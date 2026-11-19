// A stage lost to a network failure on the Action's runners and the cloud sandbox is relaunched, at most twice since a
// person last started the Objective, then Blocked with the count (#245). Each tick is the real dispatch() against one
// fake GitHub whose labels, timeline and comments persist between ticks, so a count is only what the issue holds.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { blockCauseOf, marker, setSelf } from "../scripts/lib/logic.mjs";
import { applyExit } from "../scripts/lib/session.mjs";
import { RELAUNCH_MAX, relaunchDecision, relaunchRecordOf } from "../scripts/lib/relaunch.mjs";

RETRY.sleep = async () => {};

const SELF = { login: "pendulum-app[bot]", type: "Bot" };
const PERSON = { login: "maintainer", type: "User" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "pendulum:objective";
const MIN = 60_000;

/**
 * One repository on GitHub: issues with labels, their timelines and comments, kept across ticks. `runs` and `jobs`: the
 * workflow's runs (listed newest first within a `created` range, `per_page` at most) and each run's jobs; `spend`: the
 * day's spend comments; `failRecord`: the relaunch record's post fails; `failComments`: the issues whose comment list
 * cannot be read (a network blip, 502); `prs`: an open PR per issue, `{ number, review }` (`review`: when the review
 * label went on, or none); `live`: the runs listed by status (`{ in_progress: [{ id }] }`), whose jobs are `jobs`;
 * `failLive`: how many status listings answer 502 first; `failJobs`: the runs whose jobs cannot be read (502); `fresh`: an
 * issue as a fresh read of it shows it, where the listing is older. `cfg` is read at each request, so a test may change it
 * between ticks.
 */
function fakeGitHub(open, cfg = {}) {
  let last = 0;
  // Every write's time is GitHub's now, and later than the one before it.
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const issues = new Map();
  let ids = 1000;
  for (const { number, labels, since = 30 * MIN, at: given = null, comments = [] } of open) {
    const at = given ?? new Date(Date.now() - since).toISOString();
    issues.set(number, {
      issue: { number, state: "open", body: "", user: { login: "maintainer" }, labels: [...labels] },
      // The label's start, by a person, then each state label as Pendulum applied it.
      timeline: [
        // A Blocked Objective was Running before its Block.
        ...(labels.includes("pendulum:blocked") ? ["labeled", "unlabeled"].map((event) => ({ event, label: { name: "pendulum:running" }, actor: SELF, created_at: new Date(Date.parse(at) - MIN).toISOString() })) : []),
        ...labels.map((name) => ({ event: "labeled", label: { name }, actor: name === OBJ || name === "pendulum:restart" ? PERSON : SELF, created_at: at })),
      ],
      comments: comments.map((c) => ({ id: (ids += 1), user: SELF, created_at: at, updated_at: at, ...c })),
    });
  }
  const writes = [];
  const reads = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const path = decodeURIComponent(u.pathname).replace("/repos/acme/app", "");
    if (u.pathname === "/graphql") return json({ data: {} });
    if (method === "GET") reads.push(`${path}${u.search}`);
    if (method !== "GET") writes.push(`${method} ${path}${body?.body ? ` ${body.body}` : body?.labels ? ` ${body.labels.join(",")}` : ""}`);
    const n = Number(/^\/issues\/(\d+)/.exec(path)?.[1]);
    const one = issues.get(n);
    if (method === "GET" && path === "/issues") {
      if (u.searchParams.get("state") === "closed") return json([]);
      const label = u.searchParams.get("labels");
      return json([...issues.values()].map((i) => i.issue).filter((i) => i.labels.includes(label)).map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })), updated_at: stamp() })));
    }
    if (method === "GET" && /^\/issues\/\d+$/.test(path) && one) {
      const shown = cfg.fresh?.[n] ?? one.issue;
      return json({ ...shown, labels: shown.labels.map((name) => ({ name })) });
    }
    // The timeline carries the comments too, as `commented` events.
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(path) && one)
      return json([...one.timeline, ...one.comments.map((c) => ({ event: "commented", actor: c.user, ...c }))].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)));
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path) && one && cfg.failComments?.includes(n)) return json({ message: "Bad Gateway" }, 502);
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path) && one) return json(one.comments);
    // A PR is an issue too: its timeline holds the review label's start, its comments nothing.
    const pr = Object.entries(cfg.prs || {}).find(([, p]) => p.number === n || p.number === Number(/^\/pulls\/(\d+)$/.exec(path)?.[1]));
    const pull = pr && { number: pr[1].number, state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { ref: `pendulum/${pr[0]}`, sha: "a".repeat(40) }, base: { ref: "main" }, labels: pr[1].review ? [{ name: "pendulum:review" }] : [] };
    if (method === "GET" && pr && /^\/issues\/\d+\/timeline$/.test(path)) return json(pr[1].review ? [{ event: "labeled", label: { name: "pendulum:review" }, actor: SELF, created_at: pr[1].review }] : []);
    if (method === "GET" && pr && /^\/issues\/\d+\/comments$/.test(path)) return json([]);
    if (method === "GET" && pr && /^\/pulls\/\d+$/.test(path)) return json(pull);
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path) && one && cfg.failRecord && body.body.includes(":relaunch -->")) return json({ message: "Bad Gateway" }, 502);
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path) && one) {
      const at = stamp();
      const c = { id: (ids += 1), user: SELF, body: body.body, created_at: at, updated_at: at };
      one.comments.push(c);
      return json(c, 201);
    }
    const edit = /^\/issues\/comments\/(\d+)$/.exec(path);
    if (edit) {
      const c = [...issues.values()].flatMap((i) => i.comments).find((x) => x.id === Number(edit[1]));
      if (!c) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") Object.assign(c, { body: body.body, updated_at: stamp() });
      return json(c);
    }
    if (method === "POST" && /^\/issues\/\d+\/labels$/.test(path) && one) {
      for (const name of body.labels)
        if (!one.issue.labels.includes(name)) {
          one.issue.labels.push(name);
          one.timeline.push({ event: "labeled", label: { name }, actor: SELF, created_at: stamp() });
        }
      return json(one.issue.labels.map((name) => ({ name })));
    }
    const off = /^\/issues\/\d+\/labels\/(.+)$/.exec(path);
    if (method === "DELETE" && off && one) {
      if (!one.issue.labels.includes(off[1])) return json({ message: "Label does not exist" }, 404);
      one.issue.labels = one.issue.labels.filter((l) => l !== off[1]);
      one.timeline.push({ event: "unlabeled", label: { name: off[1] }, actor: SELF, created_at: stamp() });
      return json({});
    }
    if (method === "GET" && path === "/pulls") {
      const head = Number(/:pendulum\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1]);
      const p = cfg.prs?.[head];
      return json(p ? [{ number: p.number, state: "open", head: { ref: `pendulum/${head}` } }] : []);
    }
    if (method === "GET" && path === "/collaborators") return json([{ login: "maintainer" }]);
    if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(path)) {
      const range = u.searchParams.get("created");
      const status = u.searchParams.get("status");
      if (status && cfg.failLive > 0) {
        cfg.failLive -= 1;
        return json({ message: "Bad Gateway" }, 502);
      }
      if (!range) return json({ workflow_runs: cfg.live?.[status] || [] });
      const [from, to] = range.split("..").map((t) => Date.parse(t));
      const hits = (cfg.runs || []).filter((r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) <= to).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return json({ workflow_runs: hits.slice(0, Number(u.searchParams.get("per_page") || 30)) });
    }
    const runJobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (method === "GET" && runJobs && (cfg.failJobs === true || cfg.failJobs?.includes(Number(runJobs[1])))) return json({ message: "Bad Gateway" }, 502);
    if (method === "GET" && runJobs) return json({ jobs: cfg.jobs?.[runJobs[1]] || [] });
    if (method === "GET" && path === "/actions/artifacts") return json({ artifacts: [] });
    // The workflow file (raw) at the commit the test gives it at, only there.
    if (method === "GET" && path === "/contents/.github/workflows/pendulum.yml" && typeof cfg.workflow === "string" && u.searchParams.get("ref") === cfg.workflowSha) return new Response(cfg.workflow, { status: 200 });
    if (method === "GET" && path === "/issues/comments") return json(cfg.spend || []);
    return json({ message: "Not Found" }, 404);
  };
  return {
    fetch,
    writes,
    reads,
    issue: (n) => issues.get(n),
    labels: (n) => [...issues.get(n).issue.labels].sort(),
    /** The Running stints' starts moved `ms` into the past: that long passes with no job or stage showing up. */
    age(ms) {
      for (const i of issues.values()) for (const e of i.timeline) if (e.label?.name === "pendulum:running") e.created_at = new Date(Date.parse(e.created_at) - ms).toISOString();
    },
    /** A person's action: a label applied or taken off. */
    person(n, event, name) {
      const one = issues.get(n);
      if (event === "labeled" && !one.issue.labels.includes(name)) one.issue.labels.push(name);
      if (event === "unlabeled") one.issue.labels = one.issue.labels.filter((l) => l !== name);
      one.timeline.push({ event, label: { name }, actor: PERSON, created_at: stamp() });
    },
    /** Pendulum's Blocked notices on an issue, oldest first. */
    blocks: (n) => issues.get(n).comments.filter((c) => c.body.startsWith(`<!-- pendulum:${n}:blocked:`)),
  };
}

