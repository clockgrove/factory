/**
 * Autonomy allowances (CORE.md#Allowances): how much an Objective may
 * correct itself before Factory asks. Each comes from the configuration the
 * Objective froze (`autonomy.allowances`), plus what the operator granted
 * with `more`. Running out holds with the cause `failure`, and `more`
 * grants as much again. A replan starts every allowance afresh: it clears
 * the repairs and the kept facts these counts are made of.
 */
import type { ReviewArtifactSelector } from "./review/artifacts.js";
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

/**
 * Mechanical merge-conflict repairs per target (`state.kept`): they count
 * against `perPath`, which bounds a conflict loop, but never against
 * `implementationRepairs`, which counts wrong results, as the old Factory
 * charged only those.
 */
const CONFLICTS = "allowances:conflicts";

const granted = (state: ObjectiveState): Record<string, number> =>
  (state.kept[GRANTED] as Record<string, number> | undefined) ?? {};

/** A Work Item's work step: its repairs are implementation repairs. */
const IMPLEMENTATION = /^item:[^:]+:work$/;

/**
 * The repairs of a path that count: a repair whose failure was blamed on a
 * predecessor is free (engine.ts Outcome `free`); the predecessor's own
 * repair counts.
 */
const charged = (repair: ObjectiveState["repairs"][string]): number =>
  repair.count - (repair.free?.length ?? 0);

export interface Usage {
  used: number;
  allowed: number;
}

/** Implementation repairs so far, and how many the Objective allows. */
export function implementationRepairs(state: ObjectiveState): Usage {
  const conflicts =
    (state.kept[CONFLICTS] as Record<string, number> | undefined) ?? {};
  let used = 0;
  for (const [target, repair] of Object.entries(state.repairs ?? {}))
    if (IMPLEMENTATION.test(target))
      used += charged(repair) - (conflicts[target] ?? 0);
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
        used: charged(repair),
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
  const repair = state.repairs?.[key];
  if (!repair || !charged(repair)) return [];
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
 * The engine's open allowance questions, by hold id (`state.kept`): what
 * their `more` grants. Any other `more` (a planning round, a managed
 * worker's spend) is its step's.
 */
const ASKED = "allowances:asked";

export type Asked = "repairs" | "rereviews";

/**
 * The `--review-artifacts` a `revalidate` past the allowance gave, by the
 * id of the rereviews question it asked instead: its `more` reuses them.
 */
const CAPTURES = "allowances:captures";

/**
 * Note that open hold `id` asks for more of `kind`, with the rereview's
 * `captures` when it gave them; closed ones are forgotten.
 */
export function asked(
  state: ObjectiveState,
  id: string,
  kind: Asked,
  captures?: readonly ReviewArtifactSelector[],
): void {
  const open = new Set(state.holds.map((hold) => hold.id));
  const live = <T>(name: string): Record<string, T> =>
    Object.fromEntries(
      Object.entries(
        (state.kept[name] as Record<string, T> | undefined) ?? {},
      ).filter(([held]) => open.has(held) && held !== id),
    );
  state.kept[ASKED] = { ...live<Asked>(ASKED), [id]: kind };
  const kept = {
    ...live<ReviewArtifactSelector[]>(CAPTURES),
    ...(captures ? { [id]: [...captures] } : {}),
  };
  if (Object.keys(kept).length) state.kept[CAPTURES] = kept;
  else delete state.kept[CAPTURES];
}

/** The `--review-artifacts` rereviews question `id` keeps for its `more`. */
export function askedCaptures(
  state: ObjectiveState,
  id: string,
): ReviewArtifactSelector[] | undefined {
  return (
    state.kept[CAPTURES] as Record<string, ReviewArtifactSelector[]> | undefined
  )?.[id];
}

/** What hold `id`'s `more` grants, if it is the engine's. */
export function askedFor(state: ObjectiveState, id: string): Asked | undefined {
  return (state.kept[ASKED] as Record<string, Asked> | undefined)?.[id];
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

/**
 * Result rereviews (`revalidate` answers) charged across the Objective
 * (`state.kept`). The engine charges each when the answer lands, against
 * the live state, so two at once can't both pass the allowance.
 */
const REREVIEWS = "allowances:rereviews";

export function resultRereviews(state: ObjectiveState): Usage {
  const used = (state.kept[REREVIEWS] as number | undefined) ?? 0;
  return {
    used,
    allowed:
      allowances(state).resultRereviews + (granted(state).resultRereviews ?? 0),
  };
}

/** Charge one result rereview; false, and nothing charged, past the allowance. */
export function chargeRereview(state: ObjectiveState): boolean {
  const { used, allowed } = resultRereviews(state);
  if (used >= allowed) return false;
  state.kept[REREVIEWS] = used + 1;
  return true;
}

/** The engine's `more` to a spent rereview: as much again. */
export function grantRereviews(state: ObjectiveState): void {
  const grants = { ...granted(state) };
  grants.resultRereviews =
    (grants.resultRereviews ?? 0) + grant(state, "resultRereviews");
  state.kept[GRANTED] = grants;
}

/** The question a `revalidate` past the allowance asks instead. */
export function rereviewQuestion(state: ObjectiveState, key: string): string {
  const { allowed } = resultRereviews(state);
  return `${key}'s refused result can't be checked again: this Objective has used its ${allowed} result rereview${allowed === 1 ? "" : "s"} (autonomy.allowances.resultRereviews). \`more\` allows ${grant(state, "resultRereviews")} more and checks it again.`;
}

export function countConflict(state: ObjectiveState, target: string): void {
  const kept =
    (state.kept[CONFLICTS] as Record<string, number> | undefined) ?? {};
  state.kept[CONFLICTS] = { ...kept, [target]: (kept[target] ?? 0) + 1 };
}
