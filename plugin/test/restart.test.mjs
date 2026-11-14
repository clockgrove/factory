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

/**
 * A fetch fake: one Objective (#7, `labels`) with an open PR (#70, in the merge queue), its branch at HEAD7 (a ruleset
 * keeps it with `keepBranch`), a plan comment and a split record. `timeline(n)` its label events; `jobs` live Actions jobs.
 */
const HEAD7 = "7".repeat(40);
function fakeApi({ open = () => [], labels = ["factory:objective", RESTART_LABEL], pr = { number: 70, draft: false, node_id: "PR_70", state: "open", mergeable_state: "clean", head: { sha: "a".repeat(40), ref: "factory/7" }, base: { ref: "main" }, labels: [] }, queued = true, comments = null, timeline = () => [], jobs = [], keepBranch = false, writers = ["maintainer"] } = {}) {
  const writes = [];
  const reads = [];
  const state = { labels: new Set(labels), branch: HEAD7, prOpen: !!pr, comments: comments ?? [{ id: 11, user: BOT, created_at: "2031-03-02T01:05:00Z", body: "<!-- factory:7:plan -->\n## Plan\n- [ ] old item" }, { id: 12, user: BOT, created_at: "2031-03-02T01:40:00Z", body: '<!-- factory:7:parts {"prs":[70],"remaining":2} -->\nparts' }] };
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
    if (method === "GET") reads.push(path);
    if (method !== "GET") writes.push(`${method} ${path}${method === "PATCH" && body?.body ? ` ${body.body.split("\n")[0]}` : method === "PATCH" && body?.state ? ` ${body.state}` : method === "POST" && body?.body ? ` ${body.body.split("\n")[0]}` : ""}`);
    if (method === "GET" && path === "/issues") return json(u.searchParams.get("state") === "closed" ? [] : open(u.searchParams.get("labels")));
    if (method === "GET" && path === "/issues/7") return json({ number: 7, state: "open", comments: state.comments.length, labels: [...state.labels].map((name) => ({ name })) });
    if (method === "DELETE" && path.startsWith("/issues/7/labels/")) {
      state.labels.delete(path.slice("/issues/7/labels/".length));
      return json([]);
    }
    if (method === "POST" && path === "/issues/7/labels") {
      for (const l of body.labels) state.labels.add(l);
      return json([]);
    }
    if (method === "GET" && path === "/git/ref/heads/factory/7") return state.branch ? json({ object: { sha: state.branch } }) : json({ message: "Not Found" }, 404);
    if (method === "DELETE" && path === "/git/refs/heads/factory/7") {
      if (keepBranch) return json({ message: "Cannot delete this protected branch" }, 422);
      state.branch = null;
      return json({}, 200);
    }
    if (method === "GET" && path === "/pulls") return json(pr && state.prOpen && u.searchParams.get("head") === "acme:factory/7" ? [pr] : []);
    if (method === "GET" && path === "/pulls/70") return json(pr);
    if (method === "PATCH" && path === "/pulls/70") {
      state.prOpen = false;
      return json({});
    }
    if (method === "GET" && /^\/issues\/7\/comments$/.test(path)) return json(state.comments);
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path)) return json([]);
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(path)) return json(timeline(Number(/issues\/(\d+)\//.exec(path)[1])));
    if (method === "GET" && path.endsWith("/collaborators")) return json(writers.map((login) => ({ login })));
    if (method === "GET" && /^\/collaborators\/[^/]+\/permission$/.test(path)) return json({ permission: "read" });
    if (method === "GET" && path === "/actions/artifacts") return json({ artifacts: [] });
    if (method === "GET" && path === "/issues/comments") return json([]);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(path)) return json({ workflow_runs: u.searchParams.get("status") === "in_progress" && jobs.length ? [{ id: 5 }] : [] });
    if (method === "GET" && path === "/actions/runs/5/jobs") return json({ jobs });
    if (method === "PATCH" && /^\/issues\/comments\/\d+$/.test(path)) {
      const c = state.comments.find((x) => x.id === Number(path.split("/").pop()));
      if (c) c.body = body.body;
      return json(c || {});
    }
    if (method === "POST" && /^\/issues\/7\/comments$/.test(path)) {
      const c = { id: 100 + state.comments.length, html_url: "https://github.test/acme/app/issues/7#issuecomment-99", user: BOT, created_at: new Date().toISOString(), body: body.body };
      state.comments.push(c);
      return json(c);
    }
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path)) return json({ id: 99, user: BOT, body: body.body });
    if (method === "DELETE" || method === "POST" || method === "PATCH") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { writes, reads, state, restore: () => (globalThis.fetch = realFetch) };
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
        const r = await restartObjective(REPO, 7, { at: AT, by: "maintainer", project: null }, { token: "t" });
        assert.deepEqual(r, { pr: 70, head: HEAD7, finished: true });
        assert.deepEqual(api.writes, [
          `POST /issues/7/comments ${restartMarker(7, AT)}`,
          "dequeue PR_70",
          "DELETE /issues/70/labels/factory:review",
          "DELETE /git/refs/heads/factory/7",
          "POST /issues/70/comments <!-- factory:7:restarted:20310302T020000Z -->",
          "PATCH /pulls/70 closed",
          "PATCH /issues/comments/11 <!-- factory:7:restarted-plan -->",
          'PATCH /issues/comments/12 <!-- factory:7:restarted-parts {"prs":[70],"remaining":2} -->',
          "DELETE /issues/7/labels/factory:running",
          "DELETE /issues/7/labels/factory:blocked",
          "DELETE /issues/7/labels/factory:question",
          "DELETE /issues/7/labels/factory:in-review",
          "DELETE /issues/7/labels/factory:restart",
        ]);
        // The record names who, the earlier PR and the deleted branch's last commit (to restore it).
        const record = api.state.comments.find((c) => c.body.startsWith(restartMarker(7, AT)));
        assert.match(record.body, new RegExp(`"by":"maintainer","pr":70,"head":"${HEAD7}"`));
        assert.match(record.body, new RegExp(`git push origin ${HEAD7}:refs/heads/factory/7`));
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
      const api = fakeApi({ labels: ["factory:objective", RESTART_LABEL, ...labels], open: (label) => (label === "factory:objective" ? [issue(["factory:objective", RESTART_LABEL, ...labels])] : []), jobs, timeline: () => [{ event: "labeled", label: { name: RESTART_LABEL }, actor: { login: "maintainer", type: "User" }, created_at: ago(restartAgo) }] });
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


