// No Objective is left Running with no claim (#304): a serve stopped between its dispatch's Running label and the
// claim puts the Objective back to Queued, and a serve's tick takes a pendulum:local Objective that has been Running a
// few minutes with no claim and no stage anywhere as Queued again.
import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { budgetHome, fakeProc } from "./fixtures/machine.mjs";
import { Local, STAGE_RECORD, holderId, machineIdentity } from "../scripts/local.mjs";
import { claimBody, claimMarker } from "../scripts/lib/local.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

RETRY.sleep = async () => {};

const LOCAL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "local.mjs")).href;

/**
 * A GitHub with one Objective, #7, of repository o/r: its labels, comments and timeline. `hook(req, path, state)` runs
 * on every request as it arrives and may return a promise its answer waits for (its write is made at once); one that
 * resolves to {status} answers with that status instead. `listed`: the labels the issue listings show (a listing older
 * than GitHub), else the issue's own. `clockMs`: how far GitHub's clock (its Date header) is from this machine's.
 * `workflow`: the repository's workflow list as GitHub answers it: pendulum.yml's `state` in it, "none" for a list without
 * it, or an HTTP status its read gets (null: not served). `lag`: how many timeline reads after a pendulum:local label
 * event still miss it (a timeline that lags behind the label write).
 */
async function fakeGitHub({ labels = ["pendulum:objective", "pendulum:local"], listed = null, comments = [], timeline = [], clockMs = 0, workflow = null, lag = 0, hook = () => {} } = {}) {
  const state = { labels: new Set(labels), listed: listed && new Set(listed), comments, timeline, workflow, lag, workflowReads: [], writes: [] };
  let id = 500;
  const issue = () => ({ number: 7, title: "t", body: "", state: "open", user: { login: "maintainer" }, labels: [...state.labels].map((name) => ({ name })), created_at: "2026-11-01T00:00:00Z", updated_at: new Date().toISOString() });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      const body = raw ? JSON.parse(raw) : null;
      if (req.method !== "GET") state.writes.push(`${req.method} ${p}`);
      // The write lands on GitHub at once; only its answer waits for the hook.
      const gate = Promise.resolve(hook(req, p, state));
      // The answer is GitHub's state as the request arrived, sent once the hook lets it go.
      const send = (status, b) => {
        const text = b === undefined ? "" : JSON.stringify(b);
        void gate.then((o) => {
          const head = { "content-type": "application/json", date: new Date(Date.now() + clockMs).toUTCString() };
          if (o?.status) return res.writeHead(o.status, head).end(JSON.stringify({ message: "Validation Failed" }));
          res.writeHead(status, head).end(text);
        });
      };
      if (p === "/user") return send(200, { login: "maintainer", type: "User" });
      // The repository's workflow list: pendulum.yml at `workflow`'s state, a list without it ("none"), or an HTTP status.
      if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(p) && state.workflow !== null) {
        state.workflowReads.push(p);
        if (typeof state.workflow === "number") return send(state.workflow, { message: "Resource not accessible by personal access token" });
        const workflows = [{ id: 1, path: ".github/workflows/ci.yml", state: "active" }, ...(state.workflow === "none" ? [] : [{ id: 2, path: ".github/workflows/pendulum.yml", state: state.workflow }])];
        return send(200, { total_count: workflows.length, workflows });
      }
      if (p === "/repos/o/r/collaborators") return send(200, [{ login: "maintainer", permissions: { push: true } }, { login: "other", permissions: { push: true } }]);
      if (p === "/repos/o/r/issues" && req.method === "GET") {
        const want = (url.searchParams.get("labels") || "").split(",").filter(Boolean);
        const shown = state.listed || state.labels;
        return send(200, url.searchParams.get("state") !== "closed" && want.every((l) => shown.has(l)) ? [{ ...issue(), labels: [...shown].map((name) => ({ name })) }] : []);
      }
      if (p === "/repos/o/r/issues/7" && req.method === "GET") return send(200, issue());
      if (p === "/repos/o/r/issues/7/labels" && req.method === "POST") {
        for (const l of body.labels) state.labels.add(l), state.timeline.push({ id: (id += 1), event: "labeled", label: { name: l }, actor: { login: "maintainer", type: "User" }, created_at: new Date().toISOString() });
        return send(200, []);
      }
      const label = /^\/repos\/o\/r\/issues\/7\/labels\/(.+)$/.exec(p);
      if (label && req.method === "DELETE") {
        const l = decodeURIComponent(label[1]);
        if (!state.labels.delete(l)) return send(404, { message: "Not Found" });
        state.timeline.push({ event: "unlabeled", label: { name: l }, actor: { login: "maintainer" }, created_at: new Date().toISOString() });
        return send(200, []);
      }
      if (p === "/repos/o/r/issues/7/timeline") {
        if (state.lag <= 0 || !state.timeline.some((e) => e.label?.name === "pendulum:local")) return send(200, state.timeline);
        state.lag -= 1;
        return send(200, state.timeline.filter((e) => e.label?.name !== "pendulum:local"));
      }
      if (p === "/repos/o/r/issues/7/comments" && req.method === "GET") return send(200, state.comments);
      if (p === "/repos/o/r/issues/7/comments" && req.method === "POST") {
        const at = new Date().toISOString();
        const c = { id: (id += 1), user: { login: "maintainer", type: "User" }, body: body.body, created_at: at, updated_at: at };
        state.comments.push(c);
        return send(201, c);
      }
      const one = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(p);
      if (one && req.method === "PATCH") {
        const c = state.comments.find((x) => String(x.id) === one[1]);
        Object.assign(c, { body: body.body, updated_at: new Date().toISOString() });
        return send(200, c);
      }
      if (one && req.method === "DELETE") {
        state.comments.splice(state.comments.findIndex((x) => String(x.id) === one[1]), 1);
        return send(204);
      }
      if (p === "/graphql") return send(200, { data: {} });
      return req.method === "GET" ? send(200, []) : send(200, {});
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  // Closing ends every connection too, a client's idle or half-open one included: it never waits for one.
  const close = () => new Promise((ok) => (server.close(ok), server.closeAllConnections()));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close };
}

