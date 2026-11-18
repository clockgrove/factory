import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY, listComments } from "../scripts/lib/github.mjs";
import { FINDINGS_MAX, decisionSpendMarker, findingsMarker, findingsOf, harnessMarker, ledgerMarker, ledgerOfComment, rebaseCostMarker, setSelf, spendMarker, stageSpendLine } from "../scripts/lib/logic.mjs";
import { pendulumBuild } from "../scripts/lib/release.mjs";
import { progressTail, writeUsage } from "../scripts/lib/session.mjs";
import { costOf, loadPrices } from "../scripts/lib/cost-join.mjs";
import { BILLING_WORDS, parseClaude } from "../scripts/lib/usage.mjs";
import { COST_KINDS, REPORT_SCHEMA, STOPPED_EXIT, buildReport, outcomeOf, readReport, renderReport, reportCheck, reportScope } from "../scripts/lib/report.mjs";
import { passLedger } from "../scripts/lib/usage.mjs";
import { keepDecision } from "../scripts/lib/harness.mjs";
import { objectiveRecords } from "../scripts/lib/finish-card.mjs";
import { todaysUsage } from "../scripts/lib/github.mjs";
import { appIdVariableCheck } from "../scripts/doctor.mjs";
import { variableSettings } from "../scripts/lib/inputs.mjs";
import { collectObjective } from "../../bench/lib/collect.mjs";
import { scoreObjective } from "../../bench/lib/objective.mjs";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs, reportCommand } from "../scripts/local.mjs";
import { PREVIOUS_NAME } from "../scripts/lib/local.mjs";
import { newForms } from "./fixtures/progress-new-form.mjs";

/** The Pendulum build a stage of this checkout records (#565 W6): its release at its tag, else with its commit. */
const PENDULUM_VERSION = pendulumBuild();

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
const progress = (n, stage, key, { h = "claude", model = "claude-opus-5-5", spend = null, rebase = null, account = null, findings = null, ...rest } = {}) =>
  comment(n, [`<!-- pendulum:${n}:progress:${stage}:${key} -->`, `Pendulum ${stage}: started.`, `- 03:00Z harness ${h} (${model}) attempt 1`, "- 03:05Z exit: delivered", harness(h, model, account), ...(spend ? [spendMarker(spend.usd, spend.parts)] : []), ...(rebase ? [rebaseCostMarker(rebase)] : []), ...(findings ? [findingsMarker(findings)] : [])].join("\n"), rest);

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
    // Copies: a test that edits one of its comments edits its own world alone.
    ...scratch.map((c) => ({ ...c })),
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
    "pendulum-usage-3": [{ id: 301, name: "pendulum-usage-3", expired: false, workflow_run: { id: 44002648279, repository_id: 1, head_repository_id: 1 }, record: recs.work }],
    "pendulum-usage-3-review": [{ id: 302, name: "pendulum-usage-3-review", expired: false, workflow_run: { id: 44002920873, repository_id: 1, head_repository_id: 1 }, record: recs.review }],
    // #7's build on Actions: a record from before records named their comment, matched by its workflow run.
    "pendulum-usage-7": [{ id: 701, name: "pendulum-usage-7", expired: false, workflow_run: { id: 51001, repository_id: 1, head_repository_id: 1 }, record: { harness: "claude", model: "claude-opus-5-5", usd: 0.9, runs: 1, exit: "delivered", tokens: { input: 1000, output: 100, cached: 0, written: 0 }, usdByBilling: { api: 0.9 }, billing: "api", started: "2026-11-17T04:00:10Z", ended: "2026-11-17T04:10:00Z" } }],
    "pendulum-usage-8": [{ id: 801, name: "pendulum-usage-8", expired: true, workflow_run: { id: 61001, repository_id: 1, head_repository_id: 1 } }],
  };
  return { comments, issues, pulls, artifacts, recs };
}

/**
 * A fake GitHub over `w`, answering the reads a report makes as GitHub does: page by page, with a Link header naming the
 * next and last pages; `w.appVariable` the PENDULUM_APP_ID repository variable (404 without one; a function of the token
 * gives it per token, {status} a refusal); `w.permissions` each comment author's permission on the repository (a
 * status to refuse with; a login it does not name has none, a 404), by default the teammate's alone, a writer's. `calls`
 * lists every request.
 */
function fakeGitHub(w) {
  const calls = [];
  const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  const page = (list, u, wrap = null) => {
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const n = Number(u.searchParams.get("page") ?? 1);
    const last = Math.max(1, Math.ceil(list.length / per));
    const at = (k) => {
      const v = new URL(u);
      v.searchParams.set("page", String(k));
      return v.href;
    };
    const link = n < last && !w.noLink ? { link: `<${at(n + 1)}>; rel="next", <${at(last)}>; rel="last"` } : {};
    const items = list.slice((n - 1) * per, n * per);
    return json(wrap ? wrap(items, list.length) : items, 200, link);
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO.full}`, "");
    calls.push(`${init.method || "GET"} ${p}${u.search}`);
    if ((init.method || "GET") !== "GET") return json({ message: "a report writes nothing" }, 405);
    if (u.pathname === "/user") return json(ME);
    if (p === "/actions/variables/PENDULUM_APP_ID") {
      // Per token when a function (the token without "Bearer "): a value, {status} for GitHub's refusal, or none (404).
      const v = typeof w.appVariable === "function" ? w.appVariable(String(init.headers?.Authorization ?? "").replace(/^Bearer /, "")) : w.appVariable;
      if (v && typeof v === "object") return json({ message: v.message ?? "Resource not accessible by personal access token" }, v.status);
      return v ? json({ name: "PENDULUM_APP_ID", value: String(v) }) : json({ message: "Not Found" }, 404);
    }
    if (p === "/issues/comments") {
      const since = u.searchParams.get("since");
      return page(w.comments.filter((c) => !since || Date.parse(c.updated_at) >= Date.parse(since)), u);
    }
    let m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m) return page(w.comments.filter((c) => c.issue_url === issueUrl(Number(m[1]))), u);
    if (p === "/issues") {
      const label = u.searchParams.get("labels");
      return page(w.issues.filter((i) => !label || i.labels.some((l) => l.name === label)), u);
    }
    m = /^\/issues\/(\d+)$/.exec(p);
    if (m) {
      const i = w.issues.find((x) => x.number === Number(m[1]));
      return i ? json({ ...i, comments: w.comments.filter((c) => c.issue_url === issueUrl(i.number)).length }) : json({ message: "Not Found" }, 404);
    }
    m = /^\/issues\/(\d+)\/sub_issues$/.exec(p);
    if (m) return page(w.issues.filter((i) => (w.parents?.[m[1]] || []).includes(i.number)), u);
    if (p === "/pulls") {
      const head = u.searchParams.get("head");
      return page(w.pulls.filter((x) => !head || `${REPO.owner}:${x.head?.ref}` === head), u);
    }
    m = /^\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (m && w.rateLimitPermission) return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1) });
    if (m) {
      const answer = (w.permissions ?? { teammate: "write" })[decodeURIComponent(m[1])];
      if (typeof answer === "number") return json({ message: "Must have push access to view repository collaborators." }, answer);
      return answer ? json({ permission: answer }) : json({ message: "Not Found" }, 404);
    }
    if (p === "/actions/artifacts") return page((u.searchParams.has("name") ? w.artifacts[u.searchParams.get("name")] || [] : Object.values(w.artifacts).flat()).map(({ record, ...a }) => a), u, (artifacts, total) => ({ total_count: total, artifacts }));
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
async function report(w, flags = {}, { cacheHome = null, app = APP.id } = {}) {
  const fake = fakeGitHub(w);
  let out = "";
  let err = "";
  const parsed = parseArgs(["report", "--repo", REPO.full, "--checkout", tmpdir(), "--json", ...(app === null ? [] : ["--app", String(app)]), ...Object.entries(flags).flatMap(([k, v]) => (v === true ? [`--${k}`] : [].concat(v).flatMap((x) => [`--${k}`, String(x)])))]);
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
    assert.match(err, /^pendulum report: planned at least \d+ call\(s\)/);
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
  // Kept under the API's host, and only the fields the report reads: no reason, session or basis.
  const kept = JSON.parse(readFileSync(join(cache, "pendulum", "artifacts", "github.test", "acme", "app", "301.json"), "utf8")).result;
  assert.equal(kept.progressRun, "44002648279");
  assert.deepEqual(kept.ran, { pendulum: PENDULUM_VERSION });
  for (const k of ["reason", "session", "basis", "credential", "cache", "sessionTotal"]) assert.ok(!Object.hasOwn(kept, k), k);
  // With no finish card, the report reads no timelines, workflow runs or jobs (the scorer's walk-away reads), and writes nothing.
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
  assert.deepEqual(r.hotSpots.cacheWriteShare.items.map((x) => [x.passLabel, x.written, x.input, x.share]), [["answer", 15000, 100000, 0.15], ["review", 15000, 100000, 0.15], ["validation-fix", 15000, 100000, 0.15], ["work", 15000, 100000, 0.15]]);
  // 0.519812 over 30 + 20 + 5 + 11 seconds of passes, billed per use.
  assert.deepEqual(three.usdPerModelMinute, { api: { usd: 0.519812, pricedMinutes: 1.1, pricedPasses: 4, usdPerModelMinute: Math.round((0.519812 / (66 / 60)) * 1e6) / 1e6 } });
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
  assert.deepEqual(keys(r), ["breakdowns", "comparison", "findings", "generatedAt", "hotSpots", "objectives", "pendulum", "rates", "repository", "schema", "scope", "source", "totals", "unknown", "words"]);
  assert.deepEqual(keys(r.findings), ["byReviewer", "byStage", "outcomes", "totals"]);
  assert.deepEqual(keys(r.findings.totals), ["cost", "findings", "outcomes", "reviewStages", "unnamed"]);
  assert.deepEqual(keys(r.scope), ["by", "compare", "defaultPeriod", "issues", "label", "parent", "since", "until"]);
  assert.deepEqual(keys(r.words), ["api", "credits", "sandbox", "subscription", "unknown"]);
  assert.deepEqual(keys(r.totals), ["asked", "churn", "cost", "decisionRecords", "objectives", "passes", "perMerged", "stages", "tokens"]);
  assert.deepEqual(keys(r.totals.perMerged), ["fixPasses", "leftOut", "n", "reviewRounds", "usd", "wallMinutes"]);
  assert.deepEqual(keys(r.totals.perMerged.usd), ["api", "credits", "sandbox", "subscription", "unknown"]);
  assert.deepEqual(keys(r.totals.perMerged.wallMinutes), ["leftOut", "median", "n", "p25", "p75"]);
  assert.deepEqual(keys(r.totals.asked[0]), ["unknownRuns", "usd", "what"]);
  const cost = [".unknownDecisionCalls:number", ".unknownRuns:number", ".unknownUnsplitRuns:number", ".unknownWhy[]", ".usd.api:number", ".usd.credits:number", ".usd.sandbox:number", ".usd.subscription:number", ".usd.unknown:number"];
  assert.deepEqual(shape(r.objectives.find((o) => o.issue === 5).cost).map((s) => s.replace(/\[\]:string$/, "[]")), cost);
  assert.deepEqual(keys(r.unknown), ["decisionCalls", "items", "reasons", "runs", "stages", "unsplitRuns"]);
  assert.deepEqual(keys(r.unknown.reasons[0]), ["code", "runs", "stages", "text"]);
  assert.deepEqual(keys(r.unknown.items[0]), ["decisionCalls", "issue", "runs", "stage", "unsplitRuns", "why"]);
  assert.deepEqual(keys(r.breakdowns), ["account", "day", "harness", "model", "pass", "route", "stage", "version"]);
  assert.deepEqual(keys(r.breakdowns.stage[0]), ["cost", "key", "stages", "tokens"]);
  assert.deepEqual(keys(r.breakdowns.pass[0]), ["cost", "decisionRecords", "key", "modelMinutes", "passes", "spendLineStages", "tokens"]);
  assert.deepEqual(keys(r.breakdowns.model[0]), ["basis", "cost", "key", "stages", "tokens", "usdPerModelMinute"]);
  assert.deepEqual(keys(r.objectives.find((o) => o.issue === 3)), ["asked", "blockedNotices", "churn", "clockWhy", "cost", "decisionRecords", "findings", "issue", "legacyStages", "merged", "modelMinutes", "outcome", "passes", "reviewRounds", "route", "running", "stages", "started", "title", "tokens", "unpricedPasses", "url", "usdPerModelMinute", "wallMinutes"]);
  assert.deepEqual(keys(r.hotSpots.reviewLoops.items[0]), ["issue", "reviewerPasses", "reviews"]);
  assert.deepEqual(keys(r.hotSpots.costPerModelMinute.items[0]), ["billing", "model", "pricedMinutes", "pricedPasses", "usd", "usdPerModelMinute"]);
  assert.deepEqual(keys(r.hotSpots), ["answerAndFixPasses", "blockedOrUnmergedSpend", "blockedStages", "cacheWriteShare", "costPerModelMinute", "reviewLoops"]);
  assert.ok(Array.isArray(r.hotSpots.blockedStages.unrecorded));
  for (const h of Object.values(r.hotSpots)) assert.ok(typeof h.rankBy === "string" && Array.isArray(h.items));
  assert.deepEqual(keys(r.source), ["calls", "complete", "maxCalls", "missing", "read", "stoppedAt", "trusted"]);
  assert.deepEqual(keys(r.source.trusted), ["app", "appFrom", "appWhy", "logins", "refused"]);
  assert.deepEqual(keys(r.source.calls), ["byKind", "made", "planned", "plannedAtLeast"]);
  assert.deepEqual(keys(r.source.read), ["artifacts", "comments", "ignoredComments", "issues", "localRecords", "pendulumComments", "pulls", "summaries", "unattributedComments"]);
  assert.deepEqual(keys(r.source.missing[0]), ["code", "count", "counts", "issues", "text"]);
  assert.deepEqual(keys(r.source.missing[0].counts), ["objectives", "stages"]);
  // The documented schema names every top-level field and the version (docs/REPORT.md).
  const doc = readFileSync(join(import.meta.dirname, "..", "..", "docs", "REPORT.md"), "utf8");
  assert.ok(doc.includes(REPORT_SCHEMA));
  const named = ["decisionRecords", "unknownDecisionCalls", "unknownUnsplitRuns", "unsplitRuns", "decisionCalls", "reviewRounds", "reviewerPasses", "pricedMinutes", "pricedPasses", "usable"];
  for (const k of [...keys(r), ...keys(r.totals), ...keys(r.totals.perMerged), ...keys(r.breakdowns), ...keys(r.objectives[0]), ...keys(r.hotSpots), ...keys(r.source), ...keys(r.findings), ...keys(r.findings.totals), ...r.findings.outcomes, ...named]) assert.ok(doc.includes(`\`${k}\``), `docs/REPORT.md names ${k}`);
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
  assert.deepEqual(scope, { since: "2026-10-19T00:00:00Z", until: null, defaultPeriod: true, issues: [], label: null, parent: null, compare: null });
  assert.deepEqual(reportScope({ issue: ["3,7", "7"] }, NOW).issues, [3, 7]);
  assert.equal(reportScope({ label: "wave-6" }, NOW).since, null, "a set is read whole unless a period is given");
  assert.equal(reportCheck({ since: "yesterday" }), '--since takes a date (2026-11-01) or a time with its zone, not "yesterday"');
  assert.equal(reportCheck({ since: "2026-11-02", until: "2026-11-01" }), "--since must come before --until");
  assert.equal(reportCheck({ issue: ["3", "x"] }), '--issue takes issue numbers (12, or 12,15), not "3 x"');
  assert.equal(reportCheck({ issue: ["3"], label: "a" }), "give one of --issue, --label, --parent or --compare");
  assert.equal(reportCheck({ by: "model" }), '--by takes account, not "model"');
  assert.equal(reportCheck({ since: "2026-11-01T10:00:00+02:00" }), null);
  assert.throws(() => parseArgs(["report", "--by", "model"]), /--by takes account/);
  assert.deepEqual(parseArgs(["report", "--issue", "3", "--issue", "7,8", "--json"]).flags.issue, ["3", "7,8"]);
});

// ------------------------------------------------------------------ the review's fixes (#525)

/** A forged usage artifact a fork's pull request run uploaded under #3's name: $500 that is no one's. */
const FORGED = { id: 999, name: "pendulum-usage-3", expired: false, workflow_run: { id: 77, repository_id: 1, head_repository_id: 2 }, record: { harness: "claude", model: "claude-opus-5-5", usd: 500, runs: 1, progressRun: "44002648279", usdByBilling: { api: 500 }, billing: "api", tokens: { input: 1, output: 1, cached: 0, written: 0 } } };

test("report (B1): an artifact a fork's run uploaded is never read; it is counted under its own missing code", async () => {
  const w = world();
  w.artifacts["pendulum-usage-3"].push(FORGED);
  // One that names no repository id is not read either: the check fails closed.
  w.artifacts["pendulum-usage-3"].push({ ...FORGED, id: 998, workflow_run: { id: 78 } });
  const { json: r, calls } = await report(w, { issue: 3 });
  assert.equal(usd(byIssue(r, 3)).api, 0.519812, "$0.52, not $500.52");
  assert.ok(!calls.includes("DOWNLOAD 999") && !calls.includes("DOWNLOAD 998"));
  const foreign = r.source.missing.find((m) => m.code === "artifact-foreign");
  assert.deepEqual([foreign.count, foreign.issues], [1, [3]]);
  assert.equal(r.source.read.artifacts.foreign, 2);
});

test("the scorer, the finish card and the daily cap (B1): a fork's artifact of an Objective's name is no usage record", async () => {
  // The scorer's collection: the fork's artifact is left out and said in the row.
  const dir = mkdtempSync(join(tmpdir(), "own-"));
  const issue = { number: 3, title: "t", state: "closed", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T02:00:00Z", user: ME };
  const own = { id: 1, name: "pendulum-usage-3", created_at: "2026-11-17T02:26:00Z", expired: false, workflow_run: { id: 44002648279, repository_id: 1, head_repository_id: 1 } };
  const forged = { ...FORGED, created_at: "2026-11-17T02:27:00Z" };
  const api = async (path) => (path === "repos/acme/app/issues/3" ? issue : /actions\/artifacts\?name=pendulum-usage-3&/.test(path) ? [{ artifacts: [own, forged] }] : []);
  const download = async (_repo, a) => {
    const d = join(dir, String(a.id));
    mkdirSync(d);
    writeFileSync(join(d, "result.json"), JSON.stringify(a.id === 999 ? FORGED.record : { harness: "claude", model: "claude-opus-5-5", usd: 0.35637, runs: 1, progressRun: "44002648279" }));
    return d;
  };
  const collected = await collectObjective(api, "acme/app", 3, { download, jobs: false });
  assert.deepEqual(collected.artifacts.map((a) => a.id), [1]);
  assert.deepEqual(collected.usage.map((u) => u.usd), [0.35637]);
  assert.equal(collected.foreignArtifacts, 1);
  const row = scoreObjective(collected, { prices: loadPrices(), now: "2026-11-18T00:00:00Z" });
  assert.equal(row.cost.usd, 0.3564);
  assert.ok(row.missing.includes("1 usage artifact(s) from runs of forks, not read"));
  // The finish card's records and the dispatcher's daily sum read none of it either.
  const fake = fakeGitHub({ ...world(), artifacts: { "pendulum-usage-3": [FORGED, { id: 5, name: "pendulum-usage-3", expired: false, created_at: "2026-11-17T02:26:00Z", workflow_run: { id: 44002648279, repository_id: 1, head_repository_id: 1 } }] } });
  await over(fake, async () => {
    const recs = await objectiveRecords(REPO, 3, { token: "t", want: [{ stage: "work", key: "44002648279" }, { stage: "work", key: "77" }], download: async (a) => ({ id: a.id }) });
    assert.deepEqual(recs.map((x) => x.id), [5]);
    const today = await todaysUsage(REPO, { token: "t", dateIso: "2026-11-17", download: async (_r, a) => ({ usd: a.id }) });
    assert.deepEqual(today.map((x) => x.usd), [5]);
  });
});

test("report (B2): with no App id, the App's stage comments are stages of unknown cost; its vendor comments add none, and its decision calls are decisions of unknown cost", async () => {
  const w = world();
  w.comments.push(comment(3, `<!-- pendulum:3:vendor:work:44002648279 -->\n- sandbox done`, { at: "2026-11-17T02:26:00Z" }));
  w.comments.push(comment(3, `<!-- pendulum:3:vendor:work:5555-abcdef123456 -->\n- sandbox alone`, { at: "2026-11-17T02:26:10Z" }));
  w.comments.push(comment(3, `<!-- pendulum:3:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 2, usd: 0.01 })}`, { at: "2026-11-17T02:27:00Z" }));
  const fake = fakeGitHub(w);
  const read = await over(fake, () => readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }));
  const r = buildReport(read, { now: new Date(NOW).toISOString() });
  const three = byIssue(r, 3);
  assert.deepEqual(three.stages, { work: 1, rebase: 0, review: 1 }, "the two progress comments only");
  assert.equal(r.totals.stages, 2);
  // Two stages, the lone sandbox booking, the decision calls: four runs of unknown cost, and no dollar.
  assert.equal(three.cost.unknownRuns, 4);
  assert.deepEqual(usd(three), { api: 0, subscription: 0, credits: 0, unknown: 0, sandbox: 0 });
  assert.deepEqual(r.breakdowns.stage.map((x) => [x.key, x.stages, x.cost.unknownRuns]), [["work", 1, 2], ["review", 1, 1], ["decisions", 1, 1]]);
  assert.deepEqual(r.unknown.reasons.map((x) => [x.code, x.stages, x.runs]), [["unattributed", 4, 4]]);
  assert.ok(r.source.missing.some((m) => m.code === "app-not-given"));
});

test("report (S1): Pendulum's App id comes from the repository variable PENDULUM_APP_ID; --app overrides it; doctor checks it against app_id", async () => {
  const w = world();
  w.appVariable = APP.id;
  const fake = fakeGitHub(w);
  const read = await over(fake, () => readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }));
  const r = buildReport(read, { now: new Date(NOW).toISOString() });
  assert.equal(usd(byIssue(r, 3)).api, 0.519812);
  assert.deepEqual(r.source.trusted, { logins: ["kirkmarple-clockgrove"], refused: [], app: APP.id, appFrom: "variable", appWhy: null });
  assert.ok(fake.calls.includes("GET /actions/variables/PENDULUM_APP_ID"));
  const flagged = await report(w, { issue: 3 });
  assert.ok(!flagged.calls.some((c) => c.includes("/actions/variables/")), "--app: no variable read");
  assert.equal(flagged.json.source.trusted.appFrom, "flag");
  // Doctor, on Actions: missing, another App's, or the one the jobs run as.
  const repo = { full: "acme/app" };
  assert.equal(appIdVariableCheck({ variable: null, appId: "2271", repo }).status, "WARN");
  assert.match(appIdVariableCheck({ variable: null, appId: "2271", repo }).fix, /^gh variable set PENDULUM_APP_ID --repo acme\/app --body /);
  assert.match(appIdVariableCheck({ variable: "17", appId: "2271", repo }).detail, /names another App/);
  assert.equal(appIdVariableCheck({ variable: "2271", appId: " 2271 ", repo }).status, "PASS");
  assert.equal(appIdVariableCheck({ variable: "2271", appId: "", repo }), null);
  // The variable is no setting: no run reads it, and it is not named as an unknown one.
  assert.deepEqual(variableSettings({ PENDULUM_APP_ID: "2271" }).unknown, []);
});

