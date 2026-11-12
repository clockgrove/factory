import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS_WAIT_BACKOFF_MS, CHECKS_WAIT_MS, CHECKS_WAIT_TRIES, checksWaitMarker, checksWaitNext, checksWaitOf, checksWaiting, decideExit, marker, setSelf } from "../scripts/lib/logic.mjs";
import { checksNotStarted } from "../scripts/lib/triage.mjs";

// #72: a required check GitHub never started is no red: no fix pass, no counted pass, and never "validation red".

const SHA = "a".repeat(40);
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const BOT = { login: "factory-app[bot]", type: "Bot" };
const min = 60_000;

/** GitHub on fetch for one head: its check runs and workflow runs (each a value, or a function of the read count). */
async function withGitHub({ checkRuns = [], workflowRuns = [] }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const reads = { checks: 0, runs: 0 };
  const at = (v, n) => (typeof v === "function" ? v(n) : v);
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (/\/commits\/[0-9a-f]+\/check-runs$/.test(u.pathname)) {
      const runs = at(checkRuns, (reads.checks += 1));
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (u.pathname === `/repos/${REPO.full}/actions/runs` && u.searchParams.get("head_sha") === SHA) {
      const runs = at(workflowRuns, (reads.runs += 1));
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

/** One validation loop on the required check `quality`, the waits cut to milliseconds. */
async function loop(github, { checks = {}, deadlineMs = 30_000 } = {}) {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const phases = [];
  const result = await withGitHub(github, () =>
    validationLoop({
      checkout: "/nonexistent",
      commands: [],
      harness: "codex",
      // A fix pass, if one were reached, stops at the spent budget instead of running a harness.
      maxUsd: 0.01,
      spentUsd: 1,
      session: {},
      taskCard: "",
      env: process.env,
      deadlineAt: Date.now() + deadlineMs,
      checks: { repo: REPO, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 1, timeoutMs: 20, stuckWaitMs: 0, ...checks },
      outbox: { push: async () => true, expected: () => SHA },
      onPhase: async (l) => phases.push(l),
    }),
  );
  return { result, phases };
}

const queuedRun = { id: 77, name: "CI", status: "queued", conclusion: null, check_suite_id: 9, created_at: new Date(Date.now() - 47 * min).toISOString() };

test("a required check whose workflow run GitHub left queued spends no fix pass, counts no pass and Blocks as infrastructure", async () => {
  const { result, phases } = await loop({ checkRuns: [], workflowRuns: [queuedRun] });
  assert.equal(result.harness, undefined, "no fix pass was reached");
  assert.equal(result.passes, 0, "the wait is not a validation pass");
  assert.equal(result.stuck?.deferrable, true);
  assert.match(result.stuck.reason, /^GitHub has not started the required check\(s\) quality on a{7}: workflow run CI \(run 77\) queued 4\d min with no job started \(infrastructure, not this change\)$/);
  assert.ok(!phases.some((l) => /fix run$/.test(l) && /red:/.test(l)), phases.join("\n"));
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: result.passes, green: false, stuck: result.stuck.reason } });
  assert.deepEqual(exit, { exit: "blocked", reason: result.stuck.reason });
});

test("a required check run left queued after its workflow run completed is GitHub's, not the change's", async () => {
  const checkRuns = [{ id: 2, name: "quality", status: "queued", conclusion: null, check_suite: { id: 9 }, started_at: null }];
  const { result } = await loop({ checkRuns, workflowRuns: [{ ...queuedRun, status: "completed", conclusion: "success", updated_at: new Date(Date.now() - 50 * min).toISOString() }] });
  assert.equal(result.harness, undefined);
  assert.equal(result.stuck.deferrable, true);
  assert.match(result.stuck.reason, /^GitHub left the required check quality queued on a{7} after its workflow run CI \(run 77\) completed 50 min ago/);
});

test("locally the stage waits a check GitHub has not started out, and validates once it runs: no fix pass", async () => {
  // GitHub starts the run once Factory has found it queued, and it goes green.
  const green = [{ id: 3, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: new Date().toISOString() }];
  let seenQueued = false;
  const workflowRuns = () => ((seenQueued = true), [queuedRun]);
  const { result, phases } = await loop({ checkRuns: () => (seenQueued ? green : []), workflowRuns }, { checks: { stuckWaitMs: 60_000 }, deadlineMs: 10 * min });
  assert.equal(result.green, true);
  assert.equal(result.passes, 1);
  assert.ok(phases.some((l) => /^GitHub has not started .*; waiting for GitHub to start it, no fix run$/.test(l)), phases.join("\n"));
});

