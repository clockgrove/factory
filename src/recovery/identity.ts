import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  deduplicateFactoryEvents,
  FactoryEventConflictError,
  type FactoryEventConflictScope,
} from "../control/receipts.js";
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

function digestValidatedFactoryEvent(event: FactoryEvent): {
  canonical: string;
  digest: string;
} {
  const encoded = canonical(event);
  return {
    canonical: encoded,
    digest: createHash("sha256").update(encoded).digest("hex"),
  };
}

/** Envelope identity excludes transport metadata, but retains every parsed protocol field. */
export function recoveryEventDigest(event: FactoryEvent): string {
  assertStandardPrototypes();
  const parsed = parseFactoryEvent(materializeDataOnly(event));
  const digest = digestValidatedFactoryEvent(parsed).digest;
  assertStandardPrototypes();
  return digest;
}

// Accessors, toJSON, NaN, holes and exotic prototypes can conceal values from
// ordinary enumeration or JSON serialization. Materialize only data descriptors
// before an untrusted envelope reaches the protocol parser.
const standardPrototypeDescriptors = [
  {
    prototype: Object.prototype,
    descriptors: Object.getOwnPropertyDescriptors(Object.prototype),
  },
  {
    prototype: Array.prototype,
    descriptors: Object.getOwnPropertyDescriptors(Array.prototype),
  },
];
function standardPrototypesUnchanged(): boolean {
  for (
    let prototypeIndex = 0;
    prototypeIndex < standardPrototypeDescriptors.length;
    prototypeIndex++
  ) {
    const { prototype, descriptors } = standardPrototypeDescriptors[prototypeIndex]!;
    const current = Object.getOwnPropertyDescriptors(prototype);
    const keys = Reflect.ownKeys(descriptors);
    if (Reflect.ownKeys(current).length !== keys.length) return false;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = keys[keyIndex]!;
      const expected = Reflect.get(descriptors, key) as PropertyDescriptor;
      const observed = Reflect.get(current, key) as PropertyDescriptor | undefined;
      if (
        !observed ||
        expected.value !== observed.value ||
        expected.get !== observed.get ||
        expected.set !== observed.set ||
        expected.writable !== observed.writable ||
        expected.enumerable !== observed.enumerable ||
        expected.configurable !== observed.configurable
      )
        return false;
    }
  }
  return true;
}

function assertStandardPrototypes(): void {
  if (!standardPrototypesUnchanged())
    throw new Error("standard prototypes changed during recovery observation");
}

function materializeDataOnly(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (!value || typeof value !== "object" || depth > 32 || types.isProxy(value))
    throw new Error("recovery observation requires bounded data-only events");
  if (ancestors.has(value)) throw new Error("recovery observation requires acyclic events");
  ancestors.add(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype))
    throw new Error("recovery observation requires standard data prototypes");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string"))
    throw new Error("recovery observation does not accept symbol fields");
  const keys = ownKeys.filter((key): key is string => typeof key === "string");
  const values = array ? keys.filter((key) => key !== "length") : keys;
  if (
    (array &&
      (values.length !== value.length || values.some((key, index) => key !== String(index)))) ||
    values.some((key) => !descriptors[key]!.enumerable)
  )
    throw new Error("recovery observation does not accept sparse or hidden fields");
  const clone: unknown[] | Record<string, unknown> = array ? [] : {};
  for (const key of values) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) throw new Error("recovery observation does not accept accessors");
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: materializeDataOnly(descriptor.value, ancestors, depth + 1),
      writable: true,
    });
  }
  ancestors.delete(value);
  return clone;
}

