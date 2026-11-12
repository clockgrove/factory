import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATEWAY_HOST, SHELL_SECRET_KEYS, codexRunner, codexSandboxCheck, harnessCommand } from "../scripts/lib/harness.mjs";
import { captureSession, dropSessions, holdSession, prepareFactoryHome, realRoots, runnerLaunch } from "../scripts/lib/claude-runner.mjs";
import { CODEX_RUNNER_HOME, CODEX_RUNNER_SESSION_ROOT, CONFINEMENT_PROBE, DECOY_LAUNCH, PROBE_MARKER, codexRunnerLayout, offListHost, presentPaths, resetCodexState } from "../scripts/lib/codex-runner.mjs";
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
  runner.present = new Set([`${CLONE}/.codex`, `${CLONE}/.git/commondir`, `${CLONE}/.git/info`]);
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
  assert.ok(!profile.includes('"/proc"'), "no /proc deny on a runner: the PID namespace hides every process outside the sandbox, and the probe checks it");
  assert.ok(profile.includes('".git/config"="read"') && profile.includes('".git/hooks"="read"'));
  assert.ok(profile.includes(`"${CLONE}/.codex"="read"`) && profile.includes(`"${CLONE}/.git/commondir"="read"`));
  assert.ok(profile.includes(`"${CLONE}/.git/info"="read"`), "no command renames .git/info to put an attributes file of its own there");
  assert.ok(!profile.includes(`"${CLONE}/.claude"`), "an absent path is left out: Codex's sandbox refuses one");
  assert.ok(!profile.includes(".config/gh"), "no credential store is hidden: the agent's read-only gh login is for its commands");
  assert.ok(profile.includes('"pypi.org"="allow"'));
  assert.equal(c["shell_environment_policy.exclude"], `[${[...SHELL_SECRET_KEYS, PROBE_MARKER].map((k) => JSON.stringify(k)).join(",")}]`, "every credential the harness could hold, and the probe's stand-in for one");
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
  await realRoots({ fix: [agent.tmp, ...layout.caches] }, agent.home);
  for (const c of layout.caches) assert.ok(existsSync(c), `${c} made: a writable root must exist`);
  assert.equal(layout.sessions, join(agent.home, CODEX_RUNNER_SESSION_ROOT));
  dropSessions();
  holdSession("t2", execFileSync("tar", ["-C", layout.sessions, "-cf", "-", "--", "2026/11/12/rollout-2026-11-12T00-00-00-t1.jsonl"]));
  await resetCodexState(layout);
  assert.ok(existsSync(join(day, "rollout-2026-11-12T00-00-00-t1.jsonl")), "a session restored from an earlier stage is put back too");
  dropSessions();
});

test("only the checkout's read-only paths that exist go into Codex's profile; the listing fails closed", async () => {
  const { root } = fakeAgent();
  const clone = join(root, "repo");
  execFileSync("git", ["init", "-q", clone]);
  mkdirSync(join(clone, ".codex"));
  await assert.rejects(presentPaths(clone), (e) => e instanceof GitRefusal && e.code === "git-clear" && /commondir/.test(e.message), "the pre-start clear makes .git/commondir: absent, no start");
  writeFileSync(join(clone, ".git", "commondir"), ".\n");
  mkdirSync(join(clone, ".git", "info"), { recursive: true });
  writeFileSync(join(clone, ".git", "info", "attributes"), "");
  const present = await presentPaths(clone);
  assert.ok(present.has(join(clone, ".codex")) && present.has(join(clone, ".git", "info")));
  assert.ok(!present.has(join(clone, ".claude")));
  await assert.rejects(presentPaths(clone, {}, { run: async () => ({ code: 1, stdout: "", stderr: "boom" }) }), (e) => e instanceof GitRefusal && e.code === "git-clear", "a failed listing never leaves the paths writable");
  symlinkSync(join(root, "nowhere"), join(clone, ".mcp.json"));
  await assert.rejects(presentPaths(clone), (e) => e instanceof GitRefusal && e.code === "sandbox" && e.path === ".mcp.json");
  assert.match(gitRefusalReason("sandbox", 1, { path: ".mcp.json" }), /`\.mcp\.json`, a link to nothing/);
});

