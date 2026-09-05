import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { CodexCliLocalBackend } from "../src/backends/codex-cli-local.js";
import {
  CodexSdkLocalBackend,
  createSdkContainmentWrapper,
} from "../src/backends/codex-sdk-local.js";
import { localExecutionScopeBatch, type AttemptContext } from "../src/execution/backend.js";
import { localScopeUnit, type LocalScopeProcessPort } from "../src/runtime/local-scope.js";
import type { StartProcessOptions } from "../src/runtime/process-group.js";
import { workerPacketDigest } from "../src/protocol/worker-packet.js";

function context(workspace = "/tmp"): AttemptContext {
  const deadline = new Date(Date.now() + 10_000);
  const prepared: AttemptContext = {
    repository: "o/r",
    objective: 1,
    workItem: 2,
    attempt: 1,
    runId: "owned-execution",
    directorEpoch: 3,
    policyDigest: "a".repeat(64),
    workspace,
    deadline,
    packet: {
      goal: "Change value.txt",
      acceptanceCriteria: ["value.txt changes"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: "b".repeat(40),
      validationCommands: ["node --test"],
      artifactContract: "clockgrove.factory/artifact-v1",
      requirements: {
        os: [],
        architecture: [],
        tools: [],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
    },
    localExecutionScope: {
      batch: {
        identity: {
          protocol: "clockgrove.factory/local-scope-v1",
          repository: "o/r",
          objective: 1,
          workItem: 2,
          attempt: 1,
          runId: "owned-execution",
          directorEpoch: 3,
          policyDigest: "a".repeat(64),
          phase: "execution",
          commandIndex: 0,
          invocationDigest: "c".repeat(64),
          hostIdentity: "d".repeat(64),
        },
        commandCount: 1,
        producerPid: process.pid,
        producerStartTicks: "100",
        deadline: deadline.toISOString(),
      },
      assertCurrent: vi.fn(async () => undefined),
    },
  };
  prepared.localExecutionScope!.batch.identity.invocationDigest = workerPacketDigest(
    prepared.packet,
  );
  return prepared;
}

function portFixture(input: AttemptContext) {
  const unit = localScopeUnit(input.localExecutionScope!.batch.identity);
  let state: "absent" | "active" | "unknown" = "absent";
  const log: string[] = [];
  const final = { outcome: "succeeded", summary: "done", commands: [] };
  const events: ThreadEvent[] = [
    {
      type: "item.completed",
      item: { id: "final", type: "agent_message", text: JSON.stringify(final) },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        cached_input_tokens: 1,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ];
  const show = vi.fn(async (requested: string) => {
    expect(requested).toBe(unit);
    if (state === "unknown") throw new Error("private observation failure");
    return Object.entries({
      Id: unit,
      LoadState: state === "absent" ? "not-found" : "loaded",
      ActiveState: state === "absent" ? "inactive" : "active",
      SubState: state === "absent" ? "dead" : "running",
      ControlGroup: state === "absent" ? "" : `/user.slice/app.slice/${unit}`,
      Job: "",
      InvocationID: "e".repeat(32),
      KillMode: "control-group",
    })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  });
  const stop = vi.fn(async (requested: string) => {
    expect(requested).toBe(unit);
    log.push("stop");
    state = "absent";
  });
  const start = vi.fn((_options: StartProcessOptions) => {
    log.push("spawn");
    state = "active";
    return {
      pid: 321,
      completed: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: events.map((event) => JSON.stringify(event)).join("\n"),
        stderr: "",
        durationMs: 2,
        timedOut: false,
      }),
      cancel: async () => undefined,
    };
  });
  const port: LocalScopeProcessPort = {
    hostIdentity: async () => input.localExecutionScope!.batch.identity.hostIdentity,
    show,
    read: async (path) =>
      path === "/proc/self/mountinfo"
        ? "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
        : "populated 1\n",
    now: () => new Date(),
    start,
    stop,
  };
  input.localExecutionScope!.assertCurrent = vi.fn(async () => {
    log.push("fence");
  });
  return {
    port,
    log,
    events,
    start,
    stop,
    unit,
    setState(next: typeof state) {
      state = next;
    },
  };
}

describe("prepared local execution scope bindings", () => {
  it("the SDK wrapper rejects producer KillMode changes before starting the actual executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-sdk-producer-fence-"));
    try {
      const input = context();
      const identity = {
        ...input.localExecutionScope!.batch.identity,
        producerUnit: "fixture-producer.service",
        producerInvocationId: "e".repeat(32),
      };
      const systemctl = join(directory, "systemctl");
      await writeFile(
        systemctl,
        `#!${process.execPath}\nconst unit=process.argv[4];const producer=unit===${JSON.stringify(identity.producerUnit)};console.log(Object.entries({Id:unit,LoadState:producer?'loaded':'not-found',ActiveState:producer?'active':'inactive',ControlGroup:producer?'/fixture-producer.service':'',Job:'',InvocationID:producer?'${identity.producerInvocationId}':'',KillMode:'process'}).map(([k,v])=>k+'='+v).join('\\n'));\n`,
      );
      await chmod(systemctl, 0o700);
      const wrapper = await createSdkContainmentWrapper(
        directory,
        { command: "/must-not-launch", args: [] },
        process.pid,
        { identity, deadline: input.deadline },
      );
      await expect(
        promisify(execFile)(wrapper, [], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          timeout: 3000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Factory SDK producer generation changed"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["goal", "retry"])("rejects %s packet changes after journaling", (change) => {
    const input = context();
    if (change === "goal") input.packet.goal = "Different work";
    else input.packet.preconditions.push("Repair the previously rejected artifact");
    expect(() => localExecutionScopeBatch(input)).toThrow("does not match");
  });
  it("preserves the portable baseline when no journaled scope is supplied", () => {
    const input = context();
    delete input.localExecutionScope;
    expect(localExecutionScopeBatch(input)).toBeUndefined();
  });
  it.each([
    { repository: "other/repo" },
    { objective: 3 },
    { workItem: 4 },
    { attempt: 2 },
    { runId: "another-run" },
    { directorEpoch: 4 },
    { policyDigest: "f".repeat(64) },
    { phase: "validation" },
    { commandIndex: 1 },
  ])("rejects borrowed scope identity %j", (change) => {
    const input = context();
    Object.assign(input.localExecutionScope!.batch.identity, change);
    expect(() => localExecutionScopeBatch(input)).toThrow();
  });
  it.each([
    { commandCount: 2 },
    { producerPid: process.pid + 1 },
    { deadline: "2026-01-01T00:00:00.000Z" },
  ])("rejects incompatible journal %j", (change) => {
    const input = context();
    Object.assign(input.localExecutionScope!.batch, change);
    expect(() => localExecutionScopeBatch(input)).toThrow();
  });
});

describe.each(["cli", "sdk"] as const)("%s journaled execution scope", (kind) => {
  async function fixture(wrapperCleanupUnverified = false) {
    const directory = await mkdtemp(join(tmpdir(), "factory-owned-backend-"));
    const input = context(directory);
    const f = portFixture(input);
    let clientOptions: CodexOptions | undefined;
    const common = {
      authFile: join(directory, "no-auth.json"),
      createCodexHome: async () => mkdtemp(join(directory, "home-")),
      localScopePort: f.port,
    };
    const backend =
      kind === "cli"
        ? new CodexCliLocalBackend({ ...common, command: "/bin/true" })
        : new CodexSdkLocalBackend({
            ...common,
            codexPathOverride: "/bin/true",
            createClient: (options) => {
              clientOptions = options;
              f.log.push("client");
              return {
                startThread: () => ({
                  id: null,
                  runStreamed: async () => {
                    f.log.push("spawn");
                    f.setState("active");
                    return {
                      events: (async function* () {
                        for (const event of f.events) yield event;
                        if (wrapperCleanupUnverified) {
                          f.setState("absent");
                          yield {
                            type: "error" as const,
                            message: "Factory SDK owned scope cleanup unverified",
                          };
                          // The real SDK prioritizes spawnError over exit/stderr
                          // after an AbortSignal, so the marker must survive it.
                          const error = new Error("The operation was aborted");
                          error.name = "AbortError";
                          throw error;
                        }
                      })(),
                    };
                  },
                }),
              };
            },
          });
    return { ...f, directory, input, backend, clientOptions: () => clientOptions };
  }
  it("fences before execution and proves exact resource cleanup before success", async () => {
    const f = await fixture();
    try {
      const handle = await f.backend.launch(f.input);
      await vi.waitFor(async () =>
        expect((await f.backend.observe(handle)).state).toBe("succeeded"),
      );
      expect(f.log.indexOf("fence")).toBeLessThan(f.log.indexOf("spawn"));
      expect(f.input.localExecutionScope!.assertCurrent).toHaveBeenCalledOnce();
      expect(f.stop.mock.calls).toEqual([[f.unit]]);
      if (kind === "cli") {
        const spawned = f.start.mock.calls[0]![0];
        expect(spawned.command).toBe("systemd-run");
        expect(spawned.args).toContain(`--unit=${f.unit}`);
        expect(spawned.args).toContain("--collect");
        expect(spawned.args).toContain("--ask-for-approval");
        expect(spawned.args).toContain("never");
        expect(spawned.env?.FACTORY_ATTEMPT_ID).toBeTruthy();
      } else {
        const wrapper = await readFile(f.clientOptions()!.codexPathOverride!, "utf8");
        expect(wrapper).toContain(f.unit);
        expect(wrapper).toContain("--collect");
        expect(wrapper).toContain('stdio: ["inherit", "pipe", "pipe"]');
        expect(f.clientOptions()!.env?.FACTORY_ATTEMPT_ID).toBeTruthy();
      }
      await f.backend.observe(handle);
      expect(f.input.localExecutionScope!.assertCurrent).toHaveBeenCalledOnce();
      await f.backend.cleanup(handle);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("does not launch after the supplied journal/lease fence rejects", async () => {
    const f = await fixture();
    try {
      f.input.localExecutionScope!.assertCurrent = vi.fn(async () => {
        throw new Error("fenced");
      });
      await expect(f.backend.launch(f.input)).rejects.toThrow("fenced");
      expect(f.log).not.toContain("spawn");
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("does not expose terminal success while exact resource cleanup is pending", async () => {
    const f = await fixture();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.stop.mockImplementation(async () => {
      await cleanup;
      f.setState("absent");
    });
    try {
      const handle = await f.backend.launch(f.input);
      await vi.waitFor(() => expect(f.stop).toHaveBeenCalled());
      expect((await f.backend.observe(handle)).state).toBe("running");
      release();
      await vi.waitFor(async () =>
        expect((await f.backend.observe(handle)).state).toBe("succeeded"),
      );
      await f.backend.cleanup(handle);
    } finally {
      release();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("fails closed and preserves its cleanup handle when exact scope stop fails", async () => {
    const f = await fixture();
    f.stop.mockRejectedValue(new Error("private systemd exception"));
    try {
      const handle = await f.backend.launch(f.input);
      await vi.waitFor(async () => expect((await f.backend.observe(handle)).state).toBe("failed"));
      expect((await f.backend.observe(handle)).reason).toContain("cleanup is unverified");
      expect((await f.backend.observe(handle)).reason).not.toContain("private");
      await expect(f.backend.cleanup(handle)).rejects.toThrow("scope stop unavailable");
      f.setState("absent");
      await f.backend.cleanup(handle);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("refuses a previously active exact scope before starting a second execution", async () => {
    const f = await fixture();
    try {
      f.setState("active");
      await expect(f.backend.launch(f.input)).rejects.toThrow("scope is not available");
      expect(f.log).not.toContain("spawn");
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it.skipIf(kind !== "sdk")(
    "does not turn unknown launcher cleanup into success from a momentarily absent scope",
    async () => {
      const f = await fixture(true);
      try {
        const handle = await f.backend.launch(f.input);
        await vi.waitFor(async () =>
          expect((await f.backend.observe(handle)).state).toBe("failed"),
        );
        expect((await f.backend.observe(handle)).usage).toMatchObject({
          inputTokens: 4,
          outputTokens: 2,
        });
        expect(await f.port.show(f.unit)).toContain("LoadState=not-found");
        await expect(f.backend.cleanup(handle)).rejects.toThrow("automated replacement is blocked");
        await expect(f.backend.cancel(handle)).rejects.toThrow("automated replacement is blocked");
        await expect(f.backend.collect(handle)).rejects.toThrow("automated replacement is blocked");
        await expect(f.backend.launch(f.input)).rejects.toThrow("automated replacement is blocked");
        await expect(f.backend.launch({ ...f.input, attempt: 2 })).rejects.toThrow(
          "automated replacement is blocked",
        );
        expect(f.log.filter((entry) => entry === "spawn")).toHaveLength(1);
        expect((await f.backend.observe(handle)).reason).toContain(
          "launcher cleanup is unverified",
        );
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );
});
