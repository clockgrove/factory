import type { BudgetRemaining, BackendCandidate } from "../execution/registry.js";
import {
  normalizeSchedulingPolicy,
  requirementsPolicyRejections,
  type RunPolicy,
} from "../protocol/policy.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import {
  CapacityLedger,
  capacityReservationKey,
  type CapacityLimits,
  type CapacityRejectionCode,
  type CapacityReservation,
  type CapacitySnapshot,
} from "./capacity-ledger.js";
import type { RankedWorkItem } from "./priority.js";
import {
  resourcePressureReasons,
  type ResourceSnapshot,
} from "./resource-sampler.js";

export type AdmissionReasonCode =
  | "local-capacity"
  | "capability-required"
  | "local-saturated"
  | "queue-delay"
  | "deadline";

export type QueuedReasonCode =
  | "lease-unavailable"
  | "policy-constraint"
  | "backend-incompatible"
  | "backend-unavailable"
  | "backend-at-capacity"
  | "global-capacity"
  | "local-capacity"
  | "local-pressure"
  | "local-cooldown"
  | "resource-sample-unavailable"
  | "budget-exhausted"
  | "burst-disabled"
  | "burst-trigger-pending"
  | "burst-priority"
  | "path-conflict"
  | "exclusive-resource-conflict";

export interface AdmissionWorkItem {
  priority: RankedWorkItem;
  requirements: ExecutionRequirements;
  backends: readonly BackendCandidate[];
  /** Pre-probed independent validators in immutable backend order. */
  validators?: readonly BackendCandidate[];
  nextAttempt: number;
  estimatedDurationMs: number;
  paths: readonly string[];
  exclusiveResources: readonly string[];
  queuedSince?: string;
}

export interface AdmissionProposal {
  workItem: number;
  backendId: string;
  admissionClass: "local" | "remote-required" | "burst";
  admissionReason: AdmissionReasonCode;
  requirements: { cpu: number; memoryMb: number };
  priority: {
    rank: number;
    fieldId?: string;
    optionId?: string;
    subIssuePosition: number;
    criticalPathLength: number;
    unfinishedDownstream: number;
  };
  capacity?: {
    measuredAt: string;
    effectiveCpu: number;
    availableMemoryMb: number;
    loadRatio: number;
    memoryUsageRatio: number;
  };
  capacityGeneration: number;
  reservation: CapacityReservation;
  reservedBudget: { unit: "sandbox_milliseconds" | "managed_sessions" | "none"; amount: number };
  validation?: {
    backendId: string;
    reservedBudget: {
      unit: "sandbox_milliseconds" | "managed_sessions" | "none";
      amount: number;
    };
  };
}

export interface QueuedDecision {
  workItem: number;
  code: QueuedReasonCode;
  reason: string;
  observedPriorityRank: number;
  observedSubIssuePosition: number;
  queuedSince?: string;
  recordQueueStart: boolean;
  permanent: boolean;
}

export interface AdmissionPlan {
  admissions: AdmissionProposal[];
  queued: QueuedDecision[];
}

