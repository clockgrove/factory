import type {
  CopilotClientOptions,
  PermissionHandler,
  SessionConfig,
} from "@github/copilot-sdk";
import type { GitHubCopilotWorkerInput } from "./github-copilot.js";
import { FACTORY_VERSION } from "../package-metadata.js";
import { requireCopilotHome } from "./github-copilot-session.js";
import { pathInsideRoot } from "./harness-support.js";

function permissionHandler(input: GitHubCopilotWorkerInput): PermissionHandler {
  const allowed = new Set(input.config.permissionKinds);
  return (request) => {
    if (
      request.managedApprovalRequired ||
      (request.kind !== "read" && request.kind !== "write") ||
      !allowed.has(request.kind)
    )
      return {
        kind: "reject",
        feedback: "Factory did not grant this capability",
      };
    if (request.requestSandboxBypass)
      return {
        kind: "reject",
        feedback: "Factory does not grant sandbox bypass",
      };
    const path = request.kind === "read" ? request.path : request.fileName;
    return pathInsideRoot(path, input.request.worktree)
      ? { kind: "approve-once" }
      : {
          kind: "reject",
          feedback: "Factory grants file access only inside its worktree",
        };
  };
}

/** SDK 1.0.13 exposes the configured grep file-search capability as rg. */
function canonicalCopilotTools(tools: readonly string[]): string[] {
  return tools.map((name) => (name === "grep" ? "rg" : name));
}

/** The native model may select editing tools, but cannot widen the ceiling. */
export function assertCopilotToolPolicy(
  input: GitHubCopilotWorkerInput,
  names: readonly string[] | undefined,
): void {
  const allowed = new Set(canonicalCopilotTools(input.config.availableTools));
  if (
    !names?.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.has(name))
  )
    throw new Error(
      `Copilot effective tool policy does not match the current Work Item: allowed ${JSON.stringify([...allowed].sort())}; observed ${JSON.stringify(names ?? null)}`,
    );
  const offered = new Set(names);
  if (
    input.config.permissionKinds.includes("read") &&
    !["view", "rg", "glob"].some((name) => offered.has(name))
  )
    throw new Error(
      "Copilot effective tool policy lacks required file reading",
    );
  if (
    input.config.permissionKinds.includes("write") &&
    (!input.request.item.kind || input.request.item.kind === "work") &&
    !input.request.discovery &&
    input.request.item.ownedPaths.length &&
    !["create", "edit", "apply_patch"].some((name) => offered.has(name))
  )
    throw new Error(
      "Copilot effective tool policy lacks required file editing",
    );
}

export function githubCopilotClientOptions(
  input: GitHubCopilotWorkerInput,
  environment: NodeJS.ProcessEnv,
  baseDirectory: string,
): CopilotClientOptions {
  return {
    mode: "empty",
    workingDirectory: input.request.worktree,
    baseDirectory,
    builtinPluginDirectories: [],
    logLevel: "error",
    env: { ...environment },
    useLoggedInUser: true,
    sessionIdleTimeoutSeconds: input.config.timeoutSeconds,
    enableRemoteSessions: false,
    clientInfo: {
      applicationName: "clockgrove-factory",
      applicationVersion: FACTORY_VERSION,
      integrationName: "github-copilot-agent-harness",
      integrationVersion: "1",
    },
  };
}

export function githubCopilotSessionOptions(
  input: GitHubCopilotWorkerInput,
): SessionConfig {
  return {
    clientName: "clockgrove-factory",
    model: input.config.model,
    reasoningEffort: input.config.reasoningEffort,
    systemMessage: {
      mode: "append",
      content:
        "You are an implementation worker controlled by Clockgrove Factory. Work only in the supplied current working directory and only on paths owned by the Work Item. Do not commit, push, publish, open or edit issues or pull requests, access GitHub tools, deploy, or change the current Git HEAD. Earlier conversation and tool results are advisory history; the current Work Item, working directory, owned paths and permissions are authoritative. Recheck changed files before relying on historical reads. Return a concise description and stop when complete or safely blocked.",
    },
    availableTools: canonicalCopilotTools(input.config.availableTools).map(
      (name) => `builtin:${name}`,
    ),
    enableConfigDiscovery: false,
    enableExperimentalMode: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    onPermissionRequest: permissionHandler(input),
    workingDirectory: input.request.worktree,
    additionalDirectories: [],
    streaming: false,
    includeSubAgentStreamingEvents: false,
    mcpOAuthTokenStorage: "in-memory",
    mcpServers: {},
    customAgents: [],
    skillDirectories: [],
    pluginDirectories: [],
    instructionDirectories: [],
    infiniteSessions: { enabled: Boolean(input.session) },
    ...(input.session
      ? { configDirectory: requireCopilotHome(input.session) }
      : {}),
    memory: { enabled: false },
    enableMcpApps: false,
    enableSessionTelemetry: false,
    enableFileChangeTracking: false,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    remoteSession: "off",
  };
}
