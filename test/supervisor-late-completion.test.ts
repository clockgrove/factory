import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { CompiledGraphManager } from "../src/control/graphs.js";
import { GitHubReader } from "../src/github.js";
import { PlatformUnavailableError } from "../src/platform.js";
import * as scopes from "../src/runtime/local-scope.js";
import { runContainedProcess } from "../src/runtime/process-group.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function completedBeforeOutage() {
  // Seed a real immutable compiler checkpoint, not just a hand-compiled graph.
  // The ordinary Supervisor must account this fixture's known two-token result.
  const persist = CompiledGraphManager.prototype.persist;
  vi.spyOn(CompiledGraphManager.prototype, "persist").mockImplementation(function (
    this: CompiledGraphManager,
    args,
  ) {
    if ("source" in args) return persist.call(this, args);
    return persist.call(this, {
      ...args,
      compilation: args.compilation ?? {
        invocationId: `compile-${args.base.oid}`,
        inputTokens: 1,
        outputTokens: 1,
      },
    });
  });
  const f = await providerSupervisorFixture("daytona-burst", {
    controllerActivation: true,
    dependencyChain: true,
    localOnly: true,
  });
  const hostIdentity = "b".repeat(64);
  vi.spyOn(scopes, "discoverLocalScopeHost").mockResolvedValue({
    hostIdentity,
    producerPid: process.pid,
    producerStartTicks: "456",
    producerUnit: "factory-fixture.service",
    producerInvocationId: "c".repeat(32),
  });
  vi.spyOn(scopes.linuxLocalScopeReadPort, "hostIdentity").mockResolvedValue(hostIdentity);
  vi.spyOn(scopes.linuxLocalScopeReadPort, "show").mockImplementation(
    async (unit) =>
      `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group\n`,
  );
  vi.spyOn(scopes, "runScopedLocalProcess").mockImplementation(async (_identity, options) =>
    runContainedProcess(options),
  );
  const close = vi.mocked(GitHubControlStore.prototype.closeIssue);
  const original = close.getMockImplementation()!;
  const outage = new PlatformUnavailableError(
    { kind: "rate_limit", retryAfterMs: 60_000 },
    new Error("fixture quota exhausted"),
  );
  close.mockImplementation(async (number) => {
    if (number === 7) throw outage;
    return original(number);
  });
  await expect(f.run()).rejects.toBe(outage);
  expect(f.snapshot.closed).toBe(false);
  expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(3);
  expect(f.resources.size).toBe(0);
  expect(
    f.events().filter((event) => event.kind === "budget" && event.usageId?.startsWith("compile-")),
  ).toHaveLength(1);
  close.mockImplementation(original);
  const start = f.events().find((event) => event.event === "FactoryRunStarted")!;
  const deadline = Date.parse(start.at) + f.policy.objectiveTimeoutMinutes * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(deadline + 60_000);
  return { ...f, deadline, before: [...f.activity] };
}