test("a link planted at a writable root is replaced by a real directory; one higher up the path refuses the start", async () => {
  const { root, agent, layout } = fakeAgent();
  // The repository's install plants ~/.yarn -> ~: the sandbox would let commands write the whole home.
  symlinkSync(agent.home, join(agent.home, ".yarn"));
  await realRoots({ fix: [agent.tmp, ...layout.caches], check: [agent.home] }, agent.home);
  assert.ok(lstatSync(join(agent.home, ".yarn")).isDirectory() && !lstatSync(join(agent.home, ".yarn")).isSymbolicLink());
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  execFileSync("rm", ["-rf", join(agent.home, ".local")]);
  symlinkSync(elsewhere, join(agent.home, ".local"));
  await assert.rejects(realRoots({ fix: layout.caches }, agent.home), (e) => e instanceof GitRefusal && e.code === "roots" && e.path === "~/.local/share/pnpm");
  assert.match(gitRefusalReason("roots", 1, { path: "~/.local/share/pnpm" }), /`~\/\.local\/share\/pnpm`.*\(roots\).*not started/);
  assert.doesNotMatch(gitRefusalReason("roots", 1, {}), /git/, "the Block does not blame git");
  const clone = join(root, "repo-link");
  symlinkSync(elsewhere, clone);
  await assert.rejects(realRoots({ check: [clone] }, agent.home), (e) => e instanceof GitRefusal, "a checkout that is a link refuses too");
  // A home reached through a linked ancestor (/home -> /var/home) is no planted link.
  const real = join(root, "var-home");
  mkdirSync(join(real, "agent", "tmp"), { recursive: true });
  symlinkSync(real, join(root, "home"));
  const linked = join(root, "home", "agent");
  mkdirSync(join(linked, "repo"));
  await realRoots({ fix: [join(linked, "tmp"), join(linked, ".npm")], check: [join(linked, "repo")] }, linked);
  assert.ok(existsSync(join(real, "agent", ".npm")));
});

