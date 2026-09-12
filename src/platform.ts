import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

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
    const next = {
      resource,
      limit,
      remaining,
      used: number("x-ratelimit-used"),
      resetAt: resetAt.toISOString(),
      observedAt: now.toISOString(),
    } satisfies PrimaryRateLimitObservation;
    const previous = this.#resources.get(resource);
    if (previous) {
      const previousReset = new Date(previous.resetAt).getTime();
      const nextReset = resetAt.getTime();
      // Concurrent requests can complete out of order. Within one primary
      // window, retain the most conservative observation instead of letting an
      // older response manufacture capacity that a later response consumed.
      if (nextReset < previousReset) return;
      if (nextReset === previousReset) {
        next.remaining = Math.min(previous.remaining, next.remaining);
        next.used =
          previous.used === null || next.used === null
            ? (previous.used ?? next.used)
            : Math.max(previous.used, next.used);
        next.observedAt =
          new Date(previous.observedAt).getTime() > now.getTime()
            ? previous.observedAt
            : next.observedAt;
      }
    }
    this.#resources.set(resource, next);
  }

  snapshot(): PrimaryRateLimitObservation[] {
    return [...this.#resources.values()]
      .map((value) => ({ ...value }))
      .sort((left, right) => left.resource.localeCompare(right.resource));
  }
}

export type GitHubRequestPriority = "normal" | "protected";

interface GitHubRequestAdmissionContext {
  priority: GitHubRequestPriority;
  expectedCost?: number;
}

const requestPriority = new AsyncLocalStorage<GitHubRequestAdmissionContext>();

/** Bind an internal request class without sending Factory-only metadata to GitHub. */
export function withGitHubRequestPriority<T>(
  priority: GitHubRequestPriority,
  operation: () => Promise<T>,
  expectedCost?: number,
): Promise<T> {
  if (requestPriority.getStore()) return operation();
  return requestPriority.run(
    { priority, ...(expectedCost === undefined ? {} : { expectedCost }) },
    operation,
  );
}

export interface GitHubEndpointRequestTelemetry {
  endpoint:
    | "authenticated-user"
    | "issues"
    | "issue-comments"
    | "repository-comments"
    | "git-ref"
    | "git-commit"
    | "matching-refs"
    | "graphql"
    | "other";
  admitted: number;
  transported: number;
  conditional: number;
  notModified: number;
  successful: number;
}

export interface GitHubRequestTelemetry {
  measurementScope: "process-local-credential";
  measurementWindow: { startedAt: string; observedAt: string };
  endpoints: GitHubEndpointRequestTelemetry[];
  limitingReason: "primary-reserve" | "primary-exhausted" | null;
  nextAdmissionAt: string | null;
}

/** Keep enough primary capacity for every maximum-sized (32 Objective) cohort
 * that can be admitted before one primary window resets. Eight waves times
 * three fenced REST operations per Objective, plus repository ownership and
 * bounded repair headroom, fits below 1,024. The equivalent GraphQL CAS/mutation
 * envelope fits below 512. Normal metadata waits before consuming either. */
export const GITHUB_PRIMARY_PROTECTED_RESERVE = 1_024;
export const GITHUB_GRAPHQL_PROTECTED_RESERVE = 512;

/** GitHub's documented GraphQL cost calculation prices unique connections by
 * their possible parent cardinality, divided by 100. Factory's largest
 * supported query is Objective: 100 Work Items, 20 linked PRs each, and 20
 * check suites per status commit. Its complete connection expansion is below
 * 50,000 requests, hence below 500 points; 512 is the fail-closed bound. */
export const GITHUB_GRAPHQL_OBJECTIVE_QUERY_MAX_COST = 512;
export const GITHUB_GRAPHQL_NORMAL_REQUEST_ESTIMATE = GITHUB_GRAPHQL_OBJECTIVE_QUERY_MAX_COST;

function requestEndpoint(url: URL): GitHubEndpointRequestTelemetry["endpoint"] {
  const path = url.pathname;
  if (path.endsWith("/user")) return "authenticated-user";
  if (path.endsWith("/graphql")) return "graphql";
  if (/\/issues\/comments$/.test(path)) return "repository-comments";
  if (/\/issues\/\d+\/comments$/.test(path)) return "issue-comments";
  if (/\/issues$/.test(path)) return "issues";
  if (path.includes("/git/matching-refs/")) return "matching-refs";
  if (path.includes("/git/commits/")) return "git-commit";
  if (path.includes("/git/ref/")) return "git-ref";
  return "other";
}

function inferredRequestPriority(
  _method: string,
  _endpoint: GitHubEndpointRequestTelemetry["endpoint"],
): GitHubRequestPriority {
  return "normal";
}

