import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyQuotaStopRequest,
  installQuotaStopFetchInterceptor,
  quotaStopTargetMatch,
  type QuotaStopArm,
} from "../scripts/qualification-controller-quota-stop.mjs";
import {
  assertUnmodifiedInstalledGeneration,
  parseSelectedManagerEnvironment,
  qualificationManagerEnvironment,
  runInstalledQuotaStopScenario,
} from "../scripts/verify-installed-controller-quota-stop.mjs";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((path) => rm(path, { force: true })));
  cleanup.clear();
});

async function waitForJson(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        error instanceof SyntaxError === false
      )
        throw error;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function fixtureArm(overrides: Partial<QuotaStopArm> = {}): QuotaStopArm {
  return {
    nodeExecutable: process.execPath,
    factoryCli: "/opt/clockgrove/factory/dist/factory.js",
    repository: "private-owner/private-repository",
    checkout: "/home/example/project",
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    unit: "clockgrove-factory-1234567890abcdef.service",
    ...overrides,
  };
}

function fixtureArgv(arm: QuotaStopArm): string[] {
  return [
    arm.nodeExecutable,
    arm.factoryCli,
    "controller",
    "run",
    arm.repository,
    "--repo",
    arm.checkout,
    "--executable-identity",
    arm.artifactIdentity,
  ];
}

