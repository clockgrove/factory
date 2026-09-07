import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReader, cancellationRequestFromComments } from "../src/github.js";
import { LifecycleRecorder } from "../src/control/events.js";
import { encodeEventComment } from "../src/control/receipts.js";
import { isModelInvocationMarker, unresolvedModelInvocations } from "../src/control/budget.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { SafeArtifactCheckpointHeldError } from "../src/runtime/qualification-checkpoint.js";
import { unreconciledBudgetReservations } from "../src/control/budget.js";
import { unreconciledCapacityReservations } from "../src/scheduling/capacity-ledger.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
});

async function held(advanceBase = true) {
  let cleanupUnknown = false;
  const reconcile = vi.fn(async () => {
    if (cleanupUnknown) throw new Error("original resource absence is unknown");
  });
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
    controllerActivation: true,
    configureLocalBackend: (backend) => ({ ...backend, reconcileStale: reconcile }),
  });
  fixtures.push(f);
  const start = f.snapshot.factoryEvents!.find((event) => event.event === "FactoryRunStarted")!;
  if (start.event !== "FactoryRunStarted") throw new Error("fixture start absent");
  f.snapshot.factoryEvents!.push(
    parseFactoryEvent({
      protocol: start.protocol,
      kind: "run",
      event: "ActivationRequested",
      objective: 7,
      runId: "fixture-activation",
      sequence: 0,
      at: start.at,
      requestedBy: start.actor,
      requestId: "fixture-activation",
      repository: start.repository,
      baseSha: start.baseSha,
      policy: start.policy,
      policyDigest: start.policyDigest,
      controllerProtocolMin: start.protocol,
      controllerProtocolMax: start.protocol,
    }),
  );
  const budget = LifecycleRecorder.prototype.budget;
  let first = true;
  vi.spyOn(LifecycleRecorder.prototype, "budget").mockImplementation(async function (
    this: LifecycleRecorder,
    args,
  ) {
    const event = await budget.call(this, args);
    if (
      first &&
      args.event === "BudgetReconciled" &&
      args.unit === "local_milliseconds" &&
      args.reservation.workItem === 8
    ) {
      first = false;
      // Same safe boundary as installed hold: ready artifact + success + actual
      // token/native receipts and backend cleanup, but no validator admission.
      throw new SafeArtifactCheckpointHeldError();
    }
    return event;
  });
  await expect(f.run()).rejects.toThrow(/qualification artifact checkpoint held/);
  expect(f.events().some((event) => event.event === "AttemptSucceeded")).toBe(true);
  expect(f.events().some((event) => event.event === "ValidationRecorded")).toBe(false);
  const retainedRefs = [...f.refs].filter(([ref]) => ref.includes("/artifact-transfers/"));
  expect(retainedRefs.some(([ref]) => ref.endsWith("/ready"))).toBe(true);
  const before = structuredClone(f.events());
  const runGit = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.repository, encoding: "utf8" }).trim();
  const competing = runGit(
    "-c",
    "core.hooksPath=/dev/null",
    "commit-tree",
    `${start.baseSha}^{tree}`,
    "-p",
    start.baseSha!,
    "-m",
    "unrelated externally committed branch advance",
  );
  if (advanceBase) f.refs.set("refs/heads/main", competing);
  const request = parseFactoryEvent({
    protocol: start.protocol,
    kind: "run",
    event: "FactoryRunCancellationRequested",
    objective: 7,
    runId: f.runId,
    sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
    at: new Date().toISOString(),
    requestedBy: "operator",
    requestId: "cancel-exact-existing-run",
  });
  if (request.event !== "FactoryRunCancellationRequested")
    throw new Error("fixture cancellation absent");
  const requestCancellation = (change: Record<string, unknown> = {}, author = "operator") => {
    const raw = parseFactoryEvent({ ...request, ...change });
    const authenticated = cancellationRequestFromComments(
      [
        {
          body: encodeEventComment("Cancel existing run", raw),
          authorLogin: author,
          authorAssociation: "OWNER",
        },
      ],
      f.runId,
      "operator",
    );
    if (authenticated) f.snapshot.factoryEvents!.push(authenticated);
    vi.mocked(GitHubReader.prototype.readRunCancellationRequest).mockResolvedValue(authenticated);
  };
  return {
    f,
    before,
    retainedRefs,
    requestCancellation,
    reconcile,
    unknown: () => {
      cleanupUnknown = true;
    },
  };
}

