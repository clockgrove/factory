import "./temp.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideExit, sandboxMarkerLine, setSelf } from "../scripts/lib/logic.mjs";
import { launchOne } from "../scripts/launch.mjs";
import { forwardAsks, readHandOver, stageDispatchBody } from "../scripts/stage.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { WORKFLOW_ONLY_SETTINGS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { RELAY_WAIT_MS, crossOs, crossOsAsk, crossOsChecks, launcherDispatch, launcherRelay, legsLine, workflowProblem } from "../scripts/lib/cross-os.mjs";
import { openProgressCheck } from "../scripts/lib/fix-progress.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { workValidation } from "../scripts/lib/session.mjs";
import { crossOsRow } from "../scripts/doctor.mjs";
import { PASS_KINDS, passKind } from "../scripts/lib/usage.mjs";
import { passLabel } from "../scripts/lib/report.mjs";

// #518: opt-in cross-OS CI in the work stage. The repository names a CI workflow and the check names of its macOS and
// Windows legs; the stage dispatches the workflow on the branch for each head it validates, waits for those legs in that
// one run within a bound per head, and a red leg goes to the fix pass like any validation red.

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const MAC = "test (macos-26, 1/1)";
const WIN = "test (windows-2025, 1/1)";
const LEGS = `${MAC}\n${WIN}`;
const ON = { PENDULUM_CROSS_OS_WORKFLOW: "ci.yml", PENDULUM_CROSS_OS_CHECKS: LEGS };
const CI = "name: CI\non:\n  pull_request:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n";

/**
 * GitHub on fetch for the cross-OS legs, as one event log (`seen.log`) beside the stage's phases.
 * - `legs(sha, n)`: once the workflow was dispatched on `sha` (the n-th dispatch, from 1), each check run of that run by
 *   name, {status, conclusion}; a head has none of them before its dispatch.
 * - `lag`: how many reads of the head's check runs, and of its runs list, pass after a dispatch before its run and its
 *   check runs appear (GitHub creates a run after answering the dispatch).
 * - `pr(sha)`: check runs of a `pull_request` run on the head (another check suite), present from the start.
 * - `earlier(sha)`: workflow runs dispatched on the head before the stage ran (each with its legs, by `legs(sha, 0)`).
 * - `dispatch`: the dispatch's answer, a status code: 200 with the run's id, 204 with none, or another refusal; `auto`
 *   (the default) as GitHub answers, 200 when the body asks for `return_run_details`, else 204.
 * - `workflow`: the workflow file's text at any ref; `noRunner`: every job has no runner yet (GitHub has not started it).
 * - `replaced`: the first dispatch's run is cancelled and a newer dispatched run on its head replaces it (its legs by
 *   `legs(sha, 2)`), as a re-dispatch or the workflow's concurrency group would.
 * The head a dispatch runs on is the checkout's HEAD then.
 */
