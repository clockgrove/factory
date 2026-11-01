#!/usr/bin/env node
/**
 * `node bench/review-replay.mjs`: replay recorded result reviews with a
 * Factory build's result reviewer and score it (#2344,
 * bench/lib/review-replay.mjs).
 *
 *   --bench-home DIR            the bench home; the set is its review-replay/
 *                               (or FACTORY_BENCH_HOME)
 *   --set DIR                   the replay set itself, over the bench home
 *   --repo DIR                  a clone of the reviewed repository: its
 *                               objects hold each record's base
 *   --build DIR                 the Factory checkout whose reviewer runs
 *                               (its dist/; default: this checkout)
 *   --reviewer auto|v2|v1|recorded the adapter (bench/lib/reviewers/); auto
 *                               picks the one that fits the build, and
 *                               recorded replays the recorded verdicts
 *   --provider codex|claude|copilot  the planner kind (default: codex)
 *   --model NAME, --effort LEVEL     the reviewer's model and effort
 *                               (default: the build's for the provider)
 *   --runs N                    reviews of each record (default: 1)
 *   --concurrency N             reviews at once (default: 1, so reviews
 *                               don't stretch each other's wall time;
 *                               more only within the host's share)
 *   --prepare-concurrency N     preparations at once (default: as
 *                               --concurrency); preparation isn't review
 *                               time
 *   --cache DIR                 what replays share across sets and
 *                               labels, such as each item's warm install
 *                               store (default: ~/.cache/factory-bench/
 *                               review-replay)
 *   --seeded                    add the seeded records (seeded/records/),
 *                               reviewed once each and scored apart
 *   --only ID ...               only these records
 *   --label NAME                the results' name (default: from the
 *                               reviewer, provider, model and effort)
 *   --timeout-minutes N         each review's bound (default: 20)
 *   --fresh                     review again what earlier results hold
 *
 * Results go to <set>/results/<label>/: runs/<n>/<record id>.json, one
 * per review, reused by a later invocation unless --fresh (one that
 * failed runs again), and
 * scorecard.json. Exit codes: 0 scored (a review that failed is counted
 * in `errors`); 64 usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOME_ENV } from "./lib/home.mjs";
import {
  candidateProblem,
  loadSet,
  perRecord,
  reviewOnce,
  scoreRun,
  scratchRepository,
  summarize,
  writeJson,
} from "./lib/review-replay.mjs";
import * as recorded from "./lib/reviewers/recorded.mjs";
import * as v1 from "./lib/reviewers/v1.mjs";
import * as v2 from "./lib/reviewers/v2.mjs";

/** Every reviewer generation's adapter, newest first; `recorded` is chosen by name only. */
const ADAPTERS = [v2, v1];

const { values } = parseArgs({
  options: {
    "bench-home": { type: "string" },
    set: { type: "string" },
    repo: { type: "string" },
    build: { type: "string" },
    reviewer: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    runs: { type: "string" },
    concurrency: { type: "string" },
    "prepare-concurrency": { type: "string" },
    cache: { type: "string" },
    seeded: { type: "boolean" },
    only: { type: "string", multiple: true },
    label: { type: "string" },
    "timeout-minutes": { type: "string" },
    fresh: { type: "boolean" },
  },
});

const usage = (message) => {
  process.stderr.write(
    `${message}\nSee the header of bench/review-replay.mjs for usage.\n`,
  );
  process.exit(64);
};

const number = (flag, fallback) => {
  if (values[flag] === undefined) return fallback;
  const n = Number(values[flag]);
  if (!Number.isSafeInteger(n) || n < 1)
    usage(`--${flag} takes a whole number more than 0`);
  return n;
};

const home = values["bench-home"] ?? process.env[HOME_ENV];
const setDir = values.set
  ? resolve(values.set)
  : home
    ? resolve(home, "review-replay")
    : null;
if (!setDir)
  usage(
    `no replay set. It lives outside the Factory repository: give --set DIR, or --bench-home DIR (with review-replay/ inside), or set ${HOME_ENV}.`,
  );
