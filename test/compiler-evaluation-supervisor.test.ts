import { describe, expect, it, vi } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { CompiledGraphManager, compiledGraphProjectionRef } from "../src/control/graphs.js";
import { GitHubReader, cancellationRequestFromComments } from "../src/github.js";
import { decodeEventComments, encodeEventComment } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { policyDigest } from "../src/protocol/policy.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { compileObjective } from "../src/compiler/index.js";
import { readRepositoryFacts } from "../src/repository-profiles/index.js";
import { readCompilerObligationEvidence } from "../src/management/codex-cli.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import { GithubOctokitGraphWriter, compiledGraphDigest } from "../src/graph.js";
import { buildRecoveryProposal } from "../src/recovery/proposal.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { RecoveryPlanManager } from "../src/recovery/plan.js";
import { RecoveryClaimManager } from "../src/recovery/claims.js";
import { recoveryAdoptionEvents } from "../src/recovery/transaction.js";

const usage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 4 };
type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
function freshObjective(f: Fixture) {
  for (const ref of [...f.refs.keys()])
    if (ref.includes("/graphs/") || ref.includes("/graph-projections/")) f.refs.delete(ref);
  f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter((event) => event.kind !== "graph");
  f.snapshot.workItems = [];
  f.snapshot.body = "Create answer.txt containing the required answer.";
}
function configureCompiler(f: Fixture, decision: "accept" | "repair" = "accept") {
  const calls: string[] = [];
  Object.assign(f.management, { supportsCompilerAdmission: true });
  f.management.extractObligations = async (context, checkpoint, beforeModelInvocation) => {
    await beforeModelInvocation?.();
    calls.push("inventory");
    const inventory: ObligationInventory = {
      version: 1,
      objectiveDigest: compilerEvalDigest(context.objective),
      baseSha: context.baseSha,
      evidence: await readCompilerObligationEvidence(context),
      obligations: [
        {
          id: "answer",
          text: "Create answer.txt containing the required answer.",
          kind: "explicit",
          evidenceIds: ["objective"],
          acceptanceEvidence: "Inspect answer.txt",
        },
      ],
    };
    const result = { inventory, usage };
    await checkpoint(result);
    return result;
  };
  f.management.compile = async (context, checkpoint, beforeModelInvocation) => {
    await beforeModelInvocation?.();
    calls.push("compile");
    const criterion = "answer.txt contains the required answer";
    const objective = compileObjective({
      title: context.objective.title,
      baseSha: context.baseSha,
      runPolicy: context.runPolicy,
      repositoryFacts: await readRepositoryFacts(
        context.repository,
        context.repositoryFiles,
        context.repositoryLfs,
      ),
      workItems: [
        {
          id: "answer",
          title: "Create answer",
          goal: "Create answer.txt",
          acceptance: [criterion],
          scope: ["answer.txt"],
          preconditions: [],
          outOfScope: [],
          conventions: [],
          dependsOn: [],
          baseSha: context.baseSha,
          validationCommands: ["npm test"],
          criterionRisks: [{ criterion, risk: "ordinary" }],
          validation: [
            {
              tier: "semantic",
              evidenceCommands: [],
              criteria: [criterion],
              rationale: "Inspect the required answer in the candidate artifact",
            },
          ],
          requirements: {
            os: ["linux"],
            architecture: [],
            tools: ["node"],
            services: [],
            networkDestinations: [],
            permittedSecretNames: [],
            trust: "trusted_local",
          },
          artifactContract: "clockgrove.factory/artifact-v1",
        },
      ],
    });
    const result = { objective, usage };
    await checkpoint(result);
    return result;
  };
  f.management.judgePlan = async (context, checkpoint, beforeModelInvocation) => {
    await beforeModelInvocation?.();
    calls.push("judge");
    const verdict: CompilerJudgeVerdict = {
      version: 1,
      rubricVersion: 1,
      draftDigest: compiledGraphDigest(context.objective),
      inventoryDigest: compilerEvalDigest(context.inventory),
      coverage: [
        {
          obligationId: "answer",
          status: decision === "accept" ? "covered" : "missing",
          itemIds: decision === "accept" ? ["answer"] : [],
          acceptanceBindings:
            decision === "accept"
              ? [{ itemId: "answer", criterion: "answer.txt contains the required answer" }]
              : [],
          evidenceIds: ["objective"],
          reason: "Fixture coverage assessment",
        },
      ],
      items: [
        {
          itemId: "answer",
          granularity: "cohesive",
          reason: "Single deliverable",
          evidenceIds: ["objective"],
        },
      ],
      dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "assessed",
        reason: "Fixture evidence",
        evidenceIds: ["objective"],
      })),
      dependencies: [],
      findings:
        decision === "accept"
          ? []
          : [
              {
                id: "missing",
                dimension: "coverage",
                severity: "blocking",
                confidence: 1,
                obligationIds: ["answer"],
                itemIds: ["answer"],
                evidenceIds: ["objective"],
                rootCause: "Required answer is missing",
                correction: "Preserve required answer",
                uncertainty: "",
              },
            ],
      uncertainty: [],
      decision,
    };
    const result = { verdict, usage };
    await checkpoint(result);
    return result;
  };
  f.management.repairPlan = async () => {
    calls.push("repair");
    throw new Error("unexpected repair in bounded report fixture");
  };
  return calls;
}
function assertNoProjection(f: Fixture) {
  expect(f.events().filter((event) => event.kind === "graph")).toEqual([]);
  expect(f.snapshot.workItems).toEqual([]);
  expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
  expect(f.snapshot.closed).toBe(false);
}

