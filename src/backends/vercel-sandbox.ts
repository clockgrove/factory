import { Sandbox, type Command, type CommandFinished, type NetworkPolicy } from "@vercel/sandbox";

import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  IsolatedValidationContext,
  IsolatedValidationResult,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import {
  ProviderResourceCleanupError,
  remainingBeforeAttemptDeadline,
} from "../execution/backend.js";
import { normalizeArtifact, type NormalizedArtifact } from "../execution/artifacts.js";
import { inspectPinnedLfs } from "../repository-profiles/git-lfs.js";
import {
  parseSandboxPaths,
  parseIsolatedValidationResult,
  repositoryArchive,
  sandboxBootstrapFiles,
  sandboxResourceName,
  sandboxValidationFiles,
} from "./sandbox-common.js";

const DEFAULT_VERCEL_CLEANUP_TIMEOUT_MS = 120_000;

interface RunningVercel {
  sandbox: Sandbox;
  command: Command;
  result: CommandFinished | null;
  context: AttemptContext;
}

export interface VercelSandboxBackendOptions {
  repository: string;
  modelCredentialName?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  createVisibilityAttempts?: number;
  createVisibilityDelayMs?: number;
  cleanupTimeoutMs?: number;
  deadlineSignal?: (
    deadline: Date,
    failure: string,
  ) => {
    signal: AbortSignal;
    dispose: () => void;
  };
}

export class VercelResourceCleanupError extends ProviderResourceCleanupError {
  override readonly name = "VercelResourceCleanupError";
  readonly resourceName: string;
  readonly operation: string;
  override readonly cause: string;

  constructor(options: {
    resourceName: string;
    operation: string;
    cause: unknown;
    priorFailure?: unknown;
  }) {
    const cause = options.cause instanceof Error ? options.cause.message : String(options.cause);
    const prior =
      options.priorFailure === undefined
        ? ""
        : ` The preceding operation also failed: ${options.priorFailure instanceof Error ? options.priorFailure.message : String(options.priorFailure)}.`;
    super(
      `Vercel sandbox ${options.resourceName} cleanup was not confirmed during ${options.operation}; ` +
        `automated replacement is blocked because the resource may still be billable. ` +
        `Cleanup error: ${cause}.${prior}`,
    );
    this.resourceName = options.resourceName;
    this.operation = options.operation;
    this.cause = cause;
  }
}

