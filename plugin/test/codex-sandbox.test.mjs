import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATEWAY_HOST, SHELL_SECRET_KEYS, codexRunner, codexSandboxCheck, dropSandboxCheck, harnessCommand } from "../scripts/lib/harness.mjs";
import { captureSession, dropSessions, holdSession, prepareFactoryHome, runnerLaunch } from "../scripts/lib/claude-runner.mjs";
import { CODEX_RUNNER_HOME, CODEX_RUNNER_SESSION_ROOT, codexRunnerLayout, presentPaths, resetCodexState } from "../scripts/lib/codex-runner.mjs";
import { GitRefusal, LOCAL_DOMAINS, codexLocalConfig, gitRefusalReason } from "../scripts/lib/local.mjs";
import { BACKENDS } from "../scripts/lib/backend.mjs";
import { claudeSandboxChecks } from "../scripts/doctor.mjs";

const AGENT = { user: "factory-agent", uid: 1002, home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set() };
const CLONE = "/home/factory-agent/repo";
/** The `-c` values of a Codex command line, by key. */
const configOf = (args) => Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "-c" ? [[a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]] : [])));

/** A throwaway agent home and temp directory, for the start-up path as this process's user. */
function fakeAgent() {
  const root = mkdtempSync(join(tmpdir(), "cx-"));
  const agent = { home: join(root, "agent"), tmp: join(root, "agent", "tmp") };
  mkdirSync(agent.tmp, { recursive: true });
  return { root, agent, layout: codexRunnerLayout(agent, join(root, "codex-home")) };
}

test("Codex on a runner: its own sandbox with local mode's profile fitted to the agent, never the bypass", () => {
  const runner = codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env: { FACTORY_INPUT_ALLOWED_DOMAINS: "pypi.org" } });
  assert.deepEqual(runner.domains, [...LOCAL_DOMAINS, "pypi.org"]);
  assert.equal(runner.home, CODEX_RUNNER_HOME);
  runner.present = new Set([`${CLONE}/.codex`, `${CLONE}/.git/commondir`]);
  const { args, env } = harnessCommand({ harness: "codex", model: "m", prompt: "p", runner });
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(args.includes("--ignore-user-config"));
  const c = configOf(args);
  assert.equal(c.default_permissions, '"factory"');
  assert.equal(c.approval_policy, '"never"');
  assert.equal(c["features.network_proxy"], "true", "the domain list holds only with Codex's proxy");
  const profile = c["permissions.factory"];
  for (const root of [CLONE, AGENT.tmp, ...["/.npm", "/.cache", "/.local/share/pnpm", "/.bun", "/.yarn"].map((p) => AGENT.home + p)]) assert.ok(profile.includes(`"${root}"=true`), `${root}: a writable root`);
  assert.ok(!profile.includes(`"${AGENT.home}"=true`), "never the agent's home: its start-up files and Codex's own state stay unwritable");
  assert.ok(profile.includes('"/proc"="deny"'));
  assert.ok(profile.includes('".git/config"="read"') && profile.includes('".git/hooks"="read"'));
  assert.ok(profile.includes(`"${CLONE}/.codex"="read"`) && profile.includes(`"${CLONE}/.git/commondir"="read"`));
  assert.ok(!profile.includes(`"${CLONE}/.claude"`), "an absent path is left out: Codex's sandbox refuses one");
  assert.ok(!profile.includes(".config/gh"), "no credential store is hidden: the agent's read-only gh login is for its commands");
  assert.ok(profile.includes('"pypi.org"="allow"'));
  assert.equal(c["shell_environment_policy.exclude"], `[${SHELL_SECRET_KEYS.map((k) => JSON.stringify(k)).join(",")}]`, "every credential the harness could hold");
  assert.equal(c["shell_environment_policy.set"], `{HOME=${JSON.stringify(AGENT.home)},TMPDIR=${JSON.stringify(AGENT.tmp)}}`, "its commands get the agent's HOME and TMPDIR back");
  assert.equal(c.projects, `{${JSON.stringify(CLONE)}={trust_level="untrusted"}}`);
  assert.equal(env.CODEX_HOME, `${AGENT.home}/.factory-codex/home`);
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsmonitor", "Codex's own git runs no fsmonitor from the checkout");
  const [cmd, launch] = runnerLaunch(runner, "codex", ["exec"], "/opt/tool/bin:/home/factory-agent/.local/bin:/usr/bin");
  assert.equal(cmd, "/usr/bin/env");
  assert.deepEqual(launch, [`HOME=${CODEX_RUNNER_HOME}`, "TMPDIR=/tmp", "PATH=/opt/tool/bin:/usr/bin", "codex", "exec"], "Factory's HOME, a private /tmp, nothing of the agent's home on its PATH");
  assert.equal(codexRunner({ harness: "claude", agent: AGENT, clone: CLONE }), null);
  assert.equal(codexRunner({ harness: "codex", agent: null, clone: CLONE }), null, "no agent uid (a developer's /factory:run): no runner sandbox");
  assert.equal(codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env: { FACTORY_LOCAL: "1" } }), null, "local mode has its own");
  assert.ok(harnessCommand({ harness: "codex", prompt: "p" }).args.includes("--dangerously-bypass-approvals-and-sandbox"), "a developer's own session keeps the CLI's own behaviour");
});

