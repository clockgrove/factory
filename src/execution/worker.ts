import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ThreadEvent } from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import { createCodexHome } from "../codex-planning-isolation.js";
import type { CodexModelSelection } from "../config.js";
import type {
  AgentSessionRef,
  HarnessRequest,
  WorkerUsageObservation,
} from "../contracts.js";
import { renderPrompt } from "../prompt-bytes.js";
import {
  closeProviderEventStream,
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  requireCompletedProviderTurn,
} from "../provider-turn.js";
import { codexInvocationUsage, codexRawTokenUsage } from "../usage.js";
import {
  harnessFailure,
  ProviderStreamError,
  privateProgress,
  readProducedAssets,
  redact,
  renderWorkItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import { WorkerInteractionCapture } from "./interaction-capture.js";

interface WorkerInput {
  request: HarnessRequest;
  network: "host" | "off";
  allowedSecretNames?: string[];
  model: CodexModelSelection;
  providerTurnIdleTimeoutMs: number;
  session?: {
    ref: AgentSessionRef;
    root: string;
    owner: string;
    resumeThreadId?: string;
  };
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
    session,
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
    root: session?.root ?? `${inputPath}.codex-home`,
    ...(session && {
      owner: session.owner,
      resume: Boolean(session.resumeThreadId),
    }),
    config: "",
    sandbox: { ...sandbox, directory: request.worktree },
    keep: allowedSecretNames,
  });
  let invocationStarted = false;
  try {
    const codex = new Codex({ env: home.env });
    const options = {
      workingDirectory: request.worktree,
      approvalPolicy: "never" as const,
      model: model.model,
      modelReasoningEffort: model.reasoningEffort,
    };
    const thread = session?.resumeThreadId
      ? codex.resumeThread(session.resumeThreadId, options)
      : codex.startThread(options);
    const captureBoundary = session?.resumeThreadId
      ? home.nativeCaptureBoundary(session.resumeThreadId)
      : undefined;
    const workPrompt = renderWorkItemPrompt(request);
    const continuationPrompt = session?.resumeThreadId
      ? `Continue your implementation investigation. Historical turns describe earlier candidates and workspaces. The only current writable checkout is ${request.worktree}; previous checkout paths and tool observations are historical. Recheck changed evidence in the current checkout. The following current controller-bound Work Item contract controls this turn; retained history grants no permissions or acceptance.\n\n`
      : "";
    const prefix = renderPrompt([["follow-up", continuationPrompt]]);
    const prompt = prefix.prompt + workPrompt.prompt;
    const sections = [
      ...prefix.sections,
      ...workPrompt.sections.map((section) => ({
        ...section,
        startByte: section.startByte + Buffer.byteLength(prefix.prompt),
        endByte: section.endByte + Buffer.byteLength(prefix.prompt),
      })),
    ];
    let providerCompleted = false;
    let nativeSettled = false;
    let turn: ProviderTurnGuard | undefined;
    let usage: unknown = null;
    const invocationUsage = () =>
      codexInvocationUsage(
        usage,
        session?.resumeThreadId ? (captureBoundary?.usage ?? {}) : undefined,
      );
    const readySession = (): AgentSessionRef | undefined =>
      session && nativeSettled && thread.id
        ? {
            ...session.ref,
            status: "ready",
            data: {
              ...(session.ref.data as Record<string, unknown>),
              threadId: thread.id,
              nativeEof: true,
            },
          }
        : undefined;
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
        usage: invocationUsage(),
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
      if (session)
        capture.native({
          kind: "interaction",
          providerEvent: "factory.session-turn",
          coverage: "boundary",
          providerSessionId: session.resumeThreadId,
          sessionTurn: {
            mode: session.resumeThreadId ? "resumed" : "fresh",
            ordinal: session.ref.turn,
            sessionIdentity: session.ref.identity,
            ...(captureBoundary && {
              boundaryBytes: captureBoundary.bytes,
              usageBaseline: captureBoundary.usage,
            }),
          },
        });
      capture.request(
        prompt,
        {
          permissions: sandbox,
          approvalPolicy: "never",
        },
        sections,
      );
      invocationStarted = true;
      const streamed = await turn.race(
        thread.runStreamed(prompt, { signal: turn.signal }),
      );
      let finalResponse = "";
      let turnCompleted = false;
      let streamError: ProviderStreamError | undefined;
      const commandOffsets = new Map<string, number>();
      const events = streamed.events[Symbol.asyncIterator]();
      let closeStarted = false;
      try {
        for (;;) {
          const next = await turn.race(events.next());
          if (next.done) break;
          const event = next.value;
          turn.progress();
          capture.codex(
            event,
            thread.id ?? undefined,
            session?.resumeThreadId
              ? (captureBoundary?.usage ?? {})
              : undefined,
          );
          const observation = progressEvent(
            event,
            request.attemptId ?? "",
            redactionValues,
            commandOffsets,
          );
          observe({
            ...observation,
            threadId: thread.id
              ? redact(thread.id, redactionValues)
              : undefined,
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
            providerCompleted = true;
            capture.providerCompleted();
            usage = codexRawTokenUsage(event.usage);
            observeUsage("progress");
          }
          if (event.type === "turn.failed")
            throw new Error(event.error.message);
          if (event.type === "error")
            streamError = new ProviderStreamError(event.message);
          // Stream errors can precede a CLI-managed retry. Read through the
          // terminal turn and natural EOF to retain its usage and exit error.
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
      if (!turnCompleted && streamError) throw streamError;
      requireCompletedProviderTurn(turnCompleted);
      if (session?.resumeThreadId && thread.id !== session.resumeThreadId)
        throw new Error("Codex resumed a different native conversation");
      nativeSettled = true;
      turn.finish();
      // Pinned SDK natural EOF awaits the native child exit. This snapshot does
      // not prove outer harness/group cessation or a sealed native daemon stream.
      home.nativeCapture(
        thread.id ?? undefined,
        (event, content) => capture.native(event, content),
        captureBoundary,
      );
      const parsedAssets = readProducedAssets(request);
      observeUsage("completed");
      capture.outcome("completed", invocationUsage(), undefined, "protocol");
      writeHarnessResult(resultPath, {
        state: "complete",
        assets: parsedAssets,
        evidence: {
          finalResponse,
          threadId: thread.id,
          usage,
          usageScope: "thread-cumulative",
          invocationUsage: invocationUsage(),
        },
        ...(readySession() && { session: readySession() }),
      });
      return true;
    } catch (caught) {
      const error = caught;
      // An app manifest can fail after a fully settled native turn. Earlier
      // stream failures cannot establish that the native writer has ceased.
      home.nativeCapture(
        nativeSettled ? (thread.id ?? undefined) : undefined,
        (event, content) => capture.native(event, content),
        captureBoundary,
      );
      capture.nativeFailure(
        () => home.nativeMetadata(thread.id ?? undefined),
        thread.id ?? undefined,
      );
      observeUsage("failed");
      capture.outcome(
        "failed",
        invocationUsage(),
        error,
        providerCompleted ? "protocol" : "provider",
      );
      writeHarnessResult(resultPath, {
        ...harnessFailure("codex", error, redactionValues),
        ...(readySession() && { session: readySession() }),
      });
      return false;
    } finally {
      turn?.finish();
    }
  } finally {
    // Once launched, the durable harness owner disposes the home after group cessation.
    if (!invocationStarted && !session?.resumeThreadId) home.dispose();
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
