import { z } from "zod";

import {
  CompilerInferenceChallengesSchema,
  CompilerJudgeVerdictSchema,
  MAX_COMPILER_INFERENCE_CHALLENGES,
  MAX_COMPILER_ITEM_CHALLENGES,
  MAX_COMPILER_OBLIGATION_CHALLENGES,
  ObligationInventorySchema,
  type CompilerInferenceChallenge,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import { NetworkDestinationSchema, RepositoryScopePathSchema } from "../protocol/worker-packet.js";
import { CompilerMediaFactsSchema, MediaIntentSchema } from "../assets/media-intent.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(64);
const Text = z.string().min(1).max(4_000);
const DiagnosticValueSchema: z.ZodType<CompilerDiagnosticValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(DiagnosticValueSchema),
    z.record(DiagnosticValueSchema),
  ]),
);

export type CompilerDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | CompilerDiagnosticValue[]
  | { [key: string]: CompilerDiagnosticValue };

export const COMPILER_VIOLATION_CODES = [
  "schema-invalid",
  "work-item-count",
  "duplicate-item-id",
  "duplicate-dependency",
  "duplicate-criterion-id",
  "duplicate-criterion-text",
  "duplicate-work-item-contract",
  "unknown-obligation",
  "unmapped-obligation",
  "unknown-dependency",
  "dependency-cycle",
  "dependency-limit",
  "invalid-scope",
  "unknown-validation-recipe",
  "invalid-deferred-operation",
  "uncovered-criterion",
  "protected-risk-validation",
  "ungrounded-validation-tier",
  "partial-toolchain-authority",
  "mixed-toolchain-authority",
  "unsupported-toolchain",
  "no-validation-capability",
  "missing-capability-provider",
  "ambiguous-capability-provider",
  "non-ancestor-capability-provider",
  "operation-count-limit",
  "validation-command-limit",
  "execution-requirement-limit",
  "exclusive-resource-limit",
  "worker-packet-limit",
  "issue-body-limit",
  "compiled-graph-limit",
  "projection-blocked",
  "compiler-request-limit",
  "compiler-prompt-limit",
  "judge-context-limit",
  "denied-network-destination",
  "legacy-constraint-mismatch",
  "duplicate-media-intent-id",
  "unknown-media-obligation",
  "unknown-media-work-item",
  "unknown-media-criterion",
  "unknown-imported-asset",
  "unconsumed-media-intent",
  "ungrounded-media-intent",
  "incompatible-media-output",
  "unauthorized-media-review",
  "inconsistent-media-necessity",
  "media-producer-unavailable",
  "media-dependency-cycle",
  "objective-count",
  "duplicate-objective-id",
  "duplicate-acceptance-id",
  "duplicate-output-id",
  "invalid-objective-content",
  "duplicate-obligation-disposition",
  "invalid-obligation-disposition",
  "unknown-prerequisite-objective",
  "unknown-prerequisite-output",
  "duplicate-prerequisite-output",
  "self-prerequisite",
  "objective-cycle",
  "objective-order",
  "unknown-completion-acceptance",
  "duplicate-completion-acceptance",
  "invalid-integration-acceptance",
  "overlapping-objective-scope",
  "root-integration-acceptance",
  "empty-objective-milestone",
  "invalid-objective-bound",
  "invalid-planning-trigger",
  "clarification-coverage",
  "invalid-clarification",
  "duplicate-clarification-id",
  "objective-planning-required",
  "report-truncated",
] as const;
export const CompilerViolationCodeSchema = z.enum(COMPILER_VIOLATION_CODES);
export type CompilerViolationCode = z.infer<typeof CompilerViolationCodeSchema>;

export const COMPILER_TERMINAL_VIOLATION_PHASES: Readonly<
  Partial<Record<CompilerViolationCode, readonly ("request" | "proposal")[]>>
> = {
  "schema-invalid": ["request"],
  "partial-toolchain-authority": ["request"],
  "mixed-toolchain-authority": ["request"],
  "unsupported-toolchain": ["request"],
  "no-validation-capability": ["request"],
  "compiler-request-limit": ["request"],
  "compiler-prompt-limit": ["request"],
  "judge-context-limit": ["request"],
  "denied-network-destination": ["request"],
  "media-producer-unavailable": ["proposal"],
};

export const CompilerViolationSchema = z
  .object({
    code: CompilerViolationCodeSchema,
    itemId: Id.nullable(),
    field: z
      .string()
      .max(1_000)
      .regex(/^(?:|(?:\/(?:[^~/]|~0|~1)*)+)$/),
    expected: DiagnosticValueSchema,
    observed: DiagnosticValueSchema,
  })
  .strict();
export type CompilerViolation = z.infer<typeof CompilerViolationSchema>;

export const CompilerValidationReportSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-validation"),
    phase: z.enum(["request", "obligations", "proposal"]),
    status: z.enum(["valid", "repairable", "unsatisfiable"]),
    violations: z.array(CompilerViolationSchema).max(128),
  })
  .strict()
  .superRefine((report, context) => {
    const terminal = report.violations.some((violation) =>
      COMPILER_TERMINAL_VIOLATION_PHASES[violation.code]?.some((phase) => phase === report.phase),
    );
    const truncated = report.violations.some((violation) => violation.code === "report-truncated");
    const canonical =
      report.violations.length === 0
        ? "valid"
        : terminal
          ? "unsatisfiable"
          : report.status === "unsatisfiable" && truncated
            ? "unsatisfiable"
            : "repairable";
    if (report.status !== canonical)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: `status must be ${canonical} for its phase and violations`,
      });
  });
