import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY } from "../scripts/lib/github.mjs";
import { decisionSpendMarker, harnessMarker, rebaseCostMarker, setSelf, spendMarker } from "../scripts/lib/logic.mjs";
import { PENDULUM_VERSION } from "../scripts/lib/inputs.mjs";
import { writeUsage } from "../scripts/lib/session.mjs";
import { costOf, loadPrices } from "../scripts/lib/cost-join.mjs";
import { BILLING_WORDS } from "../scripts/lib/usage.mjs";
import { REPORT_SCHEMA, STOPPED_EXIT, buildReport, readReport, renderReport, reportCheck, reportScope } from "../scripts/lib/report.mjs";
import { parseArgs, reportCommand } from "../scripts/local.mjs";

RETRY.sleep = async () => {};

// The run the finish card's approved mock-up was made from (clockgrove/pendulum-scratch #3 and PR #4), as GitHub
// answered for it: its two Actions stages' progress comments, written by Pendulum's App, and their usage records.
const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "finish-scratch-3.json"), "utf8"));
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const APP = { id: 2271, slug: "clockgrove-pendulum" };
const BOT = { login: `${APP.slug}[bot]`, type: "Bot" };
const ME = { login: "kirkmarple-clockgrove", type: "User" };
const issueUrl = (n) => `https://api.github.com/repos/${REPO.full}/issues/${n}`;
let nextId = 9000;
/** A comment as the repository-wide comments read answers with it. */
const comment = (n, body, { user = BOT, at = "2026-11-17T03:00:00Z", updated = at, association = user === BOT ? "CONTRIBUTOR" : "OWNER", app = user === BOT ? APP : null } = {}) => ({ id: (nextId += 1), issue_url: issueUrl(n), user, author_association: association, ...(app ? { performed_via_github_app: { id: app.id, slug: app.slug } } : {}), created_at: at, updated_at: updated, body });
const harness = (h, model, account = null) => harnessMarker(h, model, { worker: model, subagent: null, reviewer: null, labels: [], ...(account ? { account } : {}) });
/** A progress comment: its marker, the stage's own lines, its harness line and, for a local stage, its spend line. */
const progress = (n, stage, key, { h = "claude", model = "claude-opus-5-5", spend = null, rebase = null, account = null, ...rest } = {}) =>
  comment(n, [`<!-- pendulum:${n}:progress:${stage}:${key} -->`, `Pendulum ${stage}: started.`, `- 03:00Z harness ${h} (${model}) attempt 1`, "- 03:05Z exit: delivered", harness(h, model, account), ...(spend ? [spendMarker(spend.usd, spend.parts)] : []), ...(rebase ? [rebaseCostMarker(rebase)] : [])].join("\n"), rest);

// #3: the scratch run, on GitHub Actions, as the App wrote it (no spend line: its dollars are in its usage artifacts).
const scratch = real.comments.map((c) => ({ ...c, id: (nextId += 1), issue_url: issueUrl(3), performed_via_github_app: { id: APP.id, slug: APP.slug }, user: BOT }));
const scratchIssue = { ...real.issue, title: "Add multiply(a, b) to the math module", state: "closed" };
const scratchPr = { ...real.pr, head: { ...real.pr.head, ref: "pendulum/3" } };

