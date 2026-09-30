import type { DeliveryObservation } from "../contracts.js";
import type { FactoryState } from "../state.js";

/** A read-only wait, never an uncertain submitted delivery effect. */
export class DeliveryReadinessPending extends Error {
  constructor() {
    super(
      "Awaiting exact published head checks or target protection readiness",
    );
  }
}

export function assertDeliveryReady(observation: DeliveryObservation): void {
  if (observation.state !== "open" || observation.checks === "failing")
    throw new Error(
      `PR is not mergeable: ${observation.state}, checks ${observation.checks}`,
    );
  if (observation.mergeReadiness === "blocked")
    throw new Error("PR is not mergeable under authenticated target readiness");
  if (
    observation.checks === "pending" ||
    observation.mergeReadiness === "waiting"
  )
    throw new DeliveryReadinessPending();
}

/** Existing publication/QA identity is the durable continuation, not another store. */
export function isReadinessWait(state: FactoryState, id: string): boolean {
  const work = state.work[id];
  return Boolean(
    work &&
      !work.pendingEffect &&
      work.waitingReason &&
      (work.status === "published" ||
        (work.status === "running" &&
          work.step === "validate" &&
          state.graph.items.find((item) => item.id === id)?.kind === "qa")),
  );
}

export function hasReadinessWait(state: FactoryState): boolean {
  return Object.keys(state.work).some((id) => isReadinessWait(state, id));
}
