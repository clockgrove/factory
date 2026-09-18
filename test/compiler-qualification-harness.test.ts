import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkpointAuthority,
  main as genericCheckpointMain,
} from "../scripts/verify-local-checkpoint-restart.mjs";
import {
  assertCompilerSelectionHold,
  assertGraphProjectionHold,
  assertCompilerQualificationDefaults,
  assertCompilerQualificationPnpmRuntime,
  compilerCheckpointArm,
  compilerCheckpointExtension,
  compilerCheckpointAuthority,
  compilerCheckpointPath,
  compilerQualificationObjectiveBody,
  runCompilerCheckpointScenario,
} from "../scripts/verify-compiler-qualification-checkpoints.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("recovery identity requires JSON data");
};
const recoveryReceiptDigest = (event: unknown) => hash(canonical(event));
function pnpmRuntimeStatus(
  overrides: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const receipt = {
    protocol: "clockgrove.factory/toolchain-runtime-bundle-v1",
    tool: "pnpm",
    adapter: "node-pnpm",
    adapterContract: 1,
    platform: { os: "linux", architecture: "x64", libc: "glibc" },
    components: [
      { id: "node", version: "22.14.0" },
      { id: "pnpm", version: "10.34.5" },
    ],
    resolvedAt: "2026-09-18T01:02:03.000Z",
    ...overrides,
  };
  const { resolvedAt: _resolvedAt, ...identity } = receipt;
  return [
    { tool: "pnpm", state: "ready", receipt: { ...receipt, digest: hash(canonical(identity)) } },
  ];
}
const repository = "example/compiler-checkpoint-fixture";
const checkout = "/home/example/compiler-checkpoint-fixture";
const unit = `clockgrove-factory-${hash(`${repository}\0${resolve(checkout)}`).slice(0, 16)}.service`;
const policy = {
  objectiveTimeoutMinutes: 45,
  workItemTimeoutMinutes: 10,
  compilerEvaluation: {
    mode: "auto-repair" as const,
    maxRepairs: 2,
    maxInvocations: 7,
    timeoutSeconds: 600,
    maxObservedTokens: 500_000,
  },
};
const authority = {
  repository,
  checkout,
  unit,
  phase: "exercise",
  namespace: "compiler-case",
  evidence: "/home/example/compiler-checkpoint.json",
  policy,
  compilerRecovery: true,
  compilerMaxModelTokens: 500_000,
};
const artifact = {
  version: "2.0.27-beta.0",
  inventorySha256: "1".repeat(64),
  bundles: [
    { file: "factory.js", bytes: 100, sha256: "2".repeat(64) },
    { file: "mcp-server.js", bytes: 100, sha256: "3".repeat(64) },
  ],
};
const original = {
  unit,
  state: "active",
  pid: 101,
  startTicks: "1001",
  invocationId: "a".repeat(32),
  hostIdentity: "b".repeat(64),
  configDigest: "c".repeat(64),
};
const projectionController = {
  ...original,
  pid: 102,
  startTicks: "1002",
  invocationId: "d".repeat(32),
};
const pausedController = {
  ...original,
  pid: 103,
  startTicks: "1003",
  invocationId: "e".repeat(32),
};
const objective = 47;
const baseSha = "4".repeat(40);
const actualRunId = "9d69ce85-6810-41d8-af62-1fab153d4574";
const fixtureStartedAt = new Date(Date.now() - 120_000).toISOString();
const fixtureEligibleUntil = new Date(Date.parse(fixtureStartedAt) + 45 * 60_000).toISOString();
function arm(checkpoint: "compiler-selection" | "graph-projection") {
  return compilerCheckpointArm(authority, original, artifact, objective, baseSha, checkpoint);
}

function startEvent(policyDigest = arm("compiler-selection").policyDigest) {
  return {
    kind: "run",
    event: "FactoryRunStarted",
    sequence: 0,
    objective,
    runId: actualRunId,
    activationRequestId: "compiler-case-activate",
    policyDigest,
    policy,
    repository,
    baseSha,
    at: fixtureStartedAt,
  };
}

