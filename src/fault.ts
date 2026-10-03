/**
 * One fault model for every adapter (recovery v2.2, #515). Only adapters
 * classify: the GitHub gateway, the git wrapper, each model adapter, and each
 * execution driver and sandbox provider. They attach a `Fault` to the error
 * they already throw; runners read it with `faultOf`, and anything nobody
 * classified is a `defect`.
 */

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
  | { kind: "defect"; detail: string };

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
 * wraps (such as an Interruption around a provider failure). Anything no
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
  return function <This, Args extends unknown[], Return>(
    method: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >,
  ): (this: This, ...args: Args) => Return {
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
  now = Date.now(),
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

/**
 * A step's persisted repeat record, keyed `${item}/${attempt}/${step}` or
 * `objective/${step}`. Written only by the step primitive (#515).
 */
export interface RepeatRecord {
  /** When the step began failing; any progress inside the step resets it. */
  since: string;
  /** Faults since `since`. */
  count: number;
  last: Fault;
  /** Earliest time the step runs again. */
  nextAt: string;
}

export type WaitKind =
  | "ci"
  | "capacity"
  | "dependency"
  | "outage"
  | "decision"
  | "prerequisite";

/** Why an item or Objective is not progressing right now. */
export interface Wait {
  kind: WaitKind;
  detail: string;
}

const WAIT_KINDS = new Set<string>([
  "ci",
  "capacity",
  "dependency",
  "outage",
  "decision",
  "prerequisite",
]);
const STEP_NAME = /^[a-z][a-z-]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

/**
 * Validate persisted repeat records. `items` lists the Work Items whose
 * steps may repeat; without it only Objective steps may.
 */
export function assertRepeats(
  value: unknown,
  label: string,
  items: ReadonlySet<string> = new Set(),
): void {
  if (value === undefined) return;
  for (const [key, raw] of Object.entries(plainRecord(value, label))) {
    const parts = key.split("/");
    if (
      !(
        (parts.length === 2 &&
          parts[0] === "objective" &&
          STEP_NAME.test(parts[1]!)) ||
        (parts.length === 3 &&
          items.has(parts[0]!) &&
          IDENTITY.test(parts[1]!) &&
          STEP_NAME.test(parts[2]!))
      )
    )
      throw new Error(`${label} key ${key} names no known step`);
    const record = plainRecord(raw, `${label}.${key}`);
    if (
      Object.keys(record).sort().join(",") !== "count,last,nextAt,since" ||
      !iso(record.since) ||
      !iso(record.nextAt) ||
      !Number.isSafeInteger(record.count) ||
      Number(record.count) < 1 ||
      !isFault(record.last)
    )
      throw new Error(`${label}.${key} is invalid`);
  }
}

export function assertWait(value: unknown, label: string): void {
  if (value === undefined) return;
  const wait = plainRecord(value, label);
  if (
    Object.keys(wait).sort().join(",") !== "detail,kind" ||
    !WAIT_KINDS.has(String(wait.kind)) ||
    !text(wait.detail)
  )
    throw new Error(`${label} is invalid`);
}
