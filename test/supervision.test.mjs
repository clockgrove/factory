import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enqueueIntake } from "../dist/intake.js";
import { factoryConfigDigest } from "../dist/config.js";
import { defaultAutonomy } from "../dist/index.js";
import { saveState, statePath } from "../dist/state-store.js";
import {
  checkServiceState,
  checkIntakeServiceState,
  renderService,
  serviceName,
  supervise,
} from "../dist/supervision.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "factory-supervision-"));
  const previous = { ...process.env };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh
printf "%s\\n" "$*" >> "${root}/calls"
case "$2" in
  enable|link)
    case "$3" in
      /*) test -f "$3" || exit 1;;
      *) echo "Unit not found in manager search path" >&2; exit 1;;
    esac
    printf "%s" "$3" > "${root}/registered"
    if test "$2" = enable; then touch "${root}/enabled"; fi;;
  disable)
    test -f "${root}/registered" || { echo "Unit not found" >&2; exit 1; }
    rm -f "${root}/registered" "${root}/enabled";;
  stop)
    test -f "${root}/registered" || { echo "Unit not found" >&2; exit 1; };;
  is-system-running) echo running;;
  is-active) echo inactive;;
  is-enabled)
    if test -f "${root}/enabled"; then echo enabled
    elif test -f "${root}/registered"; then echo linked
    else echo not-found; fi;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "loginctl"), "#!/bin/sh\necho no\n", { mode: 0o700 });
  const config = factoryConfig(
    createTarget(root).checkout,
    "example/supervision",
  );
  const configPath = join(root, "factory.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const state = {
    schemaVersion: 7,
    kind: "preparing",
    repository: config.repository,
    objective: 1,
    runId: "fixture-run",
    configDigest: factoryConfigDigest(config),
    baseSha: "a".repeat(40),
    objectiveBodyDigest: "b".repeat(64),
    autonomy: defaultAutonomy,
    capacity: { concurrency: 1 },
    issueByItemId: {},
    coordinator: {
      mode: "paused",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
    },
  };
  saveState(statePath(config.repository, 1), state);
  try {
    await fn({ root, config, configPath, state });
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
}

test("registers the exact isolated-XDG unit with the manager idempotently without starting work", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    await supervise("install", configPath, { objective: 1 });
    const path = join(
      process.env.XDG_CONFIG_HOME,
      "systemd/user",
      serviceName(config.repository),
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const unit = readFileSync(path, "utf8");
    assert.match(unit, /ExecStart="\//);
    assert.match(unit, /KillMode=process/);
    assert.match(unit, /SendSIGKILL=no/);
    assert.doesNotMatch(
      readFileSync(join(root, "calls"), "utf8"),
      /--user start/,
    );
    const calls = readFileSync(join(root, "calls"), "utf8");
    assert.equal(
      calls.split("\n").filter((line) => line === `--user enable ${path}`)
        .length,
      2,
    );
    assert.doesNotMatch(calls, /--force|--global|--now/);
    const status = await supervise("status", configPath);
    assert.equal(status.logoutPersistence, "not-enabled");
    assert.equal(status.registered, true);
  }));

test("disable and uninstall retain identical continuation and allowances", () =>
  fixture(async ({ config, configPath }) => {
    const stateFile = statePath(config.repository, 1),
      before = readFileSync(stateFile);
    await supervise("install", configPath, { objective: 1 });
    await supervise("disable", configPath);
    assert.equal((await supervise("status", configPath)).enabled, "linked");
    await supervise("disable", configPath);
    await supervise("uninstall", configPath);
    await supervise("uninstall", configPath);
    assert.deepEqual(readFileSync(stateFile), before);
    assert.equal((await supervise("status", configPath)).registered, false);
  }));

test("a disabled isolated unit remains upgradeable without enabling or starting it", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    await supervise("disable", configPath);
    const candidate = join(root, "compatible-cli.mjs");
    writeFileSync(
      candidate,
      'console.log("factory-supervision-compatible-v1")',
    );
    const result = await supervise("upgrade", configPath, { cli: candidate });
    assert.equal(result.restarted, false);
    const status = await supervise("status", configPath);
    assert.equal(status.enabled, "linked");
    assert.equal(status.binding.cli, candidate);
    assert.doesNotMatch(
      readFileSync(join(root, "calls"), "utf8"),
      /--user start/,
    );
    await supervise("uninstall", configPath);
    assert.equal((await supervise("status", configPath)).registered, false);
  }));

test("incompatible rollback refuses before draining or changing unit", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    const path = join(
        process.env.XDG_CONFIG_HOME,
        "systemd/user",
        serviceName(config.repository),
      ),
      before = readFileSync(path);
    const old = join(root, "old-cli.mjs");
    writeFileSync(old, 'console.log("unrecognized command")');
    await assert.rejects(
      supervise("upgrade", configPath, { cli: old }),
      /does not affirm/,
    );
    assert.deepEqual(readFileSync(path), before);
    assert.doesNotMatch(
      readFileSync(join(root, "calls"), "utf8"),
      /--user stop/,
    );
  }));

test("state compatibility refuses future fields without altering state", () =>
  fixture(async ({ config, state }) => {
    state.futureAuthority = { automaticSpend: true };
    saveState(statePath(config.repository, 1), state);
    assert.throws(
      () => checkServiceState(config, 1),
      /cannot validate continuation field/,
    );
  }));

test("service requires private configuration and matching continuation", () =>
  fixture(async ({ config, configPath, state }) => {
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o644 });
    chmodSync(configPath, 0o644);
    await assert.rejects(
      supervise("install", configPath, { objective: 1 }),
      /owner-private/,
    );
    chmodSync(configPath, 0o600);
    state.configDigest = "c".repeat(64);
    saveState(statePath(config.repository, 1), state);
    await assert.rejects(
      supervise("install", configPath, { objective: 1 }),
      /Continuation configuration differs/,
    );
  }));

test("unsupported manager reports foreground limit and never registers", () =>
  fixture(async ({ root, configPath }) => {
    writeFileSync(
      join(root, "bin/systemctl"),
      "#!/bin/sh\necho offline\nexit 1\n",
      { mode: 0o700 },
    );
    const status = await supervise("status", configPath);
    assert.equal(status.supported, false);
    await assert.rejects(
      supervise("install", configPath, { objective: 1 }),
      /foreground/,
    );
  }));

test("unit escapes systemd specifiers and command variable expansion", () => {
  const text = renderService({
    version: 1,
    node: "/node",
    cli: "/pkg $x%/cli.js",
    config: "/private/config.json",
    objective: 1,
    stateHome: "/state",
    environment: { PATH: "/tool$literal" },
  });
  assert.match(text, /pkg \$\$x%%/);
  assert.match(text, /Environment="PATH=\/tool\$literal"/);
  assert.throws(
    () => renderService({ node: "/node\nExecStart=oops", environment: {} }),
    /line breaks/,
  );
});

const github = {
  objective: async () => ({ body: "Authorized Objective", state: "open" }),
};
const consent = {
  actor: "fixture",
  reason: "bounded lifecycle",
  consent: true,
};
async function intakePath(config) {
  const { stateRoot } = await import("../dist/config.js");
  return join(stateRoot(config.repository), "intake.json");
}
/** A finite batch with recorded service consent; no command records both without watch. */
async function registerIntake(config) {
  rmSync(statePath(config.repository, 1));
  await enqueueIntake(config, github, [1]);
  const path = await intakePath(config);
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.serviceConsent = consent;
  writeFileSync(path, JSON.stringify(value));
}
test("intake service pins its mode, requires consent and refuses unknown authorization fields", () =>
  fixture(async ({ config, configPath }) => {
    await registerIntake(config);
    await supervise("install", configPath, { intake: true });
    const unitPath = join(
      process.env.XDG_CONFIG_HOME,
      "systemd/user",
      serviceName(config.repository),
    );
    const unit = readFileSync(unitPath, "utf8");
    assert.match(unit, /"--intake"/);
    assert.doesNotMatch(unit, /"--objective"/);
    const path = await intakePath(config);
    const value = JSON.parse(readFileSync(path, "utf8"));
    delete value.serviceConsent;
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => checkIntakeServiceState(config), /service consent/);
    value.serviceConsent = consent;
    value.futureAuthority = true;
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => checkIntakeServiceState(config), /Unsupported intake/);
  }));
