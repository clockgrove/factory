/**
 * `factory diagnostics --survival`: what happened to the code Factory
 * merged, from the installation's checkout and Factory's own state alone.
 * It fetches nothing and calls no network: the default branch is the
 * checkout's `origin/HEAD` as `factory serve` last fetched it.
 *
 * - An Objective's changes are its merge records (work/merged.ts): each
 *   `mergeSha` on the default branch's first-parent line. A change's own
 *   commits are `mergeSha^1..mergeSha` (the squash commit, or a merge and
 *   its branch); the lines it added are the lines `git blame -w` gives to
 *   those commits at the merge, in the files it changed.
 * - Unchanged after 7, 30 and 90 days: the share of those lines that
 *   `git blame -w` still gives to the change at the first-parent commit
 *   nearest that horizon, for each horizon that has passed. `-w` ignores
 *   whitespace-only rewrites; nothing else counts as formatting. A file
 *   renamed or deleted since counts its lines as changed.
 * - Reverted: a later commit whose message says `This reverts commit
 *   <mergeSha>` (`git revert`, and GitHub's revert of a squash commit).
 * - Fix-ups: first-parent commits within 30 days of a merge that change or
 *   delete lines it added (blame at the commit's parent against its `-w`
 *   diff), with the Objective's own later merges left out.
 * - Baseline: the same numbers for the other first-parent commits that
 *   touched the same paths in the same period (Factory's are the merge
 *   records of every Objective here; everything else counts as human).
 *
 * Read-only. Every scan is bounded (MAX_*), and the report says which
 * bound it hit.
 */
import { displayTime } from "./display.js";
import { pinnedGitExit } from "./git.js";
import { findState, listAllObjectives, type ObjectiveState } from "./state.js";
import type { MergeResult } from "./work/merged.js";

const DAY_S = 86_400;
const HORIZONS = [7, 30, 90] as const;
const FIXUP_DAYS = 30;
/** The single Objective's baseline period: this many days either side of its merges. */
const BASELINE_MARGIN_DAYS = 30;
const MAX_CHAIN = 50_000;
const MAX_OBJECTIVES = 100;
const MAX_BASELINE_COMMITS = 200;
const MAX_FIXUP_COMMITS = 200;
const MAX_CHANGE_COMMITS = 1_000;
const MAX_BLAMES = 1_500;
const GIT_TIMEOUT_MS = 120_000;

export type SurvivalSelection =
  | { issue: number }
  | { since: string; until: string };

export interface HorizonSurvival {
  days: number;
  /** Changes that added lines and whose horizon has passed; only they count. */
  changes: number;
  added: number;
  unchanged: number;
  /** unchanged / added; null when nothing was added. */
  share: number | null;
}

export interface Fixup {
  sha: string;
  at: string;
  subject: string;
  /** Lines the Objective added that this commit changed or deleted. */
  lines: number;
  by: "factory" | "human";
}

export interface ObjectiveSurvival {
  issue: number;
  merges: {
    sha: string;
    at: string;
    /** Not on the default branch's first-parent line in the checkout. */
    missing?: true;
    files: number;
    added: number;
    revertedBy: { sha: string; at: string; subject: string }[];
  }[];
  survival: HorizonSurvival[];
  reverted: boolean;
  fixups: Fixup[];
}

export interface SurvivalReport {
  kind: "code-survival";
  repository: string;
  tip: { sha: string; at: string };
  selection: SurvivalSelection;
  objectives: ObjectiveSurvival[];
  factory: HorizonSurvival[];
  baseline: {
    since: string;
    until: string;
    commits: number;
    paths: number;
    survival: HorizonSurvival[];
  };
  /** Each bound the scan hit; empty when it read everything. */
  capped: string[];
}

/** A selection the report can't serve; `code` is the CLI's refusal. */
export class SurvivalError extends Error {
  constructor(
    readonly code: "no_factory_state",
    message: string,
  ) {
    super(message);
  }
}

interface Commit {
  sha: string;
  parents: string[];
  time: number;
  subject: string;
  files: string[];
}

