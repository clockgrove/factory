import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GITHUB_TOKEN_KEYS, LOCAL_WORKFLOW_SETTINGS, MODEL_SECRET_KEYS, PER_RUN_INPUTS, RUNNER_SECRET_KEYS, SECRET_INPUTS, WORKFLOW_SETTINGS, workflowSettings } from "../scripts/lib/inputs.mjs";
import { PENDULUM_CHILD_KEYS, PENDULUM_CONTROL_KEYS, scrubbedEnv } from "../scripts/lib/harness.mjs";
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
  const expected = new Set([...inputs.filter((n) => !SECRET_INPUTS.has(n) && !PER_RUN_INPUTS.includes(n)).map((n) => `PENDULUM_${n.toUpperCase()}`), ...LOCAL_WORKFLOW_SETTINGS]);
  assert.deepEqual([...WORKFLOW_SETTINGS].sort(), [...expected].sort(), "derived from DEFAULTS, which must match action.yml");
  const local = readFileSync(join(ROOT, "docs", "LOCAL.md"), "utf8");
  for (const n of LOCAL_WORKFLOW_SETTINGS) assert.ok(local.includes(`\`${n}`), `${n} is documented in docs/LOCAL.md`);
});

test("local mode takes only settings from the workflow file; any other PENDULUM_* name is dropped, named, and warned by doctor (#119)", () => {
  const wf = workflowEnv(
    [
      "name: Pendulum",
      "env:",
      "  PENDULUM_MODEL: claude-opus-5-5",
      "  PENDULUM_VALIDATION: 'npm test'",
      "  PENDULUM_LOCAL_DOMAINS: pypi.org",
      "  PENDULUM_LOCAL_SRT_HARNESS: ./tools/open.json",
      "  PENDULUM_APP_SLUG: someone-else",
      "  PENDULUM_APP_TOKEN: ghs_planted",
      "  PENDULUM_PROGRESS_RUN: other-run",
      "  PENDULUM_SHELL_SECRETS: '{\"X\":\"1\"}'",
      "  PENDULUM_ISSUE: '7'",
      "  PENDULUM_RELAY_BWRAP: ./tools/bwrap",
      "jobs: {}",
    ].join("\n"),
  );
  const { kept, dropped } = workflowSettings(wf);
  assert.deepEqual(kept, { PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_VALIDATION: "npm test", PENDULUM_LOCAL_DOMAINS: "pypi.org" });
  assert.deepEqual(dropped, ["PENDULUM_LOCAL_SRT_HARNESS", "PENDULUM_APP_SLUG", "PENDULUM_APP_TOKEN", "PENDULUM_PROGRESS_RUN", "PENDULUM_SHELL_SECRETS", "PENDULUM_ISSUE", "PENDULUM_RELAY_BWRAP"], "a name added later is dropped too, with no list to update");
  // A stage's base env, as Local builds it from what it kept.
  const base = Local.prototype.baseEnv.call({ wf: kept, harness: "claude" });
  assert.equal(base.PENDULUM_MODEL, process.env.PENDULUM_MODEL || "claude-opus-5-5");
  for (const k of dropped) assert.ok(!(k in base) || process.env[k], `${k} never reaches a stage from the workflow`);
  const [warn] = workflowEnvChecks(wf);
  assert.equal(warn.status, "WARN");
  assert.match(warn.detail, /PENDULUM_LOCAL_SRT_HARNESS, PENDULUM_APP_SLUG.*no Pendulum setting: local mode ignores them/);
  assert.deepEqual(workflowEnvChecks(kept), [], "settings alone: nothing to say");
});

test("local mode leaves the cloud-sandbox route's own workflow setting out of every stage without warning about it (#179)", () => {
  const wf = { PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_SANDBOX_VCPUS: "4", PENDULUM_NOT_A_SETTING: "x" };
  const { kept, dropped, otherRoute } = workflowSettings(wf);
  assert.deepEqual(kept, { PENDULUM_MODEL: "claude-opus-5-5" });
  assert.deepEqual(otherRoute, ["PENDULUM_SANDBOX_VCPUS"], "setup writes it for the cloud-sandbox route");
  assert.deepEqual(dropped, ["PENDULUM_NOT_A_SETTING"], "an unknown name is still dropped and warned about");
  const base = Local.prototype.baseEnv.call({ wf: kept, harness: "claude" });
  assert.ok(!("PENDULUM_SANDBOX_VCPUS" in base) || process.env.PENDULUM_SANDBOX_VCPUS, "never reaches a stage from the workflow");
  const [warn, more] = workflowEnvChecks(wf);
  assert.equal(more, undefined);
  assert.match(warn.detail, /PENDULUM_NOT_A_SETTING/);
  assert.doesNotMatch(warn.detail, /PENDULUM_SANDBOX_VCPUS/);
  assert.deepEqual(workflowEnvChecks({ PENDULUM_MODEL: "m", PENDULUM_SANDBOX_VCPUS: "4" }), [], "a cloud-route workflow: nothing to say");
});

