import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
  readCompilerObligationEvidence,
  validateCompilerDraft,
  CODEX_PLAN_JUDGE_SCHEMA,
} from "../src/management/codex-cli.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import { compiledGraphDigest, type CompiledObjective } from "../src/graph.js";
import type { CompilationContext } from "../src/management/backend.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type ObligationInventory,
  type CompilerJudgeVerdict,
} from "../src/evaluation/compiler-eval.js";

const temporary: string[] = [];
const usage = { inputTokens: 32, outputTokens: 12, cachedInputTokens: 8 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "compiler-judge-management-"));
  temporary.push(repository);
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  const context: CompilationContext = {
    repository,
    objective: { number: 1, title: "Test", body: "Tests pass" },
    baseSha: "a".repeat(40),
    defaultBranch: "main",
    repositoryFiles: ["package.json"],
    allowedNetworkDestinations: [],
    runPolicy: DEFAULT_RUN_POLICY,
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const inventory: ObligationInventory = {
    version: 1,
    objectiveDigest: compilerEvalDigest(context.objective),
    baseSha: context.baseSha,
    evidence: context.repositoryEvidence,
    obligations: [
      {
        id: "tests",
        text: "Tests pass",
        kind: "explicit",
        evidenceIds: ["objective"],
        acceptanceEvidence: "Run repository tests",
      },
    ],
  };
  const proposal = {
    title: "Test",
    workItems: [
      {
        id: "code",
        title: "Implement code",
        goal: "Implement code",
        acceptance: ["Tests pass"],
        criterionRisks: [{ criterion: "Tests pass", risk: "ordinary" }],
        scope: ["src/code.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: context.baseSha,
        validationCommands: ["npm test"],
        validation: [
          {
            tier: "mechanical",
            criteria: ["Tests pass"],
            rationale: "Repository test command establishes the criterion",
            evidenceCommands: ["npm test"],
          },
        ],
        requirements: {
          os: ["linux"],
          architecture: ["x64"],
          cpu: 1,
          memoryMb: 2048,
          diskMb: 1024,
          timeoutMinutes: 30,
          estimatedDurationMinutes: 10,
          tools: ["node", "npm"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
  return { context, inventory, proposal };
}
function verdict(
  inventory: ObligationInventory,
  objective: CompiledObjective,
): CompilerJudgeVerdict {
  return {
    version: 1,
    rubricVersion: 1,
    draftDigest: compiledGraphDigest(objective),
    inventoryDigest: compilerEvalDigest(inventory),
    coverage: [
      {
        obligationId: "tests",
        status: "covered",
        itemIds: ["code"],
        acceptanceBindings: [{ itemId: "code", criterion: "Tests pass" }],
        evidenceIds: ["objective"],
        reason: "Tests required",
      },
    ],
    items: [
      {
        itemId: "code",
        granularity: "cohesive",
        reason: "One outcome",
        evidenceIds: ["objective"],
      },
    ],
    dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "assessed",
      reason: "Supported",
      evidenceIds: ["objective"],
    })),
    dependencies: [],
    findings: [],
    uncertainty: [],
    decision: "accept",
  };
}

describe("independent compiler management boundaries", () => {
  it("retains cited Objective text beyond the first excerpt without silently dropping scope", async () => {
    const { context } = await fixture();
    context.objective.body = `${"a".repeat(4200)} Final mandatory compatibility requirement`;
    const evidence = compilerObligationEvidence(context);
    expect(
      evidence
        .filter((entry) => entry.kind === "objective")
        .map((entry) => entry.excerpt)
        .join(""),
    ).toBe(`${context.objective.title}\n${context.objective.body}`);
    expect(evidence.find((entry) => entry.id === "objective-2")?.excerpt).toContain(
      "Final mandatory compatibility requirement",
    );
  });

  it("extracts obligations without a graph and durably checkpoints before returning", async () => {
    const { context, inventory } = await fixture();
    const calls: string[] = [];
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        calls.push("invoke");
        expect(prompt).toContain("No compiled plan is available");
        expect(prompt).not.toContain('"workItems"');
        return { value: inventory, usage };
      },
    });
    const result = await backend.extractObligations(context, async () => {
      calls.push("checkpoint");
    });
    calls.push("returned");
    expect(calls).toEqual(["invoke", "checkpoint", "returned"]);
    expect(result.inventory).toEqual(inventory);
    await expect(
      backend.extractObligations(context, async () => {
        throw new Error("checkpoint unavailable");
      }),
    ).rejects.toMatchObject({ usage, message: "checkpoint unavailable" });
  });

  it("judges complete coverage in an isolated prompt without compiler self-assessment", async () => {
    const { context, inventory, proposal } = await fixture();
    const compiled = await new CodexCliManagementBackend({
      runStructured: async () => ({ value: proposal, usage }),
    }).compile(context, async () => {});
    compiled.objective.workItems[0]!.economicReview!.rationale = "PRIVATE_COMPILER_SELF_ASSESSMENT";
    const runStructured = vi.fn(async (_cwd, schema, prompt: string) => {
      expect(schema).toEqual(CODEX_PLAN_JUDGE_SCHEMA);
      expect(prompt).not.toContain("PRIVATE_COMPILER_SELF_ASSESSMENT");
      expect(prompt).toContain("every item");
      expect(prompt).toContain("Passing every packet");
      return { value: verdict(inventory, compiled.objective), usage };
    });
    const judged = await new CodexCliManagementBackend({ runStructured }).judgePlan(
      { compilation: context, inventory, objective: compiled.objective },
      async () => {},
    );
    expect(judged.verdict.draftDigest).toBe(compiledGraphDigest(compiled.objective));
    expect(runStructured).toHaveBeenCalledOnce();
  });

  it("rejects incomplete or foreign evidence judgments while preserving paid usage", async () => {
    const { context, inventory, proposal } = await fixture();
    const compiled = await new CodexCliManagementBackend({
      runStructured: async () => ({ value: proposal, usage }),
    }).compile(context, async () => {});
    const invalid = verdict(inventory, compiled.objective);
    invalid.coverage = [];
    const checkpoint = vi.fn();
    await expect(
      new CodexCliManagementBackend({
        runStructured: async () => ({ value: invalid, usage }),
      }).judgePlan({ compilation: context, inventory, objective: compiled.objective }, checkpoint),
    ).rejects.toMatchObject({ name: "ManagementOutputError", usage });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("retains raw proposals, grounds repairs again, and checks complete lineage", async () => {
    const { context, inventory, proposal } = await fixture();
    const backend = new CodexCliManagementBackend({
      runStructured: async () => ({ value: proposal, usage }),
    });
    const compiled = await backend.compile(context, async () => {});
    expect(compiled.provenance?.rawProposal).toEqual(proposal);
    expect(
      compiled.provenance?.normalizationTrace.some((change) =>
        change.startsWith("code.requirements:"),
      ),
    ).toBe(true);
    await expect(validateCompilerDraft(context, compiled.objective)).resolves.toEqual(
      compiled.objective,
    );
    const summary = {
      changeSummary: "Retain cohesive behavior",
      lineage: [{ itemId: "code", previousItemIds: ["code"] }],
      findingDispositions: [],
    };
    const repairBackend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        expect(prompt).toContain("complete replacement");
        expect(prompt).toContain("Original obligations are immutable");
        return { value: { objective: proposal, summary }, usage };
      },
    });
    const repaired = await repairBackend.repairPlan(
      {
        compilation: context,
        inventory,
        objective: compiled.objective,
        verdict: verdict(inventory, compiled.objective),
        revision: 1,
      },
      async () => {},
    );
    expect(repaired.repair).toEqual(summary);
    expect(repaired.objective).toEqual(compiled.objective);
    summary.lineage[0]!.previousItemIds = [];
    await expect(
      repairBackend.repairPlan(
        {
          compilation: context,
          inventory,
          objective: compiled.objective,
          verdict: verdict(inventory, compiled.objective),
          revision: 2,
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ usage, message: "repair reused item ID without its lineage" });
  });

  it("preserves malformed proposals and can repair an initial mechanical failure", async () => {
    const { context, inventory, proposal } = await fixture();
    const invalid = { title: "Test", workItems: [] };
    await expect(
      new CodexCliManagementBackend({
        runStructured: async () => ({ value: invalid, usage }),
      }).compile(context, async () => {}),
    ).rejects.toMatchObject({ proposal: invalid, usage });
    const repaired = await new CodexCliManagementBackend({
      runStructured: async () => ({
        value: {
          objective: proposal,
          summary: {
            changeSummary: "Restore missing graph",
            lineage: [{ itemId: "code", previousItemIds: [] }],
            findingDispositions: [],
          },
        },
        usage,
      }),
    }).repairPlan(
      {
        compilation: context,
        inventory,
        previousProposal: invalid,
        validationFailure: "Work Item count is out of bounds",
        revision: 1,
      },
      async () => {},
    );
    expect(repaired.objective.workItems).toHaveLength(1);
  });

  it("reads pinned source bytes instead of changed working files and reports gaps", async () => {
    const { context } = await fixture();
    delete context.repositoryEvidence;
    execFileSync("git", ["init", "-q"], { cwd: context.repository });
    execFileSync("git", ["add", "package.json"], { cwd: context.repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: context.repository },
    );
    context.baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: context.repository,
      encoding: "utf8",
    }).trim();
    await writeFile(join(context.repository, "package.json"), "MUTABLE_SENTINEL");
    context.repositoryFiles.push("missing.ts");
    const evidence = await readCompilerObligationEvidence(context);
    expect(JSON.stringify(evidence)).toContain("node --test");
    expect(JSON.stringify(evidence)).not.toContain("MUTABLE_SENTINEL");
    expect(evidence.some((entry) => entry.id === "unavailable-sources")).toBe(true);
  });

  it("keeps independent LLM labels distinct from human calibration and checkpointed", async () => {
    const { context } = await fixture();
    const label = {
      version: 1,
      caseDigest: "c".repeat(64),
      provenance: "llm-assisted",
      pass: "blinded",
      obligations: [
        {
          id: "tests",
          text: "Tests pass",
          evidenceIds: ["objective"],
          status: "required",
          reason: "Explicit Objective",
        },
      ],
      disagreements: [],
      uncertainty: [],
    };
    const checkpoint = vi.fn();
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        expect(prompt).not.toContain('"graph"');
        expect(prompt).not.toContain('"verdict"');
        return { value: label, usage };
      },
    });
    await expect(
      backend.labelCompilerCase(
        { compilation: context, caseDigest: label.caseDigest, pass: "blinded" },
        checkpoint,
      ),
    ).resolves.toMatchObject({ label, usage });
    expect(checkpoint).toHaveBeenCalledOnce();
    await expect(
      backend.extractObligations({ ...context, invocationTimeoutMs: 0 }, async () => {}),
    ).rejects.toThrow("deadline exhausted");
  });
});

