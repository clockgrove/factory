// Clockgrove #821: main's head last passed `quality` five days before a
// newly published advisory made the supply-chain gate fail on every PR,
// and on main too, had it run. Factory compared the PR's failure with that
// stale pass only, read main as green and repaired the Work Items (#2098).
// With the operator's opt-in delivery.baseRerun, Factory runs that one
// workflow on main and compares with a fresh run there; without it, it
// still runs nothing on the default branch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { observeCi } from "../dist/delivery.js";
import { GitHub, GitHubError } from "../dist/github.js";
import { skipsDispatchedRuns } from "../dist/planning/dispatch-guard.js";
import { baseRerunWorkflow } from "../dist/planning/facts.js";
import { baseRerunCheck } from "../dist/readiness.js";
import {
  delivery,
  keepBaseReruns,
  pullInput,
  rerunOutcome,
} from "../dist/work/step-deliver.js";
import {
  cli,
  closedPort,
  configured,
  installation,
  item,
  plan,
  REPO,
} from "./helpers.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MOVED = "e".repeat(40);
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

test("a run that gives no fresh result within the hour is noted, and the failure is judged without it", async () => {
  const hub = github({ attempt: 2 });
  const repair = await observe(hub, "quality.yml", kept(61 * MINUTE));
  assert.equal(repair.kind, "repair", JSON.stringify(repair));
  assert.deepEqual(hub.dispatched, []);
  assert.match(
    repair.finding,
    /Factory ran quality\.yml on main's head b{40} at \S+ \(the operator's delivery\.baseRerun\), and quality had no fresh result there 60 minutes later\./,
  );
});

test("a dispatch is made again only for another head of main, or a day later", async () => {
  for (const [what, hub, keep] of [
    [
      "main moved",
      github({ head: MOVED, baseRuns: [{ ...STALE, head_sha: MOVED }] }),
      kept(MINUTE),
    ],
    ["a day later", github(), kept(DAY + MINUTE)],
    ["another workflow", github(), kept(MINUTE, { workflow: "other.yml" })],
  ]) {
    const result = await observe(hub, "quality.yml", keep);
    assert.equal(result.kind, "rerun", what);
    assert.deepEqual(hub.dispatched, [["quality.yml", "main"]], what);
  }
});

test("Factory runs only the named workflow, and only for a stale pass of its own", async () => {
  for (const [what, hub] of [
    // main's stale pass came from another workflow.
    [
      "another workflow's pass",
      github({ paths: { [MAIN_RUN]: ".github/workflows/release.yml" } }),
    ],
    // Without Actions read access the workflow of the pass is unknown.
    ["no Actions access", github({ actions: false })],
    // A pass from an hour before says enough.
    [
      "a recent pass",
      github({
        baseRuns: [
          onBase(21, "quality", "success", {
            completed_at: new Date(failedAt - 60 * MINUTE).toISOString(),
          }),
        ],
      }),
    ],
    // No run on main at all: nothing to say which workflow reports it.
    ["no run on main", github({ baseRuns: [] })],
  ]) {
    const result = await observe(hub, "quality.yml");
    assert.deepEqual(hub.dispatched, [], what);
    assert.equal(result.baseRerun, undefined, what);
  }
  // The operator's repair: the item's change is meant to fix it there.
  const shared = github({ attempt: 2 });
  const repaired = await observe(shared, "quality.yml", { repairShared: true });
  assert.equal(repaired.kind, "repair");
  assert.deepEqual(shared.dispatched, []);
});

test("a run of the workflow already in progress on main is waited for, with no dispatch", async () => {
  const hub = github({
    baseRuns: [
      STALE,
      onBase(31, "quality", null, {
        status: "in_progress",
        completed_at: null,
      }),
    ],
    jobRuns: { 31: DISPATCHED_RUN },
  });
  const result = await observe(hub, "quality.yml");
  assert.equal(result.kind, "rerun", JSON.stringify(result));
  assert.equal(result.baseRerun.dispatched, false);
  assert.deepEqual(result.baseRerun.checks, ["quality"]);
  assert.deepEqual(hub.dispatched, []);
  assert.deepEqual(hub.reruns, []);
});

