import { describe, expect, it } from "vitest";

import type { BackendCandidate } from "../src/execution/registry.js";
import { DEFAULT_RUN_POLICY, type RunPolicy } from "../src/protocol/policy.js";
import type { ExecutionRequirements } from "../src/protocol/worker-packet.js";
import {
  planAdmissions,
  type AdmissionInput,
  type AdmissionWorkItem,
} from "../src/scheduling/admission.js";
import type { CapacitySnapshot } from "../src/scheduling/capacity-ledger.js";
import type { RankedWorkItem } from "../src/scheduling/priority.js";
import type { ResourceSnapshot } from "../src/scheduling/resource-sampler.js";
import type { DerivedWorkItem } from "../src/state.js";

const local = candidate("codex-app-server/local-worktree", "local");
const cloud = candidate("codex-cli/daytona", "sandbox");

function candidate(
  id: string,
  kind: "local" | "sandbox" | "managed",
  options: { permanentReasons?: string[]; transientReasons?: string[] } = {},
): BackendCandidate {
  return {
    id,
    registered: true,
    backend: null,
    capabilities: null,
    probe: {
      available: options.transientReasons?.length !== 1,
      authenticated: options.transientReasons?.length !== 1,
      measuredAt: "2026-09-04T00:00:00.000Z",
    },
    costClass: kind,
    local: kind === "local",
    paid: kind !== "local",
    permanentReasons: options.permanentReasons ?? [],
    transientReasons: options.transientReasons ?? [],
  };
}

const policy: RunPolicy = {
  ...DEFAULT_RUN_POLICY,
  backendOrder: [local.id, cloud.id],
  maxParallel: 8,
  allowedPaidBackends: [cloud.id],
  cloudFallback: "explicit",
  maxSandboxMinutes: 60,
  capacity: {
    mode: "adaptive-local",
    local: {
      maxWorkers: 3,
      defaultCpu: 1,
      defaultMemoryMb: 2_048,
      reserveCpu: 0.5,
      reserveMemoryMb: 1_024,
      minimumFreeMemoryMb: 1_024,
      maxLoadRatio: 0.9,
      maxMemoryUsageRatio: 0.85,
      sampleIntervalSeconds: 5,
      admissionCooldownSeconds: 10,
    },
    backendMaxParallel: { [local.id]: 3, [cloud.id]: 2 },
  },
  burst: {
    mode: "saturation",
    backendOrder: [cloud.id],
    maxCloudParallel: 2,
    queueDelaySeconds: 0,
    deadlineReserveMinutes: 60,
    maxPriorityRank: 100,
  },
};

const resource: ResourceSnapshot = {
  measuredAt: "2026-09-04T00:00:00.000Z",
  logicalCpu: 16,
  effectiveCpu: 16,
  loadRatio: 0.2,
  totalMemoryMb: 64 * 1_024,
  availableMemoryMb: 48 * 1_024,
  memoryUsageRatio: 0.25,
  source: "host",
};

function derived(number: number): DerivedWorkItem {
  return {
    id: `I_${number}`,
    number,
    title: `Item ${number}`,
    body: "",
    closed: false,
    state: "unstarted",
    attempts: 0,
    doneWithoutMergedPullRequest: false,
    assignees: [],
    labels: ["factory:work-item"],
    subIssuePosition: number - 1,
    issueFieldValues: [],
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
  };
}

function requirements(overrides: Partial<ExecutionRequirements> = {}): ExecutionRequirements {
  return {
    os: ["linux"],
    architecture: ["x64"],
    tools: ["node"],
    services: [],
    networkDestinations: [],
    permittedSecretNames: [],
    trust: "trusted_local",
    ...overrides,
  };
}

function workItem(
  number: number,
  options: {
    requirements?: ExecutionRequirements;
    backends?: BackendCandidate[];
    validators?: BackendCandidate[];
    queuedSince?: string;
  } = {},
): AdmissionWorkItem {
  const item = derived(number);
  const priority: RankedWorkItem = {
    item,
    rank: number,
    source: "subissue-order",
    subIssuePosition: number - 1,
    criticalPathLength: 0,
    unfinishedDownstream: 0,
  };
  return {
    priority,
    requirements: options.requirements ?? requirements(),
    backends: options.backends ?? [local, cloud],
    ...(options.validators ? { validators: options.validators } : {}),
    nextAttempt: 1,
    estimatedDurationMs: 60_000,
    paths: [`src/item-${number}/`],
    exclusiveResources: [],
    ...(options.queuedSince ? { queuedSince: options.queuedSince } : {}),
  };
}

