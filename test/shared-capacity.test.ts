import { describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { LeaseManager, type LeaseStore, type GitCommitObject } from "../src/control/lease.js";
import { RepositoryLeaseManager } from "../src/controller/repository-lease.js";
import {
  SharedCapacityCoordinator,
  SHARED_CAPACITY_ACTION_REQUIRED_AT,
  SHARED_CAPACITY_COMPACT_AT,
  SHARED_CAPACITY_HARD_LIMIT,
  SHARED_CAPACITY_REF,
  sharedCapacityClaimId,
  type SharedCapacityOwner,
} from "../src/controller/shared-capacity.js";
import {
  capacityReservationKey,
  type CapacityLimits,
  type CapacityReservation,
} from "../src/scheduling/capacity-ledger.js";

const base = "a".repeat(40),
  digest = "b".repeat(64);
class Store implements LeaseStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([
    [base, { oid: base, treeOid: base, parentOids: [], message: "base", serverTime: new Date() }],
  ]);
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>([[base, new Map()]]);
  now = new Date("2026-09-08T00:00:00Z");
  next = 1;
  loseResponse = false;
  failCreateTree = false;
  beforeDispatch: (() => Promise<void>) | undefined;
  scopes = new AsyncLocalStorage<() => Promise<void>>();
  mutationScope = new AsyncLocalStorage<"normal" | "lease" | "cleanup">();
  mutationClasses: Array<"normal" | "lease" | "cleanup"> = [];
  async withMutationClass<T>(
    kind: "normal" | "lease" | "cleanup",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.mutationScope.getStore()) return operation();
    this.mutationClasses.push(kind);
    return this.mutationScope.run(kind, operation);
  }
  async withMutationFence<T>(
    fence: (waitedMs: number) => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.scopes.run(() => fence(0), operation);
  }
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const result = this.commits.get(oid);
    if (!result) throw new Error("missing commit");
    return result;
  }
  async createCommit(input: { treeOid: string; parentOids: string[]; message: string }) {
    await this.scopes.getStore()?.();
    const oid = (this.next++).toString(16).padStart(40, "0");
    this.commits.set(oid, { ...input, oid, serverTime: this.now });
    return oid;
  }
  async createRef(ref: string, oid: string) {
    await this.scopes.getStore()?.();
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }
  async createBlob(content: Buffer) {
    await this.scopes.getStore()?.();
    const oid = (this.next++).toString(16).padStart(40, "0");
    this.blobs.set(oid, content);
    return oid;
  }
  async createTree(input: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }) {
    await this.scopes.getStore()?.();
    if (this.failCreateTree) {
      this.failCreateTree = false;
      throw new Error("injected tree failure");
    }
    const oid = (this.next++).toString(16).padStart(40, "0");
    const tree = new Map(this.trees.get(input.baseTreeOid ?? base) ?? []);
    for (const entry of input.entries) {
      if (entry.sha) tree.set(entry.path, entry.sha);
      else tree.delete(entry.path);
    }
    this.trees.set(oid, tree);
    return oid;
  }
  async readTreeDirectory(treeOid: string, path: string) {
    const tree = this.trees.get(treeOid);
    if (!tree) throw new Error("missing tree");
    const prefix = `${path}/`;
    const direct = [...tree.entries()].filter(
      ([candidate]) =>
        candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"),
    );
    if (direct.length === 0) return null;
    return direct.map(([candidate, sha]) => ({
      name: candidate.slice(prefix.length),
      type: "blob" as const,
      sha,
    }));
  }
  async compareAndSwapRef(input: { ref: string; beforeOid: string; afterOid: string }) {
    if (input.ref === SHARED_CAPACITY_REF && this.beforeDispatch) {
      const pending = this.beforeDispatch;
      this.beforeDispatch = undefined;
      await this.scopes.run(async () => {}, pending);
    }
    await this.scopes.getStore()?.();
    if (this.refs.get(input.ref) !== input.beforeOid) return false;
    this.refs.set(input.ref, input.afterOid);
    if (input.ref === SHARED_CAPACITY_REF && this.loseResponse) {
      this.loseResponse = false;
      throw new Error("accepted response lost");
    }
    return true;
  }
  async serverTime() {
    return this.now;
  }
}
const limits: CapacityLimits = {
  maxParallel: 2,
  maxLocalParallel: 2,
  maxCloudParallel: 2,
  backendMaxParallel: {},
  cpuCapacity: 4,
  memoryCapacityMb: 2048,
  maxPaidUnits: 10,
};
function coordinator(store: Store, ceiling = limits, assertLegacyCompatible = async () => {}) {
  return new SharedCapacityCoordinator({
    store,
    repository: "fixture/project",
    baseCommitSha: base,
    limits: ceiling,
    assertLegacyCompatible,
  });
}
async function owner(
  store: Store,
  objective: number,
  runId = `run-${objective}`,
): Promise<SharedCapacityOwner> {
  const lease = await new LeaseManager({ store }).acquire(
    { objective, runId, holder: `session-${objective}`, policyDigest: digest },
    await store.readCommit(base),
  );
  return { objective, runId, directorEpoch: lease.epoch, policyDigest: digest };
}
function reservation(
  objective: number,
  extra: Partial<CapacityReservation> = {},
): CapacityReservation {
  const value = {
    objective,
    workItem: objective * 10,
    attempt: 1,
    phase: "execution" as const,
    backendId: "codex-sdk/local-worktree",
    admissionClass: "local" as const,
    local: true,
    cpu: 1,
    memoryMb: 128,
    paidUnits: 0,
    paths: [],
    exclusiveResources: [],
    ...extra,
  };
  return { ...value, key: capacityReservationKey(value) };
}

