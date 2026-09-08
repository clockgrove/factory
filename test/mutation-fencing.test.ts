import { expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { observeLeaseAssertion } from "../src/control/mutation-observation.js";
import { ContentCreationPacer, MutationScheduler } from "../src/platform.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scheduler() {
  let now = Date.parse("2026-01-01T00:00:00Z");
  return new MutationScheduler({
    pacer: new ContentCreationPacer(80, 500, 0),
    now: () => new Date(now),
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
}

const response = () =>
  new Response(JSON.stringify({ sha: "a".repeat(40) }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
const write = (store: GitHubControlStore) =>
  store.createCommit({
    treeOid: "b".repeat(40),
    parentOids: [],
    message: "synthetic Objective receipt",
  });

it("captures Objective authority before quota queueing and rejects stale queued writes", async () => {
  const mutations = scheduler();
  const blocker = await mutations.acquire();
  let epoch = 1;
  let transports = 0;
  const store = new GitHubControlStore({
    token: "queued-objective-fixture",
    owner: "fixture",
    repo: "project",
    mutationScope: "objective:1",
    mutationScheduler: mutations,
    captureMutationFence: () => {
      const captured = epoch;
      return async () => {
        observeLeaseAssertion();
        if (epoch !== captured) throw new Error("stale Objective epoch");
      };
    },
    requestFetch: async () => {
      transports++;
      return response();
    },
  });
  const pending = write(store);
  const outcome = expect(pending).rejects.toThrow("stale Objective epoch");
  epoch = 2;
  blocker.release();
  await outcome;
  expect(transports).toBe(0);
  expect(store.mutationOperationTelemetry().records).toEqual([
    expect.objectContaining({
      operation: "createCommit",
      resourceScope: "objective:1",
      leaseAssertions: 1,
      mutationRequests: 0,
      readRequests: 0,
      outcome: "failed",
    }),
  ]);
});

it("releases quota admission at dispatch so independent Objectives overlap remote writes", async () => {
  const mutations = scheduler();
  const firstStarted = deferred(),
    releaseFirst = deferred(),
    secondStarted = deferred();
  const make = (objective: number) =>
    new GitHubControlStore({
      token: `independent-objective-${objective}`,
      owner: "fixture",
      repo: "project",
      mutationScope: `objective:${objective}`,
      mutationScheduler: mutations,
      captureMutationFence: () => async () => {
        observeLeaseAssertion();
      },
      requestFetch: async () => {
        if (objective === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else secondStarted.resolve();
        return response();
      },
    });
  const firstStore = make(1),
    secondStore = make(2);
  const first = write(firstStore);
  await firstStarted.promise;
  const second = write(secondStore);
  try {
    await secondStarted.promise;
    await second;
    expect(mutations.telemetry()).toMatchObject({ transported: 2, successful: 1 });
    expect(secondStore.mutationOperationTelemetry().records[0]).toMatchObject({
      resourceScope: "objective:2",
      leaseAssertions: 1,
      mutationRequests: 1,
      outcome: "succeeded",
    });
  } finally {
    releaseFirst.resolve();
    await first;
  }
});

it("counts actual fence reads per operation and excludes unrelated reads and diagnostic failures", async () => {
  let store!: GitHubControlStore;
  store = new GitHubControlStore({
    token: "operation-count-fixture",
    owner: "fixture",
    repo: "project",
    mutationScope: "objective:3",
    mutationScheduler: scheduler(),
    captureMutationFence: () => async () => {
      observeLeaseAssertion();
      await store.readRefWithServerTime("refs/clockgrove-factory/leases/objective-3");
    },
    onMutationOperation: () => {
      throw new Error("diagnostics must not invalidate publication");
    },
    requestFetch: async (_url, init) =>
      init?.method === "GET"
        ? new Response(JSON.stringify({ object: { sha: "c".repeat(40) } }), {
            headers: { "content-type": "application/json", date: "Tue, 08 Sep 2026 00:00:00 GMT" },
          })
        : response(),
  });
  await store.readRef("refs/heads/main");
  await write(store);
  const telemetry = store.mutationOperationTelemetry();
  expect(telemetry.records).toHaveLength(1);
  expect(telemetry.records[0]).toMatchObject({
    measurementScope: "process-local-transport-boundary",
    operation: "createCommit",
    leaseAssertions: 1,
    readRequests: 1,
    fenceReadRequests: 1,
    mutationRequests: 1,
    unclassifiedRequests: 0,
    outcome: "succeeded",
  });
  expect(telemetry.records[0]!.fenceMs).toBeGreaterThanOrEqual(0);
  expect(telemetry.records[0]!.elapsedMs).toBeGreaterThanOrEqual(telemetry.records[0]!.fenceMs);
  expect(telemetry.droppedRecords).toBe(0);
});
