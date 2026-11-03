/**
 * The scorecard's outcome metrics (#2223), from what bench/lib/score.mjs
 * collects of a run: human effort, time to delivery, waste, stage escapes
 * and cost. The grade is bench/lib/grade.mjs's. Each rule is stated here
 * and in bench/README.md#Scorecard, and reads the run log's events and the
 * state, never the text of a finding or a question.
 */

/**
 * What an operator touch weighs. A hand-made change to the default branch
 * is the heaviest; a judgment call (an answer with text, refuse, replan,
 * an explicit accept or refuse, cancel, ...) takes thought; a rubber stamp
 * (`more`, a plain `retry`, `adopt`, `continue`, pause and resume) takes a
 * glance.
 */
export const WEIGHTS = Object.freeze({ stamp: 1, judgment: 5, handFix: 25 });

/** Answers that are a stamp when they carry no text or argument. */
const STAMP_ANSWERS = new Set(["more", "retry", "adopt", "continue"]);
/** Operator requests other than an answer that are a stamp. */
const STAMP_REQUESTS = new Set(["retry", "pause", "resume", "drain"]);

/** An answer's touch: a stamp, or a judgment. */
export function answerTouch(answer, { text, arg } = {}) {
  return STAMP_ANSWERS.has(answer) && !text && !arg ? "stamp" : "judgment";
}

/** Any other operator request's touch (`run` is no touch and never reaches here). */
export function requestTouch(kind) {
  return STAMP_REQUESTS.has(kind) ? "stamp" : "judgment";
}

/**
 * Human effort: every answered hold and other operator action by its
 * touch, and every hand fix. `policyStamps`: the stamps on holds of the
 * policy's kinds (a spend or allowance raise, adopting a config), which a
 * harness run's policy gives: they count, as an operator would have had
 * to give them. `scriptedJudgments`: the answers the scripted operator
 * gave (bench/lib/scripted.mjs), each weighed as a judgment, since a real
 * operator would have had to make it, and counted apart, so runs under
 * different policies aren't compared as equals. `unattended`: the
 * Objective is done with no touch at all.
 */
export function humanEffort({ decisions, actions, handFixes, outcome }) {
  const touches = [...decisions, ...actions].map((entry) => entry.touch);
  const stamps = touches.filter((touch) => touch === "stamp").length;
  const judgments = touches.filter((touch) => touch === "judgment").length;
  const score =
    stamps * WEIGHTS.stamp +
    judgments * WEIGHTS.judgment +
    handFixes.length * WEIGHTS.handFix;
  return {
    score,
    unattended: outcome === "done" && score === 0,
    weights: WEIGHTS,
    stamps,
    judgments,
    handFixes: handFixes.length,
    policyStamps: decisions.filter((d) => d.policy && d.touch === "stamp")
      .length,
    scriptedJudgments: [...decisions, ...actions].filter((e) => e.scripted)
      .length,
    fixes: handFixes,
  };
}

/**
 * Time to delivery: active wall time plus a fixed charge for each question
 * that needed the operator (a hold of a kind the policy doesn't answer). The
 * operator's speed stays out of it; asking still costs something.
 */
export function delivery(activeWallMs, questions, chargeMinutes) {
  const questionChargeMs = chargeMinutes * 60_000;
  return {
    ms:
      activeWallMs === null
        ? null
        : activeWallMs + questions * questionChargeMs,
    activeWallMs,
    questions,
    questionChargeMs,
  };
}

/** The causes of waste, in the order a call is tested against them: a call has one cause at most. */
export const WASTE_CAUSES = ["outage", "hedge", "amendment", "superseded"];

/** The error of a call that HedgedPlanner aborted because the other call answered first (diagnostics.ts `addHedge`). */
const HEDGE_LOST = /\bhedged$/;

const tally = () => ({ tokens: 0, modelMs: 0, calls: 0, unknownCalls: 0 });

function add(row, call) {
  row.calls += 1;
  row.modelMs += call.ms;
  if (call.tokens === null) row.unknownCalls += 1;
  else row.tokens += call.tokens;
}

/**
 * Each step's results that a later attempt of the same step replaced. A
 * step's attempts, in order, make one result when one ends `done`; the
 * attempts before it (a hold, a continuation) are part of it. A result is
 * superseded when the step's next result was made again, not built on it:
 * no `repair` outcome sent work back to this step between the two. A
 * repair continues the result it repairs (the worker's conversation and
 * branch go on), so a repaired result is no waste; a review that judged a
 * result the step then reviewed again, or an amendment's plan its review
 * sent back, is. Returns the attempts of superseded results.
 */
export function supersededAttempts(attempts, repairs) {
  const byStep = new Map();
  for (const attempt of attempts) {
    if (!attempt.step) continue;
    if (!byStep.has(attempt.step)) byStep.set(attempt.step, []);
    byStep.get(attempt.step).push(attempt);
  }
  const superseded = new Set();
  for (const [step, list] of byStep) {
    const results = [];
    let open = [];
    for (const attempt of list) {
      open.push(attempt);
      if (attempt.outcome === "done") {
        results.push({ attempts: open, doneAt: attempt.outcomeAt });
        open = [];
      }
    }
    for (let i = 0; i + 1 < results.length; i++) {
      const from = results[i].doneAt;
      const to = results[i + 1].doneAt;
      const repaired = repairs.some(
        (repair) =>
          repair.target === step && repair.at > from && repair.at < to,
      );
      if (!repaired)
        for (const attempt of results[i].attempts) superseded.add(attempt.key);
    }
  }
  return superseded;
}

