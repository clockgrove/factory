import { isDeepStrictEqual } from "node:util";
import {
  type AttemptEvent,
  type FactoryEvent,
  type ReportedModelUsage,
  parseFactoryEvent,
} from "../protocol/events.js";
import type { ArtifactConsumerBinding } from "../protocol/events.js";
import { assertNoSecretMaterial, PROTOCOL_V2 } from "../protocol/limits.js";
import { encodeEventComment, encodeEventTrailer } from "./receipts.js";
import { writerAuthority } from "./authority.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "./lease.js";
import { ensureAdmissionCompatibility } from "./admission-compatibility.js";
import {
  IssueAdmissionLedger,
  type IssueAdmissionIdentity,
  type IssueAdmissionEvidence,
} from "./issue-admission.js";
import { listAttemptReservationRefs } from "./attempt-readers.js";
export { listAttemptReservationRefs, readAttemptReservationRef } from "./attempt-readers.js";
import type { LocalScopeBatch } from "../protocol/local-scope.js";

export interface AttemptStore {
  readRef(ref: string): Promise<string | null>;
  compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }): Promise<boolean>;
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
  artifactConsumer?: ArtifactConsumerBinding;
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
    ...(event.artifactConsumer ? { artifactConsumer: event.artifactConsumer } : {}),
  };
}

export interface AttemptAdmissionBinding {
  graphDigest: string;
  graphCommitOid: string;
  projectionCommitOid: string;
  capacityReservationId: string;
  budgetReservationId: string;
  resourceIdentity: string;
  artifactConsumer?: ArtifactConsumerBinding;
}

export interface AttemptManagerOptions {
  store: AttemptStore;
  leases: LeaseManager;
  /** Authenticated original graph/run bindings; historical liabilities are never inferred from current parentage. */
  legacyBinding?: (
    reservation: AttemptReservation,
    issueNodeId: string,
  ) => Promise<AttemptAdmissionBinding>;
}

export class AttemptManager {
  readonly #store: AttemptStore;
  readonly #leases: LeaseManager;
  readonly ledger: IssueAdmissionLedger;
  readonly #legacyBinding: AttemptManagerOptions["legacyBinding"];

  constructor(options: AttemptManagerOptions) {
    this.#store = options.store;
    this.#leases = options.leases;
    this.ledger = new IssueAdmissionLedger(options.store);
    this.#legacyBinding = options.legacyBinding;
  }

