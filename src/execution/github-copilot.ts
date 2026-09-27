import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubCopilotSdkConfig } from "../config.js";
import type {
  AgentHarness,
  HarnessHandle,
  HarnessObservation,
  HarnessRequest,
  HarnessResult,
} from "../contracts.js";
import { AuthenticationRequiredError } from "../contracts.js";
import { parseProducedAssetSets } from "../media.js";
import {
  linuxProcessIdentity,
  processGroupExists,
  sanitizedWorkerEnvironment,
} from "../process.js";
import { parseAuthenticationRequest } from "./harness-support.js";

interface GitHubCopilotWorkerHandleData {
  pid: number;
  startTime: string;
  requestPath: string;
  resultPath: string;
  logPath: string;
}

/** Exact SDK 1.0.13 requires Node >=22.12 on Factory's Node >=22 surface. */
export function requireCopilotRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error(
      `GitHub Copilot SDK 1.0.13 requires Node >=22.12.0; current runtime is ${version}. No fallback is available`,
    );
}

export interface GitHubCopilotWorkerInput {
  request: HarnessRequest;
  config: GitHubCopilotSdkConfig;
  providerTurnIdleTimeoutMs?: number;
}

const copilotAuthenticationEnvironment = [
  "COPILOT_GITHUB_TOKEN",
  "GITHUB_COPILOT_API_TOKEN",
  "COPILOT_API_URL",
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_TYPE",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BEARER_TOKEN",
];

export function githubCopilotWorkerInput(
  request: HarnessRequest,
  config: GitHubCopilotSdkConfig,
): GitHubCopilotWorkerInput {
  return {
    request,
    config: structuredClone(config),
  };
}

export function githubCopilotAuthenticationValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  return copilotAuthenticationEnvironment
    .map((name) => environment[name])
    .filter((value): value is string => Boolean(value));
}

export function githubCopilotWorkerEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  const environment = sanitizedWorkerEnvironment(
    credentialDirectory,
    copilotAuthenticationEnvironment,
  );
  // The shared sanitizer rejects all GITHUB_* variables. Restore only the
  // Copilot SDK's named endpoint token, never the controller's publication
  // credentials (GH_TOKEN/GITHUB_TOKEN).
  if (process.env.GITHUB_COPILOT_API_TOKEN)
    environment.GITHUB_COPILOT_API_TOKEN = process.env.GITHUB_COPILOT_API_TOKEN;
  // Keep the sanitizer's owned empty GH_CONFIG_DIR. Ambient or default gh
  // login can contain the controller's publication credentials, not a
  // separately authorized Copilot-local login.
  if (process.env.COPILOT_HOME)
    environment.COPILOT_HOME = process.env.COPILOT_HOME;
  environment.COPILOT_SDK_DEFAULT_CONNECTION = "stdio";
  return environment;
}

export class GitHubCopilotSdkHarness implements AgentHarness {
  readonly capabilities = {
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "local-environment",
  } as const;

  constructor(
    private root: string,
    private config: GitHubCopilotSdkConfig,
  ) {}

  private require(handle: HarnessHandle): GitHubCopilotWorkerHandleData {
    const data = handle.data;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid GitHub Copilot harness handle");
    const value = data as Partial<GitHubCopilotWorkerHandleData>;
    const root = resolve(this.root);
    if (
      !Number.isSafeInteger(value.pid) ||
      typeof value.startTime !== "string" ||
      !value.startTime ||
      typeof value.requestPath !== "string" ||
      typeof value.resultPath !== "string" ||
      typeof value.logPath !== "string" ||
      ![value.requestPath, value.resultPath, value.logPath].every((path) =>
        resolve(path).startsWith(`${root}${sep}`),
      )
    )
      throw new Error("Invalid GitHub Copilot harness handle");
    return value as GitHubCopilotWorkerHandleData;
  }

  async start(request: HarnessRequest): Promise<HarnessHandle> {
    requireCopilotRuntime();
    const identity = request.attemptId ?? randomUUID();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const credentialDirectory = join(this.root, "empty-gh-config");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    const requestPath = join(this.root, `${identity}.request.json`);
    const resultPath = join(this.root, `${identity}.result.json`);
    const logPath = join(this.root, `${identity}.log`);
    writeFileSync(
      requestPath,
      `${JSON.stringify(githubCopilotWorkerInput(request, this.config))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const log = openSync(logPath, "a", 0o600);
    let pid: number;
    try {
      const worker = fileURLToPath(
        new URL("./github-copilot-worker.js", import.meta.url),
      );
      const child = spawn(process.execPath, [worker, requestPath, resultPath], {
        detached: true,
        stdio: ["ignore", log, log],
        env: githubCopilotWorkerEnvironment(credentialDirectory),
      });
      if (!child.pid)
        throw new Error("Failed to launch GitHub Copilot harness worker");
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(log);
    }
    const identityOnHost = linuxProcessIdentity(pid);
    if (!identityOnHost || identityOnHost.group !== pid)
      throw new Error(
        "GitHub Copilot harness worker did not start in its own process group",
      );
    return {
      identity,
      data: {
        pid,
        startTime: identityOnHost.startTime,
        requestPath: resolve(requestPath),
        resultPath: resolve(resultPath),
        logPath: resolve(logPath),
      } satisfies GitHubCopilotWorkerHandleData,
    };
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    const data = this.require(handle);
    if (existsSync(data.resultPath)) {
      const result = JSON.parse(readFileSync(data.resultPath, "utf8")) as {
        state: "complete" | "failed";
        error?: string;
        authentication?: unknown;
      };
      const authentication = parseAuthenticationRequest(result.authentication);
      return result.state === "complete"
        ? { state: "complete" }
        : {
            state: "failed",
            detail: result.error,
            ...(authentication && { authentication }),
          };
    }
    const current = linuxProcessIdentity(data.pid);
    return current?.startTime === data.startTime &&
      current.group === data.pid &&
      current.state !== "Z"
      ? { state: "running" }
      : {
          state: "failed",
          detail:
            "GitHub Copilot worker exited without a durable result; operator direction required",
        };
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = this.require(handle);
    const current = linuxProcessIdentity(data.pid);
    if (current?.startTime !== data.startTime || current.group !== data.pid) {
      if (!existsSync(data.resultPath))
        throw new Error(
          "GitHub Copilot worker identity changed before cancellation",
        );
      return;
    }
    try {
      process.kill(-data.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 2_000;
    while (processGroupExists(data.pid) && Date.now() < deadline)
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 20),
      );
    if (processGroupExists(data.pid))
      try {
        process.kill(-data.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    while (processGroupExists(data.pid))
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 20),
      );
  }

  async collect(handle: HarnessHandle): Promise<HarnessResult> {
    const data = this.require(handle);
    for (;;) {
      const observed = await this.observe(handle);
      if (observed.state === "running") {
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 100),
        );
        continue;
      }
      if (observed.state !== "complete") {
        if (observed.authentication)
          throw new AuthenticationRequiredError(
            observed.detail ?? "GitHub Copilot authentication required",
            observed.authentication,
          );
        throw new Error(
          observed.detail ?? "GitHub Copilot harness worker failed",
        );
      }
      const result: unknown = JSON.parse(readFileSync(data.resultPath, "utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("GitHub Copilot harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw new Error(
          "GitHub Copilot completion result lacks structured evidence",
        );
      const assets =
        value.assets === undefined
          ? undefined
          : parseProducedAssetSets(value.assets);
      return { evidence: value.evidence, assets };
    }
  }
}
