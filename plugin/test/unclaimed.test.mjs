// No Objective is left Running with no claim (#304): a serve stopped between its dispatch's Running label and the
// claim puts the Objective back to Queued, and a serve's tick takes a factory:local Objective that has been Running a
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
import { Local, STAGE_RECORD, holderId, machineIdentity, unroutedLine } from "../scripts/local.mjs";
import { claimBody, claimMarker } from "../scripts/lib/local.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

RETRY.sleep = async () => {};

const LOCAL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "local.mjs")).href;

/**
 * A GitHub with one Objective, #7, of repository o/r: its labels, comments and timeline. `hook(req, path, state)` runs
 * on every request as it arrives and may return a promise its answer waits for (its write is made at once); one that
 * resolves to {status} answers with that status instead. `listed`: the labels the issue listings show (a listing older
 * than GitHub), else the issue's own. `clockMs`: how far GitHub's clock (its Date header) is from this machine's.
 * `workflow`: the repository's workflow list as GitHub answers it: factory.yml's `state` in it, "none" for a list without
 * it, or an HTTP status its read gets (null: not served). `lag`: how many timeline reads after a factory:local label
 * event still miss it (a timeline that lags behind the label write).
 */
async function fakeGitHub({ labels = ["factory:objective", "factory:local"], listed = null, comments = [], timeline = [], clockMs = 0, workflow = null, lag = 0, hook = () => {} } = {}) {
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
      // The repository's workflow list: factory.yml at `workflow`'s state, a list without it ("none"), or an HTTP status.
      if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(p) && state.workflow !== null) {
        state.workflowReads.push(p);
        if (typeof state.workflow === "number") return send(state.workflow, { message: "Resource not accessible by personal access token" });
        const workflows = [{ id: 1, path: ".github/workflows/ci.yml", state: "active" }, ...(state.workflow === "none" ? [] : [{ id: 2, path: ".github/workflows/factory.yml", state: state.workflow }])];
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
        if (state.lag <= 0 || !state.timeline.some((e) => e.label?.name === "factory:local")) return send(200, state.timeline);
        state.lag -= 1;
        return send(200, state.timeline.filter((e) => e.label?.name !== "factory:local"));
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
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

const claims = (state) => state.comments.filter((c) => c.body.startsWith(claimMarker(7)));

/**
 * The real `serve` (its tick, its dispatch, its claim, its signal handling) in a child process against `fake`, from a
 * loop built without the start-up checks (a harness, a token): serve's own code from there on.
 */
function childServe(fake) {
  const home = mkdtempSync(join(tmpdir(), "unclaimed-home-"));
  const dev = mkdtempSync(join(tmpdir(), "unclaimed-dev-"));
  const script = `
    import { Local, holderId, machineIdentity } from ${JSON.stringify(LOCAL)};
    const loop = Object.assign(Object.create(Local.prototype), {
      dev: ${JSON.stringify(dev)}, repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", notice: null,
      harness: "claude", wf: { FACTORY_LOCAL_MAX_CONCURRENT: "2", FACTORY_MAX_CONCURRENT: "2" }, opts: { token: "t" },
      holder: holderId(machineIdentity()), children: new Set(), firstSetup: new Map(), claimRetryMs: 0,
    });
    await loop.serve({ intervalMs: 60_000 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: fake.url, FACTORY_LOCAL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const exited = new Promise((r) => child.on("exit", (code, signal) => (clearTimeout(timer), r({ code, signal, out: () => out }))));
  return { child, exited };
}

test("serve stopped by SIGINT while its dispatch marks a pick Running starts nothing and puts it back to Queued, with no claim (#304)", { skip: process.platform === "win32" }, async () => {
  let child = null;
  let signalled = false;
  const fake = await fakeGitHub({
    // The Running label lands on GitHub; the stop comes before its answer reaches serve.
    hook: async (req, p) => {
      if (req.method === "POST" && p === "/repos/o/r/issues/7/labels" && !signalled) {
        signalled = true;
        child.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 300));
      }
    },
  });
  try {
    const run = childServe(fake);
    child = run.child;
    const end = await run.exited;
    assert.ok(signalled, end.out());
    assert.equal(end.code, 130, end.out());
    assert.ok(!fake.state.labels.has("factory:running"), `left Running with no claim:\n${end.out()}`);
    assert.equal(claims(fake.state).length, 0);
    assert.match(end.out(), /#7: stopping before it started; back to Queued/);
    assert.doesNotMatch(end.out(), /#7: resuming|could not start/);
  } finally {
    await fake.close();
  }
});

test("serve stopped by SIGINT while a pick reads its claim writes no claim and puts the Objective back to Queued (#304)", { skip: process.platform === "win32" }, async () => {
  let child = null;
  let signalled = false;
  const fake = await fakeGitHub({
    // The pick's claim read, after the dispatch marked it Running: the stop comes before its answer.
    hook: async (req, p, state) => {
      if (req.method === "GET" && p === "/repos/o/r/issues/7/comments" && state.labels.has("factory:running") && !signalled) {
        signalled = true;
        child.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 300));
      }
    },
  });
  try {
    const run = childServe(fake);
    child = run.child;
    const end = await run.exited;
    assert.ok(signalled, end.out());
    assert.equal(end.code, 130, end.out());
    assert.equal(claims(fake.state).length, 0, `a claim was written after the stop:\n${end.out()}`);
    assert.ok(!fake.state.writes.some((w) => w === "POST /repos/o/r/issues/7/comments"), "no claim write at all");
    assert.ok(!fake.state.labels.has("factory:running"), `left Running:\n${end.out()}`);
    assert.match(end.out(), /#7: stopping before its claim was written; back to Queued/);
  } finally {
    await fake.close();
  }
});

/** The real serve, one tick at a time in this process, against `fake`; the work stage itself is not run (`picks`). `extra`: the loop's own fields. */
async function serveTicks(fake, { ticks = 1, live = false, extra = {} } = {}) {
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL };
  process.env.GITHUB_API_URL = fake.url;
  process.env.FACTORY_LOCAL = "1";
  const dev = mkdtempSync(join(tmpdir(), "unclaimed-dev-"));
  if (live) {
    // A stage of #7 running on this machine (this test's own process stands in for it).
    const { processRecord } = await import("../scripts/lib/proc.mjs");
    const usage = join(dev, ".factory", "7", "usage-work-x");
    mkdirSync(usage, { recursive: true });
    writeFileSync(join(usage, STAGE_RECORD), JSON.stringify(processRecord(process.pid)));
  }
  const picks = [];
  const lines = [];
  const loop = Object.assign(Object.create(Local.prototype), {
    dev, repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", notice: null, harness: "claude",
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "2", FACTORY_MAX_CONCURRENT: "2" }, opts: { token: "t" }, holder: holderId(machineIdentity()),
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

const runningSince = (ms) => [{ event: "labeled", label: { name: "factory:running" }, actor: { login: "maintainer" }, created_at: new Date(Date.now() - ms).toISOString() }];

test("serve: a factory:local Objective Running for minutes with no claim and no stage anywhere is Queued again, said once, and picked (#304)", async () => {
  const fake = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running"], timeline: runningSince(10 * 60_000) });
  try {
    const { picks, log } = await serveTicks(fake, { ticks: 2 });
    const said = log.match(/#7: Running since \S+ with no claim and no stage on any machine \(a start that never wrote its claim\); back to Queued/g) || [];
    assert.equal(said.length, 1, log);
    assert.ok(fake.state.writes.includes("DELETE /repos/o/r/issues/7/labels/factory%3Arunning"), fake.state.writes.join("\n"));
    // Queued again: this loop's next pick takes it (and marks it Running anew), and nothing Blocks it.
    assert.deepEqual(picks, [7]);
    assert.ok(!fake.state.labels.has("factory:blocked"));
  } finally {
    await fake.close();
  }
});

test("serve: a Running Objective with a claim, a fresh Running label, or a stage on this machine is left alone (#304)", async () => {
  const other = "otherbox:4242:abcdef:m0:b0";
  const cases = [
    ["another machine's live claim", { comments: [{ id: 1, user: { login: "maintainer", type: "User" }, body: `${claimMarker(7)}\n${claimBody(other)}`, updated_at: new Date().toISOString() }], timeline: runningSince(10 * 60_000) }],
    ["another machine's stale claim", { comments: [{ id: 1, user: { login: "maintainer", type: "User" }, body: `${claimMarker(7)}\n${claimBody(other, new Date(Date.now() - 3 * 3600_000))}`, updated_at: new Date(Date.now() - 3 * 3600_000).toISOString() }], timeline: runningSince(10 * 60_000) }],
    ["a Running label two minutes old", { timeline: runningSince(2 * 60_000) }],
    ["a stage of it on this machine", { timeline: runningSince(10 * 60_000), live: true }],
  ];
  for (const [what, { comments = [], timeline, live = false }] of cases) {
    const fake = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running"], comments, timeline });
    try {
      const { picks, log } = await serveTicks(fake, { live });
      assert.ok(fake.state.labels.has("factory:running"), what);
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
 * other three, then adds factory:running).
 */
const labelDeletes = (state) => {
  const out = [];
  const del = (l) => `DELETE /repos/o/r/issues/7/labels/${encodeURIComponent(l)}`;
  const mark = ["factory:blocked", "factory:question", "factory:in-review"].map(del);
  for (const w of state.writes) {
    if (w === "POST /repos/o/r/issues/7/labels") {
      if (out.slice(-3).join() === mark.join()) out.splice(-3);
    } else if (w.startsWith("DELETE /repos/o/r/issues/7/labels/")) out.push(w);
  }
  return out;
};

test("serve: a listing older than GitHub never sweeps an Objective that has since left Running; only factory:running ever comes off (#304 review)", async () => {
  // The listing still shows Running; GitHub has a Question since, and the timeline shows the label's removal.
  const fake = await fakeGitHub({
    labels: ["factory:objective", "factory:local", "factory:question"],
    listed: ["factory:objective", "factory:local", "factory:running"],
    timeline: [labelEvent("labeled", "factory:running", ago(40 * 60_000)), labelEvent("unlabeled", "factory:running", ago(5_000)), labelEvent("labeled", "factory:question", ago(5_000))],
  });
  try {
    const { log } = await serveTicks(fake);
    assert.ok(fake.state.labels.has("factory:question"), log);
    assert.deepEqual(labelDeletes(fake.state), []);
    assert.doesNotMatch(log, /back to Queued/);
  } finally {
    await fake.close();
  }
  // The listing and the timeline agree it is Running, but a fresh read of the issue shows it In review too.
  const both = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running", "factory:in-review"], listed: ["factory:objective", "factory:local", "factory:running"], timeline: runningSince(40 * 60_000) });
  try {
    await serveTicks(both);
    assert.deepEqual(labelDeletes(both.state), []);
  } finally {
    await both.close();
  }
  // Swept: only the Running label is removed, never the other state labels.
  const swept = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running"], timeline: runningSince(40 * 60_000) });
  try {
    await serveTicks(swept);
    assert.deepEqual(labelDeletes(swept.state), ["DELETE /repos/o/r/issues/7/labels/factory%3Arunning"]);
  } finally {
    await swept.close();
  }
});

test("serve: the sweep's few minutes are on GitHub's clock, not this machine's (#304 review)", async () => {
  // This machine's clock is 10 minutes ahead of GitHub's: a label GitHub wrote 3 minutes ago reads 13 minutes old here.
  const fake = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running"], clockMs: -10 * 60_000, timeline: runningSince(13 * 60_000) });
  try {
    const { log } = await serveTicks(fake);
    assert.ok(fake.state.labels.has("factory:running"), log);
    assert.doesNotMatch(log, /back to Queued/);
  } finally {
    await fake.close();
  }
});

/** A loop whose work stage only records that it started (`started`), against `fake`; runObjective and its claim are real. */
async function startLoop(fake) {
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL };
  process.env.GITHUB_API_URL = fake.url;
  process.env.FACTORY_LOCAL = "1";
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
  state.timeline.push(labelEvent("unlabeled", "factory:running"), labelEvent("labeled", "factory:running"));
};
const claimOf = (login, holder) => ({ id: 90, user: { login, type: "User" }, body: `${claimMarker(7)}\n${claimBody(holder)}`, created_at: ago(1_000), updated_at: ago(1_000) });

test("a start that waited while another loop took the Objective again writes no claim over that loop's (#304 review)", async () => {
  let stalled = false;
  const fake = await fakeGitHub({
    labels: ["factory:objective", "factory:local", "factory:running"],
    timeline: runningSince(60_000),
    // The start's claim read answers with no claim, late: meanwhile the other loop (same login) takes it and claims.
    hook: async (req, p, state) => {
      if (req.method === "GET" && p === "/repos/o/r/issues/7/comments" && !stalled) {
        stalled = true;
        await new Promise((r) => setTimeout(r, 50));
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
    labels: ["factory:objective", "factory:local", "factory:running"],
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

test("a start with no other loop about claims and starts as before (#304 review)", async () => {
  const fake = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running"], timeline: runningSince(60_000) });
  const { loop, started, restore } = await startLoop(fake);
  try {
    assert.equal((await loop.runObjective(7)).exit, "delivered");
    assert.deepEqual(started, [7]);
  } finally {
    restore();
    await fake.close();
  }
});

test("serve stopped while its dispatch fails after marking a pick still puts that pick back to Queued (#310 review)", { skip: process.platform === "win32" }, async () => {
  let child = null;
  let signalled = false;
  const fake = await fakeGitHub({
    // The Running label lands, but GitHub answers 422: the dispatch throws after the mark.
    hook: async (req, p) => {
      if (req.method === "POST" && p === "/repos/o/r/issues/7/labels" && !signalled) {
        signalled = true;
        child.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 300));
        return { status: 422 };
      }
    },
  });
  try {
    const run = childServe(fake);
    child = run.child;
    const end = await run.exited;
    assert.ok(signalled, end.out());
    assert.equal(end.code, 130, end.out());
    assert.ok(!fake.state.labels.has("factory:running"), `left Running with no claim:\n${end.out()}`);
    assert.match(end.out(), /#7: stopping before it started; back to Queued/);
  } finally {
    await fake.close();
  }
});

test("serve stopped while its dispatch marks a pick that another loop has claimed meanwhile leaves that loop's Objective Running (#310 review)", { skip: process.platform === "win32" }, async () => {
  let child = null;
  let signalled = false;
  const fake = await fakeGitHub({
    hook: async (req, p, state) => {
      if (req.method === "POST" && p === "/repos/o/r/issues/7/labels" && !signalled) {
        signalled = true;
        state.comments.push(claimOf("other", "otherbox:4242:abcdef:m0:b0"));
        child.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 300));
      }
    },
  });
  try {
    const run = childServe(fake);
    child = run.child;
    const end = await run.exited;
    assert.ok(signalled, end.out());
    assert.equal(end.code, 130, end.out());
    assert.ok(fake.state.labels.has("factory:running"), `another loop's Objective was put back:\n${end.out()}`);
    assert.deepEqual(labelDeletes(fake.state), []);
    assert.match(end.out(), /#7: stopping before it started; a claim is on it \(otherbox:4242:abcdef:m0:b0\), so it stays as it is/);
  } finally {
    await fake.close();
  }
});

