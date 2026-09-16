import { describe, expect, it } from "vitest";
import type { CompilerProposal } from "../src/compiler/contracts.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  CompilerInferenceChallengeLimitError,
  deriveCompilerInferenceChallenges,
  validateCompilerCaseLabel,
  compilerEvalDigest,
  createCompilerEvalReport,
  measureCompilerCalibration,
  measureCompilerRepairComparison,
  hydrateObligationInventory,
  parseObligationInventory,
  renderCompilerEvalMarkdown,
  validateCompilerJudgeVerdict,
  validateCompilerInferenceChallenges,
  type CompilerJudgeVerdict,
  type ObligationInventory,
  type CompilerCalibrationCase,
} from "../src/evaluation/compiler-eval.js";

const evidence = [
  {
    id: "objective",
    kind: "objective" as const,
    identity: "original",
    excerpt: "Deliver API and integration",
  },
];
const inventory: ObligationInventory = {
  version: 1,
  objectiveDigest: "a".repeat(64),
  baseSha: "b".repeat(40),
  evidence,
  obligations: ["api", "integration"].map((id) => ({
    id,
    text: `Deliver ${id}`,
    kind: "explicit",
    evidenceIds: ["objective"],
    acceptanceEvidence: `Verify ${id}`,
  })),
};
// These tests exercise evidence contracts only, not structural compilation or model quality.
const graph = {
  protocol: "clockgrove.factory/compiler-proposal",
  kind: "work-items",
  mediaIntents: [],
  workItems: [
    {
      id: "api",
      dependsOn: [],
      criteria: [{ id: "requested-outcome" }],
    },
  ],
} as unknown as CompilerProposal;
const expected = { inventory, graph, draftDigest: "c".repeat(64) };
const verdict = (): CompilerJudgeVerdict => ({
  version: 1,
  rubricVersion: 1,
  draftDigest: expected.draftDigest,
  inventoryDigest: compilerEvalDigest(inventory),
  coverage: inventory.obligations.map((obligation) => ({
    obligationId: obligation.id,
    acceptanceBindings: [{ itemId: "api", criterionId: "requested-outcome" }],
    status: "covered",
    itemIds: ["api"],
    evidenceIds: ["objective"],
    reason: "Acceptance includes the requested outcome",
  })),
  items: [
    {
      itemId: "api",
      granularity: "cohesive",
      reason: "Single coherent deliverable",
      evidenceIds: ["objective"],
    },
  ],
  dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
    dimension,
    status: "assessed",
    reason: "Grounded assessment",
    evidenceIds: ["objective"],
  })),
  dependencies: [
    {
      itemId: "api",
      dependsOn: [],
      reason: "No prerequisite items",
      evidenceIds: ["objective"],
    },
  ],
  findings: [],
  inferenceCorrections: [],
  uncertainty: [],
  decision: "accept",
});
describe("obligation-first compiler evidence", () => {
  it("grounds citation identity and exact excerpts before graph review", () => {
    expect(parseObligationInventory(inventory, { ...inventory, evidence })).toEqual(inventory);
    const changed = structuredClone(inventory);
    changed.evidence[0]!.excerpt = "Invented requirement";
    expect(() => parseObligationInventory(changed, inventory)).toThrow("ungrounded");
    changed.evidence[0]!.excerpt = evidence[0]!.excerpt;
    changed.baseSha = "d".repeat(40);
    expect(() => parseObligationInventory(changed, inventory)).toThrow("identity mismatch");
  });
  it("hydrates only model-owned claims with Factory's canonical evidence envelope", () => {
    const claims = { version: 1 as const, obligations: inventory.obligations };
    expect(hydrateObligationInventory(claims, inventory)).toEqual(inventory);

    const unknown = structuredClone(claims);
    unknown.obligations[0]!.evidenceIds = ["invented"];
    expect(() => hydrateObligationInventory(unknown, inventory)).toThrow(
      "unknown obligation citation",
    );
    expect(() => hydrateObligationInventory(inventory, inventory)).toThrow();

    const duplicated = structuredClone(claims);
    duplicated.obligations.push({ ...duplicated.obligations[0]! });
    expect(() => hydrateObligationInventory(duplicated, inventory)).toThrow(
      "duplicate obligation identity",
    );

    const missing = structuredClone(claims);
    missing.obligations[0]!.evidenceIds = [];
    expect(() => hydrateObligationInventory(missing, inventory)).toThrow();
    expect(() =>
      hydrateObligationInventory(claims, {
        ...inventory,
        evidence: [...evidence, { ...evidence[0]! }],
      }),
    ).toThrow("duplicate trusted evidence identity");
  });
  it("does not replace Objective coverage with individually successful packets", () => {
    const partial = verdict();
    partial.coverage[1]!.status = "missing";
    expect(() => validateCompilerJudgeVerdict(partial, expected)).toThrow("unresolved coverage");
    partial.decision = "repair";
    expect(validateCompilerJudgeVerdict(partial, expected).decision).toBe("repair");
    partial.coverage.pop();
    expect(() => validateCompilerJudgeVerdict(partial, expected)).toThrow("incomplete Objective");
  });
  it("refuses preference-only repair and requires a material finding or non-waived coverage gap", () => {
    const review = verdict();
    review.decision = "repair";
    expect(() => validateCompilerJudgeVerdict(review, expected)).toThrow(
      "no unresolved coverage or material finding",
    );
    review.findings = [
      {
        id: "style",
        severity: "advisory",
        dimension: "granularity",
        obligationIds: [],
        itemIds: ["api"],
        evidenceIds: ["objective"],
        rootCause: "Prefer shorter prose",
        correction: "Shorten prose",
        confidence: 0.8,
        uncertainty: "Style only",
      },
    ];
    expect(() => validateCompilerJudgeVerdict(review, expected)).toThrow(
      "no unresolved coverage or material finding",
    );
    review.findings[0]!.severity = "material-efficiency";
    expect(validateCompilerJudgeVerdict(review, expected).decision).toBe("repair");
    review.findings = [];
    review.coverage[0]!.status = "partial";
    expect(validateCompilerJudgeVerdict(review, expected).decision).toBe("repair");
  });
  it("requires every item, dimension and dependency and binds the exact draft", () => {
    expect(validateCompilerJudgeVerdict(verdict(), expected).decision).toBe("accept");
    const changed = verdict();
    changed.items = [];
    expect(() => validateCompilerJudgeVerdict(changed, expected)).toThrow("granularity");
    expect(() =>
      validateCompilerJudgeVerdict(verdict(), { ...expected, draftDigest: "d".repeat(64) }),
    ).toThrow("identity");
    const serial = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "work-items",
      mediaIntents: [],
      workItems: [
        { id: "api", dependsOn: [], criteria: [{ id: "requested-outcome" }] },
        { id: "consumer", dependsOn: ["api"], criteria: [{ id: "consumes-api" }] },
      ],
    } as unknown as CompilerProposal;
    const reviewed = verdict();
    reviewed.items.push({ ...reviewed.items[0]!, itemId: "consumer" });
    expect(() => validateCompilerJudgeVerdict(reviewed, { ...expected, graph: serial })).toThrow(
      "dependency rationale",
    );
    reviewed.dependencies.push({
      itemId: "consumer",
      dependsOn: ["api"],
      reason: "Consumes API",
      evidenceIds: ["objective"],
    });
    expect(validateCompilerJudgeVerdict(reviewed, { ...expected, graph: serial }).decision).toBe(
      "accept",
    );
  });
  it("validates grouped rationale for a 1,050-edge fixed graph", () => {
    const workItems = Array.from({ length: 100 }, (_, index) => ({
      id: index === 0 ? "api" : `item-${index}`,
      dependsOn:
        index < 50
          ? []
          : Array.from({ length: 21 }, (_, dependency) =>
              dependency === 0 ? "api" : `item-${dependency}`,
            ),
      criteria: [{ id: "requested-outcome" }],
    }));
    const groupedGraph = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "work-items",
      workItems,
    } as unknown as CompilerProposal;
    expect(workItems.reduce((total, item) => total + item.dependsOn.length, 0)).toBe(1_050);
    const reviewed = verdict();
    reviewed.items = workItems.map((item) => ({
      itemId: item.id,
      granularity: "cohesive",
      reason: "Bounded fixed-graph item",
      evidenceIds: ["objective"],
    }));
    reviewed.dependencies = workItems.map((item) => ({
      itemId: item.id,
      dependsOn: item.dependsOn,
      reason: "Complete dependency set",
      evidenceIds: ["objective"],
    }));
    expect(
      validateCompilerJudgeVerdict(reviewed, { ...expected, graph: groupedGraph }).decision,
    ).toBe("accept");
    reviewed.dependencies[99]!.dependsOn = reviewed.dependencies[99]!.dependsOn.slice(1);
    expect(() =>
      validateCompilerJudgeVerdict(reviewed, { ...expected, graph: groupedGraph }),
    ).toThrow("exact dependency set");
  });
  it("rejects hallucinated identities, duplicated causes and hidden blockers", () => {
    const reviewed = verdict();
    reviewed.findings.push({
      id: "f1",
      dimension: "coverage",
      severity: "advisory",
      confidence: 0.8,
      obligationIds: ["api"],
      itemIds: ["api"],
      evidenceIds: ["objective"],
      rootCause: "Potential improvement",
      correction: "Keep advisory",
      uncertainty: "Preference",
    });
    expect(validateCompilerJudgeVerdict(reviewed, expected).decision).toBe("accept");
    reviewed.findings.push({ ...reviewed.findings[0]!, id: "f2" });
    expect(() => validateCompilerJudgeVerdict(reviewed, expected)).toThrow("root cause");
    reviewed.findings.pop();
    reviewed.findings[0]!.severity = "blocking";
    expect(() => validateCompilerJudgeVerdict(reviewed, expected)).toThrow("blockers");
    reviewed.findings[0]!.evidenceIds = ["invented"];
    expect(() => validateCompilerJudgeVerdict(reviewed, expected)).toThrow("citation");
  });
  it("retains unavailable usage and separates estimated waste from observed cost", () => {
    const reviewed = verdict();
    reviewed.findings.push({
      id: "f1",
      dimension: "coverage",
      severity: "advisory",
      confidence: 0.5,
      obligationIds: ["api"],
      itemIds: [],
      evidenceIds: ["objective"],
      rootCause: "Earlier omission",
      correction: "Already corrected",
      uncertainty: "Mixed causes",
    });
    const report = createCompilerEvalReport({
      ...expected,
      verdict: reviewed,
      mode: "post-mortem",
      historicalEvidence: [
        { id: "attempt", kind: "receipt", identity: "receipt-sha", excerpt: "Failed integration" },
      ],
      usage: [
        {
          invocationId: "call",
          phase: "worker",
          evidenceId: "attempt",
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          observedTokens: 123,
          observedMilliseconds: null,
        },
      ],
      causes: [
        {
          findingId: "f1",
          cause: "mixed",
          evidenceIds: ["attempt"],
          explanation: "Planning and execution contributed",
          estimatedAvoidableTokens: 40,
          uncertainty: "No counterfactual run",
        },
      ],
    });
    expect(report.observedTokenSubtotal).toBe(123);
    expect(report.observedTotalTokens).toBeNull();
    expect(report.economicBenefitMeasured).toBe(false);
    expect(renderCompilerEvalMarkdown(report)).toContain("estimated avoidable tokens: 40");
    expect(renderCompilerEvalMarkdown(report)).toContain(
      "total tokens 123; input unavailable; output unavailable; cached input unavailable (cached input is included in input)",
    );
    expect(JSON.parse(JSON.stringify(report)).usage[0]!.observedMilliseconds).toBeNull();
    expect(() =>
      createCompilerEvalReport({
        ...expected,
        verdict: reviewed,
        historicalEvidence: report.evidence.filter((entry) => entry.id === "attempt"),
        usage: [
          {
            ...report.usage[0]!,
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 80,
          },
        ],
      }),
    ).toThrow("disagrees with input and output");
    expect(() =>
      createCompilerEvalReport({
        ...expected,
        verdict: reviewed,
        usage: [report.usage[0]!, report.usage[0]!],
      }),
    ).toThrow();
  });
});
const calibrationCase = (id: string): CompilerCalibrationCase => ({
  id,
  split: "held-out",
  labelProvenance: "synthetic",
  labelEvidence: "fixture",
  expectedOmissions: [],
  expectedRepair: false,
  validPlan: true,
  reportedOmissions: [],
  findingCount: 0,
  unsupportedFindingCount: 0,
  repaired: false,
  accepted: true,
  validAlternative: true,
  cosmeticGroup: "group",
  outcome: "completed",
});
describe("calibration measurement boundaries", () => {
  it("measures alternatives and cosmetic stability without claiming synthetic calibration", () => {
    const result = measureCompilerCalibration([
      calibrationCase("one"),
      calibrationCase("combined"),
      { ...calibrationCase("failed"), outcome: "failed" },
    ]);
    expect(result.heldOut.validAlternativeAcceptanceRate).toBe(1);
    expect(result.heldOut.cosmeticStability).toBe(1);
    expect(result.heldOut.omissionRecall).toBeNull();
    expect(result.heldOut.failed).toBe(1);
    expect(result.humanCalibrationProven).toBe(false);
    expect(result.cases).toHaveLength(3);
  });
  it("exposes omissions, unsupported findings, unnecessary repairs and held-out leakage", () => {
    const result = measureCompilerCalibration([
      {
        ...calibrationCase("missing"),
        expectedOmissions: ["a", "b"],
        expectedRepair: true,
        validPlan: false,
        reportedOmissions: ["a"],
        findingCount: 2,
        unsupportedFindingCount: 1,
      },
      { ...calibrationCase("valid"), repaired: true },
    ]);
    expect(result.heldOut.omissionRecall).toBe(0.5);
    expect(result.heldOut.unsupportedFindingRate).toBe(0.5);
    expect(result.heldOut.unnecessaryRepairRate).toBe(1);
    expect(() =>
      measureCompilerCalibration([
        calibrationCase("one"),
        { ...calibrationCase("train"), split: "calibration" },
      ]),
    ).toThrow("held-out");
  });
});

