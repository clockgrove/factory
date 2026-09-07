import {
  economicRequirements,
  type CompilerWorkItem,
  type DecompositionEvidence,
} from "./index.js";
import type { BackendCandidate, BackendRegistry } from "../execution/registry.js";
import type { RunPolicy } from "../protocol/policy.js";
import type { CapacitySnapshot } from "../scheduling/capacity-ledger.js";
import type { ResourceSnapshot } from "../scheduling/resource-sampler.js";

export interface CompilationEvidenceSource {
  objective: number;
  policy: RunPolicy;
  repositoryLimits: { maxLocalWorkers: number; maxPaidWorkers: number };
  deliveryMode: "regular-prs" | "native-stacks" | "escalate";
  nowMs: number;
  cooldownUntilMs: number;
  capacity: CapacitySnapshot;
  sampleResource: (nowMs: number) => Promise<ResourceSnapshot>;
  evaluate: BackendRegistry["evaluate"];
}

/**
 * Read-only, bounded advisory observations for a newly compiled graph. The caller
 * invokes this only before its first durable graph checkpoint, never on replay.
 * Neither a sample nor a capability result is a reservation or launch authority.
 */
export async function collectCompilationEvidence(
  items: readonly Pick<CompilerWorkItem, "id" | "requirements">[],
  source: CompilationEvidenceSource,
): Promise<DecompositionEvidence> {
  if (
    items.length < 1 ||
    items.length > 100 ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error("compilation evidence requires a bounded unique graph");
  // Fixed worker ceilings still require physical headroom; neither scheduling
  // mode turns its configured worker count into an observed capacity estimate.
  const resource = await source.sampleResource(source.nowMs).catch(() => null);
  const candidates = new Map<string, readonly BackendCandidate[]>();
  // Sequential observations reuse the existing registry probe cache and do not
  // fan out a hundred capability requests at the post-compilation boundary.
  for (const item of items) {
    try {
      candidates.set(
        item.id,
        await source.evaluate({
          policy: source.policy,
          requirements: economicRequirements(item, source.policy),
          nowMs: source.nowMs,
        }),
      );
    } catch {
      // Missing is unknown, not an empty capability set proving ineligibility.
      // Do not copy raw provider errors into the durable graph rationale.
    }
  }
  return {
    objective: source.objective,
    policy: source.policy,
    capacity: source.capacity,
    resource,
    repositoryLimits: source.repositoryLimits,
    deliveryMode: source.deliveryMode,
    nowMs: source.nowMs,
    cooldownUntilMs: source.cooldownUntilMs,
    candidates,
  };
}
