import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as localWorktreeRuntime from "../src/runtime/local-worktree.js";
import { activeRuntimeBundleSync, toolchainStoreRoot } from "../src/runtime/toolchain-store.js";
import {
  canonicalJson,
  runtimeBundleDigest,
  sha256Bytes,
  sha256Tree,
  SUPPORTED_RUNTIME_PLATFORM,
  type RuntimeBundleReceipt,
} from "../src/runtime/toolchain-bundle.js";
import { parseWorkerPacket } from "../src/protocol/worker-packet.js";
import {
  assertFutureToolchainRequirements,
  activateManagedRuntimePacket,
  createManagedRuntimeActivation,
  futurePackageScriptCommand,
  isFutureToolchainProvider,
  isolatedManagedToolchainPlan,
  managedToolAvailable,
  localManagedToolchainPlan,
  packageScriptValidationCommand,
  assertRepositoryCapabilityProofsCurrent,
  resolveIntegratedRepositoryCapabilities,
  TOOLCHAIN_AUTHORITY_ADAPTERS,
  unprovisionedFutureToolchainReason,
  validationSetupCommandCount,
} from "../src/toolchains/authority.js";

async function installManagedFixture(tool: "bun" | "uv"): Promise<RuntimeBundleReceipt> {
  const specifications =
    tool === "bun"
      ? [{ id: "bun", version: "1.3.10", executablePath: "bun/bin/bun" }]
      : [
          { id: "uv", version: "0.12.12", executablePath: "uv/bin/uv" },
          { id: "python", version: "3.14.7", executablePath: "python/bin/python3" },
        ];
  const scratch = await mkdtemp(join(tmpdir(), `factory-${tool}-authority-plan-`));
  const components = [];
  for (const specification of specifications) {
    const root = join(scratch, specification.id, "root");
    const executable = join(root, specification.executablePath);
    const bytes = Buffer.from(`${specification.id} executable`);
    const asset = Buffer.from(`${specification.id} archive`);
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, bytes, { mode: 0o700 });
    components.push({
      id: specification.id,
      version: specification.version,
      release: {
        provider: "github" as const,
        repository: `fixture/${specification.id}`,
        releaseId: "1",
        tag: specification.version,
        publishedAt: "2026-09-10T00:00:00.000Z",
      },
      asset: {
        assetId: "1",
        name: `${specification.id}.asset`,
        url: `https://example.invalid/${specification.id}.asset`,
        size: asset.length,
        sha256: sha256Bytes(asset),
        archive: specification.id === "bun" ? ("zip" as const) : ("tar.gz" as const),
      },
      executablePath: specification.executablePath,
      executableSha256: sha256Bytes(bytes),
      treeSha256: await sha256Tree(root),
    });
  }
  const unsigned = {
    protocol: "clockgrove.factory/toolchain-runtime-bundle-v1" as const,
    tool,
    adapter: tool === "bun" ? "javascript-bun" : "python-uv",
    adapterContract: 1,
    platform: SUPPORTED_RUNTIME_PLATFORM,
    components,
    resolvedAt: "2026-09-10T00:00:00.000Z",
  };
  const receipt: RuntimeBundleReceipt = { ...unsigned, digest: runtimeBundleDigest(unsigned) };
  const bundle = join(toolchainStoreRoot(), "bundles", receipt.digest);
  for (const [index, specification] of specifications.entries()) {
    const target = join(bundle, specification.id);
    await mkdir(dirname(join(target, "root", specification.executablePath)), { recursive: true });
    await writeFile(join(target, "asset"), `${specification.id} archive`);
    await writeFile(
      join(target, "root", specification.executablePath),
      `${specification.id} executable`,
      { mode: 0o700 },
    );
    expect(await sha256Tree(join(target, "root"))).toBe(components[index]!.treeSha256);
  }
  await writeFile(join(bundle, "receipt.json"), JSON.stringify(receipt));
  return receipt;
}

async function installDistinctRuntime(source: RuntimeBundleReceipt): Promise<RuntimeBundleReceipt> {
  const unsigned = structuredClone(source) as Omit<RuntimeBundleReceipt, "digest"> & {
    digest?: string;
  };
  delete unsigned.digest;
  const pnpm = unsigned.components.find(({ id }) => id === "pnpm")!;
  pnpm.release = { ...pnpm.release, releaseId: "provider-mismatch" };
  const receipt = { ...unsigned, digest: runtimeBundleDigest(unsigned) } as RuntimeBundleReceipt;
  const root = toolchainStoreRoot();
  await cp(join(root, "bundles", source.digest), join(root, "bundles", receipt.digest), {
    recursive: true,
  });
  await writeFile(
    join(root, "bundles", receipt.digest, "receipt.json"),
    `${canonicalJson(receipt)}\n`,
  );
  return receipt;
}

