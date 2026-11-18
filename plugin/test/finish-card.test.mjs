import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETRY } from "../scripts/lib/github.mjs";
import { setSelf, setWriters } from "../scripts/lib/logic.mjs";
import { PREVIOUS_NAME } from "../scripts/lib/local.mjs";
import { badge, centsOf, finishData, finishMarker, gateChecks, objectiveRecords, renderFinishCard, withFinishBlock } from "../scripts/lib/finish-card.mjs";

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
  assert.ok(md.startsWith('<p align="center"><img src="https://raw.githubusercontent.com/clockgrove/pendulum/main/assets/brand/pendulum/web/mark-240.png" width="96" alt="Pendulum"></p>'));
  assert.match(md, /^<h3 align="center">Merged in 3 min 54 s for \$0\.52\.<\/h3>$/m);
  assert.doesNotMatch(md, /^#{1,2} |<h[12]\b/m, "an h3 headline, no h1 or h2");
  assert.match(md, /issue #3 → <a href="https:\/\/github\.com\/clockgrove\/pendulum-scratch\/pull\/4">PR #4<\/a> · landed through your merge queue at 02:27 UTC/);
  assert.ok(md.includes(badge("status", "merged", "4a7a3a")));
  assert.ok(md.includes('<img alt="wall clock: 3m 54s" src="https://img.shields.io/badge/wall_clock-3m_54s-7a4a24?style=for-the-badge">'));
  assert.ok(md.includes('<img alt="cost: $0.52" src="https://img.shields.io/badge/cost-%240.52-c9822e?style=for-the-badge">'));
  assert.doesNotMatch(md, /human/i, "no human-action badge: the scorer's count is not computed at merge time");
  assert.match(md, /^You wrote the issue and added the label\. Pendulum took it from there: it planned the work, opened PR #4 \(\*\*2 commits, \+20 −1 across 3 files\*\*\), got \*\*1 check\*\* green, had the change reviewed \(no findings\), and it merged through your merge queue\.$/m);
  assert.match(md, /```mermaid\n%%\{init: \{"theme":"base"[^\n]*\}%%\ngantt\n/);
  assert.match(md, /section Build\n {4}1m 21s :active, 2026-11-17T02:24:34, 2026-11-17T02:25:55\n {4}section Review\n {4}35s :active, 2026-11-17T02:26:20, 2026-11-17T02:26:55\n {4}section Queue\n {4}44s :active, 2026-11-17T02:26:52, 2026-11-17T02:27:36\n```/);
  assert.match(md, /\| Stage \| Time \| Cost \|\n\| --- \| ---: \| ---: \|\n\| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|\n\| Review · Fable 5\.2 \| 35 s \| \$0\.16 \|\n\| Merge queue · your CI \| 44 s \| — \|\n\| \*\*Total\*\* \| \*\*3 min 54 s\*\* \| \*\*\$0\.52\*\* \|/);
  assert.match(md, /pie showData\n {4}"Plan \+ build" : 0\.36\n {4}"Review" : 0\.16\n```/);
  // No billing recorded: the card says so rather than call it billed or API-equivalent.
  assert.match(md, /<sub>These are the costs Pendulum recorded for this run\. Pendulum did not record how these dollars were billed\./);
  assert.match(md, /<details><summary>Full run log<\/summary>\n\n- 02:23:42 labelled `pendulum:objective`: the clock starts\n- 02:24:34 plan \+ build stage started \(claude-opus-5-5\)\n/);
  assert.match(md, /- 02:27:36 PR #4 merged, 1 check green\n\n<\/details>$/);

  // Someone else filed the issue: each is named, and a PR Pendulum did not open is described, not claimed.
  const other = renderFinishCard(withSelf(() => data({ issue: { ...real.issue, user: { login: "filer" } }, pulls: pulls({ pr: { ...real.pr, user: { login: "someone" } } }) })));
  assert.match(other, /^\*\*filer\*\* wrote the issue and \*\*kirkmarple-clockgrove\*\* added the label\. Pendulum took it from there: it planned the work, got \*\*1 check\*\* green, had the change reviewed \(no findings\), and it merged through your merge queue\. PR #4 has \*\*2 commits, \+20 −1 across 3 files\*\*\.$/m);
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
    assert.match(md, /<h3 align="center">Merged in 3 min 54 s for \$0\.36 plus spend that was not reported\.<\/h3>/);
    assert.match(md, /\| Review \| 35 s \| unknown \|/, "the stage shows, its dollars never");
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
  assert.match(md, /<h3 align="center">Merged in 3 min 54 s; its cost is unknown\.<\/h3>/);
  assert.doesNotMatch(md, /\$0\.00/);
  assert.match(md, /\| Pendulum's stages, no record found \| — \| unknown \|/);
  assert.match(md, /Pendulum found no record of this run's stages, so its cost shows as unknown, not as a number\./);
});

test("finish card: after a route switch, the other route's App stages are runs of unknown cost even with no App id to match them by", async () => {
  const { pendulumOwn, throughApp } = await import("../scripts/lib/finish-card.mjs");
  const APP = { id: 5778155, slug: "clockgrove-pendulum" };
  assert.ok(throughApp({ user: bot, performed_via_github_app: APP }));
  assert.ok(!throughApp({ user: { login: "github-actions[bot]", type: "Bot" }, performed_via_github_app: { id: 15368, slug: "github-actions" } }), "GitHub Actions is no App route");
  assert.ok(!throughApp({ user: { login: "someone", type: "User" }, performed_via_github_app: APP }), "the author must be the App's own bot");
  // The Action's App built it; the person's local loop (no PENDULUM_LOCAL_APP_ID) ran the review and posts the card.
  setWriters("clockgrove/pendulum-scratch", ["dev"]);
  setSelf("dev");
  try {
    const comments = withSpend({ review: { usd: 0.163442 } }).map((c) => (c.body.startsWith("<!-- pendulum:3:progress:review:") ? { ...c, user: { login: "dev", type: "User" } } : { ...c, performed_via_github_app: APP }));
    const d = finishData({ repo: "clockgrove/pendulum-scratch", issue: real.issue, timeline: real.timeline, comments, pulls: pulls(), checks: real.checks, records: tagged(real.records, comments), mine: pendulumOwn(null) });
    assert.deepEqual(d.stages.map((s) => [s.kind, s.usd, s.unknown]), [["build", null, 1], ["review", 0.163442, 0]]);
    const md = renderFinishCard(d);
    assert.match(md, /<h3 align="center">Merged in 3 min 54 s for \$0\.16 plus spend that was not reported\.<\/h3>/);
    assert.match(md, /\*\*\$0\.16 \+ unknown\*\*/);
    assert.doesNotMatch(md, /\$0\.36/, "the App's figures are never read from another route");
    assert.doesNotMatch(md, /for \$0\.16\.<\/h3>|\*\*\$0\.16\*\*/, "no bare $0.16 total");
    assert.equal(d.planned, false, "its plan marker is not this route's to trust");
  } finally {
    setSelf(null);
    setWriters("clockgrove/pendulum-scratch", []);
  }
});

test("finish card: a Copilot stage with a spend line takes its model from its usage record, its dollars from the line (#539)", () => {
  // Copilot's default model: its harness line and progress line name none; the run's record names it.
  const copilot = withSpend({ work: { usd: 0.4 }, review: { usd: 0.2 } }).map((c) => ({ ...c, body: c.body.replace(/^<!-- pendulum:harness \{[^\n]*\} -->$/m, '<!-- pendulum:harness {"harness":"copilot","model":null,"models":{"worker":null,"subagent":null,"reviewer":null},"labels":[]} -->').replace("harness claude (claude-opus-5-5) attempt 1", "harness copilot attempt 1") }));
  const records = real.records.map((r) => ({ ...r, harness: "copilot", model: "claude-sonnet-5.5" }));
  const d = withSelf(() => data({ comments: copilot, records }));
  assert.deepEqual(d.stages.map((s) => [s.kind, s.model, s.usd, s.unknown]), [["build", "claude-sonnet-5.5", 0.4, 0], ["review", "claude-sonnet-5.5", 0.2, 0]]);
  const md = renderFinishCard(d);
  assert.match(md, /\| Plan \+ build · claude-sonnet-5\.5 \| 1 min 21 s \| \$0\.40 \|\n\| Review · claude-sonnet-5\.5 \| 35 s \| \$0\.20 \|/);
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

test("finish card: a record of a stage that ran no harness pass is a known $0, not unknown (S4)", () => {
  const records = [{ ...real.records[0], usd: null, runs: 0, noRun: true }, real.records[1]];
  const d = withSelf(() => data({ records }));
  assert.deepEqual(d.stages.map((s) => [s.usd, s.unknown]), [[0, 0], [0.163442, 0]]);
  assert.match(renderFinishCard(d), /<h3 align="center">Merged in 3 min 54 s for \$0\.16\.<\/h3>/);
});

test("finish card: what the dollars are comes from #508's usdByBilling, on records, spend lines and vendor comments; billing not recorded is no billing (B4)", () => {
  const records = real.records.map((r) => ({ ...r, usdByBilling: { subscription: r.usd } }));
  const md = renderFinishCard(withSelf(() => data({ records })));
  assert.ok(md.includes('<h3 align="center">Merged in 3 min 54 s for $0.52 API-equivalent.</h3>'));
  assert.ok(md.includes('<img alt="API-equivalent: $0.52"'), "the badge says what the dollars are");
  assert.ok(md.includes("| Stage | Time | Cost (API-equivalent) |"), "one kind: the column says it once");
  assert.match(md, /\| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|/);
  assert.match(md, /An API-equivalent figure is what the usage would cost at API list prices, on your subscription; it is not billed\./);
  assert.doesNotMatch(md, /alt="cost:/);

  // The same from local stages' spend lines; billed API spend reads as plain dollars.
  const local = renderFinishCard(withSelf(() => data({ comments: withSpend({ work: { usd: 0.35637, usdByBilling: { subscription: 0.35637 } }, review: { usd: 0.163442, usdByBilling: { subscription: 0.163442 } } }), records: [] })));
  assert.match(local, /for \$0\.52 API-equivalent\.<\/h3>/);
  const api = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, usdByBilling: { api: r.usd } })) })));
  assert.match(api, /for \$0\.52\.<\/h3>/);
  assert.match(api, /They are billed spend on your API key or AI Gateway key\./);
  // A mix: the headline says which part is what; each cell says its own.
  const mixed = renderFinishCard(withSelf(() => data({ records: [{ ...real.records[0], usdByBilling: { api: 0.35637 } }, { ...real.records[1], usdByBilling: { subscription: 0.163442 } }] })));
  assert.match(mixed, /for \$0\.52 \(part API-equivalent\)\.<\/h3>/);
  assert.match(mixed, /alt="cost: \$0\.52"/);
  assert.match(mixed, /\| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.36 \|\n\| Review · Fable 5\.2 \| 35 s \| \$0\.16 API-equivalent \|/);
  // Copilot AI credits are billed to the seat: named, never API-equivalent.
  const credits = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, usdByBilling: { credits: r.usd } })) })));
  assert.match(credits, /for \$0\.52 in Copilot AI credits\.<\/h3>/);
  assert.ok(credits.includes('<img alt="Copilot AI credits: $0.52"'));
  assert.doesNotMatch(credits, /API-equivalent/);
  // #508's `unknown`: billing not recorded. It is no kind of billing: no badge label, no API-equivalent words.
  const unrecorded = renderFinishCard(withSelf(() => data({ records: real.records.map((r) => ({ ...r, usdByBilling: { unknown: r.usd } })) })));
  assert.match(unrecorded, /for \$0\.52 \(billing not recorded\)\.<\/h3>/);
  assert.ok(unrecorded.includes('<img alt="cost: $0.52"'));
  assert.ok(unrecorded.includes("| Stage | Time | Cost (billing not recorded) |"));
  assert.match(unrecorded, /Pendulum did not record how these dollars were billed\./, "no recorded kind: not 'some'");
  assert.doesNotMatch(unrecorded, /For some of these dollars/);
  assert.doesNotMatch(unrecorded, /API-equivalent/);
  const half = renderFinishCard(withSelf(() => data({ records: [{ ...real.records[0], usdByBilling: { subscription: 0.35637 } }, { ...real.records[1], usdByBilling: { unknown: 0.163442 } }] })));
  assert.match(half, /for \$0\.52 \(part API-equivalent, part billing not recorded\)\.<\/h3>/);
  assert.match(half, /\| Review · Fable 5\.2 \| 35 s \| \$0\.16 \(billing not recorded\) \|/);
  assert.match(half, /For some of these dollars Pendulum did not record how they were billed\./, "beside a recorded kind: 'some'");
});

test("finish card: a sandbox stage's vendor comment counts whenever it was written; one with no progress comment is a stage of its own, its unknowns kept (B2, S8)", () => {
  const work = real.comments.find((c) => c.body.startsWith("<!-- pendulum:3:progress:work:"));
  const key = /^<!-- pendulum:3:progress:(work:[A-Za-z0-9-]+) -->/.exec(work.body)[1];
  // Booked after the merge, for an in-run stage: counted by its key.
  const late = comment(901, "2026-11-17T03:00:00Z", `<!-- pendulum:3:vendor:${key} -->\nPendulum's sandbox cost for this stage:\nx\n${spendLine({ usd: 0.05, vendorUsd: 0.05 })}`);
  const d = withSelf(() => data({ comments: [...real.comments, late] }));
  assert.deepEqual(d.sandbox, { usd: 0.05, unknown: 0 });
  assert.match(renderFinishCard(d), /\| Cloud sandbox \| — \| \$0\.05 \|/);
  assert.match(renderFinishCard(d), /"Cloud sandbox" : 0\.05/);

  // A stage that wrote no progress comment: its model dollars and billing from the vendor comment.
  const alone = comment(902, "2026-11-17T02:26:30Z", `<!-- pendulum:3:vendor:review:abc -->\nx\n${spendLine({ usd: 0.3, modelUsd: 0.2, vendorUsd: 0.1, usdByBilling: { subscription: 0.2 } })}`);
  const two = withSelf(() => data({ comments: [...real.comments, alone] }));
  assert.deepEqual(two.stages.filter((s) => !s.start).map((s) => [s.kind, s.usd, s.unknown, s.byBilling]), [["review", 0.2, 0, { subscription: 0.2 }]]);
  // Neither the model's nor the vendor's figure reported: two runs of unknown cost, never fewer, and no chart.
  const blind = comment(903, "2026-11-17T02:26:30Z", `<!-- pendulum:3:vendor:review:def -->\nx\n${spendLine({ usd: 0, vendorUsd: null, usdUnknown: 1, usdUnknownWhy: ["sandbox"] })}`);
  const b = withSelf(() => data({ comments: [...real.comments, blind] }));
  const vendorOnly = b.stages.find((s) => !s.start);
  assert.deepEqual([vendorOnly.usd, vendorOnly.unknown, b.sandbox.unknown], [null, 1, 1]);
  const md = renderFinishCard(b);
  assert.match(md, /plus spend that was not reported/);
  assert.match(md, /2 runs have no reported cost/);
  assert.doesNotMatch(md, /pie showData/);
});

test("finish card: a stage is named only by what its records say (S5)", () => {
  const work = real.comments.find((c) => c.body.startsWith("<!-- pendulum:3:progress:work:"));
  const again = comment(910, "2026-11-17T02:26:00Z", work.body.replace(/progress:work:\d+/, "progress:work:910"), "2026-11-17T02:26:10Z");
  const rebase = comment(911, "2026-11-17T02:26:12Z", `${work.body.replace(/progress:work:\d+/, "progress:work:911")}\n<!-- pendulum:rebase-cost {"usd":0,"conflict":false} -->`, "2026-11-17T02:26:15Z");
  const d = withSelf(() => data({ comments: [...real.comments, again, rebase] }));
  assert.deepEqual(d.stages.map((s) => s.kind), ["build", "work", "rebase", "review"], "a later work stage is work, not a fix");
  assert.match(renderFinishCard(d), /section Work\n {4}10s :active/);

  // A sandbox work stage that wrote only its vendor comment, before the build's progress comment: it is the build.
  const early = comment(912, "2026-11-17T02:24:00Z", `<!-- pendulum:3:vendor:work:zz -->\nx\n${spendLine({ usd: 0.2, modelUsd: 0.1, vendorUsd: 0.1 })}`);
  assert.deepEqual(withSelf(() => data({ comments: [...real.comments, early] })).stages.map((s) => s.kind), ["build", "work", "review"], "named in time order across both kinds");
  // A split Objective: the first work stage after part 1 merged is part 2's.
  const part1 = { ...real.pr, number: 2, merged_at: "2026-11-17T02:25:58Z", created_at: "2026-11-17T02:25:00Z", html_url: "https://github.com/clockgrove/pendulum-scratch/pull/2" };
  const split = withSelf(() => data({ comments: [...real.comments, again], pulls: [{ pr: part1, timeline: [], reviews: [], reviewComments: [] }, ...pulls()] }));
  assert.deepEqual(split.stages.map((s) => [s.kind, s.part]), [["build", 1], ["part", 2], ["review", 2]]);
  const md = renderFinishCard(split);
  assert.match(md, /\| Part 2 · Opus 5\.5 \|/);
  assert.match(md, /opened PRs #2, #4 \(\*\*4 commits, \+40 −2 across 6 files\*\*\), got the last part's \*\*1 check\*\* green/);
});

test("finish card: the checks that gated the merge are the latest attempt of each, completed by the merge, and the required ones when there are (S3)", () => {
  const at = (s) => `2026-11-17T02:2${s}Z`;
  const run = (id, name, conclusion, done, app = 15368) => ({ id, name, status: "completed", conclusion, completed_at: at(done), app: { id: app } });
  const checks = [run(1, "test", "failure", "6:00"), run(2, "test", "success", "7:00"), run(3, "lint", "success", "7:10"), run(4, "lint", "success", "7:20", 99), run(5, "deploy", "success", "8:00"), run(6, "docs", "failure", "7:05")];
  assert.deepEqual(gateChecks(checks, at("7:36")), { passed: 3, failed: 1, required: false }, "test's retry counts once, green; deploy finished after the merge");
  assert.deepEqual(gateChecks(checks, at("7:36"), [{ name: "test", app: 15368 }, { name: "lint", app: 15368 }]), { passed: 2, failed: 0, required: true }, "the required checks only, from their own app");
  assert.equal(gateChecks([run(1, "test", "skipped", "7:00")], at("7:36")), null, "none green: no checks claim");
  const md = renderFinishCard(withSelf(() => data({ checks, required: [{ name: "test", app: 15368 }] })));
  assert.match(md, /got \*\*1 required check\*\* green/);
  const red = renderFinishCard(withSelf(() => data({ checks })));
  assert.match(red, /got \*\*3 checks\*\* green \(1 red\)/);
});

test("finish card: the rows' and the chart's cents add up to the total's", () => {
  assert.deepEqual(centsOf([0.334, 0.333, 0.333]), [34, 33, 33]);
  assert.deepEqual(centsOf([0.004, 0.996, null]), [0, 100, null]);
  const records = [{ ...real.records[0], usd: 0.004 }, { ...real.records[1], usd: 0.996 }];
  const md = renderFinishCard(withSelf(() => data({ records })));
  assert.match(md, /\| Plan \+ build · Opus 5\.5 \| 1 min 21 s \| \$0\.00 \|\n\| Review · Fable 5\.2 \| 35 s \| \$1\.00 \|/);
  assert.match(md, /\*\*\$1\.00\*\*/);
  assert.doesNotMatch(md, /pie showData/, "one slice with a cent to show: no chart");
});

test("finish card: a merge queue drop is a drop, and the queue's own removal a second before the merge is the merge", () => {
  const tl = [
    { event: "added_to_merge_queue", created_at: "2026-11-17T02:26:00Z" },
    { event: "removed_from_merge_queue", created_at: "2026-11-17T02:26:20Z" },
    { event: "added_to_merge_queue", created_at: "2026-11-17T02:26:52Z" },
    { event: "removed_from_merge_queue", created_at: "2026-11-17T02:27:35Z" },
  ];
  const d = withSelf(() => data({ pulls: pulls({ timeline: tl }) }));
  assert.deepEqual(d.queue, [
    { start: "2026-11-17T02:26:00Z", end: "2026-11-17T02:26:20Z", merged: false },
    { start: "2026-11-17T02:26:52Z", end: "2026-11-17T02:27:36Z", merged: true },
  ]);
  assert.match(renderFinishCard(d), /section Dropped/);
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
 */
function fakeRepo({ failCard = 0, failBody = 0, labels3 = ["pendulum:objective", "pendulum:in-review"], labels8 = ["pendulum:objective", "pendulum:in-review"], dropLabels = false } = {}) {
  const issue = (number, labels) => ({ number, state: "closed", state_reason: "completed", closed_at: real.issue.closed_at, labels: labels.map((name) => ({ name })), body: "", user: { login: "kirkmarple-clockgrove", type: "User" } });
  const closed = [issue(3, labels3), issue(7, ["pendulum:objective", "pendulum:blocked"]), issue(8, labels8)];
  const comments = { 3: withSpend({ work: { usd: 0.35637 }, review: { usd: 0.163442 } }), 7: [], 8: [] };
  const prs = { 3: [{ ...real.pr, user: bot }], 7: [{ number: 70, merged_at: "2026-11-17T02:27:36Z", created_at: "2026-11-17T02:20:00Z" }], 8: [{ number: 80, node_id: "PR_80", state: "open", draft: false, merged_at: null, created_at: "2026-11-17T02:20:00Z" }] };
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
    if (method === "GET" && p === "/issues/4/timeline") return json(real.prTimeline);
    if (method === "GET" && p === "/pulls/4/reviews") return json(real.reviews);
    if (method === "GET" && p === "/pulls/4/comments") return json(real.reviewComments);
    if (method === "GET" && p === `/commits/${real.pr.merge_commit_sha}/check-runs`) return json({ total_count: real.checks.length, check_runs: real.checks });
    if (method === "GET" && p === "/actions/artifacts") return json({ total_count: 0, artifacts: [] });
    if (method === "GET" && p === "/issues/3/timeline") return json(real.timeline);
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(p)) return json([]);
    if (method === "GET" && p.endsWith("/collaborators")) return json([{ login: "kirkmarple-clockgrove" }]);
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
    if (c && method === "POST" && failCard && JSON.parse(init.body).body?.startsWith(finishMarker(3))) return json({ message: "failed" }, failCard);
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

test("finish card: the dispatcher's Done pass posts it once when an Objective merges, before its label goes; a later tick posts none; none on a Block or an unmerged close", async () => {
  const fake = fakeRepo();
  const first = await tickOver(fake);
  assert.deepEqual(first.finished, [3]);
  assert.deepEqual(first.done, [3, 7, 8], "every closed Objective is still tidied");
  const three = fake.writes.filter((w) => w.includes("/issues/3/") || w.startsWith("PATCH /pulls/4"));
  const card = three.filter((w) => w.startsWith(`POST /issues/3/comments ${finishMarker(3)}\n`));
  assert.equal(card.length, 1, "one card");
  assert.match(card[0], /<h3 align="center">Merged in 3 min 54 s for \$0\.52\.<\/h3>/, "its dollars from the stages' spend lines");
  assert.match(card[0], /got \*\*1 required check\*\* green/, "the branch protection's required check");
  assert.ok(!fake.reads.some((r) => r.includes("name=pendulum-usage-3")), "every stage has a spend line: no artifact is read");
  const body = three.findIndex((w) => w.startsWith("PATCH /pulls/4 <!-- pendulum:3:finish-pr -->\n<h3"));
  assert.ok(body >= 0 && body < three.indexOf(card[0]), "the PR body first, then the card");
  assert.ok(three.indexOf(card[0]) < three.findIndex((w) => w.startsWith("DELETE /issues/3/labels/")), "the card before the label goes");
  assert.ok(!fake.writes.some((w) => w.includes(finishMarker(7)) || w.includes(finishMarker(8))), "no card on a Block, nor on a close with its PR unmerged");
  assert.ok(!fake.writes.some((w) => w.startsWith("PATCH /pulls/70") || w.startsWith("PATCH /pulls/80")));

  // A second tick (the label's removal lost, so #3 is tidied again): its card is there, so none is posted.
  const before = fake.writes.length;
  const second = await tickOver(fake);
  assert.deepEqual(second.finished, []);
  assert.ok(!fake.writes.slice(before).some((w) => w.includes(finishMarker(3)) || w.startsWith("PATCH /pulls/4")), "posted once");
});

test("finish card: a passing failure waits for a later tick, by the tick's own clock; any other failure, or a refused PR body, does not hold it (B1, S9)", async () => {
  const closedAt = Date.parse(real.issue.closed_at);
  const failing = fakeRepo({ failCard: 502 });
  const failed = await tickOver(failing, { now: new Date(closedAt + 3600_000) });
  assert.deepEqual(failed.finished, []);
  assert.ok(!failed.done.includes(3));
  assert.ok(!failing.writes.some((w) => w.startsWith("DELETE /issues/3/labels/")), "no tidy without its card");
  assert.ok(!failed.deadlines.some((d) => /finish/.test(JSON.stringify(d))), "no wake of its own: a later tick retries");
  // A day after the close the tidy goes on without it.
  assert.ok((await tickOver(fakeRepo({ failCard: 502 }), { now: new Date(closedAt + 25 * 3600_000) })).done.includes(3));
  assert.ok((await tickOver(fakeRepo({ failCard: 422 }))).done.includes(3));
  // The PR body write refused: the card is posted all the same.
  const refused = fakeRepo({ failBody: 422 });
  assert.deepEqual((await tickOver(refused)).finished, [3]);
});

test("finish card: one route posts it, the local loop for pendulum:local Objectives and the Action for the rest, and under a person's login the PR body is left alone (S1, S-A, B3)", async () => {
  // A local loop without --all: #3 has no pendulum:local, so it is the Action's; the loop tidies nothing of it.
  const notOurs = fakeRepo();
  assert.deepEqual((await tickOver(notOurs, { env: { PENDULUM_LOCAL: "1" } })).finished, []);
  assert.ok(!notOurs.writes.some((w) => w.includes(finishMarker(3))));
  // The Action does not post for a pendulum:local Objective, and leaves its label for the loop's Done pass (#565).
  const local = ["pendulum:objective", "pendulum:local", "pendulum:in-review"];
  const action = fakeRepo({ labels3: local });
  const tick = await tickOver(action);
  assert.deepEqual(tick.finished, []);
  assert.ok(!tick.done.includes(3));
  // The local loop posts it for its own, with no PR body block.
  const loop = fakeRepo({ labels3: local });
  assert.deepEqual((await tickOver(loop, { env: { PENDULUM_LOCAL: "1" } })).finished, [3]);
  assert.ok(loop.writes.some((w) => w.startsWith(`POST /issues/3/comments ${finishMarker(3)}`)));
  assert.ok(!loop.writes.some((w) => w.startsWith("PATCH /pulls/4")), "no edit of the PR body under a person's login");
  // A loop with --all beside a running Action: it tidies the Action's Objective but posts no card for it; the Action does.
  const all = fakeRepo();
  const allTick = await tickOver(all, { env: { PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" } });
  assert.deepEqual(allTick.finished, []);
  assert.ok(!allTick.done.includes(3), "its label left for the Action's Done pass, which posts the card");
  assert.ok(!all.writes.some((w) => w.includes(finishMarker(3))));
  assert.deepEqual((await tickOver(fakeRepo())).finished, [3], "the Action posts it");
});

test("finish card (#565 W3): the Action's tick on a pendulum:local Objective's close, before the loop's, leaves its label, so the loop's Done pass still posts its card; a day after the close the Action tidies it alone", async () => {
  const local = ["pendulum:objective", "pendulum:local", "pendulum:in-review"];
  // assetgrove #402 and #408: the Action's run on the close came first and took the label, so the loop had none to act on.
  const fake = fakeRepo({ labels3: local, dropLabels: true });
  const action = await tickOver(fake);
  assert.deepEqual(action.finished, []);
  assert.ok(!fake.writes.some((w) => w.startsWith("DELETE /issues/3/labels/")), "the label stays for the loop");
  assert.ok(action.done.includes(7) && action.done.includes(8), "an Objective with no card to wait for is tidied as before");
  const loop = await tickOver(fake, { env: { PENDULUM_LOCAL: "1" } });
  assert.deepEqual(loop.finished, [3], "the loop's later tick posts the card");
  assert.ok(fake.writes.some((w) => w.startsWith(`POST /issues/3/comments ${finishMarker(3)}`)));
  assert.ok(fake.writes.some((w) => w.startsWith("POST /issues/3/comments <!-- pendulum:3:done -->")), "and its Done record");
  // A person closed a pendulum:local Objective by hand with its PR still open (#80): no card is due, so the Action tidies
  // it at once, its PR stopped (out of the merge queue, back to a draft), never left queued for a day.
  const open = fakeRepo({ labels8: local, dropLabels: true });
  const openTick = await tickOver(open);
  assert.ok(openTick.done.includes(8));
  assert.ok(open.writes.some((w) => w.startsWith("DELETE /issues/8/labels/")), "its state label goes");
  assert.ok(open.writes.some((w) => w.startsWith("DELETE /issues/80/labels/")), "its PR stopped: the review label off");
  // Closed as not planned: no card is due either.
  const dropped = fakeRepo({ labels3: local, dropLabels: true });
  const fetchAll = dropped.fetch;
  dropped.fetch = async (url, init) => {
    const r = await fetchAll(url, init);
    if (new URL(url).pathname.endsWith("/issues") && (init?.method || "GET") === "GET") return new Response(JSON.stringify((await r.json()).map((i) => (i.number === 3 ? { ...i, state_reason: "not_planned" } : i))), { status: 200, headers: { "content-type": "application/json" } });
    return r;
  };
  assert.ok((await tickOver(dropped)).done.includes(3), "closed as not planned: tidied at once");
  // Its loop not running: a day after the close the Action tidies it, with no card.
  const late = fakeRepo({ labels3: local, dropLabels: true });
  const lateTick = await tickOver(late, { now: new Date(Date.parse(real.issue.closed_at) + 25 * 3600_000) });
  assert.ok(lateTick.done.includes(3));
  assert.deepEqual(lateTick.finished, []);
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
    const [head, line, ...rest] = body.split("\n");
    assert.equal(head, finishMarker(3), "the card's own marker first, so one card per Objective still holds");
    assert.match(line, /^<!-- pendulum:3:summary \{[^\n<>]*\} -->$/, "one hidden line, nothing in it that closes the comment");
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
  assert.equal(crowdedBody, `${finishMarker(3)}\n${renderFinishCard(crowded)}`);
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
  assert.match(renderFinishCard(sandboxed), /plus spend that was not reported/);
  assert.deepEqual(card.finishSummary(sandboxed).sandbox, { usd: 0.02, cents: 2, unknown: 1, why: ["sandbox"], foreign: [] });
  // A teammate's vendor comment of one of Pendulum's stages is that stage's, no run of its own; one of no stage is a
  // run of unknown cost of its stage's kind, one each.
  const teammate = { login: "teammate", type: "User" };
  const theirs = (id, at, key) => ({ ...comment(id, at, `<!-- pendulum:3:vendor:${key} -->\nx\n${spendLine({ usd: 0.5, vendorUsd: 0.5 })}`), user: teammate, author_association: "MEMBER" });
  const foreign = withSelf(() => data({ comments: [...real.comments, theirs(905, "2026-11-17T02:26:41Z", keyOf("work")), theirs(906, "2026-11-17T02:26:42Z", "review:zz9"), theirs(907, "2026-11-17T02:26:43Z", "work:zz8")] }));
  assert.deepEqual(foreign.sandbox, { usd: 0, unknown: 2 });
  assert.deepEqual(card.finishSummary(foreign).sandbox.foreign, ["review", "work"]);

  // Another issue's, another version's or a broken one reads as none.
  const body = card.finishCardBody(runs[0]);
  assert.equal(card.readSummary(body, 4), null);
  assert.equal(card.readSummary(body.replace('"v":1', '"v":2'), 3), null);
  assert.equal(card.readSummary(body.replace(/"usd":0\.35637/, '"usd":"0.35637"'), 3), null);
  assert.equal(card.readSummary(body.replace(/"kind":"build"/, '"kind":"magic"'), 3), null);
});

test("finish card (#567): an issue labelled before the rename to Pendulum has no wall clock: the card says so, never a figure that starts too late", async () => {
  const { finishSummary } = await import("../scripts/lib/finish-card.mjs");
  const plain = withSelf(() => data());
  // GitHub keeps a renamed label's old name on its events: the Objective's first label, a day before the current one.
  for (const name of [`${PREVIOUS_NAME}:objective`, `${PREVIOUS_NAME}:running`]) {
    const timeline = [{ event: "labeled", label: { name }, actor: { login: "kirkmarple-clockgrove" }, created_at: "2026-11-16T02:00:00Z" }, ...real.timeline];
    const d = withSelf(() => data({ timeline }));
    const sum = finishSummary(d);
    assert.deepEqual([sum.wallMs, sum.labelledWallMs], [null, null], name);
    // Nothing else is read from that event: the clock's start and every other figure are as without it.
    const rest = (x) => ({ ...x, pendulum: null, wallMs: null, labelledWallMs: null });
    assert.deepEqual(rest(sum), rest(finishSummary(plain)));
    const md = renderFinishCard(d);
    assert.match(md, /<h3 align="center">Merged for [^<]*\. Its wall clock is not known: it was labelled before the rename to Pendulum\.<\/h3>/);
    assert.match(md, /alt="wall clock: not known"/);
    assert.match(md, /\| \*\*Total\*\* \| \*\*not known\*\* \|/);
    assert.doesNotMatch(md, /Merged in /);
  }
  // A current label alone, or a label of another name that starts with it: the wall clock as before.
  const other = withSelf(() => data({ timeline: [{ event: "labeled", label: { name: `${PREVIOUS_NAME}:objectives` }, created_at: "2026-11-16T02:00:00Z" }, ...real.timeline] }));
  assert.equal(finishSummary(other).wallMs, finishSummary(plain).wallMs);
  assert.ok(finishSummary(plain).wallMs > 0 && finishSummary(plain).labelledWallMs > 0);
});
