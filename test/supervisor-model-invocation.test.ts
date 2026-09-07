import { access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import {
  deriveBudgetUsage,
  isModelInvocationMarker,
  unresolvedModelInvocations,
} from "../src/control/budget.js";
import {
  reviewCheckpointRef,
  reviewIdentityDigest,
  type ReviewIdentity,
} from "../src/control/reviews.js";
import { PlatformUnavailableError } from "../src/platform.js";
import type { FactoryEvent } from "../src/protocol/events.js";
import * as worktrees from "../src/runtime/local-worktree.js";
import * as cleanValidation from "../src/validation/clean-run.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
type BudgetEvent = Extract<FactoryEvent, { kind: "budget" }>;
const modelBudgets = (f: Fixture): BudgetEvent[] =>
  f
    .events()
    .filter(
      (event): event is BudgetEvent => event.kind === "budget" && event.unit === "model_tokens",
    );

describe("Supervisor model dispatch journal", () => {
  it.each(["missing", "partial"] as const)("fences terminal %s counters without economics before any review", async (kind) => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      noModelTokenBudget: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async (handle) => ({
          ...await backend.observe(handle),
          usage: kind === "missing" ? {} : { inputTokens: 4 },
        }),
      }),
    });
    try {
      expect(f.policy.economics).toBeUndefined();
      expect(await f.run()).toMatchObject({ status: "escalated" });
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
      expect(f.activity.filter((entry) => entry.operation === "review")).toEqual([]);
      expect(f.events().filter((event) => event.event === "ValidationRecorded" || event.event === "PublicationRecorded")).toEqual([]);
      const markers = modelBudgets(f).filter(isModelInvocationMarker);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ modelInvocationId: "worker-8-1", phase: "execution" });
      expect(modelBudgets(f)).toEqual(markers);
      expect(unresolvedModelInvocations(f.events())).toEqual(markers);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("persists exact worker and semantic-review intent before each model call and links actual counters", async () => {
    let fixture: Fixture | undefined;
    const workerCalls: string[] = [];
    const reviewCalls: string[] = [];
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        launch: async (context) => {
          if (!fixture) throw new Error("fixture not yet configured");
          const invocationId = `worker-${context.workItem}-${context.attempt}`;
          const markers = modelBudgets(fixture).filter(
            (event) => isModelInvocationMarker(event) && event.modelInvocationId === invocationId,
          );
          expect(markers).toHaveLength(1);
          expect(markers[0]).toMatchObject({
            objective: context.objective,
            runId: context.runId,
            workItem: context.workItem,
            attempt: context.attempt,
            phase: "execution",
            amount: 0,
            usageId: `invocation-${invocationId}`,
            policyDigest: context.policyDigest,
            directorEpoch: context.directorEpoch,
          });
          expect(unresolvedModelInvocations(fixture.events())).toContainEqual(markers[0]);
          workerCalls.push(invocationId);
          return backend.launch(context);
        },
      }),
    });
    fixture = f;
    const review = f.management.review;
    f.management.review = async (context, checkpoint) => {
      const reservation = f
        .events()
        .find(
          (event) =>
            event.kind === "attempt" &&
            event.event === "AttemptReserved" &&
            event.workItem === context.workItemNumber,
        );
      if (reservation?.kind !== "attempt" || reservation.event !== "AttemptReserved")
        throw new Error("real review has no original reservation");
      const identity: ReviewIdentity = {
        kind: "artifact",
        runId: f.runId,
        objective: context.objectiveNumber,
        workItem: context.workItemNumber,
        attempt: reservation.attempt,
        artifactDigest: context.artifact.digest,
        baseSha: context.evidence.baseSha,
        outputTreeSha: context.evidence.outputTreeSha,
        evidenceDigest: context.evidence.digest,
      };
      const invocationId = `review-${reviewIdentityDigest(identity)}`;
      const markers = modelBudgets(f).filter(
        (event) => isModelInvocationMarker(event) && event.modelInvocationId === invocationId,
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        runId: f.runId,
        objective: context.objectiveNumber,
        workItem: context.workItemNumber,
        attempt: reservation.attempt,
        phase: "management",
        amount: 0,
        policyDigest: reservation.policyDigest,
        directorEpoch: reservation.directorEpoch,
      });
      expect(unresolvedModelInvocations(f.events())).toContainEqual(markers[0]);
      reviewCalls.push(invocationId);
      return review(context, checkpoint);
    };
    try {
      expect(await f.run()).toMatchObject({ status: "completed" });
      expect(workerCalls).toHaveLength(3);
      expect(reviewCalls).toHaveLength(3);
      const budgets = modelBudgets(f);
      const markers = budgets.filter(isModelInvocationMarker);
      expect(markers).toHaveLength(6);
      for (const marker of markers) {
        const actual = budgets.filter(
          (event) =>
            event.event === "BudgetReconciled" &&
            event.modelInvocationId === marker.modelInvocationId &&
            event.phase === marker.phase &&
            event.workItem === marker.workItem &&
            event.attempt === marker.attempt,
        );
        expect(actual).toHaveLength(1);
        expect(actual[0]).toMatchObject({
          amount: 6,
          runId: marker.runId,
          objective: marker.objective,
          policyDigest: marker.policyDigest,
          directorEpoch: marker.directorEpoch,
          reportedModelUsage: { inputTokens: 4, outputTokens: 2 },
        });
        expect(actual[0]!.sequence).toBeGreaterThan(marker.sequence);
        expect(actual[0]!.usageId).not.toMatch(/^invocation-/);
      }
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
      expect(deriveBudgetUsage(f.events()).modelTokens).toBe(36);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("retains unknown worker dispatch across restart without another launch or invented usage", async () => {
    const retained: worktrees.LocalWorktree[] = [];
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => {
          throw new Error("fixture: terminal counters and output unavailable");
        },
      }),
    });
    const create = worktrees.createLocalWorktree;
    vi.spyOn(worktrees, "createLocalWorktree").mockImplementation(async (...args) => {
      const worker = await create(...args);
      retained.push(worker);
      return worker;
    });
    try {
      await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
      const markers = modelBudgets(f).filter(isModelInvocationMarker);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        modelInvocationId: "worker-8-1",
        phase: "execution",
        amount: 0,
      });
      expect(modelBudgets(f).filter((event) => event.event === "BudgetReconciled")).toEqual([]);
      expect(unresolvedModelInvocations(f.events())).toEqual(markers);
      await expect(f.run()).rejects.toThrow(/completion is unknown after dispatch/);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
      expect(f.activity.filter((entry) => entry.operation.includes("review"))).toEqual([]);
      expect(modelBudgets(f)).toEqual(markers);
      expect(
        f
          .events()
          .filter((event) =>
            [
              "FactoryRunCompleted",
              "FactoryRunCancelled",
              "FactoryRunEscalated",
              "AttemptFailed",
              "AttemptDeferred",
            ].includes(event.event),
          ),
      ).toEqual([]);
      expect(retained).toHaveLength(1);
      await expect(access(retained[0]!.path)).resolves.toBeUndefined();
    } finally {
      await f.dispose();
      for (const worker of retained) await worktrees.cleanupLocalWorktree(worker);
    }
  }, 30_000);

  it("repairs an accepted immutable review's missing linked usage after restart without repeating that model call", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
    });
    const validate = vi.spyOn(cleanValidation, "validateArtifactClean");
    let held = true;
    let checkpointRef: string | undefined;
    let checkpointOid: string | undefined;
    const write = vi.mocked(GitHubControlStore.prototype.addIssueComment).getMockImplementation();
    if (!write) throw new Error("fixture receipt transport missing");
    vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
      async (node, body) => {
        const receipts = decodeEventComments(body);
        if (
          held &&
          receipts.some(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.unit === "model_tokens" &&
              event.phase === "management" &&
              event.workItem === 8,
          )
        ) {
          expect(checkpointRef).toBeDefined();
          checkpointOid = f.refs.get(checkpointRef!);
          expect(checkpointOid).toMatch(/^[0-9a-f]{40}$/);
          throw new PlatformUnavailableError(
            { kind: "server_error", retryAfterMs: 1 },
            new Error("fixture: review accounting write unavailable"),
          );
        }
        return write(node, body);
      },
    );
    const review = f.management.review;
    f.management.review = async (context, checkpoint) => {
      if (context.workItemNumber === 8) {
        checkpointRef = reviewCheckpointRef({
          kind: "artifact",
          runId: f.runId,
          objective: 7,
          workItem: 8,
          attempt: 1,
          artifactDigest: context.artifact.digest,
          baseSha: context.evidence.baseSha,
          outputTreeSha: context.evidence.outputTreeSha,
          evidenceDigest: context.evidence.digest,
        });
      }
      return review(context, checkpoint);
    };
    try {
      await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      const pending = unresolvedModelInvocations(f.events());
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ workItem: 8, attempt: 1, phase: "management", amount: 0 });
      expect(
        f.activity.filter((entry) => entry.operation === "review" && entry.workItem === 8),
      ).toHaveLength(1);
      expect(
        modelBudgets(f).filter(
          (event) =>
            event.event === "BudgetReconciled" &&
            event.workItem === 8 &&
            event.phase === "management",
        ),
      ).toEqual([]);
      held = false;
      const validationBeforeRestart = f.events().filter((event) => event.event === "ValidationRecorded" && event.workItem === 8);
      expect(validationBeforeRestart).toHaveLength(1);
      const artifactDigest = validate.mock.calls[0]![0].artifact.digest;
      expect(f.refs.has("refs/heads/factory/objective-7/work-item-8/attempt-1")).toBe(false);
      const result = await f.run();
      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" });
      expect(f.events().filter((event) => event.event === "ValidationRecorded" && event.workItem === 8)).toEqual(validationBeforeRestart);
      expect(validate.mock.calls.filter(([input]) => input.artifact.digest === artifactDigest)).toHaveLength(1);
      expect(f.events().filter((event) => event.event === "PublicationRecorded" && event.workItem === 8)).toHaveLength(1);
      expect(f.refs.get(checkpointRef!)).toBe(checkpointOid);
      expect(
        f.activity.filter((entry) => entry.operation === "review" && entry.workItem === 8),
      ).toHaveLength(1);
      expect(
        f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 8),
      ).toHaveLength(1);
      const actual = modelBudgets(f).filter(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.modelInvocationId === pending[0]!.modelInvocationId,
      );
      expect(actual).toHaveLength(1);
      expect(actual[0]).toMatchObject({
        amount: 6,
        workItem: 8,
        attempt: 1,
        phase: "management",
        directorEpoch: pending[0]!.directorEpoch,
        policyDigest: pending[0]!.policyDigest,
      });
      expect(actual[0]!.sequence).toBeGreaterThan(pending[0]!.sequence);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
