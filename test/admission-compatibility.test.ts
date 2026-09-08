import { describe, expect, it } from "vitest";
import {
  ensureAdmissionCompatibility,
  isAdmissionBarrier,
  type AdmissionCompatibilityStore,
} from "../src/control/admission-compatibility.js";
import { attemptRef, attemptRefPrefix } from "../src/control/attempts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { PROTOCOL_V2 } from "../src/protocol/limits.js";
import type { GitCommitObject } from "../src/control/lease.js";

const base: GitCommitObject = {
  oid: "a".repeat(40),
  treeOid: "b".repeat(40),
  parentOids: [],
  message: "base",
  serverTime: new Date("2026-09-08T00:00:00Z"),
};
const claimRef = "refs/clockgrove-factory/repository/work-items/work-item-7";
class Store implements AdmissionCompatibilityStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([[base.oid, base]]);
  next = 1;
  beforeCreate: ((ref: string) => Promise<void>) | undefined;
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const value = this.commits.get(oid);
    if (!value) throw new Error("missing commit");
    return value;
  }
  async listRefs(prefix: string) {
    return [...this.refs]
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, oid]) => ({ ref, oid }));
  }
  async createCommit(args: { treeOid: string; parentOids: string[]; message: string }) {
    const oid = (this.next++).toString(16).padStart(40, "0");
    this.commits.set(oid, { ...args, oid, serverTime: base.serverTime });
    return oid;
  }
  async createRef(ref: string, oid: string) {
    if (this.beforeCreate) {
      const callback = this.beforeCreate;
      this.beforeCreate = undefined;
      await callback(ref);
    }
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }
  async compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }) {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    return true;
  }
  async serverTime() {
    return base.serverTime;
  }
  async addIssueComment() {}
}
const args = {
  objective: 3,
  workItem: 7,
  workItemNodeId: "I_7",
  base,
  assertCurrent: async () => {},
};
async function oldClaim(store: Store, objective = 3) {
  const existing = await store.readRef(claimRef);
  if (existing) {
    const commit = await store.readCommit(existing);
    const trailer = commit.message.split("Factory-Repository-Claim: ")[1];
    if (!trailer) throw new Error("repository Work Item claim has no claim trailer");
    const value = JSON.parse(Buffer.from(trailer, "base64url").toString("utf8"));
    if (value.objective !== objective) throw new Error("another owner");
    return;
  }
  const oid = await store.createCommit({
    treeOid: base.treeOid,
    parentOids: [base.oid],
    message: `Factory-Repository-Claim: ${Buffer.from(JSON.stringify({ objective, workItem: 7, runId: "old-run", directorEpoch: 1 })).toString("base64url")}`,
  });
  if (!(await store.createRef(claimRef, oid))) throw new Error("old claim conflict");
}
// Captured old AttemptManager algorithm (baseline 870691d). Deliberately
// independent of the new production manager so mixed-version tests stay old.
async function oldReserve(store: Store) {
  const refs = await store.listRefs(attemptRefPrefix(3, 7));
  const attempts = await Promise.all(
    refs.map(async ({ oid }) => {
      const commit = await store.readCommit(oid);
      const trailer = commit.message
        .split(/\r?\n/)
        .reverse()
        .find((line) => line.startsWith("Factory-Event: "));
      if (!trailer) throw new Error("no Factory event trailer");
      const event = parseFactoryEvent(
        JSON.parse(
          Buffer.from(trailer.slice("Factory-Event: ".length), "base64url").toString("utf8"),
        ),
      );
      if (event.kind !== "attempt" || event.event !== "AttemptReserved")
        throw new Error("not an attempt reservation");
      return event.attempt;
    }),
  );
  const next = (attempts.sort((a, b) => a - b).at(-1) ?? 0) + 1;
  const ref = attemptRef(3, 7, next);
  const event = parseFactoryEvent({
    protocol: PROTOCOL_V2,
    kind: "attempt",
    event: "AttemptReserved",
    objective: 3,
    runId: "old-run",
    sequence: 1,
    at: (await store.serverTime()).toISOString(),
    workItem: 7,
    attempt: next,
    backend: "codex-sdk-local",
    baseSha: base.oid,
    directorEpoch: 1,
    policyDigest: "c".repeat(64),
  });
  const oid = await store.createCommit({
    treeOid: base.treeOid,
    parentOids: [base.oid],
    message: encodeEventTrailer(event),
  });
  if (!(await store.createRef(ref, oid))) throw new Error("another Director reserved");
  return { ref, oid };
}

