/**
 * One fault model for every adapter (recovery v2.2, #515). Only adapters
 * classify: the GitHub gateway, the git wrapper, each model adapter, and each
 * execution driver and sandbox provider. They attach a `Fault` to the error
 * they already throw; runners read it with `faultOf`, and anything nobody
 * classified is a `defect`.
 */

import * as time from "./clock.js";

/** What a failed result showed, for repair and the operator. */
export interface FailureEvidence {
  detail: string;
}

export type Fault =
  /** Repeat later: network, 5xx, lag, rate or usage limit, lost response, dead worker. */
  | {
      kind: "transient";
      detail: string;
      /** Do not repeat before this time (ISO 8601). */
      retryAt?: string;
      /**
       * Whether this fault counts against a paid step's bound: the effect may
       * have happened or been paid for (a lost response, a dead worker, an
       * invalid answer). Limits with a reset time and free calls never count.
       */
      outcomeUnknown: boolean;
    }
  /** Needs the operator: a foreign change, a refusal, a repeated paid failure. */
  | { kind: "decision"; question: string; evidence: string[] }
  /** The produced result is wrong: repair it or retry. */
  | { kind: "work"; evidence: FailureEvidence }
  /** Credentials, permissions or installation; resumes after the named fix. */
  | { kind: "config"; detail: string; fix: string }
  /** An invariant broke: stop and report. */
  | { kind: "defect"; detail: string }
  /** The operator cancelled while the step ran; not a failure. */
  | { kind: "cancelled"; detail: string };

export type FaultKind = Fault["kind"];

export function faultDetail(fault: Fault): string {
  switch (fault.kind) {
    case "decision":
      return fault.question;
    case "work":
      return fault.evidence.detail;
    default:
      return fault.detail;
  }
}

/** An error that is its fault; later steps throw these directly. */
export class StepFault extends Error {
  constructor(
    readonly fault: Fault,
    options?: ErrorOptions,
  ) {
    super(faultDetail(fault), options);
    this.name = "StepFault";
  }
}

/** The operator cancelled: the `cancelled` fault, never an unclassified error. */
export function cancelledFault(detail = "Objective cancelled"): StepFault {
  return new StepFault({ kind: "cancelled", detail });
}

const FAULT = "fault";

/**
 * Attach a classification to an error an adapter is about to throw. The
 * first classification wins, so the layer nearest the effect keeps its
 * context. The property is non-enumerable: messages, serialization and
 * inspection of the error are unchanged.
 */
export function attachFault<E>(error: E, fault: Fault | undefined): E {
  if (
    fault &&
    error !== null &&
    typeof error === "object" &&
    !Object.hasOwn(error, FAULT) &&
    !(error instanceof StepFault) &&
    Object.isExtensible(error)
  )
    Object.defineProperty(error, FAULT, {
      value: fault,
      enumerable: false,
      configurable: true,
    });
  return error;
}

/**
 * The classification an adapter attached to this error, or to the error it
 * wraps (such as a driver error around a provider failure). Anything no
 * adapter classified is a defect.
 */
export function faultOf(error: unknown): Fault {
  return (
    attachedFault(error) ?? {
      kind: "defect",
      detail: error instanceof Error ? error.message : String(error),
    }
  );
}

/** The classification on this error or the errors it wraps, if any. */
export function attachedFault(error: unknown): Fault | undefined {
  for (
    let current: unknown = error, depth = 0;
    current !== null && typeof current === "object" && depth < 8;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    if (current instanceof StepFault) return current.fault;
    const attached = (current as { fault?: unknown }).fault;
    if (isFault(attached)) return attached;
  }
  return undefined;
}

const iso = (value: unknown): boolean =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Exact shape check, used for attached faults and persisted state. */
export function isFault(value: unknown): value is Fault {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fault = value as Record<string, unknown>;
  const keys = Object.keys(fault).sort().join(",");
  switch (fault.kind) {
    case "transient":
      return (
        (keys === "detail,kind,outcomeUnknown" ||
          (keys === "detail,kind,outcomeUnknown,retryAt" &&
            iso(fault.retryAt))) &&
        text(fault.detail) &&
        typeof fault.outcomeUnknown === "boolean"
      );
    case "decision":
      return (
        keys === "evidence,kind,question" &&
        text(fault.question) &&
        Array.isArray(fault.evidence) &&
        fault.evidence.every(text)
      );
    case "work": {
      const evidence = fault.evidence as Record<string, unknown> | undefined;
      return (
        keys === "evidence,kind" &&
        !!evidence &&
        typeof evidence === "object" &&
        Object.keys(evidence).join(",") === "detail" &&
        text(evidence.detail)
      );
    }
    case "config":
      return (
        keys === "detail,fix,kind" && text(fault.detail) && text(fault.fix)
      );
    case "defect":
    case "cancelled":
      return keys === "detail,kind" && text(fault.detail);
    default:
      return false;
  }
}

