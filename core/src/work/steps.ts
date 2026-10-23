import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crashPoint } from "../crash.js";
import {
  ACCEPT,
  type DeliveryContext,
  deleteFactoryBranch,
  itemBranch,
  merge,
  mergeUnit,
  observeCi,
  type PullInput,
  publish,
  REPUBLISH,
  RESET_BRANCH,
  type Repair,
} from "../delivery.js";
import {
  hold,
  type Outcome,
  objectiveWide,
  type Step,
  type StepContext,
} from "../engine.js";
import { defaultHead } from "../git.js";
import { GitHubError, issueGone } from "../github.js";
import {
  type CandidateSet,
  captureAssets,
  destinationFinding,
  type InputRecord,
  type MediaInput,
  type MediaOutcome,
  materializeSelection,
  mediaDirectory,
  missingMember,
  needsSelection,
  readSelection,
  resolveInputs,
  type Selection,
  selectionQuestion,
  selectionRef,
  validationMembers,
  verifyOriginMedia,
} from "../media.js";
import { checkObjective, objectiveText } from "../objective.js";
import { forceRemove } from "../paths.js";
import {
  BaseFiles,
  finalCommands,
  fixedScripts,
  planningSources,
} from "../planning/facts.js";
import { packageManagerUpdate } from "../planning/prompts.js";
import { repositoryView } from "../planning/repository.js";
import {
  peerNotes,
  rank,
  resourceGate,
  type ScheduleView,
} from "../planning/schedule.js";
import {
  guarded,
  OBJECTIVE_ACCEPTED,
  type ObjectiveInputs,
  type PlanningDeps,
  REOPENED,
} from "../planning/steps.js";
import { executable, type Plan, type WorkItem } from "../planning/types.js";
import { type DeliveryUnit, unitOf, units } from "../planning/units.js";
import { moveStatusOffDone } from "../queue.js";
import { correction, type RepairFinding } from "../repair.js";
import type { ReviewArtifact } from "../review/artifacts.js";
import { reviewObjective } from "../review/final.js";
import {
  type CriterionDecision,
  type ResultReview,
  receiptPath,
  reviewResult,
} from "../review/result.js";
import { type ObjectiveBlock, readShown, shownDigest } from "../shown.js";
import { type ObjectiveState, runOf, sinceRun } from "../state.js";
import { validateTree } from "../validate.js";
import {
  addWorktree,
  hostGit,
  hostGitExit,
  isAncestor,
  removeWorktree,
  worktreePath,
} from "../worktree.js";
import { collect, type HandoffNote } from "./collect.js";
import { type MergeResult, mergeOf } from "./merged.js";
import { prepareWorkPrompt, type RepairContext } from "./prompt.js";
import type { Worker, WorkerSpend } from "./worker.js";

const MINUTE = 60_000;

/** What execution needs from the installation, beyond planning. */
export interface BuildDeps extends PlanningDeps {
  /** The worker for an Objective's plan. */
  worker(plan: Plan, blocks: readonly ObjectiveBlock[]): Worker;
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
 * Facts that outlive repairs are kept in `state.kept`, under item keys.
 *
 * With native-stack delivery, each chain of the plan (planning/units.ts) is
 * one unit: a layer above the bottom starts on the head published for the
 * layer below it, its PR targets that layer's branch, only the top layer
 * has a merge step (it merges the whole stack), and a repair of a layer
 * also clears every layer above it.
 */
const PHASES = [
  "work",
  "select",
  "validate",
  "review",
  "publish",
  "ci",
  "merge",
] as const;
type Phase = (typeof PHASES)[number];

const stepKey = (id: string, phase: Phase) => `item:${id}:${phase}`;
const keptKey = (id: string, fact: string) => `item:${id}:${fact}`;

function kept<T>(
  state: ObjectiveState,
  id: string,
  fact: string,
): T | undefined {
  return (state.kept ?? {})[keptKey(id, fact)] as T | undefined;
}

interface WorkResult {
  base: string;
  commit: string;
  tree: string;
  notes: HandoffNote[];
  validated?: { tree: string; commands: string[] };
  /** The candidate media sets captured; empty when the item has no select step. */
  sets: CandidateSet[];
}

/**
 * An operator's selection kept across a repair that isn't about the media,
 * with the sets it was chosen from: the repaired attempt stages no media,
 * and the select step writes the same set on the new work commit.
 */
interface KeptSelection {
  selection: Selection;
  sets: CandidateSet[];
}

/** A finished worker run, kept until its result is collected, so a collection question doesn't run the worker again. */
interface Finished {
  finalResponse: string;
  validated?: { tree: string; commands: string[] };
  /** Captured once; absent until then. */
  sets?: CandidateSet[];
}

interface ValidateResult {
  tree: string;
  commands: string[];
  artifacts?: ReviewArtifact[];
}

interface PublishResult {
  pr: number;
  head: string;
  merged: boolean;
}

/**
 * The steps after planning: the build, then final validation, final review
 * and the report. Every one takes `replan` here, before it runs, so any of
 * their holds may offer it and the answer always plans again.
 */
export function deliverySteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  const steps = !built(state)
    ? buildSteps(state, deps)
    : !state.done.final
      ? [finalStep(deps)]
      : !state.done["final-review"]
        ? [finalReviewStep(deps)]
        : !state.done.report
          ? [reportStep(deps)]
          : [];
  return steps.map(replannable);
}

/** The step, except that a `replan` answer to its hold takes the replan route. */
function replannable(step: Step): Step {
  return {
    ...step,
    run: (context) =>
      context.answer?.answer === "replan"
        ? Promise.resolve(replanOutcome(context.state))
        : step.run(context),
  };
}

/**
 * The runnable item steps, most important first (planning/schedule.ts): each
 * unsettled item whose dependencies have merged, or a native-stack layer
 * whose layer below is published. An item's first step waits, without a
 * question, while an in-flight item holds a resource it declares.
 */
function buildSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  const plan = state.done.plan as Plan;
  if (plan.split) return [splitPending(plan.split.children.length)];
  const stacked =
    deps.config.delivery.kind === "native-stack" ? units(plan) : undefined;
  if (stacked && "problem" in stacked) return [unitsProblem(stacked.problem)];
  const layerOf = (id: string) => multiLayer(stacked, id);
  const done = (id: string, phase: Phase) =>
    Boolean(state.done[stepKey(id, phase)]);
  const settled = (id: string) => Boolean(mergeOf(state, id));
  // Started: any step done or running, a kept base (the first work attempt
  // keeps it, and repairs keep it), a waiting retry or an open question.
  // Settled items drop out below.
  const started = new Set(
    [
      ...Object.keys(state.done),
      ...Object.keys(state.attempts),
      ...Object.keys(state.retries),
      ...Object.entries(state.kept ?? {})
        .filter(([key, value]) => key.endsWith(":base") && value != null)
        .map(([key]) => key),
      ...state.holds.map((hold) => hold.step),
    ]
      .filter((key) => key.startsWith("item:"))
      .map((key) => key.split(":")[1]),
  );
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
    const below = place?.unit.items[place.layer - 1];
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
    // The planner is offered only executable kinds; a saved plan from
    // another build may still hold one this build can't run.
    if (!executable(item.kind)) return notYet(item, `${item.kind} items`);
    if (item.kind === "aggregate") return aggregateStep(item);
    const place = layerOf(item.id);
    const top = !place || place.layer === place.unit.items.length - 1;
    const phase = PHASES.find(
      (p) =>
        !done(item.id, p) &&
        (p !== "select" || needsSelection(item)) &&
        (p !== "merge" || top),
    );
    // The top merges the stack once every layer's checks are ready.
    if (
      !phase ||
      (phase === "merge" &&
        place?.unit.items.some((layer) => !done(layer.id, "ci")))
    )
      return undefined;
    return itemStep(item, phase, deps);
  };
  const steps: Step[] = [];
  const runnable = plan.items.filter(
    (item) => !settled(item.id) && ready(item),
  );
  for (const item of rank(plan, view, runnable)) {
    const step = next(item);
    if (!step) continue;
    const first =
      item.kind === "aggregate" || step.key === stepKey(item.id, "work");
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
  const plan = state.done.plan as Plan | undefined;
  if (!plan || plan.split) return [];
  const place = stackLayer(plan, deps, id);
  return place
    ? place.unit.items.slice(0, place.layer).map((layer) => layer.id)
    : [];
}

