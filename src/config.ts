import { validateDaytonaConfig } from "./execution/daytona.js";
import { validateClaudeManagedConfig } from "./execution/claude-managed.js";
import { validateOpenAIManagedConfig } from "./execution/openai-managed.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type AutonomyConfig, resolveAutonomy } from "./repair-policy.js";

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "persistent";

export interface CodexModelSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export const DEFAULT_PLANNER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
};

export const DEFAULT_REVIEWER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
};

export const DEFAULT_WORKER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-5.6-luna",
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
  adapter: typeof CLAUDE_AGENT_SDK_ADAPTER_IDENTITY;
  model: string;
  reasoningEffort: HarnessReasoningEffort;
  permissionMode: "acceptEdits" | "dontAsk";
  session: "new-per-attempt";
  settingSources: ClaudeSettingSource[];
  tools: string[];
  allowedTools: string[];
  maxTurns: number;
  authentication: "local";
}

export interface GitHubCopilotSdkConfig {
  kind: "github-copilot-sdk";
  adapter: typeof GITHUB_COPILOT_SDK_ADAPTER_IDENTITY;
  model: string;
  reasoningEffort: HarnessReasoningEffort;
  session: "new-per-attempt";
  availableTools: string[];
  permissionKinds: ("read" | "write")[];
  timeoutSeconds: number;
  authentication: "local";
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
    }
  | {
      kind: "sandbox";
      concurrency?: number;
      provider: string;
      config?: { [key: string]: JsonValue };
      harness: Extract<LocalHarnessConfig, { kind: "registered" }>;
      argv: string[];
    };

export interface ClaudeModelSelection {
  model: string;
  reasoningEffort: HarnessReasoningEffort;
}

