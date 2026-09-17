import { describe, expect, it } from "vitest";

import {
  CompilerProposalSchema,
  type CompilerProposal,
  type CompilerRequest,
} from "../src/compiler/contracts.js";
import {
  compilerEvalDigest,
  deriveCompilerInferenceChallenges,
} from "../src/evaluation/compiler-eval.js";
import {
  compilerJudgeSourceBytes,
  MAX_COMPILER_JUDGE_SOURCE_BYTES,
} from "../src/compiler/judge-context.js";
import { workerPacketFromCompiled } from "../src/graph.js";
import type { PinnedRepositoryFacts } from "../src/repository-profiles/read.js";
import {
  parseAndValidateCompilerProposal,
  projectCompilerProposal,
} from "../src/compiler/proposal.js";
import {
  analyzeDependencies,
  exclusiveResourcePairs,
  overlappingScopePairs,
} from "../src/graph-analysis.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import { parseCompilerOperation } from "../src/toolchains/compiler-capabilities.js";
import {
  semanticPinnedFacts,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";

function codes(request: CompilerRequest, proposal: unknown, pinned?: PinnedRepositoryFacts) {
  return parseAndValidateCompilerProposal(
    request,
    proposal,
    pinned ? { pinnedFacts: pinned, runPolicy: projectionPolicy(request) } : undefined,
  ).report.violations.map((entry) => ({
    code: entry.code,
    itemId: entry.itemId,
    field: entry.field,
    expected: entry.expected,
    observed: entry.observed,
  }));
}

function projectionPolicy(request: CompilerRequest) {
  const compilerMediaEgress =
    request.media.assetEgress.mode === "denied"
      ? DEFAULT_RUN_POLICY.compilerMediaEgress
      : {
          mode: request.media.assetEgress.mode,
          maxAssets: 32,
          deterministicReviewRuleIds: request.media.reviewRules.map(({ id }) => id).sort(),
        };
  return {
    ...DEFAULT_RUN_POLICY,
    workItemTimeoutMinutes: request.constraints.workItemTimeoutMinutes,
    allowedNetworkDestinations: [...request.constraints.allowedNetworkDestinations],
    compilerMediaEgress,
  };
}

function mediaIntent(
  overrides: Partial<CompilerProposal["mediaIntents"][number]> = {},
): CompilerProposal["mediaIntents"][number] {
  return {
    id: "primary-media",
    role: "layout-reference",
    purpose: "implementation-reference",
    necessity: "required",
    obligationIds: ["explicit-contract"],
    rationale: "The implementation requires an exact media reference.",
    brief: "Produce a bounded layout reference that shows the required contract.",
    fulfillment: { kind: "produced", inputRoleBindings: [] },
    output: {
      mediaTypes: ["image/png"],
      minimumCount: 1,
      maximumCount: 1,
      raster: {
        minimumWidth: 640,
        maximumWidth: 1024,
        minimumHeight: 480,
        maximumHeight: 768,
        alpha: "allowed",
        animation: "forbidden",
      },
    },
    review: { kind: "human-required" },
    bindings: [{ workItemId: "item-1", direction: "input-to", criterionIds: [] }],
    ...overrides,
  };
}

const privateUnknownOutput = {
  outputVisibility: "private" as const,
  outputRightsBasis: "unknown" as const,
};

it("rejects duplicate imported asset identities before media projection", () => {
  const proposal = semanticProposal(semanticRequest());
  proposal.mediaIntents = [
    mediaIntent({
      fulfillment: { kind: "imported", assetIds: ["asset-1", "asset-1"] },
      output: {
        mediaTypes: ["image/png"],
        minimumCount: 2,
        maximumCount: 2,
        raster: null,
      },
    }),
  ];
  expect(() => CompilerProposalSchema.parse(proposal)).toThrow("reference IDs must be unique");
});

function judgeSourceBytes(
  request: CompilerRequest,
  proposal: CompilerProposal,
  trace: ReturnType<typeof projectCompilerProposal>["trace"],
) {
  return compilerJudgeSourceBytes({
    originalObjective: {
      number: request.objective.number,
      title: request.objective.title,
      body: request.objective.body,
    },
    baseSha: request.baseSha,
    priorCompilationFailure: { reason: "x".repeat(8_000), rawProposalAvailable: false },
    inventory: request.inventory,
    challenges: request.challenges,
    proposal,
    projectionTrace: trace,
    draftDigest: trace.graphDigest,
    inventoryDigest: compilerEvalDigest(request.inventory),
  });
}

describe("semantic proposal validation", () => {
  it.each([
    {
      name: "duplicate Work Item ID",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems.push({
          ...structuredClone(proposal.workItems[0]!),
          scope: ["src/other.ts"],
        });
      },
      expected: { code: "duplicate-item-id", itemId: "item-1", field: "/workItems" },
    },
    {
      name: "duplicate criterion ID",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.criteria.push(structuredClone(proposal.workItems[0]!.criteria[0]!));
      },
      expected: {
        code: "duplicate-criterion-id",
        itemId: "item-1",
        field: "/workItems/0/criteria/1/id",
      },
    },
    {
      name: "duplicate criterion text",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        const duplicate = structuredClone(proposal.workItems[0]!.criteria[0]!);
        duplicate.id = "duplicated-text";
        proposal.workItems[0]!.criteria.push(duplicate);
      },
      expected: {
        code: "duplicate-criterion-text",
        itemId: "item-1",
        field: "/workItems/0/criteria/1/text",
      },
    },
    {
      name: "unknown obligation",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.obligationIds.push("not-in-inventory");
      },
      expected: {
        code: "unknown-obligation",
        itemId: "item-1",
        field: "/workItems/0/obligationIds",
      },
    },
    {
      name: "unmapped explicit obligation",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.obligationIds = [];
      },
      expected: { code: "unmapped-obligation", itemId: null, field: "/workItems" },
    },
    {
      name: "unknown dependency",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.dependsOn = ["missing"];
      },
      expected: {
        code: "unknown-dependency",
        itemId: "item-1",
        field: "/workItems/0/dependsOn",
      },
    },
    {
      name: "dependency cycle",
      count: 2,
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.dependsOn = ["item-2"];
      },
      expected: { code: "dependency-cycle", itemId: null, field: "/workItems" },
    },
    {
      name: "duplicate dependency",
      count: 2,
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[1]!.dependsOn = ["item-1", "item-1"];
      },
      expected: {
        code: "duplicate-dependency",
        itemId: "item-2",
        field: "/workItems/1/dependsOn",
      },
    },
    {
      name: "unknown observed recipe",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        const reference = proposal.workItems[0]!.criteria[0]!.validation[0]!.evidence[0]!;
        if (reference.kind !== "observed") throw new Error("fixture recipe changed");
        reference.recipeId = "unknown-recipe";
      },
      expected: {
        code: "unknown-validation-recipe",
        itemId: "item-1",
        field: "/workItems/0/criteria/0/validation/0/evidence",
      },
    },
    {
      name: "protected risk without deterministic evidence",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.criteria[0]!.risk = "security";
        proposal.workItems[0]!.criteria[0]!.validation = [{ tier: "semantic", evidence: [] }];
      },
      expected: {
        code: "protected-risk-validation",
        itemId: "item-1",
        field: "/workItems/0/criteria/0/validation",
      },
    },
    {
      name: "ungrounded visual tier",
      mutate(_request: CompilerRequest, proposal: CompilerProposal) {
        proposal.workItems[0]!.criteria[0]!.validation[0]!.tier = "visual";
      },
      expected: {
        code: "ungrounded-validation-tier",
        itemId: "item-1",
        field: "/workItems/0/criteria/0/validation/0/tier",
      },
    },
    {
      name: "dependency bound",
      count: 2,
      mutate(request: CompilerRequest) {
        request.constraints.maxDependenciesPerItem = 0;
      },
      expected: {
        code: "dependency-limit",
        itemId: "item-2",
        field: "/workItems/1/dependsOn",
      },
    },
  ])("returns the exact $name violation identity", ({ count = 1, mutate, expected }) => {
    const request = semanticRequest();
    const proposal = semanticProposal(request, count);
    mutate(request, proposal);
    expect(codes(request, proposal)).toContainEqual(expect.objectContaining(expected));
  });

  it("returns schema failure without persisting malformed provider fields", () => {
    const request = semanticRequest();
    const malformed = structuredClone(semanticProposal(request)) as unknown as {
      workItems: Array<Record<string, unknown>>;
    };
    malformed.workItems[0]!.scope = ["../private"];
    const result = parseAndValidateCompilerProposal(request, malformed);
    expect(result.proposal).toBeUndefined();
    expect(result.report).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: [{ code: "invalid-scope", field: "/workItems/0/scope/0" }],
    });
    expect(JSON.stringify(result.report)).not.toContain("../private");
  });

  it("returns a structured schema violation for an overlong item ID", () => {
    const request = semanticRequest();
    const malformed = structuredClone(semanticProposal(request)) as unknown as {
      workItems: Array<Record<string, unknown>>;
    };
    malformed.workItems[0]!.id = "a".repeat(65);
    expect(() => parseAndValidateCompilerProposal(request, malformed)).not.toThrow();
    expect(parseAndValidateCompilerProposal(request, malformed).report).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: [
        expect.objectContaining({
          code: "schema-invalid",
          itemId: null,
          field: "/workItems/0/id",
        }),
      ],
    });
  });

  it("reports projection preconditions through structured proposal violations", () => {
    const request = semanticRequest();

    const unsafeResource = structuredClone(semanticProposal(request)) as unknown as {
      workItems: Array<Record<string, unknown>>;
    };
    unsafeResource.workItems[0]!.exclusiveResources = ["cache/../shared"];
    expect(parseAndValidateCompilerProposal(request, unsafeResource).report).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: [
        expect.objectContaining({
          code: "schema-invalid",
          itemId: "item-1",
          field: "/workItems/0/exclusiveResources/0",
        }),
      ],
    });

    const scopedTarget = semanticProposal(request);
    scopedTarget.workItems[0]!.scope = ["test/my file.js"];
    scopedTarget.workItems[0]!.criteria[0]!.validation[0]!.evidence = [
      { kind: "scoped-node-test", targets: ["test/my file.js"] },
    ];
    expect(codes(request, scopedTarget)).toContainEqual(
      expect.objectContaining({
        code: "unknown-validation-recipe",
        itemId: "item-1",
        field: "/workItems/0/criteria/0/validation/0/evidence",
      }),
    );

    const commandBound = semanticProposal(request);
    request.repository.validationRecipes = Array.from({ length: 33 }, (_, index) => ({
      ...request.repository.validationRecipes[0]!,
      id: `recipe-${index + 1}`,
      command: `node --test test/case-${index + 1}.js`,
    }));
    commandBound.workItems[0]!.criteria[0]!.validation = [
      {
        tier: "mechanical",
        evidence: request.repository.validationRecipes
          .slice(0, 32)
          .map((recipe) => ({ kind: "observed" as const, recipeId: recipe.id })),
      },
      {
        tier: "mechanical",
        evidence: [{ kind: "observed", recipeId: request.repository.validationRecipes[32]!.id }],
      },
    ];
    expect(codes(request, commandBound)).toContainEqual(
      expect.objectContaining({
        code: "validation-command-limit",
        itemId: "item-1",
        expected: { maximumUniqueValidationCommands: 32 },
        observed: 33,
      }),
    );

    const requirementRequest = semanticRequest();
    const requirementBound = semanticProposal(requirementRequest);
    requirementBound.workItems[0]!.executionIntent.additionalTools = Array.from(
      { length: 64 },
      (_, index) => `extra-tool-${index + 1}`,
    );
    expect(codes(requirementRequest, requirementBound)).toContainEqual(
      expect.objectContaining({
        code: "execution-requirement-limit",
        itemId: "item-1",
        field: "/workItems/0/executionIntent/additionalTools",
        expected: { maximumProjectedValues: 64 },
        observed: 66,
      }),
    );
  });

  it("counts pinned LFS tooling at the exact projected execution boundary", () => {
    const pinned = semanticPinnedFacts({
      lfs: {
        baseSha: "a".repeat(40),
        assets: [],
        requiredTools: ["git-lfs"],
        attributes: true,
      },
    });
    const request = semanticRequest(pinned);
    const boundary = semanticProposal(request);
    boundary.workItems[0]!.executionIntent.additionalTools = Array.from(
      { length: 61 },
      (_, index) => `extra-tool-${index + 1}`,
    );

    expect(parseAndValidateCompilerProposal(request, boundary).report.status).toBe("valid");
    expect(
      projectCompilerProposal({
        request,
        proposal: boundary,
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }).objective.workItems[0]!.requirements!.tools,
    ).toHaveLength(64);

    const overflow = structuredClone(boundary);
    overflow.workItems[0]!.executionIntent.additionalTools.push("extra-tool-62");
    expect(parseAndValidateCompilerProposal(request, overflow).report).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: expect.arrayContaining([
        expect.objectContaining({
          code: "execution-requirement-limit",
          itemId: "item-1",
          field: "/workItems/0/executionIntent/additionalTools",
          expected: { maximumProjectedValues: 64 },
          observed: 65,
        }),
      ]),
    });
  });

  it("counts Factory-derived generated resources at the exact 64-item boundary", () => {
    const fixture = (count: number) => {
      const pinned = semanticPinnedFacts({
        paths: [
          "package.json",
          "package-lock.json",
          ...Array.from({ length: count }, (_, index) => `dist/chunk-${index + 1}.js`),
        ],
      });
      const request = semanticRequest(pinned);
      const proposal = semanticProposal(request);
      proposal.workItems[0]!.scope = ["dist/"];
      return { pinned, request, proposal };
    };
    const boundary = fixture(64);
    expect(
      parseAndValidateCompilerProposal(boundary.request, boundary.proposal, {
        pinnedFacts: boundary.pinned,
        runPolicy: projectionPolicy(boundary.request),
      }).report.status,
    ).toBe("valid");
    expect(
      projectCompilerProposal({
        request: boundary.request,
        proposal: boundary.proposal,
        pinnedFacts: boundary.pinned,
        runPolicy: projectionPolicy(boundary.request),
      }).objective.workItems[0]!.changeSurface?.exclusiveResources,
    ).toHaveLength(64);

    const overflow = fixture(65);
    expect(codes(overflow.request, overflow.proposal, overflow.pinned)).toContainEqual(
      expect.objectContaining({
        code: "exclusive-resource-limit",
        itemId: "item-1",
        field: "/workItems/0/exclusiveResources",
        expected: { maximumProjectedValues: 64 },
        observed: 65,
      }),
    );
  });

  it("rejects an overlong Factory-derived resource before projection", () => {
    const path = `dist/${"a".repeat(196)}.js`;
    expect(path.length).toBeGreaterThan(200);
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", path],
    });
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    proposal.workItems[0]!.scope = ["dist/"];
    expect(codes(request, proposal, pinned)).toContainEqual(
      expect.objectContaining({
        code: "exclusive-resource-limit",
        itemId: "item-1",
        field: "/workItems/0/exclusiveResources",
        expected: { maximumProjectedLength: 200 },
        observed: path.length,
      }),
    );
  });

  it("counts scope-derived serialization edges at the exact dependency boundary", () => {
    const fixture = (overlapCount: number) => {
      const paths = Array.from(
        { length: overlapCount },
        (_, index) => `src/independent-${index + 1}.ts`,
      );
      const pinned = semanticPinnedFacts({
        paths: ["package.json", "package-lock.json", ...paths],
      });
      const request = semanticRequest(pinned);
      const proposal = semanticProposal(request, overlapCount + 1);
      for (const [index, item] of proposal.workItems.entries()) {
        item.dependsOn = [];
        item.scope = index < overlapCount ? [paths[index]!] : paths;
      }
      return { pinned, request, proposal };
    };
    const boundary = fixture(50);
    expect(
      parseAndValidateCompilerProposal(boundary.request, boundary.proposal, {
        pinnedFacts: boundary.pinned,
        runPolicy: projectionPolicy(boundary.request),
      }).report.status,
    ).toBe("valid");
    expect(
      projectCompilerProposal({
        request: boundary.request,
        proposal: boundary.proposal,
        pinnedFacts: boundary.pinned,
        runPolicy: projectionPolicy(boundary.request),
      }).objective.workItems.at(-1)!.dependsOn,
    ).toHaveLength(50);

    const overflow = fixture(51);
    expect(codes(overflow.request, overflow.proposal, overflow.pinned)).toContainEqual(
      expect.objectContaining({
        code: "dependency-limit",
        itemId: "item-52",
        field: "/workItems/51/dependsOn",
        expected: 50,
        observed: 51,
      }),
    );

    overflow.proposal.workItems[0]!.obligationIds = [];
    const combined = codes(overflow.request, overflow.proposal, overflow.pinned);
    expect(combined.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["unmapped-obligation", "dependency-limit"]),
    );
  });

  it("supports the graph's per-item dependency capacity without a smaller judge-wide cap", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const fixture = (finalJoinWidth: number) => {
      const proposal = semanticProposal(request, 100);
      for (const [index, item] of proposal.workItems.entries()) {
        item.scope = [`src/disjoint-${index + 1}.ts`];
        item.dependsOn =
          index < 51
            ? []
            : Array.from(
                { length: index === 99 ? finalJoinWidth : 21 },
                (_, dependency) => `item-${dependency + 1}`,
              );
      }
      return proposal;
    };
    const boundary = fixture(21);
    expect(
      parseAndValidateCompilerProposal(request, boundary, {
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }).report.status,
    ).toBe("valid");
    expect(
      projectCompilerProposal({
        request,
        proposal: boundary,
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }).objective.workItems.reduce((total, item) => total + item.dependsOn.length, 0),
    ).toBe(1_029);
  });

  it("bounds the fully expanded Worker Packet before projection", () => {
    const fixture = (count: number) => {
      const pinned = semanticPinnedFacts();
      const request = semanticRequest(pinned);
      const proposal = semanticProposal(request);
      const evidence = proposal.workItems[0]!.criteria[0]!.validation;
      proposal.workItems[0]!.criteria = Array.from({ length: count }, (_, index) => ({
        id: `criterion-${index + 1}`,
        text: `Criterion ${index + 1} verifies ${"x".repeat(970)}.`,
        risk: "ordinary" as const,
        validation: structuredClone(evidence),
      }));
      return { pinned, request, proposal };
    };
    const boundary = fixture(7);
    expect(
      parseAndValidateCompilerProposal(boundary.request, boundary.proposal, {
        pinnedFacts: boundary.pinned,
        runPolicy: projectionPolicy(boundary.request),
      }).report.status,
    ).toBe("valid");

    const issueOverflow = fixture(10);
    expect(
      codes(issueOverflow.request, issueOverflow.proposal, issueOverflow.pinned),
    ).toContainEqual(expect.objectContaining({ code: "issue-body-limit", itemId: "item-1" }));

    const overflow = fixture(50);
    expect(codes(overflow.request, overflow.proposal, overflow.pinned)).toContainEqual(
      expect.objectContaining({
        code: "worker-packet-limit",
        itemId: "item-1",
        field: "/workItems/0",
        expected: { maximumProjectedBytes: 128 * 1024 },
        observed: expect.any(Number),
      }),
    );
  });

  it("reports invalid metadata and an independent exact oversized issue body together", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 52);
    const evidence = proposal.workItems[0]!.criteria[0]!.validation;
    proposal.workItems[0]!.criteria = Array.from({ length: 10 }, (_, index) => ({
      id: `criterion-${index + 1}`,
      text: `Criterion ${index + 1} verifies ${"x".repeat(index === 0 ? 967 : 970)}.`,
      risk: "ordinary" as const,
      validation: structuredClone(evidence),
    }));
    proposal.workItems[51]!.dependsOn = proposal.workItems.slice(0, 50).map((item) => item.id);
    proposal.workItems[51]!.scope = [...proposal.workItems[50]!.scope];

    const report = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    }).report;
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "projection-blocked",
          itemId: proposal.workItems[51]!.id,
          field: "/workItems/51",
        }),
        expect.objectContaining({
          code: "issue-body-limit",
          itemId: proposal.workItems[0]!.id,
          observed: 73_756,
        }),
      ]),
    );
  });

  it.each([
    {
      name: "duplicate maximum-length preconditions and exclusions",
      mutate(proposal: CompilerProposal) {
        proposal.workItems[0]!.preconditions = Array(64).fill(`P${"p".repeat(1_999)}`);
        proposal.workItems[0]!.outOfScope = Array(64).fill(`O${"o".repeat(1_999)}`);
      },
    },
    {
      name: "restored criteria, scope, and conventions",
      mutate(proposal: CompilerProposal) {
        proposal.workItems[0]!.criteria[0]!.text = `C${"c".repeat(1_999)}`;
        proposal.workItems[0]!.scope = Array(64).fill(`src/${"s".repeat(493)}.ts`);
        proposal.workItems[0]!.conventions = Array(64).fill(`V${"v".repeat(1_999)}`);
      },
    },
  ])("bounds $name after restoring authored fields", ({ mutate }) => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    mutate(proposal);
    expect(codes(request, proposal, pinned)).toContainEqual(
      expect.objectContaining({
        code: "worker-packet-limit",
        itemId: "item-1",
        field: "/workItems/0",
        expected: { maximumProjectedBytes: 128 * 1024 },
        observed: expect.any(Number),
      }),
    );
  });

  it("projects every restored authored field when its exact Worker Packet fits", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    proposal.workItems[0]!.criteria[0]!.text = `C${"c".repeat(999)}`;
    proposal.workItems[0]!.scope = Array(5).fill(`src/${"s".repeat(193)}.ts`);
    proposal.workItems[0]!.preconditions = Array(5).fill(`P${"p".repeat(999)}`);
    proposal.workItems[0]!.outOfScope = Array(5).fill(`O${"o".repeat(999)}`);
    proposal.workItems[0]!.conventions = Array(5).fill(`V${"v".repeat(999)}`);

    expect(
      parseAndValidateCompilerProposal(request, proposal, {
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }).report.status,
    ).toBe("valid");
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    }).objective.workItems[0]!;
    expect(() => workerPacketFromCompiled(projected)).not.toThrow();
    expect(projected).toMatchObject({
      acceptance: proposal.workItems[0]!.criteria.map((criterion) => criterion.text),
      scope: proposal.workItems[0]!.scope,
      preconditions: proposal.workItems[0]!.preconditions,
      outOfScope: proposal.workItems[0]!.outOfScope,
      conventions: proposal.workItems[0]!.conventions,
    });
  });

  it("reserves the maximum later economic rationale in the compiled graph envelope", () => {
    const paths = Array.from(
      { length: 64 },
      (_, index) => `src/${index + 1}-${"x".repeat(260)}.ts`,
    );
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", ...paths],
    });
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 100);
    for (const item of proposal.workItems) item.scope = ["src/"];
    const graphViolation = codes(request, proposal, pinned).find(
      (entry) => entry.code === "compiled-graph-limit",
    );
    expect(graphViolation).toEqual(
      expect.objectContaining({
        itemId: null,
        field: "/workItems",
        expected: { maximumProjectedBytes: 2 * 1024 * 1024 },
        observed: expect.any(Number),
      }),
    );
    expect(graphViolation!.observed).toEqual(expect.any(Number));
    expect(graphViolation!.observed as number).toBeLessThan(2 * 1024 * 1024 + 200_000);
  });

  it("uses repository requirements and the exact run policy during envelope validation", () => {
    const requirementsPath = ".factory/execution-requirements.json";
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", requirementsPath, "src/item-1.ts"],
      documents: {
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
        [requirementsPath]: JSON.stringify({
          version: 1,
          scopes: [
            { paths: ["src/"], requirements: { cpu: 2 } },
            { paths: ["src/item-1.ts"], requirements: { cpu: 3 } },
          ],
        }),
      },
    });
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const result = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: {
        ...DEFAULT_RUN_POLICY,
        workItemTimeoutMinutes: 7,
      },
    });
    expect(result.report).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: [
        expect.objectContaining({
          code: "projection-blocked",
          itemId: null,
          field: "/workItems",
          observed: {
            error: expect.stringContaining("conflicting cpu repository evidence"),
          },
        }),
      ],
    });
  });

  it("accepts bounded model-owned non-derivable execution intent", () => {
    const request = semanticRequest(undefined, ["api.example.com"]);
    const proposal = semanticProposal(request);
    proposal.workItems[0]!.executionIntent = {
      estimatedDurationMinutes: 20,
      additionalTools: ["ffmpeg"],
      services: ["postgresql"],
      additionalNetworkDestinations: ["api.example.com"],
      trust: "trusted_local",
    };

    expect(parseAndValidateCompilerProposal(request, proposal).report.status).toBe("valid");
  });

  it("reports duplicate deliverable contracts before economic projection", () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request, 2);
    proposal.workItems[1] = {
      ...structuredClone(proposal.workItems[0]!),
      id: "item-2",
      title: "A different label does not make a distinct deliverable",
      obligationIds: [],
    };
    expect(parseAndValidateCompilerProposal(request, proposal).report).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate-work-item-contract",
          itemId: "item-2",
          field: "/workItems",
          observed: ["item-1", "item-2"],
        }),
      ]),
    });
  });

  it.each([
    ["Rust", "src/lib.rs", "unsupported-toolchain"],
    ["Go", "src/main.go", "unsupported-toolchain"],
    ["ambient Python", "src/app.py", "unsupported-toolchain"],
  ])(
    "does not let an observed npm recipe validate %s work in a polyglot repository",
    (_language, scope, expectedCode) => {
      const pinned = semanticPinnedFacts({
        paths: [
          "package.json",
          "package-lock.json",
          "src/index.ts",
          "src/lib.rs",
          "src/main.go",
          "src/app.py",
        ],
        scripts: { test: "node --test" },
      });
      const request = semanticRequest(pinned, [
        "files.pythonhosted.org",
        "pypi.org",
        "registry.npmjs.org",
      ]);
      const proposal = semanticProposal(request);
      proposal.workItems[0]!.scope = [scope];

      expect(codes(request, proposal)).toContainEqual(
        expect.objectContaining({
          code: expectedCode,
          itemId: "item-1",
          field: "/workItems/0/scope",
        }),
      );
    },
  );
});

