import { describe, expect, it, vi } from "vitest";
import {
  LocalScopeCleanupError,
  localScopeUnit,
  runScopedLocalProcess,
  startScopedLocalProcess,
  stopLocalScope,
  type LocalScopeIdentity,
  type LocalScopeProcessPort,
} from "../src/runtime/local-scope.js";
import type { ProcessResult, StartProcessOptions } from "../src/runtime/process-group.js";

const identity: LocalScopeIdentity = {
  protocol: "clockgrove.factory/local-scope-v1",
  repository: "o/r",
  objective: 1,
  workItem: 2,
  attempt: 1,
  runId: "scope-process",
  directorEpoch: 1,
  policyDigest: "a".repeat(64),
  phase: "validation",
  commandIndex: 0,
  invocationDigest: "f".repeat(64),
  hostIdentity: "b".repeat(64),
};
const options: StartProcessOptions = {
  command: "/bin/worker",
  args: ["${LITERAL}", "$(literal)", "space here"],
  cwd: "/tmp",
  env: { LITERAL: "environment-only" },
  timeoutMs: 250,
  maxOutputBytes: 1024,
  cancellationGraceMs: 20,
};
const result: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: "finished",
  stderr: "",
  durationMs: 12,
  timedOut: false,
};

function fixture(scopeIdentity: LocalScopeIdentity = identity) {
  const unit = localScopeUnit(scopeIdentity);
  let state: "absent" | "active" | "unknown" = "absent";
  let launch: StartProcessOptions | undefined;
  let resolve!: (result: ProcessResult) => void;
  const completed = new Promise<ProcessResult>((done) => {
    resolve = done;
  });
  const show = vi.fn(async () => {
    if (state === "unknown") throw new Error("private manager exception");
    return Object.entries({
      Id: unit,
      LoadState: state === "absent" ? "not-found" : "loaded",
      ActiveState: state === "absent" ? "inactive" : "active",
      SubState: state === "absent" ? "dead" : "running",
      ControlGroup: state === "absent" ? "" : `/user.slice/app.slice/${unit}`,
      Job: "",
      InvocationID: state === "absent" ? "" : "c".repeat(32),
      KillMode: "control-group",
    })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  });
  const hostIdentity = vi.fn(async (): Promise<string | null> => identity.hostIdentity);
  const stop = vi.fn(async (_unit: string) => {
    state = "absent";
  });
  const cancel = vi.fn(async (signal?: NodeJS.Signals) => {
    try {
      await launch?.terminateDescendants?.();
      resolve({ ...result, exitCode: null, signal: signal ?? "SIGTERM" });
    } catch (error) {
      resolve({ ...result, exitCode: 1, stdout: "", stderr: String(error) });
      throw error;
    }
  });
  const start = vi.fn((input: StartProcessOptions) => {
    launch = input;
    state = "active";
    return { pid: 123, completed, cancel };
  });
  const port: LocalScopeProcessPort = {
    hostIdentity,
    show,
    read: async (path) =>
      path === "/proc/self/mountinfo"
        ? "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
        : "populated 1\nfrozen 0\n",
    now: () => new Date("2026-09-05T00:00:00Z"),
    start,
    stop,
  };
  return {
    port,
    unit,
    start,
    stop,
    cancel,
    hostIdentity,
    setState(next: typeof state) {
      state = next;
    },
    resolve,
    async finish(value: ProcessResult = result) {
      // The process-group boundary invokes this before awaiting inherited pipes.
      try {
        await launch?.terminateDescendants?.();
        resolve(value);
      } catch (error) {
        resolve({ ...value, exitCode: 1, stdout: "", stderr: String(error) });
      }
    },
  };
}

