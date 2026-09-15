import { z } from "zod";

import {
  CompilerInferenceChallengeSchema,
  CompilerJudgeVerdictSchema,
  ObligationInventorySchema,
  type CompilerInferenceChallenge,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import { NetworkDestinationSchema, RepositoryScopePathSchema } from "../protocol/worker-packet.js";

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
  "denied-network-destination",
  "legacy-constraint-mismatch",
  "report-truncated",
] as const;
export const CompilerViolationCodeSchema = z.enum(COMPILER_VIOLATION_CODES);
export type CompilerViolationCode = z.infer<typeof CompilerViolationCodeSchema>;

export const COMPILER_TERMINAL_VIOLATION_PHASES: Readonly<
  Partial<Record<CompilerViolationCode, readonly ["request"]>>
> = {
  "schema-invalid": ["request"],
  "partial-toolchain-authority": ["request"],
  "mixed-toolchain-authority": ["request"],
  "unsupported-toolchain": ["request"],
  "no-validation-capability": ["request"],
  "denied-network-destination": ["request"],
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

export const CompilerProposalSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-proposal"),
    workItems: z
      .array(
        z
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
                      !value
                        .split("/")
                        .some((part) => part === ".." || part === "." || part === ""),
                    "resource identity contains traversal or empty components",
                  ),
              )
              .max(64),
            executionIntent: z
              .object({
                estimatedDurationMinutes: z.number().int().min(1).max(1_440),
                additionalTools: z.array(Id).max(64),
                services: z.array(Id).max(64),
                additionalNetworkDestinations: z.array(NetworkDestinationSchema).max(64),
                trust: z.enum(["trusted_local", "isolated", "managed"]),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type CompilerProposal = z.infer<typeof CompilerProposalSchema>;

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
        validationRecipes: z.array(CompilerValidationRecipeSchema).max(128),
        toolchains: z.array(CompilerToolchainCapabilitySchema).max(32),
        validationSurfaces: z
          .object({
            deterministicSimulation: z.array(RepositoryScopePathSchema).max(256),
            visual: z.array(RepositoryScopePathSchema).max(256),
            python: z.array(RepositoryScopePathSchema).max(5_000),
            rust: z.array(RepositoryScopePathSchema).max(5_000),
            go: z.array(RepositoryScopePathSchema).max(5_000),
          })
          .strict(),
        pathCount: z.number().int().min(0).max(10_000),
      })
      .strict(),
    constraints: z
      .object({
        maxWorkItems: z.number().int().min(1).max(100),
        maxDependenciesPerItem: z.number().int().min(0).max(50),
        allowedNetworkDestinations: z.array(z.string().min(1).max(253)).max(64),
        workItemTimeoutMinutes: z.number().int().min(1).max(1_440),
      })
      .strict(),
    previousProposal: CompilerProposalSchema.nullable(),
    validationReport: CompilerValidationReportSchema,
    semanticFindings: CompilerJudgeFindingsSchema,
    challenges: z.array(CompilerInferenceChallengeSchema).max(64),
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
const jsonNetworkDestination = {
  type: "string",
  minLength: 1,
  maxLength: 253,
  pattern:
    "^(?!.*(?:^|\\.)[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]$)(?![Mm][Ee][Tt][Aa][Dd][Aa][Tt][Aa]\\.[Gg][Oo][Oo][Gg][Ll][Ee]\\.[Ii][Nn][Tt][Ee][Rr][Nn][Aa][Ll]$)(?:\\*\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
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
const intentSchema = {
  oneOf: [
    strictObject({ kind: { const: "observed" }, recipeId: jsonId }),
    strictObject({
      kind: { const: "scoped-node-test" },
      targets: { type: "array", minItems: 1, maxItems: 32, items: jsonScopePath },
    }),
    strictObject({
      kind: { const: "deferred" },
      adapterId: jsonId,
      operation: strictObject({
        kind: jsonId,
        key: { type: "string", minLength: 1, maxLength: 160 },
      }),
    }),
  ],
};

const compilerProposalObjectSchema = strictObject({
  protocol: { const: "clockgrove.factory/compiler-proposal" },
  workItems: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: strictObject({
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
            enum: [
              "ordinary",
              "safety",
              "security",
              "destructive-action",
              "accounting",
              "recovery",
            ],
          },
          validation: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: strictObject({
              tier: {
                enum: ["mechanical", "semantic", "visual", "deterministic-simulation"],
              },
              evidence: stringArray(32, intentSchema),
            }),
          },
        }),
      },
      scope: { type: "array", minItems: 1, maxItems: 64, items: jsonScopePath },
      preconditions: stringArray(64, { type: "string", minLength: 1, maxLength: 2_000 }),
      outOfScope: stringArray(64, { type: "string", minLength: 1, maxLength: 2_000 }),
      conventions: stringArray(64, { type: "string", minLength: 1, maxLength: 2_000 }),
      dependsOn: stringArray(50, jsonId),
      exclusiveResources: stringArray(64, {
        type: "string",
        minLength: 1,
        maxLength: 160,
        pattern: "^(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//)[a-z0-9][a-z0-9:._/-]*$",
      }),
      executionIntent: strictObject({
        estimatedDurationMinutes: { type: "integer", minimum: 1, maximum: 1_440 },
        additionalTools: stringArray(64, jsonId),
        services: stringArray(64, jsonId),
        additionalNetworkDestinations: stringArray(64, jsonNetworkDestination),
        trust: { enum: ["trusted_local", "isolated", "managed"] },
      }),
    }),
  },
});

export const COMPILER_PROPOSAL_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...compilerProposalObjectSchema,
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
const jsonValidationReport = strictObject({
  protocol: { const: "clockgrove.factory/compiler-validation" },
  phase: { enum: ["request", "obligations", "proposal"] },
  status: { enum: ["valid", "repairable", "unsatisfiable"] },
  violations: { type: "array", maxItems: 128, items: jsonViolation },
});
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
      validationRecipes: { type: "array", maxItems: 128, items: jsonRecipe },
      toolchains: { type: "array", maxItems: 32, items: jsonToolchain },
      validationSurfaces: strictObject({
        deterministicSimulation: stringArray(256, jsonScopePath),
        visual: stringArray(256, jsonScopePath),
        python: stringArray(5_000, jsonScopePath),
        rust: stringArray(5_000, jsonScopePath),
        go: stringArray(5_000, jsonScopePath),
      }),
      pathCount: { type: "integer", minimum: 0, maximum: 10_000 },
    }),
    constraints: strictObject({
      maxWorkItems: { type: "integer", minimum: 1, maximum: 100 },
      maxDependenciesPerItem: { type: "integer", minimum: 0, maximum: 50 },
      allowedNetworkDestinations: stringArray(64, {
        type: "string",
        minLength: 1,
        maxLength: 253,
      }),
      workItemTimeoutMinutes: { type: "integer", minimum: 1, maximum: 1_440 },
    }),
    previousProposal: { oneOf: [{ type: "null" }, compilerProposalObjectSchema] },
    validationReport: jsonValidationReport,
    semanticFindings: { type: "array", maxItems: 64, items: jsonFinding },
    challenges: { type: "array", maxItems: 64, items: jsonChallenge },
  }),
} as const;