async function withGitHub({ work, legs, lag = 0, pr = () => [], earlier = () => [], dispatch = "auto", workflow = CI, noRunner = false, replaced = false, appActions = true, record = null, branchAt = null, failHead = () => false, dispatchOn = null, log }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  // `tokens`: the token of each workflow dispatch; `stageAsks`: the stage's repository dispatches to its launcher.
  // `locks`: each lock ref and its commit; `commits`: the lock commits made.
  const seen = { dispatches: [], tokens: [], heads: new Map(), stageAsks: [], locks: new Map(), commits: new Map() };
  let ids = 100;
  const json = (b, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const headOf = () => execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runOf = (sha, h) => {
    const checks = Object.entries(legs(sha, h.n)).map(([name, s], i) => ({ id: h.id * 10 + i, name, status: s.status, conclusion: s.conclusion ?? null, check_suite: { id: h.id }, app: { slug: "github-actions", id: 15368 }, started_at: new Date(h.at).toISOString(), completed_at: s.status === "completed" ? new Date().toISOString() : null }));
    const done = checks.every((c) => c.status === "completed");
    return { checks, run: { id: h.id, name: "CI", event: "workflow_dispatch", path: ".github/workflows/ci.yml", head_sha: sha, status: h.cancelled ? "completed" : done ? "completed" : "in_progress", conclusion: h.cancelled ? "cancelled" : done ? (checks.every((c) => c.conclusion === "success") ? "success" : "failure") : null, check_suite_id: h.id, workflow_id: 5, created_at: new Date(h.at).toISOString(), updated_at: new Date().toISOString() } };
  };
  const headsOf = (sha) => [...(earlier(sha) || []).map((e) => ({ ...e, n: 0 })), ...(seen.heads.get(sha) || [])];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const token = String(init.headers?.Authorization || "").replace(/^Bearer /, "");
    // The cloud sandbox's App token (`t`) with no Actions permission: GitHub refuses its every Actions call.
    if (!appActions && token === "t" && p.startsWith(`/repos/${REPO.full}/actions/`)) return json({ message: "Resource not accessible by integration" }, 403);
    if (record && p === "/graphql") return json({ data: /defaultBranchRef/.test(JSON.parse(String(init.body)).query) ? { repository: { id: "R_1", defaultBranchRef: { target: { tree: { oid: "e".repeat(40) } } } } } : {} });
    if (record) {
      // The launcher's reads and its lock: the Objective, its sandbox record, its branch.
      if (p === `/repos/${REPO.full}/issues/4`) return json({ number: 4, state: "open", user: { login: "maintainer", type: "User" }, labels: [{ name: "pendulum:objective" }, { name: "pendulum:running" }] });
      if (p === `/repos/${REPO.full}/issues/4/comments`) return json([{ id: 9, user: { login: "pendulum-app[bot]", type: "Bot" }, body: `<!-- pendulum:4:sandbox -->\n${sandboxMarkerLine(record)}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
      if (p === `/repos/${REPO.full}/issues/4/timeline` || p === `/repos/${REPO.full}/pulls`) return json([]);
      if (p === `/repos/${REPO.full}/git/commits` && init.method === "POST") {
        const c = { ...JSON.parse(String(init.body)), sha: (ids += 1).toString(16).padStart(40, "c") };
        seen.commits.set(c.sha, c);
        return json(c, 201);
      }
      if (p.startsWith(`/repos/${REPO.full}/git/commits/`)) return json(seen.commits.get(p.split("/").at(-1)) ?? { message: "Not Found" }, seen.commits.has(p.split("/").at(-1)) ? 200 : 404);
      if (p === `/repos/${REPO.full}/git/refs` && init.method === "POST") {
        const { ref, sha } = JSON.parse(String(init.body));
        if (seen.locks.has(ref)) return json({ message: "Reference already exists" }, 422);
        seen.locks.set(ref, sha);
        return json({ ref }, 201);
      }
      if (p.startsWith(`/repos/${REPO.full}/git/ref/pendulum-launch/`)) {
        const ref = `refs/${p.slice(`/repos/${REPO.full}/git/ref/`.length)}`;
        return seen.locks.has(ref) ? json({ ref, object: { sha: seen.locks.get(ref), type: "commit" } }) : json({ message: "Not Found" }, 404);
      }
      if (p === `/repos/${REPO.full}/git/ref/heads/pendulum/4`) {
        if (failHead(seen)) return json({ message: "Server Error" }, 502);
        return json({ ref: "refs/heads/pendulum/4", object: { sha: branchAt ?? headOf(), type: "commit" } });
      }
      if (p === `/repos/${REPO.full}/dispatches` && init.method === "POST") {
        seen.stageAsks.push(JSON.parse(String(init.body)));
        return json(null, 204);
      }
    }
    if (p === `/repos/${REPO.full}/actions/workflows/ci.yml/dispatches` && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      seen.dispatches.push(body);
      seen.tokens.push(token);
      const status = dispatch === "auto" ? (body.return_run_details === true ? 200 : 204) : dispatch;
      if (![200, 204].includes(status)) return json({ message: dispatch === 403 ? "Resource not accessible by integration" : "Workflow does not have 'workflow_dispatch' trigger" }, dispatch);
      const sha = dispatchOn ?? headOf();
      log.push(`dispatch ${sha.slice(0, 7)}`);
      const h = { n: seen.dispatches.length, id: (ids += 10), at: Date.now() + 1000, cr: 0, lr: 0 };
      seen.heads.set(sha, [...(seen.heads.get(sha) || []), h]);
      if (replaced && h.n === 1) {
        h.cancelled = true;
        seen.heads.get(sha).push({ n: 2, id: (ids += 10), at: Date.now() + 2000, cr: 0, lr: 0 });
      }
      return status === 200 ? json({ workflow_run_id: h.id, run_url: `https://github.test/runs/${h.id}`, html_url: "x" }) : json(null, 204);
    }
    let m = /^\/repos\/acme\/app\/contents\/\.github\/workflows\/ci\.yml$/.exec(p);
    if (m) return new Response(workflow, { status: 200 });
    m = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p);
    if (m) {
      const checks = [...pr(m[1]), ...headsOf(m[1]).filter((h) => h.n === 0 || ++h.cr > lag).flatMap((h) => runOf(m[1], h).checks)];
      return json({ total_count: checks.length, check_runs: checks });
    }
    if (/^\/repos\/acme\/app\/commits\/[0-9a-f]{40}\/status$/.test(p)) return json({ statuses: [{ context: WIN, state: "success" }] });
    if (p === `/repos/${REPO.full}/actions/runs` && u.searchParams.get("head_sha")) {
      const sha = u.searchParams.get("head_sha");
      const visible = headsOf(sha).filter((h) => h.n === 0 || ++h.lr > lag);
      const runs = visible.map((h) => runOf(sha, h).run);
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    m = /^\/repos\/acme\/app\/actions\/runs\/(\d+)$/.exec(p);
    if (m) {
      for (const [sha] of seen.heads) for (const h of headsOf(sha)) if (h.id === Number(m[1])) return json(runOf(sha, h).run);
      return json({ message: "Not Found" }, 404);
    }
    m = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)\/logs$/.exec(p);
    if (m) return new Response("##[group]Run npm test\nnot ok 1 - paths join with a backslash on Windows\n##[error]Process completed with exit code 1.\n", { status: 200 });
    if (/^\/repos\/acme\/app\/actions\/workflows\/5\/runs$/.test(p)) {
      const sha = u.searchParams.get("head_sha");
      const runs = headsOf(sha).map((h) => runOf(sha, h).run);
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    m = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)$/.exec(p);
    if (m) return json({ id: Number(m[1]), run_id: Math.floor(Number(m[1]) / 10), name: WIN, status: "completed", conclusion: "failure", runner_id: noRunner ? 0 : 7, runner_name: noRunner ? "" : "w7", steps: [{ name: "Run npm test", number: 4, status: "completed", conclusion: "failure" }] });
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

/**
 * The work stage's validation (session.mjs workValidation, as worker.mjs calls it) in a git checkout, with `commands` as
 * its validation commands and no required checks, and cross-OS CI from `settings` (the workflow env block's names; none:
 * off). A fake Codex is the fix pass: its call n commits `fix-<n>` and records its prompt. `checks`: the waits cut to
 * milliseconds. `progress`: the stage's progress check (decision route off), shared by the loops as worker.mjs's is.
 * Returns the result, the phases and GitHub's events in one log (`log`), the prompts, the dispatches and the final head.
 */
async function stage({ settings = {}, commands = [], github = {}, checks = {}, route = "actions", relay = undefined, progress = false }) {
  const root = mkdtempSync(join(tmpdir(), "cross-os-"));
  const work = join(root, "work");
  mkdirSync(work);
  const g = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  g("init", "-q", "-b", "pendulum/4");
  g("config", "user.name", "t");
  g("config", "user.email", "t@example.com");
  writeFileSync(join(work, "README"), "x\n");
  g("add", "-A");
  g("commit", "-q", "-m", "work");
  mkdirSync(join(root, "bin"));
  const prompts = join(root, "prompts");
  writeFileSync(
    join(root, "bin", "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify(process.argv.slice(2).join(" ") + "\\n" + stdin) + "\\n");
const n = fs.readFileSync(${JSON.stringify(prompts)}, "utf8").trim().split("\\n").length;
fs.writeFileSync("fix-" + n, "fixed\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fix " + n]);
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-" + n }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }));
`,
    { mode: 0o755 },
  );
  const env = { HOME: process.env.HOME, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, CODEX_HOME: join(root, "codex") };
  const path = process.env.PATH;
  process.env.PATH = env.PATH;
  const log = [];
  try {
    const inputs = resolveInputs({ env: { ...settings, PENDULUM_DECISION_ROUTE: "off" } });
    const set = crossOs(inputs);
    const cross = set.setting || set.problem ? { problem: set.problem, checks: set.setting ? { ...crossOsChecks({ setting: set.setting, repo: REPO, issue: 4, prNumber: 5, branch: "pendulum/4", token: "t", route, ...(relay !== undefined ? { relay } : {}) }), appearMs: 60_000, pollMs: 1, maxPollMs: 4, stuckWaitMs: 40, guardMs: 0, ...checks } : null } : null;
    return await withGitHub({ work, legs: () => ({}), ...github, log }, async (seen) => {
      const result = await workValidation({ checkout: work, commands, checks: null, harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, spentUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl"), onPhase: async (l) => log.push(l), handOff: false, ...(progress ? { progressCheck: openProgressCheck({ inputs, stage: null }) } : {}) }, cross);
      let made = [];
      try {
        made = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      } catch {}
      return { result, log, phases: log, prompts: made, dispatches: seen.dispatches, tokens: seen.tokens, head: g("rev-parse", "HEAD").trim() };
    });
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}

const green = { status: "completed", conclusion: "success" };
const red = { status: "completed", conclusion: "failure" };
const running = { status: "in_progress", conclusion: null };
const skipped = { status: "completed", conclusion: "skipped" };
const legLine = (sha, mac, win) => `cross-OS CI (ci.yml) on ${sha.slice(0, 7)}: ${MAC}: ${mac}; ${WIN}: ${win}`;
const anyHead = (l) => l.replace(/\b(on|dispatch) [0-9a-f]{7}\b/g, "$1 X");

test("#518: cross-OS CI is off by default: the stage's own validation runs as before, and nothing is dispatched", async () => {
  const inputs = resolveInputs({ env: {} });
  assert.deepEqual([inputs.crossOsWorkflow, inputs.crossOsChecks, inputs.crossOsWaitMs], ["", [], 60 * 60_000]);
  assert.deepEqual(crossOs(inputs), { setting: null, problem: null });
  const r = await stage({ commands: ["test -f README"], github: { legs: () => ({ [MAC]: green, [WIN]: green }) } });
  assert.equal(r.result.green, true);
  assert.equal(r.result.passes, 1, "the command's pass");
  assert.deepEqual(r.dispatches, []);
  assert.deepEqual(r.log, ["validation pass 1 (1 commands)"]);
  assert.equal(crossOsRow(inputs), null, "doctor has no row for it");
  // A red command: the fix pass and its green, the same as validationLoop's own.
  const fixed = await stage({ commands: ["test -f fix-1"] });
  assert.equal(fixed.result.green, true);
  assert.equal(fixed.prompts.length, 1);
  assert.deepEqual(fixed.dispatches, []);
});

test("#518: on, with macOS and Windows green: the workflow is dispatched on the branch once, after the commands, and the progress names each leg's result", async () => {
  const r = await stage({ settings: ON, commands: ["test -f README"], github: { legs: () => ({ [MAC]: green, [WIN]: green }) } });
  assert.equal(r.result.green, true, r.log.join("\n"));
  assert.equal(r.result.passes, 2, "the command's pass and the cross-OS pass");
  assert.deepEqual(r.dispatches, [{ ref: "pendulum/4", return_run_details: true }]);
  assert.equal(r.prompts.length, 0, "no fix pass");
  assert.deepEqual(r.log.map(anyHead), ["validation pass 1 (1 commands)", "cross-os-validation pass 1 (cross-OS legs)", "dispatch X", `waiting for cross-OS legs (${MAC}; ${WIN}) on X`, anyHead(legLine(r.head, "success", "success"))]);
});

test("#518: a red Windows leg goes back to the worker; its fix commits, the commands run on the new head before it is dispatched, and it ends green", async () => {
  const r = await stage({ settings: ON, commands: ["test -f README"], github: { legs: (sha, n) => ({ [MAC]: green, [WIN]: n === 1 ? red : green }) } });
  assert.equal(r.result.green, true, r.log.join("\n"));
  assert.equal(r.prompts.length, 1, "one fix pass");
  assert.match(r.prompts[0], /Pendulum's validation pass 1 failed on the branch you delivered/);
  assert.match(r.prompts[0], /test \(windows-2025, 1\/1\)/, "the fix pass is handed the red leg");
  assert.match(r.prompts[0], /paths join with a backslash on Windows/, "with its failure from the job's log");
  assert.deepEqual(r.dispatches, [{ ref: "pendulum/4", return_run_details: true }, { ref: "pendulum/4", return_run_details: true }], "each new head is dispatched once");
  const order = r.log.map(anyHead).filter((l) => /^(validation pass|dispatch|cross-OS CI \(ci\.yml\))/.test(l));
  assert.deepEqual(order, ["validation pass 1 (1 commands)", "dispatch X", anyHead(legLine("0".repeat(7), "success", "failure")), "validation pass 1 (1 commands)", "dispatch X", anyHead(legLine("0".repeat(7), "success", "success"))], r.log.join("\n"));
  assert.equal(r.result.passes, 4, "two command passes, two cross-OS passes");
});

test("#518 B1: a same-name pull_request check that was skipped, and a dispatched run GitHub lists late, never stand for the dispatched Windows leg that failed", async () => {
  const prSkipped = (sha) => [{ id: 9001, name: WIN, status: "completed", conclusion: "skipped", check_suite: { id: 1 }, app: { slug: "github-actions" }, started_at: new Date().toISOString() }, { id: 9002, name: MAC, status: "completed", conclusion: "success", check_suite: { id: 1 }, app: { slug: "github-actions" }, started_at: new Date().toISOString() }].map((c) => ({ ...c, head_sha: sha }));
  const r = await stage({ settings: ON, github: { pr: prSkipped, lag: 3, dispatch: 204, legs: (sha, n) => ({ [MAC]: green, [WIN]: n === 1 ? red : green }) } });
  assert.equal(r.prompts.length, 1, "the dispatched leg's red went to the fix pass");
  assert.match(r.prompts[0], /test \(windows-2025, 1\/1\)/);
  assert.equal(anyHead(r.log.find((l) => /^cross-OS CI \(ci\.yml\)/.test(l))), anyHead(legLine("0".repeat(7), "success", "failure")), r.log.join("\n"));
  assert.equal(r.result.green, true, "green only on the fix's own dispatched run");
  // GitHub naming the run in its answer (return_run_details): that run, on the head Pendulum pushed, is the one read.
  const named = await stage({ settings: ON, github: { pr: prSkipped, legs: () => ({ [MAC]: green, [WIN]: red }) }, checks: { boundMs: 50 } });
  assert.notEqual(named.result.green, true);
  assert.equal(named.prompts.length, 1, "a red, not the pull_request run's skip, and one fix pass for it");
  assert.match(named.result.stalled || "", /it brought back the red of cross-os-validation pass 1 on [0-9a-f]{7}: test \(windows-2025, 1\/1\), failing the same way/, "the same red after its fix pass is no progress, with no progress check wired");
});

test("#518 B1: a needs: failure that skips a leg is no green: the stage Blocks naming the skip and the job that caused it", async () => {
  const r = await stage({ settings: ON, github: { legs: () => ({ build: red, [MAC]: green, [WIN]: skipped }) } });
  assert.equal(r.result.green, false);
  assert.equal(r.prompts.length, 0, "no fix pass");
  assert.equal(r.result.stuck.cause, "work");
  assert.match(r.result.stuck.reason, /^cross-OS CI: test \(windows-2025, 1\/1\) skipped on [0-9a-f]{7}, so it did not run: the run's job build ended failure first/);
  const alone = await stage({ settings: ON, github: { legs: () => ({ [MAC]: green, [WIN]: { status: "completed", conclusion: "neutral" } }) } });
  assert.equal(alone.result.stuck.cause, "setup");
  assert.match(alone.result.stuck.reason, /test \(windows-2025, 1\/1\) neutral on [0-9a-f]{7}, so it did not run; run the leg on workflow_dispatch in ci\.yml/);
});

test("#518 with #519: a dispatched run cancelled and replaced by a newer one on its head: the cancel is no red, and the newer run's legs decide", async () => {
  const r = await stage({ settings: ON, github: { replaced: true, legs: (sha, n) => (n === 1 ? { [MAC]: green, [WIN]: { status: "completed", conclusion: "cancelled" } } : { [MAC]: green, [WIN]: green }) } });
  assert.equal(r.result.green, true, r.log.join("\n"));
  assert.equal(r.prompts.length, 0, "no fix pass for the replaced run's cancel");
  assert.equal(r.dispatches.length, 1);
  assert.ok(r.log.includes(legLine(r.head, "success", "success")), r.log.join("\n"));
});

test("#518 S5: a dispatched run already on the head is waited for, not dispatched again; a cancelled one is not reused", async () => {
  const at = Date.now() - 60_000;
  const r = await stage({ settings: ON, github: { earlier: () => [{ id: 7, at }], legs: () => ({ [MAC]: green, [WIN]: green }) } });
  assert.equal(r.result.green, true, r.log.join("\n"));
  assert.deepEqual(r.dispatches, []);
  const c = await stage({ settings: ON, github: { earlier: () => [{ id: 7, at, cancelled: true }], legs: (sha, n) => (n === 0 ? { [MAC]: green, [WIN]: { status: "completed", conclusion: "cancelled" } } : { [MAC]: green, [WIN]: green }) } });
  assert.equal(c.result.green, true, c.log.join("\n"));
  assert.deepEqual(c.dispatches, [{ ref: "pendulum/4", return_run_details: true }]);
});

test("#518 S2: a Windows fix that breaks Linux is judged by the progress check against the red it was given, not fixed again unjudged", async () => {
  // The commands fail once fix-1 (the Windows fix) is there; the Windows leg is red on the first dispatch only.
  const linux = "test ! -f fix-1 || { echo 'not ok 1 - linux path'; exit 1; }";
  const r = await stage({ settings: ON, progress: true, commands: [linux], github: { legs: (sha, n) => ({ [MAC]: green, [WIN]: n === 1 ? red : green }) } });
  assert.equal(r.result.green, false);
  assert.equal(r.prompts.length, 1, "no fix pass for the Linux red: the decision route is off, and the exact checks cannot call it progress");
  assert.match(r.result.stalled || "", /^the fix pass before it made no progress: .*failing: test ! -f fix-1/);
});

test("#518 S2: Linux red fixed, then a Windows red: the Windows leg gets its own fix pass, unjudged, with the decision route off", async () => {
  // The commands fail until fix-1 (the Linux fix) is there; the Windows leg is red on the first dispatch only.
  const linux = "test -f fix-1 || { echo 'not ok 1 - linux path'; exit 1; }";
  const r = await stage({ settings: ON, progress: true, commands: [linux], github: { legs: (sha, n) => ({ [MAC]: green, [WIN]: n === 1 ? red : green }) } });
  assert.equal(r.result.green, true, r.log.join("\n"));
  assert.equal(r.prompts.length, 2, "the Linux fix pass, then the Windows one");
  assert.match(r.prompts[1], /test \(windows-2025, 1\/1\)/);
  assert.ok(!r.log.some((l) => /no progress/.test(l)), r.log.join("\n"));
});

test("#518 S2: Linux red X fixed, Windows red Y fixed, then X again: no progress, and the stage Blocks naming the red that came back", async () => {
  // X fails until fix-1, and again once fix-2 (the Windows fix) is there; the Windows leg is red on the first dispatch.
  const linux = "{ test -f fix-1 && test ! -f fix-2; } || { echo 'not ok 1 - linux path'; exit 1; }";
  const r = await stage({ settings: ON, progress: true, commands: [linux], github: { legs: (sha, n) => ({ [MAC]: green, [WIN]: n === 1 ? red : green }) } });
  assert.equal(r.result.green, false);
  assert.equal(r.prompts.length, 2, "X's fix pass and Y's, none for X again");
  assert.match(r.result.stalled || "", /^the fix pass before it made no progress: it brought back the red of validation pass 1 on [0-9a-f]{7}: .*linux path.*, failing the same way/);
});

test("#518 S3: the bound is the head's, from its first wait: a leg still running then Blocks naming it, with no fix pass", async () => {
  const t0 = Date.now();
  const r = await stage({ settings: ON, github: { legs: () => ({ [MAC]: green, [WIN]: running }) }, checks: { boundMs: 60, boundText: "the cross-OS wait on this head reached its bound, 1 min (cross_os_wait_minutes)" } });
  assert.equal(r.result.green, false);
  assert.equal(r.prompts.length, 0, "no fix pass: nothing failed");
  assert.equal(r.result.passes, 0, "the wait is no counted pass");
  assert.match(r.result.stuck?.reason || "", /not finished on [0-9a-f]{7} .*; the cross-OS wait on this head reached its bound, 1 min \(cross_os_wait_minutes\)$/);
  assert.ok(Date.now() - t0 < 30_000, "it ended at the bound, not the stage's wall clock");
  assert.ok(r.log.includes(legLine(r.head, "success", "in_progress")), r.log.join("\n"));
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: r.result.passes, green: false, stuck: r.result.stuck.reason, stuckCause: r.result.stuck.cause } });
  assert.deepEqual([exit.exit, exit.reason], ["blocked", r.result.stuck.reason]);
  // A leg GitHub has not started: the first wait ends on the not-started bound (40 ms), the next one waits what is left of
  // the head's bound (60 ms from its first wait), never a bound of its own, and the Block names the head's bound.
  const queued = await stage({ settings: ON, github: { noRunner: true, legs: () => ({ [MAC]: green, [WIN]: { status: "queued", conclusion: null } }) }, checks: { boundMs: 60, stuckWaitMs: 40, boundText: "the head's bound" } });
  assert.match(queued.result.stuck?.reason || "", /^GitHub has not started .*; the head's bound$/, queued.log.join("\n"));
});

test("#518: a refused dispatch, or a workflow that grants write, Blocks as a setup gap naming the fix", async () => {
  const r = await stage({ settings: ON, github: { dispatch: 403 }, route: "actions" });
  assert.equal(r.result.stuck.cause, "setup");
  assert.match(r.result.stuck.reason, /^cross-OS CI: GitHub refused to run ci\.yml on pendulum\/4 \(403\): the token cannot dispatch a workflow \(Actions write\); give the workflow's work job `actions: write`, then re-apply the label$/);
  const no = await stage({ settings: ON, github: { workflow: "on: [pull_request]\njobs: {}\n" } });
  assert.match(no.result.stuck.reason, /^cross-OS CI: \.github\/workflows\/ci\.yml has no workflow_dispatch trigger/);
  assert.deepEqual(no.dispatches, []);
  const writes = await stage({ settings: ON, github: { workflow: `${CI}    permissions:\n      contents: write\n` } });
  assert.match(writes.result.stuck.reason, /^cross-OS CI: \.github\/workflows\/ci\.yml grants write \(job test: contents: write\), and a dispatched run would run the branch's code with that token/);
  assert.deepEqual(writes.dispatches, [], "refused before any dispatch");
});

test("#556: any scope at write or write-all, at the top or on a job, Blocks the dispatch and FAILs doctor's row naming the grant; read, none, read-all and {} pass", async () => {
  const inputs = resolveInputs({ env: ON });
  const scopes = ["id-token", "packages", "checks", "statuses", "deployments", "security-events", "pages", "attestations", "discussions", "repository-projects", "a-scope-github-adds-later"];
  const top = (perms) => `name: CI\non:\n  workflow_dispatch:\npermissions:\n${perms}jobs:\n  test:\n    runs-on: \${{ matrix.os }}\n`;
  for (const scope of scopes) {
    const atTop = workflowProblem(parseYaml(top(`  contents: read\n  ${scope}: write\n`)), "ci.yml");
    assert.equal(atTop, `.github/workflows/ci.yml grants write (its top-level permissions: ${scope}: write), and a dispatched run would run the branch's code with that token`, scope);
    const onJob = crossOsRow(inputs, { doc: parseYaml(`${CI}    permissions:\n      contents: read\n      ${scope}: write\n`) });
    assert.equal(onJob.status, "FAIL", scope);
    assert.match(onJob.detail, new RegExp(`grants write \\(job test: ${scope}: write\\)`), scope);
  }
  assert.match(workflowProblem(parseYaml("on: workflow_dispatch\npermissions: write-all\njobs:\n  a:\n    permissions: write-all\n  b:\n    permissions: {id-token: write, packages: write}\n"), "ci.yml"), /grants write \(its top-level permissions: write-all; job a: write-all; job b: id-token: write, packages: write\)/);
  for (const ok of ["{}", "read-all", "{contents: read, id-token: none, packages: read}"]) {
    assert.equal(workflowProblem(parseYaml(`on: workflow_dispatch\npermissions: ${ok}\njobs:\n  t:\n    permissions: ${ok}\n`), "ci.yml"), null, ok);
  }
  // The stage reads the copy on the head and refuses before any dispatch, naming the grant.
  const oidc = await stage({ settings: ON, github: { workflow: `${CI}    permissions:\n      contents: read\n      id-token: write\n` } });
  assert.equal(oidc.result.stuck.cause, "setup");
  assert.match(oidc.result.stuck.reason, /^cross-OS CI: \.github\/workflows\/ci\.yml grants write \(job test: id-token: write\), and a dispatched run would run the branch's code with that token/);
  assert.deepEqual(oidc.dispatches, [], "refused before any dispatch");
});

test("#518: half a setting Blocks once the other validation is green; the legs are one per line, never split on commas; the settings are workflow-file only", async () => {
  const half = await stage({ settings: { PENDULUM_CROSS_OS_WORKFLOW: "ci.yml" } });
  assert.equal(half.result.green, false);
  assert.deepEqual(half.result.stuck, { reason: "cross_os_workflow names ci.yml, but cross_os_checks, the legs that count, is empty; Pendulum never infers them from job names: list each leg's check name, one per line", cause: "setup" });
  assert.deepEqual(half.dispatches, []);
  const set = crossOs(resolveInputs({ env: { ...ON, PENDULUM_CROSS_OS_WORKFLOW: ".github/workflows/ci.yml", PENDULUM_CROSS_OS_WAIT_MINUTES: "30" } })).setting;
  assert.deepEqual(set, { workflow: "ci.yml", checks: [MAC, WIN], waitMs: 30 * 60_000 });
  assert.equal(resolveInputs({ env: { PENDULUM_CROSS_OS_WAIT_MINUTES: "1441" } }).crossOsWaitMs, 60 * 60_000);
  for (const n of ["PENDULUM_CROSS_OS_WORKFLOW", "PENDULUM_CROSS_OS_CHECKS", "PENDULUM_CROSS_OS_WAIT_MINUTES"]) assert.ok(WORKFLOW_ONLY_SETTINGS.has(n), n);
  assert.equal(legsLine({ workflow: "ci.yml", names: [MAC, WIN], sha: "a".repeat(40), runs: [] }), `cross-OS CI (ci.yml) on aaaaaaa: ${MAC}: not reported; ${WIN}: not reported`);
});

test("#518 S1: doctor's row: the cost while on; no dispatch trigger or write permissions at the top or on a job FAIL", () => {
  const inputs = resolveInputs({ env: ON });
  const on = crossOsRow(inputs, { doc: parseYaml(CI), route: "actions" });
  assert.equal(on.status, "PASS");
  assert.match(on.detail, /macOS and Windows runner minutes bill at a higher rate than Linux minutes$/);
  assert.match(on.detail, /waits up to 60 min per head for test \(macos-26, 1\/1\); test \(windows-2025, 1\/1\)/);
  assert.equal(crossOsRow(inputs, { doc: parseYaml("on: [pull_request]\njobs: {}\n") }).status, "FAIL");
  assert.equal(crossOsRow(inputs, { doc: parseYaml("on: [workflow_dispatch]\npermissions: write-all\njobs: {}\n") }).status, "FAIL");
  assert.match(crossOsRow(inputs, { doc: parseYaml(`${CI}    permissions:\n      actions: write\n`) }).detail, /grants write \(job test: actions: write\)/);
  assert.equal(workflowProblem(parseYaml("on: workflow_dispatch\njobs:\n  t:\n    permissions:\n      contents: read\n"), "ci.yml"), null);
  // #538: the cloud sandbox route dispatches through its launcher: a PASS naming the launch-event job's token, and the
  // write-grant check on the dispatched workflow holds there too.
  const sandbox = crossOsRow(inputs, { doc: parseYaml(CI), route: "sandbox" });
  assert.equal(sandbox.status, "PASS");
  assert.match(sandbox.detail, /with the launch-event job's `actions: write`: the launcher dispatches it for the sandbox stage/);
  assert.equal(crossOsRow(inputs, { doc: parseYaml(`${CI}    permissions:\n      contents: write\n`), route: "sandbox" }).status, "FAIL");
  assert.equal(crossOsRow(resolveInputs({ env: { PENDULUM_CROSS_OS_CHECKS: LEGS } }), {}).status, "FAIL");
});

test("#518 with #517: the cross-OS loop's fix and fresh passes are fix passes on the card and in the report; its scope holds have no kind", () => {
  for (const l of ["cross-os-validation-fix-1", "cross-os-validation-fresh-2"]) {
    assert.equal(passKind(l), "fix", l);
    assert.ok(PASS_KINDS.includes(passKind(l)));
    assert.match(passLabel(l), /^cross-os-validation-(?:fix|fresh)$/, "the report's pass label, read as a fix pass (report.mjs isFix)");
  }
  for (const l of ["cross-os-validation-scope-1", "cross-os-validation-fresh-scope-1"]) {
    assert.equal(passKind(l), null, l);
    assert.doesNotMatch(passLabel(l), /-(?:fix|fresh)$/, "no fix pass in the report either");
  }
});

// #538: the cloud sandbox route. The stage holds only the App's token, which has no Actions write: it asks its launcher
// job, as it asks for fresh tokens, and the launcher dispatches exactly the configured workflow on the stage's own branch
// and head with its job token, then hands the run's id back over the stage's socket.

const STAGE = join(import.meta.dirname, "..", "scripts", "stage.mjs");
const CLAIM = "0123456789ab";
const VM_HOME = "/home/vercel-sandbox";
const BOT = { login: "pendulum-app[bot]", type: "Bot" };
const RECORD = { vendor: "vercel", stage: "work", state: "running", claim: CLAIM, id: "pendulum-x1", home: VM_HOME, at: new Date().toISOString(), leaseUntil: new Date(Date.now() + 3_600_000).toISOString(), launches: [] };

/**
 * The relay as a sandbox stage runs it: the worker's ask (launcherRelay, `on` standing for its IPC channel) passes
 * stage.mjs's own check (crossOsAsk) and becomes its repository dispatch (stageDispatchBody), which `rewrite` may change
 * as a sandbox that holds the App's token could; the real launcher (launchOne) answers it with a fake vendor whose `run`
 * starts the real `stage.mjs --deliver` in a home whose socket reads each hand-over as the stage does (readHandOver) and
 * passes its messages back over `on`. `out`: the launches, the vendor runs and the hand-overs.
 */
async function sandboxRelay({ settings = ON, rewrite = (b) => b, retryMs, againMs } = {}) {
  const home = mkdtempSync(join(tmpdir(), "vm-"));
  mkdirSync(join(home, "pendulum"), { mode: 0o700 });
  const on = new EventEmitter();
  const out = { launches: [], runs: [], handed: [] };
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      const h = readHandOver(buf, CLAIM);
      out.handed.push(h);
      for (const m of h?.messages || []) on.emit("message", m);
    });
  });
  await new Promise((r) => server.listen(join(home, "pendulum", "stage.sock"), r));
  const adapter = {
    run: async (id, spec) => {
      out.runs.push({ id, argv: spec.argv, env: spec.env });
      assert.deepEqual(spec.argv.slice(0, 2), ["node", `${VM_HOME}/pendulum/plugin/scripts/stage.mjs`]);
      await promisify(execFile)(process.execPath, [STAGE, ...spec.argv.slice(2)], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, ...spec.env } });
      return { exitCode: 0, timedOut: false, durationMs: 1 };
    },
  };
  const inputs = { ...resolveInputs({ env: { ...settings, PENDULUM_SANDBOX: "vercel" } }), repo: REPO.full, appToken: "t", githubToken: "job" };
  const launch = async (body) => {
    setSelf(BOT.login);
    try {
      return await launchOne({ inputs, eventName: "repository_dispatch", payload: { action: body.event_type, client_payload: body.client_payload, sender: BOT }, repoId: "1", adapter });
    } finally {
      setSelf(null);
    }
  };
  const send = (m) => {
    const ask = crossOsAsk(m);
    if (!ask) return;
    const { ask: at, ...more } = ask;
    const body = rewrite(stageDispatchBody({ issue: 4, claim: CLAIM, want: "cross-os", ask: at, more }));
    pending.push(new Promise((r) => setImmediate(r)).then(() => launch(body)).then((x) => out.launches.push(x), (e) => out.launches.push({ error: e.message })));
  };
  const pending = [];
  // `settled()`: every launch the stage's asks started, finished (a launch ends after its hand-over reached the stage).
  return { relay: launcherRelay({ send, on, ...(retryMs ? { retryMs } : {}), ...(againMs ? { againMs } : {}) }), launch, out, settled: () => Promise.all(pending), close: () => (server.close(), rmSync(home, { recursive: true, force: true })) };
}