const recoveryCompilerEvaluation = {
  mode: "auto-repair" as const,
  maxRepairs: 2,
  maxInvocations: 7,
  timeoutSeconds: 600,
  maxObservedTokens: 500_000,
};

async function graphlessCompilerRecoveryFixture() {
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    compilerEvaluation: recoveryCompilerEvaluation,
  });
  freshObjective(f);
  const calls = configureCompiler(f);
  const sourcePolicy = structuredClone(f.policy);
  const sourcePolicyDigest = policyDigest(sourcePolicy);
  const sourceRunId = "failed-compiler-source";
  const successorRunId = "compiler-recovery-successor";
  const at = new Date().toISOString();
  const sourceEvent = (fields: Record<string, unknown>) =>
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: sourceRunId,
      at,
      ...fields,
    });
  const terminalReason = "compiled Objective has 16 deterministic violations: fixture";
  const invocationId = "compiler-inventory-1";
  const predecessorStart = sourceEvent({
    kind: "run",
    event: "FactoryRunStarted",
    sequence: 1,
    actor: "operator",
    repository: "fixture/provider-qualification",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: f.baseSha,
    policy: sourcePolicy,
    policyDigest: sourcePolicyDigest,
  });
  if (predecessorStart.event !== "FactoryRunStarted") throw new Error("fixture predecessor start");
  f.snapshot.factoryEvents = [
    predecessorStart,
    sourceEvent({
      kind: "delivery",
      event: "DeliverySelected",
      sequence: 2,
      requested: "regular-prs",
      selected: "regular-prs",
      capabilityVersion: "2026-03-10",
      reason: "fixture delivery selection",
    }),
    sourceEvent({
      kind: "budget",
      event: "BudgetReserved",
      sequence: 3,
      phase: "management",
      unit: "model_tokens",
      amount: 0,
      usageId: `invocation-${invocationId}`,
      modelInvocationId: invocationId,
      directorEpoch: 1,
      policyDigest: sourcePolicyDigest,
    }),
    sourceEvent({
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 4,
      phase: "management",
      unit: "model_tokens",
      amount: usage.inputTokens + usage.outputTokens,
      usageId: `draft-${invocationId}`,
      modelInvocationId: invocationId,
      directorEpoch: 1,
      policyDigest: sourcePolicyDigest,
      reportedModelUsage: usage,
    }),
    sourceEvent({
      kind: "run",
      event: "FactoryRunEscalated",
      sequence: 5,
      reason: terminalReason,
    }),
  ];

  const store = new GitHubControlStore({
    token: "fixture-only",
    owner: "fixture",
    repo: "provider-qualification",
  });
  const proposal = await buildRecoveryProposal({
    repository: "fixture/provider-qualification",
    snapshot: f.snapshot,
    historyComplete: true,
    store: recoveryReadPort(store, "fixture", "provider-qualification"),
    requestId: "compiler-recovery-request",
    successorRunId,
    compilerEvaluation: recoveryCompilerEvaluation,
  });
  expect(proposal.status, JSON.stringify(proposal.blockers)).toBe("proposed");
  if (!proposal.plan) throw new Error("fixture recovery plan");
  const successorLease = {
    ...f.lease,
    runId: successorRunId,
    policyDigest: proposal.plan.policyDigest,
  };
  const planRecord = await new RecoveryPlanManager(f.storage, f.leases).persist({
    lease: successorLease,
    plan: proposal.plan,
  });
  const request = sourceEvent({
    kind: "recovery",
    event: "RecoveryRequested",
    sequence: 6,
    requestedBy: "operator",
    requestId: proposal.plan.requestId,
    repository: "fixture/provider-qualification",
    planDigest: planRecord.digest,
    predecessorRunId: sourceRunId,
    predecessorTerminalDigest: proposal.plan.predecessor.terminalDigest,
    successorRunId,
    policyDigest: proposal.plan.policyDigest,
    baseSha: proposal.plan.expectedBaseSha,
  });
  if (request.event !== "RecoveryRequested") throw new Error("fixture recovery request");
  f.snapshot.factoryEvents.push(request);
  const claim = await new RecoveryClaimManager(f.storage, f.leases).claim({
    lease: successorLease,
    planRecord,
    authenticatedRequest: request,
    transaction: {
      at,
      startSequence: 7,
      evidenceDigest: "1".repeat(64),
      accountingDigest: "2".repeat(64),
      resourceEvidenceDigest: "3".repeat(64),
    },
  });
  f.snapshot.factoryEvents.push(
    ...recoveryAdoptionEvents({
      planRecord,
      claim,
      authenticatedRequest: request,
      predecessorStart,
    }),
  );

  let nextIssue = 8;
  vi.spyOn(GithubOctokitGraphWriter.prototype, "createWorkItemIssue").mockImplementation(
    async ({ title, body }) => {
      const number = nextIssue++;
      const id = `I_${number}`;
      f.snapshot.workItems.push({
        id,
        number,
        title,
        body,
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      });
      return { id, number };
    },
  );
  vi.spyOn(GithubOctokitGraphWriter.prototype, "addBlockedBy").mockResolvedValue(undefined);
  return {
    f,
    calls,
    planRecord,
    recovery: {
      requestId: proposal.plan.requestId,
      planDigest: planRecord.digest,
      successorRunId,
    },
  };
}

