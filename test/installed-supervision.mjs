// Explicit opt-in model-free systemd proof. Run only against a disposable installed artifact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [installationPath, evidencePath, mode] = process.argv.slice(2);
const installation = installationPath && resolve(installationPath);
const evidence = evidencePath && resolve(evidencePath);
if (mode && mode !== "--isolated-config")
  throw new Error("Unknown installed-supervision mode");
if (!installation || !evidence)
  throw new Error(
    "installed-supervision requires installed package root and new evidence directory",
  );
if (existsSync(evidence)) throw new Error("Evidence directory must be new");
mkdirSync(evidence, { mode: 0o700 });
const checkout = join(evidence, "public-fixture");
cpSync(new URL("./fixtures/disposable-target", import.meta.url), checkout, {
  recursive: true,
});
execFileSync("git", ["init", "-b", "main", checkout]);
execFileSync("git", [
  "-C",
  checkout,
  "remote",
  "add",
  "origin",
  "https://github.com/example/factory-supervision-fixture.git",
]);
execFileSync("git", ["-C", checkout, "add", "."]);
execFileSync("git", [
  "-C",
  checkout,
  "-c",
  "user.name=Factory Test",
  "-c",
  "user.email=factory@example.invalid",
  "commit",
  "-m",
  "Public fixture",
]);
const baseSha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
process.env.XDG_STATE_HOME = join(evidence, "state");
if (mode === "--isolated-config")
  process.env.XDG_CONFIG_HOME = join(evidence, "config");
const cli = join(installation, "dist/cli.js"),
  configPath = join(evidence, "factory.json");
const run = (...args) =>
  execFileSync(process.execPath, [cli, ...args, "--config", configPath], {
    encoding: "utf8",
    timeout: 45_000,
  });
