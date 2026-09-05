import { describe, expect, it } from "vitest";
import { compiledGraphProjectionRef, compiledGraphRef } from "../src/control/graphs.js";
import { type FactoryEvent, parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import {
  RECOVERY_CLAIM_PROTOCOL,
  type AuthenticatedRecoveryRequest,
  type RecoveryClaimRecord,
} from "../src/recovery/claims.js";
import {
  recoveryClaimRef,
  recoveryEventDigest,
  recoverySourceEventsDigest,
} from "../src/recovery/identity.js";
import {
  RECOVERY_PLAN_PROTOCOL,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlan,
  type RecoveryPlanRecord,
} from "../src/recovery/plan.js";
import { inspectRecoveryAdoption, recoveryAdoptionEvents } from "../src/recovery/transaction.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const at = "2026-09-04T00:00:00.000Z";
const common = { protocol: "clockgrove.factory/v2", objective: 7, runId: "source", at };

function fixture() {
  const policy = structuredClone(DEFAULT_RUN_POLICY);
  const predecessorStart = parseFactoryEvent({
    ...common,
    kind: "run",
    event: "FactoryRunStarted",
    sequence: 1,
    actor: "operator",
    objectiveAuthor: "author",
    repository: "fixture/project",
    fork: false,
    baseBranch: "main",
    baseSha: sha("a"),
    policy,
    policyDigest: policyDigest(policy),
  });
  if (predecessorStart.event !== "FactoryRunStarted") throw new Error("fixture start");
  const terminal = parseFactoryEvent({
    ...common,
    kind: "run",
    event: "FactoryRunEscalated",
    sequence: 10,
    reason: "checks blocked",
  });
  const sourceEvents = [predecessorStart, terminal];
  const predecessor = {
    runId: "source",
    startDigest: recoveryEventDigest(predecessorStart),
    terminalDigest: recoveryEventDigest(terminal),
    terminalEvent: "FactoryRunEscalated" as const,
    terminalSequence: 10,
  };
  const history = [{ ...predecessor, policyDigest: policyDigest(policy) }];
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
  const allowance = {
    modelTokens: policy.economics?.maxModelTokens ?? null,
    sandboxMinutes: policy.maxSandboxMinutes,
    managedSessions: policy.maxManagedAgentSessions,
    implementationAttemptsPerItem: policy.maxAttemptsPerItem,
  };
  const plan: RecoveryPlan = {
    protocol: RECOVERY_PLAN_PROTOCOL,
    repository: "fixture/project",
    repositoryId: "R_fixture",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "request-one",
    successorRunId: "successor",
    predecessor,
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 7,
      runIds: ["source"],
      events: sourceEvents,
      maxSequence: 10,
    }),
    sourceEventMaxSequence: 10,
    priorPlanDigest: null,
    expectedBaseSha: sha("a"),
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: compiledGraphRef(7, "source"),
      commitOid: sha("1"),
      blobOid: sha("2"),
      digest: digest("4"),
      projection: {
        ref: compiledGraphProjectionRef(7, "source"),
        commitOid: sha("3"),
        blobOid: sha("4"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: policy,
    policyDigest: policyDigest(policy),
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
  const planDigest = recoveryPlanDigest(plan);
  const planRecord: RecoveryPlanRecord = {
    plan,
    digest: planDigest,
    ref: recoveryPlanRef(7, planDigest),
    commitOid: sha("5"),
    blobOid: sha("6"),
  };
  const authenticatedRequest: AuthenticatedRecoveryRequest = {
    ...common,
    protocol: "clockgrove.factory/v2",
    kind: "recovery",
    event: "RecoveryRequested",
    sequence: 11,
    requestedBy: "operator",
    requestId: plan.requestId,
    repository: plan.repository,
    planDigest,
    predecessorRunId: "source",
    predecessorTerminalDigest: predecessor.terminalDigest,
    successorRunId: "successor",
    policyDigest: plan.policyDigest,
    baseSha: plan.expectedBaseSha,
  };
  const claim: RecoveryClaimRecord = {
    protocol: RECOVERY_CLAIM_PROTOCOL,
    repository: plan.repository,
    repositoryId: plan.repositoryId,
    objective: 7,
    objectiveNodeId: plan.objectiveNodeId,
    requestId: plan.requestId,
    requestDigest: recoveryEventDigest(authenticatedRequest),
    requestSequence: authenticatedRequest.sequence,
    planDigest,
    planRef: planRecord.ref,
    planCommitOid: planRecord.commitOid,
    planBlobOid: planRecord.blobOid,
    predecessorRunId: "source",
    predecessorTerminalDigest: predecessor.terminalDigest,
    successorRunId: "successor",
    expectedBaseSha: plan.expectedBaseSha,
    policyDigest: plan.policyDigest,
    transaction: {
      at,
      startSequence: 13,
      evidenceDigest: digest("7"),
      accountingDigest: digest("8"),
      resourceEvidenceDigest: digest("9"),
    },
    ref: recoveryClaimRef(7, "source"),
    oid: sha("7"),
    blobOid: sha("8"),
  };
  return {
    planRecord,
    claim,
    authenticatedRequest,
    predecessorStart,
    events: [...sourceEvents, authenticatedRequest] as FactoryEvent[],
    historyComplete: true,
  };
}

describe("deterministic pending recovery transaction inspection", () => {
  it.each([0, 1, 2, 3])("reconstructs prefix %i without granting execution authority", (length) => {
    const f = fixture();
    const expected = recoveryAdoptionEvents(f);
    f.events.push(...expected.slice(0, length));
    const before = structuredClone(f);
    const result = inspectRecoveryAdoption(f);
    expect(result).toEqual({
      state: ["pending", "started", "consumed", "complete"][length],
      executionAuthorized: false,
      nextEvent: expected[length] ?? null,
      blockers: [],
    });
    expect(recoveryAdoptionEvents(f)).toEqual(expected);
    expect(f).toEqual(before);
    expect(expected.map((event) => event.sequence)).toEqual([13, 14, 15]);
    expect(expected.every((event) => event.at === at && event.runId === "successor")).toBe(true);
    expect(expected[2]).toMatchObject({
      claimRef: f.claim.ref,
      claimOid: f.claim.oid,
      sourceEventsDigest: f.planRecord.plan.sourceEventsDigest,
      evidenceDigest: f.claim.transaction.evidenceDigest,
      accountingDigest: f.claim.transaction.accountingDigest,
      resourceEvidenceDigest: f.claim.transaction.resourceEvidenceDigest,
    });
  });

  it.each([1, 2, 3])(
    "replays lost responses after prefix %i with exact duplicate envelopes",
    (length) => {
      const f = fixture();
      const prefix = recoveryAdoptionEvents(f).slice(0, length);
      f.events.push(...prefix, ...structuredClone(prefix));
      expect(inspectRecoveryAdoption(f).state).toBe(
        ["pending", "started", "consumed", "complete"][length],
      );
      f.events.reverse();
      expect(inspectRecoveryAdoption(f).state).toBe(
        ["pending", "started", "consumed", "complete"][length],
      );
    },
  );

  it.each([[1], [2], [0, 2], [1, 2]])("rejects transaction gaps %j", (...indices) => {
    const f = fixture();
    const expected = recoveryAdoptionEvents(f);
    f.events.push(...indices.map((index) => expected[index]!));
    expect(inspectRecoveryAdoption(f).blockers).toEqual(["transaction-prefix-incomplete"]);
  });

  it.each(
    [0, 1, 2].flatMap((index) => ["at", "sequence", "body"].map((field) => ({ index, field }))),
  )("rejects changed $field on envelope $index", ({ index, field }) => {
    const f = fixture();
    const expected = recoveryAdoptionEvents(f);
    f.events.push(...expected);
    const altered = parseFactoryEvent({
      ...expected[index],
      ...(field === "at"
        ? { at: "2026-09-04T00:00:01.000Z" }
        : field === "sequence"
          ? { sequence: 20 }
          : { unexpectedReceipt: "changed" }),
    });
    f.events.push(altered);
    expect(inspectRecoveryAdoption(f).blockers).toEqual(["unexpected-successor-event"]);
  });

  it.each(["request", "plan", "claim", "actor", "predecessor"])(
    "blocks mismatching %s binding",
    (target) => {
      const f = fixture();
      if (target === "request") f.authenticatedRequest.baseSha = sha("f");
      if (target === "plan") f.planRecord.commitOid = sha("f");
      if (target === "claim") f.claim.successorRunId = "other";
      if (target === "actor") f.predecessorStart.actor = "other";
      if (target === "predecessor") f.predecessorStart.runId = "other";
      expect(() => recoveryAdoptionEvents(f)).toThrow();
      expect(inspectRecoveryAdoption(f)).toMatchObject({
        state: "blocked",
        executionAuthorized: false,
        nextEvent: null,
      });
    },
  );

  it("blocks incomplete or excessive history", () => {
    const f = fixture();
    expect(inspectRecoveryAdoption({ ...f, historyComplete: false }).blockers).toEqual([
      "history-incomplete",
    ]);
    expect(
      inspectRecoveryAdoption({ ...f, events: Array.from({ length: 50_001 }, () => f.events[0]!) })
        .blockers,
    ).toEqual(["history-incomplete"]);
  });

  it.each(["missing", "altered", "competing"])("blocks %s acknowledgement", (kind) => {
    const f = fixture();
    if (kind === "missing") f.events.pop();
    else
      f.events.push(
        parseFactoryEvent({
          ...f.authenticatedRequest,
          ...(kind === "competing"
            ? { requestId: "competitor", successorRunId: "other" }
            : { at: "2026-09-04T00:00:01.000Z" }),
        }),
      );
    expect(inspectRecoveryAdoption(f).blockers).toEqual(["request-missing-or-conflicting"]);
  });

  it.each(["start", "terminal", "late-charge"])("blocks changed source fence: %s", (kind) => {
    const f = fixture();
    if (kind === "start") f.events.shift();
    else if (kind === "terminal") f.events.splice(1, 1);
    else
      f.events.push(
        parseFactoryEvent({
          ...common,
          kind: "budget",
          event: "BudgetReconciled",
          sequence: 30,
          phase: "management",
          unit: "model_tokens",
          amount: 1,
          usageId: "late",
          policyDigest: f.planRecord.plan.policyDigest,
        }),
      );
    expect(inspectRecoveryAdoption(f).blockers).toEqual(["source-fence-changed"]);
  });

  it.each(["terminal", "cancel", "worker", "lease"])(
    "blocks unexpected successor %s effects",
    (kind) => {
      const f = fixture();
      f.events.push(...recoveryAdoptionEvents(f));
      const extras =
        kind === "terminal"
          ? { kind: "run", event: "FactoryRunEscalated" }
          : kind === "cancel"
            ? {
                kind: "run",
                event: "FactoryRunCancellationRequested",
                requestedBy: "operator",
                requestId: "cancel",
              }
            : kind === "worker"
              ? {
                  kind: "attempt",
                  event: "AttemptFailed",
                  workItem: 8,
                  attempt: 1,
                  backend: "local",
                  baseSha: sha("a"),
                  directorEpoch: 1,
                  policyDigest: f.claim.policyDigest,
                  reason: "failed",
                }
              : {
                  kind: "lease",
                  event: "LeaseAcquired",
                  holder: "operator",
                  epoch: 1,
                  expiresAt: "2026-09-04T00:10:00.000Z",
                  policyDigest: f.claim.policyDigest,
                };
      f.events.push(parseFactoryEvent({ ...common, runId: "successor", sequence: 16, ...extras }));
      expect(inspectRecoveryAdoption(f).blockers).toEqual(["unexpected-successor-event"]);
    },
  );

  it.each([13, 14, 15])(
    "blocks source recovery receipt colliding at transaction sequence %i",
    (sequence) => {
      const f = fixture();
      const receipt = recoveryAdoptionEvents(f)[1];
      f.events.push(
        parseFactoryEvent({ ...receipt, runId: "source", predecessorRunId: "older", sequence }),
      );
      expect(inspectRecoveryAdoption(f).blockers).toEqual(["transaction-sequence-collision"]);
    },
  );

  it("blocks another run at a reserved transaction sequence and foreign Objective events", () => {
    const f = fixture();
    const terminal = f.events[1]!;
    expect(
      inspectRecoveryAdoption({
        ...f,
        events: [...f.events, parseFactoryEvent({ ...terminal, runId: "other", sequence: 13 })],
      }).blockers,
    ).toEqual(["unplanned-run-history"]);
    expect(
      inspectRecoveryAdoption({
        ...f,
        events: [...f.events, parseFactoryEvent({ ...terminal, objective: 99 })],
      }).blockers,
    ).toEqual(["event-scope-mismatch"]);
  });
});
