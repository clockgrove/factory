import { isObject } from "../checked.js";
import type { CriterionDecision } from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import { fact, itemsWith } from "../work/facts.js";
import type { AmendmentProposal, AmendmentResult } from "./amendments.js";
import { namedBase } from "./facts.js";
import { ownsPath } from "./graph.js";
import type { ObjectiveInputs } from "./steps.js";
import type { Plan, WorkItem } from "./types.js";

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

/**
 * A plan's `ownedSince` for `items`, against the paths `before` (an owned
 * plan, reset.ts `ownedPlan`) ranked: a path one of those covers keeps the
 * earliest time of the ones that do (none for the plan's acceptance), and
 * every other path is owned from `at`. Beside each path, the ones it
 * covers that rank earlier keep their times, so what the Objective owned
 * before keeps its place however an amendment narrows or widens a path.
 * Undefined when no path has a time of its own.
 */
export function ownedSince(
  items: WorkItem[],
  at: string,
  before?: { plan: Plan; accepted: string },
): Record<string, string> | undefined {
  const had = before ? rankedPaths(before.plan, before.accepted) : [];
  const since = new Map<string, string>();
  const add = (path: string, time: string) => {
    const known = since.get(path);
    if (known === undefined || time < known) since.set(path, time);
  };
  for (const path of new Set(items.flatMap((item) => item.ownedPaths))) {
    const covering = had.filter((each) => ownsPath(path, [each.path]));
    const time = covering.length
      ? covering.reduce((a, b) => (b.since < a.since ? b : a)).since
      : at;
    if (time !== before?.accepted) add(path, time);
    for (const each of had)
      if (each.since < time && ownsPath(each.path, [path]))
        add(each.path, each.since);
  }
  return since.size ? Object.fromEntries(since) : undefined;
}

/**
 * Each path `plan`'s Objective owns, with when it came to own it: its
 * items' paths, by their `ownedSince` time or else `accepted`, and the
 * `ownedSince` paths none of them names but one covers: the paths it
 * owned before an amendment widened them (`ownedSince`).
 */
export function rankedPaths(
  plan: Plan,
  accepted: string,
): { path: string; since: string }[] {
  const paths = [...new Set(plan.items.flatMap((item) => item.ownedPaths))];
  const since = plan.ownedSince ?? {};
  const time = (path: string) =>
    Object.hasOwn(since, path) ? since[path]! : accepted;
  return [
    ...paths.map((path) => ({ path, since: time(path) })),
    ...Object.keys(since)
      .filter((path) => !paths.includes(path) && ownsPath(path, paths))
      .map((path) => ({ path, since: time(path) })),
  ];
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

/**
 * The delivery kind the Objective froze and the one `config` would freeze
 * instead, once it has a plan and they differ. Its plan is split by the
 * kind it froze (work/steps.ts `stackOf`), so from then on `adopt` and
 * `switch` never change it; delivering with the other kind takes a new run.
 */
export function deliveryChange(
  state: ObjectiveState,
  config: Record<string, unknown>,
): { was: string; now: string } | undefined {
  if (!state.frozen || !acceptedPlan(state)) return undefined;
  const kind = (of: Record<string, unknown>) =>
    String(isObject(of.delivery) ? of.delivery.kind : undefined);
  const [was, now] = [kind(state.frozen.config), kind(config)];
  return was === now ? undefined : { was, now };
}

/** The plan's items in dependency order: each after the items it depends on. */
export function dependencyOrder(plan: Plan): WorkItem[] {
  const ordered: WorkItem[] = [];
  const seen = new Set<string>();
  const visit = (item: WorkItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    for (const id of item.dependencies) {
      const dependency = plan.items.find((candidate) => candidate.id === id);
      if (dependency) visit(dependency);
    }
    ordered.push(item);
  };
  for (const item of plan.items) visit(item);
  return ordered;
}

const retiredOf = (plan: Plan) =>
  new Set((plan.retired ?? []).map((entry) => entry.command.trim()));

/**
 * Final validation's Work Item runs, for a plan with no final command
 * (the installation requires none): each work and QA item's own validation
 * commands, intact and in dependency order, less those the operator
 * retired, so QA runs on the merged default branch whenever the plan has a
 * command. A list identical to one already listed is left out. Empty when
 * the plan has final commands.
 */
export function fallbackRuns(plan: Plan): WorkItem[] {
  if (plan.finalCommands.length) return [];
  const retired = retiredOf(plan);
  const listed = new Set<string>();
  return dependencyOrder(plan).flatMap((item) => {
    if (!["work", "qa"].includes(item.kind ?? "work")) return [];
    const validation = item.validation.filter(
      (check) => !retired.has(check.command.trim()),
    );
    const key = JSON.stringify(validation.map((check) => check.command.trim()));
    if (!validation.length || listed.has(key)) return [];
    listed.add(key);
    return [{ ...item, validation }];
  });
}

/**
 * The checks final validation runs on the merged default branch, less
 * those the operator retired: the plan's final commands, then its QA
 * items' commands, each once, or, with no final command, the commands of
 * its Work Item runs (`fallbackRuns`) less those that compare with the
 * base, which those runs skip (work/finish.ts finalRuns).
 */
export function finalChecks(plan: Plan): string[] {
  if (!plan.finalCommands.length)
    return fallbackRuns(plan).flatMap((item) =>
      item.validation.flatMap(({ command }) =>
        namedBase(command, plan.base) ? [] : [command],
      ),
    );
  // The QA items' commands prove the Objective's command criteria: they
  // run again on the final head, after the required commands.
  const retired = retiredOf(plan);
  const seen = new Set<string>();
  const qa = dependencyOrder(plan).flatMap((item) =>
    item.kind === "qa" ? item.validation.map((check) => check.command) : [],
  );
  return [...plan.finalCommands, ...qa].filter((command) => {
    const key = command.trim();
    if (retired.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The retirements as lines for the report and status: command, reason,
 * who and when.
 */
export function retiredLines(
  plan: Plan,
  time: (at: string) => string = (at) => at,
): string[] {
  return (plan.retired ?? []).map(
    (entry) =>
      `command \`${entry.command}\` (final validation): retired by ${entry.by} at ${time(entry.at)}: ${entry.reason}`,
  );
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
