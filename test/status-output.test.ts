import { describe, expect, it } from "vitest";

import { buildExplanationReport } from "../src/application/explain.js";
import { buildReplayReport } from "../src/application/replay.js";
import { buildStatusReport, type FactoryReadSnapshot } from "../src/application/status.js";
import { EXPLANATION_CODES } from "../src/explanations/index.js";
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

describe("bounded status, explain, and replay output", () => {
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
      maxParallel: 8,
      localMaxWorkers: 8,
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
    expect(report.readyOrder[0]).toMatchObject({
      workItem: 11,
      rank: 3,
      source: "operator-command",
    });
  });
});
