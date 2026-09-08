import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { unresolvedModelInvocations } from "../src/control/budget.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { ValidationCheckpointManager } from "../src/control/validation-checkpoints.js";
import * as cleanValidation from "../src/validation/clean-run.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

async function validatedBeforeReview(stage: "validation" | "execution" = "validation") {
  const fixture = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
  });
  const validation = vi.spyOn(cleanValidation, "validateArtifactClean");
  const writer = vi.mocked(GitHubControlStore.prototype.addIssueComment);
  const original = writer.getMockImplementation()!;
  const failure = new PlatformUnavailableError(
    { kind: "server_error", retryAfterMs: 1 },
    new Error("fixture interruption after validation accounting, before review dispatch"),
  );
  let interrupted = false;
  writer.mockImplementation(async (node, body) => {
    await original(node, body);
    if (
      !interrupted &&
      decodeEventComments(body).some(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.workItem === 8 &&
          event.phase === stage &&
          event.unit ===
            (stage === "validation" ? "validation_milliseconds" : "local_milliseconds"),
      )
    ) {
      interrupted = true;
      throw failure;
    }
  });
  return { fixture, validation, failure };
}

describe("retained validated artifact continuation", () => {
  it("recovers an immutable passed validation when its summary comment never committed", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
    });
    const validation = vi.spyOn(cleanValidation, "validateArtifactClean");
    const writer = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const original = writer.getMockImplementation()!;
    const failure = new PlatformUnavailableError(
      { kind: "server_error", retryAfterMs: 1 },
      new Error("validation summary write lost"),
    );
    let interrupted = false;
    writer.mockImplementation(async (node, body) => {
      if (
        !interrupted &&
        decodeEventComments(body).some(
          (event) => event.event === "ValidationRecorded" && event.workItem === 8,
        )
      ) {
        interrupted = true;
        throw failure;
      }
      await original(node, body);
    });
    try {
      await expect(f.run()).rejects.toBe(failure);
      expect([...f.refs.keys()].some((ref) => ref.includes("/validations/"))).toBe(true);
      expect(f.events().some((event) => event.event === "ValidationRecorded")).toBe(false);
      expect(validation).toHaveBeenCalledOnce();
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(validation).toHaveBeenCalledTimes(3);
      expect(
        f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.workItem),
      ).toEqual([8, 9, 10]);
      expect(
        f.events().filter((event) => event.event === "ValidationRecorded" && event.workItem === 8),
      ).toHaveLength(1);
      expect(
        f.activity.filter((entry) => entry.operation === "review" && entry.workItem === 8),
      ).toHaveLength(1);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("rejects operator cancellation arriving after recovery snapshot but before missing review admission", async () => {
    const { fixture: f, validation, failure } = await validatedBeforeReview();
    try {
      await expect(f.run()).rejects.toBe(failure);
      const load = ValidationCheckpointManager.prototype.load;
      let injected = false;
      vi.spyOn(ValidationCheckpointManager.prototype, "load").mockImplementation(async function (
        this: ValidationCheckpointManager,
        identity,
      ) {
        const record = await load.call(this, identity);
        if (!injected && identity.workItem === 8) {
          injected = true;
          f.snapshot.factoryEvents!.push(
            parseFactoryEvent({
              protocol: "clockgrove.factory/v2",
              kind: "run",
              event: "FactoryRunCancellationRequested",
              objective: 7,
              runId: f.runId,
              sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
              at: new Date().toISOString(),
              requestedBy: "operator",
              requestId: "fixture-cancel-during-recovery",
            }),
          );
        }
        return record;
      });
      const before = f.events().filter((event) => event.kind === "budget");
      await expect(f.run()).resolves.toMatchObject({ status: "cancelled" });
      expect(injected).toBe(true);
      expect(f.events().filter((event) => event.kind === "budget")).toEqual(before);
      expect(f.activity.filter((entry) => entry.operation.includes("review"))).toEqual([]);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
      expect(validation).toHaveBeenCalledOnce();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("continues validated and succeeded roots together after one interrupted cohort without replaying root work", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
    });
    f.repositoryResources.controllerLimits.maxLocalWorkers = 2;
    const validation = vi.spyOn(cleanValidation, "validateArtifactClean");
    const writer = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const original = writer.getMockImplementation()!;
    const failure = new PlatformUnavailableError(
      { kind: "server_error", retryAfterMs: 1 },
      new Error("fixture interrupted root cohort"),
    );
    let ready!: () => void;
    let validated!: () => void;
    const rootReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const rootValidated = new Promise<void>((resolve) => {
      validated = resolve;
    });
    let interrupt = true;
    writer.mockImplementation(async (node, body) => {
      await original(node, body);
      const events = decodeEventComments(body);
      if (!interrupt) return;
      if (
        events.some(
          (event) =>
            event.event === "BudgetReconciled" &&
            event.workItem === 9 &&
            event.phase === "execution" &&
            event.unit === "local_milliseconds",
        )
      ) {
        ready();
        await rootValidated;
        throw failure;
      }
      if (
        events.some(
          (event) =>
            event.event === "BudgetReconciled" &&
            event.workItem === 8 &&
            event.phase === "validation" &&
            event.unit === "validation_milliseconds",
        )
      ) {
        validated();
        await rootReady;
        throw failure;
      }
    });
    try {
      await expect(f.run()).rejects.toBe(failure);
      interrupt = false;
      const succeeded = f
        .events()
        .find((event) => event.event === "AttemptSucceeded" && event.workItem === 9);
      if (!succeeded) throw new Error("second root has no terminal artifact");
      f.snapshot.workItems[1]!.factoryEvents!.push(
        parseFactoryEvent({
          ...succeeded,
          event: "AttemptCancelled",
          writerOperationId: "fixture-cohort-controller-shutdown",
          sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
          reason: "controller stopped after sibling provider error",
        }),
      );
      expect(validation).toHaveBeenCalledOnce();
      expect(
        f.events().some((event) => event.event === "AttemptCollected" && event.workItem === 9),
      ).toBe(false);
      expect(
        f.events().some((event) => event.event === "ValidationRecorded" && event.workItem === 8),
      ).toBe(true);
      expect(f.activity.filter((entry) => entry.operation.includes("review"))).toEqual([]);
      expect(f.resources.size).toBe(0);
      const execution = f
        .events()
        .filter((event) => event.kind === "budget" && event.phase === "execution");
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed", runId: f.runId });
      for (const workItem of [8, 9, 10])
        expect(
          f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === workItem),
        ).toHaveLength(1);
      for (const workItem of [8, 9]) {
        expect(
          f
            .events()
            .filter((event) => event.event === "ValidationRecorded" && event.workItem === workItem),
        ).toHaveLength(1);
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" &&
                event.phase === "execution" &&
                event.workItem === workItem,
            ),
        ).toEqual(execution.filter((event) => "workItem" in event && event.workItem === workItem));
      }
      expect(f.snapshot.workItems.every((item) => item.closed)).toBe(true);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
      expect(f.resources.size).toBe(0);
    } finally {
      ready();
      validated();
      await f.dispose();
    }
  }, 30_000);

  it.each([false, true])(
    "reuses a succeeded ready artifact after legacy shutdown only without conflicting failure (%s)",
    async (conflictingFailure) => {
      const { fixture: f, validation, failure } = await validatedBeforeReview("execution");
      try {
        await expect(f.run()).rejects.toBe(failure);
        const succeeded = f
          .events()
          .find((event) => event.event === "AttemptSucceeded" && event.workItem === 8);
        if (!succeeded || succeeded.event !== "AttemptSucceeded")
          throw new Error("missing genuine succeeded checkpoint");
        expect(unresolvedModelInvocations(f.events())).toEqual([]);
        expect(f.resources.size).toBe(0);
        expect(validation).not.toHaveBeenCalled();
        expect(
          [...f.refs.keys()].some(
            (ref) => ref.includes("artifact-transfers/") && ref.endsWith("/ready"),
          ),
        ).toBe(true);
        // Model the historical controller-shutdown receipt after genuine retained
        // output/settlement; current controllers need not recreate this old state.
        f.snapshot.workItems[0]!.factoryEvents!.push(
          parseFactoryEvent({
            ...succeeded,
            event: conflictingFailure ? "AttemptFailed" : "AttemptCancelled",
            writerOperationId: "fixture-legacy-shutdown-outcome",
            sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
            reason: "controller shutdown before collection",
          }),
        );
        expect(f.events().some((event) => event.event === "FactoryRunCancellationRequested")).toBe(
          false,
        );
        const originalBudget = f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" && event.workItem === 8 && event.phase === "execution",
          );
        if (conflictingFailure) {
          const result = await f
            .run()
            .catch((error: unknown) => ({ status: "blocked", reason: String(error) }));
          expect(result.status).not.toBe("completed");
          expect(result.reason).toMatch(/attempt budget|failed|lifecycle|conflict/i);
          expect(validation).not.toHaveBeenCalled();
          expect(f.activity.filter((entry) => entry.operation.includes("review"))).toEqual([]);
          expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
        } else {
          expect(
            f
              .events()
              .some((event) =>
                ["AttemptFailed", "AttemptTimedOut", "AttemptDeferred"].includes(event.event),
              ),
          ).toBe(false);
          const result = await f.run();
          expect(result, result.reason).toMatchObject({ status: "completed", runId: f.runId });
          expect(validation).toHaveBeenCalledTimes(3);
          expect(
            f.activity
              .filter((entry) => entry.operation === "launch")
              .map((entry) => entry.workItem),
          ).toEqual([8, 9, 10]);
          expect(
            f.activity.filter((entry) => entry.operation === "review" && entry.workItem === 8),
          ).toHaveLength(1);
        }
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" && event.workItem === 8 && event.phase === "execution",
            ),
        ).toEqual(originalBudget);
        expect(f.events()).toContainEqual(succeeded);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("runs only the missing review after exact validation and accounting survived an interruption", async () => {
    const { fixture: f, validation, failure } = await validatedBeforeReview();
    try {
      await expect(f.run()).rejects.toBe(failure);
      const preserved = f.events().filter((event) => "workItem" in event && event.workItem === 8);
      expect(preserved.some((event) => event.event === "ValidationRecorded" && event.passed)).toBe(
        true,
      );
      expect(
        preserved.some(
          (event) => event.event === "CapacityReconciled" && event.phase === "validation",
        ),
      ).toBe(true);
      expect(preserved.some((event) => event.event === "AttemptValidated")).toBe(false);
      expect(f.activity.filter((entry) => entry.operation.includes("review"))).toEqual([]);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
      expect(validation).toHaveBeenCalledOnce();
      expect(
        [...f.refs.keys()].some(
          (ref) => ref.includes("artifact-transfers/") && ref.endsWith("/ready"),
        ),
      ).toBe(true);

      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed", runId: f.runId });
      expect(f.events()).toEqual(expect.arrayContaining(preserved));
      expect(
        f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.workItem),
      ).toEqual([8, 9, 10]);
      expect(
        f.activity.filter((entry) => entry.operation === "review" && entry.workItem === 8),
      ).toHaveLength(1);
      expect(validation).toHaveBeenCalledTimes(3);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("does not use retained validation as authority to continue an operator-cancelled invocation", async () => {
    const { fixture: f, validation, failure } = await validatedBeforeReview();
    try {
      await expect(f.run()).rejects.toBe(failure);
      const launches = f.activity.filter((entry) => entry.operation === "launch");
      const cancellation = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCancellationRequested",
        objective: 7,
        runId: f.runId,
        sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
        at: new Date().toISOString(),
        requestedBy: "operator",
        requestId: "fixture-operator-cancel",
      });
      if (cancellation.event !== "FactoryRunCancellationRequested")
        throw new Error("invalid cancellation fixture");
      f.snapshot.factoryEvents!.push(cancellation);
      vi.mocked(GitHubReader.prototype.readRunCancellationRequest).mockResolvedValue(cancellation);
      await expect(f.run()).resolves.toMatchObject({ status: "cancelled" });
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual(launches);
      expect(f.activity.filter((entry) => entry.operation.includes("review"))).toEqual([]);
      expect(validation).toHaveBeenCalledOnce();
      expect(f.events().some((event) => event.event === "FactoryRunCompleted")).toBe(false);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("does not repeat an unknown review even when exact passed validation is retained", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
    });
    const validation = vi.spyOn(cleanValidation, "validateArtifactClean");
    const review = vi
      .spyOn(f.management, "review")
      .mockRejectedValue(
        new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("fixture review completion unavailable"),
        ),
      );
    try {
      await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      expect(review).toHaveBeenCalledOnce();
      const unknown = unresolvedModelInvocations(f.events());
      expect(unknown.length).toBeGreaterThan(0);
      await expect(f.run()).resolves.toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/model invocation consumption is unknown/),
      });
      expect(review).toHaveBeenCalledOnce();
      expect(validation).toHaveBeenCalledOnce();
      expect(unresolvedModelInvocations(f.events())).toEqual(unknown);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
