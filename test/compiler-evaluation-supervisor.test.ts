import { describe, expect, it, vi } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { CompiledGraphManager, compiledGraphProjectionRef } from "../src/control/graphs.js";
import { loadCompilerDrafts } from "../src/control/compiler-drafts.js";
import { GitHubReader, cancellationRequestFromComments } from "../src/github.js";
import { decodeEventComments, encodeEventComment } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_COMPILER_EVALUATION_POLICY, policyDigest } from "../src/protocol/policy.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { compileObjective } from "../src/compiler/index.js";
import { parseWorkerPacketFromIssue } from "../src/graph.js";
import { readRepositoryFacts } from "../src/repository-profiles/index.js";
import { readCompilerObligationEvidence } from "../src/management/codex-cli.js";
import { bindManagementTerminalOutcome } from "../src/management/backend.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import { validatePersistedCompilerDraftJournal } from "../src/evaluation/compiler-draft-loop.js";
import { GithubOctokitGraphWriter } from "../src/graph.js";
import { buildRecoveryProposal } from "../src/recovery/proposal.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { RecoveryPlanManager } from "../src/recovery/plan.js";
import { RecoveryClaimManager } from "../src/recovery/claims.js";
import { recoveryAdoptionEvents } from "../src/recovery/transaction.js";
import { CompilerProposalSchema, type CompilerProposal } from "../src/compiler/contracts.js";
import { proposalResultFromCompiledFixture } from "./helpers/compiler-proposal.js";
import { parseAndValidateCompilerProposal } from "../src/compiler/proposal.js";
import { parseCompilerOperation } from "../src/toolchains/compiler-capabilities.js";

