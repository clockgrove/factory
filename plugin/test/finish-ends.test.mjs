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
