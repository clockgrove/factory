import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
  CODEX_CASE_LABEL_SCHEMA,
} from "../src/management/codex-cli.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import type { CompilationContext, PlanJudgeContext } from "../src/management/backend.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  CompilerCaseLabelSchema,
  compilerEvalDigest,
  type ObligationInventory,
  type CompilerJudgeVerdict,
} from "../src/evaluation/compiler-eval.js";
import type { CompilerProposal } from "../src/compiler/contracts.js";
import { createCompilerValidationReport } from "../src/compiler/violations.js";
import { compilerJudgeCandidateFromCompiled } from "../src/compiler/judge-context.js";
import type { CompiledObjective } from "../src/graph.js";
import {
  semanticProjectionContext,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";

const temporary: string[] = [];
const usage = { inputTokens: 32, outputTokens: 12, cachedInputTokens: 8 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("preserves a fixed graph's exact execution design for independent judgment", () => {
  const graph: CompiledObjective = {
    title: "Existing exact graph",
    deferredCapabilityAdapters: ["adapter-one"],
    workItems: [
      {
        id: "fixed-item",
        title: "Keep exact fields",
        goal: "Preserve every persisted semantic and execution field.",
        acceptance: ["The exact command remains bound."],
        scope: ["src/fixed.ts"],
        preconditions: ["Pinned evidence exists."],
        outOfScope: ["No unrelated edits."],
        conventions: ["Keep the protocol exact."],
        dependsOn: [],
        baseSha: "a".repeat(40),
        validationCommands: ["tool:with/slash verify --exact"],
        validation: [
          {
            tier: "mechanical",
            criteria: ["The exact command remains bound."],
            evidenceCommands: ["tool:with/slash verify --exact"],
            rationale: "Pinned deterministic evidence.",
          },
        ],
        requirements: {
          os: ["linux"],
          architecture: ["x64"],
          tools: ["tool:with/slash"],
          services: ["fixture-service"],
          networkDestinations: ["example.invalid"],
          permittedSecretNames: ["FIXTURE_TOKEN"],
          trust: "isolated",
        },
        repositoryCapabilities: {
          provides: [
            {
              adapter: "adapter-one",
              generation: "generation-one",
              authorityPaths: ["src/fixed.ts"],
              operations: [{ kind: "verify", key: "exact" }],
            },
          ],
          requires: [],
        },
        managedRuntimes: [
          {
            tool: "npm",
            adapter: "adapter-one",
            adapterContract: 1,
            platform: { os: "linux", architecture: "x64", libc: "glibc" },
            releaseChannel: "ga",
          },
        ],
        context: {
          mustRead: ["README.md"],
          searchSeeds: ["Exact context"],
          dependencyEvidence: [],
        },
        criterionRisks: [{ criterion: "The exact command remains bound.", risk: "recovery" }],
        delivery: { group: "fixed-group", relationship: "root" },
      },
    ],
  };

  const candidate = compilerJudgeCandidateFromCompiled(graph);
  expect(candidate.workItems[0]).toMatchObject({
    validationCommands: ["tool:with/slash verify --exact"],
    validation: graph.workItems[0]!.validation,
    requirements: graph.workItems[0]!.requirements,
    repositoryCapabilities: graph.workItems[0]!.repositoryCapabilities,
    managedRuntimes: graph.workItems[0]!.managedRuntimes,
    context: graph.workItems[0]!.context,
    criterionRisks: graph.workItems[0]!.criterionRisks,
    delivery: graph.workItems[0]!.delivery,
  });
  expect(candidate.workItems[0]!.requirements?.tools).toEqual(["tool:with/slash"]);
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
    runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
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
    kind: "work-items",
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
          additionalTools: [],
          services: [],
          additionalNetworkDestinations: [],
          trust: "isolated",
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
    dependencies: [
      {
        itemId: "code",
        dependsOn: [],
        reason: "No prerequisite items",
        evidenceIds: ["objective"],
      },
    ],
    findings: [],
    inferenceCorrections: [],
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
      riskElevations: { count: 0, digest: compilerEvalDigest([]) },
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
    let observedPrompt = "";
    let observedSchema: unknown;
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, schema, prompt) => {
        calls.push("invoke");
        observedPrompt = prompt;
        observedSchema = schema;
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
    expect(result.provenance).toEqual({
      promptDigest: createHash("sha256").update(observedPrompt).digest("hex"),
      schemaDigest: createHash("sha256").update(JSON.stringify(observedSchema)).digest("hex"),
      baseSha: context.baseSha,
      model: null,
      reasoning: null,
    });
    await expect(
      backend.extractObligations(context, async () => {
        throw new Error("checkpoint unavailable");
      }),
    ).rejects.toMatchObject({ usage, message: "checkpoint unavailable" });
  });

  it("keeps 5,000 near-maximum repository paths out of the obligation model input", async () => {
    const { context, claims } = await fixture();
    const paths = Array.from(
      { length: 5_000 },
      (_, index) => `python/${String(index).padStart(5, "0")}-${"x".repeat(470)}.py`,
    );
    context.repositoryFiles = paths;
    context.repositoryEvidence = compilerObligationEvidence(context);
    let observedPrompt = "";
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        observedPrompt = prompt;
        return { value: claims, usage };
      },
    });
    await expect(backend.extractObligations(context, async () => {})).resolves.toBeDefined();
    expect(Buffer.byteLength(observedPrompt)).toBeLessThan(512 * 1024);
    expect(observedPrompt).not.toContain(paths.at(-1)!);
    expect(observedPrompt).toContain('"count":5000');
  });

  it("admits the maximum Objective and a maximum retained inventory repair without source duplication", async () => {
    const { context, claims } = await fixture();
    context.objective.title = "T".repeat(256);
    context.objective.body = "b".repeat(384 * 1024);
    context.repositoryEvidence = compilerObligationEvidence(context);
    expect(context.repositoryEvidence.filter((entry) => entry.kind === "objective").length).toBe(
      99,
    );
    const previousProposal = {
      version: 1,
      obligations: Array.from({ length: 30 }, (_, index) => ({
        id: `prior-${index}`,
        text: `${index}:` + "p".repeat(3_900),
        kind: "ambiguity",
        evidenceIds: ["foreign"],
        acceptanceEvidence: `${index}:` + "a".repeat(3_900),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(previousProposal))).toBeLessThan(256 * 1024);
    const prompts: string[] = [];
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        prompts.push(prompt);
        return { value: claims, usage };
      },
    });
    await backend.extractObligations(context, async () => {});
    await backend.extractObligations(context, async () => {}, undefined, {
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
      previousProposal,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => Buffer.byteLength(prompt) < 1024 * 1024)).toBe(true);
    expect(prompts[1]).not.toContain('"body":"');
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
      semanticProjectionContext(),
      async () => 44 * 60_000,
      context,
    );

    expect(runStructured).toHaveBeenCalledOnce();
  });

  it("judges complete coverage in an isolated prompt without compiler self-assessment", async () => {
    const { context, inventory, proposal } = await fixture();
    let observedPrompt = "";
    let observedSchema: unknown;
    const runStructured = vi.fn(async (_cwd, schema, prompt: string) => {
      observedPrompt = prompt;
      observedSchema = schema;
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
    expect(judged.provenance).toEqual({
      promptDigest: createHash("sha256").update(observedPrompt).digest("hex"),
      schemaDigest: createHash("sha256").update(JSON.stringify(observedSchema)).digest("hex"),
      baseSha: context.baseSha,
      model: null,
      reasoning: null,
    });
    expect(runStructured).toHaveBeenCalledOnce();
  });

  it("admits a compact 903-edge projection trace through the production judge boundary", async () => {
    const { context, inventory, proposal: single } = await fixture();
    const proposal: CompilerProposal = {
      ...single,
      workItems: Array.from({ length: 51 }, (_, index) => ({
        ...structuredClone(single.workItems[0]!),
        id: `item-${index + 1}`,
        title: `Implement item ${index + 1}`,
        goal: `Implement item ${index + 1}`,
        obligationIds: index === 0 ? ["tests"] : [],
        scope: [`src/item-${index + 1}.ts`],
        criteria: [
          {
            ...structuredClone(single.workItems[0]!.criteria[0]!),
            id: "tests-pass",
            text: `Item ${index + 1} passes its tests`,
          },
        ],
      })),
    };
    const addedEdges = Array.from({ length: 43 }, (_, later) =>
      Array.from({ length: later }, (_, earlier) => ({
        itemId: `item-${later + 1}`,
        dependsOn: `item-${earlier + 1}`,
        reason: "exclusive-resource" as const,
      })),
    ).flat();
    expect(addedEdges).toHaveLength(903);
    const graphDigest = compilerEvalDigest(proposal);
    const contextWithTrace: PlanJudgeContext = {
      compilation: context,
      inventory,
      proposal,
      graphDigest,
      challenges: [],
      projectionTrace: {
        protocol: "clockgrove.factory/compiler-projection",
        requestDigest: "a".repeat(64),
        proposalDigest: compilerEvalDigest(proposal),
        graphDigest,
        addedEdges,
        adapterBindings: [],
        riskElevations: { count: 0, digest: compilerEvalDigest([]) },
      },
    };
    const reviewed: CompilerJudgeVerdict = {
      ...verdict(inventory, single, graphDigest),
      draftDigest: graphDigest,
      coverage: [
        {
          obligationId: "tests",
          status: "covered",
          itemIds: ["item-1"],
          acceptanceBindings: [{ itemId: "item-1", criterionId: "tests-pass" }],
          evidenceIds: ["objective"],
          reason: "Tests required",
        },
      ],
      items: proposal.workItems.map((item) => ({
        itemId: item.id,
        granularity: "cohesive",
        reason: "One bounded result",
        evidenceIds: ["objective"],
      })),
      dependencies: proposal.workItems.map((item) => ({
        itemId: item.id,
        dependsOn: addedEdges
          .filter((edge) => edge.itemId === item.id)
          .map((edge) => edge.dependsOn),
        reason: "Factory serialized the complete exclusive-resource dependency set",
        evidenceIds: ["objective"],
      })),
    };
    const runStructured = vi.fn(async (_cwd, _schema, prompt: string) => {
      const source = prompt.split("\n\n").at(-1)!;
      expect(Buffer.byteLength(source)).toBeLessThan(900 * 1024);
      return { value: reviewed, usage };
    });
    await expect(
      new CodexCliManagementBackend({ runStructured }).judgePlan(contextWithTrace, async () => {}),
    ).resolves.toMatchObject({ verdict: { decision: "accept" } });
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
      }).proposePlan(request, async () => {}, semanticProjectionContext(), undefined, context),
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
    }).proposePlan(
      repairedRequest,
      async () => {},
      semanticProjectionContext(),
      undefined,
      context,
    );
    if (repaired.proposal.kind !== "work-items") throw new Error("fixture requires Work Items");
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

