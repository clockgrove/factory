// A stage lost to a network failure on the Action's runners and the cloud sandbox is relaunched, at most twice since a
// person last started the Objective, then Blocked with the count (#245). Each tick is the real dispatch() against one
// fake GitHub whose labels, timeline and comments persist between ticks, so a count is only what the issue holds.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { blockCauseOf, marker, sandboxMarkerLine, setSelf } from "../scripts/lib/logic.mjs";
import { applyExit } from "../scripts/lib/session.mjs";
import { setStateLabel } from "../scripts/lib/github.mjs";
import { RELAUNCH_MAX, relaunchDecision, relaunchRecordOf } from "../scripts/lib/relaunch.mjs";

RETRY.sleep = async () => {};

const SELF = { login: "factory-app[bot]", type: "Bot" };
const PERSON = { login: "maintainer", type: "User" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "factory:objective";
const MIN = 60_000;

/**
 * One repository on GitHub: issues with labels, their timelines and comments, kept across ticks. `runs` and `jobs`: the
 * workflow's runs (listed by creation time) and each run's jobs; `spend`: the day's spend comments; `failRecord`: the
 * relaunch record's post fails.
 */
function fakeGitHub(open, { runs = [], jobs = {}, spend = [], failRecord = false } = {}) {
  let last = 0;
  // Every write's time is GitHub's now, and later than the one before it.
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const issues = new Map();
  let ids = 1000;
  for (const { number, labels, since = 30 * MIN, at: given = null, comments = [] } of open) {
    const at = given ?? new Date(Date.now() - since).toISOString();
    issues.set(number, {
      issue: { number, state: "open", body: "", user: { login: "maintainer" }, labels: [...labels] },
      // The label's start, by a person, then each state label as Factory applied it.
      timeline: [
        // A Blocked Objective was Running before its Block.
        ...(labels.includes("factory:blocked") ? ["labeled", "unlabeled"].map((event) => ({ event, label: { name: "factory:running" }, actor: SELF, created_at: new Date(Date.parse(at) - MIN).toISOString() })) : []),
        ...labels.map((name) => ({ event: "labeled", label: { name }, actor: name === OBJ || name === "factory:restart" ? PERSON : SELF, created_at: at })),
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
    if (method === "GET") reads.push(path);
    if (method !== "GET") writes.push(`${method} ${path}${body?.body ? ` ${body.body}` : body?.labels ? ` ${body.labels.join(",")}` : ""}`);
    const n = Number(/^\/issues\/(\d+)/.exec(path)?.[1]);
    const one = issues.get(n);
    if (method === "GET" && path === "/issues") {
      if (u.searchParams.get("state") === "closed") return json([]);
      const label = u.searchParams.get("labels");
      return json([...issues.values()].map((i) => i.issue).filter((i) => i.labels.includes(label)).map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })), updated_at: stamp() })));
    }
    if (method === "GET" && /^\/issues\/\d+$/.test(path) && one) return json({ ...one.issue, labels: one.issue.labels.map((name) => ({ name })) });
    // The timeline carries the comments too, as `commented` events.
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(path) && one)
      return json([...one.timeline, ...one.comments.map((c) => ({ event: "commented", actor: c.user, ...c }))].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)));
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path) && one) return json(one.comments);
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path) && one && failRecord && body.body.includes(":relaunch -->")) return json({ message: "Bad Gateway" }, 502);
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
    if (method === "GET" && path === "/pulls") return json([]);
    if (method === "GET" && path === "/collaborators") return json([{ login: "maintainer" }]);
    if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(path)) return json({ workflow_runs: u.searchParams.get("created") ? runs : [] });
    const runJobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (method === "GET" && runJobs) return json({ jobs: jobs[runJobs[1]] || [] });
    if (method === "GET" && path === "/actions/artifacts") return json({ artifacts: [] });
    if (method === "GET" && path === "/issues/comments") return json(spend);
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
      for (const i of issues.values()) for (const e of i.timeline) if (e.label?.name === "factory:running") e.created_at = new Date(Date.parse(e.created_at) - ms).toISOString();
    },
    /** A person's action: a label applied or taken off. */
    person(n, event, name) {
      const one = issues.get(n);
      if (event === "labeled" && !one.issue.labels.includes(name)) one.issue.labels.push(name);
      if (event === "unlabeled") one.issue.labels = one.issue.labels.filter((l) => l !== name);
      one.timeline.push({ event, label: { name }, actor: PERSON, created_at: stamp() });
    },
    /** Factory's Blocked notices on an issue, oldest first. */
    blocks: (n) => issues.get(n).comments.filter((c) => c.body.startsWith(`<!-- factory:${n}:blocked:`)),
  };
}

