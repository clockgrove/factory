import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_AGENT_SDK_ADAPTER_IDENTITY } from "../config.js";
import {
  type AgentSessionRef,
  AuthenticationRequiredError,
  type WorkerUsageObservation,
} from "../contracts.js";
import {
  closeProviderEventStream,
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
} from "../provider-turn.js";
import {
  type ClaudeWorkerInput,
  claudeAuthenticationFailure,
  claudeAuthenticationValues,
} from "./claude.js";
import {
  createFactoryWorktreeMcp,
  factoryMcpServerName,
  factoryMcpToolName,
  type PreparedClaudeEnvironment,
} from "./claude-environment.js";
import { claudeQueryOptions } from "./claude-options.js";
import {
  type ClaudeSessionData,
  claudeHistoryDigest,
  claudePrivateWrite,
} from "./claude-session.js";
import {
  ClaudeUsage,
  claudeCost,
  claudeModelUsage,
  claudeRawTokenUsage,
} from "./claude-usage.js";
import {
  createFactoryValidationMcp,
  factoryValidationServerName,
  factoryValidationToolName,
  type PreparedClaudeValidation,
  workerValidationCommands,
} from "./claude-validation.js";
import {
  createFactoryFilesMcp,
  factoryFilesAuthorized,
  factoryFilesServerName,
  factoryFilesToolNames,
  type PreparedClaudeFiles,
} from "./claude-files.js";
import {
  createFactoryShellMcp,
  factoryShellAuthorized,
  factoryShellServerName,
  factoryShellToolName,
  type PreparedClaudeShell,
} from "./claude-shell.js";
import {
  harnessFailure,
  ProviderLimitError,
  privateProgress,
  readProducedAssets,
  redact,
  renderWorkItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import { WorkerInteractionCapture } from "./interaction-capture.js";
import { indexHasGitlinks } from "./staged-candidate.js";
import { workerShellRoot } from "./local.js";
import { toolActivity } from "./tool-activity.js";

function progressEvent(
  message: SDKMessage,
  attemptId: string,
  secrets: string[],
  worktree: string,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    eventId: randomUUID(),
    at: new Date().toISOString(),
    attemptId,
    operation: message.type,
  };
  if ("subtype" in message && typeof message.subtype === "string")
    event.subtype = message.subtype;
  if ("session_id" in message && typeof message.session_id === "string")
    event.sessionId = redact(message.session_id, secrets);
  if (message.type === "system" && message.subtype === "init") {
    event.skills = message.skills.map((name) => redact(name, secrets));
    event.agents = message.agents?.map((name) => redact(name, secrets)) ?? [];
    event.plugins = message.plugins.map(({ name, path, version }) => ({
      name: redact(name, secrets),
      path: redact(path, secrets),
      ...(version && { version: redact(version, secrets) }),
    }));
  }
  // Which tools the turn called and what they targeted, never their content.
  if (message.type === "assistant") {
    const content = (message.message as { content?: unknown }).content;
    const tools = (Array.isArray(content) ? content : [])
      .filter(
        (block): block is { type: "tool_use"; name: unknown; input: unknown } =>
          !!block && typeof block === "object" && block.type === "tool_use",
      )
      .map((block) => toolActivity(block.name, block.input, worktree))
      .filter((activity) => activity !== undefined)
      .slice(0, 16)
      .map((activity) => ({
        tool: activity.tool,
        ...(activity.target && { target: redact(activity.target, secrets) }),
      }));
    if (tools.length) event.tools = tools;
  }
  if (message.type === "result") {
    event.success = message.subtype === "success" && !message.is_error;
    event.turns = message.num_turns;
    event.usage = claudeRawTokenUsage(message.usage);
    event.modelUsage = claudeModelUsage(message.modelUsage, secrets);
    event.totalCostUsd = claudeCost(message.total_cost_usd);
    if (message.subtype !== "success")
      event.detail = redact(message.errors.join("; "), secrets);
  }
  return event;
}

