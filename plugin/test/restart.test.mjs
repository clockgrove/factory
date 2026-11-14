// Restarting an Objective from its issue's current text (#206): the `factory:restart` label, in any state. A running
// stage stops first (the stop of #207); then the dispatcher closes the earlier PR with a comment, deletes the branch,
// retires the plan and split records, forgets the comments from before the restart, and queues the Objective again.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESTART_LABEL, restartMarker, restartObjective, restartRecord, stopCause, stopText } from "../scripts/lib/stop.mjs";
import { maintainerDecisions, restartedAt, setSelf } from "../scripts/lib/logic.mjs";
import { currentPlan, partsRecord } from "../scripts/lib/handoff.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const BOT = { login: "factory-app[bot]", type: "Bot" };
const issue = (labels, state = "open", number = 7) => ({ number, state, labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });
const AT = "2031-03-02T02:00:00Z";
const recordComment = (n = 7, at = AT) => ({ id: 900, user: BOT, created_at: "2031-03-02T02:01:00Z", body: `${restartMarker(n, at)}\n${restartRecord({ at, pr: 70 })}` });

test("stopCause: factory:restart stops a running stage first; a closed or unlabelled issue stays what it was", () => {
  assert.equal(stopCause(issue(["factory:objective", RESTART_LABEL]), "factory:objective"), "restart");
  assert.equal(stopCause(issue([RESTART_LABEL]), "factory:objective"), "unlabeled", "a stopped Objective restarts only once its label is back");
  assert.equal(stopCause(issue(["factory:objective", RESTART_LABEL], "closed"), "factory:objective"), "closed");
  assert.equal(stopText("restart"), "`factory:restart` was applied");
});

test("restartedAt and the decisions: a comment from before the restart feeds no run after it; a stranger's record counts for nothing", () => {
  setSelf(BOT.login);
  try {
    const before = { id: 1, user: { login: "maintainer", type: "User" }, created_at: "2031-03-02T01:00:00Z", body: "Use the old API." };
    const after = { id: 2, user: { login: "maintainer", type: "User" }, created_at: "2031-03-02T02:30:00Z", body: "Use the new API." };
    assert.equal(restartedAt([before, after]), null);
    assert.deepEqual(maintainerDecisions([before, after]).map((d) => d.body), ["Use the old API.", "Use the new API."]);
    const comments = [before, recordComment(), after];
    assert.equal(restartedAt(comments), "2031-03-02T02:00:00.000Z");
    assert.deepEqual(maintainerDecisions(comments).map((d) => d.body), ["Use the new API."]);
    // The newest restart counts; a record by someone Factory does not trust is no restart.
    const later = recordComment(7, "2031-03-02T03:00:00Z");
    assert.equal(restartedAt([...comments, later]), "2031-03-02T03:00:00.000Z");
    assert.deepEqual(maintainerDecisions([...comments, later]), []);
    const forged = { ...recordComment(7, "2031-03-02T03:00:00Z"), user: { login: "stranger", type: "User" } };
    assert.equal(restartedAt([before, forged, after]), null);
  } finally {
    setSelf(null);
  }
});

/** A fetch fake: one Objective (#7) with an open PR (#70, in the merge queue), a plan comment and a split record. */
function fakeApi({ open = () => [], pr = { number: 70, draft: false, node_id: "PR_70" }, queued = true, comments = null, timeline = () => [], jobs = [] } = {}) {
  const writes = [];
  const state = { comments: comments ?? [{ id: 11, user: BOT, created_at: "2031-03-02T01:05:00Z", body: "<!-- factory:7:plan -->\n## Plan\n- [ ] old item" }, { id: 12, user: BOT, created_at: "2031-03-02T01:40:00Z", body: '<!-- factory:7:parts {"prs":[70],"remaining":2} -->\nparts' }] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const path = decodeURIComponent(u.pathname).replace("/repos/acme/app", "");
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") {
      if (/dequeuePullRequest/.test(body?.query || "")) writes.push(`dequeue ${body.variables.id}`);
      if (/mergeQueueEntry \{/.test(body?.query || "")) return json({ data: { repository: { pullRequest: { mergeQueueEntry: queued ? { state: "QUEUED" } : null } } } });
      return json({ data: {} });
    }
    if (method !== "GET") writes.push(`${method} ${path}${method === "PATCH" && body?.body ? ` ${body.body.split("\n")[0]}` : method === "PATCH" && body?.state ? ` ${body.state}` : method === "POST" && body?.body ? ` ${body.body.split("\n")[0]}` : ""}`);
    if (method === "GET" && path === "/issues") return json(u.searchParams.get("state") === "closed" ? [] : open(u.searchParams.get("labels")));
    if (method === "GET" && path === "/pulls") return json(pr && u.searchParams.get("head") === "acme:factory/7" ? [pr] : []);
    if (method === "GET" && path === "/pulls/70") return json(pr);
    if (method === "GET" && /^\/issues\/7\/comments$/.test(path)) return json(state.comments);
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path)) return json([]);
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(path)) return json(timeline(Number(/issues\/(\d+)\//.exec(path)[1])));
    if (method === "GET" && path.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && path === "/actions/artifacts") return json({ artifacts: [] });
    if (method === "GET" && path === "/issues/comments") return json([]);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(path)) return json({ workflow_runs: u.searchParams.get("status") === "in_progress" && jobs.length ? [{ id: 5 }] : [] });
    if (method === "GET" && path === "/actions/runs/5/jobs") return json({ jobs });
    if (method === "PATCH" && /^\/issues\/comments\/\d+$/.test(path)) {
      const c = state.comments.find((x) => x.id === Number(path.split("/").pop()));
      if (c) c.body = body.body;
      return json(c || {});
    }
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path)) return json({ id: 99, html_url: "https://github.test/acme/app/issues/7#issuecomment-99", user: BOT, body: body.body });
    if (method === "DELETE" || method === "POST" || method === "PATCH") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { writes, state, restore: () => (globalThis.fetch = realFetch) };
}

