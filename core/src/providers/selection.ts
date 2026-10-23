/**
 * Provider selection. Each configured provider gets its own planner,
 * worker and workflow; an Objective runs on the provider it froze when it
 * was admitted (state.provider), whatever the configuration or
 * `serve --provider` says later. Cancel needs no provider.
 */
import type { CoreConfig } from "../config.js";
import { hold, type Step, type Workflow } from "../engine.js";
import type { Plan } from "../planning/types.js";
import type { ObjectiveState } from "../state.js";
import type { Worker } from "../work/worker.js";
import {
  ClaudePlanner,
  type ClaudePlannerOptions,
  DEFAULT_CLAUDE_MODELS,
} from "./claude.js";
import { ClaudeWorker } from "./claude-worker.js";
import { CodexPlanner, DEFAULT_CODEX_MODELS } from "./codex.js";
import { CodexWorker } from "./codex-worker.js";
import type { ProviderConfig } from "./config.js";
import {
  CopilotPlanner,
  CopilotWorker,
  DEFAULT_COPILOT_MODELS,
} from "./copilot.js";
import { ClaudeManagedWorker, OpenAIManagedWorker } from "./managed.js";
import { HedgedPlanner, type Planner } from "./planner.js";

/** The provider's planner, hedged against stalled calls. */
export function providerPlanner(provider: ProviderConfig): Planner {
  const models = provider.models ?? {};
  switch (provider.planner) {
    case "claude":
      return new HedgedPlanner(
        new ClaudePlanner({
          ...DEFAULT_CLAUDE_MODELS,
          ...models,
        } as ClaudePlannerOptions),
      );
    case "copilot":
      return new HedgedPlanner(
        new CopilotPlanner({
          ...DEFAULT_COPILOT_MODELS,
          ...models,
        } as typeof DEFAULT_COPILOT_MODELS),
      );
    default:
      return new HedgedPlanner(
        new CodexPlanner({
          ...DEFAULT_CODEX_MODELS,
          ...models,
        } as typeof DEFAULT_CODEX_MODELS),
      );
  }
}

/** The provider's worker for one Objective's plan. */
export function providerWorker(
  provider: ProviderConfig,
  config: CoreConfig,
): (plan: Plan, body: string) => Worker {
  const worker = provider.worker;
  const allowedSecretNames = config.policy.allowedSecretNames;
  return (plan, body) => {
    switch (worker.kind) {
      case "claude":
        return new ClaudeWorker({
          sandbox: config.sandbox,
          plan,
          body,
          repository: config.repository,
          config: worker.settings,
          allowedSecretNames,
        });
      case "copilot":
        return new CopilotWorker({
          model: { model: worker.model, effort: worker.effort },
          tools: worker.tools,
        });
      case "openai-agents":
        return new OpenAIManagedWorker(worker);
      case "claude-managed-agents":
        return new ClaudeManagedWorker(worker);
      default:
        return new CodexWorker({
          sandbox: config.sandbox,
          network: worker.network,
          allowedSecretNames,
        });
    }
  };
}

/**
 * Route each Objective to its frozen provider's workflow. An Objective
 * whose provider is no longer configured holds until it is restored;
 * `cancel` always works.
 */
export function providerWorkflow(
  workflows: ReadonlyMap<string, Workflow>,
  fallback: Workflow,
): Workflow {
  const frozen = (state: ObjectiveState) =>
    state.provider ? workflows.get(state.provider.name) : undefined;
  return {
    steps(state) {
      // Cancel cleanup is the same on every provider.
      if (state.status === "cancelled") return fallback.steps(state);
      const workflow = frozen(state);
      return workflow ? workflow.steps(state) : [missingProvider(state)];
    },
    status: (state) => (frozen(state) ?? fallback).status(state),
  };
}

function missingProvider(state: ObjectiveState): Step {
  return {
    key: "provider",
    deadlineMs: 60_000,
    async run() {
      if (!state.provider)
        return hold(
          "This Objective has no frozen provider: it was admitted by a Factory build that didn't record one. Cancel it and queue it again.",
          ["cancel"],
        );
      return hold(
        `This Objective started on provider "${state.provider.name}", which the configuration no longer names. Restore that provider in the configuration and restart the service, then answer retry; or cancel.`,
      );
    },
  };
}
