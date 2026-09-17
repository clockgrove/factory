import { createHash } from "node:crypto";

import {
  CompilerRepositoryCaptureGateRuleSchema,
  CompilerValidationRecipeSchema,
  RepositoryCaptureCatalogSchema,
  type CompilerRepositoryCaptureGateRule,
  type CompilerRepositoryComparator,
  type CompilerValidationRecipe,
  type RepositoryCaptureCatalog,
} from "../compiler/contracts.js";
import { compilerEvalDigest } from "../evaluation/compiler-eval.js";
import { repositoryCaptureProfileForOutput } from "../protocol/worker-packet.js";
import {
  repositoryComparatorCapability,
  repositoryComparatorContracts,
} from "./repository-comparators.js";

export const MAX_REPOSITORY_CAPTURE_DIAGNOSTICS = 64;

export type RepositoryCaptureCatalogDiagnosticCode =
  | "catalog-schema-invalid"
  | "capture-command-unobserved"
  | "comparator-unavailable"
  | "comparator-inapplicable"
  | "comparator-identity-mismatch"
  | "threshold-out-of-domain";

export interface RepositoryCaptureCatalogDiagnostic {
  code: RepositoryCaptureCatalogDiagnosticCode;
  recipeId: string | null;
  field: string;
  expected: unknown;
  observed: unknown;
}

export interface RepositoryCaptureCatalogValidationReport {
  protocol: "clockgrove.factory/repository-capture-catalog-validation";
  status: "valid" | "invalid";
  diagnostics: RepositoryCaptureCatalogDiagnostic[];
  truncated: boolean;
}

export interface BoundRepositoryCaptureCapabilities {
  validationRecipes: CompilerValidationRecipe[];
  repositoryComparators: CompilerRepositoryComparator[];
  deterministicCaptureGates: CompilerRepositoryCaptureGateRule[];
}

export interface RepositoryCaptureCatalogEvaluation {
  report: RepositoryCaptureCatalogValidationReport;
  capabilities: BoundRepositoryCaptureCapabilities | null;
}

export class RepositoryCaptureCatalogValidationError extends Error {
  constructor(readonly report: RepositoryCaptureCatalogValidationReport) {
    const first = report.diagnostics[0];
    super(
      first
        ? `repository capture catalog is invalid (${first.code} at ${first.field}; ${report.diagnostics.length} diagnostic(s))`
        : "repository capture catalog is invalid",
    );
    this.name = "RepositoryCaptureCatalogValidationError";
  }
}

export function repositoryCaptureRecipeId(command: string): string {
  return `recipe-${createHash("sha256").update(command).digest("hex").slice(0, 16)}`;
}

