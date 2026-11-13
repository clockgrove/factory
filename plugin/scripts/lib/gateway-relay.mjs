// The metering relay for an opted-in AI Gateway key (#97). A repository that opts its own gateway key in to the worker's
// shell (lib/worker-secrets.mjs, NAME AI_GATEWAY_API_KEY) no longer hands the key to the sandbox: Factory's stage process
// holds it and runs this relay; the worker's shell gets a per-stage token in AI_GATEWAY_API_KEY and the relay's address
// in FACTORY_GATEWAY_URL. Each call the relay forwards is priced and counted into the Objective's spend (the pass's usage
// record: max_usd, daily_usd, `usd`, the progress line, the scorecard), and the relay refuses calls once the cap is
// reached, so a pipeline's spend through the key is capped live by numbers the model cannot edit.
//
// - Where it listens: a Unix socket (mode 600, or 660 for the agent's group on a runner) in a directory the agent cannot
//   write, and, with no sandbox at all (a developer's own session), a TCP port on this machine's 127.0.0.1. Sandboxed
//   commands reach the socket through a forwarder Factory's bwrap shim starts on the command namespace's own 127.0.0.1
//   (relay-shim.mjs). The token gates every call: another local user or process that reaches the socket or the port
//   gets nothing without it.
// - What it forwards: only the gateway's generation endpoints (POST; an image edit's multipart body as sent) and its
//   read-only model list (GET) on ROUTES, only to GATEWAY_ORIGIN, with the key in place of the token and an allowlist of
//   request and response headers. Never another path or method, a method override, a redirect it follows, an absolute
//   URL, CONNECT or an upgrade. The key is cut out of every response in each form a text can carry it.
// - Pricing, from what the caller cannot write: the gateway's own fields at fixed top-level places (an AI SDK protocol
//   response's or an image edit's `providerMetadata.gateway`, a stream's last event's), and the generation's cost looked up with the same key
//   (`/v1/generation?id=` by the answer's top-level generation id, or its x-generation-id header on a stream); the larger
//   of the two counts. A reported cost is booked at once and the lookup reconciles it aside (the gateway records a
//   generation seconds after the answer); with no reported cost the call waits for the lookup. A request body echoed
//   into a response (a tool's schema, a tool call's input) is never read.
// - A call that cost nothing, by structure: one that never left this machine (its socket never connected, or never
//   finished its TLS handshake: `unsent`); a refusal before any model ran (the gateway's known 4xx, or its error type
//   for one, PRE_MODEL_ERRORS; a 5xx saying no generation ran, UNAVAILABLE_ERRORS); a redirect, which is never followed.
// - A failed call whose cost is unknown (an error status, a broken answer, a timeout, a stream that carried an error and
//   no finish) is never $0 (#142): it is booked at an upper bound, the dearest call priced so far or $0.25, and relaying
//   goes on. One that names its generation is booked so at once, and its record's cost replaces the estimate when it
//   comes. UNKNOWN_STREAK_SHUT such calls in a row, with no priced call between them, shut the gateway for the stage (the
//   pass ends over budget, so the stage Blocks, and every later call is refused). So does a complete answer that cannot
//   be priced, at once. The call that shuts it is booked at the estimate too.
// - The call log: one line per call in the stage's usage directory (CALL_LOG), no body and no key.
// - The cap: calls are relayed only while a harness pass runs, one billable call at a time, each only once the calls
//   before it are priced or booked at their estimate, and only while the pass's spend through the key plus the harness's
//   own spend in the pass so far (read live from its stream, live-spend.mjs) is under the pass's budget (what max_usd
//   left when the pass started). So model spend plus key spend can pass the cap by at most one call's cost (and what the
//   harness spends after it).
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { dirname, join } from "node:path";
import { secretForms } from "./inputs.mjs";

/** The one host the relay forwards to. */
export const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
/** The worker secret's NAME whose value is relayed, never handed over: the Vercel AI Gateway's own variable. */
export const RELAYED_NAME = "AI_GATEWAY_API_KEY";
/** The relay's address in the worker's shell (`http://127.0.0.1:<port>`): the AI SDK's createGateway takes `${it}/v4/ai` as baseURL. */
export const RELAY_URL_ENV = "FACTORY_GATEWAY_URL";
/** The worker's own state directory, outside the checkout, kept for the stage (docs/PLAN.md, Worker secrets). */
export const STATE_DIR_ENV = "FACTORY_STATE_DIR";
/** A path the relay answers without the token, with its probe id: Factory's probes check a command reaches this relay. */
export const RELAY_PING = "/.factory-relay/ping";
/** A value with an AI Gateway key's shape (worker-relay.mjs relays it, or withholds it under any other name). */
export const GATEWAY_KEY_SHAPE = /^vck_/i;
/** The most of one JSON answer the relay keeps to price it (a stream keeps only its first and last events). */
export const MAX_PRICED_BYTES = 128 * 1024 * 1024;
/** When a generation's cost is looked up after the call (the gateway records it a little later). */
export const LOOKUP_DELAYS_MS = [1000, 3000, 6000, 12000, 20000, 30000];
/**
 * How long a complete answer's lookup goes on while the lookup itself fails (a 5xx, a 429, a network error: anything but
 * a cost or "no record"), and how far apart its further tries are. The call was billed and only this endpoint prices it,
 * so the relay waits, holding the turn, instead of shutting on an outage the caller did not cause. Ten minutes is half of
 * what one relayed call may itself take (UPSTREAM_TIMEOUT_MS), so a queued caller waits no longer than it already may;
 * past it the gateway shuts, as for a record that never comes.
 */
export const LOOKUP_OUTAGE_MS = 10 * 60_000;
export const LOOKUP_RETRY_MS = 15_000;
/** The most of a lookup's Retry-After the relay waits before its next try. */
export const LOOKUP_RETRY_AFTER_MAX_MS = 60_000;
/**
 * The Retry-After, in seconds, on the relay's own refusals a client should simply try again: its queue is full (429),
 * and the harness's live spend could not be read (503). A client that retries on its own backoff alone gives up within
 * seconds, while the queue ahead of it takes that long per call.
 */
export const RELAY_RETRY_AFTER_S = { waiting: 10, live: 5 };
/** How long a call may take upstream, sending to the last byte of its answer (a long image generation). */
export const UPSTREAM_TIMEOUT_MS = 20 * 60_000;
/**
 * The TCP keepalive on each upstream call's socket (#145). Node's global agent probes after 1 s idle and then every
 * second; Vercel's edge answers about 27 probes on a connection and then none, so ten unanswered probes later the kernel
 * ended a call whose answer was still silent with ETIMEDOUT, about 38 s in. One probe a minute keeps a silent call (and
 * any NAT on the path) alive past UPSTREAM_TIMEOUT_MS (27 probes a minute apart outlast it), and still finds a dead peer
 * about 70 s after its last answer.
 */
export const UPSTREAM_KEEPALIVE_MS = 60_000;
/** How long a request's body may take to arrive once the relay reads it (not while it waits its turn under a cap). */
export const BODY_TIMEOUT_MS = 5 * 60_000;

/**
 * An image edit's body cap: its reference images travel in it, base64 in JSON as raccoon-world's turnaround sends them
 * (four photo references came to 38.5 MiB). Only one capped call's body is held at a time (one billable call in flight).
 */
export const EDITS_MAX_BYTES = 128 * 1024 * 1024;

/**
 * What the relay forwards: method, path (no query) and the request's size cap. `family` says where its cost is read:
 * `sdk` (the AI SDK's gateway protocol: `providerMetadata.gateway` at the top level, or in a stream's last event),
 * `openai` (an OpenAI- or Anthropic-compatible answer: its top-level generation id, looked up), `image` (an OpenAI-compatible
 * image edit: the gateway's `providerMetadata.gateway` at the top level if it adds one, else as `openai`), `free` (the
 * model list). An image edit's body is multipart form data (the AI SDK's OpenAI provider, fetch with FormData) or JSON
 * with data URLs; either passes as sent, its content-type and boundary untouched, up to a few reference images.
 */
