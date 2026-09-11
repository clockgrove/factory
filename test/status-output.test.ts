import { describe, expect, it } from "vitest";

import { buildExplanationReport } from "../src/application/explain.js";
import { buildReplayReport } from "../src/application/replay.js";
import { buildStatusReport, type FactoryReadSnapshot } from "../src/application/status.js";
import { EXPLANATION_CODES } from "../src/explanations/index.js";
import type { GitHubMutationTelemetry } from "../src/platform.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest, type RunPolicy } from "../src/protocol/policy.js";

const cloudId = "codex-cli/daytona";
const policy: RunPolicy = {
  ...DEFAULT_RUN_POLICY,
  backendOrder: ["codex-cli/local-worktree", cloudId],
  cloudFallback: "explicit",
  allowedPaidBackends: [cloudId],
  maxSandboxMinutes: 30,
  burst: {
    mode: "queue-delay",
    backendOrder: [cloudId],
    maxCloudParallel: 2,
    queueDelaySeconds: 120,
    deadlineReserveMinutes: 60,
    maxPriorityRank: 20,
  },
};
const sha = "a".repeat(40);

function event(value: Record<string, unknown>): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "run-status",
    at: "2026-09-04T12:00:00.000Z",
    ...value,
  });
}

function snapshot(): FactoryReadSnapshot {
  return {
    id: "objective-node",
    number: 7,
    title: "Build the thing",
    authorLogin: "private-operator-name",
    defaultBranch: "main",
    closed: false,
    readAt: new Date("2026-09-04T12:01:00.000Z"),
    factoryEvents: [
      event({
        kind: "run",
        event: "FactoryRunStarted",
        sequence: 1,
        actor: "private-operator-name",
        repository: "clockgrove/factory",
        objectiveAuthor: "private-operator-name",
        fork: false,
        baseBranch: "main",
        policy,
        policyDigest: policyDigest(policy),
      }),
      event({
        kind: "controller",
        event: "ControllerObserved",
        sequence: 2,
        controllerId: "private-machine-id",
        epoch: 4,
        expiresAt: "2026-09-04T12:05:00.000Z",
        controllerPolicyDigest: "c".repeat(64),
        protocolMin: "clockgrove.factory/v2",
        protocolMax: "clockgrove.factory/v2",
      }),
    ],
    workItems: [
      {
        id: "item-10",
        number: 10,
        title: "Cloud burst item",
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        subIssuePosition: 0,
        issueFieldValues: [],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [
          event({
            kind: "attempt",
            event: "AttemptReserved",
            sequence: 3,
            workItem: 10,
            attempt: 1,
            backend: cloudId,
            baseSha: sha,
            directorEpoch: 4,
            policyDigest: policyDigest(policy),
            providerResourceId: "raw-provider-response-secret",
            admissionClass: "burst",
            admissionReason: "queue-delay",
            requestedCpu: 2,
            requestedMemoryMb: 4_096,
            priorityRank: 1,
            subIssuePosition: 0,
            criticalPathLength: 1,
            unfinishedDownstream: 1,
            capacityMeasuredAt: "2026-09-04T12:00:00.000Z",
            effectiveCpu: 16,
            availableMemoryMb: 48_000,
            loadRatio: 0.2,
            memoryUsageRatio: 0.3,
          }),
          event({
            kind: "budget",
            event: "BudgetReserved",
            sequence: 4,
            workItem: 10,
            attempt: 1,
            phase: "execution",
            unit: "sandbox_milliseconds",
            amount: 120_000,
          }),
        ],
      },
      {
        id: "item-11",
        number: 11,
        title: "Waiting item",
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        subIssuePosition: 1,
        issueFieldValues: [],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [
          event({
            kind: "scheduling",
            event: "WorkItemQueued",
            sequence: 5,
            workItem: 11,
            directorEpoch: 4,
            policyDigest: policyDigest(policy),
            reason: "burst-trigger-pending: raw provider OAuth response must never be returned",
            reasonCode: "burst-trigger-pending",
            gate: "economic",
            observedPriorityRank: 2,
            observedSubIssuePosition: 1,
            prioritySource: "subissue-order",
          }),
        ],
      },
      {
        id: "item-12",
        number: 12,
        title: "Dependency blocked item",
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        subIssuePosition: 2,
        issueFieldValues: [],
        blockedBy: [{ number: 99, closed: false }],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      },
    ],
  };
}