/** Whether every item has merged (or, for aggregates, completed). */
export function built(state: ObjectiveState): boolean {
  const plan = state.done.plan as Plan | undefined;
  // A split delivers through its children, which aren't created yet.
  if (!plan || plan.split) return false;
  return plan.items.every((item) => mergeOf(state, item.id));
}

/** The item's unit and layer when it is in a native stack of more than one item. */
function multiLayer(
  stacked: ReturnType<typeof units> | undefined,
  id: string,
): { unit: DeliveryUnit; layer: number } | undefined {
  if (!stacked || "problem" in stacked) return undefined;
  const found = unitOf(stacked.units, id);
  return found && found.unit.items.length > 1 ? found : undefined;
}

/** The item's place in a native stack under this installation's delivery. */
function stackLayer(
  plan: Plan,
  deps: BuildDeps,
  id: string,
): { unit: DeliveryUnit; layer: number } | undefined {
  return deps.config.delivery.kind === "native-stack"
    ? multiLayer(units(plan), id)
    : undefined;
}

/** The native-stack layer below the item, whose published head it builds on. */
function stackBelow(
  plan: Plan,
  deps: BuildDeps,
  item: WorkItem,
): WorkItem | undefined {
  const place = stackLayer(plan, deps, item.id);
  return place?.unit.items[place.layer - 1];
}

/** The PR base of a native-stack layer above the bottom: the branch below it. */
function baseBranch(
  state: ObjectiveState,
  deps: BuildDeps,
  item: WorkItem,
): string | undefined {
  const below = stackBelow(state.done.plan as Plan, deps, item);
  return below ? itemBranch(state.issue, below.id) : undefined;
}

/** A plan that does not split into native stacks: only a new plan helps. */
function unitsProblem(problem: string): Step {
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

/**
 * A plan that splits the Objective into child Objectives. Creating the
 * children is not ported yet (slice 6), so the plan holds rather than
 * report done with nothing delivered.
 */
function splitPending(children: number): Step {
  return {
    key: "build:split",
    deadlineMs: MINUTE,
    run: async () =>
      hold(
        `The accepted plan splits this Objective into ${children} child Objectives, and Factory can't create child Objectives yet. Answer replan to plan it without a split, or cancel.`,
        ["replan", "cancel"],
      ),
  };
}

/** The select step's result for an item, when it has one. */
function selection(state: ObjectiveState) {
  return (id: string) =>
    state.done[stepKey(id, "select")] as Selection | undefined;
}

/** The commit later steps use: the selection's, which adds the chosen media, else the work commit. */
function candidate(state: ObjectiveState, id: string): string {
  return (
    selection(state)(id)?.commit ??
    (state.done[stepKey(id, "work")] as WorkResult).commit
  );
}

function itemStep(item: WorkItem, phase: Phase, deps: BuildDeps): Step {
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
      : phase === "validate"
        ? { resource: "cpu" as const }
        : {}),
    deadlineMs:
      phase === "work"
        ? 2 * 60 * MINUTE
        : phase === "ci"
          ? 10 * MINUTE
          : 45 * MINUTE,
    run: (context) =>
      guarded(deps.config.repository, () => run(item, context, deps)),
  };
}

// ---------------------------------------------------------------------------
// work

async function workStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = state.done.plan as Plan;
  const { shown } = objectiveInputs(state);
  const body = shown.body;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  const media = mediaDirectory(workDir, item.id);
  // An item builds on the default branch as it is when it starts, which
  // holds every merged dependency; a native-stack layer above the bottom
  // builds on the layer below's current delivered head: the head a merge
  // check named (`onto`), else its CI's (GitHub may have updated the
  // branch), else its published one. It keeps that base across repairs.
  const below = stackBelow(plan, deps, item);
  const start = async () => {
    if (!below) return defaultHead(config.checkout, config.repository, signal);
    const delivered = (phase: Phase) =>
      (state.done[stepKey(below.id, phase)] as { head: string } | undefined)
        ?.head;
    return (
      kept<string>(state, item.id, "onto") ??
      delivered("ci") ??
      delivered("publish")!
    );
  };
  const keptBase = kept<string>(state, item.id, "base");
  let base = keptBase ?? (await start());
  const added = await addWorktree(config.checkout, worktree, base, signal);
  if (added === "kept" && keptBase === undefined) {
    // A worktree from an attempt that never kept its base (interrupted
    // before its outcome) sits on that attempt's base, which the default
    // branch may have left since: start over on this one.
    await rebaseWorktree(
      config.checkout,
      worktree,
      base,
      base,
      undefined,
      signal,
    );
  } else if (kept(state, item.id, "rebase")) {
    // A conflict or failed delivery: move onto the current start and replay
    // the kept change, so the worker can resolve it there.
    const head = await start();
    const replay = kept<string>(state, item.id, "replay");
    if (head !== base) {
      await rebaseWorktree(
        config.checkout,
        worktree,
        base,
        head,
        replay,
        signal,
      );
      base = head;
    }
  }
  const keepBase = {
    [keptKey(item.id, "base")]: base,
    [keptKey(item.id, "rebase")]: false,
    [keptKey(item.id, "onto")]: null,
  };
  const finishedKey = keptKey(item.id, "finished");
  const selectionKey = keptKey(item.id, "selection");
  let finished = kept<Finished>(state, item.id, "finished");
  let own = kept<KeptSelection>(state, item.id, "selection");
  let keepAll: Record<string, unknown> = keepBase;
  // The worker finished and collection asked: `repair` sends the result
  // back; any other answer collects it again.
  if (finished && context.answer?.answer === "repair") {
    const finding = `The operator sent this result back for repair${context.answer.text ? `: ${context.answer.text}` : "."}`;
    return repairOutcome(
      item,
      "work",
      finding,
      { ...keepBase, ...failure(item, finding) },
      context,
      deps,
    );
  }
  if (!finished && context.answer?.answer === "revalidate") {
    // The operator says the refused result is correct and Factory's check
    // was at fault: it is the step's result again, unchanged, with no
    // worker run, collection or repair. Only reads: a rerun does the same.
    const refused = await refusedResult(
      state,
      item,
      config.checkout,
      base,
      signal,
    );
    if (!refused)
      return withKeep(
        hold(
          `Work Item ${item.id}'s refused result can no longer be checked again as it is (it is gone, or no longer sits on ${base}). Answer \`retry\` to diagnose the failure again, or cancel.`,
          ["retry", "cancel"],
        ),
        keepBase,
      );
    return {
      kind: "done",
      result: refused,
      keep: {
        ...keepBase,
        [finishedKey]: null,
        [keptKey(item.id, "finding")]: null,
        [keptKey(item.id, "refused")]: null,
        [keptKey(item.id, "replay")]: null,
      },
    };
  }
  if (!finished) {
    const repair = await repairContext(item, context, deps, base);
    if (repair && "hold" in repair) return withKeep(repair.hold, keepBase);
    keepAll = { ...keepBase, ...(repair?.keep ?? {}) };
    // A kept selection whose private copies are gone can't be written
    // again: this attempt makes new candidates and the operator chooses.
    if (own && (await missingMember(own.selection.set))) {
      own = undefined;
      keepAll = { ...keepAll, [selectionKey]: null };
    }
    const inputs = await resolveInputs({
      checkout: config.checkout,
      repository: config.repository,
      directory: media,
      plan,
      item,
      base,
      body: objectiveText(shown.blocks),
      localAssetRoots: config.media.localAssetRoots,
      selection: selection(state),
      ...(own ? { kept: own.selection } : {}),
      githubToken: () => deps.github.serviceToken(),
      signal,
    });
    if (inputs.kind !== "done")
      return mediaOutcome(item, inputs, context, deps, keepAll);
    // Review gets the same inputs (InputRecord): the last ones resolved.
    keepAll = { ...keepAll, [keptKey(item.id, "inputs")]: inputs.value };

    const files = new BaseFiles(config.checkout, base, signal);
    const scripts = await fixedScripts(
      finalCommands(shown.blocks, config.finalValidation.requiredCommands),
      files,
    );
    const pin = packageManagerUpdate(shown.blocks);
    const prepared = await prepareWorkPrompt({
      checkout: config.checkout,
      worktree,
      objective: state.issue,
      objectiveBody: body,
      plan,
      item,
      base,
      conventions: (await repositoryView(config.checkout, base, false, signal))
        .conventions,
      fixedScripts: scripts.map((script) => script.name),
      ...(pin ? { packageManagerUpdate: pin } : {}),
      ...(repair ? { repair: repair.context } : {}),
      mediaInputs: inputs.value,
      ...(own
        ? {
            keptSelection: {
              set: own.selection.set.id.toLowerCase(),
              destinations: own.selection.set.members.map((m) => m.destination),
            },
          }
        : {}),
      peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
      signal,
    });
    if ("problem" in prepared)
      return withKeep(
        hold(prepared.problem, ["retry", "replan", "cancel"]),
        keepAll,
      );

    const spent = kept<WorkerSpend>(state, item.id, "spend");
    const { spend, ...result } = await deps.worker(plan, shown.blocks).run({
      worktree,
      prompt: prepared.prompt,
      item,
      commands: item.validation.map((v) => v.command),
      base,
      signal,
      log: context.log,
      ...(spent ? { spend: spent } : {}),
      ...(context.answer ? { answer: context.answer } : {}),
    });
    // A paid worker's spend outlives retries, restarts and repairs.
    if (spend) keepAll = { ...keepAll, [keptKey(item.id, "spend")]: spend };
    if (result.kind !== "finished") return withKeep(result, keepAll);
    finished = {
      finalResponse: result.finalResponse,
      ...(result.validated ? { validated: result.validated } : {}),
    };
  }

  // Capture before collection, which deletes the media manifest, and keep
  // the captured sets before anything destructive: the step runs again at
  // once and collects with them. A repair whose selection stands has no
  // manifest and keeps the sets the selection came from; one that staged
  // new sets anyway forgets the selection first (capture replaces the kept
  // copies), and the operator chooses from the new sets.
  if (!finished.sets && own) {
    const staged = await lstat(join(worktree, ".factory-assets.json")).then(
      () => true,
      () => false,
    );
    if (staged)
      return {
        kind: "retry",
        reason:
          "The repair staged new candidate sets, so the operator chooses again",
        progress: true,
        keep: { ...keepAll, [finishedKey]: finished, [selectionKey]: null },
      };
    finished = { ...finished, sets: own.sets };
  }
  if (!finished.sets) {
    const captured = await captureAssets({
      secretlintConfig: config.policy.secretlintConfig,
      worktree,
      item,
      directory: media,
      signal,
    });
    if (captured.kind !== "done")
      return mediaOutcome(item, captured, context, deps, {
        ...keepAll,
        [finishedKey]: finished,
      });
    if (captured.value.length)
      return {
        kind: "retry",
        reason: "Candidate media sets captured; collecting the result",
        progress: true,
        keep: {
          ...keepAll,
          [finishedKey]: { ...finished, sets: captured.value },
        },
      };
    finished = { ...finished, sets: [] };
  }
  const sets = finished.sets ?? [];
  // The kept copies replace the worker's staging.
  if (sets.length) await forceRemove(join(worktree, ".factory-media"));
  const keepFinished = { ...keepAll, [finishedKey]: finished };

  const collected = await collect({
    secretlintConfig: config.policy.secretlintConfig,
    worktree,
    base,
    plan,
    item,
    sandbox: config.sandbox,
    finalResponse: finished.finalResponse,
    refusedTree: kept<Refused>(state, item.id, "refused")?.tree,
    signal,
  });
  switch (collected.kind) {
    case "collected": {
      const outside = await destinationFinding({
        worktree,
        base,
        commit: collected.commit,
        sets,
        signal,
      });
      if (outside)
        return repairOutcome(
          item,
          "work",
          outside,
          { ...keepAll, ...failure(item, outside) },
          context,
          deps,
        );
      const done: WorkResult = {
        base,
        commit: collected.commit,
        tree: collected.tree,
        notes: collected.notes,
        ...(finished.validated ? { validated: finished.validated } : {}),
        sets,
      };
      return {
        kind: "done",
        result: done,
        keep: {
          ...keepAll,
          [finishedKey]: null,
          [keptKey(item.id, "finding")]: null,
          [keptKey(item.id, "refused")]: null,
          [keptKey(item.id, "replay")]: null,
        },
      };
    }
    case "repair":
      return repairOutcome(
        item,
        "work",
        collected.finding,
        { ...keepAll, ...failure(item, collected.finding) },
        context,
        deps,
      );
    default:
      return withKeep(collected, keepFinished);
  }
}

