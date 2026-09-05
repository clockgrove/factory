import { constants as fsConstants } from "node:fs";
import { access, chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join } from "node:path";

import { readLocalResourceHostIdentity } from "../recovery/local-resources.js";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";

import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import { localExecutionScopeBatch } from "../execution/backend.js";
import {
  assertLocalScopeLaunch,
  localScopeUnit,
  scopedLocalCommand,
  stopLocalScope,
  type LocalScopeIdentity,
  type LocalScopeProcessPort,
} from "../runtime/local-scope.js";
import { normalizeArtifact, type NormalizedArtifact } from "../execution/artifacts.js";
import {
  durableAttemptId,
  legacyDurableAttemptId,
  normalizeExecutionUsage,
} from "../execution/session.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import {
  createIsolatedCodexHome,
  isolateCodexEnvironment,
  resolveCodexAuthFile,
  type CodexHomeFactory,
} from "../runtime/codex-home.js";
import { collectLocalArtifact } from "../runtime/local-worktree.js";
import { resolveCodexCommand, type CodexCommand } from "../runtime/codex-command.js";
import {
  linuxProcessIds,
  runContainedProcess,
  sanitizedWorkerEnvironment,
} from "../runtime/process-group.js";
import { restrictedCodexConfig } from "./codex-cli-policy.js";
import {
  CODEX_WORKER_OUTPUT_SCHEMA,
  probeLocalCapabilities,
  workerPacketPrompt,
  type LocalCapabilityProbe,
} from "./codex-cli-local.js";

interface WorkerFinal {
  outcome: "succeeded" | "failed" | "declined";
  summary: string;
  commands: Array<{ command: string; exitCode: number }>;
}

