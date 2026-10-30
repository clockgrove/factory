/**
 * The scripted operator (#2266): fixed, documented answers to judgment
 * holds, so repeated runs of a benchmark get the same answers and the
 * operator stops being part of what is measured. Opt-in: `run.mjs --policy
 * scripted`, or the definition's `operatorPolicy.policy`. It comes after
 * the policy's answers by kind (bench/lib/holds.mjs), and anything no rule
 * answers still pauses for the operator.
 *
 * Each rule is `{ id, matches(hold), answer(hold) }` over a hold as
 * `factory status --json` shows it (id, question, options). The first rule
 * that matches decides: its answer, or null to pause. The refusals come
 * before the planner's recommendation, so a recommended exception or
 * widening is refused, never taken. Each rule matches a hold by its step
 * and Factory's own question templates and phrases (cited with each); the
 * policy-exception and planner-recommended rules also read the planner's
 * or diagnosis's own words inside them, for explicit phrases only, and
 * anything less pauses. A rule gives an answer only when the hold offers
 * it. bench/README.md#The scripted operator
 * states each rule as written here; change both together.
 */

/** What `as` ends with on a scripted answer: the scorecard counts them apart. */
export const SCRIPTED_AS = " (scripted)";

/** The `as` a scripted answer is given as, from the policy's own. */
export const scriptedAs = (as) => `${as}${SCRIPTED_AS}`;

/** Whether an answer's `as` says the scripted operator gave it. */
export const isScripted = (as) =>
  typeof as === "string" && as.endsWith(SCRIPTED_AS);

/** The operator policies: answers by kind only, or those and the scripted rules. */
export const POLICIES = ["stamps", "scripted"];

/** The step a hold asks for: its id up to the time it was asked (`<step>@<askedAt>`). */
const stepOf = (hold) => {
  const id = typeof hold.id === "string" ? hold.id : "";
  const at = id.lastIndexOf("@");
  return at < 0 ? id : id.slice(0, at);
};

const textOf = (hold) =>
  typeof hold.question === "string" ? hold.question : "";

/** The hold's option for `answer`, if it offers one. */
const option = (hold, answer) =>
  (hold.options ?? [])
    .map((o) => (typeof o === "string" ? { answer: o } : o))
    .find((o) => o.answer === answer);

/**
 * Whether the hold offers `answer` with text: Factory's `answer` option
 * (`needsText`), which sends the text to the planner or to the next
 * attempt as the operator's guidance.
 */
const guides = (hold) => option(hold, "answer")?.needsText === true;

/**
 * The steps whose questions carry a planner's or a diagnosis's own
 * question and take guidance: planning's decide step (`decide:<g>:<n>`),
 * an amendment's planning step (`amend:<id>:plan`) and a Work Item's work
 * step, which asks the repair diagnosis's question (`item:<id>:work`).
 */
const GUIDED_STEP = /^(decide:\d+:\d+|amend:[^:]+:plan|item:[^:]+:work)$/;

/** The planner's own question on a decide hold (planning/steps.ts `questionFor`), without Factory's framing. */
const PLANNER_ASKS = "The planner needs a decision:\n\n";
const PLANNER_ANSWER_WITH = "\n\nAnswer with `answer <your choice>`.";
function plannerQuestion(hold) {
  const text = textOf(hold);
  if (!text.startsWith(PLANNER_ASKS)) return null;
  const own = text.slice(PLANNER_ASKS.length);
  const end = own.lastIndexOf(PLANNER_ANSWER_WITH);
  return end < 0 ? own : own.slice(0, end);
}

