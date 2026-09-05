import { afterEach, describe, expect, it, vi } from "vitest";
import * as protocol from "../src/protocol/events.js";
import { createRecoveryEventDigest, recoveryEventDigest } from "../src/recovery/identity.js";

const fixture = (): protocol.FactoryEvent =>
  protocol.parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunEscalated",
    objective: 7,
    runId: "fixture",
    sequence: 2,
    at: "2026-09-05T00:00:00Z",
    reason: "fixture terminal",
  });
afterEach(() => vi.restoreAllMocks());

describe("verification-local recovery identity cache", () => {
  it("reuses exact content, not caller object identity, after complete validation", () => {
    const event = fixture();
    const expected = recoveryEventDigest(event);
    const parse = vi.spyOn(protocol, "parseFactoryEvent");
    const digest = createRecoveryEventDigest();
    expect(digest(event)).toBe(expected);
    expect(digest(structuredClone(event))).toBe(expected);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(digest({ ...event, sequence: 3 })).not.toBe(expected);
    expect(parse).toHaveBeenCalledTimes(2);
    Object.assign(event, { protocol: "unsupported" });
    expect(() => digest(event)).toThrow();
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it.each(["NaN", "sparse", "undefined", "toJSON", "accessor", "prototype"])(
    "does not cache non-data-only %s inputs, even when ordinary JSON.stringify collapses them",
    (fault) => {
      const event = fixture();
      const digest = createRecoveryEventDigest();
      const plain = {
        ...event,
        ignored:
          fault === "NaN" ? null : fault === "sparse" || fault === "undefined" ? [null] : "fixture",
      };
      digest(plain);
      const unusual = { ...plain };
      if (fault === "NaN") Object.assign(unusual, { ignored: Number.NaN });
      if (fault === "sparse") Object.assign(unusual, { ignored: new Array(1) });
      if (fault === "undefined") Object.assign(unusual, { ignored: [undefined] });
      if (fault === "toJSON") Object.defineProperty(unusual, "toJSON", { value: () => plain });
      if (fault === "accessor")
        Object.defineProperty(unusual, "ignored", { enumerable: true, get: () => "fixture" });
      if (fault === "prototype") Object.setPrototypeOf(unusual, { custom: true });
      const parse = vi.spyOn(protocol, "parseFactoryEvent");
      if (fault === "NaN" || fault === "undefined") {
        expect(() => digest(unusual)).toThrow();
        expect(() => digest(unusual)).toThrow();
      } else {
        digest(unusual);
        digest(unusual);
      }
      expect(parse).toHaveBeenCalledTimes(2);
    },
  );

  it("cannot hide an invalid required field behind toJSON or a non-enumerable accessor", () => {
    const event = fixture();
    const digest = createRecoveryEventDigest();
    digest(event);
    const hidden = { ...event, protocol: "unsupported", toJSON: () => event };
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(event));
    expect(() => digest(hidden as unknown as protocol.FactoryEvent)).toThrow();
    const getter = { ...event };
    Object.defineProperty(getter, "protocol", { enumerable: false, get: () => "unsupported" });
    expect(() => digest(getter)).toThrow();
    expect(() => digest({ ...event, sequence: Number.NaN })).toThrow();
    const proxy = new Proxy(event, {
      get: (target, key, receiver) =>
        key === "protocol" ? "unsupported" : Reflect.get(target, key, receiver),
    });
    expect(() => digest(proxy)).toThrow();
  });

  it("falls back to full validation when entry or byte bounds are reached", () => {
    const event = fixture();
    const parse = vi.spyOn(protocol, "parseFactoryEvent");
    const digest = createRecoveryEventDigest({ maxEntries: 1 });
    digest(event);
    digest({ ...event, sequence: 3 });
    digest({ ...event, sequence: 3 });
    digest(event);
    expect(parse).toHaveBeenCalledTimes(3);
    const tiny = createRecoveryEventDigest({ maxBytes: 1 });
    tiny(event);
    tiny(event);
    expect(parse).toHaveBeenCalledTimes(5);
    expect(() => digest({ ...event, objective: 0 })).toThrow();
  });

  it("revalidates when a standard prototype gains a parser-visible field", () => {
    const event = fixture();
    Reflect.deleteProperty(event, "reason");
    const digest = createRecoveryEventDigest();
    const expected = digest(event);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "reason");
    try {
      Object.defineProperty(Object.prototype, "reason", { configurable: true, value: 123 });
      expect(() => recoveryEventDigest(event)).toThrow();
      expect(() => digest(event)).toThrow();
      const independent = Object.assign(Object.create(null), event) as protocol.FactoryEvent;
      expect(digest(independent)).toBe(expected);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "reason", previous);
      else Reflect.deleteProperty(Object.prototype, "reason");
    }
    expect(digest(event)).toBe(expected);
  });

  it("does not share validated state across verifier invocations", () => {
    const event = fixture();
    const parse = vi.spyOn(protocol, "parseFactoryEvent");
    createRecoveryEventDigest()(event);
    createRecoveryEventDigest()(event);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(() => createRecoveryEventDigest({ maxEntries: 0 })).toThrow(/bound/);
    expect(() => createRecoveryEventDigest({ maxBytes: Infinity })).toThrow(/bound/);
  });
});