test("checksNotStarted: decided on the runs' structure; a check still running, or never reported, is not GitHub's delay", () => {
  const base = { sha: SHA, names: ["quality"], waitedMin: 15, now: Date.now() };
  assert.match(checksNotStarted({ ...base, workflowRuns: [] }).reason, /^GitHub created no workflow run for a{7} in 15 min/);
  assert.equal(checksNotStarted({ ...base, workflowRuns: [] }).deferrable, true);
  const running = checksNotStarted({ ...base, checkRuns: [{ id: 1, name: "quality", status: "in_progress", check_suite: { id: 9 } }], workflowRuns: [{ ...queuedRun, status: "in_progress" }] });
  assert.equal(running.deferrable, false);
  assert.match(running.reason, /still in progress; no failing run to fix$/);
  const unreported = checksNotStarted({ ...base, workflowRuns: [{ ...queuedRun, status: "completed" }] });
  assert.equal(unreported.deferrable, false);
  assert.match(unreported.reason, /never reported on a{7}/);
  assert.equal(checksNotStarted({ ...base, workflowRuns: null, readError: "403" }).deferrable, false, "unread runs prove nothing");
});

test("checksWaitNext: bounded by tries and time on one head; a new head starts over", () => {
  const t0 = Date.parse("2026-11-11T10:00:00Z");
  const first = checksWaitNext(null, { head: SHA, startedAt: t0 - 15 * min, now: t0 });
  assert.deepEqual(first, { head: SHA, since: new Date(t0 - 15 * min).toISOString(), tries: 1, retryAt: new Date(t0 + CHECKS_WAIT_BACKOFF_MS[0]).toISOString() });
  let rec = first;
  let now = t0;
  for (let i = 2; i < CHECKS_WAIT_TRIES; i += 1) {
    now += 30 * min;
    rec = checksWaitNext(rec, { head: SHA, now });
    assert.equal(rec.tries, i);
    assert.ok(!rec.giveUp);
  }
  const last = checksWaitNext(rec, { head: SHA, now: now + 30 * min });
  assert.equal(last.giveUp, true, `${CHECKS_WAIT_TRIES} stages on one head`);
  assert.equal(checksWaitNext({ ...first, tries: 1 }, { head: SHA, now: Date.parse(first.since) + CHECKS_WAIT_MS }).giveUp, true, "or the time bound");
  assert.equal(checksWaitNext(rec, { head: "b".repeat(40), now }).tries, 1, "another head is a new streak");
});

test("the checks-wait record: only Factory's own, cleared by a comment with no record line; the dispatcher holds it until retryAt", async () => {
  const rec = { head: SHA, since: "2026-11-11T10:00:00.000Z", tries: 1, retryAt: "2026-11-11T10:10:00.000Z" };
  const head = marker(7, "checks-wait");
  const own = { user: BOT, body: `${head}\nFactory is waiting for GitHub.\n${checksWaitMarker(rec)}` };
  setSelf(BOT.login);
  try {
    assert.deepEqual(checksWaitOf([own], 7), rec);
    assert.equal(checksWaitOf([{ ...own, user: { login: "someone" } }], 7), null, "anyone can paste a marker");
    assert.equal(checksWaitOf([{ ...own, body: `${head}\nFactory no longer waits.` }], 7), null);
  } finally {
    setSelf(null);
  }
  assert.equal(checksWaiting(rec, Date.parse(rec.retryAt) - 1), true);
  assert.equal(checksWaiting(rec, Date.parse(rec.retryAt)), false);
});

test("dispatch: on the Actions route a Queued Objective waiting on unstarted checks is not picked before its retry time, and a start-retry wake is armed for it", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const now = Date.now();
  const rec = { head: SHA, since: new Date(now - 20 * min).toISOString(), tries: 1, retryAt: new Date(now + 10 * min).toISOString() };
  const iss = (number) => ({ number, state: "open", labels: [{ name: "factory:objective" }], body: "", updated_at: new Date(now).toISOString(), user: { login: "maintainer" } });
  const comments = { 40: [{ id: 1, user: BOT, body: `${marker(40, "checks-wait")}\nwaiting\n${checksWaitMarker(rec)}` }] };
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  setSelf(BOT.login);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const n = Number(/\/issues\/(\d+)\//.exec(u.pathname)?.[1]);
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues`) return json(u.searchParams.get("state") === "closed" ? [] : [iss(40), iss(41)]);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) return json(comments[n] || []);
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json([]);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo: REPO.full, objectiveLabel: "factory:objective", maxConcurrent: 10, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t", now: new Date(now), dryRun: true });
    assert.deepEqual(r.ready, [41], JSON.stringify(r.skipped));
    assert.match(r.skipped.find((x) => x.number === 40)?.reason || "", /^GitHub had not started the required checks on a{7}; next try after/);
    assert.deepEqual(r.deadlines.filter((d) => d.issue === 40).map((d) => [d.kind, d.at]), [["start-retry", rec.retryAt]]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    setSelf(null);
  }
});