it("adjudicates a cited inferred-obligation challenge independently without changing the graph", async () => {
  const { context, inventory, proposal } = await fixture();
  const compiled = await new CodexCliManagementBackend({
    runStructured: async () => ({ value: proposal, usage }),
  }).compile(context, async () => {});
  inventory.obligations.push({
    id: "invented",
    text: "Install unrelated infrastructure",
    kind: "prerequisite",
    evidenceIds: ["objective"],
    acceptanceEvidence: "Inferred infrastructure exists",
  });
  const reviewed = verdict(inventory, compiled.objective);
  reviewed.coverage.push({
    obligationId: "invented",
    status: "missing",
    itemIds: [],
    acceptanceBindings: [],
    evidenceIds: ["objective"],
    reason: "Original source does not require infrastructure",
  });
  const challenge = {
    findingId: "false-positive",
    obligationId: "invented",
    reason: "Original request only asks for tests",
    evidenceIds: ["objective"],
  };
  reviewed.inferenceCorrections = [{ ...challenge, disposition: "unsupported-inference" }];
  const runStructured = vi.fn(async (_cwd, _schema, prompt: string) => {
    expect(prompt).toContain("Adjudicate any structured evidence-cited challenges independently");
    expect(prompt).toContain(JSON.stringify(challenge));
    expect(prompt).not.toContain("PRIVATE_COMPILER_REASONING");
    return { value: reviewed, usage };
  });
  const result = await new CodexCliManagementBackend({ runStructured }).judgePlan(
    { compilation: context, inventory, objective: compiled.objective, challenges: [challenge] },
    async () => {},
  );
  expect(result.verdict.decision).toBe("accept");
  expect(result.verdict.coverage.find((entry) => entry.obligationId === "invented")!.status).toBe(
    "missing",
  );
  expect(runStructured).toHaveBeenCalledOnce();
  inventory.obligations.at(-1)!.kind = "explicit";
  reviewed.inventoryDigest = compilerEvalDigest(inventory);
  await expect(
    new CodexCliManagementBackend({ runStructured }).judgePlan(
      { compilation: context, inventory, objective: compiled.objective, challenges: [challenge] },
      async () => {},
    ),
  ).rejects.toMatchObject({ name: "ManagementOutputError", usage });
});

