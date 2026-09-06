import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";

type PublicationEvent = Extract<FactoryEvent, { kind: "publication" }>;

function parsed(event: PublicationEvent): PublicationEvent {
  const value = parseFactoryEvent(event);
  if (value.kind !== "publication" || value.event !== "PublicationRecorded")
    throw new Error("publication selection requires recorded publication envelopes");
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function semantic(event: PublicationEvent): string {
  const { sequence: _sequence, at: _at, reason: _reason, ...binding } = parsed(event);
  // Authentication/transport metadata is separate from the original envelope.
  // Preserve every protocol field, including unknown forward-compatible fields.
  return canonical(binding);
}

export function equivalentPublicationRecords(
  left: PublicationEvent,
  right: PublicationEvent,
): boolean {
  return semantic(left) === semantic(right);
}

/** Select one representative, never erase audit history or grant authentication.
 * Callers supply authenticated receipts for one intended publication revision.
 * A pre-existing immutable proof must keep its exact selected envelope. */
export function selectEquivalentPublicationRecord(
  records: readonly PublicationEvent[],
  preferred?: PublicationEvent,
): PublicationEvent | null {
  if (records.length > 256) throw new Error("publication equivalence exceeds scope bound");
  deduplicateFactoryEvents(records.map(parsed));
  if (records.length === 0) {
    if (preferred) throw new Error("pinned publication envelope is unavailable");
    return null;
  }
  const expected = semantic(records[0]!);
  if (records.some((record) => semantic(record) !== expected))
    throw new Error("authenticated publication receipts have conflicting bindings");
  if (preferred) {
    const envelope = canonical(parsed(preferred));
    const exact = records.find((record) => canonical(parsed(record)) === envelope);
    if (!exact) throw new Error("pinned publication envelope is unavailable");
    return exact;
  }
  return [...records].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.at.localeCompare(right.at) ||
      JSON.stringify(parsed(left)).localeCompare(JSON.stringify(parsed(right))),
  )[0]!;
}
