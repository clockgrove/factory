import type { CompiledObjective } from "../../src/graph.js";
import { execFileSync } from "node:child_process";
import type {
  CompilationContext,
  CompilerProposalResult,
  CompilerModelAdmission,
  ManagementBackend,
  ManagementUsage,
} from "../../src/management/backend.js";
import {
  CompilerProposalSchema,
  type CompilerRequest,
  type ValidationIntentRef,
} from "../../src/compiler/contracts.js";
import { compilerEvalDigest } from "../../src/evaluation/compiler-eval.js";
import { emptyCompilerValidationReport } from "../../src/compiler/violations.js";
import { parseCompilerOperation } from "../../src/toolchains/compiler-capabilities.js";
import { inferCriterionRisk } from "../../src/compiler/validation-design.js";
import { parseAndValidateCompilerProposal } from "../../src/compiler/proposal.js";
import { compiledGraphDigest } from "../../src/graph.js";
import type { ValidatedCompilerDraft } from "../../src/evaluation/compiler-draft-loop.js";

export function pinFixtureRepository(repository: string): string {
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Factory Fixture",
      "-c",
      "user.email=factory-fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: repository },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
}

export interface LegacyFixtureCompilationResult {
  objective: CompiledObjective;
  usage: ManagementUsage;
}
export type LegacyFixtureCompiler = (
  context: CompilationContext,
  checkpoint: (result: LegacyFixtureCompilationResult) => Promise<void>,
  beforeModelInvocation?: CompilerModelAdmission,
) => Promise<LegacyFixtureCompilationResult>;

function validationReference(
  request: CompilerRequest,
  commands: readonly string[],
  scope: readonly string[],
): ValidationIntentRef {
  for (const command of commands) {
    const recipe = request.repository.validationRecipes.find((entry) => entry.command === command);
    if (recipe) return { kind: "observed", recipeId: recipe.id };
    const bare = request.repository.validationRecipes.find(
      (entry) => entry.command === "node --test",
    );
    const targets = /^node --test (.+)$/.exec(command)?.[1]?.split(/\s+/) ?? [];
    if (
      bare &&
      targets.length > 0 &&
      targets.every((target) =>
        scope.some((path) => path === target || (path.endsWith("/") && target.startsWith(path))),
      )
    )
      return { kind: "scoped-node-test", targets };
    for (const capability of request.repository.toolchains) {
      const operation = parseCompilerOperation(capability.adapterId, command);
      if (capability.state === "eligible-deferred" && operation)
        return { kind: "deferred", adapterId: capability.adapterId, operation };
    }
  }
  const recipe = request.repository.validationRecipes[0];
  if (!recipe) throw new Error("fixture request has no validation capability");
  return { kind: "observed", recipeId: recipe.id };
}

export function proposalFromCompiledFixture(
  request: CompilerRequest,
  objective: CompiledObjective,
) {
  const explicit = request.inventory.obligations
    .filter((entry) => entry.kind === "explicit")
    .map((entry) => entry.id);
  return CompilerProposalSchema.parse({
    protocol: "clockgrove.factory/compiler-proposal",
    workItems: objective.workItems.map((item, itemIndex) => ({
      id: item.id,
      title: item.title,
      goal: item.goal,
      obligationIds: itemIndex === 0 ? explicit : [],
      criteria: item.acceptance.map((text, criterionIndex) => {
        const designed = (item.validation ?? []).filter((entry) => entry.criteria.includes(text));
        const explicitDesign = designed.some(
          (entry) =>
            entry.rationale !==
            "No criterion-specific deterministic binding was supplied; conservative semantic review is retained.",
        );
        const designedValidation = explicitDesign
          ? designed.map((entry) => ({
              tier: entry.tier,
              evidence:
                entry.tier === "semantic"
                  ? []
                  : [
                      ...new Map(
                        (entry.evidenceCommands?.length
                          ? entry.evidenceCommands
                          : (item.validationCommands ?? [])
                        ).map((command) => {
                          const reference = validationReference(request, [command], item.scope);
                          return [JSON.stringify(reference), reference] as const;
                        }),
                      ).values(),
                    ],
            }))
          : [
              {
                tier: "mechanical" as const,
                evidence: [validationReference(request, item.validationCommands ?? [], item.scope)],
              },
            ];
        const validation = designedValidation.some((entry) => entry.evidence.length > 0)
          ? designedValidation
          : [
              {
                tier: "mechanical" as const,
                evidence: [validationReference(request, item.validationCommands ?? [], item.scope)],
              },
              ...designedValidation,
            ];
        return {
          id: `criterion-${criterionIndex + 1}`,
          text,
          risk:
            item.criterionRisks?.find((entry) => entry.criterion === text)?.risk ??
            inferCriterionRisk(text),
          validation,
        };
      }),
      scope: item.scope,
      preconditions: item.preconditions,
      outOfScope: item.outOfScope,
      conventions: item.conventions,
      dependsOn: item.dependsOn,
      exclusiveResources: (item.changeSurface?.exclusiveResources ?? []).filter((resource) =>
        /^[a-z0-9][a-z0-9:._/-]*$/.test(resource),
      ),
      executionIntent: {
        estimatedDurationMinutes: item.requirements?.estimatedDurationMinutes ?? 30,
        additionalTools: item.requirements?.tools ?? [],
        services: item.requirements?.services ?? [],
        additionalNetworkDestinations: item.requirements?.networkDestinations ?? [],
        trust: item.requirements?.trust ?? "isolated",
      },
    })),
  });
}

export function proposalResultFromCompiledFixture(
  request: CompilerRequest,
  objective: CompiledObjective,
  usage: ManagementUsage = { inputTokens: 1, outputTokens: 1 },
): CompilerProposalResult {
  const proposal = proposalFromCompiledFixture(request, objective);
  const report = parseAndValidateCompilerProposal(request, proposal).report;
  if (report.status !== "valid")
    throw new Error(`fixture semantic proposal is invalid: ${JSON.stringify(report.violations)}`);
  return {
    request,
    proposal,
    report,
    usage,
    provenance: {
      promptDigest: compilerEvalDigest(request),
      schemaDigest: "a".repeat(64),
      requestDigest: compilerEvalDigest(request),
      model: null,
      reasoning: null,
      baseSha: request.baseSha,
    },
  };
}

export function validatedDraftFromCompiledFixture(
  request: CompilerRequest,
  objective: CompiledObjective,
): ValidatedCompilerDraft {
  const proposal = proposalFromCompiledFixture(request, objective);
  return {
    proposal,
    objective,
    projectionTrace: {
      protocol: "clockgrove.factory/compiler-projection",
      requestDigest: compilerEvalDigest(request),
      proposalDigest: compilerEvalDigest(proposal),
      graphDigest: compiledGraphDigest(objective),
      addedEdges: [],
      adapterBindings: [],
      riskElevations: [],
    },
    report: emptyCompilerValidationReport(),
    requestDigest: compilerEvalDigest(request),
  };
}

export function adaptFixtureCompiler(
  compile: LegacyFixtureCompiler,
): ManagementBackend["proposePlan"] {
  return async (request, checkpoint, _admission, execution) => {
    if (!execution) throw new Error("fixture compiler requires execution context");
    const compiled = await compile(execution, async () => {}, _admission);
    const result = proposalResultFromCompiledFixture(request, compiled.objective, compiled.usage);
    await checkpoint(result);
    return result;
  };
}
