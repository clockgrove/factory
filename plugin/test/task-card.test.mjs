import "./temp.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";
import { PENDULUM_PROTECTED, protectedPaths, protectedTouched, renderTaskCard } from "../scripts/lib/logic.mjs";
import { buildPrompt } from "../scripts/lib/session.mjs";


test("a missing placeholder value is an error, not an empty string", () => {
  assert.throws(() => renderTaskCard("hi {{issue}} {{nope}}", { issue: 1 }), /missing values for nope/);
});

test("the prompt is the card followed by the issue verbatim", () => {
  const prompt = buildPrompt({ templatePath: join(PLUGIN_ROOT, "templates", "task-card.md"), issue: 7, issueTitle: "Add thing", issueBody: "## Goal\nDo it.\n\n## Decisions\n- keep X", maxUsd: 10, timeoutMinutes: 60, validation: ["make test"], budgetCommand: "", protectedList: PENDULUM_PROTECTED });
  const [card, issue] = prompt.split("\n---\n");
  assert.match(card, /issue #7/);
  assert.match(issue, /Issue #7: Add thing\n\n## Goal\nDo it\.\n\n## Decisions\n- keep X/);
});

test("protected paths: Pendulum's list plus the repository's, deduped; directory and file rules", () => {
  const list = protectedPaths([".github/", " scripts/test-budget.json ", ""]);
  assert.deepEqual(list, [".github/", "CODEOWNERS", ".agents/skills/", ".claude/", ".codex/", "scripts/test-budget.json"]);
  assert.deepEqual(protectedTouched([".github/workflows/ci.yml", "src/a.ts", "docs/CODEOWNERS", "scripts/test-budget.json", ".claude/agents/implementer.md"], list), [".github/workflows/ci.yml", "docs/CODEOWNERS", "scripts/test-budget.json", ".claude/agents/implementer.md"]);
  assert.deepEqual(protectedTouched(["src/x.ts"], list), []);
});


test("maintainer decisions: people who can push, no bots or Pendulum markers, oldest first; the answer prompt carries them", async () => {
  const { maintainerDecisions, decisionsSection } = await import("../scripts/lib/logic.mjs");
  const { answerPrompt } = await import("../scripts/review.mjs");
  const c = (login, assoc, type, at, body) => ({ user: { login, type }, author_association: assoc, created_at: at, body });
  const decisions = maintainerDecisions([
    c("owner", "OWNER", "User", "2026-11-07T09:52:00Z", "Answer: follow the participant set."),
    c("pendulum[bot]", "NONE", "Bot", "2026-11-07T09:40:00Z", "Plan."),
    c("owner", "OWNER", "User", "2026-11-07T09:30:00Z", "<!-- pendulum:14:plan -->\nnot a decision"),
    c("stranger", "NONE", "User", "2026-11-07T09:31:00Z", "Answer: ship it as is."),
    c("member", "MEMBER", "User", "2026-11-07T09:10:00Z", "Keep the 1024-octet bound."),
  ]);
  // Who may decide is checked by write access in objectiveDecisions, not here: a private org member reads as CONTRIBUTOR.
  assert.deepEqual(decisions.map((d) => d.author), ["member", "stranger", "owner"]);
  const { setWriters, pushAuthor, trustedAuthor, knownWriter } = await import("../scripts/lib/logic.mjs");
  const privateMember = { user: { login: "kirk-private", type: "User" }, author_association: "CONTRIBUTOR" };
  assert.equal(trustedAuthor(privateMember), false);
  assert.equal(knownWriter("kirk-private"), null);
  setWriters("o/r", ["kirk-private"]);
  assert.equal(trustedAuthor(privateMember), true);
  setWriters("o/other", []);
  assert.equal(trustedAuthor(privateMember), false);
  // What an App saw on a real adopter: the owner as CONTRIBUTOR and an empty writer list; the workflow's notify user counts.
  const { setMaintainers } = await import("../scripts/lib/logic.mjs");
  setWriters("o/r", []);
  assert.equal(knownWriter("kirk-private"), null, "an empty writer list is not a no");
  setMaintainers("o/r", [" @Kirk-Private"]);
  assert.equal(trustedAuthor(privateMember), false, "a bare login is trusted for nothing: it could be renamed away and re-registered");
  setMaintainers("o/r", [" @Kirk-Private#4242"]);
  assert.equal(trustedAuthor({ ...privateMember, user: { ...privateMember.user, id: 4242 } }), true);
  assert.equal(trustedAuthor({ ...privateMember, user: { ...privateMember.user, id: 9999 } }), false, "the login, renamed away and registered by someone else");
  assert.equal(trustedAuthor({ user: { login: "kirk-renamed", type: "User", id: 4242 }, author_association: "CONTRIBUTOR" }), true, "the same account after its own rename");
  assert.equal(trustedAuthor({ user: { login: "stranger", type: "User" }, author_association: "CONTRIBUTOR" }), false);
  assert.equal(pushAuthor({ user: { login: "someone", type: "User" }, author_association: "NONE" }), false);
  assert.match(decisionsSection(decisions), /Keep the 1024-octet bound[\s\S]*participant set/);
  assert.equal(decisionsSection([]), "");
  const p = answerPrompt({ taskCard: "", prNumber: 32, comments: [], decisions });
  assert.match(p, /answered PR #32's question/);
  assert.match(p, /participant set/);
  // A maintainer's change no pass has read (no Question): the answer pass is told so, with the decision.
  const q = answerPrompt({ taskCard: "", prNumber: 59, comments: [], decisions, afterPush: true });
  assert.match(q, /commented on PR #59 after the last pass read the decisions/);
  assert.match(q, /participant set/);
  assert.doesNotMatch(q, /QUESTION:/);
});

test("unread decisions: what no pass read, or edited after the version read; Pendulum's own review threads are not decisions", async () => {
  const { maintainerDecisions, decisionsRead, decisionsReadMarker, decisionsReadOf, mergeRead, unreadDecisions, setWriters } = await import("../scripts/lib/logic.mjs");
  setWriters("o/r", []);
  const dev = { login: "kirk", type: "User" };
  const at = (m) => `2026-11-07T10:${String(m).padStart(2, "0")}:00Z`;
  const comments = [
    { kind: "comment", id: 1, user: dev, author_association: "OWNER", created_at: at(1), body: "Keep the bound." },
    { kind: "comment", id: 2, user: dev, author_association: "OWNER", created_at: at(2), updated_at: at(30), body: "Use the new name (edited)." },
    // Local mode: Pendulum's review, its inline finding and the worker's reply all post as the developer's login.
    { kind: "review", id: 70, user: dev, author_association: "OWNER", created_at: at(3), body: "<!-- pendulum:5:review -->\nPendulum reviewer: one pass." },
    { kind: "line", id: 71, pull_request_review_id: 70, user: dev, author_association: "OWNER", created_at: at(3), body: "a.js:4: acceptance 1: off by one." },
    { kind: "line", id: 72, pull_request_review_id: 99, in_reply_to_id: 71, user: dev, author_association: "OWNER", created_at: at(4), body: "a.js:4: Fixed in abc123." },
    // A different maintainer's reply in that thread is their word, and so is a line comment in a review of their own.
    { kind: "line", id: 73, pull_request_review_id: 98, in_reply_to_id: 71, user: { login: "maria", type: "User" }, author_association: "MEMBER", created_at: at(5), body: "a.js:4: No, keep it inclusive." },
    { kind: "line", id: 74, pull_request_review_id: 97, user: dev, author_association: "OWNER", created_at: at(6), body: "b.js:9: This regressed the export." },
  ];
  const decisions = maintainerDecisions(comments);
  assert.deepEqual(decisions.map((d) => d.key), ["comment:1", "comment:2", "line:73", "line:74"]);
  assert.equal(decisions[1].seen, at(30), "an edit is the version a pass must read");

  // The worker read the first two before its run; the line comments came during it, one comment was edited after.
  const worker = decisionsRead(decisions.slice(0, 2).map((d) => ({ ...d, seen: d.at })));
  const self = "pendulum[bot]";
  const progress = (login, body, extra = {}) => ({ user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, author_association: "OWNER", body: `<!-- pendulum:5:progress:work:1 -->\nPendulum work run 1\n${body}`, ...extra });
  const issueComments = [
    progress(self, decisionsReadMarker(worker)),
    // Only Pendulum's own progress comments count: another bot, a maintainer, or a marker outside a progress comment do not.
    progress("other-app[bot]", decisionsReadMarker({ "line:74": at(59) })),
    progress("kirk", decisionsReadMarker({ "line:73": at(59) })),
    { user: { login: self, type: "Bot" }, body: decisionsReadMarker({ "comment:2": at(59) }) },
    // A malformed record is ignored, never an error: its decisions stay unread.
    progress(self, "<!-- pendulum:decisions-read {nope} -->"),
  ];
  const read = decisionsReadOf(issueComments, { issue: 5, self });
  assert.deepEqual(unreadDecisions(decisions, read).map((d) => d.key), ["comment:2", "line:73", "line:74"]);
  // In local mode Pendulum posts as the developer: their progress comments are the record there.
  assert.deepEqual(Object.keys(decisionsReadOf(issueComments, { issue: 5, self: "Kirk" })), ["line:73"]);
  assert.throws(() => decisionsReadOf(issueComments, { issue: 5, self: null }), /own login is unknown/);
  // The review's answer pass read them all: nothing unread, so the merge may go ahead.
  assert.deepEqual(unreadDecisions(decisions, mergeRead(read, decisionsRead(decisions))), []);
  // No record at all (a PR from before the record existed): every decision is unread, an answer pass rather than a merge.
  assert.equal(unreadDecisions(decisions, {}).length, 4);
});
