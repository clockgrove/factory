/**
 * Named providers: each pairs a planner (plan and every review) with a
 * worker (the work step). The configuration holds any number of them and
 * names one `defaultProvider`; an Objective freezes its provider when it is
 * admitted (selection.ts). Checked once here, when configuration loads.
 */

import {
  type Check,
  isObject,
  names,
  object,
  oneOf,
  optional,
  type Retired,
  type Spec,
  section,
  text,
  whole,
} from "../checked.js";
import type { ClaudePlannerOptions } from "./claude.js";
import type { ClaudeWorkerConfig } from "./claude-worker.js";
import type { CodexEffort } from "./codex.js";
import {
  type ModelChoice,
  PLANNER_PHASES,
  type PlannerModels,
} from "./planner.js";

export const PLANNERS = ["codex", "claude", "copilot"] as const;
export type PlannerKind = (typeof PLANNERS)[number];

export const WORKERS = [
  "codex",
  "claude",
  "copilot",
  "openai-agents",
  "claude-managed-agents",
] as const;
export type WorkerKind = (typeof WORKERS)[number];

/** A worker's settings: `kind` plus the adapter's own fields, checked here. */
export type WorkerConfig =
  | ({ kind: "codex"; network: "off" | "host" } & Partial<
      ModelChoice<CodexEffort>
    >)
  /** The Claude worker settings given; the adapter's defaults fill the rest. */
  | { kind: "claude"; settings: Partial<ClaudeWorkerConfig> }
  | {
      kind: "copilot";
      model: string;
      effort: string;
      /** The tool ceiling; the SDK names grep `rg`. */
      tools: string[];
    }
  | {
      kind: "openai-agents";
      model: string;
      effort: "low" | "medium" | "high";
      containerSize: "small" | "medium" | "large";
      /** The controller variable (or service credential) holding the API key. */
      apiKeyEnv: string;
      timeoutSeconds: number;
      /** Hosted runs per Work Item before Factory asks (`more` grants as many again). */
      maxRuns: number;
      /** Tokens per Work Item, across runs, before Factory asks. */
      itemBudgetTokens?: number;
    }
  | {
      kind: "claude-managed-agents";
      agentId: string;
      agentVersion: number;
      environmentId: string;
      workspaceId: string;
      credentialEnv: string;
      /** A positive whole-cent list-cost ceiling per session. */
      budgetCents?: string;
      timeoutSeconds: number;
      /** Hosted runs per Work Item before Factory asks (`more` grants as many again). */
      maxRuns: number;
      /** List cost per Work Item, across runs, before Factory asks. */
      itemBudgetCents?: number;
    };

/** A planner with the model choices given; each adapter has defaults. */
export type ProviderConfig = { worker: WorkerConfig } & (
  | { planner: "claude"; models?: Partial<ClaudePlannerOptions> }
  | { planner: "codex"; models?: Partial<PlannerModels<CodexEffort>> }
  | { planner: "copilot"; models?: Partial<PlannerModels> }
);

export const CLAUDE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const CODEX_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const satisfies readonly CodexEffort[];
/** The Claude worker's tools: the SDK's file tools and Factory's Validate. */
export const CLAUDE_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Validate",
] as const;

export const COPILOT_TOOLS = [
  "view",
  "create",
  "edit",
  "apply_patch",
  "grep",
  "glob",
];

/** A hosted run's limit: well inside the work step's 2-hour deadline. */
export const MAX_HOSTED_SECONDS = 6000;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** What replaced each key of an earlier provider shape. */
const RETIRED_PROVIDER: Retired = {
  planning: "name the planner with planner and models",
  execution:
    "name the worker with worker; worker runs at once are the top-level execution.workers",
};

/** An environment variable's name. */
const envName: Check<string> = (value, path, problems) => {
  if (typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value))
    return value;
  problems.push(`${path} must be a name matching ^[A-Z_][A-Z0-9_]*$`);
  return "";
};

/**
 * The `providers` and `defaultProvider` settings, with problems appended.
 * Without `providers` there is one, `codex`, planning and working with
 * Codex.
 */
export function providersConfig(
  raw: Record<string, unknown>,
  problems: string[],
): { providers: Record<string, ProviderConfig>; defaultProvider: string } {
  const given: Record<string, unknown> =
    raw.providers === undefined
      ? { codex: { planner: "codex", worker: { kind: "codex" } } }
      : isObject(raw.providers)
        ? raw.providers
        : {};
  if (raw.providers !== undefined && !isObject(raw.providers))
    problems.push("providers must be an object");
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, value] of Object.entries(given)) {
    if (!NAME.test(name)) {
      problems.push(
        `providers.${name}: a provider name is lower-case letters, digits and dashes`,
      );
      continue;
    }
    const provider = providerConfig(value, `providers.${name}`, problems);
    if (provider) providers[name] = provider;
  }
  const names = Object.keys(given);
  if (!names.length) problems.push("providers must name at least one provider");
  const defaultProvider = optional(text())(
    raw.defaultProvider,
    "defaultProvider",
    problems,
  );
  if (defaultProvider !== undefined && !names.includes(defaultProvider))
    problems.push(
      `defaultProvider ${JSON.stringify(defaultProvider)} is not one of providers (${names.join(", ")})`,
    );
  return { providers, defaultProvider: defaultProvider ?? names[0] ?? "" };
}

