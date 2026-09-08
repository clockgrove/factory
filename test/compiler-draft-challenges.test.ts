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
import {
  compileEvaluatedDraft,
  assertCompilerDraftSelection,
} from "../src/management/draft-compilation.js";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
} from "../src/management/codex-cli.js";
import type {
  CompilationContext,
  ManagementBackend,
  PlanJudgeContext,
} from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { compiledGraphDigest, type CompiledObjective } from "../src/graph.js";
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
        protocol: "clockgrove.factory/compiler-draft-v1" as const,
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
  const context: CompilationContext = {
    repository,
    objective: {
      number: 42,
      title: golden.title,
      body: "Implement core behavior and executable tests. No infrastructure deployment is requested.",
    },
    baseSha: golden.baseSha,
    defaultBranch: "main",
    repositoryFiles: golden.repositoryFacts.files.map((file: { path: string }) => file.path),
    allowedNetworkDestinations: [],
    runPolicy: { ...DEFAULT_RUN_POLICY, compilerEvaluation: { mode: "auto-repair" } },
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const graph = (
    await new CodexCliManagementBackend({
      runStructured: async () => ({
        value: {
          title: golden.title,
          workItems: golden.workItems.map((item: { acceptance: string[] }) => ({
            ...item,
            criterionRisks: item.acceptance.map((criterion) => ({ criterion, risk: "ordinary" })),
          })),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }).compile(context, async () => {})
  ).objective;
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
  const graph = context.objective;
  const corrected = Boolean(context.challenges?.length);
  return {
    version: 1,
    rubricVersion: 1,
    draftDigest: compiledGraphDigest(graph),
    inventoryDigest: compilerEvalDigest(context.inventory),
    coverage: context.inventory.obligations.map((entry) => ({
      obligationId: entry.id,
      status: entry.id === "invented" ? "missing" : "covered",
      itemIds: entry.id === "invented" ? [] : [graph.workItems[0]!.id],
      acceptanceBindings:
        entry.id === "invented"
          ? []
          : [{ itemId: graph.workItems[0]!.id, criterion: graph.workItems[0]!.acceptance[0]! }],
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
    dependencies: graph.workItems.flatMap((item) =>
      item.dependsOn.map((dependsOn) => ({
        itemId: item.id,
        dependsOn,
        reason: "Producer contract",
        evidenceIds: ["objective"],
      })),
    ),
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
  it("reviews an unchanged graph with new challenge evidence and carries it through a second repair and replay", async () => {
    const f = await fixture();
    const calls: string[] = [];
    let judges = 0;
    const usage = { inputTokens: 2, outputTokens: 1 };
    const backend = {
      extractObligations: async () => {
        calls.push("inventory");
        return { inventory: f.inventory, usage };
      },
      compile: async () => {
        calls.push("compile");
        return { objective: f.graph, usage };
      },
      repairPlan: async (context: { revision: number; challenges?: unknown[] }) => {
        calls.push("repair");
        if (context.revision === 2) expect(context.challenges).toHaveLength(1);
        const graph = structuredClone(f.graph);
        if (context.revision === 2) graph.workItems[0]!.goal += " with explicit execution detail";
        return {
          objective: graph,
          usage,
          repair: {
            changeSummary: "Evidence-cited correction",
            lineage: graph.workItems.map((item) => ({
              itemId: item.id,
              previousItemIds: [item.id],
            })),
            findingDispositions: [
              {
                findingId: context.revision === 1 ? "false-inference" : "real-refinement",
                disposition: context.revision === 1 ? "challenged" : "addressed",
                reason: "Original source excludes deployment",
                evidenceIds: ["objective"],
              },
            ],
          },
        };
      },
      judgePlan: async (context: PlanJudgeContext) => {
        calls.push("judge");
        judges++;
        expect(context.challenges ?? []).toHaveLength(judges === 1 ? 0 : 1);
        return { verdict: judged(context, judges === 3), usage };
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
    expect(outcome.status).toBe("accepted");
    expect(calls).toEqual(["inventory", "compile", "judge", "repair", "judge", "repair", "judge"]);
    const selected = f.records.find((record) => record.kind === "selection")!;
    expect(selected.payload.reviewEvidence).toHaveLength(1);
    if (outcome.status !== "accepted") throw new Error("expected accepted");
    assertCompilerDraftSelection(f.records, outcome.graph, f.binding.inputDigest);
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({ status: "accepted" });
    expect(calls).toHaveLength(7);
    selected.payload.reviewEvidence = [];
    expect(() => assertCompilerDraftSelection(f.records, outcome.graph)).toThrow(
      "judge input evidence changed",
    );
  });
  it("propagates original pre-provider admission failures without synthetic usage results", async () => {
    const f = await fixture();
    const cause = new Error("Objective withdrawn");
    const backend = {
      extractObligations: vi.fn(),
      judgePlan: vi.fn(),
      repairPlan: vi.fn(),
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
    expect(backend.extractObligations).not.toHaveBeenCalled();
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
      validate: (value) => value as CompiledObjective,
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

it("reconsiders a cited item-only granularity false positive on the unchanged graph", async () => {
  const f = await fixture();
  f.inventory.obligations = f.inventory.obligations.filter((entry) => entry.kind === "explicit");
  let judges = 0;
  let repairs = 0;
  const usage = { inputTokens: 2, outputTokens: 1 };
  const backend = {
    extractObligations: async () => ({ inventory: f.inventory, usage }),
    compile: async () => ({ objective: f.graph, usage }),
    repairPlan: async () => {
      repairs++;
      return {
        objective: f.graph,
        usage,
        repair: {
          changeSummary: "Challenge unsupported split",
          lineage: f.graph.workItems.map((item) => ({
            itemId: item.id,
            previousItemIds: [item.id],
          })),
          findingDispositions: [
            {
              findingId: "oversized-false-positive",
              disposition: "challenged",
              reason:
                "The cited source defines one cohesive bounded deliverable; splitting would duplicate validation",
              evidenceIds: ["objective"],
            },
          ],
        },
      };
    },
    judgePlan: async (context: PlanJudgeContext) => {
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
      return { verdict: review, usage };
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
  expect(outcome.status).toBe("accepted");
  expect(judges).toBe(2);
  expect(repairs).toBe(1);
  if (outcome.status !== "accepted") throw new Error("expected acceptance");
  expect(outcome.graphDigest).toBe(compiledGraphDigest(f.graph));
  assertCompilerDraftSelection(f.records, outcome.graph, f.binding.inputDigest);
  await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({ status: "accepted" });
  expect(judges).toBe(2);
});
