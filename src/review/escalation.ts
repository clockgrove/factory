/**
 * A Work Item result review's escalation to the provider's `top` tier
 * (#2364): a stronger, costlier model, run only where Factory's own state
 * says the standard review is likely failing. Each trigger is structural,
 * read from the finder's answer, the proofs and the item's history, never
 * from the reviewers' words:
 *
 * 1. `proof-dropped`: a proof dropped a `behaviour` or `verification-gap`
 *    refusal, so the review is about to pass a criterion the finder
 *    refused;
 * 2. `repairs-nearly-spent`: the item's repair allowance (its path's, or
 *    the Objective's implementation repairs) has at most one repair left;
 * 3. `finder-question`: the review is about to ask the operator a finder
 *    question (never the protected-test check's);
 * 4. `repro-shares-file`: a confirmed repro's refusal cites a file a
 *    passed criterion's verdict cites too;
 * 5. `earlier-refusal-passes`: a criterion refused on an earlier attempt
 *    (a kept repro) now passes with no suspicion;
 * 6. `note-on-behaviour`: a refusal routed to a note (test economy,
 *    placement or the standard) on a criterion that names no test file,
 *    or whose detail cites product code (a path not a test's,
 *    citations.ts `TEST_PATH`, the protected check's rule).
 *
 * Every trigger that fires joins one escalation, the review's only one: the
 * finder again on the `top` tier (review/item.ts `escalate`), on every
 * criterion for trigger 2, else on the criteria the triggers name. Its
 * refusals are proved as the standard finder's are, and only a confirmed
 * one adds a refusal. A finder question it answers is settled by its
 * verdict under the same standard (a pass, a note, or a suspicion its
 * proof dropped); one it asks again stays the operator's, saying the top
 * tier couldn't judge it either. It never removes a confirmed refusal.
 */
import type { Planner } from "../providers/planner.js";
import { citedSpans, namesTestPath, sameFile, TEST_PATH } from "./citations.js";
import type {
  Ground,
  RefusedCriterion,
  ResultReview,
  ReviewedCriterion,
  ReviewQuestion,
} from "./result.js";