describe("media intent compilation", () => {
  it("keeps a nonmedia proposal on the repository execution path", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(result.objective.workItems).toHaveLength(proposal.workItems.length);
    expect(
      result.objective.workItems.every(
        ({ deliverable }) => deliverable.kind === "repository-change",
      ),
    ).toBe(true);
    expect(result.trace.mediaIntents).toEqual([]);
  });

  it("returns structured limits for 101 projected items without running out-of-range economics", () => {
    const pinned = semanticPinnedFacts({
      paths: [
        "package.json",
        "package-lock.json",
        ...Array.from({ length: 70 }, (_, index) => `src/item-${index + 1}.ts`),
      ],
    });
    const request = semanticRequest(pinned);
    const capability = {
      id: "bounded-raster-producer",
      capabilityDigest: "7".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["raster-role"],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["image/png"],
      maximumCount: 1,
      raster: {
        maximumWidth: 2048,
        maximumHeight: 2048,
        supportsAlpha: true,
        supportsAnimation: false,
      },
    };
    request.media.producerCapabilities = [capability];
    const proposal = semanticProposal(request, 70);
    proposal.mediaIntents = Array.from({ length: 31 }, (_, index) =>
      mediaIntent({
        id: `role-${index + 1}`,
        role: "raster-role",
        brief: `Produce bounded role ${index + 1}.`,
      }),
    );
    const result = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
      mediaPlanning: {
        assetBindings: [],
        producerCapabilities: [capability],
        reviewRules: [],
      },
    });
    expect(result.report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "work-item-count", observed: 101 }),
        expect.objectContaining({
          code: "objective-planning-required",
          observed: expect.objectContaining({ workItems: 101 }),
        }),
      ]),
    );
  });

  it("projects sixteen four-variant producers without collapsing their semantic intents", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const capability = {
      id: "bounded-opaque-producer",
      capabilityDigest: "7".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["opaque-product-part"],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["application/octet-stream"],
      maximumCount: 4,
      raster: null,
    };
    request.media.producerCapabilities = [capability];
    const proposal = semanticProposal(request);
    proposal.mediaIntents = Array.from({ length: 16 }, (_, index) =>
      mediaIntent({
        id: `part-${index + 1}`,
        role: "opaque-product-part",
        brief: `Produce bounded opaque part ${index + 1}.`,
        output: {
          mediaTypes: ["application/octet-stream"],
          minimumCount: 4,
          maximumCount: 4,
          raster: null,
        },
      }),
    );
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
      mediaPlanning: {
        assetBindings: [],
        producerCapabilities: [capability],
        reviewRules: [],
      },
    });
    const producers = projected.objective.workItems.filter(
      (item) => item.deliverable.kind === "asset-production",
    );
    expect(producers).toHaveLength(16);
    expect(
      producers.every(
        (item) =>
          item.deliverable.kind === "asset-production" &&
          item.deliverable.intent.output.minimumCount === 4 &&
          item.deliverable.intent.output.maximumCount === 4 &&
          item.deliverable.activationSelection.minimumCount === 1 &&
          item.deliverable.activationSelection.maximumCount === 4,
      ),
    ).toBe(true);
    expect(
      projected.objective.workItems.find((item) => item.id === "item-1")
        ?.generatedAssetRequirements,
    ).toHaveLength(16);
  });

  it("fails deterministically when required media has neither an import nor a producer", () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [mediaIntent()];
    expect(codes(request, proposal)).toContainEqual(
      expect.objectContaining({
        code: "media-producer-unavailable",
        itemId: "primary-media",
        field: "/mediaIntents/0/output",
      }),
    );
  });

  it("omits helpful unavailable media while retaining an explicit trace disposition", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [mediaIntent({ necessity: "helpful" })];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(result.objective.workItems).toHaveLength(1);
    expect(result.trace.mediaIntents).toEqual([
      {
        intentId: "primary-media",
        disposition: "omitted-helpful",
        producerWorkItemId: null,
      },
    ]);
  });

  it("binds an exact imported raster directly to its repository consumer", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const manifestDigest = "b".repeat(64);
    const policy = {
      ...projectionPolicy(request),
      compilerMediaEgress: {
        mode: "private-assets" as const,
        maxAssets: 32,
        deterministicReviewRuleIds: [],
      },
    };
    request.media = {
      assetManifest: {
        digest: manifestDigest,
        assets: [
          {
            id: "asset-1",
            mediaType: "image/png",
            bytes: 4096,
            inspection: {
              kind: "raster",
              width: 800,
              height: 600,
              frames: 1,
              alpha: false,
            },
            visibility: "private",
          },
        ],
      },
      assetEgress: {
        mode: "private-assets",
        policyDigest: compilerEvalDigest(policy.compilerMediaEgress),
      },
      producerCapabilities: [],
      reviewRules: [],
    };
    const input = {
      manifestDigest,
      descriptorDigest: "c".repeat(64),
      contentDigest: "d".repeat(64),
      storageReceiptDigest: "e".repeat(64),
      path: `assets/${"c".repeat(64)}/reference.png`,
      purpose: "compiler-import",
    };
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        fulfillment: { kind: "imported", assetIds: ["asset-1"] },
      }),
    ];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: policy,
      mediaPlanning: {
        assetBindings: [{ assetId: "asset-1", input }],
        producerCapabilities: [],
        reviewRules: [],
      },
    });
    expect(result.objective.workItems[0]!.assetInputs).toEqual([input]);
    expect(result.trace.mediaIntents[0]).toMatchObject({
      intentId: "primary-media",
      disposition: "imported",
      producerWorkItemId: null,
    });
  });

  it("does not pass a same-MIME producer input through as the finished intent", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const manifestDigest = "b".repeat(64);
    const policy = {
      ...projectionPolicy(request),
      compilerMediaEgress: {
        mode: "private-assets" as const,
        maxAssets: 32,
        deterministicReviewRuleIds: [],
      },
    };
    const capability = {
      id: "png-derivative",
      capabilityDigest: "1".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [
        {
          id: "source",
          mediaTypes: ["image/png"],
          minimumCount: 1,
          maximumCount: 1,
          semantics: "directional-reference",
        },
      ],
      roles: ["layout-reference"],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["image/png"],
      maximumCount: 1,
      raster: {
        maximumWidth: 2048,
        maximumHeight: 2048,
        supportsAlpha: true,
        supportsAnimation: false,
      },
    };
    request.media = {
      assetManifest: {
        digest: manifestDigest,
        assets: [
          {
            id: "asset-1",
            mediaType: "image/png",
            bytes: 4096,
            inspection: {
              kind: "raster",
              width: 800,
              height: 600,
              frames: 1,
              alpha: false,
            },
            visibility: "private",
          },
        ],
      },
      assetEgress: {
        mode: "private-assets",
        policyDigest: compilerEvalDigest(policy.compilerMediaEgress),
      },
      producerCapabilities: [capability],
      reviewRules: [],
    };
    const input = {
      manifestDigest,
      descriptorDigest: "c".repeat(64),
      contentDigest: "d".repeat(64),
      storageReceiptDigest: "e".repeat(64),
      path: `assets/${"c".repeat(64)}/reference.png`,
      purpose: "compiler-import",
    };
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: ["asset-1"], inputIntentIds: [] },
          ],
        },
      }),
    ];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: policy,
      mediaPlanning: {
        assetBindings: [{ assetId: "asset-1", input }],
        producerCapabilities: [capability],
        reviewRules: [],
      },
    });
    const producer = result.objective.workItems.find(
      (item) => item.deliverable.kind === "asset-production",
    );
    expect(producer?.assetInputs).toEqual([input]);
    expect(result.trace.mediaIntents).toEqual([
      {
        intentId: "primary-media",
        disposition: "producer",
        producerWorkItemId: producer!.id,
      },
    ]);
  });

  it("binds exact opaque non-raster media without raster inspection fields", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const manifestDigest = "b".repeat(64);
    const policy = {
      ...projectionPolicy(request),
      compilerMediaEgress: {
        mode: "private-assets" as const,
        maxAssets: 32,
        deterministicReviewRuleIds: [],
      },
    };
    request.media = {
      assetManifest: {
        digest: manifestDigest,
        assets: [
          {
            id: "sound-1",
            mediaType: "audio/wav",
            bytes: 4096,
            inspection: { kind: "opaque" },
            visibility: "private",
          },
        ],
      },
      assetEgress: {
        mode: "private-assets",
        policyDigest: compilerEvalDigest(policy.compilerMediaEgress),
      },
      producerCapabilities: [],
      reviewRules: [],
    };
    const input = {
      manifestDigest,
      descriptorDigest: "c".repeat(64),
      contentDigest: "d".repeat(64),
      storageReceiptDigest: "e".repeat(64),
      path: `assets/${"c".repeat(64)}/reference.wav`,
      purpose: "compiler-import",
    };
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        id: "interaction-sound",
        role: "sound-reference",
        fulfillment: { kind: "imported", assetIds: ["sound-1"] },
        output: {
          mediaTypes: ["audio/wav"],
          minimumCount: 1,
          maximumCount: 16,
          raster: null,
        },
      }),
    ];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: policy,
      mediaPlanning: {
        assetBindings: [{ assetId: "sound-1", input }],
        producerCapabilities: [],
        reviewRules: [],
      },
    });

    expect(result.objective.workItems[0]!.assetInputs).toEqual([input]);
    expect(result.trace.mediaIntents).toEqual([
      {
        intentId: "interaction-sound",
        disposition: "imported",
        producerWorkItemId: null,
      },
    ]);
  });

  it("derives one asset producer and its directed consumer dependency", () => {
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", "src/item-1.ts", "src/item-2.ts"],
    });
    const request = semanticRequest(pinned);
    const capability = {
      id: "raster-producer",
      capabilityDigest: "1".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["layout-reference" as const],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["image/png" as const],
      maximumCount: 4,
      raster: {
        maximumWidth: 2048,
        maximumHeight: 2048,
        supportsAlpha: true,
        supportsAnimation: false,
      },
    };
    request.media.producerCapabilities = [capability];
    const proposal = semanticProposal(request, 2);
    proposal.mediaIntents = [
      mediaIntent({
        bindings: [{ workItemId: "item-1", direction: "input-to", criterionIds: [] }],
      }),
    ];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
      mediaPlanning: {
        assetBindings: [],
        producerCapabilities: [capability],
        reviewRules: [],
      },
    });
    const producer = result.objective.workItems.find(
      ({ deliverable }) => deliverable.kind === "asset-production",
    );
    expect(producer?.scope).toEqual([]);
    expect(producer?.validationCommands).toEqual([]);
    expect(producer?.dependsOn).toEqual([]);
    expect(result.objective.workItems.find(({ id }) => id === "item-1")!.dependsOn).toContain(
      producer!.id,
    );
    expect(result.trace.addedEdges).toContainEqual({
      itemId: "item-1",
      dependsOn: producer!.id,
      reason: "media-input",
    });
    expect(workerPacketFromCompiled(producer!).deliverable).toMatchObject({
      kind: "asset-production",
      contract: "clockgrove.factory/asset-set",
      producerCapabilityId: "raster-producer",
    });
  });

  it("refuses required repository-result media evidence before graph projection", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    request.media.producerCapabilities = [
      {
        id: "input-only-raster-producer",
        capabilityDigest: "1".repeat(64),
        ...privateUnknownOutput,
        inputRoles: [],
        roles: ["layout-reference"],
        purposes: ["implementation-reference"],
        mediaTypes: ["image/png"],
        maximumCount: 4,
        raster: {
          maximumWidth: 2048,
          maximumHeight: 2048,
          supportsAlpha: true,
          supportsAnimation: false,
        },
      },
    ];
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        bindings: [
          { workItemId: "item-1", direction: "evidence-for", criterionIds: ["implemented"] },
        ],
      }),
    ];
    const parsed = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(parsed.report.violations).toContainEqual(
      expect.objectContaining({ code: "incompatible-media-output", itemId: "primary-media" }),
    );
  });

  it("projects non-raster media without inventing image constraints", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const capability = {
      id: "audio-producer",
      capabilityDigest: "2".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["sound-reference" as const],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["audio/wav"],
      maximumCount: 2,
      raster: null,
    };
    request.media.producerCapabilities = [capability];
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        id: "interaction-sound",
        role: "sound-reference",
        brief: "Produce the bounded interaction sound reference.",
        output: {
          mediaTypes: ["audio/wav"],
          minimumCount: 1,
          maximumCount: 1,
          raster: null,
        },
      }),
    ];

    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
      mediaPlanning: {
        assetBindings: [],
        producerCapabilities: [capability],
        reviewRules: [],
      },
    });
    const producer = result.objective.workItems.find(
      ({ deliverable }) => deliverable.kind === "asset-production",
    );

    expect(producer?.deliverable).toMatchObject({
      kind: "asset-production",
      producerCapabilityId: "audio-producer",
      intent: {
        id: "interaction-sound",
        output: { mediaTypes: ["audio/wav"], raster: null },
      },
    });
    expect(result.trace.mediaIntents).toEqual([
      {
        intentId: "interaction-sound",
        disposition: "producer",
        producerWorkItemId: producer!.id,
      },
    ]);
  });

  it("chains a reviewed non-raster activation into a later opaque producer", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const audio = {
      id: "audio-source",
      capabilityDigest: "5".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["sound-reference" as const],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["audio/wav"],
      maximumCount: 1,
      raster: null,
    };
    const opaque = {
      id: "opaque-derivative",
      capabilityDigest: "6".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [
        {
          id: "source",
          mediaTypes: ["audio/wav"],
          minimumCount: 1,
          maximumCount: 1,
          semantics: "directional-reference" as const,
        },
      ],
      roles: ["model-reference" as const],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["application/octet-stream"],
      maximumCount: 1,
      raster: null,
    };
    request.media.producerCapabilities = [audio, opaque];
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        id: "audio-grounding",
        role: "sound-reference",
        brief: "Produce one reviewed audio grounding reference.",
        bindings: [],
        output: {
          mediaTypes: ["audio/wav"],
          minimumCount: 1,
          maximumCount: 1,
          raster: null,
        },
      }),
      mediaIntent({
        id: "opaque-followup",
        role: "model-reference",
        brief: "Produce one opaque derivative from the approved audio reference.",
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            {
              roleId: "source",
              importedAssetIds: [],
              inputIntentIds: ["audio-grounding"],
            },
          ],
        },
        output: {
          mediaTypes: ["application/octet-stream"],
          minimumCount: 1,
          maximumCount: 1,
          raster: null,
        },
      }),
    ];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
      mediaPlanning: {
        assetBindings: [],
        producerCapabilities: [audio, opaque],
        reviewRules: [],
      },
    });
    const source = result.objective.workItems.find(
      (item) =>
        item.deliverable.kind === "asset-production" &&
        item.deliverable.intent.id === "audio-grounding",
    )!;
    const derivative = result.objective.workItems.find(
      (item) =>
        item.deliverable.kind === "asset-production" &&
        item.deliverable.intent.id === "opaque-followup",
    )!;
    expect(derivative.dependsOn).toContain(source.id);
    const packet = workerPacketFromCompiled(derivative);
    expect(packet.generatedAssetRequirements).toEqual([
      expect.objectContaining({
        intentId: "audio-grounding",
        producerWorkItemId: source.id,
        direction: "input-to",
      }),
    ]);
  });

  it("binds the downstream producer-role selection interval into the upstream producer", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const source = {
      id: "multi-source",
      capabilityDigest: "8".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["opaque-source"],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["application/octet-stream"],
      maximumCount: 4,
      raster: null,
    };
    const consumer = {
      id: "requires-two",
      capabilityDigest: "9".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [
        {
          id: "source",
          mediaTypes: ["application/octet-stream"],
          minimumCount: 2,
          maximumCount: 4,
          semantics: "source",
        },
      ],
      roles: ["opaque-bundle"],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["application/octet-stream"],
      maximumCount: 1,
      raster: null,
    };
    request.media.producerCapabilities = [source, consumer];
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        id: "upstream",
        role: "opaque-source",
        bindings: [],
        output: {
          mediaTypes: ["application/octet-stream"],
          minimumCount: 1,
          maximumCount: 4,
          raster: null,
        },
      }),
      mediaIntent({
        id: "downstream",
        role: "opaque-bundle",
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: [], inputIntentIds: ["upstream"] },
          ],
        },
        output: {
          mediaTypes: ["application/octet-stream"],
          minimumCount: 1,
          maximumCount: 1,
          raster: null,
        },
      }),
    ];
    const result = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
      mediaPlanning: {
        assetBindings: [],
        producerCapabilities: [source, consumer],
        reviewRules: [],
      },
    });
    const upstream = result.objective.workItems.find(
      (item) =>
        item.deliverable.kind === "asset-production" && item.deliverable.intent.id === "upstream",
    );
    expect(upstream?.deliverable).toMatchObject({
      activationSelection: { minimumCount: 2, maximumCount: 4 },
    });
  });

  it("rejects an empty activation-selection intersection across consumers", () => {
    const request = semanticRequest();
    const source = {
      id: "selection-source",
      capabilityDigest: "6".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [],
      roles: ["selection-source"],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["application/octet-stream"],
      maximumCount: 4,
      raster: null,
    };
    const consumer = (id: string, role: string, minimumCount: number, maximumCount: number) => ({
      id,
      capabilityDigest: compilerEvalDigest(id),
      ...privateUnknownOutput,
      inputRoles: [
        {
          id: "source",
          mediaTypes: ["application/octet-stream"],
          minimumCount,
          maximumCount,
          semantics: "source",
        },
      ],
      roles: [role],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["application/octet-stream"],
      maximumCount: 1,
      raster: null,
    });
    request.media.producerCapabilities = [
      source,
      consumer("select-one", "one-consumer", 1, 1),
      consumer("select-two", "two-consumer", 2, 4),
    ];
    const producedFrom = (id: string, role: string) =>
      mediaIntent({
        id,
        role,
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: [], inputIntentIds: ["upstream"] },
          ],
        },
        output: {
          mediaTypes: ["application/octet-stream"],
          minimumCount: 1,
          maximumCount: 1,
          raster: null,
        },
      });
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        id: "upstream",
        role: "selection-source",
        bindings: [],
        output: {
          mediaTypes: ["application/octet-stream"],
          minimumCount: 1,
          maximumCount: 4,
          raster: null,
        },
      }),
      producedFrom("consumer-one", "one-consumer"),
      producedFrom("consumer-two", "two-consumer"),
    ];
    expect(codes(request, proposal)).toContainEqual(
      expect.objectContaining({
        code: "incompatible-media-output",
        itemId: "upstream",
        observed: { minimumCount: 2, maximumCount: 1 },
      }),
    );
  });

  it("rejects a raster minimum beyond the producer's declared bound", () => {
    const request = semanticRequest();
    request.media.producerCapabilities = [
      {
        id: "small-raster-producer",
        capabilityDigest: "3".repeat(64),
        ...privateUnknownOutput,
        inputRoles: [],
        roles: ["layout-reference"],
        purposes: ["implementation-reference"],
        mediaTypes: ["image/png"],
        maximumCount: 4,
        raster: {
          maximumWidth: 1024,
          maximumHeight: 1024,
          supportsAlpha: true,
          supportsAnimation: false,
        },
      },
    ];
    const proposal = semanticProposal(request);
    const intent = mediaIntent();
    proposal.mediaIntents = [
      mediaIntent({
        output: {
          ...intent.output,
          raster: { ...intent.output.raster!, minimumWidth: 2048, maximumWidth: null },
        },
      }),
    ];

    expect(codes(request, proposal)).toContainEqual(
      expect.objectContaining({
        code: "incompatible-media-output",
        itemId: "primary-media",
      }),
    );
  });

  it("reports a structured cycle when derived media ordering closes a dependency loop", () => {
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", "src/item-1.ts", "src/item-2.ts"],
    });
    const request = semanticRequest(pinned);
    const capability = {
      id: "raster-producer",
      capabilityDigest: "4".repeat(64),
      ...privateUnknownOutput,
      inputRoles: [
        {
          id: "source",
          mediaTypes: ["image/png" as const],
          minimumCount: 1,
          maximumCount: 1,
          semantics: "directional-reference",
        },
      ],
      roles: ["layout-reference" as const],
      purposes: ["implementation-reference" as const],
      mediaTypes: ["image/png" as const],
      maximumCount: 4,
      raster: {
        maximumWidth: 2048,
        maximumHeight: 2048,
        supportsAlpha: true,
        supportsAnimation: false,
      },
    };
    request.media.producerCapabilities = [capability];
    const proposal = semanticProposal(request);
    proposal.mediaIntents = [
      mediaIntent({
        id: "cycle-a",
        bindings: [],
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: [], inputIntentIds: ["cycle-b"] },
          ],
        },
      }),
      mediaIntent({
        id: "cycle-b",
        bindings: [],
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: [], inputIntentIds: ["cycle-a"] },
          ],
        },
      }),
    ];
    expect(
      parseAndValidateCompilerProposal(request, proposal, {
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
        mediaPlanning: {
          assetBindings: [],
          producerCapabilities: [capability],
          reviewRules: [],
        },
      }).report.violations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "media-dependency-cycle",
          field: "/mediaIntents",
        }),
      ]),
    );
  });

  it("rejects provider and storage authority smuggled into a media intent", () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request) as unknown as {
      mediaIntents: Array<Record<string, unknown>>;
    };
    proposal.mediaIntents = [{ ...mediaIntent(), provider: "invented-provider" }];
    expect(codes(request, proposal)).toContainEqual(
      expect.objectContaining({ code: "schema-invalid", field: "/mediaIntents/0" }),
    );
  });

  it("canonicalizes intent, import, media, binding, and criterion order", () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request, 2);
    proposal.mediaIntents = [
      mediaIntent({
        id: "z-intent",
        necessity: "helpful",
        obligationIds: ["explicit-contract"],
        output: { ...mediaIntent().output, mediaTypes: ["image/webp", "image/png"] },
        bindings: [
          { workItemId: "item-2", direction: "input-to", criterionIds: ["implemented"] },
          { workItemId: "item-1", direction: "input-to", criterionIds: [] },
        ],
      }),
      mediaIntent({ id: "a-intent", necessity: "helpful" }),
    ];
    const parsed = parseAndValidateCompilerProposal(request, proposal);
    expect(parsed.report.status).toBe("valid");
    if (parsed.proposal?.kind !== "work-items") throw new Error("expected Work Item proposal");
    expect(parsed.proposal.mediaIntents.map(({ id }) => id)).toEqual(["a-intent", "z-intent"]);
    expect(parsed.proposal.mediaIntents[1]!.output.mediaTypes).toEqual(["image/png", "image/webp"]);
    expect(parsed.proposal.mediaIntents[1]!.bindings.map(({ workItemId }) => workItemId)).toEqual([
      "item-1",
      "item-2",
    ]);
  });
});