test("intake service start requires an owner while pending but accepts an exhausted finite batch", () =>
  fixture(async ({ root, config, configPath, state }) => {
    await registerIntake(config);
    await supervise("install", configPath, { intake: true });
    writeFileSync(
      join(root, "bin/systemctl"),
      '#!/bin/sh\ncase "$2" in is-system-running) echo running;; is-active) echo failed;; esac\n',
      { mode: 0o700 },
    );
    await assert.rejects(supervise("start", configPath), /has not established/);
    const { intakeControl } = await import("../dist/intake.js");
    await intakeControl(config, "dequeue", 1);
    await supervise("start", configPath);
  }));

test("managed CLI readiness and fresh supervised starts use loaded private credentials", () =>
  fixture(async ({ root, config, configPath, state }) => {
    const { spawnSync } = await import("node:child_process");
    const { intakeControl } = await import("../dist/intake.js");
    config.execution = {
      kind: "managed-agent",
      provider: "openai-agents",
      concurrency: 1,
      config: {
        model: "fixture",
        reasoningEffort: "low",
        containerSize: "small",
        apiKeyEnv: "FACTORY_SERVICE_TEST_KEY",
        timeoutSeconds: 10,
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    await registerIntake(config);
    await intakeControl(config, "dequeue", 1);
    const credentials = join(root, "loaded");
    mkdirSync(credentials);
    const file = join(credentials, "FACTORY_SERVICE_TEST_KEY");
    const cli = new URL("../dist/cli.js", import.meta.url);
    const run = (args, ambient) =>
      spawnSync(
        process.execPath,
        [cli.pathname, ...args, "--config", configPath],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            CREDENTIALS_DIRECTORY: credentials,
            FACTORY_SERVICE_TEST_KEY: ambient,
          },
        },
      );
    const absent = run(["readiness"], "");
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /FACTORY_SERVICE_TEST_KEY/);
    assert.doesNotMatch(absent.stderr, /outside-directory/);
    const present = run(["readiness"], "dummy-ambient");
    assert.equal(present.status, 0);
    assert.match(present.stdout, /not verified/);
    assert.doesNotMatch(present.stdout, /dummy-ambient/);
    const args = [
      "supervisor",
      "serve",
      "--intake",
      "--service-credential",
      "FACTORY_SERVICE_TEST_KEY",
    ];
    const missing = run(args, "dummy-ambient");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /unavailable/);
    assert.doesNotMatch(missing.stderr, /dummy-ambient/);
    writeFileSync(file, "", { mode: 0o600 });
    const empty = run(args, "dummy-ambient");
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /empty/);
    for (const key of ["dummy-first-loaded", "dummy-second-loaded"]) {
      writeFileSync(file, key);
      const started = run(args, "dummy-ambient");
      assert.equal(started.status, 0, started.stderr);
      assert.doesNotMatch(started.stdout + started.stderr, /dummy-/);
    }
  }));