const stages = ["inventory", "compile", "judge"];
function compilerInvocations() {
  return stages.map((stage, index) => ({
    invocationId: `compiler-${stage}`,
    stage,
    revision: 0,
    state: "completed",
    inputTokens: 5,
    outputTokens: 5 + index,
    cachedInputTokens: 0,
    observedTokens: 10 + index,
    observedMilliseconds: 100 + index,
  }));
}

function compilerStatus() {
  return {
    availability: "observed",
    policy: policy.compilerEvaluation,
    invocations: compilerInvocations(),
    cumulativeUsage: {
      inputTokens: 15,
      outputTokens: 18,
      cachedInputTokens: 0,
      observedTokens: 33,
      complete: true,
    },
  };
}

function accountingEvents() {
  return stages.flatMap((stage, index) => {
    const invocationId = `compiler-${stage}`;
    return [
      {
        kind: "budget",
        event: "BudgetReserved",
        sequence: index * 2 + 1,
        objective,
        runId: actualRunId,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        policyDigest: arm("compiler-selection").policyDigest,
      },
      {
        kind: "budget",
        event: "BudgetReconciled",
        sequence: index * 2 + 2,
        objective,
        runId: actualRunId,
        phase: "management",
        unit: "model_tokens",
        amount: 10 + index,
        usageId: `draft-${invocationId}`,
        modelInvocationId: invocationId,
        policyDigest: arm("compiler-selection").policyDigest,
      },
    ];
  });
}

function selectionWitness() {
  const selected = arm("compiler-selection");
  const reachedAt = new Date(Date.now() - 60_000);
  return {
    ...selected,
    protocol: "clockgrove.factory/compiler-qualification-checkpoint-reached",
    runId: actualRunId,
    armDigest: hash(JSON.stringify(selected)),
    controllerInvocationId: original.invocationId,
    hostIdentity: original.hostIdentity,
    producerPid: original.pid,
    producerStartTicks: original.startTicks,
    proof: {
      checkpoint: "compiler-selection",
      journalDigest: "5".repeat(64),
      selectionSequence: 9,
      revision: 0,
      graphDigest: "6".repeat(64),
      graphAbsent: true,
      usage: stages.map((stage, index) => ({
        invocationId: `compiler-${stage}`,
        stage,
        revision: 0,
        amount: 10 + index,
        reservationSequence: index * 2 + 1,
        reconciliationSequence: index * 2 + 2,
      })),
    },
    startedAt: fixtureStartedAt,
    eligibleUntil: fixtureEligibleUntil,
    reachedAt: reachedAt.toISOString(),
    holdUntil: new Date(reachedAt.getTime() + 10 * 60_000).toISOString(),
  };
}

const graphRef = "refs/clockgrove-factory/graphs/objective-47/run-fixture";
const graphBlobSha = "8".repeat(40);
const projectionRef = "refs/clockgrove-factory/graph-projections/objective-47/run-fixture";
const projectionBlobSha = "b".repeat(40);
function graphEvents(workItemNumbers = [48, 49, 50, 51]) {
  return [
    {
      protocol: "clockgrove.factory/v2",
      kind: "graph",
      event: "GraphCompiled",
      sequence: 10,
      at: fixtureStartedAt,
      objective,
      runId: actualRunId,
      graphDigest: "6".repeat(64),
      graphSize: workItemNumbers.length,
      baseSha,
      graphRef,
      graphBlobSha,
    },
    {
      protocol: "clockgrove.factory/v2",
      kind: "graph",
      event: "GraphProjected",
      sequence: 11,
      at: fixtureStartedAt,
      objective,
      runId: actualRunId,
      graphDigest: "6".repeat(64),
      graphSize: workItemNumbers.length,
      projectionRef,
      projectionBlobSha,
    },
  ];
}

