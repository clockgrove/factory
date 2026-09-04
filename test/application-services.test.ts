import { describe, expect, it } from "vitest";

import { FactoryApplicationService, type ApplicationSnapshot } from "../src/application/index.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const snapshot = (): ApplicationSnapshot => ({
  id: "objective-node", number: 7, title: "Objective", defaultBranch: "main", workItems: [], factoryEvents: [],
});

describe("FactoryApplicationService", () => {
  it("persists one activation and returns its original receipt for concurrent duplicates", async () => {
    let current = snapshot();
    const comments: string[] = [];
    const service = new FactoryApplicationService({
      owner: "o", repo: "r", reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date("2026-01-01T00:00:00.000Z"),
        addIssueComment: async (_id, body) => {
          comments.push(body);
          current.factoryEvents = [...(current.factoryEvents ?? []), ...decodeEventComments(body)];
        },
      },
    });
    const input = { objective: 7, requestId: "offline-activation", baseSha: "a".repeat(40) };
    const [first, duplicate] = await Promise.all([service.activate(input), service.activate(input)]);
    expect(comments).toHaveLength(1);
    expect(duplicate).toEqual(first);
  });

  it.each(["doctor", "plan", "status", "explain"] as const)("%s cannot mutate GitHub", async (operation) => {
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o", repo: "r", reader: { readObjective: async () => snapshot() },
      store: { getAuthenticatedLogin: async () => "actor", serverTime: async () => new Date(), addIssueComment: async () => { writes += 1; } },
    });
    await service.inspect(operation, 7);
    expect(writes).toBe(0);
  });

  it("deduplicates controller lifecycle requests and returns the first receipt", async () => {
    let calls = 0;
    const receipt = { accepted: true };
    const service = new FactoryApplicationService({
      owner: "o", repo: "r", reader: { readObjective: async () => snapshot() },
      controller: {
        start: async () => { calls += 1; return receipt; }, stop: async () => receipt,
        install: async () => receipt, uninstall: async () => receipt,
      },
    });
    const input = { repository: "o/r", checkout: "/checkout", requestId: "controller-1" };
    expect(await service.controller("start", input)).toBe(receipt);
    expect(await service.controller("start", input)).toBe(receipt);
    expect(calls).toBe(1);
  });

  it.each(["pause", "resume", "drain", "cloud-pause", "retry", "priority", "replay"] as const)(
    "returns the original durable receipt for duplicate %s requests",
    async (operation) => {
      let current = snapshot();
      let writes = 0;
      const service = new FactoryApplicationService({
        owner: "o", repo: "r", reader: { readObjective: async () => structuredClone(current) },
        store: {
          getAuthenticatedLogin: async () => "actor", serverTime: async () => new Date("2026-01-01T00:00:00.000Z"),
          addIssueComment: async (_id, body) => {
            writes += 1;
            current.factoryEvents = [...(current.factoryEvents ?? []), ...decodeEventComments(body)];
          },
        },
      });
      const input = {
        objective: 7, requestId: `duplicate-${operation}`,
        ...((operation === "retry" || operation === "priority") ? { workItem: 8 } : {}),
        ...(operation === "priority" ? { priorityRank: 3 } : {}),
      };
      const first = await service.command(operation, input);
      const duplicate = await service.command(operation, input);
      expect(duplicate).toEqual(first);
      expect(writes).toBe(1);
    },
  );

  it("returns the original durable cancellation receipt", async () => {
    let current = snapshot();
    current.factoryEvents = [parseFactoryEvent({
      protocol: "clockgrove.factory/v2", kind: "run", event: "FactoryRunStarted", objective: 7,
      runId: "run-1", sequence: 1, at: "2026-01-01T00:00:00.000Z", actor: "actor",
      repository: "o/r", objectiveAuthor: "actor", fork: false, baseBranch: "main",
      policy: DEFAULT_RUN_POLICY, policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    })];
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o", repo: "r", reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor", serverTime: async () => new Date("2026-01-01T00:01:00.000Z"),
        addIssueComment: async (_id, body) => { writes += 1; current.factoryEvents!.push(...decodeEventComments(body)); },
      },
    });
    const input = { objective: 7, requestId: "duplicate-cancel" };
    const first = await service.command("cancel", input);
    expect(await service.command("cancel", input)).toEqual(first);
    expect(writes).toBe(1);
  });

  it("rejects cancellation when the latest run is terminal", async () => {
    const current = snapshot();
    current.factoryEvents = [
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2", kind: "run", event: "FactoryRunStarted", objective: 7,
        runId: "run-1", sequence: 1, at: "2026-01-01T00:00:00.000Z", actor: "actor",
        repository: "o/r", objectiveAuthor: "actor", fork: false, baseBranch: "main",
        policy: DEFAULT_RUN_POLICY, policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      }),
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2", kind: "run", event: "FactoryRunCompleted", objective: 7,
        runId: "run-1", sequence: 2, at: "2026-01-01T00:01:00.000Z",
      }),
    ];
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o", repo: "r", reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor", serverTime: async () => new Date(),
        addIssueComment: async () => { writes += 1; },
      },
    });

    await expect(service.command("cancel", { objective: 7, requestId: "late-cancel" }))
      .rejects.toThrow("no Factory v2 run");
    expect(writes).toBe(0);
  });
});
