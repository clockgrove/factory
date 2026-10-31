// clockgrove/factory#2281: a worker's inner loop is edit, Validate, read the
// failure, fix. Each Validate ran every declared command in order, so a
// worker failing on its 4th command paid for the install and three
// unrelated commands before each verdict that mattered. Validate now takes
// the indices of the commands to run (a targeted run, in declared order,
// which never counts for handoff), and logs the call's feedback latency. A
// full run keeps the declared order: run first, a command that needs an
// earlier one's output failed every full run however it was fixed. Real Git
// and the real sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import {
  toolAllowed,
  validateToolShape,
} from "../dist/providers/claude-worker.js";
import { CodexValidate } from "../dist/providers/codex-validate.js";
import { copilotPermission } from "../dist/providers/copilot.js";
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
const SCRIPTS = Object.fromEntries(
  ["a", "b", "c"].map((name) => [
    `check-${name}.sh`,
    `grep -q "${name} ok" src/state.txt\n`,
  ]),
);
const work = item("loop", { ownedPaths: ["src/**"], validation: CHECKS });

// A build, then a check of what it built (ignored output, as a build's is):
// the check needs the build to have run in the same checkout. A slow
// unrelated command comes after them.
const BUILT = {
  ".gitignore": "out/\n",
  "build.sh": "mkdir -p out && cp src/state.txt out/built\n",
  "check.sh": "test -f out/built && grep -q ok out/built\n",
  "other.sh": "true\n",
};
const dependent = item("built", {
  ownedPaths: ["src/**"],
  validation: ["build", "check", "other"].map((name) => ({
    command: `sh ${name}.sh`,
  })),
});

/**
 * A worker's checkout of `validated` at its base, with `scripts`, its
 * Validate, and what it logged.
 */
