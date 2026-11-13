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
async function withGitHub({ checkRuns = [], workflowRuns = [], files = {}, jobs = {}, older = {}, suites = {}, workflows = null, prFiles = null }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const reads = { checks: 0, runs: 0, contents: 0 };
  const at = (v, n) => (typeof v === "function" ? v(n) : v);
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const p = u.pathname;
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
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

/** One validation loop on the required check `quality`, the waits cut to milliseconds; a fix pass stops at the spent budget. */
async function loop(github, { checks = {}, deadlineMs = 30_000, triage = null } = {}) {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const phases = [];
  let checkReads = 0;
  let contentReads = 0;
  const result = await withGitHub(github, async (reads) => {
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
      checks: { repo: REPO, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 1, maxPollMs: 4, timeoutMs: 20, stuckWaitMs: 40, guardMs: 0, ...checks },
      outbox: { push: async () => true, expected: () => SHA },
      onPhase: async (l) => phases.push(l),
      ...(triage ? { triage } : {}),
    });
    checkReads = reads.checks;
    contentReads = reads.contents;
    return r;
  });
  return { result, phases, checkReads, contentReads };
}

const ciRun = (over = {}) => ({ id: 77, name: "CI", status: "queued", conclusion: null, check_suite_id: 9, workflow_id: 5, path: ".github/workflows/ci.yml", created_at: ago(47), updated_at: ago(47), ...over });
const files = { ".github/workflows/ci.yml": CI };

test("a required check whose workflow run GitHub left queued: a bounded wait in the stage, no fix pass, no counted pass, then a Block naming the run", async () => {
  const t0 = Date.now();
  const { result, phases, checkReads } = await loop({ checkRuns: [], workflowRuns: [ciRun()], files });
  assert.equal(result.harness, undefined, "no fix pass was reached");
  assert.equal(result.passes, 0, "the wait is not a validation pass");
  assert.match(result.stuck?.reason || "", /^GitHub has not started the required check\(s\) quality on a{7}: workflow run CI \(run 77\) queued 4\d min with no job started \(infrastructure, not this change\)$/);
  assert.ok(phases.some((l) => /; waiting up to 0 min for it to start, no fix run$/.test(l)), phases.join("\n"));
  assert.ok(Date.now() - t0 >= 40 && checkReads >= 3, "it waited in the stage, reading again");
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: result.passes, green: false, stuck: result.stuck.reason } });
  assert.deepEqual(exit, { exit: "blocked", reason: result.stuck.reason, cause: "factory" });
});

test("the in-stage wait is bounded by the stage's wall clock less the guard: none left, it Blocks at once", async () => {
  const { result, phases } = await loop({ checkRuns: [], workflowRuns: [ciRun()], files }, { checks: { guardMs: undefined, stuckWaitMs: undefined } });
  assert.match(result.stuck.reason, /^GitHub has not started/);
  assert.ok(!phases.some((l) => /waiting up to/.test(l)), "30 s left is under the 5-minute guard");
});

test("a check GitHub starts during the wait is validated as usual: green, no fix pass", async () => {
  const green = [{ id: 3, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: new Date().toISOString() }];
  let seen = false;
  const { result } = await loop({ checkRuns: () => (seen ? green : []), workflowRuns: () => ((seen = true), [ciRun()]), files }, { checks: { stuckWaitMs: 60_000 } });
  assert.equal(result.green, true);
  assert.equal(result.passes, 1);
});

