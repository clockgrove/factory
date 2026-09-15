import { describe, expect, it, vi } from "vitest";

import type { CompilerDraftManager, CompilerDraftRecord } from "../src/control/compiler-drafts.js";
import { compiledGraphDigest } from "../src/graph.js";
import {
  CompilerDraftAdmissionError,
  runCompilerDraftLoop,
  type CompilerDraftCallbacks,
  type DraftInvocationResult,
  type ValidatedCompilerDraft,
} from "../src/evaluation/compiler-draft-loop.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import {
  parseAndValidateCompilerProposal,
  projectCompilerProposal,
} from "../src/compiler/proposal.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import type { CompilerDraftBinding } from "../src/control/compiler-drafts.js";
import type { LeaseState } from "../src/control/lease.js";
import {
  semanticPinnedFacts,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";

const binding: CompilerDraftBinding = {
  repository: "clockgrove/factory",
  objective: 404,
  runId: "semantic-draft",
  policyDigest: "b".repeat(64),
  baseSha: "a".repeat(40),
  inputDigest: "c".repeat(64),
};
const lease = {} as LeaseState;

function memoryManager(records: CompilerDraftRecord[] = []) {
  return {
    records,
    manager: {
      load: async () => [...records],
      append: async (
        _lease: LeaseState,
        recordBinding: CompilerDraftBinding,
        sequence: number,
        kind: CompilerDraftRecord["kind"],
        payload: Record<string, unknown>,
      ) => {
        if (sequence !== records.length) throw new Error("fixture sequence mismatch");
        const record: CompilerDraftRecord = {
          protocol: "clockgrove.factory/compiler-draft",
          binding: recordBinding,
          sequence,
          kind,
          payload,
        };
        records.push(record);
        return record;
      },
    } as unknown as CompilerDraftManager,
  };
}

function validDraft(): { inventory: unknown; draft: ValidatedCompilerDraft } {
  const pinned = semanticPinnedFacts();
  const request = semanticRequest(pinned);
  const proposal = semanticProposal(request);
  const projected = projectCompilerProposal({
    request,
    proposal,
    pinnedFacts: pinned,
    runPolicy: { ...DEFAULT_RUN_POLICY, allowedNetworkDestinations: [] },
  });
  return {
    inventory: request.inventory,
    draft: {
      proposal,
      objective: projected.objective,
      projectionTrace: projected.trace,
      report: parseAndValidateCompilerProposal(request, proposal).report,
      requestDigest: compilerEvalDigest(request),
    },
  };
}

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 };
const response = (value: unknown): DraftInvocationResult => ({ value, usage });

function baseCallbacks(
  invoke: CompilerDraftCallbacks["invoke"],
  draft: ValidatedCompilerDraft,
): CompilerDraftCallbacks {
  return {
    invoke,
    recordUsage: vi.fn(async () => {}),
    validateInventory: (value) => value,
    validate: (value) => {
      if ((value as { kind?: string })?.kind !== "valid") throw new Error("malformed proposal");
      return draft;
    },
    accept: (value) => (value as { decision?: string }).decision === "accept",
  };
}

