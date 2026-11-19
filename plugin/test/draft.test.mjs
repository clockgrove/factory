// Draft Objectives (#204): an issue with `pendulum:draft` is never run, on any route, even with `pendulum:objective` on
// it too: no dispatch, no claim, no spend. Removing Draft starts an admitted Objective and keeps its identity.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DRAFT_LABEL, RESTART_LABEL, isDraft, requeuedIn, restartMarker, restartRecord, stopCause, stopText, watchObjective } from "../scripts/lib/stop.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "pendulum:objective";
const issue = (labels, state = "open", number = 7, extra = {}) => ({ number, state, labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" }, ...extra });

test("stopCause: a draft never runs, its Objective label on or not, and a draft label wins over a restart; closed is still closed", () => {
  assert.equal(stopCause(issue([OBJ, DRAFT_LABEL]), OBJ), "draft", "both labels: a draft");
  assert.equal(stopCause(issue([DRAFT_LABEL]), OBJ), "draft");
  assert.equal(stopCause(issue([OBJ, DRAFT_LABEL, RESTART_LABEL]), OBJ), "draft", "a restart waits until the draft is started");
  assert.equal(stopCause(issue([OBJ, DRAFT_LABEL], "closed"), OBJ), "closed");
  assert.equal(stopCause({ state: "open", labels: [OBJ, DRAFT_LABEL] }, OBJ), "draft", "labels as names");
  assert.equal(stopCause(issue([OBJ]), OBJ), null, "started: runs");
  assert.ok(isDraft(issue([DRAFT_LABEL])) && !isDraft(issue([OBJ])));
  assert.equal(stopText("draft"), "`pendulum:draft` was applied", "no brackets inside the exit line's own: exit: stopped (`pendulum:draft` was applied)");
});

test("a running stage stops when its Objective is made a draft", { timeout: 5000 }, async () => {
  const seen = [];
  await new Promise((done) => {
    const reads = [issue([OBJ]), issue([OBJ, DRAFT_LABEL])];
    let i = 0;
    watchObjective({ read: async () => reads[Math.min(i++, 1)], label: OBJ, everyMs: 5, onStop: (cause) => (seen.push(cause), setTimeout(done, 20)) });
  });
  assert.deepEqual(seen, ["draft"]);
});

/** A fetch fake over one repository: `issues(label)` lists open issues, `pr(n)` the pendulum/<n> branch's open PR. */
function fakeApi({ issues = () => [], pr = () => null, timeline = () => [], issue: one = () => null }) {
  const writes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") {
      if (/convertPullRequestToDraft/.test(body?.query || "")) writes.push(`draft ${body.variables.id}`);
      if (/mergeQueueEntry \{/.test(body?.query || "")) return json({ data: { repository: { pullRequest: { mergeQueueEntry: null } } } });
      return json({ data: {} });
    }
    if (method !== "GET") writes.push(`${method} ${decodeURIComponent(u.pathname).replace("/repos/acme/app", "")}`);
    if (method === "GET" && u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? [] : issues(u.searchParams.get("labels")));
    const single = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(u.pathname);
    if (method === "GET" && single && one(Number(single[1]))) return json(one(Number(single[1])));
    if (method === "GET" && u.pathname === "/repos/acme/app/pulls") {
      const n = Number(/pendulum\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1]);
      const p = pr(n);
      return json(p ? [p] : []);
    }
    const onePr = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(u.pathname);
    if (method === "GET" && onePr) return json({ number: Number(onePr[1]), state: "open", draft: false, node_id: `PR_${onePr[1]}`, mergeable_state: "clean", head: { sha: "a".repeat(40), ref: "pendulum/7" }, base: { ref: "main" }, labels: [] });
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json(timeline(Number(/issues\/(\d+)\//.exec(u.pathname)[1])));
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && u.pathname.endsWith("/collaborators/triager/permission")) return json({ permission: "triage" });
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (method === "GET" && u.pathname.endsWith("/actions/artifacts")) return json({ artifacts: [] });
    if (method === "GET" && /\/comments$/.test(u.pathname)) return json([]);
    if (method === "DELETE" || method === "POST" || method === "PATCH") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { writes, restore: () => (globalThis.fetch = realFetch) };
}

const withApi = async (env, fn) => {
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", ...env });
  for (const k of ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL"]) if (!(k in env)) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const INPUTS = { repo: "acme/app", objectiveLabel: OBJ, maxConcurrent: 5, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60 };

test("dispatcher: a draft is never picked or restarted, even beside pendulum:objective, and says why; what it blocks stays blocked", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  // #7 a draft that also carries the Objective label (and a restart); #8 a plain Objective; #9 an Objective blocked by #7.
  const listed = [issue([OBJ, DRAFT_LABEL, RESTART_LABEL], "open", 7), issue([OBJ], "open", 8), issue([OBJ], "open", 9, { body: "Blocked by #7" })];
  const tick = (inputs) =>
    withApi({}, async () => {
      setSelf("pendulum-app[bot]");
      const api = fakeApi({ issues: (label) => (label === OBJ ? listed : []), timeline: () => [{ event: "labeled", label: { name: RESTART_LABEL }, actor: { login: "maintainer", type: "User" }, created_at: ago(60_000) }] });
      try {
        return { r: await dispatch(inputs, { token: "t" }), writes: api.writes };
      } finally {
        api.restore();
        setSelf(null);
      }
    });
  const t = await tick(INPUTS);
  assert.deepEqual(t.r.ready, [8], JSON.stringify(t.r.skipped));
  assert.deepEqual(t.r.restarted, [], "a draft's restart waits for its start");
  assert.match(t.r.skipped.find((s) => s.number === 7)?.reason ?? "", /draft/);
  assert.match(t.r.skipped.find((s) => s.number === 9)?.reason ?? "", /blocked by #7/, "an Objective a draft blocks is not freed by it");
  assert.ok(!t.writes.some((w) => /\/issues\/7\//.test(w)), `nothing is written on the draft: ${t.writes.join(", ")}`);
  // Named by hand (workflow_dispatch with the issue): still nothing.
  const one = await tick({ ...INPUTS, issue: 7 });
  assert.deepEqual(one.r.ready, []);
  assert.match(one.r.skipped[0].reason, /draft/);
  assert.deepEqual(one.writes, []);
});

test("dispatcher waits for the Draft removal event and starts with Objective identity retained", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const actor = { login: "maintainer", type: "User" };
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const record = (event, name, created_at) => ({ event, label: { name }, actor, created_at });
  // The issue listing already shows Draft off. Its timeline still shows the issue as held for editing.
  const timeline = [record("labeled", OBJ, at(3)), record("labeled", DRAFT_LABEL, at(2))];
  const tick = () => withApi({}, async () => {
    setSelf("pendulum-app[bot]");
    const api = fakeApi({ issues: (label) => (label === OBJ ? [issue([OBJ])] : []), timeline: () => timeline });
    try {
      return { result: await dispatch(INPUTS, { token: "t" }), writes: api.writes };
    } finally {
      api.restore();
      setSelf(null);
    }
  });
  const unread = await tick();
  assert.deepEqual(unread.result.ready, []);
  assert.match(unread.result.skipped[0].reason, /Draft removal is not yet visible/);

  timeline.push(record("unlabeled", DRAFT_LABEL, at(1)));
  const ready = await tick();
  assert.deepEqual(ready.result.ready, [7]);
  assert.ok(!ready.writes.includes(`DELETE /issues/7/labels/${OBJ}`));
});

test("an earlier restart in the same second never authorizes a Draft release", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const maintainer = { login: "maintainer", type: "User" };
  const triager = { login: "triager", type: "User" };
  const release = { id: 13, event: "unlabeled", label: { name: DRAFT_LABEL }, created_at: at, actor: triager };
  const timeline = [
    { id: 10, event: "labeled", label: { name: OBJ }, created_at: at, actor: maintainer },
    { id: 11, event: "commented", created_at: at, actor: { login: "pendulum-app[bot]", type: "Bot" }, body: `${restartMarker(7, at)}\n${restartRecord({ issue: 7, at })}` },
    { ...release, id: 12, event: "labeled", actor: maintainer },
    release,
  ];
  await withApi({}, async () => {
    setSelf("pendulum-app[bot]");
    const api = fakeApi({ issues: (label) => (label === OBJ ? [issue([OBJ])] : []), timeline: () => timeline });
    try {
      const queued = await dispatch(INPUTS, { token: "t" });
      assert.deepEqual(queued.ready, []);
      assert.match(queued.skipped[0].reason, /started by triager/);
      const named = await dispatch({ ...INPUTS, issue: 7 }, { token: "t" });
      assert.deepEqual(named.ready, []);
      assert.match(named.skipped[0].reason, /Draft activation was not authorized/);

      timeline.push({ ...timeline[2], id: 14 }, { ...release, id: 15, actor: maintainer });
      const authorized = await dispatch(INPUTS, { token: "t" });
      assert.deepEqual(authorized.ready, [7]);
    } finally {
      api.restore();
      setSelf(null);
    }
  });
});

test("the merge pass never merges a draft's PR, whoever runs it", async () => {
  const { mergeReadyOne } = await import("../scripts/lib/session.mjs");
  await withApi({}, async () => {
    const api = fakeApi({ issue: (n) => (n === 7 ? issue([OBJ, DRAFT_LABEL, "pendulum:in-review"]) : null) });
    try {
      assert.equal(await mergeReadyOne(REPO, { issue: 7, prNumber: 70, queue: false, objectiveLabel: OBJ }, { token: "t" }), "stopped");
      assert.ok(!api.writes.some((w) => /merge/.test(w)));
    } finally {
      api.restore();
    }
  });
});

test("merge and cloud review wait for a visible and authorized Draft removal", async () => {
  const { launchOne } = await import("../scripts/launch.mjs");
  const { mergeReadyOne } = await import("../scripts/lib/session.mjs");
  const actor = { login: "maintainer", type: "User" };
  const timeline = [
    { event: "labeled", label: { name: OBJ }, created_at: "2026-10-10T10:00:00Z", actor },
    { event: "labeled", label: { name: DRAFT_LABEL }, created_at: "2026-10-10T10:10:00Z", actor },
  ];
  const removeDraft = (minute, by) => ({ event: "unlabeled", label: { name: DRAFT_LABEL }, created_at: `2026-10-10T10:${minute}:00Z`, actor: by });
  await withApi({}, async () => {
    setSelf("pendulum-app[bot]");
    const api = fakeApi({ timeline: (n) => n === 7 ? timeline : [], issue: (n) => n === 7 ? issue([OBJ, "pendulum:in-review"]) : null });
    const merge = () => mergeReadyOne(REPO, { issue: 7, prNumber: 70, queue: false, objectiveLabel: OBJ }, { token: "t" });
    const launch = () => launchOne({
      inputs: { ...INPUTS, appToken: "t" },
      eventName: "pull_request",
      payload: { action: "ready_for_review", sender: actor, pull_request: { number: 70, head: { ref: "pendulum/7", repo: { full_name: REPO.full } } } },
      gate: true,
    });
    try {
      assert.equal(await merge(), "pending");
      assert.match((await launch()).reason, /Draft removal is not yet visible/);
      timeline.push(removeDraft(11, { login: "triager", type: "User" }));
      assert.equal(await merge(), "pending");
      assert.match((await launch()).reason, /Draft activation was not authorized/);
      assert.deepEqual(api.writes, []);

      timeline.push({ ...timeline[1], created_at: "2026-10-10T10:12:00Z" }, removeDraft(13, actor));
      assert.equal(await merge(), "not-recorded", "an authorized removal passes Draft admission to normal merge validation");
      assert.equal((await launch()).exit, "start", "an authorized removal passes Draft admission to the launcher");
    } finally {
      api.restore();
      setSelf(null);
    }
  });
});

test("local mode: `pendulum run` refuses a draft before any claim; a draft is neither resumed nor reviewed", async () => {
  const { Local, holderId } = await import("../scripts/local.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const ws = mkdtempSync(join(tmpdir(), "draft-ws-"));
  const claimed = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo: REPO, repoFull: "acme/app", opts: { token: "t" }, wf: {}, holder: "this-loop", baseEnv: () => ({ PENDULUM_LOCAL_ALL: "1" }), reapHere: () => {}, ws: () => ws, withClaim: async (n) => (claimed.push(n), { exit: "delivered" }) });
  const gh = { getIssue: async () => issue([OBJ, DRAFT_LABEL]), findPr: async () => null };
  await assert.rejects(loop.runIssue(7, { gh, waitMs: 1 }), /#7 is a draft \(pendulum:draft\), which Pendulum never runs; start it first/);
  assert.deepEqual(claimed, [], "no claim is taken");
  // Held by a loop of this machine that went away: resumed and reviewed unless a draft.
  const away = holderId(undefined, 2 ** 22 + 7);
  const claim = (n) => ({ id: n, user: { login: "maintainer", type: "User" }, updated_at: new Date(Date.now() - 3600_000).toISOString(), body: `<!-- pendulum:${n}:local -->\n${claimBody(away, new Date(Date.now() - 3600_000))}` });
  const pull = (n) => ({ number: n * 10, draft: false, head: { ref: `pendulum/${n}` }, labels: [{ name: "pendulum:review" }] });
  await withApi({ PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/repos/acme/app/pulls") return json([pull(7), pull(8)]);
      const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(u.pathname);
      if (one) return json(issue(Number(one[1]) === 8 ? [OBJ, DRAFT_LABEL, "pendulum:in-review"] : [OBJ, "pendulum:in-review"], "open", Number(one[1])));
      if (u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("labels") === "pendulum:running" ? [issue([OBJ, DRAFT_LABEL, "pendulum:running"], "open", 8), issue([OBJ, "pendulum:running"], "open", 7)] : []);
      if (u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (u.pathname === "/user") return json({ login: "maintainer", type: "User" });
      const comments = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(u.pathname);
      if (comments) return json([claim(Number(comments[1]))]);
      return json([]);
    };
    try {
      assert.deepEqual((await loop.pendingReviews()).map(({ issue, pr }) => ({ issue, pr })), [{ issue: 7, pr: 70 }], "#8 is a draft: no review");
      assert.deepEqual(await loop.pausedHere(new Map()), [7], "#8 is a draft: not resumed");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a Blocked or Question Objective made a draft and started by taking the draft label off counts as re-applied, so the dispatcher queues it again", async () => {
  const at = (m) => `2031-03-02T0${m}:00:00Z`;
  const ev = (event, name, t) => ({ event, label: { name }, actor: { login: "maintainer", type: "User" }, created_at: t });
  const run = async (events) => (await requeuedIn(events, OBJ, async () => true)).requeued;
  for (const state of ["pendulum:blocked", "pendulum:question"]) {
    const base = [ev("labeled", OBJ, at(1)), ev("labeled", "pendulum:running", at(2)), ev("labeled", state, at(3)), ev("labeled", DRAFT_LABEL, at(4))];
    assert.equal(await run([...base, ev("unlabeled", DRAFT_LABEL, at(5))]), true, `${state}: started`);
    assert.equal(await run(base), false, `${state}: still a draft`);
  }
  // A draft removal from before the Block is no restart of the Blocked run.
  assert.equal(await run([ev("labeled", DRAFT_LABEL, at(1)), ev("labeled", OBJ, at(1)), ev("unlabeled", DRAFT_LABEL, at(2)), ev("labeled", "pendulum:blocked", at(3))]), false);
  // A state change and a maintainer's recovery can share a second. The timeline records their order.
  const held = [ev("labeled", OBJ, at(1)), ev("labeled", DRAFT_LABEL, at(2))];
  const blocked = ev("labeled", "pendulum:blocked", at(3));
  const activated = ev("unlabeled", DRAFT_LABEL, at(3));
  assert.equal(await run([...held, blocked, activated]), true);
  assert.equal(await run([...held, activated, blocked]), false);
});
