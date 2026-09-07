import { describe, expect, it, vi } from "vitest";
import { FactoryApplicationService, type ApplicationSnapshot } from "../src/application/index.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const baseSha = "a".repeat(40);
const legacy = {
  ...DEFAULT_RUN_POLICY,
  economics: {
    maxModelTokens: 100,
    maxSandboxMinutes: 0,
    maxManagedSessions: 0,
    minCloudTimeSavedMinutes: 0,
  },
};
const observed = {
  ...legacy,
  economics: { ...legacy.economics, modelTokenBudgetMode: "observed-stop" as const },
};
const hard = {
  ...legacy,
  economics: { ...legacy.economics, modelTokenBudgetMode: "hard" as const },
};

function fixture() {
  const snapshot: ApplicationSnapshot = {
    id: "objective",
    number: 7,
    title: "Objective",
    defaultBranch: "main",
    workItems: [],
    factoryEvents: [],
  };
  const writes = vi.fn(async (_id: string, body: string) => {
    snapshot.factoryEvents!.push(...decodeEventComments(body));
  });
  const label = vi.fn(async () => {});
  const compile = vi.fn(async () => {
    throw new Error("unexpected model invocation");
  });
  const checkout = vi.fn(async () => {
    throw new Error("unexpected checkout preparation");
  });
  const service = new FactoryApplicationService({
    owner: "o",
    repo: "r",
    reader: { readObjective: async () => structuredClone(snapshot) },
    store: {
      getAuthenticatedLogin: async () => "actor",
      serverTime: async () => new Date("2026-01-01T00:00:00Z"),
      ensureObjectiveLabel: label,
      addIssueComment: writes,
    },
    planning: {
      repositoryPath: "/unread-budget-fixture",
      validateCheckout: checkout,
      readRepositoryLayout: async () => ({ files: [], truncated: false }),
      management: {
        id: "test-management",
        compile,
        probe: async () => ({ available: true, authenticated: true }),
        review: async () => {
          throw new Error("unexpected review");
        },
      },
    },
  });
  return { snapshot, writes, label, compile, checkout, service };
}

describe("public fresh model-token policy admission", () => {
  it.each([legacy, hard])(
    "rejects ambiguous or unsupported activation before writes",
    async (policy) => {
      const f = fixture();
      await expect(
        f.service.activate({ objective: 7, requestId: "new-budget", baseSha, policy }),
      ).rejects.toThrow(/requires explicit|hard is unsupported/);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.label).not.toHaveBeenCalled();
      expect(f.compile).not.toHaveBeenCalled();
    },
  );

  it("records explicit observed intent with its own immutable digest and exact replay", async () => {
    const f = fixture();
    const request = { objective: 7, requestId: "explicit-budget", baseSha, policy: observed };
    const accepted = await f.service.activate(request);
    expect(accepted).toMatchObject({ policy: observed, policyDigest: policyDigest(observed) });
    expect(await f.service.activate({ objective: 7, requestId: request.requestId })).toEqual(
      accepted,
    );
    expect(f.writes).toHaveBeenCalledTimes(1);
    await expect(f.service.activate({ ...request, policy: legacy })).rejects.toThrow(
      /requires explicit/,
    );
    expect(f.writes).toHaveBeenCalledTimes(1);
  });

  it("returns only an exact historical activation receipt, never copies its implicit intent to a new request", async () => {
    const f = fixture();
    const original = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "ActivationRequested",
      objective: 7,
      runId: "historical",
      sequence: 1,
      at: "2026-01-01T00:00:00.000Z",
      requestedBy: "actor",
      requestId: "historical",
      repository: "o/r",
      baseSha,
      policy: legacy,
      policyDigest: policyDigest(legacy),
      controllerProtocolMin: "clockgrove.factory/v2",
      controllerProtocolMax: "clockgrove.factory/v2",
    });
    f.snapshot.factoryEvents = [original];
    expect(await f.service.activate({ objective: 7, requestId: "historical" })).toEqual(original);
    expect(
      await f.service.activate({ objective: 7, requestId: "historical", policy: legacy }),
    ).toEqual(original);
    await expect(
      f.service.activate({ objective: 7, requestId: "fresh-copy", baseSha, policy: legacy }),
    ).rejects.toThrow(/requires explicit/);
    expect(f.snapshot.factoryEvents).toEqual([original]);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each([legacy, hard, { ...observed, economics: { ...observed.economics, maxModelTokens: 0 } }])(
    "refuses explicit compilation before model or checkout work and does not invent usage",
    async (policy) => {
      const f = fixture();
      const report = await f.service.plan({ objective: 7, compile: true, baseSha, policy });
      expect(report.compilation).toMatchObject({ result: "failed", usagePersistence: "none" });
      expect(report.usage).toBeNull();
      expect(report.graph).toBeNull();
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "fail",
            summary: expect.stringMatching(
              /requires explicit|hard is unsupported|threshold exhausted/,
            ),
          }),
        ]),
      );
      expect(f.compile).not.toHaveBeenCalled();
      expect(f.checkout).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
    },
  );

  it("does not turn read-only graph inspection into new compilation authority", async () => {
    const f = fixture();
    const report = await f.service.plan({ objective: 7, policy: hard });
    expect(report.compilation.result).toBe("not-requested");
    expect(report.activationAuthorized).toBe(false);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });
});
