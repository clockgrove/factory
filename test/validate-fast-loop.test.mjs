// clockgrove/factory#2281: a worker's inner loop is edit, Validate, read the
// failure, fix. Each Validate ran every declared command in order, so a
// worker failing on its 4th command paid for the install and three
// unrelated commands before each verdict that mattered. Validate now takes
// the indices of the commands to run (a targeted run, which never counts
// for handoff), runs the command that failed last first on a full run, and
// logs the call's feedback latency. Real Git and the real sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { validateToolShape } from "../dist/providers/claude-worker.js";
import { CodexValidate } from "../dist/providers/codex-validate.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { runOrder } from "../dist/validate.js";
import {
  FinishRequests,
  SelfValidation,
  VALIDATION_TOOL_INPUT,
  validateRequest,
  validationTargets,
} from "../dist/work/self-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const BOOTSTRAP = "pnpm install --frozen-lockfile --ignore-scripts";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function loaded() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return { ...loadConfig(REPO), logs: inst.logs };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";

// Three checks, each passing once the worker's src/state.txt says so.
const CHECKS = ["a", "b", "c"].map((name) => ({
  command: `sh check-${name}.sh`,
}));
const work = item("loop", { ownedPaths: ["src/**"], validation: CHECKS });

/** A worker's checkout at its base, its Validate, and what it logged. */
function workerValidate() {
  const { sandbox, logs } = loaded();
  const worktree = join(tempDir("factory-fast-loop-"), "w");
  mkdirSync(join(worktree, "src"), { recursive: true });
  git(worktree, "init", "--quiet");
  for (const name of ["a", "b", "c"])
    writeFileSync(
      join(worktree, `check-${name}.sh`),
      `grep -q "${name} ok" src/state.txt\n`,
    );
  writeFileSync(join(worktree, "src", "state.txt"), "\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  const base = git(worktree, "rev-parse", "HEAD");
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
  const events = [];
  const signal = AbortSignal.timeout(300_000);
  const input = {
    worktree,
    prompt: "",
    item: work,
    commands: CHECKS.map((check) => check.command),
    base,
    signal,
    log: (event) => events.push(event),
    activity: () => {},
    output: () => {},
    runFile: (kind) => log.runFile(1, `item:loop:work#1.${kind}`),
  };
  const options = {
    sandbox,
    plan: plan([work], { base }),
    blocks: [],
    repository: REPO,
    commandTimeoutMs: 60_000,
  };
  return {
    worktree,
    input,
    options,
    events,
    validator: new SelfValidation(input, options, signal),
    state: (text) => writeFileSync(join(worktree, "src", "state.txt"), text),
  };
}

/** The indices of the commands each Validate run ran, in order, and its worker-validate event. */
function runs(events) {
  const out = [];
  let ran = [];
  for (const event of events)
    if (event.event === "validation-command") ran.push(event.index);
    else if (event.event === "worker-validate") {
      out.push({ ran, event });
      ran = [];
    }
  return out;
}

test("the run's order keeps the exact install first, each command once", () => {
  const commands = ["sh a.sh", "sh b.sh", "sh c.sh"];
  assert.deepEqual(runOrder(commands), [0, 1, 2]);
  assert.deepEqual(runOrder(commands, [2, 0, 1]), [2, 0, 1]);
  assert.deepEqual(runOrder(commands, [1, 1, 7, -1, 0.5]), [1]);
  // An install the commands need runs first, whatever the order names.
  const installed = [BOOTSTRAP, ...commands];
  assert.deepEqual(runOrder(installed, [3]), [0, 3]);
  assert.deepEqual(runOrder(installed, [2, 0, 1, 3]), [0, 2, 1, 3]);
  assert.deepEqual(runOrder(installed), [0, 1, 2, 3]);
});

test("every worker's Validate takes the targeted commands' indices, or none", () => {
  // Codex's and Copilot's JSON Schema, and Claude's Zod, say the same.
  assert.deepEqual(VALIDATION_TOOL_INPUT.properties.commands.items, {
    type: "integer",
    minimum: 0,
  });
  assert.equal(VALIDATION_TOOL_INPUT.additionalProperties, false);
  const claude = z.object(validateToolShape(z)).strict();
  for (const [args, targets] of [
    [undefined, {}],
    [{}, {}],
    [{ commands: [] }, { commands: [] }],
    [{ commands: [0, 2] }, { commands: [0, 2] }],
  ]) {
    assert.deepEqual(validationTargets(args), targets);
    assert.equal(claude.safeParse(args ?? {}).success, true);
  }
  for (const args of [
    { commands: [-1] },
    { commands: [1.5] },
    { commands: "1" },
    { command: 1 },
    [1],
  ]) {
    assert.ok("problem" in validationTargets(args), JSON.stringify(args));
    assert.equal(claude.safeParse(args).success, false, JSON.stringify(args));
  }
});

test("a targeted run runs only its commands and never counts for handoff; a full run runs the last failing command first", {
  skip,
}, async () => {
  const { validator, events, state } = workerValidate();
  // A full run, in declared order: the 2nd command fails.
  state("a ok\n");
  const failed = await validator.call();
  assert.equal(failed.isError, false, failed.text);
  assert.ok(failed.text.startsWith("Validation failed."), failed.text);
  assert.match(failed.text, /That is command 1: .*`commands: \[1\]`/);
  // An index no declared command has runs nothing and lists them.
  const unknown = await validator.call([3]);
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /3 is not the index of a declared command/);
  assert.match(
    unknown.text,
    /\n0: sh check-a\.sh\n1: sh check-b\.sh\n2: sh check-c\.sh$/,
  );
  // The fix, checked by a targeted run of that command alone.
  state("a ok\nb ok\n");
  const targeted = await validator.call([1]);
  assert.equal(targeted.isError, false, targeted.text);
  assert.ok(
    targeted.text.startsWith(
      "The 1 commands of this targeted run passed:\n- sh check-b.sh\nA targeted run never validates your result",
    ),
    targeted.text,
  );
  // It covers nothing for handoff: the worker is still asked to validate.
  assert.equal(await validator.finalTree(), false);
  const race = (operation) => operation;
  assert.equal(
    await new FinishRequests(validator, true, work).next(race),
    validateRequest(work),
  );
  // A full run, now in declared order again: the 3rd command fails.
  const third = await validator.call();
  assert.ok(third.text.startsWith("Validation failed."), third.text);
  // The next full run runs it first, and stops there while it fails...
  await validator.call();
  // ...and once it passes, every declared command still runs.
  state("a ok\nb ok\nc ok\n");
  const passed = await validator.call();
  assert.ok(
    passed.text.startsWith("All 3 declared validation commands passed:"),
    passed.text,
  );
  assert.match(String(await validator.finalTree()), /^[0-9a-f]{40}$/);
  // Naming every declared command is a full run, in declared order.
  const every = await validator.call([2, 1, 0]);
  assert.ok(every.text.startsWith("All 3 declared"), every.text);
  const logged = runs(events);
  assert.deepEqual(
    logged.map(({ ran }) => ran),
    [[0, 1], [1], [0, 1, 2], [2], [2, 0, 1], [0, 1, 2]],
  );
  assert.deepEqual(
    logged.map(({ event }) => [
      event.passed,
      event.targeted,
      event.firstCommand,
    ]),
    [
      [false, undefined, undefined],
      [true, [1], undefined],
      [false, undefined, undefined],
      [false, undefined, 2],
      [true, undefined, 2],
      [true, undefined, undefined],
    ],
  );
  // Feedback latency: the call's time, the time from the last edit to the
  // verdict, and what its passing commands took of it.
  for (const { event } of logged) {
    assert.ok(Number.isInteger(event.durationMs) && event.durationMs > 0);
    assert.ok(event.sinceEditMs >= event.durationMs, JSON.stringify(event));
    assert.ok(event.passedMs >= 0 && event.passedMs <= event.durationMs);
  }
  assert.equal(logged[3].event.passedMs, 0);
});

