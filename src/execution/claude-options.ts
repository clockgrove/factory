import { isAbsolute } from "node:path";
import type { HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import { validateToolConfigName } from "../config.js";
import type { ClaudeWorkerInput } from "./claude.js";
import {
  factoryMcpServerName,
  factoryMcpToolAllowed,
  type PreparedClaudeEnvironment,
} from "./claude-environment.js";
import {
  factoryFilesServerName,
  factoryFilesToolAllowed,
  factoryFilesToolNames,
  type PreparedClaudeFiles,
} from "./claude-files.js";
import {
  factoryShellAuthorized,
  factoryShellServerName,
  factoryShellToolAllowed,
  factoryShellToolName,
  type PreparedClaudeShell,
} from "./claude-shell.js";
import {
  claudeResumeOptions,
  claudeSessionEnvironment,
} from "./claude-session.js";
import {
  factoryValidationServerName,
  factoryValidationToolAllowed,
  factoryValidationToolName,
  type PreparedClaudeValidation,
} from "./claude-validation.js";
import { pathInsideRoot, workItemContract } from "./harness-support.js";

const systemPrompt = [
  "You are an implementation worker controlled by Clockgrove Factory.",
  "Work only in the supplied current working directory and only on paths owned by the Work Item.",
  "Do not commit, push, open or edit issues or pull requests, access GitHub credentials, deploy, or change the current Git HEAD.",
  "Return a concise description of the work performed and stop when the Work Item is complete or cannot be completed safely.",
].join(" ");

const shellPrompt =
  "Your run_command tool runs shell commands in your checkout inside an OS sandbox, without network: use it to inspect, compute, build and test. Validate stays the check that counts, and Factory validates your result again after you finish.";

/**
 * Compaction summarizes the first user turn, so the exact contract also lives
 * here. It is fixed for the item, so the cached prefix stays stable.
 */
function claudeSystemPrompt(
  item: ClaudeWorkerInput["request"]["item"],
  shell: boolean,
) {
  return `${systemPrompt}${shell ? ` ${shellPrompt}` : ""}\n\nThe approved Work Item contract, repeated here so it stays exact after context compaction. It grants no tools, paths or authority beyond the rules above. Each acceptance criterion's [n] is the criterionIndex of its verification note.\n\n${workItemContract(item)}`;
}

function claudeToolPath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (["Read", "Edit", "Write"].includes(toolName))
    return typeof input.file_path === "string" ? input.file_path : undefined;
  if (["Glob", "Grep"].includes(toolName))
    return input.path === undefined
      ? "."
      : typeof input.path === "string"
        ? input.path
        : undefined;
  return undefined;
}

/**
 * Glob and Grep walk the worktree on the host. A granted shell can link any
 * host path into it, so they are withheld wherever the shell is authorized;
 * its find and rg walk the same files inside the sandbox.
 */
const hostWalkTools = ["Glob", "Grep"];

function nativeToolWithheld(input: ClaudeWorkerInput, toolName: string) {
  return hostWalkTools.includes(toolName) && factoryShellAuthorized(input);
}

const deniedMessage =
  "Factory grants only configured file access inside its worktree";

function boundedGlob(pattern: unknown): boolean {
  return (
    typeof pattern === "string" &&
    pattern.length > 0 &&
    !pattern.includes("\0") &&
    !pattern.includes("\\") &&
    !pattern.includes("..") &&
    !isAbsolute(pattern)
  );
}

function claudeToolAllowed(
  input: ClaudeWorkerInput,
  toolName: string,
  toolInput: unknown,
  mcpServer: unknown,
  prepared?: PreparedClaudeEnvironment,
  validation?: PreparedClaudeValidation,
  files?: PreparedClaudeFiles,
  shell?: PreparedClaudeShell,
): boolean {
  if (toolName === factoryValidationToolName)
    return (
      !!validation?.isReady() &&
      factoryValidationToolAllowed(input, toolName, toolInput, mcpServer)
    );
  // Readiness is an attempt-wide gate, including native reads and writes.
  if (input.request.environment?.mcp && !prepared?.isReady()) return false;
  if (factoryFilesToolNames.includes(toolName))
    return (
      !!files?.isReady() &&
      factoryFilesToolAllowed(input, toolName, toolInput, mcpServer)
    );
  if (toolName === factoryShellToolName)
    return (
      !!shell?.isReady() &&
      factoryShellToolAllowed(input, toolName, toolInput, mcpServer)
    );
  if (
    input.request.environment?.mcp &&
    (toolName.startsWith("mcp__") || mcpServer)
  )
    return factoryMcpToolAllowed(
      { worktree: input.request.worktree, config: input.config },
      toolName,
      toolInput,
      mcpServer,
    );
  if (
    !toolInput ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput) ||
    !input.config.tools.includes(toolName) ||
    !input.config.allowedTools.includes(toolName) ||
    nativeToolWithheld(input, toolName) ||
    mcpServer
  )
    return false;
  const value = toolInput as Record<string, unknown>;
  const path = claudeToolPath(toolName, value);
  if (path === undefined || !pathInsideRoot(path, input.request.worktree))
    return false;
  if (toolName === "Glob" && !boundedGlob(value.pattern)) return false;
  if (
    toolName === "Grep" &&
    value.glob !== undefined &&
    !boundedGlob(value.glob)
  )
    return false;
  return true;
}