/** Run `fn` with this fake as GitHub, as the Action's dispatcher (or the sandbox route's, with `sandbox`). */
async function on(gh, fn) {
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL", "GITHUB_RUN_ID"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.FACTORY_LOCAL;
  delete process.env.FACTORY_LOCAL_ALL;
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

const tick = async (gh, { maxConcurrent = 5, sandbox = undefined, dailyUsd = 0 } = {}) => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  return on(gh, () => dispatch({ repo: REPO.full, objectiveLabel: OBJ, maxConcurrent, dailyUsd, ciChecks: [], timeoutMinutes: 60, notify: "kirk", ...(sandbox ? { sandbox } : {}) }, { token: "t" }));
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
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "factory:running"], since: 20 * MIN }]);
  for (const k of [1, 2]) {
    const r = await tick(gh);
    assert.deepEqual(r.relaunched, [7], `lost ${k}: relaunched`);
    assert.deepEqual(r.relaunch, [7], "named in the work matrix again");
    assert.deepEqual(r.vanished, [], "no Block yet");
    assert.deepEqual(gh.blocks(7), []);
    assert.deepEqual(gh.labels(7), [OBJ, "factory:running"].sort(), "Running again, in its own slot");
    assert.ok(gh.writes.includes("DELETE /issues/7/labels/factory:running") && gh.writes.at(-1).startsWith("POST /issues/7/labels factory:running"), "a new Running stint: its job gets the start grace again");
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
  assert.match(notice.body, /^<!-- factory:7:blocked:dispatch:[^]*@kirk Blocked \(dispatch\): worker job vanished: Running with no job in progress; Factory relaunched its stage 2 times since the Objective was last started/);
  assert.equal(blockCauseOf(notice.body), "factory", "no stage recorded an outage: the vanished cause");
  assert.deepEqual(gh.labels(7), [OBJ, "factory:blocked"].sort());
  assert.equal(recordOf(gh, 7).tries.length, RELAUNCH_MAX, "the Block adds no try");
});

test("an outage exit is relaunched, twice, then Blocked once with cause outage and the count, the person mentioned only then", async () => {
  const gh = fakeGitHub([{ number: 8, labels: [OBJ, "factory:running"], since: 5 * MIN }]);
  for (const k of [1, 2]) {
    await outageEnd(gh, 8, 100 + k);
    assert.doesNotMatch(gh.blocks(8).at(-1).body, /@kirk/, "the stage's own outage notice mentions no one");
    const r = await tick(gh);
    assert.deepEqual(r.relaunched, [8], `outage ${k}: relaunched`);
    assert.deepEqual(r.relaunch, [8]);
    assert.deepEqual(gh.labels(8), [OBJ, "factory:running"].sort());
    assert.deepEqual(recordOf(gh, 8).tries.map((t) => t.lost), Array(k).fill("outage"));
    assert.match(gh.issue(8).comments.find((c) => c.body.startsWith(marker(8, "relaunch"))).body, new RegExp(`relaunched this Objective's stage: ${k} of 2 [^]*ended on its network`));
  }
  await outageEnd(gh, 8, 103);
  const used = await tick(gh);
  assert.deepEqual([used.relaunched, used.relaunchesUsed], [[], [8]]);
  const notice = gh.blocks(8).at(-1);
  assert.match(notice.body, /^<!-- factory:8:blocked:relaunch:[^]*@kirk Blocked \(relaunch\): the stage was lost to its network again after Factory relaunched it 2 times/);
  assert.equal(blockCauseOf(notice.body), "outage");
  assert.deepEqual(gh.labels(8), [OBJ, "factory:blocked"].sort());
  // The next tick finds the dispatcher's notice newest: no second notice, no relaunch.
  const after = await tick(gh);
  assert.deepEqual([after.relaunched, after.relaunchesUsed], [[], []]);
  assert.equal(gh.blocks(8).length, 4);
});

