/**
 * GitHub request tracing (docs/reference/run-log.md#Run log): what the
 * requests of one sync job, one step attempt or the rest of the service run
 * cost, and each request worth a line of its own. Counts, routes, statuses,
 * times, request ids and a failure's cause only: never a body, a token or a
 * query value.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { oneLine } from "./text.js";

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
  /**
   * What the client learned once for the rest of the service run, in this
   * scope (`GitHub` `protectionRefused`): each an event of its own, after
   * the requests' (`requestEvents`).
   */
  notices?: Record<string, unknown>[];
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
  /** No answer, or its body cut short: the error's codes, syscall, hostname and remote address (`networkCause`), and the error as one line (`failureText`). */
  codes?: string[];
  syscall?: string;
  hostname?: string;
  address?: string;
  cause?: string;
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

/** One error of a failure's chain, with the fields Node and undici set. */
interface Link {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  syscall?: unknown;
  hostname?: unknown;
  host?: unknown;
  address?: unknown;
  port?: unknown;
  /** undici's SocketError: the connection it lost. */
  socket?: { remoteAddress?: unknown; remotePort?: unknown };
  cause?: unknown;
  errors?: unknown;
}

const MAX_LINKS = 8;

/**
 * `error` and what is under it, outermost first: its `cause` chain and an
 * AggregateError's `errors` (a connection tried on each address), each
 * once, at most MAX_LINKS. fetch's own error says only "fetch failed".
 */
function links(error: unknown): Link[] {
  const found: Link[] = [];
  const queue: unknown[] = [error];
  while (queue.length && found.length < MAX_LINKS) {
    const at = queue.shift();
    if (!at || typeof at !== "object" || found.includes(at as Link)) continue;
    const link = at as Link;
    found.push(link);
    if (Array.isArray(link.errors)) queue.push(...link.errors);
    queue.push(link.cause);
  }
  return found;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** A link's remote end, `address:port` (`[v6]:port`), from its own fields or its lost socket's. */
function remote(link: Link): string | undefined {
  const address = text(link.address) ?? text(link.socket?.remoteAddress);
  if (!address) return undefined;
  const port =
    typeof link.port === "number"
      ? link.port
      : typeof link.socket?.remotePort === "number"
        ? link.socket.remotePort
        : undefined;
  if (port === undefined) return address;
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** What a request that got no answer met, for its `github-request` event (see `NotedRequest`). */
export interface NetworkCause {
  codes?: string[];
  syscall?: string;
  hostname?: string;
  address?: string;
}

/** The structured fields of a failure's chain (`links`): its error codes, each once, and the first syscall, hostname and remote address. */
export function networkCause(error: unknown): NetworkCause {
  const chain = links(error);
  const codes = [
    ...new Set(chain.map((e) => text(e.code)).filter((code) => code)),
  ] as string[];
  const first = (pick: (e: Link) => string | undefined) => {
    for (const link of chain) {
      const value = pick(link);
      if (value) return value;
    }
    return undefined;
  };
  const syscall = first((e) => text(e.syscall));
  const hostname = first((e) => text(e.hostname) ?? text(e.host));
  const address = first(remote);
  return {
    ...(codes.length ? { codes } : {}),
    ...(syscall ? { syscall } : {}),
    ...(hostname ? { hostname } : {}),
    ...(address ? { address } : {}),
  };
}

/** A URL's login and query dropped: a signed link's signature, a token in a remote. */
const withoutSecrets = (line: string): string =>
  line
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#][^\s)]*/gi, "$1");

/**
 * A failed request's error as one line: its message, then each cause's
 * with the code, syscall, hostname and remote address it doesn't already
 * say, as `fetch failed: other side closed (UND_ERR_SOCKET,
 * 192.0.2.1:443)`. No URL's login or query.
 */
export function failureText(error: unknown): string {
  const chain = links(error);
  if (!chain.length) return oneLine(withoutSecrets(String(error)), 600);
  const parts: string[] = [];
  for (const link of chain) {
    const message = oneLine(text(link.message) ?? text(link.name) ?? "", 200);
    // Each field as it is shown, and as the message would already say it.
    const fields: string[] = [];
    for (const [shown, said] of [
      [text(link.code), text(link.code)],
      [text(link.syscall), text(link.syscall)],
      [text(link.hostname) ?? text(link.host), undefined],
      [remote(link), text(link.address) ?? text(link.socket?.remoteAddress)],
    ])
      if (shown && !message.includes(said ?? shown) && !fields.includes(shown))
        fields.push(shown);
    const part = [message, fields.length ? `(${fields.join(", ")})` : ""]
      .filter(Boolean)
      .join(" ");
    if (part && !parts.includes(part)) parts.push(part);
  }
  const [top = String(error), ...causes] = parts;
  return oneLine(
    withoutSecrets(causes.length ? `${top}: ${causes.join("; ")}` : top),
    600,
  );
}

/** A failed request's cause, as its `github-request` event records it. */
export function causeFields(error: unknown): NetworkCause & { cause: string } {
  return { ...networkCause(error), cause: oneLine(failureText(error), 300) };
}

/** A request that got no answer, by its error's structured fields (name and code, its causes' too). */
export function networkCategory(
  error: unknown,
  aborted: boolean,
): FailureCategory {
  if (aborted) return "aborted";
  const chain = links(error);
  const codes = chain.map((e) => text(e.code) ?? "");
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

/** A scope's traced requests as `github-request` events, its unnoted count as one more, then its notices. */
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
    ...(counted.notices ?? []).map((notice) => ({ job, ...notice })),
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