test("a dispatch GitHub refuses is noted in the repair; a 403 asks for Actions: write", async () => {
  const refused = github({
    attempt: 2,
    dispatch: new GitHubError(
      "Workflow does not have 'workflow_dispatch' trigger",
      422,
    ),
  });
  const repair = await observe(refused, "quality.yml");
  assert.equal(repair.kind, "repair", JSON.stringify(repair));
  assert.match(
    repair.finding,
    /Factory could not run quality\.yml on main for a fresh comparison \(the operator's delivery\.baseRerun\): GitHub refused it \(HTTP 422: .*workflow_dispatch.*\)\. It must be a workflow on main that runs on workflow_dispatch with no required input\./,
  );
  const forbidden = github({
    dispatch: new GitHubError("Resource not accessible by integration", 403),
  });
  await assert.rejects(observe(forbidden, "quality.yml"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.permission, "Actions: write");
    return true;
  });
});

test("the item steps pass the setting and the kept run on, and keep and log a new one", () => {
  const a = item("a");
  const state = {
    issue: 1,
    kept: {},
    done: {
      plan: plan([a]),
      "item:a:publish": { pr: 7, head: HEAD, merged: false },
    },
  };
  const context = {
    state,
    signal: new AbortController().signal,
    log() {},
  };
  const deps = (baseRerun) => ({
    github: {},
    config: {
      checkout: "/x",
      delivery: { kind: "regular", ...(baseRerun ? { baseRerun } : {}) },
    },
  });
  assert.equal(delivery(context, deps()).baseRerun, undefined);
  assert.equal(
    delivery(context, deps({ workflow: "quality.yml" })).baseRerun,
    "quality.yml",
  );
  assert.equal(pullInput(state, a, context, undefined).baseRerun, undefined);
  const run = kept(MINUTE).baseRerun;
  state.kept["item:a:baseRerun"] = run;
  assert.deepEqual(pullInput(state, a, context, undefined).baseRerun, run);

  const logged = [];
  const outcome = rerunOutcome(
    { ...context, log: (event) => logged.push(event) },
    a,
    {
      kind: "rerun",
      reason: "Running quality.yml",
      afterMs: 20_000,
      baseRerun: run,
    },
  );
  assert.equal(outcome.kind, "retry");
  assert.deepEqual(outcome.keep, { "item:a:baseRerun": run });
  assert.deepEqual(logged, [
    {
      event: "base-rerun",
      item: "a",
      base: BASE,
      workflow: "quality.yml",
      checks: ["quality"],
      dispatched: true,
    },
  ]);
});

/** A default branch's workflow files, for readiness. */
const files = (workflows) => ({
  paths: async () => Object.keys(workflows),
  text: async (path) => workflows[path],
});

const QUALITY_YML = `name: Quality
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps: [{ run: npm test }]
  quality:
    runs-on: ubuntu-latest
    steps: [{ run: npm run supply-chain }]
`;

