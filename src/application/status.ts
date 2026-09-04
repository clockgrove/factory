import type { FactoryEvent } from "../protocol/events.js";
import {
  normalizeSchedulingPolicy,
  type RunPolicy,
} from "../protocol/policy.js";
import { parseWorkerPacketFromIssue } from "../graph.js";
import type {
  LinkedPullRequest,
  WorkItemSnapshot,
} from "../types.js";
import {
  deriveState,
  queuedSince,
  type DerivedWorkItem,
} from "../state.js";
import {
  deduplicateFactoryEvents,
  latestRunReceipts,
} from "../control/receipts.js";
import { summarizeRun, type RunSummary } from "../economics/index.js";
import {
  deriveCapacityReservations,
  type CapacityReservation,
} from "../scheduling/capacity-ledger.js";
import {
  rankReadyWorkItems,
  type ObservedPrioritySource,
} from "../scheduling/priority.js";
import { queuedReasonCode } from "../explanations/index.js";

export interface ReadWorkItemSnapshot {
  id?: string;
  number: number;
  title?: string;
  body?: string;
  closed?: boolean;
  assignees?: string[];
  labels?: string[];
  subIssuePosition?: number;
  issueFieldValues?: WorkItemSnapshot["issueFieldValues"];
  blockedBy?: WorkItemSnapshot["blockedBy"];
  linkedPullRequests?: LinkedPullRequest[];
  copilotAssignments?: Date[];
  factoryEvents?: FactoryEvent[];
}

/** Structural subset shared by GitHubReader and lightweight application tests. */
export interface FactoryReadSnapshot {
  id: string;
  number: number;
  title: string;
  authorLogin?: string;
  authorAssociation?: string;
  body?: string;
  closed?: boolean;
  readAt?: Date;
  repositoryId?: string;
  defaultBranch: string;
  workItemLabelId?: string | null;
  copilotBotId?: string | null;
  ciExpectedOnPullRequests?: boolean | "unknown";
  graphQlRateLimit?: {
    cost: number;
    limit: number;
    remaining: number;
    resetAt: Date;
  };
  factoryEvents?: FactoryEvent[];
  workItems: ReadWorkItemSnapshot[];
}

export interface StatusWorkItem {
  number: number;
  title: string;
  state: string;
  openDependencies: number[];
  queuedSince?: string;
  queueReasonCode?: string;
  priority?: {
    rank: number;
    source: ObservedPrioritySource;
    sourceEvidence:
      | "current-snapshot"
      | "admission-receipt"
      | "queue-receipt"
      | "run-policy";
    subIssuePosition: number;
  };
  activeReservation?: {
    attempt: number;
    phase: "execution" | "validation";
    backendId: string;
    admissionClass: "local" | "remote-required" | "burst";
    cpu: number;
    memoryMb: number;
  };
  latestAdmission?: {
    attempt: number;
    backendId: string;
    admissionClass: "local" | "remote-required" | "burst";
    reason: string;
  };
}

