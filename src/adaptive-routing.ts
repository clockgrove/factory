import { createHash } from "node:crypto";
import type {
  ContentStore,
  DeclaredWorkCondition,
  WorkGraph,
} from "./contracts.js";
import {
  assertDiscoveryOutputManifest,
  authenticateDiscoveryOutput,
  discoverySpecificationDigest,
  type DiscoveryBody,
  type DiscoveryOutputManifest,
  type DiscoveryProducer,
} from "./discovery.js";
import { record } from "./unknown-fields.js";

/** Retained literal facts, not a result-acceptance receipt or new authority. */
export interface WorkConditionInputPacket {
  schemaVersion: 1;
  condition: DeclaredWorkCondition;
  expectedProducer: DiscoveryProducer;
  sourceCommitSha: string;
  manifest: DiscoveryOutputManifest;
  body: DiscoveryBody;
  value: boolean;
}
export type WorkConditionEvaluation =
  | {
      status: "known";
      value: boolean;
      inputPacket: WorkConditionInputPacket;
      digest: string;
    }
  | { status: "unknown"; detail: string };

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function keys(
  value: Record<string, unknown>,
  fields: string[],
  label: string,
): void {
  if (Object.keys(value).sort().join() !== [...fields].sort().join())
    throw new Error(`${label} has missing or unsupported fields`);
}
export function workConditionDigest(condition: DeclaredWorkCondition): string {
  return hash(condition);
}
export function assertDeclaredWorkCondition(
  value: unknown,
): asserts value is DeclaredWorkCondition {
  const condition = record(value, "Work condition");
  keys(
    condition,
    ["schemaVersion", "id", "input", "predicate"],
    "Work condition",
  );
  if (
    condition.schemaVersion !== 1 ||
    typeof condition.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(condition.id)
  )
    throw new Error("Work condition has an invalid version or stable identity");
  const input = record(condition.input, "Condition input");
  keys(input, ["producerItemId", "role", "schema"], "Condition input");
  if (
    typeof input.producerItemId !== "string" ||
    !input.producerItemId ||
    typeof input.role !== "string" ||
    !input.role.trim() ||
    input.schema !== "factory.repository-inventory/v1"
  )
    throw new Error(
      "Work condition must select a declared repository discovery output",
    );
  const predicate = record(condition.predicate, "Condition predicate");
  if (predicate.kind === "inventory-empty")
    keys(predicate, ["kind"], "Condition predicate");
  else if (predicate.kind === "has-classification") {
    keys(
      predicate,
      ["kind", "classification", "otherClassifications"],
      "Condition predicate",
    );
    if (
      typeof predicate.classification !== "string" ||
      !predicate.classification.trim()
    )
      throw new Error(
        "Condition classification must be a literal nonempty label",
      );
    if (
      !Array.isArray(predicate.otherClassifications) ||
      predicate.otherClassifications.some(
        (entry) =>
          typeof entry !== "string" ||
          !entry.trim() ||
          entry === predicate.classification,
      ) ||
      new Set(predicate.otherClassifications).size !==
        predicate.otherClassifications.length
    )
      throw new Error(
        "Condition negative classifications must be distinct reviewed labels, separate from the selected label",
      );
  } else
    throw new Error(
      "Unsupported work condition; arbitrary expressions and code are not routing predicates",
    );
}

