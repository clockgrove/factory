import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCH_JOB_MS, START_RETRY_MS, WAKE_KINDS, WAKE_SLACK_MS, failedSince, launchDecision, launchJobName, launchJobState, lostLaunch, pendingMarkers, marker, nextUtcMidnight, nextWake, parseWake, sandboxMarkerLine, sandboxRecordOf, setSelf, settleStale, startBackoffMs, startFailures, startRetryAt, transientHold, refusalStreakAt, vendorEvidence, wakeKinds } from "../scripts/lib/logic.mjs";
import { recordBody, writeSandboxRecord } from "../scripts/launch.mjs";
import { BASE, BOT, REPO, githubStore } from "./fixtures/github-records.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

const T = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const min = 60_000;

test("nextWake: the earliest sleeper deadline still ahead; owners' kinds, past ones and covered ones arm nothing", () => {
  const deadlines = [
    { issue: 4, kind: "launch-grace", at: iso(T + 1 * min) },
    { issue: 5, kind: "quota", at: iso(T + 7 * min) },
    { issue: 6, kind: "lease", at: iso(T + 4 * min) },
    { issue: 7, kind: "lease", at: iso(T - 1 * min) },
    { issue: null, kind: "daily-cap", at: iso(nextUtcMidnight(T)) },
  ];
  assert.deepEqual(nextWake(deadlines, { now: T }), { kind: "lease", at: iso(T + 4 * min), issue: 6 });
  assert.equal(nextWake([{ kind: "answer-grace", at: iso(T + min) }, { kind: "lease", at: iso(T - min) }], { now: T }), null, "only WAKE_KINDS, only ahead");
  // A wake already queued or sleeping covers a deadline it fires before, or within the slack after.
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "quota", at: iso(T + 2 * min) }] }), null);
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "quota", at: iso(T + 4 * min + WAKE_SLACK_MS) }] }), null);
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "quota", at: iso(T + 4 * min + WAKE_SLACK_MS + 1000) }] })?.issue, 6, "a later sleeper does not cover it");
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "lease", at: iso(T - 30_000) }] })?.issue, 6, "one already past its deadline (firing, or this run's own) covers nothing");
  assert.deepEqual(WAKE_KINDS, ["lease", "quota", "start-retry", "daily-cap", "retry", "third-party", "sibling-wait", "job-grace", "sweep"]);
  // A private repository sleeps only to the short waits: the lease, the day's turn and a third-party or sibling wait's bound wait for events and the cron.
  assert.deepEqual(wakeKinds(true), ["lease", "quota", "start-retry", "daily-cap", "retry", "third-party", "sibling-wait", "job-grace"], "the sweep's and the image's kinds are theirs, not the dispatcher's");
  for (const v of [false, null, undefined]) assert.deepEqual(wakeKinds(v), ["quota", "start-retry", "retry", "job-grace"], `visibility ${v}`);
  assert.deepEqual(nextWake(deadlines, { now: T, kinds: wakeKinds(false) }), { kind: "quota", at: iso(T + 7 * min), issue: 5 });
  assert.equal(nextWake([{ kind: "daily-cap", at: iso(nextUtcMidnight(T)) }, { kind: "lease", at: iso(T + min) }], { now: T, kinds: wakeKinds(false) }), null);
});

const SINCE = "2026-11-10T11:00:00.000Z";
const at = (m) => iso(Date.parse(SINCE) + m * min);
const fail = (m, code, stage = "work") => ({ stage, ok: false, at: at(m), ...(code ? { code } : {}) });

