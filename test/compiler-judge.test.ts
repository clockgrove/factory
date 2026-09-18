import { describe, expect, it } from "vitest";

import { compiledGraphDigest } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  repairableCompilerJudgeVerdict,
  validateCompilerJudgeVerdict,
  type CompilerJudgeVerdict,
} from "../src/evaluation/compiler-eval.js";
import { projectCompilerProposal } from "../src/compiler/proposal.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import {
  semanticPinnedFacts,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";

function acceptedVerdict(
  request: ReturnType<typeof semanticRequest>,
  proposal: ReturnType<typeof semanticProposal>,
  graphDigest: string,
  edges: Array<{ itemId: string; dependsOn: string }> = [],
): CompilerJudgeVerdict {
  return {
    version: 1,
    rubricVersion: 1,
    draftDigest: graphDigest,
    inventoryDigest: compilerEvalDigest(request.inventory),
    coverage: request.inventory.obligations.map((obligation) => ({
      obligationId: obligation.id,
      acceptanceBindings: [{ itemId: proposal.workItems[0]!.id, criterionId: "implemented" }],
      status: "covered",
      itemIds: [proposal.workItems[0]!.id],
      evidenceIds: ["objective"],
      reason: "The criterion directly covers the cited obligation.",
    })),
    items: proposal.workItems.map((item) => ({
      itemId: item.id,
      granularity: "cohesive",
      reason: "The item owns one independently reviewable behavior.",
      evidenceIds: ["objective"],
    })),
    dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "assessed",
      reason: "Assessed against the Objective and semantic proposal.",
      evidenceIds: ["objective"],
    })),
    dependencies: proposal.workItems.map((item) => ({
      itemId: item.id,
      dependsOn: [
        ...new Set([
          ...item.dependsOn,
          ...edges.filter((edge) => edge.itemId === item.id).map((edge) => edge.dependsOn),
        ]),
      ],
      reason: "The dependency set preserves authored and deterministic serialization intent.",
      evidenceIds: ["objective"],
    })),
    findings: [],
    inferenceCorrections: [],
    uncertainty: [],
    decision: "accept",
  };
}

