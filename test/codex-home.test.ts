import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveCodexAuthFile,
  resolveCodexHomeRoot,
} from "../src/runtime/codex-home.js";

describe("isolated Codex homes", () => {
  it("uses durable per-user state instead of the operating-system temp directory", () => {
    expect(resolveCodexHomeRoot({
      homeDirectory: "/home/factory",
      tempDirectory: "/tmp",
      xdgStateHome: "",
    })).toBe("/home/factory/.local/state/clockgrove-factory/codex-homes");
  });

  it("honors an absolute XDG state directory", () => {
    expect(resolveCodexHomeRoot({
      homeDirectory: "/home/factory",
      tempDirectory: "/tmp",
      xdgStateHome: "/var/lib/factory-user",
    })).toBe("/var/lib/factory-user/clockgrove-factory/codex-homes");
  });

  it("ignores relative or temporary XDG state directories", () => {
    const expected = "/home/factory/.local/state/clockgrove-factory/codex-homes";
    expect(resolveCodexHomeRoot({
      homeDirectory: "/home/factory",
      tempDirectory: "/tmp",
      xdgStateHome: "relative/state",
    })).toBe(expected);
    expect(resolveCodexHomeRoot({
      homeDirectory: "/home/factory",
      tempDirectory: "/tmp",
      xdgStateHome: "/tmp/factory-state",
    })).toBe(expected);
  });

  it("fails when the user home and state directory are both temporary", () => {
    expect(() => resolveCodexHomeRoot({
      homeDirectory: "/tmp/factory-home",
      tempDirectory: "/tmp",
      xdgStateHome: "/tmp/factory-state",
    })).toThrow("cannot place isolated Codex homes outside temporary directory");
  });

  it("uses the active Codex installation for authentication", () => {
    const previous = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = "/opt/codex-state";
    try {
      expect(resolveCodexAuthFile()).toBe(join("/opt/codex-state", "auth.json"));
      expect(resolveCodexAuthFile("/explicit/auth.json")).toBe("/explicit/auth.json");
    } finally {
      if (previous === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previous;
    }
  });
});
