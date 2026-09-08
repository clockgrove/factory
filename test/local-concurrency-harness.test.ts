import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import {
  concurrencyAuthority,
  concurrencyMeasurements,
  concurrencyModelConfiguration,
  concurrencyObjectiveBody,
  concurrencyRefill,
  concurrencyReceiptProgress,
  assertInnerTakeover,
  assertObjectiveContention,
  assertRetiredController,
  main,
  runConcurrencyLeaseFaultScenario,
  runConcurrencyScenario,
  verifyConcurrencyArtifacts,
  type ConcurrencyPort,
} from "../scripts/verify-local-concurrency.mjs";
import { qualificationPaths } from "../scripts/verify-live-objective.mjs";

const repository = "example/disposable";
const checkout = "/home/example/disposable";
const unit = `clockgrove-factory-${createHash("sha256").update(`${repository}\0${checkout}`).digest("hex").slice(0, 16)}.service`;
const env = {
  FACTORY_LOCAL_CONCURRENCY: "1",
  FACTORY_CONCURRENCY_REPOSITORY: repository,
  FACTORY_CONCURRENCY_CHECKOUT: checkout,
  FACTORY_CONCURRENCY_CONTROLLER_UNIT: unit,
  FACTORY_CONCURRENCY_PHASE: "exercise",
  FACTORY_CONCURRENCY_NAMESPACE: "concurrency-fixture",
  FACTORY_CONCURRENCY_EVIDENCE: "/tmp/private/concurrency.json",
  FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: "500000",
  FACTORY_CONCURRENCY_MODEL: "fixture-model",
  FACTORY_CONCURRENCY_REASONING: "high",
  FACTORY_CONCURRENCY_ACK: `${repository}:${unit}:start,activate-two,stop`,
};
const authority = concurrencyAuthority(env)!;
const faultEnv = {
  ...env,
  FACTORY_CONCURRENCY_SCENARIO: "lease-fault",
  FACTORY_CONCURRENCY_ACK: `${repository}:${unit}:start,activate-two,contend,pause-b,freeze-inner-contend-unfreeze,stop-stale,restart,resume-b,stop`,
};
const faultAuthority = concurrencyAuthority(faultEnv)!;
describe("prospective concurrency observation window", () => {
  it("keeps omitted and explicit 45-minute authority byte-equivalent", () => {
    const original = JSON.stringify(authority);
    expect(
      JSON.stringify(concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: "45" })),
    ).toBe(original);
    concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: "120" });
    expect(JSON.stringify(concurrencyAuthority(env))).toBe(original);
  });
  it.each([
    "",
    "44",
    "121",
    "0",
    "-45",
    "45.5",
    "60.0",
    "1e2",
    " 60",
    "60 ",
    "060",
    "Infinity",
    "9007199254740992",
  ])("refuses invalid duration %s before entering the installed runner", async (duration) => {
    const run = vi.fn(async () => {});
    await expect(
      main({ ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: duration }, run),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("observes beyond 45 minutes but refuses acceptance or a new action at the original 120-minute boundary", async () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start + 80 * 60000);
    const selectedEnv = { ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: "120" };
    const selected = concurrencyAuthority(selectedEnv)!;
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(start).toISOString(),
      actions: [],
      base: "a".repeat(40),
      actor: { id: 1, login: "fixture" },
      objectives: selected.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const call = vi.fn(async () => ({ run: { state: "active" } }));
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const list = vi.fn(async () => []);
    try {
      await main(selectedEnv, async (_env, _runner, extension) => {
        if (!extension.extendPort) throw Error("missing production extension");
        const port = (await extension.extendPort({
          port: {},
          evidence,
          save: vi.fn(),
          call,
          request,
          list,
          retireClient: vi.fn(),
        })) as Pick<ConcurrencyPort, "pollPair" | "prepare">;
        await expect(port.pollPair("completed", () => true)).resolves.toHaveLength(2);
        now.mockReturnValue(start + 120 * 60000 - 1);
        await expect(
          port.pollPair("completed", () => {
            now.mockReturnValue(start + 120 * 60000);
            return true;
          }),
        ).rejects.toMatchObject({ code: "CHECKPOINT_DEADLINE" });
        const callsBeforeAction = call.mock.calls.length;
        await expect(port.prepare("activate")).rejects.toMatchObject({
          code: "CHECKPOINT_DEADLINE",
        });
        expect(call).toHaveBeenCalledTimes(callsBeforeAction);
        expect(evidence.actions).toEqual([]);
        expect(evidence.startedAt).toBe(new Date(start).toISOString());
      });
    } finally {
      now.mockRestore();
    }
  });
  it("bounds independent final artifact reads by the same original remaining time", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    const failure = Error("bounded read unavailable");
    const request = vi.fn(async () => {
      throw failure;
    });
    try {
      await expect(verifyConcurrencyArtifacts(request, authority, "main", [], 11000)).rejects.toBe(
        failure,
      );
      expect(request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        { ref: "main" },
        1000,
      );
      now.mockReturnValue(11000);
      await expect(
        verifyConcurrencyArtifacts(request, authority, "main", [], 11000),
      ).rejects.toMatchObject({ code: "CHECKPOINT_DEADLINE" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("uses one incremental repository comment listing while unchanged instead of full snapshots", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current - 45 * 60_000 + 1).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const call = vi.fn(async () => ({ run: { state: "active" } }));
    let incrementalListings = 0;
    const stopped = new Error("bounded observation stopped");
    const list = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/issues/comments") {
        incrementalListings++;
        if (incrementalListings === 3) throw stopped;
      }
      return [];
    });
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call,
            request,
            list,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", () => false);
        }),
      ).rejects.toBe(stopped);
      expect(incrementalListings).toBe(3);
      expect(request).toHaveBeenCalledTimes(2);
      expect(call).toHaveBeenCalledTimes(2);
      expect(
        (evidence as typeof evidence & { observer: Record<string, unknown> }).observer,
      ).toMatchObject({
        fullObjectiveSnapshots: 2,
        incrementalCommentListings: 2,
        unchangedIncrementalListings: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("treats overlap, untrusted comments and cached receipts only as hints before fresh convergence", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current - 45 * 60_000 + 1).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const at = new Date(current + 1_000).toISOString();
    const comment = (objective: number, id: number, userId = 1) => ({
      id,
      body: `fixture\n\n<!-- clockgrove-factory:event\n${JSON.stringify({
        protocol: "clockgrove.factory/v2",
        kind: "controller",
        event: "ControllerObserved",
        objective,
        runId: `run-${objective}`,
        sequence: 1,
        at,
      })}\n-->`,
      html_url: `https://github.com/${repository}/issues/${objective}#issuecomment-${id}`,
      created_at: at,
      updated_at: at,
      user: { id: userId, login: userId === 1 ? "fixture" : "outsider" },
    });
    const trusted = [comment(10, 201), comment(11, 202)];
    const outsider = comment(10, 200, 2);
    let objectiveReads = 0;
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      objectiveReads++;
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const call = vi.fn(async () => ({ run: { state: "active" } }));
    let incrementalListings = 0;
    const list = vi.fn(async (route: string, args: { issue_number?: number }) => {
      if (route === "GET /repos/{owner}/{repo}/issues/comments") {
        incrementalListings++;
        return incrementalListings === 1 ? [outsider] : [outsider, ...trusted];
      }
      if (route.endsWith("/sub_issues")) return [];
      if (route.endsWith("/{issue_number}/comments")) {
        const round = Math.floor((objectiveReads - 1) / 2);
        if (round === 0 || (round === 1 && args.issue_number === 11)) return [];
        return trusted.filter((entry) => entry.html_url.includes(`/issues/${args.issue_number}#`));
      }
      return [];
    });
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call,
            request,
            list,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", (pair) =>
            pair.every((entry) =>
              (entry as { receipts: Array<{ event: { event: string } }> }).receipts.some(
                ({ event }) => event.event === "ControllerObserved",
              ),
            ),
          );
        }),
      ).resolves.toBeUndefined();
      expect(incrementalListings).toBe(3);
      // Baseline, incomplete fresh confirmation, then converged fresh confirmation.
      expect(request).toHaveBeenCalledTimes(6);
      expect(call).toHaveBeenCalledTimes(6);
      expect(
        vi
          .mocked(list)
          .mock.calls.filter(([route]) => route === "GET /repos/{owner}/{repo}/issues/comments")
          .map(([, args]) => args),
      ).toEqual([
        expect.objectContaining({ since: expect.any(String), sort: "updated", direction: "asc" }),
        expect.objectContaining({ since: expect.any(String), sort: "updated", direction: "asc" }),
        expect.objectContaining({ since: expect.any(String), sort: "updated", direction: "asc" }),
      ]);
    } finally {
      now.mockRestore();
    }
  });
});
describe("prospective concurrent qualification attempts", () => {
  it("bounds both Objectives to their original attempt without changing shared controller ceilings", () => {
    expect(parseRunPolicy(authority.policy).maxAttemptsPerItem).toBe(1);
    expect(authority.namespaces).toHaveLength(2);
    expect(authority.controllerLocalCeiling).toBe(8);
    expect(authority.aggregateObservedThreshold).toBe(500000);
  });
  it("preserves the original authority when the per-Objective option is omitted or explicitly 250000", () => {
    const original = structuredClone(authority);
    expect(
      concurrencyAuthority({
        ...env,
        FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      }),
    ).toEqual(original);
    concurrencyAuthority({
      ...env,
      FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
      FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: "1000000",
    });
    expect(authority).toEqual(original);
    expect(concurrencyAuthority(env)).toEqual(original);
  });
  it.each([
    [250000, 45],
    [400000, 60],
    [500000, 120],
  ])(
    "binds both prospective activations to the explicit %i threshold and %i minute window",
    async (limit, minutes) => {
      const selectedEnv = {
        ...env,
        FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: String(limit),
        FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: String(2 * limit),
        FACTORY_CONCURRENCY_DURATION_MINUTES: String(minutes),
      };
      const selected = concurrencyAuthority(selectedEnv)!;
      expect(selected).toEqual({
        ...authority,
        aggregateObservedThreshold: 2 * limit,
        policy: {
          ...authority.policy,
          objectiveTimeoutMinutes: minutes,
          economics: { ...parseRunPolicy(authority.policy).economics, maxModelTokens: limit },
        },
      });
      expect(parseRunPolicy(selected.policy).maxAttemptsPerItem).toBe(1);
      const evidence = {
        actions: [],
        startedAt: new Date().toISOString(),
        base: "a".repeat(40),
        defaultBranch: "main",
        objectives: selected.namespaces.map((namespace, index) => ({
          namespace,
          objective: { number: 10 + index },
        })),
      };
      const call = vi.fn(async (_tool: string, _args: Record<string, unknown>) => ({}));
      await main(selectedEnv, async (_env, _runner, extension) => {
        expect(extension.observationWindowMinutes).toBe(minutes);
        if (!extension.extendPort) throw Error("missing production extension");
        const port = (await extension.extendPort({
          port: {},
          evidence,
          save: vi.fn(),
          call,
          request: vi.fn(async () => ({ data: { sha: evidence.base } })),
          list: vi.fn(async () => []),
          retireClient: vi.fn(),
        })) as Pick<ConcurrencyPort, "prepare">;
        await port.prepare("activate");
      });
      expect(call).toHaveBeenCalledTimes(2);
      for (const [index, namespace] of selected.namespaces.entries())
        expect(call).toHaveBeenNthCalledWith(index + 1, "factory_activate", {
          owner: "example",
          repo: "disposable",
          objectiveNumber: 10 + index,
          requestId: `${namespace}-activate`,
          baseSha: evidence.base,
          policy: selected.policy,
        });
      const f = scenarioPort();
      expect(await runConcurrencyScenario(f.port, selected)).toMatchObject({
        aggregateObservedThreshold: 2 * limit,
        controllerLocalCeiling: 8,
        authorizedScenarioWorkerMaximum: 2,
      });
    },
  );
  it.each([
    [undefined, undefined],
    [undefined, "1000000"],
    ["400000", undefined],
    ["400000", "500000"],
    ["400000", "800001"],
    ["400000", "0800000"],
    ["249999", "499998"],
    ["500001", "1000002"],
    ["0", "0"],
    ["250000.5", "500001"],
    ["2.5e5", "500000"],
    [" 250000", "500000"],
    ["0250000", "500000"],
    ["NaN", "NaN"],
    ["", "500000"],
    ["9007199254740992", "18014398509481984"],
  ])(
    "refuses invalid per-Objective %s / aggregate %s before any runner action",
    async (perObjective, aggregate) => {
      const run = vi.fn(async () => {});
      await expect(
        main(
          {
            ...env,
            FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: perObjective,
            FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: aggregate,
          },
          run,
        ),
      ).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );
});
describe("stale controller stop identity fence", () => {
  const original = { unit, pid: 1234, invocationId: "a".repeat(32) };
  const configPath = `/home/example/.config/systemd/user/${unit}`;
  const fields = {
    Id: unit,
    LoadState: "loaded",
    FragmentPath: configPath,
    DropInPaths: "",
    NeedDaemonReload: "no",
    Job: "",
    ActiveState: "failed",
    SubState: "failed",
    MainPID: "0",
    InvocationID: original.invocationId,
    ExecMainPID: "1234",
    ExecMainCode: "1",
    ExecMainStatus: "1",
    Result: "exit-code",
  };
  it("accepts the actual original exit1 failure and still-pending auto-restart, never an assumed exit2", () => {
    expect(() => assertRetiredController(fields, original, configPath)).not.toThrow();
    expect(() =>
      assertRetiredController(
        { ...fields, ActiveState: "activating", SubState: "auto-restart" },
        original,
        configPath,
      ),
    ).not.toThrow();
  });
  it("refuses active, pending or already replaced controller generations", () => {
    for (const changed of [
      { MainPID: "1235" },
      { Job: "123 /job/123" },
      { InvocationID: "b".repeat(32) },
      { ActiveState: "activating", SubState: "start" },
      { ExecMainStatus: "2" },
      { DropInPaths: "/unexpected.conf" },
    ]) {
      expect(() =>
        assertRetiredController({ ...fields, ...changed }, original, configPath),
      ).toThrow();
    }
  });
});
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString();
const event = (
  objective: number,
  sequence: number,
  name: string,
  seconds: number,
  workItem = objective * 10,
) => ({
  objective,
  runId: `run-${objective}`,
  sequence,
  event: name,
  at: at(seconds),
  workItem,
  attempt: 1,
});
const observation = (events: Record<string, unknown>[]) => ({
  receipts: events.map((event) => ({ event })),
});
function pair(closed = true) {
  return [
    observation([
      event(1, 1, "ControllerObserved", 0),
      event(1, 2, "AttemptStarted", 1),
      ...(closed
        ? [
            event(1, 3, "AttemptSucceeded", 20),
            event(1, 4, "AttemptStarted", 22, 11),
            event(1, 5, "AttemptSucceeded", 25, 11),
          ]
        : []),
    ]),
    observation([
      event(2, 1, "ControllerObserved", 0),
      event(2, 2, "AttemptStarted", 2),
      event(2, 3, "AttemptSucceeded", 4),
      event(2, 4, "AttemptStarted", 6, 21),
      event(2, 5, "AttemptSucceeded", 9, 21),
      event(2, 6, "RunPauseRequested", 10),
    ]),
  ];
}

describe("installed two-Objective qualification authority", () => {
  it("preserves controller8 and derives scenario2 from two explicit one-worker policies", () => {
    expect(authority).toMatchObject({
      controllerLocalCeiling: 8,
      authorizedScenarioWorkerMaximum: 2,
      aggregateObservedThreshold: 500000,
      namespaces: ["concurrency-fixture-a", "concurrency-fixture-b"],
      policy: {
        maxParallel: 1,
        capacity: { local: { maxWorkers: 1, reserveCpu: 0.5, reserveMemoryMb: 1024 } },
        allowedPaidBackends: [],
        economics: { maxModelTokens: 250000, modelTokenBudgetMode: "observed-stop" },
        models: {
          mode: "single-profile",
          profiles: { qualification: { model: "fixture-model", reasoning: "high" } },
          phaseProfiles: {
            compile: "qualification",
            implement: "qualification",
            review: "qualification",
            recover: "qualification",
          },
        },
      },
    });
  });
  it("requires new explicit two-Objective exercise authority, default-home auth and bounded namespace", () => {
    expect(concurrencyAuthority({})).toBeNull();
    expect(() => concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_ACK: undefined })).toThrow();
    expect(() =>
      concurrencyAuthority({ ...env, GH_TOKEN: "synthetic-not-a-credential" }),
    ).toThrow();
    expect(() =>
      concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: "1000000" }),
    ).toThrow();
    expect(() =>
      concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_NAMESPACE: "a".repeat(48) }),
    ).toThrow();
    expect(
      concurrencyAuthority({
        ...env,
        FACTORY_CONCURRENCY_PHASE: "preflight",
        FACTORY_CONCURRENCY_ACK: undefined,
      })?.phase,
    ).toBe("preflight");
  });
  it("requires exact requested model and reasoning settings without changing product defaults", () => {
    expect(() => concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_MODEL: undefined })).toThrow(
      /model required/,
    );
    expect(() =>
      concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_REASONING: "fashionable" }),
    ).toThrow(/reasoning effort/);
    expect(concurrencyModelConfiguration(pair()[0], authority)).toMatchObject({
      requested: {
        evidence: "immutable-run-policy",
        managementBackend: "codex-cli/local",
      },
      resolved: {
        managementBackend: "codex-cli/local",
        executionBackendOrder: ["codex-sdk/local-worktree", "codex-cli/local-worktree"],
        phases: {
          compile: { model: "fixture-model", reasoning: "high" },
          implement: { model: "fixture-model", reasoning: "high" },
        },
      },
      observed: {
        executionBackends: [],
        providerReturnedModel: "unavailable-not-recorded-in-receipts",
      },
    });
  });
  it("reports the exact graph projection interval and leaves unrecorded costs unavailable", () => {
    const graphDigest = "d".repeat(64);
    const measured = concurrencyMeasurements(
      observation([
        event(1, 1, "FactoryRunStarted", 0),
        { ...event(1, 2, "GraphCompiled", 3), graphDigest, graphSize: 3 },
        { ...event(1, 3, "GraphProjected", 8), graphDigest, graphSize: 3 },
        event(1, 4, "FactoryRunCompleted", 20),
      ]),
      { incrementalCommentListings: 4 },
    );
    expect(measured).toMatchObject({
      run: { availability: "observed", milliseconds: 20_000 },
      graphCompiledToProjected: {
        interval: { availability: "observed", milliseconds: 5_000 },
        projection: { availability: "observed", graphDigest, projectedWorkItems: 3 },
        cpuAndMemory: { availability: "unavailable" },
        modelTokens: { availability: "unavailable" },
      },
      controllerMutationOperations: { availability: "unavailable" },
      githubAccountQuotaAttributedToRun: { availability: "unavailable" },
    });
  });
  it("keeps useful asymmetric work in disjoint original fixture namespaces, never sleep/pressure injection", () => {
    const a = concurrencyObjectiveBody(authority.namespaces[0]!, 0);
    const b = concurrencyObjectiveBody(authority.namespaces[1]!, 1);
    expect(a).toContain("24 individually named edge-case assertions");
    expect(a).toContain("Do not introduce artificial delays");
    expect(b).toContain("Keep both roots minimal");
    expect(a).not.toContain(authority.namespaces[1]!);
    expect(b).not.toContain(authority.namespaces[0]!);
  });
});