test("Codex through the AI Gateway on a runner: the gateway's host joins its commands' hosts", () => {
  const gw = codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env: { FACTORY_CODEX_GATEWAY_KEY: "k" } });
  assert.equal(GATEWAY_HOST, "ai-gateway.vercel.sh");
  assert.deepEqual(gw.domains, [...LOCAL_DOMAINS, GATEWAY_HOST]);
  assert.ok(!codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env: { CODEX_API_KEY: "k" } }).domains.includes(GATEWAY_HOST));
  const { args } = harnessCommand({ harness: "codex", model: "gpt-x", prompt: "p", runner: { ...gw, present: new Set() }, gateway: { session: null } });
  assert.match(configOf(args)["permissions.factory"], /"ai-gateway\.vercel\.sh"="allow"/);
  assert.equal(configOf(args).model_provider, '"vercel"');
});

test("local mode's Codex profile is unchanged: credential stores denied under the home, present paths read-only", () => {
  const c = configOf(codexLocalConfig({ clone: "/nope-clone", home: "/h", addDirs: ["/d"] }));
  assert.ok(c["permissions.factory"].includes('"/h/.ssh"="deny"') && c["permissions.factory"].includes('"/h/.codex/auth.json*"="deny"'));
  assert.ok(!c["permissions.factory"].includes("/nope-clone/.codex"), "absent here");
  assert.equal(c["shell_environment_policy.set"], undefined);
});

test("a ~/.bashrc planted in the agent's home never runs at the next Codex start; Codex's state is made afresh", async () => {
  dropSessions();
  const { root, agent, layout } = fakeAgent();
  const marker = join(root, "ran");
  for (const rc of [".bashrc", ".profile", ".bash_profile"]) writeFileSync(join(agent.home, rc), `echo ${rc} >> ${marker}\n`);
  await prepareFactoryHome(layout.home, "Codex", { sudo: false });
  // Codex's shell snapshot is a login shell, started with its own HOME: Factory's, empty.
  const [, args] = runnerLaunch(layout, "bash", ["-lc", 'printf "%s" "$HOME"']);
  assert.equal(execFileSync("/usr/bin/env", args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: agent.home } }), layout.home);
  assert.ok(!existsSync(marker), "no start-up file of the agent's ran");
  await resetCodexState(layout);
  const day = join(layout.sessions, "2026", "11", "12");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-11-12T00-00-00-t1.jsonl"), '{"turn":1}\n');
  assert.deepEqual(await captureSession(layout, "t1"), ["2026/11/12/rollout-2026-11-12T00-00-00-t1.jsonl"]);
  // Between two starts the repository's code plants a config with a notify hook and rewrites the session.
  writeFileSync(join(layout.codexHome, "config.toml"), 'notify = ["sh", "-c", "env > /tmp/leak"]\n');
  writeFileSync(join(day, "rollout-2026-11-12T00-00-00-t1.jsonl"), '{"planted":true}\n');
  await resetCodexState(layout);
  assert.ok(!existsSync(join(layout.codexHome, "config.toml")));
  assert.equal(readFileSync(join(day, "rollout-2026-11-12T00-00-00-t1.jsonl"), "utf8"), '{"turn":1}\n', "Factory's captured copy, not the planted one");
  for (const c of layout.caches) assert.ok(existsSync(c), `${c} made: a writable root must exist`);
  assert.equal(layout.sessions, join(agent.home, CODEX_RUNNER_SESSION_ROOT));
  dropSessions();
  holdSession("t2", execFileSync("tar", ["-C", layout.sessions, "-cf", "-", "--", "2026/11/12/rollout-2026-11-12T00-00-00-t1.jsonl"]));
  await resetCodexState(layout);
  assert.ok(existsSync(join(day, "rollout-2026-11-12T00-00-00-t1.jsonl")), "a session restored from an earlier stage is put back too");
  dropSessions();
});