const claims = (state) => state.comments.filter((c) => c.body.startsWith(claimMarker(7)));

/**
 * The real `serve` (its tick, its dispatch, its claim, its signal handling) in a child process against `fake`, from a
 * loop built without the start-up checks (a harness, a token): serve's own code from there on. `said(re)` resolves once
 * the child has said a line matching `re`.
 */
function childServe(fake) {
  const home = mkdtempSync(join(tmpdir(), "unclaimed-home-"));
  const dev = mkdtempSync(join(tmpdir(), "unclaimed-dev-"));
  const script = `
    import { Local, holderId, machineIdentity } from ${JSON.stringify(LOCAL)};
    const loop = Object.assign(Object.create(Local.prototype), {
      dev: ${JSON.stringify(dev)}, repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", notice: null,
      harness: "claude", wf: { PENDULUM_LOCAL_MAX_CONCURRENT: "2", PENDULUM_MAX_CONCURRENT: "2" }, opts: { token: "t" },
      holder: holderId(machineIdentity()), children: new Set(), firstSetup: new Map(), claimRetryMs: 0,
    });
    await loop.serve({ intervalMs: 60_000 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: fake.url, PENDULUM_LOCAL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const waiting = new Set();
  const heard = (c) => {
    out += c;
    for (const w of waiting) w();
  };
  child.stdout.on("data", heard);
  child.stderr.on("data", heard);
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const exited = new Promise((r) => child.on("exit", (code, signal) => (clearTimeout(timer), r({ code, signal, out: () => out }))));
  // Once the child has said a line matching `re` (or has exited).
  const said = (re) =>
    new Promise((r) => {
      const check = () => re.test(out) && (waiting.delete(check), r());
      waiting.add(check);
      void exited.then(r);
      check();
    });
  return { child, exited, said };
}

test("serve stopped by SIGINT while its dispatch marks a pick Running starts nothing and puts it back to Queued, with no claim (#304)", { skip: process.platform === "win32" }, async () => {
  let run = null;
  let signalled = false;
  const fake = await fakeGitHub({
    // The Running label lands on GitHub; the stop comes before its answer reaches serve: the answer waits until serve
    // says it is stopping.
    hook: async (req, p) => {
      if (req.method === "POST" && p === "/repos/o/r/issues/7/labels" && !signalled) {
        signalled = true;
        run.child.kill("SIGINT");
        await run.said(/stopping \(SIGINT\)/);
      }
    },
  });
  try {
    run = childServe(fake);
    const end = await run.exited;
    assert.ok(signalled, end.out());
    assert.equal(end.code, 130, end.out());
    assert.ok(!fake.state.labels.has("pendulum:running"), `left Running with no claim:\n${end.out()}`);
    assert.equal(claims(fake.state).length, 0);
    assert.match(end.out(), /#7: stopping before it started; back to Queued/);
    assert.doesNotMatch(end.out(), /#7: resuming|could not start/);
  } finally {
    await fake.close();
  }
});

/** The real serve, one tick at a time in this process, against `fake`; the work stage itself is not run (`picks`). `extra`: the loop's own fields. */
async function serveTicks(fake, { ticks = 1, live = false, extra = {} } = {}) {
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, PENDULUM_LOCAL: process.env.PENDULUM_LOCAL, PENDULUM_LOCAL_ALL: process.env.PENDULUM_LOCAL_ALL };
  process.env.GITHUB_API_URL = fake.url;
  process.env.PENDULUM_LOCAL = "1";
  const dev = mkdtempSync(join(tmpdir(), "unclaimed-dev-"));
  if (live) {
    // A stage of #7 running on this machine (this test's own process stands in for it).
    const { processRecord } = await import("../scripts/lib/proc.mjs");
    const usage = join(dev, ".pendulum", "7", "usage-work-x");
    mkdirSync(usage, { recursive: true });
    writeFileSync(join(usage, STAGE_RECORD), JSON.stringify(processRecord(process.pid)));
  }
  const picks = [];
  const lines = [];
  const loop = Object.assign(Object.create(Local.prototype), {
    dev, repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", notice: null, harness: "claude",
    wf: { PENDULUM_LOCAL_MAX_CONCURRENT: "2", PENDULUM_MAX_CONCURRENT: "2" }, opts: { token: "t" }, holder: holderId(machineIdentity()),
    machine: { home: budgetHome(), proc: fakeProc(mkdtempSync(join(tmpdir(), "proc-"))) },
    children: new Set(), firstSetup: new Map(), claimRetryMs: 0,
    stopOnSignals: () => {},
    cleanup: async () => {},
    runObjective: async (n) => (picks.push(n), { exit: "skipped" }),
    ...extra,
  });
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    for (let i = 0; i < ticks; i += 1) await loop.serve({ once: true });
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  return { picks, log: lines.join(""), loop };
}

const runningSince = (ms) => [{ event: "labeled", label: { name: "pendulum:running" }, actor: { login: "maintainer" }, created_at: new Date(Date.now() - ms).toISOString() }];

test("serve: a pendulum:local Objective Running for minutes with no claim and no stage anywhere is Queued again, said once, and picked (#304)", async () => {
  const fake = await fakeGitHub({ labels: ["pendulum:objective", "pendulum:local", "pendulum:running"], timeline: runningSince(10 * 60_000) });
  try {
    const { picks, log } = await serveTicks(fake, { ticks: 2 });
    const said = log.match(/#7: Running since \w{3} \d{1,2}, \d{1,2}:\d\d:\d\d [AP]M \S+ with no claim and no stage on any machine \(a start that never wrote its claim\); back to Queued/g) || [];
    assert.equal(said.length, 1, log);
    assert.ok(fake.state.writes.includes("DELETE /repos/o/r/issues/7/labels/pendulum%3Arunning"), fake.state.writes.join("\n"));
    // Queued again: this loop's next pick takes it (and marks it Running anew), and nothing Blocks it.
    assert.deepEqual(picks, [7]);
    assert.ok(!fake.state.labels.has("pendulum:blocked"));
  } finally {
    await fake.close();
  }
});

test("serve: a Running Objective with a claim, a fresh Running label, or a stage on this machine is left alone (#304)", async () => {
  const other = "otherbox:4242:abcdef:m0:b0";
  const cases = [
    ["another machine's live claim", { comments: [{ id: 1, user: { login: "maintainer", type: "User" }, body: `${claimMarker(7)}\n${claimBody(other)}`, updated_at: new Date().toISOString() }], timeline: runningSince(10 * 60_000) }],
    ["a Running label two minutes old", { timeline: runningSince(2 * 60_000) }],
    ["a stage of it on this machine", { timeline: runningSince(10 * 60_000), live: true }],
  ];
  for (const [what, { comments = [], timeline, live = false }] of cases) {
    const fake = await fakeGitHub({ labels: ["pendulum:objective", "pendulum:local", "pendulum:running"], comments, timeline });
    try {
      const { picks, log } = await serveTicks(fake, { live });
      assert.ok(fake.state.labels.has("pendulum:running"), what);
      assert.doesNotMatch(log, /back to Queued/, what);
      assert.deepEqual(picks, [], what);
    } finally {
      await fake.close();
    }
  }
});

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const labelEvent = (event, name, at = new Date().toISOString()) => ({ event, label: { name }, actor: { login: "maintainer" }, created_at: at });
/**
 * The label removals, less those of a pick marking it Running (dispatch's mark sets the one state label: it removes the
 * other three, then adds pendulum:running).
 */
const labelDeletes = (state) => {
  const out = [];
  const del = (l) => `DELETE /repos/o/r/issues/7/labels/${encodeURIComponent(l)}`;
  const mark = ["pendulum:blocked", "pendulum:question", "pendulum:in-review"].map(del);
  for (const w of state.writes) {
    if (w === "POST /repos/o/r/issues/7/labels") {
      if (out.slice(-3).join() === mark.join()) out.splice(-3);
    } else if (w.startsWith("DELETE /repos/o/r/issues/7/labels/")) out.push(w);
  }
  return out;
};

test("serve: a listing older than GitHub never sweeps an Objective that has since left Running (#304 review)", async () => {
  // The listing still shows Running; GitHub has a Question since, and the timeline shows the label's removal.
  const fake = await fakeGitHub({
    labels: ["pendulum:objective", "pendulum:local", "pendulum:question"],
    listed: ["pendulum:objective", "pendulum:local", "pendulum:running"],
    timeline: [labelEvent("labeled", "pendulum:running", ago(40 * 60_000)), labelEvent("unlabeled", "pendulum:running", ago(5_000)), labelEvent("labeled", "pendulum:question", ago(5_000))],
  });
  try {
    const { log } = await serveTicks(fake);
    assert.ok(fake.state.labels.has("pendulum:question"), log);
    assert.deepEqual(labelDeletes(fake.state), []);
    assert.doesNotMatch(log, /back to Queued/);
  } finally {
    await fake.close();
  }
});

/** A loop whose work stage only records that it started (`started`), against `fake`; runObjective and its claim are real. */
async function startLoop(fake) {
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, PENDULUM_LOCAL: process.env.PENDULUM_LOCAL };
  process.env.GITHUB_API_URL = fake.url;
  process.env.PENDULUM_LOCAL = "1";
  const started = [];
  const loop = Object.assign(Object.create(Local.prototype), {
    dev: mkdtempSync(join(tmpdir(), "unclaimed-dev-")), repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", notice: null, harness: "claude",
    wf: {}, opts: { token: "t" }, holder: holderId(machineIdentity()), children: new Set(), firstSetup: new Map(), claimRetryMs: 0, stopping: false,
    work: async (n) => (started.push(n), { exit: "delivered" }),
  });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  return { loop, started, restore };
}

/** Another loop, meanwhile: the sweep put the Objective back to Queued, and that loop picked it again (a new stint). */
const anotherStint = (state) => {
  state.timeline.push(labelEvent("unlabeled", "pendulum:running"), labelEvent("labeled", "pendulum:running"));
};
const claimOf = (login, holder) => ({ id: 90, user: { login, type: "User" }, body: `${claimMarker(7)}\n${claimBody(holder)}`, created_at: ago(1_000), updated_at: ago(1_000) });

test("a start that waited while another loop took the Objective again writes no claim over that loop's (#304 review)", async () => {
  let stalled = false;
  const fake = await fakeGitHub({
    labels: ["pendulum:objective", "pendulum:local", "pendulum:running"],
    timeline: runningSince(60_000),
    // The start's claim read answers with no claim; before the answer arrives the other loop (same login) takes it and claims.
    hook: async (req, p, state) => {
      if (req.method === "GET" && p === "/repos/o/r/issues/7/comments" && !stalled) {
        stalled = true;
        anotherStint(state);
        state.comments.push(claimOf("maintainer", "otherbox:4242:abcdef:m0:b0"));
      }
    },
  });
  const { loop, started, restore } = await startLoop(fake);
  try {
    const r = await loop.runObjective(7);
    assert.equal(r.exit, "skipped");
    assert.deepEqual(started, [], "no second start");
    assert.ok(!fake.state.writes.some((w) => w.startsWith("PATCH ") || w === "POST /repos/o/r/issues/7/comments"), fake.state.writes.join("\n"));
    assert.match(claims(fake.state)[0].body, /holder: otherbox:4242:abcdef:m0:b0/);
  } finally {
    restore();
    await fake.close();
  }
});

test("a start whose claim write landed after another loop took the Objective again steps aside and leaves no claim of its own (#304 review)", async () => {
  let stalled = false;
  const fake = await fakeGitHub({
    labels: ["pendulum:objective", "pendulum:local", "pendulum:running"],
    timeline: runningSince(60_000),
    // The claim's write is slow to land: meanwhile another loop (another login) picks the Objective again.
    hook: async (req, p, state) => {
      if (req.method === "POST" && p === "/repos/o/r/issues/7/comments" && !stalled) {
        stalled = true;
        anotherStint(state);
      }
    },
  });
  const { loop, started, restore } = await startLoop(fake);
  try {
    const r = await loop.runObjective(7);
    assert.equal(r.exit, "skipped");
    assert.deepEqual(started, [], "no second start");
    assert.deepEqual(claims(fake.state), [], "its own claim is taken back");
    // This loop never resumes it from a claim of its name.
    assert.deepEqual(await loop.pausedHere(new Map()), []);
  } finally {
    restore();
    await fake.close();
  }
});

test("a start told to stop while it reads its claim writes no claim and puts the Objective back to Queued (#304)", async () => {
  let started = null;
  const fake = await fakeGitHub({
    labels: ["pendulum:objective", "pendulum:local", "pendulum:running"],
    timeline: runningSince(60_000),
    // The pick's claim read, after the dispatch marked it Running: the stop comes before its answer.
    hook: (req, p) => {
      if (req.method === "GET" && p === "/repos/o/r/issues/7/comments") started.loop.stopping = true;
    },
  });
  started = await startLoop(fake);
  try {
    assert.equal((await started.loop.runObjective(7)).exit, "skipped");
    assert.deepEqual(started.started, [], "nothing starts");
    assert.ok(!fake.state.writes.some((w) => w === "POST /repos/o/r/issues/7/comments"), "no claim write at all");
    assert.ok(!fake.state.labels.has("pendulum:running"), "left Running");
  } finally {
    started.restore();
    await fake.close();
  }
});

test("a start with no other loop about claims and starts as before (#304 review)", async () => {
  const fake = await fakeGitHub({ labels: ["pendulum:objective", "pendulum:local", "pendulum:running"], timeline: runningSince(60_000) });
  const { loop, started, restore } = await startLoop(fake);
  try {
    assert.equal((await loop.runObjective(7)).exit, "delivered");
    assert.deepEqual(started, [7]);
  } finally {
    restore();
    await fake.close();
  }
});

test("serve stopped while its dispatch marks a pick that another loop has claimed meanwhile leaves that loop's Objective Running (#310 review)", { skip: process.platform === "win32" }, async () => {
  let run = null;
  let signalled = false;
  const fake = await fakeGitHub({
    // Another loop's claim lands with the Running label; the answer waits until serve says it is stopping.
    hook: async (req, p, state) => {
      if (req.method === "POST" && p === "/repos/o/r/issues/7/labels" && !signalled) {
        signalled = true;
        state.comments.push(claimOf("other", "otherbox:4242:abcdef:m0:b0"));
        run.child.kill("SIGINT");
        await run.said(/stopping \(SIGINT\)/);
      }
    },
  });
  try {
    run = childServe(fake);
    const end = await run.exited;
    assert.ok(signalled, end.out());
    assert.equal(end.code, 130, end.out());
    assert.ok(fake.state.labels.has("pendulum:running"), `another loop's Objective was put back:\n${end.out()}`);
    assert.deepEqual(labelDeletes(fake.state), []);
  } finally {
    await fake.close();
  }
});