describe("independent semantic compiler judgment", () => {
  it("binds coverage to item and criterion IDs and reviews Factory-added edges", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 2);
    proposal.workItems[1]!.dependsOn = [];
    proposal.workItems[0]!.exclusiveResources = ["gpu:0"];
    proposal.workItems[1]!.exclusiveResources = ["gpu:0"];
    const projection = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
    });
    const verdict = acceptedVerdict(
      request,
      proposal,
      compiledGraphDigest(projection.objective),
      projection.trace.addedEdges,
    );
    expect(
      validateCompilerJudgeVerdict(verdict, {
        draftDigest: compiledGraphDigest(projection.objective),
        inventory: request.inventory,
        graph: proposal,
        addedEdges: projection.trace.addedEdges,
      }),
    ).toEqual(verdict);
    const invalid = structuredClone(verdict);
    invalid.coverage[0]!.acceptanceBindings[0]!.criterionId = "unknown-criterion";
    expect(() =>
      validateCompilerJudgeVerdict(invalid, {
        draftDigest: compiledGraphDigest(projection.objective),
        inventory: request.inventory,
        graph: proposal,
        addedEdges: projection.trace.addedEdges,
      }),
    ).toThrow(/acceptance binding/);
  });

  it("does not accept missing explicit coverage or a material finding", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const projection = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
    });
    const digest = compiledGraphDigest(projection.objective);
    const missing = acceptedVerdict(request, proposal, digest);
    missing.coverage[0]!.status = "missing";
    missing.coverage[0]!.acceptanceBindings = [];
    missing.coverage[0]!.itemIds = [];
    expect(() =>
      validateCompilerJudgeVerdict(missing, {
        draftDigest: digest,
        inventory: request.inventory,
        graph: proposal,
      }),
    ).toThrow(/unresolved coverage/);

    const blocked = acceptedVerdict(request, proposal, digest);
    blocked.findings = [
      {
        id: "omitted-obligation",
        dimension: "coverage",
        severity: "blocking",
        confidence: 1,
        obligationIds: ["explicit-contract"],
        itemIds: ["item-1"],
        evidenceIds: ["objective"],
        rootCause: "The proposal omits required behavior.",
        correction: "Add criterion coverage for the explicit obligation.",
        uncertainty: "",
      },
    ];
    expect(() =>
      validateCompilerJudgeVerdict(blocked, {
        draftDigest: digest,
        inventory: request.inventory,
        graph: proposal,
      }),
    ).toThrow(/unresolved coverage or blockers/);
  });

  it.each(["coverage", "item", "dimension", "finding"] as const)(
    "derives evidence-cited repair input from an invalid accept %s predicate",
    (predicate) => {
      const pinned = semanticPinnedFacts();
      const request = semanticRequest(pinned);
      const proposal = semanticProposal(request);
      const projection = projectCompilerProposal({
        request,
        proposal,
        pinnedFacts: pinned,
        runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
      });
      const raw = acceptedVerdict(request, proposal, compiledGraphDigest(projection.objective));
      if (predicate === "coverage") raw.coverage[0]!.status = "partial";
      if (predicate === "item") raw.items[0]!.granularity = "unknown";
      if (predicate === "dimension") {
        raw.dimensions.find((entry) => entry.dimension === "assumption-grounding")!.status =
          "unknown";
        raw.dimensions.find((entry) => entry.dimension === "assumption-grounding")!.reason =
          "The existing proposal does not expose enough grounding to assess assumptions.";
      }
      if (predicate === "finding")
        raw.findings.push({
          id: "existing-blocker",
          dimension: "coverage",
          severity: "blocking",
          confidence: 1,
          obligationIds: [request.inventory.obligations[0]!.id],
          itemIds: [proposal.workItems[0]!.id],
          evidenceIds: ["objective"],
          rootCause: "The accepted proposal still has a material defect.",
          correction: "Correct the cited defect without adding scope.",
          uncertainty: "",
        });
      const preserved = structuredClone(raw);

      const repair = repairableCompilerJudgeVerdict(raw, {
        draftDigest: compiledGraphDigest(projection.objective),
        inventory: request.inventory,
        graph: proposal,
        addedEdges: projection.trace.addedEdges,
      });

      expect(raw).toEqual(preserved);
      expect(repair?.decision).toBe("repair");
      expect(repair?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining(
            predicate === "finding"
              ? { id: "existing-blocker", severity: "blocking" }
              : {
                  id: "invalid-acceptance",
                  dimension:
                    predicate === "dimension"
                      ? "assumption-grounding"
                      : predicate === "item"
                        ? "granularity"
                        : "coverage",
                  severity: "blocking",
                  itemIds: proposal.workItems.map((item) => item.id),
                  evidenceIds: ["objective"],
                },
          ),
        ]),
      );
      expect(() =>
        validateCompilerJudgeVerdict(repair, {
          draftDigest: compiledGraphDigest(projection.objective),
          inventory: request.inventory,
          graph: proposal,
          addedEdges: projection.trace.addedEdges,
        }),
      ).not.toThrow();
    },
  );

  it("turns an ungrounded acceptance binding into exact semantic repair evidence", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const projection = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
    });
    const raw = acceptedVerdict(request, proposal, compiledGraphDigest(projection.objective));
    raw.coverage[0]!.acceptanceBindings[0]!.criterionId = "missing-criterion";

    expect(() =>
      validateCompilerJudgeVerdict(raw, {
        draftDigest: compiledGraphDigest(projection.objective),
        inventory: request.inventory,
        graph: proposal,
        addedEdges: projection.trace.addedEdges,
      }),
    ).toThrow("ungrounded acceptance binding");

    const repair = repairableCompilerJudgeVerdict(raw, {
      draftDigest: compiledGraphDigest(projection.objective),
      inventory: request.inventory,
      graph: proposal,
      addedEdges: projection.trace.addedEdges,
    });
    expect(repair).toMatchObject({
      decision: "repair",
      coverage: [{ status: "unknown", acceptanceBindings: [] }],
      findings: [
        {
          id: "invalid-acceptance-binding",
          dimension: "coverage",
          severity: "blocking",
          obligationIds: [request.inventory.obligations[0]!.id],
          itemIds: [proposal.workItems[0]!.id],
          evidenceIds: ["objective"],
        },
      ],
    });
    expect(() =>
      validateCompilerJudgeVerdict(repair, {
        draftDigest: compiledGraphDigest(projection.objective),
        inventory: request.inventory,
        graph: proposal,
        addedEdges: projection.trace.addedEdges,
      }),
    ).not.toThrow();
  });

  it("does not reintroduce an adjudicated unsupported prerequisite into dimension repair", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    request.inventory.obligations.push({
      id: "unsupported-prerequisite",
      text: "Provision infrastructure that the Objective does not request.",
      kind: "prerequisite",
      evidenceIds: ["objective"],
      acceptanceEvidence: "Infrastructure is provisioned.",
    });
    const proposal = semanticProposal(request);
    const projection = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
    });
    const raw = acceptedVerdict(request, proposal, compiledGraphDigest(projection.objective));
    const coverage = raw.coverage.find(
      (entry) => entry.obligationId === "unsupported-prerequisite",
    )!;
    coverage.status = "missing";
    coverage.itemIds = [];
    coverage.acceptanceBindings = [];
    const dimension = raw.dimensions.find((entry) => entry.dimension === "assumption-grounding")!;
    dimension.status = "unknown";
    dimension.reason = "The existing proposal leaves a separate assumption unclear.";
    const challenge = {
      findingId: "unsupported-prerequisite-finding",
      obligationId: "unsupported-prerequisite",
      reason: "The cited Objective does not require infrastructure provisioning.",
      evidenceIds: ["objective"],
    };
    raw.inferenceCorrections = [
      {
        ...challenge,
        disposition: "unsupported-inference",
      },
    ];

    const repair = repairableCompilerJudgeVerdict(raw, {
      draftDigest: compiledGraphDigest(projection.objective),
      inventory: request.inventory,
      graph: proposal,
      addedEdges: projection.trace.addedEdges,
      challenges: [challenge],
    });

    expect(repair).toMatchObject({
      decision: "repair",
      findings: [
        {
          id: "invalid-acceptance",
          dimension: "assumption-grounding",
          obligationIds: [],
          itemIds: proposal.workItems.map((item) => item.id),
          evidenceIds: ["objective"],
        },
      ],
    });
    expect(repair?.findings.flatMap((finding) => finding.obligationIds)).not.toContain(
      "unsupported-prerequisite",
    );
    expect(() =>
      validateCompilerJudgeVerdict(repair, {
        draftDigest: compiledGraphDigest(projection.objective),
        inventory: request.inventory,
        graph: proposal,
        addedEdges: projection.trace.addedEdges,
        challenges: [challenge],
      }),
    ).not.toThrow();
  });
});
