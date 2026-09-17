import { createHash } from "node:crypto";

import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "./receipts.js";

const COMMAND_NAMES = new Set([
  "RunPauseRequested",
  "RunResumeRequested",
  "RunDrainRequested",
  "CloudPauseRequested",
  "WorkItemRetryRequested",
  "WorkItemPriorityChanged",
]);

type CommandEvent = FactoryEvent & {
  kind: "run";
  requestedBy: string;
  requestId: string;
};

type MediaRevisionDecisionEvent = FactoryEvent & {
  kind: "media";
  event: "AssetDecisionRecorded";
  workItem: number;
  decisionDigest: string;
  decisionKind: "revision-requested";
  requestId: string;
  requestedBy: string;
  reason: string;
};

export interface RetryCommand {
  workItem: number;
  sequence: number;
  requestedBy: string;
  requestId: string;
}

export interface PriorityCommand {
  workItem: number;
  rank: number;
  sequence: number;
  requestedBy: string;
  requestId: string;
}

export interface AdmissionGateCommand {
  kind: "pause" | "drain";
  sequence: number;
  requestedBy: string;
  requestId: string;
}

export interface DurableCommandState {
  admissionsPaused: boolean;
  draining: boolean;
  cloudPaused: boolean;
  admissionGate: AdmissionGateCommand | null;
  latestSequence: number | null;
  retries: ReadonlyMap<number, RetryCommand>;
  priorities: ReadonlyMap<number, PriorityCommand>;
}

function isCommandEvent(event: FactoryEvent): event is CommandEvent {
  return (
    event.kind === "run" &&
    COMMAND_NAMES.has(event.event) &&
    "requestedBy" in event &&
    typeof event.requestedBy === "string" &&
    "requestId" in event &&
    typeof event.requestId === "string"
  );
}

function isMediaRevisionDecision(event: FactoryEvent): event is MediaRevisionDecisionEvent {
  return (
    event.kind === "media" &&
    event.event === "AssetDecisionRecorded" &&
    event.decisionKind === "revision-requested" &&
    typeof event.decisionDigest === "string" &&
    typeof event.requestId === "string" &&
    typeof event.requestedBy === "string" &&
    typeof event.reason === "string"
  );
}

function commandFingerprint(event: CommandEvent): string {
  return JSON.stringify({
    event: event.event,
    objective: event.objective,
    runId: event.runId,
    requestedBy: event.requestedBy.toLowerCase(),
    workItem: "workItem" in event ? event.workItem : undefined,
    priorityRank: "priorityRank" in event ? event.priorityRank : undefined,
    reason: "reason" in event ? event.reason : undefined,
    mediaRevision: "mediaRevision" in event ? event.mediaRevision : undefined,
  });
}

function assertMediaRevisionRetry(event: CommandEvent, events: readonly FactoryEvent[]) {
  if (
    event.event !== "WorkItemRetryRequested" ||
    !("mediaRevision" in event) ||
    !event.mediaRevision
  )
    return;
  const reason = "reason" in event && typeof event.reason === "string" ? event.reason : null;
  const binding = event.mediaRevision;
  const decisions = deduplicateFactoryEvents(
    events.filter(
      (candidate) =>
        candidate.kind === "media" &&
        candidate.event === "AssetDecisionRecorded" &&
        candidate.objective === event.objective &&
        candidate.runId === event.runId &&
        candidate.workItem === event.workItem &&
        candidate.requestId === binding.decisionRequestId &&
        candidate.assetSetDigest === binding.assetSetDigest &&
        candidate.decisionDigest === binding.decisionDigest &&
        candidate.decisionKind === "revision-requested" &&
        candidate.requestedBy?.toLowerCase() === event.requestedBy.toLowerCase(),
    ),
  );
  if (
    !reason ||
    createHash("sha256").update(reason).digest("hex") !== binding.feedbackDigest ||
    decisions.length !== 1 ||
    decisions[0]?.reason !== reason
  )
    throw new Error("media revision retry differs from its authenticated review decision");
}

/**
 * Reconstruct the active run's operational command state from GitHub evidence.
 *
 * Request IDs are idempotency keys: an exact replay keeps its first sequence,
 * while a conflicting reuse fails closed. Commands for another Objective/run,
 * commands at or before the run start, and commands not issued by the active
 * run actor never affect scheduling.
 */
