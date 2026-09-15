import { createHash } from "node:crypto";

import { assertNoSecretMaterial } from "../protocol/limits.js";
import {
  COMPILER_TERMINAL_VIOLATION_PHASES,
  CompilerValidationReportSchema,
  CompilerViolationSchema,
  type CompilerDiagnosticValue,
  type CompilerValidationReport,
  type CompilerViolation,
  type CompilerViolationCode,
} from "./contracts.js";

export interface CompilerRule {
  code: CompilerViolationCode;
  summary: string;
  terminalPhases: readonly CompilerValidationReport["phase"][];
}

const rule = (code: CompilerViolationCode, summary: string): CompilerRule => ({
  code,
  summary,
  terminalPhases: COMPILER_TERMINAL_VIOLATION_PHASES[code] ?? [],
});

export const COMPILER_RULES: Readonly<Record<CompilerViolationCode, CompilerRule>> = {
  "schema-invalid": rule("schema-invalid", "The value does not match the compiler contract."),
  "work-item-count": rule("work-item-count", "The Work Item count is outside the accepted bound."),
  "duplicate-item-id": rule("duplicate-item-id", "A Work Item identifier is duplicated."),
  "duplicate-dependency": rule(
    "duplicate-dependency",
    "A Work Item dependency identifier is duplicated.",
  ),
  "duplicate-criterion-id": rule("duplicate-criterion-id", "A criterion identifier is duplicated."),
  "duplicate-criterion-text": rule(
    "duplicate-criterion-text",
    "A Work Item repeats the same acceptance criterion text.",
  ),
  "duplicate-work-item-contract": rule(
    "duplicate-work-item-contract",
    "Each Work Item must describe a distinct deliverable contract.",
  ),
  "unknown-obligation": rule("unknown-obligation", "The proposal maps an unknown obligation."),
  "unmapped-obligation": rule(
    "unmapped-obligation",
    "An explicit obligation has no Work Item mapping.",
  ),
  "unknown-dependency": rule("unknown-dependency", "A dependency names an unknown Work Item."),
  "dependency-cycle": rule("dependency-cycle", "The dependency graph contains a cycle."),
  "dependency-limit": rule("dependency-limit", "A Work Item exceeds the dependency bound."),
  "invalid-scope": rule("invalid-scope", "A scope is not a canonical repository-relative path."),
  "unknown-validation-recipe": rule(
    "unknown-validation-recipe",
    "A validation reference is not in the pinned recipe catalog.",
  ),
  "invalid-deferred-operation": rule(
    "invalid-deferred-operation",
    "A deferred operation is not accepted by its adapter contract.",
  ),
  "uncovered-criterion": rule(
    "uncovered-criterion",
    "A criterion has no sufficient validation intent.",
  ),
  "protected-risk-validation": rule(
    "protected-risk-validation",
    "A protected criterion lacks sufficient deterministic validation.",
  ),
  "ungrounded-validation-tier": rule(
    "ungrounded-validation-tier",
    "A validation tier is not grounded by the pinned repository surface.",
  ),
  "partial-toolchain-authority": rule(
    "partial-toolchain-authority",
    "The pinned repository contains partial toolchain authority.",
  ),
  "mixed-toolchain-authority": rule(
    "mixed-toolchain-authority",
    "The pinned repository contains mixed toolchain authority.",
  ),
  "unsupported-toolchain": rule(
    "unsupported-toolchain",
    "The pinned repository has no supported compiler toolchain.",
  ),
  "no-validation-capability": rule(
    "no-validation-capability",
    "No observed or eligible validation capability exists.",
  ),
  "missing-capability-provider": rule(
    "missing-capability-provider",
    "A deferred operation has no authority-owning provider.",
  ),
  "ambiguous-capability-provider": rule(
    "ambiguous-capability-provider",
    "A deferred operation has multiple possible providers.",
  ),
  "non-ancestor-capability-provider": rule(
    "non-ancestor-capability-provider",
    "A deferred operation provider is not a dependency ancestor.",
  ),
  "operation-count-limit": rule(
    "operation-count-limit",
    "The adapter operation-count bound is exceeded.",
  ),
  "validation-command-limit": rule(
    "validation-command-limit",
    "A Work Item exceeds the projected validation-command bound.",
  ),
  "execution-requirement-limit": rule(
    "execution-requirement-limit",
    "A Work Item exceeds a projected execution-requirement bound.",
  ),
  "denied-network-destination": rule(
    "denied-network-destination",
    "A required network destination is denied by policy.",
  ),
  "legacy-constraint-mismatch": rule(
    "legacy-constraint-mismatch",
    "The proposal changes an immutable adopted Work Item constraint.",
  ),
  "report-truncated": rule(
    "report-truncated",
    "Additional deterministic violations were omitted by the report bound.",
  ),
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("compiler diagnostic must be JSON serializable");
  return text;
};

