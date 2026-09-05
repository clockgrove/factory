import { describe, expect, it, vi } from "vitest";
import { LifecycleRecorder } from "../src/control/events.js";
import type { AttemptReservation } from "../src/control/attempts.js";
import type { LeaseManager, LeaseState } from "../src/control/lease.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { createValidationEvidence } from "../src/validation/evidence.js";

const now = new Date("2026-09-04T00:00:00.000Z");
function fixture() {
  const lease: LeaseState = {
    objective: 7,
    runId: "current",
    holder: "operator",
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    ref: "lease",
    oid: "a".repeat(40),
    treeOid: "b".repeat(40),
    epoch: 2,
    sequence: 20,
    expiresAt: now,
  };
  const reservation: AttemptReservation = {
    objective: 7,
    runId: "current",
    workItem: 8,
    attempt: 1,
    backend: "codex-sdk/local-worktree",
    policyDigest: lease.policyDigest,
    directorEpoch: 2,
    ref: "reservation",
    oid: "c".repeat(40),
    baseSha: "d".repeat(40),
    sequence: 2,
    createdAt: now,
  };
  const store = { addIssueComment: vi.fn(async () => {}), serverTime: vi.fn(async () => now) };
  const assertCurrent = vi.fn(async () => {});
  const recorder = new LifecycleRecorder(store, { assertCurrent } as unknown as LeaseManager);
  const invoke = (kind: string) =>
    kind === "validation"
      ? recorder.validation({
          lease,
          reservation,
          workItemNodeId: "issue-8",
          sequence: 21,
          evidence: createValidationEvidence({
            protocol: "clockgrove.factory/validation-v1",
            artifactDigest: "e".repeat(64),
            baseSha: reservation.baseSha,
            outputTreeSha: "f".repeat(40),
            commands: [],
            passed: true,
            startedAt: now.toISOString(),
            completedAt: now.toISOString(),
          }),
        })
      : recorder.budget({
          lease,
          reservation,
          workItemNodeId: "issue-8",
          sequence: 21,
          event: "BudgetReconciled",
          unit: "model_tokens",
          amount: 10,
        });
  return { lease, reservation, store, assertCurrent, invoke };
}

describe("validation and accounting source-reservation fences", () => {
  for (const kind of ["validation", "budget"]) {
    it.each(["run", "objective", "policy", "future-epoch", "invalid-epoch"])(
      `${kind} rejects %s mismatch before any receipt write`,
      async (change) => {
        const f = fixture();
        if (change === "run") f.reservation.runId = "terminal-predecessor";
        if (change === "objective") f.reservation.objective = 9;
        if (change === "policy") f.reservation.policyDigest = "9".repeat(64);
        if (change === "future-epoch") f.reservation.directorEpoch = 3;
        if (change === "invalid-epoch") f.reservation.directorEpoch = 0;
        await expect(f.invoke(kind)).rejects.toThrow(/fenced/);
        expect(f.assertCurrent).toHaveBeenCalledExactlyOnceWith(f.lease);
        expect(f.store.serverTime).not.toHaveBeenCalled();
        expect(f.store.addIssueComment).not.toHaveBeenCalled();
      },
    );
    it.each([1, 2])(
      `${kind} preserves same-run evidence under epoch %s reservation`,
      async (epoch) => {
        const f = fixture();
        f.reservation.directorEpoch = epoch;
        await expect(f.invoke(kind)).resolves.toMatchObject({
          objective: 7,
          runId: "current",
          workItem: 8,
          attempt: 1,
        });
        expect(f.store.addIssueComment).toHaveBeenCalledOnce();
      },
    );
    it(`${kind} never writes after losing current lease ownership`, async () => {
      const f = fixture();
      f.assertCurrent.mockRejectedValue(new Error("lease lost"));
      await expect(f.invoke(kind)).rejects.toThrow("lease lost");
      expect(f.store.addIssueComment).not.toHaveBeenCalled();
    });
  }
});