export type CompilerValidationReport = z.infer<typeof CompilerValidationReportSchema>;

export const RepositoryCapabilityOperationSchema = z
  .object({ kind: Id, key: z.string().min(1).max(160) })
  .strict();

export const ValidationIntentRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observed"), recipeId: Id }).strict(),
  z
    .object({
      kind: z.literal("scoped-node-test"),
      targets: z.array(RepositoryScopePathSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deferred"),
      adapterId: Id,
      operation: RepositoryCapabilityOperationSchema,
    })
    .strict(),
]);
export type ValidationIntentRef = z.infer<typeof ValidationIntentRefSchema>;

export const CompilerCriterionSchema = z
  .object({
    id: Id,
    text: z.string().min(1).max(2_000),
    risk: z.enum([
      "ordinary",
      "safety",
      "security",
      "destructive-action",
      "accounting",
      "recovery",
    ]),
    validation: z
      .array(
        z
          .object({
            tier: z.enum(["mechanical", "semantic", "visual", "deterministic-simulation"]),
            evidence: z.array(ValidationIntentRefSchema).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export const CompilerWorkItemProposalSchema = z
  .object({
    id: Id,
    title: z.string().min(1).max(256),
    goal: Text,
    obligationIds: z.array(z.string().min(1).max(160)).max(128),
    criteria: z.array(CompilerCriterionSchema).min(1).max(64),
    scope: z.array(RepositoryScopePathSchema).min(1).max(64),
    preconditions: z.array(z.string().min(1).max(2_000)).max(64),
    outOfScope: z.array(z.string().min(1).max(2_000)).max(64),
    conventions: z.array(z.string().min(1).max(2_000)).max(64),
    dependsOn: z.array(Id).max(50),
    exclusiveResources: z
      .array(
        z
          .string()
          .min(1)
          .max(160)
          .regex(/^[a-z0-9][a-z0-9:._/-]*$/)
          .refine(
            (value) =>
              !value.split("/").some((part) => part === ".." || part === "." || part === ""),
            "resource identity contains traversal or empty components",
          ),
      )
      .max(64),
    executionIntent: z
      .object({
        estimatedDurationMinutes: z.number().int().min(1).max(1_440).nullable(),
        additionalTools: z.array(Id).max(64),
        services: z.array(Id).max(64),
        additionalNetworkDestinations: z.array(NetworkDestinationSchema).max(64),
        trust: z.enum(["trusted_local", "isolated", "managed"]),
      })
      .strict(),
  })
  .strict();
export type CompilerWorkItemProposal = z.infer<typeof CompilerWorkItemProposalSchema>;

export const ProposedObjectiveAcceptanceSchema = z
  .object({
    id: Id,
    kind: z.enum(["owned", "aggregate-integration"]),
    text: z.string().min(1).max(2_000),
  })
  .strict();

export const ProposedObjectiveOutputSchema = z
  .object({
    id: Id,
    description: Text,
    completionAcceptanceIds: z.array(Id).min(1).max(64),
  })
  .strict();

export const ProposedObjectivePrerequisiteOutputSchema = z
  .object({ objectiveId: Id, outputId: Id })
  .strict();

export const ProposedObjectivePlanningEstimateSchema = z
  .object({
    workItems: z.number().int().min(1).max(100).nullable(),
    criticalPathMinutes: z.number().positive().max(43_200).nullable(),
    aggregateWorkMinutes: z.number().positive().max(432_000).nullable(),
    basis: Text,
  })
  .strict();

export const ProposedObjectiveSchema = z
  .object({
    id: Id,
    title: z.string().min(1).max(256),
    outcome: Text,
    acceptance: z.array(ProposedObjectiveAcceptanceSchema).min(1).max(64),
    ownedScope: z.array(RepositoryScopePathSchema).min(1).max(64),
    obligationIds: z.array(z.string().min(1).max(160)).max(128),
    planningEstimate: ProposedObjectivePlanningEstimateSchema,
    outputs: z.array(ProposedObjectiveOutputSchema).min(1).max(64),
    prerequisiteOutputs: z.array(ProposedObjectivePrerequisiteOutputSchema).max(64),
  })
  .strict();
export type ProposedObjective = z.infer<typeof ProposedObjectiveSchema>;

export const RequirementDispositionSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      obligationId: z.string().min(1).max(160),
      disposition: z.literal("owned"),
      objectiveId: Id,
      acceptanceId: Id,
    })
    .strict(),
  z
    .object({
      obligationId: z.string().min(1).max(160),
      disposition: z.literal("aggregate-integration"),
      objectiveId: Id,
      acceptanceId: Id,
    })
    .strict(),
  z
    .object({
      obligationId: z.string().min(1).max(160),
      disposition: z.literal("deferred"),
      reason: Text,
    })
    .strict(),
]);
export type RequirementDisposition = z.infer<typeof RequirementDispositionSchema>;

export const PlanningTriggerSchema = z
  .object({
    code: z.enum([
      "work-item-threshold",
      "critical-path-threshold",
      "aggregate-work-threshold",
      "compiler-envelope-threshold",
      "independent-milestones",
      "resource-boundary",
      "authorization-boundary",
    ]),
    source: z.enum(["obligation-inventory", "pinned-repository", "run-policy", "projected-graph"]),
    availability: z.enum(["observed", "estimated", "unavailable"]),
    observed: z.union([z.number().finite(), z.string().min(1).max(2_000), z.null()]),
    threshold: z.number().finite().nullable(),
    obligationIds: z.array(z.string().min(1).max(160)).min(1).max(128),
    explanation: Text,
  })
  .strict();
export type PlanningTrigger = z.infer<typeof PlanningTriggerSchema>;

export const ClarificationRequirementSchema = z
  .object({
    id: Id,
    question: z.string().min(1).max(2_000),
    reason: Text,
    obligationIds: z.array(z.string().min(1).max(160)).min(1).max(128),
  })
  .strict();
export type ClarificationRequirement = z.infer<typeof ClarificationRequirementSchema>;

export const CompilerWorkItemsProposalSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-proposal"),
    kind: z.literal("work-items"),
    workItems: z.array(CompilerWorkItemProposalSchema).min(1).max(100),
    mediaIntents: z.array(MediaIntentSchema).max(32),
  })
  .strict();
const CompilerObjectivesProposalSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-proposal"),
    kind: z.literal("objectives"),
    objectives: z.array(ProposedObjectiveSchema).min(2).max(32),
    coverage: z.array(RequirementDispositionSchema).min(1).max(128),
    triggers: z.array(PlanningTriggerSchema).min(1).max(32),
  })
  .strict();
const CompilerClarificationProposalSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-proposal"),
    kind: z.literal("clarification"),
    requirements: z.array(ClarificationRequirementSchema).min(1).max(32),
    triggers: z.array(PlanningTriggerSchema).min(1).max(32),
  })
  .strict();
export const CompilerProposalSchema = z.discriminatedUnion("kind", [
  CompilerWorkItemsProposalSchema,
  CompilerObjectivesProposalSchema,
  CompilerClarificationProposalSchema,
]);
export type CompilerProposalValue = z.infer<typeof CompilerProposalSchema>;
export type CompilerProposal = z.infer<typeof CompilerWorkItemsProposalSchema>;
export type CompilerWorkItemsProposal = CompilerProposal;
export type CompilerObjectivesProposal = z.infer<typeof CompilerObjectivesProposalSchema>;
export type CompilerClarificationProposal = z.infer<typeof CompilerClarificationProposalSchema>;

/** Provider structured-output schemas require one root object with every field
 * required. Convert that strict wire envelope into the canonical discriminated
 * proposal; this is a current provider boundary, not a legacy format adapter. */
export function normalizeCompilerProposalProviderOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const arrays = [
    "workItems",
    "mediaIntents",
    "objectives",
    "coverage",
    "triggers",
    "requirements",
  ] as const;
  if (!arrays.every((field) => Array.isArray(candidate[field]))) return value;
  const providerKeys = ["protocol", "kind", ...arrays].sort();
  if (
    Object.keys(candidate)
      .sort()
      .some((key, index) => key !== providerKeys[index]) ||
    Object.keys(candidate).length !== providerKeys.length
  )
    return value;
  const empty = (field: (typeof arrays)[number]) => (candidate[field] as unknown[]).length === 0;
  if (
    candidate.kind === "work-items" &&
    empty("objectives") &&
    empty("coverage") &&
    empty("triggers") &&
    empty("requirements")
  )
    return {
      protocol: candidate.protocol,
      kind: candidate.kind,
      workItems: candidate.workItems,
      mediaIntents: candidate.mediaIntents,
    };
  if (
    candidate.kind === "objectives" &&
    empty("workItems") &&
    empty("mediaIntents") &&
    empty("requirements")
  )
    return {
      protocol: candidate.protocol,
      kind: candidate.kind,
      objectives: candidate.objectives,
      coverage: candidate.coverage,
      triggers: candidate.triggers,
    };
  if (
    candidate.kind === "clarification" &&
    empty("workItems") &&
    empty("mediaIntents") &&
    empty("objectives") &&
    empty("coverage")
  )
    return {
      protocol: candidate.protocol,
      kind: candidate.kind,
      requirements: candidate.requirements,
      triggers: candidate.triggers,
    };
  return value;
}

export const CompilerValidationRecipeSchema = z
  .object({
    id: Id,
    command: z.string().min(1).max(1_000),
    adapterId: Id.nullable(),
    requiredTools: z.array(Id).max(16),
    networkDestinations: z.array(z.string().min(1).max(253)).max(16),
  })
  .strict();
export type CompilerValidationRecipe = z.infer<typeof CompilerValidationRecipeSchema>;

