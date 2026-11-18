import "./temp.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { BACKENDS } from "../scripts/lib/backend.mjs";
import { setSelf, setVerified, setWriters, trustedAuthor } from "../scripts/lib/logic.mjs";

test("sandbox and gate: local wraps Pendulum's commands in srt (and pendulum-db for validation), notes TMPDIR, runs commands first", async () => {
  const inner = ["bash", "-eo", "pipefail", "-c", "npm test"];
  assert.deepEqual(BACKENDS.actions.sandbox.command(inner, {}), ["bash", ["-eo", "pipefail", "-c", "npm test"]]);
  const env = { PENDULUM_LOCAL: "1", PENDULUM_LOCAL_SRT: "/s.json", PENDULUM_LOCAL_DB: "1", PENDULUM_DB_WRAP: "1", PENDULUM_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], clone: null }) };
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, env), ["srt", ["-s", "/s.json", "--", "pendulum-db", ...inner]]);
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, { ...env, PENDULUM_DB_WRAP: "" }), ["srt", ["-s", "/s.json", "--", ...inner]]);
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, { ...env, TMPDIR: "/tmp/pendulum-7-ab" }), ["srt", ["-s", "/s.json", "--", "env", "TMPDIR=/tmp/pendulum-7-ab", "pendulum-db", ...inner]]);
  assert.equal(BACKENDS.actions.sandbox.harness({ PENDULUM_LOCAL_SANDBOX: "{}" }), null);
  assert.throws(() => BACKENDS.local.sandbox.harness({ PENDULUM_LOCAL: "1" }), /unsandboxed/);
  assert.equal(BACKENDS.actions.sandbox.cardNotes(), "");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "copilot"), /\$TMPDIR[\s\S]*`deniedHosts`[\s\S]*outside your sandbox/, "Copilot's sandbox on a runner: Codex's notes");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "codex"), /\$TMPDIR[\s\S]*`deniedHosts`/, "Codex's sandbox on a runner: local mode's notes");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "claude"), /\$TMPDIR[\s\S]*`deniedHosts`/, "Claude Code's sandbox on a runner: local mode's notes");
  assert.doesNotMatch(BACKENDS.actions.sandbox.cardNotes({}, "claude"), /localhost|service/i, "no service offered: nothing said about services");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "claude", [5432, 6379]), /reachable from your commands at `localhost:5432`, `localhost:6379`\./, "the ports actually offered");
  assert.match(BACKENDS.local.sandbox.cardNotes({}), /\$TMPDIR/);
  assert.doesNotMatch(BACKENDS.local.sandbox.cardNotes({}), /pendulum-db/);
  assert.match(BACKENDS.local.sandbox.cardNotes({ PENDULUM_LOCAL_DB: "1" }), /pendulum-db npm run test:db/);
  assert.match(BACKENDS.local.sandbox.cardNotes({}), /`deniedHosts`/);
  assert.deepEqual([BACKENDS.actions.gate.commandsFirst, BACKENDS.local.gate.commandsFirst], [false, true]);
  assert.equal(await BACKENDS.local.trigger.stepsAside(), false);
});

test("trustedAuthor: Pendulum acts on a marker only from its own login or someone who can push, never another App", () => {
  setSelf(null);
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "clockgrove-pendulum[bot]" }, author_association: "NONE" }), false, "Pendulum's login unknown: no App counts");
  setSelf("clockgrove-pendulum[bot]");
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "Clockgrove-Pendulum[bot]" }, author_association: "NONE" }), true);
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "github-actions[bot]" }, author_association: "NONE" }), false, "the job token's comments forge nothing");
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "other-app[bot]" }, author_association: "NONE" }), false);
  setSelf(null);
  assert.equal(trustedAuthor({ user: { type: "User", login: "owner" }, author_association: "OWNER" }), true);
  // #605: a MEMBER or COLLABORATOR can be read-only; only a verified write permission makes one a writer.
  setWriters("acme/app", []);
  for (const a of ["MEMBER", "COLLABORATOR"]) assert.equal(trustedAuthor({ user: { type: "User", login: "member" }, author_association: a }), false);
  setVerified("acme/app", "member", true);
  for (const a of ["MEMBER", "COLLABORATOR"]) assert.equal(trustedAuthor({ user: { type: "User", login: "Member" }, author_association: a }), true);
  setWriters(null, []);
  for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", undefined]) assert.equal(trustedAuthor({ user: { type: "User" }, author_association: a }), false);
});

test("whichSync: a PATH scan, never a shell; names with separators or shell syntax resolve to nothing", async () => {
  const { whichSync } = await import("../scripts/lib/proc.mjs");
  assert.ok(whichSync("node"));
  for (const bad of ["node;touch /tmp/pendulum-which-probe", "$(id)", "../node", "/usr/bin/node", ""]) assert.equal(whichSync(bad), null);
});

test("spend lines: a local run's dollars round-trip through its progress comment; prose and junk count 0", async () => {
  const { spendMarker, spendOf } = await import("../scripts/lib/logic.mjs");
  const body = `<!-- pendulum:7:progress:work:1 -->\nPendulum work run 1\n- 01:00Z exit: delivered; usd 0.34\n${spendMarker(0.3392)}`;
  assert.deepEqual(spendOf(body), { usd: 0.3392, unknown: 0 });
  assert.deepEqual(spendOf("- 01:00Z exit: delivered; usd 0.34"), { usd: 0, unknown: 0 }, "the prose exit line is never read");
  assert.deepEqual(spendOf('<!-- pendulum:spend {"usd":"x"} -->'), { usd: 0, unknown: 0 });
  assert.deepEqual(spendOf('<!-- pendulum:spend {"usd":-5} -->'), { usd: 0, unknown: 0 });
});

