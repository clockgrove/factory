import { afterEach, expect, it, vi } from "vitest";

import {
  LeaseManager,
  leaseEventFromCommit,
  type GitCommitObject,
  type LeaseStore,
} from "../src/control/lease.js";
import {
  PlatformUnavailableError,
  retryGitHubQuota,
  withGitHubQuotaWait,
} from "../src/platform.js";
import { LeaseController } from "../src/supervisor.js";

afterEach(() => vi.useRealTimers());

it("releases the lease mutex before quota refresh renews and retries release from that fresh lease", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
  const baseOid = "a".repeat(40);
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>([
    [
      baseOid,
      { oid: baseOid, treeOid: baseOid, parentOids: [], message: "base", serverTime: new Date() },
    ],
  ]);
  let next = 1;
  let refuseRelease = false;
  let transportedCommits = 0;
  const store: LeaseStore = {
    async readRef(ref) {
      return refs.get(ref) ?? null;
    },
    async readCommit(oid) {
      const commit = commits.get(oid);
      if (!commit) throw new Error("missing commit");
      return commit;
    },
    async serverTime() {
      return new Date();
    },
    async createCommit(input) {
      // Match the store-local retry boundary: an outer logical lease release
      // must receive the refusal and drop its mutex before the quota refresh.
      return retryGitHubQuota(async () => {
        transportedCommits++;
        if (refuseRelease) {
          refuseRelease = false;
          throw new PlatformUnavailableError(
            { kind: "rate_limit", retryAfterMs: 3_600_000 },
            { status: 429 },
          );
        }
        const oid = (next++).toString(16).padStart(40, "0");
        commits.set(oid, { ...input, oid, serverTime: new Date() });
        return oid;
      });
    },
    async createRef(ref, oid) {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
    async compareAndSwapRef({ ref, beforeOid, afterOid }) {
      if (refs.get(ref) !== beforeOid) return false;
      refs.set(ref, afterOid);
      return true;
    },
  };
  const manager = new LeaseManager({ store, durationMs: 60_000 });
  const acquired = await manager.acquire(
    { objective: 42, runId: "run-1", holder: "host-1", policyDigest: "b".repeat(64) },
    await store.readCommit(baseOid),
  );
  let sequence = acquired.sequence;
  const controller = new LeaseController(manager, acquired, { take: () => ++sequence });
  const refresh = vi.fn(async () => controller.renewIfNeeded(false, true));
  const sleeps = vi.fn(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  });
  refuseRelease = true;
  await withGitHubQuotaWait({ beforeRetry: refresh, sleep: sleeps }, () => controller.release());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(sleeps).toHaveBeenCalledExactlyOnceWith(3_600_000, undefined);
  const leaseCommits = [...commits.values()].filter((commit) => commit.oid !== baseOid);
  const events = leaseCommits.map(leaseEventFromCommit);
  expect(events.map((event) => event.event)).toEqual([
    "LeaseAcquired",
    "LeaseRenewed",
    "LeaseReleased",
  ]);
  expect(events[1]).toMatchObject({
    at: new Date().toISOString(),
    previousOid: acquired.oid,
    epoch: acquired.epoch,
  });
  expect(events[2]).toMatchObject({ previousOid: leaseCommits[1]!.oid, epoch: acquired.epoch });
  expect(refs.get(acquired.ref)).toBe(leaseCommits[2]!.oid);
  expect(transportedCommits).toBe(4);
}, 2_000);