function freezeParsedData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (!value || typeof value !== "object" || depth > 32 || types.isProxy(value))
    throw new Error("recovery observation parser returned non-data material");
  if (ancestors.has(value)) throw new Error("recovery observation parser returned a cycle");
  ancestors.add(value);
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
    throw new Error("recovery observation parser returned an exotic prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string"))
    throw new Error("recovery observation parser returned symbol fields");
  const keys = ownKeys.filter((key): key is string => typeof key === "string");
  const values = array ? keys.filter((key) => key !== "length") : keys;
  if (
    (array &&
      (values.length !== value.length || values.some((key, index) => key !== String(index)))) ||
    values.some((key) => !descriptors[key]!.enumerable)
  )
    throw new Error("recovery observation parser returned sparse or hidden material");
  for (const key of values) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    if (!("value" in descriptor))
      throw new Error("recovery observation parser returned accessor material");
    freezeParsedData(descriptor.value, ancestors, depth + 1);
  }
  Object.freeze(value);
  ancestors.delete(value);
}

interface RecoveryEventObservationCore {
  readonly digestByEvent: WeakMap<object, string>;
  readonly canonicalByEvent: WeakMap<object, string>;
  readonly canonicalBytesByEvent: WeakMap<object, number>;
  readonly byDigest: ReadonlyMap<string, FactoryEvent>;
  /** Parsed representatives in the caller's original input order, including
   * exact duplicates. This is available only through the root observation so
   * callers can authenticate source-segment ownership without reparsing raw
   * envelopes after an asynchronous observation boundary. */
  readonly validatedInputEvents: readonly FactoryEvent[];
  readonly semanticallyDeduplicatedEvents: readonly FactoryEvent[];
  readonly stats: RecoveryEventObservationStats;
}

const observationConstruction = Symbol("authenticated recovery event observation");
const authenticatedObservations = new WeakSet<object>();
const semanticConflictScopes = new WeakMap<object, readonly FactoryEventConflictScope[]>();

/** Return only scope metadata for a validated semantic conflict. Event payloads
 * remain private to observation construction and are never reparsed by callers. */
export function recoveryEventSemanticConflictScopes(
  error: unknown,
): readonly FactoryEventConflictScope[] | null {
  return error !== null && typeof error === "object"
    ? (semanticConflictScopes.get(error) ?? null)
    : null;
}

export interface RecoveryEventObservationStats {
  readonly inputEvents: number;
  readonly parsedEvents: number;
  readonly canonicalizedEvents: number;
  readonly digestedEvents: number;
  readonly retainedEvents: number;
  readonly canonicalBytes: number;
}

export interface RecoveryEventObservationOptions {
  maxEvents?: number;
  maxBytes?: number;
  sortBySequence?: boolean;
}

export interface AsyncRecoveryEventObservationOptions extends RecoveryEventObservationOptions {
  /** A small batch keeps controller cancellation/deadline observation responsive. */
  batchSize?: number;
  signal?: AbortSignal;
}

interface RecoveryEventObservationBounds {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

function observationBounds(
  options: RecoveryEventObservationOptions,
): RecoveryEventObservationBounds {
  const maxEvents = options.maxEvents ?? 50_000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 50_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024 ||
    (options.sortBySequence !== undefined && typeof options.sortBySequence !== "boolean")
  )
    throw new Error("invalid recovery event observation bound");
  return { maxEvents, maxBytes };
}

