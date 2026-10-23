import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resultRereviews } from "../allowances.js";
import { crashPoint } from "../crash.js";
import {
  ACCEPT,
  type DeliveryContext,
  deleteFactoryBranch,
  itemBranch,
  merge,
  mergeUnit,
  type NamedCheck,
  observeCi,
  observeNamedCheck,
  type PullInput,
  publish,
  REPUBLISH,
  RESET_BRANCH,
  type Repair,
} from "../delivery.js";
import {
  hold,
  itemOf,
  type Outcome,
  objectiveWide,
  type Step,
  type StepContext,
} from "../engine.js";
import { defaultHead } from "../git.js";
import { GitHubError, issueGone } from "../github.js";
import { roleMemory } from "../knowledge/index.js";
import {
  type CandidateSet,
  captureAssets,
  destinationFinding,
  type InputRecord,
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
import { baselineQa } from "../planning/graph.js";
import { acceptedInputs, currentPlan } from "../planning/plan.js";
import { packageManagerUpdate } from "../planning/prompts.js";
import { repositoryView } from "../planning/repository.js";
import {
  objectiveNotes,
  peerNotes,
  rank,
  resourceGate,
  type ScheduleView,
} from "../planning/schedule.js";
import {
  OBJECTIVE_ACCEPTED,
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
  type DeliveryPosition,
  type DependencyResult,
  type ResultReview,
  receiptPath,
  reviewQa,
  reviewResult,
} from "../review/result.js";
import { type ObjectiveBlock, readShown, shownDigest } from "../shown.js";
import { type Answer, type ObjectiveState, runOf, sinceRun } from "../state.js";
import { headAndTail } from "../text.js";
import { validateTree, validationDeadlineMs } from "../validate.js";
import {
  addWorktree,
  hostGit,
  hostGitExit,
  isAncestor,
  removeWorktree,
  worktreePath,
} from "../worktree.js";
import { collect, type HandoffNote } from "./collect.js";
import { discover, discoveryInputs } from "./discovery.js";
import {
  fact,
  facts,
  itemsWith,
  type KeptSelection,
  type Refused,
  written,
} from "./facts.js";
import { type MergeResult, mergeOf } from "./merged.js";
import { prepareWorkPrompt, type RepairContext } from "./prompt.js";
import type { Worker } from "./worker.js";

const MINUTE = 60_000;
/** What a kept validation finding holds of a failed run's output. */
const KEPT_OUTPUT_HEAD = 32_000;
const KEPT_OUTPUT_TAIL = 96_000;

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
 * Facts that outlive repairs are kept in `state.kept` (work/facts.ts).
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

interface WorkResult {
  base: string;
  commit: string;
  tree: string;
  notes: HandoffNote[];
  validated?: { tree: string; commands: string[] };
  /** The candidate media sets captured; empty when the item has no select step. */
  sets: CandidateSet[];
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
function buildSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  const plan = currentPlan(state)!;
  if (plan.split) return [splitPending(plan.split.children.length)];
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
    // The planner is offered only executable kinds; a saved plan from
    // another build may still hold one this build can't run.
    if (!executable(item.kind)) return notYet(item, `${item.kind} items`);
    const place = layerOf(item.id);
    const phase = phasesOf(item, place).find((p) => !done(item.id, p));
    // The top merges the stack once every layer's checks are ready.
    if (
      !phase ||
      (phase === "merge" &&
        place?.unit.items.some((layer) => !done(layer.id, "ci")))
    )
      return undefined;
    if (phase === "work" && item.kind === "discovery")
      return discoveryStep(item, deps);
    // Aggregates, QA and discovery deliver nothing: their merge step settles them.
    if (phase === "merge" && (item.kind ?? "work") !== "work")
      return settleStep(item);
    return itemStep(item, phase, deps, place);
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
  if (!plan || plan.split) return [];
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
  // A split delivers through its children, which aren't created yet.
  if (!plan || plan.split) return false;
  return plan.items.every((item) => mergeOf(state, item.id));
}

/** An item's place in a native stack of more than one item: its unit and layer. */
type StackPlace = { unit: DeliveryUnit; layer: number };

/** The plan's native stacks under this installation's delivery; none for regular PRs. */
function stackOf(
  plan: Plan,
  deps: BuildDeps,
): ReturnType<typeof units> | undefined {
  return deps.config.delivery.kind === "native-stack" ? units(plan) : undefined;
}

/** The item's place when it is in a native stack of more than one item. */
function multiLayer(
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
 * reviews the integrated result, then settles; discovery observes (its
 * work step, work/discovery.ts), then settles.
 */
function phasesOf(item: WorkItem, place: StackPlace | undefined): Phase[] {
  if (item.kind === "aggregate") return ["merge"];
  if (item.kind === "qa") return ["validate", "review", "merge"];
  if (item.kind === "discovery") return ["work", "merge"];
  const top = !place || place.layer === place.unit.items.length - 1;
  return PHASES.filter(
    (p) => (p !== "select" || needsSelection(item)) && (p !== "merge" || top),
  );
}

/** The native-stack layer below the item, whose published head it builds on. */
function layerBelow(place: StackPlace | undefined): WorkItem | undefined {
  return place?.unit.items[place.layer - 1];
}

/** The PR base of a native-stack layer above the bottom: the branch below it. */
function baseBranch(
  issue: number,
  place: StackPlace | undefined,
): string | undefined {
  const below = layerBelow(place);
  return below ? itemBranch(issue, below.id) : undefined;
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

function itemStep(
  item: WorkItem,
  phase: Phase,
  deps: BuildDeps,
  place: StackPlace | undefined,
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
      : phase === "validate"
        ? { resource: "cpu" as const }
        : {}),
    deadlineMs:
      phase === "work"
        ? 2 * 60 * MINUTE
        : phase === "ci"
          ? 10 * MINUTE
          : phase === "validate"
            ? validationDeadlineMs(item, commandTimeoutMs(deps))
            : 45 * MINUTE,
    run: (context) => run(item, context, deps, place),
  };
}

/** Each validation command's limit, in ms. */
function commandTimeoutMs(deps: BuildDeps): number {
  return deps.config.validation.commandTimeoutSeconds * 1000;
}

// ---------------------------------------------------------------------------
// work

async function workStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const { shown } = acceptedInputs(state);
  const body = shown.body;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  const media = mediaDirectory(workDir, item.id);
  // An item builds on the default branch as it is when it starts, which
  // holds every merged dependency; a native-stack layer above the bottom
  // builds on the layer below's current delivered head: the head a merge
  // check named (`onto`), else its CI's (GitHub may have updated the
  // branch), else its published one. It keeps that base across repairs.
  const below = layerBelow(place);
  const start = async () => {
    if (!below) return defaultHead(config.checkout, config.repository, signal);
    const delivered = (phase: Phase) =>
      (state.done[stepKey(below.id, phase)] as { head: string } | undefined)
        ?.head;
    return (
      fact(state, "onto", item.id) ?? delivered("ci") ?? delivered("publish")!
    );
  };
  const keptBase = fact(state, "base", item.id);
  let base = keptBase ?? (await start());
  const added = await addWorktree(config.checkout, worktree, base, signal);
  let replayed = false;
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
  } else if (fact(state, "rebase", item.id)) {
    // A conflict or failed delivery: move onto the current start and replay
    // the kept change, so the worker can resolve it there.
    const head = await start();
    const replay = fact(state, "refused", item.id)?.commit;
    if (head !== base) {
      replayed = await rebaseWorktree(
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
  const keepBase = facts({ base, rebase: false, onto: null }, item.id);
  let finished = fact(state, "finished", item.id);
  let own = fact(state, "selection", item.id);
  // A conflict repair whose replay applied cleanly onto the change's own
  // base is mechanical: the replayed change is the result, collected,
  // validated and reviewed again with no worker run. A media item's
  // worker runs, for its candidates.
  if (
    !finished &&
    replayed &&
    !needsSelection(item) &&
    fact(state, "finding", item.id)?.kind === "conflict"
  )
    finished = {
      finalResponse: `Factory replayed the previous result onto ${base} with no conflict.`,
      replayed: true,
    };
  let keepAll: Record<string, unknown> = keepBase;
  // The worker finished and collection asked: `repair` sends the result
  // back; any other answer collects it again.
  if (finished && context.answer?.answer === "repair") {
    const finding = `The operator sent this result back for repair${context.answer.text ? `: ${context.answer.text}` : "."}`;
    return repairOutcome(item, "work", finding, context.state, place, {
      keep: keepBase,
    });
  }
  if (!finished && context.answer?.answer === "revalidate") {
    // The operator says the refused result is correct and Factory's check
    // was at fault: it is the step's result again, unchanged, with no
    // worker run, collection or repair. Only reads: a rerun does the same.
    // The engine charged it to resultRereviews when the answer landed.
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
        ...facts({ finished: null, finding: null, refused: null }, item.id),
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
      keepAll = { ...keepAll, ...facts({ selection: null }, item.id) };
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
      return mediaOutcome(item, inputs, context, place, keepAll);
    // Review gets the same inputs (InputRecord): the last ones resolved.
    keepAll = { ...keepAll, ...facts({ inputs: inputs.value }, item.id) };

    const files = new BaseFiles(config.checkout, base, signal);
    const scripts = await fixedScripts(
      finalCommands(shown.blocks, config.finalValidation.requiredCommands),
      files,
    );
    const pin = packageManagerUpdate(shown.blocks);
    const memory = await itemMemory("work", item, context, deps, base);
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
      discoveryInputs: discoveryInputs(state, item),
      ...(memory ? { memory } : {}),
      signal,
    });
    if ("problem" in prepared)
      return withKeep(
        hold(prepared.problem, ["retry", "replan", "cancel"]),
        keepAll,
      );

    const spent = fact(state, "spend", item.id);
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
    if (spend) keepAll = { ...keepAll, ...facts({ spend }, item.id) };
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
        keep: { ...keepAll, ...facts({ finished, selection: null }, item.id) },
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
      return mediaOutcome(item, captured, context, place, {
        ...keepAll,
        ...facts({ finished }, item.id),
      });
    if (captured.value.length)
      return {
        kind: "retry",
        reason: "Candidate media sets captured; collecting the result",
        progress: true,
        keep: {
          ...keepAll,
          ...facts(
            { finished: { ...finished, sets: captured.value } },
            item.id,
          ),
        },
      };
    finished = { ...finished, sets: [] };
  }
  const sets = finished.sets ?? [];
  // The kept copies replace the worker's staging.
  if (sets.length) await forceRemove(join(worktree, ".factory-media"));
  const keepFinished = { ...keepAll, ...facts({ finished }, item.id) };

  const collected = await collect({
    secretlintConfig: config.policy.secretlintConfig,
    worktree,
    base,
    plan,
    item,
    sandbox: config.sandbox,
    finalResponse: finished.finalResponse,
    refusedTree: refusedOf(state, item.id)?.tree,
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
        return repairOutcome(item, "work", outside, context.state, place, {
          keep: keepAll,
        });
      const done: WorkResult = {
        base,
        commit: collected.commit,
        tree: collected.tree,
        // A replay's collection has no handoff file: the notes are kept.
        notes: finished.replayed
          ? (fact(state, "refused", item.id)?.notes ?? [])
          : collected.notes,
        ...(finished.validated ? { validated: finished.validated } : {}),
        sets,
      };
      return {
        kind: "done",
        result: done,
        keep: {
          ...keepAll,
          ...facts({ finished: null, finding: null, refused: null }, item.id),
        },
      };
    }
    case "repair":
      return repairOutcome(
        item,
        "work",
        collected.finding,
        context.state,
        place,
        {
          keep: keepAll,
        },
      );
    default:
      return withKeep(collected, keepFinished);
  }
}

