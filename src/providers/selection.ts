/**
 * Provider selection. Each configured provider gets its own planner,
 * worker and workflow; an Objective runs on the provider it froze when it
 * was admitted (state.frozen), whatever `serve --provider` says later.
 * Cancel needs no provider.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isObject } from "../checked.js";
import type { CoreConfig, SandboxConfig } from "../config.js";
import { ADOPTS, hold, type Step, type Workflow } from "../engine.js";
import { deliveryChange, profilesLacking } from "../planning/plan.js";
import type { Plan } from "../planning/types.js";
import type { ObjectiveBlock } from "../shown.js";
import { type ObjectiveState, TERMINAL } from "../state.js";
import type { Worker } from "../work/worker.js";
import {
  ClaudePlanner,
  type ClaudePlannerOptions,
  DEFAULT_CLAUDE_MODELS,
} from "./claude.js";
import {
  ClaudeWorker,
  type ClaudeWorkerConfig,
  claudeWorkerTools,
  DEFAULT_CLAUDE_WORKER,
} from "./claude-worker.js";
import {
  type CodexEffort,
  CodexPlanner,
  DEFAULT_CODEX_MODELS,
} from "./codex.js";
import { CodexWorker, DEFAULT_CODEX_WORKER_MODEL } from "./codex-worker.js";
import type { ProviderConfig } from "./config.js";
import {
  CopilotPlanner,
  CopilotWorker,
  DEFAULT_COPILOT_MODELS,
} from "./copilot.js";
import { ClaudeManagedWorker, OpenAIManagedWorker } from "./managed.js";
import {
  HedgedPlanner,
  type ModelChoice,
  type Planner,
  type PlannerModels,
} from "./planner.js";

/** A planner kind's adapter defaults for its models. */
export function defaultModels(planner: string): PlannerModels {
  return planner === "claude"
    ? DEFAULT_CLAUDE_MODELS
    : planner === "copilot"
      ? DEFAULT_COPILOT_MODELS
      : DEFAULT_CODEX_MODELS;
}

/**
 * The provider's settings with every adapter default filled in: what its
 * planner and worker run with, and what an Objective freezes, so an
 * upgrade that changes a default holds a running Objective too.
 */
export function resolvedProvider(provider: ProviderConfig): ProviderConfig {
  const worker = provider.worker;
  return {
    ...provider,
    models: { ...defaultModels(provider.planner), ...provider.models },
    worker:
      worker.kind === "claude"
        ? {
            ...worker,
            settings: { ...DEFAULT_CLAUDE_WORKER, ...worker.settings },
          }
        : worker.kind === "codex"
          ? { ...DEFAULT_CODEX_WORKER_MODEL, ...worker }
          : worker,
  } as ProviderConfig;
}

/** What a profile's worker runs with, shown to the planner beside its description. */
export interface ProfileWorker {
  kind: string;
  model?: string;
  effort?: string;
  /** The tools the worker may use. */
  tools: string[];
  /** Whether the worker's own commands reach the network. */
  network: "off" | "host" | "hosted";
}

/** A provider's worker as the planner sees it, adapter defaults filled in. */
export function profileWorker(
  provider: ProviderConfig,
  worktreeRead: boolean,
  sandboxNetwork: SandboxConfig["network"],
): ProfileWorker {
  const worker = resolvedProvider(provider).worker;
  switch (worker.kind) {
    case "codex":
      return {
        kind: worker.kind,
        model: worker.model!,
        effort: worker.effort!,
        tools: ["sandboxed shell"],
        network: worker.network,
      };
    case "claude": {
      const settings = worker.settings as ClaudeWorkerConfig;
      return {
        kind: worker.kind,
        model: settings.model,
        effort: settings.effort,
        tools: claudeWorkerTools(settings, worktreeRead),
        network: sandboxNetwork === "host" ? "host" : "off",
      };
    }
    case "copilot":
      return {
        kind: worker.kind,
        model: worker.model,
        effort: worker.effort,
        tools: worker.tools,
        network: "off",
      };
    case "openai-agents":
      return {
        kind: worker.kind,
        model: worker.model,
        effort: worker.effort,
        tools: ["hosted container shell"],
        network: "hosted",
      };
    case "claude-managed-agents":
      return {
        kind: worker.kind,
        tools: [
          `agent ${worker.agentId} version ${worker.agentVersion}'s tools`,
        ],
        network: "hosted",
      };
  }
}