describe("installed controller quota-stop harness", () => {
  it("is inert without an explicit owner-private arm", () => {
    const before = globalThis.fetch;
    expect(installQuotaStopFetchInterceptor({})).toBe(false);
    expect(globalThis.fetch).toBe(before);
  });

  it("admits only the exact read-only REST repository-facts request", () => {
    expect(
      classifyQuotaStopRequest(
        "https://api.github.com/repos/private-owner/private-repository",
        undefined,
        "private-owner/private-repository",
      ),
    ).toEqual({
      method: "GET",
      route: "repository",
      operation: "repository-facts-rest-read",
    });
    for (const request of [
      ["https://api.github.com/graphql", { method: "POST" }],
      ["https://api.github.com/repos/private-owner/another-repository", undefined],
      ["https://api.github.com/repos/private-owner/private-repository?x=1", undefined],
    ] as const) {
      expect(() =>
        classifyQuotaStopRequest(request[0], request[1], "private-owner/private-repository"),
      ).toThrow();
    }
  });

  it("uses a whitespace-free file URL in the temporary manager environment", () => {
    const values = qualificationManagerEnvironment(
      "/home/example/source path/preload.mjs",
      "/run/user/1000/.fixture.arm.json",
    );
    expect(values).toEqual({
      NODE_OPTIONS: "--import=file:///home/example/source%20path/preload.mjs",
      FACTORY_INSTALLED_QUOTA_STOP_ARM: "/run/user/1000/.fixture.arm.json",
    });
    expect(values.NODE_OPTIONS).not.toMatch(/\s/);
    expect(
      parseSelectedManagerEnvironment(
        `PATH=/usr/bin\nNODE_OPTIONS=${values.NODE_OPTIONS}\nFACTORY_INSTALLED_QUOTA_STOP_ARM=${values.FACTORY_INSTALLED_QUOTA_STOP_ARM}\n`,
      ),
    ).toEqual(values);
  });

  it("requires the production unit generation with no drop-in", () => {
    const manager = {
      LoadState: "loaded",
      FragmentPath: "/home/example/.config/systemd/user/factory.service",
      DropInPaths: "",
      NeedDaemonReload: "no",
    };
    expect(() => assertUnmodifiedInstalledGeneration(manager, manager.FragmentPath)).not.toThrow();
    expect(() =>
      assertUnmodifiedInstalledGeneration(
        { ...manager, DropInPaths: "/home/example/factory.service.d/test" },
        manager.FragmentPath,
      ),
    ).toThrow();
  });

  it("is inert for unrelated Node argv and fails closed for a near-match controller", () => {
    const arm = fixtureArm();
    expect(
      quotaStopTargetMatch(arm, {
        argv: [process.execPath, "/other/service.js"],
        cgroup: "0::/unrelated.service\n",
        invocationId: "b".repeat(32),
      }),
    ).toEqual({ argvMatches: false, targetMatches: false });
    expect(() =>
      quotaStopTargetMatch(arm, {
        argv: [...fixtureArgv(arm).slice(0, -1), `sha256:${"b".repeat(64)}`],
        cgroup: `0::/app.slice/${arm.unit}\n`,
        invocationId: "b".repeat(32),
      }),
    ).toThrow("target arguments differ");
  });

  it("fails closed when an explicitly selected arm is malformed", async () => {
    const uid = process.getuid!();
    const armPath = `/run/user/${uid}/.malformed-quota-stop-arm-${randomBytes(8).toString("hex")}`;
    cleanup.add(armPath);
    await writeFile(armPath, "{not-json}\n", { flag: "wx", mode: 0o600 });
    expect(() =>
      installQuotaStopFetchInterceptor({
        FACTORY_INSTALLED_QUOTA_STOP_ARM: armPath,
        NODE_OPTIONS: `--import=${
          pathToFileURL(resolve("scripts/qualification-controller-quota-stop.mjs")).href
        }`,
      }),
    ).toThrow();
  });

  it("intercepts one exact request until SIGTERM without transport or secret telemetry", async () => {
    const uid = process.getuid!();
    const runtime = `/run/user/${uid}`;
    const caseId = randomBytes(16).toString("hex");
    const arm = fixtureArm();
    const prefix = `${runtime}/.${arm.unit}.${caseId}`;
    const armPath = `${prefix}.arm.json`;
    const reachedPath = `${prefix}.reached.json`;
    const telemetryPath = `${prefix}.telemetry.json`;
    for (const path of [armPath, reachedPath, telemetryPath]) cleanup.add(path);
    const now = Date.now();
    const resetEpoch = Math.ceil((now + 3_600_000) / 1_000);
    await writeFile(
      armPath,
      `${JSON.stringify({
        protocol: "clockgrove.factory/installed-controller-quota-stop-arm",
        caseId,
        ...arm,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        resetEpoch,
        reachedPath,
        telemetryPath,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await chmod(armPath, 0o600);
    const preloadUrl = pathToFileURL(
      resolve("scripts/qualification-controller-quota-stop.mjs"),
    ).href;
    const secret = "never-retain-this-token";
    const program = `const module = await import(process.env.PRELOAD_URL);
const arm = JSON.parse(process.env.ARM);
module.installQuotaStopFetchInterceptor(
  { ...process.env, NODE_OPTIONS: "--import=" + process.env.PRELOAD_URL, FACTORY_INSTALLED_QUOTA_STOP_ARM: process.env.ARM_PATH },
  { argv: process.argv.slice(0, 1).concat(arm.argv.slice(1)), cgroup: "0::/app.slice/" + arm.unit + "\\n", invocationId: arm.invocationId },
);
const response = await fetch("https://api.github.com/repos/private-owner/private-repository", { headers: { authorization: "Bearer ${secret}" } });
process.stdout.write(JSON.stringify({ status: response.status, remaining: response.headers.get("x-ratelimit-remaining"), reset: response.headers.get("x-ratelimit-reset") }));`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      env: {
        ...process.env,
        PRELOAD_URL: preloadUrl,
        ARM_PATH: armPath,
        ARM: JSON.stringify({
          argv: fixtureArgv(arm),
          unit: arm.unit,
          invocationId: "b".repeat(32),
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const closed = once(child, "close") as Promise<[number, NodeJS.Signals | null]>;
    try {
      expect(await waitForJson(reachedPath)).toMatchObject({
        protocol: "clockgrove.factory/installed-controller-quota-stop-reached",
        caseId,
        unit: arm.unit,
        method: "GET",
        route: "repository",
        operation: "repository-facts-rest-read",
      });
      child.kill("SIGTERM");
      const [code, signal] = await closed;
      expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        status: 403,
        remaining: "0",
        reset: String(resetEpoch),
      });
      const telemetryBytes = await readFile(telemetryPath, "utf8");
      expect(JSON.parse(telemetryBytes)).toMatchObject({
        protocol: "clockgrove.factory/installed-controller-quota-stop-telemetry",
        caseId,
        unit: arm.unit,
        signal: "SIGTERM",
        injectedResponses: 1,
        upstreamFetchCalls: 0,
        injectedStatus: 403,
        resetEpoch,
      });
      expect(telemetryBytes).not.toContain(secret);
      expect(telemetryBytes).not.toContain("private-owner");
      expect(telemetryBytes).not.toContain("private-repository");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([closed.catch(() => undefined), sleep(1_000)]);
    }
  });

  it("clears the manager environment after explicit stop and retains cleanup last", async () => {
    const trace: string[] = [];
    const step = (name: string, value: string) => async () => {
      trace.push(name);
      return value;
    };
    const port = {
      install: step("install", "installed"),
      arm: step("arm", "armed"),
      start: step("start", "started"),
      reached: step("reached", "reached"),
      disarm: step("disarm", "disarmed"),
      stop: step("stop", "stopped"),
      telemetry: step("telemetry", "telemetry"),
      final: step("final", "final"),
      cleanup: step("cleanup", "cleanup"),
    };
    await expect(runInstalledQuotaStopScenario(port)).resolves.toMatchObject({
      reached: "reached",
      disarmed: "disarmed",
      stopped: "stopped",
      final: "final",
      cleanup: "cleanup",
    });
    expect(trace).toEqual([
      "install",
      "arm",
      "start",
      "reached",
      "stop",
      "disarm",
      "telemetry",
      "final",
      "cleanup",
    ]);
  });

  it("does not stop when the read-only intercept was not proven", async () => {
    const stop = vi.fn(async () => undefined);
    await expect(
      runInstalledQuotaStopScenario({
        install: async () => undefined,
        arm: async () => undefined,
        start: async () => undefined,
        reached: async () => {
          throw new Error("intercept absent");
        },
        disarm: async () => undefined,
        stop,
        telemetry: async () => undefined,
        final: async () => undefined,
        cleanup: async () => undefined,
      }),
    ).rejects.toThrow("intercept absent");
    expect(stop).not.toHaveBeenCalled();
  });
});
