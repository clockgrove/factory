import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COPILOT_PROBE_SCRIPT, SHELL_SECRET_KEYS, copilotLocalCheck, copilotRunner, copilotSandboxCheck, harnessCommand } from "../scripts/lib/harness.mjs";
import { dropSessions, holdSession } from "../scripts/lib/claude-runner.mjs";
import { CONFINEMENT_PROBE, PROBE_MARKER, PROBE_PASS } from "../scripts/lib/codex-runner.mjs";
import { COPILOT_DECOY_LAUNCH, COPILOT_RUNNER_HOME, COPILOT_RUNNER_SESSION_ROOT, COPILOT_TMP, COPILOT_TMP_LAUNCH, PROBE_PERSIST, PROBE_RESULT, bwrapShim, copilotLaunch, copilotRunnerLayout, probeDriver, probeEnv, probeModel, resetCopilotState } from "../scripts/lib/copilot-runner.mjs";
import { GitRefusal, LOCAL_DOMAINS, copilotLocalSettings, copilotPrivateTmp, gitRefusalReason } from "../scripts/lib/local.mjs";
import { claudeSandboxChecks } from "../scripts/doctor.mjs";

const AGENT = { user: "factory-agent", uid: 1002, home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set() };
const CLONE = "/home/factory-agent/repo";

/** A throwaway agent home, temp directory and checkout, for the start-up path as this process's user. */
function fakeRunner() {
  const root = mkdtempSync(join(tmpdir(), "cp-"));
  const agent = { home: join(root, "agent"), tmp: join(root, "agent", "tmp") };
  const clone = join(agent.home, "repo");
  mkdirSync(agent.tmp, { recursive: true });
  mkdirSync(join(clone, ".git"), { recursive: true });
  return { root, agent, runner: { clone, ...copilotRunnerLayout(agent, join(root, "copilot-home")), domains: LOCAL_DOMAINS } };
}

test("Copilot on a runner: its own sandbox under Factory's policy, never --allow-all", () => {
  const runner = copilotRunner({ harness: "copilot", agent: AGENT, clone: CLONE, env: { FACTORY_INPUT_ALLOWED_DOMAINS: "pypi.org" } });
  assert.deepEqual(runner.domains, [...LOCAL_DOMAINS, "pypi.org"]);
  assert.equal(runner.home, COPILOT_RUNNER_HOME);
  const { args, env } = harnessCommand({ harness: "copilot", model: "m", prompt: "p", runner });
  assert.ok(!args.includes("--allow-all"), "no longer everything allowed");
  assert.deepEqual(args.slice(0, 8), ["--sandbox", "--allow-all-tools", "--allow-all-urls", "--no-auto-update", "--log-level", "none", "--add-dir", AGENT.tmp], "file tools in the checkout and the agent's temp directory only; no update of itself; no logs in its commands' reach");
  assert.ok(!args.includes("--trust-folder"));
  assert.equal(args.find((a) => a.startsWith("--secret-env-vars=")), `--secret-env-vars=${SHELL_SECRET_KEYS.join(",")}`);
  assert.equal(env.COPILOT_HOME, `${AGENT.home}/.factory-copilot/home`);
  assert.equal(env.COPILOT_CACHE_HOME, `${COPILOT_RUNNER_HOME}/cache`, "the release it runs is Factory's, never one the agent could replace");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsmonitor", "Copilot's own git runs no fsmonitor from the checkout");
  assert.equal(runner.sessions, `${AGENT.home}/${COPILOT_RUNNER_SESSION_ROOT}`);
  const [cmd, launch] = copilotLaunch(runner, "copilot", ["-p"], "/opt/tool/bin:/home/factory-agent/.local/bin:node_modules/.bin::/usr/bin");
  assert.equal(cmd, "/bin/sh");
  assert.deepEqual(launch, ["-c", COPILOT_TMP_LAUNCH, "factory-copilot", COPILOT_TMP, `HOME=${COPILOT_RUNNER_HOME}`, `PATH=${COPILOT_RUNNER_HOME}/bin:/opt/tool/bin:/usr/bin`, "copilot", "-p"], "Factory's HOME and bwrap first, a TMPDIR of its own, nothing of the agent's home and no relative entry on its PATH");
  assert.ok(!COPILOT_TMP_LAUNCH.includes("${"));
  assert.equal(copilotRunner({ harness: "codex", agent: AGENT, clone: CLONE }), null);
  assert.equal(copilotRunner({ harness: "copilot", agent: null, clone: CLONE }), null, "no agent uid (a developer's /factory:run): no runner sandbox");
  assert.equal(copilotRunner({ harness: "copilot", agent: AGENT, clone: CLONE, env: { FACTORY_LOCAL: "1" } }), null, "local mode has its own");
  assert.ok(harnessCommand({ harness: "copilot", prompt: "p" }).args.includes("--allow-all"), "a developer's own session is unchanged");
});

