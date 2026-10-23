/**
 * Knowledge settings: where the curated store lives and the optional
 * `planning.context` section that admits adaptive planning context,
 * checked with the rest of the configuration (config.ts loadConfig).
 */
import { join } from "node:path";
import { type Check, flag, object, section, whole } from "../checked.js";

/** Bounds on the context one planning call is given and on Dream's input; a bound left out takes its default. */
export interface ContextBounds {
  /** Planner-requested lookup rounds per planner step (planning/lookup.ts). */
  maxRounds: number;
  /** Requests per planner lookup round; the rest are refused by name. */
  maxRequestsPerRound: number;
  /** Memory records supplied at most. */
  maxResults: number;
  /** UTF-8 bytes of supplied memory, of one planner step's lookup answers, or of Dream's input packet. */
  maxBytes: number;
  /** Time spent selecting memory or Dream input. */
  maxElapsedMs: number;
  /** Provider calls planner lookups may add: each round is one, so it caps the rounds too. */
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

/** A Dream model call's deadline; a call still submitted past it was interrupted. */
export const DREAM_DEADLINE_MS = 45 * 60_000;

export function knowledgeDir(root: string): string {
  return join(root, "knowledge");
}

/** The `planning.context` section: its presence admits Adaptive workflow Objectives. */
export const planningContext: Check<PlanningContext> = (
  value,
  path,
  problems,
) =>
  section(
    value,
    path,
    {
      bounds: object(
        Object.fromEntries(
          Object.entries(DEFAULT_BOUNDS).map(([name, bound]) => [
            name,
            whole(1, bound),
          ]),
        ) as Record<keyof ContextBounds, Check<number>>,
      ),
      selectors: (selectors: unknown, at: string, found: string[]) => {
        if (
          Array.isArray(selectors) &&
          selectors.length &&
          selectors.length <= 64 &&
          new Set(selectors).size === selectors.length &&
          selectors.every(literalSelector)
        )
          return selectors as string[];
        found.push(
          `${at} needs 1–64 distinct literal relative files or directory prefixes ending in /`,
        );
        return [];
      },
      memory: flag(false),
    },
    problems,
    { enabled: "the section's presence turns planning context on" },
  );

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
