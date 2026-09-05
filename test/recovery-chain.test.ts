import { describe, expect, it } from "vitest";
import { compiledGraphRef, compiledGraphProjectionRef } from "../src/control/graphs.js";
import { type FactoryEvent, parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, type RunPolicy, policyDigest } from "../src/protocol/policy.js";
import {
  verifyRecoveryChain,
  recoveryClaimRef,
  recoveryEventDigest,
  recoverySourceEventsDigest,
  recoveryUnknownUsageDigest,
  type RecoveryClaimObservation,
} from "../src/recovery/chain.js";
import {
  RECOVERY_PLAN_PROTOCOL,
  recoveryPlanDigest,
  recoveryPlanRef,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  type RecoveryPlan,
  type RecoveryPlanRecord,
} from "../src/recovery/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const policy: RunPolicy = {
  ...DEFAULT_RUN_POLICY,
  economics: {
    maxModelTokens: 1000,
    maxSandboxMinutes: 0,
    maxManagedSessions: 0,
    minCloudTimeSavedMinutes: 0,
  },
};
function event(fields: Record<string, unknown>): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "source",
    sequence: 1,
    at: "2026-09-04T00:00:00Z",
    ...fields,
  });
}
function history(runId = "source", offset = 0, acceptedPolicy = policy): FactoryEvent[] {
  return [
    event({
      kind: "run",
      event: "FactoryRunStarted",
      runId,
      sequence: offset + 1,
      actor: "operator",
      repository: "o/r",
      objectiveAuthor: "operator",
      fork: false,
      baseBranch: "main",
      baseSha: sha("a"),
      policy: acceptedPolicy,
      policyDigest: policyDigest(acceptedPolicy),
    }),
    event({
      kind: "budget",
      event: "BudgetReconciled",
      runId,
      sequence: offset + 2,
      phase: "management",
      unit: "model_tokens",
      amount: 10,
      usageId: `compile-${digest("c")}`,
    }),
    event({ kind: "run", event: "FactoryRunEscalated", runId, sequence: offset + 10 }),
  ];
}
function proposal(
  events: FactoryEvent[],
  successor = "successor",
  prior: RecoveryPlan | null = null,
): RecoveryPlan {
  const starts = events
    .filter((value) => value.event === "FactoryRunStarted")
    .sort((a, b) => a.sequence - b.sequence);
  const entries = starts.map((start) => {
    const terminal = events.find(
      (value) => value.runId === start.runId && value.event === "FactoryRunEscalated",
    )!;
    return {
      runId: start.runId,
      startDigest: recoveryEventDigest(start),
      terminalDigest: recoveryEventDigest(terminal),
      terminalEvent: "FactoryRunEscalated" as const,
      terminalSequence: terminal.sequence,
      policyDigest: String(start.policyDigest),
    };
  });
  const last = entries.at(-1)!;
  const sourceEventMaxSequence = Math.max(
    ...events.filter((value) => value.kind !== "recovery").map((value) => value.sequence),
  );
  const items: RecoveryPlan["items"] = [
    {
      workItem: 8,
      issueNodeId: "I_8",
      compilerId: "work",
      action: "execute",
      source: null,
      observedPullRequest: null,
      resources: { state: "not-required", receiptDigest: null, identities: [] },
    },
  ];
  const acceptedPolicy = prior?.acceptedPolicy ?? policy;
  const allowance = prior?.allowance.after ?? {
    modelTokens: 1000,
    sandboxMinutes: 0,
    managedSessions: 0,
    implementationAttemptsPerItem: 3,
  };
  return {
    protocol: RECOVERY_PLAN_PROTOCOL,
    repository: "o/r",
    repositoryId: "R_1",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: `request-${successor}`,
    successorRunId: successor,
    predecessor: {
      runId: last.runId,
      startDigest: last.startDigest,
      terminalDigest: last.terminalDigest,
      terminalEvent: last.terminalEvent,
      terminalSequence: last.terminalSequence,
    },
    history: entries,
    historyDigest: recoveryHistoryDigest(entries),
    sourceEventMaxSequence,
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 7,
      runIds: entries.map((entry) => entry.runId),
      events,
      maxSequence: sourceEventMaxSequence,
    }),
    priorPlanDigest: prior ? recoveryPlanDigest(prior) : null,
    expectedBaseSha: sha("a"),
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: compiledGraphRef(7, "source"),
      commitOid: sha("b"),
      blobOid: sha("c"),
      digest: digest("d"),
      projection: {
        ref: compiledGraphProjectionRef(7, "source"),
        commitOid: sha("d"),
        blobOid: sha("e"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: structuredClone(acceptedPolicy),
    policyDigest: policyDigest(acceptedPolicy),
    allowance: {
      before: { ...allowance },
      increment: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 0,
      },
      after: { ...allowance },
    },
    unknownUsageAcknowledgementDigest: null,
    items,
  };
}
function record(plan: RecoveryPlan): RecoveryPlanRecord {
  const digest = recoveryPlanDigest(plan);
  return { plan, digest, ref: recoveryPlanRef(7, digest), commitOid: sha("b"), blobOid: sha("c") };
}
function admitted(plan: RecoveryPlan) {
  const planDigest = recoveryPlanDigest(plan);
  const sequence = plan.sourceEventMaxSequence;
  const claim: RecoveryClaimObservation = {
    ref: recoveryClaimRef(7, plan.predecessor.runId),
    oid: sha("f"),
    repository: "o/r",
    objective: 7,
    requestId: plan.requestId,
    planDigest,
    predecessorRunId: plan.predecessor.runId,
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    successorRunId: plan.successorRunId,
  };
  const request = event({
    kind: "recovery",
    event: "RecoveryRequested",
    runId: plan.predecessor.runId,
    sequence: sequence + 1,
    requestedBy: "operator",
    requestId: plan.requestId,
    repository: "o/r",
    planDigest,
    predecessorRunId: plan.predecessor.runId,
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    successorRunId: plan.successorRunId,
    policyDigest: plan.policyDigest,
    baseSha: plan.expectedBaseSha,
  });
  const consumed = event({
    kind: "recovery",
    event: "RecoveryConsumed",
    runId: plan.successorRunId,
    sequence: sequence + 3,
    recoveryRequestId: plan.requestId,
    planDigest,
    predecessorRunId: plan.predecessor.runId,
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    claimRef: claim.ref,
    claimOid: claim.oid,
  });
  const source = history(plan.successorRunId, sequence + 1, plan.acceptedPolicy);
  source[1]!.sequence = sequence + 5;
  Object.assign(source[0]!, {
    recoveryRequestId: plan.requestId,
    recoveryPlanDigest: planDigest,
    predecessorRunId: plan.predecessor.runId,
  });
  const completed = event({
    ...consumed,
    event: "RecoveryAdoptionCompleted",
    sequence: sequence + 4,
    evidenceDigest: digest("1"),
    sourceEventsDigest: plan.sourceEventsDigest,
    accountingDigest: digest("2"),
    resourceEvidenceDigest: digest("3"),
    baseSha: plan.expectedBaseSha,
  });
  return { events: [request, consumed, completed, ...source], claim };
}
function fixture() {
  const events = history();
  return {
    repository: "o/r",
    repositoryId: "R_1",
    objective: 7,
    objectiveNodeId: "I_7",
    historyComplete: true,
    events,
    candidatePlan: proposal(events),
    plansByDigest: {} as Record<string, RecoveryPlanRecord>,
    claims: [] as RecoveryClaimObservation[],
  };
}
function successorFixture() {
  const value = fixture();
  const first = value.candidatePlan;
  first.allowance.increment.modelTokens = 100;
  first.allowance.after.modelTokens = 1100;
  first.acceptedPolicy.economics!.maxModelTokens = 1100;
  first.policyDigest = policyDigest(first.acceptedPolicy);
  const admission = admitted(first);
  value.events.push(...admission.events);
  value.plansByDigest[recoveryPlanDigest(first)] = record(first);
  value.claims.push(admission.claim);
  value.candidatePlan = proposal(value.events, "third", first);
  return value;
}
const codes = (value: ReturnType<typeof verifyRecoveryChain>) =>
  value.blockers.map((blocker) => blocker.code);