class GitHubRequestGovernor {
  readonly #startedAt = new Date().toISOString();
  readonly #endpoints = new Map<
    GitHubEndpointRequestTelemetry["endpoint"],
    Omit<GitHubEndpointRequestTelemetry, "endpoint">
  >();
  #limitingReason: GitHubRequestTelemetry["limitingReason"] = null;
  #nextAdmissionAt: string | null = null;
  readonly #inFlightCost = new Map<"core" | "graphql", number>();

  admit(
    primaryQuota: GitHubPrimaryQuotaCache,
    endpoint: GitHubEndpointRequestTelemetry["endpoint"],
    method: string,
    conditional: boolean,
    defaultPriority?: GitHubRequestPriority,
    defaultExpectedCost?: number,
    now = new Date(),
  ): () => void {
    const context = requestPriority.getStore();
    const priority =
      context?.priority ?? defaultPriority ?? inferredRequestPriority(method, endpoint);
    const resource = endpoint === "graphql" ? "graphql" : "core";
    const expectedCost = Math.max(
      1,
      context?.expectedCost ??
        defaultExpectedCost ??
        (resource === "graphql" && priority === "normal"
          ? GITHUB_GRAPHQL_NORMAL_REQUEST_ESTIMATE
          : 1),
    );
    const observed = primaryQuota.snapshot().find((entry) => entry.resource === resource);
    if (observed) {
      const resetAt = new Date(observed.resetAt);
      if (resetAt.getTime() > now.getTime()) {
        const effectiveRemaining = observed.remaining - (this.#inFlightCost.get(resource) ?? 0);
        const reserve =
          resource === "graphql"
            ? GITHUB_GRAPHQL_PROTECTED_RESERVE
            : GITHUB_PRIMARY_PROTECTED_RESERVE;
        const exhausted = effectiveRemaining < expectedCost;
        const reserved = priority === "normal" && effectiveRemaining - expectedCost < reserve;
        if (exhausted || reserved) {
          this.#limitingReason = exhausted ? "primary-exhausted" : "primary-reserve";
          this.#nextAdmissionAt = resetAt.toISOString();
          throw new GitHubPrimaryAdmissionDeferredError(
            {
              kind: "rate_limit",
              retryAfterMs: Math.max(1_000, resetAt.getTime() - now.getTime() + 1_000),
            },
            new Error(
              exhausted
                ? "GitHub primary quota is exhausted"
                : "GitHub metadata reads reached Factory's protected primary reserve",
            ),
          );
        }
      }
    }
    if (priority === "normal") {
      this.#limitingReason = null;
      this.#nextAdmissionAt = null;
    }
    const counters = this.#counters(endpoint);
    counters.admitted++;
    if (conditional) counters.conditional++;
    this.#inFlightCost.set(resource, (this.#inFlightCost.get(resource) ?? 0) + expectedCost);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#inFlightCost.get(resource) ?? expectedCost) - expectedCost;
      if (remaining === 0) this.#inFlightCost.delete(resource);
      else this.#inFlightCost.set(resource, remaining);
    };
  }

  transported(endpoint: GitHubEndpointRequestTelemetry["endpoint"]): void {
    this.#counters(endpoint).transported++;
  }

  completed(endpoint: GitHubEndpointRequestTelemetry["endpoint"], status: number): void {
    const counters = this.#counters(endpoint);
    if (status === 304) counters.notModified++;
    if (status >= 200 && status < 400) counters.successful++;
  }

  telemetry(now = new Date()): GitHubRequestTelemetry {
    return {
      measurementScope: "process-local-credential",
      measurementWindow: { startedAt: this.#startedAt, observedAt: now.toISOString() },
      endpoints: [...this.#endpoints.entries()]
        .map(([endpoint, counters]) => ({ endpoint, ...counters }))
        .sort((left, right) => left.endpoint.localeCompare(right.endpoint)),
      limitingReason: this.#limitingReason,
      nextAdmissionAt: this.#nextAdmissionAt,
    };
  }

  #counters(
    endpoint: GitHubEndpointRequestTelemetry["endpoint"],
  ): Omit<GitHubEndpointRequestTelemetry, "endpoint"> {
    let counters = this.#endpoints.get(endpoint);
    if (!counters) {
      counters = { admitted: 0, transported: 0, conditional: 0, notModified: 0, successful: 0 };
      this.#endpoints.set(endpoint, counters);
    }
    return counters;
  }
}

const stateByCredential = new Map<
  string,
  { governor: GitHubRequestGovernor; primaryQuota: GitHubPrimaryQuotaCache }
>();

/** Keep both controls for every admitted credential for the lifetime of this process. */
function stateForCredential(token: string) {
  const credential = createHash("sha256").update(token).digest("hex");
  let state = stateByCredential.get(credential);
  if (!state) {
    if (stateByCredential.size >= 16) {
      throw new Error(
        "Factory supports at most 16 distinct GitHub credentials per process; reuse an existing credential or restart the process before using a new credential",
      );
    }
    state = { governor: new GitHubRequestGovernor(), primaryQuota: new GitHubPrimaryQuotaCache() };
    stateByCredential.set(credential, state);
  }
  return state;
}

function requestGovernorForCredential(token: string): GitHubRequestGovernor {
  return stateForCredential(token).governor;
}

export function githubRequestTelemetryForCredential(token: string): GitHubRequestTelemetry {
  return requestGovernorForCredential(token).telemetry();
}

/** Admission and transport accounting shared by every Octokit built from one credential. */
export function admitGitHubRequest(
  token: string,
  primaryQuota: GitHubPrimaryQuotaCache,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  defaultPriority?: GitHubRequestPriority,
  defaultExpectedCost?: number,
): () => void {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = String(
    init?.method ?? (input instanceof Request ? input.method : "GET"),
  ).toUpperCase();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const endpoint = requestEndpoint(url);
  const governor = requestGovernorForCredential(token);
  return governor.admit(
    primaryQuota,
    endpoint,
    method,
    headers.has("if-none-match") || headers.has("if-modified-since"),
    defaultPriority,
    defaultExpectedCost,
  );
}

export function observeGitHubRequestTransport(
  token: string,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  transport: typeof globalThis.fetch,
): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const endpoint = requestEndpoint(url);
  const governor = requestGovernorForCredential(token);
  governor.transported(endpoint);
  return transport(input, init).then((response) => {
    governor.completed(endpoint, response.status);
    return response;
  });
}

