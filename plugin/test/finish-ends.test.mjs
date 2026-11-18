// The finish card's look and its ends (#589): text only, its headline block, a numbered timeline with Blocked and
// Question stages and the time on hold, one stage table, the cost chart; one card per Objective, written in place as
// its run ends again (Blocked, a Question, closed without merging, merged); and no reader takes a card of an end other
// than a merge for a merged Objective's.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETRY, repoOf } from "../scripts/lib/github.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { COMMENT_MAX, endCard, finishCardBody, finishData, finishEndOf, finishMarker, finishSummary, postFinishCard, readSummary, renderFinishCard } from "../scripts/lib/finish-card.mjs";
import { summaryFor } from "../scripts/lib/report.mjs";
import * as F from "./fixtures/finish-ends.mjs";

RETRY.sleep = async () => {};
const SNAP = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "finish-ends.snap.json"), "utf8"));
const ZONE = { GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "America/Los_Angeles" };

function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  setSelf(F.SELF);
  try {
    return fn();
  } finally {
    setSelf(null);
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const data = (make) => withEnv(ZONE, () => finishData(make()));
const card = (make) => withEnv(ZONE, () => renderFinishCard(finishData(make())));
// The charts' theme lines are the shared look's (card-kit.mjs), tested there: the snapshots leave them out.
const shown = (md) => md.split("\n").filter((l) => !l.startsWith("%%{init")).join("\n");

for (const [name, make] of Object.entries({ mergedClean: F.mergedClean, mergedBlocked: F.mergedBlocked, closedUnmerged: F.closedUnmerged, blockedEnd: F.blockedEnd, questionEnd: F.questionEnd, multiDay: F.multiDay })) {
  test(`finish card snapshot (#589): ${name}`, () => {
    assert.equal(shown(card(make)), SNAP[name]);
  });
}

test("finish card (#589): merged, clean (spec 5.2): the headline block first, text only; the stage table holds the timeline's figures; the cost chart beside its table", () => {
  const md = card(F.mergedClean);
  assert.ok(md.startsWith("### ✅ Merged in 37 min 33 s · $3.67 + unknown\nIssue #402 → PR #409 · merged through your merge queue at 10:31 AM PST · API-equivalent, not billed · plus 7 AI runs of unknown cost\n\n"));
  assert.doesNotMatch(md, /<img|<h\d|<p |shields\.io|pie showData/, "no image, badge, centred block or pie");
  assert.match(md, /^You wrote the issue and added the label\. Pendulum planned the work, opened PR #409 \(\*\*4 commits, \+355 −25 across 10 files\*\*\), got \*\*1 CI check\*\* green, had the change reviewed \(1 finding\), and it merged through your merge queue\.$/m);
  assert.match(md, /^\| 9:54 AM \| Plan \+ build · Opus 5\.5 \| 11 min 1 s \| \$1\.78 \+ unknown \|$/m);
  assert.match(md, /^\| \| \*\*Total\*\* \| \*\*37 min 33 s\*\* \| \*\*\$3\.67 \+ unknown\*\* \|$/m);
  assert.match(md, /xychart-beta horizontal\n {4}title "Recorded cost \(USD\)"\n {4}x-axis \["Work \$1\.78 \+ unknown", "Review \$1\.29 \+ unknown", "Answering the review \$0\.60"\]\n {4}y-axis "USD" 0 --> 2\n {4}bar \[1\.78, 1\.29, 0\.60\]/);
  assert.match(md, /"plotColorPalette":"#c9822e"/, "one amber series");
  assert.match(md, /^Bars show recorded dollars only; 7 AI runs of unknown cost are not drawn\. CI minutes are not included\.$/m);
  assert.match(md, /- \*\*Unknown cost:\*\* 7 AI judge calls went through the AI Gateway, which did not report their cost\./);
  assert.doesNotMatch(md, /How overhead is counted/, "no overhead: no note on how it is counted");
});

test("finish card (#589): a Block on the way (spec 5.3): repeated section names numbered, the Blocked stage red with its word, the time on hold grey from the notice to the next stage", () => {
  const d = data(F.mergedBlocked);
  assert.deepEqual(d.stages.map((s) => [s.kind, s.outcome ?? null]), [["build", null], ["review", null], ["review", null], ["review", "blocked"], ["work", null], ["rebase", null], ["review", null]]);
  assert.deepEqual(d.holds, [{ kind: "blocked", start: "2026-11-18T02:31:08Z", end: "2026-11-18T03:12:40Z" }]);
  const md = card(F.mergedBlocked);
  assert.match(md, /section Review 1\n[^\n]*\n {4}section Review 2\n[^\n]*\n {4}section Review 3\n {4}3m 33s Blocked :crit, 2026-11-17T18:27:35, 2026-11-17T18:31:08\n {4}section On hold\n {4}41m 32s :done, 2026-11-17T18:31:08, 2026-11-17T19:12:40\n/);
  assert.match(md, /^\| 6:27 PM \| Review 3 · Fable 5\.2 · ⛔ Blocked \| 3 min 33 s \| \$0\.52 \+ unknown \|\n\| 6:31 PM \| On hold · waiting for you \| 41 min 32 s \| — \|$/m);
  assert.match(md, /^Blocked once: 41 min 32 s on hold, waiting for you\.$/m);
  assert.match(md, /\| Overhead Pendulum caused \| Stages \| Cost \|\n\| :-- \| --: \| --: \|\n\| Rebases after other PRs merged \(conflict\) \| 1 \| \$0\.61 \|\n\| Runs repeated after a Block \| 1 \| \$0\.52 \|/);
  assert.match(md, /- \*\*How overhead is counted:\*\* Each item comes from a stage's own record/);
  // The summary's figures are the merged card's: the holds and outcomes are the card's own words, never the summary's.
  assert.equal(finishSummary(d).end, undefined);
  assert.equal(JSON.stringify(finishSummary(d)).includes("hold"), false);
});

test("finish card (#589): a notice with no recorded end, or one of anyone but Pendulum, holds nothing", () => {
  const o = F.mergedBlocked();
  // The Blocked notice by a stranger: no stage ended Blocked, nothing on hold.
  const pasted = o.comments.map((c) => (/:blocked:/.test(c.body) ? { ...c, user: { login: "stranger", type: "User" } } : c));
  const d = withEnv(ZONE, () => finishData({ ...o, comments: pasted }));
  assert.deepEqual(d.holds, []);
  assert.ok(d.stages.every((s) => !s.outcome));
  // The Blocked card (spec 5.4): its last stage red, no hold row (the hold has not ended), the action lines.
  const b = data(F.blockedEnd);
  assert.deepEqual(b.holds, []);
  assert.equal(b.stages.at(-1).outcome, "blocked");
});

test("finish card (#589): Blocked, a Question and a close (spec 5.4): their headlines, what to do and why; a close needs no one", () => {
  const blocked = card(F.blockedEnd);
  assert.ok(blocked.startsWith("### ⛔ Blocked after 1 h 5 min · $2.83 + unknown so far\nIssue #152 · PR #157 is a draft · Blocked at 12:52 PM PST · API-equivalent, not billed · plus 5 AI runs of unknown cost\n\n> **What to do:** fix the cause below, then re-apply the `pendulum:objective` label. The Blocked notice on this issue has the full steps.\n>\n> **Why:** 2 review findings are still open after the answers.\n"));
  assert.match(blocked, /3 min 00s|31m 00s Blocked :crit/);
  const question = card(F.questionEnd);
  assert.ok(question.startsWith("### ❓ Question after 9 min · $0.84 so far\nIssue #512 · Question asked at 2:19 PM PST · API-equivalent, not billed\n\n> **What to do:** answer the question in a comment on this issue. Pendulum goes on from where it stopped.\n>\n> **Question:** Should the export keep the legacy column order, or follow the new schema?\n"));
  // Asked on its PR: answered there, then the PR marked ready.
  const onPr = withEnv(ZONE, () => renderFinishCard(finishData({ ...F.blockedEnd(), end: { kind: "question", at: "2026-11-17T20:52:00Z", reason: "which one?", form: "pr" } })));
  assert.match(onPr, /^> \*\*What to do:\*\* answer in a comment on this issue or PR #157, then mark PR #157 ready\. Pendulum goes on from where it stopped\.$/m);
  const closed = card(F.closedUnmerged);
  assert.ok(closed.startsWith("### ⏹️ Closed without merging after 1 h 12 min · $4.20\nIssue #230 · PR #236 closed, not merged · closed at 3:02 PM PST · API-equivalent, not billed\n\nYou wrote the issue and added the label. Pendulum planned the work and opened PR #236 (**3 commits, +120 −14 across 5 files**); you closed the issue before it merged.\n"));
  assert.doesNotMatch(closed, /What to do|Where the money went/);
  // With no merge and no other end, no card: finishData's answer as before.
  assert.equal(withEnv(ZONE, () => finishData({ ...F.closedUnmerged(), end: null })), null);
});

test("finish card (#589): across days (spec 5.5): dates on every time, the run's span on the second line, the stages' and the holds' totals", () => {
  const md = card(F.multiDay);
  assert.ok(md.startsWith("### ✅ Merged in 2 d 3 h · $18.40\nIssue #98 → PRs #101, #104 · Nov 15, 9:12 AM – Nov 17, 12:40 PM PST · billed to your API key\nStages ran for 2 h 14 min in all; 2 d on hold (Blocked once, 1 Question).\n"));
  assert.match(md, /axisFormat %b %d %H:%M\n {4}tickInterval 12hour/);
  assert.match(md, /section On hold 1\n {4}21h 40m :done, 2026-11-15T10:18:05, 2026-11-16T07:58:30\n/);
  assert.match(md, /^\| Nov 15, 9:56 AM \| Review 1 · Fable 5\.2 · ❓ Question \| 22 min 5 s \| \$3\.10 \|$/m);
  assert.match(md, /^\| Nov 16, 8:52 AM \| On hold 2 · waiting for you \| 1 d 3 h \| — \|$/m);
});

test("finish card (#589): the summary of an end other than a merge names it and no merge, and reads back as none; a merged card's summary is as before", () => {
  for (const make of [F.blockedEnd, F.questionEnd, F.closedUnmerged]) {
    const d = data(make);
    const body = withEnv(ZONE, () => finishCardBody(d));
    const sum = finishSummary(d);
    assert.equal(sum.merged, null);
    assert.equal(sum.end, d.end);
    assert.equal(readSummary(body, d.issue), null, `${d.end}: no reader takes it for a merged Objective's`);
    assert.deepEqual(finishEndOf(body, d.issue), { end: d.end, at: d.ended });
  }
  const merged = data(F.mergedClean);
  const body = withEnv(ZONE, () => finishCardBody(merged));
  assert.deepEqual(readSummary(body, 402), finishSummary(merged));
  assert.equal(Object.hasOwn(finishSummary(merged), "end"), false, "a merged summary carries no new field");
  // A card from before #589 has no end line: it was only ever posted on a merge.
  assert.deepEqual(finishEndOf(`${finishMarker(402)}\n### Merged`, 402), { end: "merged", at: null });
  assert.equal(finishEndOf("no card", 402), null);
});

test("finish card (#589): the report reads a non-merged card's Objective from its stages, and a card written again in place by its last write", () => {
  const scope = { since: "2026-11-01T00:00:00Z", until: null, issues: [] };
  const mine = (c) => c.user?.login === F.SELF;
  const o = F.blockedEnd();
  const blocked = withEnv(ZONE, () => finishCardBody(finishData(o)));
  const issueUrl = `https://api.github.com/repos/acme/app/issues/${o.issue.number}`;
  const comments = [...o.comments, { id: 9, user: { login: F.SELF, type: "Bot" }, created_at: "2026-11-17T20:53:00Z", updated_at: "2026-11-17T20:53:00Z", body: blocked }].map((c) => ({ ...c, issue_url: issueUrl }));
  assert.equal(summaryFor(152, comments, scope, { mine }), null, "a Blocked card is no merge: the stages are read");
  // The same Objective later merged: its card was written over in place (created at the Block, updated at the merge).
  const m = F.mergedClean();
  const url = `https://api.github.com/repos/acme/app/issues/402`;
  const ledgered = m.comments.map((c) => ({ ...c, issue_url: url, body: /:progress:/.test(c.body) ? `${c.body}\n<!-- pendulum:ledger {"p":[]} -->` : c.body }));
  const mergedBody = withEnv(ZONE, () => finishCardBody(finishData({ ...m, comments: ledgered })));
  const upserted = { id: 10, user: { login: F.SELF, type: "Bot" }, created_at: "2026-11-17T18:06:00Z", updated_at: "2026-11-17T18:32:00Z", body: mergedBody, issue_url: url };
  assert.ok(summaryFor(402, [...ledgered, upserted], scope, { mine }), "its figures are those of its last write, after every stage");
  assert.equal(summaryFor(402, [...ledgered, { ...upserted, updated_at: upserted.created_at }], scope, { mine }), null, "a card older than a stage's last write is not read");
});

test("finish card (#589): over GitHub's limit the card leaves out its run log first; its summary and end line stay", () => {
  const o = F.mergedClean();
  const many = Array.from({ length: 900 }, (_, i) => F.stage(402, "review", `x${i}`, `2026-11-17T18:0${i % 10}:00Z`, `2026-11-17T18:0${i % 10}:30Z`, "claude-fable-5-2", { usd: 0.01, usdByBilling: { subscription: 0.01 }, usdByPass: { review: { usd: 0.01, usdByBilling: { subscription: 0.01 } } } }, "\n" + "y".repeat(10)));
  const d = withEnv(ZONE, () => finishData({ ...o, comments: [...o.comments, ...many] }));
  const full = withEnv(ZONE, () => renderFinishCard(d));
  assert.ok(full.length > COMMENT_MAX, `${full.length}`);
  const body = withEnv(ZONE, () => finishCardBody(d));
  assert.ok(body.length <= COMMENT_MAX);
  assert.doesNotMatch(body, /\*\*Run log\*\*/);
  assert.deepEqual(finishEndOf(body, 402).end, "merged");
});

/**
 * A fake GitHub for Objective #152: its comments as `comments` (a POST adds one, a PATCH edits one), its branch's PRs as
 * `prs`, and the reads a card makes. Returns {fetch, comments, writes}.
 */
function fakeObjective(o, prs) {
  const comments = o.comments.map((c) => ({ ...c }));
  const writes = [];
  let next = 5000;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    if (method !== "GET") writes.push(`${method} ${p}`);
    if (method === "GET" && p === "/pulls" && u.searchParams.get("state") === "all") return json(prs());
    const pr = /^\/pulls\/(\d+)$/.exec(p);
    if (method === "GET" && pr) return json(prs().find((x) => String(x.number) === pr[1]));
    if (method === "GET" && /^\/pulls\/\d+\/(reviews|comments)$/.test(p)) return json([]);
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(p)) return json(p === `/issues/${o.issue.number}/timeline` ? o.timeline : []);
    if (method === "GET" && p === `/issues/${o.issue.number}/comments`) return json(comments);
    if (method === "GET" && /\/check-runs$/.test(p)) return json({ total_count: 0, check_runs: [] });
    if (method === "GET" && p === "/rulesets") return json([]);
    if (method === "POST" && p === `/issues/${o.issue.number}/comments`) {
      const c = { id: (next += 1), user: { login: F.SELF, type: "Bot" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), body: JSON.parse(init.body).body };
      comments.push(c);
      return json(c, 201);
    }
    const edit = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (method === "PATCH" && edit) {
      const c = comments.find((x) => String(x.id) === edit[1]);
      Object.assign(c, { body: JSON.parse(init.body).body, updated_at: new Date().toISOString() });
      return json(c);
    }
    if (method === "PATCH") return json({});
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, comments, writes };
}

async function over(fake, fn) {
  const real = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = fake.fetch;
  const before = Object.fromEntries(Object.keys(ZONE).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ZONE);
  setSelf(F.SELF);
  try {
    return await fn();
  } finally {
    setSelf(null);
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    globalThis.fetch = real;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

test("finish card (#589): one card per Objective, written in place: the stage's Blocked card, Blocked again, then the merge; a merged card is final", async () => {
  const o = F.blockedEnd();
  let state = { merged_at: null, draft: true, state: "open" };
  const prs = () => [{ number: 157, user: { login: F.SELF, type: "Bot" }, created_at: "2026-11-17T20:19:00Z", html_url: "https://github.com/acme/app/pull/157", head: { sha: "d".repeat(40) }, commits: 2, additions: 40, deletions: 3, changed_files: 2, ...state }];
  const fake = fakeObjective(o, prs);
  const repo = repoOf("acme/app");
  const issue = { ...o.issue, labels: [{ name: "pendulum:objective" }, { name: "pendulum:blocked" }] };
  // The review stage Blocks: its own card, after its exit line.
  assert.equal(await over(fake, () => endCard(repo, issue, { token: "t" }, { exit: "blocked", reason: o.end.reason, now: Date.parse("2026-11-17T20:52:00Z") })), "posted");
  const cards = () => fake.comments.filter((c) => c.body.startsWith(finishMarker(152)));
  assert.equal(cards().length, 1);
  assert.match(cards()[0].body, /\n### ⛔ Blocked after /);
  // Blocked again later: the same comment, written again.
  assert.equal(await over(fake, () => endCard(repo, issue, { token: "t" }, { exit: "blocked", reason: "still open", now: Date.parse("2026-11-17T21:30:00Z") })), "updated");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].body, /> \*\*Why:\*\* still open/);
  // Merged: the Done pass writes the merged card over it, in place; every reader sees the merge.
  state = { merged_at: "2026-11-17T22:00:00Z", draft: false, state: "closed" };
  const closedIssue = { ...issue, state: "closed", closed_at: "2026-11-17T22:00:02Z" };
  assert.equal(await over(fake, () => postFinishCard(repo, closedIssue, { token: "t" }, { prBody: false })), "updated");
  assert.equal(cards().length, 1);
  assert.equal(finishEndOf(cards()[0].body, 152).end, "merged");
  assert.ok(readSummary(cards()[0].body, 152), "its summary is a merge's now");
  // A merged card is final: a later Block of a reopened run, or the Done pass again, leaves it as it is.
  assert.equal(await over(fake, () => postFinishCard(repo, closedIssue, { token: "t" }, { prBody: false })), "had");
  state = { merged_at: null, draft: true, state: "open" };
  assert.equal(await over(fake, () => endCard(repo, issue, { token: "t" }, { exit: "blocked", reason: "again" })), "had");
  assert.equal(cards().length, 1);
  assert.ok(!fake.writes.some((w) => w.startsWith("PATCH /pulls/157")), "no finish block on the PR under prBody false");
  // A card no one else can write: a stranger's comment with the marker is never edited.
  const theirs = fakeObjective({ ...o, comments: [...o.comments, { id: 1, user: { login: "stranger", type: "User" }, created_at: "2026-11-17T20:53:00Z", body: `${finishMarker(152)}\n<!-- pendulum:152:finish-end {"end":"merged","at":"2026-11-17T20:53:00Z"} -->` }] }, prs);
  assert.equal(await over(theirs, () => endCard(repo, issue, { token: "t" }, { exit: "question", reason: "which?", form: "issue", now: Date.parse("2026-11-17T20:52:00Z") })), "posted");
  // An end that needs no card: nothing is read.
  assert.equal(await endCard(repo, issue, { token: "t" }, { exit: "delivered" }), "no end");
});