test("a resume whose stint cannot be read back after its claim keeps that claim as its own (#310 re-review)", async () => {
  const id = machineIdentity();
  // This machine's earlier serve (its pid gone) paused #7: its claim, same login, an hour stale.
  const old = `${id.host}:999999:abcdef:${id.machine}:${id.boot}`;
  let reads = 0;
  const stale = (body) => body.replace(/heartbeat: \S+/, `heartbeat: ${ago(3600_000)}`);
  const fake = await fakeGitHub({
    labels: ["pendulum:objective", "pendulum:local", "pendulum:running"],
    timeline: runningSince(2 * 3600_000),
    comments: [{ id: 90, user: { login: "maintainer", type: "User" }, body: stale(`${claimMarker(7)}\n${claimBody(old)}`), created_at: ago(2 * 3600_000), updated_at: ago(3600_000) }],
    // The stint reads before the claim answer; every one after it fails.
    hook: (req, p) => {
      if (req.method === "GET" && p === "/repos/o/r/issues/7/timeline" && ++reads >= 3) return { status: 502 };
    },
  });
  const { loop, started, restore } = await startLoop(fake);
  try {
    assert.equal((await loop.runObjective(7)).exit, "skipped");
    assert.deepEqual(started, []);
    assert.match(claims(fake.state)[0].body, new RegExp(`holder: ${loop.holder}`), "the claim stays, naming this loop");
  } finally {
    restore();
    await fake.close();
  }
});