export interface FactoryStatusReport {
  operation: "status";
  repository: string;
  objective: {
    number: number;
    title: string;
    closed: boolean;
    observedAt: string;
  };
  run:
    | { availability: "unavailable"; state: "not-started" }
    | {
        availability: "observed";
        runId: string;
        state: "active" | "completed" | "cancelled" | "escalated";
        policyDigest: string;
        startedAt: string;
        finishedAt?: string;
      };
  readyOrder: Array<{
    position: number;
    workItem: number;
    rank: number;
    source: ObservedPrioritySource;
    subIssuePosition: number;
    criticalPathLength: number;
    unfinishedDownstream: number;
  }>;
  readyOrderAvailability:
    | { availability: "observed" }
    | { availability: "unavailable"; reason: string };
  capacity: {
    configured:
      | { availability: "unavailable"; reason: string }
      | {
          availability: "observed";
          maxParallel: number;
          localMaxWorkers: number;
          cloudMaxWorkers: number;
          backendMaxParallel: Record<string, number>;
        };
    observed: {
      active: number;
      local: number;
      cloud: number;
      cpuReserved: number;
      memoryMbReserved: number;
      latestHostSample:
        | { availability: "unavailable"; reason: string }
        | {
            availability: "observed";
            measuredAt: string;
            effectiveCpu: number;
            availableMemoryMb: number;
            loadRatio: number;
            memoryUsageRatio: number;
          };
    };
    activeReservations: Array<{
      workItem: number;
      attempt: number;
      phase: "execution" | "validation";
      backendId: string;
      admissionClass: "local" | "remote-required" | "burst";
      local: boolean;
      cpu: number;
      memoryMb: number;
    }>;
  };
  burst: {
    configured:
      | { availability: "unavailable"; reason: string }
      | {
          availability: "observed";
          mode: string;
          maxCloudParallel: number;
          maxPriorityRank: number;
          queueDelaySeconds: number;
          deadlineReserveMinutes: number;
        };
    admitted: Array<{
      workItem: number;
      attempt: number;
      trigger: string;
      backendId: string;
    }>;
  };
  controller: {
    latestObservation:
      | { availability: "unavailable"; reason: string }
      | {
          availability: "observed";
          observedAt: string;
          epoch: number;
          expiresAt: string;
          protocolMin: string;
          protocolMax: string;
        };
  };
  workItems: StatusWorkItem[];
  summary: RunSummary | null;
}

export function snapshotEvents(snapshot: FactoryReadSnapshot): FactoryEvent[] {
  return deduplicateFactoryEvents([
    ...(snapshot.factoryEvents ?? []),
    ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ]).sort((left, right) => left.sequence - right.sequence);
}

function evidenceTime(snapshot: FactoryReadSnapshot, events: readonly FactoryEvent[]): Date {
  if (snapshot.readAt && Number.isFinite(snapshot.readAt.getTime())) return snapshot.readAt;
  const last = events.at(-1)?.at;
  return new Date(last ?? "1970-01-01T00:00:00.000Z");
}

function derivedItems(
  snapshot: FactoryReadSnapshot,
  observedAt: Date,
): DerivedWorkItem[] {
  return snapshot.workItems.map((item) => {
    const normalized: WorkItemSnapshot = {
      id: item.id ?? `issue-${item.number}`,
      number: item.number,
      title: item.title ?? `Work Item #${item.number}`,
      ...(item.body === undefined ? {} : { body: item.body }),
      closed: item.closed ?? false,
      assignees: [...(item.assignees ?? [])],
      labels: [...(item.labels ?? [])],
      ...(item.subIssuePosition === undefined
        ? {}
        : { subIssuePosition: item.subIssuePosition }),
      ...(item.issueFieldValues === undefined
        ? {}
        : { issueFieldValues: structuredClone(item.issueFieldValues) }),
      blockedBy: structuredClone(item.blockedBy ?? []),
      linkedPullRequests: structuredClone(item.linkedPullRequests ?? []),
      copilotAssignments: [...(item.copilotAssignments ?? [])],
      ...(item.factoryEvents === undefined
        ? {}
        : { factoryEvents: structuredClone(item.factoryEvents) }),
    };
    const state = deriveState(normalized, observedAt);
    const attempts = (normalized.factoryEvents ?? []).reduce(
      (highest, event) =>
        event.kind === "attempt" ? Math.max(highest, event.attempt) : highest,
      0,
    );
    return {
      ...normalized,
      state,
      attempts,
      doneWithoutMergedPullRequest:
        state === "done" &&
        !normalized.linkedPullRequests.some((pullRequest) => pullRequest.state === "MERGED"),
    };
  });
}

function policyFor(events: readonly FactoryEvent[]): RunPolicy | null {
  const run = latestRunReceipts([...events]);
  if (run) return run.start.policy;
  const activation = [...events]
    .reverse()
    .find(
      (event) => event.kind === "run" && event.event === "ActivationRequested",
    );
  return activation?.kind === "run" && activation.event === "ActivationRequested"
    ? activation.policy
    : null;
}

