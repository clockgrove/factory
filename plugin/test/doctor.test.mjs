import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeSandboxChecks, credentialChecks, deciderCheck, gitCheck, workflowText } from "../scripts/doctor.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

const repo = { full: "o/r", owner: "o", name: "r" };
const wf = (pin) => `on: issues\njobs:\n  work:\n    steps:\n      - uses: clockgrove/factory@${pin}\n`;
function clone(text) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  if (text !== null) {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "factory.yml"), text);
  }
  return root;
}
const fail = (status) => async () => {
  throw Object.assign(new Error("no"), { status });
};

test("doctor: the workflow is read from the default branch on GitHub; a local copy behind it is noted (#2579)", async () => {
  const asked = [];
  const read = async (path, ref) => {
    asked.push([path, ref]);
    return wf("v0.7.98");
  };
  const r = await workflowText({ repo, branch: "main", env: {}, root: clone(wf("v0.7.83")), read });
  assert.deepEqual(asked, [[".github/workflows/factory.yml", "main"]]);
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

test("doctor: no workflow on the default branch is none; one GitHub cannot serve falls back to the local copy, said so", async () => {
  const none = await workflowText({ repo, branch: "main", env: {}, root: clone(wf("v0.7.83")), read: fail(404) });
  assert.equal(none.text, null);
  assert.match(none.checks[0].detail, /in this copy but not on main on GitHub/);
  assert.deepEqual(await workflowText({ repo, branch: "main", env: {}, root: clone(null), read: fail(404) }), { text: null, checks: [] });
  const down = await workflowText({ repo, branch: "main", env: {}, root: clone(wf("v0.7.83")), read: fail(503) });
  assert.equal(down.text, wf("v0.7.83"));
  assert.match(down.checks[0].detail, /could not be read from main on GitHub \(HTTP 503\); the checks read the local copy/);
});

test("setup files: every repository file the setup command runs must be protected, on every route; doctor FAILs otherwise and setup adds it", async () => {
  const { setupFilesCheck } = await import("../scripts/doctor.mjs");
  const { protectSetup } = await import("../scripts/setup.mjs");
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-files-"));
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
  // Setup renders the missing ones into FACTORY_PROTECTED_PATHS whatever the route (no sandbox here).
  const p = await protectSetup({ setup, protectedAdditions: ["scripts/ci/setup.sh"] }, dir);
  assert.deepEqual(p.scripts, ["scripts/ci/setup.sh", "scripts/ci/toolchain.sh"]);
  assert.deepEqual(p.adding, ["/scripts/ci/toolchain.sh"], "setup adds the file anchored at the root");
  assert.deepEqual(p.protectedList, ["scripts/ci/setup.sh", "/scripts/ci/toolchain.sh"]);
  assert.equal((await setupFilesCheck({ inputs: { setup, protectedAdditions: p.protectedList }, checkout: dir }))[0].status, "PASS", "what setup renders passes doctor");
});

test("setup files: a root setup file is protected at the root only, so a same-named file deeper in a monorepo stays the worker's", async () => {
  const { setupFilesCheck } = await import("../scripts/doctor.mjs");
  const { protectSetup } = await import("../scripts/setup.mjs");
  const { protectedPaths, protectedTouched } = await import("../scripts/lib/logic.mjs");
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-root-"));
  mkdirSync(join(dir, "packages", "web"), { recursive: true });
  for (const f of ["build.mjs", ".env.example", "configure", join("packages", "web", "build.mjs"), join("packages", "web", ".env.example")]) writeFileSync(join(dir, f), "");
  const p = await protectSetup({ setup: "node build.mjs && cp .env.example .env && sh configure", protectedAdditions: [] }, dir);
  assert.deepEqual(p.adding, ["/build.mjs", "/.env.example", "/configure"]);
  assert.equal((await setupFilesCheck({ inputs: { setup: "node build.mjs && cp .env.example .env && sh configure", protectedAdditions: p.protectedList }, checkout: dir }))[0].status, "PASS");
  const list = protectedPaths(p.protectedList);
  assert.deepEqual(protectedTouched(["packages/web/build.mjs", "packages/web/.env.example", "src/configure"], list), [], "an Objective editing a package's build.mjs does not Block");
  assert.deepEqual(protectedTouched(["build.mjs", ".env.example", "configure"], list), ["build.mjs", ".env.example", "configure"]);
});

test("app permissions: one list; a missing read FAILs, actions read is no extra, and README and the factory-setup skill carry the same text", async () => {
  const { APP_PERMISSIONS_TEXT, permissionGaps } = await import("../scripts/lib/app-token.mjs");
  const { appPermissionChecks } = await import("../scripts/doctor.mjs");
  const { readFileSync } = await import("node:fs");
  const full = { contents: "write", pull_requests: "write", issues: "write", organization_projects: "write", checks: "read", statuses: "read", metadata: "read" };
  assert.deepEqual(permissionGaps(full), { missing: [], extra: [] });
  assert.deepEqual(permissionGaps({ ...full, actions: "read" }), { missing: [], extra: [] }, "actions read is optional (cloud-sandbox logs), never extra");
  assert.deepEqual(permissionGaps({ ...full, checks: "write" }), { missing: [], extra: ["checks:write"] }, "a write satisfies a read, and is above the list");
  const noReads = { ...full };
  delete noReads.checks;
  delete noReads.statuses;
  assert.deepEqual(permissionGaps(noReads).missing, ["checks:read", "statuses:read"]);
  assert.deepEqual(permissionGaps({ ...full, organization_projects: "read" }).missing, ["projects:write"]);
  // A personal account's board is out of every App's reach (Projects is an organization permission, #199): not required.
  const noProjects = { ...full };
  delete noProjects.organization_projects;
  assert.deepEqual(permissionGaps(noProjects).missing, ["projects:write"], "an organization's App still needs it");
  assert.deepEqual(permissionGaps(noProjects, { userAccount: true }), { missing: [], extra: [] });
  assert.deepEqual(appPermissionChecks({ appSlug: "f", ...permissionGaps(noProjects, { userAccount: true }) }).map((c) => c.status), ["PASS"]);
  const [fail] = appPermissionChecks({ appSlug: "f", ...permissionGaps(noReads) });
  assert.equal(fail.status, "FAIL");
  assert.match(fail.detail, /missing checks:read, statuses:read/);
  const ok = appPermissionChecks({ appSlug: "f", ...permissionGaps({ ...full, actions: "read" }) });
  assert.deepEqual(ok.map((c) => c.status), ["PASS"], "no 'remove' warning on actions read");
  assert.ok(ok[0].detail.endsWith(APP_PERMISSIONS_TEXT));
  const wf = appPermissionChecks({ appSlug: "f", ...permissionGaps({ ...full, workflows: "write" }) });
  assert.deepEqual(wf.map((c) => c.status), ["PASS", "WARN"]);
  assert.match(wf[1].fix, /workflows permission off/);
  const root = join(import.meta.dirname, "..", "..");
  for (const doc of ["README.md", "plugin/skills/factory-setup/SKILL.md"]) assert.ok(readFileSync(join(root, doc), "utf8").includes(APP_PERMISSIONS_TEXT), `${doc} names the App's permissions as doctor does`);
});

test("doctor: Claude on Actions or in a cloud sandbox FAILs without bwrap, socat or rg; no shell-credential WARN anywhere", async () => {
  const names = (rows) => rows.map((r) => `${r.name}:${r.status}`);
  const none = async () => false;
  const all = async () => true;
  const claude = { harness: "claude" };
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: claude, env: { GITHUB_ACTIONS: "true" }, local: false, has: none })), ["claude sandbox: bwrap:FAIL", "claude sandbox: socat:FAIL", "claude sandbox: rg:FAIL"]);
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: claude, env: { FACTORY_STAGE_SANDBOX: "1" }, local: false, has: all })), ["claude sandbox: bwrap:PASS", "claude sandbox: socat:PASS", "claude sandbox: rg:PASS"]);
  assert.deepEqual(await claudeSandboxChecks({ inputs: claude, env: {}, local: false, has: none }), [], "a person's machine checking an Actions repository");
  assert.deepEqual(await claudeSandboxChecks({ inputs: claude, env: { GITHUB_ACTIONS: "true" }, local: true, has: none }), [], "local mode checks its own sandboxes");
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: { harness: "copilot" }, env: { GITHUB_ACTIONS: "true" }, local: false, has: none })), ["copilot sandbox: bwrap:FAIL", "copilot sandbox: slirp4netns:FAIL", "copilot sandbox: socat:FAIL"], "Copilot runs its commands in its own sandbox there too");
  const rows = await credentialChecks({ inputs: { harness: "claude", credential: "api", anthropicApiKey: "k" }, env: { GITHUB_ACTIONS: "true" } });
  assert.deepEqual(rows.filter((r) => /shell credential/.test(r.name)), [], "Claude's commands no longer see its credential on any route");
});

