import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  activeRuntimeBundle,
  activeRuntimeBundleSync,
  provisionToolchain,
  restoreToolchain,
  runtimeBundleByDigest,
  runtimeComponentPaths,
  toolchainStatus,
  type GitHubRelease,
  type ToolchainReleaseSource,
} from "../src/runtime/toolchain-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const testNodeBytes = Buffer.from("#!/bin/sh\nprintf 'v22.14.0\\n'\n", "utf8");

function source(bytes: Buffer, releases?: GitHubRelease[]): ToolchainReleaseSource {
  const defaults: GitHubRelease[] = [
    {
      id: 1,
      tag: "v99.0.0-rc.1",
      draft: false,
      prerelease: true,
      publishedAt: "2026-09-10T00:00:00.000Z",
      assets: [],
    },
    {
      id: 2,
      tag: "v12.3.4",
      draft: false,
      prerelease: false,
      publishedAt: "2026-09-09T00:00:00.000Z",
      assets: [
        {
          id: 20,
          name: "pnpm-linux-x64",
          url: "https://api.github.com/repos/pnpm/pnpm/releases/assets/20",
          browserDownloadUrl:
            "https://github.com/pnpm/pnpm/releases/download/v12.3.4/pnpm-linux-x64",
          size: bytes.byteLength,
          digest: `sha256:${digest(bytes)}`,
        },
      ],
    },
  ];
  return {
    listReleases: async () => releases ?? defaults,
    downloadAsset: async () => bytes,
    resolveLatestNodeDistribution: async () => ({
      version: "22.14.0",
      tag: "v22.14.0",
      publishedAt: "2026-09-08T00:00:00.000Z",
      name: "node-v22.14.0-linux-x64-test",
      url: "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64-test",
      sha256: digest(testNodeBytes),
      archive: "raw",
      executablePath: "node",
    }),
    downloadNodeDistribution: async () => testNodeBytes,
  };
}

const fakeRun = (async (command: string) => ({
  stdout: command.includes("/node/root/") ? "v22.14.0\n" : "12.3.4\n",
  stderr: "",
})) as never;

