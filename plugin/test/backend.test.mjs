import "./temp.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { BACKENDS, backend } from "../scripts/lib/backend.mjs";
import { setSelf, trustedAuthor } from "../scripts/lib/logic.mjs";

const issue = (...labels) => ({ labels: labels.map((name) => ({ name })) });

test("backend: FACTORY_LOCAL=1 picks local, anything else the Action's runner", () => {
  assert.equal(backend({ FACTORY_LOCAL: "1" }).name, "local");
  assert.equal(backend({}).name, "actions");
  assert.equal(backend({ FACTORY_LOCAL_SANDBOX: "{}" }).name, "local", "sandbox settings alone still mean local");
});

test("deniedFix: a local Block on denied hosts gets the FACTORY_LOCAL_DOMAINS fix, a runner's (Claude's sandbox) the allowed_domains input", () => {
  const env = { FACTORY_LOCAL_SANDBOX: JSON.stringify({ domains: ["github.com", "extra.example.com"] }) };
  assert.match(BACKENDS.actions.sandbox.deniedFix(["cdn.example.org"], {}, "claude"), /^The harness's sandbox denied `cdn\.example\.org`\. .*`allowed_domains` input.*re-apply `factory:objective`\.$/);
  assert.equal(BACKENDS.actions.sandbox.deniedFix(["cdn.example.org", "registry.npmjs.org"], { FACTORY_INPUT_ALLOWED_DOMAINS: "*.example.org" }, "claude"), null, "allowed already, by the input or by default");
  assert.match(BACKENDS.local.sandbox.deniedFix(["cdn.example.org", "extra.example.com"], env), /^The local sandbox denied `cdn\.example\.org`\. .*FACTORY_LOCAL_DOMAINS.*re-apply `factory:objective`\.$/);
  assert.equal(BACKENDS.local.sandbox.deniedFix(["github.com"], env), null, "an allowed host is no allow-list fix");
  assert.match(BACKENDS.local.sandbox.deniedFix(["cdn.example.org"], { FACTORY_LOCAL_SANDBOX: "{not json" }), /cdn\.example\.org/, "unreadable settings never fail the notice");
});

test("trigger: the Action takes unlabelled Objectives, a local loop the factory:local ones (or all with FACTORY_LOCAL_ALL)", () => {
  assert.equal(BACKENDS.actions.trigger.routes(issue("factory:objective")), true);
  assert.equal(BACKENDS.actions.trigger.routes(issue("factory:objective", "factory:local")), false);
  assert.equal(BACKENDS.local.trigger.routes(issue("factory:objective"), {}), false);
  assert.equal(BACKENDS.local.trigger.routes(issue("factory:objective", "factory:local"), {}), true);
  assert.equal(BACKENDS.local.trigger.routes(issue("factory:objective"), { FACTORY_LOCAL_ALL: "1" }), true);
});

test("sandbox and gate: local wraps Factory's commands in srt (and factory-db for validation), notes TMPDIR, runs commands first", async () => {
  const inner = ["bash", "-eo", "pipefail", "-c", "npm test"];
  assert.deepEqual(BACKENDS.actions.sandbox.command(inner, {}), ["bash", ["-eo", "pipefail", "-c", "npm test"]]);
  const env = { FACTORY_LOCAL: "1", FACTORY_LOCAL_SRT: "/s.json", FACTORY_LOCAL_DB: "1", FACTORY_DB_WRAP: "1", FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], clone: null }) };
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, env), ["srt", ["-s", "/s.json", "--", "factory-db", ...inner]]);
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, { ...env, FACTORY_DB_WRAP: "" }), ["srt", ["-s", "/s.json", "--", ...inner]]);
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, { ...env, TMPDIR: "/tmp/factory-7-ab" }), ["srt", ["-s", "/s.json", "--", "env", "TMPDIR=/tmp/factory-7-ab", "factory-db", ...inner]]);
  assert.equal(BACKENDS.actions.sandbox.harness({ FACTORY_LOCAL_SANDBOX: "{}" }), null);
  assert.throws(() => BACKENDS.local.sandbox.harness({ FACTORY_LOCAL: "1" }), /unsandboxed/);
  assert.equal(BACKENDS.actions.sandbox.cardNotes(), "");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "copilot"), /\$TMPDIR[\s\S]*`deniedHosts`[\s\S]*outside your sandbox/, "Copilot's sandbox on a runner: Codex's notes");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "codex"), /\$TMPDIR[\s\S]*`deniedHosts`/, "Codex's sandbox on a runner: local mode's notes");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "claude"), /\$TMPDIR[\s\S]*`deniedHosts`/, "Claude Code's sandbox on a runner: local mode's notes");
  assert.doesNotMatch(BACKENDS.actions.sandbox.cardNotes({}, "claude"), /localhost|service/i, "no service offered: nothing said about services");
  assert.match(BACKENDS.actions.sandbox.cardNotes({}, "claude", [5432, 6379]), /reachable from your commands at `localhost:5432`, `localhost:6379`\./, "the ports actually offered");
  assert.match(BACKENDS.local.sandbox.cardNotes({}), /\$TMPDIR/);
  assert.doesNotMatch(BACKENDS.local.sandbox.cardNotes({}), /factory-db/);
  assert.match(BACKENDS.local.sandbox.cardNotes({ FACTORY_LOCAL_DB: "1" }), /factory-db npm run test:db/);
  assert.match(BACKENDS.local.sandbox.cardNotes({}), /`deniedHosts`/);
  assert.deepEqual([BACKENDS.actions.gate.commandsFirst, BACKENDS.local.gate.commandsFirst], [false, true]);
  assert.equal(await BACKENDS.local.trigger.stepsAside(), false);
});

test("trustedAuthor: Factory acts on a marker only from its own login or someone who can push, never another App", () => {
  setSelf(null);
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "clockgrove-factory[bot]" }, author_association: "NONE" }), false, "Factory's login unknown: no App counts");
  setSelf("clockgrove-factory[bot]");
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "Clockgrove-Factory[bot]" }, author_association: "NONE" }), true);
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "github-actions[bot]" }, author_association: "NONE" }), false, "the job token's comments forge nothing");
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "other-app[bot]" }, author_association: "NONE" }), false);
  setSelf(null);
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(trustedAuthor({ user: { type: "User" }, author_association: a }), true);
  for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", undefined]) assert.equal(trustedAuthor({ user: { type: "User" }, author_association: a }), false);
});

test("whichSync: a PATH scan, never a shell; names with separators or shell syntax resolve to nothing", async () => {
  const { whichSync } = await import("../scripts/lib/proc.mjs");
  assert.ok(whichSync("node"));
  for (const bad of ["node;touch /tmp/factory-which-probe", "$(id)", "../node", "/usr/bin/node", ""]) assert.equal(whichSync(bad), null);
});

test("spend lines: a local run's dollars round-trip through its progress comment; prose and junk count 0", async () => {
  const { spendMarker, spendOf } = await import("../scripts/lib/logic.mjs");
  const body = `<!-- factory:7:progress:work:1 -->\nFactory work run 1\n- 01:00Z exit: delivered; usd 0.34\n${spendMarker(0.3392)}`;
  assert.equal(spendOf(body), 0.3392);
  assert.equal(spendOf("- 01:00Z exit: delivered; usd 0.34"), 0, "the prose exit line is never read");
  assert.equal(spendOf('<!-- factory:spend {"usd":"x"} -->'), 0);
  assert.equal(spendOf('<!-- factory:spend {"usd":-5} -->'), 0);
});

test("Factory's git on the agent's checkout: locally always in srt's git profile, never on the host", () => {
  const inner = ["git", "-C", "/c", "checkout", "-B", "factory/1"];
  assert.throws(() => BACKENDS.local.sandbox.git(inner, { FACTORY_LOCAL: "1" }), /unsandboxed/);
  assert.deepEqual(BACKENDS.local.sandbox.git(inner, { FACTORY_LOCAL_SRT_GIT: "/g.json", TMPDIR: "/t" }), ["srt", ["-s", "/g.json", "--", "env", "TMPDIR=/t", ...inner]]);
});

