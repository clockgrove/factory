import { createHash } from "node:crypto";
import { z } from "zod";
import type { CompilerObjective } from "../compiler/index.js";
import { assessDecomposition, type DecompositionEvidence } from "../compiler/economics.js";

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
export const ObligationInventorySchema = z
  .object({
    version: z.literal(1),
    objectiveDigest: Digest,
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    evidence: z.array(CompilerEvidenceSchema).min(1).max(128),
    obligations: z
      .array(
        z
          .object({
            id: Id,
            text: Text,
            kind: z.enum(["explicit", "prerequisite", "ambiguity"]),
            evidenceIds: Refs.min(1),
            acceptanceEvidence: Text,
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();
export type ObligationInventory = z.infer<typeof ObligationInventorySchema>;
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
            acceptanceBindings: z
              .array(z.object({ itemId: Id, criterion: Text }).strict())
              .max(128),
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
      .max(128),
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
            dependsOn: Id,
            reason: Text,
            evidenceIds: Refs.min(1),
          })
          .strict(),
      )
      .max(1024),
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
    uncertainty: z.array(Text).max(64),
    decision: z.enum(["accept", "repair", "abstain"]),
  })
  .strict();
export type CompilerJudgeVerdict = z.infer<typeof CompilerJudgeVerdictSchema>;

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

export function validateCompilerJudgeVerdict(
  value: unknown,
  expected: {
    draftDigest: string;
    inventory: ObligationInventory;
    graph: { workItems: Array<{ id: string; dependsOn: string[]; acceptance: string[] }> };
  },
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
    unique(
      entry.acceptanceBindings.map((binding) => `${binding.itemId}\0${binding.criterion}`),
      "acceptance binding",
    );
    for (const binding of entry.acceptanceBindings) {
      const item = expected.graph.workItems.find((candidate) => candidate.id === binding.itemId);
      if (!entry.itemIds.includes(binding.itemId) || !item?.acceptance.includes(binding.criterion))
        throw new Error("ungrounded acceptance binding");
    }
    if (entry.status === "covered" && entry.acceptanceBindings.length === 0)
      throw new Error("covered obligation requires acceptance binding");
    if (entry.status === "covered" && entry.itemIds.length === 0)
      throw new Error("covered obligation requires item mapping");
  }
  const edges = new Set(
    expected.graph.workItems.flatMap((entry) =>
      entry.dependsOn.map((dependency) => `${entry.id}\0${dependency}`),
    ),
  );
  const reviewedEdges = verdict.dependencies.map((entry) => `${entry.itemId}\0${entry.dependsOn}`);
  references(reviewedEdges, edges, "dependency edge");
  if (reviewedEdges.length !== edges.size) throw new Error("incomplete dependency rationale");
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
  if (
    verdict.decision === "accept" &&
    (verdict.coverage.some((entry) => entry.status !== "covered") ||
      verdict.findings.some((entry) => entry.severity !== "advisory") ||
      verdict.items.some((entry) => entry.granularity === "unknown") ||
      verdict.dimensions.some((entry) => entry.status === "unknown"))
  )
    throw new Error("acceptance has unresolved coverage or blockers");
  return verdict;
}

export interface CompilerEvalUsage {
  invocationId: string;
  phase: "obligations" | "compile" | "judge" | "repair" | "worker" | "validation";
  evidenceId: string;
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
  graph: { workItems: Array<{ id: string; dependsOn: string[]; acceptance: string[] }> };
  verdict: CompilerJudgeVerdict;
  draftDigest: string;
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
    for (const value of [entry.observedTokens, entry.observedMilliseconds])
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new Error("invalid observed usage");
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
    draftDigest: input.draftDigest,
    verdict,
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
    "## Granularity and dependencies",
    "",
    ...report.verdict.items.map(
      (entry) =>
        `- ${clean(entry.itemId)}: ${entry.granularity}; ${clean(entry.reason)}; evidence: ${entry.evidenceIds.map(clean).join(", ")}`,
    ),
    ...report.verdict.dependencies.map(
      (entry) =>
        `- ${clean(entry.itemId)} depends on ${clean(entry.dependsOn)}: ${clean(entry.reason)}; evidence: ${entry.evidenceIds.map(clean).join(", ")}`,
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
        `- ${clean(entry.invocationId)} (${entry.phase}): observed tokens ${entry.observedTokens ?? "unknown"}, milliseconds ${entry.observedMilliseconds ?? "unknown"}; evidence: ${clean(entry.evidenceId)}`,
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
  const measure = (split: CompilerCalibrationCase["split"]) => {
    const all = cases.filter((entry) => entry.split === split);
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