function capacity(): CapacitySnapshot {
  return {
    generation: 1,
    reservations: [],
    active: 0,
    local: 0,
    cloud: 0,
    cpu: 0,
    memoryMb: 0,
    paidUnits: 0,
    byBackend: {},
  };
}

function occupiedCapacity(
  options: {
    paths?: string[];
    exclusiveResources?: string[];
    backendId?: string;
    objective?: number;
  } = {},
): CapacitySnapshot {
  const backendId = options.backendId ?? local.id;
  const reservation = {
    key: `${options.objective ?? 14}:99:1:execution:${backendId}`,
    objective: options.objective ?? 14,
    workItem: 99,
    attempt: 1,
    phase: "execution" as const,
    backendId,
    admissionClass: "local" as const,
    local: true,
    cpu: 1,
    memoryMb: 2_048,
    paidUnits: 0,
    paths: options.paths ?? ["src/existing/"],
    exclusiveResources: options.exclusiveResources ?? [],
  };
  return {
    generation: 1,
    reservations: [reservation],
    active: 1,
    local: 1,
    cloud: 0,
    cpu: 1,
    memoryMb: 2_048,
    paidUnits: 0,
    byBackend: { [backendId]: 1 },
  };
}

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    objective: 14,
    policy,
    workItems: Array.from({ length: 8 }, (_, index) => workItem(index + 1)),
    capacity: capacity(),
    budget: { sandboxMinutes: 60, managedAgentSessions: 0 },
    resource,
    nowMs: Date.parse("2026-09-04T00:10:00.000Z"),
    objectiveDeadlineMs: Date.parse("2026-09-04T02:00:00.000Z"),
    ...overrides,
  };
}

