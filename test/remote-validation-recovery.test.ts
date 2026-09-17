import { describe, expect, it, vi } from "vitest";

import {
  inspectRemoteValidationEventChain,
  runRemoteValidationInvocationTransaction,
} from "../src/validation/remote-invocation-recovery.js";
import { inspectLocalValidationScopeReboundChain } from "../src/validation/local-invocation-recovery.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { createValidationInvocation } from "../src/validation/repository-capture.js";
import { DEFAULT_REPOSITORY_CAPTURE_EGRESS_POLICY } from "../src/protocol/policy.js";
import {
  hasExactWriterAuthority,
  hasHistoricalWriterAuthority,
  writerAuthority,
} from "../src/control/authority.js";
import { localScopeBatchDigest } from "../src/protocol/local-scope.js";

const providers = ["codex-cli/daytona", "codex-cli/vercel-sandbox"] as const;
const deadline = "2026-09-17T00:10:00.000Z";
const fence = "2026-09-17T00:01:00.000Z";
const writer = {
  objective: 418,
  runId: "remote-recovery",
  holder: "director",
  policyDigest: "5".repeat(64),
  ref: "refs/factory/lease",
  oid: "a".repeat(40),
  treeOid: "b".repeat(40),
  epoch: 1,
  sequence: 9,
  expiresAt: new Date("2026-09-17T01:00:00.000Z"),
};
const authority = {
  objective: writer.objective,
  runId: writer.runId,
  holder: writer.holder,
  epoch: writer.epoch,
  policyDigest: writer.policyDigest,
  sequence: writer.sequence,
  oid: writer.oid,
  expiresAt: writer.expiresAt,
  observedAt: new Date("2026-09-17T00:00:00.000Z"),
};

it("requires the final prepared/dispatch/rebound authority and exact visibility chain", () => {
  const common = {
    protocol: "clockgrove.factory/v2" as const,
    kind: "validation-invocation" as const,
    objective: 418,
    runId: "remote-recovery",
    workItem: 7,
    attempt: 1,
    reservationOid: "1".repeat(40),
    artifactDigest: "2".repeat(64),
    invocationDigest: "3".repeat(64),
    backend: "codex-cli/daytona",
    validationDeadline: deadline,
    capacityReservationSequence: 10,
    ...writerAuthority(writer, 12),
  };
  expect(
    parseFactoryEvent({
      ...common,
      event: "ValidationInvocationPrepared",
      sequence: 11,
      ...writerAuthority(writer, 11),
      at: "2026-09-17T00:00:00.000Z",
      reservationRef: "refs/clockgrove-factory/attempts/418/7/1",
      reservationReceiptDigest: "4".repeat(64),
      attemptDirectorEpoch: 1,
      attemptPolicyDigest: "5".repeat(64),
      baseSha: "6".repeat(40),
      outputTreeSha: "7".repeat(40),
      invocationRef: "refs/clockgrove-factory/validation-invocations/test/intent",
      invocationCommitOid: "8".repeat(40),
      backendLocator: "image@sha256:" + "9".repeat(64),
    }).event,
  ).toBe("ValidationInvocationPrepared");
  const dispatch = {
    ...common,
    event: "ValidationInvocationRemoteDispatchStarted" as const,
    sequence: 12,
    ...writerAuthority(writer, 12),
    at: "2026-09-17T00:00:00.000Z",
    resourceName: "factory-candidate-exact",
    requestIdentityDigest: "a".repeat(64),
    noHandleReplacementNotBefore: fence,
  };
  expect(parseFactoryEvent(dispatch).event).toBe("ValidationInvocationRemoteDispatchStarted");
  const rebound = {
    ...dispatch,
    event: "ValidationInvocationRemoteRebound" as const,
    sequence: 13,
    ...writerAuthority(writer, 13),
    at: fence,
    originalDispatchSequence: dispatch.sequence,
  };
  expect(parseFactoryEvent(rebound).event).toBe("ValidationInvocationRemoteRebound");
  const settled = {
    ...dispatch,
    event: "ValidationInvocationRemoteSettled" as const,
    sequence: 14,
    ...writerAuthority(writer, 14),
    at: fence,
    originalDispatchSequence: dispatch.sequence,
    reboundSequence: rebound.sequence,
    settlementEvidence: "provider-cleanup" as const,
  };
  expect(parseFactoryEvent(settled).event).toBe("ValidationInvocationRemoteSettled");
  expect(() =>
    parseFactoryEvent({
      ...dispatch,
      noHandleReplacementNotBefore: "2026-09-17T00:00:59.999Z",
    }),
  ).toThrow(/visibility fence/);
  const { validationDeadline: _deadline, ...missingFinalAuthority } = dispatch;
  expect(() => parseFactoryEvent(missingFinalAuthority)).toThrow();
  const {
    writerEpoch: _writerEpoch,
    writerOperationId: _writerOperationId,
    writerHolder: _writerHolder,
    writerPolicyDigest: _writerPolicyDigest,
    ...writerless
  } = dispatch;
  expect(() => parseFactoryEvent(writerless)).toThrow();
  const {
    writerEpoch: _reboundWriterEpoch,
    writerOperationId: _reboundWriterOperationId,
    writerHolder: _reboundWriterHolder,
    writerPolicyDigest: _reboundWriterPolicyDigest,
    ...writerlessRebound
  } = rebound;
  expect(() => parseFactoryEvent(writerlessRebound)).toThrow();
  const {
    writerEpoch: _settledWriterEpoch,
    writerOperationId: _settledWriterOperationId,
    writerHolder: _settledWriterHolder,
    writerPolicyDigest: _settledWriterPolicyDigest,
    ...writerlessSettlement
  } = settled;
  expect(() => parseFactoryEvent(writerlessSettlement)).toThrow();
});