export const ROUTES = [
  { method: "POST", path: /^\/v[1-9]\/ai\/(language-model|image-model|embedding-model|decision-model|reranking-model)$/, family: "sdk", maxBytes: 64 * 1024 * 1024 },
  { method: "POST", path: /^\/v1\/(chat\/completions|responses|embeddings|messages|images\/generations)$/, family: "openai", maxBytes: 64 * 1024 * 1024 },
  { method: "POST", path: /^\/v1\/images\/edits$/, family: "image", maxBytes: EDITS_MAX_BYTES },
  { method: "GET", path: /^\/v[1-9]\/ai\/config$|^\/v1\/models$/, family: "free", maxBytes: 0 },
];
/**
 * The request headers passed on; every other one is dropped. The AI SDK's own (ai@7.0.165, @ai-sdk/gateway 4.0.138, as
 * recorded in plugin/test/fixtures/ai-sdk-7.0.165-requests.json): ai-gateway-protocol-version, ai-gateway-auth-method,
 * the model in ai-model-id or, for a language model, ai-language-model-id, ai-<kind>-model-specification-version,
 * ai-language-model-streaming, and ai-o11y-* on Vercel. The gateway refuses a call without its model header (400).
 */
export const REQUEST_HEADERS = /^(content-type|accept|accept-language|user-agent|anthropic-version|anthropic-beta|ai-(gateway-protocol-version|gateway-auth-method|model-id|[a-z]+-model-(id|specification-version|streaming)|o11y-[a-z-]+))$/;
/** The response headers passed back; every other one is dropped. */
const RESPONSE_HEADERS = /^(content-type|retry-after|x-vercel-id|x-request-id|request-id|x-ratelimit-[a-z-]+)$/;

const num = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};
const GEN_ID = /^gen_[A-Za-z0-9]{6,64}$/;
/** The answers that bill nothing: the gateway refused the call before any model ran. */
const UNBILLED = new Set([400, 401, 403, 404, 413, 422, 429]);
/**
 * The gateway's own 402 refusals, by their error type: a team, project, key or user budget spent
 * (`quota_for_entity_exceeded`), or no AI Gateway Credits left (`insufficient_funds`). Refused before any model ran, so
 * $0; any other 402 is a failed call of unknown cost.
 */
export const GATEWAY_REFUSALS = new Set(["quota_for_entity_exceeded", "insufficient_funds"]);
/**
 * The gateway's error types for a call it refused before any model ran (as `@ai-sdk/gateway` reads them): a key, a
 * request, a rate limit, a model or a route it would not take. Such an answer costs $0 only with a 4xx status and the
 * type at `error.type`; a 5xx is looked up or estimated whatever its type. A provider's failure (`failed_dependency`)
 * or the gateway's own (`internal_server_error`) may come after a model ran: not these.
 */
export const PRE_MODEL_ERRORS = new Set(["authentication_error", "invalid_request_error", "rate_limit_exceeded", "model_not_found", "not_found", "forbidden", "customer_verification_required"]);
/**
 * The 5xx error types for a call no generation ran for (#148): the gateway or its provider had no capacity
 * (`service_unavailable_error`: the gateway's 503, "provider capacity or gateway service unavailable" in Vercel's AI
 * Gateway reference), a provider overloaded (`overloaded_error`, Anthropic's, through `/v1/messages`) or rate limited
 * (`rate_limit_exceeded`, the gateway's; `rate_limit_error`, Anthropic's). With such a type at `error.type`, or at the
 * body's top level when it has no `error` object (the gateway writes both shapes, as for its 402), and no generation id
 * in the body or header, the call costs $0 and is no unknown cost; with an id it is booked at the estimate and looked up.
 */
export const UNAVAILABLE_ERRORS = new Set(["service_unavailable_error", "overloaded_error", "rate_limit_exceeded", "rate_limit_error"]);
/** The least a call whose cost stays unknown is booked at (#142): it, or the dearest call priced so far, the larger. */
export const UNKNOWN_COST_FLOOR_USD = 0.25;
/**
 * How many calls of unknown cost in a row, with no priced call between them, shut the gateway for the stage. Six is two
 * client calls of three attempts each (the AI SDK tries a 408, 409, 429 or 5xx three times): one call's retries through
 * a blip never shut it, and a gateway that prices nothing across two whole calls does. Each of the six is booked at the
 * estimate, so the stage's count is short by at most six times what a call cost above its estimate.
 */
export const UNKNOWN_STREAK_SHUT = 6;
/** The per-call log, in the stage's usage directory (no sandbox writes there): one JSON line per call. */
export const CALL_LOG = "relay-calls.jsonl";
/** The most lines the call log takes; past them, one closing line counts the calls left out. */
export const CALL_LOG_MAX_LINES = 2000;

/**
 * The gateway's error type in an error answer's body, at `error.type` (its standard error shape); else null. `topLevel`:
 * a body with no `error` object is read at its own `type` too, the other shape the gateway writes (gatewayRefusalOf).
 */
export function errorTypeOf(doc, { topLevel = false } = {}) {
  const top = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : null);
  const d = top(doc);
  const e = top(d?.error) ?? (topLevel ? d : null);
  return typeof e?.type === "string" && /^[a-z0-9_]{1,64}$/.test(e.type) ? e.type : null;
}

/** An error answer's generation id, from the gateway's own places: its top-level `generationId` or `id`, or the header. */
export function errorGenerationId(doc, headerId = null) {
  const d = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  return [d?.generationId, d?.id, headerId].find((v) => typeof v === "string" && GEN_ID.test(v)) || null;
}

/**
 * The model a call names, for the call log: its allowlisted model header, else a JSON body's or a form's `model`; kept
 * only when it has a model id's shape (`provider/name`, at most 80 characters). The caller chose it: the stage's held
 * secrets are masked in the log (worker.mjs finish).
 */
export function modelOf(headers, body, type = "") {
  const clean = (v) => (typeof v === "string" && v.length <= 80 && /^[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9][\w.:-]*$/.test(v) ? v : null);
  const h = clean(headers?.["ai-language-model-id"]) ?? clean(headers?.["ai-model-id"]);
  if (h || !body?.length) return h;
  if (/^application\/json/i.test(type)) {
    try {
      const j = JSON.parse(body.toString("utf8"));
      return clean(j && typeof j === "object" && !Array.isArray(j) ? j.model : null);
    } catch {
      return null;
    }
  }
  if (/^multipart\/form-data/i.test(type)) return clean(/name="model"\r\n(?:[^\r\n]*\r\n)*\r\n([^\r\n]{1,120})\r\n/.exec(body.subarray(0, 64 * 1024).toString("latin1"))?.[1]);
  return null;
}

/**
 * The gateway's budget or credits refusal in a 402 answer's body, or null: its error type (at `error.type`, or `type` at
 * the top level) one of GATEWAY_REFUSALS, with its message on one line, clipped, and `cut` (the key cut out).
 */
export function gatewayRefusalOf(doc, cut = (t) => t) {
  const top = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : null);
  const d = top(doc);
  const e = top(d?.error) ?? d;
  if (!e || typeof e.type !== "string" || !GATEWAY_REFUSALS.has(e.type)) return null;
  const one = cut(typeof e.message === "string" ? e.message : "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { type: e.type, message: one.length > 160 ? `${one.slice(0, 159).trimEnd()}…` : one };
}

/** How a Block reason or a log line names the gateway's refusal: `AI Gateway refused: <type> (<message>)`. */
export const gatewayRefusalText = (r) => `AI Gateway refused: ${r.type}${r.message ? ` (${r.message})` : ""}`;