describe("independent authenticated timing assertions", () => {
  it("requires a completed B worker and distinct B refill during an A execution lifetime", () => {
    expect(concurrencyRefill(pair())).toMatchObject({
      boundary: "authenticated-worker-lifetimes",
      simultaneousCpu: "not-measured",
      slow: { workItem: 10 },
      released: { workItem: 20 },
      refill: { workItem: 21 },
    });
    expect(concurrencyRefill(pair(false))).not.toBeNull();
    expect(concurrencyRefill([...pair()].reverse())).toMatchObject({
      spanningObjective: 1,
      refillObjective: 0,
      released: { workItem: 20 },
      refill: { workItem: 21 },
    });
    expect(concurrencyReceiptProgress("refill", [...pair()].reverse())).toBe(true);
  });
  it("does not manufacture refill from overlap alone or equal server timestamps", () => {
    const overlap = pair();
    overlap[1]!.receipts.splice(3);
    expect(concurrencyRefill(overlap)).toBeNull();
    const tied = pair();
    tied[1]!.receipts[3]!.event.at = at(4);
    expect(concurrencyRefill(tied)).toBeNull();
    const late = pair();
    late[1]!.receipts[3]!.event.at = at(21);
    late[1]!.receipts[4]!.event.at = at(23);
    expect(concurrencyRefill(late)).toBeNull();
  });
  it("rejects two concurrently started workers in the same one-worker Objective", () => {
    const invalid = pair();
    invalid[1]!.receipts[2]!.event.sequence = 5;
    expect(() => concurrencyRefill(invalid)).toThrow(/one-worker ceiling/);
  });
  it("rejects conflicting terminal events instead of guessing the shorter lifetime", () => {
    const invalid = pair();
    invalid[1]!.receipts.push({ event: event(2, 7, "AttemptFailed", 5) });
    expect(() => concurrencyRefill(invalid)).toThrow(/conflicting worker terminals/);
  });
  it("rejects a refill lifetime with missing attempt identity", () => {
    const invalid = pair();
    delete invalid[1]!.receipts[1]!.event.attempt;
    expect(() => concurrencyRefill(invalid)).toThrow(/identity missing/);
  });
});

