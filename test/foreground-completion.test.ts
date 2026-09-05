import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { attemptRef } from "../src/control/attempts.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { durableAttemptId } from "../src/execution/session.js";
import { workerPacketFromCompiled, type CompiledObjective } from "../src/graph.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { workerPacketDigest } from "../src/protocol/worker-packet.js";
import type { LocalScopeBatch } from "../src/protocol/local-scope.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { deriveForegroundCompletion } from "../src/recovery/foreground-completion.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "../src/recovery/identity.js";
import {
  parseRecoveryPlan,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  type RecoveryPlan,
} from "../src/recovery/plan.js";
import { verifyRecoveryProposalResources } from "../src/recovery/resources.js";
import {
  observeCompletedForegroundScopeBatch,
  observeLocalScopeBatch,
} from "../src/recovery/scope-resources.js";
import { localScopeUnit, type LocalScopeReadPort } from "../src/runtime/local-scope.js";

const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const now = new Date("2026-09-05T00:00:00Z");
const policy = structuredClone(DEFAULT_RUN_POLICY);
const pd = policyDigest(policy);

async function fixture(backend = "codex-sdk/local-worktree") {
  const refs = new Map<string, string>(),
    commits = new Map<string, GitCommitObject>(),
    blobs = new Map<string, Buffer>(),
    trees = new Map<string, Map<string, string>>();
  let counter = 0;
  const next = () => createHash("sha1").update(`fixture-${counter++}`).digest("hex");
  const base: GitCommitObject = {
    oid: sha("a"),
    treeOid: sha("b"),
    parentOids: [],
    message: "base",
    serverTime: now,
  };
  commits.set(base.oid, base);
  const storage: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (oid) => {
      const c = commits.get(oid);
      if (!c) throw new Error("missing commit");
      return c;
    },
    readBlob: async (oid) => {
      const b = blobs.get(oid);
      if (!b) throw new Error("missing blob");
      return b;
    },
    readTreeEntry: async (oid, path) => trees.get(oid)?.get(path) ?? null,
    createBlob: async (b) => {
      const oid = next();
      blobs.set(oid, b);
      return oid;
    },
    createTree: async ({ entries }) => {
      const oid = next();
      trees.set(oid, new Map(entries.filter((e) => e.sha).map((e) => [e.path, e.sha!])));
      return oid;
    },
    createCommit: async (args) => {
      const oid = next();
      commits.set(oid, { ...args, oid, serverTime: now });
      return oid;
    },
    createRef: async (ref, oid) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
  };
  const lease: LeaseState = {
    objective: 7,
    runId: "source",
    holder: "operator",
    policyDigest: pd,
    ref: "lease",
    oid: sha("f"),
    treeOid: base.treeOid,
    epoch: 1,
    sequence: 1,
    expiresAt: now,
  };
  const objective: CompiledObjective = {
    title: "Fixture",
    workItems: [
      {
        id: "work",
        title: "Work",
        goal: "Implement work",
        acceptance: ["passes"],
        scope: ["src/work.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: base.oid,
        validationCommands: ["node --test test/work.test.js"],
        requirements: {
          os: [],
          architecture: [],
          tools: ["node"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
  const manager = new CompiledGraphManager(storage, {
    assertCurrent: async () => {},
  } as unknown as LeaseManager);
  const graph = await manager.persist({ lease, base, objective });
  const projection = await manager.persistProjection({
    lease,
    graph,
    bindings: [{ compilerId: "work", issueNodeId: "I_8", issueNumber: 8 }],
  });
  const execution: LocalScopeBatch = {
    identity: {
      protocol: "clockgrove.factory/local-scope-v1",
      repository: "o/r",
      objective: 7,
      runId: "source",
      workItem: 8,
      attempt: 1,
      directorEpoch: 1,
      policyDigest: pd,
      phase: "execution",
      commandIndex: 0,
      invocationDigest: workerPacketDigest(workerPacketFromCompiled(objective.workItems[0]!)),
      hostIdentity: digest("c"),
    },
    commandCount: 1,
    producerPid: 123,
    producerStartTicks: "456",
    deadline: "2026-09-05T00:45:00Z",
  };
  const validation: LocalScopeBatch = {
    ...structuredClone(execution),
    identity: { ...execution.identity, phase: "validation", invocationDigest: digest("d") },
    commandCount: 2,
  };
  const events: FactoryEvent[] = [];
  const add = (sequence: number, fields: Record<string, unknown>) => {
    const e = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: "source",
      at: now.toISOString(),
      sequence,
      ...fields,
    });
    events.push(e);
    return e;
  };
  add(1, {
    kind: "run",
    event: "FactoryRunStarted",
    actor: "operator",
    objectiveAuthor: "operator",
    repository: "o/r",
    fork: false,
    baseBranch: "main",
    baseSha: base.oid,
    policy,
    policyDigest: pd,
  });
  add(2, {
    kind: "graph",
    event: "GraphCompiled",
    graphDigest: graph.graphDigest,
    graphSize: 1,
    baseSha: base.oid,
    graphRef: graph.ref,
    graphBlobSha: graph.blobOid,
  });
  add(3, {
    kind: "graph",
    event: "GraphProjected",
    graphDigest: graph.graphDigest,
    graphSize: 1,
    projectionRef: projection.ref,
    projectionBlobSha: projection.blobOid,
  });
  const attempt = (sequence: number, event: string, fields: Record<string, unknown> = {}) =>
    add(sequence, {
      kind: "attempt",
      event,
      workItem: 8,
      attempt: 1,
      backend,
      baseSha: base.oid,
      directorEpoch: 1,
      policyDigest: pd,
      ...fields,
    });
  const budget = (
    sequence: number,
    event: string,
    phase: string,
    unit: string,
    amount: number,
    fields: Record<string, unknown> = {},
  ) =>
    add(sequence, {
      kind: "budget",
      event,
      workItem: 8,
      attempt: 1,
      phase,
      unit,
      amount,
      ...fields,
    });
  // Captured ordinary source order: cap22 -> collected24 -> validation26.
  const reserved = attempt(9, "AttemptReserved", { localScopeBatch: execution });
  const reservationOid = next();
  const writeReservation = () =>
    commits.set(reservationOid, {
      oid: reservationOid,
      treeOid: base.treeOid,
      parentOids: [base.oid],
      message: encodeEventTrailer(reserved),
      serverTime: now,
    });
  writeReservation();
  refs.set(attemptRef(7, 8, 1), reservationOid);
  budget(10, "BudgetReserved", "execution", "local_milliseconds", 100000);
  attempt(13, "AttemptStarted", {
    providerResourceId: backend.startsWith("codex-sdk")
      ? `sdk-${durableAttemptId({ repository: "o/r", objective: 7, workItem: 8, attempt: 1, runId: "source", directorEpoch: 1 }).slice(0, 24)}`
      : "local-987",
    resourceHostIdentity: execution.identity.hostIdentity,
  });
  budget(16, "BudgetReconciled", "execution", "model_tokens", 43965, { usageId: "worker-8-1" });
  attempt(18, "AttemptSucceeded", { artifactDigest: digest("d"), reportedModelTokens: 43965 });
  budget(20, "BudgetReconciled", "execution", "local_milliseconds", 71980);
  const capacityFields = {
    kind: "capacity",
    workItem: 8,
    attempt: 1,
    backend: "factory/local-validation",
    phase: "validation",
    directorEpoch: 1,
    policyDigest: pd,
    requestedCpu: 1,
    requestedMemoryMb: 512,
  };
  add(22, { ...capacityFields, event: "CapacityReserved", localScopeBatch: validation });
  attempt(24, "AttemptCollected", { artifactDigest: digest("d") });
  add(26, {
    kind: "validation",
    event: "ValidationRecorded",
    workItem: 8,
    attempt: 1,
    baseSha: base.oid,
    outputTreeSha: sha("e"),
    passed: true,
    evidenceDigest: digest("e"),
  });
  add(28, { ...capacityFields, event: "CapacityReconciled" });
  budget(29, "BudgetReconciled", "validation", "validation_milliseconds", 11912);
  attempt(33, "AttemptValidated", { artifactDigest: digest("d") });
  add(40, { kind: "run", event: "FactoryRunEscalated", reason: "unrelated delivery gate" });
  const items: RecoveryPlan["items"] = [
    {
      workItem: 8,
      issueNodeId: "I_8",
      compilerId: "work",
      action: "reconcile",
      source: {
        runId: "source",
        attempt: 1,
        reservationRef: attemptRef(7, 8, 1),
        reservationCommitOid: reservationOid,
        reservationReceiptDigest: recoveryEventDigest(reserved),
        artifactDigest: digest("d"),
        validation: {
          receiptDigest: recoveryEventDigest(events.find((e) => e.kind === "validation")!),
          evidenceDigest: digest("e"),
          baseSha: base.oid,
          outputTreeSha: sha("e"),
        },
        review: null,
        publication: null,
      },
      observedPullRequest: null,
      resources: { state: "unknown", receiptDigest: null, identities: [] },
    },
  ];
  const allowance = {
    modelTokens: null,
    sandboxMinutes: 0,
    managedSessions: 0,
    implementationAttemptsPerItem: policy.maxAttemptsPerItem,
  };
  const history = [
    {
      runId: "source",
      startDigest: recoveryEventDigest(events[0]!),
      terminalDigest: recoveryEventDigest(events.at(-1)!),
      terminalEvent: "FactoryRunEscalated" as const,
      terminalSequence: 40,
      policyDigest: pd,
    },
  ];
  const plan: RecoveryPlan = {
    protocol: "clockgrove.factory/recovery-plan-v1",
    repository: "o/r",
    repositoryId: "R_1",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "request",
    successorRunId: "successor",
    predecessor: {
      runId: "source",
      startDigest: history[0]!.startDigest,
      terminalDigest: history[0]!.terminalDigest,
      terminalEvent: "FactoryRunEscalated",
      terminalSequence: 40,
    },
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 7,
      runIds: ["source"],
      events,
      maxSequence: 40,
    }),
    sourceEventMaxSequence: 40,
    priorPlanDigest: null,
    expectedBaseSha: base.oid,
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: graph.ref,
      commitOid: graph.commitOid,
      blobOid: graph.blobOid,
      digest: graph.graphDigest,
      projection: {
        ref: projection.ref,
        commitOid: projection.commitOid,
        blobOid: projection.blobOid,
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: policy,
    policyDigest: pd,
    allowance: {
      before: allowance,
      increment: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 0,
      },
      after: allowance,
    },
    unknownUsageAcknowledgementDigest: null,
    items,
  };
  parseRecoveryPlan(plan);
  const store = {
    ...storage,
    listRefs: async (prefix: string) =>
      [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, oid]) => ({ ref, oid })),
    readPullRequest: async () => null,
    readDefaultBranch: async () => ({ branch: "main", commit: base }),
  } as unknown as RecoveryReadStore;
  const rebind = () => {
    plan.sourceEventsDigest = recoverySourceEventsDigest({
      objective: 7,
      runIds: ["source"],
      events,
      maxSequence: 40,
    });
    const v = events.find((e) => e.kind === "validation");
    if (v) items[0]!.source!.validation!.receiptDigest = recoveryEventDigest(v);
    items[0]!.source!.reservationReceiptDigest = recoveryEventDigest(reserved);
    writeReservation();
  };
  const read = vi.fn(async (_path: string): Promise<string> => {
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  });
  const show = vi.fn(async (unit: string) =>
    Object.entries({
      Id: unit,
      LoadState: "not-found",
      ActiveState: "inactive",
      SubState: "dead",
      ControlGroup: "",
      Job: "",
      InvocationID: "",
      KillMode: "control-group",
    })
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const hostIdentity = vi.fn(async () => execution.identity.hostIdentity);
  const port: LocalScopeReadPort = { read, show, hostIdentity, now: () => new Date() };
  return {
    plan,
    events,
    store,
    execution,
    validation,
    reserved,
    rebind,
    port,
    read,
    show,
    hostIdentity,
  };
}

