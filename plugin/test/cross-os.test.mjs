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
import { crossOs, crossOsChecks, legsLine } from "../scripts/lib/cross-os.mjs";
import { workValidation } from "../scripts/lib/session.mjs";
import { crossOsRow } from "../scripts/doctor.mjs";

// #518: opt-in cross-OS CI in the work stage. The repository names a CI workflow and the check names of its macOS and
// Windows legs; the stage dispatches the workflow on the branch for each head it validates, waits for those legs within
// a bound, and a red leg goes to the fix pass like any validation red.

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const MAC = "test (macos-26, 1/1)";
const WIN = "test (windows-2025, 1/1)";
const LEGS = `${MAC}\n${WIN}`;
const ON = { PENDULUM_CROSS_OS_WORKFLOW: "ci.yml", PENDULUM_CROSS_OS_CHECKS: LEGS };

/**
 * GitHub on fetch for the cross-OS legs. `legs(sha, n)` gives, once the workflow was dispatched on `sha` (the n-th
 * dispatch, from 1), each leg's {status, conclusion} by name; before its dispatch a head has no leg at all. `dispatch`:
 * the dispatch's answer (a status code, 204 by default). The head a dispatch runs on is the checkout's HEAD then.
 */
async function withGitHub({ work, legs, dispatch = 204 }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const seen = { dispatches: [], heads: new Map() };
  let ids = 100;
  const json = (b, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  // Each dispatched head's runs: one workflow run, one check run per leg (ids fixed per head).
  const runsOf = (sha) => {
    const h = seen.heads.get(sha);
    if (!h) return { workflow: [], checks: [] };
    const state = legs(sha, h.n);
    const checks = Object.entries(state).map(([name, s], i) => ({ id: h.base + i, name, status: s.status, conclusion: s.conclusion ?? null, check_suite: { id: h.base }, app: { slug: "github-actions", id: 15368 }, started_at: new Date(h.at).toISOString(), completed_at: s.status === "completed" ? new Date().toISOString() : null }));
    const done = checks.every((c) => c.status === "completed");
    const workflow = [{ id: h.base, name: "CI", event: "workflow_dispatch", path: ".github/workflows/ci.yml", head_sha: sha, status: done ? "completed" : "in_progress", conclusion: done ? (checks.every((c) => c.conclusion === "success") ? "success" : "failure") : null, check_suite_id: h.base, workflow_id: 5, created_at: new Date(h.at).toISOString(), updated_at: new Date().toISOString() }];
    return { workflow, checks };
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    if (p === `/repos/${REPO.full}/actions/workflows/ci.yml/dispatches` && init.method === "POST") {
      seen.dispatches.push(JSON.parse(String(init.body)));
      if (dispatch !== 204) return json({ message: dispatch === 403 ? "Resource not accessible by integration" : "Workflow does not have 'workflow_dispatch' trigger" }, dispatch);
      const sha = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      seen.heads.set(sha, { n: seen.dispatches.length, base: (ids += 10), at: Date.now() });
      return json(null, 204);
    }
    let m = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p);
    if (m) {
      const { checks } = runsOf(m[1]);
      return json({ total_count: checks.length, check_runs: checks });
    }
    if (/^\/repos\/acme\/app\/commits\/[0-9a-f]{40}\/status$/.test(p)) return json({ statuses: [] });
    if (p === `/repos/${REPO.full}/actions/runs` && u.searchParams.get("head_sha")) {
      const { workflow } = runsOf(u.searchParams.get("head_sha"));
      return json({ total_count: workflow.length, workflow_runs: workflow });
    }
    m = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)\/logs$/.exec(p);
    if (m) return new Response("##[group]Run npm test\nnot ok 1 - paths join with a backslash on Windows\n##[error]Process completed with exit code 1.\n", { status: 200 });
    m = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)$/.exec(p);
    if (m) return json({ id: Number(m[1]), run_id: 1, name: WIN, status: "completed", conclusion: "failure", runner_id: 7, runner_name: "w7", steps: [{ name: "Run npm test", number: 4, status: "completed", conclusion: "failure" }] });
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
 * The work stage's validation (session.mjs workValidation, as worker.mjs calls it) in a git checkout, with no validation
 * commands and no required checks, and cross-OS CI from `settings` (the workflow env block's names; none: off). A fake
 * Codex is the fix pass: each call commits `fix-<n>` and records its prompt. `checks`: the waits cut to milliseconds.
 */
async function stage({ settings = {}, legs = () => ({}), dispatch = 204, checks = {}, route = "actions" }) {
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
  const phases = [];
  try {
    const inputs = resolveInputs({ env: settings });
    const set = crossOs(inputs);
    const cross = set.setting || set.problem ? { problem: set.problem, checks: set.setting ? { ...crossOsChecks({ setting: set.setting, repo: REPO, issue: 4, prNumber: 5, branch: "pendulum/4", token: "t", route }), appearMs: 0, pollMs: 1, maxPollMs: 4, stuckWaitMs: 40, guardMs: 0, ...checks } : null } : null;
    return await withGitHub({ work, legs, dispatch }, async (seen) => {
      const result = await workValidation({ checkout: work, commands: inputs.validation, checks: null, harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, spentUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl"), onPhase: async (l) => phases.push(l), handOff: false }, cross);
      let made = [];
      try {
        made = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      } catch {}
      return { result, phases, prompts: made, dispatches: seen.dispatches, head: g("rev-parse", "HEAD").trim() };
    });
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}

const green = { status: "completed", conclusion: "success" };
const red = { status: "completed", conclusion: "failure" };
const running = { status: "in_progress", conclusion: null };

test("#518: cross-OS CI is off by default: no setting, no dispatch, and the stage's validation ends as before", async () => {
  const inputs = resolveInputs({ env: {} });
  assert.deepEqual([inputs.crossOsWorkflow, inputs.crossOsChecks, inputs.crossOsWaitMs], ["", [], 60 * 60_000]);
  assert.deepEqual(crossOs(inputs), { setting: null, problem: null });
  const r = await stage({ legs: () => ({ [MAC]: green, [WIN]: green }) });
  assert.equal(r.result.green, true);
  assert.equal(r.result.passes, 0, "no validation pass: no commands, no checks");
  assert.equal(r.result.skipped, "no validation commands");
  assert.deepEqual(r.dispatches, [], "nothing dispatched");
  assert.ok(!r.phases.some((l) => /cross-OS/.test(l)), r.phases.join("\n"));
  assert.equal(crossOsRow(inputs), null, "doctor has no row for it");
});

test("#518: on, with macOS and Windows green: the workflow is dispatched on the branch once, the wait reads both legs, and the progress names each result", async () => {
  const r = await stage({ settings: ON, legs: () => ({ [MAC]: green, [WIN]: green }) });
  assert.equal(r.result.green, true, r.phases.join("\n"));
  assert.equal(r.result.passes, 1, "the cross-OS pass is a validation pass");
  assert.deepEqual(r.dispatches, [{ ref: "pendulum/4" }]);
  assert.equal(r.prompts.length, 0, "no fix pass");
  assert.ok(r.phases.includes(`cross-OS CI (ci.yml) on ${r.head.slice(0, 7)}: ${MAC}: success; ${WIN}: success`), r.phases.join("\n"));
  assert.ok(r.phases.some((l) => l === `waiting for cross-OS legs (${MAC}; ${WIN}) on ${r.head.slice(0, 7)}`), r.phases.join("\n"));
});

test("#518: a red Windows leg goes back to the worker: a fix pass with the leg's failure, then the new head is dispatched and validated green", async () => {
  // The first head's Windows leg fails; the fix pass's head is green on both.
  const r = await stage({ settings: ON, legs: (sha, n) => ({ [MAC]: green, [WIN]: n === 1 ? red : green }) });
  assert.equal(r.result.green, true, r.phases.join("\n"));
  assert.equal(r.prompts.length, 1, "one fix pass");
  assert.match(r.prompts[0], /Pendulum's validation pass 1 failed on the branch you delivered/);
  assert.match(r.prompts[0], /test \(windows-2025, 1\/1\)/, "the fix pass is handed the red leg");
  assert.match(r.prompts[0], /paths join with a backslash on Windows/, "with its failure from the job's log");
  assert.deepEqual(r.dispatches, [{ ref: "pendulum/4" }, { ref: "pendulum/4" }], "each new head is dispatched once");
  const first = r.phases.find((l) => /^cross-OS CI \(ci\.yml\) on [0-9a-f]{7}: .*failure$/.test(l));
  assert.equal(first?.replace(/ on [0-9a-f]{7}:/, " on X:"), `cross-OS CI (ci.yml) on X: ${MAC}: success; ${WIN}: failure`, r.phases.join("\n"));
  assert.ok(r.phases.includes(`cross-OS CI (ci.yml) on ${r.head.slice(0, 7)}: ${MAC}: success; ${WIN}: success`), r.phases.join("\n"));
  assert.ok(r.phases.some((l) => /^cross-OS validation pass 1 red: .*fix run/.test(l)), r.phases.join("\n"));
});

test("#518: the wait's bound reached with a leg still running: no fix pass, and the stage Blocks naming the bound", async () => {
  const t0 = Date.now();
  const r = await stage({ settings: ON, legs: () => ({ [MAC]: green, [WIN]: running }), checks: { boundMs: 60, boundText: "the cross-OS wait reached its bound, 1 min (cross_os_wait_minutes)" } });
  assert.equal(r.result.green, false);
  assert.equal(r.prompts.length, 0, "no fix pass: nothing failed");
  assert.equal(r.result.passes, 0, "the wait is no counted pass");
  assert.match(r.result.stuck?.reason || "", /not finished on [0-9a-f]{7} .*; the cross-OS wait reached its bound, 1 min \(cross_os_wait_minutes\)$/);
  assert.ok(Date.now() - t0 < 30_000, "it ended at the bound, not the stage's wall clock");
  assert.ok(r.phases.includes(`cross-OS CI (ci.yml) on ${r.head.slice(0, 7)}: ${MAC}: success; ${WIN}: in_progress`), r.phases.join("\n"));
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: r.result.passes, green: false, stuck: r.result.stuck.reason, stuckCause: r.result.stuck.cause } });
  assert.equal(exit.exit, "blocked");
  assert.equal(exit.reason, r.result.stuck.reason);
});

test("#518: a refused dispatch Blocks as a setup gap naming the fix for the route (the cloud sandbox's App token has no Actions write)", async () => {
  const r = await stage({ settings: ON, legs: () => ({ [MAC]: green, [WIN]: green }), dispatch: 403, route: "sandbox" });
  assert.equal(r.result.green, false);
  assert.equal(r.result.stuck.cause, "setup");
  assert.match(r.result.stuck.reason, /^cross-OS CI: GitHub refused to run ci\.yml on pendulum\/4 \(403\): the token cannot dispatch a workflow \(Actions write\); a cloud sandbox stage holds the App's token, which has no Actions write, and Pendulum's App does not ask for one/);
  const no = await stage({ settings: ON, dispatch: 422 });
  assert.match(no.result.stuck.reason, /Workflow does not have 'workflow_dispatch' trigger; give the workflow a `workflow_dispatch:` trigger/);
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

test("#518: doctor's row: the cost while on, a missing dispatch trigger or a cloud sandbox FAILs", () => {
  const inputs = resolveInputs({ env: ON });
  const on = crossOsRow(inputs, { events: ["pull_request", "merge_group", "workflow_dispatch"], route: "actions" });
  assert.equal(on.status, "PASS");
  assert.match(on.detail, /macOS and Windows runner minutes bill at a higher rate than Linux minutes$/);
  assert.match(on.detail, /waits up to 60 min for test \(macos-26, 1\/1\); test \(windows-2025, 1\/1\)/);
  assert.equal(crossOsRow(inputs, { events: ["pull_request"], route: "actions" }).status, "FAIL");
  assert.equal(crossOsRow(inputs, { events: ["workflow_dispatch"], route: "sandbox" }).status, "FAIL");
  assert.equal(crossOsRow(resolveInputs({ env: { PENDULUM_CROSS_OS_CHECKS: LEGS } }), {}).status, "FAIL");
});