/** Run `fn` with this fake as GitHub, as the Action's dispatcher (or the sandbox route's, with `sandbox`). */
async function on(gh, fn) {
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL", "GITHUB_RUN_ID", "GITHUB_WORKFLOW_REF"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  // The dispatcher's own workflow (github.mjs workflowFile), whatever workflow runs these tests (CI's is quality.yml).
  process.env.GITHUB_WORKFLOW_REF = "acme/app/.github/workflows/pendulum.yml@refs/heads/main";
  delete process.env.PENDULUM_LOCAL;
  delete process.env.PENDULUM_LOCAL_ALL;
  globalThis.fetch = gh.fetch;
  setSelf(SELF.login);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const tick = async (gh, { maxConcurrent = 5, sandbox = undefined, dailyUsd = 0, run = null } = {}) => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  return on(gh, () => {
    // The dispatching run (GITHUB_RUN_ID), which a relaunch records.
    if (run) process.env.GITHUB_RUN_ID = String(run);
    else delete process.env.GITHUB_RUN_ID;
    return dispatch({ repo: REPO.full, objectiveLabel: OBJ, maxConcurrent, dailyUsd, ciChecks: [], timeoutMinutes: 60, notify: "kirk", ...(sandbox ? { sandbox } : {}) }, { token: "t" });
  });
};

