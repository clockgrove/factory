import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETRY } from "../scripts/lib/github.mjs";
import { setSelf, setWriters } from "../scripts/lib/logic.mjs";
import { PREVIOUS_NAME } from "../scripts/lib/local.mjs";
import { centsOf, finishData, finishMarker, objectiveRecords, renderFinishCard } from "../scripts/lib/finish-card.mjs";

RETRY.sleep = async () => {};

// The run the approved mock-up was made from (clockgrove/pendulum-scratch #3 and PR #4), as GitHub answered for it.
const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "finish-scratch-3.json"), "utf8"));
const SELF = "clockgrove-pendulum[bot]";
const bot = { login: SELF, type: "Bot" };
const pulls = (over = {}) => [{ pr: real.pr, timeline: real.prTimeline, reviews: real.reviews, reviewComments: real.reviewComments, ...over }];
// Each usage record as objectiveRecords returns it, with its artifact's name: the stage whose progress comment it names.
const tagged = (records, comments = real.comments) =>
  records.map((r) => {
    if (r.artifact) return r;
    const stage = comments.map((c) => new RegExp(`^<!-- pendulum:3:progress:(work|review):${r.progressRun} -->`).exec(c.body || "")?.[1]).find(Boolean);
    return stage ? { ...r, artifact: stage === "review" ? "pendulum-usage-3-review" : "pendulum-usage-3" } : r;
  });
const data = (over = {}) => {
  const args = { repo: "clockgrove/pendulum-scratch", issue: real.issue, timeline: real.timeline, comments: real.comments, pulls: pulls(), checks: real.checks, records: real.records, ...over };
  return finishData({ ...args, records: tagged(args.records, args.comments) });
};
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
const withSpend = (lines, comments = real.comments) =>
  comments.map((c) => {
    const key = /^<!-- pendulum:3:progress:(work|review):/.exec(c.body)?.[1];
    return key && lines[key] ? { ...c, body: `${c.body}\n${spendLine(lines[key])}` } : c;
  });
