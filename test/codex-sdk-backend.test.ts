import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexOptions, ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import {
  CodexSdkLocalBackend,
  createSdkContainmentWrapper,
} from "../src/backends/codex-sdk-local.js";
import { restrictedCodexConfig } from "../src/backends/codex-cli-policy.js";
import type { AttemptContext } from "../src/execution/backend.js";
import { durableAttemptId } from "../src/execution/session.js";
import { cleanupLocalWorktree, createLocalWorktree } from "../src/runtime/local-worktree.js";

async function repositoryFixture(): Promise<{
  repository: string;
  baseSha: string;
  authFile: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "factory-codex-sdk-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
    cwd: repository,
  });
  await writeFile(join(repository, "value.txt"), "base\n");
  execFileSync("git", ["add", "value.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const authFile = join(repository, "auth.json");
  await writeFile(authFile, "{}", { mode: 0o600 });
  return { repository, baseSha, authFile };
}

function context(workspace: string, baseSha: string): AttemptContext {
  return {
    repository: "clockgrove/factory",
    objective: 1,
    workItem: 2,
    attempt: 1,
    runId: "sdk-run",
    directorEpoch: 3,
    policyDigest: "f".repeat(64),
    workspace,
    deadline: new Date(Date.now() + 10_000),
    packet: {
      goal: "Change value.txt.",
      acceptanceCriteria: ["value.txt contains changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha,
      validationCommands: ["grep -qx changed value.txt"],
      requirements: {
        os: [],
        architecture: [],
        tools: ["grep"],
        services: [],
        networkDestinations: ["registry.npmjs.org"],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    },
  };
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("contained process did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
}

async function waitForPid(path: string): Promise<number> {
  for (let check = 0; check < 100; check += 1) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (/^\d+$/.test(value.trim())) return Number(value.trim());
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("contained grandchild did not report its PID");
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let check = 0; check < 100; check += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`contained descendant ${pid} survived termination`);
}

describe("Codex SDK local backend", () => {
  it("advertises the release's Linux runtime boundary", () => {
    expect(new CodexSdkLocalBackend().capabilities.supportedOs).toEqual(["linux"]);
  });

  it("maps the Work Packet network boundary into structured SDK config", () => {
    expect(restrictedCodexConfig("workspace-write")).toEqual({
      web_search: "disabled",
      sandbox_workspace_write: { network_access: false },
    });
    expect(
      restrictedCodexConfig("workspace-write", [
        "registry.npmjs.org",
        "*.example.com",
        "registry.npmjs.org",
      ]),
    ).toEqual({
      web_search: "disabled",
      sandbox_workspace_write: { network_access: true },
      features: {
        network_proxy: {
          enabled: true,
          domains: {
            "*.example.com": "allow",
            "registry.npmjs.org": "allow",
          },
        },
      },
    });
    expect(() => restrictedCodexConfig("workspace-write", ["https://example.com"])).toThrow(
      "invalid Codex command-network destination",
    );
  });

  it("owns SDK isolation, observation, usage, and the host-collected artifact", async () => {
    const fixture = await repositoryFixture();
    const worktree = await createLocalWorktree(fixture.repository, fixture.baseSha);
    let clientOptions: CodexOptions | undefined;
    let threadOptions: ThreadOptions | undefined;
    let turnOptions: TurnOptions | undefined;
    let prompt = "";
    const backend = new CodexSdkLocalBackend({
      authFile: fixture.authFile,
      credentialAvailable: () => true,
      capabilityProbe: async () => ({ tools: ["grep"], services: [] }),
      createCodexHome: async (kind) => {
        const homes = join(fixture.repository, "homes");
        await mkdir(homes, { recursive: true });
        return mkdtemp(join(homes, `${kind}-`));
      },
      createClient: (options) => {
        clientOptions = options;
        return {
          startThread(options) {
            threadOptions = options;
            return {
              id: null,
              async runStreamed(input, options) {
                prompt = input;
                turnOptions = options;
                await writeFile(join(worktree.path, "value.txt"), "changed\n");
                async function* events(): AsyncGenerator<ThreadEvent> {
                  yield { type: "thread.started", thread_id: "sdk-thread-1" };
                  yield {
                    type: "item.completed",
                    item: {
                      id: "final",
                      type: "agent_message",
                      text: JSON.stringify({
                        outcome: "succeeded",
                        summary: "done",
                        commands: [{ command: "edit value.txt", exitCode: 0 }],
                      }),
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 9,
                      output_tokens: 4,
                      cached_input_tokens: 2,
                      cache_write_input_tokens: 0,
                      reasoning_output_tokens: 1,
                    },
                  };
                }
                return { events: events() };
              },
            };
          },
        };
      },
    });

    const attemptContext = context(worktree.path, fixture.baseSha);
    attemptContext.modelSelection = {
      profile: "frontier",
      model: "gpt-5",
      reasoning: "high",
    };
    expect(await backend.probe(attemptContext.packet.requirements)).toMatchObject({
      available: true,
      authenticated: true,
    });
    const handle = await backend.launch(attemptContext);
    let observation = await backend.observe(handle);
    for (let check = 0; check < 20 && observation.state === "running"; check += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      observation = await backend.observe(handle);
    }
    expect(observation).toMatchObject({
      state: "succeeded",
      usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
    });
    expect(handle.metadata?.threadId).toBe("sdk-thread-1");
    expect(threadOptions).toMatchObject({
      workingDirectory: worktree.path,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      networkAccessEnabled: true,
      model: "gpt-5",
      modelReasoningEffort: "high",
    });
    expect(clientOptions?.config).toMatchObject({
      web_search: "disabled",
      sandbox_workspace_write: { network_access: true },
      features: {
        network_proxy: {
          domains: { "registry.npmjs.org": "allow" },
        },
      },
    });
    expect(clientOptions?.env?.GH_TOKEN).toBeUndefined();
    expect(clientOptions?.env?.FACTORY_ATTEMPT_ID).toBe(durableAttemptId(attemptContext));
    expect(turnOptions?.outputSchema).toBeDefined();
    expect(turnOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(prompt).toContain("restricted Factory implementation worker");

    const artifact = await backend.collect(handle);
    expect(artifact).toMatchObject({
      baseSha: fixture.baseSha,
      changedPaths: ["value.txt"],
      outcome: "succeeded",
      commands: [{ command: "edit value.txt", exitCode: 0, durationMs: 0 }],
    });
    expect(artifact.patch).toContain("changed");
    await backend.cleanup(handle);
    await cleanupLocalWorktree(worktree);
  });

  it("fails closed when the SDK runtime or a credential is unavailable", async () => {
    const unavailable = new CodexSdkLocalBackend({
      createClient: () => {
        throw new Error("SDK native binary missing");
      },
      credentialAvailable: () => true,
    });
    expect(await unavailable.probe()).toMatchObject({
      available: false,
      authenticated: false,
      reason: "SDK native binary missing",
    });

    const unauthenticated = new CodexSdkLocalBackend({
      createClient: () => ({
        startThread: () => {
          throw new Error("not used");
        },
      }),
      credentialAvailable: () => false,
    });
    expect(await unauthenticated.probe()).toMatchObject({
      available: true,
      authenticated: false,
      reason: "no Codex login or permitted model credential was found",
    });
  });

  it("rejects streamed secret material before bounded logs can discard it", async () => {
    const fixture = await repositoryFixture();
    const worktree = await createLocalWorktree(fixture.repository, fixture.baseSha);
    const homes = join(fixture.repository, "secret-homes");
    let abortObserved = false;
    let processExitObserved = false;
    const backend = new CodexSdkLocalBackend({
      authFile: fixture.authFile,
      createCodexHome: async (kind) => {
        await mkdir(homes, { recursive: true });
        return mkdtemp(join(homes, `${kind}-`));
      },
      createClient: () => ({
        startThread: () => ({
          id: null,
          async runStreamed(_input, options) {
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield {
                  type: "error",
                  message: `authorization: bearer ghp_${"x".repeat(40)}`,
                };
                abortObserved = options?.signal?.aborted ?? false;
                if (abortObserved) {
                  // Model the SDK waiting for its containment wrapper to exit
                  // only while Factory continues draining after cancellation.
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  processExitObserved = true;
                }
              } finally {
                if (!abortObserved) {
                  // An iterator-return shortcut schedules termination but does
                  // not provide the exit fence cleanup requires.
                  setTimeout(() => {
                    processExitObserved = true;
                  }, 25);
                }
              }
            }
            return { events: events() };
          },
        }),
      }),
    });

    const handle = await backend.launch(context(worktree.path, fixture.baseSha));
    let observation = await backend.observe(handle);
    for (let check = 0; check < 20 && observation.state === "running"; check += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      observation = await backend.observe(handle);
    }
    expect(observation).toMatchObject({
      state: "failed",
      reason: "SDK event contains suspected GitHub token",
    });
    const artifact = await backend.collect(handle);
    expect(artifact.logs).not.toContain("ghp_");
    await backend.cleanup(handle);
    expect(abortObserved).toBe(true);
    expect(processExitObserved).toBe(true);
    await cleanupLocalWorktree(worktree);
  });

  it("aborts and observes the streamed process-exit fence after a secret violation", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-exit-fence-"));
    const workspace = join(root, "workspace");
    const homes = join(root, "homes");
    await mkdir(workspace);
    let abortObserved = false;
    let processExitObserved = false;
    const backend = new CodexSdkLocalBackend({
      createCodexHome: async (kind) => {
        await mkdir(homes, { recursive: true });
        return mkdtemp(join(homes, `${kind}-`));
      },
      createClient: () => ({
        startThread: () => ({
          id: null,
          async runStreamed(_input, options) {
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield {
                  type: "error",
                  message: `authorization: bearer ghp_${"x".repeat(40)}`,
                };
                abortObserved = options?.signal?.aborted ?? false;
                if (abortObserved) {
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  processExitObserved = true;
                }
              } finally {
                if (!abortObserved) {
                  setTimeout(() => {
                    processExitObserved = true;
                  }, 25);
                }
              }
            }
            return { events: events() };
          },
        }),
      }),
    });

    try {
      const handle = await backend.launch(context(workspace, "b".repeat(40)));
      let observation = await backend.observe(handle);
      for (let check = 0; check < 20 && observation.state === "running"; check += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observation = await backend.observe(handle);
      }
      expect(observation).toMatchObject({
        state: "failed",
        reason: "SDK event contains suspected GitHub token",
      });
      await backend.cleanup(handle);
      expect(abortObserved).toBe(true);
      expect(processExitObserved).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when a valid final result is followed by turn.failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-failed-turn-"));
    const workspace = join(root, "workspace");
    const homes = join(root, "homes");
    await mkdir(workspace);
    const backend = new CodexSdkLocalBackend({
      createCodexHome: async (kind) => {
        await mkdir(homes, { recursive: true });
        return mkdtemp(join(homes, `${kind}-`));
      },
      createClient: () => ({
        startThread: () => ({
          id: null,
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              yield {
                type: "item.completed",
                item: {
                  id: "final",
                  type: "agent_message",
                  text: JSON.stringify({
                    outcome: "succeeded",
                    summary: "not actually complete",
                    commands: [],
                  }),
                },
              };
              yield { type: "turn.failed", error: { message: "provider turn failed" } };
            }
            return { events: events() };
          },
        }),
      }),
    });

    try {
      const handle = await backend.launch(context(workspace, "b".repeat(40)));
      let observation = await backend.observe(handle);
      for (let check = 0; check < 20 && observation.state === "running"; check += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observation = await backend.observe(handle);
      }
      expect(observation).toMatchObject({
        state: "failed",
        reason: "provider turn failed",
      });
      await backend.cleanup(handle);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the SDK event stream ends without turn.completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-missing-completion-"));
    const workspace = join(root, "workspace");
    const homes = join(root, "homes");
    await mkdir(workspace);
    const backend = new CodexSdkLocalBackend({
      createCodexHome: async (kind) => {
        await mkdir(homes, { recursive: true });
        return mkdtemp(join(homes, `${kind}-`));
      },
      createClient: () => ({
        startThread: () => ({
          id: null,
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              yield {
                type: "item.completed",
                item: {
                  id: "final",
                  type: "agent_message",
                  text: JSON.stringify({
                    outcome: "succeeded",
                    summary: "missing completion fence",
                    commands: [],
                  }),
                },
              };
            }
            return { events: events() };
          },
        }),
      }),
    });

    try {
      const handle = await backend.launch(context(workspace, "b".repeat(40)));
      let observation = await backend.observe(handle);
      for (let check = 0; check < 20 && observation.state === "running"; check += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observation = await backend.observe(handle);
      }
      expect(observation).toMatchObject({
        state: "failed",
        reason: "SDK worker stream ended without turn.completed",
      });
      await backend.cleanup(handle);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "linux")("Codex SDK process containment", () => {
  async function containmentFixture(
    supervisorPid: number,
    resistantDescendant = false,
    rootExitsNaturally = false,
  ): Promise<{
    root: string;
    wrapper: string;
    pidFile: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-containment-"));
    const pidFile = join(root, "grandchild.pid");
    const target = join(root, "target.mjs");
    const descendantSource = [
      'const { writeFileSync } = require("node:fs");',
      ...(resistantDescendant ? ['process.on("SIGTERM", () => {});'] : []),
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    await writeFile(
      target,
      [
        'import { spawn } from "node:child_process";',
        'import { existsSync } from "node:fs";',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
        ...(resistantDescendant ? ['process.on("SIGTERM", () => process.exit(0));'] : []),
        rootExitsNaturally
          ? `const ready = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(ready); process.exit(0); } }, 10);`
          : "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const wrapper = await createSdkContainmentWrapper(
      root,
      { command: process.execPath, args: [target] },
      supervisorPid,
    );
    return { root, wrapper, pidFile };
  }

  it("terminates the complete Codex process group on SDK abort", async () => {
    const fixture = await containmentFixture(process.pid, true);
    const wrapper = spawn(fixture.wrapper, [], { stdio: "ignore" });
    let grandchild = 0;
    try {
      grandchild = await waitForPid(fixture.pidFile);
      wrapper.kill("SIGTERM");
      await waitForExit(wrapper);
      await waitUntilGone(grandchild);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
      if (grandchild) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // Already terminated by the wrapper.
        }
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("terminates descendants when the recorded Factory supervisor is gone", async () => {
    const fixture = await containmentFixture(2_147_483_647);
    const wrapper = spawn(fixture.wrapper, [], { stdio: "ignore" });
    let grandchild = 0;
    try {
      grandchild = await waitForPid(fixture.pidFile);
      await waitForExit(wrapper);
      await waitUntilGone(grandchild);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
      if (grandchild) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // Already terminated by the wrapper.
        }
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("terminates a resistant background descendant after Codex exits naturally", async () => {
    const fixture = await containmentFixture(process.pid, true, true);
    const wrapper = spawn(fixture.wrapper, [], { stdio: "ignore" });
    let grandchild = 0;
    try {
      grandchild = await waitForPid(fixture.pidFile);
      await waitForExit(wrapper);
      await waitUntilGone(grandchild);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
      if (grandchild) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // Already terminated by the wrapper.
        }
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("proves marker-process absence after a terminal SDK stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-terminal-orphan-"));
    const workspace = join(root, "workspace");
    const homes = join(root, "homes");
    await mkdir(workspace);
    const attemptContext = context(workspace, "b".repeat(40));
    const backend = new CodexSdkLocalBackend({
      createCodexHome: async (kind) => {
        await mkdir(homes, { recursive: true });
        return mkdtemp(join(homes, `${kind}-`));
      },
      createClient: () => ({
        startThread: () => ({
          id: null,
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              yield { type: "turn.failed", error: { message: "wrapper exited" } };
            }
            return { events: events() };
          },
        }),
      }),
    });
    let orphan: ChildProcess | undefined;
    try {
      const handle = await backend.launch(attemptContext);
      let observation = await backend.observe(handle);
      for (let check = 0; check < 20 && observation.state === "running"; check += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observation = await backend.observe(handle);
      }
      expect(observation.state).toBe("failed");

      orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        env: {
          ...process.env,
          FACTORY_ATTEMPT_ID: durableAttemptId(attemptContext),
        },
        stdio: "ignore",
      });
      if (!orphan.pid) throw new Error("orphan fixture did not start");
      await new Promise((resolve) => setTimeout(resolve, 50));

      await backend.cleanup(handle);
      await waitUntilGone(orphan.pid);
    } finally {
      if (orphan?.pid) {
        try {
          process.kill(orphan.pid, "SIGKILL");
        } catch {
          // Cleanup proved it was already gone.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "leaves an otherwise identical worker from another repository alive",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "factory-sdk-repo-scope-"));
      const attemptA = context(root, "b".repeat(40));
      const attemptB = {
        ...attemptA,
        repository: "clockgrove/another-repository",
      };
      let workerA: ChildProcess | undefined;
      let workerB: ChildProcess | undefined;
      try {
        workerA = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          env: { ...process.env, FACTORY_ATTEMPT_ID: durableAttemptId(attemptA) },
          stdio: "ignore",
        });
        workerB = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          env: { ...process.env, FACTORY_ATTEMPT_ID: durableAttemptId(attemptB) },
          stdio: "ignore",
        });
        if (!workerA.pid || !workerB.pid) {
          throw new Error("repository-scoped SDK fixtures did not start");
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        await new CodexSdkLocalBackend().reconcileStale(attemptA);
        await waitUntilGone(workerA.pid);
        expect(() => process.kill(workerB!.pid!, 0)).not.toThrow();
      } finally {
        for (const worker of [workerA, workerB]) {
          if (!worker?.pid) continue;
          try {
            process.kill(worker.pid, "SIGKILL");
          } catch {
            // A worker already fenced by the test is absent.
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("bounds raw stdout before the SDK can buffer an unbounded JSONL line", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-output-limit-"));
    const target = join(root, "target.mjs");
    await writeFile(target, 'process.stdout.write("x".repeat(2 * 1024 * 1024));');
    const wrapper = await createSdkContainmentWrapper(
      root,
      { command: process.execPath, args: [target] },
      process.pid,
    );
    try {
      expect(() =>
        execFileSync(wrapper, [], {
          encoding: "utf8",
          maxBuffer: 3 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).toThrow(/bounded-output limit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
