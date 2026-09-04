import { describe, expect, it } from "vitest";

import { type FactoryEvent, parseFactoryEvent } from "../src/protocol/events.js";
import { PROTOCOL_V2 } from "../src/protocol/limits.js";
import {
  DEFAULT_RUN_POLICY,
  assertRequirementsWithinPolicy,
  destinationAllowedByPolicy,
  parseRunPolicy,
  policyDigest,
} from "../src/protocol/policy.js";
import { parseWorkerPacket } from "../src/protocol/worker-packet.js";
import {
  decodeEventComments,
  decodeEventTrailer,
  deduplicateFactoryEvents,
  encodeEventComment,
  encodeEventTrailer,
  latestSupportedRun,
} from "../src/control/receipts.js";

const SHA = "a".repeat(40);

function runStarted(over: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    protocol: PROTOCOL_V2,
    kind: "run",
    event: "FactoryRunStarted",
    objective: 42,
    runId: "run-1",
    sequence: 1,
    at: "2026-09-03T00:00:00.000Z",
    actor: "operator",
    repository: "clockgrove/factory",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    ...over,
  } as FactoryEvent;
}

describe("v2 run policy", () => {
  it("defaults to local-only execution with bounded parallelism", () => {
    expect(DEFAULT_RUN_POLICY.backendOrder).toEqual([
      "codex-sdk/local-worktree",
      "codex-cli/local-worktree",
    ]);
    expect(DEFAULT_RUN_POLICY.maxParallel).toBe(8);
    expect(DEFAULT_RUN_POLICY.allowedPaidBackends).toEqual([]);
    expect(DEFAULT_RUN_POLICY.cloudFallback).toBe("never");
    expect(DEFAULT_RUN_POLICY.capacity?.mode).toBe("adaptive-local");
    expect(DEFAULT_RUN_POLICY.burst?.mode).toBe("never");
  });

  it("rejects a paid backend that was not explicitly allowed", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        backendOrder: ["codex-cli/daytona"],
        cloudFallback: "explicit",
        maxSandboxMinutes: 60,
      }),
    ).toThrow(/not explicitly allowed/);
  });

  it("rejects a sandbox selection with no sandbox budget", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        backendOrder: ["codex-cli/daytona"],
        allowedPaidBackends: ["codex-cli/daytona"],
        cloudFallback: "explicit",
      }),
    ).toThrow(/zero sandbox-minute budget/);
  });

  it("creates a stable digest independent of object key order", () => {
    const reversed = Object.fromEntries(Object.entries(DEFAULT_RUN_POLICY).reverse());
    expect(policyDigest(parseRunPolicy(reversed))).toBe(policyDigest(DEFAULT_RUN_POLICY));
  });

  it("keeps compiler-requested network and secret authority inside operator policy", () => {
    expect(
      destinationAllowedByPolicy("cdn.npmjs.org", DEFAULT_RUN_POLICY.allowedNetworkDestinations),
    ).toBe(true);
    expect(
      destinationAllowedByPolicy("npmjs.org", DEFAULT_RUN_POLICY.allowedNetworkDestinations),
    ).toBe(false);
    const requirements = {
      os: [],
      architecture: [],
      tools: [],
      services: [],
      networkDestinations: ["attacker.example"],
      permittedSecretNames: [],
      trust: "isolated" as const,
    };
    expect(() => assertRequirementsWithinPolicy(requirements, DEFAULT_RUN_POLICY)).toThrow(
      /outside run policy/,
    );
    expect(() =>
      assertRequirementsWithinPolicy(
        { ...requirements, networkDestinations: [], permittedSecretNames: ["DEPLOY_KEY"] },
        DEFAULT_RUN_POLICY,
      ),
    ).toThrow(/unsupported task secrets/);
  });
});