interface SdkThread {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: TurnOptions,
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface SdkClient {
  startThread(options?: ThreadOptions): SdkThread;
}

interface SdkAttempt {
  context: AttemptContext;
  handle: BackendHandle;
  home: string;
  controller: AbortController;
  terminal: Promise<void>;
  state: "running" | "succeeded" | "failed" | "cancelled";
  final?: WorkerFinal;
  usage?: unknown;
  progress?: string;
  logs: string;
  reason?: string;
  cancelled: boolean;
  timedOut: boolean;
  scopeSettled?: boolean;
}

export interface CodexSdkLocalOptions {
  /** Low-level owned-resource port for deterministic lifecycle conformance. */
  localScopePort?: LocalScopeProcessPort;
  codexPathOverride?: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  authFile?: string;
  permittedModelCredentials?: string[];
  createCodexHome?: CodexHomeFactory;
  capabilityProbe?: LocalCapabilityProbe;
  createClient?: (options: CodexOptions) => SdkClient;
  credentialAvailable?: () => boolean | Promise<boolean>;
}

const MAX_EVENT_LOG_BYTES = 256 * 1024;
export const CODEX_SDK_COMPATIBLE_CLI_MINOR = "0.153" as const;

const CODEX_SDK_CONTAINMENT_SOURCE = String.raw`
import { spawn, execFile, execFileSync } from "node:child_process";

const supervisorPid = __FACTORY_SUPERVISOR_PID__;
const command = __FACTORY_CODEX_COMMAND__;
const prefixArgs = __FACTORY_CODEX_ARGS__;
const scope = __FACTORY_LOCAL_SCOPE__;
function unitProperties(unit, allowPendingJob = false) {
  let text;
  try {
    text = execFileSync("systemctl", ["--user", "show", unit, "--property=Id,LoadState,ActiveState,ControlGroup,Job,InvocationID,KillMode", "--no-pager"], { encoding: "utf8", timeout: 10000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (![1, 4].includes(error.status) || typeof error.stdout !== "string") throw new Error("Factory SDK scope observation unavailable");
    text = error.stdout;
  }
  const fields = {};
  for (const line of text.trim().split("\n")) {
    const at = line.indexOf("=");
    const name = line.slice(0, at);
    if (at < 1 || Object.hasOwn(fields, name)) throw new Error("Factory SDK scope observation invalid");
    fields[name] = line.slice(at + 1);
  }
  if (fields.Id !== unit || fields.ControlGroup === undefined || fields.Job === undefined || (!allowPendingJob && !["", "0", "0 /"].includes(fields.Job))) throw new Error("Factory SDK scope observation invalid");
  return fields;
}
if (scope) {
  const before = unitProperties(scope.unit);
  if (before.LoadState !== "not-found" || before.ActiveState !== "inactive" || before.ControlGroup !== "") throw new Error("Factory SDK scope is already present");
  if (scope.producerUnit) {
    const producer = unitProperties(scope.producerUnit);
    if (producer.LoadState !== "loaded" || producer.ActiveState !== "active" || producer.InvocationID !== scope.producerInvocationId || producer.KillMode !== "control-group") throw new Error("Factory SDK producer generation changed");
  }
  const remaining = Date.parse(scope.deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Factory SDK scope launch deadline expired");
  const ttl = prefixArgs.findIndex((arg) => arg.startsWith("--property=RuntimeMaxSec="));
  if (ttl < 0) throw new Error("Factory SDK scope runtime bound missing");
  prefixArgs[ttl] = "--property=RuntimeMaxSec=" + Math.floor(remaining) + "ms";
}
const child = spawn(command, [...prefixArgs, ...process.argv.slice(2)], {
  detached: true,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
if (!child.pid) throw new Error("Factory SDK containment wrapper could not start Codex");

let stopping = false;
let forceTimer;
let groupPoll;
let childResult;
let outputViolation;
let scopeCleanupDone = !scope;
let scopeCleanupFailed = false;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const outputState = {
  stdout: { bytes: 0, lineBytes: 0 },
  stderr: { bytes: 0, lineBytes: 0 },
};

function groupExists() {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    // A permission/read failure is not evidence that the launcher group is gone.
    return error.code !== "ESRCH";
  }
}

function exitFromChild() {
  if (!childResult && !scopeCleanupFailed) return;
  clearInterval(watchdog);
  if (forceTimer) clearTimeout(forceTimer);
  if (groupPoll) clearInterval(groupPoll);
  process.exit(outputViolation || scopeCleanupFailed ? 1 : childResult.signal ? 1 : childResult.code ?? 1);
}

function finishWhenGroupIsGone() {
  if (!scopeCleanupDone) return;
  if (scopeCleanupFailed) {
    // Do not wait forever after the bounded cleanup verifier has already failed.
    // This is a nonzero result, never an absence grant; the backend must reconcile
    // the exact owned scope before the Supervisor can close or replace the attempt.
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    exitFromChild();
    return;
  }
  if (!childResult) return;
  if (!groupExists()) {
    exitFromChild();
    return;
  }
  if (!groupPoll) {
    groupPoll = setInterval(() => {
      if (!groupExists()) exitFromChild();
    }, 50);
  }
}

function stopGroup() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  forceTimer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, 2_000);
  if (scope) {
    cleanupScope().catch(() => {
      scopeCleanupFailed = true;
      process.stderr.write("Factory SDK owned scope cleanup unverified\n");
    }).finally(() => {
      scopeCleanupDone = true;
      finishWhenGroupIsGone();
    });
  }
  finishWhenGroupIsGone();
}

function scopeMissing(fields) {
  return fields.LoadState === "not-found" && fields.ActiveState === "inactive" &&
    fields.ControlGroup === "" && fields.InvocationID === "" &&
    ["", "0", "0 /"].includes(fields.Job);
}

async function cleanupScope() {
  // --collect can remove a successfully completed scope before systemd-run exits.
  // Neither a stop error nor a successful stop is an absence observation.
  const before = unitProperties(scope.unit, true);
  if (!scopeMissing(before) || !childResult || groupExists()) {
    if (!scopeMissing(before) && (before.LoadState !== "loaded" ||
      before.KillMode !== "control-group" || !/^[a-f0-9]{32}$/.test(before.InvocationID ?? "") ||
      !before.ControlGroup.endsWith("/" + scope.unit))) throw new Error("scope ownership unavailable");
    await new Promise((resolve) => execFile("systemctl", ["--user", "stop", scope.unit],
      { timeout: 10000, maxBuffer: 16384 }, () => resolve()));
  }
  // Allow the existing bounded process-group TERM/KILL drain to finish before
  // checking absence: a still-live launcher could otherwise create the scope late.
  const groupDeadline = performance.now() + 3000;
  while (!childResult || groupExists()) {
    if (performance.now() >= groupDeadline) throw new Error("scope launcher remains active");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const drainDeadline = performance.now() + 500;
  for (;;) {
    const current = unitProperties(scope.unit, true);
    if (scopeMissing(current)) {
      if (scopeMissing(unitProperties(scope.unit))) return;
      throw new Error("scope observation changed");
    }
    if (current.LoadState !== "loaded" || current.KillMode !== "control-group" ||
      !/^[a-f0-9]{32}$/.test(current.InvocationID ?? "") ||
      !current.ControlGroup.endsWith("/" + scope.unit) || performance.now() >= drainDeadline)
      throw new Error("scope absence unavailable");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function forwardBounded(name, target, chunk) {
  if (outputViolation) return;
  const state = outputState[name];
  state.bytes += chunk.length;
  for (const byte of chunk) {
    state.lineBytes = byte === 10 ? 0 : state.lineBytes + 1;
    if (state.lineBytes > MAX_LINE_BYTES) break;
  }
  if (state.bytes > MAX_STREAM_BYTES || state.lineBytes > MAX_LINE_BYTES) {
    outputViolation =
      "Factory SDK containment stopped Codex because " + name +
      " exceeded its bounded-output limit\n";
    process.stderr.write(outputViolation);
    stopGroup();
    return;
  }
  target.write(chunk);
}

child.stdout.on("data", (chunk) => forwardBounded("stdout", process.stdout, chunk));
child.stderr.on("data", (chunk) => forwardBounded("stderr", process.stderr, chunk));

process.on("SIGTERM", stopGroup);
process.on("SIGINT", stopGroup);
process.on("SIGHUP", stopGroup);
const watchdog = setInterval(() => {
  try { process.kill(supervisorPid, 0); } catch { stopGroup(); }
}, 250);
watchdog.unref();

child.once("error", (error) => {
  process.stderr.write("Factory SDK containment wrapper failed: " + error.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  childResult = { code, signal };
  if (!stopping && (scope || groupExists())) stopGroup();
  if (stopping) finishWhenGroupIsGone();
  else exitFromChild();
});
`;

export async function createSdkContainmentWrapper(
  home: string,
  target: CodexCommand,
  supervisorPid = process.pid,
  preparedScope?: { identity: LocalScopeIdentity; deadline: Date },
): Promise<string> {
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
    throw new Error("SDK containment wrapper requires a positive supervisor PID");
  }
  const wrapper = join(home, "factory-sdk-codex-wrapper.mjs");
  const scope = preparedScope
    ? {
        unit: localScopeUnit(preparedScope.identity),
        deadline: preparedScope.deadline.toISOString(),
        producerUnit: preparedScope.identity.producerUnit,
        producerInvocationId: preparedScope.identity.producerInvocationId,
      }
    : null;
  const executable = preparedScope
    ? scopedLocalCommand(
        preparedScope.identity,
        target.command,
        target.args,
        preparedScope.deadline.getTime() - Date.now(),
      )
    : target;
  const source = `#!/usr/bin/env node\n${CODEX_SDK_CONTAINMENT_SOURCE}`
    .replace("__FACTORY_SUPERVISOR_PID__", String(supervisorPid))
    .replace("__FACTORY_CODEX_COMMAND__", () => JSON.stringify(executable.command))
    .replace("__FACTORY_CODEX_ARGS__", () => JSON.stringify(executable.args))
    .replace("__FACTORY_LOCAL_SCOPE__", () => JSON.stringify(scope));
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

function appendBounded(current: string, line: string): string {
  const next = `${current}${line}\n`;
  if (Buffer.byteLength(next, "utf8") <= MAX_EVENT_LOG_BYTES) return next;
  const bytes = Buffer.from(next, "utf8");
  const tail = bytes.subarray(Math.max(0, bytes.length - MAX_EVENT_LOG_BYTES + 96));
  return `[SDK event log truncated to ${MAX_EVENT_LOG_BYTES} bytes]\n${tail.toString("utf8")}`;
}

function safeDiagnostic(value: string): string {
  try {
    assertNoSecretMaterial(value, "SDK diagnostic");
    return value;
  } catch (error) {
    return error instanceof Error ? error.message : "SDK diagnostic contained secret material";
  }
}

function parseWorkerFinal(text: string): WorkerFinal | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    !["succeeded", "failed", "declined"].includes(String(value.outcome)) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.commands)
  )
    return undefined;
  const commands: WorkerFinal["commands"] = [];
  for (const entry of value.commands) {
    if (!entry || typeof entry !== "object") return undefined;
    const command = entry as Record<string, unknown>;
    if (
      typeof command.command !== "string" ||
      typeof command.exitCode !== "number" ||
      !Number.isInteger(command.exitCode)
    )
      return undefined;
    commands.push({ command: command.command, exitCode: command.exitCode });
  }
  return {
    outcome: value.outcome as WorkerFinal["outcome"],
    summary: value.summary,
    commands,
  };
}

