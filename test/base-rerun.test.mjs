// Clockgrove #821: main's head last passed `quality` five days before a
// newly published advisory made the supply-chain gate fail on every PR,
// and on main too, had it run. Factory compared the PR's failure with that
// stale pass only, read main as green and repaired the Work Items (#2098).
// With the operator's opt-in delivery.baseRerun, Factory runs that one
// workflow on main and compares with a fresh run there; without it, it
// still runs nothing on the default branch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCi } from "../dist/delivery.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PR_RUN = 900;
const MAIN_RUN = 950;
const DISPATCHED_RUN = 960;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const QUALITY = ".github/workflows/quality.yml";

const failedAt = Date.now() - MINUTE;
const stalePass = new Date(failedAt - 5 * DAY).toISOString();

/** A completed GitHub Actions check run on the PR's head. */
function check(id, name, conclusion, fields = {}) {
  return {
    id,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion,
    completed_at: new Date(failedAt).toISOString(),
    html_url: `https://github.com/o/r/actions/runs/${PR_RUN}/job/${id}`,
    app: { id: 15368, slug: "github-actions" },
    ...fields,
  };
}

/** The same on main's head BASE. */
const onBase = (id, name, conclusion, fields = {}) =>
  check(id, name, conclusion, { head_sha: BASE, ...fields });

/** main's last `quality` run: a pass five days before the PR failed. */
const STALE = onBase(21, "quality", "success", { completed_at: stalePass });

/**
 * A GitHub whose open PR #7 is ready but for its failed `quality` check:
 * `baseRuns` on main's head. Check runs 21 and up on main belong to the
 * workflow run `jobRuns` names (main's push run by default), and each
 * workflow run ran the file `paths` names. `dispatch` is what a dispatch
 * does: nothing, or an error to throw.
 */
function github({
  runs = [check(1, "quality", "failure")],
  baseRuns = [STALE],
  attempt = 1,
  jobRuns = {},
  paths = { [MAIN_RUN]: QUALITY, [DISPATCHED_RUN]: QUALITY },
  actions = true,
  dispatch,
  head = BASE,
} = {}) {
  const reruns = [];
  const dispatched = [];
  return {
    reruns,
    dispatched,
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
      mergeStateStatus: "UNSTABLE",
    }),
    branchHead: async (branch) => {
      assert.equal(branch, "main");
      return head;
    },
    checkRuns: async (sha) =>
      sha === HEAD ? runs : sha === head ? baseRuns : [],
    commitStatuses: async () => [],
    requiredChecks: async () => [],
    failureAnnotations: async () => [],
    jobLogTail: async () => undefined,
    workflowJob: async (job) =>
      actions
        ? {
            run: job < 20 ? PR_RUN : (jobRuns[job] ?? MAIN_RUN),
            attempt,
            failedSteps: [],
            failedStepTimes: [],
          }
        : undefined,
    workflowRunAttempt: async (run) =>
      actions
        ? {
            attempt: run === PR_RUN ? attempt : 1,
            status: "completed",
            ...(paths[run] ? { path: paths[run] } : {}),
          }
        : undefined,
    rerunFailedJobs: async (run) => {
      reruns.push(run);
    },
    dispatchWorkflow: async (workflow, ref) => {
      dispatched.push([workflow, ref]);
      if (dispatch) throw dispatch;
    },
    runArtifacts: async () => [],
    commitsBeyond: async () => ({ total: 0, commits: [] }),
  };
}

/** The CI step on `hub`'s PR #7, with `workflow` as delivery.baseRerun. */
function observe(hub, workflow, answered = {}) {
  return observeCi(
    {
      github: hub,
      checkout: "/nonexistent",
      signal: new AbortController().signal,
      ...(workflow ? { baseRerun: workflow } : {}),
    },
    {
      issue: 1,
      item: "a",
      pr: 7,
      head: HEAD,
      pushedHeads: [HEAD],
      requiredChecks: [],
      ...answered,
    },
  );
}

/** What the item keeps once Factory dispatched quality.yml `ago` ms ago. */
const kept = (ago, fields = {}) => ({
  baseRerun: {
    base: BASE,
    workflow: "quality.yml",
    checks: ["quality"],
    at: new Date(Date.now() - ago).toISOString(),
    dispatched: true,
    ...fields,
  },
});

test("without delivery.baseRerun Factory runs nothing on main: a stale pass is only noted", async () => {
  const hub = github({ attempt: 2 });
  const result = await observe(hub);
  assert.equal(result.kind, "repair", JSON.stringify(result));
  assert.deepEqual(hub.dispatched, []);
  assert.match(
    result.finding,
    /On main's head b{40}, as GitHub shows it \(Factory runs nothing there\): quality ended success at \S+, 5 days before it failed here\. A pass that old may not hold now/,
  );
});

