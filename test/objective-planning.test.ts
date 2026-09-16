import { describe, expect, it } from "vitest";

import type { CompilerObjectivesProposal } from "../src/compiler/contracts.js";
import {
  type ObjectivePlanningViolationCode,
  validateObjectivePlan,
} from "../src/compiler/objective-planning.js";

const obligations = ["core-behavior", "consumer-behavior", "integrated-result"];

function validPlan(): CompilerObjectivesProposal {
  return {
    protocol: "clockgrove.factory/compiler-proposal",
    kind: "objectives",
    objectives: [
      {
        id: "core",
        title: "Produce the core artifact",
        outcome: "A reusable core artifact implements the requested behavior.",
        acceptance: [{ id: "core-works", kind: "owned", text: "The core behavior is observable." }],
        ownedScope: ["src/core/"],
        obligationIds: ["core-behavior"],
        planningEstimate: {
          workItems: 8,
          criticalPathMinutes: 240,
          aggregateWorkMinutes: 360,
          basis: "The foundation is bounded to one accepted core artifact and its direct tests.",
        },
        outputs: [
          {
            id: "core-artifact",
            description: "The accepted reusable core artifact.",
            completionAcceptanceIds: ["core-works"],
          },
        ],
        prerequisiteOutputs: [],
      },
      {
        id: "consumer",
        title: "Integrate the core artifact",
        outcome: "The consumer uses the accepted core artifact end to end.",
        acceptance: [
          {
            id: "consumer-works",
            kind: "owned",
            text: "The consumer behavior is observable.",
          },
          {
            id: "integrates-core",
            kind: "aggregate-integration",
            text: "The accepted core artifact and consumer operate together.",
          },
        ],
        ownedScope: ["src/consumer/"],
        obligationIds: ["consumer-behavior"],
        planningEstimate: {
          workItems: 6,
          criticalPathMinutes: null,
          aggregateWorkMinutes: null,
          basis:
            "The integration milestone is bounded to the consumer and the accepted core handoff; duration is not yet available.",
        },
        outputs: [
          {
            id: "integrated-artifact",
            description: "The accepted integrated result.",
            completionAcceptanceIds: ["consumer-works", "integrates-core"],
          },
        ],
        prerequisiteOutputs: [{ objectiveId: "core", outputId: "core-artifact" }],
      },
    ],
    coverage: [
      {
        obligationId: "core-behavior",
        disposition: "owned",
        objectiveId: "core",
        acceptanceId: "core-works",
      },
      {
        obligationId: "consumer-behavior",
        disposition: "owned",
        objectiveId: "consumer",
        acceptanceId: "consumer-works",
      },
      {
        obligationId: "integrated-result",
        disposition: "aggregate-integration",
        objectiveId: "consumer",
        acceptanceId: "integrates-core",
      },
    ],
    triggers: [
      {
        code: "independent-milestones",
        source: "obligation-inventory",
        availability: "observed",
        observed: "core output is required by a separately accepted consumer",
        threshold: null,
        obligationIds: [...obligations],
        explanation: "The dependency has an independently useful accepted output.",
      },
    ],
  };
}

function codes(
  plan: CompilerObjectivesProposal,
  inventory = obligations,
): ObjectivePlanningViolationCode[] {
  return validateObjectivePlan(plan, inventory).map((entry) => entry.code);
}

