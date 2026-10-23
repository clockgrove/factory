/**
 * Named providers: each pairs a planner (plan and every review) with a
 * worker (the work step). The configuration holds any number of them and
 * names one `defaultProvider`; an Objective freezes its provider when it is
 * admitted (selection.ts). Checked once here, when configuration loads.
 */

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
  | { kind: "codex"; network: "off" | "host" }
  /** Claude worker settings (model, effort, maxTurns, tools, allowedTools, permissionMode). */
  | { kind: "claude"; settings: Record<string, unknown> }
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
    };

export interface ProviderConfig {
  planner: PlannerKind;
  /** Planner and reviewer model choices; each adapter has defaults. */
  models?: Record<string, unknown>;
  worker: WorkerConfig;
}

export const COPILOT_TOOLS = [
  "view",
  "create",
  "edit",
  "apply_patch",
  "grep",
  "glob",
];

/** Settings that moved into `providers`. */
const MOVED = [
  ["planning", "provider"],
  ["planning", "models"],
  ["execution", "workerProvider"],
  ["execution", "codexNetwork"],
  ["execution", "claudeWorker"],
] as const;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;

type Fields = Record<string, unknown>;

/**
 * The `providers` and `defaultProvider` settings, with problems appended.
 * Without `providers` there is one, `codex`, planning and working with
 * Codex.
 */
export function providersConfig(
  raw: Fields,
  problems: string[],
): { providers: Record<string, ProviderConfig>; defaultProvider: string } {
  for (const [section, name] of MOVED)
    if ((raw[section] as Fields | undefined)?.[name] !== undefined)
      problems.push(
        `${section}.${name} is not a setting: name the planner and worker under providers.<name>`,
      );
  if (raw.providers === undefined)
    return {
      providers: {
        codex: { planner: "codex", worker: { kind: "codex", network: "off" } },
      },
      defaultProvider: text(raw.defaultProvider, "codex"),
    };
  const providers: Record<string, ProviderConfig> = {};
  const all = object(raw.providers, "providers", problems);
  for (const [name, value] of Object.entries(all ?? {})) {
    if (!NAME.test(name)) {
      problems.push(
        `providers.${name}: a provider name is lower-case letters, digits and dashes`,
      );
      continue;
    }
    const provider = providerConfig(value, `providers.${name}`, problems);
    if (provider) providers[name] = provider;
  }
  const names = Object.keys(all ?? {});
  if (all && names.length === 0)
    problems.push("providers must name at least one provider");
  const defaultProvider = text(raw.defaultProvider, names[0] ?? "");
  if (names.length && !names.includes(defaultProvider))
    problems.push(
      `defaultProvider ${JSON.stringify(defaultProvider)} is not one of providers (${names.join(", ")})`,
    );
  return { providers, defaultProvider };
}

function providerConfig(
  value: unknown,
  path: string,
  problems: string[],
): ProviderConfig | undefined {
  const provider = object(value, path, problems);
  if (!provider) return undefined;
  known(provider, ["planner", "models", "worker"], path, problems);
  const planner = provider.planner ?? "codex";
  if (!PLANNERS.includes(planner as PlannerKind)) {
    problems.push(`${path}.planner must be one of ${PLANNERS.join(", ")}`);
    return undefined;
  }
  const models =
    provider.models === undefined
      ? undefined
      : object(provider.models, `${path}.models`, problems);
  const worker = workerConfig(
    provider.worker ?? { kind: planner },
    `${path}.worker`,
    problems,
  );
  if (!worker) return undefined;
  return {
    planner: planner as PlannerKind,
    ...(models ? { models } : {}),
    worker,
  };
}

