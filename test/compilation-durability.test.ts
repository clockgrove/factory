import { describe, expect, it } from "vitest";

import { deriveBudgetUsage } from "../src/control/budget.js";
import type { CompiledGraphRecord } from "../src/control/graphs.js";
import type { FactoryEvent } from "../src/protocol/events.js";
import { runDurableCompilationTransaction, type CompilationFaultPoint } from "../src/supervisor.js";
import type { CompilationCheckpoint, CompilationResult } from "../src/management/backend.js";

const graphDigest = "d".repeat(64);
const objective = {
  title: "Durable compile",
  workItems: [
    {
      id: "work",
      title: "Work",
      goal: "Implement work",
      acceptance: ["Tests pass"],
      scope: ["src/work.ts"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn: [],
      baseSha: "a".repeat(40),
      validationCommands: ["npm test"],
      requirements: {
        os: ["linux"],
        architecture: ["x64"],
        tools: ["node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local" as const,
      },
      artifactContract: "clockgrove.factory/artifact-v1" as const,
    },
  ],
};

const compilation: CompilationResult = {
  objective,
  usage: { inputTokens: 11, outputTokens: 19 },
};

function record(): CompiledGraphRecord {
  return {
    ref: "refs/clockgrove-factory/graphs/objective-1/run-test",
    commitOid: "b".repeat(40),
    blobOid: "c".repeat(40),
    graphDigest,
    graphSize: 1,
    objective,
    compilation: {
      protocol: "clockgrove.factory/compilation-receipt-v1",
      invocationId: `compile-${"a".repeat(40)}`,
      graphDigest,
      inputTokens: 11,
      outputTokens: 19,
    },
  };
}

function budgetEvent(sequence: number): Extract<FactoryEvent, { kind: "budget" }> {
  return {
    protocol: "clockgrove.factory/v2",
    kind: "budget",
    event: "BudgetReconciled",
    objective: 1,
    runId: "run-test",
    sequence,
    at: "2026-09-04T00:00:00.000Z",
    phase: "management",
    unit: "model_tokens",
    amount: 30,
    usageId: `compile-${graphDigest}`,
  };
}

describe("durable compilation transaction", () => {
  it.each<CompilationFaultPoint>([
    "after-model-return",
    "after-graph-persistence",
    "after-usage-write",
    "after-preflight",
  ])("restarts %s without another model invocation", async (faultPoint) => {
    let durable: CompiledGraphRecord | null = null;
    let invocations = 0;
    let faultArmed = true;
    const budgetEvents: FactoryEvent[] = [];

    const invoke = async (checkpoint: CompilationCheckpoint) => {
      invocations += 1;
      await checkpoint(compilation);
      return compilation;
    };
    const run = () =>
      runDurableCompilationTransaction({
        existing: durable,
        invoke,
        persist: async () => {
          durable = record();
          return durable;
        },
        recover: async () => durable,
        recordUsage: async (saved) => {
          const usageId = `compile-${saved.graphDigest}`;
          if (!budgetEvents.some((event) => event.kind === "budget" && event.usageId === usageId)) {
            budgetEvents.push(budgetEvent(budgetEvents.length + 1));
          }
        },
        preflight: async () => {},
        fault: async (point) => {
          if (faultArmed && point === faultPoint) {
            faultArmed = false;
            throw new Error(`fault ${point}`);
          }
        },
      });

    await expect(run()).rejects.toThrow(`fault ${faultPoint}`);
    await expect(run()).resolves.toMatchObject({ graphDigest });
    expect(invocations).toBe(1);
    expect(deriveBudgetUsage(budgetEvents).modelTokens).toBe(30);
    expect(budgetEvents).toHaveLength(1);
  });

  it("recovers a lost graph-persistence response without reinvoking the model", async () => {
    let durable: CompiledGraphRecord | null = null;
    let invocations = 0;
    let loseResponse = true;
    const result = await runDurableCompilationTransaction({
      existing: null,
      invoke: async (checkpoint) => {
        invocations += 1;
        await checkpoint(compilation);
        return compilation;
      },
      persist: async () => {
        durable = record();
        if (loseResponse) {
          loseResponse = false;
          throw new Error("graph response lost");
        }
        return durable;
      },
      recover: async () => durable,
      recordUsage: async () => {},
      preflight: async () => {},
    });

    expect(result.graphDigest).toBe(graphDigest);
    expect(invocations).toBe(1);
  });

  it("recovers a lost usage-write response idempotently on restart", async () => {
    let durable: CompiledGraphRecord | null = null;
    let invocations = 0;
    let loseResponse = true;
    const budgetEvents: FactoryEvent[] = [];
    const run = () =>
      runDurableCompilationTransaction({
        existing: durable,
        invoke: async (checkpoint) => {
          invocations += 1;
          await checkpoint(compilation);
          return compilation;
        },
        persist: async () => {
          durable = record();
          return durable;
        },
        recover: async () => durable,
        recordUsage: async () => {
          if (budgetEvents.length === 0) budgetEvents.push(budgetEvent(1));
          if (loseResponse) {
            loseResponse = false;
            throw new Error("usage response lost");
          }
        },
        preflight: async () => {},
      });

    await expect(run()).rejects.toThrow("usage response lost");
    await expect(run()).resolves.toMatchObject({ graphDigest });
    expect(invocations).toBe(1);
    expect(deriveBudgetUsage(budgetEvents).modelTokens).toBe(30);
    expect(budgetEvents).toHaveLength(1);
  });
});
