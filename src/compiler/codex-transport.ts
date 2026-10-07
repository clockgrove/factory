import {
  type PlanningTransport,
  CODEX_PLANNING_PROVIDER,
  CODEX_PLANNING_ADAPTER,
  type PlanningRole,
  type PlanningTurn,
} from "./transport.js";
import type { CodexModelSelection } from "../config.js";
import type { ModelInvocationContext } from "../contracts.js";
import {
  ProviderTurnGuard,
  requireCompletedProviderTurn,
} from "../provider-turn.js";
import {
  createCodexHome,
  CODEX_TREE_REVIEW_CONFIG,
  CODEX_PLANNING_CONFIG,
} from "../codex-planning-isolation.js";
import { runCodexExec } from "../codex-exec.js";
import { observeModelInvocation } from "./observation.js";
import { codexRawTokenUsage } from "../usage.js";
import { codexCaptureEvent } from "../execution/interaction-capture.js";
import { UnsettledSubprocessError } from "../process.js";

/**
 * Codex SDK transport: a read-only, never-approving, tool-free thread per
 * attempt, run under Factory's own scratch CODEX_HOME so the operator's
 * config.toml and AGENTS.md never apply.
 */
export class CodexPlanningTransport implements PlanningTransport {
  readonly provider = CODEX_PLANNING_PROVIDER;
  readonly adapter = CODEX_PLANNING_ADAPTER;

  constructor(
    private checkout: string,
    private planner: CodexModelSelection,
    private reviewer: CodexModelSelection,
    private providerTurnIdleTimeoutMs: number,
    private redactionValues: string[],
  ) {}

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
  }): Promise<void> {
    const { invocation, turn: state } = args;
    const selection = this.selection(args.role);
    const started = Date.now();
    const turn = new ProviderTurnGuard(this.providerTurnIdleTimeoutMs);
    const thread: { id?: string } = {};
    let retainHome = false;
    let turnCompleted = false;
    let streamError: Error | undefined;
    // A tree review's shell reads the tree alone, offline.
    const home = createCodexHome(
      args.tree
        ? {
            config: CODEX_TREE_REVIEW_CONFIG,
            sandbox: {
              directory: args.tree,
              workspace: "read",
              network: false,
            },
          }
        : { config: CODEX_PLANNING_CONFIG },
    );
    try {
      await runCodexExec({
        env: home.env,
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
        signal: turn.signal,
        event: (event) => {
          if (event.type === "thread.started") thread.id = event.thread_id;
          turn.progress();
          const item =
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
              ? event.item
              : undefined;
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
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "usage",
                  usage: {
                    scope: "invocation-cumulative",
                    terminal: true,
                    completeness: event.usage
                      ? "available-categories"
                      : "unavailable",
                    normalized: event.usage
                      ? {
                          inputTokens: event.usage.input_tokens,
                          cachedInputTokens: event.usage.cached_input_tokens,
                          cacheWriteInputTokens:
                            event.usage.cache_write_input_tokens,
                          outputTokens: event.usage.output_tokens,
                          reasoningOutputTokens:
                            event.usage.reasoning_output_tokens,
                        }
                      : {},
                    raw: codexRawTokenUsage(event.usage),
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
            if (event.usage)
              state.usage = {
                inputTokens: event.usage.input_tokens,
                cachedInputTokens: event.usage.cached_input_tokens,
                cacheWriteInputTokens: event.usage.cache_write_input_tokens,
                outputTokens: event.usage.output_tokens,
                reasoningOutputTokens: event.usage.reasoning_output_tokens,
              };
          }
          const tool =
            item?.type === "mcp_tool_call"
              ? `${item.server}/${item.tool}`
              : item?.type === "command_execution"
                ? "shell"
                : item?.type === "file_change"
                  ? "apply_patch"
                  : undefined;
          observeModelInvocation(invocation, {
            type: "progress",
            capture: codexCaptureEvent(
              event,
              thread.id ?? undefined,
              this.redactionValues,
            ),
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
      if (!turnCompleted && streamError) throw streamError;
      requireCompletedProviderTurn(turnCompleted);
    } catch (error) {
      retainHome = error instanceof UnsettledSubprocessError;
      observeModelInvocation(invocation, {
        type: "progress",
        capture: {
          event: {
            kind: "interaction",
            providerEvent: "codex.native-failure",
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
      if (!retainHome) home.dispose();
    }
  }
}
