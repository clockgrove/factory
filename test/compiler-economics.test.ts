import { describe, expect, it } from "vitest";
import {
  assessDecomposition, compileObjective, economicRequirements,
  type CompilerWorkItemInput, type DecompositionEvidence,
} from "../src/compiler/index.js";
import { DEFAULT_RUN_POLICY, type RunPolicy } from "../src/protocol/policy.js";
import type { BackendCandidate } from "../src/execution/registry.js";
import { CapacityLedger, capacityReservationKey } from "../src/scheduling/capacity-ledger.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stamp = "2026-09-06T00:00:00.000Z";
const localId = "codex-sdk/local-worktree";
const cloudId = "codex-cli/daytona";
function candidate(paid = false): BackendCandidate {
  const id = paid ? cloudId : localId;
  return {
    id, registered: true, backend: null, local: !paid, paid,
    costClass: paid ? "sandbox" : "local", permanentReasons: [], transientReasons: [],
    probe: { available: true, authenticated: true, measuredAt: stamp },
    capabilities: {
      id, agentKind: "codex", runtimeKind: paid ? "daytona" : "local-worktree",
      hostExecution: !paid, isolation: paid ? "container" : "process",
      supportedOs: ["linux"], supportedArchitectures: ["x64"], supportedTools: ["npm"],
      supportedServices: [], supportsCancellation: true, supportsObservation: true,
      supportsResume: false, supportsLocalInference: false, supportsModelSelection: true,
      requiresPaidRuntime: paid, providerManagedPublication: false, requiredCredentials: [],
    },
  };
}
const policy: RunPolicy = {
  ...DEFAULT_RUN_POLICY, backendOrder: [localId, cloudId], maxParallel: 8,
  allowedPaidBackends: [cloudId], maxSandboxMinutes: 60,
  capacity: {
    mode: "adaptive-local",
    local: { maxWorkers: 8, defaultCpu: 1, defaultMemoryMb: 1024, reserveCpu: 0.5,
      reserveMemoryMb: 1024, minimumFreeMemoryMb: 1024, maxLoadRatio: 0.9,
      maxMemoryUsageRatio: 0.85, sampleIntervalSeconds: 5, admissionCooldownSeconds: 10 },
    backendMaxParallel: { [localId]: 8, [cloudId]: 2 },
  },
};
function item(id: string, overrides: Partial<CompilerWorkItemInput> = {}): CompilerWorkItemInput {
  return {
    id, title: id, goal: `Implement ${id}`, acceptance: [`${id} returns the expected result`],
    scope: [`src/${id}.ts`], dependsOn: [], preconditions: [], outOfScope: [], conventions: [],
    baseSha: "a".repeat(40), validationCommands: ["npm test"],
    requirements: { os: ["linux"], architecture: ["x64"], tools: ["npm"], services: [],
      networkDestinations: [], permittedSecretNames: [], trust: "trusted_local",
      cpu: 1, memoryMb: 1024, estimatedDurationMinutes: 10 },
    artifactContract: "clockgrove.factory/artifact-v1", ...overrides,
  };
}
function graph(items = [item("a"), item("b"), item("c")], economicEvidence?: DecompositionEvidence) {
  return compileObjective({ title: "Economics", baseSha: "a".repeat(40), workItems: items,
    repositoryFacts: { files: [{ path: "package.json" }, ...items.map((value) => ({ path: value.scope[0]! }))],
      scripts: { test: "node --test" } }, ...(economicEvidence ? { economicEvidence } : {}) });
}
function evidence(overrides: Partial<DecompositionEvidence> = {}): DecompositionEvidence {
  return {
    objective: 100, policy, capacity: new CapacityLedger().snapshot(),
    repositoryLimits: { maxLocalWorkers: 8, maxPaidWorkers: 2 }, deliveryMode: "native-stacks",
    nowMs: Date.parse(stamp), cooldownUntilMs: 0,
    resource: { measuredAt: stamp, logicalCpu: 16, effectiveCpu: 2.5, loadRatio: 0.2,
      totalMemoryMb: 8192, availableMemoryMb: 6144, memoryUsageRatio: 0.25, source: "cgroup-v2" },
    candidates: new Map(["a", "b", "c"].map((id) => [id, [candidate(), candidate(true)]])),
    ...overrides,
  };
}