export const CompilerToolchainCapabilitySchema = z
  .object({
    adapterId: Id,
    state: z.enum([
      "observed",
      "eligible-deferred",
      "partial",
      "mixed",
      "policy-blocked",
      "unsupported",
    ]),
    contract: z.string().min(1).max(160),
    rootAuthorityPaths: z.array(RepositoryScopePathSchema).max(16),
    generationAuthorityPaths: z.array(RepositoryScopePathSchema).max(16),
    requiredTools: z.array(Id).max(16),
    networkDestinations: z.array(z.string().min(1).max(253)).max(16),
    runtimePins: z
      .array(
        z
          .object({
            path: RepositoryScopePathSchema,
            fields: z.array(z.string().min(1).max(160)).max(16),
            source: z.literal("activated-runtime"),
          })
          .strict(),
      )
      .max(16),
    mixedAuthority: z.literal("reject"),
    descendants: z
      .object({
        allowed: z.boolean(),
        requiresTransitiveProviderAncestor: z.boolean(),
      })
      .strict(),
    operation: z
      .object({
        kind: Id,
        keySchema: z.record(z.unknown()),
        providerCommandCount: z.object({ min: z.literal(1), max: z.literal(1) }).strict(),
        maxProvisionedOperations: z.literal(32),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CompilerToolchainCapability = z.infer<typeof CompilerToolchainCapabilitySchema>;

const CompilerValidationSurfaceSchema = z
  .object({
    count: z.number().int().min(0).max(10_000),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    sample: z.array(RepositoryScopePathSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sample.length > value.count)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sample"],
        message: "sample cannot exceed the represented path count",
      });
  });

const CompilerJudgeFindingsSchema = CompilerJudgeVerdictSchema.shape.findings;
export type CompilerJudgeFinding = CompilerJudgeVerdict["findings"][number];

export const CompilerRequestSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-request"),
    revision: z.number().int().min(0).max(2),
    objective: z
      .object({
        number: z.number().int().positive(),
        title: z.string().min(1).max(256),
        body: z.string().max(384 * 1024),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    inventory: ObligationInventorySchema,
    inventorySource: z.enum(["structural-source", "independent-extraction"]),
    repository: z
      .object({
        manifests: z.array(RepositoryScopePathSchema).max(64),
        requiredTools: z.array(Id).max(64),
        validationRecipes: z.array(CompilerValidationRecipeSchema).max(128),
        toolchains: z.array(CompilerToolchainCapabilitySchema).max(32),
        validationSurfaces: z
          .object({
            deterministicSimulation: CompilerValidationSurfaceSchema,
            visual: CompilerValidationSurfaceSchema,
            python: CompilerValidationSurfaceSchema,
            rust: CompilerValidationSurfaceSchema,
            go: CompilerValidationSurfaceSchema,
          })
          .strict(),
        pathCount: z.number().int().min(0).max(10_000),
      })
      .strict(),
    media: CompilerMediaFactsSchema,
    constraints: z
      .object({
        maxWorkItems: z.number().int().min(1).max(100),
        planningWorkItemThreshold: z.number().int().min(1).max(100),
        planningCriticalPathMinutes: z
          .number()
          .positive()
          .max(30 * 24 * 60),
        planningAggregateWorkMinutes: z
          .number()
          .positive()
          .max(300 * 24 * 60),
        maxDependenciesPerItem: z.number().int().min(0).max(50),
        allowedNetworkDestinations: z.array(z.string().min(1).max(253)).max(64),
        workItemTimeoutMinutes: z.number().int().min(1).max(1_440),
      })
      .strict(),
    previousProposal: CompilerProposalSchema.nullable(),
    validationReport: CompilerValidationReportSchema,
    semanticFindings: CompilerJudgeFindingsSchema,
    challenges: CompilerInferenceChallengesSchema,
  })
  .strict();
export type CompilerRequest = z.infer<typeof CompilerRequestSchema> & {
  inventory: ObligationInventory;
  semanticFindings: CompilerJudgeVerdict["findings"];
  challenges: CompilerInferenceChallenge[];
};

const stringArray = (maxItems: number, item: Record<string, unknown> = { type: "string" }) => ({
  type: "array",
  maxItems,
  items: item,
});
const strictObject = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const jsonId = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]*$",
  maxLength: 64,
};
const jsonEvalId = { type: "string", minLength: 1, maxLength: 160 };
const jsonText = { type: "string", minLength: 1, maxLength: 4_000 };
const jsonDigest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const jsonBaseSha = { type: "string", pattern: "^[a-f0-9]{40}$" };
const jsonScopePath = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  pattern: "^(?!/)(?!.*\\\\)(?!.*//)(?!.*[*?\\[])(?!.*(?:^|/)\\.\\.?(?:/|$)).+$",
};
const providerJsonScopePath = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  // Provider regex shapes syntax; RepositoryScopePathSchema owns segment and relativity checks.
  pattern: "^[^\\\\*?\\[]+$",
};
const jsonNetworkDestination = {
  type: "string",
  minLength: 1,
  maxLength: 253,
  pattern:
    "^(?!.*(?:^|\\.)[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]$)(?![Mm][Ee][Tt][Aa][Dd][Aa][Tt][Aa]\\.[Gg][Oo][Oo][Gg][Ll][Ee]\\.[Ii][Nn][Tt][Ee][Rr][Nn][Aa][Ll]$)(?:\\*\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
};
const providerJsonNetworkDestination = {
  type: "string",
  minLength: 1,
  maxLength: 253,
  // NetworkDestinationSchema deterministically excludes local and instance-metadata endpoints.
  pattern: "^(?:\\*\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
};
const jsonDiagnostic = {
  type: ["null", "boolean", "number", "string", "array", "object"],
};
const jsonRefs = (minimum = 0) => ({
  type: "array",
  minItems: minimum,
  maxItems: 128,
  items: jsonEvalId,
});
const intentSchema = (scopePath: Record<string, unknown>) => ({
  anyOf: [
    strictObject({ kind: { type: "string", const: "observed" }, recipeId: jsonId }),
    strictObject({
      kind: { type: "string", const: "scoped-node-test" },
      targets: { type: "array", minItems: 1, maxItems: 32, items: scopePath },
    }),
    strictObject({
      kind: { type: "string", const: "deferred" },
      adapterId: jsonId,
      operation: strictObject({
        kind: jsonId,
        key: { type: "string", minLength: 1, maxLength: 160 },
      }),
    }),
  ],
});

