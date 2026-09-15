import { describe, expect, it, vi } from "vitest";

import { unresolvedModelInvocations } from "../src/control/budget.js";
import { DISCOVERY_LOCATOR_PREFIX } from "../src/control/discovery-locators.js";
import {
  LeaseAcquisitionContendedError,
  LeaseLostError,
  LeaseManager,
} from "../src/control/lease.js";
import { TERMINAL_RECOVERY_REQUIRED } from "../src/control/recovery.js";
import { foregroundControllerPolicyFromSnapshot } from "../src/controller/repository-controller.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;

async function interruptedCompilationFixture(includeCancellation: boolean): Promise<{
  f: Fixture;
  marker: ReturnType<typeof parseFactoryEvent>;
  cancellation: Extract<
    ReturnType<typeof parseFactoryEvent>,
    { kind: "run"; event: "FactoryRunCancellationRequested" }
  >;
  compile: ReturnType<typeof vi.spyOn>;
}> {
  const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  const start = f.snapshot.factoryEvents!.find(
    (event) => event.kind === "run" && event.event === "FactoryRunStarted",
  );
  if (!start || start.kind !== "run" || start.event !== "FactoryRunStarted") {
    throw new Error("fixture run start is unavailable");
  }
  const delivery = f.snapshot.factoryEvents!.find((event) => event.kind === "delivery");
  if (!delivery) throw new Error("fixture delivery selection is unavailable");
  const { activationRequestId: _activation, baseSha: _baseSha, ...plainStart } = start;
  const marker = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "budget",
    event: "BudgetReserved",
    objective: 7,
    runId: f.runId,
    sequence: 3,
    at: "2026-09-14T20:00:00.000Z",
    phase: "management",
    unit: "model_tokens",
    amount: 0,
    usageId: `invocation-compile-${f.baseSha}`,
    modelInvocationId: `compile-${f.baseSha}`,
    directorEpoch: f.lease.epoch,
    policyDigest: f.lease.policyDigest,
  });
  const cancellation = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunCancellationRequested",
    objective: 7,
    runId: f.runId,
    sequence: 4,
    at: "2026-09-14T20:00:01.000Z",
    requestedBy: "operator",
    requestId: "cancel-interrupted-compilation",
    reason: "stop the interrupted foreground run",
  });
  if (cancellation.kind !== "run" || cancellation.event !== "FactoryRunCancellationRequested") {
    throw new Error("fixture cancellation request is invalid");
  }
  f.refs.clear();
  f.snapshot.workItems = [];
  f.snapshot.factoryEvents = [
    parseFactoryEvent(plainStart),
    parseFactoryEvent({ ...delivery, sequence: 2 }),
    marker,
    ...(includeCancellation ? [cancellation] : []),
  ];
  const compile = vi.spyOn(f.management, "compile");
  vi.mocked(GitHubReader.prototype.readRunCancellationRequest).mockResolvedValue(cancellation);
  return { f, marker, cancellation, compile };
}

