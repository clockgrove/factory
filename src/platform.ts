import { createHash } from "node:crypto";

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
 * request has already counted against it. Factory uses these published ceilings
 * as the outer boundary of a locally observed, adaptive guardrail.
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
 * Factory's local pacing policy. The content limits are GitHub's documented
 * outer bounds rather than a second, arbitrary hourly quota. Admission is
 * smoothed and adapts downward after an observed secondary refusal.
 * "Avoid concurrent requests... make requests serially" and "wait at least
 * one second between" mutative requests (docs.github.com/en/rest/using-the-
 * rest-api/best-practices-for-using-the-rest-api).
 */
export const FACTORY_PACING = {
  maxConcurrentRequests: 5,
  maxContentCreatingPerMinute: GITHUB_SECONDARY_LIMITS.maxContentCreatingPerMinute,
  maxContentCreatingPerHour: GITHUB_SECONDARY_LIMITS.maxContentCreatingPerHour,
  minMsBetweenMutations: 1_000,
} as const;

export interface PrimaryRateLimitObservation {
  resource: string;
  limit: number;
  remaining: number;
  used: number | null;
  resetAt: string;
  observedAt: string;
}

/** Header cache for GitHub's observable primary quota. */
export class GitHubPrimaryQuotaCache {
  readonly #resources = new Map<string, PrimaryRateLimitObservation>();

  observe(
    headers: Record<string, string | number | undefined> | undefined,
    now: Date = new Date(),
  ): void {
    if (!headers) return;
    const normalized = new Map(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const number = (name: string): number | null => {
      const value = normalized.get(name);
      if (value === undefined) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const resource = String(normalized.get("x-ratelimit-resource") ?? "core").toLowerCase();
    const limit = number("x-ratelimit-limit");
    const remaining = number("x-ratelimit-remaining");
    const reset = number("x-ratelimit-reset");
    if (limit === null || remaining === null || reset === null) return;
    const resetAt = new Date(reset * 1_000);
    if (Number.isNaN(resetAt.getTime())) return;
    this.#resources.set(resource, {
      resource,
      limit,
      remaining,
      used: number("x-ratelimit-used"),
      resetAt: resetAt.toISOString(),
      observedAt: now.toISOString(),
    });
  }

