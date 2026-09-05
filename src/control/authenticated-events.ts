import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "./receipts.js";
import { recoveryEventDigest } from "../recovery/identity.js";
import { policyDigest } from "../protocol/policy.js";

export interface AuthenticatedFactoryEvent {
  event: FactoryEvent;
  login: string;
}

function runStartFingerprint(event: FactoryEvent): string {
  const semantic = { ...event } as Record<string, unknown>;
  delete semantic.at;
  delete semantic.sequence;
  if (typeof semantic.actor === "string") {
    semantic.actor = semantic.actor.toLowerCase();
  }
  if (typeof semantic.repository === "string") {
    semantic.repository = semantic.repository.toLowerCase();
  }
  return JSON.stringify(semantic);
}

/**
 * Bind every run ID to exactly one GitHub-authenticated actor. A trusted
 * collaborator may post their own comments, but cannot replace the actor of
 * an existing run by replaying FactoryRunStarted with that run ID.
 */
export function bindAuthenticatedRunActors(
  entries: readonly AuthenticatedFactoryEvent[],
): Map<string, string> {
  const authenticatedRequests = deduplicateFactoryEvents(
    entries.flatMap(({ event, login }) =>
      ((event.kind === "run" && event.event === "ActivationRequested") ||
        (event.kind === "recovery" && event.event === "RecoveryRequested")) &&
      event.requestedBy.toLowerCase() === login.toLowerCase()
        ? [event]
        : [],
    ),
  );
  const activations = new Map(
    deduplicateFactoryEvents(
      entries.flatMap(({ event, login }) =>
        event.kind === "run" &&
        event.event === "ActivationRequested" &&
        event.requestedBy.toLowerCase() === login.toLowerCase()
          ? [event]
          : [],
      ),
    ).map(
      (event) =>
        [
          "requestId" in event && typeof event.requestId === "string" ? event.requestId : "",
          event,
        ] as const,
    ),
  );
  const actors = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  for (const { event, login } of entries) {
    if (
      event.kind !== "run" ||
      event.event !== "FactoryRunStarted" ||
      event.actor.toLowerCase() !== login.toLowerCase()
    ) {
      continue;
    }
    const priorActor = actors.get(event.runId);
    if (priorActor && priorActor.toLowerCase() !== login.toLowerCase()) {
      throw new Error(`Factory run ${event.runId} has conflicting authenticated actors`);
    }
    const fingerprint = runStartFingerprint(event);
    const priorFingerprint = fingerprints.get(event.runId);
    if (priorFingerprint && priorFingerprint !== fingerprint) {
      throw new Error(`Factory run ${event.runId} has conflicting authenticated starts`);
    }
    if (event.activationRequestId) {
      const activation = activations.get(event.activationRequestId);
      if (
        !activation ||
        activation.kind !== "run" ||
        activation.event !== "ActivationRequested" ||
        activation.requestedBy.toLowerCase() !== event.actor.toLowerCase() ||
        activation.repository.toLowerCase() !== event.repository.toLowerCase() ||
        activation.policyDigest !== event.policyDigest ||
        activation.baseSha !== event.baseSha
      ) {
        throw new Error(`Factory run ${event.runId} does not match its authenticated activation`);
      }
    }
    actors.set(event.runId, login);
    fingerprints.set(event.runId, fingerprint);
  }
  const authenticatedHistory = deduplicateFactoryEvents(
    entries.flatMap(({ event, login }) =>
      actors.get(event.runId)?.toLowerCase() === login.toLowerCase() ? [event] : [],
    ),
  );
  for (const event of authenticatedHistory) {
    if (event.kind !== "run" || event.event !== "FactoryRunStarted" || !event.recoveryRequestId)
      continue;
    const request = authenticatedRequests.find(
      (candidate) =>
        candidate.objective === event.objective &&
        "requestId" in candidate &&
        candidate.requestId === event.recoveryRequestId,
    );
    const predecessors = authenticatedHistory.filter(
      (candidate) =>
        candidate.kind === "run" &&
        candidate.event === "FactoryRunStarted" &&
        candidate.objective === event.objective &&
        candidate.runId === event.predecessorRunId,
    );
    const predecessor = predecessors[0];
    const terminals = authenticatedHistory.filter(
      (candidate) =>
        candidate.kind === "run" &&
        ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
          candidate.event,
        ) &&
        candidate.objective === event.objective &&
        candidate.runId === event.predecessorRunId,
    );
    const terminal = terminals[0];
    if (
      !request ||
      request.kind !== "recovery" ||
      request.event !== "RecoveryRequested" ||
      predecessors.length !== 1 ||
      !predecessor ||
      predecessor.kind !== "run" ||
      predecessor.event !== "FactoryRunStarted" ||
      terminals.length !== 1 ||
      !terminal ||
      terminal.sequence <= predecessor.sequence ||
      request.sequence <= terminal.sequence ||
      event.sequence <= request.sequence ||
      request.requestedBy.toLowerCase() !== event.actor.toLowerCase() ||
      predecessor.actor.toLowerCase() !== event.actor.toLowerCase() ||
      request.runId !== predecessor.runId ||
      request.predecessorRunId !== predecessor.runId ||
      request.successorRunId !== event.runId ||
      request.planDigest !== event.recoveryPlanDigest ||
      request.predecessorTerminalDigest !== recoveryEventDigest(terminal) ||
      request.repository.toLowerCase() !== event.repository.toLowerCase() ||
      predecessor.repository.toLowerCase() !== event.repository.toLowerCase() ||
      predecessor.objectiveAuthor.toLowerCase() !== event.objectiveAuthor.toLowerCase() ||
      predecessor.fork !== event.fork ||
      predecessor.baseBranch !== event.baseBranch ||
      request.policyDigest !== event.policyDigest ||
      policyDigest(event.policy) !== event.policyDigest ||
      request.baseSha !== event.baseSha
    ) {
      throw new Error(
        "Successor start does not match its authenticated recovery request and terminal predecessor",
      );
    }
  }
  return actors;
}