/** A stage's own end on its network off the local route (worker.mjs, review.mjs: session.mjs outageExit's Block). */
const outageEnd = (gh, n, run) =>
  on(gh, async () => {
    process.env.GITHUB_RUN_ID = String(run);
    await applyExit(REPO, { issue: n, pr: null, exit: "blocked", reason: "this machine could not reach api.anthropic.com (ENOTFOUND) from 2026-11-14T08:47:00.000Z; the stage waited for the network until its time ran out", cause: "outage", notify: null, stage: "outage" }, { token: "t" });
  });

const recordOf = (gh, n) => {
  setSelf(SELF.login);
  try {
    return relaunchRecordOf(gh.issue(n).comments, n);
  } finally {
    setSelf(null);
  }
};

test("a vanished Running stage is relaunched, and relaunched again, then Blocked with the count; each tick reads the count from the issue", async () => {
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "pendulum:running"], since: 20 * MIN }]);
  for (const k of [1, 2]) {
    const r = await tick(gh);
    assert.deepEqual(r.relaunched, [7], `lost ${k}: relaunched`);
    assert.deepEqual(r.relaunch, [7], "named in the work matrix again");
    assert.deepEqual(r.vanished, [], "no Block yet");
    assert.deepEqual(gh.blocks(7), []);
    assert.deepEqual(gh.labels(7), [OBJ, "pendulum:running"].sort(), "Running again, in its own slot");
    assert.ok(gh.writes.includes("DELETE /issues/7/labels/pendulum:running") && gh.writes.at(-1).startsWith("POST /issues/7/labels pendulum:running"), "a new Running stint: its job gets the start grace again");
    assert.deepEqual(recordOf(gh, 7).tries.map((t) => t.lost), Array(k).fill("vanished"), "the count is on the issue");
    // Inside the new stint's grace the relaunched job is not lost yet: nothing more.
    const young = await tick(gh);
    assert.deepEqual([young.relaunched, young.vanished], [[], []]);
    // Its job never shows up either.
    gh.age(20 * MIN);
  }
  const used = await tick(gh);
  assert.deepEqual(used.relaunched, []);
  assert.deepEqual(used.vanished, [7]);
  const [notice] = gh.blocks(7);
  assert.match(notice.body, /^<!-- pendulum:7:blocked:dispatch:[^]*@kirk Blocked \(dispatch\): worker job vanished: Running with no job in progress; Pendulum relaunched its stage 2 times since the Objective was last started/);
  assert.equal(blockCauseOf(notice.body), "pendulum", "no stage recorded an outage: the vanished cause");
  assert.deepEqual(gh.labels(7), [OBJ, "pendulum:blocked"].sort());
  assert.equal(recordOf(gh, 7).tries.length, RELAUNCH_MAX, "the Block adds no try");
});

