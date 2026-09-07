import type { FactoryEvent } from "../protocol/events.js";
import { policyDigest } from "../protocol/policy.js";
import { recoveryEventDigest } from "./identity.js";
import type { RecoveryPlan } from "./plan.js";

/** Authenticated request envelopes have their own run/sequence namespace. They
 * are historical authority for a pinned source start, never a successor effect.
 * Callers retain every envelope and independently verify the adoption/usage chain.
 * Exact transport duplicates must already have been collapsed by the caller. */
export function recoveryRunHistoryActivations(
  plan: RecoveryPlan,
  events: readonly FactoryEvent[],
): ReadonlySet<FactoryEvent> | null {
  const sourceRuns = new Set(plan.history.map((entry) => entry.runId));
  const activations = new Set<FactoryEvent>();
  for (const entry of plan.history) {
    const starts = events.filter(
      (event) => event.event === "FactoryRunStarted" && event.runId === entry.runId,
    );
    const start = starts[0];
    if (start?.event !== "FactoryRunStarted" || !start.activationRequestId) continue;
    if (starts.length !== 1 || recoveryEventDigest(start) !== entry.startDigest) return null;
    const requests = events.filter(
      (event) =>
        event.event === "ActivationRequested" && event.requestId === start.activationRequestId,
    );
    const request = requests[0];
    if (
      requests.length !== 1 ||
      request?.event !== "ActivationRequested" ||
      request.objective !== plan.objective ||
      request.runId !== start.activationRequestId ||
      request.requestedBy.toLowerCase() !== start.actor.toLowerCase() ||
      request.repository.toLowerCase() !== plan.repository.toLowerCase() ||
      request.baseSha !== start.baseSha ||
      request.policyDigest !== start.policyDigest ||
      policyDigest(request.policy) !== request.policyDigest ||
      request.controllerProtocolMin !== start.protocol ||
      request.controllerProtocolMax !== start.protocol ||
      Date.parse(request.at) > Date.parse(start.at) ||
      activations.has(request)
    )
      return null;
    activations.add(request);
  }
  if (
    events.some(
      (event) =>
        event.objective !== plan.objective ||
        (event.event === "ActivationRequested"
          ? !activations.has(event)
          : !sourceRuns.has(event.runId) && event.runId !== plan.successorRunId),
    )
  )
    return null;
  return activations;
}
