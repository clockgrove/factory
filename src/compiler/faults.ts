import {
  CompletedModelInvocationError,
  AuthenticationRequiredError,
} from "../contracts.js";
import {
  attachFault,
  transient,
  type Fault,
  decision,
  networkFailure,
} from "../fault.js";
import * as time from "../clock.js";
import { CODEX_PLANNING_PROVIDER } from "./transport.js";
import { authenticationFailure } from "../execution/harness-support.js";
import {
  ProviderTurnTimeoutError,
  ProviderTurnIncompleteError,
} from "../provider-turn.js";

export class MalformedPlannerOutput extends CompletedModelInvocationError {}

/** A timed-out attempt; only proven native cessation permits another dispatch. */
export class ProviderResponseTimeoutFailure extends CompletedModelInvocationError {
  constructor(
    readonly timeout: ProviderTurnTimeoutError,
    readonly stopped: boolean,
  ) {
    super(timeout);
    this.name = "ProviderResponseTimeoutFailure";
  }
}

export class ProviderCapacityFailure extends CompletedModelInvocationError {
  constructor(cause: unknown) {
    super(cause);
    this.name = "ProviderCapacityFailure";
  }
}

/**
 * Output the decoder refused. It counts against the paid bound like a lost
 * answer, so the step re-asks with this detail a bounded number of times
 * and then asks the operator.
 */
export function invalidOutput(cause: unknown): MalformedPlannerOutput {
  const error = new MalformedPlannerOutput(cause);
  return attachFault(
    error,
    transient(`Model output was invalid: ${error.message}`, true),
  );
}

/**
 * When a usage limit resets, read from the message only when the provider
 * gave no structured reset time.
 */
function usageReset(detail: string, now: number): string | undefined {
  // Claude: "Claude AI usage limit reached|<epoch seconds>".
  const epoch = /usage limit reached\|(\d{10})\b/i.exec(detail);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  // Codex: "... try again in 2 days 3 hours" (also minutes/seconds).
  const relative =
    /try again in ((?:\s*(?:and\s+)?\d+\s+(?:days?|hours?|minutes?|seconds?),?)+)/i.exec(
      detail,
    );
  if (!relative) return undefined;
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;
  let total = 0;
  for (const [, count, name] of relative[1]!.matchAll(
    /(\d+)\s+(day|hour|minute|second)/gi,
  ))
    total += Number(count) * unit[name!.toLowerCase()[0] as keyof typeof unit];
  return total ? new Date(now + total).toISOString() : undefined;
}

/** Filesystem and process syscalls: their failures are local. */
const LOCAL_SYSCALL =
  /^(spawn\b.*|open|close|read|write|mkdir|mkdtemp|rmdir|rm|unlink|rename|stat|lstat|fstat|scandir|readdir|access|chmod|copyfile|symlink|readlink|realpath|utime|ftruncate|fsync)$/;

const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** The request failed before a connection opened (DNS, refused, unreachable). */
function connectPhase(error: unknown, detail: string): boolean {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 6;
    current = current.cause, depth++
  )
    if (CONNECT_CODES.has(String((current as NodeJS.ErrnoException).code)))
      return true;
  return /can't reach the API|Could not resolve host|Connection refused|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(
    detail,
  );
}

const BILLING_FIX =
  "Restore the provider plan, credits or billing for the configured login, then `factory run`";

/**
 * Classify a failed structured model call, the paid effect behind planning,
 * review and diagnosis. Faults with `outcomeUnknown` count against the paid
 * bound; limits that name a reset wait without counting.
 */
