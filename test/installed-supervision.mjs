// Explicit opt-in model-free systemd proof. Run only against a disposable installed artifact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [installation, evidence] = process.argv
  .slice(2)
  .map((path) => resolve(path));
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
const cli = join(installation, "dist/cli.js"),
  configPath = join(evidence, "factory.json");
const run = (...args) =>
  execFileSync(process.execPath, [cli, ...args, "--config", configPath], {
    encoding: "utf8",
    timeout: 45_000,
  });
run(
  "install",
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
const config = JSON.parse(readFileSync(configPath, "utf8"));
const admissionBase = {
  schemaVersion: 1,
  repository: config.repository,
  objective: 1,
  baseSha,
  configDigest: factoryConfigDigest(config),
  authority: {
    schemaVersion: 1,
    actor: "model-free installed lifecycle fixture",
    reason: "Paused owner only; no provider, GitHub or target work",
    executionConsent: true,
    serviceConsent: true,
    objectives: [1],
    allowances: {
      planningRevisions: 0,
      implementationRepairs: 0,
      resultRereviews: 0,
    },
    repairClasses: [],
    resources: { maxConcurrency: 1 },
    requiredEnvironment: [],
  },
};
const admission = {
  ...admissionBase,
  digest: createHash("sha256")
    .update(JSON.stringify(admissionBase))
    .digest("hex"),
};
const state = {
  schemaVersion: 5,
  kind: "preparing",
  repository: config.repository,
  objective: 1,
  runId: "installed-systemd-model-free",
  configDigest: factoryConfigDigest(config),
  baseSha,
  objectiveBodyDigest: "a".repeat(64),
  admission,
  planning: "ready",
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
    "Installed model-free paused coordinator lifecycle; synthetic admission and local public fixture. No model-backed Objective acceptance claimed.",
  installation,
  cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
  checks: [],
};
writeFileSync(
  join(evidence, "SCENARIO.json"),
  JSON.stringify(
    {
      ...report,
      owner: "Factory contributor #246",
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
  run("supervisor", "install", "--objective", "1");
  installed = true;
  run("supervisor", "install", "--objective", "1");
  const status = JSON.parse(run("supervisor", "status"));
  assert.equal(status.registered, true);
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
  run("supervisor", "start");
  const second = JSON.parse(
    readFileSync(join(stateRoot(config.repository), "controller.lock"), "utf8"),
  );
  assert.notEqual(second.pid, first.pid);
  assert.equal(snapshot().runId, state.runId);
  assert.deepEqual(snapshot().issueByItemId, {});
  assert.deepEqual(snapshot().admission, state.admission);
  report.checks.push(
    "ordinary manager restart preserves paused continuation, admission and run identity",
  );
  const incompatible = join(evidence, "old-cli.mjs");
  writeFileSync(incompatible, 'console.log("unsupported command")');
  assert.throws(() => run("supervisor", "upgrade", "--cli", incompatible));
  assert.equal(JSON.parse(run("supervisor", "status")).active, "active");
  report.checks.push(
    "incompatible artifact refuses before stopping live owner",
  );
  run("supervisor", "upgrade", "--cli", cli);
  assert.equal(snapshot().runId, state.runId);
  report.checks.push("compatible exact-artifact handoff and restart");
  run("supervisor", "disable");
  assert.equal(
    existsSync(join(stateRoot(config.repository), "controller.lock")),
    false,
  );
  run("supervisor", "uninstall");
  installed = false;
  const final = JSON.parse(run("supervisor", "status"));
  assert.equal(final.registered, false);
  assert.deepEqual(snapshot().admission, state.admission);
  assert.equal(snapshot().cancelledAt, undefined);
  assert.equal(snapshot().cancelRequested, undefined);
  report.checks.push(
    "disable/uninstall retain authority, snapshot and evidence without cancellation",
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
