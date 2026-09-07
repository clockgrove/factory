import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertContinuationSeed,
  assertContinuationObservation,
  continuationEvidencePath,
  assertStoppedContinuationController,
  runCheckpointContinuation,
} from "../scripts/verify-local-checkpoint-continuation.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const at = "2026-09-07T04:58:07.000Z";
  const policy = {
    objectiveTimeoutMinutes: 45,
    allowedPaidBackends: [],
    economics: { maxModelTokens: 250000, modelTokenBudgetMode: "observed-stop" },
  };
  const actor = { id: 42, login: "operator" };
  const authority = {
    sessionRecovery: true,
    phase: "exercise",
    repository: "example/disposable",
    namespace: "retained",
    unit: "fixture.service",
    policy,
    evidence: "/tmp/private/exercise.json",
  };
  const controller = {
    unit: authority.unit,
    invocationId: "a".repeat(32),
    pid: 100,
    startTicks: "12",
    hostIdentity: "b".repeat(64),
    configDigest: "c".repeat(64),
  };
  const base = "d".repeat(40),
    digest = "e".repeat(64);
  const activation = {
    event: "ActivationRequested",
    runId: "retained-activate",
    requestId: "retained-activate",
    objective: 7,
    repository: authority.repository,
    baseSha: base,
    policy,
    policyDigest: digest,
    requestedBy: actor.login,
  };
  const arm = {
    repository: authority.repository,
    objective: 7,
    activationRequestId: activation.requestId,
    policyDigest: digest,
    expiresAt: "2026-09-07T05:08:07.000Z",
    unit: controller.unit,
    invocationId: controller.invocationId,
    producerPid: controller.pid,
    producerStartTicks: controller.startTicks,
    hostIdentity: controller.hostIdentity,
  };
  const witness = {
    protocol: "clockgrove.factory/app-server-checkpoint-reached-v1",
    armDigest: hash(JSON.stringify(arm)),
    ...Object.fromEntries(
      ["repository", "objective", "activationRequestId", "policyDigest", "expiresAt"].map((key) => [
        key,
        arm[key as keyof typeof arm],
      ]),
    ),
    runId: "run-original",
    workItem: 8,
    attempt: 1,
    baseSha: base,
    reachedAt: "2026-09-07T05:02:19.000Z",
  };
  const pause = {
    event: "RunPauseRequested",
    runId: witness.runId,
    objective: 7,
    requestedBy: actor.login,
    requestId: "retained-contain",
  };
  const create = { number: 7, node_id: "objective-7", user: actor, body: "fixture" };
  const original = {
    protocol: "clockgrove.factory/checkpoint-restart-qualification-v1",
    result: { result: "incomplete" },
    authority,
    artifact: { inventorySha256: "f".repeat(64) },
    sourceCommit: base,
    harnessFiles: [],
    startedAt: at,
    actor,
    base,
    configDigest: controller.configDigest,
    objective: { number: 7, node_id: "objective-7" },
    objectiveBodyDigest: hash(create.body),
    sessionArm: { arm, digest: witness.armDigest, writtenAt: at },
    controllerReadiness: [{ identity: controller }],
    runRequest: {
      tool: "factory_activate",
      arguments: {
        owner: "example",
        repo: "disposable",
        objectiveNumber: 7,
        requestId: activation.requestId,
        baseSha: base,
        policy,
      },
    },
    actions: [
      {
        action: "start",
        requestedAt: at,
        returnedAt: at,
        response: { accepted: true, unit: authority.unit, repository: authority.repository },
      },
      { action: "create", requestedAt: at, returnedAt: at, response: create },
      { action: "activate", requestedAt: at, returnedAt: at, response: activation },
    ],
  };
  const tuple = { objective: 7, runId: witness.runId, policyDigest: digest, directorEpoch: 1 };
  const model = (phase: string, id: string, workItem?: number) => [
    {
      kind: "budget",
      event: "BudgetReserved",
      ...tuple,
      phase,
      unit: "model_tokens",
      amount: 0,
      sequence: 10,
      usageId: `invocation-${id}`,
      modelInvocationId: id,
      ...(workItem ? { workItem, attempt: 1 } : {}),
    },
    {
      kind: "budget",
      event: "BudgetReconciled",
      ...tuple,
      phase,
      unit: "model_tokens",
      amount: phase === "execution" ? 44906 : 16444,
      sequence: 11,
      usageId: id,
      modelInvocationId: id,
      ...(workItem ? { workItem, attempt: 1 } : {}),
    },
  ];
  const events = [
    activation,
    {
      ...tuple,
      event: "FactoryRunStarted",
      actor: actor.login,
      baseSha: base,
      repository: authority.repository,
      activationRequestId: activation.requestId,
      policy,
    },
    pause,
    {
      ...tuple,
      event: "AttemptReserved",
      workItem: 8,
      attempt: 1,
      backend: "codex-app-server/local-worktree",
    },
    { ...tuple, event: "AttemptStarted", workItem: 8, attempt: 1 },
    { ...tuple, event: "AttemptSucceeded", workItem: 8, attempt: 1 },
    ...model("management", "compile"),
    ...model("execution", "worker-8-1", 8),
  ];
  const observation = {
    receipts: events.map((event) => ({ event })),
    status: {
      run: { state: "paused", runId: witness.runId },
      summary: {
        economics: { unresolvedModelInvocations: 0, usage: { model_tokens: { value: 61350 } } },
      },
    },
  };
  return {
    original,
    witness,
    pause,
    controller,
    observation,
    now: Date.parse("2026-09-07T05:10:00.000Z"),
  };
}

