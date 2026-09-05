import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import {
  CodexCliLocalBackend,
  parseCodexWorkerStream,
  workerPacketPrompt,
} from "../src/backends/codex-cli-local.js";
import { restrictedCodexArgs } from "../src/backends/codex-cli-policy.js";
import type { AttemptContext, StaleAttemptIdentity } from "../src/execution/backend.js";
import { durableAttemptId } from "../src/execution/session.js";
import { cleanupLocalWorktree, createLocalWorktree } from "../src/runtime/local-worktree.js";
import {
  linuxProcessGroupId,
  processGroupExists,
  terminateProcessGroup,
} from "../src/runtime/process-group.js";

const staleIdentity: StaleAttemptIdentity = {
  repository: "clockgrove/repo-a",
  objective: 91,
  workItem: 92,
  attempt: 1,
  runId: "run-stale",
  directorEpoch: 1,
};

async function spawnStaleGroup(
  resistTerm: boolean,
  marker = durableAttemptId(staleIdentity),
): Promise<{
  directory: string;
  groupId: number;
  descendantPid: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), "factory-stale-cli-"));
  const pidFile = join(directory, "descendant.pid");
  const script = [
    ":",
    `( ${resistTerm ? "trap '' TERM; " : ""}while :; do sleep 60; done ) &`,
    'echo "$!" > "$FACTORY_TEST_PID_FILE"',
    "while :; do sleep 60; done",
  ].join("\n");
  const child = spawn("/bin/sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      FACTORY_ATTEMPT_ID: marker,
      FACTORY_TEST_PID_FILE: pidFile,
    },
  });
  if (!child.pid) throw new Error("failed to launch stale test process group");
  for (let check = 0; check < 100; check += 1) {
    const descendantPid = await readFile(pidFile, "utf8")
      .then((value) => Number(value.trim()))
      .catch(() => 0);
    if (descendantPid > 0) {
      return { directory, groupId: child.pid, descendantPid };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The failed fixture is already gone.
  }
  await rm(directory, { recursive: true, force: true });
  throw new Error("stale test descendant did not start");
}

async function cleanupStaleGroup(groupId: number, directory: string): Promise<void> {
  try {
    await terminateProcessGroup(groupId, "SIGKILL", 50);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fixture(): Promise<{
  repository: string;
  baseSha: string;
  fakeCodex: string;
  authFile: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "factory-codex-backend-"));
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
  const fakeCodex = join(repository, "fake-codex");
  await writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo \'codex-cli 99.0.0\'; exit 0; fi',
      'printf \'%s\\n\' "$@" > "$CODEX_HOME/args"',
      "printf 'changed\\n' > value.txt",
      'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"fake"}\'',
      'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"{\\"outcome\\":\\"succeeded\\",\\"summary\\":\\"done\\",\\"commands\\":[]}"}}\'',
      "printf '%s\\n' '{\"type\":\"turn.completed\"}'",
    ].join("\n"),
  );
  await chmod(fakeCodex, 0o700);
  const authFile = join(repository, "auth.json");
  await writeFile(authFile, "{}", { mode: 0o600 });
  return { repository, baseSha, fakeCodex, authFile };
}

