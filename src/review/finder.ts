/**
 * The result review's finder (#2344, variant B): the per-Work-Item result
 * reviewer as it was before the reproduced-refusal review, its criteria
 * (the item's own acceptance, then the Objective criteria it proves) and
 * its instructions, run through result.ts `runReview` on the same
 * evidence. No criterion is bound to one validation command (R6): any
 * test the item's validation runs can prove any criterion. Its refusals
 * are not verdicts: each names its ground, and review/item.ts routes on
 * it, proving a behaviour or verification refusal with a repro before it
 * can cost a repair.
 */
import { coverageCriterion } from "../planning/graph.js";
import { DESIGN_CHECKLIST, ENGINEERING_STANDARD } from "../planning/rubric.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { REVIEW_GUIDANCE } from "./result.js";

/**
 * The criteria a result review judges: the item's own acceptance, then each
 * Objective criterion or source exit item the plan says this item's review
 * proves. A single-item plan's review also judges what final review proves.
 * The worker gets this same list, numbered the same (work/prompt.ts
 * `workItemContract`), so the indices match its notes, and an obligation
 * its acceptance only paraphrases reaches it word for word (#2197). One a
 * `result-command` proves is judged too: its command passing proves only
 * what the tests it runs assert, and the item may have written those tests
 * itself, so a stub they pass is caught here, not at final review (#2203).
 */
export function resultCriteria(
  plan: Pick<Plan, "items" | "coverage">,
  item: Pick<WorkItem, "id" | "acceptance">,
): string[] {
  const whole = plan.items.length === 1 && plan.items[0]!.id === item.id;
  const owned = plan.coverage
    .filter(
      (entry) =>
        entry.itemId === item.id &&
        (entry.proof.kind === "result-semantic" ||
          entry.proof.kind === "result-command" ||
          entry.proof.kind === "integrated-semantic" ||
          (whole && entry.proof.kind === "final-review")),
    )
    .map(coverageCriterion)
    .filter((criterion) => !item.acceptance.includes(criterion));
  return [...item.acceptance, ...new Set(owned)];
}

/** What each refusal's `ground` means (result.ts GROUNDS): Factory routes on it. */
const GROUND_GUIDANCE = [
  "Give every refuse finding its ground, the one that fits best; Factory acts on it:",
  "- behaviour: the product does the wrong thing on an input or case the criterion covers;",
  "- verification-gap: the criterion's behaviour is unproven: a test it needs is missing or asserts less than it states;",
  "- test-economy: a test proves again what another proves, or copies a setup it could import;",
  "- placement: right code or test in the wrong file, module or validation command;",
  "- standard: an engineering-standard or design-checklist rule broken in changed code, the behaviour itself right;",
  "- protected-change: the result changed or removed an existing test, assertion, golden or baseline.",
].join("\n");

/**
 * The result-review instructions, limited to the evidence result review gets
 * (no receipts, bindings or historical references). Instructions
 * and evidence that don't depend on the candidate come first, so reviews of
 * one item's candidates share a provider-cache prefix.
 */
export function finderInstructions(
  /** How many of `criteria` are the item's own acceptance, first. */
  itemCriteria: number,
  criteria: readonly string[],
): string[] {
  return [
    REVIEW_GUIDANCE.judge,
    "The worker's handoff and verification notes come from this unaccepted candidate: they are advisory investigation leads, not semantic claims, requirements, validation or acceptance. Check relevant claims against complete current evidence. A verification note is the implementer's claimed map from one criterionIndex's sub-clauses to candidate file:line locations: use it as a starting index, verify each cited location yourself, and judge the criterion from candidate evidence. A wrong, incomplete or absent map proves nothing either way, and a cited source unavailable in the candidate is a lead to investigate, not proof of absence.",
    REVIEW_GUIDANCE.asyncWork,
    ...(itemCriteria < criteria.length
      ? [
          `Criteria ${itemCriteria} to ${criteria.length - 1} are the Objective's acceptance criteria and pinned-source exit items this Work Item's result proves, quoted verbatim; the criteria before them are its own acceptance. Final review judges these same texts again with the same standard, so judge each now as it will: every enumerated sub-clause, each proven by the verification standard below. A fact only the integrated tree, a sibling Work Item or final validation can show belongs to final review and is not missing here; pass when this result delivers its own part. Existing tests are protected by default: changing or removing an existing assertion, golden or baseline, or skipping or deselecting an existing test, is acceptable only when one of this item's own acceptance entries states that behaviour change and why; otherwise refuse it under the criterion the change was made for, citing the changed file/lines.`,
        ]
      : []),
    REVIEW_GUIDANCE.behaviour,
    `The engineering standard below is the repository's quality bar for code this result adds or changes, on top of the criteria. A violation in changed code is a semantic defect even when every criterion passes: refuse the criterion whose implementation or tests contain it, naming the rule and citing the file/lines, so the worker fixes it. Unchanged existing code is no finding. This judges code quality, not a mechanism the plan described, so the rule above still holds. A presence, type or tautological assertion proves no sub-clause. A test this result adds that proves again a claim another test in the tree already proves, or a harness or fixture setup it copies instead of importing, is a test-economy violation: refuse it, citing both locations.\n${ENGINEERING_STANDARD}`,
    `The design checklist below is part of that bar. The worker answered each question in a design note (designRisk names the question) citing file:line evidence. Verify each answer against the candidate code yourself: a wrong or unsupported answer is no proof, and an absent note proves nothing either way. A design defect in code this result adds or changes (a new action gated only by a broader existing grant, new state with no enforced bound or retention, attribution to a principal that did not act, avoidable per-request work, a reference test whose expected side runs the code under test, a numeric limit with no origin) is a semantic defect: refuse the criterion whose implementation contains it, naming the question and citing the file/lines. Where the repository declares its own design checklist (its AGENTS.md or a document it maps), apply it too.\n${DESIGN_CHECKLIST}`,
    REVIEW_GUIDANCE.findings,
    REVIEW_GUIDANCE.quantified,
    REVIEW_GUIDANCE.precedent,
    REVIEW_GUIDANCE.design,
    REVIEW_GUIDANCE.labels,
    REVIEW_GUIDANCE.evidenceRoot,
    GROUND_GUIDANCE,
  ];
}
