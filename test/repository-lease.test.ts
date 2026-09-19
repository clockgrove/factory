import { describe, expect, it, vi } from "vitest";
import { PlatformUnavailableError, withGitHubQuotaWait } from "../src/platform.js";

import type { GitCommitObject, LeaseStore } from "../src/control/lease.js";
import {
  DEFAULT_REPOSITORY_LEASE_DURATION_MS,
  REPOSITORY_LEASE_REF,
  RepositoryLeaseContendedError,
  RepositoryLeaseLostError,
  RepositoryLeaseManager,
} from "../src/controller/repository-lease.js";
import type {
  RepositoryLeaseIdentity,
  RepositoryLeaseOwner,
} from "../src/controller/repository-lease.js";

class MemoryLeaseStore implements LeaseStore {
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, GitCommitObject>();
  now = new Date("2026-01-01T00:00:00.000Z");
  observations = 0;
  #next = 2;

  constructor() {
    this.commits.set("1".repeat(40), {
      oid: "1".repeat(40),
      treeOid: "a".repeat(40),
      parentOids: [],
      message: "base",
      serverTime: this.now,
    });
  }

  readRef(ref: string): Promise<string | null> {
    return Promise.resolve(this.refs.get(ref) ?? null);
  }

  readRefWithServerTime(ref: string): Promise<{ oid: string | null; serverTime: Date }> {
    this.observations += 1;
    return Promise.resolve({
      oid: this.refs.get(ref) ?? null,
      serverTime: this.now,
    });
  }

  readCommit(oid: string): Promise<GitCommitObject> {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`missing commit ${oid}`);
    return Promise.resolve(commit);
  }

  createCommit(input: { treeOid: string; parentOids: string[]; message: string }): Promise<string> {
    const oid = this.#next.toString(16).padStart(40, "0");
    this.#next += 1;
    this.commits.set(oid, {
      oid,
      ...input,
      serverTime: this.now,
    });
    return Promise.resolve(oid);
  }

  createRef(ref: string, oid: string): Promise<boolean> {
    if (this.refs.has(ref)) return Promise.resolve(false);
    this.refs.set(ref, oid);
    return Promise.resolve(true);
  }

  compareAndSwapRef(input: { ref: string; beforeOid: string; afterOid: string }): Promise<boolean> {
    if (this.refs.get(input.ref) !== input.beforeOid) {
      return Promise.resolve(false);
    }
    this.refs.set(input.ref, input.afterOid);
    return Promise.resolve(true);
  }

  serverTime(): Promise<Date> {
    return Promise.resolve(this.now);
  }

  base(): GitCommitObject {
    return this.commits.get("1".repeat(40))!;
  }
}

const digest = (character: string) => character.repeat(64);
const processOwner = { kind: "process" } as const;
const managedOwner = (
  invocationId: string,
  overrides: Partial<Extract<RepositoryLeaseOwner, { kind: "managed-service" }>> = {},
): Extract<RepositoryLeaseOwner, { kind: "managed-service" }> => ({
  kind: "managed-service",
  hostIdentity: digest("b"),
  configDigest: digest("c"),
  executableIdentity: `sha256:${digest("d")}`,
  unit: "clockgrove-factory-0123456789abcdef.service",
  invocationId,
  ...overrides,
});
const identity = (
  controllerId: string,
  owner: RepositoryLeaseOwner = processOwner,
  policyDigest = digest("a"),
): RepositoryLeaseIdentity => ({ controllerId, policyDigest, owner });

