import { afterEach, describe, expect, it, vi } from "vitest";
import * as protocol from "../src/protocol/events.js";
import {
  observeRecoveryEvents,
  RecoveryEventObservation,
  recoveryEventDigest,
  recoveryEventObservation,
  recoverySourceEventsDigest,
} from "../src/recovery/identity.js";

const rawFixture = (sequence = 2): protocol.FactoryEvent =>
  protocol.parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunEscalated",
    objective: 7,
    runId: "fixture",
    sequence,
    at: "2026-09-05T00:00:00Z",
    reason: "fixture terminal",
  });

const representativeEvents = (): protocol.FactoryEvent[] => {
  const digest = "d".repeat(64);
  const common = {
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "fixture",
    at: "2026-09-05T00:00:00Z",
  };
  return [
    rawFixture(),
    protocol.parseFactoryEvent({
      ...common,
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 3,
      phase: "management",
      unit: "model_tokens",
      amount: 10,
      usageId: "usage-1",
    }),
    protocol.parseFactoryEvent({
      ...common,
      kind: "controller",
      event: "ControllerObserved",
      sequence: 4,
      controllerId: "controller",
      epoch: 1,
      expiresAt: "2026-09-05T00:10:00Z",
      controllerPolicyDigest: digest,
      protocolMin: "clockgrove.factory/v2",
      protocolMax: "clockgrove.factory/v2",
      writerEpoch: 1,
      writerOperationId: "operation",
      writerHolder: "holder",
      writerPolicyDigest: digest,
    }),
  ];
};

afterEach(() => vi.restoreAllMocks());