describe("foreground run reconnect", () => {
  it("derives foreground wrapper resources from the durable run policy", async () => {
    const { f } = await interruptedCompilationFixture(false);
    try {
      const durable = parseRunPolicy({
        ...f.policy,
        backendOrder: [...f.policy.backendOrder, "codex-cli/daytona"],
        allowedPaidBackends: ["codex-cli/daytona"],
        cloudFallback: "explicit" as const,
        burst: {
          ...f.policy.burst,
          mode: "deadline" as const,
          backendOrder: ["codex-cli/daytona"],
          maxCloudParallel: 2,
        },
      });
      const start = f.snapshot.factoryEvents!.find(
        (event) => event.kind === "run" && event.event === "FactoryRunStarted",
      );
      if (!start || start.kind !== "run" || start.event !== "FactoryRunStarted")
        throw new Error("fixture run start is unavailable");
      f.snapshot.factoryEvents = [
        parseFactoryEvent({ ...start, policy: durable, policyDigest: policyDigest(durable) }),
      ];

      const selected = foregroundControllerPolicyFromSnapshot(f.snapshot, DEFAULT_RUN_POLICY);

      expect(selected.runPolicy).toEqual(durable);
      expect(selected.controllerPolicy.maxPaidWorkers).toBe(2);
      expect(DEFAULT_RUN_POLICY.allowedPaidBackends).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("cancels the same interrupted compilation run and refuses an implicit successor", async () => {
    const { f, marker, compile } = await interruptedCompilationFixture(true);
    try {
      await expect(f.run()).resolves.toMatchObject({
        status: "cancelled",
        runId: f.runId,
        reason: expect.stringContaining("cleanup-only cancellation"),
      });

      const afterCancellation = f.events();
      expect(
        afterCancellation.filter(
          (event) => event.kind === "run" && event.event === "FactoryRunStarted",
        ),
      ).toHaveLength(1);
      expect(
        afterCancellation.filter(
          (event) => event.kind === "run" && event.event === "FactoryRunCancelled",
        ),
      ).toHaveLength(1);
      expect(unresolvedModelInvocations(afterCancellation)).toEqual([marker]);
      expect(
        afterCancellation.filter((event) =>
          ["graph", "attempt", "capacity", "publication", "validation", "scheduling"].includes(
            event.kind,
          ),
        ),
      ).toEqual([]);
      expect(compile).not.toHaveBeenCalled();
      expect([...f.refs.keys()].some((ref) => ref.startsWith(DISCOVERY_LOCATOR_PREFIX))).toBe(true);

      await expect(f.run()).resolves.toMatchObject({
        status: "escalated",
        runId: f.runId,
        reason: TERMINAL_RECOVERY_REQUIRED,
      });
      expect(
        f.events().filter((event) => event.kind === "run" && event.event === "FactoryRunStarted"),
      ).toHaveLength(1);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("rechecks cancellation after acquiring the same-run lease", async () => {
    const { f, marker, compile, cancellation } = await interruptedCompilationFixture(false);
    try {
      await expect(f.run()).resolves.toMatchObject({
        status: "cancelled",
        runId: f.runId,
        reason: expect.stringContaining("before resumed compilation"),
      });
      expect(GitHubReader.prototype.readRunCancellationRequest).toHaveBeenCalledWith(
        7,
        f.runId,
        "operator",
      );
      expect(f.events()).toEqual(expect.arrayContaining([marker]));
      expect(f.events()).not.toEqual(expect.arrayContaining([cancellation]));
      expect(unresolvedModelInvocations(f.events())).toEqual([marker]);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("returns a bounded same-run draining result when cancellation lease acquisition contends", async () => {
    const { f, compile } = await interruptedCompilationFixture(true);
    vi.mocked(LeaseManager.prototype.acquire).mockRejectedValueOnce(
      new LeaseAcquisitionContendedError(7, 12_000, "existing-holder"),
    );
    try {
      await expect(f.run()).resolves.toMatchObject({
        status: "draining",
        runId: f.runId,
        reason: expect.stringContaining("cancel-interrupted-compilation"),
      });
      expect(
        f.events().filter((event) => event.kind === "run" && event.event === "FactoryRunStarted"),
      ).toHaveLength(1);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("returns a bounded same-run draining result when cancellation loses the lease CAS race", async () => {
    const { f, compile } = await interruptedCompilationFixture(true);
    vi.mocked(LeaseManager.prototype.acquire).mockRejectedValueOnce(
      new LeaseLostError("another Director won lease acquisition"),
    );
    try {
      await expect(f.run()).resolves.toMatchObject({
        status: "draining",
        runId: f.runId,
        reason: expect.stringContaining("cancel-interrupted-compilation"),
      });
      expect(
        f.events().filter((event) => event.kind === "run" && event.event === "FactoryRunStarted"),
      ).toHaveLength(1);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each([
    ["a live holder", new LeaseAcquisitionContendedError(7, 12_000, "existing-holder")],
    ["the create/CAS winner", new LeaseLostError("another Director won lease acquisition")],
  ])(
    "returns same-run draining when late cancellation races %s",
    async (_description, leaseError) => {
      const { f, compile } = await interruptedCompilationFixture(false);
      vi.mocked(LeaseManager.prototype.acquire).mockRejectedValueOnce(leaseError);
      try {
        await expect(f.run()).resolves.toMatchObject({
          status: "draining",
          runId: f.runId,
          reason: expect.stringContaining("cancel-interrupted-compilation"),
        });
        expect(GitHubReader.prototype.readRunCancellationRequest).toHaveBeenCalledWith(
          7,
          f.runId,
          "operator",
        );
        expect(
          f.events().filter((event) => event.kind === "run" && event.event === "FactoryRunStarted"),
        ).toHaveLength(1);
        expect(compile).not.toHaveBeenCalled();
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});
