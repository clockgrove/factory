import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import { requestControl, serveControl } from "../dist/coordinator-control.js";
import {
  acquireControllerLock,
  releaseControllerLock,
} from "../dist/state-store.js";

const close = (server) => new Promise((resolve) => server.close(resolve));

test("native listener closure cannot unlink another live socket after directory descriptor reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-control-lifetime-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "long-state-root-".repeat(10));
  const repository = "example/owner";
  const directory = stateRoot(repository);
  const otherDirectory = join(root, "other-owner");
  mkdirSync(directory, { recursive: true });
  mkdirSync(otherDirectory);
  const lockPath = join(directory, "controller.lock");
  const lock = acquireControllerLock(lockPath, 1);
  let server;
  let other;
  const descriptors = [];
  try {
    server = await serveControl(repository, lock, async () => "responsive");
    const descriptor = Number(server.address().match(/fd\/(\d+)/)[1]);
    // On the broken implementation this reuses the closed bound descriptor.
    // On the corrected implementation it remains reserved for this listener.
    for (;;) {
      const fd = openSync(otherDirectory, "r");
      descriptors.push(fd);
      if (fd >= descriptor) break;
    }
    other = createServer((socket) => socket.end("other owner"));
    const otherPath = join(otherDirectory, "control.sock");
    await new Promise((resolve, reject) =>
      other.once("error", reject).listen(otherPath, resolve),
    );
    assert.equal(statSync(join(directory, "control.sock")).mode & 0o777, 0o600);
    assert.deepEqual(
      await requestControl(repository, { objective: 1, action: "status" }),
      { handled: true, result: "responsive" },
    );
    await close(server);
    server = undefined;
    assert.equal(existsSync(join(directory, "control.sock")), false);
    assert.equal(existsSync(otherPath), true);
    assert.equal(other.listening, true);
    assert.throws(() => readlinkSync(`/proc/self/fd/${descriptor}`), /ENOENT/);
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(otherPath);
      let body = "";
      socket.on("data", (part) => (body += part));
      socket.once("error", reject);
      socket.once("end", () => resolve(body));
    });
    assert.equal(response, "other owner");
  } finally {
    if (server) await close(server);
    if (other) await close(other);
    for (const fd of descriptors) closeSync(fd);
    releaseControllerLock(lockPath, lock);
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed socket permission setup closes its native listener and bound directory descriptor", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-control-startup-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const repository = "example/startup";
  const directory = stateRoot(repository);
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, "controller.lock");
  const lock = acquireControllerLock(lockPath, 1);
  try {
    const pending = serveControl(repository, lock, async () => "unused");
    const descriptor = readdirSync("/proc/self/fd").find((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === directory;
      } catch {
        return false;
      }
    });
    assert.ok(descriptor);
    // Native bind has completed, but the listening callback has not chmodded it.
    rmSync(join(directory, "control.sock"));
    await assert.rejects(pending, /ENOENT/);
    assert.throws(() => readlinkSync(`/proc/self/fd/${descriptor}`), /ENOENT/);
    assert.equal(existsSync(join(directory, "control.sock")), false);
  } finally {
    releaseControllerLock(lockPath, lock);
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
