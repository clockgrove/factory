import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import replaySchema from "../schemas/replay-snapshot.schema.json";
import policySchema from "../schemas/run-policy.schema.json";

import { DEFAULT_RUN_POLICY, type RunPolicy } from "../src/protocol/policy.js";
import {
  pinAdmissionSnapshot,
  replayAdmissions,
  type PinnedAdmissionInput,
  type PinnedAdmissionWorkItem,
  type ReplayDecisionSet,
} from "../src/replay/index.js";

const localId = "codex-cli/local-worktree";
const cloudId = "codex-cli/daytona";

const policy: RunPolicy = {
  ...DEFAULT_RUN_POLICY,
  backendOrder: [localId, cloudId],
  maxParallel: 2,
  cloudFallback: "explicit",
  allowedPaidBackends: [cloudId],
  maxSandboxMinutes: 10,
  capacity: {
    mode: "adaptive-local",
    local: {
      ...DEFAULT_RUN_POLICY.capacity!.local!,
      maxWorkers: 1,
    },
    backendMaxParallel: { [localId]: 1, [cloudId]: 1 },
  },
  burst: {
    mode: "saturation",
    backendOrder: [cloudId],
    maxCloudParallel: 1,
    queueDelaySeconds: 0,
    deadlineReserveMinutes: 60,
    maxPriorityRank: 100,
  },
};

function item(number: number): PinnedAdmissionWorkItem {
  const index = number - 100;
  return {
    number,
    priority: {
      rank: number === 103 ? 103 : index,
      source: "subissue-order",
      subIssuePosition: index - 1,
      criticalPathLength: 3 - index,
      unfinishedDownstream: 3 - index,
    },
    requirements: {
      os: ["linux"],
      architecture: ["x64"],
      cpu: 1,
      memoryMb: 2_048,
      tools: ["node"],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
    },
    backends: [
      {
        id: localId,
        registered: true,
        costClass: "local",
        local: true,
        paid: false,
        reportsModelUsage: true,
        permanentReasons: [],
        transientReasons: [],
      },
      {
        id: cloudId,
        registered: true,
        costClass: "sandbox",
        local: false,
        paid: true,
        reportsModelUsage: false,
        permanentReasons: [],
        transientReasons: [],
      },
    ],
    validators: [
      {
        id: cloudId,
        registered: true,
        costClass: "sandbox",
        local: false,
        paid: true,
        reportsModelUsage: false,
        permanentReasons: [],
        transientReasons: [],
      },
    ],
    nextAttempt: 1,
    estimatedDurationMs: 60_000,
    paths: [`src/item-${number}`],
    exclusiveResources: [],
  };
}

const input: PinnedAdmissionInput = {
  objective: 41,
  policy,
  workItems: [item(101), item(102), item(103)],
  capacity: {
    generation: 1,
    reservations: [],
    active: 0,
    local: 0,
    cloud: 0,
    cpu: 0,
    memoryMb: 0,
    paidUnits: 0,
    byBackend: {},
  },
  budget: { sandboxMinutes: 10, managedAgentSessions: 0 },
  resource: {
    measuredAt: "2026-09-04T12:00:00.000Z",
    logicalCpu: 16,
    effectiveCpu: 16,
    loadRatio: 0.1,
    totalMemoryMb: 65_536,
    availableMemoryMb: 49_152,
    memoryUsageRatio: 0.25,
    source: "host",
  },
  nowMs: Date.parse("2026-09-04T12:00:00.000Z"),
  objectiveDeadlineMs: Date.parse("2026-09-04T14:00:00.000Z"),
  leaseValid: true,
};