/** Planning and review run through one configured provider. */
export type PlanningConfig =
  | {
      kind: "codex-sdk";
      planner: CodexModelSelection;
      reviewer: CodexModelSelection;
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
export function hostSchedulingDefaults(host: {
  cpus: number;
  memoryBytes: number;
}): { concurrency: number; scheduling: Required<SchedulingConfig> } {
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
  scheduling?: SchedulingConfig;
  /** Limits on unattended repair and amendment; omitted fields use bounded defaults. */
  autonomy?: AutonomyConfig;
  /** Explicit local sensitive-content opt-in; absent remains disabled. */
  capture?: { enabled: boolean; maxBytesPerInvocation: number };
  schemaVersion: 1;
  repository: string;
  checkout: string;
  planning: PlanningConfig;
  execution: ExecutionConfig;
  delivery: { kind: "regular" | "native-stack" };
  contentStore: { kind: "local" };
  policy: {
    network: "host" | "off";
    allowedSecretNames: string[];
    deployments: "denied";
  };
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
const copilotFileTools = new Set([
  "view",
  "create",
  "edit",
  "apply_patch",
  "grep",
  "glob",
]);

const factoryRepositories = new Set([
  "clockgrove/factory",
  "clockgrove/factory-rebuild",
  "clockgrove/factory-archive",
]);

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

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${name}.${unexpected} is unsupported`);
}

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
): asserts value is CodexModelSelection {
  assertObject(value, name);
  if (typeof value.model !== "string" || value.model.trim().length === 0)
    throw new Error(`${name}.model must be a non-empty string`);
  if (
    typeof value.reasoningEffort !== "string" ||
    !codexReasoningEfforts.has(value.reasoningEffort as CodexReasoningEffort)
  )
    throw new Error(`${name}.reasoningEffort is unsupported`);
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

function validatePlanning(
  value: unknown,
): asserts value is FactoryConfig["planning"] {
  assertObject(value, "planning");
  if (value.kind === "codex-sdk") {
    assertCodexModelSelection(value.planner, "planning.planner");
    assertCodexModelSelection(value.reviewer, "planning.reviewer");
    return;
  }
  if (value.kind !== "claude-agent-sdk")
    throw new Error("Unsupported planning model");
  assertOnlyKeys(
    value,
    ["kind", "maxOutputTokens", "planner", "reviewer"],
    "planning",
  );
  if (
    !Number.isSafeInteger(value.maxOutputTokens) ||
    (value.maxOutputTokens as number) <= 0
  )
    throw new Error("planning.maxOutputTokens must be a positive integer");
  assertClaudeModelSelection(value.planner, "planning.planner");
  assertClaudeModelSelection(value.reviewer, "planning.reviewer");
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

/** Parse only supported GitHub clone URLs; never return credentials or raw URLs. */
function remoteRepository(remote: string): string | undefined {
  const scp =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(
      remote,
    );
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(remote);
    const https =
      url.protocol === "https:" && url.hostname === "github.com" && !url.port;
    const ssh =
      url.protocol === "ssh:" &&
      url.username === "git" &&
      !url.password &&
      ((url.hostname === "github.com" && (!url.port || url.port === "22")) ||
        (url.hostname === "ssh.github.com" && url.port === "443"));
    if ((!https && !ssh) || url.search || url.hash) return undefined;
    const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.pathname,
    );
    return path ? `${path[1]}/${path[2]}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function originRepositories(checkout: string, push: boolean): string[] {
  const direction = push ? "push" : "fetch";
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "-C",
        checkout,
        "remote",
        "get-url",
        ...(push ? ["--push"] : []),
        "--all",
        "origin",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new Error(
      `Cannot resolve origin ${direction} URLs; configure origin for the target GitHub repository`,
    );
  }
  const repositories = output.split("\n").map(remoteRepository);
  if (repositories.some((repository) => !repository))
    throw new Error(
      `Origin ${direction} URL is not a supported GitHub repository URL; use the target repository's HTTPS or SSH clone URL`,
    );
  return repositories as string[];
}

/** Custom LFS routing cannot be proven from Git clone URLs; keep the default origin route. */
function validateLfsRouting(checkout: string): void {
  const keys =
    "^(lfs\\.(url|pushurl|remote\\.(autodetect|searchall)|standalonetransferagent|customtransfer\\..*|transfer\\.enablehrefrewrite)|remote\\.(lfsdefault|lfspushdefault|.+\\.(lfsurl|lfspushurl)))$";
  const check = (source: string[]) => {
    let output: string;
    try {
      output = execFileSync(
        "git",
        [
          "-C",
          checkout,
          "config",
          "--includes",
          ...source,
          "--null",
          "--get-regexp",
          keys,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      if ((error as { status?: number }).status === 1) return;
      throw new Error(
        "Cannot inspect LFS routing configuration; repair Git/.lfsconfig settings before using Factory",
      );
    }
    for (const entry of output.split("\0").filter(Boolean)) {
      const newline = entry.indexOf("\n");
      const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
      const value = newline < 0 ? undefined : entry.slice(newline + 1).trim();
      if (value === "") continue;
      if (
        /^lfs\.(remote\.(autodetect|searchall)|transfer\.enablehrefrewrite)$/.test(
          key,
        ) &&
        value !== undefined &&
        /^(false|no|off|0)$/i.test(value)
      )
        continue;
      if (/^remote\.lfs(push)?default$/.test(key) && value === "origin")
        continue;
      throw new Error(
        "Custom LFS routing is unsupported for target binding; remove LFS URL, alternate-remote, rewrite, or custom-transfer settings and use origin's default GitHub LFS endpoint",
      );
    }
  };
  check([]);
  // A fresh clone can use committed settings even when the working file overrides them.
  const file = join(checkout, ".lfsconfig");
  if (existsSync(file)) check(["--file", file]);
  for (const blob of [":.lfsconfig", "HEAD:.lfsconfig"]) {
    try {
      execFileSync("git", ["-C", checkout, "cat-file", "-e", blob], {
        stdio: "ignore",
      });
    } catch {
      continue;
    }
    check(["--blob", blob]);
  }
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
  validateTarget(value.repository, value.checkout);
  validatePlanning(value.planning);
  if (value.scheduling !== undefined) validateScheduling(value.scheduling);
  assertObject(value.execution, "execution");
  if (
    value.execution.kind !== "local" &&
    value.execution.kind !== "managed-agent" &&
    value.execution.kind !== "sandbox"
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
  if (value.execution.kind === "sandbox") {
    assertOnlyKeys(
      value.execution,
      ["kind", "concurrency", "provider", "config", "harness", "argv"],
      "execution",
    );
    if (
      typeof value.execution.provider !== "string" ||
      !value.execution.provider.trim()
    )
      throw new Error("Sandbox provider identity required");
    if (value.execution.provider === "daytona")
      validateDaytonaConfig(value.execution.config);
    else if (value.execution.config !== undefined)
      throw new Error("Only Daytona accepts sandbox provider configuration");
    validateLocalHarness(value.execution.harness);
    if (value.execution.harness.kind !== "registered")
      throw new Error("Sandbox requires the installed registered harness seam");
    if (
      !Array.isArray(value.execution.argv) ||
      !value.execution.argv.length ||
      !value.execution.argv.every(
        (x) => typeof x === "string" && x.length && !x.includes("\0"),
      )
    )
      throw new Error("Sandbox requires installed invocation argv");
  } else if (value.execution.kind === "managed-agent") {
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
    if (value.execution.defaultProfile !== undefined)
      throw new Error("execution.defaultProfile requires profiles");
    validateLocalHarness(value.execution.harness);
  }

  assertObject(value.delivery, "delivery");
  if (
    value.delivery.kind !== "regular" &&
    value.delivery.kind !== "native-stack"
  ) {
    throw new Error("Unsupported delivery strategy");
  }
  assertObject(value.contentStore, "contentStore");
  if (value.contentStore.kind !== "local")
    throw new Error("Unsupported content store");
  assertObject(value.policy, "policy");
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
  if (value.policy.deployments !== "denied")
    throw new Error("Deployments are unsupported");
  if (value.capture !== undefined) {
    assertObject(value.capture, "capture");
    assertOnlyKeys(
      value.capture,
      ["enabled", "maxBytesPerInvocation"],
      "capture",
    );
    if (
      typeof value.capture.enabled !== "boolean" ||
      !Number.isSafeInteger(value.capture.maxBytesPerInvocation) ||
      (value.capture.maxBytesPerInvocation as number) <= 0
    )
      throw new Error(
        "capture requires enabled boolean and positive maxBytesPerInvocation",
      );
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

/**
 * Digest of every declared installation choice, including adapter config; an omitted
 * concurrency stays omitted, so the digest does not follow the host. Autonomy limits are
 * excluded: each Objective snapshots them, and its capacity, when it starts.
 */
export function factoryConfigDigest(config: FactoryConfig): string {
  const { autonomy: _autonomy, ...bound } = config;
  assertJsonValue(bound, "configuration");
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
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

export function readConfig(path = configPath()): FactoryConfig {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function validateLocalHarness(
  harness: unknown,
): asserts harness is LocalHarnessConfig {
  assertObject(harness, "execution.harness");
  if (harness.kind === "codex-sdk") {
    assertOnlyKeys(
      harness,
      ["kind", "model", "reasoningEffort"],
      "execution.harness",
    );
    assertCodexModelSelection(harness, "execution.harness");
  } else if (harness.kind === "claude-agent-sdk") {
    assertOnlyKeys(
      harness,
      [
        "kind",
        "adapter",
        "model",
        "reasoningEffort",
        "permissionMode",
        "session",
        "settingSources",
        "tools",
        "allowedTools",
        "maxTurns",
        "authentication",
      ],
      "execution.harness",
    );
    if (harness.adapter !== CLAUDE_AGENT_SDK_ADAPTER_IDENTITY)
      throw new Error("execution.harness.adapter is not the pinned Claude SDK");
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
    if (harness.session !== "new-per-attempt")
      throw new Error("execution.harness.session is unsupported");
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
    if (tools.some((tool) => !claudeFileTools.has(tool)))
      throw new Error(
        "execution.harness.tools supports only Read, Edit, Write, Glob, and Grep",
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
    if (harness.authentication !== "local")
      throw new Error("execution.harness.authentication must be local");
  } else if (harness.kind === "github-copilot-sdk") {
    assertOnlyKeys(
      harness,
      [
        "kind",
        "adapter",
        "model",
        "reasoningEffort",
        "session",
        "availableTools",
        "permissionKinds",
        "timeoutSeconds",
        "authentication",
      ],
      "execution.harness",
    );
    if (harness.adapter !== GITHUB_COPILOT_SDK_ADAPTER_IDENTITY)
      throw new Error(
        "execution.harness.adapter is not the pinned GitHub Copilot SDK",
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
    if (harness.session !== "new-per-attempt")
      throw new Error("execution.harness.session is unsupported");
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
    if (harness.authentication !== "local")
      throw new Error("execution.harness.authentication must be local");
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
