import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import {
  largeFileAuthority,
  largeFileTransferArm,
  transferArmPath,
  transferHoldReady,
  runLargeFileScenario,
  largeFileExtension,
  main,
} from "../scripts/verify-local-large-files.mjs";
import { createLargeFileFixture } from "../scripts/qualification-large-files.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const repository = "example/disposable",
  checkout = "/home/example/disposable";
const unit = `clockgrove-factory-${hash(`${repository}\0${checkout}`).slice(0, 16)}.service`;
const env = {
  FACTORY_LOCAL_LARGE_FILES: "1",
  FACTORY_LARGE_FILE_CASE: "transfer-restart",
  FACTORY_LARGE_FILE_PHASE: "exercise",
  FACTORY_LARGE_FILE_REPOSITORY: repository,
  FACTORY_LARGE_FILE_CHECKOUT: checkout,
  FACTORY_LARGE_FILE_CONTROLLER_UNIT: unit,
  FACTORY_LARGE_FILE_NAMESPACE: "large-file-case",
  FACTORY_LARGE_FILE_MAX_MODEL_TOKENS: "250000",
  FACTORY_LARGE_FILE_EVIDENCE: "/tmp/private/result.json",
  FACTORY_LARGE_FILE_FIXTURE: "/tmp/private/fixture.json",
  FACTORY_LARGE_FILE_FIXTURE_SHA256: "a".repeat(64),
  FACTORY_LARGE_FILE_ACK: `${repository}:${unit}:transfer-restart:start,create,arm-transfer-intent,activate,pause,restart,resume,stop`,
};
const authority = largeFileAuthority(env)!;
const original = {
  unit,
  pid: 123,
  startTicks: "456",
  invocationId: "a".repeat(32),
  hostIdentity: "b".repeat(64),
};
const replacement = { ...original, pid: 124, startTicks: "457", invocationId: "c".repeat(32) };
const baseSha = "d".repeat(40),
  policyDigest = "e".repeat(64);
function scenario() {
  const common = {
    repository,
    objective: 7,
    runId: "original",
    directorEpoch: 1,
    policyDigest,
    baseSha,
  };
  const events: Record<string, unknown>[] = [];
  const add = (event: string, kind: string, values: Record<string, unknown> = {}) =>
    events.push({ ...common, sequence: events.length + 1, event, kind, ...values });
  add("ActivationRequested", "run", {
    runId: "activation",
    requestId: `${authority.namespace}-activate`,
    requestedBy: "operator",
    policy: authority.policy,
  });
  add("FactoryRunStarted", "run", {
    activationRequestId: `${authority.namespace}-activate`,
    actor: "operator",
    policy: authority.policy,
  });
  add("GraphCompiled", "graph");
  add("GraphProjected", "graph", { graphSize: 3 });
  add("BudgetReconciled", "budget", {
    phase: "management",
    unit: "model_tokens",
    usageId: `compile-${policyDigest}`,
    amount: 100,
  });
  const reserve = (workItem: number) => {
    add("AttemptReserved", "attempt", {
      workItem,
      attempt: 1,
      backend: "codex-app-server/local-worktree",
    });
    add("AttemptStarted", "attempt", { workItem, attempt: 1 });
    add("BudgetReconciled", "budget", {
      workItem,
      attempt: 1,
      phase: "execution",
      unit: "model_tokens",
      usageId: `worker-${workItem}-1`,
      amount: 100,
    });
  };
  const settle = (workItem: number) => {
    const item = { workItem, attempt: 1 };
    add("BudgetReconciled", "budget", {
      ...item,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 1000,
    });
    add("BudgetReconciled", "budget", {
      ...item,
      phase: "validation",
      unit: "validation_milliseconds",
      amount: 100,
    });
    add("AttemptSucceeded", "attempt", { ...item, reportedModelTokens: 100 });
    add("AttemptValidated", "attempt", item);
    add("ValidationRecorded", "validation", { ...item, passed: true });
    add("BudgetReconciled", "budget", {
      ...item,
      phase: "management",
      unit: "model_tokens",
      usageId: `review-${policyDigest}`,
      amount: 100,
    });
    add("PublicationRecorded", "publication", item);
    add("AttemptIntegrated", "attempt", { ...item, headSha: baseSha });
  };
  const observe = (count: number, completed = false) => ({
    receipts: structuredClone(events).map((event) => ({ event })),
    status: {
      objective: { number: 7, closed: completed },
      run: { runId: "original", policyDigest, state: completed ? "completed" : "paused" },
      capacity: { activeReservations: [] },
      summary: {
        runId: "original",
        economics: {
          nativeUnits: [{ unit: "local_milliseconds", outstanding: 0 }],
          usage: { model_tokens: { availability: "observed", value: 100 + count * 200 } },
          modelTokenBreakdown: { reconciledCalls: 1 + count * 2 },
        },
      },
    },
  });
  reserve(8);
  add("RunPauseRequested", "run", { requestId: `${authority.namespace}-pause` });
  const held = {
    ...observe(0),
    transferCheckpoint: {
      ...common,
      protocol: "clockgrove.factory/artifact-transfer-checkpoint-reached-v1",
      armDigest: "f".repeat(64),
      workItem: 8,
      attempt: 1,
      payloadBytes: 6 * 1024 * 1024,
      terminal: { modelTokens: 100, usageId: "worker-8-1" },
    },
  };
  settle(8);
  add("RunPauseAcknowledged", "run", { commandRequestId: `${authority.namespace}-pause` });
  const paused = observe(1);
  reserve(9);
  settle(9);
  reserve(10);
  settle(10);
  add("FactoryRunCompleted", "run");
  const completed = observe(3, true);
  const actions: string[] = [];
  const port = {
    pauseRequestId: `${authority.namespace}-pause`,
    preflight: vi.fn(async () => "inactive"),
    action: vi.fn(async (name: string) => {
      actions.push(name);
    }),
    controller: vi.fn(
      async (state: string, prior?: unknown) =>
        prior ??
        (state === "inactive" ? { state } : actions.includes("restart") ? replacement : original),
    ),
    poll: vi.fn(async (phase: string, accept: (value: unknown) => boolean) => {
      const value =
        phase === "completed" ? completed : phase === "recovered-transfer-pause" ? paused : held;
      expect(accept(value)).toBe(true);
      return value;
    }),
    armTransfer: vi.fn(async () => ({ digest: held.transferCheckpoint.armDigest })),
    transferProof: vi.fn(async () => ({
      artifactDigest: "1".repeat(64),
      intentOid: "2".repeat(40),
    })),
    absence: vi.fn(async () => []),
    checkpoint: vi.fn(async () => {}),
    takeover: vi.fn(async () => {}),
    finalProof: vi.fn(async () => {}),
    compileRefusal: vi.fn(async () => ({ refused: true })),
    artifactRefusal: vi.fn(async () => ({ refused: true })),
  };
  return { port, actions, held, paused, completed };
}