const expected: ReplayDecisionSet = {
  admissions: [
    {
      workItem: 101,
      backendId: localId,
      admissionClass: "local",
      admissionReason: "local-capacity",
      requirements: { cpu: 1, memoryMb: 2_048 },
      priority: {
        rank: 1,
        source: "subissue-order",
        subIssuePosition: 0,
        criticalPathLength: 2,
        unfinishedDownstream: 2,
      },
      capacity: {
        measuredAt: "2026-09-04T12:00:00.000Z",
        effectiveCpu: 16,
        availableMemoryMb: 49_152,
        loadRatio: 0.1,
        memoryUsageRatio: 0.25,
      },
      capacityGeneration: 1,
      reservation: {
        key: `41:101:1:execution:${localId}`,
        objective: 41,
        workItem: 101,
        attempt: 1,
        phase: "execution",
        backendId: localId,
        admissionClass: "local",
        local: true,
        cpu: 1,
        memoryMb: 2_048,
        paidUnits: 0,
        paths: ["src/item-101"],
        exclusiveResources: [],
      },
      reservedBudget: { unit: "none", amount: 0 },
    },
    {
      workItem: 102,
      backendId: cloudId,
      admissionClass: "burst",
      admissionReason: "local-saturated",
      requirements: { cpu: 1, memoryMb: 2_048 },
      priority: {
        rank: 2,
        source: "subissue-order",
        subIssuePosition: 1,
        criticalPathLength: 1,
        unfinishedDownstream: 1,
      },
      capacity: {
        measuredAt: "2026-09-04T12:00:00.000Z",
        effectiveCpu: 16,
        availableMemoryMb: 49_152,
        loadRatio: 0.1,
        memoryUsageRatio: 0.25,
      },
      capacityGeneration: 1,
      reservation: {
        key: `41:102:1:execution:${cloudId}`,
        objective: 41,
        workItem: 102,
        attempt: 1,
        phase: "execution",
        backendId: cloudId,
        admissionClass: "burst",
        local: false,
        cpu: 1,
        memoryMb: 2_048,
        paidUnits: 1,
        paths: ["src/item-102"],
        exclusiveResources: [],
      },
      reservedBudget: { unit: "sandbox_milliseconds", amount: 60_000 },
      validation: {
        backendId: cloudId,
        reservedBudget: { unit: "sandbox_milliseconds", amount: 60_000 },
      },
    },
  ],
  queued: [
    {
      workItem: 103,
      code: "burst-priority",
      gate: "priority",
      reason: "priority rank 103 exceeds burst threshold 100",
      observedPriorityRank: 103,
      observedSubIssuePosition: 2,
      prioritySource: "subissue-order",
      recordQueueStart: true,
      permanent: false,
    },
  ],
};

