// A Codex worker checks its own work (#2156). Live (Clockgrove #800), a
// Codex worker had no Validate and wasn't told its shell has no network or
// dependencies: it tried `pnpm install`, finished with no change, and the
// repair diagnosis asked the operator to restore an environment that worked
// as designed. Claude and Copilot workers had Validate all along.
//
// Codex itself runs here, as the worker launches it (its own home and
// configuration, its namespace launcher), as an app server: that serves the
// worker's MCP tools to a client with no model call, so Codex's own MCP
// client runs Factory's Validate through the configuration the worker gets.
// What a model is shown needs a model: no fake provider runs here
// (AGENTS.md), so that is the Codex worker integration cases'.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { itemValidates, workers } from "../dist/planning/steps.js";
import { shellPrompt } from "../dist/providers/claude-worker.js";
import {
  CODEX_VALIDATE_CALL,
  CODEX_VALIDATION_TOOL_ID,
  CodexValidate,
} from "../dist/providers/codex-validate.js";
import {
  codexShellNote,
  codexWorkerHome,
} from "../dist/providers/codex-worker.js";
import { workerCapability } from "../dist/planning/rubric.js";
import { profileWorker } from "../dist/providers/selection.js";
import { LaunchedGroup } from "../dist/sandbox.js";
import {
  criterionMap,
  FinishRequests,
  VALIDATE_RESULT_CHARS,
  validateRequest,
} from "../dist/work/self-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

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

const { sandbox, logs } = loaded();
// No operator login reaches these Codex homes, and no model is called.
process.env.CODEX_HOME = tempDir("factory-no-login-");
process.env.XDG_CACHE_HOME = tempDir("factory-cache-");

const required = { command: "test -f src/feature.js" };
const feature = item("feature", {
  ownedPaths: ["src/feature.js"],
  validation: [required],
});

