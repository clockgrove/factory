import { readFile, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectCompilerEvaluation,
  mechanicalDependencyCriticalPath,
  readCompilerCausalAnnotationsFile,
  type CompilerCausalAnnotations,
} from "../src/application/compiler-eval.js";
import {
  loadCompilerDrafts,
  draftDigest,
  type CompilerDraftManager,
  type CompilerDraftRecord,
} from "../src/control/compiler-drafts.js";
import {
  CompiledGraphProjectionConflictError,
  loadCompiledGraph,
  loadCompiledGraphProjection,
  type CompiledGraphReadStore,
} from "../src/control/graphs.js";
import { latestRunReceipts } from "../src/control/receipts.js";
import { summarizeRun } from "../src/economics/index.js";
import { compiledGraphDigest, parsePersistedCompiledObjective } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  compilerPlanningInventory,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type { ApplicationSnapshot } from "../src/application/services.js";
import { CompilerProposalSchema, CompilerRequestSchema } from "../src/compiler/contracts.js";
import { compilerJudgeCandidateFromCompiled } from "../src/compiler/judge-context.js";
import {
  factoryCompilerCapabilities,
  type CompilerProjectionTrace,
} from "../src/compiler/proposal.js";
import {
  runCompilerDraftLoop,
  validatePersistedCompilerDraftJournal,
  type CompilerDraftCallbacks,
} from "../src/evaluation/compiler-draft-loop.js";
import { emptyCompilerValidationReport } from "../src/compiler/violations.js";
import type { LeaseState } from "../src/control/lease.js";
vi.mock("../src/control/compiler-drafts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/compiler-drafts.js")>()),
  loadCompilerDrafts: vi.fn(),
}));
vi.mock("../src/control/graphs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/graphs.js")>()),
  loadCompiledGraph: vi.fn(),
  loadCompiledGraphProjection: vi.fn(),
}));
vi.mock("../src/control/receipts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/receipts.js")>()),
  latestRunReceipts: vi.fn(),
}));
vi.mock("../src/economics/index.js", () => ({ summarizeRun: vi.fn() }));
const objective = { number: 236, title: "Objective", body: "Deliver change" };
const runPolicy = structuredClone(DEFAULT_RUN_POLICY);
const objectiveDigest = compilerEvalDigest(objective);
const sourceEvidence = {
  objective: structuredClone(objective),
  evidence: [
    {
      id: "objective",
      kind: "objective" as const,
      identity: objectiveDigest,
      excerpt: "Objective\nDeliver change",
    },
  ],
  modelSelection: null,
};
const binding = {
  repository: "clockgrove/factory",
  objective: 236,
  runId: "run",
  policyDigest: policyDigest(runPolicy),
  baseSha: "a".repeat(40),
  inputDigest: compilerEvalDigest({
    objective,
    assetManifestDigest: null,
    compilerMediaEgress: runPolicy.compilerMediaEgress,
  }),
};
const snapshot: ApplicationSnapshot = {
  id: "objective",
  number: 236,
  title: "Objective",
  defaultBranch: "main",
  workItems: [],
};
const store = {} as CompiledGraphReadStore;
const inventory: ObligationInventory = {
  version: 1,
  objectiveDigest,
  baseSha: binding.baseSha,
  evidence: structuredClone(sourceEvidence.evidence),
  obligations: [
    {
      id: "change",
      text: "Deliver change",
      kind: "explicit",
      evidenceIds: ["objective"],
      acceptanceEvidence: "Check change",
    },
  ],
};
const golden = JSON.parse(
  await readFile(new URL("./fixtures/compiler/golden-objective.json", import.meta.url), "utf8"),
);
const graph = parsePersistedCompiledObjective({ title: golden.title, workItems: golden.workItems });
const proposal = CompilerProposalSchema.parse({
  protocol: "clockgrove.factory/compiler-proposal",
  kind: "work-items",
  mediaIntents: [],
  coverage: [
    {
      obligationId: "change",
      bindings: [
        {
          kind: "criterion",
          itemId: graph.workItems[0]!.id,
          criterionId: `${graph.workItems[0]!.id}-criterion-1`,
        },
      ],
    },
  ],
  workItems: graph.workItems.map((item, itemIndex) => ({
    id: item.id,
    title: item.title,
    goal: item.goal,
    obligationIds: itemIndex === 0 ? ["change"] : [],
    criteria: item.acceptance.map((text, criterionIndex) => ({
      id: `${item.id}-criterion-${criterionIndex + 1}`,
      text,
      risk: "ordinary",
      validation: [
        {
          tier: "mechanical",
          evidence: [{ kind: "observed", recipeId: "recipe-test" }],
        },
      ],
    })),
    scope: item.scope,
    preconditions: item.preconditions,
    outOfScope: item.outOfScope,
    conventions: item.conventions,
    dependsOn: item.dependsOn,
    exclusiveResources: item.changeSurface?.exclusiveResources ?? [],
    executionIntent: {
      estimatedDurationMinutes: 30,
      additionalTools: [],
      services: [],
      additionalNetworkDestinations: [],
      trust: "isolated",
    },
  })),
});
const proposalRequest = CompilerRequestSchema.parse({
  protocol: "clockgrove.factory/compiler-request",
  revision: 1,
  objective: { ...objective, digest: objectiveDigest },
  baseSha: binding.baseSha,
  inventory: compilerPlanningInventory(inventory),
  inventorySource: "independent-extraction",
  factoryCapabilities: factoryCompilerCapabilities(runPolicy),
  repository: {
    manifests: ["package.json"],
    requiredTools: [],
    validationRecipes: [
      {
        id: "recipe-test",
        command: "npm test",
        adapterId: "node-npm",
        requiredTools: ["node", "npm"],
        networkDestinations: [],
        capture: null,
      },
    ],
    toolchains: [],
    validationSurfaces: {
      deterministicSimulation: { count: 0, digest: compilerEvalDigest([]), sample: [] },
      python: { count: 0, digest: compilerEvalDigest([]), sample: [] },
      rust: { count: 0, digest: compilerEvalDigest([]), sample: [] },
      go: { count: 0, digest: compilerEvalDigest([]), sample: [] },
    },
    pathCount: 1,
  },
  media: {
    assetManifest: null,
    assetEgress: {
      mode: "denied",
      policyDigest: compilerEvalDigest({
        mode: "denied",
        maxAssets: 0,
        deterministicReviewRuleIds: [],
      }),
    },
    producerCapabilities: [],
    reviewRules: [],
  },
  repositoryCapture: {
    execution: { commands: [] },
    egress: {
      policyDigest: compilerEvalDigest(DEFAULT_RUN_POLICY.repositoryCaptureEgress),
      deterministicGateIds: [...DEFAULT_RUN_POLICY.repositoryCaptureEgress.deterministicGateIds],
      review: structuredClone(DEFAULT_RUN_POLICY.repositoryCaptureEgress.review),
    },
    reviewer: null,
    comparators: [],
    deterministicGates: [],
  },
  constraints: {
    maxWorkItems: 100,
    planningWorkItemThreshold: 100,
    planningCriticalPathMinutes: 43_200,
    planningAggregateWorkMinutes: 432_000,
    maxDependenciesPerItem: 50,
    allowedNetworkDestinations: [],
    workItemTimeoutMinutes: 30,
  },
  previousProposal: null,
  validationReport: {
    protocol: "clockgrove.factory/compiler-validation",
    phase: "proposal",
    status: "repairable",
    violations: [
      {
        code: "schema-invalid",
        itemId: null,
        field: "",
        expected: "valid proposal",
        observed: null,
      },
    ],
  },
  semanticFindings: [],
  challenges: [],
});
const projectionTrace: CompilerProjectionTrace = {
  protocol: "clockgrove.factory/compiler-projection",
  requestDigest: compilerEvalDigest(proposalRequest),
  proposalDigest: compilerEvalDigest(proposal),
  graphDigest: compiledGraphDigest(graph),
  addedEdges: [],
  adapterBindings: [],
  mediaIntents: [],
  riskElevations: { count: 0, digest: compilerEvalDigest([]) },
};
function history() {
  const records: CompilerDraftRecord[] = [];
  const limits = {
    maxRepairs: 2,
    maxInvocations: 7,
    maxObservedTokens: Number.MAX_SAFE_INTEGER,
    deadlineMs: 600_000,
  };
  let timestamp = Date.parse("2026-09-15T20:00:00.000Z");
  const add = (kind: CompilerDraftRecord["kind"], payload: Record<string, unknown>) =>
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding: structuredClone(binding),
      sequence: records.length,
      kind,
      payload,
    });
  const call = (args: {
    stage: "inventory" | "compile" | "repair" | "judge";
    revision: number;
    inputDigest: string;
    value: unknown;
    compilerRequestDigest?: string;
    error?: string;
    proposal?: unknown;
  }) => {
    const invocationId = `compiler-${draftDigest({
      binding,
      stage: args.stage,
      revision: args.revision,
    })}`;
    const expectedProvenance = {
      promptDigest: "1".repeat(64),
      schemaDigest: "2".repeat(64),
      promptBytes: 120,
      schemaBytes: 240,
      sizeSource: "provider-dispatch",
      baseSha: binding.baseSha,
      model: "fixture",
      reasoning: "high",
      mediaEgressDigest: compilerEvalDigest(runPolicy.compilerMediaEgress),
    };
    const startedAt = ++timestamp;
    add("invocation", {
      startedAt,
      invocationId,
      stage: args.stage,
      revision: args.revision,
      inputDigest: args.inputDigest,
      expectedProvenance,
      ...(args.compilerRequestDigest ? { compilerRequestDigest: args.compilerRequestDigest } : {}),
    });
    const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 };
    add("result", {
      invocationId,
      stage: args.stage,
      revision: args.revision,
      value: args.error ? null : args.value,
      usage,
      responseBytes: 80,
      responseBytesSource: "provider-final-response",
      completedAt: ++timestamp,
      observedMilliseconds: timestamp - startedAt,
      provenance: expectedProvenance,
      terminalOutcome: {
        state: args.error ? "provider-failed" : "succeeded",
        usage,
      },
      ...(args.error ? { error: args.error } : {}),
      ...(args.proposal === undefined ? {} : { proposal: args.proposal }),
    });
    return records.at(-1)!;
  };
  add("started", {
    limits,
    startedAt: timestamp,
    sourceEvidenceDigest: draftDigest(sourceEvidence),
    fixedGraphDigest: null,
    adapterMode: "provider",
  });
  add("source-evidence", {
    sourceEvidence: structuredClone(sourceEvidence),
    sourceEvidenceDigest: draftDigest(sourceEvidence),
  });
  call({
    stage: "inventory",
    revision: 0,
    inputDigest: draftDigest({
      inventory: null,
      previous: null,
      projection: null,
      failure: null,
    }),
    value: structuredClone(inventory),
  });
  const compileRequest = CompilerRequestSchema.parse({
    ...structuredClone(proposalRequest),
    revision: 0,
  });
  const compileRequestDigest = draftDigest(compileRequest);
  const compileFailure = {
    error: "secret-api-key=do-not-display",
    proposal: structuredClone(proposal),
  };
  call({
    stage: "compile",
    revision: 0,
    inputDigest: draftDigest({
      inventory,
      previous: null,
      projection: null,
      failure: null,
    }),
    compilerRequestDigest: compileRequestDigest,
    value: null,
    error: compileFailure.error,
    proposal: compileFailure.proposal,
  });
  const repairRequestDigest = draftDigest(proposalRequest);
  const repairValue = {
    request: structuredClone(proposalRequest),
    proposal: structuredClone(proposal),
    report: {
      protocol: "clockgrove.factory/compiler-validation",
      phase: "proposal",
      status: "valid",
      violations: [],
    },
    provenance: { requestDigest: repairRequestDigest },
  };
  call({
    stage: "repair",
    revision: 1,
    inputDigest: draftDigest({
      inventory,
      previous: proposal,
      projection: null,
      failure: compileFailure,
    }),
    compilerRequestDigest: repairRequestDigest,
    value: repairValue,
  });
  add("validation", {
    revision: 1,
    valid: true,
    graph,
    graphDigest: compiledGraphDigest(graph),
    proposalDigest: draftDigest(proposal),
    resultDigest: draftDigest(repairValue),
    traceDigest: draftDigest(projectionTrace),
    projectionTrace: structuredClone(projectionTrace),
    requestDigest: repairRequestDigest,
  });
  const verdict = {
    version: 1,
    rubricVersion: 1,
    draftDigest: compiledGraphDigest(graph),
    inventoryDigest: compilerEvalDigest(inventory),
    coverage: [
      {
        obligationId: "change",
        status: "covered",
        itemIds: [graph.workItems[0]!.id],
        acceptanceBindings: [
          {
            kind: "criterion" as const,
            itemId: graph.workItems[0]!.id,
            criterionId:
              proposal.kind === "work-items"
                ? proposal.workItems[0]!.criteria[0]!.id
                : (() => {
                    throw new Error("fixture requires a Work Item proposal");
                  })(),
          },
        ],
        evidenceIds: ["objective"],
        reason: "Mapped acceptance",
      },
    ],
    items: graph.workItems.map((item) => ({
      itemId: item.id,
      granularity: "cohesive",
      evidenceIds: ["objective"],
      reason: "Cohesive",
    })),
    dependencies: graph.workItems.map((item) => ({
      itemId: item.id,
      dependsOn: item.dependsOn,
      evidenceIds: ["objective"],
      reason: "Required output",
    })),
    dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "assessed",
      reason: "Assessed",
      evidenceIds: ["objective"],
    })),
    inferenceCorrections: [],
    findings: [],
    uncertainty: [],
    decision: "accept",
  };
  call({
    stage: "judge",
    revision: 1,
    inputDigest: draftDigest({
      inventory,
      previous: proposal,
      projection: projectionTrace,
      failure: null,
    }),
    value: verdict,
  });
  add("selection", {
    revision: 1,
    graphDigest: compiledGraphDigest(graph),
    inventoryDigest: draftDigest(inventory),
    verdictDigest: draftDigest(verdict),
    proposalDigest: draftDigest(proposal),
    requestDigest: repairRequestDigest,
    traceDigest: draftDigest(projectionTrace),
  });
  validatePersistedCompilerDraftJournal(records);
  return records;
}
function terminalAfterInventoryHistory(): CompilerDraftRecord[] {
  const complete = history();
  const compileIndex = complete.findIndex(
    (record) => record.kind === "invocation" && record.payload.stage === "compile",
  );
  const records = complete.slice(0, compileIndex);
  records.push({
    protocol: "clockgrove.factory/compiler-draft",
    binding: structuredClone(binding),
    sequence: records.length,
    kind: "stopped",
    payload: { reason: "inventory-terminal" },
  });
  validatePersistedCompilerDraftJournal(records);
  return records;
}
function terminalAfterUnknownProposalHistory(): CompilerDraftRecord[] {
  const complete = history();
  const compileIndex = complete.findIndex(
    (record) => record.kind === "invocation" && record.payload.stage === "compile",
  );
  const records = complete.slice(0, compileIndex + 1);
  const invocation = records.at(-1)!;
  const invocationId = String(invocation.payload.invocationId);
  const startedAt = Number(invocation.payload.startedAt);
  records.push(
    {
      protocol: "clockgrove.factory/compiler-draft",
      binding: structuredClone(binding),
      sequence: records.length,
      kind: "result",
      payload: {
        invocationId,
        stage: "compile",
        revision: 0,
        value: null,
        usage: null,
        responseBytes: 0,
        responseBytesSource: "no-structured-response",
        completedAt: startedAt + 1,
        observedMilliseconds: 1,
        provenance: structuredClone(invocation.payload.expectedProvenance),
        terminalOutcome: { state: "provider-failed", usage: null },
        error: "provider rejected the proposal response",
      },
    },
    {
      protocol: "clockgrove.factory/compiler-draft",
      binding: structuredClone(binding),
      sequence: records.length + 1,
      kind: "stopped",
      payload: { reason: "accounting-unavailable" },
    },
  );
  validatePersistedCompilerDraftJournal(records);
  return records;
}
async function emitFixedGraphHistory(): Promise<CompilerDraftRecord[]> {
  const durable: CompilerDraftRecord[] = [];
  const manager = {
    load: async () => structuredClone(durable),
    append: async (
      _lease: LeaseState,
      recordBinding: typeof binding,
      sequence: number,
      kind: CompilerDraftRecord["kind"],
      payload: Record<string, unknown>,
    ) => {
      if (sequence !== durable.length || draftDigest(recordBinding) !== draftDigest(binding))
        throw new Error("fixture journal append fence");
      const record: CompilerDraftRecord = {
        protocol: "clockgrove.factory/compiler-draft",
        binding: recordBinding,
        sequence,
        kind,
        payload: structuredClone(payload),
      };
      durable.push(record);
      return structuredClone(record);
    },
  } as unknown as CompilerDraftManager;
  const candidate = compilerJudgeCandidateFromCompiled(graph);
  const graphDigest = compiledGraphDigest(graph);
  const requestDigest = draftDigest({ fixedGraph: graphDigest });
  const trace: CompilerProjectionTrace = {
    ...projectionTrace,
    requestDigest,
    proposalDigest: draftDigest(candidate),
    graphDigest,
  };
  const verdict = structuredClone(
    history().find((record) => record.kind === "result" && record.payload.stage === "judge")!
      .payload.value,
  ) as {
    coverage: Array<{ acceptanceBindings: Array<{ criterionId: string }> }>;
  };
  verdict.coverage[0]!.acceptanceBindings[0]!.criterionId = candidate.workItems[0]!.criteria[0]!.id;
  const callbacks: CompilerDraftCallbacks = {
    invoke: async (request, checkpoint) => {
      const result = {
        value:
          request.stage === "inventory" ? structuredClone(inventory) : structuredClone(verdict),
        usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 },
      };
      await checkpoint(result);
      return result;
    },
    recordUsage: async () => {},
    validateInventory: (value) => value,
    validate: () => ({
      proposal: candidate,
      objective: graph,
      projectionTrace: trace,
      report: emptyCompilerValidationReport(),
      requestDigest,
    }),
    accept: () => true,
  };
  let now = Date.parse("2026-09-15T20:00:00.000Z");
  const result = await runCompilerDraftLoop({
    manager,
    lease: {} as LeaseState,
    binding,
    callbacks,
    limits: {
      maxRepairs: 0,
      maxInvocations: 7,
      maxObservedTokens: Number.MAX_SAFE_INTEGER,
      deadlineMs: 600_000,
    },
    now: () => ++now,
    startedAt: now,
    fixedGraph: graph,
    sourceEvidence: structuredClone(sourceEvidence),
  });
  if (result.status !== "accepted") throw new Error("fixed graph fixture was not accepted");
  return result.records;
}
const emittedFixedGraphHistory = await emitFixedGraphHistory();
function fixedGraphHistory(): CompilerDraftRecord[] {
  return structuredClone(emittedFixedGraphHistory);
}
beforeEach(() => {
  vi.mocked(latestRunReceipts).mockReturnValue({
    runId: "run",
    start: {
      policyDigest: binding.policyDigest,
      baseSha: binding.baseSha,
      policy: runPolicy,
    },
  } as ReturnType<typeof latestRunReceipts>);
  vi.mocked(loadCompiledGraph).mockResolvedValue(null);
  vi.mocked(loadCompiledGraphProjection).mockResolvedValue(null);
  vi.mocked(loadCompilerDrafts).mockResolvedValue(history());
  vi.mocked(summarizeRun).mockReturnValue(null);
});
describe("read-only compiler evaluation", () => {
  it("reconstructs a successful fixed-graph report-only judgment without a semantic proposal call", async () => {
    const records = fixedGraphHistory();
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      revision: 0,
      draftDigest: compiledGraphDigest(graph),
      observedTotalTokens: 24,
    });
    expect(result.usage).toHaveLength(2);
    expect(result.invocationStatus).toEqual([
      expect.objectContaining({ stage: "inventory", revision: 0, state: "completed" }),
      expect.objectContaining({ stage: "judge", revision: 0, state: "completed" }),
    ]);
    expect(result.calibrationEvidence!.result).toMatchObject({
      terminalState: "accepted",
      kind: "work-items",
      obligationCount: 1,
      workItems: {
        modelAuthoredCount: proposal.kind === "work-items" ? proposal.workItems.length : -1,
        compiledTotal: graph.workItems.length,
        projectedTotal: null,
      },
    });
    expect(result.calibrationEvidence!.invocations[0]!.sizes).toMatchObject({
      prompt: { bytes: expect.any(Number) },
      schema: { bytes: expect.any(Number) },
      response: { bytes: expect.any(Number) },
    });
    expect(result.markdown).toContain("## Qualification evidence");
    expect(result.markdown).toContain(
      "Terminal state: accepted; result availability: observed; proposal kind: work-items.",
    );
    expect(result.markdown).toContain(
      "Obligations: 1 (mechanically-counted-authenticated-inventory).",
    );
    const inventoryInvocation = result.calibrationEvidence!.invocations[0]!;
    expect(result.markdown).toContain(
      `prompt ${inventoryInvocation.sizes.prompt.bytes} bytes (local-callback); schema ${inventoryInvocation.sizes.schema.bytes} bytes (local-callback); response ${inventoryInvocation.sizes.response.bytes} bytes (canonical-structured-value); inventory unavailable bytes (not-applicable); evidence ${inventoryInvocation.sizes.evidence.bytes} bytes (reconstructed-authenticated-source-evidence).`,
    );
    expect(result.markdown).toContain("mechanically-reconstructed-fixed-graph");
    expect(result.markdown).not.toContain("Work Items: model-authored");
    expect(result.cumulativeUsage).toEqual({
      inputTokens: 20,
      outputTokens: 4,
      cachedInputTokens: 14,
      observedTokens: 24,
      complete: true,
    });
    expect(
      records.some(
        (record) => record.payload.stage === "compile" || record.payload.stage === "repair",
      ),
    ).toBe(false);
    expect(result.modelInvoked).toBe(false);
  });
  it("rejects the former incomplete nondeterministic fixed journal before reporting usage", async () => {
    const records = fixedGraphHistory();
    const started = records[0]!;
    started.payload = {
      limits: { maxRepairs: 0 },
      fixedGraphDigest: started.payload.fixedGraphDigest,
    };
    const invocation = records.find((record) => record.kind === "invocation")!;
    const result = records.find(
      (record) =>
        record.kind === "result" && record.payload.invocationId === invocation.payload.invocationId,
    )!;
    invocation.payload.invocationId = "inventory-fixed-0";
    result.payload.invocationId = "inventory-fixed-0";
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow();
  });
  it("validates every non-empty current journal before deriving report evidence", async () => {
    const records = history();
    delete records[0]!.payload.adapterMode;
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow();
  });
  it("requires the current durable source-evidence record without reconstructing a fallback", async () => {
    const records = history();
    const sourceIndex = records.findIndex((record) => record.kind === "source-evidence");
    records.splice(sourceIndex, 1);
    records.forEach((record, sequence) => (record.sequence = sequence));
    records[0]!.payload.sourceEvidenceDigest = draftDigest(null);
    validatePersistedCompilerDraftJournal(records);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("requires current durable source evidence");
  });
  it("authenticates the composite compiler input envelope independently of the Objective digest", async () => {
    expect(binding.inputDigest).not.toBe(objectiveDigest);
    const records = history().slice(0, 2);
    for (const record of records)
      record.binding = { ...record.binding, inputDigest: "f".repeat(64) };
    validatePersistedCompilerDraftJournal(records);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("compiler draft input envelope identity mismatch");
  });
  it("binds the compiler input envelope to the authenticated run asset manifest authority", async () => {
    vi.mocked(latestRunReceipts).mockReturnValue({
      runId: binding.runId,
      start: {
        policyDigest: binding.policyDigest,
        baseSha: binding.baseSha,
        policy: runPolicy,
        assetManifestDigest: "f".repeat(64),
      },
    } as ReturnType<typeof latestRunReceipts>);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("compiler draft input envelope identity mismatch");
  });
  it("binds the compiler input envelope to the authenticated compiler egress authority", async () => {
    const policy = structuredClone(runPolicy);
    policy.compilerMediaEgress = {
      mode: "private-assets",
      maxAssets: 1,
      deterministicReviewRuleIds: [],
    };
    const authenticatedPolicyDigest = policyDigest(policy);
    const records = history().slice(0, 2);
    for (const record of records)
      record.binding = { ...record.binding, policyDigest: authenticatedPolicyDigest };
    validatePersistedCompilerDraftJournal(records);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    vi.mocked(latestRunReceipts).mockReturnValue({
      runId: binding.runId,
      start: {
        policyDigest: authenticatedPolicyDigest,
        baseSha: binding.baseSha,
        policy,
      },
    } as ReturnType<typeof latestRunReceipts>);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("compiler draft input envelope identity mismatch");
  });
  it.each([
    [
      "foreign Objective digest",
      (value: ObligationInventory) => {
        value.objectiveDigest = "f".repeat(64);
      },
      "obligation inventory input identity mismatch",
    ],
    [
      "foreign base SHA",
      (value: ObligationInventory) => {
        value.baseSha = "f".repeat(40);
      },
      "obligation inventory input identity mismatch",
    ],
    [
      "ungrounded source citation",
      (value: ObligationInventory) => {
        value.evidence[0]!.excerpt = "foreign Objective evidence";
      },
      "ungrounded evidence citation",
    ],
  ])("rejects a terminal-after-inventory journal with %s", async (_case, mutate, expected) => {
    const records = terminalAfterInventoryHistory();
    const inventoryResult = records.find(
      (record) => record.kind === "result" && record.payload.stage === "inventory",
    )!;
    const value = structuredClone(inventoryResult.payload.value) as ObligationInventory;
    mutate(value);
    inventoryResult.payload.value = value;
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow(expected);
  });
  it("keeps terminal proposal accounting unknown without inferring zero or authorizing replay", async () => {
    const records = terminalAfterUnknownProposalHistory();
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    const failed = result.invocationStatus!.find((invocation) => invocation.stage === "compile")!;
    expect(failed).toMatchObject({
      state: "failed",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      observedTokens: null,
    });
    expect(result.unresolvedInvocations).toContain(failed.invocationId);
    expect(result.cumulativeUsage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 7,
      observedTokens: 12,
      complete: false,
    });
    expect(result.markdown).toContain(`${failed.invocationId} (compile): total tokens unavailable`);
    expect(result.markdown).toContain("complete total: unavailable");
    expect(result.activationAuthorized).toBe(false);
    expect(result.modelInvoked).toBe(false);
  });
  it("classifies an empty persisted error diagnostic as a failed invocation", async () => {
    const records = history();
    const compileResult = records.find(
      (record) => record.kind === "result" && record.payload.stage === "compile",
    )!;
    compileResult.payload.error = "";
    records.find(
      (record) => record.kind === "invocation" && record.payload.stage === "repair",
    )!.payload.inputDigest = draftDigest({
      inventory,
      previous: compileResult.payload.proposal,
      projection: null,
      failure: { error: "", proposal: compileResult.payload.proposal },
    });
    validatePersistedCompilerDraftJournal(records);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.invocationStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocationId: compileResult.payload.invocationId,
          stage: "compile",
          state: "failed",
        }),
      ]),
    );
    expect(result.calibrationEvidence?.result).toMatchObject({
      terminalState: "accepted",
      availability: "observed",
      kind: "work-items",
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: compileResult.sequence, failed: true }),
      ]),
    );
    expect(result.reports).toHaveLength(1);
  });
  it("excludes an empty-diagnostic failed judge from reports and calibration", async () => {
    const records = history();
    const judgeResult = records.find(
      (record) => record.kind === "result" && record.payload.stage === "judge",
    )!;
    judgeResult.payload.error = "";
    judgeResult.payload.value = null;
    judgeResult.payload.terminalOutcome = {
      state: "provider-failed",
      usage: judgeResult.payload.usage,
    };
    records.pop();
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding: structuredClone(binding),
      sequence: records.length,
      kind: "stopped",
      payload: { reason: "judge-failed" },
    });
    validatePersistedCompilerDraftJournal(records);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.invocationStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocationId: judgeResult.payload.invocationId,
          stage: "judge",
          state: "failed",
        }),
      ]),
    );
    expect(result.reports).toHaveLength(0);
    expect(result.calibrationEvidence?.result).toMatchObject({
      terminalState: "stopped",
      availability: "missing",
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: judgeResult.sequence, failed: true }),
      ]),
    );
  });
  it("renders unavailable result and obligation authority without claiming authentication", async () => {
    vi.mocked(loadCompilerDrafts).mockResolvedValue(history().slice(0, 2));

    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });

    expect(result.calibrationEvidence!.result).toMatchObject({
      terminalState: "incomplete",
      availability: "missing",
      obligationCount: null,
      obligationCountAuthority: "unavailable",
    });
    expect(result.markdown).toContain(
      "Terminal state: incomplete; result availability: missing; proposal kind: unavailable.",
    );
    expect(result.markdown).toContain("Obligations: unavailable (unavailable).");
    expect(result.markdown).not.toContain("mechanically counted from the authenticated inventory");
  });
  it.each([1, 2])(
    "rejects a fixed graph with maxRepairs %i in the shared grammar before reporting usage",
    async (maxRepairs) => {
      const records = fixedGraphHistory();
      records[0]!.payload.limits = {
        ...(records[0]!.payload.limits as Record<string, unknown>),
        maxRepairs,
      };

      expect(() => validatePersistedCompilerDraftJournal(records)).toThrow("zero repairs");
      vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
      await expect(
        inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
      ).rejects.toThrow("zero repairs");
    },
  );
  it.each([
    [
      "started graph digest",
      (records: CompilerDraftRecord[]) => {
        records[0]!.payload.fixedGraphDigest = "f".repeat(64);
      },
      /compiler draft policy changed/,
    ],
    [
      "validation result digest",
      (records: CompilerDraftRecord[]) => {
        records.find((record) => record.kind === "validation")!.payload.resultDigest = "f".repeat(
          64,
        );
      },
      /compiler validation proposal binding differs/,
    ],
    [
      "candidate projection digest",
      (records: CompilerDraftRecord[]) => {
        records.find((record) => record.kind === "validation")!.payload.proposalDigest = "f".repeat(
          64,
        );
      },
      /compiler validation proposal binding differs/,
    ],
  ])("rejects a malformed fixed-graph %s binding", async (_label, mutate, message) => {
    const records = fixedGraphHistory();
    mutate(records);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow(message);
  });
  it("preserves failed revisions and observed overhead without exposing provider errors", async () => {
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.observedTotalTokens).toBe(48);
    expect(result.usage![0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 7,
      observedTokens: 12,
    });
    expect(result.markdown).toContain(
      "total tokens 12; input 10; output 2; cached input 7 (cached input is included in input)",
    );
    expect(result.markdown).toContain("original failure retained");
    expect(result.markdown).toContain(
      "maxRepairs is shared across inventory regeneration and graph repair",
    );
    const inventoryInvocation = result.calibrationEvidence!.invocations[0]!;
    expect(result.markdown).toContain(
      `prompt 120 bytes (provider-dispatch); schema 240 bytes (provider-dispatch); response 80 bytes (provider-final-response); inventory unavailable bytes (not-applicable); evidence ${inventoryInvocation.sizes.evidence.bytes} bytes (reconstructed-authenticated-source-evidence).`,
    );
    expect(result.correctionBudget).toMatchObject({
      semantics: "shared across inventory regeneration and graph repair",
      inventoryRepairs: 0,
      graphRepairs: 1,
    });
    expect(JSON.stringify(result)).not.toContain("do-not-display");
    expect(result.modelInvoked).toBe(false);
  });
  it("reports a pre-provider terminal as known not invoked without poisoning token completeness", async () => {
    const records = history();
    records.pop();
    const priorJudge = records.find(
      (record) => record.kind === "result" && record.payload.stage === "judge",
    )!;
    const invocationId = `compiler-${draftDigest({ binding, stage: "repair", revision: 2 })}`;
    const startedAt = Number(priorJudge.payload.completedAt) + 1;
    records.push(
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding,
        sequence: records.length,
        kind: "invocation",
        payload: {
          invocationId,
          stage: "repair",
          revision: 2,
          startedAt,
          inputDigest: draftDigest({
            inventory,
            previous: proposal,
            projection: null,
            failure: priorJudge.payload.value,
          }),
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding,
        sequence: records.length + 1,
        kind: "result",
        payload: {
          invocationId,
          stage: "repair",
          revision: 2,
          value: null,
          usage: null,
          error: "compiler request is too large",
          stopReason: "compiler-request-limit: split the Objective into smaller Objectives",
          preProviderTerminal: true,
          completedAt: startedAt + 1,
          observedMilliseconds: 1,
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding,
        sequence: records.length + 2,
        kind: "stopped",
        payload: {
          reason: "compiler-request-limit: split the Objective into smaller Objectives",
        },
      },
    );
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.preProviderTerminals).toEqual([
      expect.objectContaining({
        invocationId,
        reason: "compiler-request-limit: split the Objective into smaller Objectives",
      }),
    ]);
    expect(result.unresolvedInvocations).not.toContain(invocationId);
    expect(result.reports[0]!.observedTotalTokens).toBe(48);
    expect(result.markdown).toContain(`${invocationId} (repair): provider not invoked`);
    expect(result.markdown).toContain("split the Objective into smaller Objectives");
    expect(result.markdown).not.toContain(
      `Unresolved compiler invocation accounting: ${invocationId}`,
    );
    expect(result.calibrationEvidence!.invocations.at(-1)!.sizes.response).toEqual({
      bytes: null,
      provenance: "not-applicable-pre-provider",
    });
    expect(result.calibrationEvidence!.invocations.at(-1)!.sizes.prompt).toEqual({
      bytes: null,
      provenance: "not-applicable-pre-provider",
    });
    expect(result.calibrationEvidence!.invocations.at(-1)!.sizes.schema).toEqual({
      bytes: null,
      provenance: "not-applicable-pre-provider",
    });
    expect(result.markdown).toContain("bytes (not-applicable-pre-provider); inventory");
  });
  it("rejects missing dispatch provenance outside an authenticated pre-provider terminal", async () => {
    const records = history();
    const invocation = records.find((record) => record.kind === "invocation")!;
    delete invocation.payload.expectedProvenance;
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    await expect(
      inspectCompilerEvaluation({
        repository: binding.repository,
        snapshot,
        store,
      }),
    ).rejects.toThrow(
      /compiler (?:result provenance differs|invocation dispatch provenance unavailable)/,
    );
  });
  it("keeps uncertain paid calls visible and refuses a known total", async () => {
    const records = history();
    records.pop();
    const priorJudge = records.find(
      (record) => record.kind === "result" && record.payload.stage === "judge",
    )!;
    const invocationId = `compiler-${draftDigest({ binding, stage: "repair", revision: 2 })}`;
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: records.length,
      kind: "invocation",
      payload: {
        stage: "repair",
        revision: 2,
        invocationId,
        startedAt: Number(priorJudge.payload.completedAt) + 1,
        inputDigest: draftDigest({
          inventory,
          previous: proposal,
          projection: null,
          failure: priorJudge.payload.value,
        }),
        expectedProvenance: structuredClone(
          records.find((record) => record.kind === "invocation")!.payload.expectedProvenance,
        ),
      },
    });
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.reports[0]!.observedTotalTokens).toBeNull();
    expect(result.markdown).toContain(invocationId);
    expect(result.reports[0]!.observedTokenSubtotal).toBe(48);
    expect(result.usage!.at(-1)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      observedTokens: null,
    });
    expect(result.calibrationEvidence!.invocations.at(-1)!.sizes.response).toEqual({
      bytes: null,
      provenance: "unavailable-unresolved",
    });
    expect(result.markdown).toContain("bytes (unavailable-unresolved); inventory");
  });
  it("rejects mismatched authenticated run and selected judgment identities", async () => {
    await expect(
      inspectCompilerEvaluation({ repository: "other/repository", snapshot, store }),
    ).rejects.toThrow("authenticated run");
    const records = history();
    records.at(-1)!.payload.verdictDigest = "f".repeat(64);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("selection durable bindings differ");
  });
  it.each(["proposalDigest", "traceDigest", "requestDigest"])(
    "rejects a selection with a mismatched %s",
    async (field) => {
      const records = history();
      records.at(-1)!.payload[field] = "f".repeat(64);
      vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
      await expect(
        inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
      ).rejects.toThrow("selection durable bindings differ");
    },
  );
  it.each(["proposalDigest", "requestDigest", "graphDigest"])(
    "rejects a self-digested trace with a mismatched %s",
    async (field) => {
      const records = history();
      const validation = records.find((record) => record.kind === "validation")!;
      const trace = validation.payload.projectionTrace as Record<string, unknown>;
      trace[field] = "f".repeat(64);
      validation.payload.traceDigest = draftDigest(trace);
      records.at(-1)!.payload.traceDigest = validation.payload.traceDigest;
      vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
      await expect(
        inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
      ).rejects.toThrow("compiler validation trace binding differs");
    },
  );
  it("rejects a proposal result whose reserved compiler request digest changed", async () => {
    const records = history();
    const repair = records.find(
      (record) => record.kind === "invocation" && record.payload.stage === "repair",
    )!;
    repair.payload.compilerRequestDigest = "f".repeat(64);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("compiler proposal request binding differs");
  });
  it("rejects a judge result whose full invocation digest changed", async () => {
    const records = history();
    records.pop();
    const judge = records.find(
      (record) => record.kind === "invocation" && record.payload.stage === "judge",
    )!;
    judge.payload.inputDigest = "f".repeat(64);
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("compiler judge input digest differs");
  });
  it("rejects an inventory that is not bound to the Objective input digest", async () => {
    const records = history();
    const inventoryResult = records.find(
      (record) => record.kind === "result" && record.payload.stage === "inventory",
    )!;
    inventoryResult.payload.value = {
      ...(inventoryResult.payload.value as object),
      objectiveDigest: "f".repeat(64),
    };
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    await expect(
      inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
    ).rejects.toThrow("compiler compile input digest differs");
  });
  it("retains malformed historical judge evidence without accepting or leaking it", async () => {
    const records = history();
    records.pop();
    const judge = records.find(
      (record) => record.kind === "result" && record.payload.stage === "judge",
    )!;
    judge.payload.value = "provider-secret-must-stay-in-original-evidence";
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.reports).toHaveLength(0);
    expect(result.markdown).toContain("Invalid historical judge results retained");
    expect(result.markdown).toContain("## Compiler invocation accounting");
    expect(result.markdown).toContain("input 10; output 2; cached input 7");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });
  it("never labels compiler usage complete after an accounting failure without a valid report", async () => {
    const records = history();
    records.pop();
    const judge = records.find(
      (record) => record.kind === "result" && record.payload.stage === "judge",
    )!;
    judge.payload.value = "malformed historical judge output";
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: records.length,
      kind: "accounting-failure",
      payload: {
        invocationId: judge.payload.invocationId,
        stage: "judge",
        error: "ledger unavailable",
      },
    });
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.reports).toHaveLength(0);
    expect(result.markdown).toContain("Observed compiler token subtotal: 48");
    expect(result.markdown).toContain("complete total: unavailable");
    expect(result.markdown).not.toContain("complete total: 48");
  });
  it("restores exact usage authority after a durable accounting reconciliation", async () => {
    const records = history();
    const selection = records.pop()!;
    const judged = records.find(
      (record) => record.kind === "result" && record.payload.stage === "judge",
    )!;
    const failureSequence = records.length;
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: failureSequence,
      kind: "accounting-failure",
      payload: {
        invocationId: judged.payload.invocationId,
        stage: "judge",
        error: "temporary ledger failure",
      },
    });
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: records.length,
      kind: "accounting-reconciled",
      payload: {
        invocationId: judged.payload.invocationId,
        stage: "judge",
        failureSequence,
      },
    });
    records.push({ ...selection, sequence: records.length });
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);

    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.reports[0]!.observedTotalTokens).toBe(48);
    expect(result.markdown).toContain("complete total: 48");
    expect(result.markdown).not.toContain("ledger completeness is unavailable");
  });
  it("reports absent history without reusing historical authority", async () => {
    vi.mocked(loadCompilerDrafts).mockResolvedValue([]);
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.markdown).toContain("old authority cannot authorize");
    vi.mocked(latestRunReceipts).mockReturnValue(null);
    expect(
      (await inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }))
        .reports,
    ).toEqual([]);
  });
});

