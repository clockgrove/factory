import type { DeliverySelection } from "./delivery.js";
import type { AsyncMergeResult, GitHubStack } from "./github-stacks.js";
import type { PublicationEvent } from "../protocol/events.js";
import {
  acquireIntegrationLease,
  applyIntegrationCommand,
  assertIntegrationHeads,
  type IntegrationLease,
} from "./integration-lease.js";
import { verifyExactHeadValidation, type ExactHeadValidationEvidence } from "../validation/plan.js";

export const PUBLICATION_RECEIPT_PROTOCOL = "clockgrove.factory/publication-receipt-v1" as const;

export interface PublicationReceipt {
  protocol: typeof PUBLICATION_RECEIPT_PROTOCOL;
  runId: string;
  unitId: string;
  itemId: string;
  workItem: number;
  attempt: number;
  revision: number;
  mode: "regular-prs" | "native-stacks";
  position: number;
  parentItemId?: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  pullRequest: number;
  capabilityVersion: string;
  exactHeadValidation: ExactHeadValidationEvidence;
  state: "published" | "stack-linked" | "validation-invalidated";
  stackNumber?: number;
  invalidatedByItem?: string;
  invalidatedByHeadSha?: string;
}

export interface PublicationReceiptStore {
  read(runId: string, itemId: string): Promise<PublicationReceipt | null>;
  write(receipt: PublicationReceipt): Promise<void>;
}

export interface StackDeliveryProvider {
  ensureStack(pullRequests: readonly number[]): Promise<GitHubStack>;
  requestMerge(args: {
    pullRequest: number;
    expectedHeadSha: string;
    title: string;
    action: "default" | "direct_merge" | "merge_queue";
  }): Promise<AsyncMergeResult>;
  mergeResult(
    pullRequest: number,
    uuid: string,
    expectedHeadSha: string,
  ): Promise<AsyncMergeResult>;
  unstack(stackNumber: number): Promise<void>;
}

function assertMergeResultHead(result: AsyncMergeResult, expectedHeadSha: string): void {
  if (
    result.state !== "failed" &&
    result.state !== "merged" &&
    result.expectedHeadSha !== expectedHeadSha
  ) {
    throw new Error("delivery provider returned integration state for a stale head");
  }
}

function samePublication(a: PublicationReceipt, b: PublicationReceipt): boolean {
  return (
    a.protocol === b.protocol &&
    a.runId === b.runId &&
    a.unitId === b.unitId &&
    a.itemId === b.itemId &&
    a.workItem === b.workItem &&
    a.attempt === b.attempt &&
    a.mode === b.mode &&
    a.position === b.position &&
    a.parentItemId === b.parentItemId &&
    a.branch === b.branch &&
    a.baseBranch === b.baseBranch &&
    a.baseSha === b.baseSha &&
    a.headSha === b.headSha &&
    a.pullRequest === b.pullRequest &&
    a.capabilityVersion === b.capabilityVersion &&
    a.exactHeadValidation.digest === b.exactHeadValidation.digest
  );
}

function assertReceipt(receipt: PublicationReceipt): void {
  if (
    receipt.protocol !== PUBLICATION_RECEIPT_PROTOCOL ||
    !receipt.runId ||
    !receipt.unitId ||
    !receipt.itemId ||
    receipt.workItem < 1 ||
    receipt.attempt < 1 ||
    receipt.revision < 1 ||
    receipt.position < 0 ||
    receipt.pullRequest < 1
  ) {
    throw new Error("publication receipt identity is invalid");
  }
  verifyExactHeadValidation(receipt.exactHeadValidation, receipt.headSha);
  if (receipt.position === 0 && receipt.parentItemId) {
    throw new Error("bottom publication receipt cannot name a parent");
  }
  if (receipt.position > 0 && !receipt.parentItemId) {
    throw new Error("higher publication receipt must name its parent");
  }
  if (
    receipt.state === "stack-linked" &&
    receipt.mode === "native-stacks" &&
    !receipt.stackNumber
  ) {
    throw new Error("linked native-stack receipt has no stack number");
  }
  if (
    receipt.state === "validation-invalidated" &&
    (!receipt.invalidatedByItem || !receipt.invalidatedByHeadSha)
  ) {
    throw new Error("invalidated publication receipt has no cause");
  }
}

