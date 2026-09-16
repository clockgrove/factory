import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { COMPILER_PROPOSAL_JSON_SCHEMA } from "../src/compiler/contracts.js";
import { CompilerInvariantError } from "../src/compiler/invariant-error.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import {
  managementFailureProvenance,
  managementTerminalOutcome,
  ManagementFailureCleanupError,
  ManagementOutputError,
  type ManagementBackend,
} from "../src/management/backend.js";
import {
  CodexCliManagementBackend,
  compilerProposalPrompt,
  renderCompilerProposalPrompt,
} from "../src/management/codex-cli.js";
import {
  compilePlan,
  compilePlanWithLegacyAdmission,
  structuralObjectiveInventory,
} from "../src/management/compile.js";
import type { CompilationContext } from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import {
  CompilerRequestValidationError,
  MAX_COMPILER_REQUEST_BYTES,
  parseAndValidateCompilerProposal,
  validateCompilerRequest,
} from "../src/compiler/proposal.js";
import {
  semanticPinnedFacts,
  semanticProjectionContext,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";
import {
  parseLegacyGraphConstraints,
  renderLegacyWorkItemCore,
  type LegacyGraphConstraints,
} from "../src/graph.js";

describe("single semantic management route", () => {
  it.each([
    ["generic compilePlan", false],
    ["Supervisor legacy admission compatibility", true],
  ] as const)("rejects split network authority before any %s effects", async (_name, legacy) => {
    const context: CompilationContext = {
      repository: process.cwd(),
      objective: { number: 404, title: "Reject split authority", body: "Do not dispatch." },
      defaultBranch: "main",
      baseSha: "a".repeat(40),
      repositoryFiles: [],
      allowedNetworkDestinations: [],
      runPolicy: DEFAULT_RUN_POLICY,
    };
    const legacyAdmission = vi.fn();
    const accounting = vi.fn();
    const journal = vi.fn();
    const provider = vi.fn();
    const admitCompilation = vi.fn(async () => {
      legacyAdmission();
      accounting();
      journal();
      return {
        timeoutMs: 1_000,
        modelInvocationId: "compile-test",
        checkpointProviderRefusal: async () => {},
      };
    });
    const proposePlan = vi.fn(async () => {
      provider();
      accounting();
      journal();
      throw new Error("backend reached");
    });
    const backend = { id: "arbitrary", proposePlan } as unknown as ManagementBackend;
    const checkpoint = vi.fn(async () => {
      journal();
    });

    await expect(
      legacy
        ? compilePlanWithLegacyAdmission(context, backend, checkpoint, admitCompilation)
        : compilePlan(context, backend, checkpoint, admitCompilation),
    ).rejects.toThrow("compilation context network authority differs from run policy");
    expect(legacyAdmission).not.toHaveBeenCalled();
    expect(admitCompilation).not.toHaveBeenCalled();
    expect(proposePlan).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(accounting).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("sizes a 1,151,759-byte adopted-constraint prompt before provider admission", async () => {
    const request = semanticRequest();
    const legacy: LegacyGraphConstraints = {
      protocol: "clockgrove.factory/legacy-graph-constraints-v1",
      objectiveTitle: "Adopt exact existing work",
      workItems: Array.from({ length: 10 }, (_, index) => ({
        compilerId: `adopted-${index + 1}`,
        issueNodeId: `I_${index + 1}`,
        issueNumber: index + 1,
        title: `Existing item ${index + 1}`,
        goal: `Preserve existing item ${index + 1}.`,
        acceptance: [`Existing item ${index + 1} remains exact.`],
        scope: [`legacy/item-${index + 1}.ts`],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        blockedByNumbers: [],
      })),
    };
    const targetBytes = 1_151_759;
    while (Buffer.byteLength(renderCompilerProposalPrompt(request, legacy)) < targetBytes) {
      const current = Buffer.byteLength(renderCompilerProposalPrompt(request, legacy));
      const item = legacy.workItems.find((candidate) => candidate.conventions.length < 64);
      if (!item) throw new Error("fixture exhausted valid legacy convention capacity");
      item.conventions.push("");
      const overhead = Buffer.byteLength(renderCompilerProposalPrompt(request, legacy)) - current;
      const fill = Math.min(2_000, targetBytes - current - overhead);
      if (fill < 0) throw new Error("fixture cannot reach exact prompt size");
      item.conventions[item.conventions.length - 1] = "x".repeat(fill);
    }
    const rendered = renderCompilerProposalPrompt(request, legacy);
    expect(Buffer.byteLength(rendered)).toBe(targetBytes);
    expect(
      parseLegacyGraphConstraints({
        objectiveTitle: legacy.objectiveTitle,
        workItems: legacy.workItems.map((item) => ({
          id: item.issueNodeId,
          number: item.issueNumber,
          title: item.title,
          body: renderLegacyWorkItemCore(item),
          blockedByNumbers: item.blockedByNumbers,
        })),
      }),
    ).toEqual(legacy);
    const runStructured = vi.fn();
    const admission = vi.fn();
    const backend = new CodexCliManagementBackend({ runStructured });

    expect(() => compilerProposalPrompt(request, legacy)).toThrow(
      `compiler prompt is ${targetBytes} bytes; maximum is 1048576`,
    );
    await expect(
      backend.proposePlan(request, async () => {}, semanticProjectionContext(), admission, {
        repository: process.cwd(),
        objective: request.objective,
        baseSha: request.baseSha,
        defaultBranch: "main",
        repositoryFiles: [],
        allowedNetworkDestinations: [],
        runPolicy: { ...semanticProjectionContext().runPolicy },
        legacyGraphConstraints: legacy,
      }),
    ).rejects.toThrow(`compiler prompt is ${targetBytes} bytes; maximum is 1048576`);
    expect(runStructured).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });
  it("carries lossless ordinary Objective source coverage and detects an omitted segment", () => {
    const context = {
      objective: {
        number: 404,
        title: "Add strict parsing",
        body: "Add a parser. Reject malformed input.\nAdd boundary tests.",
      },
      baseSha: "a".repeat(40),
    } as CompilationContext;
    const inventory = structuralObjectiveInventory(context);
    expect(inventory.evidence.map((entry) => entry.excerpt)).toEqual([
      "Add strict parsing",
      "Add a parser. Reject malformed input.\nAdd boundary tests.",
    ]);
    expect(inventory.obligations.map((entry) => entry.id)).not.toContain("objective-complete");

    const request = semanticRequest();
    request.objective = {
      ...context.objective,
      digest: compilerEvalDigest(context.objective),
    };
    request.inventory = inventory;
    request.inventorySource = "structural-source";
    const proposal = semanticProposal(request);
    proposal.workItems[0]!.obligationIds = inventory.obligations
      .slice(0, -1)
      .map((entry) => entry.id);
    expect(parseAndValidateCompilerProposal(request, proposal).report.violations).toContainEqual(
      expect.objectContaining({
        code: "unmapped-obligation",
        expected: inventory.obligations.at(-1)!.id,
        observed: null,
      }),
    );
  });

  it("preserves every Objective body character across bounded source segments", () => {
    const body = `  ${"a".repeat(4_100)}\r\n- keep exact spacing  `;
    const context = {
      objective: { number: 404, title: " Exact title ", body },
      baseSha: "a".repeat(40),
    } as CompilationContext;
    const inventory = structuralObjectiveInventory(context);
    expect(inventory.evidence[0]!.excerpt).toBe(context.objective.title);
    expect(
      inventory.evidence
        .slice(1)
        .map((entry) => entry.excerpt)
        .join(""),
    ).toBe(body);
    expect(inventory.evidence.every((entry) => entry.excerpt.length <= 4_000)).toBe(true);
  });

  it("keeps the maximum accepted Objective body within the inventory bound", () => {
    const body = "x".repeat(384 * 1_024);
    const inventory = structuralObjectiveInventory({
      objective: { number: 404, title: "Bounded source", body },
      baseSha: "a".repeat(40),
    } as CompilationContext);
    expect(inventory.obligations).toHaveLength(100);
    expect(
      inventory.evidence
        .slice(1)
        .map((entry) => entry.excerpt)
        .join(""),
    ).toBe(body);
  });

  it("keeps unbroken Objective text within bounded inventory fields", () => {
    const inventory = structuralObjectiveInventory({
      objective: { number: 404, title: "Bounded text", body: "x".repeat(8_001) },
      baseSha: "a".repeat(40),
    } as CompilationContext);
    expect(inventory.obligations).toHaveLength(4);
    expect(inventory.evidence.every((entry) => entry.excerpt.length <= 4_000)).toBe(true);
    expect(inventory.evidence.slice(1).map((entry) => entry.excerpt.length)).toEqual([
      4_000, 4_000, 1,
    ]);
  });

  it("keeps the maximum accepted structural Objective within the management prompt bound", () => {
    const request = semanticRequest();
    request.objective.body = "x".repeat(384 * 1_024);
    request.objective.digest = compilerEvalDigest({
      number: request.objective.number,
      title: request.objective.title,
      body: request.objective.body,
    });
    request.inventory = structuralObjectiveInventory({
      objective: {
        number: request.objective.number,
        title: request.objective.title,
        body: request.objective.body,
      },
      baseSha: request.baseSha,
    } as CompilationContext);
    request.inventorySource = "structural-source";
    expect(() => compilerProposalPrompt(request)).not.toThrow();
  });

  it("keeps 5,000 near-maximum Python paths out of request, prompt, and draft results", () => {
    const hiddenPaths = Array.from(
      { length: 5_000 },
      (_, index) => `python/${String(index).padStart(5, "0")}-${"x".repeat(470)}.py`,
    );
    const pinned = semanticPinnedFacts({
      paths: ["package.json", "package-lock.json", ...hiddenPaths],
    });
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const report = parseAndValidateCompilerProposal(request, proposal).report;
    const persistedResult = {
      request,
      proposal,
      report,
      provenance: {
        promptDigest: compilerEvalDigest(compilerProposalPrompt(request)),
        schemaDigest: compilerEvalDigest(COMPILER_PROPOSAL_JSON_SCHEMA),
        requestDigest: compilerEvalDigest(request),
        model: null,
        reasoning: null,
        baseSha: request.baseSha,
      },
    };
    expect(request.repository.pathCount).toBe(5_002);
    expect(request.repository.validationSurfaces.python).toMatchObject({
      count: 5_000,
      sample: expect.arrayContaining([hiddenPaths[0]]),
    });
    expect(request.repository.validationSurfaces.python.sample).toHaveLength(32);
    expect(JSON.stringify(request)).not.toContain(hiddenPaths.at(-1)!);
    expect(compilerProposalPrompt(request)).not.toContain(hiddenPaths.at(-1)!);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(persistedResult))).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("summarizes 257 overlapping visual and simulation paths without a request overflow", () => {
    const paths = Array.from(
      { length: 257 },
      (_, index) => `test/simulation-snapshot-${String(index).padStart(3, "0")}.png`,
    );
    const request = semanticRequest(
      semanticPinnedFacts({ paths: ["package.json", "package-lock.json", ...paths] }),
    );
    expect(request.repository.validationSurfaces.deterministicSimulation).toMatchObject({
      count: 257,
    });
    expect(request.repository.validationSurfaces.visual).toMatchObject({ count: 257 });
    expect(request.repository.validationSurfaces.deterministicSimulation.sample).toHaveLength(32);
    expect(request.repository.validationSurfaces.visual.sample).toHaveLength(32);
    expect(() => compilerProposalPrompt(request)).not.toThrow();
  });

  it("uses the identical proposal schema for initial and repair and includes inventory initially", async () => {
    const initial = semanticRequest();
    const proposal = semanticProposal(initial);
    const schemas: unknown[] = [];
    const prompts: string[] = [];
    const runStructured = vi.fn(async (_cwd, schema, prompt) => {
      schemas.push(schema);
      prompts.push(prompt);
      return { value: proposal, usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 } };
    });
    const backend = new CodexCliManagementBackend({ runStructured });
    const firstCheckpoint = vi.fn(async () => {});
    const first = await backend.proposePlan(initial, firstCheckpoint, semanticProjectionContext());
    const repair = structuredClone(initial);
    repair.revision = 1;
    repair.previousProposal = proposal;
    repair.validationReport = {
      protocol: "clockgrove.factory/compiler-validation",
      phase: "proposal",
      status: "repairable",
      violations: [
        {
          code: "unmapped-obligation",
          itemId: null,
          field: "/workItems",
          expected: "explicit-contract",
          observed: null,
        },
      ],
    };
    repair.semanticFindings = [
      {
        id: "material-coverage-gap",
        dimension: "coverage",
        severity: "blocking",
        confidence: 0.95,
        obligationIds: ["explicit-contract"],
        itemIds: [proposal.workItems[0]!.id],
        evidenceIds: ["objective"],
        rootCause: "The acceptance contract omits a required boundary behavior.",
        correction: "Add the missing boundary behavior without weakening existing coverage.",
        uncertainty: "",
      },
    ];
    const second = await backend.proposePlan(repair, async () => {}, semanticProjectionContext());
    expect(schemas).toEqual([COMPILER_PROPOSAL_JSON_SCHEMA, COMPILER_PROPOSAL_JSON_SCHEMA]);
    expect(prompts[0]).toContain(JSON.stringify(initial.inventory));
    expect(prompts[0]).toContain("complete independent obligation inventory");
    const repairEnvelope = JSON.parse(prompts[1]!.split("\n\n").at(-1)!);
    expect(repairEnvelope.previousProposal).toEqual(repair.previousProposal);
    expect(repairEnvelope.validationReport).toEqual(repair.validationReport);
    expect(repairEnvelope.semanticFindings).toEqual(repair.semanticFindings);
    expect(firstCheckpoint).toHaveBeenCalledExactlyOnceWith(first);
    expect(second.proposal).toEqual(proposal);
    expect(first.provenance.promptDigest).toBe(
      createHash("sha256").update(prompts[0]!).digest("hex"),
    );
    expect(first.provenance.schemaDigest).toBe(
      createHash("sha256").update(JSON.stringify(COMPILER_PROPOSAL_JSON_SCHEMA)).digest("hex"),
    );
  });

  it("fails closed before dispatch when projection authority is absent", async () => {
    const request = semanticRequest();
    const runStructured = vi.fn();
    const backend = new CodexCliManagementBackend({ runStructured });
    await expect(backend.proposePlan(request, async () => {}, undefined as never)).rejects.toThrow(
      "compiler projection authority is required",
    );
    expect(runStructured).not.toHaveBeenCalled();
  });

  it("rejects an oversized complete repair envelope before model admission", async () => {
    const repair = semanticRequest();
    repair.revision = 1;
    const previous = semanticProposal(repair);
    const longList = (label: string) =>
      Array.from(
        { length: 64 },
        (_, index) => `${label}-${String(index).padStart(2, "0")}-${"x".repeat(1_970)}`,
      );
    previous.workItems[0]!.goal = "g".repeat(4_000);
    previous.workItems[0]!.criteria[0]!.text = "c".repeat(2_000);
    previous.workItems[0]!.scope = Array.from(
      { length: 64 },
      (_, index) => `src/${String(index).padStart(2, "0")}-${"p".repeat(465)}.ts`,
    );
    previous.workItems[0]!.preconditions = longList("precondition");
    previous.workItems[0]!.outOfScope = longList("excluded");
    previous.workItems[0]!.conventions = longList("convention");
    repair.previousProposal = previous;
    repair.validationReport = {
      protocol: "clockgrove.factory/compiler-validation",
      phase: "proposal",
      status: "repairable",
      violations: [
        {
          code: "unmapped-obligation",
          itemId: null,
          field: "/workItems",
          expected: "explicit-contract",
          observed: null,
        },
      ],
    };
    repair.semanticFindings = Array.from({ length: 64 }, (_, index) => ({
      id: `material-gap-${index}`,
      dimension: "coverage" as const,
      severity: "blocking" as const,
      confidence: 0.95,
      obligationIds: ["explicit-contract"],
      itemIds: [previous.workItems[0]!.id],
      evidenceIds: ["objective"],
      rootCause: `root-${index}-${"r".repeat(3_970)}`,
      correction: `fix-${index}-${"f".repeat(3_970)}`,
      uncertainty: "",
    }));
    const bytes = Buffer.byteLength(JSON.stringify(repair));
    expect(bytes).toBeGreaterThan(MAX_COMPILER_REQUEST_BYTES);
    const report = validateCompilerRequest(repair);
    expect(report.violations).toContainEqual({
      code: "compiler-request-limit",
      itemId: null,
      field: "",
      expected: { maximumBytes: MAX_COMPILER_REQUEST_BYTES },
      observed: bytes,
    });
    const runStructured = vi.fn();
    const admission = vi.fn();
    const backend = new CodexCliManagementBackend({ runStructured });
    const rejection = await backend
      .proposePlan(repair, async () => {}, semanticProjectionContext(), admission)
      .catch((error) => error);
    expect(rejection).toBeInstanceOf(CompilerRequestValidationError);
    expect(rejection.report).toEqual(report);
    expect(runStructured).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });

  it("describes structural source coverage without claiming independent extraction", async () => {
    const request = semanticRequest();
    request.inventorySource = "structural-source";
    const proposal = semanticProposal(request);
    const prompts: string[] = [];
    const backend = new CodexCliManagementBackend({
      runStructured: async (_cwd, _schema, prompt) => {
        prompts.push(prompt);
        return { value: proposal, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    await backend.proposePlan(request, async () => {}, semanticProjectionContext());
    expect(prompts[0]).toContain("lossless bounded Objective source segments");
    expect(prompts[0]).not.toContain("complete independent obligation inventory");
  });

  it("persists known usage and the typed report for malformed and mechanically invalid output", async () => {
    const request = semanticRequest();
    const invalid = semanticProposal(request);
    invalid.workItems.push({ ...structuredClone(invalid.workItems[0]!), scope: ["src/other.ts"] });
    const expectedReport = parseAndValidateCompilerProposal(
      request,
      invalid,
      semanticProjectionContext(),
    ).report;
    for (const value of [{ unexpected: true }, invalid]) {
      const backend = new CodexCliManagementBackend({
        runStructured: async () => ({
          value,
          usage: { inputTokens: 7, outputTokens: 2 },
        }),
      });
      const checkpoint = vi.fn();
      const rejection = await backend
        .proposePlan(request, checkpoint, semanticProjectionContext())
        .catch((error) => error);
      expect(rejection).toBeInstanceOf(ManagementOutputError);
      expect(rejection).toMatchObject({
        usage: { inputTokens: 7, outputTokens: 2 },
        proposal: value,
      });
      expect(managementTerminalOutcome(rejection)).toEqual({
        state: "succeeded",
        usage: { inputTokens: 7, outputTokens: 2 },
      });
      expect(checkpoint).not.toHaveBeenCalled();
      if (value === invalid) expect(rejection.validationReport).toEqual(expectedReport);
    }
  });

  it("classifies structured provider failure and returned invalid usage without inventing counters", async () => {
    const request = semanticRequest();
    const providerFailure = new Error("provider unavailable");
    const failed = await new CodexCliManagementBackend({
      runStructured: async () => {
        throw providerFailure;
      },
    })
      .proposePlan(request, async () => {}, semanticProjectionContext())
      .catch((error) => error);
    expect(failed).toBe(providerFailure);
    expect(managementTerminalOutcome(failed)).toEqual({
      state: "provider-failed",
      usage: null,
    });

    const invalidUsage = await new CodexCliManagementBackend({
      runStructured: async () => ({
        value: semanticProposal(request),
        usage: { inputTokens: -1, outputTokens: 2 },
      }),
    })
      .proposePlan(request, async () => {}, semanticProjectionContext())
      .catch((error) => error);
    expect(invalidUsage).toBeInstanceOf(Error);
    expect(managementTerminalOutcome(invalidUsage)).toEqual({
      state: "invalid-response",
      usage: null,
    });
  });

  it.each([
    ["string", "provider rejected as a string"],
    ["null", null],
  ] as const)(
    "normalizes a structured %s rejection without losing its primitive cause",
    async (_name, rejection) => {
      const request = semanticRequest();
      const failed = await new CodexCliManagementBackend({
        runStructured: async () => {
          throw rejection;
        },
      })
        .proposePlan(request, async () => {}, semanticProjectionContext())
        .catch((error) => error);

      expect(failed).toBeInstanceOf(Error);
      expect(failed).toMatchObject({
        message: String(rejection),
        cause: rejection,
        provenance: {
          baseSha: request.baseSha,
          promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(managementTerminalOutcome(failed)).toEqual({
        state: "provider-failed",
        usage: null,
      });
    },
  );

  it("preserves a structured adapter's attachable rejection identity and exact fields", async () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request);
    const rejection = {
      message: "provider returned an attachable failure",
      usage: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 3 },
      proposal,
    };
    const failed = await new CodexCliManagementBackend({
      runStructured: async () => {
        throw rejection;
      },
    })
      .proposePlan(request, async () => {}, semanticProjectionContext())
      .catch((error) => error);

    expect(failed).toBe(rejection);
    expect(failed).toMatchObject({ usage: rejection.usage, proposal });
    expect(managementTerminalOutcome(failed)).toEqual({
      state: "provider-failed",
      usage: rejection.usage,
    });

    const cleanup = new ManagementFailureCleanupError(rejection, "cleanup rejected");
    expect(cleanup).toMatchObject({
      primaryError: rejection,
      usage: rejection.usage,
      proposal,
      providerDiagnostic: rejection.message,
      cleanupError: { message: "cleanup rejected", cause: "cleanup rejected" },
    });
  });

  it.each(["error", "object"] as const)(
    "preserves frozen structured %s identity through side-channel authority",
    async (kind) => {
      const request = semanticRequest();
      const rejection = Object.freeze(
        kind === "error"
          ? new Error("frozen provider failure")
          : { message: "frozen provider failure" },
      );
      const failed = await new CodexCliManagementBackend({
        runStructured: async () => {
          throw rejection;
        },
      })
        .proposePlan(request, async () => {}, semanticProjectionContext())
        .catch((error) => error);

      expect(failed).toBe(rejection);
      expect(Object.hasOwn(failed, "provenance")).toBe(false);
      expect(managementFailureProvenance(failed)).toMatchObject({
        baseSha: request.baseSha,
        promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(managementTerminalOutcome(failed)).toEqual({
        state: "provider-failed",
        usage: null,
      });
    },
  );

  it("terminates an unchanged repair report after exactly one paid repair call", async () => {
    const initial = semanticRequest();
    const invalid = semanticProposal(initial);
    invalid.workItems[0]!.obligationIds = [];
    const report = parseAndValidateCompilerProposal(initial, invalid).report;
    const repair = structuredClone(initial);
    repair.revision = 1;
    repair.previousProposal = invalid;
    repair.validationReport = report;
    const runStructured = vi.fn(async () => ({
      value: structuredClone(invalid),
      usage: { inputTokens: 9, outputTokens: 1 },
    }));
    const backend = new CodexCliManagementBackend({ runStructured });
    const rejection = await backend
      .proposePlan(repair, async () => {}, semanticProjectionContext())
      .catch((error) => error);
    expect(rejection).toBeInstanceOf(ManagementOutputError);
    expect(rejection.message).toContain("repeated the unchanged invalid proposal");
    expect(rejection.validationReport).toEqual(report);
    expect(runStructured).toHaveBeenCalledOnce();
  });

  it("calls admission once immediately before dispatch and checkpoints one accepted proposal", async () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request);
    const events: string[] = [];
    const backend = new CodexCliManagementBackend({
      runStructured: async () => {
        events.push("model");
        return { value: proposal, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const admission = vi.fn(async () => {
      events.push("admission");
      return 5_000;
    });
    const checkpoint = vi.fn(async () => {
      events.push("checkpoint");
    });
    await backend.proposePlan(request, checkpoint, semanticProjectionContext(), admission);
    expect(admission).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(events).toEqual(["admission", "model", "checkpoint"]);
  });

  it("preserves a projection invariant thrown by the accepted-proposal checkpoint", async () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request);
    const runStructured = vi.fn(async () => ({
      value: proposal,
      usage: { inputTokens: 7, outputTokens: 2 },
    }));
    const backend = new CodexCliManagementBackend({ runStructured });
    const invariant = new CompilerInvariantError("economic projection assertion");

    await expect(
      backend.proposePlan(
        request,
        async () => {
          throw invariant;
        },
        semanticProjectionContext(),
      ),
    ).rejects.toBe(invariant);
    expect(runStructured).toHaveBeenCalledOnce();
  });
});
