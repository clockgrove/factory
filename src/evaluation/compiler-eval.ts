import { createHash } from "node:crypto";
import { z } from "zod";
import { CompilerDraftStopError } from "./compiler-draft-errors.js";
import type { CompilerObjective } from "../compiler/index.js";
import { assessDecomposition, type DecompositionEvidence } from "../compiler/economics.js";

/** A preference-only repair request cannot authorize another paid compiler call. */
export class CompilerJudgeNoMaterialRepairError extends CompilerDraftStopError {
  constructor() {
    super("judge repair has no unresolved coverage or material finding");
  }
}

const Id = z.string().min(1).max(160);
const Text = z.string().min(1).max(4000);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Refs = z.array(Id).max(128);
export const COMPILER_JUDGE_DIMENSIONS = [
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
] as const;
const Dimension = z.enum(COMPILER_JUDGE_DIMENSIONS);
export const CompilerEvidenceSchema = z
  .object({
    id: Id,
    kind: z.enum(["objective", "repository", "artifact", "receipt"]),
    identity: Text,
    excerpt: Text,
  })
  .strict();
export type CompilerEvidence = z.infer<typeof CompilerEvidenceSchema>;
export const CompilerPlanningEvidenceSchema = z
  .object({
    id: Id,
    kind: z.enum(["objective", "repository", "artifact", "receipt"]),
    identity: Text,
    digest: Digest,
    citation: Text,
  })
  .strict();
export type CompilerPlanningEvidence = z.infer<typeof CompilerPlanningEvidenceSchema>;
const ObligationSchema = z
  .object({
    id: Id,
    text: Text,
    kind: z.enum(["explicit", "prerequisite", "ambiguity"]),
    evidenceIds: Refs.min(1),
    acceptanceEvidence: Text,
  })
  .strict();
/** Model-owned claims only. Factory attaches the frozen evidence envelope. */
export const ObligationClaimsSchema = z
  .object({
    version: z.literal(1),
    obligations: z.array(ObligationSchema).min(1).max(128),
  })
  .strict();
export type ObligationClaims = z.infer<typeof ObligationClaimsSchema>;
export const ObligationInventorySchema = z
  .object({
    version: z.literal(1),
    objectiveDigest: Digest,
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    evidence: z.array(CompilerEvidenceSchema).min(1).max(128),
    obligations: z.array(ObligationSchema).min(1).max(128),
  })
  .strict();
export type ObligationInventory = z.infer<typeof ObligationInventorySchema>;
export const CompilerPlanningInventorySchema = z
  .object({
    version: z.literal(1),
    objectiveDigest: Digest,
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    evidence: z.array(CompilerPlanningEvidenceSchema).min(1).max(128),
    obligations: z.array(ObligationSchema).min(1).max(128),
  })
  .strict();
export type CompilerPlanningInventory = z.infer<typeof CompilerPlanningInventorySchema>;
export const FACTORY_COMPILER_CAPABILITY_IDS = [
  "exact-activation-binding",
  "execution-network-policy",
  "independent-semantic-review",
  "protected-pr-integration",
  "exact-integration-candidate-validation",
  "authorized-finding-reporting",
  "terminal-objective-handling",
] as const;
export const FactoryCompilerCapabilityIdSchema = z.enum(FACTORY_COMPILER_CAPABILITY_IDS);
export const FactoryCompilerCapabilitySchema = z
  .object({
    id: FactoryCompilerCapabilityIdSchema,
    description: Text,
    authorityDigest: Digest,
  })
  .strict();
export type FactoryCompilerCapability = z.infer<typeof FactoryCompilerCapabilitySchema>;
export const ObligationCoverageBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("criterion"), itemId: Id, criterionId: Id }).strict(),
  z
    .object({
      kind: z.literal("factory-capability"),
      capabilityId: FactoryCompilerCapabilityIdSchema,
    })
    .strict(),
]);
export type ObligationCoverageBinding = z.infer<typeof ObligationCoverageBindingSchema>;

function planningCitation(evidence: CompilerEvidence): string {
  if (evidence.kind === "objective") return "Objective";
  const firstLine = evidence.excerpt.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine && firstLine.length <= 240) return firstLine;
  return `${evidence.kind}:${evidence.id}`;
}

/** Prompt-safe projection for planning and repair. Source bytes remain in the
 * authenticated inventory used by extraction and judgment. */