/** A change's lines: added at its commit, and unchanged per passed horizon. */
interface Counted {
  added: number;
  files: number;
  unchanged: Map<number, number>;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export async function survival(
  options: {
    repository: string;
    checkout: string;
    objectives: string;
    now?: Date;
  },
  selection: SurvivalSelection,
): Promise<SurvivalReport> {
  const scan = new Scan(options.checkout);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tip = (
    await scan.git([
      "rev-parse",
      "--verify",
      "refs/remotes/origin/HEAD^{commit}",
    ])
  )?.trim();
  if (!tip)
    throw new SurvivalError(
      "no_factory_state",
      `The checkout ${options.checkout} has no origin/HEAD to read the default branch from; \`factory serve\` sets it when it fetches.`,
    );

  // Every Objective's merges: Factory's commits, and the ones selected.
  const factory = new Set<string>();
  const selected: { issue: number; merges: { sha: string; at: number }[] }[] =
    [];
  const range =
    "issue" in selection
      ? undefined
      : {
          since: Date.parse(selection.since) / 1000,
          until: Date.parse(selection.until) / 1000,
        };
  let skipped = 0;
  for (const issue of listAllObjectives(options.objectives)) {
    const loaded = findState(options.objectives, issue);
    if (loaded?.kind !== "ok") continue;
    const merges = mergesOf(loaded.state);
    for (const merge of merges) factory.add(merge.sha);
    const chosen =
      "issue" in selection
        ? issue === selection.issue
          ? merges
          : []
        : merges.filter((m) => m.at >= range!.since && m.at <= range!.until);
    if (!chosen.length && !("issue" in selection && issue === selection.issue))
      continue;
    if (selected.length < MAX_OBJECTIVES)
      selected.push({ issue, merges: chosen });
    else skipped++;
  }
  if ("issue" in selection && !selected.length)
    throw new SurvivalError(
      "no_factory_state",
      `Factory has no state for #${selection.issue}.`,
    );
  if (skipped)
    scan.cap(
      `objectives: reported the first ${MAX_OBJECTIVES}; ${skipped} more merged in the range`,
    );

  const recorded = selected.flatMap((o) => o.merges.map((m) => m.at));
  const margin = BASELINE_MARGIN_DAYS * DAY_S;
  const period =
    range ??
    (recorded.length
      ? {
          since: Math.min(...recorded) - margin,
          until: Math.max(...recorded) + margin,
        }
      : { since: now - margin, until: now });
  // A merge's commit time is before Factory recorded it: a day's margin.
  const earliest = Math.min(period.since, ...recorded) - DAY_S;
  const chain = await scan.chain(tip, earliest);
  const at = new Map(chain.map((commit, index) => [commit.sha, index]));
  const reverts = await scan.reverts(tip, earliest);

  const report: SurvivalReport = {
    kind: "code-survival",
    repository: options.repository,
    tip: { sha: tip, at: iso(chain[0]?.time ?? now) },
    selection,
    objectives: [],
    factory: [],
    baseline: {
      since: iso(period.since),
      until: iso(period.until),
      commits: 0,
      paths: 0,
      survival: [],
    },
    capped: scan.capped,
  };
  const paths = new Set<string>();
  const factoryCounts: [Commit, Counted][] = [];
  for (const objective of selected) {
    const counted: [Commit, Counted][] = [];
    const entry: ObjectiveSurvival = {
      issue: objective.issue,
      merges: [],
      survival: [],
      reverted: false,
      fixups: [],
    };
    const own = new Set(objective.merges.map((m) => m.sha));
    const fixups = new Map<string, Fixup>();
    for (const merge of objective.merges) {
      const index = at.get(merge.sha);
      const revertedBy = reverts
        .filter((r) => r.body.includes(`This reverts commit ${merge.sha}`))
        .map((r) => ({ sha: r.sha, at: iso(r.time), subject: r.subject }));
      if (revertedBy.length) entry.reverted = true;
      if (index === undefined) {
        entry.merges.push({
          sha: merge.sha,
          at: iso(merge.at),
          missing: true,
          files: 0,
          added: 0,
          revertedBy,
        });
        continue;
      }
      const commit = chain[index]!;
      for (const file of commit.files) paths.add(file);
      const result = await scan.count(commit, commit.files, chain, now);
      entry.merges.push({
        sha: merge.sha,
        at: iso(commit.time),
        files: result?.files ?? 0,
        added: result?.added ?? 0,
        revertedBy,
      });
      if (!result) continue;
      counted.push([commit, result]);
      for (const fixup of await scan.fixups(
        commit,
        index,
        chain,
        own,
        factory,
      )) {
        const seen = fixups.get(fixup.sha);
        if (seen) seen.lines += fixup.lines;
        else fixups.set(fixup.sha, fixup);
      }
    }
    entry.survival = horizons(counted, now);
    entry.fixups = [...fixups.values()].sort((a, b) =>
      a.at.localeCompare(b.at),
    );
    factoryCounts.push(...counted);
    report.objectives.push(entry);
  }
  report.factory = horizons(factoryCounts, now);

  // The baseline: everyone else's first-parent commits in the same paths.
  const human = chain.filter(
    (c) =>
      !factory.has(c.sha) &&
      c.parents.length &&
      c.time >= period.since &&
      c.time <= period.until &&
      c.files.some((f) => paths.has(f)),
  );
  if (human.length > MAX_BASELINE_COMMITS)
    scan.cap(
      `baseline: read the latest ${MAX_BASELINE_COMMITS} of ${human.length} commits in the same paths`,
    );
  const baseline: [Commit, Counted][] = [];
  for (const commit of human.slice(0, MAX_BASELINE_COMMITS)) {
    const result = await scan.count(
      commit,
      commit.files.filter((f) => paths.has(f)),
      chain,
      now,
    );
    if (result?.added) baseline.push([commit, result]);
  }
  report.baseline.commits = baseline.length;
  report.baseline.paths = paths.size;
  report.baseline.survival = horizons(baseline, now);
  return report;
}

/** The Objective's merges, once each, with when Factory recorded them. */
function mergesOf(state: ObjectiveState): { sha: string; at: number }[] {
  const merges = new Map<string, number>();
  for (const [key, value] of Object.entries(state.done)) {
    const merge = value as MergeResult;
    if (key.endsWith(":merge") && merge.mergeSha && !merges.has(merge.mergeSha))
      merges.set(merge.mergeSha, Date.parse(merge.at) / 1000);
  }
  return [...merges].map(([sha, at]) => ({ sha, at }));
}

function horizons(
  counted: [Commit, Counted][],
  now: number,
): HorizonSurvival[] {
  const out: HorizonSurvival[] = [];
  for (const days of HORIZONS) {
    const passed = counted.filter(
      ([commit, c]) => c.added && commit.time + days * DAY_S <= now,
    );
    if (!passed.length) continue;
    const added = passed.reduce((sum, [, c]) => sum + c.added, 0);
    const unchanged = passed.reduce(
      (sum, [, c]) => sum + (c.unchanged.get(days) ?? 0),
      0,
    );
    out.push({
      days,
      changes: passed.length,
      added,
      unchanged,
      share: added ? Math.round((unchanged / added) * 1000) / 1000 : null,
    });
  }
  return out;
}

/** The Git reads, with their caches and bounds. */
class Scan {
  readonly capped: string[] = [];
  private blames = 0;
  private readonly blamed = new Map<string, string[] | null>();
  private readonly owned = new Map<string, Set<string>>();

