import { expect, it, vi } from "vitest";
import { capacityReservationKey } from "../src/scheduling/capacity-ledger.js";

const BASE = "a".repeat(40);
const DIGEST = "b".repeat(64);
const limits = {
  maxParallel: 1,
  maxLocalParallel: 1,
  maxCloudParallel: 0,
  backendMaxParallel: {},
  cpuCapacity: 1,
  memoryCapacityMb: 1024,
  maxPaidUnits: 0,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class Server {
  refs = new Map<string, string>();
  commits = new Map([
    [BASE, { sha: BASE, tree: { sha: BASE }, parents: [] as { sha: string }[], message: "base" }],
  ]);
  next = 1;
  cas: { owner: string; before: string; after: string; accepted: boolean }[] = [];
  contention = false;
  firstCas: (() => void) | undefined;
  loseNextAccepted = false;
  refuseOwner: string | undefined;
  requests = new Map<string, number>();
  remaining = 10000;
  fetch(owner: string): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== "https://api.github.com") throw new Error("real network forbidden");
      this.requests.set(owner, (this.requests.get(owner) ?? 0) + 1);
      this.remaining--;
      const reply = (value: unknown, status = 200, headers = {}) =>
        Response.json(value, {
          status,
          headers: {
            date: new Date().toUTCString(),
            "x-ratelimit-limit": "10000",
            "x-ratelimit-remaining": String(this.remaining),
            "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
            ...headers,
          },
        });
      if (this.refuseOwner === owner) {
        this.refuseOwner = undefined;
        return reply({ message: "secondary rate limit" }, 429, { "retry-after": "60" });
      }
      const path = decodeURIComponent(url.pathname).replace("/repos/fixture/project", "");
      const data = (request.method === "POST" ? await request.json() : {}) as {
        query: string;
        variables: { name: string; beforeOid: string; afterOid: string };
        ref: string;
        sha: string;
        tree: string;
        parents: string[];
        message: string;
      };
      if (path === "/graphql") {
        if (!data.query.includes("FactoryUpdateRefs"))
          return reply({ data: { repository: { id: "R_fixture" } } });
        const { name, beforeOid, afterOid } = data.variables;
        const apply = () => {
          const accepted = this.refs.get(name) === beforeOid;
          this.cas.push({ owner, before: beforeOid, after: afterOid, accepted });
          if (accepted) this.refs.set(name, afterOid);
          if (accepted && this.loseNextAccepted) {
            this.loseNextAccepted = false;
            throw new Error("accepted response lost");
          }
          return reply(
            accepted
              ? { data: { updateRefs: { clientMutationId: null } } }
              : { errors: [{ message: "CAS conflict" }] },
          );
        };
        if (this.contention && !this.firstCas) {
          return new Promise<Response>((resolve) => {
            this.firstCas = () => resolve(apply());
          });
        }
        if (this.contention) {
          this.contention = false;
          this.firstCas!();
        }
        return apply();
      }
      if (path.startsWith("/git/ref/")) {
        const oid = this.refs.get(`refs/${path.slice("/git/ref/".length)}`);
        return reply(oid ? { object: { sha: oid } } : { message: "Not Found" }, oid ? 200 : 404);
      }
      if (path === "/git/refs") {
        if (this.refs.has(data.ref)) return reply({ message: "exists" }, 422);
        this.refs.set(data.ref, data.sha);
        return reply({ ref: data.ref, object: { sha: data.sha } });
      }
      if (path.startsWith("/git/commits/")) {
        const value = this.commits.get(path.slice("/git/commits/".length));
        if (!value) throw new Error("missing fixture commit");
        return reply(value);
      }
      if (path === "/git/commits") {
        const sha = (this.next++).toString(16).padStart(40, "0");
        const value = {
          sha,
          tree: { sha: data.tree },
          parents: data.parents.map((sha: string) => ({ sha })),
          message: data.message,
        };
        this.commits.set(sha, value);
        return reply(value);
      }
      if (path === "") return reply({ id: 1 });
      throw new Error(`unsupported fake route ${request.method} ${path}`);
    };
  }
}

