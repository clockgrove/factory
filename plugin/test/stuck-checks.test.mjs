import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExit } from "../scripts/lib/logic.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads on purpose: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

// #72: a required check GitHub never started is no red: no fix pass, no counted pass, a bounded wait in the stage, and
// then a Block naming the stuck run, never "validation red".

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const min = 60_000;
const ago = (m) => new Date(Date.now() - m * min).toISOString();
const CI = "jobs:\n  quality:\n    name: quality\n    runs-on: ubuntu-latest\n";

/**
 * GitHub on fetch for one head. `checkRuns` and `workflowRuns` are values or functions of the read count; `files` the
 * workflow files at the head by path; `jobs` Actions jobs by id; `older` an older commit's check runs by name and
 * `suites` the workflow run of a check suite.
 */
async function withGitHub({ checkRuns = [], workflowRuns = [], files = {}, jobs = {}, older = {}, suites = {}, workflows = null, prFiles = null, routes = null }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const reads = { checks: 0, runs: 0, contents: 0 };
  const at = (v, n) => (typeof v === "function" ? v(n) : v);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    // `routes(path, url, reads, init)`: a test's own answers (a body; undefined for none), asked first.
    const own = routes?.(p, u, reads, init);
    if (own !== undefined) return json(own);
    if (p === `/repos/${REPO.full}/commits/${SHA}/check-runs`) {
      const runs = at(checkRuns, (reads.checks += 1));
      // null: this read fails on GitHub's side.
      if (runs === null) return json({ message: "Server Error" }, 502);
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (p === `/repos/${REPO.full}/commits/${OLD}/check-runs`) return json({ check_runs: older[u.searchParams.get("check_name")] || [] });
    if (p === `/repos/${REPO.full}/actions/runs` && u.searchParams.get("head_sha") === SHA) {
      const runs = at(workflowRuns, (reads.runs += 1));
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (p === `/repos/${REPO.full}/actions/runs` && u.searchParams.get("check_suite_id")) return json({ workflow_runs: suites[u.searchParams.get("check_suite_id")] ? [suites[u.searchParams.get("check_suite_id")]] : [] });
    if (p === `/repos/${REPO.full}/actions/workflows` && workflows) return json({ workflows });
    if (p === `/repos/${REPO.full}/pulls/5/files` && prFiles) return json(prFiles.map((filename) => ({ filename })));
    let m = /\/actions\/jobs\/(\d+)$/.exec(p);
    if (m && jobs[m[1]]) return json(jobs[m[1]]);
    m = /\/contents\/(.+)$/.exec(p);
    if (m) reads.contents += 1;
    if (m && files[m[1]] !== undefined && u.searchParams.get("ref") === SHA) return new Response(files[m[1]], { status: 200 });
    if (p === `/repos/${REPO.full}/commits` || /\/issues\/\d+\/comments$/.test(p)) return json(p.endsWith("/commits") ? [{ sha: OLD }] : []);
    if (p === `/repos/${REPO.full}`) return json({ default_branch: "main" });
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

/**
 * One validation loop on the required check `quality`, on a clock only GitHub's answers move: read n of the head's check
 * runs is `stepMs` x n after `t0`, and nothing else moves it, so a wait ends after the same reads however busy the
 * machine is. The bounds are cut to milliseconds; a fix pass stops at the spent budget. `waitedMs`: the clock's time
 * over the loop.
 */
async function loop(github, { checks = {}, deadlineMs = 30_000, triage = null, stepMs = 5, t0 = Date.now() } = {}) {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const phases = [];
  let checkReads = 0;
  const realNow = Date.now;
  let clock = t0;
  Date.now = () => clock;
  const answer = github.checkRuns ?? [];
  const onClock = { ...github, checkRuns: (n) => ((clock = t0 + n * stepMs), typeof answer === "function" ? answer(n) : answer) };
  try {
    const result = await withGitHub(onClock, async (reads) => {
      const r = await validationLoop({
        checkout: "/nonexistent",
        commands: [],
        harness: "codex",
        maxUsd: 0.01,
        spentUsd: 1,
        session: {},
        taskCard: "",
        env: process.env,
        deadlineAt: Date.now() + deadlineMs,
        checks: { repo: REPO, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 1, maxPollMs: 4, stuckWaitMs: 40, guardMs: 0, ...checks },
        outbox: { push: async () => true, expected: () => SHA },
        onPhase: async (l) => phases.push(l),
        ...(triage ? { triage } : {}),
      });
      checkReads = reads.checks;
      return r;
    });
    return { result, phases, checkReads, waitedMs: clock - t0 };
  } finally {
    Date.now = realNow;
  }
}

const ciRun = (over = {}) => ({ id: 77, name: "CI", status: "queued", conclusion: null, check_suite_id: 9, workflow_id: 5, path: ".github/workflows/ci.yml", created_at: ago(47), updated_at: ago(47), ...over });
const files = { ".github/workflows/ci.yml": CI };

test("a required check whose workflow run GitHub left queued: a bounded wait in the stage, no fix pass, no counted pass, then a Block naming the run", async () => {
  const { result, phases, checkReads, waitedMs } = await loop({ checkRuns: [], workflowRuns: [ciRun()], files });
  assert.equal(result.harness, undefined, "no fix pass was reached");
  assert.equal(result.passes, 0, "the wait is not a validation pass");
  assert.match(result.stuck?.reason || "", /^GitHub has not started the required check\(s\) quality on a{7}: workflow run CI \(run 77\) queued 4\d min with no job started \(infrastructure, not this change\)$/);
  assert.ok(phases.some((l) => /; waiting up to 0 min for it to start, no fix run$/.test(l)), phases.join("\n"));
  assert.ok(waitedMs >= 40 && checkReads >= 3, "it waited in the stage, reading again");
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: result.passes, green: false, stuck: result.stuck.reason } });
  assert.deepEqual(exit, { exit: "blocked", reason: result.stuck.reason, cause: "pendulum" });
});

