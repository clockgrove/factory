import { appendFileSync, readFileSync } from "node:fs";
import { createPlanningModel as reviewModel } from "./eval-review-model.mjs";

/**
 * Review-only `--planning-model` whose first `FLAKY_FAILURES` graph reviews
 * (counted in the file `FLAKY_STATE`) fail with `FLAKY_MESSAGE`.
 */
export function createPlanningModel(options) {
  const model = reviewModel(options);
  return {
    ...model,
    async reviewGraph(request) {
      appendFileSync(process.env.FLAKY_STATE, "x");
      const calls = readFileSync(process.env.FLAKY_STATE, "utf8").length;
      if (calls <= Number(process.env.FLAKY_FAILURES ?? 1))
        throw new Error(process.env.FLAKY_MESSAGE);
      return model.reviewGraph(request);
    },
  };
}
