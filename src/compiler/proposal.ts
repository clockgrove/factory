import {
  assertCompiledObjectiveAdoptsLegacyConstraints,
  compiledGraphDigest,
  compiledGraphDigestForDiagnostics,
  MAX_COMPILED_GRAPH_BYTES,
  renderWorkPacket,
  renderWorkPacketWithRawGraphMetadataForDiagnostics,
  validateGraph,
  workerPacketFromCompiled,
  type CompiledObjective,
  type CompiledAssetProductionWorkItem,
  type GraphItemMetadata,
  type LegacyGraphConstraints,
} from "../graph.js";
import { analyzeDependencies, overlappingScopePairs } from "../graph-analysis.js";
import {
  EMPTY_REPOSITORY_CAPTURE_PLANNING,
  type CompilationContext,
} from "../management/backend.js";
import {
  destinationAllowedByPolicy,
  normalizeSchedulingPolicy,
  type RunPolicy,
} from "../protocol/policy.js";
import {
  repositoryCaptureProfileForOutput,
  RepositoryScopePathSchema,
} from "../protocol/worker-packet.js";
import type { RepositoryCaptureRecipe } from "../protocol/worker-packet.js";
import { MAX_GITHUB_TEXT_BYTES, MAX_WORKER_PACKET_BYTES } from "../protocol/limits.js";
import {
  readPinnedCompilerFacts,
  scopedNodeTestCommand,
  type PinnedRepositoryFacts,
} from "../repository-profiles/index.js";
import { scopeOwnsPath } from "../repository-capabilities/model.js";
import {
  compilerCapabilitiesForRepository,
  formatCompilerOperation,
  type CompilerRepositoryCapabilities,
} from "../toolchains/compiler-capabilities.js";
import { toolchainAdapterById } from "../toolchains/authority.js";
import {
  compilerEvalDigest,
  deriveCompilerInferenceChallenges,
  ObligationInventorySchema,
  type CompilerInferenceChallenge,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import {
  acceptanceTextProblem,
  assessDecomposition,
  compileObjective,
  validateCompiledObjective,
  type DecompositionEvidence,
  type CompilerWorkItem,
  type CompilerWorkItemInput,
} from "./index.js";
import { compilerJudgeSourceBytes, MAX_COMPILER_JUDGE_SOURCE_BYTES } from "./judge-context.js";
import { inferCriterionRisk, type CriterionRisk } from "./validation-design.js";
import {
  normalizeCompilerProposalProviderOutput,
  CompilerProposalSchema,
  CompilerRequestSchema,
  type CompilerDiagnosticValue,
  type CompilerJudgeFinding,
  type CompilerProposal,
  type CompilerProposalValue,
  type CompilerRepositoryCaptureFacts,
  type CompilerRequest,
  type CompilerValidationReport,
  type CompilerViolation,
  type ValidationIntentRef,
} from "./contracts.js";
import { isMeaningfulPlanningText, validateObjectivePlan } from "./objective-planning.js";
import { createCompilerValidationReport, emptyCompilerValidationReport } from "./violations.js";
import { CompilerInvariantError } from "./invariant-error.js";
import type { WorkerAssetInput } from "../assets/contracts.js";
import { declaredAssetHandlerContract } from "../assets/handlers.js";
import type { CompilerMediaProducerCapability, MediaIntent } from "../assets/media-intent.js";
import { evaluateBoundRepositoryCaptureCapabilities } from "../validation/repository-capture-catalog.js";
export { CompilerInvariantError } from "./invariant-error.js";

export class CompilerRequestValidationError extends Error {
  constructor(readonly report: CompilerValidationReport) {
    super(`compiler request is ${report.status}`);
    this.name = "CompilerRequestValidationError";
  }
}

export const MAX_COMPILER_REQUEST_BYTES = 900 * 1024;

/** The repository-authority portion of request validation. Read-only
 * qualification preflight calls this same boundary after deriving capabilities
 * from the exact pinned base, so it cannot maintain a looser copy of the
 * compiler's mechanical acceptance rules. */
export function validateCompilerRepositoryAuthority(
  repository: Pick<CompilerRepositoryCapabilities, "validationRecipes" | "toolchains">,
  allowedNetworkDestinations: readonly string[],
): CompilerValidationReport {
  const violations: CompilerViolation[] = [];
  const eligible = repository.toolchains.filter(
    (toolchain) => toolchain.state === "eligible-deferred",
  );
  for (const toolchain of repository.toolchains) {
    if (toolchain.state === "partial")
      violations.push(
        violation(
          "partial-toolchain-authority",
          "/repository/toolchains",
          "observed or wholly absent authority",
          toolchain.adapterId,
        ),
      );
    if (toolchain.state === "mixed")
      violations.push(
        violation(
          "mixed-toolchain-authority",
          "/repository/toolchains",
          "one authority owner",
          toolchain.adapterId,
        ),
      );
  }
  if (repository.validationRecipes.length === 0 && eligible.length === 0) {
    for (const toolchain of repository.toolchains) {
      if (toolchain.state === "policy-blocked")
        violations.push(
          violation(
            "denied-network-destination",
            "/constraints/allowedNetworkDestinations",
            toolchain.networkDestinations,
            [...allowedNetworkDestinations],
          ),
        );
    }
    violations.push(
      violation(
        repository.toolchains.every((entry) => entry.state === "unsupported")
          ? "unsupported-toolchain"
          : "no-validation-capability",
        "/repository",
        "at least one observed recipe or eligible deferred adapter",
        {
          recipes: repository.validationRecipes.length,
          states: repository.toolchains.map((entry) => entry.state).sort(),
        },
      ),
    );
  }
  return createCompilerValidationReport("request", violations);
}

function compilerRepositoryCaptureFacts(
  context: Pick<CompilationContext, "runPolicy" | "repositoryCapturePlanning">,
  repository: ReturnType<typeof compilerCapabilitiesForRepository>,
): CompilerRepositoryCaptureFacts {
  const policy = context.runPolicy.repositoryCaptureEgress;
  const localAdapters = new Set(
    context.repositoryCapturePlanning.execution.localManagedRuntimeAdapterIds,
  );
  const isolatedBackendIds = [
    ...new Set(context.repositoryCapturePlanning.execution.isolatedBackendIds),
  ].sort();
  const captureRecipes = repository.validationRecipes.filter(
    ({ capture }) => capture?.kind === "capture",
  );
  return {
    execution: {
      commands: captureRecipes.map((recipe) => ({
        recipeId: recipe.id,
        local:
          recipe.adapterId !== null && localAdapters.has(recipe.adapterId)
            ? { managedRuntimeReceiptRequired: true as const }
            : null,
        isolatedBackendIds,
      })),
    },
    egress: {
      policyDigest: compilerEvalDigest(policy),
      deterministicGateIds: [...policy.deterministicGateIds],
      review: structuredClone(policy.review),
    },
    reviewer: context.repositoryCapturePlanning.reviewerCapability
      ? structuredClone(context.repositoryCapturePlanning.reviewerCapability)
      : null,
    comparators: structuredClone(repository.repositoryComparators),
    deterministicGates: repository.deterministicCaptureGates.filter(({ id }) =>
      policy.deterministicGateIds.includes(id),
    ),
  };
}

export interface CompilerProjectionTrace {
  protocol: "clockgrove.factory/compiler-projection";
  requestDigest: string;
  proposalDigest: string;
  graphDigest: string;
  addedEdges: Array<{
    itemId: string;
    dependsOn: string;
    reason: "scope-overlap" | "exclusive-resource" | "media-input";
  }>;
  adapterBindings: Array<{
    itemId: string;
    adapterId: string;
    providerWorkItem: string;
    operation: { kind: string; key: string };
  }>;
  mediaIntents: Array<{
    intentId: string;
    disposition: "imported" | "producer" | "repository-capture" | "omitted-helpful";
    producerWorkItemId: string | null;
  }>;
  riskElevations: {
    count: number;
    digest: string;
  };
}

export interface PreparedCompilerRequest {
  request: CompilerRequest;
  pinnedFacts: PinnedRepositoryFacts;
  report: CompilerValidationReport;
  legacyGraphConstraints?: LegacyGraphConstraints;
}

interface CompilerProjectionFacts {
  files: Array<{ path: string; generated: boolean; binary: boolean }>;
}

export interface CompilerProjectionContext {
  pinnedFacts: PinnedRepositoryFacts;
  runPolicy: RunPolicy;
  repositoryCapturePlanning?: CompilationContext["repositoryCapturePlanning"];
  mediaPlanning?: {
    assetBindings: Array<{ assetId: string; input: WorkerAssetInput }>;
    producerCapabilities: CompilerMediaProducerCapability[];
    reviewRules: CompilerRequest["media"]["reviewRules"];
  };
}

type CompilerValidationSurfacePaths = {
  deterministicSimulation: string[];
  python: string[];
  rust: string[];
  go: string[];
};

function compilerValidationSurfacePaths(
  pathsInput: readonly string[],
): CompilerValidationSurfacePaths {
  const paths = [...new Set(pathsInput)].sort();
  return {
    deterministicSimulation: paths.filter((path) =>
      /(?:simulation|simulator|replay|seed)/.test(path.toLowerCase()),
    ),
    python: paths.filter((path) => path === "pyproject.toml" || path.endsWith(".py")),
    rust: paths.filter((path) => path === "Cargo.toml" || path.endsWith(".rs")),
    go: paths.filter((path) => path === "go.mod" || path.endsWith(".go")),
  };
}

export function summarizeCompilerValidationSurfaces(paths: readonly string[]) {
  const surfaces = compilerValidationSurfacePaths(paths);
  return Object.fromEntries(
    Object.entries(surfaces).map(([name, values]) => [
      name,
      {
        count: values.length,
        digest: compilerEvalDigest(values),
        sample: values.slice(0, 32),
      },
    ]),
  ) as {
    [K in keyof CompilerValidationSurfacePaths]: {
      count: number;
      digest: string;
      sample: string[];
    };
  };
}

export function assertCompilerProjectionAuthority(
  request: CompilerRequest,
  context: CompilerProjectionContext,
): void {
  if (!context) throw new Error("compiler projection authority is required");
  const { pinnedFacts, runPolicy } = context;
  const { digest: pinnedDigest, ...unsignedPinnedFacts } = pinnedFacts;
  if (
    pinnedDigest !== compilerEvalDigest(unsignedPinnedFacts) ||
    pinnedFacts.baseSha !== request.baseSha ||
    pinnedFacts.relevantPaths.length !== request.repository.pathCount ||
    compilerEvalDigest(pinnedFacts.manifests) !==
      compilerEvalDigest(request.repository.manifests) ||
    compilerEvalDigest([...new Set(pinnedFacts.repository.lfs?.requiredTools ?? [])].sort()) !==
      compilerEvalDigest(request.repository.requiredTools)
  )
    throw new Error("pinned repository facts differ from the compiler request");
  const expectedCapabilities = compilerCapabilitiesForRepository(
    pinnedFacts,
    request.constraints.allowedNetworkDestinations,
  );
  if (
    compilerEvalDigest({
      validationRecipes: expectedCapabilities.validationRecipes,
      toolchains: expectedCapabilities.toolchains,
    }) !==
    compilerEvalDigest({
      validationRecipes: request.repository.validationRecipes,
      toolchains: request.repository.toolchains,
    })
  )
    throw new Error("compiler request capabilities differ from pinned adapter facts");
  if (
    compilerEvalDigest(
      compilerRepositoryCaptureFacts(
        {
          runPolicy,
          repositoryCapturePlanning:
            context.repositoryCapturePlanning ?? EMPTY_REPOSITORY_CAPTURE_PLANNING,
        },
        expectedCapabilities,
      ),
    ) !== compilerEvalDigest(request.repositoryCapture)
  )
    throw new Error("repository capture authority differs from the compiler request");
  if (
    compilerEvalDigest(summarizeCompilerValidationSurfaces(pinnedFacts.relevantPaths)) !==
    compilerEvalDigest(request.repository.validationSurfaces)
  )
    throw new Error("compiler request surface summary differs from pinned repository facts");
  if (
    runPolicy.workItemTimeoutMinutes !== request.constraints.workItemTimeoutMinutes ||
    compilerEvalDigest([...runPolicy.allowedNetworkDestinations].sort()) !==
      compilerEvalDigest([...request.constraints.allowedNetworkDestinations].sort())
  )
    throw new Error("run policy differs from the compiler request constraints");
  const egress = runPolicy.compilerMediaEgress;
  if (
    request.media.assetEgress.mode !== egress.mode ||
    request.media.assetEgress.policyDigest !== compilerEvalDigest(egress)
  )
    throw new Error("compiler media egress differs from immutable run policy");
  if (context.mediaPlanning) {
    const bindingIds = context.mediaPlanning.assetBindings.map((entry) => entry.assetId).sort();
    if (request.media.assetManifest) {
      const requestIds = request.media.assetManifest.assets.map((asset) => asset.id).sort();
      if (compilerEvalDigest(requestIds) !== compilerEvalDigest(bindingIds))
        throw new Error("compiler asset bindings differ from the manifest view");
      if (
        context.mediaPlanning.assetBindings.some(
          ({ input }) => input.manifestDigest !== request.media.assetManifest!.digest,
        )
      )
        throw new Error("compiler asset binding differs from its manifest digest");
    } else if (bindingIds.length > 0) {
      throw new Error("compiler asset bindings lack their manifest view");
    }
    if (
      compilerEvalDigest(context.mediaPlanning.producerCapabilities) !==
        compilerEvalDigest(request.media.producerCapabilities) ||
      compilerEvalDigest(context.mediaPlanning.reviewRules) !==
        compilerEvalDigest(request.media.reviewRules)
    )
      throw new Error("compiler media capability authority differs from the request");
  } else if (
    request.media.assetManifest !== null ||
    request.media.producerCapabilities.length > 0 ||
    request.media.reviewRules.length > 0
  ) {
    throw new Error("compiler request contains media authority absent from projection context");
  }
}

function normalizeCompilerProjectionFacts(
  files: readonly { path: string; generated?: boolean; binary?: boolean }[],
): CompilerProjectionFacts {
  if (files.length > 10_000) throw new Error("compiler projection file inventory exceeds bound");
  const paths = new Set<string>();
  const normalized = files.map((file) => {
    const path = RepositoryScopePathSchema.parse(file.path);
    if (paths.has(path)) throw new Error(`duplicate compiler projection path: ${path}`);
    paths.add(path);
    return { path, generated: file.generated === true, binary: file.binary === true };
  });
  return { files: normalized.sort((left, right) => left.path.localeCompare(right.path)) };
}

function compilerProjectionFactsFromPinned(
  pinnedFacts: PinnedRepositoryFacts,
): CompilerProjectionFacts {
  return normalizeCompilerProjectionFacts(pinnedFacts.repository.files);
}

const pointer = (...parts: Array<string | number>) =>
  parts.length
    ? `/${parts
        .map(String)
        .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")}`
    : "";

const violation = (
  code: CompilerViolation["code"],
  field: string,
  expected: CompilerDiagnosticValue,
  observed: CompilerDiagnosticValue,
  itemId: string | null = null,
): CompilerViolation => ({ code, itemId, field, expected, observed });

function schemaViolations(
  error: {
    issues: Array<{ path: PropertyKey[]; code: string; message: string }>;
  },
  input?: unknown,
) {
  return error.issues.map((issue) => {
    const path = issue.path.map(String);
    const code =
      path.at(-1) === "scope" || path.includes("scope")
        ? "invalid-scope"
        : path.at(-1) === "workItems" && issue.code === "too_big"
          ? "work-item-count"
          : path.includes("criteria") && path.at(-1) === "validation"
            ? "uncovered-criterion"
            : "schema-invalid";
    const itemIndex =
      path[0] === "workItems" && /^\d+$/.test(path[1] ?? "") ? Number(path[1]) : null;
    const candidate =
      itemIndex !== null && input && typeof input === "object" && "workItems" in input
        ? (input as { workItems?: unknown[] }).workItems?.[itemIndex]
        : null;
    const itemId =
      candidate &&
      typeof candidate === "object" &&
      "id" in candidate &&
      typeof candidate.id === "string" &&
      candidate.id.length <= 64 &&
      /^[a-z0-9][a-z0-9-]*$/.test(candidate.id)
        ? candidate.id
        : null;
    return violation(code, pointer(...path), { contract: "strict" }, { issue: issue.code }, itemId);
  });
}

export function validateCompilerRequest(requestInput: unknown): CompilerValidationReport {
  const parsed = CompilerRequestSchema.safeParse(requestInput);
  if (!parsed.success)
    return createCompilerValidationReport("request", schemaViolations(parsed.error, requestInput));
  const request = parsed.data;
  const violations: CompilerViolation[] = [];
  const requestBytes = Buffer.byteLength(JSON.stringify(request));
  if (requestBytes > MAX_COMPILER_REQUEST_BYTES)
    violations.push(
      violation(
        "compiler-request-limit",
        "",
        { maximumBytes: MAX_COMPILER_REQUEST_BYTES },
        requestBytes,
      ),
    );
  if (
    request.objective.digest !==
    compilerEvalDigest({
      number: request.objective.number,
      title: request.objective.title,
      body: request.objective.body,
    })
  )
    violations.push(
      violation(
        "schema-invalid",
        "/objective/digest",
        { derivedFrom: ["number", "title", "body"] },
        request.objective.digest,
      ),
    );
  if (
    request.revision > 0 &&
    request.validationReport.status === "valid" &&
    request.semanticFindings.length === 0
  )
    violations.push(
      violation(
        "schema-invalid",
        "/revision",
        "a typed mechanical report or semantic findings",
        request.revision,
      ),
    );
  if (
    request.inventory.objectiveDigest !== request.objective.digest ||
    request.inventory.baseSha !== request.baseSha
  )
    violations.push(
      violation(
        "schema-invalid",
        "/inventory",
        { objectiveDigest: request.objective.digest, baseSha: request.baseSha },
        {
          objectiveDigest: request.inventory.objectiveDigest,
          baseSha: request.inventory.baseSha,
        },
      ),
    );
  if (
    request.revision === 0 &&
    (request.previousProposal !== null ||
      request.validationReport.status !== "valid" ||
      request.validationReport.violations.length !== 0 ||
      request.semanticFindings.length !== 0 ||
      request.challenges.length !== 0)
  )
    violations.push(
      violation(
        "schema-invalid",
        "/revision",
        request.revision === 0 ? "initial request envelope" : "repair request envelope",
        request.revision,
      ),
    );
  const recipes = request.repository.validationRecipes;
  const commandIdentities = new Map<string, Set<string>>();
  const recipeIdentities = new Map<string, Set<string>>();
  for (const recipe of recipes) {
    const phase = recipe.capture?.kind ?? "ordinary";
    const identity = compilerEvalDigest(recipe);
    const byCommand = commandIdentities.get(recipe.command) ?? new Set<string>();
    byCommand.add(`${phase}\0${recipe.id}\0${identity}`);
    commandIdentities.set(recipe.command, byCommand);
    const byId = recipeIdentities.get(recipe.id) ?? new Set<string>();
    byId.add(identity);
    recipeIdentities.set(recipe.id, byId);
  }
  for (const [command, identities] of commandIdentities)
    if (identities.size > 1)
      violations.push(
        violation(
          "schema-invalid",
          "/repository/validationRecipes",
          "one phase and recipe identity per command text",
          command,
        ),
      );
  for (const [id, identities] of recipeIdentities)
    if (identities.size > 1)
      violations.push(
        violation(
          "schema-invalid",
          "/repository/validationRecipes",
          "one recipe value per identity",
          id,
        ),
      );
  const captureRecipeIds = recipes
    .filter(({ capture }) => capture?.kind === "capture")
    .map(({ id }) => id);
  const executionRecipeIds = request.repositoryCapture.execution.commands.map(
    ({ recipeId }) => recipeId,
  );
  if (
    compilerEvalDigest([...captureRecipeIds].sort()) !==
    compilerEvalDigest([...executionRecipeIds].sort())
  )
    violations.push(
      violation(
        "schema-invalid",
        "/repositoryCapture/execution/commands",
        [...captureRecipeIds].sort(),
        [...executionRecipeIds].sort(),
      ),
    );
  if (
    request.repositoryCapture.egress.policyDigest !==
    compilerEvalDigest({
      deterministicGateIds: request.repositoryCapture.egress.deterministicGateIds,
      review: request.repositoryCapture.egress.review,
    })
  )
    violations.push(
      violation(
        "schema-invalid",
        "/repositoryCapture/egress/policyDigest",
        "digest of the exact repository capture egress policy",
        request.repositoryCapture.egress.policyDigest,
      ),
    );
  for (const [index, comparator] of request.repositoryCapture.comparators.entries()) {
    const capture = recipes.find(({ id }) => id === comparator.captureRecipeId);
    if (
      capture?.capture?.kind !== "capture" ||
      compilerEvalDigest(capture) !== comparator.captureRecipeDigest
    )
      violations.push(
        violation(
          "schema-invalid",
          `/repositoryCapture/comparators/${index}`,
          "an installed comparator policy bound to its exact capture recipe",
          comparator,
        ),
      );
  }
  for (const [index, gate] of request.repositoryCapture.deterministicGates.entries()) {
    const capture = recipes.find(({ id }) => id === gate.captureRecipeId);
    const thresholdPolicyId =
      gate.comparison.kind === "threshold" ? gate.comparison.policyId : null;
    const comparator =
      thresholdPolicyId !== null
        ? request.repositoryCapture.comparators.find(
            ({ policy, captureRecipeId }) =>
              policy.id === thresholdPolicyId && captureRecipeId === gate.captureRecipeId,
          )
        : null;
    if (
      capture?.capture?.kind !== "capture" ||
      compilerEvalDigest(capture) !== gate.captureRecipeDigest ||
      (gate.comparison.kind === "threshold" &&
        (!comparator ||
          comparator.captureRecipeDigest !== gate.captureRecipeDigest ||
          compilerEvalDigest(comparator.policy) !== gate.comparison.policyDigest ||
          compilerEvalDigest(comparator.comparator) !==
            compilerEvalDigest(gate.comparison.comparator) ||
          comparator.policy.metric !== gate.comparison.metric ||
          comparator.policy.maximumDifference !== gate.comparison.maximumDifference))
    )
      violations.push(
        violation(
          "schema-invalid",
          `/repositoryCapture/deterministicGates/${index}`,
          "exact bound catalog recipes",
          gate.id,
        ),
      );
  }
  const captureAuthority = evaluateBoundRepositoryCaptureCapabilities({
    validationRecipes: request.repository.validationRecipes,
    repositoryComparators: request.repositoryCapture.comparators,
    deterministicCaptureGates: request.repositoryCapture.deterministicGates,
  });
  for (const diagnostic of captureAuthority.report.diagnostics)
    violations.push(
      violation(
        "schema-invalid",
        `/repositoryCapture/catalog${diagnostic.field}`,
        {
          diagnostic: diagnostic.code,
          capability: diagnostic.expected as CompilerDiagnosticValue,
        },
        diagnostic.observed as CompilerDiagnosticValue,
      ),
    );
  violations.push(
    ...validateCompilerRepositoryAuthority(
      request.repository,
      request.constraints.allowedNetworkDestinations,
    ).violations,
  );
  return createCompilerValidationReport("request", violations);
}

export async function prepareCompilerRequest(input: {
  context: CompilationContext;
  inventory: ObligationInventory;
  inventorySource?: CompilerRequest["inventorySource"];
  revision?: number;
  previousProposal?: CompilerProposalValue | null;
  validationReport?: CompilerValidationReport;
  semanticFindings?: CompilerJudgeFinding[];
  challenges?: CompilerInferenceChallenge[];
  pinnedFacts?: PinnedRepositoryFacts;
}): Promise<PreparedCompilerRequest> {
  const { context } = input;
  const pinnedFacts =
    input.pinnedFacts ??
    (await readPinnedCompilerFacts(
      context.repository,
      context.baseSha,
      context.repositoryFiles,
      context.repositoryLfs,
    ));
  const repository = compilerCapabilitiesForRepository(
    pinnedFacts,
    context.allowedNetworkDestinations,
  );
  const repositoryCapture = compilerRepositoryCaptureFacts(context, repository);
  const revision = input.revision ?? 0;
  const planning = context.runPolicy.objectivePlanning;
  const mediaEgress = context.runPolicy.compilerMediaEgress;
  const mediaEgressDigest = compilerEvalDigest(mediaEgress);
  if (context.mediaPlanning) {
    if (
      context.mediaPlanning.assetEgress.mode !== mediaEgress.mode ||
      context.mediaPlanning.assetEgress.policyDigest !== mediaEgressDigest
    )
      throw new Error("compiler media asset egress differs from immutable run policy");
    if ((context.mediaPlanning.assetManifest?.assets.length ?? 0) > mediaEgress.maxAssets)
      throw new Error("compiler media asset count exceeds immutable egress policy");
    if (
      mediaEgress.mode === "public-assets" &&
      context.mediaPlanning.assetManifest?.assets.some((asset) => asset.visibility !== "public")
    )
      throw new Error("private Objective asset is not permitted by compiler media egress policy");
  }
  const adopted = context.legacyGraphConstraints !== undefined;
  const request = CompilerRequestSchema.parse({
    protocol: "clockgrove.factory/compiler-request",
    revision,
    objective: {
      ...context.objective,
      digest: compilerEvalDigest(context.objective),
    },
    baseSha: context.baseSha,
    inventory: ObligationInventorySchema.parse(input.inventory),
    inventorySource: input.inventorySource ?? "independent-extraction",
    repository: {
      manifests: pinnedFacts.manifests,
      requiredTools: [...new Set(pinnedFacts.repository.lfs?.requiredTools ?? [])].sort(),
      validationRecipes: repository.validationRecipes,
      toolchains: repository.toolchains,
      validationSurfaces: summarizeCompilerValidationSurfaces(pinnedFacts.relevantPaths),
      pathCount: pinnedFacts.relevantPaths.length,
    },
    media: context.mediaPlanning
      ? {
          assetManifest: context.mediaPlanning.assetManifest,
          assetEgress: context.mediaPlanning.assetEgress,
          producerCapabilities: context.mediaPlanning.producerCapabilities,
          reviewRules: context.mediaPlanning.reviewRules,
        }
      : {
          assetManifest: null,
          assetEgress: { mode: mediaEgress.mode, policyDigest: mediaEgressDigest },
          producerCapabilities: [],
          reviewRules: [],
        },
    repositoryCapture,
    constraints: {
      maxWorkItems: context.legacyGraphConstraints?.workItems.length ?? 100,
      planningWorkItemThreshold: adopted ? 100 : (planning?.maxWorkItemsPerObjective ?? 100),
      planningCriticalPathMinutes:
        adopted || !planning
          ? 30 * 24 * 60
          : context.runPolicy.objectiveTimeoutMinutes * planning.maxCriticalPathRatio,
      planningAggregateWorkMinutes:
        adopted || !planning
          ? 300 * 24 * 60
          : context.runPolicy.objectiveTimeoutMinutes * planning.maxAggregateWorkRatio,
      maxDependenciesPerItem: 50,
      allowedNetworkDestinations: [...new Set(context.allowedNetworkDestinations)].sort(),
      workItemTimeoutMinutes: context.runPolicy.workItemTimeoutMinutes,
    },
    previousProposal: input.previousProposal ?? null,
    validationReport: input.validationReport ?? emptyCompilerValidationReport(),
    semanticFindings: input.semanticFindings ?? [],
    challenges: input.challenges ?? [],
  });
  const report = validateCompilerRequest(request);
  return {
    request,
    pinnedFacts,
    report,
    ...(context.legacyGraphConstraints
      ? { legacyGraphConstraints: context.legacyGraphConstraints }
      : {}),
  };
}

function validationCommand(
  request: CompilerRequest,
  reference: ValidationIntentRef,
): string | null {
  if (reference.kind === "observed")
    return (
      request.repository.validationRecipes.find((recipe) => recipe.id === reference.recipeId)
        ?.command ?? null
    );
  if (reference.kind === "scoped-node-test") return scopedNodeTestCommand(reference.targets);
  return formatCompilerOperation(reference.adapterId, reference.operation);
}

function resolvedExecutionRequirements(
  request: CompilerRequest,
  proposal: CompilerProposal,
  item: CompilerProposal["workItems"][number],
) {
  const references = item.criteria.flatMap((criterion) =>
    criterion.validation.flatMap((validation) => validation.evidence),
  );
  const captureRecipeIds = proposal.mediaIntents.flatMap((intent) => {
    if (!intent.repositoryCapture) return [];
    if (!intent.bindings.some((binding) => binding.workItemId === item.id)) return [];
    if (repositoryCaptureUnavailableReasons(request, proposal, intent).length > 0) return [];
    return [intent.repositoryCapture.captureRecipeId];
  });
  const recipes = [
    ...references.flatMap((reference) =>
      reference.kind === "observed"
        ? request.repository.validationRecipes.filter((recipe) => recipe.id === reference.recipeId)
        : reference.kind === "scoped-node-test"
          ? request.repository.validationRecipes.filter(
              (recipe) => recipe.command === "node --test",
            )
          : [],
    ),
    ...request.repository.validationRecipes.filter((recipe) =>
      captureRecipeIds.includes(recipe.id),
    ),
  ];
  const deferred = references.flatMap((reference) =>
    reference.kind === "deferred"
      ? request.repository.toolchains.filter(
          (toolchain) => toolchain.adapterId === reference.adapterId,
        )
      : [],
  );
  return {
    tools: [
      ...new Set([
        ...request.repository.requiredTools,
        ...recipes.flatMap((recipe) => recipe.requiredTools),
        ...deferred.flatMap((capability) => capability.requiredTools),
        ...item.executionIntent.additionalTools,
      ]),
    ].sort(),
    networkDestinations: [
      ...new Set([
        ...recipes.flatMap((recipe) => recipe.networkDestinations),
        ...deferred.flatMap((capability) => capability.networkDestinations),
        ...item.executionIntent.additionalNetworkDestinations,
      ]),
    ].sort(),
  };
}

function resolvedExclusiveResources(
  projectionFacts: CompilerProjectionFacts,
  item: CompilerProposal["workItems"][number],
): string[] {
  const scopedFiles = projectionFacts.files.filter((file) =>
    item.scope.some((path) =>
      path.endsWith("/") ? file.path.startsWith(path) : file.path === path,
    ),
  );
  const generated =
    scopedFiles.some((file) => file.generated) ||
    item.scope.some((path) => /(^|\/)(?:dist|build|generated)\//.test(path));
  const binary =
    scopedFiles.some((file) => file.binary) ||
    item.scope.some((path) => /\.(?:png|jpe?g|zip|wasm|pdf)$/i.test(path));
  return [
    ...new Set([
      ...item.exclusiveResources,
      ...(generated || binary
        ? scopedFiles.length
          ? scopedFiles.map((file) => file.path)
          : item.scope
        : []),
    ]),
  ].sort();
}

function criterionHasDeterministicValidation(
  criterion: CompilerProposal["workItems"][number]["criteria"][number],
) {
  return criterion.validation.some(
    (entry) => entry.tier === "mechanical" || entry.tier === "deterministic-simulation",
  );
}

const intentFulfillmentAssetIds = (intent: MediaIntent) =>
  intent.fulfillment.kind === "imported" ? intent.fulfillment.assetIds : [];
const intentProducerInputAssetIds = (intent: MediaIntent) =>
  intent.fulfillment.kind === "produced"
    ? intent.fulfillment.inputRoleBindings.flatMap(({ importedAssetIds }) => importedAssetIds)
    : [];
const intentInputIntentIds = (intent: MediaIntent) =>
  intent.fulfillment.kind === "produced"
    ? intent.fulfillment.inputRoleBindings.flatMap(({ inputIntentIds }) => inputIntentIds)
    : [];

function mediaCapabilitySupports(
  request: CompilerRequest,
  proposal: CompilerProposal,
  capability: CompilerMediaProducerCapability,
  intent: MediaIntent,
): boolean {
  const output = intent.output;
  const raster = output.profile;
  const capabilityRaster = capability.raster;
  const intentById = new Map(proposal.mediaIntents.map((entry) => [entry.id, entry]));
  const importedById = new Map(
    (request.media.assetManifest?.assets ?? []).map((asset) => [asset.id, asset]),
  );
  if (intent.fulfillment.kind !== "produced") return false;
  const inputRoleBindings = intent.fulfillment.inputRoleBindings;
  const rolesMatch =
    inputRoleBindings.every((binding) => {
      if (binding.inputIntentIds.length > 1) return false;
      const role = capability.inputRoles.find(({ id }) => id === binding.roleId);
      if (!role) return false;
      const imported = binding.importedAssetIds.map((id) => importedById.get(id));
      if (imported.some((asset) => !asset || !role.mediaTypes.includes(asset.mediaType)))
        return false;
      const produced = binding.inputIntentIds.map((id) => intentById.get(id));
      if (
        produced.some(
          (source) =>
            !source ||
            !source.output.mediaTypes.some((mediaType) => role.mediaTypes.includes(mediaType)),
        )
      )
        return false;
      const minimumCount = imported.length + produced.length;
      const maximumCount =
        imported.length +
        produced.reduce((total, source) => total + (source?.output.maximumCount ?? 32), 0);
      return minimumCount <= role.maximumCount && maximumCount >= role.minimumCount;
    }) &&
    capability.inputRoles.every(
      (role) =>
        role.minimumCount === 0 || inputRoleBindings.some((binding) => binding.roleId === role.id),
    );
  return (
    intent.bindings.every(({ direction }) => direction === "input-to") &&
    capability.roles.includes(intent.role) &&
    capability.purposes.includes(intent.purpose) &&
    output.mediaTypes.some((mediaType) => capability.mediaTypes.includes(mediaType)) &&
    rolesMatch &&
    output.minimumCount <= capability.maximumCount &&
    (raster === null ||
      (capabilityRaster !== null &&
        (raster.minimumWidth === null || raster.minimumWidth <= capabilityRaster.maximumWidth) &&
        (raster.minimumHeight === null || raster.minimumHeight <= capabilityRaster.maximumHeight) &&
        (raster.alpha !== "required" || capabilityRaster.supportsAlpha) &&
        (raster.animation !== "required" || capabilityRaster.supportsAnimation)))
  );
}

function activationSelectionForIntent(
  request: CompilerRequest,
  proposal: CompilerProposal,
  source: MediaIntent,
) {
  let minimumCount = 1;
  let maximumCount = source.output.maximumCount;
  for (const consumer of proposal.mediaIntents) {
    if (consumer.fulfillment.kind !== "produced") continue;
    const capability = [...request.media.producerCapabilities]
      .filter((candidate) => mediaCapabilitySupports(request, proposal, candidate, consumer))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!capability) continue;
    for (const binding of consumer.fulfillment.inputRoleBindings) {
      if (!binding.inputIntentIds.includes(source.id)) continue;
      const role = capability.inputRoles.find(({ id }) => id === binding.roleId);
      if (!role) continue;
      const importedCount = binding.importedAssetIds.length;
      minimumCount = Math.max(minimumCount, role.minimumCount - importedCount, 1);
      maximumCount = Math.min(maximumCount, role.maximumCount - importedCount);
    }
  }
  return { minimumCount, maximumCount };
}

function importedAssetsSatisfyMediaIntent(request: CompilerRequest, intent: MediaIntent): boolean {
  if (
    intent.fulfillment.kind !== "imported" ||
    intentFulfillmentAssetIds(intent).length === 0 ||
    !request.media.assetManifest ||
    intent.bindings.some((binding) => binding.direction !== "input-to")
  )
    return false;
  const byId = new Map(request.media.assetManifest.assets.map((asset) => [asset.id, asset]));
  const assets = intentFulfillmentAssetIds(intent)
    .map((id) => byId.get(id))
    .filter((asset) => asset);
  if (
    assets.length !== intentFulfillmentAssetIds(intent).length ||
    assets.length < intent.output.minimumCount ||
    assets.length > intent.output.maximumCount
  )
    return false;
  const permittedMediaTypes = new Set<string>(intent.output.mediaTypes);
  return assets.every((asset) => {
    if (!asset || !permittedMediaTypes.has(asset.mediaType)) return false;
    return rasterInspectionSatisfies(asset.inspection, intent.output.profile);
  });
}

function rasterInspectionSatisfies(
  inspection:
    | { kind: "raster"; width: number; height: number; frames: number; alpha: boolean }
    | {
        kind: "opaque";
      },
  constraints: MediaIntent["output"]["profile"],
): boolean {
  if (constraints === null) return true;
  if (inspection.kind !== "raster") return false;
  if (constraints.minimumWidth !== null && inspection.width < constraints.minimumWidth)
    return false;
  if (constraints.maximumWidth !== null && inspection.width > constraints.maximumWidth)
    return false;
  if (constraints.minimumHeight !== null && inspection.height < constraints.minimumHeight)
    return false;
  if (constraints.maximumHeight !== null && inspection.height > constraints.maximumHeight)
    return false;
  if (constraints.alpha === "required" && inspection.alpha !== true) return false;
  if (constraints.alpha === "forbidden" && inspection.alpha !== false) return false;
  if (constraints.animation === "required" && inspection.frames <= 1) return false;
  if (constraints.animation === "forbidden" && inspection.frames !== 1) return false;
  return true;
}

function dimensionsSatisfy(
  dimensions: { width: number; height: number },
  constraints: NonNullable<MediaIntent["output"]["profile"]>,
): boolean {
  return (
    (constraints.minimumWidth === null || dimensions.width >= constraints.minimumWidth) &&
    (constraints.maximumWidth === null || dimensions.width <= constraints.maximumWidth) &&
    (constraints.minimumHeight === null || dimensions.height >= constraints.minimumHeight) &&
    (constraints.maximumHeight === null || dimensions.height <= constraints.maximumHeight)
  );
}

function canonicalMediaIntent(intent: MediaIntent): MediaIntent {
  const fulfillment =
    intent.fulfillment.kind === "imported"
      ? { kind: "imported" as const, assetIds: [...intent.fulfillment.assetIds].sort() }
      : {
          kind: "produced" as const,
          inputRoleBindings: intent.fulfillment.inputRoleBindings
            .map((binding) => ({
              ...binding,
              importedAssetIds: [...binding.importedAssetIds].sort(),
              inputIntentIds: [...binding.inputIntentIds].sort(),
            }))
            .sort((left, right) => left.roleId.localeCompare(right.roleId)),
        };
  return {
    ...intent,
    obligationIds: [...intent.obligationIds].sort(),
    fulfillment,
    output: { ...intent.output, mediaTypes: [...intent.output.mediaTypes].sort() },
    bindings: intent.bindings
      .map((binding) => ({ ...binding, criterionIds: [...binding.criterionIds].sort() }))
      .sort(
        (left, right) =>
          left.workItemId.localeCompare(right.workItemId) ||
          left.direction.localeCompare(right.direction) ||
          JSON.stringify(left.criterionIds).localeCompare(JSON.stringify(right.criterionIds)),
      ),
  };
}

function captureCommandRoutes(
  request: CompilerRequest,
  recipeIds: readonly string[],
): { local: boolean; isolatedBackendIds: string[] } {
  const authorities = recipeIds
    .map((recipeId) =>
      request.repositoryCapture.execution.commands.find((entry) => entry.recipeId === recipeId),
    )
    .filter(
      (entry): entry is CompilerRequest["repositoryCapture"]["execution"]["commands"][number] =>
        entry !== undefined,
    );
  if (authorities.length !== recipeIds.length) return { local: false, isolatedBackendIds: [] };
  const local = authorities.every((entry) => entry?.local !== null);
  const [first, ...rest] = authorities.map(
    ({ isolatedBackendIds }) => new Set<string>(isolatedBackendIds),
  );
  const isolatedBackendIds = [...(first ?? new Set<string>())]
    .filter((backendId) => rest.every((set) => set.has(backendId)))
    .sort();
  return { local, isolatedBackendIds };
}

function humanCaptureReviewAssetCount(
  request: CompilerRequest,
  proposal: CompilerProposal,
  workItemId: string,
): number {
  const expected = new Set<string>();
  const observed = new Set<string>();
  for (const candidate of proposal.mediaIntents) {
    const capture = candidate.repositoryCapture;
    if (!capture || capture.gate.kind !== "human-required") continue;
    if (!candidate.bindings.some((binding) => binding.workItemId === workItemId)) continue;
    expected.add(capture.expectedAssetId);
    const recipe = request.repository.validationRecipes.find(
      ({ id }) => id === capture.captureRecipeId,
    );
    if (recipe?.capture?.kind !== "capture") continue;
    for (const { roleId } of recipe.capture.outputs) observed.add(`${candidate.id}\0${roleId}`);
  }
  return expected.size + observed.size;
}

function proposalWithRepositoryCaptureCandidate(
  proposal: CompilerProposal,
  intent: MediaIntent,
): CompilerProposal {
  const boundWorkItems = new Set(intent.bindings.map(({ workItemId }) => workItemId));
  return {
    ...proposal,
    mediaIntents: [
      ...proposal.mediaIntents.filter(
        (candidate) =>
          candidate.id !== intent.id &&
          (!candidate.repositoryCapture ||
            !candidate.bindings.some(({ workItemId }) => boundWorkItems.has(workItemId))),
      ),
      intent,
    ],
  };
}

function repositoryCaptureAuthorityReasons(
  request: CompilerRequest,
  proposal: CompilerProposal,
  intent: MediaIntent,
): string[] {
  if (!intent.repositoryCapture) return [];
  const captureRequest = intent.repositoryCapture;
  const reasons: string[] = [];
  const expected = request.media.assetManifest?.assets.find(
    ({ id }) => id === captureRequest.expectedAssetId,
  );
  if (intent.review !== null)
    reasons.push("repository capture cannot reuse producer review authority");
  if (intent.output.minimumCount !== 1 || intent.output.maximumCount !== 1)
    reasons.push("repository capture requires exactly one comparison subject");
  if (!expected) reasons.push(`expected asset ${captureRequest.expectedAssetId} is unavailable`);
  else if (!intent.output.mediaTypes.includes(expected.mediaType))
    reasons.push(`expected asset MIME ${expected.mediaType} is outside the capture contract`);
  const captureRecipe = request.repository.validationRecipes.find(
    ({ id }) => id === captureRequest.captureRecipeId,
  );
  if (captureRecipe?.capture?.kind !== "capture") {
    reasons.push(`capture recipe ${captureRequest.captureRecipeId} is unavailable`);
    return reasons;
  }
  const capture = captureRecipe.capture;
  const subject = capture.outputs.find(({ roleId }) => roleId === capture.comparisonOutputRoleId);
  if (!subject) reasons.push("capture comparison subject role is not a declared output");
  else {
    if (!intent.output.mediaTypes.includes(subject.mediaType))
      reasons.push(`comparison subject MIME ${subject.mediaType} is outside the capture contract`);
    if (expected && subject.mediaType !== expected.mediaType)
      reasons.push(
        `comparison subject MIME ${subject.mediaType} differs from expected asset MIME ${expected.mediaType}`,
      );
  }
  if ((intent.output.profile?.kind ?? null) !== (capture.profile?.kind ?? null))
    reasons.push("capture recipe does not support the requested typed profile");
  const constraints = intent.output.profile;
  const profile = capture.profile;
  if (constraints && profile?.kind === "raster") {
    if (profile.output && !dimensionsSatisfy(profile.output, constraints))
      reasons.push("capture recipe exact output dimensions are outside the capture contract");
    if (expected && !rasterInspectionSatisfies(expected.inspection, constraints))
      reasons.push("expected asset inspection is outside the raster capture contract");
    if (
      expected?.inspection.kind === "raster" &&
      profile.output &&
      (expected.inspection.width !== profile.output.width ||
        expected.inspection.height !== profile.output.height)
    )
      reasons.push("expected asset dimensions differ from the capture recipe exact output");
  }
  if (captureRequest.comparison.kind === "threshold") {
    const policyId = captureRequest.comparison.policyId;
    if (
      !request.repositoryCapture.comparators.some(
        ({ policy, captureRecipeId, captureRecipeDigest }) =>
          policy.id === policyId &&
          captureRecipeId === captureRecipe.id &&
          captureRecipeDigest === compilerEvalDigest(captureRecipe),
      )
    )
      reasons.push(`comparison policy ${policyId} is unavailable`);
  }
  const routes = captureCommandRoutes(request, [captureRecipe.id]);
  if (!routes.local && routes.isolatedBackendIds.length === 0)
    reasons.push("capture commands have no authorized local or isolated execution route");

  if (captureRequest.gate.kind === "human-required") {
    if (!capture.humanReview) reasons.push("capture recipe does not authorize human review");
    const reviewer = request.repositoryCapture.reviewer;
    if (!reviewer || request.repositoryCapture.egress.review.mode === "denied")
      reasons.push("semantic repository capture reviewer is unavailable");
    else {
      const types = [
        expected?.mediaType,
        ...capture.outputs.map(({ mediaType }) => mediaType),
      ].filter((mediaType): mediaType is string => Boolean(mediaType));
      const handlers = types.map((mediaType) => declaredAssetHandlerContract(mediaType));
      if (
        types.some((mediaType) => !reviewer.mediaTypes.includes(mediaType)) ||
        handlers.some(
          (handler) =>
            handler.descriptorClass !== "semantic" ||
            !reviewer.semanticHandlers.some(
              ({ id, contract }) => id === handler.id && contract === handler.contract,
            ),
        ) ||
        (expected &&
          (expected.descriptorClass !== "semantic" ||
            !reviewer.semanticHandlers.some(
              ({ id, contract }) =>
                id === expected.inspectionHandler.id &&
                contract === expected.inspectionHandler.contract,
            )))
      )
        reasons.push("semantic reviewer lacks the exact MIME or inspection handler");
      const outputProfiles = capture.outputs.map(({ roleId }) =>
        repositoryCaptureProfileForOutput(capture, roleId),
      );
      const typedProfileKinds = new Set(
        outputProfiles.flatMap((outputProfile) => (outputProfile ? [outputProfile.kind] : [])),
      );
      if (
        (outputProfiles.some((outputProfile) => outputProfile === null) &&
          !reviewer.allowUnprofiled) ||
        [...typedProfileKinds].some((kind) => !reviewer.profiles.includes(kind))
      )
        reasons.push("semantic reviewer lacks the exact capture profile");
      if (
        !reviewer.visibilities.includes("private") ||
        !reviewer.rightsBases.includes("unknown") ||
        (expected &&
          (!reviewer.visibilities.includes(expected.visibility) ||
            !reviewer.rightsBases.includes(expected.rightsBasis)))
      )
        reasons.push("semantic reviewer lacks the exact visibility or rights authority");
      const assetCount = Math.max(
        0,
        ...intent.bindings.map(({ workItemId }) =>
          humanCaptureReviewAssetCount(request, proposal, workItemId),
        ),
      );
      if (
        assetCount > reviewer.maximumAssets ||
        assetCount > request.repositoryCapture.egress.review.maxAssets
      )
        reasons.push(`deduplicated semantic review asset count ${assetCount} exceeds authority`);
      if (
        request.repositoryCapture.egress.review.mode === "public-assets" &&
        (expected?.visibility !== "public" || capture.outputs.length > 0)
      )
        reasons.push("private capture outputs are denied by public-only review egress");
    }
  } else {
    const authorityId = captureRequest.gate.authorityId;
    const gate = request.repositoryCapture.deterministicGates.find(({ id }) => id === authorityId);
    const profileId = capture.profile?.kind ?? "unprofiled";
    const criteria = new Set(intent.bindings.flatMap(({ criterionIds }) => criterionIds));
    const exactScenario = gate?.scenarios.some(
      (scenario) => compilerEvalDigest(scenario) === compilerEvalDigest(captureRequest.scenario),
    );
    const selectedPolicyId =
      captureRequest.comparison.kind === "threshold" ? captureRequest.comparison.policyId : null;
    const exactComparison =
      gate?.comparison.kind === captureRequest.comparison.kind &&
      (gate?.comparison.kind === "exact" ||
        (selectedPolicyId !== null && gate?.comparison.policyId === selectedPolicyId));
    if (
      !gate ||
      gate.captureRecipeId !== captureRecipe.id ||
      gate.captureRecipeDigest !== compilerEvalDigest(captureRecipe) ||
      !exactComparison ||
      !subject ||
      !gate.mediaTypes.includes(subject.mediaType) ||
      !gate.profiles.includes(profileId) ||
      !expected ||
      !gate.mediaTypes.includes(expected.mediaType) ||
      !gate.visibilities.includes(expected.visibility) ||
      !gate.rightsBases.includes(expected.rightsBasis) ||
      !gate.visibilities.includes("private") ||
      !gate.rightsBases.includes("unknown") ||
      !gate.expectedDescriptorClasses.includes(expected.descriptorClass) ||
      !exactScenario ||
      criteria.size === 0 ||
      criteria.size > gate.maximumCriteria
    )
      reasons.push(
        `deterministic capture authority ${authorityId} does not match the exact result contract`,
      );
  }
  return reasons;
}

function repositoryCaptureUnavailableReasons(
  request: CompilerRequest,
  proposal: CompilerProposal,
  intent: MediaIntent,
): string[] {
  const reasons = repositoryCaptureAuthorityReasons(request, proposal, intent);
  if (!intent.repositoryCapture) return reasons;
  const boundItems = new Set(intent.bindings.map(({ workItemId }) => workItemId));
  const registrations = new Map<string, Set<string>>();
  const register = (command: string, phase: string, identity: string) => {
    const identities = registrations.get(command) ?? new Set<string>();
    identities.add(`${phase}\0${identity}`);
    registrations.set(command, identities);
  };
  for (const item of proposal.workItems.filter(({ id }) => boundItems.has(id)))
    for (const criterion of item.criteria)
      for (const validation of criterion.validation)
        for (const reference of validation.evidence) {
          const command = validationCommand(request, reference);
          if (command) register(command, "ordinary", compilerEvalDigest(reference));
        }
  for (const candidate of proposal.mediaIntents) {
    const candidateCapture = candidate.repositoryCapture;
    if (!candidateCapture) continue;
    if (!candidate.bindings.some(({ workItemId }) => boundItems.has(workItemId))) continue;
    const selectedCapture = request.repository.validationRecipes.find(
      ({ id }) => id === candidateCapture.captureRecipeId,
    );
    if (selectedCapture) register(selectedCapture.command, "capture", selectedCapture.id);
  }
  for (const [command, identities] of registrations)
    if (identities.size > 1)
      reasons.push(`validation command ${command} has conflicting phase or recipe identity`);
  return reasons;
}

function repositoryCaptureCriterionBindings(
  request: CompilerRequest,
  proposal: CompilerProposal,
  workItemId: string,
  criterionId: string,
): Array<{ tier: "mechanical" | "semantic"; command: string }> {
  return proposal.mediaIntents.flatMap((intent) => {
    const capture = intent.repositoryCapture;
    if (!capture || repositoryCaptureUnavailableReasons(request, proposal, intent).length > 0)
      return [];
    const binding = intent.bindings.find(
      (candidate) =>
        candidate.workItemId === workItemId && candidate.criterionIds.includes(criterionId),
    );
    if (!binding) return [];
    const recipe = request.repository.validationRecipes.find(
      ({ id }) => id === capture.captureRecipeId,
    );
    if (recipe?.capture?.kind !== "capture") return [];
    return [
      {
        tier: capture.gate.kind === "deterministic-preauthorized" ? "mechanical" : "semantic",
        command: recipe.command,
      },
    ];
  });
}

function repositoryCaptureHasSatisfiableAuthority(
  request: CompilerRequest,
  proposal: CompilerProposal,
  intent: MediaIntent,
): boolean {
  const assets = request.media.assetManifest?.assets ?? [];
  const captures = request.repository.validationRecipes.filter(
    (recipe) => recipe.capture?.kind === "capture",
  );
  for (const expected of assets)
    for (const captureRecipe of captures) {
      if (captureRecipe.capture?.kind !== "capture") continue;
      const capture = captureRecipe.capture;
      const subject = capture.outputs.find(
        ({ roleId }) => roleId === capture.comparisonOutputRoleId,
      );
      if (!subject || subject.mediaType !== expected.mediaType) continue;
      const candidates: NonNullable<MediaIntent["repositoryCapture"]>[] = [];
      if (captureRecipe.capture.humanReview)
        candidates.push({
          expectedAssetId: expected.id,
          scenario: intent.repositoryCapture?.scenario ?? {
            id: "default",
            fixture: null,
            seed: null,
          },
          captureRecipeId: captureRecipe.id,
          comparison: { kind: "exact" },
          gate: { kind: "human-required" },
        });
      for (const gate of request.repositoryCapture.deterministicGates) {
        if (gate.captureRecipeId !== captureRecipe.id) continue;
        const gateComparison = gate.comparison;
        for (const scenario of gate.scenarios)
          candidates.push({
            expectedAssetId: expected.id,
            scenario,
            captureRecipeId: captureRecipe.id,
            comparison:
              gateComparison.kind === "exact"
                ? { kind: "exact" }
                : { kind: "threshold", policyId: gateComparison.policyId },
            gate: { kind: "deterministic-preauthorized", authorityId: gate.id },
          });
      }
      for (const repositoryCapture of candidates) {
        const candidate: MediaIntent = {
          ...intent,
          review: null,
          fulfillment: { kind: "imported", assetIds: [expected.id] },
          output: {
            mediaTypes: [subject.mediaType],
            minimumCount: 1,
            maximumCount: 1,
            profile: structuredClone(intent.output.profile),
          },
          repositoryCapture,
        };
        if (
          repositoryCaptureAuthorityReasons(
            request,
            proposalWithRepositoryCaptureCandidate(proposal, candidate),
            candidate,
          ).length === 0
        )
          return true;
      }
    }
  return false;
}

function projectedMediaProducerCount(request: CompilerRequest, proposal: CompilerProposal): number {
  return proposal.mediaIntents.filter(
    (intent) =>
      !intent.repositoryCapture &&
      !importedAssetsSatisfyMediaIntent(request, intent) &&
      request.media.producerCapabilities.some((capability) =>
        mediaCapabilitySupports(request, proposal, capability, intent),
      ),
  ).length;
}

function projectedWorkItemsForEconomics(
  request: CompilerRequest,
  proposal: CompilerProposal,
  projectionContext: CompilerProjectionContext,
): Parameters<typeof assessDecomposition>[0] {
  const authored: Parameters<typeof assessDecomposition>[0][number][] =
    compilerWorkItemsForEconomics(
      request,
      proposal,
      projectionContext.pinnedFacts,
      projectionContext.runPolicy,
    );
  const existingIds = new Set(authored.map(({ id }) => id));
  const producerIds = new Map<string, string>();
  for (const intent of proposal.mediaIntents) {
    if (
      !intent.repositoryCapture &&
      !importedAssetsSatisfyMediaIntent(request, intent) &&
      request.media.producerCapabilities.some((capability) =>
        mediaCapabilitySupports(request, proposal, capability, intent),
      )
    ) {
      const id = derivedMediaProducerId(intent.id, existingIds);
      existingIds.add(id);
      producerIds.set(intent.id, id);
    }
  }
  const scheduling = normalizeSchedulingPolicy(projectionContext.runPolicy);
  const produced = proposal.mediaIntents.flatMap((intent) => {
    const id = producerIds.get(intent.id);
    if (!id) return [];
    return [
      {
        id,
        goal: intent.brief,
        acceptance: [
          `Produce ${intent.output.minimumCount}-${intent.output.maximumCount} immutable media rendition(s).`,
        ],
        scope: [],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [
          ...new Set([
            ...intentInputIntentIds(intent)
              .map((inputId) => producerIds.get(inputId))
              .filter((inputId): inputId is string => Boolean(inputId)),
          ]),
        ].sort(),
        requirements: {
          os: ["linux"],
          architecture: [],
          cpu: scheduling.capacity.local.defaultCpu,
          memoryMb: scheduling.capacity.local.defaultMemoryMb,
          diskMb: 1,
          timeoutMinutes: request.constraints.workItemTimeoutMinutes,
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "managed" as const,
          evidence: [
            {
              field: "deliverable" as const,
              kind: "factory-default" as const,
              source: "asset-production planning estimate unavailable until provider admission",
            },
          ],
        },
        context: { mustRead: [], searchSeeds: [], dependencyEvidence: [] },
        validationCommands: [],
        changeSurface: { mergeClass: "large-binary" as const, exclusiveResources: [] },
      },
    ];
  });
  return [...authored, ...produced];
}

function mediaIntentViolations(
  request: CompilerRequest,
  proposal: CompilerProposal,
): CompilerViolation[] {
  const violations: CompilerViolation[] = [];
  const obligations = new Set(request.inventory.obligations.map((entry) => entry.id));
  const workItems = new Map(proposal.workItems.map((item) => [item.id, item]));
  const imported = new Set(request.media.assetManifest?.assets.map((asset) => asset.id) ?? []);
  const reviewRules = new Map(request.media.reviewRules.map((rule) => [rule.id, rule]));
  const intentIds = new Set<string>();
  const knownIntentIds = new Set(proposal.mediaIntents.map(({ id }) => id));
  const intentById = new Map(proposal.mediaIntents.map((intent) => [intent.id, intent]));
  const projectedDependencies = proposal.workItems.map((item) => ({
    id: item.id,
    dependsOn: [...item.dependsOn],
  }));
  const projectedById = new Map(projectedDependencies.map((item) => [item.id, item]));
  const projectedIds = new Set(projectedById.keys());
  const producerIdByIntent = new Map<string, string>();
  for (const intent of proposal.mediaIntents) {
    if (
      !intent.repositoryCapture &&
      !importedAssetsSatisfyMediaIntent(request, intent) &&
      request.media.producerCapabilities.some((capability) =>
        mediaCapabilitySupports(request, proposal, capability, intent),
      )
    ) {
      const producerId = derivedMediaProducerId(intent.id, projectedIds);
      projectedIds.add(producerId);
      producerIdByIntent.set(intent.id, producerId);
    }
  }
  for (const [intentIndex, intent] of proposal.mediaIntents.entries()) {
    const base = pointer("mediaIntents", intentIndex);
    if (intentIds.has(intent.id))
      violations.push(
        violation("duplicate-media-intent-id", `${base}/id`, "unique media intent IDs", intent.id),
      );
    intentIds.add(intent.id);
    const inputRoleBindings =
      intent.fulfillment.kind === "produced" ? intent.fulfillment.inputRoleBindings : [];
    for (const [inputBindingIndex, inputBinding] of inputRoleBindings.entries()) {
      const inputPath = `${base}/fulfillment/inputRoleBindings/${inputBindingIndex}/inputIntentIds`;
      const unknownInputIntents = inputBinding.inputIntentIds.filter(
        (id) => !knownIntentIds.has(id),
      );
      if (inputBinding.inputIntentIds.length > 1)
        violations.push(
          violation(
            "incompatible-media-output",
            inputPath,
            "at most one upstream Asset Set per producer input role",
            inputBinding.inputIntentIds,
            intent.id,
          ),
        );
      if (unknownInputIntents.length)
        violations.push(
          violation(
            "unknown-media-work-item",
            inputPath,
            [...knownIntentIds].sort(),
            unknownInputIntents,
            intent.id,
          ),
        );
      if (inputBinding.inputIntentIds.includes(intent.id))
        violations.push(
          violation(
            "media-dependency-cycle",
            inputPath,
            "other produced media intents",
            inputBinding.inputIntentIds,
            intent.id,
          ),
        );
      for (const inputId of inputBinding.inputIntentIds) {
        const input = intentById.get(inputId);
        if (!input) continue;
        if (!producerIdByIntent.has(inputId))
          violations.push(
            violation(
              "media-producer-unavailable",
              inputPath,
              "an upstream intent projected to an approved producer",
              inputId,
              intent.id,
            ),
          );
      }
      const unknownImports = inputBinding.importedAssetIds.filter((id) => !imported.has(id));
      if (unknownImports.length)
        violations.push(
          violation(
            "unknown-imported-asset",
            `${base}/fulfillment/inputRoleBindings/${inputBindingIndex}/importedAssetIds`,
            [...imported].sort(),
            unknownImports,
            intent.id,
          ),
        );
    }
    if (intent.fulfillment.kind === "imported") {
      const unknownImports = intent.fulfillment.assetIds.filter((id) => !imported.has(id));
      if (unknownImports.length)
        violations.push(
          violation(
            "unknown-imported-asset",
            `${base}/fulfillment/assetIds`,
            [...imported].sort(),
            unknownImports,
            intent.id,
          ),
        );
    }
    const unknownObligations = intent.obligationIds.filter((id) => !obligations.has(id));
    if (unknownObligations.length)
      violations.push(
        violation(
          "unknown-media-obligation",
          `${base}/obligationIds`,
          [...obligations].sort(),
          unknownObligations,
          intent.id,
        ),
      );
    const seenBindings = new Set<string>();
    let grounded = proposal.mediaIntents.some(
      (consumer) =>
        intentInputIntentIds(consumer).includes(intent.id) &&
        consumer.obligationIds.some((id) => intent.obligationIds.includes(id)),
    );
    for (const [bindingIndex, binding] of intent.bindings.entries()) {
      const item = workItems.get(binding.workItemId);
      if (!item) {
        violations.push(
          violation(
            "unknown-media-work-item",
            `${base}/bindings/${bindingIndex}/workItemId`,
            [...workItems.keys()].sort(),
            binding.workItemId,
            intent.id,
          ),
        );
        continue;
      }
      const bindingKey = `${binding.workItemId}\0${binding.direction}`;
      if (seenBindings.has(bindingKey))
        violations.push(
          violation(
            "unconsumed-media-intent",
            `${base}/bindings/${bindingIndex}`,
            "one canonical binding per Work Item and direction",
            binding,
            intent.id,
          ),
        );
      seenBindings.add(bindingKey);
      if (item.obligationIds.some((id) => intent.obligationIds.includes(id))) grounded = true;
      const criterionIds = new Set(item.criteria.map((criterion) => criterion.id));
      const unknownCriteria = binding.criterionIds.filter((id) => !criterionIds.has(id));
      if (unknownCriteria.length)
        violations.push(
          violation(
            "unknown-media-criterion",
            `${base}/bindings/${bindingIndex}/criterionIds`,
            [...criterionIds].sort(),
            unknownCriteria,
            intent.id,
          ),
        );
    }
    if (!grounded)
      violations.push(
        violation(
          "ungrounded-media-intent",
          base,
          "an obligation shared with at least one bound Work Item",
          { obligationIds: intent.obligationIds, bindings: intent.bindings },
          intent.id,
        ),
      );
    if (intent.repositoryCapture) {
      const unavailable = repositoryCaptureUnavailableReasons(request, proposal, intent);
      if (intent.necessity === "required" && unavailable.length)
        violations.push(
          violation(
            repositoryCaptureHasSatisfiableAuthority(request, proposal, intent)
              ? "invalid-media-validation-selection"
              : "media-validation-unavailable",
            `${base}/repositoryCapture`,
            "a repository-result capture selected from the exact execution, egress, comparison, and gate authority",
            unavailable,
            intent.id,
          ),
        );
      continue;
    }
    if (!intent.review) continue;
    if (
      intent.review.kind === "deterministic-preauthorized" &&
      !reviewRules.has(intent.review.ruleId)
    )
      violations.push(
        violation(
          "unauthorized-media-review",
          `${base}/review`,
          [...reviewRules.keys()].sort(),
          intent.review.ruleId,
          intent.id,
        ),
      );
    if (intent.review.kind === "deterministic-preauthorized") {
      const rule = reviewRules.get(intent.review.ruleId);
      const compatibleCapability = request.media.producerCapabilities.find(
        (capability) =>
          mediaCapabilitySupports(request, proposal, capability, intent) &&
          rule?.producerCapabilityIds.includes(capability.id),
      );
      const profile = intent.output.profile ? "raster" : "binary";
      if (
        rule &&
        (!compatibleCapability ||
          !rule.roles.includes(intent.role) ||
          !rule.purposes.includes(intent.purpose) ||
          !rule.profiles.includes(profile) ||
          !intent.output.mediaTypes.every((mediaType) => rule.mediaTypes.includes(mediaType)) ||
          !rule.outputVisibilities.includes(compatibleCapability.outputVisibility) ||
          !rule.rightsBases.includes(compatibleCapability.outputRightsBasis))
      )
        violations.push(
          violation(
            "unauthorized-media-review",
            `${base}/review`,
            "a deterministic reviewer applicable to the exact producer, role, purpose, MIME, and profile",
            intent.review.ruleId,
            intent.id,
          ),
        );
    }
    if (
      intent.purpose === "acceptance-evidence" &&
      intent.bindings.some((binding) => binding.direction !== "evidence-for")
    )
      violations.push(
        violation(
          "inconsistent-media-necessity",
          `${base}/bindings`,
          "acceptance evidence uses only evidence-for bindings",
          intent.bindings,
          intent.id,
        ),
      );
    const satisfiedByImport = importedAssetsSatisfyMediaIntent(request, intent);
    const compatible = request.media.producerCapabilities.filter((capability) =>
      mediaCapabilitySupports(request, proposal, capability, intent),
    );
    if (!satisfiedByImport && compatible.length === 0 && intent.necessity === "required")
      violations.push(
        violation(
          request.media.producerCapabilities.length > 0
            ? "incompatible-media-output"
            : "media-producer-unavailable",
          `${base}/output`,
          "an imported exact asset or permitted producer satisfying the media contract",
          {
            manifestAssetIds: [
              ...intentFulfillmentAssetIds(intent),
              ...intentProducerInputAssetIds(intent),
            ],
            producerCapabilities: request.media.producerCapabilities.map((entry) => entry.id),
          },
          intent.id,
        ),
      );
    const selection = activationSelectionForIntent(request, proposal, intent);
    if (
      !satisfiedByImport &&
      compatible.length > 0 &&
      selection.minimumCount > selection.maximumCount
    )
      violations.push(
        violation(
          "incompatible-media-output",
          `${base}/output`,
          "a nonempty activation-selection interval shared by every downstream consumer",
          selection,
          intent.id,
        ),
      );
    if (!satisfiedByImport && compatible.length > 0) {
      const producerId = producerIdByIntent.get(intent.id)!;
      projectedDependencies.push({
        id: producerId,
        dependsOn: [
          ...intent.bindings
            .filter(
              (binding) =>
                binding.direction === "evidence-for" && projectedById.has(binding.workItemId),
            )
            .map((binding) => binding.workItemId),
          ...intentInputIntentIds(intent)
            .map((id) => producerIdByIntent.get(id))
            .filter((id): id is string => Boolean(id)),
        ].sort(),
      });
      for (const binding of intent.bindings.filter((entry) => entry.direction === "input-to")) {
        const consumer = projectedById.get(binding.workItemId);
        if (consumer && !consumer.dependsOn.includes(producerId))
          consumer.dependsOn.push(producerId);
      }
    }
  }
  const mediaIntentDependencies = analyzeDependencies(
    proposal.mediaIntents.map((intent) => ({
      id: intent.id,
      dependsOn: intentInputIntentIds(intent),
    })),
  );
  if (mediaIntentDependencies.cycleItems.length)
    violations.push(
      violation(
        "media-dependency-cycle",
        "/mediaIntents",
        "an acyclic media intent input graph",
        mediaIntentDependencies.cycleItems,
      ),
    );
  const mediaDependencyAnalysis = analyzeDependencies(projectedDependencies);
  if (mediaDependencyAnalysis.cycleItems.length)
    violations.push(
      violation(
        "media-dependency-cycle",
        "/mediaIntents",
        "an acyclic graph after deterministic media producer projection",
        mediaDependencyAnalysis.cycleItems,
      ),
    );
  return violations;
}

export function parseAndValidateCompilerProposal(
  requestInput: CompilerRequest,
  value: unknown,
  projectionContext?: CompilerProjectionContext,
): { proposal?: CompilerProposalValue; report: CompilerValidationReport } {
  const requestReport = validateCompilerRequest(requestInput);
  if (requestReport.status !== "valid") return { report: requestReport };
  const request = CompilerRequestSchema.parse(requestInput);
  const normalized = normalizeCompilerProposalProviderOutput(value);
  const parsed = CompilerProposalSchema.safeParse(normalized);
  if (!parsed.success)
    return {
      report: createCompilerValidationReport(
        "proposal",
        schemaViolations(parsed.error, normalized),
      ),
    };
  const proposal: CompilerProposalValue =
    parsed.data.kind === "work-items"
      ? {
          ...parsed.data,
          mediaIntents: parsed.data.mediaIntents
            .map(canonicalMediaIntent)
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : parsed.data;
  const inventory = new Set(request.inventory.obligations.map((entry) => entry.id));
  const configuredPlanningThreshold = (code: string): number | undefined => {
    if (code === "work-item-threshold") return request.constraints.planningWorkItemThreshold;
    if (code === "critical-path-threshold") return request.constraints.planningCriticalPathMinutes;
    if (code === "aggregate-work-threshold")
      return request.constraints.planningAggregateWorkMinutes;
    return undefined;
  };
  const planningTriggerViolations =
    proposal.kind === "work-items"
      ? []
      : proposal.triggers.flatMap((trigger, index): CompilerViolation[] => {
          const invalidObligations = trigger.obligationIds.filter((id) => !inventory.has(id));
          const configuredThreshold = configuredPlanningThreshold(trigger.code);
          const availabilityMismatch =
            (trigger.availability === "unavailable" && trigger.observed !== null) ||
            (trigger.availability !== "unavailable" && trigger.observed === null);
          const thresholdMismatch =
            configuredThreshold !== undefined && trigger.threshold !== configuredThreshold;
          const nonTriggeringObservation =
            configuredThreshold !== undefined &&
            trigger.availability !== "unavailable" &&
            (typeof trigger.observed !== "number" || trigger.observed <= configuredThreshold);
          const placeholderEvidence =
            !isMeaningfulPlanningText(trigger.explanation) ||
            (typeof trigger.observed === "string" && !isMeaningfulPlanningText(trigger.observed));
          return [
            ...(invalidObligations.length
              ? [
                  violation(
                    "unknown-obligation",
                    pointer("triggers", index, "obligationIds"),
                    [...inventory].sort(),
                    invalidObligations,
                  ),
                ]
              : []),
            ...(availabilityMismatch ||
            thresholdMismatch ||
            nonTriggeringObservation ||
            placeholderEvidence
              ? [
                  violation(
                    "invalid-planning-trigger",
                    pointer("triggers", index),
                    configuredThreshold === undefined
                      ? "consistent availability and observation evidence"
                      : {
                          configuredThreshold,
                          observation:
                            "a numeric value above the configured threshold, or unavailable",
                        },
                    trigger,
                  ),
                ]
              : []),
          ];
        });
  if (proposal.kind === "objectives") {
    const planningViolations = validateObjectivePlan(
      proposal,
      request.inventory.obligations.map((entry) => entry.id),
    ) as CompilerViolation[];
    const objectiveBoundViolations = proposal.objectives.flatMap(
      (objective, index): CompilerViolation[] => {
        const { planningEstimate } = objective;
        const exceeded = [
          planningEstimate.workItems !== null &&
          planningEstimate.workItems > request.constraints.planningWorkItemThreshold
            ? {
                metric: "workItems",
                observed: planningEstimate.workItems,
                maximum: request.constraints.planningWorkItemThreshold,
              }
            : null,
          planningEstimate.criticalPathMinutes !== null &&
          planningEstimate.criticalPathMinutes > request.constraints.planningCriticalPathMinutes
            ? {
                metric: "criticalPathMinutes",
                observed: planningEstimate.criticalPathMinutes,
                maximum: request.constraints.planningCriticalPathMinutes,
              }
            : null,
          planningEstimate.aggregateWorkMinutes !== null &&
          planningEstimate.aggregateWorkMinutes > request.constraints.planningAggregateWorkMinutes
            ? {
                metric: "aggregateWorkMinutes",
                observed: planningEstimate.aggregateWorkMinutes,
                maximum: request.constraints.planningAggregateWorkMinutes,
              }
            : null,
          planningEstimate.criticalPathMinutes !== null &&
          planningEstimate.aggregateWorkMinutes !== null &&
          planningEstimate.criticalPathMinutes > planningEstimate.aggregateWorkMinutes
            ? {
                metric: "durationConsistency",
                observed: {
                  criticalPathMinutes: planningEstimate.criticalPathMinutes,
                  aggregateWorkMinutes: planningEstimate.aggregateWorkMinutes,
                },
                maximum: "criticalPathMinutes <= aggregateWorkMinutes",
              }
            : null,
        ].filter((entry) => entry !== null);
        return exceeded.length === 0
          ? []
          : [
              violation(
                "invalid-objective-bound",
                pointer("objectives", index, "planningEstimate"),
                {
                  maximumWorkItems: request.constraints.planningWorkItemThreshold,
                  maximumCriticalPathMinutes: request.constraints.planningCriticalPathMinutes,
                  maximumAggregateWorkMinutes: request.constraints.planningAggregateWorkMinutes,
                  unavailableEstimates: "null",
                },
                exceeded,
                objective.id,
              ),
            ];
      },
    );
    const report = createCompilerValidationReport("proposal", [
      ...planningTriggerViolations,
      ...planningViolations,
      ...objectiveBoundViolations,
    ]);
    return { proposal, report };
  }
  if (proposal.kind === "clarification") {
    const covered = new Set(proposal.requirements.flatMap((entry) => entry.obligationIds));
    const unknown = [...covered].filter((id) => !inventory.has(id));
    const clarificationIds = new Map<string, number>();
    for (const requirement of proposal.requirements)
      clarificationIds.set(requirement.id, (clarificationIds.get(requirement.id) ?? 0) + 1);
    const violations: CompilerViolation[] = [
      ...planningTriggerViolations,
      ...unknown.map((id) =>
        violation("unknown-obligation", "/requirements", [...inventory].sort(), id),
      ),
      ...[...clarificationIds]
        .filter(([, count]) => count > 1)
        .map(([id]) =>
          violation("duplicate-clarification-id", "/requirements", "unique clarification IDs", id),
        ),
      ...proposal.requirements.flatMap((requirement, index) =>
        isMeaningfulPlanningText(requirement.question) &&
        isMeaningfulPlanningText(requirement.reason)
          ? []
          : [
              violation(
                "invalid-clarification",
                pointer("requirements", index),
                "a concrete non-placeholder question and reason",
                { question: requirement.question, reason: requirement.reason },
              ),
            ],
      ),
    ];
    if (covered.size === 0)
      violations.push(
        violation(
          "clarification-coverage",
          "/requirements",
          "at least one affected parent obligation",
          [],
        ),
      );
    return { proposal, report: createCompilerValidationReport("proposal", violations) };
  }
  const violations: CompilerViolation[] = [];
  const projectionFacts = projectionContext
    ? compilerProjectionFactsFromPinned(projectionContext.pinnedFacts)
    : undefined;
  const finalProjectedWorkItemCount =
    proposal.workItems.length + projectedMediaProducerCount(request, proposal);
  if (finalProjectedWorkItemCount > request.constraints.maxWorkItems)
    violations.push(
      violation(
        "work-item-count",
        "/workItems",
        request.constraints.maxWorkItems,
        finalProjectedWorkItemCount,
      ),
    );
  if (finalProjectedWorkItemCount > 100)
    violations.push(
      violation(
        "objective-planning-required",
        "/workItems",
        {
          maximumWorkItems: request.constraints.planningWorkItemThreshold,
          maximumCriticalPathMinutes: request.constraints.planningCriticalPathMinutes,
          maximumAggregateWorkMinutes: request.constraints.planningAggregateWorkMinutes,
        },
        {
          workItems: finalProjectedWorkItemCount,
          configuredCriticalPathMinutes: null,
          configuredAggregateWorkMinutes: null,
        },
      ),
    );
  const analysis = analyzeDependencies(proposal.workItems);
  for (const id of analysis.duplicates)
    violations.push(violation("duplicate-item-id", "/workItems", "unique IDs", id, id));
  for (const entry of analysis.unknownDependencies)
    violations.push(
      violation(
        "unknown-dependency",
        pointer(
          "workItems",
          proposal.workItems.findIndex((item) => item.id === entry.itemId),
          "dependsOn",
        ),
        proposal.workItems.map((item) => item.id).sort(),
        entry.dependencyId,
        entry.itemId,
      ),
    );
  if (analysis.cycleItems.length)
    violations.push(
      violation("dependency-cycle", "/workItems", "acyclic graph", analysis.cycleItems),
    );
  const obligationIds = new Set(request.inventory.obligations.map((entry) => entry.id));
  const mapped = new Set<string>();
  const recipes = new Map(
    request.repository.validationRecipes.map((recipe) => [recipe.id, recipe]),
  );
  const capabilities = new Map(
    request.repository.toolchains.map((capability) => [capability.adapterId, capability]),
  );
  const validationSurfacePaths: CompilerValidationSurfacePaths = projectionContext
    ? compilerValidationSurfacePaths(projectionContext.pinnedFacts.relevantPaths)
    : {
        deterministicSimulation:
          request.repository.validationSurfaces.deterministicSimulation.sample,
        python: request.repository.validationSurfaces.python.sample,
        rust: request.repository.validationSurfaces.rust.sample,
        go: request.repository.validationSurfaces.go.sample,
      };
  const deferredUses: Array<{
    item: CompilerProposal["workItems"][number];
    adapterId: string;
    operation: { kind: string; key: string };
  }> = [];
  for (const [itemIndex, item] of proposal.workItems.entries()) {
    const ownsLanguageSurface = (
      paths: readonly string[],
      extension: RegExp,
      manifests: readonly string[],
    ) =>
      paths.some((path) => scopeOwnsPath(item.scope, path)) ||
      item.scope.some((path) => extension.test(path) || manifests.includes(path));
    const pythonScope = ownsLanguageSurface(validationSurfacePaths.python, /\.py$/i, [
      "pyproject.toml",
    ]);
    const rustScope = ownsLanguageSurface(validationSurfacePaths.rust, /\.rs$/i, ["Cargo.toml"]);
    const goScope = ownsLanguageSurface(validationSurfacePaths.go, /\.go$/i, ["go.mod"]);
    for (const language of [...(rustScope ? ["rust"] : []), ...(goScope ? ["go"] : [])])
      violations.push(
        violation(
          "unsupported-toolchain",
          pointer("workItems", itemIndex, "scope"),
          `compiler-supported ${language} validation authority`,
          item.scope,
          item.id,
        ),
      );
    if (pythonScope) {
      const pythonAuthority = request.repository.toolchains.find(
        (toolchain) => toolchain.adapterId === "python-uv",
      );
      const authorityAvailable =
        pythonAuthority?.state === "observed" || pythonAuthority?.state === "eligible-deferred";
      const hasPythonValidation = item.criteria.some((criterion) =>
        criterion.validation.some((validation) =>
          validation.evidence.some((reference) =>
            reference.kind === "observed"
              ? recipes.get(reference.recipeId)?.adapterId === "python-uv"
              : reference.kind === "deferred" && reference.adapterId === "python-uv",
          ),
        ),
      );
      if (!authorityAvailable || !hasPythonValidation)
        violations.push(
          violation(
            authorityAvailable ? "uncovered-criterion" : "unsupported-toolchain",
            pointer("workItems", itemIndex, "scope"),
            "python-uv validation authority bound to this Work Item",
            {
              state: pythonAuthority?.state ?? "unsupported",
              scope: item.scope,
            },
            item.id,
          ),
        );
    }
    const seenDependencies = new Set<string>();
    for (const dependency of item.dependsOn) {
      if (seenDependencies.has(dependency))
        violations.push(
          violation(
            "duplicate-dependency",
            pointer("workItems", itemIndex, "dependsOn"),
            "unique dependency IDs",
            dependency,
            item.id,
          ),
        );
      seenDependencies.add(dependency);
    }
    if (item.dependsOn.length > request.constraints.maxDependenciesPerItem)
      violations.push(
        violation(
          "dependency-limit",
          pointer("workItems", itemIndex, "dependsOn"),
          request.constraints.maxDependenciesPerItem,
          item.dependsOn.length,
          item.id,
        ),
      );
    for (const [scopeIndex, path] of item.scope.entries()) {
      if (!RepositoryScopePathSchema.safeParse(path).success)
        violations.push(
          violation(
            "invalid-scope",
            pointer("workItems", itemIndex, "scope", scopeIndex),
            "canonical repository-relative path",
            path,
            item.id,
          ),
        );
    }
    for (const id of item.obligationIds) {
      if (!obligationIds.has(id))
        violations.push(
          violation(
            "unknown-obligation",
            pointer("workItems", itemIndex, "obligationIds"),
            [...obligationIds].sort(),
            id,
            item.id,
          ),
        );
      else mapped.add(id);
    }
    const criterionIds = new Set<string>();
    const criterionTexts = new Set<string>();
    let itemEvidenceCount = 0;
    for (const [criterionIndex, criterion] of item.criteria.entries()) {
      if (criterionIds.has(criterion.id))
        violations.push(
          violation(
            "duplicate-criterion-id",
            pointer("workItems", itemIndex, "criteria", criterionIndex, "id"),
            "unique criterion ID within Work Item",
            criterion.id,
            item.id,
          ),
        );
      criterionIds.add(criterion.id);
      if (criterionTexts.has(criterion.text))
        violations.push(
          violation(
            "duplicate-criterion-text",
            pointer("workItems", itemIndex, "criteria", criterionIndex, "text"),
            "unique criterion text within Work Item",
            criterion.text,
            item.id,
          ),
        );
      criterionTexts.add(criterion.text);
      const acceptanceProblem = acceptanceTextProblem(criterion.text);
      if (acceptanceProblem)
        violations.push(
          violation(
            "uncovered-criterion",
            pointer("workItems", itemIndex, "criteria", criterionIndex, "text"),
            "concrete descriptive acceptance behavior",
            { problem: acceptanceProblem },
            item.id,
          ),
        );
      if (criterion.validation.length === 0)
        violations.push(
          violation(
            "uncovered-criterion",
            pointer("workItems", itemIndex, "criteria", criterionIndex, "validation"),
            "at least one validation tier",
            0,
            item.id,
          ),
        );
      const captureBindings = repositoryCaptureCriterionBindings(
        request,
        proposal,
        item.id,
        criterion.id,
      );
      const authoredEvidenceCount = criterion.validation.reduce(
        (count, validation) => count + validation.evidence.length,
        0,
      );
      const captureOnly = authoredEvidenceCount === 0 && captureBindings.length > 0;
      const deterministicRisk = inferCriterionRisk(criterion.text);
      if (
        (criterion.risk !== "ordinary" || deterministicRisk !== "ordinary") &&
        !criterionHasDeterministicValidation(criterion) &&
        !captureBindings.some(({ tier }) => tier === "mechanical")
      )
        violations.push(
          violation(
            "protected-risk-validation",
            pointer("workItems", itemIndex, "criteria", criterionIndex, "validation"),
            ["mechanical", "deterministic-simulation"],
            criterion.validation.map((entry) => entry.tier),
            item.id,
          ),
        );
      for (const [validationIndex, validation] of criterion.validation.entries()) {
        const groundedTier =
          validation.tier === "deterministic-simulation"
            ? validationSurfacePaths.deterministicSimulation.some((path) =>
                scopeOwnsPath(item.scope, path),
              )
            : true;
        if (!captureOnly && !groundedTier)
          violations.push(
            violation(
              "ungrounded-validation-tier",
              pointer(
                "workItems",
                itemIndex,
                "criteria",
                criterionIndex,
                "validation",
                validationIndex,
                "tier",
              ),
              `pinned ${validation.tier} repository surface within Work Item scope`,
              validation.tier,
              item.id,
            ),
          );
        if (!captureOnly && validation.tier !== "semantic" && validation.evidence.length === 0)
          violations.push(
            violation(
              "uncovered-criterion",
              pointer(
                "workItems",
                itemIndex,
                "criteria",
                criterionIndex,
                "validation",
                validationIndex,
              ),
              "validation evidence",
              0,
              item.id,
            ),
          );
        for (const reference of validation.evidence) {
          itemEvidenceCount += 1;
          if (reference.kind === "observed") {
            const recipe = recipes.get(reference.recipeId);
            if (!recipe || recipe.capture !== null)
              violations.push(
                violation(
                  "unknown-validation-recipe",
                  pointer(
                    "workItems",
                    itemIndex,
                    "criteria",
                    criterionIndex,
                    "validation",
                    validationIndex,
                    "evidence",
                  ),
                  [...recipes.values()]
                    .filter(({ capture }) => capture === null)
                    .map(({ id }) => id)
                    .sort(),
                  reference.recipeId,
                  item.id,
                ),
              );
          }
          if (reference.kind === "scoped-node-test") {
            const observedBare = [...recipes.values()].some(
              (recipe) => recipe.command === "node --test",
            );
            const validTargets =
              scopedNodeTestCommand(reference.targets) !== null &&
              reference.targets.every(
                (target) =>
                  /\.(?:c|m)?js$/.test(target) &&
                  item.scope.some((path) => scopeOwnsPath([path], target)),
              );
            if (!observedBare || !validTargets)
              violations.push(
                violation(
                  "unknown-validation-recipe",
                  pointer(
                    "workItems",
                    itemIndex,
                    "criteria",
                    criterionIndex,
                    "validation",
                    validationIndex,
                    "evidence",
                  ),
                  "scoped targets under observed bare test recipe",
                  reference.targets,
                  item.id,
                ),
              );
          }
          if (reference.kind === "deferred") {
            const capability = capabilities.get(reference.adapterId);
            const command = formatCompilerOperation(reference.adapterId, reference.operation);
            const roundTrip = command
              ? toolchainAdapterById(reference.adapterId)?.compiler?.operation?.parse(command)
              : null;
            if (
              capability?.state !== "eligible-deferred" ||
              !command ||
              roundTrip?.kind !== reference.operation.kind ||
              roundTrip.key !== reference.operation.key
            )
              violations.push(
                violation(
                  "invalid-deferred-operation",
                  pointer(
                    "workItems",
                    itemIndex,
                    "criteria",
                    criterionIndex,
                    "validation",
                    validationIndex,
                    "evidence",
                  ),
                  { state: "eligible-deferred", adapterId: reference.adapterId },
                  { state: capability?.state ?? "unknown", operation: reference.operation },
                  item.id,
                ),
              );
            else
              deferredUses.push({
                item,
                adapterId: reference.adapterId,
                operation: reference.operation,
              });
          }
        }
      }
      itemEvidenceCount += captureBindings.length;
    }
    if (itemEvidenceCount === 0)
      violations.push(
        violation(
          "uncovered-criterion",
          pointer("workItems", itemIndex, "criteria"),
          "at least one executable validation reference per Work Item",
          0,
          item.id,
        ),
      );
    const validationCommands = uniqueCommands(request, proposal, item);
    if (validationCommands.length > 32)
      violations.push(
        violation(
          "validation-command-limit",
          pointer("workItems", itemIndex, "criteria"),
          { maximumUniqueValidationCommands: 32 },
          validationCommands.length,
          item.id,
        ),
      );
    const executionRequirements = resolvedExecutionRequirements(request, proposal, item);
    for (const [field, values] of [
      ["additionalTools", executionRequirements.tools],
      ["additionalNetworkDestinations", executionRequirements.networkDestinations],
    ] as const)
      if (values.length > 64)
        violations.push(
          violation(
            "execution-requirement-limit",
            pointer("workItems", itemIndex, "executionIntent", field),
            { maximumProjectedValues: 64 },
            values.length,
            item.id,
          ),
        );
    const exclusiveResources = projectionFacts
      ? resolvedExclusiveResources(projectionFacts, item)
      : item.exclusiveResources;
    if (projectionFacts && exclusiveResources.length > 64)
      violations.push(
        violation(
          "exclusive-resource-limit",
          pointer("workItems", itemIndex, "exclusiveResources"),
          { maximumProjectedValues: 64 },
          exclusiveResources.length,
          item.id,
        ),
      );
    const oversizedResource = exclusiveResources.find((resource) => resource.length > 200);
    if (projectionFacts && oversizedResource)
      violations.push(
        violation(
          "exclusive-resource-limit",
          pointer("workItems", itemIndex, "exclusiveResources"),
          { maximumProjectedLength: 200 },
          oversizedResource.length,
          item.id,
        ),
      );
    const denied = item.executionIntent.additionalNetworkDestinations.filter(
      (destination) =>
        !destinationAllowedByPolicy(destination, request.constraints.allowedNetworkDestinations),
    );
    if (denied.length)
      violations.push(
        violation(
          "denied-network-destination",
          pointer("workItems", itemIndex, "executionIntent", "additionalNetworkDestinations"),
          request.constraints.allowedNetworkDestinations,
          denied,
          item.id,
        ),
      );
  }
  for (const obligation of request.inventory.obligations.filter(
    (entry) => entry.kind === "explicit",
  ))
    if (!mapped.has(obligation.id))
      violations.push(violation("unmapped-obligation", "/workItems", obligation.id, null));

  violations.push(...mediaIntentViolations(request, proposal));

  const byAdapter = new Map<string, typeof deferredUses>();
  for (const use of deferredUses)
    byAdapter.set(use.adapterId, [...(byAdapter.get(use.adapterId) ?? []), use]);
  for (const [adapterId, uses] of byAdapter) {
    const operations = new Set(uses.map((use) => `${use.operation.kind}\0${use.operation.key}`));
    const contract = toolchainAdapterById(adapterId)?.compiler;
    const maximumOperations = contract?.operation?.maxProvisionedOperations ?? 0;
    if (operations.size > maximumOperations)
      violations.push(
        violation("operation-count-limit", "/workItems", maximumOperations, operations.size),
      );
    if (!contract) continue;
    const itemOperations = (item: CompilerProposal["workItems"][number]) =>
      uses.filter((use) => use.item.id === item.id);
    const rootOwners = proposal.workItems.filter(
      (candidate) =>
        contract.rootAuthorityPaths.every((path) => scopeOwnsPath(candidate.scope, path)) &&
        itemOperations(candidate).length > 0,
    );
    const providers = new Set<string>();
    for (const use of uses) {
      const rootCandidates = rootOwners.filter((candidate) =>
        analysis.hasPath(use.item.id, candidate.id),
      );
      const roots = rootCandidates.filter(
        (candidate) =>
          !rootCandidates.some(
            (other) => other.id !== candidate.id && analysis.hasPath(other.id, candidate.id),
          ),
      );
      if (roots.length === 0) {
        violations.push(
          violation(
            rootOwners.length > 0
              ? "non-ancestor-capability-provider"
              : "missing-capability-provider",
            "/workItems",
            rootOwners.length > 0
              ? { consumer: use.item.id, adapterId }
              : [...contract.rootAuthorityPaths],
            rootOwners.length > 0 ? rootOwners.map((entry) => entry.id).sort() : null,
            use.item.id,
          ),
        );
        continue;
      }
      if (roots.length !== 1) {
        violations.push(
          violation(
            "ambiguous-capability-provider",
            "/workItems",
            1,
            roots.map((entry) => entry.id).sort(),
            use.item.id,
          ),
        );
        continue;
      }
      const root = roots[0]!;
      const generationCandidates = proposal.workItems.filter(
        (candidate) =>
          (candidate.id !== use.item.id || use.item.id === root.id) &&
          analysis.hasPath(use.item.id, candidate.id) &&
          analysis.hasPath(candidate.id, root.id) &&
          (candidate.id === root.id ||
            (contract.generationAuthorityPaths.every((path) =>
              scopeOwnsPath(candidate.scope, path),
            ) &&
              itemOperations(candidate).some(
                (candidateUse) =>
                  candidateUse.operation.kind === use.operation.kind &&
                  candidateUse.operation.key === use.operation.key,
              ))),
      );
      const closest = generationCandidates.filter(
        (candidate) =>
          !generationCandidates.some(
            (other) => other.id !== candidate.id && analysis.hasPath(other.id, candidate.id),
          ),
      );
      if (closest.length !== 1) {
        violations.push(
          violation(
            "ambiguous-capability-provider",
            "/workItems",
            1,
            closest.map((entry) => entry.id).sort(),
            use.item.id,
          ),
        );
        continue;
      }
      providers.add(closest[0]!.id);
    }
    for (const providerId of [...providers].sort()) {
      const provider = proposal.workItems.find((item) => item.id === providerId)!;
      const count = uniqueCommands(request, proposal, provider).length;
      const expected = contract.operation?.providerCommandCount;
      if (expected && (count < expected.min || count > expected.max))
        violations.push(
          violation(
            "operation-count-limit",
            "/workItems",
            { min: expected.min, max: expected.max },
            count,
            provider.id,
          ),
        );
    }
  }
  const economicContracts = new Map<string, string>();
  for (const item of proposal.workItems) {
    const execution = resolvedExecutionRequirements(request, proposal, item);
    const digest = compilerEvalDigest({
      goal: item.goal.trim(),
      acceptance: [...new Set(item.criteria.map((criterion) => criterion.text))].sort(),
      scope: [...new Set(item.scope)].sort(),
      preconditions: [...new Set(item.preconditions)].sort(),
      outOfScope: [...new Set(item.outOfScope)].sort(),
      conventions: [...new Set(item.conventions)].sort(),
      validationCommands: uniqueCommands(request, proposal, item),
      executionIntent: {
        estimatedDurationMinutes: item.executionIntent.estimatedDurationMinutes,
        tools: execution.tools,
        services: [...new Set(item.executionIntent.services)].sort(),
        networkDestinations: execution.networkDestinations,
        trust: item.executionIntent.trust,
      },
      exclusiveResources: [...new Set(item.exclusiveResources)].sort(),
    });
    const existing = economicContracts.get(digest);
    if (existing)
      violations.push(
        violation(
          "duplicate-work-item-contract",
          "/workItems",
          "distinct goal, acceptance, scope, validation, execution, or resource intent",
          [existing, item.id],
          item.id,
        ),
      );
    else economicContracts.set(digest, item.id);
  }
  if (projectionContext) {
    const projected =
      finalProjectedWorkItemCount <= 100
        ? projectedEnvelopeViolations(request, proposal, projectionContext)
        : [];
    violations.push(...projected);
    if (projected.length === 0 && finalProjectedWorkItemCount <= 100) {
      const assessment = assessDecomposition(
        projectedWorkItemsForEconomics(request, proposal, projectionContext),
      );
      const assessedProjectedWorkItems = finalProjectedWorkItemCount;
      const exceeded =
        assessedProjectedWorkItems > request.constraints.planningWorkItemThreshold ||
        (assessment?.configuredCriticalPathMinutes !== null &&
          assessment?.configuredCriticalPathMinutes !== undefined &&
          assessment.configuredCriticalPathMinutes >
            request.constraints.planningCriticalPathMinutes) ||
        (assessment?.configuredWorkMinutes !== null &&
          assessment?.configuredWorkMinutes !== undefined &&
          assessment.configuredWorkMinutes > request.constraints.planningAggregateWorkMinutes);
      if (exceeded)
        violations.push(
          violation(
            "objective-planning-required",
            "/workItems",
            {
              maximumWorkItems: request.constraints.planningWorkItemThreshold,
              maximumCriticalPathMinutes: request.constraints.planningCriticalPathMinutes,
              maximumAggregateWorkMinutes: request.constraints.planningAggregateWorkMinutes,
            },
            {
              workItems: assessedProjectedWorkItems,
              configuredCriticalPathMinutes: assessment?.configuredCriticalPathMinutes ?? null,
              configuredAggregateWorkMinutes: assessment?.configuredWorkMinutes ?? null,
            },
          ),
        );
    }
  }
  const report = createCompilerValidationReport("proposal", violations);
  return { proposal, report };
}

function uniqueCommands(
  request: CompilerRequest,
  proposal: CompilerProposal,
  item: CompilerProposal["workItems"][number],
): string[] {
  const ordinaryCommands: string[] = [];
  for (const criterion of item.criteria)
    for (const validation of criterion.validation)
      for (const reference of validation.evidence) {
        const command = validationCommand(request, reference);
        if (command && !ordinaryCommands.includes(command)) ordinaryCommands.push(command);
      }
  const captureCommands: string[] = [];
  for (const intent of proposal.mediaIntents) {
    const capture = intent.repositoryCapture;
    if (!capture) continue;
    if (!intent.bindings.some((binding) => binding.workItemId === item.id)) continue;
    if (repositoryCaptureUnavailableReasons(request, proposal, intent).length > 0) continue;
    const captureCommand = request.repository.validationRecipes.find(
      ({ id }) => id === capture.captureRecipeId,
    )?.command;
    if (captureCommand && !captureCommands.includes(captureCommand))
      captureCommands.push(captureCommand);
  }
  return [...ordinaryCommands, ...captureCommands];
}

function validationDesign(
  request: CompilerRequest,
  proposal: CompilerProposal,
  item: CompilerProposal["workItems"][number],
  finalCaptureAuthority = false,
): NonNullable<CompilerWorkItemInput["validation"]> {
  const tiers = new Map<
    CompilerProposal["workItems"][number]["criteria"][number]["validation"][number]["tier"],
    { criteria: string[]; commands: string[] }
  >();
  const captureTiers = new Set<"mechanical" | "semantic">();
  for (const criterion of item.criteria) {
    const captureBindings = repositoryCaptureCriterionBindings(
      request,
      proposal,
      item.id,
      criterion.id,
    );
    const captureOnly =
      captureBindings.length > 0 &&
      criterion.validation.every(({ evidence }) => evidence.length === 0);
    if (captureOnly && !finalCaptureAuthority) {
      for (const binding of captureBindings) {
        captureTiers.add(binding.tier);
        const current = tiers.get(binding.tier) ?? { criteria: [], commands: [] };
        if (!current.criteria.includes(criterion.text)) current.criteria.push(criterion.text);
        if (binding.tier === "mechanical" && !current.commands.includes(binding.command))
          current.commands.push(binding.command);
        tiers.set(binding.tier, current);
      }
      continue;
    }
    if (!captureOnly)
      for (const validation of criterion.validation) {
        const current = tiers.get(validation.tier) ?? { criteria: [], commands: [] };
        if (!current.criteria.includes(criterion.text)) current.criteria.push(criterion.text);
        for (const reference of validation.evidence) {
          const command = validationCommand(request, reference);
          if (command && !current.commands.includes(command)) current.commands.push(command);
        }
        tiers.set(validation.tier, current);
      }
    for (const binding of captureBindings) {
      captureTiers.add(binding.tier);
      const current = tiers.get(binding.tier) ?? { criteria: [], commands: [] };
      if (!current.criteria.includes(criterion.text)) current.criteria.push(criterion.text);
      tiers.set(binding.tier, current);
    }
  }
  return [...tiers].map(([tier, value]) => ({
    tier,
    criteria: value.criteria,
    rationale:
      tier !== "deterministic-simulation" && captureTiers.has(tier)
        ? "Repository-observed capture authority applies only to its exact bound criterion IDs; independent validation evidence remains additive."
        : `Criterion IDs select ${tier} evidence through the pinned compiler request.`,
    evidenceCommands: value.commands,
  }));
}

function semanticWorkItem(
  request: CompilerRequest,
  proposal: CompilerProposal,
  item: CompilerProposal["workItems"][number],
  runPolicy: RunPolicy,
): CompilerWorkItemInput {
  const scheduling = normalizeSchedulingPolicy(runPolicy);
  const executionRequirements = resolvedExecutionRequirements(request, proposal, item);
  const risk = (criterion: (typeof item.criteria)[number]): CriterionRisk => {
    const inferred = inferCriterionRisk(criterion.text);
    return criterion.risk === "ordinary" ? inferred : criterion.risk;
  };
  return {
    id: item.id,
    title: item.title,
    goal: item.goal,
    acceptance: item.criteria.map((criterion) => criterion.text),
    scope: [...item.scope],
    preconditions: [...item.preconditions],
    outOfScope: [...item.outOfScope],
    conventions: [...item.conventions],
    dependsOn: [...item.dependsOn],
    baseSha: request.baseSha,
    validationCommands: uniqueCommands(request, proposal, item),
    validation: validationDesign(request, proposal, item),
    criterionRisks: item.criteria.map((criterion) => ({
      criterion: criterion.text,
      risk: risk(criterion),
    })),
    requirements: {
      os: ["linux"],
      architecture: [],
      cpu: scheduling.capacity.local.defaultCpu,
      memoryMb: scheduling.capacity.local.defaultMemoryMb,
      diskMb: 1,
      timeoutMinutes: request.constraints.workItemTimeoutMinutes,
      ...(item.executionIntent.estimatedDurationMinutes === null
        ? {}
        : { estimatedDurationMinutes: item.executionIntent.estimatedDurationMinutes }),
      tools: executionRequirements.tools,
      services: [...new Set(item.executionIntent.services)].sort(),
      networkDestinations: executionRequirements.networkDestinations,
      permittedSecretNames: [],
      trust: item.executionIntent.trust,
    },
    deliverable: {
      kind: "repository-change",
      contract: "clockgrove.factory/artifact",
    },
    exclusiveResources: [...item.exclusiveResources],
  };
}

function semanticCompilerWorkItems(
  request: CompilerRequest,
  proposal: CompilerProposal,
  runPolicy: RunPolicy,
): CompilerWorkItemInput[] {
  return proposal.workItems.map((item) => semanticWorkItem(request, proposal, item, runPolicy));
}

function restoreAuthoredWorkItemFields(
  projected: Pick<CompiledObjective, "workItems">,
  proposal: CompilerProposal,
): void {
  const proposalById = new Map(proposal.workItems.map((item) => [item.id, item]));
  for (const item of projected.workItems) {
    if (item.deliverable.kind !== "repository-change")
      throw new Error(`projected repository Work Item ${item.id} changed deliverable kind`);
    const authored = proposalById.get(item.id);
    if (!authored) throw new Error(`projected Work Item ${item.id} has no authored proposal`);
    const authoredDependencies = new Set(authored.dependsOn);
    item.title = authored.title;
    item.goal = authored.goal;
    item.acceptance = authored.criteria.map((criterion) => criterion.text);
    item.scope = [...authored.scope];
    item.preconditions = [...authored.preconditions];
    item.outOfScope = [...authored.outOfScope];
    item.conventions = [...authored.conventions];
    item.dependsOn = [
      ...authored.dependsOn,
      ...item.dependsOn.filter((dependency) => !authoredDependencies.has(dependency)).sort(),
    ];
  }
}

function derivedMediaProducerId(intentId: string, existing: ReadonlySet<string>): string {
  for (let length = 16; length <= 56; length += 8) {
    const candidate = `asset-${compilerEvalDigest(intentId).slice(0, length)}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`media intent ${intentId} has no collision-free derived producer identity`);
}

function projectedRepositoryCaptureGateAuthority(
  request: CompilerRequest,
  intent: MediaIntent,
  binding: MediaIntent["bindings"][number],
  expected: WorkerAssetInput,
  captureRecipe: CompilerRequest["repository"]["validationRecipes"][number],
  comparison: RepositoryCaptureRecipe["comparison"],
): RepositoryCaptureRecipe["gate"] {
  const captureRequest = intent.repositoryCapture;
  if (!captureRequest || captureRequest.gate.kind !== "deterministic-preauthorized")
    throw new Error(`media intent ${intent.id} lacks deterministic capture authority`);
  const authorityId = captureRequest.gate.authorityId;
  const rule = request.repositoryCapture.deterministicGates.find(({ id }) => id === authorityId);
  const expectedFact = request.media.assetManifest?.assets.find(
    ({ id }) => id === captureRequest.expectedAssetId,
  );
  if (!rule || !expectedFact)
    throw new Error(`media intent ${intent.id} lacks its configured capture gate`);
  const comparisonAuthority =
    comparison.kind === "exact"
      ? { kind: "exact" as const }
      : {
          kind: "threshold" as const,
          comparator: structuredClone(comparison.comparator),
          metric: comparison.policy.metric,
          maximumDifference: comparison.policy.maximumDifference,
        };
  const core = {
    protocol: "clockgrove.factory/repository-capture-gate-authority" as const,
    authorityId: rule.id,
    captureCommand: {
      recipeId: captureRecipe.id,
      recipeDigest: compilerEvalDigest(captureRecipe),
      command: captureRecipe.command,
    },
    comparison: comparisonAuthority,
    expectedDescriptorDigest: expected.descriptorDigest,
    expectedMediaType: expectedFact.mediaType,
    expectedDescriptorClass: expectedFact.descriptorClass,
    expectedVisibility: expectedFact.visibility,
    expectedRightsBasis: expectedFact.rightsBasis,
    observedVisibility: "private" as const,
    observedRightsBasis: "unknown" as const,
    profileId:
      captureRecipe.capture?.kind === "capture"
        ? (captureRecipe.capture.profile?.kind ?? null)
        : null,
    scenario: structuredClone(captureRequest.scenario),
    criterionIds: [...binding.criterionIds].sort(),
    maximumCriteria: rule.maximumCriteria,
    policyDigest: request.repositoryCapture.egress.policyDigest,
  };
  return {
    kind: "deterministic-preauthorized",
    authority: { ...core, digest: compilerEvalDigest(core) },
  };
}

function projectedRepositoryCaptureRecipe(
  request: CompilerRequest,
  intent: MediaIntent,
  binding: MediaIntent["bindings"][number],
  expected: WorkerAssetInput,
  criteria: readonly { id: string; text: string }[],
): RepositoryCaptureRecipe {
  const captureRequest = intent.repositoryCapture;
  if (!captureRequest) throw new Error(`media intent ${intent.id} lacks capture semantics`);
  const captureRecipe = request.repository.validationRecipes.find(
    ({ id }) => id === captureRequest.captureRecipeId,
  );
  if (captureRecipe?.capture?.kind !== "capture")
    throw new Error(`media intent ${intent.id} lacks grounded capture authority`);
  const captureCapability = captureRecipe.capture;
  const commandIdentity = (recipe: (typeof request.repository.validationRecipes)[number]) => ({
    recipeId: recipe.id,
    recipeDigest: compilerEvalDigest(recipe),
    command: recipe.command,
  });
  const comparison =
    captureRequest.comparison.kind === "exact"
      ? {
          kind: "exact" as const,
          outputRoleId: captureCapability.comparisonOutputRoleId,
          expectedDescriptorDigest: expected.descriptorDigest,
          policy: { kind: "exact-bytes" as const },
        }
      : ((policyId: string) => {
          const installed = request.repositoryCapture.comparators.find(
            ({ policy, captureRecipeId, captureRecipeDigest }) =>
              policy.id === policyId &&
              captureRecipeId === captureRecipe.id &&
              captureRecipeDigest === compilerEvalDigest(captureRecipe),
          );
          if (!installed)
            throw new Error(`media intent ${intent.id} lacks grounded comparison authority`);
          return {
            kind: "threshold" as const,
            outputRoleId: captureCapability.comparisonOutputRoleId,
            comparator: installed.comparator,
            expectedDescriptorDigest: expected.descriptorDigest,
            policy: {
              kind: "bounded-difference" as const,
              metric: installed.policy.metric,
              maximumDifference: installed.policy.maximumDifference,
            },
          };
        })(captureRequest.comparison.policyId);
  const criterionBindings = [...criteria].sort((left, right) => left.id.localeCompare(right.id));
  if (
    criterionBindings.length !== binding.criterionIds.length ||
    criterionBindings.some(({ id }, index) => id !== [...binding.criterionIds].sort()[index])
  )
    throw new Error(`media intent ${intent.id} lacks exact criterion text bindings`);
  const core = {
    id: `capture-${compilerEvalDigest({ intentId: intent.id, workItemId: binding.workItemId }).slice(0, 16)}`,
    mediaUse: { intentId: intent.id, direction: "evidence-for" as const },
    criterionIds: criterionBindings.map(({ id }) => id),
    criteria: criterionBindings.map(({ text }) => text),
    scenario: structuredClone(captureRequest.scenario),
    captureCommand: commandIdentity(captureRecipe),
    outputs: structuredClone(captureCapability.outputs),
    profile:
      captureCapability.profile && intent.output.profile
        ? {
            ...structuredClone(captureCapability.profile),
            constraints: structuredClone(intent.output.profile),
          }
        : null,
    comparison,
    gate:
      captureRequest.gate.kind === "human-required"
        ? { kind: "human-required" as const }
        : projectedRepositoryCaptureGateAuthority(
            request,
            intent,
            binding,
            expected,
            captureRecipe,
            comparison,
          ),
  };
  return { ...core, digest: compilerEvalDigest(core) };
}

function projectMediaIntents(
  request: CompilerRequest,
  proposal: CompilerProposal,
  projectionContext: CompilerProjectionContext,
  projected: CompiledObjective,
): CompilerProjectionTrace["mediaIntents"] {
  const disposition: CompilerProjectionTrace["mediaIntents"] = [];
  const byId = new Map(projected.workItems.map((item) => [item.id, item]));
  const assetBindings = new Map(
    projectionContext.mediaPlanning?.assetBindings.map((binding) => [
      binding.assetId,
      binding.input,
    ]) ?? [],
  );
  const existingIds = new Set(byId.keys());
  const scheduling = normalizeSchedulingPolicy(projectionContext.runPolicy);
  const intentById = new Map(proposal.mediaIntents.map((intent) => [intent.id, intent]));
  const producerIdByIntent = new Map<string, string>();
  for (const intent of proposal.mediaIntents) {
    if (
      !intent.repositoryCapture &&
      !importedAssetsSatisfyMediaIntent(request, intent) &&
      request.media.producerCapabilities.some((candidate) =>
        mediaCapabilitySupports(request, proposal, candidate, intent),
      )
    ) {
      const producerId = derivedMediaProducerId(intent.id, existingIds);
      existingIds.add(producerId);
      producerIdByIntent.set(intent.id, producerId);
    }
  }
  for (const intent of proposal.mediaIntents) {
    if (intent.repositoryCapture) {
      const unavailable = repositoryCaptureUnavailableReasons(request, proposal, intent);
      if (unavailable.length) {
        if (intent.necessity === "required")
          throw new Error(`required media intent ${intent.id} lacks capture authority`);
        disposition.push({
          intentId: intent.id,
          disposition: "omitted-helpful",
          producerWorkItemId: null,
        });
        continue;
      }
      const expected = assetBindings.get(intent.repositoryCapture.expectedAssetId);
      if (!expected) throw new Error(`media intent ${intent.id} lacks expected asset authority`);
      for (const binding of intent.bindings) {
        const consumer = byId.get(binding.workItemId);
        if (!consumer || consumer.deliverable.kind !== "repository-change")
          throw new Error(`media intent ${intent.id} has no repository consumer`);
        const knownInputs = new Set(
          (consumer.assetInputs ?? []).map(({ descriptorDigest }) => descriptorDigest),
        );
        consumer.assetInputs = [
          ...(consumer.assetInputs ?? []),
          ...(!knownInputs.has(expected.descriptorDigest) ? [structuredClone(expected)] : []),
        ].sort((left, right) => left.descriptorDigest.localeCompare(right.descriptorDigest));
        consumer.mediaUses = [
          ...(consumer.mediaUses ?? []),
          {
            source: "imported" as const,
            intentId: intent.id,
            role: intent.role,
            inputRoleId: null,
            brief: intent.brief,
            purpose: intent.purpose,
            necessity: intent.necessity,
            obligationIds: [...intent.obligationIds],
            rationale: intent.rationale,
            direction: "evidence-for" as const,
            criterionIds: [...binding.criterionIds],
            descriptorDigests: [expected.descriptorDigest],
            manifestDigest: expected.manifestDigest,
          },
        ];
        consumer.repositoryCaptureRecipes = [
          ...(consumer.repositoryCaptureRecipes ?? []),
          projectedRepositoryCaptureRecipe(
            request,
            intent,
            binding,
            expected,
            (proposal.workItems.find(({ id }) => id === binding.workItemId)?.criteria ?? []).filter(
              ({ id }) => binding.criterionIds.includes(id),
            ),
          ),
        ].sort((left, right) => left.id.localeCompare(right.id));
      }
      disposition.push({
        intentId: intent.id,
        disposition: "repository-capture",
        producerWorkItemId: null,
      });
      continue;
    }
    const imported = importedAssetsSatisfyMediaIntent(request, intent);
    const selectedAssetIds = imported
      ? intentFulfillmentAssetIds(intent)
      : intentProducerInputAssetIds(intent);
    const selectedInputs = selectedAssetIds.map((assetId) => {
      const input = assetBindings.get(assetId);
      if (!input) throw new Error(`media intent ${intent.id} lacks imported asset authority`);
      return structuredClone(input);
    });
    if (imported) {
      for (const binding of intent.bindings) {
        const consumer = byId.get(binding.workItemId);
        if (!consumer || consumer.deliverable.kind !== "repository-change")
          throw new Error(`media intent ${intent.id} has no repository consumer`);
        const current = consumer.assetInputs ?? [];
        const known = new Set(current.map((entry) => entry.descriptorDigest));
        consumer.assetInputs = [
          ...current,
          ...selectedInputs.filter((entry) => !known.has(entry.descriptorDigest)),
        ].sort((left, right) => left.descriptorDigest.localeCompare(right.descriptorDigest));
        consumer.mediaUses = [
          ...(consumer.mediaUses ?? []),
          {
            source: "imported" as const,
            intentId: intent.id,
            role: intent.role,
            inputRoleId: null,
            brief: intent.brief,
            purpose: intent.purpose,
            necessity: intent.necessity,
            obligationIds: [...intent.obligationIds],
            rationale: intent.rationale,
            direction: binding.direction,
            criterionIds: [...binding.criterionIds],
            descriptorDigests: selectedInputs.map(({ descriptorDigest }) => descriptorDigest),
            manifestDigest: selectedInputs[0]!.manifestDigest,
          },
        ];
      }
      disposition.push({
        intentId: intent.id,
        disposition: "imported",
        producerWorkItemId: null,
      });
      continue;
    }
    const capability = [...request.media.producerCapabilities]
      .filter((candidate) => mediaCapabilitySupports(request, proposal, candidate, intent))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!capability) {
      if (intent.necessity === "required")
        throw new Error(`required media intent ${intent.id} has no permitted producer`);
      disposition.push({
        intentId: intent.id,
        disposition: "omitted-helpful",
        producerWorkItemId: null,
      });
      continue;
    }
    const producerId = producerIdByIntent.get(intent.id);
    if (!producerId) throw new Error(`media intent ${intent.id} lacks its projected producer`);
    if (intent.fulfillment.kind !== "produced")
      throw new Error(`media intent ${intent.id} imported fulfillment was not satisfied`);
    if (intent.review === null)
      throw new Error(`media intent ${intent.id} lacks producer review authority`);
    const producerIntent = {
      ...structuredClone(intent),
      review: intent.review,
      repositoryCapture: null,
    };
    const inputRequirements = intent.fulfillment.inputRoleBindings.flatMap((binding) =>
      binding.inputIntentIds.map((inputIntentId) => {
        const inputIntent = intentById.get(inputIntentId);
        const inputProducerId = producerIdByIntent.get(inputIntentId);
        if (!inputIntent || !inputProducerId)
          throw new Error(`media intent ${intent.id} lacks produced input ${inputIntentId}`);
        return {
          intentId: inputIntent.id,
          producerWorkItemId: inputProducerId,
          role: inputIntent.role,
          purpose: inputIntent.purpose,
          necessity: inputIntent.necessity,
          obligationIds: [...inputIntent.obligationIds],
          brief: inputIntent.brief,
          rationale: inputIntent.rationale,
          direction: "input-to" as const,
          criterionIds: [] as string[],
          inputRoleId: binding.roleId,
        };
      }),
    );
    const inputsByAssetId = new Map(
      intentProducerInputAssetIds(intent).map(
        (assetId, index) => [assetId, selectedInputs[index]!] as const,
      ),
    );
    const producerInputs = [
      ...new Map(selectedInputs.map((input) => [input.descriptorDigest, input])).values(),
    ].map((input) => structuredClone(input));
    const producerMediaUses = intent.fulfillment.inputRoleBindings.flatMap((binding) =>
      binding.importedAssetIds.map((assetId) => {
        const input = inputsByAssetId.get(assetId);
        if (!input) throw new Error(`media input ${assetId} lacks immutable asset authority`);
        return {
          source: "imported" as const,
          intentId: intent.id,
          role: intent.role,
          inputRoleId: binding.roleId,
          brief: intent.brief,
          purpose: intent.purpose,
          necessity: intent.necessity,
          obligationIds: [...intent.obligationIds],
          rationale: intent.rationale,
          direction: "input-to" as const,
          criterionIds: [] as string[],
          descriptorDigests: [input.descriptorDigest],
          manifestDigest: input.manifestDigest,
        };
      }),
    );
    const producer: CompiledAssetProductionWorkItem = {
      id: producerId,
      title: `Produce ${intent.role.replaceAll("-", " ")}: ${intent.id}`.slice(0, 256),
      goal: intent.brief,
      acceptance: [
        `Produce ${intent.output.minimumCount}-${intent.output.maximumCount} immutable ${intent.output.mediaTypes.join(" or ")} variant(s) satisfying the declared media constraints.`,
        `Return an authenticated clockgrove.factory/asset-set result bound to media intent ${intent.id}; review and activation remain separate supervised decisions.`,
      ],
      preconditions: [],
      outOfScope: [
        "Do not modify the repository, create a commit or pull request, approve a variant, or activate downstream content.",
      ],
      conventions: [
        "Preserve exact imported asset identities and return only bounded immutable variant descriptors.",
      ],
      dependsOn: [
        ...new Set([...inputRequirements.map(({ producerWorkItemId }) => producerWorkItemId)]),
      ].sort(),
      baseSha: request.baseSha,
      scope: [],
      validationCommands: [],
      requirements: {
        os: ["linux"],
        architecture: [],
        cpu: scheduling.capacity.local.defaultCpu,
        memoryMb: scheduling.capacity.local.defaultMemoryMb,
        diskMb: 1,
        timeoutMinutes: request.constraints.workItemTimeoutMinutes,
        tools: [],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "managed",
        evidence: [
          {
            field: "deliverable",
            kind: "factory-default",
            source: `asset-production:${capability.id}`,
          },
        ],
      },
      deliverable: {
        kind: "asset-production",
        contract: "clockgrove.factory/asset-set",
        intent: producerIntent,
        producerCapabilityId: capability.id,
        producerCapabilityDigest: capability.capabilityDigest,
        activationSelection: activationSelectionForIntent(request, proposal, intent),
      },
      ...(producerInputs.length ? { assetInputs: producerInputs } : {}),
      ...(inputRequirements.length || producerMediaUses.length
        ? { generatedAssetRequirements: inputRequirements, mediaUses: producerMediaUses }
        : {}),
      economicReview: {
        conservative: true,
        rationale: "Provider economics remain unresolved until supervised asset execution.",
        paidMeasurementRequired: false,
      },
    };
    projected.workItems.push(producer);
    byId.set(producer.id, producer);
    for (const binding of intent.bindings.filter((entry) => entry.direction === "input-to")) {
      const consumer = byId.get(binding.workItemId);
      if (!consumer || consumer.deliverable.kind !== "repository-change")
        throw new Error(`media intent ${intent.id} has no repository consumer`);
      if (!consumer.dependsOn.includes(producerId)) consumer.dependsOn.push(producerId);
      consumer.dependsOn.sort();
      consumer.generatedAssetRequirements = [
        ...(consumer.generatedAssetRequirements ?? []),
        {
          intentId: intent.id,
          producerWorkItemId: producerId,
          role: intent.role,
          purpose: intent.purpose,
          necessity: intent.necessity,
          obligationIds: [...intent.obligationIds],
          brief: intent.brief,
          rationale: intent.rationale,
          direction: "input-to" as const,
          criterionIds: [...binding.criterionIds],
          inputRoleId: null,
        },
      ].sort((left, right) => left.intentId.localeCompare(right.intentId));
    }
    disposition.push({
      intentId: intent.id,
      disposition: "producer",
      producerWorkItemId: producerId,
    });
  }
  return disposition;
}

function finalizeProjectedValidationDesign(
  request: CompilerRequest,
  proposal: CompilerProposal,
  projected: CompiledObjective,
): void {
  const proposalById = new Map(proposal.workItems.map((item) => [item.id, item]));
  for (const item of projected.workItems) {
    if (item.deliverable.kind !== "repository-change") continue;
    const authored = proposalById.get(item.id);
    if (!authored) continue;
    item.validation = validationDesign(request, proposal, authored, true);
  }
}

function orderProjectedWorkItemsByDependency(projected: CompiledObjective): void {
  const analysis = analyzeDependencies(projected.workItems);
  if (
    analysis.duplicates.length ||
    analysis.unknownDependencies.length ||
    analysis.cycleItems.length
  )
    return;
  const byId = new Map(projected.workItems.map((item) => [item.id, item]));
  projected.workItems = analysis.order.map((id) => byId.get(id)!);
}

function compilerProjectionTrace(
  request: CompilerRequest,
  proposal: CompilerProposal,
  projected: CompiledObjective,
  mediaIntents: CompilerProjectionTrace["mediaIntents"],
  graphDigest = compiledGraphDigest(projected),
): CompilerProjectionTrace {
  const proposalById = new Map(proposal.workItems.map((item) => [item.id, item]));
  const scopePairs = new Set(
    overlappingScopePairs(proposal.workItems).map(([left, right]) => `${left}\0${right}`),
  );
  const addedEdges: CompilerProjectionTrace["addedEdges"] = [];
  for (const item of projected.workItems) {
    const authored = proposalById.get(item.id);
    if (!authored) {
      if (item.deliverable.kind !== "asset-production")
        throw new Error(`projected Work Item ${item.id} has no authored proposal`);
      for (const dependency of item.dependsOn)
        addedEdges.push({
          itemId: item.id,
          dependsOn: dependency,
          reason: "media-input",
        });
      continue;
    }
    const authoredDependencies = new Set(authored.dependsOn);
    for (const dependency of item.dependsOn.filter((id) => !authoredDependencies.has(id))) {
      const key = [item.id, dependency].sort().join("\0");
      addedEdges.push({
        itemId: item.id,
        dependsOn: dependency,
        reason: projected.workItems.some(
          (candidate) =>
            candidate.id === dependency && candidate.deliverable.kind === "asset-production",
        )
          ? "media-input"
          : scopePairs.has(key)
            ? "scope-overlap"
            : "exclusive-resource",
      });
    }
  }
  const riskElevationEntries = proposal.workItems.flatMap((item) =>
    item.criteria.flatMap((criterion) => {
      const inferred = inferCriterionRisk(criterion.text);
      return criterion.risk === "ordinary" && inferred !== "ordinary"
        ? [
            {
              itemId: item.id,
              criterionId: criterion.id,
              from: "ordinary" as const,
              to: inferred,
            },
          ]
        : [];
    }),
  );
  const adapterBindings = projected.workItems.flatMap((item) =>
    item.deliverable.kind === "repository-change"
      ? (item.repositoryCapabilities?.requires ?? []).map((binding) => ({
          itemId: item.id,
          adapterId: binding.adapter,
          providerWorkItem: binding.providerWorkItem,
          operation: { ...binding.operation },
        }))
      : [],
  );
  return {
    protocol: "clockgrove.factory/compiler-projection",
    requestDigest: compilerEvalDigest(request),
    proposalDigest: compilerEvalDigest(proposal),
    graphDigest,
    addedEdges: addedEdges.sort(
      (left, right) =>
        left.itemId.localeCompare(right.itemId) || left.dependsOn.localeCompare(right.dependsOn),
    ),
    adapterBindings: adapterBindings.sort(
      (left, right) =>
        left.itemId.localeCompare(right.itemId) ||
        left.adapterId.localeCompare(right.adapterId) ||
        left.operation.key.localeCompare(right.operation.key),
    ),
    mediaIntents: [...mediaIntents].sort((left, right) =>
      left.intentId.localeCompare(right.intentId),
    ),
    riskElevations: {
      count: riskElevationEntries.length,
      digest: compilerEvalDigest(riskElevationEntries),
    },
  };
}

function projectedEnvelopeViolations(
  request: CompilerRequest,
  proposal: CompilerProposal,
  projectionContext: CompilerProjectionContext,
): CompilerViolation[] {
  const { pinnedFacts, runPolicy } = projectionContext;
  let projected: ReturnType<typeof compileObjective>;
  let mediaDispositions: CompilerProjectionTrace["mediaIntents"] = [];
  try {
    const workItems = semanticCompilerWorkItems(request, proposal, runPolicy);
    projected = compileObjective({
      title: request.objective.title,
      baseSha: request.baseSha,
      repositoryFacts: pinnedFacts.repository,
      workItems,
      validationCommands: [...new Set(workItems.flatMap((item) => item.validationCommands))],
      runPolicy,
    });
    restoreAuthoredWorkItemFields(projected, proposal);
    mediaDispositions = projectMediaIntents(
      request,
      proposal,
      projectionContext,
      projected as CompiledObjective,
    );
    finalizeProjectedValidationDesign(request, proposal, projected as CompiledObjective);
    validateCompiledObjective(projected, [
      ...new Set(workItems.flatMap((item) => item.validationCommands)),
    ]);
  } catch (error) {
    const violations: CompilerViolation[] = [];
    for (const [itemIndex, item] of proposal.workItems.entries()) {
      try {
        const isolatedProposal: CompilerProposal = {
          ...proposal,
          workItems: [{ ...item, dependsOn: [] }],
          mediaIntents: [],
        };
        const isolatedSemantic = semanticCompilerWorkItems(request, isolatedProposal, runPolicy);
        const isolated = compileObjective({
          title: request.objective.title,
          baseSha: request.baseSha,
          repositoryFacts: pinnedFacts.repository,
          workItems: isolatedSemantic,
          validationCommands: [
            ...new Set(isolatedSemantic.flatMap((entry) => entry.validationCommands)),
          ],
          runPolicy,
        });
        restoreAuthoredWorkItemFields(isolated, isolatedProposal);
        workerPacketFromCompiled(isolated.workItems[0]!);
      } catch (itemError) {
        const message = itemError instanceof Error ? itemError.message : String(itemError);
        const bytes = /^Worker Packet is (\d+) bytes; maximum is \d+$/.exec(message)?.[1];
        if (bytes)
          violations.push(
            violation(
              "worker-packet-limit",
              pointer("workItems", itemIndex),
              { maximumProjectedBytes: MAX_WORKER_PACKET_BYTES },
              Number(bytes),
              item.id,
            ),
          );
      }
    }
    violations.push(
      violation(
        "projection-blocked",
        "/workItems",
        "a graph whose dependent projection-envelope checks can be completed",
        { error: error instanceof Error ? error.message : String(error) },
      ),
    );
    return violations;
  }

  const violations: CompilerViolation[] = [];
  for (const [itemIndex, item] of projected.workItems.entries()) {
    if (item.dependsOn.length > request.constraints.maxDependenciesPerItem)
      violations.push(
        violation(
          "dependency-limit",
          pointer("workItems", itemIndex, "dependsOn"),
          request.constraints.maxDependenciesPerItem,
          item.dependsOn.length,
          item.id,
        ),
      );
    try {
      workerPacketFromCompiled(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bytes = /^Worker Packet is (\d+) bytes; maximum is \d+$/.exec(message)?.[1];
      violations.push(
        violation(
          bytes ? "worker-packet-limit" : "schema-invalid",
          pointer("workItems", itemIndex),
          bytes
            ? { maximumProjectedBytes: MAX_WORKER_PACKET_BYTES }
            : "a valid projected Worker Packet",
          bytes ? Number(bytes) : { error: message },
          item.id,
        ),
      );
    }
  }
  const dependencyShapeInvalid = projected.workItems.some(
    (item) => item.dependsOn.length > request.constraints.maxDependenciesPerItem,
  );
  const graphEnvelope = {
    ...projected,
    workItems: projected.workItems.map((item) => ({
      ...item,
      economicReview: {
        ...item.economicReview,
        // Economic evidence is optional during proposal validation and may later
        // replace this rationale with any schema-valid value. Reserve its full
        // bound so final projection cannot cross the persisted graph limit.
        rationale: "x".repeat(2_000),
      },
    })),
  };
  const diagnosticGraph = graphEnvelope as CompiledObjective;
  const graphDigest = compiledGraphDigestForDiagnostics(diagnosticGraph);
  for (const [itemIndex, item] of diagnosticGraph.workItems.entries()) {
    const metadata: GraphItemMetadata = {
      protocol: "clockgrove.factory/graph-v1",
      id: item.id,
      graphDigest,
      graphSize: diagnosticGraph.workItems.length,
      index: itemIndex,
      dependsOn: item.dependsOn,
      ...(diagnosticGraph.deferredCapabilityAdapters === undefined
        ? {}
        : { deferredCapabilityAdapters: diagnosticGraph.deferredCapabilityAdapters }),
    };
    let body: string;
    try {
      renderWorkPacket(item);
    } catch {
      // The independent Worker Packet violation above owns this item.
      continue;
    }
    try {
      body = renderWorkPacket(item, metadata);
    } catch (error) {
      violations.push(
        violation(
          "projection-blocked",
          pointer("workItems", itemIndex),
          "valid final graph-item metadata",
          { error: error instanceof Error ? error.message : String(error) },
          item.id,
        ),
      );
      body = renderWorkPacketWithRawGraphMetadataForDiagnostics(item, metadata);
    }
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_GITHUB_TEXT_BYTES)
      violations.push(
        violation(
          "issue-body-limit",
          pointer("workItems", itemIndex),
          { maximumProjectedBytes: MAX_GITHUB_TEXT_BYTES },
          bytes,
          item.id,
        ),
      );
  }
  if (dependencyShapeInvalid) {
    const observedBytes = Buffer.byteLength(JSON.stringify(graphEnvelope));
    if (observedBytes > MAX_COMPILED_GRAPH_BYTES)
      violations.push(
        violation(
          "compiled-graph-limit",
          "/workItems",
          { maximumProjectedBytes: MAX_COMPILED_GRAPH_BYTES },
          observedBytes,
        ),
      );
  } else {
    const observedBytes = Buffer.byteLength(JSON.stringify(graphEnvelope));
    if (observedBytes > MAX_COMPILED_GRAPH_BYTES)
      violations.push(
        violation(
          "compiled-graph-limit",
          "/workItems",
          { maximumProjectedBytes: MAX_COMPILED_GRAPH_BYTES },
          observedBytes,
        ),
      );
  }
  try {
    const trace = compilerProjectionTrace(
      request,
      proposal,
      projected as CompiledObjective,
      mediaDispositions,
      dependencyShapeInvalid ? compilerEvalDigest(projected) : compiledGraphDigest(projected),
    );
    const effectiveChallenges = deriveCompilerInferenceChallenges({
      inventory: request.inventory,
      findings: request.semanticFindings,
      proposal,
      carried: request.challenges,
    });
    const observedBytes = compilerJudgeSourceBytes({
      originalObjective: {
        number: request.objective.number,
        title: request.objective.title,
        body: request.objective.body,
      },
      baseSha: request.baseSha,
      // A retry may carry the maximum bounded failure reason even when the
      // first judge call does not. Reserve it before accepting paid output.
      priorCompilationFailure: { reason: "x".repeat(8_000), rawProposalAvailable: false },
      inventory: request.inventory,
      challenges: effectiveChallenges,
      proposal,
      projectionTrace: trace,
      draftDigest: trace.graphDigest,
      inventoryDigest: compilerEvalDigest(request.inventory),
    });
    if (observedBytes > MAX_COMPILER_JUDGE_SOURCE_BYTES)
      violations.push(
        violation(
          "judge-context-limit",
          "/workItems",
          { maximumBytes: MAX_COMPILER_JUDGE_SOURCE_BYTES },
          observedBytes,
        ),
      );
  } catch (error) {
    violations.push(
      violation("schema-invalid", "/workItems", "a deterministically serializable judge context", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return violations;
}

export function compilerWorkItemsForEconomics(
  request: CompilerRequest,
  proposal: CompilerProposal,
  pinnedFacts: PinnedRepositoryFacts,
  runPolicy: RunPolicy,
): CompilerWorkItem[] {
  const workItems = semanticCompilerWorkItems(request, proposal, runPolicy);
  return compileObjective({
    title: request.objective.title,
    baseSha: request.baseSha,
    repositoryFacts: pinnedFacts.repository,
    workItems,
    validationCommands: [...new Set(workItems.flatMap((item) => item.validationCommands))],
    runPolicy,
  }).workItems;
}

export function projectCompilerProposal(input: {
  request: CompilerRequest;
  proposal: CompilerProposal;
  pinnedFacts: PinnedRepositoryFacts;
  runPolicy: RunPolicy;
  repositoryCapturePlanning?: CompilationContext["repositoryCapturePlanning"];
  mediaPlanning?: CompilerProjectionContext["mediaPlanning"];
  economicEvidence?: DecompositionEvidence;
  legacyGraphConstraints?: LegacyGraphConstraints;
}): { objective: CompiledObjective; trace: CompilerProjectionTrace } {
  assertCompilerProjectionAuthority(input.request, {
    pinnedFacts: input.pinnedFacts,
    runPolicy: input.runPolicy,
    repositoryCapturePlanning: input.repositoryCapturePlanning ?? EMPTY_REPOSITORY_CAPTURE_PLANNING,
    ...(input.mediaPlanning ? { mediaPlanning: input.mediaPlanning } : {}),
  });
  const validated = parseAndValidateCompilerProposal(input.request, input.proposal, {
    pinnedFacts: input.pinnedFacts,
    runPolicy: input.runPolicy,
    repositoryCapturePlanning: input.repositoryCapturePlanning ?? EMPTY_REPOSITORY_CAPTURE_PLANNING,
    ...(input.mediaPlanning ? { mediaPlanning: input.mediaPlanning } : {}),
  });
  if (!validated.proposal || validated.report.status !== "valid")
    throw Object.assign(new CompilerInvariantError("projection received an invalid proposal"), {
      validationReport: validated.report,
      proposal: input.proposal,
    });
  if (validated.proposal.kind !== "work-items")
    throw Object.assign(new CompilerInvariantError("projection requires a Work Item proposal"), {
      validationReport: validated.report,
      proposal: validated.proposal,
    });
  try {
    const semantic = semanticCompilerWorkItems(input.request, validated.proposal, input.runPolicy);
    const projected = compileObjective({
      title: input.request.objective.title,
      baseSha: input.request.baseSha,
      repositoryFacts: input.pinnedFacts.repository,
      workItems: semantic,
      validationCommands: [...new Set(semantic.flatMap((item) => item.validationCommands))],
      runPolicy: input.runPolicy,
      ...(input.economicEvidence ? { economicEvidence: input.economicEvidence } : {}),
    }) as CompiledObjective;
    restoreAuthoredWorkItemFields(projected, validated.proposal);
    const mediaDispositions = projectMediaIntents(
      input.request,
      validated.proposal,
      {
        pinnedFacts: input.pinnedFacts,
        runPolicy: input.runPolicy,
        repositoryCapturePlanning:
          input.repositoryCapturePlanning ?? EMPTY_REPOSITORY_CAPTURE_PLANNING,
        ...(input.mediaPlanning ? { mediaPlanning: input.mediaPlanning } : {}),
      },
      projected,
    );
    finalizeProjectedValidationDesign(input.request, validated.proposal, projected);
    orderProjectedWorkItemsByDependency(projected);
    validateCompiledObjective(projected, [
      ...new Set(semantic.flatMap((item) => item.validationCommands)),
    ]);
    validateGraph(projected);
    if (input.legacyGraphConstraints)
      assertCompiledObjectiveAdoptsLegacyConstraints(projected, input.legacyGraphConstraints);
    return {
      objective: projected,
      trace: compilerProjectionTrace(
        input.request,
        validated.proposal,
        projected,
        mediaDispositions,
      ),
    };
  } catch (error) {
    if (error instanceof CompilerInvariantError) throw error;
    throw new CompilerInvariantError(error);
  }
}

export function validateLegacyProposal(
  proposal: CompilerProposal,
  constraints: LegacyGraphConstraints | undefined,
): CompilerValidationReport {
  if (!constraints) return emptyCompilerValidationReport();
  const violations: CompilerViolation[] = [];
  const expectedById = new Map(constraints.workItems.map((item) => [item.compilerId, item]));
  const expectedIdByNumber = new Map(
    constraints.workItems.map((item) => [item.issueNumber, item.compilerId]),
  );
  if (proposal.workItems.length !== constraints.workItems.length)
    violations.push(
      violation(
        "legacy-constraint-mismatch",
        "/workItems",
        [...constraints.workItems].length,
        proposal.workItems.length,
      ),
    );
  for (const [index, item] of proposal.workItems.entries()) {
    const expected = expectedById.get(item.id);
    const expectedAtIndex = constraints.workItems[index];
    const expectedDependencies =
      expected?.blockedByNumbers.map((number) => expectedIdByNumber.get(number)!) ?? [];
    if (
      !expected ||
      expectedAtIndex?.compilerId !== item.id ||
      item.title !== expected.title ||
      item.goal !== expected.goal ||
      compilerEvalDigest(item.criteria.map((criterion) => criterion.text)) !==
        compilerEvalDigest(expected.acceptance) ||
      compilerEvalDigest(item.scope) !== compilerEvalDigest(expected.scope) ||
      compilerEvalDigest(item.preconditions) !== compilerEvalDigest(expected.preconditions) ||
      compilerEvalDigest(item.outOfScope) !== compilerEvalDigest(expected.outOfScope) ||
      compilerEvalDigest(item.conventions) !== compilerEvalDigest(expected.conventions) ||
      compilerEvalDigest(item.dependsOn) !== compilerEvalDigest(expectedDependencies)
    )
      violations.push(
        violation(
          "legacy-constraint-mismatch",
          "/workItems",
          expected?.compilerId ?? "known adopted Work Item",
          item.id,
          item.id,
        ),
      );
  }
  return createCompilerValidationReport("proposal", violations);
}

export type { CompilerJudgeVerdict };