/** Run `fn` with a fake `gh` first on PATH whose `gh auth token` prints `token`, or fails (no login) when it is null. */
async function withGh(token, fn) {
  const bin = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(bin, "gh"), token === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\n[ "$1 $2" = "auth token" ] && { echo ${token}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}
/** The local copy of acme/app's App id as setup, serve and doctor save it (lib/app-id.mjs), in the test's fake home. */
const appIdCopy = () => join(process.env.HOME, ".config", "pendulum", "repos", REPO.owner, `${REPO.name}.json`);
const appMissing = (r) => r.source.missing.filter((m) => m.code.startsWith("app-")).map((m) => [m.code, m.count]);

const SECONDARY = { status: 403, message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." };
const who = { logins: ["kirkmarple-clockgrove"] };

test("report (#564): the local token gets 403 or 404 on PENDULUM_APP_ID: that one read is made again with the gh login's token, which reads it; the token is never printed", async () => {
  const w = world();
  w.appVariable = (t) => (t === "gho_login" ? APP.id : { status: 403 });
  const r = await withGh("gho_login", () => report(w, { issue: 3 }, { app: null }));
  assert.deepEqual(r.json.source.trusted, { ...who, refused: [], app: APP.id, appFrom: "variable-gh", appWhy: null });
  assert.equal(usd(byIssue(r.json, 3)).api, 0.519812, "the App's stages are Pendulum's");
  assert.deepEqual(r.calls.filter((c) => c.includes("/actions/variables/")), ["GET /actions/variables/PENDULUM_APP_ID", "GET /actions/variables/PENDULUM_APP_ID"]);
  assert.equal(r.json.source.calls.byKind["app id"], 2);
  assert.equal(r.json.source.calls.made, r.json.source.calls.planned, "the second read is planned");
  assert.deepEqual(appMissing(r.json), []);
  assert.ok(!r.err.includes("gho_login") && !JSON.stringify(r.json).includes("gho_login"), "the gh token is never printed");
  // A 404 to a token that may not read variables is read again the same way.
  w.appVariable = (t) => (t === "gho_login" ? APP.id : null);
  assert.equal((await withGh("gho_login", () => report(w, { issue: 3 }, { app: null }))).json.source.trusted.appFrom, "variable-gh");
  // The gh login reads it and it is not set: not set, never unreadable.
  w.appVariable = (t) => (t === "gho_login" ? null : { status: 403 });
  const unset = await withGh("gho_login", () => report(w, { issue: 3 }, { app: null }));
  assert.equal(unset.json.source.trusted.appFrom, "unset");
  assert.deepEqual(appMissing(unset.json), [["app-not-given", 3]], "#3's three comments through the App");
  // A value that is no App id is read, so not read again, and said as such.
  w.appVariable = "pendulum-app";
  const bad = await withGh("gho_login", () => report(w, { issue: 9 }, { app: null }));
  assert.equal(bad.calls.filter((c) => c.includes("/actions/variables/")).length, 1);
  assert.match(bad.json.source.missing.find((m) => m.code === "app-not-given").text, /^the repository variable PENDULUM_APP_ID is no App id \(a number\)/);
});

test("report (#564): no App id says why: a variable no token may read (403) is app-unreadable, one not set (404) is app-not-given, with or without an App comment in the period", async () => {
  const w = world();
  w.appVariable = () => ({ status: 403 });
  const forbidden = await withGh(null, () => report(w, { issue: 3 }, { app: null }));
  assert.deepEqual(forbidden.json.source.trusted, { ...who, refused: [], app: null, appFrom: "forbidden", appWhy: "forbidden" });
  assert.deepEqual(appMissing(forbidden.json), [["app-unreadable", 3]], "#3's three comments through the App, not attributed");
  assert.equal(forbidden.calls.filter((c) => c.includes("/actions/variables/")).length, 1, "no gh login: no second read");
  // #9 has no comment at all: the App id is still said to be missing, and why.
  const quiet = await withGh(null, () => report(w, { issue: 9 }, { app: null }));
  assert.deepEqual(appMissing(quiet.json), [["app-unreadable", 0]]);
  // The gh login is refused too: still unreadable.
  const both = await withGh("gho_login", () => report(w, { issue: 9 }, { app: null }));
  assert.equal(both.json.source.trusted.appFrom, "forbidden");
  assert.equal(both.calls.filter((c) => c.includes("/actions/variables/")).length, 2);
  assert.deepEqual(appMissing(both.json), [["app-unreadable", 0]]);
  // Not set: app-not-given, whose text names the line that sets it; the gh login's 404 decides it.
  w.appVariable = null;
  const unset = await withGh("gho_login", () => report(w, { issue: 9 }, { app: null }));
  assert.deepEqual([unset.json.source.trusted.appFrom, unset.json.source.trusted.appWhy], ["unset", "unset"]);
  assert.deepEqual(appMissing(unset.json), [["app-not-given", 0]]);
  assert.match(unset.json.source.missing.find((m) => m.code === "app-not-given").text, /gh variable set PENDULUM_APP_ID --repo acme\/app --body /);
  assert.equal(unset.calls.filter((c) => c.includes("/actions/variables/")).length, 2, "the 404 is read again with the gh login");
  // A rate-limited 403 to the report's token is no refusal: never app-unreadable, never read with another token.
  w.appVariable = () => SECONDARY;
  await assert.rejects(withGh("gho_login", () => report(w, { issue: 9 }, { app: null })), /secondary rate limit/);
});

test("report (#564): the gh login's read never ends the report: refused (401) or rate limited, the first read's reason stands and the local copy applies; a budget stop on it keeps both", async () => {
  const file = appIdCopy();
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ appId: APP.id })}\n`, { mode: 0o644 });
  try {
    const w = world();
    w.appVariable = (t) => (t === "gho_login" ? { status: 401, message: "Bad credentials" } : { status: 403 });
    const refused = await withGh("gho_login", () => report(w, { issue: 3 }, { app: null }));
    assert.equal(refused.code, 0);
    assert.deepEqual(refused.json.source.trusted, { ...who, refused: [], app: APP.id, appFrom: "local-copy", appWhy: "forbidden" });
    assert.match(refused.err, /the gh login's read of the repository variable PENDULUM_APP_ID failed \(HTTP 401\); the first read's answer stands/);
    assert.match(refused.err, /the App id is the local copy's, 2271 \(\S+app\.json\), unverified: the repository variable PENDULUM_APP_ID could not be read/);
    assert.ok(!refused.err.includes("gho_login"));
    w.appVariable = (t) => (t === "gho_login" ? SECONDARY : { status: 403 });
    const limited = await withGh("gho_login", () => report(w, { issue: 3 }, { app: null }));
    assert.deepEqual([limited.json.source.trusted.appFrom, limited.json.source.trusted.appWhy], ["local-copy", "forbidden"]);
    assert.match(limited.err, /failed \(HTTP 403, rate limited\)/);
    // --max-calls 2: the login and the first read; the stop on the second keeps the reason, and the copy applies.
    w.appVariable = () => ({ status: 403 });
    const stopped = await withGh("gho_login", () => report(w, { issue: 3, "max-calls": 2 }, { app: null }));
    assert.equal(stopped.code, STOPPED_EXIT);
    assert.equal(stopped.json.source.stoppedAt, "app id");
    assert.deepEqual(stopped.json.source.trusted, { ...who, refused: [], app: APP.id, appFrom: "local-copy", appWhy: "forbidden" });
    rmSync(file);
    const bare = await withGh("gho_login", () => report(w, { issue: 3, "max-calls": 2 }, { app: null }));
    assert.deepEqual([bare.json.source.trusted.appFrom, bare.json.source.trusted.appWhy], ["forbidden", "forbidden"]);
    assert.deepEqual(appMissing(bare.json), [["app-unreadable", 0]]);
  } finally {
    rmSync(join(process.env.HOME, ".config", "pendulum", "repos"), { recursive: true, force: true });
  }
});

test("report (#564): the local copy beside the local token gives the App id when the variable cannot be read or is not set; a copy others may write, or in a folder others may write, is not taken; the variable wins over a copy", async () => {
  const file = appIdCopy();
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ appId: APP.id })}\n`, { mode: 0o644 });
  try {
    const w = world();
    w.appVariable = () => ({ status: 403 });
    const r = await withGh(null, () => report(w, { issue: 3 }, { app: null }));
    assert.deepEqual(r.json.source.trusted, { ...who, refused: [], app: APP.id, appFrom: "local-copy", appWhy: "forbidden" });
    assert.equal(usd(byIssue(r.json, 3)).api, 0.519812);
    assert.deepEqual(appMissing(r.json), []);
    // Not set (404 to every token): the copy, and why it stands in.
    w.appVariable = null;
    const unset = await withGh("gho_login", () => report(w, { issue: 3 }, { app: null }));
    assert.deepEqual(unset.json.source.trusted, { ...who, refused: [], app: APP.id, appFrom: "local-copy", appWhy: "unset" });
    assert.match(unset.err, /unverified: the repository variable PENDULUM_APP_ID is not set/);
    // The variable, when it can be read, is the App id: a stale copy is not.
    w.appVariable = 17;
    assert.deepEqual((await withGh(null, () => report(w, { issue: 3 }, { app: null }))).json.source.trusted, { ...who, refused: [], app: 17, appFrom: "variable", appWhy: null });
    // A copy any user may write decides nothing: it is named on stderr and the id stays unreadable.
    chmodSync(file, 0o666);
    w.appVariable = () => ({ status: 403 });
    const loose = await withGh(null, () => report(w, { issue: 3 }, { app: null }));
    assert.equal(loose.json.source.trusted.appFrom, "forbidden");
    assert.match(loose.err, /the local copy of the App id is not taken: .*app\.json is writable by others \(mode 666\)/);
    // Nor one in a folder others may write, where it could be swapped.
    chmodSync(file, 0o644);
    chmodSync(join(file, ".."), 0o777);
    const folder = await withGh(null, () => report(w, { issue: 3 }, { app: null }));
    assert.equal(folder.json.source.trusted.appFrom, "forbidden");
    assert.match(folder.err, /repos\/acme is writable by others \(mode 777\)/);
  } finally {
    rmSync(join(process.env.HOME, ".config", "pendulum", "repos"), { recursive: true, force: true });
  }
});

test("report (S2): --self trusts an exact login only on a comment by someone who can push, and source lists the trusted logins", async () => {
  const w = world();
  const { json: r } = await report(w, { issue: 7, self: "teammate" });
  assert.equal(usd(byIssue(r, 7)).api, 1.55);
  assert.equal(usd(byIssue(r, 7)).unknown, 50, "the teammate's $50 spend line, billing not recorded");
  assert.equal(byIssue(r, 7).cost.unknownRuns, 0);
  assert.deepEqual(r.source.trusted.logins, ["kirkmarple-clockgrove", "teammate"]);
  // The stranger named: still nothing, they cannot push.
  const { json: s } = await report(world(), { issue: 3, self: "stranger" });
  assert.equal(usd(byIssue(s, 3)).api, 0.519812);
  assert.equal(s.source.read.ignoredComments, 2);
});

test("report (#607): a read-only member's forged spend comment changes no figure, on the stage path and on the card's; a writer's record still counts", async () => {
  // A member with read access alone: MEMBER by association, "read" by the permission read.
  const READER = { login: "reader-607", type: "User" };
  const forge = (w) => {
    w.permissions = { teammate: "write", [READER.login]: "read" };
    w.comments.push(
      progress(7, "work", "local-f1", { user: READER, association: "MEMBER", at: "2026-11-17T04:55:00Z", spend: { usd: 999, parts: { usdByBilling: { api: 999 }, billing: "api" } } }),
      comment(7, `<!-- pendulum:7:vendor:work:local-f2 -->\nx\n${spendMarker(99, { vendorUsd: 99 })}`, { user: READER, association: "COLLABORATOR", at: "2026-11-17T04:56:00Z" }),
      comment(5, `<!-- pendulum:5:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 9, usd: 9 })}`, { user: READER, association: "MEMBER", at: "2026-11-17T03:30:00Z" }),
    );
    return w;
  };
  const base = await report(world(), { since: "2026-11-17" });
  const forged = await report(forge(world()), { since: "2026-11-17" });
  assert.deepEqual(figures(forged.json), figures(base.json), "no figure moves");
  assert.equal(forged.json.source.read.ignoredComments, base.json.source.read.ignoredComments + 3);
  // Each author's permission read once, planned: the planned calls are the calls made.
  assert.deepEqual(forged.calls.filter((c) => c.includes("/permission")).sort(), [`GET /collaborators/${READER.login}/permission`, "GET /collaborators/teammate/permission"]);
  assert.equal(forged.json.source.calls.planned, forged.json.source.calls.made);
  // --self names neither into Pendulum's own: the reader cannot push.
  const named = await report(forge(world()), { issue: 7, self: READER.login });
  assert.equal(usd(byIssue(named.json, 7)).api, 1.55);
  assert.deepEqual([named.json.source.trusted.logins, named.json.source.trusted.refused], [["kirkmarple-clockgrove"], [{ login: READER.login, why: "cannot-push" }]], "a --self login that cannot push is not listed as trusted");
  // The writer's stage comment still counts: a run of unknown cost, and with --self its dollars.
  assert.ok(byIssue(forged.json, 7).cost.unknownWhy.includes("unattributed"));
  assert.equal(usd(byIssue((await report(forge(world()), { issue: 7, self: "teammate" })).json, 7)).unknown, 50);

  // The card's path: #3's finish card, built from comments read as the card reads them, with the reader's forged stage in
  // its run, counts nothing of it; the report reads #3 from that card and says what its stages say without the forgery.
  const carded = (extra) => {
    const w = world();
    w.permissions = { teammate: "write", [READER.login]: "read" };
    w.comments.push(...extra);
    return w;
  };
  const fake = [progress(3, "review", "local-f3", { user: READER, association: "MEMBER", at: "2026-11-17T02:26:00Z", spend: { usd: 999, parts: { usdByBilling: { api: 999 }, billing: "api" } } })];
  const plain = carded([]);
  plain.comments.push(await finishCard3(plain));
  const withForgery = carded(fake);
  const card = await finishCard3(withForgery);
  withForgery.comments.push(card);
  assert.equal(card.body, plain.comments.at(-1).body, "the card is the same as without the forgery");
  const viaCard = await report(withForgery, { issue: 3 });
  assert.equal(viaCard.json.source.read.summaries, 1, "the forged comment is none the card left out: the card is read");
  assert.deepEqual(clockless(viaCard.json), clockless((await report(carded([]), { issue: 3 })).json));
});

test("report (#607): the call budget stops during the permission reads: those authors are never trusted, their stages are runs of unknown cost, and source.missing says why", async () => {
  const w = () => {
    const x = world();
    x.comments.push(progress(7, "work", "local-g1", { user: { login: "second-607", type: "User" }, association: "COLLABORATOR", at: "2026-11-17T04:52:00Z", spend: { usd: 7, parts: { usdByBilling: { api: 7 }, billing: "api" } } }));
    x.permissions = { teammate: "write", "second-607": "write" };
    return x;
  };
  // --issue 7: the login, the issue, its comments; then the two permissions, planned at once, and the budget ends after one.
  const { code, json: r, calls } = await report(w(), { issue: 7, self: ["teammate", "second-607"], "max-calls": 4 });
  assert.equal(code, STOPPED_EXIT);
  assert.equal(calls.filter((c) => c.includes("/permission")).length, 1);
  assert.match(r.source.stoppedAt, /permissions/);
  // second-607 is read first (by login), a writer: its $7 is Pendulum's own under --self, beside #7's local stages' $0.65
  // (its Actions build's artifact is not reached); the teammate's is not read, so its stage is a run of unknown cost,
  // never its $50.
  assert.equal(usd(byIssue(r, 7)).api, 7.65);
  assert.equal(usd(byIssue(r, 7)).unknown, 0, "never the unchecked author's dollars");
  assert.ok(byIssue(r, 7).cost.unknownWhy.includes("unattributed"));
  assert.deepEqual(r.source.missing.find((m) => m.code === "author-unchecked")?.issues, [7]);
  assert.deepEqual([r.source.trusted.logins, r.source.trusted.refused], [["kirkmarple-clockgrove", "second-607"], [{ login: "teammate", why: "unchecked" }]]);
  // A stop before any permission read: every such author unchecked.
  const early = await report(w(), { issue: 7, "max-calls": 3 });
  assert.equal(early.calls.filter((c) => c.includes("/permission")).length, 0);
  assert.deepEqual(early.json.source.missing.find((m) => m.code === "author-unchecked")?.issues, [7]);
  // A token that may not read a permission (403): that author is never trusted either, and said so.
  const refused = w();
  refused.permissions.teammate = 403;
  const { code: ok, json: f } = await report(refused, { issue: 7, self: "teammate" });
  assert.equal(ok, 0);
  assert.equal(usd(byIssue(f, 7)).unknown, 0);
  assert.deepEqual(f.source.missing.find((m) => m.code === "author-unverifiable")?.issues, [7]);
  assert.equal(f.source.calls.planned, f.source.calls.made);
});