it("computes a stable mechanical critical path across fan-out and join graphs", () => {
  expect(
    mechanicalDependencyCriticalPath([
      { id: "root", dependsOn: [] },
      { id: "left", dependsOn: ["root"] },
      { id: "right", dependsOn: ["root"] },
      { id: "join", dependsOn: ["left", "right"] },
    ]),
  ).toEqual({
    workItems: 3,
    dependencyEdges: 2,
    itemIds: ["root", "left", "join"],
  });
});

it("binds compiled and projected totals to their immutable refs and receipts", async () => {
  const graphRecord = {
    graphDigest: compiledGraphDigest(graph),
    graphSize: graph.workItems.length,
    objective: graph,
    ref: "refs/factory/graphs/236/run",
    commitOid: "c".repeat(40),
    blobOid: "d".repeat(40),
  };
  const projectionRecord = {
    graphDigest: graphRecord.graphDigest,
    graphSize: graphRecord.graphSize,
    ref: "refs/factory/graph-projections/236/run",
    commitOid: "e".repeat(40),
    blobOid: "f".repeat(40),
    bindings: graph.workItems.map((item, index) => ({
      compilerId: item.id,
      issueNodeId: `node-${index + 1}`,
      issueNumber: 300 + index,
    })),
  };
  const compiledReceipt = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: snapshot.number,
    runId: binding.runId,
    sequence: 20,
    at: "2026-09-16T00:00:00.000Z",
    kind: "graph",
    event: "GraphCompiled",
    graphDigest: graphRecord.graphDigest,
    graphSize: graphRecord.graphSize,
    baseSha: binding.baseSha,
    graphRef: graphRecord.ref,
    graphBlobSha: graphRecord.blobOid,
  });
  const projectedReceipt = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: snapshot.number,
    runId: binding.runId,
    sequence: 21,
    at: "2026-09-16T00:00:01.000Z",
    kind: "graph",
    event: "GraphProjected",
    graphDigest: graphRecord.graphDigest,
    graphSize: graphRecord.graphSize,
    projectionRef: projectionRecord.ref,
    projectionBlobSha: projectionRecord.blobOid,
  });
  vi.mocked(loadCompiledGraph).mockResolvedValue(graphRecord);
  vi.mocked(loadCompiledGraphProjection).mockResolvedValue(projectionRecord);
  const result = await inspectCompilerEvaluation({
    repository: binding.repository,
    snapshot: { ...snapshot, factoryEvents: [compiledReceipt, projectedReceipt] },
    store,
  });
  expect(result.calibrationEvidence!.authority).toMatchObject({
    graph: { availability: "observed", digest: graphRecord.graphDigest },
    projection: { availability: "observed", size: graphRecord.graphSize },
  });
  expect(result.markdown).toContain(
    `Immutable graph authority: observed; digest ${graphRecord.graphDigest}; size ${graphRecord.graphSize}; ref ${JSON.stringify(graphRecord.ref)}; commit ${graphRecord.commitOid}; blob ${graphRecord.blobOid}; base ${binding.baseSha}.`,
  );
  expect(result.markdown).toContain(
    `Immutable projection authority: observed; digest ${result.calibrationEvidence!.authority.projection.digest}; size ${graphRecord.graphSize}; ref ${JSON.stringify(projectionRecord.ref)}; commit ${projectionRecord.commitOid}; blob ${projectionRecord.blobOid}.`,
  );
  expect(result.calibrationEvidence!.result).toMatchObject({
    kind: "work-items",
    workItems: {
      mechanicallyDerivedProducerCount: 0,
      compiledTotal: graphRecord.graphSize,
      projectedTotal: graphRecord.graphSize,
      criticalPath: { workItems: 2, dependencyEdges: 1 },
    },
  });

  vi.mocked(loadCompiledGraphProjection).mockRejectedValue(
    new CompiledGraphProjectionConflictError("projection differs from immutable graph"),
  );
  const conflicting = await inspectCompilerEvaluation({
    repository: binding.repository,
    snapshot: { ...snapshot, factoryEvents: [compiledReceipt, projectedReceipt] },
    store,
  });
  expect(conflicting.calibrationEvidence!.authority.projection.availability).toBe("conflicting");
  expect(
    conflicting.calibrationEvidence!.result.kind === "work-items" &&
      "workItems" in conflicting.calibrationEvidence!.result
      ? conflicting.calibrationEvidence!.result.workItems.projectedTotal
      : "wrong-kind",
  ).toBeNull();

  const readFailure = new Error("projection control-store read failed");
  vi.mocked(loadCompiledGraphProjection).mockRejectedValue(readFailure);
  await expect(
    inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot: { ...snapshot, factoryEvents: [compiledReceipt, projectedReceipt] },
      store,
    }),
  ).rejects.toBe(readFailure);
});

