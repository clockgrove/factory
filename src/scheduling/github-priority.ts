import type { IssueFieldSingleSelectSnapshot } from "../types.js";
import type { PriorityFieldDefinition } from "../github.js";

export interface RawIssueFieldValueConnection {
  totalCount: number;
  nodes: Array<{
    optionId?: string | null;
    name?: string;
    field?: { id?: string; name?: string; dataType?: string } | null;
  }>;
}

/** Normalize only single-select values while refusing a partial connection. */
export function normalizeIssueFieldValues(
  workItem: number,
  connection: RawIssueFieldValueConnection | undefined,
): IssueFieldSingleSelectSnapshot[] {
  if (!connection) return [];
  if (connection.totalCount !== connection.nodes.length) {
    throw new Error(
      `Work Item #${workItem} has too many issue-field values for a complete snapshot`,
    );
  }
  return connection.nodes.flatMap((value) =>
    value.field?.id &&
    value.field.name &&
    value.field.dataType === "SINGLE_SELECT"
      ? [
          {
            fieldId: value.field.id,
            fieldName: value.field.name,
            dataType: "SINGLE_SELECT" as const,
            optionId: value.optionId ?? null,
            optionName: value.name ?? null,
          },
        ]
      : [],
  );
}

export function priorityPolicyFragment(field: PriorityFieldDefinition) {
  return {
    priority: {
      source: "issue-field-then-subissue-order" as const,
      issueFieldId: field.id,
      optionRanks: Object.fromEntries(
        field.options.map((option) => [
          option.id,
          Math.min(1_000, option.position * 10),
        ]),
      ),
      unsetRank: Math.min(1_000, Math.max(100, field.options.length * 10)),
      onUnavailable: "fallback-to-subissue-order" as const,
    },
  };
}

export type PriorityFieldPreflight =
  | { available: true }
  | { available: false; reason: string };

/** Validate immutable stable IDs without ever consulting display names. */
export function validatePriorityFieldDefinition(
  policy: {
    source: "subissue-order" | "issue-field-then-subissue-order";
    issueFieldId?: string | undefined;
    optionRanks?: Record<string, number> | undefined;
  },
  fields: readonly PriorityFieldDefinition[],
): PriorityFieldPreflight {
  if (policy.source === "subissue-order") return { available: true };
  const fieldId = policy.issueFieldId;
  if (!fieldId) {
    return { available: false, reason: "priority issueFieldId is missing" };
  }
  const field = fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    return {
      available: false,
      reason: `priority field ${fieldId} is unavailable or is not an organization single-select field`,
    };
  }
  const availableOptions = new Set(field.options.map((option) => option.id));
  const unknown = Object.keys(policy.optionRanks ?? {})
    .filter((optionId) => !availableOptions.has(optionId))
    .sort();
  if (unknown.length > 0) {
    return {
      available: false,
      reason: `priority field ${fieldId} does not contain configured option ${unknown.join(", ")}`,
    };
  }
  return { available: true };
}
