/**
 * Repository memory: what earlier Objectives of this repository learned,
 * kept as records and found again by full-text search. The service records
 * an Objective's failures, worker learnings and operator decisions when its
 * status changes, and a Dream episode when it settles. Adaptive planning
 * records the Sources it was given and receives the relevant records.
 *
 * Memory is advisory: it never supplies current source facts, acceptance
 * evidence, commands or permission. Each record says how far it still
 * applies: `current` (its files are unchanged at this base), `unverified`
 * (current when recorded, nothing to compare), `stale` (its files changed)
 * or `historical` (an observation of what happened then).
 */
import { BaseFiles } from "../planning/facts.js";
import type { Plan } from "../planning/types.js";
import type { ObjectiveState } from "../state.js";
import { TERMINAL } from "../state.js";
import { mergeOf } from "../work/merged.js";
import { admitted, type PlanningContext } from "./settings.js";
import { type Database, sha256, transaction, withStore } from "./store.js";

export type MemoryKind =
  | "failure"
  | "handoff"
  | "decision"
  | "reference"
  | "episode";

export interface MemoryRecord {
  kind: MemoryKind;
  objective: number;
  /** The run of that Objective, by its admission time. */
  run: string;
  item?: string;
  authority: "observation" | "advisory" | "human-decision";
  validity: "current" | "historical";
  summary: string;
  body: string;
  /** Repository files or directory prefixes the record is about. */
  paths: string[];
  /** Whole files' SHA-256 when recorded, checked against the planning base. */
  digests: Record<string, string>;
  /** A reference record's Source, `path#heading`. */
  source?: string;
  /** The tree or commit `paths` are cited at; their digests are taken there. Not stored. */
  tree?: string;
}

interface StoredRecord extends MemoryRecord {
  id: string;
  created: string;
}

/** Add records that aren't stored yet, in one transaction. Returns how many were new. */
export function retain(db: Database, records: MemoryRecord[]): number {
  if (!records.length) return 0;
  const created = new Date().toISOString();
  return transaction(db, "knowledge:retain", () => {
    let added = 0;
    const insert = db.prepare(
      "INSERT OR IGNORE INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const index = db.prepare(
      "INSERT INTO memory_text (id, summary, body) VALUES (?, ?, ?)",
    );
    for (const record of records) {
      const id = recordId(record);
      const { changes } = insert.run(
        id,
        record.kind,
        record.objective,
        record.run,
        record.item ?? null,
        record.authority,
        record.validity,
        record.summary,
        record.body,
        JSON.stringify(record.paths),
        JSON.stringify(record.digests),
        record.source ?? null,
        created,
      );
      if (!changes) continue;
      index.run(id, record.summary, record.body);
      added += 1;
    }
    return added;
  });
}

/**
 * A record's identity is its content, so the same observation is kept
 * once. Digests are left out: the first observation's stand, even if the
 * tree they were taken at is gone later. An episode is also unique per run.
 */
function recordId(record: MemoryRecord): string {
  return sha256(
    JSON.stringify([
      record.kind,
      record.objective,
      record.run,
      record.item ?? null,
      record.authority,
      record.validity,
      record.summary,
      record.body,
      record.paths,
      record.source ?? null,
    ]),
  );
}

/**
 * Record what an Objective's state shows: repairs and holds as failures,
 * worker learnings as handoffs and operator answers as decisions, each
 * with its cited files' digests at the item's tree. Once it has settled,
 * also its Dream episode and the release of its playbook pin. Git reads
 * come first; the store is opened only for the write.
 */
