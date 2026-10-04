import { createHash } from "node:crypto";
import { unknownCheckNames } from "../check-names.js";
import { knownCheckNames, planningSources } from "../compiler.js";
import type { WorkGraph } from "../contracts.js";
import { attachedFault, decision, StepFault } from "../fault.js";
import { fetchHead } from "../process.js";
import { assertPreIntegrationCheckSources } from "./readiness.js";

/**
 * Checks already verified, keyed by everything the answer depends on. Only
 * successes are kept, so a poll against an unchanged default branch does not
 * re-read the workflows or sources. The tip itself is fetched on every call
 * (it is part of the key), so this saves the reads, not the fetch. The set
 * stays small: a new tip is a new key.
 */
const verified = new Set<string>();
const MAX_VERIFIED = 256;

function remember(key: string): void {
  if (verified.size >= MAX_VERIFIED) verified.clear();
  verified.add(key);
}

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * The CI check names a plan may use at a commit. Reading the workflows can
 * fail: a git error keeps the class git gave it (transient, config); anything
 * else is a decision the operator can answer, not a plain Error.
 */
function readKnownNames(
  objectiveBody: string,
  commit: string,
  checkout: string,
): string[] {
  try {
    return knownCheckNames(objectiveBody, commit, checkout);
  } catch (error) {
    if (attachedFault(error)) throw error;
    throw new StepFault(
      decision(
        `Factory could not read the GitHub workflows at ${commit.slice(0, 12)} to check the planned CI check names. Fix the checkout and run factory retry, or cancel and plan again?`,
        error instanceof Error ? error.message : String(error),
      ),
      { cause: error },
    );
  }
}

/**
 * While a source-required CI check has not reported on the PR head, the check
 * must still be defined where it was planned from: a job in the default
 * branch's workflows or a line under the Objective's Required checks, and the
 * pinned source that requires it must be unchanged. A job renamed after
 * planning would never report, and delivery would wait forever; ask the
 * operator.
 *
 * `gates` is the unreported gates only (unreportedGates): a gate already on
 * the exact head, or a PR already merged, is never asked, however main has
 * changed since. A CI proof is bound by QA, at its own commit, while it waits
 * (assertProofCheckDefined).
 *
 * The only answers offered are ones that work mid-run: restore what changed
 * and `factory retry`, or cancel and plan again. Editing the Objective trips
 * its changed-body check, and an amendment must preserve source-required
 * checks.
 */
export async function assertCheckSourcesAtIntegration(args: {
  graph: WorkGraph;
  baseSha: string;
  objectiveBody: string;
  checkout: string;
  /** The gates still unreported on the head; nothing to bind when empty. */
  gates: string[];
  /** Read only when there is a gate to bind. */
  defaultBranch: () => string | Promise<string>;
}): Promise<void> {
  const { checkout, gates } = args;
  if (!gates.length) return;
  const graph: WorkGraph = {
    ...args.graph,
    requiredPreIntegrationChecks: (
      args.graph.requiredPreIntegrationChecks ?? []
    ).filter((gate) => gates.includes(gate.checkName)),
  };
  const defaultBranch = await args.defaultBranch();
  const tip = await fetchHead(checkout, defaultBranch);
  const key = JSON.stringify([
    "delivery",
    checkout,
    args.baseSha,
    tip,
    digest(args.objectiveBody),
    gates,
  ]);
  if (verified.has(key)) return;
  try {
    assertPreIntegrationCheckSources(
      graph,
      planningSources(args.objectiveBody, args.baseSha, checkout),
    );
  } catch (error) {
    if (attachedFault(error)) throw error;
    throw new StepFault(
      decision(
        "A source that requires a CI check changed since planning. Restore it and run factory retry, or cancel and plan again?",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  const known = readKnownNames(args.objectiveBody, tip, checkout);
  const unknown = unknownCheckNames(gates, known);
  if (unknown.length)
    throw new StepFault(
      decision(
        `CI check ${unknown.map((name) => JSON.stringify(name)).join(", ")} has not reported on the PR head and is no longer a job in ${defaultBranch}'s GitHub workflows (at ${tip.slice(0, 12)}) or an entry under the Objective's Required checks, so it will never report. Restore the job under that name and run factory retry, or cancel and plan again?`,
        `Defined now: ${JSON.stringify(known.slice(0, 20))}`,
      ),
    );
  remember(key);
}

/**
 * A QA CI proof that is about to wait must name a check its own commit
 * defines: a job in that commit's workflows or a line under the Objective's
 * Required checks. The commit is the one the check must report on, so a later
 * rename on the default branch does not matter, and a proof that has
 * completed or is not waiting is never asked. A commit that lacks the job can
 * never report it, and restoring the job elsewhere does not change that
 * commit, so the only answer is to cancel and plan again.
 */
export function assertProofCheckDefined(args: {
  checkName: string;
  /** The commit the check must report on. */
  commit: string;
  objectiveBody: string;
  checkout: string;
}): void {
  const { checkName, commit, checkout } = args;
  const key = JSON.stringify([
    "proof",
    checkout,
    commit,
    digest(args.objectiveBody),
    checkName,
  ]);
  if (verified.has(key)) return;
  const known = readKnownNames(args.objectiveBody, commit, checkout);
  if (!known.includes(checkName))
    throw new StepFault(
      decision(
        `CI check ${JSON.stringify(checkName)} is not a job in the GitHub workflows at ${commit.slice(0, 12)}, the commit it must report on, or an entry under the Objective's Required checks, so it will never report. Cancel and plan again with a check that exists?`,
        `Defined there: ${JSON.stringify(known.slice(0, 20))}`,
      ),
    );
  remember(key);
}
