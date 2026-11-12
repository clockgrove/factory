// The metering relay for an opted-in AI Gateway key (#97). A repository that opts its own gateway key in to the worker's
// shell (lib/worker-secrets.mjs, NAME AI_GATEWAY_API_KEY) no longer hands the key to the sandbox: Factory's stage process
// holds it and runs this relay; the worker's shell gets a per-stage token in AI_GATEWAY_API_KEY and the relay's address
// in FACTORY_GATEWAY_URL. Each call the relay forwards is priced and counted into the Objective's spend (the pass's usage
// record: max_usd, daily_usd, `usd`, the progress line, the scorecard), and the relay refuses calls once the cap is
// reached, so a pipeline's spend through the key is capped live by numbers the model cannot edit.
//
// - Where it listens: a Unix socket (mode 600, or 660 for the agent's group on a runner) in a directory the agent cannot
//   write, and, for Claude Code on a runner, a TCP port on this machine's 127.0.0.1 that Claude Code's sandbox proxy
//   carries (claude-runner.mjs services). Codex's and Copilot's commands reach the socket through a forwarder Factory's
//   bwrap shim starts on the command namespace's own 127.0.0.1 (relay-shim.mjs). The token gates every forwarded call:
//   another local user or process that reaches the socket or the port gets nothing without it.
// - What it forwards: any path, only to GATEWAY_ORIGIN, with the key in place of the token. Never a redirect, an absolute
//   URL, CONNECT or an upgrade. The key's value is cut out of every response it passes back.
// - Pricing: the cost the gateway reports for the call (`providerMetadata.gateway.cost`, which the AI SDK's image, text and
//   decision models return), else the generation's cost looked up with the same key (`/v1/generation?id=`), else the
//   Codex price table for a listed model's tokens (#86). A call whose cost none of these gives is never counted as $0:
//   the relay refuses every later call (fail closed) and the stage's dollars are marked a lower bound. A response that is
//   not 2xx, and GET, HEAD and OPTIONS, are not billed.
// - The cap: calls are forwarded only while a harness pass runs (beginPass/endPass), and only while the pass's spend
//   through the key, plus the largest call so far for each call in flight, is under the pass's budget (what max_usd left
//   when the pass started). The harness's own spend in the running pass counts once the pass reports it.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { CODEX_PRICES, priceTokens } from "./usage.mjs";

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
/** The most of one request the relay reads, and of one response it keeps to price. */
export const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
export const MAX_PRICED_BYTES = 256 * 1024 * 1024;
/** When a generation's cost is looked up again after the call (the gateway records it a little later). */
export const LOOKUP_DELAYS_MS = [1000, 3000, 6000, 12000, 20000, 30000];

const FREE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Request headers never passed on: hop-by-hop, the client's own auth and anything naming where it came from. */
const DROP_REQUEST = new Set(["host", "authorization", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding", "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]);
/** Response headers never passed back: hop-by-hop, and the length and encoding the relay's own copy no longer matches. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "set-cookie", "proxy-authenticate", "upgrade", "trailer"]);

const num = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * What one response says it cost, from its text (JSON, or a server-sent event stream): {usd} when the gateway reported
 * the call's cost, else {generationId} when it named the generation, else {usd} from the Codex price table for a listed
 * model's tokens, else null. The last cost in a stream wins (the finish event carries the call's total).
 */
