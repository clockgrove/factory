import { describe, expect, it } from "vitest";

import {
  acquireIntegrationLease,
  applyIntegrationCommand,
  assertIntegrationHeads,
  undoIntegrationCommand,
} from "../src/publication/integration-lease.js";
import {
  PUBLICATION_RECEIPT_PROTOCOL,
  StackManager,
  type PublicationReceipt,
  type PublicationReceiptStore,
  type StackDeliveryProvider,
} from "../src/publication/stack-manager.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => value.repeat(40);
const binding = (head: string) =>
  bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: "a".repeat(64),
      baseSha: sha("b"),
      outputTreeSha: sha("c"),
    },
    publishedHeadSha: head,
    publishedTreeSha: sha("c"),
    publishedBaseSha: sha("b"),
  });

function lease() {
  return acquireIntegrationLease({
    operationId: "operation-1",
    unitId: "delivery/a",
    repositoryEpoch: 7,
    expectedHeads: { "1": sha("d"), "2": sha("e") },
    evidence: { "1": binding(sha("d")), "2": binding(sha("e")) },
  });
}

describe("fenced integration recovery", () => {
  it("rejects a stale head even when every other pull request is unchanged", () => {
    expect(() =>
      assertIntegrationHeads(lease(), { "1": sha("d"), "2": sha("f") }),
    ).toThrow("stale or incomplete");
  });

  it("makes retry and cancellation idempotent and each command reversible", () => {
    const failed = applyIntegrationCommand(lease(), {
      kind: "fail",
      idempotencyKey: "failure-1",
      reason: "merge queue ejected stack",
    });
    const retried = applyIntegrationCommand(failed, {
      kind: "retry",
      idempotencyKey: "retry-1",
      expectedHeads: { "1": sha("d"), "2": sha("f") },
      evidence: { "1": binding(sha("d")), "2": binding(sha("f")) },
    });
    expect(retried).toMatchObject({ state: "acquired", attempt: 2 });
    expect(
      applyIntegrationCommand(retried, {
        kind: "retry",
        idempotencyKey: "retry-1",
        expectedHeads: { "1": sha("d"), "2": sha("f") },
        evidence: { "1": binding(sha("d")), "2": binding(sha("f")) },
      }),
    ).toBe(retried);
    expect(() =>
      applyIntegrationCommand(retried, {
        kind: "retry",
        idempotencyKey: "retry-1",
        expectedHeads: { "1": sha("d"), "2": sha("9") },
        evidence: { "1": binding(sha("d")), "2": binding(sha("9")) },
      }),
    ).toThrow(/idempotency key/);
    expect(undoIntegrationCommand(retried, "retry-1")).toEqual(failed);
    const cancelled = applyIntegrationCommand(retried, {
      kind: "cancel",
      idempotencyKey: "cancel-1",
    });
    expect(applyIntegrationCommand(cancelled, { kind: "cancel", idempotencyKey: "cancel-1" })).toBe(cancelled);
    expect(undoIntegrationCommand(cancelled, "cancel-1")).toEqual(retried);
  });

  it("recovers pending, merge-queue, asynchronous completion, and rollback states", async () => {
    let result: Awaited<ReturnType<StackDeliveryProvider["requestMerge"]>> = {
      state: "pending",
      uuid: "async-1",
      expectedHeadSha: sha("e"),
      mergeAction: "merge_queue",
    };
    let unstacked = 0;
    const provider: StackDeliveryProvider = {
      ensureStack: async () => ({ number: 4, baseRef: "main", open: true, pullRequests: [] }),
      requestMerge: async () => result,
      mergeResult: async () => result,
      unstack: async () => { unstacked += 1; },
    };
    const store: PublicationReceiptStore = {
      read: async () => null,
      write: async () => {},
    };
    const members: PublicationReceipt[] = [
      {
        protocol: PUBLICATION_RECEIPT_PROTOCOL,
        runId: "run-1",
        unitId: "delivery/a",
        itemId: "a",
        workItem: 1,
        attempt: 1,
        revision: 1,
        mode: "native-stacks",
        position: 0,
        branch: "branch-a",
        baseBranch: "main",
        baseSha: sha("b"),
        headSha: sha("d"),
        pullRequest: 1,
        capabilityVersion: "2026-03-10",
        exactHeadValidation: binding(sha("d")),
        state: "stack-linked",
        stackNumber: 4,
      },
      {
        protocol: PUBLICATION_RECEIPT_PROTOCOL,
        runId: "run-1",
        unitId: "delivery/a",
        itemId: "b",
        workItem: 2,
        attempt: 1,
        revision: 1,
        mode: "native-stacks",
        position: 1,
        parentItemId: "a",
        branch: "branch-b",
        baseBranch: "branch-a",
        baseSha: sha("b"),
        headSha: sha("e"),
        pullRequest: 2,
        capabilityVersion: "2026-03-10",
        exactHeadValidation: binding(sha("e")),
        state: "stack-linked",
        stackNumber: 4,
      },
    ];
    const manager = new StackManager(store, provider);
    const acquired = manager.beginIntegration({
      operationId: "operation-1",
      unitId: "delivery/a",
      repositoryEpoch: 7,
      members,
    });
    const pending = await manager.integrate({
      lease: acquired,
      members,
      merge: "atomic-stack",
      title: "Factory stack",
      action: "merge_queue",
      idempotencyKey: "merge-1",
    });
    expect(pending).toMatchObject({ state: "pending", asynchronousMergeUuid: "async-1" });
    result = { state: "merged", mergeSha: sha("9") };
    const completed = await manager.recoverIntegration({
      lease: pending,
      pullRequest: 2,
      idempotencyKey: "merge-complete-1",
    });
    expect(completed.state).toBe("completed");

    const failed = applyIntegrationCommand(acquired, {
      kind: "fail",
      idempotencyKey: "fail-rollback",
      reason: "rebase failed",
    });
    const rolledBack = await manager.rollback(failed, 4, "rollback-1");
    expect(rolledBack.state).toBe("rolled-back");
    expect((await manager.rollback(rolledBack, 4, "rollback-1")).state).toBe("rolled-back");
    expect(unstacked).toBe(1);
  });

  it("rejects provider state and recovery requests outside the exact-head lease", async () => {
    const provider: StackDeliveryProvider = {
      ensureStack: async () => ({
        number: 4,
        baseRef: "main",
        open: true,
        pullRequests: [],
      }),
      requestMerge: async () => ({
        state: "queued",
        expectedHeadSha: sha("f"),
      }),
      mergeResult: async () => ({
        state: "queued",
        expectedHeadSha: sha("f"),
      }),
      unstack: async () => {},
    };
    const manager = new StackManager(
      { read: async () => null, write: async () => {} },
      provider,
    );
    const value = acquireIntegrationLease({
      operationId: "operation-stale",
      unitId: "delivery/a",
      repositoryEpoch: 7,
      expectedHeads: { "1": sha("d") },
      evidence: { "1": binding(sha("d")) },
    });
    const members = [
      {
        protocol: PUBLICATION_RECEIPT_PROTOCOL,
        runId: "run-1",
        unitId: "delivery/a",
        itemId: "a",
        workItem: 1,
        attempt: 1,
        revision: 1,
        mode: "native-stacks" as const,
        position: 0,
        branch: "branch-a",
        baseBranch: "main",
        baseSha: sha("b"),
        headSha: sha("d"),
        pullRequest: 1,
        capabilityVersion: "2026-03-10",
        exactHeadValidation: binding(sha("d")),
        state: "stack-linked" as const,
        stackNumber: 4,
      },
    ];
    await expect(
      manager.integrate({
        lease: value,
        members,
        merge: "bottom-up",
        title: "Factory stack",
        idempotencyKey: "merge-stale",
      }),
    ).rejects.toThrow(/stale head/);
    const pending = applyIntegrationCommand(value, {
      kind: "pending",
      idempotencyKey: "pending-1",
      uuid: "async-1",
    });
    await expect(
      manager.recoverIntegration({
        lease: pending,
        pullRequest: 999,
        idempotencyKey: "recover-unknown",
      }),
    ).rejects.toThrow(/absent from its lease/);
  });
});
