import { describe, expect, it, vi } from "vitest";

import { runRemoteValidationInvocationTransaction } from "../src/validation/remote-invocation-recovery.js";
import { parseFactoryEvent } from "../src/protocol/events.js";

const providers = ["codex-cli/daytona", "codex-cli/vercel-sandbox"] as const;
const deadline = "2026-09-17T00:10:00.000Z";
const fence = "2026-09-17T00:01:00.000Z";

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
  };
  expect(
    parseFactoryEvent({
      ...common,
      event: "ValidationInvocationPrepared",
      sequence: 11,
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
    at: "2026-09-17T00:00:00.000Z",
    resourceName: "factory-candidate-exact",
    requestIdentityDigest: "a".repeat(64),
    noHandleReplacementNotBefore: fence,
  };
  expect(parseFactoryEvent(dispatch).event).toBe("ValidationInvocationRemoteDispatchStarted");
  expect(
    parseFactoryEvent({
      ...dispatch,
      event: "ValidationInvocationRemoteRebound",
      sequence: 13,
      at: fence,
      originalDispatchSequence: dispatch.sequence,
    }).event,
  ).toBe("ValidationInvocationRemoteRebound");
  expect(() =>
    parseFactoryEvent({
      ...dispatch,
      noHandleReplacementNotBefore: "2026-09-17T00:00:59.999Z",
    }),
  ).toThrow(/visibility fence/);
  const { validationDeadline: _deadline, ...missingFinalAuthority } = dispatch;
  expect(() => parseFactoryEvent(missingFinalAuthority)).toThrow();
});

function ports(args: {
  now?: string;
  intent?: boolean;
  dispatch?: boolean;
  rebound?: boolean;
  observation?: string | null;
  launch?: () => Promise<string>;
}) {
  const stages: string[] = [];
  const dispatch = { noHandleReplacementNotBefore: fence };
  let dispatched = args.dispatch ?? false;
  let rebound = args.rebound ?? false;
  return {
    stages,
    dispatch,
    input: {
      validationDeadline: deadline,
      now: async () => new Date(args.now ?? "2026-09-17T00:00:30.000Z"),
      observeFinal: async () => null,
      observeIntent: async () => args.intent ?? true,
      persistIntent: async () => {
        stages.push("intent");
      },
      observeDispatch: async () => ({
        ...(dispatched ? { dispatch } : {}),
        rebound,
      }),
      persistDispatch: async () => {
        stages.push("dispatch");
        dispatched = true;
        return dispatch;
      },
      observeResource: async () => {
        stages.push("observe");
        return args.observation ?? null;
      },
      persistRebound: async () => {
        stages.push("rebound");
        rebound = true;
      },
      launch:
        args.launch ??
        (async () => {
          stages.push("launch");
          return "launched";
        }),
      persistFinal: async (result: string) => {
        stages.push("final");
        return result;
      },
    },
  };
}

describe.each(providers)("%s remote validation recovery", (provider) => {
  it("recovers a pre-create crash by durably starting the initial dispatch before launch", async () => {
    const fixture = ports({ intent: true, dispatch: false });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe("launched");
    expect(fixture.stages).toEqual(["dispatch", "launch", "final"]);
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
      "final",
    ]);
  });

  it("uses exact post-fence absence for one durable rebound before replacement launch", async () => {
    const fixture = ports({
      dispatch: true,
      observation: null,
      now: "2026-09-17T00:02:00.000Z",
    });
    await expect(runRemoteValidationInvocationTransaction(fixture.input)).resolves.toBe("launched");
    expect(fixture.stages).toEqual(["observe", "rebound", "launch", "final"]);
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
});
