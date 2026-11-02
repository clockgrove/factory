/**
 * Confirmed refusals as extra validation (#2344 R3): each refusal a Work
 * Item's result review confirmed by running its repro command
 * (review/item.ts) keeps that command, and every later validation of the
 * item's results, the validate step's and the worker's own Validate, runs
 * it after the item's own commands, so the repair must make it pass. One
 * the operator accepted on the tree it was refused on (`accept <n>`: the
 * reviewer was wrong) no longer runs. A replan keeps none: the commands
 * belong to the plan they were confirmed under.
 */
import { ACCEPTED_AT } from "../planning/plan.js";
import type { ValidationCommand, WorkItem } from "../planning/types.js";
import { decides, type Repro } from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import { fact } from "./facts.js";

/** One confirmed refusal, kept for later validations and the next review's packet. */
export interface ConfirmedRepro {
  /** The criterion refused, and the tree it was refused on. */
  criterion: string;
  tree: string;
  detail: string;
  repro: Repro;
}

/** The kept repros under the plan accepted now, without those the operator accepted. */
export function keptRepros(
  state: ObjectiveState,
  itemId: string,
): ConfirmedRepro[] {
  const kept = fact(state, "repros", itemId);
  if (!kept || kept.plan !== state.kept[ACCEPTED_AT]) return [];
  const decisions = fact(state, "decisions", itemId) ?? [];
  return kept.entries.filter(
    (entry) =>
      [...decisions]
        .reverse()
        .find((decision) => decides(decision, entry.criterion, entry.tree))
        ?.outcome !== "accept",
  );
}

/**
 * `item` as its results are validated: its own commands, then each kept
 * repro command once, as the review's refusal check ran it.
 */
export function withRepros(state: ObjectiveState, item: WorkItem): WorkItem {
  const commands = [
    ...new Set(keptRepros(state, item.id).map((entry) => entry.repro.command)),
  ].filter((command) => !item.validation.some((v) => v.command === command));
  if (!commands.length) return item;
  return {
    ...item,
    validation: [...item.validation, ...commands.map(reproCommand)],
  };
}

/**
 * A repro command as a validation command: it needs none of the item's
 * commands, so it runs after only the exact install, which always runs
 * first when the commands start with one (validate.ts `runOrder`).
 */
export function reproCommand(command: string): ValidationCommand {
  return { command, after: [] };
}

/** The kept repros with `added` after them, under the plan accepted now. */
export function addRepros(
  state: ObjectiveState,
  itemId: string,
  added: readonly ConfirmedRepro[],
): { plan: string; entries: ConfirmedRepro[] } {
  const kept = fact(state, "repros", itemId);
  const plan = state.kept[ACCEPTED_AT] as string;
  return {
    plan,
    entries: [...(kept?.plan === plan ? kept.entries : []), ...added],
  };
}