test("doctor: no harness's commands can read its credential off local mode, so no shell-credential row (#87)", async () => {
  const shell = (rows) => rows.filter((r) => /shell credential/.test(r.name)).map((r) => `${r.name}:${r.status}`);
  const codex = { harness: "codex", credential: "api", codexApiKey: "k", model: "m" };
  const copilot = { harness: "copilot", credential: "api", copilotGithubToken: "" };
  assert.deepEqual(shell(await credentialChecks({ inputs: codex, env: { GITHUB_ACTIONS: "true", FACTORY_INPUT_CODEX_API_KEY: "k" }, local: false })), []);
  assert.deepEqual(shell(await credentialChecks({ inputs: copilot, env: { FACTORY_STAGE_SANDBOX: "1" }, local: false })), [], "Copilot runs its commands in its own sandbox there");
  assert.deepEqual(shell(await credentialChecks({ inputs: copilot, env: {}, local: true })), []);
  assert.deepEqual(shell(await credentialChecks({ inputs: { harness: "claude", credential: "api", anthropicApiKey: "k" }, env: { GITHUB_ACTIONS: "true" }, local: false })), []);
});

test("doctor: with local triage on, a dry rerun tells whether the token can rerun CI jobs (#74)", async () => {
  const { githubChecks, rerunProbeCheck } = await import("../scripts/doctor.mjs");
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const asked = [];
  let status = 403;
  globalThis.fetch = async (url, init = {}) => {
    asked.push(`${init.method || "GET"} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ message: "x" }), { status, headers: { "content-type": "application/json" } });
  };
  try {
    const no = await rerunProbeCheck({ repo, token: "t" });
    assert.equal(no.status, "WARN");
    assert.match(no.detail, /cannot rerun CI jobs: GitHub refused a dry rerun \(403\)/);
    assert.match(no.fix, /Actions read and write/);
    assert.deepEqual(asked, ["POST /repos/o/r/actions/runs/0/rerun-failed-jobs"], "run 0, which no repository has: nothing can rerun");
    // #379: GitHub's usual 404 for run 0 is a pass that says what it saw, so a set-up machine gets a clean doctor; any
    // other answer leaves it not verified.
    status = 404;
    const r404 = await rerunProbeCheck({ repo, token: "t" });
    assert.equal(r404.status, "PASS");
    assert.match(r404.detail, /did not refuse a dry rerun \(404\)/);
    status = 500;
    const r500 = await rerunProbeCheck({ repo, token: "t" });
    assert.equal(r500.status, "WARN");
    assert.equal(r500.detail, "not verified: GitHub answered a dry rerun with 500");
    // Only a local doctor run probes, with a gateway key or without (#379: the stage's harness triages then); a stage's
    // own checks never do. (Each run stops at its next read.)
    const probed = [];
    const probeRerun = async () => (probed.push(1), { status: "WARN", name: "triage rerun" });
    const env = { GITHUB_ACTIONS: "true" };
    const run = (job, local, inputs = { aiGatewayApiKey: "k" }) => githubChecks({ inputs, repo, token: "t", app: null, env, job, local, probeRerun }).catch(() => null);
    await run(false, true);
    assert.equal(probed.length, 1, "doctor --local with a gateway key");
    await run(false, true, {});
    assert.equal(probed.length, 2, "doctor --local without one");
    await run(true, true);
    await run(false, false);
    await run(false, true, { decisionRoute: "off" });
    await run(false, true, { decisionRoute: "gateway" });
    assert.equal(probed.length, 2, "a stage's job checks, another route, or no decision call (route off, gateway with no key): no probe");
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
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
    if (u.pathname === "/repos/o/r/actions/organization-variables") return new Response(JSON.stringify({ total_count: 1, variables: [{ name: "FACTORY_MAX_USD", value: "9" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/repos/o/r/actions/variables") return new Response(JSON.stringify({ total_count: 1, variables: [{ name: "FACTORY_DAILY_USD", value: "40" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("on: issues\nenv:\n  FACTORY_HARNESS: copilot\n  FACTORY_MODEL: gpt-x\n  FACTORY_RUNNER_NAME: no-setting\njobs: {}\n", { status: 200 });
  };
  const copy = clone("env:\n  FACTORY_HARNESS: codex\n");
  try {
    const r = await doctorSettings({ args: {}, checkout: clone(null), repo, token: "t", env: {} });
    assert.deepEqual(asked, [["/repos/o/r/actions/variables?per_page=30", "Bearer t"], ["/repos/o/r/actions/organization-variables?per_page=30", "Bearer t"], ["/repos/o/r/contents/.github/workflows/factory.yml", "Bearer t"]], "the repository's variables, the organization's it shares, and the default branch's file, with doctor's token");
    assert.equal(r.inputs.harness, "copilot");
    assert.equal(r.inputs.dailyUsd, 40, "a repository variable over the workflow (#284)");
    assert.equal(r.inputs.maxUsd, 25, "an organization variable is not Factory's");
    assert.deepEqual(r.checks.map((c) => [c.status, c.name]), [["WARN", "organization variables"]]);
    assert.match(r.checks[0].detail, /^organization variable FACTORY_MAX_USD is not supported: Factory's settings take the repository's own variables only/);
    assert.match(defaultsCheck(r.inputs).detail, /^harness copilot, worker gpt-x,/);
    assert.deepEqual((await credentialChecks({ inputs: r.inputs, env: {}, local: false })).map((c) => c.name), ["copilot credential"]);
    assert.equal(r.env.FACTORY_RUNNER_NAME, undefined, "only the settings Factory takes");
    // #402: what a local stage reads, as serve's baseEnv: the repository's settings, and this shell's own settings only.
    const shell = await doctorSettings({ args: {}, checkout: clone(null), repo, token: "t", env: { FACTORY_GUESS_HOURS: "3, 9", FACTORY_SUBAGENT_MODEL: "mine" } });
    assert.deepEqual([shell.env.FACTORY_GUESS_HOURS, shell.stage.FACTORY_GUESS_HOURS], ["3, 9", undefined], "a shell-only repository setting reaches no stage");
    assert.deepEqual([shell.stage.FACTORY_DAILY_USD, shell.stage.FACTORY_SUBAGENT_MODEL], ["40", "mine"]);
    // GitHub's copy wins over a clone's here; this shell wins over both.
    assert.equal((await doctorSettings({ args: {}, checkout: copy, repo, token: "t", env: {} })).inputs.harness, "copilot");
    assert.equal((await doctorSettings({ args: {}, checkout: copy, repo, token: "t", env: { FACTORY_HARNESS: "claude" } })).inputs.harness, "claude");
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

test("doctor and serve warn when the installed plugin is older than the release the workflow pins, and say how to update (#299)", async () => {
  const { githubChecks, pluginVersionCheck } = await import("../scripts/doctor.mjs");
  const { committedWorkflowEnv } = await import("../scripts/lib/local.mjs");
  const { pluginLine } = await import("../scripts/local.mjs");
  const { FACTORY_VERSION } = await import("../scripts/lib/inputs.mjs");
  const [maj, min, pat] = FACTORY_VERSION.split(".").map(Number);
  const newer = `v${maj}.${min}.${pat + 1}`;
  const flow = (ref) => `on: issues\npermissions:\n  contents: read\njobs:\n  work:\n    steps:\n      - uses: clockgrove/factory@${ref}\n`;
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  let pinned = newer;
  let flowText = null;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const json = (st, b) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
    if (path === "/repos/o/r") return json(200, { default_branch: "main" });
    if (path === "/repos/o/r/contents/.github/workflows/factory.yml") return new Response(flowText ?? flow(pinned), { status: 200 });
    if (path === "/repos/o/r/rulesets") return json(200, []);
    if (path === "/graphql") return json(200, { data: {} });
    return json(404, { message: "Not Found" });
  };
  const inputs = { repo: "o/r", objectiveLabel: "factory:objective", maintainers: [], notify: "", ciChecks: [], setup: "", validation: [], githubToken: "" };
  const env = { GITHUB_WORKSPACE: mkdtempSync(join(tmpdir(), "ws-")) };
  const row = async (job) => (await githubChecks({ inputs, repo, token: "t", app: { appSlug: "factory-app", missing: [], extra: [] }, env, job })).filter((c) => c.name === "plugin version");
  try {
    const [old] = await row(false);
    assert.equal(old.status, "WARN");
    assert.equal(old.detail, `the installed plugin is v${FACTORY_VERSION}, older than clockgrove/factory@${newer}, which the workflow pins: a session's skills and local mode's stages run the older release`);
    assert.match(old.fix, /claude plugin update factory@clockgrove/);
    assert.match(old.fix, /codex plugin add factory@clockgrove/);
    assert.match(old.fix, /copilot plugin update factory@clockgrove/);
    assert.deepEqual(await row(true), [], "a job's plugin is the Action it pins");
    pinned = `v${FACTORY_VERSION}`;
    assert.equal((await row(false))[0].status, "PASS");
    const pinRow = async (text) => {
      flowText = text;
      return (await githubChecks({ inputs, repo, token: "t", app: { appSlug: "factory-app", missing: [], extra: [] }, env, job: true })).filter((c) => c.name === "factory pin");
    };
    assert.deepEqual((await pinRow(`# - uses: clockgrove/factory@v0.7.1\n${flow("v0.9.30")}`)).map((c) => c.status), ["PASS"], "a commented-out old pin fails nothing");
    assert.deepEqual((await pinRow(flow("v0.7.1").replace("clockgrove/factory@v0.7.1", "'clockgrove/factory@v0.7.1'"))).map((c) => c.status), ["FAIL"], "a quoted old pin is read");
    flowText = null;
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
  // By the numbers, not the text: v0.9.30 is newer than v0.9.4; a commit or a floating tag is no release to compare.
  assert.equal(pluginVersionCheck(flow("v0.9.30"), "0.9.4").status, "WARN");
  assert.equal(pluginVersionCheck(flow("v0.9.4"), "0.9.30").status, "PASS");
  assert.equal(pluginVersionCheck(flow("v1.0.0"), "0.10.2").status, "WARN");
  assert.equal(pluginVersionCheck(flow("v0.9"), "0.9.4"), null);
  assert.equal(pluginVersionCheck(flow("0123456789abcdef0123456789abcdef01234567"), "0.9.4"), null);
  // The parsed YAML decides: a commented-out pin is none, a quoted one counts, the first call wins.
  const { factoryRef } = await import("../scripts/doctor.mjs");
  const commented = `# - uses: clockgrove/factory@v9.9.9\n${flow("v0.9.4")}`;
  assert.equal(factoryRef(commented), "v0.9.4");
  assert.equal(pluginVersionCheck(commented, "0.9.4").status, "PASS", "a comment pins nothing");
  assert.equal(factoryRef("on: issues\n# uses: clockgrove/factory@v9.9.9\njobs: {}\n"), "");
  const quoted = flow('"v0.9.31"').replace('clockgrove/factory@"v0.9.31"', '"clockgrove/factory@v0.9.31"');
  assert.equal(factoryRef(quoted), "v0.9.31");
  assert.equal(pluginVersionCheck(quoted, "0.9.30").status, "WARN");
  assert.equal(factoryRef("jobs: [unclosed"), "", "a file that does not parse pins nothing");
  // serve's start: the default branch's committed workflow, read through git.
  const git = (text) => (args) => (args[0] === "show" ? (text === null ? { status: 128, stdout: "" } : { status: 0, stdout: text }) : args[0] === "ls-remote" ? { status: 0, stdout: "ref: refs/heads/main\tHEAD\n" } : { status: 0, stdout: "" });
  const line = pluginLine(committedWorkflowEnv("/clone", { git: git(flow(newer)) }));
  assert.ok(line.startsWith(`the installed plugin is v${FACTORY_VERSION}, older than clockgrove/factory@${newer}, `), line);
  assert.match(line, /; update the plugin, then start a new session: /);
  assert.equal(pluginLine(committedWorkflowEnv("/clone", { git: git(flow(`v${FACTORY_VERSION}`)) })), null);
  assert.equal(pluginLine(committedWorkflowEnv("/clone", { git: git(null) })), null, "no workflow on the default branch: nothing to compare");
});

test("mintInstallationToken reads a personal account from the installation and stops requiring projects there; an organization's still needs it (#199); doctor's row names projects only where it is needed (#360)", () => {
  const lib = join(import.meta.dirname, "..", "scripts", "lib", "app-token.mjs");
  const doctor = join(import.meta.dirname, "..", "scripts", "doctor.mjs");
  const script = `
    import { generateKeyPairSync } from "node:crypto";
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" });
    const perms = { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" };
    const { appPermissionChecks } = await import(${JSON.stringify(pathToFileURL(doctor).href)});
    const out = {};
    for (const type of ["User", "Organization"]) {
      globalThis.fetch = async (url) => {
        const p = new URL(url).pathname;
        const json = (b) => new Response(JSON.stringify(b), { status: p.endsWith("/access_tokens") ? 201 : 200, headers: { "content-type": "application/json" } });
        if (p === "/app") return json({ slug: "f", name: "F" });
        if (p === "/repos/o/r/installation") return json({ id: 9, account: { type }, permissions: perms });
        if (p === "/app/installations/9/access_tokens") return json({ token: "t", expires_at: "2099-01-01T00:00:00Z", permissions: perms });
        return new Response("{}", { status: 404 });
      };
      const { mintInstallationToken } = await import(${JSON.stringify(pathToFileURL(lib).href)} + "?" + type);
      const r = await mintInstallationToken({ appId: "1", privateKey: pem, owner: "o", repo: "r" });
      out[type] = { userAccount: r.userAccount, missing: r.missing };
      if (type === "User") out.row = appPermissionChecks(r);
      else out.orgFix = appPermissionChecks(r)[0].fix;
    }
    process.stdout.write(JSON.stringify(out));`;
  const got = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, GITHUB_API_URL: "https://github.test" }, encoding: "utf8" }));
  assert.deepEqual(got.User, { userAccount: true, missing: [] });
  assert.deepEqual(got.Organization, { userAccount: false, missing: ["projects:write"] });
  // The App on a personal account holds no projects: the PASS row must not claim it, and says it is not needed there.
  assert.deepEqual(got.row.map((c) => c.status), ["PASS"]);
  assert.doesNotMatch(got.row[0].detail, /projects: write|projects, /);
  assert.match(got.row[0].detail, /projects: not needed on a personal account \(labels carry the state\)/);
  assert.match(got.orgFix, /issues, projects: write/, "an organization's App is still told it needs projects write");
});

