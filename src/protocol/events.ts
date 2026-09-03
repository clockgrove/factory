import { z } from "zod";

import { RunPolicySchema } from "./policy.js";
import {
  MAX_PERSISTED_EVENT_BYTES,
  PROTOCOL_V2,
  boundedText,
  gitSha,
  isoDate,
  safeId,
  sha256Digest,
  validatePersistable,
} from "./limits.js";

const Common = z
  .object({
    protocol: z.literal(PROTOCOL_V2),
    objective: z.number().int().positive(),
    runId: safeId,
    sequence: z.number().int().nonnegative(),
    at: isoDate,
  })
  .passthrough();

const RunStarted = Common.extend({
  kind: z.literal("run"),
  event: z.literal("FactoryRunStarted"),
  actor: boundedText(160),
  repository: boundedText(300),
  objectiveAuthor: boundedText(160),
  fork: z.boolean(),
  baseBranch: boundedText(500),
  policy: RunPolicySchema,
  policyDigest: sha256Digest,
});

const RunTerminal = Common.extend({
  kind: z.literal("run"),
  event: z.enum([
    "FactoryRunCompleted",
    "FactoryRunCancelled",
    "FactoryRunEscalated",
  ]),
  reason: boundedText(8_000).optional(),
});

const RunCancellationRequested = Common.extend({
  kind: z.literal("run"),
  event: z.literal("FactoryRunCancellationRequested"),
  requestedBy: boundedText(160),
  requestId: safeId,
  reason: boundedText(8_000).optional(),
});

const ActivationRequested = Common.extend({
  kind: z.literal("run"),
  event: z.literal("ActivationRequested"),
  requestedBy: boundedText(160),
  requestId: safeId,
  repository: boundedText(300),
  baseSha: gitSha,
  policy: RunPolicySchema,
  policyDigest: sha256Digest,
  controllerProtocolMin: boundedText(80),
  controllerProtocolMax: boundedText(80),
});

const RunControlRequested = Common.extend({
  kind: z.literal("run"),
  event: z.enum([
    "RunPauseRequested",
    "RunResumeRequested",
    "RunDrainRequested",
    "CloudPauseRequested",
  ]),
  requestedBy: boundedText(160),
  requestId: safeId,
  reason: boundedText(8_000).optional(),
});

const WorkItemControlRequested = Common.extend({
  kind: z.literal("run"),
  event: z.enum(["WorkItemRetryRequested", "WorkItemPriorityChanged"]),
  requestedBy: boundedText(160),
  requestId: safeId,
  workItem: z.number().int().positive(),
  priorityRank: z.number().int().min(0).max(1_000).optional(),
  reason: boundedText(8_000).optional(),
});

const ControllerObserved = Common.extend({
  kind: z.literal("controller"),
  event: z.literal("ControllerObserved"),
  controllerId: safeId,
  epoch: z.number().int().positive(),
  expiresAt: isoDate,
  controllerPolicyDigest: sha256Digest,
  protocolMin: boundedText(80),
  protocolMax: boundedText(80),
});

const Lease = Common.extend({
  kind: z.literal("lease"),
  event: z.enum(["LeaseAcquired", "LeaseRenewed", "LeaseReleased"]),
  holder: safeId,
  epoch: z.number().int().positive(),
  expiresAt: isoDate,
  policyDigest: sha256Digest,
  previousOid: gitSha.optional(),
});

const attemptEventNames = [
  "AttemptReserved",
  "AttemptStarted",
  "AttemptProgressed",
  "AttemptSucceeded",
  "AttemptFailed",
  "AttemptTimedOut",
  "AttemptCancelled",
  "AttemptDeferred",
  "AttemptCollected",
  "AttemptPublished",
  "AttemptValidated",
  "AttemptIntegrated",
] as const;

