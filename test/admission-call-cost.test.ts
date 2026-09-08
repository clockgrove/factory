import { describe, expect, it } from "vitest";
import {
  AttemptManager,
  attemptRef,
  attemptRefPrefix,
  type AttemptStore,
} from "../src/control/attempts.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { PROTOCOL_V2 } from "../src/protocol/limits.js";

const sha = "a".repeat(40),
  digest = "b".repeat(64);
const base: GitCommitObject = {
  oid: sha,
  treeOid: sha,
  parentOids: [],
  message: "base",
  serverTime: new Date("2026-09-08T00:00:00Z"),
};
const lease = {
  objective: 1,
  runId: "run",
  epoch: 1,
  holder: "holder",
  policyDigest: digest,
} as LeaseState;
const claim = "refs/clockgrove-factory/repository/work-items/work-item-2";
class CountStore implements AttemptStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([[sha, base]]);
  next = 1;
  calls: Record<string, number> = {};
  count(key: string) {
    this.calls[key] = (this.calls[key] ?? 0) + 1;
  }
  reset() {
    this.calls = {};
  }
  async readRef(ref: string) {
    this.count("readRef");
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    this.count("readCommit");
    const value = this.commits.get(oid);
    if (!value) throw Error("missing");
    return value;
  }
  async listRefs(prefix: string) {
    this.count("listRefs");
    return [...this.refs]
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, oid]) => ({ ref, oid }));
  }
  async createCommit(args: { treeOid: string; parentOids: string[]; message: string }) {
    this.count("createCommit");
    const oid = (this.next++).toString(16).padStart(40, "0");
    this.commits.set(oid, { ...args, oid, serverTime: base.serverTime });
    return oid;
  }
  async createRef(ref: string, oid: string) {
    this.count("createRef");
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }
  async compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }) {
    this.count("CAS");
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    return true;
  }
  async serverTime() {
    this.count("serverTime");
    return base.serverTime;
  }
  async addIssueComment() {
    this.count("comment");
  }
}
function binding(attempt: number) {
  return {
    graphDigest: digest,
    graphCommitOid: sha,
    projectionCommitOid: sha,
    capacityReservationId: `capacity-${attempt}`,
    budgetReservationId: `budget-${attempt}`,
    resourceIdentity: `resource-${attempt}`,
  };
}
function manager(store: CountStore) {
  return new AttemptManager({
    store,
    leases: {
      assertMutationAuthorized: async () => store.count("fence"),
      assertCurrent: async () => store.count("fence"),
    } as unknown as LeaseManager,
    legacyBinding: async (reservation) => binding(reservation.attempt),
  });
}
const reserveArgs = {
  lease,
  workItem: 2,
  workItemNodeId: "I_2",
  backend: "codex-sdk/local-worktree",
  base,
  sequence: 1,
  binding: async (attempt: number) => binding(attempt),
};

// Baseline 870691d claimWorkItem + AttemptManager.reserve storage algorithm.
// Captured here so the comparison continues to measure the old two-stage path.
async function legacyAdmission(store: CountStore) {
  const existing = await store.readRef(claim);
  if (existing) await store.readCommit(existing);
  else {
    const oid = await store.createCommit({
      treeOid: sha,
      parentOids: [sha],
      message: `Factory-Repository-Claim: ${Buffer.from(JSON.stringify({ objective: 1, workItem: 2, runId: "run", directorEpoch: 1 })).toString("base64url")}`,
    });
    await store.createRef(claim, oid);
  }
  store.count("fence");
  const refs = await store.listRefs(attemptRefPrefix(1, 2));
  for (const ref of refs) await store.readCommit(ref.oid);
  const next = refs.length + 1;
  const event = parseFactoryEvent({
    protocol: PROTOCOL_V2,
    kind: "attempt",
    event: "AttemptReserved",
    objective: 1,
    runId: "run",
    sequence: 1,
    at: (await store.serverTime()).toISOString(),
    workItem: 2,
    attempt: next,
    backend: reserveArgs.backend,
    baseSha: sha,
    directorEpoch: 1,
    policyDigest: digest,
  });
  const oid = await store.createCommit({
    treeOid: sha,
    parentOids: [sha],
    message: encodeEventTrailer(event),
  });
  store.count("fence");
  await store.createRef(attemptRef(1, 2, next), oid);
  await store.addIssueComment();
}
function profile(store: CountStore) {
  return { ...store.calls, simulatedFenceMs: (store.calls.fence ?? 0) * 2 };
}

// Storage-port calls and a fixed synthetic 2 ms/assertion clock are component
// evidence only. Graph authentication, HTTP transport fences, resource budgets,
// actual GitHub fetch latency, throughput, and provider work are not measured.
describe("deterministic admission call profile", () => {
  it("reports baseline, first-use, steady retry, and migration overhead separately", async () => {
    const old = new CountStore();
    await legacyAdmission(old);
    const legacyInitial = profile(old);
    old.reset();
    await legacyAdmission(old);
    const legacySteady = profile(old);
    const current = new CountStore();
    const controller = manager(current);
    const first = await controller.reserve(reserveArgs);
    const newInitial = profile(current);
    await controller.settle(lease, first, {
      reservationOid: first.oid,
      capacityReservationId: binding(1).capacityReservationId,
      budgetReservationId: binding(1).budgetReservationId,
      resourceIdentity: binding(1).resourceIdentity,
      producerStopped: true,
      resourcesReleased: true,
      capacityReleased: true,
      accountingSettled: true,
      evidenceOid: sha,
    });
    current.reset();
    await controller.reserve({ ...reserveArgs, sequence: 2 });
    const newSteady = profile(current);
    const historical = new CountStore();
    await legacyAdmission(historical);
    historical.reset();
    await manager(historical).ensureCompatibility(lease, 2, "I_2", base);
    const migration = profile(historical);
    expect({ legacyInitial, legacySteady, newInitial, newSteady, migration }).toMatchSnapshot();
    expect(current.calls.listRefs).toBe(1);
    expect(current.calls.CAS).toBe(1);
    expect(historical.calls.listRefs).toBe(3);
  });
});