async function seedClaims(
  store: Store,
  claimOwner: SharedCapacityOwner,
  count: number,
  released: boolean,
  active?: CapacityReservation,
): Promise<void> {
  const claims = Array.from({ length: count }, (_, index) => {
    const value = reservation(claimOwner.objective, { workItem: index + 1 });
    return {
      id: sharedCapacityClaimId(claimOwner, value.key),
      owner: claimOwner,
      reservation: value,
      released,
    };
  });
  if (active) {
    claims.push({
      id: sharedCapacityClaimId(claimOwner, active.key),
      owner: claimOwner,
      reservation: active,
      released: false,
    });
  }
  const total = claims.length;
  const state = {
    protocol: "clockgrove.factory/shared-capacity-v1",
    repository: "fixture/project",
    generation: 1,
    limits: {
      ...limits,
      maxParallel: Math.max(limits.maxParallel, total + 1),
      maxLocalParallel: Math.max(limits.maxLocalParallel, total + 1),
      cpuCapacity: Math.max(limits.cpuCapacity, total + 1),
      memoryCapacityMb: Math.max(limits.memoryCapacityMb, (total + 1) * 128),
    },
    claims,
  };
  const oid = (store.next++).toString(16).padStart(40, "0");
  store.commits.set(oid, {
    oid,
    treeOid: base,
    parentOids: [base],
    message: `Factory shared capacity\n\nFactory-Shared-Capacity: ${Buffer.from(
      JSON.stringify(state),
    ).toString("base64url")}`,
    serverTime: store.now,
  });
  store.refs.set(SHARED_CAPACITY_REF, oid);
}

