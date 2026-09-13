import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, withGitHubQuotaWait } from "../src/platform.js";
import { LeaseManager } from "../src/control/lease.js";
import { GitHubControlStore } from "../src/control/github-store.js";

const OID = "a".repeat(40);
const TREE = "b".repeat(40);
const DATE = "Sun, 13 Sep 2026 00:00:00 GMT";
function commit(oid = OID, message = "immutable") {
  return {
    sha: oid,
    tree: { sha: TREE },
    parents: [{ sha: TREE }],
    message,
    committer: { date: DATE },
  };
}
function store(fetcher: typeof fetch) {
  return new GitHubControlStore({
    token: "content-fixture",
    owner: "o",
    repo: "r",
    requestFetch: fetcher,
  });
}
afterEach(() => vi.useRealTimers());
async function finish<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  const result = pending
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      done = true;
    });
  for (let ticks = 0; !done && ticks < 2000; ticks++) await vi.advanceTimersByTimeAsync(10);
  if (!done) throw new Error("content test did not settle");
  const settled = await result;
  if ("error" in settled) throw settled.error;
  return settled.value;
}

describe("immutable commit content transport", () => {
  it("observes current provider time and changed lease content through warm reads", async () => {
    vi.useFakeTimers();
    let date = DATE,
      oid = OID;
    let contentReads = 0;
    const event = {
      protocol: "clockgrove.factory/v2",
      kind: "lease",
      event: "LeaseAcquired",
      objective: 42,
      runId: "fixture",
      holder: "owner",
      epoch: 1,
      sequence: 1,
      at: new Date(DATE).toISOString(),
      expiresAt: "2026-09-13T00:10:00Z",
      policyDigest: "b".repeat(64),
    };
    const port = store(async (input, init) => {
      if (new URL(new Request(input, init).url).pathname.includes("/git/ref/"))
        return Response.json({ object: { sha: oid } }, { headers: { date } });
      contentReads++;
      return Response.json(
        commit(
          oid,
          `Factory-Event: ${Buffer.from(JSON.stringify({ ...event, epoch: oid === OID ? 1 : 2 })).toString("base64url")}`,
        ),
        { headers: { date } },
      );
    });
    const leases = new LeaseManager({ store: port });
    const first = await finish(leases.readObserved(42));
    date = "Sun, 13 Sep 2026 00:11:00 GMT";
    const warm = await finish(leases.readObserved(42));
    expect(warm.serverTime.getTime()).toBe(Date.parse(date));
    expect(contentReads).toBe(1);
    await expect(finish(leases.assertCurrent(first.lease!))).rejects.toThrow("lease was lost");
    oid = TREE;
    expect((await finish(leases.readObserved(42))).lease!.epoch).toBe(2);
    expect(contentReads).toBe(2);
  });

  it("does not let one coalesced caller's cancellation poison its peer", async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    let reads = 0;
    const port = new GitHubControlStore({
      token: "content-cancellation-fixture",
      owner: "o",
      repo: "r",
      circuitBreaker: new CircuitBreaker(),
      requestFetch: async () => {
        reads++;
        if (reads === 1) {
          cancelled.abort(new Error("owner stopped"));
          return Response.json(
            { message: "secondary rate limit" },
            { status: 429, headers: { date: DATE, "retry-after": "1" } },
          );
        }
        return Response.json(commit(), { headers: { date: DATE } });
      },
    });
    const stopped = withGitHubQuotaWait({ signal: cancelled.signal }, () =>
      port.readCommitContent(OID),
    );
    const peer = withGitHubQuotaWait({}, () => port.readCommitContent(OID));
    const outcomes = await finish(Promise.allSettled([stopped, peer]));
    expect(outcomes[0]!.status).toBe("rejected");
    expect(outcomes[1]!.status).toBe("fulfilled");
    expect(reads).toBe(2);
    expect(port.commitContentTelemetry().entries).toBe(1);
  });

  it("bounds distinct in-flight reads without duplicating a retained entry", async () => {
    const port = store(async () => {
      throw new Error("unexpected transport");
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(port, "readCommit").mockImplementation(async (oid) => {
      await waiting;
      return { oid, treeOid: TREE, parentOids: [], message: "content", serverTime: new Date(DATE) };
    });
    const requests = Array.from({ length: 256 }, (_, index) =>
      port.readCommitContent(index.toString(16).padStart(40, "0")),
    );
    const overflow = [port.readCommitContent(OID), port.readCommitContent(OID)];
    release();
    await Promise.all([...requests, ...overflow]);
    expect(port.commitContentTelemetry().entries).toBe(256);
  });

  it("coalesces content, isolates returned arrays/dates and keeps readCommit time fresh", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let date = DATE;
    const port = store(async () => {
      reads++;
      return Response.json(commit(), { headers: { date } });
    });
    const [one, two] = await finish(
      Promise.all([port.readCommitContent(OID), port.readCommitContent(OID)]),
    );
    expect(reads).toBe(1);
    expect(one).not.toHaveProperty("serverTime");
    one.parentOids.length = 0;
    one.committedAt!.setTime(0);
    expect(two.parentOids).toEqual([TREE]);
    expect((await port.readCommitContent(OID)).committedAt!.getTime()).toBe(Date.parse(DATE));
    date = "Sun, 13 Sep 2026 00:01:00 GMT";
    expect((await finish(port.readCommit(OID))).serverTime.getTime()).toBe(Date.parse(date));
    expect(reads).toBe(2);
    expect(port.commitContentTelemetry()).toMatchObject({
      misses: 1,
      coalesced: 1,
      hits: 1,
      entries: 1,
    });
  });

  it("does not retain mismatched, incomplete or denied content and does not share across stores", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let response: unknown = commit(TREE);
    let status = 200;
    const fetcher: typeof fetch = async () => {
      reads++;
      return Response.json(response, { status, headers: { date: DATE } });
    };
    const port = store(fetcher);
    await expect(finish(port.readCommitContent(OID))).rejects.toThrow("mismatch");
    response = { sha: OID };
    await expect(finish(port.readCommitContent(OID))).rejects.toThrow();
    status = 404;
    await expect(finish(port.readCommitContent(OID))).rejects.toThrow();
    status = 200;
    response = commit();
    await finish(port.readCommitContent(OID));
    await finish(store(fetcher).readCommitContent(OID));
    expect(reads).toBe(5);
    expect(port.commitContentTelemetry().entries).toBe(1);
  });

  it("evicts by bytes and refetches discarded content", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const port = store(async (input, init) => {
      reads++;
      const oid = new URL(new Request(input, init).url).pathname.split("/").at(-1)!;
      return Response.json(commit(oid, "x".repeat(3 * 1024 * 1024)), { headers: { date: DATE } });
    });
    for (const oid of [OID, TREE, "c".repeat(40), OID]) await finish(port.readCommitContent(oid));
    expect(reads).toBe(4);
    expect(port.commitContentTelemetry()).toMatchObject({ entries: 2, evictions: 2 });
    expect(port.commitContentTelemetry().peakBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
