import { Buffer } from "node:buffer";

import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { MAX_PERSISTED_EVENT_BYTES, validatePersistable } from "../protocol/limits.js";

const COMMENT_OPEN = "<!-- clockgrove-factory:event\n";
const COMMENT_CLOSE = "\n-->";
const TRAILER = "Factory-Event:";

export function encodeEventComment(summary: string, event: FactoryEvent): string {
  const cleanSummary = summary.trim();
  if (!cleanSummary || Buffer.byteLength(cleanSummary, "utf8") > 8_000) {
    throw new Error("event summary must be between 1 and 8000 bytes");
  }
  if (cleanSummary.includes("<!-- clockgrove-factory:event")) {
    throw new Error("event summary contains the reserved Factory envelope marker");
  }
  const parsed = parseFactoryEvent(event);
  const body = `${cleanSummary}\n\n${COMMENT_OPEN}${JSON.stringify(parsed)}${COMMENT_CLOSE}`;
  validatePersistable(body, MAX_PERSISTED_EVENT_BYTES + 8_192, "Factory comment");
  return body;
}

export function decodeEventComments(body: string): FactoryEvent[] {
  const events: FactoryEvent[] = [];
  let offset = 0;
  while (offset < body.length) {
    const start = body.indexOf(COMMENT_OPEN, offset);
    if (start < 0) break;
    const payloadStart = start + COMMENT_OPEN.length;
    const end = body.indexOf(COMMENT_CLOSE, payloadStart);
    if (end < 0) throw new Error("unterminated Factory event envelope");
    const raw = body.slice(payloadStart, end);
    if (Buffer.byteLength(raw, "utf8") > MAX_PERSISTED_EVENT_BYTES) {
      throw new Error("Factory event envelope exceeds the size limit");
    }
    events.push(parseFactoryEvent(JSON.parse(raw)));
    offset = end + COMMENT_CLOSE.length;
  }
  return events;
}

export function encodeEventTrailer(event: FactoryEvent): string {
  const parsed = parseFactoryEvent(event);
  const encoded = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  return `${TRAILER} ${encoded}`;
}

export function decodeEventTrailer(message: string): FactoryEvent | null {
  const line = message
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(`${TRAILER} `));
  if (!line) return null;
  const encoded = line.slice(TRAILER.length + 1).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("invalid Factory event trailer encoding");
  }
  const raw = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_PERSISTED_EVENT_BYTES) {
    throw new Error("Factory event trailer exceeds the size limit");
  }
  return parseFactoryEvent(JSON.parse(raw));
}

export function latestSupportedRun(events: FactoryEvent[]): FactoryEvent | null {
  const runs = deduplicateFactoryEvents(events)
    .filter((event) => event.kind === "run")
    .sort((a, b) => a.sequence - b.sequence);
  const starts = runs.filter((event) => event.event === "FactoryRunStarted");
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i]!;
    const terminal = runs.some(
      (event) =>
        event.runId === start.runId &&
        event.sequence > start.sequence &&
        ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event),
    );
    if (!terminal) return start;
  }
  return null;
}

export interface RunReceiptSet {
  runId: string;
  start: Extract<FactoryEvent, { kind: "run"; event: "FactoryRunStarted" }>;
  terminal?: Extract<
    FactoryEvent,
    {
      kind: "run";
      event: "FactoryRunCompleted" | "FactoryRunCancelled" | "FactoryRunEscalated";
    }
  >;
  events: FactoryEvent[];
}

/**
 * Select the most recently started run and its complete, sequence-ordered
 * evidence stream. This is intentionally useful for both active and terminal
 * runs; `latestSupportedRun` remains the active-run authority check.
 */
export function latestRunReceipts(events: FactoryEvent[]): RunReceiptSet | null {
  const deduplicated = deduplicateFactoryEvents(events).sort(
    (left, right) => left.sequence - right.sequence,
  );
  const start = [...deduplicated]
    .reverse()
    .find(
      (event): event is RunReceiptSet["start"] =>
        event.kind === "run" && event.event === "FactoryRunStarted",
    );
  if (!start) return null;
  const runEvents = deduplicated.filter((event) => event.runId === start.runId);
  const terminal = [...runEvents]
    .reverse()
    .find(
      (event): event is NonNullable<RunReceiptSet["terminal"]> =>
        event.kind === "run" &&
        ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event),
    );
  return {
    runId: start.runId,
    start,
    ...(terminal ? { terminal } : {}),
    events: runEvents,
  };
}

/**
 * GitHub may accept a comment mutation and lose the response, after which an
 * HTTP retry can create the same receipt twice. Sequence plus the event's
 * scope is its idempotency key: exact duplicates collapse, while conflicting
 * payloads at that identity fail closed instead of corrupting ledgers. The
 * scope suffix also tolerates a cancellation writer racing one Supervisor
 * event after both observed the same prior sequence.
 */
export function deduplicateFactoryEvents(events: FactoryEvent[]): FactoryEvent[] {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const requestFingerprint = (event: FactoryEvent): string => {
    const semantic = { ...event } as Record<string, unknown>;
    delete semantic.at;
    delete semantic.sequence;
    if (typeof semantic.requestedBy === "string") {
      semantic.requestedBy = semantic.requestedBy.toLowerCase();
    }
    if (typeof semantic.repository === "string") {
      semantic.repository = semantic.repository.toLowerCase();
    }
    return canonical(semantic);
  };
  const applicationRequests = new Map<string, { encoded: string; event: FactoryEvent }>();
  const bySequence = new Map<string, { encoded: string; event: FactoryEvent }>();
  for (const event of events) {
    const workItem = "workItem" in event ? (event.workItem ?? "") : "";
    const attempt = "attempt" in event ? (event.attempt ?? "") : "";
    const phase = "phase" in event ? event.phase : "";
    const unit = "unit" in event ? event.unit : "";
    const requestId = "requestId" in event ? event.requestId : "";
    if (typeof requestId === "string" && requestId) {
      const key = `${event.objective}:${requestId}`;
      const encoded = requestFingerprint(event);
      const prior = applicationRequests.get(key);
      if (prior && prior.encoded !== encoded) {
        throw new Error(`conflicting Factory application requests at ${key}`);
      }
      if (
        !prior ||
        event.sequence < prior.event.sequence ||
        (event.sequence === prior.event.sequence && event.at < prior.event.at)
      ) {
        applicationRequests.set(key, { encoded, event });
      }
      continue;
    }
    const key = [
      event.runId,
      event.sequence,
      event.kind,
      event.event,
      workItem,
      attempt,
      phase,
      unit,
      requestId,
    ].join(":");
    const encoded = JSON.stringify(event);
    const prior = bySequence.get(key);
    if (prior && prior.encoded !== encoded) {
      throw new Error(`conflicting Factory events at ${key}`);
    }
    if (!prior) bySequence.set(key, { encoded, event });
  }
  return [...bySequence.values(), ...applicationRequests.values()]
    .map(({ event }) => event)
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.at.localeCompare(right.at) ||
        left.event.localeCompare(right.event),
    );
}

/** Allocate the next objective-wide event sequence from reconstructed state. */
export function nextEventSequence(...streams: ReadonlyArray<FactoryEvent[]>): number {
  return Math.max(0, ...streams.flat().map((event) => event.sequence)) + 1;
}