export function compilerPlanningInventory(
  inventoryInput: ObligationInventory,
): CompilerPlanningInventory {
  const inventory = ObligationInventorySchema.parse(inventoryInput);
  return CompilerPlanningInventorySchema.parse({
    version: 1,
    objectiveDigest: inventory.objectiveDigest,
    baseSha: inventory.baseSha,
    evidence: inventory.evidence
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        identity: entry.identity,
        digest: compilerEvalDigest(entry.excerpt),
        citation: planningCitation(entry),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    obligations: inventory.obligations
      .map((entry) => ({ ...entry, evidenceIds: [...entry.evidenceIds].sort() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}
export const MAX_COMPILER_OBLIGATION_CHALLENGES = 128;
export const MAX_COMPILER_ITEM_CHALLENGES = 64;
export const MAX_COMPILER_INFERENCE_CHALLENGES =
  MAX_COMPILER_OBLIGATION_CHALLENGES + MAX_COMPILER_ITEM_CHALLENGES;

export const CompilerJudgeVerdictSchema = z
  .object({
    version: z.literal(1),
    rubricVersion: z.literal(1),
    draftDigest: Digest,
    inventoryDigest: Digest,
    coverage: z
      .array(
        z
          .object({
            obligationId: Id,
            acceptanceBindings: z.array(ObligationCoverageBindingSchema).max(128),
            status: z.enum(["covered", "partial", "missing", "unknown"]),
            itemIds: Refs,
            evidenceIds: Refs.min(1),
            reason: Text,
          })
          .strict(),
      )
      .min(1)
      .max(128),
    items: z
      .array(
        z
          .object({
            itemId: Id,
            granularity: z.enum(["cohesive", "oversized", "fragmented", "unknown"]),
            reason: Text,
            evidenceIds: Refs.min(1),
          })
          .strict(),
      )
      .max(100),
    dimensions: z
      .array(
        z
          .object({
            dimension: Dimension,
            status: z.enum(["assessed", "not-applicable", "unknown"]),
            reason: Text,
            evidenceIds: Refs.min(1),
          })
          .strict(),
      )
      .length(COMPILER_JUDGE_DIMENSIONS.length),
    dependencies: z
      .array(
        z
          .object({
            itemId: Id,
            dependsOn: z.array(Id).max(50),
            reason: Text,
            evidenceIds: Refs.min(1),
          })
          .strict(),
      )
      .max(100),
    findings: z
      .array(
        z
          .object({
            id: Id,
            dimension: Dimension,
            severity: z.enum(["advisory", "material-efficiency", "blocking"]),
            confidence: z.number().min(0).max(1),
            obligationIds: Refs,
            itemIds: Refs,
            evidenceIds: Refs.min(1),
            rootCause: Text,
            correction: Text,
            uncertainty: z.string().max(4000),
          })
          .strict(),
      )
      .max(64),
    inferenceCorrections: z
      .array(
        z
          .object({
            findingId: Id,
            obligationId: Id,
            disposition: z.enum(["unsupported-inference", "upheld"]),
            reason: Text,
            evidenceIds: Refs.min(1),
          })
          .strict(),
      )
      .max(MAX_COMPILER_OBLIGATION_CHALLENGES),
    uncertainty: z.array(Text).max(64),
    decision: z.enum(["accept", "repair", "abstain"]),
  })
  .strict();
export type CompilerJudgeVerdict = z.infer<typeof CompilerJudgeVerdictSchema>;

export interface CompilerJudgeValidationContext {
  draftDigest: string;
  inventory: ObligationInventory | CompilerPlanningInventory;
  factoryCapabilities?: FactoryCompilerCapability[];
  graph: {
    coverage?: Array<{
      obligationId: string;
      bindings: ObligationCoverageBinding[];
    }>;
    workItems: Array<{
      id: string;
      dependsOn: string[];
      criteria: Array<{ id: string }>;
    }>;
  };
  addedEdges?: Array<{ itemId: string; dependsOn: string }>;
  challenges?: CompilerInferenceChallenge[];
}

function coverageBindingKey(binding: ObligationCoverageBinding): string {
  return binding.kind === "criterion"
    ? `${binding.kind}\0${binding.itemId}\0${binding.criterionId}`
    : `${binding.kind}\0${binding.capabilityId}`;
}

/**
 * Convert a structurally valid but self-contradictory acceptance into bounded,
 * evidence-cited repair evidence. The raw verdict remains the durable provider
 * output; this deterministic projection only supplies the next repair request.
 */
export function repairableCompilerJudgeVerdict(
  value: unknown,
  expected: CompilerJudgeValidationContext,
): CompilerJudgeVerdict | null {
  const parsed = CompilerJudgeVerdictSchema.safeParse(value);
  if (!parsed.success || parsed.data.decision !== "accept") return null;
  const verdict = parsed.data;
  const projectedItems = new Map(expected.graph.workItems.map((item) => [item.id, item]));
  const factoryCapabilities = new Set(
    (expected.factoryCapabilities ?? []).map((entry) => entry.id),
  );
  const ungroundedObligations = new Set<string>();
  const ungroundedItems = new Set<string>();
  const ungroundedEvidence = new Set<string>();
  const coverage = verdict.coverage.map((entry) => {
    const validBindings = entry.acceptanceBindings.filter((binding) => {
      const item = binding.kind === "criterion" ? projectedItems.get(binding.itemId) : undefined;
      const valid =
        binding.kind === "factory-capability"
          ? factoryCapabilities.has(binding.capabilityId)
          : entry.itemIds.includes(binding.itemId) &&
            item?.criteria.some((criterion) => criterion.id === binding.criterionId) === true;
      if (!valid) {
        ungroundedObligations.add(entry.obligationId);
        if (item) ungroundedItems.add(item.id);
        for (const evidenceId of entry.evidenceIds) ungroundedEvidence.add(evidenceId);
      }
      return valid;
    });
    if (validBindings.length === entry.acceptanceBindings.length) return entry;
    return {
      ...entry,
      acceptanceBindings: validBindings,
      status: entry.status === "covered" && validBindings.length === 0 ? "unknown" : entry.status,
      reason:
        `${entry.reason} The judge supplied an acceptance binding outside the exact projected criterion catalog.`.slice(
          0,
          4000,
        ),
    };
  });
  if (ungroundedObligations.size > 0) {
    const availableEvidence = new Set(expected.inventory.evidence.map((entry) => entry.id));
    const evidenceIds = [...ungroundedEvidence].filter((id) => availableEvidence.has(id));
    if (evidenceIds.length === 0) return null;
    const usedIds = new Set(verdict.findings.map((entry) => entry.id));
    let id = "invalid-acceptance-binding";
    for (let suffix = 2; usedIds.has(id); suffix++) id = `invalid-acceptance-binding-${suffix}`;
    const repair = {
      ...verdict,
      coverage,
      findings: [
        ...verdict.findings,
        {
          id,
          dimension: "coverage" as const,
          severity: "blocking" as const,
          confidence: 1,
          obligationIds: [...ungroundedObligations],
          itemIds: [...ungroundedItems],
          evidenceIds,
          rootCause:
            "The judge cited acceptance criteria that are not present in the exact projected Work Item graph.",
          correction:
            "Preserve every obligation and revise the proposal only as needed so each covered obligation can bind to an existing projected item and criterion ID.",
          uncertainty: "",
        },
      ],
      decision: "repair" as const,
    };
    try {
      return validateCompilerJudgeVerdict(repair, expected);
    } catch {
      return null;
    }
  }
  const omittedProposalBindings = verdict.coverage.flatMap((entry) => {
    const observed = new Set(entry.acceptanceBindings.map(coverageBindingKey));
    const declared =
      expected.graph.coverage?.find((row) => row.obligationId === entry.obligationId)?.bindings ??
      [];
    return declared
      .filter((binding) => !observed.has(coverageBindingKey(binding)))
      .map((binding) => ({ entry, binding }));
  });
  if (omittedProposalBindings.length > 0) {
    const obligationIds = [
      ...new Set(omittedProposalBindings.map(({ entry }) => entry.obligationId)),
    ];
    const itemIds = [
      ...new Set(
        omittedProposalBindings.flatMap(({ binding }) =>
          binding.kind === "criterion" ? [binding.itemId] : [],
        ),
      ),
    ];
    const evidenceIds = [
      ...new Set(omittedProposalBindings.flatMap(({ entry }) => entry.evidenceIds)),
    ];
    const usedIds = new Set(verdict.findings.map((entry) => entry.id));
    let id = "omitted-proposal-coverage";
    for (let suffix = 2; usedIds.has(id); suffix++) id = `omitted-proposal-coverage-${suffix}`;
    const repair = {
      ...verdict,
      findings: [
        ...verdict.findings,
        {
          id,
          dimension: "coverage" as const,
          severity: "blocking" as const,
          confidence: 1,
          obligationIds,
          itemIds,
          evidenceIds,
          rootCause:
            "The acceptance decision omitted authenticated coverage bindings declared by the exact proposal.",
          correction:
            "Reassess every declared criterion and Factory capability binding; preserve both kinds for mixed obligations.",
          uncertainty: "",
        },
      ],
      decision: "repair" as const,
    };
    try {
      return validateCompilerJudgeVerdict(repair, expected);
    } catch {
      return null;
    }
  }
  let unsupported: Set<string>;
  try {
    unsupported = unsupportedInferenceObligationIds(verdict, expected);
  } catch {
    return null;
  }
  const unresolvedCoverage = verdict.coverage.filter(
    (entry) => entry.status !== "covered" && !unsupported.has(entry.obligationId),
  );
  const unknownItems = verdict.items.filter((entry) => entry.granularity === "unknown");
  const unknownDimensions = verdict.dimensions.filter((entry) => entry.status === "unknown");
  const materialFindings = verdict.findings.filter((entry) => entry.severity !== "advisory");
  if (
    unresolvedCoverage.length === 0 &&
    unknownItems.length === 0 &&
    unknownDimensions.length === 0 &&
    materialFindings.length === 0
  )
    return null;

  const findings = [...verdict.findings];
  if (materialFindings.length === 0) {
    if (findings.length >= 64) return null;
    const obligationIds = [...new Set(unresolvedCoverage.map((entry) => entry.obligationId))];
    const itemIds = [
      ...new Set([
        ...unresolvedCoverage.flatMap((entry) => entry.itemIds),
        ...unknownItems.map((entry) => entry.itemId),
      ]),
    ];
    // A rubric dimension assesses the whole candidate. Binding all existing
    // items identifies that exact graph without inventing scope or obligations.
    if (itemIds.length === 0) itemIds.push(...expected.graph.workItems.map((entry) => entry.id));
    const evidenceIds = [
      ...new Set(
        [...unresolvedCoverage, ...unknownItems, ...unknownDimensions].flatMap(
          (entry) => entry.evidenceIds,
        ),
      ),
    ];
    if (evidenceIds.length === 0 || (obligationIds.length === 0 && itemIds.length === 0))
      return null;
    const usedIds = new Set(findings.map((entry) => entry.id));
    let id = "invalid-acceptance";
    for (let suffix = 2; usedIds.has(id); suffix++) id = `invalid-acceptance-${suffix}`;
    const unresolved = [
      ...unresolvedCoverage.map((entry) => `coverage ${entry.obligationId} is ${entry.status}`),
      ...unknownItems.map((entry) => `item ${entry.itemId} granularity is unknown`),
      ...unknownDimensions.map((entry) => `dimension ${entry.dimension} is unknown`),
    ];
    findings.push({
      id,
      dimension:
        unknownDimensions[0]?.dimension ?? (unknownItems.length ? "granularity" : "coverage"),
      severity: "blocking",
      confidence: 1,
      obligationIds,
      itemIds,
      evidenceIds,
      rootCause: `The judge requested acceptance while ${unresolved.join("; ")}.`.slice(0, 4000),
      correction:
        "Clarify the existing Work Items only where needed to resolve the cited assessment; preserve every obligation and do not add scope solely to populate the rubric.",
      uncertainty: [...unknownItems, ...unknownDimensions]
        .map((entry) => entry.reason)
        .join("; ")
        .slice(0, 4000),
    });
  }
  const repair = { ...verdict, findings, decision: "repair" as const };
  try {
    return validateCompilerJudgeVerdict(repair, expected);
  } catch {
    return null;
  }
}

/** Stable identity independent of object key insertion order; arrays retain their order. */
export function compilerEvalDigest(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    if (entry !== null && typeof entry === "object")
      return `{${Object.entries(entry)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    return JSON.stringify(entry);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
function references(ids: string[], available: Set<string>, label: string) {
  unique(ids, label);
  if (ids.some((id) => !available.has(id))) throw new Error(`unknown ${label}`);
}

function unsupportedInferenceObligationIds(
  verdict: CompilerJudgeVerdict,
  expected: CompilerJudgeValidationContext,
): Set<string> {
  const challenges = validateCompilerInferenceChallenges(
    expected.challenges ?? [],
    expected.inventory,
  );
  const corrections = verdict.inferenceCorrections ?? [];
  unique(
    corrections.map((entry) => `${entry.findingId}\0${entry.obligationId}`),
    "inference correction",
  );
  const evidence = new Set(expected.inventory.evidence.map((entry) => entry.id));
  const unsupported = new Set<string>();
  for (const correction of corrections) {
    const challenge = challenges.find(
      (entry) =>
        entry.findingId === correction.findingId && entry.obligationId === correction.obligationId,
    );
    if (!challenge) throw new Error("inference correction requires a matching compiler challenge");
    references(correction.evidenceIds, evidence, "inference correction citation");
    if (!correction.evidenceIds.some((id) => challenge.evidenceIds.includes(id)))
      throw new Error("inference correction must adjudicate cited challenge evidence");
    if (correction.disposition === "unsupported-inference") {
      if (
        expected.inventory.obligations.find((entry) => entry.id === correction.obligationId)
          ?.kind === "explicit"
      )
        throw new Error("explicit Objective obligations cannot be waived");
      const coverage = verdict.coverage.find(
        (entry) => entry.obligationId === correction.obligationId,
      );
      if (coverage?.status !== "missing" && coverage?.status !== "unknown")
        throw new Error("unsupported inference must preserve missing or unknown original coverage");
      unsupported.add(correction.obligationId);
    }
  }
  if (
    corrections.some(
      (entry) => entry.disposition === "upheld" && unsupported.has(entry.obligationId),
    )
  )
    throw new Error("contradictory inference corrections");
  return unsupported;
}
/** Evidence is supplied by the pinned repository reader, never by the model as authority. */
export function parseObligationInventory(
  value: unknown,
  expected: {
    objectiveDigest: string;
    baseSha: string;
    evidence: readonly CompilerEvidence[];
  },
): ObligationInventory {
  const inventory = ObligationInventorySchema.parse(value);
  if (
    inventory.objectiveDigest !== expected.objectiveDigest ||
    inventory.baseSha !== expected.baseSha
  )
    throw new Error("obligation inventory input identity mismatch");
  unique(
    expected.evidence.map((entry) => entry.id),
    "trusted evidence identity",
  );
  unique(
    inventory.evidence.map((entry) => entry.id),
    "evidence identity",
  );
  unique(
    inventory.obligations.map((entry) => entry.id),
    "obligation identity",
  );
  for (const cited of inventory.evidence) {
    const source = expected.evidence.find((entry) => entry.id === cited.id);
    if (
      !source ||
      source.identity !== cited.identity ||
      source.kind !== cited.kind ||
      !source.excerpt.includes(cited.excerpt)
    )
      throw new Error("ungrounded evidence citation");
  }
  const ids = new Set(inventory.evidence.map((entry) => entry.id));
  for (const obligation of inventory.obligations)
    references(obligation.evidenceIds, ids, "obligation citation");
  if (!inventory.evidence.some((entry) => entry.kind === "objective"))
    throw new Error("inventory requires original Objective evidence");
  return inventory;
}

/** Attach Factory-owned source identity without accepting a model-authored evidence envelope. */
export function hydrateObligationInventory(
  value: unknown,
  expected: {
    objectiveDigest: string;
    baseSha: string;
    evidence: readonly CompilerEvidence[];
  },
): ObligationInventory {
  const claims = ObligationClaimsSchema.parse(value);
  return parseObligationInventory(
    {
      version: claims.version,
      objectiveDigest: expected.objectiveDigest,
      baseSha: expected.baseSha,
      evidence: expected.evidence,
      obligations: claims.obligations,
    },
    expected,
  );
}

export function validateCompilerJudgeVerdict(
  value: unknown,
  expected: CompilerJudgeValidationContext,
): CompilerJudgeVerdict {
  const verdict = CompilerJudgeVerdictSchema.parse(value);
  if (
    verdict.draftDigest !== expected.draftDigest ||
    verdict.inventoryDigest !== compilerEvalDigest(expected.inventory)
  )
    throw new Error("judge identity mismatch");
  const evidence = new Set(expected.inventory.evidence.map((entry) => entry.id));
  const obligations = new Set(expected.inventory.obligations.map((entry) => entry.id));
  const items = new Set(expected.graph.workItems.map((entry) => entry.id));
  const factoryCapabilities = new Set(
    (expected.factoryCapabilities ?? []).map(
      (entry) => FactoryCompilerCapabilitySchema.parse(entry).id,
    ),
  );
  const coverageIds = verdict.coverage.map((entry) => entry.obligationId);
  references(coverageIds, obligations, "coverage obligation");
  if (coverageIds.length !== obligations.size)
    throw new Error("incomplete Objective coverage review");
  const itemIds = verdict.items.map((entry) => entry.itemId);
  references(itemIds, items, "granularity item");
  if (itemIds.length !== items.size) throw new Error("incomplete item granularity review");
  unique(
    verdict.dimensions.map((entry) => entry.dimension),
    "rubric dimension",
  );
  for (const entry of [
    ...verdict.coverage,
    ...verdict.items,
    ...verdict.dimensions,
    ...verdict.dependencies,
    ...verdict.findings,
  ])
    references(entry.evidenceIds, evidence, "judge citation");
  for (const entry of verdict.coverage) {
    references(entry.itemIds, items, "coverage item");
    unique(entry.acceptanceBindings.map(coverageBindingKey), "acceptance binding");
    for (const binding of entry.acceptanceBindings) {
      if (binding.kind === "factory-capability") {
        if (!factoryCapabilities.has(binding.capabilityId))
          throw new Error("ungrounded Factory capability binding");
        continue;
      }
      const item = expected.graph.workItems.find((candidate) => candidate.id === binding.itemId);
      if (
        !entry.itemIds.includes(binding.itemId) ||
        !item?.criteria.some((criterion) => criterion.id === binding.criterionId)
      )
        throw new Error("ungrounded acceptance binding");
    }
    if (entry.status === "covered" && entry.acceptanceBindings.length === 0)
      throw new Error("covered obligation requires acceptance binding");
    if (
      entry.status === "covered" &&
      entry.acceptanceBindings.some((binding) => binding.kind === "criterion") &&
      entry.itemIds.length === 0
    )
      throw new Error("criterion-covered obligation requires item mapping");
    if (entry.status === "covered" && verdict.decision === "accept") {
      const observed = new Set(entry.acceptanceBindings.map(coverageBindingKey));
      const omitted =
        expected.graph.coverage
          ?.find((row) => row.obligationId === entry.obligationId)
          ?.bindings.filter((binding) => !observed.has(coverageBindingKey(binding))) ?? [];
      if (omitted.length > 0) throw new Error("accepted coverage omits proposed binding");
    }
  }
  const expectedDependencies = new Map(
    expected.graph.workItems.map((entry) => [entry.id, new Set(entry.dependsOn)] as const),
  );
  for (const edge of expected.addedEdges ?? []) {
    const dependencies = expectedDependencies.get(edge.itemId);
    if (!dependencies || !items.has(edge.dependsOn))
      throw new Error("invalid Factory-added dependency edge");
    dependencies.add(edge.dependsOn);
  }
  unique(
    verdict.dependencies.map((entry) => entry.itemId),
    "dependency item",
  );
  references(
    verdict.dependencies.map((entry) => entry.itemId),
    items,
    "dependency item",
  );
  if (verdict.dependencies.length !== items.size)
    throw new Error("incomplete dependency rationale");
  for (const entry of verdict.dependencies) {
    references(entry.dependsOn, items, "dependency edge");
    const wanted = [...expectedDependencies.get(entry.itemId)!].sort();
    const reviewed = [...entry.dependsOn].sort();
    if (compilerEvalDigest(reviewed) !== compilerEvalDigest(wanted))
      throw new Error("dependency rationale differs from exact dependency set");
  }
  unique(
    verdict.findings.map((entry) => entry.id),
    "finding identity",
  );
  unique(
    verdict.findings.map((entry) =>
      compilerEvalDigest({
        rootCause: entry.rootCause.trim().toLowerCase(),
        obligationIds: [...entry.obligationIds].sort(),
        itemIds: [...entry.itemIds].sort(),
      }),
    ),
    "finding root cause",
  );
  for (const entry of verdict.findings) {
    references(entry.obligationIds, obligations, "finding obligation");
    references(entry.itemIds, items, "finding item");
    if (!entry.obligationIds.length && !entry.itemIds.length)
      throw new Error("finding requires affected identity");
  }
  const unsupported = unsupportedInferenceObligationIds(verdict, expected);
  if (
    verdict.decision === "accept" &&
    (verdict.coverage.some(
      (entry) => entry.status !== "covered" && !unsupported.has(entry.obligationId),
    ) ||
      verdict.findings.some((entry) => entry.severity !== "advisory") ||
      verdict.items.some((entry) => entry.granularity === "unknown") ||
      verdict.dimensions.some((entry) => entry.status === "unknown"))
  )
    throw new Error("acceptance has unresolved coverage or blockers");
  if (
    verdict.decision === "repair" &&
    !verdict.coverage.some(
      (entry) => entry.status !== "covered" && !unsupported.has(entry.obligationId),
    ) &&
    !verdict.findings.some((entry) => entry.severity !== "advisory")
  )
    throw new CompilerJudgeNoMaterialRepairError();
  return verdict;
}

export interface CompilerEvalUsage {
  invocationId: string;
  phase: "obligations" | "compile" | "judge" | "repair" | "worker" | "validation";
  evidenceId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  observedTokens: number | null;
  observedMilliseconds: number | null;
}
export interface CompilerPostMortemCause {
  findingId: string;
  cause: "compiler" | "worker" | "infrastructure" | "changed-requirement" | "mixed" | "unknown";
  evidenceIds: string[];
  explanation: string;
  estimatedAvoidableTokens: number | null;
  uncertainty: string;
}
export function createCompilerEvalReport(input: {
  inventory: ObligationInventory;
  factoryCapabilities?: FactoryCompilerCapability[];
  graph: {
    workItems: Array<{ id: string; dependsOn: string[]; criteria: Array<{ id: string }> }>;
  };
  addedEdges?: Array<{ itemId: string; dependsOn: string }>;
  verdict: CompilerJudgeVerdict;
  draftDigest: string;
  challenges?: CompilerInferenceChallenge[];
  mode?: "plan-review" | "post-mortem";
  usage?: CompilerEvalUsage[];
  causes?: CompilerPostMortemCause[];
  /** Trusted caller establishes whether all expected invocation evidence is present. */
  usageComplete?: boolean;
  notInvokedPhases?: CompilerEvalUsage["phase"][];
  historicalEvidence?: CompilerEvidence[];
  economics?: DecompositionEvidence;
  /** Full compiler shape is needed only for optional heuristic economics. */
  economicGraph?: CompilerObjective;
}) {
  const verdict = validateCompilerJudgeVerdict(input.verdict, input);
  const usage = input.usage ?? [];
  const causes = input.causes ?? [];
  const evidence = [
    ...input.inventory.evidence,
    ...(input.historicalEvidence ?? []).map((entry) => CompilerEvidenceSchema.parse(entry)),
  ];
  unique(
    evidence.map((entry) => entry.id),
    "report evidence",
  );
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  unique(
    usage.map((entry) => entry.invocationId),
    "usage invocation",
  );
  for (const entry of usage) {
    references([entry.evidenceId], evidenceIds, "usage evidence");
    for (const value of [
      entry.inputTokens,
      entry.outputTokens,
      entry.cachedInputTokens,
      entry.observedTokens,
      entry.observedMilliseconds,
    ])
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new Error("invalid observed usage");
    if (
      entry.inputTokens !== null &&
      entry.outputTokens !== null &&
      entry.observedTokens !== entry.inputTokens + entry.outputTokens
    )
      throw new Error("observed token total disagrees with input and output");
    if (
      entry.cachedInputTokens !== null &&
      entry.inputTokens !== null &&
      entry.cachedInputTokens > entry.inputTokens
    )
      throw new Error("cached input exceeds input tokens");
  }
  for (const entry of causes) {
    references(
      [entry.findingId],
      new Set(verdict.findings.map((finding) => finding.id)),
      "post-mortem finding",
    );
    references(entry.evidenceIds, evidenceIds, "post-mortem evidence");
    if (entry.cause !== "unknown" && entry.evidenceIds.length === 0)
      throw new Error("attribution requires evidence");
    if (
      entry.estimatedAvoidableTokens !== null &&
      (!Number.isFinite(entry.estimatedAvoidableTokens) || entry.estimatedAvoidableTokens < 0)
    )
      throw new Error("invalid avoidable-waste estimate");
  }
  const missingEvidence = [
    ...(usage.length === 0 ? ["No observed invocation usage supplied"] : []),
    ...usage
      .filter((entry) => entry.observedTokens === null)
      .map((entry) => `Token usage unavailable: ${entry.invocationId}`),
    ...usage
      .filter((entry) => entry.observedMilliseconds === null)
      .map((entry) => `Timing unavailable: ${entry.invocationId}`),
    ...(["obligations", "compile", "judge", "repair"] as const)
      .filter(
        (phase) =>
          !usage.some((entry) => entry.phase === phase) && !input.notInvokedPhases?.includes(phase),
      )
      .map((phase) => `Evaluation overhead unavailable or not invoked: ${phase}`),
  ];
  return {
    version: 1 as const,
    format: "compiler-eval" as const,
    mode: input.mode ?? "plan-review",
    inventory: input.inventory,
    factoryCapabilities: input.factoryCapabilities ?? [],
    draftDigest: input.draftDigest,
    verdict,
    challenges: input.challenges ?? [],
    evidence,
    usage,
    causes,
    economics:
      input.economics && input.economicGraph
        ? assessDecomposition(input.economicGraph.workItems, input.economics)
        : null,
    observedTokenSubtotal: usage.reduce((sum, entry) => sum + (entry.observedTokens ?? 0), 0),
    observedTotalTokens:
      input.usageComplete === true && usage.every((entry) => entry.observedTokens !== null)
        ? usage.reduce((sum, entry) => sum + (entry.observedTokens ?? 0), 0)
        : null,
    missingEvidence,
    economicBenefitMeasured: false as const,
    humanCalibrationProven: false as const,
  };
}
export type CompilerEvalReport = ReturnType<typeof createCompilerEvalReport>;
export function renderCompilerEvalMarkdown(report: CompilerEvalReport): string {
  const clean = (value: string) => value.replace(/[\r\n|]/g, " ");
  return [
    `# Compiler evaluation (${report.mode})`,
    "",
    `Draft: ${report.draftDigest}`,
    `Decision: ${report.verdict.decision}`,
    "",
    "## Objective coverage",
    "",
    ...report.verdict.coverage.map(
      (entry) =>
        `- ${clean(entry.obligationId)}: ${entry.status} — ${clean(entry.reason)} (evidence: ${entry.evidenceIds.map(clean).join(", ")})`,
    ),
    "",
    "## Independently adjudicated inference corrections",
    "",
    ...(report.verdict.inferenceCorrections ?? []).map(
      (entry) =>
        `- ${clean(entry.obligationId)} (finding ${clean(entry.findingId)}): ${entry.disposition}; ${clean(entry.reason)}; evidence: ${entry.evidenceIds.map(clean).join(", ")}. Original obligation and coverage remain preserved.`,
    ),
    "",
    "## Granularity and dependencies",
    "",
    ...report.verdict.items.map(
      (entry) =>
        `- ${clean(entry.itemId)}: ${entry.granularity}; ${clean(entry.reason)}; evidence: ${entry.evidenceIds.map(clean).join(", ")}`,
    ),
    ...report.verdict.dependencies.map(
      (entry) =>
        `- ${clean(entry.itemId)} depends on ${entry.dependsOn.map(clean).join(", ") || "nothing"}: ${clean(entry.reason)}; evidence: ${entry.evidenceIds.map(clean).join(", ")}`,
    ),
    "",
    "## Quality dimensions",
    "",
    ...report.verdict.dimensions.map(
      (entry) =>
        `- ${entry.dimension}: ${entry.status}; ${clean(entry.reason)}; evidence: ${entry.evidenceIds.map(clean).join(", ")}`,
    ),
    "",
    "## Findings",
    "",
    ...report.verdict.findings.map(
      (entry) =>
        `- ${entry.severity}: ${clean(entry.rootCause)}. Correction: ${clean(entry.correction)}. Affected obligations: ${entry.obligationIds.map(clean).join(", ")}; items: ${entry.itemIds.map(clean).join(", ")}; evidence: ${entry.evidenceIds.map(clean).join(", ")}. Confidence: ${entry.confidence}; uncertainty: ${clean(entry.uncertainty)}`,
    ),
    "",
    "## Attribution",
    "",
    ...report.causes.map(
      (entry) =>
        `- ${clean(entry.findingId)}: ${entry.cause}; ${clean(entry.explanation)}; estimated avoidable tokens: ${entry.estimatedAvoidableTokens ?? "unknown"}; evidence: ${entry.evidenceIds.map(clean).join(", ")}`,
    ),
    "",
    "## Invocation observations",
    "",
    ...report.usage.map(
      (entry) =>
        `- ${clean(entry.invocationId)} (${entry.phase}): total tokens ${entry.observedTokens ?? "unavailable"}; input ${entry.inputTokens ?? "unavailable"}; output ${entry.outputTokens ?? "unavailable"}; cached input ${entry.cachedInputTokens ?? "unavailable"} (cached input is included in input); milliseconds ${entry.observedMilliseconds ?? "unknown"}; evidence: ${clean(entry.evidenceId)}`,
    ),
    "",
    "## Accounting and limitations",
    "",
    `Observed token subtotal: ${report.observedTokenSubtotal}; total: ${report.observedTotalTokens ?? "unknown"}.`,
    "Estimated avoidable waste is not measured savings. Synthetic reports do not establish human calibration or economic benefit.",
    ...report.missingEvidence.map((entry) => `- ${clean(entry)}`),
    ...report.verdict.uncertainty.map((entry) => `- Uncertainty: ${clean(entry)}`),
    "",
  ].join("\n");
}

export interface CompilerCalibrationCase {
  id: string;
  split: "calibration" | "held-out";
  labelProvenance: "human" | "llm-assisted" | "synthetic";
  labelEvidence: string;
  /** Positive = genuine omission; negative = valid plan. */
  expectedOmissions: string[];
  expectedRepair: boolean;
  validPlan: boolean;
  reportedOmissions: string[];
  findingCount: number;
  unsupportedFindingCount: number;
  repaired: boolean;
  accepted: boolean;
  validAlternative: boolean;
  cosmeticGroup: string | null;
  outcome: "completed" | "failed" | "inconclusive";
}
/** A measurement helper; synthetic wiring cases remain explicitly unqualified. */
export function measureCompilerCalibration(cases: readonly CompilerCalibrationCase[]) {
  unique(
    cases.map((entry) => entry.id),
    "calibration case",
  );
  for (const entry of cases) {
    if (!entry.labelEvidence.trim()) throw new Error("calibration requires label provenance");
    if (
      !Number.isInteger(entry.findingCount) ||
      !Number.isInteger(entry.unsupportedFindingCount) ||
      entry.findingCount < 0 ||
      entry.unsupportedFindingCount < 0 ||
      entry.unsupportedFindingCount > entry.findingCount
    )
      throw new Error("invalid calibration finding counts");
    unique(entry.expectedOmissions, "expected omission");
    unique(entry.reportedOmissions, "reported omission");
  }
  const ratio = (numerator: number, denominator: number) =>
    denominator ? numerator / denominator : null;
  const measure = (
    split: CompilerCalibrationCase["split"],
    provenance?: CompilerCalibrationCase["labelProvenance"],
  ) => {
    const all = cases.filter(
      (entry) => entry.split === split && (!provenance || entry.labelProvenance === provenance),
    );
    const complete = all.filter((entry) => entry.outcome === "completed");
    const expected = complete.reduce((sum, entry) => sum + entry.expectedOmissions.length, 0);
    const found = complete.reduce(
      (sum, entry) =>
        sum + entry.expectedOmissions.filter((id) => entry.reportedOmissions.includes(id)).length,
      0,
    );
    const valid = complete.filter((entry) => entry.validPlan && !entry.expectedRepair);
    const alternatives = complete.filter((entry) => entry.validAlternative);
    const groups = [
      ...new Set(complete.flatMap((entry) => (entry.cosmeticGroup ? [entry.cosmeticGroup] : []))),
    ]
      .map((group) => complete.filter((entry) => entry.cosmeticGroup === group))
      .filter((group) => group.length > 1);
    return {
      cases: all.length,
      failed: all.filter((entry) => entry.outcome === "failed").length,
      inconclusive: all.filter((entry) => entry.outcome === "inconclusive").length,
      omissionRecall: ratio(found, expected),
      unsupportedFindingRate: ratio(
        complete.reduce((sum, entry) => sum + entry.unsupportedFindingCount, 0),
        complete.reduce((sum, entry) => sum + entry.findingCount, 0),
      ),
      unnecessaryRepairRate: ratio(valid.filter((entry) => entry.repaired).length, valid.length),
      validAlternativeAcceptanceRate: ratio(
        alternatives.filter((entry) => entry.accepted).length,
        alternatives.length,
      ),
      cosmeticStability: ratio(
        groups.filter(
          (group) =>
            new Set(
              group.map((entry) =>
                compilerEvalDigest({
                  accepted: entry.accepted,
                  repaired: entry.repaired,
                  omissions: [...entry.reportedOmissions].sort(),
                }),
              ),
            ).size === 1,
        ).length,
        groups.length,
      ),
      humanLabeledPositiveAndNegative:
        complete.some(
          (entry) => entry.labelProvenance === "human" && entry.expectedOmissions.length > 0,
        ) &&
        complete.some(
          (entry) => entry.labelProvenance === "human" && entry.validPlan && !entry.expectedRepair,
        ),
    };
  };
  const calibration = measure("calibration");
  const heldOut = measure("held-out");
  const contaminatedGroups = new Set(
    cases
      .filter((entry) => entry.split === "calibration")
      .flatMap((entry) => (entry.cosmeticGroup ? [entry.cosmeticGroup] : [])),
  );
  if (
    cases.some(
      (entry) =>
        entry.split === "held-out" &&
        entry.cosmeticGroup &&
        contaminatedGroups.has(entry.cosmeticGroup),
    )
  )
    throw new Error("cosmetic variants cannot cross held-out boundary");
  return {
    version: 1 as const,
    cases: [...cases],
    calibration,
    heldOut,
    aggregateProvenance:
      new Set(cases.map((entry) => entry.labelProvenance)).size > 1
        ? "mixed"
        : (cases[0]?.labelProvenance ?? "unavailable"),
    byProvenance: {
      human: {
        calibration: measure("calibration", "human"),
        heldOut: measure("held-out", "human"),
      },
      "llm-assisted": {
        calibration: measure("calibration", "llm-assisted"),
        heldOut: measure("held-out", "llm-assisted"),
      },
      synthetic: {
        calibration: measure("calibration", "synthetic"),
        heldOut: measure("held-out", "synthetic"),
      },
    },
    humanCalibrationProven:
      cases.length > 0 &&
      cases.every((entry) => entry.labelProvenance === "human" && entry.outcome === "completed") &&
      calibration.humanLabeledPositiveAndNegative &&
      heldOut.humanLabeledPositiveAndNegative,
    economicBenefitMeasured: false as const,
  };
}

/** Assisted labels are machine evidence, never human gold or an activation verdict. */
export const CompilerCaseLabelSchema = z
  .object({
    version: z.literal(1),
    caseDigest: Digest,
    provenance: z.literal("llm-assisted"),
    pass: z.enum(["blinded", "adjudication"]),
    obligations: z
      .array(
        z
          .object({
            id: Id,
            text: Text,
            evidenceIds: Refs.min(1),
            status: z.enum(["required", "unsupported", "ambiguous"]),
            reason: Text,
          })
          .strict(),
      )
      .min(1)
      .max(128),
    disagreements: z
      .array(
        z
          .object({
            obligationId: Id,
            priorStatus: z.enum(["required", "unsupported", "ambiguous"]),
            reason: Text,
            evidenceIds: Refs.min(1),
          })
          .strict(),
      )
      .max(128),
    uncertainty: z.array(Text).max(64),
  })
  .strict();
export type CompilerCaseLabel = z.infer<typeof CompilerCaseLabelSchema>;
export function validateCompilerCaseLabel(
  value: unknown,
  expected: {
    caseDigest: string;
    evidence: readonly CompilerEvidence[];
    pass: CompilerCaseLabel["pass"];
    priorLabel?: CompilerCaseLabel;
  },
): CompilerCaseLabel {
  const label = CompilerCaseLabelSchema.parse(value);
  if (label.caseDigest !== expected.caseDigest || label.pass !== expected.pass)
    throw new Error("label input identity mismatch");
  unique(
    label.obligations.map((entry) => entry.id),
    "label obligation",
  );
  unique(
    label.disagreements.map((entry) => entry.obligationId),
    "label disagreement",
  );
  const ids = new Set(expected.evidence.map((entry) => entry.id));
  for (const entry of [...label.obligations, ...label.disagreements])
    references(entry.evidenceIds, ids, "label citation");
  if (label.pass === "blinded") {
    if (expected.priorLabel || label.disagreements.length)
      throw new Error("blinded label cannot consume a prior label");
  } else {
    const prior = expected.priorLabel;
    if (!prior || prior.pass !== "blinded" || prior.caseDigest !== label.caseDigest)
      throw new Error("adjudication requires the exact blinded label");
    const previous = new Map(prior.obligations.map((entry) => [entry.id, entry]));
    for (const entry of prior.obligations)
      if (!label.obligations.some((current) => current.id === entry.id))
        throw new Error("adjudication cannot silently drop obligations");
    for (const disagreement of label.disagreements) {
      const original = previous.get(disagreement.obligationId);
      const current = label.obligations.find((entry) => entry.id === disagreement.obligationId);
      if (
        !original ||
        !current ||
        original.status !== disagreement.priorStatus ||
        current.status === original.status
      )
        throw new Error("ungrounded label disagreement");
    }
    for (const entry of label.obligations) {
      const original = previous.get(entry.id);
      if (original && entry.text !== original.text)
        throw new Error("adjudication cannot silently rewrite obligation text");
      if (
        original &&
        entry.status !== original.status &&
        !label.disagreements.some((disagreement) => disagreement.obligationId === entry.id)
      )
        throw new Error("label disagreement must be preserved");
    }
  }
  if (
    label.obligations.some((entry) => entry.status === "ambiguous") &&
    label.uncertainty.length === 0
  )
    throw new Error("ambiguous labels must expose uncertainty");
  return label;
}

export interface CompilerComparisonArm {
  outcome: "accepted" | "failed" | "inconclusive";
  evidenceIds: string[];
  remainingObligations: string[];
  regressions: string[];
  /** Total observed effort includes extraction, all failed calls, repair, judge and workers. */
  observedTotalTokens: number | null;
  observedElapsedMilliseconds: number | null;
}
export interface CompilerComparisonPair {
  caseDigest: string;
  conditionsDigest: string;
  provenance: "observed" | "synthetic";
  unrepaired: CompilerComparisonArm;
  repaired: CompilerComparisonArm;
}
/** Keeps failed/inconclusive arms in the denominator and never turns judge scores into savings. */
export function measureCompilerRepairComparison(pairs: readonly CompilerComparisonPair[]) {
  unique(
    pairs.map((pair) => `${pair.caseDigest}:${pair.conditionsDigest}`),
    "comparison pair",
  );
  for (const pair of pairs) {
    Digest.parse(pair.caseDigest);
    Digest.parse(pair.conditionsDigest);
    for (const arm of [pair.unrepaired, pair.repaired]) {
      if (arm.evidenceIds.length === 0)
        throw new Error("comparison requires original arm evidence");
      for (const value of [arm.observedTotalTokens, arm.observedElapsedMilliseconds])
        if (value !== null && (!Number.isFinite(value) || value < 0))
          throw new Error("invalid comparison observation");
    }
  }
  const measured = pairs.filter(
    (pair) =>
      pair.provenance === "observed" &&
      pair.unrepaired.outcome === "accepted" &&
      pair.repaired.outcome === "accepted" &&
      pair.unrepaired.observedTotalTokens !== null &&
      pair.repaired.observedTotalTokens !== null &&
      pair.unrepaired.observedElapsedMilliseconds !== null &&
      pair.repaired.observedElapsedMilliseconds !== null,
  );
  return {
    version: 1 as const,
    pairs: [...pairs],
    pairCount: pairs.length,
    measuredPairCount: measured.length,
    failedOrInconclusivePairs: pairs.filter(
      (pair) => pair.unrepaired.outcome !== "accepted" || pair.repaired.outcome !== "accepted",
    ).length,
    defectReduction: pairs.reduce(
      (sum, pair) =>
        sum +
        pair.unrepaired.remainingObligations.length -
        pair.repaired.remainingObligations.length,
      0,
    ),
    regressions: pairs.reduce((sum, pair) => sum + pair.repaired.regressions.length, 0),
    observedTokenDifference:
      measured.length > 0
        ? measured.reduce(
            (sum, pair) =>
              sum +
              (pair.unrepaired.observedTotalTokens ?? 0) -
              (pair.repaired.observedTotalTokens ?? 0),
            0,
          )
        : null,
    observedElapsedDifferenceMilliseconds:
      measured.length > 0
        ? measured.reduce(
            (sum, pair) =>
              sum +
              (pair.unrepaired.observedElapsedMilliseconds ?? 0) -
              (pair.repaired.observedElapsedMilliseconds ?? 0),
            0,
          )
        : null,
    economicBenefitMeasured: measured.length > 0 && measured.length === pairs.length,
    limitation:
      "Matched observations describe these cases only; estimated defects and judge scores do not establish savings. Positive differences mean less observed repaired effort, negative differences mean more.",
  };
}

export const CompilerInferenceChallengeSchema = z
  .object({
    findingId: Id,
    obligationId: Id.optional(),
    originalFinding: z
      .object({ dimension: Dimension, rootCause: Text, correction: Text, itemIds: Refs.min(1) })
      .strict()
      .optional(),
    reason: Text,
    evidenceIds: Refs.min(1),
  })
  .strict()
  .refine(
    (entry) => entry.obligationId !== undefined || entry.originalFinding !== undefined,
    "challenge requires an original obligation or item finding",
  );
export type CompilerInferenceChallenge = z.infer<typeof CompilerInferenceChallengeSchema>;
export const CompilerInferenceChallengesSchema = z
  .array(CompilerInferenceChallengeSchema)
  .max(MAX_COMPILER_INFERENCE_CHALLENGES)
  .superRefine((challenges, context) => {
    const obligationCount = challenges.filter(
      (challenge) => challenge.obligationId !== undefined,
    ).length;
    const itemCount = challenges.length - obligationCount;
    if (obligationCount > MAX_COMPILER_OBLIGATION_CHALLENGES)
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: MAX_COMPILER_OBLIGATION_CHALLENGES,
        inclusive: true,
        exact: false,
        message: "too many obligation inference challenges",
      });
    if (itemCount > MAX_COMPILER_ITEM_CHALLENGES)
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: MAX_COMPILER_ITEM_CHALLENGES,
        inclusive: true,
        exact: false,
        message: "too many item-only inference challenges",
      });
  });