function assertInitialization(
  message: SDKSystemMessage,
  input: ClaudeWorkerInput,
  sdkModel: string,
  shellTool: boolean,
): void {
  const { config, request } = input;
  if (resolve(message.cwd) !== resolve(request.worktree))
    throw new Error("Claude SDK initialized outside the supplied worktree");
  // The SDK reports the requested string, including a `[1m]` window suffix.
  if (message.model !== sdkModel)
    throw new Error(
      `Claude SDK selected model ${message.model}, expected ${sdkModel}`,
    );
  if (message.permissionMode !== config.permissionMode)
    throw new Error(
      `Claude SDK selected permission mode ${message.permissionMode}, expected ${config.permissionMode}`,
    );
  if (message.effort !== undefined && message.effort !== config.reasoningEffort)
    throw new Error(
      `Claude SDK selected reasoning effort ${String(message.effort)}, expected ${config.reasoningEffort}`,
    );
  const validating = workerValidationCommands(input).length > 0;
  const configuredTools = new Set(config.tools);
  if (request.environment?.mcp) configuredTools.add(factoryMcpToolName);
  if (validating) configuredTools.add(factoryValidationToolName);
  const fileTools = factoryFilesAuthorized(input);
  if (fileTools)
    for (const tool of factoryFilesToolNames) configuredTools.add(tool);
  if (shellTool) configuredTools.add(factoryShellToolName);
  const unexpectedTool = message.tools.find(
    (tool) => !configuredTools.has(tool),
  );
  if (unexpectedTool)
    throw new Error(`Claude SDK exposed unconfigured tool ${unexpectedTool}`);
  const expectedServers = [
    ...(request.environment?.mcp ? [factoryMcpServerName] : []),
    ...(validating ? [factoryValidationServerName] : []),
    ...(fileTools ? [factoryFilesServerName] : []),
    ...(shellTool ? [factoryShellServerName] : []),
  ];
  if (
    message.mcp_servers.length !== expectedServers.length ||
    message.mcp_servers.some(
      (server) =>
        server.source !== "sdk" || !expectedServers.includes(server.name),
    ) ||
    new Set(message.mcp_servers.map((server) => server.name)).size !==
      expectedServers.length
  )
    throw new Error(
      expectedServers.length
        ? "Claude SDK initialized an unexpected profile MCP inventory"
        : "Claude SDK initialized an unconfigured MCP server",
    );
  // Plugin, skill and agent lists describe runtime inventory, not permissions.
  // In the pinned runtime, init.skills lists user-invocable commands even when
  // skills: [] hides them from the model. Empty agents adds no custom agents;
  // it does not remove built-ins. Explicit tools and host hooks enforce access.
}

/** Continuations of one attempt's conversation after a turn-limit stop. */
const MAX_TURN_LIMIT_CONTINUATIONS = 2;

/**
 * The user turns of one streaming query. Streaming input keeps the native
 * conversation, its tools and MCP servers open after a result, so a turn-limit
 * stop continues in place with a fresh turn budget. Ending it lets the CLI exit.
 */
function userTurns() {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    async *messages(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        const content = pending.shift();
        if (content !== undefined)
          yield {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
          };
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    send(content: string): void {
      pending.push(content);
      notify();
    },
    end(): void {
      ended = true;
      notify();
    },
  };
}

/** Validate evidence, noting for review a result whose final files no passing run covered. */
async function validationEvidence(validation: PreparedClaudeValidation) {
  const evidence = await validation.evidence();
  return evidence.finalTreeValidated === false
    ? {
        ...evidence,
        note: "No passing Validate run covered the worker's final files, even after a request to validate them.",
      }
    : evidence;
}