function rewriteLeaseRecord(
  store: MemoryLeaseStore,
  oid: string,
  rewrite: (record: Record<string, unknown>) => void,
): void {
  const commit = store.commits.get(oid)!;
  const prefix = "Factory-Repository-Lease: ";
  const lines = commit.message.split("\n");
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const record = JSON.parse(
    Buffer.from(lines[index]!.slice(prefix.length), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  rewrite(record);
  lines[index] = `${prefix}${Buffer.from(JSON.stringify(record), "utf8").toString("base64url")}`;
  commit.message = lines.join("\n");
}

describe("repository-controller lease", () => {
  it.each(["createCommit", "compareAndSwapRef"] as const)(
    "rebuilds an unchanged repository lease after one hour of definite quota at %s",
    async (boundary) => {
      const store = new MemoryLeaseStore();
      const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
      const original = await manager.acquire(identity("first"), store.base());
      vi.spyOn(store, boundary).mockRejectedValueOnce(
        new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: 3_600_000 },
          { status: 429 },
        ),
      );
      const renewed = await withGitHubQuotaWait(
        {
          sleep: async (ms) => {
            store.now = new Date(store.now.getTime() + ms);
          },
        },
        () => manager.renew(original),
      );
      expect(renewed).toMatchObject({ controllerId: "first", epoch: original.epoch, sequence: 2 });
      expect(renewed.expiresAt.getTime()).toBe(store.now.getTime() + 60_000);
      expect(store.refs.get(original.ref)).toBe(renewed.oid);
      await expect(manager.assertCurrent(renewed)).resolves.toBeUndefined();
    },
  );

  it("retains strict ordinary expiry and refuses to revive a released repository lease", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const original = await manager.acquire(identity("first"), store.base());
    store.now = new Date(store.now.getTime() + 3_600_000);
    await expect(manager.renew(original)).rejects.toBeInstanceOf(RepositoryLeaseLostError);
    const renewed = await manager.renew(original, { allowExpiredAfterQuota: true });
    const released = await manager.release(renewed);
    await expect(manager.renew(released, { allowExpiredAfterQuota: true })).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
    expect(store.refs.get(original.ref)).toBe(released.oid);
  });

  it("refuses a takeover at the final CAS after the post-quota identity read", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const original = await manager.acquire(identity("first"), store.base());
    store.now = new Date(store.now.getTime() + 3_600_000);
    const compare = store.compareAndSwapRef.bind(store);
    let takeoverOid = "";
    vi.spyOn(store, "compareAndSwapRef").mockImplementationOnce(async (input) => {
      takeoverOid = (
        await manager.acquire(identity("peer", processOwner, digest("b")), store.base())
      ).oid;
      return compare(input);
    });
    await expect(manager.renew(original, { allowExpiredAfterQuota: true })).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
    expect(store.refs.get(original.ref)).toBe(takeoverOid);
    await expect(manager.renew(original, { allowExpiredAfterQuota: true })).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
  });

  it("excludes another controller, renews one epoch, and releases cleanly", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({
      store,
      durationMs: 60_000,
    });
    const first = await manager.acquire(identity("first"), store.base());
    expect(first).toMatchObject({ epoch: 1, sequence: 1 });
    expect(store.refs.has(REPOSITORY_LEASE_REF)).toBe(true);
    await expect(
      manager.acquire(identity("second", processOwner, digest("b")), store.base()),
    ).rejects.toBeInstanceOf(RepositoryLeaseContendedError);

    store.now = new Date("2026-01-01T00:00:10.000Z");
    const renewed = await manager.renew(first);
    expect(renewed).toMatchObject({ epoch: 1, sequence: 2 });
    await expect(manager.assertCurrent(first)).resolves.toBeUndefined();
    expect(store.observations).toBeGreaterThan(0);

    const released = await manager.release(first);
    expect(released).toMatchObject({ epoch: 1, sequence: 3 });
    await expect(manager.assertCurrent(released)).rejects.toBeInstanceOf(RepositoryLeaseLostError);
  });

  it("permits deterministic takeover only after authoritative server expiry", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({
      store,
      durationMs: 30_000,
    });
    const first = await manager.acquire(identity("first"), store.base());
    store.now = new Date("2026-01-01T00:00:30.000Z");
    const second = await manager.acquire(
      identity("second", processOwner, digest("b")),
      store.base(),
    );
    expect(second).toMatchObject({ epoch: 2, sequence: 2 });
    await expect(manager.assertCurrent(first)).rejects.toBeInstanceOf(RepositoryLeaseLostError);
  });

  it("takes over a live lease only for a new invocation of the same managed service", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const predecessor = await manager.acquire(
      identity("predecessor", managedOwner("1".repeat(32))),
      store.base(),
    );
    store.now = new Date("2026-01-01T00:00:10.000Z");

    const successorOwner = managedOwner("2".repeat(32));
    const successor = await manager.acquire(identity("successor", successorOwner), store.base());

    expect(successor).toMatchObject({
      controllerId: "successor",
      owner: successorOwner,
      epoch: 2,
      sequence: 2,
    });
    expect(successor.expiresAt).toEqual(new Date("2026-01-01T00:01:10.000Z"));
    expect(store.refs.get(REPOSITORY_LEASE_REF)).toBe(successor.oid);
    await expect(manager.assertCurrent(predecessor)).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
    await expect(manager.assertCurrent(successor)).resolves.toBeUndefined();
  });

  it("uses the ref-bound authoritative time when a live holder appears after an earlier clock sample", async () => {
    const store = new MemoryLeaseStore();
    store.now = new Date("2026-01-01T00:00:10.000Z");
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const incumbent = await manager.acquire(identity("incumbent"), store.base());
    store.now = new Date("2026-01-01T00:00:00.000Z");
    vi.spyOn(store, "readRefWithServerTime").mockResolvedValueOnce({
      oid: incumbent.oid,
      serverTime: new Date("2026-01-01T00:00:10.000Z"),
    });

    await expect(
      manager.acquire(identity("candidate", processOwner, digest("b")), store.base()),
    ).rejects.toBeInstanceOf(RepositoryLeaseContendedError);
  });

  it.each([
    [
      "the same invocation",
      managedOwner("1".repeat(32)),
      managedOwner("1".repeat(32)),
      digest("a"),
    ],
    ["a manual claimant", managedOwner("1".repeat(32)), processOwner, digest("a")],
    ["a manual holder", processOwner, managedOwner("2".repeat(32)), digest("a")],
    [
      "another host",
      managedOwner("1".repeat(32)),
      managedOwner("2".repeat(32), { hostIdentity: digest("e") }),
      digest("a"),
    ],
    [
      "another unit configuration",
      managedOwner("1".repeat(32)),
      managedOwner("2".repeat(32), { configDigest: digest("e") }),
      digest("a"),
    ],
    [
      "another executable",
      managedOwner("1".repeat(32)),
      managedOwner("2".repeat(32), { executableIdentity: `sha256:${digest("e")}` }),
      digest("a"),
    ],
    [
      "another unit",
      managedOwner("1".repeat(32)),
      managedOwner("2".repeat(32), {
        unit: "clockgrove-factory-fedcba9876543210.service",
      }),
      digest("a"),
    ],
    ["another policy", managedOwner("1".repeat(32)), managedOwner("2".repeat(32)), digest("e")],
  ] as const)(
    "reports ordinary bounded contention for %s",
    async (_case, currentOwner, candidateOwner, candidatePolicy) => {
      const store = new MemoryLeaseStore();
      const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
      const current = await manager.acquire(identity("current", currentOwner), store.base());
      store.now = new Date("2026-01-01T00:00:10.000Z");

      const acquisition = manager.acquire(
        identity("candidate", candidateOwner, candidatePolicy),
        store.base(),
      );
      const error = await acquisition.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RepositoryLeaseContendedError);
      expect(error).not.toBeInstanceOf(RepositoryLeaseLostError);
      expect(error).toMatchObject({
        expiresAt: current.expiresAt,
        observedAt: store.now,
        retryAfterMs: 50_000,
      });
      expect(store.refs.get(REPOSITORY_LEASE_REF)).toBe(current.oid);
      await expect(manager.assertCurrent(current)).resolves.toBeUndefined();
    },
  );

  it("reports the authoritative winner when two managed successors race at the CAS", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const predecessor = await manager.acquire(
      identity("predecessor", managedOwner("1".repeat(32))),
      store.base(),
    );
    const compare = store.compareAndSwapRef.bind(store);
    const winnerIdentity = identity("winner", managedOwner("3".repeat(32)));
    let winnerOid = "";
    vi.spyOn(store, "compareAndSwapRef").mockImplementationOnce(async (input) => {
      winnerOid = (await manager.acquire(winnerIdentity, store.base())).oid;
      return compare(input);
    });

    const acquisition = manager.acquire(
      identity("loser", managedOwner("2".repeat(32))),
      store.base(),
    );
    const error = await acquisition.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RepositoryLeaseContendedError);
    expect(error).not.toBeInstanceOf(RepositoryLeaseLostError);
    expect(error).toMatchObject({ retryAfterMs: 60_000 });
    expect(store.refs.get(REPOSITORY_LEASE_REF)).toBe(winnerOid);
    expect((await manager.read())?.controllerId).toBe("winner");
    await expect(manager.assertCurrent(predecessor)).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
  });

  it("can retry the same handoff after a crash before the takeover CAS", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const predecessor = await manager.acquire(
      identity("predecessor", managedOwner("1".repeat(32))),
      store.base(),
    );
    const successorIdentity = identity("successor", managedOwner("2".repeat(32)));
    vi.spyOn(store, "compareAndSwapRef").mockRejectedValueOnce(new Error("crash before CAS"));

    await expect(manager.acquire(successorIdentity, store.base())).rejects.toThrow(
      "crash before CAS",
    );
    expect(store.refs.get(REPOSITORY_LEASE_REF)).toBe(predecessor.oid);

    const successor = await manager.acquire(successorIdentity, store.base());
    expect(successor).toMatchObject({ controllerId: "successor", epoch: 2, sequence: 2 });
    await expect(manager.assertCurrent(predecessor)).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
  });

  it("renews the same controller identity after a crash following the takeover CAS", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const predecessor = await manager.acquire(
      identity("predecessor", managedOwner("1".repeat(32))),
      store.base(),
    );
    const successorIdentity = identity("successor", managedOwner("2".repeat(32)));
    const compare = store.compareAndSwapRef.bind(store);
    vi.spyOn(store, "compareAndSwapRef").mockImplementationOnce(async (input) => {
      expect(await compare(input)).toBe(true);
      throw new Error("crash after CAS");
    });

    await expect(manager.acquire(successorIdentity, store.base())).rejects.toThrow(
      "crash after CAS",
    );
    expect(await manager.read()).toMatchObject({
      controllerId: "successor",
      epoch: 2,
      sequence: 2,
    });

    const recovered = await manager.acquire(successorIdentity, store.base());
    expect(recovered).toMatchObject({ controllerId: "successor", epoch: 2, sequence: 3 });
    await expect(manager.assertCurrent(predecessor)).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
    await expect(manager.assertCurrent(recovered)).resolves.toBeUndefined();
  });

  it.each([
    [managedOwner("2".repeat(32)), digest("a")],
    [managedOwner("1".repeat(32), { configDigest: digest("e") }), digest("a")],
    [managedOwner("1".repeat(32)), digest("e")],
  ] as const)(
    "does not renew a same-ID claimant with mismatched authority %#",
    async (candidateOwner, candidatePolicy) => {
      const store = new MemoryLeaseStore();
      const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
      const current = await manager.acquire(
        identity("controller", managedOwner("1".repeat(32))),
        store.base(),
      );

      await expect(
        manager.acquire(identity("controller", candidateOwner, candidatePolicy), store.base()),
      ).rejects.toBeInstanceOf(RepositoryLeaseContendedError);
      expect(store.refs.get(REPOSITORY_LEASE_REF)).toBe(current.oid);
      await expect(manager.assertCurrent(current)).resolves.toBeUndefined();
    },
  );

  it("rejects lease records without the required discriminated owner", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const lease = await manager.acquire(identity("current"), store.base());
    rewriteLeaseRecord(store, lease.oid, (record) => {
      delete record.owner;
    });

    await expect(manager.read()).rejects.toThrow("repository lease record is invalid");
  });

  it("rejects a lease shifted beyond the authoritative server window", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const lease = await manager.acquire(identity("current"), store.base());
    rewriteLeaseRecord(store, lease.oid, (record) => {
      record.at = "2026-01-02T00:00:00.000Z";
      record.expiresAt = "2026-01-02T00:01:00.000Z";
    });

    await expect(manager.acquire(identity("candidate"), store.base())).rejects.toThrow(
      "outside the authoritative server window",
    );
  });

  it("rejects duplicate and noncanonical lease trailers", async () => {
    const duplicateStore = new MemoryLeaseStore();
    const duplicateManager = new RepositoryLeaseManager({
      store: duplicateStore,
      durationMs: 60_000,
    });
    const duplicateLease = await duplicateManager.acquire(
      identity("duplicate"),
      duplicateStore.base(),
    );
    const duplicateCommit = duplicateStore.commits.get(duplicateLease.oid)!;
    duplicateCommit.message += `\n${duplicateCommit.message.split("\n").at(-1)}`;
    await expect(duplicateManager.read()).rejects.toThrow("one bounded lease trailer");

    const encodingStore = new MemoryLeaseStore();
    const encodingManager = new RepositoryLeaseManager({
      store: encodingStore,
      durationMs: 60_000,
    });
    const encodingLease = await encodingManager.acquire(identity("encoding"), encodingStore.base());
    const encodingCommit = encodingStore.commits.get(encodingLease.oid)!;
    encodingCommit.message += "=";
    await expect(encodingManager.read()).rejects.toThrow("trailer encoding is invalid");
  });

  it("binds every noninitial record to its sole immutable commit parent", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 30_000 });
    await manager.acquire(identity("first"), store.base());
    store.now = new Date("2026-01-01T00:00:30.000Z");
    const second = await manager.acquire(identity("second"), store.base());
    const commit = store.commits.get(second.oid)!;

    rewriteLeaseRecord(store, second.oid, (record) => {
      delete record.previousOid;
    });
    await expect(manager.read()).rejects.toThrow("repository lease record is invalid");

    rewriteLeaseRecord(store, second.oid, (record) => {
      record.previousOid = commit.parentOids[0];
    });
    commit.parentOids = ["f".repeat(40)];
    await expect(manager.read()).rejects.toThrow("repository lease record is invalid");

    commit.parentOids = [second.oid, "f".repeat(40)];
    await expect(manager.read()).rejects.toThrow("repository lease record is invalid");
  });

  it.each([
    ["an unknown field", (record: Record<string, unknown>) => Object.assign(record, { extra: 1 })],
    ["an unsafe epoch", (record: Record<string, unknown>) => (record.epoch = 2 ** 53)],
    [
      "an overlong controller ID",
      (record: Record<string, unknown>) => (record.controllerId = "x".repeat(161)),
    ],
    ["a noncanonical event time", (record: Record<string, unknown>) => (record.at = "2026-01-01")],
    [
      "an unbounded live duration",
      (record: Record<string, unknown>) => (record.expiresAt = "2026-01-01T01:00:00.000Z"),
    ],
    ["an invalid previous OID", (record: Record<string, unknown>) => (record.previousOid = "bad")],
    [
      "an impossible predecessor on the initial acquisition",
      (record: Record<string, unknown>) => (record.previousOid = "1".repeat(40)),
    ],
    [
      "a sequence behind the epoch",
      (record: Record<string, unknown>) =>
        Object.assign(record, { epoch: 9, sequence: 1, previousOid: "1".repeat(40) }),
    ],
    [
      "a renewal without sequence advancement",
      (record: Record<string, unknown>) =>
        Object.assign(record, {
          event: "RepositoryLeaseRenewed",
          previousOid: "1".repeat(40),
        }),
    ],
  ])("rejects a record with %s", async (_case, rewrite) => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });
    const lease = await manager.acquire(identity("current"), store.base());
    rewriteLeaseRecord(store, lease.oid, rewrite);

    await expect(manager.read()).rejects.toThrow("repository lease record is invalid");
  });

  it("bounds the configured lease duration used by ordinary contention", () => {
    const store = new MemoryLeaseStore();
    expect(
      () =>
        new RepositoryLeaseManager({
          store,
          durationMs: DEFAULT_REPOSITORY_LEASE_DURATION_MS + 1,
        }),
    ).toThrow("between 30 seconds and 10 minutes");
  });

  it.each([
    undefined,
    { kind: "process", invocationId: "1".repeat(32) },
    { ...managedOwner("1".repeat(32)), invocationId: "not-an-invocation" },
    { ...managedOwner("1".repeat(32)), executableIdentity: digest("d") },
    { ...managedOwner("1".repeat(32)), hostIdentity: digest("B") },
  ])("rejects malformed owner input %#", async (owner) => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({ store, durationMs: 60_000 });

    await expect(
      manager.acquire(
        { controllerId: "candidate", policyDigest: digest("a"), owner } as RepositoryLeaseIdentity,
        store.base(),
      ),
    ).rejects.toThrow("repository lease owner is invalid");
    expect(store.refs.has(REPOSITORY_LEASE_REF)).toBe(false);
  });
});