describe("pure authenticated recovery chain verification", () => {
  it.each(["complete", "missing-adoption", "conflicting-claim"])(
    "accounts reused-graph successor history without inventing a compiler charge: %s",
    (mode) => {
      const value = successorFixture();
      const prior = Object.values(value.plansByDigest)[0]!.plan;
      value.events = value.events.filter(
        (event) =>
          !(
            event.runId === "successor" &&
            (event.kind === "budget" || event.event === "RecoveryAdoptionCompleted")
          ),
      );
      const start = value.events.find(
        (event) => event.event === "FactoryRunStarted" && event.runId === "successor",
      )!;
      const consumed = value.events.find((event) => event.event === "RecoveryConsumed")!;
      consumed.sequence = start.sequence + 1;
      if (consumed.event !== "RecoveryConsumed") throw new Error("fixture consumption");
      if (mode !== "missing-adoption")
        value.events.push(
          event({
            ...consumed,
            event: "RecoveryAdoptionCompleted",
            sequence: start.sequence + 2,
            claimOid: mode === "conflicting-claim" ? sha("a") : consumed.claimOid,
            evidenceDigest: digest("1"),
            sourceEventsDigest: prior.sourceEventsDigest,
            accountingDigest: digest("2"),
            resourceEvidenceDigest: digest("3"),
            baseSha: prior.expectedBaseSha,
          }),
        );
      value.candidatePlan = proposal(value.events, "third", prior);
      const before = structuredClone(value.events);
      const result = verifyRecoveryChain(value);
      expect(result.status).toBe("verified");
      expect(result.accounting?.usage?.modelTokens).toBe(10);
      expect(result.accounting?.unknownModelUsageCount).toBe(mode === "complete" ? 0 : 1);
      expect(result.accounting?.remaining?.modelTokens).toBe(1090);
      expect(value.events).toEqual(before);
    },
  );
  it("verifies a bootstrap proposal without creating authority or resetting usage", () => {
    const value = fixture();
    const before = structuredClone(value);
    const result = verifyRecoveryChain(value);
    expect(result.status).toBe("verified");
    expect(result.executionAuthorized).toBe(false);
    expect(result.accounting?.usage?.modelTokens).toBe(10);
    expect(result.accounting?.remaining?.modelTokens).toBe(990);
    expect(result.verifiedAccountingRunIds).toEqual(["source"]);
    expect(value).toEqual(before);
  });
  it("verifies a consumed predecessor chain with increments applied once and original identities", () => {
    const value = successorFixture();
    value.events.push(...structuredClone(value.events));
    const result = verifyRecoveryChain(value);
    expect(result.status).toBe("verified");
    expect(result.allowance?.before.modelTokens).toBe(1100);
    expect(result.allowance?.after.modelTokens).toBe(1100);
    expect(result.accounting?.usage?.modelTokens).toBe(20);
    expect(result.accounting?.remaining?.modelTokens).toBe(1080);
  });
  it("retains graph-only failed runs in bootstrap accounting", () => {
    const value = fixture();
    value.events.push(...history("graph-only", 20));
    value.candidatePlan = proposal(value.events);
    expect(verifyRecoveryChain(value).accounting?.usage?.modelTokens).toBe(20);
    value.candidatePlan = proposal(history("graph-only", 20));
    value.candidatePlan.graph.sourceRunId = "graph-only";
    value.candidatePlan.graph.ref = compiledGraphRef(7, "graph-only");
    value.candidatePlan.graph.projection.ref = compiledGraphProjectionRef(7, "graph-only");
    expect(codes(verifyRecoveryChain(value))).toContain("omitted-history");
  });
  it("carries multiple explicit increments once across three admitted generations", () => {
    const value = successorFixture();
    const second = value.candidatePlan;
    second.allowance.increment.modelTokens = 200;
    second.allowance.after.modelTokens = 1300;
    second.acceptedPolicy.economics!.maxModelTokens = 1300;
    second.policyDigest = policyDigest(second.acceptedPolicy);
    const admission = admitted(second);
    value.events.push(...admission.events);
    value.claims.push(admission.claim);
    value.plansByDigest[recoveryPlanDigest(second)] = record(second);
    value.candidatePlan = proposal(value.events, "fourth", second);
    const result = verifyRecoveryChain(value);
    expect(result.status).toBe("verified");
    expect(result.allowance?.before.modelTokens).toBe(1300);
    expect(result.accounting?.usage?.modelTokens).toBe(30);
    expect(result.accounting?.remaining?.modelTokens).toBe(1270);
  });
  it("anchors bootstrap to the latest accepted predecessor policy while charging all earlier usage", () => {
    const value = fixture();
    const laterPolicy = { ...policy, economics: { ...policy.economics!, maxModelTokens: 2000 } };
    value.events.push(...history("later", 20, laterPolicy));
    value.candidatePlan = proposal(value.events);
    value.candidatePlan.acceptedPolicy = laterPolicy;
    value.candidatePlan.policyDigest = policyDigest(laterPolicy);
    value.candidatePlan.allowance.before.modelTokens = 2000;
    value.candidatePlan.allowance.after.modelTokens = 2000;
    const result = verifyRecoveryChain(value);
    expect(result.status).toBe("verified");
    expect(result.accounting?.usage?.modelTokens).toBe(20);
    expect(result.accounting?.remaining?.modelTokens).toBe(1980);
    expect(
      result.accounting?.blockers.some((item) => item.code === "historical-policy-difference"),
    ).toBe(true);
  });
  it.each([
    "incomplete",
    "missing-start",
    "missing-terminal",
    "wrong-terminal",
    "wrong-policy",
    "foreign-repo",
    "foreign-node",
  ])("rejects %s history", (change) => {
    const value = fixture();
    if (change === "incomplete") value.historyComplete = false;
    if (change === "missing-start")
      value.events = value.events.filter((item) => item.event !== "FactoryRunStarted");
    if (change === "missing-terminal")
      value.events = value.events.filter((item) => item.event !== "FactoryRunEscalated");
    if (change === "wrong-terminal") Object.assign(value.events[2]!, { reason: "different" });
    if (change === "wrong-policy") Object.assign(value.events[0]!, { policyDigest: digest("f") });
    if (change === "foreign-repo") value.repository = "elsewhere/repo";
    if (change === "foreign-node") value.objectiveNodeId = "I_elsewhere";
    expect(verifyRecoveryChain(value).status).toBe("blocked");
  });
  it.each(["request", "consumption", "claim", "plan"])(
    "rejects missing prior %s observation",
    (missing) => {
      const value = successorFixture();
      if (missing === "request")
        value.events = value.events.filter((item) => item.event !== "RecoveryRequested");
      if (missing === "consumption")
        value.events = value.events.filter((item) => item.event !== "RecoveryConsumed");
      if (missing === "claim") value.claims = [];
      if (missing === "plan") value.plansByDigest = {};
      expect(verifyRecoveryChain(value).status).toBe("blocked");
    },
  );
  it.each(["policyDigest", "baseSha", "requestedBy", "predecessorTerminalDigest"])(
    "rejects mismatched authenticated request %s",
    (field) => {
      const value = successorFixture();
      Object.assign(value.events.find((item) => item.event === "RecoveryRequested")!, {
        [field]: field === "requestedBy" ? "other" : field === "baseSha" ? sha("f") : digest("f"),
      });
      expect(verifyRecoveryChain(value).status).toBe("blocked");
    },
  );
  it.each(["oid", "requestId", "successorRunId", "repository", "predecessorTerminalDigest"])(
    "rejects independently observed claim mismatch %s",
    (field) => {
      const value = successorFixture();
      Object.assign(value.claims[0]!, { [field]: "different" });
      expect(codes(verifyRecoveryChain(value))).toContain("claim-observation-mismatch");
    },
  );
  it("rejects forked consumed successors and does not mistake chronology for ancestry", () => {
    const value = successorFixture();
    const consumed = value.events.find((item) => item.event === "RecoveryConsumed")!;
    value.events.push({ ...consumed, runId: "fork", sequence: 100 } as FactoryEvent);
    expect(codes(verifyRecoveryChain(value))).toContain("forked-successor");
    const bootstrap = successorFixture();
    bootstrap.candidatePlan.priorPlanDigest = null;
    expect(verifyRecoveryChain(bootstrap).status).toBe("blocked");
  });
  it("rejects conflicting request reuse and missing/cyclic plan pointers", () => {
    const value = successorFixture();
    const request = value.events.find((item) => item.event === "RecoveryRequested")!;
    value.events.push({ ...request, sequence: 100, baseSha: sha("f") } as FactoryEvent);
    expect(verifyRecoveryChain(value).status).toBe("blocked");
    const missing = fixture();
    missing.candidatePlan.priorPlanDigest = digest("f");
    expect(codes(verifyRecoveryChain(missing))).toContain("chain-cycle-or-missing-plan");
  });
  it("rejects pending claims rather than overwriting or treating them as cleanup", () => {
    const value = fixture();
    value.claims.push(admitted(value.candidatePlan).claim);
    expect(codes(verifyRecoveryChain(value))).toContain("candidate-predecessor-claimed");
  });
  it("does not hide an unconsumed claim on an older bootstrap source", () => {
    const value = fixture();
    value.claims.push(admitted(value.candidatePlan).claim);
    value.events.push(...history("later", 20));
    value.candidatePlan = proposal(value.events);
    expect(codes(verifyRecoveryChain(value))).toContain("unlinked-claim");
  });
  it("rejects a fabricated future source cutoff", () => {
    const value = fixture();
    value.candidatePlan.sourceEventMaxSequence = 1000;
    expect(codes(verifyRecoveryChain(value))).toContain("source-cutoff-unobserved");
  });
  it("rejects newly observed source charges until a new candidate fence is acknowledged", () => {
    const value = fixture();
    value.events.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 11,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `failed-compile-${sha("a")}`,
      }),
    );
    expect(codes(verifyRecoveryChain(value))).toContain("candidate-source-advanced");
    value.candidatePlan = proposal(value.events);
    expect(verifyRecoveryChain(value).accounting?.usage?.modelTokens).toBe(40);
  });
  it("keeps an admitted prior prefix valid while carrying later source reconciliation into current totals", () => {
    const value = successorFixture();
    value.events.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 30,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `failed-compile-${sha("a")}`,
      }),
    );
    const prior = Object.values(value.plansByDigest)[0]!.plan;
    value.candidatePlan = proposal(value.events, "third", prior);
    const result = verifyRecoveryChain(value);
    expect(result.status).toBe("verified");
    expect(result.accounting?.usage?.modelTokens).toBe(50);
  });
  it("does not let recovery acknowledgement receipts change source digest or duplicate budget", () => {
    const value = fixture();
    value.events.push(admitted(value.candidatePlan).events[0]!);
    expect(verifyRecoveryChain(value).status).toBe("verified");
    expect(verifyRecoveryChain(value).accounting?.usage?.modelTokens).toBe(10);
  });
  it("preserves unknown usage and verifies optional acknowledgement without authorizing execution", () => {
    const value = fixture();
    value.events = value.events.filter((item) => item.kind !== "budget");
    value.candidatePlan = proposal(value.events);
    const initial = verifyRecoveryChain(value);
    expect(initial.status).toBe("verified");
    expect(initial.accounting?.unknownModelUsageCount).toBe(1);
    value.candidatePlan.unknownUsageAcknowledgementDigest = recoveryUnknownUsageDigest(
      value.candidatePlan.sourceEventsDigest,
      initial.accounting!,
    );
    const acknowledged = verifyRecoveryChain(value);
    expect(acknowledged.status).toBe("verified");
    expect(acknowledged.executionAuthorized).toBe(false);
    expect(
      acknowledged.accounting?.blockers.some((item) => item.code === "unknown-model-usage"),
    ).toBe(true);
    value.candidatePlan.unknownUsageAcknowledgementDigest = digest("f");
    expect(codes(verifyRecoveryChain(value))).toContain("unknown-usage-acknowledgement-mismatch");
  });
  it("hashes canonical envelopes and refuses conflicting receipts and source scope", () => {
    const events = history();
    const reversed = Object.fromEntries(Object.entries(events[0]!).reverse()) as FactoryEvent;
    expect(recoveryEventDigest(reversed)).toBe(recoveryEventDigest(events[0]!));
    const input = { objective: 7, runIds: ["source"], events, maxSequence: 10 };
    expect(recoverySourceEventsDigest({ ...input, events: [...events].reverse() })).toBe(
      recoverySourceEventsDigest(input),
    );
    expect(recoverySourceEventsDigest({ ...input, events: [...events, ...events] })).toBe(
      recoverySourceEventsDigest(input),
    );
    expect(() => recoverySourceEventsDigest({ ...input, objective: 8 })).toThrow();
    expect(() => recoverySourceEventsDigest({ ...input, runIds: ["source", "source"] })).toThrow();
  });
});