test("only the checkout's read-only paths that exist go into Codex's profile", async () => {
  const { root } = fakeAgent();
  const clone = join(root, "repo");
  execFileSync("git", ["init", "-q", clone]);
  mkdirSync(join(clone, ".codex"));
  const present = await presentPaths(clone);
  assert.ok(present.has(join(clone, ".codex")));
  assert.ok(!present.has(join(clone, ".claude")) && !present.has(join(clone, ".git", "commondir")));
});

test("Codex's sandbox is started once before the first run: where it cannot start, the stage Blocks before any command runs", async () => {
  dropSandboxCheck();
  const runner = { ...codexRunner({ harness: "codex", agent: AGENT, clone: CLONE }), present: new Set() };
  const calls = [];
  const fail = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 1, stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" };
  };
  await assert.rejects(codexSandboxCheck(runner, { PATH: "/usr/bin" }, { run: fail }), (e) => e instanceof GitRefusal && e.code === "sandbox" && /RTM_NEWADDR/.test(e.message));
  const call = calls[0];
  assert.equal(call[0], "/usr/bin/env");
  assert.ok(call.includes("sandbox") && call.at(-1) === "/bin/true" && call.includes(`HOME=${CODEX_RUNNER_HOME}`));
  assert.match(gitRefusalReason("sandbox", 1), /Codex's sandbox could not start.*no command ran unsandboxed/);
  let n = 0;
  const ok = async () => {
    n++;
    return { code: 0, stderr: "" };
  };
  await codexSandboxCheck(runner, {}, { run: ok });
  await codexSandboxCheck(runner, {}, { run: ok });
  assert.equal(n, 1, "checked once per process");
  dropSandboxCheck();
});

test("Codex's task card on a runner: the sandbox notes, and setup's services out of its commands' reach", () => {
  const notes = BACKENDS.actions.sandbox.cardNotes({}, "codex", [5432]);
  assert.match(notes, /\$TMPDIR/);
  assert.match(notes, /deniedHosts/);
  assert.match(notes, /outside your sandbox: your commands cannot reach it/);
  assert.doesNotMatch(notes, /localhost:5432/, "no relay for Codex: no port is offered");
  assert.equal(BACKENDS.actions.sandbox.cardNotes({}, "copilot", []), "");
});

test("doctor: Codex in a job needs bwrap, AppArmor on a self-hosted runner, and its sandbox starting", async () => {
  const names = (rows) => rows.map((r) => `${r.name}:${r.status}`);
  const codex = { harness: "codex" };
  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: codex, env: hosted, local: false, has: async () => false, start: async () => ({ ok: true }) })), ["codex sandbox: bwrap:FAIL"], "no start without bwrap");
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: codex, env: hosted, local: false, has: async () => true, start: async () => ({ ok: true }) })), ["codex sandbox: bwrap:PASS", "codex sandbox: start:PASS"]);
  const failed = await claudeSandboxChecks({ inputs: codex, env: hosted, local: false, has: async () => true, start: async () => ({ ok: false, reason: "bwrap: setting up uid map: Permission denied" }) });
  assert.deepEqual(names(failed), ["codex sandbox: bwrap:PASS", "codex sandbox: start:FAIL"]);
  assert.match(failed.at(-1).detail, /uid map/);
  const self = await claudeSandboxChecks({ inputs: codex, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, local: false, has: async () => true, read: () => "1\n", profiles: async () => "", start: async () => ({ ok: false, reason: "x" }) });
  assert.deepEqual(names(self), ["codex sandbox: bwrap:PASS", "codex sandbox: apparmor:FAIL", "codex sandbox: start:FAIL"]);
  assert.match(self.at(-1).fix, /factory-bwrap/);
  assert.deepEqual(await claudeSandboxChecks({ inputs: codex, env: hosted, local: true, has: async () => false }), [], "local mode checks its own sandboxes");
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: codex, env: hosted, local: false, has: async () => true, start: async () => null })), ["codex sandbox: bwrap:PASS"], "before the agent exists, no start check");
});
