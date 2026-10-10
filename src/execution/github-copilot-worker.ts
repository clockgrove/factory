import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionEvent } from "@github/copilot-sdk";
import { GITHUB_COPILOT_SDK_ADAPTER_IDENTITY } from "../config.js";
import type { WorkerUsageObservation } from "../contracts.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  ProviderTurnIncompleteError,
} from "../provider-turn.js";
import {
  type GitHubCopilotWorkerInput,
  githubCopilotAuthenticationSelection,
  githubCopilotAuthenticationValues,
} from "./github-copilot.js";
import { bounded, cleanupCopilotClient } from "./github-copilot-lifecycle.js";
import {
  githubCopilotClientOptions,
  githubCopilotSessionOptions,
} from "./github-copilot-options.js";
import {
  type CopilotSessionData,
  copilotDigest,
  requireCopilotHome,
  requireCopilotWorkspace,
} from "./github-copilot-session.js";
import { CopilotUsage } from "./github-copilot-usage.js";
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
  event: SessionEvent,
  attemptId: string,
  secrets: string[],
): Record<string, unknown> {
  const observation: Record<string, unknown> = {
    eventId: randomUUID(),
    at: event.timestamp,
    attemptId,
    operation: event.type,
  };
  if (event.agentId) observation.agentId = event.agentId;
  if (event.type === "tool.execution_start") {
    observation.tool = event.data.toolName;
    observation.model = event.data.model;
  }
  if (event.type === "session.idle" && event.data.aborted !== undefined)
    observation.aborted = event.data.aborted;
  if (event.type === "session.error")
    observation.detail = redact(event.data.message, secrets);
  if (event.type === "session.shutdown") {
    observation.model = event.data.currentModel;
    observation.tokens = event.data.conversationTokens;
    observation.shutdownType = event.data.shutdownType;
  }
  return observation;
}