test("scrubbedEnv removes Pendulum's control variables from every child, and keeps what children are given on purpose (#119)", () => {
  const given = Object.fromEntries([...PENDULUM_CONTROL_KEYS, ...PENDULUM_CHILD_KEYS].map((k) => [k, "v"]));
  const e = scrubbedEnv({ ...given, PENDULUM_MODEL: "m", PATH: "/usr/bin" });
  for (const k of PENDULUM_CONTROL_KEYS) assert.ok(!(k in e), `${k} removed`);
  for (const k of PENDULUM_CHILD_KEYS.filter((k) => !["PENDULUM_SHELL_SECRETS", "PENDULUM_LFS_PIN"].includes(k))) assert.equal(e[k], "v", `${k} kept`);
  assert.equal(e.PENDULUM_MODEL, "m");
});

test("every PENDULUM_* name Pendulum reads is a setting, a secret, a control variable or one it hands children: none is the workflow's to set (#119)", () => {
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
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bPENDULUM_[A-Z0-9_]*[A-Z0-9]\b/g)) names.add(m[0]);
  // Names of constants in Pendulum's code, not environment variables.
  const constants = new Set(["PENDULUM_PROTECTED", "PENDULUM_SECRET_KEYS", "PENDULUM_VERSION", "PENDULUM_CONTROL_KEYS", "PENDULUM_CHILD_KEYS"]);
  const secrets = new Set([...[...SECRET_INPUTS].map((n) => `PENDULUM_${n.toUpperCase()}`), ...RUNNER_SECRET_KEYS, ...GITHUB_TOKEN_KEYS, ...MODEL_SECRET_KEYS]);
  const known = new Set([...WORKFLOW_SETTINGS, ...secrets, ...PENDULUM_CONTROL_KEYS, ...PENDULUM_CHILD_KEYS, ...constants]);
  const unclassified = [...names].filter((n) => !n.startsWith("PENDULUM_INPUT_") && !known.has(n));
  assert.deepEqual(unclassified, [], "classify each new name: PENDULUM_CONTROL_KEYS (scrubbed from children) or PENDULUM_CHILD_KEYS (lib/harness.mjs)");
  for (const k of [...PENDULUM_CONTROL_KEYS, ...PENDULUM_CHILD_KEYS, ...[...SECRET_INPUTS].map((n) => `PENDULUM_${n.toUpperCase()}`)]) assert.ok(!WORKFLOW_SETTINGS.has(k), `${k} is no workflow setting`);
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
    writeFileSync(join(dev, ".github", "workflows", "pendulum.yml"), `name: Pendulum\nenv:\n${Object.entries(env).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\njobs: {}\n`);
  };
  git(dev, "checkout", "-q", "-b", "trunk");
  writeFileSync(join(dev, "README"), "x\n");
  git(dev, "add", "README");
  git(dev, "commit", "-q", "-m", "first");
  git(dev, "push", "-q", "origin", "trunk");
  assert.deepEqual(committedWorkflowEnv(dev), { wf: {}, pins: [], branch: "trunk", error: "origin/trunk has no .github/workflows/pendulum.yml" }, "none on the default branch: none used");
  flow({ PENDULUM_MODEL: "m1", PENDULUM_LOCAL_DOMAINS: "pypi.org" });
  git(dev, "add", ".github");
  git(dev, "commit", "-q", "-m", "workflow");
  git(dev, "push", "-q", "origin", "trunk");
  // An unreviewed branch checked out here widens local mode in its working tree, and in a commit of its own.
  git(dev, "checkout", "-q", "-b", "contributor");
  flow({ PENDULUM_MODEL: "m1", PENDULUM_LOCAL_DOMAINS: "evil.example", PENDULUM_LOCAL_ENV: "AWS_SECRET_ACCESS_KEY" });
  git(dev, "commit", "-qam", "widen");
  const committed = committedWorkflowEnv(dev);
  const { text: committedText, ...settings } = committed;
  assert.deepEqual(settings, { wf: { PENDULUM_MODEL: "m1", PENDULUM_LOCAL_DOMAINS: "pypi.org" }, pins: [], branch: "trunk", error: null }, "the default branch's, whatever is checked out");
  assert.match(committedText, /PENDULUM_LOCAL_DOMAINS: pypi\.org/, "the default branch's file text, for the plugin version line");
  const working = workflowEnv(readFileSync(join(dev, ".github", "workflows", "pendulum.yml"), "utf8"));
  assert.deepEqual(workflowDriftLines(working, committed), [".github/workflows/pendulum.yml here differs from origin/trunk in PENDULUM_LOCAL_DOMAINS, PENDULUM_LOCAL_ENV: local mode uses origin/trunk's; commit the change to trunk to use it"]);
  const [warn] = workflowSourceChecks(working, committed);
  assert.equal(warn.status, "WARN");
  assert.match(warn.detail, /PENDULUM_LOCAL_DOMAINS, PENDULUM_LOCAL_ENV/);
  assert.deepEqual(workflowSourceChecks(committed.wf, committed), [], "the same settings: nothing to say");
  assert.match(workflowSourceChecks({}, { wf: {}, branch: "trunk", error: "origin/trunk has no .github/workflows/pendulum.yml" })[0].detail, /uses none/);
  // Doctor run outside a clone (--repo only): not checked, which says nothing about what serve uses.
  const none = committedWorkflowEnv("/nowhere", { git: () => ({ status: 128, stdout: "" }) });
  assert.equal(none.noClone, true);
  const [skipped] = workflowSourceChecks({}, none);
  assert.match(skipped.detail, /^not checked: doctor runs outside a clone/);
  assert.doesNotMatch(skipped.detail, /uses none/);
  // A change pushed to the default branch is what the next start reads (fetched first).
  git(dev, "checkout", "-q", "trunk");
  flow({ PENDULUM_MODEL: "m2" });
  git(dev, "commit", "-qam", "m2");
  git(dev, "push", "-q", "origin", "trunk");
  git(dev, "reset", "-q", "--hard", "HEAD~1");
  git(dev, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  assert.deepEqual(committedWorkflowEnv(dev).wf, { PENDULUM_MODEL: "m2" });
});