test("#72's other shapes: a required check run queued with no runner after its workflow run completed, or inside one still going", async () => {
  const queued = [{ id: 2, name: "quality", status: "queued", conclusion: null, check_suite: { id: 9 }, started_at: null }];
  const noRunner = { 2: { id: 2, status: "queued", runner_id: 0, runner_name: "" } };
  const done = await loop({ checkRuns: queued, jobs: noRunner, workflowRuns: [ciRun({ status: "completed", conclusion: "success", updated_at: ago(50) })] });
  assert.equal(done.result.harness, undefined);
  assert.match(done.result.stuck.reason, /: quality queued after its workflow run CI \(run 77\) completed 50 min ago \(infrastructure/);
  const going = await loop({ checkRuns: queued, jobs: noRunner, workflowRuns: [ciRun({ status: "in_progress" })] });
  assert.match(going.result.stuck.reason, /: quality queued with no runner in workflow run CI \(run 77\) \(infrastructure/);
  // A runner took it: it is running, not GitHub's delay, and Blocks at once with no wait.
  const taken = await loop({ checkRuns: queued, jobs: { 2: { id: 2, status: "queued", runner_id: 4, runner_name: "r4" } }, workflowRuns: [ciRun({ status: "in_progress" })] });
  assert.equal(taken.result.stuck.waits, false);
  assert.ok(!taken.phases.some((l) => /waiting up to/.test(l)));
});

test("a queued run is tied to the required check: another workflow's queued run, an approval wait or a wrong name Blocks at once", async () => {
  const other = { id: 88, name: "Docs", status: "queued", conclusion: null, check_suite_id: 10, workflow_id: 6, path: ".github/workflows/docs.yml", created_at: ago(30) };
  const docs = { ...files, ".github/workflows/docs.yml": "jobs:\n  docs:\n    runs-on: x\n" };
  // CI produced no quality and completed; only Docs is queued: the wrong name, never a wait on Docs.
  const unrelated = await loop({ checkRuns: [], workflowRuns: [ciRun({ status: "completed", conclusion: "success" }), other], files: docs });
  assert.equal(unrelated.result.harness, undefined);
  assert.match(unrelated.result.stuck.reason, /^required check\(s\) quality never reported on a{7}: .*check the required check names; no failing run to fix$/);
  assert.ok(!unrelated.phases.some((l) => /waiting up to/.test(l)));
  // No workflow file on the head names quality, and nothing older ran it: a queued run is not this check's.
  const untied = await loop({ checkRuns: [], workflowRuns: [other], files: docs });
  assert.match(untied.result.stuck.reason, /check the required check names/);
  // A run waiting for a deployment approval is no GitHub delay.
  const approval = await loop({ checkRuns: [], workflowRuns: [ciRun({ status: "waiting" })], files });
  assert.match(approval.result.stuck.reason, /^required check\(s\) quality on a{7} wait for a deployment approval/);
  // A check its workflow file does not name plainly (a reusable workflow) is tied by an older commit's run of it.
  const reusable = await loop({ checkRuns: [], workflowRuns: [ciRun()], files: { ".github/workflows/ci.yml": "jobs:\n  call:\n    uses: ./.github/workflows/q.yml\n" }, older: { quality: [{ id: 5, name: "quality", check_suite: { id: 41 } }] }, suites: { 41: { id: 70, workflow_id: 5 } } });
  assert.match(reusable.result.stuck.reason, /^GitHub has not started the required check\(s\) quality on a{7}: workflow run CI \(run 77\) queued/);
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
});

test("a check that starts during the wait and is still running at its cap gets the checks' normal timeout", async () => {
  const inProgress = [{ id: 3, name: "quality", status: "in_progress", conclusion: null, check_suite: { id: 9 }, started_at: new Date().toISOString() }];
  const green = [{ ...inProgress[0], status: "completed", conclusion: "success" }];
  let classified = 0;
  const { result, phases } = await loop({ checkRuns: () => (classified === 0 ? [] : classified === 1 ? inProgress : green), workflowRuns: () => ((classified += 1), [ciRun(classified > 1 ? { status: "in_progress" } : {})]), files });
  assert.equal(result.green, true, result.stuck?.reason);
  assert.equal(result.passes, 1);
  assert.ok(phases.some((l) => /started late; waiting for them as usual$/.test(l)), phases.join("\n"));
});

test("a check queued at another service, or held by the repository's concurrency group, is named as such, not as GitHub", async () => {
  const external = await loop({ checkRuns: [{ id: 6, name: "quality", status: "queued", conclusion: null, app: { slug: "buildkite" }, check_suite: { id: 31 }, started_at: null }], workflowRuns: [] });
  assert.match(external.result.stuck.reason, /^buildkite has not started the required check\(s\) quality on a{7}: quality queued at buildkite, which has not started it \(infrastructure, not this change\)$/);
  const held = await loop({ checkRuns: [], workflowRuns: [ciRun({ status: "pending" })], files });
  assert.match(held.result.stuck.reason, /^The repository's concurrency group holds the required check\(s\) quality on a{7}: workflow run CI \(run 77\) pending 4\d min behind its concurrency group \(the repository's own workflow setting\) \(not this change\)$/);
});

test("a reusable workflow's job and an expression-named job resolve to the required check with no history", async () => {
  const caller = { ".github/workflows/ci.yml": "jobs:\n  call:\n    uses: ./.github/workflows/q.yml\n", ".github/workflows/q.yml": "on: workflow_call\njobs:\n  quality:\n    runs-on: x\n" };
  const reusable = await loop({ checkRuns: [], workflowRuns: [ciRun()], files: caller }, { checks: { names: ["call / quality"] } });
  assert.match(reusable.result.stuck.reason, /^GitHub has not started the required check\(s\) call \/ quality on a{7}: workflow run CI \(run 77\) queued/);
  const { workflowChecks, reports } = await import("../scripts/lib/triage.mjs");
  const { checks } = await workflowChecks("jobs:\n  test:\n    name: Test ${{ matrix.os }}\n  remote:\n    uses: acme/ci/.github/workflows/q.yml@v1\n");
  assert.ok(checks.some((c) => reports(c, "Test ubuntu-latest")));
  assert.ok(checks.some((c) => reports(c, "remote / lint")), "a workflow in another repository: any job under the caller");
  assert.ok(!checks.some((c) => reports(c, "quality")));
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

test("GitHub's ?, + and [] filter operators are not guessed at: such a filter is unknown, and the check is waited for", async () => {
  const { filterSkips } = await import("../scripts/lib/triage.mjs");
  const probes = [["**/*.jsx?", "src/page.js"], ["**/*.[jt]s", "src/a.ts"], ["v[0-9]+/**", "v12/a.js"]];
  for (const [pattern, file] of probes) {
    for (const ignore of [false, true]) assert.equal(filterSkips({ key: "k", ignore, patterns: [pattern], sole: true }, [file]), null, `${pattern} vs ${file}`);
    waitsWithHint(await filterCase(ciFiltered(`  pull_request:\n    paths: ['${pattern}']`), [file]), `${pattern} vs ${file}`);
  }
});

test("a path filter decides alone only when pull_request is the workflow's only trigger on the head; push beside it, in either order, waits", async () => {
  const { filterSkips } = await import("../scripts/lib/triage.mjs");
  for (const on of ["  push:\n  pull_request:\n    paths: ['src/**']", "  pull_request:\n    paths: ['src/**']\n  push:", "  pull_request_target:\n  pull_request:\n    paths: ['src/**']"]) waitsWithHint(await filterCase(ciFiltered(on), ["docs/a.md"]), on);
  // merge_group runs on the queue's commit, never the head: the filter still decides.
  assert.equal((await filterCase(ciFiltered("  merge_group:\n  pull_request:\n    paths: ['src/**']"), ["docs/a.md"])).result.stuck.kind, "filtered");
  assert.equal(filterSkips({ key: "k", ignore: false, patterns: ["src/**"], sole: false }, ["docs/a.md"]), null);
});

test("a check two workflows produce is filtered out only when both skip: GitHub's ci.yml and ci-skip.yml pair waits, listed in either order", async () => {
  const ci = { id: 5, path: ".github/workflows/ci.yml", state: "active" };
  const skip = { id: 6, path: ".github/workflows/ci-skip.yml", state: "active" };
  const companion = { ".github/workflows/ci-skip.yml": ciFiltered("  pull_request:\n    paths-ignore: ['src/**']") };
  for (const workflows of [[ci, skip], [skip, ci]]) waitsWithHint(await filterCase(ciFiltered("  pull_request:\n    paths: ['src/**']"), ["docs/a.md"], workflows, companion), workflows.map((w) => w.path).join(" then "));
  // Both skip a change: filtered, in either order.
  const bothSkip = { ".github/workflows/ci-skip.yml": ciFiltered("  pull_request:\n    paths: ['lib/**']") };
  for (const workflows of [[ci, skip], [skip, ci]]) assert.equal((await filterCase(ciFiltered("  pull_request:\n    paths: ['src/**']"), ["docs/a.md"], workflows, bothSkip)).result.stuck.kind, "filtered");
});

test("an empty changed-file list is unknown, never a skip", async () => {
  const { filterSkips } = await import("../scripts/lib/triage.mjs");
  for (const ignore of [false, true]) assert.equal(filterSkips({ key: "k", ignore, patterns: ["src/**"], sole: true }, []), null);
  waitsWithHint(await filterCase(ciFiltered("  pull_request:\n    paths: ['src/**']"), []), "no files");
});

test("the workflow files are read once per stage, however often the wait is classified", async () => {
  // Not started at first and after the wait: classified twice on one head.
  const r = await loop({ checkRuns: [], workflowRuns: [ciRun()], files: { ".github/workflows/ci.yml": CI }, workflows: oneWorkflow });
  assert.match(r.result.stuck.reason, /^GitHub has not started/);
  assert.equal(r.contentReads, 1);
});

test("a failed read of the check runs keeps the last good reading: the wait goes on to its own deadline, never read as nothing ran", async () => {
  const running = [{ id: 3, name: "quality", status: "in_progress", conclusion: null, check_suite: { id: 9 }, started_at: ago(1) }];
  const green = [{ ...running[0], status: "completed", conclusion: "success" }];
  // Reads 2 and 3 of the wait fail (past appearMs, 0 here), each through every one of the client's tries (#168), so the
  // failure reaches the wait rather than being hidden by a retry; read 4 sees the check finish green.
  const T = RETRY.tries;
  const { result, checkReads } = await loop({ checkRuns: (n) => (n === 1 ? running : n <= 1 + 2 * T ? null : green), workflowRuns: [ciRun({ status: "in_progress" })], files }, { checks: { timeoutMs: 5000 } });
  assert.equal(result.green, true, "the run was still going: a failed read is no proof that nothing ran");
  assert.equal(result.passes, 1);
  assert.equal(checkReads, 2 + 2 * T, "two whole failed reads, then the green one");
  // No read has succeeded since the wait began: it ends at appearMs as for nothing ran, never at the full timeout.
  const t0 = Date.now();
  const failing = await loop({ checkRuns: () => null, workflowRuns: [ciRun({ status: "in_progress" })], files }, { checks: { timeoutMs: 60_000, stuckWaitMs: 0 } });
  assert.ok(Date.now() - t0 < 5000, "it did not wait to the timeout");
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
    assert.match(result.stuck.reason, /rerun it on GitHub or fix the workflow, then re-apply the label; no failing run to fix$/);
    assert.ok(!phases.some((l) => /waiting up to/.test(l)), "no wait for a run that has ended");
    // GitHub could not start it: most often the workflow file, the repository's; a cancellation may be its own concurrency setting.
    const cause = conclusion === "startup_failure" ? "setup" : "work";
    assert.equal(result.stuck.cause, cause);
    assert.deepEqual(decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: 0, green: false, stuck: result.stuck.reason, stuckCause: result.stuck.cause } }), { exit: "blocked", reason: result.stuck.reason, cause });
  }
});