test("a resume whose stint cannot be read back after its claim keeps that claim as its own, and resumes it once stale (#310 re-review)", async () => {
  const id = machineIdentity();
  // This machine's earlier serve (its pid gone) paused #7: its claim, same login, an hour stale.
  const old = `${id.host}:999999:abcdef:${id.machine}:${id.boot}`;
  let reads = 0;
  const stale = (body) => body.replace(/heartbeat: \S+/, `heartbeat: ${ago(3600_000)}`);
  const fake = await fakeGitHub({
    labels: ["factory:objective", "factory:local", "factory:running"],
    timeline: runningSince(2 * 3600_000),
    comments: [{ id: 90, user: { login: "maintainer", type: "User" }, body: stale(`${claimMarker(7)}\n${claimBody(old)}`), created_at: ago(2 * 3600_000), updated_at: ago(3600_000) }],
    // The stint reads before the claim answer; every one after it fails.
    hook: (req, p) => {
      if (req.method === "GET" && p === "/repos/o/r/issues/7/timeline" && ++reads >= 3) return { status: 502 };
    },
  });
  const { loop, started, restore } = await startLoop(fake);
  try {
    assert.deepEqual(await loop.pausedHere(new Map()), [7]);
    assert.equal((await loop.runObjective(7)).exit, "skipped");
    assert.deepEqual(started, []);
    const c = claims(fake.state)[0];
    assert.match(c.body, new RegExp(`holder: ${loop.holder}`), "the claim stays, naming this loop");
    // Later, the claim stale and GitHub answering: this loop resumes it, rather than leaving it for the day's Block.
    reads = -1000;
    c.updated_at = ago(3600_000);
    c.body = stale(c.body);
    assert.deepEqual(await loop.pausedHere(new Map()), [7]);
  } finally {
    restore();
    await fake.close();
  }
});