if (!existsSync(join(setDir, "records"))) usage(`${setDir} has no records/`);
if (!values.repo) usage("Give --repo, a clone of the reviewed repository");
const build = resolve(
  values.build ?? fileURLToPath(new URL("..", import.meta.url)),
);
if (!existsSync(join(build, "dist/review/result.js")))
  usage(`${build} has no dist/review/result.js: run npm run build there`);
/** The build's commit, when it is a Git checkout (dist/ is untracked: don't rebuild it during a replay). */
function buildCommit(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
const provider = {
  planner: values.provider ?? "codex",
  ...(values.model ? { model: values.model } : {}),
  ...(values.effort ? { effort: values.effort } : {}),
};
if (!["codex", "claude", "copilot"].includes(provider.planner))
  usage("--provider takes codex, claude or copilot");

let adapter;
/** The reviewer setting asked for: the flags, else the build's default for the provider. */
let setting = null;
if (values.reviewer === "recorded") adapter = recorded;
else {
  const result = await import(join(build, "dist/review/result.js"));
  adapter =
    !values.reviewer || values.reviewer === "auto"
      ? ADAPTERS.find((a) => a.fits(result, build))
      : ADAPTERS.find((a) => a.id === values.reviewer);
  if (!adapter)
    usage(
      values.reviewer && values.reviewer !== "auto"
        ? `no reviewer adapter ${values.reviewer}; there are ${ADAPTERS.map((a) => a.id).join(", ")} and recorded`
        : `no adapter in bench/lib/reviewers/ fits ${build}'s reviewer: add one for its generation`,
    );
  if (!adapter.fits(result, build))
    usage(`adapter ${adapter.id} doesn't fit ${build}'s reviewer`);
  const { defaultModels } = await import(
    join(build, "dist/providers/selection.js")
  );
  const defaults = defaultModels(provider.planner);
  setting = {
    provider: provider.planner,
    model: provider.model ?? defaults.reviewer.model,
    effort:
      provider.effort ??
      defaults.reviewEffort?.["result-review"] ??
      defaults.reviewer.effort,
    from:
      provider.model && provider.effort
        ? "flags"
        : provider.model || provider.effort
          ? "flags, the rest the build's default"
          : "the build's default",
  };
}

const runs = adapter === recorded ? 1 : number("runs", 1);
const concurrency = number("concurrency", 1);
const prepareConcurrency = number("prepare-concurrency", concurrency);
const shared = resolve(
  values.cache ??
    join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "factory-bench",
      "review-replay",
    ),
);
const timeoutMs = number("timeout-minutes", 20) * 60_000;
const label =
  values.label ??
  (adapter === recorded
    ? "recorded"
    : [adapter.id, provider.planner, provider.model, provider.effort]
        .filter(Boolean)
        .join("-"));
const out = join(setDir, "results", label);
const records = loadSet(setDir, {
  seeded: values.seeded,
  ...(values.only ? { only: values.only } : {}),
});
// The recorded verdicts exist for recorded reviews only, not seeded ones.
const replayed = records.filter(
  (record) =>
    record.replay !== false && (adapter !== recorded || record.recorded),
);
if (!replayed.length) usage("no record to replay");

const scratch = scratchRepository(values.repo, setDir);
process.on("exit", scratch.dispose);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    scratch.dispose();
    process.kill(process.pid, signal);
  });

/** Run `task` over `items`, `width` at a time. */
async function pool(items, width, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, worker),
  );
}

// Each record's preparation, once, before any review: what its runs
// share, such as a warm install store and a mutation pass. It isn't
// review time, so it is timed apart.
const prepared = new Map();
if (adapter.prepare)
  await pool(
    replayed.filter((record) => !candidateProblem(scratch.clone, record)),
    prepareConcurrency,
    async (record) => {
      const started = Date.now();
      try {
        const value = await adapter.prepare({
          build,
          set: setDir,
          cache: { record: join(out, "cache", record.id), shared },
          record,
          checkout: scratch.clone,
          signal: AbortSignal.timeout(timeoutMs),
        });
        prepared.set(record.id, { value, ms: Date.now() - started });
        process.stderr.write(
          `prepared ${record.id} in ${Math.round((Date.now() - started) / 1000)} s\n`,
        );
      } catch (error) {
        prepared.set(record.id, {
          error: String(error?.message ?? error),
          ms: Date.now() - started,
        });
        process.stderr.write(
          `prepare ${record.id}: error: ${error?.message ?? error}\n`,
        );
      }
    },
  );

