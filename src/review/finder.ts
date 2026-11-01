/**
 * The result review's finder (#2344, variant B): the per-Work-Item result
 * reviewer as it was before the reproduced-refusal review, its criteria
 * (the item's own acceptance, then the Objective criteria it proves), its
 * command proofs and its instructions, run through result.ts `runReview`
 * on the same evidence. Its refusals are not verdicts: review/item.ts
 * proves each one with a repro before it can cost a repair.
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

/** A criterion of `resultCriteria` the plan proves by one of the item's validation commands. */
export interface CommandProof {
  criterionIndex: number;
  /** The command's index in the item's validation, and in the validation passes row. */
  validationIndex: number;
  command: string;
}

/**
 * Each criterion of `resultCriteria` a `result-command` proof covers, with
 * the command it names, in criterion order: the review is told that the
 * command's pass is required evidence, not proof of the text (#2203).
 */
export function commandProofs(
  plan: Pick<Plan, "items" | "coverage">,
  item: Pick<WorkItem, "id" | "acceptance" | "validation">,
): CommandProof[] {
  const criteria = resultCriteria(plan, item);
  const proofs = new Map<string, CommandProof>();
  for (const entry of plan.coverage) {
    const { proof } = entry;
    if (entry.itemId !== item.id || proof.kind !== "result-command") continue;
    const criterionIndex = criteria.indexOf(coverageCriterion(entry));
    const command = item.validation[proof.validationIndex]?.command;
    if (criterionIndex < 0 || command === undefined) continue;
    proofs.set(`${criterionIndex}:${proof.validationIndex}`, {
      criterionIndex,
      validationIndex: proof.validationIndex,
      command,
    });
  }
  return [...proofs.values()].sort(
    (a, b) =>
      a.criterionIndex - b.criterionIndex ||
      a.validationIndex - b.validationIndex,
  );
}

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
  commands: readonly CommandProof[],
): string[] {
  const proven = commands
    .map(
      ({ criterionIndex, validationIndex, command }) =>
        `criterion ${criterionIndex} by validation command ${validationIndex} (${JSON.stringify(command)})`,
    )
    .join(", ");
  return [
    REVIEW_GUIDANCE.judge,
    "The worker's handoff and verification notes come from this unaccepted candidate: they are advisory investigation leads, not semantic claims, requirements, validation or acceptance. Check relevant claims against complete current evidence. A verification note is the implementer's claimed map from one criterionIndex's sub-clauses to candidate file:line locations: use it as a starting index, verify each cited location yourself, and judge the criterion from candidate evidence. A wrong, incomplete or absent map proves nothing either way, and a cited source unavailable in the candidate is a lead to investigate, not proof of absence.",
    REVIEW_GUIDANCE.asyncWork,
    ...(itemCriteria < criteria.length
      ? [
          `Criteria ${itemCriteria} to ${criteria.length - 1} are the Objective's acceptance criteria and pinned-source exit items this Work Item's result proves, quoted verbatim; the criteria before them are its own acceptance. Final review judges these same texts again with the same standard, so judge each now as it will: every enumerated sub-clause, each proven by the verification standard below. A fact only the integrated tree, a sibling Work Item or final validation can show belongs to final review and is not missing here; pass when this result delivers its own part. Existing tests are protected by default: changing or removing an existing assertion, golden or baseline, or skipping or deselecting an existing test, is acceptable only when one of this item's own acceptance entries states that behaviour change and why; otherwise refuse it under the criterion the change was made for, citing the changed file/lines.`,
        ]
      : []),
    ...(commands.length
      ? [
          `Command-proven criteria: the plan proves ${proven} of this Work Item; the Validation command passes row lists each command at that index, and it passed on this tree. When a criterion states only what that command's own exit decides (a lint, type-check or build passing, or a check script or exact-output comparison the command itself makes), the pass establishes it: pass it, unless this Work Item weakened the command's configuration or check to make it pass, which you judge as a change to existing verification. Otherwise that pass is required, not sufficient: it proves only what the tests the command runs assert, and this Work Item may have written those tests itself. Judge each such criterion from its own text as written, like any other: find the tests the command runs in candidate/, and pass it only when their assertions establish every sub-clause by the verification standard below. A test that asserts less than the text (a weaker restatement of it, or a fixture that only stores and echoes its input where the criterion requires a real consumer or producer), or a test the command does not run, leaves the criterion unproven: refuse it as missing verification, citing the validation row and the test's file/lines.`,
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
  ];
}