/** The kept finding of a failure, for the next attempt's repair context. */
function failure(item: WorkItem, detail: string): Record<string, unknown> {
  return {
    [keptKey(item.id, "finding")]: {
      kind: "failure",
      detail,
    } satisfies RepairFinding,
  };
}

/** A media answer other than done as the step's outcome: `repair` goes back to the work step. */
function mediaOutcome(
  item: WorkItem,
  outcome: Exclude<MediaOutcome<unknown>, { kind: "done" }>,
  context: StepContext,
  deps: BuildDeps,
  keep: Record<string, unknown> = {},
  from: Phase = "work",
): Outcome {
  switch (outcome.kind) {
    case "repair":
      return repairOutcome(
        item,
        from,
        outcome.finding,
        { ...keep, ...failure(item, outcome.finding) },
        context,
        deps,
      );
    case "retry":
      return { kind: "retry", reason: outcome.reason, keep };
    default:
      return { ...outcome, keep };
  }
}

/** Handoff notes of every item whose result was accepted (validated and reviewed), by item. */
function acceptedNotes(
  state: ObjectiveState,
  plan: Plan,
): Map<string, HandoffNote[]> {
  const notes = new Map<string, HandoffNote[]>();
  for (const other of plan.items) {
    const work = state.done[stepKey(other.id, "work")] as
      | WorkResult
      | undefined;
    if (
      work &&
      state.done[stepKey(other.id, "validate")] &&
      state.done[stepKey(other.id, "review")]
    )
      notes.set(other.id, work.notes);
  }
  return notes;
}

/** Add facts to keep to any outcome that can carry them. */
function withKeep(outcome: Outcome, keep: Record<string, unknown>): Outcome {
  if (outcome.kind === "fail") return outcome;
  return { ...outcome, keep: { ...(outcome.keep ?? {}), ...keep } };
}

/**
 * Move a kept worktree from `from` to `to` and replay the kept change
 * (`replay`) on it. Conflicts stay in the files for the worker to resolve.
 */
async function rebaseWorktree(
  checkout: string,
  worktree: string,
  from: string,
  to: string,
  refused: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  await hostGit(worktree, ["checkout", "--detach", "--force", to], { signal });
  await hostGit(worktree, ["clean", "-ffdx", "--", "."], { signal });
  if (!refused) return;
  const diff = await hostGit(
    checkout,
    ["diff", "--no-ext-diff", "--no-textconv", from, refused],
    { signal },
  );
  if (!diff.length) return;
  // Applying may conflict; the worker resolves what remains.
  await hostGitExit(worktree, ["apply", "--3way", "--whitespace=nowarn"], {
    input: diff.toString("utf8"),
    signal,
  });
}

/**
 * What a repaired attempt is told: the latest finding and its correction.
 * The correction is diagnosed once per repair and kept, so a rerun of the
 * work step reuses it; an operator question holds.
 */
async function repairContext(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  base: string,
): Promise<
  | { context: RepairContext; keep: Record<string, unknown> }
  | { hold: Outcome }
  | undefined
