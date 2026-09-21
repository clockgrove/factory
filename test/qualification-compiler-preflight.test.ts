import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installedCompilerPreflight,
  installedLocalScopePreflight,
  qualificationRuntimeEnvironment,
} from "../scripts/qualification-install-identity.mjs";

const baseSha = "a".repeat(40);
const digest = "b".repeat(64);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function execution(report: unknown, status: number) {
  return {
    pid: 10,
    output: [],
    stdout: `${JSON.stringify(report)}\n`,
    stderr: "",
    status,
    signal: null,
  };
}

function report(result: "passed" | "blocked") {
  return {
    result,
    baseSha,
    pinnedFactsDigest: digest,
    validationRecipeCount: result === "passed" ? 1 : 0,
    eligibleDeferredAdapters: [],
    toolchains: [],
    validation: {
      protocol: "clockgrove.factory/compiler-validation",
      phase: "request",
      status: result === "passed" ? "valid" : "unsatisfiable",
      violations:
        result === "passed"
          ? []
          : [
              {
                code: "partial-toolchain-authority",
                itemId: null,
                field: "/repository/toolchains",
                expected: "observed or wholly absent authority",
                observed: "node-npm",
              },
            ],
    },
    execution: {
      protocol: "clockgrove.factory/execution-route-preflight",
      result: "passed",
      required: null,
      routes: [],
    },
  };
}

function executionRouteReport(
  trust: "trusted_local" | "isolated" | "managed",
  result: "passed" | "blocked",
) {
  return {
    ...report("passed"),
    result,
    execution: {
      protocol: "clockgrove.factory/execution-route-preflight",
      result,
      required: {
        trust,
        minimumIsolation:
          trust === "isolated" ? "container" : trust === "managed" ? "managed" : "none",
      },
      routes: [
        {
          id: "codex-app-server/local-worktree",
          runtimeKind: "codex-app-server",
          hostExecution: true,
          isolation: "process",
          compatible: result === "passed",
          reasons: result === "passed" ? [] : ["requires container-or-stronger isolation"],
        },
      ],
    },
  };
}

