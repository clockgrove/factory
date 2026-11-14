import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeSandboxChecks, credentialChecks, workflowText } from "../scripts/doctor.mjs";
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
  const fail = setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/ci/setup.sh"] }, checkout: dir });
  assert.equal(fail.length, 1);
  assert.equal(fail[0].status, "FAIL");
  assert.match(fail[0].detail, /runs scripts\/ci\/toolchain\.sh as the runner/);
  assert.doesNotMatch(fail[0].detail, /setup\.sh/, "the protected one is not named");
  assert.match(fail[0].fix, /add \/scripts\/ci\/toolchain\.sh to protected_paths/, "the fix names the root-anchored entry");
  assert.equal(setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/ci/"] }, checkout: dir })[0].status, "PASS", "a directory entry covers both");
  assert.equal(setupFilesCheck({ inputs: { setup, protectedAdditions: ["setup.sh", "toolchain.sh"] }, checkout: dir })[0].status, "PASS", "a file-name entry matches at any depth, as on push");
  assert.deepEqual(setupFilesCheck({ inputs: { setup: "sudo apt-get install -y libpq-dev", protectedAdditions: [] }, checkout: dir }), [], "a setup naming no repository file has nothing to protect");
  assert.deepEqual(setupFilesCheck({ inputs: { setup: "bash scripts/ci/missing.sh", protectedAdditions: [] }, checkout: dir }), [], "a named path the checkout does not hold is not a repository file");
  // Setup renders the missing ones into FACTORY_PROTECTED_PATHS whatever the route (no sandbox here).
  const p = protectSetup({ setup, protectedAdditions: ["scripts/ci/setup.sh"] }, dir);
  assert.deepEqual(p.scripts, ["scripts/ci/setup.sh", "scripts/ci/toolchain.sh"]);
  assert.deepEqual(p.adding, ["/scripts/ci/toolchain.sh"], "setup adds the file anchored at the root");
  assert.deepEqual(p.protectedList, ["scripts/ci/setup.sh", "/scripts/ci/toolchain.sh"]);
  assert.equal(setupFilesCheck({ inputs: { setup, protectedAdditions: p.protectedList }, checkout: dir })[0].status, "PASS", "what setup renders passes doctor");
});

test("setup files: a root setup file is protected at the root only, so a same-named file deeper in a monorepo stays the worker's", async () => {
  const { setupFilesCheck } = await import("../scripts/doctor.mjs");
  const { protectSetup } = await import("../scripts/setup.mjs");
  const { protectedPaths, protectedTouched } = await import("../scripts/lib/logic.mjs");
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-root-"));
  mkdirSync(join(dir, "packages", "web"), { recursive: true });
  for (const f of ["build.mjs", ".env.example", "configure", join("packages", "web", "build.mjs"), join("packages", "web", ".env.example")]) writeFileSync(join(dir, f), "");
  const p = protectSetup({ setup: "node build.mjs && cp .env.example .env && sh configure", protectedAdditions: [] }, dir);
  assert.deepEqual(p.adding, ["/build.mjs", "/.env.example", "/configure"]);
  assert.equal(setupFilesCheck({ inputs: { setup: "node build.mjs && cp .env.example .env && sh configure", protectedAdditions: p.protectedList }, checkout: dir })[0].status, "PASS");
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
    // GitHub may answer 404 for run 0 with or without the permission: never a pass.
    for (status of [404, 500]) {
      const r = await rerunProbeCheck({ repo, token: "t" });
      assert.equal(r.status, "WARN", String(status));
      assert.equal(r.detail, `not verified: GitHub answered a dry rerun with ${status}`);
    }
    // Only a local doctor run with triage on probes; a stage's own checks never do. (Each run stops at its next read.)
    const probed = [];
    const probeRerun = async () => (probed.push(1), { status: "WARN", name: "triage rerun" });
    const env = { GITHUB_ACTIONS: "true" };
    const run = (job, local, inputs = { aiGatewayApiKey: "k" }) => githubChecks({ inputs, repo, token: "t", app: null, env, job, local, probeRerun }).catch(() => null);
    await run(false, true);
    assert.equal(probed.length, 1, "doctor --local with a gateway key");
    await run(true, true);
    await run(false, false);
    await run(false, true, {});
    assert.equal(probed.length, 1, "a stage's job checks, another route, or triage off: no probe");
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
});

test("mintInstallationToken reads a personal account from the installation and stops requiring projects there; an organization's still needs it (#199)", () => {
  const lib = join(import.meta.dirname, "..", "scripts", "lib", "app-token.mjs");
  const script = `
    import { generateKeyPairSync } from "node:crypto";
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" });
    const perms = { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" };
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
    }
    process.stdout.write(JSON.stringify(out));`;
  const got = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, GITHUB_API_URL: "https://github.test" }, encoding: "utf8" }));
  assert.deepEqual(got.User, { userAccount: true, missing: [] });
  assert.deepEqual(got.Organization, { userAccount: false, missing: ["projects:write"] });
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
