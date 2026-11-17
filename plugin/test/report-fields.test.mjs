// #569: each `pendulum report` field measures what its name says. Passes are harness passes and decision records are
// counted apart (R7); model minutes are every harness pass's, null when one has no times (R5), and a decision record's
// span is none (R6); the runs of unknown cost say how many are decision calls (V3); review rounds leave out a stage that
// ran no pass (W5) and give the reviewer's passes, with cost per model minute on the model rows (V10); a spend line
// written while its stage ran is in flight while its Objective runs (W4); `rates` says when nothing could be weighed (V11).
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { decisionSpendMarker, harnessMarker, ledgerMarker, setSelf, spendMarker } from "../scripts/lib/logic.mjs";
import { pendulumBuild } from "../scripts/lib/release.mjs";
import { renderReport } from "../scripts/lib/report.mjs";
import { parseArgs, reportCommand } from "../scripts/local.mjs";

RETRY.sleep = async () => {};

const PENDULUM_VERSION = pendulumBuild();
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const APP = { id: 2271, slug: "clockgrove-pendulum" };
const BOT = { login: `${APP.slug}[bot]`, type: "Bot" };
const ME = { login: "kirkmarple-clockgrove", type: "User" };
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const T0 = Date.parse("2026-11-17T01:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const issueUrl = (n) => `https://api.github.com/repos/${REPO.full}/issues/${n}`;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
let nextId = 9000;

const blank = () => ({ comments: [], issues: [], pulls: [] });
const objective = (w, n, { state = "closed", labels = [] } = {}) => w.issues.push({ number: n, title: `Objective ${n}`, state, labels: ["pendulum:objective", ...labels].map((name) => ({ name })), created_at: at(-10), user: ME });
const comment = (n, body, { user = ME, when = at(0), app = null } = {}) => ({ id: (nextId += 1), issue_url: issueUrl(n), user, author_association: user === ME ? "OWNER" : "CONTRIBUTOR", ...(app ? { performed_via_github_app: { id: app.id, slug: app.slug } } : {}), created_at: when, updated_at: when, body });

/** One pass of a per-pass ledger, as a usage record holds it: [from, to] minutes after T0 (null: no times), its dollars or null. */
const pass = (label, model, span, usd, { why = ["unreported"], unknown = usd === null ? 1 : 0 } = {}) => ({ label, model, effort: "medium", started: span ? at(span[0]) : null, ended: span ? at(span[1]) : null, usd, usdUnknown: unknown, usdUnknownWhy: unknown ? why : [], billing: "api", usdByBilling: usd === null ? {} : { api: usd }, tokens: { input: 1000, output: 100, cached: 0, written: 0 } });
/** A decision record of `calls` gateway calls, from its first call to its last: their dollars, or `unknown` of them of unknown cost. */
const decision = (calls, span, { usd = null, unknown = usd === null ? calls : 0, why = ["decision-no-cost"] } = {}) => ({ ...pass("decision", null, span, usd, { why, unknown }), decision: true, calls });

/**
 * A local stage by Pendulum's own login, as its end writes it: its progress comment with its harness line, its spend
 * line (its passes' dollars and runs of unknown cost, `extra` added) and its per-pass ledger line.
 */
function stage(w, n, kind, key, passes, { model = kind === "review" ? FABLE : OPUS, when = at(0), extra = {}, ledger = true } = {}) {
  const known = round6(passes.reduce((t, p) => t + (p.usd ?? 0), 0));
  const unknown = passes.reduce((t, p) => t + p.usdUnknown, 0);
  const why = [...new Set(passes.flatMap((p) => p.usdUnknownWhy))].sort();
  const spend = spendMarker(known, { ...(known ? { usdByBilling: { api: known }, billing: "api" } : {}), ...(unknown ? { usdUnknown: unknown, usdUnknownWhy: why } : {}), ...extra });
  const lines = [`<!-- pendulum:${n}:progress:${kind}:${key} -->`, `Pendulum ${kind}: started.`, harnessMarker("claude", model, { worker: OPUS, subagent: null, reviewer: FABLE, labels: [] }), spend];
  if (ledger) lines.push(ledgerMarker(passes, { model, version: PENDULUM_VERSION, published: [OPUS, FABLE] }));
  w.comments.push(comment(n, lines.join("\n"), { when }));
}

function fakeGitHub(w) {
  const calls = [];
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO.full}`, "");
    calls.push(`${init.method || "GET"} ${p}${u.search}`);
    if ((init.method || "GET") !== "GET") return json({ message: "a report writes nothing" }, 405);
    if (u.pathname === "/user") return json(ME);
    if (p === "/issues/comments") return json(w.comments);
    let m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m) return json(w.comments.filter((c) => c.issue_url === issueUrl(Number(m[1]))));
    m = /^\/issues\/(\d+)$/.exec(p);
    if (m) {
      const i = w.issues.find((x) => x.number === Number(m[1]));
      return i ? json({ ...i, comments: w.comments.filter((c) => c.issue_url === issueUrl(i.number)).length }) : json({ message: "Not Found" }, 404);
    }
    if (p === "/issues") return json(w.issues);
    if (p === "/pulls") {
      const head = u.searchParams.get("head");
      return json(w.pulls.filter((x) => !head || `${REPO.owner}:${x.head?.ref}` === head));
    }
    if (p === "/actions/artifacts") return json({ total_count: 0, artifacts: [] });
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, calls, download: async () => null };
}

/** `pendulum report --json` through its real command on the fake: {code, json}. */
async function report(w, flags) {
  const fake = fakeGitHub(w);
  let out = "";
  let err = "";
  const parsed = parseArgs(["report", "--repo", REPO.full, "--checkout", tmpdir(), "--json", "--app", String(APP.id), ...flags]);
  const saved = { api: process.env.GITHUB_API_URL, cache: process.env.XDG_CACHE_HOME };
  const realFetch = globalThis.fetch;
  process.env.GITHUB_API_URL = "https://github.test";
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cache-"));
  globalThis.fetch = fake.fetch;
  try {
    const code = await reportCommand(parsed.flags, { out: (t) => (out += t), err: (t) => (err += t), token: "t", download: fake.download, now: Date.parse("2026-11-18T00:00:00Z") });
    assert.ok(code === 0, err);
    return { code, json: JSON.parse(out) };
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of [["GITHUB_API_URL", saved.api], ["XDG_CACHE_HOME", saved.cache]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const byIssue = (r, n) => r.objectives.find((o) => o.issue === n);

/**
 * #20: a work stage (a $0.50 work pass of 5 minutes, then a decision record of 3 gateway calls of unknown cost from
 * minute 6 to minute 30) and a review stage on the reviewer's model (a $0.30 review pass of 2 minutes, an answer pass of
 * 1 minute of unknown cost, a $0.10 fix pass of 1 minute on the worker's model), and a decision-spend line of 2 calls of
 * unknown cost.
 */
function decisionsWorld() {
  const w = blank();
  objective(w, 20);
  stage(w, 20, "work", "local-w20", [pass("work-1", OPUS, [0, 5], 0.5), decision(3, [6, 30])], { when: at(0) });
  stage(w, 20, "review", "local-r20", [pass("review", FABLE, [31, 33], 0.3), pass("answer", OPUS, [34, 35], null), pass("validation-fix-1", OPUS, [36, 37], 0.1)], { when: at(31) });
  w.comments.push(comment(20, `<!-- pendulum:20:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 2, usd: 0.01, usdUnknown: 2, usdUnknownWhy: ["decision-lookup"] })}`, { when: at(40) }));
  return w;
}

test("report (#569 R7, R6): passes are harness passes, and a decision record, counted apart, has no model minutes", async () => {
  const { json: r } = await report(decisionsWorld(), ["--issue", "20"]);
  const o = byIssue(r, 20);
  assert.deepEqual(o.passes, { total: 4, answer: 1, fix: 1 }, "work, review, answer and fix: the decision record is no pass");
  assert.equal(o.decisionRecords, 1);
  assert.deepEqual([r.totals.passes, r.totals.decisionRecords], [4, 1]);
  const row = (k) => r.breakdowns.pass.find((x) => x.key === k);
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.decisionRecords, x.modelMinutes]), [["work", 1, 0, 5], ["decision", 0, 1, null], ["review", 1, 0, 2], ["answer", 1, 0, 1], ["validation-fix", 1, 0, 1]]);
  // The decision record's span (its first call to its last: 24 minutes) is in no model minutes.
  assert.equal(row("decision").cost.unknownRuns, 3);
  assert.equal(r.breakdowns.pass.reduce((t, x) => t + x.passes, 0), r.totals.passes);
  assert.match(renderReport(r), /^\| decision \| 1 decision record\(s\) \|/m);
});

test("report (#569 R5): an Objective's model minutes are every harness pass's, its cost per model minute over the priced ones as shown", async () => {
  const { json: r } = await report(decisionsWorld(), ["--issue", "20"]);
  const o = byIssue(r, 20);
  // 5 + 2 + 1 + 1: the unpriced answer pass's minute too, never the decision record's 24.
  assert.equal(o.modelMinutes, 9);
  assert.equal(o.unpricedPasses, 1);
  // $0.90 over the 8 minutes of the three passes whose dollars were all reported.
  assert.deepEqual(o.usdPerModelMinute, { api: { usd: 0.9, pricedMinutes: 8, pricedPasses: 3, usdPerModelMinute: 0.1125 } });
});

test("report (#569 R5): a harness pass with no times leaves the Objective's model minutes unknown (pendulum-scratch #19), and the ratio is the dollars over the minutes shown", async () => {
  // pendulum-scratch #19: a work stage whose one pass ended unreported with no times, a work stage of 53.083 s and a
  // review stage of 11.377 s. v0.10.2 reported 1.07 model minutes, the two priced passes'; the oracle, the finish card's
  // summary and the arms say null.
  const w = blank();
  objective(w, 19);
  const ms = (from, to) => [(from - T0) / 60_000, (to - T0) / 60_000];
  stage(w, 19, "work", "44091891065", [pass("work-1", OPUS, null, null)], { when: at(0) });
  stage(w, 19, "work", "44092248787", [pass("work-1", OPUS, ms(T0 + 120_000, T0 + 173_083), 0.233129)], { when: at(2) });
  stage(w, 19, "review", "44092623336", [pass("review", FABLE, ms(T0 + 300_000, T0 + 311_377), 0.189198)], { when: at(5) });
  const { json: r } = await report(w, ["--issue", "19"]);
  const o = byIssue(r, 19);
  assert.equal(o.modelMinutes, null);
  const x = o.usdPerModelMinute.api;
  assert.deepEqual([x.usd, x.pricedMinutes, x.pricedPasses], [0.422327, round6(64.46 / 60), 2]);
  assert.equal(x.usdPerModelMinute, round6(x.usd / x.pricedMinutes), "worked out from the figures shown");
});

test("report (#569 V3): the runs of unknown cost say how many are decision calls, by stage, by Objective and in total", async () => {
  const { json: r } = await report(decisionsWorld(), ["--issue", "20"]);
  const o = byIssue(r, 20);
  // 3 decision calls in the work stage's record, 1 answer pass, 2 decision calls of the decision-spend line.
  assert.deepEqual([o.cost.unknownRuns, o.cost.unknownDecisionCalls], [6, 5]);
  assert.deepEqual([r.totals.cost.unknownRuns, r.totals.cost.unknownDecisionCalls, r.unknown.runs, r.unknown.decisionCalls], [6, 5, 6, 5]);
  assert.deepEqual(r.unknown.items.map((x) => [x.stage, x.runs, x.decisionCalls]), [["work", 3, 3], ["review", 1, 0], ["decisions", 2, 2]]);
  assert.deepEqual(r.breakdowns.stage.map((x) => [x.key, x.cost.unknownRuns, x.cost.unknownDecisionCalls]), [["work", 3, 3], ["review", 1, 0], ["decisions", 2, 2]]);
  assert.equal(r.breakdowns.pass.find((x) => x.key === "decision").cost.unknownDecisionCalls, 3);
  assert.match(renderReport(r), /^- Runs of unknown cost: 6 \(5 of them decision calls\) in 2 stage\(s\)/m);
  // A stage with no ledger: its runs are decision calls only when every reason it gives is a decision call's.
  const w = blank();
  objective(w, 30);
  stage(w, 30, "work", "local-w30", [pass("work-1", OPUS, [0, 5], 0.5), decision(3, [6, 30])], { ledger: false });
  stage(w, 30, "work", "local-x30", [pass("work-1", OPUS, [31, 32], null), decision(2, [33, 34])], { ledger: false, when: at(31) });
  const { json: bare } = await report(w, ["--issue", "30"]);
  assert.deepEqual(bare.unknown.items.map((x) => [x.runs, x.decisionCalls, x.why]), [[3, 3, ["decision-no-cost"]], [3, 0, ["decision-no-cost", "unreported"]]]);
});

test("report (#569 V10): review rounds give the reviewer's passes; cost per model minute is on each model's row, and ranked by model", async () => {
  const { json: r } = await report(decisionsWorld(), ["--issue", "20"]);
  assert.deepEqual(r.hotSpots.reviewLoops.items, [{ issue: 20, reviews: 1, reviewerPasses: 1 }]);
  const model = (k) => r.breakdowns.model.find((x) => x.key === k);
  // Each row over the priced harness passes of the stages it counts: the work stage's on the worker's model, the review
  // stage's (its review and fix passes) on the reviewer's.
  assert.deepEqual(model(OPUS).usdPerModelMinute, { api: { usd: 0.5, pricedMinutes: 5, pricedPasses: 1, usdPerModelMinute: 0.1 } });
  assert.deepEqual(model(FABLE).usdPerModelMinute, { api: { usd: 0.4, pricedMinutes: 3, pricedPasses: 2, usdPerModelMinute: 0.133333 } });
  assert.deepEqual(model("decisions").usdPerModelMinute, {});
  assert.deepEqual(r.hotSpots.costPerModelMinute.items.map((x) => [x.model, x.billing, x.usdPerModelMinute]), [[FABLE, "api", 0.133333], [OPUS, "api", 0.1]]);
  const md = renderReport(r);
  assert.match(md, /^\*\*Review rounds\*\*: #20 1 \(1 reviewer pass\(es\)\)$/m);
  assert.match(md, new RegExp(`^\\*\\*Cost per model minute, by model\\*\\*: ${FABLE} \\$0\\.13/min api \\(\\$0\\.40 over 3 min of 2 priced pass\\(es\\)\\); ${OPUS} \\$0\\.10/min api`, "m"));
});

/**
 * #21, merged: a work stage, a review stage that ran no pass (its spend line says `noPass`: its one decision call aside)
 * and a review stage that did. With `card`, its finish card as Pendulum's App posts it, built by the real card.
 */
async function noPassWorld({ card = false } = {}) {
  const w = blank();
  objective(w, 21);
  stage(w, 21, "work", "local-w21", [pass("work-1", OPUS, [0, 5], 0.5)], { when: at(0) });
  stage(w, 21, "review", "local-r21a", [decision(1, [10, 10.5], { usd: 0.01 })], { when: at(10), extra: { noPass: true } });
  stage(w, 21, "review", "local-r21b", [pass("review", FABLE, [20, 22], 0.3), pass("validation-fix-1", OPUS, [23, 25], 0.2)], { when: at(20) });
  const pr = { number: 1021, head: { ref: "pendulum/21", repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: at(4), updated_at: at(50), merged_at: at(50), state: "closed" };
  w.pulls.push(pr);
  if (card) {
    const finish = await import("../scripts/lib/finish-card.mjs");
    const mine = (c) => c.user?.login === ME.login || finish.pendulumOwn(APP.id)(c);
    const timeline = [{ event: "labeled", label: { name: "pendulum:objective" }, actor: ME, created_at: at(-1) }];
    const d = finish.finishData({ repo: REPO.full, issue: w.issues[0], timeline, comments: [...w.comments], pulls: [{ pr, timeline: [], reviews: [], reviewComments: [] }], checks: [], records: [], mine });
    w.comments.push(comment(21, finish.finishCardBody(d), { user: BOT, app: APP, when: at(51) }));
  }
  return w;
}

test("report (#569 W5): a review stage whose spend line says it ran no pass is a stage but no review round, on the stage path and the card path alike", async () => {
  const { json: r } = await report(await noPassWorld(), ["--issue", "21"]);
  const o = byIssue(r, 21);
  assert.deepEqual([o.stages.review, o.reviewRounds], [2, 1]);
  assert.deepEqual(r.hotSpots.reviewLoops.items, [{ issue: 21, reviews: 1, reviewerPasses: 1 }]);
  // Read from its finish card's summary: the same figures.
  const { json: card } = await report(await noPassWorld({ card: true }), ["--issue", "21"]);
  assert.equal(card.source.read.summaries, 1);
  for (const k of ["objectives", "totals", "unknown", "breakdowns", "hotSpots"]) assert.deepEqual(card[k], r[k], k);
});

test("report (#569 W4): a spend line written while its stage ran is in flight while its Objective is Running, and read as it stands once it is not", async () => {
  const running = (n, { labels, state, open }) => {
    const w = blank();
    objective(w, n, { state, labels });
    stage(w, n, "work", `local-w${n}`, [pass("work-1", OPUS, [0, 5], 0.2), pass("work-2", OPUS, [6, 7], null), pass("work-3", OPUS, null, null)], { ledger: false, extra: { running: true, usdRunning: open } });
    return w;
  };
  // Both runs still open, the Objective Running: in flight, not unreported.
  const { json: live } = await report(running(22, { labels: ["pendulum:running"], state: "open", open: 2 }), ["--issue", "22"]);
  assert.deepEqual([byIssue(live, 22).cost.unknownRuns, byIssue(live, 22).cost.unknownWhy], [2, ["running"]]);
  assert.deepEqual(live.unknown.reasons.map((x) => [x.code, x.runs]), [["running", 2]]);
  assert.match(live.unknown.reasons[0].text, /in flight/);
  // One of its two runs open: both reasons, as a stage's runs are not split between its reasons.
  const { json: part } = await report(running(23, { labels: ["pendulum:running"], state: "open", open: 1 }), ["--issue", "23"]);
  assert.deepEqual(byIssue(part, 23).cost.unknownWhy, ["running", "unreported"]);
  // The Objective is no longer Running (its stage was killed after the write): the line's runs ended unreported.
  const { json: done } = await report(running(24, { labels: ["pendulum:blocked"], state: "open", open: 2 }), ["--issue", "24"]);
  assert.deepEqual([byIssue(done, 24).cost.unknownRuns, byIssue(done, 24).cost.unknownWhy], [2, ["unreported"]]);
});