test("Pendulum's git on the agent's checkout: locally always in srt's git profile, never on the host", () => {
  const inner = ["git", "-C", "/c", "checkout", "-B", "pendulum/1"];
  assert.throws(() => BACKENDS.local.sandbox.git(inner, { PENDULUM_LOCAL: "1" }), /unsandboxed/);
  assert.deepEqual(BACKENDS.local.sandbox.git(inner, { PENDULUM_LOCAL_SRT_GIT: "/g.json", TMPDIR: "/t" }), ["srt", ["-s", "/g.json", "--", "env", "TMPDIR=/t", ...inner]]);
});

test("agent uid: its commands run in a confined systemd unit with an allowlisted env, values never on the command line", async () => {
  const { asAgent, setAgent, sudoEnv } = await import("../scripts/lib/proc.mjs");
  setAgent({ user: "pendulum-agent", home: "/home/pendulum-agent", tmp: "/home/pendulum-agent/tmp", allow: new Set(["DATABASE_URL"]) });
  try {
    const env = { PATH: "/opt/tool/bin:/usr/bin", LANG: "C", CI: "true", DATABASE_URL: "postgres://x", PENDULUM_OUT: "/o", ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghs_job", PENDULUM_INPUT_APP_PRIVATE_KEY: "pem", ACTIONS_RUNTIME_TOKEN: "rt", RANDOM_RUNNER_VAR: "x" };
    const [cmd, args, out] = asAgent("bash", ["-c", "true"], env, [], "/home/pendulum-agent/repo");
    assert.equal(cmd, "/usr/bin/sudo");
    assert.deepEqual(args.slice(0, 3), ["-n", "--preserve-env=LANG,CI,DATABASE_URL,PENDULUM_OUT", "/usr/bin/systemd-run"]);
    for (const p of ["--uid=pendulum-agent", "--gid=pendulum-agent", "--pipe", "--wait", "--collect", "--working-directory=/home/pendulum-agent/repo", "--property=ProtectSystem=strict", "--property=ProtectHome=tmpfs", "--property=BindPaths=/home/pendulum-agent", "--property=ReadWritePaths=/home/pendulum-agent", "--property=PrivateTmp=yes", "--property=ReadOnlyPaths=/run", "--property=TemporaryFileSystem=/dev/shm:mode=1777 /run/lock:mode=1777", "--property=PrivateIPC=yes", "--property=NoNewPrivileges=yes", "--property=KillMode=control-group", "--setenv=DATABASE_URL", "--setenv=TMPDIR=/home/pendulum-agent/tmp", "--setenv=HOME=/home/pendulum-agent"]) assert.ok(args.includes(p), p);
    assert.deepEqual(args.slice(args.indexOf("--")), ["--", "/usr/bin/env", "bash", "-c", "true"]);
    assert.deepEqual(out, { LANG: "C", CI: "true", DATABASE_URL: "postgres://x", PENDULUM_OUT: "/o" });
    assert.doesNotMatch(args.join(" "), /sk-secret|ghs_job|postgres/, "no value on the command line");
    assert.deepEqual(sudoEnv(args, out), { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...out }, "sudo itself starts with only those, and a fixed PATH");
    const [, harnessArgs, harnessEnv] = asAgent("claude", ["-p"], env, ["ANTHROPIC_API_KEY"]);
    assert.equal(harnessEnv.ANTHROPIC_API_KEY, "sk-secret", "the harness gets its model key");
    assert.ok(harnessArgs.includes("--setenv=ANTHROPIC_API_KEY"));
    assert.equal(harnessEnv.GITHUB_TOKEN, undefined);
  } finally {
    setAgent(null);
  }
});


test("Copilot always runs with its built-in GitHub MCP server off; the local sandboxes deny /proc", async () => {
  const { harnessCommand } = await import("../scripts/lib/harness.mjs");
  const { claudeLocalSettings, codexLocalConfig, srtSettings } = await import("../scripts/lib/local.mjs");
  for (const local of [null, { addDirs: [], domains: [], clone: null, readOnly: [] }]) assert.ok(harnessCommand({ harness: "copilot", prompt: "x", local }).args.includes("--disable-builtin-mcps"));
  assert.ok(claudeLocalSettings({ home: "/h" }).sandbox.filesystem.denyRead.includes("/proc"));
  assert.ok(claudeLocalSettings({ home: "/h" }).permissions.deny.includes("Read(//proc/**)"));
  assert.ok(srtSettings({ home: "/h" }).filesystem.denyRead.includes("/proc"));
  assert.match(codexLocalConfig({ home: "/h" }).join(" "), /"\/proc"="deny"/);
});

test("the agent's read-only token: a file in its own home, git's helper for github.com only, gh's hosts.yml", async () => {
  const { readTokenFiles } = await import("../scripts/lib/agent.mjs");
  const { files, helper } = readTokenFiles("/home/pendulum-agent", "ghs_read");
  assert.equal(files[".pendulum/read-token"], "ghs_read\n");
  assert.match(files[".gitconfig"], /^\[credential\]\n\thelper =\n\[credential "https:\/\/github\.com"\]\n\thelper = "!f\(\) \{ echo username=x-access-token; echo \\"password=\$\(cat \/home\/pendulum-agent\/\.pendulum\/read-token\)\\"; \}; f"\n$/);
  assert.match(files[".config/gh/hosts.yml"], /oauth_token: ghs_read/);
  assert.match(helper, /cat \/home\/pendulum-agent\/\.pendulum\/read-token/);
});

test("local notices: the App's key only from under ~/.config/pendulum (its real path), both settings or neither", async () => {
  const { chmodSync, linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localApp } = await import("../scripts/lib/local.mjs");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pendulum-home-")));
  try {
    mkdirSync(join(home, ".config", "pendulum", "github-app"), { recursive: true });
    const key = join(home, ".config", "pendulum", "github-app", "app.pem");
    writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n", { mode: 0o600 });
    writeFileSync(join(home, "elsewhere.pem"), "secret-text");
    symlinkSync(join(home, "elsewhere.pem"), join(home, ".config", "pendulum", "link.pem"));
    assert.deepEqual(localApp({}, home), { app: null });
    assert.deepEqual(localApp({ PENDULUM_LOCAL_APP_ID: "5", PENDULUM_LOCAL_APP_KEY: "~/.config/pendulum/github-app/app.pem" }, home).app, { id: "5", key: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n" });
    assert.match(localApp({ PENDULUM_LOCAL_APP_ID: "5" }, home).problem, /both/);
    assert.match(localApp({ PENDULUM_LOCAL_APP_ID: "x", PENDULUM_LOCAL_APP_KEY: key }, home).problem, /numeric/);
    assert.match(localApp({ PENDULUM_LOCAL_APP_ID: "5", PENDULUM_LOCAL_APP_KEY: join(home, "nope.pem") }, home).problem, /no file/);
    for (const p of [join(home, "elsewhere.pem"), join(home, ".config", "pendulum", "link.pem")]) {
      const r = localApp({ PENDULUM_LOCAL_APP_ID: "5", PENDULUM_LOCAL_APP_KEY: p }, home);
      assert.match(r.problem, /no sandbox can read/);
      assert.ok(!r.problem.includes("secret-text"), "the key's text is never in a message");
    }
    const ok = { PENDULUM_LOCAL_APP_ID: "5", PENDULUM_LOCAL_APP_KEY: key };
    chmodSync(key, 0o640);
    assert.match(localApp(ok, home).problem, /chmod 600/, "group or world bits");
    chmodSync(key, 0o600);
    linkSync(key, join(home, "second-link.pem"));
    assert.match(localApp(ok, home).problem, /hard links/, "a second hard link reaches the key outside ~/.config/pendulum");
    rmSync(join(home, "second-link.pem"));
    assert.ok(localApp(ok, home).app);
    assert.ok(localApp(ok, home, "claude").app, "the default harness homes hold no ~/.config/pendulum");
    assert.match(localApp({ ...ok, CLAUDE_CONFIG_DIR: join(home, ".config") }, home, "claude").problem, /harness's home/, "a harness home the outer sandbox reads holds the key");
    assert.match(localApp({ ...ok, CODEX_HOME: join(home, ".config", "pendulum") }, home, "codex").problem, /harness's home/);
    // ~/.config/pendulum itself a symlink: the sandboxes deny the literal path, not where it points.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "pendulum-home-")));
    mkdirSync(join(other, ".config"), { recursive: true });
    symlinkSync(join(home, ".config", "pendulum"), join(other, ".config", "pendulum"));
    assert.match(localApp({ PENDULUM_LOCAL_APP_ID: "5", PENDULUM_LOCAL_APP_KEY: join(other, ".config", "pendulum", "github-app", "app.pem") }, other).problem, /not a symlink/);
    rmSync(other, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("local notices: a stage gets the notice token from its parent over IPC, and nothing the stage starts inherits the channel", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const { serveNotices, noticeFromParent } = await import("../scripts/lib/app-token.mjs");
  assert.equal(noticeFromParent({ proc: {} }), null, "no channel (Actions, deliver): no notice token");
  const lib = pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", "app-token.mjs")).href;
  // The stage: asks twice (one answer, one refusal), then starts a shell that lists its own fds and env.
  const stage = `
    import { spawnSync } from "node:child_process";
    const { noticeFromParent } = await import(${JSON.stringify(lib)});
    const issued = [];
    const ask = noticeFromParent({ issued });
    const first = await ask();
    const second = await ask().then(() => "no error", (e) => e.message);
    const sh = spawnSync("sh", ["-c", "ls -l /proc/$$/fd; env"], { encoding: "utf8" });
    console.log(JSON.stringify({ first, second, issued, sh: sh.stdout }));`;
  let calls = 0;
  const mint = async () => {
    calls += 1;
    if (calls === 2) throw new Error("mint refused");
    return { token: "ghs_notice", expiresAt: "2099-01-01T00:00:00Z" };
  };
  const child = spawn(process.execPath, ["--input-type=module", "-e", stage], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  serveNotices(child, mint);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, "the channel does not keep the stage alive");
  const r = JSON.parse(out);
  assert.deepEqual(r.first, { token: "ghs_notice", mintedAt: null }, "a mint that says no time: none");
  assert.match(r.second, /mint refused/);
  assert.deepEqual(r.issued, ["ghs_notice"]);
  const fdsOf = (text) => text.split("\n").map((l) => / (\d+) -> /.exec(l)?.[1]).filter(Boolean).sort();
  const lines = r.sh.split("\n");
  // The same shell started from this process: the fds any child here inherits anyway (a CI runner leaves some open).
  const { spawnSync } = await import("node:child_process");
  const baseline = fdsOf(spawnSync("sh", ["-c", "ls -l /proc/$$/fd"], { encoding: "utf8" }).stdout);
  if (!baseline.includes("3")) assert.ok(!fdsOf(r.sh).includes("3"), "the stage's IPC fd (3 here) is close-on-exec in the stage");
  assert.deepEqual(fdsOf(r.sh), baseline, "a process the stage starts holds no fd beyond what this one's children do");
  assert.ok(!lines.some((l) => l.startsWith("NODE_CHANNEL")), "no NODE_CHANNEL_* reaches the stage's children");
});

test("a local harness loads no settings or hooks from the clone, and no sandbox may write the clone's harness configuration", async () => {
  const { harnessCommand } = await import("../scripts/lib/harness.mjs");
  const { HARNESS_CONFIG, claudeLocalSettings, copilotLocalSettings, srtSettings } = await import("../scripts/lib/local.mjs");
  const local = { addDirs: ["/s/tmp"], readDirs: ["/s/usage"], domains: [], clone: "/c", readOnly: ["/s/usage"], claudeDir: "/s/usage/claude" };
  const c = harnessCommand({ harness: "claude", prompt: "x", local });
  // Claude Code: flag settings only (no user, project or local source), hooks off, skills and agents from Pendulum's copy.
  assert.equal(c.args[c.args.indexOf("--setting-sources") + 1], "");
  assert.equal(JSON.parse(c.args[c.args.indexOf("--settings") + 1]).disableAllHooks, true);
  assert.equal(c.args[c.args.indexOf("--plugin-dir") + 1], "/s/usage/claude/plugin");
  assert.equal(c.args[c.args.indexOf("--agents") + 1], "/s/usage/claude/agents.json");
  assert.equal(c.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, "1", "the repository's CLAUDE.md still loads");
  assert.ok(c.args.join(" ").includes("--add-dir /c"));
  const paths = [...HARNESS_CONFIG.dirs, ...HARNESS_CONFIG.files].map((p) => `/c/${p}`);
  const claude = claudeLocalSettings({ clone: "/c", home: "/h" });
  const copilot = copilotLocalSettings({ clone: "/c", home: "/h", platform: "linux" });
  // The clone's .git bound on its own in Copilot's sandbox: a mount point no command can rename (sandbox-check "rename .git").
  assert.deepEqual(copilot.sandbox.userPolicy.filesystem.readwritePaths, ["/c/.git"]);
  const srt = srtSettings({ clone: "/c", home: "/h" });
  for (const p of paths) {
    assert.ok(claude.sandbox.filesystem.denyWrite.includes(p) && claude.permissions.deny.includes(`Edit(/${p}/**)`), p);
    assert.ok(copilot.sandbox.userPolicy.filesystem.readonlyPaths.includes(p), p);
    assert.ok(srt.filesystem.denyWrite.includes(p), p);
  }
  // Pendulum's own git work (no clone in its profile) still writes the plugin's skills and agents there.
  assert.ok(!srtSettings({ home: "/h" }).filesystem.denyWrite.some((p) => p.startsWith("/c/")));
});

test("a local harness's own git never enters a submodule or runs an fsmonitor; package caches are no added directory", async () => {
  const { harnessCommand } = await import("../scripts/lib/harness.mjs");
  const { AGENT_SHELL_TELEMETRY_OFF } = await import("../scripts/lib/local.mjs");
  const local = { addDirs: ["/s/npm", "/s/tmp"], cacheDirs: ["/s/npm"], readDirs: [], domains: [], clone: "/c", readOnly: [] };
  for (const harness of ["claude", "codex", "copilot"]) {
    const { env, args } = harnessCommand({ harness, prompt: "x", local });
    const cfg = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    assert.equal(cfg["diff.ignoreSubmodules"], "all", harness);
    assert.equal(cfg["core.fsmonitor"], "false", harness);
    assert.ok(!args.includes("--trust-folder"), harness);
    // Claude Code would read a CLAUDE.md in an added directory, Copilot its .github/agents and skills.
    if (harness !== "codex") assert.ok(!args.join(" ").includes("--add-dir /s/npm") && args.join(" ").includes("--add-dir /s/tmp"), harness);
  }
  const c = harnessCommand({ harness: "claude", prompt: "x", local });
  assert.deepEqual(JSON.parse(c.args[c.args.indexOf("--settings") + 1]).sandbox.filesystem.allowWrite, ["/s/npm"]);
  assert.deepEqual(harnessCommand({ harness: "codex", prompt: "x", local: null }).env, AGENT_SHELL_TELEMETRY_OFF, "the Action's runner: only the agent shell's telemetry variables");
});

test("a Claude agent file becomes an --agents entry with only its description, prompt, tools and model", async () => {
  const { agentDefinition } = await import("../scripts/lib/checkout.mjs");
  const text = "---\nname: implementer\ndescription: \"Does one item.\"\ntools: Read, Edit, Bash\nmodel: m1\npermissionMode: bypassPermissions\nhooks:\n  SessionStart:\n    - hooks:\n        - type: command\n          command: touch /x\nmcpServers:\n  evil:\n    command: sh\n---\n\nDo the item.\n";
  assert.deepEqual(agentDefinition(text, "fallback"), { name: "implementer", definition: { description: "Does one item.", prompt: "Do the item.", tools: ["Read", "Edit", "Bash"], model: "m1" } });
  assert.equal(agentDefinition("no front matter", "x"), null);
  // Claude Code's /agents generator writes plain descriptions strict YAML refuses (`: ` inside, a leading backtick or @).
  const generated = "---\nname: code-reviewer\ndescription: Use this agent when you need a review. Examples: <example>Context: The user just wrote code. user: 'Review it' assistant: 'I will use the code-reviewer agent'</example>\ntools:\n  - Read\n  - Grep\nmodel: sonnet\n---\nYou review code.\n";
  assert.deepEqual(agentDefinition(generated, "x"), { name: "code-reviewer", definition: { description: "Use this agent when you need a review. Examples: <example>Context: The user just wrote code. user: 'Review it' assistant: 'I will use the code-reviewer agent'</example>", prompt: "You review code.", tools: ["Read", "Grep"], model: "sonnet" } });
  assert.equal(agentDefinition("---\nname: a\ndescription: Reviews code # internal note\nnote: x: y\n---\nP\n", "x")?.definition.description, "Reviews code");
  for (const d of ["`fmt` runner: formats code", "@team: owners", "Expert in: A, B: C"]) assert.equal(agentDefinition(`---\nname: a\ndescription: ${d}\n---\nP\n`, "x")?.definition.description, d, d);
  assert.equal(agentDefinition("---\nname: ../x\ndescription: d\n---\nbody", "safe").name, "safe");
});

test("a local harness's git: .git/commondir read-only everywhere, each .gitmodules name ignored, the git guard first", async () => {
  const { claudeLocalSettings, codexLocalConfig, copilotLocalSettings, srtSettings, harnessGitEnv, gitGuardScript } = await import("../scripts/lib/local.mjs");
  const cd = "/c/.git/commondir";
  assert.ok(claudeLocalSettings({ clone: "/c", home: "/h" }).sandbox.filesystem.denyWrite.includes(cd));
  assert.ok(copilotLocalSettings({ clone: "/c", home: "/h", platform: "linux" }).sandbox.userPolicy.filesystem.readonlyPaths.includes(cd));
  assert.ok(srtSettings({ clone: "/c", home: "/h" }).filesystem.denyWrite.includes(cd));
  // Codex: by absolute path where it exists (a stage makes it before any sandbox).
  const env = harnessGitEnv(["lib/a"]);
  const cfg = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(cfg["submodule.lib/a.ignore"], "all", "a .gitmodules ignore = none would otherwise win");
  assert.match(gitGuardScript("/usr/bin/git"), /PENDULUM_GIT_ID[\s\S]*exit 128[\s\S]*exec "\/usr\/bin\/git" "\$@"/);
});

test("Linux: Claude Code, and Codex and Copilot where their sandboxes start in it, run in an outer srt sandbox", async () => {
  const { OUTER_HARNESSES, OUTER_PROBED, harnessOuterSettings } = await import("../scripts/lib/local.mjs");
  assert.deepEqual(OUTER_HARNESSES, ["claude", "codex", "copilot"]);
  assert.deepEqual(OUTER_PROBED, ["codex", "copilot"], "Codex and Copilot are probed per host");
  const s = harnessOuterSettings({ harness: "codex", domains: ["github.com"], writable: ["/c"], clone: "/c", home: "/h", env: {} });
  assert.ok(s.allowNestedUserNamespaces && s.network.allowAllUnixSockets);
  const hosts = new Set(s.network.allowedDomains);
  assert.ok(hosts.has("api.openai.com") && !hosts.has("api.anthropic.com"));
  assert.ok(s.filesystem.allowWrite.includes("/h/.codex") && !s.filesystem.denyRead.some((p) => p.startsWith("/h/.codex")));
  assert.ok(s.filesystem.denyRead.includes("/h/.ssh") && s.filesystem.denyRead.includes("/h/.config/pendulum") && s.filesystem.denyRead.includes("/h/.claude/.credentials.json"));
  assert.equal(s.bwrapPath, undefined, "only Copilot's outer sandbox runs bwrap through Pendulum's wrapper");
  const c = harnessOuterSettings({ harness: "copilot", domains: ["registry.npmjs.org"], writable: ["/c"], clone: "/c", home: "/h", env: { COPILOT_HOME: "/u/copilot" }, bwrapPath: "/u/outer/bwrap" });
  assert.equal(c.bwrapPath, "/u/outer/bwrap");
  const copilotHosts = new Set(c.network.allowedDomains);
  assert.ok(copilotHosts.has("api.githubcopilot.com") && copilotHosts.has("registry.npmjs.org"));
  assert.ok(c.filesystem.allowWrite.includes("/u/copilot"));
});

// A stand-in for ripgrep that lists every file below its last argument, as `rg --files` does; with $WARN a line on
// stderr, then $SLEEP seconds of sleep and exit $CODE, so a test can make it warn, hang or fail.
const FAKE_RG = `#!/bin/sh
for t do :; done
find "$t" -type f | sort
[ -n "$WARN" ] && echo "rg: some/dir: Permission denied" >&2
[ -n "$SLEEP" ] && sleep "$SLEEP"
exit "\${CODE:-0}"
`;

test("the sandboxes' scan (#154): ripgrep's list less the lines whose first protected name is a nested .git; exit code and stderr kept; fails closed with the whole list", async () => {
  const { nestedGitLine, writeNestedGitScan } = await import("../scripts/lib/local.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync: write, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { join, dirname } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pendulum-scan-"));
  const fake = join(dir, "real-rg");
  write(fake, FAKE_RG, { mode: 0o755 });
  const scan = writeNestedGitScan(join(dir, "scan"), fake);
  assert.equal(statSync(scan).mode & 0o777, 0o755);
  assert.equal(statSync(join(dir, "scan")).mode & 0o777, 0o700);
  const r = join(dir, "clone");
  const kept = [".git/HEAD", ".git/config", ".git/hooks/pre-commit", ".bashrc", "sub/.bashrc", "sub/.vscode/settings.json", "sub/.claude/commands/x.md", "sub/.mcp.json", "c/.vscode/.git/x", "Dep/.GIT/config", "d/.gİt/hooks/x", "e/.git/.bashrc"];
  const dropped = ["dep/.git/HEAD", "dep/.git/config", "dep/.git/hooks/pre-commit", "vendor/dep/.git/hooks/x", "f/.git/config/.bashrc"];
  for (const f of [...kept, ...dropped]) {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    write(join(r, f), "");
  }
  const paths = (xs) => xs.map((f) => join(r, f)).sort();
  const run = (env = {}) => spawnSync(scan, ["--files", "--max-depth", "4", r], { encoding: "utf8", env: { ...process.env, ...env } });
  const ok = run({ WARN: "1" });
  assert.equal(ok.status, 0);
  assert.deepEqual(ok.stdout.split("\n").filter(Boolean).sort(), paths(kept));
  assert.match(ok.stderr, /Permission denied/, "ripgrep's stderr passes through (srt denies the directories it could not read)");
  // Lines that are not plain paths below the scanned directory are kept as they are.
  for (const l of [`${r}/x/../.git/hooks/y`, `${r}//dep/.git/HEAD`, `/elsewhere/dep/.git/config`, `${r}-other/dep/.git/HEAD`]) assert.equal(nestedGitLine(l, r), false, l);
  const none = run({ CODE: "1" });
  assert.equal(none.status, 1, "none found: ripgrep's 1, silent");
  // A 1 with anything on stderr (a shim that failed) is a failed scan: the whole list, exit 2.
  const noisy = run({ CODE: "1", WARN: "1" });
  assert.equal(noisy.status, 2);
  assert.deepEqual(noisy.stdout.split("\n").filter(Boolean).sort(), paths([...kept, ...dropped]));
  // A failed ripgrep: the whole list, nested .git included, and a failed scan's exit, which srt still binds.
  const bad = run({ CODE: "2" });
  assert.equal(bad.status, 2);
  assert.deepEqual(bad.stdout.split("\n").filter(Boolean).sort(), paths([...kept, ...dropped]));
  // The filter itself failing (here made to throw by a preload): the whole list and exit 2, never a shortened list.
  const preload = join(dir, "break-filter.cjs");
  write(preload, 'String.prototype.split = function () { throw new Error("filter broken"); };\n');
  const broken = run({ NODE_OPTIONS: `--require ${preload}` });
  assert.equal(broken.status, 2);
  assert.deepEqual(broken.stdout.split("\n").filter(Boolean).sort(), paths([...kept, ...dropped]));
});

test("local mode pins the clone's .git when it clones and refuses one put in its place; its git state too", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, renameSync, cpSync, rmSync, lstatSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pinGitDir, readGitPin, gitDirChanged, pinGitState, checkGitState, pinnedInode } = await import("../scripts/lib/local.mjs");
  const root = mkdtempSync(join(tmpdir(), "pin-"));
  const clone = join(root, "repo");
  const pin = join(root, ".sandbox", "git-id");
  mkdirSync(join(clone, ".git", "hooks"), { recursive: true });
  writeFileSync(join(clone, ".git", "config"), "[core]\n");
  pinGitDir(clone, pin);
  const id = readGitPin(pin);
  const st = lstatSync(join(clone, ".git"), { bigint: true });
  // Inode and birth time, never the device number (not stable across a restart).
  assert.equal(id, `${st.ino}:${st.birthtimeNs}`);
  assert.equal(pinnedInode(id), String(st.ino));
  assert.equal(gitDirChanged(clone, id, pin), "");
  assert.equal(gitDirChanged(clone, `${st.ino}:0`, pin), "", "a filesystem that keeps no birth time: the inode alone");
  assert.match(gitDirChanged(clone, `${st.ino}:1`, pin), /it was replaced/, "a freed inode handed to a new directory");
  assert.match(gitDirChanged(clone, null, pin), /no pinned \.git identity/);
  pinGitState(clone);
  assert.equal(checkGitState(clone), "");
  writeFileSync(join(clone, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
  assert.match(checkGitState(clone), /changed since Pendulum set them up/);
  // Copied, edited and swapped in: same content does not make it the same directory.
  cpSync(join(clone, ".git"), join(clone, ".git-new"), { recursive: true });
  renameSync(join(clone, ".git"), join(clone, ".git-old"));
  renameSync(join(clone, ".git-new"), join(clone, ".git"));
  assert.match(gitDirChanged(clone, id, pin), /not the directory Pendulum cloned/);
  rmSync(root, { recursive: true, force: true });
});

test("the outer sandbox: host sockets unreadable, the harness's settings, MCP config and install read-only, Copilot's policy file included", async () => {
  const { harnessOuterSettings, harnessHomeGuards, hostSockets } = await import("../scripts/lib/local.mjs");
  const s = harnessOuterSettings({ harness: "claude", writable: ["/c"], clone: "/c", home: "/h", env: { SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1" } });
  const covered = (list, p) => list.some((q) => p === q || p.startsWith(`${q}/`));
  for (const p of [`/run/user/${process.getuid()}`, "/run/dbus", "/var/run/docker.sock", "/tmp/ssh-x", "/run/WSL", "/mnt/wslg", "/run/snapd.socket", "/run/snapd-snap.socket", "/tmp/.X11-unix"]) assert.ok(covered(s.filesystem.denyRead, p), p);
  assert.deepEqual(s.filesystem.denyRead.filter((p) => s.filesystem.denyRead.some((q) => q !== p && p.startsWith(`${q}/`))), [], "one entry per tree");
  assert.ok(hostSockets({}, 1000, { roots: [], bound: () => [] }).includes("/run/user/1000"));
  for (const p of harnessHomeGuards("claude", {}, "/h")) assert.ok(s.filesystem.denyWrite.includes(p), p);
  assert.ok(s.filesystem.denyWrite.includes("/h/.claude.json") && !s.filesystem.allowWrite.includes("/h/.claude.json"), "its MCP servers live there");
  const x = harnessOuterSettings({ harness: "codex", writable: ["/c"], clone: "/c", home: "/h", env: {}, install: ["/h/.codex/packages/standalone"] });
  for (const p of ["/h/.codex/config.toml", "/h/.codex/hooks.json", "/h/.codex/packages", "/h/.codex/packages/standalone", "/h/.codex/memories", "/h/.codex/instructions.md"]) assert.ok(x.filesystem.denyWrite.includes(p), p);
  // Copilot: its home's settings.json is its sandbox's policy; read-only like the others' settings, its sessions writable.
  const guards = harnessHomeGuards("copilot", { COPILOT_HOME: "/u/c" }, "/h");
  for (const p of ["/u/c/settings.json", "/u/c/config.json", "/u/c/mcp-config.json", "/u/c/hooks"]) assert.ok(guards.includes(p), p);
  const c = harnessOuterSettings({ harness: "copilot", writable: ["/c"], clone: "/c", home: "/h", env: { COPILOT_HOME: "/u/c" } });
  for (const p of guards) assert.ok(c.filesystem.denyWrite.includes(p) && !c.filesystem.allowWrite.includes(p), p);
  assert.ok(c.filesystem.allowWrite.includes("/u/c"), "its sessions, which a later stage resumes");
  assert.deepEqual(harnessHomeGuards("copilot", {}, "/h"), [], "no Copilot home of Pendulum's: nothing in the developer's own ~/.copilot is made or guarded");
  // Copilot's binary unpacks the release it runs into its cache home: only its sandboxed --version may write there.
  const { versionSettings, copilotCacheHome } = await import("../scripts/lib/local.mjs");
  assert.equal(copilotCacheHome({}, "/h", "linux"), "/h/.cache/copilot");
  assert.equal(copilotCacheHome({ XDG_CACHE_HOME: "/x" }, "/h", "linux"), "/x/copilot");
  assert.equal(copilotCacheHome({}, "/h", "darwin"), "/h/Library/Caches/copilot");
  assert.deepEqual(versionSettings("copilot", {}, "/h").filesystem.allowWrite, [copilotCacheHome({}, "/h")]);
  assert.deepEqual(versionSettings("codex", {}, "/h").filesystem.allowWrite, []);
  assert.ok(!c.filesystem.allowWrite.some((p) => "/h/.cache/copilot/pkg".startsWith(p)), "read-only in its outer sandbox");
  assert.ok(guards.includes("/u/c/pkg"), "a release in its home would run too");
});

test("local Copilot runs only inside the outer sandbox: serve refuses a host where it does not start, and a stage that finds it off Blocks", async () => {
  const { preflight, copilotOuterReason, Local } = await import("../scripts/local.mjs");
  const refused = (problems) => problems.filter((p) => /runs Copilot only inside the outer sandbox/.test(p));
  let calls = 0;
  const off = preflight("copilot", "o/r", "t", "c", { outer: (h) => (calls++, assert.equal(h, "copilot"), { on: false, why: "no /dev/net/tun" }) });
  // Probed where it can start at all (srt, bubblewrap and copilot here, or off Linux); then refused with the probe's reason.
  assert.equal(refused(off).length, calls);
  if (calls) assert.match(refused(off)[0], /: no \/dev\/net\/tun; use PENDULUM_HARNESS=claude or codex/);
  assert.deepEqual(refused(preflight("copilot", "o/r", "t", "c", { outer: () => ({ on: true, why: "" }) })), [], "where it starts, Copilot runs");
  for (const h of ["claude", "codex"]) assert.deepEqual(refused(preflight(h, "o/r", "t", "", { outer: () => assert.fail("only Copilot needs it at serve") })), []);
  // A stage that finds it off (a version probed again after serve began): Blocked with fixed text, nothing started.
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pinGitDir, gitPinFile } = await import("../scripts/lib/local.mjs");
  const dev = mkdtempSync(join(tmpdir(), "blk-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "copilot", stopping: false, firstSetup: new Map(), children: new Set() });
  mkdirSync(join(local.ws(8), "repo", ".git"), { recursive: true });
  pinGitDir(join(local.ws(8), "repo"), gitPinFile(local.ws(8)));
  const blocked = [];
  local.block = async (...a) => blocked.push(a);
  // The Objective's labels choose nothing: the loop's own harness.
  local.harnessFor = async () => ({ ok: true, harness: "copilot" });
  local.stageEnv = () => {
    throw Object.assign(new Error("local mode runs Copilot only inside the outer sandbox, which does not start on this host: slirp4netns did not configure its interface: x"), { code: "outer-sandbox" });
  };
  const r = await local.stage(8, "work", "worker.mjs", []);
  assert.equal(r.exit, "blocked");
  assert.deepEqual(blocked, [[8, "work", copilotOuterReason]]);
  assert.doesNotMatch(copilotOuterReason, /slirp4netns|\/home|\/tmp|\n/, "no probe output or local path reaches GitHub");
  // The sandboxes' scan failing its check as the stage starts (#154): Blocked with its own fixed text, cause setup (block()).
  const { sandboxScanReason } = await import("../scripts/local.mjs");
  blocked.length = 0;
  local.stageEnv = () => {
    throw Object.assign(new Error("the sandbox's scan for protected paths does not work here: rg: /home/x/bin/rg failed"), { code: "sandbox-scan" });
  };
  assert.equal((await local.stage(8, "work", "worker.mjs", [])).exit, "blocked");
  assert.deepEqual(blocked, [[8, "work", sandboxScanReason]]);
  assert.doesNotMatch(sandboxScanReason, /\/home|\/tmp|\n/, "no local path reaches GitHub");
  local.stageEnv = () => {
    throw new Error("other");
  };
  await assert.rejects(local.stage(8, "work", "worker.mjs", []), /other/, "any other failure is not turned into a Block");
  rmSync(dev, { recursive: true, force: true });
});

test("a clone's .git/info/attributes: made empty and read-only everywhere; pin, pre-start clear and check agree, a change refuses with a fixed reason", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { GitRefusal, checkGitState, claudeLocalSettings, clearHarnessConfig, codexLocalConfig, gitGuards, pinGitState, prepareProtectedPaths, refusalExit, srtSettings } = await import("../scripts/lib/local.mjs");
  const root = mkdtempSync(join(tmpdir(), "attr-"));
  const clone = join(root, "repo");
  execFileSync("git", ["init", "-q", clone]);
  execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]);
  const attr = join(clone, ".git", "info", "attributes");
  prepareProtectedPaths(clone);
  assert.equal(readFileSync(attr, "utf8"), "", "a real, empty file the sandboxes protect");
  assert.ok(gitGuards(clone).includes(attr));
  assert.ok(claudeLocalSettings({ clone, home: "/h" }).sandbox.filesystem.denyWrite.includes(attr) && srtSettings({ clone, home: "/h" }).filesystem.denyWrite.includes(attr));
  assert.ok(codexLocalConfig({ clone, home: "/h" }).some((c) => c.includes(`${JSON.stringify(attr)}="read"`)));
  // As a stage runs them: pin after Pendulum's git setup, then the pre-start clear before each harness start, then the check.
  const run = (inner) => exec(inner[0], inner.slice(1));
  pinGitState(clone);
  await clearHarnessConfig(clone, run);
  assert.equal(checkGitState(clone), "", "the clear changes nothing the pin recorded");
  rmSync(attr);
  await clearHarnessConfig(clone, run);
  assert.equal(checkGitState(clone), "", "absent and remade empty say the same to git");
  writeFileSync(attr, "* filter=x\n");
  await clearHarnessConfig(clone, run);
  assert.match(checkGitState(clone), /info\/attributes changed/);
  // The stage Blocks on a refusal with fixed text, never the local path or command output.
  const r = refusalExit(new GitRefusal("git-state", `${clone} changed`), { stage: "work", issue: 5, env: {} });
  assert.doesNotMatch(r.reason, /\/tmp|\/home/);
  assert.match(r.reason, /git-state/);
  assert.equal(r.key, undefined, "a git-state Block is per run");
  const g = refusalExit(new GitRefusal("git-identity", "x"), { stage: "work", issue: 5, env: { PENDULUM_LOCAL_SANDBOX: JSON.stringify({ gitId: "1:2" }) } });
  assert.match(g.reason, /\.pendulum\/5/);
  assert.match(g.key, /^git-identity:work:/);
  assert.match(refusalExit(new GitRefusal("git-clear", "y"), { stage: "review", issue: 5, env: {} }).reason, /git-clear/);
  assert.equal(refusalExit(new Error("other"), { stage: "work", issue: 5 }), null, "any other error is still a crash");
  rmSync(root, { recursive: true, force: true });
});

test("a stage's start removes the git locks an interrupted run left, and leaves one a live process holds", { skip: !existsSync("/proc/self/fd") && "needs /proc" }, async () => {
  const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync, spawn } = await import("node:child_process");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { prepareClone, staleGitLocks } = await import("../scripts/lib/local.mjs");
  const root = mkdtempSync(join(tmpdir(), "locks-"));
  const clone = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  writeFileSync(join(clone, "app.txt"), "v1\n");
  git("add", ".");
  git("commit", "-q", "-m", "i");
  const run = (inner) => exec(inner[0], inner.slice(1));
  const plant = () => {
    for (const l of ["config.lock", "refs/heads/main.lock"]) writeFileSync(join(clone, ".git", l), "");
  };
  const start = async () => (await prepareClone(clone, [], run, { fresh: true, locks: staleGitLocks(clone).stale })).locks.sort();
  plant();
  assert.throws(() => git("config", "pendulum.x", "1"), "the planted lock stops git");
  // A live holder: a process with the lock open. Both locks stay (the holder may be mid-way through a ref update too).
  const holder = spawn(process.execPath, ["-e", "require('fs').openSync(process.argv[1], 'r'); process.stdout.write('ok'); setInterval(() => {}, 1e3)", join(clone, ".git", "config.lock")], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((ok) => holder.stdout.once("data", ok));
    assert.deepEqual(await start(), []);
    assert.deepEqual(staleGitLocks(clone).live.sort(), [".git/config.lock", ".git/refs/heads/main.lock"]);
  } finally {
    holder.kill();
    await new Promise((ok) => holder.once("exit", ok));
  }
  // The holder is gone: the next start removes both, and git works again.
  assert.deepEqual(await start(), [".git/config.lock", ".git/refs/heads/main.lock"]);
  git("config", "pendulum.x", "1");
  git("commit", "-q", "--allow-empty", "-m", "after");
  // A lock older than the box's last boot has no holder, whatever /proc says.
  plant();
  for (const l of ["config.lock", "refs/heads/main.lock"]) utimesSync(join(clone, ".git", l), new Date(0), new Date(0));
  assert.deepEqual(staleGitLocks(clone, { proc: join(root, "no-proc") }).stale.sort(), [".git/config.lock", ".git/refs/heads/main.lock"]);
  assert.deepEqual(staleGitLocks(join(root, "absent")), { stale: [], live: [] });
  rmSync(root, { recursive: true, force: true });
});

// #418: any label text is a Claude model id now, so the pinned agent file holds it as one quoted scalar.
test("pinModel writes a label's model id into an agent file as one YAML scalar, whatever its text", async () => {
  const { agentDefinition, pinModel } = await import("../scripts/lib/checkout.mjs");
  const text = "---\nname: implementer\ndescription: \"Does one item.\"\ntools: Read\nmodel: claude-sonnet-5-5\n---\n\nDo the item.\n";
  for (const model of ["a #x", "{a: b}", "claude-sonnet-5-5[1m]", "x\": y"]) {
    for (const harness of ["claude", "copilot"]) assert.equal(agentDefinition(pinModel(text, harness, model), "x").definition.model, model, `${harness}: ${model}`);
  }
});