test("a supervised Claude planning service keeps the Claude login and may bind a token", () =>
  fixture(async ({ root, config, configPath, state }) => {
    config.planning = {
      kind: "claude-agent-sdk",
      maxOutputTokens: 1000,
      planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
      reviewer: { model: "claude-opus-5-5", reasoningEffort: "high" },
    };
    writeFileSync(configPath, JSON.stringify(config));
    await registerIntake(config);
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
    process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-token-never-copied";
    const unitFile = join(
      process.env.XDG_CONFIG_HOME,
      "systemd/user",
      serviceName(config.repository),
    );
    // No credential is required: the service uses the operator's login.
    await supervise("install", configPath, { intake: true });
    let unit = readFileSync(unitFile, "utf8");
    assert.doesNotMatch(unit, /LoadCredential|--service-credential/);
    assert.match(
      unit,
      new RegExp(`Environment="CLAUDE_CONFIG_DIR=${root}/claude-config"`),
    );
    assert.match(unit, /Environment="HTTPS_PROXY=http:\/\/proxy.invalid:3128"/);
    assert.doesNotMatch(unit, /ambient-token-never-copied/);
    await supervise("uninstall", configPath);

    // A headless host may bind an OAuth token; unrelated names stay refused.
    const token = join(root, "claude-token");
    writeFileSync(token, "bound-oauth-token", { mode: 0o600 });
    await assert.rejects(
      supervise("install", configPath, {
        intake: true,
        credentialFiles: [`OTHER_KEY=${token}`],
      }),
      /OTHER_KEY is not required/,
    );
    await supervise("install", configPath, {
      intake: true,
      credentialFiles: [`CLAUDE_CODE_OAUTH_TOKEN=${token}`],
    });
    unit = readFileSync(unitFile, "utf8");
    assert.match(unit, /^LoadCredential="CLAUDE_CODE_OAUTH_TOKEN:\//m);
    assert.match(unit, /"--service-credential" "CLAUDE_CODE_OAUTH_TOKEN"/);
    assert.doesNotMatch(unit, /bound-oauth-token/);
    const status = await supervise("status", configPath);
    assert.deepEqual(status.binding.credentials, [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", file: token },
    ]);
  }));

test("a retired single-credential binding is refused for reuse and only removable", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    const path = join(
      process.env.XDG_CONFIG_HOME,
      "systemd/user",
      serviceName(config.repository),
    );
    const prefix = "# Factory local supervision v1 ";
    const value = JSON.parse(
      readFileSync(path, "utf8").split("\n")[0].slice(prefix.length),
    );
    value.credential = { name: "KEY", file: join(root, "key") };
    writeFileSync(path, renderService(value), { mode: 0o600 });
    const legacy = /retired single `credential` field.*--credential-file NAME=/;
    await assert.rejects(
      supervise("upgrade", configPath, { cli: process.argv[1] }),
      legacy,
    );
    await assert.rejects(supervise("start", configPath), legacy);
    await assert.rejects(
      supervise("install", configPath, { objective: 1 }),
      legacy,
    );
    assert.match(readFileSync(path, "utf8"), /"credential":/);
    const status = await supervise("status", configPath);
    assert.equal(status.binding, undefined);
    assert.equal(
      status.bindingHealth.diagnostics[0].code,
      "legacy-credential-binding",
    );
    assert.match(status.bindingHealth.diagnostics[0].action, legacy);
    assert.deepEqual(await supervise("uninstall", configPath), {
      stopped: true,
      evidenceRetained: true,
    });
    assert.equal(existsSync(path), false);
    await supervise("install", configPath, { objective: 1 });
    assert.doesNotMatch(readFileSync(path, "utf8"), /"credential":/);
  }));

