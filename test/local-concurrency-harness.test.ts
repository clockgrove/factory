import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import {
  concurrencyAuthority,
  concurrencyObjectiveBody,
  concurrencyRefill,
  assertInnerTakeover,
  assertRetiredController,
  main,
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
  FACTORY_CONCURRENCY_ACK: `${repository}:${unit}:start,activate-two,contend,pause-b,freeze-inner-contend-unfreeze,stop-stale,restart,resume-b,stop`,
};
const authority = concurrencyAuthority(env)!;
describe("prospective concurrent qualification attempts", () => {
  it("bounds both Objectives to their original attempt without changing shared controller ceilings", () => {
    expect(parseRunPolicy(authority.policy).maxAttemptsPerItem).toBe(1);
    expect(authority.namespaces).toHaveLength(2);
    expect(authority.controllerLocalCeiling).toBe(8);
    expect(authority.aggregateObservedThreshold).toBe(500000);
  });
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
      actions.push("outer-contend");
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
  it("orders scoped pause, peer progress, accounted absence, restart and exact final proof", async () => {
    const f = scenarioPort();
    const result = await runConcurrencyScenario(f.port, authority);
    expect(result).toMatchObject({
      result: "passed",
      innerLeaseHeldContention: "observed",
      simultaneousInnerCasCollision: "not-exercised",
      comparativeSavings: "not-measured",
    });
    expect(f.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "model-free-offset",
      "prepare:activate",
      "both-started",
      "outer-contend",
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
    await expect(runConcurrencyScenario(f.port, authority)).rejects.toThrow("response unavailable");
    expect(f.actions).not.toContain("restart");
    expect(f.actions).not.toContain("stop");
    expect(f.actions).not.toContain("exact-final-proofs");
  });
  it("leaves the settled peer paused and forbids continuation after an uncertain inner contender", async () => {
    const f = scenarioPort();
    f.port.innerContend = async () => {
      throw Error("inner contender outcome is unknown; no automatic continuation");
    };
    await expect(runConcurrencyScenario(f.port, authority)).rejects.toThrow(/outcome is unknown/);
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
        scope: "installed-two-objective-concurrency",
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
