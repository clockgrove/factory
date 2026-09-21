import { describe, expect, it, vi } from "vitest";
import { LeaseLostError, LeaseManager } from "../src/control/lease.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { IssueAdmissionLedger } from "../src/control/issue-admission.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { isModelInvocationMarker, unresolvedModelInvocations } from "../src/control/budget.js";
import type { FactoryEvent } from "../src/protocol/events.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

function assertExecutionDispatch(
  events: FactoryEvent[],
  accounting: "exact" | "terminal-unavailable" | "open",
): void {
  const reservations = events.filter((event) => event.event === "AttemptReserved");
  expect(reservations).toHaveLength(1);
  const reservation = reservations[0]!;
  const markers = events
    .filter(isModelInvocationMarker)
    .filter((event) => event.phase === "execution");
  expect(markers).toHaveLength(1);
  const marker = markers[0]!;
  expect(marker).toMatchObject({
    objective: reservation.objective,
    runId: reservation.runId,
    workItem: 8,
    attempt: 1,
    directorEpoch: reservation.directorEpoch,
    policyDigest: reservation.policyDigest,
    usageId: "invocation-worker-8-1",
    modelInvocationId: "worker-8-1",
    amount: 0,
  });
  expect(marker.sequence).toBeGreaterThan(reservation.sequence);
  expect(marker).not.toHaveProperty("reportedModelUsage");
  const actual = events.filter(
    (event) =>
      event.kind === "budget" &&
      event.event === "BudgetReconciled" &&
      event.unit === "model_tokens" &&
      event.phase === "execution",
  );
  const pending = unresolvedModelInvocations(events).filter((event) => event.phase === "execution");
  if (accounting === "exact") {
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({
      objective: marker.objective,
      runId: marker.runId,
      workItem: marker.workItem,
      attempt: marker.attempt,
      directorEpoch: marker.directorEpoch,
      policyDigest: marker.policyDigest,
      usageId: "worker-8-1",
      modelInvocationId: marker.modelInvocationId,
    });
    expect(actual[0]!.sequence).toBeGreaterThan(marker.sequence);
    expect(pending).toEqual([]);
  } else if (accounting === "terminal-unavailable") {
    expect(actual).toEqual([]);
    expect(pending).toEqual([]);
  } else {
    expect(actual).toEqual([]);
    expect(pending).toEqual([marker]);
  }
}

