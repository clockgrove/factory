import { z } from "zod";

import { RunPolicySchema } from "./policy.js";
import { ReportedModelUsageSchema } from "./model-usage.js";
export { ReportedModelUsageSchema, type ReportedModelUsage } from "./model-usage.js";
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
  activationRequestId: safeId.optional(),
  baseSha: gitSha.optional(),
  recoveryRequestId: safeId.optional(),
  recoveryPlanDigest: sha256Digest.optional(),
  predecessorRunId: safeId.optional(),
}).superRefine((value, context) => {
  const recovery = [value.recoveryRequestId, value.recoveryPlanDigest, value.predecessorRunId];
  if (
    recovery.some((field) => field !== undefined) &&
    (!recovery.every((field) => field !== undefined) ||
      value.activationRequestId ||
      !value.baseSha ||
      value.predecessorRunId === value.runId)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "A successor start requires its complete distinct predecessor/request/plan/base binding and cannot also be an ordinary activation",
    });
  }
});

// A separate event kind makes unsupported controllers fail closed instead of
// ignoring successor authority as an optional field on an ordinary activation.
const RecoveryRequested = Common.extend({
  kind: z.literal("recovery"),
  event: z.literal("RecoveryRequested"),
  requestedBy: boundedText(160),
  requestId: safeId,
  repository: boundedText(300),
  planDigest: sha256Digest,
  predecessorRunId: safeId,
  predecessorTerminalDigest: sha256Digest,
  successorRunId: safeId,
  policyDigest: sha256Digest,
  baseSha: gitSha,
}).superRefine((value, context) => {
  if (value.runId !== value.predecessorRunId || value.successorRunId === value.predecessorRunId)
    context.addIssue({
      code: "custom",
      message: "A recovery request belongs to its predecessor and names a distinct successor",
    });
});

const RecoveryConsumed = Common.extend({
  kind: z.literal("recovery"),
  event: z.literal("RecoveryConsumed"),
  recoveryRequestId: safeId,
  planDigest: sha256Digest,
  predecessorRunId: safeId,
  predecessorTerminalDigest: sha256Digest,
  claimRef: boundedText(500),
  claimOid: gitSha,
}).superRefine((value, context) => {
  if (value.runId === value.predecessorRunId)
    context.addIssue({
      code: "custom",
      message: "A consumed recovery belongs to a distinct successor",
    });
});