function deferredFixture() {
  const allowed = ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"];
  const pinned = semanticPinnedFacts({ paths: ["README.md"], scripts: {} });
  const request = semanticRequest(pinned, allowed);
  const adapter = request.repository.toolchains.find(
    (entry) => entry.adapterId === "node-npm" && entry.state === "eligible-deferred",
  )!;
  const evidence = (key: string) => {
    const operation = parseCompilerOperation(adapter.adapterId, `npm run ${key}`);
    if (!operation) throw new Error(`fixture operation is invalid: ${key}`);
    return { kind: "deferred" as const, adapterId: adapter.adapterId, operation };
  };
  const item = (
    id: string,
    scope: string[],
    dependsOn: string[],
    key = "test",
  ): CompilerProposal["workItems"][number] => ({
    id,
    title: `Implement ${id}`,
    goal: `Deliver ${id}.`,
    obligationIds: id === "provider" ? ["explicit-contract"] : [],
    criteria: [
      {
        id: "validated",
        text: `${id} is tested.`,
        risk: "ordinary",
        validation: [{ tier: "mechanical", evidence: [evidence(key)] }],
      },
    ],
    scope,
    preconditions: [],
    outOfScope: [],
    conventions: [],
    dependsOn,
    exclusiveResources: [],
    executionIntent: {
      estimatedDurationMinutes: 10,
      additionalTools: [],
      services: [],
      additionalNetworkDestinations: [],
      trust: "isolated",
    },
  });
  return { request, pinned, adapter, evidence, item };
}