test("supervised install and upgrade retain the caller's nonsecret SQLite path", () =>
  fixture(async ({ root, config, configPath }) => {
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.CODEX_SQLITE_HOME = join(root, "sqlite-home");
    process.env.GITHUB_TOKEN = "excluded-publication-token";
    await supervise("install", configPath, { objective: 1 });
    const installed = (await supervise("status", configPath)).binding;
    assert.equal(installed.environment.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(
      installed.environment.CODEX_SQLITE_HOME,
      process.env.CODEX_SQLITE_HOME,
    );
    assert.equal(installed.environment.GITHUB_TOKEN, undefined);
    const path = join(
      process.env.XDG_CONFIG_HOME,
      "systemd/user",
      serviceName(config.repository),
    );
    assert.ok(
      readFileSync(path, "utf8").includes(
        `Environment="CODEX_SQLITE_HOME=${process.env.CODEX_SQLITE_HOME}"`,
      ),
    );
    const candidate = join(root, "compatible-cli.mjs");
    writeFileSync(
      candidate,
      'console.log("factory-supervision-compatible-v1")',
    );
    process.env.CODEX_SQLITE_HOME = join(root, "different-host-value");
    await supervise("upgrade", configPath, { cli: candidate });
    assert.equal(
      (await supervise("status", configPath)).binding.environment
        .CODEX_SQLITE_HOME,
      installed.environment.CODEX_SQLITE_HOME,
    );
  }));

function unitFile(config) {
  return join(
    process.env.XDG_CONFIG_HOME,
    "systemd/user",
    serviceName(config.repository),
  );
}
function editBinding(config, change) {
  const path = unitFile(config);
  const text = readFileSync(path, "utf8");
  const prefix = "# Factory local supervision v1 ";
  const value = JSON.parse(text.split("\n")[0].slice(prefix.length));
  change(value);
  writeFileSync(path, renderService(value));
}
async function cliStatus(configPath) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      new URL("../dist/cli.js", import.meta.url).pathname,
      "supervisor",
      "status",
      "--config",
      configPath,
    ],
    { encoding: "utf8", timeout: 10000, env: process.env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("CLI status separates usable stopped and disabled bindings from registration and manager observations", () =>
  fixture(async ({ root, config, configPath }) => {
    const stateFile = statePath(config.repository, 1);
    const before = readFileSync(stateFile);
    let status = await cliStatus(configPath);
    assert.equal(status.bindingHealth.status, "unregistered");
    await supervise("install", configPath, { objective: 1 });
    status = await cliStatus(configPath);
    assert.equal(status.registered, true);
    assert.equal(status.active, "inactive");
    assert.equal(status.enabled, "enabled");
    assert.equal(status.bindingHealth.status, "usable");
    assert.deepEqual(status.bindingHealth.checks, {
      node: true,
      cli: true,
      config: true,
    });
    assert.match(status.bindingHealth.limitation, /ownership are not verified/);
    await supervise("disable", configPath);
    status = await cliStatus(configPath);
    assert.equal(status.enabled, "linked");
    assert.equal(status.bindingHealth.status, "usable");
    const calls = readFileSync(join(root, "calls"), "utf8");
    const unit = readFileSync(unitFile(config));
    await cliStatus(configPath);
    assert.deepEqual(readFileSync(unitFile(config)), unit);
    assert.deepEqual(readFileSync(stateFile), before);
    assert.doesNotMatch(
      readFileSync(join(root, "calls"), "utf8").slice(calls.length),
      /--user (?:enable|start|stop|daemon-reload)(?: |\n)/,
    );
  }));

test("CLI status diagnoses missing CLI, unavailable Node and missing configuration without executing bindings", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    const poisoned = join(root, "poisoned-node");
    writeFileSync(poisoned, `#!/bin/sh\ntouch '${root}/executed'\n`, {
      mode: 0o600,
    });
    editBinding(config, (value) => {
      value.node = poisoned;
      value.cli = join(root, "absent-cli.js");
      value.config = join(root, "absent-config.json");
    });
    const before = readFileSync(unitFile(config));
    const status = await cliStatus(configPath);
    assert.equal(status.registered, true);
    assert.equal(status.active, "inactive");
    assert.equal(status.enabled, "enabled");
    assert.equal(status.bindingHealth.status, "unusable");
    assert.deepEqual(status.bindingHealth.checks, {
      node: false,
      cli: false,
      config: false,
    });
    assert.deepEqual(
      status.bindingHealth.diagnostics.map((d) => d.code),
      ["unavailable-node", "missing-cli", "missing-config"],
    );
    assert.match(
      status.bindingHealth.diagnostics[1].action,
      /supervisor upgrade/,
    );
    assert.equal(existsSync(join(root, "executed")), false);
    assert.deepEqual(readFileSync(unitFile(config)), before);
    await assert.rejects(supervise("start", configPath));
    assert.doesNotMatch(
      readFileSync(join(root, "calls"), "utf8"),
      /--user start/,
    );
  }));