/** A Blocked stage's reason with the gateway's refusal in this stage named first (the worker may have stopped on it). */
export function withGatewayRefusal(reason, refused) {
  if (!refused) return reason;
  const named = gatewayRefusalText(refused);
  return !reason ? named : reason.includes(named) ? reason : `${named}; ${reason}`;
}

/**
 * A Blocked stage's reason with what the relay saw named first: the gateway's own refusal (withGatewayRefusal), the
 * relay's shutdown (withRelayShut). `totals`: the relay's (totals()); `capReached`: Factory's max_usd was in fact reached.
 */
export const stageBlockReason = (reason, totals, capReached = false) => withGatewayRefusal(withRelayShut(reason, totals?.shut ?? null, capReached), totals?.gatewayRefused ?? null);

/**
 * A Blocked stage's cause (logic.mjs BLOCK_CAUSES) beside stageBlockReason: the gateway's budget or credits refusal in
 * this stage is the cause (the worker may have stopped on it); a "dollar cap" the relay's shutdown caused, with max_usd
 * not reached, is Factory's own; anything else keeps `cause`.
 */
export function stageBlockCause(cause, totals, capReached = false) {
  if (totals?.gatewayRefused) return "gateway-budget";
  if (totals?.shut && cause === "max-usd" && !capReached) return "factory";
  return cause;
}

/**
 * How a Block reason names the relay's shutdown: `gateway relay shut: <n> calls in this stage could not be priced (<why>)`
 * after UNKNOWN_STREAK_SHUT failures of unknown cost in a row, or `gateway relay shut: a complete answer could not be priced (<why>)`.
 */
export const relayShutText = (shut) => (shut.complete ? `gateway relay shut: a complete answer could not be priced (${shut.why})` : `gateway relay shut: ${shut.calls} calls in this stage could not be priced (${shut.why})`);

/**
 * A Blocked stage's reason with the relay's shutdown named first. The shutdown ends the pass over budget, so the stage
 * reads "dollar cap reached"; unless max_usd was in fact reached (`capReached`), that is replaced: only an actual overrun
 * reads so.
 */
export function withRelayShut(reason, shut, capReached = false) {
  if (!shut) return reason;
  const named = relayShutText(shut);
  if (reason === "dollar cap reached" && !capReached) return `${named}; Factory's max_usd was not reached`;
  return !reason ? named : reason.includes(named) ? reason : `${named}; ${reason}`;
}
/** What a call after the gateway's budget or credits refusal is told, after the refusal itself. */
const GATEWAY_REFUSED_MORE = "Factory's gateway relay refuses further calls in this stage: this is the AI Gateway's own budget or credits, not Factory's max_usd. Stop and report it";
/** The most billable calls waiting behind the one in flight while a cap is on; more get 429. */
export const MAX_WAITING = 8;

/** The route a request takes, or null: refused. */
export function routeOf(method, target) {
  if (typeof target !== "string" || target.includes("?") || target.includes("#")) return null;
  return ROUTES.find((r) => r.method === method && r.path.test(target)) || null;
}

/**
 * What one answer says it cost, from fixed places the caller cannot write: {usd, id}, either null. `doc` is the parsed JSON
 * body (or, for a stream, its last event that names the gateway's metadata: the `finish` event), `first` a stream's first
 * event, `headerId` the answer's `x-generation-id` header (the gateway sends it on a stream). An `sdk` answer's cost and
 * id: `providerMetadata.gateway.cost` (a string, "0.007") and `.generationId` at its top level, else the header's id. An
 * `openai` answer's: its top-level generation id (or the header's), looked up. An `image` answer's: the gateway's
 * top-level `providerMetadata.gateway` cost and id when it adds them, else as `openai`. Any other shape names neither, and
 * the call fails closed.
 */
export function costOf(doc, family, first = null, headerId = null) {
  const top = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : null);
  const d = top(doc);
  const fromHeader = typeof headerId === "string" && GEN_ID.test(headerId) ? headerId : null;
  if (family === "sdk") {
    const gw = top(top(d?.providerMetadata)?.gateway);
    return { usd: num(gw?.cost), id: typeof gw?.generationId === "string" && GEN_ID.test(gw.generationId) ? gw.generationId : fromHeader };
  }
  if (family === "openai" || family === "image") {
    const gw = family === "image" ? top(top(d?.providerMetadata)?.gateway) : null;
    const id = [gw?.generationId, d?.id, top(first)?.id, fromHeader].find((v) => typeof v === "string" && GEN_ID.test(v)) || null;
    return { usd: num(gw?.cost), id };
  }
  return { usd: null, id: null };
}

/**
 * The key cut out of a byte stream in each form a text can carry it (inputs.mjs secretForms: itself, JSON-escaped,
 * URL-encoded, base64 at each offset): each occurrence becomes `***`, also one split across two chunks.
 */
export function keyCutter(key) {
  const forms = [...new Set([String(key), ...secretForms(key)])].filter(Boolean).map((f) => Buffer.from(f, "utf8"));
  const longest = Math.max(...forms.map((f) => f.length));
  const mask = Buffer.from("***");
  let carry = Buffer.alloc(0);
  const cut = (buf) => {
    let out = buf;
    for (const k of forms) {
      const parts = [];
      let from = 0;
      for (let i = out.indexOf(k, from); i !== -1; i = out.indexOf(k, from)) {
        parts.push(out.subarray(from, i), mask);
        from = i + k.length;
      }
      parts.push(out.subarray(from));
      out = Buffer.concat(parts);
    }
    return out;
  };
  return {
    push(chunk) {
      const data = cut(Buffer.concat([carry, Buffer.from(chunk)]));
      // A form's start at the end waits for the next chunk.
      const keep = Math.min(data.length, longest - 1);
      carry = data.subarray(data.length - keep);
      return data.subarray(0, data.length - keep);
    },
    end() {
      const rest = cut(carry);
      carry = Buffer.alloc(0);
      return rest;
    },
    /** Whether `text` (a header value) carries the key in any form. */
    carries: (text) => forms.some((f) => String(text).includes(f.toString("utf8"))),
  };
}

/**
 * One upstream call through Node's own http(s) client, with `timeoutMs` for the whole of it (fetch's agent would cut a
 * slow model's first byte at 300 s): {status, headers: Map, body: async iterable of decoded bytes}. Never follows a
 * redirect. A compressed answer is decoded, so its cost can be read. Its socket probes the peer every `keepAliveMs`
 * (UPSTREAM_KEEPALIVE_MS), not the global agent's every second, and is its own (`connection: close`): never a pooled
 * socket that probed every second while it waited. The agent stays Node's own, so an operator's proxy (HTTPS_PROXY with
 * NODE_USE_ENV_PROXY) still applies.
 *
 * Two facts about a call that failed are told by structure, never by an error's text. A rejection carries `unsent`: the
 * request cannot have left this machine, because its socket was still connecting when the request got it and never
 * became ready to carry data (`connect`; over TLS `secureConnect`, before which Node encrypts none of the request), or
 * because no socket was ever given to it. A socket handed over already connected (a pooled one, a proxy's tunnel) may
 * carry the request at once, so such a call is never `unsent`. `timedOut()` on the answer, and `relayTimeout` on a
 * rejection, say this function's own timer ended the call, which a peer's reset does not.
 */
