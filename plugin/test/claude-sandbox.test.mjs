import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SHELL_SECRET_KEYS, claudeRunner, harnessCommand } from "../scripts/lib/harness.mjs";
import { CLAUDE_HOME, captureSession, dropGitPins, dropSessions, envFileText, holdSession, pinRunnerGit, prepareClaudeHome, resetClaudeState, restoreRunnerGit, runnerLaunch, runnerLayout } from "../scripts/lib/claude-runner.mjs";
import { CLAUDE_SECRET_ENV, GitRefusal, LOCAL_DOMAINS, claudeLocalSettings, claudeRunnerSettings, droppedDomains, runnerDomains } from "../scripts/lib/local.mjs";
import { asAgent, setAgent } from "../scripts/lib/proc.mjs";
import { BACKENDS } from "../scripts/lib/backend.mjs";
import { claudeSandboxChecks } from "../scripts/doctor.mjs";

const AGENT = { user: "factory-agent", home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set() };
const denied = (settings) => settings.sandbox.credentials.envVars.filter((v) => v.mode === "deny").map((v) => v.name);

/** A throwaway agent home, temp directory and Factory-owned Claude home, for the runner's start-up path. */
function fakeRunner() {
  const root = mkdtempSync(join(tmpdir(), "cr-"));
  const agent = { home: join(root, "agent"), tmp: join(root, "agent", "tmp") };
  mkdirSync(agent.tmp, { recursive: true });
  return { root, agent, layout: runnerLayout(agent, join(root, "claude-home")) };
}

test("Claude's sandbox unsets the model credentials in every command's environment, in local mode too", () => {
  assert.deepEqual(denied(claudeLocalSettings({ clone: "/c", home: "/h" })), CLAUDE_SECRET_ENV);
  assert.deepEqual(denied(claudeLocalSettings({ clone: "/c", home: "/h", secretEnv: SHELL_SECRET_KEYS })), SHELL_SECRET_KEYS);
});

test("a runner's Claude settings: writes only in the checkout, the temp directories and the caches, never elsewhere in the agent's home", () => {
  const layout = runnerLayout(AGENT);
  const writable = ["/home/factory-agent/repo", layout.agentTmp, layout.cmdTmp, ...layout.caches];
  const s = claudeRunnerSettings({ clone: "/home/factory-agent/repo", writable, domains: ["github.com"] });
  const fs = s.sandbox.filesystem;
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.disableAllHooks, true);
  assert.deepEqual(s.sandbox.network.allowedDomains, ["github.com"]);
  assert.deepEqual(fs.allowWrite, writable);
  assert.ok(!fs.allowWrite.includes("/home/factory-agent"), "not the agent's home: its shell start-up files and git config stay unwritable");
  assert.ok(!fs.allowWrite.some((p) => p.startsWith(layout.config) || p.startsWith(layout.ownTmp)), "nor Claude Code's own state");
  assert.deepEqual(fs.denyRead, ["/proc"], "the agent's read-only GitHub token is for its commands");
  for (const p of ["repo/.git/hooks", "repo/.git/config", "repo/.claude", "repo/.mcp.json"]) {
    assert.ok(fs.denyWrite.includes(`/home/factory-agent/${p}`), `${p}: no command writes it`);
    assert.ok(s.permissions.deny.includes(`Edit(//home/factory-agent/${p})`), `${p}: no edit either`);
  }
  assert.deepEqual(denied(s), CLAUDE_SECRET_ENV);
  assert.equal(s.permissions.blockWritesOutsideWorkingDirectories, true);
});

test("allowed_domains: added to LOCAL_DOMAINS, host names and *. entries only; doctor names each one dropped", async () => {
  assert.deepEqual(runnerDomains(""), LOCAL_DOMAINS);
  const value = "pypi.org, *.pythonhosted.org\nFiles.Example.com bad_host 1.2.3.4 http://x.org github.com";
  assert.deepEqual(runnerDomains(value).slice(LOCAL_DOMAINS.length), ["pypi.org", "*.pythonhosted.org", "files.example.com"]);
  assert.deepEqual(droppedDomains(value), ["bad_host", "1.2.3.4", "http://x.org"]);
  const rows = await claudeSandboxChecks({ inputs: { harness: "claude" }, env: { FACTORY_INPUT_ALLOWED_DOMAINS: value }, local: false });
  assert.deepEqual(rows.map((r) => `${r.name}:${r.status}`), ["allowed_domains:WARN"]);
  assert.match(rows[0].detail, /"bad_host", "1\.2\.3\.4", "http:\/\/x\.org"/);
});