/**
 * Tokens and model time spent on work that didn't reach the result, as a
 * share of the totals, by cause and by Work Item (`objective` for calls of
 * none). A call's cause, the first that holds:
 * - `outage`: its attempt had no outcome before its run file ended and a
 *   later run file began (the service restarted or died under it), and no
 *   `aborted` event stopped it.
 * - `hedge`: a hedged pair's call that lost: aborted as `hedged` because
 *   the other answered first.
 * - `amendment`: a call of an amendment the plan rejected or left
 *   unchanged (the state's `amend:<id>` record).
 * - `superseded`: a call of a result a later attempt of the same step
 *   replaced (`supersededAttempts`).
 *
 * `calls`: { attempt, item, tokens (null: unknown), ms, error }.
 * `attempts`: { key, step, file, outcome, outcomeAt, aborted }, `files` the
 * run files' count, `repairs`: { at, target }, `amendmentFate(step)`:
 * `rejected`, `unchanged` or undefined.
 */
export function wasteOf({
  calls,
  attempts,
  files,
  repairs,
  amendmentFate,
  totals,
}) {
  const byKey = new Map(attempts.map((attempt) => [attempt.key, attempt]));
  const superseded = supersededAttempts(attempts, repairs);
  const causeOf = (call) => {
    const attempt = byKey.get(call.attempt);
    if (
      attempt &&
      attempt.outcome === null &&
      !attempt.aborted &&
      attempt.file < files - 1
    )
      return "outage";
    if (HEDGE_LOST.test(call.error ?? "")) return "hedge";
    if (attempt && amendmentFate(attempt.step)) return "amendment";
    if (attempt && superseded.has(attempt.key)) return "superseded";
    return null;
  };
  const all = tally();
  const byCause = Object.fromEntries(WASTE_CAUSES.map((c) => [c, tally()]));
  const byItem = {};
  for (const call of calls) {
    const cause = causeOf(call);
    if (!cause) continue;
    const item = call.item ?? "objective";
    byItem[item] ??= tally();
    add(all, call);
    add(byCause[cause], call);
    add(byItem[item], call);
  }
  return {
    tokens: all.tokens,
    modelMs: all.modelMs,
    tokensShare: totals.tokens ? all.tokens / totals.tokens : null,
    modelMsShare: totals.modelMs ? all.modelMs / totals.modelMs : null,
    calls: all.calls,
    unknownCalls: all.unknownCalls,
    byCause,
    byItem,
  };
}

/**
 * Stage escapes: defects caught later than the stage meant to catch them.
 * - `finalReviewRefusals`: final review refused the integrated result
 *   (result review let it through);
 * - `handFixesAfterFinalReview`: hand fixes made after final review first
 *   ran (final review let it through to the operator);
 * - `graderFailedPassed`: criteria the grader failed although final review
 *   passed them (it passed the result last); null until graded.
 * - `graderDefects`: verified findings of severity `defect` (they violate a
 *   stated criterion) in a result final review passed (#2273); null until
 *   graded by a grader that reports findings.
 */
export function escapesOf({ refusals, handFixesAfter, grade, finalPassed }) {
  const graded = typeof grade?.failed === "number";
  const graderFailedPassed = graded ? (finalPassed ? grade.failed : 0) : null;
  const graderDefects =
    graded && Array.isArray(grade.findings)
      ? finalPassed
        ? grade.findings.filter((f) => f.severity === "defect").length
        : 0
      : null;
  return {
    total:
      refusals +
      handFixesAfter +
      (graderFailedPassed ?? 0) +
      (graderDefects ?? 0),
    finalReviewRefusals: refusals,
    handFixesAfterFinalReview: handFixesAfter,
    graderFailedPassed,
    graderDefects,
  };
}

/**
 * Cost, a guard: each call's tokens at its model's price (`prices`: per
 * model, US dollars per million uncached input, cached input and output
 * tokens; reasoning is part of output). Null when the definition has no
 * prices or a call's model has none: never a partial sum. Calls that
 * reported no tokens are left out, as from the token totals.
 */
export function costOf(calls, prices) {
  if (!prices) return null;
  const byModel = {};
  const unpriced = new Set();
  let usd = 0;
  let unknownCalls = 0;
  for (const call of calls) {
    if (call.tokens === null) {
      unknownCalls += 1;
      continue;
    }
    const model = call.model ?? "unknown";
    byModel[model] ??= {
      calls: 0,
      uncachedInput: 0,
      cachedInput: 0,
      output: 0,
      usd: null,
    };
    const row = byModel[model];
    row.calls += 1;
    row.uncachedInput += call.input - call.cached;
    row.cachedInput += call.cached;
    row.output += call.output;
  }
  for (const [model, row] of Object.entries(byModel)) {
    const price = Object.hasOwn(prices, model) ? prices[model] : null;
    if (!price) {
      unpriced.add(model);
      continue;
    }
    row.usd =
      (row.uncachedInput * price.uncachedInput +
        row.cachedInput * price.cachedInput +
        row.output * price.output) /
      1e6;
    usd += row.usd;
  }
  return {
    usd: unpriced.size ? null : usd,
    byModel,
    unpriced: [...unpriced],
    unknownCalls,
  };
}
