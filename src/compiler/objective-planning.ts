import { analyzeDependencies, overlappingScopePairs } from "../graph-analysis.js";
import type {
  CompilerDiagnosticValue,
  CompilerObjectivesProposal,
  ProposedObjective,
} from "./contracts.js";

export const OBJECTIVE_PLANNING_VIOLATION_CODES = [
  "objective-count",
  "duplicate-objective-id",
  "duplicate-acceptance-id",
  "duplicate-output-id",
  "invalid-objective-content",
  "unknown-obligation",
  "duplicate-obligation-disposition",
  "unmapped-obligation",
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
] as const;

export type ObjectivePlanningViolationCode = (typeof OBJECTIVE_PLANNING_VIOLATION_CODES)[number];

/** CompilerViolation-compatible shape. These codes remain local until the compiler
 * proposal integration adds them to the closed compiler rule registry. */
export interface ObjectivePlanningViolation {
  code: ObjectivePlanningViolationCode;
  itemId: string | null;
  field: string;
  expected: CompilerDiagnosticValue;
  observed: CompilerDiagnosticValue;
}

const pointer = (...parts: Array<string | number>) =>
  parts.length
    ? `/${parts
        .map(String)
        .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")}`
    : "";

const diagnostic = (value: unknown): CompilerDiagnosticValue => value as CompilerDiagnosticValue;

const violation = (
  code: ObjectivePlanningViolationCode,
  field: string,
  expected: CompilerDiagnosticValue,
  observed: CompilerDiagnosticValue,
  itemId: string | null = null,
): ObjectivePlanningViolation => ({ code, itemId, field, expected, observed });

const canonical = (value: CompilerDiagnosticValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const violationKey = (entry: ObjectivePlanningViolation) =>
  [
    entry.itemId ?? "",
    entry.field,
    entry.code,
    canonical(entry.expected),
    canonical(entry.observed),
  ].join("\0");

function normalizedViolations(
  violations: readonly ObjectivePlanningViolation[],
): ObjectivePlanningViolation[] {
  const unique = new Map(violations.map((entry) => [violationKey(entry), entry]));
  return [...unique.values()].sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
}

const fakeText = /^(?:n\/?a|none|todo|tbd|placeholder|later|unknown|done)$/i;

function nonemptyText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value.trim());
}

function meaningfulText(value: string): boolean {
  const normalized = value.trim();
  return nonemptyText(normalized) && !fakeText.test(normalized);
}

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function objectiveDependencies(objective: ProposedObjective): string[] {
  return [...new Set(objective.prerequisiteOutputs.map((entry) => entry.objectiveId))];
}

/**
 * Pure semantic validation for an already schema-shaped Objective plan.
 * `obligationIds` is the authoritative inventory supplied to the compiler.
 */