test("Claude on a runner: its own sandbox, acceptEdits, Factory's HOME for it; Codex and Copilot unchanged", () => {
  const runner = claudeRunner({ harness: "claude", agent: AGENT, clone: "/home/factory-agent/repo", env: { FACTORY_INPUT_ALLOWED_DOMAINS: "pypi.org" } });
  assert.deepEqual(runner.domains, [...LOCAL_DOMAINS, "pypi.org"]);
  assert.equal(runner.home, CLAUDE_HOME);
  const { args, env } = harnessCommand({ harness: "claude", model: "m", prompt: "p", runner });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(flag("--permission-mode"), "acceptEdits");
  assert.equal(flag("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(flag("--plugin-dir"), `${CLAUDE_HOME}/claude/plugin`, "Factory's skills from its own directory");
  assert.deepEqual(args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : [])), ["/home/factory-agent/repo", "/home/factory-agent/tmp"]);
  const settings = JSON.parse(flag("--settings"));
  assert.deepEqual(denied(settings), SHELL_SECRET_KEYS, "every credential the harness could hold");
  assert.equal(settings.sandbox.network.allowedDomains.at(-1), "pypi.org");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/factory-agent/.factory-claude/config");
  assert.equal(env.CLAUDE_CODE_TMPDIR, "/home/factory-agent/.factory-claude/cmd");
  assert.equal(env.CLAUDE_ENV_FILE, `${CLAUDE_HOME}/env.sh`);
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsmonitor", "Claude Code's own git runs no fsmonitor from the checkout");
  const [cmd, launch] = runnerLaunch(runner, "claude", ["-p"], "/opt/tool/bin:/home/factory-agent/.local/bin:/usr/bin");
  assert.equal(cmd, "/usr/bin/env");
  assert.deepEqual(launch, [`HOME=${CLAUDE_HOME}`, "TMPDIR=/home/factory-agent/.factory-claude/tmp", "PATH=/opt/tool/bin:/usr/bin", "claude", "-p"], "nothing of the agent's home on its PATH");
  assert.equal(claudeRunner({ harness: "codex", agent: AGENT, clone: "/c" }), null);
  assert.equal(claudeRunner({ harness: "claude", agent: null, clone: "/c" }), null, "no agent uid, no runner sandbox");
  assert.equal(claudeRunner({ harness: "claude", agent: AGENT, clone: "/c", env: { FACTORY_LOCAL: "1" } }), null, "local mode has its own");
  assert.ok(harnessCommand({ harness: "codex", prompt: "p", runner }).args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("a ~/.bashrc a validation command planted in the agent's home never runs at the next Claude start", async () => {
  const { root, agent, layout } = fakeRunner();
  const marker = join(root, "ran");
  for (const rc of [".bashrc", ".profile", ".bash_profile", ".bash_login"]) writeFileSync(join(agent.home, rc), `echo ${rc} >> ${marker}\n`);
  // The control: Claude Code's shell snapshot (`bash -c -l`) with the agent's home sources them.
  execFileSync("bash", ["-lc", "true"], { env: { PATH: process.env.PATH, HOME: agent.home } });
  assert.ok(existsSync(marker), "the planted files run when HOME is the agent's");
  writeFileSync(marker, "");
  await prepareClaudeHome(layout, { sudo: false });
  // Claude Code's start on a runner: the unit gives the agent's HOME; Factory's launch replaces it before Claude starts.
  const [cmd, args] = runnerLaunch(layout, "bash", ["-lc", 'printf "%s" "$HOME"']);
  assert.equal(cmd, "/usr/bin/env");
  assert.equal(execFileSync("/usr/bin/env", args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: agent.home } }), layout.home);
  assert.equal(readFileSync(marker, "utf8"), "", "no start-up file of the agent's ran");
  // Its commands get the agent's home back, inside the sandbox (CLAUDE_ENV_FILE).
  assert.equal(readFileSync(layout.envFile, "utf8"), envFileText(layout));
  assert.equal(execFileSync("bash", ["-c", '. "$1"; printf "%s %s" "$HOME" "$TMPDIR"', "sh", layout.envFile], { encoding: "utf8" }), `${agent.home} ${agent.tmp}`);
});

test("Claude's state is made afresh before every start: what was planted is gone, the sessions Factory holds are back", async () => {
  dropSessions();
  const { layout } = fakeRunner();
  await resetClaudeState(layout);
  const projects = join(layout.config, "projects");
  mkdirSync(join(projects, "-repo"), { recursive: true });
  writeFileSync(join(projects, "-repo", "s1.jsonl"), '{"turn":1}\n');
  assert.deepEqual(await captureSession(layout, "s1"), ["-repo/s1.jsonl"]);
  // Between two starts the agent's code plants settings and rewrites the session.
  writeFileSync(join(layout.config, "settings.json"), '{"hooks":{}}');
  writeFileSync(join(layout.config, ".claude.json"), '{"mcpServers":{"x":{"command":"evil"}}}');
  writeFileSync(join(projects, "-repo", "s1.jsonl"), '{"planted":true}\n');
  writeFileSync(join(layout.ownTmp, "planted"), "x");
  await resetClaudeState(layout);
  assert.ok(!existsSync(join(layout.config, "settings.json")) && !existsSync(join(layout.config, ".claude.json")) && !existsSync(join(layout.ownTmp, "planted")));
  assert.equal(readFileSync(join(projects, "-repo", "s1.jsonl"), "utf8"), '{"turn":1}\n', "Factory's captured copy, not the planted one");
  for (const c of layout.caches) assert.ok(existsSync(c), `${c} made for the sandbox to write`);
  dropSessions();
  holdSession("s2", execFileSync("tar", ["-C", projects, "-cf", "-", "--", "-repo/s1.jsonl"]));
  await resetClaudeState(layout);
  assert.ok(existsSync(join(projects, "-repo", "s1.jsonl")), "a session restored from an earlier stage is put back too");
  dropSessions();
});

test("the checkout's git state is put back before every Claude start; a replaced .git refuses it", async () => {
  dropGitPins();
  const { root } = fakeRunner();
  const clone = join(root, "repo");
  execFileSync("git", ["init", "-q", clone]);
  writeFileSync(join(clone, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const config = readFileSync(join(clone, ".git", "config"), "utf8");
  await assert.rejects(restoreRunnerGit(clone), (e) => e instanceof GitRefusal && e.code === "git-state", "no pin, no start");
  await pinRunnerGit(clone);
  // A validation command plants a filter, a hook and a commondir.
  writeFileSync(join(clone, ".git", "config"), `${config}[filter "x"]\n\tclean = sh -c 'touch ${root}/filter-ran'\n`);
  writeFileSync(join(clone, ".git", "hooks", "post-index-change"), "#!/bin/sh\ntouch ran\n", { mode: 0o755 });
  writeFileSync(join(clone, ".git", "commondir"), "/elsewhere\n");
  await restoreRunnerGit(clone);
  assert.equal(readFileSync(join(clone, ".git", "config"), "utf8"), config);
  assert.ok(!existsSync(join(clone, ".git", "hooks", "post-index-change")) && existsSync(join(clone, ".git", "hooks", "pre-commit")));
  assert.ok(!existsSync(join(clone, ".git", "commondir")));
  renameSync(join(clone, ".git"), join(clone, ".git-old"));
  execFileSync("git", ["init", "-q", clone]);
  await assert.rejects(restoreRunnerGit(clone), (e) => e instanceof GitRefusal && e.code === "git-identity");
  dropGitPins();
});

test("allowed_domains is the fix only for Claude's sandbox on a runner", () => {
  assert.match(BACKENDS.actions.sandbox.deniedFix(["cdn.example.org"], {}, "claude"), /`allowed_domains` input/);
  assert.equal(BACKENDS.actions.sandbox.deniedFix(["cdn.example.org"], {}, "codex"), null, "Codex skips its sandbox here: its own fix stands");
  assert.equal(BACKENDS.actions.sandbox.deniedFix(["cdn.example.org"], {}, "copilot"), null);
});

test("doctor: in a job, bwrap, socat and rg; on a self-hosted runner, AppArmor with the one-time admin step", async () => {
  const names = (rows) => rows.map((r) => `${r.name}:${r.status}`);
  const job = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" };
  const has = async (b) => b !== "rg";
  const restricted = () => "1\n";
  const rows = await claudeSandboxChecks({ inputs: { harness: "claude" }, env: job, local: false, has, read: restricted, profiles: async () => "unprivileged_userns (enforce)\n" });
  assert.deepEqual(names(rows), ["claude sandbox: bwrap:PASS", "claude sandbox: socat:PASS", "claude sandbox: rg:FAIL", "claude sandbox: apparmor:FAIL"]);
  assert.match(rows.at(-1).fix, /factory-bwrap.*apparmor_parser -r/);
  const fixed = await claudeSandboxChecks({ inputs: { harness: "claude" }, env: job, local: false, has: async () => true, read: restricted, profiles: async () => "factory-bwrap (unconfined)\n" });
  assert.equal(fixed.at(-1).status, "PASS");
  const ubuntu26 = await claudeSandboxChecks({ inputs: { harness: "claude" }, env: job, local: false, has: async () => true, read: restricted, profiles: async () => "factory-bwrap (unconfined)\nunpriv_bwrap (enforce)\n" });
  assert.equal(ubuntu26.at(-1).status, "FAIL", "bwrap-userns-restrict still loaded");
  const hosted = await claudeSandboxChecks({ inputs: { harness: "claude" }, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }, local: false, has: async () => true, read: restricted, profiles: async () => "" });
  assert.deepEqual(names(hosted), ["claude sandbox: bwrap:PASS", "claude sandbox: socat:PASS", "claude sandbox: rg:PASS"], "the Action loads the profile on GitHub's hosted runners");
});

test("the agent's unit keeps ProtectKernelTunables, but for a harness with a sandbox of its own (bwrap mounts a fresh /proc)", () => {
  setAgent(AGENT);
  try {
    assert.ok(asAgent("true", [], {}, [], AGENT.home)[1].includes("--property=ProtectKernelTunables=yes"));
    const nested = asAgent("claude", [], {}, [], AGENT.home, { nested: true })[1];
    assert.ok(!nested.includes("--property=ProtectKernelTunables=yes"));
    for (const p of ["--property=NoNewPrivileges=yes", "--property=ProtectSystem=strict", "--property=ProtectKernelModules=yes"]) assert.ok(nested.includes(p), p);
  } finally {
    setAgent(null);
  }
});
