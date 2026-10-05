import { WorkerInteractionCapture } from "./interaction-capture.js";
import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { HarnessRequest, WorkerUsageObservation } from "../contracts.js";
import { codexTokenUsage, codexRawTokenUsage } from "../usage.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  harnessFailure,
  ProviderStreamError,
  privateProgress,
  readProducedAssets,
  redact,
  workItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import type { CodexModelSelection } from "../config.js";
import { createCodexHome } from "../codex-planning-isolation.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  closeProviderEventStream,
  requireCompletedProviderTurn,
} from "../provider-turn.js";

interface WorkerInput {
  request: HarnessRequest;
  network: "host" | "off";
  allowedSecretNames?: string[];
  model: CodexModelSelection;
  providerTurnIdleTimeoutMs: number;
}

function progressEvent(
  event: ThreadEvent,
  attemptId: string,
  secrets: string[],
  commandOffsets: Map<string, number>,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    eventId: randomUUID(),
    at: new Date().toISOString(),
    attemptId,
    operation: event.type,
  };
  if (event.type === "turn.completed")
    base.usage = codexRawTokenUsage(event.usage);
  if (event.type === "turn.failed")
    base.detail = redact(event.error.message, secrets);
  if (event.type === "error") base.detail = redact(event.message, secrets);
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    base.itemId = event.item.id;
    base.itemType = event.item.type;
    if (event.item.type === "command_execution") {
      base.exitCode = event.item.exit_code;
      base.status = event.item.status;
      const output = event.item.aggregated_output;
      const previous = commandOffsets.get(event.item.id) ?? 0;
      const complete =
        event.type === "item.completed"
          ? output.length
          : output.lastIndexOf("\n") + 1;
      if (complete > previous)
        base.detail = redact(output.slice(previous, complete), secrets);
      commandOffsets.set(event.item.id, Math.max(previous, complete));
    } else if (event.item.type === "mcp_tool_call") {
      base.tool = `${event.item.server}/${event.item.tool}`;
      base.status = event.item.status;
    } else if (event.item.type === "file_change")
      base.status = event.item.status;
  }
  return base;
}

export async function runCodexWorker(
  inputPath: string,
  resultPath: string,
): Promise<boolean> {
  const {
    request,
    network,
    allowedSecretNames = [],
    model,
    providerTurnIdleTimeoutMs,
  } = JSON.parse(readFileSync(inputPath, "utf8")) as WorkerInput;
  const redactionValues = allowedSecretNames
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
  const progressPath = resultPath.replace(
    /\.result\.json$/,
    ".progress.ndjson",
  );
  const capture = new WorkerInteractionCapture(
    request,
    progressPath,
    redactionValues,
    {
      provider: "codex",
      model: model.model,
      reasoningEffort: model.reasoningEffort,
    },
  );
  // A private HOME with only the Codex login; shell commands see the
  // worktree, the private HOME and TMPDIR, and the platform runtime alone.
  const sandbox = { workspace: "write", network: network === "host" } as const;
  const home = createCodexHome({
    config: "",
    sandbox,
    keep: allowedSecretNames,
  });
  const codex = new Codex({ env: home.env });
  const thread = codex.startThread({
    workingDirectory: request.worktree,
    approvalPolicy: "never",
    model: model.model,
    modelReasoningEffort: model.reasoningEffort,
  });
  const prompt = workItemPrompt(request);
  let providerCompleted = false;
  let turn: ProviderTurnGuard | undefined;
  let usage: unknown = null;
  let progressLost = false;
  const observe = (event: unknown): void => {
    if (progressLost) return;
    try {
      privateProgress(progressPath, event);
    } catch (error) {
      progressLost = true;
      process.stderr.write(
        `Factory worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  const observeUsage = (type: WorkerUsageObservation["type"]): void => {
    const workerUsage: WorkerUsageObservation = {
      type,
      invocationId: request.attemptId ?? "",
      providerAttempt: 1,
      ...(request.item.executionBinding
        ? {
            profileId: request.item.executionBinding.id,
            adapter: request.item.executionBinding.adapter,
          }
        : {}),
      role: "worker",
      phase: "implementation",
      provider: "codex",
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      usage: codexTokenUsage(usage),
    };
    observe({
      eventId: randomUUID(),
      at: new Date().toISOString(),
      attemptId: request.attemptId ?? "",
      operation: "worker-usage",
      workerUsage,
    });
  };
  try {
    turn = new ProviderTurnGuard(
      providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
    );
    observeUsage("started");
    capture.request(prompt, {
      permissions: sandbox,
      approvalPolicy: "never",
    });
    const streamed = await turn.race(
      thread.runStreamed(prompt, { signal: turn.signal }),
    );
    let finalResponse = "";
    let turnCompleted = false;
    const commandOffsets = new Map<string, number>();
    const events = streamed.events[Symbol.asyncIterator]();
    let closeStarted = false;
    try {
      for (;;) {
        const next = await turn.race(events.next());
        if (next.done) break;
        const event = next.value;
        turn.progress();
        capture.codex(event, thread.id ?? undefined);
        const observation = progressEvent(
          event,
          request.attemptId ?? "",
          redactionValues,
          commandOffsets,
        );
        observe({
          ...observation,
          threadId: thread.id ? redact(thread.id, redactionValues) : undefined,
        });
        if (
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          event.item.type === "agent_message"
        )
          finalResponse = event.item.text;
        if (event.type === "turn.completed") {
          turnCompleted = true;
          usage = codexRawTokenUsage(event.usage);
          observeUsage("progress");
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error")
          throw new ProviderStreamError(event.message);
        if (turnCompleted) break;
      }
      closeStarted = true;
      await closeProviderEventStream(events, turn, true);
    } catch (error) {
      if (!closeStarted && !turn.signal.aborted) {
        closeStarted = true;
        try {
          await closeProviderEventStream(events, turn, true);
        } catch {
          // Preserve the provider failure that required cleanup.
        }
      }
      throw error;
    } finally {
      if (!closeStarted) void closeProviderEventStream(events, turn, false);
    }
    requireCompletedProviderTurn(turnCompleted);
    turn.finish();
    providerCompleted = true;
    capture.providerCompleted();
    const parsedAssets = readProducedAssets(request);
    writeHarnessResult(resultPath, {
      state: "complete",
      assets: parsedAssets,
      evidence: {
        finalResponse,
        threadId: thread.id,
        usage,
      },
    });
    observeUsage("completed");
    capture.outcome("completed", codexTokenUsage(usage), undefined, "protocol");
    return true;
  } catch (caught) {
    const error = caught;
    writeHarnessResult(
      resultPath,
      harnessFailure("codex", error, redactionValues),
    );
    observeUsage("failed");
    capture.outcome(
      "failed",
      codexTokenUsage(usage),
      error,
      providerCompleted ? "protocol" : "provider",
    );
    return false;
  } finally {
    turn?.finish();
    home.dispose();
  }
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("Worker requires input and result paths");
  if (!(await runCodexWorker(inputPath, resultPath))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
