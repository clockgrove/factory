import { PlatformUnavailableError } from "../src/platform.js";
import * as localScope from "../src/runtime/local-scope.js";
import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { issueAdmissionRef, parseIssueAdmissionCommit } from "../src/control/issue-admission.js";
import { decodeEventTrailer } from "../src/control/receipts.js";
import type { AttemptContext } from "../src/execution/backend.js";
import { providerSupervisorFixture, LOCAL } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
async function ledger(f: Fixture, workItem: number) {
  const oid = f.refs.get(issueAdmissionRef(workItem));
  expect(oid).toBeDefined();
  const read = vi.mocked(GitHubControlStore.prototype.readCommit).getMockImplementation()!;
  return parseIssueAdmissionCommit(await read(oid!), workItem);
}
async function assertOriginalMetadata(f: Fixture) {
  const read = vi.mocked(GitHubControlStore.prototype.readCommit).getMockImplementation()!;
  for (const workItem of [8, 9, 10]) {
    const record = await ledger(f, workItem);
    for (const entry of record.history) {
      expect(f.refs.has(entry.reservation.ref)).toBe(false);
      const metadata = await read(entry.reservation.oid);
      expect(metadata.parentOids).toEqual([entry.reservation.baseSha]);
      expect(decodeEventTrailer(metadata.message)).toMatchObject({
        event: "AttemptReserved",
        objective: 7,
        workItem,
        attempt: entry.reservation.attempt,
        runId: f.runId,
        directorEpoch: entry.directorEpoch,
        policyDigest: entry.policyDigest,
      });
      expect(entry.disposition).toBe("released");
      expect(entry.evidence).toMatchObject({
        reservationOid: entry.reservation.oid,
        producerStopped: true,
        resourcesReleased: true,
        capacityReleased: true,
        accountingSettled: true,
      });
    }
  }
  expect(f.resources.size).toBe(0);
  expect(
    f.activity.every((event) => event.backend === LOCAL || event.operation.includes("review")),
  ).toBe(true);
}

describe("Supervisor issue admission with synthetic local execution", () => {
  it("restarts a never-dispatched no-scope intent after both write response and readback were lost", async () => {
    const shutdown = new AbortController();
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      controllerActivation: true,
    });
    vi.spyOn(localScope, "discoverLocalScopeHost").mockResolvedValue(null);
    const create = vi.mocked(GitHubControlStore.prototype.createRef).getMockImplementation()!;
    const read = vi.mocked(GitHubControlStore.prototype.readRef).getMockImplementation()!;
    let lost = false,
      unavailable = false;
    vi.mocked(GitHubControlStore.prototype.createRef).mockImplementation(async (ref, oid) => {
      const accepted = await create(ref, oid);
      if (!lost && ref === issueAdmissionRef(8) && accepted) {
        lost = unavailable = true;
        shutdown.abort();
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("accepted reservation response lost"),
        );
      }
      return accepted;
    });
    vi.mocked(GitHubControlStore.prototype.readRef).mockImplementation(async (ref) => {
      if (unavailable && ref === issueAdmissionRef(8))
        throw new Error("reservation readback unavailable");
      return read(ref);
    });
    try {
      await f.run(shutdown.signal).catch(() => undefined);
      expect(lost).toBe(true);
      expect(f.activity.filter((event) => event.operation === "launch")).toHaveLength(0);
      const original = (await ledger(f, 8)).history[0]!;
      expect(original).toMatchObject({ disposition: "prepared", dispatchPossible: false });
      expect(
        f.events().filter((event) => event.event === "AttemptReserved" && event.workItem === 8),
      ).toHaveLength(0);
      unavailable = false;
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      const history = (await ledger(f, 8)).history;
      expect(history.map((entry) => entry.reservation.attempt)).toEqual([1, 2]);
      expect(history[0]).toMatchObject({
        reservation: original.reservation,
        directorEpoch: original.directorEpoch,
        disposition: "released",
        dispatchPossible: false,
      });
      expect(history[1]!.dispatchPossible).toBe(true);
      expect(
        f.events().filter((event) => event.event === "AttemptStarted" && event.workItem === 8),
      ).toMatchObject([{ attempt: 2 }]);
      expect(
        f
          .events()
          .filter(
            (event) => event.kind === "budget" && event.workItem === 8 && event.attempt === 1,
          ),
      ).toEqual([]);
      expect(f.resources.size).toBe(0);
    } finally {
      unavailable = false;
      await f.dispose();
    }
  }, 30_000);
  it("finishes the real pipeline with issue ledgers and immutable metadata pointers", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    try {
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      await assertOriginalMetadata(f);
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(3);
      for (const workItem of [8, 9, 10])
        expect(
          (await ledger(f, workItem)).history.map((entry) => entry.reservation.attempt),
        ).toEqual([1]);
      const execution = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.phase === "execution" &&
            event.unit === "model_tokens",
        );
      expect(execution.map((event) => (event.kind === "budget" ? event.amount : null))).toEqual([
        6, 6, 6,
      ]);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("preserves failed-attempt usage and releases it before retrying under the next issue attempt", async () => {
    const contexts = new Map<string, AttemptContext>();
    const launches: Array<{ workItem: number; attempt: number }> = [];
    const cleanups: Array<{ workItem: number; attempt: number }> = [];
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      maxAttemptsPerItem: 2,
      configureLocalBackend: (backend) => ({
        ...backend,
        launch: async (input) => {
          launches.push({ workItem: input.workItem, attempt: input.attempt });
          const handle = await backend.launch(input);
          contexts.set(handle.resourceId, input);
          return handle;
        },
        observe: async (handle) => {
          const input = contexts.get(handle.resourceId)!;
          return input.workItem === 8 && input.attempt === 1
            ? {
                state: "failed",
                observedAt: new Date().toISOString(),
                reason: "synthetic first-attempt failure",
                usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 },
              }
            : backend.observe(handle);
        },
        cleanup: async (handle) => {
          const input = contexts.get(handle.resourceId)!;
          await backend.cleanup(handle);
          cleanups.push({ workItem: input.workItem, attempt: input.attempt });
        },
      }),
    });
    try {
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      await assertOriginalMetadata(f);
      expect(launches.filter((entry) => entry.workItem === 8)).toEqual([
        { workItem: 8, attempt: 1 },
        { workItem: 8, attempt: 2 },
      ]);
      expect(cleanups.filter((entry) => entry.workItem === 8)).toEqual([
        { workItem: 8, attempt: 1 },
        { workItem: 8, attempt: 2 },
      ]);
      expect((await ledger(f, 8)).history.map((entry) => entry.reservation.attempt)).toEqual([
        1, 2,
      ]);
      const events = f.events();
      const failed = events.find(
        (event) => event.event === "AttemptFailed" && event.workItem === 8 && event.attempt === 1,
      )!;
      const retry = events.find(
        (event) => event.event === "AttemptReserved" && event.workItem === 8 && event.attempt === 2,
      )!;
      expect(failed).toBeDefined();
      expect(retry.sequence).toBeGreaterThan(failed.sequence);
      const usage = events.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.phase === "execution" &&
          event.unit === "model_tokens" &&
          event.workItem === 8,
      );
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({
        runId: f.runId,
        workItem: 8,
        attempt: 1,
        amount: 10,
        usageId: "worker-8-1",
      });
      expect(usage[1]).toMatchObject({
        runId: f.runId,
        workItem: 8,
        attempt: 2,
        amount: 6,
        usageId: "worker-8-2",
      });
      expect(
        events.filter((event) => event.event === "AttemptIntegrated" && event.workItem === 8),
      ).toMatchObject([{ attempt: 2 }]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