test("the confinement probe: the agent's home and .git/config refuse a write, the temp directory takes one", () => {
  const { root, agent } = fakeAgent();
  const run = (home, git, tmp, host = "") => {
    try {
      return { code: 0, out: execFileSync("/bin/sh", ["-c", CONFINEMENT_PROBE, "sh", home, git, tmp, host], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  // Unconfined here (no sandbox): the probe says which rule breaks first.
  assert.deepEqual(run(agent.home, "", agent.tmp), { code: 4, out: "the agent home is writable\n" });
  const ro = join(root, "ro");
  mkdirSync(ro, { mode: 0o555 });
  const git = join(agent.tmp, "config");
  writeFileSync(git, "x");
  assert.deepEqual(run(ro, git, agent.tmp), { code: 4, out: "the checkout's .git/config is writable\n" }, "a fixed text: no local path reaches a Blocked comment");
  assert.equal(readFileSync(git, "utf8"), "x", "the probe writes nothing into a writable file");
  assert.deepEqual(run(ro, "", ro), { code: 4, out: "the agent temp directory is not writable\n" });
  assert.equal(run(ro, "", agent.tmp).code, 0);
  // The marker check: here (no sandbox, no PID namespace) the parent's environment shows it.
  const marked = execFileSync("/bin/sh", ["-c", `${PROBE_MARKER}=m42 /bin/sh -c "$1" sh ${ro} "" ${agent.tmp} "" m42 || echo "exit $?"`, "sh", CONFINEMENT_PROBE], { encoding: "utf8" });
  assert.equal(marked, "the credential stand-in is readable in a process environment\nexit 4\n");
  assert.equal(offListHost(["github.com"]), "example.com");
  assert.equal(offListHost(["example.com"]), "", "an allow-list that names it: no network rule");
});

test("the decoy: a readable process outside the sandbox that holds the marker fails the probe; the launch checks the decoy is there", () => {
  const { root, agent } = fakeAgent();
  const ro = join(root, "ro2");
  mkdirSync(ro, { mode: 0o555 });
  // No sandbox here: the decoy, a plain sleep holding the marker, is readable, as it would be if a sandbox let it be.
  const out = execFileSync("/bin/sh", ["-c", `${PROBE_MARKER}=m77 sleep 30 & d=$!; sleep 0.2; env -u ${PROBE_MARKER} /bin/sh -c "$1" sh ${ro} "" ${agent.tmp} "" m77 "$d"; echo "exit $?"; kill "$d"`, "sh", CONFINEMENT_PROBE], { encoding: "utf8" });
  assert.equal(out, "the decoy outside the sandbox is readable\nexit 4\n");
  // DECOY_LAUNCH runs `codex "$@" <decoy pid>`: a stand-in codex reports what it got and whether the decoy holds the marker.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nfor d; do :; done\necho "args=$*"\ntr '\\0' '\\n' < /proc/$d/environ | grep -c '^${PROBE_MARKER}=m88$'\n`, { mode: 0o755 });
  const got = execFileSync("/bin/sh", ["-c", DECOY_LAUNCH, "sh", "sandbox", "x"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, [PROBE_MARKER]: "m88" } }).split("\n");
  assert.match(got[0], /^args=sandbox x \d+$/);
  assert.equal(got[1], "1", "the decoy holds the marker while codex runs");
});

test("the network rule fails without curl or node, rather than passing unchecked", () => {
  const { root, agent } = fakeAgent();
  const ro = join(root, "ro3");
  mkdirSync(ro, { mode: 0o555 });
  const bin = join(root, "bin3");
  mkdirSync(bin);
  for (const b of ["tr", "grep", "rm"]) symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${b}`], { encoding: "utf8" }).trim(), join(bin, b));
  const out = execFileSync("/bin/sh", ["-c", '/bin/sh -c "$1" sh "$2" "" "$3" example.com "" ""; echo "exit $?"', "sh", CONFINEMENT_PROBE, ro, agent.tmp], { encoding: "utf8", env: { PATH: bin } });
  assert.equal(out, "no curl or node to check the network rule\nexit 4\n");
});

test("Codex's sandbox probe runs before every start: where it cannot start or does not confine, the stage Blocks", async () => {
  const runner = { ...codexRunner({ harness: "codex", agent: AGENT, clone: CLONE }), present: new Set() };
  const calls = [];
  const reply = (r) => async (cmd, args) => {
    calls.push([cmd, ...args]);
    return r;
  };
  await assert.rejects(codexSandboxCheck(runner, { PATH: "/usr/bin" }, { run: reply({ code: 1, stdout: "", stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" }) }), (e) => e instanceof GitRefusal && e.code === "sandbox" && /RTM_NEWADDR/.test(e.message) && !e.rule);
  assert.equal(calls.length, 2, "a start that failed is tried once more before it Blocks");
  const call = calls[0];
  assert.equal(call[0], "/usr/bin/env");
  assert.ok(call.includes(DECOY_LAUNCH) && call.includes("sandbox") && call.includes(CONFINEMENT_PROBE) && call.includes(`HOME=${CODEX_RUNNER_HOME}`));
  assert.deepEqual(call.slice(-5, -1), [AGENT.home, `${CLONE}/.git/config`, AGENT.tmp, "example.com"]);
  assert.match(call.at(-1), /^[0-9a-f]{32}$/, "a fresh marker each time");
  assert.match(gitRefusalReason("sandbox", 1), /could not start.*no command ran unsandboxed.*doctor lines/);
  calls.length = 0;
  await assert.rejects(codexSandboxCheck(runner, {}, { run: reply({ code: 4, stdout: "the agent home is writable\n", stderr: "" }) }), (e) => e.code === "sandbox" && e.rule === "the agent home is writable");
  assert.equal(calls.length, 1, "a probe that ran and found a broken rule is never retried");
  await assert.rejects(codexSandboxCheck(runner, {}, { run: reply({ code: 4, stdout: "example.com, off the allow-list, is reachable\n", stderr: "" }) }), (e) => e.rule === "a host off the allow-list is reachable");
  let flaky = 0;
  await codexSandboxCheck(runner, {}, {
    run: async () => {
      flaky++;
      if (flaky === 1) throw new Error("spawn EAGAIN");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(flaky, 2, "a spawn failure is retried once");
  await assert.rejects(codexSandboxCheck(runner, {}, { run: reply({ code: 0, timedOut: true, stdout: "", stderr: "" }) }), (e) => e.code === "sandbox", "a timeout twice Blocks");
  await assert.rejects(codexSandboxCheck(runner, {}, { run: reply({ code: 4, stdout: "<b>planted</b>\n", stderr: "" }) }), (e) => e.rule === "an unknown rule", "only Factory's own rule texts reach the Blocked comment");
  assert.match(gitRefusalReason("sandbox", 1, { rule: "the agent home is writable" }), /does not confine here \(the agent home is writable\)/);
  let n = 0;
  const ok = async () => {
    n++;
    return { code: 0, stdout: "", stderr: "" };
  };
  await codexSandboxCheck(runner, {}, { run: ok });
  await codexSandboxCheck(runner, {}, { run: ok });
  assert.equal(n, 2, "probed at every start");
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
