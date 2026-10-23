import { isObject } from "../checked.js";
import type { ObjectiveState } from "../state.js";
import { fact } from "../work/facts.js";
import type {
  AmendmentProposal,
  AmendmentResult,
  AmendmentsModule,
} from "./amendments.js";
import type { ObjectiveInputs } from "./steps.js";
import type { Plan, WorkItem } from "./types.js";

/*
 * The one reader of the accepted plan. The plan step saves it at
 * `state.done.plan`; an accepted amendment saves its plan under its own key.
 * Everything else reads the plan the Objective runs now through
 * `currentPlan`, and what it was planned from through `acceptedInputs`.
 * A conditional Work Item's declared condition is read here too
 * (`conditionVerdict`), from its producer's kept discovery result.
 */

/** When the plan was accepted, for the order of owned-path waits (service.ts). */
export const ACCEPTED_AT = "plan:acceptedAt";

/** An amendment's saved outcome (AmendmentResult). */
export const amendmentKey = (id: string) => `amend:${id}`;

/** The proposals against the plan accepted now, oldest first; a replan leaves earlier ones behind. */
export function proposalsOf(state: ObjectiveState): AmendmentProposal[] {
  const accepted = state.kept[ACCEPTED_AT];
  return (
    (state.modules.amendments as AmendmentsModule | undefined)?.proposals ?? []
  ).filter((proposal) => proposal.plan === accepted);
}

/** The plan the Objective runs now: the latest accepted amendment's, else the accepted plan. */
export function currentPlan(state: ObjectiveState): Plan | undefined {
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
  const used = new Set(
    (currentPlan(state)?.items ?? []).flatMap((item) =>
      item.executionProfile ? [item.executionProfile.id] : [],
    ),
  );
  return [...used].filter((id) => !Object.hasOwn(profiles, id)).sort();
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

/** A conditional Work Item's declared condition, evaluated over its producer's kept result. */
export interface ConditionVerdict {
  conditionId: string;
  /** The branch the item runs on. */
  when: boolean;
  /** The condition's value: the item runs only when it equals `when`. */
  value: boolean;
  /** What the value was read from, for the skip record, final review and the report. */
  evidence: string;
}

/** The first few paths of a list, for evidence. */
const someOf = (paths: readonly string[]) =>
  paths.length
    ? `: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, and ${paths.length - 5} more` : ""}`
    : "";

/**
 * Item `item`'s declared condition over its producer's kept discovery
 * result (work/facts.ts `discovery`): deterministic, with no model call.
 * Undefined for unconditional work; a string when it can't be evaluated
 * (no kept result for the declared producer and role, or a classification
 * missing or outside the condition's reviewed labels): an unknown fact
 * never counts as false. The item depends directly on the producer, so it
 * is read only once the producer has settled.
 */
export function conditionVerdict(
  state: ObjectiveState,
  item: WorkItem,
): ConditionVerdict | string | undefined {
  if (!item.condition) return undefined;
  const { conditionId, when } = item.condition;
  const condition = currentPlan(state)?.conditions?.find(
    (entry) => entry.id === conditionId,
  );
  if (!condition)
    return `Work Item ${item.id} selects condition ${conditionId}, which the plan doesn't declare.`;
  const { producerItemId, role, schema } = condition.input;
  const result = fact(state, "discovery", producerItemId);
  if (
    !result ||
    result.producerItemId !== producerItemId ||
    result.role !== role ||
    result.schema !== schema
  )
    return `Condition ${conditionId} reads discovery role ${JSON.stringify(role)} from ${producerItemId}, which has no such kept result.`;
  const at = `discovery ${producerItemId} (role ${JSON.stringify(role)}) at ${result.commit.slice(0, 12)}`;
  const { predicate } = condition;
  if (predicate.kind === "inventory-empty") {
    const value = result.entries.length === 0;
    return {
      conditionId,
      when,
      value,
      evidence: `Condition ${conditionId} (inventory-empty) is ${value}: ${at} listed ${result.entries.length} files${someOf(result.entries.map((entry) => entry.path))}.`,
    };
  }
  const labels = [predicate.classification, ...predicate.otherClassifications];
  const unknown = result.entries.filter(
    (entry) =>
      result.mode !== "semantic" ||
      entry.classification === undefined ||
      !labels.includes(entry.classification),
  );
  if (unknown.length)
    return `Condition ${conditionId} (has-classification ${JSON.stringify(predicate.classification)}) can't be read: ${at} has ${unknown.length} files with no classification from ${JSON.stringify(labels)}${someOf(unknown.map((entry) => `${entry.path} (${entry.classification ?? "unclassified"})`))}. A missing label is never a negative finding.`;
  const matched = result.entries
    .filter((entry) => entry.classification === predicate.classification)
    .map((entry) => entry.path);
  const value = matched.length > 0;
  return {
    conditionId,
    when,
    value,
    evidence: `Condition ${conditionId} (has-classification ${JSON.stringify(predicate.classification)}) is ${value}: ${at} classified ${matched.length} of ${result.entries.length} files so${someOf(matched)}.`,
  };
}