function boundedValue(value: CompilerDiagnosticValue): CompilerDiagnosticValue {
  const text = canonical(value);
  assertNoSecretMaterial(text, "compiler diagnostic value");
  const bytes = Buffer.byteLength(text);
  if (bytes <= 2 * 1024) return value;
  return {
    bounded: true,
    bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function normalizeViolation(value: CompilerViolation): CompilerViolation {
  const violation = CompilerViolationSchema.parse(value);
  return {
    code: violation.code,
    itemId: violation.itemId,
    field: violation.field,
    expected: boundedValue(violation.expected),
    observed: boundedValue(violation.observed),
  };
}

const violationKey = (violation: CompilerViolation) =>
  [
    violation.itemId ?? "",
    violation.field,
    violation.code,
    canonical(violation.expected),
    canonical(violation.observed),
  ].join("\0");

export function createCompilerValidationReport(
  phase: CompilerValidationReport["phase"],
  input: readonly CompilerViolation[],
): CompilerValidationReport {
  const normalized = input.map(normalizeViolation);
  const unique = new Map(normalized.map((violation) => [violationKey(violation), violation]));
  const ordered = [...unique.values()].sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
  const terminal = ordered.some((violation) =>
    COMPILER_RULES[violation.code].terminalPhases.includes(phase),
  );
  const status = ordered.length === 0 ? "valid" : terminal ? "unsatisfiable" : "repairable";
  const maximum = Math.min(127, ordered.length);
  let kept = ordered.slice(0, maximum);
  const truncation = (): CompilerViolation => ({
    code: "report-truncated",
    itemId: null,
    field: "",
    expected: { maximumViolations: 128, maximumBytes: 64 * 1024 },
    observed: { totalViolations: ordered.length },
  });
  if (ordered.length > 127) kept.push(truncation());
  const report = (): CompilerValidationReport => ({
    protocol: "clockgrove.factory/compiler-validation",
    phase,
    status,
    violations: kept,
  });
  while (Buffer.byteLength(canonical(report())) > 64 * 1024 && kept.length > 1) {
    kept = kept.filter((violation) => violation.code !== "report-truncated");
    kept.pop();
    kept.push(truncation());
  }
  const parsed = CompilerValidationReportSchema.parse(report());
  if ((parsed.status === "valid") !== (parsed.violations.length === 0))
    throw new Error("compiler validation status contradicts its violations");
  return parsed;
}

export function emptyCompilerValidationReport(
  phase: CompilerValidationReport["phase"] = "proposal",
): CompilerValidationReport {
  return createCompilerValidationReport(phase, []);
}

export function compilerValidationReportDigest(report: CompilerValidationReport): string {
  return createHash("sha256")
    .update(canonical(CompilerValidationReportSchema.parse(report)))
    .digest("hex");
}

export function renderCompilerValidationReport(reportInput: CompilerValidationReport): string {
  const report = CompilerValidationReportSchema.parse(reportInput);
  if (report.violations.length === 0) return `${report.phase}: valid`;
  return [
    `${report.phase}: ${report.status} (${report.violations.length} violation${report.violations.length === 1 ? "" : "s"})`,
    ...report.violations.map(
      (violation) =>
        `- ${violation.code}${violation.itemId ? ` [${violation.itemId}]` : ""} ${violation.field || "/"}: ${COMPILER_RULES[violation.code].summary} Expected ${canonical(violation.expected)}; observed ${canonical(violation.observed)}.`,
    ),
  ].join("\n");
}
