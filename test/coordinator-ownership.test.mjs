import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";
import { requestControl, serveControl } from "../dist/coordinator-control.js";
import {
  acquireControllerLock,
  readContinuation,
  readControllerOwner,
  releaseControllerLock,
  saveState,
  statePath,
} from "../dist/state-store.js";

const storeUrl = new URL("../dist/state-store.js", import.meta.url).href;
const contenderSource = `
  import { acquireControllerLock, releaseControllerLock } from ${JSON.stringify(storeUrl)};
  const path = process.argv[1];
  let lock;
  process.on("message", (message) => {
    if (message === "acquire") {
      try {
        lock = acquireControllerLock(path, 1);
        process.send({ outcome: "acquired", token: lock.token, pid: process.pid });
      } catch (error) {
        process.send({ outcome: "refused", error: error.message });
      }
    } else if (message === "release") {
      if (lock) releaseControllerLock(path, lock);
      process.disconnect();
    } else if (message === "crash") {
      process.exit(0);
    }
  });
  process.send({ outcome: "ready" });
`;

function contender(path, children) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", contenderSource, path],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.push(child);
  return child;
}

async function command(child, message) {
  const reply = once(child, "message");
  child.send(message);
  return (await reply)[0];
}

async function finish(child, message = "release") {
  const exited = once(child, "exit");
  child.send(message);
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
}

for (const stale of [false, true]) {
  test(`separate controllers have one owner under ${stale ? "stale-owner" : "first-owner"} contention`, {
    timeout: 10_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-ownership-"));
    const path = join(root, "controller.lock");
    const children = [];
    try {
      if (stale) {
        const previous = contender(path, children);
        await once(previous, "message");
        assert.equal((await command(previous, "acquire")).outcome, "acquired");
        await finish(previous, "crash");
        assert.ok(
          existsSync(path),
          "crashed owner leaves its real lock behind",
        );
      }
      const peers = Array.from({ length: 6 }, () => contender(path, children));
      await Promise.all(peers.map((child) => once(child, "message")));
      const results = await Promise.all(
        peers.map((child) => command(child, "acquire")),
      );
      const winner = results.findIndex(
        (result) => result.outcome === "acquired",
      );
      assert.equal(
        results.filter((result) => result.outcome === "acquired").length,
        1,
      );
      const owner = readControllerOwner(path);
      assert.equal(owner.token, results[winner].token);
      assert.equal(owner.pid, peers[winner].pid);
      for (let index = 0; index < peers.length; index++) {
        if (index === winner) continue;
        assert.equal(results[index].outcome, "refused");
        assert.match(results[index].error, /already owns|EEXIST/);
        await finish(peers[index]);
        assert.deepEqual(
          readControllerOwner(path),
          owner,
          "a losing process cannot remove or replace the winning owner",
        );
      }
      assert.equal(statSync(path).mode & 0o777, 0o600);
      await finish(peers[winner]);
      assert.equal(existsSync(path), false);
      assert.equal(existsSync(`${path}.acquire`), false);
    } finally {
      await Promise.all(
        children
          .filter(
            (child) => child.exitCode === null && child.signalCode === null,
          )
          .map(async (child) => {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }),
      );
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function rawControl(path, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (part) => {
      body += part;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("private control socket refuses missing or stale owner tokens before lifecycle handling", {
  timeout: 10_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "fc-control-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const repository = "example/ownership";
  const directory = stateRoot(repository);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "controller.lock");
  const lock = acquireControllerLock(path, 1);
  let server;
  let handled = 0;
  try {
    server = await serveControl(repository, lock, async (request) => {
      handled++;
      return { action: request.action };
    });
    const socketPath = join(directory, "control.sock");
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    for (const token of [undefined, "previous-owner-token"]) {
      assert.deepEqual(
        await rawControl(socketPath, { objective: 1, action: "cancel", token }),
        { error: "Controller owner changed" },
      );
    }
    assert.equal(handled, 0);
    await assert.rejects(
      requestControl(repository, { objective: 2, action: "cancel" }),
      /running Objective #1/,
    );
    assert.equal(handled, 0);
    assert.deepEqual(
      await requestControl(repository, { objective: 1, action: "status" }),
      { handled: true, result: { action: "status" } },
    );
    assert.equal(handled, 1);
  } finally {
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    releaseControllerLock(path, lock);
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const planning of ["ready", "submitted"]) {
  test(`restart from ${planning} preparation never duplicates uncertain planning`, {
    timeout: 10_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-prepare-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/restart-${planning}`,
      );
      const objectiveBody =
        "## Acceptance\n- `test -s result.txt`\n\n## Final validation\n- `test -s result.txt`\n";
      let calls = 0;
      const descriptor = {
        config,
        objectiveBody,
        fakeRoot: join(root, "fake"),
        actions: {},
        planningModel: {
          async generateStructured() {
            calls++;
            const snapshot = readContinuation(config.repository, 1);
            assert.equal(snapshot.planning, "submitted");
            assert.equal(snapshot.runId, "preserved-preparation-run");
            throw new Error("fixture planning reply lost");
          },
          async reviewGraph() {
            throw new Error("review must not run without a planning reply");
          },
        },
      };
      saveState(statePath(config.repository, 1), {
        schemaVersion: 3,
        kind: "preparing",
        repository: config.repository,
        objective: 1,
        runId: "preserved-preparation-run",
        configDigest: factoryConfigDigest(config),
        baseSha: target.baseSha,
        objectiveBodyDigest: createHash("sha256")
          .update(objectiveBody)
          .digest("hex"),
        planning,
        issueByItemId: {},
        coordinator: {
          mode: "running",
          phase: "planning",
          phaseStartedAt: new Date().toISOString(),
        },
      });
      const first = makeApplication(descriptor);
      await assert.rejects(
        first.application.runObjective(1),
        planning === "ready"
          ? /fixture planning reply lost/
          : /unknown outcome/,
      );
      assert.equal(calls, planning === "ready" ? 1 : 0);
      const second = makeApplication(descriptor);
      await assert.rejects(
        second.application.runObjective(1),
        /preparation stopped|unknown outcome/,
      );
      assert.equal(calls, planning === "ready" ? 1 : 0);
      assert.equal(
        readContinuation(config.repository, 1).runId,
        "preserved-preparation-run",
      );
      assert.equal(
        readContinuation(config.repository, 1).planning,
        "submitted",
      );
      assert.deepEqual(first.github.state().issues, {});
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