test("an outage exit is relaunched, twice, then Blocked once with cause outage and the count, the person mentioned only then", async () => {
  const gh = fakeGitHub([{ number: 8, labels: [OBJ, "pendulum:running"], since: 5 * MIN }]);
  for (const k of [1, 2]) {
    await outageEnd(gh, 8, 100 + k);
    assert.doesNotMatch(gh.blocks(8).at(-1).body, /@kirk/, "the stage's own outage notice mentions no one");
    const r = await tick(gh);
    assert.deepEqual(r.relaunched, [8], `outage ${k}: relaunched`);
    assert.deepEqual(r.relaunch, [8]);
    assert.deepEqual(gh.labels(8), [OBJ, "pendulum:running"].sort());
    assert.deepEqual(recordOf(gh, 8).tries.map((t) => t.lost), Array(k).fill("outage"));
    assert.match(gh.issue(8).comments.find((c) => c.body.startsWith(marker(8, "relaunch"))).body, new RegExp(`relaunched this Objective's stage: ${k} of 2 [^]*ended on its network`));
  }
  await outageEnd(gh, 8, 103);
  const used = await tick(gh);
  assert.deepEqual([used.relaunched, used.relaunchesUsed], [[], [8]]);
  const notice = gh.blocks(8).at(-1);
  assert.match(notice.body, /^<!-- pendulum:8:blocked:relaunch:[^]*@kirk Blocked \(relaunch\): the stage was lost to its network again after Pendulum relaunched it 2 times/);
  assert.equal(blockCauseOf(notice.body), "outage");
  assert.deepEqual(gh.labels(8), [OBJ, "pendulum:blocked"].sort());
  // The next tick finds the dispatcher's notice newest: no second notice, no relaunch.
  const after = await tick(gh);
  assert.deepEqual([after.relaunched, after.relaunchesUsed], [[], []]);
  assert.equal(gh.blocks(8).length, 4);
});