const jsonCompilerWorkItemProposal = (
  scopePath: Record<string, unknown>,
  networkDestination: Record<string, unknown>,
  exclusiveResourcePattern: string,
) =>
  strictObject({
    id: jsonId,
    title: { type: "string", minLength: 1, maxLength: 256 },
    goal: { type: "string", minLength: 1, maxLength: 4_000 },
    obligationIds: stringArray(128, { type: "string", minLength: 1, maxLength: 160 }),
    criteria: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: strictObject({
        id: jsonId,
        text: { type: "string", minLength: 1, maxLength: 2_000 },
        risk: {
          type: "string",
          enum: ["ordinary", "safety", "security", "destructive-action", "accounting", "recovery"],
        },
        validation: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: strictObject({
            tier: {
              type: "string",
              enum: ["mechanical", "semantic", "visual", "deterministic-simulation"],
            },
            evidence: stringArray(32, intentSchema(scopePath)),
          }),
        },
      }),
    },
    scope: { type: "array", minItems: 1, maxItems: 64, items: scopePath },
    preconditions: stringArray(64, { type: "string", minLength: 1, maxLength: 2_000 }),
    outOfScope: stringArray(64, { type: "string", minLength: 1, maxLength: 2_000 }),
    conventions: stringArray(64, { type: "string", minLength: 1, maxLength: 2_000 }),
    dependsOn: stringArray(50, jsonId),
    exclusiveResources: stringArray(64, {
      type: "string",
      minLength: 1,
      maxLength: 160,
      pattern: exclusiveResourcePattern,
    }),
    executionIntent: strictObject({
      estimatedDurationMinutes: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 1_440,
      },
      additionalTools: stringArray(64, jsonId),
      services: stringArray(64, jsonId),
      additionalNetworkDestinations: stringArray(64, networkDestination),
      trust: { type: "string", enum: ["trusted_local", "isolated", "managed"] },
    }),
  });
