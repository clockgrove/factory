import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ readdirSync: () => [], readFileSync: vi.fn() }));

import { startContainedProcess } from "../src/runtime/process-group.js";

afterEach(() => vi.restoreAllMocks());

it("waits for buffered output after exit before reporting a successful command", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 2_147_483_000,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  mocks.spawn.mockReturnValue(child);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process group already gone"), { code: "ESRCH" });
  });
  const processHandle = startContainedProcess({
    command: "git",
    args: ["diff"],
    cwd: "/tmp",
    timeoutMs: 1_000,
  });
  let settled = false;
  void processHandle.completed.then(() => {
    settled = true;
  });
  child.emit("exit", 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeDrain = settled;
  child.stdout.emit("data", Buffer.from("complete patch\n"));
  child.stderr.emit("data", Buffer.from("diagnostic\n"));
  child.emit("close", 0, null);
  const result = await processHandle.completed;
  expect(settledBeforeDrain).toBe(false);
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "complete patch\n",
    stderr: "diagnostic\n",
  });
});

it("fails when a child closes stdin before the bounded input is flushed", async () => {
  const stdin = Object.assign(new EventEmitter(), {
    writableFinished: false,
    end: vi.fn(() => stdin.emit("close")),
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 2_147_483_001,
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  mocks.spawn.mockReturnValue(child);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process group already gone"), { code: "ESRCH" });
  });
  const processHandle = startContainedProcess({
    command: "codex",
    args: ["exec", "-"],
    cwd: "/tmp",
    stdin: { text: "complete bounded prompt", maxBytes: 1024 },
    timeoutMs: 1_000,
  });
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await expect(processHandle.completed).resolves.toMatchObject({
    exitCode: 1,
    stdout: "",
    stderr: "stdin transport closed before completion",
  });
  expect(stdin.end).toHaveBeenCalledExactlyOnceWith("complete bounded prompt", "utf8");
});
