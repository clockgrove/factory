import { describe, expect, it, vi } from "vitest";
import {
  assertNativeLinearHistory,
  executeNativeLinearControllerCase,
  nativeLinearObjectiveBody,
  nativeLinearQualification,
} from "../scripts/verify-native-linear-objective.mjs";
import { qualificationPaths } from "../scripts/verify-live-objective.mjs";

const head = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);

type QualificationEvent = {
  event: string;
  workItem?: number;
  sequence?: number;
  headSha?: string;
  invalidatedByItem?: string;
  usageId?: string;
  [key: string]: unknown;
};

function publication(
  position: number,
  sequence: number,
  headSha: string,
  baseSha: string,
  validationDigest: string,
): QualificationEvent {
  return {
    event: "PublicationRecorded",
    runId: "run",
    objective: 1,
    workItem: position + 2,
    attempt: 1,
    itemId: ["root", "middle", "top"][position],
    unitId: "linear",
    position,
    ...(position ? { parentItemId: ["root", "middle"][position - 1] } : {}),
    mode: "native-stacks",
    sequence,
    headSha,
    baseSha,
    validationDigest,
  };
}

function history(): QualificationEvent[] {
  const root = publication(0, 10, head("a"), head("0"), digest("a"));
  const middle = publication(1, 11, head("b"), head("a"), digest("b"));
  const top = publication(2, 12, head("c"), head("b"), digest("c"));
  const middleRebased = publication(1, 25, head("d"), head("1"), digest("d"));
  const topFirstRebase = publication(2, 28, head("e"), head("d"), digest("e"));
  const topFinal = publication(2, 34, head("f"), head("2"), digest("f"));
  return [
    root,
    middle,
    top,
    {
      ...root,
      event: "IntegrationCompleted",
      operationId: "linear-stack-operation",
      sequence: 19,
    },
    { event: "AttemptIntegrated", workItem: 2, sequence: 20 },
    {
      ...middle,
      event: "ValidationInvalidated",
      sequence: 21,
      invalidatedByItem: "root",
      invalidatedByHeadSha: head("1"),
    },
    {
      ...top,
      event: "ValidationInvalidated",
      sequence: 22,
      invalidatedByItem: "root",
      invalidatedByHeadSha: head("1"),
    },
    {
      event: "ValidationRecorded",
      workItem: 3,
      sequence: 23,
      evidenceDigest: digest("d"),
      baseSha: head("1"),
    },
    { event: "AttemptPublished", workItem: 3, sequence: 24, headSha: head("d") },
    middleRebased,
    {
      event: "ValidationRecorded",
      workItem: 4,
      sequence: 26,
      evidenceDigest: digest("e"),
      baseSha: head("d"),
    },
    { event: "AttemptPublished", workItem: 4, sequence: 27, headSha: head("e") },
    topFirstRebase,
    {
      ...middleRebased,
      event: "IntegrationCompleted",
      operationId: "linear-stack-operation",
      sequence: 29,
    },
    { event: "AttemptIntegrated", workItem: 3, sequence: 30 },
    {
      ...topFirstRebase,
      event: "ValidationInvalidated",
      sequence: 31,
      invalidatedByItem: "middle",
      invalidatedByHeadSha: head("2"),
    },
    {
      event: "ValidationRecorded",
      workItem: 4,
      sequence: 32,
      evidenceDigest: digest("f"),
      baseSha: head("2"),
    },
    { event: "AttemptPublished", workItem: 4, sequence: 33, headSha: head("f") },
    topFinal,
    {
      ...topFinal,
      event: "IntegrationCompleted",
      operationId: "linear-stack-operation",
      sequence: 39,
    },
    { event: "AttemptIntegrated", workItem: 4, sequence: 40 },
    ...["one", "two", "three"].flatMap((suffix, index) => [
      {
        event: "BudgetReconciled",
        usageId: `integration-validation-${suffix}`,
        amount: index,
      },
      { event: "BudgetReconciled", usageId: `rebase-review-${suffix}`, amount: index + 1 },
    ]),
  ];
}