test("serve: an issue labelled Running and another state at once, with no claim, is said once, not every tick (#310 re-review)", async () => {
  const fake = await fakeGitHub({ labels: ["factory:objective", "factory:local", "factory:running", "factory:in-review"], timeline: runningSince(40 * 60_000) });
  try {
    const { log } = await serveTicks(fake, { ticks: 3 });
    assert.equal((log.match(/#7: labelled factory:running and factory:in-review at once with no claim; left alone/g) || []).length, 1, log);
    assert.deepEqual(labelDeletes(fake.state), []);
  } finally {
    await fake.close();
  }
});

test("a resume that steps aside on a changed stint leaves its own claim resumable, never set aside for good (#310 re-review)", async () => {
  const id = machineIdentity();
  const old = `${id.host}:999999:abcdef:${id.machine}:${id.boot}`;
  const stale = (body) => body.replace(/heartbeat: \S+/, `heartbeat: ${ago(3600_000)}`);
  let changed = false;
  const fake = await fakeGitHub({
    labels: ["factory:objective", "factory:local", "factory:running"],
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
 * A repository's origin and a developer's clone of it, its default branch `main` with no Factory workflow; `addWorkflow`
 * pushes .github/workflows/factory.yml to it.
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
    writeFileSync(join(dev, ".github", "workflows", "factory.yml"), "name: Factory\nenv:\n  FACTORY_MODEL: m\njobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: clockgrove/factory@v0.9.30\n");
    git("add", ".github");
    git("commit", "-q", "-m", "workflow");
    git("push", "-q", "origin", "main");
  };
  return { dev, addWorkflow };
}

test("serve: where no Action runs (no factory.yml workflow, or a disabled one), the Objective it picks without factory:local is labelled factory:local, said once, and runs (#455)", async () => {
  for (const workflow of ["none", "disabled_manually"]) {
    // The default branch carries a workflow file all the same: only GitHub's answer counts.
    const repo = cloneOf();
    repo.addWorkflow();
    const fake = await fakeGitHub({ labels: ["factory:objective"], workflow });
    try {
      const { picks, log } = await serveTicks(fake, { ticks: 2, extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
      assert.deepEqual(picks, [7], `${workflow}: ${log}`);
      assert.ok(fake.state.labels.has("factory:local") && fake.state.labels.has("factory:running"), String(workflow));
      const added = fake.state.writes.filter((w) => w === "POST /repos/o/r/issues/7/labels");
      assert.equal(added.length, 2, "factory:local first, then the Running mark");
      // Factory's mark names that exact label event, so the scorer counts the label as Factory's.
      const event = fake.state.timeline.find((e) => e.event === "labeled" && e.label.name === "factory:local");
      assert.deepEqual(fake.state.comments.filter((c) => c.body.includes(":local-route:")).map((c) => c.body.split("\n")[0]), [`<!-- factory:7:local-route:${event.id} -->`]);
      assert.equal((log.match(/#7: no Action runs Objectives here, so this loop takes it and labels it factory:local/g) || []).length, 1, log);
      assert.match(log, /no Action runs Objectives in o\/r \(no active factory\.yml workflow\)/);
      assert.equal(process.env.FACTORY_LOCAL_ALL, undefined, "no routing flag: the label is the route");
    } finally {
      await fake.close();
    }
  }
});

test("serve: with the Action active, Objectives without factory:local are the Action's, said once per start; an unread answer labels nothing and takes nothing (#455)", async () => {
  // No workflow file on the default branch: GitHub's answer decides, never origin's tree.
  const repo = cloneOf();
  const fake = await fakeGitHub({ labels: ["factory:objective"], workflow: "active" });
  try {
    const { picks, log } = await serveTicks(fake, { ticks: 3, extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
    assert.deepEqual(picks, [], "never taken");
    assert.ok(!fake.state.labels.has("factory:local"));
    const said = log.split("\n").filter((l) => l.includes("without factory:local ("));
    assert.equal(said.length, 1, log);
    assert.match(said[0], /1 queued Objective without factory:local \(#7\) is the Action's: its factory\.yml workflow is active\. To run one on this machine instead, add factory:local to it\. \(serve --all is for a repository whose Action should not run Objectives: with the Action active, both would race/);
  } finally {
    await fake.close();
  }
  // A failed read, and a token without Actions: read (GitHub's 403 or 404): unknown, so nothing is labelled.
  for (const workflow of [500, 403, 404]) {
    const failing = await fakeGitHub({ labels: ["factory:objective"], workflow });
    try {
      const { picks, log } = await serveTicks(failing, { ticks: 2, extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
      assert.deepEqual(picks, [], `${workflow}: ${log}`);
      assert.ok(!failing.state.labels.has("factory:local"), String(workflow));
      assert.equal(process.env.FACTORY_LOCAL_ALL, undefined);
      assert.equal((log.match(/whether GitHub's Action runs Objectives in o\/r could not be read/g) || []).length, 1, log);
      assert.doesNotMatch(log, /is the Action's/, "nothing said that the read did not tell");
    } finally {
      await failing.close();
    }
  }
  assert.match(unroutedLine([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "live"), /^12 queued Objectives without factory:local \(#1, #2, #3, #4, #5, #6, #7, #8, #9, #10 and 2 more\) are the Action's/);
});

test("serve: an Objective labelled factory:local by a pick where no Action ran stays this machine's once the Action is active: a start that never wrote its claim is Queued again and picked here (#304, #455)", async () => {
  const repo = cloneOf();
  const fake = await fakeGitHub({ labels: ["factory:objective"], workflow: "none" });
  try {
    const first = await serveTicks(fake, { extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
    assert.deepEqual(first.picks, [7], first.log);
    // Its start died before its claim; the Action's workflow is enabled since, and the Running label is 10 minutes old.
    for (const e of fake.state.timeline) e.created_at = ago(10 * 60_000);
    fake.state.workflow = "active";
    repo.addWorkflow();
    const { picks, log } = await serveTicks(fake, { extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
    assert.match(log, /#7: Running since \S+ with no claim and no stage on any machine \(a start that never wrote its claim\); back to Queued/);
    assert.deepEqual(picks, [7], log);
    assert.ok(!fake.state.labels.has("factory:blocked"));
  } finally {
    await fake.close();
  }
});

test("local mode reads whether the Action runs for --repo's repository, whatever the clone's origin holds; factory run labels an Objective it runs where none does (#455)", async () => {
  const keys = ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "FACTORY_LOCAL_TOKEN", "GITHUB_API_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  // The clone's origin (a fork or mirror) carries the workflow; GitHub lists none for o/r.
  const repo = cloneOf();
  repo.addWorkflow();
  const fake = await fakeGitHub({ labels: ["factory:objective"], workflow: "none" });
  try {
    process.env.FACTORY_LOCAL_TOKEN = "t";
    process.env.GITHUB_API_URL = fake.url;
    const loop = new Local({ repo: "o/r", checkout: repo.dev });
    assert.equal(await loop.actionState(), "none");
    assert.deepEqual(fake.state.workflowReads, ["/repos/o/r/actions/workflows"]);
    assert.equal(await loop.actionState(), "none");
    assert.equal(fake.state.workflowReads.length, 1, "read once per settings interval, never per tick");
    await loop.adoptForRun(7, { labels: [{ name: "factory:objective" }] });
    assert.ok(fake.state.labels.has("factory:local"), "factory run's Objective is this machine's to tend");
    assert.ok(fake.state.comments.some((c) => c.body.startsWith("<!-- factory:7:local-route:")), "with Factory's mark of its label event");
    // The other way round: GitHub's Action active, no workflow file on origin.
    const bare = cloneOf();
    fake.state.workflow = "active";
    assert.equal(await new Local({ repo: "o/r", checkout: bare.dev }).actionState(), "live");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await fake.close();
  }
});

test("serve: a pick whose mark could not be posted, or whose label event the timeline did not show yet, starts all the same, and the loop that holds it writes the mark later, naming that exact event once (#455 review)", async () => {
  const marks = (state) => state.comments.filter((c) => c.body.includes(":local-route:"));
  const labelEvent = (state) => state.timeline.find((e) => e.event === "labeled" && e.label.name === "factory:local");
  for (const why of ["post", "lag"]) {
    const repo = cloneOf();
    let failing = why === "post";
    const fake = await fakeGitHub({
      labels: ["factory:objective"],
      workflow: "none",
      lag: why === "lag" ? 1 : 0,
      // The mark's posts fail during the pick, retries included, before they land (GitHub's 502): each write is taken
      // back, its answer an error.
      hook: (req, p, state) => {
        if (!failing || req.method !== "POST" || p !== "/repos/o/r/issues/7/comments") return;
        setImmediate(() => state.comments.splice(state.comments.findIndex((c) => c.body.includes(":local-route:")), 1));
        return { status: 502 };
      },
    });
    try {
      const { picks, log, loop } = await serveTicks(fake, { extra: { dev: repo.dev, settingsBranch: "main", settingsEveryMs: 0 } });
      assert.deepEqual(picks, [7], `${why}: the pick starts: ${log}`);
      assert.ok(fake.state.labels.has("factory:local"));
      assert.equal(marks(fake.state).length, 0, why);
      assert.match(log, why === "post" ? /#7: no Action runs Objectives here, so this loop takes it and labels it factory:local; Factory's mark of that label is not written yet \(the mark could not be posted/ : /#7: no Action runs Objectives here, so this loop takes it and labels it factory:local; Factory's mark of that label is not written yet \(the timeline does not show this login's factory:local label event yet\)/);
      assert.doesNotMatch(log, /could not be added/, "the label is on: never said otherwise");
      failing = false;
      // The loop that holds it (its claim's start, then each heartbeat) writes the mark, once.
      const api = process.env.GITHUB_API_URL;
      process.env.GITHUB_API_URL = fake.url;
      try {
        await loop.backfillMark(7);
        await loop.backfillMark(7);
      } finally {
        api === undefined ? delete process.env.GITHUB_API_URL : (process.env.GITHUB_API_URL = api);
      }
      assert.deepEqual(marks(fake.state).map((c) => c.body.split("\n")[0]), [`<!-- factory:7:local-route:${labelEvent(fake.state).id} -->`], why);
    } finally {
      await fake.close();
    }
  }
});

test("Factory's local-route mark names only the label on now, and only this login's: never one taken off since, never a person's; no login, no mark (#455 review)", async () => {
  const { localRouteEvent, markLocalRoute } = await import("../scripts/lib/local.mjs");
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const me = { login: "maintainer", type: "User" };
  const ev = (id, event, actor = me) => ({ id, event, label: { name: "factory:local" }, actor });
  setSelf("maintainer");
  try {
    assert.deepEqual(localRouteEvent([ev(1, "labeled"), ev(2, "unlabeled"), ev(3, "labeled")]), { id: "3", mine: true });
    assert.equal(localRouteEvent([ev(1, "labeled"), ev(2, "unlabeled")]), null, "taken off since: no label on");
    assert.deepEqual(localRouteEvent([ev(1, "labeled"), ev(2, "unlabeled"), ev(3, "labeled", { login: "someone", type: "User" })]), { id: "3", mine: false });
    setSelf(null);
    const repo = { owner: "o", name: "r", full: "o/r" };
    const saved = process.env.GITHUB_API_URL;
    const fake = await fakeGitHub({ labels: ["factory:objective", "factory:local"], timeline: [ev(5, "labeled")], hook: (req, p) => (p === "/user" ? { status: 500 } : undefined) });
    process.env.GITHUB_API_URL = fake.url;
    try {
      const r = await markLocalRoute(repo, 7, { token: "t" });
      assert.equal(r.marked, false);
      assert.match(r.why, /Factory's own login could not be read/);
      assert.equal(fake.state.comments.length, 0, "no mark accepting any actor");
    } finally {
      saved === undefined ? delete process.env.GITHUB_API_URL : (process.env.GITHUB_API_URL = saved);
      await fake.close();
    }
  } finally {
    setSelf(null);
  }
});
