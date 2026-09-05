import type { DurableObjectiveActivation } from "../control/github-store.js";
import type { CompiledGraphReadStore } from "../control/graphs.js";
import { deriveDurableCommandState } from "../control/commands.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import type { FactoryEvent } from "../protocol/events.js";
import { recoveryEventDigest } from "./identity.js";
import { loadRecoveryPlan } from "./plan.js";

/** Discovery locates acknowledged work; it does not authorize adoption or execution. */
export async function discoverRecoveryActivation(input: {
  repository: string;
  objective: number;
  actor: string;
  events: FactoryEvent[];
  store: CompiledGraphReadStore;
}): Promise<DurableObjectiveActivation | null> {
  const events = deduplicateFactoryEvents(input.events);
  const requests = events
    .filter(
      (event): event is Extract<FactoryEvent, { event: "RecoveryRequested" }> =>
        event.event === "RecoveryRequested" && event.objective === input.objective,
    )
    .sort((a, b) => a.sequence - b.sequence);
  if (requests.length === 0) return null;
  if (new Set(requests.map((request) => request.predecessorRunId)).size !== requests.length)
    throw new Error("Competing recovery requests require reconciliation");
  const request = requests.at(-1)!;
  const planRecord = await loadRecoveryPlan(input.store, input.objective, request.planDigest);
  if (!planRecord) throw new Error("Acknowledged recovery plan is unavailable");
  const plan = planRecord.plan;
  const predecessor = events.find(
    (event) => event.event === "FactoryRunStarted" && event.runId === plan.predecessor.runId,
  );
  const terminal = events.find(
    (event) => recoveryEventDigest(event) === plan.predecessor.terminalDigest,
  );
  if (
    request.repository.toLowerCase() !== input.repository.toLowerCase() ||
    plan.repository.toLowerCase() !== input.repository.toLowerCase() ||
    request.requestedBy.toLowerCase() !== input.actor.toLowerCase() ||
    predecessor?.event !== "FactoryRunStarted" ||
    predecessor.actor.toLowerCase() !== input.actor.toLowerCase() ||
    recoveryEventDigest(predecessor) !== plan.predecessor.startDigest ||
    !terminal ||
    request.sequence <= terminal.sequence ||
    request.requestId !== plan.requestId ||
    request.predecessorRunId !== plan.predecessor.runId ||
    request.predecessorTerminalDigest !== plan.predecessor.terminalDigest ||
    request.successorRunId !== plan.successorRunId ||
    request.policyDigest !== plan.policyDigest ||
    request.baseSha !== plan.expectedBaseSha
  )
    throw new Error("Acknowledged recovery request binding is invalid");
  const starts = events.filter(
    (event): event is Extract<FactoryEvent, { event: "FactoryRunStarted" }> =>
      event.event === "FactoryRunStarted" && event.runId === plan.successorRunId,
  );
  if (starts.length > 1) throw new Error("Conflicting successor starts");
  const start = starts[0];
  if (start) {
    if (
      start.recoveryRequestId !== request.requestId ||
      start.recoveryPlanDigest !== request.planDigest ||
      start.predecessorRunId !== request.predecessorRunId ||
      start.policyDigest !== request.policyDigest ||
      start.baseSha !== request.baseSha ||
      start.actor.toLowerCase() !== input.actor.toLowerCase()
    )
      throw new Error("Successor start does not match acknowledged recovery");
    if (
      events.some(
        (event) =>
          event.runId === start.runId &&
          event.sequence > start.sequence &&
          ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
            event.event,
          ),
      )
    )
      return null;
    const commands = deriveDurableCommandState({
      events,
      objective: input.objective,
      runId: start.runId,
      runActor: start.actor,
      runStartSequence: start.sequence,
    });
    if (
      commands.admissionGate &&
      events.some(
        (event) =>
          event.kind === "run" &&
          event.runId === start.runId &&
          event.event ===
            (commands.admissionGate!.kind === "drain"
              ? "RunDrainCompleted"
              : "RunPauseAcknowledged") &&
          event.commandRequestId === commands.admissionGate!.requestId,
      )
    )
      return null;
  }
  return {
    objective: input.objective,
    activatedAt: request.at,
    requestId: request.requestId,
    policy: plan.acceptedPolicy,
    policyDigest: plan.policyDigest,
    baseSha: plan.expectedBaseSha,
    requestedBy: request.requestedBy,
    recovery: {
      requestId: request.requestId,
      planDigest: request.planDigest,
      successorRunId: request.successorRunId,
    },
  };
}