function controllerInput(caseName: "response-loss-restart" | "active-cancellation") {
  const evidence: {
    objective: { number: number };
    actor: { id: number; login: string };
    qualificationNamespace: string;
    nativeLinearIntervention?: Record<string, unknown>;
  } = {
    objective: { number: 7 },
    actor: { id: 9, login: "operator" },
    qualificationNamespace: "native-linear-case",
  };
  const runRequest = {
    tool: "factory_activate",
    arguments: {
      owner: "example",
      repo: "fixture",
      objectiveNumber: 7,
      requestId: "native-linear-case-activate",
      policy: {},
    },
  };
  const progressEvents = [
    {
      event: "FactoryRunStarted",
      runId: "run",
      activationRequestId: runRequest.arguments.requestId,
    },
    {
      event: "IntegrationCompleted",
      runId: "run",
      workItem: 2,
      attempt: 1,
      sequence: 19,
      headSha: head("0"),
      operationId: "linear-stack-operation",
    },
    {
      event: "ValidationInvalidated",
      runId: "run",
      workItem: 3,
      attempt: 1,
      sequence: 20,
      headSha: head("a"),
    },
    {
      event: "PublicationRecorded",
      runId: "run",
      workItem: 3,
      attempt: 1,
      sequence: 21,
      headSha: head("b"),
    },
  ];
  const observations = [
    { events: progressEvents, status: { run: { availability: "observed", state: "running" } } },
    {
      events: progressEvents,
      status: {
        run: {
          availability: "observed",
          state: caseName === "response-loss-restart" ? "completed" : "cancelled",
        },
      },
    },
  ];
  return {
    caseName,
    evidence,
    owner: "example",
    repo: "fixture",
    checkout: "/home/operator/fixture",
    runRequest,
    call: vi.fn(async (_name: string, _arguments: Record<string, unknown>) => ({})),
    request: vi.fn(),
    save: vi.fn(),
    observe: vi.fn(async () => observations.shift()!),
    wait: vi.fn(async () => {}),
    maximumObservations: 3,
  };
}