function resultError(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "success") return result.errors.join("; ");
  return result.is_error ? result.result : undefined;
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("Claude worker requires input and result paths");
  const input = JSON.parse(
    readFileSync(inputPath, "utf8"),
  ) as ClaudeWorkerInput;
  const redactionValues = claudeAuthenticationValues(process.env);
  const progressPath = resultPath.replace(
    /\.result\.json$/,
    ".progress.ndjson",
  );
  const capture = new WorkerInteractionCapture(
    input.request,
    progressPath,
    redactionValues,
    {
      provider: "claude",
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
    },
  );
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  const turn = new ProviderTurnGuard(
    input.providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  );
  turn.signal.addEventListener(
    "abort",
    () => controller.abort(turn.signal.reason),
    { once: true },
  );
  let providerCompleted = false;
  let prepared: PreparedClaudeEnvironment | undefined;
  let validation: PreparedClaudeValidation | undefined;
  let files: PreparedClaudeFiles | undefined;
  let shell: PreparedClaudeShell | undefined;
  let events: AsyncIterator<SDKMessage> | undefined;
  let closeStarted = false;
  let progressLost = false;
  const turns = userTurns();
  const usage = new ClaudeUsage(
    redactionValues,
    input.session?.data.baseline,
    input.session?.resume,
  );
  const observeUsage = (type: WorkerUsageObservation["type"]): void => {
    if (progressLost) return;
    const workerUsage: WorkerUsageObservation = {
      type,
      invocationId: input.request.attemptId ?? "",
      providerAttempt: 1,
      ...(input.request.item.executionBinding
        ? {
            profileId: input.request.item.executionBinding.id,
            adapter: input.request.item.executionBinding.adapter,
          }
        : {}),
      role: "worker",
      phase: "implementation",
      provider: "claude",
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      usage: type === "started" ? {} : usage.totals(),
    };
    try {
      privateProgress(progressPath, {
        eventId: randomUUID(),
        at: new Date().toISOString(),
        attemptId: input.request.attemptId ?? "",
        operation: "worker-usage",
        workerUsage,
      });
    } catch (error) {
      progressLost = true;
      process.stderr.write(
        `Factory Claude worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  try {
    observeUsage("started");
    const { query } = await turn.race(import("@anthropic-ai/claude-agent-sdk"));
    if (input.request.environment?.mcp) {
      prepared = await turn.race(
        createFactoryWorktreeMcp({
          worktree: input.request.worktree,
          config: input.config,
        }).then(async (environment) => {
          if (controller.signal.aborted) {
            await environment.close();
            throw new Error("Claude environment preparation interrupted");
          }
          return environment;
        }),
      );
    }
    const validationCommands = workerValidationCommands(input);
    if (validationCommands.length) {
      validation = await turn.race(
        createFactoryValidationMcp({
          worktree: input.request.worktree,
          commands: validationCommands,
          ownedPaths: input.request.item.ownedPaths,
          config: input.config,
          ...(input.request.validationLfs && {
            lfs: input.request.validationLfs,
          }),
          ...(input.request.commandSandbox && {
            sandbox: input.request.commandSandbox,
          }),
          packageAuthority: {
            sourceDeclared: input.request.item.validation
              .filter((check) => check.provenance === "source-declared")
              .map((check) => check.command),
            ...(input.request.packageManagerUpdate !== undefined && {
              packageManagerUpdate: input.request.packageManagerUpdate,
            }),
          },
          handoff: {
            peers: input.request.handoffPeers ?? [],
            acceptance: input.request.item.acceptance,
          },
          onRun: (validation) => {
            if (progressLost) return;
            try {
              privateProgress(progressPath, {
                eventId: randomUUID(),
                at: new Date().toISOString(),
                attemptId: input.request.attemptId ?? "",
                operation: "validation",
                validation,
              });
            } catch (error) {
              progressLost = true;
              process.stderr.write(
                `Factory Claude worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            }
          },
        }).then(async (environment) => {
          if (controller.signal.aborted) {
            await environment.close();
            throw new Error("Claude environment preparation interrupted");
          }
          return environment;
        }),
      );
    }
    if (factoryFilesAuthorized(input)) {
      files = await turn.race(
        createFactoryFilesMcp({
          worktree: input.request.worktree,
          ownedPaths: input.request.item.ownedPaths,
          config: input.config,
        }).then(async (environment) => {
          if (controller.signal.aborted) {
            await environment.close();
            throw new Error("Claude environment preparation interrupted");
          }
          return environment;
        }),
      );
    }
    // Not in a checkout with submodule gitlinks: host-side Git would enter a
    // repository the shell could write behind one.
    if (
      factoryShellAuthorized(input) &&
      !indexHasGitlinks(input.request.worktree)
    ) {
      shell = await turn.race(
        createFactoryShellMcp({
          worktree: input.request.worktree,
          root: workerShellRoot(input.request.worktree),
          config: input.config,
          ...(input.request.commandSandbox && {
            sandbox: input.request.commandSandbox,
          }),
        }).then(async (environment) => {
          if (controller.signal.aborted) {
            await environment.close();
            throw new Error("Claude environment preparation interrupted");
          }
          return environment;
        }),
      );
    }
    const rendered = renderWorkItemPrompt(
      input.request,
      input.request.worktree,
    );
    const prompt = rendered.prompt;
    const options = claudeQueryOptions(
      input,
      process.env,
      controller,
      prepared,
      validation,
      files,
      shell,
    );
    capture.request(
      prompt,
      {
        systemPrompt: options.systemPrompt,
        tools: options.tools,
        allowedTools: options.allowedTools,
        permissionMode: options.permissionMode,
      },
      rendered.sections,
    );
    if (input.session) {
      input.session.ref.currentTurn = {
        ...input.session.ref.currentTurn!,
        dispatch: "submitted",
        resources: "active",
      };
      claudePrivateWrite(
        join(input.session.data.root, "pending.json"),
        input.session.ref,
      );
    }
    turns.send(prompt);
    const stream = query({ prompt: turns.messages(), options });
    let continuations = 0;
    let validationRequested = false;
    let result: SDKResultMessage | undefined;
    // The SDK reports a reached usage or session limit as structure.
    let limit: { retryAt?: string } | undefined;
    let assistantError: SDKAssistantMessageError | undefined;
    let initialization: SDKSystemMessage | undefined;
    events = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await turn.race(events.next());
      if (next.done) break;
      const message = next.value;
      turn.progress();
      if (message.type === "result") result = message;
      if (message.type === "assistant" && message.error)
        assistantError = message.error;
      if (message.type === "rate_limit_event") {
        const { status, resetsAt } = message.rate_limit_info;
        // The SDK gives the reset as Unix seconds.
        limit =
          status === "rejected"
            ? {
                ...(resetsAt !== undefined && {
                  retryAt: new Date(resetsAt * 1000).toISOString(),
                }),
              }
            : undefined;
      }
      const observedUsage = usage.observe(message);
      capture.claude(
        message,
        observedUsage,
        message.type === "result"
          ? { costUsd: usage.cost() ?? null }
          : undefined,
      );
      if (!progressLost)
        try {
          privateProgress(progressPath, {
            ...progressEvent(
              message,
              input.request.attemptId ?? "",
              redactionValues,
              input.request.worktree,
            ),
            ...observedUsage,
          });
        } catch (error) {
          progressLost = true;
          process.stderr.write(
            `Factory Claude worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      if (message.type === "system" && message.subtype === "init") {
        assertInitialization(message, input, options.model!, !!shell);
        if (prepared || validation || files || shell) {
          const statuses = await turn.race(stream.mcpServerStatus());
          prepared?.markReady(
            statuses.filter((status) => status.name === factoryMcpServerName),
          );
          if (validation) {
            const owned = statuses.filter(
              (status) => status.name === factoryValidationServerName,
            );
            if (owned.length !== 1)
              throw new Error(
                "Factory validation MCP readiness verification failed",
              );
            validation.markReady(owned[0]!);
          }
          if (files) {
            const owned = statuses.filter(
              (status) => status.name === factoryFilesServerName,
            );
            if (owned.length !== 1)
              throw new Error(
                "Factory files MCP readiness verification failed",
              );
            files.markReady(owned[0]!);
          }
          if (shell) {
            const owned = statuses.filter(
              (status) => status.name === factoryShellServerName,
            );
            if (owned.length !== 1)
              throw new Error(
                "Factory shell MCP readiness verification failed",
              );
            shell.markReady(owned[0]!);
          }
        }
        if (
          input.session &&
          message.session_id !== input.session.data.nativeSessionId
        )
          throw new Error(
            "Claude worker initialized a different native conversation",
          );
        initialization = message;
      }
      if (
        message.type === "result" &&
        message.subtype === "error_max_turns" &&
        continuations < MAX_TURN_LIMIT_CONTINUATIONS
      ) {
        // A turn-limit stop is unfinished work, not a failed attempt: the same
        // conversation and worktree continue under the same attempt and usage.
        continuations += 1;
        const continuation = `You reached the turn limit before finishing. Continue the same task from where you stopped.${validation ? " Finish only after Validate passes on your final files," : " Finish the change,"} then review your own diff, then give your final report.`;
        capture.request(continuation);
        turns.send(continuation);
        continue;
      }
      if (
        message.type === "result" &&
        validation &&
        !validationRequested &&
        !resultError(message) &&
        (await turn.race(validation.evidence())).finalTreeValidated === false
      ) {
        // One more turn when no passing Validate run covers the final files.
        validationRequested = true;
        const request =
          "Run Validate on your final files, fix any failures, then give your final report.";
        capture.request(request);
        turns.send(request);
        continue;
      }
      if (message.type === "result") break;
    }
    if (!initialization)
      throw new Error("Claude SDK did not report its initialized session");
    if (!result) throw new Error("Claude SDK ended without a result");
    const error = resultError(result);
    if (error)
      throw claudeAuthenticationFailure(result, assistantError)
        ? new AuthenticationRequiredError(error, {
            provider: "claude",
            command: "claude auth login",
          })
        : limit
          ? new ProviderLimitError(error, limit.retryAt)
          : new Error(error);
    turns.end();
    closeStarted = true;
    await closeProviderEventStream(events, turn, true);
    if (prepared) await turn.race(prepared.close());
    if (validation) await turn.race(validation.close());
    if (files) await turn.race(files.close());
    if (shell) await turn.race(shell.close());
    turn.finish();
    providerCompleted = true;
    capture.providerCompleted();
    if (
      input.session &&
      result.session_id !== input.session.data.nativeSessionId
    )
      throw new Error(
        "Claude worker result belongs to a different conversation",
      );
    let session: AgentSessionRef | undefined;
    if (input.session) {
      const data: ClaudeSessionData = {
        ...input.session.data,
        nativeTerminal: true,
        baseline: usage.boundary(),
        historyDigest: claudeHistoryDigest(input.session),
      };
      session = {
        ...input.session.ref,
        status: "in-flight",
        data,
        currentTurn: {
          ...input.session.ref.currentTurn!,
          terminal: "completed",
          resources: "unknown",
        },
      };
    }
    const assets = readProducedAssets(input.request);
    observeUsage("completed");
    capture.outcome("completed", usage.totals(), undefined, "protocol");
    writeHarnessResult(resultPath, {
      state: "complete",
      assets,
      ...(session && { session }),
      evidence: {
        harness: "claude-agent-sdk",
        ...(prepared && { environment: prepared.evidence() }),
        ...(validation && { validation: await validationEvidence(validation) }),
        adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
        sessionId: result.session_id,
        configuredModel: input.config.model,
        observedModel: initialization.model,
        reasoningEffort: input.config.reasoningEffort,
        permissionMode: initialization.permissionMode,
        settingSources: input.config.settingSources,
        plugins: initialization.plugins.map(({ name, path, version }) => ({
          name: redact(name, redactionValues),
          path: redact(path, redactionValues),
          ...(version && { version: redact(version, redactionValues) }),
        })),
        finalResponse: result.subtype === "success" ? result.result : "",
        usage: claudeRawTokenUsage(result.usage),
        modelUsage: claudeModelUsage(result.modelUsage, redactionValues),
        totalCostUsd: usage.cost(),
        cumulativeCostUsd: claudeCost(result.total_cost_usd),
      },
    });
  } catch (error) {
    if (events && !closeStarted && !turn.signal.aborted) {
      closeStarted = true;
      try {
        await closeProviderEventStream(events, turn, true);
      } catch {
        /* Preserve the authoritative provider failure. */
      }
    }
    writeHarnessResult(
      resultPath,
      harnessFailure("claude", error, redactionValues),
    );
    observeUsage("failed");
    capture.outcome(
      "failed",
      usage.totals(),
      error,
      providerCompleted ? "protocol" : "provider",
    );
    process.exitCode = 1;
  } finally {
    turns.end();
    if (events && !closeStarted)
      void closeProviderEventStream(events, turn, false);
    for (const owned of [prepared, validation, files, shell]) {
      if (!owned) continue;
      const closing = owned.close();
      if (!turn.signal.aborted) {
        try {
          await turn.race(closing);
        } catch {
          /* Preserve the attempt failure. */
        }
      } else void closing.catch(() => undefined);
    }
    turn.finish();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