test("Copilot's runner policy: writes in the checkout, temp directory and caches; git and harness configuration read-only; the login readable", async () => {
  const { runner } = fakeRunner();
  await resetCopilotState(runner, process.env);
  const settings = JSON.parse(readFileSync(join(runner.copilotHome, "settings.json"), "utf8")).sandbox;
  assert.equal(settings.enabled, true);
  assert.equal(settings.allowBypass, false);
  assert.deepEqual(settings.auth, { git: false, gh: false }, "no git or gh login handed in by Copilot");
  const fs = settings.userPolicy.filesystem;
  for (const p of [runner.clone, runner.agentTmp, ...runner.caches, join(runner.clone, ".git")]) assert.ok(fs.readwritePaths.includes(p), `${p}: writable`);
  assert.ok(!fs.readwritePaths.includes(runner.agentHome), "never the agent's home");
  for (const p of ["config", "hooks", "commondir", "info", "info/attributes"]) assert.ok(fs.readonlyPaths.includes(join(runner.clone, ".git", p)), `.git/${p}: read-only`);
  for (const p of [".github/hooks", ".github/copilot", ".mcp.json"]) assert.ok(fs.readonlyPaths.includes(join(runner.clone, p)), `${p}: read-only`);
  for (const p of [".gitconfig", ".config/gh", ".factory"]) assert.ok(fs.readonlyPaths.includes(join(runner.agentHome, p)), `the agent's ${p}: read for its commands`);
  assert.deepEqual(fs.deniedPaths, [COPILOT_TMP], "Copilot's own TMPDIR (each command's network rules); the agent's login is for its commands");
  assert.deepEqual(settings.userPolicy.network, { allowOutbound: true, allowLocalNetwork: false, allowedHosts: LOCAL_DOMAINS });
  const local = copilotLocalSettings({ clone: "/c", addDirs: ["/c"], home: "/h", platform: "darwin" }).sandbox.userPolicy.filesystem;
  assert.ok(local.deniedPaths.includes("/h/.config/gh"), "local mode still denies the developer's credential stores");
});

test("Copilot's state is made afresh before every start: a planted setting is gone, held sessions come back, the temp directory's harness configuration is cleared", async () => {
  const { runner } = fakeRunner();
  mkdirSync(runner.copilotHome, { recursive: true });
  writeFileSync(join(runner.copilotHome, "mcp-config.json"), '{"mcpServers":{"x":{"command":"evil"}}}');
  mkdirSync(join(runner.copilotHome, "hooks"));
  mkdirSync(join(runner.agentTmp, ".github", "hooks"), { recursive: true });
  writeFileSync(join(runner.agentTmp, ".github", "hooks", "h.json"), "{}");
  writeFileSync(join(runner.agentTmp, "keep.txt"), "mine");
  const src = mkdtempSync(join(tmpdir(), "sess-"));
  mkdirSync(join(src, "abc"));
  writeFileSync(join(src, "abc", "events.jsonl"), "{}\n");
  dropSessions();
  holdSession("abc", execFileSync("tar", ["-C", src, "-cf", "-", "abc"]));
  try {
    await resetCopilotState(runner, process.env);
  } finally {
    dropSessions();
  }
  assert.equal(readFileSync(join(runner.copilotHome, "mcp-config.json"), "utf8"), '{"mcpServers":{}}\n', "no MCP server");
  assert.ok(!existsSync(join(runner.copilotHome, "hooks")), "nothing planted survives");
  assert.match(readFileSync(join(runner.copilotHome, "config.json"), "utf8"), /firstLaunchAt/);
  assert.equal(readFileSync(join(runner.sessions, "abc", "events.jsonl"), "utf8"), "{}\n", "Factory's held session is put back");
  assert.ok(!existsSync(join(runner.agentTmp, ".github", "hooks")), "an added directory's harness configuration is cleared");
  assert.equal(readFileSync(join(runner.agentTmp, "keep.txt"), "utf8"), "mine", "and nothing else of it");
});

