import { describe, expect, it } from "vitest";
import type { CompilerObjective } from "../src/compiler/index.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  validateCompilerCaseLabel,
  compilerEvalDigest,
  createCompilerEvalReport,
  measureCompilerCalibration,
  measureCompilerRepairComparison,
  parseObligationInventory,
  renderCompilerEvalMarkdown,
  validateCompilerJudgeVerdict,
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
  title: "API",
  workItems: [
    { id: "api", dependsOn: [], acceptance: ["Acceptance includes the requested outcome"] },
  ],
} as unknown as CompilerObjective;
const expected = { inventory, graph, draftDigest: "c".repeat(64) };
const verdict = (): CompilerJudgeVerdict => ({
  version: 1,
  rubricVersion: 1,
  draftDigest: expected.draftDigest,
  inventoryDigest: compilerEvalDigest(inventory),
  coverage: inventory.obligations.map((obligation) => ({
    obligationId: obligation.id,
    acceptanceBindings: [{ itemId: "api", criterion: "Acceptance includes the requested outcome" }],
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
  dependencies: [],
  findings: [],
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
      title: "API",
      workItems: [
        { id: "api", dependsOn: [], acceptance: ["Acceptance includes the requested outcome"] },
        { id: "consumer", dependsOn: ["api"], acceptance: ["Consumes API"] },
      ],
    } as unknown as CompilerObjective;
    const reviewed = verdict();
    reviewed.items.push({ ...reviewed.items[0]!, itemId: "consumer" });
    expect(() => validateCompilerJudgeVerdict(reviewed, { ...expected, graph: serial })).toThrow(
      "dependency rationale",
    );
    reviewed.dependencies.push({
      itemId: "consumer",
      dependsOn: "api",
      reason: "Consumes API",
      evidenceIds: ["objective"],
    });
    expect(validateCompilerJudgeVerdict(reviewed, { ...expected, graph: serial }).decision).toBe(
      "accept",
    );
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
    expect(JSON.parse(JSON.stringify(report)).usage[0]!.observedMilliseconds).toBeNull();
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
