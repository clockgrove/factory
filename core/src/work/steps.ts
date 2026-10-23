import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCEPT,
  type DeliveryContext,
  itemBranch,
  merge,
  mergeUnit,
  observeCi,
  type PullInput,
  publish,
  REPUBLISH,
  type Repair,
} from "../delivery.js";
import { hold, type Outcome, type Step, type StepContext } from "../engine.js";
import { defaultHead } from "../git.js";
import {
  type CandidateSet,
  captureAssets,
  destinationFinding,
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
  normalizedBody,
  type PlanningDeps,
} from "../planning/steps.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { type DeliveryUnit, unitOf, units } from "../planning/units.js";
import { correction, type RepairFinding } from "../repair.js";
import type { ReviewArtifact } from "../review/artifacts.js";
import { reviewObjective } from "../review/final.js";
import {
  type CriterionDecision,
  type ResultReview,
  receiptPath,
  reviewResult,
} from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import { validateTree } from "../validate.js";
import {
  addWorktree,
  GitRefusal,
  hostGit,
  hostGitExit,
  removeWorktree,
  worktreePath,
} from "../worktree.js";
import { collect, type HandoffNote } from "./collect.js";
import { prepareWorkPrompt, type RepairContext } from "./prompt.js";
import type { Worker, WorkerSpend } from "./worker.js";

const MINUTE = 60_000;

