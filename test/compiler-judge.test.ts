import { describe, expect, it } from "vitest";

import { compiledGraphDigest } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
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
});