describe("deferred capability provider validation", () => {
  it("accepts one provider and transitive descendants", () => {
    const { request, item } = deferredFixture();
    const proposal: CompilerProposal = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "work-items",
      mediaIntents: [],
      workItems: [
        item("provider", ["package.json", "package-lock.json"], []),
        item("child", ["src/child.ts"], ["provider"]),
        item("descendant", ["src/descendant.ts"], ["child"]),
      ],
    };
    expect(parseAndValidateCompilerProposal(request, proposal).report.status).toBe("valid");
  });

  it("accepts a later generation that owns generation authority and supersedes its ancestor", () => {
    const { request, item } = deferredFixture();
    const later = item("later", ["package.json"], ["provider"]);
    const proposal: CompilerProposal = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "work-items",
      mediaIntents: [],
      workItems: [
        item("provider", ["package.json", "package-lock.json"], []),
        later,
        item("consumer", ["src/consumer.ts"], ["later"]),
      ],
    };
    expect(parseAndValidateCompilerProposal(request, proposal).report.status).toBe("valid");
  });

  it.each([
    {
      name: "missing",
      build: (item: ReturnType<typeof deferredFixture>["item"]) => [
        { ...item("consumer", ["src/consumer.ts"], []), obligationIds: ["explicit-contract"] },
      ],
      code: "missing-capability-provider",
      itemId: "consumer",
    },
    {
      name: "non-ancestor",
      build: (item: ReturnType<typeof deferredFixture>["item"]) => [
        item("provider", ["package.json", "package-lock.json"], []),
        item("consumer", ["src/consumer.ts"], []),
      ],
      code: "non-ancestor-capability-provider",
      itemId: "consumer",
    },
    {
      name: "ambiguous",
      build: (item: ReturnType<typeof deferredFixture>["item"]) => [
        item("provider", ["package.json", "package-lock.json"], []),
        { ...item("provider-two", ["package.json", "package-lock.json"], []), obligationIds: [] },
        item("consumer", ["src/consumer.ts"], ["provider", "provider-two"]),
      ],
      code: "ambiguous-capability-provider",
      itemId: "consumer",
    },
  ])("classifies a $name provider exactly", ({ build, code, itemId }) => {
    const { request, item } = deferredFixture();
    const proposal: CompilerProposal = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "work-items",
      mediaIntents: [],
      workItems: build(item),
    };
    expect(codes(request, proposal)).toContainEqual(
      expect.objectContaining({ code, itemId, field: "/workItems" }),
    );
  });

  it("accepts 32 graph-wide finite operations and rejects the 33rd", () => {
    const { request, pinned, item } = deferredFixture();
    const provider = item("provider", ["package.json", "package-lock.json"], []);
    const consumers = Array.from({ length: 32 }, (_, index) =>
      item(
        `consumer-${index + 1}`,
        [`src/consumer-${index + 1}.ts`],
        ["provider"],
        `check-${index + 2}`,
      ),
    );
    const proposal: CompilerProposal = {
      protocol: "clockgrove.factory/compiler-proposal",
      kind: "work-items",
      mediaIntents: [],
      workItems: [provider, ...consumers],
    };
    const boundary = structuredClone(proposal);
    boundary.workItems.pop();
    expect(parseAndValidateCompilerProposal(request, boundary).report.status).toBe("valid");
    expect(() =>
      projectCompilerProposal({
        request,
        proposal: boundary,
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }),
    ).not.toThrow();
    expect(codes(request, proposal)).toContainEqual(
      expect.objectContaining({
        code: "operation-count-limit",
        field: "/workItems",
        expected: 32,
        observed: 33,
      }),
    );
  });

  it("rejects more than one command on a selected provider before projection", () => {
    const { request, item, evidence } = deferredFixture();
    const provider = item("provider", ["package.json", "package-lock.json"], []);
    provider.criteria.push({
      id: "second-operation",
      text: "A second provider operation is validated.",
      risk: "ordinary",
      validation: [{ tier: "mechanical", evidence: [evidence("check")] }],
    });
    expect(
      codes(request, {
        protocol: "clockgrove.factory/compiler-proposal",
        kind: "work-items",
        mediaIntents: [],
        workItems: [provider],
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: "operation-count-limit",
        itemId: "provider",
        expected: { min: 1, max: 1 },
        observed: 2,
      }),
    );
  });
});

