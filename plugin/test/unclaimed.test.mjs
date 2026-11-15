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
 * on every request as it arrives and may return a promise its answer waits for (its write is made at once).
 */
async function fakeGitHub({ labels = ["factory:objective", "factory:local"], comments = [], timeline = [], hook = () => {} } = {}) {
  const state = { labels: new Set(labels), comments, timeline, writes: [] };
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
      const send = (status, b) => void gate.then(() => res.writeHead(status, { "content-type": "application/json" }).end(b === undefined ? "" : JSON.stringify(b)));
      if (p === "/user") return send(200, { login: "maintainer", type: "User" });
      if (p === "/repos/o/r/collaborators") return send(200, [{ login: "maintainer", permissions: { push: true } }]);
      if (p === "/repos/o/r/issues" && req.method === "GET") {
        const want = (url.searchParams.get("labels") || "").split(",").filter(Boolean);
        return send(200, url.searchParams.get("state") !== "closed" && want.every((l) => state.labels.has(l)) ? [issue()] : []);
      }
      if (p === "/repos/o/r/issues/7" && req.method === "GET") return send(200, issue());
      if (p === "/repos/o/r/issues/7/labels" && req.method === "POST") {
        for (const l of body.labels) state.labels.add(l), state.timeline.push({ event: "labeled", label: { name: l }, actor: { login: "maintainer" }, created_at: new Date().toISOString() });
        return send(200, []);
      }
      const label = /^\/repos\/o\/r\/issues\/7\/labels\/(.+)$/.exec(p);
      if (label && req.method === "DELETE") return state.labels.delete(decodeURIComponent(label[1])) ? send(200, []) : send(404, { message: "Not Found" });
      if (p === "/repos/o/r/issues/7/timeline") return send(200, state.timeline);
      if (p === "/repos/o/r/issues/7/comments" && req.method === "GET") return send(200, state.comments);
      if (p === "/repos/o/r/issues/7/comments" && req.method === "POST") {
        const c = { id: (id += 1), user: { login: "maintainer", type: "User" }, body: body.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
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