test("report (#607): perMerged reads a merged Objective from its card only when every writer's stage comment is one the card counted", async () => {
  const w = world();
  w.comments.push(await finishCard3(w));
  // A verified writer's stage comment on #3, after its card: the row reads #3's stages, and so does perMerged.
  w.comments.push(progress(3, "review", "local-late1", { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T02:40:00Z" }));
  const { json: r } = await report(w, { since: "2026-11-17" });
  assert.equal(r.source.read.summaries, 0);
  assert.ok(byIssue(r, 3).cost.unknownRuns > 0);
  assert.ok(r.totals.perMerged.leftOut.some((x) => x.issue === 3 && x.why.includes("unknown-runs")), "never known dollars for an Objective with a run of unknown cost");
});

test("report (#607): an author first met in an Objective's own thread, from before the period or merged in it, has their permission read, planned", async () => {
  const early = { login: "early-607", type: "User" };
  // #3 opened before the period with records in it: its thread from before the floor is read, and with it early-607's stage.
  const w = world();
  w.permissions = { teammate: "write", [early.login]: "write" };
  w.comments.push(progress(3, "work", "local-e1", { user: early, association: "MEMBER", at: "2026-11-17T02:25:00Z" }));
  const pre = await report(w, { since: "2026-11-17T02:26:00Z" });
  const read = (r, login) => r.calls.indexOf(`GET /collaborators/${login}/permission`);
  assert.ok(read(pre, early.login) > pre.calls.findIndex((c) => c.startsWith("GET /issues/3/comments")), "read after the thread that holds it");
  assert.equal(pre.json.source.calls.planned, pre.json.source.calls.made);
  // #7, merged in a period that holds none of its records: its thread is read for its figures, and the teammate's stage in it.
  const merged = await report(world(), { since: "2026-11-17T04:56:00Z" });
  assert.ok(read(merged, "teammate") > merged.calls.findIndex((c) => c.startsWith("GET /issues/7/comments")));
  assert.equal(merged.json.source.calls.planned, merged.json.source.calls.made);
});

test("report (#607): a period whose token may not read an author's permission (403) counts their stage as unknown cost and says so; a rate limit is no 403", async () => {
  const w = world();
  w.permissions = { teammate: 403 };
  const { code, json: r } = await report(w, { since: "2026-11-17" });
  assert.equal(code, 0);
  assert.deepEqual(r.source.missing.find((m) => m.code === "author-unverifiable")?.issues, [7]);
  assert.ok(byIssue(r, 7).cost.unknownWhy.includes("unattributed"));
  assert.equal(usd(byIssue(r, 7)).unknown, 0);
  assert.equal(r.source.calls.planned, r.source.calls.made);
  // A rate limit's 403 is GitHub's own answer that it is busy, not that the token may not read: the report fails.
  const limited = world();
  limited.rateLimitPermission = true;
  await assert.rejects(report(limited, { since: "2026-11-17" }), /rate limit|403/i);
});

test("report (#607): a set reads the permissions of its own issues' authors alone", async () => {
  const w = world();
  w.comments.push(progress(42, "work", "local-o1", { user: { login: "outside-607", type: "User" }, association: "MEMBER", at: "2026-11-17T04:00:00Z" }));
  w.permissions = { teammate: "write", "outside-607": "write" };
  const set = await report(w, { label: "pendulum:objective" });
  assert.ok(set.calls.includes("GET /collaborators/teammate/permission"));
  assert.ok(!set.calls.includes("GET /collaborators/outside-607/permission"), "#42 is in no Objective of the set");
  assert.equal(set.json.source.calls.planned, set.json.source.calls.made);
  assert.ok((await report(w, { since: "2026-11-17" })).calls.includes("GET /collaborators/outside-607/permission"), "a period covers every issue");
});

test("report (S3): only a PR from the repository itself counts, and an open issue is open whatever its PRs", () => {
  const pr = (over) => ({ number: 70, head: { ref: "pendulum/7", repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: "2026-11-17T04:20:00Z", merged_at: "2026-11-17T05:00:00Z", ...over });
  const closed = { number: 7, state: "closed", labels: [] };
  assert.equal(outcomeOf(closed, [pr()]), "merged");
  assert.equal(outcomeOf(closed, [pr({ head: { ref: "pendulum/7", repo: { id: 2 } } })]), "closed-unmerged", "a fork's PR on a branch of the same name");
  assert.equal(outcomeOf({ ...closed, state: "open" }, [pr()]), "open");
  assert.equal(outcomeOf({ ...closed, labels: [{ name: "pendulum:blocked" }] }, [pr()]), "blocked");
  assert.equal(outcomeOf(closed, [], { pullsRead: false }), null, "PRs not read: no outcome a label does not decide");
  assert.equal(outcomeOf({ ...closed, labels: [{ name: "pendulum:question" }] }, [], { pullsRead: false }), "question");
});

test("report (S4): stopped before the PRs and the artifacts: outcomes are null unless a label or an open issue decides them, and the stages not reached are `stopped`", async () => {
  // The login, the comments, the teammate's permission and the labelled issues; then the budget ends before the PRs.
  const { code, json: r } = await report(world(), { since: "2026-11-17", "max-calls": 4 });
  assert.equal(code, STOPPED_EXIT);
  assert.equal(byIssue(r, 3).outcome, null);
  assert.equal(byIssue(r, 8).outcome, null);
  assert.equal(byIssue(r, 5).outcome, "blocked");
  assert.deepEqual(byIssue(r, 3).cost.unknownWhy, ["stopped"]);
  assert.ok(!r.unknown.reasons.some((x) => x.code === "no-record"), "never `no-record` for a stage not reached");
  assert.deepEqual(r.source.missing.find((m) => m.code === "stopped-before-records").issues, [3, 7, 8]);
});

test("report (S5, S6): the plan follows each read's last page; --issue reads that issue's comments alone; the default period starts at UTC midnight; a decision day counts when its start is in the period", async () => {
  const w = world();
  for (let k = 0; k < 150; k += 1) w.comments.push(comment(100 + k, "a comment of no Objective", { user: ME, at: "2026-11-17T06:00:00Z" }));
  const { err, json: r } = await report(w, { since: "2026-11-17" });
  assert.match(err, /planned 1 call\(s\) for the other 1 page\(s\) of comments/);
  assert.equal(r.source.calls.byKind.comments, 2);
  const one = await report(world(), { issue: 3 });
  // Every call planned before it was made: the login, the App's variable is skipped (--app), the issue, its comments, its PRs, two artifact lists, two downloads of two calls.
  assert.equal(one.json.source.calls.made, one.json.source.calls.planned);
  assert.ok(one.calls.includes("GET /issues/3/comments?per_page=100&page=1"));
  assert.ok(!one.calls.some((c) => c.startsWith("GET /issues/comments")), "no repository-wide read for named issues");
  assert.ok(one.calls.some((c) => c.startsWith("GET /pulls?state=all&head=acme%3Apendulum%2F3")));
  assert.deepEqual(reportScope({ until: "2026-11-10T08:00:00Z" }, NOW), { since: "2026-10-11T00:00:00Z", until: "2026-11-10T08:00:00Z", defaultPeriod: true, issues: [], label: null, parent: null, compare: null });
  assert.equal(reportScope({}, Date.parse("2026-11-18T15:30:00Z")).since, "2026-10-19T00:00:00Z");
  // #5's decision calls are dated 2026-11-17: a period from noon that day leaves them out.
  const { json: noon } = await report(world(), { since: "2026-11-17T03:00:00Z" });
  assert.equal(usd(byIssue(noon, 5)).api, 0);
  const { json: day } = await report(world(), { since: "2026-11-17" });
  assert.equal(usd(byIssue(day, 5)).api, 0.02);
});

test("report (S7): each reason counts the stages naming it; its runs only where no stage gives it with another reason", async () => {
  const w = world();
  w.comments.push(progress(8, "work", "local-u2", { user: ME, at: "2026-11-17T05:40:00Z", spend: { usd: 0.1, parts: { usdUnknown: 2, usdUnknownWhy: ["unreported", "credits"] } } }));
  const { json: r } = await report(w, { issue: 8 });
  assert.deepEqual(r.unknown.reasons.map((x) => [x.code, x.stages, x.runs]), [["unreported", 2, null], ["credits", 1, null], ["no-record", 1, 1]]);
  assert.equal(r.unknown.runs, 4);
});

test("report (S8): a pass's relayed key spend is `api` in its ledger entry and in the pass breakdown", async () => {
  const [entry] = passLedger([{ harness: "codex", model: "gpt-6.1-sol", label: "work-1", usd: 0.5, workerKeyUsd: 0.2, tokens: { input: 1, output: 1, cached: 0 }, billing: "subscription" }], "subscription");
  assert.deepEqual([entry.usdByBilling, entry.workerKeyUsd], [{ subscription: 0.3, api: 0.2 }, 0.2]);
  const w = world();
  const rec = w.artifacts["pendulum-usage-3"][0].record;
  rec.ledger = [{ ...rec.ledger[0], billing: "subscription", usd: 0.2, usdByBilling: { subscription: 0.15, api: 0.05 }, workerKeyUsd: 0.05 }, ...rec.ledger.slice(1)];
  // The stage's own figure split the same way, so its passes fit in it.
  rec.usdByBilling = { api: 0.20637, subscription: 0.15 };
  const { json: r } = await report(w, { issue: 3 });
  assert.deepEqual(usd(r.breakdowns.pass.find((x) => x.key === "work")), { api: 0.05, subscription: 0.15, credits: 0, unknown: 0, sandbox: 0 });
  // Cost per model minute: each kind over the same priced minutes, never summed.
  assert.deepEqual(Object.keys(byIssue(r, 3).usdPerModelMinute).sort(), ["api", "subscription"]);
  assert.equal(byIssue(r, 3).usdPerModelMinute.subscription.modelMinutes, byIssue(r, 3).usdPerModelMinute.api.modelMinutes);
});

test("report (nits): a booking two records carry counts once, on the last, as the scorer counts it; an artifact with no run is unreadable; a kept decision keeps its effort", async () => {
  const w = world();
  const claim = "abcdef123456";
  w.artifacts["pendulum-usage-7"][0].record.vendor = { claim, usd: 0.1 };
  w.artifacts["pendulum-usage-7-review"] = [{ id: 702, name: "pendulum-usage-7-review", expired: false, workflow_run: { id: 52001, repository_id: 1, head_repository_id: 1 }, record: { harness: "claude", model: "m", usd: 0, runs: 0, exit: "skipped", ended: "2026-11-17T04:45:00Z", vendor: { claim, usd: 0.2 }, tokens: { input: null, output: null, cached: null, written: null } } }];
  w.artifacts["pendulum-usage-8"].push({ id: 802, name: "pendulum-usage-8", expired: false, workflow_run: { repository_id: 1, head_repository_id: 1 } });
  const { json: r } = await report(w, { since: "2026-11-17" });
  const scorer = costOf([{ ...w.artifacts["pendulum-usage-7"][0].record, artifact: "pendulum-usage-7" }, { ...w.artifacts["pendulum-usage-7-review"][0].record, artifact: "pendulum-usage-7-review" }], loadPrices());
  assert.equal(scorer.vendor.usd, 0.2);
  assert.equal(usd(byIssue(r, 7)).sandbox, 0.2);
  assert.equal(r.source.read.artifacts.unreadable, 1);
  assert.equal(r.source.read.artifacts.expired, 1);
  assert.equal(keepDecision({ harness: "claude", model: "m", usd: 0.01, tokens: { input: 1, output: 1, cached: 0 }, effort: "low" }).effort, "low");
});

// ------------------------------------------------------------------ #533: spend lines on every route

/** #3 as GitHub Actions stages write it since spend lines are on every route: each progress comment carries its spend line. */
function linedWorld() {
  const w = world();
  const lines = { "44002648279": { usd: 0.35637, parts: { usdByBilling: { api: 0.35637 }, billing: "api", route: "actions" } }, "44002920873": { usd: 0.163442, parts: { usdByBilling: { api: 0.163442 }, billing: "api", route: "actions" } } };
  w.comments = w.comments.map((c) => {
    const key = /^<!-- pendulum:3:progress:(?:work|review):(\d+) -->/.exec(c.body || "")?.[1];
    return key && lines[key] && c.user === BOT ? { ...c, body: `${c.body}\n${spendMarker(lines[key].usd, lines[key].parts)}` } : c;
  });
  return w;
}

test("report (#533): an Actions stage with a spend line gets its per-pass ledger from its usage record, its dollars counted once, from the line", async () => {
  const { json: r, calls } = await report(linedWorld(), { issue: 3 });
  const three = byIssue(r, 3);
  assert.deepEqual(usd(three), { api: 0.519812, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, "once, not twice");
  assert.deepEqual(three.passes, { total: 4, answer: 1, fix: 1 });
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api]), [["work", 1, 0.2], ["validation-fix", 1, 0.1], ["answer", 1, 0.05637], ["review", 1, 0.163442]]);
  assert.deepEqual(r.breakdowns.version.map((x) => [x.key, x.stages]), [[PENDULUM_VERSION, 2]]);
  assert.ok(!r.source.missing.some((m) => m.code === "no-ledger"));
  assert.equal(calls.filter((c) => c.startsWith("DOWNLOAD")).length, 2);
  // Every call planned before it was made, the downloads included.
  assert.equal(r.source.calls.made, r.source.calls.planned);
  // A local record in the clone that holds a stage's ledger: no artifact is read for it.
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  const w = linedWorld();
  for (const [name, a] of [["usage-work-1", w.artifacts["pendulum-usage-3"][0]], ["usage-review-1", w.artifacts["pendulum-usage-3-review"][0]]]) {
    mkdirSync(join(clone, ".pendulum", "3", name), { recursive: true });
    writeFileSync(join(clone, ".pendulum", "3", name, "result.json"), JSON.stringify(a.record));
  }
  const fake = fakeGitHub(w);
  const read = await over(fake, () => readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", appId: APP.id, checkout: clone, download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }));
  const local = buildReport(read, { now: new Date(NOW).toISOString() });
  assert.deepEqual(byIssue(local, 3).passes, { total: 4, answer: 1, fix: 1 });
  assert.ok(!fake.calls.some((c) => c.includes("/actions/artifacts")), "the local records hold every ledger: no artifact list read");
});

/** linedWorld on the Copilot harness at its default model: the harness lines name none; the usage records name it. */
function copilotLinedWorld() {
  const w = linedWorld();
  w.comments = w.comments.map((c) => (/^<!-- pendulum:3:progress:/.test(c.body || "") ? { ...c, body: c.body.replace(/^<!-- pendulum:harness \{[^\n]*\} -->$/m, harness("copilot", null)).replace("harness claude (claude-opus-5-5) attempt 1", "harness copilot attempt 1") } : c));
  // Each pass on that model too, as Copilot's records name it.
  const onSonnet = (rec) => ({ ...rec, harness: "copilot", model: "claude-sonnet-5.5", ...(Array.isArray(rec?.ledger) ? { ledger: rec.ledger.map((e) => ({ ...e, model: "claude-sonnet-5.5" })) } : {}) });
  for (const list of Object.values(w.artifacts)) for (const a of list) a.record = onSonnet(a.record);
  return w;
}

test("report (#539): a Copilot stage with a spend line is under its usage record's model; its dollars stay the line's; a Claude stage's model is its harness line's", async () => {
  const { json: r } = await report(copilotLinedWorld(), { issue: 3 });
  assert.deepEqual(r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api]), [["claude-sonnet-5-5", 2, 0.519812]]);
  assert.deepEqual(usd(byIssue(r, 3)), { api: 0.519812, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, "the spend lines' dollars, once");
  // A local stage's record in the clone names it the same way.
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  const w = copilotLinedWorld();
  for (const [name, a] of [["usage-work-1", w.artifacts["pendulum-usage-3"][0]], ["usage-review-1", w.artifacts["pendulum-usage-3-review"][0]]]) {
    mkdirSync(join(clone, ".pendulum", "3", name), { recursive: true });
    writeFileSync(join(clone, ".pendulum", "3", name, "result.json"), JSON.stringify(a.record));
  }
  const fake = fakeGitHub(w);
  const read = await over(fake, () => readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", appId: APP.id, checkout: clone, download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }));
  assert.deepEqual(buildReport(read, { now: new Date(NOW).toISOString() }).breakdowns.model.map((x) => [x.key, x.stages]), [["claude-sonnet-5-5", 2]]);
  // Claude, unchanged: each stage under its harness line's model, whatever its record names.
  const claude = linedWorld();
  for (const list of Object.values(claude.artifacts)) for (const a of list) a.record = { ...a.record, model: "claude-sonnet-5.5" };
  const { json: c } = await report(claude, { issue: 3 });
  assert.deepEqual(c.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api]).sort(), [["claude-fable-5-2", 1, 0.163442], ["claude-opus-5-5", 1, 0.35637]]);
});

test("report (#600): a Copilot stage whose usage record ran through a bring-your-own-key provider names no model, as on its cards", async () => {
  const w = copilotLinedWorld();
  const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/x";
  for (const list of Object.values(w.artifacts)) for (const a of list) a.record = { ...a.record, model: arn, byok: true };
  const { json: r } = await report(w, { issue: 3 });
  assert.deepEqual(r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api]), [[null, 2, 0.519812]]);
  assert.ok(!JSON.stringify(r).includes("123456789012"), "the provider's id is nowhere in the report");
});

test("report (#533): the call budget stopped before the usage records: the stages whose ledger is unread are named, their dollars still the spend lines'", async () => {
  // The login, the issue, its comments and its PRs; then the budget ends before the artifact lists.
  const { code, json: r } = await report(linedWorld(), { issue: 3, "max-calls": 4 });
  assert.equal(code, STOPPED_EXIT);
  assert.equal(usd(byIssue(r, 3)).api, 0.519812);
  assert.equal(byIssue(r, 3).cost.unknownRuns, 0, "a lined stage is never of unknown cost for an unread record");
  const stopped = r.source.missing.find((m) => m.code === "ledger-stopped");
  assert.deepEqual([stopped.count, stopped.issues, stopped.stages], [2, [3], [{ issue: 3, stage: "work", key: "44002648279" }, { issue: 3, stage: "review", key: "44002920873" }]]);
  assert.ok(!r.source.missing.some((m) => m.code === "no-ledger"));
});

test("report (#533): a stage with a spend line takes its tokens from its usage record; the spend line carries none, so none twice", async () => {
  const { json: r } = await report(linedWorld(), { issue: 3 });
  // The work stage's three passes and the review's one, 100k input each, as writeUsage summed them.
  const want = { input: 400_000, output: 16_000, cached: 320_000, written: 60_000 };
  assert.deepEqual(byIssue(r, 3).tokens, want);
  assert.deepEqual(r.totals.tokens, want);
  assert.deepEqual(r.breakdowns.stage.find((x) => x.key === "review").tokens, { input: 100_000, output: 4_000, cached: 80_000, written: 15_000 });
});

test("report (#533): no App id on a mixed route: the App's stages are each one stage of unknown cost, their records neither a second stage nor their dollars", async () => {
  const w = linedWorld();
  w.comments.push(progress(3, "review", "local-m1", { user: ME, at: "2026-11-17T02:40:00Z", spend: { usd: 0.1, parts: { usdByBilling: { api: 0.1 }, billing: "api" } } }));
  const fake = fakeGitHub(w);
  // Built while the token's login is known, as the command builds it: the local stage is the reader's own.
  const r = await over(fake, async () => buildReport(await readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }), { now: new Date(NOW).toISOString() }));
  assert.ok(fake.calls.some((c) => c.includes("/actions/artifacts")), "the local stage's ledger is wanted: the artifacts are read");
  const three = byIssue(r, 3);
  assert.equal(r.totals.stages, 3);
  assert.deepEqual(three.stages, { work: 1, rebase: 0, review: 2 });
  assert.deepEqual(usd(three), { api: 0.1, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, "the trusted line's dollars alone");
  assert.equal(three.cost.unknownRuns, 2);
  assert.deepEqual(three.cost.unknownWhy, ["unattributed"]);
});

test("report (#533): the budget goes to dollars before ledgers: Objectives with a stage that has no spend line are read first", async () => {
  const { calls } = await report(linedWorld(), { since: "2026-11-17" });
  const lists = calls.filter((c) => c.includes("/actions/artifacts?name=")).map((c) => new URL(`https://x${c.slice(4)}`).searchParams.get("name"));
  // #7 and #8 have a stage with no spend line (their dollars); #3 and #5 need only ledgers.
  assert.deepEqual(lists, ["pendulum-usage-7", "pendulum-usage-7-review", "pendulum-usage-8", "pendulum-usage-8-review", "pendulum-usage-3", "pendulum-usage-3-review", "pendulum-usage-5", "pendulum-usage-5-review"]);
});

// ------------------------------------------------------------------ #543: the ledger line on the progress comment

/**
 * linedWorld as its stages write it since the ledger line: beside each of #3's spend lines, the per-pass ledger line its
 * stage's end writes from its usage record (logic.mjs stageSpendLine).
 */
function ledgeredWorld() {
  const w = linedWorld();
  const recs = [w.artifacts["pendulum-usage-3"][0].record, w.artifacts["pendulum-usage-3-review"][0].record];
  w.comments = w.comments.map((c) => {
    const key = /^<!-- pendulum:3:progress:(?:work|review):(\d+) -->/.exec(c.body || "")?.[1];
    const rec = c.user === BOT ? recs.find((x) => x.progressRun === key) : null;
    return rec ? { ...c, body: `${c.body}\n${stageSpendLine(rec).ledger ?? ""}` } : c;
  });
  return w;
}

test("report (#543): the ledger lines fill the pass breakdown from the comments with no artifact read, every call planned; the figures are the usage records', the dollars the spend lines'", async () => {
  const { json: r, calls } = await report(ledgeredWorld(), { issue: 3 });
  assert.deepEqual(calls.filter((c) => c.includes("/actions/artifacts") || c.startsWith("DOWNLOAD")), [], "no artifact listed or downloaded");
  // The login, the issue, its comments and its PRs: each planned before it was made, and no more.
  assert.deepEqual([r.source.calls.planned, r.source.calls.made], [4, 4]);
  assert.equal(calls.length, r.source.calls.made);
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api]), [["work", 1, 0.2], ["validation-fix", 1, 0.1], ["answer", 1, 0.05637], ["review", 1, 0.163442]]);
  assert.deepEqual(byIssue(r, 3).passes, { total: 4, answer: 1, fix: 1 });
  assert.deepEqual(usd(byIssue(r, 3)), { api: 0.519812, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, "once, from the spend lines");
  // The same figures the usage artifacts give (#533): passes, tokens, model minutes, models, release and dollars.
  const { json: fromArtifacts } = await report(linedWorld(), { issue: 3 });
  const noBasis = (b) => ({ ...b, model: b.model.map(({ basis, ...x }) => x) });
  assert.deepEqual(noBasis(r.breakdowns), noBasis(fromArtifacts.breakdowns));
  // The ledger lines name each pass's model: the model rows are by pass. A ledger only the usage artifact holds books each
  // stage whole under its model, as the finish card's path, which reads no artifact, has to (#568).
  const bases = (x) => x.breakdowns.model.map((m) => [m.key, Object.keys(m.basis).filter((k) => m.basis[k])]);
  assert.deepEqual(bases(r), [["claude-opus-5-5", ["pass"]], ["claude-fable-5-2", ["pass"]]]);
  assert.deepEqual(bases(fromArtifacts), [["claude-opus-5-5", ["stage"]], ["claude-fable-5-2", ["stage"]]]);
  assert.deepEqual(r.objectives, fromArtifacts.objectives);
  assert.deepEqual(r.totals, fromArtifacts.totals);
  assert.deepEqual(r.hotSpots, fromArtifacts.hotSpots);
  assert.deepEqual(r.source.missing, []);
  // A ledger that did not fit its comment: the Objective's usage records are read for it, as before.
  const w = ledgeredWorld();
  w.comments = w.comments.map((c) => (c.body.startsWith("<!-- pendulum:3:progress:work:44002648279 -->") ? { ...c, body: c.body.replace(/^<!-- pendulum:ledger [^\n]*$/m, 'Per-pass ledger: 80 passes, over the 6000-character bound of its line; the stage\'s usage record holds it.\n<!-- pendulum:ledger {"cut":80} -->') } : c));
  const cut = await report(w, { issue: 3 });
  assert.equal(cut.calls.filter((c) => c.startsWith("DOWNLOAD")).length, 2);
  assert.deepEqual(cut.json.breakdowns.pass, fromArtifacts.breakdowns.pass);
});

test("report (#543): a ledger line counts only on Pendulum's own comment: a pasted one gives no stage its passes and spares no artifact read", async () => {
  // Pendulum's own ledger lines with no usage record left: the passes come from the comments alone.
  const own = ledgeredWorld();
  own.artifacts = {};
  const { json: mine } = await report(own, { issue: 3 });
  assert.deepEqual(byIssue(mine, 3).passes, { total: 4, answer: 1, fix: 1 });
  // The same lines pasted under the same stage keys by a stranger and by GitHub Actions' bot, and by a member who is not
  // Pendulum under a key of its own, beside Pendulum's own stage comments, which carry none.
  const pasted = ledgeredWorld().comments.filter((c) => c.user === BOT && /^<!-- pendulum:ledger /m.test(c.body));
  assert.equal(pasted.length, 2);
  const withPastes = () => {
    const w = linedWorld();
    w.comments.push(
      ...pasted.map((c) => comment(3, c.body, { user: { login: "stranger", type: "User" }, association: "NONE", at: c.created_at })),
      ...pasted.map((c) => comment(3, c.body, { user: { login: "github-actions[bot]", type: "Bot" }, association: "NONE", app: { id: 15368, slug: "github-actions" }, at: c.created_at })),
      comment(3, pasted[0].body.replace("<!-- pendulum:3:progress:work:44002648279 -->", "<!-- pendulum:3:progress:work:997 -->"), { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T02:30:00Z" }),
    );
    return w;
  };
  // Pendulum's own stages' passes are their usage records', each once; the pastes add none, and their records are still read.
  const { json: r, calls } = await report(withPastes(), { issue: 3 });
  const { json: fromArtifacts } = await report(linedWorld(), { issue: 3 });
  assert.equal(calls.filter((c) => c.startsWith("DOWNLOAD")).length, 2, "a pasted ledger spares no artifact read");
  const passes = (x) => x.breakdowns.pass.filter((k) => k.key !== null);
  assert.deepEqual(passes(r), passes(fromArtifacts));
  assert.deepEqual(byIssue(r, 3).passes, { total: 4, answer: 1, fix: 1 });
  assert.equal(usd(byIssue(r, 3)).api, 0.519812, "no pasted dollar");
  assert.deepEqual([byIssue(r, 3).cost.unknownRuns, byIssue(r, 3).cost.unknownWhy], [1, ["unattributed"]], "the member's stage comment is a run of unknown cost");
  // With no usage record left, the pastes give no stage its passes.
  const bare = withPastes();
  bare.artifacts = {};
  const { json: none } = await report(bare, { issue: 3 });
  assert.deepEqual(none.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api]), [[null, null, 0.519812]], "no pass: every dollar under no pass");
  assert.equal(byIssue(none, 3).passes, null);
  assert.deepEqual(none.source.missing.find((m) => m.code === "no-ledger")?.issues, [3]);
});

// ------------------------------------------------------------------ #546: review findings and their outcomes

const OUTCOMES0 = { "fixed-test": 0, "fixed-verdict": 0, answered: 0, "not-fixed": 0, "not-checkable": 0, open: 0 };
const outcomes = (o = {}) => ({ ...OUTCOMES0, ...o });
const GREPTILE = "greptile-apps[bot]";
/**
 * #11's two review stages, local and on the API: the first (claude-fable-5-2, $0.40) posted review 1101 with findings
 * 1 and 2 and answered them; the second (claude-opus-5-5, $0.30) raised none, judged them again and listed a named
 * reviewer's finding 3, which it answered.
 */