export class CompilerInferenceChallengeLimitError extends CompilerDraftStopError {
  constructor(kind: "obligation" | "item-only", observed: number, maximum: number) {
    super(`compiler-inference-challenge-limit: ${kind} challenges ${observed} exceed ${maximum}`);
    this.name = "CompilerInferenceChallengeLimitError";
  }
}

export function validateCompilerInferenceChallenges(
  value: unknown,
  inventory: ObligationInventory | CompilerPlanningInventory,
): CompilerInferenceChallenge[] {
  const challenges = z.array(CompilerInferenceChallengeSchema).parse(value);
  const obligationChallenges = challenges.filter(
    (challenge) => challenge.obligationId !== undefined,
  );
  const itemChallenges = challenges.filter((challenge) => challenge.obligationId === undefined);
  if (obligationChallenges.length > MAX_COMPILER_OBLIGATION_CHALLENGES)
    throw new CompilerInferenceChallengeLimitError(
      "obligation",
      obligationChallenges.length,
      MAX_COMPILER_OBLIGATION_CHALLENGES,
    );
  if (itemChallenges.length > MAX_COMPILER_ITEM_CHALLENGES)
    throw new CompilerInferenceChallengeLimitError(
      "item-only",
      itemChallenges.length,
      MAX_COMPILER_ITEM_CHALLENGES,
    );
  unique(
    challenges.map((entry) => `${entry.findingId}\0${entry.obligationId ?? ""}`),
    "inference challenge",
  );
  unique(
    obligationChallenges.map((entry) => entry.obligationId!),
    "challenged obligation",
  );
  const evidence = new Set(inventory.evidence.map((entry) => entry.id));
  const obligations = new Set(inventory.obligations.map((entry) => entry.id));
  for (const challenge of challenges) {
    if (challenge.obligationId !== undefined)
      references([challenge.obligationId], obligations, "challenged obligation");
    if (challenge.originalFinding) unique(challenge.originalFinding.itemIds, "challenged item");
    references(challenge.evidenceIds, evidence, "challenge citation");
  }
  return challenges;
}

