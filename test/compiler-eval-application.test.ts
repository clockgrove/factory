import { readFile, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectCompilerEvaluation,
  readCompilerCausalAnnotationsFile,
  type CompilerCausalAnnotations,
} from "../src/application/compiler-eval.js";
import {
  loadCompilerDrafts,
  draftDigest,
  type CompilerDraftRecord,
} from "../src/control/compiler-drafts.js";
import { loadCompiledGraph, type CompiledGraphReadStore } from "../src/control/graphs.js";
import { latestRunReceipts } from "../src/control/receipts.js";
import { summarizeRun } from "../src/economics/index.js";
import { compiledGraphDigest, parsePersistedCompiledObjective } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import type { ApplicationSnapshot } from "../src/application/services.js";
import { CompilerProposalSchema, CompilerRequestSchema } from "../src/compiler/contracts.js";
vi.mock("../src/control/compiler-drafts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/compiler-drafts.js")>()),
  loadCompilerDrafts: vi.fn(),
}));
vi.mock("../src/control/graphs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/graphs.js")>()),
  loadCompiledGraph: vi.fn(),
}));
vi.mock("../src/control/receipts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/receipts.js")>()),
  latestRunReceipts: vi.fn(),
}));
vi.mock("../src/economics/index.js", () => ({ summarizeRun: vi.fn() }));
const objective = { number: 236, title: "Objective", body: "Deliver change" };
const binding = {
  repository: "clockgrove/factory",
  objective: 236,
  runId: "run",
  policyDigest: "policy",
  baseSha: "a".repeat(40),
  inputDigest: compilerEvalDigest(objective),
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
  objectiveDigest: binding.inputDigest,
  baseSha: binding.baseSha,
  evidence: [
    { id: "objective", kind: "objective", identity: "original", excerpt: "Deliver change" },
  ],
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
    },
  })),
});
const proposalRequest = CompilerRequestSchema.parse({
  protocol: "clockgrove.factory/compiler-request",
  revision: 1,
  objective: { ...objective, digest: binding.inputDigest },
  baseSha: binding.baseSha,
  inventory,
  repository: {
    manifests: ["package.json"],
    validationRecipes: [
      {
        id: "recipe-test",
        command: "npm test",
        adapterId: "node-npm",
        requiredTools: ["node", "npm"],
        networkDestinations: [],
      },
    ],
    toolchains: [],
    validationSurfaces: { deterministicSimulation: [], visual: [] },
    pathCount: 1,
  },
  constraints: {
    maxWorkItems: 100,
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
const projectionTrace = {
  protocol: "clockgrove.factory/compiler-projection",
  requestDigest: compilerEvalDigest(proposalRequest),
  proposalDigest: compilerEvalDigest(proposal),
  graphDigest: compiledGraphDigest(graph),
  addedEdges: [],
  adapterBindings: [],
  riskElevations: [],
};
function history() {
  const records: CompilerDraftRecord[] = [];
  const add = (kind: CompilerDraftRecord["kind"], payload: Record<string, unknown>) =>
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: records.length,
      kind,
      payload,
    });
  const call = (stage: string, revision: number, value: unknown, error?: string) => {
    const invocationId = `${stage}-${revision}`;
    add("invocation", { invocationId, stage, revision });
    add("result", {
      invocationId,
      stage,
      revision,
      value,
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 },
      ...(error ? { error } : {}),
    });
  };
  add("started", {});
  call("inventory", 0, structuredClone(inventory));
  call("compile", 0, null, "secret-api-key=do-not-display");
  call("repair", 1, {
    request: structuredClone(proposalRequest),
    proposal: structuredClone(proposal),
    report: {
      protocol: "clockgrove.factory/compiler-validation",
      phase: "proposal",
      status: "valid",
      violations: [],
    },
    provenance: { requestDigest: projectionTrace.requestDigest },
  });
  add("validation", {
    revision: 1,
    valid: true,
    graph,
    graphDigest: compiledGraphDigest(graph),
    proposalDigest: draftDigest(proposal),
    traceDigest: draftDigest(projectionTrace),
    projectionTrace: structuredClone(projectionTrace),
    requestDigest: projectionTrace.requestDigest,
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
          { itemId: graph.workItems[0]!.id, criterionId: proposal.workItems[0]!.criteria[0]!.id },
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
    dependencies: graph.workItems.flatMap((item) =>
      item.dependsOn.map((dependsOn) => ({
        itemId: item.id,
        dependsOn,
        evidenceIds: ["objective"],
        reason: "Required output",
      })),
    ),
    dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "assessed",
      reason: "Assessed",
      evidenceIds: ["objective"],
    })),
    findings: [],
    uncertainty: [],
    decision: "accept",
  };
  call("judge", 1, verdict);
  add("selection", {
    revision: 1,
    graphDigest: compiledGraphDigest(graph),
    inventoryDigest: draftDigest(inventory),
    verdictDigest: draftDigest(verdict),
    proposalDigest: draftDigest(proposal),
    requestDigest: projectionTrace.requestDigest,
    traceDigest: draftDigest(projectionTrace),
  });
  return records;
}
beforeEach(() => {
  vi.mocked(latestRunReceipts).mockReturnValue({
    runId: "run",
    start: { policyDigest: "policy", baseSha: binding.baseSha },
  } as ReturnType<typeof latestRunReceipts>);
  vi.mocked(loadCompiledGraph).mockResolvedValue(null);
  vi.mocked(loadCompilerDrafts).mockResolvedValue(history());
  vi.mocked(summarizeRun).mockReturnValue(null);
});
describe("read-only compiler evaluation", () => {
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
    expect(result.correctionBudget).toMatchObject({
      semantics: "shared across inventory regeneration and graph repair",
      inventoryRepairs: 0,
      graphRepairs: 1,
    });
    expect(JSON.stringify(result)).not.toContain("do-not-display");
    expect(result.modelInvoked).toBe(false);
  });
  it("keeps uncertain paid calls visible and refuses a known total", async () => {
    const records = history();
    records.pop();
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      sequence: records.length,
      kind: "invocation",
      payload: { stage: "repair", revision: 2, invocationId: "uncertain" },
    });
    vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
    const result = await inspectCompilerEvaluation({
      repository: binding.repository,
      snapshot,
      store,
    });
    expect(result.reports[0]!.observedTotalTokens).toBeNull();
    expect(result.markdown).toContain("uncertain");
    expect(result.reports[0]!.observedTokenSubtotal).toBe(48);
    expect(result.usage!.at(-1)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      observedTokens: null,
    });
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
    ).rejects.toThrow("exact accepted");
  });
  it.each(["proposalDigest", "traceDigest", "requestDigest"])(
    "rejects a selection with a mismatched %s",
    async (field) => {
      const records = history();
      records.at(-1)!.payload[field] = "f".repeat(64);
      vi.mocked(loadCompilerDrafts).mockResolvedValue(records);
      await expect(
        inspectCompilerEvaluation({ repository: binding.repository, snapshot, store }),
      ).rejects.toThrow(/exact (?:accepted|proposal|compiler request)/);
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
      ).rejects.toThrow(/projection trace|exact accepted/);
    },
  );
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
    ).rejects.toThrow("inventory repository identity mismatch");
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
      payload: { stage: "judge", error: "ledger unavailable" },
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
      invocationId: "judge-1",
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