function ports(args: {
  now?: string;
  intent?: boolean;
  dispatch?: boolean;
  rebound?: boolean;
  settled?: boolean;
  result?: string | null;
  observation?: string | null;
  observeResource?: () => Promise<string | null>;
  cleanupObservation?: "cleaned" | "absent";
  cleanupResource?: () => Promise<"cleaned" | "absent">;
  terminalFailure?: () => Promise<string>;
  launch?: () => Promise<string>;
  replayReplacement?: (() => Promise<string>) | null;
  afterPersistRebound?: () => Promise<void>;
}) {
  const stages: string[] = [];
  const dispatch = { noHandleReplacementNotBefore: fence };
  let dispatched = args.dispatch ?? false;
  let rebound = args.rebound ?? false;
  let settled = args.settled ?? false;
  let durableResult = args.result ?? null;
  return {
    stages,
    dispatch,
    input: {
      validationDeadline: deadline,
      now: async () => new Date(args.now ?? "2026-09-17T00:00:30.000Z"),
      observeResult: async () => durableResult,
      observeIntent: async () => args.intent ?? true,
      persistIntent: async () => {
        stages.push("intent");
      },
      observeDispatch: async () => ({
        ...(dispatched ? { dispatch } : {}),
        rebound,
        settled,
      }),
      persistDispatch: async () => {
        stages.push("dispatch");
        dispatched = true;
        return dispatch;
      },
      observeResource:
        args.observeResource ??
        (async () => {
          stages.push("observe");
          return args.observation ?? null;
        }),
      cleanupResource:
        args.cleanupResource ??
        (async () => {
          stages.push("cleanup");
          return args.cleanupObservation ?? "absent";
        }),
      terminalDeadlineFailure:
        args.terminalFailure ??
        (async () => {
          stages.push("terminal");
          return "deadline-failure";
        }),
      persistRebound: async () => {
        stages.push("rebound");
        rebound = true;
        await args.afterPersistRebound?.();
      },
      persistSettlement: async (_dispatch: typeof dispatch, evidence: string) => {
        stages.push(`settle-${evidence}`);
        settled = true;
      },
      launch:
        args.launch ??
        (async () => {
          stages.push("launch");
          return "launched";
        }),
      ...(args.replayReplacement === null
        ? {}
        : {
            replayReplacement:
              args.replayReplacement ??
              (async () => {
                stages.push("replay");
                return "launched";
              }),
          }),
      persistResult: async (result: string) => {
        stages.push("result");
        durableResult = result;
        return result;
      },
    },
  };
}

