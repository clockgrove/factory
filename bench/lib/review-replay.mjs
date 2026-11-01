/**
 * Review replay (#2344): run a Factory build's result reviewer again on
 * result reviews Factory recorded, and score it against hand labels.
 *
 * A replay set is a directory, outside this repository (bench/README.md):
 *
 *   records/<id>.json          one recorded review each (see `loadSet`)
 *   seeded/records/<id>.json   accepted results with a planted defect
 *   plans/, sources/           the plans and pinned sources records name
 *   labels.json                each record's labelled refusals and defects
 *   objects.bundle             optional: the candidate commits, as refs
 *
 * Each run reviews a record afresh: a scratch clone of the reviewed
 * repository (with the set's bundle fetched in), the
 * record's exact candidate commit, checked by its tree, and the recorded
 * validation evidence. The reviewer is the build's own, driven through an
 * adapter per reviewer generation (bench/lib/reviewers/). Results and the
 * scorecard are written under the set's results/.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Verdict kinds an adapter returns, per criterion. */
export const KINDS = ["pass", "refuse", "question", "note"];

/**
 * The criterion a reviewer adds of its own, beyond the record's: Factory's
 * protected-test check of the existing tests a result changed (#2344). An
 * adapter gives its verdict this `criterionIndex`, and a label's defect
 * names it among its `criteria` when that check is what should catch it.
 */
export const PROTECTED = "protected";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function git(dir, args, env = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", ...env },
  }).trim();
}

/**
 * The set's records, each with its labels (`labels.json`, keyed by record
 * id: `{ refusals: [{ criterionIndex, defect, defectId?, category?,
 * justification, labelledBy }], defects: [{ id, criteria, description,
 * evidence, labelledBy }] }`) and its plan and sources read in. `seeded`
 * adds seeded/records/; `only` keeps those ids.
 */
export function loadSet(dir, { seeded = false, only } = {}) {
  const labels = existsSync(join(dir, "labels.json"))
    ? json(join(dir, "labels.json"))
    : {};
  const files = (sub) =>
    existsSync(join(dir, sub))
      ? readdirSync(join(dir, sub))
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(dir, sub, name))
      : [];
  const records = [];
  for (const file of [
    ...files("records"),
    ...(seeded ? files(join("seeded", "records")) : []),
  ]) {
    const record = json(file);
    if (only && !only.includes(record.id)) continue;
    const label = labels[record.id] ?? record.labels ?? {};
    records.push({
      ...record,
      labels: label.refusals ?? [],
      defects: label.defects ?? [],
      plan: json(join(dir, record.plan)),
      sources: json(join(dir, record.sources)),
      ...(record.inputs ? { inputs: json(join(dir, record.inputs)) } : {}),
    });
  }
  return records;
}

/**
 * A scratch clone of `repo` with the set's bundle fetched in and `repo`'s
 * origin. It holds its own objects, not alternates, so a sandboxed
 * validation of a candidate, which sees only the clone, can read them.
 * Removed by `dispose`.
 */