export function upstreamRequest(url, { method, headers, body = null, timeoutMs = UPSTREAM_TIMEOUT_MS, keepAliveMs = UPSTREAM_KEEPALIVE_MS }) {
  const u = new URL(url);
  const tls = u.protocol === "https:";
  const client = tls ? https : http;
  const state = { ready: false, timedOut: false };
  return new Promise((resolve, reject) => {
    const req = client.request(u, { method, headers: { ...headers, connection: "close", ...(body ? { "content-length": body.length } : {}) } }, (res) => {
      const h = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
      const enc = (h.get("content-encoding") || "").toLowerCase();
      const decoder = enc === "gzip" ? zlib.createGunzip() : enc === "br" ? zlib.createBrotliDecompress() : enc === "deflate" ? zlib.createInflate() : null;
      if (decoder) {
        h.delete("content-encoding");
        res.on("error", (e) => decoder.destroy(e));
      }
      resolve({ status: res.statusCode, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null, [Symbol.iterator]: () => h[Symbol.iterator]() }, body: decoder ? res.pipe(decoder) : res, timedOut: () => state.timedOut });
    });
    const timer = setTimeout(() => {
      state.timedOut = true;
      req.destroy(new Error("timed out"));
    }, timeoutMs);
    timer.unref();
    req.on("socket", (sock) => {
      // After the agent's own setting (one second): the socket is handed to this request with it already applied.
      sock.setKeepAlive(true, keepAliveMs);
      if (!sock.connecting) state.ready = true;
      else sock.once(tls ? "secureConnect" : "connect", () => (state.ready = true));
    });
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) => reject(Object.assign(e, { unsent: !state.ready, relayTimeout: state.timedOut })));
    req.end(body || undefined);
  });
}

/** Whether `header` (an Authorization value) is `Bearer <token>`, compared in constant time. */
export function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ""));
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The relay's own refusal: `factory_relay`, or `factory_max_usd` for Factory's dollar cap. `gateway`: an earlier answer's
 * gateway refusal repeated (its type and message, `source: "ai-gateway"`), so a client tells the two 402s apart.
 */
const refusal = (res, status, message, { type = "factory_relay", gateway = null, retryAfter = null } = {}) => {
  if (res.headersSent) return res.destroy();
  // What the client still sends is read and dropped, so the refusal reaches it.
  res.req?.resume?.();
  const error = gateway ? { message: `${gatewayRefusalText(gateway)}. ${message}`, type: gateway.type, source: "ai-gateway" } : { message: `Factory's gateway relay: ${message}`, type };
  const body = JSON.stringify({ error });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) });
  res.end(body);
};

/**
 * A server-sent event stream read as it passes: its first event, its dearest `finish` event (which carries the
 * gateway's cost and generation id) and whether it carried an `error` event (the AI SDK protocol's and Anthropic's
 * `type: "error"`: the provider failed after the answer's status was sent), never the whole stream.
 */
function eventReader() {
  let pending = "";
  let first = null;
  let finish = null;
  let errored = false;
  const take = (block) => {
    const line = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!line) return;
    let e;
    try {
      e = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (!e || typeof e !== "object") return;
    first ??= e;
    // The gateway's cost rides on its `finish` event; no other event's metadata is read. Of several, the dearest counts.
    if (e.type === "finish") {
      const cost = (x) => num(x?.providerMetadata?.gateway?.cost) ?? -1;
      if (!finish || cost(e) > cost(finish)) finish = e;
    }
    if (e.type === "error") errored = true;
  };
  return {
    push(text) {
      pending += text;
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop();
      for (const b of blocks) take(b);
      // An event longer than the cap is no event the relay prices.
      if (pending.length > MAX_PRICED_BYTES) pending = "";
    },
    end() {
      if (pending) take(pending);
      return { first, doc: finish, errored };
    },
  };
}

/**
 * Start the relay for `key`. `dir`: a directory only Factory's user writes, where the socket goes (made 700, or 711 when
 * `group` is given, the agent's group, which then owns the socket at 660 through `chgrp`, an async (path, group) =>
 * void that throws when it cannot). `tcp`: also listen on 127.0.0.1 (no sandbox). `maxUsd`: the stage's max_usd (0 or
 * less: no cap). Returns the relay: {url, port, tcpPort, socketPath, dir, token, probeId, beginPass(budget), endPass(),
 * totals(), close()}.
 */
