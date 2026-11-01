// Shared by the service tests: a throwaway installation, the real service
// and CLI as real processes, seeded state, and waits.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { freezeConfig } from "../dist/providers/selection.js";
import { LaunchedGroup } from "../dist/sandbox.js";

export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
export const REPO = "drill/target";

export function installation() {
  const stateDir = tempDir("factory-test-");
  const root = join(stateDir, REPO.replace("/", "__"));
  const env = {
    ...process.env,
    FACTORY_STATE_DIR: stateDir,
    FACTORY_TICK_MS: "50",
    FACTORY_BACKOFF_MS: "100",
  };
  delete env.FACTORY_CRASH_AT;
  return {
    root,
    objectives: join(root, "objectives"),
    requests: join(root, "requests"),
    logs: join(root, "logs"),
    env,
  };
}

// Every service a test starts is killed at the end, even when a test fails;
// then the temporary directories they used are removed.
export const children = new Set();
const directories = [];
after(async () => {
  const running = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  const exits = running.map(
    (child) => new Promise((resolve) => child.once("exit", resolve)),
  );
  for (const child of running) child.kill("SIGKILL");
  await Promise.all(exits);
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/**
 * Codex's app server, started as Factory starts codex from a private Codex
 * `home` (its launcher, environment and configuration), and a JSON-RPC
 * client for it. No model is called unless a turn is started.
 */
export function codexAppServer(home, cwd) {
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

/**
 * A small real key-value server as a `sandbox.services` entry
 * (work/services.ts): `set KEY VALUE` and `get KEY` on a Unix socket in its
 * directory, and `outside`, whether it reaches a listener on the host's
 * loopback `port`.
 */
export const KV_SERVICE = (port) => ({
  start: `exec node -e 'const net=require("net");const store=new Map();net.createServer((socket)=>socket.once("data",(line)=>{const [command,key,value]=String(line).trim().split(" ");if(command==="outside"){const probe=net.connect(Number(process.env.KV_HOST_PORT),"127.0.0.1");probe.on("connect",()=>{probe.destroy();socket.end("reached")});probe.on("error",()=>socket.end("refused"));return}if(command==="set")store.set(key,value);socket.end(store.get(key)??"none")})).listen(process.env.FACTORY_SERVICE_DIR+"/kv.sock")'`,
  ready: 'test -S "$FACTORY_SERVICE_DIR/kv.sock"',
  environment: {
    KV_SOCKET: "$" + "{FACTORY_SERVICE_DIR}/kv.sock",
    KV_HOST_PORT: String(port),
  },
});

/** A command that asks the KV_SERVICE `request` through `KV_SOCKET` and prints its answer, or the error's code. */
export const kvAsk = (request) =>
  `node -e 'const s=require("net").connect(process.env.KV_SOCKET);s.on("connect",()=>s.write(process.argv.slice(1).join(" ")));let d="";s.on("data",(c)=>(d+=c));s.on("end",()=>console.log(d));s.on("error",(e)=>console.log(e.code))' ${request}`;

/** A sandbox configuration, network off, with the KV_SERVICE, which reports whether it reaches `port`. */
export const servicesSandbox = (port) => ({
  required: true,
  network: "off",
  readOnlyPaths: [],
  environment: {},
  services: { kv: KV_SERVICE(port) },
  limits: {
    tmpMiB: 64,
    homeMiB: 64,
    checkoutMiB: 64,
    files: 4096,
    candidateMiB: 16,
    candidateFiles: 1024,
    installStoreDays: 14,
    installStoreMiB: 20_480,
    processes: 4096,
  },
});

/** A new directory under tmpdir(), removed when the test file ends. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/**
 * Spawn `node ...args`, killed if this test process dies first: after()
 * never runs then, and Node can't set a parent-death signal, but setpriv can.
 */
export function spawnNode(args, options) {
  return spawn(
    "setpriv",
    ["--pdeathsig", "KILL", process.execPath, ...args],
    options,
  );
}

/** Start `factory serve`. Resolves with its exit when it ends. */
export function serve(inst, crashAt, nodeArgs = [], serveArgs = []) {
  const env = { ...inst.env };
  if (crashAt) env.FACTORY_CRASH_AT = crashAt;
  const args = [...nodeArgs, CLI, "serve", "--repo", REPO, ...serveArgs];
  const child = spawnNode(args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  return { child, exit, stderr: () => stderr };
}

/**
 * The service's exit, waited for at most `ms`: past it, the service is
 * killed and the wait fails with what it wrote, so a hang explains itself.
 */
export async function exited(service, what, ms = 30_000) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      service.child.kill("SIGKILL");
      reject(
        new Error(
          `${what} didn't exit within ${ms / 1000} s; it wrote:\n${service.stderr()}`,
        ),
      );
    }, ms);
  });
  try {
    return await Promise.race([service.exit, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function cli(inst, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--repo", REPO], {
    env: inst.env,
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/**
 * A `/factory <answer> [--question ID]` comment as the GitHub sync turns it
 * into a request, with the comment's time. Resolves with the result.
 */
export async function comment(inst, issue, answer, writtenAt, question) {
  mkdirSync(inst.requests, { recursive: true });
  const id = `comment-${Date.now()}`;
  // Written whole, then renamed, as Factory writes requests (requests.ts
  // writeRequest): the service never reads a file half-written.
  const temporary = join(inst.requests, `.${id}.tmp`);
  writeFileSync(
    temporary,
    JSON.stringify({
      id,
      at: new Date().toISOString(),
      by: "octo",
      request: {
        kind: "answer",
        issue,
        answer,
        writtenAt,
        ...(question ? { question } : {}),
      },
    }),
  );
  renameSync(temporary, join(inst.requests, `${id}.json`));
  const result = join(inst.requests, `${id}.result`);
  await until(() => existsSync(result), "the comment's result");
  return JSON.parse(readFileSync(result, "utf8")).message;
}

/** The stable refusal code a command printed on stderr. */
export function refusal(result) {
  const parsed = JSON.parse(result.err.split("\n")[0]);
  assert.equal(parsed.kind, "lifecycle-refusal");
  return parsed.code;
}

export function status(inst) {
  return JSON.parse(cli(inst, "status", "--json").out);
}

/** The configuration an Objective admitted on `provider` freezes; none without a configuration. */
export function frozen(inst, provider = "codex") {
  if (!inst.env.FACTORY_CONFIG) return undefined;
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    const config = loadConfig(REPO);
    return {
      ...freezeConfig(config, provider),
      provider,
      selectedBy: "defaultProvider",
    };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

/** A seeded hold's options: the first is recommended. */
export function offered(...answers) {
  return answers.map((answer, index) => ({
    answer,
    family: answer,
    consequence: `Answers ${answer}.`,
    ...(index === 0 ? { recommended: true } : {}),
  }));
}

export function seed(inst, issue, status = "checking", fields = {}) {
  mkdirSync(inst.objectives, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(inst.objectives, `${issue}.json`),
    JSON.stringify({
      version: 10,
      issue,
      status,
      frozen: frozen(inst),
      holds: [],
      answers: {},
      retries: {},
      repairs: {},
      kept: {},
      // No blocked-by links: these tests start at the check.
      done: { predecessors: { predecessors: [], ignored: [] } },
      attempts: {},
      appliedRequests: [],
      modules: {},
      updatedAt: now,
      ...fields,
    }),
  );
}

/**
 * A configured installation whose GitHub API is `api`: a closed port (the
 * network is down) or a socket that never answers (a stalled network).
 */
export function configured(inst, api, env = {}, fields = {}) {
  const config = join(inst.root, "config.json");
  mkdirSync(inst.root, { recursive: true });
  // A checkout bound to github.com/REPO, served by a bare repository here,
  // so the service can take the repository (holder.ts) with no GitHub.
  const checkout = join(inst.root, "checkout");
  if (!fields.checkout && !existsSync(checkout)) {
    const bare = join(inst.root, "origin.git");
    for (const args of [
      ["init", "--quiet", "--bare", bare],
      ["clone", "--quiet", bare, checkout],
    ]) {
      const result = spawnSync("git", args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    githubOrigin(checkout, bare);
  }
  writeFileSync(
    config,
    JSON.stringify({
      repository: REPO,
      checkout: join(inst.root, "checkout"),
      queue: { projectId: "PVT_none", pollSeconds: 5 },
      // The tests' fake GitHub serves a token, the GitHub CLI's login.
      github: { login: true },
      ...fields,
    }),
  );
  Object.assign(inst.env, {
    FACTORY_CONFIG: config,
    FACTORY_GITHUB_API: api,
    FACTORY_GITHUB_TOKEN: "unused",
    ...env,
  });
}

/**
 * Bind `checkout`'s origin to github.com/`repository` over SSH, served by
 * the local bare repository `bare`: Factory fetches only from an origin
 * that names the target.
 */
export function githubOrigin(checkout, bare, repository = REPO) {
  for (const args of [
    ["remote", "set-url", "origin", `ssh://git@github.com/${repository}.git`],
    ["config", "ssh.variant", "simple"],
    [
      "config",
      "core.sshCommand",
      `sh -c 'case "$2" in git-receive-pack*) exec git receive-pack "$0";; *) exec git upload-pack "$0";; esac' ${bare}`,
    ],
  ]) {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
}

/** A local port nothing listens on. */
export async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A server that accepts connections and never answers. */
export async function silentServer() {
  const sockets = new Set();
  const server = createServer((socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return server.address().port;
}

/** The Objective's state: active, else moved to finished/ once settled. */
export function stateOf(inst, issue) {
  const read = (dir) => readFileSync(join(dir, `${issue}.json`), "utf8");
  try {
    return JSON.parse(read(inst.objectives));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(read(join(inst.objectives, "finished")));
  }
}

export async function until(predicate, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export async function stopped(service) {
  service.child.kill("SIGTERM");
  return await exited(service, "the stopped service");
}

/** A planned Work Item with no more than status reads. */
export function item(id, fields = {}) {
  return {
    id,
    title: id,
    goal: id,
    acceptance: [],
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths: [],
    validation: [],
    brief: id,
    ...fields,
  };
}

/** An accepted plan of `items` (each built with item()): nothing else to cover, run or decide. */
export function plan(items = [], fields = {}) {
  return { items, coverage: [], finalCommands: [], decisions: [], ...fields };
}

/** An operator's `retire-command` record, against the plan accepted at `plan`. */
export function retirement(command, reason, plan = "2026-01-01T00:00:00.000Z") {
  return {
    command,
    reason,
    by: "kirk",
    at: "2026-01-01T00:00:00.000Z",
    holdId: `${command}@1`,
    plan,
  };
}

/**
 * A result review's workspace, mutation and bounds (review/item.ts) for a
 * test whose reviewer runs no command: the workspace can't be made, so its
 * mutation pass is skipped.
 */
export const NO_WORKSPACE = {
  workspace: async () => {
    throw new Error("this review runs no command");
  },
  limits: {
    commandMs: 60_000,
    prepareMs: 60_000,
    proofs: 10,
    proofCommands: 8,
    proofBudgetMs: 60_000,
  },
};
