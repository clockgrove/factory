import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
      concurrency: number;
      harness?: LocalHarnessConfig;
      defaultProfile?: string;
      profiles?: Record<string, ExecutionProfile>;
    }
  | { kind: "managed-agent"; concurrency: number; provider: string }
  | {
      kind: "sandbox";
      concurrency: number;
      provider: string;
      harness: { kind: string };
    };

export interface FactoryConfig {
  schemaVersion: 1;
  repository: string;
  checkout: string;
  planning: {
    kind: "codex-sdk";
    planner: CodexModelSelection;
    reviewer: CodexModelSelection;
  };
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

export function validateTarget(repository: string, checkout: string): void {
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
  assertObject(value.planning, "planning");
  if (value.planning.kind !== "codex-sdk")
    throw new Error("Unsupported planning model");
  assertCodexModelSelection(value.planning.planner, "planning.planner");
  assertCodexModelSelection(value.planning.reviewer, "planning.reviewer");
  assertObject(value.execution, "execution");
  if (value.execution.kind !== "local") {
    throw new Error(
      `Execution mode ${String(value.execution.kind)} is not implemented; select local`,
    );
  }
  if (
    !Number.isSafeInteger(value.execution.concurrency) ||
    (value.execution.concurrency as number) <= 0
  ) {
    throw new Error(
      "execution.concurrency must be a positive operator-selected integer",
    );
  }
  if (value.execution.profiles !== undefined) {
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
  const harnesses = value.execution.profiles
    ? Object.values(
        value.execution.profiles as Record<string, ExecutionProfile>,
      ).map((p) => p.harness)
    : [value.execution.harness as LocalHarnessConfig];
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
  return value as unknown as FactoryConfig;
}

/** Digest of every validated installation choice, including adapter config. */
export function factoryConfigDigest(config: FactoryConfig): string {
  assertJsonValue(config, "configuration");
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
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