export function deriveDurableCommandState(args: {
  events: readonly FactoryEvent[];
  objective: number;
  runId: string;
  runActor: string;
  runStartSequence: number;
}): DurableCommandState {
  const candidates = deduplicateFactoryEvents(
    args.events.filter(
      (event): event is CommandEvent =>
        isCommandEvent(event) &&
        event.objective === args.objective &&
        event.runId === args.runId &&
        event.sequence > args.runStartSequence &&
        event.requestedBy.toLowerCase() === args.runActor.toLowerCase(),
    ),
  )
    .filter(isCommandEvent)
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.at.localeCompare(right.at) ||
        left.requestId.localeCompare(right.requestId) ||
        left.event.localeCompare(right.event),
    );

  const idempotent = new Map<string, { fingerprint: string; event: CommandEvent }>();
  for (const event of candidates) {
    assertMediaRevisionRetry(event, args.events);
    const fingerprint = commandFingerprint(event);
    const prior = idempotent.get(event.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error(`conflicting durable commands reuse request ID ${event.requestId}`);
      }
      continue;
    }
    idempotent.set(event.requestId, { fingerprint, event });
  }

  let admissionsPaused = false;
  let draining = false;
  let cloudPaused = false;
  let admissionGate: AdmissionGateCommand | null = null;
  let latestSequence: number | null = null;
  const retries = new Map<number, RetryCommand>();
  const priorities = new Map<number, PriorityCommand>();
  const revisionDecisionSequence = new Map<string, number>();
  for (const decision of deduplicateFactoryEvents(
    args.events.filter(
      (event): event is MediaRevisionDecisionEvent =>
        isMediaRevisionDecision(event) &&
        event.objective === args.objective &&
        event.runId === args.runId &&
        event.sequence > args.runStartSequence &&
        event.requestedBy.toLowerCase() === args.runActor.toLowerCase(),
    ),
  )
    .filter(isMediaRevisionDecision)
    .sort((left, right) => left.sequence - right.sequence)) {
    revisionDecisionSequence.set(decision.decisionDigest, decision.sequence);
    retries.set(decision.workItem, {
      workItem: decision.workItem,
      sequence: decision.sequence,
      requestedBy: decision.requestedBy,
      requestId: decision.requestId,
    });
  }
  const commands = [...idempotent.values()].map(({ event }) => event);
  const sequences = [...new Set(commands.map((event) => event.sequence))].sort(
    (left, right) => left - right,
  );

  for (const sequence of sequences) {
    const group = commands.filter((event) => event.sequence === sequence);
    latestSequence = sequence;

    // Same-sequence writers have no observable total order. Apply reversible
    // Resume first and restrictive gates afterward, so ambiguity fails safe.
    if (group.some((event) => event.event === "RunResumeRequested")) {
      admissionsPaused = false;
      draining = false;
      cloudPaused = false;
      admissionGate = null;
    }
    if (group.some((event) => event.event === "CloudPauseRequested")) {
      cloudPaused = true;
    }
    const pause = group.find((event) => event.event === "RunPauseRequested");
    if (pause) {
      admissionsPaused = true;
      draining = false;
      admissionGate = {
        kind: "pause",
        sequence,
        requestedBy: pause.requestedBy,
        requestId: pause.requestId,
      };
    }
    const drain = group.find((event) => event.event === "RunDrainRequested");
    if (drain) {
      admissionsPaused = true;
      draining = true;
      admissionGate = {
        kind: "drain",
        sequence,
        requestedBy: drain.requestedBy,
        requestId: drain.requestId,
      };
    }

    for (const event of group) {
      if (
        event.event === "WorkItemRetryRequested" &&
        "workItem" in event &&
        typeof event.workItem === "number"
      ) {
        const sequence =
          "mediaRevision" in event && event.mediaRevision
            ? revisionDecisionSequence.get(event.mediaRevision.decisionDigest)
            : event.sequence;
        if (sequence === undefined)
          throw new Error("media revision retry has no authenticated review decision");
        retries.set(event.workItem, {
          workItem: event.workItem,
          sequence,
          requestedBy: event.requestedBy,
          requestId: event.requestId,
        });
      }
      if (
        event.event === "WorkItemPriorityChanged" &&
        "workItem" in event &&
        typeof event.workItem === "number" &&
        "priorityRank" in event &&
        typeof event.priorityRank === "number"
      ) {
        const prior = priorities.get(event.workItem);
        if (prior?.sequence === sequence && prior.rank !== event.priorityRank) {
          throw new Error(
            `conflicting priority commands for Work Item #${event.workItem} at sequence ${sequence}`,
          );
        }
        priorities.set(event.workItem, {
          workItem: event.workItem,
          rank: event.priorityRank,
          sequence,
          requestedBy: event.requestedBy,
          requestId: event.requestId,
        });
      }
    }
  }

  // A retry command is a one-shot admission permission. A reservation at the
  // same or later sequence proves the named command was already consumed.
  for (const [workItem, retry] of retries) {
    const consumed = args.events.some(
      (event) =>
        event.objective === args.objective &&
        event.runId === args.runId &&
        event.kind === "attempt" &&
        event.event === "AttemptReserved" &&
        event.workItem === workItem &&
        event.sequence >= retry.sequence,
    );
    if (consumed) retries.delete(workItem);
  }

  return {
    admissionsPaused,
    draining,
    cloudPaused,
    admissionGate,
    latestSequence,
    retries,
    priorities,
  };
}