test("Factory's bwrap: the real one starts with no environment; each command's HOME and TMPDIR become the agent's", () => {
  const root = mkdtempSync(join(tmpdir(), "shim-"));
  const real = join(root, "real-bwrap");
  writeFileSync(real, '#!/bin/sh\necho "env=$(env | grep -c .)"\nfor a do echo "arg=$a"; done\n', { mode: 0o755 });
  const shim = join(root, "bwrap");
  writeFileSync(shim, bwrapShim(real, "/home/factory-agent", "/home/factory-agent/tmp"), { mode: 0o755 });
  const out = execFileSync(shim, ["--clearenv", "--setenv", "HOME", "/var/lib/factory-copilot", "--setenv", "TMPDIR", "/tmp", "--setenv", "X", "HOME", "--", "sh", "-c", "--setenv", "HOME", "kept"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: "github_pat_secret" } });
  const lines = out.trim().split("\n");
  // `env` itself shows PWD at most: nothing the shim was started with.
  assert.ok(Number(lines[0].slice(4)) <= 1, `no environment: ${lines[0]}`);
  assert.ok(!out.includes("github_pat_secret"));
  assert.deepEqual(lines.slice(1).map((l) => l.slice(4)), ["--clearenv", "--setenv", "HOME", "/home/factory-agent", "--setenv", "TMPDIR", "/home/factory-agent/tmp", "--setenv", "X", "HOME", "--", "sh", "-c", "--setenv", "HOME", "kept"], "only bubblewrap's own options change");
  assert.ok(!bwrapShim("/usr/bin/bwrap", "/h", "/t").includes("${"));
});

test("Copilot's probe: the decoy launch holds the marker, the driver writes its result, the model asks for one call", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpp-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // A stand-in copilot: reports whether the decoy it was given holds the marker.
  writeFileSync(join(bin, "copilot"), `#!/bin/sh\necho "args=$*"\ntr '\\0' '\\n' < /proc/$FACTORY_PROBE_DECOY/environ | grep -c '^${PROBE_MARKER}=m9$'\n`, { mode: 0o755 });
  const got = execFileSync("/bin/sh", ["-c", COPILOT_DECOY_LAUNCH, "sh", "--sandbox"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, [PROBE_MARKER]: "m9" } }).split("\n");
  assert.deepEqual(got.slice(0, 2), ["args=--sandbox", "1"]);
  for (const s of [COPILOT_DECOY_LAUNCH, probeDriver({ gitConfig: "/c/.git/config", host: "example.com", marker: "m" })]) assert.ok(!s.includes("${"), "nothing systemd-run would expand");
  // The driver, unconfined here: the marker is in this shell's own parent, so the probe says so and the result is written.
  const tmp = join(root, "t");
  const home = join(root, "h");
  mkdirSync(tmp);
  mkdirSync(home);
  // Copilot's TMPDIR: a path that is not there (this machine's own /tmp/factory-copilot is no business of the test's).
  const driver = probeDriver({ gitConfig: "", host: "", marker: "m5", persist: [home], copilotTmp: join(root, "no-copilot-tmp") });
  const drive = (extra) => {
    execFileSync("/bin/sh", ["-c", driver], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, FACTORY_PROBE_SCRIPT: CONFINEMENT_PROBE, FACTORY_PROBE_DECOY: "999999999", [PROBE_MARKER]: "m5", ...extra } });
    return readFileSync(join(tmp, PROBE_RESULT), "utf8");
  };
  assert.equal(drive({}), "4\nthe credential stand-in is readable in a process environment\n");
  assert.ok(existsSync(join(home, PROBE_PERSIST)), "unconfined, the home write lands: Factory checks for it from outside");
  assert.equal(drive({ FACTORY_PROBE_SCRIPT: "" }), "4\nthe probe script is missing\n", "an empty script would exit 0 and pass");
  assert.equal(drive({ FACTORY_PROBE_DECOY: "" }), "4\nthe probe's decoy is missing\n", "and an empty decoy would skip its rule");
  assert.equal(drive({ FACTORY_PROBE_SCRIPT: "true", [PROBE_MARKER]: "" }), "0\n\n", "a script that checks nothing leaves no pass line");
  assert.match(driver, /mxc-bwrap-proxy-\*/, "Copilot's network rules must not be listable");
  assert.ok(probeDriver({ gitConfig: "", host: "", marker: "m" }).includes(`true >> '${COPILOT_TMP}/`), "nor its TMPDIR writable");
  const withLogs = probeDriver({ gitConfig: "", host: "", marker: "m", logs: "/p/logs" });
  assert.ok(withLogs.includes("find '/p/logs'") && !withLogs.includes("$COPILOT_HOME"), "the logs by their path, never a variable a command may lack");
  // The loopback model: a shell call first, then the end.
  const model = await probeModel();
  try {
    const ask = async (input) => (await (await fetch(`${model.env.COPILOT_PROVIDER_BASE_URL}/responses`, { method: "POST", body: JSON.stringify({ input }) })).text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const first = (await ask([{ type: "message", role: "user", content: "x" }])).find((e) => e.type === "response.completed").response.output[0];
    assert.equal(first.type, "function_call");
    assert.deepEqual(JSON.parse(first.arguments).command, 'sh -c "$FACTORY_COPILOT_PROBE"', "no path in the command line: Copilot's path checks would refuse one");
    const second = (await ask([{ type: "function_call_output", call_id: "call_probe", output: "ok" }])).find((e) => e.type === "response.completed").response.output[0];
    assert.equal(second.type, "message");
    assert.equal(model.env.COPILOT_OFFLINE, "true");
  } finally {
    await model.close();
  }
});

