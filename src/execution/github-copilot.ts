import { randomUUID } from "node:crypto";
import { readWorkerJson, workFault } from "../fault.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertAgentSessionRef } from "../agent-session.js";
import { assertDurableValue } from "./checkpoint.js";
import {
  COPILOT_SESSION_ADAPTER,
  copilotDigest,
  copilotSessionRoot,
  prepareCopilotSession,
  requireCopilotHome,
  type CopilotWorkerSession,
  type CopilotSessionData,
} from "./github-copilot-session.js";
import { fileURLToPath } from "node:url";
import type { GitHubCopilotSdkConfig } from "../config.js";
import type {
  AgentHarness,
  AgentSessionRef,
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
import {
  killGroup,
  launchWorker,
  observeWorker,
  stopUnrecordedWorker,
} from "./worker-process.js";

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
  session?: CopilotWorkerSession;
  action?: "release";
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

export function githubCopilotAuthenticationSelection(
  environment: NodeJS.ProcessEnv,
): string {
  return copilotDigest([
    environment.COPILOT_HOME ?? join(environment.HOME ?? "", ".copilot"),
    copilotAuthenticationEnvironment.map((name) => [
      name,
      environment[name] ?? null,
    ]),
  ]);
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
  readonly sessionAdapter = COPILOT_SESSION_ADAPTER;
  readonly sessionCapabilities = { resumeRoles: ["implementation"] } as const;
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
      value.pid! <= 1 ||
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

  private get harnessRoot(): string {
    return this.root;
  }

  /**
   * Start a fresh worker for the attempt identity. Whatever an earlier
   * unrecorded start of it spawned is stopped first (#585).
   */
  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = request.attemptId ?? randomUUID();
    requireCopilotRuntime();
    const boundRequest = { ...request, attemptId: identity };
    const session = prepareCopilotSession(
      this.root,
      boundRequest,
      this.config,
      githubCopilotAuthenticationSelection(process.env),
    );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const credentialDirectory = join(this.root, "empty-gh-config");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    return {
      identity,
      data: await launchWorker({
        root: this.harnessRoot,
        identity,
        label: "GitHub Copilot harness",
        script: fileURLToPath(
          new URL("./github-copilot-worker.js", import.meta.url),
        ),
        input: {
          ...githubCopilotWorkerInput(boundRequest, this.config),
          ...(session && { session }),
        },
        env: githubCopilotWorkerEnvironment(credentialDirectory),
      }),
    };
  }

  /** Stop what a start of `identity` spawned before its handle was recorded. */
  async cancelUnrecorded(identity: string): Promise<void> {
    await stopUnrecordedWorker(
      this.harnessRoot,
      identity,
      "GitHub Copilot harness",
    );
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    const data = this.require(handle);
    const observed = observeWorker(data, "GitHub Copilot harness");
    if (observed.state === "running" || !existsSync(data.resultPath))
      return observed;
    const result = readWorkerJson(data.resultPath) as Record<string, unknown>;
    if (result.session === undefined) return observed;
    await this.cancel(handle);
    return { ...observed, session: this.sessionReceipt(data, result.session) };
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = this.require(handle);
    const current = linuxProcessIdentity(data.pid);
    if (!current) {
      if (processGroupExists(data.pid))
        await killGroup(data.pid, "GitHub Copilot harness");
      return;
    }
    if (current.startTime !== data.startTime || current.group !== data.pid)
      throw new Error(
        "GitHub Copilot worker identity changed before cancellation",
      );
    await killGroup(data.pid, "GitHub Copilot harness");
  }

  private sessionReceipt(
    data: GitHubCopilotWorkerHandleData,
    supplied: unknown,
  ): AgentSessionRef {
    assertAgentSessionRef(supplied);
    const input = readWorkerJson(data.requestPath) as GitHubCopilotWorkerInput;
    const native = supplied.data as CopilotSessionData | undefined;
    const initial = input.session;
    if (
      !initial ||
      supplied.status !== "ready" ||
      supplied.adapter !== this.sessionAdapter ||
      supplied.identity !== initial.ref.identity ||
      supplied.turn !== initial.ref.turn ||
      supplied.executionIdentity !== initial.ref.executionIdentity ||
      !isDeepStrictEqual(supplied.scope, initial.ref.scope) ||
      native?.nativeSettled !== true ||
      typeof native.authenticationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(native.authenticationDigest) ||
      native.nativeSessionId !== initial.nativeSessionId ||
      native.selectionDigest !==
        (initial.ref.data as CopilotSessionData).selectionDigest
    )
      throw workFault("Copilot completion has an invalid session receipt");
    requireCopilotHome(initial);
    const ref = {
      ...supplied,
      data: { ...native, worker: data, workerSettled: true as const },
    };
    assertDurableValue(ref, "Copilot session receipt");
    return ref;
  }

  async releaseSession(session: AgentSessionRef): Promise<void> {
    assertAgentSessionRef(session);
    if (session.adapter !== this.sessionAdapter)
      throw new Error("Cannot release another adapter's conversation");
    const root = copilotSessionRoot(this.root, session.identity);
    const data = session.data as Partial<CopilotSessionData> | undefined;
    if (data?.pendingWorkerIdentity) {
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(data.pendingWorkerIdentity))
        throw new Error("Invalid pending Copilot worker identity");
      // Keep the request receipt while authenticating and stopping its owner.
      const requestPath = resolve(
        this.root,
        `${data.pendingWorkerIdentity}.request.json`,
      );
      if (!existsSync(requestPath)) {
        await this.cancelUnrecorded(data.pendingWorkerIdentity);
        if (existsSync(root))
          throw new Error("Copilot release lacks its owned request receipt");
        return;
      }
    }
    if (!existsSync(root)) return;
    const identity = data?.pendingWorkerIdentity ?? session.executionIdentity;
    if (!identity || !/^[a-zA-Z0-9_-]{1,160}$/.test(identity))
      throw new Error("Copilot release lacks a worker owner");
    const requestPath = resolve(this.root, `${identity}.request.json`);
    const input = readWorkerJson(requestPath) as GitHubCopilotWorkerInput;
    if (
      !input.session ||
      input.session.root !== root ||
      input.session.ref.adapter !== this.sessionAdapter ||
      input.session.ref.identity !== session.identity ||
      !isDeepStrictEqual(input.session.ref.scope, session.scope)
    )
      throw new Error(
        "Copilot release request belongs to another conversation",
      );
    requireCopilotHome(input.session);
    if (data?.worker && data.worker.requestPath !== requestPath)
      throw new Error("Copilot release worker belongs to another execution");
    if (data?.worker) await this.cancel({ identity, data: data.worker });
    else await this.cancelUnrecorded(identity);
    const releaseIdentity = `release-${session.identity}`;
    const handle = {
      identity: releaseIdentity,
      data: await launchWorker({
        root: this.root,
        identity: releaseIdentity,
        label: "Copilot session release",
        script: fileURLToPath(
          new URL("./github-copilot-worker.js", import.meta.url),
        ),
        input: {
          ...input,
          action: "release",
          session: { ...input.session, resume: true },
        },
        env: githubCopilotWorkerEnvironment(join(this.root, "empty-gh-config")),
      }),
    };
    const deadline = Date.now() + 15_000;
    let observed = observeWorker(handle.data, "Copilot session release");
    while (observed.state === "running" && Date.now() < deadline) {
      await new Promise<void>((done) => setTimeout(done, 50));
      observed = observeWorker(handle.data, "Copilot session release");
    }
    await this.cancel(handle);
    if (observed.state !== "complete")
      throw new Error(
        "Copilot session deletion was not confirmed; private storage retained",
      );
    requireCopilotHome(input.session);
    rmSync(root, { recursive: true });
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
        throw workFault(
          observed.detail ?? "GitHub Copilot harness worker failed",
        );
      }
      const result: unknown = readWorkerJson(data.resultPath);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw workFault("GitHub Copilot harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw workFault(
          "GitHub Copilot completion result lacks structured evidence",
        );
      const assets =
        value.assets === undefined
          ? undefined
          : parseProducedAssetSets(value.assets);
      return {
        evidence: value.evidence,
        assets,
        ...(observed.session && { session: observed.session }),
      };
    }
  }
}
