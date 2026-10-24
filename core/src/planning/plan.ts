import { isObject } from "../checked.js";
import type { CriterionDecision } from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import { fact, itemsWith } from "../work/facts.js";
import type { AmendmentProposal, AmendmentResult } from "./amendments.js";
import { withExpansions } from "./expansion.js";
import { coverageCriterion } from "./graph.js";
import type { ObjectiveInputs } from "./steps.js";
import type { Plan, Retirement, WorkItem } from "./types.js";

/*
 * The one reader of the accepted plan. The plan step saves it at
 * `state.done.plan`; an accepted amendment saves its plan under its own key.
 * Everything else reads the plan the Objective runs now through
 * `currentPlan`, and what it was planned from through `acceptedInputs`.
 * Settled expansion envelopes join it as a derived layer (expansion.ts
 * withExpansions): their children run like any Work Item. Only amendments,
 * which keep every envelope whose producer started, read the saved plan
 * without that layer (`acceptedPlan`).
 * The operator's retirements (`retire <n>`) are kept apart, by the step
 * whose refusal they answer, and `currentPlan` returns them in `retired`.
 * A conditional Work Item's declared condition is read here too
 * (`conditionVerdict`), from its producer's kept discovery result.
 */

/**
 * A split's record (work/split.ts): `build:split` saves each child's issue
 * and the digest of the title and body Factory wrote for it; then
 * `build:split:children` waits for the children and closes the parent.
 */
export const SPLIT = "build:split";
export const SPLIT_QUEUE = "build:split:queue";
export const SPLIT_CHILDREN = "build:split:children";
/** `ended.by` of a parent its child Objectives delivered. */
export const SPLIT_END = "split";

export interface SplitRecord {
  /** Each child's issue, by key. */
  children: Record<string, number>;
  /** Each child's title and body digest as created (facts.ts childDigest), by key. */
  bodies: Record<string, string>;
}

/** The split's record once its children exist; undefined otherwise. */
export function splitRecord(state: ObjectiveState): SplitRecord | undefined {
  return state.done[SPLIT] as SplitRecord | undefined;
}

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
 * The plan the Objective runs now, with its settled expansions' children
 * and the criteria and commands the operator retired from it.
 */
export function currentPlan(state: ObjectiveState): Plan | undefined {
  const saved = acceptedPlan(state);
  if (!saved) return undefined;
  const plan = withExpansions(state, saved);
  const accepted = state.kept[ACCEPTED_AT];
  const retired = [
    ...itemsWith(state, "retired").flatMap(
      (id) => fact(state, "retired", id) ?? [],
    ),
    ...(fact(state, "final:retired") ?? []),
    ...(fact(state, "final-review:retired") ?? []),
  ].filter((entry) => entry.plan === accepted);
  return retired.length ? { ...plan, retired } : plan;
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
    [
      ...(plan?.items ?? []),
      ...(plan?.expansions ?? []).map((envelope) => envelope.template),
    ].flatMap((item) =>
      item.executionProfile ? [item.executionProfile.id] : [],
    ),
  );
  return [...used].filter((id) => !Object.hasOwn(profiles, id)).sort();
}

/**
 * The criteria a review no longer judges: with `itemId`, that item's
 * review (its own retirements and final review's); without, final review
 * (every retirement).
 */
export function retiredCriteria(plan: Plan, itemId?: string): Set<string> {
  return new Set(
    (plan.retired ?? [])
      .filter(
        (entry) =>
          itemId === undefined ||
          entry.itemId === undefined ||
          entry.itemId === itemId,
      )
      .flatMap((entry) => (entry.criterion ? [entry.criterion] : [])),
  );
}

/**
 * The validation commands the operator retired: with `itemId`, from that
 * item's validation; without, from final validation.
 */
export function retiredCommands(plan: Plan, itemId?: string): Set<string> {
  return new Set(
    (plan.retired ?? [])
      .filter((entry) => entry.itemId === itemId)
      .flatMap((entry) => (entry.command ? [entry.command] : [])),
  );
}

/**
 * Work Item `item` as it runs now: without the commands and acceptance
 * criteria the operator retired for it. The worker, its notes, the
 * collector and its review all read this one, so criterion indices agree.
 */
export function runnableItem(plan: Plan, item: WorkItem): WorkItem {
  const commands = retiredCommands(plan, item.id);
  const criteria = retiredCriteria(plan, item.id);
  return commands.size || criteria.size
    ? {
        ...item,
        acceptance: item.acceptance.filter(
          (criterion) => !criteria.has(criterion),
        ),
        validation: item.validation.filter(
          (check) => !commands.has(check.command),
        ),
      }
    : item;
}

/**
 * The obligations retired command `entry` proved: a Work Item's by its
 * coverage's validation index, final validation's by the Objective
 * criterion's command. Review judges them on other evidence now.
 */
export function provedBy(plan: Plan, entry: Retirement): string[] {
  const item = plan.items.find((each) => each.id === entry.itemId);
  return [
    ...new Set(
      plan.coverage
        .filter((coverage) =>
          item
            ? coverage.itemId === item.id &&
              "validationIndex" in coverage.proof &&
              item.validation[coverage.proof.validationIndex]?.command ===
                entry.command
            : entry.itemId === undefined &&
              coverage.source.command === entry.command,
        )
        .map(coverageCriterion),
    ),
  ];
}

/**
 * The retirements as lines for the report and status: criterion or
 * command, where, reason, who and when; for a command, the obligations it
 * proved, which review judges now. `kind` selects one kind.
 */
export function retiredLines(
  plan: Plan,
  time: (at: string) => string = (at) => at,
  kind?: "criterion" | "command",
): string[] {
  return (plan.retired ?? [])
    .filter(
      (entry) =>
        kind === undefined ||
        (kind === "command") === (entry.command !== undefined),
    )
    .map((entry) => {
      const proved = entry.command !== undefined ? provedBy(plan, entry) : [];
      return `${entry.command !== undefined ? `command \`${entry.command}\`` : entry.criterion}${entry.itemId ? ` (Work Item ${entry.itemId})` : entry.command !== undefined ? " (final validation)" : " (final review)"}: retired by ${entry.by} at ${time(entry.at)}: ${entry.reason}${proved.length ? `. Judged by review instead: ${proved.join("; ")}` : ""}`;
    });
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