test("readiness says what delivery.baseRerun lets Factory run on main, and what runs after it", async () => {
  const config = (workflow) => ({
    repository: REPO,
    checkout: "/nonexistent",
    delivery: {
      kind: "regular",
      ...(workflow ? { baseRerun: { workflow } } : {}),
    },
  });
  assert.equal(await baseRerunCheck(config(), "main", files({})), undefined);

  const ok = await baseRerunCheck(
    config("quality.yml"),
    "main",
    files({ [QUALITY]: QUALITY_YML }),
  );
  assert.equal(ok.status, "ok", JSON.stringify(ok));
  assert.match(
    ok.detail,
    /^Factory may run quality\.yml \(checks, quality\) on main's head/,
  );

  // Clockgrove's Guarded release runs after Quality: a dispatch starts it.
  const followed = await baseRerunCheck(
    config("quality.yml"),
    "main",
    files({
      [QUALITY]: QUALITY_YML,
      ".github/workflows/release.yml":
        "name: Guarded release\non:\n  workflow_run:\n    workflows: [Quality]\n    types: [completed]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm publish }]\n",
    }),
  );
  assert.equal(followed.status, "warn");
  assert.match(
    followed.detail,
    /and \.github\/workflows\/release\.yml runs after it \(workflow_run\), so each run Factory dispatches starts that too/,
  );
  assert.match(
    followed.fix,
    /github\.event\.workflow_run\.event is workflow_dispatch/,
  );

  for (const [workflows, problem] of [
    [{}, /there is no \.github\/workflows\/quality\.yml/],
    [
      { [QUALITY]: "on: [push]\njobs: {}\n" },
      /doesn't run on workflow_dispatch/,
    ],
    [
      {
        [QUALITY]:
          "on:\n  workflow_dispatch:\n    inputs:\n      target:\n        required: true\njobs: {}\n",
      },
      /requires the input target with no default/,
    ],
  ]) {
    const warned = await baseRerunCheck(
      config("quality.yml"),
      "main",
      files(workflows),
    );
    assert.equal(warned.status, "warn");
    assert.match(warned.detail, problem);
    assert.match(warned.detail, /so GitHub refuses Factory's dispatch of it/);
  }
  // An input with a default is dispatched with it.
  const defaulted = await baseRerunWorkflow(
    files({
      [QUALITY]:
        "on:\n  workflow_dispatch:\n    inputs:\n      target:\n        required: true\n        default: all\njobs:\n  quality: {}\n",
    }),
    "quality.yml",
  );
  assert.deepEqual(defaulted, {
    checks: ["quality"],
    followers: [],
    guarded: [],
  });
});

test("delivery.baseRerun is a workflow's file name, set by setup's --base-rerun-workflow", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const set = JSON.parse(
    cli(inst, "setup", "--base-rerun-workflow", "quality.yml", "--json").out,
  );
  assert.notEqual(set.status, "refused", JSON.stringify(set));
  assert.deepEqual(set.changed, ["delivery.baseRerun.workflow"]);
  assert.deepEqual(
    JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8")).delivery,
    { baseRerun: { workflow: "quality.yml" } },
  );
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    assert.deepEqual(loadConfig(REPO).delivery, {
      kind: "regular",
      baseRerun: { workflow: "quality.yml" },
    });
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
  const path = JSON.parse(
    cli(
      inst,
      "setup",
      "--base-rerun-workflow",
      ".github/workflows/quality.yml",
      "--json",
    ).out,
  );
  assert.equal(path.status, "refused");
  assert.match(
    path.problems.join("\n"),
    /delivery\.baseRerun\.workflow must be a workflow's file name in \.github\/workflows, such as "quality\.yml"/,
  );
});

test("the client dispatches a workflow on a branch and reads the file a workflow run ran", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = request.url.split("?")[0];
      requests.push({ method: request.method, path, body });
      const repo = `/repos/${REPO}`;
      if (path === `${repo}/actions/workflows/quality.yml/dispatches`) {
        response.writeHead(204);
        return response.end();
      }
      if (path === `${repo}/actions/runs/${MAIN_RUN}`) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(
          JSON.stringify({
            run_attempt: 1,
            status: "completed",
            path: QUALITY,
          }),
        );
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not Found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.FACTORY_GITHUB_TOKEN = "ghs_test";
  const hub = new GitHub(REPO, `http://127.0.0.1:${server.address().port}`);
  await hub.dispatchWorkflow("quality.yml", "main");
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: `/repos/${REPO}/actions/workflows/quality.yml/dispatches`,
    body: JSON.stringify({ ref: "main" }),
  });
  assert.deepEqual(await hub.workflowRunAttempt(MAIN_RUN), {
    attempt: 1,
    status: "completed",
    path: QUALITY,
  });
  await assert.rejects(hub.dispatchWorkflow("missing.yml", "main"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 404);
    return true;
  });
});

const now = () => new Date().toISOString();

test("a run on main that ends with no result (cancelled, skipped) is no fresh pass: the finding says so and keeps the stale pass's warning", async () => {
  for (const [what, conclusion, keep] of [
    ["the dispatched run cancelled", "cancelled", kept(10 * MINUTE)],
    ["the dispatched run skipped", "skipped", kept(10 * MINUTE)],
    [
      "the run waited for cancelled",
      "cancelled",
      kept(10 * MINUTE, { dispatched: false }),
    ],
  ]) {
    const hub = github({
      attempt: 2,
      baseRuns: [
        STALE,
        onBase(31, "quality", conclusion, { completed_at: now() }),
      ],
      jobRuns: { 31: DISPATCHED_RUN },
    });
    const repair = await observe(hub, "quality.yml", keep);
    assert.equal(repair.kind, "repair", what);
    assert.deepEqual(hub.dispatched, [], what);
    assert.match(
      repair.finding,
      new RegExp(
        `, and its run of quality ended ${conclusion} at \\S+, with no fresh result\\. main's pass of quality at ${stalePass} before it is a day or more older than the failure here, and a pass that old may not hold now`,
      ),
      what,
    );
  }
});

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

