import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PARENT_DEATH_WATCHDOG,
  processGroupExists,
  runContainedProcess,
  sanitizedWorkerEnvironment,
  terminateProcessGroup,
} from "../src/runtime/process-group.js";
import {
  cleanupLocalWorktree,
  collectLocalArtifact,
  createLocalWorktree,
  seedLocalWorktree,
} from "../src/runtime/local-worktree.js";
import { isolateCodexEnvironment } from "../src/runtime/codex-home.js";

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
    const env = sanitizedWorkerEnvironment({ OPENAI_API_KEY: "model", GH_TOKEN: "never" }, [
      "OPENAI_API_KEY",
    ]);
    expect(env.OPENAI_API_KEY).toBe("model");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("redirects conventional host credential paths into the isolated Codex home", () => {
    const home = "/isolated/factory-attempt";
    const env = isolateCodexEnvironment(
      sanitizedWorkerEnvironment({
        HOME: "/host/home",
        XDG_CONFIG_HOME: "/host/config",
        KUBECONFIG: "/host/kube",
        DOCKER_CONFIG: "/host/docker",
        NPM_CONFIG_USERCONFIG: "/host/npmrc",
      }),
      home,
    );
    for (const value of [
      env.HOME,
      env.XDG_CONFIG_HOME,
      env.KUBECONFIG,
      env.DOCKER_CONFIG,
      env.NPM_CONFIG_USERCONFIG,
      env.AWS_SHARED_CREDENTIALS_FILE,
    ]) {
      expect(value).toMatch(/^\/isolated\/factory-attempt(?:\/|$)/);
      expect(value).not.toContain("/host/");
    }
  });
});

describe("contained processes", () => {
  async function waitUntilGone(pid: number): Promise<void> {
    for (let check = 0; check < 100; check += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`contained descendant ${pid} survived termination`);
  }

  it("bounds output and terminates a timed-out process", async () => {
    const result = await runContainedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"],
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

  it("treats EPERM as a present process group and fails closed on termination", async () => {
    const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
    const control = {
      platform: "darwin" as const,
      sendSignal: () => {
        throw denied;
      },
    };

    expect(processGroupExists(424_242, control)).toBe(true);
    await expect(terminateProcessGroup(424_242, "SIGTERM", 10, control)).rejects.toMatchObject({
      code: "EPERM",
    });
  });

  it("falls back to a direct group probe when a procfs stat read races process exit", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "factory-proc-race-"));
    await mkdir(join(procRoot, "123"));
    await writeFile(join(procRoot, "123", "stat"), "");
    const probes: Array<[number, NodeJS.Signals | 0]> = [];
    try {
      expect(
        processGroupExists(424_242, {
          platform: "linux",
          procRoot,
          sendSignal: (pid, signal) => {
            probes.push([pid, signal]);
          },
        }),
      ).toBe(true);
      expect(probes).toEqual([[-424_242, 0]]);
    } finally {
      await rm(procRoot, { recursive: true, force: true });
    }
  });

  it("rejects secret material before bounded output can discard it", async () => {
    const result = await runContainedProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write('authorization: bearer ghp_${"x".repeat(40)}\\n' + 'later\\n'.repeat(10000))`,
      ],
      cwd: tmpdir(),
      env: sanitizedWorkerEnvironment(process.env),
      timeoutMs: 10_000,
      maxOutputBytes: 512,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("stdout output contains suspected GitHub token");
    expect(result.stderr).not.toContain("ghp_");
  });

  it("kills the worker group when its recorded parent is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-parent-death-"));
    const marker = join(directory, "worker-survived");
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        PARENT_DEATH_WATCHDOG,
        "factory-parent-watchdog",
        "2147483647",
        "/bin/sh",
        "-c",
        `sleep 4; touch '${marker}'`,
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("parent-death watchdog did not stop")),
        3_500,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", reject);
    });
    expect(existsSync(marker)).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });

  it("kills a resistant background descendant after a successful root exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-natural-exit-"));
    const pidFile = join(directory, "descendant.pid");
    const target = join(directory, "target.mjs");
    const descendant = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    await writeFile(
      target,
      [
        'import { spawn } from "node:child_process";',
        'import { existsSync } from "node:fs";',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
        `const ready = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(ready); process.exit(0); } }, 10);`,
      ].join("\n"),
    );
    let descendantPid = 0;
    try {
      const result = await runContainedProcess({
        command: process.execPath,
        args: [target],
        cwd: directory,
        env: sanitizedWorkerEnvironment(process.env),
        timeoutMs: 5_000,
        cancellationGraceMs: 50,
      });
      descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(result.exitCode).toBe(0);
      await waitUntilGone(descendantPid);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Already terminated by the runner.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles as failure when owned cleanup throws while an escaped descendant holds pipes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-escaped-pipe-failure-"));
    const pidFile = join(directory, "owned-descendant.pid");
    const descendant = [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setTimeout(() => {}, 15_000);",
    ].join(" ");
    const leader = [
      'const { spawn } = require("node:child_process");',
      'const { existsSync } = require("node:fs");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: "inherit" }).unref();`,
      `const ready = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(ready); process.exit(0); } }, 10);`,
    ].join(" ");
    let deadline: NodeJS.Timeout | undefined;
    let cleanupCalls = 0;
    try {
      const started = Date.now();
      const result = await Promise.race([
        runContainedProcess({
          command: process.execPath,
          args: ["-e", leader],
          cwd: directory,
          env: sanitizedWorkerEnvironment(process.env),
          timeoutMs: 2_000,
          cancellationGraceMs: 20,
          terminateDescendants: async () => {
            cleanupCalls += 1;
            throw new Error("owned cleanup unavailable");
          },
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("escaped pipes blocked failure")), 3_000);
        }),
      ]);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("owned cleanup unavailable");
      expect(cleanupCalls).toBe(1);
      // Failure must not pretend it killed the escaped process. This test owns
      // its exact PID and removes it explicitly, never another process group.
      const descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 1).toBe(true);
      expect(() => process.kill(descendantPid, 0)).not.toThrow();
    } finally {
      if (deadline) clearTimeout(deadline);
      if (existsSync(pidFile)) {
        const descendantPid = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isSafeInteger(descendantPid) && descendantPid > 1) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // This exact test-owned descendant has already exited.
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
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
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("operator dirty change\n");

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
