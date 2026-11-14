// Draft Objectives (#204): an issue with `factory:draft` is never run, on any route, even with `factory:objective` on
// it too: no dispatch, no claim, no spend. Starting one takes the draft label off and applies the Objective label; the
// scorecard's clock starts there.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DRAFT_LABEL, RESTART_LABEL, STOP_GRACE_MS, isDraft, stopCause, stopText, watchObjective } from "../scripts/lib/stop.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { humanActions, labelTime, scoreObjective } from "../../bench/lib/objective.mjs";
import { loadPrices } from "../../bench/lib/cost.mjs";
import { cleanMerge } from "../../bench/test/fixtures/github.mjs";

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "factory:objective";
const issue = (labels, state = "open", number = 7, extra = {}) => ({ number, state, labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" }, ...extra });

test("stopCause: a draft never runs, its Objective label on or not, and a draft label wins over a restart; closed is still closed", () => {
  assert.equal(stopCause(issue([OBJ, DRAFT_LABEL]), OBJ), "draft", "both labels: a draft");
  assert.equal(stopCause(issue([DRAFT_LABEL]), OBJ), "draft");
  assert.equal(stopCause(issue([OBJ, DRAFT_LABEL, RESTART_LABEL]), OBJ), "draft", "a restart waits until the draft is started");
  assert.equal(stopCause(issue([OBJ, DRAFT_LABEL], "closed"), OBJ), "closed");
  assert.equal(stopCause({ state: "open", labels: [OBJ, DRAFT_LABEL] }, OBJ), "draft", "labels as names");
  assert.equal(stopCause(issue([OBJ]), OBJ), null, "started: runs");
  assert.ok(isDraft(issue([DRAFT_LABEL])) && !isDraft(issue([OBJ])));
  assert.equal(stopText("draft"), "`factory:draft` is on it (a draft never runs)");
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

/** A fetch fake over one repository: `issues(label)` lists open issues, `pr(n)` the factory/<n> branch's open PR. */
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
      const n = Number(/factory\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1]);
      const p = pr(n);
      return json(p ? [p] : []);
    }
    const onePr = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(u.pathname);
    if (method === "GET" && onePr) return json({ number: Number(onePr[1]), state: "open", draft: false, node_id: `PR_${onePr[1]}`, mergeable_state: "clean", head: { sha: "a".repeat(40), ref: "factory/7" }, base: { ref: "main" }, labels: [] });
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json(timeline(Number(/issues\/(\d+)\//.exec(u.pathname)[1])));
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (method === "GET" && u.pathname.endsWith("/actions/artifacts")) return json({ artifacts: [] });
    if (method === "GET" && /\/comments$/.test(u.pathname)) return json([]);
    if (method === "DELETE" || method === "POST" || method === "PATCH") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { writes, restore: () => (globalThis.fetch = realFetch) };
}

const withApi = async (env, fn) => {
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

const INPUTS = { repo: "acme/app", objectiveLabel: OBJ, maxConcurrent: 5, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60 };

test("dispatcher: a draft is never picked or restarted, even beside factory:objective, and says why; what it blocks stays blocked", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  // #7 a draft that also carries the Objective label (and a restart); #8 a plain Objective; #9 an Objective blocked by #7.
  const listed = [issue([OBJ, DRAFT_LABEL, RESTART_LABEL], "open", 7), issue([OBJ], "open", 8), issue([OBJ], "open", 9, { body: "Blocked by #7" })];
  const tick = (inputs) =>
    withApi({}, async () => {
      setSelf("factory-app[bot]");
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

test("dispatcher: an Objective made a draft while In review is left a draft PR and Queued at once; a Running one once its stage had time to stop", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  // #7 In review, made a draft just now; #8 Running, made a draft just now; #9 Running, made a draft long ago.
  const open = { [OBJ]: [issue([OBJ, DRAFT_LABEL, "factory:in-review"], "open", 7)], "factory:in-review": [issue([OBJ, DRAFT_LABEL, "factory:in-review"], "open", 7)], "factory:running": [issue([OBJ, DRAFT_LABEL, "factory:running"], "open", 8), issue([DRAFT_LABEL, "factory:running"], "open", 9)] };
  await withApi({}, async () => {
    const api = fakeApi({
      issues: (label) => open[label] || [],
      pr: (n) => (n === 7 || n === 9 ? { number: n * 10, draft: false, node_id: `PR_${n * 10}` } : null),
      timeline: (n) => [{ event: "labeled", label: { name: DRAFT_LABEL }, actor: { login: "maintainer", type: "User" }, created_at: n === 9 ? ago(STOP_GRACE_MS + 60_000) : ago(60_000) }],
    });
    try {
      const r = await dispatch(INPUTS, { token: "t" });
      assert.deepEqual(r.stopped, [7, 9]);
      assert.ok(api.writes.includes("draft PR_70") && api.writes.includes("DELETE /issues/70/labels/factory:review") && api.writes.includes("DELETE /issues/7/labels/factory:in-review"));
      assert.ok(api.writes.includes("draft PR_90") && api.writes.includes("DELETE /issues/9/labels/factory:running"));
      assert.ok(!api.writes.some((w) => /\/issues\/8\//.test(w)), "a stage may still be stopping itself");
      assert.deepEqual(r.ready, []);
    } finally {
      api.restore();
    }
  });
});

test("the merge pass never merges a draft's PR, whoever runs it", async () => {
  const { mergeReadyOne } = await import("../scripts/lib/session.mjs");
  await withApi({}, async () => {
    const api = fakeApi({ issue: (n) => (n === 7 ? issue([OBJ, DRAFT_LABEL, "factory:in-review"]) : null) });
    try {
      assert.equal(await mergeReadyOne(REPO, { issue: 7, prNumber: 70, queue: false, objectiveLabel: OBJ }, { token: "t" }), "stopped");
      assert.ok(!api.writes.some((w) => /merge/.test(w)));
    } finally {
      api.restore();
    }
  });
});

test("the sandbox launcher starts nothing for a draft, whatever the event", async () => {
  const { readContext } = await import("../scripts/launch.mjs");
  await withApi({}, async () => {
    const api = fakeApi({ issue: (n) => (n === 7 ? issue([OBJ, DRAFT_LABEL, "factory:question"]) : null) });
    try {
      for (const kind of ["comment", "swept", "checks", "review"]) {
        const c = await readContext({ repo: REPO, n: 7, ev: { kind, human: true }, inputs: { objectiveLabel: OBJ, maintainers: [], ciChecks: [] }, opts: { token: "t" }, readEventTime: false });
        assert.match(c.skip ?? "", /#7 is a draft \(factory:draft\)/, kind);
      }
      assert.deepEqual(api.writes, []);
    } finally {
      api.restore();
    }
  });
});

test("local mode: `factory run` refuses a draft before any claim; a draft is neither resumed nor reviewed", async () => {
  const { Local, holderId } = await import("../scripts/local.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const ws = mkdtempSync(join(tmpdir(), "draft-ws-"));
  const claimed = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo: REPO, repoFull: "acme/app", opts: { token: "t" }, wf: {}, holder: "this-loop", baseEnv: () => ({ FACTORY_LOCAL_ALL: "1" }), reapHere: () => {}, ws: () => ws, withClaim: async (n) => (claimed.push(n), { exit: "delivered" }) });
  const gh = { getIssue: async () => issue([OBJ, DRAFT_LABEL]), findPr: async () => null };
  await assert.rejects(loop.runIssue(7, { gh, waitMs: 1 }), /#7 is a draft \(factory:draft\), which Factory never runs; start it first/);
  assert.deepEqual(claimed, [], "no claim is taken");
  // Held by a loop of this machine that went away: resumed and reviewed unless a draft.
  const away = holderId(undefined, 2 ** 22 + 7);
  const claim = (n) => ({ id: n, user: { login: "maintainer", type: "User" }, updated_at: new Date(Date.now() - 3600_000).toISOString(), body: `<!-- factory:${n}:local -->\n${claimBody(away, new Date(Date.now() - 3600_000))}` });
  const pull = (n) => ({ number: n * 10, draft: false, head: { ref: `factory/${n}` }, labels: [{ name: "factory:review" }] });
  await withApi({ FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/repos/acme/app/pulls") return json([pull(7), pull(8)]);
      const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(u.pathname);
      if (one) return json(issue(Number(one[1]) === 8 ? [OBJ, DRAFT_LABEL, "factory:in-review"] : [OBJ, "factory:in-review"], "open", Number(one[1])));
      if (u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("labels") === "factory:running" ? [issue([OBJ, DRAFT_LABEL, "factory:running"], "open", 8), issue([OBJ, "factory:running"], "open", 7)] : []);
      if (u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (u.pathname === "/user") return json({ login: "maintainer", type: "User" });
      const comments = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(u.pathname);
      if (comments) return json([claim(Number(comments[1]))]);
      return json([]);
    };
    try {
      assert.deepEqual(await loop.pendingReviews(), [{ issue: 7, pr: 70 }], "#8 is a draft: no review");
      assert.deepEqual(await loop.pausedHere(new Map()), [7], "#8 is a draft: not resumed");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("setup creates factory:draft, and applying or removing it ticks the dispatcher on every route", async () => {
  const { readFileSync } = await import("node:fs");
  const { LABELS, renderWorkflow } = await import("../scripts/setup.mjs");
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  assert.ok(LABELS.some(([name]) => name === DRAFT_LABEL));
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  for (const v of [values, { ...values, sandbox: "vercel", default_branch: "main" }]) {
    const wf = parseYaml(renderWorkflow(template, v));
    assert.ok(wf.on.issues.types.includes("labeled") && wf.on.issues.types.includes("unlabeled"));
    assert.match(wf.jobs.dispatch.if, /github\.event\.label\.name == 'factory:draft'/);
  }
});

test("scorecard: a draft's clock starts when it is started, whatever the order of its two label changes; the start is no human action", () => {
  const prices = loadPrices();
  const by = { login: "maintainer", type: "User" };
  const ev = (event, name, created_at) => ({ event, label: { name }, actor: by, created_at });
  // cleanMerge: the Objective label at 01:00, Running at 01:05, merged 03:30, nothing else from a person.
  const started = (labels) => {
    const c = cleanMerge(42);
    c.issueTimeline = [...labels, ...c.issueTimeline.slice(1)];
    return c;
  };
  const cases = {
    // Filed as a draft with both labels; started by taking the draft label off.
    "draft label removed": [ev("labeled", DRAFT_LABEL, "2031-03-02T00:30:00Z"), ev("labeled", OBJ, "2031-03-02T00:30:00Z"), ev("unlabeled", DRAFT_LABEL, "2031-03-02T01:04:00Z")],
    // Filed as a draft only; started with the Objective label first, the draft label a few seconds later.
    "label, then draft off": [ev("labeled", DRAFT_LABEL, "2031-03-02T00:30:00Z"), ev("labeled", OBJ, "2031-03-02T01:03:55Z"), ev("unlabeled", DRAFT_LABEL, "2031-03-02T01:04:00Z")],
    // The start skill on a draft with both labels: both off, then the Objective label on again.
    "both off, label on": [ev("labeled", DRAFT_LABEL, "2031-03-02T00:30:00Z"), ev("labeled", OBJ, "2031-03-02T00:30:00Z"), ev("unlabeled", OBJ, "2031-03-02T01:03:58Z"), ev("unlabeled", DRAFT_LABEL, "2031-03-02T01:03:59Z"), ev("labeled", OBJ, "2031-03-02T01:04:00Z")],
  };
  for (const [name, labels] of Object.entries(cases)) {
    const c = started(labels);
    assert.equal(labelTime(c.issue, c.issueTimeline), "2031-03-02T01:04:00Z", name);
    assert.deepEqual(humanActions(c, labelTime(c.issue, c.issueTimeline)), [], name);
    assert.equal(scoreObjective(c, { prices, now: "2031-03-05T00:00:00Z" }).walkAway.value, true, name);
  }
  // No draft label ever: the clock is the first label, as before; a later relabel before Running is still input.
  const plain = started([ev("labeled", OBJ, "2031-03-02T01:00:00Z"), ev("unlabeled", OBJ, "2031-03-02T01:02:00Z"), ev("labeled", OBJ, "2031-03-02T01:03:00Z")]);
  assert.equal(labelTime(plain.issue, plain.issueTimeline), "2031-03-02T01:00:00Z");
});