const reviewed = (extra = []) => ({
  ...world(),
  comments: [
    progress(11, "review", "local-f1", { user: ME, at: "2026-11-17T06:00:00Z", model: "claude-fable-5-2", spend: { usd: 0.4, parts: { usdByBilling: { api: 0.4 }, billing: "api" } }, findings: { pr: 110, reviews: [1101], items: [{ id: 1, outcome: "not-fixed", review: 1101 }, { id: "r1101-1", outcome: "not-checkable", review: 1101 }] } }),
    progress(11, "review", "local-f2", { user: ME, at: "2026-11-17T08:00:00Z", model: "claude-opus-5-5", spend: { usd: 0.3, parts: { usdByBilling: { api: 0.3 }, billing: "api" } }, findings: { pr: 110, reviews: [], items: [{ id: 1, outcome: "fixed-test", review: 1101 }, { id: "r1101-1", outcome: "answered", review: 1101 }, { id: 3, outcome: "open", from: GREPTILE }] } }),
    ...extra,
  ],
  issues: [{ number: 11, title: "Eleven", state: "open", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME }],
  pulls: [],
  artifacts: {},
});
const api = (n) => ({ usd: { api: n, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, unknownRuns: 0, unknownDecisionCalls: 0, unknownUnsplitRuns: 0, unknownWhy: [] });

test("report (#546): each finding counts once, at the outcome its latest record says, against the stage and reviewer model that raised it, beside the review stages' dollars", async () => {
  const { json: r } = await report(reviewed(), { issue: 11 });
  assert.deepEqual(r.findings.outcomes, ["fixed-test", "fixed-verdict", "answered", "not-fixed", "not-checkable", "open"]);
  assert.deepEqual(r.findings.totals, { findings: 3, outcomes: outcomes({ "fixed-test": 1, answered: 1, open: 1 }), reviewStages: 2, cost: api(0.7), unnamed: 0 });
  assert.deepEqual(byIssue(r, 11).findings, r.findings.totals);
  // The fable stage raised both of Pendulum's findings; the opus stage raised none but its dollars are counted.
  assert.deepEqual(r.findings.byReviewer, [
    { key: "claude-fable-5-2", outside: false, findings: 2, outcomes: outcomes({ "fixed-test": 1, answered: 1 }), reviewStages: 1, cost: api(0.4) },
    { key: "claude-opus-5-5", outside: false, findings: 0, outcomes: outcomes(), reviewStages: 1, cost: api(0.3) },
    { key: GREPTILE, outside: true, findings: 1, outcomes: outcomes({ open: 1 }), reviewStages: null, cost: null },
  ]);
  assert.deepEqual(r.findings.byStage, [
    { issue: 11, stage: "local-f1", model: "claude-fable-5-2", findings: 2, outcomes: outcomes({ "fixed-test": 1, answered: 1 }), cost: api(0.4) },
    { issue: 11, stage: "local-f2", model: "claude-opus-5-5", findings: 0, outcomes: outcomes(), cost: api(0.3) },
  ]);
  // A period that starts after the first stage: its findings are not this period's; the second stage's dollars are.
  const { json: later } = await report(reviewed(), { issue: 11, since: "2026-11-17T07:00:00Z" });
  assert.deepEqual(later.findings.totals, { findings: 1, outcomes: outcomes({ open: 1 }), reviewStages: 1, cost: api(0.3), unnamed: 0 });
  // The Markdown carries the same counts.
  const md = renderReport(r);
  assert.match(md, /^## Review findings$/m);
  assert.match(md, /^\| claude-fable-5-2 \| 2 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \| 1 \| \$0\.40 \|/m);
  assert.match(md, /^\| greptile-apps\[bot\] \(outside Pendulum\) \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 1 \| — \|/m);
});

test("report (#546): a forged findings record counts nothing: a stranger's, a member's who is not Pendulum, and one outside a review stage's progress comment", async () => {
  const forged = { pr: 110, reviews: [1101, 9999], items: [{ id: 1, outcome: "fixed-verdict", review: 1101 }, { id: 77, outcome: "fixed-test", review: 9999 }] };
  const extra = [
    // A stranger's paste of a later review stage, and a member's who is not Pendulum: neither names any finding's outcome.
    progress(11, "review", "999", { user: { login: "stranger", type: "User" }, association: "NONE", at: "2026-11-17T09:00:00Z", findings: forged }),
    progress(11, "review", "998", { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T09:10:00Z", findings: forged }),
    // Pendulum's own comment that is no review stage's progress comment.
    progress(11, "work", "local-w9", { user: ME, at: "2026-11-17T09:20:00Z", findings: forged }),
    comment(11, `<!-- pendulum:11:answer-rounds -->\n${findingsMarker(forged)}`, { user: ME, at: "2026-11-17T09:30:00Z" }),
  ];
  const { json: clean } = await report(reviewed(), { issue: 11 });
  const { json: r } = await report(reviewed(extra), { issue: 11 });
  assert.deepEqual(r.findings, clean.findings);
  assert.equal(r.findings.totals.outcomes["fixed-verdict"], 0);
  // With no record of Pendulum's at all, there are no findings and no review stages counted.
  const { json: none } = await report({ ...reviewed(extra), comments: extra }, { issue: 11 });
  assert.deepEqual(none.findings.totals, { findings: 0, outcomes: outcomes(), reviewStages: 0, cost: api(0), unnamed: 0 });
  assert.equal(byIssue(none, 11).findings, null);
});

test("report (#546): a period reads only the records written before its end; a later stage's listed open never replaces a judgement; a line over its character budget counts the rest", async () => {
  // The second stage started before 07:00 but its record was last written after it: its dollars are the period's, its
  // outcomes are not, so the period reads the first stage's whatever the day it is run.
  const late = reviewed();
  late.comments[1] = { ...late.comments[1], created_at: "2026-11-17T06:30:00Z", updated_at: "2026-11-17T07:30:00Z" };
  const { json: r } = await report(late, { issue: 11, since: "2026-11-17", until: "2026-11-17T07:00:00Z" });
  assert.deepEqual(r.findings.totals, { findings: 3, outcomes: outcomes({ "not-fixed": 1, "not-checkable": 1, open: 1 }), reviewStages: 2, cost: api(0.7), unnamed: 0 });
  // A third stage listed finding 1 open and ended before any check of its own; its check left r1101-1 open (the resolve failed).
  const third = progress(11, "review", "local-f3", { user: ME, at: "2026-11-17T09:00:00Z", model: "claude-opus-5-5", spend: { usd: 0.1, parts: { usdByBilling: { api: 0.1 }, billing: "api" } }, findings: { pr: 110, reviews: [], items: [{ id: 1, outcome: "open", review: 1101, listed: true }, { id: "r1101-1", outcome: "open", review: 1101 }] } });
  const { json: after } = await report(reviewed([third]), { issue: 11 });
  assert.deepEqual(after.findings.totals.outcomes, outcomes({ "fixed-test": 1, open: 2 }));
  // The line keeps within FINDINGS_MAX characters: the findings that fit are named, the rest counted, and the report says so.
  const many = Array.from({ length: 400 }, (_, i) => ({ id: 100_000 + i, outcome: "not-fixed", review: 1101 }));
  const line = findingsMarker({ pr: 110, reviews: [1101], items: many });
  assert.ok(line.length <= FINDINGS_MAX, `${line.length}`);
  const kept = findingsOf(line);
  assert.ok(kept.items.length > 0 && kept.items.length < 400);
  assert.equal(kept.items.length + kept.more, 400);
  const big = progress(11, "review", "local-f4", { user: ME, at: "2026-11-17T10:00:00Z", model: "claude-fable-5-2", spend: { usd: 0.2, parts: { usdByBilling: { api: 0.2 }, billing: "api" } }, findings: { pr: 110, reviews: [1101], items: many } });
  const { json: wide } = await report({ ...reviewed(), comments: [big] }, { issue: 11 });
  assert.deepEqual(wide.findings.totals, { findings: kept.items.length, outcomes: outcomes({ "not-fixed": kept.items.length }), reviewStages: 1, cost: api(0.2), unnamed: kept.more });
});

test("report (#546, #543): a review stage's progress comment carries its ledger line and its findings line, each read back", () => {
  const ledger = ledgerMarker([{ label: "review", model: "claude-fable-5-2", usd: 0.2, usdByBilling: { api: 0.2 }, billing: "api", tokens: { input: 10, output: 2, cached: 0, written: 0 }, started: "2026-11-17T06:00:00Z", ended: "2026-11-17T06:01:00Z" }], { model: "claude-fable-5-2" });
  const findings = { pr: 110, reviews: [1101], items: [{ id: 1, outcome: "fixed-test", review: 1101 }] };
  const tail = progressTail({ harness: "claude", model: "claude-fable-5-2", spend: 0.2, spendParts: { usdByBilling: { api: 0.2 }, billing: "api" }, ledger, findings });
  assert.equal(ledgerOfComment(tail).ledger.length, 1);
  assert.deepEqual(findingsOf(tail), { ...findings, more: 0 });
});

/**
 * #3's finish card as Pendulum's App posts it, built by the real card (finish-card.mjs finishData and finishCardBody)
 * from #3's own comments, read as the card reads them (github.mjs listComments, its authors' permissions verified, from
 * the fake over `w`), and the usage records the card reads (those of the stages with no spend line, or whose model only
 * the record names: unlinedStages, modellessStages) in `w`; `edit` changes its body (a forger's figures).
 */
async function finishCard3(w, { user = BOT, association, app, edit = (b) => b } = {}) {
  // Through the module's namespace, so the suite loads on a tree without the summary and these tests alone fail there.
  const card = await import("../scripts/lib/finish-card.mjs");
  const mine = card.pendulumOwn(APP.id);
  const comments = await over(fakeGitHub(w), () => listComments(REPO, 3, { token: "t" }));
  const want = new Set([...card.unlinedStages(comments, 3, mine), ...card.modellessStages(comments, 3, mine)].map((x) => x.key));
  const records = [{ ...w.recs.work, artifact: "pendulum-usage-3" }, { ...w.recs.review, artifact: "pendulum-usage-3-review" }].filter((r) => want.has(r.progressRun));
  const d = card.finishData({ repo: REPO.full, issue: real.issue, timeline: real.timeline, comments, pulls: [{ pr: real.pr, timeline: real.prTimeline, reviews: real.reviews, reviewComments: real.reviewComments }], checks: real.checks, records, mine });
  return comment(3, edit(card.finishCardBody(d)), { user, at: "2026-11-17T02:28:00Z", ...(association ? { association } : {}), ...(app !== undefined ? { app } : {}) });
}
const artifactCalls = (calls) => calls.filter((c) => c.includes("/actions/artifacts") || c.startsWith("DOWNLOAD"));
/** Everything a report says but where it read it from. */
const figures = (r) => ({ totals: r.totals, unknown: r.unknown, breakdowns: r.breakdowns, objectives: r.objectives, hotSpots: r.hotSpots, findings: r.findings, missing: r.source.missing });
/**
 * figures() less what only a finish card records (#570): an Objective's clock (the scorer's start, from its card's summary,
 * and the wall clock to its merge), for comparing a world with a card to the same world without one.
 */
const clockless = (r) => {
  const f = structuredClone(figures(r));
  for (const o of f.objectives) for (const k of ["started", "wallMinutes", "clockWhy"]) delete o[k];
  delete f.totals.perMerged.wallMinutes;
  f.totals.perMerged.leftOut = f.totals.perMerged.leftOut.map((x) => ({ ...x, why: x.why.filter((w) => w !== "no-clock") })).filter((x) => x.why.length);
  return f;
};

test("report (#547): with --rates no Objective is read from its finish card's summary, which carries no sub-agent threads or long-context share: its stages are read", async () => {
  const w = world();
  w.comments.push(await finishCard3(w));
  assert.equal((await report(w, { issue: 3 })).json.source.read.summaries, 1);
  const rated = await report(w, { issue: 3, rates: "gpt-6-luna" });
  assert.equal(rated.json.source.read.summaries, 0);
  assert.ok(artifactCalls(rated.calls).some((c) => c.startsWith("DOWNLOAD")), "its usage records are read");
  // Its figures are its stages' own, as without a card.
  const stages = await report(world(), { issue: 3, rates: "gpt-6-luna" });
  assert.deepEqual(clockless(rated.json), clockless(stages.json));
  assert.deepEqual(rated.json.rates, stages.json.rates);
});

test("report (#544): a merged Objective is read from its finish card's summary, one comment, and the report says exactly what its stages say", async () => {
  const { readSummary } = await import("../scripts/lib/finish-card.mjs");
  // #3 on Actions with no spend lines (the card read its usage records), and with spend and ledger lines (#543).
  for (const [name, make] of [["records", world], ["ledger lines", ledgeredWorld]]) {
    const w = make();
    w.comments.push(await finishCard3(w));
    const stages = await report(make(), { issue: 3 });
    const card = await report(w, { issue: 3 });
    assert.deepEqual(artifactCalls(card.calls), [], `${name}: no usage artifact listed or downloaded`);
    assert.doesNotMatch(card.err, /usage artifact/, `${name}: none planned`);
    assert.equal(card.json.source.calls.made, card.json.source.calls.planned);
    assert.equal(card.json.source.read.summaries, 1);
    // Every figure, the pass breakdown, tokens, model minutes and hot spots included, is the stages' own.
    assert.deepEqual(clockless(card.json), clockless(stages.json), name);
    assert.deepEqual(byIssue(card.json, 3).passes, { total: 4, answer: 1, fix: 1 });
    assert.deepEqual(card.json.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api]), [["work", 1, 0.2], ["validation-fix", 1, 0.1], ["answer", 1, 0.05637], ["review", 1, 0.163442]]);
  }
  // On Actions with no spend lines the card spares the artifact reads: two lists, two downloads of two calls each.
  const plain = await report(world(), { issue: 3 });
  const w = world();
  const posted = await finishCard3(w);
  w.comments.push(posted);
  const card = await report(w, { issue: 3 });
  assert.equal(artifactCalls(plain.calls).length, 4);
  assert.equal(card.json.source.calls.planned, plain.json.source.calls.planned - 6);
  // The summary carries the passes by kind and their model minutes, as its stages' ledgers give them.
  const s = readSummary(posted.body, 3);
  assert.deepEqual(s.stages.map((x) => x.passes.map((k) => [k.kind, k.passes])), [[["work", 1], ["validation-fix", 1], ["answer", 1]], [["review", 1]]]);
  assert.deepEqual(s.stages.map((x) => x.passes.reduce((t, k) => t + k.priced.minutes, 0)), [0.5 + 20 / 60 + 5 / 60, 11 / 60]);
  assert.deepEqual(s.stages.map((x) => [x.version, x.tokens.input]), [[PENDULUM_VERSION, 300_000], [PENDULUM_VERSION, 100_000]]);
  // The Objective's own measures for comparing Objectives: its passes, every harness pass's minutes, its tokens, and
  // the wall clock from its first label (the scorer's start) to the merge.
  assert.deepEqual(s.passes, byIssue(plain.json, 3).passes);
  assert.equal(s.modelMinutes, 0.5 + 20 / 60 + 5 / 60 + 11 / 60);
  assert.deepEqual(s.tokens, byIssue(plain.json, 3).tokens);
  assert.deepEqual([s.labelled, s.labelledWallMs], [real.timeline.find((e) => e.event === "labeled" && e.label.name === "pendulum:objective").created_at, Date.parse(real.pr.merged_at) - Date.parse("2026-11-17T02:23:42Z")]);

  // One comment: with every other comment of #3 gone, the card alone gives the same figures, but for what only its
  // stages' own comments say (#570): the day each started and the route each ran on, under none here.
  const alone = world();
  alone.comments = [...alone.comments.filter((c) => c.issue_url !== issueUrl(3)), posted];
  const one = await report(alone, { issue: 3 });
  assert.equal(one.json.source.read.pendulumComments, 1);
  const fromCommentsLess = (r) => {
    const f = clockless(r);
    for (const k of ["day", "route"]) f.breakdowns[k] = f.breakdowns[k].map((x) => ({ ...x, key: null }));
    for (const o of f.objectives) o.route = null;
    return f;
  };
  assert.deepEqual(fromCommentsLess(one.json), fromCommentsLess(plain.json));
  assert.deepEqual(one.json.breakdowns.route.map((x) => x.key), [null]);

  // Over a period: the same figures as with no card at all, and no artifact of #3's read.
  const period = await report(w, { since: "2026-11-17" });
  const without = await report(world(), { since: "2026-11-17" });
  assert.deepEqual(clockless(period.json), clockless(without.json));
  assert.ok(!period.calls.some((c) => c.includes("pendulum-usage-3")), "#3 is read from its card");
  assert.ok(period.calls.some((c) => c.includes("pendulum-usage-7")), "an Objective with no card is read by its stages");
  // A period that starts inside the card's run cannot use it, and --by account needs each stage's own record.
  assert.ok((await report(w, { since: "2026-11-17T02:26:00Z" })).calls.some((c) => c.includes("pendulum-usage-3")));
  assert.equal(artifactCalls((await report(w, { issue: 3, by: "account" })).calls).length, 4);

  // A stage with no ledger in the card (a spend line with no ledger line, its record unread by the card): its stages are read.
  const lined = linedWorld();
  lined.comments.push(await finishCard3(lined));
  const fallback = await report(lined, { issue: 3 });
  assert.equal(fallback.json.source.read.summaries, 0);
  assert.equal(fallback.calls.filter((c) => c.startsWith("DOWNLOAD")).length, 2);
  assert.deepEqual(clockless(fallback.json), clockless((await report(linedWorld(), { issue: 3 })).json));
  // Its clock is still its card's (#570 V6): the scorer's start, the merge and the wall clock between them.
  const three = byIssue(fallback.json, 3);
  assert.deepEqual([three.started, three.merged, three.wallMinutes, three.clockWhy], ["2026-11-17T02:23:42Z", real.pr.merged_at, Math.round(((Date.parse(real.pr.merged_at) - Date.parse("2026-11-17T02:23:42Z")) / 60_000) * 100) / 100, null]);
  assert.equal(byIssue((await report(linedWorld(), { issue: 3 })).json, 3).clockWhy, "no-card");
});

test("report (#544): a forged summary counts nothing: only Pendulum's own card is read, anyone else's leaves the stages to be read", async () => {
  const forge = (b) => b.replace(/"api":0\.35637/g, '"api":999');
  const plain = await report(world(), { issue: 3 });
  for (const who of [{ user: { login: "stranger", type: "User" }, association: "NONE", app: null }, { user: { login: "github-actions[bot]", type: "Bot" }, association: "NONE", app: { id: 15368, slug: "github-actions" } }, { user: { login: "teammate", type: "User" }, association: "MEMBER", app: null }, { user: { login: "other-app[bot]", type: "Bot" }, association: "NONE", app: { id: 999, slug: "other-app" } }]) {
    const w = world();
    const forged = await finishCard3(w, { ...who, edit: forge });
    assert.match(forged.body, /"api":999/, "the forger's figure is in it");
    w.comments.push(forged);
    const r = await report(w, { issue: 3 });
    assert.deepEqual(byIssue(r.json, 3).cost, byIssue(plain.json, 3).cost, who.user.login);
    assert.equal(artifactCalls(r.calls).length, 4, `${who.user.login}: the stages are read`);
    assert.equal(r.json.source.read.summaries, 0);
  }
  // Pendulum's own card, forged in place to a broken figure, is no summary either.
  const w = world();
  w.comments.push(await finishCard3(w, { edit: (b) => b.replace(/"usd":0\.35637/, '"usd":-1') }));
  const broken = await report(w, { issue: 3 });
  assert.equal(broken.json.source.read.summaries, 0);
  assert.deepEqual(byIssue(broken.json, 3).cost, byIssue(plain.json, 3).cost);
  // A forged card alone, on an issue with no stage of Pendulum's: no figure at all.
  const bare = world();
  const forged = await finishCard3(bare, { user: { login: "stranger", type: "User" }, association: "NONE", app: null, edit: forge });
  bare.comments = bare.comments.filter((c) => c.issue_url !== issueUrl(3)).concat(forged);
  const none = await report(bare, { since: "2026-11-17" });
  assert.ok(!none.json.objectives.some((o) => o.issue === 3 && (o.cost.usd.api > 0 || o.stages.work + o.stages.review > 0)));
});

test("report (#544): a run with a sandbox, decision lines, comments Pendulum cannot attribute and sub-second times reads the same from its card; anything written after the card sends it back to the stages", async () => {
  const { readSummary } = await import("../scripts/lib/finish-card.mjs");
  const TEAMMATE = { login: "teammate", type: "User" };
  // #3's run with: a sandbox booked on its work stage, one on its review whose usage the vendor did not report, decision
  // calls outside a stage, a teammate's stage comment and vendor comment, and passes ending on a fraction of a second.
  const rich = () => {
    const w = world();
    for (const rec of [w.recs.work, w.recs.review]) rec.ledger = rec.ledger.map((e) => ({ ...e, ended: e.ended.replace("Z", ".750Z") }));
    // Its review stage's findings record (#546): read from the review's own comment on either path.
    const review = w.comments.find((c) => c.body.startsWith("<!-- pendulum:3:progress:review:44002920873"));
    review.body = `${review.body}\n${findingsMarker({ pr: 4, reviews: [4401], items: [{ id: 1, outcome: "fixed-test", review: 4401 }, { id: 2, outcome: "answered", review: 4401 }] })}`;
    const vendor = (key, at, parts) => comment(3, `<!-- pendulum:3:vendor:${key} -->\nPendulum's sandbox cost for this stage:\nx\n${spendMarker(parts.usd, parts)}`, { at });
    w.comments.push(
      vendor("work:44002648279", "2026-11-17T02:25:56Z", { usd: 0.05, vendorUsd: 0.05 }),
      vendor("review:44002920873", "2026-11-17T02:26:56Z", { usd: 0.02, vendorUsd: 0.02, usdUnknown: 1, usdUnknownWhy: ["sandbox"] }),
      comment(3, `<!-- pendulum:3:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 2, usd: 0.01 })}`, { at: "2026-11-17T02:27:00Z" }),
      progress(3, "review", "teammate-1", { user: TEAMMATE, association: "MEMBER", at: "2026-11-17T02:26:30Z" }),
      comment(3, `<!-- pendulum:3:vendor:work:teammate-2 -->\nx\n${spendMarker(0.3, { vendorUsd: 0.3 })}`, { user: TEAMMATE, association: "MEMBER", at: "2026-11-17T02:26:31Z" }),
    );
    return w;
  };
  const stages = await report(rich(), { issue: 3 });
  const w = rich();
  const posted = await finishCard3(w);
  w.comments.push(posted);
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  assert.deepEqual(artifactCalls(card.calls), []);
  assert.deepEqual(clockless(card.json), clockless(stages.json));
  // Each is in it: the sandbox's run of unknown cost, the teammate's stage and vendor comment, the decision calls.
  const s = readSummary(posted.body, 3);
  assert.deepEqual([s.sandbox.usd, s.sandbox.unknown, s.sandbox.foreign], [0.07, 2, ["work"]]);
  assert.deepEqual(byIssue(card.json, 3).cost.unknownWhy, ["sandbox", "unattributed"]);
  assert.equal(usd(byIssue(card.json, 3)).api, Math.round((0.519812 + 0.01) * 1e6) / 1e6);
  assert.deepEqual(card.json.source.missing.find((m) => m.code === "unattributed")?.issues, [3]);
  assert.equal(s.passes, null, "a stage Pendulum cannot attribute: the Objective's passes are not known");
  assert.deepEqual([card.json.findings.totals.findings, card.json.findings.byStage.map((x) => [x.stage, x.findings, x.cost.usd.api, x.cost.usd.sandbox])], [2, [["44002920873", 2, 0.163442, 0.02]]]);

  // Written or edited after the card: a late vendor comment, a vendor comment patched, a spend line changed.
  const after = "2026-11-17T02:40:00Z";
  for (const [name, change] of [
    ["a late vendor comment", (x) => x.comments.push(comment(3, `<!-- pendulum:3:vendor:review:44002920873 -->\nx\n${spendMarker(0.4, { vendorUsd: 0.4 })}`, { at: after }))],
    ["a vendor comment patched", (x) => Object.assign(x.comments.find((c) => c.body.startsWith("<!-- pendulum:3:vendor:work:44002648279")), { updated_at: after })],
    ["a spend line changed", (x) => Object.assign(x.comments.find((c) => c.body.startsWith("<!-- pendulum:3:progress:work:44002648279")), { updated_at: after })],
  ]) {
    const late = rich();
    late.comments.push(await finishCard3(late));
    change(late);
    const r = await report(late, { issue: 3 });
    assert.equal(r.json.source.read.summaries, 0, name);
    assert.ok(artifactCalls(r.calls).length > 0, `${name}: the stages are read`);
  }
  // A card that found no stage at all is no summary to read an Objective from.
  const empty = world();
  const blank = await finishCard3({ ...empty, comments: empty.comments.filter((c) => c.issue_url !== issueUrl(3)) });
  assert.deepEqual(readSummary(blank.body, 3).stages, []);
  empty.comments.push(blank);
  assert.equal((await report(empty, { issue: 3 })).json.source.read.summaries, 0);
});

// ------------------------------------------------------------------ #559: a stage's model is its own records'

/**
 * ledgeredWorld with #3's work stage on Copilot at its default model: its harness line names none, nor does its ledger
 * line (written with no published models), so only its usage record can name it: `model` (null: none). Its review
 * stage stays on Claude, under its harness line's claude-fable-5-2.
 */
function modellessWorld(model) {
  const w = ledgeredWorld();
  const work = w.artifacts["pendulum-usage-3"][0];
  const { model: _drop, ...rest } = work.record;
  work.record = { ...rest, harness: "copilot", ...(model ? { model } : {}) };
  w.recs.work = work.record;
  w.comments = w.comments.map((c) =>
    c.body.startsWith("<!-- pendulum:3:progress:work:44002648279 -->")
      ? { ...c, body: c.body.replace(/^<!-- pendulum:harness \{[^\n]*\} -->$/m, harnessMarker("copilot", "", { worker: null, subagent: null, reviewer: "claude-fable-5-2", labels: [] })).replace("harness claude (claude-opus-5-5) attempt 1", "harness copilot attempt 1").replace(/^<!-- pendulum:ledger [^\n]*$/m, ledgerMarker(work.record.ledger, { version: PENDULUM_VERSION, published: null })) }
      : c,
  );
  return w;
}

test("report (#559): a stage whose lines name no model is under its own usage record's model on the stage path, as on its finish card, never another stage's", async () => {
  const work = modellessWorld("claude-sonnet-5.5").comments.find((c) => c.body.startsWith("<!-- pendulum:3:progress:work:"));
  assert.equal(ledgerOfComment(work.body).model, null, "its ledger line names no model");
  const stages = await report(modellessWorld("claude-sonnet-5.5"), { issue: 3 });
  assert.deepEqual(stages.json.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api]), [["claude-sonnet-5-5", 1, 0.35637], ["claude-fable-5-2", 1, 0.163442]]);
  assert.deepEqual(stages.json.source.missing, []);
  // Its finish card reads the same record for it (modellessStages): the two paths agree on every figure.
  const w = modellessWorld("claude-sonnet-5.5");
  w.comments.push(await finishCard3(w));
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  assert.deepEqual(clockless(card.json), clockless(stages.json));
});