describe("pure admission replay", () => {
  it.each([
    { effectiveCpu: 0.5, totalMemoryMb: 1024, availableMemoryMb: 512, memoryUsageRatio: 0.5 },
    { effectiveCpu: 0.5, totalMemoryMb: 0, availableMemoryMb: 0, memoryUsageRatio: 1 },
    { effectiveCpu: 0.5, totalMemoryMb: 0, availableMemoryMb: 0, memoryUsageRatio: 0.25 },
  ])("accepts actual cgroup resource domain in replay and its public schema: %j", (observed) => {
    const snapshot = pinAdmissionSnapshot({ ...input, resource: { ...input.resource!, ...observed } });
    expect(snapshot.input.resource).toMatchObject(observed);
    expect(replayAdmissions(snapshot).reproduced).toBe(true);
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    ajv.addSchema(policySchema);
    expect(ajv.compile(replaySchema)(snapshot)).toBe(true);
  });

  it.each([
    { effectiveCpu: 0 },
    { effectiveCpu: -0.5 },
    { effectiveCpu: Number.POSITIVE_INFINITY },
    { effectiveCpu: Number.NaN },
    { totalMemoryMb: -1 },
    { totalMemoryMb: Number.POSITIVE_INFINITY },
    { totalMemoryMb: 0, availableMemoryMb: 1 },
    { availableMemoryMb: -1 },
    { availableMemoryMb: Number.NaN },
    { memoryUsageRatio: -0.1 },
    { memoryUsageRatio: 1.1 },
    { memoryUsageRatio: Number.NaN },
  ])("rejects non-finite or contradictory resource bounds: %j", (invalid) => {
    expect(() => pinAdmissionSnapshot({ ...input, resource: { ...input.resource!, ...invalid } })).toThrow();
  });

  it("binds prior queue observations and reason transitions without changing legacy snapshots", () => {
    const waiting = "2026-09-04T11:59:00.000Z";
    const pinnedInput: PinnedAdmissionInput = {
      ...input,
      leaseValid: false,
      workItems: [{ ...item(101), queuedSince: waiting, previousQueueObservation: { code: "local-pressure", gate: "capacity" } }],
    };
    const snapshot = pinAdmissionSnapshot(pinnedInput);
    expect(snapshot.input.workItems[0]?.previousQueueObservation).toEqual({ code: "local-pressure", gate: "capacity" });
    expect(replayAdmissions(snapshot)).toMatchObject({ reproduced: true, decisions: { queued: [{
      code: "lease-unavailable", recordQueueStart: false, recordQueueReasonChange: true, queuedSince: waiting,
    }] } });
    const tampered = structuredClone(snapshot);
    tampered.input.workItems[0]!.previousQueueObservation = { code: "lease-unavailable", gate: "authority" };
    expect(() => replayAdmissions(tampered)).toThrow("snapshot digest mismatch");
    const unchanged = pinAdmissionSnapshot(tampered.input);
    expect(unchanged.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    expect(replayAdmissions(unchanged).decisions.queued[0]).not.toHaveProperty("recordQueueReasonChange");
    const legacy = pinAdmissionSnapshot({ ...input, leaseValid: false, workItems: [{ ...item(101), queuedSince: waiting }] });
    expect(legacy.input.workItems[0]).not.toHaveProperty("previousQueueObservation");
    expect(replayAdmissions(legacy)).toMatchObject({ reproduced: true });
    expect(legacy.expected.queued[0]).not.toHaveProperty("recordQueueReasonChange");
  });

  it("reproduces every admission and queued decision from a JSON-round-tripped pinned fixture", () => {
    const fixture = pinAdmissionSnapshot(input, "2026-09-04T12:00:00.000Z", expected);
    const persisted = JSON.parse(JSON.stringify(fixture));
    const result = replayAdmissions(persisted);
    expect(result.reproduced).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.decisions).toEqual(expected);
  });

  it("reports exact per-item mismatches for a valid but incorrect conformance expectation", () => {
    const wrong = structuredClone(expected);
    wrong.queued[0]!.reason = "wrong expected reason";
    const fixture = pinAdmissionSnapshot(input, "2026-09-04T12:00:00.000Z", wrong);
    const result = replayAdmissions(fixture);
    expect(result.reproduced).toBe(false);
    expect(result.mismatches).toMatchObject([{ decision: "queued", workItem: 103 }]);
  });

  it("fails closed if any pinned input changes without a new digest", () => {
    const fixture = pinAdmissionSnapshot(input);
    const tampered = structuredClone(fixture);
    tampered.input.budget.sandboxMinutes = 0;
    expect(() => replayAdmissions(tampered)).toThrow("snapshot digest mismatch");
  });

  it("drops unknown nested fields and rejects raw backend reason text", () => {
    const unsafe = structuredClone(input) as PinnedAdmissionInput & {
      policy: RunPolicy & { apiToken?: string };
      capacity: PinnedAdmissionInput["capacity"] & { controllerId?: string };
    };
    unsafe.policy.apiToken = "ghp_not-a-real-token-but-never-publish-it";
    unsafe.capacity.controllerId = "private-machine";
    (unsafe.workItems[0]!.requirements as Record<string, unknown>).providerResponse = {
      raw: "private",
    };
    const fixture = pinAdmissionSnapshot(unsafe);
    const encoded = JSON.stringify(fixture);
    expect(encoded).not.toContain("apiToken");
    expect(encoded).not.toContain("controllerId");
    expect(encoded).not.toContain("providerResponse");

    const rawReason = structuredClone(input);
    rawReason.workItems[0]!.backends[0]!.transientReasons = ["HTTP 401 body from provider"];
    expect(() => pinAdmissionSnapshot(rawReason)).toThrow("reasons must be stable sanitized codes");
  });
});