describe("grounded advisory compiler economics", () => {
  it("separates dependency width, resource fit and configured savings", () => {
    const inputs = evidence();
    const assessment = assessDecomposition(graph().workItems, inputs);
    expect(assessment).toMatchObject({ dependencyWaveWidth: 3, configuredWorkMinutes: 30,
      configuredCriticalPathMinutes: 10, idealConcurrencyTimeSavedMinutes: 20,
      localFit: { availability: "estimated", likelySlots: 2, waveFits: [2], measuredAt: stamp } });
    expect(assessment.cloudEligibility.every((value) => value.status === "eligible-in-principle")).toBe(true);
    expect(inputs.capacity!.reservations).toEqual([]);
    expect(graph(undefined, inputs).workItems[0]!.economicReview.rationale).toContain("Resource-constrained local wave fit: 2");
    expect(graph(undefined, inputs).workItems[0]!.economicReview.rationale).toContain("no admission or paid execution authority");
  });
  it("uses available memory headroom, not total memory or dependency width", () => {
    const inputs = evidence();
    inputs.resource = { ...inputs.resource!, availableMemoryMb: 2048 };
    expect(assessDecomposition(graph().workItems, inputs).localFit.likelySlots).toBe(1);
    inputs.resource = { ...inputs.resource, effectiveCpu: 0.5 };
    expect(assessDecomposition(graph().workItems, inputs).localFit.likelySlots).toBe(0);
  });
  it("respects controller, backend, delivery, pressure and cooldown restrictions", () => {
    for (const inputs of [
      evidence({ repositoryLimits: { maxLocalWorkers: 1, maxPaidWorkers: 2 } }),
      evidence({ deliveryMode: "regular-prs" }),
      evidence({ policy: { ...policy, capacity: { ...policy.capacity!, backendMaxParallel: { [localId]: 1 } } } }),
    ]) expect(assessDecomposition(graph().workItems, inputs).localFit.likelySlots).toBe(1);
    for (const inputs of [evidence({ cooldownUntilMs: Date.parse(stamp) + 1000 }), evidence({ deliveryMode: "escalate" })])
      expect(assessDecomposition(graph().workItems, inputs).localFit.likelySlots).toBe(0);
    const pressure = evidence();
    pressure.resource = { ...pressure.resource!, memoryUsageRatio: 0.95 };
    expect(assessDecomposition(graph().workItems, pressure).localFit.likelySlots).toBe(0);
  });
  it("retains reservation resource and path conflicts without mutating the supplied ledger", () => {
    const ledger = new CapacityLedger();
    const identity = { objective: 99, workItem: 7, attempt: 1, phase: "execution" as const, backendId: localId };
    const capacity = ledger.reconcile(1, [{ ...identity, key: capacityReservationKey(identity),
      admissionClass: "local", local: true, cpu: 1, memoryMb: 1024, paidUnits: 0,
      paths: ["src/a.ts"], exclusiveResources: [] }]);
    expect(assessDecomposition(graph().workItems, evidence({ capacity })).localFit.likelySlots).toBe(1);
    expect(ledger.snapshot()).toEqual(capacity);
  });
  it("scans past oversized work and keeps first-fit results deterministic", () => {
    const a = item("a");
    a.requirements.cpu = 3;
    const compiled = graph([a, item("b"), item("c")]);
    const forward = assessDecomposition(compiled.workItems, evidence());
    const reversed = assessDecomposition([...compiled.workItems].reverse(), evidence());
    expect(forward.localFit.likelySlots).toBe(2);
    expect(reversed).toEqual(forward);
  });
  it("keeps absent inputs unknown and does not pretend fixed slots are resource observations", () => {
    const compiled = graph().workItems;
    expect(assessDecomposition(compiled).localFit.likelySlots).toBeNull();
    expect(assessDecomposition(compiled).cloudEligibility[0]!.status).toBe("unknown");
    for (const inputs of [evidence({ resource: null }), evidence({ candidates: new Map() }),
      evidence({ policy: { ...policy, capacity: { ...policy.capacity!, mode: "fixed" } } })])
      expect(assessDecomposition(compiled, inputs).localFit.likelySlots).toBeNull();
  });
  it("does not interpret zero memory capacity as unknown or usable capacity", () => {
    const inputs = evidence();
    inputs.resource = { ...inputs.resource!, totalMemoryMb: 0, availableMemoryMb: 0, memoryUsageRatio: 1 };
    expect(assessDecomposition(graph().workItems, inputs).localFit.likelySlots).toBe(0);
  });
  it("requires explicit paid authority and complete compatible per-item capability observations", () => {
    const compiled = graph().workItems;
    expect(assessDecomposition(compiled, evidence({ policy: { ...policy, allowedPaidBackends: [] } })).cloudEligibility[0]!.status).toBe("ineligible");
    const missing = evidence({ candidates: new Map([["a", [candidate()]]]) });
    expect(assessDecomposition(compiled, missing).cloudEligibility[0]!.status).toBe("unknown");
    const unavailable = candidate(true);
    unavailable.probe = { available: false, authenticated: false, measuredAt: stamp };
    const inputs = evidence({ candidates: new Map([["a", [candidate(), unavailable]]]) });
    expect(assessDecomposition(compiled, inputs).cloudEligibility[0]!.status).toBe("unknown");
    unavailable.probe = { available: true, authenticated: true, measuredAt: stamp };
    unavailable.capabilities!.supportedOs = ["darwin"];
    expect(assessDecomposition(compiled, inputs).cloudEligibility[0]!.status).toBe("ineligible");
  });
  it("applies effective trust without altering the packet or granting host execution", () => {
    const compiled = graph().workItems;
    const isolated = { ...policy, trust: "sandbox_untrusted" as const };
    expect(economicRequirements(compiled[0]!, isolated).trust).toBe("isolated");
    expect(compiled[0]!.requirements.trust).toBe("trusted_local");
    expect(assessDecomposition(compiled, evidence({ policy: isolated })).localFit.likelySlots).toBe(0);
  });
  it("preserves distinct execution and convention contracts instead of inventing redundancy", () => {
    const first = item("a");
    const second = { ...first, id: "b", requirements: { ...first.requirements, architecture: ["arm64"] } };
    expect(assessDecomposition(graph([first, second]).workItems).redundantItemPairs).toEqual([]);
    expect(() => graph([first, { ...first, id: "b" }])).toThrow(/uneconomic duplicate/);
    expect(() => graph([first, { ...first, id: "b", conventions: ["Use the compatibility implementation"] }])).not.toThrow();
  });
  it("reports distinct reviewability, repeated validation and missing durations without economic certainty", () => {
    const a = item("a");
    delete a.requirements.estimatedDurationMinutes;
    const assessment = assessDecomposition(graph([a, item("b")]).workItems);
    expect(assessment.configuredCriticalPathMinutes).toBeNull();
    expect(assessment.repeatedValidationCommands).toBe(1);
    expect(assessment.feedback.join(" ")).toContain("structural counts alone do not prove");
  });
  it("collects trusted economics after grounding and checkpoints the rationale without another model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-compiler-economics-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      const calls: string[] = [];
      const backend = new CodexCliManagementBackend({ runStructured: async () => {
        calls.push("model");
        return { value: { title: "Economics", workItems: [item("a")] },
          usage: { inputTokens: 1, outputTokens: 1 } };
      } });
      const result = await backend.compile({ repository: root, repositoryFiles: ["package.json"],
        objective: { number: 100, title: "Economics", body: "Implement a" }, defaultBranch: "main",
        baseSha: "a".repeat(40), allowedNetworkDestinations: [], economicEvidence: async (items) => {
          calls.push("evidence");
          expect(items[0]!.context.mustRead).toContain("package.json");
          expect(items[0]!.requirements.trust).toBe("trusted_local");
          return evidence();
        } }, async (checkpoint) => {
          calls.push("checkpoint");
          expect(checkpoint.objective.workItems[0]!.economicReview!.rationale).toContain("Paid execution policy/capability: eligible-in-principle");
          expect(checkpoint.objective.workItems[0]!.economicReview!.rationale.length).toBeLessThanOrEqual(2000);
        });
      expect(calls).toEqual(["model", "evidence", "checkpoint"]);
      expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
