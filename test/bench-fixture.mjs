// Shared by the bench tests: the scorecard of Clockgrove #800 from its real
// state and run log, trimmed (fixtures/bench/clockgrove__clockgrove: only the
// events and fields the scorer reads; free text cut to Factory's template
// words; thread ids and commit SHAs pseudonymized).
import { fileURLToPath } from "node:url";
import { loadDefinition } from "../bench/lib/definition.mjs";
import { scoreRun } from "../bench/lib/score.mjs";

export const FIXTURE_STATE = fileURLToPath(
  new URL("./fixtures/bench/clockgrove__clockgrove", import.meta.url),
);

export function fixtureCard(run = {}) {
  return scoreRun({
    stateDir: FIXTURE_STATE,
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
