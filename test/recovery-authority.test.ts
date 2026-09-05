import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { bindAuthenticatedRunActors } from "../src/control/authenticated-events.js";
import { deduplicateFactoryEvents } from "../src/control/receipts.js";
import { RunManager } from "../src/control/runs.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { recoveryEventDigest } from "../src/recovery/identity.js";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
const common = { protocol: "clockgrove.factory/v2", objective: 7, at: "2026-09-04T00:00:00.000Z" };
function fixture() {
  const predecessor = parseFactoryEvent({
    ...common,
    kind: "run",
    event: "FactoryRunStarted",
    runId: "previous",
    sequence: 1,
    actor: "operator",
    repository: "o/r",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: sha,
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  });
  const terminal = parseFactoryEvent({
    ...common,
    kind: "run",
    event: "FactoryRunEscalated",
    runId: "previous",
    sequence: 10,
    reason: "blocked",
  });
  const request = parseFactoryEvent({
    ...common,
    kind: "recovery",
    event: "RecoveryRequested",
    runId: "previous",
    sequence: 11,
    requestedBy: "operator",
    requestId: "continue-7",
    repository: "o/r",
    planDigest: digest,
    predecessorRunId: "previous",
    predecessorTerminalDigest: recoveryEventDigest(terminal),
    successorRunId: "successor",
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    baseSha: sha,
  });
  const successor = parseFactoryEvent({
    ...predecessor,
    runId: "successor",
    sequence: 12,
    recoveryRequestId: "continue-7",
    recoveryPlanDigest: digest,
    predecessorRunId: "previous",
  });
  return { predecessor, terminal, request, successor };
}
function entries(events: FactoryEvent[]) {
  return events.map((event) => ({ event, login: "operator" }));
}