export function costOf(text, contentType = "") {
  const docs = [];
  if (/event-stream/i.test(contentType)) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        docs.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // not JSON ([DONE], a comment)
      }
    }
  } else {
    try {
      docs.push(JSON.parse(text));
    } catch {
      return null;
    }
  }
  let usd = null;
  let generationId = null;
  let tokens = null;
  const seen = new Set();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 12 || seen.has(o)) return;
    seen.add(o);
    const gw = o.providerMetadata?.gateway ?? o.provider_metadata?.gateway;
    if (gw && typeof gw === "object") {
      if (num(gw.cost) !== null) usd = num(gw.cost);
      if (typeof gw.generationId === "string" && gw.generationId) generationId = gw.generationId;
    }
    if (typeof o.id === "string" && /^gen_[A-Za-z0-9]+$/.test(o.id)) generationId ??= o.id;
    const u = o.usage;
    if (typeof o.model === "string" && u && typeof u === "object") {
      const input = num(u.prompt_tokens ?? u.input_tokens);
      const output = num(u.completion_tokens ?? u.output_tokens);
      const cached = num(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
      if (input !== null || output !== null) tokens = { model: o.model, input, output, cached };
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  for (const d of docs) walk(d);
  if (usd !== null) return { usd };
  if (generationId) return { generationId };
  if (tokens) {
    const priced = priceTokens(CODEX_PRICES, tokens.model, { input: tokens.input, output: tokens.output, cached: tokens.cached, written: null });
    if (priced !== null) return { usd: priced, basis: "table" };
  }
  return null;
}

/** `key` cut out of a byte stream: each occurrence becomes `***`, also one split across two chunks. */
export function keyCutter(key) {
  const k = Buffer.from(String(key), "utf8");
  const mask = Buffer.from("***");
  let carry = Buffer.alloc(0);
  const cut = (buf) => {
    const parts = [];
    let from = 0;
    for (let i = buf.indexOf(k, from); i !== -1; i = buf.indexOf(k, from)) {
      parts.push(buf.subarray(from, i), mask);
      from = i + k.length;
    }
    parts.push(buf.subarray(from));
    return Buffer.concat(parts);
  };
  return {
    push(chunk) {
      const data = cut(Buffer.concat([carry, Buffer.from(chunk)]));
      // A key's start at the end waits for the next chunk.
      const keep = Math.min(data.length, k.length - 1);
      carry = data.subarray(data.length - keep);
      return data.subarray(0, data.length - keep);
    },
    end() {
      const rest = cut(carry);
      carry = Buffer.alloc(0);
      return rest;
    },
  };
}

/** Whether `header` (an Authorization value) is `Bearer <token>`, compared in constant time. */
export function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ""));
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The upstream URL for a request target, or null for anything but an origin-relative path on GATEWAY_ORIGIN. */
export function upstreamUrl(target, origin = GATEWAY_ORIGIN) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || /[\\\s]/.test(target)) return null;
  let u;
  try {
    u = new URL(target, origin);
  } catch {
    return null;
  }
  return u.origin === new URL(origin).origin ? u : null;
}