/** The artifact records of #3, written by the real writer (session.mjs writeUsage) from its passes. */
function scratchRecords() {
  const work = mkdtempSync(join(tmpdir(), "usage-work-"));
  const review = mkdtempSync(join(tmpdir(), "usage-review-"));
  const pass = (label, usd, started, ended, extra = {}) => ({ harness: "claude", model: "claude-opus-5-5", label, effort: "medium", usd, tokens: { input: 100_000, output: 4_000, cached: 80_000, written: 15_000 }, started, ended, resumed: false, ok: true, billing: "api", basis: "harness-reported: total_cost_usd, modelUsage (sub-agents included)", cache: { first: { unit: "request", input: 30_000, cached: 0, written: 29_000 } }, ...extra });
  // The work stage: its build, a validation fix that resumed the session, and an answer pass; 0.35637 in all.
  const workRec = writeUsage(work, {
    harness: "claude",
    model: "claude-opus-5-5",
    records: [pass("work-1", 0.2, "2026-11-17T02:24:37Z", "2026-11-17T02:25:07Z"), pass("validation-fix-1", 0.1, "2026-11-17T02:25:10Z", "2026-11-17T02:25:30Z", { resumed: true }), pass("answer", 0.05637, "2026-11-17T02:25:31Z", "2026-11-17T02:25:36Z")],
    passes: 1,
    exit: "delivered",
    reason: "",
    credentialBasis: "ANTHROPIC_API_KEY",
    billing: "api",
    progressRun: "44002648279",
    ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [], hosts: [], effort: "medium", reviewerEffort: null },
  });
  const reviewRec = writeUsage(review, {
    harness: "claude",
    model: "claude-fable-5-2",
    records: [pass("review", 0.163442, "2026-11-17T02:26:27Z", "2026-11-17T02:26:38Z", { model: "claude-fable-5-2", effort: null })],
    passes: 1,
    exit: "delivered",
    reason: "",
    credentialBasis: "ANTHROPIC_API_KEY",
    billing: "api",
    progressRun: "44002920873",
    ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [], hosts: [], effort: "medium", reviewerEffort: null },
  });
  return { work: JSON.parse(readFileSync(join(work, "result.json"), "utf8")), review: JSON.parse(readFileSync(join(review, "result.json"), "utf8")), workRec, reviewRec };
}

/**
 * The repository: #3 (Actions, merged), #5 (local, a subscription build and a Copilot review, Blocked, with decision
 * calls outside a stage), #7 (mixed route: its build on Actions, its rebase and review local, merged), #8 (Actions, its
 * artifact expired; a local stage whose harness reported no cost; closed unmerged); and pastes of Pendulum's markers by a
 * stranger, by GitHub Actions' bot and by a member who is not Pendulum.
 */