const jsonMediaIntent = strictObject({
  id: jsonId,
  role: jsonId,
  purpose: {
    type: "string",
    enum: ["decision-input", "implementation-reference", "product-asset", "acceptance-evidence"],
  },
  necessity: { type: "string", enum: ["required", "helpful"] },
  obligationIds: { ...stringArray(128, jsonEvalId), minItems: 1 },
  rationale: { type: "string", minLength: 1, maxLength: 2_000 },
  brief: jsonText,
  fulfillment: {
    anyOf: [
      strictObject({
        kind: { type: "string", const: "imported" },
        assetIds: { ...stringArray(32, jsonId), minItems: 1, uniqueItems: true },
      }),
      strictObject({
        kind: { type: "string", const: "produced" },
        inputRoleBindings: {
          type: "array",
          maxItems: 8,
          items: strictObject({
            roleId: jsonId,
            importedAssetIds: { ...stringArray(32, jsonId), uniqueItems: true },
            inputIntentIds: { ...stringArray(32, jsonId), uniqueItems: true },
          }),
        },
      }),
    ],
  },
  output: strictObject({
    mediaTypes: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        pattern:
          "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}$",
      },
    },
    minimumCount: { type: "integer", minimum: 1, maximum: 16 },
    maximumCount: { type: "integer", minimum: 1, maximum: 16 },
    raster: {
      anyOf: [
        { type: "null" },
        strictObject({
          minimumWidth: { type: ["integer", "null"], minimum: 1, maximum: 16_384 },
          maximumWidth: { type: ["integer", "null"], minimum: 1, maximum: 16_384 },
          minimumHeight: { type: ["integer", "null"], minimum: 1, maximum: 16_384 },
          maximumHeight: { type: ["integer", "null"], minimum: 1, maximum: 16_384 },
          alpha: { type: "string", enum: ["allowed", "required", "forbidden"] },
          animation: { type: "string", enum: ["allowed", "required", "forbidden"] },
        }),
      ],
    },
  }),
  review: {
    anyOf: [
      strictObject({ kind: { type: "string", const: "human-required" } }),
      strictObject({
        kind: { type: "string", const: "deterministic-preauthorized" },
        ruleId: jsonId,
      }),
    ],
  },
  bindings: {
    type: "array",
    maxItems: 64,
    items: strictObject({
      workItemId: jsonId,
      direction: { type: "string", enum: ["input-to", "evidence-for"] },
      criterionIds: { ...stringArray(64, jsonId), uniqueItems: true },
    }),
  },
});
const jsonCompilerMediaFacts = strictObject({
  assetManifest: {
    anyOf: [
      { type: "null" },
      strictObject({
        digest: jsonDigest,
        assets: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: strictObject({
            id: jsonId,
            mediaType: {
              type: "string",
              minLength: 1,
              maxLength: 160,
              pattern:
                "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}$",
            },
            bytes: { type: "integer", minimum: 1, maximum: 100 * 1024 * 1024 },
            inspection: {
              anyOf: [
                strictObject({ kind: { type: "string", const: "opaque" } }),
                strictObject({
                  kind: { type: "string", const: "raster" },
                  width: { type: "integer", minimum: 1, maximum: 16_384 },
                  height: { type: "integer", minimum: 1, maximum: 16_384 },
                  frames: { type: "integer", minimum: 1, maximum: 16 },
                  alpha: { type: "boolean" },
                }),
              ],
            },
            visibility: { type: "string", enum: ["public", "private"] },
          }),
        },
      }),
    ],
  },
  assetEgress: strictObject({
    mode: { type: "string", enum: ["denied", "public-assets", "private-assets"] },
    policyDigest: jsonDigest,
  }),
  producerCapabilities: {
    type: "array",
    maxItems: 16,
    items: strictObject({
      id: jsonId,
      capabilityDigest: jsonDigest,
      roles: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: jsonId,
      },
      purposes: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "string",
          enum: [
            "decision-input",
            "implementation-reference",
            "product-asset",
            "acceptance-evidence",
          ],
        },
      },
      mediaTypes: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          pattern:
            "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}$",
        },
      },
      outputVisibility: { type: "string", enum: ["public", "private"] },
      outputRightsBasis: {
        type: "string",
        enum: ["user-owned", "licensed", "permission-granted", "unknown"],
      },
      inputRoles: {
        type: "array",
        maxItems: 8,
        items: strictObject({
          id: jsonId,
          mediaTypes: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 160,
              pattern:
                "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}$",
            },
          },
          minimumCount: { type: "integer", minimum: 0, maximum: 32 },
          maximumCount: { type: "integer", minimum: 0, maximum: 32 },
          semantics: jsonId,
        }),
      },
      maximumCount: { type: "integer", minimum: 1, maximum: 16 },
      raster: {
        anyOf: [
          { type: "null" },
          strictObject({
            maximumWidth: { type: "integer", minimum: 1, maximum: 16_384 },
            maximumHeight: { type: "integer", minimum: 1, maximum: 16_384 },
            supportsAlpha: { type: "boolean" },
            supportsAnimation: { type: "boolean" },
          }),
        ],
      },
    }),
  },
  reviewRules: {
    type: "array",
    maxItems: 16,
    items: strictObject({
      id: jsonId,
      kind: { type: "string", const: "deterministic-preauthorized" },
      producerCapabilityIds: { ...stringArray(16, jsonId), minItems: 1 },
      roles: { ...stringArray(16, jsonId), minItems: 1 },
      purposes: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "string",
          enum: [
            "decision-input",
            "implementation-reference",
            "product-asset",
            "acceptance-evidence",
          ],
        },
      },
      mediaTypes: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          pattern:
            "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}$",
        },
      },
      profiles: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string", enum: ["binary", "raster"] },
      },
      outputVisibilities: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string", enum: ["public", "private"] },
      },
      rightsBases: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "string",
          enum: ["user-owned", "licensed", "permission-granted", "unknown"],
        },
      },
    }),
  },
});
const jsonPlanningTrigger = strictObject({
  code: {
    type: "string",
    enum: [
      "work-item-threshold",
      "critical-path-threshold",
      "aggregate-work-threshold",
      "compiler-envelope-threshold",
      "independent-milestones",
      "resource-boundary",
      "authorization-boundary",
    ],
  },
  source: {
    type: "string",
    enum: ["obligation-inventory", "pinned-repository", "run-policy", "projected-graph"],
  },
  availability: { type: "string", enum: ["observed", "estimated", "unavailable"] },
  observed: { type: ["number", "string", "null"], minLength: 1, maxLength: 2_000 },
  threshold: { type: ["number", "null"] },
  obligationIds: {
    ...stringArray(128, { type: "string", minLength: 1, maxLength: 160 }),
    minItems: 1,
  },
  explanation: jsonText,
});
const jsonProposedObjectiveAcceptance = strictObject({
  id: jsonId,
  kind: { type: "string", enum: ["owned", "aggregate-integration"] },
  text: { type: "string", minLength: 1, maxLength: 2_000 },
});
const jsonProposedObjective = strictObject({
  id: jsonId,
  title: { type: "string", minLength: 1, maxLength: 256 },
  outcome: jsonText,
  acceptance: {
    type: "array",
    minItems: 1,
    maxItems: 64,
    items: jsonProposedObjectiveAcceptance,
  },
  ownedScope: { type: "array", minItems: 1, maxItems: 64, items: providerJsonScopePath },
  obligationIds: stringArray(128, { type: "string", minLength: 1, maxLength: 160 }),
  planningEstimate: strictObject({
    workItems: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    criticalPathMinutes: {
      type: ["number", "null"],
      exclusiveMinimum: 0,
      maximum: 43_200,
    },
    aggregateWorkMinutes: {
      type: ["number", "null"],
      exclusiveMinimum: 0,
      maximum: 432_000,
    },
    basis: jsonText,
  }),
  outputs: {
    type: "array",
    minItems: 1,
    maxItems: 64,
    items: strictObject({
      id: jsonId,
      description: jsonText,
      completionAcceptanceIds: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: jsonId,
      },
    }),
  },
  prerequisiteOutputs: {
    type: "array",
    maxItems: 64,
    items: strictObject({ objectiveId: jsonId, outputId: jsonId }),
  },
});
const jsonRequirementDisposition = {
  anyOf: [
    strictObject({
      obligationId: jsonEvalId,
      disposition: { type: "string", const: "owned" },
      objectiveId: jsonId,
      acceptanceId: jsonId,
    }),
    strictObject({
      obligationId: jsonEvalId,
      disposition: { type: "string", const: "aggregate-integration" },
      objectiveId: jsonId,
      acceptanceId: jsonId,
    }),
    strictObject({
      obligationId: jsonEvalId,
      disposition: { type: "string", const: "deferred" },
      reason: jsonText,
    }),
  ],
};
const compilerProposalSchemas = (
  scopePath: Record<string, unknown>,
  networkDestination: Record<string, unknown>,
  exclusiveResourcePattern: string,
) => {
  const workItem = jsonCompilerWorkItemProposal(
    scopePath,
    networkDestination,
    exclusiveResourcePattern,
  );
  const proposedObjective = {
    ...jsonProposedObjective,
    properties: {
      ...jsonProposedObjective.properties,
      ownedScope: { type: "array", minItems: 1, maxItems: 64, items: scopePath },
    },
  };
  const clarificationRequirement = strictObject({
    id: jsonId,
    question: { type: "string", minLength: 1, maxLength: 2_000 },
    reason: jsonText,
    obligationIds: { ...stringArray(128, jsonEvalId), minItems: 1 },
  });
  const variants = [
    strictObject({
      protocol: { type: "string", const: "clockgrove.factory/compiler-proposal" },
      kind: { type: "string", const: "work-items" },
      workItems: { type: "array", minItems: 1, maxItems: 100, items: workItem },
      mediaIntents: { type: "array", maxItems: 32, items: jsonMediaIntent },
    }),
    strictObject({
      protocol: { type: "string", const: "clockgrove.factory/compiler-proposal" },
      kind: { type: "string", const: "objectives" },
      objectives: { type: "array", minItems: 2, maxItems: 32, items: proposedObjective },
      coverage: { type: "array", minItems: 1, maxItems: 128, items: jsonRequirementDisposition },
      triggers: { type: "array", minItems: 1, maxItems: 32, items: jsonPlanningTrigger },
    }),
    strictObject({
      protocol: { type: "string", const: "clockgrove.factory/compiler-proposal" },
      kind: { type: "string", const: "clarification" },
      requirements: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: clarificationRequirement,
      },
      triggers: { type: "array", minItems: 1, maxItems: 32, items: jsonPlanningTrigger },
    }),
  ];
  const provider = strictObject({
    protocol: { type: "string", const: "clockgrove.factory/compiler-proposal" },
    kind: { type: "string", enum: ["work-items", "objectives", "clarification"] },
    workItems: { type: "array", maxItems: 100, items: workItem },
    mediaIntents: { type: "array", maxItems: 32, items: jsonMediaIntent },
    objectives: { type: "array", maxItems: 32, items: proposedObjective },
    coverage: { type: "array", maxItems: 128, items: jsonRequirementDisposition },
    triggers: { type: "array", maxItems: 32, items: jsonPlanningTrigger },
    requirements: { type: "array", maxItems: 32, items: clarificationRequirement },
  });
  return { provider, durable: { anyOf: variants } };
};

