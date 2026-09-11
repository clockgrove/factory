import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "", absence: "absent", observations: 0 }));
vi.mock("node:os", () => ({ tmpdir: () => state.root }));
vi.mock("../src/runtime/local-scope.js", () => ({
  observeLocalScope: async () => {
    state.observations++;
    return { status: state.absence };
  },
}));
import {
  holdAppServerQualificationCheckpoint,
  qualificationCheckpointPath,
  SafeArtifactCheckpointHeldError,
  SafeArtifactCheckpointShutdownError,
} from "../src/runtime/qualification-checkpoint.js";

const digest = "a".repeat(64),
  unit = `clockgrove-factory-${"a".repeat(16)}.service`,
  invocation = "b".repeat(32);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  state.root = await mkdtemp("/tmp/factory-app-checkpoint-contract-");
  roots.push(state.root);
  state.absence = "absent";
  state.observations = 0;
  let fenced = 0,
    proved = 0;
  const controller = new AbortController();
  const batch = {
    identity: {
      protocol: "clockgrove.factory/local-scope-v1",
      repository: "example/disposable",
      objective: 7,
      runId: "run-7",
      workItem: 8,
      attempt: 1,
      directorEpoch: 2,
      policyDigest: digest,
      phase: "execution",
      commandIndex: 0,
      invocationDigest: digest,
      hostIdentity: digest,
      producerUnit: unit,
      producerInvocationId: invocation,
    },
    commandCount: 1,
    producerPid: process.pid,
    producerStartTicks: "123",
    deadline: new Date(Date.now() + 60000).toISOString(),
  };
  const objectiveStartedAt = new Date();
  const args = {
    repository: "example/disposable",
    objective: 7,
    activationRequestId: "qualification-activate",
    runId: "run-7",
    workItem: 8,
    attempt: 1,
    directorEpoch: 2,
    policyDigest: digest,
    baseSha: "b".repeat(40),
    artifactDigest: digest,
    threadId: "thread-1",
    turnId: "turn-1",
    modelTokens: 1234,
    nativeMilliseconds: 500,
    batch,
    objectiveStartedAt,
    objectiveDeadline: new Date(objectiveStartedAt.getTime() + 120_000),
    holdDurationMs: 60_000,
    signal: controller.signal,
    assertCurrent: async () => {
      fenced++;
      if (fenced === 2) controller.abort();
    },
    proveTerminal: async () => {
      proved++;
    },
  };
  const arm = {
    protocol: "clockgrove.factory/app-server-checkpoint-arm-v2",
    repository: args.repository,
    objective: args.objective,
    activationRequestId: args.activationRequestId,
    policyDigest: digest,
    unit,
    invocationId: invocation,
    hostIdentity: digest,
    producerPid: process.pid,
    producerStartTicks: "123",
    eligibilityDurationMs: 120_000,
    holdDurationMs: args.holdDurationMs,
  };
  const path = qualificationCheckpointPath(unit, invocation);
  return {
    args,
    controller,
    arm,
    path,
    counts: () => ({ fenced, proved }),
    async armNow(value: unknown = arm) {
      await mkdir(join(state.root, `factory-qualification-checkpoints-${process.getuid!()}`), {
        mode: 0o700,
      });
      await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    },
  };
}
describe("one-shot installed App Server checkpoint hold", () => {
  it("keeps reached hold expiry distinct from a shutdown interruption", async () => {
    const f = await fixture();
    await f.armNow({ ...f.arm, holdDurationMs: 1 });
    const result = await holdAppServerQualificationCheckpoint({
      ...f.args,
      holdDurationMs: 1,
      assertCurrent: async () => {},
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(SafeArtifactCheckpointHeldError);
    expect(result).not.toBeInstanceOf(SafeArtifactCheckpointShutdownError);
    expect(f.controller.signal.aborted).toBe(false);
  });
  it("is a default no-op without private opt-in and does not even read provider proof", async () => {
    const f = await fixture();
    await holdAppServerQualificationCheckpoint(f.args);
    expect(f.counts()).toEqual({ fenced: 0, proved: 0 });
    expect(state.observations).toBe(0);
  });
  it("writes the exact reached identity and never returns into validation on abort", async () => {
    const f = await fixture();
    await f.armNow();
    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      SafeArtifactCheckpointShutdownError,
    );
    const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
    expect(witness).toMatchObject({
      protocol: "clockgrove.factory/app-server-checkpoint-reached-v2",
      runId: "run-7",
      workItem: 8,
      attempt: 1,
      artifactDigest: digest,
      modelTokens: 1234,
      nativeMilliseconds: 500,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(Date.parse(witness.holdUntil) - Date.parse(witness.reachedAt)).toBe(60_000);
    expect(witness.startedAt).toBe(f.args.objectiveStartedAt.toISOString());
    expect(witness.eligibleUntil).toBe(f.args.objectiveDeadline.toISOString());
    expect(f.counts()).toEqual({ fenced: 2, proved: 1 });
    const repeated = await holdAppServerQualificationCheckpoint(f.args).catch(
      (error: unknown) => error,
    );
    expect(repeated).toBeInstanceOf(SafeArtifactCheckpointHeldError);
    expect(repeated).not.toBeInstanceOf(SafeArtifactCheckpointShutdownError);
    expect(JSON.parse(await readFile(`${f.path}.reached`, "utf8"))).toEqual(witness);
  });
  it("samples the reach clock once so a later tick cannot cross eligibility", async () => {
    const f = await fixture();
    f.args.objectiveStartedAt = new Date(0);
    f.args.objectiveDeadline = new Date(100);
    await f.armNow({ ...f.arm, eligibilityDurationMs: 100 });
    vi.spyOn(Date, "now").mockReturnValueOnce(98).mockReturnValueOnce(99).mockReturnValue(100);

    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      SafeArtifactCheckpointShutdownError,
    );
    const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
    expect(Date.parse(witness.reachedAt)).toBe(99);
    expect(Date.parse(witness.reachedAt)).toBeLessThan(Date.parse(witness.eligibleUntil));
  });
  it.each([
    "objective",
    "activationRequestId",
    "policyDigest",
    "producerStartTicks",
    "invocationId",
  ])("rejects wrong %s without reached evidence", async (key) => {
    const f = await fixture();
    await f.armNow({
      ...f.arm,
      [key]:
        key === "objective"
          ? 9
          : key === "policyDigest"
            ? "c".repeat(64)
            : key === "invocationId"
              ? "c".repeat(32)
              : "wrong",
    });
    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toThrow();
    await expect(readFile(`${f.path}.reached`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["present", "unknown"])("does not hold a checkpoint over %s compute", async (absence) => {
    const f = await fixture();
    await f.armNow();
    state.absence = absence;
    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toThrow(
      "scope is not absent",
    );
  });
  it("rejects expiry, missing terminal accounting and loss of the current fence", async () => {
    const f = await fixture();
    await f.armNow();
    const expiredDeadline = new Date(Date.now() - 1);
    await expect(
      holdAppServerQualificationCheckpoint({
        ...f.args,
        objectiveStartedAt: new Date(expiredDeadline.getTime() - f.arm.eligibilityDurationMs),
        objectiveDeadline: expiredDeadline,
      }),
    ).rejects.toThrow("expiry");
    await writeFile(f.path, JSON.stringify(f.arm));
    await expect(
      holdAppServerQualificationCheckpoint({ ...f.args, modelTokens: NaN }),
    ).rejects.toThrow("evidence");
    await expect(
      holdAppServerQualificationCheckpoint({
        ...f.args,
        proveTerminal: async () => {
          throw new Error("unknown terminal");
        },
      }),
    ).rejects.toThrow("unknown terminal");
    await expect(
      holdAppServerQualificationCheckpoint({
        ...f.args,
        assertCurrent: async () => {
          throw new Error("lease lost");
        },
      }),
    ).rejects.toThrow("lease lost");
    await expect(readFile(`${f.path}.reached`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an unreached v1 arm instead of silently extending it", async () => {
    const f = await fixture();
    const {
      eligibilityDurationMs: _eligibilityDurationMs,
      holdDurationMs: _holdDurationMs,
      ...legacy
    } = f.arm;
    await f.armNow({
      ...legacy,
      protocol: "clockgrove.factory/app-server-checkpoint-arm-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toThrow("arm v1 is retired");
  });
  it("reaches after the former ten-minute arm window and starts a fresh bounded hold", async () => {
    const f = await fixture();
    const startedAt = new Date(Date.now() - 10 * 60_000 - 1);
    const eligibilityDurationMs = 45 * 60_000;
    await f.armNow({ ...f.arm, eligibilityDurationMs, holdDurationMs: 1 });
    const result = await holdAppServerQualificationCheckpoint({
      ...f.args,
      objectiveStartedAt: startedAt,
      objectiveDeadline: new Date(startedAt.getTime() + eligibilityDurationMs),
      holdDurationMs: 1,
      assertCurrent: async () => {},
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(SafeArtifactCheckpointHeldError);
    const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
    expect(Date.parse(witness.holdUntil) - Date.parse(witness.reachedAt)).toBe(1);
    expect(witness.startedAt).toBe(startedAt.toISOString());
  });
});
