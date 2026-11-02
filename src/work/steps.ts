import { itemBranch } from "../delivery.js";
import { hold, type Outcome, type Step, type StepContext } from "../engine.js";
import { type CandidateSet, needsSelection, type Selection } from "../media.js";
import { currentPlan } from "../planning/plan.js";
import { rank, resourceGate, type ScheduleView } from "../planning/schedule.js";
import type { PlanningDeps } from "../planning/steps.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { type DeliveryUnit, unitOf, units } from "../planning/units.js";
import type { ReviewArtifact } from "../review/artifacts.js";
import { resultCriteria } from "../review/finder.js";
import type { ObjectiveBlock } from "../shown.js";
import type { ObjectiveState } from "../state.js";
import {
  type AppliedFormatter,
  type RegeneratedLockfile,
  validationDeadlineMs,
} from "../validate.js";
import type { HandoffNote } from "./collect.js";
import { fact, facts, itemsWith } from "./facts.js";
import { finalReviewStep, finalStep, reportStep } from "./finish.js";
import { mergeOf } from "./merged.js";
import { refusedOf, refusedResult } from "./refused.js";
import { ciStep, mergeStep, publishStep } from "./step-deliver.js";
import { settleStep } from "./step-qa.js";
import { reviewStep } from "./step-review.js";
import { selectStep } from "./step-select.js";
import { unvalidatedMerges, validateStep } from "./step-validate.js";
import { withKeep, workStep } from "./step-work.js";
import type { Worker } from "./worker.js";

export * from "./amend.js";
export * from "./finish.js";
export * from "./refused.js";
export * from "./repair-context.js";
export * from "./retire.js";
export * from "./shared.js";
export * from "./step-deliver.js";
export * from "./step-qa.js";
export * from "./step-review.js";
export * from "./step-select.js";
export * from "./step-validate.js";
export * from "./step-work.js";

export const MINUTE = 60_000;
/** What a kept validation finding holds of a failed run's output (`failureExcerpt`). */
export const KEPT_OUTPUT_CHARS = 128_000;

/** What execution needs from the installation, beyond planning. */
export interface BuildDeps extends PlanningDeps {
  /** The worker for an Objective's plan, on the item's execution profile when it has one. */
  worker(
    plan: Plan,
    blocks: readonly ObjectiveBlock[],
    profile?: string,
  ): Worker;
}

/*
 * One Work Item runs these steps, each saved when it finishes:
 *
 *   item:<id>:work      worker in the kept worktree, then collection
 *   item:<id>:select    the operator picks a candidate media set (media items only)
 *   item:<id>:validate  the item's commands on the exact commit
 *   item:<id>:review    the independent result review
 *   item:<id>:publish   push factory/<issue>/<id>, find or open the PR
 *   item:<id>:ci        the PR's checks on the exact head
 *   item:<id>:merge     merge with the head as guard
 *
 * A refused result is a `repair`: the item's steps from `work` on are
 * cleared and the worker continues in its kept worktree with the finding.
 * Facts that outlive repairs are kept in `state.kept` (work/facts.ts).
 *
 * With native-stack delivery, each chain of the plan (planning/units.ts) is
 * one unit: a layer above the bottom starts on the head published for the
 * layer below it, its PR targets that layer's branch, only the top layer
 * has a merge step (it merges the whole stack), and a repair of a layer
 * also clears every layer above it.
 */
export const PHASES = [
  "work",
  "select",
  "validate",
  "review",
  "publish",
  "ci",
  "merge",
] as const;
export type Phase = (typeof PHASES)[number];

export const stepKey = (id: string, phase: Phase) => `item:${id}:${phase}`;

/** A result rereview: the answer that checks a refused result again, unchanged. */
export const REVALIDATE = "revalidate";

export interface WorkResult {
  base: string;
  commit: string;
  tree: string;
  notes: HandoffNote[];
  validated?: { tree: string; commands: string[] };
  /** The candidate media sets captured; empty when the item has no select step. */
  sets: CandidateSet[];
}

