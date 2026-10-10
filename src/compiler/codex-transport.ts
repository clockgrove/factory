import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readCodexAppServerTurn,
  runCodexAppServer,
} from "../codex-app-server.js";
import { runCodexExec } from "../codex-exec.js";
import {
  assertOwnedCodexHome,
  CODEX_PLANNING_CONFIG,
  CODEX_TREE_REVIEW_CONFIG,
  createCodexHome,
  releaseCodexHome,
} from "../codex-planning-isolation.js";
import type { CodexModelSelection } from "../config.js";
import type {
  AgentSessionCapabilities,
  AgentSessionContinuation,
  AgentSessionReconciliation,
  AgentSessionRef,
  ModelInvocationContext,
  ModelInvocationUsage,
} from "../contracts.js";
import { codexCaptureEvent } from "../execution/interaction-capture.js";
import { currentProcessSignal, UnsettledSubprocessError } from "../process.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  requireCompletedProviderTurn,
} from "../provider-turn.js";
import { stepCancellationSignal } from "../step.js";
import { codexInvocationUsage, codexRawTokenUsage } from "../usage.js";
import { observeModelInvocation } from "./observation.js";
import {
  CODEX_PLANNING_ADAPTER,
  CODEX_PLANNING_PROVIDER,
  type PlanningRole,
  type PlanningTransport,
  type PlanningTurn,
  structuredRequestDigest,
} from "./transport.js";

const LOWER_EFFORT_REVIEW_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Codex native transport with isolated review continuations. Compilation and
 * graph review remain fresh, tool-free turns; result reviews keep their own
 * conversation while reading only each invocation's exact candidate tree.
 */
export class CodexPlanningTransport implements PlanningTransport {
  readonly provider = CODEX_PLANNING_PROVIDER;
  get adapter(): string {
    return this.transport === "exec"
      ? CODEX_PLANNING_ADAPTER
      : "@openai/codex@0.160.0/tool-free-app-server-tree-exec-v1";
  }

  constructor(
    private checkout: string,
    private planner: CodexModelSelection,
    private reviewer: CodexModelSelection,
    private providerTurnIdleTimeoutMs: number | undefined,
    private redactionValues: string[],
    private sessionRoot?: string,
    private transport: "exec" | "app-server" = "exec",
  ) {}

  get sessionCapabilities(): AgentSessionCapabilities | undefined {
    return this.sessionRoot
      ? { resumeRoles: ["planning", "result-review", "objective-review"] }
      : undefined;
  }