function workerValidate({ validated = work, scripts = SCRIPTS } = {}) {
  const { sandbox, logs } = loaded();
  const worktree = join(tempDir("factory-fast-loop-"), "w");
  mkdirSync(join(worktree, "src"), { recursive: true });
  git(worktree, "init", "--quiet");
  for (const [path, content] of Object.entries(scripts))
    writeFileSync(join(worktree, path), content);
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
    item: validated,
    commands: validated.validation.map((check) => check.command),
    base,
    signal,
    log: (event) => events.push(event),
    activity: () => {},
    output: () => {},
    runFile: (kind) => log.runFile(1, `item:${validated.id}:work#1.${kind}`),
  };
  const options = {
    sandbox,
    plan: plan([validated], { base }),
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

test("a run keeps the declared order and the exact install, each command once", () => {
  const commands = ["sh a.sh", "sh b.sh", "sh c.sh"];
  assert.deepEqual(runOrder(commands), [0, 1, 2]);
  // No command runs ahead of one declared before it, whatever is named.
  assert.deepEqual(runOrder(commands, [2, 0, 1]), [0, 1, 2]);
  assert.deepEqual(runOrder(commands, [2, 1]), [1, 2]);
  assert.deepEqual(runOrder(commands, [1, 1, 7, -1, 0.5]), [1]);
  // An install the commands need always runs, first.
  const installed = [BOOTSTRAP, ...commands];
  assert.deepEqual(runOrder(installed, [3]), [0, 3]);
  assert.deepEqual(runOrder(installed, [3, 1]), [0, 1, 3]);
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

test("the Claude and Copilot permission checks admit a targeted run's commands and nothing else", () => {
  // Claude's PreToolUse hook and canUseTool both apply toolAllowed.
  const attempt = {
    config: { tools: [], allowedTools: [] },
    grants: { validate: true },
    input: { worktree: tempDir("factory-validate-gate-") },
  };
  const server = { name: "factory-validation", source: "sdk" };
  const claude = (args, from = server) =>
    toolAllowed(attempt, "mcp__factory-validation__run_validation", args, from);
  // Copilot's request for one of Factory's own tools carries its args.
  const copilot = (args, toolName = "run_validation") =>
    copilotPermission(
      attempt.input.worktree,
      false,
      new Set(["run_validation", "other_tool"]),
    )({ kind: "custom-tool", toolName, args, toolCallId: "call_1" }).kind;
  for (const args of [
    {},
    { commands: [] },
    { commands: [1] },
    { commands: [0, 2] },
  ]) {
    assert.equal(claude(args), true, JSON.stringify(args));
    assert.equal(copilot(args), "approve-once", JSON.stringify(args));
  }
  assert.equal(copilot(undefined), "approve-once");
  for (const args of [
    { commands: [-1] },
    { commands: "1" },
    { commands: [1], command: "rm -rf /" },
    { command: "true" },
  ]) {
    assert.equal(claude(args), false, JSON.stringify(args));
    assert.equal(copilot(args), "reject", JSON.stringify(args));
  }
  // Only from Factory's own server, and only with the grant.
  assert.equal(
    claude({ commands: [1] }, { name: "other", source: "sdk" }),
    false,
  );
  assert.equal(
    toolAllowed(
      { ...attempt, grants: { validate: false } },
      "mcp__factory-validation__run_validation",
      { commands: [1] },
      server,
    ),
    false,
  );
  // Factory's other tools still take no arguments.
  assert.equal(copilot({}, "other_tool"), "approve-once");
  assert.equal(copilot({ commands: [1] }, "other_tool"), "reject");
});

test("a targeted run runs only its commands, in declared order, and never counts for handoff; a full run runs every command in declared order", {
  skip,
}, async () => {
  const { validator, events, state } = workerValidate();
  // A full run, in declared order: the 2nd command fails.
  state("a ok\n");
  const failed = await validator.call();
  assert.equal(failed.isError, false, failed.text);
  assert.ok(failed.text.startsWith("Validation failed."), failed.text);
  assert.match(
    failed.text,
    /That is command 1: .*`commands: \[1\]`.*without command 0 declared before it/,
  );
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
  // A full run, in declared order: the 3rd command fails.
  const third = await validator.call();
  assert.ok(third.text.startsWith("Validation failed."), third.text);
  // Targeted alone, it names the earlier commands it skipped.
  const alone = await validator.call([2]);
  assert.ok(alone.text.startsWith("Validation failed."), alone.text);
  assert.match(
    alone.text,
    /This targeted run skipped commands 0, 1, declared before it: if `sh check-c\.sh` needs/,
  );
  // Named out of order, the targeted commands run in declared order.
  state("a ok\nb ok\nc ok\n");
  const both = await validator.call([2, 1]);
  assert.ok(
    both.text.startsWith(
      "The 2 commands of this targeted run passed:\n- sh check-b.sh\n- sh check-c.sh\n",
    ),
    both.text,
  );
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
    [[0, 1], [1], [0, 1, 2], [2], [1, 2], [0, 1, 2], [0, 1, 2]],
  );
  assert.deepEqual(
    logged.map(({ event }) => [event.passed, event.targeted]),
    [
      [false, undefined],
      [true, [1]],
      [false, undefined],
      [false, [2]],
      [true, [1, 2]],
      [true, undefined],
      [true, undefined],
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

test("a command that needs an earlier one's output passes the full run once fixed, and a targeted run with that one", {
  skip,
}, async () => {
  const { validator, events, state } = workerValidate({
    validated: dependent,
    scripts: BUILT,
  });
  // The check fails on what the build made from the worker's files.
  const failed = await validator.call();
  assert.ok(failed.text.startsWith("Validation failed."), failed.text);
  assert.match(failed.text, /sh check\.sh failed/);
  assert.match(failed.text, /without command 0 declared before it/);
  // Fixed: the next full run passes, the build still first. (Run first,
  // the check would fail every full run, the fix notwithstanding.)
  state("ok\n");
  const passed = await validator.call();
  assert.ok(
    passed.text.startsWith("All 3 declared validation commands passed:"),
    passed.text,
  );
  // The check alone fails without the build, and says what it skipped;
  // with the build named too, it passes.
  const alone = await validator.call([1]);
  assert.ok(alone.text.startsWith("Validation failed."), alone.text);
  assert.match(alone.text, /This targeted run skipped command 0, declared/);
  const built = await validator.call([1, 0]);
  assert.ok(
    built.text.startsWith(
      "The 2 commands of this targeted run passed:\n- sh build.sh\n- sh check.sh\n",
    ),
    built.text,
  );
  assert.deepEqual(
    runs(events).map(({ ran }) => ran),
    [[0, 1], [0, 1, 2], [1], [0, 1]],
  );
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