async function processContext(server: Server, label: string, objective: number) {
  vi.resetModules();
  const platform = await import("../src/platform.js");
  const { GitHubControlStore } = await import("../src/control/github-store.js");
  const { LeaseManager } = await import("../src/control/lease.js");
  const { SharedCapacityCoordinator } = await import("../src/controller/shared-capacity.js");
  const token = "same-server-credential";
  const scheduler = new platform.MutationScheduler({
    sleep: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
  });
  const store = new GitHubControlStore({
    token,
    owner: "fixture",
    repo: "project",
    requestFetch: server.fetch(label),
    mutationScheduler: scheduler,
  });
  const lease = await new LeaseManager({ store }).acquire(
    { objective, runId: `run-${objective}`, holder: label, policyDigest: DIGEST },
    await store.readCommit(BASE),
  );
  const capacity = new SharedCapacityCoordinator({
    store,
    repository: "fixture/project",
    baseCommitSha: BASE,
    limits,
    assertLegacyCompatible: async () => {},
  });
  const owner = { objective, runId: lease.runId, directorEpoch: lease.epoch, policyDigest: DIGEST };
  const input = {
    objective,
    workItem: objective * 10,
    attempt: 1,
    phase: "execution" as const,
    backendId: "fixture/local",
    admissionClass: "local" as const,
    local: true,
    cpu: 1,
    memoryMb: 128,
    paidUnits: 0,
    paths: [],
    exclusiveResources: [],
  };
  return {
    platform,
    scheduler,
    store,
    capacity,
    owner,
    reservation: { ...input, key: capacityReservationKey(input) },
    governor: platform.primaryQuotaForCredential(token),
  };
}

it("keeps independent process governors usable through slot contention, response loss and owner cancellation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
  let finished = false;
  const workload = (async () => {
    const server = new Server();
    const a = await processContext(server, "a", 7);
    const b = await processContext(server, "b", 8);
    expect(a.governor).not.toBe(b.governor);
    const aRequests =
      a.platform.githubRequestTelemetryForCredential("same-server-credential").endpoints;
    await b.store.readCommit(BASE);
    expect(
      a.platform.githubRequestTelemetryForCredential("same-server-credential").endpoints,
    ).toEqual(aRequests);
    expect(a.platform.GitHubPrimaryQuotaCache).not.toBe(b.platform.GitHubPrimaryQuotaCache);
    await a.capacity.initialize();
    server.contention = true;
    const results = await Promise.all([
      a.capacity.reserve(a.owner, a.reservation, limits),
      b.capacity.reserve(b.owner, b.reservation, limits),
    ]);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(server.cas).toHaveLength(2);
    expect(server.cas[0]!.before).toBe(server.cas[1]!.before);
    expect(server.cas.map((row) => row.accepted)).toEqual([true, false]);
    const winner = results[0]!.reserved ? a : b;
    const loser = winner === a ? b : a;
    const generation = (await loser.capacity.snapshot()).generation;
    await winner.capacity.release(winner.owner, winner.reservation.key);
    expect((await loser.capacity.snapshot()).generation).toBeGreaterThan(generation);
    server.loseNextAccepted = true;
    const before = server.cas.length;
    await expect(
      loser.capacity.reserve(loser.owner, loser.reservation, limits),
    ).rejects.toBeInstanceOf(loser.platform.PlatformUnavailableError);
    // Lost HTTP response opens the existing circuit; wait its floor, then reconcile
    // the same durable claim identity without resending the accepted CAS.
    vi.setSystemTime(Date.now() + 60_000);
    expect((await loser.capacity.reserve(loser.owner, loser.reservation, limits)).reserved).toBe(
      true,
    );
    expect(server.cas).toHaveLength(before + 1);
    expect((await winner.capacity.snapshot()).reservations).toHaveLength(1);

    const stop = new AbortController();
    const asleep = deferred();
    server.refuseOwner = "a";
    const requests = server.requests.get("a")!;
    const waiting = a.platform.withGitHubQuotaWait(
      {
        signal: stop.signal,
        sleep: async (_ms, signal) => {
          asleep.resolve();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
      () => a.store.readCommit(BASE),
    );
    const stopped = waiting.catch((error: unknown) => error);
    await asleep.promise;
    stop.abort(new Error("owner stopped"));
    a.scheduler.stopNormalAdmission();
    expect(await stopped).toMatchObject({ message: "owner stopped" });
    expect(server.requests.get("a")).toBe(requests + 1);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await b.store.readCommit(BASE)).oid).toBe(BASE);
    const prepared = await b.store.createCommit({
      treeOid: BASE,
      parentOids: [BASE],
      message: "peer still usable",
    });
    expect(server.commits.get(prepared)?.message).toBe("peer still usable");
    expect((await b.capacity.snapshot()).reservations).toHaveLength(1);
  })().finally(() => {
    finished = true;
  });
  const settled = workload.catch(() => {});
  try {
    while (!finished) await vi.advanceTimersByTimeAsync(10);
    await settled;
    await workload;
  } finally {
    vi.useRealTimers();
  }
}, 120_000);