describe("deterministic semantic projection", () => {
  it("validates and projects against the same policy-grounded execution envelope", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    request.constraints.workItemTimeoutMinutes = 7;
    const runPolicy = structuredClone(projectionPolicy(request));
    runPolicy.capacity!.local!.defaultCpu = 3;
    runPolicy.capacity!.local!.defaultMemoryMb = 4_096;

    expect(
      parseAndValidateCompilerProposal(request, proposal, { pinnedFacts: pinned, runPolicy }).report
        .status,
    ).toBe("valid");
    expect(
      projectCompilerProposal({ request, proposal, pinnedFacts: pinned, runPolicy }).objective
        .workItems[0]!.requirements,
    ).toMatchObject({ cpu: 3, memoryMb: 4_096, timeoutMinutes: 7 });
  });

  it("combines adapter requirements with model-owned non-derivable execution intent", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned, ["api.example.com"]);
    const proposal = semanticProposal(request);
    proposal.workItems[0]!.executionIntent = {
      estimatedDurationMinutes: 20,
      additionalTools: ["ffmpeg"],
      services: ["postgresql"],
      additionalNetworkDestinations: ["api.example.com"],
      trust: "trusted_local",
    };
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(projected.objective.workItems[0]!.requirements).toMatchObject({
      trust: "trusted_local",
      tools: ["ffmpeg", "node", "npm"],
      services: ["postgresql"],
      networkDestinations: ["api.example.com"],
    });
  });

  it("preserves semantic ownership while deriving mechanics and only adding serialization edges", () => {
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", "src/shared.ts", "src/other.ts"],
    });
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 2);
    proposal.workItems[0]!.scope = ["src/shared.ts"];
    proposal.workItems[0]!.exclusiveResources = ["emulator:android"];
    proposal.workItems[0]!.criteria[0]!.text = "A credential is never exposed.";
    proposal.workItems[1]!.scope = ["src/shared.ts"];
    proposal.workItems[1]!.dependsOn = [];
    proposal.workItems[1]!.exclusiveResources = ["emulator:android"];
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(projected.objective.workItems[0]).toMatchObject({
      title: proposal.workItems[0]!.title,
      goal: proposal.workItems[0]!.goal,
      acceptance: proposal.workItems[0]!.criteria.map((entry) => entry.text),
      scope: proposal.workItems[0]!.scope,
      preconditions: proposal.workItems[0]!.preconditions,
      outOfScope: proposal.workItems[0]!.outOfScope,
      conventions: proposal.workItems[0]!.conventions,
      baseSha: request.baseSha,
      deliverable: {
        kind: "repository-change" as const,
        contract: "clockgrove.factory/artifact" as const,
      },
    });
    expect(projected.objective.workItems[0]!.validationCommands).toEqual([
      request.repository.validationRecipes[0]!.command,
    ]);
    expect(projected.objective.workItems[0]!.requirements!.tools).toEqual(["node", "npm"]);
    expect(projected.objective.workItems[0]!.criterionRisks).toContainEqual({
      criterion: "A credential is never exposed.",
      risk: "security",
    });
    const riskElevation = [
      { itemId: "item-1", criterionId: "implemented", from: "ordinary", to: "security" },
    ];
    expect(projected.trace.riskElevations).toEqual({
      count: 1,
      digest: compilerEvalDigest(riskElevation),
    });
    expect(projected.trace.addedEdges).toEqual([
      {
        itemId: "item-2",
        dependsOn: "item-1",
        reason: "scope-overlap",
      },
    ]);
    expect(projected.objective.workItems[1]!.dependsOn).toEqual(["item-1"]);
  });

  it("records an exclusive-resource-only edge distinctly", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 2);
    proposal.workItems[0]!.exclusiveResources = ["gpu:0"];
    proposal.workItems[1]!.dependsOn = [];
    proposal.workItems[1]!.exclusiveResources = ["gpu:0"];
    const { trace } = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(trace.addedEdges).toEqual([
      {
        itemId: "item-2",
        dependsOn: "item-1",
        reason: "exclusive-resource",
      },
    ]);
  });

  it("keeps a 51-item, 64-resource serialization trace compact", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 51);
    const resources = Array.from({ length: 64 }, (_, index) => `lock:shared-${index + 1}`);
    for (const [index, item] of proposal.workItems.entries()) {
      item.scope = [`src/disjoint-${index + 1}.ts`];
      item.dependsOn = [];
      item.exclusiveResources = index < 43 ? resources : [];
    }
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(projected.trace.addedEdges.length).toBeGreaterThan(600);
    expect(projected.trace.addedEdges[0]).not.toHaveProperty("resources");
    expect(Buffer.byteLength(JSON.stringify(projected.trace))).toBeLessThan(1024 * 1024);
    expect(judgeSourceBytes(request, proposal, projected.trace)).toBeLessThan(
      MAX_COMPILER_JUDGE_SOURCE_BYTES,
    );
  });

  it("keeps a 100-item near-maximum derived-edge trace and validation record bounded", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 100);
    for (const [index, item] of proposal.workItems.entries()) {
      item.scope = [`src/disjoint-${index + 1}.ts`];
      item.dependsOn = [];
      item.exclusiveResources =
        index < 45 ? ["lock:cluster-a"] : index < 53 ? ["lock:cluster-b"] : [];
    }
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    });
    expect(projected.trace.addedEdges.length).toBeGreaterThan(700);
    expect(Buffer.byteLength(JSON.stringify(projected.trace))).toBeLessThan(1024 * 1024);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          request,
          proposal,
          report: parseAndValidateCompilerProposal(request, proposal, {
            pinnedFacts: pinned,
            runPolicy: projectionPolicy(request),
          }).report,
          projectionTrace: projected.trace,
        }),
      ),
    ).toBeLessThan(2 * 1024 * 1024);
    expect(judgeSourceBytes(request, proposal, projected.trace)).toBeLessThan(
      MAX_COMPILER_JUDGE_SOURCE_BYTES,
    );
  });

  it("rejects an otherwise projectable proposal when the exact judge source cannot fit", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    request.inventory.obligations.push(
      ...Array.from({ length: 127 }, (_, index) => ({
        id: `inferred-${index + 1}`,
        text: `${String(index + 1).padStart(3, "0")}:${"o".repeat(2_995)}`,
        kind: "prerequisite" as const,
        evidenceIds: ["objective"],
        acceptanceEvidence: `${String(index + 1).padStart(3, "0")}:${"e".repeat(2_995)}`,
      })),
    );
    const proposal = semanticProposal(request, 100);
    for (const [index, item] of proposal.workItems.entries())
      item.goal = `${String(index + 1).padStart(3, "0")}:${"g".repeat(3_880)}`;

    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(900 * 1024);
    expect(Buffer.byteLength(JSON.stringify(proposal))).toBeLessThan(512 * 1024);
    const report = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    }).report;
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        code: "judge-context-limit",
        expected: { maximumBytes: MAX_COMPILER_JUDGE_SOURCE_BYTES },
      }),
    );
  });

  it("sizes the exact post-repair derived challenges before accepting a proposal", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const inferredIds = Array.from({ length: 64 }, (_, index) => `inferred-${index}`);
    request.inventory.obligations.push(
      ...inferredIds.map((id) => ({
        id,
        kind: "prerequisite" as const,
        text: "x".repeat(4_000),
        evidenceIds: ["objective"],
        acceptanceEvidence: "y".repeat(4_000),
      })),
    );
    const proposal = semanticProposal(request, 100);
    for (const [index, item] of proposal.workItems.entries())
      item.goal = `${index}:${"g".repeat(3_280)}`;
    request.revision = 1;
    request.previousProposal = structuredClone(proposal);
    request.semanticFindings = [
      {
        id: "missing-inferences",
        dimension: "coverage",
        severity: "blocking",
        confidence: 1,
        obligationIds: inferredIds,
        itemIds: [],
        evidenceIds: ["objective"],
        rootCause: "Missing prerequisites",
        correction: "Resolve prerequisites",
        uncertainty: "",
      },
    ];

    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(900 * 1024);
    expect(Buffer.byteLength(JSON.stringify(proposal))).toBeLessThan(512 * 1024);
    const report = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    }).report;
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        code: "judge-context-limit",
        expected: { maximumBytes: MAX_COMPILER_JUDGE_SOURCE_BYTES },
      }),
    );
  });

  it("sizes all 64 independently cited late challenges with byte-identical production inputs", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    request.objective.body = "b".repeat(64_000);
    request.objective.digest = compilerEvalDigest({
      number: request.objective.number,
      title: request.objective.title,
      body: request.objective.body,
    });
    request.inventory.objectiveDigest = request.objective.digest;
    request.inventory.evidence.push(
      ...Array.from({ length: 127 }, (_, index) => ({
        id: `e-${index}`,
        kind: "repository" as const,
        identity: `identity-${index}`,
        excerpt: `${index}:` + "e".repeat(995),
      })),
    );
    request.inventory.obligations.push(
      ...Array.from({ length: 127 }, (_, index) => ({
        id: `inferred-${index}`,
        text: `${index}:` + "t".repeat(1_490),
        kind: "prerequisite" as const,
        evidenceIds: [`e-${index}`],
        acceptanceEvidence: `${index}:` + "a".repeat(1_490),
      })),
    );
    const proposal = semanticProposal(request, 100);
    for (const [index, item] of proposal.workItems.entries()) {
      item.goal = `${index}:` + "g".repeat(2_480);
      item.scope = [`src/disjoint-${index}.ts`];
      item.dependsOn = [];
    }
    request.revision = 1;
    request.previousProposal = semanticProposal(request);
    request.semanticFindings = Array.from({ length: 64 }, (_, index) => ({
      id: `finding-${index}`,
      dimension: "coverage" as const,
      severity: "blocking" as const,
      confidence: 1,
      obligationIds: [`inferred-${index}`],
      itemIds: ["item-1"],
      evidenceIds: request.inventory.evidence.map((entry) => entry.id),
      rootCause: `Missing inference ${index}`,
      correction: `Resolve inference ${index}`,
      uncertainty: "",
    }));
    const trace = {
      protocol: "clockgrove.factory/compiler-projection" as const,
      requestDigest: compilerEvalDigest(request),
      proposalDigest: compilerEvalDigest(proposal),
      graphDigest: "2".repeat(64),
      addedEdges: [],
      adapterBindings: [],
      mediaIntents: [],
      riskElevations: { count: 0, digest: compilerEvalDigest([]) },
    };
    const challenges = deriveCompilerInferenceChallenges({
      inventory: request.inventory,
      findings: request.semanticFindings,
      proposal,
      carried: request.challenges,
    });
    const sourceBytes = (effectiveChallenges: typeof challenges) =>
      compilerJudgeSourceBytes({
        originalObjective: request.objective,
        baseSha: request.baseSha,
        priorCompilationFailure: { reason: "x".repeat(8_000), rawProposalAvailable: false },
        inventory: request.inventory,
        challenges: effectiveChallenges,
        proposal,
        projectionTrace: trace,
        draftDigest: trace.graphDigest,
        inventoryDigest: compilerEvalDigest(request.inventory),
      });
    expect(challenges).toHaveLength(64);
    expect(sourceBytes([])).toBeLessThan(MAX_COMPILER_JUDGE_SOURCE_BYTES);
    expect(sourceBytes(challenges)).toBeGreaterThan(MAX_COMPILER_JUDGE_SOURCE_BYTES);
    expect(sourceBytes(challenges)).toBeGreaterThan(960_000);
    expect(
      parseAndValidateCompilerProposal(request, proposal, {
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }).report.violations,
    ).toContainEqual(expect.objectContaining({ code: "judge-context-limit" }));
  });

  it("reports independent dependency, packet, graph, and judge envelope failures together", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 52);
    const rootScopes = Array.from({ length: 51 }, (_, index) => `src/root-${index + 1}.ts`);
    for (const [index, item] of proposal.workItems.entries()) {
      item.dependsOn = [];
      item.scope = index < 51 ? [rootScopes[index]!] : rootScopes;
      item.criteria = Array.from({ length: 10 }, (_, criterionIndex) => ({
        id: `criterion-${criterionIndex + 1}`,
        text: `${item.id}-${criterionIndex + 1}:${"c".repeat(1_780)}`,
        risk: "ordinary" as const,
        validation: [
          {
            tier: "mechanical" as const,
            evidence: [
              {
                kind: "observed" as const,
                recipeId: request.repository.validationRecipes[0]!.id,
              },
            ],
          },
        ],
      }));
    }
    proposal.workItems[0]!.preconditions = Array.from({ length: 64 }, () => "p".repeat(2_000));
    proposal.workItems[0]!.outOfScope = Array.from({ length: 64 }, () => "o".repeat(2_000));

    const report = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    }).report;
    expect(report.violations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "dependency-limit",
        "worker-packet-limit",
        "compiled-graph-limit",
        "judge-context-limit",
      ]),
    );
  });

  it("reports an independent oversized packet when another item blocks graph projection", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request, 2);
    proposal.workItems[0]!.dependsOn = ["unknown-item"];
    proposal.workItems[1]!.preconditions = Array.from({ length: 64 }, () => "p".repeat(2_000));
    proposal.workItems[1]!.outOfScope = Array.from({ length: 64 }, () => "o".repeat(2_000));

    const first = parseAndValidateCompilerProposal(request, proposal, {
      pinnedFacts: pinned,
      runPolicy: projectionPolicy(request),
    }).report;
    expect(first.violations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["unknown-dependency", "worker-packet-limit", "projection-blocked"]),
    );

    proposal.workItems[0]!.dependsOn = [];
    proposal.workItems[1]!.preconditions = [];
    proposal.workItems[1]!.outOfScope = [];
    expect(
      parseAndValidateCompilerProposal(request, proposal, {
        pinnedFacts: pinned,
        runPolicy: projectionPolicy(request),
      }).report.status,
    ).toBe("valid");
  });
});

