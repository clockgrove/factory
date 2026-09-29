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
import { requestControl, serveControl } from "../dist/coordinator-control.js";
import {
  acquireControllerLock,
  readContinuation,
  readControllerOwner,
  releaseControllerLock,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";

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

test("offline cancellation verifies recorded subprocess cessation and refuses a mismatched identity", async () => {
  const { cancelObjective } = await import("../dist/runner.js");
  const { linuxProcessIdentity, processGroupExists } = await import(
    "../dist/process.js"
  );
  for (const mismatch of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "fc-offline-cancel-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      const identity = linuxProcessIdentity(child.pid);
      const target = createTarget(root);
      const config = factoryConfig(target.checkout, "example/offline-cancel");
      saveState(statePath(config.repository, 1), {
        schemaVersion: 3,
        kind: "preparing",
        repository: config.repository,
        objective: 1,
        runId: "cancel-owned",
        configDigest: factoryConfigDigest(config),
        baseSha: target.baseSha,
        objectiveBodyDigest: "a".repeat(64),
        planning: "ready",
        issueByItemId: {},
        coordinator: {
          mode: "paused",
          phase: "planning",
          phaseStartedAt: new Date().toISOString(),
          processes: [
            {
              pid: child.pid,
              startTime: mismatch ? "wrong" : identity.startTime,
            },
          ],
        },
      });
      if (mismatch) {
        await assert.rejects(
          cancelObjective(config, 1, {}),
          /identity is unresolved/,
        );
        assert.equal(
          readContinuation(config.repository, 1).cancelledAt,
          undefined,
        );
        assert.equal(processGroupExists(child.pid), true);
      } else {
        assert.equal(await cancelObjective(config, 1, {}), "cancelled");
        assert.equal(processGroupExists(child.pid), false);
        assert.ok(readContinuation(config.repository, 1).cancelledAt);
      }
    } finally {
      if (processGroupExists(child.pid)) process.kill(-child.pid, "SIGKILL");
      await exited;
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("persisted drain reattaches an existing worker and leaves its dependent pending after restart", {
  timeout: 20_000,
}, async () => {
  const { writeFileSync } = await import("node:fs");
  const { readState } = await import("../dist/state-store.js");
  const { writeDescriptor, waitForFile, readEvents } = await import(
    "./support/integration-fixture.mjs"
  );
  for (const delivery of ["regular", "native-stack"]) {
    const root = mkdtempSync(join(tmpdir(), "fc-drain-restart-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    let child;
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/drain-${delivery}`,
        delivery,
        1,
      );
      const item = (id, dependencies) => ({
        id,
        title: id,
        goal: "write result",
        brief: "write result",
        acceptance: ["result.txt exists"],
        nonGoals: ["No unrelated changes"],
        citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
        dependencies,
        ownedPaths: ["result.txt"],
        resources: [],
        validation: [
          {
            command: "test -s result.txt",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      });
      const barrier = join(root, "worker.go");
      const descriptor = {
        config,
        graph: {
          objective: 1,
          baseSha: target.baseSha,
          items: [item("first", []), item("second", ["first"])],
        },
        objectiveBody:
          "## Acceptance\n- `test -s result.txt`\n\n## Final validation\n- `test -s result.txt`\n",
        fakeRoot: join(root, "fake"),
        actions: {
          first: { barrier, files: [{ path: "result.txt", text: "first\n" }] },
          second: { files: [{ path: "result.txt", text: "second\n" }] },
        },
      };
      const descriptorPath = join(root, "descriptor.json");
      writeDescriptor(descriptorPath, descriptor);
      const path = statePath(config.repository, 1);
      mkdirSync(join(path, ".."), { recursive: true });
      child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "support/restart-controller.mjs"),
          descriptorPath,
          "1",
        ],
        { env: { ...process.env }, stdio: "ignore" },
      );
      await waitForFile(
        () => {
          const state = readContinuation(config.repository, 1);
          return state?.schemaVersion === 2 && state.work.first.execution;
        },
        path,
        "existing drain worker",
      );
      await requestControl(config.repository, {
        objective: 1,
        action: "drain",
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      writeFileSync(barrier, "go");
      const { application, eventsPath } = makeApplication(descriptor);
      const drained = await application.runObjective(1);
      assert.equal(drained.coordinator.mode, "draining");
      assert.ok(["done", "published"].includes(drained.work.first.status));
      assert.equal(drained.work.second.status, "pending");
      assert.equal(
        readEvents(eventsPath).filter((event) => event.type === "start").length,
        1,
      );
      assert.equal(
        readState(config.repository, 1).coordinator.mode,
        "draining",
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