/** A media answer other than done as the step's outcome: `repair` goes back to the work step. */
function mediaOutcome(
  item: WorkItem,
  outcome: Exclude<MediaOutcome<unknown>, { kind: "done" }>,
  context: StepContext,
  place: StackPlace | undefined,
  keep: Record<string, unknown> = {},
  from: Phase = "work",
): Outcome {
  switch (outcome.kind) {
    case "repair":
      return repairOutcome(item, from, outcome.finding, context.state, place, {
        keep,
      });
    case "retry":
      return { kind: "retry", reason: outcome.reason, keep };
    default:
      return { ...outcome, keep };
  }
}

/**
 * Handoff notes of every item whose result was accepted (validated and
 * reviewed), by item, each with that result's commit.
 */
function acceptedNotes(
  state: ObjectiveState,
  plan: Plan,
): Map<string, (HandoffNote & { commit: string })[]> {
  const notes = new Map<string, (HandoffNote & { commit: string })[]>();
  for (const other of plan.items) {
    const work = state.done[stepKey(other.id, "work")] as
      | WorkResult
      | undefined;
    if (
      work &&
      state.done[stepKey(other.id, "validate")] &&
      state.done[stepKey(other.id, "review")]
    )
      notes.set(
        other.id,
        work.notes.map((note) => ({
          ...note,
          commit: candidate(state, other.id),
        })),
      );
  }
  return notes;
}

/** Add facts to keep to any outcome that can carry them. */
function withKeep(outcome: Outcome, keep: Record<string, unknown>): Outcome {
  if (outcome.kind === "replace") return outcome;
  return { ...outcome, keep: { ...(outcome.keep ?? {}), ...keep } };
}

/**
 * Move a kept worktree from `from` to `to` and replay the kept change
 * (`replay`) on it: that commit's own change, from its parent. Conflicts
 * stay in the files for the worker to resolve. True only when the change
 * was built on `from` and applied whole with no conflict: the worktree
 * then holds `to` plus exactly that change. A change on another base (an
 * attempt stopped after its base moved) is replayed for the worker, never
 * taken as it is.
 */