function processTelemetry(
  counts: Pick<GitHubMutationTelemetry, "admitted" | "transported" | "successful"> = {
    admitted: 8,
    transported: 7,
    successful: 6,
  },
): GitHubMutationTelemetry {
  return {
    measurementScope: "process-local",
    measurementWindow: {
      startedAt: "2026-09-04T12:00:00.000Z",
      observedAt: "2026-09-04T12:05:00.000Z",
    },
    ...counts,
    serverPrimaryQuota: [
      {
        resource: "core",
        limit: 5000,
        remaining: 4993,
        used: 7,
        resetAt: "2026-09-04T13:00:00.000Z",
        observedAt: "2026-09-04T12:05:00.000Z",
      },
    ],
    localSecondaryEstimate: {
      transportedLastMinute: counts.transported === 0 ? 0 : 2,
      transportedLastHour: counts.transported,
      estimatedHourlyCapacity: 499,
      confidence: "low",
      secondaryRefusals: 0,
      limitingReason: "local-secondary-estimate",
      nextAdmissionAt: "2026-09-04T12:05:07.215Z",
    },
  };
}

describe("bounded status, explain, and replay output", () => {
  it("reports latest observed queue transitions while preserving original age and old sample timestamps", () => {
    const current = snapshot();
    const waiting = current.workItems.find((item) => item.number === 11)!;
    const first = waiting.factoryEvents![0]!;
    waiting.factoryEvents = [
      { ...first, reasonCode: "local-capacity", gate: "capacity" },
      {
        ...first,
        sequence: 6,
        at: "2026-09-04T12:00:20.000Z",
        reasonCode: "local-pressure",
        gate: "capacity",
      },
      {
        ...first,
        sequence: 7,
        at: "2026-09-04T12:00:30.000Z",
        reasonCode: "local-cooldown",
        gate: "capacity",
      },
    ] as FactoryEvent[];
    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(status.workItems.find((item) => item.number === 11)).toMatchObject({
      queuedSince: first.at,
      queueReasonCode: "local-cooldown",
    });
    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: current,
    });
    expect(explanation.explanations.find((item) => item.workItem === 11)?.code).toBe(
      EXPLANATION_CODES.capacityCooldown,
    );
    const replay = buildReplayReport({ repository: "clockgrove/factory", snapshot: current });
    expect(replay.run.availability).toBe("observed");
    if (replay.run.availability !== "observed") throw new Error("missing run");
    expect(
      replay.run.decisions.filter((item) => item.workItem === 11).map((item) => item.reasonCode),
    ).toEqual(["local-capacity", "local-pressure", "local-cooldown"]);
    expect(
      replay.run.decisions
        .filter((item) => item.workItem === 11)
        .every((item) => !("capacity" in item)),
    ).toBe(true);
    expect(replay.run.decisions.find((item) => item.decision === "admitted")).toMatchObject({
      capacity: { measuredAt: "2026-09-04T12:00:00.000Z" },
    });
  });

  it("shows ready order, capacity, reservations, queue age, priority, burst, and budget", () => {
    const report = buildStatusReport({
      repository: "clockgrove/factory",
      snapshot: snapshot(),
    });
    expect(report.readyOrder).toEqual([
      {
        position: 1,
        workItem: 11,
        rank: 100,
        source: "subissue-order",
        subIssuePosition: 1,
        criticalPathLength: 0,
        unfinishedDownstream: 0,
      },
    ]);
    expect(report.capacity.configured).toMatchObject({
      availability: "observed",
      maxParallel: 2,
      localMaxWorkers: 2,
      cloudMaxWorkers: 2,
    });
    expect(report.capacity.observed).toMatchObject({
      active: 1,
      local: 0,
      cloud: 1,
      latestHostSample: {
        availability: "observed",
        effectiveCpu: 16,
        availableMemoryMb: 48_000,
      },
    });
    expect(report.capacity.activeReservations).toMatchObject([
      {
        workItem: 10,
        attempt: 1,
        backendId: cloudId,
        admissionClass: "burst",
      },
    ]);
    expect(report.workItems.find((item) => item.number === 11)).toMatchObject({
      queuedSince: "2026-09-04T12:00:00.000Z",
      queueReasonCode: "burst-trigger-pending",
      priority: {
        rank: 2,
        source: "subissue-order",
        sourceEvidence: "queue-receipt",
      },
    });
    expect(report.burst).toMatchObject({
      configured: { mode: "queue-delay", maxCloudParallel: 2 },
      admitted: [{ workItem: 10, attempt: 1, trigger: "queue-delay", backendId: cloudId }],
    });
    expect(report.summary?.economics.budgets.sandboxMilliseconds).toEqual({
      configured: 1_800_000,
      committed: 120_000,
      remaining: 1_680_000,
    });
    expect(report.operatorAction).toMatchObject({
      required: false,
      monitoring: "continue",
      code: "run-active",
      evidence: { runId: "run-status" },
    });
  });

  it("reports active-process telemetry with its scope and window outside run economics", () => {
    const platformTelemetry = processTelemetry();
    const report = buildStatusReport({
      repository: "clockgrove/factory",
      snapshot: snapshot(),
      platformTelemetry,
    });
    expect(report.github).toEqual(platformTelemetry);
    expect(report.summary?.economics.githubMutations).toEqual({
      availability: "unavailable",
      reason: "no durable run-attributed GitHub mutation measurement is present",
    });
  });

  it("does not attribute a new reader process's zero counters to a completed run", () => {
    const terminal = snapshot();
    terminal.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunCompleted",
        sequence: 6,
        at: "2026-09-04T12:02:00.000Z",
      }),
    );
    const readerTelemetry = processTelemetry({ admitted: 0, transported: 0, successful: 0 });
    const report = buildStatusReport({
      repository: "clockgrove/factory",
      snapshot: terminal,
      platformTelemetry: readerTelemetry,
    });
    expect(report.run).toMatchObject({ state: "completed" });
    expect(report.operatorAction).toMatchObject({
      required: false,
      monitoring: "stop",
      code: "run-completed",
      evidence: { runId: "run-status", terminalAt: "2026-09-04T12:02:00.000Z" },
    });
    expect(report.github).toEqual(readerTelemetry);
    expect(report.summary?.economics.githubMutations).toMatchObject({
      availability: "unavailable",
    });
  });

  it("keeps status and summary active when canonical authority rejects a stale terminal", () => {
    const current = snapshot();
    current.factoryEvents![1] = event({
      ...current.factoryEvents![1]!,
      writerEpoch: 1,
      controllerId: "old-controller",
      epoch: 1,
    });
    current.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunCompleted",
        sequence: 6,
        at: "2026-09-04T12:02:00.000Z",
        writerOperationId: "e".repeat(64),
        writerHolder: "old-controller",
        writerEpoch: 1,
        writerPolicyDigest: policyDigest(policy),
      }),
    );
    current.objectiveAuthority = {
      objective: 7,
      runId: "run-status",
      holder: "current-controller",
      epoch: 2,
      policyDigest: policyDigest(policy),
      sequence: 7,
      oid: "f".repeat(40),
      expiresAt: new Date("2026-09-04T12:10:00.000Z"),
      observedAt: new Date("2026-09-04T12:03:00.000Z"),
    };

    const report = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });

    expect(report.run).toMatchObject({ state: "active" });
    expect(report.summary).toMatchObject({ outcome: "active" });
    expect(report.summary).not.toHaveProperty("finishedAt");
    expect(report.summary?.elapsedMilliseconds).toMatchObject({ availability: "unavailable" });
  });

  it("marks historical run mutation measurements unavailable without process telemetry", () => {
    const report = buildStatusReport({
      repository: "clockgrove/factory",
      snapshot: snapshot(),
    });
    expect(report.github).toBeUndefined();
    expect(report.summary?.economics.githubMutations).toEqual({
      availability: "unavailable",
      reason: "no durable run-attributed GitHub mutation measurement is present",
    });
  });

  it("reports a durable provider quota refusal as a stopped human-action gate", () => {
    const current = snapshot();
    current.workItems[0]!.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        sequence: 4,
        at: "2026-09-04T12:00:29.000Z",
        phase: "execution",
        unit: "model_tokens",
        amount: 0,
        usageId: "invocation-worker-10-1",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        directorEpoch: 4,
        policyDigest: policyDigest(policy),
      }),
      event({
        kind: "provider",
        event: "ProviderQuotaBlocked",
        sequence: 5,
        at: "2026-09-04T12:00:30.000Z",
        reasonCode: "provider-quota-exhausted",
        provider: "github-copilot",
        phase: "execution",
        backend: "codex-cli/local-worktree",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        providerMessage: "GitHub Copilot monthly quota exceeded",
        actionUrl: "https://github.com/settings/copilot/features",
        accounting: "unknown",
      }),
    );
    current.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunEscalated",
        sequence: 6,
        at: "2026-09-04T12:00:31.000Z",
        reason: "GitHub Copilot monthly quota exceeded",
      }),
    );

    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(status.operatorAction).toMatchObject({
      required: true,
      monitoring: "stop",
      code: "provider-quota",
      evidence: {
        reasonCode: "provider-quota-exhausted",
        phase: "execution",
        backend: "codex-cli/local-worktree",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        accounting: "unknown",
        factoryWorkActive: false,
      },
    });

    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: current,
    });
    expect(explanation.explanations[0]).toMatchObject({
      code: EXPLANATION_CODES.providerQuotaExhausted,
      category: "provider",
      disposition: "blocked",
      gate: "provider",
      evidence: { factoryWorkActive: false, monitoring: "stop" },
    });
    expect(explanation.explanations[0]?.requiredAction).toContain("factory_recovery_plan");
  });

  it("keeps monitoring a provider-neutral quota gate until terminal drain is durable", () => {
    const current = snapshot();
    current.workItems[0]!.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        sequence: 4,
        at: "2026-09-04T12:00:29.000Z",
        phase: "execution",
        unit: "model_tokens",
        amount: 0,
        usageId: "invocation-worker-10-1",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        directorEpoch: 4,
        policyDigest: policyDigest(policy),
      }),
      event({
        kind: "provider",
        event: "ProviderQuotaBlocked",
        sequence: 5,
        at: "2026-09-04T12:00:30.000Z",
        reasonCode: "provider-quota-exhausted",
        provider: "another-model-provider",
        phase: "execution",
        backend: "another/local-backend",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        providerMessage: "Model provider quota requires operator action",
        actionUrl: "https://provider.example/quota",
        accounting: "unknown",
      }),
    );

    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(status.run).toMatchObject({ state: "provider-gated" });
    expect(status.operatorAction).toMatchObject({
      required: true,
      monitoring: "continue",
      code: "provider-quota-draining",
      evidence: {
        provider: "another-model-provider",
        factoryWorkActive: true,
      },
    });

    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: current,
    }).explanations[0]!;
    expect(explanation).toMatchObject({
      code: EXPLANATION_CODES.providerQuotaExhausted,
      evidence: { factoryWorkActive: true, monitoring: "continue" },
    });
    expect(explanation.requiredAction).toContain('provider "another-model-provider"');
    expect(explanation.requiredAction).not.toContain("GitHub Copilot");

    current.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunEscalated",
        sequence: 6,
        at: "2026-09-04T12:00:31.000Z",
        reason: "Model provider quota requires operator action",
      }),
    );
    const stopped = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(stopped.operatorAction).toMatchObject({
      required: true,
      monitoring: "stop",
      code: "provider-quota",
      evidence: { provider: "another-model-provider", factoryWorkActive: false },
    });
    expect(
      "requiredAction" in stopped.operatorAction && stopped.operatorAction.requiredAction,
    ).toBe(
      'Restore quota for provider "another-model-provider" at https://provider.example/quota, then explicitly request recovery through factory_recovery_plan. Do not keep polling or retry this invocation.',
    );
  });

  it("keeps ordinary terminal guidance when a quota-gated run is cancelled", () => {
    const current = snapshot();
    current.workItems[0]!.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        sequence: 4,
        at: "2026-09-04T12:00:29.000Z",
        phase: "execution",
        unit: "model_tokens",
        amount: 0,
        usageId: "invocation-worker-10-1",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        directorEpoch: 4,
        policyDigest: policyDigest(policy),
      }),
      event({
        kind: "provider",
        event: "ProviderQuotaBlocked",
        sequence: 5,
        at: "2026-09-04T12:00:30.000Z",
        reasonCode: "provider-quota-exhausted",
        provider: "another-model-provider",
        phase: "execution",
        backend: "another/local-backend",
        modelInvocationId: "worker-10-1",
        workItem: 10,
        attempt: 1,
        providerMessage: "Model provider quota requires operator action",
        actionUrl: "https://provider.example/quota",
        accounting: "unknown",
      }),
    );
    current.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunCancellationRequested",
        sequence: 6,
        at: "2026-09-04T12:00:31.000Z",
        requestedBy: "private-operator-name",
        requestId: "cancel-provider-gated-run",
        reason: "operator requested cancellation",
      }),
    );

    const pending = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(pending.run).toMatchObject({ state: "provider-gated" });
    expect(pending.operatorAction).toMatchObject({
      required: false,
      monitoring: "continue",
      code: "run-draining",
      evidence: { cancellationRequestId: "cancel-provider-gated-run" },
    });
    expect(JSON.stringify(pending.operatorAction)).not.toContain("Restore quota");
    expect(
      buildExplanationReport({ repository: "clockgrove/factory", snapshot: current }).explanations,
    ).not.toContainEqual(
      expect.objectContaining({ code: EXPLANATION_CODES.providerQuotaExhausted }),
    );

    current.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunCancelled",
        sequence: 7,
        at: "2026-09-04T12:00:32.000Z",
        reason: "operator requested cancellation",
      }),
    );

    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(status.run).toMatchObject({ state: "cancelled" });
    expect(status.operatorAction).toMatchObject({
      required: false,
      monitoring: "stop",
      code: "run-cancelled",
    });
    expect(JSON.stringify(status.operatorAction)).not.toContain("Restore quota");

    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: current,
    });
    expect(explanation.explanations).not.toContainEqual(
      expect.objectContaining({ code: EXPLANATION_CODES.providerQuotaExhausted }),
    );
  });

  it("binds status and explanation to a terminal recovery successor instead of an older escalation", () => {
    const current = snapshot();
    const successorRunId =
      "recovery-a0546ecd67c3311ec6ad54e7c0e372cc3926c77c004b2888550968f080d8643b";
    const terminalReason =
      "successor artifact-only recovery requires an explicit artifact consumer; no replacement worker is authorized";
    current.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunEscalated",
        sequence: 6,
        at: "2026-09-04T12:02:00.000Z",
        reason: "older predecessor escalation must not be selected",
      }),
      event({
        kind: "run",
        event: "FactoryRunStarted",
        runId: successorRunId,
        sequence: 7,
        at: "2026-09-04T12:03:00.000Z",
        actor: "private-operator-name",
        repository: "clockgrove/factory",
        objectiveAuthor: "private-operator-name",
        fork: false,
        baseBranch: "main",
        policy,
        policyDigest: policyDigest(policy),
        baseSha: sha,
        recoveryRequestId: "recovery-request-7",
        recoveryPlanDigest: "d".repeat(64),
        predecessorRunId: "run-status",
      }),
      event({
        kind: "run",
        event: "FactoryRunEscalated",
        runId: successorRunId,
        sequence: 8,
        at: "2026-09-04T12:04:00.000Z",
        reason: terminalReason,
      }),
    );

    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot: current });
    expect(status.run).toMatchObject({
      availability: "observed",
      runId: successorRunId,
      state: "escalated",
      terminal: {
        runId: successorRunId,
        event: "FactoryRunEscalated",
        sequence: 8,
        at: "2026-09-04T12:04:00.000Z",
        reason: terminalReason,
        reasonDigest: "0536a190cf51e1d827a3ebdfd212e9dd59016f2dbd56544b9c9184f5092276ac",
      },
    });
    expect(JSON.stringify(status.run)).not.toContain("older predecessor escalation");
    expect(status.operatorAction).toMatchObject({
      required: true,
      monitoring: "stop",
      code: "recovery-successor-escalated",
      summary: expect.stringContaining(terminalReason),
      evidence: {
        runId: successorRunId,
        terminalSequence: 8,
        reason: terminalReason,
      },
    });

    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: current,
    });
    expect(explanation.explanations[0]).toMatchObject({
      code: EXPLANATION_CODES.recoverySuccessorEscalated,
      category: "recovery",
      disposition: "failed",
      summary: terminalReason,
      gate: "recovery-successor",
      requiredAction: expect.stringContaining("factory_recovery_plan"),
      evidence: {
        runId: successorRunId,
        predecessorRunId: "run-status",
        terminalEvent: "FactoryRunEscalated",
        terminalSequence: 8,
        terminalAt: "2026-09-04T12:04:00.000Z",
        reason: terminalReason,
        reasonDigest: "0536a190cf51e1d827a3ebdfd212e9dd59016f2dbd56544b9c9184f5092276ac",
        factoryWorkActive: false,
        monitoring: "stop",
      },
    });
  });

  it("reports an exact activation rejection as a stopped human-action gate", () => {
    const rejected = snapshot();
    rejected.workItems = [];
    rejected.factoryEvents = [
      event({
        kind: "run",
        event: "ActivationRequested",
        runId: "activation-rejected",
        sequence: 1,
        requestedBy: "private-operator-name",
        requestId: "activation-rejected",
        repository: "clockgrove/factory",
        baseSha: sha,
        policy,
        policyDigest: policyDigest(policy),
        controllerProtocolMin: "clockgrove.factory/v2",
        controllerProtocolMax: "clockgrove.factory/v2",
      }),
      event({
        kind: "run",
        event: "ActivationRejected",
        runId: "activation-rejected",
        sequence: 2,
        at: "2026-09-04T12:00:01.000Z",
        activationRequestId: "activation-rejected",
        requestedBy: "private-operator-name",
        baseSha: sha,
        policyDigest: policyDigest(policy),
        reason: "existing Work Item graph packet is malformed",
      }),
    ];

    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot: rejected });
    expect(status.activation).toEqual({
      requestId: "activation-rejected",
      state: "rejected",
      rejectionReason: "existing Work Item graph packet is malformed",
      rejectedAt: "2026-09-04T12:00:01.000Z",
    });
    expect(status.run).toEqual({ availability: "unavailable", state: "not-started" });
    expect(status.operatorAction).toMatchObject({
      required: true,
      monitoring: "stop",
      code: "activation-rejected",
      summary: expect.stringContaining("existing Work Item graph packet is malformed"),
      evidence: {
        activationRequestId: "activation-rejected",
        reason: "existing Work Item graph packet is malformed",
      },
    });

    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: rejected,
    });
    expect(explanation.explanations).toMatchObject([
      {
        code: EXPLANATION_CODES.authorityActivationRejected,
        category: "authority",
        disposition: "failed",
        gate: "activation",
        summary: "existing Work Item graph packet is malformed",
        evidence: {
          activationRequestId: "activation-rejected",
          rejectedAt: "2026-09-04T12:00:01.000Z",
          reason: "existing Work Item graph packet is malformed",
          factoryWorkActive: false,
          monitoring: "stop",
        },
      },
    ]);

    const conflicting = structuredClone(rejected);
    conflicting.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunStarted",
        sequence: 3,
        actor: "private-operator-name",
        repository: "clockgrove/factory",
        objectiveAuthor: "private-operator-name",
        fork: false,
        baseBranch: "main",
        policy,
        policyDigest: policyDigest(policy),
        activationRequestId: "activation-rejected",
        baseSha: sha,
      }),
    );
    expect(() =>
      buildStatusReport({ repository: "clockgrove/factory", snapshot: conflicting }),
    ).toThrow("activation rejection conflicts with its authenticated run start");
  });

  it("rejects an activation rejection that differs from its immutable request", () => {
    const rejected = snapshot();
    rejected.workItems = [];
    rejected.factoryEvents = [
      event({
        kind: "run",
        event: "ActivationRequested",
        runId: "activation-rejected",
        sequence: 1,
        requestedBy: "private-operator-name",
        requestId: "activation-rejected",
        repository: "clockgrove/factory",
        baseSha: sha,
        policy,
        policyDigest: policyDigest(policy),
        controllerProtocolMin: "clockgrove.factory/v2",
        controllerProtocolMax: "clockgrove.factory/v2",
      }),
      event({
        kind: "run",
        event: "ActivationRejected",
        runId: "activation-rejected",
        sequence: 2,
        activationRequestId: "activation-rejected",
        requestedBy: "different-operator",
        baseSha: sha,
        policyDigest: policyDigest(policy),
        reason: "forged rejection",
      }),
    ];

    expect(() =>
      buildStatusReport({ repository: "clockgrove/factory", snapshot: rejected }),
    ).toThrow("activation rejection differs from its immutable activation binding");
  });

  it("returns stable explanations without provider responses", () => {
    const report = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: snapshot(),
      workItem: 11,
    });
    expect(report.explanations).toMatchObject([
      {
        workItem: 11,
        category: "economic",
        code: EXPLANATION_CODES.economicBurstTriggerPending,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("OAuth");
  });

  it("reconstructs decisions without writes and labels unavailable simulation honestly", () => {
    const report = buildReplayReport({
      repository: "clockgrove/factory",
      snapshot: snapshot(),
    });
    expect(report.writeFree).toBe(true);
    expect(report.run).toMatchObject({
      availability: "observed",
      runId: "run-status",
      decisions: [
        { workItem: 10, decision: "admitted", reasonCode: "queue-delay" },
        {
          workItem: 11,
          decision: "queued",
          reasonCode: "burst-trigger-pending",
        },
      ],
    });
    expect(report.schedulerSimulation.availability).toBe("unavailable");
    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain("raw-provider-response-secret");
    expect(encoded).not.toContain("OAuth");
    expect(encoded).not.toContain("private-machine-id");
    expect(encoded).not.toContain("private-operator-name");
  });

  it("does not report stale capacity after the latest run is terminal", () => {
    const terminal = snapshot();
    terminal.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunCompleted",
        sequence: 6,
        at: "2026-09-04T12:02:00.000Z",
      }),
    );
    terminal.readAt = new Date("2026-09-04T12:02:00.000Z");
    const report = buildStatusReport({
      repository: "clockgrove/factory",
      snapshot: terminal,
    });
    expect(report.run).toMatchObject({ state: "completed" });
    expect(report.capacity.observed.active).toBe(0);
    expect(report.capacity.activeReservations).toEqual([]);
  });

  it("reports replayed operational commands and priority overrides", () => {
    const commanded = snapshot();
    commanded.factoryEvents!.push(
      event({
        kind: "run",
        event: "RunPauseRequested",
        sequence: 6,
        requestedBy: "private-operator-name",
        requestId: "pause-status",
      }),
      event({
        kind: "run",
        event: "CloudPauseRequested",
        sequence: 7,
        requestedBy: "private-operator-name",
        requestId: "pause-cloud-status",
      }),
      event({
        kind: "run",
        event: "WorkItemRetryRequested",
        sequence: 8,
        requestedBy: "private-operator-name",
        requestId: "retry-status",
        workItem: 11,
      }),
      event({
        kind: "run",
        event: "WorkItemPriorityChanged",
        sequence: 9,
        requestedBy: "private-operator-name",
        requestId: "priority-status",
        workItem: 11,
        priorityRank: 3,
        prioritySource: "operator-command",
      }),
    );
    const report = buildStatusReport({
      repository: "clockgrove/factory",
      snapshot: commanded,
    });

    expect(report.run).toMatchObject({
      state: "paused",
      cloudPaused: true,
      pendingRetries: [11],
    });
    expect(report.operatorAction).toMatchObject({
      required: false,
      monitoring: "continue",
      code: "run-pausing",
      evidence: {
        runId: "run-status",
        commandRequestId: "pause-status",
        stopKind: "pause",
      },
    });
    expect(report.readyOrder[0]).toMatchObject({
      workItem: 11,
      rank: 3,
      source: "operator-command",
    });
  });

  it("stops monitoring only after a pause is durably acknowledged", () => {
    const paused = snapshot();
    paused.workItems = [];
    paused.factoryEvents!.push(
      event({
        kind: "run",
        event: "RunPauseRequested",
        sequence: 6,
        requestedBy: "private-operator-name",
        requestId: "pause-status",
      }),
      event({
        kind: "run",
        event: "RunPauseAcknowledged",
        sequence: 7,
        commandRequestId: "pause-status",
      }),
    );

    const report = buildStatusReport({ repository: "clockgrove/factory", snapshot: paused });
    expect(report.operatorAction).toMatchObject({
      required: true,
      monitoring: "stop",
      code: "run-paused",
      summary: expect.stringContaining("No Factory work is active"),
      evidence: {
        runId: "run-status",
        commandRequestId: "pause-status",
        stopKind: "pause",
      },
    });
    const explanation = buildExplanationReport({
      repository: "clockgrove/factory",
      snapshot: paused,
    });
    expect(explanation.explanations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: EXPLANATION_CODES.authorityRunPaused,
          category: "authority",
          disposition: "blocked",
          evidence: {
            runId: "run-status",
            commandRequestId: "pause-status",
            stopKind: "pause",
            monitoring: "stop",
          },
        }),
      ]),
    );
  });

  it("keeps monitoring a drain until its durable completion acknowledgement", () => {
    const draining = snapshot();
    draining.workItems = [];
    draining.factoryEvents!.push(
      event({
        kind: "run",
        event: "RunDrainCompleted",
        sequence: 5,
        commandRequestId: "drain-status",
      }),
      event({
        kind: "run",
        event: "RunDrainRequested",
        sequence: 6,
        requestedBy: "private-operator-name",
        requestId: "drain-status",
      }),
    );

    expect(
      buildStatusReport({ repository: "clockgrove/factory", snapshot: draining }).operatorAction,
    ).toMatchObject({
      required: false,
      monitoring: "continue",
      code: "run-draining",
      evidence: { commandRequestId: "drain-status", stopKind: "drain" },
    });

    draining.factoryEvents!.push(
      event({
        kind: "run",
        event: "RunDrainCompleted",
        sequence: 7,
        commandRequestId: "drain-status",
      }),
    );
    expect(
      buildStatusReport({ repository: "clockgrove/factory", snapshot: draining }).operatorAction,
    ).toMatchObject({
      required: true,
      monitoring: "stop",
      code: "run-paused",
      evidence: { commandRequestId: "drain-status", stopKind: "drain" },
    });
  });
});
