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
} from "../src/runtime/qualification-checkpoint.js";

const digest = "a".repeat(64),
  unit = `clockgrove-factory-${"a".repeat(16)}.service`,
  invocation = "b".repeat(32);
const roots: string[] = [];
afterEach(async () => {
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
    protocol: "clockgrove.factory/app-server-checkpoint-arm-v1",
    repository: args.repository,
    objective: args.objective,
    activationRequestId: args.activationRequestId,
    policyDigest: digest,
    unit,
    invocationId: invocation,
    hostIdentity: digest,
    producerPid: process.pid,
    producerStartTicks: "123",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const path = qualificationCheckpointPath(unit, invocation);
  return {
    args,
    arm,
    path,
    counts: () => ({ fenced, proved }),
    async armNow(value = arm) {
      await mkdir(join(state.root, `factory-qualification-checkpoints-${process.getuid!()}`), {
        mode: 0o700,
      });
      await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    },
  };
}
describe("one-shot installed App Server checkpoint hold", () => {
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
      SafeArtifactCheckpointHeldError,
    );
    const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
    expect(witness).toMatchObject({
      runId: "run-7",
      workItem: 8,
      attempt: 1,
      artifactDigest: digest,
      modelTokens: 1234,
      nativeMilliseconds: 500,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(f.counts()).toEqual({ fenced: 2, proved: 1 });
    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      SafeArtifactCheckpointHeldError,
    );
    expect(JSON.parse(await readFile(`${f.path}.reached`, "utf8"))).toEqual(witness);
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
    await f.armNow({ ...f.arm, expiresAt: new Date(Date.now() - 1).toISOString() });
    await expect(holdAppServerQualificationCheckpoint(f.args)).rejects.toThrow("expiry");
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
});