/** Routing retains all original proof obligations on unconditional owners. */
export function assertDeclaredConditions(graph: WorkGraph): void {
  if (graph.conditions === undefined) {
    if (graph.items.some((item) => item.condition !== undefined))
      throw new Error("Work branch references an undeclared condition");
    return;
  }
  if (!Array.isArray(graph.conditions) || !graph.conditions.length)
    throw new Error(
      "Declared work conditions must be a nonempty array when present",
    );
  const conditions = new Map<string, DeclaredWorkCondition>();
  for (const condition of graph.conditions) {
    assertDeclaredWorkCondition(condition);
    if (conditions.has(condition.id))
      throw new Error("Duplicate declared work condition identity");
    conditions.set(condition.id, condition);
    const producer = graph.items.find(
      (item) => item.id === condition.input.producerItemId,
    );
    if (
      producer?.kind !== "discovery" ||
      !producer.discovery ||
      producer.condition ||
      producer.discovery.role !== condition.input.role ||
      producer.discovery.schema !== condition.input.schema ||
      (condition.predicate.kind === "has-classification" &&
        producer.discovery.mode !== "semantic")
    )
      throw new Error(
        "Condition input must be an unconditional, schema-matching discovery producer with the required capability",
      );
  }
  const referenced = new Set<string>();
  for (const item of graph.items) {
    if (item.condition === undefined) continue;
    const selected = record(item.condition, "Work branch");
    keys(selected, ["conditionId", "when"], "Work branch");
    if (
      typeof selected.conditionId !== "string" ||
      typeof selected.when !== "boolean"
    )
      throw new Error(
        "Work branch must select a literal declared condition and boolean outcome",
      );
    const condition = conditions.get(selected.conditionId);
    if (
      !condition ||
      !item.dependencies.includes(condition.input.producerItemId) ||
      (item.kind ?? "work") !== "work"
    )
      throw new Error(
        "Conditional implementation requires its declared direct discovery dependency; proof, aggregate and discovery nodes remain unconditional",
      );
    if (graph.coverage.some((entry) => entry.itemId === item.id))
      throw new Error(
        "Conditional implementation cannot own original Objective coverage; unconditional proof must retain every substantive obligation",
      );
    if (
      graph.coverage.some(
        (entry) =>
          entry.proof.kind === "published-ci" &&
          entry.proof.targetItem === item.id,
      )
    )
      throw new Error(
        "Published CI cannot require a conditional branch delivery: skipped work has no PR or delivery head. Retain unconditional current integrated proof instead",
      );
    if (
      graph.coverage.some((entry) => entry.environment.preparedBy === item.id)
    )
      throw new Error(
        "Mandatory environment preparation cannot depend on a conditional branch: skipped work supplies no completed preparation. Use an unconditional source-authorized preparer",
      );
    if (
      graph.items.some(
        (parent) =>
          parent.kind === "aggregate" && parent.children?.includes(item.id),
      )
    )
      throw new Error(
        "Conditional implementation cannot be an explicit aggregate child: skipped work has no completed acceptance. Join alternative branches through an unconditional QA dependency barrier while preserving original proof requirements",
      );
    referenced.add(condition.id);
  }
  for (const condition of graph.conditions)
    if (!referenced.has(condition.id))
      throw new Error("Declared condition has no reviewed branch consumer");
  for (const envelope of graph.expansions ?? []) {
    if (
      envelope.template.condition !== undefined ||
      envelope.integrationBarrierItemIds.some(
        (id) => graph.items.find((item) => item.id === id)?.condition,
      )
    )
      throw new Error(
        "Expansion templates and integration barriers retain unconditional admitted authority",
      );
  }
}