function assertNoContinuation(
  f: Fixture,
  before: FactoryEvent[],
  retainedRefs: [string, string][],
) {
  expect(
    f
      .events()
      .filter(
        (event) =>
          event.kind === "attempt" || event.kind === "validation" || event.kind === "publication",
      ),
  ).toEqual(
    before.filter(
      (event) =>
        event.kind === "attempt" || event.kind === "validation" || event.kind === "publication",
    ),
  );
  expect(f.events().filter((event) => event.kind === "budget")).toEqual(
    before.filter((event) => event.kind === "budget"),
  );
  expect([...f.refs].filter(([ref]) => ref.includes("/artifact-transfers/"))).toEqual(retainedRefs);
  expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
  expect(
    f.activity.filter((entry) => entry.operation === "review" || entry.operation === "validate"),
  ).toEqual([]);
}

function completedRemoteCapacity(f: Fixture) {
  const reserved = f
    .events()
    .find((event) => event.event === "AttemptReserved" && event.workItem === 8);
  if (reserved?.kind !== "attempt") throw new Error("fixture reservation missing");
  let sequence = Math.max(...f.events().map((event) => event.sequence));
  const identity = {
    protocol: reserved.protocol,
    kind: "capacity",
    objective: 7,
    runId: f.runId,
    workItem: 8,
    attempt: 1,
    phase: "validation",
    backend: "codex-cli/daytona",
    requestedCpu: 1,
    requestedMemoryMb: 1024,
    directorEpoch: reserved.directorEpoch,
    policyDigest: reserved.policyDigest,
    at: new Date().toISOString(),
  };
  f.snapshot.workItems[0]!.factoryEvents!.push(
    parseFactoryEvent({ ...identity, event: "CapacityReserved", sequence: ++sequence }),
    parseFactoryEvent({ ...identity, event: "CapacityReconciled", sequence: ++sequence }),
  );
  return sequence;
}

