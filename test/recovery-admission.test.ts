import { describe, expect, it } from "vitest";
import { compiledGraphProjectionRef, compiledGraphRef } from "../src/control/graphs.js";
import { type FactoryEvent, parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest, type RunPolicy } from "../src/protocol/policy.js";
import {
  verifyRecoveryAdmission,
  type RecoveryAdmissionDemand,
} from "../src/recovery/admission.js";
import { recoveryUnknownUsageDigest, verifyRecoveryChain } from "../src/recovery/chain.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "../src/recovery/identity.js";
import {
  RECOVERY_PLAN_PROTOCOL,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlan,
  type RecoveryPlanRecord,
} from "../src/recovery/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const zero = (): RecoveryAdmissionDemand => ({
  modelTokens: 0,
  sandboxMinutes: 0,
  managedSessions: 0,
  implementationAttempts: [],
});
const policy: RunPolicy = {
  ...DEFAULT_RUN_POLICY,
  maxSandboxMinutes: 10,
  maxManagedAgentSessions: 2,
  economics: {
    maxModelTokens: 100,
    maxSandboxMinutes: 10,
    maxManagedSessions: 2,
    minCloudTimeSavedMinutes: 0,
  },
};
const event = (fields: Record<string, unknown>) =>
  parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "source",
    sequence: 1,
    at: "2026-09-04T00:00:00Z",
    ...fields,
  });