async function rebaseWorktree(
  checkout: string,
  worktree: string,
  from: string,
  to: string,
  replay: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  await hostGit(worktree, ["checkout", "--detach", "--force", to], { signal });
  await hostGit(worktree, ["clean", "-ffdx", "--", "."], { signal });
  if (!replay) return false;
  const parent = (
    await hostGit(checkout, ["rev-parse", `${replay}^`], { signal })
  )
    .toString("utf8")
    .trim();
  const diff = await hostGit(
    checkout,
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", parent, replay],
    { signal },
  );
  if (!diff.length) return false;
  // Applying may conflict; the worker resolves what remains. The patch is
  // passed as a file: its bytes need not be UTF-8.
  const patch = `${worktree}.replay.patch`;
  await writeFile(patch, diff, { mode: 0o600 });
  try {
    const applied = await hostGitExit(
      worktree,
      ["apply", "--3way", "--whitespace=nowarn", patch],
      { signal },
    );
    return applied.code === 0 && parent === from;
  } finally {
    await rm(patch, { force: true });
  }
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
  const finding = fact(state, "finding", item.id);
  // A conflict needs no diagnosis: the change was moved onto `base`.
  if (finding?.kind === "conflict")
    return {
      context: {
        finding: `${finding.detail} Factory moved the previous result onto ${base} and replayed its change; resolve every conflict the replay left (conflict markers, unmerged or missing changes) within the owned paths, keeping both the new base's changes and this item's change.`,
      },
      keep: {},
    };
  if (!history?.count || !finding) return undefined;
  const saved = fact(state, "diagnosis", item.id);
  // The operator's answer is keyed by its question: one whose correction
  // is saved (a rerun, a replayed answer) is never applied again, and a
  // newer one replaces the saved correction.
  const answered =
    context.answer?.answer === "answer" &&
    context.answer.holdId !== saved?.answered
      ? context.answer
      : undefined;
  if (saved?.repair === history.count && !answered)
    return { context: saved.context, keep: {} };
  const applied = saved?.applied ?? [];
  const plan = currentPlan(state)!;
  const previous = state.done[stepKey(item.id, "work")] as
    | WorkResult
    | undefined;
  const sources = await pinnedSources(state, deps, signal);
  const answer = answered?.text;
  const result = await correction({
    planner: deps.planner,
    plan,
    item,
    finding,
    checkout: deps.config.checkout,
    base,
    commit: refusedOf(state, item.id)?.commit ?? previous?.commit ?? base,
    sources,
    prior: applied,
    ...(answer ? { operatorAnswer: answer } : {}),
    memory: () =>
      itemMemory("diagnosis", item, context, deps, base, sources, [
        finding.kind === "review"
          ? finding.refused.map((r) => r.detail).join("\n")
          : finding.detail,
      ]),
    signal,
    log: context.log,
  });
  if (result.kind === "question") {
    const rereviewed = resultRereviews(state);
    const recheck = (await refusedResult(
      state,
      item,
      deps.config.checkout,
      base,
      signal,
    ))
      ? `\n\nIf the refused result is correct and Factory's own check was at fault (for example, the check could not see files the result has), answer \`revalidate\`: Factory runs validation, review and delivery again on the same result, unchanged, without running the worker. It doesn't count as a repair; it is a result rereview, and this Objective has used ${rereviewed.used} of ${rereviewed.allowed} (autonomy.allowances.resultRereviews).`
      : "";
    return {
      hold: hold(
        `Work Item ${item.id} needs your decision before it is repaired:\n\n${result.question}\n\nAnswer \`answer <text>\` to send the worker your guidance, or \`retry\` to diagnose the failure again.${recheck}`,
        [
          "answer",
          {
            answer: "retry",
            family: "retry",
            consequence: "Diagnoses the failure again.",
          },
          ...(recheck
            ? [
                {
                  answer: "revalidate",
                  family: "accept",
                  consequence:
                    "Validates, reviews and delivers the same result again, without the worker; uses a result rereview.",
                } as const,
              ]
            : []),
          "cancel",
        ],
      ),
    };
  }
  // The operator's answer reaches the worker as their guidance, never as
  // Factory's diagnosis.
  const repairContextValue: RepairContext = {
    finding: result.correction.failure,
    ...(result.correction.source === "operator"
      ? { operator: result.correction.correction }
      : {
          correction: {
            diagnosis: result.correction.diagnosis,
            correction: result.correction.correction,
          },
        }),
    ...(finding.kind === "review" ? { fromReview: true } : {}),
  };
  return {
    context: repairContextValue,
    keep: facts(
      {
        diagnosis: {
          repair: history.count,
          context: repairContextValue,
          applied: [...applied, result.finding],
          ...(answered ? { answered: answered.holdId } : {}),
        },
      },
      item.id,
    ),
  };
}

/** The one writer of the refused fact, from the work result a repair clears. */
function refusedFact(
  id: string,
  work: WorkResult,
  refused: boolean,
): Record<string, unknown> {
  return facts(
    {
      refused: {
        commit: work.commit,
        tree: work.tree,
        notes: work.notes,
        ...(refused ? {} : { replayOnly: true as const }),
      },
    },
    id,
  );
}

/** The kept result the latest repair refused, if it refused one. */
function refusedOf(state: ObjectiveState, id: string): Refused | undefined {
  const refused = fact(state, "refused", id);
  return refused?.replayOnly ? undefined : refused;
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
  const refused = refusedOf(state, item.id);
  if (!refused) return undefined;
  const own = fact(state, "selection", item.id);
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
  const { commit, tree, notes } = refused;
  return { base, commit, tree, notes, sets: own?.sets ?? [] };
}

// ---------------------------------------------------------------------------
// validate

async function validateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  if (item.kind === "qa") return qaValidateStep(item, context, deps);
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
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
    blocks: acceptedInputs(state).shown.blocks,
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", item.id),
    },
    media: validationMembers(plan, item, selection(state)),
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
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
      const sameAsWorker =
        work.validated?.tree === result.tree &&
        JSON.stringify(work.validated.commands) ===
          JSON.stringify(result.commands);
      const rerun = fact(state, "flaky", item.id);
      if (sameAsWorker && rerun?.tree !== result.tree && result.failed)
        return {
          kind: "retry",
          reason: `\`${result.failed.command}\` failed on a tree the worker's own validation passed; running it once more.`,
          progress: true,
          keep: facts(
            { flaky: { tree: result.tree, command: result.failed.command } },
            item.id,
          ),
        };
      // State is saved on every step: it keeps a bounded finding. Output
      // longer than that (up to the raised review-artifact stream bounds)
      // is kept whole in a file for the operator; no model can read it.
      let keptOutput = result.output;
      if (result.output.length > KEPT_OUTPUT_HEAD + KEPT_OUTPUT_TAIL) {
        const outputFile = join(
          workDir,
          "outputs",
          item.id,
          `${result.tree}.txt`,
        );
        await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
        await writeFile(outputFile, result.output, { mode: 0o600 });
        keptOutput = `${headAndTail(result.output, KEPT_OUTPUT_HEAD, KEPT_OUTPUT_TAIL)}\n[The complete output is kept for the operator at ${outputFile}; it is not readable from the worker's checkout.]`;
      }
      return repairOutcome(
        item,
        "validate",
        { kind: "failure", detail: keptOutput },
        context.state,
        place,
        { shown: result.detail },
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
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state, signal } = context;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const question = selectionQuestion(
    plan,
    item,
    work.sets,
    mediaDirectory(workDir, item.id),
  );
  const answer = context.answer;
  const own = fact(state, "selection", item.id);
  let read: ReturnType<typeof readSelection>;
  let decided: { by: string; at: string };
  if (!answer && own && work.sets.some((s) => s.id === own.selection.set.id)) {
    read = {
      kind: "chosen",
      set: own.selection.set,
      bound: own.selection.bound,
      ...(own.selection.reason ? { reason: own.selection.reason } : {}),
    };
    decided = own.selection;
  } else {
    if (
      !answer ||
      !question.options.some(
        (option) => option.answer === answer.answer.toLowerCase(),
      )
    )
      return question;
    read = readSelection(plan, item, work.sets, answer);
    decided = answer;
  }
  if (read.kind === "invalid")
    return { ...question, question: `${read.problem}\n\n${question.question}` };
  if (read.kind === "repair") {
    const finding = `The operator asked for new candidates${answer?.text ? `: ${answer.text}` : "."}`;
    return repairOutcome(item, "select", finding, context.state, place);
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
    return mediaOutcome(item, made, context, place, {}, "select");
  const done: Selection = {
    commit: made.value.commit,
    tree: made.value.tree,
    set: read.set,
    bound: read.bound,
    by: decided.by,
    at: decided.at,
    ...(read.reason ? { reason: read.reason } : {}),
  };
  return { kind: "done", result: done };
}

