import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideExit } from "../scripts/lib/logic.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { WORKFLOW_ONLY_SETTINGS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { crossOs, crossOsChecks, legsLine, workflowProblem } from "../scripts/lib/cross-os.mjs";
import { openProgressCheck } from "../scripts/lib/fix-progress.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { workValidation } from "../scripts/lib/session.mjs";
import { crossOsRow } from "../scripts/doctor.mjs";

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
async function withGitHub({ work, legs, lag = 0, pr = () => [], earlier = () => [], dispatch = "auto", workflow = CI, noRunner = false, replaced = false, log }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const seen = { dispatches: [], heads: new Map() };
  let ids = 100;
  const json = (b, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const runOf = (sha, h) => {
    const checks = Object.entries(legs(sha, h.n)).map(([name, s], i) => ({ id: h.id * 10 + i, name, status: s.status, conclusion: s.conclusion ?? null, check_suite: { id: h.id }, app: { slug: "github-actions", id: 15368 }, started_at: new Date(h.at).toISOString(), completed_at: s.status === "completed" ? new Date().toISOString() : null }));
    const done = checks.every((c) => c.status === "completed");
    return { checks, run: { id: h.id, name: "CI", event: "workflow_dispatch", path: ".github/workflows/ci.yml", head_sha: sha, status: h.cancelled ? "completed" : done ? "completed" : "in_progress", conclusion: h.cancelled ? "cancelled" : done ? (checks.every((c) => c.conclusion === "success") ? "success" : "failure") : null, check_suite_id: h.id, workflow_id: 5, created_at: new Date(h.at).toISOString(), updated_at: new Date().toISOString() } };
  };
  const headsOf = (sha) => [...(earlier(sha) || []).map((e) => ({ ...e, n: 0 })), ...(seen.heads.get(sha) || [])];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    if (p === `/repos/${REPO.full}/actions/workflows/ci.yml/dispatches` && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      seen.dispatches.push(body);
      const status = dispatch === "auto" ? (body.return_run_details === true ? 200 : 204) : dispatch;
      if (![200, 204].includes(status)) return json({ message: dispatch === 403 ? "Resource not accessible by integration" : "Workflow does not have 'workflow_dispatch' trigger" }, dispatch);
      const sha = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
async function stage({ settings = {}, commands = [], github = {}, checks = {}, route = "actions", progress = false }) {
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
    const cross = set.setting || set.problem ? { problem: set.problem, checks: set.setting ? { ...crossOsChecks({ setting: set.setting, repo: REPO, issue: 4, prNumber: 5, branch: "pendulum/4", token: "t", route }), appearMs: 60_000, pollMs: 1, maxPollMs: 4, stuckWaitMs: 40, guardMs: 0, ...checks } : null } : null;
    return await withGitHub({ work, legs: () => ({}), ...github, log }, async (seen) => {
      const result = await workValidation({ checkout: work, commands, checks: null, harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, spentUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl"), onPhase: async (l) => log.push(l), handOff: false, ...(progress ? { progressCheck: openProgressCheck({ inputs, stage: null }) } : {}) }, cross);
      let made = [];
      try {
        made = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      } catch {}
      return { result, log, phases: log, prompts: made, dispatches: seen.dispatches, head: g("rev-parse", "HEAD").trim() };
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
  assert.deepEqual(r.log.map(anyHead), ["validation pass 1 (1 commands)", "cross-OS validation pass 1 (cross-OS legs)", "dispatch X", `waiting for cross-OS legs (${MAC}; ${WIN}) on X`, anyHead(legLine(r.head, "success", "success"))]);
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
  assert.match(named.result.stalled || "", /it brought back the red of cross-OS validation pass 1 on [0-9a-f]{7}: test \(windows-2025, 1\/1\), failing the same way/, "the same red after its fix pass is no progress, with no progress check wired");
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
  const r = await stage({ settings: ON, github: { dispatch: 403 }, route: "sandbox" });
  assert.equal(r.result.stuck.cause, "setup");
  assert.match(r.result.stuck.reason, /^cross-OS CI: GitHub refused to run ci\.yml on pendulum\/4 \(403\): the token cannot dispatch a workflow \(Actions write\); a cloud sandbox stage holds the App's token, which has no Actions write, and Pendulum's App does not ask for one/);
  const no = await stage({ settings: ON, github: { workflow: "on: [pull_request]\njobs: {}\n" } });
  assert.match(no.result.stuck.reason, /^cross-OS CI: \.github\/workflows\/ci\.yml has no workflow_dispatch trigger/);
  assert.deepEqual(no.dispatches, []);
  const writes = await stage({ settings: ON, github: { workflow: `${CI}    permissions:\n      contents: write\n` } });
  assert.match(writes.result.stuck.reason, /^cross-OS CI: \.github\/workflows\/ci\.yml grants write \(job test\), and a dispatched run would run the branch's code with that token/);
  assert.deepEqual(writes.dispatches, [], "refused before any dispatch");
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

test("#518 S1: doctor's row: the cost while on; no dispatch trigger, write permissions at the top or on a job, or a cloud sandbox FAIL", () => {
  const inputs = resolveInputs({ env: ON });
  const on = crossOsRow(inputs, { doc: parseYaml(CI), route: "actions" });
  assert.equal(on.status, "PASS");
  assert.match(on.detail, /macOS and Windows runner minutes bill at a higher rate than Linux minutes$/);
  assert.match(on.detail, /waits up to 60 min per head for test \(macos-26, 1\/1\); test \(windows-2025, 1\/1\)/);
  assert.equal(crossOsRow(inputs, { doc: parseYaml("on: [pull_request]\njobs: {}\n") }).status, "FAIL");
  assert.equal(crossOsRow(inputs, { doc: parseYaml("on: [workflow_dispatch]\npermissions: write-all\njobs: {}\n") }).status, "FAIL");
  assert.match(crossOsRow(inputs, { doc: parseYaml(`${CI}    permissions:\n      actions: write\n`) }).detail, /grants write \(job test\)/);
  assert.equal(workflowProblem(parseYaml("on: workflow_dispatch\njobs:\n  t:\n    permissions:\n      contents: read\n"), "ci.yml"), null);
  assert.equal(crossOsRow(inputs, { doc: parseYaml(CI), route: "sandbox" }).status, "FAIL");
  assert.equal(crossOsRow(resolveInputs({ env: { PENDULUM_CROSS_OS_CHECKS: LEGS } }), {}).status, "FAIL");
});