function prioritySourceFromAdmission(
  event: Extract<FactoryEvent, { kind: "attempt" }>,
  policy: RunPolicy,
): ObservedPrioritySource {
  if (typeof event.prioritySource === "string") {
    return event.prioritySource as ObservedPrioritySource;
  }
  if (event.priorityFieldId) return "issue-field";
  return normalizeSchedulingPolicy(policy).priority.source ===
    "issue-field-then-subissue-order"
    ? "subissue-order-fallback"
    : "subissue-order";
}

function packetScope(item: ReadWorkItemSnapshot): {
  paths: string[];
  exclusiveResources: string[];
} {
  try {
    const packet = parseWorkerPacketFromIssue(item.body ?? "");
    return {
      paths: [...packet.allowedPaths],
      exclusiveResources: [...(packet.changeSurface?.exclusiveResources ?? [])],
    };
  } catch {
    return { paths: [], exclusiveResources: [] };
  }
}

function activeReservations(
  snapshot: FactoryReadSnapshot,
  policy: RunPolicy,
  runId: string,
): CapacityReservation[] {
  const effective = normalizeSchedulingPolicy(policy);
  return deriveCapacityReservations(
    snapshot.workItems.map((item) => {
      const scope = packetScope(item);
      return {
        objective: snapshot.number,
        workItem: item.number,
        events: (item.factoryEvents ?? []).filter((event) => event.runId === runId),
        defaultCpu: effective.capacity.local.defaultCpu,
        defaultMemoryMb: effective.capacity.local.defaultMemoryMb,
        ...scope,
        isLocalBackend: (backendId: string) => {
          const reservation = [...(item.factoryEvents ?? [])]
            .reverse()
            .find(
              (event) =>
                event.runId === runId &&
                event.kind === "attempt" &&
                event.event === "AttemptReserved" &&
                event.backend === backendId,
            );
          return reservation?.kind === "attempt"
            ? reservation.admissionClass === "local"
            : !backendId.includes("daytona") &&
                !backendId.includes("vercel-sandbox") &&
                backendId !== "github-copilot/github-managed";
        },
      };
    }),
  );
}

