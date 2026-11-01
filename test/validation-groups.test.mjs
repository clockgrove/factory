// clockgrove/factory#2290: a Work Item's commands whose `after` puts them in
// groups that need nothing of each other run at once, each group in a
// checkout of its own made after the exact install, with a validation slot
// of its own. Results come back in run order, a dependent command still
// waits for what it needs, and a failure only the declared order can vouch
// for is decided by a run in that order. Real Git, real processes and the
// real sandbox; a stand-in pnpm on the PATH writes node_modules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { hostLimits } from "../dist/engine.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { validateTree } from "../dist/validate.js";
import { configured, installation, item, REPO, tempDir } from "./helpers.mjs";

const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";

const BOOTSTRAP = "pnpm install --frozen-lockfile --ignore-scripts";

// The sandbox mounts PATH directories read-only, never one in a shared
// temporary directory, so the stand-in lives beside the tests (ignored).
const tools = mkdtempSync(
  join(dirname(fileURLToPath(import.meta.url)), ".tools-"),
);
after(() => rmSync(tools, { recursive: true, force: true }));
writeFileSync(
  join(tools, "pnpm"),
  "#!/bin/sh\nmkdir -p node_modules/dep && echo installed > node_modules/dep/index.txt\n",
);
chmodSync(join(tools, "pnpm"), 0o755);
process.env.PATH = `${tools}:${process.env.PATH}`;

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// Each slow command needs the install, sleeps and writes its output; the
// check reads the first one's.
const FILES = {
  ".gitignore": "node_modules\nout/\n",
  "package.json": `${JSON.stringify({ name: "target", private: true })}\n`,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "slow.sh":
    'test -f node_modules/dep/index.txt && sleep "$2" && mkdir -p out && echo "$1" > "out/$1"\n',
  "check.sh": "test -f out/a\n",
};

function target(files = FILES) {
  const checkout = tempDir("factory-validation-groups-");
  git(checkout, "init", "--quiet");
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(checkout, path), content);
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  return { checkout, base: git(checkout, "rev-parse", "HEAD") };
}

function sandboxConfig() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const config = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  return { inst, sandbox: { ...config.sandbox, network: "off" } };
}

/**
 * A Work Item's validation of `validation` on a fresh target, with `slots`
 * validation slots free on the host. The answer, the events with the time
 * each was logged, and how long it took.
 */
async function validate(validation, { slots = 2, files } = {}) {
  const { checkout, base } = target(files);
  const { inst, sandbox } = sandboxConfig();
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const work = item("a", { ownedPaths: ["src/**"], validation });
  const events = [];
  hostLimits.configure({
    caps: { worker: 2, cpu: slots, planner: 4, github: 2 },
    reserveMiB: { worker: 0, cpu: 0, planner: 0, github: 0 },
    budgetMiB: Number.MAX_SAFE_INTEGER,
  });
  const started = Date.now();
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.validation`,
    commit: base,
    item: work,
    plan: { base, items: [work], coverage: [], finalCommands: [] },
    blocks: [],
    base,
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push({ ...event, at: Date.now() }),
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
  });
  const ms = Date.now() - started;
  // Every slot is free again, and no group's checkout is left.
  assert.equal(hostLimits.usage().used.cpu, 0);
  assert.equal(existsSync(`${checkout}.validation.groups`), false);
  assert.equal(git(checkout, "worktree", "list").split("\n").length, 1);
  return { result, events, ms };
}

const ran = (events, kind = "validation-command") =>
  events.filter((event) => event.event === kind);

test("independent commands run at once after one install, and a dependent one waits for what it needs", {
  skip,
}, async () => {
  const validation = [
    { command: BOOTSTRAP },
    { command: "sh slow.sh a 3" },
    { command: "sh slow.sh b 3", after: [] },
    { command: "sh check.sh", after: [1] },
  ];
  const grouped = await validate(validation);
  assert.equal(grouped.result.kind, "passed", grouped.result.detail);
  assert.deepEqual(
    grouped.result.results.map((result) => result.command),
    validation.map((check) => check.command),
  );
  const [groups] = ran(grouped.events, "validation-groups");
  assert.deepEqual(groups.groups, [[1, 3], [2]]);
  assert.equal(groups.slots, 2);
  // One install, then each group in its own checkout; the second group's
  // command starts while the first's runs.
  assert.deepEqual(
    ran(grouped.events)
      .map((event) => [event.index, event.group])
      .sort((a, b) => a[0] - b[0]),
    [
      [0, undefined],
      [1, 0],
      [2, 1],
      [3, 0],
    ],
  );
  const at = (kind, index) =>
    ran(grouped.events, kind).find((event) => event.index === index).at;
  assert.ok(at("validation-command", 2) < at("validation-result", 1));
  // The check runs after the command it needs, in its group's checkout.
  assert.ok(at("validation-command", 3) > at("validation-result", 1));

  // No free slot: the same commands one after another, in declared order.
  const sequential = await validate(validation, { slots: 0 });
  assert.equal(sequential.result.kind, "passed", sequential.result.detail);
  assert.deepEqual(ran(sequential.events, "validation-groups"), []);
  assert.deepEqual(
    ran(sequential.events).map((event) => event.index),
    [0, 1, 2, 3],
  );
  console.log(
    `two 3 s commands and a check: ${grouped.ms} ms in groups, ${sequential.ms} ms one after another`,
  );
  assert.ok(
    grouped.ms < sequential.ms - 2000,
    `${grouped.ms} ms in groups, ${sequential.ms} ms one after another`,
  );

  // A failure in the first group, with nothing of the other before it, is
  // the run's, read as in declared order, and stops the other group.
  const failed = await validate([
    { command: BOOTSTRAP },
    { command: "sh slow.sh a 0 && exit 4" },
    { command: "sh slow.sh b 30", after: [] },
  ]);
  assert.equal(failed.result.kind, "failed");
  assert.equal(failed.result.failed.index, 1);
  assert.deepEqual(
    failed.result.results.map((result) => result.command),
    [BOOTSTRAP],
  );
  assert.ok(failed.ms < 20_000, `${failed.ms} ms`);
});

test("a command whose after leaves out what it needs still passes: its failure in a group is decided in declared order", {
  skip,
}, async () => {
  // The check reads out/a but declares it needs nothing.
  const { result, events } = await validate([
    { command: BOOTSTRAP },
    { command: "sh slow.sh a 0" },
    { command: "sh check.sh", after: [] },
  ]);
  assert.equal(result.kind, "passed", result.detail);
  assert.deepEqual(
    ran(events, "validation-groups-rerun").map((event) => event.index),
    [2],
  );
  assert.deepEqual(
    result.results.map((result) => result.command),
    [BOOTSTRAP, "sh slow.sh a 0", "sh check.sh"],
  );
});
