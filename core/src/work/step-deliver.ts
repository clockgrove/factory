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
import { hold, itemOf, type Outcome, type StepContext } from "../engine.js";
import type { CandidateSet } from "../media.js";
import { expansionComments, expansionsOf } from "../planning/expansion.js";
import { currentPlan } from "../planning/plan.js";
import { COMMENT_LIMIT } from "../planning/steps.js";
import { executable, type WorkItem } from "../planning/types.js";
import type { DeliveryUnit } from "../planning/units.js";
import type { RepairFinding } from "../repair.js";
import { receiptPath } from "../review/result.js";
import { type Answer, type ObjectiveState, runOf } from "../state.js";
import { itemIssueOf } from "../tracking.js";
import { fact, facts, type KeptSelection, written } from "./facts.js";
import { type MergeResult, mergeOf } from "./merged.js";
import { refusedFact } from "./refused.js";
import { integrated, objectiveEdited } from "./shared.js";
import {
  type BuildDeps,
  baseBranch,
  candidate,
  multiLayer,
  PHASES,
  type Phase,
  type PublishResult,
  type StackPlace,
  selection,
  stackOf,
  stepKey,
  type ValidateResult,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// publish, ci, merge

export function delivery(
  context: StepContext,
  deps: BuildDeps,
): DeliveryContext {
  return {
    github: deps.github,
    checkout: deps.config.checkout,
    signal: context.signal,
  };
}

/**
 * Before an expansion child's first PR, its producer's settled records go
 * on the issue (planning/expansion.ts expansionComments), so `factory
 * reset` can rebuild the children (reset.ts). Upserting an unchanged
 * comment writes nothing.
 */
export async function postExpansion(
  state: ObjectiveState,
  item: WorkItem,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<void> {
  const settled = expansionsOf(state, currentPlan(state)!).find(
    ({ expanded }) => expanded?.children.some((child) => child.id === item.id),
  );
  if (!settled) return;
  const producer = settled.envelope.input.producerItemId;
  const records = expansionsOf(state, currentPlan(state)!).flatMap(
    ({ envelope, expanded }) =>
      expanded && envelope.input.producerItemId === producer ? [expanded] : [],
  );
  for (const { marker, body } of expansionComments(
    state.issue,
    producer,
    records,
    COMMENT_LIMIT - 1000,
  ))
    await deps.github.upsertComment(
      state.issue,
      marker,
      body,
      "expansion:post",
      signal,
    );
}

export async function publishStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state } = context;
  const changed = await objectiveEdited(context, deps);
  if (changed) return changed;
  await postExpansion(state, item, deps, context.signal);
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
    ...(itemIssueOf(state, item.id)
      ? { itemIssue: itemIssueOf(state, item.id) }
      : {}),
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

export function pullInput(
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

export async function ciStep(
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

export async function mergeStep(
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
export async function deleteBranches(
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
export async function mergeStack(
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
export function deliveryRepair(
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

export function republishOutcome(item: WorkItem, reason: string): Outcome {
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
 * The facts of a native-stack layer the layer below moves (a repair of
 * it): it replays its change onto the new head, keeping its selection,
 * and keeps nothing of a rereview of its old result. Every move of a
 * layer goes through here.
 */
export function movedLayer(
  state: ObjectiveState,
  layer: WorkItem,
  layerSelection: KeptSelection | undefined,
  detail: string,
): Record<string, unknown> {
  const work = state.done[stepKey(layer.id, "work")] as WorkResult | undefined;
  return {
    ...facts(
      {
        ...(layerSelection ? { selection: layerSelection } : {}),
        rebase: true,
        finished: null,
        onto: null,
        rereview: null,
      },
      layer.id,
    ),
    ...(work
      ? {
          ...refusedFact(layer.id, work, false),
          ...facts({ finding: { kind: "conflict", detail } }, layer.id),
        }
      : {}),
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
export function repairOutcome(
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
    selection: standsFor,
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
    /** The select repair keeps this choice (a missing LFS rule): its media is not the finding. */
    selection?: KeptSelection;
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
    standsFor ??
    (written(keep, "selection", item.id) === null ? undefined : standing(item));
  const media =
    !standsFor &&
    (from === "select" ||
      (own !== undefined && aboutMedia(item, own.selection.set, text, kept)));
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
          sentBack: null,
          refused: null,
          diagnosis: null,
          workSession: null,
          reviewSession: null,
        },
        item.id,
      )
    : {
        ...facts({ selection: media ? null : (own ?? null) }, item.id),
        ...(result ? refusedFact(item.id, result, refusesResult) : {}),
      };
  for (const layer of above)
    Object.assign(
      moved,
      movedLayer(
        state,
        layer,
        standing(layer),
        `Work Item ${item.id}, the stack layer below this one, is being repaired, so this change moves onto its new head.`,
      ),
    );
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
      ...facts({ finished: null, rereview: null }, item.id),
    },
  };
}

/**
 * Whether a repair is about the selected media: the finding (or the kept
 * finding's detail) names one of the set's destinations, or a refused
 * review criterion cites one or the item's candidate receipt.
 */
export function aboutMedia(
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
 * and hasn't merged, asked before its merge step. A merge step's question
 * may come after GitHub merged the PR, so it keeps retry and replan only.
 * Aggregate, QA and discovery items keep no worker result or worktree to
 * discard (`retry` already checks or observes again), so they don't offer it.
 */
export function freshable(state: ObjectiveState, key: string): boolean {
  const plan = currentPlan(state);
  const item = plan?.items.find((entry) => entry.id === itemOf(key));
  return (
    !!item &&
    key !== stepKey(item.id, "merge") &&
    executable(item.kind) &&
    !["aggregate", "qa", "discovery"].includes(item.kind ?? "") &&
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