> {
  const { state, signal } = context;
  const history = state.repairs?.[stepKey(item.id, "work")];
  const finding = kept<RepairFinding>(state, item.id, "finding");
  // A conflict needs no diagnosis: the change was moved onto `base`.
  if (finding?.kind === "conflict")
    return {
      context: {
        finding: `${finding.detail} Factory moved the previous result onto ${base} and replayed its change; resolve every conflict the replay left (conflict markers, unmerged or missing changes) within the owned paths, keeping both the new base's changes and this item's change.`,
      },
      keep: {},
    };
  if (!history?.count || !finding) return undefined;
  const saved = kept<{ repair: number; context: RepairContext }>(
    state,
    item.id,
    "correction",
  );
  if (saved?.repair === history.count)
    return { context: saved.context, keep: {} };
  const applied = kept<string[]>(state, item.id, "corrections") ?? [];
  const plan = state.done.plan as Plan;
  const previous = state.done[stepKey(item.id, "work")] as
    | WorkResult
    | undefined;
  const sources = await pinnedSources(state, deps, signal);
  const answer =
    context.answer?.answer === "answer" ? context.answer.text : undefined;
  const result = await correction({
    planner: deps.planner,
    plan,
    item,
    finding,
    checkout: deps.config.checkout,
    base,
    commit:
      kept<Refused>(state, item.id, "refused")?.commit ??
      previous?.commit ??
      base,
    sources,
    prior: applied,
    ...(answer ? { operatorAnswer: answer } : {}),
    signal,
    log: context.log,
  });
  if (result.kind === "question") {
    const recheck = (await refusedResult(
      state,
      item,
      deps.config.checkout,
      base,
      signal,
    ))
      ? "\n\nIf the refused result is correct and Factory's own check was at fault (for example, the check could not see files the result has), answer `revalidate`: Factory runs validation, review and delivery again on the same result, unchanged, without running the worker. It doesn't count as a repair."
      : "";
    return {
      hold: hold(
        `Work Item ${item.id} needs your decision before it is repaired:\n\n${result.question}\n\nAnswer with \`answer <decision>\` to send the worker a correction, or \`retry\` to diagnose the failure again.${recheck}`,
        ["answer", "retry", ...(recheck ? ["revalidate"] : []), "cancel"],
      ),
    };
  }
  const repairContextValue: RepairContext = {
    finding: result.correction.failure,
    correction: {
      diagnosis: result.correction.diagnosis,
      correction: result.correction.correction,
    },
    ...(finding.kind === "review" ? { fromReview: true } : {}),
  };
  return {
    context: repairContextValue,
    keep: {
      [keptKey(item.id, "correction")]: {
        repair: history.count,
        context: repairContextValue,
      },
      [keptKey(item.id, "corrections")]: [...applied, result.finding],
    },
  };
}

/**
 * The result a repair refused: its commit (the diagnosis's evidence), its
 * tree (collection reads the same tree on the same base as no change) and
 * its notes (for `revalidate`).
 */
interface Refused {
  commit: string;
  tree: string;
  notes: HandoffNote[];
}

/**
 * The change a rebase replays: the commit of the item's last work result,
 * kept on every repair that clears it, whether or not the repair refuses
 * that result. Separate from the refused fact, whose tree collection reads
 * as "no change".
 */
function replayFact(id: string, work: WorkResult): Record<string, string> {
  return { [keptKey(id, "replay")]: work.commit };
}

/** The one writer of the refused fact, from the refused work result. */
function refusedFact(id: string, work: WorkResult): Record<string, Refused> {
  return {
    [keptKey(id, "refused")]: {
      commit: work.commit,
      tree: work.tree,
      notes: work.notes,
    },
  };
}

/**
 * The kept refused result as a work result, when it can be checked again
 * unchanged: its commit still exists with the refused tree, on `base`, and
 * an item with media still has the selection to write on it again; sets
 * come from the selection.
 */
async function refusedResult(
  state: ObjectiveState,
  item: WorkItem,
  checkout: string,
  base: string,
  signal: AbortSignal,
): Promise<WorkResult | undefined> {
  const refused = kept<Refused>(state, item.id, "refused");
  if (!refused) return undefined;
  const own = kept<KeptSelection>(state, item.id, "selection");
  if (needsSelection(item) && !own) return undefined;
  const shown = await hostGitExit(
    checkout,
    ["show", "--no-patch", "--format=%P %T", `${refused.commit}^{commit}`],
    { signal },
  );
  if (
    shown.code !== 0 ||
    shown.stdout.toString("utf8").trim() !== `${base} ${refused.tree}`
  )
    return undefined;
  return { base, ...refused, sets: own?.sets ?? [] };
}

// ---------------------------------------------------------------------------
// validate

async function validateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = state.done.plan as Plan;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  await addWorktree(config.checkout, worktree, work.base, signal);
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktree}.validation`,
    commit: candidate(state, item.id),
    item,
    plan,
    blocks: objectiveInputs(state).shown.blocks,
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", item.id),
    },
    media: validationMembers(plan, item, selection(state)),
    sandbox: config.sandbox,
    signal,
    log: context.log,
  });
  switch (result.kind) {
    case "passed": {
      const done: ValidateResult = {
        tree: result.tree,
        commands: result.commands,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      };
      return { kind: "done", result: done };
    }
    case "failed": {
      // The worker's own Validate passed this exact tree with these
      // commands: run once more before calling it the result's fault.
      const flakyKey = keptKey(item.id, "flaky");
      const sameAsWorker =
        work.validated?.tree === result.tree &&
        JSON.stringify(work.validated.commands) ===
          JSON.stringify(result.commands);
      const rerun = kept<{ tree: string }>(state, item.id, "flaky");
      if (sameAsWorker && rerun?.tree !== result.tree && result.failed)
        return {
          kind: "retry",
          reason: `\`${result.failed.command}\` failed on a tree the worker's own validation passed; running it once more.`,
          progress: true,
          keep: {
            [flakyKey]: { tree: result.tree, command: result.failed.command },
          },
        };
      return repairOutcome(
        item,
        "validate",
        result.detail,
        {
          ...failure(item, result.output),
        },
        context,
        deps,
      );
    }
    default:
      return result;
  }
}

// ---------------------------------------------------------------------------
// select

/**
 * The operator picks one of the worker's candidate media sets; Factory
 * writes it at its destinations on top of the work commit. Until a valid
 * answer, the step asks with the candidates. After a repair that wasn't
 * about the media, the kept selection is written again without asking.
 */
async function selectStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const plan = state.done.plan as Plan;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const question = selectionQuestion(
    plan,
    item,
    work.sets,
    mediaDirectory(workDir, item.id),
  );
  const answer = context.answer;
  const own = kept<KeptSelection>(state, item.id, "selection");
  let read: ReturnType<typeof readSelection>;
  let decided: { by: string; at: string };
  if (!answer && own && work.sets.some((s) => s.id === own.selection.set.id)) {
    read = {
      kind: "chosen",
      set: own.selection.set,
      bound: own.selection.bound,
    };
    decided = own.selection;
  } else {
    if (!answer || !question.answers.includes(answer.answer.toLowerCase()))
      return question;
    read = readSelection(plan, item, work.sets, answer);
    decided = answer;
  }
  if (read.kind === "invalid")
    return { ...question, question: `${read.problem}\n\n${question.question}` };
  if (read.kind === "repair") {
    const finding = `The operator asked for new candidates${answer?.text ? `: ${answer.text}` : "."}`;
    return repairOutcome(
      item,
      "select",
      finding,
      failure(item, finding),
      context,
      deps,
    );
  }
  const made = await materializeSelection({
    checkout: deps.config.checkout,
    directory: `${worktreePath(workDir, state.issue, item.id)}.select`,
    item,
    commit: work.commit,
    set: read.set,
    ref: selectionRef(state.issue, item.id),
    signal,
  });
  if (made.kind !== "done")
    return mediaOutcome(item, made, context, deps, {}, "select");
  const done: Selection = {
    commit: made.value.commit,
    tree: made.value.tree,
    set: read.set,
    bound: read.bound,
    by: decided.by,
    at: decided.at,
  };
  return { kind: "done", result: done };
}

// ---------------------------------------------------------------------------
// review

async function reviewStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const plan = state.done.plan as Plan;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const worktree = worktreePath(
    deps.workDir(state.issue),
    state.issue,
    item.id,
  );
  const pendingKey = keptKey(item.id, "questions");
  const decisions = criterionDecisions(
    context,
    validated.tree,
    kept<string[]>(state, item.id, "questions"),
  );
  const chosen = selection(state)(item.id);
  const review = await reviewResult({
    planner: deps.planner,
    plan,
    item,
    checkout: deps.config.checkout,
    base: work.base,
    commit: candidate(state, item.id),
    validation: validated,
    sources: await pinnedSources(state, deps, signal),
    dir: `${worktree}.review`,
    notes: JSON.stringify(work.notes),
    ...(chosen
      ? { candidates: [{ item, sets: work.sets, selection: chosen }] }
      : {}),
    inputs: workerInputs(state, [item.id]),
    ...(validated.artifacts ? { artifacts: validated.artifacts } : {}),
    decisions,
    signal,
    log: context.log,
  });
  return reviewOutcome(review, pendingKey, () =>
    repairOutcome(
      item,
      "review",
      review.kind === "refused"
        ? review.refused.map((r) => `${r.criterion}: ${r.detail}`).join("\n")
        : "",
      {
        [keptKey(item.id, "finding")]: {
          kind: "review",
          tree: review.tree,
          refused: review.kind === "refused" ? review.refused : [],
        } satisfies RepairFinding,
      },
      context,
      deps,
    ),
  );
}

/** The read-only inputs each item's worker last got, for review. */
function workerInputs(state: ObjectiveState, ids: string[]): InputRecord[] {
  return ids.map((id) => ({
    item: id,
    inputs: kept<MediaInput[]>(state, id, "inputs") ?? [],
  }));
}