test("a check GitHub starts during the wait is validated as usual: green, no fix pass", async () => {
  const green = [{ id: 3, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: new Date().toISOString() }];
  let seen = false;
  const { result } = await loop({ checkRuns: () => (seen ? green : []), workflowRuns: () => ((seen = true), [ciRun()]), files }, { checks: { stuckWaitMs: 60_000 } });
  assert.equal(result.green, true);
  assert.equal(result.passes, 1);
});

test("checksNotStarted: no workflow run at all is GitHub's; a check still running is not", async () => {
  const { checksNotStarted } = await import("../scripts/lib/triage.mjs");
  const none = checksNotStarted({ sha: SHA, names: ["quality"], workflowRuns: [], waitedMin: 15 });
  assert.equal(none.waits, true);
  assert.match(none.reason, /quality on a{7}: no workflow run for it was created in 15 min/);
  const running = checksNotStarted({ sha: SHA, names: ["quality"], checkRuns: [{ id: 1, name: "quality", status: "in_progress", check_suite: { id: 9 } }], workflowRuns: [ciRun({ status: "in_progress" })] });
  assert.equal(running.waits, false);
  assert.match(running.reason, /CI \(run 77\) still in progress; no failing run to fix$/);
  assert.equal(checksNotStarted({ sha: SHA, names: ["quality"], workflowRuns: null, readError: "403" }).waits, false, "unread runs prove nothing");
  assert.equal(checksNotStarted({ sha: SHA, names: ["quality"], checkRuns: [{ id: 1, name: "quality", status: "waiting", check_suite: { id: 9 } }], workflowRuns: [ciRun({ status: "in_progress" })] }).waits, false, "a job waiting for an approval");
});

test("after a triage rerun the wait in place still leaves out the runs the rerun replaced", async () => {
  // The red: quality ran and failed. Triage reruns it; the rerun's job is queued with no runner and never starts.
  const failed = { id: 1, name: "quality", status: "completed", conclusion: "failure", check_suite: { id: 9 }, started_at: ago(10), completed_at: ago(5) };
  const rerun = { id: 2, name: "quality", status: "queued", conclusion: null, check_suite: { id: 9 }, started_at: null };
  let rerunDone = false;
  const triage = { red: async () => ((rerunDone = true), { rerun: true, ignoreIds: new Set([1]), jobs: ["quality"] }) };
  const ran = { id: 1, conclusion: "failure", steps: [{ name: "test", conclusion: "failure" }], runner_id: 3, runner_name: "r3" };
  const { result } = await loop({ checkRuns: () => (rerunDone ? [failed, rerun] : [failed]), jobs: { 1: ran, 2: { id: 2, status: "queued", runner_id: 0, runner_name: "" } }, workflowRuns: [ciRun({ status: "in_progress" })] }, { triage });
  assert.equal(result.harness, undefined, "the replaced red never reaches a fix pass");
  assert.match(result.stuck?.reason || "", /: quality queued with no runner in workflow run CI \(run 77\)/);
});

