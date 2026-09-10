import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildBunManagedExecutionPlan,
  bunCapabilityOperation,
  inspectBunAuthority,
  parseBunValidationCommand,
} from "../src/toolchains/bun.js";
import {
  type RuntimeBundleReceipt,
  runtimeBundleDigest,
  sha256Bytes,
  sha256File,
  sha256Tree,
  SUPPORTED_RUNTIME_PLATFORM,
} from "../src/runtime/toolchain-bundle.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function lockFor(
  workspaces: Record<string, Record<string, unknown>>,
  packages: Record<string, unknown> = {},
): Record<string, unknown> {
  return { lockfileVersion: 1, configVersion: 1, workspaces, packages };
}

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-bun-authority-"));
  await writeJson(join(root, "package.json"), {
    name: "root",
    version: "1.0.0",
    packageManager: "bun@1.3.10",
    scripts: { test: "bun test" },
  });
  await writeJson(join(root, "bun.lock"), lockFor({ "": { name: "root" } }));
  return root;
}

async function workspaceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-bun-workspace-"));
  await mkdir(join(root, "packages/api"), { recursive: true });
  await mkdir(join(root, "packages/shared"), { recursive: true });
  await writeJson(join(root, "package.json"), {
    name: "root",
    version: "1.0.0",
    packageManager: "bun@1.3.10",
    workspaces: ["packages/*"],
  });
  await writeJson(join(root, "packages/api/package.json"), {
    name: "api",
    version: "1.0.0",
    scripts: { test: "vitest run" },
    dependencies: { shared: "workspace:*" },
    devDependencies: { vitest: "3.2.4" },
  });
  await writeJson(join(root, "packages/shared/package.json"), {
    name: "shared",
    version: "1.0.0",
  });
  await writeJson(
    join(root, "bun.lock"),
    lockFor(
      {
        "": { name: "root" },
        "packages/api": {
          name: "api",
          dependencies: { shared: "workspace:packages/shared" },
          devDependencies: { vitest: "3.2.4" },
        },
        "packages/shared": { name: "shared" },
      },
      {
        vitest: [
          "vitest@3.2.4",
          "",
          {},
          "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        ],
      },
    ),
  );
  return root;
}

async function runtimeFixture(): Promise<{
  root: string;
  receipt: RuntimeBundleReceipt;
}> {
  const root = await mkdtemp(join(tmpdir(), "factory-bun-runtime-"));
  const temporaryTree = join(root, "tree");
  const executableRelative = "bun-linux-x64-baseline/bun";
  const executable = join(temporaryTree, executableRelative);
  const asset = Buffer.from("fake verified Bun archive");
  await mkdir(join(temporaryTree, "bun-linux-x64-baseline"), { recursive: true });
  await writeFile(executable, "#!/bin/sh\necho 1.3.10\n");
  await chmod(executable, 0o700);
  const component = {
    id: "bun",
    version: "1.3.10",
    release: {
      provider: "github" as const,
      repository: "oven-sh/bun",
      releaseId: "123",
      tag: "bun-v1.3.10",
      publishedAt: "2026-09-01T00:00:00.000Z",
    },
    asset: {
      assetId: "456",
      name: "bun-linux-x64-baseline.zip",
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-linux-x64-baseline.zip",
      size: asset.byteLength,
      sha256: sha256Bytes(asset),
      archive: "zip" as const,
    },
    executablePath: executableRelative,
    executableSha256: await sha256File(executable),
    treeSha256: await sha256Tree(temporaryTree),
  };
  const unsigned = {
    protocol: "clockgrove.factory/toolchain-runtime-bundle-v1" as const,
    tool: "bun" as const,
    adapter: "javascript-bun",
    adapterContract: 1,
    platform: SUPPORTED_RUNTIME_PLATFORM,
    components: [component],
    resolvedAt: "2026-09-01T00:00:00.000Z",
  };
  const receipt: RuntimeBundleReceipt = { ...unsigned, digest: runtimeBundleDigest(unsigned) };
  const componentRoot = join(root, "bundles", receipt.digest, "bun");
  await mkdir(join(componentRoot, "root", "bun-linux-x64-baseline"), { recursive: true });
  await writeFile(join(componentRoot, "asset"), asset);
  await writeFile(join(componentRoot, "root", executableRelative), "#!/bin/sh\necho 1.3.10\n");
  await chmod(join(componentRoot, "root", executableRelative), 0o700);
  return { root, receipt };
}

