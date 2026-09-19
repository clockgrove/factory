import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompilerDraftBinding,
  CompilerDraftManager,
  CompilerDraftRecord,
} from "../src/control/compiler-drafts.js";
import type { LeaseState } from "../src/control/lease.js";
import { compileEvaluatedDraft } from "../src/management/draft-compilation.js";
import { compilerObligationEvidence } from "../src/management/codex-cli.js";
import {
  EMPTY_REPOSITORY_CAPTURE_PLANNING,
  type CompilationContext,
  type CompilerModelAdmission,
  type ManagementBackend,
  type PlanJudgeContext,
} from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { parsePersistedCompiledObjective, type CompiledObjective } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import {
  runCompilerDraftLoop,
  CompilerDraftAdmissionError,
  type CompilerDraftCallbacks,
} from "../src/evaluation/compiler-draft-loop.js";
import {
  proposalResultFromCompiledFixture,
  pinFixtureRepository,
  validatedDraftFromCompiledFixture,
} from "./helpers/compiler-proposal.js";
import { semanticRequest } from "./helpers/semantic-compiler.js";
import { parseAndValidateCompilerProposal } from "../src/compiler/proposal.js";
function fixtureInvocationProvenance(baseSha: string, stage: string) {
  return {
    promptDigest: compilerEvalDigest({ stage }),
    schemaDigest: "a".repeat(64),
    promptBytes: 100,
    schemaBytes: 200,
    sizeSource: "provider-dispatch" as const,
    baseSha,
    model: null,
    reasoning: null,
  };
}
function proposalAdmissionProvenance(request: Parameters<ManagementBackend["proposePlan"]>[0]) {
  return {
    promptDigest: compilerEvalDigest(request),
    schemaDigest: "a".repeat(64),
    promptBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
    schemaBytes: 1,
    sizeSource: "provider-dispatch" as const,
    baseSha: request.baseSha,
    model: null,
    reasoning: null,
  };
}
const responseEvidence = {
  responseBytes: 100,
  responseBytesSource: "canonical-structured-value" as const,
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function memoryJournal() {
  const records: CompilerDraftRecord[] = [];
  const manager = {
    load: async () => structuredClone(records),
    append: async (
      _lease: LeaseState,
      binding: CompilerDraftBinding,
      sequence: number,
      kind: CompilerDraftRecord["kind"],
      payload: Record<string, unknown>,
    ) => {
      if (sequence !== records.length) throw new Error("competing append");
      const record = {
        protocol: "clockgrove.factory/compiler-draft" as const,
        binding,
        sequence,
        kind,
        payload: structuredClone(payload),
      };
      records.push(record);
      return structuredClone(record);
    },
  } as unknown as CompilerDraftManager;
  return { records, manager };
}
async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "factory-challenge-"));
  temporary.push(repository);
  const golden = JSON.parse(
    await readFile(new URL("./fixtures/compiler/golden-objective.json", import.meta.url), "utf8"),
  );
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ scripts: golden.repositoryFacts.scripts }),
  );
  await writeFile(
    join(repository, "package-lock.json"),
    JSON.stringify({ name: "draft-challenge-fixture", lockfileVersion: 3, packages: {} }),
  );
  const baseSha = pinFixtureRepository(repository);
  const context: CompilationContext = {
    repository,
    objective: {
      number: 42,
      title: golden.title,
      body: "Implement core behavior and executable tests. No infrastructure deployment is requested.",
    },
    baseSha,
    defaultBranch: "main",
    repositoryFiles: [
      "package-lock.json",
      ...golden.repositoryFacts.files.map((file: { path: string }) => file.path),
    ],
    allowedNetworkDestinations: [],
    runPolicy: {
      ...DEFAULT_RUN_POLICY,
      allowedNetworkDestinations: [],
      compilerEvaluation: { mode: "auto-repair" },
    },
    repositoryCapturePlanning: EMPTY_REPOSITORY_CAPTURE_PLANNING,
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const graph = parsePersistedCompiledObjective({
    title: golden.title,
    workItems: golden.workItems.map((item: { acceptance: string[] }) => ({
      ...item,
      criterionRisks: item.acceptance.map((criterion) => ({ criterion, risk: "ordinary" })),
    })),
  });
  const inventory: ObligationInventory = {
    version: 1,
    objectiveDigest: compilerEvalDigest(context.objective),
    baseSha: context.baseSha,
    evidence: context.repositoryEvidence,
    obligations: [
      {
        id: "requested",
        kind: "explicit",
        text: context.objective.body,
        evidenceIds: ["objective"],
        acceptanceEvidence: "Behavior works",
      },
      {
        id: "invented",
        kind: "prerequisite",
        text: "Deploy infrastructure",
        evidenceIds: ["objective"],
        acceptanceEvidence: "Deployment exists",
      },
    ],
  };
  const binding: CompilerDraftBinding = {
    repository: "owner/repo",
    objective: 42,
    runId: "challenge",
    policyDigest: policyDigest(context.runPolicy),
    baseSha: context.baseSha,
    inputDigest: inventory.objectiveDigest,
  };
  const journal = memoryJournal();
  return { context, graph, inventory, binding, ...journal };
}
function judged(context: PlanJudgeContext, accepted: boolean): CompilerJudgeVerdict {
  const graph = context.proposal;
  const corrected = Boolean(context.challenges?.length);
  return {
    version: 1,
    rubricVersion: 1,
    draftDigest: context.graphDigest,
    inventoryDigest: compilerEvalDigest(context.inventory),
    coverage: context.inventory.obligations.map((entry) => ({
      obligationId: entry.id,
      status: entry.id === "invented" ? "missing" : "covered",
      itemIds: entry.id === "invented" ? [] : [graph.workItems[0]!.id],
      acceptanceBindings:
        entry.id === "invented"
          ? []
          : [
              {
                kind: "criterion" as const,
                itemId: graph.workItems[0]!.id,
                criterionId: graph.workItems[0]!.criteria[0]!.id,
              },
            ],
      reason: "Original evidence assessed",
      evidenceIds: ["objective"],
    })),
    items: graph.workItems.map((item) => ({
      itemId: item.id,
      granularity: "cohesive",
      reason: "Cohesive",
      evidenceIds: ["objective"],
    })),
    dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "assessed",
      reason: "Reviewed",
      evidenceIds: ["objective"],
    })),
    dependencies: graph.workItems.map((item) => ({
      itemId: item.id,
      dependsOn: item.dependsOn,
      reason: "Producer contract",
      evidenceIds: ["objective"],
    })),
    findings: accepted
      ? []
      : [
          {
            id: corrected ? "real-refinement" : "false-inference",
            dimension: corrected ? "granularity" : "coverage",
            severity: "blocking",
            confidence: 0.9,
            obligationIds: [corrected ? "requested" : "invented"],
            itemIds: [],
            evidenceIds: ["objective"],
            rootCause: corrected
              ? "Execution detail needs refinement"
              : "Inferred deployment missing",
            correction: corrected ? "Refine goal" : "Deploy infrastructure",
            uncertainty: "",
          },
        ],
    inferenceCorrections: (context.challenges ?? [])
      .filter((challenge) => challenge.obligationId !== undefined)
      .map((challenge) => ({
        findingId: challenge.findingId,
        obligationId: challenge.obligationId!,
        reason: challenge.reason,
        evidenceIds: challenge.evidenceIds,
        disposition: "unsupported-inference",
      })),
    uncertainty: [],
    decision: accepted ? "accept" : "repair",
  };
}
describe("bounded independent challenge integration", () => {
  it.each([65, 128])(
    "derives and durably replays %i distinct obligation challenges end to end",
    async (count) => {
      const f = await fixture();
      f.inventory.obligations = Array.from({ length: count }, (_, index) => ({
        id: `inferred-${index + 1}`,
        kind: "prerequisite" as const,
        text: `Inferred prerequisite ${index + 1}`,
        evidenceIds: ["objective"],
        acceptanceEvidence: `Prerequisite ${index + 1} exists`,
      }));
      const calls: string[] = [];
      const usage = { inputTokens: 2, outputTokens: 1 };
      const backend = {
        supportsCompilerAdmission: true,
        extractObligations: async (
          _context: unknown,
          _checkpoint: unknown,
          beforeModelInvocation?: CompilerModelAdmission,
        ) => {
          const provenance = fixtureInvocationProvenance(f.context.baseSha, "inventory");
          await beforeModelInvocation?.(provenance);
          calls.push("inventory");
          return { inventory: f.inventory, usage, provenance, ...responseEvidence };
        },
        proposePlan: async (
          request: Parameters<ManagementBackend["proposePlan"]>[0],
          checkpoint: Parameters<ManagementBackend["proposePlan"]>[1],
          _projection: Parameters<ManagementBackend["proposePlan"]>[2],
          beforeModelInvocation?: CompilerModelAdmission,
        ) => {
          await beforeModelInvocation?.(proposalAdmissionProvenance(request));
          calls.push(request.revision === 0 ? "compile" : "repair");
          const result = proposalResultFromCompiledFixture(request, f.graph, usage);
          for (const item of result.proposal.workItems) item.obligationIds = [];
          await checkpoint(result);
          return result;
        },
        judgePlan: async (
          context: PlanJudgeContext,
          _checkpoint: unknown,
          beforeModelInvocation?: CompilerModelAdmission,
        ) => {
          const provenance = fixtureInvocationProvenance(f.context.baseSha, "judge");
          await beforeModelInvocation?.(provenance);
          calls.push("judge");
          const challenges = context.challenges ?? [];
          expect(challenges).toHaveLength(
            calls.filter((stage) => stage === "judge").length === 1 ? 0 : count,
          );
          const accepted = challenges.length > 0;
          const verdict: CompilerJudgeVerdict = {
            version: 1,
            rubricVersion: 1,
            draftDigest: context.graphDigest,
            inventoryDigest: compilerEvalDigest(context.inventory),
            coverage: context.inventory.obligations.map((obligation) => ({
              obligationId: obligation.id,
              status: "missing",
              itemIds: [],
              acceptanceBindings: [],
              reason: "The cited prerequisite was not explicitly requested",
              evidenceIds: ["objective"],
            })),
            items: context.proposal.workItems.map((item) => ({
              itemId: item.id,
              granularity: "cohesive",
              reason: "Cohesive",
              evidenceIds: ["objective"],
            })),
            dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
              dimension,
              status: "assessed",
              reason: "Reviewed",
              evidenceIds: ["objective"],
            })),
            dependencies: context.proposal.workItems.map((item) => ({
              itemId: item.id,
              dependsOn: item.dependsOn,
              reason: "Complete dependency set",
              evidenceIds: ["objective"],
            })),
            findings: accepted
              ? []
              : [
                  {
                    id: "unsupported-prerequisites",
                    dimension: "coverage",
                    severity: "blocking",
                    confidence: 0.9,
                    obligationIds: context.inventory.obligations.map((entry) => entry.id),
                    itemIds: [],
                    evidenceIds: ["objective"],
                    rootCause: "Inferred prerequisites are unmapped",
                    correction: "Add every inferred prerequisite",
                    uncertainty: "",
                  },
                ],
            inferenceCorrections: challenges.map((challenge) => ({
              findingId: challenge.findingId,
              obligationId: challenge.obligationId!,
              disposition: "unsupported-inference" as const,
              reason: "The original evidence does not require this prerequisite",
              evidenceIds: challenge.evidenceIds,
            })),
            uncertainty: [],
            decision: accepted ? "accept" : "repair",
          };
          return { verdict, usage, provenance, ...responseEvidence };
        },
      } as unknown as ManagementBackend;
      const args = {
        ...f,
        backend,
        lease: {} as LeaseState,
        deadlineAt: Date.now() + 60_000,
        admit: vi.fn(async () => {}),
        assertInputs: vi.fn(async () => {}),
        recordUsage: vi.fn(async () => {}),
        validate: async () => {},
      };
      await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
        status: "accepted",
        revision: 1,
      });
      const dispatched = calls.length;
      await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({ status: "accepted" });
      expect(calls).toHaveLength(dispatched);
    },
  );

  it("accepts a cited challenge to a false non-explicit deployment inference", async () => {
    const f = await fixture();
    const calls: string[] = [];
    let judges = 0;
    const usage = { inputTokens: 2, outputTokens: 1 };
    const backend = {
      supportsCompilerAdmission: true,
      extractObligations: async (
        _context: unknown,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "inventory");
        await beforeModelInvocation?.(provenance);
        calls.push("inventory");
        return { inventory: f.inventory, usage, provenance, ...responseEvidence };
      },
      proposePlan: async (
        request: Parameters<ManagementBackend["proposePlan"]>[0],
        checkpoint: Parameters<ManagementBackend["proposePlan"]>[1],
        _projection: Parameters<ManagementBackend["proposePlan"]>[2],
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        await beforeModelInvocation?.(proposalAdmissionProvenance(request));
        calls.push(request.revision === 0 ? "compile" : "repair");
        const graph = structuredClone(f.graph);
        const result = proposalResultFromCompiledFixture(request, graph, usage);
        await checkpoint(result);
        return result;
      },
      judgePlan: async (
        context: PlanJudgeContext,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "judge");
        await beforeModelInvocation?.(provenance);
        calls.push("judge");
        judges++;
        expect(context.challenges ?? []).toHaveLength(judges === 1 ? 0 : 1);
        return { verdict: judged(context, judges >= 2), usage, provenance, ...responseEvidence };
      },
    } as unknown as ManagementBackend;
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 60_000,
      admit: vi.fn(async () => {}),
      assertInputs: vi.fn(async () => {}),
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };
    const outcome = await compileEvaluatedDraft(args);
    expect(outcome).toMatchObject({ status: "accepted", revision: 1 });
    expect(calls).toEqual(["inventory", "compile", "judge", "repair", "judge"]);
    expect(f.records.some((record) => record.kind === "selection")).toBe(true);
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({ status: "accepted" });
    expect(calls).toHaveLength(5);
  });

  it("honors an independent judge that upholds a challenged non-explicit prerequisite", async () => {
    const f = await fixture();
    const calls: string[] = [];
    let judges = 0;
    const usage = { inputTokens: 2, outputTokens: 1 };
    const backend = {
      supportsCompilerAdmission: true,
      extractObligations: async (
        _context: unknown,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "inventory");
        await beforeModelInvocation?.(provenance);
        calls.push("inventory");
        return { inventory: f.inventory, usage, provenance, ...responseEvidence };
      },
      proposePlan: async (
        request: Parameters<ManagementBackend["proposePlan"]>[0],
        checkpoint: Parameters<ManagementBackend["proposePlan"]>[1],
        _projection: Parameters<ManagementBackend["proposePlan"]>[2],
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        await beforeModelInvocation?.(proposalAdmissionProvenance(request));
        calls.push(request.revision === 0 ? "compile" : "repair");
        const result = proposalResultFromCompiledFixture(request, f.graph, usage);
        if (request.revision === 2) {
          result.proposal.coverage.push({
            obligationId: "invented",
            bindings: [
              {
                kind: "criterion",
                itemId: result.proposal.workItems[0]!.id,
                criterionId: result.proposal.workItems[0]!.criteria[0]!.id,
              },
            ],
          });
          result.proposal.workItems[0]!.obligationIds.push("invented");
          result.proposal.coverage.sort((left, right) =>
            left.obligationId.localeCompare(right.obligationId),
          );
          result.proposal.workItems[0]!.obligationIds.sort();
          result.report = parseAndValidateCompilerProposal(request, result.proposal).report;
          result.responseBytes = Buffer.byteLength(JSON.stringify(result.proposal), "utf8");
        }
        await checkpoint(result);
        return result;
      },
      judgePlan: async (
        context: PlanJudgeContext,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "judge");
        await beforeModelInvocation?.(provenance);
        calls.push("judge");
        judges++;
        if (judges === 1)
          return { verdict: judged(context, false), usage, provenance, ...responseEvidence };
        expect(context.challenges).toEqual([
          {
            findingId: "false-inference",
            obligationId: "invented",
            reason:
              "The semantic repair deliberately leaves the cited non-explicit obligation unmapped for independent adjudication.",
            evidenceIds: ["objective"],
          },
        ]);
        const verdict = judged(context, judges === 3);
        verdict.inferenceCorrections = context.challenges!.map((challenge) => ({
          findingId: challenge.findingId,
          obligationId: challenge.obligationId!,
          reason: "The cited Objective evidence supports the prerequisite.",
          evidenceIds: challenge.evidenceIds,
          disposition: "upheld" as const,
        }));
        if (judges === 2) {
          verdict.findings = [
            {
              id: "upheld-prerequisite",
              dimension: "coverage",
              severity: "blocking",
              confidence: 0.95,
              obligationIds: ["invented"],
              itemIds: [],
              evidenceIds: ["objective"],
              rootCause: "The upheld prerequisite remains unmapped",
              correction: "Map and satisfy the prerequisite",
              uncertainty: "",
            },
          ];
          verdict.decision = "repair";
        } else {
          const covered = verdict.coverage.find((entry) => entry.obligationId === "invented")!;
          covered.status = "covered";
          covered.itemIds = [context.proposal.workItems[0]!.id];
          covered.acceptanceBindings = [
            {
              kind: "criterion",
              itemId: context.proposal.workItems[0]!.id,
              criterionId: context.proposal.workItems[0]!.criteria[0]!.id,
            },
          ];
          verdict.findings = [];
          verdict.decision = "accept";
        }
        return { verdict, usage, provenance, ...responseEvidence };
      },
    } as unknown as ManagementBackend;
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 60_000,
      admit: vi.fn(async () => {}),
      assertInputs: vi.fn(async () => {}),
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "accepted",
      revision: 2,
    });
    expect(calls).toEqual(["inventory", "compile", "judge", "repair", "judge", "repair", "judge"]);
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "accepted",
      revision: 2,
    });
    expect(calls).toHaveLength(7);
  });

  it("durably stops an oversized repair request before provider admission", async () => {
    const f = await fixture();
    f.context.objective.body += `\n${"objective-context ".repeat(21_800)}`;
    const objectiveDigest = compilerEvalDigest(f.context.objective);
    f.context.repositoryEvidence = compilerObligationEvidence(f.context);
    f.inventory.objectiveDigest = objectiveDigest;
    f.inventory.evidence[0]!.identity = objectiveDigest;
    f.binding.inputDigest = objectiveDigest;
    const calls: string[] = [];
    const admit = vi.fn(async () => {});
    const usage = { inputTokens: 2, outputTokens: 1 };
    const backend = {
      supportsCompilerAdmission: true,
      extractObligations: async (
        _context: unknown,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "inventory");
        await beforeModelInvocation?.(provenance);
        calls.push("inventory");
        return { inventory: f.inventory, usage, provenance, ...responseEvidence };
      },
      proposePlan: async (
        request: Parameters<ManagementBackend["proposePlan"]>[0],
        checkpoint: Parameters<ManagementBackend["proposePlan"]>[1],
        _projection: Parameters<ManagementBackend["proposePlan"]>[2],
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        await beforeModelInvocation?.(proposalAdmissionProvenance(request));
        calls.push(request.revision === 0 ? "compile" : "repair");
        const result = proposalResultFromCompiledFixture(request, f.graph, usage);
        result.proposal.workItems[0]!.preconditions = Array.from(
          { length: 10 },
          (_, index) => `repair-context-${index}-${"x".repeat(1_900)}`,
        );
        expect(Buffer.byteLength(JSON.stringify(result.proposal))).toBeLessThanOrEqual(512 * 1024);
        await checkpoint(result);
        return result;
      },
      judgePlan: async (
        context: PlanJudgeContext,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "judge");
        await beforeModelInvocation?.(provenance);
        calls.push("judge");
        const verdict = judged(context, false);
        verdict.findings = Array.from({ length: 64 }, (_, index) => ({
          id: `material-gap-${index}`,
          dimension: "coverage" as const,
          severity: "blocking" as const,
          confidence: 0.95,
          obligationIds: ["invented"],
          itemIds: [],
          evidenceIds: ["objective"],
          rootCause: `root-${index}-${"r".repeat(3_960)}`,
          correction: `fix-${index}-${"f".repeat(3_960)}`,
          uncertainty: "",
        }));
        verdict.inferenceCorrections = [];
        verdict.decision = "repair";
        expect(Buffer.byteLength(JSON.stringify(verdict))).toBeLessThanOrEqual(512 * 1024);
        return { verdict, usage, provenance, ...responseEvidence };
      },
    } as unknown as ManagementBackend;
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 60_000,
      admit,
      assertInputs: vi.fn(async () => {}),
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };
    const outcome = await compileEvaluatedDraft(args);
    expect(outcome).toMatchObject({
      status: "stopped",
      reason: "compiler-request-limit: split the Objective into smaller Objectives",
    });
    expect(calls).toEqual(["inventory", "compile", "judge"]);
    expect(admit).toHaveBeenCalledTimes(3);
    const repairResult = f.records.find(
      (record) => record.kind === "result" && record.payload.stage === "repair",
    );
    expect(repairResult?.payload).toMatchObject({
      usage: null,
      preProviderTerminal: true,
      stopReason: "compiler-request-limit: split the Objective into smaller Objectives",
      validationReport: {
        protocol: "clockgrove.factory/compiler-validation",
        phase: "request",
        status: "unsatisfiable",
        violations: [expect.objectContaining({ code: "compiler-request-limit" })],
      },
    });
    expect(
      f.records.find((record) => record.kind === "invocation" && record.payload.stage === "repair")
        ?.payload.compilerRequestDigest,
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "compiler-request-limit: split the Objective into smaller Objectives",
    });
    expect(calls).toHaveLength(3);
  });
  it("durably stops a fixed graph before an impossible judge call", async () => {
    const f = await fixture();
    f.context.objective.title = "T".repeat(256);
    f.context.objective.body = "b".repeat(370_000);
    f.context.repositoryEvidence = compilerObligationEvidence(f.context);
    f.context.runPolicy = {
      ...f.context.runPolicy,
      compilerEvaluation: { mode: "report-only" },
    };
    f.inventory = {
      version: 1,
      objectiveDigest: compilerEvalDigest(f.context.objective),
      baseSha: f.context.baseSha,
      evidence: f.context.repositoryEvidence,
      obligations: Array.from({ length: 25 }, (_, index) => ({
        id: `obligation-${index + 1}`,
        kind: "explicit" as const,
        text: `${index}:` + "t".repeat(3_990),
        evidenceIds: ["objective"],
        acceptanceEvidence: `${index}:` + "a".repeat(3_990),
      })),
    };
    f.binding.inputDigest = f.inventory.objectiveDigest;
    f.binding.policyDigest = policyDigest(f.context.runPolicy);
    const calls: string[] = [];
    const admit = vi.fn(async () => {});
    const backend = {
      supportsCompilerAdmission: true,
      extractObligations: async (
        _context: unknown,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        const provenance = fixtureInvocationProvenance(f.context.baseSha, "inventory");
        await beforeModelInvocation?.(provenance);
        calls.push("inventory");
        return {
          inventory: f.inventory,
          usage: { inputTokens: 2, outputTokens: 1 },
          provenance,
          ...responseEvidence,
        };
      },
      judgePlan: vi.fn(),
      proposePlan: vi.fn(),
    } as unknown as ManagementBackend;
    const args = {
      ...f,
      backend,
      fixedGraph: f.graph,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 60_000,
      admit,
      assertInputs: vi.fn(async () => {}),
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "judge-context-limit: split the Objective into smaller Objectives",
    });
    expect(calls).toEqual(["inventory"]);
    expect(admit).toHaveBeenCalledOnce();
    expect(backend.judgePlan).not.toHaveBeenCalled();
    expect(
      f.records.find((record) => record.kind === "result" && record.payload.stage === "judge")
        ?.payload,
    ).toMatchObject({ usage: null, preProviderTerminal: true });
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "judge-context-limit: split the Objective into smaller Objectives",
    });
    expect(calls).toEqual(["inventory"]);
  });
  it("propagates original pre-provider admission failures without synthetic usage results", async () => {
    const f = await fixture();
    const cause = new Error("Objective withdrawn");
    const provider = vi.fn();
    const backend = {
      supportsCompilerAdmission: true,
      extractObligations: async (
        _context: unknown,
        _checkpoint: unknown,
        beforeModelInvocation?: CompilerModelAdmission,
      ) => {
        await beforeModelInvocation?.(fixtureInvocationProvenance(f.context.baseSha, "inventory"));
        return provider();
      },
      judgePlan: vi.fn(),
      proposePlan: vi.fn(),
    } as unknown as ManagementBackend;
    await expect(
      compileEvaluatedDraft({
        ...f,
        backend,
        lease: {} as LeaseState,
        deadlineAt: Date.now() + 60_000,
        assertInputs: async () => {
          throw cause;
        },
        admit: vi.fn(),
        recordUsage: vi.fn(),
        validate: async () => {},
      }),
    ).rejects.toBe(cause);
    expect(provider).not.toHaveBeenCalled();
    expect(f.records.filter((record) => record.kind === "result")).toHaveLength(0);
    expect(f.records.filter((record) => record.kind === "accounting-failure")).toHaveLength(0);
  });
  it("distinguishes new blocker correction evidence on the same item from unchanged blockers", async () => {
    const f = await fixture();
    const callbacks: CompilerDraftCallbacks = {
      invoke: async (request) => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        value:
          request.stage === "inventory"
            ? {}
            : request.stage === "judge"
              ? {
                  accepted: request.revision === 2,
                  findings: [
                    {
                      severity: "blocking",
                      dimension: "coverage",
                      obligationIds: ["same"],
                      itemIds: ["same"],
                      evidenceIds: ["same"],
                      rootCause:
                        request.revision === 0 ? "Original defect" : "Different remaining defect",
                      correction:
                        request.revision === 0 ? "Fix first behavior" : "Fix second behavior",
                    },
                  ],
                }
              : { ...f.graph, title: `revision ${request.revision}` },
      }),
      validateInventory: (value) => value,
      validate: (value) =>
        validatedDraftFromCompiledFixture(semanticRequest(), value as CompiledObjective),
      accept: (value) => (value as { accepted: boolean }).accepted,
      recordUsage: async () => {},
    };
    await expect(
      runCompilerDraftLoop({ ...f, lease: {} as LeaseState, callbacks }),
    ).resolves.toMatchObject({ status: "accepted" });
    const cause = new Error("Fence lost");
    const other = memoryJournal();
    callbacks.invoke = async () => {
      throw new CompilerDraftAdmissionError(cause);
    };
    await expect(
      runCompilerDraftLoop({ ...f, ...other, lease: {} as LeaseState, callbacks }),
    ).rejects.toBe(cause);
    expect(other.records.some((record) => record.kind === "result")).toBe(false);
  });
});