describe("successor authority protocol", () => {
  it("publishes complete successor bindings in the event JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(new URL("../schemas/factory-event.schema.json", import.meta.url), "utf8"),
      ),
    );
    const f = fixture();
    expect(validate(f.request)).toBe(true);
    expect(validate(f.successor)).toBe(true);
    const missing = { ...f.request };
    Reflect.deleteProperty(missing, "predecessorTerminalDigest");
    expect(validate(missing)).toBe(false);
    expect(validate({ ...f.successor, recoveryRequestId: undefined })).toBe(false);
    expect(validate({ ...f.successor, activationRequestId: "ordinary" })).toBe(false);
    expect(validate({ ...f.request, event: "UnsupportedRecovery" })).toBe(false);
  });
  it("binds a successor actor to the exact authenticated terminal predecessor and request", () => {
    const f = fixture();
    expect(bindAuthenticatedRunActors(entries(Object.values(f)))).toEqual(
      new Map([
        ["previous", "operator"],
        ["successor", "operator"],
      ]),
    );
  });

  it.each([
    ["planDigest", "c".repeat(64)],
    ["predecessorTerminalDigest", "c".repeat(64)],
    ["successorRunId", "another"],
    ["policyDigest", "c".repeat(64)],
    ["baseSha", "c".repeat(40)],
    ["repository", "o/other"],
    ["requestedBy", "impostor"],
    ["sequence", 10],
  ])("rejects a request with changed %s", (field, value) => {
    const f = fixture();
    f.request = parseFactoryEvent({ ...f.request, [String(field)]: value });
    expect(() => bindAuthenticatedRunActors(entries(Object.values(f)))).toThrow(
      /authenticated recovery/,
    );
  });

  it.each(["objectiveAuthor", "fork", "baseBranch", "sequence"])(
    "rejects a changed successor %s",
    (field) => {
      const f = fixture();
      f.successor = parseFactoryEvent({
        ...f.successor,
        [field]: field === "fork" ? true : field === "sequence" ? 11 : "different",
      });
      expect(() => bindAuthenticatedRunActors(entries(Object.values(f)))).toThrow(
        /authenticated recovery/,
      );
    },
  );

  it("rejects missing and conflicting terminal evidence", () => {
    const f = fixture();
    expect(() =>
      bindAuthenticatedRunActors(entries([f.predecessor, f.request, f.successor])),
    ).toThrow(/authenticated recovery/);
    expect(() =>
      bindAuthenticatedRunActors(
        entries([
          ...Object.values(f),
          parseFactoryEvent({
            ...f.terminal,
            event: "FactoryRunCancelled",
            sequence: 9,
          }),
        ]),
      ),
    ).toThrow(/authenticated recovery/);
  });

  it("does not accept a forged request comment from another authenticated collaborator", () => {
    const f = fixture();
    const history = entries(Object.values(f));
    history[2]!.login = "collaborator";
    expect(() => bindAuthenticatedRunActors(history)).toThrow(/authenticated recovery/);
  });

  it("deduplicates identical request delivery, but rejects changed semantic bindings", () => {
    const f = fixture();
    const repeated = parseFactoryEvent({
      ...f.request,
      sequence: 13,
      at: "2026-09-04T00:00:01.000Z",
    });
    expect(deduplicateFactoryEvents([f.request, repeated])).toEqual([f.request]);
    expect(() =>
      deduplicateFactoryEvents([
        f.request,
        parseFactoryEvent({ ...repeated, planDigest: "c".repeat(64) }),
      ]),
    ).toThrow(/conflicting/);
  });

  it("cannot reuse a recovery request ID for an ordinary activation", () => {
    const f = fixture();
    const activation = parseFactoryEvent({
      ...common,
      kind: "run",
      event: "ActivationRequested",
      runId: "other",
      sequence: 11,
      requestId: "continue-7",
      requestedBy: "operator",
      repository: "o/r",
      baseSha: sha,
      policy: DEFAULT_RUN_POLICY,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      controllerProtocolMin: "clockgrove.factory/v2",
      controllerProtocolMax: "clockgrove.factory/v2",
    });
    expect(() => bindAuthenticatedRunActors(entries([...Object.values(f), activation]))).toThrow(
      /conflicting/,
    );
  });

  it.each(["recoveryRequestId", "recoveryPlanDigest", "predecessorRunId", "baseSha"])(
    "rejects a partially specified successor missing %s",
    (field) => {
      const value = { ...fixture().successor };
      Reflect.deleteProperty(value, field);
      expect(() => parseFactoryEvent(value)).toThrow();
    },
  );

  it("rejects self-recovery and mixed ordinary/recovery activation", () => {
    const f = fixture();
    expect(() => parseFactoryEvent({ ...f.request, successorRunId: "previous" })).toThrow();
    expect(() => parseFactoryEvent({ ...f.successor, predecessorRunId: "successor" })).toThrow();
    expect(() => parseFactoryEvent({ ...f.successor, activationRequestId: "ordinary" })).toThrow();
  });

  it("requires a consumed record to name an immutable claim and distinct predecessor", () => {
    const consumed = {
      ...common,
      kind: "recovery",
      event: "RecoveryConsumed",
      runId: "successor",
      sequence: 13,
      recoveryRequestId: "continue-7",
      planDigest: digest,
      predecessorRunId: "previous",
      predecessorTerminalDigest: digest,
      claimRef: "refs/clockgrove-factory/recovery-claims/objective-7/predecessor-hash",
      claimOid: sha,
    };
    expect(parseFactoryEvent(consumed).event).toBe("RecoveryConsumed");
    expect(() => parseFactoryEvent({ ...consumed, claimOid: undefined })).toThrow();
    expect(() => parseFactoryEvent({ ...consumed, predecessorRunId: "successor" })).toThrow();
  });

  it("does not make successor execution available just because request binding is valid", async () => {
    const f = fixture();
    // Authentic request/start envelopes establish actor binding, not adoption
    // or the independently loaded immutable runtime required for execution.
    expect(() => bindAuthenticatedRunActors(entries(Object.values(f)))).not.toThrow();
    const store = {
      addIssueComment: vi.fn(async () => {}),
      serverTime: vi.fn(async () => new Date()),
    };
    const manager = new RunManager(store);
    expect(() => manager.resume(Object.values(f))).toThrow(
      /acknowledged recovery request and verified runtime/,
    );
    await expect(
      manager.start({
        objective: 7,
        objectiveNodeId: "node",
        repository: "o/r",
        objectiveAuthor: "operator",
        actor: "operator",
        fork: false,
        baseBranch: "main",
        policy: DEFAULT_RUN_POLICY,
        existingEvents: Object.values(f),
      }),
    ).rejects.toThrow(/acknowledged recovery request and verified runtime/);
    expect(store.addIssueComment).not.toHaveBeenCalled();
    expect(store.serverTime).not.toHaveBeenCalled();
  });
});
