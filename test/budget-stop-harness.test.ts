import { describe, expect, it, vi } from "vitest";
import {
  assertBudgetStopCompletion,
  assessBudgetStopObservation,
  budgetRefusalReason,
  budgetStopAuthority,
  budgetStopPolicy,
  createBudgetStopQualification,
  main,
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
const policyDigest = "c".repeat(64);
type Event = Record<string, unknown> & {
  event: string;
  kind: string;
  sequence: number;
  runId: string;
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
  at: "2026-09-05T12:00:00.000Z",
  ...extra,
});
function observation() {
  return {
    context: { repository, objective: 1, actor },
    receipts: [
      event("FactoryRunStarted", "run", 1, {
        repository,
        actor: actor.login,
        policy: budgetStopPolicy(),
        policyDigest,
        baseBranch: "main",
      }),
      event("BudgetReconciled", "budget", 5, {
        phase: "management",
        unit: "model_tokens",
        usageId: `compile-${"b".repeat(64)}`,
        amount: 15919,
        reportedModelUsage: { inputTokens: 14460, outputTokens: 1459 },
      }),
      event("FactoryRunEscalated", "run", 6, { reason: budgetRefusalReason }),
      event("DeliverySelected", "delivery", 4, {
        requested: "regular-prs",
        selected: "regular-prs",
      }),
    ].map((event, index) => ({ event, commentId: 100 + index, actorId: actor.id })),
    status: {
      operation: "status",
      repository,
      objective: { number: 1 },
      run: { availability: "observed", runId: "budget-run", policyDigest, state: "escalated" },
      summary: {
        runId: "budget-run",
        attempts: { active: 0 },
        economics: {
          usage: { model_tokens: { availability: "observed", value: 15919 } },
          budgets: { modelTokens: { value: { configured: 1, committed: 15919 } } },
        },
      },
      workItems: [] as unknown[],
      capacity: { activeReservations: [] as unknown[], observed: { active: 0 } },
    },
  };
}
function terminalEvidence() {
  const observed = observation();
  return {
    scope: "installed-local-pre-projection-budget-refusal",
    repository,
    actor,
    base: "a".repeat(40),
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
    events: observed.receipts.map(({ event, commentId }) => ({
      ...event,
      author: actor.login,
      authorId: actor.id,
      receiptUrl: `https://github.com/${repository}/issues/1#issuecomment-${commentId}`,
    })),
    status: observed.status,
    children: [] as unknown[],
    pulls: [] as unknown[],
    runResult: { runId: "budget-run", status: "escalated" },
    runRequest: {
      tool: "factory_run",
      arguments: {
        repository: "/home/example/disposable",
        owner: "example",
        repo: "disposable",
        objectiveNumber: 1,
        untilTerminal: true,
        policy: budgetStopPolicy(),
      },
    },
    budgetStop: {
      kind: "pre-projection-budget-refusal-no-cancel",
      primary: {
        checkout: "/home/example/disposable",
        unit: "exact.service",
        bootDigest: "b".repeat(64),
      },
      terminalObservation: assessBudgetStopObservation(observed),
      cleanup: { state: "absent", unit: "exact.service", bootDigest: "b".repeat(64) },
    },
  };
}
const env = {
  FACTORY_LIVE_BUDGET_STOP: "1",
  FACTORY_LIVE_OBJECTIVE: "1",
  FACTORY_LIVE_OBJECTIVE_REPOSITORY: repository,
  FACTORY_LIVE_OBJECTIVE_NAMESPACE: namespace,
  FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "1",
  FACTORY_LIVE_BUDGET_STOP_ACK: `${repository}:pre-projection-refusal-no-cancel`,
};