/**
 * Fail closed when an issue comment cannot prove the complete immutable
 * publication identity reconstructed from GitHub and validation evidence.
 */
export function assertPublicationEventMatchesReceipt(
  event: PublicationEvent,
  receipt: PublicationReceipt,
): void {
  const mismatches = [
    ["runId", event.runId, receipt.runId],
    ["workItem", event.workItem, receipt.workItem],
    ["attempt", event.attempt, receipt.attempt],
    ["unitId", event.unitId, receipt.unitId],
    ["itemId", event.itemId, receipt.itemId],
    ["mode", event.mode, receipt.mode],
    ["position", event.position, receipt.position],
    ["parentItemId", event.parentItemId, receipt.parentItemId],
    ["branch", event.branch, receipt.branch],
    ["baseBranch", event.baseBranch, receipt.baseBranch],
    ["baseSha", event.baseSha, receipt.baseSha],
    ["headSha", event.headSha, receipt.headSha],
    ["pullRequest", event.pullRequest, receipt.pullRequest],
    ["capabilityVersion", event.capabilityVersion, receipt.capabilityVersion],
    ["validationDigest", event.validationDigest, receipt.exactHeadValidation.validationDigest],
    [
      "exactHeadValidationDigest",
      event.exactHeadValidationDigest,
      receipt.exactHeadValidation.digest,
    ],
  ].filter(([, observed, expected]) => observed !== expected);
  if (mismatches.length > 0) {
    throw new Error(
      `durable publication event differs from reconstructed receipt: ${mismatches
        .map(([field]) => field)
        .join(", ")}`,
    );
  }
}

/** Provider-neutral, receipt-backed stack publication and integration state. */
export class StackManager {
  constructor(
    private readonly receipts: PublicationReceiptStore,
    private readonly provider: StackDeliveryProvider,
  ) {}

  async recordPublication(candidate: PublicationReceipt): Promise<PublicationReceipt> {
    assertReceipt(candidate);
    const existing = await this.receipts.read(candidate.runId, candidate.itemId);
    if (existing) {
      assertReceipt(existing);
      if (samePublication(existing, candidate) && existing.state === candidate.state) {
        return existing;
      }
      const repairsInvalidation =
        existing.state === "validation-invalidated" &&
        candidate.state === "published" &&
        candidate.revision === existing.revision + 1 &&
        candidate.headSha !== existing.headSha;
      if (!repairsInvalidation) {
        throw new Error(`publication receipt for ${candidate.itemId} conflicts with durable state`);
      }
    }
    await this.receipts.write(candidate);
    return candidate;
  }