// ---------------------------------------------------------------------------
// review

async function reviewStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  if (item.kind === "qa") return qaReviewStep(item, context, deps);
  const { state, signal } = context;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const worktree = worktreePath(
    deps.workDir(state.issue),
    state.issue,
    item.id,
  );
  const decisions = criterionDecisions(
    context,
    validated.tree,
    fact(state, "questions", item.id),
  );
  const chosen = selection(state)(item.id);
  const position: DeliveryPosition = place
    ? {
        kind: "native-stack",
        layer: place.layer + 1,
        layers: place.unit.items.length,
        predecessor: place.unit.items[place.layer - 1]?.id ?? null,
      }
    : { kind: "regular" };
  const memory = await itemMemory(
    "result-review",
    item,
    context,
    deps,
    work.base,
  );
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
    peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
    ...(memory ? { memory } : {}),
    ...(validated.artifacts ? { artifacts: validated.artifacts } : {}),
    decisions,
    delivery: position,
    dependencies: await dependencyResults(
      state,
      item,
      deps.config.checkout,
      work.base,
      signal,
    ),
    signal,
    log: context.log,
  });
  return reviewOutcome(
    review,
    (questions) => facts({ questions }, item.id),
    () =>
      repairOutcome(
        item,
        "review",
        {
          kind: "review",
          tree: review.tree,
          refused: review.kind === "refused" ? review.refused : [],
        },
        context.state,
        place,
      ),
  );
}

/** The head an item's PR delivered: its CI step's (GitHub may have updated the branch), else its published one. */
function deliveredHead(state: ObjectiveState, id: string): string | undefined {
  return (
    (state.done[stepKey(id, "ci")] as { head: string } | undefined)?.head ??
    (state.done[stepKey(id, "publish")] as PublishResult | undefined)?.head
  );
}

/** The read-only inputs each item's worker last got, for review. */
function workerInputs(state: ObjectiveState, ids: string[]): InputRecord[] {
  return ids.map((id) => ({
    item: id,
    inputs: fact(state, "inputs", id) ?? [],
  }));
}

/**
 * Each item `item` depends on, transitively, with its accepted result: its
 * merge, or for a native-stack layer below, its published PR. Ready items
 * have every dependency delivered; one that isn't is left out.
 */
async function dependencyResults(
  state: ObjectiveState,
  item: WorkItem,
  checkout: string,
  base: string,
  signal: AbortSignal,
): Promise<DependencyResult[]> {
  const plan = currentPlan(state)!;
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  const closure = new Set<string>();
  const visit = (id: string) => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const parent of byId.get(id)?.dependencies ?? []) visit(parent);
  };
  for (const id of item.dependencies) visit(id);
  const results: DependencyResult[] = [];
  const contains = async (commit: string) =>
    (
      await hostGitExit(
        checkout,
        ["merge-base", "--is-ancestor", commit, base],
        {
          signal,
        },
      )
    ).code === 0;
  for (const entry of plan.items) {
    if (!closure.has(entry.id)) continue;
    const merged = mergeOf(state, entry.id);
    const published = state.done[stepKey(entry.id, "publish")] as
      | PublishResult
      | undefined;
    if (entry.kind === "aggregate") {
      if (merged)
        results.push({
          id: entry.id,
          title: entry.title,
          status: "aggregate-complete",
          inReviewedBase: true,
        });
      continue;
    }
    const work = state.done[stepKey(entry.id, "work")] as
      | WorkResult
      | undefined;
    const validated = state.done[stepKey(entry.id, "validate")] as
      | ValidateResult
      | undefined;
    if (!work || !validated || (!merged && !published)) continue;
    const head = deliveredHead(state, entry.id);
    const delivered = merged?.mergeSha ?? head;
    results.push({
      id: entry.id,
      title: entry.title,
      status: merged ? "merged" : "published-unmerged",
      resultCommitSha: candidate(state, entry.id),
      resultTreeSha: validated.tree,
      validationCommands: validated.commands,
      ...(published ? { pullRequest: published.pr } : {}),
      ...(head ? { deliveredHeadSha: head } : {}),
      ...(merged ? { mergeCommitSha: merged.mergeSha } : {}),
      inReviewedBase: delivered ? await contains(delivered) : false,
    });
  }
  return results;
}

/** Pass is done, refused repairs, needs-human asks (keeping the criteria it asks about with `pending`). */
function reviewOutcome(
  review: ResultReview,
  pending: (criteria: string[]) => Record<string, unknown>,
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
      [
        {
          answer: "accept",
          family: "accept",
          consequence: "Accepts the result as it is.",
        },
        {
          answer: "refuse",
          family: "refuse",
          consequence: "Sends the result back for repair with your reason.",
        },
        "cancel",
      ],
    ),
    keep: pending(review.questions.map((q) => q.criterion)),
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

function delivery(context: StepContext, deps: BuildDeps): DeliveryContext {
  return {
    github: deps.github,
    checkout: deps.config.checkout,
    signal: context.signal,
  };
}

async function publishStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state } = context;
  const changed = await objectiveEdited(context, deps);
  if (changed) return changed;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const pushed = fact(state, "pushed", item.id) ?? [];
  const republish = Boolean(fact(state, "republish", item.id));
  // Kept first, so it outlives a failure on the way (the engine's) and
  // the questions that follow.
  if (context.answer?.answer === REPUBLISH && !republish)
    return {
      kind: "retry",
      reason: "Republishing on a new PR.",
      progress: true,
      keep: facts({ republish: true }, item.id),
    };
  const rerun = fact(state, "flaky", item.id);
  const flaky = rerun?.tree === validated.tree ? rerun : undefined;
  const commit = candidate(state, item.id);
  const branch = baseBranch(state.issue, place);
  const result = await publish(delivery(context, deps), {
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
    run: runOf(state),
    secrets: deps.config.secrets,
    // The operator's `publish` counts only for the finding it answered:
    // the digest kept when the hold was raised, never the hold's text,
    // which quotes worker-chosen paths.
    ...(context.answer?.answer === "publish"
      ? { allowSecret: fact(state, "secret", item.id) }
      : {}),
  });
  if (result.kind === "secret")
    return context.answer?.answer === "repair"
      ? repairOutcome(item, "publish", result.finding, context.state, place, {
          refusesResult: true,
        })
      : {
          ...hold(
            `${result.finding}\n\nPublication stopped; nothing was pushed (finding \`${result.digest}\`). Answer repair to have the worker remove the value; publish if the matched text isn't a secret, which lets exactly this finding on this commit through once; or cancel. Rotate the secret if the worker may have written it anywhere else.`,
            [
              {
                answer: "repair",
                family: "repair",
                consequence: "The worker removes the value.",
              },
              {
                answer: "publish",
                family: "accept",
                consequence:
                  "Lets exactly this finding on this commit through, and publishes.",
              },
              "cancel",
            ],
          ),
          keep: facts({ secret: result.digest }, item.id),
        };
  // An empty change, or a pointer whose LFS object is missing: a fault in
  // the result itself, not a conflict, so no rebase.
  if (result.kind === "empty" || result.kind === "repair")
    return repairOutcome(item, "publish", result.finding, context.state, place);
  if (result.kind !== "published") return result;
  const done: PublishResult = {
    pr: result.pr,
    head: result.head,
    merged: result.merged,
  };
  return {
    kind: "done",
    result: done,
    keep: facts(
      { pushed: [...new Set([...pushed, commit])], republish: false },
      item.id,
    ),
  };
}

