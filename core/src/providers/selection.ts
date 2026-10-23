/**
 * Provider selection. Each configured provider gets its own planner,
 * worker and workflow; an Objective runs on the provider it froze when it
 * was admitted (state.provider), whatever the configuration or
 * `serve --provider` says later. Cancel needs no provider.
 */

import { isDeepStrictEqual } from "node:util";
import type { CoreConfig } from "../config.js";
import { hold, type Step, type Workflow } from "../engine.js";
import type { Plan } from "../planning/types.js";
import { type ObjectiveState, TERMINAL } from "../state.js";
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

/** A provider's workflow, with the settings it was built from. */
export interface ProviderRoute {
  workflow: Workflow;
  settings: ProviderConfig;
}

/** Settings as state stores them, so a frozen copy compares equal. */
export const frozenSettings = (settings: ProviderConfig): ProviderConfig =>
  JSON.parse(JSON.stringify(settings)) as ProviderConfig;

/**
 * Route each Objective to the provider it froze at admission. It runs only
 * while that provider is configured with the same planner, models and
 * worker; otherwise it holds until they are restored. A finished Objective
 * has no steps, and `cancel` always works.
 */
export function providerWorkflow(
  routes: ReadonlyMap<string, ProviderRoute>,
  fallback: Workflow,
): Workflow {
  const frozen = (state: ObjectiveState) => {
    const route = state.provider && routes.get(state.provider.name);
    return route &&
      isDeepStrictEqual(
        frozenSettings(route.settings),
        state.provider!.settings,
      )
      ? route.workflow
      : undefined;
  };
  return {
    steps(state) {
      // Cancel cleanup is the same on every provider.
      if (state.status === "cancelled") return fallback.steps(state);
      if (TERMINAL.includes(state.status)) return [];
      const workflow = frozen(state);
      return workflow ? workflow.steps(state) : [unavailable(state, routes)];
    },
    status: (state) => (frozen(state) ?? fallback).status(state),
  };
}

function unavailable(
  state: ObjectiveState,
  routes: ReadonlyMap<string, ProviderRoute>,
): Step {
  return {
    key: "provider",
    deadlineMs: 60_000,
    async run() {
      const provider = state.provider;
      if (!provider)
        return hold(
          "This Objective has no frozen provider: it was admitted by a Factory build that didn't record one. Cancel it and queue it again.",
          ["cancel"],
        );
      const what = routes.has(provider.name)
        ? `whose settings changed since then. It needs them as they were: ${JSON.stringify(provider.settings)}. Restore them`
        : "which the configuration no longer names. Restore it with the settings it had";
      return hold(
        `This Objective started on provider "${provider.name}", ${what} and restart the service, then answer retry; or cancel.`,
      );
    },
  };
}
