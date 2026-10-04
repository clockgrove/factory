import { appendFileSync, readFileSync } from "node:fs";
import { createPlanningModel as fixturePlanner } from "./eval-fixture-planner.mjs";

/**
 * `--planning-model` whose first `FLAKY_FAILURES` constructions (counted in
 * the file `FLAKY_STATE`, across processes and retries) fail with
 * `FLAKY_MESSAGE`, as a provider outage would. Later ones plan normally.
 */
export function createPlanningModel(options) {
  appendFileSync(process.env.FLAKY_STATE, "x");
  const calls = readFileSync(process.env.FLAKY_STATE, "utf8").length;
  if (calls <= Number(process.env.FLAKY_FAILURES ?? 1))
    throw new Error(process.env.FLAKY_MESSAGE);
  return fixturePlanner(options);
}
