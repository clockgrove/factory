/**
 * Platform refusal vs. work failure.
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

/**
 * Documented GitHub secondary rate limit thresholds
 * (docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
 * "There is not a way to check the status of your secondary rate limit" (same
 * page): the only signal a limit is close is a refusal, by which point the
 * request has already counted against it. Factory paces itself well under these
 * (`FACTORY_PACING`), not up to them.
 */
export const GITHUB_SECONDARY_LIMITS = {
  /** Shared across REST + GraphQL. */
  maxConcurrentRequests: 100,
  maxRestPointsPerMinute: 900,
  maxGraphQlPointsPerMinute: 2000,
  /** Issues, comments, PRs, assignments, and their REST/GraphQL/web equivalents. */
  maxContentCreatingPerMinute: 80,
  maxContentCreatingPerHour: 500,
} as const;

/**
 * Factory's own budget. Deliberately well inside `GITHUB_SECONDARY_LIMITS`,
 * because GitHub's own guidance is stronger than "stay under the ceiling":
 * "Avoid concurrent requests... make requests serially" and "wait at least
 * one second between" mutative requests (docs.github.com/en/rest/using-the-
 * rest-api/best-practices-for-using-the-rest-api).
 */
export const FACTORY_PACING = {
  maxConcurrentRequests: 5,
  maxContentCreatingPerMinute: 40,
  maxContentCreatingPerHour: 250,
  minMsBetweenMutations: 1_000,
} as const;

export type Refusal =
  | { kind: "rate_limit"; retryAfterMs: number }
  | { kind: "server_error"; retryAfterMs: number }
  | { kind: "not_refusal" };