describe("Bun toolchain adapter", () => {
  it("parses only canonical finite root and workspace script commands", () => {
    expect(parseBunValidationCommand("bun run test")).toEqual({
      manager: "bun",
      workspace: ".",
      script: "test",
      operation: { kind: "package-script", key: "test" },
    });
    expect(parseBunValidationCommand("bun --cwd packages/api run check:types")).toEqual({
      manager: "bun",
      workspace: "packages/api",
      script: "check:types",
      operation: { kind: "package-script", key: "packages/api:check:types" },
    });
    expect(bunCapabilityOperation("bun --cwd packages/api run test")).toEqual({
      kind: "package-script",
      key: "packages/api:test",
    });
    for (const command of [
      "bun test",
      "bun run dev",
      "bun --cwd ../api run test",
      "bun --cwd ./packages/api run test",
      "bun --cwd packages/api run test --watch",
      "bun  run test",
      " bun run test",
      "bun run test && curl attacker",
    ])
      expect(parseBunValidationCommand(command), command).toBeNull();
  });

  it("grounds a root script in exact Bun, manifest, lock, and finite-body authority", async () => {
    const root = await rootFixture();
    await expect(
      inspectBunAuthority({ root, command: "bun run test", exactVersion: "1.3.10" }),
    ).resolves.toMatchObject({
      adapter: "javascript-bun",
      version: "1.3.10",
      authorityPaths: ["package.json", "bun.lock"],
      manifestPath: "package.json",
      scriptBody: "bun test",
      command: { operation: { kind: "package-script", key: "test" } },
    });
  });

  it("grounds a selected workspace with unambiguous direct-child membership", async () => {
    const root = await workspaceFixture();
    await expect(
      inspectBunAuthority({
        root,
        command: "bun --cwd packages/api run test",
        exactVersion: "1.3.10",
      }),
    ).resolves.toMatchObject({
      manifestPath: "packages/api/package.json",
      scriptBody: "vitest run",
      workspaceManifests: ["packages/api/package.json", "packages/shared/package.json"],
    });
  });

  it("rejects ambient configuration, mixed locks, hooks, trust, unsafe sources, and drift", async () => {
    const cases: Array<{
      name: string;
      mutate(root: string): Promise<void>;
      reason: RegExp;
    }> = [
      {
        name: "version drift",
        mutate: async () => undefined,
        reason: /pin packageManager to bun@1\.3\.9/,
      },
      {
        name: "mixed lock",
        mutate: (root) => writeFile(join(root, "package-lock.json"), "{}"),
        reason: /mixed package-manager lockfile/,
      },
      {
        name: "ambient config",
        mutate: (root) => writeFile(join(root, "bunfig.toml"), "[install]\nregistry='x'\n"),
        reason: /forbids package-manager configuration/,
      },
      {
        name: "trusted dependency",
        mutate: async (root) =>
          writeJson(join(root, "package.json"), {
            name: "root",
            packageManager: "bun@1.3.10",
            scripts: { test: "bun test" },
            trustedDependencies: [],
          }),
        reason: /unsupported trustedDependencies authority/,
      },
      {
        name: "lifecycle hook",
        mutate: async (root) =>
          writeJson(join(root, "package.json"), {
            name: "root",
            packageManager: "bun@1.3.10",
            scripts: { test: "bun test", postinstall: "echo unsafe" },
          }),
        reason: /lifecycle hook postinstall/,
      },
      {
        name: "script companion",
        mutate: async (root) =>
          writeJson(join(root, "package.json"), {
            name: "root",
            packageManager: "bun@1.3.10",
            scripts: { pretest: "echo unsafe", test: "bun test" },
          }),
        reason: /pre\/post lifecycle companions/,
      },
      {
        name: "exotic source",
        mutate: async (root) =>
          writeJson(join(root, "package.json"), {
            name: "root",
            packageManager: "bun@1.3.10",
            scripts: { test: "bun test" },
            dependencies: { bad: "git+https://example.invalid/repo" },
          }),
        reason: /not exact or workspace-bound/,
      },
      {
        name: "unsafe selected script",
        mutate: async (root) =>
          writeJson(join(root, "package.json"), {
            name: "root",
            packageManager: "bun@1.3.10",
            scripts: { test: "bun test && curl attacker" },
          }),
        reason: /finite validation allowlist/,
      },
    ];
    for (const scenario of cases) {
      const root = await rootFixture();
      await scenario.mutate(root);
      await expect(
        inspectBunAuthority({
          root,
          command: "bun run test",
          exactVersion: scenario.name === "version drift" ? "1.3.9" : "1.3.10",
        }),
        scenario.name,
      ).rejects.toThrow(scenario.reason);
    }
  });

  it("requires allowed external runners to be exact local dependencies", async () => {
    const root = await rootFixture();
    await writeJson(join(root, "package.json"), {
      name: "root",
      version: "1.0.0",
      packageManager: "bun@1.3.10",
      scripts: { test: "tsc --noEmit" },
    });
    await expect(
      inspectBunAuthority({ root, command: "bun run test", exactVersion: "1.3.10" }),
    ).rejects.toThrow(/typescript must be an exact local dependency/);
  });

  it("validates every transitive record and every same-name direct version", async () => {
    const transitive = await workspaceFixture();
    const transitiveLock = JSON.parse(await readFile(join(transitive, "bun.lock"), "utf8"));
    transitiveLock.packages.transitive = ["transitive@1.0.0", "", {}];
    await writeJson(join(transitive, "bun.lock"), transitiveLock);
    await expect(
      inspectBunAuthority({
        root: transitive,
        command: "bun --cwd packages/api run test",
        exactVersion: "1.3.10",
      }),
    ).rejects.toThrow(/malformed package resolution/);

    const duplicate = await workspaceFixture();
    await writeJson(join(duplicate, "package.json"), {
      name: "root",
      version: "1.0.0",
      packageManager: "bun@1.3.10",
      devDependencies: { vitest: "2.0.0" },
      workspaces: ["packages/*"],
    });
    const duplicateLock = JSON.parse(await readFile(join(duplicate, "bun.lock"), "utf8"));
    duplicateLock.workspaces[""].devDependencies = { vitest: "2.0.0" };
    await writeJson(join(duplicate, "bun.lock"), duplicateLock);
    await expect(
      inspectBunAuthority({
        root: duplicate,
        command: "bun --cwd packages/api run test",
        exactVersion: "1.3.10",
      }),
    ).rejects.toThrow(/lacks exact package resolution: vitest@2\.0\.0/);
  });

  it("builds a receipt-bound native plan with setup-only network and typed validation argv", async () => {
    const runtime = await runtimeFixture();
    const plan = await buildBunManagedExecutionPlan({
      receipt: runtime.receipt,
      storeRoot: runtime.root,
      privateRoot: "/tmp/factory-bun-private",
      commands: ["bun run test", "bun --cwd packages/api run check:types"],
    });
    expect(plan).toMatchObject({
      tool: "bun",
      bundleDigest: runtime.receipt.digest,
      executables: [{ id: "bun", kind: "native", argsPrefix: [] }],
      setup: [
        { executableId: "bun", args: ["--version"], network: "none" },
        {
          executableId: "bun",
          args: [
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--backend=copyfile",
            "--linker=isolated",
            "--registry=https://registry.npmjs.org/",
          ],
          network: "package-registry",
        },
      ],
      validation: [
        { executableId: "bun", args: ["run", "test"], network: "none" },
        {
          executableId: "bun",
          args: ["run", "check:types"],
          cwd: "packages/api",
          network: "none",
        },
      ],
      environment: {
        PATH: "/tmp/factory-bun-private/bin",
        HOME: "/tmp/factory-bun-private/home",
        BUN_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        NPM_CONFIG_USERCONFIG: "/dev/null",
      },
    });
    expect(Object.keys(plan.environment)).not.toContain("HTTP_PROXY");
    expect(plan.environment.PATH).toBeDefined();
    expect(plan.environment.PATH!.split(":")).not.toEqual(
      expect.arrayContaining(["/usr/bin", "/bin"]),
    );
    expect(plan.assets[0]).toMatchObject({
      id: "bun",
      archive: "zip",
      executablePath: "bun-linux-x64-baseline/bun",
    });
  });
});
