/**
 * Autonomy allowances (CORE.md#Allowances): how much an Objective may
 * correct itself before Factory asks. Each comes from the configuration the
 * Objective froze (`autonomy.allowances`), plus what the operator granted
 * with `more`. Running out holds with the cause `failure`, and `more`
 * grants as much again. A replan starts every allowance afresh: it clears
 * the repairs and the kept facts these counts are made of.
 */
import type { ObjectiveState } from "./state.js";

export interface Allowances {
  /** Planning revision rounds before Factory asks; amendments charge it too. */
  planningRevisions: number;
  /** Repairs of Work Items' work, across the Objective. */
  implementationRepairs: number;
  /** Repairs of one repair path: one target step, such as a Work Item's work. */
  perPath: number;
  /** `revalidate` answers across the Objective (a refused result checked again, unchanged). */
  resultRereviews: number;
}

export type AllowanceName = keyof Allowances;

/** The old Factory's caps for repairs; four planning rounds, as the core plans. */
export const DEFAULT_ALLOWANCES: Allowances = {
  planningRevisions: 4,
  implementationRepairs: 6,
  perPath: 3,
  resultRereviews: 1,
};

/** The Objective's allowances as it froze them; the defaults without a frozen configuration. */
export function allowances(state: ObjectiveState): Allowances {
  const config = state.frozen?.config as
    | { autonomy?: { allowances?: Partial<Allowances> } }
    | undefined;
  return { ...DEFAULT_ALLOWANCES, ...config?.autonomy?.allowances };
}

/** What `more` grants: as much again, and never nothing. */
export function grant(state: ObjectiveState, name: AllowanceName): number {
  return Math.max(1, allowances(state)[name]);
}

/** The engine's repair grants (`state.kept`): `implementationRepairs`, and `perPath:<target>`. */
const GRANTED = "allowances:granted";

const granted = (state: ObjectiveState): Record<string, number> =>
  (state.kept[GRANTED] as Record<string, number> | undefined) ?? {};

/** A Work Item's work step: its repairs are implementation repairs. */
const IMPLEMENTATION = /^item:[^:]+:work$/;

export interface Usage {
  used: number;
  allowed: number;
}

/** Implementation repairs so far, and how many the Objective allows. */
export function implementationRepairs(state: ObjectiveState): Usage {
  let used = 0;
  for (const [target, repair] of Object.entries(state.repairs ?? {}))
    if (IMPLEMENTATION.test(target)) used += repair.count;
  return {
    used,
    allowed:
      allowances(state).implementationRepairs +
      (granted(state).implementationRepairs ?? 0),
  };
}

/** Repairs of each repair path so far, and how many each allows. */
export function perPath(state: ObjectiveState): Record<string, Usage> {
  const base = allowances(state).perPath;
  return Object.fromEntries(
    Object.entries(state.repairs ?? {}).map(([target, repair]) => [
      target,
      {
        used: repair.count,
        allowed: base + (granted(state)[`perPath:${target}`] ?? 0),
      },
    ]),
  );
}

/** The repair allowances step `key` has run out of, about to repair again. */
export type Overrun = ("perPath" | "implementationRepairs")[];

/**
 * The repair allowances step `key` overran: it was repaired more often
 * than its path allows, or it repairs a Work Item's work past the
 * Objective's allowance. Empty when it may run.
 */
export function overrun(state: ObjectiveState, key: string): Overrun {
  const count = state.repairs?.[key]?.count ?? 0;
  if (!count) return [];
  const over: Overrun = [];
  const path = perPath(state)[key];
  if (path && path.used > path.allowed) over.push("perPath");
  if (IMPLEMENTATION.test(key)) {
    const total = implementationRepairs(state);
    if (total.used > total.allowed) over.push("implementationRepairs");
  }
  return over;
}

/** The question an overrun asks: `more` grants as much again of each. */
export function overrunQuestion(
  state: ObjectiveState,
  key: string,
  over: Overrun,
): string {
  const past = over.map((name) => {
    const { allowed } =
      name === "perPath" ? perPath(state)[key]! : implementationRepairs(state);
    return `${name === "perPath" ? "its repair path's" : "the Objective's"} ${allowed} (autonomy.allowances.${name}; \`more\` allows ${grant(state, name)} more)`;
  });
  return `${key} needs another repair, past ${past.join(" and ")}. It still fails:\n\n${state.repairs[key]?.findings.at(-1) ?? ""}`;
}

/**
 * The engine's open overrun questions, by hold id (`state.kept`): their
 * `more` is the engine's, and any other `more` (a planning round, a
 * managed worker's spend, a rereview) is its step's.
 */
const ASKED = "allowances:asked";

/** Note that open hold `id` asks about an overrun; closed ones are forgotten. */
export function askedOverrun(state: ObjectiveState, id: string): void {
  const open = new Set(state.holds.map((hold) => hold.id));
  state.kept[ASKED] = [
    ...((state.kept[ASKED] as string[] | undefined) ?? []).filter(
      (asked) => open.has(asked) && asked !== id,
    ),
    id,
  ];
}

/** Whether hold `id` is an overrun question. */
export function isOverrun(state: ObjectiveState, id: string): boolean {
  return ((state.kept[ASKED] as string[] | undefined) ?? []).includes(id);
}

/** Grant as much again of each allowance `key` overran: the engine's `more`. */
export function grantOverrun(state: ObjectiveState, key: string): void {
  const grants = { ...granted(state) };
  for (const name of overrun(state, key)) {
    const at = name === "perPath" ? `perPath:${key}` : name;
    grants[at] = (grants[at] ?? 0) + grant(state, name);
  }
  state.kept[GRANTED] = grants;
}

/** A Work Item's result rereviews: used, granted, and a spent one asked about. */
export interface Rereviews {
  used: number;
  granted: number;
  /** Its `revalidate` found the allowance spent: `more` grants and revalidates. */
  asked?: true;
}

/**
 * Result rereviews across the Objective: each Work Item keeps its own
 * (work/facts.ts `rereviews`), so items rereviewed at once never write
 * the same fact.
 */
export function resultRereviews(state: ObjectiveState): Usage {
  let used = 0;
  let extra = 0;
  for (const [key, value] of Object.entries(state.kept ?? {}))
    if (/^item:[^:]+:rereviews$/.test(key)) {
      used += (value as Rereviews).used;
      extra += (value as Rereviews).granted;
    }
  return { used, allowed: allowances(state).resultRereviews + extra };
}