describe("shared bounded graph analysis", () => {
  it.each([
    [
      "multiple roots",
      [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: [] },
      ],
      ["a", "b"],
    ],
    [
      "fan-out",
      [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a"] },
      ],
      ["a", "b", "c"],
    ],
    [
      "join",
      [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: [] },
        { id: "c", dependsOn: ["a", "b"] },
      ],
      ["a", "b", "c"],
    ],
    [
      "diamond",
      [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a"] },
        { id: "d", dependsOn: ["b", "c"] },
      ],
      ["a", "b", "c", "d"],
    ],
  ] as const)("returns stable order and ancestors for %s", (_name, items, order) => {
    const analysis = analyzeDependencies(items);
    expect(analysis.order).toEqual(order);
    expect(analysis.cycleItems).toEqual([]);
  });

  it("handles the 100-item long-chain bound deterministically", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${String(index + 1).padStart(3, "0")}`,
      dependsOn: index === 0 ? [] : [`item-${String(index).padStart(3, "0")}`],
    }));
    const analysis = analyzeDependencies([...items].reverse());
    expect(analysis.order).toEqual(items.map((entry) => entry.id));
    expect(analysis.ancestors.get("item-100")?.size).toBe(99);
    expect(analysis.hasPath("item-100", "item-001")).toBe(true);
  });

  it("uses sorted scope-prefix and resource maps without duplicate pairs", () => {
    expect(
      overlappingScopePairs([
        { id: "b", scope: ["src/a.ts", "src/"] },
        { id: "a", scope: ["src/a.ts"] },
      ]),
    ).toEqual([["a", "b"]]);
    expect(
      exclusiveResourcePairs([
        { id: "b", exclusiveResources: ["gpu:0", "gpu:0"] },
        { id: "a", exclusiveResources: ["gpu:0"] },
      ]),
    ).toEqual([{ left: "a", right: "b", resources: ["gpu:0"] }]);
  });

  it("does not let case-distinct Linux paths hide a later prefix overlap", () => {
    expect(
      overlappingScopePairs([
        { id: "lower-root", scope: ["a/"] },
        { id: "upper-root", scope: ["A/"] },
        { id: "lower-child", scope: ["a/x"] },
      ]),
    ).toEqual([["lower-child", "lower-root"]]);
  });
});