  async list(objective: number, workItem: number): Promise<AttemptReservation[]> {
    const refs = await listAttemptReservationRefs(this.#store, objective, workItem);
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
    binding: (attempt: number) => Promise<AttemptAdmissionBinding>;
    /** Supplied only after authenticated accepted-successor reconciliation. */
    reassignmentAuthorityReceiptOid?: string;
  }): Promise<AttemptReservation> {
    await this.#leases.assertMutationAuthorized(args.lease);
    const compatibility = await this.ensureCompatibility(
      args.lease,
      args.workItem,
      args.workItemNodeId,
      args.base,
    );
    const current = await this.ledger.read(args.workItem);
    const next = (current?.history.at(-1)?.reservation.attempt ?? 0) + 1;
    const binding = await args.binding(next);
    const ref = attemptRef(args.lease.objective, args.workItem, next);
    const now = await this.#store.serverTime();
    const localScopeBatch = await args.prepareLocalScope?.(next, now);
    const event: AttemptEvent = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: "AttemptReserved",
      ...writerAuthority(args.lease, args.sequence),
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
      ...(binding.artifactConsumer ? { artifactConsumer: binding.artifactConsumer } : {}),
    };
    parseFactoryEvent(event);
    const oid = await this.#store.createCommit({
      treeOid: args.base.treeOid,
      parentOids: [args.base.oid],
      message:
        `Factory attempt ${next} reservation for Work Item #${args.workItem}\n\n` +
        encodeEventTrailer(event),
    });
    await this.#leases.assertMutationAuthorized(args.lease);
    const admissionIdentity = {
      ...binding,
      workItem: args.workItem,
      workItemNodeId: args.workItemNodeId,
      objective: args.lease.objective,
      runId: args.lease.runId,
      directorEpoch: args.lease.epoch,
      writerHolder: args.lease.holder,
      policyDigest: args.lease.policyDigest,
      reservation: { ref, oid, attempt: next, backend: args.backend, baseSha: args.base.oid },
      compatibilityClaimOid: compatibility.claimOid,
      assertCurrent: () => this.#leases.assertCurrent(args.lease).then(() => {}),
    };
    if (args.reassignmentAuthorityReceiptOid) {
      await this.ledger.reassign({
        ...admissionIdentity,
        authorityReceiptOid: args.reassignmentAuthorityReceiptOid,
      });
    } else {
      await this.ledger.admit(admissionIdentity);
    }
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
      ...(binding.artifactConsumer ? { artifactConsumer: binding.artifactConsumer } : {}),
    };
  }

  async ensureCompatibility(
    lease: LeaseState,
    workItem: number,
    workItemNodeId: string,
    base: GitCommitObject,
  ) {
    const assertCurrent = () => this.#leases.assertCurrent(lease).then(() => {});
    const compatibility = await ensureAdmissionCompatibility(this.#store, {
      workItem,
      workItemNodeId,
      objective: lease.objective,
      base,
      assertCurrent,
    });
    const current = await this.ledger.read(workItem);
    if (
      !current &&
      compatibility.legacyObjective &&
      compatibility.legacyObjective !== lease.objective
    )
      throw new Error("legacy issue ownership requires explicit accepted reassignment");
    if (!current && compatibility.legacy.length) {
      if (!this.#legacyBinding)
        throw new Error(
          "legacy admission needs authenticated graph/run evidence; reconcile the original run",
        );
      const history: IssueAdmissionIdentity[] = [];
      for (const old of compatibility.legacy) {
        const reservation = parseReservation(old.ref, await this.#store.readCommit(old.oid));
        const binding = await this.#legacyBinding(reservation, workItemNodeId);
        history.push({
          ...binding,
          workItem,
          workItemNodeId,
          objective: reservation.objective,
          runId: reservation.runId,
          directorEpoch: reservation.directorEpoch,
          writerHolder:
            reservation.runId === lease.runId &&
            reservation.objective === lease.objective &&
            reservation.directorEpoch === lease.epoch
              ? lease.holder
              : `legacy:${reservation.oid}`,
          policyDigest: reservation.policyDigest,
          reservation: {
            ref: old.ref,
            oid: old.oid,
            attempt: reservation.attempt,
            backend: reservation.backend,
            baseSha: reservation.baseSha,
          },
          compatibilityClaimOid: compatibility.claimOid,
        });
      }
      await this.ledger.importLegacy({
        workItem,
        workItemNodeId,
        compatibilityClaimOid: compatibility.claimOid,
        history,
        assertCurrent,
      });
    }
    return compatibility;
  }

  async assertReservation(
    lease: LeaseState,
    reservation: AttemptReservation,
    workItemNodeId: string,
  ) {
    let record = await this.ledger.read(reservation.workItem);
    if (!record) {
      await this.ensureCompatibility(
        lease,
        reservation.workItem,
        workItemNodeId,
        await this.#store.readCommit(reservation.baseSha),
      );
      record = await this.ledger.read(reservation.workItem);
    }
    const admission = record?.history.find((entry) => entry.reservation.oid === reservation.oid);
    const owner = record?.history.at(-1);
    if (
      !admission ||
      !owner ||
      admission.workItemNodeId !== workItemNodeId ||
      owner.objective !== lease.objective ||
      owner.runId !== lease.runId ||
      admission.objective !== reservation.objective ||
      admission.runId !== reservation.runId ||
      admission.objective !== lease.objective ||
      admission.runId !== lease.runId ||
      admission.policyDigest !== lease.policyDigest ||
      admission.policyDigest !== reservation.policyDigest ||
      admission.reservation.ref !== reservation.ref ||
      admission.reservation.attempt !== reservation.attempt ||
      admission.reservation.backend !== reservation.backend ||
      admission.reservation.baseSha !== reservation.baseSha ||
      admission.directorEpoch !== reservation.directorEpoch ||
      admission.writerEpoch > lease.epoch ||
      (admission.writerEpoch === lease.epoch && admission.currentWriterHolder !== lease.holder)
    )
      throw new Error("attempt receipt does not own the exact issue admission");
    const original = parseReservation(
      reservation.ref,
      await this.#store.readCommit(reservation.oid),
    );
    if (!isDeepStrictEqual(original, reservation))
      throw new Error("attempt reservation differs from its immutable metadata");
    return admission;
  }

  /** Restart can close an original intent without inventing producer/process absence:
   * winning the issue CAS prevents every old callback from ever gaining dispatch permission. */
  async recoverUndispatched(args: {
    lease: LeaseState;
    reservation: AttemptReservation;
    workItemNodeId: string;
    sequence: number;
  }): Promise<boolean> {
    await this.#leases.assertCurrent(args.lease);
    await this.assertReservation(args.lease, args.reservation, args.workItemNodeId);
    const closed = await this.ledger.closeUndispatched({
      workItem: args.reservation.workItem,
      reservationOid: args.reservation.oid,
      objective: args.lease.objective,
      runId: args.lease.runId,
      directorEpoch: args.lease.epoch,
      writerHolder: args.lease.holder,
      policyDigest: args.lease.policyDigest,
      assertCurrent: () => this.#leases.assertCurrent(args.lease).then(() => {}),
    });
    if (!closed) return false;
    await this.repairReservationComment(args);
    await this.record({
      ...args,
      event: "AttemptDeferred",
      allowRecovery: true,
      reason:
        "issue admission CAS permanently closed the original intent before any backend dispatch",
    });
    return true;
  }

  /** A winning transition is pre-dispatch intent, never a license to replay launch. */
  async markDispatching(lease: LeaseState, reservation: AttemptReservation): Promise<void> {
    if (
      reservation.objective !== lease.objective ||
      reservation.runId !== lease.runId ||
      reservation.policyDigest !== lease.policyDigest ||
      reservation.directorEpoch !== lease.epoch
    )
      throw new Error("attempt dispatch authority changed");
    await this.ledger.transition({
      workItem: reservation.workItem,
      reservationOid: reservation.oid,
      objective: lease.objective,
      runId: lease.runId,
      directorEpoch: lease.epoch,
      writerHolder: lease.holder,
      policyDigest: lease.policyDigest,
      disposition: "dispatching",
      assertCurrent: () => this.#leases.assertCurrent(lease).then(() => {}),
    });
  }

  async settle(
    lease: LeaseState,
    reservation: AttemptReservation,
    evidence: IssueAdmissionEvidence,
  ): Promise<void> {
    await this.ledger.transition({
      workItem: reservation.workItem,
      reservationOid: reservation.oid,
      objective: lease.objective,
      runId: lease.runId,
      directorEpoch: lease.epoch,
      writerHolder: lease.holder,
      policyDigest: lease.policyDigest,
      disposition: "released",
      evidence,
      assertCurrent: () => this.#leases.assertCurrent(lease).then(() => {}),
    });
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
    sourceArchiveDigest?: string;
    sourceArchiveBytes?: number;
    environmentIdentity?: string;
    artifactDigest?: string;
    headSha?: string;
    modelProfile?: string;
    reportedModelTokens?: number;
    reportedModelUsage?: ReportedModelUsage;
    allowRecovery?: boolean;
  }): Promise<AttemptEvent> {
    await this.#leases.assertMutationAuthorized(args.lease);
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
    const admission = await this.assertReservation(
      args.lease,
      args.reservation,
      args.workItemNodeId,
    );
    const now = await this.#store.serverTime();
    const event: AttemptEvent = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: args.event,
      ...writerAuthority(args.lease, args.sequence),
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
      ...(args.sourceArchiveDigest ? { sourceArchiveDigest: args.sourceArchiveDigest } : {}),
      ...(args.sourceArchiveBytes === undefined
        ? {}
        : { sourceArchiveBytes: args.sourceArchiveBytes }),
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
    if (
      [
        "AttemptSucceeded",
        "AttemptFailed",
        "AttemptTimedOut",
        "AttemptCancelled",
        "AttemptDeferred",
        "AttemptIntegrated",
      ].includes(args.event) &&
      !["released", "reconciled", "terminal"].includes(admission.disposition)
    ) {
      await this.ledger.transition({
        workItem: args.reservation.workItem,
        reservationOid: args.reservation.oid,
        objective: args.lease.objective,
        runId: args.lease.runId,
        directorEpoch: args.lease.epoch,
        writerHolder: args.lease.holder,
        policyDigest: args.lease.policyDigest,
        disposition: "terminal",
        assertCurrent: () => this.#leases.assertCurrent(args.lease).then(() => {}),
      });
    }
    return event;
  }

  async repairReservationComment(args: {
    lease: LeaseState;
    workItemNodeId: string;
    reservation: AttemptReservation;
  }): Promise<void> {
    await this.#leases.assertMutationAuthorized(args.lease);
    if (
      args.reservation.runId !== args.lease.runId ||
      args.reservation.policyDigest !== args.lease.policyDigest
    ) {
      throw new Error("cannot repair a reservation from another run or policy");
    }
    await this.assertReservation(args.lease, args.reservation, args.workItemNodeId);
    const event: AttemptEvent = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: "AttemptReserved",
      ...writerAuthority(args.lease, args.reservation.sequence),
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
      ...(args.reservation.localScopeBatch
        ? { localScopeBatch: args.reservation.localScopeBatch }
        : {}),
      ...(args.reservation.artifactConsumer
        ? { artifactConsumer: args.reservation.artifactConsumer }
        : {}),
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
    await this.#leases.assertMutationAuthorized(args.lease);
    const now = await this.#store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "scheduling",
      event: "WorkItemQueued",
      ...writerAuthority(args.lease, args.sequence),
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
    await this.#leases.assertMutationAuthorized(args.lease);
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
    await this.assertReservation(args.lease, args.reservation, args.workItemNodeId);
    const now = await this.#store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "capacity",
      event: args.event,
      ...writerAuthority(args.lease, args.sequence),
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
