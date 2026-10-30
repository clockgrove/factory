/**
 * One run's scorecard (bench/README.md#Scorecard), from an Objective's
 * state, its run log and Factory's diagnostics of it. It reads, never
 * writes: a live service's state can be scored. Factory's own code does
 * what Factory already defines: `ChildThreads` gives older Codex calls
 * today's child-thread accounting (a resumed session's cumulative
 * children counted once), `currentPlan` the plan the Objective ran, and
 * `diagnostics --summary` and `--analyze` (the same functions, as JSON)
 * the totals the scorecard is checked against and its telemetry.
 *
 * Time: wall time runs from admission to the end. Excluded from active
 * time, and listed: outages (the gap from a run file's last event to the
 * next run file's first: a restart), operator pauses (`pause` to `resume`),
 * and the stretches where a hold waits for an answer and no step is in
 * progress (Factory has nothing to do until someone answers). A hold's wait
 * leaves out the outages and pauses inside it. A count the logs can't give
 * is null, with its reason in `unavailable`; never 0.
 *
 * Outcomes (#2223, bench/lib/outcomes.mjs): human effort from the operator's
 * answers and actions and the hand fixes in the run repository's history,
 * time to delivery, waste from the run log's attempts and calls, stage
 * escapes and cost. The grade is added after scoring (bench/lib/grade.mjs).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { analyze } from "../../dist/analysis.js";
import { ChildThreads, childTokensOf } from "../../dist/child-threads.js";
import { diagnostics, readRun } from "../../dist/diagnostics.js";
import { CAPTURE_OFF, logFiles, rotatedRuns } from "../../dist/log.js";
import { currentPlan } from "../../dist/planning/plan.js";
import { findState } from "../../dist/state.js";
import { commitTime, endCommit, handFixCommits } from "./grade.mjs";
import { holdKind } from "./holds.mjs";
import { SCORECARD_VERSION } from "./metrics.mjs";
import {
  answerTouch,
  costOf,
  delivery,
  escapesOf,
  humanEffort,
  requestTouch,
  wasteOf,
} from "./outcomes.mjs";
import { isScripted } from "./scripted.mjs";

export { SCORECARD_VERSION };

const num = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const ms = (at) => Date.parse(at);
const rate = (part, whole) => (whole ? part / whole : null);

/** A CI repair that is a merge conflict, found before any check ran (delivery.ts). */
const BASE_CONFLICT = /conflicts with its base branch/;
/** Hold kinds that stop a step for a limit or a setting, not for a verdict on its result. */
const NOT_A_VERDICT = new Set(["spend", "allowance", "config"]);
/**
 * Whether an outcome ends a step's turn. A plain `retry` means the step is
 * still being worked on (a CI poll, a provider backoff). A `retry` with
 * `progress` handed its work to other steps (an amendment's planning, a
 * replacement amendment) and may never run again, so it ends the turn too.
 */
const ends = (event) => event.outcome !== "retry" || event.progress === true;

/** The spans `blocked` was true over, from its changes in time order. */
class Spans {
  constructor() {
    this.since = null;
    this.spans = [];
  }

  set(at, blocked) {
    if (blocked && this.since === null) this.since = at;
    else if (!blocked && this.since !== null) {
      if (ms(at) > ms(this.since))
        this.spans.push({ from: this.since, to: at });
      this.since = null;
    }
  }

  close(at) {
    if (at) this.set(at, false);
    return this.spans;
  }
}

/** `spans` cut to [start, end], each with its length; empty ones dropped. */
function clip(spans, start, end) {
  return spans
    .map((span) => {
      const from = Math.max(ms(span.from), start);
      const to = Math.min(ms(span.to), end);
      return {
        ...span,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        ms: to - from,
      };
    })
    .filter((span) => span.ms > 0);
}

/** Milliseconds of [from, to) that the intervals cover; intervals don't overlap. */
function covered(from, to, intervals) {
  let sum = 0;
  for (const span of intervals) {
    const start = Math.max(from, ms(span.from));
    const end = Math.min(to, ms(span.to));
    if (end > start) sum += end - start;
  }
  return sum;
}

/** Sorted intervals merged where they overlap. */
function union(intervals) {
  const sorted = [...intervals].sort((a, b) => ms(a.from) - ms(b.from));
  const out = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && ms(span.from) <= ms(last.to)) {
      if (ms(span.to) > ms(last.to)) last.to = span.to;
    } else out.push({ from: span.from, to: span.to });
  }
  return out;
}

function tokenTally() {
  return {
    total: 0,
    own: 0,
    childThreads: 0,
    childThreadCount: 0,
    counted: 0,
    input: 0,
    cached: 0,
    uncached: 0,
    output: 0,
    reasoning: 0,
    calls: 0,
    unknownCalls: 0,
  };
}