describe("assisted label provenance", () => {
  it("preserves independent adjudication disagreements without claiming human labels", () => {
    const first = {
      version: 1,
      caseDigest: "a".repeat(64),
      provenance: "llm-assisted",
      pass: "blinded",
      obligations: [
        {
          id: "api",
          text: "API requirement",
          evidenceIds: ["objective"],
          status: "required",
          reason: "Original request",
        },
      ],
      disagreements: [],
      uncertainty: [],
    };
    const blind = validateCompilerCaseLabel(first, {
      caseDigest: first.caseDigest,
      evidence,
      pass: "blinded",
    });
    const second = {
      ...blind,
      pass: "adjudication",
      obligations: [{ ...blind.obligations[0]!, status: "unsupported" }],
    };
    expect(() =>
      validateCompilerCaseLabel(second, {
        caseDigest: first.caseDigest,
        evidence,
        pass: "adjudication",
        priorLabel: blind,
      }),
    ).toThrow("disagreement must");
    const adjudicated = validateCompilerCaseLabel(
      {
        ...second,
        disagreements: [
          {
            obligationId: "api",
            priorStatus: "required",
            evidenceIds: ["objective"],
            reason: "Pinned implementation already satisfies it",
          },
        ],
      },
      { caseDigest: first.caseDigest, evidence, pass: "adjudication", priorLabel: blind },
    );
    expect(adjudicated.provenance).toBe("llm-assisted");
    expect(() =>
      validateCompilerCaseLabel(first, {
        caseDigest: first.caseDigest,
        evidence,
        pass: "blinded",
        priorLabel: blind,
      }),
    ).toThrow("cannot consume");
    expect(
      measureCompilerCalibration([
        { ...calibrationCase("assisted"), labelProvenance: "llm-assisted" },
      ]).humanCalibrationProven,
    ).toBe(false);
  });
});