// ------------------------------------------------------------------ #81: who has not started it, and why

test("a required workflow whose pull_request path filter skips the change Blocks at once naming the filter; one that would run is waited for", async () => {
  const workflows = [{ id: 5, path: ".github/workflows/ci.yml", state: "active" }];
  const filtered = { ".github/workflows/ci.yml": "on:\n  pull_request:\n    paths: ['src/**', '!src/**/*.md']\njobs:\n  quality:\n    runs-on: x\n" };
  const skip = await loop({ checkRuns: [], workflowRuns: [], files: filtered, workflows, prFiles: ["docs/readme.md", "src/notes.md"] });
  assert.equal(skip.result.harness, undefined);
  assert.equal(skip.result.stuck.kind, "filtered");
  assert.match(skip.result.stuck.reason, /^required check\(s\) quality never run on a{7}: on\.pull_request\.paths of its workflow skips this change, so GitHub starts no run for it; run the check on every change, or stop requiring it/);
  assert.ok(!skip.phases.some((l) => /waiting up to/.test(l)), "no wait on a run GitHub will never create");
  const runs = await loop({ checkRuns: [], workflowRuns: [], files: filtered, workflows, prFiles: ["src/app.js"] });
  assert.match(runs.result.stuck.reason, /^GitHub has not started .*no workflow run for it was created in \d+ min \(infrastructure/);
  const unknown = await loop({ checkRuns: [], workflowRuns: [], files: filtered, workflows });
  assert.match(unknown.result.stuck.reason, /no workflow run for it was created in \d+ min \(its workflow's path filter, on\.pull_request\.paths, may skip this change\)/);
});

test("filterSkips: paths runs on a match (a ! pattern excludes again), paths-ignore unless every file matches", async () => {
  const { filterSkips } = await import("../scripts/lib/triage.mjs");
  const paths = (patterns) => ({ key: "on.pull_request.paths", ignore: false, patterns, sole: true });
  assert.equal(filterSkips(paths(["src/**"]), ["src/a/b.js"]), false);
  assert.equal(filterSkips(paths(["src/**", "!src/**/*.md"]), ["src/a/b.md"]), true);
  assert.equal(filterSkips(paths(["*.js"]), ["src/a.js"]), true, "* stays within one segment");
  assert.equal(filterSkips({ key: "on.pull_request.paths-ignore", ignore: true, patterns: ["docs/**"], sole: true }, ["docs/a.md"]), true);
  assert.equal(filterSkips({ key: "on.pull_request.paths-ignore", ignore: true, patterns: ["docs/**"], sole: true }, ["docs/a.md", "src/a.js"]), false);
  assert.equal(filterSkips(paths(["src/**"]), null), null, "files unknown");
  assert.equal(filterSkips(paths(["src/**"]), []), null, "an empty changed-file list is unknown, never a skip");
  assert.equal(filterSkips(paths(["**/*.[jt]s"]), ["src/a.ts"]), null, "GitHub's ?, + and [] operators are not guessed at");
  assert.equal(filterSkips({ ...paths(["src/**"]), sole: false }, ["docs/a.md"]), null, "another trigger beside pull_request may start it");
});

// ------------------------------------------------------------------ "filtered" only when certain (#82's review)

const ciFiltered = (on) => `on:\n${on}\njobs:\n  quality:\n    runs-on: x\n`;
const oneWorkflow = [{ id: 5, path: ".github/workflows/ci.yml", state: "active" }];
/** The loop on a head with no run of the check's workflow: filtered (a Block at once) or a wait with the filter as a hint. */
const filterCase = (text, prFiles, workflows = oneWorkflow, extra = {}) => loop({ checkRuns: [], workflowRuns: [], files: { ".github/workflows/ci.yml": text, ...extra }, workflows, prFiles });
const waitsWithHint = (r, what) => {
  assert.notEqual(r.result.stuck.kind, "filtered", what);
  assert.equal(r.result.stuck.kind, "not-started", what);
  assert.ok(r.phases.some((l) => /waiting up to/.test(l)), `${what}: it waits`);
  assert.match(r.result.stuck.reason, /may skip this change/, what);
};

test("a check two workflows produce is filtered out only when both skip: GitHub's ci.yml and ci-skip.yml pair waits, listed in either order", async () => {
  const ci = { id: 5, path: ".github/workflows/ci.yml", state: "active" };
  const skip = { id: 6, path: ".github/workflows/ci-skip.yml", state: "active" };
  const companion = { ".github/workflows/ci-skip.yml": ciFiltered("  pull_request:\n    paths-ignore: ['src/**']") };
  for (const workflows of [[ci, skip], [skip, ci]]) waitsWithHint(await filterCase(ciFiltered("  pull_request:\n    paths: ['src/**']"), ["docs/a.md"], workflows, companion), workflows.map((w) => w.path).join(" then "));
  // Both skip a change: filtered, in either order.
  const bothSkip = { ".github/workflows/ci-skip.yml": ciFiltered("  pull_request:\n    paths: ['lib/**']") };
  for (const workflows of [[ci, skip], [skip, ci]]) assert.equal((await filterCase(ciFiltered("  pull_request:\n    paths: ['src/**']"), ["docs/a.md"], workflows, bothSkip)).result.stuck.kind, "filtered");
});

test("a failed read of the check runs keeps the last good reading: the wait goes on to its own deadline, never read as nothing ran", async () => {
  const running = [{ id: 3, name: "quality", status: "in_progress", conclusion: null, check_suite: { id: 9 }, started_at: ago(1) }];
  const green = [{ ...running[0], status: "completed", conclusion: "success" }];
  // Reads 2 and 3 of the wait fail (past appearMs, 0 here), each through every one of the client's tries (#168), so the
  // failure reaches the wait rather than being hidden by a retry; read 4 sees the check finish green.
  const T = RETRY.tries;
  const { result, checkReads } = await loop({ checkRuns: (n) => (n === 1 ? running : n <= 1 + 2 * T ? null : green), workflowRuns: [ciRun({ status: "in_progress" })], files }, { checks: { stuckWaitMs: 10_000 } });
  assert.equal(result.green, true, "the run was still going: a failed read is no proof that nothing ran");
  assert.equal(result.passes, 1);
  assert.equal(checkReads, 2 + 2 * T, "two whole failed reads, then the green one");
  // No read has succeeded since the wait began: it ends at appearMs as for nothing ran, never at the full timeout.
  const failing = await loop({ checkRuns: () => null, workflowRuns: [ciRun({ status: "in_progress" })], files }, { checks: { stuckWaitMs: 0 } });
  assert.equal(failing.checkReads, T, "it ended at the first failed read");
  assert.equal(failing.result.green, false);
  assert.ok(failing.result.stuck, "Blocked as a wait with nothing failed");
});

test("a producing workflow run that ended startup_failure, or was cancelled before any job, Blocks at once naming that conclusion, not the check names", async () => {
  for (const conclusion of ["startup_failure", "cancelled"]) {
    const { result, phases } = await loop({ checkRuns: [], workflowRuns: [ciRun({ status: "completed", conclusion })], files, workflows: [{ id: 5, path: ".github/workflows/ci.yml", state: "active" }] });
    assert.equal(result.harness, undefined, "no fix pass");
    assert.equal(result.passes, 0);
    assert.equal(result.stuck.kind, "ended");
    assert.match(result.stuck.reason, new RegExp(`^required check\\(s\\) quality never reported on a{7}: workflow run CI \\(run 77\\) ended ${conclusion} before its job ran`));
    assert.doesNotMatch(result.stuck.reason, /check the required check names/);
    assert.match(result.stuck.reason, /rerun it on GitHub or fix the workflow, then resume through Draft; no failing run to fix$/);
    assert.ok(!phases.some((l) => /waiting up to/.test(l)), "no wait for a run that has ended");
    // GitHub could not start it: most often the workflow file, the repository's; a cancellation may be its own concurrency setting.
    const cause = conclusion === "startup_failure" ? "setup" : "work";
    assert.equal(result.stuck.cause, cause);
    assert.deepEqual(decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: 0, green: false, stuck: result.stuck.reason, stuckCause: result.stuck.cause } }), { exit: "blocked", reason: result.stuck.reason, cause });
  }
});

