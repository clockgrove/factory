import { describe, expect, it, vi } from "vitest";

import {
  LeaseLostError,
  LeaseManager,
  leaseEventFromCommit,
  type GitCommitObject,
  type LeaseStore,
} from "../src/control/lease.js";
import { PlatformUnavailableError, withGitHubQuotaWait } from "../src/platform.js";

const baseOid = "a".repeat(40);
const identity = {
  objective: 42,
  runId: "run-1",
  holder: "host-1",
  policyDigest: "b".repeat(64),
};
const hour = 3_600_000;

class Store implements LeaseStore {
  now = new Date("2026-09-12T00:00:00Z");
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([
    [
      baseOid,
      { oid: baseOid, treeOid: baseOid, parentOids: [], message: "base", serverTime: this.now },
    ],
  ]);
  next = 1;
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error("missing commit");
    return commit;
  }
  async serverTime() {
    return this.now;
  }
  async createCommit(input: { treeOid: string; parentOids: string[]; message: string }) {
    const oid = (this.next++).toString(16).padStart(40, "0");
    this.commits.set(oid, { ...input, oid, serverTime: this.now });
    return oid;
  }
  async createRef(ref: string, oid: string) {
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }
  async compareAndSwapRef(input: { ref: string; beforeOid: string; afterOid: string }) {
    if (this.refs.get(input.ref) !== input.beforeOid) return false;
    this.refs.set(input.ref, input.afterOid);
    return true;
  }
}
const quota = () =>
  new PlatformUnavailableError({ kind: "rate_limit", retryAfterMs: hour }, { status: 429 });
async function fixture() {
  const store = new Store();
  const manager = new LeaseManager({ store, durationMs: 60_000 });
  const lease = await manager.acquire(identity, await store.readCommit(baseOid));
  return { store, manager, lease };
}

describe("Objective lease renewal after quota waiting", () => {
  it.each(["serverTime", "createCommit", "compareAndSwapRef"] as const)(
    "rebuilds the complete renewal with fresh expiry after a one-hour refusal at %s",
    async (boundary) => {
      const { store, manager, lease } = await fixture();
      const refusal = vi.spyOn(store, boundary).mockRejectedValueOnce(quota());
      const sleep = vi.fn(async (ms: number) => {
        store.now = new Date(store.now.getTime() + ms);
      });
      const renewed = await withGitHubQuotaWait({ sleep }, () => manager.renew(lease));
      expect(sleep).toHaveBeenCalledExactlyOnceWith(hour, undefined);
      expect(refusal.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(renewed).toMatchObject({
        ...identity,
        epoch: lease.epoch,
        sequence: lease.sequence + 1,
      });
      expect(renewed.expiresAt.getTime()).toBe(store.now.getTime() + 60_000);
      expect(store.refs.get(lease.ref)).toBe(renewed.oid);
      const persisted = await store.readCommit(renewed.oid);
      expect(leaseEventFromCommit(persisted)).toMatchObject({
        event: "LeaseRenewed",
        at: store.now.toISOString(),
        previousOid: lease.oid,
      });
      // A CAS refusal leaves an unused preparation, whose pre-wait deadline must
      // never become the published renewal after the hour has passed.
      if (boundary === "compareAndSwapRef") {
        const renewals = [...store.commits.values()]
          .filter((commit) => commit.oid !== baseOid)
          .map((commit) => ({ commit, event: leaseEventFromCommit(commit) }))
          .filter(({ event }) => event.event === "LeaseRenewed");
        expect(renewals).toHaveLength(2);
        expect(Date.parse(renewals[0]!.event.expiresAt)).toBeLessThan(store.now.getTime());
        expect(renewals[1]!.commit).toBe(persisted);
      }
      await expect(manager.assertCurrent(renewed)).resolves.toBeUndefined();
    },
  );

  it("keeps ordinary expiry strict and permits only the explicit post-quota renewal path", async () => {
    const { store, manager, lease } = await fixture();
    store.now = new Date(store.now.getTime() + hour);
    await expect(manager.renew(lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(manager.assertCurrent(lease)).rejects.toBeInstanceOf(LeaseLostError);
    const renewed = await manager.renew(lease, undefined, { allowExpiredAfterQuota: true });
    expect(renewed).toMatchObject({ ...identity, epoch: lease.epoch, sequence: 2 });
  });

  it("does not revive a released lease even when its exact OID is supplied", async () => {
    const { store, manager, lease } = await fixture();
    const released = await manager.release(lease);
    store.now = new Date(store.now.getTime() + hour);
    await expect(
      manager.renew(released, undefined, { allowExpiredAfterQuota: true }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(store.refs.get(lease.ref)).toBe(released.oid);
  });

  it("rejects a takeover during the quota wait before making another renewal commit", async () => {
    const { store, manager, lease } = await fixture();
    vi.spyOn(store, "createCommit").mockRejectedValueOnce(quota());
    let takeoverOid = "";
    const sleep = async (ms: number) => {
      store.now = new Date(store.now.getTime() + ms);
      const takeover = await manager.acquire(
        { ...identity, holder: "peer" },
        await store.readCommit(baseOid),
      );
      takeoverOid = takeover.oid;
    };
    await expect(withGitHubQuotaWait({ sleep }, () => manager.renew(lease))).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(store.refs.get(lease.ref)).toBe(takeoverOid);
    expect(store.commits.size).toBe(3);
  });

  it("loses CAS when another owner takes over after the post-quota identity read", async () => {
    const { store, manager, lease } = await fixture();
    store.now = new Date(store.now.getTime() + hour);
    const compare = store.compareAndSwapRef.bind(store);
    let takeoverOid = "";
    vi.spyOn(store, "compareAndSwapRef").mockImplementationOnce(async (input) => {
      const takeover = await manager.acquire(
        { ...identity, holder: "peer" },
        await store.readCommit(baseOid),
      );
      takeoverOid = takeover.oid;
      return compare(input);
    });
    await expect(
      manager.renew(lease, undefined, { allowExpiredAfterQuota: true }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(store.refs.get(lease.ref)).toBe(takeoverOid);
  });

  it.each([
    new Error("ambiguous transport timeout"),
    new PlatformUnavailableError(
      { kind: "server_error", retryAfterMs: hour },
      new Error("HTTP 503"),
    ),
  ])("does not retry an uncertain renewal outcome: %s", async (failure) => {
    const { store, manager, lease } = await fixture();
    const compare = vi.spyOn(store, "compareAndSwapRef").mockRejectedValueOnce(failure);
    const sleep = vi.fn();
    await expect(withGitHubQuotaWait({ sleep }, () => manager.renew(lease))).rejects.toBe(failure);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(store.refs.get(lease.ref)).toBe(lease.oid);
  });
});