function observationInput(input: readonly unknown[], maxEvents: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > maxEvents
  )
    throw new Error("invalid recovery event observation bound");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  const indices = keys.filter((key) => key !== "length");
  if (
    indices.some((key) => typeof key !== "string") ||
    indices.length !== input.length ||
    indices.some((key, index) => key !== String(index)) ||
    indices.some((key) => {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      return !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    throw new Error("recovery observation requires a dense data-only event list");
  return indices.map((key) => {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor & { value: unknown };
    return descriptor.value;
  });
}

function abortObservation(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("recovery event observation aborted");
}

class RecoveryEventObservationBuilder {
  readonly #digestByEvent = new WeakMap<object, string>();
  readonly #canonicalByEvent = new WeakMap<object, string>();
  readonly #canonicalBytesByEvent = new WeakMap<object, number>();
  readonly #parsed: FactoryEvent[] = [];
  #canonicalBytes = 0;

  addMaterialized(materialized: unknown, maxBytes: number): void {
    const event = parseFactoryEvent(materialized);
    freezeParsedData(event);
    const identity = digestValidatedFactoryEvent(event);
    const canonicalBytes = Buffer.byteLength(identity.canonical, "utf8");
    this.#canonicalBytes += canonicalBytes;
    if (this.#canonicalBytes > maxBytes)
      throw new Error("recovery event observation exceeds byte bound");
    this.#digestByEvent.set(event, identity.digest);
    this.#canonicalByEvent.set(event, identity.canonical);
    this.#canonicalBytesByEvent.set(event, canonicalBytes);
    this.#parsed.push(event);
  }

  finish(inputEvents: number, sortBySequence: boolean): RecoveryEventObservation {
    const byDigest = new Map<string, FactoryEvent>();
    for (const event of this.#parsed) {
      const digest = this.#digestByEvent.get(event);
      const encoded = this.#canonicalByEvent.get(event);
      if (!digest || encoded === undefined)
        throw new Error("recovery event observation index is incomplete");
      const prior = byDigest.get(digest);
      if (prior && this.#canonicalByEvent.get(prior) !== encoded)
        throw new Error("recovery event observation digest collision");
      if (!prior) byDigest.set(digest, event);
    }
    const retained = [...byDigest.values()];
    const validatedInputEvents = Object.freeze(
      this.#parsed.map((event) => {
        const digest = this.#digestByEvent.get(event);
        const representative = digest === undefined ? undefined : byDigest.get(digest);
        if (!representative)
          throw new Error("recovery event observation input index is incomplete");
        return representative;
      }),
    );
    // Detect semantic conflicts once, but retain each byte-distinct envelope.
    // Transaction inspection relies on seeing distinct retries that differ in
    // sequence or timestamp rather than silently collapsing them.
    let semanticallyDeduplicatedEvents: readonly FactoryEvent[];
    try {
      semanticallyDeduplicatedEvents = Object.freeze(deduplicateFactoryEvents(retained));
    } catch (error) {
      if (error instanceof FactoryEventConflictError) {
        const observationError = new Error("conflicting Factory events in recovery observation");
        semanticConflictScopes.set(observationError, error.scopes);
        throw observationError;
      }
      throw error;
    }
    if (sortBySequence) retained.sort((left, right) => left.sequence - right.sequence);
    const stats = Object.freeze({
      inputEvents,
      parsedEvents: inputEvents,
      canonicalizedEvents: inputEvents,
      digestedEvents: inputEvents,
      retainedEvents: retained.length,
      canonicalBytes: this.#canonicalBytes,
    });
    const core: RecoveryEventObservationCore = {
      digestByEvent: this.#digestByEvent,
      canonicalByEvent: this.#canonicalByEvent,
      canonicalBytesByEvent: this.#canonicalBytesByEvent,
      byDigest,
      validatedInputEvents,
      semanticallyDeduplicatedEvents,
      stats,
    };
    return new RecoveryEventObservation(
      observationConstruction,
      core,
      retained,
      new Set(retained),
      false,
      true,
    );
  }
}

/**
 * One complete, immutable, authenticated event observation. Object identity is
 * trusted only for the parsed and frozen values owned by this instance; a new
 * repository read must construct a new observation.
 */
export class RecoveryEventObservation {
  readonly events: readonly FactoryEvent[];
  /** Compatibility view for identities that historically applied semantic
   * request/writer retry collapse after exact envelope deduplication. */
  readonly semanticallyDeduplicatedEvents: readonly FactoryEvent[];
  /** Canonical bytes retained by this full observation or derived view. */
  readonly retainedCanonicalBytes: number;
  readonly stats: RecoveryEventObservationStats;
  readonly #core: RecoveryEventObservationCore;
  readonly #members: ReadonlySet<FactoryEvent> | null;
  readonly #semantic: boolean;
  readonly #fullInput: boolean;

  constructor(
    construction: symbol,
    core: RecoveryEventObservationCore,
    events: readonly FactoryEvent[],
    members: ReadonlySet<FactoryEvent> | null,
    semantic: boolean,
    fullInput: boolean,
  ) {
    if (construction !== observationConstruction)
      throw new Error("recovery event observations require authenticated construction");
    this.#core = core;
    this.events = Object.freeze([...events]);
    this.#members = members;
    this.#semantic = semantic;
    this.#fullInput = fullInput;
    this.semanticallyDeduplicatedEvents = Object.freeze(
      core.semanticallyDeduplicatedEvents.filter((event) => members?.has(event)),
    );
    this.retainedCanonicalBytes = events.reduce((total, event) => {
      const bytes = core.canonicalBytesByEvent.get(event);
      if (bytes === undefined)
        throw new Error("recovery event observation byte index is incomplete");
      return total + bytes;
    }, 0);
    this.stats = core.stats;
    authenticatedObservations.add(this);
    Object.freeze(this);
  }

  static create(
    input: readonly unknown[],
    options: RecoveryEventObservationOptions = {},
  ): RecoveryEventObservation {
    assertStandardPrototypes();
    const { maxEvents, maxBytes } = observationBounds(options);
    const values = observationInput(input, maxEvents);
    const builder = new RecoveryEventObservationBuilder();
    for (const raw of values) builder.addMaterialized(materializeDataOnly(raw), maxBytes);
    assertStandardPrototypes();
    return builder.finish(values.length, options.sortBySequence === true);
  }

  assertIntact(): void {
    if (!authenticatedObservations.has(this))
      throw new Error("recovery event observation is not authenticated");
    assertStandardPrototypes();
  }

  digestOf(event: FactoryEvent): string {
    if (!this.#members?.has(event))
      throw new Error("recovery event does not belong to this observation view");
    const digest = this.#core.digestByEvent.get(event);
    if (digest === undefined) throw new Error("recovery event does not belong to this observation");
    return digest;
  }

  canonicalOf(event: FactoryEvent): string {
    if (!this.#members?.has(event))
      throw new Error("recovery event does not belong to this observation view");
    const encoded = this.#core.canonicalByEvent.get(event);
    if (encoded === undefined)
      throw new Error("recovery event does not belong to this observation");
    return encoded;
  }

  /** Return authenticated events aligned one-for-one with the original input.
   * Derived views cannot expose this mapping because their membership no
   * longer represents the complete source stream. */
  validatedInputEvents(): readonly FactoryEvent[] {
    this.assertIntact();
    if (!this.#fullInput)
      throw new Error("recovery event input mapping requires the root observation");
    return this.#core.validatedInputEvents;
  }

  findByDigest(digest: string): FactoryEvent | undefined {
    const event = this.#core.byDigest.get(digest);
    if (!event || !this.#members?.has(event)) return undefined;
    return event;
  }

  /** Preserve the established retry-selection semantics without repeating
   * conflict detection, schema validation, canonicalization, or digest work. */
  semanticView(): RecoveryEventObservation {
    this.assertIntact();
    if (this.#semantic) return this;
    const events = this.semanticallyDeduplicatedEvents;
    return new RecoveryEventObservation(
      observationConstruction,
      this.#core,
      events,
      new Set(events),
      true,
      false,
    );
  }

  select(predicate: (event: FactoryEvent) => boolean): RecoveryEventObservation {
    this.assertIntact();
    const events = this.events.filter(predicate);
    this.assertIntact();
    return new RecoveryEventObservation(
      observationConstruction,
      this.#core,
      events,
      new Set(events),
      this.#semantic,
      false,
    );
  }
}

export type RecoveryEventInput = readonly FactoryEvent[] | RecoveryEventObservation;

export function recoveryEventObservation(
  input: RecoveryEventInput,
  options: RecoveryEventObservationOptions = {},
): RecoveryEventObservation {
  if (input instanceof RecoveryEventObservation && authenticatedObservations.has(input)) {
    const bounds = observationBounds(options);
    input.assertIntact();
    if (
      (options.maxEvents !== undefined && input.events.length > bounds.maxEvents) ||
      (options.maxBytes !== undefined && input.retainedCanonicalBytes > bounds.maxBytes)
    )
      throw new Error("recovery event observation exceeds scope bound");
    if (
      options.sortBySequence === true &&
      input.events.some(
        (event, index) => index > 0 && input.events[index - 1]!.sequence > event.sequence,
      )
    )
      throw new Error("recovery event observation is not sequence sorted");
    return input;
  }
  if (input instanceof RecoveryEventObservation)
    throw new Error("recovery event observation is not authenticated");
  return RecoveryEventObservation.create(input, options);
}

/** Build a complete observation without monopolizing the controller event loop. */
export async function observeRecoveryEvents(
  input: readonly unknown[],
  options: AsyncRecoveryEventObservationOptions = {},
): Promise<RecoveryEventObservation> {
  assertStandardPrototypes();
  const { maxEvents, maxBytes } = observationBounds(options);
  const inputValues = observationInput(input, maxEvents);
  const batchSize = options.batchSize ?? 256;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 4096)
    throw new Error("invalid recovery event observation batch bound");
  abortObservation(options.signal);
  assertStandardPrototypes();
  // Capture the complete data-only contents before the first event-loop yield.
  // Parsing and identity work can then remain batched without allowing a caller
  // mutation to combine values from different moments into one observation.
  const values = inputValues.map((value) => materializeDataOnly(value));
  abortObservation(options.signal);
  assertStandardPrototypes();
  const builder = new RecoveryEventObservationBuilder();
  for (let offset = 0; offset < values.length; offset += batchSize) {
    abortObservation(options.signal);
    assertStandardPrototypes();
    const end = Math.min(values.length, offset + batchSize);
    for (let index = offset; index < end; index++) builder.addMaterialized(values[index], maxBytes);
    if (offset + batchSize < values.length)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  abortObservation(options.signal);
  assertStandardPrototypes();
  return builder.finish(values.length, options.sortBySequence === true);
}

/** Exact authenticated source prefix; recovery acknowledgements are excluded to avoid circularity. */
export function recoverySourceEventsDigest(input: {
  objective: number;
  runIds: readonly string[];
  events: RecoveryEventInput;
  maxSequence: number;
}): string {
  const observation = recoveryEventObservation(input.events);
  if (
    !Number.isSafeInteger(input.objective) ||
    input.objective <= 0 ||
    !Number.isSafeInteger(input.maxSequence) ||
    input.maxSequence < 0 ||
    observation.events.length > 50_000 ||
    input.runIds.length === 0 ||
    input.runIds.length > 100 ||
    new Set(input.runIds).size !== input.runIds.length
  )
    throw new Error("recovery source identity exceeds scope bounds");
  const selected = new Set(input.runIds);
  const source = observation.semanticallyDeduplicatedEvents.filter(
    (event) => selected.has(event.runId) && event.kind !== "recovery",
  );
  if (
    source.some(
      (event) => event.objective !== input.objective || !Number.isSafeInteger(event.sequence),
    )
  )
    throw new Error("recovery source identity differs from Objective scope");
  const envelopes = source
    .filter((event) => event.sequence <= input.maxSequence)
    .map((event) => ({ sequence: event.sequence, envelope: observation.canonicalOf(event) }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.envelope.localeCompare(right.envelope),
    )
    .map(({ envelope }) => envelope);
  return createHash("sha256")
    .update(`[${envelopes.join(",")}]`)
    .digest("hex");
}
