import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyLocalRepository } from "../src/supervisor.js";

describe("Supervisor repository preflight", () => {
  it("accepts exact GitHub remotes and rejects lookalike hosts", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-supervisor-preflight-"));
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://evilgithub.com/clockgrove/factory.git"],
      { cwd: repository },
    );
    await expect(
      verifyLocalRepository(repository, "clockgrove", "factory"),
    ).rejects.toThrow(/does not match/);
    execFileSync(
      "git",
      ["remote", "set-url", "origin", "git@github.com:clockgrove/factory.git"],
      { cwd: repository },
    );
    await expect(
      verifyLocalRepository(repository, "clockgrove", "factory"),
    ).resolves.toBeUndefined();
    await rm(repository, { recursive: true, force: true });
  });
});
