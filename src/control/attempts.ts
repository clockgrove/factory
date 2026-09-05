import {
  type AttemptEvent,
  type FactoryEvent,
  type ReportedModelUsage,
  parseFactoryEvent,
} from "../protocol/events.js";
import { assertNoSecretMaterial, PROTOCOL_V2 } from "../protocol/limits.js";
import { encodeEventComment, encodeEventTrailer } from "./receipts.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "./lease.js";
import type { LocalScopeBatch } from "../protocol/local-scope.js";

export interface AttemptStore {
  listRefs(prefix: string): Promise<Array<{ ref: string; oid: string }>>;
  readCommit(oid: string): Promise<GitCommitObject>;
  createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
  addIssueComment(issueNodeId: string, body: string): Promise<void>;
  serverTime(): Promise<Date>;
}

export interface AttemptReservation {
  ref: string;
  oid: string;
  objective: number;
  workItem: number;
  attempt: number;
  backend: string;
  baseSha: string;
  runId: string;
  directorEpoch: number;
  policyDigest: string;
  sequence: number;
  createdAt: Date;
  admission?: AttemptAdmissionReceipt;
  localScopeBatch?: LocalScopeBatch;
}

export interface AttemptAdmissionReceipt {
  admissionClass: "local" | "remote-required" | "burst";
  admissionReason:
    | "local-capacity"
    | "capability-required"
    | "local-saturated"
    | "queue-delay"
    | "deadline";
  requestedCpu: number;
  requestedMemoryMb: number;
  priorityRank: number;
  prioritySource?:
    | "subissue-order"
    | "issue-field"
    | "subissue-order-fallback"
    | "operator-command";
  priorityFieldId?: string;
  priorityOptionId?: string;
  subIssuePosition: number;
  criticalPathLength: number;
  unfinishedDownstream: number;
  capacityMeasuredAt?: string;
  effectiveCpu?: number;
  availableMemoryMb?: number;
  loadRatio?: number;
  memoryUsageRatio?: number;
  estimatedCloudTimeSavedMinutes?: number;
  minimumCloudTimeSavedMinutes?: number;
}

function admissionFromEvent(event: AttemptEvent): AttemptAdmissionReceipt | undefined {
  if (
    event.admissionClass === undefined ||
    event.admissionReason === undefined ||
    event.requestedCpu === undefined ||
    event.requestedMemoryMb === undefined ||
    event.priorityRank === undefined ||
    event.subIssuePosition === undefined ||
    event.criticalPathLength === undefined ||
    event.unfinishedDownstream === undefined
  ) {
    return undefined;
  }
  const prioritySource =
    typeof event.prioritySource === "string"
      ? (event.prioritySource as AttemptAdmissionReceipt["prioritySource"])
      : undefined;
  return {
    admissionClass: event.admissionClass,
    admissionReason: event.admissionReason,
    requestedCpu: event.requestedCpu,
    requestedMemoryMb: event.requestedMemoryMb,
    priorityRank: event.priorityRank,
    ...(prioritySource ? { prioritySource } : {}),
    ...(event.priorityFieldId ? { priorityFieldId: event.priorityFieldId } : {}),
    ...(event.priorityOptionId ? { priorityOptionId: event.priorityOptionId } : {}),
    subIssuePosition: event.subIssuePosition,
    criticalPathLength: event.criticalPathLength,
    unfinishedDownstream: event.unfinishedDownstream,
    ...(event.capacityMeasuredAt ? { capacityMeasuredAt: event.capacityMeasuredAt } : {}),
    ...(event.effectiveCpu === undefined ? {} : { effectiveCpu: event.effectiveCpu }),
    ...(event.availableMemoryMb === undefined
      ? {}
      : { availableMemoryMb: event.availableMemoryMb }),
    ...(event.loadRatio === undefined ? {} : { loadRatio: event.loadRatio }),
    ...(event.memoryUsageRatio === undefined ? {} : { memoryUsageRatio: event.memoryUsageRatio }),
    ...(event.estimatedCloudTimeSavedMinutes === undefined
      ? {}
      : {
          estimatedCloudTimeSavedMinutes: event.estimatedCloudTimeSavedMinutes,
        }),
    ...(event.minimumCloudTimeSavedMinutes === undefined
      ? {}
      : { minimumCloudTimeSavedMinutes: event.minimumCloudTimeSavedMinutes }),
  };
}

