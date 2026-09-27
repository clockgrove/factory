import type {
  CopilotClientOptions,
  PermissionHandler,
  SessionConfig,
} from "@github/copilot-sdk";
import type { GitHubCopilotWorkerInput } from "./github-copilot.js";
import { FACTORY_VERSION } from "../package-metadata.js";
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
        "You are an implementation worker controlled by Clockgrove Factory. Work only in the supplied current working directory and only on paths owned by the Work Item. Do not commit, push, publish, open or edit issues or pull requests, access GitHub tools, deploy, or change the current Git HEAD. Return a concise description and stop when complete or safely blocked.",
    },
    availableTools: [...input.config.availableTools],
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
    infiniteSessions: { enabled: false },
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
