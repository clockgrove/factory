import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialChecks, workflowText } from "../scripts/doctor.mjs";

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

test("app permissions: one list; a missing read FAILs, actions read is no extra, and README and the setup skill carry the same text", async () => {
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
  for (const doc of ["README.md", "plugin/skills/setup/SKILL.md"]) assert.ok(readFileSync(join(root, doc), "utf8").includes(APP_PERMISSIONS_TEXT), `${doc} names the App's permissions as doctor does`);
});

test("doctor: Claude off local mode WARNs that its Bash commands can read its credential; local mode and Codex do not", async () => {
  const env = { GITHUB_ACTIONS: "true" };
  const shell = (rows) => rows.filter((r) => r.name === "claude shell credential");
  for (const credential of ["api", "plan"]) {
    const rows = shell(await credentialChecks({ inputs: { harness: "claude", credential, anthropicApiKey: credential === "api" ? "k" : "", claudeCodeOauthToken: credential === "plan" ? "t" : "" }, env, local: false }));
    assert.deepEqual(rows.map((r) => r.status), ["WARN"], `claude ${credential} on Actions or in a sandbox`);
    assert.match(rows[0].detail, /bubblewrap/);
  }
  assert.deepEqual(shell(await credentialChecks({ inputs: { harness: "claude", credential: "login" }, env: {}, local: false })).map((r) => r.status), ["WARN"], "a person's doctor run for an Actions repository, on the CLI login");
  assert.deepEqual(shell(await credentialChecks({ inputs: { harness: "claude", credential: "api", anthropicApiKey: "k" }, env, local: true })), [], "local mode runs Claude's commands in its sandbox");
  assert.deepEqual(shell(await credentialChecks({ inputs: { harness: "codex", credential: "api", codexApiKey: "k", model: "m" }, env, local: false })), [], "Codex withholds its key on every route");
});