function authenticatedChainFixture() {
  const reservation = {
    ref: "refs/clockgrove-factory/attempts/objective-418/work-item-7/attempt-1",
    oid: "1".repeat(40),
    objective: 418,
    workItem: 7,
    attempt: 1,
    backend: "codex-cli/daytona",
    baseSha: "6".repeat(40),
    runId: writer.runId,
    directorEpoch: 1,
    policyDigest: writer.policyDigest,
    sequence: 1,
    receiptDigest: "4".repeat(64),
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
  };
  const invocation = createValidationInvocation({
    protocol: "clockgrove.factory/validation-invocation",
    repository: "clockgrove/factory",
    objective: reservation.objective,
    runId: reservation.runId,
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    attemptAuthority: {
      reservationRef: reservation.ref,
      reservationOid: reservation.oid,
      reservationReceiptDigest: reservation.receiptDigest,
      directorEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
    },
    validationDeadline: deadline,
    artifactDigest: "2".repeat(64),
    baseSha: reservation.baseSha,
    outputTreeSha: "7".repeat(40),
    validationCommands: ["npm test"],
    repositoryCaptureRecipes: [],
    captureOutputAuthorities: [],
    comparisonAuthorities: [],
    mediaInputs: [],
    egressPolicy: DEFAULT_REPOSITORY_CAPTURE_EGRESS_POLICY,
    toolEnvironment: {
      backendId: reservation.backend,
      backendLocator: `image@sha256:${"9".repeat(64)}`,
      environmentIdentity: `image@sha256:${"9".repeat(64)}`,
      egress: "third-party",
      toolReceiptDigests: [],
    },
  });
  const capacity = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "capacity",
    event: "CapacityReserved",
    ...writerAuthority(writer, 10),
    objective: reservation.objective,
    runId: reservation.runId,
    sequence: 10,
    at: "2026-09-17T00:00:00.000Z",
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    phase: "validation",
    backend: reservation.backend,
    requestedCpu: 1,
    requestedMemoryMb: 512,
    directorEpoch: reservation.directorEpoch,
    policyDigest: reservation.policyDigest,
  });
  if (capacity.kind !== "capacity") throw new Error("fixture capacity did not parse");
  const prepared = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "validation-invocation",
    event: "ValidationInvocationPrepared",
    ...writerAuthority(writer, 11),
    objective: reservation.objective,
    runId: reservation.runId,
    sequence: 11,
    at: "2026-09-17T00:00:00.000Z",
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    reservationRef: reservation.ref,
    reservationOid: reservation.oid,
    reservationReceiptDigest: reservation.receiptDigest,
    attemptDirectorEpoch: reservation.directorEpoch,
    attemptPolicyDigest: reservation.policyDigest,
    validationDeadline: deadline,
    capacityReservationSequence: capacity.sequence,
    artifactDigest: invocation.artifactDigest,
    baseSha: invocation.baseSha,
    outputTreeSha: invocation.outputTreeSha,
    invocationDigest: invocation.digest,
    invocationRef: "refs/clockgrove-factory/validation-invocations/test/intent",
    invocationCommitOid: "8".repeat(40),
    backend: invocation.toolEnvironment.backendId,
    backendLocator: invocation.toolEnvironment.backendLocator,
  });
  const dispatch = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "validation-invocation",
    event: "ValidationInvocationRemoteDispatchStarted",
    ...writerAuthority(writer, 12),
    objective: reservation.objective,
    runId: reservation.runId,
    sequence: 12,
    at: "2026-09-17T00:00:00.000Z",
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    reservationOid: reservation.oid,
    artifactDigest: invocation.artifactDigest,
    invocationDigest: invocation.digest,
    backend: reservation.backend,
    resourceName: "factory-candidate-exact",
    requestIdentityDigest: "a".repeat(64),
    validationDeadline: deadline,
    noHandleReplacementNotBefore: fence,
    capacityReservationSequence: capacity.sequence,
  });
  const rebound = parseFactoryEvent({
    ...dispatch,
    event: "ValidationInvocationRemoteRebound",
    sequence: 13,
    ...writerAuthority(writer, 13),
    at: fence,
    originalDispatchSequence: dispatch.sequence,
  });
  const settled = parseFactoryEvent({
    ...dispatch,
    event: "ValidationInvocationRemoteSettled",
    sequence: 14,
    ...writerAuthority(writer, 14),
    at: fence,
    originalDispatchSequence: dispatch.sequence,
    reboundSequence: rebound.sequence,
    settlementEvidence: "provider-cleanup",
  });
  return {
    reservation,
    invocation,
    capacity,
    prepared,
    dispatch,
    rebound,
    settled,
    resourceIdentity: {
      resourceName: "factory-candidate-exact",
      requestIdentityDigest: "a".repeat(64),
    },
  };
}

it("authenticates the remote chain against exact current writer and immutable authority", () => {
  const fixture = authenticatedChainFixture();
  const {
    writerEpoch: _preparedWriterEpoch,
    writerOperationId: _preparedWriterOperationId,
    writerHolder: _preparedWriterHolder,
    writerPolicyDigest: _preparedWriterPolicyDigest,
    ...writerlessPrepared
  } = fixture.prepared;
  expect(() => parseFactoryEvent(writerlessPrepared)).toThrow();
  const inspect = (events: ReturnType<typeof parseFactoryEvent>[]) =>
    inspectRemoteValidationEventChain({
      ...fixture,
      events,
      isWriterAuthorized: (event) => hasExactWriterAuthority(event, authority),
    });
  expect(inspect([fixture.capacity, fixture.prepared, fixture.dispatch]).dispatch?.sequence).toBe(
    fixture.dispatch.sequence,
  );
  const forgedWriter = parseFactoryEvent({
    ...fixture.dispatch,
    writerOperationId: "f".repeat(64),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, forgedWriter])).toThrow(
    /unauthenticated writer authority/,
  );
  const forgedRequest = parseFactoryEvent({
    ...fixture.dispatch,
    requestIdentityDigest: "b".repeat(64),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, forgedRequest])).toThrow(
    /differs from immutable authority/,
  );
});