  private sessionOwner(session: AgentSessionRef): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          session.scope,
          session.identity,
          session.adapter,
          (session.data as { selectionDigest?: string } | undefined)
            ?.selectionDigest,
        ]),
      )
      .digest("hex");
  }

  private sessionData(session: AgentSessionRef): {
    sessionRoot: string;
    threadId?: string;
    selectionDigest: string;
    transport: "exec" | "app-server";
    turnId?: string;
    response?: string;
    responseDigest?: string;
    usage?: ModelInvocationUsage;
  } {
    const data = session.data as
      | {
          sessionRoot?: unknown;
          threadId?: unknown;
          selectionDigest?: unknown;
          transport?: "exec" | "app-server";
          turnId?: string;
          response?: string;
          responseDigest?: string;
          usage?: ModelInvocationUsage;
        }
      | undefined;
    if (
      !this.sessionRoot ||
      session.adapter !== this.adapter ||
      !/^[a-f0-9-]{36}$/.test(session.identity) ||
      data?.sessionRoot !== join(resolve(this.sessionRoot), session.identity) ||
      data.transport !==
        (session.scope.role === "planning" ? this.transport : "exec") ||
      typeof data.selectionDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.selectionDigest) ||
      (data.response !== undefined && typeof data.response !== "string") ||
      (data.turnId !== undefined && typeof data.turnId !== "string") ||
      (data.threadId !== undefined &&
        (typeof data.threadId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(data.threadId)))
    )
      throw new Error(
        "Reviewer continuation differs from its private adapter binding",
      );
    return data as {
      sessionRoot: string;
      threadId?: string;
      selectionDigest: string;
      transport: "exec" | "app-server";
      turnId?: string;
      response?: string;
      responseDigest?: string;
      usage?: ModelInvocationUsage;
    };
  }

  private selectionDigest(role: PlanningRole, tree: boolean): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.selection(role),
          this.adapter,
          role,
          "read-only",
          "never",
          tree ? CODEX_TREE_REVIEW_CONFIG : CODEX_PLANNING_CONFIG,
        ]),
      )
      .digest("hex");
  }

  async reconcileSession(
    session: AgentSessionRef,
  ): Promise<AgentSessionReconciliation> {
    const data = this.sessionData(session);
    const planning = session.scope.role === "planning";
    if (
      data.selectionDigest !==
      this.selectionDigest(planning ? "planner" : "reviewer", !planning)
    )
      throw new Error(
        "Codex reconciliation differs from its retained model and policy",
      );
    if (session.status === "in-flight" && data.transport === "app-server") {
      if (!data.threadId || !data.turnId || !session.currentTurn)
        return { disposition: "unknown" };
      assertOwnedCodexHome(data.sessionRoot, this.sessionOwner(session));
      const home = createCodexHome({
        root: data.sessionRoot,
        owner: this.sessionOwner(session),
        resume: true,
        config: CODEX_PLANNING_CONFIG,
      });
      const selection = this.selection("planner");
      const guard = new ProviderTurnGuard(
        this.providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
      );
      try {
        const caller = stepCancellationSignal();
        const snapshot = await readCodexAppServerTurn({
          env: home.env,
          options: {
            workingDirectory: this.checkout,
            sandboxMode: "read-only",
            approvalPolicy: "never",
            model: selection.model,
            modelReasoningEffort: selection.reasoningEffort,
          },
          threadId: data.threadId,
          turnId: data.turnId,
          signal: caller
            ? AbortSignal.any([guard.signal, caller])
            : guard.signal,
        });
        if (snapshot.status === "inProgress") return { disposition: "active" };
        if (snapshot.status === "unknown") return { disposition: "unknown" };
        const recovered = structuredClone(session);
        recovered.currentTurn!.terminal = snapshot.status;
        recovered.currentTurn!.resources = "settled";
        recovered.status =
          snapshot.status === "completed" || snapshot.status === "failed"
            ? "ready"
            : "unavailable";
        if (snapshot.response !== undefined) {
          const recoveredData = recovered.data as typeof data;
          recoveredData.response = snapshot.response;
          recoveredData.responseDigest = createHash("sha256")
            .update(snapshot.response)
            .digest("hex");
        }
        return {
          disposition: "settled",
          session: recovered,
          ...(snapshot.response === undefined
            ? {}
            : { response: snapshot.response }),
        };
      } finally {
        guard.finish();
      }
    }
    // A retained terminal checkpoint is an operational receipt. Rollout files,
    // diagnostics and absence of a process alone cannot supply one after a crash.
    if (
      session.status === "in-flight" ||
      session.currentTurn?.resources !== "settled"
    )
      return { disposition: "unknown" };
    if (
      data.response !== undefined &&
      data.responseDigest !==
        createHash("sha256").update(data.response).digest("hex")
    )
      throw new Error(
        "Retained Codex response changed from its terminal checkpoint",
      );
    return {
      disposition: "settled",
      session: structuredClone(session),
      ...(session.currentTurn?.terminal === "completed" &&
      data.response !== undefined
        ? { response: data.response }
        : {}),
      ...(data.usage ? { usage: structuredClone(data.usage) } : {}),
    };
  }

  async releaseSession(session: AgentSessionRef): Promise<void> {
    if (
      session.status === "in-flight" ||
      (session.currentTurn && session.currentTurn.resources !== "settled")
    )
      throw new Error(
        "Cannot release reviewer session with unproved process settlement",
      );
    const data = this.sessionData(session);
    // A settled session may have been disposed before its atomic state
    // checkpoint. Its exact adapter-owned path remains the disposal identity.
    if (!lstatSync(data.sessionRoot, { throwIfNoEntry: false })) return;
    releaseCodexHome(data.sessionRoot, this.sessionOwner(session));
  }

  selection(role: PlanningRole): CodexModelSelection {
    return role === "planner" ? this.planner : this.reviewer;
  }

  settings(role: PlanningRole, tree?: string): Record<string, unknown> {
    return {
      transport: tree ? "exec" : this.transport,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      ...(tree && { shell: "read-only tree" }),
      ...this.selection(role),
    };
  }

  async run(args: {
    role: PlanningRole;
    prompt: string;
    schema: unknown;
    sourcePacket?: string;
    candidateDigest?: string;
    invocation: ModelInvocationContext;
    turn: PlanningTurn;
    tree?: string;
    session?: AgentSessionContinuation;
    signal?: AbortSignal;
  }): Promise<void> {
    const { invocation, turn: state } = args;
    const selection = this.selection(args.role);
    const selectedTransport = args.tree ? "exec" : this.transport;
    const continuation =
      this.sessionRoot && args.session ? args.session : undefined;
    let session: AgentSessionRef | undefined;
    let sessionData:
      | ReturnType<CodexPlanningTransport["sessionData"]>
      | undefined;
    if (continuation) {
      if (
        args.role === "planner"
          ? Boolean(args.tree) || continuation.scope.role !== "planning"
          : !args.tree ||
            !["result-review", "objective-review"].includes(
              continuation.scope.role,
            )
      )
        throw new Error("Reviewer continuation has a different role");
      const selectionDigest = this.selectionDigest(
        args.role,
        Boolean(args.tree),
      );
      if (continuation.retained) {
        const retained = continuation.retained;
        sessionData = this.sessionData(retained);
        if (
          retained.status !== "ready" ||
          (retained.currentTurn?.dispatch === "submitted" &&
            !sessionData.threadId) ||
          retained.identity !== continuation.identity ||
          !isDeepStrictEqual(retained.scope, continuation.scope) ||
          sessionData.selectionDigest !== selectionDigest
        )
          throw new Error(
            "Reviewer session cannot continue without settled matching ownership",
          );
      } else {
        mkdirSync(this.sessionRoot!, { recursive: true, mode: 0o700 });
        sessionData = {
          sessionRoot: join(resolve(this.sessionRoot!), continuation.identity),
          selectionDigest,
          transport: selectedTransport,
        };
      }
      sessionData = { ...sessionData };
      delete sessionData.response;
      delete sessionData.responseDigest;
      delete sessionData.usage;
      delete sessionData.turnId;
      session = {
        scope: structuredClone(continuation.scope),
        adapter: this.adapter,
        identity: continuation.identity,
        data: sessionData,
        currentTurn: {
          invocationId: invocation.invocationId,
          requestDigest: structuredRequestDigest(args.prompt, args.schema),
          schemaDigest: createHash("sha256")
            .update(JSON.stringify(args.schema))
            .digest("hex"),
          ...(args.sourcePacket === undefined
            ? {}
            : {
                evidenceDigest: createHash("sha256")
                  .update(args.sourcePacket)
                  .digest("hex"),
              }),
          ...(args.candidateDigest
            ? { candidateDigest: args.candidateDigest }
            : {}),
          ...(continuation.scope.role === "planning"
            ? continuation.currentGraphDigest
              ? { graphDigest: continuation.currentGraphDigest }
              : {}
            : { graphDigest: continuation.scope.graphDigest }),
          dispatch: "intent",
          resources: "active",
        },
        turn: (continuation.retained?.turn ?? 0) + 1,
        status: "in-flight",
      };
    }
    const started = Date.now();
    // Native exec JSON omits text/reasoning deltas. A healthy structured
    // answer can stay silent until its final agent_message, at any effort.
    // Keep that quiet window for compilation and high effort. Lower-effort
    // reviews get a finite five-minute outlier bound, above the old 120s
    // cutoff; a quiet timeout still does not prove provider inactivity.
    const lowerEffortReview =
      ["graph-review", "result-review", "objective-review"].includes(
        invocation.phase,
      ) && ["minimal", "low", "medium"].includes(selection.reasoningEffort);
    const thread: { id?: string } = { id: sessionData?.threadId };
    let retainHome = false;
    let turnCompleted = false;
    let nativeAttempted = false;
    let initialCheckpointed = false;
    let streamError: Error | undefined;
    // A tree review's shell reads the tree alone, offline.
    const home = createCodexHome(
      args.tree
        ? {
            config: CODEX_TREE_REVIEW_CONFIG,
            ...(session && sessionData
              ? {
                  root: sessionData.sessionRoot,
                  resume: Boolean(continuation?.retained),
                  owner: this.sessionOwner(session),
                }
              : {}),
            sandbox: {
              directory: args.tree,
              workspace: "read",
              network: false,
            },
          }
        : {
            config: CODEX_PLANNING_CONFIG,
            ...(session && sessionData
              ? {
                  root: sessionData.sessionRoot,
                  resume: Boolean(continuation?.retained),
                  owner: this.sessionOwner(session),
                }
              : {}),
          },
    );
    const captureBoundary =
      continuation?.retained && thread.id
        ? home.nativeCaptureBoundary(thread.id)
        : undefined;
    const sessionTurn = session
      ? {
          mode: captureBoundary ? ("resumed" as const) : ("fresh" as const),
          ordinal: session.turn,
          sessionIdentity: session.identity,
          ...(captureBoundary
            ? {
                boundaryBytes: captureBoundary.bytes,
                usageBaseline: captureBoundary.usage,
              }
            : {}),
        }
      : undefined;
    const turn = new ProviderTurnGuard(
      this.providerTurnIdleTimeoutMs ??
        (lowerEffortReview
          ? LOWER_EFFORT_REVIEW_IDLE_TIMEOUT_MS
          : DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS),
      this.providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
    );
    const checkpointSession = (status: AgentSessionRef["status"]) => {
      if (!session || !sessionData || !continuation) return;
      if (thread.id === undefined) delete sessionData.threadId;
      else sessionData.threadId = thread.id;
      session = { ...session, data: { ...sessionData }, status };
      continuation.checkpoint(session);
    };
    try {
      checkpointSession("in-flight");
      initialCheckpointed = true;
      if (sessionTurn)
        observeModelInvocation(invocation, {
          type: "progress",
          capture: {
            event: {
              kind: "interaction",
              providerEvent: "factory.agent-session",
              providerSessionId: thread.id,
              sessionTurn,
              coverage: "boundary",
            },
          },
        });
      const signal = AbortSignal.any([
        turn.signal,
        ...(args.signal ? [args.signal] : []),
        ...(currentProcessSignal() ? [currentProcessSignal()!] : []),
      ]);
      signal.throwIfAborted();
      nativeAttempted = true;
      state.nativeInvocationStarted = true;
      if (session?.currentTurn && selectedTransport === "exec") {
        session.currentTurn.dispatch = "submitted";
        checkpointSession("in-flight");
      }
      const execute =
        selectedTransport === "app-server" ? runCodexAppServer : runCodexExec;
      await execute({
        ...(selectedTransport === "app-server"
          ? {
              checkpoint: (
                native: import("../codex-app-server.js").CodexAppServerCheckpoint,
              ) => {
                if (native.threadId) thread.id = native.threadId;
                if (sessionData && native.turnId)
                  sessionData.turnId = native.turnId;
                if (session?.currentTurn) {
                  if (native.dispatch === "submitted")
                    session.currentTurn.dispatch = "submitted";
                  if (native.terminal)
                    session.currentTurn.terminal = native.terminal;
                }
                if (
                  native.terminal === "completed" ||
                  native.terminal === "failed"
                )
                  state.ended = true;
                if (!args.signal?.aborted) checkpointSession("in-flight");
              },
              progress: (
                native: import("../codex-app-server.js").CodexAppServerProgress,
              ) => {
                if (native.activity) turn.progress(native.event);
                observeModelInvocation(invocation, {
                  type: "progress",
                  providerEvent: native.event,
                  providerThreadId: native.threadId,
                  providerItemId: native.itemId,
                  providerItemType: native.itemType,
                  capture: {
                    event: {
                      kind: "interaction",
                      providerEvent: native.event,
                      coverage: "boundary",
                      providerSessionId: native.threadId,
                      sessionTurn,
                    },
                    content: () => native,
                  },
                });
              },
            }
          : {}),
        env: home.env,
        ...(invocation.observe?.nativeBoundaryTelemetry && {
          boundary: (
            boundary: import("../capture.js").ModelBoundaryObservation,
          ) =>
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "interaction",
                  coverage: "boundary",
                  providerSessionId: thread.id,
                  boundary,
                },
              },
            }),
        }),
        options: {
          workingDirectory: args.tree ?? this.checkout,
          // The tree's read-only permission profile is Factory's config.
          ...(args.tree
            ? { skipGitRepoCheck: true }
            : { sandboxMode: "read-only" as const }),
          approvalPolicy: "never",
          model: selection.model,
          modelReasoningEffort: selection.reasoningEffort,
        },
        prompt: args.prompt,
        schema: args.schema,
        threadId: sessionData?.threadId,
        redactionValues: this.redactionValues,
        stderr: (diagnostic) =>
          observeModelInvocation(invocation, {
            type: "progress",
            capture: {
              event: {
                kind: "interaction",
                providerEvent: "codex.native-stderr",
                coverage: "boundary",
                providerSessionId: thread.id,
              },
              content: () => diagnostic,
            },
          }),
        signal,
        event: (event) => {
          if (event.type === "thread.started") {
            if (thread.id && event.thread_id !== thread.id)
              throw new Error(
                "Reviewer native continuation changed its thread identity",
              );
            thread.id = event.thread_id;
            checkpointSession("in-flight");
          }
          const item =
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
              ? event.item
              : undefined;
          const activeTool =
            item?.type === "command_execution" ||
            item?.type === "mcp_tool_call";
          turn.progress(
            item ? `${event.type}:${item.type}` : event.type,
            activeTool
              ? {
                  id: item.id,
                  active:
                    item.status === "in_progress" &&
                    event.type !== "item.completed",
                }
              : undefined,
          );
          // Activity acknowledgments are not billing or terminal receipts.
          // Silence and startup warnings leave submitted usage unknown.
          if (
            (item && item.type !== "error") ||
            event.type === "turn.completed"
          )
            state.started = true;
          if (
            event.type === "item.completed" &&
            event.item.type === "agent_message"
          )
            state.response = event.item.text;
          if (event.type === "turn.completed") {
            const usage = codexInvocationUsage(
              event.usage,
              captureBoundary?.usage,
            );
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "usage",
                  usage: {
                    scope: "invocation-cumulative",
                    terminal: true,
                    completeness: Object.keys(usage).length
                      ? "available-categories"
                      : "unavailable",
                    normalized: usage,
                    raw: codexRawTokenUsage(event.usage),
                    rawScope: "thread-cumulative",
                  },
                },
              },
            });
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "outcome",
                  outcome: { stage: "provider", status: "completed" },
                  durationMs: Date.now() - started,
                },
              },
            });
            turnCompleted = true;
            if (session?.currentTurn)
              session.currentTurn.terminal = "completed";
            state.ended = true;
            state.usage = Object.keys(usage).length ? usage : undefined;
          }
          const tool =
            item?.type === "mcp_tool_call"
              ? `${item.server}/${item.tool}`
              : item?.type === "command_execution"
                ? "shell"
                : item?.type === "file_change"
                  ? "apply_patch"
                  : undefined;
          const captured = codexCaptureEvent(
            event,
            thread.id ?? undefined,
            this.redactionValues,
            "native",
            captureBoundary?.usage,
          );
          if (sessionTurn) captured.event.sessionTurn = sessionTurn;
          observeModelInvocation(invocation, {
            type: "progress",
            capture: captured,
            provider: this.provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            providerThreadId:
              event.type === "thread.started"
                ? event.thread_id
                : (thread.id ?? undefined),
            providerEvent: event.type,
            providerItemId: item?.id,
            providerItemType: item?.type,
            tool,
            ...(item?.type === "error"
              ? { detail: `Nonfatal Codex SDK warning: ${item.message}` }
              : {}),
            ...(event.type === "error" ? { detail: event.message } : {}),
            ...(state.usage
              ? { usage: state.usage, usageAvailable: true }
              : {}),
          });
          if (event.type === "turn.failed") {
            state.ended = true;
            if (session?.currentTurn) session.currentTurn.terminal = "failed";
            throw new Error(event.error.message);
          }
          if (event.type === "error") streamError = new Error(event.message);
          // Stream errors can precede a CLI-managed retry. Native exit and
          // process-group settlement remain part of this owned invocation.
        },
      });
      state.stopped = true;
      if (!turnCompleted && streamError) throw streamError;
      requireCompletedProviderTurn(turnCompleted);
    } catch (error) {
      retainHome = error instanceof UnsettledSubprocessError;
      // runCodexExec throws ordinary failures only after the owned process group settles.
      state.stopped = !retainHome;
      observeModelInvocation(invocation, {
        type: "progress",
        capture: {
          event: {
            kind: "interaction",
            providerEvent: nativeAttempted
              ? "codex.native-failure"
              : "codex.native-startup-failure",
            providerSessionId: thread?.id ?? undefined,
            coverage: "boundary",
          },
          content: () => home.nativeMetadata(thread?.id ?? undefined),
        },
      });
      throw error;
    } finally {
      state.providerThreadId = thread.id;
      turn.finish();
      if (!nativeAttempted && !initialCheckpointed) {
        // Rejected startup ownership precedes all native work. Dispose only
        // this freshly created authenticated home; an earlier conversation
        // and a superseding controller's receipt remain untouched.
        if (session && !captureBoundary)
          releaseCodexHome(home.root, this.sessionOwner(session));
        else if (!session) home.dispose();
      } else if (!retainHome) {
        home.nativeCapture(
          thread.id,
          (event, content) =>
            observeModelInvocation(invocation, {
              type: "progress",
              capture: { event: { ...event, sessionTurn }, content },
            }),
          captureBoundary,
        );
        if (session?.currentTurn && sessionData) {
          session.currentTurn.resources = "settled";
          if (
            session.currentTurn.dispatch === "submitted" &&
            !session.currentTurn.terminal
          )
            session.currentTurn.terminal = "interrupted";
          if (session.currentTurn.terminal === "completed" && turnCompleted) {
            sessionData.response = state.response;
            sessionData.responseDigest = createHash("sha256")
              .update(state.response)
              .digest("hex");
          }
          if (state.usage) sessionData.usage = state.usage;
        }
        if (session && !thread.id) {
          checkpointSession("unavailable");
          releaseCodexHome(home.root, this.sessionOwner(session));
          checkpointSession("released");
        } else {
          checkpointSession(
            thread.id &&
              (turnCompleted ||
                session?.currentTurn?.terminal === "completed" ||
                session?.currentTurn?.terminal === "failed")
              ? "ready"
              : "unavailable",
          );
          if (!session) home.dispose();
        }
      }
    }
  }
}
