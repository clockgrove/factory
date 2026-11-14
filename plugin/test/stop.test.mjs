// Stopping one Objective (#207): removing its factory:objective label, or closing its issue. The running stage sees it
// on its watch, ends its harness passes (spend recorded), leaves its PR a draft and exits; no tick, loop or relaunch
// picks it up again; the dispatcher tidies a stopped one no stage holds.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { STOP_GRACE_MS, applyStop, claimExit, holdIfStopped, requestStageStop, resetStageStop, stageStopped, stopCause, stopText, stoppedRecords, watchObjective } from "../scripts/lib/stop.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

RETRY.sleep = async () => {};

const issue = (labels, state = "open", number = 7) => ({ number, state, labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });

test("stopCause: a closed issue or one without its Objective label is stopped; labels as names or objects", () => {
  assert.equal(stopCause(issue(["factory:objective", "factory:running"]), "factory:objective"), null);
  assert.equal(stopCause(issue(["factory:running"]), "factory:objective"), "unlabeled");
  assert.equal(stopCause(issue(["factory:objective"], "closed"), "factory:objective"), "closed", "closing stops it, label or not");
  assert.equal(stopCause({ state: "open", labels: ["factory:objective"] }, "factory:objective"), null);
  assert.equal(stopCause({ state: "open", labels: ["my:objective"] }, "my:objective"), null, "the workflow's own Objective label");
  assert.equal(stopCause(null, "factory:objective"), null, "no read is no stop");
  assert.equal(stopText("closed"), "the issue was closed");
  assert.equal(stopText("unlabeled", "factory:objective"), "`factory:objective` was removed");
});