export function validateObjectivePlan(
  proposal: CompilerObjectivesProposal,
  obligationIds: readonly string[],
): ObjectivePlanningViolation[] {
  const violations: ObjectivePlanningViolation[] = [];
  const inventory = new Set(obligationIds);
  const objectiveIndexes = new Map<string, number>();
  const objectivesById = new Map<string, ProposedObjective>();

  if (proposal.objectives.length < 2)
    violations.push(
      violation(
        "objective-count",
        "/objectives",
        "at least two Objectives",
        proposal.objectives.length,
      ),
    );

  for (const duplicate of duplicateValues(proposal.objectives.map((objective) => objective.id)))
    violations.push(
      violation(
        "duplicate-objective-id",
        "/objectives",
        "unique Objective IDs",
        duplicate,
        duplicate,
      ),
    );

  for (const [index, objective] of proposal.objectives.entries()) {
    if (!objectiveIndexes.has(objective.id)) {
      objectiveIndexes.set(objective.id, index);
      objectivesById.set(objective.id, objective);
    }
  }

  const acceptanceOwners = new Map<string, { objectiveId: string; kind: string }>();
  const acceptanceIds = proposal.objectives.flatMap((objective) =>
    objective.acceptance.map((entry) => entry.id),
  );
  const outputIds = proposal.objectives.flatMap((objective) =>
    objective.outputs.map((entry) => entry.id),
  );
  for (const duplicate of duplicateValues(acceptanceIds))
    violations.push(
      violation(
        "duplicate-acceptance-id",
        "/objectives",
        "globally unique acceptance IDs",
        duplicate,
      ),
    );
  for (const duplicate of duplicateValues(outputIds))
    violations.push(
      violation("duplicate-output-id", "/objectives", "globally unique output IDs", duplicate),
    );

  for (const [objectiveIndex, objective] of proposal.objectives.entries()) {
    for (const acceptance of objective.acceptance)
      if (!acceptanceOwners.has(acceptance.id))
        acceptanceOwners.set(acceptance.id, { objectiveId: objective.id, kind: acceptance.kind });
    const content: Array<[string, string]> = [
      ["title", objective.title],
      ["outcome", objective.outcome],
    ];
    for (const [field, text] of content)
      if (!meaningfulText(text))
        violations.push(
          violation(
            "invalid-objective-content",
            pointer("objectives", objectiveIndex, field),
            "meaningful non-placeholder text",
            text,
            objective.id,
          ),
        );
    if (objective.acceptance.length === 0)
      violations.push(
        violation(
          "invalid-objective-content",
          pointer("objectives", objectiveIndex, "acceptance"),
          "at least one acceptance criterion",
          0,
          objective.id,
        ),
      );
    if (objective.ownedScope.length === 0)
      violations.push(
        violation(
          "invalid-objective-content",
          pointer("objectives", objectiveIndex, "ownedScope"),
          "at least one owned repository scope",
          0,
          objective.id,
        ),
      );
    if (objective.outputs.length === 0)
      violations.push(
        violation(
          "invalid-objective-content",
          pointer("objectives", objectiveIndex, "outputs"),
          "at least one output",
          0,
          objective.id,
        ),
      );

    for (const [acceptanceIndex, acceptance] of objective.acceptance.entries())
      if (!meaningfulText(acceptance.text))
        violations.push(
          violation(
            "invalid-objective-content",
            pointer("objectives", objectiveIndex, "acceptance", acceptanceIndex, "text"),
            "meaningful non-placeholder acceptance",
            acceptance.text,
            objective.id,
          ),
        );
    for (const [scopeIndex, scope] of objective.ownedScope.entries())
      if (!nonemptyText(scope))
        violations.push(
          violation(
            "invalid-objective-content",
            pointer("objectives", objectiveIndex, "ownedScope", scopeIndex),
            "nonempty owned repository scope",
            scope,
            objective.id,
          ),
        );
    for (const [outputIndex, output] of objective.outputs.entries()) {
      if (!meaningfulText(output.description))
        violations.push(
          violation(
            "invalid-objective-content",
            pointer("objectives", objectiveIndex, "outputs", outputIndex, "description"),
            "meaningful non-placeholder output",
            output.description,
            objective.id,
          ),
        );
      for (const duplicate of duplicateValues(output.completionAcceptanceIds))
        violations.push(
          violation(
            "duplicate-completion-acceptance",
            pointer(
              "objectives",
              objectiveIndex,
              "outputs",
              outputIndex,
              "completionAcceptanceIds",
            ),
            "unique acceptance IDs",
            duplicate,
            objective.id,
          ),
        );
      const localAcceptance = new Set(objective.acceptance.map((entry) => entry.id));
      for (const acceptanceId of output.completionAcceptanceIds)
        if (!localAcceptance.has(acceptanceId))
          violations.push(
            violation(
              "unknown-completion-acceptance",
              pointer(
                "objectives",
                objectiveIndex,
                "outputs",
                outputIndex,
                "completionAcceptanceIds",
              ),
              [...localAcceptance].sort(),
              acceptanceId,
              objective.id,
            ),
          );
    }

    for (const obligationId of objective.obligationIds)
      if (!inventory.has(obligationId))
        violations.push(
          violation(
            "unknown-obligation",
            pointer("objectives", objectiveIndex, "obligationIds"),
            [...inventory].sort(),
            obligationId,
            objective.id,
          ),
        );

    const prerequisiteKeys = objective.prerequisiteOutputs.map(
      (entry) => `${entry.objectiveId}\0${entry.outputId}`,
    );
    for (const duplicate of duplicateValues(prerequisiteKeys)) {
      const [objectiveId, outputId] = duplicate.split("\0");
      violations.push(
        violation(
          "duplicate-prerequisite-output",
          pointer("objectives", objectiveIndex, "prerequisiteOutputs"),
          "unique prerequisite outputs",
          { objectiveId: objectiveId!, outputId: outputId! },
          objective.id,
        ),
      );
    }
    for (const [prerequisiteIndex, prerequisite] of objective.prerequisiteOutputs.entries()) {
      const field = pointer("objectives", objectiveIndex, "prerequisiteOutputs", prerequisiteIndex);
      if (prerequisite.objectiveId === objective.id)
        violations.push(
          violation(
            "self-prerequisite",
            field,
            "a different prerequisite Objective",
            diagnostic(prerequisite),
            objective.id,
          ),
        );
      const owner = objectivesById.get(prerequisite.objectiveId);
      if (!owner) {
        violations.push(
          violation(
            "unknown-prerequisite-objective",
            field,
            [...objectivesById.keys()].sort(),
            prerequisite.objectiveId,
            objective.id,
          ),
        );
        continue;
      }
      if (!owner.outputs.some((output) => output.id === prerequisite.outputId))
        violations.push(
          violation(
            "unknown-prerequisite-output",
            field,
            owner.outputs.map((output) => output.id).sort(),
            prerequisite.outputId,
            objective.id,
          ),
        );
      const ownerIndex = objectiveIndexes.get(prerequisite.objectiveId)!;
      if (ownerIndex >= objectiveIndex)
        violations.push(
          violation(
            "objective-order",
            field,
            "prerequisite Objective before dependent Objective",
            { prerequisiteIndex: ownerIndex, dependentIndex: objectiveIndex },
            objective.id,
          ),
        );
    }

    const hasIntegrationAcceptance = objective.acceptance.some(
      (entry) => entry.kind === "aggregate-integration",
    );
    const ownsIntegrationDisposition = proposal.coverage.some(
      (entry) =>
        entry.disposition === "aggregate-integration" &&
        entry.objectiveId === objective.id &&
        objective.acceptance.some(
          (acceptance) =>
            acceptance.id === entry.acceptanceId && acceptance.kind === "aggregate-integration",
        ),
    );
    if (objective.prerequisiteOutputs.length === 0 && hasIntegrationAcceptance)
      violations.push(
        violation(
          "root-integration-acceptance",
          pointer("objectives", objectiveIndex, "acceptance"),
          "root Objectives only claim owned acceptance",
          "aggregate-integration",
          objective.id,
        ),
      );
    if (
      objective.obligationIds.length === 0 &&
      !(
        objective.prerequisiteOutputs.length > 0 &&
        hasIntegrationAcceptance &&
        ownsIntegrationDisposition
      )
    )
      violations.push(
        violation(
          "empty-objective-milestone",
          pointer("objectives", objectiveIndex),
          "owned obligations or a prerequisite-backed integration milestone",
          {
            obligationIds: objective.obligationIds,
            prerequisiteOutputs: objective.prerequisiteOutputs,
            acceptanceKinds: objective.acceptance.map((entry) => entry.kind),
          },
          objective.id,
        ),
      );
  }

  const dependencyAnalysis = analyzeDependencies(
    proposal.objectives.map((objective) => ({
      id: objective.id,
      dependsOn: objectiveDependencies(objective),
    })),
  );
  if (dependencyAnalysis.cycleItems.length > 0)
    violations.push(
      violation(
        "objective-cycle",
        "/objectives",
        "acyclic prerequisite graph",
        dependencyAnalysis.cycleItems,
      ),
    );

  for (const [left, right] of overlappingScopePairs(
    proposal.objectives.map((objective) => ({ id: objective.id, scope: objective.ownedScope })),
  ))
    if (!dependencyAnalysis.hasPath(left, right) && !dependencyAnalysis.hasPath(right, left))
      violations.push(
        violation(
          "overlapping-objective-scope",
          "/objectives",
          "overlapping owned scopes ordered by prerequisite reachability",
          [left, right],
        ),
      );

  const dispositions = new Map<string, number>();
  for (const entry of proposal.coverage)
    dispositions.set(entry.obligationId, (dispositions.get(entry.obligationId) ?? 0) + 1);
  for (const [coverageIndex, entry] of proposal.coverage.entries()) {
    const field = pointer("coverage", coverageIndex);
    if (!inventory.has(entry.obligationId))
      violations.push(
        violation("unknown-obligation", field, [...inventory].sort(), entry.obligationId),
      );
    if ((dispositions.get(entry.obligationId) ?? 0) > 1)
      violations.push(
        violation(
          "duplicate-obligation-disposition",
          field,
          "exactly one disposition",
          entry.obligationId,
        ),
      );
    if (entry.disposition === "deferred") {
      if (!meaningfulText(entry.reason))
        violations.push(
          violation(
            "invalid-obligation-disposition",
            pointer("coverage", coverageIndex, "reason"),
            "meaningful deferral reason",
            entry.reason,
          ),
        );
      continue;
    }
    const objective = objectivesById.get(entry.objectiveId);
    const acceptance = acceptanceOwners.get(entry.acceptanceId);
    if (!objective || !acceptance || acceptance.objectiveId !== entry.objectiveId) {
      violations.push(
        violation(
          "invalid-obligation-disposition",
          field,
          "an acceptance criterion on the named Objective",
          { objectiveId: entry.objectiveId, acceptanceId: entry.acceptanceId },
          entry.objectiveId,
        ),
      );
      continue;
    }
    if (acceptance.kind !== entry.disposition)
      violations.push(
        violation(
          entry.disposition === "aggregate-integration"
            ? "invalid-integration-acceptance"
            : "invalid-obligation-disposition",
          field,
          `${entry.disposition} acceptance`,
          acceptance.kind,
          entry.objectiveId,
        ),
      );
    if (entry.disposition === "owned" && !objective.obligationIds.includes(entry.obligationId))
      violations.push(
        violation(
          "invalid-obligation-disposition",
          field,
          "owned obligation listed by the named Objective",
          entry.obligationId,
          entry.objectiveId,
        ),
      );
    if (entry.disposition === "aggregate-integration" && objective.prerequisiteOutputs.length === 0)
      violations.push(
        violation(
          "invalid-integration-acceptance",
          field,
          "prerequisite-backed aggregate integration acceptance",
          { objectiveId: entry.objectiveId, prerequisiteOutputs: [] },
          entry.objectiveId,
        ),
      );
  }
  for (const obligationId of [...inventory].sort())
    if (!dispositions.has(obligationId))
      violations.push(
        violation("unmapped-obligation", "/coverage", "exactly one disposition", obligationId),
      );

  for (const [triggerIndex, trigger] of proposal.triggers.entries())
    for (const obligationId of trigger.obligationIds)
      if (!inventory.has(obligationId))
        violations.push(
          violation(
            "unknown-obligation",
            pointer("triggers", triggerIndex, "obligationIds"),
            [...inventory].sort(),
            obligationId,
          ),
        );

  for (const [objectiveIndex, objective] of proposal.objectives.entries())
    for (const obligationId of objective.obligationIds) {
      const owned = proposal.coverage.filter(
        (entry) =>
          entry.obligationId === obligationId &&
          entry.disposition === "owned" &&
          entry.objectiveId === objective.id,
      );
      if (owned.length !== 1)
        violations.push(
          violation(
            "invalid-obligation-disposition",
            pointer("objectives", objectiveIndex, "obligationIds"),
            "exactly one matching owned coverage disposition",
            { obligationId, matches: owned.length },
            objective.id,
          ),
        );
    }

  return normalizedViolations(violations);
}