it("accepts monotonic Director takeover chains and refuses forged or regressing generations", () => {
  const fixture = authenticatedChainFixture();
  const directorB = { ...writer, holder: "director-b", epoch: 2 };
  const directorC = { ...writer, holder: "director-c", epoch: 3 };
  const observation = (lease: typeof writer) => ({
    ...authority,
    holder: lease.holder,
    epoch: lease.epoch,
  });
  const authored = (event: ReturnType<typeof parseFactoryEvent>, lease: typeof writer) =>
    parseFactoryEvent({ ...event, ...writerAuthority(lease, event.sequence) });
  const inspect = (events: ReturnType<typeof parseFactoryEvent>[], current: typeof writer) =>
    inspectRemoteValidationEventChain({
      ...fixture,
      events,
      isWriterAuthorized: (event) => hasHistoricalWriterAuthority(event, observation(current)),
    });

  const reboundB = authored(fixture.rebound, directorB);
  const settledB = authored(fixture.settled, directorB);
  expect(
    inspect([fixture.capacity, fixture.prepared, fixture.dispatch, reboundB, settledB], directorB)
      .settled?.writerHolder,
  ).toBe("director-b");

  const dispatchB = authored(fixture.dispatch, directorB);
  const reboundC = authored(fixture.rebound, directorC);
  const settledC = authored(fixture.settled, directorC);
  expect(
    inspect([fixture.capacity, fixture.prepared, dispatchB, reboundC, settledC], directorC).settled
      ?.writerHolder,
  ).toBe("director-c");

  const future = authored(fixture.dispatch, { ...writer, holder: "director-d", epoch: 4 });
  expect(() => inspect([fixture.capacity, fixture.prepared, future], directorC)).toThrow(
    /unauthenticated writer authority/,
  );
  const wrongPolicy = authored(fixture.dispatch, {
    ...directorB,
    policyDigest: "e".repeat(64),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, wrongPolicy], directorC)).toThrow(
    /unauthenticated writer authority/,
  );
  const wrongCurrentHolder = authored(fixture.dispatch, {
    ...directorC,
    holder: "not-director-c",
  });
  expect(() =>
    inspect([fixture.capacity, fixture.prepared, wrongCurrentHolder], directorC),
  ).toThrow(/unauthenticated writer authority/);
  const forgedOperation = parseFactoryEvent({
    ...dispatchB,
    writerOperationId: "f".repeat(64),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, forgedOperation], directorC)).toThrow(
    /unauthenticated writer authority/,
  );
  const regressingRebound = authored(fixture.rebound, writer);
  expect(() =>
    inspect([fixture.capacity, fixture.prepared, dispatchB, regressingRebound], directorC),
  ).toThrow(/writer generation chain regressed/);
  const regressingSettlement = authored(
    parseFactoryEvent({ ...fixture.settled, reboundSequence: null }),
    writer,
  );
  expect(() =>
    inspect([fixture.capacity, fixture.prepared, dispatchB, regressingSettlement], directorC),
  ).toThrow(/writer generation chain regressed/);
  const preparedB = authored(fixture.prepared, directorB);
  expect(() => inspect([fixture.capacity, preparedB, dispatchB], directorC)).toThrow(
    /preparation differs from its capacity writer/,
  );
  const changedHistoricalHolder = authored(fixture.dispatch, {
    ...writer,
    holder: "other-director-a",
  });
  expect(() =>
    inspect([fixture.capacity, fixture.prepared, changedHistoricalHolder], directorC),
  ).toThrow(/changed holder/);
});

