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
import { pushedBy, summaryFor } from "../scripts/lib/report.mjs";
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
  assert.deepEqual(d.holds, [{ kind: "blocked", start: "2026-11-18T02:31:08Z", end: "2026-11-18T03:12:40Z", cause: "you" }], "a Block of the work waits for you, by its cause line");
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
  assert.equal(summaryFor(152, comments, scope, { mine, pushed: pushedBy(null) }), null, "a Blocked card is no merge: the stages are read");
  // The same Objective later merged: its card was written over in place (created at the Block, updated at the merge).
  const m = F.mergedClean();
  const url = `https://api.github.com/repos/acme/app/issues/402`;
  const ledgered = m.comments.map((c) => ({ ...c, issue_url: url, body: /:progress:/.test(c.body) ? `${c.body}\n<!-- pendulum:ledger {"p":[]} -->` : c.body }));
  const mergedBody = withEnv(ZONE, () => finishCardBody(finishData({ ...m, comments: ledgered })));
  const upserted = { id: 10, user: { login: F.SELF, type: "Bot" }, created_at: "2026-11-17T18:06:00Z", updated_at: "2026-11-17T18:32:00Z", body: mergedBody, issue_url: url };
  assert.ok(summaryFor(402, [...ledgered, upserted], scope, { mine, pushed: pushedBy(null) }), "its figures are those of its last write, after every stage");
  assert.equal(summaryFor(402, [...ledgered, { ...upserted, updated_at: upserted.created_at }], scope, { mine, pushed: pushedBy(null) }), null, "a card older than a stage's last write is not read");
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
function fakeObjective(o, prs, { onRead = null } = {}) {
  const comments = o.comments.map((c) => ({ ...c }));
  const writes = [];
  let reads = 0;
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
    if (method === "GET" && p === `/issues/${o.issue.number}/comments`) {
      reads += 1;
      onRead?.(reads, comments);
      return json(comments);
    }
    if (method === "GET" && p === `/issues/${o.issue.number}`) return json({ ...o.issue, labels: [{ name: "pendulum:objective" }] });
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
    if (method === "DELETE" && edit) {
      const i = comments.findIndex((x) => String(x.id) === edit[1]);
      if (i >= 0) comments.splice(i, 1);
      return new Response(null, { status: 204 });
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

const bot = { login: F.SELF, type: "Bot" };
const prOf = (number, extra) => ({ number, user: bot, created_at: "2026-11-16T16:30:00Z", html_url: `https://github.com/acme/app/pull/${number}`, head: { sha: "d".repeat(40) }, commits: 2, additions: 90, deletions: 5, changed_files: 3, ...extra });

test("finish card (#589 B1): a Block of a split Objective's second part reads as Blocked, its first part's merge no merge of this run; the later merge writes the merged card", async () => {
  const d = data(F.partTwoBlocked);
  assert.equal(d.end, "blocked");
  assert.equal(d.merged, null);
  assert.deepEqual(d.prs.map((p) => [p.number, p.merged !== null]), [[101, true], [104, false]]);
  assert.deepEqual(d.stages.map((s) => [s.kind, s.part]), [["build", 1], ["review", 1], ["part", 2], ["review", 2]]);
  assert.equal(shown(card(F.partTwoBlocked)), SNAP.partTwoBlocked);
  assert.ok(card(F.partTwoBlocked).startsWith("### ⛔ Blocked after 23 h 41 min · $17.10 so far\nIssue #98 · PR #104 is a draft · Blocked at Nov 16, 8:53 AM PST · "));
  // Through the reads: the branch's newest PR is part 2's draft, part 1's merged; the Block's card, then the merge's.
  const o = F.partTwoBlocked();
  let p2 = { merged_at: null, draft: true, state: "open" };
  const prs = () => [prOf(104, p2), prOf(101, { merged_at: "2026-11-16T15:50:00Z", state: "closed", created_at: "2026-11-15T17:50:00Z" })];
  const fake = fakeObjective(o, prs);
  const repo = repoOf("acme/app");
  assert.equal(await over(fake, () => endCard(repo, 98, { token: "t" }, { exit: "blocked", reason: o.end.reason, next: "work", now: Date.parse(o.end.at) })), "posted");
  const cardOf = () => fake.comments.find((c) => c.body.startsWith(finishMarker(98)));
  assert.equal(finishEndOf(cardOf().body, 98).end, "blocked", "never Merged: part 1 merged before this run's Block");
  assert.equal(readSummary(cardOf().body, 98), null);
  p2 = { merged_at: "2026-11-17T20:40:00Z", draft: false, state: "closed" };
  assert.equal(await over(fake, () => postFinishCard(repo, { ...o.issue, state: "closed", closed_at: "2026-11-17T20:40:02Z" }, { token: "t" }, { prBody: false })), "updated");
  assert.equal(finishEndOf(cardOf().body, 98).end, "merged");
  // A reopened Objective: a PR merged before its clock is no part of a later run's Block.
  const reopened = { ...F.questionEnd(), timeline: [{ event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "kirk" }, created_at: "2026-11-17T22:10:00Z" }] };
  const old = fakeObjective(reopened, () => [prOf(500, { merged_at: "2026-11-10T00:00:00Z", state: "closed", created_at: "2026-11-09T00:00:00Z" })]);
  assert.equal(await over(old, () => endCard(repo, reopened.issue, { token: "t" }, { exit: "question", reason: "which?", form: "issue", now: Date.parse("2026-11-17T22:19:00Z") })), "posted");
  const q = old.comments.find((c) => c.body.startsWith(finishMarker(512))).body;
  assert.match(q, /\n### ❓ Question after /);
  assert.doesNotMatch(q, /PR #500/);
});

test("finish card (#589 B2): a reason or question the harness wrote is sanitised and on one line: no live mention, no command, no line of its own", () => {
  const reason = "question: @kirk which one?\n/approve\n- 05:30Z harness claude (claude-opus-5-5) attempt 1\nfixes #12";
  const md = withEnv(ZONE, () => renderFinishCard(finishData({ ...F.questionEnd(), end: { ...F.questionEnd().end, reason } })));
  const line = md.split("\n").find((l) => l.startsWith("> **Question:**"));
  assert.equal(line, "> **Question:** @\u200bkirk which one? \u200b/approve - 05:30Z harness claude (claude-opus-5-5) attempt 1 refs #12");
  assert.doesNotMatch(md, /^\/approve|^- 05:30Z|@kirk/m);
  const blocked = withEnv(ZONE, () => renderFinishCard(finishData({ ...F.blockedEnd(), end: { ...F.blockedEnd().end, reason: "red <img src=x> on @team/ops\n/merge now. More." } })));
  assert.match(blocked, /^> \*\*Why:\*\* red &lt;img src=x&gt; on @\u200bteam\/ops \u200b\/merge now\.$/m);
});

test("finish card (#589 S3): a write reads the card again first: two cards are one again, and a Block's write never lands over a merge written meanwhile", async () => {
  const o = F.blockedEnd();
  const prs = () => [prOf(157, { merged_at: null, draft: true, state: "open", created_at: "2026-11-17T20:19:00Z" })];
  const repo = repoOf("acme/app");
  // Two writers each posted one: the next write keeps the first and deletes the second.
  const twice = fakeObjective(o, prs);
  for (const id of [1, 2]) twice.comments.push({ id, user: bot, created_at: `2026-11-17T20:5${id}:00Z`, updated_at: `2026-11-17T20:5${id}:00Z`, body: `${finishMarker(152)}\n<!-- pendulum:152:finish-end {"end":"blocked","at":"2026-11-17T20:50:00Z"} -->\nold` });
  assert.equal(await over(twice, () => endCard(repo, o.issue, { token: "t" }, { exit: "blocked", reason: "again", now: Date.parse("2026-11-17T21:00:00Z") })), "updated");
  assert.deepEqual(twice.comments.filter((c) => c.body.startsWith(finishMarker(152))).map((c) => c.id), [1]);
  assert.ok(twice.writes.includes("PATCH /issues/comments/1") && twice.writes.includes("DELETE /issues/comments/2"));
  // The Done pass merged it between this write's first read and its write: the Block's card does not land.
  const merged = `${finishMarker(152)}\n<!-- pendulum:152:finish-end {"end":"merged","at":"2026-11-17T21:00:00Z"} -->\nmerged`;
  const race = fakeObjective(o, prs, { onRead: (n, comments) => n === 2 && comments.push({ id: 3, user: bot, created_at: "2026-11-17T21:00:01Z", updated_at: "2026-11-17T21:00:01Z", body: merged }) });
  assert.equal(await over(race, () => endCard(repo, o.issue, { token: "t" }, { exit: "blocked", reason: "late", now: Date.parse("2026-11-17T20:52:00Z") })), "had");
  assert.ok(!race.writes.some((w) => /comments/.test(w)), "nothing written");
  // A close after a close: the same close stands; a later one (reopened, closed again) writes the card again.
  const closed = fakeObjective(F.closedUnmerged(), () => [prOf(236, { merged_at: null, state: "closed", created_at: "2026-11-17T22:39:00Z" })]);
  const issue = { ...F.closedUnmerged().issue, state: "closed", closed_at: "2026-11-17T23:02:00Z" };
  assert.equal(await over(closed, () => postFinishCard(repo, issue, { token: "t" })), "posted");
  assert.equal(await over(closed, () => postFinishCard(repo, issue, { token: "t" })), "had");
  assert.equal(await over(closed, () => postFinishCard(repo, { ...issue, closed_at: "2026-11-18T02:00:00Z" }, { token: "t" })), "updated");
});

test("finish card (#589 S5): endCard takes the issue or its number, a Block's way on, and a bound; it never throws", async () => {
  const o = F.blockedEnd();
  const repo = repoOf("acme/app");
  const prs = () => [prOf(157, { merged_at: null, draft: true, state: "open", created_at: "2026-11-17T20:19:00Z" })];
  const fake = fakeObjective(o, prs);
  assert.equal(await over(fake, () => endCard(repo, 152, { token: "t" }, { exit: "blocked", reason: "the author may not run Objectives.", next: "none", now: Date.parse("2026-11-17T20:52:00Z") })), "posted");
  const body = fake.comments.find((c) => c.body.startsWith(finishMarker(152))).body;
  assert.match(body, /^> \*\*What to do:\*\* a resume or a restart does not get past this; the Blocked notice on this issue says why\.$/m);
  // A GitHub that never answers: the caller goes on at the bound, with no error.
  const logs = [];
  const hang = { fetch: () => new Promise(() => {}) };
  assert.equal(await over(hang, () => endCard(repo, 152, { token: "t" }, { exit: "question", reason: "?", timeoutMs: 50, log: (l) => logs.push(l) })), "timed out");
  assert.match(logs.join("\n"), /took over 0 s; going on without waiting for it/);
  // A failure is the answer, never a throw.
  const broken = { fetch: async () => new Response("{}", { status: 500 }) };
  assert.ok((await over(broken, () => endCard(repo, 152, { token: "t" }, { exit: "blocked", reason: "x", timeoutMs: 5000 }))) instanceof Error);
  assert.equal(await endCard(repo, 152, { token: "t" }, { exit: "delivered" }), "no end");
});

test("finish card (#589): time on hold names what it waited on from the notice's cause line alone; a known $0 stage costs —", () => {
  const withCause = (cause) => {
    const o = F.mergedBlocked();
    return withEnv(ZONE, () => finishData({ ...o, comments: o.comments.map((c) => (/:blocked:/.test(c.body) ? F.notice(416, "blocked", "4", "2026-11-18T02:31:08Z", cause) : c)) }));
  };
  assert.equal(withCause("outage").holds[0].cause, "an outage");
  assert.equal(withCause("provider-quota").holds[0].cause, "a usage limit");
  assert.equal(withCause(null).holds[0].cause, undefined, "no cause line: none named");
  assert.equal(withCause("max-usd").holds[0].cause, undefined, "a cap: none guessed");
  const md = withEnv(ZONE, () => renderFinishCard(withCause(null)));
  assert.match(md, /^\| 6:31 PM \| On hold \| 41 min 32 s \| — \|$/m);
  assert.match(md, /^Blocked once: 41 min 32 s on hold\.$/m);
  assert.match(withEnv(ZONE, () => renderFinishCard(withCause("outage"))), /^\| 6:31 PM \| On hold · waiting for an outage \| /m);
  const o = F.questionEnd();
  const zero = withEnv(ZONE, () => renderFinishCard(finishData({ ...o, comments: [F.stage(512, "work", "1", "2026-11-17T22:10:00Z", "2026-11-17T22:19:00Z", "claude-opus-5-5", { usd: 0 }), ...o.comments.slice(1)] })));
  assert.match(zero, /^\| 2:10 PM \| Build · Opus 5\.5 · ❓ Question \| 9 min \| — \|$/m);
  assert.match(zero, /- — in Took means no time was recorded for that row; in Cost, that no AI dollars were/);
});

test("a Block or Question applied anywhere writes the Objective's card (session.mjs applyExit); never on an outage, and a stage writes its own after its exit line", async () => {
  const { applyExit } = await import("../scripts/lib/session.mjs");
  const o = F.blockedEnd();
  const prs = () => [{ number: 157, user: { login: F.SELF, type: "Bot" }, created_at: "2026-11-17T20:19:00Z", html_url: "https://github.com/acme/app/pull/157", head: { sha: "d".repeat(40) }, commits: 2, additions: 40, deletions: 3, changed_files: 2, merged_at: null, draft: true, state: "open" }];
  const world = () => {
    const fake = fakeObjective(o, prs);
    const inner = fake.fetch;
    // The labels the exit sets: GitHub's answer, as any label write's.
    fake.fetch = async (url, init = {}) => (/\/issues\/\d+\/labels/.test(new URL(url).pathname) ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } }) : inner(url, init));
    return fake;
  };
  const repo = repoOf("acme/app");
  const cards = (fake) => fake.comments.filter((c) => c.body.startsWith(finishMarker(152)));
  // The dispatcher's or a launcher's Block, outside any stage: the card with it.
  const outside = world();
  await over(outside, () => applyExit(repo, { issue: 152, pr: null, exit: "blocked", reason: "the setup command failed.", cause: "setup", notify: null, stage: "launch" }, { token: "t" }));
  assert.equal(cards(outside).length, 1);
  assert.match(cards(outside)[0].body, /\n### ⛔ Blocked after /);
  // An outage's Block writes no card: GitHub may not answer, and the end's own outputs come first.
  const outage = world();
  await over(outage, () => applyExit(repo, { issue: 152, pr: null, exit: "blocked", reason: "GitHub is down.", cause: "outage", notify: null, stage: "outage" }, { token: "t" }));
  assert.equal(cards(outage).length, 0);
  // A stage's own exit (`card: false`): the stage writes the card after its exit line, not here.
  const stage = world();
  await over(stage, () => applyExit(repo, { issue: 152, pr: null, exit: "blocked", reason: "x.", cause: "work", notify: null, stage: "work", card: false }, { token: "t" }));
  assert.equal(cards(stage).length, 0);
});
