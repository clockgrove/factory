import { expect, it, vi } from "vitest";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import type { BackendRegistry } from "../src/execution/registry.js";

const inspectCompilerPreflight = vi.hoisted(() =>
  vi.fn<
    (input: {
      checkout: string;
      baseSha: string;
      policy: typeof DEFAULT_RUN_POLICY;
      registry: BackendRegistry;
      executionTrust?: "trusted_local" | "isolated" | "managed";
    }) => Promise<unknown>
  >(),
);

vi.mock("../src/application/compiler-preflight.js", () => ({ inspectCompilerPreflight }));

import { main } from "../src/cli.js";

it("uses the exact retained CLI default when compiler preflight omits policy", async () => {
  const baseSha = "a".repeat(40);
  inspectCompilerPreflight.mockResolvedValueOnce({
    result: "passed",
    baseSha,
    pinnedFactsDigest: "b".repeat(64),
    validationRecipeCount: 1,
    eligibleDeferredAdapters: [],
    toolchains: [],
    validation: { status: "valid", violations: [] },
    execution: {
      protocol: "clockgrove.factory/execution-route-preflight",
      result: "passed",
      required: null,
      routes: [],
    },
  });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await main(["compiler-preflight", "--repo", "/home/example/repository", "--base-sha", baseSha]);
    expect(inspectCompilerPreflight).toHaveBeenCalledExactlyOnceWith({
      checkout: "/home/example/repository",
      baseSha,
      policy: DEFAULT_RUN_POLICY,
      registry: expect.anything(),
    });
    const registry = inspectCompilerPreflight.mock.calls[0]![0].registry as BackendRegistry;
    expect(registry.get("github-copilot/github-managed")).toBeNull();
    expect(registry.capabilities("github-copilot/github-managed")).toMatchObject({
      runtimeKind: "github-managed",
      isolation: "managed",
      requiresPaidRuntime: true,
    });
    expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({
      result: "passed",
      baseSha,
    });
  } finally {
    stdout.mockRestore();
  }
});