describe("Objective plan semantic validation", () => {
  it("accepts a completely covered project-scale split without pretending to execute it", () => {
    const projectObligations = Array.from(
      { length: 101 },
      (_, index) => `requirement-${index + 1}`,
    );
    const objectives = Array.from({ length: 5 }, (_, index) => {
      const id = `milestone-${index + 1}`;
      const owned = projectObligations.filter(
        (_, obligationIndex) => obligationIndex % 5 === index,
      );
      return {
        id,
        title: `Deliver milestone ${index + 1}`,
        outcome: `Milestone ${index + 1} is independently reviewable and complete.`,
        acceptance: [
          {
            id: `${id}-accepted`,
            kind: "owned" as const,
            text: `Every requirement owned by milestone ${index + 1} is demonstrably satisfied.`,
          },
        ],
        ownedScope: [`src/${id}/`],
        obligationIds: owned,
        planningEstimate: {
          workItems: owned.length,
          criticalPathMinutes: null,
          aggregateWorkMinutes: null,
          basis: `Milestone ${index + 1} is bounded to ${owned.length} inventoried obligations and one independently accepted output.`,
        },
        outputs: [
          {
            id: `${id}-output`,
            description: `The accepted output of milestone ${index + 1}.`,
            completionAcceptanceIds: [`${id}-accepted`],
          },
        ],
        prerequisiteOutputs: [],
      };
    });
    const proposal: CompilerObjectivesProposal = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "objectives",
      objectives,
      coverage: objectives.flatMap((objective) =>
        objective.obligationIds.map((obligationId) => ({
          obligationId,
          disposition: "owned" as const,
          objectiveId: objective.id,
          acceptanceId: objective.acceptance[0]!.id,
        })),
      ),
      triggers: [
        {
          code: "work-item-threshold",
          source: "obligation-inventory",
          availability: "estimated",
          observed: 101,
          threshold: 24,
          obligationIds: projectObligations,
          explanation:
            "The complete inventory is expected to exceed one Objective's provisional Work Item threshold.",
        },
      ],
    };
    expect(validateObjectivePlan(proposal, projectObligations)).toEqual([]);
  });

  it("accepts a complete dependency-ordered plan", () => {
    expect(validateObjectivePlan(validPlan(), obligations)).toEqual([]);
  });

  it("allows one broad parent obligation to decompose through a prerequisite support Objective", () => {
    const plan = validPlan();
    plan.objectives[0]!.obligationIds = ["broad-outcome"];
    plan.objectives[1]!.obligationIds = [];
    plan.coverage = [
      {
        obligationId: "broad-outcome",
        disposition: "aggregate-integration",
        objectiveId: "consumer",
        acceptanceId: "integrates-core",
      },
    ];
    plan.triggers[0]!.obligationIds = ["broad-outcome"];

    expect(validateObjectivePlan(plan, ["broad-outcome"])).toEqual([]);
  });

  it("reports globally duplicated Objective, acceptance, and output IDs", () => {
    const plan = validPlan();
    plan.objectives[1]!.id = "core";
    plan.objectives[1]!.acceptance[0]!.id = "core-works";
    plan.objectives[1]!.outputs[0]!.id = "core-artifact";

    expect(codes(plan)).toEqual(
      expect.arrayContaining([
        "duplicate-objective-id",
        "duplicate-acceptance-id",
        "duplicate-output-id",
      ]),
    );
  });

  it("requires exactly one disposition for every known obligation", () => {
    const plan = validPlan();
    plan.coverage.pop();
    plan.coverage.push({
      obligationId: "core-behavior",
      disposition: "deferred",
      reason: "A separate authorized effort owns this behavior.",
    });
    plan.coverage.push({
      obligationId: "invented",
      disposition: "deferred",
      reason: "This entry is not part of the authoritative inventory.",
    });

    expect(codes(plan)).toEqual(
      expect.arrayContaining([
        "duplicate-obligation-disposition",
        "unmapped-obligation",
        "unknown-obligation",
      ]),
    );
  });

  it("rejects unknown obligations cited by planning triggers", () => {
    const plan = validPlan();
    plan.triggers[0]!.obligationIds.push("invented");

    expect(validateObjectivePlan(plan, obligations)).toContainEqual(
      expect.objectContaining({
        code: "unknown-obligation",
        field: "/triggers/0/obligationIds",
        observed: "invented",
      }),
    );
  });

  it("rejects placeholder content and fake empty milestones", () => {
    const plan = validPlan();
    const objective = plan.objectives[0]!;
    objective.outcome = "TBD";
    objective.acceptance[0]!.text = "placeholder";
    objective.ownedScope = [];
    objective.outputs[0]!.description = "later";
    objective.obligationIds = [];

    expect(codes(plan)).toEqual(
      expect.arrayContaining(["invalid-objective-content", "empty-objective-milestone"]),
    );
  });

  it("resolves prerequisite Objectives and their exact outputs", () => {
    const unknownObjective = validPlan();
    unknownObjective.objectives[1]!.prerequisiteOutputs = [
      { objectiveId: "missing", outputId: "core-artifact" },
    ];
    expect(codes(unknownObjective)).toContain("unknown-prerequisite-objective");

    const unknownOutput = validPlan();
    unknownOutput.objectives[1]!.prerequisiteOutputs[0]!.outputId = "missing";
    expect(codes(unknownOutput)).toContain("unknown-prerequisite-output");
  });

  it("rejects self references, cycles, and dependency-after-dependent ordering", () => {
    const self = validPlan();
    self.objectives[0]!.prerequisiteOutputs = [{ objectiveId: "core", outputId: "core-artifact" }];
    expect(codes(self)).toEqual(
      expect.arrayContaining(["self-prerequisite", "objective-cycle", "objective-order"]),
    );

    const reversed = validPlan();
    reversed.objectives.reverse();
    expect(codes(reversed)).toContain("objective-order");

    const cycle = validPlan();
    cycle.objectives[0]!.prerequisiteOutputs = [
      { objectiveId: "consumer", outputId: "integrated-artifact" },
    ];
    expect(codes(cycle)).toContain("objective-cycle");
  });

  it("requires outputs to resolve completion acceptance on their own Objective", () => {
    const plan = validPlan();
    plan.objectives[1]!.outputs[0]!.completionAcceptanceIds = ["core-works", "core-works"];

    expect(codes(plan)).toEqual(
      expect.arrayContaining(["duplicate-completion-acceptance", "unknown-completion-acceptance"]),
    );
  });

  it("requires aggregate dispositions to resolve prerequisite-backed integration acceptance", () => {
    const wrongKind = validPlan();
    const disposition = wrongKind.coverage[2]!;
    if (disposition.disposition === "deferred") throw new Error("fixture disposition changed");
    disposition.acceptanceId = "consumer-works";
    expect(codes(wrongKind)).toContain("invalid-integration-acceptance");

    const root = validPlan();
    root.objectives[1]!.prerequisiteOutputs = [];
    expect(codes(root)).toEqual(
      expect.arrayContaining(["root-integration-acceptance", "invalid-integration-acceptance"]),
    );

    const omittedFromOutput = validPlan();
    omittedFromOutput.objectives[1]!.outputs[0]!.completionAcceptanceIds = ["consumer-works"];
    expect(codes(omittedFromOutput)).toContain("invalid-integration-acceptance");

    const ownedOmittedFromOutput = validPlan();
    ownedOmittedFromOutput.objectives[0]!.outputs[0]!.completionAcceptanceIds = [];
    expect(codes(ownedOmittedFromOutput)).toContain("invalid-obligation-disposition");
  });

  it("requires overlapping owned scopes to be prerequisite ordered", () => {
    const unordered = validPlan();
    unordered.objectives[1]!.ownedScope = ["src/core/generated.ts"];
    unordered.objectives[1]!.prerequisiteOutputs = [];
    unordered.objectives[1]!.acceptance = unordered.objectives[1]!.acceptance.filter(
      (entry) => entry.kind === "owned",
    );
    unordered.coverage[2] = {
      obligationId: "integrated-result",
      disposition: "deferred",
      reason: "Integration is explicitly assigned to a later authorized effort.",
    };
    expect(codes(unordered)).toContain("overlapping-objective-scope");

    const ordered = validPlan();
    ordered.objectives[1]!.ownedScope = ["src/core/generated.ts"];
    expect(codes(ordered)).not.toContain("overlapping-objective-scope");
  });

  it("sorts and de-duplicates violations deterministically", () => {
    const plan = validPlan();
    plan.coverage.push(structuredClone(plan.coverage[0]!));
    const first = validateObjectivePlan(plan, obligations);
    const second = validateObjectivePlan(structuredClone(plan), [...obligations].reverse());

    expect(first).toEqual(second);
    expect(new Set(first.map((entry) => JSON.stringify(entry))).size).toBe(first.length);
  });
});
