import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PARENT_DEATH_WATCHDOG,
  runContainedProcess,
  sanitizedWorkerEnvironment,
} from "../src/runtime/process-group.js";
import {
  cleanupLocalWorktree,
  collectLocalArtifact,
  createLocalWorktree,
  seedLocalWorktree,
} from "../src/runtime/local-worktree.js";

describe("worker environment", () => {
  it("removes GitHub and unpermitted secret material", () => {
    const env = sanitizedWorkerEnvironment({
      PATH: "/bin",
      GH_TOKEN: "github",
      GITHUB_TOKEN: "github-actions",
      OPENAI_API_KEY: "model",
      DATABASE_PASSWORD: "password",
      SAFE_VALUE: "yes",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.SAFE_VALUE).toBe("yes");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.FACTORY_WORKER).toBe("1");
  });

  it("passes only explicitly named model credentials", () => {
    const env = sanitizedWorkerEnvironment(
      { OPENAI_API_KEY: "model", GH_TOKEN: "never" },
      ["OPENAI_API_KEY"],
    );
    expect(env.OPENAI_API_KEY).toBe("model");
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe("contained processes", () => {
  it("bounds output and terminates a timed-out process", async () => {
    const result = await runContainedProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)",
      ],
      cwd: tmpdir(),
      env: sanitizedWorkerEnvironment(process.env),
      timeoutMs: 50,
      cancellationGraceMs: 20,
      maxOutputBytes: 512,
    });
    expect(result.timedOut).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(512);
    expect(result.stdout).toContain("output truncated");
  });

  it("kills the worker group when its recorded parent is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-parent-death-"));
    const marker = join(directory, "worker-survived");
    const child = spawn(
      "/bin/sh",
      [
        "-c", PARENT_DEATH_WATCHDOG, "factory-parent-watchdog", "2147483647",
        "/bin/sh", "-c", `sleep 4; touch '${marker}'`,
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("parent-death watchdog did not stop")), 3_500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", reject);
    });
    expect(existsSync(marker)).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("local worktrees", () => {
  it("isolates worker changes from a dirty operator checkout and collects untracked files", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
      cwd: repository,
    });
    await writeFile(join(repository, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();

    // Dirty content remains private to the operator checkout.
    await writeFile(join(repository, "tracked.txt"), "operator dirty change\n");
    const worktree = await createLocalWorktree(repository, baseSha);
    expect(await readFile(join(worktree.path, "tracked.txt"), "utf8")).toBe("base\n");

    await writeFile(join(worktree.path, "tracked.txt"), "worker change\n");
    await writeFile(join(worktree.path, "new.txt"), "worker new file\n");
    await expect(
      collectLocalArtifact(worktree, "worker complete", ["tracked.txt"]),
    ).rejects.toThrow(/outside scope: new\.txt/);
    const artifact = await collectLocalArtifact(worktree, "worker complete");
    expect(artifact.outcome).toBe("succeeded");
    expect(artifact.changedPaths).toEqual(["new.txt", "tracked.txt"]);
    expect(artifact.patch).toContain("worker new file");
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe(
      "operator dirty change\n",
    );

    const retry = await createLocalWorktree(repository, baseSha);
    await seedLocalWorktree(retry, artifact);
    expect(await readFile(join(retry.path, "tracked.txt"), "utf8")).toBe("worker change\n");
    expect(await readFile(join(retry.path, "new.txt"), "utf8")).toBe("worker new file\n");
    expect((await collectLocalArtifact(retry)).digest).toBe(artifact.digest);

    await cleanupLocalWorktree(retry);
    await cleanupLocalWorktree(worktree);
    expect(existsSync(worktree.root)).toBe(false);
  });

  it("collects a protocol-sized patch without applying the generic log truncation cap", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-large-artifact-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
      cwd: repository,
    });
    await writeFile(join(repository, "seed.txt"), "base\n");
    execFileSync("git", ["add", "seed.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const worktree = await createLocalWorktree(repository, baseSha);
    await writeFile(join(worktree.path, "large.txt"), `${"x".repeat(300_000)}\n`);
    const artifact = await collectLocalArtifact(worktree);
    expect(Buffer.byteLength(artifact.patch)).toBeGreaterThan(256 * 1024);
    expect(artifact.patch).not.toContain("output truncated");
    expect(artifact.changedPaths).toEqual(["large.txt"]);
    await cleanupLocalWorktree(worktree);
    await rm(repository, { recursive: true, force: true });
  });
});
