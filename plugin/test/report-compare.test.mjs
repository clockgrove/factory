import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY } from "../scripts/lib/github.mjs";
import { harnessMarker, ledgerMarker, setSelf, spendMarker } from "../scripts/lib/logic.mjs";
import { PENDULUM_VERSION } from "../scripts/lib/inputs.mjs";
import { renderReport } from "../scripts/lib/report.mjs";
import { parseArgs, reportCommand } from "../scripts/local.mjs";
import { PREVIOUS_NAME } from "../scripts/lib/local.mjs";
import { baselineOf } from "../../bench/lib/baseline.mjs";

// `pendulum report --compare` (#545): two experiment arms side by side, from Pendulum's own records alone, each arm's
// label counted only where the person who last applied it can push.

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const APP = { id: 2271, slug: "clockgrove-pendulum" };
const BOT = { login: `${APP.slug}[bot]`, type: "Bot" };
const ME = { login: "kirkmarple-clockgrove", id: 1, type: "User" };
const OUTSIDER = { login: "triager", id: 2, type: "User" };
const OTHER_APP = { login: "labeller[bot]", id: 3, type: "Bot" };
const FAST = "pendulum:experiment:fast";
const SLOW = "pendulum:experiment:slow";
const T0 = Date.parse("2026-11-17T01:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString().replace(/\.000Z$/, "Z");
const issueUrl = (n) => `https://api.github.com/repos/${REPO.full}/issues/${n}`;
let nextId = 5000;

/**
 * One Objective of the experiment: on GitHub Actions, its work stage and each review stage a progress comment of the App's
 * with no spend line, its dollars and per-pass ledger in the stage's usage artifact. `work` and each of `reviews` are
 * passes ([label, usd, minutes]); `kind` their billing; `wall` the minutes from its `pendulum:objective` label to the merge.
 */
function objective(w, n, { arms = [], labeller = ME, kind = "api", work = [["work-1", 1, 10]], reviews = [], wall = 60, outcome = "merged", unknown = false, route = "actions" }) {
  const labels = ["pendulum:objective", ...arms, ...(outcome === "blocked" ? ["pendulum:blocked"] : [])];
  w.issues.push({ number: n, title: `Objective ${n}`, state: outcome === "blocked" ? "open" : "closed", labels: labels.map((name) => ({ name })), created_at: at(-30), user: ME });
  w.timelines[n] = [{ event: "labeled", label: { name: "pendulum:objective" }, actor: ME, created_at: at(0) }, ...arms.map((name) => ({ event: "labeled", label: { name }, actor: labeller, created_at: at(1) }))];
  let clock = 5;
  let run = n * 100;
  const stage = (stageName, passes) => {
    run += 1;
    const key = route === "comment" ? `local-${run}` : String(run);
    const opened = clock;
    const ledger = passes.map(([label, usd, minutes]) => {
      const e = { label, model: "claude-opus-5-5", effort: "medium", started: at(clock), ended: at(clock + minutes), usd: unknown ? null : usd, usdUnknown: unknown ? 1 : 0, usdUnknownWhy: unknown ? ["unreported"] : [], billing: kind, usdByBilling: unknown ? {} : { [kind]: usd }, tokens: { input: 10, output: 1, cached: 0, written: 0 } };
      clock += minutes;
      return e;
    });
    const usd = Math.round(passes.reduce((s, p) => s + p[1], 0) * 1e6) / 1e6;
    const record = { harness: "claude", model: "claude-opus-5-5", usd: unknown ? null : usd, usdUnknown: unknown ? 1 : 0, usdUnknownWhy: unknown ? ["unreported"] : [], usdByBilling: unknown ? {} : { [kind]: usd }, billing: kind, runs: 1, exit: "delivered", progressRun: key, tokens: { input: 10, output: 1, cached: 0, written: 0 }, ledger, ran: { pendulum: PENDULUM_VERSION } };
    const head = [`<!-- pendulum:${n}:progress:${stageName}:${key} -->`, `Pendulum ${stageName}: started.`, harnessMarker("claude", "claude-opus-5-5", { worker: "claude-opus-5-5", subagent: null, reviewer: null, labels: [] })];
    // route "comment": a local stage by Pendulum's own login, its spend line and per-pass ledger line in its progress
    // comment (#543) and no artifact; else an Actions stage of the App's, its dollars and ledger in its usage artifact.
    if (route === "comment") {
      w.comments.push({ id: (nextId += 1), issue_url: issueUrl(n), user: ME, author_association: "OWNER", created_at: at(opened), updated_at: at(opened), body: [...head, spendMarker(record.usd ?? 0, unknown ? { usdUnknown: 1, usdUnknownWhy: ["unreported"] } : { usdByBilling: { [kind]: usd }, billing: kind }), ledgerMarker(ledger, { model: "claude-opus-5-5", version: PENDULUM_VERSION, published: ["claude-opus-5-5"] })].join("\n") });
      return;
    }
    w.comments.push({ id: (nextId += 1), issue_url: issueUrl(n), user: BOT, author_association: "CONTRIBUTOR", performed_via_github_app: { id: APP.id, slug: APP.slug }, created_at: at(opened), updated_at: at(opened), body: head.join("\n") });
    const name = `pendulum-usage-${n}${stageName === "review" ? "-review" : ""}`;
    (w.artifacts[name] ||= []).push({ id: run, name, expired: false, created_at: at(clock), workflow_run: { id: run, repository_id: 1, head_repository_id: 1 }, record });
  };
  stage("work", work);
  for (const r of reviews) stage("review", r);
  if (outcome === "merged") w.pulls.push({ number: n + 1000, head: { ref: `pendulum/${n}`, repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: at(4), updated_at: at(wall), merged_at: at(wall), state: "closed" });
}

/**
 * The experiment: arm `fast` (#11-#14, #15 labelled by someone who cannot push, #16 in both arms) and arm `slow` (#21-#23,
 * #24 labelled through another App). Every figure below is chosen so each median and quartile is exact.
 */
function experiment() {
  const w = { issues: [], comments: [], pulls: [], artifacts: {}, timelines: {}, permissions: { [ME.login]: "admin", [OUTSIDER.login]: "triage", teammate: "write" } };
  objective(w, 11, { arms: [FAST], work: [["work-1", 1, 10]], wall: 60 });
  objective(w, 12, { arms: [FAST], work: [["work-1", 1.5, 15], ["validation-fix-1", 0.5, 5]], reviews: [[["review", 0.5, 5]]], wall: 90 });
  objective(w, 13, { arms: [FAST], work: [["work-1", 4, 30]], reviews: [[["review", 0, 1]], [["review", 0, 1]]], wall: 180 });
  objective(w, 14, { arms: [FAST], work: [["work-1", 0.7, 7]], outcome: "blocked" });
  objective(w, 15, { arms: [FAST], labeller: OUTSIDER, work: [["work-1", 100, 1]], wall: 1 });
  objective(w, 16, { arms: [FAST, SLOW], work: [["work-1", 50, 1]], wall: 1 });
  objective(w, 21, { arms: [SLOW], kind: "subscription", work: [["work-1", 2, 30], ["validation-fix-1", 0.5, 5], ["validation-fix-2", 0.5, 5]], reviews: [[["review", 0, 2]]], wall: 120 });
  objective(w, 22, { arms: [SLOW], kind: "subscription", work: [["work-1", 5, 50]], wall: 240 });
  objective(w, 23, { arms: [SLOW], kind: "subscription", work: [["work-1", 0, 10]], wall: 30, unknown: true });
  objective(w, 24, { arms: [SLOW], labeller: OTHER_APP, work: [["work-1", 70, 1]], wall: 1 });
  return w;
}

/**
 * Each merged Objective's finish card in `w`, as Pendulum's App posts it: the real card (`card`, the finish-card module)
 * from its comments, timeline, PR and the usage records the card reads (its stages have no spend line, so every one).
 */
function carded(w, card) {
  const mine = card.pendulumOwn(APP.id);
  for (const pr of w.pulls.filter((p) => p.merged_at)) {
    const n = pr.number - 1000;
    const comments = w.comments.filter((c) => c.issue_url === issueUrl(n));
    const records = Object.entries(w.artifacts).filter(([name]) => name === `pendulum-usage-${n}` || name === `pendulum-usage-${n}-review`).flatMap(([name, list]) => list.map((a) => ({ ...a.record, artifact: name })));
    const d = card.finishData({ repo: REPO.full, issue: w.issues.find((i) => i.number === n), timeline: w.timelines[n], comments, pulls: [{ pr, timeline: [], reviews: [], reviewComments: [] }], checks: [], records, mine });
    w.comments.push({ id: (nextId += 1), issue_url: issueUrl(n), user: BOT, author_association: "CONTRIBUTOR", performed_via_github_app: { id: APP.id, slug: APP.slug }, created_at: pr.merged_at, updated_at: pr.merged_at, body: card.finishCardBody(d) });
  }
  return w;
}

/** A fake GitHub over `w`, page by page with Link headers as GitHub answers; `calls` lists every request. */
function fakeGitHub(w) {
  const calls = [];
  const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  const page = (list, u, wrap = null) => {
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const n = Number(u.searchParams.get("page") ?? 1);
    const last = Math.max(1, Math.ceil(list.length / per));
    const to = (k) => {
      const v = new URL(u);
      v.searchParams.set("page", String(k));
      return v.href;
    };
    const items = list.slice((n - 1) * per, n * per);
    return json(wrap ? wrap(items, list.length) : items, 200, n < last ? { link: `<${to(n + 1)}>; rel="next", <${to(last)}>; rel="last"` } : {});
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO.full}`, "");
    calls.push(`${init.method || "GET"} ${p}${u.search}`);
    if ((init.method || "GET") !== "GET") return json({ message: "a report writes nothing" }, 405);
    if (u.pathname === "/user") return json(ME);
    if (p === "/issues/comments") return page(w.comments.filter((c) => !u.searchParams.get("since") || Date.parse(c.updated_at) >= Date.parse(u.searchParams.get("since"))), u);
    if (p === "/issues") return page(w.issues.filter((i) => i.labels.some((l) => l.name.toLowerCase() === String(u.searchParams.get("labels")).toLowerCase())), u);
    let m = /^\/issues\/(\d+)\/timeline$/.exec(p);
    // `timelineStatus`: an issue whose timeline GitHub refuses (403) or no longer has (404).
    if (m && w.timelineStatus?.[m[1]]) return json({ message: "refused" }, w.timelineStatus[m[1]]);
    if (m) return page(w.timelines[m[1]] || [], u);
    // One issue and its own comments, as --issue reads them.
    m = /^\/issues\/(\d+)$/.exec(p);
    if (m) {
      const i = w.issues.find((x) => x.number === Number(m[1]));
      return i ? json({ ...i, comments: w.comments.filter((c) => c.issue_url === issueUrl(i.number)).length }) : json({ message: "Not Found" }, 404);
    }
    m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m) return page(w.comments.filter((c) => c.issue_url === issueUrl(Number(m[1]))), u);
    m = /^\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (m && w.permissions[decodeURIComponent(m[1])] === "rate-limited") return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1) });
    if (m) return w.permissions[decodeURIComponent(m[1])] === 403 ? json({ message: "Must have push access to view repository collaborators." }, 403) : json({ permission: w.permissions[decodeURIComponent(m[1])] ?? "read" });
    if (p === "/pulls") return page(w.pulls, u);
    if (p === "/actions/artifacts") return page((w.artifacts[u.searchParams.get("name")] || []).map(({ record, ...a }) => a), u, (artifacts, total) => ({ total_count: total, artifacts }));
    return json({ message: "Not Found" }, 404);
  };
  const download = async (_repo, a) => {
    calls.push(`DOWNLOAD ${a.id}`);
    return Object.values(w.artifacts).flat().find((x) => x.id === a.id)?.record ?? null;
  };
  return { fetch, download, calls };
}

/** Run `fn(fake)` with the fake GitHub over `w` in place of api.github.com and a cache directory of its own. */
async function withFake(w, fn) {
  const fake = fakeGitHub(w);
  const realFetch = globalThis.fetch;
  const saved = { api: process.env.GITHUB_API_URL, cache: process.env.XDG_CACHE_HOME };
  process.env.GITHUB_API_URL = "https://github.test";
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cache-"));
  globalThis.fetch = fake.fetch;
  try {
    return await fn(fake);
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of [["GITHUB_API_URL", saved.api], ["XDG_CACHE_HOME", saved.cache]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** `pendulum report` through its real command on the fake: {code, json, err, calls}. */
async function report(w, args) {
  let out = "";
  let err = "";
  const parsed = parseArgs(["report", "--repo", REPO.full, "--checkout", tmpdir(), "--app", String(APP.id), ...args]);
  return withFake(w, async (fake) => {
    const code = await reportCommand(parsed.flags, { out: (t) => (out += t), err: (t) => (err += t), token: "t", download: fake.download, now: Date.parse("2026-11-18T00:00:00Z") });
    return { code, out, json: args.includes("--json") ? JSON.parse(out) : null, err, calls: fake.calls };
  });
}

test("report --compare: an experiment label counts only where the person who last applied it can push", async () => {
  // `--label` with an experiment label: #15's label was applied by someone with triage access, so #15 is not counted.
  const { json: one } = await report(experiment(), ["--label", FAST, "--json"]);
  assert.deepEqual(one.objectives.map((o) => o.issue), [11, 12, 13, 14, 16]);
  assert.equal(one.comparison, null);
  assert.deepEqual(one.source.missing.find((m) => m.code === "label-untrusted").issues, [15]);
  // `--compare`: the same rule for each arm.
  const { json: r, calls } = await report(experiment(), ["--compare", "fast,slow", "--json"]);
  const [fast, slow] = r.comparison.arms;
  // #15's label was applied by someone with triage access, #24's through another App: neither is in its arm.
  assert.deepEqual(fast.objectives.map((o) => o.issue), [11, 12, 13, 14]);
  assert.deepEqual(slow.objectives.map((o) => o.issue), [21, 22, 23]);
  assert.deepEqual([fast.untrusted, slow.untrusted], [[15], [24]]);
  assert.ok(!r.objectives.some((o) => [15, 24].includes(o.issue)), "not in the report at all");
  assert.ok(![fast, slow].some((arm) => arm.objectives.some((o) => o.usd.api >= 50 || o.usd.subscription >= 50)), "#15's $100 and #24's $70 count nowhere");
  assert.deepEqual(r.source.missing.find((m) => m.code === "label-untrusted").issues, [15, 24]);
  // Its artifacts are never read: the trust check comes before any record of it.
  assert.ok(!calls.some((c) => /name=pendulum-usage-(15|24)\b/.test(c)));
  // Each labeller's permission is read once, and an App's never: it never vouches.
  assert.deepEqual(calls.filter((c) => c.includes("/permission")).sort(), [`GET /collaborators/${ME.login}/permission`, `GET /collaborators/${OUTSIDER.login}/permission`]);
  // An Objective both arms count for is in neither.
  assert.deepEqual(r.comparison.inBoth, [16]);
  assert.ok(!fast.objectives.some((o) => o.issue === 16) && !slow.objectives.some((o) => o.issue === 16));

  // A label that names no experiment is read as GitHub has it, with no timeline read.
  const w = experiment();
  for (const i of w.issues) i.labels.push({ name: "wave-7" });
  const { json: plain, calls: plainCalls } = await report(w, ["--label", "wave-7", "--json"]);
  assert.equal(plain.objectives.length, 10);
  assert.ok(!plainCalls.some((c) => c.includes("/timeline")));
});

test("report --compare: each arm's n, outcomes, and the exact median and p25..p75 per merged Objective, kinds apart, no blended total", async () => {
  const { code, json: r, err } = await report(experiment(), ["--compare", "fast", "--compare", "slow", "--json"]);
  assert.equal(code, 0, err);
  assert.deepEqual(r.scope.compare, [FAST, SLOW]);
  const [fast, slow] = r.comparison.arms;
  assert.deepEqual([fast.label, fast.experiment, slow.experiment], [FAST, "fast", "slow"]);
  assert.deepEqual([fast.n, fast.merged, slow.n, slow.merged], [4, 3, 3, 3]);
  assert.deepEqual(fast.outcomes, { merged: 3, blocked: 1, question: 0, "closed-unmerged": 0, open: 0, unread: 0 });
  // fast: $1, $2.50 ($1.50 + a $0.50 fix + a $0.50 review) and $4 billed per use.
  assert.deepEqual(fast.usdPerMerged.api, { median: 2.5, p25: 1.75, p75: 3.25, n: 3, leftOut: 0 });
  assert.deepEqual(fast.usdPerMerged.subscription, { median: 0, p25: 0, p75: 0, n: 3, leftOut: 0 });
  assert.deepEqual(fast.modelMinutes, { median: 25, p25: 17.5, p75: 28.5, n: 3, leftOut: 0 });
  assert.deepEqual(fast.wallMinutes, { median: 90, p25: 75, p75: 135, n: 3, leftOut: 0 });
  assert.deepEqual(fast.reviewRounds, { median: 1, p25: 0.5, p75: 1.5, n: 3, leftOut: 0 });
  assert.deepEqual(fast.fixPasses, { median: 0, p25: 0, p75: 0.5, n: 3, leftOut: 0 });
  assert.deepEqual(fast.unknown, { runs: 0, objectives: [], reasons: [] });
  // slow: $3 and $5 on the subscription; #23's cost was not reported, so it is left out of every dollar measure.
  assert.deepEqual(slow.usdPerMerged.subscription, { median: 4, p25: 3.5, p75: 4.5, n: 2, leftOut: 1 });
  assert.deepEqual(slow.usdPerMerged.api, { median: 0, p25: 0, p75: 0, n: 2, leftOut: 1 });
  assert.deepEqual(slow.modelMinutes, { median: 42, p25: 26, p75: 46, n: 3, leftOut: 0 });
  assert.deepEqual(slow.wallMinutes, { median: 120, p25: 75, p75: 180, n: 3, leftOut: 0 });
  assert.deepEqual(slow.reviewRounds, { median: 0, p25: 0, p75: 0.5, n: 3, leftOut: 0 });
  assert.deepEqual(slow.fixPasses, { median: 0, p25: 0, p75: 1, n: 3, leftOut: 0 });
  assert.equal(slow.unknown.runs, 1);
  assert.deepEqual(slow.unknown.objectives, [23]);
  assert.deepEqual(slow.unknown.reasons.map((x) => [x.code, x.objectives]), [["unreported", 1]]);
  // The spread is the bench baseline's own: the same rows through bench/lib/baseline.mjs give the same median.
  const line = baselineOf(fast.objectives.filter((o) => o.outcome === "merged").map((o, i) => ({ exit: "merged", mergedAt: `2026-11-1${i}`, wallMinutes: o.wallMinutes })));
  assert.deepEqual([line.measures.wallMinutes.median, line.measures.wallMinutes.p25, line.measures.wallMinutes.p75], [90, 75, 135]);
  // No total across kinds or arms, no difference between the arms.
  for (const arm of [fast, slow]) {
    assert.deepEqual(Object.keys(arm.usdPerMerged).sort(), ["api", "credits", "sandbox", "subscription", "unknown"]);
    for (const k of ["total", "usd", "difference", "delta", "pValue", "significant"]) assert.ok(!Object.hasOwn(arm, k), k);
  }
  // n is in every measure, and every arm's rows are shown: no line decides when n is "small".
  for (const k of ["smallN"]) assert.ok(!Object.hasOwn(r.comparison, k), k);
  for (const k of ["small"]) assert.ok(!Object.hasOwn(fast, k), k);
  const md = renderReport(r);
  assert.match(md, /^## Comparison$/m);
  assert.match(md, /\| Measure \| fast \| slow \|/);
  assert.match(md, /\| \$ per merged Objective: API \| \$2\.50 \(\$1\.75\.\.\$3\.25, n=3\) \| \$0\.00 \(\$0\.00\.\.\$0\.00, n=2, 1 left out\) \|/);
  assert.match(md, /\| Wall clock minutes \| 90 \(75\.\.135, n=3\) \| 120 \(75\.\.180, n=3\) \|/);
  assert.match(md, /^\*\*fast\*\*: 4 Objective\(s\), 3 merged\.$/m);
  assert.match(md, /^\*\*slow\*\*: 3 Objective\(s\), 3 merged\.$/m);
  assert.ok(!/small n/i.test(md));
  assert.match(md, /\| #23 \| merged \|/);
  assert.match(md, /No difference between the arms is claimed to be significant/);
  assert.ok(!/^## Totals$/m.test(md), "no figure across both arms");
  // The plain command prints the same Markdown.
  const plain = await report(experiment(), ["--compare", "fast,slow"]);
  assert.equal(plain.out, md);
});

test("report --compare: a labeller whose permission the token may not read (403) is not vouched for, said under its own code; the report goes on", async () => {
  const w = experiment();
  w.permissions.locked = 403;
  w.timelines[22] = w.timelines[22].map((e) => (e.label?.name === SLOW ? { ...e, actor: { login: "locked", id: 9, type: "User" } } : e));
  const { code, json: r } = await report(w, ["--compare", "fast,slow", "--json"]);
  assert.equal(code, 0);
  const slow = r.comparison.arms[1];
  assert.deepEqual(slow.objectives.map((o) => o.issue), [21, 23]);
  assert.deepEqual([slow.unverifiable, slow.untrusted], [[22], [24]]);
  assert.deepEqual(r.source.missing.find((m) => m.code === "label-unverifiable").issues, [22]);
  assert.match(renderReport(r), /Not counted for slow, its labeller's permission unreadable with this token: #22\./);
  // A rate limit's 403 says nothing of what the token may read: the report fails, and no labeller is called unverifiable.
  w.permissions.locked = "rate-limited";
  await assert.rejects(report(w, ["--compare", "fast,slow", "--json"]), /rate limit|403/i);
});

test("report --compare (#544): a merged Objective read from its finish card gives the same arm measures as its stages, with no artifact read", async () => {
  // Through the module's namespace, so the suite loads on a tree without the summary and this test alone fails there.
  const card = await import("../scripts/lib/finish-card.mjs");
  const withCards = () => carded(experiment(), card);
  const stages = await report(experiment(), ["--compare", "fast,slow", "--json"]);
  const cards = await report(withCards(), ["--compare", "fast,slow", "--json"]);
  assert.equal(cards.code, 0, cards.err);
  // Every merged Objective in an arm is read from its card: #11-#13 and #21-#23 (not #15, #16 or #24, in no arm).
  assert.equal(cards.json.source.read.summaries, 6);
  assert.ok(!cards.calls.some((c) => /name=pendulum-usage-(11|12|13|21|22|23)\b/.test(c)), "no artifact of theirs is listed");
  assert.ok(stages.calls.some((c) => /name=pendulum-usage-11\b/.test(c)), "read from its stages, the same Objective's are");
  // The same arms, measure for measure: model minutes, fix passes and wall clock among them.
  assert.deepEqual(cards.json.comparison, stages.json.comparison);
  const [fast] = cards.json.comparison.arms;
  assert.deepEqual(fast.objectives.filter((o) => o.outcome === "merged").map((o) => [o.issue, o.modelMinutes, o.fixPasses, o.wallMinutes]), [[11, 10, 0, 60], [12, 25, 1, 90], [13, 32, 0, 180]]);
});

test("report --compare (#567): a merged Objective with stages from before the rename is a lower bound: left out of every measure, its wall clock too, counted in leftOut and listed in legacy; its card says the same", async () => {
  // #11 straddles the rename: its first label under the old name (GitHub keeps it on the event), then the current one,
  // and the App's work stage under the previous marker. The same stage on #16 (in both arms) and #15 (label not vouched).
  const straddle = () => {
    const w = experiment();
    w.timelines[11] = [{ event: "labeled", label: { name: `${PREVIOUS_NAME}:objective` }, actor: ME, created_at: at(-20) }, ...w.timelines[11]];
    const old = (n) => ({ id: (nextId += 1), issue_url: issueUrl(n), user: BOT, author_association: "CONTRIBUTOR", performed_via_github_app: { id: APP.id, slug: APP.slug }, created_at: at(2), updated_at: at(2), body: [`<!-- ${PREVIOUS_NAME}:${n}:progress:work:8800 -->`, "work: started.", `<!-- ${PREVIOUS_NAME}:spend {"usd":40} -->`].join("\n") });
    w.comments.push(old(11), old(15), old(16));
    return w;
  };
  const { code, json: r, out } = await report(straddle(), ["--compare", "fast,slow", "--json"]);
  assert.equal(code, 0);
  const [fast, slow] = r.comparison.arms;
  assert.deepEqual(r.source.missing.find((m) => m.code === "legacy-records")?.issues, [11]);
  assert.equal(r.source.complete, false);
  assert.deepEqual([fast.legacy, slow.legacy], [[11], []]);
  // #11's row keeps its own figures, marked, with no wall clock (its start is under the old name); the measures leave it out.
  assert.deepEqual(fast.objectives.find((o) => o.issue === 11), { issue: 11, outcome: "merged", usd: { api: 1, subscription: 0, credits: 0, unknown: 0, sandbox: 0 }, unknownRuns: 0, modelMinutes: 10, wallMinutes: null, reviewRounds: 0, fixPasses: 0, findings: null, legacyStages: 1 });
  assert.deepEqual(fast.usdPerMerged.api, { median: 3.25, p25: 2.875, p75: 3.625, n: 2, leftOut: 1 });
  assert.deepEqual(fast.modelMinutes, { median: 28.5, p25: 26.75, p75: 30.25, n: 2, leftOut: 1 });
  assert.deepEqual(fast.fixPasses, { median: 0.5, p25: 0.25, p75: 0.75, n: 2, leftOut: 1 });
  assert.deepEqual(fast.reviewRounds, { median: 1.5, p25: 1.25, p75: 1.75, n: 2, leftOut: 1 });
  assert.deepEqual(fast.wallMinutes, { median: 135, p25: 112.5, p75: 157.5, n: 2, leftOut: 1 });
  assert.deepEqual(slow.usdPerMerged.subscription, { median: 4, p25: 3.5, p75: 4.5, n: 2, leftOut: 1 });
  const md = renderReport(JSON.parse(out));
  assert.match(md, /^- Left out of fast's measures and findings, with stages from before the rename to Pendulum not read: #11\.$/m);
  // Read from the finish cards instead, the same comparison: #11's card has no wall clock either.
  const card = await import("../scripts/lib/finish-card.mjs");
  const cards = await report(carded(straddle(), card), ["--compare", "fast,slow", "--json"]);
  assert.equal(cards.json.source.read.summaries, 6);
  assert.deepEqual(cards.json.comparison, r.comparison);
});

test("report (#587): an Objective labelled before the rename is clocked `renamed` in every scope, from its card's own record or, for a card from before it recorded why, from its timeline, read and planned", async () => {
  const card = await import("../scripts/lib/finish-card.mjs");
  // #12's first label under the old name, which its card's timeline did not show.
  const renamed = (w) => {
    w.timelines[12] = [{ event: "labeled", label: { name: `${PREVIOUS_NAME}:objective` }, actor: ME, created_at: at(-20) }, ...w.timelines[12]];
    return w;
  };
  // Every card as a release before #587 wrote it: no `clockWhy` in its summary, its release 0.10.2.
  const old = (w) => {
    for (const c of w.comments.filter((x) => /^<!-- pendulum:\d+:finish -->/.test(x.body))) {
      assert.match(c.body, /,"clockWhy":null/);
      c.body = c.body.replace(/,"clockWhy":null/, "").replace(/"pendulum":"[^"]*"/, '"pendulum":"0.10.2"');
    }
    return w;
  };
  const clock = (r, n) => {
    const o = r.objectives.find((x) => x.issue === n);
    return [o.started, o.wallMinutes, o.clockWhy];
  };
  const world = () => renamed(old(carded(experiment(), card)));
  for (const [scope, args] of [["a period", ["--since", "2026-11-16"]], ["--issue", ["--issue", "12"]], ["--compare", ["--compare", "fast,slow"]]]) {
    const { json: r, calls } = await report(world(), [...args, "--json"]);
    assert.deepEqual(clock(r, 12), [null, null, "renamed"], scope);
    assert.equal(calls.filter((c) => c.includes("/issues/12/timeline")).length, 1, `${scope}: its timeline read once`);
    assert.equal(r.source.calls.planned, r.source.calls.made, `${scope}: planned`);
    // An old card on an issue labelled after the rename keeps its clock: its timeline says so.
    if (scope !== "--issue") assert.deepEqual(clock(r, 11), [at(0), 60, null], scope);
  }
  // A card that records why: `renamed` from the card itself, no timeline read for it.
  const fresh = renamed(experiment());
  // The card's own writer sees the old label: it records the reason.
  const { json: own, calls: ownCalls } = await report(carded(fresh, card), ["--issue", "12", "--json"]);
  assert.deepEqual(clock(own, 12), [null, null, "renamed"]);
  assert.ok(!ownCalls.some((c) => c.includes("/timeline")), "no timeline read");
  // A budget that stops before the timeline: the clock is not known, never the card's short one.
  const { json: full } = await report(world(), ["--issue", "12", "--json"]);
  const { code, json: cut } = await report(world(), ["--issue", "12", "--json", "--max-calls", String(full.source.calls.made - 1)]);
  assert.equal(code, 3);
  assert.deepEqual(clock(cut, 12), [null, null, "timeline-unread"]);
});

