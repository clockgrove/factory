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
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { freezeConfig } from "../dist/providers/selection.js";

export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
export const REPO = "drill/target";

export function installation() {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-test-"));
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

// Every service a test starts is killed at the end, even when a test fails.
export const children = new Set();
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

/** Start `factory serve`. Resolves with its exit when it ends. */
export function serve(inst, crashAt, nodeArgs = [], serveArgs = []) {
  const env = { ...inst.env };
  if (crashAt) env.FACTORY_CRASH_AT = crashAt;
  const args = [...nodeArgs, CLI, "serve", "--repo", REPO, ...serveArgs];
  const child = spawn(process.execPath, args, {
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
      version: 9,
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
