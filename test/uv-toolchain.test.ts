import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type RuntimeBundleReceipt,
  runtimeBundleDigest,
  sha256Bytes,
  sha256Tree,
  SUPPORTED_RUNTIME_PLATFORM,
} from "../src/runtime/toolchain-bundle.js";
import {
  buildUvManagedExecutionPlan,
  createUvManagedToolchainPlan,
  inspectUvAuthority,
  loadUvAuthoritySurface,
  parseUvPytestCommand,
  uvPytestOperation,
} from "../src/toolchains/uv.js";

const UV_VERSION = "0.12.12";
const PYTHON_VERSION = "3.13.15";
const HASH = `sha256:${"a".repeat(64)}`;

function rootPyproject(extra = ""): string {
  return `[project]
name = "safe-app"
requires-python = "==${PYTHON_VERSION}"
dependencies = ["anyio==4.11.0; python_version >= '3.13'"]

[tool.uv]
required-version = "==${UV_VERSION}"
package = false

[dependency-groups]
dev = ["pytest==8.4.2"]
${extra}`;
}

function wheelPackage(name: string, version: string): string {
  return `[[package]]
name = "${name}"
version = "${version}"
source = { registry = "https://pypi.org/simple" }
wheels = [
  { url = "https://files.pythonhosted.org/packages/${name}-${version}-py3-none-any.whl", hash = "${HASH}", size = 42 },
]
`;
}

function virtualPackage(name: string, path: string): string {
  return `[[package]]
name = "${name}"
version = "1.0.0"
source = { virtual = "${path}" }
`;
}

function lockfile(extra = ""): string {
  return `version = 1
revision = 3
requires-python = "==${PYTHON_VERSION}"

${wheelPackage("anyio", "4.11.0")}
${wheelPackage("pytest", "8.4.2")}
${extra}`;
}

function authorityInput(overrides: Partial<Parameters<typeof inspectUvAuthority>[0]> = {}) {
  return {
    command: parseUvPytestCommand("uv run --locked --no-sync python -m pytest")!,
    files: {
      "pyproject.toml": rootPyproject(),
      "uv.lock": lockfile(),
      ".python-version": `${PYTHON_VERSION}\n`,
    },
    repositoryPaths: ["pyproject.toml", "uv.lock", ".python-version", "src/app.py"],
    uvVersion: UV_VERSION,
    pythonVersion: PYTHON_VERSION,
    ...overrides,
  };
}

async function runtimeFixture(): Promise<{ receipt: RuntimeBundleReceipt; root: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "factory-uv-runtime-"));
  const specifications = [
    {
      id: "uv",
      version: UV_VERSION,
      executablePath: "uv-x86_64-unknown-linux-gnu/uv",
      executable: Buffer.from("managed uv executable"),
      asset: Buffer.from("managed uv archive"),
    },
    {
      id: "python",
      version: PYTHON_VERSION,
      executablePath: "python/bin/python3",
      executable: Buffer.from("managed python executable"),
      asset: Buffer.from("managed python archive"),
    },
  ] as const;
  const components = [];
  for (const specification of specifications) {
    const template = join(scratch, "template", specification.id, "root");
    const executable = join(template, ...specification.executablePath.split("/"));
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, specification.executable, { mode: 0o755 });
    components.push({
      id: specification.id,
      version: specification.version,
      release: {
        provider: "github" as const,
        repository: specification.id === "uv" ? "astral-sh/uv" : "astral-sh/uv-managed-python",
        releaseId: `${specification.id}-release`,
        tag: specification.version,
        publishedAt: "2026-09-10T00:00:00.000Z",
      },
      asset: {
        assetId: `${specification.id}-asset`,
        name: `${specification.id}.tar.gz`,
        url: `https://example.invalid/${specification.id}.tar.gz`,
        size: specification.asset.length,
        sha256: sha256Bytes(specification.asset),
        archive: "tar.gz" as const,
      },
      executablePath: specification.executablePath,
      executableSha256: sha256Bytes(specification.executable),
      treeSha256: await sha256Tree(template),
    });
  }
  const unsigned = {
    protocol: "clockgrove.factory/toolchain-runtime-bundle-v1" as const,
    tool: "uv" as const,
    adapter: "python-uv",
    adapterContract: 1,
    platform: SUPPORTED_RUNTIME_PLATFORM,
    components,
    resolvedAt: "2026-09-10T00:00:00.000Z",
  };
  const receipt: RuntimeBundleReceipt = { ...unsigned, digest: runtimeBundleDigest(unsigned) };
  for (const [index, specification] of specifications.entries()) {
    const componentRoot = join(scratch, "bundles", receipt.digest, specification.id);
    const executable = join(componentRoot, "root", ...specification.executablePath.split("/"));
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(join(componentRoot, "asset"), specification.asset);
    await writeFile(executable, specification.executable, { mode: 0o755 });
    expect(await sha256Tree(join(componentRoot, "root"))).toBe(components[index]!.treeSha256);
  }
  return { receipt, root: scratch };
}