describe("actual inner Director lease proof", () => {
  const start = { objective: 2, runId: "run-2", policyDigest: "a".repeat(64) };
  const before = {
    oid: "b".repeat(40),
    parents: ["a".repeat(40)],
    event: {
      ...start,
      protocol: "clockgrove.factory/v2",
      kind: "lease",
      event: "LeaseRenewed",
      holder: "old",
      epoch: 1,
      sequence: 5,
      at: at(10),
    },
  };
  const after = {
    oid: "c".repeat(40),
    parents: [before.oid],
    event: {
      ...before.event,
      holder: "new",
      epoch: 2,
      sequence: 6,
      previousOid: before.oid,
      event: "LeaseAcquired",
      at: at(15),
    },
  };
  it("proves real inner serial takeover without claiming a simultaneous race", () => {
    expect(assertInnerTakeover(before, after, [before], start)).toMatchObject({
      boundary: "inner-Director-serial-takeover",
      simultaneousRace: "not-exercised",
      originalEpoch: 1,
      replacementEpoch: 2,
    });
  });
  it("refuses outer-lease substitution, detached ancestry, same epoch and foreign policy", () => {
    expect(() =>
      assertInnerTakeover(
        before,
        { ...after, event: { ...after.event, kind: "repository-lease" } },
        [before],
        start,
      ),
    ).toThrow();
    expect(() =>
      assertInnerTakeover(before, { ...after, parents: ["d".repeat(40)] }, [before], start),
    ).toThrow();
    expect(() =>
      assertInnerTakeover(
        before,
        { ...after, event: { ...after.event, epoch: 1 } },
        [before],
        start,
      ),
    ).toThrow();
    expect(() =>
      assertInnerTakeover(before, after, [before], { ...start, policyDigest: "f".repeat(64) }),
    ).toThrow();
  });
  it("binds contention to the same Objective lease without consulting repository election", () => {
    const response = {
      isError: true,
      content: [{ type: "text", text: "Objective #2 is leased by old" }],
    };
    expect(assertObjectiveContention({ response, before, after: before, objective: 2 })).toEqual({
      boundary: "objective-lease",
      objective: 2,
      leaseOid: before.oid,
      outerRepositoryLease: "not-consulted",
    });
    expect(() => assertObjectiveContention({ response, before, after, objective: 2 })).toThrow(
      /changed the lease/,
    );
  });
});