run(
  "setup",
  "--config-only",
  "--repository",
  "example/factory-supervision-fixture",
  "--checkout",
  checkout,
  "--concurrency",
  "1",
  "--network",
  "off",
);
const { factoryConfigDigest, stateRoot } = await import(
  pathToFileURL(join(installation, "dist/config.js"))
);
const { saveState, statePath } = await import(
  pathToFileURL(join(installation, "dist/state-store.js"))
);
const { defaultAutonomy } = await import(
  pathToFileURL(join(installation, "dist/index.js"))
);
const { watchIntake } = await import(
  pathToFileURL(join(installation, "dist/intake.js"))
);
const { supervise } = await import(
  pathToFileURL(join(installation, "dist/supervision.js"))
);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const state = {
  schemaVersion: 8,
  kind: "preparing",
  repository: config.repository,
  objective: 1,
  runId: "installed-systemd-model-free",
  configDigest: factoryConfigDigest(config),
  baseSha,
  objectiveBodyDigest: "a".repeat(64),
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
const snapshot = () =>
  JSON.parse(readFileSync(statePath(config.repository, 1), "utf8"));
const report = {
  scenario:
    "Installed model-free paused coordinator lifecycle; synthetic paused Objective state and local public fixture. No model-backed Objective acceptance claimed.",
  installation,
  cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
  checks: [],
};
writeFileSync(
  join(evidence, "SCENARIO.json"),
  JSON.stringify(
    {
      ...report,
      owner: "Factory contributor installed supervision proof",
      configMode: mode ?? "existing user configuration",
      attemptLimit: 1,
      providerCalls: 0,
      concurrency: 1,
      acceptance: [
        "private registration",
        "session independence",
        "duplicate setup",
        "restart identity",
        "safe upgrade refusal",
        "stop/disable/uninstall retention",
      ],
      disposition:
        "Retain local fixture and evidence until #246 acceptance; owned unit removed through packaged uninstall",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
let installed = false;
try {
  // `factory setup --background` needs GitHub; this proof marks the queue as served and
  // installs the service through the same library steps, with no network. The synthetic
  // Objective is queued and the queue is paused, so the service keeps it without observing GitHub.
  await watchIntake(config);
  const intakeFile = join(stateRoot(config.repository), "intake.json");
  const queue = JSON.parse(readFileSync(intakeFile, "utf8"));
  writeFileSync(
    intakeFile,
    JSON.stringify({
      ...queue,
      objectives: [1],
      bodyDigests: { 1: state.objectiveBodyDigest },
      mode: "paused",
    }),
    { mode: 0o600 },
  );
  await supervise("install", configPath);
  installed = true;
  await supervise("install", configPath);
  const status = JSON.parse(run("status", "--json")).service;
  assert.equal(status.registered, true);
  assert.equal(status.enabled, "enabled");
  const fragment = execFileSync(
    "systemctl",
    ["--user", "show", status.unit, "--property=FragmentPath", "--value"],
    { encoding: "utf8" },
  ).trim();
  const unitPath = join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, ".config"),
    "systemd/user",
    status.unit,
  );
  assert.equal(realpathSync(fragment), realpathSync(unitPath));
  assert.equal(status.binding.cli, realpathSync(cli));
  assert.equal(status.binding.config, realpathSync(configPath));
  assert.equal(status.binding.stateHome, process.env.XDG_STATE_HOME);
  if (mode === "--isolated-config") {
    const managerPaths = execFileSync(
      "systemctl",
      ["--user", "show", "--property=UnitPath", "--value"],
      { encoding: "utf8" },
    )
      .trim()
      .split(" ");
    assert.equal(
      managerPaths.includes(join(process.env.XDG_CONFIG_HOME, "systemd/user")),
      false,
    );
    assert.equal(
      status.binding.environment.XDG_CONFIG_HOME,
      process.env.XDG_CONFIG_HOME,
    );
  }
  assert.notEqual(status.active, "active");
  report.host = status;
  report.checks.push("idempotent registration without start");
  run("supervisor", "start");
  const first = JSON.parse(
    readFileSync(join(stateRoot(config.repository), "controller.lock"), "utf8"),
  );
  assert.notEqual(first.pid, process.pid);
  assert.equal(
    statSync(join(stateRoot(config.repository), "control.sock")).mode & 0o777,
    0o600,
  );
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  report.checks.push(
    "installed CLI exits while separate private coordinator remains alive",
  );
  execFileSync("systemctl", ["--user", "restart", status.unit], {
    timeout: 45_000,
  });
  // The manager's stop left the queue draining, so the restarted service ends at once, and
  // `supervisor start` says which command continues it. `queue pause` keeps this proof model-free
  // (`queue resume` would make the service observe GitHub).
  for (let wait = 0; wait < 150; wait++) {
    if (JSON.parse(run("status", "--json")).service.active !== "active") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.throws(() => run("supervisor", "start"), /factory queue resume/);
  run("queue", "pause");
  run("supervisor", "start");
  const second = JSON.parse(
    readFileSync(join(stateRoot(config.repository), "controller.lock"), "utf8"),
  );
  assert.notEqual(second.pid, first.pid);
  assert.equal(snapshot().runId, state.runId);
  assert.deepEqual(snapshot().issueByItemId, {});
  report.checks.push(
    "ordinary manager restart preserves paused continuation and run identity",
  );
  const incompatible = join(evidence, "old-cli.mjs");
  writeFileSync(incompatible, 'console.log("unsupported command")');
  assert.throws(() => run("supervisor", "upgrade", "--cli", incompatible));
  assert.equal(JSON.parse(run("status", "--json")).service.active, "active");
  report.checks.push(
    "incompatible artifact refuses before stopping live owner",
  );
  run("supervisor", "upgrade", "--cli", cli);
  assert.equal(snapshot().runId, state.runId);
  report.checks.push("compatible exact-artifact handoff and restart");
  run("supervisor", "stop", "--disable");
  const disabled = JSON.parse(run("status", "--json")).service;
  assert.equal(disabled.registered, true);
  assert.notEqual(disabled.enabled, "enabled");
  assert.notEqual(disabled.enabled, "not-found");
  run("supervisor", "upgrade", "--cli", cli);
  assert.notEqual(
    JSON.parse(run("status", "--json")).service.enabled,
    "enabled",
  );
  run("supervisor", "stop", "--disable");
  assert.equal(
    existsSync(join(stateRoot(config.repository), "controller.lock")),
    false,
  );
  run("supervisor", "uninstall");
  installed = false;
  const final = JSON.parse(run("status", "--json")).service;
  assert.equal(final.registered, false);
  assert.equal(snapshot().cancelledAt, undefined);
  assert.equal(snapshot().cancelRequested, undefined);
  report.checks.push(
    "disable/uninstall retain the snapshot and evidence without cancellation",
  );
  report.passed = true;
} finally {
  if (installed) run("supervisor", "uninstall");
  writeFileSync(
    join(evidence, "RESULT.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
console.log(JSON.stringify(report, null, 2));