const withEnv = async (env, fn) => {
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  for (const k of ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

test("restartObjective: the record first; the earlier PR out of the queue, commented, closed; the branch deleted; the plan and split retired; the labels off, restart last", async () => {
  setSelf(BOT.login);
  try {
    await withEnv({}, async () => {
      const api = fakeApi();
      try {
        const r = await restartObjective(REPO, 7, { at: AT, project: null }, { token: "t" });
        assert.deepEqual(r, { pr: 70 });
        assert.deepEqual(api.writes, [
          `POST /issues/7/comments ${restartMarker(7, AT)}`,
          "dequeue PR_70",
          "DELETE /issues/70/labels/factory:review",
          "POST /issues/70/comments <!-- factory:7:restarted:20310302T020000Z -->",
          "PATCH /pulls/70 closed",
          "DELETE /git/refs/heads/factory/7",
          "PATCH /issues/comments/11 <!-- factory:7:restarted-plan -->",
          'PATCH /issues/comments/12 <!-- factory:7:restarted-parts {"prs":[70],"remaining":2} -->',
          "DELETE /issues/7/labels/factory:running",
          "DELETE /issues/7/labels/factory:blocked",
          "DELETE /issues/7/labels/factory:question",
          "DELETE /issues/7/labels/factory:in-review",
          "DELETE /issues/7/labels/factory:restart",
        ]);
        // The restarted run reads no plan and no split, and the old texts are still there to read.
        assert.equal(await currentPlan(REPO, 7, { token: "t" }), null);
        assert.equal(await partsRecord(REPO, 7, { token: "t" }), null);
        assert.match(api.state.comments[0].body, /old item/);
      } finally {
        api.restore();
      }
    });
  } finally {
    setSelf(null);
  }
});

test("dispatcher: a restart waits for a running stage to stop, never picked meanwhile; then the Objective restarts and is picked in the same tick, in any state", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const run = (labels, { jobs = [], restartAgo = 60_000, dailyUsd = 100 } = {}) =>
    withEnv({}, async () => {
      setSelf(BOT.login);
      const api = fakeApi({ open: (label) => (label === "factory:objective" ? [issue(["factory:objective", RESTART_LABEL, ...labels])] : []), jobs, timeline: () => [{ event: "labeled", label: { name: RESTART_LABEL }, created_at: ago(restartAgo) }] });
      try {
        const r = await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
        return { r, writes: api.writes };
      } finally {
        api.restore();
        setSelf(null);
      }
    });
  // Running with its work job alive: held, nothing discarded.
  const live = await run(["factory:running"], { jobs: [{ name: "work (7)", status: "in_progress" }] });
  assert.deepEqual(live.r.restarted, [], JSON.stringify(live.r.skipped));
  assert.deepEqual(live.r.ready, []);
  assert.ok(live.r.skipped.some((s) => s.number === 7), "Running: not picked");
  assert.ok(!live.writes.some((w) => w.includes("/pulls/70") || w.includes("git/refs")), "nothing of the earlier run is touched while its stage runs");
  // A stage that has not stopped long after the label is taken for gone.
  const stuck = await run(["factory:running"], { jobs: [{ name: "work (7)", status: "in_progress" }], restartAgo: 11 * 60_000 });
  assert.deepEqual(stuck.r.restarted, [7]);
  // In review, Blocked, a Question, Queued: restarted at once, and picked from the default branch in the same tick.
  for (const state of [["factory:in-review"], ["factory:blocked"], ["factory:question"], []]) {
    const t = await run(state);
    assert.deepEqual(t.r.restarted, [7], state.join() || "queued");
    assert.deepEqual(t.r.ready, [7], `${state.join() || "queued"}: picked after the restart`);
    assert.ok(t.writes.includes("PATCH /pulls/70 closed") && t.writes.includes("DELETE /git/refs/heads/factory/7"));
    assert.ok(t.writes.indexOf("DELETE /issues/7/labels/factory:restart") < t.writes.indexOf("POST /issues/7/labels"), "Running again only after the restart is done");
  }
});

test("setup creates factory:restart, and applying it ticks the dispatcher on every route", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { LABELS, renderWorkflow } = await import("../scripts/setup.mjs");
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  assert.ok(LABELS.some(([name]) => name === RESTART_LABEL));
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  for (const v of [values, { ...values, sandbox: "vercel", default_branch: "main" }]) {
    const wf = parseYaml(renderWorkflow(template, v));
    assert.ok(wf.on.issues.types.includes("labeled"));
    assert.match(wf.jobs.dispatch.if, /github\.event\.action == 'labeled' && github\.event\.label\.name == 'factory:restart'/);
  }
});
