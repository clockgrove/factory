import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkerPacket } from "../src/protocol/worker-packet.js";

const receipts = vi.hoisted(() => ({
  bun: {
    tool: "bun",
    adapter: "javascript-bun",
    digest: "b".repeat(64),
    components: [{ id: "bun", version: "1.3.10" }],
  },
  uv: {
    tool: "uv",
    adapter: "python-uv",
    digest: "d".repeat(64),
    components: [
      { id: "uv", version: "0.12.12" },
      { id: "python", version: "3.14.7" },
    ],
  },
}));

vi.mock("../src/runtime/toolchain-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/toolchain-store.js")>()),
  runtimeBundleByDigestSync: (tool: string) => receipts[tool as keyof typeof receipts],
}));

import { assertBunOrUvValidation } from "../src/validation/clean-run.js";

const writeJson = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

describe("managed adapter clean validation", () => {
  it("inspects every Bun operation promised to descendants before provider publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-bun-clean-"));
    await mkdir(join(root, "packages/api"), { recursive: true });
    await writeJson(join(root, "package.json"), {
      name: "root",
      version: "1.0.0",
      packageManager: "bun@1.3.10",
      scripts: { test: "bun test" },
      workspaces: ["packages/*"],
    });
    await writeJson(join(root, "packages/api/package.json"), {
      name: "api",
      version: "1.0.0",
      scripts: {},
    });
    await writeJson(join(root, "bun.lock"), {
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        "": { name: "root" },
        "packages/api": { name: "api" },
      },
      packages: {},
    });
    const packet: WorkerPacket = {
      goal: "Establish Bun validation.",
      acceptanceCriteria: ["Bun validation is finite."],
      allowedPaths: ["package.json", "bun.lock", "packages/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: "a".repeat(40),
      validationCommands: ["bun run test"],
      requirements: {
        os: ["linux"],
        architecture: ["x64"],
        tools: ["bun"],
        services: [],
        networkDestinations: ["registry.npmjs.org"],
        permittedSecretNames: [],
        trust: "isolated",
      },
      repositoryCapabilities: {
        requires: [],
        provides: [
          {
            adapter: "javascript-bun",
            generation: "javascript-bun/provider",
            authorityPaths: ["package.json", "bun.lock"],
            operations: [
              { kind: "package-script", key: "test" },
              { kind: "package-script", key: "packages/api:check" },
            ],
          },
        ],
      },
      managedRuntimes: [
        {
          tool: "bun",
          adapter: "javascript-bun",
          adapterContract: 1,
          platform: { os: "linux", architecture: "x64", libc: "glibc" },
          releaseChannel: "ga",
          bundleDigest: receipts.bun.digest,
        },
      ],
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const artifact = {
      protocol: "clockgrove.factory/artifact-v1" as const,
      baseSha: packet.baseSha,
      patch: "",
      changedPaths: [],
      commands: [],
      logs: "",
      outcome: "succeeded" as const,
      digest: "c".repeat(64),
      createdAt: "2026-09-10T00:00:00.000Z",
    };
    await expect(
      assertBunOrUvValidation({ path: root }, artifact, packet, packet.validationCommands),
    ).rejects.toThrow(/validation script is absent: check/);

    await writeJson(join(root, "packages/api/package.json"), {
      name: "api",
      version: "1.0.0",
      scripts: { check: "bun test" },
    });
    await expect(
      assertBunOrUvValidation({ path: root }, artifact, packet, packet.validationCommands),
    ).resolves.toMatchObject({ manager: "bun", expectedVersion: "1.3.10" });
    await expect(
      assertBunOrUvValidation(
        { path: root },
        { ...artifact, changedPaths: ["package.json"] },
        packet,
        packet.validationCommands,
        new Map([
          [
            "package.json",
            {
              name: "root",
              version: "1.0.0",
              packageManager: "bun@1.3.10",
              scripts: { test: "bun test --timeout 1000" },
              workspaces: ["packages/*"],
            },
          ],
        ]),
      ),
    ).resolves.toMatchObject({ changedOperations: new Set(["test"]) });
  });

  it("inspects every uv project operation promised to descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-uv-clean-"));
    await mkdir(join(root, "packages/api"), { recursive: true });
    await mkdir(join(root, "packages/cli"), { recursive: true });
    const rootProject = `[project]
name = "root"

[tool.uv]
required-version = "==0.12.12"
package = false

[tool.uv.workspace]
members = ["packages/api", "packages/cli"]
`;
    const memberProject = (name: string) => `[project]
name = "${name}"
requires-python = "==3.14.7"
dependencies = []

[tool.uv]
package = false

[dependency-groups]
dev = ["pytest==8.4.2"]
`;
    const lock = `version = 1
requires-python = "==3.14.7"

[[package]]
name = "pytest"
version = "8.4.2"
source = { registry = "https://pypi.org/simple" }
wheels = [
  { url = "https://files.pythonhosted.org/pytest.whl", hash = "sha256:${"a".repeat(64)}" },
]
`;
    await writeFile(join(root, "pyproject.toml"), rootProject);
    await writeFile(join(root, "packages/api/pyproject.toml"), memberProject("api"));
    await writeFile(join(root, "uv.lock"), lock);
    await writeFile(join(root, ".python-version"), "3.14.7\n");
    const packet: WorkerPacket = {
      goal: "Establish uv validation.",
      acceptanceCriteria: ["uv validation is finite."],
      allowedPaths: ["pyproject.toml", "uv.lock", ".python-version", "packages/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: "a".repeat(40),
      validationCommands: ["uv run --project packages/api --locked --no-sync python -m pytest"],
      requirements: {
        os: ["linux"],
        architecture: ["x64"],
        tools: ["uv"],
        services: [],
        networkDestinations: ["pypi.org", "files.pythonhosted.org"],
        permittedSecretNames: [],
        trust: "isolated",
      },
      repositoryCapabilities: {
        requires: [],
        provides: [
          {
            adapter: "python-uv",
            generation: "python-uv/provider",
            authorityPaths: ["pyproject.toml", "uv.lock", ".python-version"],
            operations: [
              { kind: "python-test", key: "packages/api" },
              { kind: "python-test", key: "packages/cli" },
            ],
          },
        ],
      },
      managedRuntimes: [
        {
          tool: "uv",
          adapter: "python-uv",
          adapterContract: 1,
          platform: { os: "linux", architecture: "x64", libc: "glibc" },
          releaseChannel: "ga",
          bundleDigest: receipts.uv.digest,
        },
      ],
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const artifact = {
      protocol: "clockgrove.factory/artifact-v1" as const,
      baseSha: packet.baseSha,
      patch: "",
      changedPaths: [],
      commands: [],
      logs: "",
      outcome: "succeeded" as const,
      digest: "e".repeat(64),
      createdAt: "2026-09-10T00:00:00.000Z",
    };
    await expect(
      assertBunOrUvValidation({ path: root }, artifact, packet, packet.validationCommands),
    ).rejects.toThrow(/packages\/cli\/pyproject\.toml|ENOENT/);
    await writeFile(join(root, "packages/cli/pyproject.toml"), memberProject("cli"));
    await expect(
      assertBunOrUvValidation({ path: root }, artifact, packet, packet.validationCommands),
    ).resolves.toMatchObject({ manager: "uv", expectedVersion: "0.12.12/Python 3.14.7" });
  });
});