/** One dispatcher tick over #7 with `labels` and a restart applied `restartAgo` ms ago by `by`. */
async function tick({ labels, jobs = [], restartAgo = 60_000, by = "maintainer", keepBranch = false } = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  return withEnv({}, async () => {
    setSelf(BOT.login);
    const all = ["factory:objective", RESTART_LABEL, ...labels];
    const api = fakeApi({ labels: all, keepBranch, open: (label) => (label === "factory:objective" ? [issue(all)] : []), jobs, timeline: () => [{ event: "labeled", label: { name: RESTART_LABEL }, actor: { login: by, type: "User" }, created_at: ago(restartAgo) }] });
    try {
      const r = await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60, autoMerge: true }, { token: "t" });
      return { r, writes: api.writes, reads: api.reads, state: api.state };
    } finally {
      api.restore();
      setSelf(null);
    }
  });
}

test("restart while a stage runs in any state: a review's answer pass on a Question, a Blocked one's job: held, nothing discarded", async () => {
  for (const [labels, job] of [[["factory:question"], "review (factory/7)"], [["factory:blocked"], "work (7)"], [["factory:in-review"], "review (factory/7)"]]) {
    const t = await tick({ labels, jobs: [{ name: job, status: "in_progress" }] });
    assert.deepEqual(t.r.restarted, [], labels.join());
    assert.ok(!t.writes.some((w) => w.includes("/pulls/70") || w.includes("git/refs")), `${labels.join()}: nothing of the earlier run touched`);
    assert.equal(t.state.branch, HEAD7);
  }
});

test("a held restart is out of the merge pass: its PR is not read for a merge, an update or a send-back", async () => {
  const t = await tick({ labels: ["factory:in-review"], jobs: [{ name: "review (factory/7)", status: "in_progress" }] });
  assert.deepEqual(t.r.restarted, []);
  assert.ok(!t.reads.includes("/pulls/70"), t.reads.join("\n"));
  assert.deepEqual(t.r.merged, []);
});

test("a branch a ruleset keeps: the restart Blocks with the fix, its label off, the earlier PR open and the branch where it was", async () => {
  const t = await tick({ labels: ["factory:in-review"], keepBranch: true });
  assert.deepEqual(t.r.restarted, []);
  assert.equal(t.state.branch, HEAD7);
  assert.equal(t.state.prOpen, true, "the PR is not closed");
  assert.ok(!t.writes.includes("PATCH /pulls/70 closed"));
  assert.ok(t.writes.some((w) => w.startsWith("POST /issues/7/comments <!-- factory:7:blocked")), t.writes.join("\n"));
  assert.ok(t.state.labels.has("factory:blocked") && !t.state.labels.has(RESTART_LABEL));
  assert.deepEqual(t.r.ready, []);
});

