import {
  parseFactoryEvent,
  type FactoryEvent,
  type ReportedModelUsage,
} from "../protocol/events.js";
import { PROTOCOL_V2 } from "../protocol/limits.js";
import { encodeEventBatchComment, encodeEventComment } from "./receipts.js";
import type { AttemptReservation } from "./attempts.js";
import type { LeaseManager, LeaseState } from "./lease.js";
import type { ValidationEvidence } from "../validation/evidence.js";
import type { DeliverySelection } from "../publication/delivery.js";
import type { PublicationReceipt } from "../publication/stack-manager.js";
import { writerAuthority } from "./authority.js";

export interface LifecycleEventStore {
  addIssueComment(issueNodeId: string, body: string): Promise<void>;
  serverTime(): Promise<Date>;
}

export interface BudgetEventArgs {
  lease: LeaseState;
  workItemNodeId: string;
  reservation: AttemptReservation;
  sequence: number;
  event: "BudgetReserved" | "BudgetReconciled";
  unit:
    | "model_tokens"
    | "local_milliseconds"
    | "sandbox_milliseconds"
    | "managed_sessions"
    | "validation_milliseconds";
  amount: number;
  phase?: "management" | "execution" | "validation";
  usageId?: string;
  modelInvocationId?: string;
  directorEpoch?: number;
  policyDigest?: string;
  usageEvidence?: "as-recorded" | "conservative-reservation";
  reason?: string;
  reportedModelUsage?: ReportedModelUsage;
}

function assertReservationLease(reservation: AttemptReservation, lease: LeaseState): void {
  if (
    reservation.objective !== lease.objective ||
    reservation.runId !== lease.runId ||
    reservation.policyDigest !== lease.policyDigest
  ) {
    throw new Error(
      "validation or budget reservation is fenced from the current Objective, run, or policy",
    );
  }
  // A later holder of this same run may reconcile the original attempt's evidence.
  // It cannot borrow a reservation from a future epoch or a different run.
  if (
    !Number.isSafeInteger(reservation.directorEpoch) ||
    reservation.directorEpoch <= 0 ||
    !Number.isSafeInteger(lease.epoch) ||
    lease.epoch <= 0 ||
    reservation.directorEpoch > lease.epoch
  ) {
    throw new Error("validation or budget reservation is fenced from the current lease epoch");
  }
}

export class LifecycleRecorder {
  constructor(
    private readonly store: LifecycleEventStore,
    private readonly leases: LeaseManager,
  ) {}

