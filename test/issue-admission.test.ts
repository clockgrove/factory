import { describe, expect, it } from "vitest";
import {
  IssueAdmissionLedger,
  type IssueAdmissionIdentity,
  type IssueAdmissionEvidence,
} from "../src/control/issue-admission.js";
import type { GitCommitObject } from "../src/control/lease.js";
const sha = (n: number) => n.toString(16).padStart(40, "0");
function fixture() {
  let next = 100;
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  commits.set(sha(1), {
    oid: sha(1),
    treeOid: sha(2),
    parentOids: [],
    message: "base",
    serverTime: new Date(),
  });
  const store = {
    readRef: async (ref: string) => refs.get(ref) ?? null,
    readCommit: async (oid: string) => {
      const commit = commits.get(oid);
      if (!commit) throw Error("missing");
      return commit;
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
  const identity: IssueAdmissionIdentity = {
    workItem: 10,
    workItemNodeId: "I_10",
    objective: 20,
    runId: "run-a",
    directorEpoch: 1,
    writerHolder: "holder-a",
    policyDigest: "policy",
    graphDigest: "graph",
    graphCommitOid: sha(3),
    projectionCommitOid: sha(4),
    reservation: {
      ref: "refs/clockgrove-factory/attempts/a",
      oid: sha(5),
      attempt: 1,
      backend: "local",
      baseSha: sha(1),
    },
    capacityReservationId: "capacity-a",
    budgetReservationId: "budget-a",
    resourceIdentity: "resource-a",
    compatibilityClaimOid: sha(6),
  };
  const assertCurrent = async () => {};
  const ledger = new IssueAdmissionLedger(store);
  const proof: IssueAdmissionEvidence = {
    reservationOid: sha(5),
    resourceIdentity: "resource-a",
    capacityReservationId: "capacity-a",
    budgetReservationId: "budget-a",
    producerStopped: true,
    resourcesReleased: true,
    capacityReleased: true,
    accountingSettled: true,
    evidenceOid: sha(7),
  };
  const transition = (
    disposition: "dispatching" | "terminal" | "reconciled" | "released",
    evidence?: IssueAdmissionEvidence,
  ) =>
    ledger.transition({
      workItem: 10,
      reservationOid: sha(5),
      objective: 20,
      runId: "run-a",
      directorEpoch: 1,
      writerHolder: "holder-a",
      policyDigest: "policy",
      disposition,
      assertCurrent,
      ...(evidence ? { evidence } : {}),
    });
  return { ledger, store, refs, commits, identity, assertCurrent, proof, transition };
}
describe("issue scoped admission CAS", () => {
  it.each([true, false])("one winner across simultaneous same/cross objective=%s", async (same) => {
    const f = fixture();
    const other = {
      ...f.identity,
      objective: same ? 20 : 21,
      runId: same ? "run-a" : "run-b",
      reservation: { ...f.identity.reservation, oid: sha(8) },
    };
    const outcomes = await Promise.allSettled([
      f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent }),
      f.ledger.admit({ ...other, assertCurrent: f.assertCurrent }),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
  it("retains metadata as Git parents and lost response replay only prepares once", async () => {
    const f = fixture();
    const a = await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    expect(f.commits.get(a.oid)!.parentOids).toEqual([sha(1), sha(5)]);
    expect((await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent })).oid).toBe(
      a.oid,
    );
    await f.transition("dispatching");
    await expect(f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent })).rejects.toThrow(
      "rearmed",
    );
    await expect(f.transition("dispatching")).rejects.toThrow("replayed");
  });
  it("unknown dispatch stays occupied; positive exact proof required", async () => {
    const f = fixture();
    await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    await f.transition("dispatching");
    await expect(f.transition("released")).rejects.toThrow();
    await expect(
      f.transition("released", { ...f.proof, resourceIdentity: "other" }),
    ).rejects.toThrow("exact");
    await expect(
      f.ledger.admit({
        ...f.identity,
        reservation: { ...f.identity.reservation, attempt: 2, oid: sha(8) },
        assertCurrent: f.assertCurrent,
      }),
    ).rejects.toThrow("occupied");
    const released = await f.transition("released", f.proof);
    expect((await f.transition("released", f.proof)).oid).toBe(released.oid);
    await expect(f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent })).rejects.toThrow(
      "rearmed",
    );
  });
  it("retains monotonic attempts and requires explicit new run reassignment", async () => {
    const f = fixture();
    await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    await f.transition("released", f.proof);
    const retry = {
      ...f.identity,
      reservation: { ...f.identity.reservation, attempt: 2, oid: sha(8) },
      assertCurrent: f.assertCurrent,
    };
    await expect(f.ledger.admit({ ...retry, runId: "run-b" })).rejects.toThrow("explicit");
    const next = await f.ledger.reassign({ ...retry, runId: "run-b", authorityReceiptOid: sha(9) });
    expect(next.history.map((x) => x.reservation.attempt)).toEqual([1, 2]);
    expect(f.commits.get(next.oid)!.parentOids).toEqual([next.priorRevisionOid, sha(8), sha(9)]);
  });
  it("fences queued stale writers and never borrows another owner", async () => {
    const f = fixture();
    let checks = 0;
    await expect(
      f.ledger.admit({
        ...f.identity,
        assertCurrent: async () => {
          if (++checks === 3) throw Error("stale queued actor");
        },
      }),
    ).rejects.toThrow("stale");
    expect(await f.ledger.read(10)).toBeNull();
    await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    await expect(
      f.ledger.transition({
        workItem: 10,
        reservationOid: sha(5),
        objective: 21,
        runId: "other",
        directorEpoch: 2,
        writerHolder: "holder-b",
        policyDigest: "policy",
        disposition: "released",
        evidence: f.proof,
        assertCurrent: f.assertCurrent,
      }),
    ).rejects.toThrow("authority");
  });
  it("imports unknown identities occupied and preserves response loss identity", async () => {
    const f = fixture();
    const args = {
      workItem: 10,
      workItemNodeId: "I_10",
      compatibilityClaimOid: sha(6),
      history: [f.identity],
      assertCurrent: f.assertCurrent,
    };
    const imported = await f.ledger.importLegacy(args);
    expect(imported.history[0]!.disposition).toBe("dispatching");
    expect((await f.ledger.importLegacy(args)).oid).toBe(imported.oid);
    await expect(f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent })).rejects.toThrow(
      "rearmed",
    );
  });
  it("higher epoch reconciliation preserves original epoch and fences the displaced writer", async () => {
    const f = fixture();
    await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    const recovered = await f.ledger.transition({
      workItem: 10,
      reservationOid: sha(5),
      objective: 20,
      runId: "run-a",
      directorEpoch: 2,
      writerHolder: "holder-b",
      policyDigest: "policy",
      disposition: "reconciled",
      evidence: f.proof,
      assertCurrent: f.assertCurrent,
    });
    expect(recovered.history[0]!.directorEpoch).toBe(1);
    expect(recovered.history[0]!.writerEpoch).toBe(2);
    await expect(f.transition("released", f.proof)).rejects.toThrow("authority");
    await expect(
      f.ledger.transition({
        workItem: 10,
        reservationOid: sha(5),
        objective: 20,
        runId: "run-a",
        directorEpoch: 2,
        writerHolder: "holder-b",
        policyDigest: "policy",
        disposition: "terminal",
        assertCurrent: f.assertCurrent,
      }),
    ).rejects.toThrow("regress");
  });
  it("retains settlement proof and records a higher writer for an identical terminal state", async () => {
    const f = fixture();
    await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    await f.transition("terminal");
    const recovered = await f.ledger.transition({
      workItem: 10,
      reservationOid: sha(5),
      objective: 20,
      runId: "run-a",
      directorEpoch: 2,
      writerHolder: "holder-b",
      policyDigest: "policy",
      disposition: "terminal",
      assertCurrent: f.assertCurrent,
    });
    expect(recovered.history[0]!.writerEpoch).toBe(2);
    await expect(f.transition("released", f.proof)).rejects.toThrow("authority");
    const released = await f.ledger.transition({
      workItem: 10,
      reservationOid: sha(5),
      objective: 20,
      runId: "run-a",
      directorEpoch: 2,
      writerHolder: "holder-b",
      policyDigest: "policy",
      disposition: "released",
      evidence: f.proof,
      assertCurrent: f.assertCurrent,
    });
    expect(f.commits.get(released.oid)!.parentOids).toEqual([recovered.oid, f.proof.evidenceOid]);
  });
  it("does not grant a higher epoch permission to dispatch the original prepared identity", async () => {
    const f = fixture();
    await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    await expect(
      f.ledger.transition({
        workItem: 10,
        reservationOid: sha(5),
        objective: 20,
        runId: "run-a",
        directorEpoch: 2,
        writerHolder: "holder-b",
        policyDigest: "policy",
        disposition: "dispatching",
        assertCurrent: f.assertCurrent,
      }),
    ).rejects.toThrow("replayed");
  });
  it("rejects mismatched immutable commit read responses", async () => {
    const f = fixture();
    const record = await f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent });
    f.commits.set(record.oid, { ...f.commits.get(record.oid)!, oid: sha(99) });
    await expect(f.ledger.read(10)).rejects.toThrow("OID changed");
  });
  it("terminal records preserve whether dispatch was ever possible", async () => {
    const untouched = fixture();
    await untouched.ledger.admit({ ...untouched.identity, assertCurrent: untouched.assertCurrent });
    expect((await untouched.transition("terminal")).history[0]!.dispatchPossible).toBe(false);
    const dispatched = fixture();
    await dispatched.ledger.admit({
      ...dispatched.identity,
      assertCurrent: dispatched.assertCurrent,
    });
    await dispatched.transition("dispatching");
    expect((await dispatched.transition("terminal")).history[0]!.dispatchPossible).toBe(true);
    expect(
      (await dispatched.transition("released", dispatched.proof)).history[0]!.dispatchPossible,
    ).toBe(true);
  });
  it("independent issues admit without sharing a ledger", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.ledger.admit({ ...f.identity, assertCurrent: f.assertCurrent }),
      f.ledger.admit({
        ...f.identity,
        workItem: 11,
        workItemNodeId: "I_11",
        assertCurrent: f.assertCurrent,
      }),
    ]);
    expect(results[0]!.ref).not.toBe(results[1]!.ref);
  });
});