describe("independent-session durable capacity", () => {
  it("classifies shared-capacity release as cleanup across its complete CAS transaction", async () => {
    const store = new Store();
    const shared = coordinator(store);
    const claimOwner = await owner(store, 1);
    await shared.initialize();
    const held = reservation(1);
    await shared.reserve(claimOwner, held, limits);
    store.mutationClasses = [];

    await shared.release(claimOwner, held.key);

    expect(store.mutationClasses).toEqual(["cleanup"]);
    expect((await shared.snapshot()).active).toBe(0);
  });

  it("rejects an Objective takeover while its capacity CAS waits for dispatch", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1);
    await a.initialize();
    store.beforeDispatch = async () => {
      store.now = new Date(store.now.getTime() + 20 * 60_000);
      await owner(store, 1, "replacement");
    };
    await expect(a.reserve(one, reservation(1), limits)).rejects.toThrow(
      "ownership is not current",
    );
    expect((await a.snapshot()).active).toBe(0);
  });
  it("permits distinct Objectives while a scheduler election lease is still held", async () => {
    const store = new Store(),
      a = coordinator(store),
      b = coordinator(store);
    await a.initialize();
    await new RepositoryLeaseManager({ store }).acquire(
      { controllerId: "crashed-scheduler", policyDigest: digest },
      await store.readCommit(base),
    );
    const [one, two] = await Promise.all([owner(store, 1), owner(store, 2)]);
    expect(
      await Promise.all([
        a.reserve(one, reservation(1), limits),
        b.reserve(two, reservation(2), limits),
      ]),
    ).toMatchObject([{ reserved: true }, { reserved: true }]);
    expect((await a.snapshot()).active).toBe(2);
  });

  it("does not let an unpaid first session permanently disable later authorized paid capacity", async () => {
    const store = new Store(),
      global = { ...limits, maxCloudParallel: 8 };
    const first = coordinator(store, global),
      one = await owner(store, 1),
      two = await owner(store, 2);
    await first.reserve(one, reservation(1), { ...limits, maxCloudParallel: 0 });
    const paid = reservation(2, {
      local: false,
      backendId: "codex-cli/daytona",
      admissionClass: "burst",
      paidUnits: 1,
    });
    expect(
      await coordinator(store, global).reserve(two, paid, { ...limits, maxCloudParallel: 0 }),
    ).toMatchObject({ reserved: false, code: "cloud-capacity" });
    expect(await coordinator(store, global).reserve(two, paid, limits)).toMatchObject({
      reserved: true,
    });
  });

  it("changes ceilings only through explicit fenced configuration without dropping active claims", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1),
      two = await owner(store, 2),
      three = await owner(store, 3);
    await a.reserve(one, reservation(1), limits);
    await a.reserve(two, reservation(2), limits);
    let fenced = 0;
    const authority = async () => {
      fenced++;
    };
    await a.configureLimits({ ...limits, maxParallel: 1 }, authority);
    expect((await a.snapshot()).active).toBe(2);
    await a.release(one, reservation(1).key);
    expect(await a.reserve(three, reservation(3), limits)).toMatchObject({
      reserved: false,
      code: "global-capacity",
    });
    await a.configureLimits({ ...limits, maxParallel: 3, maxLocalParallel: 3 }, authority);
    expect((await a.snapshot()).active).toBe(1);
    expect(await a.reserve(three, reservation(3), limits)).toMatchObject({ reserved: true });
    expect(fenced).toBeGreaterThan(0);
  });

  it.each([
    { selected: "maxLocalParallel" as const, local: 4, cloud: 0 },
    { selected: "maxCloudParallel" as const, local: 0, cloud: 4 },
  ])(
    "partial $selected updates preserve unmentioned resource policy",
    async ({ selected, local, cloud }) => {
      const store = new Store();
      const a = coordinator(store, {
        ...limits,
        maxParallel: 0,
        maxLocalParallel: 0,
        maxCloudParallel: 0,
        backendMaxParallel: { "limited/backend": 1 },
        cpuCapacity: 3,
        memoryCapacityMb: 512,
        maxPaidUnits: 2,
      });
      await a.initialize();
      await a.configureLimits({
        ...limits,
        maxLocalParallel: 4,
        maxCloudParallel: 4,
      }, async () => {}, [selected]);
      const oid = await store.readRef(SHARED_CAPACITY_REF);
      const message = (await store.readCommit(oid!)).message;
      const state = JSON.parse(
        Buffer.from(message.split("Factory-Shared-Capacity: ")[1]!, "base64url").toString(),
      );
      expect(state.limits).toEqual({
        maxParallel: 4,
        maxLocalParallel: local,
        maxCloudParallel: cloud,
        backendMaxParallel: { "limited/backend": 1 },
        cpuCapacity: 3,
        memoryCapacityMb: 512,
        maxPaidUnits: 2,
      });
    },
  );

  it("races separate instances for the last slot without over-admission", async () => {
    const store = new Store(),
      ceiling = { ...limits, maxParallel: 1 };
    const [one, two] = await Promise.all([owner(store, 1), owner(store, 2)]);
    const results = await Promise.all([
      coordinator(store, ceiling).reserve(one, reservation(1), limits),
      coordinator(store, ceiling).reserve(two, reservation(2), limits),
    ]);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect((await coordinator(store).snapshot()).active).toBe(1);
  });

  it.each([
    ["cpu-capacity", { cpu: 3 }, {}],
    ["memory-capacity", { memoryMb: 1500 }, {}],
    ["paid-capacity", { paidUnits: 6 }, {}],
    ["backend-capacity", {}, { backendMaxParallel: { "codex-sdk/local-worktree": 1 } }],
    ["path-conflict", { paths: ["src/shared"] }, {}],
    ["exclusive-resource-conflict", { exclusiveResources: ["gpu"] }, {}],
  ] as const)("preserves %s across independent sessions", async (code, request, changes) => {
    const store = new Store(),
      ceiling = { ...limits, ...changes };
    const a = coordinator(store, ceiling),
      b = coordinator(store, ceiling);
    const one = await owner(store, 1),
      two = await owner(store, 2);
    const extra = {
      ...request,
      ...("paths" in request ? { paths: [...request.paths] } : {}),
      ...("exclusiveResources" in request
        ? { exclusiveResources: [...request.exclusiveResources] }
        : {}),
    };
    expect(await a.reserve(one, reservation(1, extra), ceiling)).toMatchObject({ reserved: true });
    expect(await b.reserve(two, reservation(2, extra), ceiling)).toEqual({
      reserved: false,
      code,
      generation: 2,
    });
  });

  it("does not release a crashed session's claim on lease expiry or incomplete reconstruction", async () => {
    const store = new Store(),
      a = coordinator(store);
    const one = await owner(store, 1);
    await a.reserve(one, reservation(1), limits);
    store.now = new Date(store.now.getTime() + 20 * 60_000);
    const two = await owner(store, 2);
    expect(await coordinator(store).reserve(two, reservation(2), limits)).toMatchObject({
      reserved: true,
    });
    await coordinator(store).reconcile(two, []);
    expect((await a.snapshot()).active).toBe(2);
    await expect(a.release(one, reservation(1).key)).rejects.toThrow("ownership is not current");
  });

  it("keeps exact idempotency across response loss and terminal release", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1),
      item = reservation(1);
    await a.initialize();
    store.loseResponse = true;
    const result = await a.reserve(one, item, limits);
    expect(await coordinator(store).reserve(one, item, limits)).toEqual(result);
    expect((await a.snapshot()).active).toBe(1);
    await expect(a.reserve(one, { ...item, cpu: 2 }, limits)).rejects.toThrow("changed resources");
    await a.release(one, item.key);
    await a.release(one, item.key);
    expect(await a.reserve(one, item, limits)).toEqual({
      reserved: false,
      code: "released-reservation",
    });
  });

  it("transitions atomically and refuses wider policy from a second session", async () => {
    const store = new Store(),
      a = coordinator(store, { ...limits, maxParallel: 1, maxCloudParallel: 0 });
    const one = await owner(store, 1),
      item = reservation(1);
    await a.reserve(one, item, limits);
    const validation = reservation(1, { phase: "validation" });
    expect(await a.transition(one, item.key, validation, limits)).toMatchObject({ reserved: true });
    expect(await a.transition(one, item.key, validation, limits)).toMatchObject({ reserved: true });
    expect((await a.snapshot()).active).toBe(1);
    const two = await owner(store, 2);
    expect(
      await coordinator(store, { ...limits, maxParallel: 32 }).reserve(two, reservation(2), {
        ...limits,
        maxParallel: 32,
      }),
    ).toMatchObject({ reserved: false, code: "global-capacity" });
  });

  it("retries an exact transition after its released source was compacted", async () => {
    const store = new Store(),
      one = await owner(store, 1),
      source = reservation(1, { workItem: SHARED_CAPACITY_COMPACT_AT + 10 }),
      target = reservation(1, {
        workItem: SHARED_CAPACITY_COMPACT_AT + 10,
        phase: "validation",
      });
    await seedClaims(store, one, SHARED_CAPACITY_COMPACT_AT - 2, true, source);
    await expect(
      coordinator(store).transition(one, source.key, target, limits),
    ).resolves.toMatchObject({ reserved: true });
    const restarted = coordinator(store);
    await expect(restarted.transition(one, source.key, target, limits)).resolves.toMatchObject({
      reserved: true,
    });
    expect(await restarted.snapshot()).toMatchObject({ active: 1, reservations: [target] });
    expect(await restarted.retentionStatus()).toMatchObject({
      journalClaims: 1,
      retiredClaims: SHARED_CAPACITY_COMPACT_AT - 1,
    });
    await expect(
      restarted.transition(one, source.key, { ...target, cpu: 2 }, limits),
    ).rejects.toThrow("transition identity mismatch");
  });

  it("requires verified legacy initialization only once, not leader expiry each session", async () => {
    const store = new Store();
    await expect(
      coordinator(store, limits, async () => {
        throw new Error("legacy resources unknown");
      }).initialize(),
    ).rejects.toThrow("legacy resources unknown");
    expect(await store.readRef(SHARED_CAPACITY_REF)).toBeNull();
    await coordinator(store).initialize();
    await coordinator(store, limits, async () => {
      throw new Error("must not inspect old election");
    }).initialize();
  });

  it("transfers exact retained liability to a new same-run epoch without freeing a slot", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1),
      item = reservation(1);
    await a.reserve(one, item, limits);
    store.now = new Date(store.now.getTime() + 20 * 60_000);
    const successor = await owner(store, 1);
    await a.reconcile(successor, [item]);
    expect((await a.snapshot()).active).toBe(1);
    await a.release(successor, item.key);
    expect((await a.snapshot()).active).toBe(0);
  });

  it("compacts released claims into exact durable anti-replay evidence at the boundary", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1);
    await seedClaims(store, one, SHARED_CAPACITY_COMPACT_AT - 1, true);
    const fresh = reservation(1, { workItem: SHARED_CAPACITY_COMPACT_AT });
    await expect(a.reserve(one, fresh, limits)).resolves.toMatchObject({ reserved: true });
    expect(await a.retentionStatus()).toMatchObject({
      journalClaims: 1,
      activeClaims: 1,
      releasedClaims: 0,
      retiredClaims: SHARED_CAPACITY_COMPACT_AT - 1,
      status: "healthy",
    });
    const retired = reservation(1, { workItem: 1 });
    await expect(a.reserve(one, retired, limits)).resolves.toEqual({
      reserved: false,
      code: "released-reservation",
    });
    await expect(a.reserve(one, { ...retired, cpu: 2 }, limits)).rejects.toThrow(
      "identity changed resources",
    );
  });

  it("preserves compaction and both reservations across CAS contention", async () => {
    const store = new Store(),
      a = coordinator(store, { ...limits, maxParallel: 4, maxLocalParallel: 4 }),
      b = coordinator(store, { ...limits, maxParallel: 4, maxLocalParallel: 4 }),
      one = await owner(store, 1),
      two = await owner(store, 2);
    await seedClaims(store, one, SHARED_CAPACITY_COMPACT_AT - 1, true);
    store.beforeDispatch = async () => {
      await b.reserve(two, reservation(2, { workItem: SHARED_CAPACITY_COMPACT_AT + 1 }), {
        ...limits,
        maxParallel: 4,
        maxLocalParallel: 4,
      });
    };
    await a.reserve(one, reservation(1, { workItem: SHARED_CAPACITY_COMPACT_AT }), {
      ...limits,
      maxParallel: 4,
      maxLocalParallel: 4,
    });
    expect(await a.snapshot()).toMatchObject({ active: 2 });
    expect(await a.retentionStatus()).toMatchObject({
      journalClaims: 2,
      retiredClaims: SHARED_CAPACITY_COMPACT_AT - 1,
    });
  });

  it("preserves compacted evidence while a ceiling configuration loses its CAS", async () => {
    const store = new Store(),
      a = coordinator(store),
      b = coordinator(store),
      one = await owner(store, 1),
      two = await owner(store, 2);
    await seedClaims(store, one, SHARED_CAPACITY_COMPACT_AT - 1, true);
    store.beforeDispatch = async () => {
      await b.reserve(two, reservation(2), limits);
    };
    await a.configureLimits({ ...limits, maxParallel: 3, maxLocalParallel: 3 }, async () => {});
    expect(await a.snapshot()).toMatchObject({ active: 1 });
    expect(await a.retentionStatus()).toMatchObject({
      journalClaims: 1,
      retiredClaims: SHARED_CAPACITY_COMPACT_AT - 1,
    });
    const three = await owner(store, 3);
    await expect(a.reserve(three, reservation(3), limits)).resolves.toMatchObject({
      reserved: true,
    });
  });

  it("keeps the released journal authoritative when compaction crashes before publication", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1);
    await seedClaims(store, one, SHARED_CAPACITY_COMPACT_AT - 1, true);
    store.failCreateTree = true;
    await expect(
      a.reserve(one, reservation(1, { workItem: SHARED_CAPACITY_COMPACT_AT }), limits),
    ).rejects.toThrow("injected tree failure");
    expect(await a.retentionStatus()).toMatchObject({
      journalClaims: SHARED_CAPACITY_COMPACT_AT - 1,
      releasedClaims: SHARED_CAPACITY_COMPACT_AT - 1,
      retiredClaims: 0,
    });
    await expect(a.reserve(one, reservation(1, { workItem: 1 }), limits)).resolves.toEqual({
      reserved: false,
      code: "released-reservation",
    });
  });

  it("recovers an ambiguously accepted compaction without re-arming a retired identity", async () => {
    const store = new Store(),
      a = coordinator(store),
      one = await owner(store, 1);
    await seedClaims(store, one, SHARED_CAPACITY_COMPACT_AT - 1, true);
    store.loseResponse = true;
    await a.reserve(one, reservation(1, { workItem: SHARED_CAPACITY_COMPACT_AT }), limits);
    await expect(a.reserve(one, reservation(1, { workItem: 1 }), limits)).resolves.toEqual({
      reserved: false,
      code: "released-reservation",
    });
    store.now = new Date(store.now.getTime() + 20 * 60_000);
    await owner(store, 1, "replacement");
    await expect(a.reserve(one, reservation(1, { workItem: 1 }), limits)).rejects.toThrow(
      "ownership is not current",
    );
  });

  it("reports actionable unresolved retention pressure before the hard limit", async () => {
    const store = new Store(),
      largeLimits = {
        ...limits,
        maxParallel: SHARED_CAPACITY_HARD_LIMIT + 1,
        maxLocalParallel: SHARED_CAPACITY_HARD_LIMIT + 1,
        cpuCapacity: SHARED_CAPACITY_HARD_LIMIT + 1,
        memoryCapacityMb: (SHARED_CAPACITY_HARD_LIMIT + 1) * 128,
      },
      a = coordinator(store, largeLimits),
      one = await owner(store, 1);
    await seedClaims(store, one, SHARED_CAPACITY_ACTION_REQUIRED_AT, false);
    expect(await a.retentionStatus()).toEqual({
      journalClaims: SHARED_CAPACITY_ACTION_REQUIRED_AT,
      activeClaims: SHARED_CAPACITY_ACTION_REQUIRED_AT,
      releasedClaims: 0,
      retiredClaims: 0,
      compactAt: SHARED_CAPACITY_COMPACT_AT,
      actionRequiredAt: SHARED_CAPACITY_ACTION_REQUIRED_AT,
      hardLimit: SHARED_CAPACITY_HARD_LIMIT,
      status: "action-required",
      action:
        "Reconcile every retained liability and explicitly release settled claims; active or unresolved claims cannot be compacted.",
    });
    await seedClaims(store, one, SHARED_CAPACITY_HARD_LIMIT, false);
    await expect(
      a.reserve(one, reservation(1, { workItem: SHARED_CAPACITY_HARD_LIMIT + 1 }), largeLimits),
    ).rejects.toThrow("reconcile and explicitly release settled claims");
  });
});