function world() {
  const recs = scratchRecords();
  const comments = [
    ...scratch,
    progress(5, "work", "local-a1", { user: ME, spend: { usd: 1.2, parts: { usdByBilling: { subscription: 1.2 }, billing: "subscription" } }, account: "alpha" }),
    progress(5, "review", "local-b2", { user: ME, h: "copilot", model: "claude-sonnet-5-5", spend: { usd: 0.3, parts: { usdByBilling: { credits: 0.3 }, billing: "credits" } }, account: "beta", at: "2026-11-17T03:10:00Z" }),
    comment(5, `<!-- pendulum:5:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 3, usd: 0.02 })}`, { user: ME, at: "2026-11-17T03:20:00Z" }),
    progress(7, "work", "51001", { at: "2026-11-17T04:00:00Z" }),
    progress(7, "work", "local-r1", { user: ME, at: "2026-11-17T04:30:00Z", spend: { usd: 0.4, parts: { usdByBilling: { api: 0.4 }, billing: "api" } }, rebase: { usd: 0.4, conflict: true, usdByBilling: { api: 0.4 }, billing: "api" } }),
    progress(7, "review", "local-r2", { user: ME, at: "2026-11-17T04:40:00Z", model: "claude-fable-5-2", spend: { usd: 0.25, parts: { usdByBilling: { api: 0.25 }, billing: "api" } } }),
    progress(8, "work", "61001", { at: "2026-11-17T05:00:00Z" }),
    progress(8, "review", "local-u1", { user: ME, at: "2026-11-17T05:30:00Z", spend: { usd: 0, parts: { usdUnknown: 1, usdUnknownWhy: ["unreported"] } } }),
    // A stranger's paste and GitHub Actions' bot: nothing. A member who is not Pendulum: a run of unknown cost.
    progress(3, "work", "999", { user: { login: "stranger", type: "User" }, association: "NONE", spend: { usd: 999 } }),
    progress(3, "work", "998", { user: { login: "github-actions[bot]", type: "Bot" }, association: "NONE", app: { id: 15368, slug: "github-actions" }, spend: { usd: 999 } }),
    progress(7, "work", "997", { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T04:50:00Z", spend: { usd: 50 } }),
  ];
  const issue = (number, labels, state, title) => ({ number, title, state, labels: labels.map((name) => ({ name })), created_at: "2026-11-17T01:00:00Z", user: ME });
  const issues = [{ ...scratchIssue, created_at: "2026-11-17T02:23:41Z" }, issue(5, ["pendulum:objective", "pendulum:local", "pendulum:blocked"], "open", "Five"), issue(7, ["pendulum:objective"], "closed", "Seven"), issue(8, ["pendulum:objective"], "closed", "Eight"), issue(9, ["pendulum:objective"], "open", "Nine, not started")];
  const pulls = [scratchPr, { number: 70, head: { ref: "pendulum/7" }, created_at: "2026-11-17T04:20:00Z", updated_at: "2026-11-17T05:00:00Z", merged_at: "2026-11-17T05:00:00Z" }, { number: 80, head: { ref: "pendulum/8" }, created_at: "2026-11-17T05:10:00Z", updated_at: "2026-11-17T06:00:00Z", merged_at: null, state: "closed" }];
  const artifacts = {
    "pendulum-usage-3": [{ id: 301, name: "pendulum-usage-3", expired: false, workflow_run: { id: 44002648279 }, record: recs.work }],
    "pendulum-usage-3-review": [{ id: 302, name: "pendulum-usage-3-review", expired: false, workflow_run: { id: 44002920873 }, record: recs.review }],
    // #7's build on Actions: a record from before records named their comment, matched by its workflow run.
    "pendulum-usage-7": [{ id: 701, name: "pendulum-usage-7", expired: false, workflow_run: { id: 51001 }, record: { harness: "claude", model: "claude-opus-5-5", usd: 0.9, runs: 1, exit: "delivered", tokens: { input: 1000, output: 100, cached: 0, written: 0 }, usdByBilling: { api: 0.9 }, billing: "api", started: "2026-11-17T04:00:10Z", ended: "2026-11-17T04:10:00Z" } }],
    "pendulum-usage-8": [{ id: 801, name: "pendulum-usage-8", expired: true, workflow_run: { id: 61001 } }],
  };
  return { comments, issues, pulls, artifacts, recs };
}

/** A fake GitHub over `w`, answering the reads a report makes, page by page; `calls` lists every request. */
function fakeGitHub(w) {
  const calls = [];
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const page = (list, u) => {
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const p = Number(u.searchParams.get("page") ?? 1);
    return list.slice((p - 1) * per, p * per);
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO.full}`, "");
    calls.push(`${init.method || "GET"} ${p}${u.search}`);
    if ((init.method || "GET") !== "GET") return json({ message: "a report writes nothing" }, 405);
    if (u.pathname === "/user") return json(ME);
    if (p === "/issues/comments") {
      const since = u.searchParams.get("since");
      return json(page(w.comments.filter((c) => !since || Date.parse(c.updated_at) >= Date.parse(since)), u));
    }
    if (p === "/issues") {
      const label = u.searchParams.get("labels");
      return json(page(w.issues.filter((i) => !label || i.labels.some((l) => l.name === label)), u));
    }
    let m = /^\/issues\/(\d+)$/.exec(p);
    if (m) return w.issues.find((i) => i.number === Number(m[1])) ? json(w.issues.find((i) => i.number === Number(m[1]))) : json({ message: "Not Found" }, 404);
    m = /^\/issues\/(\d+)\/sub_issues$/.exec(p);
    if (m) return json(page(w.issues.filter((i) => (w.parents?.[m[1]] || []).includes(i.number)), u));
    if (p === "/pulls") return json(page(w.pulls, u));
    if (p === "/actions/artifacts") {
      const list = (w.artifacts[u.searchParams.get("name")] || []).map(({ record, ...a }) => a);
      return json({ total_count: list.length, artifacts: list });
    }
    return json({ message: "Not Found" }, 404);
  };
  const download = async (_repo, a) => {
    calls.push(`DOWNLOAD ${a.id}`);
    return Object.values(w.artifacts).flat().find((x) => x.id === a.id)?.record ?? null;
  };
  return { fetch, download, calls };
}

/** Run `fn` with the fake GitHub in place of api.github.com. */
async function over(fake, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = fake.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

const NOW = Date.parse("2026-11-18T00:00:00Z");
/** `pendulum report` through its real command, on the fake: {code, json, err, calls}. */
async function report(w, flags = {}, { cacheHome = null } = {}) {
  const fake = fakeGitHub(w);
  let out = "";
  let err = "";
  const parsed = parseArgs(["report", "--repo", REPO.full, "--checkout", tmpdir(), "--json", "--app", String(APP.id), ...Object.entries(flags).flatMap(([k, v]) => (v === true ? [`--${k}`] : [].concat(v).flatMap((x) => [`--${k}`, String(x)])))]);
  const saved = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome ?? mkdtempSync(join(tmpdir(), "cache-"));
  try {
    const code = await over(fake, () => reportCommand(parsed.flags, { out: (t) => (out += t), err: (t) => (err += t), token: "t", download: fake.download, now: NOW }));
    return { code, json: JSON.parse(out), err, calls: fake.calls };
  } finally {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
  }
}

const usd = (o) => o.cost.usd;
const byIssue = (r, n) => r.objectives.find((o) => o.issue === n);

test("report: totals split by billing kind, never blended; a mix stays apart per Objective; every figure precomputed", async () => {
  const { code, json: r } = await report(world(), { since: "2026-11-17" });
  assert.equal(code, 0);
  assert.equal(r.schema, REPORT_SCHEMA);
  // #3's two Actions stages (its artifacts, billed API) + #7's (0.9 build, 0.4 rebase, 0.25 review) + #5's decision calls.
  assert.deepEqual(usd(r.totals), { api: Math.round((0.35637 + 0.163442 + 0.9 + 0.4 + 0.25 + 0.02) * 1e6) / 1e6, subscription: 1.2, credits: 0.3, unknown: 0, sandbox: 0 });
  assert.ok(!Object.hasOwn(r.totals.cost, "total") && !Object.hasOwn(r.totals.cost.usd, "total"), "no blended total");
  // #5: a subscription build and a Copilot review, each at its own kind.
  assert.deepEqual(usd(byIssue(r, 5)), { api: 0.02, subscription: 1.2, credits: 0.3, unknown: 0, sandbox: 0 });
  assert.equal(r.words.subscription, "API-equivalent at list prices, on the subscription");
  assert.equal(r.words.credits, BILLING_WORDS.credits);
  // The breakdowns partition the totals, each row already summed: by stage, harness and model.
  const stage = Object.fromEntries(r.breakdowns.stage.map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(stage).sort(), ["decisions", "rebase", "review", "work"]);
  assert.equal(stage.decisions.cost.usd.api, 0.02);
  // Eight Claude stages (#3's two, #5's build, #7's three, #8's two), #5's Copilot review, its decision calls, and the
  // teammate's stage comment, whose harness no record of Pendulum's names.
  assert.deepEqual(r.breakdowns.harness.map((x) => [x.key, x.stages]), [["claude", 8], ["copilot", 1], ["decisions", 1], [null, 1]]);
  assert.equal(r.breakdowns.model.find((x) => x.key === "claude-fable-5-2").cost.usd.api, 0.163442 + 0.25);
  assert.ok(!r.breakdowns.account, "no per-account rows unless asked");
  assert.ok(!JSON.stringify(r).includes("alpha"), "no account name anywhere unless asked");
  // --by account: one row per account, its figures split the same way.
  const { json: acct } = await report(world(), { since: "2026-11-17", by: "account" });
  assert.deepEqual(acct.breakdowns.account.filter((x) => x.key === "alpha" || x.key === "beta").map((x) => [x.key, usd(x)]), [["alpha", { api: 0, subscription: 1.2, credits: 0, unknown: 0, sandbox: 0 }], ["beta", { api: 0, subscription: 0, credits: 0.3, unknown: 0, sandbox: 0 }]]);
  // The scorer's own cost join gives #3 the same dollars: one implementation.
  const w = world();
  const join3 = costOf([{ ...w.recs.work, artifact: "pendulum-usage-3" }, { ...w.recs.review, artifact: "pendulum-usage-3-review" }], loadPrices());
  assert.equal(Math.round((usd(byIssue(r, 3)).api - join3.usd) * 1e4), 0);
  // The Markdown carries the same figures, each kind apart.
  const md = renderReport(r);
  assert.match(md, /^# Pendulum cost report: acme\/app$/m);
  assert.match(md, /\| API \| Subscription \(API-equivalent\) \| Copilot AI credits \| Billing not recorded \| Sandbox \| Unknown runs \|/);
  assert.match(md, /Runs of unknown cost: \d+/);
});

test("report: runs of unknown cost are counted, each with its reason; an expired artifact is a stage of unknown cost, never $0", async () => {
  const { json: r } = await report(world(), { since: "2026-11-17" });
  const eight = byIssue(r, 8);
  assert.deepEqual(usd(eight), { api: 0, subscription: 0, credits: 0, unknown: 0, sandbox: 0 });
  assert.equal(eight.cost.unknownRuns, 2);
  assert.deepEqual(eight.cost.unknownWhy, ["no-record", "unreported"]);
  assert.equal(eight.outcome, "closed-unmerged");
  const reasons = Object.fromEntries(r.unknown.reasons.map((x) => [x.code, x.runs]));
  assert.deepEqual(reasons, { "no-record": 1, unreported: 1, unattributed: 1 });
  assert.equal(r.unknown.runs, 3);
  assert.equal(r.totals.cost.unknownRuns, 3);
  assert.ok(r.unknown.reasons.every((x) => typeof x.text === "string" && x.text.length));
  assert.deepEqual(r.unknown.items.filter((x) => x.issue === 8).map((x) => [x.stage, x.runs, x.why]), [["work", 1, ["no-record"]], ["review", 1, ["unreported"]]]);
  // What was missing is said: the expired artifact, the stage with no record.
  const missing = Object.fromEntries(r.source.missing.map((m) => [m.code, m]));
  assert.equal(missing["artifact-expired"].count, 1);
  assert.deepEqual(missing["no-record"].issues, [8]);
  // The spend in Objectives that ended Blocked or closed unmerged, ranked by their stages.
  assert.deepEqual(r.hotSpots.blockedOrUnmergedSpend.items.map((x) => [x.issue, x.outcome, x.stages]), [[5, "blocked", 2], [8, "closed-unmerged", 2]]);
});

test("report: a mixed-route Objective counts each stage once, its Actions build from its artifact and its local rebase and review from their spend lines", async () => {
  const { json: r } = await report(world(), { issue: 7 });
  assert.deepEqual(r.objectives.map((o) => o.issue), [7]);
  const seven = byIssue(r, 7);
  // Its build, the teammate's stage comment (a stage of unknown cost, below), its rebase and its review.
  assert.deepEqual(seven.stages, { work: 2, rebase: 1, review: 1 });
  assert.deepEqual(usd(seven), { api: 1.55, subscription: 0, credits: 0, unknown: 0, sandbox: 0 });
  // The teammate's paste (a member, not Pendulum) is one run of unknown cost, never its $50.
  assert.equal(seven.cost.unknownRuns, 1);
  assert.deepEqual(seven.cost.unknownWhy, ["unattributed"]);
  assert.equal(seven.outcome, "merged");
  assert.deepEqual(seven.tokens, { input: 1000, output: 100, cached: 0, written: 0 }, "tokens where a record reports them");
  // Only #7's artifacts were listed: its build is the one stage without a spend line.
  const { calls } = await report(world(), { issue: 7 });
  assert.deepEqual(calls.filter((c) => c.includes("/actions/artifacts")).map((c) => new URL(`https://x${c.slice(4)}`).searchParams.get("name")), ["pendulum-usage-7", "pendulum-usage-7-review"]);
});

test("report: trust: a stranger's paste and GitHub Actions' bot count nothing; a member who is not Pendulum is a run of unknown cost; no App id, Pendulum's App is not attributed", async () => {
  const { json: r } = await report(world(), { since: "2026-11-17" });
  assert.equal(r.source.read.ignoredComments, 2, "the stranger's and github-actions[bot]'s");
  assert.equal(r.source.read.unattributedComments, 1, "the teammate's");
  assert.ok(!r.objectives.some((o) => o.cost.usd.api >= 50 || o.cost.usd.unknown >= 50), "no pasted figure counted");
  // The same stranger's paste alone, on an Objective with no stage of Pendulum's: no Objective at all.
  const w = world();
  w.comments.push(progress(42, "work", "1", { user: { login: "stranger", type: "User" }, association: "NONE", spend: { usd: 5 } }));
  w.issues.push({ number: 42, title: "x", state: "open", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME });
  const { json: s } = await report(w, { since: "2026-11-17" });
  assert.ok(!s.objectives.some((o) => o.issue === 42));
  // Without --app, the App's own comments are another App's: #3's stages are runs of unknown cost, and the source says why.
  const fake = fakeGitHub(world());
  const read = await over(fake, () => readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }));
  const noApp = buildReport(read, { now: new Date(NOW).toISOString() });
  assert.deepEqual(usd(byIssue(noApp, 3)), { api: 0, subscription: 0, credits: 0, unknown: 0, sandbox: 0 });
  assert.equal(byIssue(noApp, 3).cost.unknownRuns, 2);
  assert.ok(noApp.source.missing.some((m) => m.code === "app-not-given"));
  assert.ok(!fake.calls.some((c) => c.includes("/actions/artifacts")), "no stage of Pendulum's own to read an artifact for");
});