// ------------------------------------------------------------------ #401: progress decides, not a hidden 60 minutes

const ACTIONS = { id: 15368, slug: "github-actions" };

/**
 * One validation loop with production's bounds (no injected wait caps), a minute of the clock per read of the head's
 * check runs: read n is n minutes after `t0` and answers `at(n)`, so a wait of hours takes milliseconds. `routes` are
 * the test's own answers; `calls` counts every request by path.
 */
async function virtual({ t0 = Date.now(), at, workflowRuns = [ciRun({ status: "in_progress" })], files: f = files, workflows = null, routes = null, stageMin = 300, checks = {}, triage = null }) {
  const calls = new Map();
  const own = (p, u, reads, init) => {
    calls.set(p, (calls.get(p) || 0) + 1);
    return routes?.(p, u, reads, init);
  };
  const r = await loop({ checkRuns: at, workflowRuns, files: f, workflows, routes: own }, { checks: { stuckWaitMs: undefined, guardMs: undefined, ...checks }, deadlineMs: stageMin * min, triage, stepMs: min, t0 });
  return { ...r, minutes: r.waitedMs / min, calls };
}

/** The default branch's rulesets: the merge queue's check timeout (`timeoutMin`) and the app each required check is bound to (`bound`). */
const rulesets = ({ timeoutMin = null, bound = null } = {}) => (p) => {
  if (p === `/repos/${REPO.full}/rulesets`) return timeoutMin || bound ? [{ id: 1, target: "branch", enforcement: "active" }] : [];
  if (p === `/repos/${REPO.full}/rulesets/1`) {
    const rules = [];
    if (timeoutMin) rules.push({ type: "merge_queue", parameters: { check_response_timeout_minutes: timeoutMin } });
    if (bound) rules.push({ type: "required_status_checks", parameters: { required_status_checks: Object.entries(bound).map(([context, id]) => ({ context, integration_id: id })) } });
    return { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules };
  }
  return undefined;
};