const comment = (id, created, body, updated = created) => ({ id, user: bot, created_at: created, updated_at: updated, body });

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
  assert.deepEqual(d.checks, { passed: 1, failed: 0, required: false });
  assert.deepEqual([d.commits, d.additions, d.deletions, d.files], [2, 20, 1, 3]);
  assert.equal(d.reviews.findings, 0, "the reviewer's placeholder is no finding");
  assert.deepEqual([d.planned, d.author, d.labeller], [true, "kirkmarple-clockgrove", "kirkmarple-clockgrove"]);

  const md = renderFinishCard(d);
  // Text only (#589): the headline block first, no image, no badge, no centred heading.
  assert.ok(md.startsWith("### ✅ Merged in 3 min 54 s · $0.52\nIssue #3 → PR #4 · merged through your merge queue at 2:27 AM UTC · billing not recorded\n\n"), md.slice(0, 200));
  assert.doesNotMatch(md, /<img|<h\d|shields\.io|^#{1,2} /m, "no image, no badge, no h1 or h2");
  assert.doesNotMatch(md, /human/i, "no human-action figure: the scorer's count is not computed at merge time");
  assert.match(md, /^You wrote the issue and added the label\. Pendulum planned the work, opened PR #4 \(\*\*2 commits, \+20 −1 across 3 files\*\*\), got \*\*1 CI check\*\* green, had the change reviewed \(no findings\), and it merged through your merge queue\.$/m);
  assert.match(md, /\*\*Timeline\*\* \(UTC\)\n\n```mermaid\n%%\{init: \{"theme":"base"[^\n]*\}%%\ngantt\n/);
  assert.match(md, /section Build\n {4}1m 21s :active, 2026-11-17T02:24:34, 2026-11-17T02:25:55\n {4}section Review\n {4}35s :active, 2026-11-17T02:26:20, 2026-11-17T02:26:55\n {4}section Queue\n {4}44s :active, 2026-11-17T02:26:52, 2026-11-17T02:27:36\n```/);
  assert.match(md, /\| Time \| Stage \| Took \| Cost \|\n\| :-- \| :-- \| --: \| --: \|\n\| 2:24 AM \| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|\n\| 2:26 AM \| Review · Fable 5\.2 \| 35 s \| \$0\.16 \|\n\| 2:26 AM \| Merge queue · your CI \| 44 s \| — \|\n\| \| \*\*Total\*\* \| \*\*3 min 54 s\*\* \| \*\*\$0\.52\*\* \|/);
  // A plain run: no breakdown, so no cost chart; the notes line says what the figures leave out.
  assert.doesNotMatch(md, /xychart|pie showData/);
  assert.match(md, /^CI minutes are not included\.$/m);
  // No billing recorded: Run details says so rather than call it billed or API-equivalent.
  assert.match(md, /<details><summary>Run details<\/summary>\n\n- \*\*Cost basis:\*\* Pendulum did not record how these dollars were billed\.\n/);
  assert.match(md, /\*\*Run log\*\* \(UTC\)\n- 2:23:42 AM labelled `pendulum:objective`: the clock starts\n- 2:24:34 AM plan \+ build stage started \(claude-opus-5-5\)\n/);
  assert.match(md, /- 2:27:36 AM PR #4 merged, 1 CI check green\n\n<\/details>$/);

  // Someone else filed the issue: each is named, and a PR Pendulum did not open is described, not claimed.
  const other = renderFinishCard(withSelf(() => data({ issue: { ...real.issue, user: { login: "filer" } }, pulls: pulls({ pr: { ...real.pr, user: { login: "someone" } } }) })));
  assert.match(other, /^\*\*filer\*\* wrote the issue and \*\*kirkmarple-clockgrove\*\* added the label\. Pendulum planned the work, got \*\*1 CI check\*\* green, had the change reviewed \(no findings\), and it merged through your merge queue\. PR #4 has \*\*2 commits, \+20 −1 across 3 files\*\*\.$/m);
  // A model id that is not one is not printed.
  const odd = withSelf(() => data({ comments: real.comments.map((c) => ({ ...c, body: c.body.replace('"model":"claude-opus-5-5"', '"model":"<img src=x>"') })), records: real.records.map((r) => ({ ...r, model: "<b>" })) }));
  assert.equal(odd.stages[0].model, null);
});

test("finish card: a stranger's paste of Pendulum's markers counts nothing", () => {
  const forged = real.comments.map((c) => ({ ...c, user: { login: "stranger", type: "User" }, author_association: "NONE" }));
  const d = withSelf(() => data({ comments: forged }));
  assert.deepEqual(d.stages, [], "a stranger's comment carrying a progress marker is no stage");
  assert.equal(d.planned, false);
  assert.equal(d.sandbox, null);
});

test("finish card: Pendulum is its own login here or its App by id, never another bot, a hand-applied label or a forged mark; another route's stage is a run of unknown cost; none found is unknown, never $0", async () => {
  const { pendulumOwn } = await import("../scripts/lib/finish-card.mjs");
  const APP = { id: 5778155, slug: "clockgrove-pendulum" };
  const own = pendulumOwn(APP.id);
  setSelf("dev");
  try {
    assert.ok(own({ user: { login: "dev" } }), "the login this process writes as");
    assert.ok(own({ user: bot, performed_via_github_app: APP }), "Pendulum's App, matched by id");
    assert.ok(!own({ user: bot }), "the App's login without GitHub's app record is not proof");
    assert.ok(!own({ user: { login: "github-actions[bot]", type: "Bot" }, performed_via_github_app: { id: 15368, slug: "github-actions" } }), "github-actions[bot] is not Pendulum");
    assert.ok(!own({ user: { login: "other-app[bot]", type: "Bot" }, performed_via_github_app: { id: 99, slug: "other-app" } }), "nor is any other App");
    assert.ok(!pendulumOwn(null)({ user: bot, performed_via_github_app: APP }), "no App id named: only the login here");
  } finally {
    setSelf(null);
  }
  // A route switch: the Action posts (its App), the review ran on a local loop under a person's login who can push, and
  // a maintainer re-applied pendulum:running by hand and pasted a local-route mark. Nothing of that is Pendulum's: the
  // local stage shows, as a run of unknown cost, never its dollars, and the total says "+ unknown".
  setWriters("clockgrove/pendulum-scratch", ["dev", "kirkmarple-clockgrove"]);
  try {
    const timeline = [...real.timeline, { id: 501, event: "labeled", label: { name: "pendulum:local" }, actor: { login: "kirkmarple-clockgrove", type: "User" }, created_at: "2026-11-17T02:26:00Z" }, { id: 502, event: "labeled", label: { name: "pendulum:running" }, actor: { login: "kirkmarple-clockgrove", type: "User" }, created_at: "2026-11-17T02:26:10Z" }, { id: 503, event: "labeled", label: { name: "pendulum:running" }, actor: { login: "github-actions[bot]", type: "Bot" }, created_at: "2026-11-17T02:26:11Z" }];
    const comments = withSpend({ review: { usd: 0.163442 } }).map((c) => (c.body.startsWith("<!-- pendulum:3:progress:review:") ? { ...c, user: { login: "dev", type: "User" } } : c));
    comments.push({ id: 600, user: { login: "kirkmarple-clockgrove", type: "User" }, created_at: "2026-11-17T02:26:12Z", body: "<!-- pendulum:3:local-route:501 -->\nmarked" });
    const d = withSelf(() => data({ timeline, comments }));
    assert.deepEqual(d.stages.map((s) => [s.kind, s.usd, s.unknown, s.model]), [["build", 0.35637, 0, "claude-opus-5-5"], ["review", null, 1, null]]);
    const md = renderFinishCard(d);
    assert.match(md, /^### ✅ Merged in 3 min 54 s · \$0\.36 \+ unknown$/m);
    assert.match(md, /\| 2:26 AM \| Review \| 35 s \| unknown \|/, "the stage shows, its dollars never");
    assert.match(md, /\*\*\$0\.36 \+ unknown\*\*/);
    assert.doesNotMatch(md, /0\.16/, "the other login's spend line is not read");
    // Another route's vendor comment: one more run of unknown cost, never its figure.
    const vendor = { id: 601, user: { login: "dev", type: "User" }, created_at: "2026-11-17T02:26:30Z", body: `<!-- pendulum:3:vendor:review:x -->\nx\n${spendLine({ usd: 9, vendorUsd: 9 })}` };
    const v = withSelf(() => data({ timeline, comments: [...comments, vendor] }));
    assert.deepEqual(v.sandbox, { usd: 0, unknown: 1 });
    assert.doesNotMatch(renderFinishCard(v), /\$9/);
    // Their plan, review or finish markers count for nothing.
    const plan = { id: 602, user: { login: "dev", type: "User" }, created_at: "2026-11-17T02:24:00Z", body: "<!-- pendulum:3:plan -->\nPlan" };
    const noPlan = real.comments.filter((c) => !c.body.startsWith("<!-- pendulum:3:plan"));
    assert.equal(withSelf(() => data({ comments: [...noPlan, plan] })).planned, false);
  } finally {
    setWriters("clockgrove/pendulum-scratch", []);
  }
  // No stage found at all: the cost is unknown, never $0.00.
  const none = withSelf(() => finishData({ repo: "clockgrove/pendulum-scratch", issue: real.issue, timeline: real.timeline, comments: real.comments, pulls: pulls(), checks: real.checks, records: tagged(real.records), mine: () => false, pushed: () => false }));
  assert.deepEqual(none.stages, []);
  const md = renderFinishCard(none);
  assert.match(md, /^### ✅ Merged in 3 min 54 s · unknown$/m);
  assert.doesNotMatch(md, /\$0\.00/);
  assert.match(md, /\| — \| Pendulum's stages, no record found \| — \| unknown \|/);
  assert.match(md, /- \*\*Unknown cost:\*\* 1 AI run had a record Pendulum could not read or attribute\. It is counted as unknown, never as \$0\./);
});

test("finish card: a Copilot stage with a spend line takes its model from its usage record, its dollars from the line (#539)", () => {
  // Copilot's default model: its harness line and progress line name none; the run's record names it.
  const copilot = withSpend({ work: { usd: 0.4 }, review: { usd: 0.2 } }).map((c) => ({ ...c, body: c.body.replace(/^<!-- pendulum:harness \{[^\n]*\} -->$/m, '<!-- pendulum:harness {"harness":"copilot","model":null,"models":{"worker":null,"subagent":null,"reviewer":null},"labels":[]} -->').replace("harness claude (claude-opus-5-5) attempt 1", "harness copilot attempt 1") }));
  const records = real.records.map((r) => ({ ...r, harness: "copilot", model: "claude-sonnet-5.5" }));
  const d = withSelf(() => data({ comments: copilot, records }));
  assert.deepEqual(d.stages.map((s) => [s.kind, s.model, s.usd, s.unknown]), [["build", "claude-sonnet-5.5", 0.4, 0], ["review", "claude-sonnet-5.5", 0.2, 0]]);
  const md = renderFinishCard(d);
  assert.match(md, /\| 2:24 AM \| Plan \+ build · Sonnet 5\.5 \| 1 min 21 s \| \$0\.40 \|\n\| 2:26 AM \| Review · Sonnet 5\.5 \| 35 s \| \$0\.20 \|/);
  // A Claude stage with a spend line: its harness line's model, as before, whatever its record says.
  const claude = withSelf(() => data({ comments: withSpend({ work: { usd: 0.4 }, review: { usd: 0.2 } }), records: real.records.map((r) => ({ ...r, model: "claude-sonnet-5.5" })) }));
  assert.deepEqual(claude.stages.map((s) => [s.kind, s.model, s.usd]), [["build", "claude-opus-5-5", 0.4], ["review", "claude-fable-5-2", 0.2]]);
});

test("finish card: a run with unreported spend shows it as unknown, never as a number, and draws no cost chart", () => {
  // The work stage was killed before its harness reported (a run of unknown cost, $0 known); the review reported $0.10.
  const comments = withSpend({ work: { usd: 0, usdUnknown: 1, usdUnknownWhy: ["unreported"] }, review: { usd: 0.1 } });
  const part = withSelf(() => data({ comments, records: [] }));
  assert.deepEqual(part.stages.map((s) => [s.usd, s.unknown]), [[null, 1], [0.1, 0]]);
  const md = renderFinishCard(part);
  assert.match(md, /^### ✅ Merged in 3 min 54 s · \$0\.10 \+ unknown\nIssue #3 → PR #4 · merged through your merge queue at 2:27 AM UTC · billing not recorded · plus 1 AI run of unknown cost$/m);
  assert.match(md, /\| 2:24 AM \| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| unknown \|/);
  assert.match(md, /\| \| \*\*Total\*\* \| \*\*3 min 54 s\*\* \| \*\*\$0\.10 \+ unknown\*\* \|/);
  assert.match(md, /- \*\*Unknown cost:\*\* 1 AI run ended \(or was still running\) before it reported its cost\. It is counted as unknown, never as \$0\./);
  assert.doesNotMatch(md, /xychart|pie showData/, "no chart of a total that is not known");

  // No record at all for either stage (artifacts expired or unreadable): every figure is unknown.
  const none = renderFinishCard(withSelf(() => data({ records: [] })));
  assert.match(none, /^### ✅ Merged in 3 min 54 s · unknown$/m);
  assert.doesNotMatch(none.split("<details>")[0], /\$\d/, "no dollar figure anywhere above the run log");
});

test("finish card: a record of a stage that ran no harness pass is a known $0, not unknown (S4)", () => {
  const records = [{ ...real.records[0], usd: null, runs: 0, noRun: true }, real.records[1]];
  const d = withSelf(() => data({ records }));
  assert.deepEqual(d.stages.map((s) => [s.usd, s.unknown]), [[0, 0], [0.163442, 0]]);
  assert.match(renderFinishCard(d), /^### ✅ Merged in 3 min 54 s · \$0\.16$/m);
});

test("finish card: what the dollars are comes from #508's usdByBilling, on records, spend lines and vendor comments; billing not recorded is no billing (B4)", () => {
  const records = real.records.map((r) => ({ ...r, usdByBilling: { subscription: r.usd } }));
  const md = renderFinishCard(withSelf(() => data({ records })));
  // What the dollars are, said once on the headline's second line; each cell is its cents alone.
  assert.match(md, /^### ✅ Merged in 3 min 54 s · \$0\.52\nIssue #3 → PR #4 · merged through your merge queue at 2:27 AM UTC · API-equivalent, not billed$/m);
  assert.match(md, /\| 2:24 AM \| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|/);
  assert.match(md, /- \*\*Cost basis:\*\* API-equivalent is what this usage would cost at API list prices; you are on a subscription, so it is not billed\./);

  // The same from local stages' spend lines; billed API spend is named as billed.
  const local = renderFinishCard(withSelf(() => data({ comments: withSpend({ work: { usd: 0.35637, usdByBilling: { subscription: 0.35637 } }, review: { usd: 0.163442, usdByBilling: { subscription: 0.163442 } } }), records: [] })));
  assert.match(local, / · API-equivalent, not billed$/m);
  const api = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, usdByBilling: { api: r.usd } })) })));
  assert.match(api, / · billed to your API key$/m);
  assert.match(api, /These dollars are billed to your API key or AI Gateway key\./);
  // A mix: the second line splits the total by kind.
  const mixed = renderFinishCard(withSelf(() => data({ records: [{ ...real.records[0], usdByBilling: { api: 0.35637 } }, { ...real.records[1], usdByBilling: { subscription: 0.163442 } }] })));
  assert.match(mixed, / · \$0\.52: \$0\.36 billed to your API key, \$0\.16 API-equivalent$/m);
  assert.match(mixed, /\| 2:24 AM \| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|\n\| 2:26 AM \| Review · Fable 5\.2 \| 35 s \| \$0\.16 \|/);
  // Copilot AI credits are billed to the seat: named, never API-equivalent.
  const credits = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, usdByBilling: { credits: r.usd } })) })));
  assert.match(credits, / · Copilot AI credits, billed to your seat$/m);
  assert.doesNotMatch(credits, /API-equivalent/);
  // #508's `unknown`: billing not recorded. It is no kind of billing: no API-equivalent words.
  const unrecorded = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, usdByBilling: { unknown: r.usd } })) })));
  assert.match(unrecorded, / · billing not recorded$/m);
  assert.match(unrecorded, /Pendulum did not record how these dollars were billed\./);
  assert.doesNotMatch(unrecorded, /API-equivalent/);
  const half = renderFinishCard(withSelf(() => data({ records: [{ ...real.records[0], usdByBilling: { subscription: 0.35637 } }, { ...real.records[1], usdByBilling: { unknown: 0.163442 } }] })));
  assert.match(half, / · \$0\.52: \$0\.36 API-equivalent, \$0\.16 billing not recorded$/m);
  assert.match(half, /- \*\*Cost basis:\*\* API-equivalent is what this usage would cost at API list prices; you are on a subscription, so it is not billed\. Pendulum did not record how these dollars were billed\./);
});

