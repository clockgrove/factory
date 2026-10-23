/**
 * Knowledge settings: where the curated store lives and the optional
 * `planningContext` section that admits adaptive planning context. The
 * section is read from the installation's configuration file and checked
 * once, when the service or a `dream` command starts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../config.js";

/** Bounds on the context one planning call is given and on Dream's input. */
export interface ContextBounds {
  /** Planner-requested lookup rounds (planner lookups are not on the core yet). */
  maxRounds: number;
  /** Requests per planner lookup round (planner lookups are not on the core yet). */
  maxRequestsPerRound: number;
  /** Memory records supplied at most. */
  maxResults: number;
  /** UTF-8 bytes of supplied memory, or of Dream's input packet. */
  maxBytes: number;
  /** Time spent selecting memory or Dream input. */
  maxElapsedMs: number;
  /** Provider calls planner lookups may add (planner lookups are not on the core yet). */
  maxProviderCalls: number;
}

export const DEFAULT_BOUNDS: Readonly<ContextBounds> = Object.freeze({
  maxRounds: 4,
  maxRequestsPerRound: 8,
  maxResults: 64,
  maxBytes: 262_144,
  maxElapsedMs: 30_000,
  maxProviderCalls: 5,
});

/** The admitted adaptive planning context. Absent: Adaptive workflow Objectives are refused. */
export interface PlanningContext {
  bounds: ContextBounds;
  /** Literal repository files, or directory prefixes ending in a slash. */
  selectors: string[];
  /** Supply retained repository memory to adaptive planning. */
  memory: boolean;
}

export interface KnowledgeSettings {
  repository: string;
  /** The installation's state directory; the store is `knowledge/` under it. */
  root: string;
  /** The target checkout: Dream drafts must be outside it. */
  checkout: string;
  planningContext?: PlanningContext;
  /** Secret values Dream input is redacted of. */
  secrets: string[];
}

let configured: KnowledgeSettings | undefined;

/** Set once by `serve`; planning and the check read it. */
export function configureKnowledge(settings: KnowledgeSettings): void {
  configured = settings;
}

/** The service's knowledge settings; undefined without configuration. */
export function knowledgeSettings(): KnowledgeSettings | undefined {
  return configured;
}

export function knowledgeDir(root: string): string {
  return join(root, "knowledge");
}

/**
 * The settings for `repository`, with its `planningContext` checked. A
 * malformed section throws, naming each problem, like the rest of the
 * configuration.
 */
export function loadKnowledgeSettings(input: {
  repository: string;
  root: string;
  checkout: string;
  allowedSecretNames: readonly string[];
}): KnowledgeSettings {
  const path = configPath(input.repository);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const problems: string[] = [];
  const planningContext = parsePlanningContext(raw.planningContext, problems);
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return {
    repository: input.repository,
    root: input.root,
    checkout: input.checkout,
    ...(planningContext ? { planningContext } : {}),
    secrets: input.allowedSecretNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value)),
  };
}

function parsePlanningContext(
  value: unknown,
  problems: string[],
): PlanningContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push("planningContext must be an object");
    return undefined;
  }
  const section = value as Record<string, unknown>;
  for (const key of Object.keys(section))
    if (!["enabled", "bounds", "selectors", "memory"].includes(key))
      problems.push(`planningContext.${key} is not a setting`);
  if (section.enabled !== true)
    problems.push(
      "planningContext.enabled must be true; leave the section out to refuse Adaptive workflow Objectives",
    );
  const bounds = section.bounds as Record<string, unknown> | undefined;
  const names = Object.keys(DEFAULT_BOUNDS);
  if (
    !bounds ||
    typeof bounds !== "object" ||
    Object.keys(bounds).sort().join() !== [...names].sort().join() ||
    names.some(
      (name) => !Number.isSafeInteger(bounds[name]) || Number(bounds[name]) < 1,
    )
  )
    problems.push(
      `planningContext.bounds needs exactly ${names.join(", ")}, each a whole number of at least 1`,
    );
  const selectors = section.selectors;
  if (
    !Array.isArray(selectors) ||
    !selectors.length ||
    selectors.length > 64 ||
    new Set(selectors).size !== selectors.length ||
    !selectors.every(literalSelector)
  )
    problems.push(
      "planningContext.selectors needs 1–64 distinct literal relative files or directory prefixes ending in /",
    );
  if (section.memory !== undefined && typeof section.memory !== "boolean")
    problems.push("planningContext.memory must be a boolean");
  return {
    bounds: bounds as unknown as ContextBounds,
    selectors: (selectors ?? []) as string[],
    memory: section.memory === true,
  };
}

function literalSelector(selector: unknown): boolean {
  return (
    typeof selector === "string" &&
    selector.length > 0 &&
    selector === selector.trim() &&
    !selector.startsWith("/") &&
    !selector.includes("\\") &&
    selector
      .split("/")
      .every(
        (part, index, parts) =>
          part !== "." &&
          part !== ".." &&
          part !== ".git" &&
          (part !== "" || index === parts.length - 1),
      ) &&
    [...selector].every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127 && !"*?[]{}".includes(character);
    })
  );
}

/** `path` is one of the selectors, or under a directory selector. */
export function admitted(path: string, selectors: readonly string[]): boolean {
  return selectors.some(
    (selector) =>
      path === selector ||
      (selector.endsWith("/") && path.startsWith(selector)),
  );
}