function pullInput(
  state: ObjectiveState,
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
): PullInput {
  const plan = currentPlan(state)!;
  const published = state.done[stepKey(item.id, "publish")] as PublishResult;
  const branch = baseBranch(state.issue, place);
  return {
    issue: state.issue,
    item: item.id,
    pr: published.pr,
    head: published.head,
    pushedHeads: fact(state, "pushed", item.id) ?? [],
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
  place: StackPlace | undefined,
): Promise<Outcome> {
  const result = await observeCi(
    delivery(context, deps),
    pullInput(context.state, item, context, place),
  );
  switch (result.kind) {
    case "ready":
      return {
        kind: "done",
        result: { head: result.head, merged: result.merged },
      };
    case "repair":
      return deliveryRepair(item, context, place, result, "ci");
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
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state } = context;
  const plan = currentPlan(state)!;
  if (place) return mergeStack(place.unit, context, deps);
  const ci = state.done[stepKey(item.id, "ci")] as { head: string };
  const result = await merge(delivery(context, deps), {
    ...pullInput(state, item, context, place),
    head: ci.head,
    integrated: integrated(state, plan),
  });
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
      return deliveryRepair(item, context, place, result, "merge");
    case "republish":
      return republishOutcome(item, result.reason);
    default:
      return result;
  }
}

