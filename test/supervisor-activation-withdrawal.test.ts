import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReader, cancellationRequestFromComments } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseLostError, LeaseManager } from "../src/control/lease.js";
import { decodeEventComments, encodeEventComment } from "../src/control/receipts.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { policyDigest } from "../src/protocol/policy.js";
import { isModelInvocationMarker, unresolvedModelInvocations } from "../src/control/budget.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { GithubOctokitGraphWriter, renderLegacyWorkItemCore } from "../src/graph.js";

const fixtures: Awaited<ReturnType<typeof providerSupervisorFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture(fresh = true) {
  const f = await providerSupervisorFixture("daytona-burst", {
    controllerActivation: true,
    localOnly: true,
  });
  fixtures.push(f);
  vi.spyOn(GitHubReader.prototype, "readRepositoryLayout").mockResolvedValue({
    defaultBranch: "main",
    files: ["README.md"],
    totalFiles: 1,
    truncated: false,
    treeTruncatedByGitHub: false,
  });
  const start = f.snapshot.factoryEvents!.find(
    (event) => event.kind === "run" && event.event === "FactoryRunStarted",
  )!;
  if (start.kind !== "run" || start.event !== "FactoryRunStarted")
    throw new Error("missing fixture start");
  const binding = {
    objective: 7,
    requestId: "fixture-activation",
    repository: start.repository,
    requestedBy: "operator",
    baseSha: start.baseSha!,
    policyDigest: policyDigest(f.policy),
  };
  if (fresh) {
    // Pristine human Objective, before graph compilation or a Factory run.
    // The fixture's prebuilt graph is not authority for this new activation.
    f.refs.clear();
    f.snapshot.workItems = [];
    f.snapshot.factoryEvents = [
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "ActivationRequested",
        objective: 7,
        runId: binding.requestId,
        requestId: binding.requestId,
        sequence: 1,
        at: new Date().toISOString(),
        requestedBy: binding.requestedBy,
        repository: binding.repository,
        baseSha: binding.baseSha,
        policy: f.policy,
        policyDigest: binding.policyDigest,
        controllerProtocolMin: "clockgrove.factory/v2",
        controllerProtocolMax: "clockgrove.factory/v2",
      }),
    ];
  }
  const compile = vi
    .spyOn(f.management, "compile")
    .mockRejectedValue(new Error("fixture reached uncancelled compilation"));
  const review = vi.spyOn(f.management, "review");
  const withdraw = (overrides: Record<string, unknown> = {}) => {
    const cancellation = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "ActivationCancellationRequested",
      objective: binding.objective,
      runId: binding.requestId,
      activationRequestId: binding.requestId,
      requestId: "withdraw-fixture-activation",
      repository: binding.repository,
      requestedBy: binding.requestedBy,
      baseSha: binding.baseSha,
      policyDigest: binding.policyDigest,
      sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
      at: new Date().toISOString(),
      ...overrides,
    });
    f.snapshot.factoryEvents!.push(cancellation);
    return cancellation;
  };
  // Keep the real authenticated cancellation parser; simulate only its REST
  // comment input. A missing/wrong binding supplied by Supervisor cannot match.
  const narrowRead = vi
    .mocked(GitHubReader.prototype.readRunCancellationRequest)
    .mockImplementation(async (_objective, runId, actor, activation) =>
      cancellationRequestFromComments(
        f.snapshot.factoryEvents!.map((event) => ({
          body: encodeEventComment("Fixture receipt", event),
          authorLogin: "operator",
          authorAssociation: "OWNER",
        })),
        runId,
        actor,
        activation,
      ),
    );
  return { ...f, binding, compile, review, withdraw, narrowRead };
}

function afterReceipt(eventName: FactoryEvent["event"], action: () => void) {
  const writer = vi.mocked(GitHubControlStore.prototype.addIssueComment);
  const original = writer.getMockImplementation()!;
  let injected = false;
  writer.mockImplementation(async (node, body) => {
    await original(node, body);
    if (!injected && decodeEventComments(body).some((event) => event.event === eventName)) {
      injected = true;
      action();
    }
  });
}

