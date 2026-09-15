import { describe, expect, it } from "vitest";

import type { CompilerProposal, CompilerRequest } from "../src/compiler/contracts.js";
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

function codes(request: CompilerRequest, proposal: unknown) {
  return parseAndValidateCompilerProposal(request, proposal).report.violations.map((entry) => ({
    code: entry.code,
    itemId: entry.itemId,
    field: entry.field,
    expected: entry.expected,
    observed: entry.observed,
  }));
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

  it.each(["trust", "additionalTools", "services", "additionalNetworkDestinations"])(
    "rejects model-authored operational authority through %s",
    (field) => {
      const request = semanticRequest();
      const proposal = structuredClone(semanticProposal(request)) as unknown as {
        workItems: Array<{ executionIntent: Record<string, unknown> }>;
      };
      proposal.workItems[0]!.executionIntent[field] = field === "trust" ? "trusted_local" : [];
      expect(codes(request, proposal)).toContainEqual(
        expect.objectContaining({
          code: "schema-invalid",
          field: "/workItems/0/executionIntent",
        }),
      );
    },
  );
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
    },
  });
  return { request, pinned, adapter, evidence, item };
}

describe("deferred capability provider validation", () => {
  it("accepts one provider and transitive descendants", () => {
    const { request, item } = deferredFixture();
    const proposal: CompilerProposal = {
      protocol: "clockgrove.factory/compiler-proposal",
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
        runPolicy: DEFAULT_RUN_POLICY,
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
      codes(request, { protocol: "clockgrove.factory/compiler-proposal", workItems: [provider] }),
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
  it("derives execution trust from policy and admits no model-authored tools or services", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const projected = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: { ...DEFAULT_RUN_POLICY, trust: "sandbox_untrusted" },
    });
    expect(projected.objective.workItems[0]!.requirements).toMatchObject({
      trust: "isolated",
      tools: ["node", "npm"],
      services: [],
      networkDestinations: [],
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
      runPolicy: DEFAULT_RUN_POLICY,
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
      artifactContract: "clockgrove.factory/artifact-v1",
    });
    expect(projected.objective.workItems[0]!.validationCommands).toEqual([
      request.repository.validationRecipes[0]!.command,
    ]);
    expect(projected.objective.workItems[0]!.requirements!.tools).toEqual(["node", "npm"]);
    expect(projected.objective.workItems[0]!.criterionRisks).toContainEqual({
      criterion: "A credential is never exposed.",
      risk: "security",
    });
    expect(projected.trace.riskElevations).toEqual([
      { itemId: "item-1", criterionId: "implemented", from: "ordinary", to: "security" },
    ]);
    expect(projected.trace.addedEdges).toEqual([
      {
        itemId: "item-2",
        dependsOn: "item-1",
        reason: "scope-overlap",
        resources: ["emulator:android"],
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
      runPolicy: DEFAULT_RUN_POLICY,
    });
    expect(trace.addedEdges).toEqual([
      {
        itemId: "item-2",
        dependsOn: "item-1",
        reason: "exclusive-resource",
        resources: ["gpu:0"],
      },
    ]);
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
});