it("retains failed and synthetic comparative arms without claiming observed savings", () => {
  const arm = {
    outcome: "accepted" as const,
    evidenceIds: ["result"],
    remainingObligations: [],
    regressions: [],
    observedTotalTokens: 100,
    observedElapsedMilliseconds: 10,
  };
  const pair = {
    caseDigest: "a".repeat(64),
    conditionsDigest: "b".repeat(64),
    provenance: "synthetic" as const,
    unrepaired: arm,
    repaired: { ...arm, observedTotalTokens: 50 },
  };
  expect(measureCompilerRepairComparison([pair]).observedTokenDifference).toBeNull();
  const measured = measureCompilerRepairComparison([{ ...pair, provenance: "observed" }]);
  expect(measured.observedTokenDifference).toBe(50);
  expect(
    measureCompilerRepairComparison([{ ...pair, repaired: { ...arm, outcome: "failed" } }])
      .failedOrInconclusivePairs,
  ).toBe(1);
  expect(() => measureCompilerRepairComparison([pair, pair])).toThrow("duplicate");
});

it("does not classify justified non-coverage repairs as unnecessary", () => {
  const result = measureCompilerCalibration([
    { ...calibrationCase("oversized"), expectedRepair: true, validPlan: false, repaired: true },
    calibrationCase("valid"),
  ]);
  expect(result.heldOut.unnecessaryRepairRate).toBe(0);
});
it("adjudication cannot retain an identity while reversing obligation text", () => {
  const prior = {
    version: 1 as const,
    caseDigest: "a".repeat(64),
    provenance: "llm-assisted" as const,
    pass: "blinded" as const,
    obligations: [
      {
        id: "guard",
        text: "Reject negatives",
        evidenceIds: ["objective"],
        status: "required" as const,
        reason: "Guard",
      },
    ],
    disagreements: [],
    uncertainty: [],
  };
  expect(() =>
    validateCompilerCaseLabel(
      {
        ...prior,
        pass: "adjudication",
        obligations: [{ ...prior.obligations[0]!, text: "Accept negatives" }],
      },
      { caseDigest: prior.caseDigest, evidence, pass: "adjudication", priorLabel: prior },
    ),
  ).toThrow("rewrite obligation text");
});

