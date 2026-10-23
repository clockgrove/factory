import type { ObjectiveBlock } from "../shown.js";
/**
 * Provider selection. Each configured provider gets its own planner,
 * worker and workflow; an Objective runs on the provider it froze when it
 * was admitted (state.provider), whatever the configuration or
 * `serve --provider` says later. Cancel needs no provider.
 */

import { isDeepStrictEqual } from "node:util";
import type { CoreConfig } from "../config.js";
import { hold, type Step, switchTargets, type Workflow } from "../engine.js";
import type { Plan } from "../planning/types.js";
import { type ObjectiveState, TERMINAL } from "../state.js";
import type { Worker } from "../work/worker.js";
import { ClaudePlanner, DEFAULT_CLAUDE_MODELS } from "./claude.js";
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
  switch (provider.planner) {
    case "claude":
      return new HedgedPlanner(
        new ClaudePlanner({ ...DEFAULT_CLAUDE_MODELS, ...provider.models }),
      );
    case "copilot":
      return new HedgedPlanner(
        new CopilotPlanner({ ...DEFAULT_COPILOT_MODELS, ...provider.models }),
      );
    default:
      return new HedgedPlanner(
        new CodexPlanner({ ...DEFAULT_CODEX_MODELS, ...provider.models }),
      );
  }
}

/** The provider's worker for one Objective's plan. */
export function providerWorker(
  provider: ProviderConfig,
  config: CoreConfig,
): (plan: Plan, blocks: readonly ObjectiveBlock[]) => Worker {
  const worker = provider.worker;
  const allowedSecretNames = config.policy.allowedSecretNames;
  return (plan, blocks) => {
    switch (worker.kind) {
      case "claude":
        return new ClaudeWorker({
          sandbox: config.sandbox,
          plan,
          blocks,
          repository: config.repository,
          config: worker.settings,
          allowedSecretNames,
          commandTimeoutMs: config.validation.commandTimeoutSeconds * 1000,
        });
      case "copilot":
        return new CopilotWorker({
          model: { model: worker.model, effort: worker.effort },
          tools: worker.tools,
          idleMs: worker.idleSeconds * 1000,
          validation: {
            sandbox: config.sandbox,
            plan,
            blocks,
            repository: config.repository,
            commandTimeoutMs: config.validation.commandTimeoutSeconds * 1000,
          },
        });
      case "openai-agents":
        return new OpenAIManagedWorker(worker);
      case "claude-managed-agents":
        return new ClaudeManagedWorker(worker);
      default: {
        const { kind: _, network, ...model } = worker;
        return new CodexWorker({
          model,
          sandbox: config.sandbox,
          network,
          allowedSecretNames,
          secrets: config.secrets,
        });
      }
    }
  };
}

/** A provider's workflow, with the settings it was built from. */
export interface ProviderRoute {
  workflow: Workflow;
  settings: ProviderConfig;
}

/**
 * Settings as state stores them, so a frozen copy compares equal. Copilot's
 * `idleSeconds` is a bound, not a choice the Objective froze: changing it
 * strands nothing.
 */
export const frozenSettings = (settings: ProviderConfig): ProviderConfig =>
  JSON.parse(
    JSON.stringify(settings, (key, value) =>
      key === "idleSeconds" ? undefined : value,
    ),
  ) as ProviderConfig;

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
  // `switch NAME` freezes these settings, so the new route matches them.
  const providers = Object.fromEntries(
    [...routes].map(([name, route]) => [name, frozenSettings(route.settings)]),
  );
  return {
    steps(state) {
      // Cancel cleanup is the same on every provider.
      if (state.status === "cancelled") return fallback.steps(state);
      if (TERMINAL.includes(state.status)) return [];
      const workflow = frozen(state);
      return workflow ? workflow.steps(state) : [unavailable(state, providers)];
    },
    status: (state) => (frozen(state) ?? fallback).status(state),
    upstream: (state, item) =>
      (frozen(state) ?? fallback).upstream?.(state, item) ?? [],
    providers,
  };
}

function unavailable(
  state: ObjectiveState,
  providers: Readonly<Record<string, ProviderConfig>>,
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
      const configured = provider.name in providers;
      const what = configured
        ? `whose settings changed since then. It needs them as they were: ${JSON.stringify(provider.settings)}. Restore them`
        : "which the configuration no longer names. Restore it with the settings it had";
      // `switch` moves the Objective now, without restoring anything: onto
      // another configured provider, or onto this one's new settings. The
      // engine accepts exactly these (switchTargets).
      const others = switchTargets(provider, providers);
      const named = others
        .map((n) =>
          n === provider.name ? `\`${n}\` (its new settings)` : `\`${n}\``,
        )
        .join(", ");
      return others.length
        ? hold(
            `This Objective started on provider "${provider.name}", ${what} and restart the service, then answer retry. Or ${others.length === 1 ? `answer \`switch\` to run it on provider ${named}` : `answer \`switch NAME\` to run it on one of these providers: ${named}`}; or cancel.`,
            ["switch", "retry", "cancel"],
          )
        : hold(
            `This Objective started on provider "${provider.name}", ${what} and restart the service, then answer retry; or cancel.`,
          );
    },
  };
}
