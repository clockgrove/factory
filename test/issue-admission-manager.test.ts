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
import { issueAdmissionRef, parseIssueAdmissionCommit } from "../src/control/issue-admission.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
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
  unavailableAfterLostWrite = false;
  ledgerReadUnavailable = false;
  unavailableLedgerReads = 0;
  now = new Date(base.serverTime);
  async readRef(ref: string) {
    if (ref.startsWith("refs/clockgrove-factory/admission/") && this.ledgerReadUnavailable) {
      this.unavailableLedgerReads++;
      throw Error("ledger readback unavailable");
    }
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
      this.ledgerReadUnavailable = this.unavailableAfterLostWrite;
      throw Error("lost ledger create response");
    }
    return true;
  }
  async compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }) {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    if (args.ref.startsWith("refs/clockgrove-factory/admission/") && this.loseLedgerCas) {
      this.loseLedgerCas = false;
      this.ledgerReadUnavailable = this.unavailableAfterLostWrite;
      throw Error("lost ledger CAS response");
    }
    return true;
  }
  async serverTime() {
    return this.now;
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
  const entry = (await f.manager.ledger.read(reservation.workItem))!.history.find(
    (value) => value.reservation.oid === reservation.oid,
  )!;
  if (entry.disposition !== "terminal")
    await f.manager.record({
      lease: f.lease,
      reservation,
      workItemNodeId: "I_12",
      event: "AttemptFailed",
      sequence: 11,
      allowRecovery: true,
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
  it("recovers exact admission after a lost create response without another reservation", async () => {
    const f = await fixture();
    f.store.loseLedgerCreate = true;
    const original = await f.manager.reserve(f.args());
    await expect(f.manager.reserve(f.args())).rejects.toThrow(/occupied/);
    expect((await f.manager.ledger.read(12))!.history).toHaveLength(1);
    expect(await f.manager.list(7, 12)).toHaveLength(1);
    expect((await f.manager.list(7, 12))[0]!.oid).toBe(original.oid);
    expect(f.store.comments).toHaveLength(1);
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
  it("grants one dispatch when identical contenders use content-addressed commits", async () => {
    const f = await fixture();
    f.store.createCommit = async (args) => {
      const oid = sha(JSON.stringify(args));
      f.store.commits.set(oid, { ...structuredClone(args), oid, serverTime: base.serverTime });
      return oid;
    };
    const reservation = await f.manager.reserve(f.args());
    const preparedOid = f.store.refs.get(issueAdmissionRef(12))!;
    let reads = 0,
      bothObserved!: () => void;
    const preparedObserved = new Promise<void>((resolve) => {
      bothObserved = resolve;
    });
    const read = f.store.readRef.bind(f.store);
    f.store.readRef = async (ref) => {
      const oid = await read(ref);
      if (ref === issueAdmissionRef(12) && reads < 2) {
        reads++;
        expect(oid).toBe(preparedOid);
        if (reads === 2) bothObserved();
        await preparedObserved;
      }
      return oid;
    };
    const writes: Array<{ beforeOid: string; afterOid: string }> = [];
    const cas = f.store.compareAndSwapRef.bind(f.store);
    f.store.compareAndSwapRef = async (args) => {
      if (args.ref === issueAdmissionRef(12)) writes.push(args);
      return cas(args);
    };
    let launches = 0;
    const dispatch = async () => {
      await f.manager.markDispatching(f.lease, reservation);
      launches++;
    };
    const results = await Promise.allSettled([dispatch(), dispatch()]);
    expect(reads).toBe(2);
    expect(writes.map((write) => write.beforeOid)).toEqual([preparedOid, preparedOid]);
    expect(launches).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(new Set(writes.map((write) => write.afterOid)).size).toBe(2);
    expect((await f.manager.ledger.read(12))!.history[0]).toMatchObject({
      disposition: "dispatching",
      dispatchPossible: true,
      reservation: { oid: reservation.oid },
    });
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
    await expect(dispatch()).resolves.toBeUndefined();
    await expect(dispatch()).rejects.toThrow(/replayed/);
    await expect(f.manager.reserve(f.args())).rejects.toThrow(/occupied/);
    expect(launches).toBe(1);
    expect((await f.manager.ledger.read(12))!.history[0]!.disposition).toBe("dispatching");
  });

  it.each(["local-no-scope", "local-durable-scope", "daytona-no-scope"] as const)(
    "closes a %s reservation after accepted write and unavailable readback across restart",
    async (route) => {
      const f = await fixture();
      const backend =
        route === "daytona-no-scope" ? "codex-cli/daytona" : "codex-sdk/local-worktree";
      const scoped = route === "local-durable-scope";
      const reserveArgs = (lease = f.lease) => ({
        ...f.args(lease),
        backend,
        ...(scoped
          ? {
              prepareLocalScope: async (attempt: number) => ({
                identity: {
                  protocol: "clockgrove.factory/local-scope-v1" as const,
                  repository: "o/r",
                  objective: 7,
                  runId: lease.runId,
                  workItem: 12,
                  attempt,
                  directorEpoch: lease.epoch,
                  policyDigest: lease.policyDigest,
                  phase: "execution" as const,
                  commandIndex: 0,
                  invocationDigest: "b".repeat(64),
                  hostIdentity: "c".repeat(64),
                  producerUnit: "factory-test.service",
                  producerInvocationId: "d".repeat(32),
                },
                commandCount: 1,
                producerPid: 123,
                producerStartTicks: "456",
                deadline: "2026-09-08T00:30:00Z",
              }),
            }
          : {}),
      });
      f.store.loseLedgerCreate = true;
      f.store.unavailableAfterLostWrite = true;
      await expect(f.manager.reserve(reserveArgs())).rejects.toThrow();
      expect(f.store.comments).toHaveLength(0);
      expect(f.store.unavailableLedgerReads).toBeGreaterThan(0);
      f.store.ledgerReadUnavailable = false;
      const [original] = await f.manager.list(7, 12);
      expect(original).toBeDefined();
      expect(original!.backend).toBe(backend);
      if (scoped)
        expect(original!.localScopeBatch).toMatchObject({
          identity: {
            directorEpoch: f.lease.epoch,
            attempt: 1,
            producerUnit: "factory-test.service",
          },
          producerPid: 123,
        });
      else expect(original!.localScopeBatch).toBeUndefined();
      const originalCommit = await f.store.readCommit(original!.oid);
      expect((await f.manager.ledger.read(12))!.history[0]).toMatchObject({
        disposition: "prepared",
        dispatchPossible: false,
      });
      f.store.now = new Date(f.lease.expiresAt.getTime() + 1);
      const leases = new LeaseManager({ store: f.store });
      const lease = await leases.acquire(
        {
          objective: 7,
          runId: f.lease.runId,
          holder: "restart-holder",
          policyDigest: f.lease.policyDigest,
        },
        base,
      );
      const manager = new AttemptManager({ store: f.store, leases });
      expect(lease.epoch).toBe(f.lease.epoch + 1);
      expect(
        await manager.recoverUndispatched({
          lease,
          reservation: original!,
          workItemNodeId: "I_12",
          sequence: 12,
        }),
      ).toBe(true);
      const closed = (await manager.ledger.read(12))!.history[0]!;
      expect(closed).toMatchObject({
        disposition: "terminal",
        dispatchPossible: false,
        writerEpoch: lease.epoch,
        currentWriterHolder: lease.holder,
        reservation: { oid: original!.oid },
      });
      expect(closed.evidence).toBeUndefined();
      await expect(f.manager.markDispatching(f.lease, original!)).rejects.toThrow();
      await expect(manager.markDispatching(lease, original!)).rejects.toThrow();
      await expect(manager.reserve(reserveArgs(lease))).rejects.toThrow(/occupied/);
      const receipts = f.store.comments.flatMap((value) => decodeEventComments(value.body));
      expect(receipts.map((value) => value.event)).toEqual(["AttemptReserved", "AttemptDeferred"]);
      expect(receipts[0]).toMatchObject({
        runId: original!.runId,
        directorEpoch: original!.directorEpoch,
        sequence: original!.sequence,
        workItem: 12,
        attempt: 1,
      });
      expect(receipts[1]).toMatchObject({
        directorEpoch: original!.directorEpoch,
        recoveryEpoch: lease.epoch,
        sequence: 12,
        workItem: 12,
        attempt: 1,
      });
      expect(receipts.some((value) => value.kind === "budget")).toBe(false);
      expect(await f.store.readCommit(original!.oid)).toEqual(originalCommit);
      await release({ ...f, manager, leases, lease }, original!);
      const next = await manager.reserve(reserveArgs(lease));
      expect(next.attempt).toBe(2);
      expect(next.backend).toBe(backend);
      if (scoped)
        expect(next.localScopeBatch!.identity).toMatchObject({
          attempt: 2,
          directorEpoch: lease.epoch,
        });
      else expect(next.localScopeBatch).toBeUndefined();
      expect(
        (await manager.ledger.read(12))!.history.map((value) => value.reservation.oid),
      ).toEqual([original!.oid, next.oid]);
      expect((await manager.list(7, 12))[0]).toEqual(original);
    },
  );

  it.each(["close", "dispatch"] as const)(
    "allows only %s to win the close-versus-dispatch CAS race",
    async (winner) => {
      const f = await fixture(),
        original = await f.manager.reserve(f.args());
      let winnerApplied!: () => void;
      const committed = new Promise<void>((resolve) => {
        winnerApplied = resolve;
      });
      const cas = f.store.compareAndSwapRef.bind(f.store);
      f.store.compareAndSwapRef = async (args) => {
        if (args.ref !== issueAdmissionRef(12)) return cas(args);
        const after = parseIssueAdmissionCommit(await f.store.readCommit(args.afterOid), 12);
        const kind = after.history[0]!.disposition === "terminal" ? "close" : "dispatch";
        if (kind !== winner) await committed;
        const result = await cas(args);
        if (kind === winner) winnerApplied();
        return result;
      };
      let launches = 0;
      const results = await Promise.allSettled([
        f.manager.recoverUndispatched({
          lease: f.lease,
          reservation: original,
          workItemNodeId: "I_12",
          sequence: 12,
        }),
        (async () => {
          await f.manager.markDispatching(f.lease, original);
          launches++;
        })(),
      ]);
      const entry = (await f.manager.ledger.read(12))!.history[0]!;
      expect(entry.reservation.oid).toBe(original.oid);
      expect(entry.evidence).toBeUndefined();
      if (winner === "close") {
        expect(results[0]).toEqual({ status: "fulfilled", value: true });
        expect(results[1]!.status).toBe("rejected");
        expect(entry).toMatchObject({ disposition: "terminal", dispatchPossible: false });
        expect(launches).toBe(0);
      } else {
        expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
        expect(
          results[0]!.status === "rejected" ||
            (results[0]!.status === "fulfilled" && results[0]!.value === false),
        ).toBe(true);
        expect(entry).toMatchObject({ disposition: "dispatching", dispatchPossible: true });
        expect(launches).toBe(1);
      }
      await expect(f.manager.markDispatching(f.lease, original)).rejects.toThrow();
      await expect(f.manager.reserve(f.args())).rejects.toThrow(/occupied/);
    },
  );
  it("cannot prove non-execution after dispatch CAS and its readback were uncertain", async () => {
    const f = await fixture(),
      original = await f.manager.reserve(f.args());
    f.store.loseLedgerCas = true;
    f.store.unavailableAfterLostWrite = true;
    let launches = 0;
    await expect(
      (async () => {
        await f.manager.markDispatching(f.lease, original);
        launches++;
      })(),
    ).rejects.toThrow();
    expect(launches).toBe(0);
    expect(f.store.unavailableLedgerReads).toBeGreaterThan(0);
    f.store.ledgerReadUnavailable = false;
    f.store.now = new Date(f.lease.expiresAt.getTime() + 1);
    const leases = new LeaseManager({ store: f.store });
    const lease = await leases.acquire(
      {
        objective: 7,
        runId: f.lease.runId,
        holder: "restart-holder",
        policyDigest: f.lease.policyDigest,
      },
      base,
    );
    const manager = new AttemptManager({ store: f.store, leases });
    expect(
      await manager.recoverUndispatched({
        lease,
        reservation: original,
        workItemNodeId: "I_12",
        sequence: 12,
      }),
    ).toBe(false);
    expect((await manager.ledger.read(12))!.history[0]).toMatchObject({
      disposition: "dispatching",
      dispatchPossible: true,
      reservation: { oid: original.oid },
    });
    await expect(f.manager.markDispatching(f.lease, original)).rejects.toThrow();
    await expect(manager.markDispatching(lease, original)).rejects.toThrow();
    await expect(manager.reserve(f.args(lease))).rejects.toThrow(/occupied/);
    expect(
      f.store.comments
        .flatMap((value) => decodeEventComments(value.body))
        .map((value) => value.event),
    ).toEqual(["AttemptReserved"]);
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
    const [imported] = await f.manager.list(7, 12);
    expect(
      await f.manager.recoverUndispatched({
        lease: f.lease,
        reservation: imported!,
        workItemNodeId: "I_12",
        sequence: 12,
      }),
    ).toBe(false);
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