describe("Supervisor compiler evaluation activation boundary", () => {
  it.each(["accept", "repair"] as const)(
    "report-only %s writes evaluation evidence without activating work",
    async (decision) => {
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        compilerEvaluation: { mode: "report-only" },
      });
      try {
        freshObjective(f);
        const calls = configureCompiler(f, decision);
        const result = await f.run();
        expect(result.reason).toMatch(/report-only/i);
        expect(calls).toEqual(["inventory", "compile", "judge"]);
        assertNoProjection(f);
        expect([...f.refs.keys()].some((ref) => ref.includes("/graphs/"))).toBe(false);
        expect([...f.refs.keys()].some((ref) => ref.includes("/compiler-drafts/"))).toBe(true);
        const charges = f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.unit === "model_tokens",
          );
        expect(charges).toHaveLength(3);
        expect(charges.every((event) => event.kind === "budget" && event.amount === 30)).toBe(true);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("report-only refuses inherited activated graphs without executing their workers", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      compilerEvaluation: { mode: "report-only" },
    });
    try {
      const refs = [...f.refs];
      const calls = configureCompiler(f);
      const result = await f.run();
      expect(result.reason).toMatch(/report-only/i);
      expect(calls).toEqual([]);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
      expect([...f.refs]).toEqual(refs);
      expect(f.snapshot.closed).toBe(false);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("fences a changed Objective when resuming after accepted graph persistence", async () => {
    let blockProjection = false;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      compilerEvaluation: { mode: "auto-repair" },
      repositoryFence: async () => {
        if (blockProjection)
          throw new PlatformUnavailableError(
            { kind: "server_error", retryAfterMs: 1 },
            new Error("fixture pauses before graph projection"),
          );
      },
    });
    try {
      freshObjective(f);
      const calls = configureCompiler(f);
      const addComment = vi
        .mocked(GitHubControlStore.prototype.addIssueComment)
        .getMockImplementation()!;
      vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
        async (node, body) => {
          if (blockProjection)
            throw new PlatformUnavailableError(
              { kind: "server_error", retryAfterMs: 1 },
              new Error("fixture pauses before graph receipt"),
            );
          return addComment(node, body);
        },
      );
      const persist = CompiledGraphManager.prototype.persist;
      vi.spyOn(CompiledGraphManager.prototype, "persist").mockImplementation(async function (
        this: CompiledGraphManager,
        ...args
      ) {
        const result = await persist.apply(this, args);
        blockProjection = true;
        return result;
      });
      await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      expect(calls).toEqual(["inventory", "compile", "judge"]);
      expect([...f.refs.keys()].some((ref) => ref.includes("/graphs/"))).toBe(true);
      assertNoProjection(f);
      blockProjection = false;
      f.snapshot.body += " Also retain compatibility with old answers.";
      const second = await f.run();
      expect(second.status).not.toBe("completed");
      expect(second.reason).toMatch(/changed|binding|inputs/i);
      expect(calls).toEqual(["inventory", "compile", "judge"]);
      assertNoProjection(f);
      expect(vi.mocked(GitHubControlStore.prototype.closeIssue)).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each([
    "after-evaluation",
    "after-graph-persistence",
    "after-work-item-creation",
    "after-staged-projection",
    "after-projection-receipt",
  ] as const)(
    "rechecks graphless recovery authority %s before the next durable mutation",
    async (boundary) => {
      const { f, calls, planRecord, recovery } = await graphlessCompilerRecoveryFixture();
      try {
        const changeObjective = () => {
          f.snapshot.body += ` Concurrent change ${boundary}.`;
        };
        if (boundary === "after-evaluation") {
          const compile = f.management.compile;
          f.management.compile = async (context, checkpoint, beforeModelInvocation) => {
            const result = await compile(context, checkpoint, beforeModelInvocation);
            changeObjective();
            return result;
          };
        } else if (boundary === "after-graph-persistence") {
          const persist = CompiledGraphManager.prototype.persist;
          vi.spyOn(CompiledGraphManager.prototype, "persist").mockImplementation(async function (
            this: CompiledGraphManager,
            ...args
          ) {
            const result = await persist.apply(this, args);
            vi.mocked(GitHubControlStore.prototype.getBranchHead).mockResolvedValue({
              oid: "f".repeat(40),
              treeOid: "e".repeat(40),
              parentOids: [f.baseSha],
              message: "concurrent base advance",
              serverTime: new Date(),
            });
            return result;
          });
        } else if (boundary === "after-work-item-creation") {
          const create = vi
            .mocked(GithubOctokitGraphWriter.prototype.createWorkItemIssue)
            .getMockImplementation()!;
          vi.mocked(GithubOctokitGraphWriter.prototype.createWorkItemIssue).mockImplementation(
            async (...args) => {
              const result = await create(...args);
              changeObjective();
              return result;
            },
          );
        } else if (boundary === "after-staged-projection") {
          const stage = CompiledGraphManager.prototype.stageProjection;
          vi.spyOn(CompiledGraphManager.prototype, "stageProjection").mockImplementation(
            async function (this: CompiledGraphManager, ...args) {
              const result = await stage.apply(this, args);
              changeObjective();
              return result;
            },
          );
        } else {
          const addComment = vi
            .mocked(GitHubControlStore.prototype.addIssueComment)
            .getMockImplementation()!;
          vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
            async (node, body) => {
              await addComment(node, body);
              if (
                decodeEventComments(body).some(
                  (event) =>
                    event.event === "GraphProjected" && event.runId === recovery.successorRunId,
                )
              )
                changeObjective();
            },
          );
        }

        const result = await f.runRecovery(recovery);
        expect(result).toMatchObject({
          status: "escalated",
          runId: recovery.successorRunId,
          reason: expect.stringMatching(
            /recovered Objective compilation boundary changed|successor graph-bootstrap authority changed/,
          ),
        });
        expect(calls.slice(0, 2)).toEqual(["inventory", "compile"]);
        expect(
          f.events().filter((event) => event.kind === "attempt" || event.kind === "scheduling"),
        ).toEqual([]);
        expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
        expect(f.refs.has(compiledGraphProjectionRef(7, recovery.successorRunId))).toBe(false);
        expect(
          f
            .events()
            .some(
              (event) =>
                event.event === "GraphProjected" && event.runId === recovery.successorRunId,
            ),
        ).toBe(boundary === "after-projection-receipt");
        expect("mode" in planRecord.plan.graph && planRecord.plan.graph.mode).toBe(
          "compile-objective",
        );
      } finally {
        await f.dispose();
      }
    },
    60_000,
  );
});

