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
  const config: CoreConfig = {
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
  };
  if (config.repository && config.repository !== repository)
    problems.push(
      `repository is ${config.repository}, but the command named ${repository}`,
    );
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return config;
}