test("workflowEnv reads the env block the YAML parser reads, at any indent or style; expressions, mappings and lists are left out (#387)", () => {
  const wf = workflowEnv(
    [
      "name: Pendulum",
      "env:",
      "    PENDULUM_MODEL: claude-opus-5-5 # four-space indent",
      '    "PENDULUM_VALIDATION": |',
      "      npm test",
      "      npm run lint",
      "    PENDULUM_MAX_USD: 25",
      "    PENDULUM_SETUP:",
      "    PENDULUM_NOTIFY: ${{ vars.NOTIFY }}",
      "    PENDULUM_REVIEWERS: [a, b]",
      "    OTHER: x",
      "jobs:",
      "  work:",
      "    env:",
      "      PENDULUM_HARNESS: codex",
    ].join("\n"),
  );
  assert.deepEqual(wf, { PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_VALIDATION: "npm test\nnpm run lint\n", PENDULUM_MAX_USD: "25", PENDULUM_SETUP: "" }, "the top-level block only, every value as Actions sets it");
  assert.deepEqual(workflowEnv("env: { PENDULUM_MODEL: m, PENDULUM_HARNESS: 'codex' }\njobs: {}\n"), { PENDULUM_MODEL: "m", PENDULUM_HARNESS: "codex" }, "a flow mapping is the same block");
  assert.throws(() => workflowEnv("env:\n  PENDULUM_MODEL: a\n  PENDULUM_MODEL: b\n"), /pendulum\.yml does not parse \(unsupported YAML/, "a file the parser refuses is said, never read as no settings");
});

test("a default-branch workflow that does not parse is committedWorkflowEnv's error, said once, not an empty block (#387)", async () => {
  const { committedWorkflowEnv } = await import("../scripts/lib/local.mjs");
  const { workflowSourceChecks } = await import("../scripts/doctor.mjs");
  const text = "name: Pendulum\nenv:\n  PENDULUM_MODEL: [unclosed\njobs: {}\n";
  const git = (args) => {
    if (args[0] === "ls-remote") return { status: 0, stdout: "ref: refs/heads/trunk\tHEAD\n" };
    if (args[0] === "show") return { status: 0, stdout: text };
    return { status: 0, stdout: "" };
  };
  const read = committedWorkflowEnv("/repo", { git });
  assert.deepEqual(read.wf, {});
  assert.match(read.error, /^origin\/trunk's \.github\/workflows\/pendulum\.yml does not parse \(/);
  const [warn] = workflowSourceChecks({}, read);
  assert.equal(warn.status, "WARN");
  assert.match(warn.detail, /does not parse .*so serve, run and review do not start/);
  assert.match(warn.fix, /^fix the YAML on trunk/, "its own remedy, not merging a workflow that is there");
});

test("serve, run and review do not start on a default-branch workflow that does not parse; the working tree's copy is said, once (#387)", async () => {

  const { readWorkflowEnv } = await import("../scripts/lib/local.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "wf-broken-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env });
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  execFileSync("git", ["init", "-q", "--bare", "-b", "trunk", origin]);
  execFileSync("git", ["clone", "-q", origin, dev], { env, stdio: "ignore" });
  git(dev, "checkout", "-q", "-b", "trunk");
  mkdirSync(join(dev, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dev, ".github", "workflows", "pendulum.yml"), "env:\n  PENDULUM_MODEL: [unclosed\n");
  git(dev, "add", ".");
  git(dev, "commit", "-q", "-m", "broken");
  git(dev, "push", "-q", "origin", "trunk");
  const before = process.env.PENDULUM_LOCAL;
  try {
    assert.throws(() => new Local({ checkout: dev, repo: "o/r" }), /pendulum\.yml does not parse .*fix the file on trunk and start again/);
  } finally {
    if (before === undefined) delete process.env.PENDULUM_LOCAL;
    else process.env.PENDULUM_LOCAL = before;
  }
  const said = [];
  assert.deepEqual(readWorkflowEnv(dev, { warn: (l) => said.push(l) }), {});
  assert.match(said[0], /pendulum\.yml does not parse/, "the working tree's parse failure is said, not silent");
});
