import "./temp.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxMarkerLine, setSelf } from "../scripts/lib/logic.mjs";
import { launchOne } from "../scripts/launch.mjs";
import { readHandOver, stageDispatchBody } from "../scripts/stage.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { crossOs, crossOsAsk, crossOsChecks, launcherDispatch, launcherRelay, workflowProblem } from "../scripts/lib/cross-os.mjs";
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
  // Each line's step (progress-card.mjs stepOf), as the stage's progress reporter gets it.
  const steps = [];
  try {
    const inputs = resolveInputs({ env: { ...settings, PENDULUM_DECISION_ROUTE: "off" } });
    const set = crossOs(inputs);
    const cross = set.setting || set.problem ? { problem: set.problem, checks: set.setting ? { ...crossOsChecks({ setting: set.setting, repo: REPO, issue: 4, prNumber: 5, branch: "pendulum/4", token: "t", route, ...(relay !== undefined ? { relay } : {}) }), appearMs: 60_000, pollMs: 1, maxPollMs: 4, stuckWaitMs: 40, guardMs: 0, ...checks } : null } : null;
    return await withGitHub({ work, legs: () => ({}), ...github, log }, async (seen) => {
      const result = await workValidation({ checkout: work, commands, checks: null, harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, spentUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl"), onPhase: async (l, step = null) => { log.push(l); steps.push(step); }, handOff: false, ...(progress ? { progressCheck: openProgressCheck({ inputs, stage: null }) } : {}) }, cross);
      let made = [];
      try {
        made = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      } catch {}
      return { result, log, steps, phases: log, prompts: made, dispatches: seen.dispatches, tokens: seen.tokens, head: g("rev-parse", "HEAD").trim() };
    });
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}

const green = { status: "completed", conclusion: "success" };
const red = { status: "completed", conclusion: "failure" };
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
  // #617: the line that begins the cross-OS round is that wait's own, so the progress card gives the wait one row: both
  // are cross-OS steps, in its "Waited for cross-OS CI" row (progress-card.mjs), with no "Waited for CI" row beside it.
  const { ROWS, progressCard } = await import("../scripts/lib/progress-card.mjs");
  const round = r.steps.filter((x) => x?.step === "ci" && (x.begin || x.wait));
  assert.deepEqual(round.map((x) => [x.begin === true, x.wait === true, x.crossOs]), [[true, false, true], [false, true, true]]);
  const card = progressCard({ stage: "work", issue: 4, started: 0, now: 600_000, exit: "delivered", lines: r.steps.map((x, i) => [60_000 + i, r.log[i], x]) }).card;
  assert.deepEqual(card.split("\n").filter((l) => /CI/.test(l)).map((l) => l.split(" | ")[1].split(" · ")[0]), [ROWS.crossOs[0]]);
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

test("#518 S5: a dispatched run already on the head is waited for, not dispatched again; a cancelled one is not reused", async () => {
  const at = Date.now() - 60_000;
  const r = await stage({ settings: ON, github: { earlier: () => [{ id: 7, at }], legs: () => ({ [MAC]: green, [WIN]: green }) } });
  assert.equal(r.result.green, true, r.log.join("\n"));
  assert.deepEqual(r.dispatches, []);
  const c = await stage({ settings: ON, github: { earlier: () => [{ id: 7, at, cancelled: true }], legs: (sha, n) => (n === 0 ? { [MAC]: green, [WIN]: { status: "completed", conclusion: "cancelled" } } : { [MAC]: green, [WIN]: green }) } });
  assert.equal(c.result.green, true, c.log.join("\n"));
  assert.deepEqual(c.dispatches, [{ ref: "pendulum/4", return_run_details: true }]);
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

test("#518 B1: a needs: failure that skips a leg is no green: the stage Blocks as the work's, with no fix pass", async () => {
  const skipped = { status: "completed", conclusion: "skipped" };
  const r = await stage({ settings: ON, github: { legs: () => ({ build: red, [MAC]: green, [WIN]: skipped }) } });
  assert.equal(r.result.green, false);
  assert.equal(r.prompts.length, 0, "no fix pass");
  assert.equal(r.result.stuck.cause, "work");
});