test("a non-network Block is not relaunched: the worker's own, validation, a crash; an outage Block beside them is", async () => {
  const gh = fakeGitHub([
    { number: 8, labels: [OBJ, "factory:running"] },
    { number: 9, labels: [OBJ, "factory:running"] },
    { number: 10, labels: [OBJ, "factory:running"] },
    { number: 11, labels: [OBJ, "factory:running"] },
  ]);
  await outageEnd(gh, 8, 201);
  await on(gh, async () => {
    process.env.GITHUB_RUN_ID = "202";
    await applyExit(REPO, { issue: 9, pr: null, exit: "blocked", reason: "the worker's own Block", cause: "work", notify: "kirk", stage: "work" }, { token: "t" });
    await applyExit(REPO, { issue: 10, pr: null, exit: "blocked", reason: "worker crashed: TypeError: x is undefined", cause: "factory", notify: "kirk", stage: "crash" }, { token: "t" });
  });
  // #11 ended on an outage once, and a later stage Blocked on its validation: that Block is the one standing.
  await outageEnd(gh, 11, 203);
  await on(gh, async () => {
    process.env.GITHUB_RUN_ID = "204";
    await applyExit(REPO, { issue: 11, pr: null, exit: "blocked", reason: "validation red after Factory's last pass", cause: "work", notify: "kirk", stage: "validation" }, { token: "t" });
  });
  const writes = gh.writes.length;
  const reads = gh.reads.length;
  const r = await tick(gh);
  assert.deepEqual(r.relaunched, [8]);
  for (const n of [9, 10, 11]) {
    assert.deepEqual(gh.labels(n), [OBJ, "factory:blocked"].sort(), `#${n} stays Blocked`);
    assert.equal(recordOf(gh, n), null);
  }
  assert.ok(gh.writes.slice(writes).every((w) => /\/issues\/8\//.test(w)), "only #8 is written to");
  assert.ok(!gh.reads.slice(reads).some((r) => /^\/issues\/(9|10|11)\/comments$/.test(r)), "a Blocked Objective costs the one timeline read the recovery pass makes, no comments read");
});

test("a stopped, draft or restarting Objective is never relaunched; a started one beside them is", async () => {
  const outage = (n) => ({ body: `${marker(n, "blocked", "outage:301-1")}\nBlocked (outage): this machine could not reach api.github.com (EAI_AGAIN)\n<!-- factory:block {"cause":"outage"} -->` });
  const gh = fakeGitHub([
    // #20 Running, its stage vanished, but a person took its label off (a stop, inside its grace); #21 Blocked on an
    // outage and stopped; #22 Blocked on an outage and made a draft; #23 Blocked on an outage with a restart applied by
    // someone who can push (it restarts: Queued, not Running); #24 the control.
    { number: 20, labels: [OBJ, "factory:running"], since: 30 * MIN },
    { number: 21, labels: [OBJ, "factory:blocked"], comments: [outage(21)] },
    { number: 22, labels: [OBJ, "factory:blocked"], comments: [outage(22)] },
    { number: 23, labels: [OBJ, "factory:blocked", "factory:restart"], comments: [outage(23)] },
    { number: 24, labels: [OBJ, "factory:blocked"], comments: [outage(24)] },
  ]);
  gh.person(20, "unlabeled", OBJ);
  gh.person(21, "unlabeled", OBJ);
  gh.person(22, "labeled", "factory:draft");
  const r = await tick(gh);
  assert.deepEqual(r.relaunched, [24]);
  assert.deepEqual(r.relaunch, [24]);
  for (const n of [20, 21, 22, 23]) assert.equal(recordOf(gh, n), null, `#${n}: no relaunch counted`);
  assert.ok(!gh.labels(21).includes("factory:running") && !gh.labels(22).includes("factory:running"));
  assert.deepEqual(r.restarted, [23], "the restart runs as before; its card goes back to Queued, not Running");
});

test("the count survives across ticks and dispatcher restarts, and starts over when a person re-applies the label", async () => {
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "factory:running"], since: 20 * MIN }]);
  await tick(gh);
  gh.age(20 * MIN);
  await tick(gh);
  gh.age(20 * MIN);
  // A fresh module load is no fresh count: the dispatcher keeps nothing between ticks.
  const r = await tick(gh);
  assert.deepEqual(r.vanished, [7], "two relaunches already on the issue: Blocked");
  assert.equal(recordOf(gh, 7).tries.length, 2);
  // A person re-applies the label: the Objective is Queued again, picked, and its next loss counts from there.
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
  const outage = { body: `${marker(8, "blocked", "outage:401-1")}\nBlocked (outage): lost\n<!-- factory:block {"cause":"outage"} -->` };
  const gh = fakeGitHub([
    { number: 8, labels: [OBJ, "factory:blocked"], comments: [outage] },
    { number: 9, labels: [OBJ, "P0"] },
  ]);
  const r = await tick(gh, { maxConcurrent: 1 });
  assert.deepEqual(r.relaunched, [8]);
  assert.deepEqual(r.ready, [], "the Queued P0 waits: the relaunch holds the one slot");
  assert.equal(r.running, 1);
  // With the slot taken by another Running Objective (inside its job's grace), the relaunch waits for it.
  const full = fakeGitHub([
    { number: 8, labels: [OBJ, "factory:blocked"], comments: [outage] },
    { number: 10, labels: [OBJ, "factory:running"], since: MIN },
  ]);
  const waits = await tick(full, { maxConcurrent: 1 });
  assert.deepEqual(waits.relaunched, []);
  assert.deepEqual(full.labels(8), [OBJ, "factory:blocked"].sort());
  assert.equal(recordOf(full, 8), null, "nothing counted while it waits");
  const later = await tick(full, { maxConcurrent: 2 });
  assert.deepEqual(later.relaunched, [8]);
});