test("a run that ended before its jobs is known as soon as every run on the head completed: no wait to the timeout when other checks reported", async () => {
  const lint = [{ id: 8, name: "lint", status: "completed", conclusion: "success", check_suite: { id: 10 }, started_at: ago(2) }];
  const runs = [ciRun({ status: "completed", conclusion: "startup_failure" }), ciRun({ id: 78, name: "Lint", workflow_id: 6, path: ".github/workflows/lint.yml", check_suite_id: 10, status: "completed", conclusion: "success" })];
  const t0 = Date.now();
  const { result } = await loop({ checkRuns: lint, workflowRuns: runs, files, workflows: [{ id: 5, path: ".github/workflows/ci.yml", state: "active" }] }, { checks: { timeoutMs: 60_000 } });
  assert.ok(Date.now() - t0 < 5000, "the wait ended once every run had completed");
  assert.equal(result.stuck.kind, "ended");
  assert.equal(result.stuck.cause, "setup");
  // A run still going is not that: the wait goes on (to its timeout here).
  const going = await loop({ checkRuns: lint, workflowRuns: [runs[0], { ...runs[1], status: "in_progress", conclusion: null }], files, workflows: [{ id: 5, path: ".github/workflows/ci.yml", state: "active" }] }, { checks: { timeoutMs: 50 } });
  assert.ok(going.checkReads > 2, "it kept reading");
});

