import { Daytona, type Sandbox } from "@daytona/sdk";

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
  sandboxIdentity,
  sandboxValidationFiles,
} from "./sandbox-common.js";

interface RunningDaytona {
  sandbox: Sandbox;
  result: Awaited<ReturnType<Sandbox["process"]["executeCommand"]>> | null;
  error: unknown;
  context: AttemptContext;
}

export interface DaytonaBackendOptions {
  repository: string;
  modelCredentialName?: string;
  daytonaSecretName?: string;
  image?: string;
}

export class DaytonaBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities = {
    id: "codex-cli/daytona",
    agentKind: "codex-cli",
    runtimeKind: "daytona",
    hostExecution: false,
    isolation: "container",
    supportedOs: ["linux"],
    supportedArchitectures: ["x64", "arm64"],
    supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    requiresPaidRuntime: true,
    providerManagedPublication: false,
    requiredCredentials: ["DAYTONA_API_KEY", "FACTORY_DAYTONA_MODEL_SECRET"],
  };

  readonly #repository: string;
  readonly #modelCredential: string;
  readonly #secretName: string | undefined;
  readonly #image: string;
  readonly #running = new Map<string, RunningDaytona>();

  constructor(options: DaytonaBackendOptions) {
    this.#repository = options.repository;
    this.#modelCredential = options.modelCredentialName ?? "OPENAI_API_KEY";
    this.#secretName = options.daytonaSecretName ?? process.env.FACTORY_DAYTONA_MODEL_SECRET;
    this.#image = options.image ?? "node:22-bookworm";
  }

  async probe(): Promise<BackendProbe> {
    const provider = Boolean(
      process.env.DAYTONA_API_KEY ||
        (process.env.DAYTONA_JWT_TOKEN && process.env.DAYTONA_ORGANIZATION_ID),
    );
    return {
      available: provider,
      authenticated: provider && Boolean(this.#secretName),
      ...(!provider
        ? { reason: "Daytona authentication is not available" }
        : !this.#secretName
          ? { reason: "FACTORY_DAYTONA_MODEL_SECRET does not name a Daytona organization Secret" }
          : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async probeValidation(): Promise<BackendProbe> {
    const available = Boolean(
      process.env.DAYTONA_API_KEY ||
        (process.env.DAYTONA_JWT_TOKEN && process.env.DAYTONA_ORGANIZATION_ID),
    );
    return {
      available,
      authenticated: available,
      ...(!available ? { reason: "Daytona authentication is not available" } : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    if (!this.#secretName) throw new Error("Daytona model Secret is not configured");
    const archive = await repositoryArchive(this.#repository, context.packet.baseSha);
    const ttlMinutes = Math.max(
      1,
      Math.ceil((context.deadline.getTime() - Date.now()) / 60_000),
    );
    const domains = [
      "registry.npmjs.org",
      "*.npmjs.org",
      "api.openai.com",
      ...context.packet.requirements.networkDestinations,
    ];
    const daytona = new Daytona();
    const sandbox = await daytona.create(
      {
        name: sandboxIdentity(context),
        image: this.#image,
        ephemeral: true,
        autoDeleteInterval: 0,
        ttlMinutes,
        domainAllowList: [...new Set(domains)].join(","),
        labels: {
          factory: "v2",
          objective: String(context.objective),
          workItem: String(context.workItem),
          attempt: String(context.attempt),
          run: context.runId.slice(0, 48),
        },
        secrets: { [this.#modelCredential]: this.#secretName },
        envVars: { FACTORY_SUPERVISED: "1" },
        ...(context.packet.requirements.cpu ||
        context.packet.requirements.memoryMb ||
        context.packet.requirements.diskMb
          ? {
              resources: {
                ...(context.packet.requirements.cpu
                  ? { cpu: context.packet.requirements.cpu }
                  : {}),
                ...(context.packet.requirements.memoryMb
                  ? { memory: context.packet.requirements.memoryMb / 1024 }
                  : {}),
                ...(context.packet.requirements.diskMb
                  ? { disk: context.packet.requirements.diskMb / 1024 }
                  : {}),
              },
            }
          : {}),
      },
      { timeout: 120 },
    );
    try {
      await sandbox.fs.createFolder("factory", "700");
      await sandbox.fs.uploadFiles(
        sandboxBootstrapFiles(context, archive).map((file) => ({
          source: file.content,
          destination: file.path,
        })),
      );
      const running: RunningDaytona = { sandbox, result: null, error: null, context };
      const workdir = await sandbox.getWorkDir();
      void sandbox.process
        .executeCommand(
          "bash factory/run.sh",
          workdir,
          undefined,
          Math.max(1, Math.ceil((context.deadline.getTime() - Date.now()) / 1000)),
        )
        .then(
          (result) => {
            running.result = result;
          },
          (error) => {
            running.error = error;
          },
        );
      this.#running.set(sandbox.id, running);
      return {
        backendId: this.capabilities.id,
        resourceId: sandbox.id,
        startedAt: new Date().toISOString(),
        metadata: { sandbox: sandbox.id },
      };
    } catch (error) {
      await sandbox.delete(60, true).catch(() => {});
      throw error;
    }
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const running = this.#require(handle);
    if (running.error) {
      return {
        state: "failed",
        observedAt: new Date().toISOString(),
        reason: running.error instanceof Error ? running.error.message : String(running.error),
      };
    }
    if (!running.result) return { state: "running", observedAt: new Date().toISOString() };
    return {
      state: running.result.exitCode === 0 ? "succeeded" : "failed",
      observedAt: new Date().toISOString(),
      ...(running.result.exitCode === 0
        ? {}
        : { reason: running.result.result.slice(0, 8_000) || `sandbox exited ${running.result.exitCode}` }),
    };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    await this.#require(handle).sandbox.delete(60, true).catch(() => {});
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const running = this.#require(handle);
    const [patch, paths, exit, stdout, stderr] = await Promise.all([
      running.sandbox.fs.downloadFile("factory/artifact.patch"),
      running.sandbox.fs.downloadFile("factory/changed-paths"),
      running.sandbox.fs.downloadFile("factory/exit-code"),
      running.sandbox.fs.downloadFile("factory/worker.stdout"),
      running.sandbox.fs.downloadFile("factory/worker.stderr"),
    ]);
    const exitCode = Number(exit.toString("utf8"));
    const patchText = patch.toString("utf8");
    const outcome = exitCode === 0 && patchText.trim() ? "succeeded" : patchText.trim() ? "failed" : "declined";
    return normalizeArtifact({
      baseSha: running.context.packet.baseSha,
      patch: patchText,
      changedPaths: parseSandboxPaths(paths),
      logs: `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`,
      outcome,
      ...(outcome === "succeeded" ? {} : { reason: `sandbox worker exited ${exitCode}` }),
    });
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    const running = this.#require(handle);
    this.#running.delete(handle.resourceId);
    await running.sandbox.delete(60, true).catch(() => {});
  }

  async validate(context: IsolatedValidationContext): Promise<IsolatedValidationResult> {
    const archive = await repositoryArchive(this.#repository, context.packet.baseSha);
    const ttlMinutes = Math.max(
      1,
      Math.ceil((context.deadline.getTime() - Date.now()) / 60_000),
    );
    const domains = [
      "registry.npmjs.org",
      "*.npmjs.org",
      ...context.packet.requirements.networkDestinations,
    ];
    const daytona = new Daytona();
    const sandbox = await daytona.create(
      {
        name: `${sandboxIdentity(context).slice(0, 54)}-validate`,
        image: this.#image,
        ephemeral: true,
        autoDeleteInterval: 0,
        ttlMinutes,
        domainAllowList: [...new Set(domains)].join(","),
        labels: {
          factory: "v2",
          phase: "validation",
          objective: String(context.objective),
          workItem: String(context.workItem),
          attempt: String(context.attempt),
          run: context.runId.slice(0, 48),
        },
        envVars: { FACTORY_SUPERVISED: "1" },
        ...(context.packet.requirements.cpu ||
        context.packet.requirements.memoryMb ||
        context.packet.requirements.diskMb
          ? {
              resources: {
                ...(context.packet.requirements.cpu
                  ? { cpu: context.packet.requirements.cpu }
                  : {}),
                ...(context.packet.requirements.memoryMb
                  ? { memory: context.packet.requirements.memoryMb / 1024 }
                  : {}),
                ...(context.packet.requirements.diskMb
                  ? { disk: context.packet.requirements.diskMb / 1024 }
                  : {}),
              },
            }
          : {}),
      },
      { timeout: 120 },
    );
    try {
      await sandbox.fs.createFolder("factory", "700");
      await sandbox.fs.uploadFiles(
        sandboxValidationFiles(context, archive).map((file) => ({
          source: file.content,
          destination: file.path,
        })),
      );
      const workdir = await sandbox.getWorkDir();
      const result = await sandbox.process.executeCommand(
        "node factory/validate.mjs",
        workdir,
        undefined,
        Math.max(1, Math.ceil((context.deadline.getTime() - Date.now()) / 1000)),
      );
      if (result.exitCode !== 0) {
        const detail = await sandbox.fs
          .downloadFile("factory/validation-error.txt")
          .catch(() => null);
        throw new Error(
          detail?.toString("utf8").slice(0, 8_000) ||
            result.result.slice(0, 8_000) ||
            `isolated validator exited ${result.exitCode}`,
        );
      }
      return parseIsolatedValidationResult(
        await sandbox.fs.downloadFile("factory/validation-result.json"),
      );
    } finally {
      await sandbox.delete(60, true).catch(() => {});
    }
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    const daytona = new Daytona();
    try {
      const sandbox = await daytona.get(sandboxIdentity(identity));
      await sandbox.delete(60, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:404|not[ -]?found)\b/i.test(message)) return;
      throw new Error(`could not reconcile stale Daytona sandbox: ${message}`);
    }
  }

  #require(handle: BackendHandle): RunningDaytona {
    if (handle.backendId !== this.capabilities.id) throw new Error(`handle belongs to ${handle.backendId}`);
    const running = this.#running.get(handle.resourceId);
    if (!running) throw new Error(`unknown Daytona sandbox ${handle.resourceId}`);
    return running;
  }
}