/**
 * Delete the merged items' branches (deleteFactoryBranch), bottom first:
 * each one's PR base is the item before it, the native-stack layer below.
 * A kept one is logged.
 */
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
  for (const [at, item] of items.entries()) {
    const branch = itemBranch(context.state.issue, item.id);
    const below = items[at - 1];
    const kept = await deleteFactoryBranch(
      where,
      branch,
      "deliver:branch-delete",
      below && itemBranch(context.state.issue, below.id),
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
  const plan = currentPlan(state)!;
  const top = unit.items[unit.items.length - 1] as WorkItem;
  const layers = unit.items.map((layer, at) => ({
    ...pullInput(state, layer, context, { unit, layer: at }),
    head: (state.done[stepKey(layer.id, "ci")] as { head: string }).head,
  })) as [PullInput, ...PullInput[]];
  const result = await mergeUnit(
    delivery(context, deps),
    layers,
    integrated(state, plan),
    context.answer?.answer === ACCEPT,
  );
  const layer = (id: string) =>
    unit.items.find((entry) => entry.id === id) ?? top;
  const placeOf = (id: string): StackPlace => ({
    unit,
    layer: unit.items.indexOf(layer(id)),
  });
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
      return deliveryRepair(
        layer(result.item),
        context,
        placeOf(result.item),
        result,
        "merge",
      );
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
  place: StackPlace | undefined,
  repair: Repair,
  phase: Phase,
): Outcome {
  return repairOutcome(
    item,
    phase,
    { kind: repair.conflict ? "conflict" : "failure", detail: repair.finding },
    context.state,
    place,
    {
      keep: facts(
        {
          ...(repair.conflict?.onto ? { onto: repair.conflict.onto } : {}),
          rebase: true,
        },
        item.id,
      ),
    },
  );
}

function republishOutcome(item: WorkItem, reason: string): Outcome {
  return {
    kind: "repair",
    finding: reason,
    target: stepKey(item.id, "publish"),
    clear: (["publish", "ci", "merge"] as const).map((p) =>
      stepKey(item.id, p),
    ),
    keep: facts({ republish: true }, item.id),
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
 * Every cleared work result (the item's and each layer's above) is kept
 * as the `refused` fact, so a rebase never drops the change.
 *
 * The repair keeps `finding` as the item's finding fact (a string is a
 * failure with that detail) for the next attempt's repair context, and
 * shows `shown`, else its detail or refused criteria.
 *
 * `refusesResult`: the repair refuses the item's own work result tree
 * (validate, review, CI, merge, a secret it writes), so the worker must
 * change it and the item's refused fact records it as refused. A select or
 * publish media repair (new candidates, a selection that couldn't be
 * written, LFS objects) may rightly end on the same tracked tree, so its
 * fact is `replayOnly`, and a correct fix is never "no change". The layers
 * above are moved, not refused: theirs is `replayOnly` too.
 */
function repairOutcome(
  item: WorkItem,
  from: Phase,
  finding: RepairFinding | string,
  state: ObjectiveState,
  place: StackPlace | undefined,
  {
    keep = {},
    shown,
    refusesResult = from !== "select" && from !== "publish",
    fresh = false,
  }: {
    /** Other facts the repair keeps. */
    keep?: Record<string, unknown>;
    /** The finding as the repair shows it; absent: the finding's detail. */
    shown?: string;
    refusesResult?: boolean;
    /**
     * The operator's `fresh`: the item keeps nothing of its result or work
     * (no base, refused result, finding, diagnosis or selection), so the
     * next attempt starts a fresh worktree on the current base, with no
     * repair context. The layers above move as for any repair.
     */
    fresh?: boolean;
  } = {},
): Outcome {
  const kept: RepairFinding =
    typeof finding === "string"
      ? { kind: "failure", detail: finding }
      : finding;
  const text =
    shown ??
    (kept.kind === "review"
      ? kept.refused.map((r) => `${r.criterion}: ${r.detail}`).join("\n")
      : kept.detail);
  const above = place ? place.unit.items.slice(place.layer + 1) : [];
  const standing = (entry: WorkItem): KeptSelection | undefined => {
    const chosen = selection(state)(entry.id);
    const work = state.done[stepKey(entry.id, "work")] as
      | WorkResult
      | undefined;
    return chosen && work
      ? { selection: chosen, sets: work.sets }
      : fact(state, "selection", entry.id);
  };
  // The work step forgets a selection whose copies are gone.
  const own =
    written(keep, "selection", item.id) === null ? undefined : standing(item);
  const media =
    from === "select" ||
    (own !== undefined && aboutMedia(item, own.selection.set, text, kept));
  // The result being cleared, when there is one: a repair from `work`
  // itself keeps the facts of the result before it.
  const result = state.done[stepKey(item.id, "work")] as WorkResult | undefined;
  const moved: Record<string, unknown> = fresh
    ? facts(
        {
          base: null,
          rebase: null,
          onto: null,
          selection: null,
          refused: null,
          diagnosis: null,
        },
        item.id,
      )
    : {
        ...facts({ selection: media ? null : (own ?? null) }, item.id),
        ...(result ? refusedFact(item.id, result, refusesResult) : {}),
      };
  for (const layer of above) {
    const layerSelection = standing(layer);
    const work = state.done[stepKey(layer.id, "work")] as
      | WorkResult
      | undefined;
    Object.assign(
      moved,
      facts(
        {
          ...(layerSelection ? { selection: layerSelection } : {}),
          rebase: true,
          finished: null,
          onto: null,
        },
        layer.id,
      ),
    );
    if (work)
      Object.assign(
        moved,
        refusedFact(layer.id, work, false),
        facts(
          {
            finding: {
              kind: "conflict",
              detail: `Work Item ${item.id}, the stack layer below this one, is being repaired, so this change moves onto its new head.`,
            },
          },
          layer.id,
        ),
      );
  }
  return {
    kind: "repair",
    finding: text,
    target: stepKey(item.id, "work"),
    ...(kept.kind === "conflict" ? { conflict: true as const } : {}),
    clear: [item, ...above].flatMap((entry) =>
      PHASES.map((p) => stepKey(entry.id, p)),
    ),
    keep: {
      ...keep,
      ...facts({ finding: fresh ? null : kept }, item.id),
      ...moved,
      ...facts({ finished: null }, item.id),
    },
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
 * `replan` after the plan was accepted (workflow.ts `replan`): forget the
 * plan and the build, and check the Objective again from the issue and
 * the default branch. Merged work is on the default branch, so the new
 * plan starts from it.
 */
export function replanOutcome(state: ObjectiveState): Outcome {
  // Every item step, done or running: the engine stops the running ones.
  const items = currentPlan(state)?.items ?? [];
  return {
    kind: "repair",
    finding: "The operator asked to replan.",
    target: "check",
    clear: [
      ...new Set([
        ...Object.keys(state.done),
        ...items.flatMap((item) => PHASES.map((p) => stepKey(item.id, p))),
      ]),
    ],
    keep: {
      ...Object.fromEntries(Object.keys(state.kept).map((key) => [key, null])),
      ...facts({ [RERUN]: true }),
    },
  };
}

/**
 * Whether `fresh` can answer a question of step `key` (engine.ts
 * `Workflow.freshable`): a Work Item of the current plan that runs a worker
 * and hasn't merged.
 */
export function freshable(state: ObjectiveState, key: string): boolean {
  const plan = currentPlan(state);
  const item = plan?.items.find((entry) => entry.id === itemOf(key));
  return (
    !!item &&
    !plan?.split &&
    executable(item.kind) &&
    item.kind !== "aggregate" &&
    !mergeOf(state, item.id)
  );
}

/**
 * The operator's `fresh` to item step `key`'s question (workflow.ts): a
 * repair of the item's work that keeps nothing of its result or work, so
 * it starts again from a fresh worktree on the current base. It counts
 * against the repair allowances like any repair, and the native-stack
 * layers above move onto its new head.
 */
export function freshOutcome(
  state: ObjectiveState,
  deps: BuildDeps,
  key: string,
  answer: Answer,
): Outcome {
  const plan = currentPlan(state)!;
  const item = plan.items.find((entry) => entry.id === itemOf(key))!;
  return repairOutcome(
    item,
    "work",
    `The operator asked for a fresh start${answer.text ? `: ${answer.text}` : "."}`,
    state,
    multiLayer(stackOf(plan, deps), item.id),
    { fresh: true },
  );
}

/**
 * Set when an Objective runs again: after a `replan` once the plan was
 * accepted, or when a finished Objective is queued again. The earlier
 * run's open PRs and work files go before the new run checks the issue.
 */
export const RERUN = "rerun";
/** The step that cleans up before a re-run; with `check`, before the Objective counts as started. */
export const RERUN_CLEANUP = "rerun:cleanup";

// ---------------------------------------------------------------------------
// read-only QA, aggregates and not-yet-ported kinds

/** A read-only QA item's validate result: the commit it checked and the named CI checks that passed. */
interface QaResult extends ValidateResult {
  commit: string;
  checks: NamedCheck[];
}

/**
 * Read-only QA checks the integrated result and delivers nothing: its
 * named CI checks, then its commands in a fresh sandboxed checkout, on the
 * default-branch commit once every dependency has merged. An Objective
 * made only of QA checks the bytes it planned on. A failing check or
 * command refuses: the item holds with the evidence.
 */
async function qaValidateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const head = await defaultHead(config.checkout, config.repository, signal);
  const problem = await integrationProblem(state, plan, head, deps, signal);
  if (problem) return problem;
  const checks: NamedCheck[] = [];
  const observed = new Set<string>();
  for (const { itemId, proof } of plan.coverage) {
    if (
      itemId !== item.id ||
      (proof.kind !== "integrated-ci" && proof.kind !== "published-ci")
    )
      continue;
    // published-ci: the check on the target dependency's delivered head.
    let commit = head;
    if (proof.kind === "published-ci") {
      const delivered = deliveredHead(state, proof.targetItem);
      if (!delivered)
        return hold(
          `Read-only QA item ${item.id} proves check ${JSON.stringify(proof.checkName)} on Work Item ${proof.targetItem}'s published PR, and it has none. Answer replan, or cancel.`,
          ["replan", "cancel"],
        );
      commit = delivered;
    }
    if (observed.has(`${proof.checkName}\n${commit}`)) continue;
    observed.add(`${proof.checkName}\n${commit}`);
    const check = await observeNamedCheck(
      delivery(context, deps),
      proof.checkName,
      commit,
    );
    if (check.kind === "refused")
      return qaRefusal(item, head, "a named CI check failed", check.finding);
    if (check.kind !== "passed") return check;
    checks.push(check.check);
  }
  const workDir = deps.workDir(state.issue);
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktreePath(workDir, state.issue, item.id)}.validation`,
    commit: head,
    item,
    plan,
    blocks: acceptedInputs(state).shown.blocks,
    ...(head !== plan.base ? { predecessor: head } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", item.id),
    },
    media: validationMembers(plan, item, selection(state)),
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
  });
  switch (result.kind) {
    case "passed": {
      const done: QaResult = {
        commit: head,
        tree: result.tree,
        commands: result.commands,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        checks,
      };
      return { kind: "done", result: done };
    }
    case "failed":
      return qaRefusal(
        item,
        head,
        result.failed
          ? `\`${result.failed.command}\` failed`
          : "its validation was refused",
        result.detail,
      );
    default:
      return result;
  }
}

/**
 * The independent review of what QA validated: its acceptance and the
 * obligations its review proves, on that commit, over this Objective's
 * merges. A refusal holds; its `retry` checks again from validation, on
 * the default branch as it is then.
 */
