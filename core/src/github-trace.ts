/**
 * GitHub request tracing (docs/reference/run-log.md#Run log): what the
 * requests of one sync job, one step attempt or the rest of the service run
 * cost, and each request worth a line of its own. Counts, routes, statuses,
 * times and request ids only: never a body, a token or a query value.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one scope's GitHub requests cost (`github-call`): requests sent,
 * re-sends (a 401 retried with a fresh login), rate-limit answers, other
 * failed answers, bytes sent and received (request bodies, response
 * content-length) and the requests' own time.
 */
export interface Transport {
  calls: number;
  retries: number;
  rateLimited: number;
  failed: number;
  bytes: number;
  /** The requests' time, summed: to their answer's headers, or their failure. */
  requestMs: number;
  /**
   * The requests traced one by one, for one `github-request` event apiece
   * (at most MAX_NOTED per scope; the rest only counted in `unnoted`): with
   * `every`, every request (a step's); otherwise each that failed, was
   * re-sent or was rate-limited.
   */
  requests?: NotedRequest[];
  unnoted?: number;
  every?: true;
}

/** Why a request failed: no answer (`dns`, `tls`, `timeout`, `connection`, `aborted`), or the answer's status. */
export type FailureCategory =
  | "aborted"
  | "client"
  | "connection"
  | "credential"
  | "dns"
  | "not-found"
  | "permission"
  | "rate-limit"
  | "server"
  | "timeout"
  | "tls";

/** One traced request. */
export interface NotedRequest {
  method: string;
  /** The path with its query dropped and ids, numbers and hashes as placeholders. */
  route: string;
  /** Null when no answer came (the network). */
  status: number | null;
  /** 2: re-sent once with a fresh login after a 401. */
  attempt: number;
  /** From sending to the answer's headers, or to the failure. */
  ms: number;
  /** Present when it failed. */
  category?: FailureCategory;
  rateLimited?: true;
  requestId?: string;
  retryAfterSeconds?: number;
  rateLimitReset?: string;
}

const MAX_NOTED = 50;

/** The scope whose requests `GitHub.send` counts. */
export const transport = new AsyncLocalStorage<Transport>();

/** An empty tally; `every`: trace every request, not only the failed ones. */
export function newTransport(every = false): Transport {
  return {
    calls: 0,
    retries: 0,
    rateLimited: 0,
    failed: 0,
    bytes: 0,
    requestMs: 0,
    ...(every ? { every: true as const } : {}),
  };
}

/** `path` as a route template: no query, and numbers, hashes and node ids as placeholders. */
export function routeOf(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((part) =>
      /^\d+$/.test(part)
        ? "{n}"
        : /^[0-9a-f]{7,64}$/i.test(part) && /\d/.test(part)
          ? "{sha}"
          : part,
    )
    .join("/");
}

const DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"]);
const TIMEOUT = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** A request that got no answer, by its error's structured fields (name and code, its cause's too). */
export function networkCategory(
  error: unknown,
  aborted: boolean,
): FailureCategory {
  if (aborted) return "aborted";
  const chain: { name?: unknown; code?: unknown }[] = [];
  for (
    let at: unknown = error, depth = 0;
    at && typeof at === "object" && depth < 4;
    at = (at as { cause?: unknown }).cause, depth++
  )
    chain.push(at as { name?: unknown; code?: unknown });
  const codes = chain.map((e) => (typeof e.code === "string" ? e.code : ""));
  if (chain.some((e) => e.name === "TimeoutError")) return "timeout";
  if (codes.some((code) => DNS.has(code))) return "dns";
  if (codes.some((code) => TIMEOUT.has(code))) return "timeout";
  if (
    codes.some((code) =>
      /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_OSSL)/.test(
        code,
      ),
    )
  )
    return "tls";
  return "connection";
}

/** A failed answer's category; undefined for a success. */
export function statusCategory(
  status: number,
  limited: boolean,
): FailureCategory | undefined {
  if (limited) return "rate-limit";
  if (status < 400) return undefined;
  if (status === 401) return "credential";
  if (status === 403) return "permission";
  if (status === 404 || status === 410) return "not-found";
  return status >= 500 ? "server" : "client";
}

/** Keep one request of the current scope for its `github-request` event; the kept record, none past MAX_NOTED. */
export function note(
  counted: Transport,
  request: Omit<NotedRequest, "route"> & { path: string },
  response: Response | undefined,
): NotedRequest | undefined {
  counted.requests ??= [];
  if (counted.requests.length >= MAX_NOTED) {
    counted.unnoted = (counted.unnoted ?? 0) + 1;
    return undefined;
  }
  const { path, ...rest } = request;
  const header = (name: string) => response?.headers.get(name) ?? undefined;
  const retryAfter = Number(header("retry-after"));
  const reset = Number(header("x-ratelimit-reset"));
  const requestId = header("x-github-request-id");
  const noted: NotedRequest = {
    ...rest,
    route: routeOf(path),
    ...(requestId ? { requestId: requestId.slice(0, 80) } : {}),
    ...(retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    ...(reset > 0 && (rest.rateLimited || response?.status === 429)
      ? { rateLimitReset: new Date(reset * 1000).toISOString() }
      : {}),
  };
  counted.requests.push(noted);
  return noted;
}

/** A scope's traced requests as `github-request` events, its unnoted count as one more. */
export function requestEvents(
  job: string,
  counted: Transport,
): Record<string, unknown>[] {
  return [
    ...(counted.requests ?? []).map((request) => ({
      event: "github-request",
      job,
      ...request,
    })),
    ...(counted.unnoted
      ? [{ event: "github-request", job, unnoted: counted.unnoted }]
      : []),
  ];
}

/** A scope's `github-call` counts, without its traced requests. */
export function callCounts(counted: Transport): Record<string, number> {
  return {
    calls: counted.calls,
    retries: counted.retries,
    rateLimited: counted.rateLimited,
    failed: counted.failed,
    bytes: counted.bytes,
    requestMs: counted.requestMs,
  };
}