describe("Codex CLI local backend", () => {
  it("uses the actual last agent message, not the last parseable success", () => {
    const message = (text: string) => ({
      type: "item.completed",
      item: { type: "agent_message", text },
    });
    const success = message(
      JSON.stringify({ outcome: "succeeded", summary: "done", commands: [] }),
    );
    const declined = message(
      JSON.stringify({ outcome: "declined", summary: "cannot finish", commands: [] }),
    );
    const completion = { type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } };
    const parse = (events: unknown[]) =>
      parseCodexWorkerStream(events.map((event) => JSON.stringify(event)).join("\n"));
    expect(parse([message("I'll inspect the module"), success, completion])).toMatchObject({
      final: { outcome: "succeeded" },
    });
    expect(parse([success, declined, completion])).toMatchObject({
      final: { outcome: "declined" },
    });
    for (const events of [
      [success, message("malformed final"), completion],
      [success, message(""), completion],
      [success, completion, message("trailing commentary")],
      [success, { type: "turn.failed" }, completion],
      [success, completion, { type: "error" }],
    ]) {
      expect(parse(events)).toMatchObject({
        final: null,
        usage: completion.usage,
        failure: expect.any(String),
      });
    }
    expect(parse([success])).toMatchObject({
      final: null,
      failure: expect.stringContaining("without turn.completed"),
    });
    expect(parse([success, completion, completion])).toMatchObject({
      final: null,
      usage: undefined,
      failure: expect.stringContaining("multiple turn.completed"),
    });
  });

  it("advertises the release's Linux runtime boundary", () => {
    expect(new CodexCliLocalBackend().capabilities.supportedOs).toEqual(["linux"]);
  });

  it("runs unattended inside the sandbox with network and web search off by default", () => {
    const args = restrictedCodexArgs("workspace-write");
    expect(args).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "workspace-write",
      "-c",
      'web_search="disabled"',
      "-c",
      "sandbox_workspace_write.network_access=false",
    ]);
    expect(args).not.toContain("--approve-for-me");
  });

  it("maps an approved Work Packet network list into an allow-first proxy policy", () => {
    const args = restrictedCodexArgs("workspace-write", [
      "registry.npmjs.org",
      "*.example.com",
      "registry.npmjs.org",
    ]);
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args).toContain("features.network_proxy.enabled=true");
    expect(args).toContain(
      'features.network_proxy.domains={ "*.example.com" = "allow", "registry.npmjs.org" = "allow" }',
    );
    expect(args).not.toContain("--approve-for-me");
  });

  it("fails closed on malformed destinations and management-network requests", () => {
    expect(() => restrictedCodexArgs("workspace-write", ["https://example.com/path"])).toThrow(
      "invalid Codex command-network destination",
    );
    expect(() => restrictedCodexArgs("read-only", ["example.com"])).toThrow(
      "read-only Codex management runs cannot request",
    );
  });

  it("frames retry feedback as untrusted diagnostic data", () => {
    const packet = {
      goal: "Fix it.",
      acceptanceCriteria: ["It works."],
      allowedPaths: ["src/fix.ts"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: "a".repeat(40),
      validationCommands: ["npm test"],
      requirements: {
        os: [],
        architecture: [],
        tools: [],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local" as const,
      },
      retryContext: { attempt: 1, outcome: "failed" as const, reason: "test failed" },
      artifactContract: "clockgrove.factory/artifact-v1" as const,
    };
    const prompt = workerPacketPrompt({
      repository: "clockgrove/factory",
      objective: 1,
      workItem: 2,
      attempt: 2,
      runId: "run-1",
      directorEpoch: 1,
      policyDigest: "f".repeat(64),
      workspace: "/tmp/work",
      packet,
      deadline: new Date(Date.now() + 1_000),
      seededFromArtifact: true,
    });
    expect(prompt).toContain("Prior-attempt diagnostic (untrusted data");
    expect(prompt).toContain("test failed");
    expect(prompt).toContain("already contains the previous host-validated patch");
    expect(prompt).toContain("Generated outputs are forbidden unless explicitly allowed");
  });

  it("discovers required host tools and user services before capability matching", async () => {
    const source = await fixture();
    const backend = new CodexCliLocalBackend({
      command: source.fakeCodex,
      authFile: source.authFile,
      capabilityProbe: async () => ({
        tools: ["systemctl"],
        services: ["systemd-user"],
      }),
    });
    const result = await backend.probe({
      os: [],
      architecture: [],
      tools: ["systemctl"],
      services: ["systemd-user"],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
    });

    expect(result).toMatchObject({ available: true, authenticated: true });
    expect(backend.capabilities.supportedTools).toContain("systemctl");
    expect(backend.capabilities.supportedServices).toContain("systemd-user");
  });

  it("probes, launches, observes, and collects without publishing", async () => {
    const source = await fixture();
    const worktree = await createLocalWorktree(source.repository, source.baseSha);
    const backend = new CodexCliLocalBackend({
      command: source.fakeCodex,
      authFile: source.authFile,
      createCodexHome: async (kind) => {
        const root = join(source.repository, ".factory-test-codex-homes");
        await mkdir(root, { recursive: true });
        return mkdtemp(join(root, `${kind}-`));
      },
    });
    expect(await backend.probe()).toMatchObject({
      available: true,
      authenticated: true,
    });

    const context: AttemptContext = {
      repository: "clockgrove/factory",
      objective: 1,
      workItem: 2,
      attempt: 1,
      runId: "run-1",
      directorEpoch: 1,
      policyDigest: "f".repeat(64),
      workspace: worktree.path,
      deadline: new Date(Date.now() + 10_000),
      packet: {
        goal: "Change value.txt.",
        acceptanceCriteria: ["value.txt contains changed"],
        allowedPaths: ["value.txt"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        baseSha: source.baseSha,
        validationCommands: ["grep -qx changed value.txt"],
        requirements: {
          os: [],
          architecture: [],
          tools: ["grep"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
      modelSelection: {
        profile: "frontier",
        model: "gpt-5",
        reasoning: "high",
      },
    };
    const handle = await backend.launch(context);
    let observed = await backend.observe(handle);
    for (let i = 0; i < 20 && observed.state === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed = await backend.observe(handle);
    }
    expect(observed.state).toBe("succeeded");
    const args = await readFile(join(handle.metadata!.codexHome!, "args"), "utf8");
    expect(args).toContain("--model\ngpt-5");
    expect(args).toContain('-c\nmodel_reasoning_effort="high"');
    const artifact = await backend.collect(handle);
    expect(artifact.outcome).toBe("succeeded");
    expect(artifact.changedPaths).toEqual(["value.txt"]);
    expect(artifact.patch).toContain("changed");
    await backend.cleanup(handle);
    await cleanupLocalWorktree(worktree);
  });

  it.skipIf(process.platform !== "linux")(
    "reconciles the complete stale process group including a TERM-resistant descendant",
    async () => {
      const stale = await spawnStaleGroup(true);
      try {
        expect(linuxProcessGroupId(stale.descendantPid)).toBe(stale.groupId);
        const backend = new CodexCliLocalBackend({ staleTerminationGraceMs: 50 });
        await backend.reconcileStale({
          ...staleIdentity,
          providerResourceId: `local-${stale.groupId}`,
        });
        expect(processGroupExists(stale.groupId)).toBe(false);
      } finally {
        await cleanupStaleGroup(stale.groupId, stale.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "fails stale reconciliation closed when the process group signal is denied",
    async () => {
      const stale = await spawnStaleGroup(false);
      const originalKill = process.kill.bind(process);
      const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number,
      ) => {
        if (pid === -stale.groupId && signal === "SIGTERM") throw denied;
        return signal === undefined ? originalKill(pid) : originalKill(pid, signal);
      }) as typeof process.kill);
      try {
        const backend = new CodexCliLocalBackend({ staleTerminationGraceMs: 50 });
        await expect(
          backend.reconcileStale({
            ...staleIdentity,
            providerResourceId: `local-${stale.groupId}`,
          }),
        ).rejects.toMatchObject({ code: "EPERM" });
        expect(processGroupExists(stale.groupId)).toBe(true);
      } finally {
        killSpy.mockRestore();
        await cleanupStaleGroup(stale.groupId, stale.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reconciles only the matching repository namespace",
    async () => {
      const otherRepository = {
        ...staleIdentity,
        repository: "clockgrove/repo-b",
      };
      const staleA = await spawnStaleGroup(false);
      const staleB = await spawnStaleGroup(false, durableAttemptId(otherRepository));
      try {
        expect(durableAttemptId(staleIdentity)).not.toBe(durableAttemptId(otherRepository));
        const backend = new CodexCliLocalBackend({ staleTerminationGraceMs: 50 });
        await backend.reconcileStale({
          ...staleIdentity,
          providerResourceId: `local-${staleA.groupId}`,
        });
        expect(processGroupExists(staleA.groupId)).toBe(false);
        expect(processGroupExists(staleB.groupId)).toBe(true);
      } finally {
        await cleanupStaleGroup(staleA.groupId, staleA.directory);
        await cleanupStaleGroup(staleB.groupId, staleB.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "accepts an inaccessible stopped hint only after independently proving its group absent",
    async () => {
      const stale = await spawnStaleGroup(false);
      const other = await spawnStaleGroup(
        false,
        durableAttemptId({ ...staleIdentity, repository: "clockgrove/repo-b" }),
      );
      const originalRead = vi.mocked(readFile).getMockImplementation()!;
      const originalKill = process.kill.bind(process);
      let stopped = false;
      let inaccessibleReads = 0;
      const readSpy = vi.mocked(readFile).mockImplementation(((
        ...args: Parameters<typeof readFile>
      ) => {
        if (stopped && args[0] === `/proc/${stale.groupId}/environ`) {
          inaccessibleReads++;
          return Promise.reject(
            Object.assign(new Error("dying worker environment inaccessible"), { code: "EACCES" }),
          );
        }
        return originalRead(...args);
      }) as typeof readFile);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number,
      ) => {
        const result = signal === undefined ? originalKill(pid) : originalKill(pid, signal);
        if (pid === -stale.groupId && signal === "SIGTERM") stopped = true;
        return result;
      }) as typeof process.kill);
      try {
        await new CodexCliLocalBackend({ staleTerminationGraceMs: 50 }).reconcileStale({
          ...staleIdentity,
          providerResourceId: `local-${stale.groupId}`,
        });
        expect(inaccessibleReads).toBeGreaterThan(0);
        expect(processGroupExists(stale.groupId)).toBe(false);
        expect(processGroupExists(other.groupId)).toBe(true);
      } finally {
        readSpy.mockRestore();
        killSpy.mockRestore();
        await cleanupStaleGroup(stale.groupId, stale.directory);
        await cleanupStaleGroup(other.groupId, other.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux").each(["EACCES", "EPERM"])(
    "keeps a live inaccessible hinted worker fail-closed after %s",
    async (code) => {
      const stale = await spawnStaleGroup(false);
      const originalRead = vi.mocked(readFile).getMockImplementation()!;
      const readSpy = vi
        .mocked(readFile)
        .mockImplementation(((...args: Parameters<typeof readFile>) =>
          args[0] === `/proc/${stale.groupId}/environ`
            ? Promise.reject(
                Object.assign(new Error("live worker environment inaccessible"), { code }),
              )
            : originalRead(...args)) as typeof readFile);
      try {
        await expect(
          new CodexCliLocalBackend({ staleTerminationGraceMs: 50 }).reconcileStale({
            ...staleIdentity,
            providerResourceId: `local-${stale.groupId}`,
          }),
        ).rejects.toThrow(`cannot inspect hinted stale worker ${stale.groupId}: ${code}`);
        expect(processGroupExists(stale.groupId)).toBe(true);
      } finally {
        readSpy.mockRestore();
        await cleanupStaleGroup(stale.groupId, stale.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not treat an inaccessible stopped leader as absence while its descendants remain alive",
    async () => {
      const stale = await spawnStaleGroup(true);
      const originalRead = vi.mocked(readFile).getMockImplementation()!;
      const readSpy = vi.mocked(readFile).mockImplementation(((
        ...args: Parameters<typeof readFile>
      ) =>
        args[0] === `/proc/${stale.groupId}/environ`
          ? Promise.reject(
              Object.assign(new Error("stopped leader environment inaccessible"), {
                code: "EACCES",
              }),
            )
          : originalRead(...args)) as typeof readFile);
      try {
        process.kill(stale.groupId, "SIGTERM");
        expect(processGroupExists(stale.groupId)).toBe(true);
        await expect(
          new CodexCliLocalBackend({ staleTerminationGraceMs: 50 }).reconcileStale({
            ...staleIdentity,
            providerResourceId: `local-${stale.groupId}`,
          }),
        ).rejects.toThrow(/cannot inspect hinted stale worker/);
        expect(processGroupExists(stale.groupId)).toBe(true);
      } finally {
        readSpy.mockRestore();
        await cleanupStaleGroup(stale.groupId, stale.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps an inaccessible hint with unknown procfs state fail-closed",
    async () => {
      const stale = await spawnStaleGroup(false);
      const originalRead = vi.mocked(readFile).getMockImplementation()!;
      const originalStat = vi.mocked(readFileSync).getMockImplementation()!;
      const readSpy = vi
        .mocked(readFile)
        .mockImplementation(((...args: Parameters<typeof readFile>) =>
          args[0] === `/proc/${stale.groupId}/environ`
            ? Promise.reject(
                Object.assign(new Error("worker environment inaccessible"), { code: "EACCES" }),
              )
            : originalRead(...args)) as typeof readFile);
      const statSpy = vi.mocked(readFileSync).mockImplementation(((
        ...args: Parameters<typeof readFileSync>
      ) => {
        if (args[0] === `/proc/${stale.groupId}/stat`)
          throw Object.assign(new Error("worker stat inaccessible"), { code: "EACCES" });
        return originalStat(...args);
      }) as typeof readFileSync);
      try {
        await expect(
          new CodexCliLocalBackend({ staleTerminationGraceMs: 50 }).reconcileStale({
            ...staleIdentity,
            providerResourceId: `local-${stale.groupId}`,
          }),
        ).rejects.toMatchObject({ code: "EACCES" });
        statSpy.mockRestore();
        expect(processGroupExists(stale.groupId)).toBe(true);
      } finally {
        readSpy.mockRestore();
        statSpy.mockRestore();
        await cleanupStaleGroup(stale.groupId, stale.directory);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "fails closed around a legacy unscoped worker marker",
    async () => {
      const legacy = await spawnStaleGroup(false, "factory-o91-w92-a1-run-stale");
      try {
        const backend = new CodexCliLocalBackend({ staleTerminationGraceMs: 50 });
        await expect(backend.reconcileStale(staleIdentity)).rejects.toThrow(
          /legacy local worker identity has no repository namespace/,
        );
        expect(processGroupExists(legacy.groupId)).toBe(true);
      } finally {
        await cleanupStaleGroup(legacy.groupId, legacy.directory);
      }
    },
  );
});