  constructor(private readonly checkout: string) {}

  cap(message: string): void {
    if (!this.capped.includes(message)) this.capped.push(message);
  }

  /** Git's output; undefined when it exits non-zero. */
  async git(args: string[]): Promise<string | undefined> {
    const exit = await pinnedGitExit(
      this.checkout,
      ["-c", "core.quotePath=false", ...args],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return exit.code === 0 ? exit.stdout.toString("utf8") : undefined;
  }

  /** The default branch's first-parent line since `since`, newest first, each with the files it changed against its first parent. */
  async chain(tip: string, since: number): Promise<Commit[]> {
    const out =
      (await this.git([
        "log",
        "--first-parent",
        "--diff-merges=first-parent",
        "--no-renames",
        "--name-only",
        `--max-count=${MAX_CHAIN + 1}`,
        `--since=${iso(since)}`,
        "--format=%x01%H %ct %P%x02%s",
        tip,
      ])) ?? "";
    const chain: Commit[] = [];
    for (const record of out.split("\x01").slice(1)) {
      const [head = "", ...rest] = record.split("\n");
      const [ids = "", subject = ""] = head.split("\x02");
      const [sha = "", time = "0", ...parents] = ids.split(" ");
      chain.push({
        sha,
        parents: parents.filter(Boolean),
        time: Number(time),
        subject,
        files: rest.filter(Boolean),
      });
    }
    if (chain.length > MAX_CHAIN) {
      this.cap(
        `history: read the latest ${MAX_CHAIN} first-parent commits of the default branch`,
      );
      chain.length = MAX_CHAIN;
    }
    return chain;
  }

  /** Commits since `since` that say they revert another. */
  async reverts(
    tip: string,
    since: number,
  ): Promise<{ sha: string; time: number; subject: string; body: string }[]> {
    const out =
      (await this.git([
        "log",
        "--fixed-strings",
        "--grep=This reverts commit ",
        `--since=${iso(since)}`,
        "--format=%x01%H%x00%ct%x00%s%x00%B",
        tip,
      ])) ?? "";
    return out
      .split("\x01")
      .slice(1)
      .map((record) => {
        const [sha = "", time = "0", subject = "", body = ""] =
          record.split("\x00");
        return { sha, time: Number(time), subject, body };
      });
  }

  /** The commits a change brought in: the commit itself, and a merge's branch. */
  private async ownCommits(commit: Commit): Promise<Set<string>> {
    let own = this.owned.get(commit.sha);
    if (own) return own;
    own = new Set([commit.sha]);
    if (commit.parents.length > 1) {
      const out =
        (await this.git([
          "rev-list",
          `--max-count=${MAX_CHANGE_COMMITS}`,
          `${commit.parents[0]}..${commit.sha}`,
        ])) ?? "";
      for (const sha of out.split("\n")) if (sha) own.add(sha);
      if (own.size >= MAX_CHANGE_COMMITS)
        this.cap(
          `change: read ${MAX_CHANGE_COMMITS} commits of merge ${commit.sha.slice(0, 12)}'s branch`,
        );
    }
    this.owned.set(commit.sha, own);
    return own;
  }

  /** Each line's origin commit in `file` at `commit` (`git blame -w`); null when the file isn't there. */
  private async blame(commit: string, file: string): Promise<string[] | null> {
    const key = `${commit}:${file}`;
    if (this.blamed.has(key)) return this.blamed.get(key)!;
    this.blames++;
    const out = await this.git([
      "blame",
      "-w",
      "--porcelain",
      commit,
      "--",
      file,
    ]);
    let origins: string[] | null = null;
    if (out !== undefined) {
      origins = [];
      // A header per line: `<origin> <original line> <final line>[ <group>]`.
      for (const match of out.matchAll(/^([0-9a-f]{40,64}) \d+ (\d+)/gm))
        origins[Number(match[2]) - 1] = match[1]!;
    }
    this.blamed.set(key, origins);
    return origins;
  }

  /** Room for `count` more blames; past the bound, the caller leaves its change out. */
  private room(count: number): boolean {
    if (this.blames + count <= MAX_BLAMES) return true;
    this.cap(
      `blame: stopped at ${MAX_BLAMES} git blame calls; later changes are left out`,
    );
    return false;
  }

  /** The commit on the first-parent line at `time`: the newest no later than it. */
  private nearest(chain: Commit[], time: number): Commit | undefined {
    return chain.find((commit) => commit.time <= time);
  }

  /**
   * The lines `commit` added in `files`, and how many are unchanged at
   * each horizon that has passed; undefined past the blame bound.
   */
  async count(
    commit: Commit,
    files: string[],
    chain: Commit[],
    now: number,
  ): Promise<Counted | undefined> {
    const own = await this.ownCommits(commit);
    const passed = HORIZONS.filter((days) => commit.time + days * DAY_S <= now);
    if (!this.room(files.length * (1 + passed.length))) return undefined;
    const counted: Counted = { added: 0, files: 0, unchanged: new Map() };
    const added: string[] = [];
    for (const file of files) {
      const n = ours(await this.blame(commit.sha, file), own);
      if (!n) continue;
      counted.added += n;
      counted.files++;
      added.push(file);
    }
    for (const days of passed) {
      const at = this.nearest(chain, commit.time + days * DAY_S) ?? commit;
      let unchanged = 0;
      for (const file of added)
        unchanged += ours(await this.blame(at.sha, file), own);
      counted.unchanged.set(days, unchanged);
    }
    return counted;
  }

  /** First-parent commits within FIXUP_DAYS of `commit` that change lines it added. */
  async fixups(
    commit: Commit,
    index: number,
    chain: Commit[],
    own: Set<string>,
    factory: Set<string>,
  ): Promise<Fixup[]> {
    const ownCommits = await this.ownCommits(commit);
    const files = new Set(commit.files);
    const later = chain
      .slice(0, index)
      .filter(
        (c) =>
          c.time <= commit.time + FIXUP_DAYS * DAY_S &&
          !own.has(c.sha) &&
          c.parents.length &&
          c.files.some((f) => files.has(f)),
      )
      .reverse();
    if (later.length > MAX_FIXUP_COMMITS)
      this.cap(
        `fix-ups: read the first ${MAX_FIXUP_COMMITS} of ${later.length} commits after ${commit.sha.slice(0, 12)}`,
      );
    const found: Fixup[] = [];
    for (const next of later.slice(0, MAX_FIXUP_COMMITS)) {
      const touched = next.files.filter((f) => files.has(f));
      if (!this.room(touched.length)) break;
      let lines = 0;
      for (const file of touched) {
        const before = await this.blame(next.parents[0]!, file);
        if (!before || !ours(before, ownCommits)) continue;
        for (const [start, count] of await this.removed(next, file))
          for (let line = start; line < start + count; line++)
            if (ownCommits.has(before[line - 1] ?? "")) lines++;
      }
      if (lines)
        found.push({
          sha: next.sha,
          at: iso(next.time),
          subject: next.subject,
          lines,
          by: factory.has(next.sha) ? "factory" : "human",
        });
    }
    return found;
  }

  /** The old-side line ranges `commit` changed or deleted in `file` (`-w`), as [first line, count]. */
  private async removed(
    commit: Commit,
    file: string,
  ): Promise<[number, number][]> {
    const out =
      (await this.git([
        "diff",
        "-w",
        "--unified=0",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        commit.parents[0]!,
        commit.sha,
        "--",
        file,
      ])) ?? "";
    const ranges: [number, number][] = [];
    for (const match of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm))
      ranges.push([Number(match[1]), Number(match[2] ?? "1")]);
    return ranges;
  }
}

/** How many of `origins` are one of `own`. */
function ours(origins: string[] | null, own: Set<string>): number {
  let n = 0;
  for (const sha of origins ?? []) if (sha && own.has(sha)) n++;
  return n;
}

const percent = (h: HorizonSurvival) =>
  h.share === null ? "n/a" : `${Math.round(h.share * 100)}%`;

function horizonText(survival: HorizonSurvival[]): string {
  return survival.length
    ? survival
        .map(
          (h) =>
            `${h.days} d ${percent(h)} (${h.unchanged}/${h.added} lines, ${h.changes} change${h.changes === 1 ? "" : "s"})`,
        )
        .join(", ")
    : "no 7-day window has passed yet";
}

export function survivalText(report: SurvivalReport): string {
  const short = (sha: string) => sha.slice(0, 12);
  const lines = [
    `Code survival of ${"issue" in report.selection ? `#${report.selection.issue}` : `Objectives merged ${report.selection.since} to ${report.selection.until}`} in ${report.repository}, default branch at ${short(report.tip.sha)} (${displayTime(report.tip.at)}, as last fetched)`,
  ];
  for (const objective of report.objectives) {
    lines.push(
      "",
      `#${objective.issue}: ${objective.merges.length} merge${objective.merges.length === 1 ? "" : "s"}${objective.reverted ? ", reverted" : ", not reverted"}`,
    );
    for (const merge of objective.merges)
      lines.push(
        `  ${short(merge.sha)} ${displayTime(merge.at)}: ${merge.missing ? "not on the default branch in the checkout" : `${merge.added} lines added in ${merge.files} file${merge.files === 1 ? "" : "s"}`}${merge.revertedBy.map((r) => `; reverted by ${short(r.sha)} ${r.subject}`).join("")}`,
      );
    lines.push(`  unchanged after ${horizonText(objective.survival)}`);
    lines.push(
      `  fix-ups within ${FIXUP_DAYS} d: ${objective.fixups.length || "none"}`,
    );
    for (const fixup of objective.fixups)
      lines.push(
        `    ${short(fixup.sha)} ${displayTime(fixup.at)} ${fixup.subject} (${fixup.lines} lines, ${fixup.by})`,
      );
  }
  lines.push(
    "",
    `Factory: unchanged after ${horizonText(report.factory)}`,
    `Human baseline (${report.baseline.commits} commits in the same ${report.baseline.paths} paths, ${displayTime(report.baseline.since)} to ${displayTime(report.baseline.until)}): unchanged after ${horizonText(report.baseline.survival)}`,
  );
  if (report.capped.length)
    lines.push("", "Bounded:", ...report.capped.map((cap) => `  ${cap}`));
  lines.push(
    "",
    "Lines are counted with git blame -w: whitespace-only rewrites keep a line unchanged. --json has every count.",
  );
  return `${lines.join("\n")}\n`;
}