const providerCompilerProposalObjectSchema = compilerProposalSchemas(
  providerJsonScopePath,
  providerJsonNetworkDestination,
  "^[a-z0-9][a-z0-9:._/-]*$",
).provider;
const durableCompilerProposalObjectSchema = compilerProposalSchemas(
  jsonScopePath,
  jsonNetworkDestination,
  "^(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//)(?!.*\\/$)[a-z0-9][a-z0-9:._/-]*$",
).durable;

export const COMPILER_PROPOSAL_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...providerCompilerProposalObjectSchema,
} as const;

const jsonEvidence = strictObject({
  id: jsonEvalId,
  kind: { enum: ["objective", "repository", "artifact", "receipt"] },
  identity: jsonText,
  excerpt: jsonText,
});
const jsonObligation = strictObject({
  id: jsonEvalId,
  text: jsonText,
  kind: { enum: ["explicit", "prerequisite", "ambiguity"] },
  evidenceIds: jsonRefs(1),
  acceptanceEvidence: jsonText,
});
const jsonInventory = strictObject({
  version: { const: 1 },
  objectiveDigest: jsonDigest,
  baseSha: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
  evidence: { type: "array", minItems: 1, maxItems: 128, items: jsonEvidence },
  obligations: { type: "array", minItems: 1, maxItems: 128, items: jsonObligation },
});
const jsonViolation = strictObject({
  code: { enum: COMPILER_VIOLATION_CODES },
  itemId: { oneOf: [jsonId, { type: "null" }] },
  field: {
    type: "string",
    maxLength: 1_000,
    pattern: "^(?:|(?:/(?:[^~/]|~0|~1)*)+)$",
  },
  expected: jsonDiagnostic,
  observed: jsonDiagnostic,
});
const jsonTerminalViolationCodes = Object.keys(COMPILER_TERMINAL_VIOLATION_PHASES);
const jsonConditional = (condition: object, consequence: object) =>
  Object.fromEntries([
    ["if", condition],
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema defines this conditional keyword.
    ["then", consequence],
  ]);