test("a vendor's transient start failures back off 2, 4, 8, 16, then every 30 minutes and never Block", async () => {
  const { startFailure } = await import("../scripts/launch.mjs");
  for (const code of ["unavailable", "rate_limited", "timeout"]) assert.equal(startFailure({ code }), "retry", code);
  assert.equal(startFailure({ code: "quota" }), "quota");
  assert.equal(startFailure({ code: "auth" }), "block", "any other error Blocks at once");
  // Its Block's cause: the vendor's plan quota after the wait is external (provider-quota); any other failed start is Pendulum's.
  const { failedStartCause } = await import("../scripts/launch.mjs");
  assert.equal(failedStartCause(startFailure({ code: "quota" })), "provider-quota");
  assert.equal(failedStartCause(startFailure({ code: "auth" })), "pendulum");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(startBackoffMs), [2, 4, 8, 16, 30, 30, 30].map((m) => m * min));
  // An hour-long outage: eight transient failures in the stint, no Block, the next try 30 minutes after the last.
  const outage = { state: "failed", launches: [1, 3, 7, 15, 31, 61, 91, 121].map((m) => fail(m, "unavailable")) };
  const now = Date.parse(at(125));
  assert.equal(failedSince(outage, SINCE, now), 0);
  assert.deepEqual(launchDecision({ ev: { kind: "swept", issue: 1 }, state: "Running", runningSince: SINCE, record: outage, now }), { stage: "work" });
  assert.equal(startRetryAt(outage, SINCE, now), Date.parse(at(121)) + 30 * min);
  // However many refusals in a row: whether they hold the route is the other Objectives' records' to say (vendorEvidence).
  assert.equal(transientHold(outage, SINCE, now), true);
  assert.equal(refusalStreakAt(outage, SINCE, now), Date.parse(at(1)), "the streak began at the first refusal");
  const other = (launches) => ({ state: "running", launches });
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([{ stage: "work", ok: true, at: at(90) }])], now), "up", "another Objective started since: this refusal is its own");
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([{ stage: "work", ok: true, at: at(-5) }])], now), "none", "a start before the streak says nothing");
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([{ stage: "work", ok: true, at: iso(Date.parse(at(1)) - 30_000) }])], now), "none", "nor one inside the clock allowance before it");
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([fail(20, "rate_limited"), { stage: "work", event: "dispatch", ok: null, at: at(25) }])], now), "trying", "a try in flight is waited for, even after a refusal");
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([fail(20, "rate_limited")])], now), "refused", "refused too: the vendor is down");
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([{ stage: "work", event: "dispatch", ok: null, at: at(123) }])], now), "trying", "a try in flight: wait for it");
  assert.equal(vendorEvidence(Date.parse(at(1)), [other([fail(20, "error")])], now), "none", "a failure of its own says nothing of the vendor");
  // Real failures keep three strikes, whatever transient ones came between.
  const real = { state: "failed", launches: [fail(1, "error"), fail(3, "unavailable"), fail(7, "error"), fail(15, "error")] };
  assert.match(launchDecision({ ev: { kind: "swept", issue: 1 }, state: "Running", runningSince: SINCE, record: real, now }).block, /3 sandbox starts failed/);
  assert.equal(startRetryAt(real, SINCE, now), Date.parse(at(15)), "at once: the launcher Blocks it");
  assert.equal(transientHold(real, SINCE, now), false);
});

