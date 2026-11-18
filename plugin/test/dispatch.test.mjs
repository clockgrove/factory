import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlockedBy, priorityOf, selectReady, stateOf, sumSpend } from "../scripts/lib/logic.mjs";
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

test("Running, Blocked, Question and In review are excluded, from the card first, then the label", () => {
  const issues = [issue(1), issue(2, ["pendulum:running"]), issue(3, ["pendulum:blocked"]), issue(4, ["pendulum:question"]), issue(5), issue(6, ["pendulum:in-review"])];
  const statuses = { 1: "Queued", 5: "Running" };
  const { ready, running, skipped } = selectReady({ issues, statuses, maxConcurrent: 10, dailyUsd: 100 });
  assert.deepEqual(ready, [1]);
  assert.equal(running, 2);
  assert.deepEqual(skipped.map((s) => s.reason), ["Running", "Blocked", "Question", "Running", "In review"]);
  assert.equal(stateOf(issue(9, ["pendulum:blocked"]), "Queued"), "Blocked", "a Queued card with a blocked label: the label wins");
  assert.equal(stateOf(issue(9, ["pendulum:blocked"]), "Running"), "Running", "a non-Queued card wins over the label");
  // The board has no Question column: a Question's card sits in In review, and its label says Question (#57).
  assert.equal(stateOf(issue(9, ["pendulum:question"]), "In review"), "Question");
  assert.equal(stateOf(issue(9, ["pendulum:in-review"]), "In review"), "In review");
  assert.equal(stateOf(issue(9, ["pendulum:question"]), "Running"), "Running", "a stale question label on a Running card is no Question");
  assert.deepEqual(selectReady({ issues: [issue(4, ["pendulum:question"])], statuses: { 4: "In review" }, maxConcurrent: 10, dailyUsd: 100 }).skipped, [{ number: 4, reason: "Question" }]);
});

test("max_concurrent minus running caps the start list", () => {
  const issues = [issue(1), issue(2), issue(3), issue(4, ["pendulum:running"]), issue(5, ["pendulum:running"])];
  const r = selectReady({ issues, maxConcurrent: 4, dailyUsd: 100 });
  assert.deepEqual(r.ready, [1, 2]);
  assert.equal(r.running, 2);
  assert.ok(r.skipped.some((s) => s.number === 3 && s.reason === "max_concurrent reached"));
  const full = selectReady({ issues, maxConcurrent: 2, dailyUsd: 100 });
  assert.deepEqual(full.ready, []);
  assert.equal(full.reason, "max_concurrent reached");
});