/** What execution needs from the installation, beyond planning. */
export interface BuildDeps extends PlanningDeps {
  /** The worker for an Objective's plan. */
  worker(plan: Plan, body: string): Worker;
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

interface MergeResult {
  mergeSha: string;
  integratedSha: string;
  at: string;
  /** A native stack's top: every layer's item, merged at `mergeSha`. */
  items?: string[];
}

/**
 * The runnable item steps, most important first (planning/schedule.ts): each
 * unsettled item whose dependencies have merged, or a native-stack layer
 * whose layer below is published. An item's first step waits, without a
 * question, while an in-flight item holds a resource it declares.
 */
export function buildSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  const plan = state.done.plan as Plan;
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
      ...(state.hold ? [state.hold.step] : []),
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
    if (item.kind === "aggregate") return aggregateStep(item);
    if (item.kind === "qa" || item.kind === "discovery")
      return notYet(item, `${item.kind} items`);
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

/** Whether every item has merged (or, for aggregates, completed). */
export function built(state: ObjectiveState): boolean {
  const plan = state.done.plan as Plan | undefined;
  return Boolean(plan?.items.every((item) => mergeOf(state, item.id)));
}

/**
 * The merge that delivered `id`: its own merge step's, or, for a lower
 * native-stack layer, the stack's merge recorded on the unit's top.
 */
function mergeOf(state: ObjectiveState, id: string): MergeResult | undefined {
  const own = state.done[stepKey(id, "merge")] as MergeResult | undefined;
  if (own) return own;
  for (const [key, value] of Object.entries(state.done))
    if (key.endsWith(":merge") && (value as MergeResult).items?.includes(id))
      return value as MergeResult;
  return undefined;
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
    run: async (context) =>
      context.answer?.answer === "replan"
        ? replanOutcome(context.state)
        : hold(
            `${problem}, so Factory can't deliver the plan as native stacks. Answer replan to plan again, or cancel.`,
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
      context.answer?.answer === "replan"
        ? Promise.resolve(replanOutcome(context.state))
        : guardedItem(() => run(item, context, deps)),
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
  const body = objectiveBody(state);
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
    if (!below) return defaultHead(config.checkout, signal);
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
  await addWorktree(config.checkout, worktree, base, signal);
  if (kept(state, item.id, "rebase")) {
    // A conflict or failed delivery: move onto the current start and replay
    // the refused change, so the worker can resolve it there. An attempt
    // that never kept its base (stopped when the layer below was repaired)
    // left files on an unknown base: start over on the current one.
    const head = await start();
    const refused = kept<string>(state, item.id, "refusedCommit");
    if (head !== base || keptBase === undefined) {
      await rebaseWorktree(
        config.checkout,
        worktree,
        base,
        head,
        refused,
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
      body,
      selection: selection(state),
      ...(own ? { kept: own.selection } : {}),
      githubToken: () => deps.github.serviceToken(),
      signal,
    });
    if (inputs.kind !== "done")
      return mediaOutcome(item, inputs, context, deps, keepAll);

    const files = new BaseFiles(config.checkout, base, signal);
    const scripts = await fixedScripts(
      finalCommands(body, config.finalValidation.requiredCommands),
      files,
    );
    const pin = packageManagerUpdate(body);
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
    const { spend, ...result } = await deps.worker(plan, body).run({
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
        afterMs: 0,
        keep: { ...keepAll, [finishedKey]: finished, [selectionKey]: null },
      };
    finished = { ...finished, sets: own.sets };
  }
  if (!finished.sets) {
    const captured = await captureAssets({
      checkout: config.checkout,
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
        afterMs: 0,
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
    checkout: config.checkout,
    worktree,
    base,
    plan,
    item,
    sandbox: config.sandbox,
    finalResponse: finished.finalResponse,
    ...(kept<string>(state, item.id, "refusedTree")
      ? { refusedTree: kept<string>(state, item.id, "refusedTree")! }
      : {}),
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
 * Move a kept worktree from `from` to `to` and replay the refused change on
 * it. Conflicts stay in the files for the worker to resolve.
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
      kept<string>(state, item.id, "refusedCommit") ?? previous?.commit ?? base,
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
 * The kept refused result as a work result, when it can be checked again
 * unchanged: its commit still exists with the refused tree, on `base`, and
 * an item with media still has the selection to write on it again. Notes
 * come back when they were kept with that commit; sets from the selection.
 */
async function refusedResult(
  state: ObjectiveState,
  item: WorkItem,
  checkout: string,
  base: string,
  signal: AbortSignal,
): Promise<WorkResult | undefined> {
  const commit = kept<string>(state, item.id, "refusedCommit");
  const tree = kept<string>(state, item.id, "refusedTree");
  if (!commit || !tree) return undefined;
  const own = kept<KeptSelection>(state, item.id, "selection");
  if (needsSelection(item) && !own) return undefined;
  const shown = await hostGitExit(
    checkout,
    ["show", "--no-patch", "--format=%P %T", `${commit}^{commit}`],
    { signal },
  );
  if (
    shown.code !== 0 ||
    shown.stdout.toString("utf8").trim() !== `${base} ${tree}`
  )
    return undefined;
  const notes = kept<{ commit: string; notes: HandoffNote[] }>(
    state,
    item.id,
    "refusedNotes",
  );
  return {
    base,
    commit,
    tree,
    notes: notes?.commit === commit ? notes.notes : [],
    sets: own?.sets ?? [],
  };
}

/** The refused result's notes, kept with its commit for `revalidate`. */
function refusedNotes(work: WorkResult) {
  return { commit: work.commit, notes: work.notes };
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
    body: objectiveBody(state),
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
          afterMs: 0,
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
          // The worker's own tree: collection compares the next result to it.
          [keptKey(item.id, "refusedTree")]: work.tree,
          [keptKey(item.id, "refusedCommit")]: work.commit,
          [keptKey(item.id, "refusedNotes")]: refusedNotes(work),
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
        [keptKey(item.id, "refusedTree")]: work.tree,
        [keptKey(item.id, "refusedCommit")]: work.commit,
        [keptKey(item.id, "refusedNotes")]: refusedNotes(work),
      },
      context,
      deps,
    ),
  );
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
      ...(branch ? { baseBranch: branch } : {}),
    },
  );
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
  const work = context.state.done[stepKey(item.id, "work")] as WorkResult;
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
      [keptKey(item.id, "refusedCommit")]: work.commit,
      [keptKey(item.id, "refusedTree")]: work.tree,
      [keptKey(item.id, "refusedNotes")]: refusedNotes(work),
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
 */
function repairOutcome(
  item: WorkItem,
  from: Phase,
  finding: string,
  keep: Record<string, unknown>,
  context: StepContext,
  deps: BuildDeps,
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
  const moved: Record<string, unknown> = {
    [keptKey(item.id, "selection")]: media ? null : (own ?? null),
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
      moved[keptKey(layer.id, "refusedCommit")] = work.commit;
      Object.assign(
        moved,
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
    clear: [
      ...new Set([
        ...Object.keys(state.done),
        ...items.flatMap((item) => PHASES.map((p) => stepKey(item.id, p))),
      ]),
    ],
    keep: Object.fromEntries(
      Object.keys(state.kept ?? {}).map((key) => [key, null]),
    ),
  };
}

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
export function finalStep(deps: BuildDeps): Step {
  return {
    key: "final",
    resource: "cpu",
    deadlineMs: 60 * MINUTE,
    run: (context) =>
      guardedItem(async () => {
        const { state, signal } = context;
        const { config } = deps;
        const plan = state.done.plan as Plan;
        if (context.answer?.answer === "replan") return replanOutcome(state);
        const head = await defaultHead(config.checkout, signal);
        for (const item of plan.items) {
          const merged = state.done[stepKey(item.id, "merge")] as
            | MergeResult
            | undefined;
          if (!merged?.mergeSha) continue;
          const on = await hostGitExit(
            config.checkout,
            ["merge-base", "--is-ancestor", merged.mergeSha, head],
            { signal },
          );
          if (on.code !== 0)
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
          body: objectiveBody(state),
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

/** `final-review`: every Objective criterion against the integrated result. */
export function finalReviewStep(deps: BuildDeps): Step {
  return {
    key: "final-review",
    deadlineMs: 45 * MINUTE,
    run: (context) =>
      guardedItem(async () => {
        const { state, signal } = context;
        if (context.answer?.answer === "replan") return replanOutcome(state);
        // A fix on the default branch: validate the new head before reviewing again.
        if (context.answer?.answer === "retry")
          return {
            kind: "repair",
            finding: "Final review runs again after the operator's fix.",
            target: "final",
            clear: ["final", "final-review"],
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
          sources: await pinnedSources(state, deps, signal),
          dir: join(deps.workDir(state.issue), "final-review"),
          ...(decisions ? { decisions } : {}),
          signal,
          log: context.log,
        });
        return reviewOutcome(review, "final:questions", () =>
          hold(
            `Final review refused the integrated result:\n\n${review.kind === "refused" ? review.refused.map((r) => `- ${r.criterion}: ${r.detail}`).join("\n") : ""}\n\nFix it on the default branch and answer \`retry\`, or \`replan\` to plan the remaining work, or cancel.`,
            ["retry", "replan", "cancel"],
          ),
        );
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
  const issue = await deps.github.issue(state.issue, signal);
  const body = normalizedBody(issue.body);
  const accepted = normalizedBody(
    ((state.kept ?? {})["objective:accepted"] as string | undefined) ??
      objectiveBody(state),
  );
  if (context.answer?.answer === "continue")
    return body === accepted
      ? undefined
      : {
          kind: "retry",
          reason: "Continuing with the edited Objective.",
          afterMs: 0,
          keep: { "objective:accepted": body },
        };
  if (issue.state !== "open")
    return hold(
      `Issue #${state.issue} was closed while Factory was building it. Reopen it and answer \`continue\`, or cancel.`,
      ["continue", "cancel"],
      "cancel",
    );
  if (body !== accepted)
    return hold(
      `Objective #${state.issue} was edited after its plan was accepted. \`continue\` keeps building this plan; \`replan\` plans again from the new text.`,
      ["continue", "replan", "cancel"],
      "replan",
    );
  return undefined;
}

/** The Objective body as planning read it. */
function objectiveBody(state: ObjectiveState): string {
  let latest = (state.done.check as { body: string }).body;
  for (const [key, value] of Object.entries(state.done))
    if (
      /^plan:\d+:1$/.test(key) &&
      (value as { inputs?: { body: string } }).inputs
    )
      latest = (value as { inputs: { body: string } }).inputs.body;
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
  const { sources } = await planningSources(
    objectiveBody(state),
    new BaseFiles(deps.config.checkout, plan.base, signal),
  );
  return sources;
}

/** Item steps map Git refusals to a hold; everything else goes through planning's mapping. */
async function guardedItem(work: () => Promise<Outcome>): Promise<Outcome> {
  return guarded(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GitRefusal) return hold(error.message);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// report and cancel cleanup

/** `report`: post the outcome on the issue, close it, and remove the work files. */
export function reportStep(deps: BuildDeps): Step {
  return {
    key: "report",
    deadlineMs: 10 * MINUTE,
    run: (context) =>
      guardedItem(async () => {
        const { state, signal } = context;
        const { config, github } = deps;
        if (context.answer?.answer === "replan") return replanOutcome(state);
        const marker = `<!-- factory:${state.issue}:report -->`;
        // Once the report is posted, the issue close that follows is Factory's
        // own: a restart after it must not read it as the operator's.
        const reported = await github.findComment(
          state.issue,
          marker,
          undefined,
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
        if (!reported) await github.postComment(state.issue, body, signal);
        const issue = await github.issue(state.issue, signal);
        if (issue.state === "open")
          await github.rest(
            "PATCH",
            `/repos/${config.repository}/issues/${state.issue}`,
            { state: "closed", state_reason: "completed" },
            signal,
          );
        await removeWorkFiles(state, deps, signal);
        return { kind: "done" };
      }),
  };
}

/** After cancel: close Factory's open PRs and remove the work files. It retries; it never asks. */
export function cancelCleanupStep(deps: BuildDeps): Step {
  return {
    key: "cancel:cleanup",
    deadlineMs: 10 * MINUTE,
    run: async ({ state, signal }) => {
      const plan = state.done.plan as Plan | undefined;
      const { config, github } = deps;
      for (const item of plan?.items ?? []) {
        const branch = `${config.repository.split("/")[0]}:${itemBranch(state.issue, item.id)}`;
        const pulls = await github.rest<{ number: number }[]>(
          "GET",
          `/repos/${config.repository}/pulls?head=${encodeURIComponent(branch)}&state=open`,
          undefined,
          signal,
        );
        for (const pull of pulls) {
          const marker = `<!-- factory:${state.issue}:pr-cancelled:${item.id} -->`;
          if (
            !(await github.findComment(pull.number, marker, undefined, signal))
          )
            await github.postComment(
              pull.number,
              `${marker}\nFactory cancelled Objective #${state.issue}; closing this PR.`,
              signal,
            );
          await github.rest(
            "PATCH",
            `/repos/${config.repository}/pulls/${pull.number}`,
            { state: "closed" },
            signal,
          );
        }
      }
      // The Objective's issue closes as not planned, so the queue and the
      // issue agree; the operator can reopen and queue it again.
      const issue = await github.issue(state.issue, signal);
      if (issue.state === "open")
        await github.rest(
          "PATCH",
          `/repos/${config.repository}/issues/${state.issue}`,
          { state: "closed", state_reason: "not_planned" },
          signal,
        );
      await removeWorkFiles(state, deps, signal);
      return { kind: "done" };
    },
  };
}

/** The Objective's worktrees, selection refs, captured media, review artifacts and final media scratch. */
async function removeWorkFiles(
  state: ObjectiveState,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<void> {
  const plan = state.done.plan as Plan | undefined;
  const workDir = deps.workDir(state.issue);
  for (const item of plan?.items ?? []) {
    await removeWorktree(
      deps.config.checkout,
      worktreePath(workDir, state.issue, item.id),
      signal,
    );
    await hostGit(
      deps.config.checkout,
      ["update-ref", "-d", selectionRef(state.issue, item.id)],
      { signal },
    );
  }
  for (const files of ["assets", "artifacts", "final-media"])
    await forceRemove(join(workDir, files));
}
