import { describe, expect, it, vi } from "vitest";
import {
  assertBudgetStopCompletion,
  assessBudgetStopObservation,
  budgetStopAuthority,
  budgetStopPolicy,
  main,
  observeBudgetStopThenCancel,
} from "../scripts/verify-budget-stop.mjs";
import {
  boundedPolicy,
  modelTokenLimit,
  objectiveBodyFor,
  qualificationPaths,
  verifyQualificationFinalArtifact,
} from "../scripts/verify-live-objective.mjs";

const repository = "example/disposable";
const namespace = "budget-negative-fixture";
const actor = { id: 7, login: "operator" };
const base = "a".repeat(40);
const digest = "b".repeat(64);
const policyDigest = "c".repeat(64);
const at = "2026-09-05T12:00:00.000Z";
type Event = Record<string, unknown> & {
  event: string;
  sequence: number;
  runId: string;
  kind: string;
  objective: number;
};
const event = (
  name: string,
  kind: string,
  sequence: number,
  extra: Record<string, unknown> = {},
): Event => ({
  protocol: "clockgrove.factory/v2",
  event: name,
  kind,
  sequence,
  runId: "budget-run",
  objective: 1,
  at,
  ...extra,
});
function observation() {
  const events = [
    event("FactoryRunStarted", "run", 1, {
      repository,
      actor: actor.login,
      policy: budgetStopPolicy(),
      policyDigest,
      baseBranch: "main",
    }),
    event("BudgetReconciled", "budget", 2, {
      phase: "management",
      unit: "model_tokens",
      usageId: `compile-${digest}`,
      amount: 15542,
      reportedModelUsage: { inputTokens: 14132, outputTokens: 1410 },
    }),
    event("GraphCompiled", "graph", 3, {
      graphDigest: digest,
      graphSize: 3,
      baseSha: base,
      graphRef: "refs/clockgrove-factory/graphs/1/budget-run",
      graphBlobSha: "d".repeat(40),
    }),
    event("GraphProjected", "graph", 4, {
      graphDigest: digest,
      graphSize: 3,
      projectionRef: "refs/clockgrove-factory/projections/1/budget-run",
      projectionBlobSha: "e".repeat(40),
    }),
    ...[2, 3].map((workItem, index) =>
      event("WorkItemQueued", "scheduling", 5 + index, {
        workItem,
        policyDigest,
        reasonCode: "budget-exhausted",
      }),
    ),
  ];
  return {
    receipts: events.map((event, index) => ({ event, commentId: 100 + index, actorId: actor.id })),
    unit: {
      checkout: "/home/example/disposable",
      state: "active",
      unit: `clockgrove-factory-qualification-${"f".repeat(64)}.service`,
      effectiveCpu: 4,
      invocationId: "a".repeat(32),
      pid: 123,
      startTicks: "456",
      bootDigest: "d".repeat(64),
    },
    context: { repository, objective: 1, actor, base },
    status: {
      operation: "status",
      repository,
      objective: { number: 1 },
      run: { availability: "observed", runId: "budget-run", policyDigest, state: "active" },
      summary: {
        runId: "budget-run",
        attempts: { active: 0 },
        economics: {
          usage: { model_tokens: { availability: "observed", value: 15542 } },
          budgets: { modelTokens: { value: { configured: 1, committed: 15542 } } },
        },
      },
      capacity: { activeReservations: [] as unknown[], observed: { active: 0 } },
      workItems: [
        { number: 2, openDependencies: [] },
        { number: 3, openDependencies: [] },
        { number: 4, openDependencies: [2, 3] },
      ],
    },
  };
}
function receipt(input: ReturnType<typeof observation>, name: string) {
  return input.receipts.find((receipt) => receipt.event.event === name)!.event;
}
function terminalEvidence() {
  const first = observation();
  const second = structuredClone(first);
  const cancel = event("FactoryRunCancellationRequested", "run", 7, {
    requestId: `${namespace}-cancel`,
    requestedBy: actor.login,
  });
  const cancelled = event("FactoryRunCancelled", "run", 8);
  const events = [...first.receipts.map((receipt) => receipt.event), cancel, cancelled].map(
    (event, index) => ({
      ...event,
      author: actor.login,
      authorId: actor.id,
      receiptUrl: `https://github.com/${repository}/issues/1#issuecomment-${100 + index}`,
    }),
  );
  const status = structuredClone(first.status);
  status.run.state = "cancelled";
  return {
    scope: "installed-local-observed-budget-stop-no-worker",
    repository,
    actor,
    base,
    qualificationNamespace: namespace,
    fixturePaths: qualificationPaths(namespace),
    objective: { number: 1, body: objectiveBodyFor(namespace) },
    policy: budgetStopPolicy(),
    preflight: {
      qualificationNamespace: namespace,
      namespaceIssues: [],
      harness: { candidateInventorySha256: "a".repeat(64) },
    },
    installedArtifact: { inventorySha256: "a".repeat(64) },
    finishedInstalledArtifact: { inventorySha256: "a".repeat(64) },
    events,
    status,
    pulls: [],
    runResult: { runId: "budget-run", status: "cancelled" },
    runRequest: {
      tool: "factory_run",
      arguments: {
        repository: first.unit.checkout,
        owner: "example",
        repo: "disposable",
        objectiveNumber: 1,
        untilTerminal: true,
        policy: budgetStopPolicy(),
      },
    },
    budgetStop: {
      primary: first.unit,
      observations: [
        { ...first, observedAt: at },
        { ...second, observedAt: "2026-09-05T12:00:10.000Z" },
      ],
      beforeCancel: { ...second, observedAt: "2026-09-05T12:00:11.000Z" },
      cancelRequestId: `${namespace}-cancel`,
      cancelReceipt: cancel,
      cleanup: { state: "absent", unit: first.unit.unit, bootDigest: first.unit.bootDigest },
    },
  };
}