/** The provider's planner, hedged against stalled calls. */
export function providerPlanner(provider: ProviderConfig): Planner {
  const resolved = resolvedProvider(provider);
  switch (resolved.planner) {
    case "claude":
      return new HedgedPlanner(
        new ClaudePlanner(resolved.models as ClaudePlannerOptions),
      );
    case "copilot":
      return new HedgedPlanner(
        new CopilotPlanner(resolved.models as PlannerModels),
      );
    default:
      return new HedgedPlanner(
        new CodexPlanner(resolved.models as PlannerModels<CodexEffort>),
      );
  }
}

/**
 * The worker for one Objective's plan: the Objective's provider's, or for
 * an item the planner gave an execution profile, that profile's provider's.
 */
export function providerWorker(
  provider: ProviderConfig,
  config: CoreConfig,
): (plan: Plan, blocks: readonly ObjectiveBlock[], profile?: string) => Worker {
  const allowedSecretNames = config.policy.allowedSecretNames;
  return (plan, blocks, profile) => {
    const worker = resolvedProvider(
      profileProvider(config, profile) ?? provider,
    ).worker;
    switch (worker.kind) {
      case "claude":
        return new ClaudeWorker({
          sandbox: config.sandbox,
          plan,
          blocks,
          repository: config.repository,
          config: worker.settings as ClaudeWorkerConfig,
          allowedSecretNames,
          commandTimeoutMs: config.validation.commandTimeoutSeconds * 1000,
          worktreeRead:
            profile !== undefined &&
            config.execution.profiles?.[profile]?.worktreeRead === true,
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
          model: model as ModelChoice<CodexEffort>,
          sandbox: config.sandbox,
          network,
          allowedSecretNames,
          secrets: config.secrets,
        });
      }
    }
  };
}

/**
 * The settings of the provider an execution profile names; undefined
 * without a profile. The workflow runs only on the configuration the
 * Objective froze, which holds every profile its plan could name, so an
 * unknown one is a bug.
 */
function profileProvider(
  config: CoreConfig,
  profile: string | undefined,
): ProviderConfig | undefined {
  if (profile === undefined) return undefined;
  const settings =
    config.providers[config.execution.profiles?.[profile]?.provider ?? ""];
  if (!settings)
    throw new Error(`Execution profile ${profile} is not configured`);
  return settings;
}

/**
 * The keys an Objective doesn't freeze, as paths into its frozen
 * configuration (`provider` is its own provider's settings). They operate
 * the host or present the run, never decide the work, so they may change
 * under a running Objective. Every other key is frozen, including keys
 * added later.
 */
export const OPERATIONAL: readonly string[] = [
  // Derived secret values: never written to state.
  "secrets",
  // Polling, the slots for Objectives at once, and the Project fields progress is shown in.
  "queue",
  // Steps at once, and the host's caps and memory reservations (capacity.ts).
  "execution.concurrency",
  "execution.workers",
  "execution.validations",
  "execution.planners",
  "execution.memoryMiB",
  "execution.reservations",
  // The sandbox's resource caps and the package cache's place on the host.
  "sandbox.limits",
  "sandbox.packageStore",
  // Selectors choose review evidence and grant no authority; each capture records what it ran.
  "reviewArtifacts",
  // The live status comment: display only.
  "progress",
  // The Work Item issues: display only.
  "tracking",
  // A validation command's time limit.
  "validation.commandTimeoutSeconds",
  // A worker run's time, idle and turn limits.
  "provider.worker.timeoutSeconds",
  "provider.worker.idleSeconds",
  "provider.worker.settings.maxTurns",
  // Content capture observes calls; it changes no run.
  "capture",
];