it("retains actual assisted-label prompt/source identities and marks provider model unknown", async () => {
  const { context } = await fixture();
  const prior = {
    version: 1 as const,
    caseDigest: "f".repeat(64),
    provenance: "llm-assisted" as const,
    pass: "blinded" as const,
    obligations: [
      {
        id: "tests",
        text: "Tests required",
        evidenceIds: ["objective"],
        status: "required" as const,
        reason: "Source request",
      },
    ],
    disagreements: [],
    uncertainty: [],
  };
  let capturedPrompt = "";
  let capturedSchema: unknown;
  const result = await new CodexCliManagementBackend({
    model: "requested-model",
    runStructured: async (_cwd, schema, prompt) => {
      capturedPrompt = prompt;
      capturedSchema = schema;
      return { value: { ...prior, pass: "adjudication" }, usage };
    },
  }).labelCompilerCase(
    { compilation: context, caseDigest: prior.caseDigest, pass: "adjudication", priorLabel: prior },
    async () => {},
  );
  expect(result.provenance).toMatchObject({
    promptDigest: compilerEvalDigest(capturedPrompt),
    schemaDigest: compilerEvalDigest(capturedSchema),
    requestedModel: "requested-model",
    providerReportedModel: null,
    priorLabelDigest: compilerEvalDigest(prior),
    baseSha: context.baseSha,
  });
  const source = JSON.parse(capturedPrompt.split("\n\n").at(-1)!);
  expect(result.provenance.sourceDigest).toBe(compilerEvalDigest(source));
});

