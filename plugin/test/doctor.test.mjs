import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialChecks, workflowText } from "../scripts/doctor.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

const repo = { full: "o/r", owner: "o", name: "r" };
const wf = (pin) => `on: issues\njobs:\n  work:\n    steps:\n      - uses: clockgrove/pendulum@${pin}\n`;
function clone(text) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  if (text !== null) {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "pendulum.yml"), text);
  }
  return root;
}

test("doctor: the workflow is read from the default branch on GitHub; a local copy behind it is noted (#2579)", async () => {
  const asked = [];
  const read = async (path, ref) => {
    asked.push([path, ref]);
    return wf("v0.7.98");
  };
  const r = await workflowText({ repo, branch: "main", env: {}, root: clone(wf("v0.7.83")), read });
  assert.deepEqual(asked, [[".github/workflows/pendulum.yml", "main"]]);
  assert.equal(r.text, wf("v0.7.98"));
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].status, "WARN");
  assert.match(r.checks[0].detail, /differs from main on GitHub \(it pins v0\.7\.83, GitHub v0\.7\.98\); the checks read GitHub's/);
  // The same file: nothing to say. On Actions the workspace is the run's own ref: no note either.
  assert.deepEqual((await workflowText({ repo, branch: "main", env: {}, root: clone(wf("v0.7.98")), read })).checks, []);
  assert.deepEqual((await workflowText({ repo, branch: "main", env: { GITHUB_ACTIONS: "true" }, root: clone(wf("v0.7.83")), read })).checks, []);
  // No local copy at all (a local run's stage): GitHub's.
  assert.equal((await workflowText({ repo, branch: "main", env: {}, root: clone(null), read })).text, wf("v0.7.98"));
});