/** Pass is done, refused repairs, needs-human asks (saving the criteria it asks about under `pendingKey`). */
function reviewOutcome(
  review: ResultReview,
  pendingKey: string,
  refused: () => Outcome,
): Outcome {
  if (review.kind === "pass")
    return { kind: "done", result: { tree: review.tree } };
  if (review.kind === "refused") return refused();
  const lines = review.questions.map(
    (q, i) =>
      `${i + 1}. ${q.criterion}\n   ${q.question}${q.detail ? `\n   ${q.detail}` : ""}`,
  );
  return {
    ...hold(
      `The reviewer needs your judgment on this result:\n\n${lines.join("\n")}\n\n\`accept\` accepts ${review.questions.length === 1 ? "it" : "them all"}; \`refuse <reason>\` sends the result back for repair.`,
      ["accept", "refuse", "cancel"],
    ),
    keep: { [pendingKey]: review.questions.map((q) => q.criterion) },
  };
}

/** The operator's accept or refuse, applied to every open question on this tree. */
function criterionDecisions(
  context: StepContext,
  tree: string,
  criteria: string[] | undefined,
): CriterionDecision[] | undefined {
  const answer = context.answer;
  if (
    !answer ||
    !criteria?.length ||
    (answer.answer !== "accept" && answer.answer !== "refuse")
  )
    return undefined;
  const outcome = answer.answer;
  return criteria.map((criterion) => ({
    criterion,
    tree,
    outcome,
    by: answer.by,
    at: answer.at,
    ...(answer.text ? { text: answer.text } : {}),
  }));
}

// ---------------------------------------------------------------------------
// publish, ci, merge

function delivery(
  context: StepContext,
  deps: BuildDeps,
  key: string,
): DeliveryContext {
  const since = context.state.retries[key]?.since;
  return {
    github: deps.github,
    checkout: deps.config.checkout,
    signal: context.signal,
    ...(since ? { retryingSince: since } : {}),
  };
}

async function publishStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state } = context;
  const changed = await objectiveEdited(context, deps);
  if (changed) return changed;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const pushed = kept<string[]>(state, item.id, "pushed") ?? [];
  const republish =
    context.answer?.answer === REPUBLISH ||
    Boolean(kept(state, item.id, "republish"));
  const rerun = kept<{ tree: string; command: string }>(
    state,
    item.id,
    "flaky",
  );
  const flaky = rerun?.tree === validated.tree ? rerun : undefined;
  const commit = candidate(state, item.id);
  const branch = baseBranch(state, deps, item);
  const result = await publish(
    delivery(context, deps, stepKey(item.id, "publish")),
    {
      issue: state.issue,
      item,
      base: work.base,
      commit,
      tree: validated.tree,
      pushedHeads: pushed,
      validation: {
        commands: validated.commands,
        ...(flaky ? { flaky: { command: flaky.command, exitCode: null } } : {}),
      },
      ...(republish ? { republish: true } : {}),
      ...(context.answer?.answer === RESET_BRANCH ? { reset: true } : {}),
      ...(branch ? { baseBranch: branch } : {}),
      secrets: deps.config.secrets,
      // The operator's `publish` counts only for the finding it answered:
      // the digest kept when the hold was raised, never the hold's text,
      // which quotes worker-chosen paths.
      ...(context.answer?.answer === "publish"
        ? { allowSecret: kept<string>(state, item.id, "secret") }
        : {}),
    },
  );
  if (result.kind === "secret")
    return context.answer?.answer === "repair"
      ? repairOutcome(
          item,
          "publish",
          result.finding,
          failure(item, result.finding),
          context,
          deps,
          true,
        )
      : {
          ...hold(
            `${result.finding}\n\nPublication stopped; nothing was pushed (finding \`${result.digest}\`). Answer repair to have the worker remove the value; publish if the matched text isn't a secret, which lets exactly this finding on this commit through once; or cancel. Rotate the secret if the worker may have written it anywhere else.`,
            ["repair", "publish", "cancel"],
          ),
          keep: { [keptKey(item.id, "secret")]: result.digest },
        };
  // An empty change, or a pointer whose LFS object is missing: a fault in
  // the result itself, not a conflict, so no rebase.
  if (result.kind === "empty" || result.kind === "repair")
    return repairOutcome(
      item,
      "publish",
      result.finding,
      failure(item, result.finding),
      context,
      deps,
    );
  if (result.kind !== "published")
    return republish
      ? { ...result, keep: { [keptKey(item.id, "republish")]: true } }
      : result;
  const done: PublishResult = {
    pr: result.pr,
    head: result.head,
    merged: result.merged,
  };
  return {
    kind: "done",
    result: done,
    keep: {
      [keptKey(item.id, "pushed")]: [...new Set([...pushed, commit])],
      [keptKey(item.id, "republish")]: false,
    },
  };
}

function pullInput(
  state: ObjectiveState,
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): PullInput {
  const plan = state.done.plan as Plan;
  const published = state.done[stepKey(item.id, "publish")] as PublishResult;
  const branch = baseBranch(state, deps, item);
  return {
    issue: state.issue,
    item: item.id,
    pr: published.pr,
    head: published.head,
    pushedHeads: kept<string[]>(state, item.id, "pushed") ?? [],
    requiredChecks: (plan.requiredPreIntegrationChecks ?? []).map(
      (c) => c.checkName,
    ),
    ...(context.answer?.answer === REPUBLISH ? { republish: true } : {}),
    ...(branch ? { baseBranch: branch } : {}),
  };
}

async function ciStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const result = await observeCi(
    delivery(context, deps, stepKey(item.id, "ci")),
    pullInput(context.state, item, context, deps),
  );
  switch (result.kind) {
    case "ready":
      return {
        kind: "done",
        result: { head: result.head, merged: result.merged },
      };
    case "repair":
      return deliveryRepair(item, context, deps, result, "ci");
    case "republish":
      return republishOutcome(item, result.reason);
    default:
      return result;
  }
}

async function mergeStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state } = context;
  const plan = state.done.plan as Plan;
  const place = stackLayer(plan, deps, item.id);
  if (place) return mergeStack(place.unit, context, deps);
  const ci = state.done[stepKey(item.id, "ci")] as { head: string };
  const result = await merge(
    delivery(context, deps, stepKey(item.id, "merge")),
    {
      ...pullInput(state, item, context, deps),
      head: ci.head,
      integrated: integrated(state, plan),
    },
  );
  switch (result.kind) {
    case "merged": {
      await deleteBranches(context, deps, [item]);
      const done: MergeResult = {
        mergeSha: result.mergeSha,
        integratedSha: result.integratedSha,
        at: new Date().toISOString(),
      };
      return { kind: "done", result: done };
    }
    case "repair":
      return deliveryRepair(item, context, deps, result, "merge");
    case "republish":
      return republishOutcome(item, result.reason);
    default:
      return result;
  }
}

/** Delete the merged items' branches (deleteFactoryBranch); a kept one is logged. */
async function deleteBranches(
  context: StepContext,
  deps: BuildDeps,
  items: readonly WorkItem[],
): Promise<void> {
  const where = {
    github: deps.github,
    checkout: deps.config.checkout,
    signal: context.signal,
  };
  for (const item of items) {
    const branch = itemBranch(context.state.issue, item.id);
    const kept = await deleteFactoryBranch(
      where,
      branch,
      "deliver:branch-delete",
      baseBranch(context.state, deps, item),
    );
    if (kept) context.log({ event: "branch-kept", branch, reason: kept });
  }
}

/**
 * The merge step of a native stack's top layer merges the whole unit. A
 * layer's repair or republish goes to that layer; the merge is recorded
 * here for every layer.
 */
async function mergeStack(
  unit: DeliveryUnit,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state } = context;
  const plan = state.done.plan as Plan;
  const top = unit.items[unit.items.length - 1] as WorkItem;
  const layers = unit.items.map((layer) => ({
    ...pullInput(state, layer, context, deps),
    head: (state.done[stepKey(layer.id, "ci")] as { head: string }).head,
  })) as [PullInput, ...PullInput[]];
  const result = await mergeUnit(
    delivery(context, deps, stepKey(top.id, "merge")),
    layers,
    integrated(state, plan),
    context.answer?.answer === ACCEPT,
  );
  const layer = (id: string) =>
    unit.items.find((entry) => entry.id === id) ?? top;
  switch (result.kind) {
    case "merged": {
      // Lower layers' branches are the upper PRs' bases: they go only
      // once the whole unit merged.
      await deleteBranches(context, deps, unit.items);
      const done: MergeResult = {
        mergeSha: result.mergeSha,
        integratedSha: result.integratedSha,
        at: new Date().toISOString(),
        items: result.items,
      };
      return { kind: "done", result: done };
    }
    case "repair":
      return deliveryRepair(layer(result.item), context, deps, result, "merge");
    case "republish":
      return republishOutcome(layer(result.item), result.reason);
    default: {
      const { item: _layer, ...outcome } = result;
      return outcome;
    }
  }
}

