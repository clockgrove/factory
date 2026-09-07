import { z } from "zod";

import { normalizeSchedulingPolicy, type RunPolicy } from "../protocol/policy.js";
import {
  ExecutionRequirementsSchema,
  RepositoryScopePathSchema,
  type ExecutionRequirements,
} from "../protocol/worker-packet.js";
import type { RepositoryFacts } from "../repository-profiles/index.js";

const GroundedFieldsSchema = z
  .object({
    os: z
      .array(z.enum(["linux", "darwin", "win32"]))
      .max(12)
      .optional(),
    architecture: z.array(z.string().min(1).max(40)).max(8).optional(),
    cpu: z.number().positive().max(256).optional(),
    memoryMb: z.number().int().positive().max(1_048_576).optional(),
    diskMb: z.number().int().positive().max(10_485_760).optional(),
    timeoutMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
  })
  .strict();

const RequirementsDocumentSchema = z
  .object({
    version: z.literal(1),
    defaults: GroundedFieldsSchema.optional(),
    scopes: z
      .array(
        z
          .object({
            paths: z.array(RepositoryScopePathSchema).min(1).max(64),
            requirements: GroundedFieldsSchema,
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();

type GroundedField = keyof z.infer<typeof GroundedFieldsSchema>;
type GroundedFields = z.infer<typeof GroundedFieldsSchema>;
type Evidence = NonNullable<ExecutionRequirements["evidence"]>[number];

const REQUIREMENTS_PATH = ".factory/execution-requirements.json";
const FIELD_ORDER: GroundedField[] = [
  "os",
  "architecture",
  "cpu",
  "memoryMb",
  "diskMb",
  "timeoutMinutes",
];

function pathMatches(scopePath: string, evidencePath: string): boolean {
  const scopePrefix = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  const evidencePrefix = evidencePath.endsWith("/") ? evidencePath : `${evidencePath}/`;
  return (
    scopePath === evidencePath ||
    scopePath.startsWith(evidencePrefix) ||
    evidencePath.startsWith(scopePrefix)
  );
}

function repositoryRequirements(
  facts: RepositoryFacts,
  scope: string[],
): {
  values: GroundedFields;
  evidence: Evidence[];
} {
  const text = facts.documents?.[REQUIREMENTS_PATH];
  if (text === undefined) return { values: {}, evidence: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${REQUIREMENTS_PATH} is invalid JSON`);
  }
  const document = RequirementsDocumentSchema.parse(raw);
  const values: GroundedFields = { ...(document.defaults ?? {}) };
  const sources = new Map<GroundedField, string>();
  const scopedValues = new Map<GroundedField, unknown>();
  for (const field of FIELD_ORDER) {
    if (document.defaults?.[field] !== undefined)
      sources.set(field, `${REQUIREMENTS_PATH} defaults`);
  }
  for (const [index, rule] of document.scopes.entries()) {
    if (!rule.paths.some((path) => scope.some((itemPath) => pathMatches(itemPath, path)))) continue;
    for (const field of FIELD_ORDER) {
      const value = rule.requirements[field];
      if (value === undefined) continue;
      const previous = scopedValues.get(field);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
        throw new Error(
          `conflicting ${field} repository evidence for scope ${scope.join(", ")} in ${REQUIREMENTS_PATH}`,
        );
      }
      (values as Record<string, unknown>)[field] = value;
      scopedValues.set(field, value);
      sources.set(field, `${REQUIREMENTS_PATH} scopes[${index}] (${rule.paths.join(", ")})`);
    }
  }
  return {
    values,
    evidence: FIELD_ORDER.flatMap((field) => {
      const source = sources.get(field);
      return source ? [{ field, kind: "repository" as const, source }] : [];
    }),
  };
}

/** Replace model-authored execution sizing with deterministic repository/policy evidence. */
export function groundExecutionRequirements(
  proposed: ExecutionRequirements,
  facts: RepositoryFacts,
  scope: string[],
  policy: RunPolicy,
): ExecutionRequirements {
  const scheduling = normalizeSchedulingPolicy(policy);
  const repository = repositoryRequirements(facts, scope);
  const {
    os: _proposedOs,
    architecture: _proposedArchitecture,
    cpu: _proposedCpu,
    memoryMb: _proposedMemory,
    diskMb: _proposedDisk,
    timeoutMinutes: _proposedTimeout,
    evidence: _proposedEvidence,
    ...portableRequirements
  } = proposed;
  const evidence = [...repository.evidence];
  const value = repository.values;
  const os = value.os ?? ["linux"];
  const architecture = value.architecture ?? [];
  const cpu = value.cpu ?? scheduling.capacity.local.defaultCpu;
  const memoryMb = value.memoryMb ?? scheduling.capacity.local.defaultMemoryMb;
  const timeoutMinutes = Math.min(
    value.timeoutMinutes ?? policy.workItemTimeoutMinutes,
    policy.workItemTimeoutMinutes,
  );

  const recorded = new Set(evidence.map((item) => item.field));
  const add = (item: Evidence) => {
    if (!recorded.has(item.field)) evidence.push(item);
    recorded.add(item.field);
  };
  if (value.os === undefined)
    add({ field: "os", kind: "factory-default", source: "supported-runtime:linux" });
  if (value.architecture === undefined)
    add({ field: "architecture", kind: "factory-default", source: "portable:any-architecture" });
  if (value.cpu === undefined)
    add({ field: "cpu", kind: "run-policy", source: "capacity.local.defaultCpu" });
  if (value.memoryMb === undefined)
    add({ field: "memoryMb", kind: "run-policy", source: "capacity.local.defaultMemoryMb" });
  if (value.diskMb === undefined)
    add({ field: "diskMb", kind: "factory-default", source: "backend-managed-artifact-storage" });
  if (value.timeoutMinutes === undefined)
    add({ field: "timeoutMinutes", kind: "run-policy", source: "workItemTimeoutMinutes" });
  else if (value.timeoutMinutes > policy.workItemTimeoutMinutes)
    evidence.push({
      field: "timeoutMinutes",
      kind: "run-policy",
      source: `workItemTimeoutMinutes cap (${policy.workItemTimeoutMinutes})`,
    });
  evidence.push({
    field: "artifactContract",
    kind: "factory-default",
    source: "clockgrove.factory/artifact-v1",
  });

  return ExecutionRequirementsSchema.parse({
    ...portableRequirements,
    os,
    architecture,
    cpu,
    memoryMb,
    ...(value.diskMb === undefined ? {} : { diskMb: value.diskMb }),
    timeoutMinutes,
    evidence,
  });
}
