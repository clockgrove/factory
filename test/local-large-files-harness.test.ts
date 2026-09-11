import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import {
  discoverValidationCommands,
  isGroundedValidationCommand,
} from "../src/repository-profiles/index.js";
import {
  largeFileAuthority,
  largeFileTransferArm,
  transferArmPath,
  transferHoldReady,
  runLargeFileScenario,
  largeFileExtension,
  main,
} from "../scripts/verify-local-large-files.mjs";
import {
  LARGE_FILE_RECIPE_VERSION,
  LARGE_FILE_VALIDATION_COMMAND,
  LARGE_FILE_VALIDATION_SCRIPT,
  createLargeFileFixture,
} from "../scripts/qualification-large-files.mjs";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sourceRepository = fileURLToPath(new URL("..", import.meta.url));
const sourceBaseSha = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
  cwd: sourceRepository,
  encoding: "utf8",
}).trim();
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
function fixture(parent: string) {
  return createLargeFileFixture({
    parent,
    namespace: authority.namespace,
    sourceRepository,
    baseSha: sourceBaseSha,
  });
}
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
  const modelIntent = (phase: string, modelInvocationId: string, item = {}) => {
    add("BudgetReserved", "budget", {
      ...item,
      phase,
      unit: "model_tokens",
      modelInvocationId,
      usageId: `invocation-${modelInvocationId}`,
      amount: 0,
    });
  };
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
  modelIntent("management", `compile-${policyDigest}`);
  add("GraphCompiled", "graph");
  add("GraphProjected", "graph", { graphSize: 3 });
  add("BudgetReconciled", "budget", {
    phase: "management",
    unit: "model_tokens",
    modelInvocationId: `compile-${policyDigest}`,
    usageId: `compile-${policyDigest}`,
    amount: 100,
  });
  const reserve = (workItem: number) => {
    add("AttemptReserved", "attempt", {
      workItem,
      attempt: 1,
      backend: "codex-app-server/local-worktree",
    });
    modelIntent("execution", `worker-${workItem}-1`, { workItem, attempt: 1 });
    add("AttemptStarted", "attempt", { workItem, attempt: 1 });
    add("BudgetReconciled", "budget", {
      workItem,
      attempt: 1,
      phase: "execution",
      unit: "model_tokens",
      modelInvocationId: `worker-${workItem}-1`,
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
    const reviewId = `review-${hash(`artifact-${workItem}`)}`;
    modelIntent("management", reviewId, item);
    add("BudgetReconciled", "budget", {
      ...item,
      phase: "management",
      unit: "model_tokens",
      usageId: reviewId,
      modelInvocationId: reviewId,
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
      const prepared = fixture(parent);
      const path = join(prepared.root, "fixture.json");
      const extension = largeFileExtension({
        ...authority,
        largeFile: {
          ...authority.largeFile,
          fixture: path,
          fixtureDigest: hash(readFileSync(path, "utf8")),
        },
      });
      expect(extension.harnessPaths).toContain("scripts/qualification-reservation-authority.mjs");
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
  }, 30_000);
  it("grounds every generated artifact scenario in the matching Vitest fixture recipe", () => {
    const parent = mkdtempSync(join(tmpdir(), "factory-large-file-objective-test-"));
    try {
      const fixture = createLargeFileFixture({
        parent,
        namespace: authority.namespace,
        sourceRepository,
        baseSha: sourceBaseSha,
      });
      const descriptor = join(fixture.root, "fixture.json");
      const packageJson = JSON.parse(
        execFileSync("/usr/bin/git", ["cat-file", "blob", `${fixture.baseSha}:package.json`], {
          cwd: fixture.repository,
          encoding: "utf8",
        }),
      );
      const sourcePackage = execFileSync(
        "/usr/bin/git",
        ["cat-file", "blob", `${fixture.sourceBaseSha}:package.json`],
        { cwd: fixture.repository },
      );
      const fixturePackage = execFileSync(
        "/usr/bin/git",
        ["cat-file", "blob", `${fixture.baseSha}:package.json`],
        { cwd: fixture.repository },
      );
      const repositoryFacts = {
        files: [{ path: "package.json" }, ...fixture.baseline.map(({ path }) => ({ path }))],
        scripts: packageJson.scripts,
      };
      expect(fixture.version).toBe(LARGE_FILE_RECIPE_VERSION);
      expect(fixture.sourceBaseSha).toBe(sourceBaseSha);
      expect(packageJson.scripts.test).toBe("vitest run");
      expect(fixture.validation).toEqual({
        command: LARGE_FILE_VALIDATION_COMMAND,
        script: LARGE_FILE_VALIDATION_SCRIPT,
        recipe: `vitest run ${fixture.paths.test}`,
        packagePath: "package.json",
        sourcePackageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(hash(sourcePackage)).toBe(fixture.validation!.sourcePackageDigest);
      expect(hash(fixturePackage)).toBe(fixture.validation!.packageDigest);
      expect(packageJson.scripts[LARGE_FILE_VALIDATION_SCRIPT]).toBe(
        `vitest run ${fixture.paths.test}`,
      );
      expect(packageJson.scripts[LARGE_FILE_VALIDATION_SCRIPT].split(" ")).toEqual([
        "vitest",
        "run",
        fixture.paths.test,
      ]);
      expect(
        execFileSync(
          "/usr/bin/git",
          ["diff", "--name-only", fixture.sourceBaseSha!, fixture.baseSha],
          { cwd: fixture.repository, encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .sort(),
      ).toEqual(["package.json", ...fixture.baseline.map(({ path }) => path)].sort());
      const fixtureTest = readFileSync(join(fixture.repository, fixture.paths.test), "utf8");
      expect(fixtureTest).toContain('from "vitest"');
      expect(fixtureTest).not.toContain('from "node:test"');
      expect(discoverValidationCommands(repositoryFacts)).toContain(LARGE_FILE_VALIDATION_COMMAND);
      expect(
        isGroundedValidationCommand(LARGE_FILE_VALIDATION_COMMAND, repositoryFacts, [
          fixture.paths.prefix + "/",
        ]),
      ).toBe(true);
      for (const scenario of [
        "transfer-restart",
        "lfs-missing-tool",
        "lfs-missing-object",
        "scope",
        "secret",
        "symlink",
      ] as const) {
        const scenarioAuthority = {
          ...authority,
          largeFile: {
            scenario,
            fixture: descriptor,
            fixtureDigest: hash(readFileSync(descriptor, "utf8")),
          },
        };
        const { objectiveBody } = largeFileExtension(scenarioAuthority);
        assert.ok(objectiveBody, "large-file extension must author its Objective");
        const body = objectiveBody(scenarioAuthority);
        expect(body).toContain(LARGE_FILE_VALIDATION_COMMAND);
        expect(body).not.toContain("node --test");
      }
      const preflightAuthority = {
        ...authority,
        checkout: fixture.repository,
        largeFile: {
          ...authority.largeFile,
          fixture: descriptor,
          fixtureDigest: hash(readFileSync(descriptor)),
        },
      };
      const evidence = { sourceCommit: sourceBaseSha, base: fixture.baseSha };
      const save = vi.fn();
      const extension = largeFileExtension(preflightAuthority);
      assert.ok(extension.preflight);
      extension.preflight({
        authority: preflightAuthority,
        evidence,
        save,
        command(name: string, args: string[], cwd: string) {
          return execFileSync(name, args, { cwd, encoding: "utf8" }).trim();
        },
      });
      expect(evidence).toMatchObject({ largeFileStage: "preflight-complete" });
      expect(save).toHaveBeenCalledOnce();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);
  it("rejects a standalone fixture before authoring an ungrounded Objective", () => {
    const parent = mkdtempSync(join(tmpdir(), "factory-large-file-standalone-test-"));
    try {
      const standalone = createLargeFileFixture({ parent, namespace: authority.namespace });
      const descriptor = join(standalone.root, "fixture.json");
      const standaloneAuthority = {
        ...authority,
        largeFile: {
          ...authority.largeFile,
          fixture: descriptor,
          fixtureDigest: hash(readFileSync(descriptor, "utf8")),
        },
      };
      const { objectiveBody } = largeFileExtension(standaloneAuthority);
      assert.ok(objectiveBody, "large-file extension must author its Objective");
      expect(() => objectiveBody(standaloneAuthority)).toThrow();
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
    expect(parseRunPolicy(authority.policy).maxAttemptsPerItem).toBe(1);
  });
  it.each([
    "transfer-restart",
    "lfs-missing-tool",
    "lfs-missing-object",
    "scope",
    "secret",
    "symlink",
  ])(
    "prospectively forbids replacement execution for %s without waiting for the observer",
    (scenario) => {
      const accepted = largeFileAuthority({
        ...env,
        FACTORY_LARGE_FILE_CASE: scenario,
        FACTORY_LARGE_FILE_PHASE: "preflight",
      })!;
      expect(parseRunPolicy(accepted.policy).maxAttemptsPerItem).toBe(1);
      expect(accepted.policy.economics).toEqual(authority.policy.economics);
    },
  );
  it("never mutates during preflight", async () => {
    const f = scenario();
    expect(
      await runLargeFileScenario(f.port as never, { ...authority, phase: "preflight" }),
    ).toMatchObject({ result: "preflight-only" });
    expect(f.actions).toEqual([]);
    expect(f.port.armTransfer).not.toHaveBeenCalled();
  });
  it("pins the one-shot transfer fault to exact activation, base and producer", () => {
    const arm = largeFileTransferArm(authority, original, 7, baseSha);
    expect(arm).toMatchObject({
      repository,
      objective: 7,
      baseSha,
      unit,
      activationRequestId: `${authority.namespace}-activate`,
      invocationId: original.invocationId,
      minPayloadBytes: 5242881,
      eligibilityDurationMs: 45 * 60_000,
      holdDurationMs: 600_000,
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