test("Copilot's sandbox probe runs before every start: its result decides; no result twice Blocks, a broken rule at once", async () => {
  const { runner } = fakeRunner();
  const model = async () => ({ env: { COPILOT_OFFLINE: "true", COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:1/v1" }, close: async () => {} });
  const calls = [];
  const leaving = (result, { persist = false } = {}) => async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    if (result !== null) writeFileSync(join(runner.agentTmp, PROBE_RESULT), result);
    if (persist) writeFileSync(join(runner.agentHome, PROBE_PERSIST), "");
    return { code: 0, stdout: "", stderr: "" };
  };
  await copilotSandboxCheck(runner, { PATH: "/usr/bin" }, { run: leaving(`0\n${PROBE_PASS}\n`), model });
  const call = calls[0];
  assert.equal(call.cmd, "/bin/sh");
  assert.ok(call.args.includes(COPILOT_DECOY_LAUNCH) && call.args.includes("--sandbox") && call.args.includes(`HOME=${runner.home}`) && call.args.includes(`PATH=${runner.bin}:/usr/bin`) && call.args.includes(COPILOT_TMP));
  assert.ok(call.args.includes(`--secret-env-vars=${[...SHELL_SECRET_KEYS, PROBE_MARKER].join(",")}`), "the marker is kept from commands as the token is");
  assert.match(call.env[PROBE_MARKER], /^[0-9a-f]{32}$/);
  assert.equal(call.env.COPILOT_HOME, runner.probeHome, "a COPILOT_HOME of its own");
  assert.equal(call.env.FACTORY_PROBE_SCRIPT, CONFINEMENT_PROBE);
  assert.ok(call.env.FACTORY_COPILOT_PROBE.includes(call.env[PROBE_MARKER]));
  assert.ok(existsSync(join(runner.probeHome, "settings.json")), "with the run's settings");
  assert.ok(!existsSync(join(runner.agentTmp, PROBE_RESULT)), "the result is consumed");
  calls.length = 0;
  await assert.rejects(copilotSandboxCheck(runner, {}, { run: leaving("4\nthe decoy outside the sandbox is readable\n"), model }), (e) => e instanceof GitRefusal && e.code === "sandbox" && e.rule === "the decoy outside the sandbox is readable" && e.harness === "copilot");
  assert.equal(calls.length, 1, "a broken rule is never retried");
  await assert.rejects(copilotSandboxCheck(runner, {}, { run: leaving(`0\n${PROBE_PASS}\n`, { persist: true }), model }), (e) => e.rule === "the agent home is writable", "a file the probe made in the agent's home");
  assert.ok(!existsSync(join(runner.agentHome, PROBE_PERSIST)), "and it is removed");
  await assert.rejects(copilotSandboxCheck(runner, {}, { run: leaving("0\n\n"), model }), (e) => e.rule === "the probe ended without its pass line", "exit 0 alone is no pass");
  mkdirSync(runner.home, { recursive: true });
  const factoryHome = async (cmd, args, opts) => {
    await leaving(`0\n${PROBE_PASS}\n`)(cmd, args, opts);
    writeFileSync(join(runner.home, PROBE_PERSIST), "");
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(copilotSandboxCheck(runner, {}, { run: factoryHome, model }), (e) => e.rule === "Factory's HOME for Copilot is writable");
  assert.ok(!existsSync(join(runner.home, PROBE_PERSIST)), "removed by Factory, which owns it");
  await assert.rejects(copilotSandboxCheck(runner, {}, { run: leaving("4\n<b>planted</b>\n"), model }), (e) => e.rule === "an unknown rule");
  calls.length = 0;
  await assert.rejects(copilotSandboxCheck(runner, {}, { run: leaving(null), model }), (e) => e.code === "sandbox" && !e.rule && /Copilot's sandbox could not start/.test(e.message));
  assert.equal(calls.length, 2, "no result is tried once more before it Blocks");
  assert.match(gitRefusalReason("sandbox", 1, { harness: "copilot" }), /Copilot's sandbox could not start.*copilot sandbox: bwrap, slirp4netns, apparmor, start/);
  assert.match(gitRefusalReason("sandbox", 1, { rule: "the agent home is writable", harness: "copilot" }), /^Copilot's sandbox started but does not confine here/);
});

test("local Copilot (#100): Factory's bwrap hands commands the stage's TMPDIR; the probe runs in the outer sandbox with Copilot's own TMPDIR, without the token, and Blocks a leak", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpl-"));
  const real = join(root, "real-bwrap");
  writeFileSync(real, '#!/bin/sh\necho "env=$(env | grep -c .)"\nfor a do echo "arg=$a"; done\n', { mode: 0o755 });
  const shim = join(root, "bwrap");
  writeFileSync(shim, bwrapShim(real, null, "/s/t"), { mode: 0o755 });
  const argv = ["--clearenv", "--setenv", "HOME", "/home/dev", "--setenv", "TMPDIR", "/s/copilot-tmp", "--", "sh"];
  const out = execFileSync(shim, argv, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: "github_pat_secret" } }).trim().split("\n");
  assert.ok(Number(out[0].slice(4)) <= 1 && !out.join("\n").includes("github_pat_secret"), "the real bwrap gets no environment");
  assert.deepEqual(out.slice(1).map((l) => l.slice(4)), argv.map((a) => (a === "/s/copilot-tmp" ? "/s/t" : a)), "Copilot's HOME kept, its commands' TMPDIR the stage's, nothing else changed");
  const [home, tmp, usage, clone, chome] = ["h", "t", "u", "w", "c"].map((d) => join(root, d));
  for (const d of [home, tmp, join(usage, "harness"), clone, chome]) mkdirSync(d, { recursive: true });
  writeFileSync(join(chome, "settings.json"), '{"sandbox":{"enabled":true}}\n');
  const ctmp = copilotPrivateTmp(usage);
  mkdirSync(ctmp);
  writeFileSync(join(ctmp, "planted"), "");
  const local = { clone, addDirs: [tmp], cacheDirs: [], domains: LOCAL_DOMAINS, bwrapBin: root, copilotTmp: ctmp };
  const env = { PATH: `${root}:/usr/bin`, TMPDIR: tmp, FACTORY_USAGE_DIR: usage, COPILOT_HOME: chome, COPILOT_GITHUB_TOKEN: "github_pat_secret", MY_SECRET: "s" };
  const calls = [];
  const leaving = (result) => async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env, settings: readFileSync(join(opts.env.COPILOT_HOME, "settings.json"), "utf8") });
    writeFileSync(join(tmp, PROBE_RESULT), result);
    return { code: 0, stdout: "", stderr: "" };
  };
  await copilotLocalCheck(local, "/o.json", env, { drop: ["MY_SECRET"], run: leaving(`0\n${PROBE_PASS}\n`), home });
  const [call] = calls;
  assert.equal(call.cmd, "srt");
  assert.deepEqual(call.args.slice(0, 7), ["-s", "/o.json", "--", "env", `TMPDIR=${ctmp}`, process.execPath, COPILOT_PROBE_SCRIPT], "Copilot's own TMPDIR");
  assert.ok(!existsSync(join(ctmp, "planted")), "made afresh before the start");
  assert.ok(call.env.FACTORY_COPILOT_PROBE.includes(`'${ctmp}'/mxc-bwrap-proxy-* "$TMPDIR"/mxc-bwrap-proxy-*`), "its rules checked where Copilot and the commands keep temp files");
  assert.ok(call.args.includes(COPILOT_DECOY_LAUNCH) && call.args.includes("--sandbox") && call.args.includes(`--secret-env-vars=${[...SHELL_SECRET_KEYS, PROBE_MARKER].join(",")}`));
  assert.ok(!("COPILOT_GITHUB_TOKEN" in call.env) && !("MY_SECRET" in call.env), "never the run's credentials: the marker stands in");
  assert.match(call.env[PROBE_MARKER], /^[0-9a-f]{32}$/);
  assert.equal(call.env.PATH, env.PATH, "Factory's bwrap first, as the run has it");
  assert.equal(call.env.COPILOT_HOME, join(usage, "harness", "copilot-probe"));
  assert.equal(call.settings, '{"sandbox":{"enabled":true}}\n', "with the stage's policy");
  assert.ok(!existsSync(call.env.COPILOT_HOME), "removed afterwards");
  await assert.rejects(copilotLocalCheck(local, "/o.json", env, { run: leaving("4\nthe credential stand-in is readable in a process environment\n"), home }), (e) => e instanceof GitRefusal && e.rule === "the credential stand-in is readable in a process environment" && e.local);
  await assert.rejects(copilotLocalCheck(local, "/o.json", env, { run: leaving("0\n\n"), home }), (e) => e.rule === "the probe ended without its pass line" && e.local, "exit 0 alone is no pass");
  // The driver as local mode gives it (every path under this test's own directory, never the host's /tmp/factory-copilot):
  // without Factory's bwrap the commands' $TMPDIR is Copilot's own, denied, so the result goes to the stage's by its path
  // and names the broken rule (here, unconfined: Copilot's TMPDIR absent, the marker in this shell's parent).
  const driver = probeEnv({ clone, probeHome: join(usage, "p"), cacheHome: join(root, "cache"), agentHome: home, home, agentTmp: tmp, copilotTmp: join(root, "denied-copilot-tmp") }, "m6", "").FACTORY_COPILOT_PROBE;
  assert.ok(!driver.includes("/tmp/factory-copilot"));
  execFileSync("/bin/sh", ["-c", driver], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: home, TMPDIR: join(root, "denied"), FACTORY_PROBE_SCRIPT: CONFINEMENT_PROBE, FACTORY_PROBE_DECOY: "1", [PROBE_MARKER]: "m6" } });
  assert.equal(readFileSync(join(tmp, PROBE_RESULT), "utf8"), "4\nthe credential stand-in is readable in a process environment\n");
  const denied = copilotLocalSettings({ clone, addDirs: [tmp], alsoDenied: [ctmp], platform: "linux" }).sandbox;
  assert.ok(JSON.stringify(denied).includes(JSON.stringify(ctmp)), "Copilot's own TMPDIR is denied to commands");
  assert.match(gitRefusalReason("sandbox", 1, { rule: "x", harness: "copilot", local: true }), /The stage log on the local machine/);
});