test("CLI status retains observations for malformed and mismatched bindings and redacts arbitrary marker fields", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    const original = readFileSync(unitFile(config), "utf8");
    for (const marker of [
      '# Factory local supervision v1 {"secret":"dummy-secret",',
      "# Factory local supervision v1 null",
      "[Service]\nExecStart=foreign",
    ]) {
      writeFileSync(unitFile(config), marker);
      const status = await cliStatus(configPath);
      assert.equal(status.registered, true);
      assert.equal(status.active, "inactive");
      assert.equal(status.bindingHealth.status, "unusable");
      assert.equal(
        status.bindingHealth.diagnostics[0].code,
        "malformed-binding",
      );
      assert.equal(status.binding, undefined);
      assert.doesNotMatch(JSON.stringify(status), /dummy-secret/);
      await assert.rejects(supervise("start", configPath));
    }
    writeFileSync(unitFile(config), original);
    editBinding(config, (value) => {
      value.stateHome = join(root, "different-state");
    });
    let status = await cliStatus(configPath);
    assert.equal(
      status.bindingHealth.diagnostics[0].code,
      "installation-mismatch",
    );
    assert.equal(status.binding, undefined);
    await assert.rejects(supervise("start", configPath), /differs/);
    writeFileSync(unitFile(config), original);
    const other = join(root, "other-config.json");
    writeFileSync(
      other,
      JSON.stringify(
        factoryConfig(
          createTarget(join(root, "other")).checkout,
          "example/other",
        ),
      ),
    );
    editBinding(config, (value) => {
      value.config = other;
    });
    status = await cliStatus(configPath);
    assert.equal(
      status.bindingHealth.diagnostics[0].code,
      "installation-mismatch",
    );
    assert.equal(status.binding, undefined);
    writeFileSync(unitFile(config), original);
    const prefix = "# Factory local supervision v1 ";
    const value = JSON.parse(original.split("\n")[0].slice(prefix.length));
    value.environment.PRIVATE_TOKEN = "dummy-secret";
    value.privateSecret = "dummy-secret";
    value.credentials = [
      { name: "KEY", file: "/private/credential", extra: "dummy-secret" },
    ];
    writeFileSync(unitFile(config), renderService(value));
    status = await cliStatus(configPath);
    assert.equal(status.bindingHealth.status, "usable");
    assert.doesNotMatch(
      JSON.stringify(status),
      /dummy-secret|PRIVATE_TOKEN|privateSecret/,
    );
    assert.deepEqual(status.binding.credentials, [
      { name: "KEY", file: "/private/credential" },
    ]);
  }));

