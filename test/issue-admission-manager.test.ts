import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AttemptManager,
  attemptRef,
  type AttemptAdmissionBinding,
  type AttemptReservation,
  type AttemptStore,
} from "../src/control/attempts.js";
import { LeaseManager, type GitCommitObject, type LeaseState } from "../src/control/lease.js";
import { issueAdmissionRef } from "../src/control/issue-admission.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const base: GitCommitObject = {
  oid: sha("base"),
  treeOid: sha("tree"),
  parentOids: [],
  message: "base",
  serverTime: new Date("2026-09-08T00:00:00Z"),
};
class Store implements AttemptStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([[base.oid, base]]);
  comments: Array<{ node: string; body: string }> = [];
  next = 1;
  loseLedgerCreate = false;
  loseLedgerCas = false;
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const value = this.commits.get(oid);
    if (!value) throw Error("missing commit");
    return structuredClone(value);
  }
  async listRefs(prefix: string) {
    return [...this.refs]
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, oid]) => ({ ref, oid }));
  }
  async createCommit(args: { treeOid: string; parentOids: string[]; message: string }) {
    const oid = sha(`commit-${this.next++}`);
    this.commits.set(oid, { ...structuredClone(args), oid, serverTime: base.serverTime });
    return oid;
  }
  async createRef(ref: string, oid: string) {
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    if (ref.startsWith("refs/clockgrove-factory/admission/") && this.loseLedgerCreate) {
      this.loseLedgerCreate = false;
      throw Error("lost ledger create response");
    }
    return true;
  }
  async compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }) {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    if (args.ref.startsWith("refs/clockgrove-factory/admission/") && this.loseLedgerCas) {
      this.loseLedgerCas = false;
      throw Error("lost ledger CAS response");
    }
    return true;
  }
  async serverTime() {
    return base.serverTime;
  }
  async addIssueComment(node: string, body: string) {
    this.comments.push({ node, body });
  }
}
const binding = (attempt: number): AttemptAdmissionBinding => ({
  graphDigest: "b".repeat(64),
  graphCommitOid: sha("graph"),
  projectionCommitOid: sha("projection"),
  capacityReservationId: `capacity-${attempt}`,
  budgetReservationId: `budget-${attempt}`,
  resourceIdentity: `resource-${attempt}`,
});
async function fixture() {
  const store = new Store(),
    leases = new LeaseManager({ store });
  const lease = await leases.acquire(
    { objective: 7, runId: "run-7", holder: "holder-7", policyDigest: "a".repeat(64) },
    base,
  );
  const manager = new AttemptManager({
    store,
    leases,
    legacyBinding: async (reservation) => binding(reservation.attempt),
  });
  const args = (owner: LeaseState = lease, workItem = 12) => ({
    lease: owner,
    workItem,
    workItemNodeId: `I_${workItem}`,
    backend: "codex-sdk/local-worktree",
    base,
    sequence: 10,
    binding: async (attempt: number) => binding(attempt),
  });
  return { store, leases, lease, manager, args };
}
async function release(f: Awaited<ReturnType<typeof fixture>>, reservation: AttemptReservation) {
  await f.manager.record({
    lease: f.lease,
    reservation,
    workItemNodeId: "I_12",
    event: "AttemptFailed",
    sequence: 11,
  });
  await f.manager.settle(f.lease, reservation, {
    reservationOid: reservation.oid,
    capacityReservationId: binding(reservation.attempt).capacityReservationId,
    budgetReservationId: binding(reservation.attempt).budgetReservationId,
    resourceIdentity: binding(reservation.attempt).resourceIdentity,
    producerStopped: true,
    resourcesReleased: true,
    capacityReleased: true,
    accountingSettled: true,
    evidenceOid: sha("settlement"),
  });
}
describe("production issue admission manager", () => {
  it.each([false, true])(
    "allows one concurrent reservation across same/different Objectives (%s)",
    async (different) => {
      const f = await fixture();
      const other = different
        ? await f.leases.acquire(
            { objective: 8, runId: "run-8", holder: "holder-8", policyDigest: "a".repeat(64) },
            base,
          )
        : f.lease;
      const contenders = await Promise.allSettled([
        f.manager.reserve(f.args()),
        f.manager.reserve(f.args(other)),
      ]);
      expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await f.manager.ledger.read(12))!.history).toHaveLength(1);
      expect(f.store.comments).toHaveLength(1);
    },
  );
  it("keeps different issues independent", async () => {
    const f = await fixture();
    const reservations = await Promise.all([
      f.manager.reserve(f.args()),
      f.manager.reserve(f.args(f.lease, 13)),
    ]);
    expect(reservations.map((value) => value.attempt)).toEqual([1, 1]);
    expect(f.store.refs.has(issueAdmissionRef(12))).toBe(true);
    expect(f.store.refs.has(issueAdmissionRef(13))).toBe(true);
  });
  it("retains admission after a lost create response without another reservation", async () => {
    const f = await fixture();
    f.store.loseLedgerCreate = true;
    await expect(f.manager.reserve(f.args())).rejects.toThrow(/lost ledger create/);
    await expect(f.manager.reserve(f.args())).rejects.toThrow(/occupied/);
    expect((await f.manager.ledger.read(12))!.history).toHaveLength(1);
    expect(await f.manager.list(7, 12)).toHaveLength(1);
    expect(f.store.comments).toHaveLength(0);
  });
  it("permits only the winning dispatch transition to launch", async () => {
    const f = await fixture(),
      reservation = await f.manager.reserve(f.args());
    let launches = 0;
    const dispatch = async () => {
      await f.manager.markDispatching(f.lease, reservation);
      launches++;
    };
    await Promise.allSettled([dispatch(), dispatch()]);
    expect(launches).toBe(1);
    await expect(dispatch()).rejects.toThrow(/replayed/);
    expect(launches).toBe(1);
  });
  it("does not replay launch after an applied dispatch CAS loses its response", async () => {
    const f = await fixture(),
      reservation = await f.manager.reserve(f.args());
    let launches = 0;
    f.store.loseLedgerCas = true;
    const dispatch = async () => {
      await f.manager.markDispatching(f.lease, reservation);
      launches++;
    };
    await expect(dispatch()).rejects.toThrow(/lost ledger CAS/);
    await expect(dispatch()).rejects.toThrow(/replayed/);
    await expect(f.manager.reserve(f.args())).rejects.toThrow(/occupied/);
    expect(launches).toBe(0);
    expect((await f.manager.ledger.read(12))!.history[0]!.disposition).toBe("dispatching");
  });
  it.each(["oid", "backend", "sequence", "createdAt"] as const)(
    "rejects immutable %s spoofing for receipt record and repair",
    async (field) => {
      const f = await fixture(),
        reservation = await f.manager.reserve(f.args());
      const forged = {
        ...reservation,
        ...(field === "oid"
          ? { oid: sha("foreign") }
          : field === "backend"
            ? { backend: "foreign-backend" }
            : field === "sequence"
              ? { sequence: 999 }
              : { createdAt: new Date("2026-09-09T00:00:00Z") }),
      };
      const before = f.store.comments.length;
      await expect(
        f.manager.record({
          lease: f.lease,
          reservation: forged,
          workItemNodeId: "I_12",
          event: "AttemptStarted",
          sequence: 11,
        }),
      ).rejects.toThrow();
      await expect(
        f.manager.repairReservationComment({
          lease: f.lease,
          reservation: forged,
          workItemNodeId: "I_12",
        }),
      ).rejects.toThrow();
      expect(f.store.comments).toHaveLength(before);
    },
  );
  it("imports unknown historical dispatch without admitting a replacement", async () => {
    const f = await fixture();
    const ref = attemptRef(7, 12, 1),
      event = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "attempt",
        event: "AttemptReserved",
        objective: 7,
        workItem: 12,
        attempt: 1,
        runId: f.lease.runId,
        sequence: 4,
        at: base.serverTime.toISOString(),
        directorEpoch: f.lease.epoch,
        policyDigest: f.lease.policyDigest,
        baseSha: base.oid,
        backend: "codex-sdk/local-worktree",
      });
    const oid = await f.store.createCommit({
      treeOid: base.treeOid,
      parentOids: [base.oid],
      message: encodeEventTrailer(event),
    });
    f.store.refs.set(ref, oid);
    const claim = await f.store.createCommit({
      treeOid: base.treeOid,
      parentOids: [base.oid],
      message: `Factory-Repository-Claim: ${Buffer.from(JSON.stringify({ objective: 7, workItem: 12, runId: f.lease.runId, directorEpoch: f.lease.epoch })).toString("base64url")}`,
    });
    f.store.refs.set("refs/clockgrove-factory/repository/work-items/work-item-12", claim);
    await expect(f.manager.reserve(f.args())).rejects.toThrow(/occupied/);
    const historical = (await f.manager.ledger.read(12))!.history[0]!;
    expect(historical).toMatchObject({
      imported: true,
      disposition: "dispatching",
      dispatchPossible: true,
      reservation: { oid },
    });
    expect(historical.evidence).toBeUndefined();
    expect(f.store.comments).toHaveLength(0);
  });
  it("advances retry numbering only after exact release and cannot rearm old identity", async () => {
    const f = await fixture(),
      first = await f.manager.reserve(f.args());
    await f.manager.markDispatching(f.lease, first);
    await release(f, first);
    const second = await f.manager.reserve(f.args());
    expect(second.attempt).toBe(2);
    expect(
      (await f.manager.ledger.read(12))!.history.map((entry) => entry.reservation.attempt),
    ).toEqual([1, 2]);
    await expect(f.manager.markDispatching(f.lease, first)).rejects.toThrow(/rearmed/);
    expect(f.store.refs.has(second.ref)).toBe(false);
  });
});