describe("bounded original checkpoint observation continuation", () => {
  it("binds one exclusive output so another filename cannot replay an uncertain start", () => {
    const f = fixture();
    expect(
      continuationEvidencePath(
        f.original,
        f.original.authority.evidence,
        "/tmp/private/exercise.json.continuation.json",
      ),
    ).toBe("/tmp/private/exercise.json.continuation.json");
    expect(() =>
      continuationEvidencePath(
        f.original,
        f.original.authority.evidence,
        "/tmp/private/retry.json",
      ),
    ).toThrow();
    expect(() =>
      continuationEvidencePath(
        f.original,
        "/tmp/private/copy.json",
        "/tmp/private/copy.json.continuation.json",
      ),
    ).toThrow();
  });
  it("accepts a timely historical witness after arm expiry without extending the original deadline", () => {
    const f = fixture();
    expect(
      assertContinuationSeed(f.original, f.witness, f.pause, f.original.artifact, f.now),
    ).toMatchObject({
      runId: "run-original",
      pauseRequestId: "retained-contain",
      deadline: Date.parse("2026-09-07T05:43:07.000Z"),
    });
    expect(
      assertContinuationObservation(f.observation, f.original, f.witness, f.pause, f.now)
        .modelTokens,
    ).toBe(61350);
  });
  it.each([
    "expired",
    "artifact",
    "actor",
    "run",
    "policy",
    "uncertain",
    "already-resumed",
    "late-witness",
  ])("refuses changed or unsupported authority: %s", (cut) => {
    const f = fixture();
    if (cut === "expired") f.now = Date.parse("2026-09-07T05:43:07.000Z");
    if (cut === "artifact") f.original.artifact.inventorySha256 = "0".repeat(64);
    if (cut === "actor") f.pause.requestedBy = "other";
    if (cut === "run") f.pause.runId = "other-run";
    if (cut === "policy") f.original.authority.policy.objectiveTimeoutMinutes = 46;
    if (cut === "uncertain") f.original.actions[2]!.returnedAt = "";
    if (cut === "already-resumed")
      f.original.actions.push({ ...f.original.actions[0]!, action: "resume" });
    if (cut === "late-witness") f.witness.reachedAt = "2026-09-07T05:09:00.000Z";
    expect(() =>
      assertContinuationSeed(
        f.original,
        f.witness,
        f.pause,
        { inventorySha256: "f".repeat(64) },
        f.now,
      ),
    ).toThrow();
  });
  it("rejects unresolved original invocation markers rather than treating their zero as measured usage", () => {
    const f = fixture();
    f.observation.receipts = f.observation.receipts.filter(
      ({ event }) =>
        !(event.event === "BudgetReconciled" && "workItem" in event && event.workItem === 8),
    );
    expect(() =>
      assertContinuationObservation(f.observation, f.original, f.witness, f.pause, f.now),
    ).toThrow(/unknown model/);
  });
  it("refuses crossed validation and terminal stages before any lifecycle call", async () => {
    const f = fixture();
    f.observation.receipts.push({
      event: { ...f.observation.receipts[3]!.event, event: "AttemptCancelled" },
    });
    const action = vi.fn(),
      preflight = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(f.now);
    try {
      await expect(
        runCheckpointContinuation(
          { preflight, observe: async () => f.observation, action },
          f.original.authority,
          { ...f, artifact: f.original.artifact },
        ),
      ).rejects.toThrow();
      expect(action).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("records actual failed service state only with original identity and physical absence", () => {
    const f = fixture();
    const fields = {
      Id: f.controller.unit,
      LoadState: "loaded",
      ActiveState: "failed",
      SubState: "failed",
      MainPID: "0",
      Job: "",
      ControlGroup: "",
      InvocationID: f.controller.invocationId,
      ExecMainPID: "100",
      KillMode: "control-group",
      DropInPaths: "",
      NeedDaemonReload: "no",
    };
    expect(
      assertStoppedContinuationController(fields, f.controller, f.controller.configDigest, true),
    ).toMatchObject({ ActiveState: "failed", originalProcessAbsent: true });
    for (const changed of [
      { MainPID: "101" },
      { InvocationID: "b".repeat(32) },
      { Job: "42/start" },
      { ActiveState: "activating" },
    ])
      expect(() =>
        assertStoppedContinuationController(
          { ...fields, ...changed },
          f.controller,
          f.controller.configDigest,
          true,
        ),
      ).toThrow();
    expect(() =>
      assertStoppedContinuationController(fields, f.controller, f.controller.configDigest, false),
    ).toThrow();
  });
});
