import type {
  CopilotClientOptions,
  PermissionHandler,
  SessionConfig,
  Tool,
} from "@github/copilot-sdk";
import type { GitHubCopilotWorkerInput } from "./github-copilot.js";
import { validateToolConfigName } from "../config.js";
import { FACTORY_VERSION } from "../package-metadata.js";
import {
  checkWorkHandoff,
  runDeclaredValidation,
  workerFilesTree,
  workerValidationCommands,
} from "./claude-validation.js";
import { requireCopilotHome } from "./github-copilot-session.js";
import { pathInsideRoot } from "./harness-support.js";

/** The SDK custom tool the worker serves for a configured Validate. */
export const copilotValidationToolName = "run_validation";

/** Copilot has one tool list: Validate in it is both configured and allowed. */
export function copilotValidationCommands(
  input: GitHubCopilotWorkerInput,
): string[] {
  const tools = input.config.availableTools;
  return workerValidationCommands({
    config: { tools, allowedTools: tools },
    request: input.request,
  });
}

/**
 * Validate as an SDK custom tool: the item's declared commands, run one at a
 * time through the Claude worker's runner and handoff decode, with its result
 * text and evidence. It takes no arguments, so the worker names no command.
 */
export function createCopilotValidation(
  input: GitHubCopilotWorkerInput,
  onRun: (facts: Record<string, unknown>) => void,
) {
  const commands = copilotValidationCommands(input);
  if (!commands.length)
    throw new Error(
      "Copilot validation requires configured Validate and declared commands",
    );
  const worktree = input.request.worktree;
  const handoff = {
    peers: input.request.handoffPeers ?? [],
    acceptance: input.request.item.acceptance,
  };
  let ready = false;
  let runs = 0;
  let passed = 0;
  const passedTrees = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const tool: Tool = {
    name: copilotValidationToolName,
    description:
      "Run this work item's declared validation commands (the same ones Factory runs after you finish) on a snapshot of your current files, decode .factory-handoff.json as Factory will when it collects your result, and return the result. Takes several minutes. Run it after implementing and fix any failure it reports. Run it again after your last edit, including self-review and handoff fixes: finish only after a run passes on your final files.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    defer: "never",
    handler: async () => {
      const run = ++runs;
      const result = queue.then(async () => {
        if (!ready) throw new Error("Factory validation is not ready");
        const checked = checkWorkHandoff(worktree, handoff);
        const declared = await runDeclaredValidation(worktree, commands, run);
        return { declared, handoff: checked };
      });
      queue = result.catch(() => undefined);
      try {
        const { declared, handoff: checked } = await result;
        const parts = [declared.text];
        if (checked.text)
          if (checked.passed) parts.push(checked.text);
          else parts.unshift(checked.text);
        // Self-review follows a passing run; after the bounded output, so never cut.
        if (declared.passed && checked.criteria) parts.push(checked.criteria);
        if (declared.passed && !checked.passed)
          parts.unshift("Validation failed. Fix this before you finish.");
        if (declared.passed) {
          // The handoff is outside the tree; evidence decodes its final bytes.
          passedTrees.add(declared.tree);
          if (checked.passed) passed += 1;
        }
        try {
          onRun({
            run,
            passed: declared.passed && checked.passed,
            tree: declared.tree,
            commands: commands.length,
            ran: declared.ran,
            failed: declared.failed,
            handoffPassed: checked.passed,
          });
        } catch {
          // Telemetry only: a lost observation never changes the result.
        }
        return parts.join("\n\n");
      } catch (error) {
        const message = `Factory validation unavailable: ${error instanceof Error ? error.message : String(error)}`;
        return {
          resultType: "failure" as const,
          textResultForLlm: message,
          error: message,
        };
      }
    },
  };
  return {
    tool,
    markReady: () => {
      ready = true;
    },
    close: async () => {
      ready = false;
      await queue;
    },
    /** After the turn: did a passing run cover the files the worker returns, with a handoff collection accepts? */
    evidence: async () => {
      let finalTreeValidated: boolean | undefined = false;
      if (passedTrees.size)
        try {
          finalTreeValidated =
            passedTrees.has(await workerFilesTree(worktree)) &&
            checkWorkHandoff(worktree, handoff).passed;
        } catch {
          // Collection classifies an unstageable worktree itself.
          finalTreeValidated = undefined;
        }
      return {
        kind: "factory-validation" as const,
        version: 1 as const,
        runs,
        passed,
        ...(finalTreeValidated !== undefined && { finalTreeValidated }),
        ...(finalTreeValidated === false && {
          note: "No passing Validate run covered the worker's final files.",
        }),
      };
    },
  };
}

function permissionHandler(input: GitHubCopilotWorkerInput): PermissionHandler {
  const allowed = new Set(input.config.permissionKinds);
  const validating = copilotValidationCommands(input).length > 0;
  return (request) => {
    // Only Factory's Validate, without arguments: the worker names no command.
    if (request.kind === "custom-tool")
      return !request.managedApprovalRequired &&
        validating &&
        request.toolName === copilotValidationToolName &&
        (request.args === undefined ||
          (typeof request.args === "object" &&
            request.args !== null &&
            !Array.isArray(request.args) &&
            !Object.keys(request.args).length))
        ? { kind: "approve-once" }
        : {
            kind: "reject",
            feedback: "Factory did not grant this capability",
          };
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

/**
 * SDK 1.0.13 exposes the configured grep file-search capability as rg;
 * Validate is the worker's own custom tool.
 */
function canonicalCopilotTools(tools: readonly string[]): string[] {
  return tools.map((name) =>
    name === "grep"
      ? "rg"
      : name === validateToolConfigName
        ? copilotValidationToolName
        : name,
  );
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
    copilotValidationCommands(input).length &&
    !offered.has(copilotValidationToolName)
  )
    throw new Error("Copilot effective tool policy lacks Factory validation");
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
  tools: Tool[] = [],
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
      (name) =>
        name === copilotValidationToolName
          ? `custom:${name}`
          : `builtin:${name}`,
    ),
    ...(tools.length && { tools }),
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