describe("explicit negative budget authority", () => {
  const env = {
    FACTORY_LIVE_BUDGET_STOP: "1",
    FACTORY_LIVE_OBJECTIVE: "1",
    FACTORY_LIVE_OBJECTIVE_REPOSITORY: repository,
    FACTORY_LIVE_OBJECTIVE_NAMESPACE: namespace,
    FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "1",
    FACTORY_LIVE_BUDGET_STOP_ACK: `${repository}:compile-once-budget-stop-no-worker`,
  };
  it("does nothing without its own opt-in", async () => {
    const run = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({}, run);
      expect(run).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("reduces only the initial model allowance and does not weaken happy-path guards", () => {
    const full = boundedPolicy("regular-prs", 500000) as Record<string, unknown>;
    const reduced = budgetStopPolicy();
    expect(reduced).toEqual({
      ...full,
      economics: { ...(full.economics as object), maxModelTokens: 1 },
    });
    expect(() => modelTokenLimit("1")).toThrow();
    expect(() => boundedPolicy("regular-prs", 1)).toThrow();
    expect(budgetStopAuthority(env)?.policy).toEqual(reduced);
  });
  it.each([
    { FACTORY_LIVE_BUDGET_STOP_ACK: "other/repo" },
    { FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "0" },
    { FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500000" },
    { FACTORY_LIVE_OBJECTIVE_DELIVERY: "stacked-prs" },
    { FACTORY_LIVE_REGULAR_BACKEND: "codex-cli" },
    { FACTORY_LIVE_OBJECTIVE_REPOSITORY: "clockgrove/factory" },
    { GH_TOKEN: "private-sentinel" },
    { GH_CONFIG_DIR: "/other/config" },
  ])("rejects altered scope before invocation %j", async (delta) => {
    const run = vi.fn();
    await expect(main({ ...env, ...delta }, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("observed compiler accounting and no-worker gate", () => {
  it("accepts a real positive compiler overshoot followed by blocked roots", () =>
    expect(assessBudgetStopObservation(observation())).toMatchObject({
      runId: "budget-run",
      compilerTokens: 15542,
      roots: [2, 3],
    }));
  it("waits for compilation rather than claiming unknown usage as zero", () => {
    const input = observation();
    input.receipts = [];
    expect(assessBudgetStopObservation(input)).toBeNull();
  });
  it("waits when only one ready root has an observed budget refusal", () => {
    const input = observation();
    input.receipts.pop();
    expect(assessBudgetStopObservation(input)).toBeNull();
  });
  it.each(["AttemptReserved", "AttemptStarted"])(
    "rejects any admitted %s even if status says inactive",
    (name) => {
      const input = observation();
      input.receipts.push({
        event: event(name, "attempt", 7, { workItem: 2, attempt: 1 }),
        commentId: 107,
        actorId: 7,
      });
      expect(() => assessBudgetStopObservation(input)).toThrow(/admission/);
    },
  );
  it.each([
    "FactoryRunCancelled",
    "FactoryRunCompleted",
    "FactoryRunEscalated",
    "FactoryRunCancellationRequested",
  ])("does not replace unexpected %s with its own cleanup", (name) => {
    const input = observation();
    input.receipts.push({ event: event(name, "run", 7), commentId: 107, actorId: 7 });
    expect(() => assessBudgetStopObservation(input)).toThrow(/outcome changed/);
  });
  it.each([
    { amount: 0 },
    { amount: 1 },
    { reportedModelUsage: undefined },
    { reportedModelUsage: { inputTokens: 14132 } },
    { reportedModelUsage: { inputTokens: 14132, outputTokens: 1409 } },
    { usageId: "failed-compile-unrelated" },
    { workItem: 2 },
  ])("rejects missing, zero, inconsistent, or non-compiler usage %j", (delta) => {
    const input = observation();
    Object.assign(receipt(input, "BudgetReconciled"), delta);
    expect(() => assessBudgetStopObservation(input)).toThrow();
  });
  it("rejects extra accounted calls rather than interpreting them as compiler-only", () => {
    const input = observation();
    input.receipts.push({
      event: { ...receipt(input, "BudgetReconciled"), sequence: 7, usageId: "review-extra" },
      commentId: 107,
      actorId: 7,
    });
    expect(() => assessBudgetStopObservation(input)).toThrow(/one known compiler/);
  });
  it("rejects unauthenticated source receipts", () => {
    const input = observation();
    input.receipts[0]!.actorId = 8;
    expect(() => assessBudgetStopObservation(input)).toThrow();
  });
  it("rejects changed policy, base, graph and status binding", () => {
    for (const mutate of [
      (input: ReturnType<typeof observation>) => {
        receipt(input, "FactoryRunStarted").policy = boundedPolicy("regular-prs", 500000);
      },
      (input: ReturnType<typeof observation>) => {
        receipt(input, "GraphCompiled").baseSha = "f".repeat(40);
      },
      (input: ReturnType<typeof observation>) => {
        receipt(input, "GraphProjected").graphDigest = "f".repeat(64);
      },
      (input: ReturnType<typeof observation>) => {
        input.status.run.runId = "different";
      },
      (input: ReturnType<typeof observation>) => {
        input.status.summary.economics.budgets.modelTokens.value.configured = 500000;
      },
    ]) {
      const input = observation();
      mutate(input);
      expect(() => assessBudgetStopObservation(input)).toThrow();
    }
  });
  it("rejects outstanding status liabilities even with no captured attempt receipt", () => {
    const input = observation();
    input.status.capacity.activeReservations.push({ workItem: 2 });
    expect(() => assessBudgetStopObservation(input)).toThrow();
  });
});

function coordinator() {
  let milliseconds = Date.parse(at);
  const original = observation();
  return {
    read: vi.fn(async () => structuredClone(original)),
    cancel: vi.fn(async (requestId: string) =>
      event("FactoryRunCancellationRequested", "run", 7, { requestId, requestedBy: actor.login }),
    ),
    context: original.context,
    cancelRequestId: `${namespace}-cancel`,
    assertRunning: vi.fn(),
    saveObservation: vi.fn(),
    saveCancelRequested: vi.fn(),
    wait: vi.fn(async (duration: number) => {
      milliseconds += duration;
    }),
    now: () => new Date(milliseconds).toISOString(),
  };
}
describe("one stable cancellation only after repeated known stop", () => {
  it("observes twice across an interval and rereads immediately before one cancellation", async () => {
    const input = coordinator();
    await expect(observeBudgetStopThenCancel(input)).resolves.toMatchObject({
      requestId: input.cancelRequestId,
    });
    expect(input.read).toHaveBeenCalledTimes(3);
    expect(input.saveObservation).toHaveBeenCalledTimes(2);
    expect(input.wait).toHaveBeenCalledWith(10000);
    expect(input.saveCancelRequested).toHaveBeenCalledTimes(1);
    expect(input.cancel.mock.calls).toEqual([[input.cancelRequestId]]);
  });
  it("does not cancel when an attempt appears in the final pre-request read", async () => {
    const input = coordinator();
    const bad = observation();
    bad.receipts.push({
      event: event("AttemptReserved", "attempt", 7),
      commentId: 107,
      actorId: 7,
    });
    input.read
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(bad);
    await expect(observeBudgetStopThenCancel(input)).rejects.toThrow();
    expect(input.cancel).not.toHaveBeenCalled();
    expect(input.saveCancelRequested).not.toHaveBeenCalled();
  });
  it("does not cancel on unknown compiler usage", async () => {
    const input = coordinator();
    const bad = observation();
    receipt(bad, "BudgetReconciled").reportedModelUsage = undefined;
    input.read.mockResolvedValue(bad);
    await expect(observeBudgetStopThenCancel(input)).rejects.toThrow();
    expect(input.cancel).not.toHaveBeenCalled();
  });
  it("does not cancel a changed service incarnation", async () => {
    const input = coordinator();
    const changed = observation();
    changed.unit.invocationId = "b".repeat(32);
    input.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce(changed);
    await expect(observeBudgetStopThenCancel(input)).rejects.toThrow();
    expect(input.cancel).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain cancellation response", async () => {
    const input = coordinator();
    input.cancel.mockRejectedValue(Error("response unavailable"));
    await expect(observeBudgetStopThenCancel(input)).rejects.toThrow(/response unavailable/);
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.read).toHaveBeenCalledTimes(3);
  });
  it("does not proceed after original foreground authority is revoked", async () => {
    const input = coordinator();
    input.assertRunning.mockImplementation(() => {
      throw Error("original call uncertain");
    });
    await expect(observeBudgetStopThenCancel(input)).rejects.toThrow(/uncertain/);
    expect(input.read).not.toHaveBeenCalled();
    expect(input.cancel).not.toHaveBeenCalled();
  });
  it("bounds unchanged incomplete observations with no cancellation", async () => {
    const input = coordinator();
    const pending = observation();
    pending.receipts = [];
    input.read.mockResolvedValue(pending);
    await expect(observeBudgetStopThenCancel(input)).rejects.toThrow(/bounded observed/);
    expect(input.read).toHaveBeenCalledTimes(48);
    expect(input.cancel).not.toHaveBeenCalled();
  });
});

describe("negative terminal evidence and independent artifact verifier", () => {
  it("accepts only the no-worker cancelled outcome with known accounting and collected service", () =>
    expect(() => assertBudgetStopCompletion(terminalEvidence())).not.toThrow());
  it.each(["unknown", "active"])("rejects %s cleanup", (state) => {
    const evidence = terminalEvidence();
    evidence.budgetStop.cleanup.state = state;
    expect(() => assertBudgetStopCompletion(evidence)).toThrow();
  });
  it("rejects another run, request, source unit, or namespace", () => {
    for (const mutate of [
      (e: ReturnType<typeof terminalEvidence>) => {
        e.status.run.runId = "other";
      },
      (e: ReturnType<typeof terminalEvidence>) => {
        e.budgetStop.cancelRequestId = "other";
      },
      (e: ReturnType<typeof terminalEvidence>) => {
        e.budgetStop.primary = { ...e.budgetStop.primary, unit: "other.service" };
      },
      (e: ReturnType<typeof terminalEvidence>) => {
        e.qualificationNamespace = "other-namespace";
      },
      (e: ReturnType<typeof terminalEvidence>) => {
        e.events[0]!.authorId = 99;
      },
    ]) {
      const evidence = terminalEvidence();
      mutate(evidence);
      expect(() => assertBudgetStopCompletion(evidence)).toThrow();
    }
  });
  it.each([
    [
      "checkout",
      (e: ReturnType<typeof terminalEvidence>) => {
        e.runRequest.arguments.repository = "/home/example/another-checkout";
      },
    ],
    [
      "objective",
      (e: ReturnType<typeof terminalEvidence>) => {
        e.events.at(-1)!.objective = 99;
      },
    ],
    [
      "start base",
      (e: ReturnType<typeof terminalEvidence>) => {
        Object.assign(e.events.find((event) => event.event === "FactoryRunStarted")!, {
          baseBranch: "other",
        });
      },
    ],
    [
      "start actor",
      (e: ReturnType<typeof terminalEvidence>) => {
        Object.assign(e.events.find((event) => event.event === "FactoryRunStarted")!, {
          actor: "other",
        });
      },
    ],
    [
      "compiler breakdown",
      (e: ReturnType<typeof terminalEvidence>) => {
        Object.assign(e.events.find((event) => event.event === "BudgetReconciled")!, {
          reportedModelUsage: {
            inputTokens: 14131,
            outputTokens: 1411,
          },
        });
      },
    ],
    [
      "compiler phase",
      (e: ReturnType<typeof terminalEvidence>) => {
        Object.assign(e.events.find((event) => event.event === "BudgetReconciled")!, {
          phase: "validation",
        });
      },
    ],
  ] as const)(
    "rejects changed final %s even when totals and run ID are unchanged",
    (_name, mutate) => {
      const evidence = terminalEvidence();
      mutate(evidence);
      expect(() => assertBudgetStopCompletion(evidence)).toThrow();
    },
  );
  it("retains the ordinary final merged-artifact verifier when no override is provided", async () => {
    const defaultVerifier = vi.fn(async () => {});
    const hooks = { immutable: "retained" };
    await verifyQualificationFinalArtifact({ defaultVerifier, hooks });
    expect(defaultVerifier.mock.calls).toEqual([[hooks]]);
  });
  it("invokes the explicit negative verifier once without running the merged-success verifier", async () => {
    const verifier = vi.fn(async () => {});
    const defaultVerifier = vi.fn(async () => {});
    const hooks = {};
    await verifyQualificationFinalArtifact({ verifier, defaultVerifier, hooks });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(defaultVerifier).not.toHaveBeenCalled();
  });
  it("propagates negative verification failure instead of falling back or claiming success", async () => {
    const verifier = vi.fn(async () => {
      throw Error("base changed");
    });
    const defaultVerifier = vi.fn(async () => {});
    await expect(
      verifyQualificationFinalArtifact({ verifier, defaultVerifier, hooks: {} }),
    ).rejects.toThrow(/base changed/);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(defaultVerifier).not.toHaveBeenCalled();
  });
});