export class VercelSandboxBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities = {
    id: "codex-cli/vercel-sandbox",
    supportTier: "labs",
    agentKind: "codex-cli",
    runtimeKind: "vercel-sandbox",
    hostExecution: false,
    isolation: "microvm",
    supportedOs: ["linux"],
    supportedArchitectures: ["x64"],
    supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep", "python", "python3"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    supportsModelSelection: true,
    requiresPaidRuntime: true,
    providerManagedPublication: false,
    requiredCredentials: ["VERCEL_OIDC_TOKEN", "OPENAI_API_KEY"],
  };

  readonly #repository: string;
  readonly #modelCredential: string;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #createVisibilityAttempts: number;
  readonly #createVisibilityDelayMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #deadlineSignal: NonNullable<VercelSandboxBackendOptions["deadlineSignal"]>;
  readonly #running = new Map<string, RunningVercel>();

  constructor(options: VercelSandboxBackendOptions) {
    this.#repository = options.repository;
    this.#modelCredential = options.modelCredentialName ?? "OPENAI_API_KEY";
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    this.#createVisibilityAttempts = options.createVisibilityAttempts ?? 4;
    this.#createVisibilityDelayMs = options.createVisibilityDelayMs ?? 500;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_VERCEL_CLEANUP_TIMEOUT_MS;
    this.#deadlineSignal =
      options.deadlineSignal ??
      ((deadline, failure) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (): void => {
          const remaining = deadline.getTime() - this.#now();
          if (!Number.isFinite(remaining) || remaining <= 0) {
            controller.abort(new Error(failure));
            return;
          }
          timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
        };
        arm();
        return {
          signal: controller.signal,
          dispose: () => {
            if (timer) clearTimeout(timer);
          },
        };
      });
    if (!Number.isInteger(this.#createVisibilityAttempts) || this.#createVisibilityAttempts < 1)
      throw new Error("Vercel create visibility attempts must be a positive integer");
    if (!Number.isInteger(this.#createVisibilityDelayMs) || this.#createVisibilityDelayMs < 0)
      throw new Error("Vercel create visibility delay must be a non-negative integer");
    if (!Number.isSafeInteger(this.#cleanupTimeoutMs) || this.#cleanupTimeoutMs <= 0)
      throw new Error("Vercel cleanup timeout must be a positive safe integer");
  }

  async #withinDeadline<T>(
    deadline: Date,
    failure: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    remainingBeforeAttemptDeadline(deadline, failure, this.#now);
    const bound = this.#deadlineSignal(deadline, failure);
    let rejectDeadline!: (reason: unknown) => void;
    const deadlineElapsed = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const onAbort = (): void => rejectDeadline(bound.signal.reason ?? new Error(failure));
    try {
      if (bound.signal.aborted) throw bound.signal.reason ?? new Error(failure);
      bound.signal.addEventListener("abort", onAbort, { once: true });
      return await Promise.race([operation(bound.signal), deadlineElapsed]);
    } finally {
      bound.signal.removeEventListener("abort", onAbort);
      bound.dispose();
    }
  }

  async probe(): Promise<BackendProbe> {
    const provider = Boolean(process.env.VERCEL_OIDC_TOKEN);
    const model = Boolean(process.env[this.#modelCredential]);
    return {
      available: provider,
      authenticated: provider && model,
      ...(!provider
        ? { reason: "VERCEL_OIDC_TOKEN is not available" }
        : !model
          ? { reason: `${this.#modelCredential} is not available for the sandbox worker` }
          : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async probeValidation(): Promise<BackendProbe> {
    const available = Boolean(process.env.VERCEL_OIDC_TOKEN);
    return {
      available,
      authenticated: available,
      ...(!available ? { reason: "VERCEL_OIDC_TOKEN is not available" } : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    remainingBeforeAttemptDeadline(
      context.deadline,
      "attempt deadline exhausted before Vercel sandbox launch",
      this.#now,
    );
    const modelKey = process.env[this.#modelCredential];
    if (!modelKey) throw new Error(`${this.#modelCredential} is unavailable`);
    const lfs = await this.#withinDeadline(
      context.deadline,
      "attempt deadline exhausted during Vercel LFS inspection",
      () =>
        inspectPinnedLfs(this.#repository, context.packet.baseSha, {
          deadline: context.deadline,
          now: this.#now,
        }),
    );
    if (lfs.assets.length)
      throw new Error(
        "Vercel Labs source transport does not support LFS hydration; select a local backend",
      );
    const archive = await this.#withinDeadline(
      context.deadline,
      "attempt deadline exhausted during Vercel source archive preparation",
      (signal) =>
        repositoryArchive(this.#repository, context.packet.baseSha, {
          deadline: context.deadline,
          signal,
          now: this.#now,
        }),
    );
    const allow: Record<
      string,
      Array<{ transform: Array<{ headers: Record<string, string> }> }>
    > = {
      "registry.npmjs.org": [],
      "*.npmjs.org": [],
      "api.openai.com": [{ transform: [{ headers: { authorization: `Bearer ${modelKey}` } }] }],
    };
    for (const destination of context.packet.requirements.networkDestinations) {
      allow[destination] ??= [];
    }
    const networkPolicy: NetworkPolicy = { allow };
    const remainingMs = remainingBeforeAttemptDeadline(
      context.deadline,
      "attempt deadline exhausted before Vercel sandbox creation",
      this.#now,
    );
    const resourceName = sandboxResourceName(context);
    let sandbox: Sandbox;
    try {
      sandbox = await this.#withinDeadline(
        context.deadline,
        "attempt deadline exhausted during Vercel sandbox creation",
        (signal) =>
          Sandbox.create({
            name: resourceName,
            persistent: false,
            timeout: remainingMs,
            signal,
            networkPolicy,
            // The process sees only a placeholder. Vercel's network transformer
            // injects the actual credential on the permitted OpenAI destination.
            env: { [this.#modelCredential]: "factory-brokered", FACTORY_SUPERVISED: "1" },
            tags: {
              factory: "v2",
              objective: String(context.objective),
              workItem: String(context.workItem),
              attempt: String(context.attempt),
              run: context.runId.slice(0, 48),
            },
            ...(context.packet.requirements.cpu
              ? { resources: { vcpus: Math.ceil(context.packet.requirements.cpu) } }
              : {}),
          }),
      );
    } catch (error) {
      throw new VercelResourceCleanupError({
        resourceName,
        operation: "execution sandbox create result",
        cause: error,
      });
    }
    try {
      await this.#withinDeadline(
        context.deadline,
        "attempt deadline exhausted during Vercel source upload",
        (signal) =>
          sandbox.writeFiles(
            sandboxBootstrapFiles(context, archive).map((file) => ({
              path: file.path,
              content: file.content,
              ...(file.mode ? { mode: file.mode } : {}),
            })),
            { signal },
          ),
      );
      remainingBeforeAttemptDeadline(
        context.deadline,
        "attempt deadline exhausted before Vercel worker dispatch",
        this.#now,
      );
      const command = await this.#withinDeadline(
        context.deadline,
        "attempt deadline exhausted during Vercel worker dispatch",
        (signal) =>
          sandbox.runCommand({
            cmd: "bash",
            args: ["factory/run.sh"],
            detached: true,
            signal,
          }),
      );
      const running: RunningVercel = { sandbox, command, result: null, context };
      void command.wait().then(
        (result) => {
          running.result = result;
        },
        () => {},
      );
      const resourceId = sandbox.name;
      this.#running.set(resourceId, running);
      return {
        backendId: this.capabilities.id,
        resourceId,
        startedAt: new Date().toISOString(),
        metadata: { sandbox: sandbox.name, command: command.cmdId },
      };
    } catch (error) {
      await this.#stopSandbox(sandbox, "launch rollback", error);
      throw error;
    }
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const running = this.#require(handle);
    if (!running.result) return { state: "running", observedAt: new Date().toISOString() };
    const result = running.result;
    let failureReason = `sandbox exited ${result.exitCode}`;
    if (result.exitCode !== 0) {
      try {
        const stderr = await this.#withinDeadline(
          running.context.deadline,
          "attempt deadline exhausted during Vercel failed-command observation",
          (signal) => result.stderr({ signal }),
        );
        if (stderr) failureReason = stderr.slice(0, 8_000);
      } catch {
        // The terminal exit code is authoritative. Diagnostic retrieval is
        // optional and must not hide that known terminal state.
      }
    }
    return {
      state: result.exitCode === 0 ? "succeeded" : "failed",
      observedAt: new Date().toISOString(),
      ...(result.exitCode === 0 ? {} : { reason: failureReason }),
    };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const running = this.#require(handle);
    void this.#withinDeadline(
      new Date(this.#now() + this.#cleanupTimeoutMs),
      `Vercel command termination exceeded its ${this.#cleanupTimeoutMs} ms cleanup operation bound`,
      (signal) => running.command.kill("SIGTERM", { abortSignal: signal }),
    ).catch(() => {});
    await this.#stopSandbox(running.sandbox, "cancellation");
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const running = this.#require(handle);
    const read = (path: string): Promise<Buffer | null> =>
      this.#withinDeadline(
        running.context.deadline,
        "attempt deadline exhausted during Vercel artifact collection",
        (signal) => running.sandbox.readFileToBuffer({ path }, { signal }),
      );
    const [patch, paths, exit, stdout, stderr] = await Promise.all([
      read("factory/artifact.patch"),
      read("factory/changed-paths"),
      read("factory/exit-code"),
      read("factory/worker.stdout"),
      read("factory/worker.stderr"),
    ]);
    if (!patch || !paths || !exit)
      throw new Error("sandbox did not produce the artifact contract files");
    const exitCode = Number(exit.toString("utf8"));
    const patchText = patch.toString("utf8");
    const outcome =
      exitCode === 0 && patchText.trim() ? "succeeded" : patchText.trim() ? "failed" : "declined";
    return normalizeArtifact({
      baseSha: running.context.packet.baseSha,
      patch: patchText,
      changedPaths: parseSandboxPaths(paths),
      logs: `${stdout?.toString("utf8") ?? ""}\n${stderr?.toString("utf8") ?? ""}`,
      outcome,
      ...(outcome === "succeeded" ? {} : { reason: `sandbox worker exited ${exitCode}` }),
    });
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    const running = this.#require(handle);
    await this.#stopSandbox(running.sandbox, "final cleanup");
    this.#running.delete(handle.resourceId);
  }

  async validate(context: IsolatedValidationContext): Promise<IsolatedValidationResult> {
    remainingBeforeAttemptDeadline(
      context.deadline,
      "validation deadline exhausted before Vercel sandbox launch",
      this.#now,
    );
    if (context.artifact.payload)
      throw new Error(
        "Labs Vercel validation does not support the content-addressed large-artifact channel; select Daytona or local validation",
      );
    const lfs = await this.#withinDeadline(
      context.deadline,
      "validation deadline exhausted during Vercel LFS inspection",
      () =>
        inspectPinnedLfs(this.#repository, context.packet.baseSha, {
          deadline: context.deadline,
          now: this.#now,
        }),
    );
    if (lfs.assets.length)
      throw new Error(
        "Vercel Labs validation does not support LFS hydration; select a local validator",
      );
    const archive = await this.#withinDeadline(
      context.deadline,
      "validation deadline exhausted during Vercel source archive preparation",
      (signal) =>
        repositoryArchive(this.#repository, context.packet.baseSha, {
          deadline: context.deadline,
          signal,
          now: this.#now,
        }),
    );
    const allow: Record<string, never[]> = {
      "registry.npmjs.org": [],
      "*.npmjs.org": [],
    };
    for (const destination of context.packet.requirements.networkDestinations) {
      allow[destination] ??= [];
    }
    const remainingMs = remainingBeforeAttemptDeadline(
      context.deadline,
      "validation deadline exhausted before Vercel sandbox creation",
      this.#now,
    );
    const resourceName = sandboxResourceName(context, "validation");
    let sandbox: Sandbox;
    try {
      sandbox = await this.#withinDeadline(
        context.deadline,
        "validation deadline exhausted during Vercel sandbox creation",
        (signal) =>
          Sandbox.create({
            name: resourceName,
            persistent: false,
            timeout: remainingMs,
            signal,
            networkPolicy: { allow },
            env: { FACTORY_SUPERVISED: "1" },
            tags: {
              factory: "v2",
              phase: "validation",
              objective: String(context.objective),
              workItem: String(context.workItem),
              attempt: String(context.attempt),
              run: context.runId.slice(0, 48),
            },
            ...(context.packet.requirements.cpu
              ? { resources: { vcpus: Math.ceil(context.packet.requirements.cpu) } }
              : {}),
          }),
      );
    } catch (error) {
      throw new VercelResourceCleanupError({
        resourceName,
        operation: "validation sandbox create result",
        cause: error,
      });
    }
    let validationFailure: unknown;
    try {
      await this.#withinDeadline(
        context.deadline,
        "validation deadline exhausted during Vercel source upload",
        (signal) =>
          sandbox.writeFiles(
            sandboxValidationFiles(context, archive).map((file) => ({
              path: file.path,
              content: file.content,
              ...(file.mode ? { mode: file.mode } : {}),
            })),
            { signal },
          ),
      );
      remainingBeforeAttemptDeadline(
        context.deadline,
        "validation deadline exhausted before Vercel command dispatch",
        this.#now,
      );
      const command = await this.#withinDeadline(
        context.deadline,
        "validation deadline exhausted during Vercel command dispatch",
        (signal) =>
          sandbox.runCommand({
            cmd: "node",
            args: ["factory/validate.mjs"],
            detached: true,
            signal,
          }),
      );
      const finished = await this.#withinDeadline(
        context.deadline,
        "validation deadline exhausted while waiting for Vercel command completion",
        () => command.wait(),
      );
      if (finished.exitCode !== 0) {
        const detail = await this.#withinDeadline(
          context.deadline,
          "validation deadline exhausted during Vercel error collection",
          (signal) =>
            sandbox.readFileToBuffer({ path: "factory/validation-error.txt" }, { signal }),
        ).catch(() => null);
        const diagnostic = detail?.toString("utf8").slice(0, 8_000) ?? "";
        const stderr = diagnostic
          ? ""
          : (
              await this.#withinDeadline(
                context.deadline,
                "validation deadline exhausted during Vercel stderr collection",
                () => finished.stderr(),
              )
            ).slice(0, 8_000);
        throw new Error(diagnostic || stderr || `isolated validator exited ${finished.exitCode}`);
      }
      const result = await this.#withinDeadline(
        context.deadline,
        "validation deadline exhausted during Vercel result collection",
        (signal) =>
          sandbox.readFileToBuffer({ path: "factory/validation-result.json" }, { signal }),
      );
      if (!result) throw new Error("isolated validator produced no result");
      return parseIsolatedValidationResult(result);
    } catch (error) {
      validationFailure = error;
      throw error;
    } finally {
      await this.#stopSandbox(sandbox, "validation cleanup", validationFailure);
    }
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    const resourceName = sandboxResourceName(identity);
    const replacementNotBefore = this.#replacementFence(identity);
    let sandbox: Sandbox | undefined;
    for (let attempt = 0; attempt < this.#createVisibilityAttempts; attempt += 1) {
      try {
        sandbox = await this.#withinDeadline(
          new Date(this.#now() + this.#cleanupTimeoutMs),
          `Vercel sandbox visibility lookup exceeded its ${this.#cleanupTimeoutMs} ms cleanup operation bound`,
          () => Sandbox.get({ name: resourceName }),
        );
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/\b(?:404|not[ -]?found)\b/i.test(message)) {
          throw new VercelResourceCleanupError({
            resourceName,
            operation: "stale-resource lookup",
            cause: error,
          });
        }
        if (attempt + 1 < this.#createVisibilityAttempts) {
          await this.#sleep(this.#createVisibilityDelayMs);
        }
      }
    }
    if (!sandbox) {
      if (replacementNotBefore === undefined || this.#now() >= replacementNotBefore) return;
      throw new VercelResourceCleanupError({
        resourceName,
        operation: "durable no-handle replacement fence",
        cause: `bounded visibility checks still report absence; replacement is unsafe until ${new Date(replacementNotBefore).toISOString()} and a subsequent absence check`,
      });
    }
    await this.#stopSandbox(sandbox, "stale-resource reconciliation");
  }

  #replacementFence(identity: StaleAttemptIdentity): number | undefined {
    if (identity.providerResourceId || identity.noHandleReplacementNotBefore === undefined)
      return undefined;
    const value = Date.parse(identity.noHandleReplacementNotBefore);
    if (!Number.isFinite(value)) {
      throw new VercelResourceCleanupError({
        resourceName: sandboxResourceName(identity),
        operation: "durable no-handle replacement fence",
        cause: "replacement fence is invalid",
      });
    }
    return value;
  }

  async #stopSandbox(sandbox: Sandbox, operation: string, priorFailure?: unknown): Promise<void> {
    try {
      await this.#withinDeadline(
        new Date(this.#now() + this.#cleanupTimeoutMs),
        `Vercel sandbox stop confirmation exceeded its ${this.#cleanupTimeoutMs} ms cleanup operation bound`,
        (signal) => sandbox.stop({ signal }),
      );
    } catch (error) {
      throw new VercelResourceCleanupError({
        resourceName: sandbox.name,
        operation,
        cause: error,
        ...(priorFailure === undefined ? {} : { priorFailure }),
      });
    }
  }

  #require(handle: BackendHandle): RunningVercel {
    if (handle.backendId !== this.capabilities.id)
      throw new Error(`handle belongs to ${handle.backendId}`);
    const running = this.#running.get(handle.resourceId);
    if (!running) throw new Error(`unknown Vercel sandbox ${handle.resourceId}`);
    return running;
  }
}