describe("completed original foreground invocation witness", () => {
  it.each(["codex-sdk/local-worktree", "codex-cli/local-worktree"])(
    "verifies exact captured %s chain without invented validation fields",
    async (backend) => {
      const f = await fixture(backend);
      f.events.push(structuredClone(f.reserved)); // same comment + immutable-ref envelope
      expect(await deriveForegroundCompletion({ ...f, batch: f.execution })).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(await observeLocalScopeBatch(f.execution, f.port)).toMatchObject({
        status: "unknown",
      });
      f.show.mockClear();
      expect(await verifyRecoveryProposalResources({ ...f, scopePort: f.port })).toMatchObject({
        status: "verified",
        blockers: [],
      });
      const units = [
        localScopeUnit(f.execution.identity),
        localScopeUnit(f.validation.identity),
        localScopeUnit({ ...f.validation.identity, commandIndex: 1 }),
      ];
      // Each scope observation itself rechecks the manager, in both batch passes.
      expect(f.show.mock.calls.map(([u]) => u).sort()).toEqual(
        units.flatMap((u) => [u, u, u, u]).sort(),
      );
      expect(f.events.find((e) => e.kind === "validation")).not.toHaveProperty("commands");
      expect(f.events.find((e) => e.event === "CapacityReconciled")).not.toHaveProperty(
        "localScopeBatch",
      );
    },
  );
  it.each([
    "AttemptSucceeded",
    "AttemptCollected",
    "BudgetReserved",
    "ValidationRecorded",
    "CapacityReconciled",
  ])("rejects missing %s even with a rebound history digest", async (event) => {
    const f = await fixture();
    f.events.splice(
      f.events.findIndex((e) => e.event === event),
      1,
    );
    f.rebind();
    expect(
      await observeCompletedForegroundScopeBatch({ ...f, batch: f.execution }, f.port),
    ).toMatchObject({ status: "unknown" });
    expect(f.show).not.toHaveBeenCalled();
  });
  it.each([
    "unknown-model",
    "cleanup-order",
    "failed-validation",
    "wrong-capacity-policy",
    "extra-capacity",
    "extra-accounting",
    "packet-mismatch",
    "wrong-slot-count",
    "wrong-resource",
    "unbound-history",
  ])("blocks %s", async (mode) => {
    const f = await fixture();
    const event = (name: string) => f.events.find((e) => e.event === name)!;
    if (mode === "unknown-model")
      f.events.splice(
        f.events.findIndex((e) => e.kind === "budget" && e.unit === "model_tokens"),
        1,
      );
    if (mode === "cleanup-order") event("AttemptCollected").sequence = 19;
    if (mode === "failed-validation") Object.assign(event("ValidationRecorded"), { passed: false });
    if (mode === "wrong-capacity-policy")
      Object.assign(event("CapacityReconciled"), { policyDigest: digest("f") });
    if (mode === "extra-capacity") f.events.push({ ...event("CapacityReserved"), sequence: 30 });
    if (mode === "extra-accounting")
      f.events.push(
        parseFactoryEvent({
          ...f.events.find((e) => e.kind === "budget" && e.unit === "model_tokens"),
          sequence: 30,
          usageId: "other-worker",
        }),
      );
    if (mode === "packet-mismatch") {
      f.execution.identity.invocationDigest = digest("f");
      Object.assign(event("AttemptReserved"), { localScopeBatch: f.execution });
    }
    if (mode === "wrong-slot-count")
      Object.assign(event("CapacityReserved"), {
        localScopeBatch: { ...f.validation, commandCount: 1 },
      });
    if (mode === "wrong-resource")
      Object.assign(event("AttemptStarted"), { providerResourceId: "sdk-wrong" });
    if (mode !== "unbound-history") f.rebind();
    else event("AttemptSucceeded").at = "2026-09-05T00:01:00Z";
    expect(
      await observeCompletedForegroundScopeBatch({ ...f, batch: f.execution }, f.port),
    ).toMatchObject({ status: "unknown" });
    expect(f.show).not.toHaveBeenCalled();
  });
  it("does not lose an orphan validation invocation outside reservation partitions", async () => {
    const f = await fixture();
    f.events.push(
      parseFactoryEvent({
        ...f.events.find((e) => e.event === "CapacityReserved"),
        workItem: 9,
        localScopeBatch: { ...f.validation, identity: { ...f.validation.identity, workItem: 9 } },
        sequence: 30,
      }),
    );
    f.rebind();
    expect(await verifyRecoveryProposalResources({ ...f, scopePort: f.port })).toMatchObject({
      status: "blocked",
      blockers: ["orphan-validation-resource"],
    });
    expect(f.show).not.toHaveBeenCalled();
  });
  it("requires the exact immutable reservation even with complete authentic receipts", async () => {
    const f = await fixture();
    const original = f.store.readCommit.bind(f.store);
    f.store.readCommit = async (oid) => {
      const commit = await original(oid);
      return oid === f.plan.items[0]!.source!.reservationCommitOid
        ? { ...commit, message: "unbound reservation" }
        : commit;
    };
    expect(
      await observeCompletedForegroundScopeBatch({ ...f, batch: f.execution }, f.port),
    ).toMatchObject({ status: "unknown" });
    expect(f.show).not.toHaveBeenCalled();
  });
  it.each([
    "live-producer",
    "denied-producer",
    "changed-host",
    "second-pass-unknown",
    "second-pass-reappeared",
  ])("retains liability for %s after complete receipts", async (mode) => {
    const f = await fixture();
    if (mode === "live-producer")
      f.read.mockResolvedValue(
        `123 (producer) ${["S", ...Array<string>(18).fill("0"), "456", "0"].join(" ")}`,
      );
    if (mode === "denied-producer")
      f.read.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    if (mode === "changed-host") f.hostIdentity.mockResolvedValue(digest("f"));
    if (mode.startsWith("second-pass")) {
      const original = f.show.getMockImplementation()!;
      let reads = 0;
      f.show.mockImplementation(async (unit) => {
        if (++reads <= 2) return original(unit);
        if (mode === "second-pass-unknown") throw new Error("manager unavailable");
        return (await original(unit)).replace("Job=\n", "Job=77 /job/77\n");
      });
    }
    expect(
      (await observeCompletedForegroundScopeBatch({ ...f, batch: f.execution }, f.port)).status,
    ).not.toBe("absent");
    if (mode.startsWith("second-pass")) expect(f.show).toHaveBeenCalledTimes(3);
  });
});