test("agent uid: its commands run in a confined systemd unit with an allowlisted env, values never on the command line", async () => {
  const { asAgent, setAgent, sudoEnv } = await import("../scripts/lib/proc.mjs");
  setAgent({ user: "factory-agent", home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set(["DATABASE_URL"]) });
  try {
    const env = { PATH: "/opt/tool/bin:/usr/bin", LANG: "C", CI: "true", DATABASE_URL: "postgres://x", FACTORY_OUT: "/o", ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghs_job", FACTORY_INPUT_APP_PRIVATE_KEY: "pem", ACTIONS_RUNTIME_TOKEN: "rt", RANDOM_RUNNER_VAR: "x" };
    const [cmd, args, out] = asAgent("bash", ["-c", "true"], env, [], "/home/factory-agent/repo");
    assert.equal(cmd, "/usr/bin/sudo");
    assert.deepEqual(args.slice(0, 3), ["-n", "--preserve-env=LANG,CI,DATABASE_URL,FACTORY_OUT", "/usr/bin/systemd-run"]);
    for (const p of ["--uid=factory-agent", "--gid=factory-agent", "--pipe", "--wait", "--collect", "--working-directory=/home/factory-agent/repo", "--property=ProtectSystem=strict", "--property=ProtectHome=tmpfs", "--property=BindPaths=/home/factory-agent", "--property=ReadWritePaths=/home/factory-agent", "--property=PrivateTmp=yes", "--property=ReadOnlyPaths=/run", "--property=TemporaryFileSystem=/dev/shm:mode=1777 /run/lock:mode=1777", "--property=PrivateIPC=yes", "--property=NoNewPrivileges=yes", "--property=KillMode=control-group", "--setenv=DATABASE_URL", "--setenv=TMPDIR=/home/factory-agent/tmp", "--setenv=HOME=/home/factory-agent"]) assert.ok(args.includes(p), p);
    assert.deepEqual(args.slice(args.indexOf("--")), ["--", "/usr/bin/env", "bash", "-c", "true"]);
    assert.deepEqual(out, { LANG: "C", CI: "true", DATABASE_URL: "postgres://x", FACTORY_OUT: "/o" });
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
  const { files, helper } = readTokenFiles("/home/factory-agent", "ghs_read");
  assert.equal(files[".factory/read-token"], "ghs_read\n");
  assert.match(files[".gitconfig"], /^\[credential\]\n\thelper =\n\[credential "https:\/\/github\.com"\]\n\thelper = "!f\(\) \{ echo username=x-access-token; echo \\"password=\$\(cat \/home\/factory-agent\/\.factory\/read-token\)\\"; \}; f"\n$/);
  assert.match(files[".config/gh/hosts.yml"], /oauth_token: ghs_read/);
  assert.match(helper, /cat \/home\/factory-agent\/\.factory\/read-token/);
});

test("a local Copilot run is given the stage's own temp directory, never the host's /tmp", async () => {
  const { copilotTmpdir } = await import("../scripts/lib/local.mjs");
  const local = { addDirs: ["/home/u/.cache/factory/pnpm", "/home/u/.cache/factory/s/stage-1"] };
  assert.equal(copilotTmpdir(local, { TMPDIR: "/home/u/.cache/factory/s/stage-1" }), "/home/u/.cache/factory/s/stage-1");
  assert.throws(() => copilotTmpdir(local, {}), /TMPDIR/, "unset: Copilot would open the host's /tmp");
  assert.throws(() => copilotTmpdir(local, { TMPDIR: "/tmp" }), /TMPDIR/);
});

test("local notices: the App's key only from under ~/.config/factory (its real path), both settings or neither", async () => {
  const { chmodSync, linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localApp } = await import("../scripts/lib/local.mjs");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "factory-home-")));
  try {
    mkdirSync(join(home, ".config", "factory", "github-app"), { recursive: true });
    const key = join(home, ".config", "factory", "github-app", "app.pem");
    writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n", { mode: 0o600 });
    writeFileSync(join(home, "elsewhere.pem"), "secret-text");
    symlinkSync(join(home, "elsewhere.pem"), join(home, ".config", "factory", "link.pem"));
    assert.deepEqual(localApp({}, home), { app: null });
    assert.deepEqual(localApp({ FACTORY_LOCAL_APP_ID: "5", FACTORY_LOCAL_APP_KEY: "~/.config/factory/github-app/app.pem" }, home).app, { id: "5", key: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n" });
    assert.match(localApp({ FACTORY_LOCAL_APP_ID: "5" }, home).problem, /both/);
    assert.match(localApp({ FACTORY_LOCAL_APP_ID: "x", FACTORY_LOCAL_APP_KEY: key }, home).problem, /numeric/);
    assert.match(localApp({ FACTORY_LOCAL_APP_ID: "5", FACTORY_LOCAL_APP_KEY: join(home, "nope.pem") }, home).problem, /no file/);
    for (const p of [join(home, "elsewhere.pem"), join(home, ".config", "factory", "link.pem")]) {
      const r = localApp({ FACTORY_LOCAL_APP_ID: "5", FACTORY_LOCAL_APP_KEY: p }, home);
      assert.match(r.problem, /no sandbox can read/);
      assert.ok(!r.problem.includes("secret-text"), "the key's text is never in a message");
    }
    const ok = { FACTORY_LOCAL_APP_ID: "5", FACTORY_LOCAL_APP_KEY: key };
    chmodSync(key, 0o640);
    assert.match(localApp(ok, home).problem, /chmod 600/, "group or world bits");
    chmodSync(key, 0o600);
    linkSync(key, join(home, "second-link.pem"));
    assert.match(localApp(ok, home).problem, /hard links/, "a second hard link reaches the key outside ~/.config/factory");
    rmSync(join(home, "second-link.pem"));
    assert.ok(localApp(ok, home).app);
    assert.ok(localApp(ok, home, "claude").app, "the default harness homes hold no ~/.config/factory");
    assert.match(localApp({ ...ok, CLAUDE_CONFIG_DIR: join(home, ".config") }, home, "claude").problem, /harness's home/, "a harness home the outer sandbox reads holds the key");
    assert.match(localApp({ ...ok, CODEX_HOME: join(home, ".config", "factory") }, home, "codex").problem, /harness's home/);
    // ~/.config/factory itself a symlink: the sandboxes deny the literal path, not where it points.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "factory-home-")));
    mkdirSync(join(other, ".config"), { recursive: true });
    symlinkSync(join(home, ".config", "factory"), join(other, ".config", "factory"));
    assert.match(localApp({ FACTORY_LOCAL_APP_ID: "5", FACTORY_LOCAL_APP_KEY: join(other, ".config", "factory", "github-app", "app.pem") }, other).problem, /not a symlink/);
    rmSync(other, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor: a local run whose login is the notify user WARNs unless the App posts the notices", async () => {
  const { noticeChecks } = await import("../scripts/doctor.mjs");
  const inputs = { notify: "Op" };
  assert.deepEqual(noticeChecks({ inputs, notice: false, local: true, self: "op" }).map((c) => c.status), ["WARN"]);
  assert.match(noticeChecks({ inputs, notice: false, local: true, self: "op" })[0].fix, /FACTORY_LOCAL_APP_ID/);
  assert.deepEqual(noticeChecks({ inputs, notice: true, local: true, self: "op" }).map((c) => c.status), ["PASS"]);
  assert.deepEqual(noticeChecks({ inputs, notice: false, local: true, self: "someone-else" }), []);
  assert.deepEqual(noticeChecks({ inputs, notice: false, local: false, self: "op" }), [], "on Actions the App posts everything");
  assert.deepEqual(noticeChecks({ inputs: { notify: "" }, notice: false, local: true, self: "op" }), []);
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
  assert.deepEqual(r.first, { token: "ghs_notice" });
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

test("doctor: a local run of a repository that uses Postgres WARNs with FACTORY_LOCAL_DB=1 until the database is provided (#2601)", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localDatabaseChecks, repositoryChecks } = await import("../scripts/doctor.mjs");
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const repo = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "factory-dbrepo-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    return dir;
  };
  // The scratch adopter's shape (#324): a pg dependency, a database suite in the validation, no FACTORY_LOCAL_DB.
  const factoryYml = "env:\n  FACTORY_VALIDATION: npm run check, npm test, npm run test:db\n";
  const scratch = repo({ "package.json": JSON.stringify({ scripts: { test: "x" }, dependencies: { pg: "^8" } }), ".github/workflows/factory.yml": factoryYml });
  const [w] = localDatabaseChecks({ checkout: scratch, env: {}, os: "linux" });
  assert.equal(w.status, "WARN");
  assert.match(w.detail, /package\.json depends on pg/);
  assert.match(w.fix, /FACTORY_LOCAL_DB=1/);
  assert.doesNotMatch(localDatabaseChecks({ checkout: scratch, env: {}, os: "darwin" })[0].fix, /set FACTORY_LOCAL_DB=1/, "macOS has no local database to offer");
  assert.equal(localDatabaseChecks({ checkout: scratch, env: { FACTORY_LOCAL_DB: "1" } })[0].status, "PASS");
  assert.equal(localDatabaseChecks({ checkout: scratch, env: {}, wf: { FACTORY_LOCAL_DB: "1" } })[0].status, "PASS", "the workflow's setting counts");
  assert.equal(localDatabaseChecks({ checkout: scratch, env: { FACTORY_LOCAL_DB: "" }, wf: { FACTORY_LOCAL_DB: "1" } })[0].status, "WARN", "the shell wins, as in the local loop");
  // A trimmed FACTORY_LOCAL_VALIDATION still WARNs and names what still runs locally: only the owner knows if one needs Postgres.
  const trimmed = localDatabaseChecks({ checkout: scratch, env: { FACTORY_LOCAL_VALIDATION: "npm test, npm run test:db" }, os: "linux" });
  assert.equal(trimmed[0].status, "WARN", "the scratch case: test:db still runs in a sandbox with no database");
  assert.match(trimmed[0].detail, /still runs npm test, npm run test:db locally/);
  assert.match(trimmed[0].fix, /confirm none of those needs Postgres/);
  assert.equal(localDatabaseChecks({ checkout: scratch, env: { FACTORY_LOCAL_VALIDATION: "npm run check, parallel: npm test" } })[0].status, "WARN");
  // macOS refuses FACTORY_LOCAL_DB=1, so it is no PASS there.
  const mac = localDatabaseChecks({ checkout: scratch, env: {}, wf: { FACTORY_LOCAL_DB: "1" }, os: "darwin" });
  assert.equal(mac[0].status, "WARN");
  assert.match(mac[0].detail, /Linux and WSL2 only/);
  // A CI service container is a signal; Factory's own workflow and a non-Postgres service are not; nothing to say without one.
  const ci = "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    services:\n      db:\n        image: pgvector/pgvector:pg17\n      pg2:\n        image: bitnami/postgresql:16\n      cache:\n        image: redis:7\n    steps:\n      - run: npm test\n";
  const svc = repo({ "package.json": "{}", ".github/workflows/ci.yml": ci, ".github/workflows/factory.yml": `${factoryYml}jobs:\n  x:\n    services:\n      p:\n        image: postgres:17\n` });
  const [s] = localDatabaseChecks({ checkout: svc, env: {} });
  assert.equal(s.status, "WARN");
  assert.match(s.detail, /\.github\/workflows\/ci\.yml job test has a db service \(pgvector\)/);
  assert.match(s.detail, /has a pg2 service \(postgresql\)/);
  assert.doesNotMatch(s.detail, /factory\.yml|redis/);
  assert.deepEqual(localDatabaseChecks({ checkout: repo({ "package.json": JSON.stringify({ dependencies: { "pg-format": "1" } }) }), env: {} }), [], "only a client package counts");
  // Only the root and the declared workspaces count: a fixture package.json is not a package of this repository.
  const pg = JSON.stringify({ dependencies: { pg: "^8" } });
  const fixture = repo({ "package.json": "{}", "test/fixtures/app/package.json": pg });
  assert.deepEqual(localDatabaseChecks({ checkout: fixture, env: {} }), [], "a fixture is not a package");
  const npmWs = repo({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "packages/api/package.json": pg, "test/fixtures/x/package.json": pg });
  const [n] = localDatabaseChecks({ checkout: npmWs, env: {} });
  assert.match(n.detail, /packages\/api\/package\.json depends on pg/);
  assert.doesNotMatch(n.detail, /fixtures/);
  const pnpmWs = repo({ "package.json": "{}", "pnpm-workspace.yaml": "packages:\n  - 'apps/**'\n", "apps/web/server/package.json": pg });
  assert.match(localDatabaseChecks({ checkout: pnpmWs, env: {} })[0].detail, /apps\/web\/server\/package\.json depends on pg/);
  // Wired into the repository checks only when asked (doctor --local); never by default, so a worker job never scans the agent's clone.
  const inputs = resolveInputs({ env: { FACTORY_VALIDATION: "npm run test:db" } });
  assert.ok((await repositoryChecks({ inputs, checkout: scratch, env: {}, local: true })).some((c) => c.name === "local database" && c.status === "WARN"));
  assert.ok(!(await repositoryChecks({ inputs, checkout: scratch, env: {}, local: false })).some((c) => c.name === "local database"));
  assert.ok(!(await repositoryChecks({ inputs, checkout: scratch, env: {} })).some((c) => c.name === "local database"));
});

test("local notices: a failed App post is posted again with the local token; the key's extra reach is named", async () => {
  const { noticePost } = await import("../scripts/lib/session.mjs");
  const { noticeAppExtra } = await import("../scripts/lib/app-token.mjs");
  const { noticeAppCheck } = await import("../scripts/doctor.mjs");
  const tries = [];
  const post = async (o) => {
    tries.push(o.token);
    if (o.token === "app") throw new Error("HTTP 403");
    return "posted";
  };
  assert.equal(await noticePost({ notice: async () => ({ token: "app" }), token: "local", what: "t", post }), "posted");
  assert.deepEqual(tries, ["app", "local"], "the App's refused post is retried once with the local token");
  tries.length = 0;
  assert.equal(await noticePost({ notice: async () => Promise.reject(new Error("no channel")), token: "local", what: "t", post }), "posted");
  assert.deepEqual(tries, ["local"]);
  tries.length = 0;
  await noticePost({ notice: null, token: "local", what: "t", post });
  assert.deepEqual(tries, ["local"], "no App: the local token only");
  assert.deepEqual(noticeAppExtra({ issues: "write", metadata: "read" }), []);
  assert.deepEqual(noticeAppExtra({ issues: "write", metadata: "read", contents: "write", pull_requests: "write" }), ["contents:write", "pull_requests:write"]);
  assert.equal(noticeAppCheck({ appSlug: "a", installationPermissions: { issues: "write", metadata: "read" } }).status, "PASS");
  const wide = noticeAppCheck({ appSlug: "a", installationPermissions: { issues: "write", contents: "write" } });
  assert.equal(wide.status, "PASS", "Factory's own App is a supported choice: a note, not a warning");
  assert.match(wide.detail, /also has contents:write; the notice token is narrowed to issues write/);
});

test("a local harness loads no settings or hooks from the clone, and no sandbox may write the clone's harness configuration", async () => {
  const { harnessCommand } = await import("../scripts/lib/harness.mjs");
  const { HARNESS_CONFIG, claudeLocalSettings, copilotLocalSettings, srtSettings } = await import("../scripts/lib/local.mjs");
  const local = { addDirs: ["/s/tmp"], readDirs: ["/s/usage"], domains: [], clone: "/c", readOnly: ["/s/usage"], claudeDir: "/s/usage/claude" };
  const c = harnessCommand({ harness: "claude", prompt: "x", local });
  // Claude Code: flag settings only (no user, project or local source), hooks off, skills and agents from Factory's copy.
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
  // Factory's own git work (no clone in its profile) still writes the plugin's skills and agents there.
  assert.ok(!srtSettings({ home: "/h" }).filesystem.denyWrite.some((p) => p.startsWith("/c/")));
});

test("a local harness's own git never enters a submodule or runs an fsmonitor; package caches are no added directory", async () => {
  const { harnessCommand } = await import("../scripts/lib/harness.mjs");
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
  assert.deepEqual(harnessCommand({ harness: "codex", prompt: "x", local: null }).env, {}, "the Action's runner is unchanged");
});

test("a Claude agent file becomes an --agents entry with only its description, prompt, tools and model", async () => {
  const { agentDefinition } = await import("../scripts/lib/checkout.mjs");
  const text = "---\nname: implementer\ndescription: \"Does one item.\"\ntools: Read, Edit, Bash\nmodel: m1\npermissionMode: bypassPermissions\nhooks:\n  SessionStart:\n    - hooks:\n        - type: command\n          command: touch /x\nmcpServers:\n  evil:\n    command: sh\n---\n\nDo the item.\n";
  assert.deepEqual(agentDefinition(text, "fallback"), { name: "implementer", definition: { description: "Does one item.", prompt: "Do the item.", tools: ["Read", "Edit", "Bash"], model: "m1" } });
  assert.equal(agentDefinition("no front matter", "x"), null);
  assert.equal(agentDefinition("---\nname: ../x\ndescription: d\n---\nbody", "safe").name, "safe");
});

test("Linux: when srt's sandbox does not start, local mode says why and names AppArmor's two settings where they apply", async () => {
  const { sandboxStartProblems } = await import("../scripts/lib/local.mjs");
  const files = { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n", "/etc/apparmor.d/bwrap-userns-restrict": "" };
  const read = (f) => files[f] ?? "";
  const exists = (f) => f in files;
  assert.deepEqual(sandboxStartProblems({ start: () => ({ status: 0 }), read, exists }), [], "it starts: nothing to report");
  const failed = { status: 1, stderr: "apply-seccomp: write /proc/self/setgroups: Permission denied\n" };
  const both = sandboxStartProblems({ start: () => failed, read, exists });
  assert.equal(both.length, 3);
  assert.match(both[0], /does not start here \(apply-seccomp: write \/proc\/self\/setgroups: Permission denied\)/);
  assert.match(both[1], /apparmor_restrict_unprivileged_userns=0/);
  assert.match(both[2], /apparmor_parser -R \/etc\/apparmor\.d\/bwrap-userns-restrict/);
  assert.deepEqual(sandboxStartProblems({ start: () => failed, read: () => "", exists: () => false }).length, 1, "no AppArmor (WSL2): the failure alone");
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
  assert.match(gitGuardScript("/usr/bin/git"), /FACTORY_GIT_ID[\s\S]*exit 128[\s\S]*exec "\/usr\/bin\/git" "\$@"/);
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
  assert.ok(s.filesystem.denyRead.includes("/h/.ssh") && s.filesystem.denyRead.includes("/h/.config/factory") && s.filesystem.denyRead.includes("/h/.claude/.credentials.json"));
  assert.equal(s.bwrapPath, undefined, "only Copilot's outer sandbox runs bwrap through Factory's wrapper");
  const c = harnessOuterSettings({ harness: "copilot", domains: ["registry.npmjs.org"], writable: ["/c"], clone: "/c", home: "/h", env: { COPILOT_HOME: "/u/copilot" }, bwrapPath: "/u/outer/bwrap" });
  assert.equal(c.bwrapPath, "/u/outer/bwrap");
  const copilotHosts = new Set(c.network.allowedDomains);
  assert.ok(copilotHosts.has("api.githubcopilot.com") && copilotHosts.has("registry.npmjs.org"));
  assert.ok(c.filesystem.allowWrite.includes("/u/copilot"));
});

test("Copilot's outer sandbox: bwrap gets the host's /dev/net/tun after srt's fresh /dev, once, and every other argument as given", async () => {
  const { writeBwrapTun } = await import("../scripts/lib/local.mjs");
  const { mkdtempSync, writeFileSync: write, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "factory-bwrap-"));
  // A stand-in for the real bwrap that prints each argument it is given on its own line.
  const fake = join(dir, "real-bwrap");
  write(fake, '#!/bin/sh\nfor a do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
  // /dev/null stands in for the host's TUN device: a character device every host has.
  const wrapper = writeBwrapTun(join(dir, "outer"), fake, "/dev/null");
  assert.equal(statSync(wrapper).mode & 0o777, 0o755);
  assert.equal(statSync(join(dir, "outer")).mode & 0o777, 0o700);
  const argv = (w, args) => {
    const r = spawnSync(w, args, { encoding: "utf8" });
    assert.equal(r.status, 0);
    return r.stdout.split("\n").slice(0, -1);
  };
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--", "sh", "-c", "echo 'a b'; echo --dev /dev"];
  assert.deepEqual(argv(wrapper, args), ["--ro-bind", "/", "/", "--dev", "/dev", "--dev-bind", "/dev/null", "/dev/net/tun", "--unshare-pid", "--proc", "/proc", "--", "sh", "-c", "echo 'a b'; echo --dev /dev"]);
  // srt's own probe (no --dev) passes through unchanged.
  assert.deepEqual(argv(wrapper, ["--unshare-user", "--dev-bind", "/", "/", "true"]), ["--unshare-user", "--dev-bind", "/", "/", "true"]);
  // The command's own arguments (after --) are never touched, even when they read "--dev /dev".
  assert.deepEqual(argv(wrapper, ["--unshare-pid", "--", "--dev", "/dev"]), ["--unshare-pid", "--", "--dev", "/dev"]);
  // A host without the device: every argument as given, so bubblewrap starts and outerProbe names the missing device.
  const none = writeBwrapTun(join(dir, "none"), fake, join(dir, "no-tun"));
  assert.deepEqual(argv(none, args), args);
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
  const { mkdtempSync, mkdirSync, writeFileSync: write, statSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync, spawn } = await import("node:child_process");
  const { join, dirname } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "factory-scan-"));
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
  for (const code of ["2", "7"]) {
    const bad = run({ CODE: code });
    assert.equal(bad.status, 2);
    assert.deepEqual(bad.stdout.split("\n").filter(Boolean).sort(), paths([...kept, ...dropped]));
  }
  // The filter itself failing (here made to throw by a preload): the whole list and exit 2, never a shortened list.
  const preload = join(dir, "break-filter.cjs");
  write(preload, 'String.prototype.split = function () { throw new Error("filter broken"); };\n');
  const broken = run({ NODE_OPTIONS: `--require ${preload}` });
  assert.equal(broken.status, 2);
  assert.deepEqual(broken.stdout.split("\n").filter(Boolean).sort(), paths([...kept, ...dropped]));
  // Killed mid-scan (the sandbox's timeout sends TERM): ripgrep goes too, and its whole lines so far go out unfiltered, exit 2.
  const child = spawn(scan, ["--files", r], { env: { ...process.env, SLEEP: "30" } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  setTimeout(() => child.kill("SIGTERM"), 1000);
  const t0 = Date.now();
  const code = await new Promise((done) => child.on("close", (c) => done(c)));
  assert.ok(Date.now() - t0 < 10_000, "the timeout bounds the scan: the sleeping ripgrep did not hold it open");
  assert.equal(code, 2);
  assert.deepEqual(out.split("\n").filter(Boolean).sort(), paths([...kept, ...dropped]));
  assert.ok(readFileSync(scan, "utf8").includes(`exec '${process.execPath}' `), "node by absolute path");
});

test("the sandboxes' scan (#154): a ripgrep shim works and never reads the scanned tree's tool versions; no node falls back to ripgrep unfiltered; rg is found absolute and never where a sandbox writes", async () => {
  const { nestedGitScanWrapper, ripgrepOnPath, writeNestedGitScan } = await import("../scripts/lib/local.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync: write, symlinkSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { join, dirname } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "factory-scan-"));
  // A version manager's binary: ripgrep only when called as `rg`, an error otherwise; and, like mise or asdf, it reads
  // `.tool-versions` from its working directory: one there names a ripgrep it lacks, so it fails with exit 1.
  const manager = join(dir, "manager");
  write(manager, `#!/bin/sh\n[ "$(basename "$0")" = rg ] || { echo "error: unexpected argument '$1'" >&2; exit 2; }\n[ -f .tool-versions ] && { echo "ripgrep@99.0.0 is not installed" >&2; exit 1; }\n${FAKE_RG.split("\n").slice(1).join("\n")}`, { mode: 0o755 });
  mkdirSync(join(dir, "shims"));
  symlinkSync(manager, join(dir, "shims", "rg"));
  // Its check runs the wrapper beside a `.tool-versions` of its own: it passes only because ripgrep never starts there.
  const scan = writeNestedGitScan(join(dir, "scan"), join(dir, "shims", "rg"));
  assert.ok(readFileSync(join(dir, "scan", "scan.cjs"), "utf8").includes(JSON.stringify(join(dir, "shims", "rg"))), "the PATH entry as found, never resolved");
  // The scanned tree (the clone, the sandbox's working directory) names a ripgrep the shim lacks: no effect.
  const clone = join(dir, "clone");
  for (const f of ["sub/.bashrc", "dep/.git/config", ".tool-versions"]) {
    mkdirSync(dirname(join(clone, f)), { recursive: true });
    write(join(clone, f), "ripgrep 99.0.0\n");
  }
  const r = spawnSync(scan, ["--files", clone], { cwd: clone, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter(Boolean).sort(), [join(clone, ".tool-versions"), join(clone, "sub", ".bashrc")]);
  // The manager itself (what resolving the link gives): the check fails and the stage Blocks with sandbox-scan.
  assert.throws(() => writeNestedGitScan(join(dir, "scan2"), manager), (e) => e.code === "sandbox-scan" && /does not work here/.test(e.message));
  // No rg at all, or a relative one.
  assert.throws(() => writeNestedGitScan(join(dir, "scan3"), null), (e) => e.code === "sandbox-scan");
  assert.throws(() => writeNestedGitScan(join(dir, "scan3"), "bin/rg"), (e) => e.code === "sandbox-scan");
  // The node it was written for gone (a version manager removed it mid-stage): the real ripgrep runs, unfiltered.
  const fake = join(dir, "real-rg");
  write(fake, FAKE_RG, { mode: 0o755 });
  write(scan, nestedGitScanWrapper(join(dir, "scan"), join(dir, "no-such-node"), join(dir, "scan", "scan.cjs"), fake), { mode: 0o755 });
  const raw = spawnSync(scan, ["--files", clone], { cwd: clone, encoding: "utf8" });
  assert.equal(raw.status, 0);
  assert.deepEqual(raw.stdout.split("\n").filter(Boolean).sort(), [join(clone, ".tool-versions"), join(clone, "dep", ".git", "config"), join(clone, "sub", ".bashrc")], "every name listed, nested .git included");
  // A relative PATH entry is taken from the given directory, as an absolute path; links not followed.
  mkdirSync(join(dir, "bin"));
  symlinkSync(fake, join(dir, "bin", "rg"));
  assert.equal(ripgrepOnPath({ PATH: "bin:/nonexistent" }, dir), join(dir, "bin", "rg"));
  assert.equal(ripgrepOnPath({ PATH: "/nonexistent" }, dir), null);
  // An rg in a directory a sandbox may write, or linked into one, is refused.
  mkdirSync(join(clone, "bin"));
  write(join(clone, "bin", "rg"), FAKE_RG, { mode: 0o755 });
  assert.throws(() => writeNestedGitScan(join(dir, "scan4"), join(clone, "bin", "rg"), { writable: [clone] }), (e) => e.code === "sandbox-scan" && /where a sandbox may write/.test(e.message));
  symlinkSync(join(clone, "bin", "rg"), join(dir, "bin", "rg2"));
  assert.throws(() => writeNestedGitScan(join(dir, "scan4"), join(dir, "bin", "rg2"), { writable: [clone] }), (e) => e.code === "sandbox-scan");
});

test("the sandboxes' scan (#154): srt, the outer sandbox and Claude Code (from the stage's FACTORY_LOCAL_SANDBOX) get it; the clone's git guards stay", async () => {
  const { claudeLocalSettings, gitGuards, harnessOuterSettings, localSandbox, srtSettings } = await import("../scripts/lib/local.mjs");
  const { harnessCommand } = await import("../scripts/lib/harness.mjs");
  const r = "/w/clone";
  const scan = "/w/.factory/1/usage/scan/rg";
  const srt = srtSettings({ clone: r, home: "/h", ripgrep: scan });
  assert.deepEqual(srt.ripgrep, { command: scan });
  const outer = harnessOuterSettings({ harness: "claude", clone: r, home: "/h", ripgrep: scan });
  assert.deepEqual(outer.ripgrep, { command: scan });
  const local = localSandbox({ FACTORY_LOCAL_SANDBOX: JSON.stringify({ clone: r, addDirs: [], domains: ["github.com"], readOnly: [], ripgrep: scan }) });
  const c = harnessCommand({ harness: "claude", prompt: "", local });
  const claude = JSON.parse(c.args[c.args.indexOf("--settings") + 1]);
  assert.deepEqual(claude.sandbox.ripgrep, { command: scan });
  for (const deny of [srt.filesystem.denyWrite, claude.sandbox.filesystem.denyWrite, outer.filesystem.denyWrite]) for (const g of gitGuards(r)) assert.ok(deny.includes(g), g);
  // Without it (macOS, a runner) each keeps its own scan.
  assert.equal(srtSettings({ clone: r, home: "/h" }).ripgrep, undefined);
  assert.equal(claudeLocalSettings({ clone: r, home: "/h" }).sandbox.ripgrep, undefined);
  assert.equal(harnessOuterSettings({ harness: "codex", clone: r, home: "/h" }).ripgrep, undefined);
});

test("Copilot's outer probe: names each missing tool its sandbox needs, and slirp4netns's own error when it fails", { skip: !existsSync("/dev/net/tun") && "no /dev/net/tun here" }, async () => {
  const { COPILOT_OUTER_PROBE } = await import("../scripts/lib/local.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync: write, symlinkSync, renameSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "factory-probe-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Real tools the probe text runs around the sandbox's own; each sandbox tool a stub, slirp4netns failing as it would.
  for (const t of ["sleep", "grep", "tail", "cat", "id"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim(), join(bin, t));
  const tools = ["slirp4netns", "nsenter", "unshare", "ip", "iptables", "ip6tables", "iptables-restore", "ip6tables-restore"];
  const stub = (t, body) => write(join(bin, t), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const t of tools) stub(t, t === "slirp4netns" ? "echo 'open(\"/dev/net/tun\"): Permission denied' >&2\nexit 1" : t === "unshare" ? "exit 0" : "exit 1");
  const run = () => spawnSync("/bin/sh", ["-c", COPILOT_OUTER_PROBE], { env: { PATH: bin, TMPDIR: dir }, encoding: "utf8", timeout: 30_000 });
  const r = run();
  assert.equal(r.status, 4);
  assert.equal(r.stderr.trim(), 'slirp4netns did not configure its interface: open("/dev/net/tun"): Permission denied', "one line, with the cause, for outerProbe's reason");
  for (const t of ["ip", "iptables", "ip6tables"]) {
    renameSync(join(bin, t), join(dir, t));
    const m = run();
    assert.equal(m.status, 3);
    assert.equal(m.stderr.trim(), `${t} is not on PATH`);
    renameSync(join(dir, t), join(bin, t));
  }
  // An unshare without --map-user (util-linux before 2.36) is named, not lost behind slirp4netns's error.
  stub("unshare", "case \"$*\" in *--map-user=*) echo 'unshare: unrecognized option' >&2; exit 1;; esac; exit 0");
  const u = run();
  assert.equal(u.status, 5);
  assert.match(u.stderr.trim(), /^unshare cannot make a user and network namespace mapping the user/);
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
  assert.match(checkGitState(clone), /changed since Factory set them up/);
  // Copied, edited and swapped in: same content does not make it the same directory.
  cpSync(join(clone, ".git"), join(clone, ".git-new"), { recursive: true });
  renameSync(join(clone, ".git"), join(clone, ".git-old"));
  renameSync(join(clone, ".git-new"), join(clone, ".git"));
  assert.match(gitDirChanged(clone, id, pin), /not the directory Factory cloned/);
  rmSync(root, { recursive: true, force: true });
});

test("a stage whose clone's .git is not the pinned one Blocks the Objective with a fixed reason, and starts nothing", async () => {
  const { mkdtempSync, mkdirSync, renameSync, cpSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pinGitDir, gitPinFile, gitIdentityReason } = await import("../scripts/lib/local.mjs");
  const { Local } = await import("../scripts/local.mjs");
  const dev = mkdtempSync(join(tmpdir(), "blk-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, stopping: false, firstSetup: new Map(), children: new Set() });
  const clone = join(local.ws(7), "repo");
  mkdirSync(join(clone, ".git"), { recursive: true });
  pinGitDir(clone, gitPinFile(local.ws(7)));
  cpSync(join(clone, ".git"), join(clone, ".git-new"), { recursive: true });
  renameSync(join(clone, ".git"), join(clone, ".git-old"));
  renameSync(join(clone, ".git-new"), join(clone, ".git"));
  const blocked = [];
  local.blockForClone = async (issue, name) => blocked.push([issue, name]);
  local.stageEnv = () => assert.fail("no stage env is built for a replaced .git");
  const r = await local.stage(7, "work", "worker.mjs", []);
  assert.equal(r.exit, "blocked");
  assert.deepEqual(blocked, [[7, "work"]]);
  assert.doesNotMatch(gitIdentityReason(7), /\/home|\/tmp|\/Users/, "no local path reaches GitHub");
  assert.match(gitIdentityReason(7), /\.factory\/7/);
  rmSync(dev, { recursive: true, force: true });
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
  assert.deepEqual(harnessHomeGuards("copilot", {}, "/h"), [], "no Copilot home of Factory's: nothing in the developer's own ~/.copilot is made or guarded");
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

test("macOS refuses FACTORY_LOCAL_DB=1 at start, set in the shell or in the workflow's env (#161)", async () => {
  const { preflight } = await import("../scripts/local.mjs");
  const refused = (o) => preflight("claude", "o/r", "t", "", o).filter((p) => /^FACTORY_LOCAL_DB runs on Linux and WSL2 only/.test(p));
  assert.equal(refused({ os: "darwin", env: { FACTORY_LOCAL_DB: "1" }, wf: {} }).length, 1, "from the shell");
  assert.equal(refused({ os: "darwin", env: {}, wf: { FACTORY_LOCAL_DB: "1" } }).length, 1, "from the workflow file");
  assert.equal(refused({ os: "darwin", env: { FACTORY_LOCAL_DB: "" }, wf: { FACTORY_LOCAL_DB: "1" } }).length, 0, "the shell wins, as in baseEnv");
  assert.equal(refused({ os: "darwin", env: {}, wf: {} }).length, 0, "off");
  assert.equal(refused({ os: "linux", env: {}, wf: { FACTORY_LOCAL_DB: "1" } }).length, 0, "Linux runs it");
});

test("local Copilot runs only inside the outer sandbox: serve refuses a host where it does not start, and a stage that finds it off Blocks", async () => {
  const { preflight, copilotOuterReason, Local } = await import("../scripts/local.mjs");
  const refused = (problems) => problems.filter((p) => /runs Copilot only inside the outer sandbox/.test(p));
  let calls = 0;
  const off = preflight("copilot", "o/r", "t", "c", { outer: (h) => (calls++, assert.equal(h, "copilot"), { on: false, why: "no /dev/net/tun" }) });
  // Probed where it can start at all (srt, bubblewrap and copilot here, or off Linux); then refused with the probe's reason.
  assert.equal(refused(off).length, calls);
  if (calls) assert.match(refused(off)[0], /: no \/dev\/net\/tun; use FACTORY_HARNESS=claude or codex/);
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

test("outerProbe keeps only a yes: a no is probed again, and an old no in the cache is dropped", { skip: process.platform !== "linux" }, async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { outerProbe } = await import("../scripts/lib/local.mjs");
  const t = mkdtempSync(join(tmpdir(), "op-"));
  const cacheFile = join(t, "outer-probe.json");
  writeFileSync(cacheFile, JSON.stringify({ k: { on: false, why: "old" }, other: { on: true, why: "" } }));
  let probes = 0;
  const opts = { cacheFile, home: t, keyOf: () => "k", probe: () => (probes++, { on: false, why: "slow box" }) };
  for (let i = 1; i <= 2; i++) {
    const r = outerProbe("copilot", opts);
    assert.equal(r.on, false);
    assert.equal(r.cached, undefined);
    assert.equal(r.cacheFile, cacheFile, "named, so a refusal can say where");
    assert.equal(probes, 2 * i, "probed each time, and a Copilot no once more");
  }
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(cacheFile, "utf8"))), ["other"], "no `on: false` entry is kept");
  const on = { ...opts, probe: () => (probes++, { on: true, why: "" }) };
  assert.equal(outerProbe("copilot", on).on, true);
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).k.on, true);
  const again = outerProbe("copilot", { ...opts, probe: () => assert.fail("a yes is read from the cache") });
  assert.equal(again.on, true);
  assert.equal(again.cached, true);
  rmSync(t, { recursive: true, force: true });
});

test("a Copilot outer probe that answers off once then on is on: one slow probe neither refuses serve nor Blocks a stage", { skip: process.platform !== "linux" }, async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { outerProbe } = await import("../scripts/lib/local.mjs");
  const t = mkdtempSync(join(tmpdir(), "op2-"));
  const cacheFile = join(t, "outer-probe.json");
  const answers = [{ on: false, why: "slirp4netns did not configure its interface: slow" }, { on: true, why: "" }];
  let probes = 0;
  const r = outerProbe("copilot", { cacheFile, home: t, keyOf: () => "k", probe: () => answers[probes++] });
  assert.equal(r.on, true, "the stage runs (stageEnv refuses Copilot only on an off answer)");
  assert.equal(probes, 2);
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).k.on, true, "the yes is kept");
  // Codex runs without it on a no (no Block): probed once, as before.
  let codex = 0;
  assert.equal(outerProbe("codex", { cacheFile, home: t, keyOf: () => "c", probe: () => (codex++, { on: false, why: "x" }) }).on, false);
  assert.equal(codex, 1);
  rmSync(t, { recursive: true, force: true });
});

test("serve's Copilot probe never gets the developer's own COPILOT_HOME", async () => {
  const { preflight } = await import("../scripts/local.mjs");
  const before = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = "/developer/copilot";
  try {
    const seen = [];
    preflight("copilot", "o/r", "t", "c", { outer: (h, o) => (seen.push(o?.env), { on: true, why: "" }) });
    for (const env of seen) {
      assert.equal(env.COPILOT_HOME, undefined);
      assert.equal(env.PATH, process.env.PATH, "the rest of the environment as it is");
    }
  } finally {
    if (before === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = before;
  }
});

test("a stage's Copilot home: a directory left under a file's name is replaced too", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Local } = await import("../scripts/local.mjs");
  const dev = mkdtempSync(join(tmpdir(), "ch-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "copilot", copilotToken: "c", domains: () => [] });
  const home = join(local.ws(9), ".sandbox", "copilot-home");
  for (const f of ["settings.json", "config.json", "mcp-config.json"]) mkdirSync(join(home, f, "x"), { recursive: true });
  const env = local.harnessEnv(9, [], join(dev, "clone"), join(dev, "usage"));
  assert.equal(env.COPILOT_HOME, home);
  for (const f of ["settings.json", "config.json", "mcp-config.json"]) assert.ok(statSync(join(home, f)).isFile(), f);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "mcp-config.json"), "utf8")), { mcpServers: {} });
  rmSync(dev, { recursive: true, force: true });
});

test("host sockets: one level under each root a socket or a directory holding one, and every bound socket, but the stage's own", async () => {
  const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const net = await import("node:net");
  const { hostSockets, boundSockets } = await import("../scripts/lib/local.mjs");
  const t = realpathSync(mkdtempSync(join(tmpdir(), "sk-")));
  const run = join(t, "run");
  for (const d of [join(run, "svc"), join(run, "deep", "a"), join(run, "plain"), join(t, "elsewhere"), join(t, "stage")]) mkdirSync(d, { recursive: true });
  const socks = [join(run, "top.sock"), join(run, "svc", "s.sock"), join(run, "deep", "a", "s.sock"), join(t, "elsewhere", "e.sock"), join(t, "stage", "mine.sock")];
  const servers = await Promise.all(socks.map((p) => new Promise((ok) => { const v = net.createServer().listen(p, () => ok(v)); })));
  try {
    const got = hostSockets({}, 1000, { roots: [run], bound: () => [join(run, "deep", "a", "s.sock"), join(t, "elsewhere", "e.sock"), join(t, "stage", "mine.sock"), "/nonexistent/x.sock"], keep: [join(t, "stage")] });
    for (const p of [join(run, "top.sock"), join(run, "svc"), join(run, "deep"), join(t, "elsewhere", "e.sock")]) assert.ok(got.includes(p), p);
    assert.ok(!got.includes(join(run, "plain")), "a directory holding no socket stays");
    assert.ok(!got.some((p) => p.startsWith(join(t, "stage"))), "the stage's own directories stay");
    assert.ok(!got.includes("/nonexistent/x.sock"), "a path that is no socket here is not listed");
  } finally {
    for (const v of servers) v.close();
    rmSync(t, { recursive: true, force: true });
  }
  assert.deepEqual(boundSockets("Num       RefCount Protocol Flags    Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 23 /run/a b.sock\n0000000000000000: 00000002 00000000 00010000 0001 01 24 @abstract\n0000000000000000: 00000003 00000000 00000000 0001 03 25\n"), ["/run/a b.sock"]);
});

test("the outer sandbox: in the harness's own state only what its run writes is writable, everything else read-only", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { harnessHomeGuards, harnessOuterSettings, claudeProject } = await import("../scripts/lib/local.mjs");
  const h = mkdtempSync(join(tmpdir(), "hg-"));
  const clone = "/w/.factory/3/repo";
  for (const d of [".claude/projects/-home-dev-app/memory", `.claude/projects/${claudeProject(clone)}`, ".claude/shell-snapshots", ".claude/some-new-dir", ".codex/sessions/2020/01/01"]) mkdirSync(join(h, d), { recursive: true });
  for (const f of [".claude/.credentials.json", ".claude/history.jsonl", ".codex/auth.json", ".codex/logs_2.sqlite", ".codex/memories_1.sqlite", ".codex/queue_1.sqlite", ".codex/sessions/2020/01/01/rollout-old.jsonl"]) writeFileSync(join(h, f), "x");
  const now = new Date("2026-11-08T12:00:00Z").getTime();
  mkdirSync(join(h, ".codex/sessions/2026/11/08"), { recursive: true });
  writeFileSync(join(h, ".codex/sessions/2026/11/08/rollout-dev.jsonl"), "x");
  const c = harnessHomeGuards("claude", {}, h, { clone });
  const cl = (p) => join(h, ".claude", p);
  for (const p of ["projects", "shell-snapshots", "session-env", "jobs", "daemon", "daemon.json", "dev-mods", "scheduled_tasks.json", "keybindings.json", "some-new-dir", "history.jsonl", "settings.json", "plans", "cache/changelog.md", "cache/model-catalog", "daemon.lock", "scheduled_tasks.lock"]) assert.ok(c.includes(cl(p)), p);
  for (const p of [".credentials.json", "cache", "todos"]) assert.ok(!c.includes(cl(p)), p);
  // A clone whose project name Claude Code shortens keeps a writable projects, every other project in it read-only.
  const long = `/w/${"d".repeat(200)}/repo`;
  mkdirSync(join(h, ".claude", "projects", claudeProject(long)), { recursive: true });
  const cLong = harnessHomeGuards("claude", {}, h, { clone: long });
  assert.ok(cLong.includes(cl("projects/-home-dev-app")) && !cLong.includes(cl("projects")) && !cLong.includes(cl(`projects/${claudeProject(long)}`)));
  const x = harnessHomeGuards("codex", {}, h, { now });
  const cx = (p) => join(h, ".codex", p);
  for (const p of ["memories_1.sqlite", "queue_1.sqlite", "memories", "shell_snapshots", "sessions/2020/01/01", "sessions/2026/11/08/rollout-dev.jsonl", "version.json"]) assert.ok(x.includes(cx(p)), p);
  for (const p of ["auth.json", "logs_2.sqlite", "sessions", "sessions/2026/11/08"]) assert.ok(!x.includes(cx(p)), p);
  // The settings carry them: the state directory writable, every guard read-only.
  const s = harnessOuterSettings({ harness: "claude", writable: ["/c"], clone, home: h, env: {} });
  assert.ok(s.filesystem.allowWrite.includes(join(h, ".claude")) && c.every((p) => s.filesystem.denyWrite.includes(p)));
  rmSync(h, { recursive: true, force: true });
});

test("Claude Code's projects: read-only in the outer sandbox, the clone's own a link to the Objective's directory, an earlier one moved there", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, lstatSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { claudeProject, claudeProjectLink, dropClaudeProjectLink, harnessOuterSettings } = await import("../scripts/lib/local.mjs");
  const h = mkdtempSync(join(tmpdir(), "cp-"));
  const clone = join(h, "dev", ".factory", "4", "repo");
  const link = join(h, ".claude", "projects", claudeProject(clone));
  const dir = join(h, "dev", ".factory", "4", "claude-project");
  // A project directory an earlier stage kept there: its sessions move with it.
  mkdirSync(link, { recursive: true });
  writeFileSync(join(link, "s1.jsonl"), "earlier\n");
  assert.equal(claudeProjectLink(clone, dir, {}, h), dir);
  assert.ok(lstatSync(link).isSymbolicLink() && readlinkSync(link) === dir);
  assert.equal(readFileSync(join(link, "s1.jsonl"), "utf8"), "earlier\n");
  assert.equal(claudeProjectLink(clone, dir, {}, h), dir, "the next stage keeps it");
  const s = harnessOuterSettings({ harness: "claude", writable: [clone], clone, home: h, env: {}, projectDir: dir });
  assert.ok(s.filesystem.denyWrite.includes(join(h, ".claude", "projects")) && s.filesystem.allowWrite.includes(dir));
  assert.ok(!harnessOuterSettings({ harness: "codex", writable: [clone], clone, home: h, env: {}, projectDir: dir }).filesystem.allowWrite.includes(dir));
  // A link pointing elsewhere is put back.
  rmSync(link);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(h, link);
  claudeProjectLink(clone, dir, {}, h);
  assert.equal(readlinkSync(link), dir);
  assert.equal(claudeProjectLink(`/w/${"d".repeat(200)}/repo`, dir, {}, h), null, "a name Claude Code shortens is left alone");
  dropClaudeProjectLink(clone, {}, h);
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
  rmSync(h, { recursive: true, force: true });
});

test("a git-identity Block on the review path takes factory:review off the PR, and a repeat updates its one comment", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { REVIEW_LABEL } = await import("../scripts/lib/logic.mjs");
  const { pinGitDir, gitPinFile } = await import("../scripts/lib/local.mjs");
  const { Local, reviewIssue, isBlocked } = await import("../scripts/local.mjs");
  const dev = mkdtempSync(join(tmpdir(), "rvb-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, repoFull: "o/r", repo: { owner: "o", name: "r", full: "o/r" }, opts: {}, wf: {}, harness: "claude", stopping: false, firstSetup: new Map(), children: new Set() });
  mkdirSync(join(local.ws(9), "repo", ".git"), { recursive: true });
  pinGitDir(join(local.ws(9), "repo"), gitPinFile(local.ws(9)));
  const calls = [];
  const gh = { findPr: async () => ({ number: 31, draft: false }), removeLabel: async (_r, n, l) => calls.push(["unlabel", n, l]), applyExit: async (_r, x) => calls.push(["exit", x.exit, x.key, x.stage]) };
  await local.blockForClone(9, "review", gh);
  await local.blockForClone(9, "review", gh);
  assert.deepEqual(calls.filter((c) => c[0] === "unlabel"), [["unlabel", 31, REVIEW_LABEL], ["unlabel", 31, REVIEW_LABEL]]);
  const keys = calls.filter((c) => c[0] === "exit").map((c) => c[2]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "a repeat on the same clone updates the same comment");
  assert.match(keys[0], /^git-identity:review:[0-9a-f]{12}$/, "no inode on GitHub");
  // A fresh clone is a new condition: a new comment.
  rmSync(local.ws(9), { recursive: true, force: true });
  mkdirSync(join(local.ws(9), "repo", ".git"), { recursive: true });
  pinGitDir(join(local.ws(9), "repo"), gitPinFile(local.ws(9)));
  await local.blockForClone(9, "review", gh);
  assert.notEqual(calls.at(-1)[2], keys[0]);
  // serve's review picks: no draft PR, no Blocked Objective's.
  const pr = (o) => ({ head: { ref: "factory/9" }, labels: [{ name: REVIEW_LABEL }], draft: false, ...o });
  assert.equal(reviewIssue(pr()), 9);
  assert.equal(reviewIssue(pr({ draft: true })), 0);
  assert.equal(reviewIssue(pr({ labels: [] })), 0);
  assert.equal(reviewIssue(pr({ head: { ref: "feature/9" } })), 0);
  assert.ok(isBlocked({ labels: [{ name: "factory:blocked" }] }) && isBlocked({ labels: ["factory:blocked"] }) && !isBlocked({ labels: [{ name: "factory:in-review" }] }));
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
  // As a stage runs them: pin after Factory's git setup, then the pre-start clear before each harness start, then the check.
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
  const g = refusalExit(new GitRefusal("git-identity", "x"), { stage: "work", issue: 5, env: { FACTORY_LOCAL_SANDBOX: JSON.stringify({ gitId: "1:2" }) } });
  assert.match(g.reason, /\.factory\/5/);
  assert.match(g.key, /^git-identity:work:/);
  assert.match(refusalExit(new GitRefusal("git-clear", "y"), { stage: "review", issue: 5, env: {} }).reason, /git-clear/);
  assert.equal(refusalExit(new Error("other"), { stage: "work", issue: 5 }), null, "any other error is still a crash");
  rmSync(root, { recursive: true, force: true });
});

test("a stage's start clears what an earlier stage or run left untracked in the reused clone; ignored files and Factory's paths stay", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { prepareClone } = await import("../scripts/lib/local.mjs");
  const root = mkdtempSync(join(tmpdir(), "fresh-"));
  const clone = join(root, "repo");
  const git = (...a) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  execFileSync("git", ["init", "-q", clone]);
  writeFileSync(join(clone, ".gitignore"), "node_modules/\n");
  writeFileSync(join(clone, "app.txt"), "v1\n");
  git("add", ".");
  git("commit", "-q", "-m", "i");
  const run = (inner) => exec(inner[0], inner.slice(1));
  // The first stage: Factory's paths made, then the run leaves files behind.
  await prepareClone(clone, [], run);
  mkdirSync(join(clone, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(clone, "node_modules", "dep", "index.js"), "x\n");
  mkdirSync(join(clone, "gen"), { recursive: true });
  writeFileSync(join(clone, "gen", "out.txt"), "stale\n");
  writeFileSync(join(clone, "notes.txt"), "leftover\n");
  writeFileSync(join(clone, "app.txt"), "half-done\n");
  // Another harness start in the same stage keeps the work in progress.
  await prepareClone(clone, [], run, { clear: true });
  assert.ok(existsSync(join(clone, "notes.txt")) && existsSync(join(clone, "gen", "out.txt")));
  // The next stage's start.
  await prepareClone(clone, [], run, { fresh: true });
  assert.equal(existsSync(join(clone, "notes.txt")), false);
  assert.equal(existsSync(join(clone, "gen")), false);
  assert.ok(existsSync(join(clone, "node_modules", "dep", "index.js")), "ignored files (the dependencies) stay");
  for (const p of [".claude/agents", ".vscode", ".codex", ".mcp.json"]) assert.ok(existsSync(join(clone, p)), `Factory's own ${p} stays`);
  assert.equal(git("status", "--porcelain").trim(), "M app.txt", "a tracked change is the checkout's to discard (outbox.mjs putOn)");
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
  assert.throws(() => git("config", "factory.x", "1"), "the planted lock stops git");
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
  git("config", "factory.x", "1");
  git("commit", "-q", "--allow-empty", "-m", "after");
  // A lock older than the box's last boot has no holder, whatever /proc says.
  plant();
  for (const l of ["config.lock", "refs/heads/main.lock"]) utimesSync(join(clone, ".git", l), new Date(0), new Date(0));
  assert.deepEqual(staleGitLocks(clone, { proc: join(root, "no-proc") }).stale.sort(), [".git/config.lock", ".git/refs/heads/main.lock"]);
  assert.deepEqual(staleGitLocks(join(root, "absent")), { stale: [], live: [] });
  rmSync(root, { recursive: true, force: true });
});

test("host sockets: the ssh, gpg and tmux directories under /tmp, socket or not, but the stage's own", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hostSockets } = await import("../scripts/lib/local.mjs");
  const t = realpathSync(mkdtempSync(join(tmpdir(), "tk-")));
  for (const d of ["ssh-abc", "gpg-x", "tmux-1000", "other", "ssh-mine"]) mkdirSync(join(t, d));
  writeFileSync(join(t, "ssh-file"), "");
  const got = hostSockets({}, 1000, { roots: [], bound: () => [], tmp: t, keep: [join(t, "ssh-mine")] });
  for (const d of ["ssh-abc", "gpg-x", "tmux-1000"]) assert.ok(got.includes(join(t, d)), d);
  for (const d of ["other", "ssh-file", "ssh-mine"]) assert.ok(!got.includes(join(t, d)), d);
  rmSync(t, { recursive: true, force: true });
});