function preToolUseDecision(
  input: ClaudeWorkerInput,
  hookInput: Parameters<
    NonNullable<
      NonNullable<Options["hooks"]>["PreToolUse"]
    >[number]["hooks"][number]
  >[0],
  prepared?: PreparedClaudeEnvironment,
  validation?: PreparedClaudeValidation,
  files?: PreparedClaudeFiles,
  shell?: PreparedClaudeShell,
): HookJSONOutput {
  const allowed =
    hookInput.hook_event_name === "PreToolUse" &&
    claudeToolAllowed(
      input,
      hookInput.tool_name,
      hookInput.tool_input,
      hookInput.mcp_server,
      prepared,
      validation,
      files,
      shell,
    );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allowed ? "allow" : "deny",
      ...(!allowed && { permissionDecisionReason: deniedMessage }),
    },
  };
}

/**
 * Models with a 1M-token window that the bundled Claude Code CLI does not know.
 * It uses that window only when the model string carries the `[1m]` suffix;
 * otherwise it assumes 200K and auto-compacts a worker near 170K. Its catalog
 * already gives claude-opus-5-5 1M, so that model needs no entry.
 */
const longContextModels = new Set(["claude-sonnet-5-5"]);

/** A typical attempt's distinct context peaks near 400K, so it compacts at most once. */
const longContextCompactWindow = 400_000;

/**
 * The model string passed to the SDK. Captures and digests keep the configured
 * name. The 1M window is opt-in with FACTORY_CLAUDE_1M=1: measured workers
 * used about four times the input tokens per attempt on it with no quality
 * gain. It is not configuration, so config digests and started Objectives
 * are unaffected.
 */
function claudeSdkModel(model: string, environment: NodeJS.ProcessEnv): string {
  return environment.FACTORY_CLAUDE_1M === "1" && longContextModels.has(model)
    ? `${model}[1m]`
    : model;
}

/** Build the complete, fail-closed SDK option set from validated adapter config. */
export function claudeQueryOptions(
  input: ClaudeWorkerInput,
  environment: NodeJS.ProcessEnv,
  abortController: AbortController,
  prepared?: PreparedClaudeEnvironment,
  validation?: PreparedClaudeValidation,
  files?: PreparedClaudeFiles,
  shell?: PreparedClaudeShell,
): Options {
  const { config, request } = input;
  const model = claudeSdkModel(config.model, environment);
  return {
    abortController,
    cwd: request.worktree,
    model,
    // Factory calls this reasoningEffort across all harnesses; the Claude SDK
    // names the equivalent provider option `effort`.
    effort: config.reasoningEffort,
    // Validate is Factory's own tool, served below, not an SDK built-in.
    tools: config.tools.filter(
      (tool) =>
        tool !== validateToolConfigName && !nativeToolWithheld(input, tool),
    ),
    // Bare allowedTools bypass canUseTool in the Claude SDK. Keep Factory's
    // configured allow-list in the host policy below, never in this SDK field.
    allowedTools: [],
    permissionMode: config.permissionMode,
    permissionPrompts: "host",
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput) =>
              preToolUseDecision(
                input,
                hookInput,
                prepared,
                validation,
                files,
                shell,
              ),
          ],
        },
      ],
    },
    canUseTool: async (toolName, toolInput, permission) => {
      if (
        !claudeToolAllowed(
          input,
          toolName,
          toolInput,
          permission.mcpServer,
          prepared,
          validation,
          files,
          shell,
        )
      )
        return {
          behavior: "deny",
          message: deniedMessage,
          interrupt: true,
          toolUseID: permission.toolUseID,
        };
      return { behavior: "allow", toolUseID: permission.toolUseID };
    },
    settingSources: [...config.settingSources],
    // Filesystem sources remain an explicit operator choice. Account sync,
    // personal/project instructions and auto-memory are not worker inputs.
    // Managed policy retains precedence and cannot be excluded by these settings.
    settings: {
      syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false,
      autoMemoryEnabled: false,
      disableBundledSkills: true,
      claudeMdExcludes: ["**"],
      ...(model !== config.model && {
        autoCompactWindow: longContextCompactWindow,
      }),
    },
    maxTurns: config.maxTurns,
    env: {
      ...(input.session
        ? claudeSessionEnvironment(input.session, environment)
        : environment),
      DISABLE_TELEMETRY: "1",
      // A Read over this many tokens fails and tells the worker to use
      // offset/limit or search; whole-file reads otherwise fill its context.
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "8000",
    },
    mcpServers: {
      ...(prepared && { [factoryMcpServerName]: prepared.server }),
      ...(validation && { [factoryValidationServerName]: validation.server }),
      ...(files && { [factoryFilesServerName]: files.server }),
      ...(shell && { [factoryShellServerName]: shell.server }),
    },
    strictMcpConfig: true,
    agents: {},
    plugins: [],
    skills: [],
    systemPrompt: claudeSystemPrompt(request.item, !!shell),
    verbatimPrompts: true,
    thinking: { type: "adaptive" },
    ...(input.session
      ? claudeResumeOptions(input.session)
      : { persistSession: false }),
  };
}