function attemptMarker(input: StaleAttemptIdentity | AttemptContext): string {
  return `FACTORY_ATTEMPT_ID=${durableAttemptId(input)}`;
}

async function processEnvironmentContains(pid: number, marker: string): Promise<boolean> {
  const environment = await readFile(`/proc/${pid}/environ`).catch(() => null);
  return Boolean(environment?.toString("utf8").split("\0").includes(marker));
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
}

async function matchingAttemptProcesses(marker: string): Promise<number[]> {
  const pids = await linuxProcessIds();
  const matches: number[] = [];
  for (const pid of pids) {
    if (await processEnvironmentContains(pid, marker)) matches.push(pid);
  }
  return matches;
}

async function waitForAttemptProcessesToExit(marker: string): Promise<boolean> {
  for (let check = 0; check < 20; check += 1) {
    if ((await matchingAttemptProcesses(marker)).length === 0) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return (await matchingAttemptProcesses(marker)).length === 0;
}

async function terminateAttemptProcesses(marker: string, label: string): Promise<void> {
  // Re-scan after each signal phase. A wrapper can fail while its detached
  // child is still starting, so a single snapshot could miss a newly
  // inherited marker and falsely certify absence.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const matches = await matchingAttemptProcesses(marker);
    if (matches.length === 0) return;
    for (const pid of matches) signalProcess(pid, signal);
    if (await waitForAttemptProcessesToExit(marker)) return;
  }
  const survivors = await matchingAttemptProcesses(marker);
  if (survivors.length > 0) {
    throw new Error(
      `${label} reconciliation could not terminate process IDs ${survivors.join(", ")}`,
    );
  }
}