test("a resume that steps aside on a changed stint leaves its own claim resumable, never set aside for good (#310 re-review)", async () => {
  const id = machineIdentity();
  const old = `${id.host}:999999:abcdef:${id.machine}:${id.boot}`;
  const stale = (body) => body.replace(/heartbeat: \S+/, `heartbeat: ${ago(3600_000)}`);
  let changed = false;
  const fake = await fakeGitHub({
    labels: ["pendulum:objective", "pendulum:local", "pendulum:running"],
    timeline: runningSince(2 * 3600_000),
    comments: [{ id: 90, user: { login: "maintainer", type: "User" }, body: stale(`${claimMarker(7)}\n${claimBody(old)}`), created_at: ago(2 * 3600_000), updated_at: ago(3600_000) }],
    // While the resume's claim write lands, the Objective's stint changes (another loop picked it again).
    hook: (req, p, state) => {
      if (req.method === "PATCH" && p === "/repos/o/r/issues/comments/90" && !changed) {
        changed = true;
        anotherStint(state);
      }
    },
  });
  const { loop, started, restore } = await startLoop(fake);
  try {
    assert.equal((await loop.runObjective(7)).exit, "skipped");
    assert.deepEqual(started, []);
    const c = claims(fake.state)[0];
    c.updated_at = ago(3600_000);
    c.body = stale(c.body);
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "this machine's own claim stays resumable");
  } finally {
    restore();
    await fake.close();
  }
});