describe("owned local scope process runner", () => {
  function producerFixture() {
    const bound = {
      ...identity,
      producerUnit: "factory-test-producer.service",
      producerInvocationId: "d".repeat(32),
    };
    const f = fixture(bound);
    const producer = {
      Id: bound.producerUnit,
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      ControlGroup: `/user.slice/app.slice/${bound.producerUnit}`,
      Job: "",
      InvocationID: bound.producerInvocationId,
      KillMode: "control-group",
    };
    const show = f.port.show;
    f.port.show = async (unit) =>
      unit === bound.producerUnit
        ? Object.entries(producer)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n")
        : show(unit);
    return { ...f, bound, producer };
  }

  it("allows the matching active producer generation with non-activating stop dependencies", async () => {
    const f = producerFixture();
    const child = await startScopedLocalProcess(f.bound, options, f.port);
    const args = f.start.mock.calls[0]![0].args!;
    for (const dependency of ["Requisite", "After", "StopPropagatedFrom"]) {
      expect(args).toContain(`--property=${dependency}=${f.bound.producerUnit}`);
    }
    expect(args).toContain("--property=RuntimeMaxSec=250ms");
    expect(args.some((arg) => /--property=(BindsTo|Requires)=/.test(arg))).toBe(false);
    await f.finish();
    expect(await child.completed).toBe(result);
    expect(f.stop.mock.calls).toEqual([[f.unit]]);
  });

  it.each([
    { InvocationID: "e".repeat(32) },
    { ActiveState: "inactive" },
    { ActiveState: "failed" },
    { Job: "42 /org/freedesktop/systemd1/job/42" },
    { LoadState: "not-found" },
  ])("refuses changed, inactive, or queued producer %j before spawn", async (change) => {
    const f = producerFixture();
    Object.assign(f.producer, change);
    await expect(startScopedLocalProcess(f.bound, options, f.port)).rejects.toThrow(
      "local scope producer generation is no longer active",
    );
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it.each([
    { producerUnit: "factory-test-producer.service" },
    { producerInvocationId: "d".repeat(32) },
    { producerUnit: "bad.service other.service", producerInvocationId: "d".repeat(32) },
    { producerUnit: "factory-test-producer.service", producerInvocationId: "not-an-invocation" },
  ])("requires a complete valid producer identity pair %j", async (change) => {
    const f = fixture();
    await expect(
      startScopedLocalProcess({ ...identity, ...change }, options, f.port),
    ).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it.each(["active", "unknown"] as const)(
    "rejects %s prelaunch without any effect",
    async (state) => {
      const f = fixture();
      f.setState(state);
      await expect(startScopedLocalProcess(identity, options, f.port)).rejects.toThrow(
        "owned local scope is not available for launch",
      );
      expect(f.start).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
    },
  );

  it.each([null, "c".repeat(64)])("rejects unavailable or foreign host %s", async (host) => {
    const f = fixture();
    f.hostIdentity.mockResolvedValue(host);
    await expect(startScopedLocalProcess(identity, options, f.port)).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it.each([new Date(0), new Date(Number.NaN)])(
    "rejects expired or invalid launch deadline %s",
    async (launchDeadline) => {
      const f = fixture();
      await expect(
        startScopedLocalProcess(identity, { ...options, launchDeadline }, f.port),
      ).rejects.toThrow("local scope launch deadline expired");
      expect(f.start).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
    },
  );

  it("rechecks the deadline after scope availability reads before spawning", async () => {
    const f = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const show = f.port.show;
    f.port.show = async (unit) => {
      clock.mockReturnValue(2_001);
      return show(unit);
    };
    try {
      await expect(
        startScopedLocalProcess(identity, { ...options, launchDeadline: new Date(2_000) }, f.port),
      ).rejects.toThrow("local scope launch deadline expired");
      expect(f.start).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("caps the command timeout at the remaining launch deadline", async () => {
    const f = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const child = await startScopedLocalProcess(
        identity,
        { ...options, launchDeadline: new Date(1_100) },
        f.port,
      );
      expect(f.start.mock.calls[0]![0].timeoutMs).toBe(100);
      await f.finish();
      expect(await child.completed).toBe(result);
    } finally {
      clock.mockRestore();
    }
  });

  it("wraps literal argv and forwards bounded process options without copying env into argv", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    expect(child.pid).toBe(123);
    const actual = f.start.mock.calls[0]![0];
    expect(actual).toMatchObject({ ...options, command: "systemd-run", args: expect.any(Array) });
    expect(actual.env).toBe(options.env);
    expect(actual.args?.slice(-5)).toEqual(["--", options.command, ...options.args!]);
    expect(actual.args).toContain("--expand-environment=no");
    expect(actual.args).toContain(`--unit=${f.unit}`);
    expect(actual.args?.join(" ")).not.toContain("environment-only");
    expect(actual.terminateDescendants).toEqual(expect.any(Function));
    await f.finish();
    expect(await child.completed).toBe(result);
  });

  it("stops exactly its owned scope before process completion and preserves nonzero exit", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    const failure = { ...result, exitCode: 7, stderr: "test failed" };
    await f.finish(failure);
    expect(await child.completed).toBe(failure);
    expect(f.stop.mock.calls).toEqual([[f.unit]]);
  });

  it("also cleans surviving descendants when a process port resolves before running its exit hook", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    let stopped = false;
    let postStopReads = 0;
    const show = f.port.show;
    f.port.show = async (unit) => {
      if (stopped && ++postStopReads === 2) f.setState("absent");
      return show(unit);
    };
    f.stop.mockImplementation(async () => {
      stopped = true;
    });
    f.resolve(result);
    expect(await child.completed).toBe(result);
    expect(f.stop.mock.calls).toEqual([[f.unit]]);
    expect(postStopReads).toBeGreaterThanOrEqual(3);
  });

  it("does not stop an already absent scope", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    f.setState("absent");
    await f.finish();
    expect(await child.completed).toBe(result);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("fails closed on unknown cleanup and retains the original bounded process result", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    f.setState("unknown");
    await f.finish();
    await expect(child.completed).rejects.toMatchObject({
      name: "LocalScopeCleanupError",
      scope: identity,
      result: {
        ...result,
        exitCode: 1,
        stdout: "",
        stderr: expect.stringContaining("cleanup unavailable"),
      },
    });
    await expect(child.completed).rejects.not.toThrow("private manager exception");
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("does not infer cleanup from a successful stop response", async () => {
    const f = fixture();
    f.stop.mockImplementation(async () => undefined);
    const child = await startScopedLocalProcess(identity, options, f.port);
    await f.finish();
    await expect(child.completed).rejects.toBeInstanceOf(LocalScopeCleanupError);
    expect(f.stop.mock.calls.every(([unit]) => unit === f.unit)).toBe(true);
  });

  it("drains a stopped scope until exact absence is independently observable", async () => {
    const f = fixture();
    f.setState("active");
    let stopped = false;
    let postStopReads = 0;
    const show = f.port.show;
    f.port.show = async (unit) => {
      if (stopped && ++postStopReads === 2) f.setState("absent");
      return show(unit);
    };
    f.stop.mockImplementation(async () => {
      stopped = true;
    });

    await expect(stopLocalScope(identity, f.port)).resolves.toBeUndefined();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.unit);
    expect(postStopReads).toBeGreaterThanOrEqual(3);
  });

  it("never converts an unknown post-stop observation into absence", async () => {
    const f = fixture();
    f.setState("active");
    f.stop.mockImplementation(async () => {
      f.setState("unknown");
    });

    await expect(stopLocalScope(identity, f.port)).rejects.toThrow(
      "owned local scope cleanup unverified",
    );
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.unit);
  });

  it("turns a failed exact-scope stop into unverified cleanup, not successful completion", async () => {
    const f = fixture();
    f.stop.mockRejectedValue(new Error("private stop exception"));
    const child = await startScopedLocalProcess(identity, options, f.port);
    await f.finish();
    await expect(child.completed).rejects.toBeInstanceOf(LocalScopeCleanupError);
    await expect(child.completed).rejects.not.toThrow("private stop exception");
  });

  it("preserves timeout evidence after exact scope cleanup", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    const timeout: ProcessResult = { ...result, exitCode: null, signal: "SIGTERM", timedOut: true };
    await f.finish(timeout);
    expect(await child.completed).toBe(timeout);
    expect(f.stop.mock.calls).toEqual([[f.unit]]);
  });

  it("forwards cancellation and waits for independently observed cleanup", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    await child.cancel("SIGKILL");
    expect(f.cancel).toHaveBeenCalledWith("SIGKILL");
    expect(f.stop.mock.calls).toEqual([[f.unit]]);
    expect(await child.completed).toMatchObject({ exitCode: null, signal: "SIGKILL" });
  });

  it("rejects cancellation completion when cleanup remains unknown", async () => {
    const f = fixture();
    const child = await startScopedLocalProcess(identity, options, f.port);
    f.setState("unknown");
    await expect(child.cancel()).rejects.toBeInstanceOf(LocalScopeCleanupError);
  });

  it("the convenience runner returns only after owned-resource cleanup", async () => {
    const f = fixture();
    const running = runScopedLocalProcess(identity, options, f.port);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    await f.finish();
    expect(await running).toBe(result);
    expect(f.stop.mock.calls).toEqual([[f.unit]]);
  });
});
