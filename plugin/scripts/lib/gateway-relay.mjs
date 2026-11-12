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
// - What it forwards: only the gateway's generation endpoints (POST) and its read-only model list (GET) on ROUTES, only to
//   GATEWAY_ORIGIN, with the key in place of the token and an allowlist of request and response headers. Never another
//   path or method, a method override, a redirect it follows, an absolute URL, CONNECT or an upgrade. The key is cut out
//   of every response in each form a text can carry it.
// - Pricing, from what the caller cannot write: the gateway's own fields at fixed top-level places (an AI SDK protocol
//   response's `providerMetadata.gateway`, a stream's last event's), and the generation's cost looked up with the same key
//   (`/v1/generation?id=` by the answer's top-level generation id, or its x-generation-id header on a stream); the larger
//   of the two counts. A reported cost is booked at once and the lookup reconciles it aside (the gateway records a
//   generation seconds after the answer); with no reported cost the call waits for the lookup. A request body echoed
//   into a response (a tool's schema, a tool call's input) is never read. A call whose cost cannot be determined, an
//   error after the request was sent, a 5xx or a broken stream is never $0: the pass ends over budget, so the stage Blocks
//   (fail closed), and the relay refuses every later call. A 4xx answer (the gateway refused the call) is not billed.
// - The cap: calls are relayed only while a harness pass runs, one billable call at a time, each only once the calls
//   before it are priced, and only while the pass's spend through the key plus the harness's own spend in the pass so far
//   (read live from its stream, live-spend.mjs) is under the pass's budget (what max_usd left when the pass started). So
//   model spend plus key spend can pass the cap by at most one call's cost (and what the harness spends after it).
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { join } from "node:path";
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
/** How long a call may take upstream, sending to the last byte of its answer (a long image generation). */
export const UPSTREAM_TIMEOUT_MS = 20 * 60_000;

/**
 * What the relay forwards: method, path (no query) and the request's size cap. `family` says where its cost is read:
 * `sdk` (the AI SDK's gateway protocol: `providerMetadata.gateway` at the top level, or in a stream's last event),
 * `openai` (an OpenAI- or Anthropic-compatible answer: its top-level generation id, looked up), `free` (the model list).
 */
export const ROUTES = [
  { method: "POST", path: /^\/v[1-9]\/ai\/(language-model|image-model|embedding-model|decision-model|reranking-model)$/, family: "sdk", maxBytes: 64 * 1024 * 1024 },
  { method: "POST", path: /^\/v1\/(chat\/completions|responses|embeddings|messages|images\/generations)$/, family: "openai", maxBytes: 64 * 1024 * 1024 },
  { method: "GET", path: /^\/v[1-9]\/ai\/config$|^\/v1\/models$/, family: "free", maxBytes: 0 },
];
/** The request headers passed on (the AI SDK's own `ai-*` headers among them); every other one is dropped. */
const REQUEST_HEADERS = /^(content-type|accept|user-agent|anthropic-version|anthropic-beta|ai-(gateway-protocol-version|gateway-auth-method|model-id|[a-z]+-model-specification-version|language-model-streaming|o11y-[a-z-]+))$/;
/** The response headers passed back; every other one is dropped. */
const RESPONSE_HEADERS = /^(content-type|retry-after|x-vercel-id|x-request-id|request-id|x-ratelimit-[a-z-]+)$/;

const num = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};
const GEN_ID = /^gen_[A-Za-z0-9]{6,64}$/;
/** The answers that bill nothing: the gateway refused the call before any model ran. */
const UNBILLED = new Set([400, 401, 403, 404, 413, 422, 429]);
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
 * `openai` answer's: its top-level generation id (or the header's), looked up.
 */
