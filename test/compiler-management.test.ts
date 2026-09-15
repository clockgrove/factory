import { describe, expect, it, vi } from "vitest";

import { COMPILER_PROPOSAL_JSON_SCHEMA } from "../src/compiler/contracts.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import { ManagementOutputError } from "../src/management/backend.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { structuralObjectiveInventory } from "../src/management/compile.js";
import type { CompilationContext } from "../src/management/backend.js";
import { parseAndValidateCompilerProposal } from "../src/compiler/proposal.js";
import { semanticProposal, semanticRequest } from "./helpers/semantic-compiler.js";

describe("single semantic management route", () => {
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
    expect(inventory.obligations.map((entry) => entry.text)).toEqual([
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
    expect(inventory.obligations[0]!.text).toBe(context.objective.title);
    expect(
      inventory.obligations
        .slice(1)
        .map((entry) => entry.text)
        .join(""),
    ).toBe(body);
    expect(inventory.obligations.every((entry) => entry.text.length <= 4_000)).toBe(true);
  });

  it("keeps the maximum accepted Objective body within the inventory bound", () => {
    const body = "x".repeat(384 * 1_024);
    const inventory = structuralObjectiveInventory({
      objective: { number: 404, title: "Bounded source", body },
      baseSha: "a".repeat(40),
    } as CompilationContext);
    expect(inventory.obligations).toHaveLength(100);
    expect(
      inventory.obligations
        .slice(1)
        .map((entry) => entry.text)
        .join(""),
    ).toBe(body);
  });

  it("keeps unbroken Objective text within bounded inventory fields", () => {
    const inventory = structuralObjectiveInventory({
      objective: { number: 404, title: "Bounded text", body: "x".repeat(8_001) },
      baseSha: "a".repeat(40),
    } as CompilationContext);
    expect(inventory.obligations).toHaveLength(4);
    expect(inventory.obligations.every((entry) => entry.text.length <= 4_000)).toBe(true);
    expect(inventory.obligations.slice(1).map((entry) => entry.text.length)).toEqual([
      4_000, 4_000, 1,
    ]);
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
    const first = await backend.proposePlan(initial, firstCheckpoint);
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
    const second = await backend.proposePlan(repair, async () => {});
    expect(schemas).toEqual([COMPILER_PROPOSAL_JSON_SCHEMA, COMPILER_PROPOSAL_JSON_SCHEMA]);
    expect(prompts[0]).toContain(JSON.stringify(initial.inventory));
    expect(prompts[0]).toContain("complete independent obligation inventory");
    expect(prompts[1]).toContain(JSON.stringify(repair.validationReport));
    expect(firstCheckpoint).toHaveBeenCalledExactlyOnceWith(first);
    expect(second.proposal).toEqual(proposal);
    expect(first.provenance.schemaDigest).toBe(compilerEvalDigest(COMPILER_PROPOSAL_JSON_SCHEMA));
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
    await backend.proposePlan(request, async () => {});
    expect(prompts[0]).toContain("lossless bounded Objective source segments");
    expect(prompts[0]).not.toContain("complete independent obligation inventory");
  });

  it("persists known usage and the typed report for malformed and mechanically invalid output", async () => {
    const request = semanticRequest();
    const invalid = semanticProposal(request);
    invalid.workItems.push({ ...structuredClone(invalid.workItems[0]!), scope: ["src/other.ts"] });
    const expectedReport = parseAndValidateCompilerProposal(request, invalid).report;
    for (const value of [{ unexpected: true }, invalid]) {
      const backend = new CodexCliManagementBackend({
        runStructured: async () => ({
          value,
          usage: { inputTokens: 7, outputTokens: 2 },
        }),
      });
      const checkpoint = vi.fn();
      const rejection = await backend.proposePlan(request, checkpoint).catch((error) => error);
      expect(rejection).toBeInstanceOf(ManagementOutputError);
      expect(rejection).toMatchObject({
        usage: { inputTokens: 7, outputTokens: 2 },
        proposal: value,
      });
      expect(checkpoint).not.toHaveBeenCalled();
      if (value === invalid) expect(rejection.validationReport).toEqual(expectedReport);
    }
  });

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
    const rejection = await backend.proposePlan(repair, async () => {}).catch((error) => error);
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
    await backend.proposePlan(request, checkpoint, admission);
    expect(admission).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(events).toEqual(["admission", "model", "checkpoint"]);
  });
});