export interface ValidateResult {
  tree: string;
  commands: string[];
  artifacts?: ReviewArtifact[];
  /**
   * Factory's commit on the candidate with the lockfile it resolved for a
   * dependency change (validate.ts): the commands ran on it, so later steps
   * review and publish it (`candidate`).
   */
  regenerated?: RegeneratedLockfile;
  /**
   * Factory's commit on the candidate with the repository's formatter's
   * output (validate.ts `applyFormatter`), on top of `regenerated` when
   * both are made: the commands ran on it, so later steps review and
   * publish it (`candidate`).
   */
  formatted?: AppliedFormatter;
}

export interface PublishResult {
  pr: number;
  head: string;
  merged: boolean;
}

/**
 * The steps after planning: the build, then final validation, final review
 * and the report. A `replan` answer to any of their questions is the
 * workflow's (workflow.ts `replan`): it never reaches the step.
 */
export function deliverySteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  return !built(state)
    ? buildSteps(state, deps)
    : !state.done.final
      ? [finalStep(currentPlan(state)!, deps)]
      : !state.done["final-review"]
        ? [finalReviewStep(deps)]
        : !state.done.report
          ? [reportStep(deps)]
          : [];
}

/**
 * The runnable item steps, most important first (planning/schedule.ts): each
 * unsettled item whose dependencies have merged, or a native-stack layer
 * whose layer below is published. An item's first step waits, without a
 * question, while an in-flight item holds a resource it declares.
 */
export function buildSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  const plan = currentPlan(state)!;
  const stacked = stackOf(plan, deps);
  if (stacked && "problem" in stacked) return [unitsProblem(stacked.problem)];
  // Each item's place in its native stack, worked out once per tick and
  // passed to its steps.
  const layerOf = (id: string) => multiLayer(stacked, id);
  const done = (id: string, phase: Phase) =>
    Boolean(state.done[stepKey(id, phase)]);
  const settled = (id: string) => Boolean(mergeOf(state, id));
  // Started: any step done or running, a kept base (the first work attempt
  // keeps it, and repairs keep it), a waiting retry or an open question.
  // Settled items drop out below.
  const started = startedItems(state);
  const view: ScheduleView = {
    settled,
    inFlight: (id) => started.has(id) && !settled(id),
  };
  // A native stack holds its layers' resources as one, from its bottom's
  // start until it merges, so its own lower layers never block the upper.
  const holder = (item: WorkItem): WorkItem => {
    const place = layerOf(item.id);
    if (!place) return item;
    const resources = [
      ...new Set(place.unit.items.flatMap((layer) => layer.resources ?? [])),
    ];
    return { ...(place.unit.items[0] as WorkItem), resources };
  };
  const holders = [
    ...new Map(
      plan.items.map((item) => [holder(item).id, holder(item)]),
    ).values(),
  ];
  const gate = resourceGate(
    { items: holders },
    plan.items
      .filter((item) => view.inFlight(item.id))
      .map((item) => holder(item).id),
  );
  const ready = (item: WorkItem): boolean => {
    const place = layerOf(item.id);
    const below = layerBelow(place);
    if (below) return done(below.id, "publish");
    const external = place
      ? place.unit.externalDependencies
      : item.dependencies;
    return (
      external.every(settled) &&
      (item.kind !== "aggregate" || (item.children ?? []).every(settled))
    );
  };
  const next = (item: WorkItem): Step | undefined => {
    const place = layerOf(item.id);
    const phase = phasesOf(item, place).find((p) => !done(item.id, p));
    // The top merges the stack once every layer's checks are ready.
    if (
      !phase ||
      (phase === "merge" &&
        place?.unit.items.some((layer) => !done(layer.id, "ci")))
    )
      return undefined;
    // Aggregates and QA deliver nothing: their merge step settles them.
    if (phase === "merge" && (item.kind ?? "work") !== "work")
      return settleStep(item);
    return itemStep(
      item,
      phase,
      deps,
      place,
      phase === "merge" && !place && unvalidatedMerges(state, plan, item.id),
      resultCriteria(plan, item).length,
    );
  };
  const steps: Step[] = [];
  const runnable = plan.items.filter(
    (item) => !settled(item.id) && ready(item),
  );
  for (const item of rank(plan, view, runnable)) {
    const step = next(item);
    if (!step) continue;
    // Any kind's first phase starts it, and so takes its resources.
    const first =
      step.key === stepKey(item.id, phasesOf(item, layerOf(item.id))[0]!);
    if (first && gate.admit(holder(item))) continue;
    steps.push(step);
  }
  return steps;
}

