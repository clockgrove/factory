import { isObject } from "../checked.js";
import type { CriterionDecision } from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import { fact, itemsWith } from "../work/facts.js";
import type { AmendmentProposal, AmendmentResult } from "./amendments.js";
import { coverageCriterion } from "./graph.js";
import type { ObjectiveInputs } from "./steps.js";
import type { Plan, Retirement } from "./types.js";

/*
 * The one reader of the accepted plan. The plan step saves it at
 * `state.done.plan`; an accepted amendment saves its plan under its own key.
 * Everything else reads the plan the Objective runs now through
 * `currentPlan`, and what it was planned from through `acceptedInputs`.
 * The operator's retirements of final validation commands
 * (`retire-command <n>`) are kept apart, by the final step, and
 * `currentPlan` returns them in `retired`.
 */

/** When the plan was accepted, for the order of owned-path waits (service.ts). */
export const ACCEPTED_AT = "plan:acceptedAt";

/** An amendment's saved outcome (AmendmentResult). */
export const amendmentKey = (id: string) => `amend:${id}`;

/**
 * Where a proposal is kept (`state.kept`), one key each: the service
 * writes an operator's, and a step's outcome keeps a worker's, a blame's
 * or a replacement, so neither overwrites the other.
 */
export const proposalKey = (id: string) => `amend:${id}:proposal`;
const PROPOSAL = /^amend:[^:]+:proposal$/;

/** The `more` answers to amendment `id`'s allowance question, one per question (amendments.ts). */
export const grantsKey = (id: string) => `amend:${id}:grants`;

export interface AmendmentGrant {
  holdId: string;
  grant: number;
  by: string;
  at: string;
}

/** The planning revisions granted with `more` to the amendments of the plan accepted now. */
export function amendmentGrants(state: ObjectiveState): number {
  return proposalsOf(state)
    .flatMap((p) => (state.kept[grantsKey(p.id)] ?? []) as AmendmentGrant[])
    .reduce((total, granted) => total + granted.grant, 0);
}

/** The proposals against the plan accepted now, oldest first; a replan leaves earlier ones behind. */
export function proposalsOf(state: ObjectiveState): AmendmentProposal[] {
  const accepted = state.kept[ACCEPTED_AT];
  return Object.entries(state.kept)
    .filter(
      ([key, value]) =>
        PROPOSAL.test(key) && (value as AmendmentProposal).plan === accepted,
    )
    .map(([, value]) => value as AmendmentProposal)
    .sort((a, b) =>
      a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1,
    );
}

/**
 * The operator's criterion decisions (`accept <n>`, `refuse <n>`) under the
 * plan accepted now, oldest first. Each review step keeps its own (a
 * Work Item's, final review's); a replan leaves them behind.
 */
export function decisionsOf(state: ObjectiveState): CriterionDecision[] {
  const accepted = state.kept[ACCEPTED_AT];
  return [
    ...itemsWith(state, "decisions").flatMap(
      (id) => fact(state, "decisions", id) ?? [],
    ),
    ...(fact(state, "final-review:decisions") ?? []),
  ]
    .filter((entry) => entry.plan === accepted)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The plan the Objective runs now, with the final validation commands the
 * operator retired from it.
 */
export function currentPlan(state: ObjectiveState): Plan | undefined {
  const plan = acceptedPlan(state);
  if (!plan) return undefined;
  const accepted = state.kept[ACCEPTED_AT];
  const retired = (fact(state, "final:retired") ?? []).filter(
    (entry) => entry.plan === accepted,
  );
  return retired.length ? { ...plan, retired } : plan;
}

/** The latest accepted amendment's plan, else the accepted plan, as saved. */
export function acceptedPlan(state: ObjectiveState): Plan | undefined {
  const proposals = proposalsOf(state);
  for (let at = proposals.length - 1; at >= 0; at--) {
    const result = state.done[amendmentKey(proposals[at]!.id)] as
      | AmendmentResult
      | undefined;
    if (result?.plan) return result.plan;
  }
  return state.done.plan as Plan | undefined;
}

/**
 * The execution profiles the current plan's items run on that a frozen
 * `config` doesn't name: none before a plan exists, or when the plan uses
 * none. Its items would fail on that configuration (selection.ts).
 */
export function profilesLacking(
  state: ObjectiveState,
  config: Record<string, unknown>,
): string[] {
  const execution = config.execution;
  const profiles =
    isObject(execution) && isObject(execution.profiles)
      ? execution.profiles
      : {};
  const plan = currentPlan(state);
  const used = new Set(
    (plan?.items ?? []).flatMap((item) =>
      item.executionProfile ? [item.executionProfile.id] : [],
    ),
  );
  return [...used].filter((id) => !Object.hasOwn(profiles, id)).sort();
}

/** The final validation commands the operator retired. */
export function retiredCommands(plan: Plan): Set<string> {
  return new Set((plan.retired ?? []).map((entry) => entry.command));
}

/**
 * The Objective criteria retired command `entry` proved, by the
 * criterion's command. Review judges them on other evidence now.
 */
export function provedBy(plan: Plan, entry: Retirement): string[] {
  return [
    ...new Set(
      plan.coverage
        .filter((coverage) => coverage.source.command === entry.command)
        .map(coverageCriterion),
    ),
  ];
}

/**
 * The retirements as lines for the report and status: command, reason,
 * who and when, and the obligations it proved, which review judges now.
 */
export function retiredLines(
  plan: Plan,
  time: (at: string) => string = (at) => at,
): string[] {
  return (plan.retired ?? []).map((entry) => {
    const proved = provedBy(plan, entry);
    return `command \`${entry.command}\` (final validation): retired by ${entry.by} at ${time(entry.at)}: ${entry.reason}${proved.length ? `. Judged by review instead: ${proved.join("; ")}` : ""}`;
  });
}

/** The current planning generation and round, from the saved decisions. */
export function position(state: ObjectiveState): { g: number; n: number } {
  let g = 1;
  let n = 1;
  for (;;) {
    const decided = state.done[`decide:${g}:${n}`] as
      | { accept?: true; replan?: true }
      | undefined;
    if (!decided || decided.accept) return { g, n };
    if (decided.replan) {
      g += 1;
      n = 1;
    } else n += 1;
  }
}

/** The issue and base generation `g` read: its first round's, else the check step's. */
export function generationInputs(
  state: ObjectiveState,
  g: number,
): ObjectiveInputs {
  if (g > 1)
    return (state.done[`plan:${g}:1`] as { inputs?: ObjectiveInputs }).inputs!;
  return state.done.check as ObjectiveInputs;
}

/** The Objective as the accepted generation read it: its text, base and selectors. */
export function acceptedInputs(state: ObjectiveState): ObjectiveInputs {
  return generationInputs(state, position(state).g);
}
