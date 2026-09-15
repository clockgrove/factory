import {
  assertCompiledObjectiveAdoptsLegacyConstraints,
  compiledGraphDigest,
  validateGraph,
  type CompiledObjective,
  type LegacyGraphConstraints,
} from "../graph.js";
import {
  analyzeDependencies,
  exclusiveResourcePairs,
  overlappingScopePairs,
} from "../graph-analysis.js";
import type { CompilationContext } from "../management/backend.js";
import { normalizeSchedulingPolicy, type RunPolicy } from "../protocol/policy.js";
import { RepositoryScopePathSchema } from "../protocol/worker-packet.js";
import {
  readPinnedCompilerFacts,
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
  ObligationInventorySchema,
  type CompilerInferenceChallenge,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import {
  acceptanceTextProblem,
  compileObjective,
  type DecompositionEvidence,
  type CompilerWorkItem,
  type CompilerWorkItemInput,
} from "./index.js";
import { inferCriterionRisk, type CriterionRisk } from "./validation-design.js";
import {
  CompilerProposalSchema,
  CompilerRequestSchema,
  type CompilerDiagnosticValue,
  type CompilerJudgeFinding,
  type CompilerProposal,
  type CompilerRequest,
  type CompilerValidationReport,
  type CompilerViolation,
  type ValidationIntentRef,
} from "./contracts.js";
import { createCompilerValidationReport, emptyCompilerValidationReport } from "./violations.js";

export class CompilerInvariantError extends Error {
  constructor(cause: unknown) {
    super(
      `compiler projection invariant failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = "CompilerInvariantError";
  }
}

export class CompilerRequestValidationError extends Error {
  constructor(readonly report: CompilerValidationReport) {
    super(`compiler request is ${report.status}`);
    this.name = "CompilerRequestValidationError";
  }
}

export interface CompilerProjectionTrace {
  protocol: "clockgrove.factory/compiler-projection";
  requestDigest: string;
  proposalDigest: string;
  graphDigest: string;
  addedEdges: Array<{
    itemId: string;
    dependsOn: string;
    reason: "scope-overlap" | "exclusive-resource";
    resources: string[];
  }>;
  adapterBindings: Array<{
    itemId: string;
    adapterId: string;
    providerWorkItem: string;
    operation: { kind: string; key: string };
  }>;
  riskElevations: Array<{
    itemId: string;
    criterionId: string;
    from: "ordinary";
    to: Exclude<CriterionRisk, "ordinary">;
  }>;
}

export interface PreparedCompilerRequest {
  request: CompilerRequest;
  pinnedFacts: PinnedRepositoryFacts;
  report: CompilerValidationReport;
  legacyGraphConstraints?: LegacyGraphConstraints;
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
  revision?: number;
  previousProposal?: CompilerProposal | null;
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
  const request = CompilerRequestSchema.parse({
    protocol: "clockgrove.factory/compiler-request",
    revision,
    objective: {
      ...context.objective,
      digest: compilerEvalDigest(context.objective),
    },
    baseSha: context.baseSha,
    inventory: ObligationInventorySchema.parse(input.inventory),
    repository: {
      manifests: pinnedFacts.manifests,
      validationRecipes: repository.validationRecipes,
      toolchains: repository.toolchains,
      validationSurfaces: {
        deterministicSimulation: pinnedFacts.relevantPaths.filter((path) =>
          /(?:simulation|simulator|replay|seed)/.test(path.toLowerCase()),
        ),
        visual: pinnedFacts.relevantPaths.filter(
          (path) =>
            /(?:screenshot|snapshot|visual|storybook)/.test(path.toLowerCase()) ||
            /\.(?:png|jpe?g|webp)$/i.test(path),
        ),
        python: pinnedFacts.relevantPaths.filter(
          (path) => path === "pyproject.toml" || path.endsWith(".py"),
        ),
        rust: pinnedFacts.relevantPaths.filter(
          (path) => path === "Cargo.toml" || path.endsWith(".rs"),
        ),
        go: pinnedFacts.relevantPaths.filter((path) => path === "go.mod" || path.endsWith(".go")),
      },
      pathCount: pinnedFacts.relevantPaths.length,
    },
    constraints: {
      maxWorkItems: context.legacyGraphConstraints?.workItems.length ?? 100,
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
  if (reference.kind === "scoped-node-test") return `node --test ${reference.targets.join(" ")}`;
  return formatCompilerOperation(reference.adapterId, reference.operation);
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
): { proposal?: CompilerProposal; report: CompilerValidationReport } {
  const requestReport = validateCompilerRequest(requestInput);
  if (requestReport.status !== "valid") return { report: requestReport };
  const request = CompilerRequestSchema.parse(requestInput);
  const parsed = CompilerProposalSchema.safeParse(value);
  if (!parsed.success)
    return {
      report: createCompilerValidationReport("proposal", schemaViolations(parsed.error, value)),
    };
  const proposal = parsed.data;
  const violations: CompilerViolation[] = [];
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
    const pythonScope = ownsLanguageSurface(
      request.repository.validationSurfaces.python,
      /\.py$/i,
      ["pyproject.toml"],
    );
    const rustScope = ownsLanguageSurface(request.repository.validationSurfaces.rust, /\.rs$/i, [
      "Cargo.toml",
    ]);
    const goScope = ownsLanguageSurface(request.repository.validationSurfaces.go, /\.go$/i, [
      "go.mod",
    ]);
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
            ? request.repository.validationSurfaces.deterministicSimulation.some((path) =>
                scopeOwnsPath(item.scope, path),
              )
            : validation.tier === "visual"
              ? request.repository.validationSurfaces.visual.some((path) =>
                  scopeOwnsPath(item.scope, path),
                )
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
            const validTargets = reference.targets.every(
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
  const references = item.criteria.flatMap((criterion) =>
    criterion.validation.flatMap((validation) => validation.evidence),
  );
  const recipes = references.flatMap((reference) =>
    reference.kind === "observed"
      ? request.repository.validationRecipes.filter((recipe) => recipe.id === reference.recipeId)
      : [],
  );
  const deferred = references.flatMap((reference) =>
    reference.kind === "deferred"
      ? request.repository.toolchains.filter(
          (toolchain) => toolchain.adapterId === reference.adapterId,
        )
      : [],
  );
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
      estimatedDurationMinutes: item.executionIntent.estimatedDurationMinutes,
      tools: [
        ...new Set([
          ...recipes.flatMap((recipe) => recipe.requiredTools),
          ...deferred.flatMap((capability) => capability.requiredTools),
        ]),
      ].sort(),
      services: [],
      networkDestinations: [
        ...new Set([
          ...recipes.flatMap((recipe) => recipe.networkDestinations),
          ...deferred.flatMap((capability) => capability.networkDestinations),
        ]),
      ].sort(),
      permittedSecretNames: [],
      trust: runPolicy.trust === "sandbox_untrusted" ? "isolated" : "trusted_local",
    },
    artifactContract: "clockgrove.factory/artifact-v1",
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
  const validated = parseAndValidateCompilerProposal(input.request, input.proposal);
  if (!validated.proposal || validated.report.status !== "valid")
    throw new CompilerInvariantError("projection received an invalid proposal");
  try {
    if (
      input.pinnedFacts.baseSha !== input.request.baseSha ||
      input.pinnedFacts.relevantPaths.length !== input.request.repository.pathCount ||
      compilerEvalDigest(input.pinnedFacts.manifests) !==
        compilerEvalDigest(input.request.repository.manifests)
    )
      throw new Error("pinned repository facts differ from the compiler request");
    const expectedCapabilities = compilerCapabilitiesForRepository(
      input.pinnedFacts,
      input.request.constraints.allowedNetworkDestinations,
    );
    if (
      compilerEvalDigest(expectedCapabilities) !==
      compilerEvalDigest({
        validationRecipes: input.request.repository.validationRecipes,
        toolchains: input.request.repository.toolchains,
      })
    )
      throw new Error("compiler request capabilities differ from pinned adapter facts");
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
    const proposalById = new Map(validated.proposal.workItems.map((item) => [item.id, item]));
    const addedEdges: CompilerProjectionTrace["addedEdges"] = [];
    const scopePairs = new Set(
      overlappingScopePairs(validated.proposal.workItems).map(
        ([left, right]) => `${left}\0${right}`,
      ),
    );
    const resourcePairs = new Map(
      exclusiveResourcePairs(
        validated.proposal.workItems.map((item) => ({
          id: item.id,
          exclusiveResources: item.exclusiveResources,
        })),
      ).map((pair) => [`${pair.left}\0${pair.right}`, pair.resources]),
    );
    for (const item of projected.workItems) {
      const authored = proposalById.get(item.id)!;
      const authoredDependencies = new Set(authored.dependsOn);
      for (const dependency of item.dependsOn.filter((id) => !authoredDependencies.has(id))) {
        const key = [item.id, dependency].sort().join("\0");
        const resources = resourcePairs.get(key) ?? [];
        addedEdges.push({
          itemId: item.id,
          dependsOn: dependency,
          reason: scopePairs.has(key) ? "scope-overlap" : "exclusive-resource",
          resources,
        });
      }
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
    validateGraph(projected);
    if (input.legacyGraphConstraints)
      assertCompiledObjectiveAdoptsLegacyConstraints(projected, input.legacyGraphConstraints);
    const riskElevations = validated.proposal.workItems.flatMap((item) =>
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
    const traceWithoutGraph = {
      protocol: "clockgrove.factory/compiler-projection" as const,
      requestDigest: compilerEvalDigest(input.request),
      proposalDigest: compilerEvalDigest(validated.proposal),
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
      riskElevations,
    };
    const graphDigest = compiledGraphDigest(projected);
    return { objective: projected, trace: { ...traceWithoutGraph, graphDigest } };
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