test("daily_usd reached starts nothing; a run of unknown cost adds no dollars and is named beside them", () => {
  const records = [{ usd: 40.5 }, { usd: null }, { usd: 60 }, { usd: "x" }];
  assert.deepEqual(sumSpend(records), { usd: 100.5, unknown: 2 });
  const spent = sumSpend(records);
  const r = selectReady({ issues: [issue(1, ["P0"])], maxConcurrent: 3, dailyUsd: 100, spentToday: spent.usd, unknownToday: spent.unknown });
  assert.deepEqual(r.ready, []);
  assert.equal(r.reason, "daily_usd reached");
  assert.match(r.skipped[0].reason, /daily_usd reached \(\$100\.50 plus 2 runs of unknown cost of \$100\)/);
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

test("blocking: an issue whose REST relations were rate limited is not picked this tick, even with no body lines", () => {
  const issues = [issue(4, [], "", { relationsUnread: true }), issue(6)];
  const { ready, skipped } = selectReady({ issues, maxConcurrent: 5, dailyUsd: 100 });
  assert.deepEqual(ready, [6]);
  assert.match(skipped.find((s) => s.number === 4).reason, /rate limited/);
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

  // A person's removal (a writer's dequeue) is a hold: Pendulum neither puts it back nor counts it toward the Block.
  const manual = { at: "2026-11-09T10:50:00Z", reason: "dequeued", actor: "kirk", person: true };
  assert.deepEqual(queueRetry([manual], { since }), { hold: { at: manual.at, code: "dequeued" }, drops: 0 }, "a hand removal stays out");
  assert.deepEqual(queueRetry([timedOut, manual], { since, self: "pendulum-app[bot]" }).hold, { at: manual.at, code: "dequeued" }, "a hand removal after a drop is still a hold");
  assert.deepEqual(queueRetry([manual, { at: "2026-11-09T11:30:00Z", reason: "failed_checks", actor: q }], { since }), { enqueue: true, drops: 1, last: { at: "2026-11-09T11:30:00Z", code: "failed_checks" } }, "re-enqueued by the person and dropped by the queue: one drop, the hold not counted");
  assert.equal(queueRetry([manual, manual], { since: "2026-11-09T11:00:00Z" }).enqueue, true, "a new review after the hold puts it back");

  // Pendulum's own removal of a stalled entry is a drop, by its login (the timeline names the App without [bot]) or
  // marked `self` before the timeline shows it.
  const stalled = { at: "2026-11-09T09:47:00Z", reason: "dequeued", actor: "pendulum-app", person: false };
  assert.deepEqual(queueRetry([stalled], { since, self: "pendulum-app[bot]" }), { enqueue: true, drops: 1, last: { at: stalled.at, code: STALL_CODE, pendulum: true } });
  // #2683 F2: an earlier removal of a hung entry, its code read back from Pendulum's requeue record, keeps that code.
  const hungBefore = { ...stalled, code: HUNG_CODE };
  const hungTwice = queueRetry([hungBefore, { at: "2026-11-09T09:58:00Z", reason: STALL_CODE, code: HUNG_CODE, self: true }], { since, self: "pendulum-app[bot]" });
  assert.deepEqual(hungTwice.codes, [HUNG_CODE], "never read as checks_never_started");
  const twice = queueRetry([stalled, { at: "2026-11-09T09:58:00Z", reason: STALL_CODE, self: true }], { since, self: "pendulum-app[bot]" });
  assert.match(twice.block, new RegExp(`2 times without merging it \\(${STALL_CODE}\\)`));
  assert.deepEqual(queueRetry([stalled], { since }), { enqueue: true, drops: 1, last: { at: stalled.at, code: "dequeued" } }, "without Pendulum's login known, its App is still a bot: a drop, never a hold that leaves the PR out");
});

test("queueRetry: a hung removal of Pendulum's whose step then finished green in time counts toward no try; anything else counts (#437)", async () => {
  const { HUNG_CODE, STALL_CODE, queueRetry } = await import("../scripts/lib/logic.mjs");
  const since = "2026-11-09T09:30:00Z";
  const self = "pendulum-app[bot]";
  const hung = { at: "2026-11-09T09:47:00Z", reason: "dequeued", actor: "pendulum-app", person: false, code: HUNG_CODE };
  const again = { at: "2026-11-09T09:58:00Z", reason: STALL_CODE, code: HUNG_CODE, self: true };
  assert.ok(queueRetry([hung, again], { since, self }).block, "both count: two drops Block");
  assert.deepEqual(queueRetry([{ ...hung, cleared: true }, again], { since, self }), { enqueue: true, drops: 1, last: { at: again.at, code: HUNG_CODE, pendulum: true }, cleared: 1 }, "the slow step's removal leaves the tries as they were");
  assert.deepEqual(queueRetry([{ ...hung, cleared: true }], { since, self }), { enqueue: true, drops: 0, last: { at: hung.at, code: HUNG_CODE, pendulum: true, cleared: true }, cleared: 1 }, "a cleared removal is never a hold: the PR goes back");
  assert.ok(queueRetry([{ ...hung, code: STALL_CODE, cleared: true }, again], { since, self }).block, "only a hung removal can be cleared");
  const person = { at: "2026-11-09T09:40:00Z", reason: "dequeued", actor: "kirk", person: true, code: HUNG_CODE, cleared: true };
  assert.deepEqual(queueRetry([person], { since, self }).hold, { at: person.at, code: "dequeued" }, "a person's removal stays a hold");
  const queue = { at: "2026-11-09T09:50:00Z", reason: "checks_timed_out", actor: "github-merge-queue", code: HUNG_CODE, cleared: true };
  assert.ok(queueRetry([queue, again], { since, self }).block, "the queue's own drop counts whatever it carries");
  // A step slow on every try: one removal at most is cleared, so the third hung removal Blocks, never an endless loop.
  const slow = (min) => ({ at: `2026-11-09T${String(9 + Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00Z`, reason: "dequeued", actor: "pendulum-app", person: false, code: HUNG_CODE, cleared: true });
  assert.deepEqual(queueRetry([slow(40), slow(80)], { since, self }), { enqueue: true, drops: 1, last: { at: slow(80).at, code: HUNG_CODE, pendulum: true }, cleared: 1 });
  const thrice = queueRetry([slow(40), slow(80), slow(120)], { since, self });
  assert.equal(thrice.drops, 2);
  assert.equal(thrice.cleared, 1);
  assert.ok(thrice.block, "three slow-but-green removals still Block");
  assert.ok(queueRetry([slow(40), slow(80), slow(120), slow(160), slow(200), slow(240)], { since, self }).block, "and so do six");
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
  // Tonight's case (the scratch repository's run 42759031247): setup.sh normally about a minute, running 15.
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

test("requeueLine: the issue's one line at a re-enqueue, codes and times only", async () => {
  const { requeueLine } = await import("../scripts/lib/session.mjs");
  assert.equal(requeueLine(300, { at: "2026-11-09T10:40:04Z", code: "checks_timed_out" }, 2), "Pendulum: the merge queue dropped PR #300 (checks_timed_out) at Nov 9, 10:40 AM UTC; enqueued again (try 2).");
  assert.equal(requeueLine(300, { at: "<b>", code: "unknown" }, 2), "Pendulum: the merge queue dropped PR #300 (unknown) at an unknown time; enqueued again (try 2).");
  assert.equal(requeueLine(300, { at: "2026-11-09T10:40:04.123Z", code: "failed_checks" }, 2).includes("\n"), false);
});

test("activeWorkIssues: a failed Actions listing throws, so the dispatcher leaves a Running Objective alone instead of Blocking it as vanished", async () => {
  const { createServer } = await import("node:http");
  const { activePendulumJobs, activeWorkIssues } = await import("../scripts/lib/github.mjs");
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
    assert.equal((await activePendulumJobs(repo, { token: "t" })).work.size, 0, "the lenient listing still reads a failure as none");
    fail = false;
    assert.deepEqual([...(await activeWorkIssues(repo, { token: "t" }))], [12]);
  } finally {
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
    server.close();
  }
});

test("local loop: every sweep pass acts only on the Objectives it routes; its Done pass records each removal as Pendulum's first (#2668)", async () => {
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
  const open = [iss(5, ["pendulum:objective", "pendulum:running"]), iss(6, ["pendulum:objective", "pendulum:running"])];
  const daysAgo = (d) => new Date(now - d * 86_400_000).toISOString();
  const claim = { id: 66, user: { login: "maintainer", type: "User" }, body: `<!-- pendulum:6:local -->\n${claimBody("box-a", new Date(daysAgo(1.5)))}` };
  const closed = [iss(373, ["pendulum:objective", "pendulum:in-review"], "closed"), iss(380, ["pendulum:objective", "pendulum:local", "pendulum:in-review"], "closed")];
  const tick = async (env, { failRecord = false } = {}) => {
    const writes = [];
    const realFetch = globalThis.fetch;
    const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
    for (const k of ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (method !== "GET" && !u.pathname.endsWith("/graphql")) writes.push(`${method} ${u.pathname.replace("/repos/acme/app", "")}${method === "POST" ? ` ${JSON.parse(init.body).body ?? ""}` : ""}`);
      if (method === "GET" && u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? closed : open);
      if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
      if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json([{ event: "labeled", label: { name: "pendulum:running" }, created_at: u.pathname.includes("/issues/6/") ? daysAgo(2) : hourAgo }]);
      if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (method === "GET" && /\/comments$/.test(u.pathname)) return json(u.pathname.includes("/issues/6/") ? [claim] : []);
      if (method === "POST" && /\/comments$/.test(u.pathname)) return failRecord && JSON.parse(init.body).body?.includes(":done -->") ? json({ message: "Bad Gateway" }, 502) : json({ id: 1 }, 201);
      if (method === "DELETE" || method === "POST") return json({}, 200);
      return json({ message: "Not Found" }, 404);
    };
    try {
      const r = await dispatch({ repo: "acme/app", objectiveLabel: "pendulum:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t", localSlots: 2 });
      return { r, writes };
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const on = (writes, n) => writes.filter((w) => w.includes(`/issues/${n}/`));

  // A local loop: #373 and #5 are another route's, untouched in every pass; #380 is its own, recorded before any removal.
  const local = await tick({ PENDULUM_LOCAL: "1" });
  assert.deepEqual(local.r.done, [380]);
  assert.deepEqual(local.r.vanished, [6], "another route's Running Objective is that route's to judge, unless a local loop claimed it");
  assert.ok(local.writes.includes("DELETE /issues/comments/66"), "the expired claim goes with the Block");
  assert.deepEqual(on(local.writes, 373), [], "no label, card or comment change on another route's Objective");
  assert.deepEqual(on(local.writes, 5), []);
  const own = on(local.writes, 380);
  assert.equal(own[0], `POST /issues/380/comments <!-- pendulum:380:done -->\n${doneRecord(["pendulum:in-review"])}`, "the record comes first");
  assert.ok(own.slice(1).every((w) => w.startsWith("DELETE /issues/380/labels/")) && own.length > 1);
  // The record could not be posted: no label leaves #380 unmarked; they wait for the next tick.
  const failed = await tick({ PENDULUM_LOCAL: "1" }, { failRecord: true });
  assert.deepEqual(failed.r.done, []);
  assert.ok(!on(failed.writes, 380).some((w) => w.startsWith("DELETE")), "no removal without its record");
  // With --all the loop routes every Objective, so it tends #373 too, recorded the same way.
  const all = await tick({ PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" });
  assert.deepEqual(all.r.done, [373, 380]);
  assert.match(on(all.writes, 373)[0], /^POST \/issues\/373\/comments <!-- pendulum:373:done -->\n[^]*\nremoved: pendulum:in-review$/);
  // The Action tends every route's closed Objectives, as its App: no record.
  const actions = await tick({});
  assert.deepEqual(actions.r.done, [373, 380]);
  assert.ok(!actions.writes.some((w) => w.startsWith("POST") && w.includes(":done -->")), "the App's removals need no record");

  // The pure pieces: which closed Objectives the pass tidies, per backend, and what it removes.
  const tends = (env) => (i) => BACKENDS.local.trigger.tends(i, env);
  assert.deepEqual(doneTidies(closed, { tends: tends({}) }), [{ number: 380, labels: ["pendulum:in-review"] }]);
  assert.deepEqual(doneTidies(closed, { tends: tends({ PENDULUM_LOCAL_ALL: "1" }) }).map((d) => d.number), [373, 380]);
  assert.deepEqual(doneTidies(closed, { tends: BACKENDS.actions.trigger.tends }).map((d) => d.number), [373, 380]);
  assert.deepEqual(doneTidies([iss(9, ["pendulum:objective", "pendulum:local"], "closed")], { tends: tends({}), project: true, cards: { 9: "In review" } }), [{ number: 9, labels: [] }], "a card left behind moves, with nothing to record");
  assert.equal(BACKENDS.local.trigger.asPerson, true);
  assert.equal(BACKENDS.actions.trigger.asPerson, false);
});

/**
 * One dispatcher tick on the Action's route over pendulum:local Objectives (#167). `open`: the open issues; `timeline(n)`:
 * each one's label events; `comments(n)`: its comments, or a status to fail the read with; `pulls(n)`: its open PRs;
 * `writers`: the collaborators read, or a status to fail it with.
 */
async function localTick({ repo = "acme/app", open, timeline, comments = () => [], pulls = () => [], writers = [{ login: "maintainer" }], env = {}, maxConcurrent = 2, inputs = {}, opts = {}, extra = () => null }) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const writes = [];
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  for (const k of ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const n = Number(/\/issues\/(\d+)\//.exec(u.pathname)?.[1]);
    if (method !== "GET" && !u.pathname.endsWith("/graphql")) writes.push(`${method} ${u.pathname.replace(`/repos/${repo}`, "")}${method === "POST" ? ` ${JSON.parse(init.body).body ?? ""}` : ""}`);
    const own = extra(u, method);
    if (own !== null) return json(own);
    if (method === "GET" && u.pathname === "/user") return json({ login: "maintainer", type: "User" });
    if (method === "GET" && u.pathname === `/repos/${repo}/issues`) return json(u.searchParams.get("state") === "closed" ? [] : open);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json(timeline(n));
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return Array.isArray(writers) ? json(writers) : json({ message: "Server Error" }, writers);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
      const c = comments(n);
      return Array.isArray(c) ? json(c) : json({ message: "Server Error" }, c);
    }
    if (method === "GET" && u.pathname === `/repos/${repo}/pulls`) return json(pulls(Number(/pendulum\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1])));
    if (method === "POST" && /\/comments$/.test(u.pathname)) return json({ id: 1 }, 201);
    if (method === "DELETE" || method === "POST") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo, objectiveLabel: "pendulum:objective", maxConcurrent, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, ...inputs }, { token: "t", ...opts });
    return { r, writes, blocked: (n) => writes.find((w) => w.startsWith(`POST /issues/${n}/comments`) && /blocked/i.test(w)) };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;
const localIssue = (number, state, labels = ["pendulum:local"]) => ({ number, state: "open", labels: ["pendulum:objective", ...labels, state].map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });
const labelled = (name, at) => [{ event: "labeled", label: { name }, created_at: at }];

test("local claim read: a failed read is unread, never 'no claim'; the next tick reads it and the Objective runs on (#167)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  // Running 40 minutes, a fresh claim; the first tick's claim read fails, the second's answers.
  const claim = { id: 77, user: { login: "maintainer", type: "User" }, body: `<!-- pendulum:7:local -->\n${claimBody("box-a:1:abc:m:b", new Date(Date.now() - 30_000))}`, updated_at: ago(30_000) };
  let fail = true;
  const tick = () => localTick({ open: [localIssue(7, "pendulum:running")], timeline: () => labelled("pendulum:running", ago(40 * 60_000)), comments: (n) => (n === 7 && fail ? 502 : n === 7 ? [claim] : []) });
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
  const body = (holder) => `<!-- pendulum:7:local -->\n${claimBody(holder, new Date())}`;
  const open = [{ ...localIssue(7, "pendulum:running", []), labels: ["pendulum:objective", "pendulum:running"].map((name) => ({ name })) }];
  const timeline = () => labelled("pendulum:running", ago(2 * HOUR));
  // A repository whose writer list cannot be read: the developer's claim is unread, so nothing Blocks this tick.
  const unread = await localTick({ repo: "acme/unread", open, timeline, writers: 502, comments: (n) => (n === 7 ? [{ id: 5, user: { login: "dev", type: "User" }, body: body("box-a:1:abc:m:b"), updated_at: ago(0) }] : []) });
  assert.deepEqual(unread.r.vanished, []);
  assert.ok(unread.r.deadlines.some((d) => d.kind === "retry"));
  // With the writers read, a marker by someone who cannot push is no claim: the unclaimed Running one is a lost runner
  // job, relaunched (its Block once the relaunches are used, relaunch.test.mjs).
  const stranger = await localTick({ open, timeline, comments: (n) => (n === 7 ? [{ id: 6, user: { login: "stranger", type: "User" }, body: body("box-x:1:abc:m:b"), updated_at: ago(0) }] : []) });
  assert.deepEqual([stranger.r.vanished, stranger.r.relaunched], [[], [7]]);
  assert.ok(!stranger.writes.includes("DELETE /issues/comments/6"), "a stranger's comment is not Pendulum's to delete");
});

test("local deadlines: a pendulum:local Objective with no claim waits a day, Running or in review, then Blocks naming pendulum serve (#167)", async () => {
  const pr = (n) => [{ number: 100 + n, draft: false, labels: [{ name: "pendulum:review" }], head: { ref: `pendulum/${n}` } }];
  // #7 Running 2 hours and #8 in review for 2 hours, neither claimed: they wait, with a wake at the day's end.
  const young = await localTick({
    open: [localIssue(7, "pendulum:running"), localIssue(8, "pendulum:in-review")],
    timeline: (n) => labelled(n === 7 ? "pendulum:running" : n === 8 ? "pendulum:in-review" : "pendulum:review", ago(2 * HOUR)),
    pulls: (n) => (n === 8 ? pr(8) : []),
  });
  assert.deepEqual(young.r.vanished, [], "no 15-minute grace for a local Objective");
  assert.deepEqual(young.r.deadlines.filter((d) => d.kind === "local-pause").map((d) => d.issue).sort(), [7, 8]);
  // Past a day: both Block, and the reason names the fix.
  const old = await localTick({
    open: [localIssue(7, "pendulum:running"), localIssue(8, "pendulum:in-review")],
    // The PR's (#108) review label is as old as its In-review entry.
    timeline: (n) => labelled(n === 7 ? "pendulum:running" : n === 8 ? "pendulum:in-review" : "pendulum:review", ago(25 * HOUR)),
    pulls: (n) => (n === 8 ? pr(8) : []),
  });
  assert.deepEqual(old.r.vanished.sort(), [7, 8]);
  for (const n of [7, 8]) assert.match(old.blocked(n), /no local loop[^]*start `pendulum serve` on the machine that runs it[^]*<!-- pendulum:block \{"cause":"setup"\} -->/);
  // In review for three days, but pendulum:review re-applied to its PR 2 hours ago (a maintainer's comment, a re-review):
  // a new review is owed, and its day counts from that label.
  const rereview = await localTick({ open: [localIssue(8, "pendulum:in-review")], timeline: (n) => labelled(n === 8 ? "pendulum:in-review" : "pendulum:review", ago(n === 8 ? 72 * HOUR : 2 * HOUR)), pulls: pr });
  assert.deepEqual(rereview.r.vanished, []);
  assert.equal(rereview.r.deadlines.find((d) => d.issue === 8 && d.kind === "local-pause")?.at.slice(0, 13), new Date(Date.now() + 22 * HOUR).toISOString().slice(0, 13));
  // In review with no review owed (reviewed, waiting on a person): no deadline.
  const reviewed = await localTick({ open: [localIssue(8, "pendulum:in-review")], timeline: () => labelled("pendulum:in-review", ago(25 * HOUR)), pulls: () => [{ ...pr(8)[0], labels: [] }] });
  assert.deepEqual(reviewed.r.vanished, []);
  // An unlabelled Objective's runner job still gets 15 minutes; then it is lost, and relaunched (relaunch.test.mjs).
  const runner = await localTick({ open: [{ ...localIssue(9, "pendulum:running", []) }], timeline: () => labelled("pendulum:running", ago(20 * 60_000)) });
  assert.deepEqual([runner.r.vanished, runner.r.relaunched], [[], [9]]);
  assert.ok(!runner.writes.some((w) => w.includes("<!-- pendulum:9:blocked:")), "no Block notice");
});

/**
 * One dispatcher tick on a repository whose workflow sets a cloud sandbox and which runs both routes (#235): #50 a
 * pendulum:local Objective Running on a live local claim, whose record holds three dispatch markers from 20 to 40
 * minutes old naming no run (a local loop wrote them before #235); #51 a pendulum:local Objective
 * Queued; #60 a sandbox-route Objective Queued, with a stale launch lock. Record writes go through writeSandboxRecord
 * into `store`; the lock pass goes through lib/lock.mjs against the same fake GitHub.
 */
async function sandboxRepoTick(env, { localSlots = null, localLive = null, extra = () => ({}) } = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const { marker, sandboxMarkerLine, setSelf } = await import("../scripts/lib/logic.mjs");
  const { BASE, BOT, REPO, githubStore } = await import("./fixtures/github-records.mjs");
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const iss = (number, labels) => ({ number, state: "open", labels: ["pendulum:objective", ...labels].map((name) => ({ name })), body: "", updated_at: iso(now), user: { login: "maintainer" } });
  // `extra`: more Objectives for one test, `{ open, comments, timeline, failComments }` from this tick's helpers;
  // `failComments`: how many comment-list reads of an issue fail (502) before one answers.
  const more = extra({ now, iso, iss, marker, sandboxMarkerLine, BOT });
  const open = [iss(50, ["pendulum:local", "pendulum:running"]), iss(51, ["pendulum:local"]), iss(60, []), ...(more.open || [])];
  const named = (ago) => ({ stage: "work", event: "dispatch", ok: null, run: "", at: iso(now - ago) });
  const lostRecord = { vendor: "vercel", stage: "work", state: "named", at: iso(now - 50 * 60_000), launches: [named(40 * 60_000), named(30 * 60_000), named(20 * 60_000)] };
  const comments = {
    50: [
      { id: 500, user: BOT, updated_at: iso(now), body: `${marker(50, "sandbox")}\n${sandboxMarkerLine(lostRecord)}` },
      { id: 501, user: { login: "maintainer", type: "User" }, updated_at: iso(now), body: `${marker(50, "local")}\n${claimBody("box-a", new Date(now - 30_000))}` },
    ],
    ...more.comments,
  };
  const timeline = { 50: [{ event: "labeled", label: { name: "pendulum:running" }, created_at: iso(now - 60 * 60_000) }], ...more.timeline };
  const LOCK = "refs/pendulum-launch/60/work-book-abc";
  const refs = new Map([[LOCK, "c".repeat(40)]]);
  const calls = [];
  const store = githubStore({ seed: 5 });
  setSelf(BOT.login);
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  for (const k of ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
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
    if (method === "GET" && p === "git/matching-refs/pendulum-launch/") return json([...refs].map(([ref, sha]) => ({ ref, object: { sha, type: "commit" } })));
    if (method === "GET" && p.startsWith("git/ref/pendulum-launch/")) return refs.has(`refs/${p.slice(8)}`) ? json({ ref: `refs/${p.slice(8)}`, object: { sha: refs.get(`refs/${p.slice(8)}`), type: "commit" } }) : json({ message: "Not Found" }, 404);
    if (method === "GET" && p === `git/commits/${"c".repeat(40)}`) return json({ sha: "c".repeat(40), message: `${LOCK}\n\n0123`, author: { name: "Pendulum", email: "pendulum@users.noreply.github.com", date: iso(now - 60 * 60_000) } });
    if (method === "GET" && u.pathname === "/user") return json({ login: "maintainer", type: "User" });
    if (method === "GET" && p === "issues") return json(u.searchParams.get("state") === "closed" ? [] : open);
    const one = /^issues\/(\d+)$/.exec(p) && open.find((i) => i.number === Number(p.slice(7)));
    if (method === "GET" && one) return json(one);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (method === "GET" && /^issues\/\d+\/timeline$/.test(p)) return json(timeline[n] || []);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /comments$/.test(p) && more.failComments?.[n] > 0) {
      more.failComments[n] -= 1;
      return json({ message: "Bad Gateway" }, 502);
    }
    if (method === "GET" && /comments$/.test(p)) return json(comments[n] || []);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo: REPO.full, objectiveLabel: "pendulum:objective", maxConcurrent: 5, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60, sandbox: "vercel" }, { token: "t", localSlots, localLive, recordWrites: { api: store.api, base: BASE } });
    const markers = (k) => store.bodyOf(k, marker(k, "sandbox"));
    return { r, calls, refs, markers };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    setSelf(null);
  }
}

/** A sandbox stage of Objective `n` holding its lease for another half hour: the record a launcher writes as it starts one. */
const leased = ({ now, iso, marker, sandboxMarkerLine, BOT }, n) => [{ id: 900 + n, user: BOT, updated_at: iso(now), body: `${marker(n, "sandbox")}\n${sandboxMarkerLine({ vendor: "vercel", id: `pendulum-${n}`, stage: "work", state: "running", claim: "abcabcabcabc", at: iso(now - 20 * 60_000), leaseUntil: iso(now + 30 * 60_000), launches: [{ stage: "work", event: "issues", ok: true, run: "1", at: iso(now - 20 * 60_000) }] })}` }];

test("serve waits out a live sandbox lease before it restarts an Objective relabelled pendulum:local mid-stage (#235)", async () => {
  // #63 ran on the sandbox route; a person relabelled it pendulum:local and asked for a restart while its stage still holds its lease.
  const extra = (h) => ({
    open: [h.iss(63, ["pendulum:local", "pendulum:running", "pendulum:restart"])],
    comments: { 63: leased(h, 63) },
    timeline: { 63: [{ event: "labeled", label: { name: "pendulum:running" }, created_at: h.iso(h.now - 20 * 60_000) }, { event: "labeled", label: { name: "pendulum:restart" }, actor: { login: "maintainer", type: "User" }, created_at: h.iso(h.now - 60_000) }] },
  });
  const serve = await sandboxRepoTick({ PENDULUM_LOCAL: "1" }, { localSlots: 3, extra });
  assert.deepEqual(serve.r.restarted, [], "not restarted while the sandbox still runs it");
  assert.ok(!serve.r.ready.includes(63), "nor picked here");
  assert.ok(serve.r.deadlines.some((d) => d.issue === 63 && d.kind === "retry"), "held until its stage stops: looked at again next tick");
  assert.equal(serve.markers(63), null, "the record is read, never written");
  assert.deepEqual(serve.calls, [], "and no lock is touched");
});

test("serve on a repository with a cloud sandbox: an unread sandbox record is no absent lease; the Objective is neither Blocked nor sent back to Queued that tick (#430)", async () => {
  // #62: Running on the sandbox route for 20 minutes (serve --all routes it), and #63: relabelled pendulum:local mid-stage,
  // Running for 20 minutes. Each stage holds a live lease and no local claim. The first comments read of each (the lease
  // read, after its retries) fails; the reads after it answer, so the local claim read finds no claim.
  const extra = (h) => ({
    open: [h.iss(62, ["pendulum:running"]), h.iss(63, ["pendulum:local", "pendulum:running"])],
    comments: { 62: leased(h, 62), 63: leased(h, 63) },
    timeline: Object.fromEntries([62, 63].map((n) => [n, [{ event: "labeled", label: { name: "pendulum:running" }, created_at: h.iso(h.now - 20 * 60_000) }]])),
    failComments: { 62: RETRY.tries, 63: RETRY.tries },
  });
  const all = await sandboxRepoTick({ PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" }, { localSlots: 3, localLive: () => false, extra });
  assert.deepEqual(all.r.vanished, [], "a live sandbox stage is not Blocked as vanished");
  assert.deepEqual(all.r.unclaimed, [], "nor sent back to Queued for a second stage here");
  assert.ok(!all.r.ready.includes(62) && !all.r.ready.includes(63), "nor picked");
  assert.ok(all.r.deadlines.some((d) => d.kind === "retry"), "read again soon");
  // The next tick reads each record: its live lease holds the Objective until the lease ends.
  const next = await sandboxRepoTick({ PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" }, { localSlots: 3, localLive: () => false, extra: (h) => ({ ...extra(h), failComments: {} }) });
  assert.deepEqual([next.r.vanished, next.r.unclaimed], [[], []]);
  for (const n of [62, 63]) assert.ok(next.r.deadlines.some((d) => d.issue === n && d.kind === "lease"), `#${n} looked at again when its lease ends`);
});

test("max_concurrent caps the repository as a whole: every route's Running Objectives count, each route picks only its own (#240)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const obj = (number, ...labels) => ({ number, state: "open", labels: ["pendulum:objective", ...labels].map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });
  // #1 the Action's, Running five minutes (its job inside the start grace); #2 a local loop's, paused (its machine away an
  // hour); #3 a local loop's, alive. #4 the Action's and #5 a local loop's, Queued. #6 a draft still labelled Running.
  const open = [obj(1, "pendulum:running"), obj(2, "pendulum:local", "pendulum:running"), obj(3, "pendulum:local", "pendulum:running"), obj(4), obj(5, "pendulum:local"), obj(6, "pendulum:running", "pendulum:draft")];
  const claim = (n, at) => ({ id: 70 + n, user: { login: "maintainer", type: "User" }, body: `<!-- pendulum:${n}:local -->\n${claimBody(`box-a:${n}:abc:m:b`, new Date(at))}`, updated_at: new Date(at).toISOString() });
  const comments = (n) => (n === 2 ? [claim(2, Date.now() - HOUR)] : n === 3 ? [claim(3, Date.now() - 30_000)] : []);
  const timeline = (n) => labelled("pendulum:running", ago(n === 1 ? 5 * 60_000 : 2 * HOUR));
  const tick = (env, maxConcurrent) => localTick({ open, timeline, comments, env, maxConcurrent });

  // At the cap (three Running across both routes, the paused one among them; the draft not counted): neither route picks.
  for (const env of [{}, { PENDULUM_LOCAL: "1" }, { PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" }]) {
    const { r } = await tick(env, 3);
    assert.deepEqual(r.ready, [], `${JSON.stringify(env)}: nothing starts at the cap`);
    assert.equal(r.running, 3);
    assert.equal(r.reason, "max_concurrent reached");
    assert.deepEqual(r.vanished, [], "no Running one is Blocked");
    assert.deepEqual(r.paused, [2], "the paused one keeps its place");
  }
  // One slot free: each route takes it with its own Objective; serve --all routes both and takes the first.
  assert.deepEqual((await tick({}, 4)).r.ready, [4]);
  assert.deepEqual((await tick({ PENDULUM_LOCAL: "1" }, 4)).r.ready, [5]);
  assert.deepEqual((await tick({ PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" }, 4)).r.ready, [4]);
});

test("local loop where no Action runs (adopt): a pick without pendulum:local is labelled first, and Pendulum's mark names that exact label event, before the Running mark (#455)", async () => {
  const fresh = new Date().toISOString();
  const queued = { number: 9, state: "open", labels: [{ name: "pendulum:objective" }], body: "", updated_at: fresh, user: { login: "maintainer" } };
  // The timeline after the label write: the filing, a stranger's earlier pendulum:local event, and this login's own.
  const timeline = () => [
    { id: 4000, event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "maintainer", type: "User" }, created_at: ago(HOUR) },
    { id: 4100, event: "labeled", label: { name: "pendulum:local" }, actor: { login: "other", type: "User" }, created_at: ago(HOUR / 2) },
    { id: 4242, event: "labeled", label: { name: "pendulum:local" }, actor: { login: "maintainer", type: "User" }, created_at: fresh },
  ];
  // A writer (who started it), and today's spend read as none (the usage artifacts and the local spend comments).
  // `now`: the issue as GitHub has it when read again just before the label.
  let now = queued;
  const tick = (opts) => localTick({ open: [queued], timeline, writers: [{ login: "maintainer", permissions: { push: true } }], env: { PENDULUM_LOCAL: "1" }, inputs: { dailyUsd: 50 }, opts, extra: (u, method) => (method !== "GET" ? null : u.pathname.endsWith("/actions/artifacts") ? { artifacts: [] } : u.pathname.endsWith("/issues/comments") ? [] : u.pathname.endsWith("/collaborators/maintainer/permission") ? { permission: "write" } : u.pathname === "/repos/acme/app/issues/9" ? now : null) });
  const t = await tick({ adopt: true, localSlots: 2 });
  assert.deepEqual(t.r.ready, [9]);
  const on9 = t.writes.filter((w) => w.startsWith("POST /issues/9/"));
  assert.equal(on9[0], "POST /issues/9/labels ", "pendulum:local first");
  assert.match(on9[1], /^POST \/issues\/9\/comments <!-- pendulum:9:local-route:4242 -->\nPendulum: no Action runs Objectives in this repository/, "the mark names this login's newest pendulum:local event");
  assert.ok(on9.slice(2).includes("POST /issues/9/labels "), "then the Running mark");
  assert.deepEqual(t.r.unrouted, []);
  // Without adopt (an Action runs, or it is unknown): not picked, not labelled, and counted for the start line.
  const live = await tick({ localSlots: 2 });
  assert.deepEqual(live.r.ready, []);
  assert.deepEqual(live.writes.filter((w) => w.startsWith("POST /issues/9/")), []);
  assert.deepEqual(live.r.unrouted, [9]);
  // The Action, turned on mid-tick, took it before the label: read again, it is Running, so it is neither labelled nor started.
  now = { ...queued, labels: [...queued.labels, { name: "pendulum:running" }] };
  const raced = await tick({ adopt: true, localSlots: 2 });
  assert.deepEqual(raced.r.ready, []);
  assert.deepEqual(raced.writes.filter((w) => w.startsWith("POST /issues/9/")), []);
});