describe("semantic compiler draft lifecycle", () => {
  it("accepts a valid first proposal and stores proposal/trace identities without a draft graph copy", async () => {
    const { inventory, draft } = validDraft();
    const store = memoryManager();
    const invoke = vi.fn<CompilerDraftCallbacks["invoke"]>(async (request, checkpoint) => {
      const result =
        request.stage === "inventory"
          ? response(inventory)
          : request.stage === "judge"
            ? response({ decision: "accept", findings: [] })
            : response({ kind: "valid" });
      await checkpoint(result);
      return result;
    });
    const outcome = await runCompilerDraftLoop({
      manager: store.manager,
      lease,
      binding,
      callbacks: baseCallbacks(invoke, draft),
    });
    expect(outcome).toMatchObject({
      status: "accepted",
      revision: 0,
      graphDigest: compiledGraphDigest(draft.objective),
    });
    expect(invoke.mock.calls.map(([request]) => request.stage)).toEqual([
      "inventory",
      "compile",
      "judge",
    ]);
    const validation = store.records.find((record) => record.kind === "validation")!;
    expect(validation.payload).toMatchObject({
      proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      traceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestDigest: draft.requestDigest,
    });
    expect(validation.payload).not.toHaveProperty("objective");
    const selection = store.records.find((record) => record.kind === "selection")!;
    expect(selection.payload).not.toHaveProperty("graph");
  });

  it("persists one typed mechanical report and gives repair the exact invalid proposal", async () => {
    const { inventory, draft } = validDraft();
    const request = semanticRequest();
    const invalid = semanticProposal(request);
    invalid.workItems.push({ ...structuredClone(invalid.workItems[0]!), scope: ["src/other.ts"] });
    const report = parseAndValidateCompilerProposal(request, invalid).report;
    const store = memoryManager();
    const invoke = vi.fn<CompilerDraftCallbacks["invoke"]>(async (call, checkpoint) => {
      if (call.stage === "inventory") {
        const result = response(inventory);
        await checkpoint(result);
        return result;
      }
      if (call.stage === "compile")
        throw Object.assign(new Error("invalid semantic proposal"), {
          usage,
          proposal: invalid,
          validationReport: report,
        });
      if (call.stage === "repair") {
        expect(call.previous).toEqual(invalid);
        expect(call.failure).toMatchObject({ validationReport: report });
        const result = response({ kind: "valid" });
        await checkpoint(result);
        return result;
      }
      const result = response({ decision: "accept", findings: [] });
      await checkpoint(result);
      return result;
    });
    const outcome = await runCompilerDraftLoop({
      manager: store.manager,
      lease,
      binding,
      callbacks: baseCallbacks(invoke, draft),
      limits: { maxRepairs: 1 },
    });
    expect(outcome).toMatchObject({ status: "accepted", revision: 1 });
    const failed = store.records.find(
      (record) => record.kind === "result" && record.payload.stage === "compile",
    )!;
    expect(failed.payload).toMatchObject({
      value: null,
      proposal: invalid,
      validationReport: report,
      usage,
    });
    expect(
      store.records.filter(
        (record) =>
          "validationReport" in record.payload &&
          compilerEvalDigest(record.payload.validationReport) === compilerEvalDigest(report),
      ),
    ).toHaveLength(1);
  });

  it("survives response loss after a durable result without replaying the invocation", async () => {
    const { inventory, draft } = validDraft();
    const store = memoryManager();
    const calls = new Map<string, number>();
    const invoke = vi.fn<CompilerDraftCallbacks["invoke"]>(async (request, checkpoint) => {
      calls.set(request.invocationId, (calls.get(request.invocationId) ?? 0) + 1);
      const result =
        request.stage === "inventory"
          ? response(inventory)
          : request.stage === "judge"
            ? response({ decision: "accept", findings: [] })
            : response({ kind: "valid" });
      await checkpoint(result);
      if (request.stage === "compile") throw new Error("transport response lost");
      return result;
    });
    const outcome = await runCompilerDraftLoop({
      manager: store.manager,
      lease,
      binding,
      callbacks: baseCallbacks(invoke, draft),
    });
    expect(outcome.status).toBe("accepted");
    expect([...calls.values()]).toEqual([1, 1, 1]);
  });

  it("fails closed on an invocation reserved before an unknown outcome and never replays it", async () => {
    const { draft } = validDraft();
    const store = memoryManager();
    const firstInvoke = vi.fn<CompilerDraftCallbacks["invoke"]>(
      async (_request, _checkpoint, reserve) => {
        await reserve!();
        throw new CompilerDraftAdmissionError(new Error("process disappeared after dispatch"));
      },
    );
    await expect(
      runCompilerDraftLoop({
        manager: store.manager,
        lease,
        binding,
        callbacks: { ...baseCallbacks(firstInvoke, draft), reserveAtDispatch: true },
      }),
    ).rejects.toThrow("process disappeared after dispatch");
    expect(store.records.map((record) => record.kind)).toEqual(["started", "invocation"]);
    const replay = vi.fn<CompilerDraftCallbacks["invoke"]>();
    const outcome = await runCompilerDraftLoop({
      manager: store.manager,
      lease,
      binding,
      callbacks: { ...baseCallbacks(replay, draft), reserveAtDispatch: true },
    });
    expect(outcome).toMatchObject({ status: "stopped", reason: "uncertain-invocation-accounting" });
    expect(replay).not.toHaveBeenCalled();
  });

  it("consumes a malformed repair and terminates at the selected repair bound", async () => {
    const { inventory, draft } = validDraft();
    const store = memoryManager();
    const invoke = vi.fn<CompilerDraftCallbacks["invoke"]>(async (request, checkpoint) => {
      const result =
        request.stage === "inventory"
          ? response(inventory)
          : request.stage === "compile"
            ? response({ kind: "valid" })
            : request.stage === "judge"
              ? response({
                  decision: "repair",
                  findings: [
                    {
                      severity: "blocking",
                      dimension: "coverage",
                      rootCause: "An explicit obligation is omitted.",
                      correction: "Map the obligation.",
                      obligationIds: ["explicit-contract"],
                      itemIds: ["item-1"],
                      evidenceIds: ["objective"],
                    },
                  ],
                })
              : response({ malformed: true });
      await checkpoint(result);
      return result;
    });
    const outcome = await runCompilerDraftLoop({
      manager: store.manager,
      lease,
      binding,
      callbacks: baseCallbacks(invoke, draft),
      limits: { maxRepairs: 1 },
    });
    expect(outcome).toMatchObject({ status: "stopped", reason: "repair-limit-unresolved" });
    expect(invoke.mock.calls.map(([request]) => request.stage)).toEqual([
      "inventory",
      "compile",
      "judge",
      "repair",
    ]);
    expect(store.records.some((record) => record.kind === "selection")).toBe(false);
  });

  it("stops before dispatch when its deadline is already exhausted", async () => {
    const { draft } = validDraft();
    const store = memoryManager();
    const invoke = vi.fn<CompilerDraftCallbacks["invoke"]>();
    const outcome = await runCompilerDraftLoop({
      manager: store.manager,
      lease,
      binding,
      callbacks: baseCallbacks(invoke, draft),
      startedAt: 1,
      now: () => 3,
      limits: { deadlineMs: 1 },
    });
    expect(outcome).toMatchObject({ status: "stopped", reason: "deadline-exhausted" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