test("report: the call budget: the planned calls are printed before any read, and the reads stop at --max-calls with what was read kept", async () => {
  const full = await report(world(), { since: "2026-11-17" });
  assert.ok(full.json.source.calls.made <= full.json.source.maxCalls);
  assert.ok(full.err.startsWith("pendulum report: planned "), "the plan first");
  const made = full.json.source.calls.made;
  for (const max of [1, 3, made - 1]) {
    const { code, json: r, err, calls } = await report(world(), { since: "2026-11-17", "max-calls": max });
    assert.equal(code, STOPPED_EXIT);
    assert.equal(r.source.complete, false);
    assert.equal(r.source.calls.made, max);
    assert.equal(calls.filter((c) => !c.startsWith("DOWNLOAD")).length + calls.filter((c) => c.startsWith("DOWNLOAD")).length * 2, max, "no call past the budget");
    assert.equal(r.source.missing[0].code, "stopped");
    assert.match(err, /^pendulum report: planned \d+ call\(s\)/);
    assert.match(err, /stopped at --max-calls/);
  }
  // A downloaded artifact is cached by id under the user's cache directory: the next report downloads nothing.
  const cache = mkdtempSync(join(tmpdir(), "cache-"));
  const first = await report(world(), { issue: 3 }, { cacheHome: cache });
  assert.equal(first.calls.filter((c) => c.startsWith("DOWNLOAD")).length, 2);
  const again = await report(world(), { issue: 3 }, { cacheHome: cache });
  assert.equal(again.calls.filter((c) => c.startsWith("DOWNLOAD")).length, 0);
  assert.deepEqual(again.json.objectives, first.json.objectives);
  assert.equal(again.json.source.read.artifacts.cached, 2);
  assert.ok(readFileSync(join(cache, "pendulum", "artifacts", "acme", "app", "301.json"), "utf8").includes("44002648279"));
  // The report reads no timelines, workflow runs or jobs (the scorer's walk-away reads), and writes nothing.
  assert.ok(!full.calls.some((c) => /timeline|\/actions\/runs|\/jobs|^(POST|PATCH|PUT|DELETE)/.test(c)));
});