function addTokens(tally, raw, event) {
  tally.calls += 1;
  const rawTotal = num(raw.tokens?.total);
  const total = num(event.tokens?.total);
  if (total === null) {
    tally.unknownCalls += 1;
    return;
  }
  const children = childTokensOf(event);
  const child = num(children?.total) ?? 0;
  tally.total += total;
  tally.childThreads += child;
  tally.childThreadCount += num(children?.threads) ?? 0;
  tally.own += total - child;
  tally.counted += rawTotal ?? 0;
  const input = num(event.tokens.input) ?? 0;
  const cached = num(event.tokens.cached) ?? 0;
  tally.input += input;
  tally.cached += cached;
  tally.uncached += input - cached;
  tally.output += num(event.tokens.output) ?? 0;
  tally.reasoning += num(event.tokens.reasoning) ?? 0;
}

/**
 * Factory's validate step. `runs` are its verdicts (done, repair, fail),
 * `passed` the done ones and `holds` the runs that stopped for a question.
 * `results` counts each result's first validation (the first after the
 * work that made it); `passedFirstTime` those that passed it. A hold for a
 * limit or a setting is not a verdict and leaves the first validation to
 * the next run; any other hold counts as the result not passing it.
 */
function validationTally() {
  return {
    runs: 0,
    passed: 0,
    holds: 0,
    passRate: null,
    results: 0,
    passedFirstTime: 0,
    firstPassRate: null,
  };
}

function finishValidation(tally) {
  tally.passRate = rate(tally.passed, tally.runs);
  tally.firstPassRate = rate(tally.passedFirstTime, tally.results);
  return tally;
}

function itemScore(id, kind, criteria) {
  return {
    id,
    kind,
    criteria,
    outcome: "open",
    pr: null,
    startedAt: null,
    endedAt: null,
    wallMs: null,
    activeWallMs: null,
    modelMs: 0,
    tokens: tokenTally(),
    tokensPerCriterion: null,
    repairs: 0,
    amendments: 0,
    holdBlockedMs: null,
    holds: { total: 0, operator: 0, operatorWaitMs: 0, waitMs: 0 },
    validation: validationTally(),
    workerValidation: { runs: 0, passed: 0 },
    ci: {
      rounds: 0,
      published: 0,
      conflicts: 0,
      reruns: 0,
      flaky: 0,
      passedFirstTime: 0,
      firstPassRate: null,
    },
    reviews: { runs: 0, passed: 0, firstPass: null },
  };
}

/** Factory's diagnostics of the Objective, as the CLI prints them with --json. */
async function factoryDiagnostics(logs, issue) {
  let summaryText = "";
  await diagnostics(
    {
      logs,
      issue,
      runs: { kind: "all" },
      summary: true,
      json: true,
      secrets: [],
      maxBytesPerCall: CAPTURE_OFF.maxBytesPerCall,
    },
    (text) => {
      summaryText += text;
    },
  );
  let analysisText = "";
  analyze(
    {
      logs,
      issue,
      runs: { kind: "all" },
      json: true,
      secrets: [],
      groupBy: ["item"],
      filters: {},
    },
    (text) => {
      analysisText += text;
    },
  );
  return {
    summary: JSON.parse(summaryText),
    analysis: JSON.parse(analysisText),
  };
}

/** Every merge commit the state records (`mergeSha`: each merge step's, and an item's earlier merges). */
function recordedMerges(state) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.mergeSha === "string") found.add(node.mergeSha);
    for (const value of Object.values(node)) walk(value);
  };
  walk(state.done);
  walk(state.kept);
  return found;
}

/** The time question charge when the definition sets none (bench/README.md#Scorecard). */
const QUESTION_CHARGE_MINUTES = 15;

