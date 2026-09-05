import { createHash } from "node:crypto";
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
