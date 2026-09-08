import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileAdmissionForSuccessor } from "../src/control/admission-reassignment.js";
import { IssueAdmissionLedger } from "../src/control/issue-admission.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { PROTOCOL_V2 } from "../src/protocol/limits.js";
import type { GitCommitObject } from "../src/control/lease.js";
import type { RecoveryRuntime } from "../src/recovery/runtime.js";
import { verifyRecoveryResources } from "../src/recovery/resources.js";
vi.mock("../src/recovery/resources.js", () => ({ verifyRecoveryResources: vi.fn() }));
const sha = (n: number) => n.toString(16).padStart(40, "0");
const digest = "a".repeat(64);
async function fixture() {
  let next = 100;
  const refs = new Map<string, string>([
    ["claim", sha(7)],
    ["plan", sha(8)],
  ]);
  const commits = new Map<string, GitCommitObject>(
    [1, 7, 8].map((n) => [
      sha(n),
      { oid: sha(n), treeOid: sha(2), parentOids: [], message: "base", serverTime: new Date() },
    ]),
  );
  const store = {
    readRef: async (ref: string) => refs.get(ref) ?? null,
    readCommit: async (oid: string) => {
      const value = commits.get(oid);
      if (!value) throw Error("missing commit");
      return value;
    },
    createCommit: async (args: { treeOid: string; parentOids: string[]; message: string }) => {
      const oid = sha(next++);
      commits.set(oid, { ...args, oid, serverTime: new Date() });
      return oid;
    },
    createRef: async (ref: string, oid: string) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
    compareAndSwapRef: async (args: { ref: string; beforeOid: string; afterOid: string }) => {
      if (refs.get(args.ref) !== args.beforeOid) return false;
      refs.set(args.ref, args.afterOid);
      return true;
    },
  };
  const ledger = new IssueAdmissionLedger(store);
  const identity = {
    workItem: 10,
    workItemNodeId: "I_10",
    objective: 20,
    runId: "old",
    directorEpoch: 5,
    writerHolder: "old-holder",
    policyDigest: digest,
    graphDigest: digest,
    graphCommitOid: sha(3),
    projectionCommitOid: sha(4),
    reservation: {
      ref: "attempt",
      oid: sha(5),
      attempt: 1,
      backend: "codex-cli/local-worktree",
      baseSha: sha(1),
    },
    capacityReservationId: "capacity",
    budgetReservationId: "budget",
    resourceIdentity: "resource",
    compatibilityClaimOid: sha(6),
  };
  const assertCurrent = vi.fn(async () => {});
  await ledger.admit({ ...identity, assertCurrent });
  await ledger.transition({
    workItem: 10,
    reservationOid: sha(5),
    objective: 20,
    runId: "old",
    directorEpoch: 5,
    writerHolder: "old-holder",
    policyDigest: digest,
    disposition: "dispatching",
    assertCurrent,
  });
  const common = {
    protocol: PROTOCOL_V2,
    objective: 20,
    runId: "old",
    workItem: 10,
    attempt: 1,
    at: "2026-09-08T00:00:00Z",
    directorEpoch: 5,
    policyDigest: digest,
  };
  const events = [
    parseFactoryEvent({
      ...common,
      kind: "attempt",
      event: "AttemptReserved",
      sequence: 1,
      backend: identity.reservation.backend,
      baseSha: sha(1),
    }),
    parseFactoryEvent({
      ...common,
      kind: "attempt",
      event: "AttemptFailed",
      sequence: 2,
      backend: identity.reservation.backend,
      baseSha: sha(1),
    }),
    ...["BudgetReserved", "BudgetReconciled"].map((event, i) =>
      parseFactoryEvent({
        ...common,
        kind: "budget",
        event,
        sequence: 3 + i,
        phase: "execution",
        unit: "local_milliseconds",
        amount: 10,
      }),
    ),
    parseFactoryEvent({
      ...common,
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 5,
      phase: "execution",
      unit: "model_tokens",
      amount: 10,
    }),
  ];
  const runtime = {
    status: "verified",
    adoptionVerified: true,
    controllingRun: {
      runId: "new",
      objective: 20,
      policyDigest: digest,
      recoveryPlanDigest: digest,
      recoveryRequestId: "request",
    },
    planRecord: {
      ref: "plan",
      commitOid: sha(8),
      digest,
      plan: {
        successorRunId: "new",
        objective: 20,
        policyDigest: digest,
        graph: { commitOid: sha(3), digest, projection: { commitOid: sha(4) } },
        items: [{ workItem: 10, issueNodeId: "I_10" }],
        history: [{ runId: "old", policyDigest: digest }],
      },
    },
    claim: {
      ref: "claim",
      oid: sha(7),
      successorRunId: "new",
      objective: 20,
      policyDigest: digest,
      planCommitOid: sha(8),
      planDigest: digest,
      requestId: "request",
    },
    graph: { commitOid: sha(3), graphDigest: digest },
    projection: { commitOid: sha(4), bindings: [{ issueNumber: 10, issueNodeId: "I_10" }] },
    sourceRunIds: ["old"],
    events,
    historicalAccounting: {
      unknownModelUsageCount: 0,
      unknownModelUsage: [],
      unreconciledReservationCount: 0,
      unreconciledReservations: [],
      blockerCount: 0,
      blockers: [],
      unreconciledReservationsTruncated: false,
      diagnosticsTruncated: false,
      attemptCountsTruncated: false,
    },
    currentUnknownModelUsageCount: 0,
    currentUnknownModelUsage: [],
  } as unknown as RecoveryRuntime;
  const args = {
    store: store as unknown as Parameters<typeof reconcileAdmissionForSuccessor>[0]["store"],
    ledger,
    runtime,
    lease: {
      objective: 20,
      runId: "new",
      policyDigest: digest,
      holder: "new-holder",
      epoch: 1,
      ref: "lease",
      oid: sha(9),
      treeOid: sha(2),
      sequence: 1,
      expiresAt: new Date(),
    },
    workItem: 10,
    workItemNodeId: "I_10",
    assertCurrent,
    assertCapacityReleased: vi.fn(async () => {}),
  };
  return { args, ledger, commits, refs, identity };
}
beforeEach(() =>
  vi
    .mocked(verifyRecoveryResources)
    .mockResolvedValue({ status: "verified", evidenceDigest: digest, blockers: [] }),
);
describe("accepted successor admission reassignment", () => {
  it("settles exact predecessor evidence without borrowing its epoch and permits explicit reassignment", async () => {
    const f = await fixture();
    expect(await reconcileAdmissionForSuccessor(f.args)).toEqual({ authorityReceiptOid: sha(7) });
    const record = await f.ledger.read(10);
    const old = record!.history[0]!;
    expect(old.disposition).toBe("released");
    expect(old.writerEpoch).toBe(5);
    expect(old.settledBySuccessor).toMatchObject({ runId: "new", directorEpoch: 1 });
    expect(f.commits.get(record!.oid)!.parentOids).toContain(old.evidence!.evidenceOid);
    const result = await f.ledger.reassign({
      ...f.identity,
      runId: "new",
      directorEpoch: 1,
      writerHolder: "new-holder",
      reservation: { ...f.identity.reservation, oid: sha(11), attempt: 2 },
      authorityReceiptOid: sha(7),
      assertCurrent: f.args.assertCurrent,
    });
    expect(result.history).toHaveLength(2);
  });
  it.each(["accounting", "resources", "capacity", "producer", "graph", "claim"])(
    "fails closed on %s uncertainty",
    async (kind) => {
      const f = await fixture();
      if (kind === "accounting") f.args.runtime.historicalAccounting.unknownModelUsageCount = 1;
      if (kind === "resources")
        vi.mocked(verifyRecoveryResources).mockResolvedValue({
          status: "blocked",
          evidenceDigest: null,
          blockers: ["unknown"],
        });
      if (kind === "capacity")
        f.args.assertCapacityReleased.mockRejectedValue(Error("active capacity"));
      if (kind === "producer")
        f.args.runtime.events = f.args.runtime.events.filter(
          (event) => event.event !== "AttemptFailed",
        );
      if (kind === "graph") f.args.runtime.planRecord.plan.graph.commitOid = sha(99);
      if (kind === "claim") f.refs.set("claim", sha(99));
      await expect(reconcileAdmissionForSuccessor(f.args)).rejects.toThrow();
      expect((await f.ledger.read(10))!.history[0]!.disposition).toBe("dispatching");
    },
  );
  it("does not let an ordinary lease transition settle another run", async () => {
    const f = await fixture();
    await expect(
      f.ledger.transition({
        workItem: 10,
        reservationOid: sha(5),
        objective: 20,
        runId: "new",
        directorEpoch: 99,
        writerHolder: "new-holder",
        policyDigest: digest,
        disposition: "released",
        assertCurrent: f.args.assertCurrent,
      }),
    ).rejects.toThrow("authority");
  });
});