const Attempt = Common.extend({
  kind: z.literal("attempt"),
  event: z.enum(attemptEventNames),
  workItem: z.number().int().positive(),
  attempt: z.number().int().positive(),
  backend: safeId,
  baseSha: gitSha,
  directorEpoch: z.number().int().positive(),
  recoveryEpoch: z.number().int().positive().optional(),
  policyDigest: sha256Digest,
  providerResourceId: boundedText(500).optional(),
  artifactDigest: sha256Digest.optional(),
  headSha: gitSha.optional(),
  sessionId: boundedText(500).optional(),
  modelProfile: boundedText(160).optional(),
  reportedModelTokens: z.number().int().nonnegative().optional(),
  admissionClass: z.enum(["local", "remote-required", "burst"]).optional(),
  admissionReason: z.enum([
    "local-capacity",
    "capability-required",
    "local-saturated",
    "queue-delay",
    "deadline",
  ]).optional(),
  requestedCpu: z.number().positive().max(256).optional(),
  requestedMemoryMb: z.number().int().positive().max(1_048_576).optional(),
  priorityRank: z.number().int().min(0).max(1_000).optional(),
  priorityFieldId: boundedText(200).optional(),
  priorityOptionId: boundedText(200).optional(),
  subIssuePosition: z.number().int().nonnegative().optional(),
  criticalPathLength: z.number().int().nonnegative().optional(),
  unfinishedDownstream: z.number().int().nonnegative().optional(),
  capacityMeasuredAt: isoDate.optional(),
  effectiveCpu: z.number().positive().max(256).optional(),
  availableMemoryMb: z.number().int().nonnegative().max(1_048_576).optional(),
  loadRatio: z.number().nonnegative().finite().optional(),
  memoryUsageRatio: z.number().min(0).max(1).optional(),
  reason: boundedText(8_000).optional(),
});

const Scheduling = Common.extend({
  kind: z.literal("scheduling"),
  event: z.literal("WorkItemQueued"),
  workItem: z.number().int().positive(),
  directorEpoch: z.number().int().positive(),
  policyDigest: sha256Digest,
  reason: boundedText(2_000),
  observedPriorityRank: z.number().int().min(0).max(1_000),
  observedSubIssuePosition: z.number().int().nonnegative(),
});

const Capacity = Common.extend({
  kind: z.literal("capacity"),
  event: z.enum(["CapacityReserved", "CapacityReconciled"]),
  workItem: z.number().int().positive(),
  attempt: z.number().int().positive(),
  phase: z.enum(["execution", "validation"]),
  backend: safeId,
  requestedCpu: z.number().positive().max(256),
  requestedMemoryMb: z.number().int().positive().max(1_048_576),
  directorEpoch: z.number().int().positive(),
  policyDigest: sha256Digest,
  reason: boundedText(2_000).optional(),
});

const Validation = Common.extend({
  kind: z.literal("validation"),
  event: z.literal("ValidationRecorded"),
  workItem: z.number().int().positive(),
  attempt: z.number().int().positive(),
  baseSha: gitSha,
  outputTreeSha: gitSha,
  passed: z.boolean(),
  evidenceDigest: sha256Digest,
});

const Graph = Common.extend({
  kind: z.literal("graph"),
  event: z.literal("GraphCompiled"),
  graphDigest: sha256Digest,
  graphSize: z.number().int().positive().max(100),
  baseSha: gitSha,
  graphRef: boundedText(500),
  graphBlobSha: gitSha,
});

const Budget = Common.extend({
  kind: z.literal("budget"),
  event: z.enum(["BudgetReserved", "BudgetReconciled"]),
  workItem: z.number().int().positive().optional(),
  attempt: z.number().int().positive().optional(),
  phase: z.enum(["management", "execution", "validation"]),
  unit: z.enum([
    "model_tokens",
    "local_milliseconds",
    "sandbox_milliseconds",
    "managed_sessions",
    "validation_milliseconds",
  ]),
  amount: z.number().nonnegative().finite(),
});

export const FactoryEventSchema = z.union([
  RunStarted,
  RunTerminal,
  RunCancellationRequested,
  ActivationRequested,
  RunControlRequested,
  WorkItemControlRequested,
  ControllerObserved,
  Lease,
  Attempt,
  Scheduling,
  Capacity,
  Validation,
  Graph,
  Budget,
]);

export type FactoryEvent = z.infer<typeof FactoryEventSchema>;
export type AttemptEvent = z.infer<typeof Attempt>;
export type LeaseEvent = z.infer<typeof Lease>;

export function parseFactoryEvent(input: unknown): FactoryEvent {
  const record = FactoryEventSchema.parse(input);
  validatePersistable(record, MAX_PERSISTED_EVENT_BYTES, "Factory event");
  return record;
}

export function isTerminalAttemptEvent(event: AttemptEvent): boolean {
  return [
    "AttemptSucceeded",
    "AttemptFailed",
    "AttemptTimedOut",
    "AttemptCancelled",
    "AttemptDeferred",
    "AttemptIntegrated",
  ].includes(event.event);
}