function canonicalInferenceChallenges(
  challenges: readonly CompilerInferenceChallenge[],
): CompilerInferenceChallenge[] {
  const obligationChallenges = new Map<string, CompilerInferenceChallenge>();
  const itemChallenges = new Map<string, CompilerInferenceChallenge>();
  for (const challenge of challenges) {
    if (challenge.obligationId === undefined) {
      const existing = itemChallenges.get(challenge.findingId);
      if (!existing || compilerEvalDigest(challenge) < compilerEvalDigest(existing))
        itemChallenges.set(challenge.findingId, challenge);
      continue;
    }
    const existing = obligationChallenges.get(challenge.obligationId);
    if (
      !existing ||
      challenge.findingId < existing.findingId ||
      (challenge.findingId === existing.findingId &&
        compilerEvalDigest(challenge) < compilerEvalDigest(existing))
    )
      obligationChallenges.set(challenge.obligationId, challenge);
  }
  return [
    ...[...obligationChallenges.values()].sort((left, right) =>
      left.obligationId!.localeCompare(right.obligationId!),
    ),
    ...[...itemChallenges.values()].sort((left, right) =>
      left.findingId.localeCompare(right.findingId),
    ),
  ];
}

/** Derive the exact post-repair judge challenges from durable request evidence.
 * Explicit obligations and obligations mapped by the repaired proposal are never challenged. */