test("a non-network Block is not relaunched: the worker's own, validation, a crash; an outage Block beside them is", async () => {
  const gh = fakeGitHub([
    { number: 8, labels: [OBJ, "pendulum:running"] },
    { number: 9, labels: [OBJ, "pendulum:running"] },
    { number: 10, labels: [OBJ, "pendulum:running"] },
    { number: 11, labels: [OBJ, "pendulum:running"] },
  ]);
  await outageEnd(gh, 8, 201);
  await on(gh, async () => {
    process.env.GITHUB_RUN_ID = "202";
    await applyExit(REPO, { issue: 9, pr: null, exit: "blocked", reason: "the worker's own Block", cause: "work", notify: "kirk", stage: "work" }, { token: "t" });
    await applyExit(REPO, { issue: 10, pr: null, exit: "blocked", reason: "worker crashed: TypeError: x is undefined", cause: "pendulum", notify: "kirk", stage: "crash" }, { token: "t" });
  });
  // #11 ended on an outage once, and a later stage Blocked on its validation: that Block is the one standing.
  await outageEnd(gh, 11, 203);
  await on(gh, async () => {
    process.env.GITHUB_RUN_ID = "204";
    await applyExit(REPO, { issue: 11, pr: null, exit: "blocked", reason: "validation red after Pendulum's last pass", cause: "work", notify: "kirk", stage: "validation" }, { token: "t" });
  });
  const writes = gh.writes.length;
  const reads = gh.reads.length;
  const r = await tick(gh);
  assert.deepEqual(r.relaunched, [8]);
  for (const n of [9, 10, 11]) {
    assert.deepEqual(gh.labels(n), [OBJ, "pendulum:blocked"].sort(), `#${n} stays Blocked`);
    assert.equal(recordOf(gh, n), null);
  }
  assert.ok(gh.writes.slice(writes).every((w) => /\/issues\/8\//.test(w)), "only #8 is written to");
  assert.ok(!gh.reads.slice(reads).some((r) => /^\/issues\/(9|10|11)\/comments(\?|$)/.test(r)), "a Blocked Objective costs the one timeline read the recovery pass makes, no comments read");
});

test("a stopped, draft or restarting Objective is never relaunched; a started one beside them is", async () => {
  const outage = (n) => ({ body: `${marker(n, "blocked", "outage:301-1")}\nBlocked (outage): this machine could not reach api.github.com (EAI_AGAIN)\n<!-- pendulum:block {"cause":"outage"} -->` });
  const gh = fakeGitHub([
    // #20 Running, its stage vanished, but a person took its label off (a stop, inside its grace); #21 Blocked on an
    // outage and stopped; #22 Blocked on an outage and made a draft; #23 Blocked on an outage with a restart applied by
    // someone who can push (it restarts: Queued, not Running); #24 the control.
    { number: 20, labels: [OBJ, "pendulum:running"], since: 30 * MIN },
    { number: 21, labels: [OBJ, "pendulum:blocked"], comments: [outage(21)] },
    { number: 22, labels: [OBJ, "pendulum:blocked"], comments: [outage(22)] },
    { number: 23, labels: [OBJ, "pendulum:blocked", "pendulum:restart"], comments: [outage(23)] },
    { number: 24, labels: [OBJ, "pendulum:blocked"], comments: [outage(24)] },
  ]);
  gh.person(20, "unlabeled", OBJ);
  gh.person(21, "unlabeled", OBJ);
  gh.person(22, "labeled", "pendulum:draft");
  const r = await tick(gh);
  assert.deepEqual(r.relaunched, [24]);
  assert.deepEqual(r.relaunch, [24]);
  for (const n of [20, 21, 22, 23]) assert.equal(recordOf(gh, n), null, `#${n}: no relaunch counted`);
  assert.ok(!gh.labels(21).includes("pendulum:running") && !gh.labels(22).includes("pendulum:running"));
  assert.deepEqual(r.restarted, [23], "the restart runs as before; its card goes back to Queued, not Running");
});

test("relaunch holds Running work until its newest Draft activation can be verified", async () => {
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "pendulum:running"] }]);
  const draft = "pendulum:draft";
  gh.person(7, "labeled", draft);
  gh.person(7, "unlabeled", draft);
  const timeline = gh.issue(7).timeline;
  const removal = timeline.pop();
  assert.deepEqual((await tick(gh)).relaunched, []);
  assert.equal(recordOf(gh, 7), null);

  timeline.push({ ...removal, actor: SELF });
  assert.deepEqual((await tick(gh)).relaunched, []);
  assert.equal(recordOf(gh, 7), null);

  timeline.pop();
  timeline.push(removal);
  assert.deepEqual((await tick(gh)).relaunched, [7]);
});

