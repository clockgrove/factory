import {
  artifactContentOwners as owners,
  retainCurrentArtifactPayload,
} from "./artifact-content.js";
import type { NormalizedArtifact } from "./artifacts.js";

/** Runtime cache ownership is local optimization only. Durable pending transfer
 * content is separate and is never deleted by an operation's cache cleanup. */
export function retainScopedArtifact(artifact: NormalizedArtifact): NormalizedArtifact {
  if (!artifact.payload) return artifact;
  const scope = owners.getStore();
  if (!scope) throw new Error("artifact payload consumer has no operation ownership scope");
  retainCurrentArtifactPayload(artifact.payload);
  return artifact;
}

/** Parallel Objectives and nested pipelines get independent leases; finishing
 * one consumer never releases a sibling's still-live payload. */
export async function withArtifactContentScope<T>(operation: () => Promise<T>): Promise<T> {
  return owners.run(new Map(), async () => {
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await operation() };
    } catch (error) {
      result = { ok: false, error };
    }
    const settled = await Promise.allSettled(
      [...owners.getStore()!.values()].map((release) => release()),
    );
    const failures = settled.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        [...(result.ok ? [] : [result.error]), ...failures],
        "artifact content owner cleanup failed",
      );
    if (!result.ok) throw result.error;
    return result.value;
  });
}