describe("installed compiler qualification boundary", () => {
  it.each([
    ["passed" as const, 0],
    ["blocked" as const, 2],
  ])("returns a structured %s report from the exact retained CLI", (result, status) => {
    const execute = vi.fn(() => execution(report(result), status));
    expect(
      installedCompilerPreflight(
        {
          factoryCli: "/installed/factory.js",
          checkout: "/home/example/repository",
          baseSha,
          policy: { allowedNetworkDestinations: ["registry.npmjs.org"] },
          environment: { PATH: "/usr/bin:/bin" },
        },
        execute,
      ),
    ).toMatchObject({ result, baseSha });
    expect(execute).toHaveBeenCalledWith(
      "/installed/factory.js",
      [
        "compiler-preflight",
        "--repo",
        "/home/example/repository",
        "--base-sha",
        baseSha,
        "--policy",
        "-",
      ],
      expect.objectContaining({
        cwd: "/home/example/repository",
        input: expect.stringContaining("registry.npmjs.org"),
      }),
    );
  });

  it("rejects a CLI exit/result disagreement", () => {
    expect(() =>
      installedCompilerPreflight(
        {
          factoryCli: "/installed/factory.js",
          checkout: "/home/example/repository",
          baseSha,
          policy: {},
        },
        () => execution(report("blocked"), 0),
      ),
    ).toThrow();
  });

  it.each([
    ["trusted_local" as const, "passed" as const, 0],
    ["isolated" as const, "blocked" as const, 2],
  ])("binds %s trust to the installed route preflight", (trust, result, status) => {
    const execute = vi.fn(() => execution(executionRouteReport(trust, result), status));
    expect(
      installedCompilerPreflight(
        {
          factoryCli: "/installed/factory.js",
          checkout: "/home/example/repository",
          baseSha,
          executionTrust: trust,
        },
        execute,
      ),
    ).toMatchObject({ result, execution: { required: { trust } } });
    expect(execute).toHaveBeenCalledWith(
      "/installed/factory.js",
      [
        "compiler-preflight",
        "--repo",
        "/home/example/repository",
        "--base-sha",
        baseSha,
        "--execution-trust",
        trust,
      ],
      expect.anything(),
    );
  });

  it("uses the retained CLI default without a policy option or stdin", () => {
    const execute = vi.fn(() => execution(report("passed"), 0));
    expect(
      installedCompilerPreflight(
        {
          factoryCli: "/installed/factory.js",
          checkout: "/home/example/repository",
          baseSha,
          environment: { PATH: "/usr/bin:/bin" },
        },
        execute,
      ),
    ).toMatchObject({ result: "passed", baseSha });
    expect(execute).toHaveBeenCalledWith(
      "/installed/factory.js",
      ["compiler-preflight", "--repo", "/home/example/repository", "--base-sha", baseSha],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect((execute.mock.calls[0] as unknown[])[2]).not.toHaveProperty("input");
  });

  it("propagates through the shared live and checkpoint bases and the standalone fault base", () => {
    for (const path of [
      "scripts/verify-live-objective.mjs",
      "scripts/verify-local-checkpoint-restart.mjs",
      "scripts/verify-local-faults.mjs",
    ])
      expect(readFileSync(resolve(path), "utf8"), path).toContain("installedCompilerPreflight");

    const routes = {
      "scripts/verify-regular-objective.mjs": "main as installedMain",
      "scripts/verify-native-linear-objective.mjs": "main as installedMain",
      "scripts/verify-provider-objective.mjs": "main as runInstalledObjective",
      "scripts/verify-local-concurrency.mjs": "main as checkpointMain",
      "scripts/verify-local-failure-conflict.mjs": "main as checkpointMain",
      "scripts/verify-local-large-files.mjs": "main as checkpointMain",
      "scripts/verify-compiler-qualification-checkpoints.mjs": "main as checkpointMain",
    };
    for (const [path, inheritedBoundary] of Object.entries(routes))
      expect(readFileSync(resolve(path), "utf8"), path).toContain(inheritedBoundary);
  });
});

describe("installed local-scope qualification boundary", () => {
  const capability = (result: "passed" | "blocked") => ({
    protocol: "clockgrove.factory/local-scope-preflight-v1",
    result,
    capability: "durable-local-scopes",
    ...(result === "blocked"
      ? {
          blocker: "durable-local-scopes-unavailable",
          reason:
            "durable local-scope qualification requires systemd and a reachable user systemd manager",
        }
      : {}),
  });

  it.each([
    ["passed" as const, 0],
    ["blocked" as const, 2],
  ])("returns the exact retained CLI %s report", (result, status) => {
    const execute = vi.fn(() => execution(capability(result), status));

    expect(
      installedLocalScopePreflight(
        {
          factoryCli: "/installed/factory.js",
          checkout: "/home/example/repository",
          environment: { PATH: "/usr/bin:/bin" },
        },
        execute,
      ),
    ).toMatchObject({ result, capability: "durable-local-scopes" });
    expect(execute).toHaveBeenCalledWith(
      "/installed/factory.js",
      ["local-scope-preflight"],
      expect.objectContaining({
        cwd: "/home/example/repository",
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("carries the derived user runtime directory into the retained CLI process", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-local-scope-environment-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const checkout = join(root, "repository");
    const factoryCli = join(root, "factory");
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    mkdirSync(checkout, { mode: 0o700 });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("effective Linux uid unavailable");
    writeFileSync(
      factoryCli,
      [
        "#!/bin/sh",
        'test "$1" = local-scope-preflight || exit 64',
        `test "$XDG_RUNTIME_DIR" = /run/user/${uid} || exit 65`,
        `printf '%s\\n' '${JSON.stringify(capability("passed"))}'`,
      ].join("\n"),
    );
    chmodSync(factoryCli, 0o700);

    const environment = qualificationRuntimeEnvironment(
      {
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: join(root, "ambient-substitution"),
      },
      { linuxHome: home, uid },
    );

    expect(installedLocalScopePreflight({ factoryCli, checkout, environment })).toMatchObject({
      result: "passed",
      capability: "durable-local-scopes",
    });
  });

  it("rejects a CLI exit/result disagreement", () => {
    expect(() =>
      installedLocalScopePreflight(
        {
          factoryCli: "/installed/factory.js",
          checkout: "/home/example/repository",
        },
        () => execution(capability("blocked"), 0),
      ),
    ).toThrow();
  });
});