test("the count survives across ticks and dispatcher restarts, and starts over when a person re-applies the label", async () => {
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "pendulum:running"], since: 20 * MIN }]);
  await tick(gh);
  gh.age(20 * MIN);
  await tick(gh);
  gh.age(20 * MIN);
  // A fresh module load is no fresh count: the dispatcher keeps nothing between ticks.
  const r = await tick(gh);
  assert.deepEqual(r.vanished, [7], "two relaunches already on the issue: Blocked");
  assert.equal(recordOf(gh, 7).tries.length, 2);
  // A person re-applies the label: the Objective is Queued again, picked, and its next loss counts from there.
  gh.person(7, "unlabeled", OBJ);
  gh.person(7, "labeled", OBJ);
  const picked = await tick(gh);
  assert.deepEqual(picked.reset, [7]);
  assert.deepEqual(picked.ready, [7]);
  gh.age(20 * MIN);
  const again = await tick(gh);
  assert.deepEqual(again.relaunched, [7], "relaunched again: the count started over at the label");
  assert.equal(recordOf(gh, 7).tries.length, 3, "the record keeps the earlier tries");
  const [first, , third] = recordOf(gh, 7).tries;
  assert.notEqual(third.start, first.start, "each try names the start it counted against");
  assert.deepEqual(relaunchDecision({ record: recordOf(gh, 7), start: first.start, key: "stint:x", lost: "vanished", at: new Date().toISOString() }), { block: true, tries: 2 }, "against the earlier start, the two tries then");
});

test("max_concurrent: a relaunch takes the slot its stage held, before any new pick; none is taken past the cap", async () => {
  const outage = { body: `${marker(8, "blocked", "outage:401-1")}\nBlocked (outage): lost\n<!-- pendulum:block {"cause":"outage"} -->` };
  const gh = fakeGitHub([
    { number: 8, labels: [OBJ, "pendulum:blocked"], comments: [outage] },
    { number: 9, labels: [OBJ, "P0"] },
  ]);
  const r = await tick(gh, { maxConcurrent: 1 });
  assert.deepEqual(r.relaunched, [8]);
  assert.deepEqual(r.ready, [], "the Queued P0 waits: the relaunch holds the one slot");
  assert.equal(r.running, 1);
  // With the slot taken by another Running Objective (inside its job's grace), the relaunch waits for it.
  const full = fakeGitHub([
    { number: 8, labels: [OBJ, "pendulum:blocked"], comments: [outage] },
    { number: 10, labels: [OBJ, "pendulum:running"], since: MIN },
  ]);
  const waits = await tick(full, { maxConcurrent: 1 });
  assert.deepEqual(waits.relaunched, []);
  assert.deepEqual(full.labels(8), [OBJ, "pendulum:blocked"].sort());
  assert.equal(recordOf(full, 8), null, "nothing counted while it waits");
  const later = await tick(full, { maxConcurrent: 2 });
  assert.deepEqual(later.relaunched, [8]);
});

const outageNotice = (n, extra = {}) => ({ body: `${marker(n, "blocked", "outage:601-1")}\nBlocked (outage): this machine could not reach api.github.com (EAI_AGAIN)\n<!-- pendulum:block {"cause":"outage"} -->`, ...extra });
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test("the cloud sandbox: a sandbox record that cannot be read is no absent record; that Objective waits for the next tick's read (#430)", async () => {
  // #7 Running half an hour with no start recorded; #8 In review, its PR labelled for review half an hour ago with no
  // review start recorded; #9 In review, no review label; #10 Queued. Each one's comments fail to read this tick.
  const cfg = { failComments: [7, 8, 9, 10], prs: { 8: { number: 108, review: ago(30 * MIN) }, 9: { number: 109 } } };
  const gh = fakeGitHub(
    [
      { number: 7, labels: [OBJ, "pendulum:running"], since: 30 * MIN },
      { number: 8, labels: [OBJ, "pendulum:in-review"], since: 40 * MIN },
      { number: 9, labels: [OBJ, "pendulum:in-review"], since: 40 * MIN },
      { number: 10, labels: [OBJ], since: 40 * MIN },
    ],
    cfg,
  );
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...more) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...more));
  let r;
  try {
    r = await tick(gh, { sandbox: "vercel" });
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual([r.relaunch, r.relaunched, r.ready, r.vanished], [[], [], [], []], "nothing relaunched, picked or Blocked");
  assert.deepEqual(gh.writes, [], "nothing written");
  assert.ok(r.deadlines.some((d) => d.kind === "retry"), "read again soon");
  for (const n of [7, 8, 9, 10]) assert.equal(lines.filter((l) => l.includes(`#${n}'s sandbox record unread`)).length, 1, `#${n}'s failed read is named once`);
  assert.equal(r.skipped.find((x) => x.number === 10)?.reason, "its sandbox record could not be read; read again next tick");
  // The next tick reads them: the lost starts are named again and the Queued one is picked.
  cfg.failComments = [];
  const next = await tick(gh, { sandbox: "vercel" });
  assert.deepEqual([next.relaunch, next.ready], [[7, 8], [10]]);
});

