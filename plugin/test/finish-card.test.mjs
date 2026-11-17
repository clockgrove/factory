import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETRY } from "../scripts/lib/github.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { badge, finishData, finishMarker, objectiveRecords, renderFinishCard, withFinishBlock } from "../scripts/lib/finish-card.mjs";

RETRY.sleep = async () => {};

// The run the approved mock-up was made from (clockgrove/pendulum-scratch #3 and PR #4), as GitHub answered for it.
const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "finish-scratch-3.json"), "utf8"));
const SELF = "clockgrove-pendulum[bot]";
const bot = { login: SELF, type: "Bot" };
const pulls = (over = {}) => [{ pr: real.pr, timeline: real.prTimeline, reviews: real.reviews, reviewComments: real.reviewComments, ...over }];
const data = (over = {}) => finishData({ repo: "clockgrove/pendulum-scratch", issue: real.issue, timeline: real.timeline, comments: real.comments, pulls: pulls(), checks: real.checks, records: real.records, ...over });
const withSelf = (fn) => {
  setSelf(SELF);
  try {
    return fn();
  } finally {
    setSelf(null);
  }
};
// A stage's spend line (logic.mjs spendMarker), as a local or cloud sandbox stage writes it into its progress comment.
const spendLine = (v) => `<!-- pendulum:spend ${JSON.stringify(v)} -->`;
const withSpend = (lines) => real.comments.map((c) => {
  const key = /^<!-- pendulum:3:progress:(work|review):/.exec(c.body)?.[1];
  return key ? { ...c, body: `${c.body}\n${spendLine(lines[key])}` } : c;
});