/**
 * A required check `quality` running one long step: `stepMin` is that step's duration in the workflow's recent green runs
 * (none: no history), `doneAt` the minute it completes green (never: null), `timeoutMin` the merge queue rule's
 * check_response_timeout_minutes (none: no ruleset), `comments` the PR's. Returns the loop's result, the Actions job
 * reads and the comments posted.
 */
async function running({ step = "Run npm test", stepMin = null, doneAt = null, timeoutMin = null, stageMin = 300, comments = [], red = null }) {
  const t0 = Date.now();
  const at = (m) => new Date(t0 + m * min).toISOString();
  const run = { id: 2, name: "quality", status: "in_progress", conclusion: null, check_suite: { id: 9 }, started_at: at(0), app: ACTIONS };
  const job = { id: 2, run_id: 42, name: "quality", workflow_name: "CI", status: "in_progress", started_at: at(0), runner_id: 4, runner_name: "r4", steps: [{ name: "Set up job", status: "completed", started_at: at(0), completed_at: at(0) }, { name: step, status: "in_progress", started_at: at(0), completed_at: null }] };
  const green = (k) => ({ id: 100 + k, name: "quality", steps: [{ name: step, status: "completed", conclusion: "success", started_at: at(-1000), completed_at: at(-1000 + stepMin) }] });
  let jobReads = 0;
  const posted = [];
  const rules = rulesets({ timeoutMin });
  const routes = (p, u, reads, init) => {
    if (p === `/repos/${REPO.full}/actions/jobs/2`) return (jobReads += 1), job;
    if (p === `/repos/${REPO.full}/actions/runs/42`) return { id: 42, workflow_id: 5 };
    if (p === `/repos/${REPO.full}/actions/workflows/5/runs`) return { workflow_runs: stepMin === null ? [] : Array.from({ length: 5 }, (_, k) => ({ id: 100 + k, event: "push", head_branch: "main" })) };
    const m = /\/actions\/runs\/(1\d\d)\/jobs$/.exec(p);
    if (m) return { jobs: [green(Number(m[1]) - 100)] };
    if (p === `/repos/${REPO.full}/issues/5/comments`) return init.method === "POST" ? (posted.push(JSON.parse(init.body).body), {}) : comments;
    return rules(p);
  };
  // `red`: the head's earlier red run, which triage reruns (its id ignored after); the running check is the rerun's.
  let rerun = !red;
  const triage = red ? { red: async () => ((rerun = true), { rerun: true, ignoreIds: new Set([red.id]), jobs: ["quality"] }) } : null;
  const now = (n) => (doneAt !== null && n >= doneAt ? [{ ...run, status: "completed", conclusion: "success" }] : [run]);
  const r = await virtual({ t0, at: (n) => (rerun ? [...(red ? [red] : []), ...now(n)] : [red]), routes, stageMin, triage });
  return { ...r, jobReads, posted };
}