  /**
   * Link a fully published unit. Re-running after a lost stack or receipt
   * response is safe: the provider and each receipt write are idempotent.
   */
  async linkUnit(
    selection: DeliverySelection,
    runId: string,
    expectedItems: readonly string[],
  ): Promise<PublicationReceipt[]> {
    if (selection.selected === "escalate") {
      throw new Error(`delivery selection requires escalation: ${selection.reason}`);
    }
    const members: PublicationReceipt[] = [];
    for (const itemId of expectedItems) {
      const receipt = await this.receipts.read(runId, itemId);
      if (!receipt) throw new Error(`publication receipt for ${itemId} is missing`);
      assertReceipt(receipt);
      members.push(receipt);
    }
    members.sort((a, b) => a.position - b.position || a.itemId.localeCompare(b.itemId));
    const runIds = new Set(members.map((member) => member.runId));
    const units = new Set(members.map((member) => member.unitId));
    if (runIds.size !== 1 || units.size !== 1) {
      throw new Error("publication unit receipts do not share one run and unit");
    }
    if (
      members.length !== expectedItems.length ||
      members.some(
        (member, index) => member.itemId !== expectedItems[index] || member.position !== index,
      )
    ) {
      throw new Error("publication unit receipt order differs from the immutable delivery plan");
    }
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index]!;
      if (member.capabilityVersion !== selection.capabilityVersion) {
        throw new Error("publication capability version differs from delivery selection");
      }
      const expectedMode = selection.selected === "native-stacks" ? "native-stacks" : "regular-prs";
      if (member.mode !== expectedMode) {
        throw new Error("publication receipt mode differs from immutable delivery selection");
      }
      if (index > 0) {
        const parent = members[index - 1]!;
        if (member.parentItemId !== parent.itemId || member.baseBranch !== parent.branch) {
          throw new Error("published pull requests do not form the planned linear base chain");
        }
      }
    }
    if (selection.selected === "regular-prs" || members.length === 1) {
      return members;
    }
    const stack = await this.provider.ensureStack(members.map((member) => member.pullRequest));
    const updated: PublicationReceipt[] = [];
    for (const member of members) {
      if (member.state === "stack-linked" && member.stackNumber !== stack.number) {
        throw new Error("durable publication receipt names a different GitHub stack");
      }
      const linked: PublicationReceipt = {
        ...member,
        revision:
          member.state === "stack-linked" && member.stackNumber === stack.number
            ? member.revision
            : member.revision + 1,
        state: "stack-linked",
        stackNumber: stack.number,
      };
      const current = await this.receipts.read(member.runId, member.itemId);
      if (current?.state !== "stack-linked" || current.stackNumber !== stack.number) {
        await this.receipts.write(linked);
      }
      updated.push(current?.state === "stack-linked" ? current : linked);
    }
    return updated;
  }

  /** Invalidate every transitive descendant before another publication/merge. */
  async invalidateDescendants(args: {
    receipts: readonly PublicationReceipt[];
    changedItemId: string;
    changedHeadSha: string;
  }): Promise<PublicationReceipt[]> {
    const children = new Map<string, PublicationReceipt[]>();
    for (const receipt of args.receipts) {
      if (!receipt.parentItemId) continue;
      const values = children.get(receipt.parentItemId) ?? [];
      values.push(receipt);
      children.set(receipt.parentItemId, values);
    }
    const queue = [...(children.get(args.changedItemId) ?? [])];
    const invalidated: PublicationReceipt[] = [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const receipt = queue.shift()!;
      if (seen.has(receipt.itemId)) continue;
      seen.add(receipt.itemId);
      queue.push(...(children.get(receipt.itemId) ?? []));
      if (
        receipt.state === "validation-invalidated" &&
        receipt.invalidatedByItem === args.changedItemId &&
        receipt.invalidatedByHeadSha === args.changedHeadSha
      ) {
        invalidated.push(receipt);
        continue;
      }
      const next: PublicationReceipt = {
        ...receipt,
        revision: receipt.revision + 1,
        state: "validation-invalidated",
        invalidatedByItem: args.changedItemId,
        invalidatedByHeadSha: args.changedHeadSha,
      };
      await this.receipts.write(next);
      invalidated.push(next);
    }
    return invalidated.sort((a, b) => a.position - b.position || a.itemId.localeCompare(b.itemId));
  }

  beginIntegration(args: {
    operationId: string;
    unitId: string;
    repositoryEpoch: number;
    members: readonly PublicationReceipt[];
    existing?: IntegrationLease;
  }): IntegrationLease {
    const expectedHeads: Record<string, string> = {};
    const evidence: Record<string, ExactHeadValidationEvidence> = {};
    for (const member of args.members) {
      assertReceipt(member);
      if (member.state === "validation-invalidated") {
        throw new Error(`Work Item ${member.itemId} needs exact-head revalidation`);
      }
      expectedHeads[String(member.pullRequest)] = member.headSha;
      evidence[String(member.pullRequest)] = member.exactHeadValidation;
    }
    return acquireIntegrationLease({
      operationId: args.operationId,
      unitId: args.unitId,
      repositoryEpoch: args.repositoryEpoch,
      expectedHeads,
      evidence,
      ...(args.existing ? { existing: args.existing } : {}),
    });
  }

  async integrate(args: {
    lease: IntegrationLease;
    members: readonly PublicationReceipt[];
    merge: "bottom-up" | "atomic-stack";
    title: string;
    action?: "default" | "direct_merge" | "merge_queue";
    idempotencyKey: string;
  }): Promise<IntegrationLease> {
    const ordered = [...args.members].sort((a, b) => a.position - b.position);
    const observedHeads = Object.fromEntries(
      ordered.map((member) => [String(member.pullRequest), member.headSha]),
    );
    assertIntegrationHeads(args.lease, observedHeads);
    const target = args.merge === "atomic-stack" ? ordered.at(-1) : ordered[0];
    if (!target) throw new Error("cannot integrate an empty delivery unit");
    const result = await this.provider.requestMerge({
      pullRequest: target.pullRequest,
      expectedHeadSha: target.headSha,
      title: args.title,
      action: args.action ?? "default",
    });
    assertMergeResultHead(result, target.headSha);
    return this.#applyMergeResult(args.lease, result, args.idempotencyKey);
  }

  async recoverIntegration(args: {
    lease: IntegrationLease;
    pullRequest: number;
    idempotencyKey: string;
  }): Promise<IntegrationLease> {
    if (!args.lease.asynchronousMergeUuid) return args.lease;
    const expectedHeadSha = args.lease.expectedHeads[String(args.pullRequest)];
    if (!expectedHeadSha) {
      throw new Error("integration recovery pull request is absent from its lease");
    }
    const result = await this.provider.mergeResult(
      args.pullRequest,
      args.lease.asynchronousMergeUuid,
      expectedHeadSha,
    );
    assertMergeResultHead(result, expectedHeadSha);
    return this.#applyMergeResult(args.lease, result, args.idempotencyKey);
  }

  async rollback(
    lease: IntegrationLease,
    stackNumber: number,
    idempotencyKey: string,
  ): Promise<IntegrationLease> {
    if (lease.state === "rolled-back") return lease;
    await this.provider.unstack(stackNumber);
    const cancelled =
      lease.state === "cancelled"
        ? lease
        : applyIntegrationCommand(lease, {
            kind: "cancel",
            idempotencyKey: `${idempotencyKey}/cancel`,
          });
    return applyIntegrationCommand(cancelled, { kind: "rollback", idempotencyKey });
  }

  #applyMergeResult(
    lease: IntegrationLease,
    result: AsyncMergeResult,
    idempotencyKey: string,
  ): IntegrationLease {
    if (
      result.state === "pending" &&
      lease.state === "pending" &&
      lease.asynchronousMergeUuid === result.uuid
    ) {
      return lease;
    }
    if (result.state === "queued" && lease.state === "pending") return lease;
    if (result.state === "merged") {
      return applyIntegrationCommand(lease, { kind: "complete", idempotencyKey });
    }
    if (result.state === "failed") {
      return applyIntegrationCommand(lease, {
        kind: "fail",
        idempotencyKey,
        reason: result.reason,
      });
    }
    if (result.state === "queued") {
      // GitHub already owns the merge-queue operation but does not expose a
      // poll UUID in this response. Keep the lease pending and reconcile from
      // live PR state on the next controller cycle.
      return applyIntegrationCommand(lease, { kind: "queued", idempotencyKey });
    }
    return applyIntegrationCommand(lease, {
      kind: "pending",
      idempotencyKey,
      uuid: result.uuid,
    });
  }
}