test("a restart label applied by someone who cannot push is taken off with a comment, and nothing restarts", async () => {
  const t = await tick({ labels: ["factory:in-review"], by: "stranger" });
  assert.deepEqual(t.r.restarted, []);
  assert.ok(!t.state.labels.has(RESTART_LABEL));
  assert.ok(t.writes.some((w) => w.startsWith("POST /issues/7/comments <!-- factory:7:restart-refused")));
  assert.equal(t.state.branch, HEAD7);
  assert.equal(t.state.prOpen, true);
});

test("a retry of a restart keeps what the first try recorded (the PR, the branch's head), and another loop's finished restart is left alone", async () => {
  setSelf(BOT.login);
  try {
    await withEnv({}, async () => {
      // The first try closed the PR and deleted the branch, then was cut off.
      const first = { id: 50, user: BOT, created_at: "2031-03-02T02:01:00Z", body: `${restartMarker(7, AT)}\n${restartRecord({ issue: 7, at: AT, by: "maintainer", pr: 70, head: HEAD7 })}` };
      const api = fakeApi({ comments: [first] });
      api.state.prOpen = false;
      api.state.branch = null;
      try {
        await restartObjective(REPO, 7, { at: AT, project: null }, { token: "t" });
        assert.match(first.body, new RegExp(`"by":"maintainer","pr":70,"head":"${HEAD7}"`), first.body);
      } finally {
        api.restore();
      }
      // Another loop finished it (the label is off): its Running label stays.
      const other = fakeApi({ labels: ["factory:objective", "factory:running"] });
      try {
        const r = await restartObjective(REPO, 7, { at: AT, project: null }, { token: "t" });
        assert.equal(r.finished, false);
        assert.ok(!other.writes.some((w) => w.startsWith("DELETE /issues/7/labels/")), other.writes.join("\n"));
      } finally {
        other.restore();
      }
    });
  } finally {
    setSelf(null);
  }
});

test("readers after a restart: a plan comment or a split record from before it is no one's any more, whoever wrote it", async () => {
  const { planOf } = await import("../scripts/lib/handoff.mjs");
  setSelf(BOT.login);
  try {
    const otherApp = { id: 30, user: { login: "other-app[bot]", type: "Bot" }, created_at: "2031-03-02T01:00:00Z", body: "<!-- factory:7:plan -->\n## Plan" };
    assert.ok(planOf([otherApp], 7), "without a restart another App's plan comment gives its time");
    assert.equal(planOf([otherApp, recordComment()], 7), null);
    const newPlan = { id: 31, user: BOT, created_at: "2031-03-02T03:00:00Z", body: "<!-- factory:7:plan -->\n## New plan" };
    assert.equal(planOf([otherApp, recordComment(), newPlan], 7).id, 31);
    await withEnv({}, async () => {
      const api = fakeApi({ comments: [{ id: 12, user: BOT, created_at: "2031-03-02T01:40:00Z", body: '<!-- factory:7:parts {"prs":[70],"remaining":2} -->\nparts' }, recordComment()] });
      try {
        assert.equal(await partsRecord(REPO, 7, { token: "t" }), null);
      } finally {
        api.restore();
      }
    });
  } finally {
    setSelf(null);
  }
  const { EDITED_FIX } = await import("../scripts/lib/objective-trust.mjs");
  assert.match(EDITED_FIX, /factory:restart/);
});

test("a stage that missed the restart's label learns of it from a record newer than the ones it started with, whatever its clock", async () => {
  const { objectiveReader } = await import("../scripts/lib/stop.mjs");
  setSelf(BOT.login);
  try {
    let lists = 0;
    const comments = [recordComment()];
    const reader = () => objectiveReader({ read: async () => ({ ...issue(["factory:objective"]), comments: comments.length }), list: async () => (lists++, comments) });
    // The restarted run's own stage: the record is there when it starts. On a machine whose clock is behind GitHub's,
    // the record's time is "after" the stage's start, and it still is no restart of this stage.
    const own = reader();
    await own.prime();
    assert.equal(stopCause(await own(), "factory:objective"), null);
    const n = lists;
    await own();
    assert.equal(lists, n, "the comments are read again only when their count changes");
    // A later restart, recorded while the stage runs: it stops.
    comments.push(recordComment(7, "2031-03-02T05:00:00Z"));
    assert.equal(stopCause(await own(), "factory:objective"), "restart");
    // A stage that began before any record learns of the first one.
    const early = objectiveReader({ read: async () => ({ ...issue(["factory:objective"]), comments: 0 }), list: async () => [] });
    await early.prime();
    const later = Object.assign(early, {});
    assert.equal(stopCause(await later(), "factory:objective"), null);
  } finally {
    setSelf(null);
  }
});

