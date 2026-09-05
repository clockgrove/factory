import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { boundedPolicy } from "../scripts/verify-live-objective.mjs";
import {
  assertControllerUnit,
  checkpointAuthority,
  checkpointFacts,
  checkpointLease,
  assertScopeCoverage,
  main,
  runCheckpointScenario,
  type CheckpointPort,
} from "../scripts/verify-local-checkpoint-restart.mjs";

const repository = "example/disposable";
const checkout = "/home/example/disposable";
const unit = `clockgrove-factory-${createHash("sha256").update(`${repository}\0${checkout}`).digest("hex").slice(0, 16)}.service`;
const env = {
  FACTORY_LOCAL_CHECKPOINT_RESTART: "1",
  FACTORY_CHECKPOINT_REPOSITORY: repository,
  FACTORY_CHECKPOINT_CHECKOUT: checkout,
  FACTORY_CHECKPOINT_CONTROLLER_UNIT: unit,
  FACTORY_CHECKPOINT_PHASE: "exercise",
  FACTORY_CHECKPOINT_NAMESPACE: "checkpoint-fixture",
  FACTORY_CHECKPOINT_EVIDENCE: "/tmp/private/checkpoint.json",
  FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,pause-drain,restart,resume,stop`,
};
const authority = checkpointAuthority(env)!;
const pause = `${authority.namespace}-pause`;
const digest = "a".repeat(64);
const sha = "b".repeat(40);
const original = {
  unit,
  pid: 100,
  startTicks: "1000",
  invocationId: "a".repeat(32),
  hostIdentity: digest,
};
const replacement = { ...original, pid: 101, startTicks: "2000", invocationId: "b".repeat(32) };

function observation(count = 1, completed = false) {
  const events: Record<string, unknown>[] = [
    {
      kind: "run",
      event: "ActivationRequested",
      requestId: `${authority.namespace}-activate`,
      policy: authority.policy,
      policyDigest: digest,
      requestedBy: "operator",
      repository,
      baseSha: sha,
      runId: "activation",
    },
    {
      kind: "run",
      event: "FactoryRunStarted",
      runId: "original",
      objective: 1,
      actor: "operator",
      repository,
      activationRequestId: `${authority.namespace}-activate`,
      policy: authority.policy,
      policyDigest: digest,
    },
    { kind: "graph", event: "GraphCompiled", baseSha: sha },
    { kind: "graph", event: "GraphProjected", graphSize: 3 },
    {
      kind: "budget",
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      usageId: `compile-${digest}`,
      amount: 100,
    },
  ];
  for (let i = 0; i < count; i++) {
    const item = { workItem: 2 + i, attempt: 1 };
    events.push(
      { ...item, kind: "attempt", event: "AttemptReserved", backend: "codex-sdk/local-worktree" },
      { ...item, kind: "attempt", event: "AttemptStarted" },
      { ...item, kind: "publication", event: "PublicationRecorded" },
      {
        ...item,
        kind: "budget",
        event: "BudgetReconciled",
        unit: "local_milliseconds",
        phase: "execution",
        amount: 1000,
      },
      {
        ...item,
        kind: "budget",
        event: "BudgetReconciled",
        unit: "validation_milliseconds",
        phase: "validation",
        amount: 100,
      },
      { ...item, kind: "attempt", event: "AttemptSucceeded", reportedModelTokens: 100 },
      { ...item, kind: "attempt", event: "AttemptValidated" },
      { ...item, kind: "validation", event: "ValidationRecorded", passed: true },
      {
        ...item,
        kind: "budget",
        event: "BudgetReconciled",
        unit: "model_tokens",
        phase: "execution",
        usageId: `worker-${2 + i}-1`,
        amount: 100,
      },
      {
        ...item,
        kind: "budget",
        event: "BudgetReconciled",
        unit: "model_tokens",
        phase: "management",
        usageId: `review-${digest}`,
        amount: 100,
      },
      { ...item, kind: "attempt", event: "AttemptIntegrated", headSha: sha },
    );
    if (i === 0)
      events.push(
        { kind: "run", event: "RunPauseRequested", requestId: pause },
        { kind: "run", event: "RunPauseAcknowledged", commandRequestId: pause },
      );
  }
  if (completed) events.push({ kind: "run", event: "FactoryRunCompleted" });
  const receipts: Array<{ event: Record<string, unknown> }> = events.map((event, i) => ({
    event: { runId: "original", sequence: i + 1, ...event },
  }));
  return {
    receipts,
    status: {
      objective: { number: 1, closed: completed },
      run: { runId: "original", state: completed ? "completed" : "paused", policyDigest: digest },
      capacity: { activeReservations: [] as unknown[] },
      summary: {
        runId: "original",
        economics: {
          nativeUnits: [{ unit: "local_milliseconds", outstanding: 0 }],
          usage: { model_tokens: { availability: "observed", value: 100 + count * 200 } },
          modelTokenBreakdown: { reconciledCalls: 1 + count * 2 },
        },
      },
    },
  };
}

describe("explicit checkpoint restart authority", () => {
  it("is import/no-opt-in inert", async () => {
    const runner = vi.fn();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({}, runner);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
    expect(checkpointAuthority({ GH_TOKEN: "untouched" })).toBeNull();
  });
  it("pins existing lifecycle identity and the original local allowance", () => {
    expect(authority.policy).toEqual(boundedPolicy("regular-prs", 500000));
    expect(
      checkpointAuthority({
        ...env,
        FACTORY_CHECKPOINT_PHASE: "preflight",
        FACTORY_CHECKPOINT_ACK: undefined,
      })?.phase,
    ).toBe("preflight");
  });
  it.each([
    { FACTORY_CHECKPOINT_ACK: "start-only" },
    { FACTORY_CHECKPOINT_CONTROLLER_UNIT: "unrelated.service" },
    { FACTORY_CHECKPOINT_CHECKOUT: "/mnt/c/fixture" },
    { FACTORY_CHECKPOINT_PHASE: "retry" },
    { GH_TOKEN: "private" },
    { GITHUB_TOKEN: "private" },
    { GH_HOST: "elsewhere" },
    { GH_CONFIG_DIR: "/tmp/other" },
    { XDG_CONFIG_HOME: "/tmp/other" },
  ])("rejects changed authority before invocation %j", (delta) =>
    expect(() => checkpointAuthority({ ...env, ...delta })).toThrow(),
  );
});

describe("fully accounted checkpoint", () => {
  it("rejects usage reconstructed for another run", () => {
    const value = observation();
    value.status.summary.runId = "other";
    expect(() => checkpointFacts(value, authority, pause)).toThrow();
  });
  it.each(["local_milliseconds", "validation_milliseconds"])("requires exact %s usage", (unit) => {
    const value = observation();
    value.receipts = value.receipts.filter(({ event }) => event.unit !== unit);
    expect(() => checkpointFacts(value, authority, pause)).toThrow(/native execution\/validation/);
  });
  it("rejects even reconciled orphan validator reservations", () => {
    const value = observation();
    value.receipts.push(
      {
        event: {
          event: "CapacityReserved",
          phase: "validation",
          workItem: 99,
          attempt: 1,
          runId: "original",
          sequence: 99,
        },
      },
      {
        event: {
          event: "CapacityReconciled",
          phase: "validation",
          workItem: 99,
          attempt: 1,
          runId: "original",
          sequence: 100,
        },
      },
    );
    expect(() => checkpointFacts(value, authority, pause)).toThrow(/execution partition/);
  });
  it("rejects orphan scoped receipts independently of their phase", () => {
    expect(() =>
      assertScopeCoverage([
        { event: "AttemptReserved", workItem: 1, attempt: 1 },
        { event: "ArtifactCollected", workItem: 2, attempt: 1, localScopeBatch: {} },
      ]),
    ).toThrow(/execution partition/);
  });
  it("accepts a completed admitted pipeline without changing its original run", () => {
    expect(checkpointFacts(observation(), authority, pause)).toMatchObject({
      runId: "original",
      modelTokens: 300,
      integrated: 1,
    });
  });
  it.each(["execution", "management"])("rejects missing %s model usage", (phase) => {
    const value = observation();
    value.receipts = value.receipts.filter(
      ({ event }) =>
        !(
          event.kind === "budget" &&
          event.workItem &&
          event.phase === phase &&
          event.unit === "model_tokens"
        ),
    );
    expect(() => checkpointFacts(value, authority, pause)).toThrow(/usage missing/);
  });
  it("distinguishes known zero usage from absent terminal counters", () => {
    const value = observation();
    value.receipts.find(
      ({ event }) => event.event === "AttemptSucceeded",
    )!.event.reportedModelTokens = 0;
    value.receipts.find(
      ({ event }) =>
        event.kind === "budget" && event.phase === "execution" && event.unit === "model_tokens",
    )!.event.amount = 0;
    value.status.summary.economics.usage.model_tokens.value -= 100;
    expect(checkpointFacts(value, authority, pause).modelTokens).toBe(200);
    delete value.receipts.find(({ event }) => event.event === "AttemptSucceeded")!.event
      .reportedModelTokens;
    expect(() => checkpointFacts(value, authority, pause)).toThrow(/counter unavailable/);
  });
  it.each(["AttemptSucceeded", "AttemptValidated", "ValidationRecorded", "GraphCompiled"])(
    "rejects duplicated %s work",
    (name) => {
      const value = observation();
      value.receipts.push(
        structuredClone(value.receipts.find(({ event }) => event.event === name)!),
      );
      expect(() => checkpointFacts(value, authority, pause)).toThrow();
    },
  );
  it("rejects unacknowledged pause, active resources and exhausted allowance", () => {
    const value = observation();
    value.receipts = value.receipts.filter(({ event }) => event.event !== "RunPauseAcknowledged");
    expect(() => checkpointFacts(value, authority, pause)).toThrow(/acknowledgement/);
    const active = observation();
    active.status.capacity.activeReservations.push({ workItem: 2 });
    expect(() => checkpointFacts(active, authority, pause)).toThrow();
    const spent = observation();
    spent.receipts.find(({ event }) => !event.workItem && event.kind === "budget")!.event.amount =
      499800;
    spent.status.summary.economics.usage.model_tokens.value = 500000;
    expect(() => checkpointFacts(spent, authority, pause)).toThrow(/allowance exhausted/);
  });
  it("never revives a terminal run or changes its activation", () => {
    expect(() => checkpointFacts(observation(3, true), authority, pause)).toThrow();
    const value = observation();
    value.receipts[0]!.event.requestId = "another-activation";
    expect(() => checkpointFacts(value, authority, pause)).toThrow();
  });
});

function scenario() {
  let starts = 0;
  const actions: string[] = [];
  const checkpoint = observation();
  const final = observation(3, true);
  const port: CheckpointPort = {
    pauseRequestId: pause,
    preflight: vi.fn(async () => ({ state: "inactive" })),
    action: vi.fn(async (name) => {
      actions.push(name);
    }),
    controller: vi.fn(
      async (state, expected) =>
        expected ?? (state === "inactive" ? { state } : starts++ === 0 ? original : replacement),
    ),
    observe: vi.fn(async () => checkpoint),
    poll: vi.fn(async (phase, accept) => {
      const value = phase === "completed" ? final : checkpoint;
      expect(accept(value)).toBe(true);
      return value;
    }),
    absence: vi.fn(async () => [{ status: "absent" }]),
    checkpoint: vi.fn(async () => {}),
    takeover: vi.fn(async () => {}),
    finalProof: vi.fn(async () => {}),
  };
  return { port, actions, checkpoint, final };
}

describe("one-shot checkpoint lifecycle", () => {
  it("rechecks the replacement incarnation after awaited takeover and absence before resume", async () => {
    const f = scenario();
    vi.mocked(f.port.controller).mockImplementation(async (state, expected) => {
      if (expected === replacement && !f.actions.includes("resume"))
        throw Error("incarnation changed");
      return (
        expected ??
        (state === "inactive" ? { state } : f.actions.includes("restart") ? replacement : original)
      );
    });
    await expect(runCheckpointScenario(f.port, authority)).rejects.toThrow(/incarnation changed/);
    expect(f.actions).not.toContain("resume");
  });
  it("only preflights without explicit exercise", async () => {
    const f = scenario();
    expect(await runCheckpointScenario(f.port, { ...authority, phase: "preflight" })).toMatchObject(
      { result: "preflight-only" },
    );
    expect(f.actions).toEqual([]);
  });
  it("restarts only after drained accounting and absence, resumes original work once, stops after final proof", async () => {
    const f = scenario();
    expect(await runCheckpointScenario(f.port, authority)).toMatchObject({
      result: "passed",
      final: { integrated: 3 },
    });
    expect(f.actions).toEqual([
      "start",
      "create",
      "activate",
      "pause",
      "restart",
      "resume",
      "stop",
    ]);
    expect(f.port.absence).toHaveBeenCalledTimes(3);
    expect(f.port.takeover).toHaveBeenCalledTimes(1);
  });
  it.each(["checkpoint", "absence", "takeover", "finalProof"] as const)(
    "does not infer authority after %s is unavailable",
    async (method) => {
      const f = scenario();
      vi.mocked(f.port[method]).mockRejectedValue(Error("unknown"));
      await expect(runCheckpointScenario(f.port, authority)).rejects.toThrow(/unknown/);
      expect(f.actions).not.toContain("stop");
      if (["checkpoint", "absence"].includes(method)) expect(f.actions).not.toContain("restart");
      if (method === "takeover") expect(f.actions).not.toContain("resume");
    },
  );
  it("does not repeat an unknown restart or proceed to resume", async () => {
    const f = scenario();
    f.port.action = vi.fn(async (name) => {
      f.actions.push(name);
      if (name === "restart") throw Error("unknown restart");
    });
    await expect(runCheckpointScenario(f.port, authority)).rejects.toThrow(/unknown restart/);
    expect(f.actions.filter((name) => name === "restart")).toHaveLength(1);
    expect(f.actions).not.toContain("resume");
  });
  it("blocks resume if restart repeated an accounted call", async () => {
    const f = scenario();
    const drift = structuredClone(f.checkpoint);
    drift.receipts.push(
      structuredClone(drift.receipts.find(({ event }) => event.event === "AttemptValidated")!),
    );
    vi.mocked(f.port.observe).mockResolvedValue(drift);
    await expect(runCheckpointScenario(f.port, authority)).rejects.toThrow();
    expect(f.actions).not.toContain("resume");
  });
  it("does not stop an unchanged controller incarnation", async () => {
    const f = scenario();
    vi.mocked(f.port.controller).mockResolvedValue(original);
    await expect(runCheckpointScenario(f.port, authority)).rejects.toThrow(/did not restart/);
    expect(f.actions).not.toContain("resume");
  });
});

describe("strict repository takeover receipt", () => {
  const oid = "a".repeat(40);
  const record = {
    protocol: "clockgrove.factory/v2",
    kind: "repository-lease",
    policyDigest: "b".repeat(64),
    controllerId: "controller",
    sequence: 2,
    epoch: 2,
    event: "RepositoryLeaseAcquired",
    expiresAt: "2026-09-05T12:00:00.000Z",
  };
  const commit = (value: unknown) => ({
    sha: oid,
    message: `Factory-Repository-Lease: ${Buffer.from(JSON.stringify(value)).toString("base64url")}`,
  });
  it("accepts a strictly typed immutable receipt", () =>
    expect(checkpointLease(commit(record), oid)).toEqual(record));
  it.each([
    { epoch: "3" },
    { epoch: 0 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: "2" },
    { controllerId: "" },
    { controllerId: "x".repeat(161) },
    { policyDigest: "bad" },
    { expiresAt: "bad" },
    { event: "Unknown" },
  ])("rejects malformed authority before resume", (delta) => {
    expect(() => checkpointLease(commit({ ...record, ...delta }), oid)).toThrow();
  });
  it("rejects malformed or mismatching immutable commit identities", () => {
    expect(() => checkpointLease(commit(record), "bad")).toThrow();
    expect(() => checkpointLease({ ...commit(record), sha: "c".repeat(40) }, oid)).toThrow();
  });
});

describe("preinstalled configuration identity", () => {
  const expected = {
    repository,
    checkout,
    node: "/usr/bin/node",
    bundle: "/home/example/.codex/plugins/cache/personal/factory/2.0.26/dist/factory.js",
  };
  const body = `# Managed by Clockgrove Factory v2\n[Unit]\nDescription=Clockgrove Factory repository controller for ${repository}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${checkout}\nEnvironment="PATH=/usr/bin:/bin"\nExecStart="${expected.node}" "${expected.bundle}" controller run "${repository}" --repo "${checkout}"\nRestart=on-failure\nRestartPreventExitStatus=2 130\nRestartSec=30\nTimeoutStopSec=90\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
  it("accepts only the exact generated nonsecret unit", () =>
    expect(assertControllerUnit(body, expected)).toMatch(/^[a-f0-9]{64}$/));
  it.each([
    body.replace("KillMode=control-group", "KillMode=process"),
    body.replace("controller run", "run"),
    body.replace(expected.bundle, "/tmp/other.js"),
    body.replace("[Service]", "[Service]\nExecStartPre=/tmp/other"),
    body.replace('Environment="PATH=/usr/bin:/bin"', 'Environment="GITHUB_TOKEN=private"'),
    body.replace(
      'Environment="PATH=/usr/bin:/bin"',
      'Environment="PATH=/usr/bin:/bin"\nEnvironment="PATH=/tmp"',
    ),
  ])("rejects changed executable, mutation hooks or secrets", (changed) =>
    expect(() => assertControllerUnit(changed, expected)).toThrow(),
  );
});