test("a required check whose step is within its usual duration is waited for past an hour, and goes green", async () => {
  // Tests normally take 80 minutes: at 90 that is progress, not a hang, whatever the time since the push.
  const { result, jobReads } = await running({ stepMin: 80, doneAt: 90 });
  assert.equal(result.green, true, result.stuck?.reason);
  assert.equal(result.passes, 1);
  // Not read before 15 minutes, then once each 15 minutes (16, 31, 46, 61, 76): the step it is on could not stall sooner.
  assert.equal(jobReads, 5);
});

test("a required check whose step runs past its usual duration has hung: the wait ends there, as at a timeout, naming the step and the way past it", async () => {
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const { noProgressMarker } = await import("../scripts/lib/session.mjs");
  setSelf("pendulum-app[bot]");
  // Set-up normally takes 1 minute: past max(3 x 1, 1 + 15) = 16 it has hung, long before any hour.
  const { result, minutes, posted } = await running({ step: "Run scripts/ci/setup.sh", stepMin: 1, doneAt: 40 });
  assert.equal(result.harness, undefined, "no fix pass: nothing failed");
  assert.equal(result.passes, 0);
  assert.equal(minutes, 17);
  assert.equal(result.stuck.kind, "running");
  assert.equal(result.stuck.reason, "no progress: `quality` / `Run scripts/ci/setup.sh` running 17 min, normally ~1 min; required check(s) quality not finished on aaaaaaa after 17 min: CI (run 77) still in progress; no failing run to fix; when this change makes that step slower, resume through Draft: aaaaaaa is then waited for up to the stage's wall clock");
  assert.equal(posted.length, 1);
  assert.ok(posted[0].startsWith(noProgressMarker(4, SHA)), posted[0]);
  // The label re-applied: the next stage on that head has no hang judgement, and the slower step goes green at 40.
  const again = await running({ step: "Run scripts/ci/setup.sh", stepMin: 1, doneAt: 40, comments: [{ id: 1, user: { login: "pendulum-app[bot]" }, body: posted[0] }] });
  assert.equal(again.result.green, true, again.result.stuck?.reason);
  assert.equal(again.minutes, 40);
  // A person's own pasted marker, someone who cannot push, is no answer.
  const pasted = await running({ step: "Run scripts/ci/setup.sh", stepMin: 1, doneAt: 40, comments: [{ id: 1, user: { login: "drive-by" }, author_association: "NONE", body: posted[0] }] });
  assert.equal(pasted.minutes, 17);
  setSelf(null);
});

test("a required check with no history waits up to the merge queue rule's check timeout, else to the stage's wall clock", async () => {
  const ruled = await running({ timeoutMin: 30 });
  assert.equal(ruled.minutes, 31);
  assert.match(ruled.result.stuck.reason, /^no progress: `quality` \/ `Run npm test` running 31 min; required check\(s\) quality not finished/);
  // And at the wall clock it ends unfinished.
  const clocked = await running({ stageMin: 100 });
  assert.equal(clocked.result.stuck.kind, "running");
  assert.equal(clocked.minutes, 101);
  assert.doesNotMatch(clocked.result.stuck.reason, /^no progress/);
});

