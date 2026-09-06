import { describe, expect, it, vi } from "vitest";
const { leases, releases } = vi.hoisted(() => ({ leases: new Map<string, number>(), releases: vi.fn() }));
vi.mock("../src/execution/artifact-content.js", () => ({
  retainArtifactContent: (payload: { digest: string }) => {
    leases.set(payload.digest, (leases.get(payload.digest) ?? 0) + 1);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      leases.set(payload.digest, leases.get(payload.digest)! - 1);
      releases(payload.digest);
    };
  },
}));
import { retainScopedArtifact, withArtifactContentScope } from "../src/execution/artifact-content-scope.js";
import type { NormalizedArtifact } from "../src/execution/artifacts.js";
const artifact = { payload: { digest: "a".repeat(64) } } as NormalizedArtifact;
describe("independent artifact consumer scopes", () => {
  it("keeps a concurrent owner's identical payload leased after the other finishes", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = withArtifactContentScope(async () => {
      retainScopedArtifact(artifact);
      retainScopedArtifact(artifact);
      entered();
      await pending;
      expect(leases.get(artifact.payload!.digest)).toBe(1);
    });
    await ready;
    await withArtifactContentScope(async () => {
      retainScopedArtifact(artifact);
      expect(leases.get(artifact.payload!.digest)).toBe(2);
    });
    finish();
    await first;
    expect(leases.get(artifact.payload!.digest)).toBe(0);
  });
  it("releases on failure without hiding the operation error", async () => {
    const failure = new Error("original failure");
    await expect(withArtifactContentScope(async () => {
      retainScopedArtifact(artifact);
      throw failure;
    })).rejects.toBe(failure);
    expect(leases.get(artifact.payload!.digest)).toBe(0);
    expect(() => retainScopedArtifact(artifact)).toThrow(/ownership scope/);
  });
});