test("daily_usd: a lost stage is not relaunched while today's spend has reached the cap; it waits for the day's turn, unblocked", async () => {
  const spend = [{ id: 900, user: SELF, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), body: `<!-- pendulum:9:progress:x -->\n<!-- pendulum:spend {"usd":5} -->` }];
  const open = () => [
    { number: 7, labels: [OBJ, "pendulum:running"], since: 20 * MIN },
    { number: 8, labels: [OBJ, "pendulum:blocked"], comments: [outageNotice(8)] },
  ];
  const gh = fakeGitHub(open(), { spend });
  const r = await tick(gh, { dailyUsd: 1 });
  assert.deepEqual([r.relaunched, r.vanished, r.relaunchesUsed], [[], [], []]);
  assert.ok(r.deadlines.some((d) => d.kind === "daily-cap"), "the day's turn is its wake, as for a Queued pick");
  assert.deepEqual([gh.labels(7), gh.labels(8)], [[OBJ, "pendulum:running"].sort(), [OBJ, "pendulum:blocked"].sort()], "no Block, no relaunch");
  assert.equal(recordOf(gh, 7), null);
  const under = fakeGitHub(open(), { spend });
  assert.deepEqual((await tick(under, { dailyUsd: 10 })).relaunched.sort(), [7, 8]);
});

test("a relaunch whose record cannot be written is tried again next tick, never Blocked, however old the loss", async () => {
  const cfg = { failRecord: true };
  const gh = fakeGitHub(
    [
      { number: 7, labels: [OBJ, "pendulum:running"], since: 120 * MIN },
      { number: 8, labels: [OBJ, "pendulum:blocked"], since: 120 * MIN, comments: [outageNotice(8, { created_at: ago(90 * MIN), updated_at: ago(90 * MIN) })] },
    ],
    cfg,
  );
  const r = await tick(gh);
  assert.deepEqual([r.relaunched, r.relaunchesUsed, r.vanished], [[], [], []]);
  assert.deepEqual([gh.blocks(7).length, gh.blocks(8).length], [0, 1], "no Block: a failed write is no evidence of anything");
  assert.ok(r.deadlines.some((d) => d.kind === "retry"));
  cfg.failRecord = false;
  assert.deepEqual((await tick(gh)).relaunched.sort(), [7, 8]);
});


test("a work job cancelled inside its grace is Blocked on the next tick, and its slot starts the next Objective (#528)", async () => {
  const since = MIN;
  // Its job, made just after the label and cancelled a minute in, as the release check's was.
  const cancelled = { name: "work (7)", status: "completed", conclusion: "cancelled", created_at: ago(since - 6_000), completed_at: ago(10_000) };
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "pendulum:running"], since }, { number: 8, labels: [OBJ] }], { runs: [{ id: 55, created_at: ago(since + 10_000) }], jobs: { 55: [cancelled] } });
  const r = await tick(gh, { maxConcurrent: 1 });
  assert.deepEqual([r.vanished, r.relaunched, r.ready], [[7], [], [8]], "#7 Blocked at once; #8 takes the one slot");
  assert.deepEqual(gh.labels(7), [OBJ, "pendulum:blocked"].sort());
  assert.match(gh.blocks(7)[0].body, /worker job vanished: its work job was cancelled \(a person, or its timeout\); a stop, so it was not relaunched/);
  assert.equal(gh.reads.filter((p) => /^\/actions\/runs\/\d+\/jobs/.test(p)).length, 1, "one jobs read for #7: the grace's, reused by the relaunch decision");
});
