import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { RepositoryLeaseManager } from "../src/controller/repository-lease.js";
import { SharedCapacityCoordinator } from "../src/controller/shared-capacity.js";
import { runGitHubRepositoryController } from "../src/controller/repository-controller.js";
import { createRepositorySupervisorResources } from "../src/supervisor.js";
import {
  ContentCreationPacer,
  MutationAdmissionStoppedError,
  MutationScheduler,
} from "../src/platform.js";

vi.mock("../src/supervisor.js", async (original) => ({
  ...(await original<typeof import("../src/supervisor.js")>()),
  verifyLocalRepository: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.spyOn(SharedCapacityCoordinator.prototype, "initialize").mockResolvedValue();
  vi.spyOn(GitHubControlStore.prototype, "readRef").mockResolvedValue("c".repeat(40));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advanceUntil(observed: () => boolean, maximumMs = 10_000) {
  // Octokit's real throttling wrapper schedules several successive timers.
  // Advance them only until the named boundary, never to the 42-minute reset.
  for (let elapsed = 0; elapsed < maximumMs && !observed(); elapsed += 100)
    await vi.advanceTimersByTimeAsync(100);
  expect(observed()).toBe(true);
}

function setup(input: { paced?: boolean; fetch?: typeof globalThis.fetch } = {}) {
  const abort = new AbortController();
  const resources = createRepositorySupervisorResources();
  const pacer = new ContentCreationPacer(40, 6, 0);
  if (input.paced) pacer.recordCall(new Date());
  const recordCall = vi.spyOn(pacer, "recordTransported");
  let pacingObserved = false;
  resources.mutationScheduler = new MutationScheduler({
    pacer,
    onThrottle: () => {
      pacingObserved = true;
    },
  });
  const request = vi.fn(
    input.fetch ??
      (async () =>
        new Response(JSON.stringify({ sha: "d".repeat(40) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })),
  );
  const store = new GitHubControlStore({
    token: "fixture-only",
    owner: "fixture",
    repo: "fixture",
    requestFetch: request,
    mutationScheduler: resources.mutationScheduler,
    circuitBreaker: resources.circuitBreaker,
    concurrency: resources.concurrency,
  });
  vi.spyOn(GitHubControlStore.prototype, "getRepositoryFacts").mockResolvedValue({
    defaultBranch: "main",
  } as never);
  vi.spyOn(GitHubControlStore.prototype, "getBranchHead").mockResolvedValue({
    oid: "a".repeat(40),
    treeOid: "b".repeat(40),
  } as never);
  vi.spyOn(GitHubControlStore.prototype, "discoverObjectiveActivations").mockResolvedValue([
    {
      objective: 1,
      activatedAt: new Date().toISOString(),
      requestId: "approved",
      policy: {},
      policyDigest: "c".repeat(64),
      baseSha: "a".repeat(40),
      requestedBy: "operator",
    },
  ]);
  const acquire = vi
    .spyOn(RepositoryLeaseManager.prototype, "acquire")
    .mockImplementation(async (identity) => ({
      ...identity,
      ref: "refs/clockgrove-factory/leases/repository-controller",
      oid: "a".repeat(40),
      treeOid: "b".repeat(40),
      epoch: 1,
      sequence: 1,
      expiresAt: new Date(Date.now() + 600_000),
    }));
  const release = vi
    .spyOn(RepositoryLeaseManager.prototype, "release")
    .mockImplementation(async (lease) => {
      expect(lease.epoch).toBe(1);
      expect(lease.controllerId).toBe(acquire.mock.calls[0]![0].controllerId);
      await store.withMutationClass("lease", () =>
        store.createCommit({
          treeOid: lease.treeOid,
          parentOids: [lease.oid],
          message: "Factory repository-controller lease release",
        }),
      );
      return lease;
    });
  const run = (operation: () => Promise<void>) =>
    runGitHubRepositoryController({
      token: "fixture-only",
      owner: "fixture",
      repo: "fixture",
      repository: "/fixture",
      signal: abort.signal,
      resources,
      pollIntervalMs: 1_000,
      supervisorFactory: () => ({ run: operation }),
    });
  const normal = () =>
    store.stackRequest(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: "fixture",
        repo: "fixture",
        issue_number: 1,
        body: "queued normal observation",
      },
      true,
    );
  return {
    abort,
    resources,
    pacer,
    recordCall,
    request,
    store,
    acquire,
    release,
    run,
    normal,
    pacingObserved: () => pacingObserved,
  };
}

it("stops a smoothed normal pacing wait, settles priority cleanup, and never dispatches it later", async () => {
  const f = setup({ paced: true });
  let cleanupProved = false;
  const task = f.run(async () => {
    try {
      await f.normal();
    } catch (error) {
      if (!(error instanceof MutationAdmissionStoppedError) || !f.abort.signal.aborted) throw error;
      // This deliberately empty-resource Objective fixture has no unknown writes
      // or accounting to waive. Retire its exact lease through the real scheduler.
      expect(f.resources.capacityLedger.snapshot().reservations).toHaveLength(0);
      await f.store.withMutationClass("cleanup", () =>
        f.store.createRef("refs/clockgrove-factory/leases/objective-1", "a".repeat(40)),
      );
      cleanupProved = true;
    }
  });
  await advanceUntil(f.pacingObserved);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.pacer.waitMs(new Date())).toBeGreaterThan(11 * 60_000);
  const pendingLease = await f.resources.mutationScheduler.acquire("lease");
  pendingLease.release();
  let settled = false;
  const outcome = task.finally(() => {
    settled = true;
  });
  f.abort.abort();
  await advanceUntil(() => settled);
  await outcome;
  expect(cleanupProved).toBe(true);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(2); // Only Objective/repository lease writes.
  expect(f.resources.mutationScheduler.telemetry().transported).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(3_600_001);
  await expect(f.normal()).rejects.toBeInstanceOf(MutationAdmissionStoppedError);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.recordCall).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "waits for admitted transport after stop and preserves its actual outcome (refused: %s)",
  async (refused) => {
    const response = deferred();
    let entered = false;
    const f = setup({
      fetch: async (url) => {
        if (String(url).includes("/comments")) {
          entered = true;
          await response.promise;
          return new Response(
            JSON.stringify(refused ? { message: "fixture unavailable" } : { id: 1 }),
            {
              status: refused ? 503 : 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ sha: "d".repeat(40) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    let settled = false;
    const task = f.run(async () => {
      await f.normal();
    });
    const outcome = task.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await advanceUntil(() => entered);
    f.abort.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    response.resolve();
    // The production Octokit retry plugin retains an already-dispatched 503
    // operation for three retries: 1 + 4 + 9 seconds, plus throttling timers.
    // This is one unresolved admission, not four new scheduler admissions.
    await advanceUntil(() => settled, refused ? 30_000 : 10_000);
    const failure = await outcome;
    if (refused)
      expect(failure).toMatchObject({
        message: expect.stringContaining("unresolved platform failure"),
      });
    else expect(failure).toBeNull();
    // A real refusal retains the shared cooldown and prevents even lease writes;
    // deliberate stop does not claim that this ownership was durably retired.
    expect(f.release).toHaveBeenCalledTimes(refused ? 0 : 1);
    expect(f.request).toHaveBeenCalledTimes(refused ? 1 : 2);
    expect(f.recordCall).toHaveBeenCalledTimes(refused ? 1 : 2);
    expect(f.resources.circuitBreaker.isOpen()).toBe(refused);
    expect(f.acquire).toHaveBeenCalledTimes(1);
  },
);

it("does not hide unresolved cleanup behind a pre-dispatch cancellation", async () => {
  const f = setup({ paced: true });
  const task = f.run(async () => {
    try {
      await f.normal();
    } catch (error) {
      if (error instanceof MutationAdmissionStoppedError)
        throw Error("resource cleanup remains unknown");
      throw error;
    }
  });
  let settled = false;
  const outcome = task
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await advanceUntil(f.pacingObserved);
  f.abort.abort();
  await advanceUntil(() => settled);
  expect(await outcome).toMatchObject({
    code: "controller-internal-invariant",
    safeIdentity: "controller-invariant-failure",
  });
  expect(f.request).toHaveBeenCalledTimes(1); // Repository lease retirement only, no claimed Objective cleanup.
});

it("rechecks the permit after an awaited mutation fence and releases it for lease traffic", async () => {
  const f = setup();
  const fence = deferred();
  const request = vi.fn(
    async () => new Response(JSON.stringify({ sha: "d".repeat(40) }), { status: 201 }),
  );
  const store = new GitHubControlStore({
    token: "fixture-only",
    owner: "fixture",
    repo: "fixture",
    mutationScheduler: f.resources.mutationScheduler,
    requestFetch: request,
    beforeMutation: async () => fence.promise,
  });
  const normal = store.createCommit({ treeOid: "a".repeat(40), parentOids: [], message: "normal" });
  const outcome = normal.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1);
  f.resources.mutationScheduler.stopNormalAdmission();
  fence.resolve();
  expect(await outcome).toBeInstanceOf(MutationAdmissionStoppedError);
  expect(request).not.toHaveBeenCalled();
  const lease = await f.resources.mutationScheduler.acquire("lease");
  lease.assertDispatchAllowed?.();
  lease.release();
  expect(f.recordCall).toHaveBeenCalledTimes(0); // Neither permit reached transport.
});

it("removes only queued normal admissions while an in-flight holder still serializes pending lease traffic", async () => {
  const f = setup();
  const active = await f.resources.mutationScheduler.acquire("normal");
  const queued = f.resources.mutationScheduler.acquire("normal");
  const refusal = queued.catch((error: unknown) => error);
  let leaseAdmitted = false;
  const lease = f.resources.mutationScheduler.acquire("lease").then((permit) => {
    leaseAdmitted = true;
    return permit;
  });
  f.resources.mutationScheduler.stopNormalAdmission();
  expect(await refusal).toBeInstanceOf(MutationAdmissionStoppedError);
  expect(leaseAdmitted).toBe(false);
  expect(f.recordCall).toHaveBeenCalledTimes(0);
  active.release();
  (await lease).release();
  expect(leaseAdmitted).toBe(true);
  expect(f.recordCall).toHaveBeenCalledTimes(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("rechecks local discovery retirement beside the Objective fence after a queue wait", async () => {
  const f = setup();
  const active = await f.resources.mutationScheduler.acquire("normal");
  let current = true;
  let objectiveChecks = 0;
  const stale = f.store.withMutationFence(
    async () => {
      objectiveChecks++;
      if (!current) throw new Error("repository-controller observation retired before dispatch");
    },
    () =>
      f.store.stackRequest(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner: "fixture", repo: "fixture", issue_number: 1, body: "stale observation" },
        true,
      ),
  );
  const outcome = stale.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1);
  current = false;
  active.release();
  await expect(outcome).resolves.toMatchObject({
    message: "repository-controller observation retired before dispatch",
  });
  expect(objectiveChecks).toBe(1);
  expect(f.request).not.toHaveBeenCalled();

  const fallback = f.store.stackRequest(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { owner: "fixture", repo: "fixture", issue_number: 1, body: "Objective writer fallback" },
    true,
  );
  await advanceUntil(() => f.request.mock.calls.length === 1);
  await fallback;
  expect(f.request).toHaveBeenCalledTimes(1);
});