export type FaultClassifier = (
  error: unknown,
  method: string,
) => Fault | undefined;

/**
 * Method decorator for an adapter boundary: errors leaving the method keep
 * their identity and gain the classification the adapter gives them.
 * Synchronous methods stay synchronous.
 */
export function classifyFaults(classify: FaultClassifier) {
  return <This, Args extends unknown[], Return>(
    method: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >,
  ): ((this: This, ...args: Args) => Return) => {
    const name = String(context.name);
    return function (this: This, ...args: Args): Return {
      return withFault(
        () => method.call(this, ...args),
        (error) => classify(error, name),
      );
    };
  };
}

/**
 * Run an adapter call and classify what it throws (or rejects with). The
 * error keeps its identity; a synchronous call stays synchronous.
 */
export function withFault<T>(
  run: () => T,
  classify: (error: unknown) => Fault | undefined,
): T {
  const fail = (error: unknown): never => {
    throw attachFault(error, classify(error));
  };
  let result: T;
  try {
    result = run();
  } catch (error) {
    return fail(error);
  }
  return (result instanceof Promise ? result.catch(fail) : result) as T;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Node, undici and fetch codes for a request that failed in transit. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Whether an error, or one of its causes, is a transport failure. */
export function networkFailure(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 5) return false;
  const code = (error as { code?: unknown }).code;
  return (
    error.message === "fetch failed" ||
    /Connection|Timeout/.test(error.name) ||
    (typeof code === "string" && NETWORK_CODES.has(code)) ||
    networkFailure(error.cause, depth + 1)
  );
}

type HeaderSource =
  | { get(name: string): unknown }
  | Record<string, unknown>
  | undefined
  | null;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const value =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): unknown }).get(name)
      : ((headers as Record<string, unknown>)[name] ??
        (headers as Record<string, unknown>)[name.toLowerCase()]);
  return value === undefined || value === null ? undefined : String(value);
}

/** When a rate-limited request may be sent again, from standard headers. */
export function retryAfter(
  headers: HeaderSource,
  now = time.now(),
): string | undefined {
  const retry = header(headers, "retry-after");
  if (retry !== undefined) {
    const seconds = Number(retry);
    const until = Number.isFinite(seconds)
      ? now + seconds * 1000
      : Date.parse(retry);
    if (Number.isFinite(until)) return new Date(until).toISOString();
  }
  return undefined;
}

/**
 * Generic classification of a provider SDK or HTTP error by status, headers
 * and transport codes. Statuses whose meaning depends on the call (404, 409,
 * 422) are left to the caller.
 */
export function requestFault(
  error: unknown,
  options: { outcomeUnknown: boolean; fix: string; now?: number },
): Fault | undefined {
  if (!(error instanceof Error)) return undefined;
  const { status, statusCode, headers } = error as {
    status?: unknown;
    statusCode?: unknown;
    headers?: HeaderSource;
  };
  const http = typeof status === "number" ? status : statusCode;
  const detail = message(error);
  if (typeof http === "number") {
    if (http === 401 || http === 403)
      return { kind: "config", detail, fix: options.fix };
    if (http === 429) {
      const retryAt = retryAfter(headers, options.now);
      return {
        kind: "transient",
        detail,
        ...(retryAt && { retryAt }),
        outcomeUnknown: false,
      };
    }
    if (http === 408 || http >= 500)
      return {
        kind: "transient",
        detail,
        outcomeUnknown: options.outcomeUnknown,
      };
    return undefined;
  }
  if (networkFailure(error))
    return {
      kind: "transient",
      detail,
      outcomeUnknown: options.outcomeUnknown,
    };
  return undefined;
}

export const transient = (
  detail: string,
  outcomeUnknown: boolean,
  retryAt?: string,
): Fault => ({
  kind: "transient",
  detail,
  ...(retryAt && { retryAt }),
  outcomeUnknown,
});

export const decision = (question: string, ...evidence: string[]): Fault => ({
  kind: "decision",
  question,
  evidence,
});

/** A run of transient faults with no progress between them. */
export interface FaultRun {
  /** When the run began (wall clock, for the operator). */
  since: string;
  count: number;
  last: Fault;
  /**
   * Time the run has lasted while a controller was running the step. The
   * 24-hour escalation reads this, so controller downtime never counts.
   */
  activeMs: number;
}

