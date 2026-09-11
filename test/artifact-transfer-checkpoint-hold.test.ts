import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  root: "",
  host: {} as Record<string, unknown>,
  observations: 0,
}));
vi.mock("node:os", () => ({ tmpdir: () => state.root }));
vi.mock("../src/runtime/local-scope.js", () => ({
  discoverLocalScopeHost: async () => {
    state.observations++;
    return state.host;
  },
}));
import {
  artifactTransferRef,
  type ArtifactTransferIntentCheckpoint,
} from "../src/control/artifact-transfers.js";
import {
  ArtifactTransferQualificationHeldError,
  artifactTransferQualificationCheckpointPath,
  holdArtifactTransferQualificationCheckpoint,
  proveArtifactTransferQualificationReceipts,
} from "../src/runtime/artifact-transfer-qualification-checkpoint.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { recoveryEventDigest } from "../src/recovery/identity.js";

const digest = policyDigest(DEFAULT_RUN_POLICY),
  unit = `clockgrove-factory-${"a".repeat(16)}.service`,
  invocation = "b".repeat(32);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  state.root = await mkdtemp("/tmp/factory-transfer-checkpoint-contract-");
  roots.push(state.root);
  state.observations = 0;
  state.host = {
    hostIdentity: digest,
    producerPid: process.pid,
    producerStartTicks: "123",
    producerUnit: unit,
    producerInvocationId: invocation,
  };
  const identity = {
    repository: "example/disposable",
    objective: 7,
    runId: "run-7",
    workItem: 8,
    attempt: 1,
    directorEpoch: 2,
    policyDigest: digest,
    baseSha: "b".repeat(40),
  };
  const batch = {
    identity: {
      protocol: "clockgrove.factory/local-scope-v1",
      ...identity,
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
  // LocalScopeIdentity deliberately does not contain an artifact/source-base field.
  const { baseSha: _base, ...scopeIdentity } = batch.identity;
  const exactBatch = { ...batch, identity: scopeIdentity };
  let fenced = 0,
    retained = 0,
    proved = 0;
  const controller = new AbortController();
  const checkpoint: ArtifactTransferIntentCheckpoint = {
    identity,
    artifactDigest: "c".repeat(64),
    payloadDigest: "d".repeat(64),
    payloadBytes: 5 * 1024 * 1024 + 1,
    payloadChunks: 2,
    intentRef: `${artifactTransferRef(identity)}/intent`,
    intentCommitSha: "e".repeat(40),
    descriptorDigest: "f".repeat(64),
    proveRetained: async () => {
      retained++;
    },
  };
  const common = {
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "run-7",
    at: new Date().toISOString(),
  };
  const attempt = {
    ...common,
    kind: "attempt",
    workItem: 8,
    attempt: 1,
    backend: "codex-sdk/local-worktree",
    baseSha: identity.baseSha,
    directorEpoch: 2,
    policyDigest: digest,
  };
  const events = [
    parseFactoryEvent({
      ...common,
      kind: "run",
      event: "FactoryRunStarted",
      sequence: 0,
      actor: "fixture",
      objectiveAuthor: "fixture",
      fork: false,
      repository: identity.repository,
      baseBranch: "main",
      policy: DEFAULT_RUN_POLICY,
      policyDigest: digest,
      activationRequestId: "qualification-activate",
    }),
    parseFactoryEvent({
      ...attempt,
      event: "AttemptReserved",
      sequence: 1,
      localScopeBatch: exactBatch,
    }),
    parseFactoryEvent({
      ...attempt,
      event: "AttemptStarted",
      sequence: 2,
      providerResourceId: "worker-8",
    }),
    // Real recorder omits epoch/policy on ordinary (non-conservative) model receipts.
    parseFactoryEvent({
      ...common,
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 3,
      workItem: 8,
      attempt: 1,
      phase: "execution",
      unit: "model_tokens",
      amount: 1234,
      usageId: "worker-8-1",
    }),
  ];
  const proofArgs = {
    checkpoint,
    activationRequestId: "qualification-activate",
    backend: attempt.backend,
    reservationSequence: 1,
    providerResourceId: "worker-8",
    modelTokens: 1234,
    batch: exactBatch,
    events,
  };
  const objectiveStartedAt = new Date();
  const args = {
    checkpoint,
    activationRequestId: proofArgs.activationRequestId,
    batch: exactBatch,
    objectiveStartedAt,
    objectiveDeadline: new Date(objectiveStartedAt.getTime() + 120_000),
    holdDurationMs: 60_000,
    signal: controller.signal,
    assertCurrent: async () => {
      if (++fenced === 2) controller.abort();
    },
    proveTerminal: async () => {
      proved++;
      return proveArtifactTransferQualificationReceipts(proofArgs);
    },
  };
  const arm = {
    protocol: "clockgrove.factory/artifact-transfer-checkpoint-arm-v2",
    repository: identity.repository,
    objective: 7,
    activationRequestId: args.activationRequestId,
    policyDigest: digest,
    baseSha: identity.baseSha,
    unit,
    invocationId: invocation,
    hostIdentity: digest,
    producerPid: process.pid,
    producerStartTicks: "123",
    minPayloadBytes: 5 * 1024 * 1024 + 1,
    eligibilityDurationMs: 120_000,
    holdDurationMs: args.holdDurationMs,
  };
  const path = artifactTransferQualificationCheckpointPath(unit, invocation);
  return {
    args,
    arm,
    path,
    proofArgs,
    counts: () => ({ fenced, retained, proved }),
    armNow: async (value: unknown = arm) => {
      await mkdir(dirname(path), { mode: 0o700 });
      await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    },
  };
}
describe("one-shot oversized transfer checkpoint", () => {
  it("does nothing without opt-in, for inline output, or below the armed threshold", async () => {
    const f = await fixture();
    await holdArtifactTransferQualificationCheckpoint(f.args);
    await f.armNow({ ...f.arm, minPayloadBytes: f.arm.minPayloadBytes + 1 });
    await holdArtifactTransferQualificationCheckpoint(f.args);
    await holdArtifactTransferQualificationCheckpoint({
      ...f.args,
      checkpoint: { ...f.args.checkpoint, payloadBytes: 10 },
    });
    expect(f.counts()).toEqual({ fenced: 0, retained: 0, proved: 0 });
    expect(state.observations).toBe(0);
  });
  it("latches exact intent/producer/terminal identity and never releases to ready or overwrites the witness", async () => {
    const f = await fixture();
    await f.armNow();
    await expect(holdArtifactTransferQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      ArtifactTransferQualificationHeldError,
    );
    const raw = await readFile(`${f.path}.reached`, "utf8"),
      witness = JSON.parse(raw);
    expect(witness).toMatchObject({
      protocol: "clockgrove.factory/artifact-transfer-checkpoint-reached-v2",
      ...f.args.checkpoint.identity,
      artifactDigest: f.args.checkpoint.artifactDigest,
      intentCommitSha: f.args.checkpoint.intentCommitSha,
      descriptorDigest: f.args.checkpoint.descriptorDigest,
      payloadBytes: f.args.checkpoint.payloadBytes,
      payloadDigest: f.args.checkpoint.payloadDigest,
      terminal: {
        modelTokens: 1234,
        usageId: "worker-8-1",
        modelReceiptDigest: recoveryEventDigest(f.proofArgs.events[3]!),
      },
      executionCleanup: "not-proven-by-checkpoint",
      nativeUsage: "not-measured-by-checkpoint",
    });
    expect(Date.parse(witness.holdUntil) - Date.parse(witness.reachedAt)).toBe(60_000);
    expect(witness.startedAt).toBe(f.args.objectiveStartedAt.toISOString());
    expect(witness.eligibleUntil).toBe(f.args.objectiveDeadline.toISOString());
    expect((await stat(`${f.path}.reached`)).mode & 0o777).toBe(0o600);
    expect(f.counts()).toEqual({ fenced: 2, retained: 1, proved: 1 });
    await expect(holdArtifactTransferQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      ArtifactTransferQualificationHeldError,
    );
    expect(await readFile(`${f.path}.reached`, "utf8")).toBe(raw);
  });
  it("samples the reach clock once so a later tick cannot cross eligibility", async () => {
    const f = await fixture();
    f.args.objectiveStartedAt = new Date(0);
    f.args.objectiveDeadline = new Date(100);
    await f.armNow({ ...f.arm, eligibilityDurationMs: 100 });
    vi.spyOn(Date, "now").mockReturnValueOnce(98).mockReturnValueOnce(99).mockReturnValue(100);

    await expect(holdArtifactTransferQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      ArtifactTransferQualificationHeldError,
    );
    const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
    expect(Date.parse(witness.reachedAt)).toBe(99);
    expect(Date.parse(witness.reachedAt)).toBeLessThan(Date.parse(witness.eligibleUntil));
  });
  it.each([
    "repository",
    "objective",
    "activationRequestId",
    "policyDigest",
    "baseSha",
    "producerStartTicks",
    "invocationId",
  ])("refuses mismatched %s without reaching", async (key) => {
    const f = await fixture();
    await f.armNow({
      ...f.arm,
      [key]:
        key === "objective"
          ? 9
          : key === "repository"
            ? "other/repo"
            : key === "policyDigest"
              ? "c".repeat(64)
              : key === "baseSha"
                ? "c".repeat(40)
                : key === "invocationId"
                  ? "c".repeat(32)
                  : "456",
    });
    await expect(holdArtifactTransferQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      ArtifactTransferQualificationHeldError,
    );
    await expect(readFile(`${f.path}.reached`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    "expired",
    "overlong",
    "replacement",
    "retry",
    "retained",
    "terminal",
    "fence",
    "permissions",
  ])("refuses %s evidence and does not publish a witness", async (fault) => {
    const f = await fixture();
    await f.armNow({
      ...f.arm,
      eligibilityDurationMs:
        fault === "overlong" ? f.arm.eligibilityDurationMs + 60_000 : f.arm.eligibilityDurationMs,
    });
    if (fault === "expired") {
      f.args.objectiveDeadline = new Date(Date.now() - 1);
      f.args.objectiveStartedAt = new Date(
        f.args.objectiveDeadline.getTime() - f.arm.eligibilityDurationMs,
      );
    }
    if (fault === "replacement") state.host.producerStartTicks = "456";
    if (fault === "retry") f.args.checkpoint.identity.attempt = 2;
    if (fault === "retained")
      f.args.checkpoint.proveRetained = async () => {
        throw new Error("missing original bytes");
      };
    if (fault === "terminal")
      f.args.proveTerminal = async () => {
        throw new Error("missing terminal");
      };
    if (fault === "fence")
      f.args.assertCurrent = async () => {
        throw new Error("lost lease");
      };
    if (fault === "permissions") await chmod(f.path, 0o644);
    await expect(holdArtifactTransferQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      ArtifactTransferQualificationHeldError,
    );
    await expect(readFile(`${f.path}.reached`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an unreached v1 arm without reinterpreting its expiry", async () => {
    const f = await fixture();
    const {
      eligibilityDurationMs: _eligibilityDurationMs,
      holdDurationMs: _holdDurationMs,
      ...legacy
    } = f.arm;
    await f.armNow({
      ...legacy,
      protocol: "clockgrove.factory/artifact-transfer-checkpoint-arm-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(holdArtifactTransferQualificationCheckpoint(f.args)).rejects.toThrow(
      "arm v1 is retired",
    );
  });
  it("reaches after the former ten-minute arm window and receives the full hold", async () => {
    const f = await fixture();
    const startedAt = new Date(Date.now() - 10 * 60_000 - 1);
    const eligibilityDurationMs = 45 * 60_000;
    await f.armNow({ ...f.arm, eligibilityDurationMs, holdDurationMs: 1 });
    const result = await holdArtifactTransferQualificationCheckpoint({
      ...f.args,
      objectiveStartedAt: startedAt,
      objectiveDeadline: new Date(startedAt.getTime() + eligibilityDurationMs),
      holdDurationMs: 1,
      assertCurrent: async () => {},
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ArtifactTransferQualificationHeldError);
    const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
    expect(Date.parse(witness.holdUntil) - Date.parse(witness.reachedAt)).toBe(1);
    expect(witness.startedAt).toBe(startedAt.toISOString());
  });
  it("binds real missing-vs-zero accounting, rejects conflicting receipts and ignores unrelated attempts", async () => {
    const f = await fixture(),
      args = f.proofArgs;
    expect(proveArtifactTransferQualificationReceipts(args).modelTokens).toBe(1234);
    const zero = args.events.map((event) =>
      event.kind === "budget" ? { ...event, amount: 0 } : event,
    );
    expect(
      proveArtifactTransferQualificationReceipts({ ...args, events: zero, modelTokens: 0 })
        .modelTokens,
    ).toBe(0);
    expect(() =>
      proveArtifactTransferQualificationReceipts({ ...args, modelTokens: undefined }),
    ).toThrow("terminal model receipt");
    expect(() =>
      proveArtifactTransferQualificationReceipts({ ...args, events: args.events.slice(0, 3) }),
    ).toThrow("terminal model receipt");
    expect(() =>
      proveArtifactTransferQualificationReceipts({
        ...args,
        events: [
          ...args.events,
          parseFactoryEvent({ ...args.events[3], sequence: 4, amount: 999 }),
        ],
      }),
    ).toThrow("terminal model receipt");
    expect(() =>
      proveArtifactTransferQualificationReceipts({
        ...args,
        events: args.events.map((event) =>
          event.kind === "attempt" && event.event === "AttemptStarted"
            ? { ...event, baseSha: "e".repeat(40) }
            : event,
        ),
      }),
    ).toThrow("dispatched reservation");
    expect(
      proveArtifactTransferQualificationReceipts({
        ...args,
        events: [
          ...args.events,
          parseFactoryEvent({ ...args.events[3], sequence: 4, workItem: 9 }),
        ],
      }).modelTokens,
    ).toBe(1234);
  });
});