describe("completion-only restart beyond the original Objective deadline", () => {
  it("closes on-time completed work without another worker, validation, review or merge", async () => {
    const f = await completedBeforeOutage();
    try {
      const expectedUnits = new Set(
        f.events().flatMap((event) => {
          if (
            (event.kind !== "attempt" || event.event !== "AttemptReserved") &&
            (event.kind !== "capacity" || event.event !== "CapacityReserved")
          )
            return [];
          const batch = event.localScopeBatch;
          return batch
            ? Array.from({ length: batch.commandCount }, (_, commandIndex) =>
                scopes.localScopeUnit({ ...batch.identity, commandIndex }),
              )
            : [];
        }),
      );
      vi.mocked(scopes.linuxLocalScopeReadPort.show).mockClear();
      expect(await f.run()).toMatchObject({ status: "completed", runId: f.runId });
      expect(f.snapshot.closed).toBe(true);
      expect(f.activity).toEqual(f.before);
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(3);
      expect(f.events().filter((event) => event.event === "FactoryRunCompleted")).toHaveLength(1);
      // Two independent observations per slot, repeated at the final proof fence.
      const observedUnits = vi
        .mocked(scopes.linuxLocalScopeReadPort.show)
        .mock.calls.map(([unit]) => unit);
      expect(expectedUnits.size).toBeGreaterThanOrEqual(9);
      expect(new Set(observedUnits)).toEqual(expectedUnits);
      for (const unit of expectedUnits)
        expect(observedUnits.filter((observed) => observed === unit)).toHaveLength(4);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each([
    "late-integration",
    "missing-integration",
    "missing-review",
    "unsettled-capacity",
    "unknown-scope",
    "unknown-usage",
    "missing-compiler-usage",
    "missing-validation-duration",
    "missing-validation-slot",
    "changed-execution-scope",
    "trunk-at-base",
    "trunk-at-prefix",
  ] as const)(
    "does not grant completion authority for %s",
    async (fault) => {
      const f = await completedBeforeOutage();
      try {
        const item = f.snapshot.workItems[2]!;
        if (fault === "late-integration")
          item.factoryEvents!.find((event) => event.event === "AttemptIntegrated")!.at = new Date(
            f.deadline + 1,
          ).toISOString();
        if (fault === "missing-integration")
          item.factoryEvents = item.factoryEvents!.filter(
            (event) => event.event !== "AttemptIntegrated",
          );
        if (fault === "missing-review")
          for (const ref of f.refs.keys()) if (ref.includes("/reviews/")) f.refs.delete(ref);
        if (fault === "unsettled-capacity")
          item.factoryEvents = item.factoryEvents!.filter(
            (event) => event.event !== "CapacityReconciled",
          );
        if (fault === "unknown-scope")
          vi.mocked(scopes.linuxLocalScopeReadPort.show).mockRejectedValue(
            new Error("scope observation unavailable"),
          );
        if (fault === "unknown-usage") {
          const event = item.factoryEvents!.find((event) => event.event === "AttemptSucceeded")!;
          if (event.kind !== "attempt") throw new Error("fixture attempt");
          delete event.reportedModelTokens;
          delete event.reportedModelUsage;
        }
        if (fault === "missing-compiler-usage")
          f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter(
            (event) => !(event.kind === "budget" && event.usageId?.startsWith("compile-")),
          );
        if (fault === "missing-validation-duration")
          item.factoryEvents = item.factoryEvents!.filter(
            (event) => !(event.kind === "budget" && event.unit === "validation_milliseconds"),
          );
        if (fault === "missing-validation-slot") {
          const capacity = item.factoryEvents!.find((event) => event.event === "CapacityReserved")!;
          if (capacity.kind !== "capacity") throw new Error("fixture capacity");
          capacity.localScopeBatch!.commandCount = 1;
        }
        if (fault === "changed-execution-scope") {
          const reserved = item.factoryEvents!.find((event) => event.event === "AttemptReserved")!;
          if (reserved.kind !== "attempt") throw new Error("fixture reservation");
          reserved.localScopeBatch!.identity.invocationDigest = "f".repeat(64);
        }
        if (fault === "trunk-at-base" || fault === "trunk-at-prefix") {
          const original = f
            .events()
            .find(
              (event) =>
                event.event ===
                (fault === "trunk-at-base" ? "FactoryRunStarted" : "AttemptIntegrated"),
            )!;
          const sha =
            original.event === "FactoryRunStarted"
              ? original.baseSha
              : original.kind === "attempt"
                ? original.headSha
                : undefined;
          if (!sha) throw new Error("fixture base");
          const commit = await GitHubControlStore.prototype.readCommit(sha);
          vi.mocked(GitHubControlStore.prototype.getBranchHead).mockResolvedValue(commit);
        }
        expect(await f.run()).toMatchObject({
          status: "escalated",
          reason: "Objective timeout exhausted",
        });
        expect(f.snapshot.closed).toBe(false);
        expect(f.activity).toEqual(f.before);
        expect(f.events().some((event) => event.event === "FactoryRunCompleted")).toBe(false);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it.each(["valid", "missing-review", "cancelled"] as const)(
    "rechecks a closed-but-active Objective after lost terminal response: %s",
    async (fault) => {
      const f = await completedBeforeOutage();
      try {
        const add = vi.mocked(GitHubControlStore.prototype.addIssueComment);
        const original = add.getMockImplementation()!;
        const unavailable = new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: 60_000 },
          new Error("lost terminal comment"),
        );
        add.mockImplementation(async (node, body) => {
          if (decodeEventComments(body).some((event) => event.event === "FactoryRunCompleted"))
            throw unavailable;
          return original(node, body);
        });
        await expect(f.run()).rejects.toBe(unavailable);
        expect(f.snapshot.closed).toBe(true);
        expect(f.events().some((event) => event.event === "FactoryRunCompleted")).toBe(false);
        add.mockImplementation(original);
        vi.mocked(GitHubControlStore.prototype.closeIssue).mockClear();
        if (fault === "missing-review")
          for (const ref of f.refs.keys()) if (ref.includes("/reviews/")) f.refs.delete(ref);
        if (fault === "cancelled")
          f.snapshot.factoryEvents!.push({
            protocol: "clockgrove.factory/v2",
            kind: "run",
            event: "FactoryRunCancellationRequested",
            objective: 7,
            runId: f.runId,
            sequence: 1000,
            at: new Date().toISOString(),
            requestId: "closed-objective-cancellation",
            requestedBy: "operator",
          });
        expect(await f.run()).toMatchObject({
          status:
            fault === "valid" ? "completed" : fault === "cancelled" ? "cancelled" : "escalated",
        });
        expect(GitHubControlStore.prototype.closeIssue).not.toHaveBeenCalled();
        expect(f.activity).toEqual(f.before);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("propagates a fresh platform refusal without converting it to terminal escalation", async () => {
    const f = await completedBeforeOutage();
    try {
      const unavailable = new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 60_000 },
        new Error("fixture quota exhausted"),
      );
      vi.mocked(scopes.linuxLocalScopeReadPort.show).mockImplementation(async (unit) => {
        vi.mocked(GitHubControlStore.prototype.getBranchHead).mockRejectedValue(unavailable);
        return `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group\n`;
      });
      await expect(f.run()).rejects.toBe(unavailable);
      expect(f.activity).toEqual(f.before);
      expect(
        f
          .events()
          .some((event) => ["FactoryRunCompleted", "FactoryRunEscalated"].includes(event.event)),
      ).toBe(false);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("gives a newly observed cancellation priority over late completion", async () => {
    const f = await completedBeforeOutage();
    try {
      const reader = vi.mocked(GitHubReader.prototype.readObjective);
      const original = reader.getMockImplementation()!;
      let reads = 0;
      reader.mockImplementation(async (...args) => {
        const snapshot = await original(...args);
        if (++reads >= 4)
          snapshot.factoryEvents!.push({
            protocol: "clockgrove.factory/v2",
            kind: "run",
            event: "FactoryRunCancellationRequested",
            objective: 7,
            runId: f.runId,
            sequence: 1000,
            at: new Date().toISOString(),
            requestId: "cancel-late-completion",
            requestedBy: "operator",
          });
        return snapshot;
      });
      expect(await f.run()).toMatchObject({ status: "cancelled" });
      expect(f.snapshot.closed).toBe(false);
      expect(f.activity).toEqual(f.before);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
