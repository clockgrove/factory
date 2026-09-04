import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { PROTOCOL_V2 } from "../protocol/limits.js";
import { encodeEventComment } from "./receipts.js";
import type { AttemptReservation } from "./attempts.js";
import type { LeaseManager, LeaseState } from "./lease.js";
import type { ValidationEvidence } from "../validation/evidence.js";
import type { DeliverySelection } from "../publication/delivery.js";
import type { PublicationReceipt } from "../publication/stack-manager.js";

export interface LifecycleEventStore {
  addIssueComment(issueNodeId: string, body: string): Promise<void>;
  serverTime(): Promise<Date>;
}

export class LifecycleRecorder {
  constructor(
    private readonly store: LifecycleEventStore,
    private readonly leases: LeaseManager,
  ) {}

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
    await this.leases.assertCurrent(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "graph",
      event: "GraphCompiled",
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

  async delivery(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    selection: DeliverySelection;
  }): Promise<FactoryEvent> {
    await this.leases.assertCurrent(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "delivery",
      event: "DeliverySelected",
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
    await this.leases.assertCurrent(args.lease);
    if (args.receipt.runId !== args.lease.runId) {
      throw new Error("publication receipt belongs to another run");
    }
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "publication",
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
      ...(args.receipt.parentItemId
        ? { parentItemId: args.receipt.parentItemId }
        : {}),
      branch: args.receipt.branch,
      baseBranch: args.receipt.baseBranch,
      baseSha: args.receipt.baseSha,
      headSha: args.receipt.headSha,
      pullRequest: args.receipt.pullRequest,
      capabilityVersion: args.receipt.capabilityVersion,
      validationDigest: args.receipt.exactHeadValidation.validationDigest,
      exactHeadValidationDigest: args.receipt.exactHeadValidation.digest,
      ...(args.receipt.stackNumber
        ? { stackNumber: args.receipt.stackNumber }
        : {}),
      ...(args.receipt.invalidatedByItem
        ? { invalidatedByItem: args.receipt.invalidatedByItem }
        : {}),
      ...(args.receipt.invalidatedByHeadSha
        ? { invalidatedByHeadSha: args.receipt.invalidatedByHeadSha }
        : {}),
      ...(args.operationId ? { operationId: args.operationId } : {}),
      ...(args.asynchronousMergeUuid
        ? { asynchronousMergeUuid: args.asynchronousMergeUuid }
        : {}),
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
    await this.leases.assertCurrent(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "validation",
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

  async budget(args: {
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
  }): Promise<FactoryEvent> {
    await this.leases.assertCurrent(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "budget",
      event: args.event,
      objective: args.reservation.objective,
      runId: args.reservation.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      workItem: args.reservation.workItem,
      attempt: args.reservation.attempt,
      phase:
        args.phase ?? (args.unit === "validation_milliseconds"
          ? "validation"
          : args.unit === "model_tokens"
            ? "management"
            : "execution"),
      unit: args.unit,
      amount: args.amount,
    });
    await this.store.addIssueComment(
      args.workItemNodeId,
      encodeEventComment(
        `Factory ${args.event === "BudgetReserved" ? "reserved" : "reconciled"} ${args.amount} ${args.unit}.`,
        event,
      ),
    );
    return event;
  }

  async objectiveBudget(args: {
    lease: LeaseState;
    objectiveNodeId: string;
    sequence: number;
    event: "BudgetReserved" | "BudgetReconciled";
    unit: "model_tokens" | "local_milliseconds";
    amount: number;
  }): Promise<FactoryEvent> {
    await this.leases.assertCurrent(args.lease);
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "budget",
      event: args.event,
      objective: args.lease.objective,
      runId: args.lease.runId,
      sequence: args.sequence,
      at: now.toISOString(),
      phase: "management",
      unit: args.unit,
      amount: args.amount,
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(`Factory recorded ${args.amount} ${args.unit} for management.`, event),
    );
    return event;
  }
}