test("report (#559): the usage record read for a stage's model is planned: the calls planned are the calls made", async () => {
  const { json: r, calls } = await report(modellessWorld("claude-sonnet-5.5"), { issue: 3 });
  // The login, the issue, its comments, its PRs, the two artifact lists and the two downloads of two calls each.
  assert.deepEqual(r.source.calls.byKind, { user: 1, issues: 1, comments: 1, pulls: 1, "artifact lists": 2, "artifact downloads": 4 });
  assert.equal(r.source.calls.planned, r.source.calls.made);
  assert.equal(calls.length, r.source.calls.made - 2, "a download is one request here and counts two calls (gh run download lists its run's artifacts)");
  // A local record in the clone that names its model: no artifact read for it.
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  const w = modellessWorld("claude-sonnet-5.5");
  mkdirSync(join(clone, ".pendulum", "3", "usage-work-1"), { recursive: true });
  writeFileSync(join(clone, ".pendulum", "3", "usage-work-1", "result.json"), JSON.stringify(w.artifacts["pendulum-usage-3"][0].record));
  const fake = fakeGitHub(w);
  const read = await over(fake, () => readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", appId: APP.id, checkout: clone, download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }));
  assert.deepEqual(artifactCalls(fake.calls), []);
  assert.deepEqual(buildReport(read, { now: new Date(NOW).toISOString() }).breakdowns.model.map((x) => x.key), ["claude-sonnet-5-5", "claude-fable-5-2"]);
});

test("report (#559): a stage no record of its own names a model for is under no model, with the reason in source.missing, on both paths", async () => {
  const stages = await report(modellessWorld(null), { issue: 3 });
  assert.deepEqual(stages.json.breakdowns.model.map((x) => [x.key, x.stages]), [[null, 1], ["claude-fable-5-2", 1]]);
  assert.deepEqual(stages.json.source.missing.map((m) => [m.code, m.issues]), [["no-model", [3]]]);
  const w = modellessWorld(null);
  w.comments.push(await finishCard3(w));
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  assert.deepEqual(clockless(card.json), clockless(stages.json));
  // The call budget stopped before the record: the reason is the stop.
  const { json: stopped } = await report(modellessWorld("claude-sonnet-5.5"), { issue: 3, "max-calls": 4 });
  assert.deepEqual(stopped.breakdowns.model.map((x) => [x.key, x.stages]), [[null, 1], ["claude-fable-5-2", 1]]);
  assert.deepEqual(stopped.source.missing.find((m) => m.code === "model-stopped")?.issues, [3]);
});

// ------------------------------------------------------------------ #566: the report validation's correctness batch

/** A repository with nothing in it, for one case at a time. */
const blank = () => ({ comments: [], issues: [], pulls: [], artifacts: {}, recs: {} });
const objectiveIssue = (number, { state = "closed", labels = [], created = "2026-11-17T01:00:00Z" } = {}) => ({ number, title: `Objective ${number}`, state, labels: ["pendulum:objective", ...labels].map((name) => ({ name })), created_at: created, user: ME });
const ownPull = (n, { number = n + 1000, created, updated = created, merged = null, ref = `pendulum/${n}` }) => ({ number, head: { ref, repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: created, updated_at: updated, merged_at: merged, state: "closed" });
/** One pass of a per-pass ledger, as a usage record holds it. */
const ledgerPass = (label, usd, started, ended, { billing = "api", tokens = { input: 1000, output: 100, cached: 0, written: 0 } } = {}) => ({ label, model: "claude-opus-5-5", effort: "medium", started, ended, usd, usdUnknown: 0, usdUnknownWhy: [], billing, usdByBilling: { [billing]: usd }, tokens });

test("report (#566 S3): a merged Objective whose PR lies past the PR list's early stop is read from its own branch's PRs, not reported closed unmerged", async () => {
  // The synthetic seed defect-pulls-early-stop: #1 merged before the period, a decision-spend line dated in it, and a full
  // first page of PRs updated since the period's start but its last one, so the list stops before #1's PR.
  const w = blank();
  w.issues.push(objectiveIssue(1, { created: "2026-09-01T00:00:00Z" }), objectiveIssue(2, { created: "2026-11-16T00:00:00Z" }));
  w.comments.push(comment(1, `<!-- pendulum:1:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 2, usd: 0.03 })}`, { user: ME, at: "2026-11-17T01:00:00Z" }));
  w.comments.push(comment(2, `<!-- pendulum:2:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 1, usd: 0.01 })}`, { user: ME, at: "2026-11-17T02:00:00Z" }));
  // Newest updated first, as GitHub answers `sort=updated&direction=desc`: #2's merged PR on the first page.
  w.pulls.push(ownPull(2, { created: "2026-11-16T05:00:00Z", merged: "2026-11-16T06:00:00Z", updated: "2026-11-17T00:00:00Z" }));
  for (let i = 0; i < 98; i += 1) w.pulls.push(ownPull(500 + i, { created: "2026-11-15T00:00:00Z", updated: `2026-11-1${i % 2 ? 6 : 5}T12:00:00Z` }));
  w.pulls.push(ownPull(700, { created: "2026-10-20T00:00:00Z", updated: "2026-10-21T00:00:00Z" }));
  w.pulls.push(ownPull(1, { created: "2026-09-02T00:00:00Z", merged: "2026-09-02T01:00:00Z" }));
  // An older closed Objective with only a stranger's paste of a marker in the period: it counts nothing, so no PR is read for it.
  w.issues.push(objectiveIssue(3, { created: "2026-09-01T00:00:00Z" }));
  w.comments.push(comment(3, `<!-- pendulum:3:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 1, usd: 9 })}`, { user: { login: "stranger", type: "User" }, association: "NONE", at: "2026-11-17T03:00:00Z" }));
  const { json: r, calls } = await report(w, { since: "2026-11-01" });
  assert.deepEqual(r.objectives.map((o) => [o.issue, o.outcome]), [[1, "merged"], [2, "merged"]]);
  assert.deepEqual(r.hotSpots.blockedOrUnmergedSpend.items, []);
  // #1 was created before the stop, so its branch's PRs are read; #2's PR was created since it and is on the list.
  const heads = calls.filter((c) => c.includes("/pulls?") && c.includes("head="));
  assert.deepEqual(heads, [`GET /pulls?state=all&head=${encodeURIComponent("acme:pendulum/1")}&per_page=100&page=1`]);
  assert.ok(!calls.some((c) => c.includes("/pulls?state=all&sort=updated") && c.includes("page=2")), "the list still stops early");
  // The call budget stopped before #1's branch was read: its end is unknown, never closed unmerged.
  const stopped = await report(w, { since: "2026-11-01", "max-calls": r.source.calls.made - 1 });
  assert.deepEqual([byIssue(stopped.json, 1).outcome, stopped.json.source.stoppedAt], [null, "pulls"]);
});

test("report (#566 R3/S8): a local stage whose ledger did not fit its comment takes its tokens from the clone's own record of it, with its passes", async () => {
  // The synthetic seed defect-local-record-tokens; real cases: assetgrove #404, raccoon-world #142 and #152.
  const w = blank();
  w.issues.push(objectiveIssue(41));
  const body = progress(41, "work", "local-c1", { user: ME, spend: { usd: 1.5, parts: { usdByBilling: { subscription: 1.5 }, billing: "subscription" } } }).body;
  w.comments.push(comment(41, `${body}\nPer-pass ledger: 5 passes, over the 6000-character bound of its line; the stage's usage record holds it.\n<!-- pendulum:ledger {"cut":5} -->`, { user: ME }));
  const tokens = { input: 17_001_148, output: 40_000, cached: 16_000_000, written: 500_000 };
  const passes = [1, 2, 3, 4, 5].map((i) => ledgerPass(`work-${i}`, 0.3, `2026-11-17T03:0${i}:00Z`, `2026-11-17T03:0${i}:30Z`, { billing: "subscription", tokens: { input: 3_400_229 + (i === 1 ? 1 : 0), output: 8000, cached: 3_200_000, written: 100_000 } }));
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(clone, ".pendulum", "41", "usage-work-1"), { recursive: true });
  writeFileSync(join(clone, ".pendulum", "41", "usage-work-1", "result.json"), JSON.stringify({ harness: "claude", model: "claude-opus-5-5", usd: 1.5, tokens, progressRun: "local-c1", ledger: passes, ran: { pendulum: PENDULUM_VERSION } }));
  const fake = fakeGitHub(w);
  // Built while the token's login is known: the local stage's comment is Pendulum's own by that login.
  const r = await over(fake, async () => buildReport(await readReport(REPO, reportScope({ issue: ["41"] }, NOW), { token: "t", appId: APP.id, checkout: clone, download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }), { now: new Date(NOW).toISOString() }));
  assert.deepEqual(artifactCalls(fake.calls), [], "no artifact read: the clone's record holds the ledger");
  assert.deepEqual(byIssue(r, 41).passes, { total: 5, answer: 0, fix: 0 });
  assert.deepEqual(byIssue(r, 41).tokens, tokens);
  assert.deepEqual(r.totals.tokens, tokens);
});

test("report (#566 S5): a usage record whose dollars the cost join withholds as unmatched puts none of its passes in the pass breakdown", async () => {
  // The synthetic seed defect-unmatched-pass-dollars: an older Actions record with no `progressRun`, of a run with no
  // comment, beside a local stage's comment with dollars of the same stage kind.
  const w = blank();
  w.issues.push(objectiveIssue(40));
  w.pulls.push(ownPull(40, { created: "2026-11-17T04:00:00Z", merged: "2026-11-17T05:00:00Z" }));
  const local = [ledgerPass("work-1", 0.5, "2026-11-17T03:00:00Z", "2026-11-17T03:10:00Z", { billing: "subscription" })];
  w.comments.push(progress(40, "work", "local-w1", { user: ME, at: "2026-11-17T03:00:00Z", spend: { usd: 0.5, parts: { usdByBilling: { subscription: 0.5 }, billing: "subscription" } } }));
  w.comments.at(-1).body += `\n${ledgerMarker(local, { model: "claude-opus-5-5", version: PENDULUM_VERSION, published: ["claude-opus-5-5"] })}`;
  // A review stage with no ledger line and no local record: the Objective's usage artifacts are read.
  w.comments.push(progress(40, "review", "local-r1", { user: ME, at: "2026-11-17T04:30:00Z", spend: { usd: 0.2, parts: { usdByBilling: { subscription: 0.2 }, billing: "subscription" } } }));
  const ghost = { harness: "claude", model: "claude-opus-5-5", usd: 0.7, runs: 1, exit: "delivered", usdByBilling: { api: 0.7 }, billing: "api", tokens: { input: 5000, output: 500, cached: 0, written: 0 }, started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:20:00Z", ledger: [ledgerPass("work-1", 0.7, "2026-11-17T02:00:00Z", "2026-11-17T02:20:00Z")] };
  w.artifacts["pendulum-usage-40"] = [{ id: 4001, name: "pendulum-usage-40", expired: false, created_at: "2026-11-17T02:21:00Z", workflow_run: { id: 81001, repository_id: 1, head_repository_id: 1 }, record: ghost }];
  const { json: r } = await report(w, { since: "2026-11-17" });
  const forty = byIssue(r, 40);
  assert.deepEqual(forty.stages, { work: 2, rebase: 0, review: 1 }, "the record still counts as a stage");
  assert.ok(forty.cost.unknownWhy.includes("unmatched"));
  assert.equal(forty.cost.usd.api, 0, "its dollars withheld");
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api, x.cost.usd.subscription]), [["work", 1, 0, 0.5], [null, null, 0, 0.2]], "the review stage with no ledger, under no pass");
  assert.equal(r.totals.passes, 1);
});

test("report (#566 S6): a vendor comment standing alone with no model dollars and no model run of unknown cost is one run of unknown cost, as on the finish card, never a known $0", async () => {
  // The synthetic seed defect-vendor-only-bare (launch.mjs bookVendor when the stage's usage record could not be read).
  const { objectiveStages, pendulumOwn } = await import("../scripts/lib/finish-card.mjs");
  const w = blank();
  w.issues.push(objectiveIssue(42, { state: "open", labels: ["pendulum:blocked"] }));
  w.comments.push(comment(42, ["<!-- pendulum:42:vendor:work:9001-abcdef012345 -->", "Pendulum's sandbox cost for this stage:", "- sandbox stopped", spendMarker(0.04, { vendorUsd: 0.04 })].join("\n")));
  const { json: r } = await report(w, { since: "2026-11-17" });
  assert.deepEqual(byIssue(r, 42).cost, { usd: { api: 0, subscription: 0, credits: 0, unknown: 0, sandbox: 0.04 }, unknownRuns: 1, unknownDecisionCalls: 0, unknownUnsplitRuns: 1, unknownWhy: ["unreported"] });
  assert.deepEqual(r.unknown.items, [{ issue: 42, stage: "work", runs: 1, decisionCalls: 0, unsplitRuns: 1, why: ["unreported"] }]);
  const card = objectiveStages({ issue: 42, comments: w.comments, mine: pendulumOwn(APP.id) });
  assert.deepEqual(card.stages.map((s) => [s.usd, s.unknown, s.why]), [[null, 1, ["unreported"]]]);
});

test("report (#566 S7): an artifact downloaded with no result.json leaves its stage of unknown cost `unreported`, not `no-record`", async () => {
  // The synthetic seed defect-noresult-reason; real case: pendulum-scratch #12.
  const w = blank();
  w.issues.push(objectiveIssue(43, { state: "open", labels: ["pendulum:blocked"] }));
  w.comments.push(progress(43, "work", "71001"));
  w.artifacts["pendulum-usage-43"] = [{ id: 4301, name: "pendulum-usage-43", expired: false, created_at: "2026-11-17T03:30:00Z", workflow_run: { id: 71001, repository_id: 1, head_repository_id: 1 } }];
  const { json: r, calls } = await report(w, { since: "2026-11-17" });
  assert.ok(calls.includes("DOWNLOAD 4301"));
  assert.deepEqual(byIssue(r, 43).cost.unknownWhy, ["unreported"]);
  assert.deepEqual(r.unknown.reasons.map((x) => [x.code, x.stages, x.runs]), [["unreported", 1, 1]]);
  assert.ok(!r.source.missing.some((m) => m.code === "no-record"), "its record was read");
  assert.equal(r.source.read.artifacts.noResult, 1);
});

test("report (#566 S9): a stage with a ledger line takes its passes from it on the stage path, as its finish card does, when another stage's usage record is read", async () => {
  // The synthetic seed defect-card-vs-stage-minutes: #3's build has no spend line (its usage record is read, by the card
  // too), and its review has a spend line and a ledger line beside a usage record, both timed to the millisecond (#569).
  const make = () => {
    const w = world();
    const review = w.artifacts["pendulum-usage-3-review"][0];
    review.record = { ...review.record, ledger: review.record.ledger.map((p) => ({ ...p, started: "2026-11-17T02:26:27.400Z", ended: "2026-11-17T02:26:38.900Z" })) };
    w.recs.review = review.record;
    const lines = stageSpendLine(review.record);
    w.comments = w.comments.map((c) => (c.user === BOT && c.body.startsWith("<!-- pendulum:3:progress:review:44002920873 -->") ? { ...c, body: `${c.body}\n${spendMarker(0.163442, { usdByBilling: { api: 0.163442 }, billing: "api" })}\n${lines.ledger}` } : c));
    return w;
  };
  const stages = await report(make(), { issue: 3 });
  assert.ok(stages.calls.includes("DOWNLOAD 302"), "the review stage's record is read, beside the build's");
  assert.equal(stages.json.breakdowns.pass.find((x) => x.key === "review").modelMinutes, 0.19, "11.5 s, from the ledger line");
  const w = make();
  w.comments.push(await finishCard3(w));
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  assert.deepEqual(clockless(card.json), clockless(stages.json));
});