function history(runId = "source", offset = 0, tokens = 10, sourcePolicy = policy): FactoryEvent[] {
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
      policy: sourcePolicy,
      policyDigest: policyDigest(sourcePolicy),
    }),
    event({
      kind: "budget",
      event: "BudgetReconciled",
      runId,
      sequence: offset + 2,
      phase: "management",
      unit: "model_tokens",
      amount: tokens,
      usageId: `compile-${digest("c")}`,
    }),
    event({ kind: "run", event: "FactoryRunEscalated", runId, sequence: offset + 90 }),
  ];
}
function budget(fields: Record<string, unknown>) {
  return event({
    kind: "budget",
    event: "BudgetReconciled",
    sequence: 3,
    phase: "execution",
    unit: "model_tokens",
    amount: 0,
    ...fields,
  });
}
function reservedAttempt(runId = "source", sequence = 4, attempt = 1, workItem = 8) {
  return event({
    kind: "attempt",
    event: "AttemptReserved",
    runId,
    sequence,
    workItem,
    attempt,
    backend: "codex-sdk/local-worktree",
    baseSha: sha("a"),
    directorEpoch: 1,
    policyDigest: policyDigest(policy),
  });
}
function fixture(events = history(), acceptedPolicy = structuredClone(policy)) {
  const starts = events
    .filter((entry) => entry.event === "FactoryRunStarted")
    .sort((a, b) => a.sequence - b.sequence);
  const entries = starts.map((start) => {
    const terminal = events.find(
      (entry) => entry.runId === start.runId && entry.event === "FactoryRunEscalated",
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
  const predecessor = {
    runId: last.runId,
    startDigest: last.startDigest,
    terminalDigest: last.terminalDigest,
    terminalEvent: last.terminalEvent,
    terminalSequence: last.terminalSequence,
  };
  const sourceEventMaxSequence = Math.max(...events.map((entry) => entry.sequence));
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
  const sourcePolicy = starts.at(-1)!.policy as RunPolicy;
  const allowance = (p: RunPolicy) => ({
    modelTokens: p.economics?.maxModelTokens ?? null,
    sandboxMinutes: p.maxSandboxMinutes,
    managedSessions: p.maxManagedAgentSessions,
    implementationAttemptsPerItem: p.maxAttemptsPerItem,
  });
  const before = allowance(sourcePolicy),
    after = allowance(acceptedPolicy);
  const plan: RecoveryPlan = {
    protocol: RECOVERY_PLAN_PROTOCOL,
    repository: "o/r",
    repositoryId: "R_o",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "request",
    successorRunId: "successor",
    predecessor,
    history: entries,
    historyDigest: recoveryHistoryDigest(entries),
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 7,
      runIds: entries.map((entry) => entry.runId),
      events,
      maxSequence: sourceEventMaxSequence,
    }),
    sourceEventMaxSequence,
    priorPlanDigest: null,
    expectedBaseSha: sha("a"),
    baseBranch: "main",
    graph: {
      sourceRunId: last.runId,
      ref: compiledGraphRef(7, last.runId),
      commitOid: sha("b"),
      blobOid: sha("c"),
      digest: digest("d"),
      projection: {
        ref: compiledGraphProjectionRef(7, last.runId),
        commitOid: sha("d"),
        blobOid: sha("e"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy,
    policyDigest: policyDigest(acceptedPolicy),
    allowance: {
      before,
      increment: {
        modelTokens: (after.modelTokens ?? 0) - (before.modelTokens ?? 0),
        sandboxMinutes: after.sandboxMinutes - before.sandboxMinutes,
        managedSessions: after.managedSessions - before.managedSessions,
        implementationAttemptsPerItem:
          after.implementationAttemptsPerItem - before.implementationAttemptsPerItem,
      },
      after,
    },
    unknownUsageAcknowledgementDigest: null,
    items,
  };
  const refresh = () => {
    const planDigest = recoveryPlanDigest(plan);
    const planRecord: RecoveryPlanRecord = {
      plan,
      digest: planDigest,
      ref: recoveryPlanRef(7, planDigest),
      commitOid: sha("f"),
      blobOid: sha("1"),
    };
    const chain = verifyRecoveryChain({
      repository: "o/r",
      repositoryId: "R_o",
      objective: 7,
      objectiveNodeId: "I_7",
      historyComplete: true,
      events,
      plansByDigest: {},
      claims: [],
      candidatePlan: plan,
    });
    return { planRecord, chain, required: zero() };
  };
  return { plan, events, refresh, ...refresh() };
}
const codes = (value: ReturnType<typeof verifyRecoveryAdmission>) =>
  value.blockers.map((entry) => entry.code);

describe("cumulative recovery accounting admission", () => {
  it("binds exact verified ancestry without mutation or execution authority", () => {
    const input = fixture();
    expect(input.chain.status).toBe("verified");
    const before = structuredClone(input.chain);
    const result = verifyRecoveryAdmission(input);
    expect(result).toMatchObject({ status: "verified", executionAuthorized: false, blockers: [] });
    expect(result.accountingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(input.chain).toEqual(before);
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 5 } })
        .accountingDigest,
    ).toBe(result.accountingDigest);
  });

  it("charges cumulative historical use rather than granting a fresh successor budget", () => {
    const input = fixture([...history("one", 0, 40), ...history("two", 100, 50)]);
    expect(input.chain.status).toBe("verified");
    expect(input.chain.accounting!.usage!.modelTokens).toBe(90);
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 10 } }).status,
    ).toBe("verified");
    expect(
      codes(verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 11 } })),
    ).toContain("model-token-limit");
  });

  it("allows zero-model adoption at exhausted tokens but forbids another model invocation", () => {
    const input = fixture(history("source", 0, 100));
    expect(verifyRecoveryAdmission(input).status).toBe("verified");
    expect(
      codes(verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 1 } })),
    ).toContain("model-token-limit");
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), sandboxMinutes: 1 } }).status,
    ).toBe("verified");
  });

  it.each(["sandboxMinutes", "managedSessions"] as const)(
    "requires explicit remaining %s for cleanup or validation",
    (unit) => {
      const input = fixture([
        ...history(),
        budget({
          unit: unit === "sandboxMinutes" ? "sandbox_milliseconds" : "managed_sessions",
          amount: unit === "sandboxMinutes" ? 600_000 : 2,
        }),
      ]);
      expect(verifyRecoveryAdmission(input).status).toBe("verified");
      expect(verifyRecoveryAdmission({ ...input, required: { ...zero(), [unit]: 1 } }).status).toBe(
        "blocked",
      );
    },
  );

  it("preserves fractional sandbox demand in native minutes", () => {
    const input = fixture([
      ...history(),
      budget({ unit: "sandbox_milliseconds", amount: 570_000 }),
    ]);
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), sandboxMinutes: 0.5 } }).status,
    ).toBe("verified");
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), sandboxMinutes: 0.501 } }).status,
    ).toBe("blocked");
  });

  it("counts implementation retries across runs and permits unrelated zero-attempt work", () => {
    const input = fixture([
      ...history("one"),
      reservedAttempt("one"),
      ...history("two", 100),
      reservedAttempt("two", 104),
      reservedAttempt("two", 105, 2),
    ]);
    expect(input.chain.accounting!.attemptCount).toBe(3);
    expect(verifyRecoveryAdmission(input).status).toBe("verified");
    expect(
      codes(
        verifyRecoveryAdmission({
          ...input,
          required: { ...zero(), implementationAttempts: [{ workItem: 8, count: 1 }] },
        }),
      ),
    ).toContain("implementation-attempt-limit");
  });

  it("honors exact explicit incremental allowance without resetting historical usage", () => {
    const accepted = structuredClone(policy);
    accepted.economics!.maxModelTokens = 150;
    const input = fixture(history("source", 0, 100), accepted);
    expect(input.chain.status).toBe("verified");
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 50 } }).status,
    ).toBe("verified");
    expect(
      verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 51 } }).status,
    ).toBe("blocked");
  });

  it("keeps unreconciled reservations blocking even with spare budget and zero demand", () => {
    const input = fixture([
      ...history(),
      budget({ event: "BudgetReserved", unit: "managed_sessions", amount: 1 }),
    ]);
    expect(input.chain.accounting!.usage!.managedSessionsReserved).toBe(1);
    expect(codes(verifyRecoveryAdmission(input))).toContain("unreconciled-budget-reservations");
  });

  it("unknown usage is cleared only by the exact plan acknowledgement", () => {
    const input = fixture(history().filter((entry) => entry.kind !== "budget"));
    expect(codes(verifyRecoveryAdmission(input))).toContain("unknown-model-usage");
    input.plan.unknownUsageAcknowledgementDigest = recoveryUnknownUsageDigest(
      input.plan.sourceEventsDigest,
      input.chain.accounting!,
    );
    expect(verifyRecoveryAdmission(input.refresh()).status).toBe("verified");
    input.plan.unknownUsageAcknowledgementDigest = digest("f");
    expect(verifyRecoveryAdmission(input.refresh()).status).toBe("blocked");
  });

  it("an unknown acknowledgement never clears independent liabilities or blockers", () => {
    const input = fixture([
      ...history().filter((entry) => entry.kind !== "budget"),
      budget({ event: "BudgetReserved", unit: "managed_sessions", amount: 1 }),
    ]);
    input.plan.unknownUsageAcknowledgementDigest = recoveryUnknownUsageDigest(
      input.plan.sourceEventsDigest,
      input.chain.accounting!,
    );
    const acknowledged = input.refresh();
    expect(codes(verifyRecoveryAdmission(acknowledged))).toContain(
      "unreconciled-budget-reservations",
    );
    acknowledged.chain.accounting!.blockers.push({
      code: "conflicting-worker-usage",
      reason: "fixture",
    });
    acknowledged.chain.accounting!.blockerCount++;
    expect(codes(verifyRecoveryAdmission(acknowledged))).toContain("source-accounting-blocked");
  });

  it.each(["modelTokens", "sandboxMinutes", "managedSessions"] as const)(
    "rejects NaN/Infinity/negative/overflow %s demand",
    (unit) => {
      for (const amount of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
        expect(
          verifyRecoveryAdmission({ ...fixture(), required: { ...zero(), [unit]: amount } }).status,
        ).toBe("blocked");
    },
  );

  it("rejects positive model demand whose unbounded cumulative integer would overflow", () => {
    const unbounded = structuredClone(policy);
    delete unbounded.economics;
    const input = fixture(history("source", 0, Number.MAX_SAFE_INTEGER, unbounded), unbounded);
    expect(verifyRecoveryAdmission(input).status).toBe("verified");
    expect(
      codes(verifyRecoveryAdmission({ ...input, required: { ...zero(), modelTokens: 1 } })),
    ).toContain("unsafe-arithmetic");
  });

  it.each([
    "candidate",
    "allowance",
    "remaining",
    "NaN usage",
    "missing accounting",
    "truncated attempts",
    "truncated diagnostics",
    "truncated reservations",
    "hidden attempts",
    "orphan attempts",
    "blocked chain",
  ])("rejects malformed or mismatched %s", (kind) => {
    const input = fixture([...history(), reservedAttempt()]);
    const accounting = input.chain.accounting!;
    if (kind === "candidate") input.chain.candidatePlanDigest = digest("f");
    if (kind === "allowance")
      input.chain.allowance = {
        ...input.chain.allowance!,
        after: { ...input.chain.allowance!.after, modelTokens: 999 },
      };
    if (kind === "remaining") accounting.remaining!.modelTokens = 99;
    if (kind === "NaN usage") accounting.usage!.modelTokens = NaN;
    if (kind === "missing accounting") input.chain.accounting = null;
    if (kind === "truncated attempts") accounting.attemptCountsTruncated = true;
    if (kind === "truncated diagnostics") accounting.diagnosticsTruncated = true;
    if (kind === "truncated reservations") accounting.unreconciledReservationsTruncated = true;
    if (kind === "hidden attempts") accounting.attemptCount++;
    if (kind === "orphan attempts") accounting.attemptCounts[0]!.workItem = 99;
    if (kind === "blocked chain") input.chain.status = "blocked";
    expect(verifyRecoveryAdmission(input).status).toBe("blocked");
  });

  it("rejects duplicate and foreign prospective Work Item identities", () => {
    for (const implementationAttempts of [
      [{ workItem: 99, count: 1 }],
      [
        { workItem: 8, count: 1 },
        { workItem: 8, count: 1 },
      ],
    ])
      expect(
        codes(
          verifyRecoveryAdmission({
            ...fixture(),
            required: { ...zero(), implementationAttempts },
          }),
        ),
      ).toContain("demand-scope-mismatch");
  });
});