export interface WorkConditionEvaluationInput {
  graph: WorkGraph;
  conditionId: string;
  manifest?: DiscoveryOutputManifest;
  body?: DiscoveryBody;
  expectedProducer: DiscoveryProducer;
  sourceCommitSha: string;
}
/** Call only with authenticated discovery bytes; the wrapper below performs actual storage/Git checks. */
export function evaluateWorkCondition(
  args: WorkConditionEvaluationInput,
): WorkConditionEvaluation {
  assertDeclaredConditions(args.graph);
  const condition = args.graph.conditions?.find(
    (entry) => entry.id === args.conditionId,
  );
  if (!condition)
    throw new Error("Work condition is not admitted in this graph");
  const producer = args.graph.items.find(
    (item) => item.id === condition.input.producerItemId,
  )!;
  const unknown = (detail: string): WorkConditionEvaluation => ({
    status: "unknown",
    detail,
  });
  if (!args.manifest || !args.body)
    return unknown(
      "Required condition discovery output or complete body is unavailable",
    );
  const { manifest, body } = args;
  try {
    assertDiscoveryOutputManifest(manifest);
  } catch {
    return unknown("Condition discovery manifest is malformed");
  }
  if (!Array.isArray(body.entries) || !Array.isArray(body.failures))
    return unknown("Condition discovery body is malformed");
  const encoded = Buffer.from(JSON.stringify(body));
  if (
    manifest.status !== "complete" ||
    body.failures.length ||
    body.entries.length !== manifest.selectedEntries ||
    manifest.schema !== condition.input.schema ||
    body.schema !== manifest.schema ||
    manifest.role !== condition.input.role ||
    manifest.specificationDigest !==
      discoverySpecificationDigest(producer.discovery!) ||
    JSON.stringify(manifest.source.selectors) !==
      JSON.stringify(producer.discovery!.selectors) ||
    ["objective", "runId", "itemId", "attemptId"].some(
      (field) =>
        manifest.producer[field as keyof DiscoveryProducer] !==
        args.expectedProducer[field as keyof DiscoveryProducer],
    ) ||
    manifest.producer.objective !== args.graph.objective ||
    manifest.producer.itemId !== producer.id ||
    manifest.source.commitSha !== args.sourceCommitSha ||
    !args.sourceCommitSha ||
    manifest.body.bytes !== encoded.length ||
    manifest.body.digest !==
      createHash("sha256").update(encoded).digest("hex") ||
    (producer.discovery!.mode === "semantic" &&
      body.semantic?.status !== "complete")
  )
    return unknown(
      "Condition facts are incomplete, stale or differ from their actual producer/source binding",
    );
  if (
    condition.predicate.kind === "has-classification" &&
    body.entries.some(
      (entry) =>
        typeof entry.classification !== "string" ||
        !entry.classification.trim(),
    )
  )
    return unknown(
      "Condition classifications are missing; absence of a label is not a negative finding",
    );
  if (condition.predicate.kind === "has-classification") {
    const known = [
      condition.predicate.classification,
      ...condition.predicate.otherClassifications,
    ];
    if (body.entries.some((entry) => !known.includes(entry.classification!)))
      return unknown(
        "Condition classification is outside its reviewed positive and negative labels",
      );
  }
  const value =
    condition.predicate.kind === "inventory-empty"
      ? body.entries.length === 0
      : body.entries.some(
          (entry) =>
            entry.classification ===
            (condition.predicate as { classification: string }).classification,
        );
  const inputPacket: WorkConditionInputPacket = {
    schemaVersion: 1,
    condition: structuredClone(condition),
    expectedProducer: structuredClone(args.expectedProducer),
    sourceCommitSha: args.sourceCommitSha,
    manifest: structuredClone(manifest),
    body: structuredClone(body),
    value,
  };
  return { status: "known", value, inputPacket, digest: hash(inputPacket) };
}
/** Every known predicate result is backed by complete current Git and retained artifact bytes. */
export async function evaluateAuthenticatedWorkCondition(
  args: Omit<WorkConditionEvaluationInput, "body"> & {
    checkout: string;
    store: ContentStore;
  },
): Promise<WorkConditionEvaluation> {
  assertDeclaredConditions(args.graph);
  const condition = args.graph.conditions?.find(
    (entry) => entry.id === args.conditionId,
  );
  if (!condition)
    throw new Error("Work condition is not admitted in this graph");
  const producer = args.graph.items.find(
    (item) => item.id === condition.input.producerItemId,
  )!;
  if (!args.manifest)
    return {
      status: "unknown",
      detail: "Required condition discovery output is unavailable",
    };
  try {
    const body = await authenticateDiscoveryOutput({
      checkout: args.checkout,
      specification: producer.discovery!,
      manifest: args.manifest,
      store: args.store,
    });
    return evaluateWorkCondition({ ...args, body });
  } catch {
    return {
      status: "unknown",
      detail:
        "Condition output cannot be authenticated against its retained body and bound source tree",
    };
  }
}
