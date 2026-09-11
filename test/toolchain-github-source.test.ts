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

  it("selects only an audited LTS Node/npm pair and rejects unsupported future majors", async () => {
    const supportedIndex = [
      {
        version: "v26.2.0",
        date: "2026-11-10",
        files: ["linux-x64"],
        lts: "Future",
        npm: "12.1.0",
      },
      { version: "v25.4.0", date: "2026-09-10", files: ["linux-x64"], lts: false, npm: "11.8.0" },
      {
        version: "v24.12.1",
        date: "2026-09-09",
        files: ["linux-x64"],
        lts: "Krypton",
        npm: "11.7.0",
      },
      { version: "v22.20.0", date: "2026-09-02", files: ["linux-x64"], lts: "Jod", npm: "10.9.3" },
    ];
    const checksum = "b".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/index.json")
          ? ({ ok: true, text: async () => JSON.stringify(supportedIndex) } as Response)
          : ({
              ok: true,
              text: async () => `${checksum}  node-v24.12.1-linux-x64.tar.xz\n`,
            } as Response),
      ),
    );
    await expect(
      new OctokitToolchainReleaseSource("token").resolveLatestNodeDistribution({
        embeddedNpm: true,
      }),
    ).resolves.toMatchObject({
      version: "24.12.1",
      npmVersion: "11.7.0",
      lts: "Krypton",
      sha256: checksum,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, text: async () => JSON.stringify([supportedIndex[0]]) }) as Response,
      ),
    );
    await expect(
      new OctokitToolchainReleaseSource("token").resolveLatestNodeDistribution({
        embeddedNpm: true,
      }),
    ).rejects.toThrow(/no supported Node 22\/npm 10 or Node 24\/npm 11/);
  });
});