const jsonValidationReport = {
  ...strictObject({
    protocol: { const: "clockgrove.factory/compiler-validation" },
    phase: { enum: ["request", "obligations", "proposal"] },
    status: { enum: ["valid", "repairable", "unsatisfiable"] },
    violations: { type: "array", maxItems: 128, items: jsonViolation },
  }),
  allOf: [
    jsonConditional(
      { properties: { violations: { maxItems: 0 } }, required: ["violations"] },
      { properties: { status: { const: "valid" } }, required: ["status"] },
    ),
    jsonConditional(
      { properties: { status: { const: "valid" } }, required: ["status"] },
      { properties: { violations: { maxItems: 0 } }, required: ["violations"] },
    ),
    jsonConditional(
      {
        properties: {
          phase: { const: "request" },
          violations: { contains: { properties: { code: { enum: jsonTerminalViolationCodes } } } },
        },
        required: ["phase", "violations"],
      },
      { properties: { status: { const: "unsatisfiable" } }, required: ["status"] },
    ),
    jsonConditional(
      {
        properties: {
          violations: {
            minItems: 1,
            not: { contains: { properties: { code: { const: "report-truncated" } } } },
          },
        },
        required: ["violations"],
        not: {
          properties: {
            phase: { const: "request" },
            violations: {
              contains: { properties: { code: { enum: jsonTerminalViolationCodes } } },
            },
          },
          required: ["phase", "violations"],
        },
      },
      { properties: { status: { const: "repairable" } }, required: ["status"] },
    ),
  ],
};
const jsonRecipe = strictObject({
  id: jsonId,
  command: { type: "string", minLength: 1, maxLength: 1_000 },
  adapterId: { oneOf: [jsonId, { type: "null" }] },
  requiredTools: stringArray(16, jsonId),
  networkDestinations: stringArray(16, { type: "string", minLength: 1, maxLength: 253 }),
});
const jsonToolchain = strictObject({
  adapterId: jsonId,
  state: {
    enum: ["observed", "eligible-deferred", "partial", "mixed", "policy-blocked", "unsupported"],
  },
  contract: { type: "string", minLength: 1, maxLength: 160 },
  rootAuthorityPaths: stringArray(16, jsonScopePath),
  generationAuthorityPaths: stringArray(16, jsonScopePath),
  requiredTools: stringArray(16, jsonId),
  networkDestinations: stringArray(16, { type: "string", minLength: 1, maxLength: 253 }),
  runtimePins: {
    type: "array",
    maxItems: 16,
    items: strictObject({
      path: jsonScopePath,
      fields: stringArray(16, { type: "string", minLength: 1, maxLength: 160 }),
      source: { const: "activated-runtime" },
    }),
  },
  mixedAuthority: { const: "reject" },
  descendants: strictObject({
    allowed: { type: "boolean" },
    requiresTransitiveProviderAncestor: { type: "boolean" },
  }),
  operation: {
    oneOf: [
      { type: "null" },
      strictObject({
        kind: jsonId,
        keySchema: { type: "object" },
        providerCommandCount: strictObject({ min: { const: 1 }, max: { const: 1 } }),
        maxProvisionedOperations: { const: 32 },
      }),
    ],
  },
});
const judgeDimension = {
  enum: [
    "coverage",
    "executability",
    "acceptance-quality",
    "validation-sufficiency",
    "granularity",
    "parallel-execution",
    "scope-discipline",
    "necessity-reuse",
    "composition-handoffs",
    "assumption-grounding",
    "context-sufficiency",
    "failure-isolation",
    "priority-feedback",
  ],
};
const jsonFinding = strictObject({
  id: jsonEvalId,
  dimension: judgeDimension,
  severity: { enum: ["advisory", "material-efficiency", "blocking"] },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  obligationIds: jsonRefs(),
  itemIds: jsonRefs(),
  evidenceIds: jsonRefs(1),
  rootCause: jsonText,
  correction: jsonText,
  uncertainty: { type: "string", maxLength: 4_000 },
});
const jsonOriginalFinding = strictObject({
  dimension: judgeDimension,
  rootCause: jsonText,
  correction: jsonText,
  itemIds: jsonRefs(1),
});
const jsonChallenge = {
  type: "object",
  additionalProperties: false,
  properties: {
    findingId: jsonEvalId,
    obligationId: jsonEvalId,
    originalFinding: jsonOriginalFinding,
    reason: jsonText,
    evidenceIds: jsonRefs(1),
  },
  required: ["findingId", "reason", "evidenceIds"],
  anyOf: [{ required: ["obligationId"] }, { required: ["originalFinding"] }],
};
const jsonValidationSurface = {
  ...strictObject({
    count: { type: "integer", minimum: 0, maximum: 10_000 },
    digest: jsonDigest,
    sample: stringArray(32, jsonScopePath),
  }),
  allOf: Array.from({ length: 32 }, (_, count) =>
    jsonConditional(
      { properties: { count: { const: count } }, required: ["count"] },
      { properties: { sample: { maxItems: count } }, required: ["sample"] },
    ),
  ),
};

/** Full transport schema used for parity and durable-fixture validation. */
export const COMPILER_REQUEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...strictObject({
    protocol: { const: "clockgrove.factory/compiler-request" },
    revision: { type: "integer", minimum: 0, maximum: 2 },
    objective: strictObject({
      number: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: 384 * 1024 },
      digest: jsonDigest,
    }),
    baseSha: jsonBaseSha,
    inventory: jsonInventory,
    inventorySource: { enum: ["structural-source", "independent-extraction"] },
    repository: strictObject({
      manifests: stringArray(64, jsonScopePath),
      requiredTools: stringArray(64, jsonId),
      validationRecipes: { type: "array", maxItems: 128, items: jsonRecipe },
      toolchains: { type: "array", maxItems: 32, items: jsonToolchain },
      validationSurfaces: strictObject({
        deterministicSimulation: jsonValidationSurface,
        visual: jsonValidationSurface,
        python: jsonValidationSurface,
        rust: jsonValidationSurface,
        go: jsonValidationSurface,
      }),
      pathCount: { type: "integer", minimum: 0, maximum: 10_000 },
    }),
    media: jsonCompilerMediaFacts,
    constraints: strictObject({
      maxWorkItems: { type: "integer", minimum: 1, maximum: 100 },
      planningWorkItemThreshold: { type: "integer", minimum: 1, maximum: 100 },
      planningCriticalPathMinutes: { type: "number", exclusiveMinimum: 0, maximum: 43_200 },
      planningAggregateWorkMinutes: { type: "number", exclusiveMinimum: 0, maximum: 432_000 },
      maxDependenciesPerItem: { type: "integer", minimum: 0, maximum: 50 },
      allowedNetworkDestinations: stringArray(64, {
        type: "string",
        minLength: 1,
        maxLength: 253,
      }),
      workItemTimeoutMinutes: { type: "integer", minimum: 1, maximum: 1_440 },
    }),
    previousProposal: { oneOf: [{ type: "null" }, durableCompilerProposalObjectSchema] },
    validationReport: jsonValidationReport,
    semanticFindings: { type: "array", maxItems: 64, items: jsonFinding },
    challenges: {
      type: "array",
      maxItems: MAX_COMPILER_INFERENCE_CHALLENGES,
      items: jsonChallenge,
      allOf: [
        {
          contains: { required: ["obligationId"] },
          minContains: 0,
          maxContains: MAX_COMPILER_OBLIGATION_CHALLENGES,
        },
        {
          contains: { not: { required: ["obligationId"] } },
          minContains: 0,
          maxContains: MAX_COMPILER_ITEM_CHALLENGES,
        },
      ],
    },
  }),
} as const;
