import { createHash } from "node:crypto";

import type { BackendCandidate, BudgetRemaining } from "../execution/registry.js";
import { parseRunPolicy, policyDigest, type RunPolicy } from "../protocol/policy.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import { ExecutionRequirementsSchema } from "../protocol/worker-packet.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import {
  planAdmissions,
  type AdmissionInput,
  type AdmissionPlan,
} from "../scheduling/admission.js";
import type { CapacitySnapshot } from "../scheduling/capacity-ledger.js";
import type { ObservedPrioritySource } from "../scheduling/priority.js";
import type { ResourceSnapshot } from "../scheduling/resource-sampler.js";

export const REPLAY_PROTOCOL = "clockgrove.factory/replay-v1" as const;

/** Provider-neutral backend evidence. It deliberately excludes clients and raw probes. */
export interface PinnedBackendCandidate {
  id: string;
  registered: boolean;
  costClass: "local" | "sandbox" | "managed";
  local: boolean;
  paid: boolean;
  /** Whether terminal observations carry model-token counters used by admission. */
  reportsModelUsage: boolean;
  /** Stable, sanitized reasons only; never embed a raw provider response. */
  permanentReasons: readonly string[];
  /** Stable, sanitized reasons only; never embed a raw provider response. */
  transientReasons: readonly string[];
}

export interface PinnedAdmissionWorkItem {
  number: number;
  priority: {
    rank: number;
    source: ObservedPrioritySource;
    fieldId?: string;
    optionId?: string;
    subIssuePosition: number;
    criticalPathLength: number;
    unfinishedDownstream: number;
    fallbackReason?: string;
  };
  requirements: ExecutionRequirements;
  backends: readonly PinnedBackendCandidate[];
  validators?: readonly PinnedBackendCandidate[];
  nextAttempt: number;
  estimatedDurationMs: number;
  /** Deterministic burst-economics estimate, when the compiler supplied one. */
  estimatedCloudTimeSavedMs?: number;
  paths: readonly string[];
  exclusiveResources: readonly string[];
  queuedSince?: string;
}

/** Every non-wall-clock input consumed by the admission planner. */
export interface PinnedAdmissionInput {
  objective: number;
  policy: RunPolicy;
  workItems: readonly PinnedAdmissionWorkItem[];
  capacity: CapacitySnapshot;
  budget: BudgetRemaining;
  resource: ResourceSnapshot | null;
  nowMs: number;
  objectiveDeadlineMs: number;
  cooldownUntilMs?: number;
  leaseValid?: boolean;
  objectiveLocalMax?: number;
  repositoryLimits?: { maxLocalWorkers: number; maxPaidWorkers: number };
}

export interface ReplayDecisionSet {
  admissions: AdmissionPlan["admissions"];
  queued: AdmissionPlan["queued"];
}

export interface PinnedAdmissionSnapshot {
  protocol: typeof REPLAY_PROTOCOL;
  capturedAt: string;
  policyDigest: string;
  input: PinnedAdmissionInput;
  expected: ReplayDecisionSet;
  snapshotDigest: string;
}

export interface ReplayMismatch {
  decision: "admission" | "queued";
  workItem: number;
  expected: unknown;
  actual: unknown;
}