test("doctor: Copilot in a job needs bwrap and slirp4netns, AppArmor for unshare on a self-hosted runner, and its sandbox confining", async () => {
  const names = (rows) => rows.map((r) => `${r.name}:${r.status}`);
  const copilot = { harness: "copilot" };
  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: copilot, env: hosted, local: false, has: async () => true, start: async () => ({ ok: true }) })), ["copilot sandbox: bwrap:PASS", "copilot sandbox: slirp4netns:PASS", "copilot sandbox: start:PASS"]);
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: copilot, env: hosted, local: false, has: async (b) => b !== "slirp4netns", start: async () => ({ ok: true }) })), ["copilot sandbox: bwrap:PASS", "copilot sandbox: slirp4netns:FAIL"], "no start without its tools");
  const self = await claudeSandboxChecks({ inputs: copilot, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, local: false, has: async () => true, read: () => "1\n", profiles: async () => "factory-bwrap (unconfined)\n", start: async () => ({ ok: false, reason: "Copilot's sandbox does not confine: the decoy outside the sandbox is readable" }) });
  assert.deepEqual(names(self), ["copilot sandbox: bwrap:PASS", "copilot sandbox: slirp4netns:PASS", "copilot sandbox: apparmor:FAIL", "copilot sandbox: start:FAIL"], "the bwrap profile is not the one: Copilot's namespaces come from unshare");
  assert.match(self[2].fix, /factory-unshare/);
  assert.match(self[3].detail, /decoy/);
  const both = await claudeSandboxChecks({ inputs: copilot, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, local: false, has: async () => true, read: () => "1\n", profiles: async () => "factory-bwrap (unconfined)\nfactory-unshare (unconfined)\n", start: async () => ({ ok: true }) });
  assert.equal(both[2].status, "PASS");
  const unshareOnly = await claudeSandboxChecks({ inputs: copilot, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, local: false, has: async () => true, read: () => "1\n", profiles: async () => "factory-unshare (unconfined)\n", start: async () => ({ ok: true }) });
  assert.equal(unshareOnly[2].status, "PASS", "Copilot's bwrap joins unshare's namespaces: the unshare grant is the one it needs");
  const restricted = await claudeSandboxChecks({ inputs: copilot, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, local: false, has: async () => true, read: () => "1\n", profiles: async () => "factory-unshare (unconfined)\nunpriv_unshare (enforce)\n", start: async () => ({ ok: true }) });
  assert.equal(restricted[2].status, "FAIL", "Ubuntu's unshare-userns-restrict loaded (25.04 and later)");
  assert.match(restricted[2].fix, /unshare-userns-restrict/);
  assert.deepEqual(await claudeSandboxChecks({ inputs: copilot, env: hosted, local: true, has: async () => false }), [], "local mode checks its own sandboxes");
});