/** The commit a Factory release was tagged at, in the Factory checkout `repo`. */
function releaseCommit(repo, version) {
  try {
    return execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--verify", "--quiet", `v${version}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Score Objective `issue` in Factory state directory `stateDir` (an
 * installation's: `<root>/<owner>__<repo>`). `run` names the result: id,
 * label, group, source (`harness` or `backfill`), repository, for a
 * candidate build its `factory: { commit }`, and for a harness run its run
 * directory, `dir`, and the base patches provisioning applied,
 * `basePatches` (each `{ commit, reason, applied }`). `factoryRepo`: the Factory
 * checkout releases' tags are resolved in. `checkout`: a checkout of the
 * run repository, where the end commit is read, and for a harness run (a
 * test repository no one else commits to) its hand fixes. `handFixes`:
 * hand-fix commits given by SHA (a backfill's), counted too.
 */
export async function scoreRun({
  stateDir,
  issue,
  definition,
  run,
  factoryRepo,
  checkout = null,
  handFixes = [],
}) {
  const logs = join(stateDir, "logs");
  const loaded = findState(join(stateDir, "objectives"), issue);
  if (!loaded || loaded.kind !== "ok")
    throw new Error(
      `${stateDir} has no readable state for #${issue}${loaded?.error ? `: ${loaded.error}` : ""}`,
    );
  const { state } = loaded;
  const plan = currentPlan(state) ?? state.done?.plan;
  const planItems = plan?.items ?? [];
  const itemIds = planItems.map((item) => item.id);
  const items = new Map(
    planItems.map((item) => [
      item.id,
      itemScore(item.id, item.kind, item.acceptance?.length ?? null),
    ]),
  );
  /** A step's Work Item: its own, or the item whose worker proposed its amendment (work/amend.ts `worker-<item>-<attempt>`). */
  const itemOfStep = (step) => {
    if (typeof step !== "string") return undefined;
    const own = /^item:([^:]+):/.exec(step)?.[1];
    if (own) return own;
    const amendment = /^amend:([^:]+)/.exec(step)?.[1];
    if (!amendment) return undefined;
    return itemIds
      .filter((id) => amendment.startsWith(`worker-${id}-`))
      .sort((a, b) => b.length - a.length)[0];
  };
  const itemOf = (id) => {
    if (!items.has(id)) items.set(id, itemScore(id, null, null));
    return items.get(id);
  };

  // Every run file, oldest first: its events in order.
  const files = logFiles(logs, issue);
  const runs = [];
  const events = [];
  /** Where each run file's events begin: a new service process. */
  const fileStarts = new Set();
  for (const file of files) {
    const first = events.length;
    let header;
    let end;
    readRun(file, 0, [], (event) => {
      if (event.event === "run-header") header = event;
      if (event.event === "run-end") end = event.outcome;
      events.push(event);
    });
    if (events.length === first) continue;
    fileStarts.add(first);
    runs.push({
      run: events[first].run,
      factoryVersion: header?.factoryVersion ?? null,
      sourceDigest: header?.sourceDigest ?? null,
      firstAt: events[first].at,
      lastAt: events.at(-1).at,
      end: end ?? null,
    });
  }
  const rotated = rotatedRuns(logs, issue).map((r) => r.run);

  const admitted = events.find((e) => e.event === "admitted")?.at;
  const startedAt = state.startedAt ?? admitted ?? events[0]?.at ?? null;
  const endedAt = state.ended?.at ?? events.at(-1)?.at ?? null;
  const start = startedAt ? ms(startedAt) : null;
  const end = endedAt ? ms(endedAt) : null;
  const inside = (at) => start !== null && ms(at) >= start && ms(at) <= end;

  // Outages: a later run file means the service restarted; its gap is excluded.
  const outages = [];
  for (let i = 1; i < runs.length; i++) {
    const from = Math.max(ms(runs[i - 1].lastAt), start);
    const to = Math.min(ms(runs[i].firstAt), end);
    if (to > from)
      outages.push({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        ms: to - from,
        afterRun: runs[i - 1].run,
        runEnd: runs[i - 1].end ?? "none (the run died)",
      });
  }

  const children = new ChildThreads();
  const totals = tokenTally();
  /** Calls of no Work Item: planning, final validation and review, the report. */
  const objective = { tokens: tokenTally(), modelMs: 0 };
  const models = new Map();
  const holds = new Map();
  const decisions = [];
  const actions = [];
  const pauses = [];
  let pausedAt = null;
  const planRounds = new Set();
  const generations = new Set();
  const amendmentAnswers = new Map();
  const ciRound = new Map();
  const validation = validationTally();
  /** Items whose current result has had its first validation. */
  const validated = new Set();
  /** Each step's latest hold kind. */
  const lastHold = new Map();
  // Final review passed when its step is done, not by its last logged
  // outcome: a review whose criteria the operator's answers all settled
  // (`accept <n>` to a refusal or a needs-human hold) passes without one
  // (review/result.ts).
  const final = {
    runs: 0,
    passed: 0,
    review: null,
    reviewPassed: Boolean(state.done?.["final-review"]),
  };
  let modelMs = 0;
  let costUsd = 0;
  let costed = 0;
  // For waste and cost: every call, and every step attempt with its outcome.
  const calls = [];
  const attempts = new Map();
  /** Each step's latest attempt: a step runs one attempt at a time. */
  const latest = new Map();
  /** `repair` outcomes: where in the log, and the step they sent work to. */
  const repairOutcomes = [];
  let file = -1;
  // For escapes and hand fixes.
  let finalReviewFrom = null;
  let refusals = 0;
  /** Heads Factory published: a merge commit with one as a parent is Factory's. */
  const heads = new Set();

  // Waiting on an answer: a hold is open and no step is in progress, for the
  // Objective (nothing at all runs) and for each Work Item (none of its steps runs).
  const inProgress = new Set();
  const openHolds = new Map();
  const blocked = new Spans();
  const itemBlocked = new Map();
  const track = (at) => {
    blocked.set(at, openHolds.size > 0 && inProgress.size === 0);
    const busy = new Set([...inProgress].map(itemOfStep));
    const held = new Set([...openHolds.values()].map((hold) => hold.item));
    for (const id of held)
      if (id && !itemBlocked.has(id)) itemBlocked.set(id, new Spans());
    for (const [id, spans] of itemBlocked)
      spans.set(at, held.has(id) && !busy.has(id));
  };

  for (const [index, raw] of events.entries()) {
    // A new run file is a new service process: the old one's steps died with it.
    if (fileStarts.has(index)) {
      if (index > 0) inProgress.clear();
      file += 1;
    }
    const event = children.counted(raw);
    const step = event.step;
    // `item` names a Work Item on Factory's own events; a provider event's `item` is something else.
    const itemId =
      (itemIds.includes(event.item) && event.item) || itemOfStep(step);
    const item = itemId ? itemOf(itemId) : null;
    if (item && step && inside(event.at)) {
      item.startedAt ??= event.at;
      if (!item.mergedAt) item.lastAt = event.at;
    }
    switch (event.event) {
      case "model-usage": {
        addTokens(totals, raw, event);
        addTokens(item ? item.tokens : objective.tokens, raw, event);
        const callMs = num(event.ms) ?? 0;
        modelMs += callMs;
        if (item) item.modelMs += callMs;
        else objective.modelMs += callMs;
        const usd = num(event.costUsd);
        if (usd !== null) {
          costUsd += usd;
          costed += 1;
        }
        const key = [
          event.role,
          event.provider,
          event.model,
          event.effort,
        ].join("|");
        const model = models.get(key) ?? {
          role: event.role ?? null,
          provider: event.provider ?? null,
          model: event.model ?? null,
          effort: event.effort ?? null,
          calls: 0,
        };
        model.calls += 1;
        models.set(key, model);
        const total = num(event.tokens?.total);
        calls.push({
          attempt: step ? latest.get(step) : undefined,
          item: itemId ?? null,
          tokens: total,
          ms: callMs,
          error: typeof event.error === "string" ? event.error : null,
          model: event.model ?? null,
          input: num(event.tokens?.input) ?? 0,
          cached: num(event.tokens?.cached) ?? 0,
          output: num(event.tokens?.output) ?? 0,
        });
        break;
      }
      case "start": {
        if (step) {
          const key = `${index} ${step}`;
          attempts.set(key, {
            key,
            step,
            file,
            outcome: null,
            outcomeAt: null,
            aborted: false,
          });
          latest.set(step, key);
        }
        if (step === "final-review") finalReviewFrom ??= event.at;
        if (step) {
          inProgress.add(step);
          // A held step that runs again was answered, whether or not the log has the answer.
          for (const [id, hold] of openHolds)
            if (hold.step === step) openHolds.delete(id);
        }
        const round = /^plan:(\d+):(\d+)$/.exec(step ?? "");
        if (round) {
          planRounds.add(step);
          generations.add(round[1]);
        }
        break;
      }
      case "outcome": {
        const outcome = event.outcome;
        const phase = /^item:[^:]+:(\w+)$/.exec(step ?? "")?.[1];
        const settled = outcome !== "retry";
        if (ends(event)) inProgress.delete(step);
        const attempt = attempts.get(latest.get(step));
        if (attempt && attempt.outcome === null) {
          attempt.outcome = outcome;
          attempt.outcomeAt = index;
        }
        if (outcome === "repair")
          repairOutcomes.push({ at: index, target: event.target ?? null });
        if (phase === "work" && item && outcome === "done")
          validated.delete(item.id);
        if (phase === "validate" && item && settled) {
          const tallies = [item.validation, validation];
          for (const tally of tallies)
            if (outcome === "hold") tally.holds += 1;
            else {
              tally.runs += 1;
              if (outcome === "done") tally.passed += 1;
            }
          const verdict =
            outcome !== "hold" || !NOT_A_VERDICT.has(lastHold.get(step));
          if (verdict && !validated.has(item.id)) {
            validated.add(item.id);
            for (const tally of tallies) {
              tally.results += 1;
              if (outcome === "done") tally.passedFirstTime += 1;
            }
          }
        }
        if (step === "final" && settled) {
          final.runs += 1;
          if (outcome === "done") final.passed += 1;
        }
        if (phase === "ci" && item) {
          const open = ciRound.get(item.id);
          if (open && outcome === "done") {
            if (open.published && !open.failed) item.ci.passedFirstTime += 1;
            ciRound.delete(item.id);
          } else if (
            open &&
            !open.failed &&
            outcome === "repair" &&
            BASE_CONFLICT.test(event.finding ?? "")
          ) {
            // No check failed: the push can't merge until it is rebased. Not a CI result.
            if (open.published) item.ci.conflicts += 1;
            ciRound.delete(item.id);
          } else if (open && ["repair", "hold", "fail"].includes(outcome)) {
            open.failed = true;
            if (outcome !== "hold") ciRound.delete(item.id);
          }
        }
        if (phase === "merge" && item && outcome === "done")
          item.mergedAt = event.at;
        break;
      }
      case "aborted":
        // The engine stopped these steps (cancel, cleared work): no outage cut them.
        for (const stopped of Array.isArray(event.steps) ? event.steps : []) {
          const attempt = attempts.get(latest.get(stopped));
          if (attempt) attempt.aborted = true;
        }
        break;
      case "published":
        if (typeof event.head === "string") heads.add(event.head);
        if (item) {
          item.pr = event.pr ?? item.pr;
          item.ci.published += 1;
          item.ci.rounds += 1;
          ciRound.set(item.id, { published: true, failed: false });
        }
        break;
      case "ci-rerun":
        if (item) {
          const open = ciRound.get(item.id);
          if (open) open.failed = true;
          item.ci.reruns += 1;
          item.ci.rounds += 1;
          ciRound.set(item.id, { published: false, failed: false });
        }
        break;
      case "ci-flaky":
        if (item) item.ci.flaky += 1;
        break;
      case "result-review":
        if (item) {
          item.reviews.runs += 1;
          if (event.outcome === "pass") item.reviews.passed += 1;
          item.reviews.firstPass ??= event.outcome === "pass";
        }
        break;
      case "objective-review":
        final.review = {
          outcome: event.outcome ?? null,
          criteria: num(event.criteria),
        };
        // ResultReview's kind (review/result.ts): final review refused the integrated result.
        if (event.outcome === "refused") refusals += 1;
        break;
      case "worker-validate":
        if (item) {
          item.workerValidation.runs += 1;
          if (event.passed === true) item.workerValidation.passed += 1;
        }
        break;
      case "amendment-answer": {
        const id = event.amendment ?? /^amend:([^:]+)/.exec(step ?? "")?.[1];
        if (id) amendmentAnswers.set(id, (amendmentAnswers.get(id) ?? 0) + 1);
        break;
      }
      case "hold":
        if (typeof event.id === "string") {
          const kind = holdKind(event.question);
          holds.set(event.id, {
            question: event.id,
            kind,
            step: step ?? null,
            item: itemId ?? null,
            cause: event.cause ?? null,
            askedAt: event.at,
            answeredAt: null,
            waitMs: null,
            rawWaitMs: null,
            answer: null,
            by: null,
            as: null,
            touch: null,
            scripted: false,
          });
          openHolds.set(event.id, { step, item: itemId ?? null });
          if (step) lastHold.set(step, kind);
        }
        break;
      case "request": {
        const request = event.request ?? {};
        // The service's acknowledgement repeats a request without `by`; a refused answer has a `code`.
        if (!event.by || event.code) break;
        if (request.kind === "answer") {
          openHolds.delete(request.question);
          const hold = holds.get(request.question);
          // A scripted answer is a judgment a real operator would have made,
          // whatever its answer (`continue` included).
          const scripted = isScripted(event.as);
          const touch = scripted
            ? "judgment"
            : answerTouch(request.answer, request);
          if (hold && !hold.answeredAt) {
            hold.answeredAt = event.at;
            hold.answer = request.answer ?? null;
            hold.by = event.by;
            hold.as = event.as ?? null;
            hold.touch = touch;
            hold.scripted = scripted;
          } else
            actions.push({
              kind: "answer",
              at: event.at,
              answer: request.answer ?? null,
              question: request.question ?? null,
              by: event.by,
              as: event.as ?? null,
              touch,
              scripted,
            });
          break;
        }
        if (request.kind === "run") break;
        actions.push({
          kind: request.kind,
          at: event.at,
          ...(request.item ? { item: request.item } : {}),
          by: event.by,
          as: event.as ?? null,
          touch: requestTouch(request.kind),
        });
        if (request.kind === "pause") pausedAt ??= event.at;
        if (request.kind === "resume" && pausedAt) {
          pauses.push({ from: pausedAt, to: event.at });
          pausedAt = null;
        }
        break;
      }
    }
    track(event.at);
  }
  if (pausedAt && endedAt) pauses.push({ from: pausedAt, to: endedAt });
  for (const pause of pauses) {
    pause.from = new Date(Math.max(ms(pause.from), start)).toISOString();
    pause.to = new Date(Math.min(ms(pause.to), end)).toISOString();
    pause.ms = ms(pause.to) - ms(pause.from);
  }
  const length = (spans) =>
    spans.reduce((sum, s) => sum + ms(s.to) - ms(s.from), 0);
  /** The service down or paused: left out of active time and of hold waits. */
  const downtime = union(
    [...outages, ...pauses].filter((s) => ms(s.to) > ms(s.from)),
  );
  const holdBlocked =
    start === null ? [] : clip(blocked.close(endedAt), start, end);
  /** Everything active time leaves out. */
  const excluded = union([...downtime, ...holdBlocked]);
  const excludedMs = length(excluded);
  const downtimeMs = length(downtime);

  // Holds: who answered, how long (the service down or paused left out), and whether the policy scripts their kind.
  const scripted = new Set(Object.keys(definition.operatorPolicy.answers));
  const holdTotals = {
    total: 0,
    scripted: 0,
    operator: 0,
    open: 0,
    waitMs: 0,
    rawWaitMs: 0,
    operatorWaitMs: 0,
    byKind: {},
  };
  for (const hold of holds.values()) {
    hold.policy = scripted.has(hold.kind);
    if (hold.answeredAt) {
      const from = ms(hold.askedAt);
      const to = ms(hold.answeredAt);
      hold.rawWaitMs = to - from;
      hold.waitMs = hold.rawWaitMs - covered(from, to, downtime);
    }
    holdTotals.total += 1;
    holdTotals[hold.policy ? "scripted" : "operator"] += 1;
    if (!hold.answeredAt) holdTotals.open += 1;
    holdTotals.waitMs += hold.waitMs ?? 0;
    holdTotals.rawWaitMs += hold.rawWaitMs ?? 0;
    if (!hold.policy) holdTotals.operatorWaitMs += hold.waitMs ?? 0;
    holdTotals.byKind[hold.kind] ??= {
      count: 0,
      waitMs: 0,
      scripted: hold.policy,
    };
    const kind = holdTotals.byKind[hold.kind];
    kind.count += 1;
    kind.waitMs += hold.waitMs ?? 0;
    const item = hold.item ? itemOf(hold.item) : null;
    if (item) {
      item.holds.total += 1;
      item.holds.waitMs += hold.waitMs ?? 0;
      if (!hold.policy) {
        item.holds.operator += 1;
        item.holds.operatorWaitMs += hold.waitMs ?? 0;
      }
    }
    decisions.push(hold);
  }

  // Repairs from the state: they survive log rotation.
  let repairs = 0;
  for (const [target, repair] of Object.entries(state.repairs ?? {})) {
    repairs += repair.count;
    const id = itemOfStep(target);
    if (id) itemOf(id).repairs += repair.count;
  }

  // Amendments: the plan's own record of what became of each.
  const amendments = {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    unchanged: 0,
    plannerAnswers: 0,
  };
  const proposed = new Set([
    ...amendmentAnswers.keys(),
    ...events.flatMap((e) =>
      e.event === "start"
        ? (/^amend:([^:]+)/.exec(e.step ?? "")?.slice(1) ?? [])
        : [],
    ),
  ]);
  for (const id of proposed) {
    amendments.proposed += 1;
    amendments.plannerAnswers += amendmentAnswers.get(id) ?? 0;
    const done = state.done?.[`amend:${id}`];
    if (done?.plan) amendments.accepted += 1;
    else if (done?.unchanged) amendments.unchanged += 1;
    else if (done?.rejected) amendments.rejected += 1;
    const owner = itemOfStep(`amend:${id}`);
    if (owner) itemOf(owner).amendments += 1;
  }

  let criteria = 0;
  let criteriaKnown = planItems.length > 0;
  for (const item of items.values()) {
    const merged = state.done?.[`item:${item.id}:merge`];
    item.outcome = merged
      ? merged.settled === "qa"
        ? "settled"
        : "merged"
      : state.status === "cancelled"
        ? "cancelled"
        : "open";
    item.endedAt = item.mergedAt ?? item.lastAt ?? null;
    if (item.startedAt && item.endedAt) {
      const from = ms(item.startedAt);
      const to = ms(item.endedAt);
      // Also left out: the item's own waits for an answer while none of its steps ran.
      const own = itemBlocked.get(item.id)?.close(endedAt) ?? [];
      const off = union([...excluded, ...clip(own, start, end)]);
      item.wallMs = to - from;
      item.activeWallMs = to - from - covered(from, to, off);
      item.holdBlockedMs = covered(from, to, off) - covered(from, to, downtime);
    }
    finishValidation(item.validation);
    item.ci.firstPassRate = rate(
      item.ci.passedFirstTime,
      item.ci.published - item.ci.conflicts,
    );
    item.tokensPerCriterion = item.criteria
      ? item.tokens.total / item.criteria
      : null;
    if (item.criteria === null) criteriaKnown = false;
    else criteria += item.criteria;
    delete item.mergedAt;
    delete item.lastAt;
  }
  const ci = {
    rounds: 0,
    published: 0,
    conflicts: 0,
    reruns: 0,
    flaky: 0,
    passedFirstTime: 0,
  };
  for (const item of items.values())
    for (const key of Object.keys(ci)) ci[key] += item.ci[key];

  const { summary, analysis } = await factoryDiagnostics(logs, issue);
  const sum = (rows, get) =>
    Object.values(rows).reduce((s, row) => s + get(row), 0);
  const check = (name, scorecard, factory) => ({
    name,
    scorecard,
    diagnostics: factory,
    ok: scorecard === factory,
  });
  const checks = [
    check(
      "tokens, own and child threads",
      totals.total,
      sum(summary.roles, (r) => r.tokens.total),
    ),
    check(
      "child-thread tokens",
      totals.childThreads,
      sum(summary.roles, (r) => r.childTokens),
    ),
    check(
      "model calls",
      totals.calls,
      sum(summary.roles, (r) => r.calls),
    ),
    check(
      "model time (ms)",
      modelMs,
      sum(summary.roles, (r) => r.ms),
    ),
    check("holds", holdTotals.total, summary.holds.length),
    check(
      "hold waits, asked to answered (ms)",
      holdTotals.rawWaitMs,
      summary.holdWaitMs,
    ),
    check(
      "repairs (state against the log's repair outcomes)",
      repairs,
      sum(summary.repairs, (n) => n),
    ),
  ];
  const spendLedger = num(state.spend?.tokens);

  const versions = [
    ...new Set(runs.map((r) => r.factoryVersion).filter(Boolean)),
  ];
  const unavailable = [];
  if (!costed)
    unavailable.push({
      metric: "costUsd",
      reason: "no model call reported a cost (Codex reports none)",
    });
  if (rotated.length)
    unavailable.push({
      metric: "all log-derived counts",
      reason: `${rotated.length} run(s) rotated out of the run log (${rotated.join(", ")}): counts are partial`,
    });
  if (!criteriaKnown)
    unavailable.push({
      metric: "tokensPerCriterion",
      reason: "the plan doesn't give every item's criteria",
    });
  if (totals.unknownCalls)
    unavailable.push({
      metric: "tokens of some calls",
      reason: `${totals.unknownCalls} model call(s) reported no token count (aborted or failed); the token totals leave them out`,
    });

  const wallMs = start !== null && end !== null ? end - start : null;
  const outcome =
    state.status === "done"
      ? "done"
      : state.status === "cancelled"
        ? "cancelled"
        : (state.holds ?? []).length
          ? "held"
          : "running";
  // An unfinished run's totals are lower only because it hasn't finished.
  const partial = outcome !== "done" && outcome !== "cancelled";
  if (partial)
    unavailable.unshift({
      metric: "every total",
      reason: `the Objective is ${outcome}, not ended: the totals cover the run so far, so this card is partial and is left out of comparisons`,
    });
  const build = run.factory?.distSha256;
  const buildNow = run.factory?.distSha256Now;
  if (build && buildNow && build !== buildNow)
    unavailable.push({
      metric: "which Factory ran",
      reason: `the Factory build (${run.factory.cli ?? "dist/"}) changed after provisioning: sha256 ${build.slice(0, 12)} then, ${buildNow.slice(0, 12)} at scoring. The service may have run either`,
    });

  // Outcomes (#2223). Hand fixes: a harness run's from its repository's
  // history; a backfill's only those given, since a real repository's
  // history has other people's commits too.
  const activeWallMs = wallMs === null ? null : wallMs - excludedMs;
  const atEnd = checkout ? endCommit(checkout, endedAt) : null;
  const basePatches = run.basePatches ?? [];
  const fixes = [];
  if (checkout && run.source === "harness") {
    try {
      if (!atEnd) throw new Error("its default branch can't be read");
      fixes.push(
        ...handFixCommits(checkout, {
          end: atEnd.commit,
          base: plan?.base ?? definition.source.base,
          startedAt,
          endedAt,
          merges: recordedMerges(state),
          heads,
          patches: new Set(basePatches.map((patch) => patch.applied)),
        }).map((fix) => ({ ...fix, from: "history" })),
      );
    } catch (error) {
      unavailable.push({
        metric: "hand fixes",
        reason: `the run repository's checkout ${checkout}: ${String(error.message).split("\n")[0]}; only --hand-fix commits count`,
      });
    }
  } else if (!handFixes.length)
    unavailable.push({
      metric: "hand fixes",
      reason:
        run.source === "harness"
          ? "no checkout of the run repository to read: none counted"
          : "a backfill counts only the hand fixes given with --hand-fix SHA: none given",
    });
  for (const sha of handFixes)
    if (!fixes.some((fix) => fix.sha === sha))
      fixes.push({
        sha,
        at: checkout ? commitTime(checkout, sha) : null,
        from: "given",
      });
  for (const fix of fixes) {
    fix.afterFinalReview =
      fix.at && finalReviewFrom ? ms(fix.at) >= ms(finalReviewFrom) : null;
    if (fix.at === null)
      unavailable.push({
        metric: "hand fixes after final review",
        reason: `hand fix ${fix.sha}: its time is unknown (no checkout has it), so it isn't counted as after final review`,
      });
  }
  const amendmentFate = (step) => {
    const id = /^amend:([^:]+)/.exec(step ?? "")?.[1];
    const done = id ? state.done?.[`amend:${id}`] : undefined;
    if (!done || done.plan) return undefined;
    return done.unchanged
      ? "unchanged"
      : done.rejected
        ? "rejected"
        : undefined;
  };
  const delivered = delivery(
    activeWallMs,
    holdTotals.operator,
    definition.scoring?.questionChargeMinutes ?? QUESTION_CHARGE_MINUTES,
  );
  const cost = costOf(calls, definition.prices);
  if (!cost)
    unavailable.push({
      metric: "cost",
      reason: "the definition has no prices",
    });
  else if (cost.unpriced.length)
    unavailable.push({
      metric: "cost",
      reason: `the definition prices no ${cost.unpriced.join(", ")}`,
    });
  unavailable.push({
    metric: "grade",
    reason: definition.grader
      ? "not graded: bench/score.mjs and bench/run.mjs grade an ended run"
      : "the definition has no grader",
  });
  return {
    schemaVersion: SCORECARD_VERSION,
    benchmark: definition.id,
    definitionDigest: definition.digest,
    run: {
      id: run.id,
      label: run.label,
      group: run.group,
      source: run.source,
      repository: run.repository,
      issue,
      ...(run.factory ? { factory: run.factory } : {}),
      // A harness run's directory: its run record and Objective, which the
      // blind pairwise review reads (bench/lib/judge.mjs).
      ...(run.dir ? { dir: run.dir } : {}),
      // The source commits provisioning put on the base: it wasn't pristine.
      ...(basePatches.length ? { basePatches } : {}),
    },
    partial,
    factory: {
      versions,
      commits: Object.fromEntries(
        versions.map((v) => [
          v,
          run.factory?.commit ?? releaseCommit(factoryRepo, v),
        ]),
      ),
      runs: runs.map(({ firstAt, lastAt, ...r }) => ({
        ...r,
        startedAt: firstAt,
        endedAt: lastAt,
      })),
      rotatedRuns: rotated,
    },
    models: [...models.values()],
    startedAt,
    endedAt,
    outcome,
    endCommit: atEnd?.commit ?? null,
    defaultBranch: atEnd?.branch ?? null,
    grade: null,
    human: humanEffort({ decisions, actions, handFixes: fixes, outcome }),
    deliveryMs: delivered.ms,
    delivery: delivered,
    waste: wasteOf({
      calls,
      attempts: [...attempts.values()],
      files: runs.length,
      repairs: repairOutcomes,
      amendmentFate,
      totals: { tokens: totals.total, modelMs },
    }),
    escapes: escapesOf({
      refusals,
      handFixesAfter: fixes.filter((fix) => fix.afterFinalReview).length,
      grade: null,
      finalPassed: final.reviewPassed,
    }),
    cost,
    totals: {
      wallMs,
      activeWallMs,
      excludedMs,
      downtimeMs,
      holdBlockedMs: excludedMs - downtimeMs,
      outages,
      pauses,
      holdBlocked,
      modelMs,
      tokens: { ...totals, spendLedger },
      cacheHitRate: rate(totals.cached, totals.input),
      costUsd: costed ? costUsd : null,
      criteria: criteriaKnown ? criteria : null,
      tokensPerCriterion:
        criteriaKnown && criteria ? totals.total / criteria : null,
      repairs,
      planning: {
        rounds: planRounds.size,
        generations: generations.size,
        revisions: planRounds.size + amendments.plannerAnswers,
      },
      amendments,
      holds: holdTotals,
      validation: finishValidation(validation),
      ci: {
        ...ci,
        firstPassRate: rate(ci.passedFirstTime, ci.published - ci.conflicts),
      },
      final,
    },
    items: [...items.values()],
    objective,
    operator: {
      decisions: decisions.sort((a, b) => a.askedAt.localeCompare(b.askedAt)),
      actions,
    },
    telemetry: {
      criticalPathMs: summary.criticalPathMs,
      hedges: summary.hedges,
      time: analysis.time,
      retries: {
        waits: analysis.retries.waits,
        continuations: analysis.retries.continuations,
        waitMs: analysis.retries.waitMs,
      },
      validationCommands: {
        commands: analysis.validation.commands,
        failed: analysis.validation.failed,
        ms: analysis.validation.ms,
      },
      github: analysis.github,
      cacheByItem: Object.fromEntries(
        analysis.groups.map((g) => [
          !g.key.item || g.key.item === "null" ? "objective" : g.key.item,
          g.cache.hitRate,
        ]),
      ),
    },
    checks,
    unavailable,
  };
}