async function qaReviewStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const steps = [stepKey(item.id, "validate"), stepKey(item.id, "review")];
  if (context.answer?.answer === "retry" && fact(state, "qaRefused", item.id))
    return {
      kind: "repair",
      finding: `Read-only QA item ${item.id} checks the default branch again after the operator's fix.`,
      target: steps[0]!,
      clear: steps,
      keep: facts({ qaRefused: null }, item.id),
    };
  const plan = currentPlan(state)!;
  const checked = state.done[steps[0]!] as QaResult;
  const merges = objectiveMerges(state, plan).map(
    (entry) => entry.merged.mergeSha,
  );
  const review = await reviewQa({
    planner: deps.planner,
    plan,
    item,
    checkout: deps.config.checkout,
    base: plan.base,
    commit: checked.commit,
    ...(merges.length ? { merges } : {}),
    validation: checked,
    checks: checked.checks,
    sources: await pinnedSources(state, deps, signal),
    dir: `${worktreePath(deps.workDir(state.issue), state.issue, item.id)}.review`,
    peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
    ...(checked.artifacts ? { artifacts: checked.artifacts } : {}),
    decisions: criterionDecisions(
      context,
      checked.tree,
      fact(state, "questions", item.id),
    ),
    signal,
    log: context.log,
  });
  return reviewOutcome(
    review,
    (questions) => facts({ questions }, item.id),
    () => ({
      ...qaRefusal(
        item,
        checked.commit,
        "its review refused",
        review.kind === "refused"
          ? review.refused
              .map((r) => `- ${r.criterion}: ${r.detail}`)
              .join("\n")
          : "",
      ),
      keep: facts({ qaRefused: true }, item.id),
    }),
  );
}

/** A QA refusal: no worker repairs it, so it holds with the evidence. */
function qaRefusal(
  item: WorkItem,
  commit: string,
  what: string,
  evidence: string,
): Outcome {
  return hold(
    `Read-only QA item ${item.id} refused the integrated result at ${commit.slice(0, 12)}: ${what}.\n\n${evidence}\n\nAnswer \`replan\` to plan the fix, \`retry\` to check again once the default branch is fixed, or cancel.`,
    ["replan", "retry", "cancel"],
  );
}

/** A discovery item's observation: read-only, with no worker (work/discovery.ts). */
function discoveryStep(item: WorkItem, deps: BuildDeps): Step {
  return {
    key: stepKey(item.id, "work"),
    deadlineMs: 45 * MINUTE,
    run: (context) =>
      discover(item, context, {
        checkout: deps.config.checkout,
        planner: deps.planner,
        limits: deps.config.planning.discoveryLimits,
        dir: `${worktreePath(deps.workDir(context.state.issue), context.state.issue, item.id)}.discovery`,
        base: () => discoveryBase(item, context, deps),
      }),
  };
}

/**
 * The commit a discovery item observes: the plan base, unless something
 * it depends on, directly or not, has merged; then the default branch,
 * once every merge of this Objective is still on it (integrationProblem,
 * as QA checks). An Objective made only of QA and discovery observes the
 * plan base.
 */
async function discoveryBase(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<string | Outcome> {
  const { state, signal } = context;
  const plan = currentPlan(state)!;
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  const upstream = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of byId.get(id)?.dependencies ?? [])
      if (!upstream.has(dependency)) {
        upstream.add(dependency);
        visit(dependency);
      }
  };
  visit(item.id);
  if (
    baselineQa(plan.items) ||
    ![...upstream].some((id) => mergeOf(state, id)?.mergeSha)
  )
    return plan.base;
  const head = await defaultHead(
    deps.config.checkout,
    deps.config.repository,
    signal,
  );
  return (await integrationProblem(state, plan, head, deps, signal)) ?? head;
}

