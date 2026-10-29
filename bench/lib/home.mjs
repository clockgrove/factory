/**
 * Where a benchmark's data lives: outside the Factory repository. A
 * benchmark replays a real Objective of some repository, so its definition
 * and its scorecards belong with that repository's owner, not in Factory.
 *
 * Each command takes `--benchmarks DIR` (definitions, <id>.json) and
 * `--results DIR` (scorecards, <id>/<run id>.json), or `--bench-home DIR`
 * with benchmarks/, results/ and reports/ inside. Without them it reads
 * FACTORY_BENCH_HOME, and with none of these it refuses: nothing is read
 * from or written into this repository by default. A definition can also
 * be named by its path (`--benchmark FILE.json`), such as the invented
 * example in bench/examples/.
 */
import { join, resolve } from "node:path";

export const HOME_ENV = "FACTORY_BENCH_HOME";

/** The options every command takes for its directories (node:util parseArgs). */
export const DIR_OPTIONS = {
  "bench-home": { type: "string" },
  benchmarks: { type: "string" },
  results: { type: "string" },
};

/** Why a directory is missing, and how to give it. */
export function missingDir(flag, what) {
  return `no ${what} directory. Benchmark definitions and results live outside the Factory repository: give --${flag} DIR, or --bench-home DIR (with benchmarks/ and results/ inside), or set ${HOME_ENV}.`;
}

/**
 * The directories from a command's options and the environment, each
 * absolute, or null when neither names it: `benchmarks` (definitions),
 * `results` (scorecards) and `reports` (generated, a home's only).
 */
export function benchDirs(values, env = process.env) {
  const home = values["bench-home"] ?? env[HOME_ENV] ?? null;
  const dir = (flag, sub) =>
    values[flag]
      ? resolve(values[flag])
      : home
        ? resolve(join(home, sub))
        : null;
  return {
    benchmarks: dir("benchmarks", "benchmarks"),
    results: dir("results", "results"),
    reports: home ? resolve(join(home, "reports")) : null,
  };
}

/**
 * Where a harness run is scored into: --results DIR or the results/ of
 * --bench-home DIR when given, otherwise the directory its run record names
 * (`recorded`), and only when the record names none, FACTORY_BENCH_HOME's.
 * An exported home never overrides what provisioning recorded.
 */
export function runResultsDir(values, recorded, env = process.env) {
  return (
    benchDirs(values, {}).results ?? recorded ?? benchDirs(values, env).results
  );
}
