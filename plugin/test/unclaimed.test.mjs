// No Objective is left Running with no claim (#304): a serve stopped between its dispatch's Running label and the
// claim puts the Objective back to Queued, and a serve's tick takes a factory:local Objective that has been Running a
// few minutes with no claim and no stage anywhere as Queued again.
import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
 */
async function fakeGitHub({ labels = ["factory:objective", "factory:local"], listed = null, comments = [], timeline = [], clockMs = 0, hook = () => {} } = {}) {
  const state = { labels: new Set(labels), listed: listed && new Set(listed), comments, timeline, writes: [] };
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
      if (p === "/repos/o/r/collaborators") return send(200, [{ login: "maintainer", permissions: { push: true } }, { login: "other", permissions: { push: true } }]);
      if (p === "/repos/o/r/issues" && req.method === "GET") {
        const want = (url.searchParams.get("labels") || "").split(",").filter(Boolean);
        const shown = state.listed || state.labels;
        return send(200, url.searchParams.get("state") !== "closed" && want.every((l) => shown.has(l)) ? [{ ...issue(), labels: [...shown].map((name) => ({ name })) }] : []);
      }
      if (p === "/repos/o/r/issues/7" && req.method === "GET") return send(200, issue());
      if (p === "/repos/o/r/issues/7/labels" && req.method === "POST") {
        for (const l of body.labels) state.labels.add(l), state.timeline.push({ event: "labeled", label: { name: l }, actor: { login: "maintainer" }, created_at: new Date().toISOString() });
        return send(200, []);
      }
      const label = /^\/repos\/o\/r\/issues\/7\/labels\/(.+)$/.exec(p);
      if (label && req.method === "DELETE") {
        const l = decodeURIComponent(label[1]);
        if (!state.labels.delete(l)) return send(404, { message: "Not Found" });
        state.timeline.push({ event: "unlabeled", label: { name: l }, actor: { login: "maintainer" }, created_at: new Date().toISOString() });
        return send(200, []);
      }
      if (p === "/repos/o/r/issues/7/timeline") return send(200, state.timeline);
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
      holder: holderId(machineIdentity()), children: new Set(), firstSetup: new Map(), claimRetryMs: 0, claimSettleMs: 0,
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

/** The real serve, one tick at a time in this process, against `fake`; the work stage itself is not run (`picks`). */
async function serveTicks(fake, { ticks = 1, live = false } = {}) {
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL };
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
    children: new Set(), firstSetup: new Map(), claimRetryMs: 0, claimSettleMs: 0,
    stopOnSignals: () => {},
    cleanup: async () => {},
    runObjective: async (n) => (picks.push(n), { exit: "skipped" }),
  });
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    for (let i = 0; i < ticks; i += 1) await loop.serve({ once: true });
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  return { picks, log: lines.join("") };
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
    wf: {}, opts: { token: "t" }, holder: holderId(machineIdentity()), children: new Set(), firstSetup: new Map(), claimRetryMs: 0, claimSettleMs: 0, stopping: false,
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