export function modelFault(
  error: unknown,
  call: {
    provider: string;
    ended: boolean;
    /** A model turn began; network failures after this may have been paid. */
    started?: boolean;
    failureClass: string;
    /** The transport's classification from structured provider facts. */
    fault?: Fault;
  },
  now = time.now(),
): Fault {
  if (call.fault) return call.fault;
  const detail = error instanceof Error ? error.message : String(error);
  const codex = call.provider === CODEX_PLANNING_PROVIDER;
  // A usage limit that names when it resets is a wait, even when the
  // message also suggests a plan upgrade.
  if (
    /usage limit|hit your limit/i.test(detail) &&
    /try again (in|at)\b|\bresets?\b/i.test(detail)
  )
    return transient(
      `Model provider usage limit: ${detail}`,
      false,
      usageReset(detail, now),
    );
  // Billing next: OpenAI reports exhausted quota as HTTP 429.
  if (
    /insufficient_quota|exceeded your current quota|quota exceeded|billing|credit balance|credits_required|spend limit|shared budget|usage not included|upgrade to plus/i.test(
      detail,
    )
  )
    return { kind: "config", detail, fix: BILLING_FIX };
  if (error instanceof AuthenticationRequiredError)
    return {
      kind: "config",
      detail,
      fix: `Run \`${error.authentication.command}\` on the controller host, then \`factory run\``,
    };
  if (/usage limit|hit your limit/i.test(detail))
    return transient(
      `Model provider usage limit: ${detail}`,
      false,
      usageReset(detail, now),
    );
  switch (call.failureClass) {
    case "structured-output-parse":
    case "provider-structured-output":
      return transient(`Model output was invalid: ${detail}`, true);
    case "provider-refusal":
      return decision(
        "The model refused the request. Revise the Objective, retry or cancel.",
        detail,
      );
    case "provider-capacity":
      return transient(`Model provider is over capacity: ${detail}`, false);
    case "provider-rate-limit":
      return transient(
        `Model provider rate limit: ${detail}`,
        false,
        usageReset(detail, now),
      );
    case "provider-authentication":
      return {
        kind: "config",
        detail,
        fix: `Run \`${codex ? "codex login" : "claude auth login"}\` on the controller host, then \`factory run\``,
      };
  }
  if (/selected model .*, expected /i.test(detail))
    return {
      kind: "config",
      detail,
      fix: "Choose a model the provider login can use in the Factory configuration",
    };
  // Fail-closed session checks are invariants, not provider weather.
  if (
    /unconfigured (tool|MCP server)|did not report its initialized session/i.test(
      detail,
    )
  )
    return { kind: "defect", detail };
  const authentication = authenticationFailure(
    codex ? "codex" : "claude",
    detail,
  );
  if (authentication)
    return {
      kind: "config",
      detail,
      fix: `Run \`${authentication.authentication.command}\` on the controller host, then \`factory run\``,
    };
  // A connection that never opened before the turn started sent nothing,
  // so nothing was paid. Any other network failure may have been.
  const connect = connectPhase(error, detail);
  if (connect && !call.started)
    return transient(`Model provider unreachable: ${detail}`, false);
  if (connect || networkFailure(error))
    return transient(`Model connection failed mid-call: ${detail}`, true);
  if (
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" &&
    /^spawn /.test(String((error as NodeJS.ErrnoException).syscall))
  )
    return {
      kind: "config",
      detail,
      fix: "Install the provider CLI on the controller host, then `factory run`",
    };
  // A programming error or a local filesystem failure in Factory is not
  // provider weather.
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    LOCAL_SYSCALL.test(
      String((error as NodeJS.ErrnoException | undefined)?.syscall ?? ""),
    )
  )
    return { kind: "defect", detail };
  // The provider rejected the request itself, such as a model the login
  // cannot use: nothing ran, and repeating it cannot succeed.
  const rejected = rejectedRequest(detail);
  if (rejected)
    return {
      kind: "config",
      detail: rejected,
      fix: "Choose a model and options the provider login supports in the Factory configuration, then `factory run`",
    };
  // A lost session, a dropped stream, a turn that never completed or a
  // provider failure after it ran: the paid call may have happened.
  return transient(`Model call did not complete: ${detail}`, true);
}

/** The provider's message when its structured error is a rejected request. */
function rejectedRequest(detail: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(detail);
  } catch {
    return undefined;
  }
  const { status, error } = (body ?? {}) as {
    status?: unknown;
    error?: { message?: unknown };
  };
  if (
    typeof status !== "number" ||
    status < 400 ||
    status >= 500 ||
    [408, 409, 429].includes(status)
  )
    return undefined;
  return typeof error?.message === "string" ? error.message : detail;
}

export function providerFailureClass(error: unknown): string {
  if (error instanceof ProviderCapacityFailure) return "provider-capacity";
  if (error instanceof ProviderTurnTimeoutError) return "provider-timeout";
  if (error instanceof ProviderTurnIncompleteError)
    return "provider-interrupted";
  const detail = error instanceof Error ? error.message : String(error);
  if (/rate.?limit|\b429\b/i.test(detail)) return "provider-rate-limit";
  if (/capacity|overloaded|temporarily unavailable/i.test(detail))
    return "provider-capacity";
  return "provider";
}

/** The model returned a plan that Factory's deterministic checks refused. */
export class PlanValidationError extends CompletedModelInvocationError {
  override readonly name = "PlanValidationError";
}
