import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  assertContextLookupBounds,
  type ContextLookupBounds,
} from "./compiler/context.js";
import type { ProjectQueueBinding } from "./contracts.js";
import { validateClaudeManagedConfig } from "./execution/claude-managed.js";
import { validateOpenAIManagedConfig } from "./execution/openai-managed.js";
import {
  assertCommandSandboxConfig,
  type CommandSandboxConfig,
} from "./execution/sandbox.js";
import {
  assertGitHubProjectStatusConfig,
  type GitHubProjectStatusConfig,
} from "./github-project-state.js";
import {
  bindOrigin,
  originRepositories,
  validateLfsRouting,
} from "./origin-binding.js";
import {
  assertGitPersistenceConfig,
  type GitPersistenceConfig,
} from "./recovery-checkpoint.js";
import { type AutonomyConfig, resolveAutonomy } from "./repair-policy.js";
import {
  assertReviewArtifactSelectors,
  type ReviewArtifactSelector,
} from "./review-artifacts.js";
import { refuseUnknownFields } from "./unknown-fields.js";

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "persistent";

export type CodexServiceTier = "standard" | "fast";

export interface CodexModelSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  serviceTier?: CodexServiceTier;
}

export const DEFAULT_PLANNER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-6.1-sol",
  reasoningEffort: "high",
};

export const DEFAULT_REVIEWER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
};

export const DEFAULT_WORKER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
};

export const CLAUDE_AGENT_SDK_ADAPTER_IDENTITY =
  "@anthropic-ai/claude-agent-sdk@0.3.281";
export const GITHUB_COPILOT_SDK_ADAPTER_IDENTITY = "@github/copilot-sdk@1.0.13";

export type HarnessReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ClaudeSettingSource = "user" | "project" | "local";

export interface ClaudeAgentSdkConfig {
  kind: "claude-agent-sdk";
  model: string;
  reasoningEffort: HarnessReasoningEffort;
  permissionMode: "acceptEdits" | "dontAsk";
  settingSources: ClaudeSettingSource[];
  tools: string[];
  allowedTools: string[];
  maxTurns: number;
}

export interface GitHubCopilotSdkConfig {
  kind: "github-copilot-sdk";
  model: string;
  reasoningEffort: HarnessReasoningEffort;
  availableTools: string[];
  permissionKinds: ("read" | "write")[];
  timeoutSeconds: number;
}