function pointer(path: PropertyKey[]): string {
  return path.length
    ? `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
    : "";
}

const CATALOG_SCHEMA_FIELDS = new Set([
  "captures",
  "command",
  "comparisonOutput",
  "auxiliaryOutputs",
  "profile",
  "humanReview",
  "exactDeterministicGates",
  "thresholdComparisons",
  "roleId",
  "mediaType",
  "kind",
  "viewport",
  "output",
  "diffOutput",
  "previewOutput",
  "width",
  "height",
  "policy",
  "deterministicGates",
  "id",
  "metric",
  "maximumDifference",
  "mediaTypes",
  "profiles",
  "visibilities",
  "rightsBases",
  "expectedDescriptorClasses",
  "scenarios",
  "fixture",
  "seed",
  "maximumCriteria",
]);

function safeSchemaPath(path: PropertyKey[]): PropertyKey[] {
  const safe: PropertyKey[] = [];
  for (const part of path) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) {
      safe.push(part);
      continue;
    }
    if (typeof part === "string" && CATALOG_SCHEMA_FIELDS.has(part)) {
      safe.push(part);
      continue;
    }
    safe.push("$unknown");
    break;
  }
  return safe;
}

function valueShape(value: unknown): { type: string; count?: number } {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (typeof value === "object")
    return { type: "object", count: Object.keys(value as object).length };
  return { type: typeof value };
}

function schemaValueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (part === "$unknown" || current === null || typeof current !== "object") break;
    if (typeof part === "number") {
      if (!Array.isArray(current)) break;
      current = current[part];
      continue;
    }
    if (!CATALOG_SCHEMA_FIELDS.has(String(part)) || !(part in current)) break;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

function schemaIssueClass(code: string): string {
  switch (code) {
    case "invalid_type":
      return "type";
    case "too_small":
      return "minimum-bound";
    case "too_big":
      return "maximum-bound";
    case "invalid_format":
    case "invalid_string":
      return "format";
    case "invalid_value":
    case "invalid_enum_value":
    case "invalid_literal":
      return "allowed-value";
    case "unrecognized_keys":
      return "unknown-field";
    case "invalid_union":
      return "variant";
    case "custom":
      return "cross-field-invariant";
    default:
      return "schema";
  }
}

function catalogRecipeId(value: unknown, index: number): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const command = (value as { command?: unknown }).command;
    if (typeof command === "string" && command.length > 0)
      return repositoryCaptureRecipeId(command);
  }
  return `catalog-capture-${index}`;
}

function report(
  diagnostics: RepositoryCaptureCatalogDiagnostic[],
): RepositoryCaptureCatalogValidationReport {
  const bounded = diagnostics.slice(0, MAX_REPOSITORY_CAPTURE_DIAGNOSTICS);
  return {
    protocol: "clockgrove.factory/repository-capture-catalog-validation",
    status: diagnostics.length === 0 ? "valid" : "invalid",
    diagnostics: bounded,
    truncated: diagnostics.length > bounded.length,
  };
}

function schemaDiagnostics(
  catalogInput: unknown,
  issues: Array<{ path: PropertyKey[]; code: string; keys?: unknown[] }>,
): RepositoryCaptureCatalogDiagnostic[] {
  const captures =
    catalogInput &&
    typeof catalogInput === "object" &&
    !Array.isArray(catalogInput) &&
    Array.isArray((catalogInput as { captures?: unknown }).captures)
      ? ((catalogInput as { captures: unknown[] }).captures ?? [])
      : [];
  return issues.map((issue) => {
    const safePath = safeSchemaPath(issue.path);
    const captureIndex =
      safePath[0] === "captures" && Number.isInteger(safePath[1]) ? Number(safePath[1]) : -1;
    const issueClass = schemaIssueClass(issue.code);
    const shape = valueShape(schemaValueAtPath(catalogInput, safePath));
    return {
      code: "catalog-schema-invalid" as const,
      recipeId: captureIndex >= 0 ? catalogRecipeId(captures[captureIndex], captureIndex) : null,
      field: pointer(safePath),
      expected: { invariant: "repository-capture-catalog-schema", issueClass },
      observed: {
        issueClass,
        shape,
        ...(issueClass === "unknown-field" && Array.isArray(issue.keys)
          ? { unknownFieldCount: issue.keys.length }
          : {}),
      },
    };
  });
}

function captureCapability(entry: RepositoryCaptureCatalog["captures"][number]) {
  const outputs = [
    entry.comparisonOutput,
    ...entry.auxiliaryOutputs,
    ...(entry.profile?.diffOutput ? [entry.profile.diffOutput] : []),
    ...(entry.profile?.previewOutput ? [entry.profile.previewOutput] : []),
  ];
  return {
    kind: "capture" as const,
    outputs,
    comparisonOutputRoleId: entry.comparisonOutput.roleId,
    profile: entry.profile
      ? {
          kind: "raster" as const,
          viewport: entry.profile.viewport,
          output: entry.profile.output,
          captureRoleId: entry.comparisonOutput.roleId,
          diffRoleId: entry.profile.diffOutput?.roleId ?? null,
          previewRoleId: entry.profile.previewOutput?.roleId ?? null,
        }
      : null,
    humanReview: entry.humanReview,
  };
}

/**
 * Side-effect-free executable validation for repository capture configuration.
 * Callers supply only repository-observed recipes; the evaluator owns command
 * binding, installed comparator applicability and comparator result domains.
 */
export function evaluateRepositoryCaptureCatalog(args: {
  catalog: unknown | string | undefined;
  observedRecipes: readonly CompilerValidationRecipe[];
}): RepositoryCaptureCatalogEvaluation {
  if (args.catalog === undefined)
    return {
      report: report([]),
      capabilities: {
        validationRecipes: [...args.observedRecipes],
        repositoryComparators: [],
        deterministicCaptureGates: [],
      },
    };

  let catalogInput = args.catalog;
  if (typeof catalogInput === "string") {
    try {
      catalogInput = JSON.parse(catalogInput);
    } catch {
      return {
        report: report([
          {
            code: "catalog-schema-invalid",
            recipeId: null,
            field: "",
            expected: "valid JSON capture catalog",
            observed: { issue: "invalid-json" },
          },
        ]),
        capabilities: null,
      };
    }
  }
  const parsed = RepositoryCaptureCatalogSchema.safeParse(catalogInput);
  if (!parsed.success)
    return {
      report: report(schemaDiagnostics(catalogInput, parsed.error.issues)),
      capabilities: null,
    };

  const catalog = parsed.data;
  const diagnostics: RepositoryCaptureCatalogDiagnostic[] = [];
  const observedByCommand = new Map(args.observedRecipes.map((recipe) => [recipe.command, recipe]));
  const captureByCommand = new Map<string, ReturnType<typeof captureCapability>>();

  for (const [captureIndex, entry] of catalog.captures.entries()) {
    const recipeId = repositoryCaptureRecipeId(entry.command);
    if (!observedByCommand.has(entry.command))
      diagnostics.push({
        code: "capture-command-unobserved",
        recipeId,
        field: `/captures/${captureIndex}/command`,
        expected: { authority: "repository-observed-validation-command" },
        observed: { authority: "unobserved" },
      });
    captureByCommand.set(entry.command, captureCapability(entry));

    const capture = captureByCommand.get(entry.command)!;
    const profile = repositoryCaptureProfileForOutput(capture, capture.comparisonOutputRoleId);
    for (const [comparisonIndex, { policy }] of entry.thresholdComparisons.entries()) {
      const field = `/captures/${captureIndex}/thresholdComparisons/${comparisonIndex}/policy`;
      const known = repositoryComparatorContracts.some(({ id }) => id === policy.metric);
      let capability: ReturnType<typeof repositoryComparatorCapability> | null = null;
      try {
        capability = repositoryComparatorCapability({
          metric: policy.metric,
          mediaType: entry.comparisonOutput.mediaType,
          profile,
        });
      } catch {
        diagnostics.push({
          code: known ? "comparator-inapplicable" : "comparator-unavailable",
          recipeId,
          field: `${field}/metric`,
          expected: known
            ? { applicability: "exact comparison output contract" }
            : { installedComparatorIds: repositoryComparatorContracts.map(({ id }) => id).sort() },
          observed: {
            metric: policy.metric,
            mediaType: entry.comparisonOutput.mediaType,
            profileKind: profile?.kind ?? null,
          },
        });
      }
      if (
        capability &&
        (policy.maximumDifference < capability.resultDomain.minimum ||
          policy.maximumDifference > capability.resultDomain.maximum)
      )
        diagnostics.push({
          code: "threshold-out-of-domain",
          recipeId,
          field: `${field}/maximumDifference`,
          expected: { comparatorResultDomain: capability.resultDomain },
          observed: policy.maximumDifference,
        });
    }
  }

  if (diagnostics.length > 0) return { report: report(diagnostics), capabilities: null };

  const validationRecipes = args.observedRecipes.map((recipe) =>
    CompilerValidationRecipeSchema.parse({
      ...recipe,
      capture: captureByCommand.get(recipe.command) ?? recipe.capture,
    }),
  );
  const recipeByCommand = new Map(validationRecipes.map((recipe) => [recipe.command, recipe]));
  const repositoryComparators: CompilerRepositoryComparator[] = catalog.captures.flatMap(
    (entry) => {
      const capture = recipeByCommand.get(entry.command)!;
      const profile = repositoryCaptureProfileForOutput(
        capture.capture!,
        capture.capture!.comparisonOutputRoleId,
      );
      return entry.thresholdComparisons.map(({ policy }) => ({
        captureRecipeId: capture.id,
        captureRecipeDigest: compilerEvalDigest(capture),
        policy,
        comparator: repositoryComparatorCapability({
          metric: policy.metric,
          mediaType: entry.comparisonOutput.mediaType,
          profile,
        }).identity,
      }));
    },
  );
  const comparatorByPolicyId = new Map(
    repositoryComparators.map((comparator) => [comparator.policy.id, comparator]),
  );
  const deterministicCaptureGates = catalog.captures.flatMap((entry) => {
    const capture = recipeByCommand.get(entry.command)!;
    const exact = entry.exactDeterministicGates.map((rule) => ({
      rule,
      comparison: { kind: "exact" as const },
    }));
    const thresholds = entry.thresholdComparisons.flatMap(({ policy, deterministicGates }) => {
      const selected = comparatorByPolicyId.get(policy.id)!;
      return deterministicGates.map((rule) => ({
        rule,
        comparison: {
          kind: "threshold" as const,
          policyId: selected.policy.id,
          policyDigest: compilerEvalDigest(selected.policy),
          comparator: selected.comparator,
          metric: selected.policy.metric,
          maximumDifference: selected.policy.maximumDifference,
        },
      }));
    });
    return [...exact, ...thresholds].map(({ rule, comparison }) =>
      CompilerRepositoryCaptureGateRuleSchema.parse({
        ...rule,
        captureRecipeId: capture.id,
        captureRecipeDigest: compilerEvalDigest(capture),
        comparison,
      }),
    );
  });
  return {
    report: report([]),
    capabilities: { validationRecipes, repositoryComparators, deterministicCaptureGates },
  };
}

/** Re-run the catalog evaluator over compiler-bound facts. This deliberately
 * reconstructs only active mechanical authority; it does not accept a second
 * comparator or command interpretation in proposal validation. */
export function evaluateBoundRepositoryCaptureCapabilities(args: {
  validationRecipes: readonly CompilerValidationRecipe[];
  repositoryComparators: readonly CompilerRepositoryComparator[];
  deterministicCaptureGates: readonly CompilerRepositoryCaptureGateRule[];
}): RepositoryCaptureCatalogEvaluation {
  const captures = args.validationRecipes.flatMap((recipe) => {
    const capture = recipe.capture;
    if (capture?.kind !== "capture") return [];
    const comparisonOutput = capture.outputs.find(
      ({ roleId }) => roleId === capture.comparisonOutputRoleId,
    );
    if (!comparisonOutput) return [];
    const profiled = new Set([
      capture.comparisonOutputRoleId,
      ...(capture.profile
        ? [
            capture.profile.captureRoleId,
            capture.profile.diffRoleId,
            capture.profile.previewRoleId,
          ].filter((roleId): roleId is string => roleId !== null)
        : []),
    ]);
    const catalogRule = (gate: CompilerRepositoryCaptureGateRule) => {
      const {
        captureRecipeId: _recipeId,
        captureRecipeDigest: _digest,
        comparison: _comparison,
        ...rule
      } = gate;
      return rule;
    };
    const exactDeterministicGates = args.deterministicCaptureGates
      .filter((gate) => gate.captureRecipeId === recipe.id && gate.comparison.kind === "exact")
      .map(catalogRule);
    const thresholdComparisons = args.repositoryComparators
      .filter(({ captureRecipeId }) => captureRecipeId === recipe.id)
      .map(({ policy }) => ({
        policy: structuredClone(policy),
        deterministicGates: args.deterministicCaptureGates
          .filter(
            (gate) =>
              gate.captureRecipeId === recipe.id &&
              gate.comparison.kind === "threshold" &&
              gate.comparison.policyId === policy.id,
          )
          .map(catalogRule),
      }));
    const outputForRole = (roleId: string | null) =>
      roleId === null ? null : (capture.outputs.find((output) => output.roleId === roleId) ?? null);
    return [
      {
        command: recipe.command,
        comparisonOutput,
        auxiliaryOutputs: capture.outputs.filter(({ roleId }) => !profiled.has(roleId)),
        profile: capture.profile
          ? {
              kind: "raster" as const,
              viewport: capture.profile.viewport,
              output: capture.profile.output,
              diffOutput: outputForRole(capture.profile.diffRoleId),
              previewOutput: outputForRole(capture.profile.previewRoleId),
            }
          : null,
        humanReview: capture.humanReview,
        exactDeterministicGates,
        thresholdComparisons,
      },
    ];
  });
  const evaluation = evaluateRepositoryCaptureCatalog({
    catalog: { captures },
    observedRecipes: args.validationRecipes.map((recipe) => ({ ...recipe, capture: null })),
  });
  if (!evaluation.capabilities) return evaluation;
  const diagnostics: RepositoryCaptureCatalogDiagnostic[] = [];
  for (const configured of args.repositoryComparators) {
    const installed = evaluation.capabilities.repositoryComparators.find(
      ({ captureRecipeId, policy }) =>
        captureRecipeId === configured.captureRecipeId && policy.id === configured.policy.id,
    );
    if (
      installed &&
      compilerEvalDigest(installed.comparator) !== compilerEvalDigest(configured.comparator)
    )
      diagnostics.push({
        code: "comparator-identity-mismatch",
        recipeId: configured.captureRecipeId,
        field: `/comparators/${configured.policy.id}/comparator`,
        expected: installed.comparator,
        observed: configured.comparator,
      });
  }
  return diagnostics.length > 0 ? { report: report(diagnostics), capabilities: null } : evaluation;
}