describe("admission compatibility bridge", () => {
  it("blocks an old writer arriving before claim and creates no legacy attempt namespace", async () => {
    const store = new Store();
    const result = await ensureAdmissionCompatibility(store, args);
    expect(result.legacy).toEqual([]);
    expect(result.barrierRef).toBeUndefined();
    await expect(oldClaim(store)).rejects.toThrow("no claim trailer");
    expect(await ensureAdmissionCompatibility(store, args)).toEqual(result);
  });
  it("blocks an old claim already prepared before its atomic create", async () => {
    const store = new Store();
    store.beforeCreate = async (ref) => {
      expect(ref).toBe(claimRef);
      await ensureAdmissionCompatibility(store, args);
    };
    await expect(oldClaim(store)).rejects.toThrow("old claim conflict");
    expect((await ensureAdmissionCompatibility(store, args)).legacy).toEqual([]);
  });
  it("blocks an old writer after claim but before listing attempts", async () => {
    const store = new Store();
    await oldClaim(store);
    const oldClaimOid = await store.readRef(claimRef);
    const result = await ensureAdmissionCompatibility(store, args);
    expect((await store.readCommit(result.claimOid)).parentOids).toContain(oldClaimOid);
    await expect(oldReserve(store)).rejects.toThrow("no Factory event trailer");
    expect(result.legacy).toEqual([]);
  });
  it("blocks an old reservation already past list at its exact pending create slot", async () => {
    const store = new Store();
    await oldClaim(store);
    store.beforeCreate = async (ref) => {
      expect(ref).toBe(attemptRef(3, 7, 1));
      await ensureAdmissionCompatibility(store, args);
    };
    await expect(oldReserve(store)).rejects.toThrow("another Director reserved");
    const result = await ensureAdmissionCompatibility(store, args);
    expect(result.legacy).toEqual([]);
  });
  it("retains a prior admission whose dispatch occurs after the bridge", async () => {
    const store = new Store();
    await oldClaim(store);
    const reservation = await oldReserve(store);
    const result = await ensureAdmissionCompatibility(store, args);
    expect(result.legacy).toEqual([{ ref: reservation.ref, oid: reservation.oid }]);
    expect(result.barrierRef).toBe(attemptRef(3, 7, 2));
    // No lease expiry or process observation is consulted, and no terminal,
    // release, or non-execution evidence is fabricated for this producer.
    expect(await store.readRef(reservation.ref)).toBe(reservation.oid);
    expect(await ensureAdmissionCompatibility(store, args)).toEqual(result);
  });
  it("rescans a legacy reservation winning the barrier create race", async () => {
    const store = new Store();
    await oldClaim(store);
    let reservation: Awaited<ReturnType<typeof oldReserve>> | undefined;
    store.beforeCreate = async (ref) => {
      expect(ref).toBe(attemptRef(3, 7, 1));
      reservation = await oldReserve(store);
    };
    const result = await ensureAdmissionCompatibility(store, args);
    expect(result.legacy).toEqual([{ ref: reservation!.ref, oid: reservation!.oid }]);
    expect(result.barrierRef).toBe(attemptRef(3, 7, 2));
  });
  it("concurrent importers converge on the same immutable markers", async () => {
    const store = new Store();
    await oldClaim(store);
    await oldReserve(store);
    const results = await Promise.all([
      ensureAdmissionCompatibility(store, args),
      ensureAdmissionCompatibility(store, args),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await store.listRefs(attemptRefPrefix(3, 7))).length).toBe(2);
  });
  it("rejects foreign legacy ownership without mutating it", async () => {
    const store = new Store();
    await oldClaim(store, 9);
    const before = [...store.refs];
    await expect(ensureAdmissionCompatibility(store, args)).rejects.toThrow("Objective #9");
    expect([...store.refs]).toEqual(before);
  });
  it("rejects issue identity mismatch and a copied barrier bound to another ref", async () => {
    const store = new Store();
    await oldClaim(store);
    const result = await ensureAdmissionCompatibility(store, args);
    await expect(
      ensureAdmissionCompatibility(store, { ...args, workItemNodeId: "I_other" }),
    ).rejects.toThrow("identity mismatch");
    const barrier = await store.readCommit((await store.readRef(result.barrierRef!))!);
    expect(isAdmissionBarrier(result.barrierRef!, barrier)).toBe(true);
    expect(() => isAdmissionBarrier(attemptRef(9, 7, 1), barrier)).toThrow("binding");
  });
  it("rejects a marker detached from the original claim commit", async () => {
    const store = new Store();
    await oldClaim(store);
    const result = await ensureAdmissionCompatibility(store, args);
    const marker = await store.readCommit(result.claimOid);
    store.commits.set(result.claimOid, { ...marker, parentOids: [base.oid] });
    await expect(ensureAdmissionCompatibility(store, args)).rejects.toThrow(
      "original claim parent",
    );
  });
  it("fails closed for a deleted legacy slot instead of allowing delayed creates into the hole", async () => {
    const store = new Store();
    await oldClaim(store);
    await oldReserve(store);
    await oldReserve(store);
    store.refs.delete(attemptRef(3, 7, 1));
    await expect(ensureAdmissionCompatibility(store, args)).rejects.toThrow("not contiguous");
  });
});