interface HttpErrorLike {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
    data?: { errors?: Array<{ type?: string }> };
  };
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
  const graphQlRateLimited = e.response?.data?.errors?.some(
    (entry) => entry.type === "RATE_LIMITED",
  ) ?? false;

  if (status >= 500 && status < 600) {
    return { kind: "server_error", retryAfterMs: DEFAULT_BACKOFF_MS };
  }

  const looksLikeRateLimit =
    message.includes("rate limit") ||
    message.includes("secondary rate limit") ||
    message.includes("abuse detection");

  if (graphQlRateLimited || status === 429 || (status === 403 && looksLikeRateLimit)) {
    const retryAfter = headerNumber(headers, "retry-after");
    if (retryAfter !== null) {
      return { kind: "rate_limit", retryAfterMs: retryAfter * 1000 };
    }

    // `x-ratelimit-reset` is only meaningful when the quota is actually spent.
    // Plane 3 reports a full budget while refusing, so a reset time in that
    // case describes a window we are not in — fall back to fixed backoff.
    const remaining = headerNumber(headers, "x-ratelimit-remaining");
    const reset = headerNumber(headers, "x-ratelimit-reset");
    if ((remaining === 0 || graphQlRateLimited) && reset !== null) {
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

export interface CircuitBreakerOptions {
  /** Consecutive refusals, across any call, before the circuit opens. */
  openAfterConsecutiveRefusals?: number;
  /** Cooldown the first time the circuit opens. */
  baseCooldownMs?: number;
  /** Ceiling the cooldown grows to on repeated trips. */
  maxCooldownMs?: number;
  /** Times the circuit may open before it is treated as exhausted (§7.3). */
  maxOpens?: number;
}

const DEFAULT_CIRCUIT_OPTS: Required<CircuitBreakerOptions> = {
  openAfterConsecutiveRefusals: 3,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 10 * 60_000,
  maxOpens: 5,
};

/**
 * Wave-level circuit breaker.
 *
 * This is deliberately *not* scoped to one Work Item. GitHub's own guidance
 * is explicit: "Continuing to make requests while you are rate limited may
 * result in the banning of your integration" (docs.github.com/en/rest/using-
 * the-rest-api/rate-limits-for-the-rest-api) — so a refusal must pause every
 * call the loop is about to make, not just retry the one that hit it.
 *
 * It sits above the per-Work-Item confirm/retry logic (§4.2) and must never
 * itself consume an attempt or mark an item failed (Finding 4) — it only
 * controls *when* the loop may make any GitHub call at all.
 */
export class CircuitBreaker {
  readonly #opts: Required<CircuitBreakerOptions>;
  #consecutiveRefusals = 0;
  #opens = 0;
  #openUntil: number | null = null;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.#opts = { ...DEFAULT_CIRCUIT_OPTS, ...opts };
  }

  /** True while the circuit is open: no GitHub call should be issued. */
  isOpen(now: Date = new Date()): boolean {
    return this.#openUntil !== null && now.getTime() < this.#openUntil;
  }

  /** Ms remaining until the circuit closes. Zero once it has closed. */
  waitMs(now: Date = new Date()): number {
    if (this.#openUntil === null) return 0;
    return Math.max(0, this.#openUntil - now.getTime());
  }

  /** True once the circuit has tripped `maxOpens` times — a human question, not a retry (§7.3). */
  exhausted(): boolean {
    return this.#opens >= this.#opts.maxOpens;
  }

  /** The only trustworthy evidence plane 3 has cleared is a successful request. */
  recordSuccess(): void {
    this.#consecutiveRefusals = 0;
  }

  /** Trips the circuit once enough consecutive refusals accumulate. */
  recordRefusal(
    refusal: Exclude<Refusal, { kind: "not_refusal" }>,
    now: Date = new Date(),
  ): void {
    this.#consecutiveRefusals += 1;
    if (this.#consecutiveRefusals < this.#opts.openAfterConsecutiveRefusals) {
      return;
    }

    this.#opens += 1;
    this.#consecutiveRefusals = 0;
    // Exponentially increasing cooldown per the same GitHub guidance, capped
    // so a stuck breaker does not stall the loop indefinitely on its own.
    const cooldown = Math.min(
      this.#opts.baseCooldownMs * this.#opens,
      this.#opts.maxCooldownMs,
    );
    this.#openUntil = now.getTime() + Math.max(cooldown, refusal.retryAfterMs);
  }
}

/**
 * Paces content-creating calls (issues, comments, PRs, assignments) well
 * under GitHub's documented 80/min, 500/hour secondary limits, and enforces
 * the "wait at least one second between mutative requests" best practice.
 */
export class ContentCreationPacer {
  #minute: number[] = [];
  #hour: number[] = [];
  #lastCallAt: number | null = null;

  constructor(
    private readonly perMinute: number = FACTORY_PACING.maxContentCreatingPerMinute,
    private readonly perHour: number = FACTORY_PACING.maxContentCreatingPerHour,
    private readonly minGapMs: number = FACTORY_PACING.minMsBetweenMutations,
  ) {}

  /** Ms to wait before the next content-creating call is safe to make. */
  waitMs(now: Date = new Date()): number {
    const t = now.getTime();
    this.#prune(t);
    const gapWait =
      this.#lastCallAt === null
        ? 0
        : Math.max(0, this.#lastCallAt + this.minGapMs - t);
    const minuteWait =
      this.#minute.length < this.perMinute
        ? 0
        : this.#minute[0]! + 60_000 - t;
    const hourWait =
      this.#hour.length < this.perHour ? 0 : this.#hour[0]! + 3_600_000 - t;
    return Math.max(gapWait, minuteWait, hourWait, 0);
  }

  /** Record that a content-creating call was just made. */
  recordCall(now: Date = new Date()): void {
    const t = now.getTime();
    this.#prune(t);
    this.#minute.push(t);
    this.#hour.push(t);
    this.#lastCallAt = t;
  }

  #prune(now: number): void {
    while (this.#minute.length > 0 && this.#minute[0]! <= now - 60_000) {
      this.#minute.shift();
    }
    while (this.#hour.length > 0 && this.#hour[0]! <= now - 3_600_000) {
      this.#hour.shift();
    }
  }
}

/**
 * Caps concurrent in-flight GitHub calls well under the documented 100
 * (shared REST + GraphQL) secondary limit. GitHub's stronger guidance —
 * "avoid concurrent requests... make requests serially" — is why the
 * default (`FACTORY_PACING.maxConcurrentRequests`) is a handful, not 99.
 */
export class ConcurrencyLimiter {
  #inFlight = 0;
  #queue: Array<() => void> = [];

  constructor(
    private readonly limit: number = FACTORY_PACING.maxConcurrentRequests,
  ) {}

  /** Resolves once a slot is free; call the returned function to release it. */
  async acquire(): Promise<() => void> {
    if (this.#inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
      this.#queue.shift()?.();
    };
  }
}
