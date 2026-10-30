import { itemOf } from "../engine.js";
import { type CandidateSet, needsSelection } from "../media.js";
import { currentPlan } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import type { ObjectiveState } from "../state.js";
import { hostGitExit } from "../worktree.js";
import { fact, facts, type Refused, written } from "./facts.js";
import { mergeOf } from "./merged.js";
import { stepKey, type WorkResult } from "./steps.js";

/** The one writer of the refused fact, from the work result a repair clears. */
export function refusedFact(
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
export function refusedOf(
  state: ObjectiveState,
  id: string,
): Refused | undefined {
  const refused = fact(state, "refused", id);
  return refused?.replayOnly ? undefined : refused;
}

/**
 * The tree collection reads as the refused result again (collect.ts
 * `refusedTree`): the kept refused result's, while this result's media is
 * the refused result's own (it has no candidate sets, or its selection
 * stands). The refused tree is the work commit's, before the select step
 * wrote the chosen set on it, so new candidates (a refusal about the media
 * drops the selection) are a new result even on that same tree: for an
 * item that owns only its destinations, the base's. An attempt an accepted
 * amendment started, with nothing refused since (`amendedOnly`), has none
 * either: the plan the refused tree was judged under is gone, so that tree
 * left as it is is a result, validated and reviewed under the amended
 * plan. A result with media keeps the rule above.
 */
export function refusedTreeFor(
  state: ObjectiveState,
  id: string,
  result: { sets: readonly CandidateSet[]; selectionStands: boolean },
  keep: Record<string, unknown> = {},
): string | undefined {
  if (result.sets.length > 0 && !result.selectionStands) return undefined;
  if (result.sets.length === 0 && amendedOnly(state, id, keep))
    return undefined;
  return refusedOf(state, id)?.tree;
}

/**
 * Whether the item's current attempt runs only because an amendment was
 * accepted (amend.ts `amendedAttempt`): the diagnosis for its current
 * repair, written by this run (`keep`) or saved for it, is the
 * amendment's. Every refusal since, of any tree under the amended plan, is
 * a repair with a diagnosis of its own, and so is the operator's guidance.
 */
export function amendedOnly(
  state: ObjectiveState,
  id: string,
  keep: Record<string, unknown> = {},
): boolean {
  const now = written(keep, "diagnosis", id);
  const diagnosis = now === undefined ? fact(state, "diagnosis", id) : now;
  return (
    diagnosis?.amendment !== undefined &&
    diagnosis.repair === state.repairs?.[stepKey(id, "work")]?.count
  );
}

/**
 * The kept refused result as a work result, when it can be checked again
 * unchanged: its commit still exists with the refused tree, on `base`, and
 * an item with media still has the selection to write on it again; sets
 * come from the selection.
 */
export async function refusedResult(
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

/**
 * Whether only the operator's own refusals (`refuse <n>`) remain on the
 * kept refused result: a rereview of that tree reads them again and
 * refuses again, so `revalidate` isn't offered.
 */
export function operatorRefusalsOnly(
  state: ObjectiveState,
  id: string,
): boolean {
  const finding = fact(state, "finding", id);
  return (
    finding?.kind === "review" &&
    finding.tree === refusedOf(state, id)?.tree &&
    finding.refused.length > 0 &&
    finding.refused.every((entry) => entry.source === "operator")
  );
}

/**
 * Whether `revalidate` can answer a question of item step `key`
 * (workflow.ts, for the engine): a coding item's work step while its
 * refused result is kept (and, for media, its selection stands), or a QA
 * item's review step after its review refused the integrated result.
 * The work step checks that the result still sits on its base.
 */
export function revalidatable(state: ObjectiveState, key: string): boolean {
  const item = currentPlan(state)?.items.find(
    (entry) => entry.id === itemOf(key),
  );
  if (!item || mergeOf(state, item.id)) return false;
  if (item.kind === "qa")
    return (
      key === stepKey(item.id, "review") && !!fact(state, "qaRefused", item.id)
    );
  return (
    (item.kind ?? "work") === "work" &&
    key === stepKey(item.id, "work") &&
    !!refusedOf(state, item.id) &&
    !refusedOf(state, item.id)?.unrecheckable &&
    !operatorRefusalsOnly(state, item.id) &&
    // The work step takes `revalidate` only before a finished worker
    // run is collected and when no replay onto a new start is due.
    !fact(state, "finished", item.id) &&
    !fact(state, "rebase", item.id) &&
    (!needsSelection(item) || !!fact(state, "selection", item.id))
  );
}
