import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELL_SECRET_KEYS, claudeRunner, harnessCommand } from "../scripts/lib/harness.mjs";
import { CLAUDE_SECRET_ENV, LOCAL_DOMAINS, claudeLocalSettings, claudeRunnerSettings, runnerDomains } from "../scripts/lib/local.mjs";
import { asAgent, setAgent } from "../scripts/lib/proc.mjs";

const AGENT = { user: "factory-agent", home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set() };
const denied = (settings) => settings.sandbox.credentials.envVars.filter((v) => v.mode === "deny").map((v) => v.name);

test("Claude's sandbox unsets the model credentials in every command's environment, in local mode too", () => {
  assert.deepEqual(denied(claudeLocalSettings({ clone: "/c", home: "/h" })), CLAUDE_SECRET_ENV);
  assert.deepEqual(denied(claudeLocalSettings({ clone: "/c", home: "/h", secretEnv: SHELL_SECRET_KEYS })), SHELL_SECRET_KEYS);
});

test("a runner's Claude settings: local mode's bar fitted to the agent's home", () => {
  const s = claudeRunnerSettings({ clone: "/home/factory-agent/repo", home: "/home/factory-agent", domains: ["github.com"] });
  const fs = s.sandbox.filesystem;
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.disableAllHooks, true);
  assert.deepEqual(s.sandbox.network.allowedDomains, ["github.com"]);
  assert.deepEqual(fs.allowWrite, ["/home/factory-agent"], "the checkout, the temp directory and the caches");
  assert.deepEqual(fs.denyRead, ["/proc"], "the agent's read-only GitHub token is for its commands");
  for (const p of ["repo/.git/hooks", "repo/.git/config", "repo/.claude", "repo/.mcp.json", ".claude", ".claude.json", ".gitconfig", ".config/git", ".factory"]) {
    assert.ok(fs.denyWrite.includes(`/home/factory-agent/${p}`), `${p}: no command writes it`);
    assert.ok(s.permissions.deny.includes(`Edit(//home/factory-agent/${p})`), `${p}: no edit either`);
  }
  assert.deepEqual(denied(s), CLAUDE_SECRET_ENV);
  assert.equal(s.permissions.blockWritesOutsideWorkingDirectories, true);
});

test("allowed_domains: added to LOCAL_DOMAINS, host names and *. entries only", () => {
  assert.deepEqual(runnerDomains(""), LOCAL_DOMAINS);
  assert.deepEqual(runnerDomains("pypi.org, *.pythonhosted.org\nFiles.Example.com bad_host 1.2.3.4 http://x.org github.com").slice(LOCAL_DOMAINS.length), ["pypi.org", "*.pythonhosted.org", "files.example.com"]);
});

test("Claude on a runner: its own sandbox, acceptEdits, no settings, hooks or MCP from the checkout; Codex and Copilot unchanged", () => {
  const runner = claudeRunner({ harness: "claude", agent: AGENT, clone: "/home/factory-agent/repo", env: { FACTORY_INPUT_ALLOWED_DOMAINS: "pypi.org" } });
  assert.deepEqual(runner.domains, [...LOCAL_DOMAINS, "pypi.org"]);
  assert.equal(runner.claudeDir, "/home/factory-agent/.factory/claude");
  const { args, env } = harnessCommand({ harness: "claude", model: "m", prompt: "p", runner });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(flag("--permission-mode"), "acceptEdits");
  assert.equal(flag("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(flag("--plugin-dir"), "/home/factory-agent/.factory/claude/plugin");
  assert.deepEqual(args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : [])), ["/home/factory-agent/repo", "/home/factory-agent/tmp"]);
  const settings = JSON.parse(flag("--settings"));
  assert.deepEqual(denied(settings), SHELL_SECRET_KEYS, "every credential the harness could hold");
  assert.ok(settings.sandbox.network.allowedDomains.includes("pypi.org"));
  assert.equal(env.CLAUDE_CODE_TMPDIR, "/home/factory-agent/tmp");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsmonitor", "Claude Code's own git runs no fsmonitor from the checkout");
  assert.equal(claudeRunner({ harness: "codex", agent: AGENT, clone: "/c" }), null);
  assert.equal(claudeRunner({ harness: "claude", agent: null, clone: "/c" }), null, "no agent uid, no runner sandbox");
  assert.equal(claudeRunner({ harness: "claude", agent: AGENT, clone: "/c", env: { FACTORY_LOCAL: "1" } }), null, "local mode has its own");
  assert.ok(harnessCommand({ harness: "codex", prompt: "p", runner }).args.includes("--dangerously-bypass-approvals-and-sandbox"));
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