test("on the local route no Actions job is read: a running required check is judged by the time bound only", async () => {
  const before = process.env.PENDULUM_LOCAL;
  process.env.PENDULUM_LOCAL = "1";
  try {
    const { result, jobReads, minutes } = await running({ stepMin: 80, doneAt: 90, timeoutMin: 30 });
    assert.equal(jobReads, 0);
    assert.equal(minutes, 31);
    assert.match(result.stuck.reason, /^no progress: `quality` running 31 min; /);
  } finally {
    if (before === undefined) delete process.env.PENDULUM_LOCAL;
    else process.env.PENDULUM_LOCAL = before;
  }
});

test("a required check queued with no runner keeps the not-started bound, never the stage's wall clock", async () => {
  const queued = [{ id: 2, name: "quality", status: "queued", conclusion: null, check_suite: { id: 9 }, started_at: null, app: ACTIONS }];
  const routes = (p) => (p === `/repos/${REPO.full}/actions/jobs/2` ? { id: 2, status: "queued", runner_id: 0, runner_name: "" } : undefined);
  // 60 minutes with nothing running, then up to 60 more for it to start: as on main, not the 300-minute stage.
  const { result, minutes } = await virtual({ at: () => queued, routes });
  assert.equal(minutes, 122);
  assert.equal(result.stuck.kind, "not-started");
  assert.match(result.stuck.reason, /^GitHub has not started the required check\(s\) quality on a{7}: quality queued with no runner in workflow run CI \(run 77\)/);
});

// A head on which CI ran and finished green: its job is `lint`, so the required `quality` is a name nothing produces.
const lint = [{ id: 8, name: "lint", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: ago(2), app: ACTIONS }];
const lintOnly = { ".github/workflows/ci.yml": "jobs:\n  lint:\n    runs-on: x\n" };
const suitesRoute = (suites) => (p) => (p === `/repos/${REPO.full}/commits/${SHA}/check-suites` ? { total_count: suites.length, check_suites: suites } : undefined);
const actionsSuite = { id: 9, app: { id: 15368 }, status: "completed", latest_check_runs_count: 1 };
// Apps that leave a suite queued with no runs on every head (as on clockgrove/pendulum).
const stale = [1, 2, 3].map((k) => ({ id: 20 + k, app: { id: 900 + k }, status: "queued", latest_check_runs_count: 0 }));
const both = (...fs) => (p, u, reads, init) => fs.reduce((v, f) => (v !== undefined ? v : f(p, u, reads, init)), undefined);
const completedCi = [ciRun({ status: "completed", conclusion: "success" })];

test("a required check no workflow produces Blocks as soon as every workflow run on the head completed", async () => {
  const wrong = await loop({ checkRuns: lint, workflowRuns: completedCi, files: lintOnly, workflows: oneWorkflow, routes: suitesRoute([actionsSuite]) });
  assert.equal(wrong.checkReads, 1, "the wait ended at the first reading");
  assert.equal(wrong.result.harness, undefined, "no fix pass");
  assert.equal(wrong.result.stuck.kind, "unreported");
  assert.equal(wrong.result.stuck.reason, "required check(s) quality never reported on aaaaaaa: no workflow run on it produces it (CI (run 77) completed success); check the required check names; no failing run to fix");
});

test("a required check the ruleset binds to Actions ignores other apps' stale suites; unbound, they hold it to the not-started bound only", async () => {
  const bound = await loop({ checkRuns: lint, workflowRuns: completedCi, files: lintOnly, workflows: oneWorkflow, routes: both(suitesRoute([actionsSuite, ...stale]), rulesets({ bound: { quality: 15368 } })) });
  assert.equal(bound.checkReads, 1);
  assert.equal(bound.result.stuck.kind, "unreported");
  // Bound to any app: the stale suites may report it, so the wait goes to 60 minutes with nothing running, not the stage's 300.
  const unbound = await virtual({ at: () => lint, workflowRuns: completedCi, files: lintOnly, workflows: oneWorkflow, routes: suitesRoute([actionsSuite, ...stale]) });
  assert.equal(unbound.minutes, 61);
  assert.equal(unbound.result.stuck.kind, "unreported");
});

