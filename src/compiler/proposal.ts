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
  type GraphItemMetadata,
  type LegacyGraphConstraints,
} from "../graph.js";
import { analyzeDependencies, overlappingScopePairs } from "../graph-analysis.js";
import type { CompilationContext } from "../management/backend.js";
import {
  destinationAllowedByPolicy,
  normalizeSchedulingPolicy,
  type RunPolicy,
} from "../protocol/policy.js";
import { RepositoryScopePathSchema } from "../protocol/worker-packet.js";
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
  type CompilerRequest,
  type CompilerValidationReport,
  type CompilerViolation,
  type ValidationIntentRef,
} from "./contracts.js";
import { isMeaningfulPlanningText, validateObjectivePlan } from "./objective-planning.js";
import { createCompilerValidationReport, emptyCompilerValidationReport } from "./violations.js";
import { CompilerInvariantError } from "./invariant-error.js";
export { CompilerInvariantError } from "./invariant-error.js";

export class CompilerRequestValidationError extends Error {
  constructor(readonly report: CompilerValidationReport) {
    super(`compiler request is ${report.status}`);
    this.name = "CompilerRequestValidationError";
  }
}

export const MAX_COMPILER_REQUEST_BYTES = 900 * 1024;

export interface CompilerProjectionTrace {
  protocol: "clockgrove.factory/compiler-projection";
  requestDigest: string;
  proposalDigest: string;
  graphDigest: string;
  addedEdges: Array<{
    itemId: string;
    dependsOn: string;
    reason: "scope-overlap" | "exclusive-resource";
  }>;
  adapterBindings: Array<{
    itemId: string;
    adapterId: string;
    providerWorkItem: string;
    operation: { kind: string; key: string };
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
}

type CompilerValidationSurfacePaths = {
  deterministicSimulation: string[];
  visual: string[];
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
    visual: paths.filter(
      (path) =>
        /(?:screenshot|snapshot|visual|storybook)/.test(path.toLowerCase()) ||
        /\.(?:png|jpe?g|webp)$/i.test(path),
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
    compilerEvalDigest(expectedCapabilities) !==
    compilerEvalDigest({
      validationRecipes: request.repository.validationRecipes,
      toolchains: request.repository.toolchains,
    })
  )
    throw new Error("compiler request capabilities differ from pinned adapter facts");
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
  const eligible = request.repository.toolchains.filter(
    (toolchain) => toolchain.state === "eligible-deferred",
  );
  for (const toolchain of request.repository.toolchains) {
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
  if (recipes.length === 0 && eligible.length === 0) {
    for (const toolchain of request.repository.toolchains) {
      if (toolchain.state === "policy-blocked")
        violations.push(
          violation(
            "denied-network-destination",
            "/constraints/allowedNetworkDestinations",
            toolchain.networkDestinations,
            request.constraints.allowedNetworkDestinations,
          ),
        );
    }
    violations.push(
      violation(
        request.repository.toolchains.every((entry) => entry.state === "unsupported")
          ? "unsupported-toolchain"
          : "no-validation-capability",
        "/repository",
        "at least one observed recipe or eligible deferred adapter",
        {
          recipes: recipes.length,
          states: request.repository.toolchains.map((entry) => entry.state).sort(),
        },
      ),
    );
  }
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
  const revision = input.revision ?? 0;
  const planning = context.runPolicy.objectivePlanning;
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
  item: CompilerProposal["workItems"][number],
) {
  const references = item.criteria.flatMap((criterion) =>
    criterion.validation.flatMap((validation) => validation.evidence),
  );
  const recipes = references.flatMap((reference) =>
    reference.kind === "observed"
      ? request.repository.validationRecipes.filter((recipe) => recipe.id === reference.recipeId)
      : reference.kind === "scoped-node-test"
        ? request.repository.validationRecipes.filter((recipe) => recipe.command === "node --test")
        : [],
  );
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
  const proposal = parsed.data;
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
  if (proposal.workItems.length > request.constraints.maxWorkItems)
    violations.push(
      violation(
        "work-item-count",
        "/workItems",
        request.constraints.maxWorkItems,
        proposal.workItems.length,
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
        visual: request.repository.validationSurfaces.visual.sample,
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
      const deterministicRisk = inferCriterionRisk(criterion.text);
      if (
        (criterion.risk !== "ordinary" || deterministicRisk !== "ordinary") &&
        !criterionHasDeterministicValidation(criterion)
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
            : validation.tier === "visual"
              ? validationSurfacePaths.visual.some((path) => scopeOwnsPath(item.scope, path))
              : true;
        if (!groundedTier)
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
        if (validation.tier !== "semantic" && validation.evidence.length === 0)
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
          if (reference.kind === "observed" && !recipes.has(reference.recipeId))
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
                [...recipes.keys()].sort(),
                reference.recipeId,
                item.id,
              ),
            );
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
    const validationCommands = uniqueCommands(request, item);
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
    const executionRequirements = resolvedExecutionRequirements(request, item);
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
      const count = uniqueCommands(request, provider).length;
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
    const execution = resolvedExecutionRequirements(request, item);
    const digest = compilerEvalDigest({
      goal: item.goal.trim(),
      acceptance: [...new Set(item.criteria.map((criterion) => criterion.text))].sort(),
      scope: [...new Set(item.scope)].sort(),
      preconditions: [...new Set(item.preconditions)].sort(),
      outOfScope: [...new Set(item.outOfScope)].sort(),
      conventions: [...new Set(item.conventions)].sort(),
      validationCommands: uniqueCommands(request, item),
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
    const projected = projectedEnvelopeViolations(request, proposal, projectionContext);
    violations.push(...projected);
    if (projected.length === 0) {
      const assessment = assessDecomposition(
        compilerWorkItemsForEconomics(
          request,
          proposal,
          projectionContext.pinnedFacts,
          projectionContext.runPolicy,
        ),
      );
      const exceeded =
        assessment.workItems > request.constraints.planningWorkItemThreshold ||
        (assessment.configuredCriticalPathMinutes !== null &&
          assessment.configuredCriticalPathMinutes >
            request.constraints.planningCriticalPathMinutes) ||
        (assessment.configuredWorkMinutes !== null &&
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
              workItems: assessment.workItems,
              configuredCriticalPathMinutes: assessment.configuredCriticalPathMinutes,
              configuredAggregateWorkMinutes: assessment.configuredWorkMinutes,
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
  item: CompilerProposal["workItems"][number],
): string[] {
  const commands: string[] = [];
  for (const criterion of item.criteria)
    for (const validation of criterion.validation)
      for (const reference of validation.evidence) {
        const command = validationCommand(request, reference);
        if (command && !commands.includes(command)) commands.push(command);
      }
  return commands;
}

function validationDesign(
  request: CompilerRequest,
  item: CompilerProposal["workItems"][number],
): NonNullable<CompilerWorkItemInput["validation"]> {
  const tiers = new Map<
    CompilerProposal["workItems"][number]["criteria"][number]["validation"][number]["tier"],
    { criteria: string[]; commands: string[] }
  >();
  for (const criterion of item.criteria)
    for (const validation of criterion.validation) {
      const current = tiers.get(validation.tier) ?? { criteria: [], commands: [] };
      if (!current.criteria.includes(criterion.text)) current.criteria.push(criterion.text);
      for (const reference of validation.evidence) {
        const command = validationCommand(request, reference);
        if (command && !current.commands.includes(command)) current.commands.push(command);
      }
      tiers.set(validation.tier, current);
    }
  return [...tiers].map(([tier, value]) => ({
    tier,
    criteria: value.criteria,
    rationale: `Criterion IDs select ${tier} evidence through the pinned compiler request.`,
    evidenceCommands: value.commands,
  }));
}

function semanticWorkItem(
  request: CompilerRequest,
  item: CompilerProposal["workItems"][number],
  runPolicy: RunPolicy,
): CompilerWorkItemInput {
  const scheduling = normalizeSchedulingPolicy(runPolicy);
  const executionRequirements = resolvedExecutionRequirements(request, item);
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
    validationCommands: uniqueCommands(request, item),
    validation: validationDesign(request, item),
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
    artifactContract: "clockgrove.factory/artifact",
    exclusiveResources: [...item.exclusiveResources],
  };
}

function semanticCompilerWorkItems(
  request: CompilerRequest,
  proposal: CompilerProposal,
  runPolicy: RunPolicy,
): CompilerWorkItemInput[] {
  return proposal.workItems.map((item) => semanticWorkItem(request, item, runPolicy));
}

function restoreAuthoredWorkItemFields(
  projected: Pick<CompiledObjective, "workItems">,
  proposal: CompilerProposal,
): void {
  const proposalById = new Map(proposal.workItems.map((item) => [item.id, item]));
  for (const item of projected.workItems) {
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

function compilerProjectionTrace(
  request: CompilerRequest,
  proposal: CompilerProposal,
  projected: CompiledObjective,
  graphDigest = compiledGraphDigest(projected),
): CompilerProjectionTrace {
  const proposalById = new Map(proposal.workItems.map((item) => [item.id, item]));
  const scopePairs = new Set(
    overlappingScopePairs(proposal.workItems).map(([left, right]) => `${left}\0${right}`),
  );
  const addedEdges: CompilerProjectionTrace["addedEdges"] = [];
  for (const item of projected.workItems) {
    const authored = proposalById.get(item.id);
    if (!authored) throw new Error(`projected Work Item ${item.id} has no authored proposal`);
    const authoredDependencies = new Set(authored.dependsOn);
    for (const dependency of item.dependsOn.filter((id) => !authoredDependencies.has(id))) {
      const key = [item.id, dependency].sort().join("\0");
      addedEdges.push({
        itemId: item.id,
        dependsOn: dependency,
        reason: scopePairs.has(key) ? "scope-overlap" : "exclusive-resource",
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
    (item.repositoryCapabilities?.requires ?? []).map((binding) => ({
      itemId: item.id,
      adapterId: binding.adapter,
      providerWorkItem: binding.providerWorkItem,
      operation: { ...binding.operation },
    })),
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
  } catch (error) {
    const violations: CompilerViolation[] = [];
    for (const [itemIndex, item] of proposal.workItems.entries()) {
      try {
        const isolatedProposal: CompilerProposal = {
          ...proposal,
          workItems: [{ ...item, dependsOn: [] }],
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
  economicEvidence?: DecompositionEvidence;
  legacyGraphConstraints?: LegacyGraphConstraints;
}): { objective: CompiledObjective; trace: CompilerProjectionTrace } {
  assertCompilerProjectionAuthority(input.request, {
    pinnedFacts: input.pinnedFacts,
    runPolicy: input.runPolicy,
  });
  const validated = parseAndValidateCompilerProposal(input.request, input.proposal, {
    pinnedFacts: input.pinnedFacts,
    runPolicy: input.runPolicy,
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
    validateGraph(projected);
    if (input.legacyGraphConstraints)
      assertCompiledObjectiveAdoptsLegacyConstraints(projected, input.legacyGraphConstraints);
    return {
      objective: projected,
      trace: compilerProjectionTrace(input.request, validated.proposal, projected),
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