/** JSON-RPC requests to an MCP server's socket; the answers, by id. */
function rpc(socket, requests) {
  return new Promise((answered, failed) => {
    const client = connect(socket);
    const answers = new Map();
    let buffered = "";
    client.setEncoding("utf8");
    client.on("error", failed);
    client.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        answers.set(message.id, message);
      }
      if (answers.size === requests.length) {
        client.end();
        answered(answers);
      }
    });
    for (const [id, [method, params]] of requests.entries())
      client.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: id + 1, method, params })}\n`,
      );
  });
}

test("a Codex worker's Validate lists its commands argument and runs a targeted run through it", {
  skip,
}, async () => {
  const { input, options, events, state } = workerValidate();
  state("a ok\nb ok\n");
  const validation = await CodexValidate.start(input, options);
  assert.ok(validation instanceof CodexValidate, JSON.stringify(validation));
  const socket = JSON.parse(validation.config().match(/\nargs = (.*)\n/)[1]).at(
    -1,
  );
  try {
    const call = (args) => [
      "tools/call",
      { name: "run_validation", arguments: args },
    ];
    // Queued one at a time, so the answers come in this order.
    const answers = await rpc(socket, [
      ["tools/list", {}],
      call({ commands: [1] }),
      call({ commands: [5] }),
      call({ only: [1] }),
    ]);
    const [listed] = answers.get(1).result.tools;
    assert.deepEqual(listed.inputSchema, VALIDATION_TOOL_INPUT);
    const targeted = answers.get(2).result;
    assert.equal(targeted.isError, false);
    assert.match(
      targeted.content[0].text,
      /^The 1 commands of this targeted run passed:\n- sh check-b\.sh\n/,
    );
    assert.equal(answers.get(3).result.isError, true);
    assert.match(answers.get(3).result.content[0].text, /5 is not the index/);
    assert.equal(answers.get(4).result.isError, true);
    assert.match(
      answers.get(4).result.content[0].text,
      /^run_validation did not run: it takes only `commands`, not only$/,
    );
    assert.deepEqual(
      runs(events).map(({ ran, event }) => [ran, event.targeted]),
      [[[1], [1]]],
    );
  } finally {
    await validation.close();
    rmSync(input.worktree, { recursive: true, force: true });
  }
});
