import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GITHUB_TOKEN_KEYS, LOCAL_WORKFLOW_SETTINGS, MODEL_SECRET_KEYS, RUNNER_SECRET_KEYS, SECRET_INPUTS, WORKFLOW_SETTINGS, workflowSettings } from "../scripts/lib/inputs.mjs";
import { FACTORY_CHILD_KEYS, FACTORY_CONTROL_KEYS, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { workflowEnv } from "../scripts/lib/local.mjs";
import { Local } from "../scripts/local.mjs";
import { workflowEnvChecks } from "../scripts/doctor.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/** The Action's inputs, by action.yml's own `inputs:` block. */
function actionInputs() {
  const text = readFileSync(join(ROOT, "action.yml"), "utf8");
  const block = text.split(/^inputs:\s*$/m)[1].split(/^\S/m)[0];
  return [...block.matchAll(/^ {2}([a-z_]+):\s*$/gm)].map((m) => m[1]);
}

test("the workflow settings are the Action's inputs under their env names, but secrets and a run's own, and local mode's documented settings (#119)", () => {
  const inputs = actionInputs();
  assert.ok(inputs.length > 40 && inputs.includes("validation"));
  const expected = new Set([...inputs.filter((n) => !SECRET_INPUTS.has(n) && !["mode", "issue", "pr"].includes(n)).map((n) => `FACTORY_${n.toUpperCase()}`), ...LOCAL_WORKFLOW_SETTINGS]);
  assert.deepEqual([...WORKFLOW_SETTINGS].sort(), [...expected].sort(), "derived from DEFAULTS, which must match action.yml");
  const local = readFileSync(join(ROOT, "docs", "LOCAL.md"), "utf8");
  for (const n of LOCAL_WORKFLOW_SETTINGS) assert.ok(local.includes(`\`${n}`), `${n} is documented in docs/LOCAL.md`);
});

test("local mode takes only settings from the workflow file; any other FACTORY_* name is dropped, named, and warned by doctor (#119)", () => {
  const wf = workflowEnv(
    [
      "name: Factory",
      "env:",
      "  FACTORY_MODEL: claude-opus-5-5",
      "  FACTORY_VALIDATION: 'npm test'",
      "  FACTORY_LOCAL_DOMAINS: pypi.org",
      "  FACTORY_LOCAL_SRT_HARNESS: ./tools/open.json",
      "  FACTORY_APP_SLUG: someone-else",
      "  FACTORY_APP_TOKEN: ghs_planted",
      "  FACTORY_PROGRESS_RUN: other-run",
      "  FACTORY_SHELL_SECRETS: '{\"X\":\"1\"}'",
      "  FACTORY_ISSUE: '7'",
      "  FACTORY_RELAY_BWRAP: ./tools/bwrap",
      "jobs: {}",
    ].join("\n"),
  );
  const { kept, dropped } = workflowSettings(wf);
  assert.deepEqual(kept, { FACTORY_MODEL: "claude-opus-5-5", FACTORY_VALIDATION: "npm test", FACTORY_LOCAL_DOMAINS: "pypi.org" });
  assert.deepEqual(dropped, ["FACTORY_LOCAL_SRT_HARNESS", "FACTORY_APP_SLUG", "FACTORY_APP_TOKEN", "FACTORY_PROGRESS_RUN", "FACTORY_SHELL_SECRETS", "FACTORY_ISSUE", "FACTORY_RELAY_BWRAP"], "a name added later is dropped too, with no list to update");
  // A stage's base env, as Local builds it from what it kept.
  const base = Local.prototype.baseEnv.call({ wf: kept, harness: "claude" });
  assert.equal(base.FACTORY_MODEL, process.env.FACTORY_MODEL || "claude-opus-5-5");
  for (const k of dropped) assert.ok(!(k in base) || process.env[k], `${k} never reaches a stage from the workflow`);
  const [warn] = workflowEnvChecks(wf);
  assert.equal(warn.status, "WARN");
  assert.match(warn.detail, /FACTORY_LOCAL_SRT_HARNESS, FACTORY_APP_SLUG.*no Factory setting: local mode ignores them/);
  assert.deepEqual(workflowEnvChecks(kept), [], "settings alone: nothing to say");
});

test("local mode leaves the cloud-sandbox route's own workflow setting out of every stage without warning about it (#179)", () => {
  const wf = { FACTORY_MODEL: "claude-opus-5-5", FACTORY_SANDBOX_VCPUS: "4", FACTORY_NOT_A_SETTING: "x" };
  const { kept, dropped, otherRoute } = workflowSettings(wf);
  assert.deepEqual(kept, { FACTORY_MODEL: "claude-opus-5-5" });
  assert.deepEqual(otherRoute, ["FACTORY_SANDBOX_VCPUS"], "setup writes it for the cloud-sandbox route");
  assert.deepEqual(dropped, ["FACTORY_NOT_A_SETTING"], "an unknown name is still dropped and warned about");
  const base = Local.prototype.baseEnv.call({ wf: kept, harness: "claude" });
  assert.ok(!("FACTORY_SANDBOX_VCPUS" in base) || process.env.FACTORY_SANDBOX_VCPUS, "never reaches a stage from the workflow");
  const [warn, more] = workflowEnvChecks(wf);
  assert.equal(more, undefined);
  assert.match(warn.detail, /FACTORY_NOT_A_SETTING/);
  assert.doesNotMatch(warn.detail, /FACTORY_SANDBOX_VCPUS/);
  assert.deepEqual(workflowEnvChecks({ FACTORY_MODEL: "m", FACTORY_SANDBOX_VCPUS: "4" }), [], "a cloud-route workflow: nothing to say");
});

test("scrubbedEnv removes Factory's control variables from every child, and keeps what children are given on purpose (#119)", () => {
  const given = Object.fromEntries([...FACTORY_CONTROL_KEYS, ...FACTORY_CHILD_KEYS].map((k) => [k, "v"]));
  const e = scrubbedEnv({ ...given, FACTORY_MODEL: "m", PATH: "/usr/bin" });
  for (const k of FACTORY_CONTROL_KEYS) assert.ok(!(k in e), `${k} removed`);
  for (const k of FACTORY_CHILD_KEYS.filter((k) => !["FACTORY_SHELL_SECRETS", "FACTORY_LFS_PIN"].includes(k))) assert.equal(e[k], "v", `${k} kept`);
  assert.equal(e.FACTORY_MODEL, "m");
});

test("every FACTORY_* name Factory reads is a setting, a secret, a control variable or one it hands children: none is the workflow's to set (#119)", () => {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(ROOT, "plugin", "scripts"));
  walk(join(ROOT, "plugin", "bin"));
  const names = new Set();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bFACTORY_[A-Z0-9_]*[A-Z0-9]\b/g)) names.add(m[0]);
  // Names of constants in Factory's code, not environment variables.
  const constants = new Set(["FACTORY_PROTECTED", "FACTORY_SECRET_KEYS", "FACTORY_VERSION", "FACTORY_CONTROL_KEYS", "FACTORY_CHILD_KEYS"]);
  const secrets = new Set([...[...SECRET_INPUTS].map((n) => `FACTORY_${n.toUpperCase()}`), ...RUNNER_SECRET_KEYS, ...GITHUB_TOKEN_KEYS, ...MODEL_SECRET_KEYS]);
  const known = new Set([...WORKFLOW_SETTINGS, ...secrets, ...FACTORY_CONTROL_KEYS, ...FACTORY_CHILD_KEYS, ...constants]);
  const unclassified = [...names].filter((n) => !n.startsWith("FACTORY_INPUT_") && !known.has(n));
  assert.deepEqual(unclassified, [], "classify each new name: FACTORY_CONTROL_KEYS (scrubbed from children) or FACTORY_CHILD_KEYS (lib/harness.mjs)");
  for (const k of [...FACTORY_CONTROL_KEYS, ...FACTORY_CHILD_KEYS, ...[...SECRET_INPUTS].map((n) => `FACTORY_${n.toUpperCase()}`)]) assert.ok(!WORKFLOW_SETTINGS.has(k), `${k} is no workflow setting`);
});