/**
 * Failed CI or a conflict: the worker repairs on the current base, and the
 * same PR gets the new head. A conflict is mechanical: the change moves onto
 * the base GitHub named (or the current start) and the worker resolves what
 * the replay left, with no diagnosis.
 */
function deliveryRepair(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  repair: Repair,
  phase: Phase,
): Outcome {
  return repairOutcome(
    item,
    phase,
    repair.finding,
    {
      ...(repair.conflict
        ? conflictFinding(item, repair.finding)
        : failure(item, repair.finding)),
      ...(repair.conflict?.onto
        ? { [keptKey(item.id, "onto")]: repair.conflict.onto }
        : {}),
      [keptKey(item.id, "rebase")]: true,
    },
    context,
    deps,
  );
}

/** The kept finding of a conflict: a mechanical repair (see repairContext). */
function conflictFinding(
  item: WorkItem,
  detail: string,
): Record<string, unknown> {
  return {
    [keptKey(item.id, "finding")]: {
      kind: "conflict",
      detail,
    } satisfies RepairFinding,
  };
}

function republishOutcome(item: WorkItem, reason: string): Outcome {
  return {
    kind: "repair",
    finding: reason,
    target: stepKey(item.id, "publish"),
    clear: (["publish", "ci", "merge"] as const).map((p) =>
      stepKey(item.id, p),
    ),
    keep: { [keptKey(item.id, "republish")]: true },
  };
}

/**
 * Clear the item's steps from `work` and run the worker again with the
 * finding. In a native stack every layer above the item is cleared too: it
 * moves onto the repaired layer's new head and replays its own change.
 *
 * An operator's selection stands across the repair (see KeptSelection)
 * unless the repair is about the media: it comes from the select step (the
 * operator's `repair`, or the selected set couldn't be written), or the
 * finding names a selected destination or cites the candidate receipt.
 *
 * Every cleared work result (the item's and each layer's above) keeps its
 * commit as the replay source, so a rebase never drops the change.
 *
 * `refusesResult`: the repair refuses the item's own work result tree
 * (validate, review, CI, merge, a secret it writes), so the worker must
 * change it and the item's refused fact is recorded. A select or publish
 * media repair (new candidates, a selection that couldn't be written, LFS
 * objects) may rightly end on the same tracked tree, so it records no
 * refused fact, and a correct fix is never "no change". The layers above
 * are moved, not refused: they never get a refused fact.
 */
function repairOutcome(
  item: WorkItem,
  from: Phase,
  finding: string,
  keep: Record<string, unknown>,
  context: StepContext,
  deps: BuildDeps,
  refusesResult = from !== "select" && from !== "publish",
): Outcome {
  const { state } = context;
  const place = stackLayer(state.done.plan as Plan, deps, item.id);
  const above = place ? place.unit.items.slice(place.layer + 1) : [];
  const standing = (entry: WorkItem): KeptSelection | undefined => {
    const chosen = selection(state)(entry.id);
    const work = state.done[stepKey(entry.id, "work")] as
      | WorkResult
      | undefined;
    return chosen && work
      ? { selection: chosen, sets: work.sets }
      : kept<KeptSelection>(state, entry.id, "selection");
  };
  // The work step forgets a selection whose copies are gone.
  const own =
    keep[keptKey(item.id, "selection")] === null ? undefined : standing(item);
  const media =
    from === "select" ||
    (own !== undefined &&
      aboutMedia(
        item,
        own.selection.set,
        finding,
        keep[keptKey(item.id, "finding")] as RepairFinding | undefined,
      ));
  // The result being cleared, when there is one: a repair from `work`
  // itself keeps the facts of the result before it.
  const result = state.done[stepKey(item.id, "work")] as WorkResult | undefined;
  const moved: Record<string, unknown> = {
    [keptKey(item.id, "selection")]: media ? null : (own ?? null),
    ...(result ? replayFact(item.id, result) : {}),
    ...(result && refusesResult ? refusedFact(item.id, result) : {}),
  };
  for (const layer of above) {
    const layerSelection = standing(layer);
    if (layerSelection) moved[keptKey(layer.id, "selection")] = layerSelection;
    const work = state.done[stepKey(layer.id, "work")] as
      | WorkResult
      | undefined;
    moved[keptKey(layer.id, "rebase")] = true;
    moved[keptKey(layer.id, "finished")] = null;
    moved[keptKey(layer.id, "onto")] = null;
    if (work) {
      Object.assign(
        moved,
        replayFact(layer.id, work),
        conflictFinding(
          layer,
          `Work Item ${item.id}, the stack layer below this one, is being repaired, so this change moves onto its new head.`,
        ),
      );
    }
  }
  return {
    kind: "repair",
    finding,
    target: stepKey(item.id, "work"),
    clear: [item, ...above].flatMap((entry) =>
      PHASES.map((p) => stepKey(entry.id, p)),
    ),
    keep: { ...keep, ...moved, [keptKey(item.id, "finished")]: null },
  };
}

/**
 * Whether a repair is about the selected media: the finding (or the kept
 * finding's detail) names one of the set's destinations, or a refused
 * review criterion cites one or the item's candidate receipt.
 */
function aboutMedia(
  item: WorkItem,
  set: CandidateSet,
  finding: string,
  fact: RepairFinding | undefined,
): boolean {
  const cited =
    fact?.kind === "review"
      ? fact.refused.flatMap((r) =>
          r.evidence.flatMap((e) => [e.path, e.file ?? ""]),
        )
      : [];
  if (cited.includes(receiptPath(item.id))) return true;
  const texts = [
    finding,
    ...cited,
    fact && "detail" in fact ? fact.detail : "",
  ];
  return set.members.some((m) =>
    texts.some((text) => text.includes(m.destination)),
  );
}

/**
 * `replan` after the plan was accepted: forget the plan and the build, and
 * check the Objective again from the issue and the default branch. Merged
 * work is on the default branch, so the new plan starts from it.
 */
function replanOutcome(state: ObjectiveState): Outcome {
  // Every item step, done or running: the engine stops the running ones.
  const items = (state.done.plan as Plan | undefined)?.items ?? [];
  return {
    kind: "repair",
    finding: "The operator asked to replan.",
    target: "check",
    reset: true,
    clear: [
      ...new Set([
        ...Object.keys(state.done),
        ...items.flatMap((item) => PHASES.map((p) => stepKey(item.id, p))),
      ]),
    ],
    keep: {
      ...Object.fromEntries(
        Object.keys(state.kept ?? {}).map((key) => [key, null]),
      ),
      [RERUN]: true,
    },
  };
}

/**
 * Set when an Objective runs again: after a `replan` once the plan was
 * accepted, or when a finished Objective is queued again. The earlier
 * run's open PRs and work files go before the new run checks the issue.
 */
export const RERUN = "rerun";

// ---------------------------------------------------------------------------
// aggregates and not-yet-ported kinds

function aggregateStep(item: WorkItem): Step {
  return {
    key: stepKey(item.id, "merge"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return { kind: "done", result: { aggregate: true } };
    },
  };
}