export interface AdmissionReplayResult {
  protocol: typeof REPLAY_PROTOCOL;
  snapshotDigest: string;
  reproduced: boolean;
  decisions: ReplayDecisionSet;
  mismatches: ReplayMismatch[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function finite(value: number, name: string, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be finite and at least ${minimum}`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function pinnedCandidate(candidate: PinnedBackendCandidate): PinnedBackendCandidate {
  if (!/^[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+$/.test(candidate.id)) {
    throw new Error(`invalid pinned backend id ${candidate.id}`);
  }
  const reasonCode = /^[a-z0-9][a-z0-9._-]{0,159}$/;
  for (const reason of [...candidate.permanentReasons, ...candidate.transientReasons]) {
    if (!reasonCode.test(reason)) {
      throw new Error(`pinned backend ${candidate.id} reasons must be stable sanitized codes`);
    }
  }
  return {
    id: candidate.id,
    registered: candidate.registered,
    costClass: candidate.costClass,
    local: candidate.local,
    paid: candidate.paid,
    reportsModelUsage: candidate.reportsModelUsage,
    permanentReasons: [...candidate.permanentReasons],
    transientReasons: [...candidate.transientReasons],
  };
}

function pinnedPolicy(value: RunPolicy): RunPolicy {
  const policy = parseRunPolicy(value);
  return parseRunPolicy({
    backendOrder: [...policy.backendOrder],
    maxParallel: policy.maxParallel,
    workItemTimeoutMinutes: policy.workItemTimeoutMinutes,
    objectiveTimeoutMinutes: policy.objectiveTimeoutMinutes,
    maxAttemptsPerItem: policy.maxAttemptsPerItem,
    allowedPaidBackends: [...policy.allowedPaidBackends],
    cloudFallback: policy.cloudFallback,
    maxSandboxMinutes: policy.maxSandboxMinutes,
    maxManagedAgentSessions: policy.maxManagedAgentSessions,
    trust: policy.trust,
    managementBackend: policy.managementBackend,
    ...(policy.modelProfile ? { modelProfile: policy.modelProfile } : {}),
    allowedNetworkDestinations: [...policy.allowedNetworkDestinations],
    ...(policy.priority ? { priority: structuredClone(policy.priority) } : {}),
    ...(policy.capacity ? { capacity: structuredClone(policy.capacity) } : {}),
    ...(policy.burst ? { burst: structuredClone(policy.burst) } : {}),
    ...(policy.delivery ? { delivery: structuredClone(policy.delivery) } : {}),
    ...(policy.models ? { models: structuredClone(policy.models) } : {}),
    ...(policy.economics ? { economics: structuredClone(policy.economics) } : {}),
  });
}

function pinnedRequirements(value: ExecutionRequirements): ExecutionRequirements {
  const requirements = ExecutionRequirementsSchema.parse(value);
  return {
    os: [...requirements.os],
    architecture: [...requirements.architecture],
    ...(requirements.cpu === undefined ? {} : { cpu: requirements.cpu }),
    ...(requirements.memoryMb === undefined ? {} : { memoryMb: requirements.memoryMb }),
    ...(requirements.diskMb === undefined ? {} : { diskMb: requirements.diskMb }),
    ...(requirements.timeoutMinutes === undefined
      ? {}
      : { timeoutMinutes: requirements.timeoutMinutes }),
    ...(requirements.estimatedDurationMinutes === undefined
      ? {}
      : { estimatedDurationMinutes: requirements.estimatedDurationMinutes }),
    tools: [...requirements.tools],
    services: [...requirements.services],
    networkDestinations: [...requirements.networkDestinations],
    permittedSecretNames: [...requirements.permittedSecretNames],
    trust: requirements.trust,
  };
}

function pinnedCapacity(value: CapacitySnapshot): CapacitySnapshot {
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw new Error("capacity generation must be a positive safe integer");
  }
  const reservations = value.reservations.map((reservation) => ({
    key: reservation.key,
    objective: positiveInteger(reservation.objective, "reservation objective"),
    workItem: positiveInteger(reservation.workItem, "reservation Work Item"),
    attempt: positiveInteger(reservation.attempt, "reservation attempt"),
    phase: reservation.phase,
    backendId: reservation.backendId,
    admissionClass: reservation.admissionClass,
    local: reservation.local,
    cpu: finite(reservation.cpu, "reservation CPU"),
    memoryMb: finite(reservation.memoryMb, "reservation memory"),
    paidUnits: finite(reservation.paidUnits, "reservation paid units"),
    paths: [...reservation.paths],
    exclusiveResources: [...reservation.exclusiveResources],
  }));
  const byBackend = Object.fromEntries(
    Object.entries(value.byBackend).map(([id, amount]) => [
      id,
      finite(amount, `capacity count for ${id}`),
    ]),
  );
  return {
    generation: value.generation,
    reservations,
    active: finite(value.active, "active capacity"),
    local: finite(value.local, "local capacity"),
    cloud: finite(value.cloud, "cloud capacity"),
    cpu: finite(value.cpu, "capacity CPU"),
    memoryMb: finite(value.memoryMb, "capacity memory"),
    paidUnits: finite(value.paidUnits, "capacity paid units"),
    byBackend,
  };
}

function pinnedResource(value: ResourceSnapshot | null): ResourceSnapshot | null {
  if (!value) return null;
  if (!Number.isFinite(Date.parse(value.measuredAt))) {
    throw new Error("resource measuredAt is not an ISO timestamp");
  }
  return {
    measuredAt: value.measuredAt,
    logicalCpu: finite(value.logicalCpu, "logical CPU", 1),
    effectiveCpu: finite(value.effectiveCpu, "effective CPU", 1),
    loadRatio: finite(value.loadRatio, "load ratio"),
    totalMemoryMb: finite(value.totalMemoryMb, "total memory", 1),
    availableMemoryMb: finite(value.availableMemoryMb, "available memory"),
    memoryUsageRatio: finite(value.memoryUsageRatio, "memory usage ratio"),
    source: value.source,
  };
}

/**
 * Normalize a replay input into a JSON-only, provider-neutral snapshot. Unknown
 * object properties are dropped here so a caller cannot accidentally publish a
 * backend client, credential, machine identifier, or raw probe payload.
 */
export function normalizePinnedAdmissionInput(value: PinnedAdmissionInput): PinnedAdmissionInput {
  const policy = pinnedPolicy(value.policy);
  positiveInteger(value.objective, "objective");
  finite(value.nowMs, "nowMs");
  finite(value.objectiveDeadlineMs, "objectiveDeadlineMs");
  if (value.cooldownUntilMs !== undefined) {
    finite(value.cooldownUntilMs, "cooldownUntilMs");
  }
  const workItems = value.workItems.map((item) => {
    positiveInteger(item.number, "work item number");
    positiveInteger(item.nextAttempt, `Work Item #${item.number} nextAttempt`);
    finite(item.estimatedDurationMs, "estimatedDurationMs", 1);
    if (item.estimatedCloudTimeSavedMs !== undefined) {
      finite(item.estimatedCloudTimeSavedMs, "estimatedCloudTimeSavedMs");
    }
    finite(item.priority.rank, "priority rank");
    finite(item.priority.subIssuePosition, "sub-issue position");
    finite(item.priority.criticalPathLength, "critical-path length");
    finite(item.priority.unfinishedDownstream, "unfinished downstream count");
    if (item.queuedSince !== undefined && !Number.isFinite(Date.parse(item.queuedSince))) {
      throw new Error(`Work Item #${item.number} queuedSince is not an ISO timestamp`);
    }
    return {
      number: item.number,
      priority: {
        rank: item.priority.rank,
        source: item.priority.source,
        ...(item.priority.fieldId ? { fieldId: item.priority.fieldId } : {}),
        ...(item.priority.optionId ? { optionId: item.priority.optionId } : {}),
        subIssuePosition: item.priority.subIssuePosition,
        criticalPathLength: item.priority.criticalPathLength,
        unfinishedDownstream: item.priority.unfinishedDownstream,
      },
      requirements: pinnedRequirements(item.requirements),
      backends: item.backends.map(pinnedCandidate),
      ...(item.validators ? { validators: item.validators.map(pinnedCandidate) } : {}),
      nextAttempt: item.nextAttempt,
      estimatedDurationMs: item.estimatedDurationMs,
      ...(item.estimatedCloudTimeSavedMs === undefined
        ? {}
        : { estimatedCloudTimeSavedMs: item.estimatedCloudTimeSavedMs }),
      paths: [...item.paths],
      exclusiveResources: [...item.exclusiveResources],
      ...(item.queuedSince ? { queuedSince: item.queuedSince } : {}),
    };
  });
  if (new Set(workItems.map((item) => item.number)).size !== workItems.length) {
    throw new Error("pinned replay Work Item numbers must be unique");
  }
  return {
    objective: value.objective,
    policy: structuredClone(policy),
    workItems,
    capacity: pinnedCapacity(value.capacity),
    budget: {
      sandboxMinutes: finite(value.budget.sandboxMinutes, "sandbox budget"),
      managedAgentSessions: finite(value.budget.managedAgentSessions, "managed-session budget"),
      ...(value.budget.modelTokens === undefined
        ? {}
        : {
            modelTokens:
              value.budget.modelTokens === null
                ? null
                : finite(value.budget.modelTokens, "model-token budget"),
          }),
    },
    resource: pinnedResource(value.resource),
    nowMs: value.nowMs,
    objectiveDeadlineMs: value.objectiveDeadlineMs,
    ...(value.cooldownUntilMs === undefined ? {} : { cooldownUntilMs: value.cooldownUntilMs }),
    ...(value.leaseValid === undefined ? {} : { leaseValid: value.leaseValid }),
    ...(value.objectiveLocalMax === undefined
      ? {}
      : {
          objectiveLocalMax: positiveInteger(value.objectiveLocalMax, "objectiveLocalMax"),
        }),
    ...(value.repositoryLimits
      ? {
          repositoryLimits: {
            maxLocalWorkers: positiveInteger(
              value.repositoryLimits.maxLocalWorkers,
              "repository maxLocalWorkers",
            ),
            maxPaidWorkers: finite(
              value.repositoryLimits.maxPaidWorkers,
              "repository maxPaidWorkers",
            ),
          },
        }
      : {}),
  };
}