const bothGreen = () => ({ [MAC]: green, [WIN]: green });
// A same-name check of a pull_request run in another check suite, failed: it never stands for the dispatched run's leg.
const prRed = () => [{ id: 1, name: WIN, status: "completed", conclusion: "failure", check_suite: { id: 7 }, app: { slug: "github-actions", id: 15368 }, started_at: new Date(Date.now() + 60_000).toISOString(), completed_at: new Date().toISOString() }];

test("#538: a cloud sandbox stage asks its launcher, which dispatches the configured workflow on the stage's branch with its own token; the stage gets the run's id and waits on that run's legs, with no Actions read of its own", async () => {
  const s = await sandboxRelay();
  try {
    const r = await stage({ settings: ON, route: "sandbox", relay: s.relay, github: { record: RECORD, appActions: false, legs: bothGreen, pr: prRed } });
    assert.equal(r.result.green, true, `${r.log.join("\n")}\n${JSON.stringify(s.out)}`);
    assert.deepEqual(r.dispatches, [{ ref: "pendulum/4", return_run_details: true }]);
    assert.deepEqual(r.tokens, ["job"], "the launch job's token, never the App's");
    await s.settled();
    assert.deepEqual(s.out.launches.map((l) => l.exit), ["cross-os"]);
    assert.equal(s.out.runs[0].id, RECORD.id);
    const answer = JSON.parse(s.out.runs[0].env.PENDULUM_STAGE_CROSS_OS);
    assert.equal(answer.sha, r.head);
    assert.ok(Number.isSafeInteger(answer.run) && answer.run > 0, JSON.stringify(answer));
    assert.equal(answer.suite, answer.run, "the run's check suite, as the launcher read it");
    assert.deepEqual(s.out.handed[0], { tokens: null, messages: [{ type: "pendulum-cross-os", sha: r.head, run: answer.run, suite: answer.suite, reused: false }] });
    assert.ok(r.log.includes(legLine(r.head, "success", "success")), r.log.join("\n"));
  } finally {
    s.close();
  }
});