function projectionWitness(workItemNumbers = [48, 49, 50, 51]) {
  const projected = arm("graph-projection");
  const reachedAt = new Date(Date.now() - 30_000);
  const [compiledReceipt, projectedReceipt] = graphEvents(workItemNumbers);
  return {
    ...projected,
    protocol: "clockgrove.factory/compiler-qualification-checkpoint-reached",
    runId: actualRunId,
    armDigest: hash(JSON.stringify(projected)),
    controllerInvocationId: projectionController.invocationId,
    hostIdentity: projectionController.hostIdentity,
    producerPid: projectionController.pid,
    producerStartTicks: projectionController.startTicks,
    proof: {
      checkpoint: "graph-projection",
      graphDigest: "6".repeat(64),
      graphSize: workItemNumbers.length,
      graphRef,
      graphCommitOid: "7".repeat(40),
      graphBlobSha,
      graphReceiptDigest: recoveryReceiptDigest(compiledReceipt),
      projectionRef,
      projectionCommitOid: "a".repeat(40),
      projectionBlobSha,
      projectionReceiptDigest: recoveryReceiptDigest(projectedReceipt),
      bindingsDigest: "d".repeat(64),
      workItemNumbers,
      attemptReservations: 0,
      capacityReservations: 0,
    },
    startedAt: fixtureStartedAt,
    eligibleUntil: fixtureEligibleUntil,
    reachedAt: reachedAt.toISOString(),
    holdUntil: new Date(reachedAt.getTime() + 10 * 60_000).toISOString(),
  };
}

function selectionObservation() {
  return {
    receipts: [startEvent(), ...accountingEvents()].map((event) => ({ event })),
    status: {
      run: { runId: actualRunId, state: "running" },
      compilerEvaluation: compilerStatus(),
    },
    children: [],
    compilerCheckpoints: { "compiler-selection": selectionWitness() },
  };
}

function projectedObservation(
  paused = false,
  acknowledged = false,
  workItemNumbers = [48, 49, 50, 51],
) {
  const graph = graphEvents(workItemNumbers);
  const commands = paused
    ? [
        {
          kind: "run",
          event: "RunPauseRequested",
          sequence: 12,
          objective,
          runId: actualRunId,
          requestId: "compiler-case-pause",
        },
        ...(acknowledged
          ? [
              {
                kind: "run",
                event: "RunPauseAcknowledged",
                sequence: 13,
                objective,
                runId: actualRunId,
                commandRequestId: "compiler-case-pause",
              },
            ]
          : []),
      ]
    : [];
  return {
    receipts: [...[startEvent(), ...accountingEvents(), ...graph, ...commands]].map((event) => ({
      event,
    })),
    status: {
      run: {
        runId: actualRunId,
        state: acknowledged ? "paused" : "running",
      },
      compilerEvaluation: compilerStatus(),
    },
    children: workItemNumbers.map((number) => ({ number, state: "open" })),
    compilerCheckpoints: { "graph-projection": projectionWitness(workItemNumbers) },
  };
}

