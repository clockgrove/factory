// A Codex worker checks its own work (#2156). Live (Clockgrove #800), a
// Codex worker had no Validate and wasn't told its shell has no network or
// dependencies: it tried `pnpm install`, finished with no change, and the
// repair diagnosis asked the operator to restore an environment that worked
// as designed. Claude and Copilot workers had Validate all along.
//
// Codex itself runs here, as the worker launches it (its own home and
// configuration, its namespace launcher): as an app server, which serves the
// worker's MCP tools to a client with no model call, and as `codex exec`
// against a scripted Responses endpoint with a production model's metadata,
// so a model-issued call runs Validate as a worker's model would.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { Codex } from "@openai/codex-sdk";
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

const MODELS = fileURLToPath(
  new URL("fixtures/codex-0.160.0-models.json", import.meta.url),
);

/**
 * A Responses endpoint answering each request with the next scripted output
 * item (then a final message), keeping every request's body.
 */
async function scriptedResponses(script) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = Buffer.concat(chunks);
      const encoding = request.headers["content-encoding"];
      if (encoding === "zstd") body = zlib.zstdDecompressSync(body);
      if (encoding === "gzip") body = zlib.gunzipSync(body);
      if (request.method !== "POST" || !request.url.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body.toString("utf8")));
      const n = requests.length;
      const item = script[n - 1] ?? {
        type: "message",
        role: "assistant",
        id: `msg_${n}`,
        content: [{ type: "output_text", text: "Done." }],
      };
      const event = (data) =>
        response.write(
          `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      event({ type: "response.created", response: { id: `resp_${n}` } });
      event({ type: "response.output_item.done", item });
      event({
        type: "response.completed",
        response: {
          id: `resp_${n}`,
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      });
      response.end();
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((closed) => server.close(closed)),
  };
}

// Live (#800), the worker said no Factory validation tool was exposed: on
// Codex's production models (tool_mode code_mode_only) an MCP tool is by
// default a deferred nested tool of `exec`, named nowhere in the request.
// The tool is declared in exec's description, the worker is told the exact
// call, and a model making it runs Validate.
test("a Codex worker's model on a production model's metadata sees Validate declared and the exact call, and making it inside exec runs Validate, its whole result reaching the model uncut (#2156)", async () => {
  const { worktree, base } = changedCheckout();
  // Long acceptance: the result would pass Codex's 10,000-token tool output.
  const long = item("long", {
    ownedPaths: ["src/feature.js"],
    validation: [required],
    acceptance: Array.from(
      { length: 30 },
      (_, index) =>
        `Criterion ${index}: ${"the result does this exact thing and also that ".repeat(30)}`,
    ),
  });
  const runs = [];
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-2", CAPTURE_OFF, []);
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
  const call = CODEX_VALIDATE_CALL.match(/`([^`]+)`/)[1];
  const endpoint = await scriptedResponses([
    {
      type: "custom_tool_call",
      id: "ctc_1",
      status: "completed",
      call_id: "call_1",
      name: "exec",
      input: call,
    },
  ]);
  const home = codexWorkerHome(
    worktree,
    false,
    [],
    sandbox,
    undefined,
    validation.config(),
  );
  try {
    const codex = new Codex({
      codexPathOverride: home.launcher,
      env: { ...home.env, FACTORY_TEST_RESPONSES_KEY: "test" },
      config: {
        model_provider: "scripted",
        model_providers: {
          scripted: {
            name: "scripted",
            base_url: endpoint.url,
            wire_api: "responses",
            env_key: "FACTORY_TEST_RESPONSES_KEY",
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
        model_catalog_json: MODELS,
      },
    });
    const thread = codex.startThread({
      workingDirectory: worktree,
      approvalPolicy: "never",
      model: "gpt-6.1-sol",
      modelReasoningEffort: "low",
    });
    const turn = await thread.run(
      `Implement the feature.${codexShellNote(false, true, long)}`,
    );
    assert.equal(turn.finalResponse, "Done.");
    assert.equal(endpoint.requests.length, 2);
    const [first, second] = endpoint.requests.map((request) =>
      JSON.stringify(request),
    );
    // The model is told the exact call and the tool's id.
    assert.ok(first.includes(JSON.stringify(call).slice(1, -1)), first);
    assert.ok(first.includes(CODEX_VALIDATION_TOOL_ID));
    // The tool itself is declared to the model, never deferred: it is a
    // nested tool of exec, described with exec's declaration.
    const exec = endpoint.requests[0].input
      .filter((entry) => entry.type === "additional_tools")
      .flatMap((entry) => entry.tools)
      .flatMap((tool) => tool.tools ?? [tool])
      .find((tool) => tool.name === "exec");
    assert.ok(exec, first.slice(0, 2000));
    assert.ok(
      exec.description.includes(
        `### \`${CODEX_VALIDATION_TOOL_ID}\`\nRun this work item's declared validation commands`,
      ),
      exec.description.slice(-3000),
    );
    // Its call ran Validate on the worker's files.
    assert.deepEqual(
      runs
        .filter((event) => event.event === "worker-validate")
        .map((event) => event.passed),
      [true],
    );
    // What the model got back is the whole result, which Codex didn't cut.
    const output = endpoint.requests[1].input
      .filter((entry) => entry.type === "custom_tool_call_output")
      .flatMap((entry) => entry.output)
      .map((part) => part.text)
      .join("");
    assert.ok(
      output.includes(
        `All 1 declared validation commands passed:\n- ${required.command}`,
      ),
      output.slice(0, 2000),
    );
    assert.ok(!/truncated/i.test(output), output.slice(0, 2000));
    assert.ok(output.includes("are not repeated here"), second.slice(-2000));
    assert.ok(output.includes(`[0] ${long.acceptance[0]}\n`));
  } finally {
    await endpoint.close();
    await validation.close();
    rmSync(home.root, { recursive: true, force: true });
  }
});