function authenticatedLocalChainFixture() {
  const reservation = {
    ref: "refs/clockgrove-factory/attempts/objective-418/work-item-7/attempt-1",
    oid: "1".repeat(40),
    objective: 418,
    workItem: 7,
    attempt: 1,
    backend: "codex-cli/local-worktree",
    baseSha: "6".repeat(40),
    runId: writer.runId,
    directorEpoch: 1,
    policyDigest: writer.policyDigest,
    sequence: 1,
    receiptDigest: "4".repeat(64),
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
  };
  const invocation = createValidationInvocation({
    protocol: "clockgrove.factory/validation-invocation",
    repository: "clockgrove/factory",
    objective: reservation.objective,
    runId: reservation.runId,
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    attemptAuthority: {
      reservationRef: reservation.ref,
      reservationOid: reservation.oid,
      reservationReceiptDigest: reservation.receiptDigest,
      directorEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
    },
    validationDeadline: deadline,
    artifactDigest: "2".repeat(64),
    baseSha: reservation.baseSha,
    outputTreeSha: "7".repeat(40),
    validationCommands: ["npm test"],
    repositoryCaptureRecipes: [],
    captureOutputAuthorities: [],
    comparisonAuthorities: [],
    mediaInputs: [],
    egressPolicy: DEFAULT_REPOSITORY_CAPTURE_EGRESS_POLICY,
    toolEnvironment: {
      backendId: "factory/local-validation",
      backendLocator: `local:${"9".repeat(64)}`,
      environmentIdentity: `local:${"9".repeat(64)}`,
      egress: "local",
      toolReceiptDigests: ["8".repeat(64)],
    },
  });
  const originalScopeBatch = {
    identity: {
      protocol: "clockgrove.factory/local-scope-v1" as const,
      repository: invocation.repository,
      objective: reservation.objective,
      runId: reservation.runId,
      workItem: reservation.workItem,
      attempt: reservation.attempt,
      directorEpoch: 1,
      policyDigest: reservation.policyDigest,
      phase: "validation" as const,
      commandIndex: 0,
      invocationDigest: invocation.artifactDigest,
      hostIdentity: "a".repeat(64),
      producerUnit: "factory.service",
      producerInvocationId: "b".repeat(32),
    },
    commandCount: 2,
    producerPid: 100,
    producerStartTicks: "200",
    deadline,
  };
  const capacity = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "capacity",
    event: "CapacityReserved",
    ...writerAuthority(writer, 10),
    objective: reservation.objective,
    runId: reservation.runId,
    sequence: 10,
    at: "2026-09-17T00:00:00.000Z",
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    phase: "validation",
    backend: invocation.toolEnvironment.backendId,
    requestedCpu: 1,
    requestedMemoryMb: 512,
    directorEpoch: reservation.directorEpoch,
    policyDigest: reservation.policyDigest,
    localScopeBatch: originalScopeBatch,
  });
  if (capacity.kind !== "capacity") throw new Error("fixture capacity did not parse");
  const prepared = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "validation-invocation",
    event: "ValidationInvocationPrepared",
    ...writerAuthority(writer, 11),
    objective: reservation.objective,
    runId: reservation.runId,
    sequence: 11,
    at: "2026-09-17T00:00:00.000Z",
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    reservationRef: reservation.ref,
    reservationOid: reservation.oid,
    reservationReceiptDigest: reservation.receiptDigest,
    attemptDirectorEpoch: reservation.directorEpoch,
    attemptPolicyDigest: reservation.policyDigest,
    validationDeadline: deadline,
    capacityReservationSequence: capacity.sequence,
    artifactDigest: invocation.artifactDigest,
    baseSha: invocation.baseSha,
    outputTreeSha: invocation.outputTreeSha,
    invocationDigest: invocation.digest,
    invocationRef: "refs/clockgrove-factory/validation-invocations/test/local-intent",
    invocationCommitOid: "8".repeat(40),
    backend: invocation.toolEnvironment.backendId,
    backendLocator: invocation.toolEnvironment.backendLocator,
  });
  const directorB = { ...writer, holder: "director-b", epoch: 2 };
  const reboundScopeBatch = {
    ...originalScopeBatch,
    identity: {
      ...originalScopeBatch.identity,
      directorEpoch: 2,
      producerInvocationId: "c".repeat(32),
    },
    producerPid: 101,
    producerStartTicks: "201",
  };
  const rebound = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "validation-invocation",
    event: "ValidationInvocationScopeRebound",
    ...writerAuthority(directorB, 12),
    objective: reservation.objective,
    runId: reservation.runId,
    sequence: 12,
    at: "2026-09-17T00:02:00.000Z",
    workItem: reservation.workItem,
    attempt: reservation.attempt,
    artifactDigest: invocation.artifactDigest,
    invocationDigest: invocation.digest,
    reservationOid: reservation.oid,
    backend: invocation.toolEnvironment.backendId,
    previousScopeBatchDigest: localScopeBatchDigest(originalScopeBatch),
    localScopeBatch: reboundScopeBatch,
  });
  return {
    reservation,
    invocation,
    capacity,
    prepared,
    rebound,
    originalScopeBatch,
    reboundScopeBatch,
    directorB,
  };
}