export class AttemptReservationConflict extends Error {
  constructor(message = "another Director reserved this Work Item attempt") {
    super(message);
    this.name = "AttemptReservationConflict";
  }
}

export function attemptRefPrefix(objective: number, workItem: number): string {
  if (![objective, workItem].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Objective and Work Item numbers must be positive integers");
  }
  return `refs/clockgrove-factory/attempts/objective-${objective}/work-item-${workItem}/`;
}

export function attemptRef(objective: number, workItem: number, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new Error("attempt number must be a positive integer");
  }
  return `${attemptRefPrefix(objective, workItem)}attempt-${attempt}`;
}

function parseReservation(ref: string, commit: GitCommitObject): AttemptReservation {
  const trailer = commit.message
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("Factory-Event: "));
  if (!trailer) throw new Error(`${ref} has no Factory event trailer`);
  const raw = Buffer.from(trailer.slice("Factory-Event: ".length), "base64url").toString("utf8");
  const event = parseFactoryEvent(JSON.parse(raw));
  if (event.kind !== "attempt" || event.event !== "AttemptReserved") {
    throw new Error(`${ref} does not describe an attempt reservation`);
  }
  const admission = admissionFromEvent(event);
  return {
    ref,
    oid: commit.oid,
    objective: event.objective,
    workItem: event.workItem,
    attempt: event.attempt,
    backend: event.backend,
    baseSha: event.baseSha,
    runId: event.runId,
    directorEpoch: event.directorEpoch,
    policyDigest: event.policyDigest,
    sequence: event.sequence,
    createdAt: new Date(event.at),
    ...(admission ? { admission } : {}),
    ...(event.localScopeBatch ? { localScopeBatch: event.localScopeBatch } : {}),
  };
}

export interface AttemptManagerOptions {
  store: AttemptStore;
  leases: LeaseManager;
}

export class AttemptManager {
  readonly #store: AttemptStore;
  readonly #leases: LeaseManager;

  constructor(options: AttemptManagerOptions) {
    this.#store = options.store;
    this.#leases = options.leases;
  }