/** A checkout at its base with the worker's uncommitted change. */
function changedCheckout() {
  const worktree = join(tempDir("factory-codex-validate-"), "w");
  mkdirSync(join(worktree, "src"), { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "README.md"), "base\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  const base = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "src", "feature.js"), "exports.feature = 1;\n");
  return { worktree, base };
}

/** Codex's app server, started as the worker starts codex, and a JSON-RPC client for it. */
function appServer(home, cwd) {
  const child = spawn(home.launcher, ["app-server"], {
    cwd,
    env: home.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const group = new LaunchedGroup(home.pidFile, new AbortController().signal);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  let next = 0;
  return {
    request(method, params) {
      const id = next++;
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(
          () =>
            reject(new Error(`${method} timed out: ${stderr.slice(-2000)}`)),
          120_000,
        ).unref();
      });
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ method })}\n`);
    },
    end() {
      child.stdin.end();
      group.end();
    },
  };
}

test("a Codex worker's Codex runs Validate through Factory's MCP server: the item's declared commands on a snapshot of its files, reached by Codex and never by the worker's shell (#2156)", async () => {
  const { worktree, base } = changedCheckout();
  const runs = [];
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
  const signal = AbortSignal.timeout(300_000);
  const input = {
    worktree,
    prompt: "",
    item: feature,
    commands: [required.command],
    base,
    signal,
    log: (event) => runs.push(event),
    activity: () => {},
    output: () => {},
    runFile: (kind) => log.runFile(1, `item:feature:work#1.${kind}`),
  };
  const validation = await CodexValidate.start(input, {
    sandbox,
    plan: plan([feature], { base }),
    blocks: [],
    repository: REPO,
    commandTimeoutMs: 60_000,
  });
  assert.ok(validation instanceof CodexValidate, JSON.stringify(validation));
  assert.equal(validation.tool, true);
  const config = validation.config();
  // A validation takes minutes: Codex's 60 s default would cut it off.
  assert.match(
    config,
    new RegExp(`\\ntool_timeout_sec = ${validation.deadlineMs / 1000}\\n`),
  );
  // Never deferred: on Codex's production models (tool_mode
  // code_mode_only) a deferred MCP tool is named nowhere in the model's
  // request, as #800's worker found; kept out of the deferred tools, it is
  // declared in exec's description. Codex reads the variant (one of
  // code_mode, deferred, direct) when the app server below loads this
  // configuration, and refuses an unknown one.
  assert.ok(config.includes('\nomit_tools_from = ["deferred"]\n'), config);
  // A code-mode model calls Validate from an exec cell, which would yield
  // to the model after about 30 s and leave it polling with `wait` (#2167):
  // the cell's default yield is the call's own timeout, so it blocks. Codex
  // reads it when the app server below loads this configuration.
  assert.ok(
    config.includes(
      `\n[features.code_mode]\ndefault_exec_yield_time_ms = ${validation.deadlineMs}\n`,
    ),
    config,
  );
  const socket = JSON.parse(config.match(/\nargs = (.*)\n/)[1]).at(-1);
  // Only this user reaches the socket's directory.
  assert.equal(statSync(dirname(socket)).mode & 0o777, 0o700);
  const home = codexWorkerHome(worktree, false, [], sandbox, undefined, config);
  const codex = appServer(home, worktree);
  try {
    await codex.request("initialize", {
      clientInfo: { name: "factory-test", version: "0" },
    });
    codex.notify("initialized");
    const { thread } = await codex.request("thread/start", {
      cwd: worktree,
      approvalPolicy: "never",
    });
    // Codex lists the tool from Factory's server, as the model sees it.
    const listed = await codex.request("mcpServerStatus/list", {
      threadId: thread.id,
      serverName: "factory-validation",
    });
    assert.match(JSON.stringify(listed), /"run_validation"/);
    // A turn that finishes before any passing Validate is asked to
    // validate, once, on the same thread, as a Claude worker's is.
    // A Codex worker's request says how to call it (CODEX_VALIDATE_CALL).
    const unvalidated = new FinishRequests(
      validation.validator,
      true,
      feature,
      CODEX_VALIDATE_CALL,
    );
    const race = (operation) => operation;
    assert.equal(
      await unvalidated.next(race),
      `${validateRequest(feature)} ${CODEX_VALIDATE_CALL}`,
    );
    assert.equal(await unvalidated.next(race), undefined);
    const called = await codex.request("mcpServer/tool/call", {
      threadId: thread.id,
      server: "factory-validation",
      tool: "run_validation",
      arguments: {},
    });
    assert.notEqual(called.isError, true, JSON.stringify(called));
    const text = called.content.map((part) => part.text).join("");
    assert.ok(
      text.startsWith(
        `All 1 declared validation commands passed:\n- ${required.command}`,
      ),
      text,
    );
    assert.deepEqual(
      runs
        .filter((event) => event.event === "worker-validate")
        .map((event) => event.passed),
      [true],
    );
    // The worker's result is the tree Validate passed, and a finished turn
    // on it is asked nothing more.
    const tree = await validation.validator.finalTree();
    assert.match(String(tree), /^[0-9a-f]{40}$/);
    assert.equal(
      await new FinishRequests(validation.validator, true, feature).next(race),
      undefined,
    );
    // The worker's own shell, under the same configuration, can't reach
    // the server: only Codex can.
    const shell = await codex.request("command/exec", {
      command: [
        process.execPath,
        "-e",
        `require("node:net").connect(${JSON.stringify(socket)}).on("connect",()=>{console.log("connected");process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(3)})`,
      ],
      cwd: worktree,
    });
    // The command ran there, and its connection was refused.
    assert.equal(shell.exitCode, 3, JSON.stringify(shell));
    assert.match(shell.stdout, /^(ENOENT|EACCES|EPERM)\n$/);
  } finally {
    codex.end();
    await validation.close();
    rmSync(home.root, { recursive: true, force: true });
  }
});