// Each (run, record) pair once; a seeded record is reviewed in run 1 only.
const pairs = [];
for (let run = 1; run <= runs; run++)
  for (const record of replayed)
    if (run === 1 || !record.seeded) pairs.push({ run, record });
const results = [];
let done = 0;
await pool(pairs, concurrency, async ({ run, record }) => {
  const file = join(out, "runs", String(run), `${record.id}.json`);
  // An earlier result is reused, but not an error: that review runs again.
  let result =
    !values.fresh && existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : null;
  if (!result || result.error) {
    const ready = prepared.get(record.id);
    const problem =
      candidateProblem(scratch.clone, record) ??
      (ready?.error ? `its preparation failed: ${ready.error}` : null);
    result = problem
      ? {
          id: record.id,
          run,
          verdicts: null,
          error: problem,
          tokens: 0,
          calls: 0,
          ms: 0,
          reviewers: [],
        }
      : await reviewOnce({
          adapter,
          build,
          set: setDir,
          cache: { record: join(out, "cache", record.id), shared },
          prepared: ready?.value,
          record,
          run,
          clone: scratch.clone,
          provider,
          timeoutMs,
        });
    writeJson(file, result);
  }
  results.push(result);
  done++;
  const refused = result.verdicts?.filter((v) => v.kind === "refuse").length;
  process.stderr.write(
    `[${done}/${pairs.length}] run ${run} ${record.id}: ${result.error ? `error: ${result.error}` : `${refused} refused, ${result.tokens} tokens, ${Math.round(result.ms / 1000)} s`}\n`,
  );
});

const section = (subset) => {
  const ids = new Set(subset.map((r) => r.id));
  const own = results.filter((r) => ids.has(r.id));
  const perRun = [];
  for (let run = 1; run <= runs; run++) {
    const these = own.filter((r) => r.run === run);
    if (these.length)
      perRun.push(scoreRun(subset, these, { recorded: adapter === recorded }));
  }
  return {
    records: subset.length,
    runs: perRun,
    summary: summarize(perRun),
    perRecord: perRecord(subset, own),
  };
};
const history = replayed.filter((r) => !r.seeded);
const seeded = replayed.filter((r) => r.seeded);
const scorecard = {
  label,
  reviewer: adapter.id,
  build,
  buildCommit: buildCommit(build),
  // What was asked for, and what the provider reported it ran.
  setting,
  reported: [
    ...new Map(
      results
        .flatMap((r) => r.reviewers ?? [])
        .map((r) => [JSON.stringify(r), r]),
    ).values(),
  ],
  runs,
  concurrency,
  prepareConcurrency,
  prepare: Object.fromEntries(
    [...prepared].map(([id, entry]) => [
      id,
      { ms: entry.ms, ...(entry.error ? { error: entry.error } : {}) },
    ]),
  ),
  notReplayed: records
    .filter((r) => r.replay === false)
    .map((r) => ({ id: r.id, why: r.why ?? null })),
  replay: section(history),
  ...(seeded.length ? { seeded: section(seeded) } : {}),
};
writeJson(join(out, "scorecard.json"), scorecard);

const pct = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
for (const [name, part] of [
  ["replay", scorecard.replay],
  ["seeded", scorecard.seeded],
]) {
  if (!part) continue;
  for (const [index, s] of part.runs.entries())
    process.stdout.write(
      `${name} run ${index + 1}: ${s.reviews} reviews (${s.errors} errors), ${s.refusedReviews} refused (precision ${pct(s.reviewPrecision)}), ${s.refusals} refusals (precision ${pct(s.refusalPrecision)}), item defects caught ${s.itemCaught}/${s.itemDefects} (${s.itemDistinctCaught}/${s.itemDistinctDefects} distinct), objective defects caught ${s.objectiveCaught}/${s.objectiveDefects}, ${s.questions} questions, ${s.tokens} tokens, ${Math.round(s.ms / 1000)} s\n`,
    );
}
process.stdout.write(`${join(out, "scorecard.json")}\n`);
