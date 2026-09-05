import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertNativePriorityReadback,
  assertRepositoryContention,
  assertSchedulingBarrier,
  changeSchedulingService,
  main,
  observeSchedulingService,
  ownedSchedulingScopes,
  schedulingAuthority,
  schedulingRequest,
  schedulingTransport,
  schedulingUnit,
  type ServiceIdentity,
} from "../scripts/verify-local-scheduling.mjs";
import { boundedPolicy, runQualificationCall } from "../scripts/verify-live-objective.mjs";

const boot = "component-test-boot";
const bootDigest = createHash("sha256").update(boot).digest("hex");
const binding = {
  repository: "example/disposable",
  namespace: "scheduling-fixture",
  inventory: "b".repeat(64),
  nonce: "00000000-0000-4000-8000-000000000001",
  role: "primary" as const,
};
const descriptor: ServiceIdentity = {
  unit: schedulingUnit(binding),
  node: "/usr/bin/node",
  bundle: "/home/example/.codex/plugins/cache/factory/dist/mcp-server.js",
  checkout: "/home/example/disposable",
};
const identity = {
  ...descriptor,
  pid: 321,
  startTicks: "10001",
  invocationId: "a".repeat(32),
  bootDigest,
};
const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${descriptor.unit}`;
const now = "2026-09-05T12:00:00.000Z";

function service() {
  let cpu = 0.5;
  let gone = false;
  const fields: Record<string, string> = {
    Id: descriptor.unit,
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    Job: "0 /",
    InvocationID: identity.invocationId,
    MainPID: "321",
    KillMode: "control-group",
    ControlGroup: group,
  };
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": boot,
    "/proc/321/stat": `321 (node) ${["S", ...Array(18).fill("0"), "10001", ...Array(8).fill("0")].join(" ")}`,
    "/proc/321/cmdline": `${descriptor.node}\0${descriptor.bundle}\0`,
    "/proc/321/cgroup": `0::${group}\n`,
  };
  const port = {
    exec: vi.fn((command: string, args: string[]) => {
      expect(command).toBe("systemctl");
      if (args[1] === "show")
        return Object.entries(
          gone
            ? {
                ...fields,
                LoadState: "not-found",
                ActiveState: "inactive",
                SubState: "dead",
                InvocationID: "",
                ControlGroup: "",
                MainPID: "0",
                Job: "",
              }
            : fields,
        )
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
      if (args[1] === "set-property") {
        cpu = 4;
        return "";
      }
      if (args[1] === "stop") {
        gone = true;
        return "";
      }
      throw Error("unexpected command");
    }),
    read: vi.fn((path: string) => {
      if (path === `/sys/fs/cgroup${group}/cpu.max`) return `${cpu * 100000} 100000`;
      if (Object.hasOwn(files, path)) return files[path]!;
      throw Error("unknown file");
    }),
    link: vi.fn(() => descriptor.checkout),
    now: () => now,
    wait: vi.fn(async () => {}),
  };
  return {
    port,
    fields,
    files,
    setCpu: (value: number) => {
      cpu = value;
    },
    setGone: () => {
      gone = true;
    },
  };
}

describe("explicit installed scheduling authority", () => {
  const env = {
    FACTORY_LIVE_LOCAL_SCHEDULING: "1",
    FACTORY_LIVE_OBJECTIVE: "1",
    FACTORY_LIVE_OBJECTIVE_REPOSITORY: binding.repository,
    FACTORY_LIVE_OBJECTIVE_NAMESPACE: binding.namespace,
    FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
    FACTORY_LIVE_LOCAL_SCHEDULING_ACK: `${binding.repository}:owned-cpu-priority-contention`,
  };
  it("has no effect without opt-in", async () => {
    const run = vi.fn();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({}, run);
      expect(run).not.toHaveBeenCalled();
      expect(schedulingAuthority({})).toBeNull();
    } finally {
      output.mockRestore();
    }
  });
  it("keeps the exact regular default policy and bounded original allowance", () => {
    expect(schedulingAuthority(env)?.policy).toEqual(boundedPolicy("regular-prs", 500000));
    expect(
      schedulingAuthority({
        ...env,
        FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
        FACTORY_LIVE_LOCAL_SCHEDULING_ACK: undefined,
      }),
    ).not.toBeNull();
  });
  it.each(["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"])(
    "rejects %s before preflight or any invocation, without logging its value",
    async (key) => {
      const run = vi.fn();
      const sentinel = "private-value-must-not-be-printed";
      await expect(
        main({ ...env, FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1", [key]: sentinel }, run),
      ).rejects.toThrow("scheduling qualifier requires default local GitHub authentication");
      expect(run).not.toHaveBeenCalled();
      expect(() => schedulingAuthority({ ...env, [key]: sentinel })).toThrow(
        /^scheduling qualifier requires default local GitHub authentication$/,
      );
    },
  );
  it("does not inspect auth overrides when its own opt-in is absent", () => {
    expect(schedulingAuthority({ GH_TOKEN: "untouched-parent-value" })).toBeNull();
  });
  it.each([
    { FACTORY_LIVE_LOCAL_SCHEDULING_ACK: "another/repo:owned-cpu-priority-contention" },
    { FACTORY_LIVE_OBJECTIVE: undefined },
    { FACTORY_LIVE_OBJECTIVE_REPOSITORY: "clockgrove/factory" },
    { FACTORY_LIVE_OBJECTIVE_DELIVERY: "stacked-prs" },
    { FACTORY_LIVE_REGULAR_BACKEND: "codex-cli" },
    { FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500001" },
  ])("rejects changed authority %j", (delta) =>
    expect(() => schedulingAuthority({ ...env, ...delta })).toThrow(),
  );
  it("separates exact artifact, namespace, nonce and contender identities", () => {
    const units = [
      schedulingUnit(binding),
      schedulingUnit({ ...binding, role: "contender" }),
      schedulingUnit({ ...binding, inventory: "c".repeat(64) }),
      schedulingUnit({ ...binding, namespace: "different-fixture" }),
      schedulingUnit({ ...binding, nonce: "00000000-0000-4000-8000-000000000002" }),
    ];
    expect(new Set(units).size).toBe(units.length);
    expect(
      units.every((unit) => /^clockgrove-factory-qualification-[a-f0-9]{64}\.service$/.test(unit)),
    ).toBe(true);
  });
  it("launches only the installed executable with cleared secrets and no systemd environment properties", () => {
    const config = schedulingTransport({
      ...descriptor,
      path: "/usr/bin:/home/example/.local/bin",
      home: "/home/example",
      uid: 1000,
      username: "example",
    });
    expect(config.command).toBe("systemd-run");
    expect(config.args).toContain("--property=CPUQuota=50%");
    expect(config.args).toContain("--expand-environment=no");
    expect(
      config.args.slice(
        config.args.indexOf("/usr/bin/env"),
        config.args.indexOf("/usr/bin/env") + 2,
      ),
    ).toEqual(["/usr/bin/env", "-i"]);
    expect(config.args.slice(-2)).toEqual([descriptor.node, descriptor.bundle]);
    expect(Object.keys(config.env).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
      "PATH",
      "XDG_RUNTIME_DIR",
    ]);
    expect(JSON.stringify(config)).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|Environment=/);
  });
  it.each([
    "relative/bin",
    "/usr/bin:/tmp/name with spaces",
    "/usr/bin:$HOME/bin",
    "/usr/bin::/bin",
  ])("rejects ambiguous/nonallowlisted PATH %s", (path) => {
    expect(() =>
      schedulingTransport({
        ...descriptor,
        path,
        home: "/home/example",
        uid: 1000,
        username: "example",
      }),
    ).toThrow();
  });
});

describe("exact owned Director cgroup control", () => {
  it("binds actual executable, cwd, process birth, invocation, boot and leaf quota", () => {
    const { port } = service();
    expect(observeSchedulingService(identity, port)).toMatchObject({
      ...identity,
      state: "active",
      effectiveCpu: 0.5,
      cgroup: group,
    });
    expect(port.read).toHaveBeenCalledWith(`/sys/fs/cgroup${group}/cpu.max`);
  });
  it.each([
    { InvocationID: "b".repeat(32) },
    { Id: "another.service" },
    { ControlGroup: "/another.slice/other.service" },
    { MainPID: "999" },
    { KillMode: "process" },
    { ActiveState: "deactivating" },
  ])("does not mutate a changed or uncertain service %j", async (delta) => {
    const { port, fields } = service();
    Object.assign(fields, delta);
    await expect(changeSchedulingService(identity, "release-cpu", port)).rejects.toThrow();
    expect(port.exec.mock.calls.every(([, args]) => args[1] === "show")).toBe(true);
  });
  it.each([
    "/proc/sys/kernel/random/boot_id",
    "/proc/321/stat",
    "/proc/321/cmdline",
    "/proc/321/cgroup",
  ])("rejects process identity drift at %s", async (path) => {
    const { port, files } = service();
    files[path] = "invalid";
    await expect(changeSchedulingService(identity, "stop", port)).rejects.toThrow();
    expect(port.exec.mock.calls).toHaveLength(1);
  });
  it("sets only the exact captured disposable quota once and independently reads it back", async () => {
    const { port } = service();
    await expect(changeSchedulingService(identity, "release-cpu", port)).resolves.toMatchObject({
      state: "active",
      effectiveCpu: 4,
      invocationId: identity.invocationId,
    });
    expect(port.exec.mock.calls.filter(([, args]) => args[1] !== "show")).toEqual([
      ["systemctl", ["--user", "set-property", "--runtime", identity.unit, "CPUQuota=400%"]],
    ]);
  });
  it("does not repeat a release or accept changed preexisting capacity", async () => {
    const { port, setCpu } = service();
    setCpu(4);
    await expect(changeSchedulingService(identity, "release-cpu", port)).rejects.toThrow(
      /initial CPU/,
    );
    expect(port.exec.mock.calls).toHaveLength(1);
  });
  it("requires captured birth authority before any stop", async () => {
    const { port } = service();
    await expect(changeSchedulingService(descriptor, "stop", port)).rejects.toThrow(/uncaptured/);
    expect(port.exec).not.toHaveBeenCalled();
  });
  it("stops one exact unit and requires independent collected absence", async () => {
    const { port } = service();
    await expect(changeSchedulingService(identity, "stop", port)).resolves.toMatchObject({
      unit: identity.unit,
      state: "absent",
      bootDigest,
    });
    expect(port.exec.mock.calls.filter(([, args]) => args[1] !== "show")).toEqual([
      ["systemctl", ["--user", "stop", identity.unit]],
    ]);
  });
  it("bounds an unchanged live cleanup without retrying the stop", async () => {
    const fixture = service();
    const exec = fixture.port.exec;
    const port = {
      ...fixture.port,
      exec: vi.fn((command: string, args: string[]) =>
        args[1] === "stop" ? "" : exec(command, args),
      ),
    };
    await expect(changeSchedulingService(identity, "stop", port)).rejects.toThrow(
      /cleanup is unverified/,
    );
    expect(port.exec.mock.calls.filter(([, args]) => args[1] === "stop")).toHaveLength(1);
    expect(port.wait).toHaveBeenCalledTimes(10);
  });
  it("does not promote a still-identified process to absence", () => {
    const { port, fields } = service();
    Object.assign(fields, {
      LoadState: "not-found",
      ActiveState: "inactive",
      SubState: "dead",
      InvocationID: "",
      ControlGroup: "",
      Job: "",
    });
    expect(() => observeSchedulingService(identity, port)).toThrow();
  });
});

function barrier() {
  const policy = boundedPolicy("regular-prs", 500000);
  const events = [
    {
      event: "FactoryRunStarted",
      runId: "run",
      objective: 1,
      policy,
      policyDigest: "c".repeat(64),
      sequence: 1,
    },
    { event: "GraphProjected", runId: "run", graphSize: 3, sequence: 2 },
    ...[2, 3].map((workItem, index) => ({
      event: "WorkItemQueued",
      kind: "scheduling",
      runId: "run",
      workItem,
      reasonCode: "local-capacity",
      sequence: 3 + index,
    })),
  ];
  return {
    policy,
    objective: 1,
    receipts: events.map((event, index) => ({ event, commentId: 100 + index, actorId: 7 })),
    unit: { ...identity, state: "active", effectiveCpu: 0.5 },
    status: {
      operation: "status",
      objective: { number: 1 },
      run: { availability: "observed", runId: "run" },
      summary: { attempts: { active: 0 } },
      capacity: { activeReservations: [] },
      workItems: [
        { number: 2, openDependencies: [] },
        { number: 3, openDependencies: [] },
        { number: 4, openDependencies: [2, 3] },
      ],
    },
  };
}

describe("read-only admission and native-order evidence", () => {
  it("waits on actual authenticated two-root admission blocks", () =>
    expect(assertSchedulingBarrier(barrier())).toMatchObject({ runId: "run", roots: [2, 3] }));
  it("allows partial queue visibility only as an unfinished barrier", () => {
    const input = barrier();
    input.receipts.pop();
    expect(assertSchedulingBarrier(input, false)).toBeNull();
    expect(() => assertSchedulingBarrier(input)).toThrow();
  });
  it.each(["AttemptReserved", "AttemptStarted", "FactoryRunCancelled", "FactoryRunEscalated"])(
    "rejects pre-barrier %s even before both queues appear",
    (event) => {
      const input = barrier();
      input.receipts.pop();
      input.receipts.push({
        event: { event, runId: "run", sequence: 5 } as (typeof input.receipts)[number]["event"],
        commentId: 105,
        actorId: 7,
      });
      expect(() => assertSchedulingBarrier(input, false)).toThrow();
    },
  );
  it("rejects a changed policy or another status run", () => {
    const input = barrier();
    expect(() =>
      assertSchedulingBarrier({ ...input, policy: boundedPolicy("regular-prs", 250000) }),
    ).toThrow();
    input.status.run.runId = "another";
    expect(() => assertSchedulingBarrier(input)).toThrow();
  });
  const before = [2, 3, 4].map((number) => ({ number, id: 1000 + number, nodeId: `I_${number}` }));
  it("uses numeric database IDs and exact child identity for one root reorder", () =>
    expect(() =>
      assertNativePriorityReadback(before, [before[1], before[0], before[2]], [2, 3], 3),
    ).not.toThrow());
  it.each(
    [
      before,
      [before[1], before[1], before[2]],
      [{ ...before[1], id: 9999 }, before[0], before[2]],
      [{ ...before[1], nodeId: "I_hostile" }, before[0], before[2]],
    ].map((after) => ({ after })),
  )("rejects unchanged/replaced priority observations", ({ after }) =>
    expect(() => assertNativePriorityReadback(before, after, [2, 3], 3)).toThrow(),
  );
  it("does not turn the blocked join into an eligible reordered root", () =>
    expect(() =>
      assertNativePriorityReadback(before, [before[2], before[0], before[1]], [2, 3], 4),
    ).toThrow());
  function scopeEvidence() {
    const scope = {
      protocol: "clockgrove.factory/local-scope-v1",
      repository: binding.repository,
      objective: 1,
      workItem: 2,
      attempt: 1,
      runId: "run",
      directorEpoch: 1,
      policyDigest: "c".repeat(64),
      phase: "execution",
      commandIndex: 0,
      invocationDigest: "d".repeat(64),
      hostIdentity: "e".repeat(64),
      producerUnit: identity.unit,
      producerInvocationId: identity.invocationId,
    };
    const batch = {
      identity: scope,
      commandCount: 1,
      producerPid: 321,
      producerStartTicks: "10001",
      deadline: now,
    };
    const common = {
      runId: "run",
      workItem: 2,
      attempt: 1,
      directorEpoch: 1,
      policyDigest: scope.policyDigest,
    };
    return {
      repository: binding.repository,
      objective: { number: 1 },
      runResult: { runId: "run" },
      events: [
        { ...common, event: "AttemptReserved", sequence: 1, localScopeBatch: batch },
        { ...common, event: "AttemptStarted", sequence: 2, localScopeBatch: batch },
        { ...common, event: "AttemptCollected", sequence: 3, artifactDigest: "f".repeat(64) },
        {
          ...common,
          event: "CapacityReserved",
          phase: "validation",
          sequence: 4,
          localScopeBatch: {
            ...batch,
            commandCount: 2,
            identity: { ...scope, phase: "validation", invocationDigest: "f".repeat(64) },
          },
        },
        { ...common, event: "ValidationRecorded", sequence: 5 },
      ],
    };
  }
  it("preserves exact original producer/resource identities instead of scanning unrelated processes", () => {
    const evidence = scopeEvidence();
    expect(ownedSchedulingScopes(evidence, identity)).toHaveLength(3);
    expect(() =>
      ownedSchedulingScopes(evidence, { ...identity, startTicks: "different" }),
    ).toThrow();
    expect(() =>
      ownedSchedulingScopes({ ...evidence, repository: "example/other" }, identity),
    ).toThrow();
  });
  it.each([
    [14, 16, 17],
    [31, 32, 33],
    [49, 50, 51],
  ])(
    "accepts actual SDK ordering capacity %i -> collection %i -> validation %i",
    (capacitySequence, collectedSequence, validationSequence) => {
      const evidence = scopeEvidence();
      evidence.events.find((event) => event.event === "CapacityReserved")!.sequence =
        capacitySequence;
      evidence.events.find((event) => event.event === "AttemptCollected")!.sequence =
        collectedSequence;
      evidence.events.find((event) => event.event === "ValidationRecorded")!.sequence =
        validationSequence;
      expect(ownedSchedulingScopes(evidence, identity)).toHaveLength(3);
    },
  );
  it("does not accept collection after validation as earlier invocation evidence", () => {
    const evidence = scopeEvidence();
    evidence.events.find((event) => event.event === "AttemptCollected")!.sequence = 6;
    expect(() => ownedSchedulingScopes(evidence, identity)).toThrow(/missing or ambiguous/);
  });
  it("rejects conflicting earlier artifact receipts instead of choosing the latest convenient digest", () => {
    const evidence = scopeEvidence();
    const collected = evidence.events.find((event) => event.event === "AttemptCollected")!;
    if (!("artifactDigest" in collected)) throw Error("fixture lacks artifact digest");
    evidence.events.push({ ...collected, sequence: 2, artifactDigest: "e".repeat(64) });
    expect(() => ownedSchedulingScopes(evidence, identity)).toThrow(/ambiguous/);
  });
  it.each(["AttemptReserved", "CapacityReserved"])(
    "requires physical ownership on every %s, not just remaining scopes",
    (event) => {
      const evidence = scopeEvidence();
      evidence.events = evidence.events.map((entry) =>
        entry.event === event ? { ...entry, localScopeBatch: undefined } : entry,
      );
      expect(() => ownedSchedulingScopes(evidence, identity)).toThrow(
        /lacks its owned scope batch/,
      );
    },
  );
  it("rejects an entirely missing validation reservation despite retained execution scopes", () => {
    const evidence = scopeEvidence();
    evidence.events = evidence.events.filter((entry) => entry.event !== "CapacityReserved");
    expect(() => ownedSchedulingScopes(evidence, identity)).toThrow(/preceding owned capacity/);
  });
  it.each([
    { phase: "execution" },
    { workItem: 3 },
    { attempt: 2 },
    { policyDigest: "f".repeat(64) },
    { invocationDigest: "d".repeat(64) },
  ])("rejects transplanted validation scope identity %j", (delta) => {
    const evidence = scopeEvidence();
    const capacity = evidence.events.find((entry) => entry.event === "CapacityReserved")!;
    if (!("localScopeBatch" in capacity)) throw Error("fixture lacks capacity batch");
    Object.assign(capacity.localScopeBatch!.identity, delta);
    expect(() => ownedSchedulingScopes(evidence, identity)).toThrow();
  });
});

describe("bounded GitHub observations without mutation retries", () => {
  it("attaches the supported fetch AbortSignal, including to one priority PATCH", async () => {
    const request = vi.fn(
      async (_route: string, parameters: Record<string, unknown>) => parameters,
    );
    const result = await schedulingRequest({ request }, "PATCH fixture", { sub_issue_id: 3 });
    expect(result.sub_issue_id).toBe(3);
    expect((result.request as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("never starts another request after original observer authority is revoked", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    await expect(
      schedulingRequest({ request }, "PATCH fixture", {}, controller.signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("aborts a hung transport once at the finite boundary without resubmitting uncertain writes", async () => {
    const keepAlive = setTimeout(() => {}, 1000);
    const request = vi.fn(
      (_route: string, parameters: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = (parameters.request as { signal: AbortSignal }).signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    try {
      await expect(
        schedulingRequest({ request }, "PATCH fixture", {}, undefined, 10),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(keepAlive);
    }
  });
  it("combines the original-call abort with the per-request bound", async () => {
    const controller = new AbortController();
    const request = vi.fn(
      async (_route: string, parameters: Record<string, unknown>) =>
        parameters.request as { signal: AbortSignal },
    );
    const result = await schedulingRequest({ request }, "GET fixture", {}, controller.signal);
    controller.abort();
    expect(result.signal.aborted).toBe(true);
  });
});

describe("one-shot foreground/observer coordination", () => {
  const contention = () => {
    const record = {
      protocol: "clockgrove.factory/v2",
      kind: "repository-lease",
      event: "RepositoryLeaseAcquired",
      controllerId: "holder",
      epoch: 3,
      policyDigest: "a".repeat(64),
      sequence: 1,
    };
    return {
      response: {
        isError: true,
        content: [{ type: "text", text: "another repository controller holds the lease" }],
      },
      before: { oid: "a".repeat(40), record },
      after: {
        oid: "b".repeat(40),
        record: { ...record, event: "RepositoryLeaseRenewed", sequence: 2 },
      },
      controller: {
        event: "ControllerObserved",
        controllerId: "holder",
        epoch: 3,
        controllerPolicyDigest: "a".repeat(64),
      },
    };
  };
  it("binds an exact refusal to the same observed repository lease incarnation", () =>
    expect(() => assertRepositoryContention(contention())).not.toThrow());
  it.each([
    {
      isError: false,
      content: [{ type: "text", text: "another repository controller holds the lease" }],
    },
    {
      isError: true,
      content: [
        { type: "text", text: "timeout; another repository controller holds the lease possibly" },
      ],
    },
    { isError: true, content: [{ type: "text", text: "request timed out" }] },
  ])("never treats arbitrary errors or uncertain responses as safe contention", (response) =>
    expect(() => assertRepositoryContention({ ...contention(), response })).toThrow(),
  );
  it.each([
    { controllerId: "other" },
    { epoch: 4 },
    { policyDigest: "b".repeat(64) },
    { event: "RepositoryLeaseReleased" },
    { sequence: 0 },
  ])("rejects lease identity drift %j", (delta) => {
    const input = contention();
    Object.assign(input.after.record, delta);
    expect(() => assertRepositoryContention(input)).toThrow();
  });
  it("leaves the existing default call unchanged", async () => {
    const invoke = vi.fn(async () => 42);
    expect(await runQualificationCall({ invoke, hooks: {} })).toBe(42);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("provides the exact pending call and aborts observer authority when both finish", async () => {
    let finish!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const invoke = vi.fn(() => pending);
    let signal!: AbortSignal;
    const result = await runQualificationCall({
      invoke,
      hooks: { marker: "fixed" },
      duringRun: async (hooks) => {
        expect(hooks.run).toBe(pending);
        expect(hooks.marker).toBe("fixed");
        signal = hooks.signal;
        expect(signal.aborted).toBe(false);
        finish(42);
      },
    });
    expect(result).toBe(42);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });
  it("never retries or invents a result when intervention fails and the original outcome is unknown", async () => {
    let signal!: AbortSignal;
    const invoke = vi.fn(() => new Promise<number>(() => {}));
    await expect(
      runQualificationCall({
        invoke,
        hooks: {},
        duringRun: async (hooks) => {
          signal = hooks.signal;
          throw Error("intervention unavailable");
        },
      }),
    ).rejects.toThrow(/intervention unavailable/);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });
  it("revokes a delayed observer when the original call fails, without a second call", async () => {
    let signal!: AbortSignal;
    const invoke = vi.fn(async () => {
      throw Error("unknown original outcome");
    });
    await expect(
      runQualificationCall({
        invoke,
        hooks: {},
        duringRun: async (hooks) => {
          signal = hooks.signal;
          await new Promise(() => {});
        },
      }),
    ).rejects.toThrow(/unknown original outcome/);
    expect(signal.aborted).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
