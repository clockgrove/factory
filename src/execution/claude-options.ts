import { isAbsolute } from "node:path";
import type { HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeWorkerInput } from "./claude.js";
import { pathInsideRoot } from "./harness-support.js";

const systemPrompt = [
  "You are an implementation worker controlled by Clockgrove Factory.",
  "Work only in the supplied current working directory and only on paths owned by the Work Item.",
  "Do not commit, push, open or edit issues or pull requests, access GitHub credentials, deploy, or change the current Git HEAD.",
  "Return a concise description of the work performed and stop when the Work Item is complete or cannot be completed safely.",
].join(" ");

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
): boolean {
  if (
    !toolInput ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput) ||
    !input.config.tools.includes(toolName) ||
    !input.config.allowedTools.includes(toolName) ||
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
): HookJSONOutput {
  const allowed =
    hookInput.hook_event_name === "PreToolUse" &&
    claudeToolAllowed(
      input,
      hookInput.tool_name,
      hookInput.tool_input,
      hookInput.mcp_server,
    );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allowed ? "allow" : "deny",
      ...(!allowed && { permissionDecisionReason: deniedMessage }),
    },
  };
}

/** Build the complete, fail-closed SDK option set from validated adapter config. */
export function claudeQueryOptions(
  input: ClaudeWorkerInput,
  environment: NodeJS.ProcessEnv,
  abortController: AbortController,
): Options {
  const { config, request } = input;
  return {
    abortController,
    cwd: request.worktree,
    model: config.model,
    // Factory calls this reasoningEffort across all harnesses; the Claude SDK
    // names the equivalent provider option `effort`.
    effort: config.reasoningEffort,
    tools: [...config.tools],
    // Bare allowedTools bypass canUseTool in the Claude SDK. Keep Factory's
    // configured allow-list in the host policy below, never in this SDK field.
    allowedTools: [],
    permissionMode: config.permissionMode,
    permissionPrompts: "host",
    hooks: {
      PreToolUse: [
        {
          hooks: [async (hookInput) => preToolUseDecision(input, hookInput)],
        },
      ],
    },
    canUseTool: async (toolName, toolInput, permission) => {
      if (!claudeToolAllowed(input, toolName, toolInput, permission.mcpServer))
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
      claudeMdExcludes: ["**"],
    },
    maxTurns: config.maxTurns,
    env: { ...environment, DISABLE_TELEMETRY: "1" },
    mcpServers: {},
    strictMcpConfig: true,
    agents: {},
    plugins: [],
    skills: [],
    systemPrompt,
    verbatimPrompts: true,
    thinking: { type: "adaptive" },
    persistSession: false,
  };
}