function scenarioPort() {
  const actions: string[] = [];
  const port: ConcurrencyPort = {
    preflight: async () => {
      actions.push("preflight");
      return {};
    },
    prepare: async (stage) => {
      actions.push(`prepare:${stage}`);
    },
    stagger: async () => {
      actions.push("model-free-offset");
    },
    action: async (action) => {
      actions.push(action);
    },
    controller: async (state) => {
      actions.push(`controller:${state}`);
      return { invocationId: String(actions.length), hostIdentity: "same-host" };
    },
    contend: async () => {
      actions.push("same-objective-contend");
    },
    pollPair: async (phase, accept) => {
      actions.push(phase);
      const value = pair();
      expect(accept(value)).toBe(true);
      return value;
    },
    scoped: async (action) => {
      actions.push(`${action}-b`);
    },
    settled: () => true,
    captureCheckpoint: async () => {
      actions.push("accounted-absence-inner-capture");
    },
    innerContend: async () => {
      actions.push("frozen-inner-held-contention-exact-thaw");
    },
    takeover: async () => {
      actions.push("outer-takeover");
    },
    finishThroughput: async () => {
      actions.push("throughput-final-proofs");
      return {};
    },
    finish: async () => {
      actions.push("exact-final-proofs");
      return {};
    },
  };
  return { port, actions };
}

