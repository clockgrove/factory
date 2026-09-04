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
import { normalizeArtifact, type NormalizedArtifact } from "../execution/artifacts.js";
import {
  parseSandboxPaths,
  parseIsolatedValidationResult,
  repositoryArchive,
  sandboxBootstrapFiles,
  sandboxResourceName,
  sandboxValidationFiles,
} from "./sandbox-common.js";

interface RunningVercel {
  sandbox: Sandbox;
  command: Command;
  result: CommandFinished | null;
  context: AttemptContext;
}

export interface VercelSandboxBackendOptions {
  repository: string;
  modelCredentialName?: string;
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
  readonly #running = new Map<string, RunningVercel>();

  constructor(options: VercelSandboxBackendOptions) {
    this.#repository = options.repository;
    this.#modelCredential = options.modelCredentialName ?? "OPENAI_API_KEY";
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
    const modelKey = process.env[this.#modelCredential];
    if (!modelKey) throw new Error(`${this.#modelCredential} is unavailable`);
    const archive = await repositoryArchive(this.#repository, context.packet.baseSha);
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
    const sandbox = await Sandbox.create({
      name: sandboxResourceName(context),
      persistent: false,
      timeout: Math.max(1, context.deadline.getTime() - Date.now()),
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
    });
    try {
      await sandbox.writeFiles(
        sandboxBootstrapFiles(context, archive).map((file) => ({
          path: file.path,
          content: file.content,
          ...(file.mode ? { mode: file.mode } : {}),
        })),
      );
      const command = await sandbox.runCommand({
        cmd: "bash",
        args: ["factory/run.sh"],
        detached: true,
      });
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
      await sandbox.stop().catch(() => {});
      throw error;
    }
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const running = this.#require(handle);
    if (!running.result) return { state: "running", observedAt: new Date().toISOString() };
    return {
      state: running.result.exitCode === 0 ? "succeeded" : "failed",
      observedAt: new Date().toISOString(),
      ...(running.result.exitCode === 0
        ? {}
        : {
            reason:
              (await running.result.stderr()).slice(0, 8_000) ||
              `sandbox exited ${running.result.exitCode}`,
          }),
    };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const running = this.#require(handle);
    await running.command.kill("SIGTERM").catch(() => {});
    await running.sandbox.stop().catch(() => {});
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const running = this.#require(handle);
    const [patch, paths, exit, stdout, stderr] = await Promise.all([
      running.sandbox.readFileToBuffer({ path: "factory/artifact.patch" }),
      running.sandbox.readFileToBuffer({ path: "factory/changed-paths" }),
      running.sandbox.readFileToBuffer({ path: "factory/exit-code" }),
      running.sandbox.readFileToBuffer({ path: "factory/worker.stdout" }),
      running.sandbox.readFileToBuffer({ path: "factory/worker.stderr" }),
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
    this.#running.delete(handle.resourceId);
    await running.sandbox.stop().catch(() => {});
  }

  async validate(context: IsolatedValidationContext): Promise<IsolatedValidationResult> {
    const archive = await repositoryArchive(this.#repository, context.packet.baseSha);
    const allow: Record<string, never[]> = {
      "registry.npmjs.org": [],
      "*.npmjs.org": [],
    };
    for (const destination of context.packet.requirements.networkDestinations) {
      allow[destination] ??= [];
    }
    const sandbox = await Sandbox.create({
      name: sandboxResourceName(context, "validation"),
      persistent: false,
      timeout: Math.max(1, context.deadline.getTime() - Date.now()),
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
    });
    try {
      await sandbox.writeFiles(
        sandboxValidationFiles(context, archive).map((file) => ({
          path: file.path,
          content: file.content,
          ...(file.mode ? { mode: file.mode } : {}),
        })),
      );
      const command = await sandbox.runCommand({
        cmd: "node",
        args: ["factory/validate.mjs"],
        detached: true,
      });
      const finished = await command.wait();
      if (finished.exitCode !== 0) {
        const detail = await sandbox
          .readFileToBuffer({ path: "factory/validation-error.txt" })
          .catch(() => null);
        throw new Error(
          detail?.toString("utf8").slice(0, 8_000) ||
            (await finished.stderr()).slice(0, 8_000) ||
            `isolated validator exited ${finished.exitCode}`,
        );
      }
      const result = await sandbox.readFileToBuffer({
        path: "factory/validation-result.json",
      });
      if (!result) throw new Error("isolated validator produced no result");
      return parseIsolatedValidationResult(result);
    } finally {
      await sandbox.stop().catch(() => {});
    }
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    try {
      const sandbox = await Sandbox.get({
        name: sandboxResourceName(identity),
      });
      await sandbox.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:404|not[ -]?found)\b/i.test(message)) return;
      throw new Error(`could not reconcile stale Vercel sandbox: ${message}`);
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