/** A recommendation stated outright, and the words that take one back. */
const RECOMMEND = /recommend/i;
const MARKED = /\(recommended\)/i;
const STATED = [
  MARKED,
  /\b(?:is|are)(?: the| strongly)? recommended\b/i,
  /\b(?:I|we)(?:['’]d| would)?(?: strongly)? recommend\b/i,
  /\bthe recommended (?:option|choice|default|approach) is\b/i,
  /\brecommendation(?::| is\b)/i,
  /^recommended:/i,
];
const NEGATION =
  /\b(?:no|not|none|neither|nor|never|without|against|cannot|either)\b|n['’]t\b/i;

/**
 * Whether the planner's own question names a recommended choice: every
 * sentence that mentions a recommendation states one, as "X is
 * recommended", "X (recommended)", "I recommend X", "the recommended
 * option is X" or "Recommendation: X", with no negation in that sentence.
 * One that asks (ends with "?") counts only with "(recommended)" on an
 * option, so a question asking the operator to recommend, or one that
 * names something recommended that isn't a choice, pauses; so does a
 * recommendation someone else made ("the docs recommend X").
 */
function namesRecommended(asked) {
  const mentions = asked
    .split(/(?<=[.?!])\s+|\n+/)
    .filter((sentence) => RECOMMEND.test(sentence));
  return (
    mentions.length > 0 &&
    mentions.every(
      (sentence) =>
        !NEGATION.test(sentence) &&
        (sentence.trimEnd().endsWith("?")
          ? MARKED.test(sentence)
          : STATED.some((pattern) => pattern.test(sentence))),
    )
  );
}

/**
 * A rejected amendment's reason (planning/amendments.ts `rejectionStep`):
 * the text between "was rejected: " and the discovery that follows it, so
 * the worker's own words never match.
 */
function rejection(hold) {
  const text = textOf(hold);
  if (!text.startsWith("Amendment `")) return null;
  const from = text.indexOf(" was rejected: ");
  if (from < 0) return null;
  const start = from + " was rejected: ".length;
  const end = text.indexOf("\n\nReason: ", start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** The fence's started-item rule (amendments.ts `startedItemRule` findings). */
const STARTED_ITEM = "has started, so it keeps its spec";
/** A proposal taken in while another amendment was in flight (amendments.ts `overlapStep`). */
const IN_FLIGHT = "Another amendment was in flight when it was taken in";

/**
 * A request for an exception to a repository policy the owner records, in
 * the planner's or diagnosis's own words: no Factory template asks it, and
 * each repository names its policies its own way (a test budget, say), so
 * only an exception named as one to a policy or budget counts.
 */
const POLICY_EXCEPTION = [
  /\b(?:policy|budget) exceptions?\b/i,
  /\bexceptions? (?:to|from) (?:the |its |this )?(?:\S+ ){0,3}(?:policy|budget)\b/i,
];

/** Factory's words for a protected path the Objective's May change section doesn't list (objective.ts, planning/checks.ts, work/collect.ts). */
const MAY_CHANGE = /\bMay change section\b/;

export const RULES = Object.freeze([
  {
    id: "final-pauses",
    // Final validation's and final review's questions (work/finish.ts
    // steps `final`, `final-review`): never scripted, so nothing is ever
    // accepted for the Objective's result.
    matches: (hold) => /^final(?:-review)?(?::|$)/.test(stepOf(hold)),
    answer: () => null,
  },
  {
    id: "policy-exception-refused",
    matches: (hold) =>
      GUIDED_STEP.test(stepOf(hold)) &&
      guides(hold) &&
      POLICY_EXCEPTION.some((pattern) => pattern.test(textOf(hold))),
    answer: () => ({
      answer: "answer",
      text: "No exception is granted: the repository's policy stays as its owner recorded it, and nothing is added to its exceptions. Stay within the policy, and meet the need in a way it already allows.",
    }),
  },
  {
    id: "scope-widening-refused",
    matches: (hold) =>
      GUIDED_STEP.test(stepOf(hold)) &&
      guides(hold) &&
      MAY_CHANGE.test(textOf(hold)),
    answer: () => ({
      answer: "answer",
      text: "Not authorized: the Objective's May change section stays as it is, so no protected path it doesn't list may change. Meet the need within the files the Objective allows.",
    }),
  },
  {
    id: "amendment-continue",
    matches: (hold) => {
      const reason = /^amend:[^:]+:continue$/.test(stepOf(hold))
        ? rejection(hold)
        : null;
      return (
        reason !== null &&
        option(hold, "continue") !== undefined &&
        (reason.includes(STARTED_ITEM) || reason.startsWith(IN_FLIGHT))
      );
    },
    answer: () => ({ answer: "continue" }),
  },
  {
    id: "planner-recommended",
    matches: (hold) => {
      const asked = /^decide:\d+:\d+$/.test(stepOf(hold))
        ? plannerQuestion(hold)
        : null;
      return asked !== null && guides(hold) && namesRecommended(asked);
    },
    answer: () => ({ answer: "answer", text: "Take the recommended option." }),
  },
]);

/**
 * The scripted operator's decision on an open hold: `{ rule, answer, text }`
 * from the first rule that matches, `answer` null when that rule pauses;
 * null when no rule matches, and the hold pauses for the operator.
 */
export function scriptedAnswer(hold) {
  const rule = RULES.find((r) => r.matches(hold));
  if (!rule) return null;
  const given = rule.answer(hold);
  return {
    rule: rule.id,
    answer: given?.answer ?? null,
    ...(given?.text ? { text: given.text } : {}),
  };
}