it("honors activation cancellation after inventory before any further model admission", async () => {
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    controllerActivation: true,
    compilerEvaluation: { mode: "auto-repair" },
  });
  try {
    freshObjective(f);
    const calls = configureCompiler(f);
    const extract = f.management.extractObligations!;
    f.management.extractObligations = async (context, checkpoint, beforeModelInvocation) => {
      const result = await extract(context, checkpoint, beforeModelInvocation);
      const start = f.snapshot.factoryEvents!.find((event) => event.event === "FactoryRunStarted")!;
      if (start.kind !== "run" || start.event !== "FactoryRunStarted" || !start.baseSha)
        throw new Error("fixture requires pinned activation");
      const withdrawal = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "ActivationCancellationRequested",
        objective: 7,
        runId: "fixture-activation",
        activationRequestId: "fixture-activation",
        requestId: "withdraw-after-inventory",
        requestedBy: "operator",
        repository: "fixture/provider-qualification",
        baseSha: start.baseSha,
        policyDigest: start.policyDigest,
        sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
        at: new Date().toISOString(),
      });
      const authenticated = cancellationRequestFromComments(
        [
          {
            body: encodeEventComment("Withdraw activation", withdrawal),
            authorLogin: "operator",
            authorAssociation: "OWNER",
          },
        ],
        f.runId,
        "operator",
        {
          objective: 7,
          requestId: "fixture-activation",
          repository: "fixture/provider-qualification",
          requestedBy: "operator",
          baseSha: start.baseSha,
          policyDigest: start.policyDigest,
        },
      );
      expect(authenticated).not.toBeNull();
      f.snapshot.factoryEvents!.push(authenticated!);
      vi.mocked(GitHubReader.prototype.readRunCancellationRequest).mockResolvedValue(authenticated);
      return result;
    };
    const result = await f.run();
    expect(result.status).toBe("cancelled");
    expect(calls).toEqual(["inventory"]);
    assertNoProjection(f);
    expect([...f.refs.keys()].some((ref) => ref.includes("/graphs/"))).toBe(false);
    expect(
      f
        .events()
        .filter(
          (event) =>
            event.event === "BudgetReconciled" &&
            event.kind === "budget" &&
            event.unit === "model_tokens",
        ),
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 30_000);