export async function openRelay({ key, dir, group = null, chgrp = null, tcp = false, maxUsd = 0, origin = GATEWAY_ORIGIN, fetchImpl = globalThis.fetch, lookupDelaysMs = LOOKUP_DELAYS_MS, lookupOutageMs = LOOKUP_OUTAGE_MS, lookupRetryMs = LOOKUP_RETRY_MS, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS, bodyTimeoutMs = BODY_TIMEOUT_MS, maxPricedBytes = MAX_PRICED_BYTES, callLog = null, callLogMaxLines = CALL_LOG_MAX_LINES, log = () => {} }) {
  if (typeof key !== "string" || !key) throw new Error("the relay needs the key");
  const token = `factory-relay-${randomBytes(32).toString("base64url")}`;
  const probeId = randomBytes(12).toString("hex");
  const keyForms = keyCutter(key);
  const cutText = (t) => {
    const c = keyCutter(key);
    return Buffer.concat([c.push(Buffer.from(String(t), "utf8")), c.end()]).toString("utf8");
  };
  const s = { pings: 0, spent: 0, late: 0, lateUnpriced: 0, calls: 0, failed: 0, unpriced: 0, refused: { cap: 0, unpriced: 0, token: 0, pass: 0, route: 0, gateway: 0 }, gatewayRefused: null, dearest: 0, streak: 0, estimated: 0, estimatedUsd: 0, shut: null, logged: 0, unlogged: 0, busy: false, waiters: [], failClosed: false, capped: false, pass: null, pending: new Set(), checks: new Set(), reconciles: new Set(), said: new Set() };
  const once = (what, line) => {
    if (s.said.has(what)) return;
    s.said.add(what);
    log(line);
  };
  const capOn = Number(maxUsd) > 0;

  // One JSON line per call in the stage's usage directory (CALL_LOG): never a body, a header's value or the key. A log
  // that cannot be written is said once; the call goes on.
  const record = (entry) => {
    if (!callLog) return;
    if (s.logged >= callLogMaxLines) {
      s.unlogged += 1;
      return;
    }
    try {
      mkdirSync(dirname(callLog), { recursive: true, mode: 0o700 });
      const { model: m, ...rest } = entry;
      appendFileSync(callLog, `${JSON.stringify({ t: new Date().toISOString(), ...rest, ...(m ? { model: m } : {}) })}\n`, { mode: 0o600 });
      s.logged += 1;
    } catch (e) {
      once("calllog", `gateway relay: the per-call log could not be written (${String(e?.code || e?.message || e).slice(0, 60)})`);
    }
  };
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
  // Dollars added to the stage's spend (or taken off it, when an estimate's record says less): in the pass that runs,
  // else kept for the next endPass (a call that finished after its pass ended).
  const add = (usd) => {
    s.spent += usd;
    if (s.pass) s.pass.usd += usd;
    else s.late += usd;
  };
  // One call's cost. `priced`: a cost the gateway gave (reported or looked up), which sets the dearest call so far and
  // ends a run of unknown costs; an estimate does neither.
  const book = (usd, priced = true) => {
    add(usd);
    if (priced) {
      s.dearest = Math.max(s.dearest, usd);
      s.streak = 0;
    }
    if (s.pass) s.pass.calls += 1;
  };
  // A looked-up cost above what the call was booked at: added to the spend, not counted as a call of its own.
  const bookExtra = (usd, total) => {
    add(usd);
    s.dearest = Math.max(s.dearest, total);
  };
  // The upper bound a call of unknown cost is booked at (#142): the dearest call priced so far in the stage, at least
  // UNKNOWN_COST_FLOOR_USD. It counts against max_usd like any spend. Returns what dropEstimate takes back.
  const bookEstimate = () => {
    const usd = round6(Math.max(s.dearest, UNKNOWN_COST_FLOOR_USD));
    const pass = s.pass;
    book(usd, false);
    s.estimated += 1;
    s.estimatedUsd += usd;
    if (pass) pass.estimated = (pass.estimated || 0) + 1;
    else s.lateEstimated = (s.lateEstimated || 0) + 1;
    return { usd, pass };
  };
  // An estimate its generation's record replaced is no estimate any more.
  const dropEstimate = ({ usd, pass }) => {
    s.estimated -= 1;
    s.estimatedUsd -= usd;
    if (pass && pass === s.pass) pass.estimated -= 1;
    else if (!pass && s.lateEstimated) s.lateEstimated -= 1;
  };
  // The gateway shut for the stage: the pass ends over budget (the stage stops) and every later call is refused.
  const shutDown = (why, complete = false) => {
    s.unpriced += 1;
    if (s.pass) s.pass.unpriced += 1;
    else s.lateUnpriced += 1;
    if (s.failClosed) return;
    s.failClosed = true;
    s.shut = { calls: complete ? 1 : s.streak, why, ...(complete ? { complete: true } : {}) };
    once("unpriced", `gateway relay: ${complete ? "a complete answer" : `${s.streak} calls in a row`} could not be priced (${why}); ${relayShutText(s.shut)}: the pass ends over budget and every later call is refused`);
  };
  // One more call of unknown cost in a row, its estimate already booked: the UNKNOWN_STREAK_SHUT-th with no priced call
  // between them shuts the gateway for the stage. Returns the call log's basis for it.
  const strike = (why, usd) => {
    s.streak += 1;
    if (!s.failClosed && s.streak >= UNKNOWN_STREAK_SHUT) {
      shutDown(why);
      return "shut";
    }
    if (!s.failClosed) log(`gateway relay: a call's cost could not be determined (${why}); booked $${usd.toFixed(4)} against max_usd, an upper bound (the dearest call so far, or $${UNKNOWN_COST_FLOOR_USD.toFixed(2)}), and relaying goes on (${s.streak} in a row; ${UNKNOWN_STREAK_SHUT} in a row with no priced call between them shut the gateway for this stage)`);
    return "estimate";
  };
  // A call that failed (a network error after it was sent, a broken or truncated answer, a timeout, an error status, a
  // stream that carried an error and no finish) and that nothing prices: booked at the estimate, and a strike. Returns
  // what the call log records.
  const unknown = (why) => {
    const { usd } = bookEstimate();
    return { usd, basis: strike(why, usd), unpriced: why };
  };
  // A complete answer that cannot be priced: its route and shape are the caller's choice, so the gateway shuts at once.
  // The call was billed, so it is booked at the estimate all the same.
  const unpricedAnswer = (why) => {
    const { usd } = bookEstimate();
    shutDown(why, true);
    return { usd, basis: "shut", unpriced: why };
  };
  // One try at a generation's record: {usd}, {none} (the gateway answered 404: no record), or {failed} (anything else:
  // a 5xx, a 429, a redirect, a network error, a record with no cost yet), with the wait its Retry-After asks for.
  const lookupOnce = async (id) => {
    try {
      const r = await fetchImpl(`${origin}/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(60_000) });
      if (r.ok) {
        const usd = num((await r.json())?.data?.total_cost);
        return usd !== null ? { usd } : { failed: true };
      }
      const after = Number(r.headers?.get?.("retry-after"));
      // The answer's body is not read: dropped, so its connection is not held.
      await Promise.resolve(r.body?.cancel?.()).catch(() => {});
      if (r.status === 404) return { none: true };
      return { failed: true, retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after * 1000, LOOKUP_RETRY_AFTER_MAX_MS) : 0 };
    } catch {
      return { failed: true };
    }
  };
  // A generation's cost from its record, tried at lookupDelaysMs (the gateway writes it seconds after the answer):
  // {usd} (null: none found) and `failed` (the last try was no answer at all). `wait`: for a complete answer, whose
  // only price this is. When any try failed otherwise than "no record", the tries go on every lookupRetryMs (or the
  // Retry-After) until the lookup answers, a cost or "no record", or lookupOutageMs has passed since the first.
  const lookup = async (id, { wait = false } = {}) => {
    const started = Date.now();
    let last = null;
    let failed = false;
    for (const ms of lookupDelaysMs) {
      await sleep(Math.max(ms, last?.retryAfterMs || 0));
      last = await lookupOnce(id);
      if (last.usd !== undefined) return { usd: last.usd, failed: false };
      if (last.failed) failed = true;
    }
    while (wait && failed && Date.now() - started < lookupOutageMs) {
      await sleep(Math.max(lookupRetryMs, last?.retryAfterMs || 0));
      last = await lookupOnce(id);
      if (last.usd !== undefined) return { usd: last.usd, failed: false };
      if (last.none) break;
    }
    return { usd: null, failed: !!last?.failed };
  };
  // A lookup that runs beside the calls, never holding the turn. What it throws is said, never left unhandled.
  const aside = (set, job) => {
    const guarded = job.catch((e) => once("aside", `gateway relay: a cost lookup failed in the relay (${String(e?.code || e?.name || "error").slice(0, 40)})`));
    set.add(guarded);
    guarded.finally(() => set.delete(guarded));
  };
  // A call booked at `booked` whose generation is known: a record that says more adds the difference, on a line of the
  // call log of its own. For a reported cost, and for a refusal that names a generation (booked at $0).
  const reconcileUp = (id, booked, call) =>
    aside(
      s.checks,
      lookup(id).then((looked) => {
        if (looked.usd === null || looked.usd <= booked) return;
        bookExtra(looked.usd - booked, looked.usd);
        record({ ...call, id, usd: looked.usd, basis: "lookup", reconciled: round6(looked.usd - booked) });
      }),
    );
  // A failed call that names its generation: booked at the estimate at once, so the next call need not wait for the
  // record, which then replaces the estimate (a priced call, on a line of its own). A record that never comes leaves
  // the estimate standing, and is then a strike. endPass waits for these, so a pass's totals are final when given.
  const estimateThenLookup = (id, why, call) => {
    const est = bookEstimate();
    aside(
      s.reconciles,
      lookup(id).then((looked) => {
        if (looked.usd !== null) {
          add(looked.usd - est.usd);
          s.dearest = Math.max(s.dearest, looked.usd);
          s.streak = 0;
          dropEstimate(est);
          record({ ...call, id, usd: looked.usd, basis: "lookup", reconciled: round6(looked.usd - est.usd) });
          return;
        }
        const unpriced = `${why}; generation ${id} has no record`;
        record({ ...call, id, usd: est.usd, basis: strike(unpriced, est.usd), unpriced, reconciled: 0 });
      }),
    );
    return { usd: est.usd, basis: "estimate", id, unpriced: `${why}; generation ${id} is looked up` };
  };
  // One billable call at a time while a cap is on: the next starts once the one before it is priced.
  const acquire = () =>
    new Promise((resolve) => {
      if (!s.busy) {
        s.busy = true;
        return resolve();
      }
      s.waiters.push(resolve);
    });
  const release = () => {
    const next = s.waiters.shift();
    if (next) next();
    else s.busy = false;
  };

  const handle = async (req, res) => {
    // The request's body arrives within BODY_TIMEOUT_MS of its being read (a refused one's too), else the connection drops.
    const bodyDeadline = () => setTimeout(() => !req.complete && req.destroy(), bodyTimeoutMs).unref();
    let bodyTimer = bodyDeadline();
    if (req.method === "GET" && (req.url === RELAY_PING || req.url === `${RELAY_PING}?shim`)) {
      // A command sandbox's forwarder came up (relay-shim.mjs): counted for the pass, as the shim's proof of life.
      if (req.url.endsWith("?shim")) {
        s.pings += 1;
        if (s.pass) s.pass.pings += 1;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`factory-relay ${probeId}\n`);
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      s.refused.token += 1;
      return refusal(res, 401, `the request lacks this run's relay token: send the value of ${RELAYED_NAME} as a Bearer token`);
    }
    const route = Object.keys(req.headers).some((h) => /^x-(http-)?method-override$/i.test(h)) ? null : routeOf(req.method, req.url);
    if (!route) {
      s.refused.route += 1;
      record({ status: 403, refused: "route" });
      return refusal(res, 403, `${String(req.method).slice(0, 10)} ${String(req.url).split("?")[0].slice(0, 80)} is not relayed: only the AI Gateway's generation calls (POST) and its model list (GET)`);
    }
    // Every call, the model list included, only while a pass runs and nothing failed closed.
    if (s.failClosed) {
      s.refused.unpriced += 1;
      record({ method: req.method, path: req.url, status: 403, refused: "shut" });
      return refusal(res, 403, `${relayShutText(s.shut)}, so the Objective's dollar cap cannot be enforced; no further call is relayed in this stage. Stop and report it`);
    }
    if (!s.pass || s.pass.ended) {
      s.refused.pass += 1;
      return refusal(res, 403, "calls are relayed only while a Factory pass runs");
    }
    const billable = route.family !== "free";
    // The gateway refused an earlier call for its own budget or credits: every later billable call gets that refusal.
    const gatewayRefused = () => {
      s.refused.gateway += 1;
      record({ method: req.method, path: req.url, status: 402, refused: "gateway", type: s.gatewayRefused.type });
      return refusal(res, 402, GATEWAY_REFUSED_MORE, { gateway: s.gatewayRefused });
    };
    if (billable && s.gatewayRefused) return gatewayRefused();
    // A body its declared length puts over the cap is refused before it is read or waits.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > route.maxBytes) {
      record({ method: req.method, path: req.url, status: 413, refused: "size" });
      return refusal(res, 413, `a request over ${route.maxBytes} bytes is not relayed`);
    }
    // With a cap on, a billable call waits its turn before its body is read, and only a few may wait. The body's deadline
    // stops while it waits (a few image edits queued behind each other take minutes) and starts again once it is read.
    const serial = billable && capOn;
    if (serial) {
      if (s.busy && s.waiters.length >= MAX_WAITING) record({ method: req.method, path: req.url, status: 429, refused: "waiting" });
      if (s.busy && s.waiters.length >= MAX_WAITING) return refusal(res, 429, `more than ${MAX_WAITING} calls are waiting: with a dollar cap on, calls are relayed one at a time`, { retryAfter: RELAY_RETRY_AFTER_S.waiting });
      clearTimeout(bodyTimer);
      await acquire();
      bodyTimer = bodyDeadline();
    }
    let held = serial;
    const free = () => {
      if (held) {
        held = false;
        release();
      }
    };
    // The request body, whole and under its cap, before anything is sent.
    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += c.length;
        if (size > route.maxBytes) {
          free();
          return refusal(res, 413, `a request over ${route.maxBytes} bytes is not relayed`);
        }
        chunks.push(c);
      }
    } catch {
      free();
      return res.destroy();
    }
    // Read whole: the deadline is done (a body refused over its cap keeps it while the rest is drained).
    clearTimeout(bodyTimer);
    const model = billable ? modelOf(req.headers, chunks.length ? Buffer.concat(chunks) : null, String(req.headers["content-type"] || "")) : null;
    const started = Date.now();
    if (billable) {
      // The estimates still waiting for their generation's record count toward the run of unknown costs as if they
      // stood: while one more would reach UNKNOWN_STREAK_SHUT, this call waits (holding the turn) for one to settle. So
      // no more than that many calls of unknown cost are ever outstanding since the last priced one.
      while (!s.failClosed && s.reconciles.size && s.streak + s.reconciles.size >= UNKNOWN_STREAK_SHUT) await Promise.race([...s.reconciles]);
      const running = s.pass && !s.pass.ended ? s.pass : null;
      // The harness's own spend in the pass (live-spend.mjs): a figure that cannot be read refuses the call.
      let harnessUsd = 0;
      if (running?.live && running.budget !== null) {
        let v;
        try {
          v = await Promise.race([Promise.resolve(running.live()), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 10_000).unref())]);
        } catch {
          v = undefined;
        }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          free();
          s.refused.live = (s.refused.live || 0) + 1;
          once("live", "gateway relay: the harness's own spend in the pass could not be read; the call is refused, as the cap cannot be checked");
          return refusal(res, 503, "the model's own spend in this pass could not be read, so the Objective's dollar cap cannot be checked; the call is refused. Try once more; if it fails again, stop and report it", { retryAfter: RELAY_RETRY_AFTER_S.live });
        }
        harnessUsd = v;
      }
      // Checked once the calls before it are priced: the cap can be passed by this one call's cost at most. And checked
      // after the waits above: a pass that ended meanwhile gave its totals, so the call is refused, never sent.
      const p = running && !running.ended && s.pass === running ? running : null;
      if (p && !s.failClosed && s.gatewayRefused) {
        free();
        return gatewayRefused();
      }
      const over = !!p && p.budget !== null && p.usd + harnessUsd >= p.budget;
      if (!p || s.failClosed || over) {
        free();
        if (over) {
          s.refused.cap += 1;
          s.capped = true;
          p.capped = true;
          record({ method: req.method, path: req.url, model, status: 402, refused: "max_usd" });
          once("cap", `gateway relay: max_usd reached ($${p.usd.toFixed(4)} through the key and $${harnessUsd.toFixed(4)} by the harness this pass, $${p.budget.toFixed(4)} was left); further calls are refused`);
          return refusal(res, 402, `Factory's dollar cap is reached: the Objective's max_usd ($${p.usd.toFixed(2)} spent through the key and $${harnessUsd.toFixed(2)} by the model in this pass, of the $${p.budget.toFixed(2)} left); no further call is relayed. Stop and report it: the cap is Factory's, for this Objective, not the AI Gateway's budget`, { type: "factory_max_usd" });
        }
        s.refused[s.failClosed ? "unpriced" : "pass"] += 1;
        record({ method: req.method, path: req.url, model, status: 403, refused: s.failClosed ? "shut" : "pass" });
        return refusal(res, 403, s.failClosed ? `${relayShutText(s.shut)}; no further call is relayed in this stage` : "calls are relayed only while a Factory pass runs");
      }
      s.calls += 1;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (REQUEST_HEADERS.test(k.toLowerCase())) headers[k] = v;
    headers.authorization = `Bearer ${key}`;
    headers["accept-encoding"] = "identity";
    // Sent: from here the call may be billed whatever the client does, so it runs to its end (never aborted on a client's
    // hang-up) and is priced then; an end that leaves its cost unknown fails closed.
    const done = (async () => {
      let upstream;
      try {
        upstream = await upstreamRequest(`${origin}${req.url}`, { method: req.method, headers, body: route.method === "GET" ? null : Buffer.concat(chunks), timeoutMs: upstreamTimeoutMs });
      } catch (e) {
        // `relayTimeout` and `unsent` are upstreamRequest's own facts about the call, not read from the error's text.
        const code = String(e?.relayTimeout ? "timeout" : e?.code || e?.cause?.code || e?.name || "error").slice(0, 40);
        const unsent = e?.unsent === true;
        if (!res.headersSent && !res.destroyed) refusal(res, 502, unsent ? `the AI Gateway could not be reached (${code}): the call never left this machine, so nothing was billed, and it can be tried again` : `the AI Gateway call failed (${code})`);
        return { sentError: true, error: code, unsent };
      }
      const outHeaders = {};
      for (const [k, v] of upstream.headers) if (RESPONSE_HEADERS.test(k.toLowerCase()) && !keyForms.carries(v)) outHeaders[k] = v;
      if (!res.destroyed) res.writeHead(upstream.status, outHeaders);
      const cutter = keyCutter(key);
      const sse = /event-stream/i.test(upstream.headers.get("content-type") || "");
      const events = billable && sse ? eventReader() : null;
      const decoder = new TextDecoder();
      const kept = [];
      let keptBytes = 0;
      let overflow = false;
      let broken = false;
      try {
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            if (events) events.push(decoder.decode(chunk, { stream: true }));
            else if (billable && !overflow) {
              keptBytes += chunk.length;
              if (keptBytes > maxPricedBytes) {
                overflow = true;
                kept.length = 0;
              } else kept.push(Buffer.from(chunk));
            }
            if (!res.destroyed) {
              const out = cutter.push(chunk);
              if (out.length) res.write(out);
            }
          }
        }
        if (!res.destroyed) res.end(cutter.end());
      } catch (e) {
        // The relay's own timer ends a call by destroying it, which reads as a reset: upstreamRequest says which it was.
        broken = String(upstream.timedOut() ? "timeout" : e?.code || e?.cause?.code || e?.name || "error").slice(0, 40);
        if (!res.destroyed) res.destroy();
      }
      if (!billable) return { free: true };
      let parsed = { doc: null, first: null, errored: false };
      if (events) parsed = events.end();
      else if (!overflow) {
        try {
          parsed.doc = JSON.parse(Buffer.concat(kept).toString("utf8"));
        } catch {
          parsed.doc = null;
        }
      }
      return { status: upstream.status, broken, overflow, stream: !!events, headerId: upstream.headers.get("x-generation-id"), ...parsed };
    })().catch(() => ({ sentError: true, error: "relay" }));
    if (!billable) return;
    // The lock passes to the next call once this one is priced (finally), whatever happened to it. Each call's outcome is
    // one line of the call log.
    const pricing = done.then(async (o) => {
      const entry = { method: req.method, path: req.url, model, status: o.status ?? null, ms: Date.now() - started };
      try {
        Object.assign(entry, await price(o));
      } catch (e) {
        // Pricing itself failed: never $0, and never an unhandled failure that ends the stage's process.
        Object.assign(entry, unknown(`the relay could not price the call (${String(e?.code || e?.name || "error").slice(0, 40)})`));
      } finally {
        record(entry);
        free();
      }
    });
    // What one call cost, and how that was found: {usd, basis, id?, unpriced?, why?, type?}.
    const price = async (o) => {
      const headerId = typeof o.headerId === "string" && GEN_ID.test(o.headerId) ? o.headerId : null;
      const call = { method: req.method, path: req.url, model };
      // Never sent: the request cannot have left this machine (upstreamRequest `unsent`: its socket never connected, or
      // never finished its TLS handshake), so the gateway saw nothing and billed nothing. $0, and no unknown cost.
      if (o.sentError && o.unsent) {
        s.failed += 1;
        return { usd: 0, basis: "unsent", why: `the call never left this machine: ${o.error}` };
      }
      // A redirect: the relay follows none, and the gateway ran nothing to answer with one. $0, and no unknown cost.
      if (!o.sentError && !o.broken && o.status >= 300 && o.status < 400) {
        s.failed += 1;
        return { usd: 0, basis: "redirect" };
      }
      // A known refusal (a bad or unauthorised request, a missing model, too large, unprocessable, rate limited): the
      // gateway refused the call, which is not billed. Should it name a generation all the same, that is looked up
      // aside, and a cost its record gives is booked.
      if (UNBILLED.has(o.status) && !o.broken) {
        s.failed += 1;
        const id = errorGenerationId(o.overflow || o.stream ? null : o.doc, headerId);
        if (id) reconcileUp(id, 0, call);
        return { usd: 0, basis: "refused", type: errorTypeOf(o.doc), ...(id ? { id } : {}) };
      }
      // The gateway's budget or credits refusal (a 402 with its error type): refused before any model ran, so $0. The
      // pass goes on (the worker sees the gateway's answer and decides); later billable calls get the same refusal.
      const refused = o.status === 402 && !o.broken && !o.overflow && !o.first ? gatewayRefusalOf(o.doc, cutText) : null;
      if (refused) {
        s.failed += 1;
        s.gatewayRefused ??= refused;
        if (s.pass) s.pass.gatewayRefused ??= refused;
        once("gateway", `gateway relay: ${gatewayRefusalText(refused)}; the call cost $0, and later calls in this stage get the same refusal`);
        return { usd: 0, basis: "gateway-refused", type: refused.type };
      }
      const ok = !o.sentError && o.status >= 200 && o.status < 300;
      // A stream's `finish` event carries the gateway's cost: once it came, the call is priced however the socket ended.
      const finished = ok && o.stream && !!o.doc && costOf(o.doc, route.family, o.first, headerId).usd !== null;
      // A stream that ended cleanly with an `error` event and no `finish`: the provider failed after the answer's status
      // was sent. A failed call, which the caller did not shape.
      const streamFailed = ok && !o.broken && o.stream && o.errored && !o.doc;
      const complete = ok && (!o.broken || finished) && !streamFailed;
      // A complete answer too large to read its cost: priced by its header's generation when it names one; else the
      // caller can ask for such an answer, so it never passes as an unknown cost.
      if (complete && o.overflow) {
        const looked = headerId ? await lookup(headerId, { wait: true }) : null;
        if (looked && looked.usd !== null) {
          book(looked.usd);
          return { usd: looked.usd, basis: "lookup", id: headerId };
        }
        return { ...unpricedAnswer(headerId ? "the answer was too large to read its cost and its generation's record never came" : "the answer was too large to read its cost"), ...(headerId ? { id: headerId } : {}) };
      }
      if (!complete) {
        // Any other error answered whole: a 4xx the gateway gave before any model ran (its `error.type`, never its status
        // alone, never a type elsewhere in the body) is $0.
        const whole = !o.sentError && !o.broken && !o.overflow && !o.stream && !o.first;
        const type = whole ? errorTypeOf(o.doc) : null;
        // Its generation, when the answer names one: the error body's, the header's, a stream's first or finish event's.
        const streamId = o.stream ? [costOf(o.doc, route.family, o.first, headerId).id, o.first?.id].find((v) => typeof v === "string" && GEN_ID.test(v)) || null : null;
        const id = o.sentError ? null : errorGenerationId(o.overflow || o.stream ? null : o.doc, headerId) || streamId;
        if (type && o.status >= 400 && o.status < 500 && PRE_MODEL_ERRORS.has(type)) {
          s.failed += 1;
          if (id) reconcileUp(id, 0, call);
          return { usd: 0, basis: "refused", type, ...(id ? { id } : {}) };
        }
        // A 5xx saying no generation ran (the gateway or its provider unavailable, overloaded or rate limited; the type at
        // `error.type`, or at the top level of a body with no `error` object), naming no generation: $0, and no unknown
        // cost toward the gateway's shutdown.
        const said = type ?? (whole ? errorTypeOf(o.doc, { topLevel: true }) : null);
        if (said && o.status >= 500 && UNAVAILABLE_ERRORS.has(said) && !id) {
          s.failed += 1;
          return { usd: 0, basis: "unavailable", type: said };
        }
        // Else its cost is unknown: the estimate. With a generation named, booked at once and replaced by its record's
        // cost when that comes; with none, a strike now.
        const why = o.sentError ? `the call failed after it was sent: ${o.error}` : o.broken ? `the answer broke off: ${o.broken}` : streamFailed ? "the stream carried an error event and no finish" : o.overflow ? "the error answer was too large to read" : `the gateway answered ${o.status}${said ? ` (${said})` : ""}`;
        return { ...(id ? estimateThenLookup(id, why, call) : unknown(`${why}; no generation id`)), ...(said ? { type: said } : {}) };
      }
      const { usd, id } = costOf(o.doc, route.family, o.first, headerId);
      if (usd !== null) {
        // The gateway's own top-level cost: booked now, so the next call need not wait for the generation's record,
        // which the gateway writes seconds later. The lookup then runs aside, and a larger looked-up cost is booked on
        // top (in the pass still running, else in the next one).
        book(usd);
        if (id) reconcileUp(id, usd, call);
        return { usd, basis: "reported", ...(id ? { id } : {}), ...(o.broken ? { why: `the answer broke off after its finish event: ${o.broken}` } : {}) };
      }
      // No cost reported: the lookup is the only figure, so the next call waits for it. A complete answer that stays
      // unpriced shuts the gateway at once: which route and request shape answer so is the caller's choice, so it never
      // passes as an unknown cost. A lookup that itself fails is no such answer: it is tried for LOOKUP_OUTAGE_MS first.
      const looked = id ? await lookup(id, { wait: true }) : null;
      if (!looked || looked.usd === null) return { ...unpricedAnswer(!id ? "the answer named no cost and no generation" : looked.failed ? "the gateway reported no cost and the lookup of its generation's cost kept failing" : "the gateway reported no cost and its generation's record never came"), ...(id ? { id } : {}) };
      book(looked.usd);
      return { usd: looked.usd, basis: "lookup", id };
    };
    s.pending.add(pricing);
    pricing.finally(() => s.pending.delete(pricing));
  };

  const listen = (srv) => {
    srv.on("upgrade", (_req, sock) => sock.destroy());
    srv.on("connect", (_req, sock) => sock.destroy());
    srv.headersTimeout = 60_000;
    // The headers within a minute; the body's own deadline (BODY_TIMEOUT_MS) runs only while it is read, never while a
    // call waits its turn (Node's requestTimeout would drop a large body queued behind a long call).
    srv.requestTimeout = 0;
    return srv;
  };
  const server = listen(
    http.createServer((req, res) => {
      handle(req, res).catch(() => refusal(res, 500, "the call failed in the relay"));
    }),
  );

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, group ? 0o711 : 0o700);
  const socketPath = join(dir, `relay-${randomBytes(6).toString("hex")}.sock`);
  rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  if (group) {
    await chgrp(socketPath, group);
    chmodSync(socketPath, 0o660);
  }
  let tcpServer = null;
  let tcpPort = null;
  if (tcp) {
    tcpServer = listen(
      http.createServer((req, res) => {
        handle(req, res).catch(() => refusal(res, 500, "the call failed in the relay"));
      }),
    );
    await new Promise((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(0, "127.0.0.1", resolve);
    });
    tcpPort = tcpServer.address().port;
  }
  // The port the worker's shell names: the TCP one with no sandbox, else one for the forwarder in each command namespace
  // (its own loopback, empty but for what the command starts).
  const port = tcpPort ?? randomInt(20000, 60000);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    tcpPort,
    socketPath,
    dir,
    token,
    probeId,
    /**
     * A harness pass starts: calls are relayed while the key's spend in it, plus `live()` (the harness's own spend in the
     * pass so far, live-spend.mjs), stays under `budget` (null: no cap).
     */
    beginPass(budget, live = null) {
      s.pass = { budget: capOn ? Math.max(0, Number(budget) || 0) : null, live, usd: 0, calls: 0, unpriced: 0, estimated: 0, capped: false, pings: 0 };
    },
    /**
     * The pass ended: its spend through the key once every call in it is priced (or failed closed), with any spend booked
     * since the last pass ended (a call that finished after it), so every dollar reaches a usage record.
     */
    async endPass() {
      // Ended first: a call still waiting for its turn sees the pass ended and is refused, never sent. What is in flight
      // still books into it.
      const p = s.pass || { usd: 0, calls: 0, unpriced: 0, estimated: 0, capped: false, pings: 0 };
      p.ended = true;
      // Every call in flight, and every estimate still waiting for its generation's record (its lookup's tries are
      // bounded): the totals given below are final, and no later lookup changes them.
      while (s.pending.size || s.reconciles.size) await Promise.allSettled([...s.pending, ...s.reconciles]);
      // The reported costs' lookups: waited for a while (the gateway records a generation within seconds); one still
      // running books its difference into the next pass.
      await Promise.race([Promise.allSettled([...s.checks]), new Promise((r) => setTimeout(r, 15_000).unref())]);
      s.pass = null;
      const late = s.late;
      const lateUnpriced = s.lateUnpriced;
      const lateEstimated = s.lateEstimated || 0;
      s.late = 0;
      s.lateUnpriced = 0;
      s.lateEstimated = 0;
      return { usd: Math.max(0, Math.round((p.usd + late) * 1e6) / 1e6), calls: p.calls, unpriced: p.unpriced + lateUnpriced, estimated: (p.estimated || 0) + lateEstimated, capped: p.capped, pings: p.pings, gatewayRefused: p.gatewayRefused ?? null, shut: s.shut };
    },
    totals: () => ({ usd: Math.max(0, Math.round(s.spent * 1e6) / 1e6), pings: s.pings, calls: s.calls, failed: s.failed, unpriced: s.unpriced, capped: s.capped, failClosed: s.failClosed, gatewayRefused: s.gatewayRefused, estimated: s.estimated, estimatedUsd: Math.max(0, Math.round(s.estimatedUsd * 1e6) / 1e6), shut: s.shut, callLog: callLog && s.logged ? { file: CALL_LOG, lines: s.logged, ...(s.unlogged ? { unlogged: s.unlogged } : {}) } : null, refused: { ...s.refused } }),
    async close() {
      while (s.pending.size || s.reconciles.size) await Promise.allSettled([...s.pending, ...s.reconciles]);
      await Promise.allSettled([...s.checks]);
      // The calls past the log's cap, counted on one closing line.
      if (callLog && s.unlogged && !s.summarised) {
        s.summarised = true;
        try {
          appendFileSync(callLog, `${JSON.stringify({ t: new Date().toISOString(), unlogged: s.unlogged, note: `${s.unlogged} more calls past the log's ${callLogMaxLines} lines` })}\n`, { mode: 0o600 });
        } catch {
          // said once when the log first failed
        }
      }
      for (const srv of [server, tcpServer].filter(Boolean)) {
        srv.closeAllConnections?.();
        await new Promise((r) => srv.close(() => r()));
      }
      rmSync(socketPath, { force: true });
    },
  };
}