test("on a retry, a dispatched run with no result within the hour is waited for no longer", async () => {
  const queued = () =>
    github({
      attempt: 2,
      baseRuns: [
        STALE,
        onBase(31, "quality", null, { status: "queued", completed_at: null }),
      ],
      jobRuns: { 31: DISPATCHED_RUN },
    });
  const repair = await observe(queued(), "quality.yml", {
    ...kept(5 * 60 * MINUTE),
    retried: true,
  });
  assert.equal(repair.kind, "repair", JSON.stringify(repair));
  assert.match(
    repair.finding,
    /and quality had no fresh result there 60 minutes later\./,
  );
  // Within the hour it is still waited for.
  const wait = await observe(queued(), "quality.yml", {
    ...kept(10 * MINUTE),
    retried: true,
  });
  assert.equal(wait.kind, "retry", JSON.stringify(wait));
  assert.match(wait.reason, /^Awaiting main's fresh run of quality/);
});

test("a run of the workflow in progress on main for one failed check is waited for before a dispatch for another", async () => {
  const stale = (id, name) =>
    onBase(id, name, "success", { completed_at: stalePass });
  const pr = [check(1, "test", "failure"), check(2, "lint", "failure")];
  const running = github({
    runs: pr,
    baseRuns: [
      stale(21, "lint"),
      stale(22, "test"),
      onBase(31, "test", null, { status: "in_progress", completed_at: null }),
    ],
    jobRuns: { 31: DISPATCHED_RUN },
  });
  const wait = await observe(running, "quality.yml");
  assert.equal(wait.kind, "rerun", JSON.stringify(wait));
  assert.deepEqual(running.dispatched, []);
  assert.deepEqual(wait.baseRerun.checks, ["test"]);
  assert.equal(wait.baseRerun.dispatched, false);
  // It passed; lint's pass there is still stale: now it is dispatched.
  const ended = github({
    runs: pr,
    baseRuns: [
      stale(21, "lint"),
      stale(22, "test"),
      onBase(31, "test", "success", { completed_at: now() }),
    ],
    jobRuns: { 31: DISPATCHED_RUN },
  });
  const dispatched = await observe(ended, "quality.yml", {
    baseRerun: {
      ...wait.baseRerun,
      at: new Date(Date.now() - 2 * MINUTE).toISOString(),
    },
  });
  assert.equal(dispatched.kind, "rerun", JSON.stringify(dispatched));
  assert.deepEqual(ended.dispatched, [["quality.yml", "main"]]);
  assert.deepEqual(dispatched.baseRerun.checks, ["lint"]);
  assert.equal(dispatched.baseRerun.dispatched, true);
});

test("a native stack's layers share one dispatch, and the merge step keeps and logs each layer's", async () => {
  const hub = github();
  const baseReruns = [];
  const context = {
    github: hub,
    checkout: "/nonexistent",
    signal: new AbortController().signal,
    baseRerun: "quality.yml",
    baseReruns,
  };
  const layer = (name) =>
    observeCi(context, {
      issue: 1,
      item: name,
      pr: 7,
      head: HEAD,
      pushedHeads: [HEAD],
      requiredChecks: [],
    });
  const first = await layer("a");
  const second = await layer("b");
  assert.deepEqual(hub.dispatched, [["quality.yml", "main"]]);
  assert.equal(first.baseRerun.dispatched, true);
  assert.equal(second.kind, "rerun", JSON.stringify(second));
  assert.equal(second.baseRerun.dispatched, false);
  assert.equal(second.baseRerun.at, first.baseRerun.at);
  assert.match(
    second.reason,
    /^Awaiting the run of quality\.yml that Factory dispatched on main's head b{40}/,
  );
  assert.deepEqual(
    baseReruns.map((entry) => entry.item),
    ["a", "b"],
  );

  // Another layer's repair is the outcome: both runs are kept and logged.
  const logged = [];
  const step = { log: (event) => logged.push(event) };
  const repaired = keepBaseReruns(
    step,
    { kind: "repair", finding: "x", target: "item:c:work", clear: [] },
    baseReruns,
    undefined,
  );
  assert.deepEqual(repaired.keep, {
    "item:a:baseRerun": first.baseRerun,
    "item:b:baseRerun": second.baseRerun,
  });
  assert.deepEqual(
    logged.map((event) => [event.event, event.item, event.dispatched]),
    [
      ["base-rerun", "a", true],
      ["base-rerun", "b", false],
    ],
  );
  // Layer a's rerun is the outcome: rerunOutcome keeps that one.
  logged.length = 0;
  const chosen = keepBaseReruns(
    step,
    {
      kind: "retry",
      reason: "r",
      keep: { "item:a:baseRerun": first.baseRerun },
    },
    baseReruns,
    "a",
  );
  assert.deepEqual(chosen.keep, {
    "item:a:baseRerun": first.baseRerun,
    "item:b:baseRerun": second.baseRerun,
  });
  assert.deepEqual(
    logged.map((event) => event.item),
    ["b"],
  );
});

test("readiness accepts a follower whose every job skips a dispatched run, as Clockgrove's Guarded release does", async () => {
  const config = {
    repository: REPO,
    checkout: "/nonexistent",
    delivery: { kind: "regular", baseRerun: { workflow: "quality.yml" } },
  };
  // Guarded release's shape: one job releases only from a push, the
  // others need it.
  const release = `name: Guarded release
on:
  workflow_run:
    workflows: [Quality]
    types: [completed]
    branches: [main]
  workflow_dispatch:
jobs:
  select:
    if: \${{ github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository) }}
    runs-on: ubuntu-latest
    steps: [{ run: node select.mjs }]
  staging:
    needs: select
    if: \${{ needs.select.outputs.environment == 'staging' }}
    uses: ./.github/workflows/deploy.yml
  production:
    if: \${{ false }}
    needs: select
    uses: ./.github/workflows/deploy.yml
`;
  const guarded = await baseRerunCheck(
    config,
    "main",
    files({ [QUALITY]: QUALITY_YML, ".github/workflows/release.yml": release }),
  );
  assert.equal(guarded.status, "ok", JSON.stringify(guarded));
  assert.match(
    guarded.detail,
    /\.github\/workflows\/release\.yml runs after it but skips every job for a run Factory dispatched/,
  );
  // A job that still runs for a dispatched run: the warning stays.
  const deploys = await baseRerunCheck(
    config,
    "main",
    files({
      [QUALITY]: QUALITY_YML,
      ".github/workflows/release.yml": release.replace(
        "    if: ${{ needs.select.outputs.environment == 'staging' }}\n",
        "    if: ${{ always() }}\n",
      ),
    }),
  );
  assert.equal(deploys.status, "warn", JSON.stringify(deploys));

  const skips = (jobs) => skipsDispatchedRuns({ jobs });
  const job = (fields = {}) => ({ "runs-on": "x", ...fields });
  for (const [what, jobs, expected] of [
    ["no if", { a: job() }, false],
    ["if false", { a: job({ if: false }) }, true],
    [
      "push only",
      { a: job({ if: "github.event.workflow_run.event == 'push'" }) },
      true,
    ],
    [
      "not a dispatch, any case",
      {
        a: job({
          if: "${{ github['event'].workflow_run.EVENT != 'WORKFLOW_DISPATCH' }}",
        }),
      },
      true,
    ],
    [
      "unknown either way",
      { a: job({ if: "github.event.workflow_run.conclusion == 'success'" }) },
      false,
    ],
    [
      "unknown or true",
      {
        a: job({
          if: "github.event.workflow_run.event == 'push' || github.ref == 'refs/heads/main'",
        }),
      },
      false,
    ],
    [
      "needs a skipped job",
      { a: job({ if: false }), b: job({ needs: ["a"] }) },
      true,
    ],
    [
      "needs a skipped job, always()",
      { a: job({ if: false }), b: job({ needs: "a", if: "always()" }) },
      false,
    ],
    ["text around the expression", { a: job({ if: "x ${{ false }}" }) }, false],
    ["unparsable", { a: job({ if: "github.event_name ==" }) }, false],
    ["no jobs", {}, false],
  ])
    assert.equal(skips(jobs), expected, what);
});
