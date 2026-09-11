import { afterEach, expect, it, vi } from "vitest";
import { importLegacyCapacity } from "../src/controller/legacy-capacity.js";
import { GitHubReader } from "../src/github.js";
import { CompiledGraphManager } from "../src/control/graphs.js";
import type { GitHubControlStore } from "../src/control/github-store.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import type { CompiledObjective } from "../src/graph.js";
import * as scopeResources from "../src/recovery/scope-resources.js";
import { unresolvedModelInvocations } from "../src/control/budget.js";

afterEach(() => vi.restoreAllMocks());
const base = "a".repeat(40),
  digest = "b".repeat(64),
  blob = "c".repeat(40);
const policy = policyDigest(DEFAULT_RUN_POLICY);
function event(fields: Record<string, unknown>): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "legacy",
    sequence: 1,
    at: "2026-09-08T00:00:00Z",
    ...fields,
  });
}
function fixture(extras: FactoryEvent[] = []) {
  const started = event({
    kind: "run",
    event: "FactoryRunStarted",
    actor: "operator",
    repository: "fixture/project",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policy,
  });
  const snapshot = {
    number: 7,
    factoryEvents: [started, ...extras.filter((row) => !("workItem" in row))],
    workItems: [{ id: "I8", number: 8, factoryEvents: extras.filter((row) => "workItem" in row) }],
  };
  vi.spyOn(GitHubReader.prototype, "readObjective").mockResolvedValue(snapshot as never);
  const listRefs = vi.fn(async () => [
    { ref: "refs/clockgrove-factory/leases/objective-7", oid: base },
  ]);
  const args = {
    store: { listRefs } as unknown as GitHubControlStore,
    token: "fixture-only",
    owner: "fixture",
    repo: "project",
    assertCurrent: vi.fn(async () => {}),
  };
  return { args, snapshot };
}
it("migrates an authenticated no-worker Objective without inventing outstanding capacity", async () => {
  const f = fixture();
  expect(await importLegacyCapacity(f.args)).toEqual([]);
  expect(f.args.assertCurrent).toHaveBeenCalled();
});
it.each([false, true])(
  "preserves unknown management usage without inventing global capacity or absence proof: %s",
  async (unrelatedBatch) => {
    const f = fixture([
      event({
        kind: "budget",
        event: "BudgetReserved",
        sequence: 2,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        modelInvocationId: "compile-original",
        usageId: "invocation-compile-original",
        directorEpoch: 1,
        policyDigest: policy,
      }),
    ]);
    const observe = vi
      .spyOn(scopeResources, "observeLocalScopeBatch")
      .mockResolvedValue({ status: "absent" } as never);
    if (unrelatedBatch) {
      const capacity = {
        kind: "capacity",
        workItem: 8,
        attempt: 1,
        phase: "validation",
        backend: "factory/local-validation",
        requestedCpu: 1,
        requestedMemoryMb: 256,
        directorEpoch: 1,
        policyDigest: policy,
      };
      f.snapshot.workItems[0]!.factoryEvents.push(
        event({
          ...capacity,
          event: "CapacityReserved",
          sequence: 3,
          localScopeBatch: {
            identity: {
              protocol: "clockgrove.factory/local-scope-v1",
              repository: "fixture/project",
              objective: 7,
              workItem: 8,
              attempt: 1,
              runId: "legacy",
              directorEpoch: 1,
              policyDigest: policy,
              phase: "validation",
              commandIndex: 0,
              invocationDigest: digest,
              hostIdentity: digest,
            },
            commandCount: 1,
            producerPid: 123,
            producerStartTicks: "456",
            deadline: "2026-09-08T00:01:00Z",
          },
        }),
        event({ ...capacity, event: "CapacityReconciled", sequence: 4 }),
      );
    }
    const before = structuredClone(f.snapshot);
    expect(await importLegacyCapacity(f.args)).toEqual([]);
    expect(f.snapshot).toEqual(before);
    expect(unresolvedModelInvocations(f.snapshot.factoryEvents)).toHaveLength(1);
    expect(observe).not.toHaveBeenCalled();
  },
);
it("imports retained execution using exact original owner and immutable graph scope", async () => {
  const f = fixture([
    event({
      kind: "graph",
      event: "GraphCompiled",
      sequence: 2,
      graphDigest: digest,
      graphSize: 1,
      baseSha: base,
      graphRef: "refs/clockgrove-factory/graphs/fixture",
      graphBlobSha: blob,
    }),
    event({
      kind: "attempt",
      event: "AttemptReserved",
      sequence: 3,
      workItem: 8,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
      baseSha: base,
      directorEpoch: 2,
      policyDigest: policy,
      requestedCpu: 2,
      requestedMemoryMb: 256,
    }),
    event({
      kind: "budget",
      event: "BudgetReserved",
      sequence: 4,
      phase: "execution",
      workItem: 8,
      attempt: 1,
      unit: "model_tokens",
      amount: 0,
      modelInvocationId: "worker-original",
      usageId: "invocation-worker-original",
      directorEpoch: 2,
      policyDigest: policy,
    }),
  ]);
  const graph: CompiledObjective = {
    deferredCapabilityAdapters: [],
    title: "Objective",
    workItems: [
      {
        id: "feature",
        title: "Feature",
        goal: "Implement feature",
        acceptance: ["Tests pass"],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: base,
        validationCommands: ["npm test"],
        requirements: {
          os: [],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
  vi.spyOn(CompiledGraphManager.prototype, "load").mockResolvedValue({
    graphDigest: digest,
    blobOid: blob,
    objective: graph,
  } as never);
  vi.spyOn(CompiledGraphManager.prototype, "loadProjection").mockResolvedValue({
    bindings: [{ compilerId: "feature", issueNumber: 8, issueNodeId: "I8" }],
  } as never);
  expect(await importLegacyCapacity(f.args)).toMatchObject([
    {
      owner: { objective: 7, runId: "legacy", directorEpoch: 2, policyDigest: policy },
      reservation: { paths: ["src/feature.ts"], cpu: 2, memoryMb: 256 },
    },
  ]);
  f.snapshot.workItems[0]!.id = "successor-I8";
  await expect(importLegacyCapacity(f.args)).rejects.toThrow("missing historical Work Item");
});
it("does not treat missing authenticated history as proof of an empty legacy repository", async () => {
  const f = fixture();
  f.snapshot.factoryEvents = [];
  await expect(importLegacyCapacity(f.args)).rejects.toThrow("authenticated legacy run history");
});