test("watchObjective: the first read that shows the stop calls onStop once; a failed read is no answer", async () => {
  const reads = [issue(["factory:objective"]), new Error("502"), issue(["factory:objective"]), issue([]), issue([], "closed")];
  const seen = [];
  let i = 0;
  await new Promise((done) => {
    watchObjective({
      read: async () => {
        const r = reads[Math.min(i++, reads.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
      label: "factory:objective",
      everyMs: 5,
      onStop: (cause) => {
        seen.push(cause);
        setTimeout(done, 40);
      },
    });
  });
  assert.deepEqual(seen, ["unlabeled"], "called once, on the fourth read, never again");
  assert.equal(i, 4);
  // A watch stopped before any stop never calls back.
  let called = false;
  const w = watchObjective({ read: async () => issue([]), label: "factory:objective", everyMs: 5, onStop: () => (called = true) });
  w.stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(called, false);
});

test("the stage's stop: asked once, its exit claimed once, and the main flow parked after it", async () => {
  resetStageStop();
  try {
    let passed = false;
    await holdIfStopped().then(() => (passed = true));
    assert.equal(passed, true, "a running stage goes on");
    assert.equal(requestStageStop("unlabeled"), true);
    assert.equal(requestStageStop("closed"), false, "the first cause stands");
    assert.equal(stageStopped(), "unlabeled");
    let after = false;
    holdIfStopped().then(() => (after = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(after, false, "after the stop the stage's flow makes no more changes");
    assert.equal(claimExit(), true);
    assert.equal(claimExit(), false, "the stage's end is written once");
  } finally {
    resetStageStop();
  }
});

test("stoppedRecords: a pass the stop ended before it reported dollars counts its live reading, a lower bound; nothing else changes", () => {
  const passes = [
    { label: "work-1", usd: 1.5, ok: true },
    { label: "work-2", usd: null, stopped: true, stoppedUsd: 0.75, basis: "unmetered" },
    { label: "fix", usd: 0, stopped: true, noRun: true, stoppedUsd: 9 },
    { label: "plan", usd: null, stopped: true },
    { label: "codex", usd: 0.2, stopped: true, stoppedUsd: 0.5 },
  ];
  const out = stoppedRecords(passes);
  assert.deepEqual(out[0], passes[0]);
  assert.equal(out[1].usd, 0.75);
  assert.equal(out[1].usdLowerBound, true);
  assert.match(out[1].basis, /lower bound: the stage was stopped/);
  assert.deepEqual(out[2], passes[2], "a pass that never ran spent nothing");
  assert.deepEqual(out[3], passes[3], "no reading: left as it was");
  assert.deepEqual(out[4], passes[4], "a pass that reported dollars keeps them");
});

/** A fetch fake over one repository: `issues(label)` lists open issues, `pr(n)` the factory/<n> branch's open PR. */
function fakeApi({ issues = () => [], closed = [], pr = () => null, timeline = () => [], queued = new Set() }) {
  const writes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") {
      if (/convertPullRequestToDraft/.test(body?.query || "")) writes.push(`draft ${body.variables.id}`);
      if (/dequeuePullRequest/.test(body?.query || "")) writes.push(`dequeue ${body.variables.id}`);
      if (/mergeQueueEntry \{/.test(body?.query || "")) return json({ data: { repository: { pullRequest: { mergeQueueEntry: queued.has(body.variables.n) ? { state: "QUEUED" } : null } } } });
      if (/moveCard|updateProjectV2ItemFieldValue/.test(body?.query || "")) writes.push("card");
      return json({ data: {} });
    }
    if (method !== "GET") writes.push(`${method} ${decodeURIComponent(u.pathname).replace("/repos/acme/app", "")}`);
    if (method === "GET" && u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? closed : issues(u.searchParams.get("labels")));
    if (method === "GET" && u.pathname === "/repos/acme/app/pulls") {
      const n = Number(/factory\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1]);
      const p = pr(n);
      return json(p ? [p] : []);
    }
    const one = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(u.pathname);
    if (method === "GET" && one) return json({ number: Number(one[1]), draft: false, node_id: `PR_${one[1]}` });
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json(timeline(Number(/issues\/(\d+)\//.exec(u.pathname)[1])));
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
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

test("applyStop: the open PR leaves the merge queue and goes back to a draft without the review label; the state label comes off; a closed issue's labels are the Done pass's", async () => {
  await withApi({}, async () => {
    const api = fakeApi({ pr: (n) => (n === 7 ? { number: 70, draft: false, node_id: "PR_70" } : null), queued: new Set([70]) });
    try {
      assert.deepEqual(await applyStop({ owner: "acme", name: "app", full: "acme/app" }, 7, { project: null }, { token: "t" }), []);
      assert.deepEqual(api.writes, ["dequeue PR_70", "draft PR_70", "DELETE /issues/70/labels/factory:review", "DELETE /issues/7/labels/factory:running", "DELETE /issues/7/labels/factory:blocked", "DELETE /issues/7/labels/factory:question", "DELETE /issues/7/labels/factory:in-review"]);
      api.writes.length = 0;
      await applyStop({ owner: "acme", name: "app", full: "acme/app" }, 7, { closed: true, project: null }, { token: "t" });
      assert.deepEqual(api.writes, ["dequeue PR_70", "draft PR_70", "DELETE /issues/70/labels/factory:review"], "a closed issue: only its PR");
      api.writes.length = 0;
      await applyStop({ owner: "acme", name: "app", full: "acme/app" }, 8, { closed: true, project: null }, { token: "t" });
      assert.deepEqual(api.writes, [], "no PR, nothing to do");
    } finally {
      api.restore();
    }
  });
});

test("dispatcher: a stopped Objective In review is left a draft and Queued at once; a stopped Running one only once its stage had time to stop itself; a closed one's PR a draft", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  // #7 In review and #8 Running lost their label just now; #9 Running lost it long ago (its stage died); #10 is still an
  // Objective; #11 is a local loop's, its label off long ago (another route's to a local loop without --all).
  const open = { "factory:objective": [issue(["factory:objective"], "open", 10)], "factory:in-review": [issue(["factory:in-review"], "open", 7)], "factory:running": [issue(["factory:running"], "open", 8), issue(["factory:running"], "open", 9), issue(["factory:running", "factory:local"], "open", 11)] };
  const run = (env) =>
    withApi(env, async () => {
      const api = fakeApi({
        issues: (label) => open[label] || [],
        // #12 closed by a person while In review, its PR still open.
        closed: [issue(["factory:objective", "factory:in-review"], "closed", 12)],
        pr: (n) => (n === 7 || n === 9 || n === 12 ? { number: n * 10, draft: false, node_id: `PR_${n * 10}` } : null),
        timeline: (n) => [{ event: "labeled", label: { name: "factory:objective" }, created_at: ago(3 * 3600_000) }, { event: "unlabeled", label: { name: "factory:objective" }, created_at: n === 9 || n === 11 ? ago(STOP_GRACE_MS + 60_000) : ago(60_000) }],
      });
      try {
        const r = await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
        return { r, writes: api.writes };
      } finally {
        api.restore();
      }
    });
  const actions = await run({});
  assert.deepEqual(actions.r.stopped, [7, 9, 11]);
  const on = (writes, n) => writes.filter((w) => w.includes(`/issues/${n}/`) || w.includes(`PR_${n * 10}`) || w.includes(`/issues/${n * 10}/`));
  assert.ok(on(actions.writes, 7).includes("draft PR_70") && on(actions.writes, 7).includes("DELETE /issues/70/labels/factory:review"), "its PR a draft, unlabelled for review");
  assert.ok(on(actions.writes, 7).includes("DELETE /issues/7/labels/factory:in-review"));
  assert.deepEqual(on(actions.writes, 8), [], "a stage may still be stopping itself");
  assert.ok(on(actions.writes, 9).includes("DELETE /issues/9/labels/factory:running") && on(actions.writes, 9).includes("draft PR_90"));
  assert.deepEqual(actions.r.ready, [10], "the Objective that is not stopped is picked; a stopped one never is");
  // Closing the issue stops it too: the Done pass leaves its open PR a draft without the review label.
  assert.deepEqual(actions.r.done, [12]);
  assert.ok(actions.writes.includes("draft PR_120") && actions.writes.includes("DELETE /issues/120/labels/factory:review"));
  // A local loop tends only the Objectives it routes.
  const local = await run({ FACTORY_LOCAL: "1" });
  assert.deepEqual(local.r.stopped, [11]);
});

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const LIB = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;

test("a stopped stage's harness pass ends at once, its live reading kept; no pass starts after the stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-pass-"));
  mkdirSync(join(root, "bin"));
  // A fake Codex that reports one turn, then runs on for a minute unless it is ended; each start is counted.
  writeFileSync(
    join(root, "bin", "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_STATE + "/starts", "x");
console.log(JSON.stringify({ type: "thread.started", thread_id: "01a1c6ba-16b2-7a13-b2da-47bf51b4e724" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 0, output_tokens: 5000, reasoning_output_tokens: 0 } }));
setTimeout(() => {}, 60000);
`,
    { mode: 0o755 },
  );
  const script = `
    import { runHarness, stageSpendSoFar, stagePasses } from ${JSON.stringify(LIB("harness.mjs"))};
    import { requestStageStop } from ${JSON.stringify(LIB("stop.mjs"))};
    const root = process.env.FAKE_STATE;
    const pass = (label) => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: root, env: { PATH: process.env.PATH, FAKE_STATE: root }, timeoutMs: 120_000, label });
    const started = Date.now();
    const run = pass("work-1");
    while (!((await stageSpendSoFar()).usd > 0) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 20));
    requestStageStop("unlabeled");
    const first = await run;
    const second = await pass("work-2");
    process.stdout.write(JSON.stringify({ ms: Date.now() - started, first: { stopped: first.stopped, usd: first.usd }, second: { stopped: second.stopped, noRun: second.noRun, usd: second.usd }, passes: stagePasses().map((p) => p.label) }) + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, FAKE_STATE: root, CODEX_HOME: join(root, "codex") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, err);
  const r = JSON.parse(out.trim().split("\n").at(-1));
  assert.ok(r.ms < 40_000, `the pass ran on after the stop (${r.ms} ms)`);
  assert.equal(r.first.stopped, true);
  assert.ok(r.first.usd > 0, "the stopped pass's spend is recorded");
  assert.deepEqual(r.second, { stopped: true, noRun: true, usd: 0 });
  assert.equal(readFileSync(join(root, "starts"), "utf8"), "x", "the harness started once: no pass after the stop");
  assert.deepEqual(r.passes, ["work-1", "work-2"], "every pass is the stage's record");
  assert.ok(existsSync(root));
});

test("stopStage: the stage's end on a stop: its passes settled into its records with their spend, its PR a draft, finish('stopped'); once only", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-stage-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin", "codex"),
    `#!${process.execPath}
console.log(JSON.stringify({ type: "thread.started", thread_id: "01a1c6ba-16b2-7a13-b2da-47bf51b4e724" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 0, output_tokens: 5000, reasoning_output_tokens: 0 } }));
setTimeout(() => {}, 60000);
`,
    { mode: 0o755 },
  );
  const script = `
    import { runHarness, stageSpendSoFar } from ${JSON.stringify(LIB("harness.mjs"))};
    import { stopStage } from ${JSON.stringify(LIB("session.mjs"))};
    const writes = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      const body = init.body ? JSON.parse(init.body) : null;
      if (u.pathname === "/graphql") {
        if (/convertPullRequestToDraft/.test(body?.query || "")) writes.push("draft " + body.variables.id);
        return json({ data: {} });
      }
      if (method !== "GET") writes.push(method + " " + decodeURIComponent(u.pathname));
      if (u.pathname === "/repos/acme/app/pulls/70") return json({ number: 70, draft: false, node_id: "PR_70" });
      return json([]);
    };
    process.env.GITHUB_API_URL = "https://github.test";
    const root = process.env.FAKE_STATE;
    const records = [];
    const run = runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 120_000, label: "work-1" });
    const started = Date.now();
    while (!((await stageSpendSoFar()).usd > 0) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 20));
    const ends = [];
    const finish = async (exit, reason) => ends.push({ exit, reason, records: records.map((r) => ({ label: r.label, stopped: r.stopped, usd: r.usd })) });
    const repo = { owner: "acme", name: "app", full: "acme/app" };
    const took = await stopStage({ cause: "unlabeled", label: "factory:objective", repo, issue: 7, pr: { number: 70 }, records, finish, opts: { token: "t" } });
    const again = await stopStage({ cause: "closed", label: "factory:objective", repo, issue: 7, pr: { number: 70 }, records, finish, opts: { token: "t" } });
    await run;
    process.stdout.write(JSON.stringify({ took, again, ms: Date.now() - started, ends, writes }) + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, FAKE_STATE: root, CODEX_HOME: join(root, "codex") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  assert.equal(await new Promise((r) => child.on("exit", r)), 0, err);
  const r = JSON.parse(out.trim().split("\n").at(-1));
  assert.equal(r.took, true);
  assert.equal(r.again, false, "a second stop writes nothing");
  assert.ok(r.ms < 40_000, `the stop waited on the pass (${r.ms} ms)`);
  assert.equal(r.ends.length, 1);
  assert.equal(r.ends[0].exit, "stopped");
  assert.equal(r.ends[0].reason, "`factory:objective` was removed");
  assert.equal(r.ends[0].records.length, 1, "the pass still running at the stop is in the records");
  assert.equal(r.ends[0].records[0].stopped, true);
  assert.ok(r.ends[0].records[0].usd > 0, "with its spend");
  assert.ok(r.writes.includes("draft PR_70") && r.writes.includes("DELETE /repos/acme/app/issues/70/labels/factory:review"), r.writes.join("\n"));
  assert.ok(r.writes.includes("DELETE /repos/acme/app/issues/7/labels/factory:running"));
});

test("local loop: a stopped Objective's labelled PR gets no review, and a stopped Objective it held is not resumed", async () => {
  const { Local, holderId } = await import("../scripts/local.mjs");
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const loop = Object.assign(Object.create(Local.prototype), { repo: { owner: "acme", name: "app", full: "acme/app" }, repoFull: "acme/app", opts: { token: "t" }, wf: {}, holder: "this-loop", baseEnv: () => ({ FACTORY_LOCAL_ALL: "1" }) });
  // Both held by a loop of this machine that went away (a pid long gone): ones to resume, unless stopped.
  const away = holderId(undefined, 2 ** 22 + 7);
  const claim = (n) => ({ id: n, user: { login: "maintainer", type: "User" }, updated_at: new Date(Date.now() - 3600_000).toISOString(), body: `<!-- factory:${n}:local -->\n${claimBody(away, new Date(Date.now() - 3600_000))}` });
  const pull = (n) => ({ number: n * 10, draft: false, head: { ref: `factory/${n}` }, labels: [{ name: "factory:review" }] });
  await withApi({ FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/repos/acme/app/pulls") return json([pull(7), pull(8), pull(9)]);
      const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(u.pathname);
      if (one) return json(issue(Number(one[1]) === 7 ? ["factory:objective", "factory:in-review"] : Number(one[1]) === 8 ? ["factory:in-review"] : ["factory:objective"], Number(one[1]) === 9 ? "closed" : "open", Number(one[1])));
      if (u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("labels") === "factory:running" ? [issue(["factory:running"], "open", 8), issue(["factory:objective", "factory:running"], "open", 7)] : []);
      if (u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (u.pathname === "/user") return json({ login: "maintainer", type: "User" });
      const comments = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(u.pathname);
      if (comments) return json([claim(Number(comments[1]))]);
      return json([]);
    };
    try {
      assert.deepEqual(await loop.pendingReviews(), [{ issue: 7, pr: 70 }], "#8 lost its label, #9 is closed: no review for either");
      assert.deepEqual(await loop.pausedHere(new Map()), [7], "#8 lost its label: not resumed");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
