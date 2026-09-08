import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import {
  deduplicateFactoryEvents,
  hasCurrentWriterAuthority,
  latestRunReceipts,
  latestSupportedRun,
} from "../src/control/receipts.js";
import { LifecycleRecorder } from "../src/control/events.js";
import type { LeaseManager, LeaseState } from "../src/control/lease.js";
import { objectiveAuthorityObservation, writerAuthority } from "../src/control/authority.js";
import { RunManager } from "../src/control/runs.js";

const common = {
  protocol: "clockgrove.factory/v2",
  objective: 42,
  runId: "run-a",
  at: "2026-09-07T00:00:00.000Z",
};
const POLICY_DIGEST = policyDigest(DEFAULT_RUN_POLICY);
const start = parseFactoryEvent({
  ...common,
  kind: "run",
  event: "FactoryRunStarted",
  sequence: 1,
  actor: "owner",
  repository: "owner/repo",
  objectiveAuthor: "owner",
  fork: false,
  baseBranch: "main",
  policy: DEFAULT_RUN_POLICY,
  policyDigest: policyDigest(DEFAULT_RUN_POLICY),
});
const boundary = parseFactoryEvent({
  ...common,
  kind: "controller",
  event: "ControllerObserved",
  sequence: 5,
  writerEpoch: 2,
  observationScope: "objective-writer",
  controllerId: "owner-b",
  epoch: 2,
  expiresAt: "2026-09-07T00:10:00.000Z",
  controllerPolicyDigest: policyDigest(DEFAULT_RUN_POLICY),
  protocolMin: common.protocol,
  protocolMax: common.protocol,
});
const terminal = (writerEpoch?: number) =>
  parseFactoryEvent({
    ...common,
    kind: "run",
    event: "FactoryRunCompleted",
    sequence: 9,
    ...(writerEpoch === undefined ? {} : { writerEpoch }),
  });

