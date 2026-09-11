import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNpmManagedToolchainPlan,
  findNestedNpmRoots,
  inspectNpmAuthority,
  npmCapabilityOperation,
  npmEnvironment,
  npmValidationCommandForOperation,
  parseNpmValidationCommand,
} from "../src/toolchains/npm.js";
import {
  runtimeBundleDigest,
  sha256Bytes,
  SUPPORTED_RUNTIME_PLATFORM,
  type RuntimeBundleReceipt,
} from "../src/runtime/toolchain-bundle.js";

const NODE_VERSION = "24.8.0";
const NPM_VERSION = "11.6.0";
const roots: string[] = [];

async function fixture(options: { workspace?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-npm-adapter-"));
  roots.push(root);
  const manifest = {
    name: "fixture-app",
    version: "1.0.0",
    private: true,
    packageManager: `npm@${NPM_VERSION}`,
    devEngines: {
      runtime: { name: "node", version: NODE_VERSION, onFail: "error" },
      packageManager: { name: "npm", version: NPM_VERSION, onFail: "error" },
    },
    ...(options.workspace ? { workspaces: ["packages/api"] } : {}),
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "1.0.0" },
  };
  const packages: Record<string, unknown> = {
    "": {
      name: manifest.name,
      version: manifest.version,
      devDependencies: manifest.devDependencies,
    },
    "node_modules/vitest": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/vitest/-/vitest-1.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      bin: { vitest: "vitest.mjs" },
    },
  };
  if (options.workspace) {
    await mkdir(join(root, "packages/api"), { recursive: true });
    await writeFile(
      join(root, "packages/api/package.json"),
      JSON.stringify({ name: "fixture-api", version: "1.0.0", scripts: { test: "node --test" } }),
    );
    // npm 11 omits the member name here and binds it through the canonical
    // node_modules/fixture-api workspace link below.
    packages["packages/api"] = { version: "1.0.0" };
    packages["node_modules/fixture-api"] = { link: true, resolved: "packages/api" };
  }
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("npm deferred toolchain authority", () => {
  it("parses only canonical root and exact-workspace operations", () => {
    expect(parseNpmValidationCommand("npm run test")).toEqual({ workspace: ".", script: "test" });
    expect(parseNpmValidationCommand("npm run test --workspace=packages/api")).toEqual({
      workspace: "packages/api",
      script: "test",
    });
    expect(npmCapabilityOperation("npm run test --workspace=packages/api")).toEqual({
      kind: "package-script",
      key: "12:packages/api:test",
    });
    expect(
      npmValidationCommandForOperation({ kind: "package-script", key: "12:packages/api:test" }),
    ).toEqual({ workspace: "packages/api", script: "test" });
    expect(npmCapabilityOperation("npm run test:unit --workspace=packages/api")).toEqual({
      kind: "package-script",
      key: "12:packages/api:test:unit",
    });
    expect(
      npmValidationCommandForOperation({
        kind: "package-script",
        key: "12:packages/api:test:unit",
      }),
    ).toEqual({ workspace: "packages/api", script: "test:unit" });
    expect(npmCapabilityOperation("npm run test:unit")).toEqual({
      kind: "package-script",
      key: "1:.:test:unit",
    });
    expect(
      npmValidationCommandForOperation({ kind: "package-script", key: "1:.:test:unit" }),
    ).toEqual({ workspace: ".", script: "test:unit" });
    expect(
      npmValidationCommandForOperation({ kind: "package-script", key: "packages/api:test:unit" }),
    ).toBeNull();
    for (const command of [
      "npm test",
      "npm run test -- --watch",
      "npm run test -w packages/api",
      "npm exec vitest",
      "npx vitest",
      "npm run start",
      "npm run test --workspace=../api",
    ])
      expect(parseNpmValidationCommand(command), command).toBeNull();
  });

  it("accepts an exact lock-v3 root and enumerated workspace", async () => {
    const root = await fixture({ workspace: true });
    const inspection = await inspectNpmAuthority({
      root,
      commands: [
        { workspace: ".", script: "test" },
        { workspace: "packages/api", script: "test" },
      ],
      nodeVersion: NODE_VERSION,
      npmVersion: NPM_VERSION,
    });
    expect(inspection.authorityPaths).toEqual([
      "package-lock.json",
      "package.json",
      "packages/api/package.json",
    ]);
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["packages/api"].name = "wrong-api";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: "packages/api", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/lock descriptor differs/);
    expect(await findNestedNpmRoots(root, ["packages/api"])).toEqual([]);
  });

  it("layers root binaries beneath nearer workspace providers", async () => {
    const root = await fixture({ workspace: true });
    const memberPath = join(root, "packages/api/package.json");
    const member = JSON.parse(await readFile(memberPath, "utf8"));
    member.scripts.test = "vitest run";
    await writeFile(memberPath, JSON.stringify(member));

    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: "packages/api", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).resolves.toBeDefined();

    member.devDependencies = { "workspace-runner": "1.0.0" };
    await writeFile(memberPath, JSON.stringify(member));
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["packages/api"].devDependencies = member.devDependencies;
    lock.packages["packages/api/node_modules/workspace-runner"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/workspace-runner/-/workspace-runner-1.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      bin: { "workspace-runner": "bin.js" },
    };
    await writeFile(lockPath, JSON.stringify(lock));

    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: "packages/api", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).resolves.toBeDefined();

    lock.packages["packages/api/node_modules/workspace-runner"].bin = { vitest: "bin.js" };
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: "packages/api", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects runtime drift, lifecycle authority, exotic sources, and nested roots", async () => {
    const root = await fixture();
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: "24.8.1",
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/runtime|devEngines/);

    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    manifest.scripts.pretest = "node --test";
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/lifecycle/);

    delete manifest.scripts.pretest;
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["node_modules/vitest"].resolved = "https://example.com/vitest.tgz";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/canonical registry/);

    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/package.json"), "{}");
    expect(await findNestedNpmRoots(root, [])).toEqual(["nested/package.json"]);
  });

  it("rejects script escapes, runtime-shadowing bins, and non-resolving lock edges", async () => {
    for (const body of ["node --test /tmp/host.js", "node --test ../../host.js"]) {
      const root = await fixture();
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      manifest.scripts.test = body;
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      await expect(
        inspectNpmAuthority({
          root,
          commands: [{ workspace: ".", script: "test" }],
          nodeVersion: NODE_VERSION,
          npmVersion: NPM_VERSION,
        }),
      ).rejects.toThrow(/allowlist|escapes/);
    }

    const shadowRoot = await fixture();
    const shadowLockPath = join(shadowRoot, "package-lock.json");
    const shadowLock = JSON.parse(await readFile(shadowLockPath, "utf8"));
    shadowLock.packages["node_modules/vitest"].bin.node = "vitest.mjs";
    await writeFile(shadowLockPath, JSON.stringify(shadowLock));
    await expect(
      inspectNpmAuthority({
        root: shadowRoot,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/bin node.*reserved/);

    const closureRoot = await fixture();
    const closureLockPath = join(closureRoot, "package-lock.json");
    const closureLock = JSON.parse(await readFile(closureLockPath, "utf8"));
    closureLock.packages["node_modules/vitest"].dependencies = { dep: "^1.0.0" };
    closureLock.packages["node_modules/other/node_modules/dep"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
    };
    await writeFile(closureLockPath, JSON.stringify(closureLock));
    await expect(
      inspectNpmAuthority({
        root: closureRoot,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/installed ancestor|closure.*dep/);
  });

  it("accepts canonical prerelease ranges and traverses omitted optional subgraphs", async () => {
    const root = await fixture();
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["node_modules/vitest"].dependencies = { "std-env": "^4.0.0-rc.1" };
    lock.packages["node_modules/vitest"].optionalDependencies = { fsevents: "^2.3.0" };
    lock.packages["node_modules/std-env"] = {
      version: "4.0.0",
      resolved: "https://registry.npmjs.org/std-env/-/std-env-4.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
    };
    lock.packages["node_modules/fsevents"] = {
      version: "2.3.3",
      resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      optional: true,
      os: ["darwin"],
      dependencies: { child: "^1.0.0" },
    };
    lock.packages["node_modules/fsevents/node_modules/child"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/child/-/child-1.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
    };
    await writeFile(lockPath, JSON.stringify(lock));

    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).resolves.toBeDefined();

    lock.packages["node_modules/std-env"].version = "4.1.0-rc.1";
    lock.packages["node_modules/std-env"].resolved =
      "https://registry.npmjs.org/std-env/-/std-env-4.1.0-rc.1.tgz";
    lock.packages["node_modules/vitest"].dependencies["std-env"] = "^4.0.0";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/does not satisfy/);

    lock.packages["node_modules/std-env"].version = "4.0.0";
    lock.packages["node_modules/std-env"].resolved =
      "https://registry.npmjs.org/std-env/-/std-env-4.0.0.tgz";
    lock.packages["node_modules/vitest"].dependencies["std-env"] =
      "https://example.com/std-env.tgz";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/does not satisfy/);
  });

  it("allows the same binary name in separate npm resolution scopes", async () => {
    const root = await fixture();
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.devDependencies = {
      ...manifest.devDependencies,
      parent: "1.0.0",
      runner: "1.0.0",
    };
    await writeFile(manifestPath, JSON.stringify(manifest));

    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages[""].devDependencies = manifest.devDependencies;
    lock.packages["node_modules/parent"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/parent/-/parent-1.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      dependencies: { runner: "2.0.0" },
    };
    lock.packages["node_modules/runner"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/runner/-/runner-1.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      bin: { runner: "bin.js" },
    };
    lock.packages["node_modules/parent/node_modules/runner"] = {
      version: "2.0.0",
      resolved: "https://registry.npmjs.org/runner/-/runner-2.0.0.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      bin: { runner: "bin.js" },
    };
    await writeFile(lockPath, JSON.stringify(lock));

    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: ".", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a workspace reached through an intermediate symlink", async () => {
    const root = await fixture({ workspace: true });
    await mkdir(join(root, "actual-packages/api"), { recursive: true });
    await writeFile(
      join(root, "actual-packages/api/package.json"),
      await readFile(join(root, "packages/api/package.json"), "utf8"),
    );
    await rm(join(root, "packages"), { recursive: true });
    await symlink("actual-packages", join(root, "packages"));
    await expect(
      inspectNpmAuthority({
        root,
        commands: [{ workspace: "packages/api", script: "test" }],
        nodeVersion: NODE_VERSION,
        npmVersion: NPM_VERSION,
      }),
    ).rejects.toThrow(/symlink/);
  });

  it("builds a private npm environment without ambient interpreter or config authority", () => {
    const environment = npmEnvironment("/private/npm");
    expect(environment).toMatchObject({
      PATH: "/private/npm/bin",
      HOME: "/private/npm/home",
      NODE_ENV: "",
      NODE_OPTIONS: "",
      NODE_PATH: "",
      NPM_CONFIG_USERCONFIG: "/dev/null",
      npm_config_cache: "/private/npm/cache",
      npm_config_ignore_scripts: "true",
      npm_config_registry: "https://registry.npmjs.org/",
    });
    expect(environment.PATH).not.toMatch(/(?:^|:)(?:\/usr\/bin|\/bin)(?::|$)/);
  });

  it("builds an exact interpreted plan and a root-compatible deterministic install", () => {
    const nodeBytes = Buffer.from("managed node");
    const npmBytes = Buffer.from("managed npm cli");
    const archive = Buffer.from("official node archive");
    const component = {
      id: "npm",
      version: NODE_VERSION,
      release: {
        provider: "nodejs" as const,
        repository: "nodejs/node",
        releaseId: `v${NODE_VERSION}`,
        tag: `v${NODE_VERSION}`,
        publishedAt: "2026-09-10T00:00:00.000Z",
        channel: "lts:Krypton",
      },
      asset: {
        assetId: "node-archive",
        name: "node.tar.xz",
        url: "https://nodejs.org/dist/node.tar.xz",
        size: archive.length,
        sha256: sha256Bytes(archive),
        archive: "tar.xz" as const,
      },
      executablePath: "node/bin/node",
      executableSha256: sha256Bytes(nodeBytes),
      treeSha256: "a".repeat(64),
      entrypoints: [
        {
          id: "node",
          version: NODE_VERSION,
          path: "node/bin/node",
          sha256: sha256Bytes(nodeBytes),
        },
        {
          id: "npm",
          version: NPM_VERSION,
          path: "node/lib/node_modules/npm/bin/npm-cli.js",
          sha256: sha256Bytes(npmBytes),
          interpreter: "node",
        },
      ],
    };
    const unsigned = {
      protocol: "clockgrove.factory/toolchain-runtime-bundle-v1" as const,
      tool: "npm" as const,
      adapter: "node-npm",
      adapterContract: 1,
      platform: SUPPORTED_RUNTIME_PLATFORM,
      components: [component],
      resolvedAt: "2026-09-10T00:00:00.000Z",
    };
    const receipt: RuntimeBundleReceipt = {
      ...unsigned,
      digest: runtimeBundleDigest(unsigned),
    };
    const plan = createNpmManagedToolchainPlan({
      receipt,
      assets: [
        {
          id: "npm",
          path: "/private/node.tar.xz",
          content: archive,
          sha256: sha256Bytes(archive),
          archive: "tar.xz",
          executablePath: component.executablePath,
          executableSha256: component.executableSha256,
          treeSha256: component.treeSha256,
          entrypoints: component.entrypoints,
        },
      ],
      commands: ["npm run test"],
    });
    expect(plan.executables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "node", kind: "native", entrypointId: "node" }),
        expect.objectContaining({
          id: "npm",
          kind: "interpreted",
          entrypointId: "npm",
          interpreterId: "node",
        }),
      ]),
    );
    const install = plan.setup.at(-1)!;
    expect(install.args).toContain("--include-workspace-root=true");
    expect(install.args).toEqual(
      expect.arrayContaining(["--include=dev", "--include=optional", "--include=peer"]),
    );
    expect(install.args).not.toContain("--workspaces");
    expect(plan.validation[0]).toMatchObject({ executableId: "npm", args: ["run", "test"] });
  });
});