describe("bounded existing installed-controller composition", () => {
  it("does no exercise action in preflight", async () => {
    const f = scenarioPort();
    expect(
      await runConcurrencyScenario(f.port, { ...authority, phase: "preflight" }),
    ).toMatchObject({ result: "preflight-only" });
    expect(f.actions).toEqual(["preflight"]);
  });
  it("runs useful throughput without manufactured delay or injected fault work", async () => {
    const f = scenarioPort();
    const result = await runConcurrencyScenario(f.port, authority);
    expect(result).toMatchObject({
      result: "passed",
      scope: "installed-two-objective-useful-throughput-refill",
      artificialDelayMs: 0,
      injectedFaults: 0,
      comparativeSavings: "not-measured",
    });
    expect(f.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "prepare:activate",
      "both-started",
      "refill",
      "completed",
      "stop",
      "controller:inactive",
      "throughput-final-proofs",
    ]);
  });
  it("keeps expiry, same-Objective contention and restart in an explicit fault scenario", async () => {
    const f = scenarioPort();
    const result = await runConcurrencyLeaseFaultScenario(f.port, faultAuthority);
    expect(result).toMatchObject({
      result: "passed",
      innerLeaseHeldContention: "observed",
      simultaneousInnerCasCollision: "not-exercised",
    });
    expect(f.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "model-free-offset",
      "prepare:activate",
      "both-started",
      "same-objective-contend",
      "refill",
      "pause-b",
      "scoped-pause",
      "peer-completed",
      "accounted-absence-inner-capture",
      "frozen-inner-held-contention-exact-thaw",
      "restart",
      "controller:active",
      "outer-takeover",
      "resume-b",
      "completed",
      "stop",
      "controller:inactive",
      "exact-final-proofs",
    ]);
  });
  it("does not retry or automatically restart/stop after an ambiguous exercise failure", async () => {
    const f = scenarioPort();
    f.port.scoped = async () => {
      throw Error("response unavailable");
    };
    await expect(runConcurrencyLeaseFaultScenario(f.port, faultAuthority)).rejects.toThrow(
      "response unavailable",
    );
    expect(f.actions).not.toContain("restart");
    expect(f.actions).not.toContain("stop");
    expect(f.actions).not.toContain("exact-final-proofs");
  });
  it("leaves the settled peer paused and forbids continuation after an uncertain inner contender", async () => {
    const f = scenarioPort();
    f.port.innerContend = async () => {
      throw Error("inner contender outcome is unknown; no automatic continuation");
    };
    await expect(runConcurrencyLeaseFaultScenario(f.port, faultAuthority)).rejects.toThrow(
      /outcome is unknown/,
    );
    expect(f.actions).toContain("accounted-absence-inner-capture");
    for (const action of ["restart", "resume-b", "stop", "exact-final-proofs"])
      expect(f.actions).not.toContain(action);
  });
  it("uses committed checkpoint main extension and inventories all new evidence dependencies", async () => {
    const run = vi.fn(async () => {});
    await main(env, run);
    expect(run).toHaveBeenCalledWith(
      env,
      runConcurrencyScenario,
      expect.objectContaining({
        authority,
        scope: "installed-two-objective-useful-throughput",
        harnessPaths: expect.arrayContaining([
          "scripts/verify-local-concurrency.mjs",
          "scripts/qualification-sibling-refresh-proof.mjs",
          "scripts/qualification-model-accounting.mjs",
        ]),
      }),
    );
  });
});