/**
 * The native-stack layers below item `id`, whose questions stop it too
 * (engine.ts Workflow `upstream`): `buildSteps` makes a layer runnable once
 * the layer below is published, before it settles, so a stack successor
 * waits on its predecessors' holds as a dependent waits on its
 * dependencies'.
 */
export function layersBelow(
  state: ObjectiveState,
  deps: BuildDeps,
  id: string,
): string[] {
  const plan = currentPlan(state);
  if (!plan) return [];
  const place = multiLayer(stackOf(plan, deps), id);
  return place
    ? place.unit.items.slice(0, place.layer).map((layer) => layer.id)
    : [];
}

/**
 * The Work Items that have started: any step done, running or waiting, a
 * kept base (the first work attempt keeps it, and repairs keep it), or an
 * open question. Placeholder facts a repair keeps for items above it
 * (`rebase`, `finished`, `onto`) don't count.
 */
export function startedItems(state: ObjectiveState): Set<string> {
  return new Set(
    [
      ...Object.keys(state.done),
      ...Object.keys(state.attempts),
      ...Object.keys(state.retries),
      ...state.holds.map((hold) => hold.step),
    ]
      .filter((key) => key.startsWith("item:"))
      .map((key) => key.split(":")[1]!)
      .concat(itemsWith(state, "base")),
  );
}

/** Whether every item has merged (or, for aggregates, completed). */
export function built(state: ObjectiveState): boolean {
  const plan = currentPlan(state);
  if (!plan) return false;
  return plan.items.every((item) => mergeOf(state, item.id));
}

/** An item's place in a native stack of more than one item: its unit and layer. */
export type StackPlace = { unit: DeliveryUnit; layer: number };

/** The plan's native stacks under this installation's delivery; none for regular PRs. */
export function stackOf(
  plan: Plan,
  deps: BuildDeps,
): ReturnType<typeof units> | undefined {
  return deps.config.delivery.kind === "native-stack" ? units(plan) : undefined;
}

/** The item's place when it is in a native stack of more than one item. */
export function multiLayer(
  stacked: ReturnType<typeof units> | undefined,
  id: string,
): StackPlace | undefined {
  if (!stacked || "problem" in stacked) return undefined;
  const found = unitOf(stacked.units, id);
  return found && found.unit.items.length > 1 ? found : undefined;
}

/**
 * The phases the item runs, in order: select only when it needs a media
 * selection, and merge only at the top of its native stack (the top merges
 * the whole stack). An aggregate only settles; read-only QA validates and
 * reviews the integrated result, then settles.
 */
export function phasesOf(
  item: WorkItem,
  place: StackPlace | undefined,
): Phase[] {
  if (item.kind === "aggregate") return ["merge"];
  if (item.kind === "qa") return ["validate", "review", "merge"];
  const top = !place || place.layer === place.unit.items.length - 1;
  return PHASES.filter(
    (p) => (p !== "select" || needsSelection(item)) && (p !== "merge" || top),
  );
}

/** The native-stack layer below the item, whose published head it builds on. */
export function layerBelow(
  place: StackPlace | undefined,
): WorkItem | undefined {
  return place?.unit.items[place.layer - 1];
}

/** The PR base of a native-stack layer above the bottom: the branch below it. */
export function baseBranch(
  issue: number,
  place: StackPlace | undefined,
): string | undefined {
  const below = layerBelow(place);
  return below ? itemBranch(issue, below.id) : undefined;
}

/** A plan that does not split into native stacks: only a new plan helps. */
export function unitsProblem(problem: string): Step {
  return {
    key: "build:units",
    deadlineMs: MINUTE,
    run: async () =>
      hold(
        `${problem}, so Factory can't deliver the plan as native stacks. Answer replan to plan again, or cancel.`,
        ["replan", "cancel"],
      ),
  };
}

/** The select step's result for an item, when it has one. */
export function selection(state: ObjectiveState) {
  return (id: string) =>
    state.done[stepKey(id, "select")] as Selection | undefined;
}

/**
 * The commit later steps use: the validate step's, which adds the
 * formatter's output or a lockfile Factory resolved (the formatting commit
 * is the later); else the selection's, which adds the chosen media; else
 * the work commit.
 */
