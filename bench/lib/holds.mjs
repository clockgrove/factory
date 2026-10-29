/**
 * What kind of question a hold asks, from the start of its text (the run
 * log keeps the first few hundred characters; status has it whole). The
 * patterns follow Factory's own question templates: spend limits
 * (spend.ts), repair, rereview and planning allowances (allowances.ts,
 * planning/amendments.ts), a changed configuration, a diagnosis's
 * question, the result reviewer's judgment, CI, a QA refusal and an
 * amendment's decision. The operator policy scripts answers by kind; the
 * scorecard groups holds and their waits by it.
 */
const PATTERNS = [
  ["spend", /^Model spend reached /],
  [
    "allowance",
    /needs another repair, past |refused result can't be checked again: this Objective has used |autonomy\.allowances\.planningRevisions allows/,
  ],
  ["config", /^The configuration changed since this Objective froze it/],
  ["review", /^The reviewer needs your judgment/],
  ["diagnosis", /needs your decision before it is repaired/],
  ["amendment", /^(Planning amendment |Amendment `)/],
  ["ci", /^Check "[^"]+" has no run/],
  ["qa", /^Read-only QA item /],
];

/** Every kind, `other` last. */
export const HOLD_KINDS = [...PATTERNS.map(([kind]) => kind), "other"];

export function holdKind(question) {
  const text = typeof question === "string" ? question : "";
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

/**
 * The policy's answer to an open hold (status's `holds[]`: question and
 * options), or null when the operator must answer. A scripted answer is
 * given only when the hold offers it.
 */
export function policyAnswer(hold, policy) {
  const kind = holdKind(hold.question);
  const answer = policy.answers[kind];
  const offered = (hold.options ?? []).some(
    (option) =>
      (typeof option === "string" ? option : option.answer) === answer,
  );
  return { kind, answer: answer && offered ? answer : null };
}