describe("retained artifact proof refuses unbound Git inputs before local evaluation", () => {
  const finalSha = "a".repeat(40),
    treeSha = "b".repeat(40),
    blobSha = "c".repeat(40);
  const finalEvidence = [{ events: [{ event: "AttemptIntegrated", headSha: finalSha }] }];
  it("refuses an unrelated default-branch tip", async () => {
    const request = vi.fn(async () => ({ data: { sha: "d".repeat(40) } }));
    await expect(
      verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
    ).rejects.toThrow(/outside exact proved integrations/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["120000", "100755"])(
    "refuses unexpected file mode %s rather than materializing it",
    async (mode) => {
      const request = vi.fn(async (route: string) =>
        route.endsWith("commits/{ref}")
          ? { data: { sha: finalSha, commit: { tree: { sha: treeSha } } } }
          : {
              data: {
                truncated: false,
                tree: [
                  {
                    path: qualificationPaths(authority.namespaces[0]!).files[0],
                    mode,
                    type: "blob",
                    sha: blobSha,
                    size: 3,
                  },
                ],
              },
            },
      );
      await expect(
        verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("refuses truncated tree evidence and oversized blobs without downloading their contents", async () => {
    const tree = { truncated: true, tree: [] as unknown[] };
    const request = vi.fn(async (route: string) =>
      route.endsWith("commits/{ref}")
        ? { data: { sha: finalSha, commit: { tree: { sha: treeSha } } } }
        : { data: tree },
    );
    await expect(
      verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
    ).rejects.toThrow();
    tree.truncated = false;
    tree.tree = [
      {
        path: qualificationPaths(authority.namespaces[0]!).files[0],
        mode: "100644",
        type: "blob",
        sha: blobSha,
        size: 65537,
      },
    ];
    await expect(
      verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(4);
  });
});
