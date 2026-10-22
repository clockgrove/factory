import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The installation's configuration, checked once when it's loaded. */
export interface CoreConfig {
  repository: string;
  /** A clone of the target, owned by Factory. */
  checkout: string;
  queue: {
    /** GitHub Project node id (PVT_...). */
    projectId: string;
    /** Single-select field Factory reads for "queued" and writes for progress. */
    field: string;
    /** Number field that orders the queue; ties go to the lower issue number. */
    orderField: string;
    /** Option names for each status. "queued" is what the operator sets. */
    options: Record<QueueOption, string>;
    pollSeconds: number;
  };
  planning: {
    /** The provider that plans and reviews. */
    provider: "codex" | "claude";
    /** Optional model choices; each adapter has defaults. */
    models?: Record<string, unknown>;
    /** Revision rounds before Factory asks; `more` grants two more. */
    revisions: number;
    /** A curated playbook file in the target, read at the base. */
    playbook: string;
  };
  finalValidation: {
    /** Commands every Objective's result must pass. */
    requiredCommands: string[];
    /** Commands that need network and run only in CI. */
    ciOnlyCommands: string[];
  };
}

export type QueueOption =
  | "queued"
  | "planning"
  | "building"
  | "holding"
  | "done"
  | "failed"
  | "cancelled";

const DEFAULT_OPTIONS: Record<QueueOption, string> = {
  queued: "Queued",
  planning: "Planning",
  building: "Building",
  holding: "Needs you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function configPath(repository: string): string {
  return (
    process.env.FACTORY_CONFIG ??
    join(
      homedir(),
      ".config",
      "factory",
      `${repository.replace("/", "__")}.json`,
    )
  );
}

/** Load and check the configuration. Throws one message naming every problem. */
export function loadConfig(repository: string): CoreConfig {
  const path = configPath(repository);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Can't read ${path}: ${String(error)}`);
  }
  const problems: string[] = [];
  const text = (value: unknown, name: string): string => {
    if (typeof value === "string" && value.trim()) return value;
    problems.push(`${name} must be a non-empty string`);
    return "";
  };
  const queue = (raw.queue ?? {}) as Record<string, unknown>;
  const options = {
    ...DEFAULT_OPTIONS,
    ...((queue.options ?? {}) as Partial<Record<QueueOption, string>>),
  };
  const config = {
    repository: text(raw.repository, "repository"),
    checkout: text(raw.checkout, "checkout"),
    queue: {
      projectId: text(queue.projectId, "queue.projectId"),
      field:
        queue.field === undefined
          ? "Factory"
          : text(queue.field, "queue.field"),
      orderField:
        queue.orderField === undefined
          ? "Factory order"
          : text(queue.orderField, "queue.orderField"),
      options,
      pollSeconds:
        typeof queue.pollSeconds === "number" && queue.pollSeconds >= 5
          ? queue.pollSeconds
          : 30,
    },
  } as CoreConfig;
  const planning = (raw.planning ?? {}) as Record<string, unknown>;
  const provider = planning.provider ?? "codex";
  if (provider !== "codex" && provider !== "claude")
    problems.push('planning.provider must be "codex" or "claude"');
  const final = (raw.finalValidation ?? {}) as Record<string, unknown>;
  const list = (value: unknown, name: string): string[] => {
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((v) => typeof v === "string"))
      return value as string[];
    problems.push(`${name} must be a list of strings`);
    return [];
  };
  config.planning = {
    provider: provider === "claude" ? "claude" : "codex",
    ...(planning.models && typeof planning.models === "object"
      ? { models: planning.models as Record<string, unknown> }
      : {}),
    revisions:
      typeof planning.revisions === "number" && planning.revisions >= 0
        ? planning.revisions
        : 4,
    playbook:
      typeof planning.playbook === "string"
        ? planning.playbook
        : ".factory/playbook.md",
  };
  config.finalValidation = {
    requiredCommands: list(
      final.requiredCommands,
      "finalValidation.requiredCommands",
    ),
    ciOnlyCommands: list(
      final.ciOnlyCommands,
      "finalValidation.ciOnlyCommands",
    ),
  };
  if (config.repository && config.repository !== repository)
    problems.push(
      `repository is ${config.repository}, but the command named ${repository}`,
    );
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return config;
}