test("the cloud sandbox: a stage whose lease ran out after its start is relaunched as a work stage, in place of the vanished Block", async () => {
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const record = { vendor: "vercel", stage: "work", state: "running", claim: "c1", at: iso(25 * MIN), leaseUntil: iso(5 * MIN), launches: [{ stage: "work", event: "swept", ok: true, cue: "x", run: "1", at: iso(25 * MIN) }] };
  const gh = fakeGitHub([{ number: 7, labels: [OBJ, "factory:running"], since: 30 * MIN, comments: [{ body: `${marker(7, "sandbox")}\n${sandboxMarkerLine(record)}` }] }]);
  const r = await tick(gh, { sandbox: "vercel" });
  assert.deepEqual(r.relaunched, [7]);
  assert.deepEqual(r.relaunch, [7], "the launcher starts its work stage: a new Running stint has no work start");
  assert.deepEqual(r.vanished, []);
  assert.deepEqual(recordOf(gh, 7).tries.map((t) => t.lost), ["vanished"]);
});

const outageNotice = (n, extra = {}) => ({ body: `${marker(n, "blocked", "outage:601-1")}\nBlocked (outage): this machine could not reach api.github.com (EAI_AGAIN)\n<!-- factory:block {"cause":"outage"} -->`, ...extra });
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test("an outage notice counts only when written since the Objective last became Running: a later Block whose notice never landed is not relaunched", async () => {
  const gh = fakeGitHub([{ number: 8, labels: [OBJ, "factory:running"], since: 5 * MIN }]);
  await outageEnd(gh, 8, 501);
  assert.deepEqual((await tick(gh)).relaunched, [8]);
  // The relaunched stage Blocks for its own reason: applyExit sets the label first, and its notice never lands.
  await on(gh, () => setStateLabel(REPO, 8, "blocked", { token: "t" }));
  const r = await tick(gh);
  assert.deepEqual(r.relaunched, [], "the outage notice is from before the relaunch's Running stint");
  assert.deepEqual(gh.labels(8), [OBJ, "factory:blocked"].sort());
  assert.equal(recordOf(gh, 8).tries.length, 1);
});

test("daily_usd: a lost stage is not relaunched while today's spend has reached the cap; it waits for the day's turn, unblocked", async () => {
  const spend = [{ id: 900, user: SELF, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), body: `<!-- factory:9:progress:x -->\n<!-- factory:spend {"usd":5} -->` }];
  const open = () => [
    { number: 7, labels: [OBJ, "factory:running"], since: 20 * MIN },
    { number: 8, labels: [OBJ, "factory:blocked"], comments: [outageNotice(8)] },
  ];
  const gh = fakeGitHub(open(), { spend });
  const r = await tick(gh, { dailyUsd: 1 });
  assert.deepEqual([r.relaunched, r.vanished, r.relaunchesUsed], [[], [], []]);
  assert.ok(r.deadlines.some((d) => d.kind === "daily-cap"), "the day's turn is its wake, as for a Queued pick");
  assert.deepEqual([gh.labels(7), gh.labels(8)], [[OBJ, "factory:running"].sort(), [OBJ, "factory:blocked"].sort()], "no Block, no relaunch");
  assert.equal(recordOf(gh, 7), null);
  const under = fakeGitHub(open(), { spend });
  assert.deepEqual((await tick(under, { dailyUsd: 10 })).relaunched.sort(), [7, 8]);
});