describe("v2 event protocol", () => {
  it("round-trips additive reported counters while keeping legacy absence and partial unknowns", () => {
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "budget",
      event: "BudgetReconciled",
      objective: 42,
      runId: "run-1",
      sequence: 1,
      at: "2026-09-03T00:00:00.000Z",
      phase: "execution",
      unit: "model_tokens",
      amount: 150,
      reportedModelUsage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0 },
    });
    expect(decodeEventComments(encodeEventComment("Usage", event))).toEqual([event]);
    const { reportedModelUsage: _usage, ...legacy } = event;
    expect(parseFactoryEvent(legacy)).not.toHaveProperty("reportedModelUsage");
    expect(
      parseFactoryEvent({ ...legacy, reportedModelUsage: { cachedInputTokens: 0 } }),
    ).toMatchObject({ reportedModelUsage: { cachedInputTokens: 0 } });
    for (const reportedModelUsage of [
      {},
      { inputTokens: -1 },
      { inputTokens: 1.5 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { inputTokens: 120, cachedInputTokens: 121 },
      { inputTokens: 120, outputTokens: 31 },
      { cachedInputTokens: null },
      { reasoningTokens: 1 },
    ])
      expect(() => parseFactoryEvent({ ...legacy, reportedModelUsage })).toThrow();
    for (const override of [
      { event: "BudgetReserved" },
      { unit: "managed_sessions" },
      { unit: "local_milliseconds" },
    ])
      expect(() => parseFactoryEvent({ ...event, ...override })).toThrow();
  });

  it("requires an attempt's reported total to match complete supplied input and output", () => {
    const event = {
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: "AttemptFailed",
      objective: 42,
      workItem: 43,
      attempt: 1,
      backend: "codex-cli/local-worktree",
      runId: "run-1",
      sequence: 2,
      at: "2026-09-03T00:00:00.000Z",
      baseSha: SHA,
      directorEpoch: 1,
      policyDigest: "b".repeat(64),
      reportedModelUsage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 80 },
    };
    expect(parseFactoryEvent({ ...event, reportedModelTokens: 150 })).toMatchObject({
      reportedModelTokens: 150,
    });
    expect(() => parseFactoryEvent(event)).toThrow();
    expect(() => parseFactoryEvent({ ...event, reportedModelTokens: 230 })).toThrow();
    expect(
      parseFactoryEvent({ ...event, reportedModelUsage: { inputTokens: 120 } }),
    ).not.toHaveProperty("reportedModelTokens");
  });
  it("round-trips comment and commit-trailer envelopes", () => {
    const event = runStarted();
    expect(decodeEventComments(encodeEventComment("Factory started.", event))).toEqual([event]);
    expect(decodeEventTrailer(`subject\n\n${encodeEventTrailer(event)}`)).toEqual(event);
  });

  it("ignores unknown fields from a future writer on the same protocol", () => {
    const event = parseFactoryEvent({ ...runStarted(), futureEvidence: { value: 1 } });
    expect(event.futureEvidence).toEqual({ value: 1 });
  });

  it("fails closed on an unsupported protocol", () => {
    expect(() =>
      parseFactoryEvent({ ...runStarted(), protocol: "clockgrove.factory/v3" }),
    ).toThrow();
  });

  it("rejects suspected credentials before persistence", () => {
    expect(() =>
      parseFactoryEvent({
        ...runStarted(),
        actor: `ghp_${"x".repeat(40)}`,
      }),
    ).toThrow(/suspected GitHub token/);
  });

  it("finds the newest non-terminal run", () => {
    const old = runStarted({ runId: "old", sequence: 1 });
    const stopped = runStarted({
      runId: "old",
      sequence: 2,
      event: "FactoryRunCancelled",
    });
    const current = runStarted({ runId: "current", sequence: 3 });
    expect(latestSupportedRun([current, stopped, old])?.runId).toBe("current");
  });

  it("keeps a run active after a cancellation request until terminal acknowledgement", () => {
    const started = runStarted();
    const requested = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "FactoryRunCancellationRequested",
      objective: 42,
      runId: "run-1",
      sequence: 2,
      at: "2026-09-03T00:01:00.000Z",
      requestedBy: "operator",
      requestId: "cancel-1",
    });
    expect(latestSupportedRun([started, requested])?.event).toBe("FactoryRunStarted");
    expect(
      deduplicateFactoryEvents([
        { ...requested, sequence: 8, at: "2026-09-03T00:08:00.000Z" },
        requested,
      ]),
    ).toEqual([requested]);
  });

  it("requires explicit rank evidence for a durable priority command", () => {
    const command = {
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "WorkItemPriorityChanged",
      objective: 42,
      runId: "run-1",
      sequence: 2,
      at: "2026-09-03T00:01:00.000Z",
      requestedBy: "operator",
      requestId: "priority-1",
      workItem: 43,
    };
    expect(() => parseFactoryEvent(command)).toThrow();
    expect(
      parseFactoryEvent({
        ...command,
        priorityRank: 7,
        prioritySource: "operator-command",
      }),
    ).toMatchObject({ priorityRank: 7, prioritySource: "operator-command" });
  });

  it("accepts durable activation, queue, capacity, and attributed admission events", () => {
    const activation = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "ActivationRequested",
      objective: 42,
      runId: "activation-1",
      sequence: 1,
      at: "2026-09-03T00:00:00.000Z",
      requestedBy: "operator",
      requestId: "request-1",
      repository: "clockgrove/factory",
      baseSha: SHA,
      policy: DEFAULT_RUN_POLICY,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      controllerProtocolMin: "clockgrove.factory/v2",
      controllerProtocolMax: "clockgrove.factory/v2",
    });
    const queued = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "scheduling",
      event: "WorkItemQueued",
      objective: 42,
      runId: "run-1",
      sequence: 2,
      at: "2026-09-03T00:01:00.000Z",
      workItem: 43,
      directorEpoch: 1,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      reason: "local pressure",
      observedPriorityRank: 10,
      observedSubIssuePosition: 0,
    });
    const rejection = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "ActivationRejected",
      objective: 42,
      runId: "activation-1",
      sequence: 2,
      at: "2026-09-03T00:01:00.000Z",
      activationRequestId: "request-1",
      requestedBy: "operator",
      baseSha: SHA,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      reason: "base advanced",
    });
    const capacity = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "capacity",
      event: "CapacityReserved",
      objective: 42,
      runId: "run-1",
      sequence: 3,
      at: "2026-09-03T00:02:00.000Z",
      workItem: 43,
      attempt: 1,
      phase: "validation",
      backend: "codex-cli/daytona",
      requestedCpu: 1,
      requestedMemoryMb: 2_048,
      directorEpoch: 1,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    });
    const admission = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "attempt",
      event: "AttemptReserved",
      objective: 42,
      runId: "run-1",
      sequence: 4,
      at: "2026-09-03T00:03:00.000Z",
      workItem: 43,
      attempt: 1,
      backend: "codex-cli/local-worktree",
      baseSha: SHA,
      directorEpoch: 1,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      admissionClass: "local",
      admissionReason: "local-capacity",
      requestedCpu: 1,
      requestedMemoryMb: 2_048,
      priorityRank: 10,
      subIssuePosition: 0,
      criticalPathLength: 2,
      unfinishedDownstream: 1,
      capacityMeasuredAt: "2026-09-03T00:02:59.000Z",
      effectiveCpu: 8,
      availableMemoryMb: 8_192,
      loadRatio: 0.25,
      memoryUsageRatio: 0.5,
      sessionId: "thread-1",
      modelProfile: "frontier",
      reportedModelTokens: 123,
    });
    expect(activation.event).toBe("ActivationRequested");
    expect(rejection.event).toBe("ActivationRejected");
    expect(queued.kind).toBe("scheduling");
    expect(capacity.kind).toBe("capacity");
    expect(admission.kind).toBe("attempt");
  });

  it("accepts durable delivery and exact-head publication receipts", () => {
    const delivery = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "delivery",
      event: "DeliverySelected",
      objective: 42,
      runId: "run-1",
      sequence: 5,
      at: "2026-09-03T00:04:00.000Z",
      requested: "stacked-prs",
      selected: "native-stacks",
      capabilityVersion: "2026-03-10",
      reason: "repository probe accepted the preview API",
    });
    const publication = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "publication",
      event: "StackLinked",
      objective: 42,
      runId: "run-1",
      sequence: 6,
      at: "2026-09-03T00:05:00.000Z",
      workItem: 43,
      attempt: 1,
      unitId: "delivery/item-a",
      itemId: "item-a",
      mode: "native-stacks",
      position: 0,
      branch: "factory/objective-42/work-item-43/attempt-1",
      baseBranch: "main",
      baseSha: SHA,
      headSha: "b".repeat(40),
      pullRequest: 44,
      capabilityVersion: "2026-03-10",
      validationDigest: "c".repeat(64),
      exactHeadValidationDigest: "d".repeat(64),
      stackNumber: 7,
    });
    expect(delivery.kind).toBe("delivery");
    expect(publication.kind).toBe("publication");
  });

  it("rejects publication receipts with incomplete topology or transition evidence", () => {
    const publication = {
      protocol: PROTOCOL_V2,
      kind: "publication",
      objective: 42,
      runId: "run-1",
      sequence: 6,
      at: "2026-09-03T00:05:00.000Z",
      workItem: 43,
      attempt: 1,
      unitId: "delivery/item-a",
      itemId: "item-a",
      mode: "native-stacks",
      position: 0,
      branch: "factory/objective-42/work-item-43/attempt-1",
      baseBranch: "main",
      baseSha: SHA,
      headSha: "b".repeat(40),
      pullRequest: 44,
      capabilityVersion: "2026-03-10",
      validationDigest: "c".repeat(64),
      exactHeadValidationDigest: "d".repeat(64),
    };
    expect(() => parseFactoryEvent({ ...publication, event: "StackLinked" })).toThrow(
      /stack number/,
    );
    expect(() => parseFactoryEvent({ ...publication, event: "ValidationInvalidated" })).toThrow(
      /head-change cause/,
    );
    expect(() => parseFactoryEvent({ ...publication, event: "IntegrationPending" })).toThrow(
      /operation ID/,
    );
  });
});

