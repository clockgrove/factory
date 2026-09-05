import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "./receipts.js";

export type ActivationRequest = Extract<
  FactoryEvent,
  { kind: "run"; event: "ActivationRequested" }
>;
export type ActivationCancellation = Extract<
  FactoryEvent,
  { kind: "run"; event: "ActivationCancellationRequested" }
>;
export interface ActivationBinding {
  objective: number;
  requestId: string;
  repository: string;
  requestedBy: string;
  baseSha: string;
  policyDigest: string;
}

export function latestActivation(
  events: readonly FactoryEvent[],
  objective: number,
): ActivationRequest | undefined {
  return deduplicateFactoryEvents([...events])
    .filter(
      (event): event is ActivationRequest =>
        event.kind === "run" &&
        event.event === "ActivationRequested" &&
        event.objective === objective,
    )
    .at(-1);
}

/** Inputs must already be GitHub-author authenticated. A withdrawal revokes one
 * activation only; it is neither a run terminal nor authority for its successor. */
export function activationCancellation(
  events: readonly FactoryEvent[],
  binding: ActivationBinding,
): ActivationCancellation | undefined {
  return deduplicateFactoryEvents([...events]).find((event): event is ActivationCancellation => {
    if (
      event.kind !== "run" ||
      event.event !== "ActivationCancellationRequested" ||
      event.objective !== binding.objective ||
      event.activationRequestId !== binding.requestId ||
      event.requestedBy.toLowerCase() !== binding.requestedBy.toLowerCase()
    )
      return false;
    if (
      event.runId !== binding.requestId ||
      event.repository.toLowerCase() !== binding.repository.toLowerCase() ||
      event.baseSha !== binding.baseSha ||
      event.policyDigest !== binding.policyDigest
    )
      throw new Error("activation cancellation differs from its immutable activation binding");
    return true;
  });
}