describe("Supervisor cancellation model usage", () => {
  it("persists known usage while unknown cleanup still blocks release and replacement", async () => {
    const shutdown = new AbortController();
    let cancelled = false;
    let cleanupAttempts = 0;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => {
          if (!cancelled) shutdown.abort();
          return {
            state: cancelled ? "cancelled" : "running",
            observedAt: new Date().toISOString(),
            usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
          };
        },
        cancel: async () => {
          cancelled = true;
        },
        cleanup: async () => {
          cleanupAttempts++;
          throw new Error("fixture cleanup unavailable");
        },
        reconcileStale: async () => {
          throw new Error("fixture resource may still be active");
        },
      }),
    });
    try {
      await expect(f.run(shutdown.signal)).rejects.toThrow(/automated replacement is blocked/);
      const usage = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.unit === "model_tokens" &&
            event.phase === "execution",
        );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        amount: 13,
        usageId: "worker-8-1",
        reportedModelUsage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
      });
      assertExecutionDispatch(f.events(), "exact");
      expect(cleanupAttempts).toBeGreaterThan(0);
      expect(
        f
          .events()
          .filter((event) =>
            [
              "AttemptCancelled",
              "AttemptSucceeded",
              "CapacityReconciled",
              "FactoryRunCompleted",
              "FactoryRunCancelled",
            ].includes(event.event),
          ),
      ).toEqual([]);
      expect(f.resources.size).toBe(1);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("does not duplicate usage already journaled before a later cancellation", async () => {
    const shutdown = new AbortController();
    let observations = 0;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async (handle) => {
          observations++;
          return backend.observe(handle);
        },
        collect: async () => {
          shutdown.abort();
          throw new Error("operator cancelled after terminal accounting");
        },
      }),
    });
    try {
      expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
      const usage = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.unit === "model_tokens" &&
            event.phase === "execution",
        );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ amount: 6, usageId: "worker-8-1" });
      assertExecutionDispatch(f.events(), "exact");
      expect(observations).toBe(1);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each([
    { failure: "lease", mode: "ordinary", controllerActivation: false },
    { failure: "receipt", mode: "ordinary", controllerActivation: false },
    { failure: "receipt", mode: "controller release", controllerActivation: true },
  ] as const)(
    "still cleans up and blocks terminal writes when the usage $failure fence fails during $mode cancellation",
    async ({ failure, controllerActivation }) => {
      const shutdown = new AbortController();
      let cancelled = false;
      let receiptWriteAttempts = 0;
      const usageFenceFailure =
        failure === "lease" ? new LeaseLostError("cancellation fixture lease lost") : undefined;
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        controllerActivation,
        configureLocalBackend: (backend) => ({
          ...backend,
          observe: async () => {
            if (!cancelled) shutdown.abort();
            return {
              state: cancelled ? "cancelled" : "running",
              observedAt: new Date().toISOString(),
              usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
            };
          },
          cancel: async (handle) => {
            await backend.cancel(handle);
            cancelled = true;
            if (failure === "lease")
              vi.mocked(LeaseManager.prototype.assertCurrent).mockRejectedValue(usageFenceFailure);
          },
        }),
      });
      if (failure === "receipt") {
        const writer = vi.mocked(GitHubControlStore.prototype.addIssueComment);
        const original = writer.getMockImplementation()!;
        writer.mockImplementation(async (nodeId, body) => {
          if (
            decodeEventComments(body).some(
              (event) =>
                event.kind === "budget" &&
                event.event === "BudgetReconciled" &&
                event.unit === "model_tokens" &&
                event.phase === "execution",
            )
          ) {
            receiptWriteAttempts++;
            throw new Error("cancellation fixture receipt unavailable");
          }
          return original(nodeId, body);
        });
      }
      try {
        const run = f.run(shutdown.signal);
        await expect(run).rejects.toThrow(/lease lost|receipt unavailable/);
        if (failure === "receipt") {
          const error = await run.catch((observed: unknown) => observed);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).name).toBe("CancellationAccountingPublicationError");
          expect((error as Error).cause).toMatchObject({
            message: "cancellation fixture receipt unavailable",
          });
          expect(receiptWriteAttempts).toBe(1);
        } else {
          expect(await run.catch((observed: unknown) => observed)).toBe(usageFenceFailure);
        }
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" &&
                event.event === "BudgetReconciled" &&
                event.unit === "model_tokens" &&
                event.phase === "execution",
            ),
        ).toEqual([]);
        assertExecutionDispatch(f.events(), "open");
        expect(
          f
            .events()
            .filter((event) => event.kind === "attempt" && event.event === "AttemptCancelled"),
        ).toEqual([]);
        expect(
          f
            .events()
            .filter((event) =>
              ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
                event.event,
              ),
            ),
        ).toEqual([]);
        expect(LeaseManager.prototype.release).not.toHaveBeenCalled();
        expect(f.resources.size).toBe(0);
        expect(f.activity.filter((entry) => entry.operation === "cleanup")).toHaveLength(1);
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it.each([13, 0, null, "partial", "running", "unavailable"] as const)(
    "retains terminal cancellation usage %s without inventing absent counters",
    async (tokens) => {
      const shutdown = new AbortController();
      const order: string[] = [];
      let cancelled = false;
      let cleaned = false;
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        configureLocalBackend: (backend) => ({
          ...backend,
          observe: async () => {
            if (cleaned) throw new Error("cleanup discarded backend observation");
            if (!cancelled) {
              shutdown.abort();
              return { state: "running", observedAt: new Date().toISOString() };
            }
            order.push("terminal-observe");
            if (tokens === "unavailable") throw new Error("terminal counters unavailable");
            if (tokens === "running")
              return { state: "running", observedAt: new Date().toISOString() };
            return {
              state: "cancelled",
              observedAt: new Date().toISOString(),
              usage:
                tokens === "partial"
                  ? { inputTokens: 9, outputTokens: null, cachedInputTokens: 2 }
                  : {
                      inputTokens: tokens,
                      outputTokens: tokens === null ? null : 0,
                      cachedInputTokens: tokens === null ? null : 0,
                    },
            };
          },
          cancel: async (handle) => {
            await backend.cancel(handle);
            cancelled = true;
            order.push("cancel");
          },
          cleanup: async (handle) => {
            await backend.cleanup(handle);
            cleaned = true;
            order.push("cleanup");
          },
        }),
      });
      try {
        const run = f.run(shutdown.signal);
        if (tokens === "unavailable" || tokens === "running")
          await expect(run).rejects.toThrow(/execution model accounting remains open or ambiguous/);
        else expect(await run).toMatchObject({ status: "cancelled" });
        const usage = f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.unit === "model_tokens" &&
              event.phase === "execution",
          );
        const terminal = f
          .events()
          .filter((event) => event.kind === "attempt" && event.event === "AttemptCancelled");
        expect(order).toEqual(["cancel", "terminal-observe", "cleanup"]);
        expect(terminal).toHaveLength(1);
        if (
          tokens === null ||
          tokens === "partial" ||
          tokens === "running" ||
          tokens === "unavailable"
        ) {
          assertExecutionDispatch(
            f.events(),
            tokens === "unavailable" || tokens === "running" ? "open" : "terminal-unavailable",
          );
          expect(usage).toEqual([]);
          expect(terminal[0]).not.toHaveProperty("reportedModelTokens");
          expect(terminal[0]).not.toHaveProperty("reportedModelUsage");
          if (tokens !== "unavailable" && tokens !== "running") {
            expect(terminal[0]).toMatchObject({
              modelInvocationId: "worker-8-1",
              producerState: "absent",
              modelUsageAccounting: "terminal-unavailable",
            });
            expect(
              (
                await new IssueAdmissionLedger(
                  new GitHubControlStore({
                    token: "fixture-only",
                    owner: "fixture",
                    repo: "provider-qualification",
                  }),
                ).read(8)
              )?.history.at(-1),
            ).toMatchObject({
              disposition: "released",
              evidence: { accountingSettled: false, unknownModelUsageRetained: true },
            });
          } else {
            expect(terminal[0]).not.toHaveProperty("modelInvocationId");
            expect(terminal[0]).not.toHaveProperty("producerState");
            expect(terminal[0]).not.toHaveProperty("modelUsageAccounting");
          }
        } else {
          assertExecutionDispatch(f.events(), "exact");
          expect(usage).toHaveLength(1);
          expect(usage[0]).toMatchObject({
            amount: tokens,
            usageId: "worker-8-1",
            reportedModelUsage: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0 },
          });
          expect(terminal[0]).toMatchObject({
            reportedModelTokens: tokens,
            reportedModelUsage: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0 },
          });
          expect(terminal[0]).not.toHaveProperty("modelInvocationId");
          expect(terminal[0]).not.toHaveProperty("producerState");
          expect(terminal[0]).not.toHaveProperty("modelUsageAccounting");
        }
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
        expect(f.resources.size).toBe(0);
        expect(
          f
            .events()
            .filter((event) =>
              ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
                event.event,
              ),
            ),
        ).toHaveLength(tokens === "unavailable" || tokens === "running" ? 0 : 1);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("resumes admission settlement from a durable terminal-unavailable receipt", async () => {
    const shutdown = new AbortController();
    let cancelled = false;
    const f = await providerSupervisorFixture("daytona-burst", {
      controllerActivation: true,
      localOnly: true,
      maxAttemptsPerItem: 2,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => {
          if (!cancelled) {
            shutdown.abort();
            return { state: "running", observedAt: new Date().toISOString() };
          }
          return {
            state: "cancelled",
            observedAt: new Date().toISOString(),
            usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
          };
        },
        cancel: async (handle) => {
          await backend.cancel(handle);
          cancelled = true;
        },
      }),
    });
    const transition = IssueAdmissionLedger.prototype.transition;
    let interruptRelease = true;
    vi.spyOn(IssueAdmissionLedger.prototype, "transition").mockImplementation(async function (
      this: IssueAdmissionLedger,
      args,
    ) {
      if (interruptRelease && args.disposition === "released") {
        interruptRelease = false;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("fixture: controller exited after terminal-unavailable receipt"),
        );
      }
      return transition.call(this, args);
    });
    const ledger = new IssueAdmissionLedger(
      new GitHubControlStore({
        token: "fixture-only",
        owner: "fixture",
        repo: "provider-qualification",
      }),
    );
    try {
      await expect(f.run(shutdown.signal)).rejects.toBeInstanceOf(PlatformUnavailableError);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.event === "AttemptCancelled" &&
              "modelUsageAccounting" in event &&
              event.modelUsageAccounting === "terminal-unavailable",
          ),
      ).toHaveLength(1);
      expect((await ledger.read(8))?.history.at(-1)).toMatchObject({
        disposition: "dispatching",
      });

      const resumed = await f.run().catch((error) => error);
      expect(resumed).toMatchObject({
        status: "escalated",
        reason: expect.stringContaining("model invocation consumption is unknown"),
      });
      expect(
        f.activity.filter((entry) => entry.operation === "reconcile-stale" && entry.workItem === 8),
      ).toHaveLength(1);
      expect((await ledger.read(8))?.history.at(-1)).toMatchObject({
        disposition: "released",
        evidence: { accountingSettled: false, unknownModelUsageRetained: true },
      });
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