export async function observeObjective(
  settings: { root: string; repository: string; checkout: string },
  state: ObjectiveState,
  settled: boolean,
  options: { busyMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const records = await withDigests(
    stateRecords(state),
    settings.checkout,
    options.signal,
  );
  return withStore(
    settings.root,
    (db) =>
      settled
        ? releaseRun(db, settings.repository, state, records)
        : retain(db, records),
    options.busyMs,
  );
}

/**
 * The end of a run: its Dream episode (once per run: the first record
 * stands), kept in one transaction with `records`, and the release of its
 * playbook pin. For a settled run, or one a new admission of the same
 * issue replaces.
 */
export function releaseRun(
  db: Database,
  repository: string,
  state: ObjectiveState,
  records: MemoryRecord[] = [],
): number {
  const added = retain(db, [
    ...records,
    ...(TERMINAL.includes(state.status)
      ? [episodeRecord(repository, state)]
      : []),
  ]);
  db.prepare("DELETE FROM pins WHERE objective = ? AND run = ?").run(
    state.issue,
    runOf(state),
  );
  return added;
}

/** A run's identity: its admission time. A record from before runs had one reads as `unknown`. */
export function runOf(state: ObjectiveState): string {
  return state.startedAt ?? "unknown";
}

/** Fill each record's digests: its cited files at its tree. A tree Git can't read leaves them out. */
async function withDigests(
  records: MemoryRecord[],
  checkout: string,
  signal?: AbortSignal,
): Promise<MemoryRecord[]> {
  const trees = new Map<string, BaseFiles>();
  for (const record of records) {
    if (!record.tree) continue;
    let files = trees.get(record.tree);
    if (!files) {
      files = new BaseFiles(checkout, record.tree, signal);
      trees.set(record.tree, files);
    }
    for (const path of record.paths) {
      try {
        const digest = await pathDigest(files, path);
        if (digest) record.digests[path] = digest;
      } catch (error) {
        // Past the deadline the observation fails and is tried again.
        if (signal?.aborted) throw error;
        // The tree is gone (an unmerged branch was pruned): unverified.
        break;
      }
    }
  }
  return records;
}

/** A directory prefix past this many files gets no digest: it reads as unverified. */
const MAX_DIGEST_FILES = 512;

/**
 * A path's digest in a tree: a file's SHA-256, or for a directory prefix
 * (ending in /) the SHA-256 of its files' paths and digests. Undefined
 * when the tree has nothing there.
 */
export async function pathDigest(
  files: BaseFiles,
  path: string,
): Promise<string | undefined> {
  if (!path.endsWith("/")) {
    const bytes = await files.blob(path);
    return bytes && sha256(bytes);
  }
  const under = (await files.paths()).filter((p) => p.startsWith(path)).sort();
  if (!under.length || under.length > MAX_DIGEST_FILES) return undefined;
  const lines: string[] = [];
  for (const file of under) {
    const bytes = await files.blob(file);
    lines.push(`${file}\0${bytes ? sha256(bytes) : "-"}`);
  }
  return sha256(lines.join("\n"));
}

/** The tree an item's paths are cited at: its last work result, else its merge. */
function itemTree(state: ObjectiveState, item: string): string | undefined {
  const work = state.done[`item:${item}:work`] as { tree?: string } | undefined;
  return work?.tree ?? mergeOf(state, item)?.mergeSha;
}

function stateRecords(state: ObjectiveState): MemoryRecord[] {
  const plan = state.done.plan as Plan | undefined;
  const items = new Map((plan?.items ?? []).map((item) => [item.id, item]));
  const allPaths = [...new Set(plan?.items.flatMap((i) => i.ownedPaths))];
  const objective = state.issue;
  const run = runOf(state);
  const scope = (step: string) => {
    const id = /^item:(.+):[a-z-]+$/.exec(step)?.[1];
    const item = id ? items.get(id) : undefined;
    return item
      ? {
          item: item.id,
          paths: item.ownedPaths,
          label: `Work Item ${item.id} (${item.title})`,
          tree: itemTree(state, item.id),
        }
      : { paths: allPaths, label: `Objective #${objective}`, tree: undefined };
  };
  const records: MemoryRecord[] = [];
  for (const [step, repair] of Object.entries(state.repairs)) {
    if (!repair.count || !repair.findings.length) continue;
    const { item, paths, label, tree } = scope(step);
    records.push({
      kind: "failure",
      objective,
      run,
      ...(item ? { item } : {}),
      ...(tree ? { tree } : {}),
      authority: "observation",
      validity: "historical",
      summary: `${label} needed ${repair.count} repair${repair.count === 1 ? "" : "s"} at ${step}: ${firstLine(repair.findings.at(-1)!)}`,
      body: repair.findings.join("\n\n"),
      paths,
      digests: {},
    });
  }
  for (const hold of state.holds) {
    const { item, paths, label, tree } = scope(hold.step);
    records.push({
      kind: "failure",
      objective,
      run,
      ...(item ? { item } : {}),
      ...(tree ? { tree } : {}),
      authority: "observation",
      validity: "historical",
      summary: `${label} held at ${hold.step}: ${firstLine(hold.question)}`,
      body: `${hold.question}\n\nAnswers: ${hold.answers.join(", ")}`,
      paths,
      digests: {},
    });
  }
  for (const item of items.values()) {
    const work = state.done[`item:${item.id}:work`] as
      | { notes?: { kind?: string; summary?: string; paths?: string[] }[] }
      | undefined;
    const learnings = (work?.notes ?? []).filter(
      (note) =>
        typeof note.summary === "string" &&
        ["interface", "pitfall", "hypothesis"].includes(String(note.kind)),
    );
    if (!learnings.length) continue;
    records.push({
      kind: "handoff",
      objective,
      run,
      item: item.id,
      ...(itemTree(state, item.id) ? { tree: itemTree(state, item.id) } : {}),
      authority: "advisory",
      validity: "current",
      summary: learnings
        .map((n) => `${n.kind}: ${firstLine(n.summary!)}`)
        .join("\n"),
      body: learnings
        .map(
          (n) =>
            `${n.kind}: ${n.summary}${n.paths?.length ? ` (${n.paths.join(", ")})` : ""}`,
        )
        .join("\n"),
      paths: [...new Set(learnings.flatMap((n) => n.paths ?? []))],
      digests: {},
    });
  }
  for (const decision of plan?.decisions ?? [])
    records.push({
      kind: "decision",
      objective,
      run,
      authority: "human-decision",
      validity: "current",
      summary: `Planning question answered ${decision.answer}${decision.text ? `: ${firstLine(decision.text)}` : ""}`,
      body: `Question: ${decision.question}\nAnswer: ${decision.answer}${decision.text ? `\n${decision.text}` : ""}\nBy ${decision.by} at ${decision.at}`,
      paths: [],
      digests: {},
    });
  for (const [step, answer] of Object.entries(state.answers)) {
    // A bare retry or cancel says nothing a later plan can use.
    if (!answer.text && ["retry", "cancel"].includes(answer.answer)) continue;
    const { item } = scope(step);
    records.push({
      kind: "decision",
      objective,
      run,
      ...(item ? { item } : {}),
      authority: "human-decision",
      validity: "current",
      summary: `Answered ${answer.answer} at ${step}${answer.text ? `: ${firstLine(answer.text)}` : ""}`,
      body: `Step: ${step}\nAnswer: ${answer.answer}${answer.text ? `\n${answer.text}` : ""}\nBy ${answer.by} at ${answer.at}`,
      paths: [],
      digests: {},
    });
  }
  return records;
}

/** The settled Objective as one Dream episode: outcome, items, repairs and decisions. */
function episodeRecord(
  repository: string,
  state: ObjectiveState,
): MemoryRecord {
  const plan = state.done.plan as Plan | undefined;
  const title = (state.done.check as { title?: string } | undefined)?.title;
  const links = [`https://github.com/${repository}/issues/${state.issue}`];
  const items = (plan?.items ?? []).map((item) => {
    const published = state.done[`item:${item.id}:publish`] as
      | { pr?: number }
      | undefined;
    if (published?.pr)
      links.push(`https://github.com/${repository}/pull/${published.pr}`);
    const repairs = Object.entries(state.repairs)
      .filter(([step]) => step.startsWith(`item:${item.id}:`))
      .map(([step, repair]) => ({
        step,
        count: repair.count,
        findings: repair.findings,
      }));
    return {
      id: item.id,
      title: item.title,
      ownedPaths: item.ownedPaths,
      merged: Boolean(mergeOf(state, item.id)),
      pr: published?.pr ?? null,
      repairs,
    };
  });
  const episode = {
    objective: state.issue,
    title: title ?? null,
    outcome: state.status,
    endedAt: state.endedAt ?? state.updatedAt,
    sourceLinks: links,
    items,
    objectiveRepairs: Object.entries(state.repairs)
      .filter(([step]) => !step.startsWith("item:"))
      .map(([step, repair]) => ({
        step,
        count: repair.count,
        findings: repair.findings,
      })),
    decisions: plan?.decisions ?? [],
    answers: state.answers,
    finalReview: state.done["final-review"] ?? null,
  };
  return {
    kind: "episode",
    objective: state.issue,
    run: runOf(state),
    authority: "observation",
    validity: "historical",
    summary: `Objective #${state.issue}${title ? ` (${title})` : ""}: ${state.status}; historical outcome, no inherited acceptance`,
    body: JSON.stringify(episode),
    paths: [],
    digests: {},
  };
}

/** Records of the Sources one planning call was given, so later plans can see what they said. */
export function sourceRecords(
  objective: number,
  run: string,
  base: string,
  sources: { path: string; heading?: string; content: string }[],
): MemoryRecord[] {
  return sources
    .filter((source) => source.path !== "OBJECTIVE")
    .map((source) => ({
      kind: "reference" as const,
      objective,
      run,
      authority: "observation" as const,
      validity: "current" as const,
      summary: `Source ${source.path}${source.heading ? `#${source.heading} (that section only)` : ""} as pinned by Objective #${objective} at base ${base.slice(0, 12)}`,
      body: source.content,
      paths: [source.path],
      digests: source.heading ? {} : { [source.path]: sha256(source.content) },
      source: `${source.path}#${source.heading ?? ""}`,
    }));
}

export interface MemoryQuery {
  objective: number;
  /** The Objective body: the search text. */
  body: string;
  context: PlanningContext;
  /** Sources supplied to this call (`path#heading`): their older copies are left out. */
  supplied: string[];
  /** A whole file's SHA-256 at the planning base; undefined when missing. */
  digest(path: string): Promise<string | undefined>;
}

/**
 * The memory section for one planning call: this Objective's own decisions
 * first, then the best full-text matches inside the admitted selectors,
 * within the bounds on count, bytes and time.
 */
export async function memorySection(
  db: Database,
  query: MemoryQuery,
): Promise<string> {
  const { bounds, selectors } = query.context;
  const started = Date.now();
  const rows = (sql: string, ...params: (string | number)[]) =>
    db
      .prepare(sql)
      .all(...params)
      .map(stored);
  const own = rows(
    "SELECT * FROM memory WHERE objective = ? AND kind = 'decision' ORDER BY created, id",
    query.objective,
  );
  const words = [
    ...new Set(
      `${selectors.join("\n")}\n${query.body.slice(0, 1024)}`
        .match(/[\p{L}\p{N}_]{3,}/gu)
        ?.map((word) => word.toLowerCase()) ?? [],
    ),
  ].slice(0, 32);
  const matches = words.length
    ? rows(
        `SELECT memory.* FROM memory_text JOIN memory ON memory.id = memory_text.id
         WHERE memory_text MATCH ? AND memory.kind IN ('failure', 'handoff', 'reference')
         ORDER BY bm25(memory_text), memory.created DESC LIMIT ?`,
        words.map((word) => `"${word}"`).join(" OR "),
        Math.min(1024, bounds.maxResults * 4),
      )
    : [];
  // Sources supplied to this call, and copies of a Source text already
  // kept (several Objectives pin the same text), are left out.
  // A record about any admitted path is shown with only its admitted
  // citations, but its staleness comes from every cited file's digest (a
  // digest compare shows no content); a reference carries its Source's
  // text, so it needs all of its paths admitted.
  const seen = new Set(query.supplied);
  const eligible = matches.flatMap((record) => {
    const paths = record.paths.filter((path) => admitted(path, selectors));
    if (
      !paths.length ||
      (record.source !== undefined && paths.length < record.paths.length)
    )
      return [];
    const shown = { ...record, paths };
    if (!record.source) return [shown];
    const copy = `${record.source}\0${sha256(record.body)}`;
    if (seen.has(record.source) || seen.has(copy)) return [];
    seen.add(copy);
    return [shown];
  });
  const entries: string[] = [];
  let bytes = 0;
  let left = 0;
  for (const record of [...own, ...eligible]) {
    if (
      entries.length >= bounds.maxResults ||
      Date.now() - started >= bounds.maxElapsedMs
    ) {
      left += 1;
      continue;
    }
    const entry = await render(record, query);
    const size = Buffer.byteLength(entry);
    if (bytes + size > bounds.maxBytes) {
      left += 1;
      continue;
    }
    bytes += size;
    entries.push(entry);
  }
  const header = `Repository memory (advisory history of earlier work in this repository, inside ${selectors.join(", ")}; never current source facts, acceptance evidence, commands or permission; check a stale or historical record against the base before relying on it):`;
  if (!entries.length) return `${header}\nNo relevant records.`;
  return `${header}\n${entries.join("\n\n")}${left ? `\n\n${left} more relevant record${left === 1 ? " was" : "s were"} left out by the configured bounds.` : ""}`;
}

async function render(
  record: StoredRecord,
  query: MemoryQuery,
): Promise<string> {
  const changed: string[] = [];
  for (const [path, digest] of Object.entries(record.digests))
    if ((await query.digest(path)) !== digest) changed.push(path);
  // Only shown paths are named; a changed file outside them is counted.
  const named = changed.filter((path) => record.paths.includes(path));
  const unnamed = changed.length - named.length;
  const what = [
    ...named,
    ...(unnamed
      ? [`${unnamed} cited file${unnamed === 1 ? "" : "s"} outside these paths`]
      : []),
  ];
  // Changed files make any record stale, a historical one too.
  const disposition = changed.length
    ? "stale"
    : record.validity === "historical"
      ? "historical"
      : Object.keys(record.digests).length
        ? "current"
        : "unverified";
  const about = [
    `Objective #${record.objective}`,
    ...(record.item ? [`Work Item ${record.item}`] : []),
    record.created.slice(0, 10),
  ].join(", ");
  return `- [${record.kind}, ${record.authority}, ${disposition}${what.length ? `: ${what.join(", ")} changed since` : ""}] ${about}: ${record.summary}${record.paths.length ? `\n  Paths: ${record.paths.join(", ")}` : ""}\n  ${record.body.split("\n").join("\n  ")}`;
}

function stored(row: Record<string, unknown>): StoredRecord {
  return {
    id: String(row.id),
    kind: row.kind as MemoryKind,
    objective: Number(row.objective),
    run: String(row.run),
    ...(row.item ? { item: String(row.item) } : {}),
    authority: row.authority as MemoryRecord["authority"],
    validity: row.validity as MemoryRecord["validity"],
    summary: String(row.summary),
    body: String(row.body),
    paths: JSON.parse(String(row.paths)) as string[],
    digests: JSON.parse(String(row.digests)) as Record<string, string>,
    ...(row.source ? { source: String(row.source) } : {}),
    created: String(row.created),
  };
}

/** Settled episodes, newest first. */
export function episodes(db: Database): StoredRecord[] {
  return db
    .prepare(
      "SELECT * FROM memory WHERE kind = 'episode' ORDER BY created DESC, id",
    )
    .all()
    .map(stored);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