/**
 * Preferred programmatic local worker. The SDK owns its Codex child process; Factory still owns
 * the isolated home, exact environment, cancellation signal, filesystem artifact, and cleanup.
 */
export class CodexSdkLocalBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities = {
    id: "codex-sdk/local-worktree",
    supportTier: "supported",
    agentKind: "codex-sdk",
    runtimeKind: "local-worktree",
    hostExecution: true,
    isolation: "process",
    supportedOs: ["linux"],
    supportedArchitectures: [arch()],
    supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    reportsModelUsage: true,
    supportsModelSelection: true,
    requiresPaidRuntime: false,
    providerManagedPublication: false,
    requiredCredentials: ["codex-login-or-model-key"],
  };

  readonly #options: CodexSdkLocalOptions;
  readonly #running = new Map<string, SdkAttempt>();

  constructor(options: CodexSdkLocalOptions = {}) {
    this.#options = options;
  }

  async probe(requirements?: ExecutionRequirements): Promise<BackendProbe> {
    const measuredAt = new Date().toISOString();
    if (process.platform !== "linux") {
      return {
        available: false,
        authenticated: false,
        reason: "Factory local execution requires Linux (native, WSL2, or a Linux guest)",
        measuredAt,
      };
    }
    if (requirements) {
      const discovered = await (this.#options.capabilityProbe ?? probeLocalCapabilities)(
        requirements,
      );
      this.capabilities.supportedTools = [
        ...new Set([...this.capabilities.supportedTools, ...discovered.tools]),
      ];
      this.capabilities.supportedServices = [
        ...new Set([...this.capabilities.supportedServices, ...discovered.services]),
      ];
    }
    try {
      await this.#probeClient(this.#sdkEnvironment(sanitizedWorkerEnvironment(process.env)));
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        reason: error instanceof Error ? error.message : String(error),
        measuredAt,
      };
    }
    const authenticated = this.#options.credentialAvailable
      ? await this.#options.credentialAvailable()
      : await this.#hasCredential();
    return {
      available: true,
      authenticated,
      ...(!authenticated
        ? { reason: "no Codex login or permitted model credential was found" }
        : {}),
      measuredAt,
    };
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    const scope = localExecutionScopeBatch(context);
    if (Date.now() >= context.deadline.getTime()) {
      throw new Error("attempt deadline already elapsed");
    }
    const home = await (this.#options.createCodexHome ?? createIsolatedCodexHome)("worker");
    try {
      const authFile = resolveCodexAuthFile(this.#options.authFile);
      const hasAuth = await access(authFile, fsConstants.R_OK).then(
        () => true,
        () => false,
      );
      if (hasAuth) await symlink(authFile, join(home, "auth.json"));

      const env = this.#sdkEnvironment(
        isolateCodexEnvironment(
          sanitizedWorkerEnvironment(process.env, this.#options.permittedModelCredentials ?? []),
          home,
        ),
      );
      const attemptId = durableAttemptId(context);
      env.FACTORY_ATTEMPT_ID = attemptId;
      const resourceHostIdentity = await readLocalResourceHostIdentity();
      const config = restrictedCodexConfig(
        "workspace-write",
        context.packet.requirements.networkDestinations,
      );
      const sdkConfig = config as unknown as NonNullable<CodexOptions["config"]>;
      const clientOptions: CodexOptions = { env, config: sdkConfig };
      if (!this.#options.createClient || scope) {
        const command = await resolveCodexCommand(this.#options.codexPathOverride);
        clientOptions.codexPathOverride = await createSdkContainmentWrapper(
          home,
          command,
          process.pid,
          scope ? { identity: scope.identity, deadline: context.deadline } : undefined,
        );
      }
      if (scope) {
        await context.localExecutionScope!.assertCurrent();
        await assertLocalScopeLaunch(
          scope.identity,
          context.deadline,
          this.#options.localScopePort,
        );
      }
      const client = this.#client(clientOptions);
      const model = context.modelSelection?.model ?? this.#options.model;
      const modelReasoningEffort =
        context.modelSelection?.reasoning ?? this.#options.modelReasoningEffort;
      const thread = client.startThread({
        workingDirectory: context.workspace,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        webSearchMode: "disabled",
        networkAccessEnabled: context.packet.requirements.networkDestinations.length > 0,
        ...(model ? { model } : {}),
        ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
      });
      const resourceId = `sdk-${attemptId.slice(0, 24)}`;
      const handle: BackendHandle = {
        backendId: this.capabilities.id,
        resourceId,
        startedAt: new Date().toISOString(),
        metadata: {
          workspace: context.workspace,
          baseSha: context.packet.baseSha,
          attemptId,
          ...(resourceHostIdentity ? { resourceHostIdentity } : {}),
          codexHome: home,
        },
      };
      const running: SdkAttempt = {
        context,
        handle,
        home,
        controller: new AbortController(),
        terminal: Promise.resolve(),
        state: "running",
        logs: "",
        cancelled: false,
        timedOut: false,
      };
      this.#running.set(resourceId, running);
      running.terminal = this.#run(thread, running);
      return handle;
    } catch (error) {
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const running = this.#require(handle);
    const state =
      running.context.localExecutionScope && !running.scopeSettled ? "running" : running.state;
    return {
      state,
      observedAt: new Date().toISOString(),
      usage: normalizeExecutionUsage(running.usage),
      ...(running.progress ? { progress: running.progress } : {}),
      ...(state === "failed"
        ? { reason: running.reason ?? running.final?.summary ?? "SDK worker failed" }
        : {}),
    };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const running = this.#require(handle);
    running.cancelled = true;
    running.controller.abort("attempt cancelled by Factory");
    await running.terminal;
    handle.metadata = {
      ...handle.metadata,
      terminalState: "cancelled",
      terminalAt: new Date().toISOString(),
      terminalReason: "attempt cancelled by Factory",
    };
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const running = this.#require(handle);
    await running.terminal;
    const collected = await collectLocalArtifact(
      {
        root: join(running.context.workspace, ".."),
        path: running.context.workspace,
        repository: running.context.workspace,
        baseSha: running.context.packet.baseSha,
      },
      running.logs,
      running.context.packet.allowedPaths,
    );
    const outcome =
      running.state === "succeeded" &&
      running.final?.outcome === "succeeded" &&
      collected.patch.trim()
        ? "succeeded"
        : running.final?.outcome === "declined" || !collected.patch.trim()
          ? "declined"
          : "failed";
    return normalizeArtifact({
      baseSha: collected.baseSha,
      patch: collected.patch,
      changedPaths: collected.changedPaths,
      commands: (running.final?.commands ?? []).map((command) => ({
        ...command,
        durationMs: 0,
      })),
      logs: collected.logs,
      outcome,
      ...(outcome === "succeeded"
        ? {}
        : {
            reason:
              running.final?.summary ||
              running.reason ||
              (running.timedOut
                ? "SDK worker timed out"
                : "SDK worker did not produce usable work"),
          }),
    });
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    const running = this.#require(handle);
    // A terminal SDK stream proves only that the containment wrapper stopped
    // producing events. If that wrapper crashed, its detached Codex process
    // may still be alive. Always cancel and then prove marker absence before
    // deleting the only in-process recovery handle.
    running.controller.abort("Factory cleanup");
    await running.terminal;
    const scope = localExecutionScopeBatch(running.context);
    if (scope) await stopLocalScope(scope.identity, this.#options.localScopePort);
    else
      await this.reconcileStale({
        repository: running.context.repository,
        objective: running.context.objective,
        workItem: running.context.workItem,
        attempt: running.context.attempt,
        runId: running.context.runId,
        directorEpoch: running.context.directorEpoch,
        phase: "execution",
        providerResourceId: handle.resourceId,
      });
    this.#running.delete(handle.resourceId);
    await rm(running.home, { recursive: true, force: true });
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("stale SDK process reconciliation is supported only on Linux/WSL");
    }
    const marker = attemptMarker(identity);
    await terminateAttemptProcesses(marker, "stale SDK");
    const legacyMarker = `FACTORY_ATTEMPT_ID=${legacyDurableAttemptId(identity)}`;
    if ((await matchingAttemptProcesses(legacyMarker)).length > 0) {
      throw new Error(
        "legacy SDK worker identity has no repository namespace; automated replacement is blocked",
      );
    }
  }

  #client(options: CodexOptions): SdkClient {
    return this.#options.createClient ? this.#options.createClient(options) : new Codex(options);
  }

  async #probeClient(env: Record<string, string>): Promise<void> {
    if (this.#options.createClient) {
      this.#options.createClient({ env });
      return;
    }
    const target = await resolveCodexCommand(this.#options.codexPathOverride);
    const result = await runContainedProcess({
      command: target.command,
      args: [...target.args, "--version"],
      cwd: process.cwd(),
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 8_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Codex executable ${target.command} is unavailable`);
    }
    const version = /\bcodex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)\b/i.exec(
      `${result.stdout}\n${result.stderr}`,
    );
    if (!version) {
      throw new Error(`Codex executable ${target.command} returned an unrecognized version`);
    }
    if (`${version[1]}.${version[2]}` !== CODEX_SDK_COMPATIBLE_CLI_MINOR) {
      throw new Error(
        `Codex SDK requires a ${CODEX_SDK_COMPATIBLE_CLI_MINOR}.x CLI; ` +
          `${target.command} reported ${version[1]}.${version[2]}.${version[3]}`,
      );
    }
  }

  #sdkEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
      Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }

  async #hasCredential(): Promise<boolean> {
    const authFile = resolveCodexAuthFile(this.#options.authFile);
    const hasAuthFile = await access(authFile, fsConstants.R_OK).then(
      () => true,
      () => false,
    );
    const hasModelCredential = (this.#options.permittedModelCredentials ?? []).some((name) =>
      Boolean(process.env[name]),
    );
    return hasAuthFile || hasModelCredential;
  }

  async #run(thread: SdkThread, running: SdkAttempt): Promise<void> {
    const remaining = Math.max(1, running.context.deadline.getTime() - Date.now());
    let streamViolation: string | undefined;
    let terminalFailure: string | undefined;
    let completionObserved = false;
    let completionCount = 0;
    const timeout = setTimeout(() => {
      running.timedOut = true;
      running.controller.abort("Factory worker deadline elapsed");
    }, remaining);
    try {
      const { events } = await thread.runStreamed(workerPacketPrompt(running.context), {
        outputSchema: CODEX_WORKER_OUTPUT_SCHEMA,
        signal: running.controller.signal,
      });
      for await (const event of events) {
        if (event.type === "turn.completed") {
          completionCount += 1;
          running.usage = completionCount === 1 ? event.usage : undefined;
        }
        const serialized = JSON.stringify(event);
        if (!streamViolation) {
          try {
            assertNoSecretMaterial(serialized, "SDK event");
          } catch (error) {
            streamViolation =
              error instanceof Error
                ? error.message
                : "SDK event contained suspected secret material";
            running.reason = streamViolation;
            // Do not throw out of the SDK's event iterator. The pinned SDK's
            // iterator-return path asks its child to stop but does not wait for
            // process exit. Aborting and continuing to drain makes the SDK hold
            // this promise until its containment wrapper has actually exited.
            running.controller.abort(streamViolation);
          }
        }
        if (streamViolation) continue;
        running.logs = appendBounded(running.logs, serialized);
        if (event.type === "thread.started") {
          running.handle.metadata = {
            ...running.handle.metadata,
            threadId: event.thread_id,
          };
        } else if (event.type === "turn.completed") {
          if (completionObserved) {
            terminalFailure = "SDK worker returned multiple turn.completed events";
            running.reason = terminalFailure;
            running.controller.abort(terminalFailure);
            continue;
          }
          completionObserved = true;
          if (!running.final) {
            terminalFailure = "SDK worker completed without a valid final result";
            running.reason = terminalFailure;
          }
        } else if (event.type === "turn.failed") {
          terminalFailure = safeDiagnostic(event.error.message);
          running.reason = terminalFailure;
          running.controller.abort(terminalFailure);
        } else if (event.type === "error") {
          terminalFailure = safeDiagnostic(event.message);
          running.reason = terminalFailure;
          running.controller.abort(terminalFailure);
        } else if (event.type === "item.completed") {
          if (event.item.type === "agent_message") {
            if (completionObserved) {
              terminalFailure = "SDK worker returned an agent message after turn.completed";
              running.reason = terminalFailure;
              running.controller.abort(terminalFailure);
            } else {
              // Match Thread.run(): every completed agent message replaces the
              // previous finalResponse, even if it is not valid worker JSON.
              const final = parseWorkerFinal(event.item.text);
              if (final) running.final = final;
              else delete running.final;
            }
            running.progress = running.final?.summary ?? event.item.text.slice(0, 500);
          } else if (event.item.type === "command_execution") {
            running.progress = event.item.command.slice(0, 500);
          }
        }
      }
      if (!completionObserved && !terminalFailure && !streamViolation && !running.timedOut) {
        terminalFailure = "SDK worker stream ended without turn.completed";
        running.reason = terminalFailure;
      }
      running.state = running.cancelled
        ? "cancelled"
        : running.timedOut || streamViolation || terminalFailure
          ? "failed"
          : completionObserved && running.final?.outcome === "succeeded"
            ? "succeeded"
            : "failed";
      if (running.state === "failed" && !running.reason) {
        running.reason = running.final?.summary ?? "SDK worker returned no valid final result";
      }
    } catch (error) {
      running.state = running.cancelled ? "cancelled" : "failed";
      running.reason ??= safeDiagnostic(
        running.timedOut
          ? "SDK worker timed out"
          : error instanceof Error
            ? error.message
            : String(error),
      );
      running.logs = appendBounded(running.logs, running.reason);
    } finally {
      clearTimeout(timeout);
      const scope = localExecutionScopeBatch(running.context);
      if (scope) {
        try {
          await stopLocalScope(scope.identity, this.#options.localScopePort);
        } catch {
          running.state = "failed";
          running.reason = "SDK worker resource cleanup is unverified";
        } finally {
          running.scopeSettled = true;
        }
      }
    }
  }

  #require(handle: BackendHandle): SdkAttempt {
    if (handle.backendId !== this.capabilities.id) {
      throw new Error(`handle belongs to ${handle.backendId}, not ${this.capabilities.id}`);
    }
    const running = this.#running.get(handle.resourceId);
    if (!running) throw new Error(`unknown SDK worker ${handle.resourceId}`);
    return running;
  }
}
