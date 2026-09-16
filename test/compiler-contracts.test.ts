import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPILER_PROPOSAL_JSON_SCHEMA,
  COMPILER_REQUEST_JSON_SCHEMA,
  CompilerProposalSchema,
  CompilerRequestSchema,
  CompilerValidationReportSchema,
  type CompilerObjectivesProposal,
  type CompilerWorkItemsProposal,
  type CompilerViolation,
} from "../src/compiler/contracts.js";
import {
  createCompilerValidationReport,
  renderCompilerValidationReport,
} from "../src/compiler/violations.js";
import {
  parseAndValidateCompilerProposal,
  validateCompilerRequest,
} from "../src/compiler/proposal.js";
import { compilerProposalPrompt } from "../src/management/codex-cli.js";
import { readPinnedCompilerFacts } from "../src/repository-profiles/read.js";
import { compilerCapabilitiesForRepository } from "../src/toolchains/compiler-capabilities.js";
import {
  semanticPinnedFacts,
  semanticProjectionContext,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const allToolchainDestinations = ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"];
const workItemsProposal = (count = 1): CompilerWorkItemsProposal => {
  const proposal = semanticProposal(semanticRequest(), count);
  if (!("workItems" in proposal)) throw new Error("semantic fixture must return Work Items");
  return proposal;
};

describe("adapter-owned compiler capabilities", () => {
  it("retains an unrelated observed generic recipe beside unsupported provider evidence", () => {
    const fixture = (paths: string[]) =>
      semanticPinnedFacts({
        paths,
        scripts: {},
        documents: { Makefile: "test:\n\tchecker\n" },
      });
    const baseline = compilerCapabilitiesForRepository(
      fixture(["Makefile", "src/app.js"]),
      allToolchainDestinations,
    );
    const pinned = fixture(["Makefile", "src/app.js", "tools/check.rs"]);
    const request = semanticRequest(pinned);
    expect(compilerCapabilitiesForRepository(pinned, allToolchainDestinations).toolchains).toEqual(
      baseline.toolchains,
    );
    expect(
      compilerCapabilitiesForRepository(pinned, allToolchainDestinations).validationRecipes,
    ).toContainEqual(expect.objectContaining({ command: "make test", adapterId: null }));
    expect(request.repository.validationRecipes).toContainEqual(
      expect.objectContaining({ command: "make test", adapterId: null }),
    );
    expect(validateCompilerRequest(request).status).toBe("valid");
  });

  it.each([
    {
      name: "npm",
      paths: ["package.json", "package-lock.json", "src/a.ts"],
      adapterId: "node-npm",
      command: "npm run test",
    },
    {
      name: "pnpm",
      paths: ["package.json", "pnpm-lock.yaml", "src/a.ts"],
      adapterId: "node-pnpm",
      command: "pnpm run test",
    },
    {
      name: "Bun",
      paths: ["package.json", "bun.lock", "src/a.ts"],
      adapterId: "javascript-bun",
      command: "bun run test",
    },
    {
      name: "uv",
      paths: ["pyproject.toml", "uv.lock", ".python-version", "pytest.ini", "src/a.py"],
      adapterId: "python-uv",
      command: "uv run --locked --no-sync python -m pytest",
    },
  ])(
    "selects $name authority and formats only its observed recipes",
    ({ paths, adapterId, command }) => {
      const scripts = adapterId === "python-uv" ? {} : { test: "runner-specific source data" };
      const pinned = semanticPinnedFacts({ paths, scripts });
      const selected = compilerCapabilitiesForRepository(pinned, allToolchainDestinations);
      expect(selected.toolchains.find((entry) => entry.adapterId === adapterId)?.state).toBe(
        "observed",
      );
      expect(selected.validationRecipes.map((entry) => entry.command)).toContain(command);
      expect(
        selected.validationRecipes
          .filter((entry) => entry.adapterId !== null)
          .every((entry) => entry.adapterId === adapterId),
      ).toBe(true);
    },
  );

  it.each([
    {
      state: "eligible-deferred",
      paths: ["README.md"],
      allowed: allToolchainDestinations,
      expected: ["eligible-deferred"],
    },
    {
      state: "partial",
      paths: ["package.json"],
      allowed: [],
      expected: ["partial", "policy-blocked"],
    },
    {
      state: "mixed",
      paths: ["package.json", "package-lock.json", "pnpm-lock.yaml"],
      allowed: [],
      expected: ["mixed", "policy-blocked"],
    },
    {
      state: "policy-blocked",
      paths: ["README.md"],
      allowed: [],
      expected: ["policy-blocked"],
    },
    {
      state: "unsupported",
      paths: ["Cargo.toml", "src/lib.rs"],
      allowed: allToolchainDestinations,
      expected: ["eligible-deferred", "unsupported"],
    },
  ])("returns canonical $state repository states", ({ paths, allowed, expected }) => {
    const selected = compilerCapabilitiesForRepository(
      semanticPinnedFacts({ paths, scripts: {} }),
      allowed,
    );
    expect([...new Set(selected.toolchains.map((entry) => entry.state))].sort()).toEqual(
      [...expected].sort(),
    );
    if (expected.includes("unsupported")) expect(selected.validationRecipes).toEqual([]);
  });

  it.each([
    ["Cargo", ["Cargo.toml", "src/lib.rs"], "rust-cargo"],
    ["Go", ["go.mod", "main.go"], "go-modules"],
    ["ambient Python", ["requirements.txt", "app.py"], "python-uv"],
  ])("keeps %s outside bootstrap authority", (_name, paths, adapterId) => {
    const selected = compilerCapabilitiesForRepository(
      semanticPinnedFacts({ paths, scripts: {} }),
      allToolchainDestinations,
    );
    expect(selected.validationRecipes).toEqual([]);
    expect(selected.toolchains).toContainEqual(
      expect.objectContaining({ adapterId, state: "unsupported" }),
    );
    expect(selected.toolchains).toContainEqual(
      expect.objectContaining({ state: "eligible-deferred" }),
    );
  });

  it("does not leak unsupported commands beside an observed supported adapter", () => {
    const selected = compilerCapabilitiesForRepository(
      semanticPinnedFacts({
        paths: ["package.json", "package-lock.json", "Cargo.toml", "src/lib.rs", "README.md"],
        scripts: { test: "node --test" },
        documents: {
          "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
          "README.md": "Run `cargo test`, `go test ./...`, or `python -m pytest`.",
        },
      }),
      allToolchainDestinations,
    );
    expect(selected.validationRecipes.map((entry) => entry.command)).toEqual([
      "npm run test",
      "node --test",
    ]);
  });

  it("uses the runtime policy matcher for wildcard and case-insensitive destinations", () => {
    const selected = compilerCapabilitiesForRepository(
      semanticPinnedFacts({ paths: ["README.md"], scripts: {} }),
      ["*.NPMJS.ORG", "PYPI.ORG", "FILES.PYTHONHOSTED.ORG"],
    );
    expect(selected.toolchains.find((entry) => entry.adapterId === "node-npm")?.state).toBe(
      "eligible-deferred",
    );
    expect(selected.toolchains.some((entry) => entry.state === "policy-blocked")).toBe(false);
  });

  it("keeps the generic compiler prompt free of adapter implementation prose", () => {
    const prompt = compilerProposalPrompt.toString();
    for (const literal of [
      /\bnpm\b/i,
      /\bpnpm\b/i,
      /\bbun\b/i,
      /\buv\b/i,
      /registry/i,
      /lockfile/i,
      /runtime[- ]pin/i,
    ])
      expect(prompt).not.toMatch(literal);
  });
});

describe("strict semantic compiler contracts", () => {
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
  const jsonProviderProposal = ajv.compile(COMPILER_PROPOSAL_JSON_SCHEMA);
  const providerEnvelope = (value: Record<string, unknown>) => ({
    protocol: value.protocol,
    kind: value.kind,
    workItems: [],
    mediaIntents: [],
    objectives: [],
    coverage: [],
    triggers: [],
    requirements: [],
    ...value,
  });
  const jsonProposal = (value: unknown) =>
    jsonProviderProposal(providerEnvelope(value as Record<string, unknown>));
  const jsonRequest = ajv.compile(COMPILER_REQUEST_JSON_SCHEMA);

  it.each([
    { status: "valid", violations: [{ code: "unknown-dependency" }] },
    { status: "repairable", violations: [] },
    { status: "unsatisfiable", violations: [] },
    { status: "repairable", violations: [{ code: "unsupported-toolchain" }] },
  ])("rejects non-canonical validation report %#", ({ status, violations }) => {
    expect(
      CompilerValidationReportSchema.safeParse({
        protocol: "clockgrove.factory/compiler-validation",
        phase: "request",
        status,
        violations: violations.map(({ code }) => ({
          code,
          itemId: null,
          field: "/repository",
          expected: "supported",
          observed: "unsupported",
        })),
      }).success,
    ).toBe(false);
  });

  it("keeps strict Zod and JSON schemas in parity for valid and invalid boundaries", () => {
    const request = semanticRequest();
    const proposal = workItemsProposal();
    const invalidProposal = structuredClone(proposal) as Record<string, unknown>;
    (invalidProposal.workItems as Array<Record<string, unknown>>)[0]!.scope = ["src/[glob].ts"];
    const invalidRequest = structuredClone(request) as Record<string, unknown>;
    invalidRequest.unexpected = true;
    const multiPointer = structuredClone(request);
    multiPointer.validationReport = createCompilerValidationReport("proposal", [
      {
        code: "unknown-dependency",
        itemId: "item-1",
        field: "/workItems/0/dependsOn/0",
        expected: [],
        observed: "missing",
      },
    ]);
    for (const [zod, json, value, accepted] of [
      [CompilerProposalSchema, jsonProposal, proposal, true],
      [CompilerProposalSchema, jsonProposal, invalidProposal, false],
      [CompilerRequestSchema, jsonRequest, request, true],
      [CompilerRequestSchema, jsonRequest, invalidRequest, false],
      [CompilerRequestSchema, jsonRequest, multiPointer, true],
    ] as const) {
      expect(zod.safeParse(value).success).toBe(accepted);
      expect(json(value)).toBe(accepted);
    }
  });

  it("accepts each strict canonical proposal variant with a required discriminator", () => {
    const workItems = workItemsProposal();
    expect(CompilerProposalSchema.parse(workItems)).toMatchObject({ kind: "work-items" });
    expect(jsonProposal(workItems), JSON.stringify(jsonProviderProposal.errors)).toBe(true);
    expect(
      parseAndValidateCompilerProposal(semanticRequest(), providerEnvelope(workItems)).proposal,
    ).toEqual(workItems);
    const providerWithLegacyField = {
      ...providerEnvelope(workItems),
      version: "v1",
    };
    expect(
      parseAndValidateCompilerProposal(semanticRequest(), providerWithLegacyField).proposal,
    ).toBeUndefined();
    const missingKind = structuredClone(workItems) as Record<string, unknown>;
    delete missingKind.kind;
    expect(CompilerProposalSchema.safeParse(missingKind).success).toBe(false);
    expect(
      parseAndValidateCompilerProposal(semanticRequest(), missingKind).proposal,
    ).toBeUndefined();

    const trigger = {
      code: "work-item-threshold" as const,
      source: "projected-graph" as const,
      availability: "estimated" as const,
      observed: 72,
      threshold: 50,
      obligationIds: ["explicit-contract"],
      explanation: "The projected graph exceeds the configured planning threshold.",
    };
    const objective = (id: string, prerequisiteOutputs: Array<Record<string, string>> = []) => ({
      id,
      title: `Deliver ${id}`,
      outcome: `${id} is independently acceptable.`,
      acceptance: [
        {
          id: `${id}-complete`,
          kind: id === "foundation" ? ("owned" as const) : ("aggregate-integration" as const),
          text: `${id} has its expected behavior.`,
        },
      ],
      ownedScope: [`src/${id}.ts`],
      obligationIds: id === "foundation" ? ["explicit-contract"] : [],
      planningEstimate: {
        workItems: 12,
        criticalPathMinutes: null,
        aggregateWorkMinutes: null,
        basis: `${id} is bounded to one independently accepted output.`,
      },
      outputs: [
        {
          id: `${id}-change`,
          description: `${id} is integrated.`,
          completionAcceptanceIds: [`${id}-complete`],
        },
      ],
      prerequisiteOutputs,
    });
    const objectives = {
      protocol: "clockgrove.factory/compiler-proposal" as const,
      kind: "objectives" as const,
      objectives: [
        objective("foundation"),
        objective("consumer", [{ objectiveId: "foundation", outputId: "foundation-change" }]),
      ],
      coverage: [
        {
          obligationId: "explicit-contract",
          disposition: "aggregate-integration" as const,
          objectiveId: "consumer",
          acceptanceId: "consumer-complete",
        },
      ],
      triggers: [trigger],
    };
    const clarification = {
      protocol: "clockgrove.factory/compiler-proposal" as const,
      kind: "clarification" as const,
      requirements: [
        {
          id: "target-platform",
          question: "Which supported target platform must own the deployment output?",
          reason: "The requested authorization boundary cannot be inferred from repository facts.",
          obligationIds: ["explicit-contract"],
        },
      ],
      triggers: [{ ...trigger, code: "authorization-boundary" as const, observed: null }],
    };

    for (const value of [objectives, clarification]) {
      expect(CompilerProposalSchema.safeParse(value).success).toBe(true);
      expect(jsonProposal(value), JSON.stringify(jsonProviderProposal.errors)).toBe(true);
    }

    const thresholdRequest = semanticRequest();
    thresholdRequest.constraints.planningWorkItemThreshold = 24;
    const boundedObjectives = structuredClone(objectives);
    boundedObjectives.triggers[0]!.threshold = 24;
    boundedObjectives.triggers[0]!.observed = 101;
    expect(
      parseAndValidateCompilerProposal(thresholdRequest, providerEnvelope(boundedObjectives)).report
        .status,
    ).toBe("valid");

    const oversizedObjective = structuredClone(boundedObjectives);
    oversizedObjective.objectives[0]!.planningEstimate.workItems = 25;
    expect(
      parseAndValidateCompilerProposal(thresholdRequest, providerEnvelope(oversizedObjective))
        .report.violations,
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid-objective-bound",
        itemId: "foundation",
        field: "/objectives/0/planningEstimate",
      }),
    );

    const contradictoryObjective = structuredClone(boundedObjectives) as CompilerObjectivesProposal;
    contradictoryObjective.objectives[0]!.planningEstimate.criticalPathMinutes = 20;
    contradictoryObjective.objectives[0]!.planningEstimate.aggregateWorkMinutes = 10;
    expect(
      parseAndValidateCompilerProposal(thresholdRequest, providerEnvelope(contradictoryObjective))
        .report.violations,
    ).toContainEqual(expect.objectContaining({ code: "invalid-objective-bound" }));

    const thresholdClarification = {
      ...clarification,
      triggers: [
        {
          ...trigger,
          observed: 101,
          threshold: 24,
        },
      ],
    };
    expect(
      parseAndValidateCompilerProposal(thresholdRequest, providerEnvelope(thresholdClarification))
        .report.status,
    ).toBe("valid");
    thresholdClarification.triggers[0]!.threshold = 25;
    expect(
      parseAndValidateCompilerProposal(thresholdRequest, providerEnvelope(thresholdClarification))
        .report.violations,
    ).toContainEqual(expect.objectContaining({ code: "invalid-planning-trigger" }));

    const placeholderClarification = structuredClone(clarification);
    placeholderClarification.requirements[0]!.question = "TBD";
    placeholderClarification.requirements[0]!.reason = "placeholder";
    expect(
      parseAndValidateCompilerProposal(
        semanticRequest(),
        providerEnvelope(placeholderClarification),
      ).report.violations,
    ).toContainEqual(expect.objectContaining({ code: "invalid-clarification" }));

    const duplicateClarification = structuredClone(clarification);
    duplicateClarification.requirements.push(
      structuredClone(duplicateClarification.requirements[0]!),
    );
    expect(
      parseAndValidateCompilerProposal(semanticRequest(), providerEnvelope(duplicateClarification))
        .report.violations,
    ).toContainEqual(expect.objectContaining({ code: "duplicate-clarification-id" }));

    const unboundClarification = structuredClone(clarification);
    unboundClarification.requirements[0]!.obligationIds = [];
    expect(CompilerProposalSchema.safeParse(unboundClarification).success).toBe(false);
    const unboundTrigger = structuredClone(objectives);
    unboundTrigger.triggers[0]!.obligationIds = [];
    expect(CompilerProposalSchema.safeParse(unboundTrigger).success).toBe(false);

    const mixed = { ...objectives, workItems: workItems.workItems };
    const vagueClarification = { ...clarification, requirements: [] };
    const undersizedSplit = { ...objectives, objectives: objectives.objectives.slice(0, 1) };
    for (const value of [mixed, vagueClarification, undersizedSplit]) {
      expect(CompilerProposalSchema.safeParse(value).success).toBe(false);
      // Provider structured output cannot express cross-field discriminator constraints;
      // the canonical parser rejects them deterministically after transport validation.
      expect(jsonProposal(value)).toBe(true);
    }
  });

  it("represents unavailable duration as null without weakening the 100-item hard cap", () => {
    const proposal = workItemsProposal();
    proposal.workItems[0]!.executionIntent.estimatedDurationMinutes = null;
    expect(CompilerProposalSchema.safeParse(proposal).success).toBe(true);
    expect(jsonProposal(proposal), JSON.stringify(jsonProviderProposal.errors)).toBe(true);

    const excessive = workItemsProposal(101);
    expect(CompilerProposalSchema.safeParse(excessive).success).toBe(false);
    expect(jsonProposal(excessive)).toBe(false);
  });

  it("keeps bounded graphs on the ordinary path and detects serial planning pressure", () => {
    const request = semanticRequest();
    request.constraints.planningWorkItemThreshold = 10;
    request.constraints.planningCriticalPathMinutes = 500;
    request.constraints.planningAggregateWorkMinutes = 2_000;

    const bounded = semanticProposal(request, 2);
    for (const item of bounded.workItems) item.executionIntent.estimatedDurationMinutes = 100;
    expect(
      parseAndValidateCompilerProposal(request, bounded, semanticProjectionContext()).report.status,
    ).toBe("valid");

    const serial = semanticProposal(request, 7);
    for (const [index, item] of serial.workItems.entries()) {
      item.executionIntent.estimatedDurationMinutes = 100;
      item.dependsOn = index === 0 ? [] : [`item-${index}`];
    }
    expect(
      parseAndValidateCompilerProposal(request, serial, semanticProjectionContext()).report
        .violations,
    ).toContainEqual(
      expect.objectContaining({
        code: "objective-planning-required",
        observed: expect.objectContaining({ configuredCriticalPathMinutes: 700 }),
      }),
    );

    for (const item of serial.workItems) item.executionIntent.estimatedDurationMinutes = null;
    expect(
      parseAndValidateCompilerProposal(request, serial, semanticProjectionContext()).report.status,
    ).toBe("valid");
  });

  it("keeps every validation-report and surface cross-field refinement in JSON parity", () => {
    const request = semanticRequest();
    const violation = (code: string) => ({
      code,
      itemId: null,
      field: "/repository",
      expected: "supported",
      observed: "unsupported",
    });
    const cases: Array<{ value: typeof request; accepted: boolean }> = [];
    const withReport = (
      status: "valid" | "repairable" | "unsatisfiable",
      phase: "request" | "obligations" | "proposal",
      violations: ReturnType<typeof violation>[],
      accepted: boolean,
    ) => {
      const value = structuredClone(request);
      value.validationReport = { ...value.validationReport, status, phase, violations } as never;
      cases.push({ value, accepted });
    };
    withReport("valid", "request", [], true);
    withReport("repairable", "request", [], false);
    withReport("valid", "request", [violation("unknown-dependency")], false);
    withReport("repairable", "request", [violation("unknown-dependency")], true);
    withReport("repairable", "request", [violation("unsupported-toolchain")], false);
    withReport("unsatisfiable", "request", [violation("unsupported-toolchain")], true);
    withReport("unsatisfiable", "proposal", [violation("unknown-dependency")], false);
    withReport("unsatisfiable", "proposal", [violation("report-truncated")], true);
    withReport("repairable", "proposal", [violation("report-truncated")], true);

    const invalidSurface = structuredClone(request);
    invalidSurface.repository.validationSurfaces.visual = {
      count: 0,
      digest: "a".repeat(64),
      sample: ["src/visible.ts"],
    };
    cases.push({ value: invalidSurface, accepted: false });
    const boundedSurface = structuredClone(request);
    boundedSurface.repository.validationSurfaces.visual = {
      count: 1,
      digest: "a".repeat(64),
      sample: ["src/visible.ts"],
    };
    cases.push({ value: boundedSurface, accepted: true });

    for (const { value, accepted } of cases) {
      expect(CompilerRequestSchema.safeParse(value).success).toBe(accepted);
      expect(jsonRequest(value), JSON.stringify(jsonRequest.errors)).toBe(accepted);
    }
  });

  it.each(["service.LocalHost", "Metadata.Google.Internal"])(
    "leaves forbidden network destination %s to deterministic proposal validation",
    (destination) => {
      const proposal = workItemsProposal();
      const candidate = structuredClone(proposal) as unknown as {
        workItems: Array<{ executionIntent: { additionalNetworkDestinations: string[] } }>;
      };
      candidate.workItems[0]!.executionIntent.additionalNetworkDestinations = [destination];
      expect(CompilerProposalSchema.safeParse(candidate).success).toBe(false);
      expect(jsonProposal(candidate), JSON.stringify(jsonProviderProposal.errors)).toBe(true);
      expect(parseAndValidateCompilerProposal(semanticRequest(), candidate).report).toMatchObject({
        status: "repairable",
        violations: expect.arrayContaining([expect.objectContaining({ code: "schema-invalid" })]),
      });
    },
  );

  it.each(["foo/", "foo//bar", "foo/./bar", "foo/../bar"])(
    "leaves malformed exclusive resource %s to deterministic proposal validation",
    (resource) => {
      const candidate = semanticProposal(semanticRequest());
      candidate.workItems[0]!.exclusiveResources = [resource];
      expect(CompilerProposalSchema.safeParse(candidate).success).toBe(false);
      expect(jsonProposal(candidate), JSON.stringify(jsonProviderProposal.errors)).toBe(true);
      expect(parseAndValidateCompilerProposal(semanticRequest(), candidate).report).toMatchObject({
        status: "repairable",
        violations: expect.arrayContaining([expect.objectContaining({ code: "schema-invalid" })]),
      });
    },
  );

  it.each(["/absolute", "../secret", "src//nested.ts", "src/./nested.ts"])(
    "leaves malformed scope path %s to deterministic proposal validation",
    (scope) => {
      const candidate = semanticProposal(semanticRequest());
      candidate.workItems[0]!.scope = [scope];
      expect(CompilerProposalSchema.safeParse(candidate).success).toBe(false);
      expect(jsonProposal(candidate), JSON.stringify(jsonProviderProposal.errors)).toBe(true);
      expect(parseAndValidateCompilerProposal(semanticRequest(), candidate).report).toMatchObject({
        status: "repairable",
        violations: expect.arrayContaining([expect.objectContaining({ code: "invalid-scope" })]),
      });
    },
  );

  it("retains strict durable request validation for an embedded previous proposal", () => {
    const previousProposal = semanticProposal(semanticRequest());
    previousProposal.workItems[0]!.scope = ["../secret"];
    expect(jsonProposal(previousProposal), JSON.stringify(jsonProviderProposal.errors)).toBe(true);

    const request = semanticRequest();
    request.previousProposal = previousProposal;
    expect(CompilerRequestSchema.safeParse(request).success).toBe(false);
    expect(jsonRequest(request)).toBe(false);
  });

  it("keeps unrelated adapters eligible while rejecting exact unsupported scope", () => {
    const pinned = semanticPinnedFacts({ paths: ["go.mod", "main.go"], scripts: {} });
    const request = semanticRequest(pinned, allToolchainDestinations);
    const first = validateCompilerRequest(request);
    const second = validateCompilerRequest(structuredClone(request));
    expect(first).toEqual(second);
    expect(first.status).toBe("valid");
    const proposal = workItemsProposal();
    proposal.workItems[0]!.scope = ["main.go"];
    expect(
      parseAndValidateCompilerProposal(request, proposal, semanticProjectionContext(pinned)).report,
    ).toMatchObject({
      phase: "proposal",
      status: "repairable",
      violations: expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-toolchain",
          field: "/workItems/0/scope",
        }),
      ]),
    });
  });

  it.each([
    {
      name: "partial authority",
      paths: ["package.json"],
      expected: [
        "denied-network-destination",
        "no-validation-capability",
        "partial-toolchain-authority",
      ],
    },
    {
      name: "mixed authority",
      paths: ["package.json", "package-lock.json", "pnpm-lock.yaml"],
      expected: [
        "denied-network-destination",
        "mixed-toolchain-authority",
        "no-validation-capability",
      ],
    },
    {
      name: "policy blocked authority",
      paths: ["README.md"],
      expected: ["denied-network-destination", "no-validation-capability"],
    },
  ])("returns exact terminal codes for $name", ({ paths, expected }) => {
    const request = semanticRequest(semanticPinnedFacts({ paths, scripts: {} }), []);
    const report = validateCompilerRequest(request);
    expect(report.status).toBe("unsatisfiable");
    expect([...new Set(report.violations.map((entry) => entry.code))].sort()).toEqual(
      [...expected].sort(),
    );
    const shuffled = structuredClone(request);
    shuffled.repository.toolchains.reverse();
    shuffled.constraints.allowedNetworkDestinations.reverse();
    expect(validateCompilerRequest(shuffled)).toEqual(report);
  });

  it.each([
    ["partial", ["package.json"], "partial-toolchain-authority"],
    ["mixed", ["package.json", "package-lock.json", "pnpm-lock.yaml"], "mixed-toolchain-authority"],
  ] as const)("does not let another eligible adapter mask %s authority", (_name, paths, code) => {
    const request = semanticRequest(
      semanticPinnedFacts({ paths: [...paths], scripts: {} }),
      allToolchainDestinations,
    );
    const report = validateCompilerRequest(request);
    expect(report.status).toBe("unsatisfiable");
    expect(report.violations).toContainEqual(expect.objectContaining({ code }));
  });
});