/** Process-local credential sharing; the token never appears in telemetry. */
export function primaryQuotaForCredential(token: string): GitHubPrimaryQuotaCache {
  return stateForCredential(token).primaryQuota;
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

/** Local primary-reserve admission refusal. No HTTP transport occurred, so it
 * must not trip the remote-refusal circuit breaker. */
export class GitHubPrimaryAdmissionDeferredError extends PlatformUnavailableError {
  constructor(refusal: Extract<Refusal, { kind: "rate_limit" }>, cause: unknown) {
    super(refusal, cause);
    this.name = "GitHubPrimaryAdmissionDeferredError";
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

export type MutationClass = "normal" | "lease" | "cleanup";

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
  requestTelemetry?: () => GitHubRequestTelemetry;
}

export interface GitHubMutationTelemetry {
  /** Counters belong to this scheduler instance, not to any durable Factory run. */
  measurementScope: "process-local";
  measurementWindow: {
    startedAt: string;
    observedAt: string;
  };
  admitted: number;
  transported: number;
  successful: number;
  serverPrimaryQuota: PrimaryRateLimitObservation[];
  localSecondaryEstimate: LocalSecondaryQuotaEstimate;
  requestTelemetry?: GitHubRequestTelemetry;
}

/**
 * Serializes quota admission, not remote mutation completion. Once transport
 * starts, an unrelated admitted operation may proceed within the shared request
 * limiter. Lease traffic can pass callers waiting on content pacing. Actual
 * transports, including failed attempts, are still priced exactly once.
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
  #requestTelemetry: (() => GitHubRequestTelemetry) | undefined;
  readonly #startedAt: string;
  #admitted = 0;
  #transported = 0;
  #successful = 0;

  constructor(options: MutationSchedulerOptions = {}) {
    this.#pacer = options.pacer ?? new ContentCreationPacer();
    this.#notify = options.onThrottle ?? (() => {});
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? mutationDelay;
    this.#primaryQuota = options.primaryQuota;
    this.#requestTelemetry = options.requestTelemetry;
    this.#startedAt = this.#now().toISOString();
  }

  attachPrimaryQuota(cache: GitHubPrimaryQuotaCache): void {
    this.#primaryQuota = cache;
  }

  attachRequestTelemetry(telemetry: () => GitHubRequestTelemetry): void {
    this.#requestTelemetry = telemetry;
  }

  telemetry(): GitHubMutationTelemetry {
    const observedAt = this.#now();
    return {
      measurementScope: "process-local",
      measurementWindow: {
        startedAt: this.#startedAt,
        observedAt: observedAt.toISOString(),
      },
      admitted: this.#admitted,
      transported: this.#transported,
      successful: this.#successful,
      serverPrimaryQuota: this.#primaryQuota?.snapshot() ?? [],
      localSecondaryEstimate: this.#pacer.snapshot(observedAt),
      ...(this.#requestTelemetry ? { requestTelemetry: this.#requestTelemetry() } : {}),
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
        wait = this.#pacer.waitMs(now, { priority: kind !== "normal" });
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
            // The rate-limit gate is not a repository data lock. Resource-specific
            // CAS/Objective fences protect correctness after dispatch.
            release();
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
          kind !== "normal"
            ? `pacing a ${kind} mutation for ${wait}ms`
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
      const queue = kind === "normal" ? this.#normalQueue : this.#leaseQueue;
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