const refusal = (res, status, message) => {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: { message: `Factory's gateway relay: ${message}`, type: "factory_relay" } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

/**
 * Start the relay for `key`. `dir`: a directory only Factory's user writes, where the socket goes (made 700, or 711 when
 * `group` is given, the agent's group, which then owns the socket at 660 through `chgrp`, an async (path, group) =>
 * void that throws when it cannot). `tcp`: also listen on 127.0.0.1 (Claude Code on a runner). `maxUsd`: the stage's
 * max_usd (0 or less: no cap). Returns the relay: {url, port, tcpPort, socketPath, token, probeId, beginPass(budget),
 * endPass(), totals(), close()}.
 */
export async function openRelay({ key, dir, group = null, chgrp = null, tcp = false, maxUsd = 0, origin = GATEWAY_ORIGIN, fetchImpl = globalThis.fetch, lookupDelaysMs = LOOKUP_DELAYS_MS, log = () => {} }) {
  if (typeof key !== "string" || !key) throw new Error("the relay needs the key");
  const token = `factory-relay-${randomBytes(32).toString("base64url")}`;
  const probeId = randomBytes(12).toString("hex");
  const s = { pings: 0, spent: 0, calls: 0, failed: 0, unpriced: 0, refused: { cap: 0, unpriced: 0, token: 0, pass: 0 }, inflight: 0, maxCall: 0, failClosed: false, capped: false, pass: null, pending: new Set(), said: new Set() };
  const once = (what, line) => {
    if (s.said.has(what)) return;
    s.said.add(what);
    log(line);
  };
  const capOn = Number(maxUsd) > 0;

  const book = (usd, { lowerBound = false } = {}) => {
    s.spent += usd;
    s.maxCall = Math.max(s.maxCall, usd);
    if (s.pass) {
      s.pass.usd += usd;
      s.pass.calls += 1;
      if (lowerBound) s.pass.unpriced += 1;
    }
  };
  const failClosed = (why) => {
    s.unpriced += 1;
    s.failClosed = true;
    if (s.pass) s.pass.unpriced += 1;
    once("unpriced", `gateway relay: a call's cost could not be determined (${why}); every later call is refused and the stage's dollars are a lower bound`);
  };
  const lookup = async (id) => {
    for (const ms of lookupDelaysMs) {
      await new Promise((r) => setTimeout(r, ms).unref());
      try {
        const r = await fetchImpl(`${origin}/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "manual" });
        if (r.ok) {
          const j = await r.json();
          const usd = num(j?.data?.total_cost ?? j?.total_cost);
          if (usd !== null) return usd;
        }
      } catch {
        // tried again below
      }
    }
    return null;
  };

  const handle = async (req, res) => {
    // CONNECT, an absolute URL or a path off the gateway: never forwarded.
    const target = req.method === "CONNECT" ? null : upstreamUrl(req.url, origin);
    if (req.method === "GET" && (req.url === RELAY_PING || req.url === `${RELAY_PING}?shim`)) {
      // A command sandbox's forwarder came up (relay-shim.mjs): counted for the pass, as the shim's proof of life.
      if (req.url.endsWith("?shim")) {
        s.pings += 1;
        if (s.pass) s.pass.pings += 1;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`factory-relay ${probeId}\n`);
    }
    if (!target) return refusal(res, 400, "only a path on the AI Gateway is relayed");
    if (!tokenMatches(req.headers.authorization, token)) {
      s.refused.token += 1;
      return refusal(res, 401, `the request lacks this run's relay token: send the value of ${RELAYED_NAME} as a Bearer token`);
    }
    const free = FREE_METHODS.has(req.method);
    if (!free) {
      if (s.failClosed) {
        s.refused.unpriced += 1;
        return refusal(res, 403, "an earlier call's cost could not be determined, so the Objective's dollar cap cannot be enforced; no further call is relayed in this stage");
      }
      if (!s.pass) {
        s.refused.pass += 1;
        return refusal(res, 403, "calls are relayed only while a Factory pass runs");
      }
      if (s.pass.budget !== null && s.pass.usd + (s.inflight + 1) * s.maxCall >= s.pass.budget && !(s.pass.usd === 0 && s.inflight === 0 && s.pass.budget > 0)) {
        s.refused.cap += 1;
        s.capped = true;
        s.pass.capped = true;
        once("cap", `gateway relay: max_usd reached ($${s.pass.usd.toFixed(4)} through the key this pass, $${s.pass.budget.toFixed(4)} was left); further calls are refused`);
        return refusal(res, 402, `the Objective's max_usd is reached ($${s.pass.usd.toFixed(2)} spent through the key in this pass of the $${s.pass.budget.toFixed(2)} left); no further call is relayed. Stop and report it: the cap is the Objective's`);
      }
    }
    // The request body, whole, before anything is sent.
    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_REQUEST_BYTES) return refusal(res, 413, `a request over ${MAX_REQUEST_BYTES} bytes is not relayed`);
        chunks.push(c);
      }
    } catch {
      return res.destroy();
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST.has(k.toLowerCase()) && !k.toLowerCase().startsWith("proxy-")) headers[k] = v;
    headers.authorization = `Bearer ${key}`;
    headers["accept-encoding"] = "identity";
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    if (!free) {
      s.inflight += 1;
      s.calls += 1;
    }
    let settled = false;
    const settle = () => {
      if (!free && !settled) {
        settled = true;
        s.inflight -= 1;
      }
    };
    let upstream;
    try {
      upstream = await fetchImpl(target, { method: req.method, headers, body: free || !chunks.length ? undefined : Buffer.concat(chunks), redirect: "manual", signal: abort.signal });
    } catch (e) {
      settle();
      // Nothing reached the gateway, or nothing came back: a failed call is not billed.
      if (!free) s.failed += 1;
      return refusal(res, 502, `the AI Gateway could not be reached (${String(e?.cause?.code || e?.name || "error")})`);
    }
    const outHeaders = {};
    for (const [k, v] of upstream.headers) if (!DROP_RESPONSE.has(k.toLowerCase()) && !v.includes(key)) outHeaders[k] = v;
    res.writeHead(upstream.status, outHeaders);
    const cutter = keyCutter(key);
    const kept = [];
    let keptBytes = 0;
    let overflow = false;
    let broken = false;
    try {
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (!free && !overflow) {
            keptBytes += chunk.length;
            if (keptBytes > MAX_PRICED_BYTES) overflow = true;
            else kept.push(Buffer.from(chunk));
          }
          const out = cutter.push(chunk);
          if (out.length) res.write(out);
        }
      }
      res.end(cutter.end());
    } catch {
      broken = true;
      res.destroy();
    }
    if (free) return;
    if (upstream.status < 200 || upstream.status >= 300) {
      settle();
      s.failed += 1;
      return;
    }
    const priced = overflow ? null : costOf(Buffer.concat(kept).toString("utf8"), upstream.headers.get("content-type") || "");
    if (priced?.usd !== undefined) {
      book(priced.usd);
      return settle();
    }
    if (priced?.generationId) {
      const p = lookup(priced.generationId).then((usd) => {
        if (usd === null) failClosed("the gateway reported no cost for its generation");
        else book(usd);
        settle();
      });
      s.pending.add(p);
      p.finally(() => s.pending.delete(p));
      return;
    }
    settle();
    failClosed(overflow ? "the response was too large to read its cost" : broken ? "the response broke off" : "the response named no cost and no generation");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => refusal(res, 500, "the call failed in the relay"));
  });
  // No upgrade (websockets) and no CONNECT: refused by closing.
  server.on("upgrade", (_req, sock) => sock.destroy());
  server.on("connect", (_req, sock) => sock.destroy());
  server.headersTimeout = 60_000;
  server.requestTimeout = 0;

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
    tcpServer = http.createServer((req, res) => {
      handle(req, res).catch(() => refusal(res, 500, "the call failed in the relay"));
    });
    tcpServer.on("upgrade", (_req, sock) => sock.destroy());
    tcpServer.on("connect", (_req, sock) => sock.destroy());
    await new Promise((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(0, "127.0.0.1", resolve);
    });
    tcpPort = tcpServer.address().port;
  }
  // The port the worker's shell names: the TCP one Claude Code's proxy carries, else one for the forwarder in each
  // command namespace (its own loopback, empty but for what the command starts).
  const port = tcpPort ?? randomInt(20000, 60000);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    tcpPort,
    socketPath,
    token,
    probeId,
    /** A harness pass starts: calls are relayed while the key's spend in it stays under `budget` (null: no cap). */
    beginPass(budget) {
      s.pass = { budget: capOn ? Math.max(0, Number(budget) || 0) : null, usd: 0, calls: 0, unpriced: 0, capped: false, pings: 0 };
    },
    /** The pass ended: its spend through the key once every call in it is priced (or failed closed). */
    async endPass() {
      // Calls still in flight (a pipeline the harness left running is reaped with it) settle first, then their pricing.
      for (let i = 0; i < 1200 && s.inflight > s.pending.size; i++) await new Promise((r) => setTimeout(r, 100));
      await Promise.allSettled([...s.pending]);
      const p = s.pass || { usd: 0, calls: 0, unpriced: 0, capped: false, pings: 0 };
      s.pass = null;
      return { usd: Math.round(p.usd * 1e6) / 1e6, calls: p.calls, unpriced: p.unpriced, capped: p.capped, pings: p.pings };
    },
    totals: () => ({ usd: Math.round(s.spent * 1e6) / 1e6, pings: s.pings, calls: s.calls, failed: s.failed, unpriced: s.unpriced, capped: s.capped, failClosed: s.failClosed, refused: { ...s.refused } }),
    async close() {
      await Promise.allSettled([...s.pending]);
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
 * the relay refused at the cap is over budget, as one the harness stopped at its own cap; a call it could not price
 * leaves the dollars a lower bound.
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
  }
  if (pass.capped) {
    rec.budgetExceeded = true;
    rec.workerKeyCapped = true;
  }
  return rec;
}
