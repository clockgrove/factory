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
