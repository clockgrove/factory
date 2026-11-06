import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlockedBy, priorityOf, selectReady, stateOf, sumSpend } from "../scripts/lib/logic.mjs";

const issue = (number, labels = [], body = "", extra = {}) => ({ number, labels: labels.map((name) => ({ name })), body, ...extra });

test("priority: P0 before P1 before P2 before unlabelled, then by number", () => {
  const issues = [issue(30, ["P2"]), issue(10), issue(20, ["P0"]), issue(15, ["P1"]), issue(12, ["P0"])];
  const { ready } = selectReady({ issues, maxConcurrent: 10, dailyUsd: 100, spentToday: 0 });
  assert.deepEqual(ready, [12, 20, 15, 30, 10]);
  assert.equal(priorityOf(issue(1, ["bug", "P1"])), 1);
  assert.equal(priorityOf(issue(1, ["P2", "P0"])), 0);
});

test("blocked by an open issue (body lines) is skipped; closed blockers do not block", () => {
  const issues = [issue(1, [], "Blocked by #5"), issue(2, [], "- blocked-by: #6, #7"), issue(3, [], "Blocked by: #9")];
  const { ready, skipped } = selectReady({ issues, openIssues: new Set([5, 7]), maxConcurrent: 5, dailyUsd: 100 });
  assert.deepEqual(ready, [3]);
  assert.deepEqual(skipped.map((s) => [s.number, s.reason]), [[1, "blocked by #5"], [2, "blocked by #7"]]);
  assert.deepEqual(parseBlockedBy("intro\nBlocked by #12 and #13\nnot a blocker #99"), [12, 13]);
  assert.deepEqual(parseBlockedBy("Depends on #4"), []);
});

test("REST blocked-by relations win over body lines when present", () => {
  const issues = [issue(1, [], "Blocked by #5", { blockedBy: [{ number: 8, state: "open" }] }), issue(2, [], "Blocked by #5", { blockedBy: [{ number: 5, state: "closed" }] })];
  const { ready, skipped } = selectReady({ issues, openIssues: new Set([5]), maxConcurrent: 5, dailyUsd: 100 });
  assert.deepEqual(ready, [2]);
  assert.equal(skipped[0].reason, "blocked by #8");
});

test("Running, Blocked, Question and In review are excluded, from the card first, then the label", () => {
  const issues = [issue(1), issue(2, ["factory:running"]), issue(3, ["factory:blocked"]), issue(4, ["factory:question"]), issue(5), issue(6, ["factory:in-review"])];
  const statuses = { 1: "Queued", 5: "Running" };
  const { ready, running, skipped } = selectReady({ issues, statuses, maxConcurrent: 10, dailyUsd: 100 });
  assert.deepEqual(ready, [1]);
  assert.equal(running, 2);
  assert.deepEqual(skipped.map((s) => s.reason), ["Running", "Blocked", "Question", "Running", "In review"]);
  assert.equal(stateOf(issue(9, ["factory:blocked"]), "Queued"), "Blocked", "a Queued card with a blocked label: the label wins");
  assert.equal(stateOf(issue(9, ["factory:blocked"]), "Running"), "Running", "a non-Queued card wins over the label");
});

test("max_concurrent minus running caps the start list", () => {
  const issues = [issue(1), issue(2), issue(3), issue(4, ["factory:running"]), issue(5, ["factory:running"])];
  const r = selectReady({ issues, maxConcurrent: 4, dailyUsd: 100 });
  assert.deepEqual(r.ready, [1, 2]);
  assert.equal(r.running, 2);
  assert.ok(r.skipped.some((s) => s.number === 3 && s.reason === "max_concurrent reached"));
  const full = selectReady({ issues, maxConcurrent: 2, dailyUsd: 100 });
  assert.deepEqual(full.ready, []);
  assert.equal(full.reason, "max_concurrent reached");
});

test("daily_usd reached starts nothing; unmetered usage counts as zero", () => {
  const records = [{ usd: 40.5 }, { usd: null }, { usd: 60 }, { usd: "x" }];
  assert.equal(sumSpend(records), 100.5);
  const r = selectReady({ issues: [issue(1, ["P0"])], maxConcurrent: 3, dailyUsd: 100, spentToday: sumSpend(records) });
  assert.deepEqual(r.ready, []);
  assert.equal(r.reason, "daily_usd reached");
  assert.match(r.skipped[0].reason, /daily_usd reached \(\$100\.50 of \$100\)/);
  const under = selectReady({ issues: [issue(1)], maxConcurrent: 3, dailyUsd: 100, spentToday: 99.99 });
  assert.deepEqual(under.ready, [1]);
  const uncapped = selectReady({ issues: [issue(1)], maxConcurrent: 3, dailyUsd: 0, spentToday: 1e6 });
  assert.deepEqual(uncapped.ready, [1], "daily_usd 0 means no daily cap");
});

test("integration failure: a behind (no queue) or conflicting (any) In-review PR goes back once, then Blocks; drafts and clean PRs are left alone", async () => {
  const { staleDecision } = await import("../scripts/lib/logic.mjs");
  const behind = { draft: false, auto_merge: null, mergeable_state: "behind" };
  assert.equal(staleDecision({ pr: behind }), "update", "no queue: GitHub updates a behind branch; no worker");
  assert.equal(staleDecision({ pr: { ...behind, mergeable_state: "dirty" } }), "rebase");
  assert.equal(staleDecision({ pr: { ...behind, mergeable_state: "dirty" }, rebaseMarkers: 1 }), "blocked", "second conflict is integration failed twice");
  assert.equal(staleDecision({ pr: { ...behind, mergeable_state: "clean" } }), "ignore");
  assert.equal(staleDecision({ pr: { ...behind, draft: true } }), "ignore");
  assert.equal(staleDecision({ pr: null }), "ignore");
  assert.equal(staleDecision({ pr: behind, queue: true }), "ignore", "with a queue, behind is the queue's job");
  assert.equal(staleDecision({ pr: { ...behind, mergeable_state: "dirty" }, queue: true }), "rebase", "with a queue, an evicted conflicting PR goes back");
  assert.equal(staleDecision({ pr: { ...behind, mergeable_state: "dirty" }, queue: true, rebaseMarkers: 1 }), "blocked");
});

test("staleDecision: a PR whose review job is running is left alone", async () => {
  const { staleDecision } = await import("../scripts/lib/logic.mjs");
  const behind = { draft: false, mergeable_state: "behind" };
  assert.equal(staleDecision({ pr: behind, reviewing: true }), "ignore");
  assert.equal(staleDecision({ pr: behind, reviewing: false }), "update");
});

test("staleDecision: a conflicting PR goes back even with the review label (no review run can exist for it)", async () => {
  const { staleDecision } = await import("../scripts/lib/logic.mjs");
  assert.equal(staleDecision({ pr: { draft: false, mergeable_state: "dirty" }, reviewing: true }), "rebase");
  assert.equal(staleDecision({ pr: { draft: false, mergeable_state: "behind" }, reviewing: true }), "ignore");
});
