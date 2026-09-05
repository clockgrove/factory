import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReader, cancellationRequestFromComments } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseManager } from "../src/control/lease.js";
import { decodeEventComments, encodeEventComment } from "../src/control/receipts.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { policyDigest } from "../src/protocol/policy.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

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