export interface AdmissionInput {
  objective: number;
  policy: RunPolicy;
  workItems: readonly AdmissionWorkItem[];
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

export function admissionCapacityLimits(
  policy: RunPolicy,
  resource: ResourceSnapshot | null,
  objective?: number,
  objectiveLocalMax?: number,
  repositoryLimits?: { maxLocalWorkers: number; maxPaidWorkers: number },
): CapacityLimits {
  const effective = normalizeSchedulingPolicy(policy);
  const repositoryLocal =
    repositoryLimits?.maxLocalWorkers ?? effective.capacity.local.maxWorkers;
  const repositoryCloud =
    repositoryLimits?.maxPaidWorkers ?? effective.burst.maxCloudParallel;
  const repositoryParallel = repositoryLocal + repositoryCloud;
  return {
    maxParallel: repositoryParallel,
    maxLocalParallel: repositoryLocal,
    maxCloudParallel: repositoryCloud,
    backendMaxParallel: Object.fromEntries(
      policy.backendOrder.map((id) => [id, repositoryParallel]),
    ),
    cpuCapacity:
      effective.capacity.mode === "adaptive-local" && resource
        ? Math.max(0, resource.effectiveCpu - effective.capacity.local.reserveCpu)
        : Number.MAX_SAFE_INTEGER,
    memoryCapacityMb:
      effective.capacity.mode === "adaptive-local" && resource
        ? Math.max(0, resource.totalMemoryMb - effective.capacity.local.reserveMemoryMb)
        : Number.MAX_SAFE_INTEGER,
    maxPaidUnits: Number.MAX_SAFE_INTEGER,
    ...(objective === undefined
      ? {}
      : {
          objectiveMaxParallel: { objective, max: policy.maxParallel },
          objectiveLocalMax: {
            objective,
            max: Math.min(
              objectiveLocalMax ?? effective.capacity.local.maxWorkers,
              effective.capacity.local.maxWorkers,
            ),
          },
          objectiveCloudMax: {
            objective,
            max: effective.burst.maxCloudParallel,
          },
          objectiveBackendMaxParallel: {
            objective,
            limits: effective.capacity.backendMaxParallel,
          },
        }),
  };
}

function queue(
  item: AdmissionWorkItem,
  code: QueuedReasonCode,
  reason: string,
  permanent = false,
): QueuedDecision {
  return {
    workItem: item.priority.item.number,
    code,
    reason,
    observedPriorityRank: item.priority.rank,
    observedSubIssuePosition: item.priority.subIssuePosition,
    ...(item.queuedSince ? { queuedSince: item.queuedSince } : {}),
    recordQueueStart: item.queuedSince === undefined,
    permanent,
  };
}

function capacityQueueCode(code: CapacityRejectionCode): QueuedReasonCode {
  switch (code) {
    case "global-capacity":
      return "global-capacity";
    case "local-capacity":
    case "cpu-capacity":
    case "memory-capacity":
      return "local-capacity";
    case "path-conflict":
      return "path-conflict";
    case "exclusive-resource-conflict":
      return "exclusive-resource-conflict";
    default:
      return "backend-at-capacity";
  }
}

function budgetFor(
  backend: BackendCandidate,
  durationMs: number,
): AdmissionProposal["reservedBudget"] {
  if (backend.costClass === "managed") {
    return { unit: "managed_sessions", amount: 1 };
  }
  if (backend.costClass === "sandbox") {
    return { unit: "sandbox_milliseconds", amount: durationMs };
  }
  return { unit: "none", amount: 0 };
}

function canReserveNativeBudget(
  budget: { sandboxMinutes: number; managedAgentSessions: number },
  reservations: readonly AdmissionProposal["reservedBudget"][],
): boolean {
  const sandboxMilliseconds = reservations
    .filter((reservation) => reservation.unit === "sandbox_milliseconds")
    .reduce((sum, reservation) => sum + reservation.amount, 0);
  const managedSessions = reservations
    .filter((reservation) => reservation.unit === "managed_sessions")
    .reduce((sum, reservation) => sum + reservation.amount, 0);
  return (
    budget.sandboxMinutes * 60_000 >= sandboxMilliseconds &&
    budget.managedAgentSessions >= managedSessions
  );
}

function reserveNativeBudget(
  budget: { sandboxMinutes: number; managedAgentSessions: number },
  reservations: readonly AdmissionProposal["reservedBudget"][],
): void {
  for (const reservation of reservations) {
    if (reservation.unit === "sandbox_milliseconds") {
      budget.sandboxMinutes -= reservation.amount / 60_000;
    } else if (reservation.unit === "managed_sessions") {
      budget.managedAgentSessions -= reservation.amount;
    }
  }
}

function burstReason(
  mode: ReturnType<typeof normalizeSchedulingPolicy>["burst"]["mode"],
  queuedLongEnough: boolean,
  deadlineReached: boolean,
): AdmissionReasonCode | null {
  if (mode === "saturation") return "local-saturated";
  if (mode === "queue-delay" && queuedLongEnough) return "queue-delay";
  if (mode === "deadline" && deadlineReached) return "deadline";
  if (mode === "queue-or-deadline") {
    if (queuedLongEnough) return "queue-delay";
    if (deadlineReached) return "deadline";
  }
  return null;
}

/** Pure, work-conserving, local-first admission planner. */
export function planAdmissions(input: AdmissionInput): AdmissionPlan {
  const effective = normalizeSchedulingPolicy(input.policy);
  const admissions: AdmissionProposal[] = [];
  const queued: QueuedDecision[] = [];
  const provisional = new CapacityLedger();
  const seedGeneration = Math.max(1, input.capacity.generation);
  provisional.reconcile(seedGeneration, input.capacity.reservations);
  const budget = {
    sandboxMinutes: input.budget.sandboxMinutes,
    managedAgentSessions: input.budget.managedAgentSessions,
  };
  const observedReservationMemoryMb = input.capacity.memoryMb;

  const resourceLimits = admissionCapacityLimits(
    input.policy,
    input.resource,
    input.objective,
    input.objectiveLocalMax,
    input.repositoryLimits,
  );

  for (const item of input.workItems) {
    const number = item.priority.item.number;
    const requested = {
      cpu: item.requirements.cpu ?? effective.capacity.local.defaultCpu,
      memoryMb:
        item.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
    };
    const policyReasons = requirementsPolicyRejections(item.requirements, input.policy);
    if (input.leaseValid === false) {
      queued.push(queue(item, "lease-unavailable", "Director lease is not current"));
      continue;
    }
    if (policyReasons.length > 0) {
      queued.push(queue(item, "policy-constraint", policyReasons.join("; "), true));
      continue;
    }

    const candidates = item.backends.filter((candidate) =>
      input.policy.backendOrder.includes(candidate.id),
    );
    const configuredLocal = candidates.filter(
      (candidate) => candidate.costClass === "local",
    );
    const locallyCompatible = candidates.filter(
      (candidate) => candidate.local && candidate.permanentReasons.length === 0,
    );
    const availableLocal = locallyCompatible.filter(
      (candidate) => candidate.transientReasons.length === 0,
    );
    const compatibleCloud = candidates.filter(
      (candidate) =>
        candidate.paid &&
        candidate.permanentReasons.length === 0 &&
        input.policy.allowedPaidBackends.includes(candidate.id),
    );
    const availableCloud = compatibleCloud.filter(
      (candidate) => candidate.transientReasons.length === 0,
    );

    let validation:
      | NonNullable<AdmissionProposal["validation"]>
      | undefined;
    if (item.requirements.trust !== "trusted_local") {
      const validators = item.validators ?? [];
      const compatibleValidators = validators.filter(
        (candidate) => candidate.permanentReasons.length === 0,
      );
      const availableValidators = compatibleValidators.filter(
        (candidate) => candidate.transientReasons.length === 0,
      );
      const candidate = availableValidators[0];
      if (!candidate) {
        const transient = compatibleValidators.flatMap(
          (value) => value.transientReasons,
        );
        const permanent = validators.flatMap((value) => value.permanentReasons);
        queued.push(
          queue(
            item,
            transient.length > 0 ? "backend-unavailable" : "backend-incompatible",
            [...transient, ...permanent].join("; ") ||
              "no independent isolated validator is available",
            transient.length === 0,
          ),
        );
        continue;
      }
      if (
        candidate.paid &&
        input.repositoryLimits?.maxPaidWorkers === 0
      ) {
        queued.push(
          queue(
            item,
            "backend-at-capacity",
            "repository controller allows no paid validation workers",
          ),
        );
        continue;
      }
      validation = {
        backendId: candidate.id,
        reservedBudget: budgetFor(candidate, item.estimatedDurationMs),
      };
      if (!canReserveNativeBudget(budget, [validation.reservedBudget])) {
        queued.push(
          queue(
            item,
            "budget-exhausted",
            `budget exhausted for independent validation on ${candidate.id}`,
          ),
        );
        continue;
      }
    }

    if (
      locallyCompatible.length === 0 &&
      configuredLocal.some((candidate) => !candidate.registered)
    ) {
      queued.push(
        queue(
          item,
          "backend-incompatible",
          configuredLocal
            .flatMap((candidate) => candidate.permanentReasons)
            .join("; ") || "configured local backend could not be evaluated",
          true,
        ),
      );
      continue;
    }

    let localBlock:
      | { code: QueuedReasonCode; reason: string }
      | undefined;
    if (locallyCompatible.length > 0) {
      if (availableLocal.length === 0) {
        localBlock = {
          code: "backend-unavailable",
          reason: locallyCompatible.flatMap((candidate) => candidate.transientReasons).join("; "),
        };
      } else if (effective.capacity.mode === "adaptive-local" && !input.resource) {
        localBlock = {
          code: "resource-sample-unavailable",
          reason: "no valid local resource sample is available",
        };
      } else if ((input.cooldownUntilMs ?? 0) > input.nowMs) {
        localBlock = {
          code: "local-cooldown",
          reason: `local admission cooldown lasts until ${new Date(input.cooldownUntilMs!).toISOString()}`,
        };
      } else if (effective.capacity.mode === "adaptive-local" && input.resource) {
        const pressure = resourcePressureReasons(input.resource, effective.capacity.local);
        if (pressure.length > 0) {
          localBlock = { code: "local-pressure", reason: pressure.join("; ") };
        }
      }
    }

    let localCapacityCode: CapacityRejectionCode | undefined;
    if (!localBlock && availableLocal.length > 0) {
      for (const candidate of availableLocal) {
        if (
          effective.capacity.mode === "adaptive-local" &&
          input.resource &&
          input.resource.availableMemoryMb -
              Math.max(
                0,
                provisional.snapshot().memoryMb - observedReservationMemoryMb,
              ) <
            requested.memoryMb + effective.capacity.local.minimumFreeMemoryMb
        ) {
          localCapacityCode = "memory-capacity";
          continue;
        }
        const reservation: CapacityReservation = {
          key: capacityReservationKey({
            objective: input.objective,
            workItem: number,
            attempt: item.nextAttempt,
            phase: "execution",
            backendId: candidate.id,
          }),
          objective: input.objective,
          workItem: number,
          attempt: item.nextAttempt,
          phase: "execution",
          backendId: candidate.id,
          admissionClass: "local",
          local: true,
          cpu: requested.cpu,
          memoryMb: requested.memoryMb,
          paidUnits: 0,
          paths: item.paths,
          exclusiveResources: item.exclusiveResources,
        };
        const result = provisional.tryReserve(
          provisional.snapshot().generation,
          reservation,
          resourceLimits,
        );
        if (!result.reserved) {
          localCapacityCode = result.code;
          continue;
        }
        admissions.push({
          workItem: number,
          backendId: candidate.id,
          admissionClass: "local",
          admissionReason: "local-capacity",
          requirements: requested,
          priority: {
            rank: item.priority.rank,
            ...(item.priority.fieldId ? { fieldId: item.priority.fieldId } : {}),
            ...(item.priority.optionId ? { optionId: item.priority.optionId } : {}),
            subIssuePosition: item.priority.subIssuePosition,
            criticalPathLength: item.priority.criticalPathLength,
            unfinishedDownstream: item.priority.unfinishedDownstream,
          },
          ...(input.resource
            ? {
                capacity: {
                  measuredAt: input.resource.measuredAt,
                  effectiveCpu: input.resource.effectiveCpu,
                  availableMemoryMb: input.resource.availableMemoryMb,
                  loadRatio: input.resource.loadRatio,
                  memoryUsageRatio: input.resource.memoryUsageRatio,
                },
              }
            : {}),
          capacityGeneration: input.capacity.generation,
          reservation,
          reservedBudget: budgetFor(candidate, item.estimatedDurationMs),
          ...(validation ? { validation } : {}),
        });
        if (validation) {
          reserveNativeBudget(budget, [validation.reservedBudget]);
        }
        localCapacityCode = undefined;
        break;
      }
      if (!localCapacityCode && admissions.at(-1)?.workItem === number) continue;
    }
    if (!localBlock && localCapacityCode) {
      localBlock = {
        code: capacityQueueCode(localCapacityCode),
        reason: `local candidate rejected by ${localCapacityCode}`,
      };
    }

    const remoteRequired = locallyCompatible.length === 0;
    if (
      !remoteRequired &&
      (localBlock?.code === "backend-unavailable" ||
        localBlock?.code === "resource-sample-unavailable")
    ) {
      queued.push(queue(item, localBlock.code, localBlock.reason));
      continue;
    }
    const cloudOrder = remoteRequired
      ? input.policy.backendOrder
      : effective.burst.backendOrder;
    const orderedCloud = cloudOrder.flatMap((id) => {
      const candidate = availableCloud.find((value) => value.id === id);
      return candidate ? [candidate] : [];
    });

    let admissionReason: AdmissionReasonCode | null = remoteRequired
      ? "capability-required"
      : null;
    if (!remoteRequired) {
      if (effective.burst.mode === "never") {
        queued.push(
          queue(
            item,
            localBlock?.code ?? "burst-disabled",
            `${localBlock?.reason ?? "local capacity is full"}; paid burst is disabled`,
          ),
        );
        continue;
      }
      if (item.priority.rank > effective.burst.maxPriorityRank) {
        queued.push(
          queue(
            item,
            "burst-priority",
            `priority rank ${item.priority.rank} exceeds burst threshold ${effective.burst.maxPriorityRank}`,
          ),
        );
        continue;
      }
      const queuedAt = item.queuedSince ? Date.parse(item.queuedSince) : input.nowMs;
      const queuedLongEnough =
        input.nowMs - queuedAt >= effective.burst.queueDelaySeconds * 1_000;
      const deadlineReached =
        input.objectiveDeadlineMs - input.nowMs <=
        effective.burst.deadlineReserveMinutes * 60_000;
      admissionReason = burstReason(
        effective.burst.mode,
        queuedLongEnough,
        deadlineReached,
      );
      if (!admissionReason) {
        queued.push(
          queue(item, "burst-trigger-pending", localBlock?.reason ?? "burst trigger is not met"),
        );
        continue;
      }
    }

    if (orderedCloud.length === 0) {
      const transient = compatibleCloud.flatMap((candidate) => candidate.transientReasons);
      const permanent = candidates.flatMap((candidate) => candidate.permanentReasons);
      queued.push(
        queue(
          item,
          transient.length > 0 ? "backend-unavailable" : "backend-incompatible",
          [...transient, ...permanent].join("; ") || "no authorized compatible backend",
          transient.length === 0,
        ),
      );
      continue;
    }

    let cloudFailure: QueuedDecision | undefined;
    for (const candidate of orderedCloud) {
      const reservedBudget = budgetFor(candidate, item.estimatedDurationMs);
      const nativeReservations = [
        reservedBudget,
        ...(validation ? [validation.reservedBudget] : []),
      ];
      if (!canReserveNativeBudget(budget, nativeReservations)) {
        cloudFailure = queue(item, "budget-exhausted", `budget exhausted for ${candidate.id}`);
        continue;
      }
      const reservation: CapacityReservation = {
        key: capacityReservationKey({
          objective: input.objective,
          workItem: number,
          attempt: item.nextAttempt,
          phase: "execution",
          backendId: candidate.id,
        }),
        objective: input.objective,
        workItem: number,
        attempt: item.nextAttempt,
        phase: "execution",
        backendId: candidate.id,
        admissionClass: remoteRequired ? "remote-required" : "burst",
        local: false,
        cpu: requested.cpu,
        memoryMb: requested.memoryMb,
        paidUnits: 1,
        paths: item.paths,
        exclusiveResources: item.exclusiveResources,
      };
      const result = provisional.tryReserve(
        provisional.snapshot().generation,
        reservation,
        resourceLimits,
      );
      if (!result.reserved) {
        cloudFailure = queue(
          item,
          capacityQueueCode(result.code),
          `cloud candidate rejected by ${result.code}`,
        );
        continue;
      }
      reserveNativeBudget(budget, nativeReservations);
      admissions.push({
        workItem: number,
        backendId: candidate.id,
        admissionClass: remoteRequired ? "remote-required" : "burst",
        admissionReason: admissionReason!,
        requirements: requested,
        priority: {
          rank: item.priority.rank,
          ...(item.priority.fieldId ? { fieldId: item.priority.fieldId } : {}),
          ...(item.priority.optionId ? { optionId: item.priority.optionId } : {}),
          subIssuePosition: item.priority.subIssuePosition,
          criticalPathLength: item.priority.criticalPathLength,
          unfinishedDownstream: item.priority.unfinishedDownstream,
        },
        ...(input.resource
          ? {
              capacity: {
                measuredAt: input.resource.measuredAt,
                effectiveCpu: input.resource.effectiveCpu,
                availableMemoryMb: input.resource.availableMemoryMb,
                loadRatio: input.resource.loadRatio,
                memoryUsageRatio: input.resource.memoryUsageRatio,
              },
            }
          : {}),
        capacityGeneration: input.capacity.generation,
        reservation,
        reservedBudget,
        ...(validation ? { validation } : {}),
      });
      cloudFailure = undefined;
      break;
    }
    if (cloudFailure) queued.push(cloudFailure);
  }
  return { admissions, queued };
}