describe("managed toolchain store", () => {
  it("selects one GA release, installs atomically, and re-verifies active bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    roots.push(root);
    const bytes = Buffer.from("#!/bin/sh\nprintf '12.3.4\\n'\n", "utf8");
    const releaseSource = source(bytes);
    let downloads = 0;
    const download = releaseSource.downloadAsset;
    releaseSource.downloadAsset = async (...args) => {
      downloads += 1;
      return download(...args);
    };
    const receipt = await provisionToolchain("pnpm", {
      root,
      source: releaseSource,
      now: () => new Date("2026-09-10T01:02:03.000Z"),
      run: fakeRun,
    });

    expect(receipt.tool).toBe("pnpm");
    expect(receipt.components.map(({ version }) => version)).toEqual(["22.14.0", "12.3.4"]);
    expect(receipt.resolvedAt).toBe("2026-09-10T01:02:03.000Z");
    expect((await activeRuntimeBundle("pnpm", root)).digest).toBe(receipt.digest);
    expect(activeRuntimeBundleSync("pnpm", root).digest).toBe(receipt.digest);
    expect(await toolchainStatus("pnpm", root)).toMatchObject({ state: "ready" });
    expect(
      (
        await provisionToolchain("pnpm", {
          root,
          source: releaseSource,
          run: fakeRun,
        })
      ).digest,
    ).toBe(receipt.digest);
    expect(downloads).toBe(1);

    const secondRoot = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    roots.push(secondRoot);
    const reconstructed = await provisionToolchain("pnpm", {
      root: secondRoot,
      source: source(bytes),
      now: () => new Date("2027-01-01T00:00:00.000Z"),
      run: fakeRun,
    });
    expect(reconstructed.resolvedAt).not.toBe(receipt.resolvedAt);
    expect(reconstructed.digest).toBe(receipt.digest);

    const [component] = runtimeComponentPaths(root, receipt);
    await writeFile(component!.asset, "corrupt", "utf8");
    expect(await toolchainStatus("pnpm", root)).toMatchObject({
      state: "corrupt",
      reason: expect.stringMatching(/integrity verification/),
    });
  });

  it("extracts only exact Node from an official-style tar.xz with sibling symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    const assets = await mkdtemp(join(tmpdir(), "factory-toolchain-assets-"));
    roots.push(root, assets);
    const nodeTree = join(assets, "node-tree");
    const nodePrefix = "node-v22.14.0-linux-x64";
    await mkdir(join(nodeTree, nodePrefix, "bin"), { recursive: true });
    await writeFile(join(nodeTree, nodePrefix, "bin/node"), "#!/bin/sh\nprintf 'v22.14.0\\n'\n");
    await symlink("../lib/node_modules/npm/bin/npm-cli.js", join(nodeTree, nodePrefix, "bin/npm"));
    const archive = join(assets, "node.tar.xz");
    execFileSync("tar", ["-cJf", archive, "-C", nodeTree, nodePrefix]);
    const nodeBytes = await readFile(archive);
    const pnpmBytes = Buffer.from("#!/bin/sh\nprintf '12.3.4\\n'\n");
    const releaseSource = source(pnpmBytes);
    releaseSource.resolveLatestNodeDistribution = async () => ({
      version: "22.14.0",
      tag: "v22.14.0",
      publishedAt: "2026-09-08T00:00:00.000Z",
      name: `${nodePrefix}.tar.xz`,
      url: `https://nodejs.org/dist/v22.14.0/${nodePrefix}.tar.xz`,
      sha256: digest(nodeBytes),
      archive: "tar.xz",
      executablePath: `${nodePrefix}/bin/node`,
    });
    releaseSource.downloadNodeDistribution = async () => nodeBytes;
    const receipt = await provisionToolchain("pnpm", {
      root,
      source: releaseSource,
    });
    const node = runtimeComponentPaths(root, receipt).find(
      ({ component }) => component.id === "node",
    )!;
    expect(node.component.executableOnly).toBe(true);
    await expect(access(node.executable)).resolves.toBeUndefined();
    await expect(access(join(node.root, nodePrefix, "bin/npm"))).rejects.toThrow();
  });

  it("rejects missing official digests and mismatched downloads without activating", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    roots.push(root);
    const bytes = Buffer.from("runtime", "utf8");
    const badDigest: GitHubRelease[] = [
      {
        id: 2,
        tag: "v12.3.4",
        draft: false,
        prerelease: false,
        publishedAt: "2026-09-09T00:00:00.000Z",
        assets: [
          {
            id: 20,
            name: "pnpm-linux-x64",
            url: "api",
            browserDownloadUrl: "download",
            size: bytes.byteLength,
            digest: "",
          },
        ],
      },
    ];
    await expect(
      provisionToolchain("pnpm", {
        root,
        source: source(bytes, badDigest),
        run: fakeRun,
      }),
    ).rejects.toThrow(/official SHA-256/);
    expect(await toolchainStatus("pnpm", root)).toMatchObject({ state: "missing" });

    const mismatch = source(bytes);
    mismatch.downloadAsset = async () => Buffer.from("different", "utf8");
    await expect(
      provisionToolchain("pnpm", {
        root,
        source: mismatch,
        run: fakeRun,
      }),
    ).rejects.toThrow(/size changed|digest differs/);
  });

  it("rejects provisioned origin metadata that exact restore would reject", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    roots.push(root);
    const bytes = Buffer.from("runtime", "utf8");
    const badOrigin = source(bytes);
    const releases = await badOrigin.listReleases("pnpm", "pnpm");
    releases[1]!.assets[0]!.browserDownloadUrl = "https://attacker.invalid/pnpm-linux-x64";
    badOrigin.listReleases = async () => releases;
    let downloaded = false;
    badOrigin.downloadAsset = async () => {
      downloaded = true;
      return bytes;
    };
    await expect(
      provisionToolchain("pnpm", { root, source: badOrigin, run: fakeRun }),
    ).rejects.toThrow(/unsupported official origin identity/);
    expect(downloaded).toBe(false);
    expect(await toolchainStatus("pnpm", root)).toMatchObject({ state: "missing" });

    const badNode = source(bytes);
    badNode.resolveLatestNodeDistribution = async () => ({
      version: "22.14.0",
      tag: "v22.14.0",
      publishedAt: "2026-09-08T00:00:00.000Z",
      name: "node-v22.14.0-linux-x64.tar.xz",
      url: "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz",
      sha256: digest(testNodeBytes),
      archive: "tar.xz",
      executablePath: "node",
    });
    await expect(
      provisionToolchain("pnpm", { root, source: badNode, run: fakeRun }),
    ).rejects.toThrow(/official Node distribution identity is invalid/);
  });

  it("rejects a receipt changed after provisioning", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    roots.push(root);
    const bytes = Buffer.from("#!/bin/sh\n", "utf8");
    const receipt = await provisionToolchain("pnpm", {
      root,
      source: source(bytes),
      run: fakeRun,
    });
    const path = join(root, "bundles", receipt.digest, "receipt.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const components = parsed.components as Array<Record<string, unknown>>;
    components[0]!.version = "0.0.0";
    await writeFile(path, JSON.stringify(parsed), "utf8");
    await expect(activeRuntimeBundle("pnpm", root)).rejects.toThrow(/receipt digest mismatch/);
  });

  it("restores an exact historical receipt after cache loss without changing the active bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    roots.push(root);
    const firstBytes = Buffer.from("#!/bin/sh\nprintf '12.3.4\\n'\n", "utf8");
    const first = await provisionToolchain("pnpm", {
      root,
      source: source(firstBytes),
      now: () => new Date("2026-09-10T01:02:03.000Z"),
      run: fakeRun,
    });
    const secondBytes = Buffer.from("#!/bin/sh\nprintf '12.3.5\\n'\n", "utf8");
    const secondReleases: GitHubRelease[] = [
      {
        id: 3,
        tag: "v12.3.5",
        draft: false,
        prerelease: false,
        publishedAt: "2026-09-10T02:00:00.000Z",
        assets: [
          {
            id: 30,
            name: "pnpm-linux-x64",
            url: "https://api.github.com/repos/pnpm/pnpm/releases/assets/30",
            browserDownloadUrl:
              "https://github.com/pnpm/pnpm/releases/download/v12.3.5/pnpm-linux-x64",
            size: secondBytes.byteLength,
            digest: `sha256:${digest(secondBytes)}`,
          },
        ],
      },
    ];
    const second = await provisionToolchain("pnpm", {
      root,
      source: source(secondBytes, secondReleases),
      run: (async (command: string) => ({
        stdout: command.includes("/node/root/") ? "v22.14.0\n" : "12.3.5\n",
        stderr: "",
      })) as never,
    });
    expect(second.digest).not.toBe(first.digest);
    await rm(join(root, "bundles", first.digest), { recursive: true });

    const restoreSource = source(firstBytes);
    let latestLookups = 0;
    let restoredAsset: [string, string, number] | undefined;
    restoreSource.listReleases = async () => {
      latestLookups += 1;
      throw new Error("exact restore must not resolve latest");
    };
    restoreSource.resolveLatestNodeDistribution = async () => {
      latestLookups += 1;
      throw new Error("exact restore must not resolve latest");
    };
    restoreSource.downloadAsset = async (owner, repository, assetId) => {
      restoredAsset = [owner, repository, assetId];
      return firstBytes;
    };
    const restored = await restoreToolchain(first, {
      root,
      source: restoreSource,
      run: fakeRun,
    });

    expect(restored.digest).toBe(first.digest);
    expect(restoredAsset).toEqual(["pnpm", "pnpm", 20]);
    expect(latestLookups).toBe(0);
    expect((await runtimeBundleByDigest("pnpm", first.digest, root)).digest).toBe(first.digest);
    expect((await activeRuntimeBundle("pnpm", root)).digest).toBe(second.digest);
  });
  it("provisions the baseline Bun GA zip without consulting ambient Bun", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-store-"));
    const assets = await mkdtemp(join(tmpdir(), "factory-toolchain-assets-"));
    roots.push(root, assets);
    const tree = join(assets, "tree");
    await mkdir(join(tree, "bun-linux-x64-baseline"), { recursive: true });
    await writeFile(join(tree, "bun-linux-x64-baseline/bun"), "#!/bin/sh\nprintf '1.4.2\\n'\n");
    const archive = join(assets, "bun.zip");
    execFileSync("python3", ["-m", "zipfile", "-c", archive, "bun-linux-x64-baseline"], {
      cwd: tree,
    });
    const bytes = await readFile(archive);
    const bunRelease: GitHubRelease = {
      id: 42,
      tag: "bun-v1.4.2",
      draft: false,
      prerelease: false,
      publishedAt: "2026-09-09T00:00:00.000Z",
      assets: [
        {
          id: 420,
          name: "bun-linux-x64-baseline.zip",
          url: "https://api.github.test/assets/420",
          browserDownloadUrl:
            "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64-baseline.zip",
          size: bytes.byteLength,
          digest: `sha256:${digest(bytes)}`,
        },
      ],
    };
    const receipt = await provisionToolchain("bun", {
      root,
      source: {
        listReleases: async () => [bunRelease],
        downloadAsset: async () => bytes,
      },
    });
    expect(receipt).toMatchObject({
      tool: "bun",
      components: [
        {
          id: "bun",
          version: "1.4.2",
          asset: { archive: "zip", sha256: digest(bytes) },
        },
      ],
    });
    await rm(join(root, "bundles", receipt.digest), { recursive: true });
    let latestLookups = 0;
    const restored = await restoreToolchain(receipt, {
      root,
      source: {
        listReleases: async () => {
          latestLookups += 1;
          throw new Error("exact restore must not resolve latest");
        },
        downloadAsset: async () => bytes,
      },
    });
    expect(restored.digest).toBe(receipt.digest);
    expect(latestLookups).toBe(0);
  });
});
