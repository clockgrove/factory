import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { option, options } from "./cli-flags.js";
import {
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  type ProviderConfig,
  stateRoot,
  validateConfigFile,
} from "./config.js";

/** The provider name setup writes: --provider, or the planning provider's short name. */
function setupProviderName(args: string[]): string {
  return (
    option(args, "provider") ??
    (option(args, "planning") === "claude-agent-sdk" ? "claude" : "codex")
  );
}

/** One provider's planning and execution from the installation options. */
function providerFromOptions(args: string[]): ProviderConfig {
  // An explicit worker ceiling is the operator's whole choice; otherwise every run sizes from its host.
  const concurrency = option(args, "concurrency")
    ? Number(option(args, "concurrency"))
    : undefined;
  const harness = option(args, "harness") ?? "codex-sdk";
  if (
    harness !== "codex-sdk" &&
    harness !== "claude-agent-sdk" &&
    harness !== "github-copilot-sdk"
  )
    throw new Error(
      "--harness must be codex-sdk, claude-agent-sdk, or github-copilot-sdk",
    );
  if (harness === "claude-agent-sdk" && !option(args, "worker-model"))
    throw new Error("The Claude harness requires --worker-model");
  if (
    harness === "github-copilot-sdk" &&
    (!option(args, "worker-model") || !option(args, "copilot-timeout-seconds"))
  )
    throw new Error(
      "The GitHub Copilot harness requires --worker-model and --copilot-timeout-seconds",
    );
  const planning = option(args, "planning") ?? "codex-sdk";
  if (planning !== "codex-sdk" && planning !== "claude-agent-sdk")
    throw new Error("--planning must be codex-sdk or claude-agent-sdk");
  const planningTransport = option(args, "planning-transport");
  if (planningTransport !== undefined) {
    if (planning !== "codex-sdk")
      throw new Error("--planning-transport requires --planning codex-sdk");
    if (planningTransport !== "exec" && planningTransport !== "app-server")
      throw new Error("--planning-transport must be exec or app-server");
  }
  if (
    planning === "claude-agent-sdk" &&
    (!option(args, "planning-model") || !option(args, "review-model"))
  )
    throw new Error(
      "Claude planning requires --planning-model and --review-model",
    );
  const claudeTools = options(args, "claude-tool");
  const claudeAllowedTools = options(args, "claude-allow-tool");
  const defaultClaudeTools = [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Validate",
  ];
  const copilotTools = options(args, "copilot-tool");
  const defaultCopilotTools = [
    "view",
    "create",
    "edit",
    "apply_patch",
    "grep",
    "glob",
  ];
  return {
    planning:
      planning === "claude-agent-sdk"
        ? {
            kind: "claude-agent-sdk",
            maxOutputTokens: 64000,
            planner: {
              model: option(args, "planning-model"),
              reasoningEffort: option(args, "planning-reasoning") ?? "high",
            },
            reviewer: {
              model: option(args, "review-model"),
              reasoningEffort: option(args, "review-reasoning") ?? "medium",
            },
          }
        : {
            kind: "codex-sdk",
            ...(planningTransport === undefined
              ? {}
              : { codex: { transport: planningTransport } }),
            planner: {
              model:
                option(args, "planning-model") ??
                DEFAULT_PLANNER_MODEL_SELECTION.model,
              reasoningEffort:
                option(args, "planning-reasoning") ??
                DEFAULT_PLANNER_MODEL_SELECTION.reasoningEffort,
            },
            reviewer: {
              model:
                option(args, "review-model") ??
                DEFAULT_REVIEWER_MODEL_SELECTION.model,
              reasoningEffort:
                option(args, "review-reasoning") ??
                DEFAULT_REVIEWER_MODEL_SELECTION.reasoningEffort,
            },
          },
    execution: {
      kind: "local",
      ...(concurrency === undefined ? {} : { concurrency }),
      harness:
        harness === "claude-agent-sdk"
          ? {
              kind: "claude-agent-sdk",
              model: option(args, "worker-model"),
              reasoningEffort: option(args, "worker-reasoning") ?? "medium",
              permissionMode:
                option(args, "claude-permission") ?? "acceptEdits",
              settingSources: options(args, "claude-setting-source"),
              tools: claudeTools.length ? claudeTools : defaultClaudeTools,
              allowedTools: claudeAllowedTools.length
                ? claudeAllowedTools
                : claudeTools.length
                  ? claudeTools
                  : defaultClaudeTools,
              // A turn-limit stop continues the conversation, so this bounds
              // each stretch of work rather than the whole attempt.
              maxTurns: Number(option(args, "claude-max-turns") ?? 400),
            }
          : harness === "github-copilot-sdk"
            ? {
                kind: "github-copilot-sdk",
                model: option(args, "worker-model"),
                reasoningEffort: option(args, "worker-reasoning") ?? "medium",
                availableTools: copilotTools.length
                  ? copilotTools
                  : defaultCopilotTools,
                permissionKinds: ["read", "write"],
                timeoutSeconds: Number(option(args, "copilot-timeout-seconds")),
              }
            : {
                kind: "codex-sdk",
                model:
                  option(args, "worker-model") ??
                  DEFAULT_WORKER_MODEL_SELECTION.model,
                reasoningEffort:
                  option(args, "worker-reasoning") ??
                  DEFAULT_WORKER_MODEL_SELECTION.reasoningEffort,
              },
    },
  } as unknown as ProviderConfig;
}

/**
 * Write a new configuration from the installation options (`factory setup`). It refuses to
 * replace an existing configuration or state root; a changed binding is a separately reviewed edit.
 */
export function writeConfiguration(args: string[], path: string): string {
  const repository = option(args, "repository");
  const checkout = option(args, "checkout");
  if (!repository || !checkout)
    throw new Error(
      "setup requires --repository and --checkout when no configuration exists",
    );
  const name = setupProviderName(args);
  const config = {
    schemaVersion: 1,
    repository,
    checkout,
    providers: { [name]: providerFromOptions(args) },
    defaultProvider: name,
    delivery: { kind: option(args, "delivery") ?? "regular" },
    ...(args.includes("--capture-content")
      ? {
          capture: {
            enabled: true,
            maxBytesPerInvocation: Number(
              option(args, "capture-max-bytes") ?? 8388608,
            ),
          },
        }
      : {}),
    policy: {
      network: option(args, "network") ?? "host",
      allowedSecretNames: [],
    },
  };
  validateConfigFile(config);
  if (existsSync(path) || existsSync(stateRoot(repository))) {
    throw new Error(
      "Factory setup requires an empty configuration and state root",
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return `Configured Factory for ${repository} at ${path} with provider ${name}`;
}

/**
 * Add a provider to an existing configuration. Other providers and shared choices are
 * unchanged, so their Objectives keep their configuration digests.
 */
export function addProvider(args: string[], path: string): string {
  const name = setupProviderName(args);
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  const providers = (file.providers ?? {}) as Record<string, unknown>;
  if (providers[name])
    throw new Error(`Provider ${name} is already configured`);
  providers[name] = providerFromOptions(args);
  file.providers = providers;
  validateConfigFile(file);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
  return `Added provider ${name} to ${path}`;
}