test("secrets on a repository a user owns: GitHub's 422 for organization secrets means none, so a missing secret still FAILs and present ones PASS", async () => {
  const { secretChecks } = await import("../scripts/doctor.mjs");
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const run = async (repoSecrets, orgStatus) => {
    globalThis.fetch = async (url) => {
      const p = new URL(url).pathname;
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (p === "/repos/me/app/actions/secrets") return json({ secrets: repoSecrets.map((name) => ({ name })) });
      if (p === "/repos/me/app/actions/organization-secrets") return orgStatus === 200 ? json({ secrets: [] }) : json({ message: "Validation Failed" }, orgStatus);
      return json({ message: "unexpected" }, 500);
    };
    return secretChecks({ inputs: { harness: "claude", credential: "api" }, repo: { owner: "me", name: "app", full: "me/app" } });
  };
  try {
    const [missing] = await run(["FACTORY_APP_ID"], 422);
    assert.equal(missing.status, "FAIL");
    assert.match(missing.detail, /missing FACTORY_APP_PRIVATE_KEY, ANTHROPIC_API_KEY/);
    const [all] = await run(["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", "ANTHROPIC_API_KEY"], 422);
    assert.equal(all.status, "PASS");
    const [unreadable] = await run(["FACTORY_APP_ID"], 403);
    assert.equal(unreadable.status, "WARN", "any other refusal is still unreadable");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

test("doctor: an unknown flag exits 64 naming it before any check; --checkout and --dir both name the clone it checks (#324)", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const doctor = join(import.meta.dirname, "..", "scripts", "doctor.mjs");
  // A GitHub that knows the repository and answers every list empty and every other read 404, so doctor runs to its end.
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/repos/o/r") return json(200, { full_name: "o/r", default_branch: "main", private: false, owner: { login: "o", type: "User" }, permissions: {} });
    if (req.url.includes("per_page")) return json(200, req.url.startsWith("/repos/o/r/actions/workflows?") ? { workflows: [] } : []);
    return json(404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, GITHUB_API_URL: api, GITHUB_GRAPHQL_URL: `${api}/graphql`, FACTORY_APP_TOKEN: "t" };
  for (const k of ["GITHUB_ACTIONS", "GITHUB_WORKSPACE"]) delete env[k];
  // Run from a directory that is no clone: doctor checks the clone it is pointed at, or this one.
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  const run = (...args) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [doctor, ...args], { cwd: elsewhere, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (status) => done({ status, stdout, stderr }));
    });
  try {
    for (const bad of [["--bogus"], ["--dir"], ["--json=yes"], ["extra"]]) {
      const r = await run("--repo", "o/r", ...bad);
      assert.equal(r.status, 64, bad.join(" "));
      assert.ok(r.stderr.includes(bad[0].split("=")[0]), `${bad.join(" ")}: the refusal names it`);
      assert.match(r.stderr, /usage: .*--checkout CLONE/);
      assert.equal(r.stdout, "", "no check ran");
    }
    assert.deepEqual(asked, [], "nothing read from GitHub");
    const help = await run("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: .*--checkout CLONE/);
    const root = clone(wf("v0.9.32"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const rows = async (...args) => {
      const r = await run("--repo", "o/r", "--json", ...args);
      assert.equal(r.status, 1, `${args.join(" ")}: the fake repository has failures (${r.stderr})`);
      return Object.fromEntries(JSON.parse(r.stdout).checks.map((c) => [c.name, c.status]));
    };
    for (const flag of ["--checkout", "--dir"]) {
      const got = await rows(flag, root);
      assert.equal(got.lockfile, "PASS", `${flag}: the clone's lockfile is found`);
      assert.equal(got["workflow settings"], undefined, `${flag}: the settings are the clone's workflow's, not GitHub's`);
    }
    const here = await rows();
    assert.equal(here.repository, "WARN", "without one, doctor checks the directory it runs in, which is no clone");
    assert.equal(here.lockfile, undefined);
  } finally {
    server.close();
  }
});

test("doctor: git 2.40 or later for the rebase check's merge-tree, and the decision model's key said with what it turns on (#362)", () => {
  assert.equal(gitCheck(false, null).status, "FAIL");
  assert.deepEqual(gitCheck(true, [2, 53, 0]), { name: "git", status: "PASS", detail: "2.53.0", fix: "" });
  assert.equal(gitCheck(true, [2, 40, 0]).status, "PASS");
  const old = gitCheck(true, [2, 39, 5]);
  assert.equal(old.status, "WARN");
  assert.match(old.detail, /^git 2\.39\.5 is older than 2\.40 .*merge-tree --merge-base/);
  assert.equal(gitCheck(true, null).status, "WARN");
  // #379: the decision calls' row says which decider judges the rebase check, and what runs with none.
  const on = deciderCheck({ inputs: { harness: "claude" }, env: { GITHUB_ACTIONS: "true" } });
  assert.equal(on.status, "PASS");
  assert.match(on.detail, /the stage's own harness \(claude\) on its login, one short call with no tools per question \(triage, drift, the answer gate, the finding check, the rebase check, the answer check, the fix-progress check, the edit check\)/);
  const off = deciderCheck({ inputs: { decisionRoute: "off" }, env: { GITHUB_ACTIONS: "true" } });
  assert.equal(off.status, "PASS");
  assert.match(off.detail, /^off \(decision_route off\): .*a send-back's conflict pass is checked by matching commits, a writer's comment resumes a Question unjudged, a red after a fix pass the exact checks cannot judge Blocks, and any edit to an Objective's text after its plan makes it stale$/);
});

test("doctor's CI row reads each workflow's parsed on: (workflowEvents), never its raw text (#386)", async () => {
  const { ciWorkflowCheck, ciWorkflowTriggers } = await import("../scripts/doctor.mjs");
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const files = {
    // pull_request and merge_group as keys of a step's `with:`: no trigger of this workflow.
    ".github/workflows/decoy.yml": "name: Decoy\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: x/y@v1\n        with:\n          pull_request: 1\n          merge_group: 1\n",
    // Both triggers in a flow mapping.
    ".github/workflows/ci.yml": "name: CI\n\"on\": {pull_request: {}, merge_group: {}}\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm test\n",
    ".github/workflows/single.yml": "name: Single\non: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n",
    ".github/workflows/broken.yml": "name: Broken\non: [pull_request, merge_group\n",
  };
  const run = async (paths) => {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/repos/o/r/actions/workflows") return new Response(JSON.stringify({ workflows: paths.map((path) => ({ path, name: path.split("/").pop(), state: "active" })) }), { status: 200, headers: { "content-type": "application/json" } });
      const path = decodeURIComponent(u.pathname.replace("/repos/o/r/contents/", ""));
      if (path === ".github/workflows/denied.yml") return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
      return files[path] !== undefined ? new Response(files[path], { status: 200, headers: { "content-type": "text/plain" } }) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    };
    return ciWorkflowTriggers(repo, { token: "t" });
  };
  try {
    const ci = await run([".github/workflows/decoy.yml", ".github/workflows/ci.yml"]);
    assert.deepEqual([ci.found, ci.path, ci.mergeGroup, ci.unread], [true, ".github/workflows/ci.yml", true, []], "the decoy's step inputs are no triggers; the flow mapping's are");
    assert.deepEqual(ci.jobs, [{ check: "test", runner: "ubuntu-24.04", commands: ["npm test"] }]);
    assert.equal(ciWorkflowCheck(ci, { queue: true }).status, "PASS");
    const single = await run([".github/workflows/single.yml"]);
    assert.deepEqual([single.found, single.mergeGroup], [true, false], "on: pull_request as one scalar");
    assert.equal(ciWorkflowCheck(single, { queue: true }).status, "FAIL", "read in full: the missing merge_group is a FAIL with a queue");
    assert.equal((await run([".github/workflows/decoy.yml"])).found, false);
    assert.equal(ciWorkflowCheck(await run([".github/workflows/decoy.yml"]), { queue: true }).status, "FAIL");
    // A workflow that cannot be parsed or read may be the one listening: a WARN naming it, never a FAIL on a guess.
    const unread = await run([".github/workflows/broken.yml", ".github/workflows/denied.yml", ".github/workflows/gone.yml"]);
    assert.equal(unread.found, false);
    assert.deepEqual(
      unread.unread.map((u) => u.split(" ")[0]),
      [".github/workflows/broken.yml", ".github/workflows/denied.yml"],
      "a listed workflow not on the default branch (404) runs nothing there",
    );
    const row = ciWorkflowCheck(unread, { queue: true });
    assert.equal(row.status, "WARN");
    assert.match(row.detail, /could not read the triggers of \.github\/workflows\/broken\.yml \(unsupported YAML.*\.github\/workflows\/denied\.yml \(HTTP 403\)/);
    // Listed by its path though it sets a name: GitHub could not parse it and runs nothing from it. With no name, the
    // path is GitHub's name for it.
    files[".github/workflows/rejected.yml"] = files[".github/workflows/ci.yml"];
    files[".github/workflows/nameless.yml"] = files[".github/workflows/ci.yml"].replace("name: CI\n", "");
    const listing = async (entries) => {
      globalThis.fetch = async (url) => {
        const u = new URL(url);
        if (u.pathname === "/repos/o/r/actions/workflows") return new Response(JSON.stringify({ workflows: entries.map((path) => ({ path, name: path, state: "active" })) }), { status: 200, headers: { "content-type": "application/json" } });
        const path = decodeURIComponent(u.pathname.replace("/repos/o/r/contents/", ""));
        return new Response(files[path], { status: 200, headers: { "content-type": "text/plain" } });
      };
      return ciWorkflowTriggers(repo, { token: "t" });
    };
    assert.equal((await listing([".github/workflows/rejected.yml"])).found, false, "GitHub runs nothing from it");
    assert.deepEqual([(await listing([".github/workflows/nameless.yml"])).path, (await listing([".github/workflows/nameless.yml"])).mergeGroup], [".github/workflows/nameless.yml", true]);
    const partial = await run([".github/workflows/single.yml", ".github/workflows/broken.yml"]);
    assert.equal(ciWorkflowCheck(partial, { queue: true }).status, "WARN", "the unread workflow may carry merge_group");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

test("doctor parses setup and validation, looks up their first command and the npm or pnpm script it runs, and runs neither (#386)", async () => {
  const { commandCheck, repositoryChecks } = await import("../scripts/doctor.mjs");
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const { chmodSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "doctor-repo-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "setup.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "scripts", "setup.sh"), 0o755);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  execFileSync("git", ["init", "-q", dir]);
  // The package managers on this PATH are stand-ins: only bash's lookup of them is under test.
  const bin = mkdtempSync(join(tmpdir(), "doctor-bin-"));
  for (const pm of ["npm", "pnpm", "yarn"]) {
    writeFileSync(join(bin, pm), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, pm), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const rows = async (settings, name) => (await repositoryChecks({ inputs: resolveInputs({ env: settings }), checkout: dir, env })).filter((c) => c.name === name);
  const setup = async (cmd) => (await rows({ FACTORY_SETUP: cmd }, "setup"))[0];
  // A correctly set-up command is a clean PASS, saying doctor did not run it.
  for (const ok of ["./scripts/setup.sh", "if true; then ./scripts/setup.sh; fi", "f() { ./scripts/setup.sh; }; f", "FOO=1 ./scripts/setup.sh --ci"]) {
    const r = await setup(ok);
    assert.equal(r.status, "PASS", ok);
    assert.match(r.detail, /doctor did not run it: --run-setup does/);
  }
  const syntax = await setup("./scripts/setup.sh && (");
  assert.equal(syntax.status, "FAIL", "a first word that exists does not make a command bash cannot parse runnable");
  assert.match(syntax.detail, /bash cannot parse it \(.*syntax error/);
  const absent = await setup("no-such-tool-386 install");
  assert.deepEqual([absent.status, absent.detail], ["WARN", "no-such-tool-386 install: no-such-tool-386 is not found here; the runner may have it"]);
  const variable = await setup("$TOOL install");
  assert.equal(variable.status, "WARN");
  assert.match(variable.detail, /its first command, \$TOOL, is not a fixed word/);
  assert.equal((await setup("npm run bootstrap")).status, "FAIL", "npm run names a script package.json lacks");
  // Nothing is run: a setup that would leave a file leaves none.
  assert.equal((await setup("touch ran-by-doctor")).status, "PASS");
  assert.equal(existsSync(join(dir, "ran-by-doctor")), false);
  // Validation: only a first command of exactly `npm|pnpm run X` is checked against package.json's scripts.
  const commands = {
    "npm audit --omit dev": "PASS",
    "pnpm test --filter web": "PASS",
    "npm run test": "PASS",
    "npm run lint": "FAIL",
    "pnpm run lint --fix": "FAIL",
    "yarn run lint": "PASS",
    "npm run lint --if-present": "PASS",
    "cd web && npm run lint": "PASS",
    "npm_config_if_present=true npm run lint": "PASS",
    "no-such-tool-386 check": "WARN",
    // A missing script fails the command only where its failure ends bash -eo pipefail.
    "npm run lint || true": "PASS",
    "npm run lint || echo skipped": "PASS",
    "(npm run lint) || true": "PASS",
    "if npm run lint; then echo ok; fi": "PASS",
    "! npm run lint": "PASS",
    "npm run lint &": "PASS",
    "npm run lint && echo x; echo y": "PASS",
    "(npm run lint)": "FAIL",
    "{ npm run lint; }": "FAIL",
    "npm run lint | tee out": "FAIL",
    "FOO=1; npm run lint": "FAIL",
    // What npm and pnpm run with no such script: npm's own env, pnpm's /regex/.
    "npm run env": "PASS",
    "pnpm run /^li/": "PASS",
    "npm test )": "FAIL",
  };
  const val = await rows({ FACTORY_VALIDATION: Object.keys(commands).join(", ") }, "validation");
  assert.deepEqual(Object.fromEntries(val.map((c) => [c.detail.split(":")[0].replace(/ \(.*$/, ""), c.status])), commands);
  assert.match(val.find((c) => c.status === "FAIL").detail, /^npm run lint: no script "lint" in package\.json$/);
  assert.match(val.at(-1).detail, /^npm test \): bash cannot parse it/);
  assert.match(val.find((c) => c.status === "WARN").detail, /no-such-tool-386 is not found here; setup may install it$/);
  // A line that uses extglob after one that turns it on parses.
  assert.equal((await commandCheck("setup", "shopt -s extglob\nls @(a|b)", { checkout: dir, env, missing: "" })).status, "PASS");
  // npm and pnpm start `node server.js` with no start script; the repository's .npmrc if-present skips a missing one.
  writeFileSync(join(dir, "server.js"), "");
  assert.equal((await commandCheck("validation", "npm run start", { checkout: dir, env, missing: "" })).status, "PASS");
  writeFileSync(join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\nif-present = true\n");
  assert.equal((await commandCheck("validation", "npm run lint", { checkout: dir, env, missing: "" })).status, "PASS");
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
 * githubChecks against a fake GitHub (#418): factory.yml as `flow`, the other workflows as `files` (listed in that
 * order), and an active ruleset on the default branch with a merge queue and `required` as its required checks.
 */
async function rowsWith({ flow, files = {}, required = [], refused = {}, fetched = [] }) {
  const { githubChecks } = await import("../scripts/doctor.mjs");
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const json = (st, b) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
  const all = { ".github/workflows/factory.yml": flow, ...files };
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
  const inputs = { repo: "o/r", objectiveLabel: "factory:objective", maintainers: [], notify: "", ciChecks: [], setup: "", validation: [], githubToken: "" };
  try {
    const rows = await githubChecks({ inputs, repo, token: "t", app: { appSlug: "factory-app", missing: [], extra: [] }, env: { GITHUB_WORKSPACE: mkdtempSync(join(tmpdir(), "ws-")) }, job: true });
    return Object.fromEntries(rows.map((r) => [r.name, r]));
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

test("doctor's job token row reads factory.yml's parsed permissions, each job's own replacing the top level's, never its text (#418)", async () => {
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

test("doctor's CI workflow row decides per required check: a workflow on pull_request makes it, and with a queue one on merge_group (#418)", async () => {
  const flow = "on: issues\npermissions:\n  contents: read\njobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";
  const wf = (name, on, job, extra = "") => `name: ${name}\non: ${on}\njobs:\n  ${job}:\n    runs-on: ubuntu-24.04\n${extra}    steps:\n      - run: npm test\n`;
  const row = async (files, required, more = {}) => (await rowsWith({ flow, files, required, ...more }))["ci workflow"];
  // Listed first and on merge_group, but none of its jobs is required; the workflow that makes `test (ubuntu)` is not on merge_group.
  const files = {
    ".github/workflows/lint.yml": wf("Lint", "[pull_request, merge_group]", "lint"),
    ".github/workflows/ci.yml": wf("CI", "pull_request", "test", "    strategy: { matrix: { os: [ubuntu] } }\n"),
  };
  const missing = await row(files, ["test (ubuntu)"]);
  assert.deepEqual([missing.status, missing.detail], ["FAIL", "test (ubuntu) is made on pull_request by CI but by no workflow on merge_group, so the queue's commit never gets it"]);
  assert.equal(missing.fix, 'add "merge_group:" under on: in .github/workflows/ci.yml');
  files[".github/workflows/ci.yml"] = files[".github/workflows/ci.yml"].replace("on: pull_request", "on: [pull_request, merge_group]");
  const ok = await row(files, ["test (ubuntu)", "lint"]);
  assert.deepEqual([ok.status, ok.detail], ["PASS", "the required checks run on pull_request and merge_group: test (ubuntu) (CI), lint (Lint)"]);
  // A required check no workflow's job makes (an App's): doctor says it cannot tell, rather than judge another workflow.
  const app = await row(files, ["Vercel"]);
  assert.deepEqual([app.status, app.detail], ["WARN", "no workflow doctor read makes Vercel, so doctor cannot tell what runs it (an App's check, or a workflow doctor could not read)"]);

  const ci = wf("CI", "[pull_request, merge_group]", "build");
  // (A) A release workflow on a tag push with a job of the same name makes no check a pull request or the queue gets.
  const release = await row({ ".github/workflows/ci.yml": ci, ".github/workflows/release.yml": wf("Release", "\n  push:\n    tags: ['v*']", "build") }, ["build"]);
  assert.deepEqual([release.status, release.detail], ["PASS", "the required checks run on pull_request and merge_group: build (CI)"]);
  // (E) Nor does a nightly schedule's matrix job.
  const nightly = await row({ ".github/workflows/nightly.yml": wf("Nightly", "\n  schedule:\n    - cron: '0 3 * * *'", "test", "    strategy: { matrix: { os: [ubuntu] } }\n"), ".github/workflows/ci.yml": wf("CI", "[pull_request, merge_group]", "test", "    strategy: { matrix: { os: [ubuntu] } }\n") }, ["test (ubuntu)"]);
  assert.equal(nightly.status, "PASS");
  // A pull_request-only shim and a merge_group workflow that make the same check together cover it.
  assert.equal((await row({ ".github/workflows/shim.yml": wf("Shim", "pull_request", "build"), ".github/workflows/queue.yml": wf("Queue", "merge_group", "build") }, ["build"])).status, "PASS");
  // (B) Made only on merge_group: a pull request never gets the check, so it is never enqueued.
  const mgOnly = await row({ ".github/workflows/ci.yml": wf("CI", "[merge_group]", "build") }, ["build"]);
  assert.deepEqual([mgOnly.status, mgOnly.detail, mgOnly.fix], ["FAIL", "build is made only by CI (on merge_group), so a pull request never gets it", 'add "pull_request:" under on: in .github/workflows/ci.yml']);
  // Made only by a release workflow: no pull request ever gets it either.
  assert.equal((await row({ ".github/workflows/release.yml": wf("Release", "\n  push:\n    tags: ['v*']", "build") }, ["build"])).status, "FAIL");
  // (C) Only some checks matched: the row names the one no workflow makes, and the PASS never claims it.
  const partial = await row({ ".github/workflows/ci.yml": ci }, ["build", "e2e"]);
  assert.deepEqual([partial.status, partial.detail], ["WARN", "no workflow doctor read makes e2e, so doctor cannot tell what runs it (an App's check, or a workflow doctor could not read)"]);
  // (D) The same with a workflow doctor could not read: it is named, and no FAIL rests on a check it could make.
  const e2e = { ".github/workflows/ci.yml": ci, ".github/workflows/e2e.yml": wf("E2E", "[pull_request, merge_group]", "e2e") };
  const hidden = await row(e2e, ["build", "e2e"], { refused: { ".github/workflows/e2e.yml": 403 } });
  assert.equal(hidden.status, "WARN");
  assert.match(hidden.detail, /^no workflow doctor read makes e2e, .*; could not read the triggers of \.github\/workflows\/e2e\.yml \(HTTP 403\)$/);
  const unsure = await row({ ".github/workflows/ci.yml": wf("CI", "pull_request", "build"), ".github/workflows/e2e.yml": "" }, ["build"], { refused: { ".github/workflows/e2e.yml": 403 } });
  assert.equal(unsure.status, "WARN", "the unread workflow could be the merge_group maker");
  // Once every check has both makers, the row fetches no later workflow (the ci token row reads each one once before it).
  const fetched = [];
  await row({ ".github/workflows/ci.yml": ci, ".github/workflows/other.yml": wf("Other", "push", "x") }, ["build"], { fetched });
  assert.deepEqual([fetched.filter((p) => p.endsWith("ci.yml")).length, fetched.filter((p) => p.endsWith("other.yml")).length], [2, 1]);
});