export function costOf(doc, family, first = null, headerId = null) {
  const top = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : null);
  const d = top(doc);
  const fromHeader = typeof headerId === "string" && GEN_ID.test(headerId) ? headerId : null;
  if (family === "sdk") {
    const gw = top(top(d?.providerMetadata)?.gateway);
    return { usd: num(gw?.cost), id: typeof gw?.generationId === "string" && GEN_ID.test(gw.generationId) ? gw.generationId : fromHeader };
  }
  if (family === "openai") {
    const id = [d?.id, top(first)?.id, fromHeader].find((v) => typeof v === "string" && GEN_ID.test(v)) || null;
    return { usd: null, id };
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
 * redirect. A compressed answer is decoded, so its cost can be read.
 */
export function upstreamRequest(url, { method, headers, body = null, timeoutMs = UPSTREAM_TIMEOUT_MS }) {
  const u = new URL(url);
  const client = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(u, { method, headers: { ...headers, ...(body ? { "content-length": body.length } : {}) } }, (res) => {
      const h = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
      const enc = (h.get("content-encoding") || "").toLowerCase();
      const decoder = enc === "gzip" ? zlib.createGunzip() : enc === "br" ? zlib.createBrotliDecompress() : enc === "deflate" ? zlib.createInflate() : null;
      if (decoder) {
        h.delete("content-encoding");
        res.on("error", (e) => decoder.destroy(e));
      }
      resolve({ status: res.statusCode, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null, [Symbol.iterator]: () => h[Symbol.iterator]() }, body: decoder ? res.pipe(decoder) : res });
    });
    const timer = setTimeout(() => req.destroy(new Error("timed out")), timeoutMs);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
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

const refusal = (res, status, message) => {
  if (res.headersSent) return res.destroy();
  // What the client still sends is read and dropped, so the refusal reaches it.
  res.req?.resume?.();
  const body = JSON.stringify({ error: { message: `Factory's gateway relay: ${message}`, type: "factory_relay" } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

/**
 * A server-sent event stream read as it passes: its first event and its dearest `finish` event (which carries the
 * gateway's cost and generation id), never the whole stream.
 */
function eventReader() {
  let pending = "";
  let first = null;
  let finish = null;
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
      return { first, doc: finish };
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
export async function openRelay({ key, dir, group = null, chgrp = null, tcp = false, maxUsd = 0, origin = GATEWAY_ORIGIN, fetchImpl = globalThis.fetch, lookupDelaysMs = LOOKUP_DELAYS_MS, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS, log = () => {} }) {
  if (typeof key !== "string" || !key) throw new Error("the relay needs the key");
  const token = `factory-relay-${randomBytes(32).toString("base64url")}`;
  const probeId = randomBytes(12).toString("hex");
  const keyForms = keyCutter(key);
  const s = { pings: 0, spent: 0, late: 0, lateUnpriced: 0, calls: 0, failed: 0, unpriced: 0, refused: { cap: 0, unpriced: 0, token: 0, pass: 0, route: 0 }, busy: false, waiters: [], failClosed: false, capped: false, pass: null, pending: new Set(), checks: new Set(), said: new Set() };
  const once = (what, line) => {
    if (s.said.has(what)) return;
    s.said.add(what);
    log(line);
  };
  const capOn = Number(maxUsd) > 0;

  // Spend booked with no pass running (a call that finished after its pass ended) waits for the next endPass.
  const book = (usd) => {
    s.spent += usd;
    if (s.pass) {
      s.pass.usd += usd;
      s.pass.calls += 1;
    } else s.late += usd;
  };
  // A looked-up cost above the reported one: added to the spend, not counted as a call of its own.
  const bookExtra = (usd) => {
    s.spent += usd;
    if (s.pass) s.pass.usd += usd;
    else s.late += usd;
  };
  const failClosed = (why) => {
    s.unpriced += 1;
    s.failClosed = true;
    if (s.pass) s.pass.unpriced += 1;
    else s.lateUnpriced += 1;
    once("unpriced", `gateway relay: a call's cost could not be determined (${why}); the pass ends over budget and every later call is refused`);
  };
  const lookup = async (id) => {
    for (const ms of lookupDelaysMs) {
      await new Promise((r) => setTimeout(r, ms).unref());
      try {
        const r = await fetchImpl(`${origin}/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(60_000) });
        if (r.ok) {
          const usd = num((await r.json())?.data?.total_cost);
          if (usd !== null) return usd;
        }
      } catch {
        // tried again below
      }
    }
    return null;
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
      return refusal(res, 403, `${String(req.method).slice(0, 10)} ${String(req.url).split("?")[0].slice(0, 80)} is not relayed: only the AI Gateway's generation calls (POST) and its model list (GET)`);
    }
    // Every call, the model list included, only while a pass runs and nothing failed closed.
    if (s.failClosed) {
      s.refused.unpriced += 1;
      return refusal(res, 403, "an earlier call's cost could not be determined, so the Objective's dollar cap cannot be enforced; no further call is relayed in this stage");
    }
    if (!s.pass || s.pass.ended) {
      s.refused.pass += 1;
      return refusal(res, 403, "calls are relayed only while a Factory pass runs");
    }
    const billable = route.family !== "free";
    // With a cap on, a billable call waits its turn before its body is read, and only a few may wait.
    const serial = billable && capOn;
    if (serial) {
      if (s.busy && s.waiters.length >= MAX_WAITING) return refusal(res, 429, `more than ${MAX_WAITING} calls are waiting: with a dollar cap on, calls are relayed one at a time`);
      await acquire();
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
    if (billable) {
      // Checked once the calls before it are priced: the cap can be passed by this one call's cost at most.
      const p = s.pass && !s.pass.ended ? s.pass : null;
      // The harness's own spend in the pass (live-spend.mjs): a figure that cannot be read refuses the call.
      let harnessUsd = 0;
      if (p?.live && p.budget !== null) {
        let v;
        try {
          v = await Promise.race([Promise.resolve(p.live()), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 10_000).unref())]);
        } catch {
          v = undefined;
        }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          free();
          s.refused.live = (s.refused.live || 0) + 1;
          once("live", "gateway relay: the harness's own spend in the pass could not be read; the call is refused, as the cap cannot be checked");
          return refusal(res, 503, "the model's own spend in this pass could not be read, so the Objective's dollar cap cannot be checked; the call is refused. Try once more; if it fails again, stop and report it");
        }
        harnessUsd = v;
      }
      const over = !!p && p.budget !== null && p.usd + harnessUsd >= p.budget;
      if (!p || s.failClosed || over) {
        free();
        if (over) {
          s.refused.cap += 1;
          s.capped = true;
          p.capped = true;
          once("cap", `gateway relay: max_usd reached ($${p.usd.toFixed(4)} through the key and $${harnessUsd.toFixed(4)} by the harness this pass, $${p.budget.toFixed(4)} was left); further calls are refused`);
          return refusal(res, 402, `the Objective's max_usd is reached ($${p.usd.toFixed(2)} spent through the key and $${harnessUsd.toFixed(2)} by the model in this pass, of the $${p.budget.toFixed(2)} left); no further call is relayed. Stop and report it: the cap is the Objective's`);
        }
        s.refused[s.failClosed ? "unpriced" : "pass"] += 1;
        return refusal(res, 403, s.failClosed ? "an earlier call's cost could not be determined; no further call is relayed in this stage" : "calls are relayed only while a Factory pass runs");
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
        if (!res.headersSent && !res.destroyed) refusal(res, 502, `the AI Gateway call failed (${String(e?.cause?.code || e?.name || "error").slice(0, 40)})`);
        return { sentError: true };
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
              if (keptBytes > MAX_PRICED_BYTES) {
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
      } catch {
        broken = true;
        if (!res.destroyed) res.destroy();
      }
      if (!billable) return { free: true };
      let parsed = { doc: null, first: null };
      if (events) parsed = events.end();
      else if (!overflow) {
        try {
          parsed.doc = JSON.parse(Buffer.concat(kept).toString("utf8"));
        } catch {
          parsed.doc = null;
        }
      }
      return { status: upstream.status, broken, overflow, headerId: upstream.headers.get("x-generation-id"), ...parsed };
    })().catch(() => ({ sentError: true }));
    if (!billable) return;
    // The lock passes to the next call once this one is priced (finally), whatever happened to it.
    const pricing = done.then(async (o) => {
      try {
        // A known refusal (a bad or unauthorised request, a missing model, too large, unprocessable, rate limited): the
        // gateway refused the call, which is not billed. Any other 4xx fails closed below.
        if (UNBILLED.has(o.status) && !o.broken) {
          s.failed += 1;
          return;
        }
        if (o.sentError || o.broken || o.overflow || !(o.status >= 200 && o.status < 300)) return failClosed(o.sentError ? "the call failed after it was sent" : o.broken ? "the answer broke off" : o.overflow ? "the answer was too large to read its cost" : `the gateway answered ${o.status}`);
        const { usd, id } = costOf(o.doc, route.family, o.first, o.headerId);
        if (usd !== null) {
          // The gateway's own top-level cost: booked now, so the next call need not wait for the generation's record,
          // which the gateway writes seconds later. The lookup then runs aside, and a larger looked-up cost is booked on
          // top (in the pass still running, else in the next one).
          book(usd);
          if (id) {
            const check = lookup(id).then((looked) => {
              if (looked !== null && looked > usd) bookExtra(looked - usd);
            });
            s.checks.add(check);
            check.finally(() => s.checks.delete(check));
          }
          return;
        }
        // No cost reported: the lookup is the only figure, so the next call waits for it.
        const looked = id ? await lookup(id) : null;
        if (looked === null) return failClosed(id ? "the gateway reported no cost and its generation's record never came" : "the answer named no cost and no generation");
        book(looked);
      } finally {
        free();
      }
    });
    s.pending.add(pricing);
    pricing.finally(() => s.pending.delete(pricing));
  };

  const listen = (srv) => {
    srv.on("upgrade", (_req, sock) => sock.destroy());
    srv.on("connect", (_req, sock) => sock.destroy());
    srv.headersTimeout = 60_000;
    // The whole request, headers and body, within five minutes.
    srv.requestTimeout = 5 * 60_000;
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
      s.pass = { budget: capOn ? Math.max(0, Number(budget) || 0) : null, live, usd: 0, calls: 0, unpriced: 0, capped: false, pings: 0 };
    },
    /**
     * The pass ended: its spend through the key once every call in it is priced (or failed closed), with any spend booked
     * since the last pass ended (a call that finished after it), so every dollar reaches a usage record.
     */
    async endPass() {
      // Ended first: a call still waiting for its turn sees the pass ended and is refused, never sent. What is in flight
      // still books into it.
      const p = s.pass || { usd: 0, calls: 0, unpriced: 0, capped: false, pings: 0 };
      p.ended = true;
      await Promise.allSettled([...s.pending]);
      // The reported costs' lookups: waited for a while (the gateway records a generation within seconds); one still
      // running books its difference into the next pass.
      await Promise.race([Promise.allSettled([...s.checks]), new Promise((r) => setTimeout(r, 15_000).unref())]);
      s.pass = null;
      const late = s.late;
      const lateUnpriced = s.lateUnpriced;
      s.late = 0;
      s.lateUnpriced = 0;
      return { usd: Math.round((p.usd + late) * 1e6) / 1e6, calls: p.calls, unpriced: p.unpriced + lateUnpriced, capped: p.capped, pings: p.pings };
    },
    totals: () => ({ usd: Math.round(s.spent * 1e6) / 1e6, pings: s.pings, calls: s.calls, failed: s.failed, unpriced: s.unpriced, capped: s.capped, failClosed: s.failClosed, refused: { ...s.refused } }),
    async close() {
      await Promise.allSettled([...s.pending, ...s.checks]);
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
 * the relay refused at the cap is over budget, as one the harness stopped at its own cap; so is a pass with a call the
 * relay could not price (fail closed: the stage stops there, and its dollars are a lower bound).
 */
export function addKeySpend(rec, pass) {
  if (!rec || !pass) return rec;
  rec.harnessUsd = rec.usd ?? null;
  rec.workerKeyUsd = pass.usd;
  rec.workerKeyCalls = pass.calls;
  if (pass.usd > 0 || rec.usd !== null) rec.usd = Math.round(((rec.usd ?? 0) + pass.usd) * 1e6) / 1e6;
  if (rec.harnessUsd === null && pass.usd > 0) rec.usdLowerBound = true;
  if (pass.unpriced) {
    rec.usdLowerBound = true;
    rec.workerKeyUnpriced = pass.unpriced;
    rec.budgetExceeded = true;
  }
  if (pass.capped) {
    rec.budgetExceeded = true;
    rec.workerKeyCapped = true;
  }
  return rec;
}