test("every launch attempt ends stored: a marker whose launch job ended and a cut-off claim become entries no later write erases", async () => {
  const { startingRecord } = await import("../scripts/dispatch.mjs");
  const { failedStartRecord, settledLaunches } = await import("../scripts/launch.mjs");
  const named = startingRecord(null, { vendor: "vercel", stage: "work", at: at(1), run: "5" });
  assert.equal(named.launches[0].ok, null);
  assert.equal(settleStale(named, Date.parse(at(600))), named, "no age turns a marker into a failure");
  assert.deepEqual(pendingMarkers(named, SINCE).map((l) => l.run), ["5"]);
  // Where its launch job stands, from its dispatcher run's jobs as GitHub lists them.
  const job = (status, extra = {}) => ({ id: 2, name: launchJobName(7), status, run_attempt: 1, ...extra });
  assert.deepEqual(launchJobState([{ name: "dispatch", status: "completed" }, job("queued")], 7), { running: true, until: null }, "waiting for a runner: no time bounds it");
  assert.deepEqual(launchJobState([job("in_progress", { started_at: at(2) })], 7), { running: true, until: Date.parse(at(2)) + LAUNCH_JOB_MS }, "running: its own limit ends it");
  assert.deepEqual(launchJobState([job("completed", { completed_at: at(4) })], 7), { ended: at(4) });
  assert.deepEqual(launchJobState([job("completed", { completed_at: at(4) }), job("in_progress", { id: 3, run_attempt: 2, started_at: at(5) })], 7).running, true, "a rerun's attempt is the latest");
  assert.deepEqual(launchJobState([{ name: "dispatch", status: "completed", completed_at: at(1) }, job("queued", { name: launchJobName(8) })], 7), { running: true, until: null, unlisted: true }, "none listed yet: the run's status decides");
  assert.deepEqual(launchJobState([{ name: "dispatch", status: "completed", completed_at: at(1) }], 7, { status: "in_progress" }), { running: true, until: null }, "the matrix is not listed yet: still to come");
  assert.deepEqual(launchJobState([{ name: "dispatch", status: "completed", completed_at: at(1) }, job("completed", { name: launchJobName(8) })], 7, { status: "completed", updated_at: at(3) }), { ended: at(3) }, "the run ended: the matrix never had it");
  assert.deepEqual(launchJobState([{ name: "dispatch", status: "in_progress" }], 7, { status: "in_progress" }), { running: true, until: null });
  const stored = lostLaunch(named, { run: "5", stage: "work", at: at(4) });
  assert.deepEqual(stored.launches, [{ stage: "work", event: "dispatch", ok: false, run: "5", at: at(4), code: "lost" }]);
  assert.equal(lostLaunch(stored, { run: "5", stage: "work", at: at(4) }), null, "settled already: nothing to store");
  // An outcome settles a pending marker; a stored failure is never dropped.
  assert.deepEqual(settledLaunches(named.launches), []);
  assert.deepEqual(settledLaunches(stored.launches).map((l) => l.code), ["lost"]);
  const failed = failedStartRecord(stored, { vendor: "vercel", stage: "work", event: "issues", run: "6", at: at(13), code: "error" });
  assert.deepEqual(failed.launches.map((l) => l.code), ["lost", "error"]);
  // A launcher cut off in its vendor calls: its claim's lease ran out with no start after it.
  const cut = { stage: "work", state: "running", claim: "abcabcabcabc", at: at(2), claimedAt: at(2), leaseUntil: at(12), launches: [] };
  const settled = settleStale(cut, Date.parse(at(13)));
  assert.deepEqual([settled.state, settled.leaseUntil, settled.launches.map((l) => [l.code, l.at])], ["failed", null, [["timeout", at(12)]]]);
  assert.equal(settleStale({ ...cut, launches: [{ stage: "work", ok: true, at: at(3) }] }, Date.parse(at(13))).launches.length, 1, "a stage that started is no failed start");
  // The launch job's limit is the workflow template's own.
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const doc = parseYaml(renderWorkflow(readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8"), { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/pendulum@v1.2.3", ci_workflow: "Quality", sandbox: "vercel", default_branch: "main" }));
  assert.equal(doc.jobs.launch["timeout-minutes"] * 60_000, LAUNCH_JOB_MS);
  assert.equal(doc.jobs.launch.name.replace("${{ matrix.issue }}", "7"), launchJobName(7));
});

const N7 = 7;
const HEAD7 = marker(N7, "sandbox");
const storeWrite = (s, next, nowMs) => writeSandboxRecord(REPO, N7, {}, next, { api: s.api, base: BASE, tries: 400, pauseMs: 0, readBackPauseMs: 0, now: () => nowMs });