it("authenticates one monotonic local capacity, preparation, and scope rebound chain", () => {
  const fixture = authenticatedLocalChainFixture();
  const observation = {
    ...authority,
    holder: fixture.directorB.holder,
    epoch: fixture.directorB.epoch,
  };
  const inspect = (events: ReturnType<typeof parseFactoryEvent>[], capacity = fixture.capacity) =>
    inspectLocalValidationScopeReboundChain({
      ...fixture,
      capacity,
      events,
      isWriterAuthorized: (event) => hasHistoricalWriterAuthority(event, observation),
    });
  expect(inspect([fixture.capacity, fixture.prepared, fixture.rebound]).rebound?.writerHolder).toBe(
    "director-b",
  );

  const {
    writerEpoch: _writerEpoch,
    writerOperationId: _writerOperationId,
    writerHolder: _writerHolder,
    writerPolicyDigest: _writerPolicyDigest,
    ...writerlessRebound
  } = fixture.rebound;
  expect(() => parseFactoryEvent(writerlessRebound)).toThrow();

  const forgedWriter = parseFactoryEvent({
    ...fixture.rebound,
    writerOperationId: "f".repeat(64),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, forgedWriter])).toThrow(
    /unauthenticated writer authority/,
  );
  const forgedCapacity = parseFactoryEvent({
    ...fixture.capacity,
    writerOperationId: "e".repeat(64),
  });
  expect(() =>
    inspect(
      [forgedCapacity, fixture.prepared, fixture.rebound],
      forgedCapacity.kind === "capacity" ? forgedCapacity : fixture.capacity,
    ),
  ).toThrow(/unauthenticated writer authority/);
  const deadlineTamperedBatch = {
    ...fixture.originalScopeBatch,
    deadline: "2026-09-17T00:09:59.999Z",
  };
  const deadlineTamperedCapacity = parseFactoryEvent({
    ...fixture.capacity,
    localScopeBatch: deadlineTamperedBatch,
  });
  expect(() =>
    inspect(
      [deadlineTamperedCapacity, fixture.prepared, fixture.rebound],
      deadlineTamperedCapacity.kind === "capacity" ? deadlineTamperedCapacity : fixture.capacity,
    ),
  ).toThrow(/exact capacity reservation/);
  const changedDigest = parseFactoryEvent({
    ...fixture.rebound,
    previousScopeBatchDigest: "d".repeat(64),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, changedDigest])).toThrow(
    /breaks its immutable writer and scope chain/,
  );
  const staleSequence = parseFactoryEvent({
    ...fixture.rebound,
    sequence: fixture.prepared.sequence,
    ...writerAuthority(fixture.directorB, fixture.prepared.sequence),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, staleSequence])).toThrow(
    /breaks its immutable writer and scope chain/,
  );
  const futureWriter = { ...fixture.directorB, holder: "director-c", epoch: 3 };
  const futureRebound = parseFactoryEvent({
    ...fixture.rebound,
    localScopeBatch: {
      ...fixture.reboundScopeBatch,
      identity: { ...fixture.reboundScopeBatch.identity, directorEpoch: 3 },
    },
    ...writerAuthority(futureWriter, fixture.rebound.sequence),
  });
  expect(() => inspect([fixture.capacity, fixture.prepared, futureRebound])).toThrow(
    /unauthenticated writer authority/,
  );
});

it("refuses a stale local rebound writer after capacity and preparation takeover", () => {
  const fixture = authenticatedLocalChainFixture();
  const originalAtB = {
    ...fixture.originalScopeBatch,
    identity: { ...fixture.originalScopeBatch.identity, directorEpoch: 2 },
  };
  const capacityB = parseFactoryEvent({
    ...fixture.capacity,
    recoveryEpoch: 2,
    localScopeBatch: originalAtB,
    ...writerAuthority(fixture.directorB, fixture.capacity.sequence),
  });
  const preparedB = parseFactoryEvent({
    ...fixture.prepared,
    ...writerAuthority(fixture.directorB, fixture.prepared.sequence),
  });
  const staleRebound = parseFactoryEvent({
    ...fixture.rebound,
    previousScopeBatchDigest: localScopeBatchDigest(originalAtB),
    localScopeBatch: {
      ...fixture.reboundScopeBatch,
      identity: { ...fixture.reboundScopeBatch.identity, directorEpoch: 1 },
    },
    ...writerAuthority(writer, fixture.rebound.sequence),
  });
  const observation = {
    ...authority,
    holder: fixture.directorB.holder,
    epoch: fixture.directorB.epoch,
  };
  expect(() =>
    inspectLocalValidationScopeReboundChain({
      ...fixture,
      capacity: capacityB.kind === "capacity" ? capacityB : fixture.capacity,
      events: [capacityB, preparedB, staleRebound],
      isWriterAuthorized: (event) => hasHistoricalWriterAuthority(event, observation),
    }),
  ).toThrow(/breaks its immutable writer and scope chain/);
});

