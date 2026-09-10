import { afterEach, describe, expect, it, vi } from "vitest";

import { OctokitToolchainReleaseSource } from "../src/runtime/toolchain-github-source.js";

afterEach(() => vi.unstubAllGlobals());

describe("official Node runtime selection", () => {
  it("selects the highest stable Linux x64 semver regardless of index order", async () => {
    const index = [
      { version: "v20.19.5", date: "2026-09-03", files: ["linux-x64"] },
      { version: "v23.0.0-rc.1", date: "2026-09-10", files: ["linux-x64"] },
      { version: "v22.20.0", date: "2026-09-02", files: ["linux-x64"] },
      { version: "v21.7.3", date: "2026-09-04", files: ["linux-x64"] },
    ];
    const checksum = "a".repeat(64);
    const fetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/index.json"))
        return { ok: true, text: async () => JSON.stringify(index) } as Response;
      expect(target).toContain("/v22.20.0/SHASUMS256.txt");
      return {
        ok: true,
        text: async () => `${checksum}  node-v22.20.0-linux-x64.tar.xz\n`,
      } as Response;
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      new OctokitToolchainReleaseSource("token").resolveLatestNodeDistribution(),
    ).resolves.toMatchObject({ version: "22.20.0", tag: "v22.20.0", sha256: checksum });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
