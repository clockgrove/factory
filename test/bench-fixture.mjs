// Shared by the bench tests: the scorecard of Clockgrove #800 from its real
// state and run log, trimmed (fixtures/bench/clockgrove__clockgrove: only the
// events and fields the scorer reads; free text cut to Factory's template
// words; thread ids and commit SHAs pseudonymized).
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefinition } from "../bench/lib/definition.mjs";
import { scoreRun } from "../bench/lib/score.mjs";

export const FIXTURE_STATE = fileURLToPath(
  new URL("./fixtures/bench/clockgrove__clockgrove", import.meta.url),
);

/** A copy of the fixture state in a new temporary directory (the caller removes it), changed by `change(stateDir)`. */
export function fixtureCopy(change) {
  const stateDir = join(
    mkdtempSync(join(tmpdir(), "bench-fixture-")),
    "clockgrove__clockgrove",
  );
  cpSync(FIXTURE_STATE, stateDir, { recursive: true });
  change(stateDir);
  return stateDir;
}

export function fixtureCard(run = {}, stateDir = FIXTURE_STATE) {
  return scoreRun({
    stateDir,
    issue: 800,
    definition: loadDefinition("clockgrove-800"),
    run: {
      id: "fixture",
      label: "clockgrove#800 (fixture)",
      group: "clockgrove#800, Factory 0.5.7→0.5.8, operator-assisted",
      source: "backfill",
      repository: "clockgrove/clockgrove",
      ...run,
    },
    factoryRepo: fileURLToPath(new URL("..", import.meta.url)),
  });
}
