import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBlockedBy, pooled, priorityOf, selectReady, stateOf, sumSpend } from "../scripts/lib/logic.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

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
  // The board has no Question column: a Question's card sits in In review, and its label says Question (#57).
  assert.equal(stateOf(issue(9, ["factory:question"]), "In review"), "Question");
  assert.equal(stateOf(issue(9, ["factory:in-review"]), "In review"), "In review");
  assert.equal(stateOf(issue(9, ["factory:question"]), "Running"), "Running", "a stale question label on a Running card is no Question");
  assert.deepEqual(selectReady({ issues: [issue(4, ["factory:question"])], statuses: { 4: "In review" }, maxConcurrent: 10, dailyUsd: 100 }).skipped, [{ number: 4, reason: "Question" }]);
});

test("a held Queued issue (a requeue's backoff) is skipped with its reason and takes no slot", () => {
  const issues = [issue(1, ["P0"]), issue(2), issue(3)];
  const r = selectReady({ issues, held: { 1: "quota waiting; next try in 7 min" }, maxConcurrent: 1, dailyUsd: 100 });
  assert.deepEqual(r.ready, [2]);
  assert.deepEqual(r.skipped.map((s) => [s.number, s.reason]), [[1, "quota waiting; next try in 7 min"], [3, "max_concurrent reached"]]);
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

test("integration failure: a behind (no queue) or conflicting (any) In-review PR goes back each time, Blocking only when stuck or at the bound; drafts and clean PRs are left alone", async () => {
  const { REBASE_LIMIT, staleDecision } = await import("../scripts/lib/logic.mjs");
  const behind = { draft: false, auto_merge: null, mergeable_state: "behind" };
  const dirty = { ...behind, mergeable_state: "dirty" };
  const stuck = { from: "a".repeat(40), base: "b".repeat(40), files: ["docs/decisions.md"] };
  assert.equal(REBASE_LIMIT, 5);
  assert.equal(staleDecision({ pr: behind }), "update", "no queue: GitHub updates a behind branch; no worker");
  assert.equal(staleDecision({ pr: dirty }), "rebase");
  assert.equal(staleDecision({ pr: dirty, rebases: 1 }), "rebase", "a conflict after a rebase, on a new base, goes back again");
  assert.equal(staleDecision({ pr: dirty, rebases: REBASE_LIMIT - 1 }), "rebase");
  assert.equal(staleDecision({ pr: dirty, rebases: REBASE_LIMIT }), "limit", "the bound");
  assert.equal(staleDecision({ pr: dirty, rebases: 1, stuck }), "stuck", "the same conflict on the same base");
  assert.equal(staleDecision({ pr: { ...behind, mergeable_state: "clean" } }), "ignore");
  // A review job that began before a sibling's merge made the PR conflict is still running: no send-back to race it.
  assert.equal(staleDecision({ pr: dirty, reviewing: true, reviewRunning: true }), "ignore");
  assert.equal(staleDecision({ pr: dirty, reviewing: true, reviewRunning: false }), "rebase", "labelled but no review job alive: back to rebase");
  assert.equal(staleDecision({ pr: { ...behind, draft: true } }), "ignore");
  assert.equal(staleDecision({ pr: null }), "ignore");
  assert.equal(staleDecision({ pr: behind, queue: true }), "ignore", "with a queue, behind is the queue's job");
  assert.equal(staleDecision({ pr: dirty, queue: true }), "rebase", "with a queue, an evicted conflicting PR goes back");
  assert.equal(staleDecision({ pr: dirty, queue: true, rebases: 1 }), "rebase");
  assert.equal(staleDecision({ pr: dirty, queue: true, rebases: REBASE_LIMIT }), "limit");
});

test("conflictsAt: only GitHub's conflict on the head the stage pushed ends the check wait", async () => {
  const { conflictsAt } = await import("../scripts/lib/logic.mjs");
  const sha = "a".repeat(40);
  assert.equal(conflictsAt({ head: { sha }, mergeable: false, mergeable_state: "dirty" }, sha), true);
  assert.equal(conflictsAt({ head: { sha: "b".repeat(40) }, mergeable: false, mergeable_state: "dirty" }, sha), false, "a read still about the head before the push");
  assert.equal(conflictsAt({ head: { sha }, mergeable: null, mergeable_state: "unknown" }, sha), false, "not worked out yet");
  assert.equal(conflictsAt({ head: { sha }, mergeable: true, mergeable_state: "behind" }, sha), false);
  assert.equal(conflictsAt(null, sha), false);
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

test("blocking: an issue whose REST relations were rate limited is not picked this tick, even with no body lines", () => {
  const issues = [issue(4, [], "", { relationsUnread: true }), issue(6)];
  const { ready, skipped } = selectReady({ issues, maxConcurrent: 5, dailyUsd: 100 });
  assert.deepEqual(ready, [6]);
  assert.match(skipped.find((s) => s.number === 4).reason, /rate limited/);
});

test("pooled: at most `size` at once, results in order", async () => {
  let live = 0;
  let most = 0;
  const out = await pooled([5, 1, 4, 2, 3, 0, 6, 7, 8, 9], 3, async (x) => {
    most = Math.max(most, (live += 1));
    await new Promise((r) => setTimeout(r, x));
    live -= 1;
    return x * 2;
  });
  assert.deepEqual(out, [10, 2, 8, 4, 6, 0, 12, 14, 16, 18]);
  assert.equal(most, 3);
  assert.deepEqual(await pooled([], 6, async () => 1), []);
});

test("queueSince: drops count from the latest of the review, the head's commit and the last re-entry or Block; unknown or future times are left out (#9)", async () => {
  const { queueSince } = await import("../scripts/lib/logic.mjs");
  const now = Date.parse("2026-11-10T12:00:00Z");
  assert.equal(queueSince(["2026-11-09T10:00:00Z", "2026-11-10T09:00:00Z", "2026-11-10T08:00:00Z"], now), "2026-11-10T09:00:00Z");
  assert.equal(queueSince(["2026-11-09T10:00:00Z", null, "2026-11-10T08:00:00Z"], now), "2026-11-10T08:00:00Z", "a re-entry after the review moves the bound");
  assert.equal(queueSince(["2026-11-09T10:00:00Z", "2027-01-01T00:00:00Z", "x"], now), "2026-11-09T10:00:00Z", "a commit date in the future never puts every drop out of count");
  assert.equal(queueSince([null, undefined], now), null);
});

test("queueRetry: a PR the merge queue dropped goes back in once; dropped again since its review, it Blocks with the queue's codes", async () => {
  const { HUNG_CODE, QUEUE_TRIES, STALL_CODE, queueRetry } = await import("../scripts/lib/logic.mjs");
  const since = "2026-11-09T09:30:00Z";
  const q = "github-merge-queue";
  const timedOut = { at: "2026-11-09T10:40:04Z", reason: "checks_timed_out", actor: q };
  const lastOf = (r) => ({ at: r.at, code: r.reason });
  assert.equal(QUEUE_TRIES, 2);
  assert.deepEqual(queueRetry([], { since }), { enqueue: true, drops: 0, last: null }, "never queued: the first enqueue");
  assert.deepEqual(queueRetry([timedOut], { since }), { enqueue: true, drops: 1, last: lastOf(timedOut) }, "#295's drop (no CI run on the queue's commit): enqueued once more");
  const again = queueRetry([timedOut, { at: "2026-11-09T11:45:00Z", reason: "failed_checks", actor: q }], { since });
  assert.equal(again.drops, 2);
  assert.match(again.block, /dropped the reviewed PR 2 times.*\(checks_timed_out, failed_checks\)/, "the notice names why");
  assert.deepEqual(queueRetry([{ at: "2026-11-09T08:00:00Z", reason: "checks_timed_out", actor: q }, { at: "2026-11-09T09:00:00Z", reason: "checks_timed_out", actor: q }, timedOut], { since }), { enqueue: true, drops: 1, last: lastOf(timedOut) }, "drops before the review the merge rests on belong to an earlier review");
  assert.deepEqual(queueRetry([{ at: "2026-11-09T11:08:05Z", reason: "merged", actor: q }, timedOut], { since }), { enqueue: true, drops: 1, last: lastOf(timedOut) }, "leaving the queue merged is no drop");
  assert.match(queueRetry([timedOut, { at: "2026-11-09T11:00:00Z", reason: "<b>x</b>", actor: q }], { since }).block, /\(checks_timed_out, unknown\)/, "only GitHub's plain codes reach the notice");
  assert.equal(queueRetry([{ at: "2026-11-09T10:40:04Z", reason: "checks_timed_out", actor: null }], { since }).drops, 1, "a removal with no actor is the queue's");
  assert.equal(queueRetry([{ at: "2026-11-09T10:40:04Z", reason: "dequeued", actor: "some-automation", person: false }], { since }).drops, 1, "a bot's removal is a drop: only a person's is a hold");

  // A person's removal (a writer's dequeue) is a hold: Factory neither puts it back nor counts it toward the Block.
  const manual = { at: "2026-11-09T10:50:00Z", reason: "dequeued", actor: "kirk", person: true };
  assert.deepEqual(queueRetry([manual], { since }), { hold: { at: manual.at, code: "dequeued" }, drops: 0 }, "a hand removal stays out");
  assert.deepEqual(queueRetry([timedOut, manual], { since, self: "factory-app[bot]" }).hold, { at: manual.at, code: "dequeued" }, "a hand removal after a drop is still a hold");
  assert.deepEqual(queueRetry([manual, { at: "2026-11-09T11:30:00Z", reason: "failed_checks", actor: q }], { since }), { enqueue: true, drops: 1, last: { at: "2026-11-09T11:30:00Z", code: "failed_checks" } }, "re-enqueued by the person and dropped by the queue: one drop, the hold not counted");
  assert.equal(queueRetry([manual, manual], { since: "2026-11-09T11:00:00Z" }).enqueue, true, "a new review after the hold puts it back");

  // Factory's own removal of a stalled entry is a drop, by its login (the timeline names the App without [bot]) or
  // marked `self` before the timeline shows it.
  const stalled = { at: "2026-11-09T09:47:00Z", reason: "dequeued", actor: "factory-app", person: false };
  assert.deepEqual(queueRetry([stalled], { since, self: "factory-app[bot]" }), { enqueue: true, drops: 1, last: { at: stalled.at, code: STALL_CODE, factory: true } });
  // #2683 F2: an earlier removal of a hung entry, its code read back from Factory's requeue record, keeps that code.
  const hungBefore = { ...stalled, code: HUNG_CODE };
  const hungTwice = queueRetry([hungBefore, { at: "2026-11-09T09:58:00Z", reason: STALL_CODE, code: HUNG_CODE, self: true }], { since, self: "factory-app[bot]" });
  assert.deepEqual(hungTwice.codes, [HUNG_CODE], "never read as checks_never_started");
  const twice = queueRetry([stalled, { at: "2026-11-09T09:58:00Z", reason: STALL_CODE, self: true }], { since, self: "factory-app[bot]" });
  assert.match(twice.block, new RegExp(`2 times without merging it \\(${STALL_CODE}\\)`));
  assert.deepEqual(queueRetry([stalled], { since }), { enqueue: true, drops: 1, last: { at: stalled.at, code: "dequeued" } }, "without Factory's login known, its App is still a bot: a drop, never a hold that leaves the PR out");
});

test("queueStall: a queue commit with no check run for QUEUE_STALL_MS is stalled; a fresh entry with no commit yet is watched", async () => {
  const { QUEUE_FRESH_MS, QUEUE_STALL_MS, queueStall } = await import("../scripts/lib/logic.mjs");
  const headAt = "2026-11-09T09:36:44Z";
  const t0 = Date.parse(headAt);
  const entry = { state: "AWAITING_CHECKS", enqueuedAt: headAt, head: "d4106a0", headAt };
  assert.deepEqual(queueStall(entry, { started: false, now: t0 + 60_000 }), { waitMs: QUEUE_STALL_MS - 60_000 }, "no check yet: watched until the bound");
  assert.deepEqual(queueStall(entry, { started: false, now: t0 + QUEUE_STALL_MS }), { stalled: true }, "#295: no check run on the queue's commit");
  assert.deepEqual(queueStall(entry, { started: true, now: t0 + 6 * QUEUE_STALL_MS, hung: [] }), {}, "a check started and none hung: nothing to decide");
  assert.deepEqual(queueStall({ ...entry, state: "MERGEABLE" }, { started: false, now: t0 + QUEUE_STALL_MS }), {}, "past checks");
  const queued = { state: "QUEUED", enqueuedAt: headAt, head: null, headAt: null };
  assert.deepEqual(queueStall(queued, { started: true, now: t0 + 5_000 }), { waitMs: QUEUE_STALL_MS }, "just enqueued: its commit comes in seconds, so it is watched");
  assert.deepEqual(queueStall(queued, { started: true, now: t0 + QUEUE_FRESH_MS + 1 }), {}, "waiting its turn behind others: a sibling's event brings it back");
  assert.deepEqual(queueStall(null, { started: false, now: t0 }), {});
});

test("queueHungMs: the fallback bound is the later of half the queue's timeout and 10 minutes before it, at least 20 minutes", async () => {
  const { QUEUE_HUNG_FLOOR_MS, QUEUE_HUNG_MS, queueHungMs } = await import("../scripts/lib/logic.mjs");
  assert.equal(queueHungMs(60), 50 * 60_000);
  assert.equal(queueHungMs(120), 110 * 60_000);
  assert.equal(queueHungMs(30), 20 * 60_000);
  assert.equal(queueHungMs(10), QUEUE_HUNG_FLOOR_MS, "a short timeout: the floor (the queue's own drop comes first)");
  assert.equal(queueHungMs(null), QUEUE_HUNG_MS, "unread: setup's 60");
  assert.equal(QUEUE_HUNG_MS, 50 * 60_000);
});

test("jobStall: a job is stalled only when its current step runs past max(3 x its normal duration, it + 15 min) (#2683)", async () => {
  const { QUEUE_HUNG_MS, jobStall, needsBaseline } = await import("../scripts/lib/logic.mjs");
  const t0 = Date.parse("2026-11-10T04:57:09Z");
  const min = 60_000;
  const iso = (m) => new Date(t0 + m * min).toISOString();
  // A job started at t0; its steps before `step` took `before` minutes; `step` runs from then on.
  const job = (step, before = 0.1, extra = {}) => ({
    id: 9,
    name: "Quality",
    workflow_name: "Quality",
    status: "in_progress",
    started_at: iso(0),
    steps: [
      { name: "Set up job", status: "completed", started_at: iso(0), completed_at: iso(before) },
      { name: step, status: "in_progress", started_at: iso(before), completed_at: null },
      { name: "Run npm test", status: "pending", started_at: null, completed_at: null },
    ],
    ...extra,
  });
  const at = (m) => ({ now: t0 + m * min, fallbackMs: QUEUE_HUNG_MS });
  // Tonight's case (factory-scratch run 42759031247): setup.sh normally about a minute, running 15.
  const setup = job("Run scripts/ci/setup.sh");
  // Stalled past max(3 x baseline, baseline + 15 min): 16 minutes for a 1-minute step.
  assert.equal(jobStall(setup, { ...at(15.1), baselineMs: 1 * min }), null, "15 minutes of a normal 1: not yet");
  assert.deepEqual(jobStall(setup, { ...at(16.6), baselineMs: 1 * min }), { name: "Quality", step: "Run scripts/ci/setup.sh", elapsedMs: 16.5 * min, baselineMs: 1 * min });
  assert.equal(jobStall(setup, { ...at(14), baselineMs: 0 }), null, "never under 15 minutes");
  // A warm-cache build: 6 minutes normally, 20 running: under max(18, 21).
  const build = job("Run npm run build", 2);
  assert.equal(jobStall(build, { ...at(22), baselineMs: 6 * min }), null);
  assert.ok(jobStall(build, { ...at(23.5), baselineMs: 6 * min }), "past 21 minutes");
  // A long but normal step: tests usually 20 minutes, running 25, in a job 55 minutes old.
  const tests = job("Run npm test", 30);
  assert.equal(jobStall(tests, { ...at(55), baselineMs: 20 * min }), null, "25 of a normal 20: progress, not a hang, whatever the job's age");
  // Past three times its baseline: stalled.
  assert.equal(jobStall(tests, { ...at(85), baselineMs: 20 * min }), null, "55 of a normal 20: under 60");
  assert.equal(jobStall(tests, { ...at(91), baselineMs: 20 * min })?.step, "Run npm test", "61 of a normal 20");
  // A running step with no start time: the fallback from the check run's start, then the job's; never skipped.
  const blind = job("Run scripts/ci/setup.sh");
  blind.steps[1].started_at = null;
  assert.equal(jobStall(blind, { ...at(30), baselineMs: 1 * min, checkStartedAt: iso(0) }), null, "within the fallback");
  assert.equal(jobStall(blind, { ...at(51), baselineMs: 1 * min, checkStartedAt: iso(0) })?.step, "Run scripts/ci/setup.sh", "past it from the check run's start");
  assert.ok(jobStall(blind, { ...at(51), baselineMs: 1 * min }), "no check run start: the job's");
  // No history for the step: the fallback bound from the job's own start.
  assert.equal(jobStall(setup, { ...at(15.1), baselineMs: null }), null, "no history, 15 minutes: within the fallback");
  assert.equal(jobStall(setup, { ...at(51), baselineMs: null })?.baselineMs, null, "no history, past 50 minutes: stalled");
  assert.ok(jobStall(setup, { ...at(51), baselineMs: null }));
  // Queued or waiting for a runner, or no steps yet: never stalled.
  assert.equal(jobStall({ ...setup, status: "queued", steps: [] }, { ...at(59), baselineMs: null }), null, "queued for a runner");
  assert.equal(jobStall({ ...setup, status: "waiting" }, { ...at(59), baselineMs: 1 * min }), null);
  assert.equal(jobStall({ ...setup, steps: [] }, { ...at(59), baselineMs: null }), null, "a runner, no steps yet");
  // History is read only once a step could be judged.
  assert.equal(needsBaseline(setup, at(14)), false);
  assert.equal(needsBaseline(setup, at(16)), true);
  assert.equal(needsBaseline({ ...setup, status: "queued" }, at(59)), false);
});

test("queueHangs: required checks judged by progress; a check that is no Actions job, or a missing aggregate, by the fallback (#2683)", async () => {
  const { ACTIONS_APP_ID, QUEUE_HUNG_MS, queueHangs, queueStall, stepKey } = await import("../scripts/lib/logic.mjs");
  const headAt = "2026-11-10T04:57:05Z";
  const t0 = Date.parse(headAt);
  const min = 60_000;
  const iso = (m) => new Date(t0 + m * min).toISOString();
  const run = (id, name, status, start, app = ACTIONS_APP_ID) => ({ id, name, status, started_at: start === null ? null : iso(start), app });
  const job = { id: 1, name: "Quality", workflow_name: "Quality", status: "in_progress", started_at: iso(0), steps: [{ name: "Run scripts/ci/setup.sh", status: "in_progress", started_at: iso(0.1) }] };
  const base = { names: ["Quality"], headAt, hungMs: QUEUE_HUNG_MS };
  const baselines = new Map([[stepKey(job, "Run scripts/ci/setup.sh"), 1 * min]]);
  const hung = queueHangs({ ...base, checks: [run(1, "Quality", "in_progress", 0)], jobs: new Map([[1, job]]), baselines, now: t0 + 16.5 * min });
  assert.deepEqual(hung.map((h) => [h.name, h.step]), [["Quality", "Run scripts/ci/setup.sh"]]);
  // The job unread (no actions: read): the fallback from the check run's start.
  assert.deepEqual(queueHangs({ ...base, checks: [run(1, "Quality", "in_progress", 0)], now: t0 + 16.5 * min }), []);
  assert.equal(queueHangs({ ...base, checks: [run(1, "Quality", "in_progress", 0)], now: t0 + 51 * min }).length, 1);
  // A third-party app's check: the fallback too; queued, never.
  assert.equal(queueHangs({ ...base, checks: [run(2, "Quality", "in_progress", 0, 999)], now: t0 + 51 * min }).length, 1);
  assert.equal(queueHangs({ ...base, checks: [run(2, "Quality", "queued", 0)], now: t0 + 59 * min }).length, 0);
  // A required aggregate not reported yet: its upstream jobs' progress decides; with nothing running, the fallback.
  const build = { ...job, id: 3, name: "build" };
  const up = queueHangs({ ...base, checks: [run(3, "build", "in_progress", 0)], jobs: new Map([[3, build]]), baselines: new Map([[stepKey(build, "Run scripts/ci/setup.sh"), 1 * min]]), now: t0 + 16.5 * min });
  assert.deepEqual(up.map((h) => h.name), ["build"], "the stuck upstream job is named");
  assert.equal(queueHangs({ ...base, checks: [run(3, "build", "completed", 0)], now: t0 + 51 * min })[0]?.name, "Quality");
  // queueStall reads nothing before the commit is 10 minutes old, then the hangs decide.
  const entry = { state: "AWAITING_CHECKS", enqueuedAt: headAt, head: "b1bee72", headAt };
  assert.deepEqual(queueStall(entry, { started: true, now: t0 + 5 * min }), { waitMs: 10 * min });
  assert.deepEqual(queueStall(entry, { started: true, now: t0 + 16 * min, hung }), { stalled: true, hung });
  assert.deepEqual(queueStall(entry, { started: true, now: t0 + 16 * min, hung: [] }), {});
});

test("gateStarted: CI from the required check's integration is the queue commit starting; code scanning is not", async () => {
  const { ACTIONS_APP_ID, QUEUE_STALL_MS, gateStarted, queueStall } = await import("../scripts/lib/logic.mjs");
  // clockgrove/clockgrove's queue commit 5f47939 (run 42619422996): the rulesets require `quality` (one from Actions,
  // integration 15368); `quality` has `needs:` on a matrix, so its check run came 15 min after the commit.
  const headAt = "2026-11-09T12:43:28Z";
  const t0 = Date.parse(headAt);
  const entry = { state: "AWAITING_CHECKS", enqueuedAt: headAt, head: "5f47939", headAt };
  const gate = [{ name: "quality", app: null }, { name: "quality", app: ACTIONS_APP_ID }];
  const actions = { id: ACTIONS_APP_ID, slug: "github-actions" };
  // Every installed app gets an empty queued suite on the commit (#295's had these two and nothing else).
  const idle = [{ app: { id: 1236702, slug: "claude" }, status: "queued", latest_check_runs_count: 0 }, { app: { id: 8329, slug: "vercel" }, status: "queued", latest_check_runs_count: 0 }];
  const seen = [
    { at: 5_000, run: { name: "reuse", app: actions }, suite: { app: actions, status: "in_progress", latest_check_runs_count: 1 } },
    { at: 15 * 60_000, run: { name: "quality", app: actions } },
  ];
  const by = (ms) => ({ runs: seen.filter((s) => s.at <= ms).map((s) => s.run), suites: [...idle, ...seen.filter((s) => s.at <= ms && s.suite).map((s) => s.suite)] });
  const stall = (ms, obs) => queueStall(entry, { started: gateStarted(gate, obs), now: t0 + ms });
  // (a) A non-required Actions run at +5 s, the required one at +15 min: CI began, so not stalled at the bound.
  assert.equal(stall(QUEUE_STALL_MS, by(QUEUE_STALL_MS)).stalled, undefined, "an aggregate required job behind needs: is not a stall");
  assert.equal(stall(15 * 60_000, by(15 * 60_000)).stalled, undefined);
  assert.equal(gateStarted(gate, { runs: by(QUEUE_STALL_MS).runs }), true, "the integration's run alone");
  assert.equal(gateStarted(gate, { suites: by(QUEUE_STALL_MS).suites }), true, "the integration's suite alone");
  // (b) Nothing on the commit but installed apps' empty suites (#295): stalled at the bound.
  assert.deepEqual(stall(QUEUE_STALL_MS, {}), { stalled: true });
  assert.deepEqual(stall(QUEUE_STALL_MS, { suites: idle }), { stalled: true });
  // (c) Only code scanning's app (its CodeQL run and suite): stalled.
  const scanning = { app: { id: 57789, slug: "github-advanced-security" } };
  const codeql = { runs: [{ name: "CodeQL", ...scanning }], suites: [...idle, { ...scanning, status: "completed", latest_check_runs_count: 1 }] };
  assert.equal(gateStarted(gate, codeql), false);
  assert.deepEqual(stall(QUEUE_STALL_MS, codeql), { stalled: true });
  // A required name counts from any check run or status; a named integration's suite counts once it has a run.
  assert.equal(gateStarted(["ci"], { statuses: [{ context: "ci", state: "pending" }] }), true);
  assert.equal(gateStarted([{ name: "build", app: 1234 }], { suites: [{ app: { id: 1234 }, latest_check_runs_count: 0 }] }), false, "an installed app's empty suite");
  assert.equal(gateStarted([{ name: "build", app: 1234 }], { suites: [{ app: { id: 1234 }, latest_check_runs_count: 2 }] }), true);
  assert.equal(gateStarted([{ name: "build", app: 1234 }], { suites: [{ app: actions, latest_check_runs_count: 3 }] }), false, "Actions is not the named integration");
  assert.equal(gateStarted([], { suites: [{ app: actions, status: "queued", latest_check_runs_count: 0 }] }), true, "no gate read: Actions; a workflow waiting on a concurrency group");
});

test("gateStarted: an empty gate counts any check run, any status, or any suite with a run, as well as Actions suites", async () => {
  const { ACTIONS_APP_ID, gateStarted } = await import("../scripts/lib/logic.mjs");
  // The required checks unread (#2612): CI from a third-party app or statuses alone is CI begun.
  const thirdParty = { id: 4242, slug: "buildkite" };
  for (const gate of [[], null, [{ name: "" }]]) {
    assert.equal(gateStarted(gate, { runs: [{ name: "build", app: thirdParty }] }), true, "a third-party app's check run");
    assert.equal(gateStarted(gate, { statuses: [{ context: "ci/jenkins", state: "pending" }] }), true, "a status alone");
    assert.equal(gateStarted(gate, { suites: [{ app: thirdParty, status: "in_progress", latest_check_runs_count: 1 }] }), true, "a suite with a run");
    assert.equal(gateStarted(gate, { suites: [{ app: { id: ACTIONS_APP_ID }, status: "queued", latest_check_runs_count: 0 }] }), true, "an Actions suite");
    // Installed apps' empty queued suites are still nothing (#295).
    assert.equal(gateStarted(gate, { suites: [{ app: thirdParty, status: "queued", latest_check_runs_count: 0 }, { app: { id: 8329 }, latest_check_runs_count: 0 }] }), false);
    assert.equal(gateStarted(gate, {}), false);
  }
  // A non-empty gate keeps its narrow rule: another app's run and an unnamed status do not count.
  const gate = [{ name: "quality", app: null }];
  assert.equal(gateStarted(gate, { runs: [{ name: "build", app: thirdParty }] }), false);
  assert.equal(gateStarted(gate, { statuses: [{ context: "ci/jenkins", state: "pending" }] }), false);
  // Any Actions run counts under a gate that requires an Actions check, not only code scanning's dynamic run.
  assert.equal(gateStarted(gate, { runs: [{ name: "push-lint", app: { id: ACTIONS_APP_ID } }] }), true, "a non-required push workflow on gh-readonly-queue/**");
});

test("requeueLine: the issue's one line at a re-enqueue, codes and times only", async () => {
  const { requeueLine } = await import("../scripts/lib/session.mjs");
  assert.equal(requeueLine(300, { at: "2026-11-09T10:40:04Z", code: "checks_timed_out" }, 2), "Factory: the merge queue dropped PR #300 (checks_timed_out) at 2026-11-09T10:40:04Z; enqueued again (try 2).");
  assert.equal(requeueLine(300, { at: "<b>", code: "unknown" }, 2), "Factory: the merge queue dropped PR #300 (unknown) at an unknown time; enqueued again (try 2).");
  assert.equal(requeueLine(300, { at: "2026-11-09T10:40:04.123Z", code: "failed_checks" }, 2).includes("\n"), false);
});

test("mergeTickCheck: an installed workflow without the merge pass's ticks is named, FAIL by hand and WARN in a run on any route", async () => {
  const { mergeTickCheck } = await import("../scripts/doctor.mjs");
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  for (const v of [values, { ...values, sandbox: "vercel", default_branch: "main" }]) assert.equal(mergeTickCheck(renderWorkflow(template, v), {}).status, "PASS");
  // A workflow rendered before this change: scratch's and clockgrove's `types: [labeled, ready_for_review, closed]`.
  const old = renderWorkflow(template, values).replace("[labeled, ready_for_review, closed, dequeued]", "[labeled, ready_for_review, closed]").replace(/\n {2}queue-watch:[\s\S]*?(?=\n {2}work:)/, "");
  const by = mergeTickCheck(old, {});
  assert.equal(by.status, "FAIL");
  assert.match(by.detail, /pull_request dequeued, the queue-watch job/);
  assert.match(by.fix, /setup --apply workflow/);
  assert.equal(mergeTickCheck(old, { GITHUB_ACTIONS: "true" }).status, "WARN", "inside a job it never Blocks every Objective before the re-render");
  assert.equal(mergeTickCheck(old, {}, { job: true }).status, "WARN", "a local or sandbox run, outside Actions, never Blocks on it either");
  const sandboxOld = renderWorkflow(template, { ...values, sandbox: "vercel", default_branch: "main" }).replace(/\n {2}launch-tick:[\s\S]*?(?=\n {2}image:)/, "");
  assert.match(mergeTickCheck(sandboxOld, {}).detail, /the launch-tick job/);
});

test("watchQueue: reads until a check starts or the PR leaves the queue; a stalled commit ticks", async () => {
  const { watchQueue } = await import("../scripts/dispatch.mjs");
  // No PRs: nothing read, no tick.
  assert.deepEqual(await watchQueue({ full: "o/r", owner: "o", name: "r" }, [], {}, { sleep: async () => {} }), { tick: false });
  assert.deepEqual(await watchQueue({ full: "o/r", owner: "o", name: "r" }, ["x", -1, 0], {}, { sleep: async () => {} }), { tick: false }, "only PR numbers are watched");
});

test("mergeBlockReason: which merge answers Block, and with what", async () => {
  const { mergeBlockReason } = await import("../scripts/lib/session.mjs");
  assert.match(mergeBlockReason("red"), /red/);
  assert.equal(mergeBlockReason("dropped", { reason: "the merge queue dropped it" }), "the merge queue dropped it");
  assert.match(mergeBlockReason("dropped"), /dropped/);
  for (const how of ["merged", "queued", "in-queue", "pending", "re-review", "held", null]) assert.equal(mergeBlockReason(how), null);
});

test("activeWorkIssues: a failed Actions listing throws, so the dispatcher leaves a Running Objective alone instead of Blocking it as vanished", async () => {
  const { createServer } = await import("node:http");
  const { activeFactoryJobs, activeWorkIssues } = await import("../scripts/lib/github.mjs");
  let fail = true;
  const server = createServer((req, res) => {
    if (fail) return res.writeHead(502, { "content-type": "application/json" }).end('{"message":"Server Error"}');
    if (/\/runs\?status=in_progress/.test(req.url)) return res.writeHead(200).end(JSON.stringify({ workflow_runs: [{ id: 9 }] }));
    if (/\/runs\/9\/jobs/.test(req.url)) return res.writeHead(200).end(JSON.stringify({ jobs: [{ name: "work (12)", status: "in_progress" }, { name: "work (13)", status: "completed" }] }));
    res.writeHead(200).end(JSON.stringify({ workflow_runs: [] }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  const repo = { owner: "o", name: "r", full: "o/r" };
  try {
    await assert.rejects(activeWorkIssues(repo, { token: "t" }), /failed \(502\)/, "a failed listing is no answer, never 'no job alive'");
    assert.equal((await activeFactoryJobs(repo, { token: "t" })).work.size, 0, "the lenient listing still reads a failure as none");
    fail = false;
    assert.deepEqual([...(await activeWorkIssues(repo, { token: "t" }))], [12]);
  } finally {
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
    server.close();
  }
});

test("workflow template: every job has a timeout, the dispatcher's included (one hung tick would hold every later tick)", async () => {
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  for (const v of [values, { ...values, sandbox: "vercel", default_branch: "main" }]) {
    const jobs = parseYaml(renderWorkflow(template, v)).jobs;
    assert.ok(jobs.dispatch, "the dispatch job renders");
    for (const [name, job] of Object.entries(jobs)) assert.ok(Number(job["timeout-minutes"]) > 0, `${name}${v.sandbox ? " (sandbox)" : ""} has timeout-minutes`);
  }
});

test("local loop: every sweep pass acts only on the Objectives it routes; its Done pass records each removal as Factory's first (#2668)", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const { BACKENDS } = await import("../scripts/lib/backend.mjs");
  const { doneRecord, doneTidies } = await import("../scripts/lib/logic.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const now = Date.now();
  const hourAgo = new Date(now - 3600_000).toISOString();
  const iss = (number, labels, state = "open") => ({ number, state, labels: labels.map((name) => ({ name })), body: "", updated_at: new Date(now).toISOString(), user: { login: "maintainer" } });
  // #373's shape: an Actions/sandbox Objective merged and closed, still In review; #380 the local loop's own; #5 an
  // Actions Objective Running for an hour with no Actions job listed (its sandbox holds it); #6 one a loop with --all
  // claimed and left away over a day, which a loop without --all still Blocks.
  const open = [iss(5, ["factory:objective", "factory:running"]), iss(6, ["factory:objective", "factory:running"])];
  const daysAgo = (d) => new Date(now - d * 86_400_000).toISOString();
  const claim = { id: 66, user: { login: "maintainer", type: "User" }, body: `<!-- factory:6:local -->\n${claimBody("box-a", new Date(daysAgo(1.5)))}` };
  const closed = [iss(373, ["factory:objective", "factory:in-review"], "closed"), iss(380, ["factory:objective", "factory:local", "factory:in-review"], "closed")];
  const tick = async (env, { failRecord = false } = {}) => {
    const writes = [];
    const realFetch = globalThis.fetch;
    const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
    for (const k of ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (method !== "GET" && !u.pathname.endsWith("/graphql")) writes.push(`${method} ${u.pathname.replace("/repos/acme/app", "")}${method === "POST" ? ` ${JSON.parse(init.body).body ?? ""}` : ""}`);
      if (method === "GET" && u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? closed : open);
      if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
      if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json([{ event: "labeled", label: { name: "factory:running" }, created_at: u.pathname.includes("/issues/6/") ? daysAgo(2) : hourAgo }]);
      if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (method === "GET" && /\/comments$/.test(u.pathname)) return json(u.pathname.includes("/issues/6/") ? [claim] : []);
      if (method === "POST" && /\/comments$/.test(u.pathname)) return failRecord && JSON.parse(init.body).body?.includes(":done -->") ? json({ message: "Bad Gateway" }, 502) : json({ id: 1 }, 201);
      if (method === "DELETE" || method === "POST") return json({}, 200);
      return json({ message: "Not Found" }, 404);
    };
    try {
      const r = await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t", localSlots: 2 });
      return { r, writes };
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const on = (writes, n) => writes.filter((w) => w.includes(`/issues/${n}/`));

  // A local loop: #373 and #5 are another route's, untouched in every pass; #380 is its own, recorded before any removal.
  const local = await tick({ FACTORY_LOCAL: "1" });
  assert.deepEqual(local.r.done, [380]);
  assert.deepEqual(local.r.vanished, [6], "another route's Running Objective is that route's to judge, unless a local loop claimed it");
  assert.ok(local.writes.includes("DELETE /issues/comments/66"), "the expired claim goes with the Block");
  assert.deepEqual(on(local.writes, 373), [], "no label, card or comment change on another route's Objective");
  assert.deepEqual(on(local.writes, 5), []);
  const own = on(local.writes, 380);
  assert.equal(own[0], `POST /issues/380/comments <!-- factory:380:done -->\n${doneRecord(["factory:in-review"])}`, "the record comes first");
  assert.ok(own.slice(1).every((w) => w.startsWith("DELETE /issues/380/labels/")) && own.length > 1);
  // The record could not be posted: no label leaves #380 unmarked; they wait for the next tick.
  const failed = await tick({ FACTORY_LOCAL: "1" }, { failRecord: true });
  assert.deepEqual(failed.r.done, []);
  assert.ok(!on(failed.writes, 380).some((w) => w.startsWith("DELETE")), "no removal without its record");
  // With --all the loop routes every Objective, so it tends #373 too, recorded the same way.
  const all = await tick({ FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" });
  assert.deepEqual(all.r.done, [373, 380]);
  assert.match(on(all.writes, 373)[0], /^POST \/issues\/373\/comments <!-- factory:373:done -->\n[^]*\nremoved: factory:in-review$/);
  // The Action tends every route's closed Objectives, as its App: no record.
  const actions = await tick({});
  assert.deepEqual(actions.r.done, [373, 380]);
  assert.ok(!actions.writes.some((w) => w.startsWith("POST") && w.includes(":done -->")), "the App's removals need no record");

  // The pure pieces: which closed Objectives the pass tidies, per backend, and what it removes.
  const tends = (env) => (i) => BACKENDS.local.trigger.tends(i, env);
  assert.deepEqual(doneTidies(closed, { tends: tends({}) }), [{ number: 380, labels: ["factory:in-review"] }]);
  assert.deepEqual(doneTidies(closed, { tends: tends({ FACTORY_LOCAL_ALL: "1" }) }).map((d) => d.number), [373, 380]);
  assert.deepEqual(doneTidies(closed, { tends: BACKENDS.actions.trigger.tends }).map((d) => d.number), [373, 380]);
  assert.deepEqual(doneTidies([iss(9, ["factory:objective", "factory:local"], "closed")], { tends: tends({}), project: true, cards: { 9: "In review" } }), [{ number: 9, labels: [] }], "a card left behind moves, with nothing to record");
  assert.equal(BACKENDS.local.trigger.asPerson, true);
  assert.equal(BACKENDS.actions.trigger.asPerson, false);
});

/**
 * One dispatcher tick on the Action's route over factory:local Objectives (#167). `open`: the open issues; `timeline(n)`:
 * each one's label events; `comments(n)`: its comments, or a status to fail the read with; `pulls(n)`: its open PRs;
 * `writers`: the collaborators read, or a status to fail it with.
 */
async function localTick({ repo = "acme/app", open, timeline, comments = () => [], pulls = () => [], writers = [{ login: "maintainer" }], env = {}, maxConcurrent = 2 }) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const writes = [];
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  for (const k of ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const n = Number(/\/issues\/(\d+)\//.exec(u.pathname)?.[1]);
    if (method !== "GET" && !u.pathname.endsWith("/graphql")) writes.push(`${method} ${u.pathname.replace(`/repos/${repo}`, "")}${method === "POST" ? ` ${JSON.parse(init.body).body ?? ""}` : ""}`);
    if (method === "GET" && u.pathname === "/user") return json({ login: "maintainer", type: "User" });
    if (method === "GET" && u.pathname === `/repos/${repo}/issues`) return json(u.searchParams.get("state") === "closed" ? [] : open);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json(timeline(n));
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return Array.isArray(writers) ? json(writers) : json({ message: "Server Error" }, writers);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
      const c = comments(n);
      return Array.isArray(c) ? json(c) : json({ message: "Server Error" }, c);
    }
    if (method === "GET" && u.pathname === `/repos/${repo}/pulls`) return json(pulls(Number(/factory\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1])));
    if (method === "POST" && /\/comments$/.test(u.pathname)) return json({ id: 1 }, 201);
    if (method === "DELETE" || method === "POST") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo, objectiveLabel: "factory:objective", maxConcurrent, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
    return { r, writes, blocked: (n) => writes.find((w) => w.startsWith(`POST /issues/${n}/comments`) && /blocked/i.test(w)) };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;
const localIssue = (number, state, labels = ["factory:local"]) => ({ number, state: "open", labels: ["factory:objective", ...labels, state].map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });
const labelled = (name, at) => [{ event: "labeled", label: { name }, created_at: at }];

test("local claim read: a failed read is unread, never 'no claim'; the next tick reads it and the Objective runs on (#167)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  // Running 40 minutes, a fresh claim; the first tick's claim read fails, the second's answers.
  const claim = { id: 77, user: { login: "maintainer", type: "User" }, body: `<!-- factory:7:local -->\n${claimBody("box-a:1:abc:m:b", new Date(Date.now() - 30_000))}`, updated_at: ago(30_000) };
  let fail = true;
  const tick = () => localTick({ open: [localIssue(7, "factory:running")], timeline: () => labelled("factory:running", ago(40 * 60_000)), comments: (n) => (n === 7 && fail ? 502 : n === 7 ? [claim] : []) });
  const first = await tick();
  assert.deepEqual(first.r.vanished, [], "no Block rests on a failed read");
  assert.equal(first.blocked(7), undefined);
  assert.ok(first.r.deadlines.some((d) => d.kind === "retry"), "a retry is due");
  fail = false;
  const second = await tick();
  assert.deepEqual(second.r.vanished, []);
  assert.deepEqual(second.r.paused, [], "alive: the heartbeat is fresh");
  assert.equal(second.blocked(7), undefined);
});

test("local claim read: an author that cannot be checked (the writer list unread) is unread; a stranger's marker never holds (#167)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const body = (holder) => `<!-- factory:7:local -->\n${claimBody(holder, new Date())}`;
  const open = [{ ...localIssue(7, "factory:running", []), labels: ["factory:objective", "factory:running"].map((name) => ({ name })) }];
  const timeline = () => labelled("factory:running", ago(2 * HOUR));
  // A repository whose writer list cannot be read: the developer's claim is unread, so nothing Blocks this tick.
  const unread = await localTick({ repo: "acme/unread", open, timeline, writers: 502, comments: (n) => (n === 7 ? [{ id: 5, user: { login: "dev", type: "User" }, body: body("box-a:1:abc:m:b"), updated_at: ago(0) }] : []) });
  assert.deepEqual(unread.r.vanished, []);
  assert.ok(unread.r.deadlines.some((d) => d.kind === "retry"));
  // With the writers read, a marker by someone who cannot push is no claim: the unclaimed Running one Blocks as before.
  const stranger = await localTick({ open, timeline, comments: (n) => (n === 7 ? [{ id: 6, user: { login: "stranger", type: "User" }, body: body("box-x:1:abc:m:b"), updated_at: ago(0) }] : []) });
  assert.deepEqual(stranger.r.vanished, [7]);
  assert.match(stranger.blocked(7), /worker job vanished/);
  assert.ok(!stranger.writes.includes("DELETE /issues/comments/6"), "a stranger's comment is not Factory's to delete");
});

test("local deadlines: a factory:local Objective with no claim waits a day, Running or in review, then Blocks naming factory serve (#167)", async () => {
  const pr = (n) => [{ number: 100 + n, draft: false, labels: [{ name: "factory:review" }], head: { ref: `factory/${n}` } }];
  // #7 Running 2 hours and #8 in review for 2 hours, neither claimed: they wait, with a wake at the day's end.
  const young = await localTick({
    open: [localIssue(7, "factory:running"), localIssue(8, "factory:in-review")],
    timeline: (n) => labelled(n === 7 ? "factory:running" : n === 8 ? "factory:in-review" : "factory:review", ago(2 * HOUR)),
    pulls: (n) => (n === 8 ? pr(8) : []),
  });
  assert.deepEqual(young.r.vanished, [], "no 15-minute grace for a local Objective");
  assert.deepEqual(young.r.deadlines.filter((d) => d.kind === "local-pause").map((d) => d.issue).sort(), [7, 8]);
  // Past a day: both Block, and the reason names the fix.
  const old = await localTick({
    open: [localIssue(7, "factory:running"), localIssue(8, "factory:in-review")],
    // The PR's (#108) review label is as old as its In-review entry.
    timeline: (n) => labelled(n === 7 ? "factory:running" : n === 8 ? "factory:in-review" : "factory:review", ago(25 * HOUR)),
    pulls: (n) => (n === 8 ? pr(8) : []),
  });
  assert.deepEqual(old.r.vanished.sort(), [7, 8]);
  for (const n of [7, 8]) assert.match(old.blocked(n), /no local loop[^]*start `factory serve` on the machine that runs it[^]*<!-- factory:block \{"cause":"setup"\} -->/);
  // In review for three days, but factory:review re-applied to its PR 2 hours ago (a maintainer's comment, a re-review):
  // a new review is owed, and its day counts from that label.
  const rereview = await localTick({ open: [localIssue(8, "factory:in-review")], timeline: (n) => labelled(n === 8 ? "factory:in-review" : "factory:review", ago(n === 8 ? 72 * HOUR : 2 * HOUR)), pulls: pr });
  assert.deepEqual(rereview.r.vanished, []);
  assert.equal(rereview.r.deadlines.find((d) => d.issue === 8 && d.kind === "local-pause")?.at.slice(0, 13), new Date(Date.now() + 22 * HOUR).toISOString().slice(0, 13));
  // In review with no review owed (reviewed, waiting on a person): no deadline.
  const reviewed = await localTick({ open: [localIssue(8, "factory:in-review")], timeline: () => labelled("factory:in-review", ago(25 * HOUR)), pulls: () => [{ ...pr(8)[0], labels: [] }] });
  assert.deepEqual(reviewed.r.vanished, []);
  // An unlabelled Objective's runner job still gets 15 minutes.
  const runner = await localTick({ open: [{ ...localIssue(9, "factory:running", []) }], timeline: () => labelled("factory:running", ago(20 * 60_000)) });
  assert.deepEqual(runner.r.vanished, [9]);
  assert.match(runner.blocked(9), /worker job vanished[^]*<!-- factory:block \{"cause":"factory"\} -->/, "a lost runner job is Factory's own");
});

test("local claim age: GitHub's update time, not the machine's clock in the body; an expired claim's Block names its holder (#167)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const comment = (written, updated) => ({ id: 70, user: { login: "maintainer", type: "User" }, body: `<!-- factory:7:local -->\n${claimBody("box-a:1:abc:m:b", new Date(written))}`, updated_at: updated });
  const run = (c) => localTick({ open: [localIssue(7, "factory:running")], timeline: () => labelled("factory:running", ago(3 * 24 * HOUR)), comments: (n) => (n === 7 ? [c] : []) });
  // A machine whose clock runs an hour behind wrote its heartbeat seconds ago by GitHub's clock: alive.
  const slow = await run(comment(Date.now() - HOUR, ago(10_000)));
  assert.deepEqual(slow.r.vanished, []);
  assert.deepEqual(slow.r.paused, []);
  // By GitHub's clock the heartbeat stopped an hour ago: paused, whatever the body says.
  const stale = await run(comment(Date.now(), ago(HOUR)));
  assert.deepEqual(stale.r.paused, [7]);
  // Two days without a heartbeat: Blocked, naming the loop and the fix, and the claim goes with it.
  const expired = await run(comment(Date.now(), ago(2 * 24 * HOUR)));
  assert.deepEqual(expired.r.vanished, [7]);
  assert.match(expired.blocked(7), /the local loop holding it \(box-a:1:abc:m:b\) has been away over a day; start `factory serve`[^]*"cause":"setup"/);
  assert.ok(expired.writes.includes("DELETE /issues/comments/70"));
});

test("local claim read: unread for over a day since the Objective began waiting Blocks naming the read (cause factory); younger, or a marked comment updated within the day, waits (#167)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const open = [localIssue(7, "factory:running")];
  const tick = (runningFor, comments, repo = "acme/app", writers) => localTick({ repo, open, writers, timeline: () => labelled("factory:running", ago(runningFor)), comments: (n) => (n === 7 ? comments : []) });
  const young = await tick(2 * HOUR, 502);
  assert.deepEqual(young.r.vanished, [], "a failed read inside the day only waits");
  // Past the day with the comments still failing: the Block is due, and a tick whose Block cannot be written goes on.
  const old = await tick(25 * HOUR, 502);
  assert.deepEqual(old.r.vanished, [7]);
  // The writer list never loads, but the marked comment was updated minutes ago: maybe a live loop, so it waits.
  const marked = (at, association = "COLLABORATOR") => [{ id: 5, user: { login: "dev", type: "User" }, author_association: association, body: `<!-- factory:7:local -->\n${claimBody("box-a:1:abc:m:b", new Date())}`, updated_at: at }];
  const live = await tick(25 * HOUR, marked(ago(60_000)), "acme/nowriters", 502);
  assert.deepEqual(live.r.vanished, []);
  // An outsider's look-alike, edited a minute ago, delays nothing.
  const outsider = await tick(25 * HOUR, marked(ago(60_000), "NONE"), "acme/nowriters3", 502);
  assert.deepEqual(outsider.r.vanished, [7]);
  const dead = await tick(25 * HOUR, marked(ago(26 * HOUR)), "acme/nowriters2", 502);
  assert.deepEqual(dead.r.vanished, [7]);
  assert.match(dead.blocked(7), /Running for over a day and its local claim cannot be read or checked \(#7's claim author could not be checked[^]*"cause":"factory"/);
});

test("claimedLocally: a runner job steps aside only for a marked claim whose author cannot be checked; a comments read that keeps failing is not claimed (#167)", async () => {
  const { BACKENDS } = await import("../scripts/lib/backend.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  let failures = 0;
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const claim = (at, login = "maintainer") => [{ id: 1, user: { login, type: "User" }, body: `<!-- factory:7:local -->\n${claimBody("box:1:a:m:b", new Date())}`, updated_at: at }];
  let comments = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/user") return json({ login: "maintainer", type: "User" });
    if (u.pathname === "/repos/acme/nowriters/collaborators") return json({ message: "Server Error" }, 502);
    if (u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (u.pathname.endsWith("/issues/7/comments")) return failures-- > 0 ? json({ message: "Server Error" }, 502) : json(comments);
    return json({ message: "Not Found" }, 404);
  };
  const claimed = (name = "app") => BACKENDS.actions.trigger.claimedLocally({ owner: "acme", name, full: `acme/${name}` }, 7, { token: "t" }, { pauseMs: 0 });
  try {
    failures = Infinity;
    assert.equal(await claimed(), false, "a listing that keeps failing is no claim seen: an unlabelled Objective's runner job works it, never skips");
    failures = 1;
    assert.equal(await claimed(), false, "read again: no claim, the runner works it");
    comments = claim(new Date().toISOString());
    assert.equal(await claimed(), true);
    comments = claim(ago(HOUR));
    assert.equal(await claimed(), false, "a stale claim holds nothing");
    // The writer list never loads: a marked comment whose author cannot be checked may be a live loop's.
    failures = 0;
    comments = claim(new Date().toISOString(), "dev");
    assert.equal(await claimed("nowriters"), true);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

test("local claim read: an unread claim Blocks only when Factory wrote nothing on the issue for the day; a live stage's progress keeps it waiting (#167)", async () => {
  // Running 30 hours (a multi-part Objective), and this tick's claim read fails; the Block's own reads answer.
  const tick = (timeline) => {
    let reads = 0;
    // The claim read fails through every one of the client's tries; the Block's own read of the comments then answers.
    return localTick({ open: [localIssue(7, "factory:running")], timeline: () => timeline, comments: (n) => (n === 7 && ++reads <= RETRY.tries ? 502 : []) });
  };
  const running = labelled("factory:running", ago(30 * HOUR));
  // Its progress comment, by Factory's login, was updated 5 minutes ago: a live stage, so it waits.
  const live = await tick([...running, { event: "commented", user: { login: "maintainer" }, actor: { login: "maintainer" }, created_at: ago(29 * HOUR), updated_at: ago(5 * 60_000) }]);
  assert.deepEqual(live.r.vanished, []);
  assert.equal(live.blocked(7), undefined);
  // On the Action, a local loop writes as its developer: a Factory marker comment by a person with push access counts.
  const developer = await tick([...running, { event: "commented", user: { login: "dev" }, author_association: "MEMBER", body: "<!-- factory:7:progress -->\nworking", created_at: ago(29 * HOUR), updated_at: ago(5 * 60_000) }]);
  assert.deepEqual(developer.r.vanished, []);
  // A label event by Factory within the day counts too.
  const labelledLately = await tick([...running, { event: "labeled", label: { name: "factory:in-review" }, actor: { login: "maintainer" }, created_at: ago(3 * HOUR) }]);
  assert.deepEqual(labelledLately.r.vanished, []);
  // Someone else's comment is no sign of a live stage.
  const quiet = await tick([...running, { event: "commented", user: { login: "stranger" }, actor: { login: "stranger" }, created_at: ago(HOUR), updated_at: ago(HOUR) }, { event: "commented", user: { login: "maintainer" }, created_at: ago(26 * HOUR), updated_at: ago(25 * HOUR) }]);
  assert.deepEqual(quiet.r.vanished, [7]);
  assert.match(quiet.blocked(7), /Running for over a day and its local claim cannot be read or checked \(#7's comments could not be read \(502\)\)[^]*"cause":"factory"/);
});

/**
 * One dispatcher tick on a repository whose workflow sets a cloud sandbox and which runs both routes (#235): #50 a
 * factory:local Objective Running on a live local claim, whose record holds three dispatch markers older than
 * START_LOST_MS (a local loop wrote them before #235: each reads as a `lost` start); #51 a factory:local Objective
 * Queued; #60 a sandbox-route Objective Queued, with a stale launch lock. Record writes go through writeSandboxRecord
 * into `store`; the lock pass goes through lib/lock.mjs against the same fake GitHub.
 */
async function sandboxRepoTick(env, { localSlots = null, extra = () => ({}) } = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const { marker, sandboxMarkerLine, setSelf, START_LOST_MS } = await import("../scripts/lib/logic.mjs");
  const { BASE, BOT, REPO, githubStore } = await import("./fixtures/github-records.mjs");
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const iss = (number, labels) => ({ number, state: "open", labels: ["factory:objective", ...labels].map((name) => ({ name })), body: "", updated_at: iso(now), user: { login: "maintainer" } });
  // `extra`: more Objectives for one test, `{ open, comments, timeline }` from this tick's helpers.
  const more = extra({ now, iso, iss, marker, sandboxMarkerLine, BOT });
  const open = [iss(50, ["factory:local", "factory:running"]), iss(51, ["factory:local"]), iss(60, []), ...(more.open || [])];
  const named = (ago) => ({ stage: "work", event: "dispatch", ok: null, run: "", at: iso(now - ago) });
  const lostRecord = { vendor: "vercel", stage: "work", state: "named", at: iso(now - 50 * 60_000), launches: [named(START_LOST_MS + 30 * 60_000), named(START_LOST_MS + 20 * 60_000), named(START_LOST_MS + 10 * 60_000)] };
  const comments = {
    50: [
      { id: 500, user: BOT, updated_at: iso(now), body: `${marker(50, "sandbox")}\n${sandboxMarkerLine(lostRecord)}` },
      { id: 501, user: { login: "maintainer", type: "User" }, updated_at: iso(now), body: `${marker(50, "local")}\n${claimBody("box-a", new Date(now - 30_000))}` },
    ],
    ...more.comments,
  };
  const timeline = { 50: [{ event: "labeled", label: { name: "factory:running" }, created_at: iso(now - 60 * 60_000) }], ...more.timeline };
  const LOCK = "refs/factory-launch/60/work-book-abc";
  const refs = new Map([[LOCK, "c".repeat(40)]]);
  const calls = [];
  const store = githubStore({ seed: 5 });
  setSelf(BOT.login);
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  for (const k of ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const p = u.pathname.replace(`/repos/${REPO.full}/`, "");
    const n = Number(/^issues\/(\d+)\//.exec(p)?.[1]);
    if (u.pathname === "/graphql") {
      const { query, variables } = JSON.parse(init.body);
      if (/defaultBranchRef/.test(query)) return json({ data: { repository: { id: BASE.repositoryId, defaultBranchRef: { target: { tree: { oid: BASE.tree } } } } } });
      if (/updateRefs/.test(query)) {
        const [r] = variables.refUpdates;
        calls.push(`updateRefs ${r.name}`);
        if (refs.get(r.name) === r.beforeOid) refs.delete(r.name);
        return json({ data: { updateRefs: { clientMutationId: null } } });
      }
      return json({});
    }
    if (p.startsWith("git/")) calls.push(`${method} ${p}`);
    if (method === "GET" && p === "git/matching-refs/factory-launch/") return json([...refs].map(([ref, sha]) => ({ ref, object: { sha, type: "commit" } })));
    if (method === "GET" && p.startsWith("git/ref/factory-launch/")) return refs.has(`refs/${p.slice(8)}`) ? json({ ref: `refs/${p.slice(8)}`, object: { sha: refs.get(`refs/${p.slice(8)}`), type: "commit" } }) : json({ message: "Not Found" }, 404);
    if (method === "GET" && p === `git/commits/${"c".repeat(40)}`) return json({ sha: "c".repeat(40), message: `${LOCK}\n\n0123`, author: { name: "Factory", email: "factory@users.noreply.github.com", date: iso(now - 60 * 60_000) } });
    if (method === "GET" && u.pathname === "/user") return json({ login: "maintainer", type: "User" });
    if (method === "GET" && p === "issues") return json(u.searchParams.get("state") === "closed" ? [] : open);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (method === "GET" && /^issues\/\d+\/timeline$/.test(p)) return json(timeline[n] || []);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /comments$/.test(p)) return json(comments[n] || []);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo: REPO.full, objectiveLabel: "factory:objective", maxConcurrent: 5, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60, sandbox: "vercel" }, { token: "t", localSlots, recordWrites: { api: store.api, base: BASE } });
    const markers = (k) => store.bodyOf(k, marker(k, "sandbox"));
    return { r, calls, refs, markers };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    setSelf(null);
  }
}

test("serve on a repository with a cloud sandbox: no sandbox record or launch entry on a local Objective (#235)", async () => {
  const serve = await sandboxRepoTick({ FACTORY_LOCAL: "1" }, { localSlots: 2 });
  assert.deepEqual(serve.r.ready, [51], "the local loop picks its Queued Objective");
  assert.equal(serve.markers(51), null, "no sandbox record for the local pick");
  assert.equal(serve.markers(50), null, "no launch entry added to the local Running one");
  // --all routes every Objective to the loop, which runs each on its box: still no record.
  const all = await sandboxRepoTick({ FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" }, { localSlots: 3 });
  assert.deepEqual(all.r.ready, [51, 60]);
  for (const n of [50, 51, 60]) assert.equal(all.markers(n), null, `#${n}`);
});

test("serve leaves the sandbox route's launch locks to that route; the Action's dispatcher still clears them (#235)", async () => {
  const serve = await sandboxRepoTick({ FACTORY_LOCAL: "1" }, { localSlots: 2 });
  assert.deepEqual(serve.calls, [], "no lock listed, read or released");
  assert.ok(serve.refs.has("refs/factory-launch/60/work-book-abc"));
  const actions = await sandboxRepoTick({});
  assert.ok(actions.calls.includes("updateRefs refs/factory-launch/60/work-book-abc"), "the sandbox route releases its stale lock");
  assert.equal(actions.refs.size, 0);
});

test("lost launch entries never count as failed starts for a local Objective; the Action's dispatcher still marks its own picks (#235)", async () => {
  // serve: #50's three lost entries are no failed starts: it is not named again and holds nothing; its live claim keeps it.
  const serve = await sandboxRepoTick({ FACTORY_LOCAL: "1" }, { localSlots: 2 });
  assert.deepEqual(serve.r.relaunch, []);
  assert.deepEqual(serve.r.vanished, []);
  assert.ok(!serve.r.deadlines.some((d) => d.issue === 50 && d.kind === "start-retry"), "no retry wake for a start the sandbox route never made");
  // The Action's dispatcher: #60 is its pick, marked as it is named; the local Objectives are not its to mark or name.
  const actions = await sandboxRepoTick({});
  assert.deepEqual(actions.r.ready, [60]);
  assert.deepEqual(actions.r.relaunch, []);
  const { sandboxRecordOf } = await import("../scripts/lib/logic.mjs");
  const marked = sandboxRecordOf(actions.markers(60)).launches.at(-1);
  assert.deepEqual([marked.stage, marked.event, marked.ok], ["work", "dispatch", null]);
  assert.equal(actions.markers(50), null);
  assert.equal(actions.markers(51), null);
});

/** A sandbox stage of Objective `n` holding its lease for another half hour: the record a launcher writes as it starts one. */
const leased = ({ now, iso, marker, sandboxMarkerLine, BOT }, n) => [{ id: 900 + n, user: BOT, updated_at: iso(now), body: `${marker(n, "sandbox")}\n${sandboxMarkerLine({ vendor: "vercel", id: `factory-${n}`, stage: "work", state: "running", claim: "abcabcabcabc", at: iso(now - 20 * 60_000), leaseUntil: iso(now + 30 * 60_000), launches: [{ stage: "work", event: "issues", ok: true, run: "1", at: iso(now - 20 * 60_000) }] })}` }];

test("serve waits out a live sandbox lease before it restarts an Objective relabelled factory:local mid-stage (#235)", async () => {
  // #63 ran on the sandbox route; a person relabelled it factory:local and asked for a restart while its stage still holds its lease.
  const extra = (h) => ({
    open: [h.iss(63, ["factory:local", "factory:running", "factory:restart"])],
    comments: { 63: leased(h, 63) },
    timeline: { 63: [{ event: "labeled", label: { name: "factory:running" }, created_at: h.iso(h.now - 20 * 60_000) }, { event: "labeled", label: { name: "factory:restart" }, actor: { login: "maintainer" }, created_at: h.iso(h.now - 60_000) }] },
  });
  const serve = await sandboxRepoTick({ FACTORY_LOCAL: "1" }, { localSlots: 3, extra });
  assert.deepEqual(serve.r.restarted, [], "not restarted while the sandbox still runs it");
  assert.ok(!serve.r.ready.includes(63), "nor picked here");
  assert.ok(serve.r.deadlines.some((d) => d.issue === 63 && d.kind === "retry"), "held until its stage stops: looked at again next tick");
  assert.equal(serve.markers(63), null, "the record is read, never written");
  assert.deepEqual(serve.calls, [], "and no lock is touched");
});

test("serve --all keeps a sandbox-route Objective whose stage holds a live lease: no 'worker job vanished' Block (#235)", async () => {
  // #62: Running on the sandbox route for 20 minutes, no Actions job, no local claim, its sandbox stage within its lease.
  const extra = (h) => ({
    open: [h.iss(62, ["factory:running"])],
    comments: { 62: leased(h, 62) },
    timeline: { 62: [{ event: "labeled", label: { name: "factory:running" }, created_at: h.iso(h.now - 20 * 60_000) }] },
  });
  const all = await sandboxRepoTick({ FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" }, { localSlots: 3, extra });
  assert.deepEqual(all.r.vanished, []);
  assert.ok(all.r.deadlines.some((d) => d.issue === 62 && d.kind === "lease"), "looked at again when its lease ends");
  assert.equal(all.markers(62), null, "no record written for it here");
  assert.deepEqual(all.r.relaunch, []);
});

test("max_concurrent caps the repository as a whole: every route's Running Objectives count, each route picks only its own (#240)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const obj = (number, ...labels) => ({ number, state: "open", labels: ["factory:objective", ...labels].map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });
  // #1 the Action's, Running five minutes (its job inside the start grace); #2 a local loop's, paused (its machine away an
  // hour); #3 a local loop's, alive. #4 the Action's and #5 a local loop's, Queued. #6 a draft still labelled Running.
  const open = [obj(1, "factory:running"), obj(2, "factory:local", "factory:running"), obj(3, "factory:local", "factory:running"), obj(4), obj(5, "factory:local"), obj(6, "factory:running", "factory:draft")];
  const claim = (n, at) => ({ id: 70 + n, user: { login: "maintainer", type: "User" }, body: `<!-- factory:${n}:local -->\n${claimBody(`box-a:${n}:abc:m:b`, new Date(at))}`, updated_at: new Date(at).toISOString() });
  const comments = (n) => (n === 2 ? [claim(2, Date.now() - HOUR)] : n === 3 ? [claim(3, Date.now() - 30_000)] : []);
  const timeline = (n) => labelled("factory:running", ago(n === 1 ? 5 * 60_000 : 2 * HOUR));
  const tick = (env, maxConcurrent) => localTick({ open, timeline, comments, env, maxConcurrent });

  // At the cap (three Running across both routes, the paused one among them; the draft not counted): neither route picks.
  for (const env of [{}, { FACTORY_LOCAL: "1" }, { FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" }]) {
    const { r } = await tick(env, 3);
    assert.deepEqual(r.ready, [], `${JSON.stringify(env)}: nothing starts at the cap`);
    assert.equal(r.running, 3);
    assert.equal(r.reason, "max_concurrent reached");
    assert.deepEqual(r.vanished, [], "no Running one is Blocked");
    assert.deepEqual(r.paused, [2], "the paused one keeps its place");
  }
  // One slot free: each route takes it with its own Objective; serve --all routes both and takes the first.
  assert.deepEqual((await tick({}, 4)).r.ready, [4]);
  assert.deepEqual((await tick({ FACTORY_LOCAL: "1" }, 4)).r.ready, [5]);
  assert.deepEqual((await tick({ FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" }, 4)).r.ready, [4]);
});
