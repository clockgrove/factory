import type { CompilerProposal, CompilerRequest } from "../../src/compiler/contracts.js";
import { emptyCompilerValidationReport } from "../../src/compiler/violations.js";
import { compilerEvalDigest } from "../../src/evaluation/compiler-eval.js";
import { normalizeRepositoryFacts } from "../../src/repository-profiles/index.js";
import type { PinnedLfsFacts } from "../../src/repository-profiles/git-lfs.js";
import type { PinnedRepositoryFacts } from "../../src/repository-profiles/read.js";
import { DEFAULT_RUN_POLICY, type RunPolicy } from "../../src/protocol/policy.js";
import {
  summarizeCompilerValidationSurfaces,
  type CompilerProjectionContext,
} from "../../src/compiler/proposal.js";
import { compilerCapabilitiesForRepository } from "../../src/toolchains/compiler-capabilities.js";

export const semanticBaseSha = "a".repeat(40);

export function semanticPinnedFacts(input?: {
  baseSha?: string;
  paths?: string[];
  scripts?: Record<string, string>;
  documents?: Record<string, string>;
  lfs?: PinnedLfsFacts;
}): PinnedRepositoryFacts {
  const paths = input?.paths ?? ["package.json", "package-lock.json", "src/item-1.ts"];
  const repository = normalizeRepositoryFacts({
    files: paths.map((path) => ({ path })),
    scripts: input?.scripts ?? { test: "vitest run" },
    ...(input?.lfs ? { lfs: input.lfs } : {}),
    documents:
      input?.documents ??
      (paths.includes("package.json")
        ? { "package.json": JSON.stringify({ scripts: input?.scripts ?? { test: "vitest run" } }) }
        : {}),
  });
  const manifests = paths
    .filter((path) =>
      /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lock|bun\.lockb|bunfig\.toml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|uv\.lock|\.python-version)$/.test(
        path,
      ),
    )
    .sort();
  const relevantPaths = [...paths].sort();
  const unsigned = {
    baseSha: input?.baseSha ?? semanticBaseSha,
    repository,
    manifests,
    relevantPaths,
  };
  return { ...unsigned, digest: compilerEvalDigest(unsigned) };
}

export function semanticProjectionContext(
  pinnedFacts = semanticPinnedFacts(),
  runPolicy: RunPolicy = {
    ...DEFAULT_RUN_POLICY,
    allowedNetworkDestinations: [],
  },
): CompilerProjectionContext {
  return { pinnedFacts, runPolicy };
}

export function semanticRequest(
  pinned = semanticPinnedFacts(),
  allowedNetworkDestinations: string[] = [],
): CompilerRequest {
  const objective = { number: 404, title: "Semantic compiler", body: "Implement the contract." };
  const objectiveDigest = compilerEvalDigest(objective);
  const capabilities = compilerCapabilitiesForRepository(pinned, allowedNetworkDestinations);
  return {
    protocol: "clockgrove.factory/compiler-request",
    revision: 0,
    objective: { ...objective, digest: objectiveDigest },
    baseSha: pinned.baseSha,
    inventory: {
      version: 1,
      objectiveDigest,
      baseSha: pinned.baseSha,
      evidence: [
        {
          id: "objective",
          kind: "objective",
          identity: objectiveDigest,
          excerpt: objective.body,
        },
      ],
      obligations: [
        {
          id: "explicit-contract",
          text: "Implement the complete semantic compiler contract.",
          kind: "explicit",
          evidenceIds: ["objective"],
          acceptanceEvidence: "The contract is covered by bound acceptance criteria.",
        },
      ],
    },
    inventorySource: "independent-extraction",
    repository: {
      manifests: pinned.manifests,
      requiredTools: [...new Set(pinned.repository.lfs?.requiredTools ?? [])].sort(),
      validationRecipes: capabilities.validationRecipes,
      toolchains: capabilities.toolchains,
      validationSurfaces: summarizeCompilerValidationSurfaces(pinned.relevantPaths),
      pathCount: pinned.relevantPaths.length,
    },
    constraints: {
      maxWorkItems: 100,
      planningWorkItemThreshold: 100,
      planningCriticalPathMinutes: 43_200,
      planningAggregateWorkMinutes: 432_000,
      maxDependenciesPerItem: 50,
      allowedNetworkDestinations: [...allowedNetworkDestinations].sort(),
      workItemTimeoutMinutes: 30,
    },
    previousProposal: null,
    validationReport: emptyCompilerValidationReport(),
    semanticFindings: [],
    challenges: [],
  };
}

export function semanticProposal(request: CompilerRequest, count = 1): CompilerProposal {
  const recipe = request.repository.validationRecipes[0];
  if (!recipe) throw new Error("semantic fixture requires an observed validation recipe");
  return {
    protocol: "clockgrove.factory/compiler-proposal",
    kind: "work-items",
    workItems: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      return {
        id: `item-${number}`,
        title: `Implement item ${number}`,
        goal: `Deliver item ${number}.`,
        obligationIds: index === 0 ? ["explicit-contract"] : [],
        criteria: [
          {
            id: "implemented",
            text: `Item ${number} is implemented and tested.`,
            risk: "ordinary",
            validation: [
              { tier: "mechanical", evidence: [{ kind: "observed", recipeId: recipe.id }] },
            ],
          },
        ],
        scope: [`src/item-${number}.ts`],
        preconditions: [],
        outOfScope: ["Unrelated behavior."],
        conventions: ["Follow repository conventions."],
        dependsOn: index === 0 ? [] : [`item-${index}`],
        exclusiveResources: [],
        executionIntent: {
          estimatedDurationMinutes: 15,
          additionalTools: [],
          services: [],
          additionalNetworkDestinations: [],
          trust: "isolated",
        },
      };
    }),
  };
}
