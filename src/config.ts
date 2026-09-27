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

export type ExecutionConfig =
  | {
      kind: "local";
      concurrency: number;
      harness: LocalHarnessConfig;
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
const copilotFileTools = new Set(["view", "create", "edit", "grep", "glob"]);

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

function remoteRepository(checkout: string): string | undefined {
  try {
    const origin = execFileSync(
      "git",
      ["-C", checkout, "remote", "get-url", "origin"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const match = origin.match(
      /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i,
    );
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
  } catch {
    return undefined;
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
  const remote = remoteRepository(actual);
  if (
    factoryRepositories.has(repo) ||
    isFactorySource(actual) ||
    (remote && factoryRepositories.has(remote))
  ) {
    throw new Error(
      "Factory cannot be installed or run against a Factory repository",
    );
  }
  if (remote && remote !== repo) {
    throw new Error(
      `checkout origin ${remote} does not match configured repository ${repo}`,
    );
  }
  try {
    execFileSync("git", ["-C", actual, "rev-parse", "--show-toplevel"], {
      stdio: "ignore",
    });
  } catch {
    throw new Error("checkout must be a Git repository");
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
  assertObject(value.execution.harness, "execution.harness");
  if (value.execution.harness.kind === "codex-sdk") {
    assertOnlyKeys(
      value.execution.harness,
      ["kind", "model", "reasoningEffort"],
      "execution.harness",
    );
    assertCodexModelSelection(value.execution.harness, "execution.harness");
  } else if (value.execution.harness.kind === "claude-agent-sdk") {
    assertOnlyKeys(
      value.execution.harness,
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
    if (value.execution.harness.adapter !== CLAUDE_AGENT_SDK_ADAPTER_IDENTITY)
      throw new Error("execution.harness.adapter is not the pinned Claude SDK");
    if (
      typeof value.execution.harness.model !== "string" ||
      value.execution.harness.model.trim().length === 0
    )
      throw new Error("execution.harness.model must be a non-empty string");
    if (
      typeof value.execution.harness.reasoningEffort !== "string" ||
      !harnessReasoningEfforts.has(
        value.execution.harness.reasoningEffort as HarnessReasoningEffort,
      )
    )
      throw new Error("execution.harness.reasoningEffort is unsupported");
    if (
      value.execution.harness.permissionMode !== "acceptEdits" &&
      value.execution.harness.permissionMode !== "dontAsk"
    )
      throw new Error("execution.harness.permissionMode is unsupported");
    if (value.execution.harness.session !== "new-per-attempt")
      throw new Error("execution.harness.session is unsupported");
    const settings = assertUniqueStrings(
      value.execution.harness.settingSources,
      "execution.harness.settingSources",
    );
    if (
      settings.some(
        (source) => !claudeSettingSources.has(source as ClaudeSettingSource),
      )
    )
      throw new Error("execution.harness.settingSources is unsupported");
    const tools = assertUniqueStrings(
      value.execution.harness.tools,
      "execution.harness.tools",
    );
    if (!tools.length)
      throw new Error("execution.harness.tools must name bounded SDK tools");
    if (tools.some((tool) => !claudeFileTools.has(tool)))
      throw new Error(
        "execution.harness.tools supports only Read, Edit, Write, Glob, and Grep",
      );
    const allowedTools = assertUniqueStrings(
      value.execution.harness.allowedTools,
      "execution.harness.allowedTools",
    );
    if (allowedTools.some((tool) => !tools.includes(tool)))
      throw new Error(
        "execution.harness.allowedTools must be a subset of execution.harness.tools",
      );
    if (
      !Number.isSafeInteger(value.execution.harness.maxTurns) ||
      (value.execution.harness.maxTurns as number) <= 0
    )
      throw new Error(
        "execution.harness.maxTurns must be a positive operator-selected integer",
      );
    if (value.execution.harness.authentication !== "local")
      throw new Error("execution.harness.authentication must be local");
  } else if (value.execution.harness.kind === "github-copilot-sdk") {
    assertOnlyKeys(
      value.execution.harness,
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
    if (value.execution.harness.adapter !== GITHUB_COPILOT_SDK_ADAPTER_IDENTITY)
      throw new Error(
        "execution.harness.adapter is not the pinned GitHub Copilot SDK",
      );
    if (
      typeof value.execution.harness.model !== "string" ||
      value.execution.harness.model.trim().length === 0
    )
      throw new Error("execution.harness.model must be a non-empty string");
    if (
      typeof value.execution.harness.reasoningEffort !== "string" ||
      !harnessReasoningEfforts.has(
        value.execution.harness.reasoningEffort as HarnessReasoningEffort,
      )
    )
      throw new Error("execution.harness.reasoningEffort is unsupported");
    if (value.execution.harness.session !== "new-per-attempt")
      throw new Error("execution.harness.session is unsupported");
    const availableTools = assertUniqueStrings(
      value.execution.harness.availableTools,
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
        `execution.harness.availableTools supports only view, create, edit, grep, and glob; received ${unsupportedTool}`,
      );
    const permissionKinds = assertUniqueStrings(
      value.execution.harness.permissionKinds,
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
      !Number.isSafeInteger(value.execution.harness.timeoutSeconds) ||
      (value.execution.harness.timeoutSeconds as number) <= 0
    )
      throw new Error(
        "execution.harness.timeoutSeconds must be a positive operator-selected integer",
      );
    if (value.execution.harness.authentication !== "local")
      throw new Error("execution.harness.authentication must be local");
  } else if (value.execution.harness.kind === "registered") {
    assertOnlyKeys(
      value.execution.harness,
      ["kind", "adapter", "config"],
      "execution.harness",
    );
    if (
      typeof value.execution.harness.adapter !== "string" ||
      value.execution.harness.adapter.trim().length === 0 ||
      value.execution.harness.adapter !== value.execution.harness.adapter.trim()
    )
      throw new Error(
        "execution.harness.adapter must be a non-empty stable identity",
      );
    assertObject(value.execution.harness.config, "execution.harness.config");
    assertJsonValue(value.execution.harness.config, "execution.harness.config");
  } else throw new Error("Unsupported local harness");
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
  if (
    (value.execution.harness.kind === "claude-agent-sdk" ||
      value.execution.harness.kind === "github-copilot-sdk") &&
    value.policy.network !== "host"
  )
    throw new Error(
      `${value.execution.harness.kind} requires policy.network host; no fallback is available`,
    );
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