/** The merge step of an item that delivers nothing (aggregate, QA, discovery): it settles. */
function settleStep(item: WorkItem): Step {
  return {
    key: stepKey(item.id, "merge"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return { kind: "done", result: { settled: item.kind } };
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
        ["cancel", "retry", "replan"],
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

/** `final`: the final commands on the default branch head after every merge. */
function finalStep(plan: Plan, deps: BuildDeps): Step {
  return {
    key: "final",
    resource: "cpu",
    // Final validation, then origin's media check.
    deadlineMs:
      validationDeadlineMs(plan, commandTimeoutMs(deps)) + 15 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const { config } = deps;
      const plan = currentPlan(state)!;
      const head = await defaultHead(
        config.checkout,
        config.repository,
        signal,
      );
      const problem = await integrationProblem(state, plan, head, deps, signal);
      if (problem) return problem;
      const workDir = deps.workDir(state.issue);
      const members = validationMembers(plan, undefined, selection(state));
      const result = await validateTree({
        checkout: config.checkout,
        repository: config.repository,
        directory: join(workDir, "final"),
        commit: head,
        plan,
        blocks: acceptedInputs(state).shown.blocks,
        reviewArtifacts: {
          configured: config.reviewArtifacts,
          planned: plan.reviewArtifacts,
          dir: join(workDir, "artifacts", "final"),
        },
        media: members,
        sandbox: config.sandbox,
        commandTimeoutMs: commandTimeoutMs(deps),
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
        repushed: Boolean(fact(state, "final:repushed")),
        signal,
      });
      if (verified.kind === "retry")
        return {
          kind: "retry",
          reason: verified.reason,
          ...(verified.repushed
            ? { keep: facts({ "final:repushed": true }) }
            : {}),
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
      return {
        kind: "done",
        result: done,
        keep: facts({ "final:repushed": null }),
      };
    },
  };
}

/** `final-review`: every Objective criterion against the integrated result. */
function finalReviewStep(deps: BuildDeps): Step {
  return {
    key: "final-review",
    deadlineMs: 45 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      // A `retry` to the refusal (never to an error or a wait question):
      // the operator fixed the default branch, so validate the new head
      // before reviewing again.
      if (
        context.answer?.answer === "retry" &&
        fact(state, "final-review:refused")
      )
        return {
          kind: "repair",
          finding: "Final review runs again after the operator's fix.",
          target: "final",
          clear: ["final", "final-review"],
          keep: facts({ "final-review:refused": null }),
        };
      const plan = currentPlan(state)!;
      const final = state.done.final as FinalResult;
      const merges = objectiveMerges(state, plan);
      const decisions = criterionDecisions(
        context,
        final.tree,
        fact(state, "final-review:questions"),
      );
      // Every merged item in merge order; a native stack's layers share its merge.
      const mergedIds = merges.flatMap(
        (entry) => entry.merged.items ?? [entry.id],
      );
      const sources = await pinnedSources(state, deps, signal);
      const acceptance = checkObjective(
        acceptedInputs(state).shown.blocks,
      ).objective.acceptance.map((criterion) => criterion.text);
      const memory = await roleMemory({
        role: "final-review",
        state,
        checkout: deps.config.checkout,
        tree: final.commit,
        paths: [
          ...new Set(
            plan.items
              .filter((item) => mergedIds.includes(item.id))
              .flatMap((item) => item.ownedPaths),
          ),
        ],
        text: acceptance.join("\n"),
        supplied: sources,
        signal,
        log: context.log,
      });
      // Read-only QA checked the integrated tree too.
      const qa = plan.items.flatMap((item) => {
        const checked = state.done[stepKey(item.id, "validate")] as
          | QaResult
          | undefined;
        return item.kind === "qa" && checked && mergeOf(state, item.id)
          ? [
              {
                itemId: item.id,
                commit: checked.commit,
                checks: checked.checks,
                commands: checked.commands,
              },
            ]
          : [];
      });
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
          ...[...mergedIds, ...qa.map((entry) => entry.itemId)].map((id) => ({
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
        peerNotes: objectiveNotes(plan, acceptedNotes(state, plan)),
        ...(memory ? { memory } : {}),
        sources,
        acceptance,
        dir: join(deps.workDir(state.issue), "final-review"),
        ...(decisions ? { decisions } : {}),
        qa,
        signal,
        log: context.log,
      });
      const pending = (questions: string[]) =>
        facts({ "final-review:questions": questions });
      return reviewOutcome(review, pending, () => ({
        ...hold(
          `Final review refused the integrated result:\n\n${review.kind === "refused" ? review.refused.map((r) => `- ${r.criterion}: ${r.detail}`).join("\n") : ""}\n\nFix it on the default branch and answer \`retry\`, or \`replan\` to plan the remaining work, or cancel.`,
          ["retry", "replan", "cancel"],
        ),
        keep: facts({ "final-review:refused": true }),
      }));
    },
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
  const planned = acceptedInputs(state);
  const digest = shownDigest(
    readShown(issue.body_html, { sources: planned.writer === true }),
  );
  const accepted =
    fact(state, OBJECTIVE_ACCEPTED) ?? shownDigest(planned.shown);
  if (context.answer?.answer === "continue")
    return digest === accepted
      ? undefined
      : {
          kind: "retry",
          reason: "Continuing with the edited Objective.",
          progress: true,
          keep: facts({ [OBJECTIVE_ACCEPTED]: digest }),
        };
  if (issue.state !== "open")
    return objectiveWide(
      hold(
        `Issue #${state.issue} was closed while Factory was building it. Reopen it and answer \`continue\`, or cancel.`,
        [
          "cancel",
          {
            answer: "continue",
            family: "accept",
            consequence: "Builds on, once the issue is reopened.",
          },
        ],
      ),
    );
  if (digest !== accepted)
    return objectiveWide(
      hold(
        `Objective #${state.issue} was edited after its plan was accepted. \`continue\` keeps building this plan; \`replan\` plans again from the new text.`,
        [
          "replan",
          {
            answer: "continue",
            family: "accept",
            consequence: "Keeps building this plan.",
          },
          "cancel",
        ],
      ),
    );
  return undefined;
}

/**
 * Why the default branch head can't be checked as this Objective's
 * integrated result: an Objective made only of read-only QA qualifies the
 * bytes it planned on, so the branch must not have moved; otherwise every
 * merge must still be on it.
 */
async function integrationProblem(
  state: ObjectiveState,
  plan: Plan,
  head: string,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<Outcome | undefined> {
  if (baselineQa(plan.items))
    return head === plan.base
      ? undefined
      : hold(
          `This Objective is made only of read-only QA, which qualifies the bytes it was planned on (${plan.base.slice(0, 12)}), and the default branch has moved to ${head.slice(0, 12)}. Answer \`replan\` to plan again on the current default branch, \`retry\` once it is back at ${plan.base.slice(0, 12)}, or cancel.`,
          ["replan", "retry", "cancel"],
        );
  for (const { id, merged } of objectiveMerges(state, plan))
    if (
      !(await isAncestor(deps.config.checkout, merged.mergeSha, head, signal))
    )
      return hold(
        `Work Item ${id}'s merge \`${merged.mergeSha.slice(0, 12)}\` is not on the default branch (${head.slice(0, 12)}); someone may have reverted or force-pushed it. Restore it and answer \`retry\`, or \`replan\`.`,
        ["retry", "replan", "cancel"],
      );
  return undefined;
}

/** This Objective's merges, in merge order. */
function objectiveMerges(
  state: ObjectiveState,
  plan: Plan,
): { id: string; merged: MergeResult }[] {
  return plan.items
    .map((item) => ({
      id: item.id,
      merged: state.done[stepKey(item.id, "merge")] as MergeResult | undefined,
    }))
    .filter(
      (entry): entry is { id: string; merged: MergeResult } =>
        !!entry.merged?.mergeSha,
    )
    .sort((a, b) => a.merged.at.localeCompare(b.merged.at));
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

/**
 * Repository memory about one Work Item, for its worker, its diagnosis or
 * its result review: the worker and the review ask the same query, so the
 * review sees what the worker saw; the diagnosis searches by the failure
 * first.
 */
function itemMemory(
  role: "work" | "diagnosis" | "result-review",
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  tree: string,
  supplied: readonly { path: string; heading?: string }[] = item.citations,
  lead: readonly string[] = [],
): Promise<string> {
  return roleMemory({
    role,
    state: context.state,
    checkout: deps.config.checkout,
    tree,
    paths: item.ownedPaths,
    text: [...lead, item.title, item.goal, ...item.acceptance].join("\n"),
    supplied,
    signal: context.signal,
    log: context.log,
  });
}

async function pinnedSources(
  state: ObjectiveState,
  deps: BuildDeps,
  signal: AbortSignal,
) {
  const plan = currentPlan(state)!;
  const objective = acceptedInputs(state);
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
    run: async (context): Promise<Outcome> => {
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
      const plan = currentPlan(state)!;
      const final = state.done.final as FinalResult;
      const lines = plan.items.map((item) => {
        const published = state.done[stepKey(item.id, "publish")] as
          | PublishResult
          | undefined;
        const merged = mergeOf(state, item.id);
        const checked =
          item.kind === "qa"
            ? (state.done[stepKey(item.id, "validate")] as QaResult | undefined)
            : undefined;
        return `- **${item.id}** ${item.title}${published ? ` — #${published.pr}` : ""}${merged?.mergeSha ? ` merged as \`${merged.mergeSha.slice(0, 12)}\`` : ""}${checked ? ` checked \`${checked.commit.slice(0, 12)}\`` : ""}`;
      });
      const repairs = Object.values(state.repairs ?? {}).reduce(
        (sum, r) => sum + r.count,
        0,
      );
      const body = `${marker}\n**Factory finished this Objective.**\n\n${lines.join("\n")}\n\nFinal validation and final review passed on \`${final.commit.slice(0, 12)}\` (${final.commands.map((c) => `\`${c}\``).join(", ")}).${repairs ? ` ${repairs} repair${repairs === 1 ? "" : "s"} along the way.` : ""}${final.media ? `\n\n${final.media}` : ""}`;
      await github.ensureComment(
        state.issue,
        marker,
        body,
        "report:comment",
        signal,
        sinceRun(state),
      );
      await github.closeIssue(state.issue, "completed", "report:close", signal);
      await removeWorkFiles(state.issue, deps, signal);
      return { kind: "done" };
    },
  };
}

/** After cancel: close Factory's open PRs, delete its branches and remove the work files. It retries; it never asks. */
export function cancelCleanupStep(deps: BuildDeps): Step {
  return {
    key: "cancel:cleanup",
    deadlineMs: 10 * MINUTE,
    neverAsks: true,
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
    key: RERUN_CLEANUP,
    resource: "github",
    deadlineMs: 10 * MINUTE,
    run: async (context): Promise<Outcome> => {
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
        keep: facts({
          [RERUN]: null,
          ...(closed ? { [REOPENED]: true as const } : {}),
        }),
      };
    },
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