const usage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 4 };
const invocationProvenance = (baseSha: string) => ({
  promptDigest: "a".repeat(64),
  schemaDigest: "b".repeat(64),
  baseSha,
  model: null,
  reasoning: null,
});
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
    const result = { inventory, provenance: invocationProvenance(context.baseSha), usage };
    await checkpoint(result);
    return result;
  };
  f.management.proposePlan = async (
    request,
    checkpoint,
    _projection,
    beforeModelInvocation,
    execution,
  ) => {
    await beforeModelInvocation?.();
    calls.push("compile");
    if (!execution) throw new Error("fixture requires compilation context");
    const criterion = "answer.txt contains the required answer";
    const objective = compileObjective({
      title: execution.objective.title,
      baseSha: execution.baseSha,
      runPolicy: execution.runPolicy,
      repositoryFacts: await readRepositoryFacts(
        execution.repository,
        execution.repositoryFiles,
        execution.repositoryLfs,
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
          baseSha: execution.baseSha,
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
            networkDestinations: ["registry.npmjs.org"],
            permittedSecretNames: [],
            trust: "trusted_local",
          },
          artifactContract: "clockgrove.factory/artifact",
        },
      ],
    });
    const result = proposalResultFromCompiledFixture(request, objective, usage);
    await checkpoint(result);
    return result;
  };
  f.management.judgePlan = async (context, checkpoint, beforeModelInvocation) => {
    await beforeModelInvocation?.();
    calls.push("judge");
    const verdict: CompilerJudgeVerdict = {
      version: 1,
      rubricVersion: 1,
      draftDigest: context.graphDigest,
      inventoryDigest: compilerEvalDigest(context.inventory),
      coverage: [
        {
          obligationId: "answer",
          status: decision === "accept" ? "covered" : "missing",
          itemIds: decision === "accept" ? ["answer"] : [],
          acceptanceBindings:
            decision === "accept" ? [{ itemId: "answer", criterionId: "criterion-1" }] : [],
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
      dependencies: [
        {
          itemId: "answer",
          dependsOn: [],
          reason: "No prerequisite items",
          evidenceIds: ["objective"],
        },
      ],
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
      inferenceCorrections: [],
      uncertainty: [],
      decision,
    };
    const result = {
      verdict,
      provenance: invocationProvenance(context.compilation.baseSha),
      usage,
    };
    await checkpoint(result);
    return result;
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
  const invocationId = `compile-${f.baseSha}`;
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
  it("completes a planning-only result without projection or defect publication", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      compilerEvaluation: { mode: "auto-repair" },
    });
    try {
      freshObjective(f);
      f.policy.findingReporting = {
        destinations: [
          {
            repository: "fixture/provider-qualification",
            audience: "private",
            operations: ["read", "create-issue", "comment-evidence"],
          },
        ],
        maxPublicationWrites: 4,
      };
      const calls: string[] = [];
      Object.assign(f.management, { supportsCompilerAdmission: true });
      f.management.extractObligations = async (context, checkpoint, beforeModelInvocation) => {
        await beforeModelInvocation?.(invocationProvenance(context.baseSha));
        calls.push("inventory");
        const inventory: ObligationInventory = {
          version: 1,
          objectiveDigest: compilerEvalDigest(context.objective),
          baseSha: context.baseSha,
          evidence: await readCompilerObligationEvidence(context),
          obligations: [
            {
              id: "foundation",
              text: "Deliver an independently accepted foundation.",
              kind: "explicit",
              evidenceIds: ["objective"],
              acceptanceEvidence: "The foundation output is accepted.",
            },
            {
              id: "consumer",
              text: "Deliver a consumer of the accepted foundation.",
              kind: "explicit",
              evidenceIds: ["objective"],
              acceptanceEvidence: "The consumer is accepted against the foundation output.",
            },
          ],
        };
        const result = { inventory, provenance: invocationProvenance(context.baseSha), usage };
        await checkpoint(result);
        return result;
      };
      f.management.proposePlan = async (request, checkpoint, projection, beforeModelInvocation) => {
        await beforeModelInvocation?.(invocationProvenance(request.baseSha));
        calls.push("compile");
        const proposal = {
          protocol: "clockgrove.factory/compiler-proposal" as const,
          kind: "objectives" as const,
          objectives: [
            {
              id: "foundation",
              title: "Deliver the foundation",
              outcome: "An independently accepted foundation is available.",
              acceptance: [
                {
                  id: "foundation-accepted",
                  kind: "owned" as const,
                  text: "The foundation behavior and output are accepted.",
                },
              ],
              ownedScope: ["src/foundation/"],
              obligationIds: ["foundation"],
              outputs: [
                {
                  id: "foundation-output",
                  description: "The accepted foundation artifact.",
                  completionAcceptanceIds: ["foundation-accepted"],
                },
              ],
              prerequisiteOutputs: [],
            },
            {
              id: "consumer",
              title: "Deliver the consumer",
              outcome: "The consumer uses the accepted foundation.",
              acceptance: [
                {
                  id: "consumer-accepted",
                  kind: "owned" as const,
                  text: "The consumer behavior is accepted against the foundation.",
                },
              ],
              ownedScope: ["src/consumer/"],
              obligationIds: ["consumer"],
              outputs: [
                {
                  id: "consumer-output",
                  description: "The accepted consumer result.",
                  completionAcceptanceIds: ["consumer-accepted"],
                },
              ],
              prerequisiteOutputs: [{ objectiveId: "foundation", outputId: "foundation-output" }],
            },
          ],
          coverage: [
            {
              obligationId: "foundation",
              disposition: "owned" as const,
              objectiveId: "foundation",
              acceptanceId: "foundation-accepted",
            },
            {
              obligationId: "consumer",
              disposition: "owned" as const,
              objectiveId: "consumer",
              acceptanceId: "consumer-accepted",
            },
          ],
          triggers: [
            {
              code: "independent-milestones" as const,
              source: "obligation-inventory" as const,
              availability: "observed" as const,
              observed: "The consumer requires a separately accepted foundation output.",
              threshold: null,
              obligationIds: ["foundation", "consumer"],
              explanation: "The request contains two independently reviewable milestones.",
            },
          ],
        };
        const report = parseAndValidateCompilerProposal(request, proposal, projection).report;
        expect(report.status, JSON.stringify(report.violations)).toBe("valid");
        const result = {
          request,
          proposal,
          report,
          usage,
          provenance: {
            ...invocationProvenance(request.baseSha),
            requestDigest: compilerEvalDigest(request),
          },
        };
        await checkpoint(result);
        return result;
      };
      f.management.judgePlan = vi.fn(async () => {
        throw new Error("planning results must not enter judgment");
      });

      const first = await f.run();
      expect(first).toMatchObject({
        status: "completed",
        reason: expect.stringMatching(/proposed/),
      });
      expect(calls).toEqual(["inventory", "compile"]);
      expect(f.management.judgePlan).not.toHaveBeenCalled();
      assertNoProjection(f);
      expect(f.events().filter((event) => event.kind === "finding")).toEqual([]);
      expect([...f.refs.keys()].some((ref) => ref.includes("/compiler-drafts/"))).toBe(true);
      const records = await loadCompilerDrafts(f.storage, 7, f.runId);
      expect(() => validatePersistedCompilerDraftJournal(records)).not.toThrow();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("repairs the observed greenfield pnpm failure shape under the omitted-policy default", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      greenfieldLifecycle: true,
      greenfieldDescendants: 2,
      compilerEvaluation: DEFAULT_COMPILER_EVALUATION_POLICY,
    });
    try {
      freshObjective(f);
      f.snapshot.body =
        "Bootstrap one pnpm workspace provider, add descendant checks, and reject unsafe runtime authorization input.";
      const safetyCriterion = "Runtime rejects unsafe authorization input";
      const consumer = f.graph.workItems.find((item) => item.id === "consumer")!;
      consumer.acceptance = [safetyCriterion];
      consumer.criterionRisks = [{ criterion: safetyCriterion, risk: "security" }];
      consumer.validation = [
        {
          tier: "mechanical",
          criteria: [safetyCriterion],
          rationale: "The pinned workspace check covers the runtime safety regression.",
          evidenceCommands: ["pnpm check"],
        },
      ];

      const calls: string[] = [];
      const reports: string[][] = [];
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
              id: "greenfield-pnpm",
              text: context.objective.body,
              kind: "explicit",
              evidenceIds: ["objective"],
              acceptanceEvidence: "Project the provider-bound pnpm graph.",
            },
          ],
        };
        const result = { inventory, provenance: invocationProvenance(context.baseSha), usage };
        await checkpoint(result);
        return result;
      };
      f.management.proposePlan = async (
        request,
        checkpoint,
        _projection,
        beforeModelInvocation,
      ) => {
        await beforeModelInvocation?.(invocationProvenance(request.baseSha));
        calls.push(request.revision === 0 ? "compile" : "repair");
        const adapter = request.repository.toolchains.find(
          (entry) => entry.adapterId === "node-pnpm" && entry.state === "eligible-deferred",
        );
        if (!adapter) throw new Error("fixture requires eligible deferred pnpm authority");
        const checkOperation = parseCompilerOperation("node-pnpm", "pnpm run check");
        if (!checkOperation) throw new Error("fixture requires the finite pnpm check operation");
        const item = (
          id: string,
          scope: string[],
          dependsOn: string[],
          criterion: string,
          risk: "ordinary" | "security",
        ): CompilerProposal["workItems"][number] => ({
          id,
          title: `Implement ${id}`,
          goal: `Deliver ${id}.`,
          obligationIds: id === "bootstrap" ? ["greenfield-pnpm"] : [],
          criteria: [
            {
              id: "criterion-1",
              text: criterion,
              risk,
              validation: [
                {
                  tier: "mechanical",
                  evidence: [
                    {
                      kind: "deferred",
                      adapterId: "node-pnpm",
                      operation: checkOperation,
                    },
                  ],
                },
              ],
            },
          ],
          scope,
          preconditions: [],
          outOfScope: [],
          conventions: [],
          dependsOn,
          exclusiveResources: [],
          executionIntent: {
            estimatedDurationMinutes: 10,
            additionalTools: [],
            services: [],
            additionalNetworkDestinations: [],
            trust: "trusted_local",
          },
        });
        const proposal = CompilerProposalSchema.parse({
          protocol: "clockgrove.factory/compiler-proposal",
          kind: "work-items",
          workItems: [
            item(
              "bootstrap",
              ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "packages/"],
              [],
              "The introduced workspace check passes",
              "ordinary",
            ),
            item("consumer", ["consumer.txt"], ["bootstrap"], safetyCriterion, "security"),
            item(
              "descendant",
              ["descendant.txt"],
              ["consumer"],
              "The descendant workspace check passes",
              "ordinary",
            ),
          ],
        });
        if (request.revision > 0) {
          const report = parseAndValidateCompilerProposal(request, proposal).report;
          const result = {
            request,
            proposal,
            report,
            usage,
            provenance: {
              ...invocationProvenance(request.baseSha),
              requestDigest: compilerEvalDigest(request),
            },
          };
          await checkpoint(result);
          return result;
        }
        if (proposal.kind !== "work-items") throw new Error("fixture requires Work Items");
        const secondOperation = parseCompilerOperation("node-pnpm", "pnpm run test");
        if (!secondOperation) throw new Error("fixture requires a finite second pnpm operation");
        proposal.workItems[0]!.criteria[0]!.validation[0]!.evidence.push({
          kind: "deferred",
          adapterId: "node-pnpm",
          operation: secondOperation,
        });
        proposal.workItems[1]!.criteria[0]!.validation[0]!.evidence = [];
        proposal.workItems[1]!.criteria[0]!.risk = "ordinary";
        const report = parseAndValidateCompilerProposal(request, proposal).report;
        reports.push(report.violations.map((violation) => violation.code));
        throw bindManagementTerminalOutcome(
          Object.assign(new Error("invalid semantic proposal"), {
            usage,
            proposal,
            validationReport: report,
            provenance: invocationProvenance(request.baseSha),
          }),
          { state: "succeeded", usage },
        );
      };
      f.management.judgePlan = async (context, checkpoint, beforeModelInvocation) => {
        await beforeModelInvocation?.();
        calls.push("judge");
        const verdict: CompilerJudgeVerdict = {
          version: 1,
          rubricVersion: 1,
          draftDigest: context.graphDigest,
          inventoryDigest: compilerEvalDigest(context.inventory),
          coverage: [
            {
              obligationId: "greenfield-pnpm",
              status: "covered",
              itemIds: context.proposal.workItems.map((item) => item.id),
              acceptanceBindings: context.proposal.workItems.flatMap((item) =>
                item.criteria.map((criterion) => ({
                  itemId: item.id,
                  criterionId: criterion.id,
                })),
              ),
              evidenceIds: ["objective"],
              reason: "The repaired provider and descendants cover the greenfield Objective.",
            },
          ],
          items: context.proposal.workItems.map((item) => ({
            itemId: item.id,
            granularity: "cohesive",
            reason: "Each item owns one bounded deliverable.",
            evidenceIds: ["objective"],
          })),
          dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
            dimension,
            status: "assessed",
            reason: "The repaired proposal is complete and bounded.",
            evidenceIds: ["objective"],
          })),
          dependencies: context.proposal.workItems.map((item) => {
            const dependsOn = [
              ...new Set([
                ...item.dependsOn,
                ...context.projectionTrace.addedEdges
                  .filter((edge) => edge.itemId === item.id)
                  .map((edge) => edge.dependsOn),
              ]),
            ];
            return {
              itemId: item.id,
              dependsOn,
              reason: dependsOn.length
                ? "The descendant waits for its capability provider."
                : "The bootstrap provider is the dependency root.",
              evidenceIds: ["objective"],
            };
          }),
          findings: [],
          inferenceCorrections: [],
          uncertainty: [],
          decision: "accept",
        };
        const result = {
          verdict,
          provenance: invocationProvenance(context.compilation.baseSha),
          usage,
        };
        await checkpoint(result);
        return result;
      };
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
      vi.spyOn(GithubOctokitGraphWriter.prototype, "addBlockedBy").mockImplementation(
        async (issueId, blockingIssueId) => {
          const blocked = f.snapshot.workItems.find((item) => item.id === issueId)!;
          const blocking = f.snapshot.workItems.find((item) => item.id === blockingIssueId)!;
          blocked.blockedBy.push({ number: blocking.number, closed: false });
        },
      );

      const result = await f.run();
      expect(reports).toHaveLength(1);
      expect(calls).toEqual(["inventory", "compile", "repair", "judge"]);
      expect(reports[0]).toEqual(
        expect.arrayContaining(["operation-count-limit", "uncovered-criterion"]),
      );
      expect(
        f
          .events()
          .some(
            (event) =>
              event.kind === "graph" && event.event === "GraphProjected" && event.graphSize === 3,
          ),
      ).toBe(true);
      expect(f.snapshot.workItems).toHaveLength(3);
      const projected = f.snapshot.workItems.map((workItem) =>
        parseWorkerPacketFromIssue(workItem.body ?? ""),
      );
      expect(projected[1]?.criterionRisks).toContainEqual({
        criterion: safetyCriterion,
        risk: "security",
      });
      expect(
        projected.map((packet) => packet.repositoryCapabilities?.requires[0]?.providerWorkItem),
      ).toEqual(["bootstrap", "bootstrap", "bootstrap"]);
      // This regression stops at its accepted projection boundary; worker
      // qualification belongs to the installed candidate scenario.
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringContaining("attempt budget exhausted"),
      });
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.phase === "management" &&
              event.unit === "model_tokens",
          ),
      ).toHaveLength(4);
    } finally {
      await f.dispose();
    }
  }, 30_000);

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
          const proposePlan = f.management.proposePlan;
          f.management.proposePlan = async (
            request,
            checkpoint,
            projection,
            beforeModelInvocation,
            execution,
          ) => {
            const result = await proposePlan(
              request,
              checkpoint,
              projection,
              beforeModelInvocation,
              execution,
            );
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