describe("Objective receipt writer generation", () => {
  it("publishes the same optional generation fields and rejects malformed controller values", () => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(new URL("../schemas/factory-event.schema.json", import.meta.url), "utf8"),
      ),
    );
    expect(validate(boundary)).toBe(true);
    expect(
      validate({
        ...boundary,
        writerOperationId: "a".repeat(64),
        writerHolder: "owner-b",
        writerPolicyDigest: policyDigest(DEFAULT_RUN_POLICY),
      }),
    ).toBe(true);
    for (const patch of [
      { writerEpoch: 0 },
      { writerEpoch: -1 },
      { writerEpoch: 1.5 },
      { writerEpoch: "2" },
      { observationScope: "unknown" },
      { writerOperationId: "contains spaces" },
      { writerHolder: "" },
      { writerPolicyDigest: "not-a-digest" },
    ]) {
      expect(validate({ ...boundary, ...patch })).toBe(false);
      expect(() => parseFactoryEvent({ ...boundary, ...patch })).toThrow();
    }
    const { writerEpoch: _writerEpoch, observationScope: _scope, ...legacy } = boundary;
    expect(validate(legacy)).toBe(true);
    expect(() => parseFactoryEvent(legacy)).not.toThrow();
  });
  it.each([1, undefined])(
    "rejects delayed terminal control from writer %s after takeover, retaining evidence",
    (epoch) => {
      const old = terminal(epoch);
      const events = [start, boundary, old];
      expect(latestSupportedRun(events)).toEqual(start);
      expect(latestRunReceipts(events)?.terminal).toBeUndefined();
      expect(latestRunReceipts(events)?.events).toContainEqual(old);
    },
  );
  it.each(["RunPauseAcknowledged", "RunDrainCompleted"])(
    "requires fresh current-owner reconciliation for %s",
    (event) => {
      const stale = parseFactoryEvent({
        ...common,
        kind: "run",
        event,
        sequence: 8,
        writerEpoch: 1,
        commandRequestId: "pause-a",
      });
      const fresh = parseFactoryEvent({ ...stale, sequence: 10, writerEpoch: 2 });
      expect(hasCurrentWriterAuthority(stale, [boundary, stale])).toBe(false);
      expect(hasCurrentWriterAuthority(fresh, [boundary, stale, fresh])).toBe(true);
      expect(latestRunReceipts([start, boundary, terminal(2)])?.terminal).toEqual(terminal(2));
    },
  );
  it("retains historical completion without a newer same-run boundary", () => {
    expect(latestRunReceipts([start, terminal()])?.terminal).toEqual(terminal());
    const other = parseFactoryEvent({ ...boundary, runId: "another-run", writerEpoch: 9 });
    expect(latestRunReceipts([start, terminal(1), other])?.terminal).toEqual(terminal(1));
  });
  it("does not allow writer metadata to bypass conflicting idempotency", () => {
    expect(() => deduplicateFactoryEvents([terminal(1), terminal(2)])).toThrow(
      "conflicting Factory events",
    );
  });
  it("matches complete writer identity to the authoritative lease and fails closed when absent", () => {
    const lease = {
      ref: "refs/clockgrove-factory/leases/objective-42",
      oid: "a".repeat(40),
      treeOid: "b".repeat(40),
      objective: 42,
      runId: "run-a",
      holder: "owner-b",
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      epoch: 2,
      sequence: 6,
      expiresAt: new Date("2026-09-07T00:10:00.000Z"),
    } satisfies LeaseState;
    const authority = objectiveAuthorityObservation(lease, new Date("2026-09-07T00:05:00.000Z"));
    const fresh = parseFactoryEvent({ ...terminal(2), ...writerAuthority(lease, 9) });
    expect(hasCurrentWriterAuthority(fresh, [fresh], authority)).toBe(true);
    expect(
      hasCurrentWriterAuthority(fresh, [fresh], {
        ...authority,
        observedAt: new Date("2026-09-07T00:11:00.000Z"),
      }),
    ).toBe(true);
    expect(hasCurrentWriterAuthority(terminal(2), [terminal(2)], authority)).toBe(true);
    expect(hasCurrentWriterAuthority(terminal(), [terminal()], authority)).toBe(false);
    expect(
      hasCurrentWriterAuthority(
        parseFactoryEvent({ ...terminal(2), writerHolder: "partial-writer" }),
        [terminal(2)],
        authority,
      ),
    ).toBe(false);
    expect(hasCurrentWriterAuthority(fresh, [fresh], null)).toBe(false);
    expect(
      hasCurrentWriterAuthority(fresh, [fresh], { ...authority, holder: "successor", epoch: 3 }),
    ).toBe(false);
  });
  it.each([
    ["stale epoch", { holder: "old-writer", epoch: 1, policyDigest: POLICY_DIGEST }],
    ["wrong holder", { holder: "old-writer", epoch: 2, policyDigest: POLICY_DIGEST }],
    ["wrong policy", { holder: "current-writer", epoch: 2, policyDigest: "f".repeat(64) }],
  ])("RunManager resume rejects a %s terminal against canonical authority", (_name, writer) => {
    const current = {
      ref: "refs/clockgrove-factory/leases/objective-42",
      oid: "c".repeat(40),
      treeOid: "d".repeat(40),
      objective: 42,
      runId: "run-a",
      holder: "current-writer",
      epoch: 2,
      sequence: 8,
      expiresAt: new Date("2026-09-07T00:10:00.000Z"),
      policyDigest: POLICY_DIGEST,
    } satisfies LeaseState;
    const oldController = parseFactoryEvent({
      ...boundary,
      writerEpoch: writer.epoch,
      controllerId: writer.holder,
      epoch: writer.epoch,
    });
    const lateTerminal = parseFactoryEvent({
      ...terminal(writer.epoch),
      ...writerAuthority({ ...current, ...writer } as LeaseState, 9),
    });
    const events = [start, oldController, lateTerminal];
    expect(latestSupportedRun(events)).toBeNull();

    const manager = new RunManager({} as ConstructorParameters<typeof RunManager>[0]);
    expect(
      manager.resume(events, objectiveAuthorityObservation(current, new Date(common.at))),
    ).toMatchObject({ runId: "run-a", policyDigest: POLICY_DIGEST });
  });
  it("deduplicates exact writer-operation replay and rejects changed payloads", () => {
    const lease = {
      objective: 42,
      runId: "run-a",
      holder: "owner-b",
      epoch: 2,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    } as LeaseState;
    const original = parseFactoryEvent({ ...terminal(2), ...writerAuthority(lease, 9) });
    const replay = parseFactoryEvent({
      ...original,
      sequence: 10,
      at: "2026-09-07T00:00:01.000Z",
    });
    expect(deduplicateFactoryEvents([replay, original])).toEqual([original]);
    expect(() =>
      deduplicateFactoryEvents([
        original,
        parseFactoryEvent({ ...replay, event: "FactoryRunCancelled" }),
      ]),
    ).toThrow("conflicting Factory writer operations");
  });
  it("stamps the reconciling writer while retaining original producer accounting", async () => {
    const events: FactoryEvent[] = [];
    const lease = {
      objective: 42,
      runId: "run-a",
      holder: "owner-b",
      epoch: 2,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    } as LeaseState;
    const recorder = new LifecycleRecorder(
      { serverTime: async () => new Date(common.at), addIssueComment: async () => {} },
      { assertMutationAuthorized: async () => {} } as unknown as LeaseManager,
    );
    const event = await recorder.budget({
      lease,
      workItemNodeId: "I_43",
      sequence: 11,
      reservation: {
        objective: 42,
        runId: "run-a",
        workItem: 43,
        attempt: 1,
        directorEpoch: 1,
        policyDigest: lease.policyDigest,
      } as Parameters<LifecycleRecorder["budget"]>[0]["reservation"],
      event: "BudgetReconciled",
      unit: "model_tokens",
      amount: 123,
      usageId: "actual-usage-a",
      usageEvidence: "as-recorded",
      directorEpoch: 1,
      modelInvocationId: "invocation-a",
      policyDigest: lease.policyDigest,
    });
    events.push(start, boundary, event);
    expect(event).toMatchObject({ writerEpoch: 2, directorEpoch: 1, amount: 123 });
    expect(latestRunReceipts(events)?.events).toContainEqual(event);
  });
});