describe("installed compiler checkpoint qualifier", () => {
  it("requires the compiler entrypoint before generic harness effects", async () => {
    expect(() => checkpointAuthority({ FACTORY_CHECKPOINT_BACKEND: "compiler" })).toThrow(
      "compiler checkpoint mode requires scripts/verify-compiler-qualification-checkpoints.mjs",
    );
    const env = {
      FACTORY_LOCAL_CHECKPOINT_RESTART: "1",
      FACTORY_CHECKPOINT_REPOSITORY: repository,
      FACTORY_CHECKPOINT_CHECKOUT: checkout,
      FACTORY_CHECKPOINT_CONTROLLER_UNIT: unit,
      FACTORY_CHECKPOINT_PHASE: "exercise",
      FACTORY_CHECKPOINT_BACKEND: "compiler",
      FACTORY_CHECKPOINT_NAMESPACE: "compiler-case",
      FACTORY_CHECKPOINT_EVIDENCE: "/home/example/compiler-checkpoint.json",
      FACTORY_CHECKPOINT_MAX_MODEL_TOKENS: "500000",
      FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,arm-compiler-selection,arm-graph-projection,restart,pause,restart,stop`,
    };
    expect(() => checkpointAuthority(env)).toThrow(
      "compiler checkpoint mode requires scripts/verify-compiler-qualification-checkpoints.mjs",
    );
    const runner = vi.fn();
    await expect(genericCheckpointMain(env, runner)).rejects.toThrow(
      "compiler checkpoint mode requires scripts/verify-compiler-qualification-checkpoints.mjs",
    );
    expect(runner).not.toHaveBeenCalled();
    expect(compilerCheckpointAuthority(env)).toMatchObject({
      compilerRecovery: true,
      unit,
      observationWindowMinutes: 45,
      compilerMaxModelTokens: 500_000,
    });
    expect(compilerCheckpointAuthority(env)).not.toHaveProperty("policy");
    expect(
      compilerCheckpointAuthority({ ...env, FACTORY_CHECKPOINT_MAX_MODEL_TOKENS: "250000" }),
    ).toMatchObject({ compilerMaxModelTokens: 250_000 });
    expect(() =>
      compilerCheckpointAuthority({ ...env, FACTORY_CHECKPOINT_ACK: "incomplete" }),
    ).toThrow();
  });

  it("requires the exact documented compiler defaults within the authorized ceiling", () => {
    expect(assertCompilerQualificationDefaults(policy, 500_000)).toBe(policy);
    expect(() => assertCompilerQualificationDefaults(policy, 250_000)).toThrow(
      "installed compiler defaults differ from the documented authorized envelope",
    );
    expect(() =>
      assertCompilerQualificationDefaults(
        {
          ...policy,
          compilerEvaluation: { ...policy.compilerEvaluation, maxInvocations: 6 },
        },
        500_000,
      ),
    ).toThrow("installed compiler defaults differ from the documented authorized envelope");
    const incomplete = structuredClone(policy) as Record<string, unknown> & {
      compilerEvaluation: Record<string, unknown>;
    };
    delete incomplete.compilerEvaluation.timeoutSeconds;
    expect(() => assertCompilerQualificationDefaults(incomplete, 500_000)).toThrow(
      "installed compiler defaults differ from the documented authorized envelope",
    );
  });

  it("requires the exact ready pnpm adapter before compiler qualification", () => {
    expect(assertCompilerQualificationPnpmRuntime(pnpmRuntimeStatus())).toEqual({
      tool: "pnpm",
      adapter: "node-pnpm",
      adapterContract: 1,
      platform: { os: "linux", architecture: "x64", libc: "glibc" },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      components: [
        { id: "node", version: "22.14.0" },
        { id: "pnpm", version: "10.34.5" },
      ],
    });
    for (const state of ["missing", "corrupt"]) {
      expect(() => assertCompilerQualificationPnpmRuntime([{ tool: "pnpm", state }])).toThrow(
        "compiler qualification requires a ready integrity-verified pnpm managed runtime",
      );
    }
    expect(() =>
      assertCompilerQualificationPnpmRuntime(pnpmRuntimeStatus({ adapter: "javascript-pnpm" })),
    ).toThrow();
    expect(() =>
      assertCompilerQualificationPnpmRuntime(
        pnpmRuntimeStatus({ platform: { os: "linux", architecture: "arm64", libc: "glibc" } }),
      ),
    ).toThrow();
  });

  it("checks installed pnpm before the compiler fixture can create an Objective", () => {
    const evidence: Record<string, unknown> = {};
    const save = vi.fn();
    const command = vi.fn(() => JSON.stringify(pnpmRuntimeStatus()));
    compilerCheckpointExtension(authority).preflight?.({
      authority,
      evidence,
      command,
      installedFactoryCli: "/installed/factory.js",
      save,
    });
    expect(command).toHaveBeenCalledWith(
      process.execPath,
      ["/installed/factory.js", "toolchains", "status"],
      checkout,
    );
    expect(evidence.compilerRuntime).toMatchObject({
      tool: "pnpm",
      adapter: "node-pnpm",
      adapterContract: 1,
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("raises only the compiler fixture's shared observation bound to four", () => {
    expect(compilerCheckpointExtension(authority)).toMatchObject({
      omitActivationPolicy: true,
      maxObservedChildren: 4,
    });
  });

  it("binds arm paths to activation and checkpoint kind before the run exists", () => {
    const selected = arm("compiler-selection");
    const projected = arm("graph-projection");
    expect(selected.bundleIdentity).toBe(`sha256:${"2".repeat(64)}`);
    expect(selected).not.toHaveProperty("runId");
    expect(compilerCheckpointPath(selected)).not.toBe(compilerCheckpointPath(projected));
    expect(compilerCheckpointPath(selected)).not.toBe(
      compilerCheckpointPath({ ...selected, activationRequestId: "another-activation" }),
    );
  });

  it("retains one pnpm provider and three horizontal safety descendants", () => {
    const body = compilerQualificationObjectiveBody(authority);
    expect(body).toContain("clockgrove-factory:qualification-namespace=compiler-case");
    expect(body).toContain("Compile exactly four Work Items");
    expect(body).toContain("the only bootstrap provider");
    expect(body).toContain("all depend directly on the bootstrap provider");
    expect(body).toContain("never lets a late task settlement replace the first terminal result");
    expect(body).toContain("pnpm run test:deadline");
    expect(body).not.toContain("Do not modify package.json");
  });

  it("rejects graph or worker admission at selection and scheduling admission at projection", () => {
    const selected = selectionObservation();
    expect(
      assertCompilerSelectionHold(
        selected,
        authority,
        { arm: arm("compiler-selection") },
        original,
      ),
    ).toBe(true);
    selected.receipts.push({
      event: projectedObservation().receipts.at(-1)!.event,
    } as unknown as (typeof selected.receipts)[number]);
    expect(() =>
      assertCompilerSelectionHold(
        selected,
        authority,
        { arm: arm("compiler-selection") },
        original,
      ),
    ).toThrow();
    const foreignRun = selectionObservation();
    foreignRun.compilerCheckpoints["compiler-selection"].runId =
      "1ca6b1cf-8368-4c8a-9326-32ad468b6bf7";
    expect(() =>
      assertCompilerSelectionHold(
        foreignRun,
        authority,
        { arm: arm("compiler-selection") },
        original,
      ),
    ).toThrow();
    expect(
      assertGraphProjectionHold(
        projectedObservation(),
        authority,
        { arm: arm("graph-projection") },
        projectionController,
      ),
    ).toBe(true);
    expect(() =>
      assertGraphProjectionHold(
        projectedObservation(false, false, [48, 49, 50]),
        authority,
        { arm: arm("graph-projection") },
        projectionController,
      ),
    ).toThrow("compiler qualification graph must contain four items");
  });

  it("keeps incomplete exact graph projection evidence pending", () => {
    const withoutProjectedReceipt = projectedObservation();
    withoutProjectedReceipt.receipts = withoutProjectedReceipt.receipts.filter(
      ({ event }) => event.event !== "GraphProjected",
    );
    expect(
      assertGraphProjectionHold(
        withoutProjectedReceipt,
        authority,
        { arm: arm("graph-projection") },
        projectionController,
      ),
    ).toBe(false);

    const withoutAllChildren = projectedObservation();
    withoutAllChildren.children.pop();
    expect(
      assertGraphProjectionHold(
        withoutAllChildren,
        authority,
        { arm: arm("graph-projection") },
        projectionController,
      ),
    ).toBe(false);

    expect(
      assertGraphProjectionHold(
        projectedObservation(),
        authority,
        { arm: arm("graph-projection") },
        projectionController,
      ),
    ).toBe(true);
  });

  it("fails closed on contradictory graph projection evidence while receipts are incomplete", () => {
    const withoutProjectedReceipt = () => {
      const observation = projectedObservation();
      observation.receipts = observation.receipts.filter(
        ({ event }) => event.event !== "GraphProjected",
      );
      return observation;
    };
    const assertHold = (observation: ReturnType<typeof projectedObservation>) =>
      assertGraphProjectionHold(
        observation,
        authority,
        { arm: arm("graph-projection") },
        projectionController,
      );

    const duplicateCompiled = withoutProjectedReceipt();
    duplicateCompiled.receipts.push(
      structuredClone(
        duplicateCompiled.receipts.find(({ event }) => event.event === "GraphCompiled")!,
      ),
    );
    expect(() => assertHold(duplicateCompiled)).toThrow(
      "one exact compiled graph receipt required",
    );

    const duplicateProjected = projectedObservation();
    duplicateProjected.receipts = duplicateProjected.receipts.filter(
      ({ event }) => event.event !== "GraphCompiled",
    );
    duplicateProjected.receipts.push(
      structuredClone(
        duplicateProjected.receipts.find(({ event }) => event.event === "GraphProjected")!,
      ),
    );
    expect(() => assertHold(duplicateProjected)).toThrow(
      "one exact projected graph receipt required",
    );

    const changedDigest = withoutProjectedReceipt();
    Object.assign(
      changedDigest.receipts.find(({ event }) => event.event === "GraphCompiled")!.event,
      { graphDigest: "f".repeat(64) },
    );
    expect(() => assertHold(changedDigest)).toThrow();

    const changedRun = withoutProjectedReceipt();
    Object.assign(changedRun.receipts.find(({ event }) => event.event === "GraphCompiled")!.event, {
      runId: "1ca6b1cf-8368-4c8a-9326-32ad468b6bf7",
    });
    expect(() => assertHold(changedRun)).toThrow();

    for (const mutation of [{ baseSha: "f".repeat(40) }, { kind: "run" }, { sequence: 12 }]) {
      const changedCompiledEnvelope = withoutProjectedReceipt();
      Object.assign(
        changedCompiledEnvelope.receipts.find(({ event }) => event.event === "GraphCompiled")!
          .event,
        mutation,
      );
      expect(() => assertHold(changedCompiledEnvelope)).toThrow(
        "compiled graph receipt digest differs",
      );
    }

    const changedProjectedEnvelope = projectedObservation();
    changedProjectedEnvelope.receipts = changedProjectedEnvelope.receipts.filter(
      ({ event }) => event.event !== "GraphCompiled",
    );
    Object.assign(
      changedProjectedEnvelope.receipts.find(({ event }) => event.event === "GraphProjected")!
        .event,
      { at: new Date(Date.parse(fixtureStartedAt) + 1).toISOString() },
    );
    expect(() => assertHold(changedProjectedEnvelope)).toThrow(
      "projected graph receipt digest differs",
    );

    const foreignChild = withoutProjectedReceipt();
    foreignChild.children[0]!.number = 999;
    expect(() => assertHold(foreignChild)).toThrow(
      "compiler projection contains a foreign Work Item",
    );

    const extraChild = withoutProjectedReceipt();
    extraChild.children.push({ number: 999, state: "open" });
    expect(() => assertHold(extraChild)).toThrow("compiler projection contains extra Work Items");

    const scheduled = withoutProjectedReceipt();
    scheduled.receipts.push({
      event: {
        kind: "attempt",
        event: "AttemptReserved",
        sequence: 12,
        objective,
        runId: actualRunId,
      },
    } as unknown as (typeof scheduled.receipts)[number]);
    expect(() => assertHold(scheduled)).toThrow();

    const reservedWitness = withoutProjectedReceipt();
    reservedWitness.compilerCheckpoints["graph-projection"].proof.attemptReservations = 1;
    expect(() => assertHold(reservedWitness)).toThrow();
  });

  it("orchestrates restart adoption, durable pause, zero admission, and final stop", async () => {
    const actions: string[] = [];
    let graphProjectionObservations = 0;
    const controllers = [original, projectionController, pausedController];
    const observations = {
      "compiler-selection-hold": selectionObservation(),
      "graph-projection-hold": projectedObservation(),
      "graph-projection-pause": projectedObservation(true),
      "projected-paused-restart": projectedObservation(true, true),
    };
    const port = {
      pauseRequestId: "compiler-case-pause",
      preflight: async () => ({ state: "inactive" }),
      action: async (action: string) => {
        actions.push(action);
      },
      controller: async (state: string) =>
        state === "inactive" ? { unit, state: "inactive" } : controllers.shift()!,
      armCompilerCheckpoints: async () => ({
        "compiler-selection": { arm: arm("compiler-selection") },
        "graph-projection": { arm: arm("graph-projection") },
      }),
      restart: async (boundary: string) => {
        actions.push(`restart-${boundary}`);
      },
      assertDefaultPolicyActivation: async () => {},
      poll: async (phase: keyof typeof observations, accept: (value: unknown) => boolean) => {
        const observation = observations[phase];
        if (phase === "graph-projection-hold") {
          const incomplete = structuredClone(observation);
          incomplete.receipts = incomplete.receipts.filter(
            ({ event }) => event.event !== "GraphProjected",
          );
          graphProjectionObservations += 1;
          expect(accept(incomplete)).toBe(false);
          expect(actions).not.toContain("pause");
        }
        graphProjectionObservations += phase === "graph-projection-hold" ? 1 : 0;
        expect(accept(observation)).toBe(true);
        return observation;
      },
    };
    await expect(runCompilerCheckpointScenario(port, authority)).resolves.toMatchObject({
      result: "passed",
      scope: "installed-compiler-qualification-checkpoints",
      runId: actualRunId,
    });
    expect(actions).toEqual([
      "start",
      "create",
      "activate",
      "restart-selection",
      "pause",
      "restart-projection",
      "stop",
    ]);
    expect(graphProjectionObservations).toBe(2);
  });

  it("rejects an extra compiler invocation and accounting pair after restart", async () => {
    const actions: string[] = [];
    const controllers = [original, projectionController, pausedController];
    const duplicated = projectedObservation();
    duplicated.status.compilerEvaluation.invocations.push({
      invocationId: "compiler-duplicate",
      stage: "repair",
      revision: 1,
      state: "completed",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      observedTokens: 2,
      observedMilliseconds: 20,
    });
    duplicated.receipts.push(
      {
        event: {
          kind: "budget",
          event: "BudgetReserved",
          sequence: 14,
          objective,
          runId: actualRunId,
          phase: "management",
          unit: "model_tokens",
          amount: 0,
          usageId: "invocation-compiler-duplicate",
          modelInvocationId: "compiler-duplicate",
          policyDigest: arm("compiler-selection").policyDigest,
        },
      } as unknown as (typeof duplicated.receipts)[number],
      {
        event: {
          kind: "budget",
          event: "BudgetReconciled",
          sequence: 15,
          objective,
          runId: actualRunId,
          phase: "management",
          unit: "model_tokens",
          amount: 2,
          usageId: "draft-compiler-duplicate",
          modelInvocationId: "compiler-duplicate",
          policyDigest: arm("compiler-selection").policyDigest,
        },
      } as unknown as (typeof duplicated.receipts)[number],
    );
    const observations = {
      "compiler-selection-hold": selectionObservation(),
      "graph-projection-hold": duplicated,
      "graph-projection-pause": projectedObservation(true),
      "projected-paused-restart": projectedObservation(true, true),
    };
    const port = {
      pauseRequestId: "compiler-case-pause",
      preflight: async () => ({ state: "inactive" }),
      action: async (action: string) => actions.push(action),
      controller: async (state: string) =>
        state === "inactive" ? { unit, state: "inactive" } : controllers.shift()!,
      armCompilerCheckpoints: async () => ({
        "compiler-selection": { arm: arm("compiler-selection") },
        "graph-projection": { arm: arm("graph-projection") },
      }),
      restart: async () => {},
      assertDefaultPolicyActivation: async () => {},
      poll: async (phase: keyof typeof observations, accept: (value: unknown) => boolean) => {
        const observation = observations[phase];
        expect(accept(observation)).toBe(true);
        return observation;
      },
    };
    await expect(runCompilerCheckpointScenario(port, authority)).rejects.toThrow(
      "compiler accounting changed after restart",
    );
  });
});
