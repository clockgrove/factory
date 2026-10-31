// The real service, as a real process, on real files: its lock, a request
// sent while it is stopped, a stop as it starts, the repository it holds,
// and the unit setup --check judges.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { unitName, unitText } from "../dist/systemd.js";
import {
  CLI,
  cli,
  closedPort,
  configured,
  exited,
  githubOrigin,
  installation,
  REPO,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  tempDir,
  until,
} from "./helpers.mjs";

test("one service per installation; the lock dies with the process", async () => {
  const inst = installation();
  const first = serve(inst);
  await until(() => status(inst).service === "running", "first service");
  const second = await serve(inst).exit;
  assert.equal(second.code, 3);
  assert.match(second.stderr, /already running/);
  first.child.kill("SIGKILL");
  await first.exit;
  const third = serve(inst);
  await until(
    () => status(inst).service === "running",
    "service after SIGKILL",
  );
  await stopped(third);
});

test("a request sent while the service is stopped applies when it starts", async () => {
  const inst = installation();
  seed(inst, 8);
  const sent = cli(inst, "cancel", "8");
  assert.equal(sent.code, 0);
  assert.match(sent.out, /isn't running/);
  const service = serve(inst);
  await until(() => stateOf(inst, 8).status === "cancelled", "cancel applied");
  await until(
    () => readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
    "request removed",
  );
  await stopped(service);
});

test("a stop as the service starts is a clean stop, after its housekeeping", async () => {
  const inst = installation();
  const dir = join(inst.logs, "5");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (let i = 0; i < 21; i++) {
    const file = join(
      dir,
      `2026-01-01T00-00-${String(i).padStart(2, "0")}.jsonl`,
    );
    writeFileSync(file, "{}\n");
    utimesSync(file, old, old);
  }
  // SIGTERM once the service holds its lock (`status` says running), before its loop.
  inst.env.STOP_AT_MKDIR = inst.objectives;
  const service = serve(inst, undefined, [
    "--import",
    new URL("./fixtures/stop-at-start.mjs", import.meta.url).href,
  ]);
  const { code, signal, stderr } = await exited(
    service,
    "the service stopped at start",
  );
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
  // Its start's housekeeping ran: the oldest run is gone, and recorded.
  assert.deepEqual(
    readFileSync(join(dir, "rotated"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).run),
    ["2026-01-01T00-00-00"],
  );
  // A clean stop: the next start counts no death.
  assert.equal(
    JSON.parse(readFileSync(join(inst.root, "service.json"), "utf8")).stopped,
    true,
  );
});

test("two spellings of one state directory share one lock", async () => {
  const inst = installation();
  const first = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const parent = join(inst.root, "..");
  const relative = spawn(process.execPath, [CLI, "serve", "--repo", REPO], {
    env: { ...inst.env, FACTORY_STATE_DIR: "." },
    cwd: parent,
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => relative.on("exit", resolve));
  assert.equal(code, 3);
  await stopped(first);
});

test("one installation serves a repository: another is refused, a restart resumes, --take-over stops the old one and a clean stop frees it", async () => {
  const api = `http://127.0.0.1:${await closedPort()}`;
  const first = installation();
  configured(first, api);
  // A second installation of the same repository, on the same origin.
  const second = installation();
  const bare = join(first.root, "origin.git");
  mkdirSync(second.root, { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("clone", "--quiet", bare, join(second.root, "checkout"));
  githubOrigin(join(second.root, "checkout"), bare);
  configured(second, api);
  const record = () =>
    git(
      "--git-dir",
      bare,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/factory/holder",
    );
  const named = () =>
    JSON.parse(git("--git-dir", bare, "log", "-1", "--format=%B", record()));

  let serving = serve(first);
  await until(() => record(), "the first installation takes the repository");
  const taken = record();
  const refused = await exited(serve(second), "the refused installation");
  assert.equal(refused.code, 78, refused.stderr);
  assert.match(
    refused.stderr,
    /is served by another installation: .*--take-over/,
  );
  assert.equal(record(), taken, "a refused installation changes nothing");

  // A crash keeps the record; the same installation resumes on it.
  serving.child.kill("SIGKILL");
  await exited(serving, "the killed holder");
  serving = serve(first);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(serving.child.exitCode, null, "the restart serves");
  assert.equal(record(), taken);

  // A deliberate take-over: the running holder stops at its next check.
  const taker = serve(second, undefined, [], ["--take-over"]);
  await until(() => record() && record() !== taken, "the take-over");
  const holder = named();
  const lost = await exited(serving, "the holder that was taken over");
  assert.equal(lost.code, 78, lost.stderr);
  assert.match(
    lost.stderr,
    new RegExp(`took drill/target over: .*${holder.installation}`),
  );

  // A clean stop frees the repository for anyone.
  assert.equal((await stopped(taker)).code, 0);
  assert.equal(record(), "");
  const again = serve(first);
  await until(() => record(), "the first installation takes it again");
  await stopped(again);
});

// The unit is written, never loaded: systemctl only reports it inactive.
test("setup --check judges the unit by the node and PATH it records: a shell with others is current, another Factory or a missing node isn't", () => {
  const inst = installation();
  const units = tempDir("factory-units-");
  inst.env.XDG_CONFIG_HOME = units;
  mkdirSync(inst.root, { recursive: true });
  mkdirSync(join(units, "systemd", "user"), { recursive: true });
  const path = join(
    units,
    "systemd",
    "user",
    unitName({ root: realpathSync(inst.root) }),
  );
  // Another node than the checking shell's, on the unit's PATH only.
  const node = join(tempDir("factory-node-"), "node");
  symlinkSync(process.execPath, node);
  const runtime = {
    node,
    env: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: inst.env.HOME },
  };
  assert.notEqual(inst.env.PATH, runtime.env.PATH);
  const check = (text) => {
    writeFileSync(path, text);
    const report = JSON.parse(cli(inst, "setup", "--check", "--json").out);
    assert.equal(report.service.installed, true, JSON.stringify(report));
    return report;
  };

  const healthy = check(unitText(REPO, [], runtime));
  assert.equal(healthy.service.current, true, JSON.stringify(healthy));
  assert.equal(healthy.service.missingNode, undefined);
  assert.doesNotMatch(healthy.warnings.join("\n"), /another Factory|missing/);

  const upgraded = check(
    unitText(REPO, [], runtime).replace(
      realpathSync(CLI),
      "/opt/factory-0.5.0/dist/cli.js",
    ),
  );
  assert.equal(upgraded.service.current, false);
  assert.match(
    upgraded.warnings.join("\n"),
    /The unit runs another Factory than this one/,
  );

  const gone = join(dirname(node), "gone", "node");
  const missing = check(unitText(REPO, [], { ...runtime, node: gone }));
  assert.equal(missing.service.current, false);
  assert.equal(missing.service.missingNode, gone);
  assert.match(
    missing.warnings.join("\n"),
    new RegExp(`The unit's node ${gone} is missing`),
  );
  assert.doesNotMatch(missing.warnings.join("\n"), /another Factory/);
});
