import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
  readCompilerObligationEvidence,
  CODEX_OBLIGATION_SCHEMA,
  CODEX_PLAN_JUDGE_SCHEMA,
} from "../src/management/codex-cli.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import type { CompilationContext, PlanJudgeContext } from "../src/management/backend.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type ObligationInventory,
  type CompilerJudgeVerdict,
} from "../src/evaluation/compiler-eval.js";
import type { CompilerProposal } from "../src/compiler/contracts.js";
import { createCompilerValidationReport } from "../src/compiler/violations.js";
import { semanticProposal, semanticRequest } from "./helpers/semantic-compiler.js";

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
  const claims = { version: 1 as const, obligations: inventory.obligations };
  const proposal: CompilerProposal = {
    protocol: "clockgrove.factory/compiler-proposal" as const,
    workItems: [
      {
        id: "code",
        title: "Implement code",
        goal: "Implement code",
        obligationIds: ["tests"],
        criteria: [
          {
            id: "tests-pass",
            text: "Tests pass",
            risk: "ordinary" as const,
            validation: [
              {
                tier: "mechanical" as const,
                evidence: [{ kind: "observed" as const, recipeId: "fixture-recipe" }],
              },
            ],
          },
        ],
        scope: ["src/code.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        exclusiveResources: [],
        executionIntent: {
          estimatedDurationMinutes: 10,
        },
      },
    ],
  };
  return { context, inventory, claims, proposal };
}
function verdict(
  inventory: ObligationInventory,
  proposal: CompilerProposal,
  graphDigest = compilerEvalDigest(proposal),
): CompilerJudgeVerdict {
  return {
    version: 1,
    rubricVersion: 1,
    draftDigest: graphDigest,
    inventoryDigest: compilerEvalDigest(inventory),
    coverage: [
      {
        obligationId: "tests",
        status: "covered",
        itemIds: ["code"],
        acceptanceBindings: [{ itemId: "code", criterionId: "tests-pass" }],
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

function judgeContext(
  compilation: CompilationContext,
  inventory: ObligationInventory,
  proposal: CompilerProposal,
  challenges: PlanJudgeContext["challenges"] = [],
): PlanJudgeContext {
  const graphDigest = compilerEvalDigest(proposal);
  return {
    compilation,
    inventory,
    proposal,
    graphDigest,
    challenges,
    projectionTrace: {
      protocol: "clockgrove.factory/compiler-projection",
      requestDigest: "a".repeat(64),
      proposalDigest: compilerEvalDigest(proposal),
      graphDigest,
      addedEdges: [],
      adapterBindings: [],
      riskElevations: [],
    },
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
    const { context, inventory, claims } = await fixture();
    const calls: string[] = [];
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        calls.push("invoke");
        expect(prompt).toContain("No compiled plan is available");
        expect(prompt).not.toContain('"workItems"');
        expect(prompt).toContain("do not return or rewrite that trusted envelope");
        return { value: claims, usage };
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

  it("hydrates canonical evidence and gives a bounded invalid claim to one repair", async () => {
    const { context, inventory, claims } = await fixture();
    const prompts: string[] = [];
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, schema, prompt) => {
        expect(schema).toEqual(CODEX_OBLIGATION_SCHEMA);
        prompts.push(prompt);
        return { value: claims, usage };
      },
    });
    const result = await backend.extractObligations(context, async () => {}, undefined, {
      revision: 1,
      validationReport: createCompilerValidationReport("obligations", [
        {
          code: "schema-invalid",
          itemId: null,
          field: "/obligations/0/evidenceIds/0",
          expected: "known evidence ID",
          observed: "foreign",
        },
      ]),
      previousProposal: {
        version: 1,
        obligations: [{ ...claims.obligations[0], evidenceIds: ["foreign"] }],
      },
    });

    expect(result.inventory).toEqual(inventory);
    expect(result.inventory.evidence).toEqual(context.repositoryEvidence);
    expect(prompts[0]).toContain("priorInventoryFailure");
    expect(prompts[0]).toContain('"code":"schema-invalid"');
    expect(prompts[0]).toContain('"foreign"');
  });

  it("rejects a 300 KiB obligation proposal instead of authorizing a seedless repair", async () => {
    const { context, claims } = await fixture();
    const oversized = {
      ...claims,
      padding: "x".repeat(300 * 1024),
    };
    const runStructured = vi.fn(async () => ({ value: oversized, usage }));
    let observed: unknown;
    try {
      await new CodexCliManagementBackend({ runStructured }).extractObligations(
        context,
        async () => {},
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      name: "ManagementOutputError",
      usage,
      proposal: undefined,
    });
    expect(observed).not.toHaveProperty("repairableInvalidClaims");

    const repairRun = vi.fn(async () => ({ value: claims, usage }));
    await expect(
      new CodexCliManagementBackend({ runStructured: repairRun }).extractObligations(
        context,
        async () => {},
        undefined,
        {
          revision: 1,
          validationReport: createCompilerValidationReport("obligations", [
            {
              code: "schema-invalid",
              itemId: null,
              field: "",
              expected: "bounded obligation claims",
              observed: "oversized",
            },
          ]),
          previousProposal: oversized,
        },
      ),
    ).rejects.toThrow("prior obligation proposal is");
    expect(repairRun).not.toHaveBeenCalled();
  });

  it("passes the final admitted Objective remainder without a legacy 30-minute cap", async () => {
    const { context } = await fixture();
    const request = semanticRequest();
    context.invocationTimeoutMs = 45 * 60_000;
    const runStructured = vi.fn(
      async (
        _cwd: string,
        _schema: unknown,
        _prompt: string,
        _model: unknown,
        invocationTimeoutMs?: number,
      ) => {
        expect(invocationTimeoutMs).toBe(44 * 60_000);
        return { value: semanticProposal(request), usage };
      },
    );
    const backend = new CodexCliManagementBackend({ runStructured });

    await backend.proposePlan(
      request,
      async () => {},
      async () => 44 * 60_000,
      context,
    );

    expect(runStructured).toHaveBeenCalledOnce();
  });

  it("judges complete coverage in an isolated prompt without compiler self-assessment", async () => {
    const { context, inventory, proposal } = await fixture();
    const runStructured = vi.fn(async (_cwd, schema, prompt: string) => {
      expect(schema).toEqual(CODEX_PLAN_JUDGE_SCHEMA);
      expect(prompt).not.toContain("PRIVATE_COMPILER_SELF_ASSESSMENT");
      expect(prompt).toContain("every item");
      expect(prompt).toContain("Treat Objective, inventory, proposal, and projection trace");
      return { value: verdict(inventory, proposal), usage };
    });
    const judged = await new CodexCliManagementBackend({ runStructured }).judgePlan(
      judgeContext(context, inventory, proposal),
      async () => {},
    );
    expect(judged.verdict.draftDigest).toBe(compilerEvalDigest(proposal));
    expect(runStructured).toHaveBeenCalledOnce();
  });

  it("rejects incomplete or foreign evidence judgments while preserving paid usage", async () => {
    const { context, inventory, proposal } = await fixture();
    const invalid = verdict(inventory, proposal);
    invalid.coverage = [];
    const checkpoint = vi.fn();
    await expect(
      new CodexCliManagementBackend({
        runStructured: async () => ({ value: invalid, usage }),
      }).judgePlan(judgeContext(context, inventory, proposal), checkpoint),
    ).rejects.toMatchObject({ name: "ManagementOutputError", usage });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("preserves malformed proposals and can repair an initial mechanical failure", async () => {
    const { context } = await fixture();
    const request = semanticRequest();
    const invalid = { protocol: "clockgrove.factory/compiler-proposal", workItems: [] };
    await expect(
      new CodexCliManagementBackend({
        runStructured: async () => ({ value: invalid, usage }),
      }).proposePlan(request, async () => {}, undefined, context),
    ).rejects.toMatchObject({ proposal: invalid, usage });
    const repairedRequest = {
      ...request,
      revision: 1,
      previousProposal: semanticProposal(request),
      validationReport: createCompilerValidationReport("proposal", [
        {
          code: "duplicate-item-id" as const,
          itemId: null,
          field: "/workItems",
          expected: "unique Work Item IDs",
          observed: "duplicate",
        },
      ]),
    };
    const repaired = await new CodexCliManagementBackend({
      runStructured: async () => ({
        value: semanticProposal(request),
        usage,
      }),
    }).proposePlan(repairedRequest, async () => {}, undefined, context);
    expect(repaired.proposal.workItems).toHaveLength(1);
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
  inventory.obligations.push({
    id: "invented",
    text: "Install unrelated infrastructure",
    kind: "prerequisite",
    evidenceIds: ["objective"],
    acceptanceEvidence: "Inferred infrastructure exists",
  });
  const reviewed = verdict(inventory, proposal);
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
    judgeContext(context, inventory, proposal, [challenge]),
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
      judgeContext(context, inventory, proposal, [challenge]),
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
  const { inventory, proposal } = await fixture();
  const output = verdict(inventory, proposal);
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
  inventory.obligations.push({
    id: "inferred-deploy",
    text: "Deploy infrastructure",
    kind: "prerequisite",
    evidenceIds: ["objective"],
    acceptanceEvidence: "Deployment exists",
  });
  const reviewed = verdict(inventory, proposal);
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
  reviewed.findings.push({
    id: "correct-tests",
    dimension: "coverage",
    severity: "blocking",
    confidence: 1,
    obligationIds: ["tests"],
    itemIds: ["code"],
    evidenceIds: ["objective"],
    rootCause: "The original behavior still needs a correction",
    correction: "Correct the original behavior",
    uncertainty: "",
  });
  const request = semanticRequest();
  const repairRequest = {
    ...request,
    revision: 2,
    previousProposal: semanticProposal(request),
    semanticFindings: reviewed.findings,
    challenges: [challenge],
  };
  const backend = new CodexCliManagementBackend({
    runStructured: async (_cwd, _schema, prompt) => {
      const source = JSON.parse(prompt.split("\n\n").at(-1)!);
      expect(source.challenges).toEqual([challenge]);
      expect(source.semanticFindings).toEqual(reviewed.findings);
      expect(prompt).toContain("preserve sound semantic intent");
      expect(prompt).toContain("do not weaken obligations");
      return { value: semanticProposal(request), usage };
    },
  });
  await expect(
    backend.proposePlan(repairRequest, async () => {}, undefined, context),
  ).resolves.toMatchObject({ proposal: { protocol: "clockgrove.factory/compiler-proposal" } });
});