describe("canonical compiler validation reports", () => {
  const violation = (overrides: Partial<CompilerViolation> = {}): CompilerViolation => ({
    code: "unknown-dependency",
    itemId: "item-1",
    field: "/workItems/0/dependsOn",
    expected: ["item-1"],
    observed: "missing",
    ...overrides,
  });

  it("sorts, deduplicates, classifies, and renders solely from the closed registry", () => {
    const report = createCompilerValidationReport("proposal", [
      violation({ itemId: "item-z" }),
      violation(),
      violation(),
    ]);
    expect(report.status).toBe("repairable");
    expect(report.violations.map((entry) => entry.itemId)).toEqual(["item-1", "item-z"]);
    expect(renderCompilerValidationReport(report)).toContain(
      "unknown-dependency [item-1] /workItems/0/dependsOn",
    );
    expect(JSON.stringify(report)).not.toContain("message");
    expect(JSON.stringify(report)).not.toContain("invariant");
  });

  it("bounds individual values, violation count, and complete report bytes", () => {
    const report = createCompilerValidationReport(
      "proposal",
      Array.from({ length: 140 }, (_, index) =>
        violation({
          itemId: `item-${String(index).padStart(3, "0")}`,
          field: `/workItems/${index}/dependsOn`,
          observed: "x".repeat(3_000) + index,
        }),
      ),
    );
    expect(report.violations).toHaveLength(128);
    expect(report.violations.at(-1)).toMatchObject({
      code: "report-truncated",
      observed: { totalViolations: 140 },
    });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(64 * 1024);
    expect(report.violations[0]!.observed).toMatchObject({ bounded: true, bytes: 3_003 });
  });

  it("refuses suspected secret material instead of persisting it", () => {
    expect(() =>
      createCompilerValidationReport("proposal", [
        violation({ observed: `ghp_${"s".repeat(40)}` }),
      ]),
    ).toThrow(/secret|token/i);
  });
});

describe("pinned compiler facts", () => {
  it("reads immutable manifest bytes and canonicalizes input order despite checkout disagreement", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-pinned-compiler-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: root });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await writeFile(join(root, "package-lock.json"), "{}\n");
    await writeFile(join(root, "README.md"), "Pinned\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
    const first = await readPinnedCompilerFacts(root, baseSha, [
      "README.md",
      "package-lock.json",
      "package.json",
    ]);
    const second = await readPinnedCompilerFacts(root, baseSha, [
      "package.json",
      "README.md",
      "package-lock.json",
      "package.json",
    ]);
    expect(first).toEqual(second);
    expect(first.repository.scripts).toEqual({ test: "node --test" });
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("false");
  });
});