test("an unrelated run cancelled, or a producing run cancelled after its jobs started, never ends the wait early", async () => {
  const workflows = [{ id: 5, path: ".github/workflows/ci.yml", state: "active" }, { id: 6, path: ".github/workflows/lint.yml", state: "active" }];
  // The reviewer's case: quality green, a required check of an outside app not reported yet, and the repository's own
  // concurrency group cancelled an unrelated run on the head. The outside check has no producing workflow: wait on.
  const quality = [{ id: 3, name: "quality", status: "completed", conclusion: "success", check_suite: { id: 9 }, started_at: ago(2) }];
  const runs = [ciRun({ status: "completed", conclusion: "success" }), ciRun({ id: 78, name: "Lint", workflow_id: 6, path: ".github/workflows/lint.yml", check_suite_id: 10, status: "completed", conclusion: "cancelled" })];
  const t0 = Date.now();
  const outside = await loop({ checkRuns: quality, workflowRuns: runs, files, workflows }, { checks: { names: ["quality", "outside/check"], timeoutMs: 300, stuckWaitMs: 0 } });
  assert.ok(Date.now() - t0 >= 300, "the wait went on to its timeout");
  assert.notEqual(outside.result.stuck?.kind, "ended");
  // quality's own run cancelled after a job of it ran (a check run in its suite): not before its jobs, so not `ended`.
  const build = [{ id: 4, name: "build", status: "completed", conclusion: "cancelled", check_suite: { id: 9 }, started_at: ago(2) }];
  const t1 = Date.now();
  const late = await loop({ checkRuns: build, workflowRuns: [ciRun({ status: "completed", conclusion: "cancelled" })], files, workflows }, { checks: { timeoutMs: 300, stuckWaitMs: 0 } });
  assert.ok(Date.now() - t1 >= 300, "the wait went on to its timeout");
  assert.notEqual(late.result.stuck?.kind, "ended");
});