describe("toolchain authority adapters", () => {
  it("records provisioning and future-authority decisions in one registry", () => {
    expect(
      TOOLCHAIN_AUTHORITY_ADAPTERS.map((adapter) => ({
        runner: adapter.runner,
        provisioning: adapter.provisioning,
        future: adapter.deferredOperations,
      })),
    ).toEqual(
      expect.arrayContaining([
        { runner: "npm", provisioning: "host-observed", future: false },
        { runner: "pnpm", provisioning: "factory-provisioned", future: true },
        { runner: "bun", provisioning: "factory-provisioned", future: true },
        { runner: "uv", provisioning: "factory-provisioned", future: true },
        { runner: "cargo", provisioning: "host-observed", future: false },
        { runner: "go", provisioning: "host-observed", future: false },
        { runner: "python", provisioning: "host-observed", future: false },
      ]),
    );
  });

  it.each([
    {
      tool: "bun" as const,
      adapter: "javascript-bun",
      commands: ["bun run test"],
      setup: "bun install --frozen-lockfile",
    },
    {
      tool: "uv" as const,
      adapter: "python-uv",
      commands: ["uv run --locked --no-sync python -m pytest"],
      setup: "uv sync --locked",
    },
  ])("uses the adapter-owned $tool plan in production isolation", async (fixture) => {
    const receipt = await installManagedFixture(fixture.tool);
    const adapter = TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === fixture.adapter)!;
    const plan = isolatedManagedToolchainPlan(fixture.commands, [
      {
        ...adapter.runtimeRequirement!,
        bundleDigest: receipt.digest,
      },
    ]);
    expect(plan?.plan.environment.PATH).toBe("/tmp/factory-toolchain/bin");
    expect(plan?.plan.setup.some(({ display }) => display.startsWith(fixture.setup))).toBe(true);
    expect(plan?.plan.setup.map(({ display }) => display)).toEqual(adapter.setupCommands);
    expect(plan?.plan.assets.every(({ treeSha256 }) => /^[a-f0-9]{64}$/.test(treeSha256))).toBe(
      true,
    );
  });

  it.each([
    {
      tool: "bun" as const,
      adapterId: "javascript-bun",
      command: "bun --cwd packages/api run test",
      authorityPaths: ["package.json", "bun.lock"],
      discoveredAuthorityPath: "packages/api/package.json",
      files: {
        "package.json": JSON.stringify({
          name: "proof",
          version: "1.0.0",
          packageManager: "bun@1.3.10",
          workspaces: ["packages/*"],
        }),
        "packages/api/package.json": JSON.stringify({
          name: "api",
          version: "1.0.0",
          scripts: { test: "bun test" },
        }),
        "bun.lock": JSON.stringify({
          lockfileVersion: 1,
          configVersion: 1,
          workspaces: { "": { name: "proof" }, "packages/api": { name: "api" } },
          packages: { api: ["api@workspace:packages/api"] },
        }),
      },
      changedPath: "package.json",
      changedContent: JSON.stringify({
        name: "proof",
        version: "1.0.0",
        packageManager: "bun@1.3.10",
        description: "authority drift",
        workspaces: ["packages/*"],
      }),
      tools: ["bun"],
      networkDestinations: ["registry.npmjs.org"],
      expected: /Bun authority bytes changed/,
    },
    {
      tool: "uv" as const,
      adapterId: "python-uv",
      command: "uv run --locked --no-sync python -m pytest",
      authorityPaths: ["pyproject.toml", "uv.lock", ".python-version"],
      files: {
        "pyproject.toml": `[project]\nname = "proof"\nrequires-python = "==3.14.7"\ndependencies = []\n\n[tool.uv]\nrequired-version = "==0.12.12"\npackage = false\n\n[dependency-groups]\ndev = ["pytest==8.4.2"]\n`,
        "uv.lock": `version = 1\nrequires-python = "==3.14.7"\n\n[[package]]\nname = "pytest"\nversion = "8.4.2"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{ url = "https://files.pythonhosted.org/packages/pytest.whl", hash = "sha256:${"a".repeat(64)}" }]\n`,
        ".python-version": "3.14.7\n",
      },
      changedPath: "pyproject.toml",
      changedContent: `[project]\nname = "proof"\ndescription = "authority drift"\nrequires-python = "==3.14.7"\ndependencies = []\n\n[tool.uv]\nrequired-version = "==0.12.12"\npackage = false\n\n[dependency-groups]\ndev = ["pytest==8.4.2"]\n`,
      tools: ["uv", "python"],
      networkDestinations: ["pypi.org", "files.pythonhosted.org"],
      expected: /uv authority bytes changed/,
    },
    {
      tool: "uv" as const,
      adapterId: "python-uv",
      command: "uv run --project packages/api --locked --no-sync python -m pytest",
      authorityPaths: ["pyproject.toml", "uv.lock", ".python-version"],
      files: {
        "pyproject.toml": `[project]\nname = "root"\n\n[tool.uv]\nrequired-version = "==0.12.12"\npackage = false\n\n[tool.uv.workspace]\nmembers = ["packages/api", "packages/shared"]\n`,
        "packages/api/pyproject.toml": `[project]\nname = "api"\nrequires-python = "==3.14.7"\ndependencies = []\n\n[tool.uv]\npackage = false\n\n[dependency-groups]\ndev = ["pytest==8.4.2"]\n`,
        "packages/shared/pyproject.toml": `[project]\nname = "shared"\nrequires-python = "==3.14.7"\ndependencies = []\n\n[tool.uv]\npackage = false\n`,
        "uv.lock": `version = 1\nrequires-python = "==3.14.7"\n\n[[package]]\nname = "root"\nversion = "1.0.0"\nsource = { virtual = "." }\n\n[[package]]\nname = "api"\nversion = "1.0.0"\nsource = { virtual = "packages/api" }\n\n[[package]]\nname = "shared"\nversion = "1.0.0"\nsource = { virtual = "packages/shared" }\n\n[[package]]\nname = "pytest"\nversion = "8.4.2"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{ url = "https://files.pythonhosted.org/packages/pytest.whl", hash = "sha256:${"a".repeat(64)}" }]\n`,
        ".python-version": "3.14.7\n",
      },
      changedPath: "pyproject.toml",
      changedContent: `[project]\nname = "root"\ndescription = "authority drift"\n\n[tool.uv]\nrequired-version = "==0.12.12"\npackage = false\n\n[tool.uv.workspace]\nmembers = ["packages/api", "packages/shared"]\n`,
      tools: ["uv", "python"],
      networkDestinations: ["pypi.org", "files.pythonhosted.org"],
      expected: /uv authority includes a path outside its provider scope/,
    },
  ])("rejects $tool authority changed after its provider generation", async (fixture) => {
    const receipt = await installManagedFixture(fixture.tool);
    const repository = await mkdtemp(join(tmpdir(), `factory-${fixture.tool}-provider-proof-`));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
      cwd: repository,
    });
    for (const [path, content] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(repository, path)), { recursive: true });
      await writeFile(join(repository, path), content);
    }
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "provider generation"], { cwd: repository });
    const providerBase = {
      oid: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      treeOid: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
    };
    await writeFile(join(repository, fixture.changedPath), fixture.changedContent);
    execFileSync("git", ["add", fixture.changedPath], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "change authority"], { cwd: repository });
    const currentBase = {
      oid: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      treeOid: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
    };
    const adapter = TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === fixture.adapterId)!;
    const runtime = { ...adapter.runtimeRequirement!, bundleDigest: receipt.digest };
    const sourceRef = "refs/heads/main";
    const packet = parseWorkerPacket({
      goal: `Use the integrated ${fixture.tool} test.`,
      acceptanceCriteria: ["The test passes."],
      allowedPaths: ["src/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: currentBase.oid,
      validationCommands: [fixture.command],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: fixture.tools,
        services: [],
        networkDestinations: fixture.networkDestinations,
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      repositoryCapabilities: {
        provides: [],
        requires: [
          {
            adapter: adapter.id,
            generation: `${adapter.id}/root`,
            providerWorkItem: "root",
            authorityPaths: fixture.authorityPaths,
            operation: adapter.operation!(fixture.command)!,
            activation: "integrated-base",
            runtime: adapter.runtimeRequirement,
          },
        ],
      },
      managedRuntimes: [runtime],
      artifactContract: "clockgrove.factory/artifact-v1",
    });
    const providerPacket = parseWorkerPacket({
      ...packet,
      baseSha: providerBase.oid,
      repositoryCapabilities: undefined,
    });
    const providerActivation = createManagedRuntimeActivation({
      packet: providerPacket,
      baseSha: providerBase.oid,
      sourceRef,
      proofDigests: [],
      receipts: [receipt],
    })!;
    const provider = {
      id: "root",
      dependsOn: [] as string[],
      scope: fixture.authorityPaths,
      issueNumber: fixture.tool === "bun" ? 293 : 291,
      integration: {
        kind: "attempt" as const,
        runId:
          fixture.tool === "bun"
            ? "00000000-0000-4000-8000-000000000293"
            : "00000000-0000-4000-8000-000000000291",
        attempt: 1,
        commitSha: providerBase.oid,
        treeOid: providerBase.treeOid,
        reservationOid: "c".repeat(40),
        reservationReceiptDigest: "d".repeat(64),
        receiptDigest: "a".repeat(64),
        managedRuntimeActivation: providerActivation,
      },
    };
    if (fixture.discoveredAuthorityPath) {
      await expect(
        resolveIntegratedRepositoryCapabilities({
          repository,
          base: currentBase,
          sourceRef,
          packet,
          providerById: () => provider,
        }),
      ).rejects.toThrow(/Bun authority includes a path outside its provider scope/);
      provider.scope.push(fixture.discoveredAuthorityPath);
    }
    await expect(
      resolveIntegratedRepositoryCapabilities({
        repository,
        base: currentBase,
        sourceRef,
        packet,
        providerById: () => provider,
      }),
    ).rejects.toThrow(fixture.expected);
  });

  it("parses npm and pnpm as distinct finite package-script adapters", () => {
    expect(packageScriptValidationCommand("npm test")).toMatchObject({
      manager: "npm",
      script: "test",
      adapter: { id: "node-npm" },
    });
    expect(packageScriptValidationCommand("npm run typecheck")).toMatchObject({
      manager: "npm",
      script: "typecheck",
    });
    expect(packageScriptValidationCommand("pnpm check")).toMatchObject({
      manager: "pnpm",
      script: "check",
      adapter: { id: "node-pnpm" },
    });
    expect(futurePackageScriptCommand("npm test")).toBeNull();
    expect(futurePackageScriptCommand("pnpm run test:unit")).toMatchObject({
      manager: "pnpm",
      script: "test:unit",
    });
    expect(packageScriptValidationCommand("pnpm install")).toBeNull();
  });

  it("admits only the audited provider shape and rejects missing authority", () => {
    const provider = {
      dependsOn: [] as string[],
      allowedPaths: ["package.json", "pnpm-lock.yaml"],
      validationCommands: ["pnpm check"],
      requirements: {
        tools: ["node", "pnpm"],
        networkDestinations: ["registry.npmjs.org"],
      },
    };
    expect(isFutureToolchainProvider(provider as never)).toBe(true);
    expect(
      isFutureToolchainProvider({ ...provider, allowedPaths: ["package.json"] } as never),
    ).toBe(false);
    expect(() =>
      assertFutureToolchainRequirements(futurePackageScriptCommand("pnpm check")!, {
        ...provider,
        requirements: { ...provider.requirements, networkDestinations: [] },
      } as never),
    ).toThrow(/registry\.npmjs\.org setup authority/);
  });

  it("distinguishes provisioned adapters from unsupported greenfield runners", () => {
    expect(unprovisionedFutureToolchainReason("npm test")).toMatch(/npm.*no Factory-provisioned/);
    expect(unprovisionedFutureToolchainReason("bun run test")).toBeUndefined();
    expect(
      unprovisionedFutureToolchainReason("uv run --locked --no-sync python -m pytest"),
    ).toBeUndefined();
    expect(unprovisionedFutureToolchainReason("cargo test")).toMatch(
      /cargo.*no Factory-provisioned/,
    );
    expect(unprovisionedFutureToolchainReason("go test ./...")).toMatch(
      /go.*no Factory-provisioned/,
    );
    expect(unprovisionedFutureToolchainReason("python -m pytest")).toMatch(
      /python.*no Factory-provisioned/,
    );
  });

  it("reserves adapter-owned setup slots and refuses mixed package managers", () => {
    expect(validationSetupCommandCount(["node --test test/a.js"])).toBe(1);
    expect(validationSetupCommandCount(["npm test"])).toBe(1);
    expect(validationSetupCommandCount(["pnpm check", "pnpm test"])).toBe(2);
    expect(() => validationSetupCommandCount(["npm test", "pnpm check"])).toThrow(/mix/);
  });

  it("probes bundled tools without consulting ambient PATH", async () => {
    const ambient = vi.fn(async () => true);
    expect(await managedToolAvailable("pnpm", ambient)).toBe(true);
    expect(ambient).not.toHaveBeenCalled();
    expect(await managedToolAvailable("npm", ambient)).toBe(true);
    expect(ambient).toHaveBeenCalledWith("npm");
  });

  it("resolves an exact integrated base into a tree, packet, operation, provider, and runtime proof", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-toolchain-proof-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
      cwd: repository,
    });
    await mkdir(join(repository, "test"));
    await writeFile(
      join(repository, "test/check.js"),
      "import assert from 'node:assert'; assert.ok(true);\n",
    );
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({
        name: "proof",
        version: "1.0.0",
        packageManager: "pnpm@10.34.5",
        scripts: {
          check: "node --test test/check.js",
          test: "node --test test/check.js",
        },
      }),
    );
    await writeFile(
      join(repository, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
    );
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repository });
    const base = {
      oid: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
      treeOid: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
    };
    const graphPacket = {
      goal: "Use the integrated check.",
      acceptanceCriteria: ["The check passes."],
      allowedPaths: ["src/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: base.oid,
      validationCommands: ["pnpm check", "pnpm test"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["node", "pnpm"],
        services: [],
        networkDestinations: ["registry.npmjs.org"],
        permittedSecretNames: [],
        trust: "trusted_local" as const,
      },
      repositoryCapabilities: {
        provides: [],
        requires: [
          {
            adapter: "node-pnpm",
            generation: "node-pnpm/root",
            providerWorkItem: "root",
            authorityPaths: ["package.json", "pnpm-lock.yaml"],
            operation: { kind: "package-script", key: "check" },
            activation: "integrated-base" as const,
            runtime: TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!
              .runtimeRequirement!,
          },
          {
            adapter: "node-pnpm",
            generation: "node-pnpm/root",
            providerWorkItem: "root",
            authorityPaths: ["package.json", "pnpm-lock.yaml"],
            operation: { kind: "package-script", key: "test" },
            activation: "integrated-base" as const,
            runtime: TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!
              .runtimeRequirement!,
          },
        ],
      },
      managedRuntimes: [
        TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!.runtimeRequirement!,
      ],
      artifactContract: "clockgrove.factory/artifact-v1" as const,
    };
    const sourceRef = "refs/heads/main";
    const { repositoryCapabilities: _providerBindings, ...providerGraphPacket } = graphPacket;
    const providerPacket = await activateManagedRuntimePacket(providerGraphPacket);
    const providerActivation = createManagedRuntimeActivation({
      packet: providerPacket,
      baseSha: base.oid,
      sourceRef,
      proofDigests: [],
    })!;
    const providerFor = (commit: typeof base) => ({
      id: "root",
      dependsOn: [] as string[],
      scope: ["package.json", "pnpm-lock.yaml", "test/check.js"],
      issueNumber: 8,
      integration: {
        kind: "attempt" as const,
        runId: "00000000-0000-4000-8000-000000000008",
        attempt: 1,
        commitSha: commit.oid,
        treeOid: commit.treeOid,
        reservationOid: "c".repeat(40),
        reservationReceiptDigest: "d".repeat(64),
        receiptDigest: "a".repeat(64),
        managedRuntimeActivation: providerActivation,
      },
    });
    const packet = await activateManagedRuntimePacket(graphPacket, (id) =>
      id === "root" ? providerFor(base) : undefined,
    );
    const providerById = (id: string) => (id === "root" ? providerFor(base) : undefined);
    const materialize = vi.spyOn(localWorktreeRuntime, "createLocalWorktree");
    const proofs = await resolveIntegratedRepositoryCapabilities({
      repository,
      base,
      sourceRef,
      packet,
      providerById,
    });
    expect(proofs).toHaveLength(2);
    expect(materialize).toHaveBeenCalledOnce();
    expect(proofs[0]).toMatchObject({
      baseSha: base.oid,
      baseTreeOid: base.treeOid,
      providerWorkItem: "root",
      providerIssue: 8,
      providerCommitSha: base.oid,
      generation: "node-pnpm/root",
      operation: { kind: "package-script", key: "check" },
    });
    expect(proofs[0]!.runtimeIdentity).toMatch(/^node-pnpm@1\/linux-x64-glibc\/[0-9a-f]{64}$/);
    await expect(
      assertRepositoryCapabilityProofsCurrent({ proofs, base, sourceRef, packet, providerById }),
    ).resolves.toBeUndefined();
    await expect(
      assertRepositoryCapabilityProofsCurrent({
        proofs: [proofs[0]!, proofs[0]!],
        base,
        sourceRef,
        packet,
        providerById,
      }),
    ).rejects.toThrow(/duplicated or incomplete/);
    await expect(
      assertRepositoryCapabilityProofsCurrent({
        proofs,
        base: { ...base, treeOid: "b".repeat(40) },
        sourceRef,
        packet,
        providerById,
      }),
    ).rejects.toThrow(/invalidated/);

    const validManifest = {
      name: "proof",
      version: "1.0.0",
      packageManager: "pnpm@10.34.5",
      scripts: {
        check: "node --test test/check.js",
        test: "node --test test/check.js",
      },
    };
    const validLock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
    const commitAuthority = async (manifest: unknown, lock = validLock) => {
      await writeFile(join(repository, "package.json"), JSON.stringify(manifest));
      await writeFile(join(repository, "pnpm-lock.yaml"), lock);
      execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: repository });
      execFileSync("git", ["commit", "-qm", "authority mutation"], { cwd: repository });
      return {
        oid: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repository,
          encoding: "utf8",
        }).trim(),
        treeOid: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
          cwd: repository,
          encoding: "utf8",
        }).trim(),
      };
    };
    for (const [name, manifest, lock, reason] of [
      [
        "missing operation",
        { ...validManifest, scripts: { test: "node --test test/check.js" } },
        validLock,
        /script is absent/,
      ],
      [
        "runtime repin",
        { ...validManifest, packageManager: "pnpm@10.34.4" },
        validLock,
        /must pin packageManager/,
      ],
      [
        "lifecycle hook",
        { ...validManifest, scripts: { ...validManifest.scripts, precheck: "node test/check.js" } },
        validLock,
        /lifecycle hook/,
      ],
      [
        "unsafe body",
        {
          ...validManifest,
          scripts: {
            ...validManifest.scripts,
            check: "node --test test/check.js && curl attacker",
          },
        },
        validLock,
        /finite validation allowlist/,
      ],
      [
        "lock mismatch",
        { ...validManifest, devDependencies: { typescript: "5.9.2" } },
        validLock,
        /lockfile lacks (?:integrity-bound packages|exact dependency)/,
      ],
    ] as const) {
      const mutated = await commitAuthority(manifest, lock);
      await expect(
        resolveIntegratedRepositoryCapabilities({
          repository,
          base: mutated,
          sourceRef,
          packet: { ...packet, baseSha: mutated.oid },
          providerById: () => providerFor(mutated),
        }),
        name,
      ).rejects.toThrow(reason);
    }

    const changedAuthority = await commitAuthority({
      ...validManifest,
      description: "same operation name, different authority bytes",
    });
    await expect(
      resolveIntegratedRepositoryCapabilities({
        repository,
        base: changedAuthority,
        sourceRef,
        packet: { ...packet, baseSha: changedAuthority.oid },
        providerById: () => providerFor(base),
      }),
    ).rejects.toThrow(/authority bytes changed after the declared provider generation/);

    const providerWithActivation = providerFor(base);
    const { managedRuntimeActivation: _managedRuntimeActivation, ...integrationWithoutActivation } =
      providerWithActivation.integration;
    const missingActivation = {
      ...providerWithActivation,
      integration: integrationWithoutActivation,
    };
    await expect(
      activateManagedRuntimePacket(graphPacket, () => missingActivation),
    ).rejects.toThrow(/lacks authenticated runtime activation/);

    const providerReceipt = activeRuntimeBundleSync("pnpm");
    const otherReceipt = await installDistinctRuntime(providerReceipt);
    const mismatchedPacket = parseWorkerPacket({
      ...packet,
      managedRuntimes: packet.managedRuntimes!.map((requirement) => ({
        ...requirement,
        bundleDigest: otherReceipt.digest,
      })),
    });
    await expect(
      resolveIntegratedRepositoryCapabilities({
        repository,
        base,
        sourceRef,
        packet: mismatchedPacket,
        providerById,
      }),
    ).rejects.toThrow(/differs from its repository capability provider generation/);
    await expect(
      resolveIntegratedRepositoryCapabilities({
        repository,
        base,
        sourceRef,
        packet,
        providerById: () => missingActivation,
      }),
    ).rejects.toThrow(/lacks authenticated runtime activation/);
    const providerWithChangedActivation = providerFor(base);
    providerWithChangedActivation.integration.managedRuntimeActivation =
      createManagedRuntimeActivation({
        packet: mismatchedPacket,
        baseSha: base.oid,
        sourceRef,
        proofDigests: [],
        receipts: [otherReceipt],
      })!;
    await expect(
      assertRepositoryCapabilityProofsCurrent({
        proofs,
        base,
        sourceRef,
        packet,
        providerById: () => providerWithChangedActivation,
      }),
    ).rejects.toThrow(/provider generation changed|activated runtime differs/);

    const restored = await commitAuthority(validManifest);
    for (const [name, mutate, reason] of [
      [
        "generation",
        (value: typeof packet) =>
          (value.repositoryCapabilities!.requires[0]!.generation = "node-pnpm/other"),
        /canonical provider contract/,
      ],
      [
        "authority paths",
        (value: typeof packet) =>
          (value.repositoryCapabilities!.requires[0]!.authorityPaths = ["package.json"]),
        /canonical provider contract/,
      ],
      [
        "provider identity",
        (value: typeof packet) =>
          (value.repositoryCapabilities!.requires[0]!.providerWorkItem = "other"),
        /unknown repository capability provider/,
      ],
    ] as const) {
      const changed = structuredClone({ ...packet, baseSha: restored.oid });
      mutate(changed);
      await expect(
        resolveIntegratedRepositoryCapabilities({
          repository,
          base: restored,
          sourceRef,
          packet: changed,
          providerById: (id) => (id === "root" ? providerFor(restored) : undefined),
        }),
        name,
      ).rejects.toThrow(reason);
    }
    materialize.mockRestore();
  });

  it("repairs stale private shims and keeps hostile ambient node and pnpm behind exact runtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-toolchain-shim-"));
    const privateRoot = join(root, "private");
    const bin = join(privateRoot, "factory-tools");
    const hostile = join(root, "hostile");
    await mkdir(bin, { recursive: true });
    await mkdir(hostile);
    await writeFile(join(bin, "node"), "stale node");
    await writeFile(join(bin, "pnpm"), "stale pnpm");
    await writeFile(join(hostile, "node"), "hostile node");
    await writeFile(join(hostile, "pnpm"), "hostile pnpm");

    const plan = await localManagedToolchainPlan(
      ["pnpm check"],
      { ...process.env, PATH: hostile },
      privateRoot,
      (
        await activateManagedRuntimePacket({
          goal: "Use pnpm.",
          acceptanceCriteria: ["The command runs."],
          allowedPaths: ["package.json"],
          preconditions: [],
          outOfScope: [],
          conventions: [],
          baseSha: "a".repeat(40),
          validationCommands: ["pnpm check"],
          requirements: {
            os: ["linux"],
            architecture: [],
            tools: ["node", "pnpm"],
            services: [],
            networkDestinations: ["registry.npmjs.org"],
            permittedSecretNames: [],
            trust: "trusted_local",
          },
          managedRuntimes: [
            TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!.runtimeRequirement!,
          ],
          artifactContract: "clockgrove.factory/artifact-v1",
        })
      ).managedRuntimes,
    );
    expect(plan).not.toBeNull();
    expect(await readlink(join(bin, "node"))).toMatch(/\/bundles\/[0-9a-f]{64}\/node\/root\/node$/);
    expect(await readlink(join(bin, "pnpm"))).toMatch(/\/bundles\/[0-9a-f]{64}\/pnpm\/root\/pnpm$/);
    expect(
      execFileSync("pnpm", ["--version"], {
        cwd: root,
        env: plan!.environment,
        encoding: "utf8",
      }).trim(),
    ).toBe("10.34.5");
  });
});