test("#538: the launcher dispatches only the configured workflow, on the stage's own branch, at the head it asked for; anything else is refused and the stage Blocks on it", async () => {
  const swap = (k, v) => (b) => ({ ...b, client_payload: { ...b.client_payload, [k]: v } });
  // A workflow other than the launcher's setting is a setup gap (the setting changed while the stage ran); another ref or
  // a moved branch is Pendulum's, as no stage of its own asks for one.
  for (const [rewrite, branchAt, why, cause] of [
    [swap("workflow", "release.yml"), null, /^cross-OS CI: the stage asked the launcher for another workflow than ci\.yml, the one cross_os_workflow names in the launcher's settings and the only one it dispatches/, "setup"],
    [swap("ref", "main"), null, /^cross-OS CI: the stage asked the launcher for another ref than its branch pendulum\/4, the only one it dispatches on/, "pendulum"],
    [swap("ref", "pendulum/5"), null, /another ref than its branch pendulum\/4/, "pendulum"],
    [(b) => b, "a".repeat(40), /^cross-OS CI: pendulum\/4 is at aaaaaaa, not at [0-9a-f]{7}, the head the stage asked for: the branch moved/, "pendulum"],
  ]) {
    const s = await sandboxRelay({ rewrite });
    try {
      const r = await stage({ settings: ON, route: "sandbox", relay: s.relay, github: { record: RECORD, appActions: false, branchAt, legs: bothGreen } });
      assert.equal(r.result.green, false);
      assert.match(r.result.stuck?.reason || "", why, JSON.stringify(s.out));
      assert.equal(r.result.stuck.cause, cause);
      assert.deepEqual(r.dispatches, [], "nothing dispatched");
      await s.settled();
      assert.deepEqual(s.out.launches.map((l) => l.exit), ["cross-os"], "answered with the refusal");
    } finally {
      s.close();
    }
  }
  // A sandbox that skips the stage's own check of the workflow: the launcher checks it at the head too.
  const root = mkdtempSync(join(tmpdir(), "cross-os-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "pendulum/4", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"]);
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const inputs = resolveInputs({ env: ON });
    await withGitHub({ work: root, legs: bothGreen, record: RECORD, workflow: `${CI}    permissions:\n      contents: write\n`, log: [] }, async (seen) => {
      const a = await launcherDispatch({ inputs, repo: REPO, issue: 4, ask: { workflow: "ci.yml", ref: "pendulum/4", sha }, token: "t", actionsToken: "job" });
      assert.match(a.refused?.reason || "", /^cross-OS CI: \.github\/workflows\/ci\.yml grants write \(job test: contents: write\), and a dispatched run would run the branch's code with that token; fix the workflow/);
      assert.equal(a.refused.cause, "setup");
      const off = await launcherDispatch({ inputs: resolveInputs({ env: {} }), repo: REPO, issue: 4, ask: { workflow: "ci.yml", ref: "pendulum/4", sha }, token: "t", actionsToken: "job" });
      assert.equal(off.refused?.cause, "setup", "cross-OS CI off in the launcher's settings dispatches nothing");
      assert.deepEqual(seen.dispatches, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#538: on Actions and in local mode the stage dispatches with its own token and asks no launcher; the sandbox's token hand-over is unchanged", async () => {
  for (const route of ["actions", "local"]) {
    const asked = [];
    const r = await stage({ settings: ON, route, relay: async (a) => (asked.push(a), { timedOut: true }), github: { legs: bothGreen } });
    assert.equal(r.result.green, true, `${route}: ${r.log.join("\n")}`);
    assert.deepEqual(r.tokens, ["t"], route);
    assert.deepEqual(asked, [], route);
  }
  const local = await stage({ settings: ON, route: "local", github: { dispatch: 403 } });
  assert.match(local.result.stuck.reason, /\(403\): the token cannot dispatch a workflow \(Actions write\); give the repository token Actions read and write, then re-apply the label$/);
  // A sandbox stage never dispatches with its App token: with no channel to a launcher it Blocks, and with a launcher
  // that never answers it asks again, then Blocks at the bound.
  const none = await stage({ settings: ON, route: "sandbox", relay: null, github: { legs: bothGreen } });
  assert.equal(none.result.stuck?.cause, "pendulum");
  assert.deepEqual(none.dispatches, []);
  const asks = [];
  // The relay's bound is the stage's wall clock here (2 min, under RELAY_WAIT_MS), and its clock runs 20 s a reading,
  // so the bound passes after two asks.
  let t = 0;
  const quiet = await stage({ settings: ON, route: "sandbox", relay: launcherRelay({ send: (m) => asks.push(m), on: new EventEmitter(), retryMs: 20, clock: () => (t += 20_000) }), github: { legs: bothGreen } });
  assert.equal(quiet.result.stuck?.cause, "outage", JSON.stringify(quiet.result));
  assert.match(quiet.result.stuck.reason, /^cross-OS CI: the launcher gave no run for the stage's request to run ci\.yml on [0-9a-f]{7} within 2 min; check the workflow's launch-event job runs/);
  assert.equal(asks.length, 2, "asked again before the bound");
  assert.equal(new Set(asks.map((a) => a.ask)).size, asks.length, "each ask names itself");
  assert.deepEqual(quiet.dispatches, []);
  // Fresh tokens: the launcher's hand-over through the real --deliver, as before.
  const s = await sandboxRelay();
  try {
    await withGitHub({ work: mkdtempSync(join(tmpdir(), "w-")), legs: bothGreen, record: RECORD, log: [] }, async () => {
      const r = await s.launch(stageDispatchBody({ issue: 4, claim: CLAIM, want: "token", ask: 1794175200 }));
      assert.equal(r.exit, "token", JSON.stringify(r));
    });
    assert.deepEqual(s.out.handed, [{ tokens: { write: "t", read: null }, messages: [{ type: "pendulum-tokens", write: "t", read: null }] }]);
    assert.equal(readHandOver(JSON.stringify({ claim: "another", write: "x" }), CLAIM), null, "another claim's is refused");
  } finally {
    s.close();
  }
});

/** A git checkout on pendulum/4 with one commit, and its head. */
function headRepo() {
  const root = mkdtempSync(join(tmpdir(), "head-"));
  execFileSync("git", ["init", "-q", "-b", "pendulum/4", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"]);
  return { root, sha: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

test("#538 review: a second ask on a head reuses its run with no second dispatch; a replayed ask is skipped by its lock; another claim's ask is skipped", async () => {
  const { root, sha } = headRepo();
  const s = await sandboxRelay();
  try {
    await withGitHub({ work: root, legs: bothGreen, record: RECORD, log: [] }, async (seen) => {
      const ask = (n, claim = CLAIM) => stageDispatchBody({ issue: 4, claim, want: "cross-os", ask: n, more: { sha, workflow: "ci.yml", ref: "pendulum/4" } });
      assert.equal((await s.launch(ask(1))).exit, "cross-os");
      const replay = await s.launch(ask(1));
      assert.equal(replay.exit, "skipped");
      assert.match(replay.reason, /another launcher holds pendulum-launch\/4\/work-cross-os-0123456789ab-1$/);
      assert.equal((await s.launch(ask(2))).exit, "cross-os");
      const other = await s.launch(ask(3, "ffffffffffff"));
      assert.equal(other.exit, "skipped");
      assert.match(other.reason, /not the claim the sandbox record carries/);
      assert.equal(seen.dispatches.length, 1, "one run on the head");
      const [first, second] = s.out.runs.map((r) => JSON.parse(r.env.PENDULUM_STAGE_CROSS_OS));
      assert.equal(s.out.runs.length, 2, "the replay and the other claim are not answered");
      assert.equal(first.reused, undefined);
      assert.deepEqual(second, { sha, run: first.run, suite: first.suite, reused: true });
    });
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#538 review: GitHub naming no run (204) is answered with the head's dispatched run; a run made on another head is refused and left to finish", async () => {
  const s = await sandboxRelay();
  try {
    const r = await stage({ settings: ON, route: "sandbox", relay: s.relay, github: { record: RECORD, appActions: false, dispatch: 204, legs: bothGreen } });
    assert.equal(r.result.green, true, r.log.join("\n"));
    await s.settled();
    const answer = JSON.parse(s.out.runs[0].env.PENDULUM_STAGE_CROSS_OS);
    assert.ok(answer.run > 0 && answer.suite === answer.run, JSON.stringify(answer));
  } finally {
    s.close();
  }
  const m = await sandboxRelay();
  try {
    const r = await stage({ settings: ON, route: "sandbox", relay: m.relay, github: { record: RECORD, appActions: false, dispatchOn: "d".repeat(40), legs: bothGreen } });
    assert.match(r.result.stuck?.reason || "", /^cross-OS CI: the run GitHub made \(\d+\) is on ddddddd, not on [0-9a-f]{7}: pendulum\/4 moved; re-apply the label/);
    assert.equal(r.result.stuck.cause, "pendulum");
    assert.equal(r.dispatches.length, 1, "dispatched once; nothing cancels it");
  } finally {
    m.close();
  }
});

test("#538 review: a branch read that fails for now is no refusal: the stage asks again and gets its run", async () => {
  const s = await sandboxRelay({ againMs: 5 });
  try {
    // Every read of the branch fails while the first launch holds its lock (its first lock is the only one).
    const r = await stage({ settings: ON, route: "sandbox", relay: s.relay, github: { record: RECORD, appActions: false, failHead: (seen) => seen.locks.size === 1, legs: bothGreen } });
    assert.equal(r.result.green, true, `${r.log.join("\n")}\n${JSON.stringify(s.out)}`);
    await s.settled();
    assert.deepEqual(s.out.runs.map((x) => JSON.parse(x.env.PENDULUM_STAGE_CROSS_OS).again ?? false), [true, false]);
    assert.equal(r.dispatches.length, 1);
  } finally {
    s.close();
  }
});

test("#538 review: the relay asks again after an answer with no run or no check suite, and resolves on one it can wait on", async () => {
  const on = new EventEmitter();
  const asks = [];
  const sha = "c".repeat(40);
  const answers = [{ sha, run: 5, suite: null }, { sha, run: null, suite: null }, { sha, again: true }, { sha, run: 5, suite: 9, reused: true }];
  const relay = launcherRelay({ send: (m) => (asks.push(m), setImmediate(() => on.emit("message", { type: "pendulum-cross-os", ...answers[asks.length - 1] }))), on, againMs: 1, retryMs: 60_000 });
  assert.deepEqual(await relay({ workflow: "ci.yml", ref: "pendulum/4", sha, boundMs: RELAY_WAIT_MS }), { sha, run: 5, suite: 9, reused: true });
  assert.equal(asks.length, 4);
  assert.equal(on.listenerCount("message"), 0, "its listener is gone once answered");
});

test("#538 review: stage.mjs passes the worker's ask over the real IPC channel to its launcher dispatch, and the answer back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ipc-"));
  const sha = "e".repeat(40);
  const script = join(dir, "worker.mjs");
  writeFileSync(script, `import { launcherRelay } from ${JSON.stringify(join(import.meta.dirname, "..", "scripts", "lib", "cross-os.mjs"))};\nconst a = await launcherRelay()({ workflow: "ci.yml", ref: "pendulum/4", sha: ${JSON.stringify(sha)}, boundMs: 60000 });\nprocess.send({ type: "done", a }, () => process.disconnect());\n`);
  const child = fork(script, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const asked = [];
  let stopping = false;
  forwardAsks(child, {
    stopping: () => stopping,
    dispatch: async (want, ask, more) => {
      asked.push({ want, ask: typeof ask, more });
      for (const m of readHandOver(JSON.stringify({ claim: CLAIM, crossOs: { sha, run: 41, suite: 42 } }), CLAIM).messages) child.send(m);
    },
  });
  const done = await new Promise((resolve) => child.on("message", (m) => m?.type === "done" && resolve(m.a)));
  stopping = true;
  await new Promise((r) => child.on("exit", r));
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(asked, [{ want: "cross-os", ask: "number", more: { sha, workflow: "ci.yml", ref: "pendulum/4" } }]);
  assert.deepEqual(done, { sha, run: 41, suite: 42, reused: false });
});

test("#538 with #556: a sandbox stage refuses a workflow that grants write before it asks its launcher, naming the grant", async () => {
  const asked = [];
  const r = await stage({ settings: ON, route: "sandbox", relay: async (a) => (asked.push(a), { timedOut: true }), github: { workflow: `${CI}    permissions:\n      id-token: write\n`, legs: bothGreen } });
  assert.match(r.result.stuck?.reason || "", /^cross-OS CI: \.github\/workflows\/ci\.yml grants write \(job test: id-token: write\)/);
  assert.equal(r.result.stuck.cause, "setup");
  assert.deepEqual(asked, []);
  assert.deepEqual(r.dispatches, []);
});