it("permits 129 dependency reviews in both provider and runtime judge schemas", async () => {
  const { default: Ajv } = await import("ajv");
  const { CompilerJudgeVerdictSchema } = await import("../src/evaluation/compiler-eval.js");
  const { context, inventory, proposal } = await fixture();
  const compiled = await new CodexCliManagementBackend({
    runStructured: async () => ({ value: proposal, usage }),
  }).compile(context, async () => {});
  const output = verdict(inventory, compiled.objective);
  output.inferenceCorrections = [];
  output.dependencies = Array.from({ length: 129 }, (_, index) => ({
    itemId: `item-${index}`,
    dependsOn: "base",
    reason: "Dependency rationale",
    evidenceIds: ["objective"],
  }));
  expect(new Ajv({ strict: false }).compile(CODEX_PLAN_JUDGE_SCHEMA)(output)).toBe(true);
  expect(CompilerJudgeVerdictSchema.safeParse(output).success).toBe(true);
});

it("supplies carried challenges and prior independent corrections to the production repair prompt", async () => {
  const { context, inventory, proposal } = await fixture();
  const compiled = await new CodexCliManagementBackend({
    runStructured: async () => ({ value: proposal, usage }),
  }).compile(context, async () => {});
  inventory.obligations.push({
    id: "inferred-deploy",
    text: "Deploy infrastructure",
    kind: "prerequisite",
    evidenceIds: ["objective"],
    acceptanceEvidence: "Deployment exists",
  });
  const reviewed = verdict(inventory, compiled.objective);
  reviewed.decision = "repair";
  reviewed.coverage.push({
    obligationId: "inferred-deploy",
    status: "missing",
    itemIds: [],
    acceptanceBindings: [],
    evidenceIds: ["objective"],
    reason: "Not requested",
  });
  const challenge = {
    findingId: "false-deploy",
    obligationId: "inferred-deploy",
    reason: "Source does not require deployment",
    evidenceIds: ["objective"],
  };
  reviewed.inferenceCorrections = [{ ...challenge, disposition: "unsupported-inference" }];
  // The next repair still needs a real outstanding requirement after the invented one is waived.
  reviewed.coverage[0]!.status = "partial";
  reviewed.coverage[0]!.reason = "The original behavior still needs a correction";
  const summary = {
    changeSummary: "Preserve cited correction",
    lineage: [{ itemId: "code", previousItemIds: ["code"] }],
    findingDispositions: [],
  };
  const backend = new CodexCliManagementBackend({
    runStructured: async (_cwd, _schema, prompt) => {
      const source = JSON.parse(prompt.split("\n\n").at(-1)!);
      expect(source.challenges).toEqual([challenge]);
      expect(source.inferenceCorrections).toEqual(reviewed.inferenceCorrections);
      expect(prompt).toContain("not permission to waive explicit requirements");
      expect(prompt).toContain("next judge must reassess every original obligation");
      return { value: { objective: proposal, summary }, usage };
    },
  });
  await expect(
    backend.repairPlan(
      {
        compilation: context,
        inventory,
        objective: compiled.objective,
        verdict: reviewed,
        challenges: [challenge],
        revision: 2,
      },
      async () => {},
    ),
  ).resolves.toMatchObject({ repair: summary });
});