describe("native linear-stack installed matrix", () => {
  it("defines one explicit linear Objective without provider or fallback scope", () => {
    const namespace = "native-linear-fixture";
    const body = nativeLinearObjectiveBody(namespace);
    const paths = qualificationPaths(namespace);
    expect(paths.files.every((path) => body.includes(path))).toBe(true);
    expect(body).toContain("The first is the only root");
    expect(body).toContain("depends only on the first");
    expect(body).toContain("depends only on the second");
    expect(body).not.toMatch(/Daytona|fallback|unavailable/i);
    expect(
      nativeLinearQualification({
        FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
        FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
        FACTORY_LIVE_NATIVE_LINEAR_CASE: "cascade",
        FACTORY_LIVE_OBJECTIVE_NAMESPACE: namespace,
        FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      }),
    ).toMatchObject({
      scope: "installed-local-native-linear-stack-cascade",
      namespace,
      privateEvidence: true,
    });
  });

  it.each(["", "other", "native-unavailable"])(
    "rejects unknown matrix case %j before installed execution",
    (caseName) => {
      expect(() =>
        nativeLinearQualification({
          FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
          FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
          FACTORY_LIVE_NATIVE_LINEAR_CASE: caseName,
          FACTORY_LIVE_OBJECTIVE_NAMESPACE: "native-linear-fixture",
          FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
        }),
      ).toThrow();
    },
  );

  it("keeps native unavailability in its separate qualification", () => {
    expect(() =>
      nativeLinearQualification({
        FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
        FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE: "1",
        FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
        FACTORY_LIVE_NATIVE_LINEAR_CASE: "cascade",
        FACTORY_LIVE_OBJECTIVE_NAMESPACE: "native-linear-fixture",
        FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      }),
    ).toThrow(/separate fallback qualification/);
  });

  it("requires one invalidation/revalidation per lower-layer change and bottom-up completion", () => {
    expect(() => assertNativeLinearHistory(history())).not.toThrow();
  });

  it.each([
    [
      "missing invalidation",
      (events: ReturnType<typeof history>) =>
        events.splice(
          events.findIndex(
            (event) => event.event === "ValidationInvalidated" && event.workItem === 4,
          ),
          1,
        ),
    ],
    [
      "changed-head reuse",
      (events: ReturnType<typeof history>) => {
        const publications = events.filter(
          (event) => event.event === "PublicationRecorded" && event.workItem === 3,
        );
        publications[1]!.headSha = publications[0]!.headSha!;
      },
    ],
    [
      "duplicate native mutation",
      (events: ReturnType<typeof history>) => {
        events.push(
          structuredClone(
            events.find((event) => event.event === "IntegrationCompleted" && event.workItem === 3)!,
          ),
        );
      },
    ],
    [
      "cascade order",
      (events: ReturnType<typeof history>) => {
        const invalidations = events.filter(
          (event) => event.event === "ValidationInvalidated" && event.workItem === 4,
        );
        invalidations.reverse().forEach((event, index) => {
          event.invalidatedByItem = ["root", "middle"][index]!;
        });
      },
    ],
    [
      "partial completion order",
      (events: ReturnType<typeof history>) => {
        events.find(
          (event) => event.event === "AttemptIntegrated" && event.workItem === 3,
        )!.sequence = 19;
      },
    ],
    [
      "duplicate accounting",
      (events: ReturnType<typeof history>) => {
        events.push(
          structuredClone(
            events.find(
              (event) =>
                event.event === "BudgetReconciled" &&
                event.usageId === "integration-validation-one",
            )!,
          ),
        );
      },
    ],
  ] as const)("rejects deterministic %s evidence", (_name, mutate) => {
    const events = history();
    mutate(events);
    expect(() => assertNativeLinearHistory(events)).toThrow();
  });

  it("adopts one durable revalidated operation after a deliberately lost restart response", async () => {
    const input = controllerInput("response-loss-restart");
    await expect(executeNativeLinearControllerCase(input)).resolves.toEqual({
      objective: 7,
      runId: "run",
      status: "completed",
    });
    expect(input.call.mock.calls.map(([name]) => name)).toEqual([
      "factory_activate",
      "factory_controller_restart",
    ]);
    expect(input.evidence.nativeLinearIntervention).toMatchObject({
      case: "response-loss-restart",
      runId: "run",
      responseLost: true,
      progress: { workItem: 3, durableHeadSha: head("b") },
    });
  });

  it("requests active cancellation once after durable partial native progress", async () => {
    const input = controllerInput("active-cancellation");
    await expect(executeNativeLinearControllerCase(input)).resolves.toEqual({
      objective: 7,
      runId: "run",
      status: "cancelled",
    });
    expect(input.call.mock.calls.map(([name]) => name)).toEqual([
      "factory_activate",
      "factory_cancel",
    ]);
    expect(input.evidence.nativeLinearIntervention).toMatchObject({
      case: "active-cancellation",
      requested: true,
      responseLost: false,
    });
  });

  it("does not retry or relabel a run that becomes terminal before intervention", async () => {
    const input = controllerInput("response-loss-restart");
    input.observe = vi.fn(async () => ({
      events: [
        {
          event: "FactoryRunStarted",
          runId: "run",
          activationRequestId: input.runRequest.arguments.requestId,
        },
      ],
      status: { run: { availability: "observed", state: "completed" } },
    }));
    await expect(executeNativeLinearControllerCase(input)).rejects.toThrow(
      /ended before its bounded intervention/,
    );
    expect(input.call).toHaveBeenCalledTimes(1);
    expect(input.call).toHaveBeenCalledWith("factory_activate", input.runRequest.arguments);
  });
});
