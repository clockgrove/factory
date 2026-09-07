import { afterEach, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseManager } from "../src/control/lease.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { RepositoryLeaseManager } from "../src/controller/repository-lease.js";
import { runGitHubRepositoryController } from "../src/controller/repository-controller.js";
import { ContentCreationPacer, MutationScheduler } from "../src/platform.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

it("the actual Supervisor drains and releases its owned lease after a queued receipt is interrupted by controller stop", async () => {
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
    controllerActivation: true,
  });
  fixtures.push(f);
  const shutdown = new AbortController();
  let reached!: () => void;
  const queued = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const pacer = new ContentCreationPacer(40, 6, 0);
  for (let n = 0; n < 3; n++) pacer.recordCall(new Date(Date.now() - 18 * 60_000));
  const scheduler = new MutationScheduler({
    pacer,
    reservedLeaseMutationsPerHour: 3,
    onThrottle: () => reached(),
  });
  f.repositoryResources.mutationScheduler = scheduler;
  // Physical headroom forces the real planner's queued receipt before any
  // execution admission. Do not substitute a fake Supervisor catch handler.
  f.repositoryResources.resourceSampler = {
    sample: async () => ({
      measuredAt: new Date().toISOString(),
      logicalCpu: 8,
      effectiveCpu: 8,
      loadRatio: 0,
      totalMemoryMb: 32768,
      availableMemoryMb: 0,
      memoryUsageRatio: 1,
      source: "host",
    }),
  };
  const addComment = vi.mocked(GitHubControlStore.prototype.addIssueComment);
  const persist = addComment.getMockImplementation()!;
  let normalDispatched = 0;
  addComment.mockImplementation(async function (this: GitHubControlStore, node, body) {
    if (!decodeEventComments(body).some((event) => event.event === "WorkItemQueued"))
      return persist.call(this, node, body);
    const permit = await scheduler.acquire("normal");
    try {
      permit.assertDispatchAllowed?.();
      normalDispatched++;
      await persist.call(this, node, body);
    } finally {
      permit.release();
    }
  });
  vi.spyOn(GitHubControlStore.prototype, "discoverObjectiveActivations").mockResolvedValue([
    {
      objective: 7,
      activatedAt: new Date().toISOString(),
      requestId: "fixture-activation",
      policy: f.policy,
      policyDigest: "c".repeat(64),
      baseSha: f.snapshot.factoryEvents!.find((event) => event.event === "FactoryRunStarted")!
        .baseSha!,
      requestedBy: "operator",
    },
  ]);
  const acquisition = vi
    .spyOn(RepositoryLeaseManager.prototype, "acquire")
    .mockImplementation(async (identity, base) => ({
      ...identity,
      ref: "refs/clockgrove-factory/leases/repository-controller",
      oid: base.oid,
      treeOid: base.treeOid,
      epoch: 1,
      sequence: 1,
      expiresAt: new Date(Date.now() + 600_000),
    }));
  const retired: string[] = [];
  const objectiveRelease = vi.mocked(LeaseManager.prototype.release);
  objectiveRelease.mockImplementation(async (lease) => {
    expect(lease).toMatchObject({ objective: 7, runId: f.runId, epoch: 1 });
    expect(f.repositoryResources.capacityLedger.snapshot().reservations).toHaveLength(0);
    const permit = await scheduler.acquire("lease");
    permit.assertDispatchAllowed?.();
    permit.release();
    retired.push("objective");
    return lease;
  });
  const repositoryRelease = vi
    .spyOn(RepositoryLeaseManager.prototype, "release")
    .mockImplementation(async (lease) => {
      expect(lease.controllerId).toBe(acquisition.mock.calls[0]![0].controllerId);
      expect(lease.epoch).toBe(1);
      const permit = await scheduler.acquire("lease");
      permit.assertDispatchAllowed?.();
      permit.release();
      retired.push("repository");
      return lease;
    });
  const supervised = vi.fn(async () => {
    await f.run(shutdown.signal);
  });
  const task = runGitHubRepositoryController({
    token: "fixture-only",
    owner: "fixture",
    repo: "provider-qualification",
    repository: f.repository,
    signal: shutdown.signal,
    resources: f.repositoryResources,
    supervisorFactory: () => ({ run: supervised }),
    pollIntervalMs: 20,
  });
  const outcome = task.then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.race([
    queued,
    outcome.then((error) => {
      throw error ?? new Error("controller returned before the queued receipt boundary");
    }),
  ]);
  expect(pacer.waitMs(new Date(), { hourlyReserve: 3 })).toBeGreaterThan(41 * 60_000);
  shutdown.abort();
  expect(await outcome).toBeUndefined();
  expect(retired).toEqual(["objective", "repository"]);
  expect(objectiveRelease).toHaveBeenCalledTimes(1);
  expect(repositoryRelease).toHaveBeenCalledTimes(1);
  expect(acquisition).toHaveBeenCalledTimes(1);
  expect(supervised).toHaveBeenCalledTimes(1);
  expect(normalDispatched).toBe(0);
  expect(f.resources.size).toBe(0);
  expect(
    f.activity.some((event) => ["launch", "validate", "review"].includes(event.operation)),
  ).toBe(false);
  expect(
    f
      .events()
      .some((event) =>
        [
          "AttemptReserved",
          "WorkItemQueued",
          "FactoryRunCancelled",
          "FactoryRunCompleted",
          "FactoryRunEscalated",
        ].includes(event.event),
      ),
  ).toBe(false);
});
