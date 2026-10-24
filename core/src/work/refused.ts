import { itemOf } from "../engine.js";
import { needsSelection } from "../media.js";
import { currentPlan } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import type { ObjectiveState } from "../state.js";
import { hostGitExit } from "../worktree.js";
import { fact, facts, type Refused } from "./facts.js";
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
