import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectCompilerEvaluation } from "../src/application/compiler-eval.js";
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
import type { ApplicationSnapshot } from "../src/application/services.js";
vi.mock("../src/control/compiler-drafts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/compiler-drafts.js")>()),
  loadCompilerDrafts: vi.fn(),
}));
vi.mock("../src/control/graphs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/graphs.js")>()),
  loadCompiledGraph: vi.fn(),
}));
vi.mock("../src/control/receipts.js", () => ({ latestRunReceipts: vi.fn() }));
vi.mock("../src/economics/index.js", () => ({ summarizeRun: vi.fn() }));
const binding = {
  repository: "clockgrove/factory",
  objective: 236,
  runId: "run",
  policyDigest: "policy",
  baseSha: "a".repeat(40),
  inputDigest: "c".repeat(64),
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
  objectiveDigest: "b".repeat(64),
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
function history() {
  const records: CompilerDraftRecord[] = [];
  const add = (kind: CompilerDraftRecord["kind"], payload: Record<string, unknown>) =>
    records.push({
      protocol: "clockgrove.factory/compiler-draft-v1",
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
      usage: { inputTokens: 10, outputTokens: 2 },
      ...(error ? { error } : {}),
    });
  };
  add("started", {});
  call("inventory", 0, inventory);
  call("compile", 0, null, "secret-api-key=do-not-display");
  call("repair", 1, { objective: graph });
  add("validation", { revision: 1, valid: true, graph, graphDigest: compiledGraphDigest(graph) });
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
          { itemId: graph.workItems[0]!.id, criterion: graph.workItems[0]!.acceptance[0]! },
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
    expect(result.markdown).toContain("original failure retained");
    expect(JSON.stringify(result)).not.toContain("do-not-display");
    expect(result.modelInvoked).toBe(false);
  });
  it("keeps uncertain paid calls visible and refuses a known total", async () => {
    const records = history();
    records.pop();
    records.push({
      protocol: "clockgrove.factory/compiler-draft-v1",
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
    expect(JSON.stringify(result)).not.toContain("provider-secret");
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