test("CLI status preserves local health when the manager is unavailable and keeps invalid config details private", () =>
  fixture(async ({ root, config, configPath }) => {
    await supervise("install", configPath, { objective: 1 });
    writeFileSync(
      join(root, "bin/systemctl"),
      '#!/bin/sh\necho "Failed: dummy-secret" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    let status = await cliStatus(configPath);
    assert.equal(status.manager, "unavailable");
    assert.equal(status.supported, false);
    assert.equal(status.active, "unavailable");
    assert.equal(status.enabled, "unavailable");
    assert.equal(status.bindingHealth.status, "usable");
    const bad = join(root, "invalid-config.json");
    writeFileSync(bad, '{"secret":"dummy-secret",');
    editBinding(config, (value) => {
      value.config = bad;
    });
    status = await cliStatus(configPath);
    assert.equal(status.bindingHealth.status, "unusable");
    assert.equal(status.bindingHealth.diagnostics[0].code, "invalid-config");
    assert.doesNotMatch(JSON.stringify(status), /dummy-secret/);
  }));

test("watch service consent covers queued Objectives and leaves their continuation unchanged", () =>
  fixture(async ({ config, state, configPath }) => {
    const { watchIntake } = await import("../dist/intake.js");
    rmSync(statePath(config.repository, 1));
    await watchIntake(config, consent);
    await enqueueIntake(config, github, [1]);
    saveState(statePath(config.repository, 1), state);
    const before = readFileSync(statePath(config.repository, 1));
    checkIntakeServiceState(config);
    assert.equal(
      await supervise("check", configPath, { intake: true }),
      "factory-supervision-compatible-v1",
    );
    checkServiceState(config, 1);
    assert.deepEqual(readFileSync(statePath(config.repository, 1)), before);
  }));
