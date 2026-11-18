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
import { setSelf, spendMarker, spendParts, stageSpendLine } from "../scripts/lib/logic.mjs";
import { COMMENT_MAX, endCard, finishCardBody, finishData, finishEndOf, finishMarker, finishSummary, blockersToRead, finishTotals, postFinishCard, readSummary, renderFinishCard, summaryMarker } from "../scripts/lib/finish-card.mjs";
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

for (const [name, make] of Object.entries({ mergedClean: F.mergedClean, mergedBlocked: F.mergedBlocked, closedUnmerged: F.closedUnmerged, blockedEnd: F.blockedEnd, questionEnd: F.questionEnd, multiDay: F.multiDay, blockedThenPaused: F.blockedThenPaused })) {
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
  assert.deepEqual(d.holds, [{ kind: "blocked", start: "2026-11-18T02:31:08Z", end: "2026-11-18T03:12:40Z", why: "you", cause: "you" }], "a Block of the work waits for you, by its cause line");
  const md = card(F.mergedBlocked);
  assert.match(md, /section Review 1\n[^\n]*\n {4}section Review 2\n[^\n]*\n {4}section Review 3\n {4}3m 33s Blocked :crit, 2026-11-17T18:27:35, 2026-11-17T18:31:08\n {4}section On hold\n {4}41m 32s :done, 2026-11-17T18:31:08, 2026-11-17T19:12:40\n/);
  assert.match(md, /^\| 6:27 PM \| Review 3 · Fable 5\.2 · ⛔ Blocked \| 3 min 33 s \| \$0\.52 \+ unknown \|\n\| 6:31 PM \| On hold · waiting for you \| 41 min 32 s \| — \|$/m);
  // Working and waiting apart (#614): the headline, the third line with the wait's cause, the table's two rows.
  assert.ok(md.startsWith("### ✅ Merged · 1 h 42 min working, 41 min 32 s waiting · $12.58 + unknown\n"), md.slice(0, 120));
  assert.match(md, /^Waited 41 min 32 s for you; 2 h 23 min from the label to the merge\.$/m);
  assert.match(md, /^\| \| Working \| 1 h 42 min \| \|\n\| \| Waiting \| 41 min 32 s \| \|\n\| \| \*\*Total\*\* \| \*\*2 h 23 min\*\* \|/m);
  assert.match(md, /\| Overhead Pendulum caused \| Stages \| Cost \|\n\| :-- \| --: \| --: \|\n\| Rebases after other PRs merged \(conflict\) \| 1 \| \$0\.61 \|\n\| Runs repeated after a Block \| 1 \| \$0\.52 \|/);
  assert.match(md, /- \*\*How overhead is counted:\*\* Each item comes from a stage's own record/);
  // The summary's figures are the merged card's, its wait among them (#614); a stage's outcome is the card's own word.
  assert.equal(finishSummary(d).end, undefined);
  assert.deepEqual(finishSummary(d).waits, [{ kind: "blocked", why: "you", start: "2026-11-18T02:31:08Z", end: "2026-11-18T03:12:40Z" }]);
  assert.equal(JSON.stringify(finishSummary(d)).includes("outcome"), false);
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
  assert.ok(md.startsWith("### ✅ Merged · 2 h 28 min working, 2 d waiting · $18.40\nIssue #98 → PRs #101, #104 · Nov 15, 9:12 AM – Nov 17, 12:40 PM PST · billed to your API key\nWaited 2 d for you; 2 d 3 h from the label to the merge.\n"), md.slice(0, 300));
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
    // A blocking issue, as GitHub answers for it (`o.blockers`, by repository and number; `status` and `headers` for a
    // refusal); one it does not hold is a 404.
    const blocker = (o.blockers ?? []).find((b) => method === "GET" && u.pathname === `/repos/${b.repo}/issues/${b.number}`);
    if (blocker?.status) return new Response(JSON.stringify({ message: "refused" }), { status: blocker.status, headers: { "content-type": "application/json", ...(blocker.headers ?? {}) } });
    if (blocker) return json({ number: blocker.number, state: blocker.state, closed_at: blocker.closed_at });
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
  assert.ok(card(F.partTwoBlocked).startsWith("### ⛔ Blocked · 2 h working, 21 h 40 min waiting · $17.10 so far\nIssue #98 · PR #104 is a draft · Blocked at Nov 16, 8:53 AM PST · "));
  assert.match(card(F.partTwoBlocked), /^Waited 21 h 40 min for you; 23 h 41 min from the label to the Block\.$/m);
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
  assert.match(md, /^Waited 41 min 32 s on hold; 2 h 23 min from the label to the merge\.$/m);
  assert.match(withEnv(ZONE, () => renderFinishCard(withCause("provider-quota"))), /^Waited 41 min 32 s on a usage limit; /m);
  assert.deepEqual([withCause("outage"), withCause("provider-quota"), withCause("setup"), withCause(null)].map((d) => d.holds[0].why), ["outage", "usage-limit", "you", undefined]);
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

// ------------------------------------------------------------------ working and waiting (#614)

test("finish card (#614): blocked by an issue, then paused on a usage limit (a real run's records): working and waiting apart, each wait with its cause, an On hold row and a grey bar for each", async () => {
  const d = data(F.blockedThenPaused);
  // The two waits, each from recorded times: the blocked-by event to the blocker's close; the paused review's last write
  // to the next stage's start.
  assert.deepEqual(d.holds, [
    { kind: "blocked-by", why: "blocked-by", start: "2026-11-17T20:34:26Z", end: "2026-11-18T09:10:43Z", blockers: ["#420"], cause: "#420" },
    { kind: "paused", start: "2026-11-18T10:13:20Z", end: "2026-11-18T17:08:37Z", why: "usage-limit", cause: "a usage limit" },
  ]);
  assert.deepEqual(d.stages.map((s) => [s.kind, s.outcome ?? null]), [["build", null], ["review", "paused"], ["review", null], ["review", null]]);
  const t = finishTotals(d);
  const [h, min, sec] = [3600_000, 60_000, 1000];
  assert.deepEqual([t.wall, t.waited, t.worked], [21 * h + 45 * min + 49 * sec, 12 * h + 36 * min + 17 * sec + 6 * h + 55 * min + 17 * sec, 2 * h + 14 * min + 15 * sec]);
  const md = card(F.blockedThenPaused);
  assert.ok(md.startsWith("### ✅ Merged · 2 h 14 min working, 19 h 31 min waiting · $15.33\nIssue #421 → PR #443 · Nov 17, 12:34 PM – Nov 18, 10:20 AM PST · API-equivalent, not billed\nWaited 12 h 36 min blocked by #420 and 6 h 55 min on a usage limit; 21 h 45 min from the label to the merge.\n\n"), md.slice(0, 400));
  assert.doesNotMatch(md, /Merged in /, "never the whole span as the time it took");
  // The timeline: each wait a grey bar; the paused review amber with its word.
  assert.match(md, /section On hold 1\n {4}12h 36m :done, 2026-11-17T12:34:26, 2026-11-18T01:10:43\n {4}section Build\n/);
  assert.match(md, /section Review 1\n {4}21s Paused :active, 2026-11-18T02:12:59, 2026-11-18T02:13:20\n {4}section On hold 2\n {4}6h 55m :done, 2026-11-18T02:13:20, 2026-11-18T09:08:37\n {4}section Review 2\n/);
  // The table: an On hold row for each, with its cause; then the Total's two parts.
  assert.match(md, /^\| Nov 17, 12:34 PM \| On hold 1 · blocked by #420 \| 12 h 36 min \| — \|\n\| Nov 18, 1:12 AM \| Plan \+ build · Opus 5\.5 \| 1 h \| \$7\.81 \|\n\| Nov 18, 2:12 AM \| Review 1 · Fable 5\.2 · ⏸️ Paused \| 21 s \| — \|\n\| Nov 18, 2:13 AM \| On hold 2 · waiting for a usage limit \| 6 h 55 min \| — \|$/m);
  assert.match(md, /^\| \| Working \| 2 h 14 min \| \|\n\| \| Waiting \| 19 h 31 min \| \|\n\| \| \*\*Total\*\* \| \*\*21 h 45 min\*\* \| \*\*\$15\.33\*\* \|$/m);
  assert.match(md, /^- \*\*Working and waiting:\*\* Waiting is the time on hold in the table, each from a recorded start and end/m);
  assert.match(md, /^- Nov 17, 12:34:26 PM blocked by #420: on hold\n- Nov 18, 1:10:43 AM no longer blocked by #420\n/m);
  assert.match(md, /^- Nov 18, 2:13:20 AM paused for a usage limit: on hold until the next stage$/m);
  // The summary carries the split and the waits, and reads back as written.
  const sum = finishSummary(d);
  assert.deepEqual([sum.wallMs, sum.workMs, sum.waitMs], [t.wall, t.worked, t.waited]);
  assert.deepEqual(sum.waits, [
    { kind: "blocked-by", why: "blocked-by", start: "2026-11-17T20:34:26Z", end: "2026-11-18T09:10:43Z", blockers: ["#420"] },
    { kind: "paused", why: "usage-limit", start: "2026-11-18T10:13:20Z", end: "2026-11-18T17:08:37Z" },
  ]);
  const body = withEnv(ZONE, () => finishCardBody(d));
  assert.deepEqual(readSummary(body, 421), sum);

  // Through the reads and the write (postFinishCard): the blocker is read once for its close, and the card says the same.
  const o = F.blockedThenPaused();
  const prs = () => [prOf(443, { merged_at: "2026-11-18T18:20:10Z", state: "closed", created_at: "2026-11-18T09:57:14Z", commits: 5, additions: 1749, deletions: 287, changed_files: 31 })];
  const fake = fakeObjective(o, prs);
  const gets = [];
  const inner = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if (!init.method || init.method === "GET") gets.push(new URL(url).pathname);
    return inner(url, init);
  };
  const closed = { ...o.issue, state: "closed", closed_at: "2026-11-18T18:20:13Z" };
  assert.equal(await over(fake, () => postFinishCard(repoOf("acme/app"), closed, { token: "t" }, { prBody: false })), "posted");
  const posted = fake.comments.find((c) => c.body.startsWith(finishMarker(421))).body;
  assert.match(posted, /\n### ✅ Merged · 2 h 14 min working, 19 h 31 min waiting · \$15\.33\n/);
  assert.deepEqual(readSummary(posted, 421).waits, sum.waits);
  assert.equal(gets.filter((p) => p === "/repos/acme/app/issues/420").length, 1);
  // A blocker GitHub will not show (a 404): the card is still written, without that wait.
  const hidden = fakeObjective({ ...o, blockers: [] }, prs);
  assert.equal(await over(hidden, () => postFinishCard(repoOf("acme/app"), closed, { token: "t" }, { prBody: false })), "posted");
  assert.deepEqual(readSummary(hidden.comments.find((c) => c.body.startsWith(finishMarker(421))).body, 421).waits.map((w) => w.kind), ["paused"]);
});

test("finish card (#614): a wait counts only with a recorded start and end; nothing is inferred from a gap", () => {
  const o = F.blockedThenPaused();
  const holds = (over) => withEnv(ZONE, () => finishData({ ...o, ...over })).holds.map((x) => [x.kind, x.start, x.end]);
  const paused = ["paused", "2026-11-18T10:13:20Z", "2026-11-18T17:08:37Z"];
  const added = o.timeline.find((e) => e.event === "blocked_by_added");
  // The blocker not read, still open, or closed only after the first stage began (its first close is not on record).
  assert.deepEqual(holds({ blockers: [] }), [paused]);
  assert.deepEqual(holds({ blockers: [{ repo: "acme/app", number: 420, state: "open", closed_at: null }] }), [paused]);
  assert.deepEqual(holds({ blockers: [{ repo: "acme/app", number: 420, state: "closed", closed_at: "2026-11-18T12:00:00Z" }] }), [paused]);
  // Another repository's issue of the same number is not this relation's.
  assert.deepEqual(holds({ blockers: [{ repo: "acme/other", number: 420, state: "closed", closed_at: "2026-11-18T09:10:43Z" }] }), [paused]);
  // No blocked-by event: the 12 hours before the first stage stay a gap, never a wait.
  const bare = withEnv(ZONE, () => finishData({ ...o, timeline: o.timeline.filter((e) => e !== added) }));
  assert.deepEqual(bare.holds.map((x) => x.kind), ["paused"]);
  assert.ok(withEnv(ZONE, () => renderFinishCard(bare)).startsWith("### ✅ Merged · 14 h 50 min working, 6 h 55 min waiting · $15.33\n"));
  // The relation removed before the blocker closed: the wait ends at the removal.
  assert.deepEqual(holds({ timeline: [...o.timeline, { event: "blocked_by_removed", created_at: "2026-11-18T02:00:00Z", blocked_by: added.blocked_by }] })[0], ["blocked-by", "2026-11-17T20:34:26Z", "2026-11-18T02:00:00Z"]);
  // A relation from before the label: the wait starts at the clock.
  assert.deepEqual(holds({ timeline: o.timeline.map((e) => (e === added ? { ...e, created_at: "2026-11-17T08:00:00Z" } : e)) })[0], ["blocked-by", "2026-11-17T20:34:21Z", "2026-11-18T09:10:43Z"]);
  // Two blockers whose waits overlap are one wait, naming both.
  const two = withEnv(ZONE, () => finishData({ ...o, timeline: [...o.timeline, { event: "blocked_by_added", created_at: "2026-11-17T21:00:00Z", blocked_by: { number: 419 } }], blockers: [...o.blockers, { repo: "acme/app", number: 419, state: "closed", closed_at: "2026-11-18T09:00:00Z" }] }));
  assert.deepEqual(two.holds[0], { kind: "blocked-by", why: "blocked-by", start: "2026-11-17T20:34:26Z", end: "2026-11-18T09:10:43Z", blockers: ["#420", "#419"], cause: "#420, #419" });
  assert.equal(finishTotals(two).waited, finishTotals(withEnv(ZONE, () => finishData(o))).waited, "time two waits share is counted once");
  // A pause no stage follows has no recorded end; a paused stage with no pause in its record is no wait at all.
  const cut = o.comments.filter((c) => !/:progress:review:(1795021703531|1795023645301) -->/.test(c.body));
  assert.deepEqual(holds({ comments: cut }).map((x) => x[0]), ["blocked-by"]);
  const unmarked = o.comments.map((c) => ({ ...c, body: c.body.replace('"limitPaused":true,', "") }));
  assert.deepEqual(holds({ comments: unmarked }).map((x) => x[0]), ["blocked-by"]);
  // The pause notice's words name nothing: only the stage's own record does.
  const stranger = o.comments.map((c) => (/:progress:review:1794996765735 -->/.test(c.body) ? { ...c, user: { login: "stranger", type: "User" } } : c));
  assert.deepEqual(holds({ comments: stranger }).map((x) => x[0]), ["blocked-by"]);
});

test("finish card (#614): a stage's spend line records a pause on a usage limit or an outage, and the card names each; a line from before reads as no pause", () => {
  const line = (usage) => spendParts((({ usd, parts }) => spendMarker(usd, parts))(stageSpendLine(usage)));
  const limit = line({ usd: 0, exit: "paused", usageLimit: { harness: "claude", reset: "2026-11-24T10:00:00Z" } });
  assert.deepEqual([limit.limitPaused, limit.outagePaused, limit.exit], [true, undefined, "paused"]);
  const outage = line({ usd: 0, exit: "paused", outage: { host: "api.anthropic.com", code: "ECONNRESET" } });
  assert.deepEqual([outage.limitPaused, outage.outagePaused, outage.exit], [undefined, true, "paused"]);
  // A Block that met an outage, or any other end, records no pause.
  assert.deepEqual([line({ usd: 0, exit: "blocked", outage: { host: "x" } }).outagePaused, line({ usd: 1, exit: "delivered" }).limitPaused], [undefined, undefined]);
  // Only an outage record marks one: a list, or anything else that is no record, does not.
  assert.deepEqual([[], "down", true].map((outage) => line({ usd: 0, exit: "paused", outage }).outagePaused), [undefined, undefined, undefined]);
  // The card: an outage's pause is its own cause.
  const o = F.blockedThenPaused();
  const comments = o.comments.map((c) => ({ ...c, body: c.body.replace('"limitPaused":true,', '"outagePaused":true,') }));
  const d = withEnv(ZONE, () => finishData({ ...o, comments }));
  assert.deepEqual(d.holds[1], { kind: "paused", start: "2026-11-18T10:13:20Z", end: "2026-11-18T17:08:37Z", why: "outage", cause: "an outage" });
  const md = withEnv(ZONE, () => renderFinishCard(d));
  assert.match(md, /^\| Nov 18, 2:13 AM \| On hold 2 · waiting for an outage \| 6 h 55 min \| — \|$/m);
  assert.match(md, /^Waited 12 h 36 min blocked by #420 and 6 h 55 min on an outage; /m);
  // A stage with no spend line: its usage record's own pause (an Actions stage that moved to another account).
  const bare = o.comments.map((c) => (/:progress:review:1794996765735 -->/.test(c.body) ? { ...c, body: c.body.split("\n").filter((l) => !l.startsWith("<!-- pendulum:spend") && !l.startsWith("<!-- pendulum:ledger")).join("\n") } : c));
  const record = { artifact: "pendulum-usage-421-review", progressRun: "1794996765735", usd: 0, exit: "waiting", usageLimit: { harness: "claude", reset: null, noReset: true }, harness: "claude", model: "claude-fable-5-2" };
  assert.equal(withEnv(ZONE, () => finishData({ ...o, comments: bare, records: [record] })).holds[1].why, "usage-limit");
  assert.equal(withEnv(ZONE, () => finishData({ ...o, comments: bare, records: [{ ...record, usageLimit: undefined }] })).holds.length, 1, "a wait for another reason names no pause");
  assert.equal(withEnv(ZONE, () => finishData({ ...o, comments: bare, records: [{ ...record, usageLimit: [] }] })).holds.length, 1, "a list is no usage-limit record");
  assert.equal(withEnv(ZONE, () => finishData({ ...o, comments: bare, records: [{ ...record, exit: "paused", usageLimit: undefined, outage: [] }] })).holds.length, 1, "nor an outage's");
});

test("finish card (#614): an Objective with no waits looks as before, its summary says so, and a card from before waits were recorded still reads", () => {
  for (const [name, make] of Object.entries({ mergedClean: F.mergedClean, closedUnmerged: F.closedUnmerged, blockedEnd: F.blockedEnd, questionEnd: F.questionEnd })) {
    const md = card(make);
    assert.equal(shown(md), SNAP[name], name);
    assert.doesNotMatch(md, /working|Working|waiting|Waiting|Waited|On hold/, name);
    const sum = finishSummary(data(make));
    assert.deepEqual([sum.workMs, sum.waitMs, sum.waits], [sum.wallMs, 0, []], name);
  }
  assert.ok(card(F.mergedClean).startsWith("### ✅ Merged in 37 min 33 s · $3.67 + unknown\n"));
  // A card from before #614: its summary line has none of the three fields. It reads as it did, its waits not recorded.
  const d = data(F.blockedThenPaused);
  const now = withEnv(ZONE, () => summaryMarker(d));
  const v = JSON.parse(/summary (\{.*\}) -->$/.exec(now)[1]);
  const { workMs: _w, waitMs: _m, waits: _s, ...before } = v;
  const old = readSummary(`${finishMarker(421)}\n<!-- pendulum:421:summary ${JSON.stringify(before)} -->`, 421);
  const read = readSummary(`${finishMarker(421)}\n${now}`, 421);
  assert.deepEqual([old.workMs, old.waitMs, old.waits], [null, null, null]);
  assert.deepEqual({ ...old, workMs: read.workMs, waitMs: read.waitMs, waits: read.waits }, read, "every other figure reads the same");
  // A broken waits list is no record of waits, never a card that cannot be read.
  const broken = readSummary(`${finishMarker(421)}\n<!-- pendulum:421:summary ${JSON.stringify({ ...v, waits: [{ kind: "nap", why: null, start: "x", end: "y" }] })} -->`, 421);
  assert.deepEqual([broken.waits, broken.workMs, broken.cost], [null, null, read.cost]);
});

test("finish card (#614): waits that overlap share no time: each is cut to the part no earlier wait covers, so the causes add up to the waiting total", () => {
  const o = F.blockedThenPaused();
  // A Block of the dispatcher's while #420 still blocked the Objective: its hold would run to the first stage's start.
  const notice = { ...F.notice(421, "blocked", "0", "2026-11-17T21:00:00Z", "setup") };
  const d = withEnv(ZONE, () => finishData({ ...o, comments: [notice, ...o.comments] }));
  assert.deepEqual(d.holds.map((x) => [x.kind, x.why, x.start, x.end]), [
    ["blocked-by", "blocked-by", "2026-11-17T20:34:26Z", "2026-11-18T09:10:43Z"],
    ["blocked", "you", "2026-11-18T09:10:43Z", "2026-11-18T09:12:03Z"],
    ["paused", "usage-limit", "2026-11-18T10:13:20Z", "2026-11-18T17:08:37Z"],
  ]);
  const t = finishTotals(d);
  assert.equal(d.holds.reduce((n, x) => n + (Date.parse(x.end) - Date.parse(x.start)), 0), t.waited, "the waits' lengths are the waiting total");
  assert.equal(t.worked + t.waited, t.wall);
  const md = withEnv(ZONE, () => renderFinishCard(d));
  assert.match(md, /^Waited 12 h 36 min blocked by #420, 1 min 20 s for you and 6 h 55 min on a usage limit; 21 h 45 min from the label to the merge\.$/m);
  assert.match(md, /^\| Nov 18, 1:10 AM \| On hold 2 · waiting for you \| 1 min 20 s \| — \|$/m);
  assert.match(md, /^\| \| Waiting \| 19 h 32 min \| \|$/m);
  assert.deepEqual(finishSummary(d).waits.map((w) => w.start), d.holds.map((x) => x.start));
  // A notice hold wholly inside an earlier wait adds nothing.
  const inside = withEnv(ZONE, () => finishData({ ...o, comments: [notice, ...o.comments], blockers: [{ repo: "acme/app", number: 420, state: "closed", closed_at: "2026-11-18T09:12:03Z" }] }));
  assert.deepEqual(inside.holds.map((x) => x.kind), ["blocked-by", "paused"]);
});

test("finish card (#614): a blocking issue is read in the repository its event names, never as this repository's issue of the same number; a managed user's owner name is taken", () => {
  const o = F.blockedThenPaused();
  const named = (full_name) => o.timeline.map((e) => (e.event === "blocked_by_added" ? { ...e, blocked_by: { number: 420, repository: { full_name } } } : e));
  const closed = (repo) => [{ repo, number: 420, state: "closed", closed_at: "2026-11-18T09:10:43Z" }];
  const first = (over) => withEnv(ZONE, () => finishData({ ...o, ...over })).holds[0];
  // Another repository's issue: its own name on the card, and this repository's #420 is not its close.
  assert.deepEqual([first({ timeline: named("acme/other"), blockers: closed("acme/other") }).blockers, first({ timeline: named("acme/other"), blockers: closed("acme/app") }).kind], [["acme/other#420"], "paused"]);
  // A managed user's repository (an underscore and the enterprise's short code).
  assert.deepEqual(first({ timeline: named("mona-cat_octo/app"), blockers: closed("mona-cat_octo/app") }).blockers, ["mona-cat_octo/app#420"]);
  assert.deepEqual(blockersToRead("acme/app", named("mona-cat_octo/app"), "2026-11-18T09:12:03Z"), [{ repo: "mona-cat_octo/app", number: 420 }]);
  // A name the card would not print: left out, and nothing is read for it.
  for (const bad of ["emu_user_x/app", "a/b/c", "<b>/app", "", 7]) {
    assert.equal(first({ timeline: named(bad), blockers: closed("acme/app") }).kind, "paused", String(bad));
    assert.deepEqual(blockersToRead("acme/app", named(bad), "2026-11-18T09:12:03Z"), [], String(bad));
  }
  // No repository named: this one. Only relations added before the first stage are read, each once.
  const later = { event: "blocked_by_added", created_at: "2026-11-18T12:00:00Z", blocked_by: { number: 500 } };
  assert.deepEqual(blockersToRead("acme/app", [...o.timeline, later, o.timeline[1]], "2026-11-18T09:12:03Z"), [{ repo: "acme/app", number: 420 }]);
  assert.deepEqual(blockersToRead("acme/app", o.timeline, undefined), [], "no stage: nothing to read");
  // A summary's blockers read back with such a name.
  const d = withEnv(ZONE, () => finishData({ ...o, timeline: named("mona-cat_octo/app"), blockers: closed("mona-cat_octo/app") }));
  assert.deepEqual(readSummary(withEnv(ZONE, () => finishCardBody(d)), 421).waits[0].blockers, ["mona-cat_octo/app#420"]);
});

test("finish card (#614): the blocker's read through postFinishCard and endCard: another repository's, a refusal leaves the wait out, a rate limit or a 5xx fails the write for a later one", async () => {
  const o = F.blockedThenPaused();
  const repo = repoOf("acme/app");
  const prs = () => [prOf(443, { merged_at: "2026-11-18T18:20:10Z", state: "closed", created_at: "2026-11-18T09:57:14Z" })];
  const closed = { ...o.issue, state: "closed", closed_at: "2026-11-18T18:20:13Z" };
  const cardOf = (fake) => fake.comments.find((c) => c.body.startsWith(finishMarker(421)))?.body;
  const post = (fake) => over(fake, () => postFinishCard(repo, closed, { token: "t" }, { prBody: false }));
  // Another repository's blocker: read there.
  const other = { ...o, timeline: o.timeline.map((e) => (e.event === "blocked_by_added" ? { ...e, blocked_by: { number: 7, repository: { full_name: "acme/other" } } } : e)), blockers: [{ repo: "acme/other", number: 7, state: "closed", closed_at: "2026-11-18T09:10:43Z" }] };
  const cross = fakeObjective(other, prs);
  assert.equal(await post(cross), "posted");
  assert.match(cardOf(cross), /^Waited 12 h 36 min blocked by acme\/other#7 and 6 h 55 min on a usage limit; /m);
  // A plain 403 (a repository this token may not read): the card without that wait.
  const refused = fakeObjective({ ...o, blockers: [{ repo: "acme/app", number: 420, status: 403 }] }, prs);
  assert.equal(await post(refused), "posted");
  assert.deepEqual(readSummary(cardOf(refused), 421).waits.map((w) => w.kind), ["paused"]);
  // A rate-limited 403, and a 5xx: no card is written with a wait missing; the write fails, for a later one.
  const limited = fakeObjective({ ...o, blockers: [{ repo: "acme/app", number: 420, status: 403, headers: { "retry-after": "1" } }] }, prs);
  await assert.rejects(over(limited, () => postFinishCard(repo, closed, { token: "t", noRateWait: true }, { prBody: false })), (e) => e.rateLimited === true && e.status === 403);
  assert.equal(cardOf(limited), undefined);
  const down = fakeObjective({ ...o, blockers: [{ repo: "acme/app", number: 420, status: 502 }] }, prs);
  await assert.rejects(post(down), (e) => e.status === 502);
  assert.equal(cardOf(down), undefined);
  // A Block's card (endCard) reads the blocker too: the wait before the first stage is on it.
  const open = () => [prOf(443, { merged_at: null, draft: true, state: "open", created_at: "2026-11-18T09:57:14Z" })];
  const blocked = fakeObjective({ ...o, comments: o.comments.filter((c) => !/:progress:review:1795023645301 -->/.test(c.body)) }, open);
  assert.equal(await over(blocked, () => endCard(repo, o.issue, { token: "t" }, { exit: "blocked", reason: "findings stay open.", now: Date.parse("2026-11-18T17:40:00Z") })), "posted");
  assert.match(cardOf(blocked), /\n### ⛔ Blocked · 1 h 34 min working, 19 h 31 min waiting · /);
  assert.match(cardOf(blocked), /^Waited 12 h 36 min blocked by #420 and 6 h 55 min on a usage limit; 21 h 5 min from the label to the Block\.$/m);
});