describe("Worker Packet", () => {
  it("accepts a bounded local packet", () => {
    const packet = parseWorkerPacket({
      goal: "Add invitation persistence.",
      acceptanceCriteria: ["Invitations survive a restart."],
      allowedPaths: ["src/invitations/", "test/invitations.test.ts"],
      preconditions: [],
      outOfScope: ["Email delivery"],
      conventions: ["Use the existing repository adapter."],
      baseSha: SHA,
      validationCommands: ["npm test -- invitations"],
      requirements: { trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    });
    expect(packet.requirements.networkDestinations).toEqual([]);
  });

  it("rejects secret values while permitting secret names", () => {
    const base = {
      goal: "Use the mail provider.",
      acceptanceCriteria: ["Mail is sent."],
      allowedPaths: ["src/mail.ts"],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: {
        trust: "isolated",
        permittedSecretNames: ["OPENAI_API_KEY"],
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    expect(parseWorkerPacket(base).requirements.permittedSecretNames).toEqual(["OPENAI_API_KEY"]);
    expect(() => parseWorkerPacket({ ...base, conventions: [`sk-${"x".repeat(40)}`] })).toThrow(
      /suspected OpenAI API key/,
    );
  });

  it("rejects absolute, traversing, and glob scope entries", () => {
    const base = {
      goal: "Change one file.",
      acceptanceCriteria: ["The change is tested."],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: { trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    for (const path of ["/etc/passwd", "../outside", "src/*", "src\\file.ts"]) {
      expect(() => parseWorkerPacket({ ...base, allowedPaths: [path] })).toThrow(/scope/i);
    }
  });

  it("accepts bounded context, change-surface, delivery, and duration metadata", () => {
    const packet = parseWorkerPacket({
      goal: "Add the scheduler.",
      acceptanceCriteria: ["Admissions are deterministic."],
      allowedPaths: ["src/scheduling/"],
      baseSha: SHA,
      validationCommands: ["npm test -- scheduling"],
      requirements: {
        trust: "trusted_local",
        estimatedDurationMinutes: 20,
      },
      context: {
        mustRead: ["docs/DESIGN.md"],
        searchSeeds: ["admission controller"],
        dependencyEvidence: [{ workItem: "policy", commit: SHA }],
      },
      changeSurface: {
        mergeClass: "exclusive",
        exclusiveResources: ["scheduler-registry"],
      },
      delivery: {
        group: "scheduler",
        relationship: "continue-stack",
        parentWorkItem: "policy",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    });
    expect(packet.context?.mustRead).toEqual(["docs/DESIGN.md"]);
    expect(packet.requirements.estimatedDurationMinutes).toBe(20);
  });

  it("rejects contradictory change-surface and stack metadata", () => {
    const base = {
      goal: "Add one file.",
      acceptanceCriteria: ["It is tested."],
      allowedPaths: ["src/a.ts"],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: { trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    expect(() =>
      parseWorkerPacket({
        ...base,
        changeSurface: {
          mergeClass: "parallel-safe",
          exclusiveResources: ["singleton-editor"],
        },
      }),
    ).toThrow(/parallel-safe/);
    expect(() =>
      parseWorkerPacket({
        ...base,
        delivery: { group: "stack", relationship: "continue-stack" },
      }),
    ).toThrow(/parentWorkItem/);
  });
});