function providerConfig(
  value: unknown,
  path: string,
  problems: string[],
): ProviderConfig | undefined {
  const before = problems.length;
  const provider = section(
    value,
    path,
    {
      planner: oneOf(PLANNERS, "codex"),
      models: (entry: unknown) => entry,
      worker: (entry: unknown) => entry,
    },
    problems,
    RETIRED_PROVIDER,
  );
  const { planner } = provider;
  const models =
    provider.models === undefined
      ? undefined
      : section(
          provider.models,
          `${path}.models`,
          modelsSpec(planner),
          problems,
        );
  const worker = workerConfig(
    provider.worker ?? { kind: planner },
    `${path}.worker`,
    problems,
  );
  if (!worker || problems.length !== before) return undefined;
  return {
    planner,
    ...(models ? { models } : {}),
    worker,
  } as ProviderConfig;
}

/**
 * Planner and reviewer model choices, with the keys and efforts of the
 * planner's kind: a choice names both model and effort.
 */
function modelsSpec(planner: PlannerKind): Spec {
  const efforts: readonly string[] | undefined =
    planner === "claude"
      ? CLAUDE_EFFORTS
      : planner === "codex"
        ? CODEX_EFFORTS
        : undefined;
  const effort = efforts ? oneOf(efforts) : text();
  const choice = optional(
    object({
      model: text(),
      effort,
      ...(planner === "codex"
        ? { serviceTier: optional(oneOf(["standard", "fast"] as const)) }
        : {}),
    }),
  );
  return {
    planner: choice,
    reviewer: choice,
    reviewEffort: optional(
      object(
        Object.fromEntries(
          PLANNER_PHASES.map((phase) => [phase, optional(effort)]),
        ),
      ),
    ),
    ...(planner === "claude" ? { maxOutputTokens: optional(whole(1)) } : {}),
  };
}

/** Hosted runs end before the work step's 2-hour deadline. */
const HOSTED = {
  timeoutSeconds: whole(1, 3600, MAX_HOSTED_SECONDS),
  maxRuns: whole(1, 3, 100),
};

/** Each worker kind's settings. */
const WORKER_SPECS: Record<WorkerKind, Spec> = {
  codex: {
    kind: text(),
    network: oneOf(["off", "host"] as const, "off"),
    model: optional(text()),
    effort: optional(oneOf(CODEX_EFFORTS)),
    serviceTier: optional(oneOf(["standard", "fast"] as const)),
  },
  claude: {
    kind: text(),
    model: optional(text()),
    effort: optional(oneOf(CLAUDE_EFFORTS)),
    permissionMode: optional(oneOf(["acceptEdits", "dontAsk"] as const)),
    settingSources: optional((value, path, problems) => {
      // Project and local settings are files in the worktree, which the
      // repository or the worker writes; the CLI runs their hooks on the
      // host, outside the sandbox.
      if (
        Array.isArray(value) &&
        value.some((source) => source === "project" || source === "local")
      ) {
        problems.push(
          `${path} may name only "user": project and local settings come from the worktree, and their hooks would run outside the sandbox`,
        );
        return [];
      }
      return names(["user"] as const, true)(value, path, problems);
    }),
    tools: optional(names(CLAUDE_TOOLS, false)),
    allowedTools: optional(names(CLAUDE_TOOLS, true)),
    maxTurns: optional(whole(1)),
  },
  copilot: {
    kind: text(),
    model: text("gpt-6.1-sol"),
    effort: text("medium"),
    tools: (value, path, problems) =>
      value === undefined
        ? COPILOT_TOOLS
        : names(COPILOT_TOOLS, false)(value, path, problems),
  },
  "openai-agents": {
    kind: text(),
    model: text(),
    effort: oneOf(["low", "medium", "high"] as const),
    containerSize: oneOf(["small", "medium", "large"] as const),
    apiKeyEnv: envName,
    ...HOSTED,
    itemBudgetTokens: optional(whole(1)),
  },
  "claude-managed-agents": {
    kind: text(),
    agentId: text(),
    agentVersion: whole(1),
    environmentId: text(),
    workspaceId: text(),
    credentialEnv: envName,
    budgetCents: optional((value, path, problems) => {
      if (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
        return value;
      problems.push(
        `${path} must be a positive whole-cent string, such as "500"`,
      );
      return "";
    }),
    ...HOSTED,
    itemBudgetCents: optional(whole(1)),
  },
};

function workerConfig(
  value: unknown,
  path: string,
  problems: string[],
): WorkerConfig | undefined {
  const kind = isObject(value) ? value.kind : undefined;
  if (!WORKERS.includes(kind as WorkerKind)) {
    problems.push(
      isObject(value)
        ? `${path}.kind must be one of ${WORKERS.join(", ")}`
        : `${path} must be an object`,
    );
    return undefined;
  }
  const before = problems.length;
  const { kind: _, ...settings } = section(
    value,
    path,
    WORKER_SPECS[kind as WorkerKind],
    problems,
  );
  if (kind === "claude") {
    const { tools, allowedTools } = settings as Partial<ClaudeWorkerConfig>;
    const offered: readonly string[] = tools ?? CLAUDE_TOOLS;
    if (allowedTools?.some((tool) => !offered.includes(tool)))
      problems.push(`${path}.allowedTools must be a subset of tools`);
  }
  if (problems.length !== before) return undefined;
  return (
    kind === "claude" ? { kind, settings } : { kind, ...settings }
  ) as WorkerConfig;
}
