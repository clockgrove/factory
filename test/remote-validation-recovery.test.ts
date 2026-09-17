import { describe, expect, it, vi } from "vitest";

import {
  inspectRemoteValidationEventChain,
  runRemoteValidationInvocationTransaction,
} from "../src/validation/remote-invocation-recovery.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { createValidationInvocation } from "../src/validation/repository-capture.js";
import { DEFAULT_REPOSITORY_CAPTURE_EGRESS_POLICY } from "../src/protocol/policy.js";
import { hasExactWriterAuthority, writerAuthority } from "../src/control/authority.js";

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
  launch?: () => Promise<string>;
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
      persistRebound: async () => {
        stages.push("rebound");
        rebound = true;
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
  return {
    reservation,
    invocation,
    capacity,
    prepared,
    dispatch,
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
      /before its durable no-handle fence/,
    );
    expect(fixture.stages).toEqual(["observe"]);
  });

  it("self-heals a lost create response after post-fence exact absence", async () => {
    let launches = 0;
    const fixture = ports({
      dispatch: false,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
    });
    fixture.input.launch = async () => {
      launches += 1;
      fixture.stages.push(`launch-${launches}`);
      if (launches === 1) throw new Error("provider create response lost");
      return "recovered-launch";
    };
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe(
      "recovered-launch",
    );
    expect(fixture.stages).toEqual([
      "dispatch",
      "launch-1",
      "observe",
      "rebound",
      "launch-2",
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
      "launch",
      "result",
      "settle-provider-cleanup",
    ]);
  });

  it("refuses rebound after the original immutable deadline", async () => {
    const fixture = ports({
      dispatch: true,
      observation: null,
      now: deadline,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /deadline is exhausted/,
    );
    expect(fixture.stages).toEqual(["observe"]);
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
        /before its durable no-handle fence/,
      );
    }
    expect(seen).toEqual([deadline, deadline]);
  });

  it("refuses a second rebound", async () => {
    const launch = vi.fn(async () => "duplicate");
    const fixture = ports({
      dispatch: true,
      rebound: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
      launch,
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /single durable rebound/,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.stages).toEqual(["observe"]);
  });

  it("does not let a durable result mask cleanup failure for a live resource", async () => {
    const fixture = ports({
      dispatch: true,
      result: "checkpointed",
      observeResource: async () => {
        fixture.stages.push("observe-live");
        throw new Error("provider cleanup failed while resource remains live");
      },
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /cleanup failed.*remains live/,
    );
    expect(fixture.stages).toEqual(["observe-live"]);
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
    expect(fixture.stages).toEqual(["observe", "settle-post-fence-exact-absence"]);
  });

  it("keeps a durable result unsettled until exact absence crosses the visibility fence", async () => {
    const fixture = ports({ dispatch: true, result: "checkpointed", observation: null });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).rejects.toThrow(
      /resource is unsettled before the no-handle fence/,
    );
    expect(fixture.stages).toEqual(["observe"]);
  });

  it("records provider cleanup settlement after exact recovery of a live resource", async () => {
    const fixture = ports({ dispatch: true, observation: "recovered" });
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
