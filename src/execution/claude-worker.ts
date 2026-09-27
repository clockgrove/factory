import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  claudeAuthenticationValues,
  type ClaudeWorkerInput,
} from "./claude.js";
import {
  harnessFailure,
  privateProgress,
  readProducedAssets,
  redact,
  workItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import { claudeQueryOptions } from "./claude-options.js";
import type { WorkerUsageObservation } from "../contracts.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  closeProviderEventStream,
} from "../provider-turn.js";

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
    event.sessionId = message.session_id;
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
    event.usage = message.usage;
    event.modelUsage = message.modelUsage;
    event.totalCostUsd = message.total_cost_usd;
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
  const unexpectedTool = message.tools.find(
    (tool) => !configuredTools.has(tool),
  );
  if (unexpectedTool)
    throw new Error(`Claude SDK exposed unconfigured tool ${unexpectedTool}`);
  if (message.mcp_servers.length)
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
  let events: AsyncIterator<SDKMessage> | undefined;
  let closeStarted = false;
  let progressLost = false;
  const observeUsage = (type: WorkerUsageObservation["type"]): void => {
    if (progressLost) return;
    const workerUsage: WorkerUsageObservation = {
      type,
      invocationId: input.request.attemptId ?? "",
      providerAttempt: 1,
      role: "worker",
      phase: "implementation",
      provider: "claude",
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      usage: {},
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
    const stream = query({
      prompt: workItemPrompt(input.request),
      options: claudeQueryOptions(input, process.env, controller),
    });
    let result: SDKResultMessage | undefined;
    let initialization: SDKSystemMessage | undefined;
    events = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await turn.race(events.next());
      if (next.done) break;
      const message = next.value;
      turn.progress();
      if (message.type === "result") result = message;
      if (!progressLost)
        try {
          privateProgress(
            progressPath,
            progressEvent(
              message,
              input.request.attemptId ?? "",
              redactionValues,
            ),
          );
        } catch (error) {
          progressLost = true;
          process.stderr.write(
            `Factory Claude worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      if (message.type === "system" && message.subtype === "init") {
        assertInitialization(message, input);
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
    turn.finish();
    const assets = readProducedAssets(input.request);
    writeHarnessResult(resultPath, {
      state: "complete",
      assets,
      evidence: {
        harness: "claude-agent-sdk",
        adapter: input.config.adapter,
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
        usage: result.usage,
        modelUsage: result.modelUsage,
        totalCostUsd: result.total_cost_usd,
      },
    });
    observeUsage("completed");
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
    process.exitCode = 1;
  } finally {
    if (events && !closeStarted)
      void closeProviderEventStream(events, turn, false);
    turn.finish();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
