import { amendmentAllowed, amendmentsUsedUp } from "./repair-policy.js";
import type { FactoryState } from "./state.js";

/** The most of the model's diagnosis a decision quotes. */
const DIAGNOSIS_QUOTE_CHARS = 400;
export const cappedDiagnosis = (text: string): string =>
  text.length > DIAGNOSIS_QUOTE_CHARS
    ? `${text.slice(0, DIAGNOSIS_QUOTE_CHARS)}...`
    : text;

/**
 * What a predecessor-blame stop tells the operator to do next, from the state
 * now. The order is the one `factory status` uses: a pending amendment first
 * (what settles it), then whether the graph changed since the blame (an
 * amendment landed), then the planning allowance. The allowance comes last
 * because the amendment that fixes the predecessor takes the last revision
 * itself; reading it first would send the operator to cancel after the fix.
 * `digest` is the digest of the graph now.
 */
export function blameDecision(
  state: FactoryState,
  itemId: string,
  digest: string,
): string | undefined {
  const blame = state.work[itemId]?.recovery?.failure?.predecessor;
  if (!blame) return undefined;
  const objective = state.objective;
  const run = `factory run --objective ${objective}`;
  const retry = `factory retry --objective ${objective} --item ${itemId}`;
  const owner = `${blame.item}${blame.pullRequest ? ` (PR #${blame.pullRequest})` : ""}`;
  // The model's text is quoted and capped: it is evidence, not the
  // controller's wording, and it must not read as a command.
  const said = JSON.stringify(blame.diagnosis);
  const head = `${blame.path} is owned by ${owner}, which is merged; ${itemId} did not cause this failure and a repair of ${itemId} cannot fix it. The diagnosis said: ${said}.`;
  const pending = state.pendingAmendment;
  if (pending?.phase === "rejected")
    return `${head} The amendment that was to fix it was rejected: \`factory propose-amendment --objective ${objective} --proposal FILE\` with a replacement`;
  if (pending && pending.phase !== "backlog")
    return `${head} An amendment is pending: (1) \`${run}\` reviews and projects it and merges its Work Items. (2) \`${retry}\`, which starts a new attempt on the integrated head. (3) \`${run}\` again`;
  // The stored text does not follow the amendment's Work Items as they merge;
  // `factory status` does, and says when the retry is due.
  if (blame.graphDigest !== digest)
    return `${head} The graph changed since this stop, so an amendment landed. Once its Work Items have merged (a run merges them; factory status says when): (1) \`${retry}\`, which starts a new attempt on the integrated head. (2) \`${run}\` again`;
  // An amendment needs a planning revision: name it only while one is left.
  return amendmentAllowed(state)
    ? `${head} Fix ${blame.item} in this order: (1) \`factory propose-amendment --objective ${objective} --proposal FILE\` with an in-scope proposal that adds a Work Item depending on ${blame.item} and owning ${blame.path}; it works while the Objective is stopped. (2) If no run is active, \`${run}\` until that Work Item merges. (3) \`${retry}\`, which starts a new attempt on the integrated head. (4) \`${run}\` again`
    : `${head} ${amendmentsUsedUp(objective)}`;
}

/**
 * Rewrite the decision of every item still stopped on a blame, after the
 * graph or the pending amendment changed: the stored text is what `factory
 * run` prints and `status --json` carries, so it must not keep naming a step
 * that is done.
 */
export function refreshBlameDecisions(
  state: FactoryState,
  digest: string,
): void {
  for (const [id, work] of Object.entries(state.work)) {
    const failure = work.recovery?.failure;
    if (work.recovery?.phase !== "stopped" || !failure?.predecessor) continue;
    if (work.status !== "failed") continue;
    const decision = blameDecision(state, id, digest);
    if (decision) failure.decision = decision;
  }
}
