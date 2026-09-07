import { describe, expect, it, vi } from "vitest";
import {
  collectCompilationEvidence,
  type CompilationEvidenceSource,
} from "../src/compiler/runtime-evidence.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "../src/protocol/policy.js";
import { CapacityLedger } from "../src/scheduling/capacity-ledger.js";
import type { ExecutionRequirements } from "../src/protocol/worker-packet.js";

const requirements: ExecutionRequirements = {
  os: ["linux"],
  architecture: ["x64"],
  tools: [],
  services: [],
  networkDestinations: [],
  permittedSecretNames: [],
  trust: "trusted_local",
};
const items = [
  { id: "a", requirements },
  { id: "b", requirements },
];
function source(): CompilationEvidenceSource {
  return {
    objective: 1,
    policy: parseRunPolicy(DEFAULT_RUN_POLICY),
    repositoryLimits: { maxLocalWorkers: 4, maxPaidWorkers: 0 },
    deliveryMode: "regular-prs",
    nowMs: 1000,
    cooldownUntilMs: 0,
    capacity: new CapacityLedger().snapshot(),
    sampleResource: vi.fn(async () => ({
      measuredAt: new Date(1000).toISOString(),
      logicalCpu: 8,
      effectiveCpu: 4,
      loadRatio: 0,
      totalMemoryMb: 8192,
      availableMemoryMb: 4096,
      memoryUsageRatio: 0.5,
      source: "host" as const,
    })),
    evaluate: vi.fn(async () => []),
  };
}

describe("new-graph runtime economic observations", () => {
  it("uses the supplied immutable policy, limits, delivery and one resource sample without reserving", async () => {
    const input = source();
    const before = structuredClone(input.capacity);
    const result = await collectCompilationEvidence(items, input);
    expect(input.sampleResource).toHaveBeenCalledExactlyOnceWith(1000);
    expect(input.evaluate).toHaveBeenCalledTimes(2);
    expect(result.policy).toBe(input.policy);
    expect(result.capacity).toEqual(before);
    expect(input.capacity).toEqual(before);
    expect(result.repositoryLimits).toEqual({ maxLocalWorkers: 4, maxPaidWorkers: 0 });
    expect(result.deliveryMode).toBe("regular-prs");
    expect(result.candidates?.get("a")).toEqual([]);
  });

  it("keeps failed observations unknown without echoing provider diagnostics", async () => {
    const input = source();
    input.sampleResource = vi.fn(async () => {
      throw Error("private sampling details");
    });
    input.evaluate = vi.fn(async () => {
      throw Error("private provider details");
    });
    const result = await collectCompilationEvidence(items, input);
    expect(result.resource).toBeNull();
    expect(result.candidates?.has("a")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("applies isolated trust before probing and never mutates compiler requirements", async () => {
    const input = source();
    input.policy = parseRunPolicy({ ...input.policy, trust: "sandbox_untrusted" });
    await collectCompilationEvidence(items, input);
    expect(input.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: expect.objectContaining({ trust: "isolated" }),
      }),
    );
    expect(requirements.trust).toBe("trusted_local");
  });

  it("samples actual physical headroom for fixed policy instead of inferring configured slots", async () => {
    const input = source();
    input.policy = parseRunPolicy({
      ...input.policy,
      capacity: { ...input.policy.capacity, mode: "fixed" },
    });
    const result = await collectCompilationEvidence(items, input);
    expect(input.sampleResource).toHaveBeenCalledExactlyOnceWith(input.nowMs);
    expect(result.resource).toMatchObject({ effectiveCpu: 4, availableMemoryMb: 4096 });
    expect(result.policy).toBe(input.policy);
  });

  it("bounds observations before I/O and rejects duplicate graph identities", async () => {
    const input = source();
    await expect(collectCompilationEvidence([], input)).rejects.toThrow(/bounded unique graph/);
    await expect(collectCompilationEvidence([items[0]!, items[0]!], input)).rejects.toThrow(
      /bounded unique graph/,
    );
    await expect(
      collectCompilationEvidence(
        Array.from({ length: 101 }, (_, id) => ({ id: String(id), requirements })),
        input,
      ),
    ).rejects.toThrow(/bounded unique graph/);
    expect(input.sampleResource).not.toHaveBeenCalled();
    expect(input.evaluate).not.toHaveBeenCalled();
  });
});
