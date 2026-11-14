// A stopped stage makes no change after its stop (#222 review): its flow parks after a pass the stop ended, starts no
// command, push or PR change, never merges a stopped Objective, never overrides an exit of its own already under way,
// writes its spend before its GitHub tidy, and writes what it knows at once when its end runs out of time.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const LIB = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;

/** A fake Codex that reports one turn and runs on for a minute unless it is ended. */
function fakeCodex(root) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(
    join(root, "bin", "codex"),
    `#!${process.execPath}
console.log(JSON.stringify({ type: "thread.started", thread_id: "01a1c6ba-16b2-7a13-b2da-47bf51b4e724" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 0, output_tokens: 5000, reasoning_output_tokens: 0 } }));
if (process.env.FAKE_STUBBORN) process.on("SIGTERM", () => {});
setTimeout(() => {}, 60000);
`,
    { mode: 0o755 },
  );
}

/** Run `script` (an ES module body) in its own process; resolves with its last stdout line as JSON. */
async function stage(script, root, timeoutMs = 90_000) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, FAKE_STATE: root, CODEX_HOME: join(root, "codex"), GITHUB_API_URL: "https://github.test" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  const last = out.trim().split("\n").at(-1);
  let json = null;
  try {
    json = JSON.parse(last);
  } catch {
    json = null;
  }
  return { code, json, out, err };
}

// A fetch fake for a child process: GitHub calls recorded; `issue` the Objective's labels; `hang` paths never answer.
const FETCH = (issueLabels, hang = "") => `
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push(method + " " + decodeURIComponent(u.pathname) + (u.pathname === "/graphql" ? " " + (/mutation\\(\\$id: ID!\\) \\{ (\\w+)/.exec(body?.query || "")?.[1] || "query") : ""));
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (${JSON.stringify(hang)} && u.pathname.includes(${JSON.stringify(hang)})) return new Promise(() => {});
    if (u.pathname === "/graphql") return json({ data: {} });
    if (u.pathname === "/repos/acme/app/issues/7") return json({ number: 7, state: "open", labels: ${JSON.stringify(issueLabels)}.map((name) => ({ name })) });
    if (u.pathname === "/repos/acme/app/pulls/70") return json({ number: 70, state: "open", draft: false, node_id: "PR_70", mergeable_state: "clean", head: { sha: "a".repeat(40) }, labels: [] });
    return json([]);
  };
`;

test("validation: a fix pass the stop ends is the stage's last step; the validation command does not run again (the reviewer's repro)", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-val-"));
  fakeCodex(root);
  const script = `
    import { validationLoop } from ${JSON.stringify(LIB("session.mjs"))};
    import { passesRunning, stagePasses } from ${JSON.stringify(LIB("harness.mjs"))};
    import { requestStageStop } from ${JSON.stringify(LIB("stop.mjs"))};
    const root = process.env.FAKE_STATE;
    const loop = validationLoop({ checkout: root, commands: ["echo ran >> " + root + "/ran; exit 1"], harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env: { PATH: process.env.PATH, FAKE_STATE: root }, deadlineAt: Date.now() + 600_000, eventsFile: root + "/events.jsonl", maxPasses: 2 });
    let ended = false;
    loop.then(() => (ended = true), () => (ended = true));
    const t0 = Date.now();
    while (passesRunning() === 0 && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    requestStageStop("unlabeled");
    while (passesRunning() > 0 && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(JSON.stringify({ ended, passes: stagePasses().length }) + "\\n");
    process.exit(0);
  `;
  const r = await stage(script, root);
  assert.ok(r.json, r.err);
  assert.equal(readFileSync(join(root, "ran"), "utf8"), "ran\n", "the command ran once, before the fix pass, and never after the stop");
  assert.equal(r.json.ended, false, "the loop never goes on to its next step");
  assert.equal(r.json.passes, 1);
});

test("after the stop no repository command starts, no PR is opened or rewritten and no reply is posted", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-guards-"));
  const script = `
    import { sh } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib", "checkout.mjs")).href)};
    import { publishPr, postReplies } from ${JSON.stringify(LIB("handoff.mjs"))};
    import { requestStageStop } from ${JSON.stringify(LIB("stop.mjs"))};
    ${FETCH(["factory:objective"])}
    const root = process.env.FAKE_STATE;
    const repo = { owner: "acme", name: "app", full: "acme/app" };
    requestStageStop("unlabeled");
    const settled = [];
    sh(root, "echo ran >> " + root + "/ran").then(() => settled.push("sh"));
    publishPr(repo, { branch: "factory/7", base: "main", issue: 7, issueTitle: "t", prText: "Title\\n\\nBody" }, { token: "t" }).then(() => settled.push("publish"));
    postReplies(repo, 70, 7, JSON.stringify([{ id: 1, body: "done" }]), [1], { token: "t" }).then(() => settled.push("replies"));
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(JSON.stringify({ settled, calls }) + "\\n");
    process.exit(0);
  `;
  const r = await stage(script, root, 30_000);
  assert.ok(r.json, r.err);
  assert.deepEqual(r.json.settled, []);
  assert.deepEqual(r.json.calls, [], "no GitHub call");
  assert.equal(existsSync(join(root, "ran")), false, "no command ran");
});