test("setup files: every repository file the setup command runs must be protected, on every route; doctor FAILs otherwise and setup adds it", async () => {
  const { setupFilesCheck } = await import("../scripts/doctor.mjs");
  const { protectSetup } = await import("../scripts/setup.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pendulum-setup-files-"));
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  writeFileSync(join(dir, "scripts", "ci", "setup.sh"), "");
  writeFileSync(join(dir, "scripts", "ci", "toolchain.sh"), "");
  const setup = "bash scripts/ci/setup.sh && ./scripts/ci/toolchain.sh --pin 1 && corepack enable";
  const fail = await setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/ci/setup.sh"] }, checkout: dir });
  assert.equal(fail.length, 1);
  assert.equal(fail[0].status, "FAIL");
  assert.match(fail[0].detail, /runs scripts\/ci\/toolchain\.sh as the runner/);
  assert.doesNotMatch(fail[0].detail, /setup\.sh/, "the protected one is not named");
  assert.match(fail[0].fix, /add \/scripts\/ci\/toolchain\.sh to protected_paths/, "the fix names the root-anchored entry");
  assert.equal((await setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/ci/"] }, checkout: dir }))[0].status, "PASS", "a directory entry covers both");
  assert.equal((await setupFilesCheck({ inputs: { setup, protectedAdditions: ["setup.sh", "toolchain.sh"] }, checkout: dir }))[0].status, "PASS", "a file-name entry matches at any depth, as on push");
  const [nothing] = await setupFilesCheck({ inputs: { setup: "sudo apt-get install -y libpq-dev", protectedAdditions: [] }, checkout: dir });
  assert.equal(nothing.status, "PASS", "a setup naming no repository file has nothing to protect");
  assert.match(nothing.detail, /^the command names no repository file it runs\. Not followed/, "and says what is never followed");
  const [missing] = await setupFilesCheck({ inputs: { setup: "bash scripts/ci/missing.sh", protectedAdditions: [] }, checkout: dir });
  assert.equal(missing.status, "PASS", "a named path the checkout does not hold needs no protected entry");
  assert.match(missing.detail, /a push changing scripts\/ci\/missing\.sh is refused/, "but no push may create it (#387)");
  // Setup renders the missing ones into PENDULUM_PROTECTED_PATHS whatever the route (no sandbox here).
  const p = await protectSetup({ setup, protectedAdditions: ["scripts/ci/setup.sh"] }, dir);
  assert.deepEqual(p.scripts, ["scripts/ci/setup.sh", "scripts/ci/toolchain.sh"]);
  assert.deepEqual(p.adding, ["/scripts/ci/toolchain.sh"], "setup adds the file anchored at the root");
  assert.deepEqual(p.protectedList, ["scripts/ci/setup.sh", "/scripts/ci/toolchain.sh"]);
  assert.equal((await setupFilesCheck({ inputs: { setup, protectedAdditions: p.protectedList }, checkout: dir }))[0].status, "PASS", "what setup renders passes doctor");
});

test("doctor without --checkout takes the settings from the default branch's workflow on GitHub: copilot there gets copilot's checks (#236)", async () => {
  const { defaultsCheck, doctorSettings } = await import("../scripts/doctor.mjs");
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const asked = [];
  let status = 200;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    asked.push([`${u.pathname}${u.search}`, init.headers?.Authorization]);
    if (status !== 200) return new Response(JSON.stringify({ message: "x" }), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/repos/o/r/actions/organization-variables") return new Response(JSON.stringify({ total_count: 1, variables: [{ name: "PENDULUM_MAX_USD", value: "9" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/repos/o/r/actions/variables") return new Response(JSON.stringify({ total_count: 1, variables: [{ name: "PENDULUM_DAILY_USD", value: "40" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("on: issues\nenv:\n  PENDULUM_HARNESS: copilot\n  PENDULUM_MODEL: gpt-x\n  PENDULUM_RUNNER_NAME: no-setting\njobs: {}\n", { status: 200 });
  };
  const copy = clone("env:\n  PENDULUM_HARNESS: codex\n");
  try {
    const r = await doctorSettings({ args: {}, checkout: clone(null), repo, token: "t", env: {} });
    assert.deepEqual(asked, [["/repos/o/r/actions/variables?per_page=30", "Bearer t"], ["/repos/o/r/actions/organization-variables?per_page=30", "Bearer t"], ["/repos/o/r/contents/.github/workflows/pendulum.yml", "Bearer t"]], "the repository's variables, the organization's it shares, and the default branch's file, with doctor's token");
    assert.equal(r.inputs.harness, "copilot");
    assert.equal(r.inputs.dailyUsd, 40, "a repository variable over the workflow (#284)");
    assert.equal(r.inputs.maxUsd, 25, "an organization variable is not Pendulum's");
    assert.deepEqual(r.checks.map((c) => [c.status, c.name]), [["WARN", "organization variables"]]);
    assert.match(r.checks[0].detail, /^organization variable PENDULUM_MAX_USD is not supported: Pendulum's settings take the repository's own variables only/);
    assert.match(defaultsCheck(r.inputs).detail, /^harness copilot, worker gpt-x,/);
    assert.deepEqual((await credentialChecks({ inputs: r.inputs, env: {}, local: false })).map((c) => c.name), ["copilot credential"]);
    assert.equal(r.env.PENDULUM_RUNNER_NAME, undefined, "only the settings Pendulum takes");
    // #402: what a local stage reads, as serve's baseEnv: the repository's settings, and this shell's own settings only.
    const shell = await doctorSettings({ args: {}, checkout: clone(null), repo, token: "t", env: { PENDULUM_GUESS_HOURS: "3, 9", PENDULUM_SUBAGENT_MODEL: "mine" } });
    assert.deepEqual([shell.env.PENDULUM_GUESS_HOURS, shell.stage.PENDULUM_GUESS_HOURS], ["3, 9", undefined], "a shell-only repository setting reaches no stage");
    assert.deepEqual([shell.stage.PENDULUM_DAILY_USD, shell.stage.PENDULUM_SUBAGENT_MODEL], ["40", "mine"]);
    // GitHub's copy wins over a clone's here; this shell wins over both.
    assert.equal((await doctorSettings({ args: {}, checkout: copy, repo, token: "t", env: {} })).inputs.harness, "copilot");
    assert.equal((await doctorSettings({ args: {}, checkout: copy, repo, token: "t", env: { PENDULUM_HARNESS: "claude" } })).inputs.harness, "claude");
    // With --checkout, that checkout's copy, and GitHub's file is not read.
    asked.length = 0;
    assert.equal((await doctorSettings({ args: { checkout: copy }, checkout: copy, repo, token: "t", env: {} })).inputs.harness, "codex");
    assert.deepEqual(asked.map(([p]) => p), ["/repos/o/r/actions/variables?per_page=30", "/repos/o/r/actions/organization-variables?per_page=30"]);
    // Unreadable: one WARN naming the harness assumed, from the local copy when there is one.
    for (status of [404, 403]) {
      const none = await doctorSettings({ args: {}, checkout: clone(null), repo, token: "t", env: {} });
      assert.equal(none.inputs.harness, "claude");
      assert.deepEqual(none.checks.map((c) => [c.status, c.name]), [["WARN", "workflow settings"], ["WARN", "repository variables"]]);
      assert.equal(none.checks[0].name, "workflow settings");
      assert.match(none.checks[0].detail, new RegExp(`\\(HTTP ${status}\\), so the checks take no workflow's settings and assume harness claude$`));
      const here = await doctorSettings({ args: {}, checkout: copy, repo, token: "t", env: {} });
      assert.equal(here.inputs.harness, "codex");
      assert.match(here.checks[0].detail, /'s copy and assume harness codex$/);
    }
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
});

test("doctor never starts a bash, or any program, the repository ships, whatever PATH holds (#386)", async () => {
  const { commandCheck, systemBash } = await import("../scripts/doctor.mjs");
  const { chmodSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "doctor-repo-"));
  const marker = join(mkdtempSync(join(tmpdir(), "doctor-marker-")), "ran");
  const plant = (rel) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(dir, rel), 0o755);
  };
  for (const rel of ["bash", "node_modules/.bin/bash", "tool386"]) plant(rel);
  const env = { PATH: [".", "", "node_modules/.bin", join(dir, "node_modules", ".bin"), "/usr/bin", "/bin"].join(":") };
  const bash = systemBash(env, dir);
  assert.ok(bash && !bash.startsWith(dir), `the system's bash, not the repository's: ${bash}`);
  for (const cmd of ["tool386 --setup", "./tool386", "bash -c true"]) {
    const r = await commandCheck("setup", cmd, { checkout: dir, env, missing: "" });
    assert.equal(r.status, "PASS", `${cmd}: ${r.detail}`);
  }
  assert.equal(existsSync(marker), false, "nothing the repository ships ran");
});

/**
 * githubChecks against a fake GitHub (#418): pendulum.yml as `flow`, the other workflows as `files` (listed in that
 * order), and an active ruleset on the default branch with a merge queue and `required` as its required checks.
 */
async function rowsWith({ flow, files = {}, required = [], refused = {}, fetched = [] }) {
  const { githubChecks } = await import("../scripts/doctor.mjs");
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const json = (st, b) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
  const all = { ".github/workflows/pendulum.yml": flow, ...files };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/o/r") return json(200, { default_branch: "main", owner: { type: "Organization" } });
    if (path === "/repos/o/r/actions/workflows") return json(200, { workflows: Object.entries(all).map(([p, t]) => ({ path: p, name: /^name: (.+)$/m.exec(t)?.[1] ?? p, state: "active" })) });
    if (path === "/repos/o/r/rulesets") return json(200, [{ id: 1, target: "branch", enforcement: "active" }]);
    if (path === "/repos/o/r/rulesets/1") return json(200, { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "merge_queue" }, { type: "required_status_checks", parameters: { required_status_checks: required.map((context) => ({ context })) } }] });
    const file = decodeURIComponent(path.replace("/repos/o/r/contents/", ""));
    if (path.startsWith("/repos/o/r/contents/")) fetched.push(file);
    if (refused[file]) return json(refused[file], { message: "Resource not accessible by integration" });
    if (all[file] !== undefined) return new Response(all[file], { status: 200 });
    if (path === "/graphql") return json(200, { data: {} });
    return json(404, { message: "Not Found" });
  };
  const inputs = { repo: "o/r", objectiveLabel: "pendulum:objective", maintainers: [], notify: "", ciChecks: [], setup: "", validation: [], githubToken: "" };
  try {
    const rows = await githubChecks({ inputs, repo, token: "t", app: { appSlug: "pendulum-app", missing: [], extra: [] }, env: { GITHUB_WORKSPACE: mkdtempSync(join(tmpdir(), "ws-")) }, job: true });
    return Object.fromEntries(rows.map((r) => [r.name, r]));
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

test("doctor's job token row reads pendulum.yml's parsed permissions, each job's own replacing the top level's, never its text (#418)", async () => {
  const token = async (flow) => (await rowsWith({ flow }))["job token"];
  const job = (perms) => `on: issues\npermissions:\n  contents: read\njobs:\n  work:\n    runs-on: ubuntu-latest\n${perms}    steps:\n      - run: echo\n`;
  // The shipped template's shapes: the top level reads, one job asks for actions alone (contents none), one for contents read.
  assert.equal((await token(job("    permissions: { actions: write }\n"))).status, "PASS");
  assert.equal((await token(job("    permissions: { contents: read, issues: write }\n"))).status, "PASS");
  // A job that grants itself write-all, with contents: read at the top: the text has read and no `contents: write`.
  const all = await token(job("    permissions: write-all\n"));
  assert.equal(all.status, "FAIL");
  assert.equal(all.detail, "a job's token may write repository contents: work (contents: write, its own)");
  // read-all says no `contents: read`; a comment that names write grants nothing.
  assert.equal((await token("on: issues\npermissions: read-all\njobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n")).status, "PASS");
  assert.equal((await token(job("    # contents: write is the App's, never this token's\n"))).status, "PASS");
  // No permissions anywhere: the repository's default token, which the file does not hold to read.
  const unset = await token("on: issues\njobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n");
  assert.equal(unset.status, "FAIL");
  assert.match(unset.detail, /work \(no permissions here or at the top level, so the repository's default token\)/);
  assert.equal((await token(job("    permissions: { contents: admin }\n"))).status, "FAIL", "a value GitHub does not take is not read as read");
});

const REVIEW_GUARD = "github.event.label.name == 'pendulum:review'";
const guardRow = async (flow) => (await rowsWith({ flow }))["workflow triggers"];
const shippedWorkflow = async () => {
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  return renderWorkflow(readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8"), { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/pendulum@v1.2.3", ci_workflow: "Quality" });
};

test("doctor's workflow triggers row: a workflow on pull_request (not its first trigger) whose jobs lack the guard WARNs, though comments name the label (#488)", async () => {
  const unguarded = (await shippedWorkflow()).replaceAll(REVIEW_GUARD, "github.event.label.name != ''");
  assert.match(unguarded, /pendulum:review/);
  const row = await guardRow(unguarded);
  assert.deepEqual([row.status, row.detail], ["WARN", "pull_request trigger without the pendulum:review label guard"]);
});