/**
 * A repository's origin and a developer's clone of it, its default branch `main` with no Pendulum workflow; `addWorkflow`
 * pushes .github/workflows/pendulum.yml to it.
 */
function cloneOf() {
  const root = mkdtempSync(join(tmpdir(), "route-"));
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  const ident = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (...a) => execFileSync("git", ["-C", dev, ...a], { encoding: "utf8", env: ident, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, dev], { stdio: "ignore" });
  git("checkout", "-q", "-b", "main");
  writeFileSync(join(dev, "README.md"), "app\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "app");
  git("push", "-q", "origin", "main");
  const addWorkflow = () => {
    mkdirSync(join(dev, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dev, ".github", "workflows", "pendulum.yml"), "name: Pendulum\nenv:\n  PENDULUM_MODEL: m\njobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: clockgrove/pendulum@v0.9.30\n");
    git("add", ".github");
    git("commit", "-q", "-m", "workflow");
    git("push", "-q", "origin", "main");
  };
  return { dev, addWorkflow };
}

test("serve: where no Action runs (a disabled pendulum.yml workflow), the Objective it picks without pendulum:local is labelled pendulum:local, said once, and runs (#455)", async () => {
  for (const workflow of ["disabled_manually"]) {
    // The default branch carries a workflow file all the same: only GitHub's answer counts.
    const repo = cloneOf();
    repo.addWorkflow();
    const fake = await fakeGitHub({ labels: ["pendulum:objective"], workflow });
    try {
      const { picks, log } = await serveTicks(fake, { ticks: 2, extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
      assert.deepEqual(picks, [7], `${workflow}: ${log}`);
      assert.ok(fake.state.labels.has("pendulum:local") && fake.state.labels.has("pendulum:running"), String(workflow));
      const added = fake.state.writes.filter((w) => w === "POST /repos/o/r/issues/7/labels");
      assert.equal(added.length, 2, "pendulum:local first, then the Running mark");
      // Pendulum's mark names that exact label event, so the scorer counts the label as Pendulum's.
      const event = fake.state.timeline.find((e) => e.event === "labeled" && e.label.name === "pendulum:local");
      assert.deepEqual(fake.state.comments.filter((c) => c.body.includes(":local-route:")).map((c) => c.body.split("\n")[0]), [`<!-- pendulum:7:local-route:${event.id} -->`]);
      assert.equal((log.match(/#7: no Action runs Objectives here, so this loop takes it and labels it pendulum:local/g) || []).length, 1, log);
      assert.match(log, /no Action runs Objectives in o\/r \(no active pendulum\.yml workflow\)/);
      assert.equal(process.env.PENDULUM_LOCAL_ALL, undefined, "no routing flag: the label is the route");
    } finally {
      await fake.close();
    }
  }
});

test("serve: with the Action active, Objectives without pendulum:local are the Action's, said once per start; an unread answer labels nothing and takes nothing (#455)", async () => {
  // No workflow file on the default branch: GitHub's answer decides, never origin's tree.
  const repo = cloneOf();
  const fake = await fakeGitHub({ labels: ["pendulum:objective"], workflow: "active" });
  try {
    const { picks, log } = await serveTicks(fake, { ticks: 3, extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
    assert.deepEqual(picks, [], "never taken");
    assert.ok(!fake.state.labels.has("pendulum:local"));
    const said = log.split("\n").filter((l) => l.includes("without pendulum:local ("));
    assert.equal(said.length, 1, log);
    assert.match(said[0], /1 queued Objective without pendulum:local \(#7\) is the Action's: its pendulum\.yml workflow is active\. To run one on this machine instead, add pendulum:local to it\. \(serve --all is for a repository whose Action should not run Objectives: with the Action active, both would race/);
  } finally {
    await fake.close();
  }
  // A token without Actions: read (GitHub's 403): unknown, so nothing is labelled.
  for (const workflow of [403]) {
    const failing = await fakeGitHub({ labels: ["pendulum:objective"], workflow });
    try {
      const { picks, log } = await serveTicks(failing, { ticks: 2, extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
      assert.deepEqual(picks, [], `${workflow}: ${log}`);
      assert.ok(!failing.state.labels.has("pendulum:local"), String(workflow));
      assert.equal(process.env.PENDULUM_LOCAL_ALL, undefined);
      assert.equal((log.match(/whether GitHub's Action runs Objectives in o\/r could not be read/g) || []).length, 1, log);
      assert.doesNotMatch(log, /is the Action's/, "nothing said that the read did not tell");
    } finally {
      await failing.close();
    }
  }
});

test("serve: a pick whose label event the timeline did not show yet starts all the same, and the loop that holds it writes the mark later, naming that exact event once (#455 review)", async () => {
  const marks = (state) => state.comments.filter((c) => c.body.includes(":local-route:"));
  const labelEvent = (state) => state.timeline.find((e) => e.event === "labeled" && e.label.name === "pendulum:local");
  const repo = cloneOf();
  const fake = await fakeGitHub({ labels: ["pendulum:objective"], workflow: "none", lag: 1 });
  const api = process.env.GITHUB_API_URL;
  try {
    const { picks, log, loop } = await serveTicks(fake, { extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
    assert.deepEqual(picks, [7], `the pick starts: ${log}`);
    assert.ok(fake.state.labels.has("pendulum:local"));
    assert.equal(marks(fake.state).length, 0);
    assert.deepEqual([...loop.unmarked], [7], "its claim's start writes the mark");
    // The loop that holds it (its claim's start, then each heartbeat) writes the mark, once.
    process.env.GITHUB_API_URL = fake.url;
    await loop.backfillMark(7);
    await loop.backfillMark(7);
    assert.equal(loop.unmarked.size, 0);
    assert.deepEqual(marks(fake.state).map((c) => c.body.split("\n")[0]), [`<!-- pendulum:7:local-route:${labelEvent(fake.state).id} -->`]);
  } finally {
    api === undefined ? delete process.env.GITHUB_API_URL : (process.env.GITHUB_API_URL = api);
    await fake.close();
  }
});

test("Pendulum's local-route mark names only the label on now, and only this login's: never one taken off since, never a person's; no login, no mark (#455 review)", async () => {
  const { localRouteEvent, markLocalRoute } = await import("../scripts/lib/local.mjs");
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const me = { login: "maintainer", type: "User" };
  const ev = (id, event, actor = me) => ({ id, event, label: { name: "pendulum:local" }, actor });
  setSelf("maintainer");
  try {
    assert.deepEqual(localRouteEvent([ev(1, "labeled"), ev(2, "unlabeled"), ev(3, "labeled")]), { id: "3", mine: true });
    assert.equal(localRouteEvent([ev(1, "labeled"), ev(2, "unlabeled")]), null, "taken off since: no label on");
    assert.deepEqual(localRouteEvent([ev(1, "labeled"), ev(2, "unlabeled"), ev(3, "labeled", { login: "someone", type: "User" })]), { id: "3", mine: false });
    setSelf(null);
    const repo = { owner: "o", name: "r", full: "o/r" };
    const saved = process.env.GITHUB_API_URL;
    const fake = await fakeGitHub({ labels: ["pendulum:objective", "pendulum:local"], timeline: [ev(5, "labeled")], hook: (req, p) => (p === "/user" ? { status: 500 } : undefined) });
    process.env.GITHUB_API_URL = fake.url;
    try {
      const r = await markLocalRoute(repo, 7, { token: "t" });
      assert.equal(r.marked, false);
      assert.match(r.why, /Pendulum's own login could not be read/);
      assert.equal(fake.state.comments.length, 0, "no mark accepting any actor");
    } finally {
      saved === undefined ? delete process.env.GITHUB_API_URL : (process.env.GITHUB_API_URL = saved);
      await fake.close();
    }
  } finally {
    setSelf(null);
  }
});

test("a pendulum:local label the developer applied by hand is never marked as Pendulum's: the loop that holds it leaves it a person's action (#455 review)", async () => {
  const { localPendulumActions } = await import("../../bench/lib/objective.mjs");
  const repo = cloneOf();
  repo.addWorkflow();
  const by = { login: "maintainer", type: "User" };
  // The Action is active; the developer labelled #7 pendulum:local by hand (event 99), under the login Pendulum posts as.
  const fake = await fakeGitHub({ labels: ["pendulum:objective", "pendulum:local"], workflow: "active", timeline: [{ id: 98, event: "labeled", label: { name: "pendulum:objective" }, actor: by, created_at: ago(3600_000) }, { id: 99, event: "labeled", label: { name: "pendulum:local" }, actor: by, created_at: ago(1800_000) }] });
  const api = process.env.GITHUB_API_URL;
  try {
    const { picks, loop } = await serveTicks(fake, { extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
    assert.deepEqual(picks, [7]);
    // Its claim's start and each heartbeat take this step (withClaim): it writes no mark.
    process.env.GITHUB_API_URL = fake.url;
    await loop.backfillMark(7);
    await loop.backfillMark(7);
    assert.equal(fake.state.comments.filter((c) => c.body.includes(":local-route:")).length, 0, "no mark");
    const collected = { issue: { number: 7, labels: [...fake.state.labels].map((name) => ({ name })) }, issueTimeline: fake.state.timeline, issueComments: fake.state.comments };
    assert.equal(localPendulumActions(collected)(ago(1800_000), by, "labeled pendulum:local", 99), false, "it scores as the person's");
  } finally {
    api === undefined ? delete process.env.GITHUB_API_URL : (process.env.GITHUB_API_URL = api);
    await fake.close();
  }
});
