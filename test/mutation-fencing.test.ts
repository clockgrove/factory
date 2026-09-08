import { expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseManager, type LeaseState } from "../src/control/lease.js";
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
const publish = (store: GitHubControlStore, suffix = "fixture") =>
  store.createRef(`refs/heads/${suffix}`, "a".repeat(40));

it("records an already-retired Objective before queueing without any remote read or write", async () => {
  const store = new GitHubControlStore({
    token: "retired-objective-fixture",
    owner: "fixture",
    repo: "project",
    mutationScheduler: scheduler(),
    captureMutationFence: () => {
      throw new Error("retired Objective");
    },
    requestFetch: async () => {
      throw new Error("transport must not run");
    },
  });
  await expect(publish(store)).rejects.toThrow("retired Objective");
  expect(store.mutationOperationTelemetry().records).toEqual([
    expect.objectContaining({ readRequests: 0, mutationRequests: 0, outcome: "failed" }),
  ]);
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
  const pending = publish(store);
  const outcome = expect(pending).rejects.toThrow("stale Objective epoch");
  epoch = 2;
  blocker.release();
  await outcome;
  expect(transports).toBe(0);
  expect(store.mutationOperationTelemetry().records).toEqual([
    expect.objectContaining({
      operation: "createRef",
      authorityClass: "atomic-publication",
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
  const first = publish(firstStore, "objective-1");
  await firstStarted.promise;
  const second = publish(secondStore, "objective-2");
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
  const lease: LeaseState = {
    ref: "refs/clockgrove-factory/leases/objective-3",
    oid: "c".repeat(40),
    treeOid: "b".repeat(40),
    objective: 3,
    runId: "run-3",
    holder: "session-3",
    policyDigest: "d".repeat(64),
    epoch: 1,
    sequence: 1,
    expiresAt: new Date("2026-09-08T00:10:00Z"),
  };
  store = new GitHubControlStore({
    token: "operation-count-fixture",
    owner: "fixture",
    repo: "project",
    mutationScope: "objective:3",
    mutationScheduler: scheduler(),
    captureMutationFence: () => async () => {
      await new LeaseManager({ store }).assertCurrent(lease);
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
  await store.createBlob(Buffer.from("immutable fixture", "utf8"));
  await store.createTree({
    entries: [{ path: "fixture.txt", mode: "100644", type: "blob", sha: "a".repeat(40) }],
  });
  await write(store);
  await publish(store);
  const telemetry = store.mutationOperationTelemetry();
  expect(telemetry.records).toHaveLength(4);
  for (const [index, operation] of ["createBlob", "createTree", "createCommit"].entries()) {
    expect(telemetry.records[index]).toMatchObject({
      measurementScope: "process-local-transport-boundary",
      operation,
      authorityClass: "immutable-preparation",
      leaseAssertions: 0,
      readRequests: 0,
      fenceReadRequests: 0,
      mutationRequests: 1,
      unclassifiedRequests: 0,
      outcome: "succeeded",
    });
  }
  expect(telemetry.records[3]).toMatchObject({
    measurementScope: "process-local-transport-boundary",
    operation: "createRef",
    authorityClass: "atomic-publication",
    leaseAssertions: 1,
    readRequests: 1,
    fenceReadRequests: 1,
    mutationRequests: 1,
    unclassifiedRequests: 0,
    outcome: "succeeded",
  });
  expect(telemetry.records[3]!.fenceMs).toBeGreaterThanOrEqual(0);
  expect(telemetry.records[3]!.elapsedMs).toBeGreaterThanOrEqual(telemetry.records[3]!.fenceMs);
  expect(telemetry.droppedRecords).toBe(0);
});

it("isolates concurrent shared-transaction fences and does not repeat a configured Objective check", async () => {
  const mutations = scheduler();
  const blocker = await mutations.acquire();
  const epochs = new Map([
    [1, 1],
    [2, 1],
  ]);
  let configuredChecks = 0;
  let transports = 0;
  const store = new GitHubControlStore({
    token: "scoped-transaction-fixture",
    owner: "fixture",
    repo: "project",
    mutationScheduler: mutations,
    mutationScope: "shared-resource",
    captureMutationFence: () => async () => {
      configuredChecks++;
    },
    requestFetch: async () => {
      transports++;
      return response();
    },
  });
  const scopedWrite = (objective: number) => {
    const captured = epochs.get(objective);
    return store.withMutationFence(
      async () => {
        observeLeaseAssertion();
        if (epochs.get(objective) !== captured) throw new Error("stale shared-resource owner");
      },
      () => publish(store, `objective-${objective}`),
    );
  };
  const stale = expect(scopedWrite(1)).rejects.toThrow("stale shared-resource owner");
  const unrelated = scopedWrite(2);
  epochs.set(1, 2);
  blocker.release();
  await Promise.all([stale, unrelated]);
  expect(transports).toBe(1);
  expect(configuredChecks).toBe(0);
  expect(store.mutationOperationTelemetry().records).toEqual([
    expect.objectContaining({ leaseAssertions: 1, mutationRequests: 0, outcome: "failed" }),
    expect.objectContaining({ leaseAssertions: 1, mutationRequests: 1, outcome: "succeeded" }),
  ]);
});
