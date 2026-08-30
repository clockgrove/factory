/**
 * Platform refusal vs. work failure (PROBE-001, Finding 4).
 *
 * The distinction this module draws is small and load-bearing. When GitHub
 * refuses a request, that is a property of the *substrate*, not of the Work
 * Item. Misreading it as work failure is how a loop starts thrashing: retry,
 * escalate, replan — all against a platform that is merely asking us to wait.
 *
 * Measured, and the reason this is not defensive over-engineering:
 *   - `403 API rate limit exceeded` while `/rate_limit` reported 5000/5000
 *   - `403` on the Copilot session endpoint under sustained dispatch
 *   - `HTTP 500` inside the agent engine on 2 of 26 burst dispatches
 *   - client-side `429` from naive polling
 */

export type Refusal =
  | { kind: "rate_limit"; retryAfterMs: number }
  | { kind: "server_error"; retryAfterMs: number }
  | { kind: "not_refusal" };

interface HttpErrorLike {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined> };
}

const DEFAULT_BACKOFF_MS = 60_000;

function headerNumber(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): number | null {
  const raw = headers?.[name];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify an error thrown by the GitHub client.
 *
 * A `403` is ambiguous on GitHub: it covers both "you may not do this" and
 * "you are going too fast". Only the latter is a refusal, and the two are
 * distinguished by the message, because the headers are unreliable — during
 * the measured plane-3 event the quota headers reported a full budget.
 */
export function classifyRefusal(error: unknown): Refusal {
  const e = error as HttpErrorLike;
  const status = e?.status;
  if (typeof status !== "number") return { kind: "not_refusal" };

  const headers = e.response?.headers;
  const message = (e.message ?? "").toLowerCase();

  if (status >= 500 && status < 600) {
    return { kind: "server_error", retryAfterMs: DEFAULT_BACKOFF_MS };
  }

  const looksLikeRateLimit =
    message.includes("rate limit") ||
    message.includes("secondary rate limit") ||
    message.includes("abuse detection");

  if (status === 429 || (status === 403 && looksLikeRateLimit)) {
    const retryAfter = headerNumber(headers, "retry-after");
    if (retryAfter !== null) {
      return { kind: "rate_limit", retryAfterMs: retryAfter * 1000 };
    }

    // `x-ratelimit-reset` is only meaningful when the quota is actually spent.
    // Plane 3 reports a full budget while refusing, so a reset time in that
    // case describes a window we are not in — fall back to fixed backoff.
    const remaining = headerNumber(headers, "x-ratelimit-remaining");
    const reset = headerNumber(headers, "x-ratelimit-reset");
    if (remaining === 0 && reset !== null) {
      const ms = reset * 1000 - Date.now();
      if (ms > 0) return { kind: "rate_limit", retryAfterMs: ms };
    }

    return { kind: "rate_limit", retryAfterMs: DEFAULT_BACKOFF_MS };
  }

  // A 403 without rate-limit wording is a genuine permission problem, and
  // retrying it forever would hide a real misconfiguration.
  return { kind: "not_refusal" };
}

/**
 * True when an error means "the platform is unavailable right now".
 *
 * Callers must not let this consume an attempt, mark a Work Item failed, or
 * reach the replanner. Attempts are derived from linked PRs (§4.4), and a
 * refused dispatch creates no PR — so honouring this keeps the count honest.
 */
export function isPlatformUnavailable(error: unknown): boolean {
  return classifyRefusal(error).kind !== "not_refusal";
}

export class PlatformUnavailableError extends Error {
  readonly retryAfterMs: number;
  override readonly cause: unknown;

  constructor(refusal: Exclude<Refusal, { kind: "not_refusal" }>, cause: unknown) {
    super(`platform unavailable (${refusal.kind}); retry in ${refusal.retryAfterMs}ms`);
    this.name = "PlatformUnavailableError";
    this.retryAfterMs = refusal.retryAfterMs;
    this.cause = cause;
  }
}