describe("installed large-file lifecycle authority", () => {
  it("assembles ports before preflight has discovered a base or created an Objective", async () => {
    const parent = mkdtempSync(join(tmpdir(), "factory-large-file-port-test-"));
    try {
      const fixture = createLargeFileFixture({ parent, namespace: authority.namespace });
      const path = join(fixture.root, "fixture.json");
      const extension = largeFileExtension({
        ...authority,
        largeFile: {
          ...authority.largeFile,
          fixture: path,
          fixtureDigest: hash(readFileSync(path, "utf8")),
        },
      });
      const port = { preflight: vi.fn(), action: vi.fn() };
      const assembled = (await extension.extendPort!({
        port,
        evidence: {},
        save: vi.fn(),
        request: vi.fn(),
      })) as Record<string, unknown>;
      expect(assembled.compileRefusal).toBeTypeOf("function");
      expect(assembled.armTransfer).toBeTypeOf("function");
      expect(port.action).not.toHaveBeenCalled();
      expect(port.preflight).not.toHaveBeenCalled();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it("does nothing without its own opt-in", async () => {
    expect(largeFileAuthority({ ...env, FACTORY_LOCAL_LARGE_FILES: undefined })).toBeNull();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({});
      expect(log).toHaveBeenCalledWith(expect.stringContaining("opt-in"));
    } finally {
      log.mockRestore();
    }
  });
  it("requires the exact case, fault authority and explicit allowance", () => {
    for (const key of [
      "FACTORY_LARGE_FILE_ACK",
      "FACTORY_LARGE_FILE_MAX_MODEL_TOKENS",
      "FACTORY_LARGE_FILE_CASE",
    ])
      expect(() => largeFileAuthority({ ...env, [key]: undefined })).toThrow();
    expect(() => largeFileAuthority({ ...env, FACTORY_LARGE_FILE_CASE: "secret" })).toThrow();
    expect(authority.policy).toMatchObject({
      backendOrder: ["codex-app-server/local-worktree"],
      maxParallel: 1,
    });
    expect(parseRunPolicy(authority.policy).capacity?.local?.maxWorkers).toBe(1);
  });
  it("never mutates during preflight", async () => {
    const f = scenario();
    expect(
      await runLargeFileScenario(f.port as never, { ...authority, phase: "preflight" }),
    ).toMatchObject({ result: "preflight-only" });
    expect(f.actions).toEqual([]);
    expect(f.port.armTransfer).not.toHaveBeenCalled();
  });
  it("pins the one-shot transfer fault to exact activation, base and producer", () => {
    const arm = largeFileTransferArm(authority, original, 7, baseSha, 0);
    expect(arm).toMatchObject({
      repository,
      objective: 7,
      baseSha,
      unit,
      activationRequestId: `${authority.namespace}-activate`,
      invocationId: original.invocationId,
      minPayloadBytes: 5242881,
      expiresAt: "1970-01-01T00:10:00.000Z",
    });
    expect(transferArmPath(unit, original.invocationId, 1000)).toContain(
      `/${hash(`${unit}\0${original.invocationId}`)}.json`,
    );
    expect(() => transferArmPath("other.service", original.invocationId)).toThrow();
  });
  it("waits for the actual intent witness and rejects early completion, altered usage and another attempt", () => {
    const f = scenario(),
      arm = { digest: f.held.transferCheckpoint.armDigest };
    expect(transferHoldReady({ ...f.held, transferCheckpoint: undefined }, authority, arm)).toBe(
      false,
    );
    expect(transferHoldReady(f.held, authority, arm)).toBe(true);
    const changed = structuredClone(f.held);
    changed.transferCheckpoint.terminal.modelTokens = 0;
    expect(() => transferHoldReady(changed, authority, arm)).toThrow();
    for (const event of [
      "AttemptSucceeded",
      "AttemptFailed",
      "AttemptCollected",
      "PublicationRecorded",
      "FactoryRunCompleted",
    ])
      expect(() =>
        transferHoldReady(
          { ...f.held, receipts: [...f.held.receipts, { event: { event } }] },
          authority,
          arm,
        ),
      ).toThrow();
    expect(() =>
      transferHoldReady(
        { ...f.held, transferCheckpoint: { ...f.held.transferCheckpoint, attempt: 2 } },
        authority,
        arm,
      ),
    ).toThrow();
  });
  it("proves intent, restarts once, verifies exact ready recovery, then finishes the original graph", async () => {
    const f = scenario();
    expect(await runLargeFileScenario(f.port as never, authority)).toMatchObject({
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
    expect(f.port.armTransfer).toHaveBeenCalledOnce();
    expect(f.port.transferProof).toHaveBeenCalledTimes(2);
    expect(f.port.finalProof).toHaveBeenCalledOnce();
  });
  it.each(["checkpoint", "takeover", "finalProof", "absence"] as const)(
    "never automatically retries or cleans up after uncertain %s",
    async (method) => {
      const f = scenario();
      f.port[method].mockRejectedValue(Error("unknown"));
      await expect(runLargeFileScenario(f.port as never, authority)).rejects.toThrow("unknown");
      expect(f.actions).not.toContain("stop");
      if (method !== "finalProof") expect(f.actions).not.toContain("resume");
    },
  );
  it("does not resume a different transfer identity", async () => {
    const f = scenario();
    f.port.transferProof
      .mockResolvedValueOnce({ artifactDigest: "first", intentOid: "same" })
      .mockResolvedValueOnce({ artifactDigest: "second", intentOid: "same" });
    await expect(runLargeFileScenario(f.port as never, authority)).rejects.toThrow();
    expect(f.actions).not.toContain("resume");
  });
  it("checks source refusal without starting a controller or worker", async () => {
    const f = scenario();
    expect(
      await runLargeFileScenario(f.port as never, {
        ...authority,
        largeFile: { ...authority.largeFile, scenario: "lfs-missing-object" },
      }),
    ).toMatchObject({ result: "passed", scope: "installed-pre-compilation-refusal-only" });
    expect(f.actions).toEqual(["create"]);
    expect(f.port.compileRefusal).toHaveBeenCalledOnce();
    expect(f.port.armTransfer).not.toHaveBeenCalled();
  });
  it("requires a proven artifact refusal and exact scope absence before stopping", async () => {
    const f = scenario();
    f.port.poll.mockImplementation(async (_phase, accept) => {
      expect(accept(f.completed)).toBe(true);
      return f.completed;
    });
    expect(
      await runLargeFileScenario(f.port as never, {
        ...authority,
        largeFile: { ...authority.largeFile, scenario: "secret" },
      }),
    ).toMatchObject({ result: "passed", scope: "installed-artifact-refusal-only" });
    expect(f.actions).toEqual(["start", "create", "activate", "stop"]);
    expect(f.port.artifactRefusal).toHaveBeenCalledWith(f.completed);
    expect(f.port.absence).toHaveBeenCalledOnce();
    expect(f.port.armTransfer).not.toHaveBeenCalled();
  });
});