const RunTerminal = Common.extend({
  kind: z.literal("run"),
  event: z.enum(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]),
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

const ActivationRejected = Common.extend({
  kind: z.literal("run"),
  event: z.literal("ActivationRejected"),
  activationRequestId: safeId,
  requestedBy: boundedText(160),
  baseSha: gitSha,
  policyDigest: sha256Digest,
  reason: boundedText(8_000),
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

const RunControlAcknowledged = Common.extend({
  kind: z.literal("run"),
  event: z.enum(["RunPauseAcknowledged", "RunDrainCompleted"]),
  commandRequestId: safeId,
});

const WorkItemRetryRequested = Common.extend({
  kind: z.literal("run"),
  event: z.literal("WorkItemRetryRequested"),
  requestedBy: boundedText(160),
  requestId: safeId,
  workItem: z.number().int().positive(),
  reason: boundedText(8_000).optional(),
});

const WorkItemPriorityChanged = Common.extend({
  kind: z.literal("run"),
  event: z.literal("WorkItemPriorityChanged"),
  requestedBy: boundedText(160),
  requestId: safeId,
  workItem: z.number().int().positive(),
  priorityRank: z.number().int().min(0).max(1_000),
  prioritySource: z.literal("operator-command"),
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
  environmentIdentity: boundedText(500).optional(),
  artifactDigest: sha256Digest.optional(),
  headSha: gitSha.optional(),
  sessionId: boundedText(500).optional(),
  modelProfile: boundedText(160).optional(),
  reportedModelTokens: z.number().int().nonnegative().optional(),
  reportedModelUsage: ReportedModelUsageSchema.optional(),
  admissionClass: z.enum(["local", "remote-required", "burst"]).optional(),
  admissionReason: z
    .enum(["local-capacity", "capability-required", "local-saturated", "queue-delay", "deadline"])
    .optional(),
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
  estimatedCloudTimeSavedMinutes: z.number().nonnegative().finite().optional(),
  minimumCloudTimeSavedMinutes: z.number().nonnegative().finite().optional(),
  reason: boundedText(8_000).optional(),
}).superRefine((event, context) => {
  const usage = event.reportedModelUsage;
  if (
    usage?.inputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.inputTokens + usage.outputTokens !== event.reportedModelTokens
  )
    context.addIssue({
      code: "custom",
      path: ["reportedModelTokens"],
      message: "reported model total must equal input plus output tokens",
    });
});

const Scheduling = Common.extend({
  kind: z.literal("scheduling"),
  event: z.literal("WorkItemQueued"),
  workItem: z.number().int().positive(),
  directorEpoch: z.number().int().positive(),
  policyDigest: sha256Digest,
  reason: boundedText(2_000),
  reasonCode: z
    .enum([
      "lease-unavailable",
      "policy-constraint",
      "backend-incompatible",
      "backend-unavailable",
      "backend-at-capacity",
      "global-capacity",
      "local-capacity",
      "local-pressure",
      "local-cooldown",
      "resource-sample-unavailable",
      "budget-exhausted",
      "burst-disabled",
      "burst-trigger-pending",
      "burst-time-saved",
      "burst-priority",
      "path-conflict",
      "exclusive-resource-conflict",
    ])
    .optional(),
  gate: z
    .enum([
      "authority",
      "capacity",
      "priority",
      "scope",
      "trust",
      "backend",
      "validation",
      "economic",
    ])
    .optional(),
  observedPriorityRank: z.number().int().min(0).max(1_000),
  observedSubIssuePosition: z.number().int().nonnegative(),
  prioritySource: z
    .enum(["subissue-order", "issue-field", "subissue-order-fallback", "operator-command"])
    .optional(),
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
  recoveryEpoch: z.number().int().positive().optional(),
  policyDigest: sha256Digest,
  reason: boundedText(2_000).optional(),
});

const Delivery = Common.extend({
  kind: z.literal("delivery"),
  event: z.literal("DeliverySelected"),
  requested: z.enum(["regular-prs", "stacked-prs"]),
  selected: z.enum(["regular-prs", "native-stacks", "escalate"]),
  capabilityVersion: boundedText(80),
  reason: boundedText(2_000),
});

const Publication = Common.extend({
  kind: z.literal("publication"),
  event: z.enum([
    "PublicationRecorded",
    "StackLinked",
    "ValidationInvalidated",
    "IntegrationPending",
    "IntegrationFailed",
    "IntegrationCompleted",
    "IntegrationCancelled",
    "IntegrationRolledBack",
  ]),
  workItem: z.number().int().positive(),
  attempt: z.number().int().positive(),
  unitId: boundedText(200),
  itemId: safeId,
  mode: z.enum(["regular-prs", "native-stacks"]),
  position: z.number().int().nonnegative(),
  parentItemId: safeId.optional(),
  branch: boundedText(500),
  baseBranch: boundedText(500),
  baseSha: gitSha,
  headSha: gitSha,
  pullRequest: z.number().int().positive(),
  capabilityVersion: boundedText(80),
  validationDigest: sha256Digest,
  exactHeadValidationDigest: sha256Digest,
  stackNumber: z.number().int().positive().optional(),
  operationId: safeId.optional(),
  asynchronousMergeUuid: boundedText(200).optional(),
  invalidatedByItem: safeId.optional(),
  invalidatedByHeadSha: gitSha.optional(),
  reason: boundedText(2_000).optional(),
}).superRefine((event, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (event.position === 0 && event.parentItemId) {
    issue("bottom publication event cannot name a parent");
  }
  if (event.position > 0 && !event.parentItemId) {
    issue("higher publication event must name its parent");
  }
  if (event.event === "StackLinked" && (event.mode !== "native-stacks" || !event.stackNumber)) {
    issue("native StackLinked event requires a stack number");
  }
  if (
    event.event === "ValidationInvalidated" &&
    (!event.invalidatedByItem || !event.invalidatedByHeadSha)
  ) {
    issue("ValidationInvalidated event requires its head-change cause");
  }
  if (event.event.startsWith("Integration") && !event.operationId) {
    issue("integration event requires an operation ID");
  }
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

const GraphCompiled = Common.extend({
  kind: z.literal("graph"),
  event: z.literal("GraphCompiled"),
  graphDigest: sha256Digest,
  graphSize: z.number().int().positive().max(100),
  baseSha: gitSha,
  graphRef: boundedText(500),
  graphBlobSha: gitSha,
});

const GraphProjected = Common.extend({
  kind: z.literal("graph"),
  event: z.literal("GraphProjected"),
  graphDigest: sha256Digest,
  graphSize: z.number().int().positive().max(100),
  projectionRef: boundedText(500),
  projectionBlobSha: gitSha,
});

const Budget = Common.extend({
  kind: z.literal("budget"),
  event: z.enum(["BudgetReserved", "BudgetReconciled"]),
  workItem: z.number().int().positive().optional(),
  attempt: z.number().int().positive().optional(),
  phase: z.enum(["management", "execution", "validation"]),
  /** Deterministic invocation identity; repeated receipts replace, distinct calls add. */
  usageId: boundedText(300).optional(),
  unit: z.enum([
    "model_tokens",
    "local_milliseconds",
    "sandbox_milliseconds",
    "managed_sessions",
    "validation_milliseconds",
  ]),
  amount: z.number().nonnegative().finite(),
  reportedModelUsage: ReportedModelUsageSchema.optional(),
}).superRefine((event, context) => {
  const usage = event.reportedModelUsage;
  if (!usage) return;
  if (event.event !== "BudgetReconciled" || event.unit !== "model_tokens")
    context.addIssue({
      code: "custom",
      path: ["reportedModelUsage"],
      message: "model usage breakdown belongs only to reconciled model-token budgets",
    });
  if (
    usage.inputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.inputTokens + usage.outputTokens !== event.amount
  )
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "model-token budget amount must equal input plus output tokens",
    });
});

export const FactoryEventSchema = z.union([
  RunStarted,
  RunTerminal,
  RunCancellationRequested,
  ActivationRequested,
  ActivationRejected,
  RecoveryRequested,
  RecoveryConsumed,
  RunControlRequested,
  RunControlAcknowledged,
  WorkItemRetryRequested,
  WorkItemPriorityChanged,
  ControllerObserved,
  Lease,
  Attempt,
  Scheduling,
  Capacity,
  Delivery,
  Publication,
  Validation,
  GraphCompiled,
  GraphProjected,
  Budget,
]);

export type FactoryEvent = z.infer<typeof FactoryEventSchema>;
export type AttemptEvent = z.infer<typeof Attempt>;
export type LeaseEvent = z.infer<typeof Lease>;
export type DeliveryEvent = z.infer<typeof Delivery>;
export type PublicationEvent = z.infer<typeof Publication>;

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