it("independently corrects cited hallucinated prerequisites without waiving explicit obligations", () => {
  const inferred = structuredClone(inventory);
  inferred.obligations[1]!.kind = "prerequisite";
  const review = verdict();
  review.inventoryDigest = compilerEvalDigest(inferred);
  review.coverage[1]!.status = "missing";
  review.coverage[1]!.itemIds = [];
  review.coverage[1]!.acceptanceBindings = [];
  const challenge = {
    findingId: "invented-integration",
    obligationId: "integration",
    reason: "Original Objective never requires this inferred integration",
    evidenceIds: ["objective"],
  };
  review.inferenceCorrections = [{ ...challenge, disposition: "unsupported-inference" }];
  const context = { ...expected, inventory: inferred, challenges: [challenge] };
  expect(validateCompilerJudgeVerdict(review, context).decision).toBe("accept");
  review.decision = "repair";
  expect(() => validateCompilerJudgeVerdict(review, context)).toThrow(
    "no unresolved coverage or material finding",
  );
  review.decision = "accept";
  expect(inferred.obligations).toHaveLength(2);
  expect(review.coverage[1]!.status).toBe("missing");
  expect(() => validateCompilerJudgeVerdict(review, { ...context, challenges: [] })).toThrow(
    "matching compiler challenge",
  );
  const explicit = structuredClone(inferred);
  explicit.obligations[1]!.kind = "explicit";
  review.inventoryDigest = compilerEvalDigest(explicit);
  expect(() => validateCompilerJudgeVerdict(review, { ...context, inventory: explicit })).toThrow(
    "cannot be waived",
  );
});

