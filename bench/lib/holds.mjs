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
 * The only answers a policy may script: raising a spend limit or an
 * allowance, and adopting a changed configuration. Every other hold (a
 * review's criteria, a diagnosis, an amendment, ...) is the operator's, and
 * no policy may accept or cancel anything.
 */
export const SCRIPTABLE = Object.freeze({
  spend: "more",
  allowance: "more",
  config: "adopt",
});

/**
 * The policy's answer to an open hold (status's `holds[]`: question and
 * options), or null when the operator must answer. A scripted answer is
 * given only when it is one SCRIPTABLE allows and the hold offers it.
 */
export function policyAnswer(hold, policy) {
  const kind = holdKind(hold.question);
  const answer = Object.hasOwn(policy.answers, kind)
    ? policy.answers[kind]
    : undefined;
  const allowed =
    Object.hasOwn(SCRIPTABLE, kind) && SCRIPTABLE[kind] === answer;
  const offered = (hold.options ?? []).some(
    (option) =>
      (typeof option === "string" ? option : option.answer) === answer,
  );
  return { kind, answer: allowed && offered ? answer : null };
}
