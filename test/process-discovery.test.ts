import { beforeEach, describe, expect, it, vi } from "vitest";

const { enumerate } = vi.hoisted(() => ({ enumerate: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readdir: enumerate,
}));

import { linuxProcessIds } from "../src/runtime/process-group.js";

describe("Linux process discovery", () => {
  beforeEach(() => {
    enumerate.mockReset();
  });

  it("retains a names snapshot when a PID disappears before Dirent conversion", async () => {
    // Model Node's DT_UNKNOWN fallback: withFileTypes requires an internal
    // lstat, which rejects the whole listing if an unrelated process exits.
    enumerate.mockImplementation(async (_path, options) => {
      if (options?.withFileTypes) {
        throw Object.assign(new Error("lstat /proc/1098239: no such file"), { code: "ENOENT" });
      }
      return ["self", "thread-self", "sys", "101", "1098239", "0", "not-a-pid"];
    });
    // Readers handle vanished PIDs individually after enumeration; no identity
    // or existence claim is made merely because a PID occurred in this snapshot.
    await expect(linuxProcessIds()).resolves.toEqual([101, 1098239]);
  });

  it("does not interpret an unreadable proc filesystem as no surviving workers", async () => {
    const failure = Object.assign(new Error("cannot enumerate /proc"), { code: "EACCES" });
    enumerate.mockRejectedValue(failure);
    await expect(linuxProcessIds()).rejects.toBe(failure);
  });
});