/** The relay this process runs for its stage, when there is one: what runHarness meters each pass with. */
let ACTIVE = null;
export const setActiveRelay = (r) => {
  ACTIVE = r;
};
export const activeRelay = () => ACTIVE;

/**
 * A pass's spend through the key added to its usage record: `workerKeyUsd` and `workerKeyCalls` beside the harness's own
 * dollars (`harnessUsd`), `usd` their sum, so max_usd between passes, daily_usd and the progress line count it. A pass
 * the relay refused at the cap is over budget, as one the harness stopped at its own cap; so is a pass in which the
 * relay shut (the stage stops there; its dollars, the estimates in them, are marked a lower bound as well).
 */
export function addKeySpend(rec, pass) {
  if (!rec || !pass) return rec;
  rec.harnessUsd = rec.usd ?? null;
  rec.workerKeyUsd = pass.usd;
  rec.workerKeyCalls = pass.calls;
  if (pass.usd > 0 || rec.usd !== null) rec.usd = Math.round(((rec.usd ?? 0) + pass.usd) * 1e6) / 1e6;
  if (rec.harnessUsd === null && pass.usd > 0) rec.usdLowerBound = true;
  // A call booked at its upper-bound estimate (#142): the dollars are an upper bound; the pass goes on.
  if (pass.estimated) {
    rec.usdUpperBound = true;
    rec.workerKeyEstimated = pass.estimated;
  }
  if (pass.unpriced) {
    rec.usdLowerBound = true;
    rec.workerKeyUnpriced = pass.unpriced;
    rec.budgetExceeded = true;
    if (pass.shut) rec.workerKeyShut = pass.shut;
  }
  if (pass.capped) {
    rec.budgetExceeded = true;
    rec.workerKeyCapped = true;
  }
  // The gateway's own refusal is no cap of Factory's: the pass is not over budget for it.
  if (pass.gatewayRefused) rec.workerKeyGatewayRefused = pass.gatewayRefused;
  return rec;
}