  snapshot(): PrimaryRateLimitObservation[] {
    return [...this.#resources.values()]
      .map((value) => ({ ...value }))
      .sort((left, right) => left.resource.localeCompare(right.resource));
  }
}

const primaryQuotaByCredential = new Map<string, GitHubPrimaryQuotaCache>();

/** Process-local credential sharing; the token never appears in telemetry. */
export function primaryQuotaForCredential(token: string): GitHubPrimaryQuotaCache {
  const credential = createHash("sha256").update(token).digest("hex");
  let cache = primaryQuotaByCredential.get(credential);
  if (!cache) {
    cache = new GitHubPrimaryQuotaCache();
    if (primaryQuotaByCredential.size >= 16) {
      primaryQuotaByCredential.delete(primaryQuotaByCredential.keys().next().value!);
    }
    primaryQuotaByCredential.set(credential, cache);
  }
  return cache;
}

export type Refusal =
  | { kind: "rate_limit"; retryAfterMs: number }
  | { kind: "server_error"; retryAfterMs: number }
  | { kind: "not_refusal" };

interface HttpErrorLike {
  status?: number;
  message?: string;
  headers?: Record<string, string | number | undefined>;
  errors?: Array<GraphQlErrorLike>;
  response?: {
    headers?: Record<string, string | number | undefined>;
    data?: { errors?: Array<GraphQlErrorLike> };
    errors?: Array<GraphQlErrorLike>;
  };
}

interface GraphQlErrorLike {
  type?: string;
  code?: string;
  message?: string;
}

const DEFAULT_BACKOFF_MS = 60_000;

function headerNumber(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): number | null {
  const raw = headers?.[name];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function refusalHeaders(error: unknown): Record<string, string | number | undefined> | undefined {
  const value =
    error instanceof PlatformUnavailableError
      ? (error.cause as HttpErrorLike)
      : (error as HttpErrorLike);
  return value?.response?.headers ?? value?.headers;
}

/** Primary exhaustion reports zero remaining; other 403/429 rate refusals are
 * the only feedback GitHub provides for the invisible secondary plane. */
export function isSecondaryRateLimitRefusal(error: unknown): boolean {
  const refusal = classifyRefusal(error);
  if (refusal.kind !== "rate_limit") return false;
  return headerNumber(refusalHeaders(error), "x-ratelimit-remaining") !== 0;
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
  if (error instanceof PlatformUnavailableError) return error.refusal;
  const e = error as HttpErrorLike;
  const status = e?.status;
  // `RequestError` keeps these under `response`; `GraphqlResponseError`
  // exposes both headers and errors at the top level and leaves `status`
  // undefined. GitHub has emitted both RATE_LIMITED and RATE_LIMIT with the
  // `graphql_rate_limit` code, so classification must use all documented
  // client shapes rather than one enum spelling.
  const headers = e?.response?.headers ?? e?.headers;
  const message = (e?.message ?? "").toLowerCase();
  const graphQlErrors = [
    ...(e?.errors ?? []),
    ...(e?.response?.errors ?? []),
    ...(e?.response?.data?.errors ?? []),
  ];
  const graphQlRateLimited = graphQlErrors.some((entry) => {
    const type = entry.type?.toUpperCase();
    const code = entry.code?.toLowerCase();
    const detail = entry.message?.toLowerCase() ?? "";
    return (
      type === "RATE_LIMITED" ||
      type === "RATE_LIMIT" ||
      code === "graphql_rate_limit" ||
      detail.includes("rate limit")
    );
  });
  if (typeof status !== "number" && !graphQlRateLimited) {
    return { kind: "not_refusal" };
  }

  if (typeof status === "number" && status >= 500 && status < 600) {
    return { kind: "server_error", retryAfterMs: DEFAULT_BACKOFF_MS };
  }

  const looksLikeRateLimit =
    message.includes("rate limit") ||
    message.includes("secondary rate limit") ||
    message.includes("abuse detection");

  if (graphQlRateLimited || status === 429 || (status === 403 && looksLikeRateLimit)) {
    const retryAfter = headerNumber(headers, "retry-after");
    if (retryAfter !== null && retryAfter >= 0) {
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
  readonly refusal: Exclude<Refusal, { kind: "not_refusal" }>;
  readonly retryAfterMs: number;
  override readonly cause: unknown;

  constructor(refusal: Exclude<Refusal, { kind: "not_refusal" }>, cause: unknown) {
    super(`platform unavailable (${refusal.kind}); retry in ${refusal.retryAfterMs}ms`);
    this.name = "PlatformUnavailableError";
    this.refusal = refusal;
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
  recordRefusal(refusal: Exclude<Refusal, { kind: "not_refusal" }>, now: Date = new Date()): void {
    // A single refusal already asks us to stop sending requests. The trip
    // threshold controls escalation, not permission to ignore Retry-After.
    this.#openUntil = Math.max(this.#openUntil ?? 0, now.getTime() + refusal.retryAfterMs);
    this.#consecutiveRefusals += 1;
    if (this.#consecutiveRefusals < this.#opts.openAfterConsecutiveRefusals) {
      return;
    }

    this.#opens += 1;
    this.#consecutiveRefusals = 0;
    // Exponentially increasing cooldown per the same GitHub guidance, capped
    // so a stuck breaker does not stall the loop indefinitely on its own.
    const cooldown = Math.min(this.#opts.baseCooldownMs * this.#opens, this.#opts.maxCooldownMs);
    this.#openUntil = Math.max(this.#openUntil, now.getTime() + cooldown);
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
  #adaptiveFactor = 1;
  #successfulSinceRefusal = 0;
  #secondaryRefusals = 0;

  constructor(
    private readonly perMinute: number = FACTORY_PACING.maxContentCreatingPerMinute,
    private readonly perHour: number = FACTORY_PACING.maxContentCreatingPerHour,
    private readonly minGapMs: number = FACTORY_PACING.minMsBetweenMutations,
  ) {}

  /**
   * Ms to wait before the next content-creating call is safe to make. Calls
   * are distributed across the hour so a burst cannot create an hourly cliff.
   */
  waitMs(now: Date = new Date(), options: { priority?: boolean } = {}): number {
    const t = now.getTime();
    this.#prune(t);
    const effectiveHourly = Math.max(1, Math.floor((this.perHour - 1) / this.#adaptiveFactor));
    const gap = options.priority
      ? this.minGapMs
      : Math.max(this.minGapMs, Math.ceil(3_600_000 / effectiveHourly));
    const gapWait = this.#lastCallAt === null ? 0 : Math.max(0, this.#lastCallAt + gap - t);
    const minuteWait =
      this.#minute.length < this.perMinute
        ? 0
        : this.#minute[this.#minute.length - this.perMinute]! + 60_000 - t;
    const hourWait =
      this.#hour.length < effectiveHourly
        ? 0
        : this.#hour[this.#hour.length - effectiveHourly]! + 3_600_000 - t;
    return Math.max(gapWait, minuteWait, hourWait, 0);
  }

  /** Record an actual transport attempt, immediately before invoking HTTP. */
  recordTransported(now: Date = new Date()): void {
    const t = now.getTime();
    this.#prune(t);
    this.#minute.push(t);
    this.#hour.push(t);
    this.#lastCallAt = t;
  }

  recordCall(now: Date = new Date()): void {
    this.recordTransported(now);
  }

  recordSuccess(): void {
    this.#successfulSinceRefusal += 1;
    if (this.#adaptiveFactor > 1 && this.#successfulSinceRefusal >= 20) {
      this.#adaptiveFactor = Math.max(1, this.#adaptiveFactor - 0.1);
      this.#successfulSinceRefusal = 0;
    }
  }

  recordSecondaryRefusal(): void {
    this.#secondaryRefusals += 1;
    this.#successfulSinceRefusal = 0;
    this.#adaptiveFactor = Math.min(8, this.#adaptiveFactor * 2);
  }

  snapshot(now: Date = new Date()): LocalSecondaryQuotaEstimate {
    const t = now.getTime();
    this.#prune(t);
    const wait = this.waitMs(now);
    return {
      transportedLastMinute: this.#minute.length,
      transportedLastHour: this.#hour.length,
      estimatedHourlyCapacity: Math.max(1, Math.floor((this.perHour - 1) / this.#adaptiveFactor)),
      confidence: this.#secondaryRefusals > 0 ? "high" : this.#hour.length >= 20 ? "medium" : "low",
      secondaryRefusals: this.#secondaryRefusals,
      limitingReason: wait > 0 ? "local-secondary-estimate" : null,
      nextAdmissionAt: new Date(t + wait).toISOString(),
    };
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

export interface LocalSecondaryQuotaEstimate {
  transportedLastMinute: number;
  transportedLastHour: number;
  estimatedHourlyCapacity: number;
  confidence: "low" | "medium" | "high";
  secondaryRefusals: number;
  limitingReason: "local-secondary-estimate" | null;
  nextAdmissionAt: string;
}

export type MutationClass = "normal" | "lease";

/** No transport was invoked for this mutation. Never used to classify a
 * transport that was already in flight or a GitHub refusal. */
export class MutationAdmissionStoppedError extends Error {
  constructor() {
    super("normal mutation admission stopped before dispatch for controller shutdown");
    this.name = "MutationAdmissionStoppedError";
  }
}

export interface MutationPermit {
  waitedMs: number;
  release(): void;
  /** Last synchronous check immediately before invoking transport. */
  assertDispatchAllowed?(): void;
  /** Called adjacent to the sole HTTP attempt; internal retries are disabled. */
  recordTransported?(): void;
  recordSuccess?(): void;
  recordRefusal?(secondary: boolean): void;
}

export interface MutationAdmission {
  acquire(kind?: MutationClass): Promise<MutationPermit>;
}

export interface MutationSchedulerOptions {
  pacer?: ContentCreationPacer;
  onThrottle?: (message: string) => void;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  primaryQuota?: GitHubPrimaryQuotaCache;
}

export interface GitHubMutationTelemetry {
  admitted: number;
  transported: number;
  successful: number;
  serverPrimaryQuota: PrimaryRateLimitObservation[];
  localSecondaryEstimate: LocalSecondaryQuotaEstimate;
}

/**
 * Serializes mutating requests while allowing lease traffic to pass normal
 * callers that are sleeping on the hourly content budget. Admission records
 * the request before transport so failed HTTP attempts are still priced.
 */
export class MutationScheduler implements MutationAdmission {
  readonly #pacer: ContentCreationPacer;
  readonly #notify: (message: string) => void;
  readonly #now: () => Date;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #normalShutdown = new AbortController();
  #active = false;
  #leaseQueue: Array<() => void> = [];
  #normalQueue: Array<() => void> = [];
  #lastNoticeAt = 0;
  #primaryQuota: GitHubPrimaryQuotaCache | undefined;
  #admitted = 0;
  #transported = 0;
  #successful = 0;

  constructor(options: MutationSchedulerOptions = {}) {
    this.#pacer = options.pacer ?? new ContentCreationPacer();
    this.#notify = options.onThrottle ?? (() => {});
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? mutationDelay;
    this.#primaryQuota = options.primaryQuota;
  }

  attachPrimaryQuota(cache: GitHubPrimaryQuotaCache): void {
    this.#primaryQuota = cache;
  }

  telemetry(): GitHubMutationTelemetry {
    return {
      admitted: this.#admitted,
      transported: this.#transported,
      successful: this.#successful,
      serverPrimaryQuota: this.#primaryQuota?.snapshot() ?? [],
      localSecondaryEstimate: this.#pacer.snapshot(this.#now()),
    };
  }

  /** Deliberate process retirement only. Pending normal work is never resumed
   * in this scheduler; lease traffic and in-flight transport remain untouched. */
  stopNormalAdmission(): void {
    if (!this.#normalShutdown.signal.aborted)
      this.#normalShutdown.abort(new MutationAdmissionStoppedError());
  }

  #assertAdmissionOpen(kind: MutationClass): void {
    if (kind === "normal") this.#normalShutdown.signal.throwIfAborted();
  }

  async acquire(kind: MutationClass = "normal"): Promise<MutationPermit> {
    const startedAt = this.#now().getTime();
    let pacedWaitMs = 0;
    for (;;) {
      const release = await this.#acquireGate(kind);
      const now = this.#now();
      let wait: number;
      try {
        this.#assertAdmissionOpen(kind);
        wait = this.#pacer.waitMs(now, { priority: kind === "lease" });
      } catch (error) {
        release();
        throw error;
      }
      if (wait === 0) {
        this.#admitted += 1;
        let transported = false;
        return {
          waitedMs: Math.max(pacedWaitMs, now.getTime() - startedAt),
          release,
          assertDispatchAllowed: () => this.#assertAdmissionOpen(kind),
          recordTransported: () => {
            if (transported) return;
            transported = true;
            this.#transported += 1;
            this.#pacer.recordTransported(this.#now());
          },
          recordSuccess: () => {
            if (!transported) return;
            this.#successful += 1;
            this.#pacer.recordSuccess();
          },
          recordRefusal: (secondary) => {
            if (transported && secondary) this.#pacer.recordSecondaryRefusal();
          },
        };
      }
      release();
      if (wait >= 5_000 && now.getTime() - this.#lastNoticeAt >= 60_000) {
        this.#lastNoticeAt = now.getTime();
        this.#notify(
          kind === "lease"
            ? `pacing a lease mutation for ${wait}ms`
            : `pacing a GitHub mutation for ${wait}ms; lease traffic retains priority`,
        );
      }
      await this.#sleep(wait, kind === "normal" ? this.#normalShutdown.signal : undefined);
      pacedWaitMs += wait;
    }
  }

  async #acquireGate(kind: MutationClass): Promise<() => void> {
    this.#assertAdmissionOpen(kind);
    if (!this.#active) {
      this.#active = true;
      return this.#releaseGate();
    }
    await new Promise<void>((resolve, reject) => {
      const queue = kind === "lease" ? this.#leaseQueue : this.#normalQueue;
      const signal = kind === "normal" ? this.#normalShutdown.signal : undefined;
      const grant = () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        const index = queue.indexOf(grant);
        if (index < 0) return;
        queue.splice(index, 1);
        signal?.removeEventListener("abort", stop);
        reject(signal!.reason);
      };
      queue.push(grant);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    });
    return this.#releaseGate();
  }

  #releaseGate(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#leaseQueue.shift() ?? this.#normalQueue.shift();
      if (next) next();
      else this.#active = false;
    };
  }
}

function mutationDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
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

  constructor(private readonly limit: number = FACTORY_PACING.maxConcurrentRequests) {}

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