describe("observation-scoped recovery event identity", () => {
  it("preserves digest bytes while isolating and freezing parsed events", () => {
    const raw = structuredClone(rawFixture());
    const expected = recoveryEventDigest(raw);
    const parse = vi.spyOn(protocol, "parseFactoryEvent");
    const observation = RecoveryEventObservation.create([raw]);
    const indexed = observation.events[0]!;

    expect(parse).toHaveBeenCalledTimes(1);
    expect(indexed).not.toBe(raw);
    expect(observation.digestOf(indexed)).toBe(expected);
    expect(observation.findByDigest(expected)).toBe(indexed);
    expect(Object.isFrozen(indexed)).toBe(true);
    expect(() => Object.assign(indexed, { reason: "mutated" })).toThrow();

    Object.assign(raw, { reason: "changed after the read" });
    expect(observation.digestOf(indexed)).toBe(expected);
    expect(recoveryEventDigest(raw)).not.toBe(expected);
  });

  it.each([
    "proxy",
    "accessor",
    "toJSON",
    "exotic prototype",
    "null prototype",
    "sparse array",
    "hidden field",
    "non-finite number",
    "undefined value",
    "symbol field",
  ])("rejects unsafe %s material before it can enter the index", (fault) => {
    const event = { ...rawFixture() } as Record<PropertyKey, unknown>;
    let unsafe: unknown = event;
    if (fault === "proxy") unsafe = new Proxy(event, {});
    if (fault === "accessor")
      Object.defineProperty(event, "reason", {
        enumerable: true,
        get: () => "concealed",
      });
    if (fault === "toJSON") event.toJSON = () => ({ ...event });
    if (fault === "exotic prototype") Object.setPrototypeOf(event, { inherited: true });
    if (fault === "null prototype") unsafe = Object.assign(Object.create(null), event);
    if (fault === "sparse array") event.untrusted = new Array(1);
    if (fault === "hidden field")
      Object.defineProperty(event, "reason", {
        enumerable: false,
        value: "concealed",
      });
    if (fault === "non-finite number") event.untrusted = Number.NaN;
    if (fault === "undefined value") event.untrusted = [undefined];
    if (fault === "symbol field") event[Symbol("concealed")] = true;

    expect(() => RecoveryEventObservation.create([unsafe as protocol.FactoryEvent])).toThrow();
    expect(() => recoveryEventDigest(unsafe as protocol.FactoryEvent)).toThrow();
  });

  it("preserves retained historical digest bytes and writer-retry source identity", () => {
    const events = representativeEvents();
    expect(events.map(recoveryEventDigest)).toEqual([
      "ac13393301aef2ced5725c551bb61b13247a4db14452546f450bd142d613c839",
      "13249d769a0b00e9347be69deff27e9d416cbac50975d1df944f39b920031469",
      "a63d6407df2cc345ce0500f845f78081e799e5899f0f20de9b32eaf79983e4e2",
    ]);
    const retry = protocol.parseFactoryEvent({
      ...events[2],
      sequence: 5,
      at: "2026-09-05T00:00:01Z",
    });
    const observation = RecoveryEventObservation.create([...events, retry]);
    expect(observation.events).toHaveLength(4);
    expect(observation.semanticallyDeduplicatedEvents).toHaveLength(3);
    expect(
      recoverySourceEventsDigest({
        objective: 7,
        runIds: ["fixture"],
        events: observation,
        maxSequence: 10,
      }),
    ).toBe("89598f24af2d240eb87716fa96d0b6749142a64b35efaebfec818db80d146779");
  });

  it("rejects mutation of standard prototypes at construction and verifier boundaries", () => {
    const observation = RecoveryEventObservation.create([rawFixture()]);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "factoryInjected");
    try {
      Object.defineProperty(Object.prototype, "factoryInjected", {
        configurable: true,
        value: "unexpected",
      });
      expect(() => RecoveryEventObservation.create([rawFixture()])).toThrow(/prototype/);
      expect(() => recoveryEventObservation(observation)).toThrow(/prototype/);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "factoryInjected", previous);
      else Reflect.deleteProperty(Object.prototype, "factoryInjected");
    }
    expect(recoveryEventObservation(observation)).toBe(observation);
  });

  it("does not trust a replaced Array iterator while checking prototype integrity", () => {
    const event = rawFixture();
    const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    let rejected = false;
    try {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        ...original,
        value: function* emptyIterator() {},
      });
      try {
        RecoveryEventObservation.create([event]);
      } catch {
        rejected = true;
      }
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, original);
    }
    expect(rejected).toBe(true);
  });

  it("rejects clones, foreign observations and values outside a derived view", () => {
    const first = RecoveryEventObservation.create([rawFixture(2), rawFixture(3)]);
    const second = RecoveryEventObservation.create([rawFixture(2)]);
    const selected = first.select((event) => event.sequence === 2);

    expect(() => first.digestOf(structuredClone(first.events[0]!))).toThrow(/belong/);
    expect(() => first.digestOf(second.events[0]!)).toThrow(/belong/);
    expect(() => selected.digestOf(first.events[1]!)).toThrow(/view/);
    expect(selected.digestOf(first.events[0]!)).toBe(first.digestOf(first.events[0]!));

    const forged = Object.create(RecoveryEventObservation.prototype) as RecoveryEventObservation;
    Object.defineProperty(forged, "events", { value: [] });
    expect(() => recoveryEventObservation(forged)).toThrow(/authenticated/);
  });

  it("collapses only exact duplicates and rejects semantic conflicts", () => {
    const event = rawFixture();
    const observation = RecoveryEventObservation.create([event, structuredClone(event)]);
    expect(observation.events).toHaveLength(1);
    expect(observation.stats).toMatchObject({ inputEvents: 2, retainedEvents: 1 });

    expect(() =>
      RecoveryEventObservation.create([
        event,
        protocol.parseFactoryEvent({ ...event, reason: "conflicting terminal" }),
      ]),
    ).toThrow(/conflicting Factory events/);
  });

  it("authenticates original input positions without exposing them through derived views", () => {
    const later = rawFixture(3);
    const earlier = rawFixture(2);
    const observation = RecoveryEventObservation.create([later, earlier, structuredClone(later)], {
      sortBySequence: true,
    });
    const input = observation.validatedInputEvents();

    expect(observation.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(input.map((event) => event.sequence)).toEqual([3, 2, 3]);
    expect(input[0]).toBe(input[2]);
    expect(input.every((event) => Object.isFrozen(event))).toBe(true);
    expect(() => observation.semanticView().validatedInputEvents()).toThrow(/root observation/);
    expect(() => observation.select(() => true).validatedInputEvents()).toThrow(/root observation/);
  });

  it.each([600, 5_000, 10_000, 50_000])(
    "performs one parse/canonicalization/digest per input across a %i-event history",
    (size) => {
      const events = Array.from({ length: size }, (_, index) => rawFixture(index + 1));
      const parse = vi.spyOn(protocol, "parseFactoryEvent");
      const observation = RecoveryEventObservation.create(events, {
        maxEvents: 50_000,
        sortBySequence: true,
      });
      const operations = { ...observation.stats };

      expect(operations).toMatchObject({
        inputEvents: size,
        parsedEvents: size,
        canonicalizedEvents: size,
        digestedEvents: size,
        retainedEvents: size,
      });
      expect(operations.canonicalBytes).toBeGreaterThan(size);
      expect(parse).toHaveBeenCalledTimes(size);

      const view = observation.select((event) => event.sequence <= Math.ceil(size / 2));
      const last = view.events.at(-1)!;
      expect(view.findByDigest(view.digestOf(last))).toBe(last);
      expect(
        recoverySourceEventsDigest({
          objective: 7,
          runIds: ["fixture"],
          events: view,
          maxSequence: Number.MAX_SAFE_INTEGER,
        }),
      ).toMatch(/^[0-9a-f]{64}$/);
      recoverySourceEventsDigest({
        objective: 7,
        runIds: ["fixture"],
        events: observation,
        maxSequence: Number.MAX_SAFE_INTEGER,
      });
      expect(parse).toHaveBeenCalledTimes(size);
      expect(observation.stats).toEqual(operations);
    },
    30_000,
  );

  it("enforces count and byte bounds without an eviction fallback", () => {
    const event = rawFixture();
    expect(() => RecoveryEventObservation.create([event], { maxEvents: 0 })).toThrow(/bound/);
    expect(() => RecoveryEventObservation.create([event], { maxBytes: 1 })).toThrow(/byte bound/);
    expect(() =>
      RecoveryEventObservation.create(Array.from({ length: 50_001 }, () => event)),
    ).toThrow(/bound/);
    const observation = RecoveryEventObservation.create([event, rawFixture(3)]);
    const view = observation.select((candidate) => candidate.sequence === 2);
    expect(recoveryEventObservation(view, { maxBytes: view.retainedCanonicalBytes })).toBe(view);
    expect(() =>
      recoveryEventObservation(view, { maxBytes: view.retainedCanonicalBytes - 1 }),
    ).toThrow(/scope bound/);
    expect(() => recoveryEventObservation(view, { maxEvents: 50_001 })).toThrow(/bound/);
  });

  it("aborts deterministically between bounded construction batches", async () => {
    const events = Array.from({ length: 600 }, (_, index) => rawFixture(index + 1));
    const controller = new AbortController();
    const pending = observeRecoveryEvents(events, {
      batchSize: 10,
      maxEvents: 600,
      signal: controller.signal,
    });
    setImmediate(() => controller.abort(new Error("deadline observed")));
    await expect(pending).rejects.toThrow("deadline observed");
  });

  it("rejects standard-prototype mutation between asynchronous batches", async () => {
    const events = Array.from({ length: 600 }, (_, index) => rawFixture(index + 1));
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "factoryInjected");
    const pending = observeRecoveryEvents(events, { batchSize: 10, maxEvents: 600 });
    queueMicrotask(() => {
      Object.defineProperty(Array.prototype, "factoryInjected", {
        configurable: true,
        value: "unexpected",
      });
    });
    try {
      await expect(pending).rejects.toThrow(/prototype/);
    } finally {
      if (previous) Object.defineProperty(Array.prototype, "factoryInjected", previous);
      else Reflect.deleteProperty(Array.prototype, "factoryInjected");
    }
  });
});