export function deriveCompilerInferenceChallenges(input: {
  inventory: ObligationInventory | CompilerPlanningInventory;
  findings: CompilerJudgeVerdict["findings"];
  proposal: {
    coverage: Array<{ obligationId: string; bindings: ObligationCoverageBinding[] }>;
  };
  carried?: unknown;
}): CompilerInferenceChallenge[] {
  const carried = validateCompilerInferenceChallenges(input.carried ?? [], input.inventory);
  const carriedObligations = new Set(
    carried.flatMap((challenge) =>
      challenge.obligationId === undefined ? [] : [challenge.obligationId],
    ),
  );
  const mapped = new Set(
    input.proposal.coverage
      .filter((entry) => entry.bindings.length > 0)
      .map((entry) => entry.obligationId),
  );
  const challengeable = new Set(
    input.inventory.obligations
      .filter((obligation) => obligation.kind !== "explicit" && !mapped.has(obligation.id))
      .map((obligation) => obligation.id),
  );
  const generated = canonicalInferenceChallenges(
    [...input.findings]
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((finding) =>
        [...finding.obligationIds]
          .sort()
          .filter(
            (obligationId) =>
              challengeable.has(obligationId) && !carriedObligations.has(obligationId),
          )
          .map((obligationId) => ({
            findingId: finding.id,
            obligationId,
            reason:
              "The semantic repair deliberately leaves the cited non-explicit obligation unmapped for independent adjudication.",
            evidenceIds: [...new Set(finding.evidenceIds)].sort(),
          })),
      ),
  );
  return validateCompilerInferenceChallenges([...carried, ...generated], input.inventory);
}
/** Only structured, cited dispositions enter the isolated judge; never compiler private reasoning. */
export function buildCompilerInferenceChallenges(
  inventory: ObligationInventory,
  prior: CompilerJudgeVerdict,
  dispositions: readonly {
    findingId: string;
    disposition: "addressed" | "challenged";
    reason: string;
    evidenceIds: string[];
  }[],
): CompilerInferenceChallenge[] {
  if (prior.inventoryDigest !== compilerEvalDigest(inventory))
    throw new Error("challenge inventory identity mismatch");
  unique(
    dispositions.map((entry) => entry.findingId),
    "finding disposition",
  );
  const challenges: CompilerInferenceChallenge[] = [];
  for (const disposition of dispositions.filter((entry) => entry.disposition === "challenged")) {
    const finding = prior.findings.find((entry) => entry.id === disposition.findingId);
    if (!finding) throw new Error("challenge refers to unknown prior finding");
    if (finding.obligationIds.length === 0)
      challenges.push({
        findingId: finding.id,
        originalFinding: {
          dimension: finding.dimension,
          rootCause: finding.rootCause,
          correction: finding.correction,
          itemIds: finding.itemIds,
        },
        reason: disposition.reason,
        evidenceIds: disposition.evidenceIds,
      });
    for (const obligationId of finding.obligationIds)
      challenges.push({
        findingId: finding.id,
        obligationId,
        reason: disposition.reason,
        evidenceIds: disposition.evidenceIds,
      });
  }
  return validateCompilerInferenceChallenges(canonicalInferenceChallenges(challenges), inventory);
}