describe("Supervisor activation withdrawal races", () => {
  it("rejects malformed pre-existing Work Items before starting a run", async () => {
    const f = await fixture(true);
    f.snapshot.workItems = [
      {
        id: "I_8",
        number: 8,
        title: "Malformed existing item",
        body: "A planning note without the bounded legacy sections",
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      },
    ];

    expect(await f.run()).toMatchObject({
      status: "escalated",
      runId: "not-started",
      reason: expect.stringMatching(
        /Objective graph preflight failed.*six ordered legacy sections/,
      ),
    });
    expect(f.events()).toContainEqual(
      expect.objectContaining({
        event: "ActivationRejected",
        activationRequestId: "fixture-activation",
      }),
    );
    expect(
      f
        .events()
        .filter(
          (event) =>
            event.event === "FactoryRunStarted" ||
            event.event === "DeliverySelected" ||
            event.kind === "budget" ||
            event.kind === "attempt",
        ),
    ).toEqual([]);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
  });

  it("compiles and adopts valid existing Work Items on a fresh activation without recreating topology", async () => {
    const f = await fixture(true);
    const core = {
      goal: "Create a.txt containing a",
      acceptance: ["a.txt has the expected text"],
      scope: ["a.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
    };
    f.snapshot.workItems = [
      {
        id: "I_8",
        number: 8,
        title: "Implement a",
        body: renderLegacyWorkItemCore(core),
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      },
    ];
    f.compile.mockImplementation(async (context, checkpoint) => {
      const result = {
        objective: {
          title: f.snapshot.title,
          workItems: [
            {
              id: "adopted-8",
              title: "Implement a",
              ...core,
              dependsOn: [],
              baseSha: context.baseSha,
              validationCommands: ["node --test"],
              requirements: {
                os: ["linux"],
                architecture: [],
                tools: ["node"],
                services: [],
                networkDestinations: [],
                permittedSecretNames: [],
                trust: "trusted_local" as const,
                estimatedDurationMinutes: 1,
              },
              artifactContract: "clockgrove.factory/artifact-v1" as const,
              delivery: { group: "adopted-8", relationship: "root" as const },
            },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      await checkpoint(result);
      return result;
    });
    const create = vi
      .spyOn(GithubOctokitGraphWriter.prototype, "createWorkItemIssue")
      .mockRejectedValue(new Error("legacy adoption must not create an issue"));
    const addBlockedBy = vi
      .spyOn(GithubOctokitGraphWriter.prototype, "addBlockedBy")
      .mockRejectedValue(new Error("legacy adoption must not create an edge"));
    const update = vi
      .spyOn(GithubOctokitGraphWriter.prototype, "updateWorkItemIssue")
      .mockImplementation(async ({ issueId, body }) => {
        expect(issueId).toBe("I_8");
        f.snapshot.workItems[0]!.body = body;
      });

    expect(await f.run()).toMatchObject({ status: "completed", objective: 7 });
    expect(f.compile).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(addBlockedBy).not.toHaveBeenCalled();
    expect(f.snapshot.workItems).toHaveLength(1);
    expect(f.snapshot.workItems[0]).toMatchObject({ id: "I_8", number: 8, closed: true });
    expect(f.events().filter((event) => event.event === "GraphCompiled")).toHaveLength(1);
    expect(f.events().filter((event) => event.event === "GraphProjected")).toHaveLength(1);
  });

  it("refuses adoption writes when a legacy Work Item changes during compilation", async () => {
    const f = await fixture(true);
    const core = {
      goal: "Create a.txt containing a",
      acceptance: ["a.txt has the expected text"],
      scope: ["a.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
    };
    f.snapshot.workItems = [
      {
        id: "I_8",
        number: 8,
        title: "Implement a",
        body: renderLegacyWorkItemCore(core),
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      },
    ];
    f.compile.mockImplementation(async (context, checkpoint) => {
      const result = {
        objective: {
          title: f.snapshot.title,
          workItems: [
            {
              id: "adopted-8",
              title: "Implement a",
              ...core,
              dependsOn: [],
              baseSha: context.baseSha,
              validationCommands: ["node --test"],
              requirements: {
                os: ["linux"],
                architecture: [],
                tools: ["node"],
                services: [],
                networkDestinations: [],
                permittedSecretNames: [],
                trust: "trusted_local" as const,
              },
              artifactContract: "clockgrove.factory/artifact-v1" as const,
              delivery: { group: "adopted-8", relationship: "root" as const },
            },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      await checkpoint(result);
      f.snapshot.workItems[0]!.body = renderLegacyWorkItemCore({
        ...core,
        goal: "A concurrently changed goal",
      });
      return result;
    });
    const update = vi.spyOn(GithubOctokitGraphWriter.prototype, "updateWorkItemIssue");

    expect(await f.run()).toMatchObject({
      status: "escalated",
      reason: expect.stringContaining("legacy Work Item constraints changed during"),
    });
    expect(f.compile).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
    expect(f.events().filter((event) => event.event === "GraphCompiled")).toHaveLength(0);
    expect(f.events().filter((event) => event.event === "GraphProjected")).toHaveLength(0);
  });

  it("persists compilation intent before the real invocation and leaves missing counters unknown", async () => {
    const f = await fixture(true);
    Object.assign(f.management, { supportsCompilerAdmission: true });
    f.compile.mockImplementation(async (context, _checkpoint, beforeModelInvocation) => {
      expect(f.events().filter(isModelInvocationMarker)).toEqual([]);
      await beforeModelInvocation?.();
      const markers = f.events().filter(isModelInvocationMarker);
      expect(markers).toHaveLength(1);
      const start = f
        .events()
        .find((event) => event.kind === "run" && event.event === "FactoryRunStarted");
      expect(start).toBeDefined();
      expect(markers[0]).toMatchObject({
        objective: 7,
        runId: start!.runId,
        phase: "management",
        modelInvocationId: `compile-${context.baseSha}`,
        usageId: `invocation-compile-${context.baseSha}`,
        amount: 0,
        policyDigest: policyDigest(f.policy),
      });
      expect(markers[0]!.workItem).toBeUndefined();
      expect(markers[0]!.attempt).toBeUndefined();
      expect(markers[0]!.sequence).toBeGreaterThan(start!.sequence);
      expect(unresolvedModelInvocations(f.events())).toEqual(markers);
      throw new Error("fixture: compilation result and token counters unavailable");
    });
    expect(await f.run()).toMatchObject({
      status: "escalated",
      reason: "fixture: compilation result and token counters unavailable",
    });
    expect(f.compile).toHaveBeenCalledOnce();
    const markers = f.events().filter(isModelInvocationMarker);
    expect(markers).toHaveLength(1);
    expect(unresolvedModelInvocations(f.events())).toEqual(markers);
    expect(
      f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.unit === "model_tokens",
        ),
    ).toEqual([]);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
    expect(f.events().some((event) => event.event === "GraphCompiled")).toBe(false);
  });

  it("does not invent an invocation when ordinary compiler preparation fails before dispatch", async () => {
    const f = await fixture(true);
    Object.assign(f.management, { supportsCompilerAdmission: true });
    f.compile.mockRejectedValue(new Error("fixture: isolated home unavailable before dispatch"));

    expect(await f.run()).toMatchObject({
      status: "escalated",
      reason: "fixture: isolated home unavailable before dispatch",
    });
    expect(f.compile).toHaveBeenCalledOnce();
    expect(f.events().filter(isModelInvocationMarker)).toEqual([]);
    expect(unresolvedModelInvocations(f.events())).toEqual([]);
    expect(f.events().some((event) => event.event === "GraphCompiled")).toBe(false);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
  });

  it.each(["hard", "missing"] as const)(
    "rejects fresh foreground %s token intent before any compilation or dispatch",
    async (mode) => {
      const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
      fixtures.push(f);
      // Same pristine human-Objective boundary as fixture(true), but with no
      // recorded activation: a genuinely new foreground policy is being requested.
      f.refs.clear();
      f.snapshot.workItems = [];
      f.snapshot.factoryEvents = [];
      if (!f.policy.economics) throw new Error("fixture needs a token threshold");
      if (mode === "hard") f.policy.economics.modelTokenBudgetMode = "hard";
      else delete f.policy.economics.modelTokenBudgetMode;
      const compile = vi.spyOn(f.management, "compile");
      const review = vi.spyOn(f.management, "review");
      // Refusal precedes run creation, so there is no run to escalate.
      await expect(f.run()).rejects.toThrow(
        mode === "hard" ? /hard is unsupported/ : /requires explicit/,
      );
      expect(compile).not.toHaveBeenCalled();
      expect(review).not.toHaveBeenCalled();
      expect(f.activity).toEqual([]);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.event === "FactoryRunStarted" ||
              event.kind === "budget" ||
              event.kind === "attempt",
          ),
      ).toEqual([]);
    },
  );

  it("rechecks Objective authority after the cancellation read before compilation", async () => {
    let changed = false;
    const f = await fixture(true);
    vi.mocked(LeaseManager.prototype.assertGeneration).mockImplementation(async () => {
      if (changed) throw new LeaseLostError("Objective fence changed during cancellation read");
    });
    f.narrowRead.mockImplementation(async () => {
      changed = true;
      return null;
    });
    await expect(f.run()).rejects.toThrow("Objective fence changed during cancellation read");
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
  });
  it("does not start or compile an activation already withdrawn before startup", async () => {
    const f = await fixture();
    f.withdraw();
    expect(await f.run()).toMatchObject({ status: "cancelled", runId: f.binding.requestId });
    expect(f.events().some((event) => event.event === "FactoryRunStarted")).toBe(false);
    expect(f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
  });

  it("rereads withdrawal after lease acquisition before appending a run start", async () => {
    const f = await fixture();
    const acquire = vi.mocked(LeaseManager.prototype.acquire);
    const original = acquire.getMockImplementation()!;
    acquire.mockImplementation(async (...args) => {
      const lease = await original(...args);
      f.withdraw();
      return lease;
    });
    expect(await f.run()).toMatchObject({ status: "cancelled", runId: f.binding.requestId });
    expect(acquire).toHaveBeenCalledOnce();
    expect(LeaseManager.prototype.release).toHaveBeenCalledOnce();
    expect(f.events().some((event) => event.event === "FactoryRunStarted")).toBe(false);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
  });

  it("cancels a just-started run before invoking compilation with the exact activation binding", async () => {
    const f = await fixture();
    afterReceipt("FactoryRunStarted", () => {
      f.withdraw();
    });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "cancelled" });
    expect(result.runId).not.toBe(f.binding.requestId);
    expect(f.events().filter((event) => event.event === "FactoryRunStarted")).toHaveLength(1);
    expect(f.events().filter((event) => event.event === "FactoryRunCancelled")).toHaveLength(1);
    expect(f.narrowRead).toHaveBeenCalledWith(7, result.runId, "operator", f.binding);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.activity).toEqual([]);
  });

  it.each([
    { runId: "another-activation", activationRequestId: "another-activation" },
    { requestedBy: "another-operator" },
  ])("does not cancel this run with unrelated withdrawal %j", async (overrides) => {
    const f = await fixture();
    afterReceipt("FactoryRunStarted", () => {
      f.withdraw(overrides);
    });
    const result = await f.run();
    expect(result).toMatchObject({
      status: "escalated",
      reason: expect.stringContaining("fixture reached uncancelled compilation"),
    });
    expect(f.compile).toHaveBeenCalledOnce();
    expect(f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
    expect(f.activity).toEqual([]);
  });

  it("fences a resumed activation withdrawn after reservation but before worker launch", async () => {
    const f = await fixture(false);
    afterReceipt("AttemptReserved", () => {
      f.withdraw();
    });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "cancelled", runId: f.runId });
    expect(f.events().some((event) => event.event === "AttemptReserved")).toBe(true);
    expect(f.events().some((event) => event.event === "AttemptStarted")).toBe(false);
    expect(f.activity.some((entry) => entry.operation === "launch")).toBe(false);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.narrowRead).toHaveBeenCalledWith(7, f.runId, "operator", f.binding);
  });
});
