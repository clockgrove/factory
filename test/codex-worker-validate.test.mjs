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
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { workers } from "../dist/planning/steps.js";
import { CodexValidate } from "../dist/providers/codex-validate.js";
import {
  codexShellNote,
  codexWorkerHome,
} from "../dist/providers/codex-worker.js";
import { workerCapability } from "../dist/planning/rubric.js";
import { profileWorker } from "../dist/providers/selection.js";
import { LaunchedGroup } from "../dist/sandbox.js";
import { FinishRequests, validateRequest } from "../dist/work/self-validate.js";
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
    const unvalidated = new FinishRequests(validation.validator, true, feature);
    const race = (operation) => operation;
    assert.equal(await unvalidated.next(race), validateRequest(feature));
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
          "Your run_validation tool (Validate) runs this Work Item's declared validation commands as Factory will: the exact locked install, then each command, in Factory's validation sandbox",
        ),
        validating,
      );
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
  const access = workers({
    providers,
    execution: {
      profiles: {
        codex: { provider: "codex" },
        files: { provider: "copilot" },
      },
    },
  });
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