test("confirmRunning and the merge pass: a stopped Objective asks for the stop and never merges; a running one goes on", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-merge-"));
  const script = (labels) => `
    import { confirmRunning } from ${JSON.stringify(LIB("stop.mjs"))};
    import { mergeReadyOne } from ${JSON.stringify(LIB("session.mjs"))};
    import { getIssue } from ${JSON.stringify(LIB("github.mjs"))};
    ${FETCH(labels)}
    const repo = { owner: "acme", name: "app", full: "acme/app" };
    const asked = [];
    let confirmed = null;
    confirmRunning({ read: () => getIssue(repo, 7, { token: "t" }), label: "factory:objective", onStop: (c) => asked.push(c) }).then((v) => (confirmed = v));
    const how = await mergeReadyOne(repo, { issue: 7, prNumber: 70, queue: false, objectiveLabel: "factory:objective" }, { token: "t" });
    await new Promise((r) => setTimeout(r, 200));
    process.stdout.write(JSON.stringify({ asked, confirmed, how, calls }) + "\\n");
    process.exit(0);
  `;
  const stopped = await stage(script([]), root, 30_000);
  assert.ok(stopped.json, stopped.err);
  assert.deepEqual(stopped.json.asked, ["unlabeled"]);
  assert.equal(stopped.json.confirmed, null, "the caller parks");
  assert.equal(stopped.json.how, "stopped");
  assert.ok(!stopped.json.calls.some((c) => /merge|enqueue/i.test(c.replace("/pulls/70", ""))), stopped.json.calls.join("\n"));
  const live = await stage(script(["factory:objective"]), root, 30_000);
  assert.deepEqual(live.json.asked, []);
  assert.equal(live.json.confirmed, true);
  assert.notEqual(live.json.how, "stopped");
});

test("stopStage: a stop racing the stage's own exit (being applied, or its merge) ends nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-commit-"));
  const script = `
    import { stopStage } from ${JSON.stringify(LIB("session.mjs"))};
    import { commitExit } from ${JSON.stringify(LIB("stop.mjs"))};
    ${FETCH(["factory:objective"])}
    const repo = { owner: "acme", name: "app", full: "acme/app" };
    commitExit();
    const ends = [];
    const took = await stopStage({ cause: "closed", label: "factory:objective", repo, issue: 7, pr: { number: 70 }, records: [], finish: async (e) => ends.push(e), opts: { token: "t" } });
    process.stdout.write(JSON.stringify({ took, ends, calls, again: commitExit() }) + "\\n");
    process.exit(0);
  `;
  const r = await stage(script, root, 30_000);
  assert.ok(r.json, r.err);
  assert.deepEqual(r.json, { took: false, ends: [], calls: [], again: true });
});

test("stopStage: the usage and spend line first, then a tidy bounded in time; a pass still running counts at its live reading; an end that runs out of time is written at once", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-money-"));
  fakeCodex(root);
  // The PR's draft mutation never answers: the tidy hangs.
  const script = (finishHangs) => `
    import { runHarness, stageSpendSoFar } from ${JSON.stringify(LIB("harness.mjs"))};
    import { stopStage } from ${JSON.stringify(LIB("session.mjs"))};
    ${FETCH(["factory:objective"], "/graphql")}
    const root = process.env.FAKE_STATE;
    const repo = { owner: "acme", name: "app", full: "acme/app" };
    // A pass whose process ignores the stop's SIGTERM: still running when the short settle ends.
    runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: root, env: { PATH: process.env.PATH, FAKE_STUBBORN: "1" }, timeoutMs: 120_000, label: "work-1" });
    const t0 = Date.now();
    while (!((await stageSpendSoFar()).usd > 0) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    const order = [];
    const records = [];
    const finish = async (exit) => {
      order.push("finish:" + calls.length);
      if (${finishHangs}) return new Promise(() => {});
    };
    let exited = null;
    let ended = null;
    const took = stopStage({ cause: "unlabeled", label: "factory:objective", repo, issue: 7, pr: { number: 70, node_id: "PR_70" }, records, finish, opts: { token: "t" }, settleMs: 1, tidyMs: 500, exitMs: ${finishHangs ? 1500 : 60_000}, endNow: (recs) => (ended = recs.map((r) => ({ label: r.label, usd: r.usd, low: !!r.usdLowerBound }))), exit: (code) => (exited = code) });
    const result = await Promise.race([took, new Promise((r) => setTimeout(() => r("pending"), 4000))]);
    process.stdout.write(JSON.stringify({ result, order, ms: Date.now() - t0, exited, ended, records: records.map((r) => ({ label: r.label, usd: r.usd, low: !!r.usdLowerBound })) }) + "\\n");
    process.exit(0);
  `;
  const r = await stage(script(false), root, 60_000);
  assert.ok(r.json, r.err);
  assert.equal(r.json.result, true, "the hung tidy does not hold the stage");
  assert.deepEqual(r.json.order, ["finish:0"], "the end is written before any GitHub call of the tidy");
  assert.equal(r.json.exited, null);
  assert.equal(r.json.records.length, 1);
  assert.ok(r.json.records[0].usd > 0 && r.json.records[0].low, `the pass still running counts at its live reading, a lower bound: ${JSON.stringify(r.json.records)}`);
  const late = await stage(script(true), root, 60_000);
  assert.ok(late.json, late.err);
  assert.equal(late.json.result, "pending");
  assert.equal(late.json.exited, 1, "past its time the stage exits");
  assert.ok(late.json.ended?.length === 1 && late.json.ended[0].usd > 0 && late.json.ended[0].low, "having written what it knew at once");
});