describe("bounded inference challenge derivation", () => {
  const inferredInventory = (count: number): ObligationInventory => ({
    version: 1,
    objectiveDigest: "d".repeat(64),
    baseSha: "e".repeat(40),
    evidence,
    obligations: Array.from({ length: count }, (_, index) => ({
      id: `inferred-${index}`,
      text: `Inferred obligation ${index}`,
      kind: "prerequisite" as const,
      evidenceIds: ["objective"],
      acceptanceEvidence: `Independently assess ${index}`,
    })),
  });
  const finding = (ids: string[], id = "missing-inferences") => ({
    id,
    dimension: "coverage" as const,
    severity: "blocking" as const,
    confidence: 1,
    obligationIds: ids,
    itemIds: [],
    evidenceIds: ["objective"],
    rootCause: "Inferred prerequisites are unmapped",
    correction: "Resolve only supported prerequisites",
    uncertainty: "",
  });

  it.each([65, 128])("derives one deterministic challenge for each of %i obligations", (count) => {
    const bounded = inferredInventory(count);
    const ids = bounded.obligations.map((entry) => entry.id);
    const challenges = deriveCompilerInferenceChallenges({
      inventory: bounded,
      findings: [finding(ids)],
      proposal: { workItems: [{ obligationIds: [] }] },
    });
    expect(challenges).toHaveLength(count);
    expect(challenges.map((entry) => entry.obligationId)).toEqual([...ids].sort());
  });

  it("chooses the stable finding identity for overlaps and never challenges explicit or mapped work", () => {
    const bounded = inferredInventory(3);
    bounded.obligations[2]!.kind = "explicit";
    const ids = bounded.obligations.map((entry) => entry.id);
    const forward = deriveCompilerInferenceChallenges({
      inventory: bounded,
      findings: [finding(ids, "z-finding"), finding(ids, "a-finding")],
      proposal: { workItems: [{ obligationIds: [ids[1]!] }] },
    });
    const reverse = deriveCompilerInferenceChallenges({
      inventory: bounded,
      findings: [finding(ids, "a-finding"), finding(ids, "z-finding")],
      proposal: { workItems: [{ obligationIds: [ids[1]!] }] },
    });
    expect(forward).toEqual(reverse);
    expect(forward).toEqual([
      expect.objectContaining({ findingId: "a-finding", obligationId: ids[0] }),
    ]);
  });

  it("turns item-only overflow into a typed terminal error", () => {
    const bounded = inferredInventory(1);
    const itemOnly = Array.from({ length: 65 }, (_, index) => ({
      findingId: `finding-${index}`,
      originalFinding: {
        dimension: "granularity" as const,
        rootCause: "Item appears broad",
        correction: "Reassess cohesion",
        itemIds: ["item-1"],
      },
      reason: "Independent review required",
      evidenceIds: ["objective"],
    }));
    expect(() => validateCompilerInferenceChallenges(itemOnly, bounded)).toThrow(
      CompilerInferenceChallengeLimitError,
    );
  });
});

it("separates human, assisted and synthetic calibration outcomes including failures", () => {
  const result = measureCompilerCalibration([
    { ...calibrationCase("human"), labelProvenance: "human" },
    { ...calibrationCase("assisted"), labelProvenance: "llm-assisted", repaired: true },
    { ...calibrationCase("synthetic-failure"), outcome: "failed" },
  ]);
  expect(result.aggregateProvenance).toBe("mixed");
  expect(result.byProvenance.human.heldOut.unnecessaryRepairRate).toBe(0);
  expect(result.byProvenance["llm-assisted"].heldOut.unnecessaryRepairRate).toBe(1);
  expect(result.byProvenance.synthetic.heldOut.failed).toBe(1);
  expect(result.humanCalibrationProven).toBe(false);
});
