import {
  type PlanningTransport,
  CODEX_PLANNING_PROVIDER,
  CODEX_PLANNING_ADAPTER,
  type PlanningRole,
  type PlanningTurn,
} from "./transport.js";
import type { CodexModelSelection } from "../config.js";
import type {
  ModelInvocationContext,
  AgentSessionContinuation,
  AgentSessionRef,
} from "../contracts.js";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  ProviderTurnGuard,
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  requireCompletedProviderTurn,
} from "../provider-turn.js";
import {
  createCodexHome,
  CODEX_TREE_REVIEW_CONFIG,
  CODEX_PLANNING_CONFIG,
  releaseCodexHome,
} from "../codex-planning-isolation.js";
import { runCodexExec } from "../codex-exec.js";
import { observeModelInvocation } from "./observation.js";
import { codexRawTokenUsage, codexInvocationUsage } from "../usage.js";
import { codexCaptureEvent } from "../execution/interaction-capture.js";
import { UnsettledSubprocessError } from "../process.js";

const LOWER_EFFORT_REVIEW_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Codex native transport with isolated review continuations. Compilation and
 * graph review remain fresh, tool-free turns; result reviews keep their own
 * conversation while reading only each invocation's exact candidate tree.
 */
export class CodexPlanningTransport implements PlanningTransport {
  readonly provider = CODEX_PLANNING_PROVIDER;
  readonly adapter = CODEX_PLANNING_ADAPTER;

  constructor(
    private checkout: string,
    private planner: CodexModelSelection,
    private reviewer: CodexModelSelection,
    private providerTurnIdleTimeoutMs: number | undefined,
    private redactionValues: string[],
    private sessionRoot?: string,
  ) {}

  get sessionContinuation(): true | undefined {
    return this.sessionRoot ? true : undefined;
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
  } {
    const data = session.data as
      | {
          sessionRoot?: unknown;
          threadId?: unknown;
          selectionDigest?: unknown;
        }
      | undefined;
    if (
      !this.sessionRoot ||
      session.adapter !== this.adapter ||
      !/^[a-f0-9-]{36}$/.test(session.identity) ||
      data?.sessionRoot !== join(resolve(this.sessionRoot), session.identity) ||
      typeof data.selectionDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.selectionDigest) ||
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
    };
  }

  async releaseSession(session: AgentSessionRef): Promise<void> {
    if (session.status === "in-flight")
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
    invocation: ModelInvocationContext;
    turn: PlanningTurn;
    tree?: string;
    session?: AgentSessionContinuation;
    signal?: AbortSignal;
  }): Promise<void> {
    const { invocation, turn: state } = args;
    const selection = this.selection(args.role);
    const continuation =
      this.sessionRoot && args.tree && args.session ? args.session : undefined;
    let session: AgentSessionRef | undefined;
    let sessionData:
      | ReturnType<CodexPlanningTransport["sessionData"]>
      | undefined;
    if (continuation) {
      if (
        args.role !== "reviewer" ||
        !["result-review", "objective-review"].includes(continuation.scope.role)
      )
        throw new Error("Reviewer continuation has a different role");
      const selectionDigest = createHash("sha256")
        .update(JSON.stringify(selection))
        .digest("hex");
      if (continuation.retained) {
        const retained = continuation.retained;
        sessionData = this.sessionData(retained);
        if (
          retained.status !== "ready" ||
          !sessionData.threadId ||
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
        };
      }
      session = {
        scope: structuredClone(continuation.scope),
        adapter: this.adapter,
        identity: continuation.identity,
        data: sessionData,
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
    let nativeCompleted = false;
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
        : { config: CODEX_PLANNING_CONFIG },
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
          ...(captureBoundary ? { boundaryBytes: captureBoundary.bytes } : {}),
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
              providerEvent: "factory.review-session",
              providerSessionId: thread.id,
              sessionTurn,
              coverage: "boundary",
            },
          },
        });
      nativeAttempted = true;
      await runCodexExec({
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
        signal: args.signal
          ? AbortSignal.any([turn.signal, args.signal])
          : turn.signal,
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
          // Codex emits turn.started before it sends the model request, so a
          // connection that fails after it reached no model and is unpaid.
          // Startup warnings do not prove inference; other items or usage do.
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
            throw new Error(event.error.message);
          }
          if (event.type === "error") streamError = new Error(event.message);
          // Stream errors can precede a CLI-managed retry. Native exit and
          // process-group settlement remain part of this owned invocation.
        },
      });
      nativeCompleted = true;
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
        if (session && !thread.id) {
          checkpointSession("unavailable");
          releaseCodexHome(home.root, this.sessionOwner(session));
          checkpointSession("released");
        } else {
          checkpointSession(
            thread.id && turnCompleted && nativeCompleted
              ? "ready"
              : "unavailable",
          );
          if (!session) home.dispose();
        }
      }
    }
  }
}