/** The adapter identity a harness is recorded under; SDK harnesses are identified by the SDK Factory ships. */
export function harnessAdapterIdentity(harness: LocalHarnessConfig): string {
  switch (harness.kind) {
    case "codex-sdk":
      return harness.kind;
    case "claude-agent-sdk":
      return CLAUDE_AGENT_SDK_ADAPTER_IDENTITY;
    case "github-copilot-sdk":
      return GITHUB_COPILOT_SDK_ADAPTER_IDENTITY;
    case "registered":
      return harness.adapter;
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type LocalHarnessConfig =
  | ({ kind: "codex-sdk" } & CodexModelSelection)
  | ClaudeAgentSdkConfig
  | GitHubCopilotSdkConfig
  | {
      kind: "registered";
      /** Stable adapter identity. Include a version when behavior changes. */
      adapter: string;
      /** Opaque, JSON-safe configuration interpreted only by the adapter. */
      config: { [key: string]: JsonValue };
    };

export interface ExecutionProfileEnvironment {
  instructions?: string;
  mcp?: { kind: "factory-worktree-read"; version: 1 };
}

export interface ExecutionProfile {
  description: string;
  selectionHints?: string[];
  harness: LocalHarnessConfig;
  environment?: ExecutionProfileEnvironment;
}

export type ExecutionConfig =
  | {
      kind: "local";
      concurrency?: number;
      harness?: LocalHarnessConfig;
      defaultProfile?: string;
      profiles?: Record<string, ExecutionProfile>;
    }
  | {
      kind: "managed-agent";
      concurrency?: number;
      provider: "openai-agents" | "claude-managed-agents";
      config: { [key: string]: JsonValue };
    };

export interface ClaudeModelSelection {
  model: string;
  reasoningEffort: HarnessReasoningEffort;
}

/** The review calls whose reasoning effort `planning.reviewEffort` can set. */
export const REVIEW_EFFORT_PHASES = [
  "graph-review",
  "result-review",
  "objective-review",
] as const;
export type ReviewEffortPhase = (typeof REVIEW_EFFORT_PHASES)[number];

/** The reviewer selection for one call: its phase's `reviewEffort`, else the reviewer's own effort. */
export function reviewerSelection<T extends { reasoningEffort: string }>(
  reviewer: T,
  reviewEffort: Partial<Record<string, T["reasoningEffort"]>> | undefined,
  phase: string | undefined,
): T {
  const effort = phase === undefined ? undefined : reviewEffort?.[phase];
  return effort ? { ...reviewer, reasoningEffort: effort } : reviewer;
}

/** Planning and review run through one configured provider. */
export type PlanningConfig =
  | {
      kind: "codex-sdk";
      /** Exec planning reads pinned sources by default; app-server is tool-free. Tree reviews use exec. */
      codex?: {
        transport?: "exec" | "app-server";
        /** Source-only read profile; enabled by default for exec planning. */
        sourceArtifacts?: boolean;
      };
      planner: CodexModelSelection;
      reviewer: CodexModelSelection;
      /** Per review phase effort; an omitted phase uses `reviewer.reasoningEffort`. */
      reviewEffort?: Partial<Record<ReviewEffortPhase, CodexReasoningEffort>>;
    }
  | {
      /**
       * Claude through the pinned Agent SDK, authenticated by the operator's
       * Claude login (or CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY).
       */
      kind: "claude-agent-sdk";
      /** Output token ceiling for every planning and review call. */
      maxOutputTokens: number;
      planner: ClaudeModelSelection;
      reviewer: ClaudeModelSelection;
      /** Per review phase effort; an omitted phase uses `reviewer.reasoningEffort`. */
      reviewEffort?: Partial<Record<ReviewEffortPhase, HarnessReasoningEffort>>;
    };

export type ResourcePhase = "coding" | "validation" | "review" | "delivery";

export interface SchedulingConfig {
  cpu?: number;
  memoryMiB?: number;
  reviewConcurrency?: number;
  validationConcurrency?: number;
  phases?: Partial<Record<ResourcePhase, { cpu?: number; memoryMiB?: number }>>;
}

/**
 * Defaults sized from the host (`os.availableParallelism()`, `os.totalmem()`) whenever
 * `execution.concurrency` is omitted, recomputed each time the configuration is read so they
 * follow the host. Keep 2 CPUs and 4 GiB for the OS and controller and share the rest. A coding worker reserves
 * 2 CPUs and 2 GiB; validation (builds and tests) 4 CPUs and 4 GiB; review and delivery mostly
 * wait on remote APIs, so 0.5 CPU and 512 MiB. Each reservation is capped at the totals, and a
 * phase ceiling is how many of its reservations fit. Review allows two per coding worker.
 */
export function hostSchedulingDefaults(host: HostFacts): {
  concurrency: number;
  scheduling: Required<SchedulingConfig>;
} {
  const cpu = Math.max(1, host.cpus - 2);
  const memoryMiB = Math.max(
    1024,
    Math.floor(host.memoryBytes / 1024 ** 2) - 4096,
  );
  const reserve = (cpus: number, mib: number) => ({
    cpu: Math.min(cpus, cpu),
    memoryMiB: Math.min(mib, memoryMiB),
  });
  const phases = {
    coding: reserve(2, 2048),
    validation: reserve(4, 4096),
    review: reserve(0.5, 512),
    delivery: reserve(0.5, 512),
  };
  const fit = (phase: { cpu: number; memoryMiB: number }) =>
    Math.floor(Math.min(cpu / phase.cpu, memoryMiB / phase.memoryMiB));
  const concurrency = fit(phases.coding);
  return {
    concurrency,
    scheduling: {
      cpu,
      memoryMiB,
      reviewConcurrency: 2 * concurrency,
      validationConcurrency: fit(phases.validation),
      phases,
    },
  };
}

export interface FactoryConfig {
  /**
   * The queue's (default) provider when this configuration resolved another one. It binds
   * queue authority only; resolveProvider sets it and the configuration digest excludes it.
   */
  queueProvider?: { planning: PlanningConfig; execution: ExecutionConfig };
  /** Explicit Git destination and payload scope; omission is local-only retention. */
  gitPersistence?: GitPersistenceConfig;
  /** Explicit bounded retrieval admission; omission retains the static planner. */
  planningContext?: {
    enabled: true;
    bounds: ContextLookupBounds;
    /** Literal repository files or directory prefixes ending with a slash. */
    selectors: string[];
    /** Eligible retained knowledge in this same repository only. */
    memory?: boolean;
  };
  /** Explicit validation image/text proof selection; omission retains no artifacts. */
  reviewArtifacts?: ReviewArtifactSelector[];
  /**
   * GitHub presentation. Progress comments and Project status are on by default (see
   * `githubProgressSettings` and `githubProjectStatusSettings`); `{ enabled: false }` opts out.
   */
  githubManagement?: {
    projectStatus?: GitHubProjectStatusConfig | { enabled: false };
    progress?:
      | {
          enabled: true;
          repository: string;
          includeQuestions: boolean;
        }
      | { enabled: false };
  };
  scheduling?: SchedulingConfig;
  /** Limits on unattended repair and amendment; omitted fields use bounded defaults. */
  autonomy?: AutonomyConfig;
  /** Explicit local sensitive-content opt-in; absent remains disabled. */
  capture?: {
    enabled: boolean;
    maxBytesPerInvocation: number;
    nativeBoundaryTelemetry?: boolean;
    /** Explicit recovery retention of already redacted/truncated captures. */
    retainInRecovery?: boolean;
  };
  /** Project scheduling authority; polling is observational. */
  queue?: {
    pollSeconds: number;
    objectiveDeadlineSeconds?: number;
    /**
     * How many queued Objectives may run at once (default 1). Operational:
     * outside both digests, so changing it strands no started Objective or
     * queue receipt.
     */
    maxActiveObjectives?: number;
    project?: ProjectQueueBinding;
  };
  schemaVersion: 1;
  repository: string;
  checkout: string;
  planning: PlanningConfig;
  execution: ExecutionConfig;
  delivery: { kind: "regular" | "native-stack" };
  policy: {
    network: "host" | "off";
    allowedSecretNames: string[];
  };
  /**
   * The OS sandbox worker-caused commands run in (validation, setup, probes,
   * a worker's shell). Omitted: required, network off, no shared store.
   */
  sandbox?: CommandSandboxConfig;
}

const codexReasoningEfforts = new Set<CodexReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);
const harnessReasoningEfforts = new Set<HarnessReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const claudeSettingSources = new Set<ClaudeSettingSource>([
  "user",
  "project",
  "local",
]);
const claudeFileTools = new Set(["Read", "Edit", "Write", "Glob", "Grep"]);
/** A Claude worker tool that runs only the item's declared validation. */
export const validateToolConfigName = "Validate";
const copilotFileTools = new Set([
  "view",
  "create",
  "edit",
  "apply_patch",
  "grep",
  "glob",
]);

const factoryRepositories = new Set(["clockgrove/factory"]);

function isFactorySource(checkout: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    ) as { name?: string };
    return manifest.name === "@clockgrove/factory";
  } catch {
    return false;
  }
}

function assertObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

const localExecutionKeys = [
  "kind",
  "concurrency",
  "harness",
  "profiles",
  "defaultProfile",
];

const assertOnlyKeys = refuseUnknownFields;