test("a required commit status a service posts after CI completed is waited for, not Blocked as a wrong name", async () => {
  // Codecov's way: `coverage` is a commit status, posted on older commits; here it arrives at minute 3, after CI completed.
  const quality = [{ id: 3, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: ago(2), app: ACTIONS }];
  let n = 0;
  const status = (p) => {
    if (p === `/repos/${REPO.full}/commits/${SHA}/status`) return { statuses: n >= 3 ? [{ id: 60, context: "coverage", state: "success", created_at: ago(0) }] : [] };
    if (p === `/repos/${REPO.full}/commits/${OLD}/status`) return { statuses: [{ id: 59, context: "coverage", state: "success", created_at: ago(600) }] };
    return undefined;
  };
  const r = await virtual({ at: (k) => ((n = k), quality), workflowRuns: completedCi, files: lintOnly, workflows: oneWorkflow, routes: both(status, suitesRoute([actionsSuite])), checks: { names: ["quality", "coverage"] } });
  assert.equal(r.result.green, true, r.result.stuck?.reason);
  assert.equal(r.minutes, 3);
});

test("a check an `on: workflow_run` workflow may post is never Blocked as a wrong name at once: it gets the not-started bound", async () => {
  const chained = { ...lintOnly, ".github/workflows/post.yml": "on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\njobs:\n  report:\n    runs-on: x\n    steps:\n      - run: ./post-status\n" };
  const workflows = [...oneWorkflow, { id: 6, path: ".github/workflows/post.yml", state: "active" }];
  const r = await virtual({ at: () => lint, workflowRuns: completedCi, files: chained, workflows, routes: rulesets({ bound: { quality: 15368 } }) });
  assert.equal(r.minutes, 61);
  assert.equal(r.result.stuck.kind, "unreported");
});

test("while a triage rerun is awaited a missing required check is not read as a wrong name", async () => {
  // quality failed; triage reruns it. GitHub's run list still shows the run completed, and the rerun's check is not listed yet.
  const failed = { id: 1, name: "quality", status: "completed", conclusion: "failure", check_suite: { id: 9 }, started_at: ago(10), completed_at: ago(5), app: ACTIONS };
  const rerun = { id: 2, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: ago(1), app: ACTIONS };
  let rerunAt = null;
  const triage = { red: async ({ failedRuns }) => (failedRuns.length ? ((rerunAt = 0), { rerun: true, ignoreIds: new Set([1]), jobs: ["quality"] }) : { rerun: false }) };
  const at = () => [...lint, ...(rerunAt === null ? [failed] : (rerunAt += 1) < 4 ? [failed] : [failed, rerun])];
  const { result, checkReads } = await loop({ checkRuns: at, workflowRuns: [ciRun({ status: "completed", conclusion: "failure" })], files: {}, routes: rulesets({ bound: { quality: 15368 } }) }, { triage });
  assert.equal(result.green, true, result.stuck?.reason);
  assert.ok(checkReads >= 5);
});

test("a required commit status is read: green when it is, and a failed one is a red the fix pass is handed", async () => {
  const quality = [{ id: 3, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: ago(2), app: ACTIONS }];
  const status = (state) => (p) => (p === `/repos/${REPO.full}/commits/${SHA}/status` ? { state, statuses: [{ id: 50, context: "deploy", state, created_at: ago(3), target_url: "https://ci.example/50" }] } : undefined);
  const green = await loop({ checkRuns: quality, workflowRuns: completedCi, files, checks: {}, routes: status("success") }, { checks: { names: ["quality", "deploy"] } });
  assert.equal(green.result.green, true, green.result.stuck?.reason);
  assert.equal(green.checkReads, 1);
  // Failed: a red the fix pass is handed, named by its context.
  const red = await loop({ checkRuns: quality, workflowRuns: completedCi, files, routes: status("failure") }, { checks: { names: ["quality", "deploy"] } });
  assert.equal(red.result.green, false);
  assert.match(red.result.lastOutput, /--- deploy: failure\ncommit status https:\/\/ci\.example\/50/);
});