describe("prospective pre-projection refusal authority", () => {
  it("has no import/entry action without its own opt-in", async () => {
    const invoke = vi.fn(async () => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({}, invoke);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("reduces only the initial budget and leaves happy guard unchanged", () => {
    const full = boundedPolicy("regular-prs", 500000) as Record<string, unknown>;
    expect(budgetStopPolicy()).toEqual({
      ...full,
      economics: { ...(full.economics as object), maxModelTokens: 1 },
    });
    expect(() => modelTokenLimit("1")).toThrow();
    expect(budgetStopAuthority(env)?.policy).toEqual(budgetStopPolicy());
  });
  it.each([
    ["FACTORY_LIVE_BUDGET_STOP_ACK", `${repository}:compile-once-budget-stop-no-worker`],
    ["FACTORY_LIVE_BUDGET_STOP_ACK", "another/repo:pre-projection-refusal-no-cancel"],
    ["FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS", "2"],
    ["FACTORY_LIVE_OBJECTIVE_DELIVERY", "native-stacks"],
    ["FACTORY_LIVE_REGULAR_BACKEND", "codex-cli"],
    ["FACTORY_LIVE_OBJECTIVE_REPOSITORY", "clockgrove/factory"],
    ...["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"].map((key) => [
      key,
      "override",
    ]),
  ])("rejects changed %s before any invocation", async (key, value) => {
    const invoke = vi.fn(async () => {});
    await expect(main({ ...env, [key!]: value }, invoke)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("constructs no control/polling hook and calls the shared runner once", async () => {
    const invoke = vi.fn(async () => {});
    await main(env, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    const qualification = createBudgetStopQualification(budgetStopAuthority(env)!);
    expect(qualification.duringRun).toBeUndefined();
    expect(qualification.scope).toBe("installed-local-pre-projection-budget-refusal");
  });
});

describe("observed pre-projection terminal rather than queued/cancelled assumptions", () => {
  it("retains real counters and marks durable graph uninspected, never absent", () => {
    const input = observation();
    const before = structuredClone(input);
    expect(assessBudgetStopObservation(input)).toMatchObject({
      observationScope: "observed-pre-projection-budget-refusal",
      compilerTokens: 15919,
      durableGraph: "uninspected",
      originalExerciseResultChanged: false,
    });
    expect(input).toEqual(before);
  });
  it.each(["AttemptReserved", "AttemptStarted", "AttemptCancelled"])("rejects any %s", (name) => {
    const input = observation();
    input.receipts.push({ event: event(name, "attempt", 4), actorId: 7, commentId: 200 });
    expect(() => assessBudgetStopObservation(input)).toThrow();
  });
  it.each([
    ["CapacityReserved", "capacity"],
    ["GraphCompiled", "graph"],
    ["GraphProjected", "graph"],
    ["WorkItemQueued", "scheduling"],
    ["PublicationRecorded", "publication"],
    ["ValidationRecorded", "validation"],
    ["FactoryRunCancellationRequested", "run"],
  ])("rejects %s outside this narrow boundary", (name, kind) => {
    const input = observation();
    input.receipts.push({ event: event(name!, kind!, 4), actorId: 7, commentId: 200 });
    expect(() => assessBudgetStopObservation(input)).toThrow();
  });
  const changes: Array<[string, (v: ReturnType<typeof observation>) => void]> = [
    [
      "changed delivery",
      (v) => {
        v.receipts[3]!.event.selected = "native-stacks";
      },
    ],
    [
      "late delivery",
      (v) => {
        v.receipts[3]!.event.sequence = 7;
      },
    ],
    [
      "missing delivery",
      (v) => {
        v.receipts.pop();
      },
    ],
    [
      "unknown event",
      (v) => {
        v.receipts.push({ event: event("FutureAuthority", "run", 4), actorId: 7, commentId: 200 });
      },
    ],
    [
      "unknown usage",
      (v) => {
        delete v.receipts[1]!.event.reportedModelUsage;
      },
    ],
    [
      "zero usage",
      (v) => {
        v.receipts[1]!.event.amount = 0;
      },
    ],
    [
      "bad breakdown",
      (v) => {
        v.receipts[1]!.event.reportedModelUsage = { inputTokens: 1, outputTokens: 1 };
      },
    ],
    [
      "failed compile identity",
      (v) => {
        v.receipts[1]!.event.usageId = "failed-compile-other";
      },
    ],
    [
      "usage after terminal",
      (v) => {
        v.receipts[1]!.event.sequence = 7;
      },
    ],
    [
      "usage before start",
      (v) => {
        v.receipts[1]!.event.sequence = 1;
      },
    ],
    [
      "other terminal",
      (v) => {
        v.receipts[2]!.event.event = "FactoryRunCancelled";
      },
    ],
    [
      "other reason",
      (v) => {
        v.receipts[2]!.event.reason = "provider unavailable";
      },
    ],
    [
      "other actor",
      (v) => {
        v.receipts[0]!.actorId = 8;
      },
    ],
    [
      "other Objective",
      (v) => {
        v.receipts[0]!.event.objective = 2;
      },
    ],
    [
      "other run",
      (v) => {
        v.receipts[1]!.event.runId = "other";
      },
    ],
    [
      "other status",
      (v) => {
        v.status.run.state = "completed";
      },
    ],
    [
      "unobserved status",
      (v) => {
        v.status.run.availability = "unavailable";
      },
    ],
    [
      "unknown status usage",
      (v) => {
        v.status.summary.economics.usage.model_tokens.availability = "unavailable";
      },
    ],
    [
      "outstanding capacity",
      (v) => {
        v.status.capacity.activeReservations.push({ reserved: 1 });
      },
    ],
    [
      "projected child",
      (v) => {
        v.status.workItems.push({ number: 2 });
      },
    ],
    [
      "additional model call",
      (v) => {
        v.receipts.push({
          ...v.receipts[1]!,
          commentId: 200,
          event: { ...v.receipts[1]!.event, sequence: 4, usageId: `compile-${"e".repeat(64)}` },
        });
      },
    ],
    [
      "conflicting receipt",
      (v) => {
        v.receipts.push({
          ...v.receipts[1]!,
          commentId: 200,
          event: { ...v.receipts[1]!.event, amount: 123 },
        });
      },
    ],
  ];
  it.each(changes)("rejects %s", (_name, change) => {
    const input = observation();
    change(input);
    expect(() => assessBudgetStopObservation(input)).toThrow();
  });
  it("deduplicates authenticated same-identity lost responses", () => {
    const input = observation();
    input.receipts.push(structuredClone(input.receipts[1]!));
    expect(assessBudgetStopObservation(input).compilerTokens).toBe(15919);
  });
});

describe("prospective completion and original-exercise preservation", () => {
  it("requires exact terminal evidence plus service absence", () => {
    expect(() => assertBudgetStopCompletion(terminalEvidence())).not.toThrow();
  });
  const changes: Array<[string, (v: ReturnType<typeof terminalEvidence>) => void]> = [
    [
      "historical failed scope",
      (v) => {
        v.scope = "installed-local-observed-budget-stop-no-worker";
      },
    ],
    [
      "wrong checkout",
      (v) => {
        v.runRequest.arguments.repository = "/another";
      },
    ],
    [
      "wrong namespace",
      (v) => {
        v.qualificationNamespace = "another";
      },
    ],
    [
      "wrong installed artifact",
      (v) => {
        v.finishedInstalledArtifact.inventorySha256 = "e".repeat(64);
      },
    ],
    [
      "unknown resource",
      (v) => {
        v.budgetStop.cleanup.state = "unknown";
      },
    ],
    [
      "wrong unit",
      (v) => {
        v.budgetStop.cleanup.unit = "other.service";
      },
    ],
    [
      "wrong boot",
      (v) => {
        v.budgetStop.cleanup.bootDigest = "f".repeat(64);
      },
    ],
    [
      "foreign receipt",
      (v) => {
        v.events[0]!.authorId = 9;
      },
    ],
    [
      "foreign receipt location",
      (v) => {
        v.events[0]!.receiptUrl = `https://github.com/${repository}/issues/2#issuecomment-100`;
      },
    ],
    [
      "changed original start",
      (v) => {
        Object.assign(v.events[0]!, { baseBranch: "other" });
      },
    ],
    [
      "changed compiler breakdown",
      (v) => {
        Object.assign(v.events[1]!, {
          reportedModelUsage: { inputTokens: 14461, outputTokens: 1458 },
        });
      },
    ],
    [
      "unexpected child",
      (v) => {
        v.children.push({ number: 2 });
      },
    ],
    [
      "unexpected PR",
      (v) => {
        v.pulls.push({ number: 2 });
      },
    ],
    [
      "cancel attempt",
      (v) => {
        Object.assign(v.budgetStop, { cancelRequested: true });
      },
    ],
  ];
  it.each(changes)("rejects %s", (_name, change) => {
    const input = terminalEvidence();
    change(input);
    expect(() => assertBudgetStopCompletion(input)).toThrow();
  });
  it("keeps ordinary merged-artifact verifier unchanged by default", async () => {
    const defaultVerifier = vi.fn(async () => {});
    const hooks = {};
    await verifyQualificationFinalArtifact({ defaultVerifier, hooks });
    expect(defaultVerifier.mock.calls).toEqual([[hooks]]);
  });
  it("invokes the explicit final verifier once and propagates its failure", async () => {
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