function hydrate(input: PinnedAdmissionInput): AdmissionInput {
  const candidate = (value: PinnedBackendCandidate): BackendCandidate => ({
    ...value,
    permanentReasons: [...value.permanentReasons],
    transientReasons: [...value.transientReasons],
    backend: null,
    capabilities: {
      reportsModelUsage: value.reportsModelUsage,
    } as NonNullable<BackendCandidate["capabilities"]>,
    probe: null,
  });
  return {
    ...input,
    workItems: input.workItems.map((item) => ({
      priority: {
        ...item.priority,
        item: { number: item.number } as AdmissionInput["workItems"][number]["priority"]["item"],
      },
      requirements: structuredClone(item.requirements),
      backends: item.backends.map(candidate),
      ...(item.validators ? { validators: item.validators.map(candidate) } : {}),
      nextAttempt: item.nextAttempt,
      estimatedDurationMs: item.estimatedDurationMs,
      ...(item.estimatedCloudTimeSavedMs === undefined
        ? {}
        : { estimatedCloudTimeSavedMs: item.estimatedCloudTimeSavedMs }),
      paths: [...item.paths],
      exclusiveResources: [...item.exclusiveResources],
      ...(item.queuedSince ? { queuedSince: item.queuedSince } : {}),
    })),
  };
}