test("local mode reads the workflow's settings from the default branch's commit, never the working tree's branch; a working tree that differs is named (#122)", async () => {
  const { committedWorkflowEnv } = await import("../scripts/lib/local.mjs");
  const { workflowDriftLines } = await import("../scripts/lib/inputs.mjs");
  const { workflowSourceChecks } = await import("../scripts/doctor.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "wf-"));
  const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  execFileSync("git", ["init", "-q", "--bare", "-b", "trunk", origin]);
  execFileSync("git", ["clone", "-q", origin, dev]);
  const flow = (env) => {
    mkdirSync(join(dev, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dev, ".github", "workflows", "factory.yml"), `name: Factory\nenv:\n${Object.entries(env).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\njobs: {}\n`);
  };
  git(dev, "checkout", "-q", "-b", "trunk");
  writeFileSync(join(dev, "README"), "x\n");
  git(dev, "add", "README");
  git(dev, "commit", "-q", "-m", "first");
  git(dev, "push", "-q", "origin", "trunk");
  assert.deepEqual(committedWorkflowEnv(dev), { wf: {}, branch: "trunk", error: "origin/trunk has no .github/workflows/factory.yml" }, "none on the default branch: none used");
  flow({ FACTORY_MODEL: "m1", FACTORY_LOCAL_DOMAINS: "pypi.org" });
  git(dev, "add", ".github");
  git(dev, "commit", "-q", "-m", "workflow");
  git(dev, "push", "-q", "origin", "trunk");
  // An unreviewed branch checked out here widens local mode in its working tree, and in a commit of its own.
  git(dev, "checkout", "-q", "-b", "contributor");
  flow({ FACTORY_MODEL: "m1", FACTORY_LOCAL_DOMAINS: "evil.example", FACTORY_LOCAL_ENV: "AWS_SECRET_ACCESS_KEY" });
  git(dev, "commit", "-qam", "widen");
  const committed = committedWorkflowEnv(dev);
  assert.deepEqual(committed, { wf: { FACTORY_MODEL: "m1", FACTORY_LOCAL_DOMAINS: "pypi.org" }, branch: "trunk", error: null }, "the default branch's, whatever is checked out");
  const working = workflowEnv(readFileSync(join(dev, ".github", "workflows", "factory.yml"), "utf8"));
  assert.deepEqual(workflowDriftLines(working, committed), [".github/workflows/factory.yml here differs from origin/trunk in FACTORY_LOCAL_DOMAINS, FACTORY_LOCAL_ENV: local mode uses origin/trunk's; commit the change to trunk to use it"]);
  const [warn] = workflowSourceChecks(working, committed);
  assert.equal(warn.status, "WARN");
  assert.match(warn.detail, /FACTORY_LOCAL_DOMAINS, FACTORY_LOCAL_ENV/);
  assert.deepEqual(workflowSourceChecks(committed.wf, committed), [], "the same settings: nothing to say");
  assert.match(workflowSourceChecks({}, { wf: {}, branch: "trunk", error: "origin/trunk has no .github/workflows/factory.yml" })[0].detail, /uses none/);
  // Doctor run outside a clone (--repo only): not checked, which says nothing about what serve uses.
  const none = committedWorkflowEnv("/nowhere", { git: () => ({ status: 128, stdout: "" }) });
  assert.equal(none.noClone, true);
  const [skipped] = workflowSourceChecks({}, none);
  assert.match(skipped.detail, /^not checked: doctor runs outside a clone/);
  assert.doesNotMatch(skipped.detail, /uses none/);
  // A change pushed to the default branch is what the next start reads (fetched first).
  git(dev, "checkout", "-q", "trunk");
  flow({ FACTORY_MODEL: "m2" });
  git(dev, "commit", "-qam", "m2");
  git(dev, "push", "-q", "origin", "trunk");
  git(dev, "reset", "-q", "--hard", "HEAD~1");
  git(dev, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  assert.deepEqual(committedWorkflowEnv(dev).wf, { FACTORY_MODEL: "m2" });
});