test("report: writeUsage records each pass in result.json (the ledger), with the effort and the Pendulum version in `ran`; the report breaks stages down by pass from it", async () => {
  const { work } = scratchRecords();
  assert.equal(work.ran.pendulum, PENDULUM_VERSION);
  assert.equal(work.ran.effort, "medium");
  assert.deepEqual(work.ledger.map((p) => [p.label, p.model, p.effort, p.usd, p.usdUnknown, p.billing, p.resumed]), [
    ["work-1", "claude-opus-5-5", "medium", 0.2, 0, "api", false],
    ["validation-fix-1", "claude-opus-5-5", "medium", 0.1, 0, "api", true],
    ["answer", "claude-opus-5-5", "medium", 0.05637, 0, "api", false],
  ]);
  assert.deepEqual(work.ledger[0].tokens, { input: 100_000, output: 4_000, cached: 80_000, written: 15_000 });
  assert.deepEqual(work.ledger[0].firstCache, { unit: "request", input: 30_000, cached: 0, written: 29_000 });
  assert.equal(work.ledger[0].started, "2026-11-17T02:24:37Z");
  // A decision record and a pass of unknown cost keep their own entries.
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const rec = writeUsage(dir, { harness: "claude", model: "m", records: [{ harness: "claude", model: "m", label: "work-1", usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"], tokens: { input: null, output: null, cached: null }, started: "a", ended: "b" }, { harness: "claude", model: "m", label: "decision", decision: true, calls: 2, usd: 0.01, tokens: { input: 5, output: 1, cached: 0 } }, { harness: "claude", model: "m", label: "run", noRun: true, usd: 0, tokens: {} }], passes: 0, exit: "blocked", reason: "x", credentialBasis: null });
  assert.deepEqual(rec.ledger.map((p) => [p.label, p.decision ?? false, p.usd, p.usdUnknown, p.usdUnknownWhy, p.billing]), [["work-1", false, null, 1, ["unreported"], null], ["decision", true, 0.01, 0, [], null]]);
  assert.equal(rec.ran, undefined, "no `ran` given: none written");

  // The report reads it: passes by kind, answer and fix passes, the cache-write share and the cost per model minute.
  const { json: r } = await report(world(), { issue: 3 });
  const three = byIssue(r, 3);
  assert.deepEqual(three.passes, { total: 4, answer: 1, fix: 1 });
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api]), [["work", 1, 0.2], ["validation-fix", 1, 0.1], ["answer", 1, 0.05637], ["review", 1, 0.163442]]);
  assert.deepEqual(r.hotSpots.answerAndFixPasses.items, [{ issue: 3, answer: 1, fix: 1, passes: 2 }]);
  assert.deepEqual(r.hotSpots.cacheWriteShare.items.map((x) => [x.passKind, x.written, x.input, x.share]), [["answer", 15000, 100000, 0.15], ["review", 15000, 100000, 0.15], ["validation-fix", 15000, 100000, 0.15], ["work", 15000, 100000, 0.15]]);
  // 0.519812 over 30 + 20 + 5 + 11 seconds of passes, billed per use.
  assert.deepEqual(three.usdPerModelMinute, { api: { usd: 0.519812, modelMinutes: 1.1, passes: 4, usdPerModelMinute: Math.round((0.519812 / (66 / 60)) * 1e6) / 1e6 } });
  assert.deepEqual(r.breakdowns.version.map((x) => [x.key, x.stages]), [[PENDULUM_VERSION, 2]]);
  // An older record, with no ledger: said, never a guess.
  const w = world();
  for (const a of [...w.artifacts["pendulum-usage-3"], ...w.artifacts["pendulum-usage-3-review"]]) {
    delete a.record.ledger;
    delete a.record.ran;
  }
  const { json: old } = await report(w, { issue: 3 });
  assert.equal(byIssue(old, 3).passes, null);
  assert.equal(byIssue(old, 3).usdPerModelMinute, null);
  assert.deepEqual(old.hotSpots.answerAndFixPasses.unrecorded, [3]);
  assert.deepEqual(old.source.missing.filter((m) => m.code === "no-ledger" || m.code === "no-version").map((m) => [m.code, m.issues]), [["no-ledger", [3]], ["no-version", [3]]]);
  assert.deepEqual(old.breakdowns.version.map((x) => x.key), [null]);
});

/** Every key path of a JSON value with its type, arrays read at their first item: the schema's shape. */
const shape = (v, at = "") => (Array.isArray(v) ? (v.length ? shape(v[0], `${at}[]`) : [`${at}[]`]) : v && typeof v === "object" ? Object.keys(v).sort().flatMap((k) => shape(v[k], `${at}.${k}`)) : [`${at}:${v === null ? "null" : typeof v}`]);

test("report: --json keeps its schema: every field the documented shape names, of its type", async () => {
  const { json: r } = await report(world(), { since: "2026-11-17", by: "account" });
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(r), ["breakdowns", "generatedAt", "hotSpots", "objectives", "pendulum", "repository", "schema", "scope", "source", "totals", "unknown", "words"]);
  assert.deepEqual(keys(r.scope), ["by", "defaultPeriod", "issues", "label", "parent", "since", "until"]);
  assert.deepEqual(keys(r.words), ["api", "credits", "sandbox", "subscription", "unknown"]);
  assert.deepEqual(keys(r.totals), ["cost", "objectives", "passes", "stages", "tokens"]);
  const cost = [".unknownRuns:number", ".unknownWhy[]", ".usd.api:number", ".usd.credits:number", ".usd.sandbox:number", ".usd.subscription:number", ".usd.unknown:number"];
  assert.deepEqual(shape(r.objectives.find((o) => o.issue === 5).cost).map((s) => s.replace(/\[\]:string$/, "[]")), cost);
  assert.deepEqual(keys(r.unknown), ["items", "reasons", "runs"]);
  assert.deepEqual(keys(r.unknown.reasons[0]), ["code", "runs", "text"]);
  assert.deepEqual(keys(r.unknown.items[0]), ["issue", "runs", "stage", "why"]);
  assert.deepEqual(keys(r.breakdowns), ["account", "harness", "model", "pass", "stage", "version"]);
  assert.deepEqual(keys(r.breakdowns.stage[0]), ["cost", "key", "stages", "tokens"]);
  assert.deepEqual(keys(r.breakdowns.pass[0]), ["cost", "key", "modelMinutes", "passes", "tokens"]);
  assert.deepEqual(keys(r.objectives.find((o) => o.issue === 3)), ["cost", "issue", "modelMinutes", "outcome", "passes", "stages", "title", "tokens", "unpricedPasses", "url", "usdPerModelMinute"]);
  assert.deepEqual(keys(r.hotSpots), ["answerAndFixPasses", "blockedOrUnmergedSpend", "cacheWriteShare", "costPerModelMinute", "reviewLoops"]);
  for (const h of Object.values(r.hotSpots)) assert.ok(typeof h.rankBy === "string" && Array.isArray(h.items));
  assert.deepEqual(keys(r.source), ["calls", "complete", "maxCalls", "missing", "read", "stoppedAt"]);
  assert.deepEqual(keys(r.source.read), ["artifacts", "comments", "ignoredComments", "issues", "localRecords", "pendulumComments", "pulls", "unattributedComments"]);
  assert.deepEqual(keys(r.source.missing[0]), ["code", "count", "issues", "text"]);
  // The documented schema names every top-level field and the version (docs/REPORT.md).
  const doc = readFileSync(join(import.meta.dirname, "..", "..", "docs", "REPORT.md"), "utf8");
  assert.ok(doc.includes(REPORT_SCHEMA));
  for (const k of [...keys(r), ...keys(r.hotSpots), ...keys(r.source)]) assert.ok(doc.includes(`\`${k}\``), `docs/REPORT.md names ${k}`);
});

