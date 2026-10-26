// A failed check on a Factory PR may be a flake in the repository's own
// CI, not the change: before it is a repair, its failed Actions jobs are
// rerun once per workflow run and head. A rerun's failure is the repair;
// a pass is logged and kept for the report. GitHub's run attempt and the
// kept rerun bound it, so a restart or GitHub's lag never reruns twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError } from "../dist/github.js";
import { observeCi } from "../dist/delivery.js";
import { fact, facts } from "../dist/work/facts.js";
import { passedRerun, rerunOutcome } from "../dist/work/step-deliver.js";

const HEAD = "a".repeat(40);
const RUN = 900;

/** A check run of GitHub Actions on HEAD. */
function actions(id, name, conclusion) {
  return {
    id,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/${RUN}/job/${id}`,
    app: { id: 15368, slug: "github-actions" },
  };
}

/**
 * A GitHub whose open PR #7 is ready but for its checks: `runs` on HEAD,
 * each job's attempt in `jobs` (id → attempt), the run's latest attempt
 * and its status.
 */
function github({
  runs,
  statuses = [],
  jobs = {},
  attempt = 1,
  status = "completed",
  refuse,
  actionsRead = true,
}) {
  const reruns = [];
  return {
    reruns,
    repository: "o/r",
    defaultBranch: async () => "main",
    pull: async () => ({
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      head: { sha: HEAD, ref: "factory/1/a" },
      base: { ref: "main" },
    }),
    mergeState: async () => ({
      headRefOid: HEAD,
      headRefName: "factory/1/a",
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
    }),
    checkRuns: async () => runs,
    commitStatuses: async () => statuses,
    requiredChecks: async () => [],
    failureAnnotations: async () => [],
    jobLogTail: async () => undefined,
    workflowJob: async (job) =>
      actionsRead ? { run: RUN, attempt: jobs[job] ?? 1 } : undefined,
    workflowRunAttempt: async () => ({ attempt, status }),
    rerunFailedJobs: async (run) => {
      if (refuse) throw new GitHubError("refused", refuse);
      reruns.push(run);
    },
  };
}

function observe(hub, rerun) {
  return observeCi(
    {
      github: hub,
      checkout: "/nonexistent",
      signal: new AbortController().signal,
    },
    {
      issue: 1,
      item: "a",
      pr: 7,
      head: HEAD,
      pushedHeads: [HEAD],
      requiredChecks: [],
      ...(rerun ? { rerun } : {}),
    },
  );
}

test("a failed Actions job on its run's first attempt is rerun once, not repaired", async () => {
  const hub = github({
    runs: [actions(1, "tests", "failure"), actions(2, "lint", "timed_out")],
  });
  const result = await observe(hub);
  assert.equal(result.kind, "rerun");
  assert.deepEqual(hub.reruns, [RUN]);
  assert.equal(result.rerun.head, HEAD);
  assert.deepEqual(result.rerun.checks, ["tests", "lint"]);
  assert.deepEqual(result.rerun.runs, [RUN]);
  assert.match(
    result.reason,
    /Rerunning the failed Actions jobs of tests, lint on PR #7/,
  );
});

test("a failed job whose workflow run still runs other jobs waits for the run, then is rerun", async () => {
  const running = github({
    runs: [
      actions(1, "lint", "failure"),
      { ...actions(2, "tests", null), status: "in_progress" },
    ],
    status: "in_progress",
  });
  const waited = await observe(running);
  assert.equal(waited.kind, "retry");
  assert.match(waited.reason, /to finish before rerunning/);
  assert.equal(waited.holdAfter, undefined);
  assert.deepEqual(running.reruns, []);
  const finished = github({
    runs: [actions(1, "lint", "failure"), actions(2, "tests", "success")],
  });
  assert.equal((await observe(finished)).kind, "rerun");
  assert.deepEqual(finished.reruns, [RUN]);
});

test("a run already rerun is never rerun again: kept, or shown by GitHub after a restart", async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  // GitHub still shows the first attempt's failure after the kept rerun.
  const kept = github({ runs: [actions(1, "tests", "failure")] });
  const waited = await observe(kept, {
    head: HEAD,
    checks: ["tests"],
    runs: [RUN],
    at,
  });
  assert.equal(waited.kind, "retry");
  assert.equal(waited.holdAfter.since, at);
  assert.match(waited.holdAfter.question, /were rerun, but GitHub still shows/);
  assert.deepEqual(kept.reruns, []);
  // No kept rerun (a crash after the request), but the run shows attempt 2.
  const shown = github({ runs: [actions(1, "tests", "failure")], attempt: 2 });
  assert.equal((await observe(shown)).kind, "retry");
  assert.deepEqual(shown.reruns, []);
  // A rerun kept for an earlier head doesn't count on this one.
  const moved = github({ runs: [actions(1, "tests", "failure")] });
  const again = await observe(moved, {
    head: "b".repeat(40),
    checks: ["tests"],
    runs: [RUN],
    at,
  });
  assert.equal(again.kind, "rerun");
  assert.deepEqual(moved.reruns, [RUN]);
});

test("a rerun's own failure is the repair, and its finding says the failure stands", async () => {
  const hub = github({
    runs: [actions(3, "tests", "failure")],
    jobs: { 3: 2 },
    attempt: 2,
  });
  const result = await observe(hub, {
    head: HEAD,
    checks: ["tests"],
    runs: [RUN],
    at: new Date().toISOString(),
  });
  assert.equal(result.kind, "repair");
  assert.equal(result.checks, true);
  assert.match(
    result.finding,
    /Factory reran the failed Actions jobs of tests once on this head, and the failure stands/,
  );
  assert.deepEqual(hub.reruns, []);
});

test("checks that pass on the rerun's attempt make the PR ready", async () => {
  const hub = github({
    runs: [actions(3, "tests", "success")],
    jobs: { 3: 2 },
    attempt: 2,
  });
  const result = await observe(hub, {
    head: HEAD,
    checks: ["tests"],
    runs: [RUN],
    at: new Date().toISOString(),
  });
  assert.equal(result.kind, "ready");
  assert.equal(result.head, HEAD);
  assert.deepEqual(hub.reruns, []);
});

test("a failure no rerun can clear is repaired at once, as before", async () => {
  const cases = {
    "a commit status": github({
      runs: [actions(1, "tests", "failure")],
      statuses: [{ context: "external", state: "failure" }],
    }),
    "another app's check": github({
      runs: [{ ...actions(1, "tests", "failure"), app: { id: 1, slug: "ci" } }],
    }),
    "a startup failure": github({
      runs: [actions(1, "tests", "startup_failure")],
    }),
    "no Actions read access": github({
      runs: [actions(1, "tests", "failure")],
      actionsRead: false,
    }),
    "GitHub refusing the rerun": github({
      runs: [actions(1, "tests", "failure")],
      refuse: 422,
    }),
  };
  for (const [name, hub] of Object.entries(cases)) {
    const result = await observe(hub);
    assert.equal(result.kind, "repair", name);
    assert.doesNotMatch(result.finding, /reran/, name);
  }
  assert.deepEqual(cases["a commit status"].reruns, []);
});

test("a rerun the login may not make asks for Actions: write", async () => {
  const hub = github({ runs: [actions(1, "tests", "failure")], refuse: 403 });
  await assert.rejects(observe(hub), (error) => {
    assert.equal(error.permission, "Actions: write");
    return true;
  });
});

test("the step keeps and logs the rerun, then logs the pass once for the report", () => {
  const logged = [];
  const item = { id: "a" };
  const rerun = {
    head: HEAD,
    checks: ["tests"],
    runs: [RUN],
    at: new Date().toISOString(),
  };
  const context = (kept = {}) => ({
    state: { kept, done: {}, issue: 1 },
    log: (event) => logged.push(event),
  });
  const outcome = rerunOutcome(context(), item, {
    kind: "rerun",
    reason: "Rerunning",
    afterMs: 20_000,
    rerun,
  });
  assert.equal(outcome.kind, "retry");
  assert.equal(outcome.afterMs, 20_000);
  assert.deepEqual(fact({ kept: outcome.keep }, "ciRerun", "a"), rerun);
  assert.equal(logged[0].event, "ci-rerun");

  const kept = facts({ ciRerun: rerun }, "a");
  assert.equal(passedRerun(context(kept), item, "b".repeat(40)), undefined);
  const passed = passedRerun(context(kept), item, HEAD);
  assert.equal(fact({ kept: passed }, "ciRerun", "a").passed, true);
  assert.deepEqual(
    logged.map((event) => event.event),
    ["ci-rerun", "ci-flaky"],
  );
  assert.equal(passedRerun(context(passed), item, HEAD), undefined);
  assert.equal(logged.length, 2);
});