test("finish card: the rows' and the chart's cents add up to the total's", () => {
  assert.deepEqual(centsOf([0.334, 0.333, 0.333]), [34, 33, 33]);
  assert.deepEqual(centsOf([0.004, 0.996, null]), [0, 100, null]);
  const records = [{ ...real.records[0], usd: 0.004 }, { ...real.records[1], usd: 0.996 }];
  const md = renderFinishCard(withSelf(() => data({ records })));
  // A row under a cent above zero reads "<$0.01", never "$0.00"; the rows still add up to the total.
  assert.match(md, /\| 2:24 AM \| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| <\$0\.01 \|\n\| 2:26 AM \| Review · Fable 5\.2 \| 35 s \| \$1\.00 \|/);
  assert.match(md, /\*\*\$1\.00\*\*/);
  assert.doesNotMatch(md, /xychart/, "a plain run: no breakdown, no chart");
});

test("finish card: an Actions stage's dollars come from its usage artifact, its own run's on this repository's code only; a token that may not read artifacts, or a failed download, reads no record", async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const asked = [];
  let status = 200;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get("name"));
    const name = u.searchParams.get("name");
    const run = (id, head = 1) => ({ id, repository_id: 1, head_repository_id: head });
    // The stage's own run's, an expired one, another run's, a fork's run under the same name, and one naming no repository.
    const artifacts = [{ id: name.length, name, expired: false, workflow_run: run(44) }, { id: 9, name, expired: true, workflow_run: run(44) }, { id: 10, name, expired: false, workflow_run: run(46) }, { id: 11, name, expired: false, workflow_run: run(44, 2) }, { id: 12, name, expired: false, workflow_run: { id: 44 } }];
    return new Response(JSON.stringify(status === 200 ? { total_count: artifacts.length, artifacts } : { message: "Resource not accessible by integration" }), { status, headers: { "content-type": "application/json" } });
  };
  const repo = { owner: "acme", name: "app", full: "acme/app" };
  try {
    const want = [{ stage: "work", key: "44" }, { stage: "review", key: "44-2" }];
    const read = [];
    const recs = await objectiveRecords(repo, 3, { token: "t", want, download: async (a) => (read.push(a.id), { usd: 1 }) });
    assert.deepEqual(asked, ["pendulum-usage-3", "pendulum-usage-3-review"]);
    assert.deepEqual(recs.map((r) => r.artifact), ["pendulum-usage-3", "pendulum-usage-3-review"], "each record names its artifact");
    assert.deepEqual(read, [16, 23], "only the stage's own run's: never an expired one, another run's, a fork's or one naming no repository");
    asked.length = 0;
    assert.deepEqual(await objectiveRecords(repo, 3, { token: "t", want: [], download: async () => assert.fail("nothing to download") }), []);
    assert.deepEqual(asked, [], "no stage without a spend line: nothing is listed");
    const some = await objectiveRecords(repo, 3, { token: "t", want, download: async (a) => (a.name.endsWith("-review") ? Promise.reject(new Error("gh failed")) : {}) });
    assert.deepEqual(some.map((r) => r.artifact), ["pendulum-usage-3"], "a failed download is no record; the card goes on");
    status = 403;
    assert.deepEqual(await objectiveRecords(repo, 3, { token: "t", want, download: async () => assert.fail("nothing to download") }), []);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

/**
 * A fake GitHub holding closed Objectives: #3 merged (scratch #3's run, its stages' spend lines in their progress
 * comments; `labels3` its labels), #7 Blocked with a PR a person merged, #8 closed with its PR still open. Comments posted
 * are there on the next read. `failCard`: the status the card's POST answers with; `failBody`: the PR body PATCH's.
 * `extra3`: more comments on #3; `permissions`: each login's permission on the repository (none: a 404); `onTimeline3`,
 * called as #3's timeline is read.
 */
function fakeRepo({ failCard = 0, failOn = 3, failBody = 0, labels3 = ["pendulum:objective", "pendulum:in-review"], labels8 = ["pendulum:objective", "pendulum:in-review"], dropLabels = false, pr80 = {}, extra3 = [], permissions = {}, onTimeline3 = () => {} } = {}) {
  const issue = (number, labels) => ({ number, state: "closed", state_reason: "completed", closed_at: real.issue.closed_at, labels: labels.map((name) => ({ name })), body: "", user: { login: "kirkmarple-clockgrove", type: "User" } });
  const closed = [issue(3, labels3), issue(7, ["pendulum:objective", "pendulum:blocked"]), issue(8, labels8)];
  const comments = { 3: [...withSpend({ work: { usd: 0.35637 }, review: { usd: 0.163442 } }), ...extra3], 7: [], 8: [] };
  const prs = { 3: [{ ...real.pr, user: bot }], 7: [{ number: 70, merged_at: "2026-11-17T02:27:36Z", created_at: "2026-11-17T02:20:00Z" }], 8: [{ number: 80, node_id: "PR_80", state: "open", draft: false, merged_at: null, created_at: "2026-11-17T02:20:00Z", ...pr80 }] };
  const writes = [];
  const reads = [];
  let nextId = 100;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET") reads.push(`${p}${u.search}`);
    if (method !== "GET" && p !== "/graphql") writes.push(`${method} ${p}${init.body ? ` ${JSON.parse(init.body).body ?? ""}` : ""}`);
    if (method === "GET" && u.pathname === "/repos/acme/app") return json({ full_name: "acme/app", default_branch: "main", visibility: "public" });
    if (method === "GET" && p === "/rulesets") return json([]);
    if (method === "GET" && p === "/branches/main/protection") return json({ required_status_checks: { checks: [{ context: "test", app_id: 15368 }] } });
    if (method === "GET" && p === "/issues") return json(u.searchParams.get("state") === "closed" ? closed : []);
    if (method === "GET" && p === "/pulls" && u.searchParams.get("state") === "all") return json(prs[/pendulum\/(\d+)$/.exec(u.searchParams.get("head"))[1]] || []);
    if (method === "GET" && p === "/pulls" && u.searchParams.get("state") === "open") return json((prs[/pendulum\/(\d+)$/.exec(u.searchParams.get("head"))[1]] || []).filter((x) => x.state === "open"));
    if (method === "GET" && p === "/pulls/4") return json({ ...real.pr, user: bot });
    const one = /^\/pulls\/(70|80)$/.exec(p);
    if (method === "GET" && one) return json({ ...Object.values(prs).flat().find((x) => String(x.number) === one[1]), user: bot, head: { sha: "c".repeat(40), ref: "x" }, commits: 1, additions: 2, deletions: 0, changed_files: 1 });
    if (method === "GET" && /^\/pulls\/(70|80)\/(reviews|comments)$/.test(p)) return json([]);
    if (method === "GET" && p === "/issues/4/timeline") return json(real.prTimeline);
    if (method === "GET" && p === "/pulls/4/reviews") return json(real.reviews);
    if (method === "GET" && p === "/pulls/4/comments") return json(real.reviewComments);
    if (method === "GET" && p === `/commits/${real.pr.merge_commit_sha}/check-runs`) return json({ total_count: real.checks.length, check_runs: real.checks });
    if (method === "GET" && p === "/actions/artifacts") return json({ total_count: 0, artifacts: [] });
    if (method === "GET" && /^\/commits\/c+\/check-runs$/.test(p)) return json({ total_count: 0, check_runs: [] });
    if (method === "GET" && p === "/issues/3/timeline") return onTimeline3(), json(real.timeline);
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(p)) return json([]);
    if (method === "GET" && p.endsWith("/collaborators")) return json([{ login: "kirkmarple-clockgrove" }]);
    const perm = /^\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (method === "GET" && perm) return permissions[decodeURIComponent(perm[1])] ? json({ permission: permissions[decodeURIComponent(perm[1])] }) : json({ message: "Not Found" }, 404);
    if (method === "PATCH" && p === "/pulls/4" && failBody) return json({ message: "failed" }, failBody);
    const c = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (c && method === "GET") return json(comments[c[1]] ?? []);
    // `dropLabels`: a label's removal holds, so the next tick reads the issue without it.
    const dl = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(p);
    if (dl && method === "DELETE" && dropLabels) {
      const i = closed.find((x) => x.number === Number(dl[1]));
      if (i) i.labels = i.labels.filter((l) => l.name !== decodeURIComponent(dl[2]));
      return json({}, 200);
    }
    if (c && method === "POST" && failCard && JSON.parse(init.body).body?.startsWith(finishMarker(failOn))) return json({ message: "failed" }, failCard);
    if (c && method === "POST") {
      const posted = { id: (nextId += 1), user: bot, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), body: JSON.parse(init.body).body };
      (comments[c[1]] ??= []).push(posted);
      return json(posted, 201);
    }
    if (method === "PATCH" || method === "DELETE" || method === "POST") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, writes, reads };
}