describe.each(providers)("%s remote validation recovery", (provider) => {
  it("recovers a pre-create crash by durably starting the initial dispatch before launch", async () => {
    const fixture = ports({ intent: true, dispatch: false });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe("launched");
    expect(fixture.stages).toEqual(["dispatch", "launch", "result", "settle-provider-cleanup"]);
    expect(provider).toMatch(/^codex-cli\//);
  });

  it("does not turn response loss or eventual 404 into replay before the fence", async () => {
    const fixture = ports({ dispatch: true, observation: null });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /observation cannot begin before its durable no-handle fence/,
    );
    expect(fixture.stages).toEqual([]);
  });

  it("does not authorize absence when the clock crosses the fence after a pre-fence restart", async () => {
    const observeResource = vi.fn(async () => null);
    const launch = vi.fn(async () => "duplicate");
    const fixture = ports({ dispatch: true, observeResource, launch });
    const times = [new Date("2026-09-17T00:00:59.999Z"), new Date("2026-09-17T00:01:00.001Z")];
    fixture.input.now = async () => times.shift() ?? new Date("2026-09-17T00:01:00.001Z");
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /observation cannot begin before its durable no-handle fence/,
    );
    expect(observeResource).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.stages).toEqual([]);
  });

  it("self-heals a lost create response after post-fence exact absence", async () => {
    const fixture = ports({
      dispatch: false,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
      replayReplacement: async () => {
        fixture.stages.push("idempotent-replay");
        return "recovered-launch";
      },
    });
    fixture.input.launch = async () => {
      fixture.stages.push("initial-launch");
      throw new Error("provider create response lost");
    };
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "recovered-launch",
    );
    expect(fixture.stages).toEqual([
      "dispatch",
      "initial-launch",
      "observe",
      "rebound",
      "idempotent-replay",
      "result",
      "settle-provider-cleanup",
    ]);
  });

  it("uses exact post-fence absence for one durable rebound before replacement launch", async () => {
    const fixture = ports({
      dispatch: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe("launched");
    expect(fixture.stages).toEqual([
      "observe",
      "rebound",
      "replay",
      "result",
      "settle-provider-cleanup",
    ]);
  });

  it("cleans and records deterministic terminal failure after the immutable deadline", async () => {
    const fixture = ports({
      dispatch: true,
      observation: null,
      cleanupObservation: "cleaned",
      now: deadline,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "deadline-failure",
    );
    expect(fixture.stages).toEqual(["cleanup", "terminal", "result", "settle-provider-cleanup"]);
  });

  it("cleans an exact live resource for a durable result after deadline without result recovery", async () => {
    const observeResource = vi.fn(async () => {
      throw new Error("expired result collection must not run");
    });
    const fixture = ports({
      dispatch: true,
      result: "checkpointed",
      cleanupObservation: "cleaned",
      observeResource,
      now: deadline,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "checkpointed",
    );
    expect(observeResource).not.toHaveBeenCalled();
    expect(fixture.stages).toEqual(["cleanup", "settle-provider-cleanup"]);
  });

  it("refuses an expired prepared invocation before writing its first dispatch", async () => {
    const fixture = ports({ intent: true, dispatch: false, now: deadline });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /deadline is exhausted before dispatch/,
    );
    expect(fixture.stages).toEqual([]);
  });

  it("keeps the identical deadline through repeated pre-fence restarts", async () => {
    const seen: string[] = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const fixture = ports({ dispatch: true, observation: null });
      const input = {
        ...fixture.input,
        now: async () => {
          seen.push(fixture.input.validationDeadline);
          return new Date("2026-09-17T00:00:30.000Z");
        },
      };
      await expect(runRemoteValidationInvocationTransaction(input)).rejects.toThrow(
        /observation cannot begin before its durable no-handle fence/,
      );
    }
    expect(seen).toEqual([deadline, deadline]);
  });

  it("resumes the exact replacement after a crash immediately after its rebound event", async () => {
    const replayReplacement = vi.fn(async () => "replacement");
    const fixture = ports({
      dispatch: true,
      rebound: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
      replayReplacement,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "replacement",
    );
    expect(replayReplacement).toHaveBeenCalledOnce();
    expect(fixture.stages).toEqual(["observe", "result", "settle-provider-cleanup"]);
  });

  it("replays one provider-idempotent replacement after a crash that persisted its rebound", async () => {
    let crashAfterRebound = true;
    const launch = vi.fn(async () => "forbidden");
    const replayReplacement = vi.fn(async () => "replacement");
    const fixture = ports({
      dispatch: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
      launch,
      replayReplacement,
      afterPersistRebound: async () => {
        if (crashAfterRebound) throw new Error("controller crashed after rebound");
      },
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /crashed after rebound/,
    );
    crashAfterRebound = false;
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "replacement",
    );
    expect(launch).not.toHaveBeenCalled();
    expect(replayReplacement).toHaveBeenCalledOnce();
    expect(fixture.stages.filter((stage) => stage === "rebound")).toHaveLength(1);
  });

  it("reuses one provider receipt across restarts after a replacement response is lost", async () => {
    let replayCalls = 0;
    let billedReplacements = 0;
    const launch = vi.fn(async () => "forbidden");
    const replayReplacement = vi.fn(async () => {
      replayCalls += 1;
      if (replayCalls === 1) {
        billedReplacements += 1;
        throw new Error("replacement response lost after provider acceptance");
      }
      return "same-provider-receipt";
    });
    const fixture = ports({
      dispatch: true,
      rebound: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
      launch,
      replayReplacement,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /response lost/,
    );
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "same-provider-receipt",
    );
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "same-provider-receipt",
    );
    expect(launch).not.toHaveBeenCalled();
    expect(replayReplacement).toHaveBeenCalledTimes(2);
    expect(billedReplacements).toBe(1);
    expect(fixture.stages.filter((stage) => stage.startsWith("settle-"))).toHaveLength(1);
  });

  it("fails deterministically when a persisted rebound has no provider idempotency primitive", async () => {
    const launch = vi.fn(async () => "duplicate");
    const fixture = ports({
      dispatch: true,
      rebound: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
      launch,
      replayReplacement: null,
    });
    for (let restart = 0; restart < 2; restart += 1) {
      await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
        /lacks provider-idempotent replacement dispatch capability/,
      );
    }
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.stages.filter((stage) => stage === "rebound")).toHaveLength(0);
  });

  it("does not resume a persisted rebound before the original no-handle fence", async () => {
    const launch = vi.fn(async () => "duplicate");
    const fixture = ports({ dispatch: true, rebound: true, observation: null, launch });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /observation cannot begin before its durable no-handle fence/,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.stages).toEqual([]);
  });

  it("recovers an already-running replacement instead of launching it again", async () => {
    const launch = vi.fn(async () => "duplicate");
    const fixture = ports({
      dispatch: true,
      rebound: true,
      observation: "replacement-result",
      now: "2026-09-17T00:02:00.000Z",
      launch,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "replacement-result",
    );
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.stages).toEqual(["observe", "result", "settle-provider-cleanup"]);
  });

  it("settles an already-rebounded invocation when absence observation crosses the deadline", async () => {
    const fixture = ports({
      dispatch: true,
      rebound: true,
      observation: null,
      cleanupObservation: "cleaned",
    });
    const times = [
      new Date("2026-09-17T00:01:00.000Z"),
      new Date("2026-09-17T00:09:59.999Z"),
      new Date(deadline),
    ];
    fixture.input.now = async () => times.shift() ?? new Date(deadline);
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "deadline-failure",
    );
    expect(fixture.stages).toEqual([
      "observe",
      "cleanup",
      "terminal",
      "result",
      "settle-provider-cleanup",
    ]);
  });

  it("settles a failed rebound when its final absence observation crosses the deadline", async () => {
    const fixture = ports({
      dispatch: true,
      observation: null,
      cleanupObservation: "cleaned",
      replayReplacement: async () => {
        fixture.stages.push("replay-failed");
        throw new Error("rebound create failed");
      },
    });
    const times = [
      new Date("2026-09-17T00:01:00.000Z"),
      new Date("2026-09-17T00:09:59.996Z"),
      new Date("2026-09-17T00:09:59.997Z"),
      new Date("2026-09-17T00:09:59.998Z"),
      new Date("2026-09-17T00:09:59.999Z"),
      new Date(deadline),
    ];
    fixture.input.now = async () => times.shift() ?? new Date(deadline);
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "deadline-failure",
    );
    expect(fixture.stages).toEqual([
      "observe",
      "rebound",
      "replay-failed",
      "observe",
      "cleanup",
      "terminal",
      "result",
      "settle-provider-cleanup",
    ]);
  });

  it("does not let a durable result mask cleanup failure for a live resource", async () => {
    const fixture = ports({
      dispatch: true,
      result: "checkpointed",
      now: "2026-09-17T00:02:00.000Z",
      cleanupResource: async () => {
        fixture.stages.push("cleanup-live");
        throw new Error("provider cleanup failed while resource remains live");
      },
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /cleanup failed.*remains live/,
    );
    expect(fixture.stages).toEqual(["cleanup-live"]);
  });

  it("settles a cleanup-before-receipt crash from durable result and exact post-fence absence", async () => {
    const fixture = ports({
      dispatch: true,
      result: "checkpointed",
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "checkpointed",
    );
    expect(fixture.stages).toEqual(["cleanup", "settle-post-fence-exact-absence"]);
  });

  it("keeps a durable result unsettled until exact absence crosses the visibility fence", async () => {
    const fixture = ports({ dispatch: true, result: "checkpointed", observation: null });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /resource is unsettled before the no-handle fence/,
    );
    expect(fixture.stages).toEqual([]);
  });

  it("records provider cleanup settlement after exact recovery of a live resource", async () => {
    const fixture = ports({
      dispatch: true,
      observation: "recovered",
      now: "2026-09-17T00:02:00.000Z",
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "recovered",
    );
    expect(fixture.stages).toEqual(["observe", "result", "settle-provider-cleanup"]);
  });

  it("returns only when both durable result and settlement already exist", async () => {
    const complete = ports({ dispatch: true, result: "checkpointed", settled: true });
    await expect(runRemoteValidationInvocationTransaction(complete.input)).resolves.toBe(
      "checkpointed",
    );
    expect(complete.stages).toEqual([]);

    const missingResult = ports({ dispatch: true, settled: true });
    await expect(runRemoteValidationInvocationTransaction(missingResult.input)).rejects.toThrow(
      /lacks its exact durable result or dispatch/,
    );
  });
});