it("keeps provider and runtime judge cardinality contracts aligned", async () => {
  const { default: Ajv } = await import("ajv");
  const { CompilerJudgeVerdictSchema, ObligationClaimsSchema } = await import(
    "../src/evaluation/compiler-eval.js"
  );
  const { inventory, proposal } = await fixture();
  const output = verdict(inventory, proposal);
  output.inferenceCorrections = [];
  const ajv = new Ajv({ strict: false });
  const providerJudge = ajv.compile(CODEX_PLAN_JUDGE_SCHEMA);
  const providerObligations = ajv.compile(CODEX_OBLIGATION_SCHEMA);
  expect(providerJudge(output)).toBe(CompilerJudgeVerdictSchema.safeParse(output).success);
  const invalidJudgments = [
    { ...output, coverage: [] },
    { ...output, items: Array.from({ length: 101 }, () => output.items[0]!) },
    { ...output, dimensions: output.dimensions.slice(0, -1) },
    { ...output, findings: Array.from({ length: 65 }, () => ({ ...output.findings[0] })) },
    {
      ...output,
      dependencies: [
        {
          itemId: "code",
          dependsOn: Array.from({ length: 51 }, (_, index) => `item-${index}`),
          reason: "Too many dependencies",
          evidenceIds: ["objective"],
        },
      ],
    },
    { ...output, draftDigest: "not-a-digest" },
    { ...output, items: [{ ...output.items[0]!, itemId: "x".repeat(161) }] },
    { ...output, coverage: [{ ...output.coverage[0]!, evidenceIds: [] }] },
  ];
  for (const invalid of invalidJudgments) {
    expect(providerJudge(invalid)).toBe(false);
    expect(CompilerJudgeVerdictSchema.safeParse(invalid).success).toBe(false);
  }
  const claims = { version: 1 as const, obligations: inventory.obligations };
  expect(providerObligations(claims)).toBe(ObligationClaimsSchema.safeParse(claims).success);
  for (const invalid of [
    { ...claims, obligations: [] },
    { ...claims, obligations: [{ ...claims.obligations[0]!, evidenceIds: [] }] },
    { ...claims, obligations: [{ ...claims.obligations[0]!, id: "x".repeat(161) }] },
  ]) {
    expect(providerObligations(invalid)).toBe(false);
    expect(ObligationClaimsSchema.safeParse(invalid).success).toBe(false);
  }
});