/** One dispatcher tick over `fake`, with `env` (PENDULUM_LOCAL and the like) and the tick's clock `now`. */
async function tickOver(fake, { env = {}, now = new Date(Date.parse(real.issue.closed_at) + 3600_000) } = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  for (const k of ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL"]) delete process.env[k];
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  globalThis.fetch = fake.fetch;
  setSelf(SELF);
  try {
    return await dispatch({ repo: "acme/app", objectiveLabel: "pendulum:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t", now });
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("finish card: the dispatcher's Done pass posts it once when an Objective closes, merged or not (#589), before its label goes; a later tick posts none", async () => {
  const fake = fakeRepo();
  const first = await tickOver(fake);
  assert.deepEqual(first.finished, [3, 7, 8], "a card for every closed Objective Pendulum ran: merged, merged by a person while Blocked, closed with its PR open");
  assert.deepEqual(first.done, [3, 7, 8], "every closed Objective is still tidied");
  const three = fake.writes.filter((w) => w.includes("/issues/3/") || w.startsWith("PATCH /pulls/4"));
  const card = three.filter((w) => w.startsWith(`POST /issues/3/comments ${finishMarker(3)}\n`));
  assert.equal(card.length, 1, "one card");
  assert.match(card[0], /\n### ✅ Merged in 3 min 54 s · \$0\.52\n/, "its dollars from the stages' spend lines");
  assert.match(card[0], /got \*\*1 CI check\*\* green/, "the branch protection's required check");
  assert.ok(!fake.reads.some((r) => r.includes("name=pendulum-usage-3")), "every stage has a spend line: no artifact is read");
  const body = three.findIndex((w) => w.startsWith("PATCH /pulls/4 <!-- pendulum:3:finish-pr -->\n### ✅ Merged"));
  assert.ok(body >= 0 && body < three.indexOf(card[0]), "the PR body first, then the card");
  assert.ok(three.indexOf(card[0]) < three.findIndex((w) => w.startsWith("DELETE /issues/3/labels/")), "the card before the label goes");
  // #7's PR merged (a person merged it while it was Blocked): a merged card. #8 closed with its PR open: closed, not merged.
  assert.ok(fake.writes.some((w) => w.startsWith(`POST /issues/7/comments ${finishMarker(7)}\n`) && w.includes("\n### ✅ Merged ")));
  const closedCard = fake.writes.find((w) => w.startsWith(`POST /issues/8/comments ${finishMarker(8)}\n`));
  assert.match(closedCard, /\n<!-- pendulum:8:finish-end \{"end":"closed","at":"[^"]+"\} -->\n### ⏹️ Closed without merging after 7 min 39 s · unknown\nIssue #8 · PR #80 still open · closed at 2:27 AM UTC · plus 1 AI run of unknown cost\n/);
  assert.match(closedCard, /Pendulum opened PR #80 \(\*\*1 commit, \+2 −0 across 1 file\*\*\); the issue was closed before it merged\./);
  // Its summary says how it ended and names no merge, so no reader takes it for a merged Objective's.
  const { readSummary } = await import("../scripts/lib/finish-card.mjs");
  assert.match(closedCard, /<!-- pendulum:8:summary \{[^\n]*"merged":null[^\n]*"end":"closed"/);
  assert.equal(readSummary(closedCard.replace(/^POST \/issues\/8\/comments /, ""), 8), null);
  assert.doesNotMatch(closedCard, /What to do/, "a close needs no one to act");
  assert.ok(!fake.writes.some((w) => w.startsWith("PATCH /pulls/80 <!--")), "no finish block on a PR that did not merge");

  // A second tick (the label's removal lost, so #3 is tidied again): its card is there, so none is posted.
  const before = fake.writes.length;
  const second = await tickOver(fake);
  assert.deepEqual(second.finished, []);
  assert.ok(!fake.writes.slice(before).some((w) => w.includes(finishMarker(3)) || w.includes(finishMarker(8)) || w.startsWith("PATCH /pulls/4")), "posted once: a merge and a close are final");
});

test("finish card (#607): a read-only member's forged stage comment changes nothing on the card; a writer's stage is still a run of unknown cost", async () => {
  const cardOf = (fake) => fake.writes.find((w) => w.startsWith(`POST /issues/3/comments ${finishMarker(3)}\n`));
  const at = "2026-11-17T02:26:00Z";
  let nextId = 950;
  const stage = (login, association, key) => ({ id: (nextId += 1), user: { login, type: "User" }, author_association: association, created_at: at, updated_at: at, body: [`<!-- pendulum:3:progress:work:${key} -->`, "Pendulum work: started.", spendLine({ usd: 999, usdByBilling: { api: 999 }, billing: "api" })].join("\n") });
  const plain = fakeRepo();
  await tickOver(plain);
  // A member and a collaborator with read access alone: the permission read says so; neither counts.
  const forged = fakeRepo({ extra3: [stage("reader-607", "MEMBER", "local-f1"), stage("triage-607", "COLLABORATOR", "local-f22")], permissions: { "reader-607": "read", "triage-607": "triage" } });
  await tickOver(forged);
  assert.equal(cardOf(forged), cardOf(plain), "the same card, figure for figure");
  assert.ok(forged.reads.includes("/collaborators/reader-607/permission"), "the member's permission is read");
  // A writer's stage comment: a stage of unknown cost, never its $999.
  const writer = fakeRepo({ extra3: [stage("writer-607", "MEMBER", "local-w1")], permissions: { "writer-607": "write" } });
  await tickOver(writer);
  assert.match(cardOf(writer), /\n### ✅ Merged in 3 min 54 s · \$0\.52 \+ unknown\n/);
  assert.doesNotMatch(cardOf(writer), /999/);
  // The permission's window ending during the card's reads (another repository's writer list starts the list over): the
  // writer verified as the comments were read still counts.
  const rolled = fakeRepo({ extra3: [stage("writer2-607", "MEMBER", "local-w2")], permissions: { "writer2-607": "write" }, onTimeline3: () => setWriters("acme/other", []) });
  await tickOver(rolled);
  assert.match(cardOf(rolled), /\n### ✅ Merged in 3 min 54 s · \$0\.52 \+ unknown\n/);
});

test("finish card (#544): the summary marker carries the card's own figures, from the same finishData, and reads back as written", async () => {
  // Through the module's namespace, so the suite loads on a tree without the summary and this test alone fails there.
  const card = await import("../scripts/lib/finish-card.mjs");
  const work = real.comments.find((c) => c.body.startsWith("<!-- pendulum:3:progress:work:"));
  const key = /^<!-- pendulum:3:progress:(work:[A-Za-z0-9-]+) -->/.exec(work.body)[1];
  // The plain run; and one with a conflict rebase (churn), a sandbox booked after the merge, a sandbox stage with no
  // progress comment whose figures were not reported, and a review whose harness reported none.
  const rebase = comment(911, "2026-11-17T02:26:12Z", `${work.body.replace(/progress:work:\d+/, "progress:work:911")}\n${spendLine({ usd: 0.07, usdByBilling: { api: 0.07 } })}\n<!-- pendulum:rebase-cost {"usd":0.07,"conflict":true} -->`, "2026-11-17T02:26:15Z");
  const late = comment(901, "2026-11-17T03:00:00Z", `<!-- pendulum:3:vendor:${key} -->\nx\n${spendLine({ usd: 0.05, vendorUsd: 0.05 })}`);
  const blind = comment(903, "2026-11-17T02:26:30Z", `<!-- pendulum:3:vendor:review:def -->\nx\n${spendLine({ usd: 0, vendorUsd: null, usdUnknown: 1, usdUnknownWhy: ["sandbox"] })}`);
  const runs = [withSelf(() => data()), withSelf(() => data({ comments: [...withSpend({ review: { usd: 0, usdUnknown: 1, usdUnknownWhy: ["zeroed"] } }), rebase, late, blind], records: real.records.slice(0, 1) }))];
  for (const d of runs) {
    const body = card.finishCardBody(d);
    const [head, line, end, ...rest] = body.split("\n");
    assert.equal(head, finishMarker(3), "the card's own marker first, so one card per Objective still holds");
    assert.match(line, /^<!-- pendulum:3:summary \{[^\n<>]*\} -->$/, "one hidden line, nothing in it that closes the comment");
    assert.equal(end, `<!-- pendulum:3:finish-end {"end":"merged","at":"${d.merged}"} -->`, "how the run ended, for a later write");
    assert.equal(rest.join("\n"), renderFinishCard(d), "the card itself is unchanged under it");
    // It reads back exactly as written.
    const s = card.readSummary(body, 3);
    assert.deepEqual(s, card.finishSummary(d));
    // Every figure is the card's own: its totals, rows and breakdown, never worked out another way.
    const t = card.finishTotals(d);
    assert.deepEqual([s.wallMs, s.cost.usd, s.cost.unknown, s.cost.byBilling, s.cost.why], [t.wall, t.usd, t.unknown, t.byBilling, t.why]);
    assert.equal(s.cost.cents, Math.round(t.usd * 100));
    assert.ok(body.includes(`**${card.costText(s.cost.usd, s.cost.unknown)}`), "the total the card's table shows");
    assert.deepEqual(s.stages.map((x) => [x.kind, x.part, x.model, x.usd, x.unknown, x.byBilling, x.sandbox, x.churn]), d.stages.map((x) => [x.kind, x.part, x.model, x.usd, x.unknown, x.byBilling, x.sandbox, x.churn.map((c) => c.row)]));
    const b = card.spendBreakdown(d);
    assert.deepEqual(s.churn.map((r) => [r.row, r.stages, r.usd, r.cents, r.unknown]), b.churn.map((r) => [r.row, r.stages, r.usd, r.cents, r.unknown]));
    assert.deepEqual(s.asked.map((r) => [r.usd, r.cents, r.unknown]), b.asked.map((r) => [r.usd, r.cents, r.unknown]));
    assert.deepEqual([s.checks, s.commits, s.additions, s.deletions, s.files, s.prs, s.reviews], [d.checks, d.commits, d.additions, d.deletions, d.files, d.prs.map((p) => p.number), { count: d.reviews.count, findings: d.reviews.findings }]);
    assert.equal(s.v, card.SUMMARY_VERSION);
    assert.match(s.pendulum, /^\d+\.\d+\.\d+/);
  }
  // The richer run's figures: a churn row for the rebase, and every run of unknown cost with its reason.
  const rich = card.readSummary(card.finishCardBody(runs[1]), 3);
  assert.deepEqual(rich.churn.map((r) => [r.row, r.stages, r.usd]), [["rebase-conflict", 1, 0.07]]);
  assert.deepEqual(rich.stages.map((x) => [x.kind, x.why]), [["build", []], ["rebase", []], ["review", ["zeroed"]], ["review", ["unreported"]]]);
  assert.deepEqual([rich.sandbox.usd, rich.sandbox.unknown, rich.sandbox.why], [0.05, 1, ["sandbox"]]);
  assert.deepEqual(rich.cost.why, ["sandbox", "unreported", "zeroed"]);
  assert.deepEqual(rich.stageCounts, { work: 1, rebase: 1, review: 2 });

  // A stage's passes by kind, model minutes, tokens and release are its ledger's, through the report's own
  // stagePassFigures: from its usage record here, from the ledger line beside its spend line on newer stages.
  const { stagePassFigures } = await import("../scripts/lib/pass-figures.mjs");
  const pass = (label, usd, started, ended) => ({ label, usd, billing: "api", usdByBilling: { api: usd }, started, ended, tokens: { input: 1000, output: 10, cached: 500, written: 200 } });
  const ledgers = [[pass("work-1", 0.3, "2026-11-17T02:24:40Z", "2026-11-17T02:25:10Z"), pass("answer", 0.05637, "2026-11-17T02:25:20Z", "2026-11-17T02:25:50Z")], [pass("review", 0.163442, "2026-11-17T02:26:21Z", "2026-11-17T02:26:51Z")]];
  const withLedger = withSelf(() => data({ records: real.records.map((r, i) => ({ ...r, ledger: ledgers[i], ran: { pendulum: "0.10.1" }, tokens: { input: 1000 * ledgers[i].length, output: 10, cached: 0, written: 0 } })) }));
  const sum = card.readSummary(card.finishCardBody(withLedger), 3);
  assert.deepEqual(sum, card.finishSummary(withLedger));
  assert.deepEqual(sum.stages.map((x) => x.passes), ledgers.map(stagePassFigures));
  assert.deepEqual(sum.stages.map((x) => x.passes.map((k) => [k.kind, k.passes, k.minutes])), [[["work", 1, 0.5], ["answer", 1, 0.5]], [["review", 1, 0.5]]]);
  assert.deepEqual(sum.stages.map((x) => [x.version, x.tokens.input]), [["0.10.1", 2000], ["0.10.1", 1000]]);
  assert.deepEqual(rich.stages.map((x) => x.passes), [null, null, null, null], "no ledger, no passes: a reader reads the stages");
  assert.deepEqual([rich.passes, rich.modelMinutes], [null, null], "an Objective's passes only when every stage's are known");
  assert.deepEqual([sum.passes, sum.modelMinutes], [{ total: 3, answer: 1, fix: 0 }, 1.5]);
  // A harness pass with no times: its passes count, its model minutes are not known.
  const untimed = withSelf(() => data({ records: real.records.map((r, i) => ({ ...r, ledger: i ? [{ ...ledgers[1][0], started: null }] : ledgers[0] })) }));
  assert.deepEqual([card.finishSummary(untimed).passes.total, card.finishSummary(untimed).modelMinutes], [3, null]);

  // A summary over its bound is written with no stage's passes: a reader then reads the stages.
  const many = Array.from({ length: 200 }, (_, i) => pass(`k${i}x`, 0.001, "2026-11-17T02:24:40Z", "2026-11-17T02:25:10Z"));
  const huge = withSelf(() => data({ records: real.records.map((r) => ({ ...r, ledger: many })) }));
  const hugeBody = card.finishCardBody(huge);
  assert.ok(hugeBody.split("\n")[1].length <= card.SUMMARY_MAX);
  assert.deepEqual(card.readSummary(hugeBody, 3).stages.map((x) => x.passes), [null, null]);
  // Still over it with no stage's passes, or a body over GitHub's 65,536: the card is posted without a summary.
  const crowd = Array.from({ length: 200 }, (_, i) => comment(2000 + i, `2026-11-17T02:25:${String(i % 60).padStart(2, "0")}Z`, `${work.body.replace(/progress:work:\d+/, `progress:work:${7000 + i}`)}\n${spendLine({ usd: 0.01, usdByBilling: { api: 0.01 } })}`));
  const crowded = withSelf(() => data({ comments: [...real.comments, ...crowd] }));
  assert.ok(card.summaryMarker(crowded) === null, "no summary line fits");
  const crowdedBody = card.finishCardBody(crowded);
  assert.equal(crowdedBody, `${finishMarker(3)}\n${card.finishEndMarker(crowded)}\n${renderFinishCard(crowded)}`);
  // 200 stages: like stages fold into one row each, the per-stage list in Run details; the timeline is left out.
  assert.match(crowdedBody, /\| Work ×200 · Opus 5\.5 \| [^|]+ \| \$2\.00 \|/);
  assert.match(crowdedBody, /^Timeline chart left out: 202 stages; the table has every figure\.$/m);
  assert.match(crowdedBody, /\*\*Each stage\*\*\n- 2:24 AM Plan \+ build · Opus 5\.5: 1 min 21 s, /);
  assert.equal(card.readSummary(crowdedBody, 3), null);
  // A marker anywhere but the line under the finish marker reads as none.
  const plainBody = card.finishCardBody(runs[0]);
  const [first, second, ...after] = plainBody.split("\n");
  assert.equal(card.readSummary([first, "", second, ...after].join("\n"), 3), null);
  assert.equal(card.readSummary(second, 3), null);

  // A stage with a ledger line takes its passes from it, the source the report reads, even with its usage record read:
  // the record's sub-second times give the same passes but not the same minutes.
  const lined = withSpend({ work: { usd: 0.35637, usdByBilling: { api: 0.35637 } }, review: { usd: 0.163442, usdByBilling: { api: 0.163442 } } });
  const ledgerLine = (i) => `<!-- pendulum:ledger ${JSON.stringify({ v: "0.10.1", p: ledgers[i].map((e) => ({ l: e.label, b: "api", u: e.usd, t: [Date.parse(e.started) / 1000, Date.parse(e.ended) / 1000], n: [1000, 10, 500, 200] })) })} -->`;
  const withLines = lined.map((c) => (/^<!-- pendulum:3:progress:work:/.test(c.body) ? { ...c, body: `${c.body}\n${ledgerLine(0)}` } : /^<!-- pendulum:3:progress:review:/.test(c.body) ? { ...c, body: `${c.body}\n${ledgerLine(1)}` } : c));
  const subSecond = real.records.map((r, i) => ({ ...r, ledger: ledgers[i].map((e) => ({ ...e, ended: e.ended.replace("Z", ".750Z") })) }));
  const both = withSelf(() => data({ comments: withLines, records: subSecond }));
  assert.deepEqual(card.finishSummary(both).stages.map((x) => x.passes.map((k) => k.minutes)), [[0.5, 0.5], [0.5]], "the ledger line's seconds, not the record's");

  // A sandbox whose dollars are known but whose usage the vendor did not report keeps its run of unknown cost (as the
  // cost join counts it), on the card and in the summary.
  const keyOf = (stage) => /^<!-- pendulum:3:progress:((?:work|review):[A-Za-z0-9-]+) -->/.exec(real.comments.find((c) => c.body.startsWith(`<!-- pendulum:3:progress:${stage}:`)).body)[1];
  const partial = comment(904, "2026-11-17T02:26:40Z", `<!-- pendulum:3:vendor:${keyOf("review")} -->\nx\n${spendLine({ usd: 0.02, vendorUsd: 0.02, usdUnknown: 1, usdUnknownWhy: ["sandbox"] })}`);
  const sandboxed = withSelf(() => data({ comments: [...real.comments, partial] }));
  assert.deepEqual(sandboxed.sandbox, { usd: 0.02, unknown: 1 });
  assert.match(renderFinishCard(sandboxed), / · plus 1 AI run of unknown cost$/m);
  assert.deepEqual(card.finishSummary(sandboxed).sandbox, { usd: 0.02, cents: 2, unknown: 1, why: ["sandbox"], foreign: [] });
  // A teammate's vendor comment of one of Pendulum's stages is that stage's, no run of its own; one of no stage is a
  // run of unknown cost of its stage's kind, one each. The teammate is a writer (on the writer list); a member who is not
  // counts nothing.
  const teammate = { login: "teammate", type: "User" };
  const theirs = (id, at, key) => ({ ...comment(id, at, `<!-- pendulum:3:vendor:${key} -->\nx\n${spendLine({ usd: 0.5, vendorUsd: 0.5 })}`), user: teammate, author_association: "MEMBER" });
  const theirComments = [...real.comments, theirs(905, "2026-11-17T02:26:41Z", keyOf("work")), theirs(906, "2026-11-17T02:26:42Z", "review:zz9"), theirs(907, "2026-11-17T02:26:43Z", "work:zz8")];
  assert.equal(withSelf(() => data({ comments: theirComments })).sandbox, null, "a MEMBER association alone is no writer's");
  setWriters("clockgrove/pendulum-scratch", ["teammate"]);
  try {
    const foreign = withSelf(() => data({ comments: theirComments }));
    assert.deepEqual(foreign.sandbox, { usd: 0, unknown: 2 });
    assert.deepEqual(card.finishSummary(foreign).sandbox.foreign, ["review", "work"]);
  } finally {
    setWriters("clockgrove/pendulum-scratch", []);
  }

  // Another issue's, another version's or a broken one reads as none.
  const body = card.finishCardBody(runs[0]);
  assert.equal(card.readSummary(body, 4), null);
  assert.equal(card.readSummary(body.replace('"v":1', '"v":2'), 3), null);
  assert.equal(card.readSummary(body.replace(/"usd":0\.35637/, '"usd":"0.35637"'), 3), null);
  assert.equal(card.readSummary(body.replace(/"kind":"build"/, '"kind":"magic"'), 3), null);
});

test("finish card (#567): an issue labelled before the rename to Pendulum has no wall clock: the card says so, never a figure that starts too late", async () => {
  const { finishSummary, readSummary, summaryMarker } = await import("../scripts/lib/finish-card.mjs");
  const plain = withSelf(() => data());
  // GitHub keeps a renamed label's old name on its events: the Objective's first label, a day before the current one.
  for (const name of [`${PREVIOUS_NAME}:objective`, `${PREVIOUS_NAME}:running`]) {
    const timeline = [{ event: "labeled", label: { name }, actor: { login: "kirkmarple-clockgrove" }, created_at: "2026-11-16T02:00:00Z" }, ...real.timeline];
    const d = withSelf(() => data({ timeline }));
    const sum = finishSummary(d);
    assert.deepEqual([sum.wallMs, sum.labelledWallMs, sum.clockWhy, finishSummary(plain).clockWhy], [null, null, "renamed", null], name);
    // The summary records why (#587), so a reader takes it from the card; the card read back keeps it.
    assert.equal(readSummary(`${finishMarker(3)}\n${summaryMarker(d)}`, 3)?.clockWhy, "renamed", name);
    // Nothing else is read from that event: the clock's start and every other figure are as without it.
    const rest = (x) => ({ ...x, pendulum: null, wallMs: null, labelledWallMs: null, clockWhy: null });
    assert.deepEqual(rest(sum), rest(finishSummary(plain)));
    const md = renderFinishCard(d);
    assert.match(md, /^### ✅ Merged · \$[^\n]*\n[^\n]* · Its wall clock is not known: it was labelled before the rename to Pendulum$/m);
    assert.match(md, /\| \| \*\*Total\*\* \| \*\*not known\*\* \|/);
    assert.doesNotMatch(md, /Merged in /);
  }
  // A current label alone, or a label of another name that starts with it: the wall clock as before.
  const other = withSelf(() => data({ timeline: [{ event: "labeled", label: { name: `${PREVIOUS_NAME}:objectives` }, created_at: "2026-11-16T02:00:00Z" }, ...real.timeline] }));
  assert.equal(finishSummary(other).wallMs, finishSummary(plain).wallMs);
  assert.ok(finishSummary(plain).wallMs > 0 && finishSummary(plain).labelledWallMs > 0);
});
