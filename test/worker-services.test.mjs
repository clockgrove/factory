// A worker attempt's throwaway services (#2291): a real server, started as
// `sandbox.services` configures it, reached from a worker's commands in the
// command sandbox (as the Claude worker's run_command runs them) and from a
// Codex worker's shell (Codex's own sandbox, run by its app server with no
// model call). Nothing is shared between attempts, and the service keeps the
// worker's network rules.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { codexWorkerHome } from "../dist/providers/codex-worker.js";
import { runSandboxed } from "../dist/sandbox.js";
import { AttemptServices } from "../dist/work/services.js";
import { validationEnvironment } from "../dist/worktree.js";
import { codexAppServer, KV_SERVICE, tempDir } from "./helpers.mjs";

// The sandbox mounts the PATH's toolchains: this node, not a version shim.
process.env.PATH = `${dirname(process.execPath)}:/bin:/usr/bin`;
// No operator login reaches the Codex home, and no model is called.
process.env.CODEX_HOME = tempDir("factory-no-login-");

/** A sandbox configuration with the key-value service, which reports whether it reaches `port`. */
const configured = (port) => ({
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
    processes: 4096,
  },
});

/** The worker's command that asks the service: `KV_SOCKET` locates it. */
const ask = (request) =>
  `node -e 'const s=require("net").connect(process.env.KV_SOCKET);s.on("connect",()=>s.write(process.argv.slice(1).join(" ")));let d="";s.on("data",(c)=>(d+=c));s.on("end",()=>console.log(d));s.on("error",(e)=>console.log(e.code))' ${request}`;

/** A host listener on loopback, and the port a service must not reach under network off. */
async function hostListener(t) {
  const server = createServer((socket) => socket.end("host\n"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server.address().port;
}

/** One attempt's worktree and private HOME and TMPDIR, as the Claude worker makes them. */
function attempt(root, name) {
  const paths = Object.fromEntries(
    ["worktree", "home", "tmp", "gh"].map((part) => [
      part,
      join(root, name, part),
    ]),
  );
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

test("each worker attempt's services are its own, reached only through their directory, on the worker's network, and stopped at its end (#2291)", async (t) => {
  const root = tempDir("factory-services-test-");
  const config = configured(await hostListener(t));
  const signal = AbortSignal.timeout(120_000);
  const first = attempt(root, "first");
  const second = attempt(root, "second");
  const started = [];
  t.after(() => Promise.all(started.map((services) => services.stop())));
  const start = async () => {
    const services = await AttemptServices.start(
      config,
      "off",
      signal,
      () => {},
    );
    assert.ok(services instanceof AttemptServices, JSON.stringify(services));
    started.push(services);
    return services;
  };
  // A command as run_command runs it, in its attempt's sandbox.
  const run = async (paths, services, command) => {
    const result = await runSandboxed(command, {
      cwd: paths.worktree,
      home: paths.home,
      temporary: paths.tmp,
      env: { ...validationEnvironment(paths.gh), ...services.environment },
      services: services.root,
      config,
      network: false,
      packageInstall: false,
      signal,
      timeoutMs: 30_000,
    });
    assert.equal(result.kind, "ran", JSON.stringify(result));
    assert.equal(result.sandboxed, true);
    return { code: result.exitCode, out: result.stdout.trim() };
  };
  const mine = await start();
  const theirs = await start();
  assert.notEqual(mine.root, theirs.root);
  assert.equal(mine.environment.KV_SOCKET, join(mine.root, "kv", "kv.sock"));

  assert.deepEqual(await run(first, mine, ask("set x 1")), {
    code: 0,
    out: "1",
  });
  assert.equal((await run(first, mine, ask("get x"))).out, "1");
  // Another attempt's service is empty, and its directory isn't visible.
  assert.equal((await run(second, theirs, ask("get x"))).out, "none");
  assert.equal(
    (
      await run(
        first,
        mine,
        `KV_SOCKET=${theirs.environment.KV_SOCKET} ${ask("get x")}`,
      )
    ).out,
    "ENOENT",
  );
  // The worker's commands write nothing beside the socket.
  assert.notEqual(
    (await run(first, mine, 'touch "$KV_SOCKET.x"')).code,
    0,
    "a worker's command wrote in the services directory",
  );
  // Under network off the service has a network namespace of its own: the
  // host's loopback is out of its reach.
  assert.equal((await run(first, mine, ask("outside"))).out, "refused");

  // The attempt's end stops it: a connection held open is closed by its end.
  const held = connect(mine.environment.KV_SOCKET);
  await new Promise((resolve, reject) =>
    held.once("connect", resolve).once("error", reject),
  );
  const closed = new Promise((resolve) => held.once("close", resolve));
  await mine.stop();
  await closed;
  // The next attempt starts with an empty one.
  const next = await start();
  assert.equal((await run(first, next, ask("get x"))).out, "none");
});

test("a Codex worker's shell, on the host's network, gets its attempt's services' variables and reaches them; the service shares that network (#2291)", async (t) => {
  const port = await hostListener(t);
  const config = configured(port);
  const worktree = join(tempDir("factory-services-codex-"), "w");
  mkdirSync(worktree);
  const services = await AttemptServices.start(
    config,
    "host",
    AbortSignal.timeout(120_000),
    () => {},
  );
  assert.ok(services instanceof AttemptServices, JSON.stringify(services));
  t.after(() => services.stop());
  const home = codexWorkerHome(
    worktree,
    true,
    [],
    config,
    undefined,
    "",
    services,
  );
  t.after(() => rmSync(home.root, { recursive: true, force: true }));
  const codex = codexAppServer(home, worktree);
  t.after(() => codex.end());
  await codex.request("initialize", {
    clientInfo: { name: "factory-test", version: "0" },
  });
  codex.notify("initialized");
  await codex.request("thread/start", {
    cwd: worktree,
    approvalPolicy: "never",
  });
  const shell = async (command) => {
    const result = await codex.request("command/exec", {
      command: ["sh", "-c", command],
      cwd: worktree,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    return result.stdout.trim();
  };
  assert.equal(await shell(ask("set y 2")), "2");
  assert.equal(await shell(ask("get y")), "2");
  assert.equal(await shell(ask("outside")), "reached");
});