test("finish card: the merged run, every figure from the run's own records (scratch #3, the approved mock-up's run)", () => {
  const d = withSelf(() => data());
  // The clock is the label; each stage is its progress comment; its dollars its usage record (progressRun).
  assert.equal(d.started, "2026-11-17T02:23:42Z");
  assert.equal(d.merged, "2026-11-17T02:27:36Z");
  assert.deepEqual(d.stages.map((s) => [s.kind, s.start, s.end, s.model, s.usd, s.unknown]), [
    ["build", "2026-11-17T02:24:34Z", "2026-11-17T02:25:55Z", "claude-opus-5-5", 0.35637, 0],
    ["review", "2026-11-17T02:26:20Z", "2026-11-17T02:26:55Z", "claude-fable-5-2", 0.163442, 0],
  ]);
  assert.deepEqual(d.queue, [{ start: "2026-11-17T02:26:52Z", end: "2026-11-17T02:27:36Z", merged: true }], "the queue's own removal at the merge is the merge, not a drop");
  // Only the checks that completed by the merge gated it: Pendulum's own runs on the merge commit after it do not count.
  assert.deepEqual(d.checks, { passed: 1, failed: 0 });
  assert.deepEqual([d.commits, d.additions, d.deletions, d.files], [2, 20, 1, 3]);
  assert.equal(d.reviews.findings, 0, "the reviewer's placeholder is no finding");
  assert.equal(d.planned, true);

  const md = renderFinishCard(d);
  assert.ok(md.startsWith('<p align="center"><img src="https://raw.githubusercontent.com/clockgrove/pendulum/main/assets/brand/pendulum/web/mark-240.png" width="96" alt="Pendulum"></p>'));
  assert.match(md, /^<h3 align="center">Merged in 3 min 54 s for \$0\.52\.<\/h3>$/m);
  assert.doesNotMatch(md, /^#{1,2} |<h[12]\b/m, "an h3 headline, no h1 or h2");
  assert.match(md, /issue #3 → <a href="https:\/\/github\.com\/clockgrove\/pendulum-scratch\/pull\/4">PR #4<\/a> · landed through your merge queue at 02:27 UTC/);
  assert.ok(md.includes(badge("status", "merged", "4a7a3a")));
  assert.ok(md.includes('<img alt="wall clock: 3m 54s" src="https://img.shields.io/badge/wall_clock-3m_54s-7a4a24?style=for-the-badge">'));
  assert.ok(md.includes('<img alt="cost: $0.52" src="https://img.shields.io/badge/cost-%240.52-c9822e?style=for-the-badge">'));
  assert.doesNotMatch(md, /human/i, "no human-action badge: the scorer's count is not computed at merge time");
  assert.match(md, /^You wrote the issue and added the label\. Pendulum took it from there: it planned the work, made \*\*2 commits\*\* \(\+20 −1 across 3 files\), got \*\*1 check\*\* green, had the change reviewed \(no findings\), and it merged through your merge queue\.$/m);
  assert.match(md, /```mermaid\n%%\{init: \{"theme":"base"[^\n]*\}%%\ngantt\n/);
  assert.match(md, /section Build\n {4}1m 21s :active, 2026-11-17T02:24:34, 2026-11-17T02:25:55\n {4}section Review\n {4}35s :active, 2026-11-17T02:26:20, 2026-11-17T02:26:55\n {4}section Queue\n {4}44s :active, 2026-11-17T02:26:52, 2026-11-17T02:27:36\n```/);
  assert.match(md, /\| Stage \| Time \| Cost \|\n\| --- \| ---: \| ---: \|\n\| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|\n\| Review · Fable 5\.2 \| 35 s \| \$0\.16 \|\n\| Merge queue · your CI \| 44 s \| — \|\n\| \*\*Total\*\* \| \*\*3 min 54 s\*\* \| \*\*\$0\.52\*\* \|/);
  assert.match(md, /pie showData\n {4}"Plan \+ build" : 0\.36\n {4}"Review" : 0\.16\n```/);
  // No billing recorded (#481): the card says so rather than call it billed or API-equivalent.
  assert.match(md, /<sub>These are the costs Pendulum recorded for this run; Pendulum did not record whether they were billed to an API key or are a subscription's API-equivalent figures\./);
  assert.match(md, /<details><summary>Full run log<\/summary>\n\n- 02:23:42 labelled `pendulum:objective`: the clock starts\n- 02:24:34 plan \+ build stage started \(claude-opus-5-5\)\n/);
  assert.match(md, /- 02:27:36 PR #4 merged, 1 check passed\n\n<\/details>$/);
});

test("finish card: a run with unreported spend shows it as unknown, never as a number, and draws no cost chart", () => {
  // The work stage was killed before its harness reported (a run of unknown cost, $0 known); the review reported $0.10.
  const comments = withSpend({ work: { usd: 0, usdUnknown: 1, usdUnknownWhy: ["unreported"] }, review: { usd: 0.1 } });
  const part = withSelf(() => data({ comments, records: [] }));
  assert.deepEqual(part.stages.map((s) => [s.usd, s.unknown]), [[null, 1], [0.1, 0]]);
  const md = renderFinishCard(part);
  assert.match(md, /<h3 align="center">Merged in 3 min 54 s for \$0\.10 plus spend that was not reported\.<\/h3>/);
  assert.ok(md.includes('<img alt="cost: $0.10 + unknown" src="https://img.shields.io/badge/cost-%240.10_%2B_unknown-c9822e?style=for-the-badge">'));
  assert.match(md, /\| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| unknown \|/);
  assert.match(md, /\| \*\*Total\*\* \| \*\*3 min 54 s\*\* \| \*\*\$0\.10 \+ unknown\*\* \|/);
  assert.match(md, /One run has no reported cost, so it shows as unknown, not as a number\./);
  assert.doesNotMatch(md, /pie showData/, "no chart of a total that is not known");

  // No record at all for either stage (artifacts expired or unreadable): every figure is unknown.
  const none = renderFinishCard(withSelf(() => data({ records: [] })));
  assert.match(none, /<h3 align="center">Merged in 3 min 54 s; its cost is unknown\.<\/h3>/);
  assert.ok(none.includes('<img alt="cost: unknown"'));
  assert.doesNotMatch(none.split("<details>")[0], /\$\d/, "no dollar figure anywhere above the run log");
});

test("finish card: subscription dollars read API-equivalent everywhere they show (#481's billing field)", () => {
  const records = real.records.map((r) => ({ ...r, billing: "subscription" }));
  const md = renderFinishCard(withSelf(() => data({ records })));
  assert.match(md, /<h3 align="center">Merged in 3 min 54 s for \$0\.52 API-equivalent\.<\/h3>/);
  assert.ok(md.includes('<img alt="API-equivalent: $0.52" src="https://img.shields.io/badge/API--equivalent-%240.52-c9822e?style=for-the-badge">'));
  assert.match(md, /\| Stage \| Time \| API-equivalent \|/);
  assert.match(md, /API-equivalent: what the usage would cost at API prices, covered by your subscription and not billed\./);
  assert.doesNotMatch(md, /alt="cost:/);

  // The same billing from a local stage's spend line; and stages on an API key say billed.
  const local = renderFinishCard(withSelf(() => data({ comments: withSpend({ work: { usd: 0.35637, billing: "subscription" }, review: { usd: 0.163442, billing: "subscription" } }), records: [] })));
  assert.match(local, /for \$0\.52 API-equivalent\./);
  const api = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, billing: "api" })) })));
  assert.match(api, /for \$0\.52\.<\/h3>/);
  assert.match(api, /These are the costs Pendulum recorded for this run, billed to your API key\./);
  // One stage on each: the subscription's cell says so.
  const mixed = renderFinishCard(withSelf(() => data({ records: [{ ...real.records[0], billing: "api" }, { ...real.records[1], billing: "subscription" }] })));
  assert.match(mixed, /\| Review · Fable 5\.2 \| 35 s \| \$0\.16 API-equivalent \|/);
  assert.match(mixed, /a subscription's figures are API-equivalent, not billed spend\./);
});

test("finish card: review findings are counted from the reviews, line comments and body findings alike; none says so", () => {
  const review = real.reviews[0];
  const body = `${review.body}\n\n2 finding(s) GitHub cannot take as a line comment:\n\n<!-- pendulum:finding {"n":1,"path":"a.js","line":3} -->\n**a.js:3**\n\nx\n\n<!-- pendulum:finding {"n":2,"cut":3} -->\n(3 more finding(s) are cut)`;
  const reviewComments = [
    { id: 1, pull_request_review_id: review.id, user: bot, body: "a finding" },
    { id: 2, pull_request_review_id: review.id, user: bot, body: "another" },
    { id: 3, pull_request_review_id: review.id, in_reply_to_id: 1, user: bot, body: "an answer is no finding" },
    { id: 4, pull_request_review_id: 999, user: { login: "someone" }, body: "another reviewer's" },
  ];
  const d = withSelf(() => data({ pulls: pulls({ reviews: [{ ...review, body }], reviewComments }) }));
  assert.equal(d.reviews.findings, 6, "two line comments, one body finding and a cut tail of three");
  assert.match(renderFinishCard(d), /had the change reviewed \(6 findings\)/);
  // No Pendulum review at all (auto-merge off and merged by hand before one): the sentence leaves the review out.
  const none = renderFinishCard(withSelf(() => data({ pulls: pulls({ reviews: [], reviewComments: [] }) })));
  assert.doesNotMatch(none, /reviewed/);
  assert.match(renderFinishCard(withSelf(() => data())), /had the change reviewed \(no findings\)/);
});

test("finish card: the PR body gets the headline and badges at its top, once however often it is written", () => {
  const d = withSelf(() => data());
  const once = withFinishBlock(real.pr.body, d);
  assert.ok(once.startsWith('<!-- pendulum:3:finish-pr -->\n<h3 align="center">Merged in 3 min 54 s for $0.52.</h3>\n\n<p align="center">\n<img alt="status: merged"'));
  assert.ok(once.endsWith(`<!-- pendulum:3:finish-pr:end -->\n\n${real.pr.body}`));
  assert.equal(withFinishBlock(once, d), once);
});

test("finish card: an Actions stage's dollars come from its usage artifact, read by name; a token that may not read artifacts reads none", async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const asked = [];
  let status = 200;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get("name"));
    const name = u.searchParams.get("name");
    return new Response(JSON.stringify(status === 200 ? { total_count: 1, artifacts: [{ id: name.length, name, expired: false, workflow_run: { id: 44 } }, { id: 9, name, expired: true, workflow_run: { id: 45 } }] } : { message: "Resource not accessible by integration" }), { status, headers: { "content-type": "application/json" } });
  };
  try {
    const recs = await objectiveRecords({ owner: "acme", name: "app", full: "acme/app" }, 3, { token: "t", download: async (a) => ({ artifact: a.name, usd: 1 }) });
    assert.deepEqual(asked, ["pendulum-usage-3", "pendulum-usage-3-review"]);
    assert.deepEqual(recs.map((r) => r.artifact), ["pendulum-usage-3", "pendulum-usage-3-review"], "an expired artifact is not read");
    status = 403;
    assert.deepEqual(await objectiveRecords({ owner: "acme", name: "app", full: "acme/app" }, 3, { token: "t", download: async () => assert.fail("nothing to download") }), []);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

/**
 * One dispatcher tick on the Action's route over a fake GitHub holding closed Objectives: #3 merged (scratch #3's run, its
 * stages' spend lines in their progress comments), #7 Blocked with a PR a person merged, #8 closed with its PR still open.
 * Comments posted on a tick are there on the next.
 */
function fakeRepo({ failCard = 0 } = {}) {
  const issue = (number, labels) => ({ number, state: "closed", closed_at: real.issue.closed_at, labels: labels.map((name) => ({ name })), body: "", user: { login: "maintainer" } });
  const closed = [issue(3, ["pendulum:objective", "pendulum:in-review"]), issue(7, ["pendulum:objective", "pendulum:blocked"]), issue(8, ["pendulum:objective", "pendulum:in-review"])];
  const comments = { 3: withSpend({ work: { usd: 0.35637 }, review: { usd: 0.163442 } }), 7: [], 8: [] };
  const prs = { 3: [{ ...real.pr, user: bot }], 7: [{ number: 70, merged_at: "2026-11-17T02:27:36Z", created_at: "2026-11-17T02:20:00Z" }], 8: [{ number: 80, state: "open", merged_at: null, created_at: "2026-11-17T02:20:00Z" }] };
  const writes = [];
  let nextId = 100;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET" && p !== "/graphql") writes.push(`${method} ${p}${init.body ? ` ${JSON.parse(init.body).body ?? ""}` : ""}`);
    if (method === "GET" && p === "/issues") return json(u.searchParams.get("state") === "closed" ? closed : []);
    if (method === "GET" && p === "/pulls" && u.searchParams.get("state") === "all") return json(prs[/pendulum\/(\d+)$/.exec(u.searchParams.get("head"))[1]] || []);
    if (method === "GET" && p === "/pulls/4") return json(real.pr);
    if (method === "GET" && p === "/issues/4/timeline") return json(real.prTimeline);
    if (method === "GET" && p === "/pulls/4/reviews") return json(real.reviews);
    if (method === "GET" && p === "/pulls/4/comments") return json(real.reviewComments);
    if (method === "GET" && p === `/commits/${real.pr.merge_commit_sha}/check-runs`) return json({ total_count: real.checks.length, check_runs: real.checks });
    if (method === "GET" && p === "/actions/artifacts") return json({ total_count: 0, artifacts: [] });
    if (method === "GET" && p === "/issues/3/timeline") return json(real.timeline);
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(p)) return json([]);
    if (method === "GET" && p.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    const c = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (c && method === "GET") return json(comments[c[1]] ?? []);
    if (c && method === "POST" && failCard) return json({ message: "failed" }, failCard);
    if (c && method === "POST") {
      const posted = { id: (nextId += 1), user: bot, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), body: JSON.parse(init.body).body };
      (comments[c[1]] ??= []).push(posted);
      return json(posted, 201);
    }
    if (method === "PATCH" || method === "DELETE" || method === "POST") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, writes };
}

test("finish card: the dispatcher's Done pass posts it once when an Objective merges, before its label goes; a later tick posts none; none on a Block or an unmerged close", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const fake = fakeRepo();
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.PENDULUM_LOCAL;
  delete process.env.PENDULUM_LOCAL_ALL;
  globalThis.fetch = fake.fetch;
  setSelf(SELF);
  const tick = () => dispatch({ repo: "acme/app", objectiveLabel: "pendulum:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
  try {
    const first = await tick();
    assert.deepEqual(first.finished, [3]);
    assert.deepEqual(first.done, [3, 7, 8], "every closed Objective is still tidied");
    const on = (n) => fake.writes.filter((w) => w.includes(`/issues/${n}/`) || w.includes(`/pulls/${n === 3 ? 4 : n * 10}`));
    const three = on(3);
    const card = three.filter((w) => w.startsWith(`POST /issues/3/comments ${finishMarker(3)}\n`));
    assert.equal(card.length, 1, "one card");
    assert.match(card[0], /<h3 align="center">Merged in 3 min 54 s for \$0\.52\.<\/h3>/, "its dollars from the stages' spend lines");
    const body = three.findIndex((w) => w.startsWith("PATCH /pulls/4 <!-- pendulum:3:finish-pr -->\n<h3"));
    assert.ok(body >= 0 && body < three.indexOf(card[0]), "the PR body first, then the card");
    assert.ok(three.indexOf(card[0]) < three.findIndex((w) => w.startsWith("DELETE /issues/3/labels/")), "the card before the label goes");
    assert.ok(!fake.writes.some((w) => w.includes(finishMarker(7)) || w.includes(finishMarker(8))), "no card on a Block, nor on a close with its PR unmerged");
    assert.ok(!fake.writes.some((w) => w.startsWith("PATCH /pulls/70") || w.startsWith("PATCH /pulls/80")));

    // A second tick (the label's removal lost, so #3 is tidied again): its card is there, so none is posted.
    const before = fake.writes.length;
    const second = await tick();
    assert.deepEqual(second.finished, []);
    assert.ok(!fake.writes.slice(before).some((w) => w.includes(finishMarker(3)) || w.startsWith("PATCH /pulls/4")), "posted once");
    // A card that meets a passing failure leaves the label for the next tick, which tries again; any other failure
    // leaves the tidy to go on without it.
    const failing = fakeRepo({ failCard: 502 });
    globalThis.fetch = failing.fetch;
    const failed = await tick();
    assert.deepEqual(failed.finished, []);
    assert.ok(!failed.done.includes(3));
    assert.ok(!failing.writes.some((w) => w.startsWith("DELETE /issues/3/labels/")), "no tidy without its card");
    const refused = fakeRepo({ failCard: 422 });
    globalThis.fetch = refused.fetch;
    assert.deepEqual((await tick()).done, [3, 7, 8]);
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