describe("uv command authority", () => {
  it("parses only the canonical root and declared-workspace command shapes", () => {
    expect(parseUvPytestCommand("uv run --locked --no-sync python -m pytest")).toEqual({
      runner: "uv",
      projectDirectory: ".",
      argv: ["run", "--locked", "--no-sync", "python", "-m", "pytest"],
    });
    const workspace = parseUvPytestCommand(
      "uv run --project packages/api --locked --no-sync python -m pytest",
    );
    expect(workspace).toMatchObject({ projectDirectory: "packages/api" });
    expect(uvPytestOperation(workspace!)).toEqual({ kind: "python-test", key: "packages/api" });
    expect(uvPytestOperation({ ...workspace!, projectDirectory: "../outside" })).toBeNull();
  });

  it.each([
    "uv run python -m pytest",
    "uv run --no-sync --locked python -m pytest",
    "uv run --locked --no-sync pytest",
    "uv run --locked --no-sync python -m pytest tests/unit",
    "uv run --project ../escape --locked --no-sync python -m pytest",
    "uv run --project /tmp/project --locked --no-sync python -m pytest",
    "uv run --project packages/api;touch-x --locked --no-sync python -m pytest",
  ])("rejects non-canonical or escaping input: %s", (command) => {
    expect(parseUvPytestCommand(command)).toBeNull();
    expect(uvPytestOperation(command)).toBeNull();
  });
});