test("with delivery.baseRerun a stale pass from that workflow dispatches it on main once, before any rerun or repair", async () => {
  const hub = github();
  const result = await observe(hub, "quality.yml");
  assert.equal(result.kind, "rerun", JSON.stringify(result));
  assert.deepEqual(hub.dispatched, [["quality.yml", "main"]]);
  // Neither the PR's jobs rerun nor a repair: main's fresh run decides.
  assert.deepEqual(hub.reruns, []);
  assert.equal(result.rerun, undefined);
  assert.deepEqual(
    { ...result.baseRerun, at: undefined },
    {
      base: BASE,
      workflow: "quality.yml",
      checks: ["quality"],
      at: undefined,
      dispatched: true,
    },
  );
  assert.ok(Date.parse(result.baseRerun.at) >= failedAt);
  assert.match(
    result.reason,
    /^Running quality\.yml on main's head b{40} \(the operator's delivery\.baseRerun\) to compare PR #7's failed quality with a fresh run/,
  );
});

test("the dispatched run is waited for, and its failure on main holds with no repair (#821)", async () => {
  // GitHub doesn't show the run yet, then it runs: a wait, no second dispatch.
  for (const baseRuns of [
    [STALE],
    [
      STALE,
      onBase(31, "quality", null, { status: "queued", completed_at: null }),
    ],
  ]) {
    const hub = github({ baseRuns, jobRuns: { 31: DISPATCHED_RUN } });
    const wait = await observe(hub, "quality.yml", kept(5 * MINUTE));
    assert.equal(wait.kind, "retry", JSON.stringify(wait));
    assert.match(
      wait.reason,
      /^Awaiting main's fresh run of quality at b{40} \(quality\.yml, the operator's delivery\.baseRerun\)/,
    );
    assert.deepEqual(hub.dispatched, []);
    assert.deepEqual(hub.reruns, []);
  }
  // It failed on main too: main is red, and no repair is spent.
  const red = github({
    baseRuns: [STALE, onBase(31, "quality", "failure")],
    jobRuns: { 31: DISPATCHED_RUN },
  });
  const held = await observe(red, "quality.yml", kept(10 * MINUTE));
  assert.equal(held.kind, "hold", JSON.stringify(held));
  assert.match(
    held.question,
    /^main is red: its head b{40} fails "quality" too, which failed on PR #7/,
  );
  assert.deepEqual(red.dispatched, []);
  assert.deepEqual(red.reruns, []);
});

test("a fresh pass on main goes on to the rerun and the repair, saying what ran there", async () => {
  const passed = (fields) =>
    github({
      baseRuns: [STALE, onBase(31, "quality", "success")],
      jobRuns: { 31: DISPATCHED_RUN },
      ...fields,
    });
  const first = passed();
  const rerun = await observe(first, "quality.yml", kept(10 * MINUTE));
  assert.equal(rerun.kind, "rerun", JSON.stringify(rerun));
  assert.deepEqual(first.reruns, [PR_RUN]);
  assert.deepEqual(first.dispatched, []);

  const repair = await observe(
    passed({ attempt: 2 }),
    "quality.yml",
    kept(10 * MINUTE),
  );
  assert.equal(repair.kind, "repair", JSON.stringify(repair));
  assert.match(
    repair.finding,
    /On main's head b{40}, as GitHub shows it \(Factory runs only quality\.yml there, the operator's delivery\.baseRerun\): quality ended success at \S+\./,
  );
  assert.doesNotMatch(repair.finding, /may not hold now/);
});

const now = () => new Date().toISOString();

test("after a result rereview, main's fresh pass in Factory's run repairs instead of asking to run it there again", async () => {
  const hub = (fields) =>
    github({
      attempt: 2,
      baseRuns: [
        STALE,
        onBase(31, "quality", "success", { completed_at: now() }),
      ],
      jobRuns: { 31: DISPATCHED_RUN },
      ...fields,
    });
  const rereviewed = { retried: true, rereviewedAt: now() };
  const repair = await observe(hub(), "quality.yml", {
    ...kept(10 * MINUTE),
    ...rereviewed,
  });
  assert.equal(repair.kind, "repair", JSON.stringify(repair));
  assert.match(
    repair.finding,
    /Factory ran quality\.yml on main's head b{40} at \S+ \(the operator's delivery\.baseRerun\), and it passed quality there\./,
  );
  // Without Factory's run, the rereview's question stands (#2129).
  const held = await observe(hub(), undefined, rereviewed);
  assert.equal(held.kind, "hold", JSON.stringify(held));
  assert.match(held.question, /was checked again on the operator's revalidate/);
  // A pass on main from before the PR's failure says nothing new either.
  const before = await observe(
    hub({
      baseRuns: [
        STALE,
        onBase(31, "quality", "success", {
          completed_at: new Date(failedAt - MINUTE).toISOString(),
        }),
      ],
    }),
    "quality.yml",
    { ...kept(10 * MINUTE), ...rereviewed },
  );
  assert.equal(before.kind, "hold", JSON.stringify(before));
});