test("report: privacy: no reason, Block text, task card, transcript or credential string reaches it", async () => {
  const w = world();
  const secret = "ghp_" + "A".repeat(36);
  w.comments.push(comment(5, `<!-- pendulum:5:blocked:work -->\nBlocked (work): the model said ${secret} and the task card said SECRET-PLAN`, { user: ME, at: "2026-11-17T03:30:00Z" }));
  for (const a of w.artifacts["pendulum-usage-3"]) Object.assign(a.record, { reason: `crashed near ${secret}`, session: { transcript: "SECRET-TRANSCRIPT" } });
  const { json: r } = await report(w, { since: "2026-11-17" });
  const text = `${JSON.stringify(r)}\n${renderReport(r)}`;
  for (const s of [secret, "SECRET-PLAN", "SECRET-TRANSCRIPT", "crashed near", "Blocked (work)"]) assert.ok(!text.includes(s), s);
});

test("report: the command line: a period by default, one set at a time, dates and numbers checked before any read", () => {
  const scope = reportScope({}, NOW);
  assert.deepEqual(scope, { since: "2026-10-19T00:00:00Z", until: null, defaultPeriod: true, issues: [], label: null, parent: null });
  assert.deepEqual(reportScope({ issue: ["3,7", "7"] }, NOW).issues, [3, 7]);
  assert.equal(reportScope({ label: "wave-6" }, NOW).since, null, "a set is read whole unless a period is given");
  assert.equal(reportCheck({ since: "yesterday" }), '--since takes a date (2026-11-01) or a time with its zone, not "yesterday"');
  assert.equal(reportCheck({ since: "2026-11-02", until: "2026-11-01" }), "--since must come before --until");
  assert.equal(reportCheck({ issue: ["3", "x"] }), '--issue takes issue numbers (12, or 12,15), not "3 x"');
  assert.equal(reportCheck({ issue: ["3"], label: "a" }), "give one of --issue, --label or --parent");
  assert.equal(reportCheck({ by: "model" }), '--by takes account, not "model"');
  assert.equal(reportCheck({ since: "2026-11-01T10:00:00+02:00" }), null);
  assert.throws(() => parseArgs(["report", "--by", "model"]), /--by takes account/);
  assert.deepEqual(parseArgs(["report", "--issue", "3", "--issue", "7,8", "--json"]).flags.issue, ["3", "7,8"]);
});
