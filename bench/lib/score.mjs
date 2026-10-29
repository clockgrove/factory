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
 * Time: wall time runs from admission to the end; outages (the gap from a
 * run file's last event to the next run file's first: a restart) and
 * operator pauses (`pause` to `resume`) are excluded from active time and
 * listed. A count the logs can't give is null, with its reason in
 * `unavailable`; never 0.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { analyze } from "../../dist/analysis.js";
import { ChildThreads, childTokensOf } from "../../dist/child-threads.js";
import { diagnostics, readRun } from "../../dist/diagnostics.js";
import { CAPTURE_OFF, logFiles, rotatedRuns } from "../../dist/log.js";
import { currentPlan } from "../../dist/planning/plan.js";
import { findState } from "../../dist/state.js";
import { holdKind } from "./holds.mjs";

export const SCORECARD_VERSION = 1;

const num = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const ms = (at) => Date.parse(at);
const rate = (part, whole) => (whole ? part / whole : null);

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
    holds: { total: 0, operator: 0, operatorWaitMs: 0, waitMs: 0 },
    validation: { runs: 0, passed: 0, firstPassRate: null },
    workerValidation: { runs: 0, passed: 0 },
    ci: {
      rounds: 0,
      published: 0,
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
 * label, group, source (`harness` or `backfill`), repository, and for a
 * candidate build its `factory: { commit }`. `factoryRepo`: the Factory
 * checkout releases' tags are resolved in.
 */
export async function scoreRun({
  stateDir,
  issue,
  definition,
  run,
  factoryRepo,
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
  const attempts = new Map();
  const planRounds = new Set();
  const generations = new Set();
  const amendmentAnswers = new Map();
  const ciRound = new Map();
  const validation = { runs: 0, passed: 0 };
  const final = { runs: 0, passed: 0, review: null };
  let modelMs = 0;
  let costUsd = 0;
  let costed = 0;

  for (const raw of events) {
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
        break;
      }
      case "start": {
        attempts.set(`${event.run} ${event.attemptId ?? step}`, event.at);
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
        if (phase === "validate" && item && settled) {
          item.validation.runs += 1;
          validation.runs += 1;
          if (outcome === "done") {
            item.validation.passed += 1;
            validation.passed += 1;
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
          } else if (open && ["repair", "hold", "fail"].includes(outcome)) {
            open.failed = true;
            if (outcome !== "hold") ciRound.delete(item.id);
          }
        }
        if (phase === "merge" && item && outcome === "done")
          item.mergedAt = event.at;
        break;
      }
      case "published":
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
        if (typeof event.id === "string")
          holds.set(event.id, {
            question: event.id,
            kind: holdKind(event.question),
            step: step ?? null,
            item: itemId ?? null,
            cause: event.cause ?? null,
            askedAt: event.at,
            answeredAt: null,
            waitMs: null,
            answer: null,
            by: null,
            as: null,
          });
        break;
      case "request": {
        const request = event.request ?? {};
        // The service's acknowledgement repeats a request without `by`; a refused answer has a `code`.
        if (!event.by || event.code) break;
        if (request.kind === "answer") {
          const hold = holds.get(request.question);
          if (hold && !hold.answeredAt) {
            hold.answeredAt = event.at;
            hold.waitMs = ms(event.at) - ms(hold.askedAt);
            hold.answer = request.answer ?? null;
            hold.by = event.by;
            hold.as = event.as ?? null;
          } else
            actions.push({
              kind: "answer",
              at: event.at,
              answer: request.answer ?? null,
              question: request.question ?? null,
              by: event.by,
              as: event.as ?? null,
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
        });
        if (request.kind === "pause") pausedAt ??= event.at;
        if (request.kind === "resume" && pausedAt) {
          pauses.push({ from: pausedAt, to: event.at });
          pausedAt = null;
        }
        break;
      }
    }
  }
  if (pausedAt && endedAt) pauses.push({ from: pausedAt, to: endedAt });
  for (const pause of pauses) {
    pause.from = new Date(Math.max(ms(pause.from), start)).toISOString();
    pause.to = new Date(Math.min(ms(pause.to), end)).toISOString();
    pause.ms = ms(pause.to) - ms(pause.from);
  }
  const excluded = union(
    [...outages, ...pauses].filter((s) => ms(s.to) > ms(s.from)),
  );
  const excludedMs = excluded.reduce(
    (sum, s) => sum + ms(s.to) - ms(s.from),
    0,
  );

  // Holds: who answered, how long, and whether the policy scripts their kind.
  const scripted = new Set(Object.keys(definition.operatorPolicy.answers));
  const holdTotals = {
    total: 0,
    scripted: 0,
    operator: 0,
    open: 0,
    waitMs: 0,
    operatorWaitMs: 0,
    byKind: {},
  };
  for (const hold of holds.values()) {
    hold.policy = scripted.has(hold.kind);
    holdTotals.total += 1;
    holdTotals[hold.policy ? "scripted" : "operator"] += 1;
    if (!hold.answeredAt) holdTotals.open += 1;
    holdTotals.waitMs += hold.waitMs ?? 0;
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
      item.wallMs = to - from;
      item.activeWallMs = to - from - covered(from, to, excluded);
    }
    item.validation.firstPassRate = rate(
      item.validation.passed,
      item.validation.runs,
    );
    item.ci.firstPassRate = rate(item.ci.passedFirstTime, item.ci.published);
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
    check("hold waits (ms)", holdTotals.waitMs, summary.holdWaitMs),
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
    },
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
    totals: {
      wallMs,
      activeWallMs: wallMs === null ? null : wallMs - excludedMs,
      excludedMs,
      outages,
      pauses,
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
      validation: {
        ...validation,
        firstPassRate: rate(validation.passed, validation.runs),
      },
      ci: { ...ci, firstPassRate: rate(ci.passedFirstTime, ci.published) },
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