test("repeated cut-off launches Block after three in a row, and never hold the vendor's route", async () => {
  setSelf(BOT.login);
  const s = githubStore({ seed: 5 });
  s.put(N7, `${HEAD7}\n${recordBody({ vendor: "vercel", stage: "work", state: "stopped", at: at(0), launches: [] })}`);
  for (const [k, m] of [[1, 1], [2, 25], [3, 49]]) {
    // Each launcher claims the record (its write stores the earlier claim's cut-off first), then is cut off.
    const claim = `${k}`.repeat(12);
    const w = await storeWrite(s, (cur) => ({ ...cur, stage: "work", state: "running", claim, at: at(m), claimedAt: at(m), leaseUntil: at(m + 10) }), Date.parse(at(m)));
    assert.ok(w.ok);
  }
  // The next writer (the dispatcher's marker) stores the third cut-off before its own change.
  await storeWrite(s, (cur) => ({ ...cur }), Date.parse(at(61)));
  const rec = sandboxRecordOf(s.bodyOf(N7, HEAD7));
  const now = Date.parse(at(62));
  assert.deepEqual(startFailures(rec, SINCE, now).map((f) => f.code), ["timeout", "timeout", "timeout"]);
  assert.match(launchDecision({ ev: { kind: "swept", issue: N7 }, state: "Running", runningSince: SINCE, record: rec, now }).block, /3 sandbox starts in a row ran past the launch job's limit \(timeout\)/);
  assert.equal(transientHold(rec, SINCE, now), false, "a cut-off says nothing about the vendor");
  assert.equal(startRetryAt(rec, SINCE, now), Date.parse(at(59)), "at once: the launcher Blocks it");
  setSelf(null);
});

test("recordFailedStart writes under the record lock: a sweep's destroy in between is kept, never the stale sandbox id", async () => {
  const { recordFailedStart } = await import("../scripts/launch.mjs");
  setSelf(BOT.login);
  const N = 7;
  const HEAD = marker(N, "sandbox");
  for (let seed = 1; seed <= 30; seed += 1) {
    const s = githubStore({ seed });
    s.put(N, `${HEAD}\n${recordBody({ vendor: "vercel", id: "pendulum-old", stage: "work", state: "stopped", claim: "000000000000", at: at(0), launches: [] })}`);
    const fast = { api: s.api, base: BASE, tries: 400, pauseMs: 0, readBackPauseMs: 0 };
    const sweep = writeSandboxRecord(REPO, N, {}, (cur) => ({ ...cur, id: null, destroyedAt: at(1) }), fast);
    const failure = recordFailedStart({ inputs: { sandbox: "vercel" }, eventName: "workflow_dispatch", runId: "9", repo: REPO, n: N, opts: {}, claim: null, base: BASE }, { stage: "work", error: { code: "unavailable" }, at: at(1), api: s.api, lockOpts: { tries: 400, pauseMs: 0, readBackPauseMs: 0 } });
    const [a, b] = await Promise.all([sweep, failure]);
    assert.ok(a.ok && b.ok, `seed ${seed}: both written`);
    const rec = sandboxRecordOf(s.bodyOf(N, HEAD));
    assert.equal(rec.id, null, `seed ${seed}: the destroyed sandbox stays destroyed`);
    assert.equal(rec.launches.at(-1).code, "unavailable", `seed ${seed}: the failed start is in`);
    assert.equal(s.refs.size, 0);
  }
  setSelf(null);
});

test("dispatch: a starting marker is settled by its launch job as GitHub lists it, never by its age", async () => {
  const HOUR = 60 * min;
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const now = Date.now();
  setSelf(BOT.login);
  const iss = (number) => ({ number, state: "open", labels: [{ name: "pendulum:objective" }, { name: "pendulum:running" }], body: "", updated_at: iso(now), user: { login: "maintainer" } });
  // Each Running for two hours, named by a dispatcher an hour ago (its marker far past any fixed window):
  // #41's launch job still waits for a runner; #42's ran and ended without writing any outcome; #43's run cannot be read
  // (a 502). #44's dispatch job completed and its run goes on, but GitHub has not listed the launch matrix yet: still to
  // come. #46's run completed with no launch job for it: the matrix never had it. #47's run was deleted (a 404). #45's
  // launch job ended and its launcher's failure landed after this tick read the record: GitHub's record decides.
  const named = (n, run) => `${marker(n, "sandbox")}\n${sandboxMarkerLine({ vendor: "vercel", stage: "work", state: "named", at: iso(now - HOUR), launches: [{ stage: "work", event: "dispatch", ok: null, run, at: iso(now - HOUR) }] })}`;
  const s = githubStore({ seed: 4 });
  for (const [n, run] of [[41, "71"], [42, "72"], [43, "73"], [44, "74"], [46, "76"], [47, "77"]]) s.put(n, named(n, run));
  s.put(45, `${marker(45, "sandbox")}\n${sandboxMarkerLine({ vendor: "vercel", stage: "work", state: "failed", at: iso(now - 30_000), launches: [{ stage: "work", event: "dispatch", ok: false, run: "75", at: iso(now - 30_000), code: "error" }] })}`);
  const jobs = {
    71: [{ id: 1, name: "dispatch", status: "completed", completed_at: iso(now - HOUR) }, { id: 2, name: "launch (41)", status: "queued", run_attempt: 1, started_at: null }],
    72: [{ id: 3, name: "dispatch", status: "completed", completed_at: iso(now - HOUR) }, { id: 4, name: "launch (42)", status: "completed", conclusion: "failure", run_attempt: 1, started_at: iso(now - HOUR + min), completed_at: iso(now - HOUR + 5 * min) }],
    74: [{ id: 5, name: "dispatch", status: "completed", completed_at: iso(now - HOUR) }],
    75: [{ id: 6, name: "dispatch", status: "completed", completed_at: iso(now - HOUR) }, { id: 7, name: "launch (45)", status: "completed", conclusion: "failure", run_attempt: 1, started_at: iso(now - HOUR + min), completed_at: iso(now - HOUR + 2 * min) }],
    76: [{ id: 8, name: "dispatch", status: "completed", completed_at: iso(now - HOUR) }, { id: 9, name: "launch (99)", status: "completed", run_attempt: 1, completed_at: iso(now - HOUR + 3 * min) }],
  };
  const runs = { 74: { status: "in_progress", updated_at: iso(now - HOUR) }, 76: { status: "completed", updated_at: iso(now - HOUR + 4 * min) } };
  const reads = [];
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const n = Number(/\/issues\/(\d+)\//.exec(u.pathname)?.[1]);
    const run = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname)?.[1];
    const runOnly = /\/actions\/runs\/(\d+)$/.exec(u.pathname)?.[1];
    if (run || runOnly) reads.push(u.pathname);
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues`) return json(u.searchParams.get("state") === "closed" ? [] : [41, 42, 43, 44, 45, 46, 47].map(iss));
    if (method === "GET" && (run === "77" || runOnly === "77")) return json({ message: "Not Found" }, 404);
    if (method === "GET" && run) return jobs[run] ? json({ total_count: jobs[run].length, jobs: jobs[run] }) : json({ message: "Server Error" }, 502);
    if (method === "GET" && runOnly) return runs[runOnly] ? json(runs[runOnly]) : json({ message: "Server Error" }, 502);
    // #45's read here is older than its record: its marker still pending.
    if (method === "GET" && n === 45 && /\/comments$/.test(u.pathname)) return json([{ id: 145, user: BOT, updated_at: iso(now), body: named(45, "75") }]);
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json([{ event: "labeled", label: { name: "pendulum:running" }, created_at: iso(now - 2 * HOUR) }]);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) return json([{ id: 100 + n, user: BOT, updated_at: iso(now), body: s.bodyOf(n, marker(n, "sandbox")) }]);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo: REPO.full, objectiveLabel: "pendulum:objective", maxConcurrent: 10, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60, sandbox: "vercel" }, { token: "t", now: new Date(now), recordWrites: { api: s.api, base: BASE } });
    const kinds = (n) => r.deadlines.filter((d) => d.issue === n).map((d) => d.kind);
    // #41: still in flight an hour on: not named again and no strike; its own end ticks (no wake of its own).
    assert.ok(!r.relaunch.includes(41), "a launch waiting for a runner is not named again");
    assert.deepEqual(kinds(41), []);
    assert.equal(sandboxRecordOf(s.bodyOf(41, marker(41, "sandbox"))).launches.at(-1).ok, null, "no strike for a launch in flight");
    // #42: its job ended with no outcome written: a lost start, stored at the job's end, and its retry after the pause.
    const launches42 = sandboxRecordOf(s.bodyOf(42, marker(42, "sandbox"))).launches;
    const lost = launches42.find((l) => l.run === "72");
    assert.deepEqual([lost.ok, lost.code, lost.at], [false, "lost", iso(now - HOUR + 5 * min)]);
    assert.ok(r.relaunch.includes(42), "its pause has passed: named again");
    assert.equal(launches42.at(-1).ok, null, "and marked as it is named");
    // #43: its run's jobs could not be read: in flight, and read again on a retry.
    assert.ok(!r.relaunch.includes(43));
    assert.equal(sandboxRecordOf(s.bodyOf(43, marker(43, "sandbox"))).launches.at(-1).ok, null);
    assert.ok(r.deadlines.some((d) => d.kind === "retry"));
    // #44: no launch job listed while its run goes on: in flight, no strike (GitHub lists the matrix after dispatch ends).
    assert.ok(!r.relaunch.includes(44), "a launch job still to be listed is not named again");
    assert.equal(sandboxRecordOf(s.bodyOf(44, marker(44, "sandbox"))).launches.at(-1).ok, null, "no strike while the run goes on");
    // #46: its run completed with no launch job for it: lost, at the run's end.
    const lost46 = sandboxRecordOf(s.bodyOf(46, marker(46, "sandbox"))).launches.find((l) => l.run === "76");
    assert.deepEqual([lost46.ok, lost46.code, lost46.at], [false, "lost", iso(now - HOUR + 4 * min)]);
    // #47: GitHub holds no such run any more: no launch job can be in flight, so it is lost at its marker's time.
    const lost47 = sandboxRecordOf(s.bodyOf(47, marker(47, "sandbox"))).launches.find((l) => l.run === "77");
    assert.deepEqual([lost47.ok, lost47.code, lost47.at], [false, "lost", iso(now - HOUR)]);
    assert.ok(r.relaunch.includes(47), "its pause has passed: named again");
    // #45: the record under the lock holds its launcher's failure 30 s ago, not a lost start an hour ago: it waits its pause.
    assert.ok(!r.relaunch.includes(45), "the launcher's own failure decides its retry");
    assert.deepEqual(r.deadlines.find((d) => d.issue === 45), { issue: 45, kind: "start-retry", at: iso(now - 30_000 + START_RETRY_MS) });
    assert.deepEqual(sandboxRecordOf(s.bodyOf(45, marker(45, "sandbox"))).launches.map((l) => l.code), ["error"]);
    // Each run read once (run 73's 502 aside: its read retries): its run itself only where no launch job is listed.
    const once = reads.filter((p) => !p.includes("/runs/73/"));
    assert.equal(once.length, new Set(once).size);
    assert.deepEqual(reads.filter((p) => !p.endsWith("/jobs")).sort(), [`/repos/${REPO.full}/actions/runs/74`, `/repos/${REPO.full}/actions/runs/76`]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    setSelf(null);
  }
});

test("every kind a wake is armed for is read back from its job name and its tick: an armed start-retry covers its deadline", async () => {
  const { firedByWake } = await import("../scripts/dispatch.mjs");
  assert.ok(WAKE_KINDS.every((k) => parseWake(`wake (${k} ${iso(T + 5 * min)})`)?.kind === k), "no sleeper the dispatcher cannot see");
  assert.deepEqual(firedByWake("workflow_dispatch", { inputs: { wake: `start-retry ${iso(T + 5 * min)}` } }), { kind: "start-retry", at: iso(T + 5 * min) });
  const armed = [{ ...parseWake(`wake (start-retry ${iso(T + 5 * min)})`), startedAt: iso(T - min) }];
  assert.equal(nextWake([{ issue: 20, kind: "start-retry", at: iso(T + 5 * min) }], { now: T, armed, kinds: wakeKinds(false) }), null, "one sleeper, not one per tick");
});

test("an orphan starting marker: none over a live claim, and a skipping launcher drops its own (#42)", async () => {
  const { startingRecord } = await import("../scripts/dispatch.mjs");
  const { withoutOwnMarker } = await import("../scripts/launch.mjs");
  setSelf(BOT.login);
  const s = githubStore({ seed: 11 });
  // An event launcher claims work; the dispatcher, which read the record before that claim, then tries to mark its own
  // launch of the same stage (that launch will skip: the stage holds). Then the event's start fails transiently.
  await storeWrite(s, () => ({ vendor: "vercel", stage: "work", state: "running", at: at(3), claimedAt: at(3), leaseUntil: at(13), claim: "eeeeeeeeeeee", launches: [] }), Date.parse(at(3)));
  const marked = await storeWrite(s, (cur) => startingRecord(cur, { vendor: "vercel", stage: "work", at: at(3.1), run: "900" }), Date.parse(at(3.1)));
  assert.equal(marked.ok, undefined, "no marker over a live claim");
  await storeWrite(s, (cur) => (cur?.claim === "eeeeeeeeeeee" ? { ...cur, state: "failed", error: { code: "unavailable", status: 503 }, at: at(4), leaseUntil: null, launches: [...cur.launches, { stage: "work", ok: false, code: "unavailable", at: at(4) }] } : null), Date.parse(at(4)));
  await storeWrite(s, (cur) => ({ ...cur }), Date.parse(at(14)));
  const rec = sandboxRecordOf(s.bodyOf(N7, HEAD7));
  assert.deepEqual(startFailures(rec, SINCE, Date.parse(at(14))).map((f) => f.code), ["unavailable"]);
  assert.equal(failedSince(rec, SINCE, Date.parse(at(14))), 0, "a transient failure stays transient: no orphan strike");
  // A launch that skips drops its own run's pending marker only.
  const two = { launches: [{ stage: "work", ok: false, code: "error", at: at(1) }, { stage: "work", event: "dispatch", ok: null, run: "800", at: at(2) }, { stage: "work", event: "dispatch", ok: null, run: "900", at: at(3) }] };
  assert.deepEqual(withoutOwnMarker(two, { run: "900", stage: "work" }).launches.map((l) => l.run ?? l.code), ["error", "800"]);
  assert.equal(withoutOwnMarker(two, { run: "900", stage: "review" }), null, "another stage's marker is not its own");
  assert.equal(withoutOwnMarker(two, { run: "901" }), null);
  assert.equal(withoutOwnMarker(null, { run: "900" }), null);
  setSelf(null);
});
