// Pairing a planner and a reviewer from different providers. `--config` picks
// the planner; `--reviewer-config` supplies the `planning` block whose models
// review the graph and the result. Both are built the way production builds a
// planning model, so a pair differs from a single config in nothing else.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dist = resolve(import.meta.dirname, "../../dist");

/** Planning (structured generation, diagnosis) from one model, review from another. */
export function pairedPlanningModel(planner, reviewer) {
  return {
    generateStructured: (request) => planner.generateStructured(request),
    reviewGraph: (request) => reviewer.reviewGraph(request),
    ...(reviewer.reviewResult
      ? { reviewResult: (request) => reviewer.reviewResult(request) }
      : {}),
  };
}

/**
 * The reviewer's `planning` block from a Factory configuration file. Throws a
 * message fit for the operator when the file or block is not usable.
 */
export async function readReviewerPlanning(path) {
  let reviewer;
  try {
    reviewer = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`--reviewer-config ${path}: ${error.message}`);
  }
  if (!reviewer?.planning || typeof reviewer.planning !== "object")
    throw new Error(`--reviewer-config ${path}: no \`planning\` block`);
  const { validatePlanning } = await import(
    pathToFileURL(resolve(dist, "index.js")).href
  );
  try {
    validatePlanning(reviewer.planning);
  } catch (error) {
    throw new Error(`--reviewer-config ${path}: ${error.message}`);
  }
  return reviewer.planning;
}

/** The configured planner paired with a reviewer built from `reviewerPlanning`. */
export async function composePairedPlanningModel(
  config,
  reviewerPlanning,
  compose,
) {
  const composePlanningModel =
    compose ??
    (await import(pathToFileURL(resolve(dist, "index.js")).href))
      .composePlanningModel;
  return pairedPlanningModel(
    composePlanningModel(config),
    composePlanningModel({ ...config, planning: reviewerPlanning }),
  );
}
