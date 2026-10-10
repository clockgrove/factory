import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_AGENT_SDK_ADAPTER_IDENTITY } from "../config.js";
import type { AgentSessionRef, WorkerUsageObservation } from "../contracts.js";
import {
  closeProviderEventStream,
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
} from "../provider-turn.js";
import {
  type ClaudeWorkerInput,
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
  harnessFailure,
  privateProgress,
  readProducedAssets,
  redact,
  renderWorkItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import { WorkerInteractionCapture } from "./interaction-capture.js";

function progressEvent(
  message: SDKMessage,
  attemptId: string,
  secrets: string[],
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
): void {
  const { config, request } = input;
  if (resolve(message.cwd) !== resolve(request.worktree))
    throw new Error("Claude SDK initialized outside the supplied worktree");
  if (message.model !== config.model)
    throw new Error(
      `Claude SDK selected model ${message.model}, expected ${config.model}`,
    );
  if (message.permissionMode !== config.permissionMode)
    throw new Error(
      `Claude SDK selected permission mode ${message.permissionMode}, expected ${config.permissionMode}`,
    );
  if (message.effort !== undefined && message.effort !== config.reasoningEffort)
    throw new Error(
      `Claude SDK selected reasoning effort ${String(message.effort)}, expected ${config.reasoningEffort}`,
    );
  const configuredTools = new Set(config.tools);
  if (request.environment?.mcp) configuredTools.add(factoryMcpToolName);
  const unexpectedTool = message.tools.find(
    (tool) => !configuredTools.has(tool),
  );
  if (unexpectedTool)
    throw new Error(`Claude SDK exposed unconfigured tool ${unexpectedTool}`);
  if (request.environment?.mcp) {
    if (
      message.mcp_servers.length !== 1 ||
      message.mcp_servers[0]?.name !== factoryMcpServerName ||
      message.mcp_servers[0]?.source !== "sdk"
    )
      throw new Error(
        "Claude SDK initialized an unexpected profile MCP inventory",
      );
  } else if (message.mcp_servers.length)
    throw new Error("Claude SDK initialized an unconfigured MCP server");
  // Plugin, skill and agent lists describe runtime inventory, not permissions.
  // In the pinned runtime, init.skills lists user-invocable commands even when
  // skills: [] hides them from the model. Empty agents adds no custom agents;
  // it does not remove built-ins. Explicit tools and host hooks enforce access.
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
  let events: AsyncIterator<SDKMessage> | undefined;
  let closeStarted = false;
  let progressLost = false;
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
    const rendered = renderWorkItemPrompt(input.request);
    const prompt = rendered.prompt;
    const options = claudeQueryOptions(
      input,
      process.env,
      controller,
      prepared,
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
    const stream = query({ prompt, options });
    let result: SDKResultMessage | undefined;
    let initialization: SDKSystemMessage | undefined;
    events = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await turn.race(events.next());
      if (next.done) break;
      const message = next.value;
      turn.progress();
      if (message.type === "result") result = message;
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
        assertInitialization(message, input);
        if (prepared)
          prepared.markReady(await turn.race(stream.mcpServerStatus()));
        if (
          input.session &&
          message.session_id !== input.session.data.nativeSessionId
        )
          throw new Error(
            "Claude worker initialized a different native conversation",
          );
        initialization = message;
      }
      if (message.type === "result") break;
    }
    if (!initialization)
      throw new Error("Claude SDK did not report its initialized session");
    if (!result) throw new Error("Claude SDK ended without a result");
    const error = resultError(result);
    if (error) throw new Error(error);
    closeStarted = true;
    await closeProviderEventStream(events, turn, true);
    if (prepared) await turn.race(prepared.close());
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
    if (events && !closeStarted)
      void closeProviderEventStream(events, turn, false);
    if (prepared) {
      const closing = prepared.close();
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