/** An Objective's frozen configuration: the values and their digest. */
export interface FrozenConfig {
  /** SHA-256 of `config` with its keys sorted. */
  digest: string;
  config: Record<string, unknown>;
}

/**
 * The configuration as an Objective on `provider` freezes it: everything
 * but OPERATIONAL, with that provider's resolved settings as `provider` in place
 * of `providers` and `defaultProvider` (they only choose a new
 * Objective's provider). Undefined when `provider` isn't configured.
 */
export function freezeConfig(
  config: CoreConfig,
  provider: string,
): FrozenConfig | undefined {
  const settings = config.providers[provider];
  if (!settings) return undefined;
  const { providers: _all, defaultProvider: _default, ...rest } = config;
  const profiles = config.execution.profiles;
  const frozen = JSON.parse(
    JSON.stringify({
      ...rest,
      provider: resolvedProvider(settings),
      // Each profile with its provider's resolved settings: a change to
      // either holds the Objective.
      ...(profiles
        ? {
            execution: {
              ...rest.execution,
              profiles: Object.fromEntries(
                Object.entries(profiles).map(([id, profile]) => [
                  id,
                  {
                    ...profile,
                    settings: resolvedProvider(
                      config.providers[profile.provider]!,
                    ),
                  },
                ]),
              ),
            },
          }
        : {}),
    }),
  ) as Record<string, unknown>;
  // A profile's provider settings have the provider's operational keys.
  const operational = OPERATIONAL.flatMap((path) =>
    path.startsWith("provider.")
      ? [
          path,
          ...Object.keys(profiles ?? {}).map(
            (id) =>
              `execution.profiles.${id}.settings.${path.slice("provider.".length)}`,
          ),
        ]
      : [path],
  );
  for (const path of operational) {
    const keys = path.split(".");
    const last = keys.pop()!;
    let at: unknown = frozen;
    for (const key of keys) at = isObject(at) ? at[key] : undefined;
    if (isObject(at)) delete at[last];
  }
  return {
    digest: createHash("sha256").update(canonical(frozen)).digest("hex"),
    config: frozen,
  };
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : isObject(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

/** The keys whose values differ between two frozen configurations, as dotted paths. */
export function frozenChanges(
  was: Record<string, unknown>,
  now: Record<string, unknown>,
  prefix = "",
): string[] {
  return [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .sort()
    .flatMap((key) => {
      const [a, b] = [was[key], now[key]];
      if (isObject(a) && isObject(b))
        return frozenChanges(a, b, `${prefix}${key}.`);
      return isDeepStrictEqual(a, b) ? [] : [`${prefix}${key}`];
    });
}

/** A provider's workflow, with the configuration an Objective on it freezes. */
export interface ProviderRoute {
  workflow: Workflow;
  frozen: FrozenConfig;
}

/**
 * Route each Objective to the provider it froze. It runs only while the
 * configuration is as it froze it (docs/reference/state.md#Frozen configuration);
 * otherwise it holds once, naming the changed keys. A finished Objective
 * has no steps, and `cancel` always works.
 */
export function providerWorkflow(
  routes: ReadonlyMap<string, ProviderRoute>,
  fallback: Workflow,
): Workflow {
  const frozen = (state: ObjectiveState) => {
    const route = state.frozen && routes.get(state.frozen.provider);
    return route && route.frozen.digest === state.frozen!.digest
      ? route.workflow
      : undefined;
  };
  const freezable = Object.fromEntries(
    [...routes].map(([name, route]) => [name, route.frozen]),
  );
  return {
    steps(state) {
      // Cancel cleanup is the same on every provider.
      if (state.status === "cancelled") return fallback.steps(state);
      if (TERMINAL.includes(state.status)) return [];
      const workflow = frozen(state);
      return workflow ? workflow.steps(state) : [changed(state, freezable)];
    },
    status: (state) => (frozen(state) ?? fallback).status(state),
    upstream: (state, item) =>
      (frozen(state) ?? fallback).upstream?.(state, item) ?? [],
    // The same on every provider: GitHub, Git and provider errors and
    // replan.
    ...(fallback.outcomeOf ? { outcomeOf: fallback.outcomeOf } : {}),
    ...(fallback.replannable ? { replannable: fallback.replannable } : {}),
    ...(fallback.replan ? { replan: fallback.replan } : {}),
    freezable,
  };
}

/** The question an Objective asks when the configuration isn't the one it froze. */
function changed(
  state: ObjectiveState,
  freezable: Readonly<Record<string, FrozenConfig>>,
): Step {
  return {
    key: "config",
    deadlineMs: 60_000,
    async run() {
      const frozen = state.frozen;
      if (!frozen)
        return hold(
          "This Objective has no frozen configuration: it was admitted without one. Cancel it and queue it again.",
          ["cancel"],
        );
      // A profile the plan runs on is gone: only restoring it helps, since
      // `adopt` or `switch` would freeze a configuration without it (and
      // every provider's configuration names the same profiles).
      const live = freezable[frozen.provider];
      const now = live ?? Object.values(freezable)[0];
      const missing = profilesLacking(state, now?.config ?? {});
      if (missing.length)
        return hold(
          `This Objective's plan runs on execution profile${missing.length === 1 ? "" : "s"} ${missing.map((id) => `"${id}"`).join(", ")}, which the configuration no longer names. Restore ${missing.length === 1 ? "it" : "them"} as ${missing.length === 1 ? "it was" : "they were"}, restart the service and answer retry; or cancel.`,
          [
            {
              answer: "retry",
              family: "retry",
              consequence:
                "Runs on the frozen profiles again, once they are restored and the service restarted.",
            },
            "cancel",
          ],
        );
      // delivery.kind is the installation's: no provider's configuration
      // keeps the kind a planned Objective froze.
      const delivery = now && deliveryChange(state, now.config);
      if (delivery)
        return hold(
          `This Objective's plan is split for delivery.kind "${delivery.was}", which the configuration now sets to "${delivery.now}". To deliver it with "${delivery.now}", cancel it and queue it again. To keep "${delivery.was}", set delivery.kind back, restart the service and answer retry.`,
          [
            {
              answer: "retry",
              family: "retry",
              consequence: `Checks the configuration again, once delivery.kind is "${delivery.was}" and the service restarted.`,
            },
            "cancel",
          ],
        );
      // `switch` stands for one option per configured provider, this one's
      // included (a re-freeze); the engine names them in the question.
      const switching = Object.keys(freezable).some(
        (name) => name !== frozen.provider,
      );
      if (!live)
        return hold(
          `This Objective froze provider "${frozen.provider}", which the configuration no longer names. Restore the provider as it was, restart the service and answer retry; or cancel.`,
          [
            "switch",
            {
              answer: "retry",
              family: "retry",
              consequence:
                "Runs on the frozen provider again, once it is restored and the service restarted.",
            },
            "cancel",
          ],
        );
      const keys = frozenChanges(frozen.config, live.config);
      // `adopt` freezes exactly the configuration this question names
      // (engine.ts ADOPTS); a later change asks again.
      return {
        ...hold(
          `The configuration changed since this Objective froze it (${frozen.digest.slice(0, 12)}): ${keys.join(", ")}. \`adopt\` runs it on the configuration as it is now (${live.digest.slice(0, 12)}); or cancel. To keep the frozen values, restore them, restart the service and answer adopt.`,
          ["adopt", ...(switching ? ["switch" as const] : []), "cancel"],
        ),
        keep: { [ADOPTS]: live.digest },
      };
    },
  };
}