function workerConfig(
  value: unknown,
  path: string,
  problems: string[],
): WorkerConfig | undefined {
  const worker = object(value, path, problems);
  if (!worker) return undefined;
  const before = problems.length;
  const string = (name: string, pattern?: RegExp): string => {
    const entry = worker[name];
    if (
      typeof entry === "string" &&
      entry.trim() &&
      pattern?.test(entry) !== false
    )
      return entry;
    problems.push(
      `${path}.${name} must be ${pattern ? `a name matching ${pattern.source}` : "a non-empty string"}`,
    );
    return "";
  };
  const oneOf = <T extends string>(
    name: string,
    values: readonly T[],
    fallback?: T,
  ): T => {
    const entry = worker[name] ?? fallback;
    if (values.includes(entry as T)) return entry as T;
    problems.push(`${path}.${name} must be one of ${values.join(", ")}`);
    return values[0]!;
  };
  const seconds = (name: string, fallback: number): number => {
    const entry = worker[name] ?? fallback;
    if (Number.isSafeInteger(entry) && (entry as number) > 0)
      return entry as number;
    problems.push(`${path}.${name} must be a positive whole number of seconds`);
    return fallback;
  };
  let config: WorkerConfig;
  switch (worker.kind) {
    case "codex":
      known(worker, ["kind", "network"], path, problems);
      config = {
        kind: "codex",
        network: oneOf("network", ["off", "host"], "off"),
      };
      break;
    case "claude": {
      const { kind: _kind, ...settings } = worker;
      config = { kind: "claude", settings };
      break;
    }
    case "copilot": {
      known(worker, ["kind", "model", "effort", "tools"], path, problems);
      const tools = worker.tools ?? COPILOT_TOOLS;
      if (
        !Array.isArray(tools) ||
        !tools.length ||
        tools.some((tool) => !COPILOT_TOOLS.includes(tool as string)) ||
        new Set(tools).size !== tools.length
      )
        problems.push(
          `${path}.tools must be distinct names from ${COPILOT_TOOLS.join(", ")}`,
        );
      config = {
        kind: "copilot",
        model: worker.model === undefined ? "gpt-6.1-sol" : string("model"),
        effort: worker.effort === undefined ? "medium" : string("effort"),
        tools: Array.isArray(tools) ? (tools as string[]) : COPILOT_TOOLS,
      };
      break;
    }
    case "openai-agents":
      known(
        worker,
        [
          "kind",
          "model",
          "effort",
          "containerSize",
          "apiKeyEnv",
          "timeoutSeconds",
        ],
        path,
        problems,
      );
      config = {
        kind: "openai-agents",
        model: string("model"),
        effort: oneOf("effort", ["low", "medium", "high"]),
        containerSize: oneOf("containerSize", ["small", "medium", "large"]),
        apiKeyEnv: string("apiKeyEnv", ENV),
        timeoutSeconds: seconds("timeoutSeconds", 3600),
      };
      break;
    case "claude-managed-agents": {
      known(
        worker,
        [
          "kind",
          "agentId",
          "agentVersion",
          "environmentId",
          "workspaceId",
          "credentialEnv",
          "budgetCents",
          "timeoutSeconds",
        ],
        path,
        problems,
      );
      if (
        !Number.isSafeInteger(worker.agentVersion) ||
        (worker.agentVersion as number) < 1
      )
        problems.push(`${path}.agentVersion must pin a positive agent version`);
      const budget = worker.budgetCents;
      if (
        budget !== undefined &&
        (typeof budget !== "string" || !/^[1-9][0-9]*$/.test(budget))
      )
        problems.push(
          `${path}.budgetCents must be a positive whole-cent string, such as "500"`,
        );
      config = {
        kind: "claude-managed-agents",
        agentId: string("agentId"),
        agentVersion: worker.agentVersion as number,
        environmentId: string("environmentId"),
        workspaceId: string("workspaceId"),
        credentialEnv: string("credentialEnv", ENV),
        ...(typeof budget === "string" ? { budgetCents: budget } : {}),
        timeoutSeconds: seconds("timeoutSeconds", 3600),
      };
      break;
    }
    default:
      problems.push(`${path}.kind must be one of ${WORKERS.join(", ")}`);
      return undefined;
  }
  return problems.length === before ? config : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function object(
  value: unknown,
  path: string,
  problems: string[],
): Fields | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Fields;
  problems.push(`${path} must be an object`);
  return undefined;
}

function known(
  value: Fields,
  names: string[],
  path: string,
  problems: string[],
): void {
  for (const key of Object.keys(value))
    if (!names.includes(key)) problems.push(`${path}.${key} is not a setting`);
}