it("keeps provider and runtime case-label boundaries aligned", async () => {
  const { default: Ajv } = await import("ajv");
  const provider = new Ajv({ strict: false }).compile(CODEX_CASE_LABEL_SCHEMA);
  const label = {
    version: 1,
    caseDigest: "a".repeat(64),
    provenance: "llm-assisted",
    pass: "blinded",
    obligations: [
      {
        id: "required-outcome",
        text: "Preserve the required outcome.",
        evidenceIds: ["objective"],
        status: "required",
        reason: "The Objective says so.",
      },
    ],
    disagreements: [
      {
        obligationId: "required-outcome",
        priorStatus: "ambiguous",
        reason: "Pinned evidence resolves it.",
        evidenceIds: ["objective"],
      },
    ],
    uncertainty: ["No remaining uncertainty."],
  };
  const cases = [
    [label, true],
    [{ ...label, caseDigest: "not-a-digest" }, false],
    [{ ...label, obligations: [] }, false],
    [{ ...label, obligations: [{ ...label.obligations[0]!, id: "x".repeat(161) }] }, false],
    [{ ...label, obligations: [{ ...label.obligations[0]!, evidenceIds: [] }] }, false],
    [
      {
        ...label,
        disagreements: [{ ...label.disagreements[0]!, obligationId: "x".repeat(161) }],
      },
      false,
    ],
    [{ ...label, disagreements: [{ ...label.disagreements[0]!, evidenceIds: [] }] }, false],
    [{ ...label, uncertainty: ["x".repeat(4_001)] }, false],
  ] as const;
  for (const [candidate, accepted] of cases) {
    expect(provider(candidate), JSON.stringify(provider.errors)).toBe(accepted);
    expect(CompilerCaseLabelSchema.safeParse(candidate).success).toBe(accepted);
  }
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
  request.inventory.obligations.push({
    id: "inferred-deploy",
    text: "Deploy infrastructure",
    kind: "prerequisite",
    evidenceIds: ["objective"],
    acceptanceEvidence: "Deployment exists",
  });
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
    backend.proposePlan(
      repairRequest,
      async () => {},
      semanticProjectionContext(),
      undefined,
      context,
    ),
  ).resolves.toMatchObject({ proposal: { protocol: "clockgrove.factory/compiler-proposal" } });
});