function notYet(item: WorkItem, what: string): Step {
  return {
    key: stepKey(item.id, "work"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return hold(
        `Work Item ${item.id} is one of the ${what}, which this Factory build can't run yet.`,
        ["retry", "replan", "cancel"],
        "cancel",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// final validation and final review

interface FinalResult {
  commit: string;
  tree: string;
  commands: string[];
  artifacts?: ReviewArtifact[];
  /** The selected media origin serves, for the report; absent when there is none. */
  media?: string;
}

/** Set once final validation pushed missing LFS objects to origin again. */
const REPUSHED = "final:repushed";

/** `final`: the final commands on the default branch head after every merge. */
function finalStep(deps: BuildDeps): Step {
  return {
    key: "final",
    resource: "cpu",
    deadlineMs: 60 * MINUTE,
    run: (context) =>
      guarded(deps.config.repository, async () => {
        const { state, signal } = context;
        const { config } = deps;
        const plan = state.done.plan as Plan;
        const head = await defaultHead(
          config.checkout,
          config.repository,
          signal,
        );
        for (const item of plan.items) {
          const merged = state.done[stepKey(item.id, "merge")] as
            | MergeResult
            | undefined;
          if (!merged?.mergeSha) continue;
          if (
            !(await isAncestor(config.checkout, merged.mergeSha, head, signal))
          )
            return hold(
              `Work Item ${item.id}'s merge \`${merged.mergeSha.slice(0, 12)}\` is not on the default branch (${head.slice(0, 12)}); someone may have reverted or force-pushed it. Restore it and answer \`retry\`, or \`replan\`.`,
              ["retry", "replan", "cancel"],
            );
        }
        const workDir = deps.workDir(state.issue);
        const members = validationMembers(plan, undefined, selection(state));
        const result = await validateTree({
          checkout: config.checkout,
          repository: config.repository,
          directory: join(workDir, "final"),
          commit: head,
          plan,
          blocks: objectiveInputs(state).shown.blocks,
          reviewArtifacts: {
            configured: config.reviewArtifacts,
            planned: plan.reviewArtifacts,
            dir: join(workDir, "artifacts", "final"),
          },
          media: members,
          sandbox: config.sandbox,
          signal,
          log: context.log,
        });
        if (result.kind === "failed")
          return hold(
            `Final validation failed on the default branch (${head.slice(0, 12)}):\n\n${result.detail}\n\nFix it on the default branch and answer \`retry\`, \`replan\` to plan the remaining work, or cancel.`,
            ["retry", "replan", "cancel"],
          );
        if (result.kind !== "passed") return result;
        // Origin must serve every selected member's bytes.
        const verified = await verifyOriginMedia({
          checkout: config.checkout,
          repository: config.repository,
          commit: head,
          members,
          scratch: join(workDir, "final-media"),
          repushed: Boolean((state.kept ?? {})[REPUSHED]),
          signal,
        });
        if (verified.kind === "retry")
          return {
            kind: "retry",
            reason: verified.reason,
            ...(verified.repushed ? { keep: { [REPUSHED]: true } } : {}),
          };
        if (verified.kind === "repair") return hold(verified.finding);
        if (verified.kind !== "done") return verified;
        const done: FinalResult = {
          commit: head,
          tree: result.tree,
          commands: result.commands,
          ...(result.artifacts ? { artifacts: result.artifacts } : {}),
          ...(verified.value.summary ? { media: verified.value.summary } : {}),
        };
        return { kind: "done", result: done, keep: { [REPUSHED]: null } };
      }),
  };
}

/** Final review's refusal is the open question: its `retry` means the default branch was fixed. */
const REFUSED = "final-review:refused";

/** `final-review`: every Objective criterion against the integrated result. */
function finalReviewStep(deps: BuildDeps): Step {
  return {
    key: "final-review",
    deadlineMs: 45 * MINUTE,
    run: (context) =>
      guarded(deps.config.repository, async () => {
        const { state, signal } = context;
        // A `retry` to the refusal (never to an error or a wait question):
        // the operator fixed the default branch, so validate the new head
        // before reviewing again.
        if (context.answer?.answer === "retry" && (state.kept ?? {})[REFUSED])
          return {
            kind: "repair",
            finding: "Final review runs again after the operator's fix.",
            target: "final",
            clear: ["final", "final-review"],
            keep: { [REFUSED]: null },
          };
        const plan = state.done.plan as Plan;
        const final = state.done.final as FinalResult;
        const merges = plan.items
          .map((item) => ({
            id: item.id,
            merged: state.done[stepKey(item.id, "merge")] as
              | MergeResult
              | undefined,
          }))
          .filter(
            (entry): entry is { id: string; merged: MergeResult } =>
              !!entry.merged?.mergeSha,
          )
          .sort((a, b) => a.merged.at.localeCompare(b.merged.at));
        const decisions = criterionDecisions(
          context,
          final.tree,
          (state.kept ?? {})["final:questions"] as string[] | undefined,
        );
        // Every merged item in merge order; a native stack's layers share its merge.
        const mergedIds = merges.flatMap(
          (entry) => entry.merged.items ?? [entry.id],
        );
        const review = await reviewObjective({
          planner: deps.planner,
          plan,
          checkout: deps.config.checkout,
          base: plan.base,
          commit: final.commit,
          merges: merges.map((entry) => entry.merged.mergeSha),
          validation: { tree: final.tree, commands: final.commands },
          artifacts: [
            { artifacts: final.artifacts ?? [] },
            ...mergedIds.map((id) => ({
              itemId: id,
              artifacts:
                (
                  state.done[stepKey(id, "validate")] as
                    | ValidateResult
                    | undefined
                )?.artifacts ?? [],
            })),
          ],
          candidates: plan.items.flatMap((item) => {
            const chosen = selection(state)(item.id);
            const work = state.done[stepKey(item.id, "work")] as
              | WorkResult
              | undefined;
            return chosen && work && mergedIds.includes(item.id)
              ? [{ item, sets: work.sets, selection: chosen }]
              : [];
          }),
          inputs: workerInputs(state, mergedIds),
          sources: await pinnedSources(state, deps, signal),
          acceptance: checkObjective(
            objectiveInputs(state).shown.blocks,
          ).objective.acceptance.map((criterion) => criterion.text),
          dir: join(deps.workDir(state.issue), "final-review"),
          ...(decisions ? { decisions } : {}),
          signal,
          log: context.log,
        });
        return reviewOutcome(review, "final:questions", () => ({
          ...hold(
            `Final review refused the integrated result:\n\n${review.kind === "refused" ? review.refused.map((r) => `- ${r.criterion}: ${r.detail}`).join("\n") : ""}\n\nFix it on the default branch and answer \`retry\`, or \`replan\` to plan the remaining work, or cancel.`,
            ["retry", "replan", "cancel"],
          ),
          keep: { [REFUSED]: true },
        }));
      }),
  };
}

// ---------------------------------------------------------------------------
// Shared

/**
 * The Objective was edited or closed after its plan was accepted: ask before
 * the next effect. `continue` keeps the plan and accepts the new text.
 */
async function objectiveEdited(
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome | undefined> {
  const { state, signal } = context;
  const issue = await deps.github.renderedIssue(state.issue, signal);
  const planned = objectiveInputs(state);
  const digest = shownDigest(
    readShown(issue.body_html, { sources: planned.writer === true }),
  );
  const accepted =
    ((state.kept ?? {})[OBJECTIVE_ACCEPTED] as string | undefined) ??
    shownDigest(planned.shown);
  if (context.answer?.answer === "continue")
    return digest === accepted
      ? undefined
      : {
          kind: "retry",
          reason: "Continuing with the edited Objective.",
          progress: true,
          keep: { [OBJECTIVE_ACCEPTED]: digest },
        };
  if (issue.state !== "open")
    return objectiveWide(
      hold(
        `Issue #${state.issue} was closed while Factory was building it. Reopen it and answer \`continue\`, or cancel.`,
        ["continue", "cancel"],
        "cancel",
      ),
    );
  if (digest !== accepted)
    return objectiveWide(
      hold(
        `Objective #${state.issue} was edited after its plan was accepted. \`continue\` keeps building this plan; \`replan\` plans again from the new text.`,
        ["continue", "replan", "cancel"],
        "replan",
      ),
    );
  return undefined;
}

/** The Objective as planning read it. */
function objectiveInputs(state: ObjectiveState): ObjectiveInputs {
  let latest = state.done.check as ObjectiveInputs;
  for (const [key, value] of Object.entries(state.done))
    if (
      /^plan:\d+:1$/.test(key) &&
      (value as { inputs?: ObjectiveInputs }).inputs
    )
      latest = (value as { inputs: ObjectiveInputs }).inputs;
  return latest;
}

/** The commit the next item builds on: the latest merge, else the plan base. */
function integrated(state: ObjectiveState, plan: Plan): string {
  let latest: MergeResult | undefined;
  for (const [key, value] of Object.entries(state.done))
    if (key.endsWith(":merge") && (value as MergeResult).integratedSha)
      if (!latest || (value as MergeResult).at > latest.at)
        latest = value as MergeResult;
  return latest?.integratedSha ?? plan.base;
}

async function pinnedSources(
  state: ObjectiveState,
  deps: BuildDeps,
  signal: AbortSignal,
) {
  const plan = state.done.plan as Plan;
  const objective = objectiveInputs(state);
  const { sources } = await planningSources(
    objective.shown,
    new BaseFiles(deps.config.checkout, plan.base, signal),
    objective.child === true,
  );
  return sources;
}

// ---------------------------------------------------------------------------
// report and cancel cleanup

/** `report`: post the outcome on the issue, close it, and remove the work files. */
function reportStep(deps: BuildDeps): Step {
  return {
    key: "report",
    deadlineMs: 10 * MINUTE,
    run: (context) =>
      guarded(deps.config.repository, async () => {
        const { state, signal } = context;
        const { github } = deps;
        // The report is this run's: an earlier run of the same issue (queued
        // again after it finished) has its own, which never counts here.
        const run = runOf(state);
        const marker = `<!-- factory:${state.issue}:report:${run} -->`;
        // Once the report is posted, the issue close that follows is Factory's
        // own: a restart after it must not read it as the operator's.
        const reported = await github.findComment(
          state.issue,
          marker,
          sinceRun(state),
          signal,
        );
        if (!reported) {
          const changed = await objectiveEdited(context, deps);
          if (changed) return changed;
        }
        const plan = state.done.plan as Plan;
        const final = state.done.final as FinalResult;
        const lines = plan.items.map((item) => {
          const published = state.done[stepKey(item.id, "publish")] as
            | PublishResult
            | undefined;
          const merged = mergeOf(state, item.id);
          return `- **${item.id}** ${item.title}${published ? ` — #${published.pr}` : ""}${merged?.mergeSha ? ` merged as \`${merged.mergeSha.slice(0, 12)}\`` : ""}`;
        });
        const repairs = Object.values(state.repairs ?? {}).reduce(
          (sum, r) => sum + r.count,
          0,
        );
        const body = `${marker}\n**Factory finished this Objective.**\n\n${lines.join("\n")}\n\nFinal validation and final review passed on \`${final.commit.slice(0, 12)}\` (${final.commands.map((c) => `\`${c}\``).join(", ")}).${repairs ? ` ${repairs} repair${repairs === 1 ? "" : "s"} along the way.` : ""}${final.media ? `\n\n${final.media}` : ""}`;
        if (!reported) {
          crashPoint("report:comment:before");
          await github.postComment(state.issue, body, signal);
          crashPoint("report:comment:after");
        }
        await github.closeIssue(
          state.issue,
          "completed",
          "report:close",
          signal,
        );
        await removeWorkFiles(state.issue, deps, signal);
        return { kind: "done" };
      }),
  };
}

/** After cancel: close Factory's open PRs, delete its branches and remove the work files. It retries; it never asks. */
export function cancelCleanupStep(deps: BuildDeps): Step {
  return {
    key: "cancel:cleanup",
    deadlineMs: 10 * MINUTE,
    run: async ({ state, signal, log }) => {
      await closeFactoryPulls(
        deps,
        state.issue,
        "cancelled",
        `Factory cancelled Objective #${state.issue}; closing this PR.`,
        signal,
      );
      // Cancel ends the Objective, so its branches go once their PRs are
      // closed (a stack's upper PRs first); a re-run reuses them instead.
      // Unguarded: a moved origin's GitRefusal is an engine error (retry or cancel) until W1-03.
      for (const branch of await deps.github.branches(
        `factory/${state.issue}/`,
        signal,
      )) {
        const kept = await deleteFactoryBranch(
          { github: deps.github, checkout: deps.config.checkout, signal },
          branch,
          "cancel:branch-delete",
        );
        if (kept) log({ event: "branch-kept", branch, reason: kept });
      }
      // The Objective's issue closes as not planned, so the queue and the
      // issue agree; the operator can reopen and queue it again. An issue
      // GitHub no longer has here (deleted, or transferred away: GitHub
      // redirects, and Factory never follows) has nothing to close: cleanup
      // goes on, so it settles.
      try {
        await deps.github.closeIssue(
          state.issue,
          "not_planned",
          "cancel:close",
          signal,
        );
      } catch (error) {
        if (!issueGone(error)) throw error;
        log({ event: "issue-gone", status: error.status });
      }
      await removeWorkFiles(state.issue, deps, signal);
      return { kind: "done" };
    },
  };
}

/**
 * Before a new run of the Objective checks the issue again: reopen the
 * issue if it is closed (a finished Objective queued again; the earlier
 * run, or the Project's "Auto-close issue" workflow, closed it), close the
 * earlier run's open PRs and remove its worktrees, so the new plan starts
 * clean. Before reopening, the card's built-in Status moves off Done, so
 * that workflow doesn't close it again; the check after sees whether the
 * issue stayed open. It asks only when GitHub refuses the reopen.
 */
export function rerunCleanupStep(deps: BuildDeps): Step {
  return {
    key: "rerun:cleanup",
    resource: "github",
    deadlineMs: 10 * MINUTE,
    run: (context) =>
      guarded(deps.config.repository, async () => {
        const { state, signal } = context;
        const closed =
          (await deps.github.issue(state.issue, signal)).state !== "open";
        try {
          // The Project's "Auto-close issue" workflow closes an issue whose
          // built-in Status reads Done, so it moves off Done first.
          if (closed) {
            const moved = await moveStatusOffDone(
              deps.github,
              deps.config,
              state.issue,
              "rerun:status",
              signal,
            );
            if (moved) context.log({ event: "status-off-done", option: moved });
          }
          await deps.github.reopenIssue(state.issue, "rerun:reopen", signal);
        } catch (error) {
          if (
            error instanceof GitHubError &&
            (error.status === 403 || error.status === 422)
          )
            return hold(
              `Issue #${state.issue} was queued again, but it is closed and GitHub refused to reopen it (${error.message.slice(0, 300)}). Reopen it yourself, then answer retry; or cancel. If the Project's "Auto-close issue" workflow closes it again, set the item's Status off Done first.`,
            );
          throw error;
        }
        await closeFactoryPulls(
          deps,
          state.issue,
          "replanned",
          `Factory is running Objective #${state.issue} again from a new plan; closing this PR from the earlier one.`,
          signal,
        );
        await removeWorkFiles(state.issue, deps, signal);
        // The check that follows sees whether it stayed open.
        return {
          kind: "done",
          keep: { [RERUN]: null, ...(closed ? { [REOPENED]: true } : {}) },
        };
      }),
  };
}

/**
 * Close every open PR of the Objective: every branch under
 * `factory/<issue>/`, whatever plan made it, so PRs of an earlier plan
 * close too. Each gets one marked comment first.
 */
async function closeFactoryPulls(
  deps: BuildDeps,
  issue: number,
  kind: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const { config, github } = deps;
  const point = kind === "cancelled" ? "cancel" : "rerun";
  for (const branch of await github.branches(`factory/${issue}/`, signal)) {
    const pulls = await github.rest<{ number: number }[]>(
      "GET",
      `/repos/${config.repository}/pulls?head=${encodeURIComponent(`${github.owner}:${branch}`)}&state=open`,
      undefined,
      signal,
    );
    for (const pull of pulls) {
      const marker = `<!-- factory:${issue}:pr-${kind}:${branch.slice(`factory/${issue}/`.length)} -->`;
      await github.upsertComment(
        pull.number,
        marker,
        `${marker}\n${text}`,
        `${point}:pr-comment`,
        signal,
      );
      crashPoint(`${point}:pr-close:before`);
      await github.rest(
        "PATCH",
        `/repos/${config.repository}/pulls/${pull.number}`,
        { state: "closed" },
        signal,
      );
      crashPoint(`${point}:pr-close:after`);
    }
  }
}

/**
 * Every worktree and selection ref of the Objective, whatever plan made
 * them, then its whole work directory: captured media, review artifacts,
 * final media and review scratch, and the planning tree.
 */
async function removeWorkFiles(
  issue: number,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<void> {
  const { checkout } = deps.config;
  const workDir = deps.workDir(issue);
  const root = dirname(worktreePath(workDir, issue, "item"));
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    // No worktrees.
  }
  for (const name of names)
    if (!name.endsWith(".shell") && !name.endsWith(".validation"))
      await removeWorktree(checkout, join(root, name), signal);
  const refs = (
    await hostGit(
      checkout,
      ["for-each-ref", "--format=%(refname)", `refs/factory/${issue}/`],
      { signal },
    )
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  for (const ref of refs)
    await hostGit(checkout, ["update-ref", "-d", ref], { signal });
  await forceRemove(workDir);
}
