import { expect, it, vi } from "vitest";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";

const inspectCompilerPreflight = vi.hoisted(() => vi.fn());

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
  });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await main(["compiler-preflight", "--repo", "/home/example/repository", "--base-sha", baseSha]);
    expect(inspectCompilerPreflight).toHaveBeenCalledExactlyOnceWith({
      checkout: "/home/example/repository",
      baseSha,
      allowedNetworkDestinations: DEFAULT_RUN_POLICY.allowedNetworkDestinations,
    });
    expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({
      result: "passed",
      baseSha,
    });
  } finally {
    stdout.mockRestore();
  }
});