/**
 * A step's persisted repeat record, keyed by `repeatKey` (src/step.ts):
 * `item/<id>/<step>` or `objective/<step>`. Written only by `step`.
 */
export interface RepeatRecord {
  /** Earliest time the step runs again (backoff or a pending poll). */
  nextAt?: string;
  /** When `nextAt` was chosen; with it, bounds the sleep if the clock jumps. */
  scheduledAt?: string;
  faults?: FaultRun;
  /**
   * Paid-call faults that may have been paid for. Progress does not reset
   * it; success, work, defect and the operator's retry do.
   */
  paid?: number;
  /** A paid call started and has not settled; a restart counts it. */
  inFlight?: true;
  /** A decision the step asked and the operator has not answered. */
  asked?: string;
  /**
   * Why the paid step's last answer was invalid: the next ask carries it,
   * across a restart, until the step ends.
   */
  invalid?: string;
}

export type WaitKind =
  | "ci"
  | "capacity"
  | "dependency"
  | "decision"
  | "prerequisite";

/** Why an item or Objective is not progressing right now. */
export interface Wait {
  kind: WaitKind;
  detail: string;
  /** On a `prerequisite` from a `config` fault: what the operator must fix. */
  fix?: string;
  /** The repeat key of the step that wrote this wait; absent for callers' waits. */
  step?: string;
}

const WAIT_KINDS = new Set<string>([
  "ci",
  "capacity",
  "dependency",
  "decision",
  "prerequisite",
]);
const STEP_NAME = /^[a-z][a-z-]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The scope and step a repeat key names, or undefined when it is malformed. */
export function parseRepeatKey(
  key: string,
): { item?: string; step: string } | undefined {
  const parts = key.split("/");
  if (
    parts.length === 2 &&
    parts[0] === "objective" &&
    STEP_NAME.test(parts[1]!)
  )
    return { step: parts[1]! };
  if (
    parts.length === 3 &&
    parts[0] === "item" &&
    IDENTITY.test(parts[1]!) &&
    STEP_NAME.test(parts[2]!)
  )
    return { item: parts[1]!, step: parts[2]! };
  return undefined;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

const atLeast = (value: unknown, least: number) =>
  Number.isSafeInteger(value) && Number(value) >= least;

function validFaultRun(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    Object.keys(run).sort().join(",") === "activeMs,count,last,since" &&
    iso(run.since) &&
    atLeast(run.count, 1) &&
    atLeast(run.activeMs, 0) &&
    isFault(run.last) &&
    run.last.kind === "transient"
  );
}

/**
 * Validate persisted repeat records. Records of items no longer in the graph
 * are valid here; the state loader drops them.
 */
export function assertRepeats(value: unknown, label: string): void {
  if (value === undefined) return;
  for (const [key, raw] of Object.entries(plainRecord(value, label))) {
    if (!parseRepeatKey(key))
      throw new Error(`${label} key ${key} names no step`);
    const record = plainRecord(raw, `${label}.${key}`);
    const keys = Object.keys(record);
    if (
      !keys.length ||
      keys.some(
        (name) =>
          ![
            "nextAt",
            "scheduledAt",
            "faults",
            "paid",
            "inFlight",
            "asked",
            "invalid",
          ].includes(name),
      ) ||
      (record.nextAt === undefined) !== (record.scheduledAt === undefined) ||
      (record.nextAt !== undefined &&
        (!iso(record.nextAt) || !iso(record.scheduledAt))) ||
      (record.asked !== undefined && !text(record.asked)) ||
      (record.invalid !== undefined && !text(record.invalid)) ||
      (record.faults !== undefined && !validFaultRun(record.faults)) ||
      (record.paid !== undefined && !atLeast(record.paid, 1)) ||
      (record.inFlight !== undefined && record.inFlight !== true)
    )
      throw new Error(`${label}.${key} is invalid`);
  }
}

export function assertWait(value: unknown, label: string): void {
  if (value === undefined) return;
  const wait = plainRecord(value, label);
  if (
    Object.keys(wait).some(
      (name) => !["kind", "detail", "fix", "step"].includes(name),
    ) ||
    !WAIT_KINDS.has(String(wait.kind)) ||
    !text(wait.detail) ||
    (wait.fix !== undefined &&
      (wait.kind !== "prerequisite" || !text(wait.fix))) ||
    (wait.step !== undefined &&
      (typeof wait.step !== "string" || !parseRepeatKey(wait.step)))
  )
    throw new Error(`${label} is invalid`);
}