function decisions(input: PinnedAdmissionInput): ReplayDecisionSet {
  const result = planAdmissions(hydrate(input));
  return structuredClone({ admissions: result.admissions, queued: result.queued });
}

function snapshotPayload(snapshot: Omit<PinnedAdmissionSnapshot, "snapshotDigest">): unknown {
  return {
    protocol: snapshot.protocol,
    capturedAt: snapshot.capturedAt,
    policyDigest: snapshot.policyDigest,
    input: snapshot.input,
    expected: snapshot.expected,
  };
}

/** Capture the planner input and its complete decision set at one deterministic boundary. */
export function pinAdmissionSnapshot(
  input: PinnedAdmissionInput,
  capturedAt = new Date(input.nowMs).toISOString(),
  expected?: ReplayDecisionSet,
): PinnedAdmissionSnapshot {
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("capturedAt must be an ISO timestamp");
  }
  const normalized = normalizePinnedAdmissionInput(input);
  const value = {
    protocol: REPLAY_PROTOCOL,
    capturedAt,
    policyDigest: policyDigest(normalized.policy),
    input: normalized,
    expected: structuredClone(expected ?? decisions(normalized)),
  };
  assertNoSecretMaterial(value, "pinned admission snapshot");
  return { ...value, snapshotDigest: digest(snapshotPayload(value)) };
}

function mismatchByWorkItem(
  kind: ReplayMismatch["decision"],
  expected: readonly { workItem: number }[],
  actual: readonly { workItem: number }[],
): ReplayMismatch[] {
  const expectedByItem = new Map(expected.map((value) => [value.workItem, value]));
  const actualByItem = new Map(actual.map((value) => [value.workItem, value]));
  return [...new Set([...expectedByItem.keys(), ...actualByItem.keys()])]
    .sort((left, right) => left - right)
    .flatMap((workItem) => {
      const expectedValue = expectedByItem.get(workItem);
      const actualValue = actualByItem.get(workItem);
      return canonical(expectedValue) === canonical(actualValue)
        ? []
        : [{ decision: kind, workItem, expected: expectedValue, actual: actualValue }];
    });
}

/** Pure replay: the same pinned snapshot always produces the same report. */
export function replayAdmissions(snapshot: PinnedAdmissionSnapshot): AdmissionReplayResult {
  if (snapshot.protocol !== REPLAY_PROTOCOL) {
    throw new Error(`unsupported replay protocol ${String(snapshot.protocol)}`);
  }
  assertNoSecretMaterial(snapshot, "pinned admission snapshot");
  const normalized = normalizePinnedAdmissionInput(snapshot.input);
  if (policyDigest(normalized.policy) !== snapshot.policyDigest) {
    throw new Error("pinned replay policy digest mismatch");
  }
  if (digest(snapshotPayload({ ...snapshot, input: normalized })) !== snapshot.snapshotDigest) {
    throw new Error("pinned replay snapshot digest mismatch");
  }
  const actual = decisions(normalized);
  const mismatches = [
    ...mismatchByWorkItem("admission", snapshot.expected.admissions, actual.admissions),
    ...mismatchByWorkItem("queued", snapshot.expected.queued, actual.queued),
  ];
  return {
    protocol: REPLAY_PROTOCOL,
    snapshotDigest: snapshot.snapshotDigest,
    reproduced: mismatches.length === 0,
    decisions: actual,
    mismatches,
  };
}