export function buildStatusReport(input: {
  repository: string;
  snapshot: FactoryReadSnapshot;
}): FactoryStatusReport {
  const events = snapshotEvents(input.snapshot);
  const observedAt = evidenceTime(input.snapshot, events);
  const items = derivedItems(input.snapshot, observedAt);
  const run = latestRunReceipts(events);
  const policy = policyFor(events);
  const runEvents = run?.events ?? [];
  const effective = policy ? normalizeSchedulingPolicy(policy) : null;
  let readyOrder: FactoryStatusReport["readyOrder"] = [];
  let readyOrderAvailability: FactoryStatusReport["readyOrderAvailability"] = {
    availability: "unavailable",
    reason: "no immutable run policy is available",
  };
  if (effective) {
    try {
      readyOrder = rankReadyWorkItems(items, effective.priority).map((item, index) => ({
        position: index + 1,
        workItem: item.item.number,
        rank: item.rank,
        source: item.source,
        subIssuePosition: item.subIssuePosition,
        criticalPathLength: item.criticalPathLength,
        unfinishedDownstream: item.unfinishedDownstream,
      }));
      readyOrderAvailability = { availability: "observed" };
    } catch (error) {
      readyOrderAvailability = {
        availability: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const reservationValues =
    policy && run && !run.terminal
      ? activeReservations(input.snapshot, policy, run.runId)
      : [];
  const reservationByWorkItem = new Map(
    reservationValues.map((reservation) => [reservation.workItem, reservation]),
  );
  const rankedByWorkItem = new Map(readyOrder.map((item) => [item.workItem, item]));
  const latestHost = [...runEvents]
    .reverse()
    .find(
      (event) =>
        event.kind === "attempt" &&
        event.event === "AttemptReserved" &&
        event.capacityMeasuredAt !== undefined &&
        event.effectiveCpu !== undefined &&
        event.availableMemoryMb !== undefined &&
        event.loadRatio !== undefined &&
        event.memoryUsageRatio !== undefined,
    );
  const controller = [...events]
    .reverse()
    .find((event) => event.kind === "controller");
  const statusItems = items.map((item): StatusWorkItem => {
    const itemEvents = (item.factoryEvents ?? [])
      .filter((event) => !run || event.runId === run.runId)
      .sort((left, right) => left.sequence - right.sequence);
    const admission = [...itemEvents]
      .reverse()
      .find(
        (event) =>
          event.kind === "attempt" && event.event === "AttemptReserved",
      );
    const queued = [...itemEvents]
      .reverse()
      .find(
        (event) =>
          event.kind === "scheduling" &&
          (!admission || event.sequence > admission.sequence),
      );
    const ranked = rankedByWorkItem.get(item.number);
    const reservation = reservationByWorkItem.get(item.number);
    const queuedAt = run ? queuedSince(item, run.runId) : undefined;
    const priority =
      admission?.kind === "attempt" && admission.priorityRank !== undefined && policy
        ? {
            rank: admission.priorityRank,
            source: prioritySourceFromAdmission(admission, policy),
            sourceEvidence: "admission-receipt" as const,
            subIssuePosition: admission.subIssuePosition ?? item.subIssuePosition ?? item.number,
          }
        : queued?.kind === "scheduling" && policy
          ? {
              rank: queued.observedPriorityRank,
              source:
                queued.prioritySource ??
                (effective!.priority.source === "subissue-order"
                  ? ("subissue-order" as const)
                  : ("subissue-order-fallback" as const)),
              sourceEvidence: "queue-receipt" as const,
              subIssuePosition: queued.observedSubIssuePosition,
            }
        : ranked
          ? {
              rank: ranked.rank,
              source: ranked.source,
              sourceEvidence: "current-snapshot" as const,
              subIssuePosition: ranked.subIssuePosition,
            }
          : policy
            ? {
                rank: effective!.priority.unsetRank,
                source:
                  effective!.priority.source === "subissue-order"
                    ? ("subissue-order" as const)
                    : ("subissue-order-fallback" as const),
                sourceEvidence: "run-policy" as const,
                subIssuePosition: item.subIssuePosition ?? item.number,
              }
            : undefined;
    return {
      number: item.number,
      title: item.title,
      state: item.state,
      openDependencies: item.blockedBy
        .filter((dependency) => !dependency.closed)
        .map((dependency) => dependency.number)
        .sort((left, right) => left - right),
      ...(queuedAt === undefined ? {} : { queuedSince: queuedAt }),
      ...(queued?.kind === "scheduling" &&
      (queued.reasonCode ?? queuedReasonCode(queued.reason))
        ? {
            queueReasonCode: (queued.reasonCode ?? queuedReasonCode(queued.reason))!,
          }
        : {}),
      ...(priority ? { priority } : {}),
      ...(reservation
        ? {
            activeReservation: {
              attempt: reservation.attempt,
              phase: reservation.phase,
              backendId: reservation.backendId,
              admissionClass: reservation.admissionClass,
              cpu: reservation.cpu,
              memoryMb: reservation.memoryMb,
            },
          }
        : {}),
      ...(admission?.kind === "attempt" && admission.admissionClass && admission.admissionReason
        ? {
            latestAdmission: {
              attempt: admission.attempt,
              backendId: admission.backend,
              admissionClass: admission.admissionClass,
              reason: admission.admissionReason,
            },
          }
        : {}),
    };
  });
  const burstAdmissions = runEvents
    .filter(
      (event) =>
        event.kind === "attempt" &&
        event.event === "AttemptReserved" &&
        event.admissionClass === "burst" &&
        event.admissionReason !== undefined,
    )
    .map((event) => {
      if (event.kind !== "attempt") throw new Error("unreachable attempt filter");
      return {
        workItem: event.workItem,
        attempt: event.attempt,
        trigger: event.admissionReason!,
        backendId: event.backend,
      };
    });
  return {
    operation: "status",
    repository: input.repository,
    objective: {
      number: input.snapshot.number,
      title: input.snapshot.title,
      closed: input.snapshot.closed ?? false,
      observedAt: observedAt.toISOString(),
    },
    run: run
      ? {
          availability: "observed",
          runId: run.runId,
          state: run.terminal
            ? run.terminal.event === "FactoryRunCompleted"
              ? "completed"
              : run.terminal.event === "FactoryRunCancelled"
                ? "cancelled"
                : "escalated"
            : "active",
          policyDigest: run.start.policyDigest,
          startedAt: run.start.at,
          ...(run.terminal ? { finishedAt: run.terminal.at } : {}),
        }
      : { availability: "unavailable", state: "not-started" },
    readyOrder,
    readyOrderAvailability,
    capacity: {
      configured: effective
        ? {
            availability: "observed",
            maxParallel: policy!.maxParallel,
            localMaxWorkers: effective.capacity.local.maxWorkers,
            cloudMaxWorkers: effective.burst.maxCloudParallel,
            backendMaxParallel: { ...effective.capacity.backendMaxParallel },
          }
        : {
            availability: "unavailable",
            reason: "no immutable run policy is available",
          },
      observed: {
        active: reservationValues.length,
        local: reservationValues.filter((reservation) => reservation.local).length,
        cloud: reservationValues.filter((reservation) => !reservation.local).length,
        cpuReserved: reservationValues
          .filter((reservation) => reservation.local)
          .reduce((sum, reservation) => sum + reservation.cpu, 0),
        memoryMbReserved: reservationValues
          .filter((reservation) => reservation.local)
          .reduce((sum, reservation) => sum + reservation.memoryMb, 0),
        latestHostSample:
          latestHost?.kind === "attempt"
            ? {
                availability: "observed",
                measuredAt: latestHost.capacityMeasuredAt!,
                effectiveCpu: latestHost.effectiveCpu!,
                availableMemoryMb: latestHost.availableMemoryMb!,
                loadRatio: latestHost.loadRatio!,
                memoryUsageRatio: latestHost.memoryUsageRatio!,
              }
            : {
                availability: "unavailable",
                reason: "no admission receipt contains a complete host-capacity sample",
              },
      },
      activeReservations: reservationValues.map((reservation) => ({
        workItem: reservation.workItem,
        attempt: reservation.attempt,
        phase: reservation.phase,
        backendId: reservation.backendId,
        admissionClass: reservation.admissionClass,
        local: reservation.local,
        cpu: reservation.cpu,
        memoryMb: reservation.memoryMb,
      })),
    },
    burst: {
      configured: effective
        ? {
            availability: "observed",
            mode: effective.burst.mode,
            maxCloudParallel: effective.burst.maxCloudParallel,
            maxPriorityRank: effective.burst.maxPriorityRank,
            queueDelaySeconds: effective.burst.queueDelaySeconds,
            deadlineReserveMinutes: effective.burst.deadlineReserveMinutes,
          }
        : {
            availability: "unavailable",
            reason: "no immutable run policy is available",
          },
      admitted: burstAdmissions,
    },
    controller: {
      latestObservation:
        controller?.kind === "controller"
          ? {
              availability: "observed",
              observedAt: controller.at,
              epoch: controller.epoch,
              expiresAt: controller.expiresAt,
              protocolMin: controller.protocolMin,
              protocolMax: controller.protocolMax,
            }
          : {
              availability: "unavailable",
              reason: "no durable controller observation is available",
            },
    },
    workItems: statusItems,
    summary: summarizeRun(events, policy ?? undefined),
  };
}
