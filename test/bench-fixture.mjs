// Shared by the bench tests: the scorecard of an invented Objective,
// acme/widgets#42 (fixtures/bench/acme__widgets, written by
// fixtures/bench/generate.mjs), scored against the invented example
// definition (bench/examples/acme-widgets-42.json).
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, loadDefinition } from "../bench/lib/definition.mjs";
import { scoreRun } from "../bench/lib/score.mjs";

export const EXAMPLE = join(BENCH_DIR, "examples", "acme-widgets-42.json");

export const FIXTURE_STATE = fileURLToPath(
  new URL("./fixtures/bench/acme__widgets", import.meta.url),
);

/** A copy of the fixture state in a new temporary directory (the caller removes it), changed by `change(stateDir)`. */
export function fixtureCopy(change) {
  const stateDir = join(
    mkdtempSync(join(tmpdir(), "bench-fixture-")),
    "acme__widgets",
  );
  cpSync(FIXTURE_STATE, stateDir, { recursive: true });
  change(stateDir);
  return stateDir;
}

export function fixtureCard(run = {}, stateDir = FIXTURE_STATE) {
  return scoreRun({
    stateDir,
    issue: 42,
    definition: loadDefinition(EXAMPLE),
    run: {
      id: "fixture",
      label: "acme/widgets#42 (fixture)",
      group: "acme/widgets#42, Factory 0.5.7→0.5.8, operator-assisted",
      source: "backfill",
      repository: "acme/widgets",
      ...run,
    },
    factoryRepo: fileURLToPath(new URL("..", import.meta.url)),
  });
}