export function scratchRepository(repo, setDir) {
  const root = mkdtempSync(join(tmpdir(), "review-replay-"));
  const clone = join(root, "repo");
  execFileSync(
    "git",
    ["clone", "--quiet", "--no-checkout", resolve(repo), clone],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Its origin is the repository's own, as a Factory checkout's is: a
  // validation of the candidate fetches Git LFS objects from it.
  try {
    const origin = git(resolve(repo), ["remote", "get-url", "origin"]);
    git(clone, ["remote", "set-url", "origin", origin]);
  } catch {
    // A repository with no origin: the clone's stays its path.
  }
  const bundle = join(setDir, "objects.bundle");
  if (existsSync(bundle))
    git(clone, ["fetch", "--quiet", bundle, "refs/replay/*:refs/replay/*"]);
  return {
    root,
    clone,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Why `record`'s candidate can't be reviewed in `clone`, or null. */
export function candidateProblem(clone, record) {
  const { candidate } = record;
  if (!candidate) return "the record has no candidate commit";
  try {
    const tree = git(clone, ["rev-parse", `${candidate.commit}^{tree}`]);
    if (tree !== candidate.tree)
      return `commit ${candidate.commit} has tree ${tree}, not the recorded ${candidate.tree}`;
    git(clone, ["cat-file", "-e", `${candidate.base}^{commit}`]);
  } catch {
    return `commit ${candidate.commit} or its base ${candidate.base} is not in the repository or the set's bundle`;
  }
  return null;
}

/** A fresh checkout of the record's exact candidate tree, in `dir`. */
export function checkoutTree(clone, record, dir) {
  git(clone, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    dir,
    record.candidate.commit,
  ]);
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== record.candidate.tree)
    throw new Error(
      `the checkout has tree ${tree}, not ${record.candidate.tree}`,
    );
  return dir;
}

/**
 * Review one record with `adapter`: returns `{ id, run, verdicts, error,
 * tokens, calls, ms, reviewers, phases, extra? }`, the verdicts each `{
 * criterionIndex, kind, detail, repro? }`, `reviewers` the provider, model
 * and effort each model call reported (`reportedModel`), `phases` the
 * model calls' time and what the adapter times itself, and `extra` what
 * else it reports. `cache.record` is the record's directory for what its
 * runs share, `cache.shared` what every replay shares (install stores),
 * and `prepared` what the adapter's `prepare` returned for the record. Tokens are the reviewer's own model calls, as
 * the build logs them (`model-usage`), and time its wall clock, unless the
 * adapter reports its own (`recorded` reports the recorded review's).
 */
export async function reviewOnce({
  adapter,
  build,
  set,
  cache,
  prepared,
  record,
  run,
  clone,
  provider,
  timeoutMs,
}) {
  const work = mkdtempSync(join(tmpdir(), `review-replay-${record.id}-`));
  const usage = [];
  const started = Date.now();
  const log = (event) => {
    if (event.event === "model-usage") usage.push(event);
  };
  let verdicts = null;
  let error = null;
  let answer = {};
  try {
    const tree = adapter.needsTree
      ? checkoutTree(clone, record, join(work, "tree"))
      : undefined;
    answer = await adapter.review({
      build,
      set,
      cache,
      prepared,
      record,
      checkout: clone,
      tree,
      dir: join(work, "review"),
      provider,
      signal: AbortSignal.timeout(timeoutMs),
      log,
    });
    verdicts = answer.verdicts;
    const bad = verdicts.find(
      (v) =>
        !KINDS.includes(v.kind) ||
        (v.criterionIndex !== PROTECTED &&
          (!Number.isSafeInteger(v.criterionIndex) ||
            v.criterionIndex < 0 ||
            v.criterionIndex >= record.criteria.length)),
    );
    if (bad) throw new Error(`the adapter returned ${JSON.stringify(bad)}`);
  } catch (caught) {
    error = String(caught?.message ?? caught);
    verdicts = null;
  } finally {
    if (adapter.needsTree)
      try {
        git(clone, ["worktree", "remove", "--force", join(work, "tree")]);
      } catch {
        // A worktree that was never added: nothing to remove.
      }
    rmSync(work, { recursive: true, force: true });
  }
  return {
    id: record.id,
    run,
    verdicts,
    error,
    tokens:
      answer.tokens ??
      usage.reduce((sum, e) => sum + (e.tokens?.total ?? 0), 0),
    calls: usage.length,
    ms: answer.ms ?? Date.now() - started,
    // What the provider reported running, call by call, distinct.
    reviewers: answer.reviewers ?? [
      ...new Map(
        usage.map((e) => {
          const reviewer = {
            provider: e.provider ?? null,
            model: e.model ?? null,
            effort: e.effort ?? null,
            reportedModel: e.reportedModel ?? null,
          };
          return [JSON.stringify(reviewer), reviewer];
        }),
      ).values(),
    ],
    phases: {
      modelCalls: usage.length,
      modelMs: usage.reduce((sum, e) => sum + (e.ms ?? 0), 0),
      ...answer.extra?.phases,
    },
    ...(answer.extra ? { extra: answer.extra } : {}),
  };
}

/**
 * Whether a refusal has a real defect behind it. A recorded refusal is
 * judged by its hand label, which judges its reason; a replayed one by its
 * criterion: it is matched when the record has a labelled defect that
 * criterion covers. A replayed refusal that matches none is `unmatched`,
 * listed in the scorecard to be labelled by hand: the harness doesn't read
 * its reason.
 */
function judgeRefusal(record, criterionIndex, recorded) {
  if (recorded) {
    const label = record.labels.find(
      (l) => l.criterionIndex === criterionIndex,
    );
    return label?.defect
      ? { real: true, defects: [label.defectId] }
      : { real: false, defects: [], unlabelled: !label };
  }
  const defects = record.defects
    .filter((d) => d.criteria.includes(criterionIndex))
    .map((d) => d.id);
  return { real: defects.length > 0, defects };
}

const ratio = (part, whole) => (whole ? part / whole : null);

/**
 * Whose a defect is: `item`, the item's own acceptance, which the result
 * review owns, or `objective`, an Objective criterion only (from #2344 on,
 * final review's). A label may say; otherwise a defect with an item
 * criterion among its `criteria` is the item's.
 */
export function defectScope(record, defect) {
  return (
    defect.scope ??
    (defect.criteria.some(
      (index) => index === PROTECTED || index < record.itemCriteria,
    )
      ? "item"
      : "objective")
  );
}

/** One run's scores over its results (`results`: reviewOnce's, one per record). */
export function scoreRun(records, results, { recorded = false } = {}) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const score = {
    reviews: 0,
    errors: 0,
    refusedReviews: 0,
    realRefusedReviews: 0,
    refusals: 0,
    realRefusals: 0,
    unmatched: [],
    questions: 0,
    notes: 0,
    defects: 0,
    caught: 0,
    distinct: new Map(),
    scopes: {
      item: { defects: 0, caught: 0, distinct: new Map() },
      objective: { defects: 0, caught: 0, distinct: new Map() },
    },
    missed: [],
    tokens: 0,
    ms: 0,
  };
  for (const result of results) {
    const record = byId.get(result.id);
    if (result.error) {
      score.errors++;
      continue;
    }
    score.reviews++;
    score.tokens += result.tokens;
    score.ms += result.ms;
    const refused = result.verdicts.filter((v) => v.kind === "refuse");
    score.questions += result.verdicts.filter(
      (v) => v.kind === "question",
    ).length;
    score.notes += result.verdicts.filter((v) => v.kind === "note").length;
    const caught = new Set();
    let real = 0;
    for (const verdict of refused) {
      const judged = judgeRefusal(record, verdict.criterionIndex, recorded);
      score.refusals++;
      if (judged.real) {
        real++;
        for (const id of judged.defects) caught.add(id);
      } else if (!recorded || judged.unlabelled)
        score.unmatched.push({
          id: record.id,
          criterionIndex: verdict.criterionIndex,
          detail: verdict.detail,
          ...(verdict.repro ? { repro: verdict.repro } : {}),
        });
    }
    score.realRefusals += real;
    if (refused.length) score.refusedReviews++;
    if (real) score.realRefusedReviews++;
    for (const defect of record.defects) {
      const scope = score.scopes[defectScope(record, defect)];
      const hit = caught.has(defect.id);
      const key = `${record.objective ?? ""}:${record.item ?? record.id}:${defect.id}`;
      for (const tally of [score, scope]) {
        tally.defects++;
        if (hit) tally.caught++;
        tally.distinct.set(key, (tally.distinct.get(key) ?? false) || hit);
      }
      if (!hit)
        score.missed.push({
          id: record.id,
          defect: defect.id,
          scope: defectScope(record, defect),
        });
    }
  }
  const distinct = [...score.distinct.values()];
  return {
    reviews: score.reviews,
    errors: score.errors,
    refusedReviews: score.refusedReviews,
    reviewPrecision: ratio(score.realRefusedReviews, score.refusedReviews),
    refusals: score.refusals,
    realRefusals: score.realRefusals,
    refusalPrecision: ratio(score.realRefusals, score.refusals),
    defects: score.defects,
    caught: score.caught,
    recall: ratio(score.caught, score.defects),
    distinctDefects: distinct.length,
    distinctCaught: distinct.filter(Boolean).length,
    // The gate's recall is the item's: the defects the result review owns.
    ...Object.fromEntries(
      Object.entries(score.scopes).flatMap(([name, tally]) => {
        const seen = [...tally.distinct.values()];
        return [
          [`${name}Defects`, tally.defects],
          [`${name}Caught`, tally.caught],
          [`${name}Recall`, ratio(tally.caught, tally.defects)],
          [`${name}DistinctDefects`, seen.length],
          [`${name}DistinctCaught`, seen.filter(Boolean).length],
        ];
      }),
    ),
    missed: score.missed,
    questions: score.questions,
    notes: score.notes,
    tokens: score.tokens,
    tokensPerReview: ratio(score.tokens, score.reviews),
    ms: score.ms,
    msPerReview: ratio(score.ms, score.reviews),
    unmatched: score.unmatched,
  };
}

/** Mean, min and max of each numeric score over runs. */
export function summarize(runs) {
  const summary = {};
  for (const key of Object.keys(runs[0] ?? {})) {
    const values = runs
      .map((run) => run[key])
      .filter((v) => typeof v === "number");
    if (!values.length) continue;
    summary[key] = {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }
  return summary;
}

/** Each record's verdicts across runs, for the scorecard's table. */
export function perRecord(records, results) {
  return records.map((record) => {
    const own = results.filter((r) => r.id === record.id);
    return {
      id: record.id,
      recorded: record.recorded?.outcome ?? null,
      defects: record.defects.map((d) => d.id),
      runs: own
        .sort((a, b) => a.run - b.run)
        .map((r) =>
          r.error
            ? { run: r.run, error: r.error }
            : {
                run: r.run,
                refused: r.verdicts
                  .filter((v) => v.kind === "refuse")
                  .map((v) => v.criterionIndex),
                questions: r.verdicts.filter((v) => v.kind === "question")
                  .length,
                tokens: r.tokens,
                ms: r.ms,
              },
        ),
    };
  });
}

/** Write `value` as JSON at `path`, making its directory. */
export function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
