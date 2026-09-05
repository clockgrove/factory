import { createHash } from "node:crypto";
import { types } from "node:util";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";

/** One immutable admission claim per predecessor; pending claims must be reconciled, not replaced. */
export function recoveryClaimRef(objective: number, predecessorRunId: string): string {
  if (
    !Number.isSafeInteger(objective) ||
    objective <= 0 ||
    !/^[A-Za-z0-9._:/+-]{1,160}$/.test(predecessorRunId)
  )
    throw new Error("invalid recovery claim identity");
  return `refs/clockgrove-factory/recovery-claims/objective-${objective}/predecessor-${createHash("sha256").update(predecessorRunId).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("recovery identity requires JSON data");
}

/** Envelope identity excludes transport metadata, but retains every parsed protocol field. */
export function recoveryEventDigest(event: FactoryEvent): string {
  return createHash("sha256")
    .update(canonical(parseFactoryEvent(event)))
    .digest("hex");
}

// Do not stringify arbitrary objects into cache keys: accessors, toJSON, NaN,
// holes, and exotic prototypes can conceal values the protocol parser rejects.
const standardPrototypeDescriptors = [Object.prototype, Array.prototype].map((prototype) => ({
  prototype,
  descriptors: Object.getOwnPropertyDescriptors(prototype),
}));
function standardPrototypesUnchanged(): boolean {
  return standardPrototypeDescriptors.every(({ prototype, descriptors }) => {
    const current = Object.getOwnPropertyDescriptors(prototype);
    const keys = Reflect.ownKeys(descriptors);
    return (
      Reflect.ownKeys(current).length === keys.length &&
      keys.every((key) => {
        const expected = Reflect.get(descriptors, key) as PropertyDescriptor;
        const observed = Reflect.get(current, key) as PropertyDescriptor | undefined;
        return (
          observed &&
          expected.value === observed.value &&
          expected.get === observed.get &&
          expected.set === observed.set &&
          expected.writable === observed.writable &&
          expected.enumerable === observed.enumerable &&
          expected.configurable === observed.configurable
        );
      })
    );
  });
}

function dataOnlyKey(value: unknown, depth = 0): string | null {
  if (depth > 32) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (!value || typeof value !== "object") return null;
  if (types.isProxy(value)) return null;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array))
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => descriptors[key]!.enumerable);
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
    return null;
  const parts: string[] = [];
  for (const key of array ? keys : keys.sort()) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) return null;
    const encoded = dataOnlyKey(descriptor.value, depth + 1);
    if (encoded === null) return null;
    parts.push(array ? encoded : `${JSON.stringify(key)}:${encoded}`);
  }
  // A non-enumerable known field or accessor is still visible to the parser.
  if (
    Object.keys(descriptors).some(
      (key) => !descriptors[key]!.enumerable && !(array && key === "length"),
    )
  )
    return null;
  return array
    ? `[${parts.join(",")}]`
    : `${prototype === null ? "null:" : "plain:"}{${parts.join(",")}}`;
}

/** One verification call's bounded content cache. Every miss uses the unchanged
 * schema/secret validation. No object identity or mutable repository read is cached. */
export function createRecoveryEventDigest(
  options: { maxEntries?: number; maxBytes?: number } = {},
): typeof recoveryEventDigest {
  const maxEntries = options.maxEntries ?? 512;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 1024 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 16 * 1024 * 1024
  )
    throw new Error("invalid recovery identity cache bound");
  const cache = new Map<string, string>();
  let bytes = 0;
  return (event) => {
    const key = standardPrototypesUnchanged() ? dataOnlyKey(event) : null;
    const existing = key === null ? undefined : cache.get(key);
    if (existing !== undefined) return existing;
    const digest = recoveryEventDigest(event);
    if (key !== null && cache.size < maxEntries) {
      const size = Buffer.byteLength(key, "utf8");
      if (bytes + size <= maxBytes) {
        cache.set(key, digest);
        bytes += size;
      }
    }
    return digest;
  };
}

/** Exact authenticated source prefix; recovery acknowledgements are excluded to avoid circularity. */
export function recoverySourceEventsDigest(input: {
  objective: number;
  runIds: readonly string[];
  events: readonly FactoryEvent[];
  maxSequence: number;
}): string {
  if (
    !Number.isSafeInteger(input.objective) ||
    input.objective <= 0 ||
    !Number.isSafeInteger(input.maxSequence) ||
    input.maxSequence < 0 ||
    input.events.length > 50_000 ||
    input.runIds.length === 0 ||
    input.runIds.length > 100 ||
    new Set(input.runIds).size !== input.runIds.length
  )
    throw new Error("recovery source identity exceeds scope bounds");
  const selected = new Set(input.runIds);
  const source = input.events.filter(
    (event) => selected.has(event.runId) && event.kind !== "recovery",
  );
  if (
    source.some(
      (event) => event.objective !== input.objective || !Number.isSafeInteger(event.sequence),
    )
  )
    throw new Error("recovery source identity differs from Objective scope");
  const envelopes = deduplicateFactoryEvents(
    source.filter((event) => event.sequence <= input.maxSequence).map(parseFactoryEvent),
  )
    .map((event) => ({ sequence: event.sequence, envelope: canonical(event) }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.envelope.localeCompare(right.envelope),
    )
    .map(({ envelope }) => envelope);
  return createHash("sha256")
    .update(`[${envelopes.join(",")}]`)
    .digest("hex");
}
