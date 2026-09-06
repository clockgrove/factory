import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { GitHubReader } from "../src/github.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertConcurrent(f: Awaited<ReturnType<typeof providerSupervisorFixture>>) {
  const events = f.events();
  const integrations = events.filter(
    (event) => event.kind === "attempt" && event.event === "AttemptIntegrated",
  );
  expect(integrations).toHaveLength(3);
  for (const number of [8, 9]) {
    const admissions = events.filter(
      (event) =>
        event.kind === "attempt" &&
        event.workItem === number &&
        ["AttemptReserved", "AttemptStarted"].includes(event.event),
    );
    expect(admissions).toHaveLength(2);
    for (const admission of admissions) {
      expect(admission.sequence).toBeLessThan(integrations[0]!.sequence);
    }
  }
  const join = events.find(
    (event) =>
      event.kind === "attempt" && event.event === "AttemptStarted" && event.workItem === 10,
  )!;
  for (const integrated of integrations.filter((event) => event.workItem !== 10))
    expect(join.sequence).toBeGreaterThan(integrated.sequence);
  expect(
    f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.workItem),
  ).toEqual([8, 9, 10]);
  expect(
    f.activity.filter((entry) => entry.operation.endsWith("review")).length,
  ).toBeGreaterThanOrEqual(3);
}

describe("regular delivery owns the complete Supervisor pipeline", () => {
  it.each(["mergeability", "checks"])(
    "runs both independent pipelines during %s waits and joins only after exact integration",
    async (kind) => {
      const shutdown = new AbortController();
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        localMaxParallel: 2,
      });
      let held = true;
      let waits = 0;
      const readPull = vi.mocked(GitHubControlStore.prototype.readPullRequest);
      const original = readPull.getMockImplementation()!;
      readPull.mockImplementation(async (number) => {
        const result = await original(number);
        if (held && kind === "mergeability") {
          waits++;
          return { ...result, mergeable: null };
        }
        return result;
      });
      if (kind === "checks")
        vi.mocked(GitHubControlStore.prototype.readChecks).mockImplementation(async () => {
          if (held) waits++;
          return {
            pending: held ? ["fixture-check"] : [],
            failed: [],
            observed: [],
            observedChecks: [],
          };
        });
      const running = f.run(shutdown.signal);
      try {
        await vi.waitFor(() => expect(waits).toBeGreaterThanOrEqual(3), {
          timeout: 8000,
          interval: 20,
        });
        expect(f.policy.maxParallel).toBe(2);
        expect(
          f
            .events()
            .filter((event) => event.kind === "attempt" && event.event === "AttemptStarted")
            .map((event) => ("workItem" in event ? event.workItem : null)),
        ).toEqual([8, 9]);
        expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(0);
        held = false;
        const result = await running;
        expect(result, result.reason).toMatchObject({ status: "completed" });
        assertConcurrent(f);
      } finally {
        held = false;
        shutdown.abort();
        await running.catch(() => {});
        await f.dispose();
      }
    },
    30_000,
  );

  it("reconstructs both pending publications after restart without duplicate workers or stale-base merging", async () => {
    const shutdown = new AbortController();
    const resumedShutdown = new AbortController();
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      controllerActivation: true,
    });
    let held = true;
    let reads = 0;
    const readPull = vi.mocked(GitHubControlStore.prototype.readPullRequest);
    const original = readPull.getMockImplementation()!;
    readPull.mockImplementation(async (number) => {
      const result = await original(number);
      if (held) {
        reads++;
        return { ...result, mergeable: null };
      }
      return result;
    });
    const first = f.run(shutdown.signal);
    let second: ReturnType<typeof f.run> | undefined;
    try {
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3), {
        timeout: 8000,
        interval: 20,
      });
      shutdown.abort();
      expect(await first).toMatchObject({ status: "cancelled" });
      expect(
        f
          .events()
          .filter((event) =>
            ["FactoryRunCancelled", "FactoryRunEscalated", "FactoryRunCompleted"].includes(
              event.event,
            ),
          ),
      ).toHaveLength(0);
      const before = reads;
      second = f.run(resumedShutdown.signal);
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(before + 3), {
        timeout: 8000,
        interval: 20,
      });
      expect(
        f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.workItem),
      ).toEqual([8, 9]);
      held = false;
      const result = await second;
      expect(result, result.reason).toMatchObject({ status: "completed", runId: f.runId });
      expect(f.events().filter((event) => event.event === "FactoryRunStarted")).toHaveLength(1);
      assertConcurrent(f);
    } finally {
      held = false;
      shutdown.abort();
      resumedShutdown.abort();
      await first.catch(() => {});
      await second?.catch(() => {});
      await f.dispose();
    }
  }, 30_000);

  it("does not race integration recovery against an execution still writing its publication receipt", async () => {
    const shutdown = new AbortController();
    const release = deferred();
    const reached = deferred();
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
    });
    const write = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const originalWrite = write.getMockImplementation()!;
    let publicationWrites = 0;
    write.mockImplementation(async (node, body) => {
      if (
        decodeEventComments(body).some(
          (event) =>
            event.kind === "publication" &&
            event.event === "PublicationRecorded" &&
            event.workItem === 8,
        )
      ) {
        publicationWrites++;
        reached.resolve();
        await release.promise;
      }
      return originalWrite(node, body);
    });
    const read = vi.mocked(GitHubReader.prototype.readObjective);
    const originalRead = read.getMockImplementation()!;
    let snapshots = 0;
    read.mockImplementation(async (...args) => {
      snapshots++;
      return originalRead(...args);
    });
    const running = f.run(shutdown.signal);
    try {
      await reached.promise;
      const before = snapshots;
      await vi.waitFor(() => expect(snapshots).toBeGreaterThanOrEqual(before + 4), {
        timeout: 8000,
        interval: 20,
      });
      expect(publicationWrites).toBe(1);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.event === "AttemptIntegrated" && "workItem" in event && event.workItem === 8,
          ),
      ).toHaveLength(0);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(2);
      release.resolve();
      const result = await running;
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "publication" &&
              event.event === "PublicationRecorded" &&
              event.workItem === 8,
          ),
      ).toHaveLength(1);
      assertConcurrent(f);
    } finally {
      release.resolve();
      shutdown.abort();
      await running.catch(() => {});
      await f.dispose();
    }
  }, 30_000);
});
