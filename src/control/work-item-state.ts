import type { FactoryEvent } from "../protocol/events.js";
import { COPILOT_ASSIGNEE_LOGIN, type WorkItemSnapshot, type WorkItemState } from "../types.js";

export const RESERVATION_STALE_MS = 5 * 60_000;
type WorkScopedEvent = Extract<
  FactoryEvent,
  { kind: "attempt" | "validation" | "budget" | "media" }
>;

const assignedToCopilot = (workItem: WorkItemSnapshot) =>
  workItem.assignees.includes(COPILOT_ASSIGNEE_LOGIN);
const hasHumanAssignee = (workItem: WorkItemSnapshot) =>
  workItem.assignees.some((login) => login !== COPILOT_ASSIGNEE_LOGIN);

function eventsForCurrentAttempt(workItem: WorkItemSnapshot): WorkScopedEvent[] {
  const events = (workItem.factoryEvents ?? []).filter(
    (event): event is WorkScopedEvent =>
      (event.kind === "attempt" ||
        event.kind === "validation" ||
        event.kind === "budget" ||
        event.kind === "media") &&
      "workItem" in event &&
      event.workItem === workItem.number,
  );
  const latestAttempt = events.reduce((max, event) => Math.max(max, event.attempt ?? 0), 0);
  return events
    .filter((event) => (event.attempt ?? 0) === latestAttempt)
    .sort((a, b) => a.sequence - b.sequence);
}

function inconsistentAttempt(events: WorkScopedEvent[]): boolean {
  const attemptEvents = events.filter((event) => event.kind === "attempt");
  const values = <K extends "runId" | "backend" | "baseSha" | "directorEpoch" | "policyDigest">(
    key: K,
  ) =>
    new Set(
      attemptEvents.map((event) => String(event[key])).filter((value) => value !== "undefined"),
    );
  return (
    values("runId").size > 1 ||
    values("backend").size > 1 ||
    values("baseSha").size > 1 ||
    values("directorEpoch").size > 1 ||
    values("policyDigest").size > 1
  );
}

export function deriveWorkItemState(
  workItem: WorkItemSnapshot,
  now: Date,
  reservationStaleMs = RESERVATION_STALE_MS,
): WorkItemState {
  const events = eventsForCurrentAttempt(workItem);
  const merged = workItem.linkedPullRequests.some((pr) => pr.state === "MERGED");
  if (events.length === 0) {
    // A native closing reference plus the closed issue is conclusive GitHub
    // state even when a maintainer integrated the work outside Factory. Do not
    // invent an attempt receipt, and do not rerun code already on the base.
    if (workItem.closed && merged) return "done";
    if (assignedToCopilot(workItem) || workItem.linkedPullRequests.length > 0 || workItem.closed) {
      return "inconsistent";
    }
    if (hasHumanAssignee(workItem)) return "escalated";
    if (workItem.blockedBy.some((dependency) => !dependency.closed)) return "blocked";
    return "unstarted";
  }

  if (inconsistentAttempt(events)) return "inconsistent";
  if (assignedToCopilot(workItem)) return "inconsistent";
  const mediaEvents = events.filter((event) => event.kind === "media");
  if (mediaEvents.length) {
    if (merged) return "inconsistent";
    const cleanup = [...mediaEvents]
      .reverse()
      .find((event) => ["MediaCleanupFailed", "MediaCleanupCompleted"].includes(event.event));
    if (cleanup?.event === "MediaCleanupFailed") return "in_flight";
    const attemptEvents = events.filter((event) => event.kind === "attempt");
    const terminalAttempt = [...attemptEvents]
      .reverse()
      .find((event) =>
        ["AttemptFailed", "AttemptTimedOut", "AttemptCancelled"].includes(event.event),
      );
    if (terminalAttempt) return "failed";
    const activation = mediaEvents.find((event) => event.event === "AssetActivated");
    if (activation) return workItem.closed ? "done" : "for_review";
    if (workItem.closed) return "inconsistent";
    const decision = [...mediaEvents]
      .reverse()
      .find((event) => event.event === "AssetDecisionRecorded");
    if (decision?.event === "AssetDecisionRecorded") {
      if (decision.decisionKind === "approved") return "for_review";
      return decision.decisionKind === "revision-requested" ? "failed" : "escalated";
    }
    if (mediaEvents.some((event) => event.event === "AssetSetReady")) return "for_review";
    if (mediaEvents.some((event) => event.event === "MediaDispatchRecorded")) return "in_flight";
  }
  if (workItem.closed && merged) return "done";
  const integrated = events.some(
    (event) => event.kind === "attempt" && event.event === "AttemptIntegrated",
  );
  if (workItem.closed && !merged) return "inconsistent";
  if (integrated && !merged) return "inconsistent";
  // A merge, issue close, and audit comment are separate GitHub mutations.
  // Route a partial integration through the idempotent recovery path until all
  // three durable facts agree.
  if (merged) return "for_review";
  const attemptEvents = events.filter((event) => event.kind === "attempt");
  const deferred = [...attemptEvents].reverse().find((event) => event.event === "AttemptDeferred");
  if (deferred) {
    if (attemptEvents.some((event) => event.sequence > deferred.sequence)) {
      return "inconsistent";
    }
    if (hasHumanAssignee(workItem)) return "escalated";
    if (workItem.blockedBy.some((dependency) => !dependency.closed)) return "blocked";
    return "unstarted";
  }
  const succeeded = attemptEvents.filter(
    (event) => event.event === "AttemptSucceeded" && Boolean(event.artifactDigest),
  );
  const cancelled = attemptEvents.filter((event) => event.event === "AttemptCancelled");
  const recoveredCollection = attemptEvents.find(
    (event) =>
      event.event === "AttemptCollected" &&
      event.recoveryEpoch !== undefined &&
      cancelled.length === 1 &&
      succeeded.length === 1 &&
      event.sequence > cancelled[0]!.sequence &&
      cancelled[0]!.sequence > succeeded[0]!.sequence &&
      event.artifactDigest === succeeded[0]!.artifactDigest,
  );
  const terminalFailure = events.some(
    (event) =>
      event.kind === "attempt" &&
      (["AttemptFailed", "AttemptTimedOut"].includes(event.event) ||
        event.event === "AttemptRecoveryBlocked" ||
        (event.event === "AttemptCancelled" && !recoveredCollection)),
  );
  if (terminalFailure) return "failed";
  const validation = [...events].reverse().find((event) => event.kind === "validation");
  if (validation?.kind === "validation") {
    if (!validation.passed) return "failed";
    if (events.some((event) => event.kind === "attempt" && event.event === "AttemptPublished")) {
      return "for_review";
    }
    return "validating";
  }
  if (events.some((event) => event.kind === "attempt" && event.event === "AttemptValidated")) {
    return "validating";
  }
  if (
    events.some(
      (event) =>
        event.kind === "attempt" &&
        ["AttemptSucceeded", "AttemptCollected", "AttemptPublished"].includes(event.event),
    )
  ) {
    return "validating";
  }
  if (
    events.some(
      (event) =>
        event.kind === "attempt" && ["AttemptStarted", "AttemptProgressed"].includes(event.event),
    )
  ) {
    return "in_flight";
  }
  const reservation = events.find(
    (event) => event.kind === "attempt" && event.event === "AttemptReserved",
  );
  if (reservation) {
    return now.getTime() - new Date(reservation.at).getTime() >= reservationStaleMs
      ? "failed"
      : "reserved";
  }
  return "inconsistent";
}
