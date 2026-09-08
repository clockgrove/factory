import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  releasePreflightDiagnostic,
  verifyReleasePreflight,
  type ReleasePreflightRunner,
} from "../scripts/verify-release-preflight.mjs";

describe("coordinated release preflight", () => {
  it("accepts an injected available user manager without ambient host dependence", async () => {
    const run = vi.fn<ReleasePreflightRunner>(async (command) => ({
      stdout: command === "systemctl" ? "259\n" : "systemd 259 (259.1)\n",
    }));

    await expect(verifyReleasePreflight({ platform: "linux", run })).resolves.toBeUndefined();
    expect(run.mock.calls).toEqual([
      [
        "systemctl",
        ["--user", "show", "--property=Version", "--value", "--no-pager"],
        { timeout: 5_000, maxBuffer: 4_096, encoding: "utf8", windowsHide: true },
      ],
      [
        "systemd-run",
        ["--version"],
        { timeout: 5_000, maxBuffer: 4_096, encoding: "utf8", windowsHide: true },
      ],
    ]);
  });

  it.each([
    ["unavailable transport", async () => Promise.reject(new Error("No data available"))],
    ["empty manager response", async () => ({ stdout: "" })],
    ["unsupported manager", async () => ({ stdout: "253\n" })],
  ])("fails an injected %s with one actionable diagnostic", async (_name, response) => {
    const run = vi.fn<ReleasePreflightRunner>(response);

    await expect(verifyReleasePreflight({ platform: "linux", run })).rejects.toThrow(
      releasePreflightDiagnostic,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails a missing or unsupported launcher with the same diagnostic", async () => {
    const run = vi.fn<ReleasePreflightRunner>(async (command) => {
      if (command === "systemctl") return { stdout: "259\n" };
      throw new Error("systemd-run missing");
    });

    await expect(verifyReleasePreflight({ platform: "linux", run })).rejects.toThrow(
      releasePreflightDiagnostic,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Linux runners before attempting a command", async () => {
    const run = vi.fn<ReleasePreflightRunner>();

    await expect(verifyReleasePreflight({ platform: "win32", run })).rejects.toThrow(
      releasePreflightDiagnostic,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs before every coordinated release check and does not disable host tests", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const release = manifest.scripts["verify:release"];

    expect(release?.startsWith("node scripts/verify-release-preflight.mjs && ")).toBe(true);
    expect(release).toContain("npm run test:coverage");
    expect(release).not.toMatch(/--exclude|--skip|FACTORY_.*=0/);
  });
});