  async list(objective: number, workItem: number): Promise<AttemptReservation[]> {
    const prefix = attemptRefPrefix(objective, workItem);
    const refs = await this.#store.listRefs(prefix);
    const attempts = await Promise.all(
      refs.map(async ({ ref, oid }) => parseReservation(ref, await this.#store.readCommit(oid))),
    );
    return attempts.sort((a, b) => a.attempt - b.attempt);
  }

  async reserve(args: {
    lease: LeaseState;
    workItem: number;
    workItemNodeId: string;
    backend: string;
    base: GitCommitObject;
    sequence: number;
    admission?: AttemptAdmissionReceipt;
    prepareLocalScope?: (attempt: number, at: Date) => Promise<LocalScopeBatch | null>;
  }): Promise<AttemptReservation> {
    await this.#leases.assertCurrent(args.lease);
    const existing = await this.list(args.lease.objective, args.workItem);
    const next = (existing.at(-1)?.attempt ?? 0) + 1;
    const ref = attemptRef(args.lease.objective, args.workItem, next);
    const now = await this.#store.serverTime();
    const localScopeBatch = await args.prepareLocalScope?.(next, now);
    const event: AttemptEvent = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: "AttemptReserved",
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.workItem,
      attempt: next,
      backend: args.backend,
      baseSha: args.base.oid,
      directorEpoch: args.lease.epoch,
      policyDigest: args.lease.policyDigest,
      ...(args.admission ?? {}),
      ...(localScopeBatch ? { localScopeBatch } : {}),
    };
    parseFactoryEvent(event);
    const oid = await this.#store.createCommit({
      treeOid: args.base.treeOid,
      parentOids: [args.base.oid],
      message:
        `Factory attempt ${next} reservation for Work Item #${args.workItem}\n\n` +
        encodeEventTrailer(event),
    });
    await this.#leases.assertCurrent(args.lease);
    const won = await this.#store.createRef(ref, oid);
    if (!won) throw new AttemptReservationConflict();
    await this.#store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(`Factory reserved attempt ${next} using \`${args.backend}\`.`, event),
    );
    return {
      ref,
      oid,
      objective: event.objective,
      workItem: event.workItem,
      attempt: event.attempt,
      backend: event.backend,
      baseSha: event.baseSha,
      runId: event.runId,
      directorEpoch: event.directorEpoch,
      policyDigest: event.policyDigest,
      sequence: event.sequence,
      createdAt: now,
      ...(args.admission ? { admission: args.admission } : {}),
      ...(localScopeBatch ? { localScopeBatch } : {}),
    };
  }

  async record(args: {
    lease: LeaseState;
    workItemNodeId: string;
    reservation: AttemptReservation;
    event: Exclude<AttemptEvent["event"], "AttemptReserved">;
    sequence: number;
    reason?: string;
    providerResourceId?: string;
    resourceHostIdentity?: string;
    environmentIdentity?: string;
    artifactDigest?: string;
    headSha?: string;
    modelProfile?: string;
    reportedModelTokens?: number;
    reportedModelUsage?: ReportedModelUsage;
    allowRecovery?: boolean;
  }): Promise<AttemptEvent> {
    await this.#leases.assertCurrent(args.lease);
    if (args.environmentIdentity) {
      assertNoSecretMaterial(args.environmentIdentity, "attempt environment identity");
    }
    if (
      args.reservation.runId !== args.lease.runId ||
      args.reservation.policyDigest !== args.lease.policyDigest
    ) {
      throw new Error("attempt reservation is fenced from the current lease");
    }
    if (
      args.reservation.directorEpoch !== args.lease.epoch &&
      !(args.allowRecovery && args.reservation.directorEpoch < args.lease.epoch)
    ) {
      throw new Error("attempt reservation is fenced from the current lease epoch");
    }
    const now = await this.#store.serverTime();
    const event: AttemptEvent = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: args.event,
      objective: args.reservation.objective,
      runId: args.reservation.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.reservation.workItem,
      attempt: args.reservation.attempt,
      backend: args.reservation.backend,
      baseSha: args.reservation.baseSha,
      directorEpoch: args.reservation.directorEpoch,
      ...(args.reservation.directorEpoch === args.lease.epoch
        ? {}
        : { recoveryEpoch: args.lease.epoch }),
      policyDigest: args.reservation.policyDigest,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.providerResourceId ? { providerResourceId: args.providerResourceId } : {}),
      ...(args.resourceHostIdentity ? { resourceHostIdentity: args.resourceHostIdentity } : {}),
      ...(args.environmentIdentity ? { environmentIdentity: args.environmentIdentity } : {}),
      ...(args.artifactDigest ? { artifactDigest: args.artifactDigest } : {}),
      ...(args.headSha ? { headSha: args.headSha } : {}),
      ...(args.modelProfile ? { modelProfile: args.modelProfile } : {}),
      ...(args.reportedModelTokens === undefined
        ? {}
        : { reportedModelTokens: args.reportedModelTokens }),
      ...(args.reportedModelUsage ? { reportedModelUsage: args.reportedModelUsage } : {}),
    };
    await this.#store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(
        `Factory recorded ${args.event} for attempt ${args.reservation.attempt}.`,
        event,
      ),
    );
    return event;
  }

  async repairReservationComment(args: {
    lease: LeaseState;
    workItemNodeId: string;
    reservation: AttemptReservation;
  }): Promise<void> {
    await this.#leases.assertCurrent(args.lease);
    if (
      args.reservation.runId !== args.lease.runId ||
      args.reservation.policyDigest !== args.lease.policyDigest
    ) {
      throw new Error("cannot repair a reservation from another run or policy");
    }
    const event: AttemptEvent = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: "AttemptReserved",
      objective: args.reservation.objective,
      runId: args.reservation.runId,
      sequence: args.reservation.sequence,
      at: args.reservation.createdAt.toISOString(),
      workItem: args.reservation.workItem,
      attempt: args.reservation.attempt,
      backend: args.reservation.backend,
      baseSha: args.reservation.baseSha,
      directorEpoch: args.reservation.directorEpoch,
      policyDigest: args.reservation.policyDigest,
      ...(args.reservation.admission ?? {}),
    };
    await this.#store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(
        `Factory repaired the durable receipt for attempt ${args.reservation.attempt}.`,
        event,
      ),
    );
  }

  async recordQueued(args: {
    lease: LeaseState;
    workItem: number;
    workItemNodeId: string;
    sequence: number;
    reason: string;
    reasonCode?: NonNullable<Extract<FactoryEvent, { kind: "scheduling" }>["reasonCode"]>;
    gate?: NonNullable<Extract<FactoryEvent, { kind: "scheduling" }>["gate"]>;
    observedPriorityRank: number;
    observedSubIssuePosition: number;
    prioritySource?: NonNullable<Extract<FactoryEvent, { kind: "scheduling" }>["prioritySource"]>;
  }): Promise<FactoryEvent> {
    await this.#leases.assertCurrent(args.lease);
    const now = await this.#store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "scheduling",
      event: "WorkItemQueued",
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.workItem,
      directorEpoch: args.lease.epoch,
      policyDigest: args.lease.policyDigest,
      reason: args.reason,
      ...(args.reasonCode ? { reasonCode: args.reasonCode } : {}),
      ...(args.gate ? { gate: args.gate } : {}),
      observedPriorityRank: args.observedPriorityRank,
      observedSubIssuePosition: args.observedSubIssuePosition,
      ...(args.prioritySource ? { prioritySource: args.prioritySource } : {}),
    });
    await this.#store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(`Factory queued this Work Item: ${args.reason}.`, event),
    );
    return event;
  }

  async recordCapacity(args: {
    lease: LeaseState;
    workItemNodeId: string;
    reservation: AttemptReservation;
    sequence: number;
    event: "CapacityReserved" | "CapacityReconciled";
    phase: "execution" | "validation";
    backend: string;
    requestedCpu: number;
    requestedMemoryMb: number;
    reason?: string;
    allowRecovery?: boolean;
    localScopeBatch?: LocalScopeBatch;
  }): Promise<FactoryEvent> {
    await this.#leases.assertCurrent(args.lease);
    if (
      args.allowRecovery &&
      args.reservation.directorEpoch !== args.lease.epoch &&
      args.reservation.directorEpoch >= args.lease.epoch
    ) {
      throw new Error("capacity recovery cannot write for a future lease epoch");
    }
    if (
      args.reservation.runId !== args.lease.runId ||
      args.reservation.policyDigest !== args.lease.policyDigest ||
      (args.reservation.directorEpoch !== args.lease.epoch && !args.allowRecovery)
    ) {
      throw new Error("capacity reservation is fenced from the current lease");
    }
    const now = await this.#store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "capacity",
      event: args.event,
      objective: args.reservation.objective,
      runId: args.reservation.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.reservation.workItem,
      attempt: args.reservation.attempt,
      phase: args.phase,
      ...(args.localScopeBatch ? { localScopeBatch: args.localScopeBatch } : {}),
      backend: args.backend,
      requestedCpu: args.requestedCpu,
      requestedMemoryMb: args.requestedMemoryMb,
      directorEpoch: args.reservation.directorEpoch,
      ...(args.reservation.directorEpoch === args.lease.epoch
        ? {}
        : { recoveryEpoch: args.lease.epoch }),
      policyDigest: args.reservation.policyDigest,
      ...(args.reason ? { reason: args.reason } : {}),
    });
    await this.#store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(
        `Factory ${args.event === "CapacityReserved" ? "reserved" : "reconciled"} ${args.phase} capacity on \`${args.backend}\`.`,
        event,
      ),
    );
    return event;
  }
}