  async controller(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    controllerId: string;
    observationScope?: "repository-controller" | "objective-writer";
    epoch: number;
    expiresAt: string;
    controllerPolicyDigest: string;
    protocolMin: string;
    protocolMax: string;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "controller",
      ...writerAuthority(args.lease, args.sequence),
      event: "ControllerObserved",
      ...(args.observationScope ? { observationScope: args.observationScope } : {}),
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      controllerId: args.controllerId,
      epoch: args.epoch,
      expiresAt: args.expiresAt,
      controllerPolicyDigest: args.controllerPolicyDigest,
      protocolMin: args.protocolMin,
      protocolMax: args.protocolMax,
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        `Factory observed repository controller ${args.controllerId} at epoch ${args.epoch}.`,
        event,
      ),
    );
    return event;
  }

  async operationalGate(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    event: "RunPauseAcknowledged" | "RunDrainCompleted";
    commandRequestId: string;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      ...writerAuthority(args.lease, args.sequence),
      event: args.event,
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      commandRequestId: args.commandRequestId,
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        args.event === "RunDrainCompleted"
          ? "Factory drained all admitted work and is releasing the run lease."
          : "Factory paused new admissions after reconciling admitted work.",
        event,
      ),
    );
    return event;
  }

  async graph(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    graphDigest: string;
    graphSize: number;
    baseSha: string;
    graphRef: string;
    graphBlobSha: string;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "graph",
      event: "GraphCompiled",
      ...writerAuthority(args.lease, args.sequence),
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      graphDigest: args.graphDigest,
      graphSize: args.graphSize,
      baseSha: args.baseSha,
      graphRef: args.graphRef,
      graphBlobSha: args.graphBlobSha,
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        `Factory compiled ${args.graphSize} Work Item${args.graphSize === 1 ? "" : "s"} at ${args.baseSha}.`,
        event,
      ),
    );
    return event;
  }

  async graphProjection(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    graphDigest: string;
    graphSize: number;
    projectionRef: string;
    projectionBlobSha: string;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "graph",
      event: "GraphProjected",
      ...writerAuthority(args.lease, args.sequence),
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      graphDigest: args.graphDigest,
      graphSize: args.graphSize,
      projectionRef: args.projectionRef,
      projectionBlobSha: args.projectionBlobSha,
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        `Factory sealed ${args.graphSize} Work Item GitHub issue binding${args.graphSize === 1 ? "" : "s"}.`,
        event,
      ),
    );
    return event;
  }

  async delivery(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    selection: DeliverySelection;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "delivery",
      event: "DeliverySelected",
      ...writerAuthority(args.lease, args.sequence),
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      ...args.selection,
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        `Factory selected ${args.selection.selected}: ${args.selection.reason}`,
        event,
      ),
    );
    return event;
  }

  async publication(args: {
    lease: LeaseState;
    workItemNodeId: string;
    sequence: number;
    receipt: PublicationReceipt;
    event:
      | "PublicationRecorded"
      | "StackLinked"
      | "ValidationInvalidated"
      | "IntegrationPending"
      | "IntegrationFailed"
      | "IntegrationCompleted"
      | "IntegrationCancelled"
      | "IntegrationRolledBack";
    operationId?: string;
    asynchronousMergeUuid?: string;
    reason?: string;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    if (args.receipt.runId !== args.lease.runId) {
      throw new Error("publication receipt belongs to another run");
    }
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "publication",
      ...writerAuthority(args.lease, args.sequence),
      event: args.event,
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.receipt.workItem,
      attempt: args.receipt.attempt,
      unitId: args.receipt.unitId,
      itemId: args.receipt.itemId,
      mode: args.receipt.mode,
      position: args.receipt.position,
      ...(args.receipt.parentItemId ? { parentItemId: args.receipt.parentItemId } : {}),
      branch: args.receipt.branch,
      baseBranch: args.receipt.baseBranch,
      baseSha: args.receipt.baseSha,
      headSha: args.receipt.headSha,
      pullRequest: args.receipt.pullRequest,
      capabilityVersion: args.receipt.capabilityVersion,
      validationDigest: args.receipt.exactHeadValidation.validationDigest,
      exactHeadValidationDigest: args.receipt.exactHeadValidation.digest,
      ...(args.receipt.stackNumber ? { stackNumber: args.receipt.stackNumber } : {}),
      ...(args.receipt.invalidatedByItem
        ? { invalidatedByItem: args.receipt.invalidatedByItem }
        : {}),
      ...(args.receipt.invalidatedByHeadSha
        ? { invalidatedByHeadSha: args.receipt.invalidatedByHeadSha }
        : {}),
      ...(args.operationId ? { operationId: args.operationId } : {}),
      ...(args.asynchronousMergeUuid ? { asynchronousMergeUuid: args.asynchronousMergeUuid } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    await this.store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(
        `Factory recorded ${args.event} for pull request #${args.receipt.pullRequest}.`,
        event,
      ),
    );
    return event;
  }

  async validation(args: {
    lease: LeaseState;
    workItemNodeId: string;
    reservation: AttemptReservation;
    evidence: ValidationEvidence;
    sequence: number;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    assertReservationLease(args.reservation, args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "validation",
      ...writerAuthority(args.lease, args.sequence),
      event: "ValidationRecorded",
      objective: args.reservation.objective,
      runId: args.reservation.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.reservation.workItem,
      attempt: args.reservation.attempt,
      baseSha: args.evidence.baseSha,
      outputTreeSha: args.evidence.outputTreeSha,
      passed: args.evidence.passed,
      evidenceDigest: args.evidence.digest,
    });
    await this.store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(
        args.evidence.passed
          ? `Factory independently validated attempt ${args.reservation.attempt}.`
          : `Factory validation failed for attempt ${args.reservation.attempt}: ${args.evidence.failureReason ?? "validation failed"}`,
        event,
      ),
    );
    return event;
  }

  async budget(args: BudgetEventArgs): Promise<FactoryEvent> {
    return (await this.budgetBatch([args]))[0]!;
  }

  async budgetBatch(args: readonly BudgetEventArgs[]): Promise<FactoryEvent[]> {
    if (args.length === 0) throw new Error("budget event batch must not be empty");
    const first = args[0]!;
    if (
      args.some(
        (value) =>
          value.lease !== first.lease ||
          value.workItemNodeId !== first.workItemNodeId ||
          value.reservation !== first.reservation,
      )
    ) {
      throw new Error("budget event batch must share one lease, reservation, and destination");
    }
    await this.leases.assertMutationAuthorized(first.lease);
    assertReservationLease(first.reservation, first.lease);
    const now = await this.store.serverTime();
    const events = args.map((value) => {
      if (
        value.modelInvocationId &&
        ((value.policyDigest !== undefined &&
          value.policyDigest !== value.reservation.policyDigest) ||
          (value.directorEpoch !== undefined &&
            value.directorEpoch !== value.reservation.directorEpoch))
      ) {
        throw new Error("model invocation receipt must retain its original attempt binding");
      }
      return parseFactoryEvent({
        protocol: PROTOCOL_V2,
        kind: "budget",
        ...writerAuthority(value.lease, value.sequence),
        event: value.event,
        objective: value.reservation.objective,
        runId: value.reservation.runId,
        sequence: value.sequence,
        at: now.toISOString(),
        workItem: value.reservation.workItem,
        attempt: value.reservation.attempt,
        phase:
          value.phase ??
          (value.unit === "validation_milliseconds"
            ? "validation"
            : value.unit === "model_tokens"
              ? "management"
              : "execution"),
        unit: value.unit,
        amount: value.amount,
        ...(value.usageId ? { usageId: value.usageId } : {}),
        ...(value.modelInvocationId ? { modelInvocationId: value.modelInvocationId } : {}),
        ...(value.modelInvocationId
          ? {
              directorEpoch: value.directorEpoch ?? value.reservation.directorEpoch,
              policyDigest: value.policyDigest ?? value.reservation.policyDigest,
            }
          : {}),
        ...(value.usageEvidence ? { usageEvidence: value.usageEvidence } : {}),
        ...(value.usageEvidence === "conservative-reservation"
          ? {
              directorEpoch: value.reservation.directorEpoch,
              policyDigest: value.reservation.policyDigest,
            }
          : {}),
        ...(value.reason ? { reason: value.reason } : {}),
        ...(value.reportedModelUsage ? { reportedModelUsage: value.reportedModelUsage } : {}),
      });
    });
    await this.store.addIssueComment(
      first.workItemNodeId,
      encodeEventBatchComment(
        events.length === 1
          ? first.event === "BudgetReserved" && first.modelInvocationId
            ? "Factory recorded model dispatch intent; token consumption is not yet known."
            : `Factory ${first.event === "BudgetReserved" ? "reserved" : "reconciled"} ${first.amount} ${first.unit}.`
          : `Factory recorded ${events.length} adjacent budget reconciliations.`,
        events,
      ),
    );
    return events;
  }

  async objectiveBudget(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    workItem?: number;
    sequence: number;
    event: "BudgetReserved" | "BudgetReconciled";
    unit: "model_tokens" | "local_milliseconds";
    amount: number;
    usageId?: string;
    modelInvocationId?: string;
    directorEpoch?: number;
    policyDigest?: string;
    reportedModelUsage?: ReportedModelUsage;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    if (
      args.modelInvocationId &&
      (args.policyDigest !== args.lease.policyDigest ||
        args.directorEpoch === undefined ||
        args.directorEpoch > args.lease.epoch ||
        (args.event === "BudgetReserved" && args.directorEpoch !== args.lease.epoch))
    )
      throw new Error("model invocation receipt is fenced from its original run policy or epoch");
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "budget",
      ...writerAuthority(args.lease, args.sequence),
      event: args.event,
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      phase: "management",
      ...(args.workItem !== undefined ? { workItem: args.workItem } : {}),
      unit: args.unit,
      amount: args.amount,
      ...(args.usageId ? { usageId: args.usageId } : {}),
      ...(args.modelInvocationId ? { modelInvocationId: args.modelInvocationId } : {}),
      ...(args.modelInvocationId
        ? { directorEpoch: args.directorEpoch, policyDigest: args.policyDigest }
        : {}),
      ...(args.reportedModelUsage ? { reportedModelUsage: args.reportedModelUsage } : {}),
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        args.event === "BudgetReserved" && args.modelInvocationId
          ? "Factory recorded model dispatch intent; token consumption is not yet known."
          : `Factory recorded ${args.amount} ${args.unit} for management.`,
        event,
      ),
    );
    return event;
  }

  async providerQuotaBlocked(args: {
    lease: LeaseState;
    issueNodeId: string;
    sequence: number;
    phase: "management" | "execution";
    backend: string;
    modelInvocationId: string;
    provider: string;
    providerMessage: string;
    actionUrl?: string;
    accounting: "exact" | "unknown";
    reservation?: AttemptReservation;
    workItem?: number;
  }): Promise<FactoryEvent> {
    await this.leases.assertMutationAuthorized(args.lease);
    if (args.reservation) assertReservationLease(args.reservation, args.lease);
    if (args.phase === "execution" && !args.reservation)
      throw new Error("execution provider quota evidence requires its attempt reservation");
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "provider",
      event: "ProviderQuotaBlocked",
      ...writerAuthority(args.lease, args.sequence),
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      reasonCode: "provider-quota-exhausted",
      provider: args.provider,
      phase: args.phase,
      backend: args.backend,
      modelInvocationId: args.modelInvocationId,
      ...(args.reservation
        ? { workItem: args.reservation.workItem, attempt: args.reservation.attempt }
        : args.workItem !== undefined
          ? { workItem: args.workItem }
          : {}),
      providerMessage: args.providerMessage,
      ...(args.actionUrl ? { actionUrl: args.actionUrl } : {}),
      accounting: args.accounting,
    });
    await this.store.addIssueComment(
      args.issueNodeId,
      encodeEventComment(
        `Factory stopped at a non-retryable ${args.providerMessage}. Restore provider quota before explicitly resuming.`,
        event,
      ),
    );
    return event;
  }
}