it("does not spend a second judgment on a no-op semantic repair", async () => {
  const f = await fixture();
  f.inventory.obligations = f.inventory.obligations.filter((entry) => entry.kind === "explicit");
  let judges = 0;
  let repairs = 0;
  const usage = { inputTokens: 2, outputTokens: 1 };
  const backend = {
    supportsCompilerAdmission: true,
    extractObligations: async (
      _context: unknown,
      _checkpoint: unknown,
      beforeModelInvocation?: CompilerModelAdmission,
    ) => {
      const provenance = fixtureInvocationProvenance(f.context.baseSha, "inventory");
      await beforeModelInvocation?.(provenance);
      return { inventory: f.inventory, usage, provenance, ...responseEvidence };
    },
    proposePlan: async (
      request: Parameters<ManagementBackend["proposePlan"]>[0],
      checkpoint: Parameters<ManagementBackend["proposePlan"]>[1],
      _projection: Parameters<ManagementBackend["proposePlan"]>[2],
      beforeModelInvocation?: CompilerModelAdmission,
    ) => {
      await beforeModelInvocation?.(proposalAdmissionProvenance(request));
      if (request.revision > 0) repairs++;
      const result = proposalResultFromCompiledFixture(request, f.graph, usage);
      await checkpoint(result);
      return result;
    },
    judgePlan: async (
      context: PlanJudgeContext,
      _checkpoint: unknown,
      beforeModelInvocation?: CompilerModelAdmission,
    ) => {
      const provenance = fixtureInvocationProvenance(f.context.baseSha, "judge");
      await beforeModelInvocation?.(provenance);
      judges++;
      const review = judged(context, judges === 2);
      if (judges === 1)
        review.findings = [
          {
            id: "oversized-false-positive",
            dimension: "granularity",
            severity: "material-efficiency",
            confidence: 0.8,
            obligationIds: [],
            itemIds: [f.graph.workItems[0]!.id],
            evidenceIds: ["objective"],
            rootCause: "Item appears oversized",
            correction: "Split the item",
            uncertainty: "",
          },
        ];
      else
        expect(context.challenges).toEqual([
          {
            findingId: "oversized-false-positive",
            originalFinding: {
              dimension: "granularity",
              rootCause: "Item appears oversized",
              correction: "Split the item",
              itemIds: [f.graph.workItems[0]!.id],
            },
            reason:
              "The cited source defines one cohesive bounded deliverable; splitting would duplicate validation",
            evidenceIds: ["objective"],
          },
        ]);
      return { verdict: review, usage, provenance, ...responseEvidence };
    },
  } as unknown as ManagementBackend;
  const args = {
    ...f,
    backend,
    lease: {} as LeaseState,
    deadlineAt: Date.now() + 60_000,
    admit: vi.fn(async () => {}),
    assertInputs: async () => {},
    recordUsage: async () => {},
    validate: async () => {},
  };
  const outcome = await compileEvaluatedDraft(args);
  expect(outcome).toMatchObject({ status: "stopped", reason: "draft-cycle" });
  expect(judges).toBe(1);
  expect(repairs).toBe(1);
  expect(f.records.some((record) => record.kind === "selection")).toBe(false);
  await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
    status: "stopped",
    reason: "draft-cycle",
  });
  expect(judges).toBe(1);
});
