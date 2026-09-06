import { DEFAULT_RUN_POLICY } from "../../src/protocol/policy.js";
import { pinAdmissionSnapshot, type PinnedAdmissionInput } from "../../src/replay/index.js";

export function suppliedReplayInput(): PinnedAdmissionInput {
  return {
    objective: 7,
    policy: structuredClone(DEFAULT_RUN_POLICY),
    workItems: [
      {
        number: 8,
        priority: {
          rank: 0,
          source: "subissue-order",
          subIssuePosition: 0,
          criticalPathLength: 0,
          unfinishedDownstream: 0,
        },
        requirements: {
          os: ["linux"],
          architecture: ["x64"],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        backends: [
          {
            id: "codex-sdk/local-worktree",
            registered: true,
            costClass: "local",
            local: true,
            paid: false,
            reportsModelUsage: true,
            permanentReasons: [],
            transientReasons: [],
          },
        ],
        nextAttempt: 1,
        estimatedDurationMs: 60_000,
        paths: ["src/feature.ts"],
        exclusiveResources: [],
      },
    ],
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
    budget: { sandboxMinutes: 0, managedAgentSessions: 0 },
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
}

export const suppliedReplaySnapshot = () => pinAdmissionSnapshot(suppliedReplayInput());
export const unreproducedReplaySnapshot = () =>
  pinAdmissionSnapshot(suppliedReplayInput(), undefined, { admissions: [], queued: [] });

export const replayObjective = () => ({
  id: "objective-node",
  number: 7,
  title: "Objective",
  defaultBranch: "main",
  workItems: [],
  factoryEvents: [],
});