describe("cleanup-only cancellation of a stale activation", () => {
  it("preserves unchanged-base cancellation with previously reconciled remote validation", async () => {
    const h = await held(false);
    const sequence = completedRemoteCapacity(h.f);
    const calls = h.reconcile.mock.calls.length;
    h.requestCancellation({ sequence: sequence + 1 });
    expect(await h.f.run()).toMatchObject({ status: "cancelled", runId: h.f.runId });
    expect(h.reconcile).toHaveBeenCalledTimes(calls);
    assertNoContinuation(h.f, h.before, h.retainedRefs);
    expect(h.f.events().filter((event) => event.event === "FactoryRunCancelled")).toHaveLength(1);
  }, 30_000);

  it("does not waive unsupported remote cleanup merely because its capacity was reconciled", async () => {
    const h = await held();
    const sequence = completedRemoteCapacity(h.f);
    h.requestCancellation({ sequence: sequence + 1 });
    await expect(h.f.run()).rejects.toThrow(
      /validation resource lacks supported exact local scope ownership/,
    );
    assertNoContinuation(h.f, h.before, h.retainedRefs);
    expect(h.f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
  }, 30_000);

  it("retires exact existing resources before recovery and preserves paid work on external trunk", async () => {
    const h = await held();
    h.requestCancellation();
    const probe = vi.spyOn(h.f.management, "probe");
    expect(await h.f.run()).toMatchObject({ status: "cancelled", runId: h.f.runId });
    expect(h.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ runId: h.f.runId, workItem: 8, attempt: 1, phase: "execution" }),
    );
    expect(probe).not.toHaveBeenCalled();
    assertNoContinuation(h.f, h.before, h.retainedRefs);
    expect(h.f.events().filter((event) => event.event === "FactoryRunCancelled")).toHaveLength(1);
  }, 30_000);

  it.each(["no request", "foreign actor", "other run", "other requester"])(
    "does not grant stale-base resume for %s",
    async (kind) => {
      const h = await held();
      if (kind === "foreign actor") h.requestCancellation({}, "stranger");
      if (kind === "other run") h.requestCancellation({ runId: "another-run" });
      if (kind === "other requester") h.requestCancellation({ requestedBy: "stranger" });
      const calls = h.reconcile.mock.calls.length;
      expect(await h.f.run()).toMatchObject({
        status: "escalated",
        reason: expect.stringContaining("is stale"),
      });
      expect(h.reconcile).toHaveBeenCalledTimes(calls);
      assertNoContinuation(h.f, h.before, h.retainedRefs);
      expect(h.f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
    },
    30_000,
  );

  it("refuses mismatched activation identity before cleanup", async () => {
    const h = await held();
    h.requestCancellation();
    const activation = h.f.snapshot.factoryEvents!.find(
      (event) => event.event === "ActivationRequested",
    )!;
    if (activation.event !== "ActivationRequested") throw new Error("fixture activation absent");
    activation.baseSha = "f".repeat(40);
    const calls = h.reconcile.mock.calls.length;
    await expect(h.f.run()).rejects.toThrow(/exact authenticated activation/);
    expect(h.reconcile).toHaveBeenCalledTimes(calls);
    expect(h.f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
  }, 30_000);

  it("leaves terminal cancellation absent when exact resource cleanup is unknown", async () => {
    const h = await held();
    h.requestCancellation();
    h.unknown();
    await expect(h.f.run()).rejects.toThrow(/resource absence is unknown/);
    assertNoContinuation(h.f, h.before, h.retainedRefs);
    expect(h.f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
  }, 30_000);

  it("retires an interrupted exact local validation scope without inventing elapsed usage", async () => {
    const h = await held();
    const reserved = h.f
      .events()
      .find((event) => event.event === "AttemptReserved" && event.workItem === 8);
    const succeeded = h.f
      .events()
      .find((event) => event.event === "AttemptSucceeded" && event.workItem === 8);
    if (reserved?.kind !== "attempt" || !reserved.localScopeBatch || succeeded?.kind !== "attempt")
      throw new Error("exact fixture execution identity unavailable");
    let sequence = Math.max(...h.f.events().map((event) => event.sequence));
    const common = {
      protocol: reserved.protocol,
      objective: 7,
      runId: h.f.runId,
      workItem: 8,
      attempt: 1,
      directorEpoch: reserved.directorEpoch,
      policyDigest: reserved.policyDigest,
      at: new Date().toISOString(),
    };
    // Real admitted scope shape, interrupted before a command reports completion.
    // The distinct validation scope is physically absent; no elapsed sample exists.
    h.f.snapshot.workItems[0]!.factoryEvents!.push(
      parseFactoryEvent({
        ...common,
        kind: "capacity",
        event: "CapacityReserved",
        sequence: ++sequence,
        phase: "validation",
        backend: "factory/local-validation",
        requestedCpu: 1,
        requestedMemoryMb: 128,
        localScopeBatch: {
          ...reserved.localScopeBatch,
          deadline: new Date(Date.now() + 60_000).toISOString(),
          identity: {
            ...reserved.localScopeBatch.identity,
            phase: "validation",
            invocationDigest: succeeded.artifactDigest,
          },
        },
      }),
      parseFactoryEvent({
        ...common,
        kind: "budget",
        event: "BudgetReserved",
        sequence: ++sequence,
        phase: "validation",
        unit: "validation_milliseconds",
        amount: 60_000,
      }),
    );
    h.requestCancellation({ sequence: ++sequence });
    expect(await h.f.run()).toMatchObject({ status: "cancelled" });
    expect(unreconciledCapacityReservations(h.f.events())).toEqual([]);
    expect(unreconciledBudgetReservations(h.f.events())).toEqual([]);
    expect(
      h.f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.unit === "validation_milliseconds" &&
            event.event === "BudgetReconciled",
        ),
    ).toMatchObject([
      { amount: 60_000, usageEvidence: "conservative-reservation", phase: "validation" },
    ]);
    expect(h.f.events().some((event) => event.event === "ValidationRecorded")).toBe(false);
    expect(h.f.events().filter((event) => event.kind === "attempt")).toEqual(
      h.before.filter((event) => event.kind === "attempt"),
    );
    expect(
      h.f.activity.filter((entry) => ["launch", "validate", "review"].includes(entry.operation)),
    ).toEqual(h.f.activity.filter((entry) => entry.operation === "launch"));
    expect(h.f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
  }, 30_000);

  it("does not equate an unreported execution marker with zero usage on cancellation", async () => {
    const h = await held();
    for (const item of h.f.snapshot.workItems)
      item.factoryEvents = (item.factoryEvents ?? []).filter(
        (event) =>
          !(
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.unit === "model_tokens"
          ),
      );
    for (const event of h.f.snapshot.workItems[0]!.factoryEvents ?? [])
      if (event.kind === "attempt") {
        delete event.reportedModelTokens;
        delete event.reportedModelUsage;
      }
    h.requestCancellation();
    expect(await h.f.run()).toMatchObject({ status: "cancelled" });
    expect(
      unresolvedModelInvocations(h.f.events()).filter((event) => event.phase === "execution"),
    ).toHaveLength(1);
    expect(h.f.events().filter(isModelInvocationMarker)).toHaveLength(1);
    expect(
      h.f
        .events()
        .some(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.unit === "model_tokens",
        ),
    ).toBe(false);
  }, 30_000);
});