export const TRIGGERS = [
  "proof-dropped",
  "repairs-nearly-spent",
  "finder-question",
  "repro-shares-file",
  "earlier-refusal-passes",
  "note-on-behaviour",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** What a review may escalate to, and the item's history its triggers read. */
export interface Escalation {
  /** The provider's `top` tier (providers/selection.ts `topTier`). */
  top: {
    planner: Planner;
    provider: string;
    model: string;
    effort: string;
  };
  /** The longest the escalation may take, its proofs included. */
  deadlineMs: number;
  /** The Objective's escalations are spent: a firing is logged, and nothing runs. */
  capped?: true;
  /** Trigger 2: the item has at most one repair left. */
  repairsNearlySpent?: true;
  /** Trigger 5: the criteria the item's earlier results were refused on. */
  earlierRefused?: readonly string[];
}

/** One escalation that ran: the `result-review-escalation` event, the PR body and status. */
export interface EscalationRecord {
  triggers: Trigger[];
  tier: "top";
  provider: string;
  model: string;
  effort: string;
  /** The criteria the top tier judged, by index. */
  criteria: number[];
  /** `done`, or the standard result stood: it timed out or failed. */
  outcome: "done" | "timeout" | "error";
  /** Its suspicions, and of those, proved by a confirmed repro. */
  suspicions: { raised: number; proved: number };
  /** Criteria it refused with a confirmed repro; finder questions it settled. */
  refused: number;
  settled: number;
  tokens: number;
  ms: number;
}

/** The grounds a proof judges: their refusals are suspicions. */
const PROVED: ReadonlySet<Ground> = new Set(["behaviour", "verification-gap"]);

/** The grounds whose refusals become notes. */
const NOTED: ReadonlySet<Ground> = new Set([
  "test-economy",
  "placement",
  "standard",
]);

/** The triggers that fired, and the criteria the top tier judges: all, or the named ones. */
export interface Fired {
  triggers: Trigger[];
  /** The criteria it judges, by index, in order. */
  criteria: number[];
  /** The finder questions among them, which its verdict can settle. */
  judged: number[];
}

/**
 * The triggers `found` (the finder's answer) and `review` (after its
 * proofs) fire, with the item's history in `escalation`. None fire on an
 * operator's refusal or a criterion already refused with a repro.
 */
export function escalationTriggers(
  found: ResultReview,
  review: ResultReview,
  escalation: Pick<Escalation, "repairsNearlySpent" | "earlierRefused">,
  criteria: readonly string[],
): Fired {
  const refused = review.kind === "refused" ? review.refused : [];
  const standing = new Set(refused.map((entry) => entry.criterionIndex));
  const passes = review.verdicts.filter((entry) => entry.verdict === "pass");
  const passed = new Set(passes.map((entry) => entry.criterionIndex));
  const model = (found.kind === "refused" ? found.refused : []).filter(
    (entry) => entry.source === "model",
  );
  const named = new Map<Trigger, number[]>();
  const fire = (trigger: Trigger, indices: number[]) => {
    const open = indices.filter((index) => !standing.has(index));
    if (open.length) named.set(trigger, [...new Set(open)]);
  };
  fire(
    "proof-dropped",
    model
      .filter(
        (entry) =>
          PROVED.has(entry.ground ?? "behaviour") &&
          passed.has(entry.criterionIndex),
      )
      .map((entry) => entry.criterionIndex),
  );
  if (escalation.repairsNearlySpent)
    named.set(
      "repairs-nearly-spent",
      criteria.map((_, index) => index),
    );
  // Only a review that asks the operator: a refusal repairs first.
  if (review.kind === "needs-human" && found.kind !== "pass")
    fire(
      "finder-question",
      found.questions.map((entry) => entry.criterionIndex),
    );
  const repros = refused
    .filter((entry) => entry.repro)
    .flatMap((entry) => citedSpans(entry.detail));
  fire(
    "repro-shares-file",
    passes
      .filter((entry) =>
        citedSpans(entry.detail).some((span) =>
          repros.some((other) => sameFile(span, other)),
        ),
      )
      .map((entry) => entry.criterionIndex),
  );
  const earlier = new Set(escalation.earlierRefused ?? []);
  fire(
    "earlier-refusal-passes",
    found.verdicts
      .filter(
        (entry) => entry.verdict === "pass" && earlier.has(entry.criterion),
      )
      .map((entry) => entry.criterionIndex),
  );
  fire(
    "note-on-behaviour",
    model
      .filter(
        (entry) =>
          entry.ground !== undefined &&
          NOTED.has(entry.ground) &&
          (!namesTestPath(entry.criterion) ||
            citedSpans(entry.detail).some(
              (span) => !TEST_PATH.test(span.path),
            )),
      )
      .map((entry) => entry.criterionIndex),
  );
  const triggers = TRIGGERS.filter((trigger) => named.has(trigger));
  const judged = named.get("finder-question") ?? [];
  return {
    triggers,
    criteria: [...new Set([...named.values()].flat())].sort((a, b) => a - b),
    judged,
  };
}

/**
 * The standard `review` with the top tier's `top` (its finder's answer,
 * proved) joined: each refusal top confirmed with a repro on a criterion
 * the standard review hadn't refused is added, and each of `judged` (the
 * standard finder's questions) is settled by top's verdict on it, or
 * stays the operator's, noting that top asked too. Nothing the standard
 * review refused is removed. `by` names the tier for the words it adds.
 */
export function joinEscalation(
  review: ResultReview,
  top: ResultReview,
  judged: readonly number[],
  by: string,
): { review: ResultReview; refused: number; settled: number } {
  const standing = review.kind === "refused" ? review.refused : [];
  const refusedNow = new Set(standing.map((entry) => entry.criterionIndex));
  const added: RefusedCriterion[] = (
    top.kind === "refused" ? top.refused : []
  ).filter(
    (entry) =>
      entry.source === "model" &&
      entry.repro &&
      !refusedNow.has(entry.criterionIndex),
  );
  const refusing = new Set(added.map((entry) => entry.criterionIndex));
  const settled: ReviewedCriterion[] = [];
  const questions: ReviewQuestion[] = [];
  for (const question of review.kind === "pass" ? [] : review.questions) {
    const index = question.criterionIndex;
    if (refusing.has(index)) continue;
    if (!judged.includes(index)) {
      questions.push(question);
      continue;
    }
    const verdict = top.verdicts.find(
      (entry) => entry.criterionIndex === index,
    );
    const asked = (top.kind === "pass" ? [] : top.questions).find(
      (entry) => entry.criterionIndex === index,
    );
    if (verdict)
      settled.push({
        ...verdict,
        detail: `The top-tier reviewer (${by}) judged it: ${verdict.detail}`,
      });
    else
      questions.push(
        asked
          ? {
              ...question,
              detail: `${question.detail} The top-tier reviewer (${by}) could not judge it either: ${asked.question}`,
            }
          : question,
      );
  }
  const order = <T extends { criterionIndex: number }>(entries: T[]) =>
    entries.sort((a, b) => a.criterionIndex - b.criterionIndex);
  const verdicts = order([
    ...review.verdicts.filter(
      (entry) =>
        !refusing.has(entry.criterionIndex) &&
        !settled.some((each) => each.criterionIndex === entry.criterionIndex),
    ),
    ...settled,
  ]);
  const refused = order([...standing, ...added]);
  const { tree } = review;
  const joined: ResultReview = refused.length
    ? { kind: "refused", tree, refused, verdicts, questions: order(questions) }
    : questions.length
      ? { kind: "needs-human", tree, questions: order(questions), verdicts }
      : { kind: "pass", tree, verdicts };
  return { review: joined, refused: added.length, settled: settled.length };
}

/** What each trigger means, in words (`escalationLine`). */
const TRIGGER_WORDS: Record<Trigger, string> = {
  "proof-dropped": "a proof dropped a refusal",
  "repairs-nearly-spent": "the repair allowance is nearly spent",
  "finder-question": "the reviewer asked the operator",
  "repro-shares-file": "a confirmed repro cites a file a pass cites",
  "earlier-refusal-passes": "an earlier refusal now passes",
  "note-on-behaviour": "a refusal of behaviour became a note",
};

/** One escalation as a line of words and numbers: the PR body's review notes. */
export function escalationLine(record: EscalationRecord): string {
  const criteria = record.criteria.map((index) => index + 1);
  const named =
    criteria.length > 1
      ? `criteria ${criteria.slice(0, -1).join(", ")} and ${criteria.at(-1)}`
      : `criterion ${criteria[0]}`;
  const on = `${record.model} at ${record.effort} effort (provider ${record.provider})`;
  const why = record.triggers
    .map((trigger) => TRIGGER_WORDS[trigger])
    .join("; ");
  return record.outcome === "done"
    ? `The top tier, ${on}, judged ${named} again (${why}): ${record.suspicions.raised} suspicions, ${record.suspicions.proved} proved; ${record.refused} criteria refused, ${record.settled} questions settled.`
    : `The top tier, ${on}, was asked to judge ${named} again (${why}) and ${record.outcome === "timeout" ? "ran out of time" : "failed"}; the standard review stands.`;
}
