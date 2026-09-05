import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assessLocalFault,
  authenticatedFaultEvents,
  boundedPoll,
  faultObjective,
  faultPolicy,
  parseUnitObservation,
  scopeUnit,
} from "../scripts/verify-local-faults.mjs";
import { parseRunPolicy } from "../src/protocol/policy.js";
import { localScopeUnit } from "../src/runtime/local-scope.js";
import { parseLocalScopeIdentity } from "../src/protocol/local-scope.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = parseLocalScopeIdentity({
  protocol: "clockgrove.factory/local-scope-v1",
  repository: "fixture/private",
  objective: 7,
  workItem: 8,
  attempt: 1,
  runId: "fixture",
  directorEpoch: 1,
  policyDigest: "a".repeat(64),
  phase: "execution",
  commandIndex: 0,
  invocationDigest: "b".repeat(64),
  hostIdentity: "c".repeat(64),
  producerUnit: "factory-fixture.service",
  producerInvocationId: "d".repeat(32),
});
function fixture(scenario: "cancel" | "restart" = "cancel") {
  const reserved = {
    runId: "fixture",
    event: "AttemptReserved",
    sequence: 3,
    workItem: 8,
    attempt: 1,
    localScopeBatch: { identity },
  };
  const policy = parseRunPolicy(faultPolicy(250000, scenario));
  const events: Record<string, unknown>[] = [
    { runId: "fixture", event: "FactoryRunStarted", sequence: 1, policy },
    { runId: "fixture", event: "ControllerObserved", controllerId: "first", sequence: 2 },
    reserved,
    {
      runId: "fixture",
      event: "AttemptStarted",
      sequence: 4,
      workItem: 8,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
      providerResourceId: "owned-worker",
    },
  ];
  if (scenario === "restart")
    events.push(
      { runId: "fixture", event: "RunPauseRequested", requestId: "pause", sequence: 5 },
      { runId: "fixture", event: "ControllerObserved", controllerId: "second", sequence: 6 },
    );
  if (scenario === "cancel")
    events.push(
      {
        runId: "fixture",
        event: "FactoryRunCancellationRequested",
        sequence: 7,
        requestId: "cancel",
      },
      { runId: "fixture", event: "AttemptCancelled", sequence: 8, workItem: 8, attempt: 1 },
      { runId: "fixture", event: "FactoryRunCancelled", sequence: 9 },
    );
  else
    events.push(
      { runId: "fixture", event: "AttemptCancelled", sequence: 7, workItem: 8, attempt: 1 },
      {
        runId: "fixture",
        event: "WorkItemRetryRequested",
        sequence: 8,
        workItem: 8,
        requestId: "retry",
      },
      { runId: "fixture", event: "RunResumeRequested", sequence: 9, requestId: "resume" },
      { runId: "fixture", event: "AttemptReserved", sequence: 10, workItem: 8, attempt: 2 },
      {
        runId: "fixture",
        event: "AttemptStarted",
        sequence: 11,
        workItem: 8,
        attempt: 2,
        backend: "codex-sdk/local-worktree",
        providerResourceId: "retried-worker",
      },
      { runId: "fixture", event: "AttemptIntegrated", sequence: 12, workItem: 8, attempt: 2 },
      { runId: "fixture", event: "FactoryRunCompleted", sequence: 13 },
    );
  return {
    scenario,
    runId: "fixture",
    injected: true,
    maxModelTokens: 250000,
    installedArtifact: { digest: "installed" },
    finishedInstalledArtifact: { digest: "installed" },
    faultRequestId: "fault",
    pauseRequestId: "pause",
    cancelRequestId: "cancel",
    retryRequestId: "retry",
    resumeRequestId: "resume",
    resumeAfterAbsence: true,
    receipts: events.map((event) => ({ event })),
    status: { summary: { attempts: { active: 0 } }, capacity: { activeReservations: [] } },
    before: {
      identity,
      reservationDigest: digest(reserved),
      hostIdentity: identity.hostIdentity,
      scope: { unit: scopeUnit(identity), status: "active" },
      controller: { invocationId: "old" },
    },
    after: {
      hostIdentity: identity.hostIdentity,
      scope: { unit: scopeUnit(identity), status: "absent" },
      controller: { invocationId: "new", status: "active" },
    },
  };
}
describe("installed local fault qualification harness", () => {
  it("uses bounded local-only authority and namespaced single-item paths", () => {
    const policy = parseRunPolicy(faultPolicy(250000));
    expect(policy.maxParallel).toBe(1);
    expect(policy.allowedPaidBackends).toEqual([]);
    expect(policy.economics?.maxModelTokens).toBe(250000);
    expect(faultObjective("fixture-qualification")).toContain(
      "factory-fault-qualification/fixture-qualification/sum-even.mjs",
    );
    expect(() => faultObjective("../escape")).toThrow();
  });
  it("derives the actual production unit independently of incoming property order", () => {
    expect(scopeUnit(Object.fromEntries(Object.entries(identity).reverse()))).toBe(
      localScopeUnit(identity),
    );
    expect(() => scopeUnit({ ...identity, extra: true })).toThrow();
    expect(() => scopeUnit({ ...identity, producerUnit: "other;kill.service" })).toThrow();
  });
  it("requires complete exact-unit observations, never exit-code-only absence", () => {
    const unit = scopeUnit(identity);
    const absent = `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group`;
    expect(parseUnitObservation(unit, absent).status).toBe("absent");
    expect(parseUnitObservation(unit, absent.replace("Job=", "Job=12")).status).toBe("unknown");
    expect(parseUnitObservation(unit, absent.replace("not-found", "error")).status).toBe("unknown");
    expect(() => parseUnitObservation(unit, `${absent}\nId=foreign`)).toThrow();
  });
  it("authenticates actor IDs, preserves duplicate semantics, and rejects conflicts", () => {
    const actor = { id: 3, login: "Operator" };
    const event = {
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: "fixture",
      sequence: 1,
      event: "FactoryRunCancelled",
    };
    const comment = {
      id: 1,
      user: actor,
      body: `<!-- clockgrove-factory:event\n${JSON.stringify(event)}\n-->`,
    };
    expect(authenticatedFaultEvents([comment, comment], actor, 7)).toHaveLength(1);
    expect(authenticatedFaultEvents([{ ...comment, user: { ...actor, id: 4 } }], actor, 7)).toEqual(
      [],
    );
    expect(() =>
      authenticatedFaultEvents(
        [
          comment,
          { ...comment, body: comment.body.replace("FactoryRunCancelled", "FactoryRunCompleted") },
        ],
        actor,
        7,
      ),
    ).toThrow(/conflicting/);
  });
  it.each(["cancel", "restart"] as const)(
    "accepts only the bounded evidenced %s scenario",
    (scenario) => {
      expect(assessLocalFault(fixture(scenario))).toMatchObject({ result: "passed" });
    },
  );
  it.each(["resource", "host", "artifact", "reservation", "duplicate", "terminal", "actor-scope"])(
    "keeps %s uncertainty incomplete",
    (fault) => {
      const evidence = fixture();
      if (fault === "resource") evidence.after.scope.status = "unknown";
      if (fault === "host") evidence.after.hostIdentity = "e".repeat(64);
      if (fault === "artifact") evidence.finishedInstalledArtifact.digest = "changed";
      if (fault === "terminal")
        evidence.receipts = evidence.receipts.filter(
          ({ event }) => event.event !== "FactoryRunCancelled",
        );
      if (fault === "actor-scope") evidence.before.reservationDigest = "wrong";
      if (fault === "duplicate")
        evidence.receipts.push({
          event: {
            ...evidence.receipts[3]!.event,
            providerResourceId: "second-worker",
            sequence: 5,
          },
        });
      if (fault === "reservation")
        evidence.receipts.push({
          event: {
            runId: "fixture",
            event: "CapacityReserved",
            sequence: 4,
            kind: "capacity",
            workItem: 8,
            attempt: 1,
            phase: "validation",
            backend: "factory/local-validation",
          },
        });
      expect(assessLocalFault(evidence).result).toBe("incomplete");
    },
  );
  it("does not qualify restart from unchanged controller generation or missing pause/resume", () => {
    const evidence = fixture("restart");
    evidence.after.controller.invocationId = "old";
    evidence.receipts = evidence.receipts.filter(
      ({ event }) => event.event !== "RunPauseRequested",
    );
    expect(assessLocalFault(evidence).blockers).toContain(
      "controller-generation-transition-unproven",
    );
    expect(assessLocalFault(evidence).blockers).toContain("durable-pause-unobserved");
  });
  it.each(["late-control", "missing-start", "unexpected-retry", "foreign-unit"])(
    "rejects %s instead of claiming restart recovery",
    (fault) => {
      const evidence = fixture("restart");
      if (fault === "late-control")
        evidence.receipts.find(({ event }) => event.event === "RunPauseRequested")!.event.sequence =
          20;
      if (fault === "missing-start")
        evidence.receipts = evidence.receipts.filter(
          ({ event }) => event.event !== "AttemptStarted",
        );
      if (fault === "unexpected-retry")
        evidence.receipts.push({
          event: {
            runId: "fixture",
            event: "AttemptReserved",
            sequence: 12,
            workItem: 8,
            attempt: 3,
          },
        });
      if (fault === "foreign-unit")
        evidence.before.scope.unit = evidence.after.scope.unit = "other.scope";
      expect(assessLocalFault(evidence).result).toBe("incomplete");
    },
  );
  it("polls mechanically with a finite deadline and no escalation into another action", async () => {
    let time = 0;
    let calls = 0;
    await expect(
      boundedPoll(
        async () => ++calls,
        () => false,
        {
          milliseconds: 10,
          interval: 5,
          now: () => time,
          wait: async (ms) => {
            time += ms;
          },
        },
      ),
    ).rejects.toThrow("bounded-observation-incomplete");
    expect(calls).toBe(3);
  });
});