async function release(
  input: GitHubCopilotWorkerInput,
  resultPath: string,
): Promise<void> {
  if (!input.session)
    throw new Error("Copilot deletion requires an owned session");
  const home = requireCopilotHome(input.session);
  const releaseInput = {
    ...input,
    request: { ...input.request, worktree: home },
    config: { ...input.config, availableTools: [], permissionKinds: [] },
  };
  const { CopilotClient } = await import("@github/copilot-sdk");
  const client = new CopilotClient(
    githubCopilotClientOptions(
      releaseInput,
      process.env,
      process.env.COPILOT_HOME ?? join(process.env.HOME ?? "", ".copilot"),
    ),
  );
  let session: import("@github/copilot-sdk").CopilotSession | undefined;
  let failure: unknown;
  try {
    await bounded(client.start(), 2_000, "Copilot release startup timed out");
    session = await bounded(
      client.resumeSession(input.session.nativeSessionId, {
        ...githubCopilotSessionOptions(releaseInput),
        infiniteSessions: { enabled: false },
        continuePendingWork: false,
      }),
      2_000,
      "Copilot release attachment timed out",
    );
    if (session.sessionId !== input.session.nativeSessionId)
      throw new Error("Copilot deletion session identity changed");
    const metadata = await bounded(
      session.rpc.metadata.snapshot(),
      2_000,
      "Copilot release ownership check timed out",
    );
    if (
      metadata.alreadyInUse !== false ||
      metadata.isRemote !== false ||
      metadata.sessionId !== input.session.nativeSessionId
    )
      throw new Error(
        "Copilot deletion did not establish exclusive local ownership",
      );
    const [processing, activity] = await bounded(
      Promise.all([
        session.rpc.metadata.isProcessing(),
        session.rpc.metadata.activity(),
      ]),
      2_000,
      "Copilot release activity check timed out",
    );
    if (
      processing.processing !== false ||
      activity.hasActiveWork !== false ||
      activity.abortable !== false
    )
      throw new Error(
        "Copilot deletion still has active or unknown native work",
      );
  } catch (error) {
    failure = error;
  }
  try {
    // Deletion is deferred until release; failed attachment cannot authorize deletion.
    await cleanupCopilotClient(client, session, 2_000, Boolean(failure));
  } catch (error) {
    failure = error;
  }
  if (failure) throw failure;
  writeHarnessResult(resultPath, { state: "complete" });
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("GitHub Copilot worker requires input and result paths");
  const input = JSON.parse(
    readFileSync(inputPath, "utf8"),
  ) as GitHubCopilotWorkerInput;
  if (input.action === "release") {
    await release(input, resultPath);
    return;
  }
  const redactionValues = githubCopilotAuthenticationValues(process.env);
  const progressPath = resultPath.replace(
    /\.result\.json$/,
    ".progress.ndjson",
  );
  const capture = new WorkerInteractionCapture(
    input.request,
    progressPath,
    redactionValues,
    {
      provider: "github-copilot",
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
    },
  );
  let progressLost = false;
  const usage = new CopilotUsage(redactionValues);
  const turn = new ProviderTurnGuard(
    input.providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  );
  let terminal = false;
  let nativeAborted = false;
  let dispatched = false;
  let cancelled = false;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  void cancellation.catch(() => undefined);
  const cancel = () => {
    cancelled = true;
    rejectCancellation(new Error("Copilot worker was cancelled"));
  };
  process.once("SIGTERM", cancel);
  const race = <T>(operation: Promise<T>): Promise<T> =>
    turn.race(Promise.race([operation, cancellation]));
  let providerCompleted = false;
  let captureFailure: unknown;
  let providerFailure: string | undefined;
  let authenticationDigest: string | undefined;
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
      provider: "github-copilot",
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
        `Factory GitHub Copilot progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  let client: import("@github/copilot-sdk").CopilotClient | undefined;
  let session: import("@github/copilot-sdk").CopilotSession | undefined;
  let outcome: Record<string, unknown> | undefined;
  let sessionStart:
    | Extract<
        SessionEvent,
        { type: "session.start" | "session.resume" }
      >["data"]
    | undefined;
  type StartupEvent = Extract<
    SessionEvent,
    { type: "session.start" | "session.resume" | "session.error" }
  >;
  let observeStartup: (event: StartupEvent) => void = () => undefined;
  const startup = new Promise<StartupEvent>((resolveStartup) => {
    observeStartup = resolveStartup;
  });
  try {
    observeUsage("started");
    const { CopilotClient } = await race(import("@github/copilot-sdk"));
    const baseDirectory =
      process.env.COPILOT_HOME ?? join(process.env.HOME ?? "", ".copilot");
    client = new CopilotClient(
      githubCopilotClientOptions(input, process.env, baseDirectory),
    );
    await race(client.start());
    const authentication = await race(client.getAuthStatus());
    if (!authentication.isAuthenticated)
      throw new Error(
        authentication.statusMessage ?? "Not authenticated with GitHub Copilot",
      );
    if (input.session) {
      if (
        (!authentication.host || !authentication.login) &&
        !githubCopilotAuthenticationValues(process.env).length
      )
        throw new Error(
          "Copilot did not establish a reusable authentication identity",
        );
      authenticationDigest = copilotDigest([
        authentication.authType ?? null,
        authentication.host ?? null,
        authentication.login ?? null,
        githubCopilotAuthenticationSelection(process.env),
      ]);
      const prior = (input.session.ref.data as CopilotSessionData)
        .authenticationDigest;
      if (input.session.resume && prior !== authenticationDigest)
        throw new Error("Copilot continuation authentication identity changed");
    }
    const sessionOptions = githubCopilotSessionOptions(input);
    const onEvent = (event: SessionEvent) => {
      turn.progress(event.type);
      if (dispatched && event.type === "session.idle") {
        terminal = true;
        if (event.data.aborted === true) nativeAborted = true;
      }
      if (event.type === "session.error") providerFailure = event.data.message;
      if (event.type === "session.start" || event.type === "session.resume")
        sessionStart = event.data;
      if (
        event.type === "session.start" ||
        event.type === "session.resume" ||
        event.type === "session.error"
      )
        observeStartup(event);
      if (!dispatched) return;
      const nativeId = session?.sessionId ?? input.session?.nativeSessionId;
      const observedUsage = usage.observe(event, nativeId);
      capture.copilot(event, nativeId, observedUsage);
      if (!progressLost)
        try {
          if (event.type === "assistant.usage" && !observedUsage) return;
          privateProgress(progressPath, {
            ...progressEvent(
              event,
              input.request.attemptId ?? "",
              redactionValues,
            ),
            ...observedUsage,
          });
        } catch (error) {
          progressLost = true;
          process.stderr.write(
            `Factory GitHub Copilot progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
    };
    session = await race(
      input.session?.resume
        ? client.resumeSession(input.session.nativeSessionId, {
            ...sessionOptions,
            onEvent,
            continuePendingWork: false,
            suppressResumeEvent: false,
          })
        : client.createSession({
            ...sessionOptions,
            onEvent,
            ...(input.session && { sessionId: input.session.nativeSessionId }),
          }),
    );
    // createSession may return before its asynchronous startup event. Never
    // dispatch the accepted Work Item until observed identity is checked.
    const initialized = await race(startup);
    if (initialized.type === "session.error")
      throw new Error(initialized.data.message);
    if (providerFailure) throw new Error(providerFailure);
    if (
      !sessionStart ||
      sessionStart.alreadyInUse ||
      ("sessionWasActive" in sessionStart && sessionStart.sessionWasActive)
    )
      throw new Error(
        "Copilot startup did not establish exclusive idle ownership",
      );
    const [metadata, model, processing, activity] = await race(
      Promise.all([
        session.rpc.metadata.snapshot(),
        session.rpc.model.getCurrent(),
        session.rpc.metadata.isProcessing(),
        session.rpc.metadata.activity(),
      ]),
    );
    if (
      metadata.sessionId !== session.sessionId ||
      metadata.isRemote !== false ||
      metadata.alreadyInUse !== false ||
      metadata.workingDirectory !== input.request.worktree ||
      metadata.selectedModel !== input.config.model ||
      model.modelId !== input.config.model ||
      model.reasoningEffort !== input.config.reasoningEffort ||
      processing.processing !== false ||
      activity.hasActiveWork !== false ||
      activity.abortable !== false
    )
      throw new Error(
        "Copilot effective model, reasoning, worktree or idle binding does not match",
      );
    await race(session.rpc.tools.initializeAndValidate());
    const offered = await race(session.rpc.tools.getCurrentMetadata());
    if (
      !offered.tools ||
      !isDeepStrictEqual(
        offered.tools.map((tool) => tool.name).sort(),
        [...input.config.availableTools].sort(),
      )
    )
      throw new Error(
        "Copilot effective tool policy does not match the current Work Item",
      );
    if (input.session) {
      if (session.sessionId !== input.session.nativeSessionId)
        throw new Error("Copilot native session identity changed");
      requireCopilotWorkspace(
        session.workspacePath,
        requireCopilotHome(input.session),
      );
    }
    usage.excludeHistory(await race(session.getEvents()), session.sessionId);
    // Startup idleness cannot qualify the implementation turn.
    terminal = false;
    const rendered = renderWorkItemPrompt(input.request);
    const prompt = rendered.prompt;
    capture.request(
      prompt,
      {
        systemMessage: sessionOptions.systemMessage,
        availableTools: sessionOptions.availableTools,
      },
      rendered.sections,
    );
    dispatched = true;
    const response = await race(
      session.sendAndWait({ prompt }, input.config.timeoutSeconds * 1_000),
    );
    capture.response(response?.data.content, session.sessionId);
    if (providerFailure) throw new Error(providerFailure);
    if (cancelled) throw new Error("Copilot worker was cancelled");
    if (!terminal)
      throw new Error("GitHub Copilot SDK ended without session.idle");
    if (nativeAborted) {
      const interrupted = new ProviderTurnIncompleteError();
      interrupted.message = "Copilot native turn reported aborted session.idle";
      throw interrupted;
    }
    const settled = await race(session.rpc.metadata.activity());
    const processingAtEnd = await race(session.rpc.metadata.isProcessing());
    if (
      settled.hasActiveWork !== false ||
      settled.abortable !== false ||
      processingAtEnd.processing !== false
    )
      throw new Error("Copilot completed event still has active native work");
    turn.finish();
    providerCompleted = true;
    capture.providerCompleted();
    const assets = readProducedAssets(input.request);
    outcome = {
      state: "complete",
      assets,
      evidence: {
        harness: "github-copilot-sdk",
        adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
        sessionId: session.sessionId,
        configuredModel: input.config.model,
        observedModel: metadata.selectedModel,
        reasoningEffort: input.config.reasoningEffort,
        availableTools: input.config.availableTools,
        authenticationType: authentication.authType,
        finalResponse: response?.data.content ?? "",
      },
    };
  } catch (error) {
    captureFailure = error;
    outcome = harnessFailure("github-copilot", error, redactionValues);
    process.exitCode = 1;
  } finally {
    turn.finish();
    try {
      if (client)
        await cleanupCopilotClient(
          client,
          session,
          2_000,
          Boolean(input.session),
          !providerCompleted,
        );
      if (providerCompleted && input.session && !cancelled && outcome)
        outcome.session = {
          ...input.session.ref,
          status: "ready",
          data: {
            ...(input.session.ref.data as CopilotSessionData),
            authenticationDigest,
            nativeSettled: true,
          },
        };
    } catch (error) {
      captureFailure = error;
      outcome = harnessFailure("github-copilot", error, redactionValues);
      process.exitCode = 1;
    }
  }
  process.removeListener("SIGTERM", cancel);
  if (!outcome) throw new Error("GitHub Copilot worker produced no outcome");
  observeUsage(outcome.state === "complete" ? "completed" : "failed");
  capture.outcome(
    outcome.state === "complete" ? "completed" : "failed",
    usage.totals(),
    captureFailure,
    providerCompleted ? "protocol" : "provider",
  );
  writeHarnessResult(resultPath, outcome);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${redact(error instanceof Error ? (error.stack ?? error.message) : String(error), githubCopilotAuthenticationValues(process.env))}\n`,
  );
  process.exitCode = 1;
});