function assertJsonValue(
  value: unknown,
  name: string,
  seen = new Set<unknown>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} must be JSON-safe`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${name} must be JSON-safe`);
  if (seen.has(value)) throw new Error(`${name} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertJsonValue(entry, `${name}[${index}]`, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error(`${name} must contain only JSON objects`);
    for (const [key, entry] of Object.entries(value))
      assertJsonValue(entry, `${name}.${key}`, seen);
  }
  seen.delete(value);
}

function assertCodexModelSelection(
  value: unknown,
  name: string,
  allowed = ["model", "reasoningEffort", "serviceTier"],
): asserts value is CodexModelSelection {
  assertObject(value, name);
  assertOnlyKeys(value, allowed, name);
  if (typeof value.model !== "string" || value.model.trim().length === 0)
    throw new Error(`${name}.model must be a non-empty string`);
  if (
    typeof value.reasoningEffort !== "string" ||
    !codexReasoningEfforts.has(value.reasoningEffort as CodexReasoningEffort)
  )
    throw new Error(`${name}.reasoningEffort is unsupported`);
  if (
    value.serviceTier !== undefined &&
    !["standard", "fast"].includes(value.serviceTier as string)
  )
    throw new Error(`${name}.serviceTier is unsupported`);
}

function assertClaudeModelSelection(
  value: unknown,
  name: string,
): asserts value is ClaudeModelSelection {
  assertObject(value, name);
  assertOnlyKeys(value, ["model", "reasoningEffort"], name);
  if (typeof value.model !== "string" || value.model.trim().length === 0)
    throw new Error(`${name}.model must be a non-empty string`);
  if (
    typeof value.reasoningEffort !== "string" ||
    !harnessReasoningEfforts.has(
      value.reasoningEffort as HarnessReasoningEffort,
    )
  )
    throw new Error(`${name}.reasoningEffort is unsupported`);
}

function assertReviewEffort(value: unknown, efforts: Set<string>): void {
  if (value === undefined) return;
  assertObject(value, "planning.reviewEffort");
  assertOnlyKeys(value, [...REVIEW_EFFORT_PHASES], "planning.reviewEffort");
  for (const [phase, effort] of Object.entries(value))
    if (typeof effort !== "string" || !efforts.has(effort))
      throw new Error(`planning.reviewEffort.${phase} is unsupported`);
}

export function validatePlanning(
  value: unknown,
): asserts value is FactoryConfig["planning"] {
  assertObject(value, "planning");
  if (value.kind === "codex-sdk") {
    assertOnlyKeys(
      value,
      ["kind", "codex", "planner", "reviewer", "reviewEffort"],
      "planning",
    );
    if (value.codex !== undefined) {
      assertObject(value.codex, "planning.codex");
      assertOnlyKeys(
        value.codex,
        ["transport", "sourceArtifacts"],
        "planning.codex",
      );
      if (
        value.codex.transport !== undefined &&
        value.codex.transport !== "exec" &&
        value.codex.transport !== "app-server"
      )
        throw new Error("planning.codex.transport must be exec or app-server");
      if (
        value.codex.sourceArtifacts !== undefined &&
        typeof value.codex.sourceArtifacts !== "boolean"
      )
        throw new Error("planning.codex.sourceArtifacts must be boolean");
      if (
        value.codex.sourceArtifacts === true &&
        value.codex.transport === "app-server"
      )
        throw new Error("Planning source artifacts require the exec transport");
    }
    assertCodexModelSelection(value.planner, "planning.planner");
    assertCodexModelSelection(value.reviewer, "planning.reviewer");
    assertReviewEffort(value.reviewEffort, codexReasoningEfforts);
    return;
  }
  if (value.kind !== "claude-agent-sdk")
    throw new Error("Unsupported planning model");
  assertOnlyKeys(
    value,
    ["kind", "maxOutputTokens", "planner", "reviewer", "reviewEffort"],
    "planning",
  );
  if (
    !Number.isSafeInteger(value.maxOutputTokens) ||
    (value.maxOutputTokens as number) <= 0
  )
    throw new Error("planning.maxOutputTokens must be a positive integer");
  assertClaudeModelSelection(value.planner, "planning.planner");
  assertClaudeModelSelection(value.reviewer, "planning.reviewer");
  assertReviewEffort(value.reviewEffort, harnessReasoningEfforts);
}

function assertUniqueStrings(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    )
  )
    throw new Error(`${name} must be an array of non-empty strings`);
  if (new Set(value).size !== value.length)
    throw new Error(`${name} must not contain duplicates`);
  return value as string[];
}

/** Factory's git wrapper needs `rev-parse --path-format` and GIT_CONFIG_COUNT (Git 2.31). */
export function assertSupportedGit(): void {
  let output: string;
  try {
    output = execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("git is not installed on the controller host");
  }
  const version = /^git version (\d+)\.(\d+)/.exec(output);
  const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
  if (!version || major < 2 || (major === 2 && minor < 31))
    throw new Error(
      `Factory requires Git 2.31 or later; the controller host has ${output}`,
    );
}

export function validateTarget(repository: string, checkout: string): void {
  assertSupportedGit();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be an owner/name GitHub repository");
  }
  if (!isAbsolute(checkout) || !existsSync(checkout)) {
    throw new Error("checkout must be an existing absolute directory");
  }
  const actual = realpathSync(checkout);
  const repo = repository.toLowerCase();
  if (factoryRepositories.has(repo) || isFactorySource(actual)) {
    throw new Error(
      "Factory cannot be installed or run against a Factory repository",
    );
  }
  let root: string;
  try {
    root = execFileSync("git", ["-C", actual, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("checkout must be a Git repository");
  }
  if (isFactorySource(root))
    throw new Error(
      "Factory cannot be installed or run against a Factory repository",
    );
  for (const push of [false, true]) {
    for (const remote of originRepositories(actual, push)) {
      if (factoryRepositories.has(remote))
        throw new Error(
          "Factory cannot be installed or run against a Factory repository",
        );
      if (remote !== repo)
        throw new Error(
          `Origin ${push ? "push" : "fetch"} repository does not match configured repository ${repo}; correct the remote binding before using Factory`,
        );
    }
  }
  validateLfsRouting(root);
  // Factory's remote git commands re-verify this binding every time.
  bindOrigin(root, repo);
}

/** Validate declared scheduling reservations; also used for the copy stored in state. */
export function validateScheduling(
  scheduling: unknown,
): asserts scheduling is SchedulingConfig {
  assertObject(scheduling, "scheduling");
  assertOnlyKeys(
    scheduling,
    [
      "cpu",
      "memoryMiB",
      "reviewConcurrency",
      "validationConcurrency",
      "phases",
    ],
    "scheduling",
  );
  for (const key of [
    "cpu",
    "memoryMiB",
    "reviewConcurrency",
    "validationConcurrency",
  ]) {
    const amount = scheduling[key];
    if (
      amount !== undefined &&
      (typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        (key.endsWith("Concurrency") && !Number.isSafeInteger(amount)))
    )
      throw new Error(
        `scheduling.${key} must be a positive finite reservation or integer ceiling`,
      );
  }
  if (scheduling.phases !== undefined) {
    assertObject(scheduling.phases, "scheduling.phases");
    assertOnlyKeys(
      scheduling.phases,
      ["coding", "validation", "review", "delivery"],
      "scheduling.phases",
    );
    for (const [phase, declaration] of Object.entries(scheduling.phases)) {
      assertObject(declaration, `scheduling.phases.${phase}`);
      assertOnlyKeys(
        declaration,
        ["cpu", "memoryMiB"],
        `scheduling.phases.${phase}`,
      );
      for (const key of ["cpu", "memoryMiB"])
        if (
          declaration[key] !== undefined &&
          (typeof declaration[key] !== "number" ||
            !Number.isFinite(declaration[key]) ||
            Number(declaration[key]) < 0)
        )
          throw new Error(
            `scheduling.phases.${phase}.${key} must be a nonnegative finite reservation`,
          );
    }
  }
  for (const key of ["cpu", "memoryMiB"]) {
    if (scheduling[key] === undefined) continue;
    const phases = scheduling.phases as
      | Record<string, Record<string, number>>
      | undefined;
    for (const phase of ["coding", "validation", "review", "delivery"])
      if (
        phases?.[phase]?.[key] === undefined ||
        phases[phase]![key]! > Number(scheduling[key])
      )
        throw new Error(
          `Binding scheduling.${key} requires a fitting declaration for every phase; missing capacity is unknown`,
        );
  }
}

export function validateConfig(value: unknown): FactoryConfig {
  assertObject(value, "configuration");
  if (value.schemaVersion !== 1)
    throw new Error("Only Factory schemaVersion 1 is supported");
  if (
    typeof value.repository !== "string" ||
    typeof value.checkout !== "string"
  ) {
    throw new Error("repository and checkout are required");
  }
  assertOnlyKeys(
    value,
    [
      "schemaVersion",
      "repository",
      "checkout",
      "planning",
      "scheduling",
      "autonomy",
      "capture",
      "execution",
      "delivery",
      "policy",
      "queue",
      "githubManagement",
      "reviewArtifacts",
      "planningContext",
      "gitPersistence",
      "queueProvider",
      "sandbox",
    ],
    "configuration",
  );
  if (value.sandbox !== undefined) assertCommandSandboxConfig(value.sandbox);
  if (value.queueProvider !== undefined) {
    assertObject(value.queueProvider, "queueProvider");
    assertOnlyKeys(
      value.queueProvider,
      ["planning", "execution"],
      "queueProvider",
    );
  }
  assertReviewArtifactSelectors(value.reviewArtifacts);
  if (value.gitPersistence !== undefined)
    assertGitPersistenceConfig(value.gitPersistence);
  if (value.planningContext !== undefined) {
    assertObject(value.planningContext, "planningContext");
    const context = value.planningContext;
    assertOnlyKeys(
      context,
      ["enabled", "bounds", "selectors", "memory"],
      "planningContext",
    );
    if (context.enabled !== true)
      throw new Error(
        "planningContext.enabled must be true; omit the section to disable retrieval",
      );
    assertContextLookupBounds(context.bounds as ContextLookupBounds);
    const selectors = assertUniqueStrings(
      context.selectors,
      "planningContext.selectors",
    );
    if (
      !selectors.length ||
      selectors.length > 64 ||
      selectors.some(
        (selector) =>
          selector !== selector.trim() ||
          selector.startsWith("/") ||
          selector.includes("\\") ||
          selector
            .split("/")
            .some(
              (part, index, parts) =>
                part === "." ||
                part === ".." ||
                (!part && index !== parts.length - 1),
            ) ||
          Array.from(selector).some(
            (character) =>
              character.codePointAt(0)! < 32 ||
              character.codePointAt(0) === 127 ||
              "*?[]{}".includes(character),
          ),
      )
    )
      throw new Error(
        "planningContext.selectors requires 1–64 literal relative files or directory prefixes",
      );
    if (context.memory !== undefined && typeof context.memory !== "boolean")
      throw new Error("planningContext.memory must be a boolean");
  }
  validateTarget(value.repository, value.checkout);
  if (value.githubManagement !== undefined) {
    assertObject(value.githubManagement, "githubManagement");
    assertOnlyKeys(
      value.githubManagement,
      ["progress", "projectStatus"],
      "githubManagement",
    );
    const optedOut = (setting: unknown): boolean =>
      !!setting &&
      typeof setting === "object" &&
      !Array.isArray(setting) &&
      Object.keys(setting).length === 1 &&
      (setting as { enabled?: unknown }).enabled === false;
    if (
      value.githubManagement.projectStatus !== undefined &&
      !optedOut(value.githubManagement.projectStatus)
    )
      assertGitHubProjectStatusConfig(
        value.githubManagement.projectStatus,
        value.repository,
      );
    if (
      value.githubManagement.progress !== undefined &&
      !optedOut(value.githubManagement.progress)
    ) {
      assertObject(
        value.githubManagement.progress,
        "githubManagement.progress",
      );
      assertOnlyKeys(
        value.githubManagement.progress,
        ["enabled", "repository", "includeQuestions"],
        "githubManagement.progress",
      );
      if (
        value.githubManagement.progress.enabled !== true ||
        value.githubManagement.progress.repository !== value.repository ||
        typeof value.githubManagement.progress.includeQuestions !== "boolean"
      )
        throw new Error(
          "GitHub progress requires explicit target and question disclosure choices",
        );
    }
  }
  validatePlanning(value.planning);
  if (value.scheduling !== undefined) validateScheduling(value.scheduling);
  assertObject(value.execution, "execution");
  if (
    value.execution.kind !== "local" &&
    value.execution.kind !== "managed-agent"
  ) {
    throw new Error(
      `Execution mode ${String(value.execution.kind)} is not implemented; select local`,
    );
  }
  if (
    value.execution.concurrency !== undefined &&
    (!Number.isSafeInteger(value.execution.concurrency) ||
      (value.execution.concurrency as number) <= 0)
  ) {
    throw new Error(
      "execution.concurrency must be a positive integer, or omitted to size from this host",
    );
  }
  if (value.execution.kind === "managed-agent") {
    assertOnlyKeys(
      value.execution,
      ["kind", "concurrency", "provider", "config"],
      "execution",
    );
    if (value.execution.provider === "openai-agents")
      validateOpenAIManagedConfig(value.execution.config);
    else if (value.execution.provider === "claude-managed-agents")
      validateClaudeManagedConfig(value.execution.config);
    else throw new Error("Unsupported managed execution provider");
  } else if (value.execution.profiles !== undefined) {
    assertOnlyKeys(value.execution, localExecutionKeys, "execution");
    if (value.execution.harness !== undefined)
      throw new Error(
        "execution.harness and execution.profiles are mutually exclusive",
      );
    assertObject(value.execution.profiles, "execution.profiles");
    const entries = Object.entries(value.execution.profiles);
    if (!entries.length)
      throw new Error("execution.profiles must not be empty");
    for (const [id, profile] of entries) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
        throw new Error("Invalid execution profile identifier");
      assertObject(profile, `execution.profiles.${id}`);
      assertOnlyKeys(
        profile,
        ["description", "selectionHints", "harness", "environment"],
        `execution.profiles.${id}`,
      );
      if (
        typeof profile.description !== "string" ||
        !profile.description.trim()
      )
        throw new Error("Execution profile description is required");
      if (profile.selectionHints !== undefined)
        assertUniqueStrings(profile.selectionHints, "profile.selectionHints");
      validateLocalHarness(profile.harness);
      if (profile.environment !== undefined) {
        const environment = profile.environment;
        assertObject(environment, "profile.environment");
        assertOnlyKeys(
          environment,
          ["instructions", "mcp"],
          "profile.environment",
        );
        if (profile.harness.kind === "registered")
          throw new Error(
            "Registered harness profile environments are not supported",
          );
        if (
          environment.instructions !== undefined &&
          (typeof environment.instructions !== "string" ||
            !environment.instructions.trim() ||
            environment.instructions.includes("\0"))
        )
          throw new Error(
            "Profile environment instructions must be nonempty text without NUL",
          );
        if (environment.mcp !== undefined) {
          assertObject(environment.mcp, "profile.environment.mcp");
          assertOnlyKeys(
            environment.mcp,
            ["kind", "version"],
            "profile.environment.mcp",
          );
          if (
            environment.mcp.kind !== "factory-worktree-read" ||
            environment.mcp.version !== 1
          )
            throw new Error("Unsupported profile MCP capability or version");
          if (
            profile.harness.kind !== "claude-agent-sdk" ||
            !profile.harness.tools.includes("Read") ||
            !profile.harness.allowedTools.includes("Read")
          )
            throw new Error(
              "Factory worktree MCP requires a Claude profile with existing Read authority",
            );
        }
      }
    }
    if (
      typeof value.execution.defaultProfile !== "string" ||
      !Object.hasOwn(value.execution.profiles, value.execution.defaultProfile)
    )
      throw new Error("execution.defaultProfile must name an eligible profile");
  } else {
    assertOnlyKeys(value.execution, localExecutionKeys, "execution");
    if (value.execution.defaultProfile !== undefined)
      throw new Error("execution.defaultProfile requires profiles");
    validateLocalHarness(value.execution.harness);
  }

  assertObject(value.delivery, "delivery");
  assertOnlyKeys(value.delivery, ["kind"], "delivery");
  if (
    value.delivery.kind !== "regular" &&
    value.delivery.kind !== "native-stack"
  ) {
    throw new Error("Unsupported delivery strategy");
  }
  assertObject(value.policy, "policy");
  assertOnlyKeys(value.policy, ["network", "allowedSecretNames"], "policy");
  if (value.policy.network !== "host" && value.policy.network !== "off")
    throw new Error("Unsupported network policy");
  const harnesses =
    value.execution.kind === "managed-agent"
      ? []
      : value.execution.profiles
        ? Object.values(
            value.execution.profiles as Record<string, ExecutionProfile>,
          ).map((p) => p.harness)
        : [value.execution.harness as LocalHarnessConfig];
  if (
    value.execution.kind === "managed-agent" &&
    (value.policy.network !== "off" ||
      !Array.isArray(value.policy.allowedSecretNames) ||
      value.policy.allowedSecretNames.length !== 0)
  )
    throw new Error(
      "OpenAI managed workers require network off and no worker secrets",
    );
  for (const harness of harnesses) {
    if (
      (harness.kind === "claude-agent-sdk" ||
        harness.kind === "github-copilot-sdk") &&
      value.policy.network !== "host"
    )
      throw new Error(
        `${harness.kind} requires policy.network host; no fallback is available`,
      );
  }
  if (
    !Array.isArray(value.policy.allowedSecretNames) ||
    !value.policy.allowedSecretNames.every(
      (name: unknown) => typeof name === "string",
    )
  ) {
    throw new Error("policy.allowedSecretNames must be a string array");
  }
  if (value.capture !== undefined) {
    assertObject(value.capture, "capture");
    assertOnlyKeys(
      value.capture,
      [
        "enabled",
        "maxBytesPerInvocation",
        "nativeBoundaryTelemetry",
        "retainInRecovery",
      ],
      "capture",
    );
    if (
      (value.capture.nativeBoundaryTelemetry !== undefined &&
        typeof value.capture.nativeBoundaryTelemetry !== "boolean") ||
      (value.capture.retainInRecovery !== undefined &&
        typeof value.capture.retainInRecovery !== "boolean") ||
      typeof value.capture.enabled !== "boolean" ||
      !Number.isSafeInteger(value.capture.maxBytesPerInvocation) ||
      (value.capture.maxBytesPerInvocation as number) <= 0
    )
      throw new Error(
        "capture requires enabled boolean and positive maxBytesPerInvocation",
      );
  }
  if (value.queue !== undefined) {
    assertObject(value.queue, "queue");
    assertOnlyKeys(
      value.queue,
      [
        "pollSeconds",
        "objectiveDeadlineSeconds",
        "maxActiveObjectives",
        "project",
      ],
      "queue",
    );
    if (
      value.queue.maxActiveObjectives !== undefined &&
      (!Number.isSafeInteger(value.queue.maxActiveObjectives) ||
        (value.queue.maxActiveObjectives as number) < 1 ||
        (value.queue.maxActiveObjectives as number) > MAX_ACTIVE_OBJECTIVES)
    )
      throw new Error(
        `queue.maxActiveObjectives must be an integer from 1 to ${MAX_ACTIVE_OBJECTIVES}`,
      );
    if (
      typeof value.queue.pollSeconds !== "number" ||
      !Number.isFinite(value.queue.pollSeconds) ||
      value.queue.pollSeconds <= 0
    )
      throw new Error("queue.pollSeconds must be a positive number");
    if (
      value.queue.objectiveDeadlineSeconds !== undefined &&
      (!Number.isSafeInteger(value.queue.objectiveDeadlineSeconds) ||
        (value.queue.objectiveDeadlineSeconds as number) <= 0 ||
        (value.queue.objectiveDeadlineSeconds as number) > 2_147_483_647)
    )
      throw new Error(
        "queue.objectiveDeadlineSeconds must be a positive integer no greater than 2147483647",
      );
    if (value.queue.project !== undefined) {
      const project = value.queue.project;
      assertObject(project, "queue.project");
      assertOnlyKeys(
        project,
        [
          "repository",
          "projectId",
          "metadataFieldId",
          "orderFieldId",
          "controlItemId",
          "factoryManagedFields",
        ],
        "queue.project",
      );
      if (
        project.repository !== value.repository ||
        project.factoryManagedFields !== true ||
        ["projectId", "metadataFieldId", "orderFieldId", "controlItemId"].some(
          (key) =>
            typeof project[key] !== "string" ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(project[key] as string),
        ) ||
        project.metadataFieldId === project.orderFieldId
      )
        throw new Error(
          "queue.project requires an exact repository, distinct fields and explicit managed-field consent",
        );
      const status = (
        value.githubManagement as FactoryConfig["githubManagement"]
      )?.projectStatus;
      if (
        status &&
        !("enabled" in status) &&
        status.projectId === project.projectId &&
        [project.metadataFieldId, project.orderFieldId].includes(status.fieldId)
      )
        throw new Error(
          "Queue scheduling fields must be separate from derived Project status",
        );
    }
  }
  if (value.autonomy !== undefined)
    resolveAutonomy(value.autonomy as AutonomyConfig);
  return value as unknown as FactoryConfig;
}

/** The worker ceiling and scheduling an Objective runs with; it stores them when it starts. */
export interface Capacity {
  concurrency: number;
  scheduling?: SchedulingConfig;
  /** Which values came from the host rather than the configuration. */
  hostSized?: { concurrency?: true; scheduling?: true };
}

/** The declared capacity, or this host's defaults when `execution.concurrency` is omitted. */
export function resolveCapacity(config: FactoryConfig): Capacity {
  if (config.execution.concurrency !== undefined)
    return {
      concurrency: config.execution.concurrency,
      ...(config.scheduling ? { scheduling: config.scheduling } : {}),
    };
  const host = currentHostDefaults();
  return {
    concurrency: host.concurrency,
    scheduling: config.scheduling ?? host.scheduling,
    hostSized: config.scheduling
      ? { concurrency: true }
      : { concurrency: true, scheduling: true },
  };
}

/** The host facts sizing reads. */
export interface HostFacts {
  cpus: number;
  memoryBytes: number;
}

function currentHostDefaults() {
  return hostSchedulingDefaults({
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
  });
}

/**
 * The capacity to schedule with now. Stored values bind plan bounds; a host-sized value never
 * exceeds what the current host offers, so a smaller host is not oversubscribed.
 */
export function liveCapacity(capacity: Capacity): Capacity {
  const sized = capacity.hostSized;
  if (!sized) return capacity;
  const host = currentHostDefaults();
  const least = (stored: number | undefined, live: number | undefined) =>
    stored === undefined || live === undefined
      ? stored
      : Math.min(stored, live);
  const stored = capacity.scheduling;
  const scheduling =
    sized.scheduling && stored
      ? {
          ...stored,
          ...Object.fromEntries(
            (
              [
                "cpu",
                "memoryMiB",
                "reviewConcurrency",
                "validationConcurrency",
              ] as const
            ).flatMap((key) =>
              stored[key] === undefined
                ? []
                : [[key, least(stored[key], host.scheduling[key])]],
            ),
          ),
          ...(stored.phases
            ? {
                phases: Object.fromEntries(
                  Object.entries(stored.phases).map(([phase, reserve]) => {
                    const live = host.scheduling.phases[phase as ResourcePhase];
                    return [
                      phase,
                      {
                        ...reserve,
                        ...(reserve?.cpu === undefined
                          ? {}
                          : { cpu: least(reserve.cpu, live?.cpu) }),
                        ...(reserve?.memoryMiB === undefined
                          ? {}
                          : {
                              memoryMiB: least(
                                reserve.memoryMiB,
                                live?.memoryMiB,
                              ),
                            }),
                      },
                    ];
                  }),
                ),
              }
            : {}),
        }
      : stored;
  return {
    concurrency: sized.concurrency
      ? Math.min(capacity.concurrency, host.concurrency)
      : capacity.concurrency,
    ...(scheduling ? { scheduling } : {}),
  };
}

export function validateCapacity(value: Capacity): Capacity {
  assertObject(value, "capacity");
  assertOnlyKeys(value, ["concurrency", "scheduling", "hostSized"], "capacity");
  if (!Number.isSafeInteger(value.concurrency) || value.concurrency <= 0)
    throw new Error("capacity.concurrency must be a positive integer");
  if (value.scheduling !== undefined) validateScheduling(value.scheduling);
  if (value.hostSized !== undefined) {
    assertObject(value.hostSized, "capacity.hostSized");
    assertOnlyKeys(
      value.hostSized,
      ["concurrency", "scheduling"],
      "capacity.hostSized",
    );
    if (
      Object.values(value.hostSized).some((flag) => flag !== true) ||
      (value.hostSized.scheduling && !value.scheduling)
    )
      throw new Error("capacity.hostSized is invalid");
  }
  return value;
}

/** Progress comments: on by default for the target; `{ enabled: false }` opts out. */
export function githubProgressSettings(
  config: FactoryConfig,
):
  | { repository: string; includeQuestions: boolean; explicit: boolean }
  | undefined {
  const setting = config.githubManagement?.progress;
  if (setting?.enabled === false) return undefined;
  return setting
    ? {
        repository: setting.repository,
        includeQuestions: setting.includeQuestions,
        explicit: true,
      }
    : {
        repository: config.repository,
        includeQuestions: false,
        explicit: false,
      };
}

/**
 * Project Status: the explicit field and options, else by default the queue's Project,
 * whose single-select Status field and options are discovered by name. `{ enabled: false }`
 * opts out; no explicit setting and no queue Project means no Project status.
 */
export type ProjectStatusSettings =
  | { kind: "explicit"; config: GitHubProjectStatusConfig }
  | {
      kind: "discover";
      repository: string;
      projectId: string;
      /** Queue scheduling fields; the discovered Status field must differ. */
      reservedFieldIds: string[];
    };
export function githubProjectStatusSettings(
  config: FactoryConfig,
): ProjectStatusSettings | undefined {
  const setting = config.githubManagement?.projectStatus;
  if (setting && "enabled" in setting) return undefined;
  if (setting) return { kind: "explicit", config: setting };
  const project = config.queue?.project;
  return project
    ? {
        kind: "discover",
        repository: config.repository,
        projectId: project.projectId,
        reservedFieldIds: [project.metadataFieldId, project.orderFieldId],
      }
    : undefined;
}

/**
 * A harness without its worker run limits (Claude `maxTurns`, Copilot `timeoutSeconds`).
 * They bound how long a worker runs, not what it builds, so an operator can change them
 * without stranding started work.
 */
export function withoutWorkerLimits(
  harness: LocalHarnessConfig,
): LocalHarnessConfig {
  if (harness.kind === "claude-agent-sdk") {
    const { maxTurns: _maxTurns, ...bound } = harness;
    return bound as LocalHarnessConfig;
  }
  if (harness.kind === "github-copilot-sdk") {
    const { timeoutSeconds: _timeoutSeconds, ...bound } = harness;
    return bound as LocalHarnessConfig;
  }
  return harness;
}

function executionWithoutWorkerLimits(
  execution: ExecutionConfig,
): ExecutionConfig {
  if (execution.kind !== "local") return execution;
  return {
    ...execution,
    ...(execution.harness && {
      harness: withoutWorkerLimits(execution.harness),
    }),
    ...(execution.profiles && {
      profiles: Object.fromEntries(
        Object.entries(execution.profiles).map(([id, profile]) => [
          id,
          { ...profile, harness: withoutWorkerLimits(profile.harness) },
        ]),
      ),
    }),
  };
}

/**
 * Settings that only present, observe or operate the run are left out of both digests, so
 * changing them never strands a started Objective or a queue receipt: GitHub progress and
 * Project status, diagnostic `capture`, the command `sandbox` host settings, the archive's operational limits (`gitPersistence`
 * maxBytes, maxFiles, timeoutMs and coalesceMs) and worker run limits
 * (`withoutWorkerLimits`). The archive's
 * identity (remote, ref, visibility, scope) stays bound. Key order is kept, so a
 * configuration without them digests exactly as before.
 */
function withoutOperationalSettings(config: FactoryConfig): FactoryConfig {
  return Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) => {
      if (key === "capture" || key === "sandbox") return [];
      if (key === "execution")
        return [[key, executionWithoutWorkerLimits(value as ExecutionConfig)]];
      if (key === "queueProvider") {
        const provider = value as NonNullable<FactoryConfig["queueProvider"]>;
        return [
          [
            key,
            {
              ...provider,
              execution: executionWithoutWorkerLimits(provider.execution),
            },
          ],
        ];
      }
      if (key === "gitPersistence") {
        const {
          maxBytes: _maxBytes,
          maxFiles: _maxFiles,
          timeoutMs: _timeoutMs,
          coalesceMs: _coalesceMs,
          ...identity
        } = value as Record<string, unknown>;
        return [[key, identity]];
      }
      if (key !== "githubManagement") return [[key, value]];
      const {
        progress: _progress,
        projectStatus: _projectStatus,
        ...bound
      } = value as NonNullable<FactoryConfig["githubManagement"]>;
      return Object.keys(bound).length ? [[key, bound]] : [];
    }),
  ) as FactoryConfig;
}

/**
 * Digest of every declared installation choice, including adapter config; an omitted
 * concurrency stays omitted, so the digest does not follow the host. Autonomy limits are
 * excluded: each Objective snapshots them, and its capacity, when it starts. The queue's
 * settings are excluded too: polling is observational, and each Objective's elapsed
 * deadline is frozen in its queue admission before dispatch rather than renewed by config.
 */
export function factoryConfigDigest(config: FactoryConfig): string {
  const {
    autonomy: _autonomy,
    queue: _queue,
    queueProvider: _queueProvider,
    ...bound
  } = withoutOperationalSettings(config);
  assertJsonValue(bound, "configuration");
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
}

/**
 * Queue approval and restore authority retain semantic choices without host layout or polling.
 * They bind the queue's provider (the file's default), whichever provider the command runs,
 * so switching hosts keeps the queue and its receipts readable.
 */
export function factoryAuthorityDigest(config: FactoryConfig): string {
  const {
    checkout: _checkout,
    queue,
    autonomy,
    queueProvider,
    ...declared
  } = withoutOperationalSettings(config);
  const {
    pollSeconds: _pollSeconds,
    maxActiveObjectives: _maxActiveObjectives,
    ...queueAuthority
  } = queue ?? {};
  const bound = {
    ...declared,
    ...queueProvider,
    autonomy: resolveAutonomy(autonomy),
    ...(Object.keys(queueAuthority).length ? { queue: queueAuthority } : {}),
  };
  assertJsonValue(bound, "queue authority");
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  return createHash("sha256").update(canonical(bound)).digest("hex");
}

/**
 * The configuration the installation's Project queue runs with: the default provider's.
 * A configuration resolved for another provider carries the default as `queueProvider`;
 * swapping it back in place reproduces the default resolution, key order included. Queue
 * commands and their receipts bind this, so they mean the same whichever provider a run uses.
 */
export function queueConfiguration(config: FactoryConfig): FactoryConfig {
  const provider = config.queueProvider;
  if (!provider) return config;
  return Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) =>
      key === "queueProvider"
        ? []
        : [
            [
              key,
              key === "planning" || key === "execution" ? provider[key] : value,
            ],
          ],
    ),
  ) as FactoryConfig;
}

/** The configuration digest of the installation's Project queue (see queueConfiguration). */
export function queueConfigDigest(config: FactoryConfig): string {
  return factoryConfigDigest(queueConfiguration(config));
}

/**
 * What a controller that executes Project queue commands accepts: the queue's authority and
 * configuration. Every provider of one installation shares it; a change to the Project,
 * autonomy or queue settings, or to any other shared setting, does not.
 */
export interface QueueControlBinding {
  authorityDigest: string;
  configDigest: string;
}
export function queueControlBinding(
  config: FactoryConfig,
): QueueControlBinding {
  return {
    authorityDigest: factoryAuthorityDigest(config),
    configDigest: queueConfigDigest(config),
  };
}

/**
 * The most queued Objectives one installation runs at once. Each run in the
 * service process listens for its own SIGTERM handoff, and Node warns above
 * ten listeners per signal.
 */
const MAX_ACTIVE_OBJECTIVES = 8;
/** How many queued Objectives may run at once; 1 unless the operator opts in. */
export function maxActiveObjectives(config: FactoryConfig): number {
  return config.queue?.maxActiveObjectives ?? 1;
}

export function configPath(): string {
  const root =
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return resolve(root, "clockgrove-factory", "config.json");
}

export function stateRoot(repository: string): string {
  const root =
    process.env.XDG_STATE_HOME ??
    join(process.env.HOME ?? "", ".local", "state");
  const [owner, repo] = repository.split("/");
  return resolve(root, "clockgrove-factory", "repositories", owner!, repo!);
}

/** One named model provider: the planning and execution choices an Objective runs with. */
export interface ProviderConfig {
  planning: PlanningConfig;
  execution: ExecutionConfig;
}

/**
 * The configuration file: shared installation choices plus named providers. Commands
 * resolve one provider into a FactoryConfig; see provider-selection.ts.
 */
export type FactoryConfigFile = Omit<
  FactoryConfig,
  "planning" | "execution"
> & {
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
};

const providerName = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The FactoryConfig for one provider. Its planning and execution take the place of
 * `providers` in the file's key order, which keeps configuration digests stable.
 */
export function resolveProvider(
  file: FactoryConfigFile,
  name: string,
): FactoryConfig {
  const provider = file.providers[name];
  if (!provider)
    throw new Error(
      `No provider ${JSON.stringify(name)} is configured; configured: ${Object.keys(file.providers).join(", ")}`,
    );
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (key === "defaultProvider") continue;
    if (key === "providers") {
      resolved.planning = provider.planning;
      resolved.execution = provider.execution;
    } else resolved[key] = value;
  }
  if (name !== file.defaultProvider)
    resolved.queueProvider = file.providers[file.defaultProvider];
  return validateConfig(resolved);
}

export function validateConfigFile(value: unknown): FactoryConfigFile {
  assertObject(value, "configuration");
  if ("planning" in value || "execution" in value)
    throw new Error(
      'Configuration planning and execution belong to a named provider: move them under "providers": { "NAME": { "planning", "execution" } } and set "defaultProvider": "NAME"',
    );
  const providers = value.providers;
  assertObject(providers, "providers");
  const names = Object.keys(providers);
  if (!names.length) throw new Error("providers requires at least one entry");
  for (const name of names) {
    if (!providerName.test(name))
      throw new Error(
        `Provider name ${JSON.stringify(name)} must be lowercase letters, digits and hyphens`,
      );
    const provider = providers[name];
    assertObject(provider, `providers.${name}`);
    assertOnlyKeys(provider, ["planning", "execution"], `providers.${name}`);
  }
  if (
    typeof value.defaultProvider !== "string" ||
    !names.includes(value.defaultProvider)
  )
    throw new Error("defaultProvider must name a configured provider");
  const file = value as unknown as FactoryConfigFile;
  for (const name of names) resolveProvider(file, name);
  return file;
}

/**
 * The provider of a configuration file that resolves to `config`, or its default provider
 * when none does, so a caller's digest comparison names the difference.
 */
export function resolveMatchingProvider(
  value: unknown,
  config: FactoryConfig,
): FactoryConfig {
  const file = validateConfigFile(value);
  const digest = factoryConfigDigest(config);
  for (const name of Object.keys(file.providers)) {
    const resolved = resolveProvider(file, name);
    if (factoryConfigDigest(resolved) === digest) return resolved;
  }
  return resolveProvider(file, file.defaultProvider);
}

export function readConfigFile(path = configPath()): FactoryConfigFile {
  return validateConfigFile(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** The FactoryConfig for one provider, or the default provider. */
export function readConfig(
  path = configPath(),
  provider?: string,
): FactoryConfig {
  const file = readConfigFile(path);
  return resolveProvider(file, provider ?? file.defaultProvider);
}

export function validateLocalHarness(
  harness: unknown,
): asserts harness is LocalHarnessConfig {
  assertObject(harness, "execution.harness");
  if (harness.kind === "codex-sdk") {
    assertCodexModelSelection(harness, "execution.harness", [
      "kind",
      "model",
      "reasoningEffort",
      "serviceTier",
    ]);
  } else if (harness.kind === "claude-agent-sdk") {
    assertOnlyKeys(
      harness,
      [
        "kind",
        "model",
        "reasoningEffort",
        "permissionMode",
        "settingSources",
        "tools",
        "allowedTools",
        "maxTurns",
      ],
      "execution.harness",
    );
    if (typeof harness.model !== "string" || harness.model.trim().length === 0)
      throw new Error("execution.harness.model must be a non-empty string");
    if (
      typeof harness.reasoningEffort !== "string" ||
      !harnessReasoningEfforts.has(
        harness.reasoningEffort as HarnessReasoningEffort,
      )
    )
      throw new Error("execution.harness.reasoningEffort is unsupported");
    if (
      harness.permissionMode !== "acceptEdits" &&
      harness.permissionMode !== "dontAsk"
    )
      throw new Error("execution.harness.permissionMode is unsupported");
    const settings = assertUniqueStrings(
      harness.settingSources,
      "execution.harness.settingSources",
    );
    if (
      settings.some(
        (source) => !claudeSettingSources.has(source as ClaudeSettingSource),
      )
    )
      throw new Error("execution.harness.settingSources is unsupported");
    const tools = assertUniqueStrings(harness.tools, "execution.harness.tools");
    if (!tools.length)
      throw new Error("execution.harness.tools must name bounded SDK tools");
    if (
      tools.some(
        (tool) => !claudeFileTools.has(tool) && tool !== validateToolConfigName,
      )
    )
      throw new Error(
        "execution.harness.tools supports only Read, Edit, Write, Glob, Grep, and Validate",
      );
    const allowedTools = assertUniqueStrings(
      harness.allowedTools,
      "execution.harness.allowedTools",
    );
    if (allowedTools.some((tool) => !tools.includes(tool)))
      throw new Error(
        "execution.harness.allowedTools must be a subset of execution.harness.tools",
      );
    if (
      !Number.isSafeInteger(harness.maxTurns) ||
      (harness.maxTurns as number) <= 0
    )
      throw new Error(
        "execution.harness.maxTurns must be a positive operator-selected integer",
      );
  } else if (harness.kind === "github-copilot-sdk") {
    assertOnlyKeys(
      harness,
      [
        "kind",
        "model",
        "reasoningEffort",
        "availableTools",
        "permissionKinds",
        "timeoutSeconds",
      ],
      "execution.harness",
    );
    if (typeof harness.model !== "string" || harness.model.trim().length === 0)
      throw new Error("execution.harness.model must be a non-empty string");
    if (
      typeof harness.reasoningEffort !== "string" ||
      !harnessReasoningEfforts.has(
        harness.reasoningEffort as HarnessReasoningEffort,
      )
    )
      throw new Error("execution.harness.reasoningEffort is unsupported");
    const availableTools = assertUniqueStrings(
      harness.availableTools,
      "execution.harness.availableTools",
    );
    if (!availableTools.length)
      throw new Error(
        "execution.harness.availableTools must name bounded SDK tools",
      );
    const unsupportedTool = availableTools.find(
      (tool) => !copilotFileTools.has(tool),
    );
    if (unsupportedTool)
      throw new Error(
        `execution.harness.availableTools supports only view, create, edit, apply_patch, grep, and glob; received ${unsupportedTool}`,
      );
    const permissionKinds = assertUniqueStrings(
      harness.permissionKinds,
      "execution.harness.permissionKinds",
    );
    if (
      !permissionKinds.length ||
      permissionKinds.some((kind) => kind !== "read" && kind !== "write")
    )
      throw new Error(
        "execution.harness.permissionKinds supports only read and write",
      );
    if (
      !Number.isSafeInteger(harness.timeoutSeconds) ||
      (harness.timeoutSeconds as number) <= 0
    )
      throw new Error(
        "execution.harness.timeoutSeconds must be a positive operator-selected integer",
      );
  } else if (harness.kind === "registered") {
    assertOnlyKeys(harness, ["kind", "adapter", "config"], "execution.harness");
    if (
      typeof harness.adapter !== "string" ||
      harness.adapter.trim().length === 0 ||
      harness.adapter !== harness.adapter.trim()
    )
      throw new Error(
        "execution.harness.adapter must be a non-empty stable identity",
      );
    assertObject(harness.config, "execution.harness.config");
    assertJsonValue(harness.config, "execution.harness.config");
  } else throw new Error("Unsupported local harness");
}