describe("uv structural authority", () => {
  it("accepts exact wheel-only root authority and records its bounded operation", () => {
    expect(inspectUvAuthority(authorityInput())).toEqual({
      adapter: "python-uv",
      operation: { kind: "python-test", key: "." },
      projectDirectory: ".",
      projectName: "safe-app",
      authorityPaths: ["pyproject.toml", "uv.lock", ".python-version"],
      uvVersion: UV_VERSION,
      pythonVersion: PYTHON_VERSION,
      dependencyGroups: ["dev"],
      lockedPackages: 2,
    });
  });

  it("normalizes dotted distribution names consistently with uv locks", () => {
    const files = {
      ...authorityInput().files,
      "pyproject.toml": rootPyproject().replace("anyio==4.11.0", "zope.interface==7.0"),
      "uv.lock": lockfile().replace(
        wheelPackage("anyio", "4.11.0"),
        wheelPackage("zope-interface", "7.0"),
      ),
    };
    expect(() => inspectUvAuthority(authorityInput({ files }))).not.toThrow();
  });

  it("requires an exact declared workspace member and inspects its pyproject", () => {
    const command = parseUvPytestCommand(
      "uv run --project packages/api --locked --no-sync python -m pytest",
    )!;
    const root = `[project]
name = "workspace-root"
requires-python = "==${PYTHON_VERSION}"
dependencies = []

[tool.uv]
required-version = "==${UV_VERSION}"
package = false

[dependency-groups]
dev = ["pytest==8.4.2"]

[tool.uv.workspace]
members = ["packages/api", "packages/shared"]
`;
    const member = `[project]
name = "api"
requires-python = "==${PYTHON_VERSION}"
dependencies = []

[tool.uv]
package = false

[dependency-groups]
dev = ["pytest==8.4.2"]
`;
    const shared = `[project]
name = "shared"
requires-python = "==${PYTHON_VERSION}"
dependencies = []

[tool.uv]
package = false
`;
    const files = {
      "pyproject.toml": root,
      "packages/api/pyproject.toml": member,
      "packages/shared/pyproject.toml": shared,
      "uv.lock": `version = 1\nrequires-python = "==${PYTHON_VERSION}"\n\n${virtualPackage("workspace-root", ".")}\n${virtualPackage("api", "packages/api")}\n${virtualPackage("shared", "packages/shared")}\n${wheelPackage("pytest", "8.4.2")}`,
      ".python-version": PYTHON_VERSION,
    };
    const repositoryPaths = [
      "pyproject.toml",
      "packages/api/pyproject.toml",
      "packages/shared/pyproject.toml",
      "uv.lock",
      ".python-version",
    ];
    const inspection = inspectUvAuthority({
      command,
      files,
      repositoryPaths,
      uvVersion: UV_VERSION,
      pythonVersion: PYTHON_VERSION,
    });
    expect(inspection.operation).toEqual({ kind: "python-test", key: "packages/api" });
    expect(inspection.authorityPaths).toEqual([
      "pyproject.toml",
      "uv.lock",
      ".python-version",
      "packages/api/pyproject.toml",
      "packages/shared/pyproject.toml",
    ]);
    expect(
      inspectUvAuthority({
        command: parseUvPytestCommand("uv run --locked --no-sync python -m pytest")!,
        files,
        repositoryPaths,
        uvVersion: UV_VERSION,
        pythonVersion: PYTHON_VERSION,
      }).operation,
    ).toEqual({ kind: "python-test", key: "." });

    expect(() =>
      inspectUvAuthority({
        command,
        files: {
          "pyproject.toml": root,
          "packages/api/pyproject.toml": member,
          "uv.lock": `version = 1\nrequires-python = "==${PYTHON_VERSION}"\n\n${wheelPackage("pytest", "8.4.2")}`,
          ".python-version": PYTHON_VERSION,
        },
        repositoryPaths: [
          "pyproject.toml",
          "packages/api/pyproject.toml",
          "uv.lock",
          ".python-version",
        ],
        uvVersion: UV_VERSION,
        pythonVersion: PYTHON_VERSION,
      }),
    ).toThrow(/workspace member is missing packages\/shared\/pyproject\.toml/);
  });

  it("rejects mixed managers, configuration, builds, custom sources, and escape", () => {
    expect(() =>
      inspectUvAuthority(
        authorityInput({ repositoryPaths: ["pyproject.toml", "package-lock.json"] }),
      ),
    ).toThrow(/mix package managers/);
    expect(() =>
      inspectUvAuthority(
        authorityInput({
          repositoryPaths: ["pyproject.toml", "uv.lock", ".python-version", "../pip.conf"],
        }),
      ),
    ).toThrow(/escapes authority/);
    expect(() =>
      inspectUvAuthority(
        authorityInput({
          files: {
            ...authorityInput().files,
            "pyproject.toml": `${rootPyproject()}\n[build-system]\nrequires = ["hatchling==1.0.0"]\n`,
          },
        }),
      ),
    ).toThrow(/build/);
    expect(() =>
      inspectUvAuthority(
        authorityInput({
          files: {
            ...authorityInput().files,
            "pyproject.toml": `${rootPyproject()}\n[tool.uv.sources]\nanyio = { git = "https://example.invalid/a" }\n`,
          },
        }),
      ),
    ).toThrow(/source surface/);
  });

  it("ignores unrelated polyglot authority outside the selected uv ancestry", () => {
    expect(() =>
      inspectUvAuthority(
        authorityInput({
          repositoryPaths: [
            ...authorityInput().repositoryPaths,
            "web/package-lock.json",
            "web/node_modules-link",
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("loads a bounded authority ancestry while rejecting selected-directory symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-uv-surface-"));
    await writeFile(join(root, "pyproject.toml"), rootPyproject());
    await writeFile(join(root, "uv.lock"), lockfile());
    await writeFile(join(root, ".python-version"), PYTHON_VERSION);
    await mkdir(join(root, "web"));
    await writeFile(join(root, "web", "package-lock.json"), "{}");
    await symlink("web", join(root, "unrelated-link"));
    const surface = await loadUvAuthoritySurface(root, ["."]);
    expect(surface.repositoryPaths).toContain("unrelated-link");
    expect(() => inspectUvAuthority({ ...authorityInput(), ...surface })).not.toThrow();

    const outside = await mkdtemp(join(tmpdir(), "factory-uv-outside-"));
    await writeFile(join(outside, "pyproject.toml"), rootPyproject());
    await writeFile(
      join(root, "pyproject.toml"),
      `${rootPyproject()}\n[tool.uv.workspace]\nmembers = ["packages/api"]\n`,
    );
    await mkdir(join(root, "packages"));
    await symlink(outside, join(root, "packages", "api"));
    await expect(loadUvAuthoritySurface(root, ["packages/api"])).rejects.toThrow(
      /ancestor is not a real directory/,
    );

    const workspace = await mkdtemp(join(tmpdir(), "factory-uv-complete-workspace-"));
    await mkdir(join(workspace, "packages/api"), { recursive: true });
    await mkdir(join(workspace, "packages/shared"), { recursive: true });
    await writeFile(
      join(workspace, "pyproject.toml"),
      `${rootPyproject()}\n[tool.uv.workspace]\nmembers = ["packages/api", "packages/shared"]\n`,
    );
    await writeFile(join(workspace, "uv.lock"), lockfile());
    await writeFile(join(workspace, ".python-version"), PYTHON_VERSION);
    await writeFile(join(workspace, "packages/api/pyproject.toml"), rootPyproject());
    await writeFile(join(workspace, "packages/shared/pyproject.toml"), rootPyproject());
    const workspaceSurface = await loadUvAuthoritySurface(workspace, ["packages/api"]);
    expect(Object.keys(workspaceSurface.files)).toEqual(
      expect.arrayContaining(["packages/api/pyproject.toml", "packages/shared/pyproject.toml"]),
    );
  });

  it("rejects imprecise versions, path dependencies, sdists, and unverified wheels", () => {
    const cases = [
      {
        files: { ...authorityInput().files, ".python-version": "3.13" },
        message: /\.python-version/,
      },
      {
        files: {
          ...authorityInput().files,
          "pyproject.toml": rootPyproject().replace(`==${UV_VERSION}`, ">=0.12"),
        },
        message: /exact managed uv/,
      },
      {
        files: {
          ...authorityInput().files,
          "pyproject.toml": rootPyproject().replace("anyio==4.11.0", "anyio @ ../anyio"),
        },
        message: /URL, VCS, path, or editable/,
      },
      {
        files: {
          ...authorityInput().files,
          "uv.lock": `${lockfile()}\nsdist = { hash = "${HASH}" }\n`,
        },
        message: /source distribution/,
      },
      {
        files: {
          ...authorityInput().files,
          "uv.lock": lockfile().replace(HASH, "sha256:deadbeef"),
        },
        message: /SHA-256/,
      },
      {
        files: {
          ...authorityInput().files,
          "uv.lock": lockfile().replace(
            "size = 42",
            'marker = "python_version; unsafe", size = 42',
          ),
        },
        message: /environment marker/,
      },
    ];
    for (const testCase of cases) {
      expect(() => inspectUvAuthority(authorityInput({ files: testCase.files }))).toThrow(
        testCase.message,
      );
    }
  });
});

describe("uv managed execution plan", () => {
  it("binds setup and validation to verified uv, Python, and venv executables", async () => {
    const runtime = await runtimeFixture();
    const privateRoot = join(runtime.root, "private");
    const plan = await buildUvManagedExecutionPlan({
      receipt: runtime.receipt,
      storeRoot: runtime.root,
      privateRoot,
      projectDirectory: "packages/api",
    });
    expect(plan).toMatchObject({
      adapter: "python-uv",
      receiptDigest: runtime.receipt.digest,
      uvVersion: UV_VERSION,
      pythonVersion: PYTHON_VERSION,
    });
    expect(plan.setup[2]).toMatchObject({
      executableId: "uv",
      network: "package-registry",
      args: [
        "sync",
        "--project",
        "packages/api",
        "--locked",
        "--no-build",
        "--no-cache",
        "--no-install-workspace",
        "--python",
        expect.stringMatching(/\/python\/root\/python\/bin\/python3$/),
        "--group",
        "dev",
      ],
    });
    expect(plan.validation).toEqual([
      {
        display: "python -m pytest",
        executableId: "venv-python",
        executable: join(privateRoot, "environment", "bin", "python"),
        args: ["-m", "pytest"],
        cwd: "packages/api",
        network: "none",
      },
    ]);
    expect(plan.environment).toMatchObject({
      HOME: join(privateRoot, "home"),
      PATH: join(privateRoot, "bin"),
      PIP_CONFIG_FILE: "/dev/null",
      PYTHONNOUSERSITE: "1",
      UV_INDEX_URL: "https://pypi.org/simple",
      UV_NO_CONFIG: "1",
      UV_NO_ENV_FILE: "1",
      UV_PYTHON_DOWNLOADS: "never",
      UV_PROJECT_ENVIRONMENT: join(privateRoot, "environment"),
    });
    expect(Object.keys(plan.environment).some((key) => key === "VIRTUAL_ENV")).toBe(false);
    expect(plan.validation[0]!.executable).not.toBe(plan.setup[1]!.executable);

    const isolated = createUvManagedToolchainPlan({
      receipt: runtime.receipt,
      privateRoot: "/tmp/factory-toolchain",
      commands: ["uv run --project packages/api --locked --no-sync python -m pytest"],
      assets: runtime.receipt.components.map((component) => ({
        id: component.id,
        path: `toolchains/${component.id}.asset`,
        content: Buffer.from("fixture"),
        sha256: component.asset.sha256,
        archive: component.asset.archive,
        executablePath: component.executablePath,
        executableSha256: component.executableSha256,
        treeSha256: component.treeSha256,
      })),
    });
    expect(isolated.executables.find(({ id }) => id === "venv-python")).toMatchObject({
      kind: "generated",
      generatedFrom: "python",
      relativePath: "/tmp/factory-toolchain/environment/bin/python",
    });
  });

  it("rejects a tampered receipt before resolving commands", async () => {
    const runtime = await runtimeFixture();
    await expect(
      buildUvManagedExecutionPlan({
        receipt: { ...runtime.receipt, digest: "f".repeat(64) },
        storeRoot: runtime.root,
        privateRoot: join(runtime.root, "private"),
      }),
    ).rejects.toThrow(/receipt digest mismatch/);
  });
});