test("a refused restart (a branch a ruleset keeps) discards nothing: its record is retired, and the plan, the decisions and the edit gate still read as before it", async () => {
  const { planOf } = await import("../scripts/lib/handoff.mjs");
  const t = await tick({ labels: ["factory:in-review"], keepBranch: true });
  setSelf(BOT.login);
  try {
    assert.equal(restartedAt(t.state.comments), null, "no reader takes the refused restart for one");
    assert.ok(t.state.comments.some((c) => /^<!-- factory:7:restart-undone:/.test(c.body)));
    const decision = { id: 5, user: { login: "maintainer", type: "User" }, created_at: "2031-03-02T00:30:00Z", body: "Keep the old API." };
    assert.deepEqual(maintainerDecisions([decision, ...t.state.comments]).map((d) => d.body), ["Keep the old API."]);
    assert.equal(planOf(t.state.comments, 7)?.id, 11, "the plan comment is still the plan");
  } finally {
    setSelf(null);
  }
});

test("a permission read that fails for now holds the restart for the next tick: no refusal, the label stays", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  await withEnv({}, async () => {
    setSelf(BOT.login);
    const all = ["factory:objective", RESTART_LABEL, "factory:in-review"];
    const api = fakeApi({ labels: all, writers: [], open: (label) => (label === "factory:objective" ? [issue(all)] : []), timeline: () => [{ event: "labeled", label: { name: RESTART_LABEL }, actor: { login: "newcomer", type: "User" }, created_at: new Date(Date.now() - 60_000).toISOString() }] });
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => (/\/collaborators\/newcomer\/permission$/.test(new URL(url).pathname) ? new Response('{"message":"bad gateway"}', { status: 502, headers: { "content-type": "application/json" } }) : real(url, init));
    try {
      const r = await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
      assert.deepEqual(r.restarted, []);
      assert.ok(api.state.labels.has(RESTART_LABEL));
      assert.ok(!api.writes.some((w) => w.includes("restart-refused")));
      assert.ok(r.deadlines.some((d) => d.kind === "retry"));
    } finally {
      globalThis.fetch = real;
      api.restore();
      setSelf(null);
    }
  });
});

test("a retry after the branch went (GitHub closed the PR with it) still comments on and closes the PR the record names; a gone label does nothing at all", async () => {
  setSelf(BOT.login);
  try {
    await withEnv({}, async () => {
      const first = { id: 50, user: BOT, created_at: "2031-03-02T02:01:00Z", body: `${restartMarker(7, AT)}\n${restartRecord({ issue: 7, at: AT, by: "maintainer", pr: 70, head: HEAD7 })}` };
      const api = fakeApi({ comments: [first] });
      api.state.prOpen = false;
      api.state.branch = null;
      try {
        await restartObjective(REPO, 7, { at: AT, project: null }, { token: "t" });
        assert.ok(api.writes.includes("POST /issues/70/comments <!-- factory:7:restarted:20310302T020000Z -->"), api.writes.join("\n"));
        assert.ok(api.writes.includes("PATCH /pulls/70 closed"));
      } finally {
        api.restore();
      }
      const gone = fakeApi({ labels: ["factory:objective", "factory:running"] });
      try {
        const r = await restartObjective(REPO, 7, { at: AT, project: null }, { token: "t" });
        assert.equal(r.finished, false);
        assert.deepEqual(gone.writes, [], "nothing written: no record, no PR change, no label");
      } finally {
        gone.restore();
      }
    });
  } finally {
    setSelf(null);
  }
});

test("the merge pass never merges an Objective waiting for its restart, whoever runs it", async () => {
  const { mergeReadyOne } = await import("../scripts/lib/session.mjs");
  await withEnv({}, async () => {
    const api = fakeApi();
    try {
      assert.equal(await mergeReadyOne(REPO, { issue: 7, prNumber: 70, queue: false, objectiveLabel: "factory:objective" }, { token: "t" }), "stopped");
    } finally {
      api.restore();
    }
  });
});