// Live (Clockgrove #800), one Codex worker call made 65 `wait` rounds
// during 27 minutes of Validate, an estimated 6M tokens: Codex code mode's
// exec yielded after about 30 s and the model polled the running call. The
// fixture is the session record of live Codex 0.160.0 threads whose
// Validate (a stand-in MCP tool that sleeps, tool_timeout_sec 900) took
// 180 s with Codex's default exec yield, as 0.5.8 configured it, and 45 s
// with `default_exec_yield_time_ms = 3600000`: an exec cell whose yield
// outlasts the call blocks until the call answers. So the worker's Codex
// home must give the cell a yield at least the call's own timeout, as Codex
// reads that home; then the recorded blocking run's rounds are the worker's,
// as its model-usage event reports them.
test("a running Validate costs a Codex worker no model rounds, and the rounds spent only waiting on a running tool are reported (#2167)", async () => {
  const { codexTelemetry } = await import(
    "../dist/providers/codex-telemetry.js"
  );
  const recorded = JSON.parse(
    readFileSync(
      new URL("./fixtures/codex-0.160.0-validate-wait.json", import.meta.url),
      "utf8",
    ),
  );
  // The configuration Codex reads from a Codex worker's home with Validate.
  const { worktree, base } = changedCheckout();
  const validation = await CodexValidate.start(
    {
      worktree,
      prompt: "",
      item: feature,
      commands: [required.command],
      base,
      signal: AbortSignal.timeout(300_000),
      log: () => {},
      activity: () => {},
      output: () => {},
      runFile: () => undefined,
    },
    {
      sandbox,
      plan: plan([feature], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
  );
  assert.ok(validation instanceof CodexValidate, JSON.stringify(validation));
  const home = codexWorkerHome(
    worktree,
    false,
    [],
    sandbox,
    undefined,
    validation.config(),
  );
  const codex = appServer(home, worktree);
  let read;
  try {
    await codex.request("initialize", {
      clientInfo: { name: "factory-test", version: "0" },
    });
    codex.notify("initialized");
    ({ config: read } = await codex.request("config/read", { cwd: worktree }));
  } finally {
    codex.end();
    await validation.close();
    rmSync(home.root, { recursive: true, force: true });
  }
  const timeoutMs =
    read.mcp_servers["factory-validation"].tool_timeout_sec * 1000;
  assert.equal(timeoutMs, validation.deadlineMs);
  const yieldMs = read.features?.code_mode?.default_exec_yield_time_ms;
  assert.equal(typeof yieldMs, "number", JSON.stringify(read.features));
  // The cell never yields while the call may still answer...
  assert.ok(yieldMs >= timeoutMs, `${yieldMs} < ${timeoutMs}`);
  // ...and outlasts the recorded call that blocked, unlike Codex's default
  // yield, which returned to the model while the polling run's call ran.
  const exec = (rollout) => {
    const call = rollout.find(
      (entry) => entry.payload.type === "custom_tool_call",
    );
    const output = rollout.find(
      (entry) =>
        entry.payload.type === "custom_tool_call_output" &&
        entry.payload.call_id === call.payload.call_id,
    );
    return {
      ms: Date.parse(output.timestamp) - Date.parse(call.timestamp),
      text: JSON.stringify(output.payload.output),
    };
  };
  const blocked = exec(recorded.blocking);
  assert.match(blocked.text, /Script completed/);
  assert.ok(yieldMs > blocked.ms, `${yieldMs} <= ${blocked.ms}`);
  assert.match(exec(recorded.polling).text, /Script running/);
  const telemetry = (rollout) => {
    const home = tempDir("factory-codex-home-");
    const day = join(home, "sessions", "2026", "10", "28");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-10-28T16-44-49-thread.jsonl"),
      rollout.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    return codexTelemetry(home, "thread");
  };
  // As 0.5.8 configured it: exec yielded, and 15 of the 16 rounds only
  // waited on the running call.
  const polling = telemetry(recorded.polling);
  assert.deepEqual(polling.nativeToolActivity.byName, { exec: 1, wait: 15 });
  assert.equal(polling.nativeTools.rounds, 16);
  assert.equal(polling.nativeTools.waitRounds, 15);
  // With a yield past the call, as the worker's home sets it: one round to
  // call it, none while it ran.
  const blocking = telemetry(recorded.blocking);
  assert.deepEqual(blocking.nativeToolActivity.byName, { exec: 1 });
  assert.equal(blocking.nativeTools.rounds, 1);
  assert.equal(blocking.nativeTools.waitRounds, 0);
  assert.equal(blocking.nativeTools.outputs, 1);
  assert.ok(blocking.nativeTools.ms >= 45_000, blocking.nativeTools.ms);
});

// A model-usage event logged before 0.5.9 (all of #800's), or by a provider
// that never counts wait rounds, has no `waitRounds`: analysis must say the
// figure is unknown there, never that no round only waited.
test("diagnostics --analyze counts wait rounds only over the calls that report them, and says unknown when none does (#2167)", async () => {
  const { analyze } = await import("../dist/analysis.js");
  const usage = (at, nativeTools) => ({
    at,
    step: "item:feature:work",
    event: "model-usage",
    role: "worker",
    phase: "work",
    provider: "codex",
    model: "m",
    outcome: "done",
    ms: 1000,
    tokens: { input: 10, output: 1, total: 11 },
    costUsd: null,
    nativeTools,
  });
  const read = (issue, events) => {
    const directory = join(logs, String(issue));
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "2026-01-01T00-00-00-000Z-3.jsonl"),
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    const options = {
      logs,
      issue,
      runs: { kind: "latest" },
      secrets: [],
      groupBy: ["phase"],
      filters: {},
    };
    let text = "";
    analyze(options, (chunk) => {
      text += chunk;
    });
    let json = "";
    analyze({ ...options, json: true }, (chunk) => {
      json += chunk;
    });
    return { text, stats: JSON.parse(json).calls.toolStats };
  };
  const old = { rounds: 705, outputs: 706, failures: 0, ms: 1000 };
  const unknown = read(21671, [
    usage("2026-01-01T00:00:01.000Z", old),
    usage("2026-01-01T00:00:02.000Z", { ...old, rounds: 127 }),
  ]);
  assert.equal(unknown.stats.waitRounds, 0);
  assert.equal(unknown.stats.waitRoundsReported, 0);
  assert.equal(unknown.stats.reportedCalls, 2);
  assert.match(
    unknown.text,
    /native tool calls: 832 rounds \(only waiting on a running tool: unknown, 0\/2 calls report it\) · 1412 outputs/,
  );
  // One call reports 15, the other nothing: 15 over the one that reports.
  const mixed = read(21672, [
    usage("2026-01-01T00:00:01.000Z", old),
    usage("2026-01-01T00:00:02.000Z", { ...old, rounds: 16, waitRounds: 15 }),
  ]);
  assert.equal(mixed.stats.waitRounds, 15);
  assert.equal(mixed.stats.waitRoundsReported, 1);
  assert.match(
    mixed.text,
    /native tool calls: 721 rounds \(15 only waiting on a running tool, 1\/2 calls report it\) · 1412 outputs/,
  );
});

test("a Codex worker without declared commands has no Validate, and its prompt says so", async () => {
  const { worktree, base } = changedCheckout();
  const bare = item("bare", { ownedPaths: ["src/feature.js"] });
  const validation = await CodexValidate.start(
    {
      worktree,
      prompt: "",
      item: bare,
      commands: [],
      base,
      signal: AbortSignal.timeout(60_000),
      log: () => {},
      activity: () => {},
      output: () => {},
      runFile: () => undefined,
    },
    {
      sandbox,
      plan: plan([bare], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
  );
  assert.ok(validation instanceof CodexValidate);
  assert.equal(validation.tool, false);
  assert.equal(validation.config(), "");
  await validation.close();
  const note = codexShellNote(false, false, bare);
  assert.ok(!note.includes("run_validation"), note);
  assert.ok(
    note.includes(
      "You have no tool that runs the declared validation: Factory runs it after you finish.",
    ),
  );
});

test("a Codex worker's prompt tells the truth about its own shell: network, dependencies, .git, /tmp, how Factory collects and validates its result, and Validate (#2156)", () => {
  for (const network of [false, true])
    for (const validating of [false, true]) {
      const note = codexShellNote(network, validating, feature);
      for (const fact of [
        "Your shell runs in Codex's sandbox, which differs from Factory's validation environment.",
        "The repository's dependencies are not installed in your checkout",
        "Your checkout's .git is read-only.",
        "You have a private writable $TMPDIR but no /tmp or /var/tmp",
        "Factory collects your uncommitted changes as a new commit on your checkout's HEAD and validates that commit in a fresh checkout, so a check of HEAD there sees your result",
        "If Factory's validation fails after you finish, the failure comes back to you with the command's output.",
        "do not change files, propose ownership or ask for another environment for that alone",
      ])
        assert.ok(note.includes(fact), `${network}/${validating}: ${fact}`);
      assert.equal(
        note.includes(
          "It has no network: no package registry, and no service on the host's loopback.",
        ),
        !network,
      );
      assert.equal(note.includes("It shares the host's network."), network);
      assert.equal(
        note.includes(
          "Your Validate tool runs this Work Item's declared validation commands as Factory will: the exact locked install, then each command, in Factory's validation sandbox",
        ),
        validating,
      );
      // Codex's production models don't see the tool listed: the note
      // names the exact call (see the `codex exec` test below).
      assert.equal(note.includes(CODEX_VALIDATE_CALL), validating);
    }
  // Codex names an MCP tool mcp__<server>__<tool>, the server's - as _.
  assert.equal(
    CODEX_VALIDATION_TOOL_ID,
    "mcp__factory_validation__run_validation",
  );
  assert.ok(
    CODEX_VALIDATE_CALL.includes(
      "Inside exec, call it as `const result = await tools.mcp__factory_validation__run_validation({});",
    ),
    CODEX_VALIDATE_CALL,
  );
});

test("a Claude worker's shell prompt tells the same truth: no installed dependencies, a read-only .git, how Factory collects its result, and Validate for what needs dependencies (#2156)", () => {
  for (const network of ["off", "package-install", "host"]) {
    const prompt = shellPrompt({ network });
    for (const fact of [
      "which differs from Factory's validation environment: use it to inspect files, compute values and run what needs no dependencies.",
      "The repository's dependencies are not installed in your checkout",
      "Your checkout's .git is read-only.",
      "Factory collects your uncommitted changes as a new commit on your checkout's HEAD and validates that commit in a fresh checkout, so a check of HEAD there sees your result",
      "Validate runs this Work Item's declared validation commands as Factory will: the exact locked install, then each command",
      "use it instead of installing dependencies or running those commands in your shell.",
      "do not change files, propose ownership or ask for another environment for that alone; check with Validate instead.",
    ])
      assert.ok(prompt.includes(fact), `${network}: ${fact}`);
    assert.equal(
      prompt.includes("without a network they can't be"),
      network !== "host",
      network,
    );
    assert.ok(!prompt.includes("build and test"), prompt);
  }
});

test("planning is told a Codex worker has its shell and Validate, where dependencies come from, and that a worker without Validate runs nothing (#2156)", () => {
  const providers = {
    codex: { planner: "codex", worker: { kind: "codex", network: "off" } },
    copilot: {
      planner: "copilot",
      worker: { kind: "copilot", model: "m", tools: ["view"] },
    },
  };
  const access = workers(
    {
      providers,
      execution: {
        profiles: {
          codex: { provider: "codex" },
          files: { provider: "copilot" },
        },
      },
    },
    providers.codex,
  );
  assert.deepEqual(access, { codex: "shell", files: "none" });
  const told = workerCapability(access);
  for (const statement of [
    "Workers on profile codex have a sandboxed shell and Validate: Validate runs the item's validation commands as Factory will, after the exact locked install, and returns their output and the Git-ignored files they write under the item's owned paths; the shell runs other commands in the checkout, where the repository's dependencies are not installed.",
    "Workers on profile files cannot run any command, not even the item's validation commands: Factory runs those after they finish and returns a failure's output to them",
  ])
    assert.ok(told.includes(statement), told);
  assert.deepEqual(profileWorker(providers.codex, false, "off").tools, [
    "sandboxed shell",
    "Validate",
  ]);
});

// Without execution profiles (the default configuration) the planner was
// told every worker had a shell, whatever the Objective's provider: a
// Copilot worker has none, and Validate only when its tools list it.
test("without execution profiles, planning is told what the Objective's own provider's worker can execute, and repair diagnosis whether it has Validate (#2156)", () => {
  const claude = (tools) => ({
    planner: "claude",
    worker: {
      kind: "claude",
      ...(tools && { settings: { tools, allowedTools: tools } }),
    },
  });
  const cases = [
    [{ planner: "codex", worker: { kind: "codex", network: "off" } }, "shell"],
    [
      {
        planner: "copilot",
        worker: { kind: "copilot", model: "m", tools: ["view"] },
      },
      "none",
    ],
    [
      {
        planner: "copilot",
        worker: { kind: "copilot", model: "m", tools: ["view", "Validate"] },
      },
      "validation-only",
    ],
    // Claude's defaults grant Write and Validate.
    [claude(), "shell"],
    [claude(["Read", "Edit", "Validate"]), "validation-only"],
    [claude(["Read", "Edit", "Write"]), "none"],
  ];
  const checked = item("checked", {
    ownedPaths: ["src/feature.js"],
    validation: [required],
  });
  const unchecked = item("unchecked", { ownedPaths: ["src/other.js"] });
  for (const [provider, access] of cases) {
    const config = { providers: { own: provider }, execution: {} };
    const told = workers(config, provider);
    assert.deepEqual(told, { default: access }, JSON.stringify(provider));
    const capability = workerCapability(told);
    assert.equal(
      capability.includes("have a sandboxed shell"),
      access === "shell",
      capability,
    );
    assert.equal(
      itemValidates(config, provider, checked),
      access !== "none",
      JSON.stringify(provider),
    );
    // An item with no declared commands has no Validate to run.
    assert.equal(itemValidates(config, provider, unchecked), false);
  }
  assert.equal(
    workerCapability({ default: "none" }),
    "Worker capability. Workers cannot run any command, not even the item's validation commands: Factory runs those after they finish and returns a failure's output to them; they read and write files in the checkout.",
  );
  // An item on a profile is judged by that profile's provider's worker.
  const copilot = cases[1][0];
  const profiled = {
    providers: { own: cases[0][0], files: copilot },
    execution: { profiles: { files: { provider: "files" } } },
  };
  assert.equal(
    itemValidates(profiled, cases[0][0], {
      ...checked,
      executionProfile: { id: "files" },
    }),
    false,
  );
  assert.equal(itemValidates(profiled, cases[0][0], checked), true);
});

test("Validate's criterion map stays within its bound and never cuts a criterion: note excerpts shorten first, then whole criteria are named instead of shown (#2156)", () => {
  const acceptance = Array.from(
    { length: 30 },
    (_, index) =>
      `Criterion ${index}: ${"the result does this exact thing and also that ".repeat(30)}end ${index}.`,
  );
  const notes = acceptance.map((_, criterionIndex) => ({
    kind: "verification",
    criterionIndex,
    summary: `Proved ${criterionIndex} by ${"checking it closely ".repeat(40)}`,
  }));
  const whole = criterionMap(acceptance, notes);
  assert.ok(whole.length > VALIDATE_RESULT_CHARS);
  for (const bound of [20_000, 45_000, 60_000]) {
    const map = criterionMap(acceptance, notes, bound);
    assert.ok(map.length <= bound, `${map.length} > ${bound}`);
    // Every criterion it shows is whole, and the rest are named.
    const shown = [...map.matchAll(/^\[(\d+)\] /gm)].map(([, n]) => Number(n));
    assert.ok(shown.length, map);
    for (const index of shown)
      assert.ok(map.includes(`[${index}] ${acceptance[index]}\n`));
    if (shown.length < acceptance.length)
      assert.ok(
        map.includes(
          `Criteria [${shown.length}] to [29] are not repeated here, to keep this result within the tool output limit: compare each with its note from the acceptance list in your instructions.`,
        ),
        map,
      );
  }
  // Short notes and few criteria are shown whole, as before.
  const few = criterionMap(acceptance.slice(0, 3), notes.slice(0, 3), 30_000);
  assert.equal(few, criterionMap(acceptance.slice(0, 3), notes.slice(0, 3)));
});

// Codex keeps 10,000 tokens of a tool's output (each production model's
// truncation_policy) and cuts the middle of a longer one: a 47,176-character
// result for 30 long criteria reached the model cut. Every worker's result
// now fits VALIDATE_RESULT_CHARS.
test("a Validate result for an item with long acceptance fits within VALIDATE_RESULT_CHARS, with the run's outcome first and whole criteria after (#2156)", async () => {
  const { worktree, base } = changedCheckout();
  const long = item("long", {
    ownedPaths: ["src/feature.js"],
    validation: [required],
    acceptance: Array.from(
      { length: 30 },
      (_, index) =>
        `Criterion ${index}: ${"the result does this exact thing and also that ".repeat(30)}`,
    ),
  });
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-2", CAPTURE_OFF, []);
  const runs = [];
  const validation = await CodexValidate.start(
    {
      worktree,
      prompt: "",
      item: long,
      commands: [required.command],
      base,
      signal: AbortSignal.timeout(300_000),
      log: (event) => runs.push(event),
      activity: () => {},
      output: () => {},
      runFile: (kind) => log.runFile(1, `item:long:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([long], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
  );
  assert.ok(validation instanceof CodexValidate, JSON.stringify(validation));
  try {
    const { text, isError } = await validation.validator.call();
    assert.equal(isError, false, text);
    assert.ok(text.length <= VALIDATE_RESULT_CHARS, String(text.length));
    assert.ok(
      text.startsWith(
        `All 1 declared validation commands passed:\n- ${required.command}`,
      ),
      text.slice(0, 500),
    );
    assert.ok(text.includes(`[0] ${long.acceptance[0]}\n`));
    assert.match(
      text,
      /Criteria \[\d+\] to \[29\] are not repeated here, to keep this result within the tool output limit/,
    );
    assert.deepEqual(
      runs
        .filter((event) => event.event === "worker-validate")
        .map((event) => event.passed),
      [true],
    );
  } finally {
    await validation.close();
  }
});