test("used up with max_concurrent reached: the Block and its mention go at once; the slot check is for a relaunch only", async () => {
  const at = ago(30 * MIN);
  const tries = [1, 2].map((k) => ({ at, lost: "outage", key: `block:${k}@${at}`, start: at }));
  const record = { body: `${marker(8, "relaunch")}\nFactory relaunched this Objective's stage: 2 of 2\n<!-- factory:relaunch ${JSON.stringify({ tries })} -->` };
  const gh = fakeGitHub([
    { number: 8, labels: [OBJ, "factory:blocked"], at, comments: [record, outageNotice(8, { created_at: ago(20 * MIN), updated_at: ago(20 * MIN) })] },
    { number: 10, labels: [OBJ, "factory:running"], since: MIN },
  ]);
  const r = await tick(gh, { maxConcurrent: 1 });
  assert.deepEqual([r.relaunched, r.relaunchesUsed], [[], [8]]);
  assert.match(gh.blocks(8).at(-1).body, /^<!-- factory:8:blocked:relaunch:[^]*@kirk Blocked \(relaunch\): the stage was lost to its network again after Factory relaunched it 2 times/);
});

test("a vanished stage that left a sign it was not the network keeps the vanished Block: a cancelled work job, a sandbox stage that recorded its end", async () => {
  const since = 20 * MIN;
  const job = (n, conclusion) => ({ name: `work (${n})`, status: "completed", conclusion, created_at: ago(since - 30_000) });
  const gh = fakeGitHub(
    [
      { number: 7, labels: [OBJ, "factory:running"], since },
      { number: 9, labels: [OBJ, "factory:running"], since },
    ],
    { runs: [{ id: 55, created_at: ago(since + 30_000) }], jobs: { 55: [job(7, "cancelled"), job(9, "failure")] } },
  );
  const r = await tick(gh);
  assert.deepEqual([r.vanished, r.relaunched], [[7], [9]], "#9's job failed with no word: lost, relaunched");
  assert.match(gh.blocks(7)[0].body, /worker job vanished: Running with no job in progress Fix by/);
  // The sandbox: #7's stage recorded its end (it reached GitHub); #9's lease ran out with no end.
  const sandboxed = (n, rec) => ({ body: `${marker(n, "sandbox")}\n${sandboxMarkerLine({ vendor: "vercel", stage: "work", claim: "c1", at: ago(25 * MIN), launches: [{ stage: "work", event: "swept", ok: true, cue: "x", run: "1", at: ago(25 * MIN) }], ...rec })}` });
  const box = fakeGitHub([
    { number: 7, labels: [OBJ, "factory:running"], since: 30 * MIN, comments: [sandboxed(7, { state: "ended", exitCode: 1, leaseUntil: null })] },
    { number: 9, labels: [OBJ, "factory:running"], since: 30 * MIN, comments: [sandboxed(9, { state: "running", leaseUntil: ago(5 * MIN) })] },
  ]);
  const s = await tick(box, { sandbox: "vercel" });
  assert.deepEqual([s.vanished, s.relaunched], [[7], [9]]);
});

test("a relaunch Factory cannot record for over an hour Blocks with the person mentioned; a younger one waits", async () => {
  const gh = fakeGitHub(
    [
      { number: 7, labels: [OBJ, "factory:running"], since: 120 * MIN },
      { number: 8, labels: [OBJ, "factory:blocked"], since: 120 * MIN, comments: [outageNotice(8, { created_at: ago(90 * MIN), updated_at: ago(90 * MIN) })] },
      { number: 11, labels: [OBJ, "factory:blocked"], since: 120 * MIN, comments: [outageNotice(11, { created_at: ago(10 * MIN), updated_at: ago(10 * MIN) })] },
    ],
    { failRecord: true },
  );
  const r = await tick(gh);
  assert.deepEqual([r.relaunched, r.relaunchesUsed, r.vanished], [[], [8], [7]]);
  assert.match(gh.blocks(8).at(-1).body, /@kirk Blocked \(relaunch\): the stage ended on its network, and Factory could not record its relaunch for over an hour/);
  assert.equal(blockCauseOf(gh.blocks(8).at(-1).body), "outage");
  assert.match(gh.blocks(7).at(-1).body, /@kirk Blocked \(dispatch\): worker job vanished: Running with no job in progress; Factory could not record its relaunch for over an hour/);
  assert.equal(gh.blocks(11).length, 1, "#11's outage is ten minutes old: it waits, and tries again");
  assert.ok(r.deadlines.some((d) => d.kind === "retry"));
});
