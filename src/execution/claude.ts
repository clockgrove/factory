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
import type {
  AgentHarness,
  HarnessHandle,
  HarnessObservation,
  HarnessRequest,
  HarnessResult,
} from "../contracts.js";
import { AuthenticationRequiredError } from "../contracts.js";
import type { ClaudeAgentSdkConfig } from "../config.js";
import { parseProducedAssetSets } from "../media.js";
import { FACTORY_VERSION } from "../package-metadata.js";
import {
  linuxProcessIdentity,
  processGroupExists,
  sanitizedWorkerEnvironment,
} from "../process.js";
import { parseAuthenticationRequest } from "./harness-support.js";

interface ClaudeWorkerHandleData {
  pid: number;
  startTime: string;
  requestPath: string;
  resultPath: string;
  logPath: string;
}

export interface ClaudeWorkerInput {
  request: HarnessRequest;
  config: ClaudeAgentSdkConfig;
  providerTurnIdleTimeoutMs?: number;
}

const claudeLocalAuthenticationEnvironment = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

export function claudeWorkerInput(
  request: HarnessRequest,
  config: ClaudeAgentSdkConfig,
): ClaudeWorkerInput {
  return {
    request,
    config: structuredClone(config),
  };
}

export function claudeAuthenticationValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  return claudeLocalAuthenticationEnvironment
    .map((name) => environment[name])
    .filter((value): value is string => Boolean(value));
}

export function claudeWorkerEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  const environment = sanitizedWorkerEnvironment(
    credentialDirectory,
    claudeLocalAuthenticationEnvironment,
  );
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = `clockgrove-factory/${FACTORY_VERSION}`;
  return environment;
}

export class ClaudeAgentSdkHarness implements AgentHarness {
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
    private config: ClaudeAgentSdkConfig,
  ) {}

  private require(handle: HarnessHandle): ClaudeWorkerHandleData {
    const data = handle.data;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid Claude harness handle");
    const value = data as Partial<ClaudeWorkerHandleData>;
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
      throw new Error("Invalid Claude harness handle");
    return value as ClaudeWorkerHandleData;
  }

  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = request.attemptId ?? randomUUID();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const credentialDirectory = join(this.root, "empty-gh-config");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    const requestPath = join(this.root, `${identity}.request.json`);
    const resultPath = join(this.root, `${identity}.result.json`);
    const logPath = join(this.root, `${identity}.log`);
    writeFileSync(
      requestPath,
      `${JSON.stringify(claudeWorkerInput(request, this.config))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const log = openSync(logPath, "a", 0o600);
    let pid: number;
    try {
      const worker = fileURLToPath(
        new URL("./claude-worker.js", import.meta.url),
      );
      const environment = claudeWorkerEnvironment(credentialDirectory);
      const child = spawn(process.execPath, [worker, requestPath, resultPath], {
        detached: true,
        stdio: ["ignore", log, log],
        env: environment,
      });
      if (!child.pid) throw new Error("Failed to launch Claude harness worker");
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(log);
    }
    const identityOnHost = linuxProcessIdentity(pid);
    if (!identityOnHost || identityOnHost.group !== pid)
      throw new Error(
        "Claude harness worker did not start in its own process group",
      );
    return {
      identity,
      data: {
        pid,
        startTime: identityOnHost.startTime,
        requestPath: resolve(requestPath),
        resultPath: resolve(resultPath),
        logPath: resolve(logPath),
      } satisfies ClaudeWorkerHandleData,
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
            "Claude worker exited without a durable result; operator direction required",
        };
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = this.require(handle);
    const current = linuxProcessIdentity(data.pid);
    if (current?.startTime !== data.startTime || current.group !== data.pid) {
      if (!existsSync(data.resultPath))
        throw new Error("Claude worker identity changed before cancellation");
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
            observed.detail ?? "Claude authentication required",
            observed.authentication,
          );
        throw new Error(observed.detail ?? "Claude harness worker failed");
      }
      const result: unknown = JSON.parse(readFileSync(data.resultPath, "utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Claude harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw new Error("Claude completion result lacks structured evidence");
      const assets =
        value.assets === undefined
          ? undefined
          : parseProducedAssetSets(value.assets);
      return { evidence: value.evidence, assets };
    }
  }
}