test("report (#566 R8, R9): each missing entry gives its Objectives and the stages among them; the Markdown names the unrecorded Objectives and the stages of unknown cost", async () => {
  const w = world();
  // A stage that names two reasons for its one run of unknown cost: two reasons, one stage.
  w.comments = w.comments.map((c) => (c.body.startsWith("<!-- pendulum:8:progress:review:local-u1 -->") ? { ...c, body: c.body.replace(/^<!-- pendulum:spend [^\n]*$/m, spendMarker(0, { usdUnknown: 1, usdUnknownWhy: ["failed-request", "unreported"] })) } : c));
  // A vendor comment with no stage of its own, by a member who is not Pendulum: a run of unknown cost, but no stage.
  w.comments.push(comment(7, ["<!-- pendulum:7:vendor:work:777-abcdef012345 -->", "Pendulum's sandbox cost for this stage:", spendMarker(0.01, { vendorUsd: 0.01 })].join("\n"), { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T04:55:00Z" }));
  const { json: r } = await report(w, { since: "2026-11-17" });
  const entry = (code) => r.source.missing.find((m) => m.code === code);
  // #5 (two local stages), #7 (its Actions build's older record and two local stages) and #8 (its expired Actions build
  // and a local stage): no ledger.
  assert.deepEqual([entry("no-ledger").issues, entry("no-ledger").counts], [[5, 7, 8], { objectives: 3, stages: 7 }]);
  assert.deepEqual([entry("no-record").issues, entry("no-record").counts], [[8], { objectives: 1, stages: 1 }]);
  assert.deepEqual(entry("unattributed").counts, { objectives: 1, stages: 1 });
  for (const m of r.source.missing) assert.deepEqual(Object.keys(m.counts), ["objectives", "stages"], m.code);
  const md = renderReport(r);
  const runs = r.unknown.runs;
  // The vendor comment with no stage is an item but no stage.
  const stagesWithUnknown = r.unknown.items.length - 1;
  assert.equal(r.unknown.stages, stagesWithUnknown);
  assert.equal(r.unknown.reasons.reduce((t, x) => t + x.stages, 0), r.unknown.items.length + 1, "a stage with two reasons is under each");
  assert.match(md, new RegExp(`^- Runs of unknown cost: ${runs} \\(${r.unknown.unsplitRuns} not known to be passes or decision calls\\) in ${stagesWithUnknown} stage\\(s\\) and 1 record\\(s\\) outside a stage \\(decision calls, or a vendor comment with no stage\\)\\. By reason \\(a stage that names two is under each\\): `, "m"));
  assert.match(md, new RegExp(`^\\*\\*Answer and fix passes\\*\\*: [^\\n]*; not recorded \\(a stage with no per-pass ledger\\): ${r.hotSpots.answerAndFixPasses.unrecorded.map((n) => `#${n}`).join(", ")}$`, "m"));
  assert.match(md, /^- Missing: stages with no per-pass ledger[^\n]* \(3 Objective\(s\), 7 stage\(s\): #5, #7, #8\)$/m);
});

test("report (#566): one name per model: a Claude model's Copilot catalog id is its Anthropic API id by the table, and an OpenAI id is the price table's row, through its aliases and provider prefix", async () => {
  const { modelName } = await import("../scripts/lib/report.mjs");
  const prices = loadPrices();
  assert.deepEqual(
    ["claude-sonnet-5.5", "claude-sonnet-5-5", "claude-opus-5.5", "claude-2.1", "claude-3.5-sonnet-20241022", "claude-fable-5-2", "openai/gpt-6.1-sol", "gpt-6.1-sol", "gpt-5.6", "gpt-6-luna-2026-08-07", "openai/gpt-7-nova", "gpt-5-mini", "us.anthropic.claude-sonnet-5.5-v1:0", "Claude-Sonnet-5.5", "decisions", null].map((m) => modelName(m, prices)),
    ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-2.1", "claude-3.5-sonnet-20241022", "claude-fable-5-2", "gpt-6.1-sol", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-6-luna-2026-08-07", "openai/gpt-7-nova", "gpt-5-mini", "us.anthropic.claude-sonnet-5.5-v1:0", "Claude-Sonnet-5.5", "decisions", null],
  );
  // Every row of the table names an API id the report keeps as it is.
  const { CLAUDE_MODELS } = await import("../scripts/lib/report.mjs");
  for (const [from, to] of Object.entries(CLAUDE_MODELS.aliases)) assert.deepEqual([modelName(from, prices), modelName(to, prices)], [to, to], from);
  const w = blank();
  const stage = (n, h, model, usd) => {
    w.issues.push(objectiveIssue(n));
    w.comments.push(progress(n, "work", `local-${n}`, { user: ME, h, model, spend: { usd, parts: { usdByBilling: { api: usd }, billing: "api" } } }));
  };
  stage(60, "copilot", "claude-sonnet-5.5", 0.1);
  stage(61, "claude", "claude-sonnet-5-5", 0.2);
  stage(62, "codex", "openai/gpt-6.1-sol", 0.3);
  stage(63, "codex", "gpt-6.1-sol", 0.4);
  const { json: r } = await report(w, { since: "2026-11-17" });
  assert.deepEqual(r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api]), [["claude-sonnet-5-5", 2, 0.3], ["gpt-6.1-sol", 2, 0.7]]);
});

// ------------------------------------------------------------------ #568: model dollars by the model each pass ran on

/**
 * #3 with spend and ledger lines (ledgeredWorld) whose review stage, as on assetgrove #404, ran its answer and fix passes
 * on the worker's model after its review pass on the reviewer's: its usage record written by the real writer, its lines
 * by the real stage end (logic.mjs stageSpendLine).
 */
function answeredWorld() {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), "usage-review-"));
  const pass = (label, model, usd, started, ended) => ({ harness: "claude", model, label, effort: null, usd, tokens: { input: 100_000, output: 4_000, cached: 80_000, written: 15_000 }, started, ended, resumed: false, ok: true, billing: "api", basis: "harness-reported: total_cost_usd, modelUsage (sub-agents included)" });
  writeUsage(dir, {
    harness: "claude",
    model: "claude-fable-5-2",
    records: [pass("review", "claude-fable-5-2", 0.163442, "2026-11-17T02:26:27Z", "2026-11-17T02:26:38Z"), pass("answer", "claude-opus-5-5", 0.05, "2026-11-17T02:26:40Z", "2026-11-17T02:26:50Z"), pass("review-validation-fix-1", "claude-opus-5-5", 0.03, "2026-11-17T02:26:52Z", "2026-11-17T02:27:00Z")],
    passes: 1,
    exit: "delivered",
    reason: "",
    credentialBasis: "ANTHROPIC_API_KEY",
    billing: "api",
    progressRun: "44002920873",
    ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [], hosts: [], effort: "medium", reviewerEffort: null },
  });
  w.recs.review = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  w.artifacts["pendulum-usage-3-review"][0].record = w.recs.review;
  const recs = [w.recs.work, w.recs.review];
  w.comments = w.comments.map((c) => {
    const key = /^<!-- pendulum:3:progress:(?:work|review):(\d+) -->/.exec(c.body || "")?.[1];
    const rec = c.user === BOT ? recs.find((x) => x.progressRun === key) : null;
    if (!rec) return c;
    const line = stageSpendLine(rec);
    return { ...c, body: `${c.body}\n${spendMarker(line.usd, line.parts)}\n${line.ledger}` };
  });
  return w;
}
const modelRows = (r) => r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api, x.basis.pass?.cost.usd.api ?? null, x.basis.stage?.cost.usd.api ?? null]);

test("report (#568): a review stage's answer and fix passes are booked under the worker's model they ran on, its review pass under the reviewer's; the totals are unchanged", async () => {
  const { json: r, calls } = await report(answeredWorld(), { issue: 3 });
  assert.deepEqual(artifactCalls(calls), [], "from the ledger lines alone");
  // The review stage's $0.243442: $0.163442 under Fable (its review pass), $0.08 under Opus (its answer and fix passes).
  // Each stage counts once, under its own model; every dollar here is booked by pass.
  assert.deepEqual(modelRows(r), [
    ["claude-opus-5-5", 1, 0.43637, 0.43637, null],
    ["claude-fable-5-2", 1, 0.163442, 0.163442, null],
  ]);
  assert.deepEqual(usd(r.totals), { api: 0.599812, subscription: 0, credits: 0, unknown: 0, sandbox: 0 });
  assert.equal(r.breakdowns.model.reduce((t, x) => t + x.stages, 0), r.totals.stages);
  assert.deepEqual(r.breakdowns.model.map((x) => x.tokens.input), [500_000, 100_000]);
  // The review stage's own figures and its findings rows stay the stage's: one stage on Fable.
  assert.deepEqual(r.breakdowns.stage.find((x) => x.key === "review").cost.usd.api, 0.243442);
  // The Markdown says each row's basis.
  assert.match(renderReport(r), /^\| claude-fable-5-2 \| pass \| 1 \| \$0\.16 \|/m);
  assert.match(renderReport(r), /^\| claude-opus-5-5 \| pass \| 1 \| \$0\.44 \|/m);
});

test("report (#568): the finish card's path books each pass under its model from the stage's ledger line, the same figures as the stage path", async () => {
  const w = answeredWorld();
  w.comments.push(await finishCard3(w));
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  const stages = await report(w, { issue: 3, by: "account" });
  assert.equal(stages.json.source.read.summaries, 0);
  const noAccount = (f) => ({ ...f, breakdowns: { ...f.breakdowns, account: undefined } });
  assert.deepEqual(noAccount(figures(card.json)), noAccount(figures(stages.json)));
  assert.deepEqual(modelRows(card.json), [
    ["claude-opus-5-5", 1, 0.43637, 0.43637, null],
    ["claude-fable-5-2", 1, 0.163442, 0.163442, null],
  ]);
});

/**
 * A local Claude stage of Objective `n` (worker Opus, sub-agents on Sonnet) whose passes' results report Claude Code's
 * per-model usage (`modelUsage`, read by the real parser): its usage record, and its progress comment with the spend and
 * ledger lines the stage's end writes from it.
 */
function subAgentStage(n, { opusUsd = 0.5, sonnetUsd = 0.2, opusName = "claude-opus-5-5", sonnetName = "claude-sonnet-5-5" } = {}) {
  const result = (opus, sonnet) => JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s1", num_turns: 3, total_cost_usd: Math.round((opus + sonnet) * 1e6) / 1e6, modelUsage: { [opusName]: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 4000, cacheCreationInputTokens: 2000, costUSD: opus }, [sonnetName]: { inputTokens: 300, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 700, costUSD: sonnet } } });
  const pass = (label, opus, sonnet, started, ended) => ({ ...parseClaude(result(opus, sonnet), "claude-opus-5-5"), label, effort: "medium", started, ended, billing: "subscription" });
  const dir = mkdtempSync(join(tmpdir(), "usage-local-"));
  writeUsage(dir, {
    harness: "claude",
    model: "claude-opus-5-5",
    records: [pass("work-1", opusUsd, sonnetUsd, "2026-11-17T03:00:00Z", "2026-11-17T03:05:00Z"), pass("validation-fix-1", 0.1, 0, "2026-11-17T03:06:00Z", "2026-11-17T03:07:00Z")],
    passes: 1,
    exit: "delivered",
    reason: "",
    credentialBasis: "subscription",
    billing: "subscription",
    progressRun: `local-${n}`,
    ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [], hosts: [], effort: "medium", reviewerEffort: null },
  });
  const rec = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  const line = stageSpendLine(rec);
  const body = [`<!-- pendulum:${n}:progress:work:local-${n} -->`, "Pendulum work: started.", harnessMarker("claude", "claude-opus-5-5", { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [] }), spendMarker(line.usd, line.parts), line.ledger].join("\n");
  return { rec, comment: comment(n, body, { user: ME }) };
}

async function localReport(w, clone) {
  const fake = fakeGitHub(w);
  // Built while the token's login is known, as the command builds it: the local stage is the reader's own.
  const r = await over(fake, async () => buildReport(await readReport(REPO, reportScope({ since: "2026-11-17" }, NOW), { token: "t", appId: APP.id, checkout: clone, download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }), { now: new Date(NOW).toISOString() }));
  return { r, calls: fake.calls };
}

test("report (#568): Claude Code's per-model usage in local mode's own record gives the sub-agents' model its own row; with no record, the stage's passes are under the model each ran on", async () => {
  const w = blank();
  w.issues.push(objectiveIssue(40));
  const { rec, comment: c } = subAgentStage(40);
  w.comments.push(c);
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(clone, ".pendulum", "40", "usage-work-1"), { recursive: true });
  writeFileSync(join(clone, ".pendulum", "40", "usage-work-1", "result.json"), JSON.stringify(rec));
  const sub = (r) => r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.subscription, x.tokens.input, Object.keys(x.basis).filter((k) => x.basis[k])]);
  // In the clone: $0.6 under Opus and $0.2 under Sonnet, its sub-agents, as Claude Code reported them; the stage on Opus.
  const { r, calls } = await localReport(w, clone);
  assert.deepEqual(artifactCalls(calls), []);
  assert.deepEqual(sub(r), [
    ["claude-opus-5-5", 1, 0.6, 14_000, ["pass"]],
    ["claude-sonnet-5-5", 0, 0.2, 2_000, ["pass"]],
  ]);
  assert.deepEqual(usd(r.totals), { api: 0, subscription: 0.8, credits: 0, unknown: 0, sandbox: 0 });
  assert.deepEqual(r.totals.tokens, { input: 16_000, output: 1_400, cached: 8_000, written: 5_400 });
  // Elsewhere, from the comment alone: no harness report of per-model usage, so no Sonnet row; each pass under its model.
  const { r: away } = await localReport(w, mkdtempSync(join(tmpdir(), "elsewhere-")));
  assert.deepEqual(sub(away), [["claude-opus-5-5", 1, 0.8, 16_000, ["pass"]]]);
  // A record whose per-model dollars do not add up to its passes' gives no split by it: never a guess.
  const off = { ...rec, models: { ...rec.models, "claude-sonnet-5-5": { ...rec.models["claude-sonnet-5-5"], usd: 0.25 } } };
  writeFileSync(join(clone, ".pendulum", "40", "usage-work-1", "result.json"), JSON.stringify(off));
  assert.deepEqual(sub((await localReport(w, clone)).r), [["claude-opus-5-5", 1, 0.8, 16_000, ["pass"]]]);
});

test("report (#568): what no pass names stays under the stage's model by stage, and a stage whose passes do not fit inside its figures is booked whole", async () => {
  const { modelParts } = await import("../scripts/lib/report.mjs");
  const prices = loadPrices();
  const entry = (model, usd, extra = {}) => ({ label: "answer", model, started: null, ended: null, usd, usdUnknown: 0, usdUnknownWhy: [], billing: "api", usdByBilling: { api: usd }, tokens: { input: 10, output: 1, cached: null, written: null }, ...extra });
  const cost = (n, extra = {}) => ({ ...api(n), ...extra });
  const tokens = { input: 30, output: 3, cached: null, written: null };
  const parts = (ledger, c = cost(0.3), t = tokens) => modelParts({ model: "claude-fable-5-2", cost: c, tokens: t, stages: 1, ledger, prices }).map((x) => [x.key, x.basis, x.stages, x.cost.usd.api, x.cost.usd.sandbox, x.cost.unknownRuns, x.tokens.input]);
  // A pass the ledger names no model of, and the sandbox vendor's cost: under the stage's model, by stage.
  assert.deepEqual(parts([entry("claude-fable-5-2", 0.1), entry("claude-opus-5-5", 0.1), entry(null, 0.1)], { ...cost(0.3), usd: { ...cost(0.3).usd, sandbox: 0.04 } }), [
    ["claude-fable-5-2", "pass", 1, 0.1, 0, 0, 10],
    ["claude-opus-5-5", "pass", 0, 0.1, 0, 0, 10],
    ["claude-fable-5-2", "stage", 0, 0.1, 0.04, 0, 10],
  ]);
  // A pass of unknown cost is its model's run.
  assert.deepEqual(parts([entry("claude-fable-5-2", 0.3), entry("claude-opus-5-5", null, { usdUnknown: 1, usdUnknownWhy: ["unreported"] })], cost(0.3, { unknownRuns: 1, unknownWhy: ["unreported"] })), [
    ["claude-fable-5-2", "pass", 1, 0.3, 0, 0, 10],
    ["claude-opus-5-5", "pass", 0, 0, 0, 1, 10],
    ["claude-fable-5-2", "stage", 0, 0, 0, 0, 10],
  ]);
  // Passes over the stage's dollars, its runs of unknown cost or its tokens: the stage is booked whole, by stage.
  const whole = [["claude-fable-5-2", "stage", 1, 0.3, 0, 0, 30]];
  assert.deepEqual(parts([entry("claude-fable-5-2", 0.2), entry("claude-opus-5-5", 0.2)]), whole);
  assert.deepEqual(parts([entry("claude-opus-5-5", 0.3, { usdUnknown: 1 })]), whole);
  assert.deepEqual(parts([entry("claude-opus-5-5", 0.3, { tokens: { input: 31, output: 1, cached: null, written: null } })]), whole);
  // With no ledger, or one that names no model: whole.
  assert.deepEqual(parts(null), whole);
  assert.deepEqual(parts([entry(null, 0.3)]), whole);
  // Booked exactly, in millionths: a millionth the passes fall short of is left under the stage's model, by stage; one
  // they pass it by (each pass's dollars rounded on its own) comes off the own model's part; none is lost or added.
  const two = { input: 20, output: 2, cached: null, written: null };
  assert.deepEqual(parts([entry("claude-opus-5-5", 0.1), entry("claude-opus-5-5", 0.2)], cost(0.300001), two), [
    ["claude-fable-5-2", "pass", 1, 0, 0, 0, null],
    ["claude-opus-5-5", "pass", 0, 0.3, 0, 0, 20],
    ["claude-fable-5-2", "stage", 0, 0.000001, 0, 0, 0],
  ]);
  assert.deepEqual(parts([entry("claude-fable-5-2", 0.1000006), entry("claude-opus-5-5", 0.2000006)], cost(0.300001), two), [
    ["claude-fable-5-2", "pass", 1, 0.1, 0, 0, 10],
    ["claude-opus-5-5", "pass", 0, 0.200001, 0, 0, 10],
  ]);
  // An own-model part at $0 has nothing to give: the stage is booked whole.
  assert.deepEqual(parts([entry("claude-opus-5-5", 0.1000006), entry("claude-opus-5-5", 0.2000006)], cost(0.300001), two), [["claude-fable-5-2", "stage", 1, 0.300001, 0, 0, 20]]);
  // The left runs of unknown cost name the stage's reasons no pass names.
  const why = modelParts({ model: "claude-fable-5-2", cost: cost(0.3, { unknownRuns: 2, unknownWhy: ["sandbox", "unreported"] }), tokens, stages: 1, ledger: [entry("claude-fable-5-2", 0.3), entry("claude-opus-5-5", null, { usdUnknown: 1, usdUnknownWhy: ["unreported"] })], prices });
  assert.deepEqual(why.map((x) => [x.key, x.basis, x.cost.unknownRuns, x.cost.unknownWhy]), [
    ["claude-fable-5-2", "pass", 0, []],
    ["claude-opus-5-5", "pass", 1, ["unreported"]],
    ["claude-fable-5-2", "stage", 1, ["sandbox"]],
  ]);
  // A reason a named pass shares with one no part took stays on the left runs: three runs, `sandbox` and `unreported`,
  // an unreported pass on Opus, an unreported pass with no model and the sandbox's run.
  const shared = modelParts({ model: "claude-fable-5-2", cost: cost(0.3, { unknownRuns: 3, unknownWhy: ["sandbox", "unreported"] }), tokens, stages: 1, ledger: [entry("claude-fable-5-2", 0.3), entry("claude-opus-5-5", null, { usdUnknown: 1, usdUnknownWhy: ["unreported"] }), entry(null, null, { usdUnknown: 1, usdUnknownWhy: ["unreported"] })], prices });
  assert.deepEqual(shared.map((x) => [x.key, x.basis, x.cost.unknownRuns, x.cost.unknownWhy]), [
    ["claude-fable-5-2", "pass", 0, []],
    ["claude-opus-5-5", "pass", 1, ["unreported"]],
    ["claude-fable-5-2", "stage", 2, ["sandbox", "unreported"]],
  ]);
  // Claude Code's per-model usage holds the stage's harness passes alone, never its decision calls: it is checked against
  // them, and the decision record keeps its own booking (a model the ledger does not name: under the stage's, by stage).
  const OPUS = "claude-opus-5-5";
  const SONNET = "claude-sonnet-5-5";
  const t = (input, output) => ({ input, output, cached: null, written: null });
  const withDecision = modelParts({
    model: OPUS,
    recorded: OPUS,
    cost: cost(1.01),
    tokens: t(30, 3),
    stages: 1,
    ledger: [entry(OPUS, 0.7, { label: "work-1" }), entry(null, 0.01, { label: "decision", decision: true, calls: 2 }), entry(OPUS, 0.3, { label: "work-2" })],
    published: [OPUS, SONNET, "claude-fable-5-2"],
    usage: { models: { [OPUS]: { input: 15, cached: null, written: null, output: 1, usd: 0.9 }, [SONNET]: { input: 5, cached: null, written: null, output: 1, usd: 0.1 } } },
    harness: "claude",
    prices,
  });
  assert.deepEqual(withDecision.map((x) => [x.key, x.basis, x.stages, x.cost.usd.api, x.tokens.input]), [
    [OPUS, "pass", 1, 0.9, 15],
    [SONNET, "pass", 0, 0.1, 5],
    [OPUS, "stage", 0, 0.01, 10],
  ]);
  assert.equal(Math.round(withDecision.reduce((n, x) => n + x.cost.usd.api, 0) * 1e6), 1_010_000, "the stage's dollars, exactly");
  // From local mode's own record, a pass's model counts only where the stage publishes it, as its ledger line would: a
  // Bedrock inference profile ARN (it names an AWS account) is no row; its pass stays under the stage's model.
  const ARN = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
  const local = modelParts({ model: "claude-fable-5-2", recorded: "claude-fable-5-2", cost: cost(0.3), tokens, stages: 1, ledger: [entry("claude-fable-5-2", 0.1), entry("claude-opus-5-5", 0.1), entry(ARN, 0.1)], local: true, published: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"], prices });
  assert.deepEqual(local.map((x) => [x.key, x.basis, x.cost.usd.api]), [
    ["claude-fable-5-2", "pass", 0.1],
    ["claude-opus-5-5", "pass", 0.1],
    ["claude-fable-5-2", "stage", 0.1],
  ]);
});

// ------------------------------------------------------------------ #563: whole threads in a period; planned == made

/** The calls of a report that went to an issue's own comments. */
const threadCalls = (calls) => calls.filter((c) => /^GET \/issues\/\d+\/comments/.test(c));

test("report (#563 S1): a period that starts between two review rounds reads the Objective's earlier round from its thread: each finding counts once, in its own period", async () => {
  // #11's first round (06:00) was last written before 07:00, so the repository-wide read since 07:00 does not hold it.
  const issue = await report(reviewed(), { issue: 11, since: "2026-11-17T07:00:00Z" });
  const { json: later, calls } = await report(reviewed(), { since: "2026-11-17T07:00:00Z" });
  assert.deepEqual(later.findings.totals, { findings: 1, outcomes: outcomes({ open: 1 }), reviewStages: 1, cost: api(0.3), unnamed: 0 });
  assert.deepEqual(later.findings, issue.json.findings, "the period reads the same as --issue");
  // One read of #11's own thread, planned before it was made.
  assert.deepEqual(threadCalls(calls), ["GET /issues/11/comments?per_page=100&page=1"]);
  assert.equal(later.source.calls.planned, later.source.calls.made);
  // A ∪ B == A + B: the first period counts the first round's findings, the second only the one the second raised.
  const { json: whole } = await report(reviewed(), { since: "2026-11-17" });
  const { json: before } = await report(reviewed(), { since: "2026-11-17", until: "2026-11-17T07:00:00Z" });
  assert.equal(before.findings.totals.findings + later.findings.totals.findings, whole.findings.totals.findings);
  assert.equal(before.findings.totals.reviewStages + later.findings.totals.reviewStages, whole.findings.totals.reviewStages);
  // An Objective opened since the period's start has every comment in the repository-wide read: no thread is read.
  assert.deepEqual(threadCalls((await report(reviewed(), { since: "2026-11-17" })).calls), []);
});

/** #12: a local work stage at 02:00 ($0.50) whose sandbox was booked at 05:00 ($0.04). */
const booked = () => ({
  ...world(),
  comments: [
    progress(12, "work", "local-v1", { user: ME, at: "2026-11-17T02:00:00Z", spend: { usd: 0.5, parts: { usdByBilling: { api: 0.5 }, billing: "api" } } }),
    comment(12, `<!-- pendulum:12:vendor:work:local-v1 -->\nPendulum's sandbox cost for this stage:\nx\n${spendMarker(0.04, { vendorUsd: 0.04 })}`, { user: ME, at: "2026-11-17T05:00:00Z" }),
  ],
  issues: [{ number: 12, title: "Twelve", state: "open", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME }],
  pulls: [],
  artifacts: {},
});

test("report (#563 S2): a sandbox booked after the period's start for a stage before it counts with its stage, in the earlier period alone; a stop before the thread leaves it of unknown cost", async () => {
  const { json: whole } = await report(booked(), { since: "2026-11-17" });
  const { json: A } = await report(booked(), { since: "2026-11-17", until: "2026-11-17T03:00:00Z" });
  const { json: B } = await report(booked(), { since: "2026-11-17T03:00:00Z" });
  assert.deepEqual([usd(byIssue(whole, 12)).sandbox, whole.totals.stages], [0.04, 1]);
  assert.deepEqual([usd(byIssue(A, 12)).sandbox, A.totals.stages], [0.04, 1]);
  assert.equal(byIssue(B, 12), undefined, "no stage of #12 started in B: no row, no sandbox, no phantom stage");
  assert.deepEqual([B.totals.stages, B.totals.cost.usd.sandbox], [0, 0]);
  assert.equal(B.source.calls.planned, B.source.calls.made);
  // The budget stops before #12's thread (the login, the comments, the issues): its vendor comment may be of a stage
  // before the period, so it is a run of unknown cost, never a sandbox stage of its own.
  const { code, json: stopped } = await report(booked(), { since: "2026-11-17T03:00:00Z", "max-calls": 3 });
  assert.equal(code, STOPPED_EXIT);
  assert.deepEqual([usd(byIssue(stopped, 12)).sandbox, stopped.totals.stages, byIssue(stopped, 12).cost.unknownRuns, byIssue(stopped, 12).cost.unknownWhy], [0, 0, 1, ["stopped"]]);
  assert.deepEqual(stopped.source.missing.find((m) => m.code === "comments-stopped")?.issues, [12]);
});

test("report (#563 S10): a stop during the repository-wide comment read keeps the pages read; the rest of each Objective's comments is a run of unknown cost", async () => {
  const w = world();
  // #5's and #3's comments on the first page, then 100 comments of no Objective, then #7's on the next.
  const at = w.comments.findIndex((c) => c.issue_url === issueUrl(7));
  const pad = Array.from({ length: 100 }, (_, k) => comment(100 + k, "a comment of no Objective", { user: ME, at: "2026-11-17T03:30:00Z" }));
  w.comments.splice(at, 0, ...pad);
  // The login, the first page of comments; the second is past the budget.
  const { code, json: r } = await report(w, { since: "2026-11-17", "max-calls": 2 });
  assert.equal(code, STOPPED_EXIT);
  assert.equal(r.source.complete, false);
  assert.deepEqual(r.objectives.map((o) => o.issue), [3, 5]);
  assert.deepEqual(usd(byIssue(r, 5)), { api: 0.02, subscription: 1.2, credits: 0.3, unknown: 0, sandbox: 0 });
  for (const n of [3, 5]) assert.ok(byIssue(r, n).cost.unknownWhy.includes("stopped") && byIssue(r, n).cost.unknownRuns >= 1, `#${n}: the rest of its comments`);
  assert.deepEqual(r.source.missing.find((m) => m.code === "comments-stopped")?.issues, [3, 5]);
  assert.equal(r.unknown.items.filter((x) => x.stage === null).length, 2);
});

test("report (#563 S4): --issue on an issue past 100 comments plans its second page once", async () => {
  const many = world();
  for (let k = 0; k < 150; k += 1) many.comments.push(comment(3, "a comment", { user: ME }));
  const { json: r } = await report(many, { issue: 3 });
  assert.equal(r.source.calls.byKind.comments, 2);
  assert.equal(r.source.calls.planned, r.source.calls.made);
});

test("report (#563 S4): a paged read whose last page is exactly full ends there, every call planned", async () => {
  // Exactly two full pages of the repository's comments: GitHub's Link header on the second names no next page.
  const full = world();
  while (full.comments.length < 200) full.comments.push(comment(100 + full.comments.length, "a comment of no Objective", { user: ME }));
  const { json: r, calls } = await report(full, { since: "2026-11-17" });
  assert.equal(r.source.calls.byKind.comments, 2);
  assert.ok(!calls.some((c) => c.startsWith("GET /issues/comments") && c.endsWith("&page=3")));
  assert.equal(r.source.calls.planned, r.source.calls.made);
});

test("report (#563 S4): the PR list's early stop leaves no planned page unread", async () => {
  // 273 PRs, newest first: a full page updated in the period, then older ones; the list stops after the second page.
  const old = world();
  const pr = (k, at) => ({ number: 1000 + k, head: { ref: `feature/${k}` }, created_at: at, updated_at: at, merged_at: null, state: "closed" });
  for (let k = 0; k < 120; k += 1) old.pulls.push(pr(k, "2026-11-17T06:00:00Z"));
  for (let k = 120; k < 270; k += 1) old.pulls.push(pr(k, "2026-10-01T00:00:00Z"));
  const { json: r } = await report(old, { since: "2026-11-17" });
  assert.equal(r.source.calls.byKind.pulls, 2);
  assert.equal(r.source.calls.planned, r.source.calls.made);
});

test("report (#563): a full first page with no Link header ends the read, and source.missing names each such read, by its issue where it read one", async () => {
  const w = world();
  for (let k = 0; k < 150; k += 1) w.comments.push(comment(100 + k, "a comment of no Objective", { user: ME }));
  w.noLink = true;
  const { json: r } = await report(w, { since: "2026-11-17" });
  assert.equal(r.source.calls.byKind.comments, 1);
  assert.equal(r.source.calls.planned, r.source.calls.made);
  // One read, the repository's comments: no issue's thread.
  const note = r.source.missing.find((m) => m.code === "no-link");
  assert.deepEqual([note?.count, note?.issues], [1, []], JSON.stringify(r.source.missing));
  assert.match(note.text, /the repository's comments/);
  // --issue 3 with 150 comments of its own: the read of #3's thread is named, by its issue.
  const own = world();
  for (let k = 0; k < 150; k += 1) own.comments.push(comment(3, "a comment", { user: ME }));
  own.noLink = true;
  const { json: one } = await report(own, { issue: 3 });
  assert.equal(one.source.calls.byKind.comments, 1);
  const named = one.source.missing.find((m) => m.code === "no-link");
  assert.deepEqual([named?.count, named?.issues], [1, [3]]);
  assert.match(named.text, /#3's comments/);
  // With GitHub's Link headers, no note.
  const { json: linked } = await report({ ...w, noLink: false }, { since: "2026-11-17" });
  assert.ok(!linked.source.missing.some((m) => m.code === "no-link"));
});

/** Each cost kind summed over a breakdown's rows, to a millionth: what the totals must equal exactly. */
const rowSums = (rows) => Object.fromEntries(["api", "subscription", "credits", "unknown", "sandbox"].map((k) => [k, Math.round(rows.reduce((t, x) => t + x.cost.usd[k], 0) * 1e6) / 1e6]));

test("report (#568): the model rows add up to the totals exactly, by pass and by Claude Code's per-model usage, each model's dollars rounded on its own", async () => {
  // The pass path: #3's review stage split between Fable and Opus.
  const { json: passes } = await report(answeredWorld(), { issue: 3 });
  assert.deepEqual(rowSums(passes.breakdowns.model), usd(passes.totals));
  // Claude Code's per-model usage at a tenth of a millionth: Opus $0.1000006 and Sonnet $0.2000006 in a pass the harness
  // reports at $0.300001. Each model's dollars to a millionth are $0.100001 and $0.200001, a millionth over the stage's:
  // it comes off the stage's own model, and the rows add up to the stage's dollars.
  const w = blank();
  w.issues.push(objectiveIssue(41));
  const { rec, comment: c } = subAgentStage(41, { opusUsd: 0.1000006, sonnetUsd: 0.2000006 });
  w.comments.push(c);
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(clone, ".pendulum", "41", "usage-work-1"), { recursive: true });
  writeFileSync(join(clone, ".pendulum", "41", "usage-work-1", "result.json"), JSON.stringify(rec));
  const { r } = await localReport(w, clone);
  assert.deepEqual(r.breakdowns.model.map((x) => [x.key, x.cost.usd.subscription]), [["claude-opus-5-5", 0.2], ["claude-sonnet-5-5", 0.200001]]);
  assert.deepEqual(usd(r.totals), { api: 0, subscription: 0.400001, credits: 0, unknown: 0, sandbox: 0 });
  assert.deepEqual(rowSums(r.breakdowns.model), usd(r.totals));
});

test("report (#568): Claude Code's per-model usage counts only where every model is one the stage publishes: an ARN or an alias gives no row of its own", async () => {
  const ARN = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
  for (const [name, names] of [["a Bedrock inference profile ARN", { sonnetName: ARN }], ["an alias", { opusName: "opus" }]]) {
    const w = blank();
    w.issues.push(objectiveIssue(42));
    const { rec, comment: c } = subAgentStage(42, names);
    w.comments.push(c);
    const clone = mkdtempSync(join(tmpdir(), "clone-"));
    mkdirSync(join(clone, ".pendulum", "42", "usage-work-1"), { recursive: true });
    writeFileSync(join(clone, ".pendulum", "42", "usage-work-1", "result.json"), JSON.stringify(rec));
    const { r } = await localReport(w, clone);
    // By its passes instead, from its ledger line: all on Opus.
    assert.deepEqual(r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.subscription]), [["claude-opus-5-5", 1, 0.8]], name);
    assert.ok(!JSON.stringify(r).includes("arn:") && !JSON.stringify(r).includes('"opus"'), `${name}: never in the report`);
    assert.ok(!renderReport(r).includes("arn:"), name);
  }
});

test("report (#568): the finish card's path books a Claude stage by Claude Code's per-model usage in the clone, as the stage path does", async () => {
  // #3's work stage on Opus with Sonnet sub-agents, its local record in the clone: $0.30637 on Opus, $0.05 on Sonnet.
  const w = answeredWorld();
  const work = { ...w.recs.work, models: { "claude-opus-5-5": { input: 10_000, cached: 200_000, written: 40_000, output: 10_000, usd: 0.30637 }, "claude-sonnet-5-5": { input: 5_000, cached: 40_000, written: 5_000, output: 2_000, usd: 0.05 } } };
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(clone, ".pendulum", "3", "usage-work-1"), { recursive: true });
  writeFileSync(join(clone, ".pendulum", "3", "usage-work-1", "result.json"), JSON.stringify(work));
  w.comments.push(await finishCard3(w));
  // Read in the clone, as the command reads there, from the card and (`--by account`) from the stages.
  const inClone = async (by) => {
    const fake = fakeGitHub(w);
    return over(fake, async () => buildReport(await readReport(REPO, reportScope({ issue: ["3"] }, NOW), { token: "t", appId: APP.id, checkout: clone, by, download: fake.download, cacheDir: mkdtempSync(join(tmpdir(), "c-")) }), { by, now: new Date(NOW).toISOString() }));
  };
  const card = { json: await inClone([]) };
  const stages = { json: await inClone(["account"]) };
  assert.deepEqual([card.json.source.read.summaries, stages.json.source.read.summaries], [1, 0]);
  const noAccount = (f) => ({ ...f, breakdowns: { ...f.breakdowns, account: undefined } });
  assert.deepEqual(noAccount(figures(card.json)), noAccount(figures(stages.json)));
  assert.deepEqual(modelRows(card.json), [
    ["claude-opus-5-5", 1, 0.38637, 0.38637, null],
    ["claude-sonnet-5-5", 0, 0.05, 0.05, null],
    ["claude-fable-5-2", 1, 0.163442, 0.163442, null],
  ]);
  assert.deepEqual(rowSums(card.json.breakdowns.model), usd(card.json.totals));
});