describe("pure local-first admission", () => {
  it("fills three local and two bounded burst slots from an eight-item queue", () => {
    const plan = planAdmissions(input());
    expect(plan.admissions.map((item) => [item.workItem, item.admissionClass])).toEqual([
      [1, "local"],
      [2, "local"],
      [3, "local"],
      [4, "burst"],
      [5, "burst"],
    ]);
    expect(plan.queued.map((item) => item.workItem)).toEqual([6, 7, 8]);
  });

  it("waits for durable queue delay before bursting", () => {
    const delayed = {
      ...policy,
      burst: { ...policy.burst!, mode: "queue-delay" as const, queueDelaySeconds: 120 },
    };
    const fresh = input({
      policy: delayed,
      workItems: Array.from({ length: 6 }, (_, index) =>
        workItem(index + 1, { queuedSince: "2026-09-04T00:09:00.000Z" }),
      ),
    });
    expect(planAdmissions(fresh).admissions.map((item) => item.workItem)).toEqual([1, 2, 3]);
    const old = {
      ...fresh,
      workItems: fresh.workItems.map((item) => ({
        ...item,
        queuedSince: "2026-09-04T00:07:59.000Z",
      })),
    };
    expect(planAdmissions(old).admissions.map((item) => item.workItem)).toEqual([
      1,
      2,
      3,
      4,
      5,
    ]);
  });

  it.each([
    ["saturation", undefined, 120 * 60_000, "local-saturated"],
    ["queue-delay", "2026-09-04T00:07:00.000Z", 120 * 60_000, "queue-delay"],
    ["deadline", undefined, 30 * 60_000, "deadline"],
    ["queue-or-deadline", undefined, 30 * 60_000, "deadline"],
  ] as const)(
    "applies the %s burst trigger only after local saturation",
    (mode, queuedSince, deadlineFromNow, reason) => {
      const nowMs = Date.parse("2026-09-04T00:10:00.000Z");
      const item = workItem(1, {
        requirements: requirements({ cpu: 32 }),
        ...(queuedSince ? { queuedSince } : {}),
      });
      const plan = planAdmissions(
        input({
          policy: {
            ...policy,
            burst: { ...policy.burst!, mode, queueDelaySeconds: 120 },
          },
          workItems: [item],
          nowMs,
          objectiveDeadlineMs: nowMs + deadlineFromNow,
        }),
      );
      expect(plan.admissions).toMatchObject([
        {
          workItem: 1,
          admissionClass: "burst",
          admissionReason: reason,
          reservedBudget: {
            unit: "sandbox_milliseconds",
            amount: item.estimatedDurationMs,
          },
        },
      ]);
    },
  );

  it("keeps work above the immutable burst priority threshold local-only", () => {
    const item = workItem(101, { requirements: requirements({ cpu: 32 }) });
    const plan = planAdmissions(input({ workItems: [item] }));
    expect(plan.admissions).toEqual([]);
    expect(plan.queued[0]).toMatchObject({ code: "burst-priority" });
  });

  it("never spends on local-compatible overflow when burst is disabled", () => {
    const never = {
      ...policy,
      burst: { ...policy.burst!, mode: "never" as const },
    };
    const plan = planAdmissions(input({ policy: never }));
    expect(plan.admissions).toHaveLength(3);
    expect(plan.admissions.every((item) => item.admissionClass === "local")).toBe(true);
    expect(plan.queued.every((item) => item.code === "local-capacity")).toBe(true);
  });

  it("routes capability-required isolated work without calling it burst", () => {
    const isolated = workItem(1, {
      requirements: requirements({ trust: "isolated" }),
      backends: [
        candidate(local.id, "local", {
          permanentReasons: ["requires container-or-stronger isolation"],
        }),
        cloud,
      ],
      validators: [cloud],
    });
    const plan = planAdmissions(
      input({
        policy: { ...policy, burst: { ...policy.burst!, mode: "never" } },
        workItems: [isolated],
      }),
    );
    expect(plan.admissions[0]).toMatchObject({
      backendId: cloud.id,
      admissionClass: "remote-required",
      admissionReason: "capability-required",
    });
  });

  it("bypasses an oversized high-priority item to keep a safe slot occupied", () => {
    const plan = planAdmissions(
      input({
        policy: { ...policy, burst: { ...policy.burst!, mode: "never" } },
        workItems: [
          workItem(1, { requirements: requirements({ cpu: 32 }) }),
          workItem(2),
        ],
      }),
    );
    expect(plan.queued[0]).toMatchObject({ workItem: 1, code: "local-capacity" });
    expect(plan.admissions[0]).toMatchObject({ workItem: 2, admissionClass: "local" });
  });

  it("does not subtract already-running reservations twice from observed free memory", () => {
    const plan = planAdmissions(
      input({
        policy: { ...policy, burst: { ...policy.burst!, mode: "never" } },
        workItems: [workItem(1)],
        capacity: occupiedCapacity(),
        resource: { ...resource, availableMemoryMb: 4_096 },
      }),
    );
    expect(plan.admissions).toMatchObject([
      { workItem: 1, admissionClass: "local" },
    ]);
  });

  it.each([
    [
      "path conflict",
      occupiedCapacity({ paths: ["src/item-1/"] }),
      workItem(1),
      "path-conflict",
    ],
    [
      "exclusive resource",
      occupiedCapacity({ exclusiveResources: ["asset-pipeline"] }),
      { ...workItem(1), exclusiveResources: ["asset-pipeline"] },
      "exclusive-resource-conflict",
    ],
  ])("keeps %s inside repository-wide capacity", (_name, occupied, item, code) => {
    const plan = planAdmissions(
      input({
        policy: { ...policy, burst: { ...policy.burst!, mode: "never" } },
        workItems: [item as AdmissionWorkItem],
        capacity: occupied as CapacitySnapshot,
      }),
    );
    expect(plan.admissions).toEqual([]);
    expect(plan.queued[0]?.code).toBe(code);
  });

  it("enforces per-Objective backend and repository controller ceilings", () => {
    const backendLimited = {
      ...policy,
      capacity: {
        ...policy.capacity!,
        backendMaxParallel: { [local.id]: 1, [cloud.id]: 2 },
      },
      burst: { ...policy.burst!, mode: "never" as const },
    };
    expect(
      planAdmissions(
        input({
          policy: backendLimited,
          workItems: [workItem(1)],
          capacity: occupiedCapacity(),
        }),
      ).queued[0]?.code,
    ).toBe("backend-at-capacity");
    expect(
      planAdmissions(
        input({
          policy: backendLimited,
          workItems: [workItem(1)],
          capacity: occupiedCapacity({ objective: 99 }),
          repositoryLimits: { maxLocalWorkers: 1, maxPaidWorkers: 0 },
        }),
      ).queued[0]?.code,
    ).toBe("global-capacity");
  });

  it("does not reinterpret an unavailable or missing local backend as cloud authority", () => {
    const unavailable = workItem(1, {
      backends: [
        candidate(local.id, "local", { transientReasons: ["probe unavailable"] }),
        cloud,
      ],
    });
    const missing = workItem(2, {
      backends: [
        {
          ...candidate(local.id, "local", { permanentReasons: ["not registered"] }),
          capabilities: null,
          backend: null,
          registered: false,
          local: false,
        },
        cloud,
      ],
    });
    const plan = planAdmissions(input({ workItems: [unavailable, missing] }));
    expect(plan.admissions).toEqual([]);
    expect(plan.queued).toMatchObject([
      { workItem: 1, code: "backend-unavailable", permanent: false },
      { workItem: 2, code: "backend-incompatible", permanent: true },
    ]);
  });

  it("reserves provider-native units and never exceeds managed-session budget", () => {
    const managed = candidate("github-copilot/github-managed", "managed");
    const managedPolicy: RunPolicy = {
      ...policy,
      backendOrder: [managed.id],
      allowedPaidBackends: [managed.id],
      maxManagedAgentSessions: 1,
      capacity: {
        ...policy.capacity!,
        backendMaxParallel: { [managed.id]: 2 },
      },
      burst: {
        ...policy.burst!,
        backendOrder: [managed.id],
        maxCloudParallel: 2,
      },
    };
    const plan = planAdmissions(
      input({
        policy: managedPolicy,
        workItems: [
          workItem(1, { backends: [managed] }),
          workItem(2, { backends: [managed] }),
        ],
        budget: { sandboxMinutes: 0, managedAgentSessions: 1 },
      }),
    );
    expect(plan.admissions).toMatchObject([
      {
        workItem: 1,
        admissionClass: "remote-required",
        reservedBudget: { unit: "managed_sessions", amount: 1 },
      },
    ]);
    expect(plan.queued[0]).toMatchObject({ workItem: 2, code: "budget-exhausted" });
  });

  it.each([
    ["lease", { leaseValid: false }, "lease-unavailable"],
    [
      "egress policy",
      { workItems: [workItem(1, { requirements: requirements({ networkDestinations: ["example.com"] }) })] },
      "policy-constraint",
    ],
    ["resource sample", { resource: null }, "resource-sample-unavailable"],
    [
      "pressure",
      { resource: { ...resource, loadRatio: 0.95 } },
      "local-pressure",
    ],
  ])("does not cross the %s gate", (_name, overrides, expected) => {
    const plan = planAdmissions(
      input({
        policy: { ...policy, burst: { ...policy.burst!, mode: "never" } },
        workItems: [workItem(1)],
        ...(overrides as Partial<AdmissionInput>),
      }),
    );
    expect(plan.admissions).toEqual([]);
    expect(plan.queued[0]?.code).toBe(expected);
  });

  it("does not consume a cloud native-unit budget when admission is queued", () => {
    const plan = planAdmissions(
      input({
        workItems: [
          workItem(1, {
            requirements: requirements({ trust: "isolated" }),
            backends: [
              candidate(local.id, "local", { permanentReasons: ["isolation"] }),
              cloud,
            ],
            validators: [cloud],
          }),
        ],
        budget: { sandboxMinutes: 0, managedAgentSessions: 0 },
      }),
    );
    expect(plan.admissions).toEqual([]);
    expect(plan.queued[0]).toMatchObject({ code: "budget-exhausted", recordQueueStart: true });
  });

  it("budgets isolated execution and independent validation before either launches", () => {
    const isolated = workItem(1, {
      requirements: requirements({ trust: "isolated" }),
      backends: [
        candidate(local.id, "local", { permanentReasons: ["isolation"] }),
        cloud,
      ],
      validators: [cloud],
    });
    const insufficient = planAdmissions(
      input({
        workItems: [isolated],
        budget: { sandboxMinutes: 1, managedAgentSessions: 0 },
      }),
    );
    expect(insufficient.admissions).toEqual([]);
    expect(insufficient.queued[0]).toMatchObject({ code: "budget-exhausted" });

    const sufficient = planAdmissions(
      input({
        workItems: [isolated],
        budget: { sandboxMinutes: 2, managedAgentSessions: 0 },
      }),
    );
    expect(sufficient.admissions).toMatchObject([
      {
        backendId: cloud.id,
        reservedBudget: { unit: "sandbox_milliseconds", amount: 60_000 },
        validation: {
          backendId: cloud.id,
          reservedBudget: { unit: "sandbox_milliseconds", amount: 60_000 },
        },
      },
    ]);
  });
});