describe("planning qualification evidence", () => {
  const trigger = {
    code: "authorization-boundary" as const,
    source: "obligation-inventory" as const,
    availability: "observed" as const,
    observed: "PRIVATE trigger prose",
    threshold: null,
    obligationIds: ["change"],
    explanation: "PRIVATE trigger explanation",
  };
  const objectiveProposal = CompilerProposalSchema.parse({
    protocol: "clockgrove.factory/compiler-proposal",
    kind: "objectives",
    objectives: ["foundation", "consumer"].map((id, index) => ({
      id,
      title: `PRIVATE ${id} title`,
      outcome: `PRIVATE ${id} outcome`,
      acceptance: [{ id: `${id}-accepted`, kind: "owned", text: `PRIVATE ${id} acceptance` }],
      ownedScope: [`src/${id}/`],
      obligationIds: index === 0 ? ["change"] : [],
      planningEstimate: {
        workItems: index + 2,
        criticalPathMinutes: null,
        aggregateWorkMinutes: null,
        basis: `PRIVATE ${id} estimate basis`,
      },
      outputs: [
        {
          id: `${id}-output`,
          description: `PRIVATE ${id} output`,
          completionAcceptanceIds: [`${id}-accepted`],
        },
      ],
      prerequisiteOutputs:
        index === 0 ? [] : [{ objectiveId: "foundation", outputId: "foundation-output" }],
    })),
    coverage: [
      {
        obligationId: "change",
        disposition: "owned",
        objectiveId: "foundation",
        acceptanceId: "foundation-accepted",
      },
    ],
    triggers: [trigger],
  });
  const clarificationProposal = CompilerProposalSchema.parse({
    protocol: "clockgrove.factory/compiler-proposal",
    kind: "clarification",
    requirements: [
      {
        id: "target",
        question: "PRIVATE clarification question",
        reason: "PRIVATE clarification reason",
        obligationIds: ["change"],
      },
    ],
    triggers: [trigger],
  });
  function recordsFor(planningProposal: typeof objectiveProposal | typeof clarificationProposal) {
    const records = history();
    const resultIndex = records.findIndex(
      (record) => record.kind === "result" && record.payload.stage === "repair",
    );
    const planningRecords = records.slice(0, resultIndex + 1);
    const result = planningRecords[resultIndex]!;
    const persisted = result.payload.value as Record<string, unknown>;
    persisted.proposal = structuredClone(planningProposal);
    result.payload.responseBytes = Buffer.byteLength(JSON.stringify(planningProposal), "utf8");
    planningRecords.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: planningRecords.length,
      kind: "stopped",
      payload: {
        reason: `compiler-planning-result:${planningProposal.kind}:${draftDigest(planningProposal)}`,
      },
    });
    return planningRecords;
  }

  it.each([
    ["objectives", objectiveProposal, 2],
    ["clarification", clarificationProposal, 1],
  ] as const)(
    "projects compact %s identities without provider prose",
    async (kind, value, count) => {
      vi.mocked(loadCompilerDrafts).mockResolvedValue(recordsFor(value));
      const result = await inspectCompilerEvaluation({
        repository: binding.repository,
        snapshot,
        store,
      });
      expect(result.calibrationEvidence!.result).toMatchObject({
        terminalState: "stopped",
        kind,
        obligationCount: 1,
        planning: { proposalCount: count },
      });
      expect(JSON.stringify(result.calibrationEvidence)).not.toContain("PRIVATE");
      expect(result.markdown).toContain(`proposal kind: ${kind}`);
      if (kind === "objectives") {
        expect(result.markdown).toContain(
          'Objective "foundation": model-reported, schema-validated estimates workItems=2, criticalPathMinutes=unknown, aggregateWorkMinutes=unknown; obligations=["change"]; outputs=["foundation-output"]; prerequisites=[].',
        );
        expect(result.markdown).toContain(
          'Coverage "change": disposition=owned; objective="foundation"; acceptance="foundation-accepted".',
        );
      } else {
        expect(result.markdown).toContain('Clarification "target": obligations=["change"].');
      }
      expect(result.markdown).toContain(
        'Trigger authorization-boundary:obligation-inventory: availability=observed; threshold=null; obligations=["change"].',
      );
      expect(result.markdown).not.toContain("PRIVATE");
    },
  );
});