/**
 * A stage's progress comment as written before the rename to Pendulum (#567): the same head with the previous name, its
 * own spend line under that name too. `head` overrides the marker line.
 */
const before = (n, stage, key, { usd = 999, head = null, ...rest } = {}) =>
  comment(n, [head ?? `<!-- ${PREVIOUS_NAME}:${n}:progress:${stage}:${key} -->`, `${stage}: started.`, `<!-- ${PREVIOUS_NAME}:spend ${JSON.stringify({ usd })} -->`].join("\n"), rest);

test("report (#567): stages recorded before the rename to Pendulum are named, never read: legacy-records lists them, the report is partial, and an Objective with both is marked", async () => {
  const { json: plain } = await report(world(), { since: "2026-11-17" });
  assert.equal(plain.source.complete, true);
  assert.ok(!plain.source.missing.some((m) => m.code === "legacy-records"));
  assert.ok(plain.objectives.every((o) => o.legacyStages === 0));
  const w = world();
  w.comments.push(
    // #7 straddles the rename: a build under the previous marker by the App, in the period, beside its Pendulum stages.
    before(7, "work", "40001", { at: "2026-11-17T03:30:00Z" }),
    // #20: only stages from before the rename, by the local login (a work and a review stage) and by a member.
    before(20, "work", "local-a1", { user: ME, at: "2026-11-17T02:00:00Z" }),
    before(20, "review", "local-a2", { user: ME, at: "2026-11-17T02:30:00Z" }),
    before(20, "work", "local-a3", { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T02:40:00Z" }),
    // #26: through another GitHub App (the stage of unknown cost a Pendulum marker there would be): counts.
    before(26, "work", "1", { user: { login: "otherapp[bot]", type: "Bot" }, association: "NONE", app: { id: 99, slug: "otherapp" }, at: "2026-11-17T02:00:00Z" }),
    // None of these: a stranger's paste, one before the period, one on another issue than its marker names, and heads
    // that are not the progress marker's exact grammar.
    before(21, "work", "1", { user: { login: "stranger", type: "User" }, association: "NONE", at: "2026-11-17T02:00:00Z" }),
    before(27, "work", "1", { user: { login: "github-actions[bot]", type: "Bot" }, association: "NONE", app: { id: 15368, slug: "github-actions" }, at: "2026-11-17T02:00:00Z" }),
    before(22, "work", "1", { at: "2026-11-16T23:00:00Z", updated: "2026-11-17T01:00:00Z" }),
    before(23, "work", "1", { head: `<!-- ${PREVIOUS_NAME}:24:progress:work:1 -->` }),
    before(25, "work", "1", { head: `<!-- ${PREVIOUS_NAME}:25:progress:build:1 -->` }),
    before(25, "work", "1", { head: `<!-- ${PREVIOUS_NAME}:25:progress:work -->` }),
    before(25, "work", "1", { head: `x <!-- ${PREVIOUS_NAME}:25:progress:work:1 -->` }),
    before(25, "work", "1", { head: `<!-- ${PREVIOUS_NAME}:25:progress:work:1 --> x` }),
  );
  const { code, json: r, err } = await report(w, { since: "2026-11-17" });
  // Not a budget stop: exit 0, but not complete.
  assert.equal(code, 0);
  assert.equal(r.source.complete, false);
  assert.equal(r.source.stoppedAt, null);
  const entry = r.source.missing.find((m) => m.code === "legacy-records");
  assert.deepEqual([entry?.issues, entry?.count, entry?.counts], [[7, 20, 26], 3, { objectives: 3, stages: 5 }], JSON.stringify(r.source.missing));
  assert.match(err, /stages recorded before the rename to Pendulum/);
  // No figure of theirs is read: every figure is the same as without them, and #20 has no row.
  // Per merged Objective (#570), #7's figures are a lower bound: left out of every measure, `legacy-records`.
  const figures = (x) => ({ totals: { ...x.totals, perMerged: undefined }, unknown: x.unknown, breakdowns: x.breakdowns, findings: x.findings, hotSpots: x.hotSpots, rows: x.objectives.map(({ legacyStages, ...o }) => o) });
  assert.deepEqual(figures(r), figures(plain));
  assert.deepEqual(r.totals.perMerged.leftOut.find((x) => x.issue === 7), { issue: 7, why: ["legacy-records"] });
  assert.deepEqual([r.totals.perMerged.n, r.totals.perMerged.reviewRounds.n, plain.totals.perMerged.reviewRounds.n], [2, 1, 2]);
  assert.equal(byIssue(r, 7).legacyStages, 1);
  assert.equal(byIssue(r, 20), undefined);
  assert.ok(r.objectives.filter((o) => o.issue !== 7).every((o) => o.legacyStages === 0));
  const md = renderReport(r);
  assert.match(md, /^\*\*Partial:\*\* stages recorded before the rename to Pendulum[^\n]* \(#7, #20, #26\)\.$/m);
  assert.match(md, /^- Partial, stages recorded before the rename to Pendulum not read: #7 \(1 stage\(s\)\)\.$/m);
  // A set reads only its own: --issue 7 names #7 alone; a period that ends before them names none.
  const { code: one, json: seven } = await report(w, { issue: 7 });
  assert.equal(one, 0);
  assert.deepEqual([seven.source.complete, seven.source.missing.find((m) => m.code === "legacy-records")?.issues, byIssue(seven, 7).legacyStages], [false, [7], 1]);
  const { json: early } = await report(w, { since: "2026-11-17", until: "2026-11-17T01:30:00Z" });
  assert.equal(early.source.complete, true);
  // A budget stop still exits STOPPED_EXIT, with both codes and both lines on stderr.
  const { code: stopped, json: cut, err: why } = await report(w, { since: "2026-11-17", "max-calls": 2 });
  assert.equal(stopped, STOPPED_EXIT);
  assert.equal(cut.source.complete, false);
  assert.deepEqual(cut.source.missing.filter((m) => ["stopped", "legacy-records"].includes(m.code)).map((m) => m.code), ["stopped", "legacy-records"]);
  assert.match(why, /^pendulum report: the reads stopped at --max-calls 2 /m);
  assert.match(why, /^pendulum report: stages recorded before the rename to Pendulum/m);
});

test("report (#568, #567): an Objective that straddles the rename books its read stages by pass model, its model rows adding up to its totals", async () => {
  const w = answeredWorld();
  w.comments.push(before(3, "work", "40002", { at: "2026-11-17T02:20:00Z" }));
  const { json: r } = await report(w, { issue: 3 });
  const { json: plain } = await report(answeredWorld(), { issue: 3 });
  assert.equal(byIssue(r, 3).legacyStages, 1);
  assert.deepEqual(r.breakdowns.model, plain.breakdowns.model, "the stage from before the rename is in no row");
  assert.deepEqual(modelRows(r), [
    ["claude-opus-5-5", 1, 0.43637, 0.43637, null],
    ["claude-fable-5-2", 1, 0.163442, 0.163442, null],
  ]);
  assert.deepEqual(rowSums(r.breakdowns.model), usd(r.totals));
  assert.deepEqual(rowSums(r.breakdowns.model), usd(byIssue(r, 3)));
});

test("report (#589): progress comments with the card over their log read as the same comments before it", async () => {
  for (const make of [world, ledgeredWorld]) {
    const w = make();
    const fresh = make();
    fresh.comments = newForms(fresh.comments);
    assert.ok(fresh.comments.some((c, i) => c.body !== w.comments[i].body), "the world has progress comments in the new form");
    const [a, b] = [await report(w), await report(fresh)];
    assert.deepEqual(b.json, a.json, make.name);
  }
});

// ------------------------------------------------------------------ #570: the owner's first questions

/**
 * ledgeredWorld with #3's spend lines as the writer makes them now: its work stage's dollars by pass kind, the fix pass it
 * ran again after a Block, and its exit (`work`: blocked, `review`: delivered, or none, a line from before the exit was
 * recorded); its review only judging answers already made.
 */
function churnedWorld({ workExit = "blocked", reviewExit = "delivered" } = {}) {
  const w = ledgeredWorld();
  const work = { usdByPass: { work: { usd: 0.2, usdByBilling: { api: 0.2 } }, fix: { usd: 0.1, usdByBilling: { api: 0.1 } }, answer: { usd: 0.05637, usdByBilling: { api: 0.05637 } } }, rerun: { afterBlock: "2026-11-17T02:20:00Z", repeated: ["fix"] } };
  const review = { usdByPass: { review: { usd: 0.163442, usdByBilling: { api: 0.163442 } } }, judgeOnly: true };
  w.comments = w.comments.map((c) => {
    if (c.user !== BOT) return c;
    const [usdOf, parts, exit] = c.body.startsWith("<!-- pendulum:3:progress:work:44002648279 -->") ? [0.35637, work, workExit] : c.body.startsWith("<!-- pendulum:3:progress:review:44002920873 -->") ? [0.163442, review, reviewExit] : [null];
    if (usdOf === null) return c;
    const line = spendMarker(usdOf, { usdByBilling: { api: usdOf }, billing: "api", ...parts, ...(exit ? { exit } : {}), route: "actions" });
    return { ...c, body: c.body.replace(/^<!-- pendulum:spend [^\n]*$/m, line) };
  });
  return w;
}

test("report (#570 V1): each Objective's asked and churn rows, and their totals, are its finish card's by the card's own rules, the same from its card and from its stages", async () => {
  const { readSummary } = await import("../scripts/lib/finish-card.mjs");
  const stages = await report(churnedWorld(), { issue: 3 });
  const w = churnedWorld();
  const posted = await finishCard3(w);
  w.comments.push(posted);
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  assert.deepEqual(clockless(card.json), clockless(stages.json));
  const api = (n) => ({ api: n, subscription: 0, credits: 0, unknown: 0, sandbox: 0 });
  // The build's work and answer passes are what the issue asked for; its fix pass run again after a Block, and the
  // review that only judged answers, are churn.
  const three = byIssue(card.json, 3);
  assert.deepEqual(three.asked, [{ what: "work", usd: api(0.2), unknownRuns: 0 }, { what: "answer", usd: api(0.05637), unknownRuns: 0 }]);
  assert.deepEqual(three.churn, [{ row: "judge", stages: 1, usd: api(0.163442), unknownRuns: 0 }, { row: "block", stages: 1, usd: api(0.1), unknownRuns: 0 }]);
  // The card's own rows, word for word.
  const s = readSummary(posted.body, 3);
  assert.deepEqual(s.asked.map((r) => [r.what, r.usd, r.unknown]), three.asked.map((r) => [r.what, r.usd.api, r.unknownRuns]));
  assert.deepEqual(s.churn.map((r) => [r.row, r.stages, r.usd, r.unknown]), three.churn.map((r) => [r.row, r.stages, r.usd.api, r.unknownRuns]));
  assert.deepEqual(card.json.totals.asked, three.asked);
  assert.deepEqual(card.json.totals.churn, three.churn);
  // Over several Objectives: a conflict rebase is churn, a sandbox its own row, and the rows add up to the stages' dollars.
  const { json: r } = await report(world(), { since: "2026-11-17" });
  const seven = byIssue(r, 7);
  assert.deepEqual(seven.churn.map((x) => [x.row, x.stages, x.usd.api]), [["rebase-conflict", 1, 0.4]]);
  for (const k of COST_KINDS) {
    const rows = r.totals.asked.concat(r.totals.churn).reduce((t, x) => t + x.usd[k], 0);
    const decisions = r.breakdowns.stage.find((x) => x.key === "decisions")?.cost.usd[k] ?? 0;
    assert.ok(Math.abs(rows + decisions - r.totals.cost.usd[k]) < 1e-9, k);
  }
});

test("report (#570 V2): a stage with no ledger puts its spend line's dollars by pass in the pass breakdown, and a row of the dollars no pass names makes it cover the totals", async () => {
  const w = churnedWorld();
  // No ledger anywhere: no ledger line, and no usage record to read one from.
  w.comments = w.comments.map((c) => ({ ...c, body: c.body.replace(/^<!-- pendulum:ledger [^\n]*$/m, "") }));
  w.artifacts = {};
  const { json: r } = await report(w, { issue: 3 });
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.spendLineStages, x.cost.usd.api]), [["work", 0, 1, 0.2], ["answer", 0, 1, 0.05637], ["fix", 0, 1, 0.1], ["review", 0, 1, 0.163442]]);
  assert.equal(r.totals.passes, 0, "no pass counted");
  // With ledgers and decision calls outside a stage, a teammate's stage and an unknown run, the rows cover the totals.
  for (const scope of [{ since: "2026-11-17" }, { issue: 3 }]) {
    const { json: all } = await report(scope.issue ? churnedWorld() : world(), scope);
    for (const view of Object.keys(all.breakdowns)) {
      for (const k of COST_KINDS) assert.ok(Math.abs(all.breakdowns[view].reduce((t, x) => t + x.cost.usd[k], 0) - all.totals.cost.usd[k]) < 1e-9, `${view} ${k}`);
      assert.equal(all.breakdowns[view].reduce((t, x) => t + x.cost.unknownRuns, 0), all.totals.cost.unknownRuns, view);
    }
  }
  const { json: period } = await report(world(), { since: "2026-11-17" });
  const rest = period.breakdowns.pass.at(-1);
  assert.deepEqual([rest.key, rest.passes], [null, null]);
  assert.ok(rest.cost.usd.api >= 0.02, "the decision calls outside a stage name no pass");
});

test("report (#570 V2): a stage whose passes name more than its own figure is booked whole under no pass, its passes still counted, the reason said; the row of no pass is never negative", async () => {
  // #3's build: its ledger line's passes cost 0.35637, its spend line says 0.3.
  const disagree = () => {
    const w = ledgeredWorld();
    w.comments = w.comments.map((c) => (c.user === BOT && c.body.startsWith("<!-- pendulum:3:progress:work:44002648279 -->") ? { ...c, body: c.body.replace(/^<!-- pendulum:spend [^\n]*$/m, spendMarker(0.3, { usdByBilling: { api: 0.3 }, billing: "api", route: "actions" })) } : c));
    return w;
  };
  const { json: r } = await report(disagree(), { issue: 3 });
  assert.deepEqual(r.breakdowns.pass.map((x) => [x.key, x.passes, x.cost.usd.api]), [["work", 1, 0], ["validation-fix", 1, 0], ["answer", 1, 0], ["review", 1, 0.163442], [null, null, 0.3]]);
  assert.deepEqual(byIssue(r, 3).passes, { total: 4, answer: 1, fix: 1 }, "its passes still counted");
  for (const x of r.breakdowns.pass) for (const k of COST_KINDS) assert.ok(x.cost.usd[k] >= 0, `${x.key} ${k}`);
  assert.equal(r.breakdowns.pass.reduce((t, x) => t + x.cost.usd.api, 0), r.totals.cost.usd.api);
  const said = r.source.missing.find((m) => m.code === "ledger-overruns");
  assert.deepEqual([said.issues, said.stages], [[3], [{ issue: 3, stage: "work", key: "44002648279" }]]);
  // The same from its finish card.
  const w = disagree();
  w.comments.push(await finishCard3(w));
  const card = await report(w, { issue: 3 });
  assert.equal(card.json.source.read.summaries, 1);
  assert.deepEqual(card.json.breakdowns.pass, r.breakdowns.pass);
  assert.deepEqual(card.json.source.missing.find((m) => m.code === "ledger-overruns"), said);
});

test("report (#570 V5, V6, V7): per merged Objective, each Objective's route, Blocked notices, clock and Running, and the dollars by UTC day", async () => {
  const { vendorBody } = await import("../scripts/lib/logic.mjs");
  // The world with each local stage's spend line recording its route, as the writer does now: its Actions stages with
  // no spend line, and #7's build, record none.
  const routed = () => {
    const w = world();
    w.comments = w.comments.map((c) => (c.user === ME && /^<!-- pendulum:\d+:progress:/.test(c.body) ? { ...c, body: c.body.replace(/^<!-- pendulum:spend \{(.*)\} -->$/m, '<!-- pendulum:spend {$1,"route":"local"} -->') } : c));
    // #5's Blocked notice, Pendulum's own; #9 Running now.
    w.comments.push(comment(5, `<!-- pendulum:5:blocked:work:local-a1 -->\nBlocked (work): x.\n<!-- pendulum:block {"cause":"pendulum"} -->`, { user: ME, at: "2026-11-17T03:30:00Z" }));
    w.issues.find((i) => i.number === 9).labels.push({ name: "pendulum:running" });
    // #7's review again the next day, on GitHub Actions, after its merge.
    w.comments.push(progress(7, "review", "52001", { at: "2026-11-18T01:00:00Z", spend: { usd: 0.05, parts: { usdByBilling: { api: 0.05 }, billing: "api", route: "actions" } } }));
    // #12: a cloud sandbox stage that left only its vendor comment, which records the route.
    w.issues.push(objectiveIssue(12, { state: "open", labels: ["pendulum:blocked"] }));
    w.comments.push(comment(12, `<!-- pendulum:12:vendor:work:9001-abcdef012345 -->\n${vendorBody({ line: "- sandbox stopped", vendorUsd: 0.04, modelUsd: 0.1, modelBilling: { usdByBilling: { api: 0.1 }, billing: "api" } })}`, { at: "2026-11-17T06:00:00Z" }));
    // #13: merged in the period; its thread, read, holds no record of Pendulum's.
    w.issues.push(objectiveIssue(13));
    w.pulls.push(ownPull(13, { created: "2026-11-17T06:00:00Z", merged: "2026-11-17T07:00:00Z" }));
    return w;
  };
  const w = routed();
  const { json: r } = await report(w, { since: "2026-11-17" });
  // The route each stage's spend line records; a stage whose line records none is under none, and said.
  assert.deepEqual([3, 5, 7, 8, 12].map((n) => byIssue(r, n).route), [null, "local", "mixed", null, "sandbox"]);
  assert.deepEqual(Object.fromEntries(r.breakdowns.route.map((x) => [x.key, x.stages])), { null: 5, local: 5, decisions: 1, actions: 1, sandbox: 1 });
  assert.deepEqual(r.source.missing.find((m) => m.code === "route-unrecorded")?.issues, [3, 7, 8]);
  assert.deepEqual([byIssue(r, 5).blockedNotices, byIssue(r, 3).blockedNotices], [1, 0]);
  assert.deepEqual([byIssue(r, 5).running, byIssue(r, 3).running], [false, false]);
  const { json: nine } = await report(w, { issue: 9 });
  assert.equal(byIssue(nine, 9).running, true);
  // No finish card: a merged Objective's start is not recorded, its merge is its PR's.
  assert.deepEqual([byIssue(r, 7).started, byIssue(r, 7).merged, byIssue(r, 7).wallMinutes, byIssue(r, 7).clockWhy], [null, "2026-11-17T05:00:00Z", null, "no-card"]);
  assert.deepEqual([byIssue(r, 5).clockWhy, byIssue(r, 8).clockWhy], ["not-merged", "not-merged"]);
  // By day: each stage on the UTC date it started, oldest first, covering the totals.
  assert.deepEqual(r.breakdowns.day.map((x) => [x.key, x.stages]), [["2026-11-17", r.totals.stages - 1], ["2026-11-18", 1]]);
  assert.equal(r.breakdowns.day[1].cost.usd.api, 0.05);
  // Per merged Objective: #3, #7 and #13, merged in the period; #7 has a teammate's stage (a run of unknown cost, and no
  // fix passes it can count), and #13 no record at all: left out, never $0.
  const p = r.totals.perMerged;
  assert.equal(p.n, 3);
  assert.deepEqual([p.usd.api.median, p.usd.api.n, p.usd.api.leftOut], [usd(byIssue(r, 3)).api, 1, 2]);
  assert.deepEqual([p.reviewRounds.n, p.reviewRounds.leftOut, p.fixPasses.n, p.fixPasses.median, p.wallMinutes.n, p.wallMinutes.leftOut], [2, 1, 1, 1, 0, 3]);
  assert.deepEqual(p.leftOut, [{ issue: 3, why: ["no-clock"] }, { issue: 7, why: ["unknown-runs", "no-passes", "no-clock"] }, { issue: 13, why: ["no-records"] }]);
  // Merged in the period, with every stage's figures: a period that starts after #7's rebase and first review counts
  // only its later review in its row, and both of its reviews per merged Objective; #3 merged before it, out.
  const { json: late } = await report(w, { since: "2026-11-17T04:45:00Z" });
  assert.equal(byIssue(late, 7).stages.review, 1);
  assert.deepEqual([late.totals.perMerged.n, late.totals.perMerged.reviewRounds.median], [2, 2]);
  // --until bounds the merge: #7, merged at 05:00, is not merged in a period that ends before it.
  const { json: early } = await report(w, { since: "2026-11-17", until: "2026-11-17T04:59:00Z" });
  assert.deepEqual(early.totals.perMerged.leftOut.map((x) => x.issue), [3]);
  // With its finish card, a merged Objective's clock is the card's: its first label to its merge.
  const carded = churnedWorld();
  carded.comments.push(await finishCard3(carded));
  // A member's decision-spend lines are decision calls of unknown cost, no stage: its fix passes stay known on both paths.
  carded.comments.push(comment(3, `<!-- pendulum:3:decisions:dispatcher -->\n${decisionSpendMarker({ date: "2026-11-17", calls: 1, usd: 0.01 })}`, { user: { login: "teammate", type: "User" }, association: "MEMBER", at: "2026-11-17T02:27:30Z" }));
  const fromCard = (await report(carded, { issue: 3 })).json;
  assert.equal(fromCard.source.read.summaries, 1);
  const fromStages = (await report(carded, { issue: 3, by: "account" })).json;
  assert.deepEqual(fromStages.totals.perMerged, fromCard.totals.perMerged);
  assert.deepEqual([fromStages.totals.perMerged.fixPasses.n, fromStages.totals.perMerged.fixPasses.median], [1, 1]);
  const three = byIssue(fromStages, 3);
  assert.deepEqual([three.started, three.merged, three.clockWhy, three.route], ["2026-11-17T02:23:42Z", real.pr.merged_at, null, "actions"]);
  assert.equal(three.wallMinutes, Math.round(((Date.parse(real.pr.merged_at) - Date.parse("2026-11-17T02:23:42Z")) / 60_000) * 100) / 100);
  // The Markdown carries the same figures.
  const md = renderReport(r);
  assert.match(md, /^## By route$/m);
  assert.match(md, /^\| 2026-11-18 \| 1 \| \$0\.05 \|/m);
  assert.match(md, /^## Per merged Objective$/m);
  assert.match(md, /^- Left out: #3 \(no-clock\); #7 \(unknown-runs, no-passes, no-clock\); #13 \(no-records\)\.$/m);
  assert.match(md, /^\| #7 \| merged \| mixed \| 0 \| — \|/m);
});

test("report (#570): the route a stage ran on is recorded in its usage record and its spend line, never inferred", async () => {
  const { spendParts, vendorBody } = await import("../scripts/lib/logic.mjs");
  const { stageRoute } = await import("../scripts/lib/backend.mjs");
  assert.deepEqual([stageRoute({ GITHUB_ACTIONS: "true" }), stageRoute({ GITHUB_ACTIONS: "true", PENDULUM_STAGE_SANDBOX: "1" }), stageRoute({ PENDULUM_LOCAL: "1" }), stageRoute({})], ["actions", "sandbox", "local", null]);
  // Local mode's backend wins over the variables of a runner or a sandbox beside it.
  assert.equal(stageRoute({ PENDULUM_LOCAL: "1", GITHUB_ACTIONS: "true", PENDULUM_STAGE_SANDBOX: "1" }), "local");
  for (const [route, env] of [["local", { PENDULUM_LOCAL: "1" }], ["actions", { GITHUB_ACTIONS: "true" }], ["sandbox", { GITHUB_ACTIONS: "true", PENDULUM_STAGE_SANDBOX: "1" }], [undefined, {}]]) {
    const dir = mkdtempSync(join(tmpdir(), "usage-route-"));
    writeUsage(dir, { harness: "claude", model: "claude-opus-5-5", records: [], passes: 0, exit: "delivered", reason: "", credentialBasis: "test", env });
    const stored = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    assert.equal(stored.route, route, `result.json records ${route}`);
    assert.equal(stageSpendLine(stored).parts.route, route, `its spend line records ${route}`);
  }
  const line = stageSpendLine({ usd: 0.1, route: "local" });
  assert.equal(spendParts(spendMarker(line.usd, line.parts)).route, "local");
  assert.ok(!Object.hasOwn(stageSpendLine({ usd: 0.1, route: "the moon" }).parts, "route"));
  assert.equal(spendParts(vendorBody({ line: "x", vendorUsd: 0.01 })).route, "sandbox");
  // Who posted a stage's comment names no route: the App's comment with no route on its line is under none.
  const { json: r } = await report(world(), { issue: 3 });
  assert.deepEqual([byIssue(r, 3).route, r.breakdowns.route.map((x) => x.key)], [null, [null]]);
});

test("report (#570 V8): the stages whose spend line records they ended Blocked, with their cost; a stage whose records do not say is named", async () => {
  const blocked = await report(churnedWorld(), { issue: 3 });
  assert.deepEqual(blocked.json.hotSpots.blockedStages, { rankBy: "stages", items: [{ issue: 3, stages: 1, keys: [{ stage: "work", key: "44002648279" }], cost: { usd: { api: 0.35637, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, unknownRuns: 0, unknownDecisionCalls: 0, unknownUnsplitRuns: 0, unknownWhy: [] } }], unrecorded: [] });
  // The same from its finish card.
  const w = churnedWorld();
  w.comments.push(await finishCard3(w));
  assert.deepEqual((await report(w, { issue: 3 })).json.hotSpots.blockedStages, blocked.json.hotSpots.blockedStages);
  // A spend line from before the exit was recorded: not known, and said.
  const { json: older } = await report(churnedWorld({ workExit: null, reviewExit: null }), { issue: 3 });
  assert.deepEqual([older.hotSpots.blockedStages.items, older.hotSpots.blockedStages.unrecorded], [[], [3]]);
  // The writer: the stage's exit code goes on its spend line, and is read back; anything else is not.
  const line = stageSpendLine({ usd: 0.1, exit: "blocked" });
  assert.equal(line.parts.exit, "blocked");
  const { spendParts } = await import("../scripts/lib/logic.mjs");
  assert.equal(spendParts(spendMarker(line.usd, line.parts)).exit, "blocked");
  assert.ok(!Object.hasOwn(spendParts(spendMarker(0.1, { exit: "Blocked: the tests failed" })), "exit"));
  assert.ok(!Object.hasOwn(stageSpendLine({ usd: 0.1 }).parts, "exit"));
});

test("report (#570 V5): an Objective merged in the period counts with every stage's figures, its thread read for them, never as $0", async () => {
  // The probe: #20, labelled exp, its work ($5) and review ($1) on Nov 11, merged on Nov 17; nothing of it since then.
  const w = blank();
  w.issues.push({ ...objectiveIssue(20, { created: "2026-11-10T00:00:00Z", labels: ["exp"] }), updated_at: "2026-11-17T03:00:00Z" });
  w.pulls.push(ownPull(20, { created: "2026-11-11T05:00:00Z", updated: "2026-11-17T03:00:00Z", merged: "2026-11-17T03:00:00Z" }));
  w.comments.push(
    progress(20, "work", "local-p1", { user: ME, at: "2026-11-11T01:00:00Z", spend: { usd: 5, parts: { usdByBilling: { api: 5 }, billing: "api", route: "local" } } }),
    progress(20, "review", "local-p2", { user: ME, at: "2026-11-11T02:00:00Z", spend: { usd: 1, parts: { usdByBilling: { api: 1 }, billing: "api", route: "local" } } }),
  );
  const { json: r, calls } = await report(w, { label: "exp", since: "2026-11-17" });
  assert.ok(calls.some((c) => c.startsWith("GET /issues/20/comments")), "its thread is read");
  assert.equal(r.source.calls.planned, r.source.calls.made, "and planned");
  assert.deepEqual(byIssue(r, 20).cost.usd.api, 0, "its row: no stage in the period");
  const p = r.totals.perMerged;
  assert.deepEqual([p.n, p.usd.api.median, p.usd.api.n, p.reviewRounds.median, p.leftOut], [1, 6, 1, 1, [{ issue: 20, why: ["no-passes", "no-clock"] }]]);
  // The call budget stopped before its thread: left out, never $0.
  const { json: stopped } = await report(w, { label: "exp", since: "2026-11-17", "max-calls": r.source.calls.made - 1 });
  assert.deepEqual([stopped.totals.perMerged.n, stopped.totals.perMerged.usd.api.n, stopped.totals.perMerged.leftOut], [1, 0, [{ issue: 20, why: ["comments-stopped"] }]]);

  // A merged Objective whose only comment of Pendulum's is its plan (its work stage died before its progress comment
  // landed): no record of cost, so left out, never $0; beside a $5 one, the median is that one's.
  const plan = blank();
  plan.issues.push(objectiveIssue(21, { labels: ["exp"] }), objectiveIssue(22, { labels: ["exp"] }));
  plan.pulls.push(ownPull(21, { created: "2026-11-17T04:00:00Z", merged: "2026-11-17T05:00:00Z" }), ownPull(22, { created: "2026-11-17T04:00:00Z", merged: "2026-11-17T05:00:00Z" }));
  plan.comments.push(comment(21, "<!-- pendulum:21:plan -->\nThe plan.", { user: ME, at: "2026-11-17T02:00:00Z" }), progress(22, "work", "local-q1", { user: ME, at: "2026-11-17T02:00:00Z", spend: { usd: 5, parts: { usdByBilling: { api: 5 }, billing: "api", route: "local" } } }));
  const { json: one } = await report(plan, { issue: 21 });
  assert.deepEqual([one.totals.perMerged.n, one.totals.perMerged.usd.api.n, one.totals.perMerged.reviewRounds.n, one.totals.perMerged.leftOut], [1, 0, 0, [{ issue: 21, why: ["no-records"] }]]);
  const { json: both } = await report(plan, { label: "exp", since: "2026-11-17" });
  const pb = both.totals.perMerged;
  assert.deepEqual([pb.usd.api.n, pb.usd.api.median, pb.reviewRounds.n, pb.leftOut], [1, 5, 1, [{ issue: 21, why: ["no-records"] }, { issue: 22, why: ["no-passes", "no-clock"] }]]);

  // The boundary: #3's stages all before the period, its merge and its finish card in it; its card and thread are read.
  const carded = churnedWorld();
  carded.comments.push(await finishCard3(carded));
  const { json: b } = await report(carded, { since: "2026-11-17T02:27:00Z" });
  assert.ok(!b.objectives.some((o) => o.issue === 3 && o.stages.work + o.stages.review > 0), "no stage of #3 in the period");
  const q = b.totals.perMerged;
  // #3 and #7 merged in it; #7 is left out where its teammate's stage leaves it unknown, #3 nowhere.
  assert.deepEqual([q.n, q.usd.api.n, q.usd.api.median, q.fixPasses.n, q.fixPasses.median, q.wallMinutes.n, q.leftOut.map((x) => x.issue)], [2, 1, 0.519812, 1, 1, 1, [7]]);
});

test("report (#570 V5): per merged Objective, the median and p25..p75 over three or more Objectives, each billing kind apart", async () => {
  const w = blank();
  for (const [n, usd] of [[30, 1], [31, 2], [32, 4], [33, 10]]) {
    w.issues.push(objectiveIssue(n));
    w.pulls.push(ownPull(n, { created: "2026-11-17T05:00:00Z", merged: "2026-11-17T06:00:00Z" }));
    w.comments.push(progress(n, "work", `local-m${n}`, { user: ME, at: "2026-11-17T02:00:00Z", spend: { usd, parts: { usdByBilling: { api: usd }, billing: "api", route: "local" } } }));
  }
  // #33's build is on the subscription: $0 at api, its own kind apart.
  w.comments = w.comments.map((c) => (c.body.startsWith("<!-- pendulum:33:") ? { ...c, body: c.body.replace('"usdByBilling":{"api":10},"billing":"api"', '"usdByBilling":{"subscription":10},"billing":"subscription"') } : c));
  const { json: r } = await report(w, { since: "2026-11-17" });
  const p = r.totals.perMerged;
  assert.equal(p.n, 4);
  // api over 0, 1, 2, 4; subscription over 0, 0, 0, 10: closest ranks interpolated, every measured Objective in each kind.
  assert.deepEqual(p.usd.api, { median: 1.5, p25: 0.75, p75: 2.5, n: 4, leftOut: 0 });
  assert.deepEqual(p.usd.subscription, { median: 0, p25: 0, p75: 2.5, n: 4, leftOut: 0 });
  assert.deepEqual(p.reviewRounds, { median: 0, p25: 0, p75: 0, n: 4, leftOut: 0 });
});

test("report (#570 V6): a reopened Objective merged again is clocked to its last merge, its newest card's, on both paths", async () => {
  // #3 merged and carded, then reopened: a work stage after the merge, a second PR merged at 04:00 and its card.
  const make = ({ secondCard }) => {
    const w = churnedWorld();
    return finishCard3(w).then((first) => {
      w.comments.push(first, progress(3, "work", "local-again", { user: ME, at: "2026-11-17T03:30:00Z", spend: { usd: 0.5, parts: { usdByBilling: { api: 0.5 }, billing: "api", route: "local" } } }));
      w.pulls.push({ ...ownPull(3, { number: 40, created: "2026-11-17T03:20:00Z", merged: "2026-11-17T04:00:00Z" }), head: { ref: "pendulum/3", repo: { id: scratchPr.head?.repo?.id ?? 1 } }, base: { repo: { id: scratchPr.base?.repo?.id ?? 1 } } });
      if (secondCard) w.comments.push(comment(3, first.body.replace(/"merged":"[^"]*"/, '"merged":"2026-11-17T04:00:00Z"'), { at: "2026-11-17T04:01:00Z" }));
      return w;
    });
  };
  const wall = Math.round(((Date.parse("2026-11-17T04:00:00Z") - Date.parse("2026-11-17T02:23:42Z")) / 60_000) * 100) / 100;
  for (const secondCard of [true, false]) {
    const w = await make({ secondCard });
    for (const flags of [{ issue: 3 }, { issue: 3, by: "account" }]) {
      const three = byIssue((await report(w, flags)).json, 3);
      assert.deepEqual([three.outcome, three.started, three.merged, three.wallMinutes, three.clockWhy], ["merged", "2026-11-17T02:23:42Z", "2026-11-17T04:00:00Z", wall, null], `${secondCard ? "its second card" : "its second PR"}, ${JSON.stringify(flags)}`);
      assert.equal(three.stages.work, 2, "the work after the first merge counts");
    }
    // In a period that ends before the last merge it is not merged in it.
    const { json: early } = await report(w, { since: "2026-11-17", until: "2026-11-17T03:00:00Z" });
    assert.ok(!early.totals.perMerged.leftOut.some((x) => x.issue === 3) && early.totals.perMerged.usd.api.n === 0, "#3 merged last at 04:00");
  }
});
