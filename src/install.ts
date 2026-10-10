import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { option, options } from "./cli-flags.js";
import {
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  stateRoot,
  validateConfig,
} from "./config.js";

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
  if (
    harness === "claude-agent-sdk" &&
    (!option(args, "worker-model") || !option(args, "claude-max-turns"))
  )
    throw new Error(
      "The Claude harness requires --worker-model and --claude-max-turns",
    );
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
  const defaultClaudeTools = ["Read", "Edit", "Write", "Glob", "Grep"];
  const copilotTools = options(args, "copilot-tool");
  const defaultCopilotTools = [
    "view",
    "create",
    "edit",
    "apply_patch",
    "grep",
    "glob",
  ];
  const config = {
    schemaVersion: 1,
    repository,
    checkout,
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
              maxTurns: Number(option(args, "claude-max-turns")),
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
  validateConfig(config);
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
  return `Configured Factory for ${repository} at ${path} with ${concurrency === undefined ? "concurrency and scheduling sized from the host at run time" : `concurrency ${concurrency}`}`;
}