export function candidate(state: ObjectiveState, id: string): string {
  const validated = state.done[stepKey(id, "validate")] as
    | ValidateResult
    | undefined;
  return (
    validated?.formatted?.commit ??
    validated?.regenerated?.commit ??
    selection(state)(id)?.commit ??
    (state.done[stepKey(id, "work")] as WorkResult).commit
  );
}

/**
 * Item step `phase`. `revalidates`: its merge step validates the candidate
 * again on Objective merges its validation didn't count
 * (step-validate.ts `validateBeforeMerge`), so it takes a CPU slot and
 * the commands' time, as the validate step does. `criteria`: how many
 * its result review judges (review/finder.ts `resultCriteria`), each at
 * most one proof.
 */
export function itemStep(
  item: WorkItem,
  phase: Phase,
  deps: BuildDeps,
  place: StackPlace | undefined,
  revalidates = false,
  criteria = item.acceptance.length,
): Step {
  const key = stepKey(item.id, phase);
  const run = {
    work: workStep,
    select: selectStep,
    validate: validateStep,
    review: reviewStep,
    publish: publishStep,
    ci: ciStep,
    merge: mergeStep,
  }[phase];
  return {
    key,
    ...(phase === "work"
      ? { resource: "worker" as const }
      : phase === "validate" || revalidates
        ? { resource: "cpu" as const }
        : phase === "review"
          ? { resource: "planner" as const }
          : {}),
    deadlineMs:
      phase === "work"
        ? 2 * 60 * MINUTE
        : phase === "ci"
          ? 10 * MINUTE
          : phase === "validate"
            ? validationDeadlineMs(
                item,
                commandTimeoutMs(deps),
                deps.config.validation.formatCommand !== undefined,
              ) +
              // A Work Item's confirmed refusals' repro commands
              // (repros.ts), one a criterion; its commands may run again
              // on the Objective's merges it was built without
              // (step-validate.ts, #2240).
              (item.kind === "qa"
                ? 0
                : item.acceptance.length * commandTimeoutMs(deps) +
                  (place ? 0 : item.validation.length * commandTimeoutMs(deps)))
            : phase === "review"
              ? // The finder, beside one warm install for the review's
                // checkout, then the proofs, at most one a criterion, one
                // after another at worst (the proof pool full): each a model
                // call, its commands and its refusal check (review/item.ts).
                45 * MINUTE +
                2 * commandTimeoutMs(deps) +
                15 * MINUTE +
                criteria *
                  (10 * MINUTE +
                    deps.config.review.proofSeconds * 1000 +
                    commandTimeoutMs(deps)) +
                (revalidates
                  ? validationDeadlineMs(item, commandTimeoutMs(deps))
                  : 0)
              : 45 * MINUTE +
                (revalidates
                  ? validationDeadlineMs(item, commandTimeoutMs(deps))
                  : 0),
    run: async (context) => {
      const outcome = await run(item, context, deps, place);
      return phase === "work"
        ? recheckMark(outcome, item, context, deps)
        : outcome;
    },
  };
}

/**
 * A work-step question while the kept refused result can't be checked
 * again as it is (gone, off the item's base, or its media selection
 * gone): the refused fact is marked `unrecheckable`, so `revalidatable`
 * stops offering `revalidate` for it, whichever question asks. The next
 * repair writes a new refused fact.
 */
export async function recheckMark(
  outcome: Outcome,
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const kept = refusedOf(state, item.id);
  const key = `item:${item.id}:refused`;
  if (
    outcome.kind !== "hold" ||
    !kept ||
    kept.unrecheckable ||
    (outcome.keep && key in outcome.keep)
  )
    return outcome;
  const base =
    (outcome.keep?.[`item:${item.id}:base`] as string | undefined) ??
    fact(state, "base", item.id);
  if (
    base &&
    (await refusedResult(state, item, deps.config.checkout, base, signal))
  )
    return outcome;
  return withKeep(
    outcome,
    facts({ refused: { ...kept, unrecheckable: true } }, item.id),
  );
}

/** Each validation command's limit, in ms. */
export function commandTimeoutMs(deps: BuildDeps): number {
  return deps.config.validation.commandTimeoutSeconds * 1000;
}