test("a session file that never ends is not read on: the archive stops at its cap", async () => {
  const { runner } = fakeRunner();
  const { archiveSession } = await import("../scripts/lib/claude-runner.mjs");
  mkdirSync(join(runner.sessions, "s1", "files"), { recursive: true });
  // What a sandboxed command can leave in Copilot's session-state/<id>/files: a sparse file of 1 TB (16 TB is past ext4's limit).
  execFileSync("truncate", ["-s", "1T", join(runner.sessions, "s1", "files", "big")]);
  const t0 = Date.now();
  const a = await archiveSession(runner, "s1", process.env, { timeoutMs: 60_000, maxBytes: 1024 * 1024 });
  assert.equal(a.truncated, true);
  assert.ok(Date.now() - t0 < 30_000, "stopped at the cap, not read to the end");
});

test("the probe's last line: a pass line after every rule held; the first process's command line is Copilot's rule only", () => {
  assert.equal(CONFINEMENT_PROBE.split("\n").at(-2), `echo "${PROBE_PASS}"`);
  // Codex's probe gets the marker as an argument, and its sandbox's first process holds the whole command line.
  assert.doesNotMatch(CONFINEMENT_PROBE, /cmdline/);
  assert.match(probeDriver({ gitConfig: "", host: "", marker: "m7" }), /\/proc\/1\/cmdline[^\n]*grep -qxF -e 'm7' -e 'FACTORY_PROBE_MARKER=m7'/);
});
