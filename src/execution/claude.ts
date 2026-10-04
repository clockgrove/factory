import { randomUUID } from "node:crypto";
import { judgedAsWork, workFault } from "../fault.js";
import { mkdirSync, readFileSync } from "node:fs";
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
import {
  launchWorker,
  observeWorker,
  stopUnrecordedWorker,
} from "./worker-process.js";
import { serviceLoginEnvironment } from "../provider-credentials.js";

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

/** Network settings a host may need to reach the Claude API. */
export const claudeNetworkEnvironment = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

export function claudeWorkerEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  const environment = sanitizedWorkerEnvironment(credentialDirectory, [
    ...claudeLocalAuthenticationEnvironment,
    ...claudeNetworkEnvironment,
  ]);
  // A service's bound login reaches Claude SDK children only.
  Object.assign(environment, serviceLoginEnvironment());
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

  private get harnessRoot(): string {
    return this.root;
  }

  /**
   * Start a fresh worker for the attempt identity. Whatever an earlier
   * unrecorded start of it spawned is stopped first (#585).
   */
  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = request.attemptId ?? randomUUID();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const credentialDirectory = join(this.root, "empty-gh-config");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    return {
      identity,
      data: await launchWorker({
        root: this.harnessRoot,
        identity,
        label: "Claude harness",
        script: fileURLToPath(new URL("./claude-worker.js", import.meta.url)),
        input: claudeWorkerInput(request, this.config),
        env: claudeWorkerEnvironment(credentialDirectory),
      }),
    };
  }

  /** Stop what a start of `identity` spawned before its handle was recorded. */
  async cancelUnrecorded(identity: string): Promise<void> {
    await stopUnrecordedWorker(this.harnessRoot, identity, "Claude harness");
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    return observeWorker(this.require(handle), "Claude harness");
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = this.require(handle);
    const current = linuxProcessIdentity(data.pid);
    if (!current) {
      if (processGroupExists(data.pid))
        throw new Error(
          "Worker cessation remains unresolved; checkout retained",
        );
      return;
    }
    if (current.startTime !== data.startTime || current.group !== data.pid)
      throw new Error("Claude worker identity changed before cancellation");
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
        throw workFault(observed.detail ?? "Claude harness worker failed");
      }
      const result: unknown = judgedAsWork(() =>
        JSON.parse(readFileSync(data.resultPath, "utf8")),
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw workFault("Claude harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw workFault("Claude completion result lacks structured evidence");
      const assets =
        value.assets === undefined
          ? undefined
          : parseProducedAssetSets(value.assets);
      return { evidence: value.evidence, assets };
    }
  }
}