it("retains blinded automated annotations with source identities and honest measurement gaps", async () => {
  const { createHash } = await import("node:crypto");
  const { z } = await import("zod");
  const schema = z
    .object({
      version: z.literal(1),
      provenance: z.literal("llm-assisted"),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      model: z.null(),
      observedTokens: z.null(),
      humanLabeled: z.literal(false),
      heldOut: z.literal(false),
      candidateVerdictsRead: z.literal(false),
      manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      limitation: z.string().min(1),
      cases: z
        .array(
          z
            .object({
              id: z.string(),
              required: z.array(z.string()).min(1),
              negativeExamples: z.array(z.string()).min(1),
              validAlternatives: z.array(z.string()).min(1),
              uncertainty: z.array(z.string()),
              sourceEvidence: z
                .array(
                  z
                    .object({
                      path: z
                        .string()
                        .regex(/^[a-zA-Z0-9_./-]+$/)
                        .refine((path) => !path.split("/").includes("..")),
                      sha256: z.string().regex(/^[a-f0-9]{64}$/),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        )
        .length(5),
    })
    .strict();
  const labels = schema.parse(
    JSON.parse(
      await readFile(
        new URL("./fixtures/evaluation/compiler-labels.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(labels.manifestSha256).toBe(
    digest(await readFile(new URL("./fixtures/evaluation/compiler.json", import.meta.url))),
  );
  for (const entry of labels.cases)
    for (const source of entry.sourceEvidence)
      expect(source.sha256).toBe(
        digest(await readFile(new URL(`./fixtures/evaluation/${source.path}`, import.meta.url))),
      );
  expect(
    labels.cases.find((entry) => entry.id === "seeded-simulation")!.uncertainty,
  ).not.toHaveLength(0);
});

function causalFixture() {
  const records = history();
  const judged = records.find(
    (record) => record.kind === "result" && record.payload.stage === "judge",
  )!;
  const value = judged.payload.value as { findings: unknown[] };
  value.findings = [
    {
      id: "handoff",
      dimension: "composition-handoffs",
      severity: "advisory",
      confidence: 0.8,
      obligationIds: ["change"],
      itemIds: [graph.workItems[0]!.id],
      evidenceIds: ["objective"],
      rootCause: "Handoff may require downstream correction",
      correction: "Clarify the handoff",
      uncertainty: "Causal effect requires runtime evidence",
    },
  ];
  records.at(-1)!.payload.verdictDigest = draftDigest(value);
  const runtime = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: snapshot.number,
    runId: binding.runId,
    sequence: 25,
    at: "2026-09-08T00:00:00.000Z",
    kind: "attempt",
    event: "AttemptFailed",
    workItem: 300,
    attempt: 1,
    backend: "fixture/local",
    baseSha: binding.baseSha,
    directorEpoch: 1,
    policyDigest: "a".repeat(64),
    headSha: "e".repeat(40),
    artifactDigest: "f".repeat(64),
    reason: "Observed handoff mismatch in the candidate artifact",
  });
  const annotations: CompilerCausalAnnotations = {
    version: 1,
    runId: binding.runId,
    draftDigest: compiledGraphDigest(graph),
    revision: 1,
    provenance: {
      kind: "caller-supplied",
      authorType: "automated",
      source: "Independent evidence review fixture",
    },
    causes: [
      {
        findingId: "handoff",
        cause: "compiler",
        itemIds: [graph.workItems[0]!.id],
        attempts: [{ workItem: 300, attempt: 1 }],
        evidenceIds: [`runtime-${draftDigest(runtime)}`],
        explanation:
          "The cited failed artifact records the handoff mismatch described by this finding",
        uncertainty: "Avoidable fraction is estimated by the caller",
        estimatedAvoidableTokens: 12,
        estimatedAvoidableMilliseconds: 1000,
      },
    ],
  };
  vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
  vi.mocked(loadCompiledGraph).mockResolvedValue({
    graphDigest: compiledGraphDigest(graph),
    graphSize: graph.workItems.length,
    objective: graph,
    ref: "graph-ref",
    commitOid: "a".repeat(40),
    blobOid: "b".repeat(40),
  });
  return { annotations, snapshot: { ...snapshot, factoryEvents: [runtime] }, runtime };
}

describe("caller-supplied historical causal annotations", () => {
  it("neutralizes line breaks and Markdown syntax in caller provenance sources", async () => {
    const fixture = causalFixture();
    fixture.annotations.provenance.source =
      "trusted-source\r\n## Forged heading [link](https://example.invalid) *emphasis*";
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot: fixture.snapshot,
      store,
      annotations: fixture.annotations,
    });

    expect(result.markdown).toContain(
      "source: trusted-source    Forged heading  link  https://example.invalid   emphasis ",
    );
    expect(result.markdown).not.toContain("\n## Forged heading");
    expect(result.markdown).not.toContain("[link](https://example.invalid)");
  });
  it.each(["compiler", "mixed"] as const)(
    "supports cited %s attribution without replacing original evidence or claiming savings",
    async (cause) => {
      const fixture = causalFixture();
      fixture.annotations.causes[0]!.cause = cause;
      const result = await inspectCompilerEvaluation({
        repository: binding.repository,
        snapshot: fixture.snapshot,
        store,
        annotations: fixture.annotations,
      });
      expect(result.reports[0]!.causes).toEqual([]);
      expect(result.annotatedReports[0]!.causes[0]).toMatchObject({
        cause,
        estimatedAvoidableTokens: 12,
      });
      expect(result.annotatedReports[0]!.observedTotalTokens).toBe(
        result.reports[0]!.observedTotalTokens,
      );
      expect(result.annotatedReports[0]!.economicBenefitMeasured).toBe(false);
      expect(result.annotatedReports[0]!.causalAuthority).toContain("caller-supplied");
      expect(result.runtimeEvidence[0]!.excerpt).toContain(fixture.runtime.headSha);
      expect(result.markdown).toContain("Estimates are not measured savings");
      expect(result.modelInvoked).toBe(false);
    },
  );
  it.each([
    "foreign-run",
    "stale-draft",
    "foreign-evidence",
    "missing-runtime",
    "foreign-attempt",
    "foreign-item",
    "unknown-finding",
  ])(
    "rejects %s annotations instead of laundering them into historical evidence",
    async (fault) => {
      const fixture = causalFixture();
      const annotation = fixture.annotations;
      if (fault === "foreign-run") annotation.runId = "other-run";
      if (fault === "stale-draft") annotation.draftDigest = "d".repeat(64);
      if (fault === "foreign-evidence") annotation.causes[0]!.evidenceIds = ["runtime-forged"];
      if (fault === "missing-runtime") annotation.causes[0]!.evidenceIds = ["objective"];
      if (fault === "foreign-attempt") annotation.causes[0]!.attempts[0]!.attempt = 99;
      if (fault === "foreign-item") annotation.causes[0]!.itemIds = ["foreign-item"];
      if (fault === "unknown-finding") annotation.causes[0]!.findingId = "invented";
      await expect(
        inspectCompilerEvaluation({
          repository: binding.repository,
          snapshot: fixture.snapshot,
          store,
          annotations: annotation,
        }),
      ).rejects.toThrow(/annotation/i);
    },
  );
  it("exposes receipt identities while redacting sensitive reason text and keeps default causes unknown", async () => {
    const fixture = causalFixture();
    fixture.runtime.reason = "secret-api-key=do-not-display";
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot: fixture.snapshot,
      store,
    });
    expect(result.annotatedReports).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("do-not-display");
    expect(result.runtimeEvidence[0]!.excerpt).toContain("sensitive reason omitted");
    expect(result.reports[0]!.causes).toEqual([]);
  });
  it("reads only bounded regular annotation files and does not follow symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compiler-annotations-"));
    try {
      const path = join(directory, "annotations.json");
      const { annotations } = causalFixture();
      await writeFile(path, JSON.stringify(annotations));
      await expect(readCompilerCausalAnnotationsFile(path)).resolves.toEqual(annotations);
      const linked = join(directory, "linked.json");
      await symlink(path, linked);
      await expect(readCompilerCausalAnnotationsFile(linked)).rejects.toThrow("regular file");
      await writeFile(path, "x".repeat(256 * 1024 + 1));
      await expect(readCompilerCausalAnnotationsFile(path)).rejects.toThrow("bounded");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("passes causal annotations through the read-only application service without a command store", async () => {
  const { FactoryApplicationService } = await import("../src/application/services.js");
  const fixture = causalFixture();
  const service = new FactoryApplicationService({
    owner: "clockgrove",
    repo: "factory",
    reader: { readObjective: async () => fixture.snapshot },
    compilerEvaluationStore: store,
  });
  const result = await service.inspect(
    "compiler-eval",
    snapshot.number,
    undefined,
    undefined,
    fixture.annotations,
  );
  expect(result).toMatchObject({
    modelInvoked: false,
    activationAuthorized: false,
    annotatedReports: [{ annotationProvenance: fixture.annotations.provenance }],
  });
  fixture.snapshot.factoryEvents = [
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "ActivationRequested",
      objective: snapshot.number,
      runId: binding.runId,
      requestId: "status-fixture",
      sequence: 0,
      at: "2026-09-08T00:00:00.000Z",
      requestedBy: "actor",
      repository: binding.repository,
      baseSha: binding.baseSha,
      policy: DEFAULT_RUN_POLICY,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      controllerProtocolMin: "clockgrove.factory/v2",
      controllerProtocolMax: "clockgrove.factory/v2",
    }),
    fixture.runtime,
  ];
  vi.mocked(latestRunReceipts).mockReturnValue({
    runId: binding.runId,
    start: {
      policyDigest: binding.policyDigest,
      baseSha: binding.baseSha,
      policy: DEFAULT_RUN_POLICY,
    },
  } as ReturnType<typeof latestRunReceipts>);
  const status = await service.inspect("status", snapshot.number);
  expect(status).toMatchObject({
    compilerEvaluation: {
      availability: "observed",
      invocations: expect.arrayContaining([
        expect.objectContaining({
          stage: "compile",
          state: "failed",
        }),
      ]),
      cumulativeUsage: {
        inputTokens: 40,
        outputTokens: 8,
        cachedInputTokens: 28,
        observedTokens: 48,
        complete: true,
      },
    },
  });
  await expect(
    service.inspect("status", snapshot.number, undefined, undefined, fixture.annotations),
  ).rejects.toThrow("only by compiler-eval");
});

it("reports disputed terminal usage as unknown while retaining the original failed evidence", async () => {
  const records = history();
  records.pop();
  records.push({
    protocol: "clockgrove.factory/compiler-draft",
    binding,
    sequence: records.length,
    kind: "terminal-conflict",
    payload: {
      invocationId: records.find(
        (record) => record.kind === "result" && record.payload.stage === "judge",
      )!.payload.invocationId,
      usageConflict: true,
      conflictingUsageDigest: "f".repeat(64),
    },
  });
  vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
  const result = await inspectCompilerEvaluation({
    repository: binding.repository,
    snapshot,
    store,
  });
  expect(result.reports[0]!.observedTotalTokens).toBeNull();
  expect(result.reports[0]!.observedTokenSubtotal).toBe(36);
  expect(result.markdown).toContain("disputed token counters are unknown");
  expect(result.markdown).toContain("original failure retained");
});
