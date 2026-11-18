import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after as afterAll, test } from "node:test";
import { MAX_WAITING, CALL_LOG, UNIX_SOCKET_PATH_MAX, EDITS_MAX_BYTES, UPSTREAM_KEEPALIVE_MS, upstreamRequest, RELAYED_NAME, RELAY_PING, addKeySpend, costOf, gatewayRefusalOf, keyCutter, modelOf, openRelay, routeOf, stageBlockReason, tokenMatches, withGatewayRefusal } from "../scripts/lib/gateway-relay.mjs";
import { relayProbeCommand, relayShimScript, writeRelayShim } from "../scripts/lib/relay-shim.mjs";
import { RELAY_SOCKET_DIR_ENV, RELAY_SOCKET_ROOT, SOCKET_DIR_RECORD, checkSocketRoot, closeWorkerRelay, dropSocketDir, handSocketDir, localRelayDir, makeSocketDir, openWorkerRelay, readSocketDirRecord, relaySocketDir, unrelayedGatewayKeys } from "../scripts/lib/worker-relay.mjs";
import { STAGE_RECORD, reapSocketDirs, relaysGatewayKey } from "../scripts/local.mjs";
import { processRecord } from "../scripts/lib/proc.mjs";
import { refusingOrigin, unhandedPort } from "./ports.mjs";
import { keyBreakdown, maskFile, writeUsage } from "../scripts/lib/session.mjs";
import { usdText } from "../scripts/lib/logic.mjs";
import { harnessOuterSettings } from "../scripts/lib/local.mjs";
import { secretForms } from "../scripts/lib/inputs.mjs";
import { costOf as benchCostOf } from "../../bench/lib/cost.mjs";
import { CODEX_PRICES } from "../scripts/lib/usage.mjs";

/** Six calls: more than one client's retries through a blip. */
const SIX = 6;
const KEY = "vck_worker_relay_0123456789abcdef";
const IMAGE = "/v4/ai/image-model";

/** Stand-in gateways not closed yet. A test that throws before its `gw.close()` (openRelay refusing a socket path over the
 * system's limit, under a long TMPDIR) would leave one listening and keep the file's process alive after its last test. */
const openGateways = new Set();
afterAll(() => {
  for (const server of openGateways) {
    server.closeAllConnections();
    server.close();
  }
});

/**
 * A stand-in AI Gateway on this machine's loopback: each path answers as `routes` says (a function gets the request's
 * body and may wait); every request is recorded.
 */
async function fakeGateway(routes) {
  const seen = [];
  const table = new Map(Object.entries(routes));
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const raw = Buffer.concat(parts);
    const body = raw.toString("utf8");
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, raw, headers: req.headers });
    // Only the routes this test named (a Map: no inherited name is ever looked up).
    const route = table.get(req.url.split("?")[0]);
    // As the real gateway: an image edit's body must parse as its content-type says (multipart by its own boundary, with
    // the model and at least one PNG; or JSON with image URLs), or it is refused (400) before any route answers.
    if (req.url.split("?")[0] === "/v1/images/edits") {
      const why = await editProblem(raw, req.headers["content-type"]);
      if (why) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: why, type: "invalid_request_error" } }));
      }
    }
    // As the real gateway: a model call without its model header is refused (400), before any route answers.
    const kind = /^\/v\d+\/ai\/([a-z]+)-model$/.exec(req.url.split("?")[0])?.[1];
    if (kind && !req.headers[kind === "language" ? "ai-language-model-id" : "ai-model-id"]) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Missing or empty model identifier", type: "invalid_request_error" } }));
    }
    const r = typeof route === "function" ? await route(body, req) : route || { status: 404, body: { error: "no route" } };
    res.writeHead(r.status ?? 200, { "content-type": r.type || "application/json", ...(r.headers || {}) });
    // `drop`: the connection is cut mid-answer, after its first bytes.
    if (r.drop) {
      res.write(r.drop);
      return setTimeout(() => res.socket.destroy(), 20);
    }
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  openGateways.add(server);
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => (openGateways.delete(server), new Promise((r) => server.close(r))) };
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Why the stand-in gateway refuses an image edit's body, or null: it parses as its content-type says. */
async function editProblem(raw, type = "") {
  if (/^multipart\/form-data;\s*boundary=/i.test(type)) {
    let form;
    try {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
    } catch {
      return "the multipart body does not parse with its boundary";
    }
    const images = [...form.getAll("image[]"), ...form.getAll("image")].filter((f) => typeof f === "object");
    const pngs = await Promise.all(images.map(async (f) => Buffer.from(await f.arrayBuffer()).subarray(0, 8).equals(PNG)));
    return form.get("model") && pngs.length && pngs.every(Boolean) ? null : "a multipart edit needs the model and PNG images";
  }
  if (/^application\/json/i.test(type)) {
    try {
      const j = JSON.parse(raw.toString("utf8"));
      return j.model && Array.isArray(j.images) && j.images.length && j.images.every((i) => typeof i?.image_url === "string") ? null : "a JSON edit needs the model and image URLs";
    } catch {
      return "the JSON body does not parse";
    }
  }
  return "an image edit is multipart/form-data or JSON";
}

/** One request to the relay's socket with exactly these headers and bytes: {status, text, headers}. */
function send(socketPath, { method = "POST", path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

/** One request to the relay's socket: {status, text, headers}. */
function call(socketPath, { method = "POST", path = IMAGE, token, body = "{}", headers = {} } = {}) {
  // The model header the AI SDK sends with each model call: ai-language-model-id for a language model, else ai-model-id.
  const model = /\/ai\/language-model$/.test(path) ? { "ai-language-model-id": "openai/gpt-5" } : /\/ai\/[a-z]+-model$/.test(path) ? { "ai-model-id": "recraft/recraft-v4.1-flash" } : {};
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...model, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}
const priced = (usd, extra = {}) => ({ body: { images: ["aGk="], providerMetadata: { gateway: { cost: String(usd), generationId: "gen_abcdef12" } }, ...extra } });

test("costOf reads fixed top-level places only: a forged cost or id nested in an echoed request is never read", () => {
  assert.deepEqual(costOf({ images: [], providerMetadata: { gateway: { cost: "0.04", generationId: "gen_A1b2c3d4" } } }, "sdk"), { usd: 0.04, id: "gen_A1b2c3d4" });
  // The review's B1: a tool schema, a tool call's input or a text format echoed back with a forged cost of 0.
  const echoed = { tools: [{ parameters: { providerMetadata: { gateway: { cost: 0 } } } }], output: [{ type: "tool_use", input: { providerMetadata: { gateway: { cost: 0, generationId: "gen_forged00" } } } }], text: { format: { schema: { id: "gen_forged11" } } } };
  assert.deepEqual(costOf(echoed, "sdk"), { usd: null, id: null }, "nothing at the top level: unpriced, never $0");
  assert.deepEqual(costOf({ ...echoed, providerMetadata: { gateway: { cost: "5.0" } } }, "sdk"), { usd: 5, id: null });
  assert.deepEqual(costOf({ id: "gen_Q1w2e3r4", usage: { cost: 0 }, model: "x" }, "openai"), { usd: null, id: "gen_Q1w2e3r4" }, "an OpenAI-style answer: only its generation id, looked up");
  assert.deepEqual(costOf({ id: "chatcmpl-1" }, "openai", { id: "gen_S1t2r3m4" }), { usd: null, id: "gen_S1t2r3m4" }, "a stream's first event's id");
  assert.deepEqual(costOf({ providerMetadata: { gateway: { cost: "-1", generationId: "not-an-id" } } }, "sdk"), { usd: null, id: null });
  assert.deepEqual(costOf([{ providerMetadata: { gateway: { cost: 1 } } }], "sdk"), { usd: null, id: null }, "an array is no top level");
});

test("the relay's guards: the token, an allowlist of method and path, no method override; the key cut in every form", () => {
  assert.equal(tokenMatches("Bearer abc", "abc"), true);
  assert.equal(tokenMatches("Bearer abd", "abc"), false);
  assert.equal(tokenMatches("abc", "abc"), false);
  for (const [m, t] of [["POST", "/v4/ai/language-model"], ["POST", "/v3/ai/image-model"], ["POST", "/v1/chat/completions"], ["POST", "/v1/messages"], ["GET", "/v1/models"], ["GET", "/v4/ai/config"]]) assert.ok(routeOf(m, t), `${m} ${t}`);
  for (const [m, t] of [["GET", "/v1/credits"], ["GET", "/v1/generation"], ["POST", "/v1/generation"], ["GET", "/v4/ai/image-model"], ["PUT", "/v4/ai/image-model"], ["TRACE", "/v1/models"], ["POST", "/v4/ai/image-model?x=1"], ["POST", "/v4/ai/video-model"], ["POST", "//evil.example/v4/ai/image-model"], ["POST", "http://evil.example/v4/ai/image-model"], ["POST", "/v4/ai/../../v1/credits"], ["GET", "/v1/report"]]) assert.equal(routeOf(m, t), null, `${m} ${t}`);
  const c = keyCutter(KEY);
  const b64 = Buffer.from(`x${KEY}y`).toString("base64");
  const out = Buffer.concat([c.push(`one ${KEY.slice(0, 9)}`), c.push(`${KEY.slice(9)} two ${encodeURIComponent(KEY)} ${b64}`), c.end()]).toString();
  assert.ok(!out.includes(KEY) && secretForms(KEY).every((f) => !out.includes(f)), out);
  assert.ok(c.carries(`Bearer ${Buffer.from(KEY).toString("base64")}`));
});

test("relay: the key in the token's place, allowlisted headers both ways; refused without the token, off the allowlist, outside a pass", async () => {
  const gw = await fakeGateway({
    [IMAGE]: priced(0.04, {}),
    "/v4/ai/echo-key": { body: {} },
    "/v1/models": { body: { data: [] }, headers: { "x-echo": KEY, "set-cookie": "a=b", "x-vercel-id": "iad1::abc" } },
    "/v1/generation": { body: { data: { total_cost: 0.04 } } },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const relay = await openRelay({ key: KEY, dir: join(dir, "r"), maxUsd: 10, origin: gw.origin, lookupDelaysMs: [5] });
  try {
    assert.equal(statSync(relay.socketPath).mode & 0o777, 0o600, "the socket is the owner's alone");
    assert.equal((await call(relay.socketPath, {})).status, 401);
    assert.equal((await call(relay.socketPath, { token: `${relay.token}x` })).status, 401);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 403, "outside a pass");
    assert.equal((await call(relay.socketPath, { token: relay.token, method: "GET", path: "/v1/models" })).status, 403, "the model list too, outside a pass");
    assert.equal((await call(relay.socketPath, { method: "GET", path: RELAY_PING })).text.trim(), `pendulum-relay ${relay.probeId}`);
    relay.beginPass(1);
    for (const [method, path, headers] of [["GET", "/v1/credits"], ["GET", "/v1/generation?id=gen_x"], ["POST", "/v4/ai/echo-key"], ["TRACE", "/v1/models"], ["GET", "/v1/models", { "x-http-method-override": "POST" }]]) assert.equal((await call(relay.socketPath, { token: relay.token, method, path, headers })).status, 403, `${method} ${path}`);
    assert.equal(gw.seen.length, 0, "nothing reached the gateway");
    const img = await call(relay.socketPath, { token: relay.token, body: '{"prompt":"a raccoon"}', headers: { "x-forwarded-for": "1.2.3.4", cookie: "c=d", "ai-model-id": "recraft/recraft-v4.1-flash", "x-vercel-ai-gateway-team": "t" } });
    assert.equal(img.status, 200);
    const sent = gw.seen.at(-2) || gw.seen.at(-1);
    const up = gw.seen.find((r) => r.url === IMAGE);
    assert.equal(up.auth, `Bearer ${KEY}`, "the gateway gets the key");
    assert.equal(up.body, '{"prompt":"a raccoon"}');
    assert.deepEqual(Object.keys(up.headers).filter((h) => ["x-forwarded-for", "cookie", "x-vercel-ai-gateway-team"].includes(h)), [], "only allowlisted request headers");
    assert.equal(up.headers["ai-model-id"], "recraft/recraft-v4.1-flash");
    const list = await call(relay.socketPath, { token: relay.token, method: "GET", path: "/v1/models" });
    assert.deepEqual([list.headers["x-echo"], list.headers["set-cookie"], list.headers["x-vercel-id"]], [undefined, undefined, "iad1::abc"], "only allowlisted response headers");
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls], [0.04, 1], "the model list is free; the image is booked");
    assert.ok(sent);
  } finally {
    await relay.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay pricing: the larger of reported and looked up; a forged echo, an unknown cost, a 5xx or a hang-up is unknown or fails closed, never $0", async () => {
  let release = null;
  const gw = await fakeGateway({
    // The real cost at the top level, a forged $0 echoed from the request (B1).
    [IMAGE]: (body) => ({ body: { providerMetadata: { gateway: { cost: "0.5", generationId: "gen_abcdef12" } }, tools: JSON.parse(body || "{}").tools } }),
    "/v4/ai/language-model": { body: { content: [{ type: "tool-call", input: '{"providerMetadata":{"gateway":{"cost":0}}}' }], providerMetadata: { gateway: { cost: "0.1", generationId: "gen_lookup01" } } } },
    "/v1/chat/completions": { body: { id: "gen_compat01", choices: [], usage: { prompt_tokens: 1, cost: 0 } } },
    "/v4/ai/decision-model": { body: { answers: {}, providerMetadata: { forged: true } } },
    "/v4/ai/embedding-model": { status: 500, body: { error: "upstream" } },
    "/v4/ai/reranking-model": () => new Promise((r) => (release = () => r({ body: { providerMetadata: { gateway: { cost: "0.3" } } } }))),
    "/v1/generation": (_b, req) => ({ body: { data: { total_cost: req.url.includes("gen_lookup01") ? 0.25 : req.url.includes("gen_compat01") ? 0.02 : 0.5 } } }),
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-price-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [5] });
    relay.beginPass(100);
    await call(relay.socketPath, { token: relay.token, body: JSON.stringify({ tools: [{ parameters: { providerMetadata: { gateway: { cost: 0 } } } }] }) });
    await call(relay.socketPath, { token: relay.token, path: "/v4/ai/language-model" });
    await call(relay.socketPath, { token: relay.token, path: "/v1/chat/completions" });
    let pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls], [0.77, 3], "0.5 (reported, looked up 0.5) + 0.25 (looked up over 0.1) + 0.02 (looked up)");
    relay.beginPass(100);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/decision-model" })).status, 200);
    pass = await relay.endPass();
    // A complete answer with no cost at the top level and no generation: it was billed, so it is a call of unknown cost:
    // nothing added to the dollars, and the pass and the stage go on (#483).
    assert.deepEqual([pass.unknown, pass.usd], [1, 0]);
    const rec = addKeySpend({ usd: 1, tokens: {} }, pass);
    assert.deepEqual([rec.budgetExceeded, rec.usd, rec.usdUnknown, rec.usdUnknownWhy], [undefined, 1, 1, ["relay"]], "the pass is not over budget for it");
    relay.beginPass(100);
    assert.notEqual((await call(relay.socketPath, { token: relay.token })).status, 403, "later calls are relayed");
    assert.notEqual((await call(relay.socketPath, { token: relay.token, method: "GET", path: "/v1/models" })).status, 403, "the model list too");
    await relay.endPass();
    await relay.close();
    // A 5xx after the call was sent, naming no generation: a call of unknown cost, never $0 and never an estimate.
    const r5 = await openRelay({ key: KEY, dir: join(dir, "b"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [5] });
    r5.beginPass(100);
    assert.equal((await call(r5.socketPath, { token: r5.token, path: "/v4/ai/embedding-model" })).status, 500);
    const p5 = await r5.endPass();
    assert.deepEqual([p5.unknown, p5.usd, p5.calls], [1, 0, 1]);
    await r5.close();
    // A client that hangs up after sending: the call runs to its end and is booked (M3).
    const rh = await openRelay({ key: KEY, dir: join(dir, "c"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [5] });
    rh.beginPass(100);
    await new Promise((resolve) => {
      const req = http.request({ socketPath: rh.socketPath, method: "POST", path: "/v4/ai/reranking-model", headers: { authorization: `Bearer ${rh.token}`, "ai-model-id": "cohere/rerank-v3.5" } }, () => {});
      req.on("error", () => resolve());
      req.end("{}");
      setTimeout(() => {
        req.destroy();
        setTimeout(() => {
          release();
          resolve();
        }, 50);
      }, 100);
    });
    const hung = await rh.endPass();
    assert.deepEqual([hung.usd, hung.calls], [0.3, 1], "booked when it finished, though the client had gone");
    await rh.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay cap: billable calls one at a time, each checked once the one before is priced; parallel calls pass the cap by one call at most (B2)", async () => {
  let inflight = 0;
  let most = 0;
  const gw = await fakeGateway({
    [IMAGE]: async () => {
      inflight += 1;
      most = Math.max(most, inflight);
      await new Promise((r) => setTimeout(r, 40));
      inflight -= 1;
      return priced(1);
    },
    "/v1/generation": { body: { data: { total_cost: 1 } } },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-cap-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 5, origin: gw.origin, lookupDelaysMs: [1] });
    relay.beginPass(2);
    const statuses = await Promise.all(Array.from({ length: 20 }, () => call(relay.socketPath, { token: relay.token }).then((r) => r.status)));
    const pass = await relay.endPass();
    assert.equal(most, 1, "never two billable calls in flight");
    assert.deepEqual([statuses.filter((x) => x === 200).length, statuses.filter((x) => x === 402 || x === 429).length], [2, 18], "8 wait their turn and are refused at the cap; the rest are turned away (429)");
    assert.deepEqual([pass.usd, pass.calls, pass.capped], [2, 2, true], "$2 of a $2 budget: at most one call past it");
    relay.beginPass(0);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 402, "nothing left: nothing relayed");
    await relay.endPass();
    await relay.close();
    // No max_usd: no cap, and calls run side by side.
    most = 0;
    const free = await openRelay({ key: KEY, dir: join(dir, "b"), maxUsd: 0, origin: gw.origin, lookupDelaysMs: [1] });
    free.beginPass(0);
    await Promise.all(Array.from({ length: 4 }, () => call(free.socketPath, { token: free.token })));
    assert.equal((await free.endPass()).usd, 4);
    assert.ok(most > 1);
    await free.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay: the key never comes back, in any form, in a body or a header", async () => {
  const gw = await fakeGateway({
    [IMAGE]: (_b, req) => ({ body: { note: `${req.headers.authorization} ${Buffer.from(req.headers.authorization).toString("base64")} ${encodeURIComponent(KEY)}`, providerMetadata: { gateway: { cost: "0.01" } } }, headers: { "x-request-id": KEY, "retry-after": Buffer.from(KEY).toString("base64") } }),
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-key-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 1, origin: gw.origin });
    relay.beginPass(1);
    const r = await call(relay.socketPath, { token: relay.token });
    const all = `${r.text} ${JSON.stringify(r.headers)}`;
    assert.ok(![KEY, ...secretForms(KEY)].some((f) => all.includes(f)), all);
    await relay.endPass();
    await relay.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pass's key spend joins its record: usd, max_usd and daily_usd count it; the usage record and the progress line break it out", () => {
  const rec = addKeySpend({ usd: 1.5, tokens: {} }, { usd: 0.8, calls: 2, capped: true });
  assert.deepEqual([rec.usd, rec.harnessUsd, rec.workerKeyUsd, rec.budgetExceeded], [2.3, 1.5, 0.8, true]);
  const unknown = addKeySpend({ usd: null, tokens: {} }, { usd: 0.2, calls: 2, unknown: 1, capped: false });
  assert.deepEqual([unknown.usd, unknown.usdUnknown, unknown.usdUnknownWhy, unknown.workerKeyUnknown, unknown.budgetExceeded], [0.2, 1, ["relay"], 1, undefined]);
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  try {
    const records = [{ harness: "claude", model: "m", usd: 2.3, harnessUsd: 1.5, workerKeyUsd: 0.8, tokens: { input: 1, output: 1, cached: 0 }, started: "a", ended: "b" }];
    const usage = writeUsage(dir, { harness: "claude", model: "m", records, passes: 1, exit: "delivered", reason: "", credentialBasis: "x", workerKey: { usd: 0.9, calls: 3, failed: 0, capped: false, refused: { cap: 0 } } });
    assert.deepEqual([usage.usd, usage.workerKeyUsd, usage.harnessUsd], [2.4, 0.9, 1.5], "a call booked outside every pass still counts");
    assert.equal(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).workerKey.calls, 3);
    assert.equal(usdText(usage), "2.4; harness 1.5, worker key 0.9");
    assert.deepEqual(keyBreakdown([{ usd: 1 }]), { fields: {}, extra: 0 }, "no relay, no fields");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The scorecard: Codex's repriced dollars keep the key's spend, and the row names it.
  const row = benchCostOf([{ harness: "codex", model: "gpt-5", tokens: { input: 1_000_000, output: 0, cached: 0 }, workerKeyUsd: 0.5, artifact: "pendulum-usage-1" }], CODEX_PRICES);
  assert.equal(row.usd, Math.round((CODEX_PRICES.perMillion["gpt-5"].input + 0.5) * 1e4) / 1e4);
  assert.equal(row.workerKeyUsd, 0.5);
});

test("the shim wraps only a command sandbox: --unshare-net before the separator, options walked by their arity, bash -p", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-shim-"));
  try {
    // A stand-in bwrap that prints what it was asked to run.
    const fake = join(dir, "real-bwrap");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const shimDir = writeRelayShim(join(dir, "bin"), { bwrap: fake, socat: "/usr/bin/socat", socket: "/run/x/relay.sock", port: 41234 });
    assert.equal(statSync(shimDir).mode & 0o777, 0o755);
    const shim = readFileSync(join(shimDir, "bwrap"), "utf8");
    assert.match(shim.split("\n")[0], /^#!\/bin\/bash -p$/, "no BASH_ENV or ENV is read");
    const run = (...a) => execFileSync(join(shimDir, "bwrap"), a, { encoding: "utf8", env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", BASH_ENV: join(dir, "planted") } }).trim().split("\n");
    writeFileSync(join(dir, "planted"), "echo PLANTED\n");
    assert.deepEqual(run("--version"), ["--version"]);
    assert.deepEqual(run("--ro-bind", "/", "/", "--", "/usr/bin/true"), ["--ro-bind", "/", "/", "--", "/usr/bin/true"], "no network namespace: as given");
    // An option's value that reads `--unshare-net` or `--` is a value (the review's minor 11).
    assert.deepEqual(run("--setenv", "X", "--unshare-net", "--", "/usr/bin/true"), ["--setenv", "X", "--unshare-net", "--", "/usr/bin/true"]);
    assert.deepEqual(run("--setenv", "X", "--", "--unshare-net", "--", "/c").slice(0, 8), ["--setenv", "X", "--", "--unshare-net", "--", "/bin/bash", "-p", "-c"], "`--` as --setenv's value is no separator: the real one follows --unshare-net");
    assert.deepEqual(run("--ro-bind", "/", "/", "--", "--unshare-net"), ["--ro-bind", "/", "/", "--", "--unshare-net"], "after the separator: the command's own argument");
    assert.deepEqual(run("--some-new-option", "--unshare-net", "--", "/c"), ["--some-new-option", "--unshare-net", "--", "/c"], "an option it does not know: as given");
    const wrapped = run("--unshare-net", "--setenv", "A", "--", "--argv0", "codex-linux-sandbox", "--", "/opt/codex", "--x");
    const sep = wrapped.indexOf("--", 4);
    assert.deepEqual(wrapped.slice(0, sep + 4), ["--unshare-net", "--setenv", "A", "--", "--argv0", "codex-linux-sandbox", "--", "/bin/bash", "-p", "-c"]);
    assert.deepEqual(wrapped.slice(-7), ["bash", "/run/x/relay.sock", "41234", "/usr/bin/socat", "codex-linux-sandbox", "/opt/codex", "--x"], "the relay's place, the argv0, then the command");
    assert.ok(!wrapped.join("\n").includes("PLANTED"), "BASH_ENV was not read");
    execFileSync("bash", ["-n", join(shimDir, "bwrap")]);
    assert.throws(() => relayShimScript({ bwrap: "bwrap", socat: "/usr/bin/socat", socket: "/s", port: 41234 }), /absolute/);
    assert.match(relayProbeCommand(41234, "abc"), /pendulum-relay abc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gateway-shaped key under another name, or AI_GATEWAY_API_KEY in another case, is withheld; the key stays in the mask list", async () => {
  assert.deepEqual(unrelayedGatewayKeys({ AI_GATEWAY_API_KEY: KEY, ai_gateway_api_key: "x", IMAGE_KEY: "VCK_abc", FAL_KEY: "fal-1" }), ["ai_gateway_api_key", "IMAGE_KEY"]);
  const r = await openWorkerRelay({ inputs: { harness: "claude", maxUsd: 1 }, shell: { IMAGE_KEY: "vck_other_0123456789", FAL_KEY: "fal-1" }, usageDir: "/nope" });
  assert.deepEqual(r.shell, { FAL_KEY: "fal-1" });
  assert.deepEqual(r.masked, ["vck_other_0123456789"]);
  const { gatewayRelayChecks } = await import("../scripts/doctor.mjs");
  const warn = gatewayRelayChecks({ inputs: { workerSecrets: "IMAGE_KEY=S", workerSecretValues: "S=vck_other_0123456789", harness: "claude" }, env: { GITHUB_ACTIONS: "true" } });
  assert.deepEqual(warn.map((c) => c.status), ["WARN"]);
  assert.match(warn[0].detail, /IMAGE_KEY: an AI Gateway key under a name other than AI_GATEWAY_API_KEY/);
  assert.ok(!JSON.stringify(warn).includes("vck_other"));
});

test("worker relay: a machine without socat Blocks with the key out of the shell; no relayed key, no relay", async () => {
  const shell = { [RELAYED_NAME]: KEY, FAL_KEY: "fal-0123456789" };
  const none = await openWorkerRelay({ inputs: { harness: "claude", maxUsd: 5 }, shell: { FAL_KEY: "f" }, usageDir: "/nope" });
  assert.deepEqual([none.relay, none.blocked, none.shell], [null, null, { FAL_KEY: "f" }]);
  const noSocat = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: "/nope", env: { PENDULUM_LOCAL: "1", PATH: "/nope" }, which: (n) => (n === "bwrap" ? "/usr/bin/bwrap" : null) });
  assert.match(noSocat.blocked, /needs socat/);
  assert.ok(!(RELAYED_NAME in noSocat.shell));
  assert.deepEqual(noSocat.masked, [KEY], "the key stays in the stage's mask list");
});

test("local mode: the outer sandbox keeps the relay socket's directory reachable (never writable), and hides another stage's socket", { skip: process.platform !== "linux" && "reads /proc/net/unix" }, async () => {
  const root = mkdtempSync(join(realpathSync("/tmp"), "fxr-"));
  const servers = [];
  try {
    // Two stages' sockets, bound: this stage's directory is kept; the other's socket is hidden, as any host socket is.
    const [mine, other] = ["a", "b"].map((u) => makeSocketDir(relaySocketDir(`/u/${u}`, { root })));
    for (const d of [mine, other]) {
      const srv = net.createServer();
      await new Promise((r) => srv.listen(join(d, "relay-x.sock"), r));
      servers.push(srv);
    }
    const s = harnessOuterSettings({ harness: "codex", writable: ["/w"], relaySocketDir: mine, env: {} });
    assert.ok(!s.filesystem.denyRead.some((p) => join(mine, "relay-x.sock").startsWith(p)), "this stage's socket stays reachable");
    assert.ok(s.filesystem.denyRead.includes(join(other, "relay-x.sock")), "another stage's socket is hidden");
    assert.ok(!s.filesystem.allowWrite.some((p) => mine.startsWith(p)), "never writable");
  } finally {
    for (const srv of servers) await new Promise((r) => srv.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the relay's socket goes in a short directory of the stage's own: made 700 in a 700 parent of this user's, a link, a file or a directory open to others refused; a path over the limit Blocks with that reason (#182)", async () => {
  // Its place: /tmp/pendulum-relay-<uid>/<12 hex of the usage directory>, the same however long the usage directory is.
  const uid = process.getuid();
  const long = join("/home/someone/projects/an-adopter-with-a-long-checkout-path", ".pendulum", "81", "usage-review-2026-11-13T05-00-00-000Z");
  assert.match(relaySocketDir(long), new RegExp(`^${realpathSync(RELAY_SOCKET_ROOT)}/pendulum-relay-${uid}/[0-9a-f]{12}$`));
  assert.equal(relaySocketDir(long), relaySocketDir(`${long}/`), "one directory per usage directory");
  assert.notEqual(relaySocketDir(long), relaySocketDir(`${long}x`));
  assert.ok(Buffer.byteLength(join(relaySocketDir(long), "relay-0123456789ab.sock")) <= UNIX_SOCKET_PATH_MAX);
  assert.ok(Buffer.byteLength(join(localRelayDir(long), "relay-0123456789ab.sock")) > UNIX_SOCKET_PATH_MAX, "where the socket was, this path is over the limit");

  const root = mkdtempSync(join(realpathSync("/tmp"), "fxr-"));
  try {
    const dir = relaySocketDir("/u/x", { root });
    assert.equal(makeSocketDir(dir), dir);
    for (const d of [dirname(dir), dir]) assert.equal(statSync(d).mode & 0o777, 0o700);
    assert.equal(makeSocketDir(dir), dir, "this user's own, made before: used");
    // The parent open to others, a link, a file: refused, never used.
    chmodSync(dirname(dir), 0o755);
    assert.throws(() => makeSocketDir(dir), /pendulum-relay-\d+ is open to other users \(mode 755\)/);
    rmSync(dirname(dir), { recursive: true, force: true });
    mkdirSync(join(root, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(root, "elsewhere"), dirname(dir));
    assert.throws(() => makeSocketDir(dir), /is not a directory \(a link or a file stands there\)/);
    rmSync(dirname(dir), { force: true });
    writeFileSync(dirname(dir), "x");
    assert.throws(() => makeSocketDir(dir), /is not a directory/);
    rmSync(dirname(dir), { force: true });

    // A socket path still over the limit: the stage Blocks before the run, naming the limit, with nothing left behind.
    // A stand-in for /tmp: sticky, and its owner taken for root's (socketRootUid).
    const deep = join(root, "d".repeat(80));
    mkdirSync(deep, { mode: 0o1700 });
    chmodSync(deep, 0o1700);
    const shell = { [RELAYED_NAME]: KEY };
    const r = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: join(root, "u"), env: { PENDULUM_LOCAL: "1", PATH: "/nope" }, which: (n) => `/usr/bin/${n}`, socketRoot: deep, socketRootUid: uid });
    assert.equal(r.relay, null);
    assert.match(r.blocked, new RegExp(`^the gateway relay for ${RELAYED_NAME} could not start: its socket's path would be \\d+ bytes, over this system's limit of ${UNIX_SOCKET_PATH_MAX} for a Unix socket`));
    assert.ok(!(RELAYED_NAME in r.shell), "the key is out of the shell");
    assert.ok(!existsSync(relaySocketDir(join(root, "u"), { root: deep })), "its directory removed");
    await assert.rejects(openRelay({ key: KEY, dir: join(root, "x".repeat(120)) }), /its socket's path would be \d+ bytes, over this system's limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long checkout path: the relay starts, a call through Pendulum's forwarder in a command's sandbox is relayed, and the socket's directory goes with the stage (#182)", { skip: (!existsSync("/usr/bin/socat") && "needs socat") || (process.platform === "win32" && "unix") }, async () => {
  const gw = await fakeGateway({ [IMAGE]: priced(0.04), "/v1/generation": { body: { data: { total_cost: 0.04 } } } });
  const root = mkdtempSync(join(realpathSync("/tmp"), "fxr-"));
  const dir = mkdtempSync(join(tmpdir(), "relay-long-"));
  // A bubblewrap stand-in: runs what follows the options' separator, in this namespace (the forwarder, then the command).
  const fake = join(dir, "fake-bwrap");
  writeFileSync(fake, '#!/bin/bash\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  // The checkout an adopter's run had, and longer: the old socket's path would have been over the limit.
  const usageDir = join(dir, "an-adopter-whose-checkout-path-is-long", ".pendulum", "81", "usage-review-2026-11-13T05-00-00-000Z");
  assert.ok(Buffer.byteLength(join(localRelayDir(usageDir), "relay-0123456789ab.sock")) > UNIX_SOCKET_PATH_MAX);
  const shell = { [RELAYED_NAME]: KEY };
  // The stand-in shares this machine's network, where the relay's pick for a namespace of the command's own could be a
  // port another process holds (the forwarder then cannot listen and the call fails): one no process is handed instead,
  // reserved against every other run of this test until it ends.
  const { port, release } = await unhandedPort();
  const open = async (o) => Object.assign(await openRelay({ ...o, origin: gw.origin, lookupDelaysMs: [1] }), { port, url: `http://127.0.0.1:${port}` });
  let opened = null;
  try {
    chmodSync(root, 0o1700);
    opened = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir, env: { PENDULUM_LOCAL: "1", PATH: "/nope" }, which: (n) => (n === "bwrap" ? fake : "/usr/bin/socat"), open, socketRoot: root, socketRootUid: process.getuid() });
    assert.equal(opened.blocked, null, opened.blocked);
    const relay = opened.relay;
    assert.equal(dirname(relay.socketPath), relaySocketDir(usageDir, { root }));
    assert.ok(Buffer.byteLength(relay.socketPath) <= UNIX_SOCKET_PATH_MAX);
    assert.equal(statSync(relay.socketPath).mode & 0o777, 0o600);
    assert.equal(relay.dir, localRelayDir(usageDir), "the shims stay in the usage directory");
    relay.beginPass(5);
    // A command in a sandbox with its own network: Pendulum's shim starts the forwarder before it, and its call to the
    // relay's address carries the run's token, never the key.
    const script = `fetch(process.env.PENDULUM_GATEWAY_URL + "${IMAGE}", { method: "POST", headers: { authorization: "Bearer " + process.env.AI_GATEWAY_API_KEY, "content-type": "application/json", "ai-model-id": "recraft/recraft-v4.1-flash" }, body: "{}" }).then(async (r) => { console.log(r.status); process.exit(0); }, (e) => { console.log("failed " + e.message); process.exit(1); })`;
    // In a process group of its own: the forwarder's socat goes with it afterwards, as it goes with a sandbox's namespace.
    const child = spawn(join(relay.shimDir, "bwrap"), ["--unshare-net", "--", process.execPath, "-e", script], { env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", PENDULUM_GATEWAY_URL: relay.url, AI_GATEWAY_API_KEY: opened.shell[RELAYED_NAME] }, detached: true, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const code = await new Promise((r) => child.on("exit", r));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // the group is gone
    }
    assert.deepEqual([code, out.trim()], [0, "200"]);
    assert.equal(gw.seen.find((x) => x.url === IMAGE)?.auth, `Bearer ${KEY}`, "the gateway got the key; the command had only the token");
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.pings], [0.04, 1, 1], "priced, and the forwarder's ping counted");
    await closeWorkerRelay(relay);
    opened = null;
    assert.ok(!existsSync(relaySocketDir(usageDir, { root })), "the socket's directory goes with the stage");
    assert.ok(!existsSync(localRelayDir(usageDir)));
  } finally {
    if (opened?.relay) await closeWorkerRelay(opened.relay);
    await gw.close();
    await release();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relay probe that finds no forwarder Blocks with a fixed reason: no key handed over, nothing run", async () => {
  const { gitRefusalReason } = await import("../scripts/lib/local.mjs");
  const reason = gitRefusalReason("relay", 7, { harness: "codex", local: true });
  assert.match(reason, /gateway relay's forwarder did not come up in Codex's sandbox \(relay\); the harness was not started, and the key was never handed over/);
  assert.match(gitRefusalReason("relay", 7, { harness: "claude" }), /Claude Code's sandbox[^]*work job's log/);
});

test("doctor: the relayed key without bwrap or socat is a WARN that every stage Blocks; else a PASS", async () => {
  const { gatewayRelayChecks } = await import("../scripts/doctor.mjs");
  const spec = { workerSecrets: "AI_GATEWAY_API_KEY=W FAL_KEY" };
  assert.deepEqual(gatewayRelayChecks({ inputs: { ...spec, harness: "claude" }, env: {}, which: () => "/usr/bin/x" }).map((c) => c.status), ["PASS"]);
  assert.match(gatewayRelayChecks({ inputs: { ...spec, harness: "codex" }, env: { GITHUB_ACTIONS: "true" }, which: (b) => (b === "socat" ? null : "/usr/bin/bwrap") })[0].detail, /needs socat/);
  assert.deepEqual(gatewayRelayChecks({ inputs: { ...spec, harness: "copilot" }, env: {}, which: () => "/usr/bin/x" }).map((c) => c.status), ["PASS"], "Copilot is relayed through its own shim");
  assert.deepEqual(gatewayRelayChecks({ inputs: { workerSecrets: "FAL_KEY", harness: "copilot" } }), [], "no relayed key, no check");
});

test("a relayed call whose cost the gateway did not report is unknown: nothing added to the dollars or the cap, counted, and the pass's record marked (#483)", async () => {
  // A 500 naming no generation, then a priced $0.10 call: the cap ($1) counts the $0.10 only.
  const gw = await fakeGateway({ "/v4/ai/embedding-model": { status: 500, body: { error: "upstream" } }, [IMAGE]: priced(0.1), "/v1/generation": { body: { data: { total_cost: 0.1 } } } });
  const dir = mkdtempSync(join(tmpdir(), "relay-unknown-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 5, origin: gw.origin, lookupDelaysMs: [1] });
    relay.beginPass(1);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/embedding-model" })).status, 500);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 200, "the unknown cost is not counted against the cap");
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.unknown, pass.capped], [0.1, 2, 1, false]);
    assert.deepEqual([relay.totals().usd, relay.totals().unknown], [0.1, 1]);
    assert.equal(relay.totals().estimated, undefined, "no estimate is kept anywhere");
    const rec = addKeySpend({ harness: "claude", usd: 2, tokens: {} }, pass);
    assert.deepEqual([rec.usd, rec.harnessUsd, rec.workerKeyUsd, rec.workerKeyUnknown, rec.usdUnknown, rec.usdUnknownWhy], [2.1, 2, 0.1, 1, 1, ["relay"]]);
    assert.equal(rec.usdUpperBound ?? rec.usdLowerBound, undefined, "no bound marks");
    await relay.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gateway's real answer shapes (fixture): string costs, the generation id in providerMetadata or the stream's header; a lookup not yet ingested falls back to the reported cost", async () => {
  const F = JSON.parse(readFileSync(new URL("./fixtures/ai-gateway-0.4-shapes.json", import.meta.url), "utf8"));
  // costOf on the real shapes.
  assert.deepEqual(costOf(F.text.body, "sdk"), { usd: 0, id: "gen_FAKETEXT0000000000000000A1" });
  assert.deepEqual(costOf(F.image.body, "sdk"), { usd: 0.007, id: "gen_FAKEIMAGE000000000000000C3" });
  assert.deepEqual(costOf(F.stream.events.at(-1), "sdk", F.stream.events[0], F.stream.headers["x-generation-id"]), { usd: 0, id: "gen_FAKESTREAM00000000000000B2" });
  assert.deepEqual(costOf({ type: "finish" }, "sdk", null, F.stream.headers["x-generation-id"]), { usd: null, id: "gen_FAKESTREAM00000000000000B2" }, "a finish event with no cost: the header's id, looked up");
  let lookups = 0;
  const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const gw = await fakeGateway({
    "/v4/ai/image-model": { body: F.image.body, headers: { "x-vercel-id": F.image.headers["x-vercel-id"] } },
    "/v4/ai/language-model": (body) =>
      JSON.parse(body || "{}").stream
        ? { type: "text/event-stream", headers: { "x-generation-id": F.stream.headers["x-generation-id"] }, body: sse(JSON.parse(body).noCost ? [...F.stream.events.slice(0, -1), { type: "finish", finishReason: "stop" }] : F.stream.events) }
        : { body: F.text.body },
    // The generation's record: the image's at once, the stream's at 0.02, the text's never ingested in time (404).
    "/v1/generation": (_b, req) => {
      lookups += 1;
      if (req.url.includes("C3")) return F.lookupImage;
      if (req.url.includes("B2")) return { body: { data: { ...F.lookupImage.body.data, id: "gen_FAKESTREAM00000000000000B2", total_cost: 0.02 } } };
      return F.lookupNotYet;
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-shapes-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 5, origin: gw.origin, lookupDelaysMs: [1, 1, 1] });
    relay.beginPass(5);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/image-model" })).status, 200);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/language-model" })).status, 200);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/language-model", body: '{"stream":true}' })).status, 200);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/language-model", body: '{"stream":true,"noCost":true}' })).status, 200);
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls], [0.047, 4], "0.007 image + 0 text (its record never came: the reported 0 stands, no Block) + 0.02 for each stream (its record's 0.02 over the reported 0, and the one that reported none)");
    assert.ok(lookups >= 4);
    await relay.close();
    // A looked-up cost above the reported one is booked on top.
    const higher = await fakeGateway({ "/v4/ai/image-model": { body: F.image.body }, "/v1/generation": { body: { data: { ...F.lookupImage.body.data, total_cost: 0.01 } } } });
    const r2 = await openRelay({ key: KEY, dir: join(dir, "b"), maxUsd: 5, origin: higher.origin, lookupDelaysMs: [1] });
    r2.beginPass(5);
    await call(r2.socketPath, { token: r2.token, path: "/v4/ai/image-model" });
    assert.deepEqual([(await r2.endPass()).usd], [0.01]);
    await r2.close();
    await higher.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with a cap, calls waiting their turn when the pass ends are refused, never sent; the one in flight is booked into that pass", async () => {
  let hold = null;
  let entered = null;
  const inFlight = new Promise((r) => (entered = r));
  const gw = await fakeGateway({
    "/v4/ai/image-model": async (body) => {
      if (JSON.parse(body || "{}").wait) {
        entered();
        await new Promise((r) => (hold = r));
      }
      return priced(1);
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-minors-"));
  const g = await openRelay({ key: KEY, dir: join(dir, "g"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [1] });
  try {
    g.beginPass(100);
    const first = call(g.socketPath, { token: g.token, body: '{"wait":true}' });
    await inFlight;
    // One more than may wait: the first answer is the 429 of the one that found the queue full, so the others wait.
    const queued = Array.from({ length: MAX_WAITING + 1 }, () => call(g.socketPath, { token: g.token }));
    const full = await Promise.race(queued);
    assert.equal(full.status, 429);
    const ended = g.endPass();
    hold();
    const statuses = (await Promise.all(queued)).map((x) => x.status).sort();
    assert.deepEqual(statuses, [...Array(MAX_WAITING).fill(403), 429]);
    assert.equal((await first).status, 200);
    const pass = await ended;
    assert.deepEqual([pass.usd, pass.calls], [1, 1]);
    assert.equal(g.totals().calls, 1, "none of the queue was sent");
  } finally {
    await g.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the AI SDK's real requests (ai@7.0.165, fixture) pass through the relay with every header the gateway needs; the model header is never dropped (#126)", async () => {
  const F = JSON.parse(readFileSync(new URL("./fixtures/ai-sdk-7.0.165-requests.json", import.meta.url), "utf8"));
  const got = [];
  const answer = { body: { providerMetadata: { gateway: { cost: "0.001" } } } };
  const gw = await fakeGateway({ "/v4/ai/language-model": (_b, req) => (got.push(req.headers), answer), "/v4/ai/image-model": (_b, req) => (got.push(req.headers), answer), "/v4/ai/embedding-model": (_b, req) => (got.push(req.headers), answer), "/v4/ai/decision-model": (_b, req) => (got.push(req.headers), answer), "/v4/ai/reranking-model": (_b, req) => (got.push(req.headers), answer) });
  const dir = mkdtempSync(join(tmpdir(), "relay-sdk-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 0, origin: gw.origin, lookupDelaysMs: [1] });
    relay.beginPass(0);
    const statuses = {};
    for (const [kind, r] of Object.entries(F.requests)) {
      // Exactly what the SDK sent, with the relay's token in the key's place.
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ socketPath: relay.socketPath, method: r.method, path: r.path, headers: { ...r.headers, authorization: `Bearer ${relay.token}` } }, (x) => {
          x.resume();
          x.on("end", () => resolve(x.statusCode));
        });
        req.on("error", reject);
        req.end(r.body);
      });
      statuses[kind] = res;
    }
    assert.deepEqual(statuses, { generateText: 200, streamText: 200, generateImage: 200, embed: 200, decide: 200, rerank: 200, video: 403 }, "every model call reaches the gateway with its model header; video is not relayed (its cost comes later)");
    // Every ai-* header the SDK sent reached the gateway.
    for (const [i, kind] of ["generateText", "streamText", "generateImage", "embed", "decide", "rerank"].entries()) {
      const sent = Object.keys(F.requests[kind].headers).filter((h) => h.startsWith("ai-"));
      assert.deepEqual(sent.filter((h) => got[i][h] !== F.requests[kind].headers[h]), [], `${kind}: an ai-* header was dropped`);
    }
    await relay.endPass();
    await relay.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Copilot: its own shim hands each call to the relay's, which adds the socket's directory read-only, loopback off the proxy and the forwarder to a command sandbox", async () => {
  const { bwrapShim, probeDriver, RELAY_RULE } = await import("../scripts/lib/copilot-runner.mjs");
  const { copilotRelayExtra } = await import("../scripts/lib/relay-shim.mjs");
  const dir = mkdtempSync(join(tmpdir(), "relay-copilot-"));
  try {
    const fake = join(dir, "real-bwrap");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const relayShim = join(writeRelayShim(join(dir, "relay", "bin"), { bwrap: fake, socat: "/usr/bin/socat", socket: "/var/lib/pendulum-relay/s/relay.sock", port: 41234, extra: copilotRelayExtra("/var/lib/pendulum-relay/s") }), "bwrap");
    // Copilot's own shim, with the relay's shim path baked in (never read from the environment).
    const shim = join(dir, "bwrap");
    writeFileSync(shim, bwrapShim(fake, null, "/agent/tmp", null, relayShim), { mode: 0o755 });
    const absent = join(dir, "bwrap-absent");
    writeFileSync(absent, bwrapShim(fake, null, "/agent/tmp", null, join(dir, "missing", "bwrap")), { mode: 0o755 });
    const run = (args, env = {}, which = shim) => execFileSync(which, args, { encoding: "utf8", env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", ...env } }).trim().split("\n");
    const cmd = ["--unshare-net", "--setenv", "TMPDIR", "/x", "--seccomp", "60", "--", "sh", "-c", "curl x"];
    const plain = run(cmd, {}, absent);
    assert.deepEqual(plain, ["--unshare-net", "--setenv", "TMPDIR", "/agent/tmp", "--seccomp", "60", "--", "sh", "-c", "curl x"], "no relay shim at the baked path: as before");
    const relayed = run(cmd);
    const sep = relayed.indexOf("--", 6);
    assert.deepEqual(relayed.slice(0, sep), ["--unshare-net", "--setenv", "TMPDIR", "/agent/tmp", "--seccomp", "60", "--ro-bind", "/var/lib/pendulum-relay/s", "/var/lib/pendulum-relay/s", "--setenv", "NO_PROXY", "127.0.0.1", "--setenv", "no_proxy", "127.0.0.1"], "Copilot's own rewrite, then the relay's options");
    assert.deepEqual(relayed.slice(sep + 1, sep + 4), ["/bin/bash", "-p", "-c"]);
    assert.deepEqual(relayed.slice(-8), ["bash", "/var/lib/pendulum-relay/s/relay.sock", "41234", "/usr/bin/socat", "", "sh", "-c", "curl x"]);
    assert.deepEqual(run(["--version"]), ["--version"], "no network namespace: as given");
    // Repository content can reach Copilot's environment in local mode: a variable naming another bubblewrap is ignored.
    assert.deepEqual(run(cmd, { PENDULUM_RELAY_BWRAP: fake }, absent), plain, "the environment never picks the bubblewrap");
    assert.ok(!bwrapShim(fake, "/h", "/t", "/n").includes("${"), "nothing systemd-run would expand");
    // The probe's rule: this relay's ping through the forwarder.
    const driver = probeDriver({ gitConfig: "/c/.git/config", host: "example.com", marker: "m", relay: { port: 41234, probeId: "abc123" } });
    assert.match(driver, /http:\/\/127\.0\.0\.1:41234\/\.pendulum-relay\/ping/);
    assert.match(driver, /pendulum-relay abc123/);
    assert.ok(driver.includes("the gateway relay is out of the commands") && RELAY_RULE.startsWith("the gateway relay is out of the commands"));
    assert.ok(!driver.includes("${"));
    assert.ok(!probeDriver({ gitConfig: "/c/.git/config", host: "example.com", marker: "m" }).includes("gateway relay"), "no relay, no rule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Copilot on a runner: each stage's relay shim is its own, in its relay directory, baked into that stage's Copilot shim; a shared one is removed at start", async () => {
  const { bakeCopilotRelay } = await import("../scripts/lib/copilot-runner.mjs");
  const { copilotRelayShimIn, copilotRelayExtra } = await import("../scripts/lib/relay-shim.mjs");
  const { dropSharedCopilotRelay } = await import("../scripts/lib/worker-relay.mjs");
  const dir = mkdtempSync(join(tmpdir(), "relay-copilot-stage-"));
  try {
    const fake = join(dir, "real-bwrap");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    // Two stages: each relay directory holds its own shim, and each stage's Copilot shim names its own.
    const stage = (name) => {
      const relayDir = join(dir, "pendulum-relay", `stage-${name}`);
      const at = copilotRelayShimIn(relayDir);
      writeRelayShim(join(relayDir, "copilot"), { bwrap: fake, socat: "/usr/bin/socat", socket: join(relayDir, `${name}.sock`), port: 41234, extra: copilotRelayExtra(relayDir) });
      const layout = { bin: join(dir, `copilot-home-${name}`, "bin"), agentHome: "/home/agent", agentTmp: "/home/agent/tmp" };
      mkdirSync(layout.bin, { recursive: true });
      bakeCopilotRelay(layout, fake, at);
      return { relayDir, shim: join(layout.bin, "bwrap") };
    };
    const a = stage("a");
    const b = stage("b");
    const run = (shim) => execFileSync(shim, ["--unshare-net", "--", "sh", "-c", "x"], { encoding: "utf8", env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" } }).trim().split("\n");
    assert.ok(run(a.shim).includes(join(a.relayDir, "a.sock")) && !run(a.shim).includes(join(b.relayDir, "b.sock")), "stage a hands to its own relay");
    assert.ok(run(b.shim).includes(join(b.relayDir, "b.sock")), "stage b to its own");
    // Stage a ends: its relay directory goes; stage b is unaffected, and a's Copilot shim falls back to the real one.
    rmSync(a.relayDir, { recursive: true, force: true });
    assert.ok(run(b.shim).includes(join(b.relayDir, "b.sock")));
    assert.deepEqual(run(a.shim), ["--unshare-net", "--", "sh", "-c", "x"], "nothing left to hand to: the real bubblewrap, as given");
    // A shared shim from an older Pendulum: removed when a Copilot stage starts.
    const shared = join(dir, "pendulum-relay", "copilot");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "bwrap"), "#!/bin/sh\n", { mode: 0o755 });
    dropSharedCopilotRelay(join(dir, "pendulum-relay"));
    assert.equal(existsSync(shared), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image edits (#129): the recorded multipart and JSON requests pass byte for byte; priced from the gateway's top-level cost or the lookup by id; any other shape fails closed", async () => {
  const F = JSON.parse(readFileSync(new URL("./fixtures/image-edits-requests.json", import.meta.url), "utf8"));
  const EDITS = "/v1/images/edits";
  const image = { created: 1, data: [{ b64_json: "aGk=" }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  // The answer shapes the gateway may give: its own cost at the top level, an id only in the header, a top-level id.
  const answers = [
    { body: { ...image, providerMetadata: { gateway: { cost: "0.04", generationId: "gen_EDITREPORTED01" } } } },
    { body: image, headers: { "x-generation-id": "gen_EDITHEADER0002" } },
    { body: { ...image, id: "gen_EDITTOPLEVEL03" } },
  ];
  const looked = { gen_EDITREPORTED01: 0.05, gen_EDITHEADER0002: 0.04, gen_EDITTOPLEVEL03: 0.06 };
  let next = 0;
  const gw = await fakeGateway({ [EDITS]: () => answers[next++] ?? { body: image }, "/v1/generation": (_b, req) => ({ body: { data: { total_cost: looked[new URL(req.url, "http://x").searchParams.get("id")] } } }) });
  const dir = mkdtempSync(join(tmpdir(), "re-"));
  const relay = await openRelay({ key: KEY, dir: join(dir, "r"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [5] });
  try {
    relay.beginPass(100);
    const kinds = Object.keys(F.requests);
    assert.deepEqual(kinds, ["sdkMultipart", "fetchMultipart", "fetchJson"]);
    for (const kind of kinds) {
      const r = F.requests[kind];
      const bytes = Buffer.from(r.body, "base64");
      const res = await send(relay.socketPath, { method: r.method, path: r.path, headers: { ...r.headers, authorization: `Bearer ${relay.token}`, "content-length": bytes.length }, body: bytes });
      assert.equal(res.status, 200, `${kind}: ${res.text}`);
      const up = gw.seen.filter((x) => x.url === EDITS).at(-1);
      assert.equal(up.headers["content-type"], r.headers["content-type"], `${kind}: the content-type and its boundary untouched`);
      assert.ok(up.raw.equals(bytes), `${kind}: the body byte for byte`);
      assert.equal(up.auth, `Bearer ${KEY}`);
    }
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls], [0.15, 3], "0.05 (looked up over 0.04 reported) + 0.04 (by the header's id) + 0.06 (by the top-level id)");
    // A changed boundary no longer parses: the gateway refuses it (400), unbilled.
    relay.beginPass(100);
    const m = F.requests.fetchMultipart;
    const broken = await send(relay.socketPath, { path: EDITS, headers: { ...m.headers, "content-type": "multipart/form-data; boundary=other", authorization: `Bearer ${relay.token}` }, body: Buffer.from(m.body, "base64") });
    assert.equal(broken.status, 400);
    // An answer with no top-level cost and no generation id (a cost only in `usage` or nested in `data`) is never $0: a
    // call of unknown cost, and relaying goes on.
    const unknown = await send(relay.socketPath, { path: EDITS, headers: { ...m.headers, authorization: `Bearer ${relay.token}` }, body: Buffer.from(m.body, "base64") });
    assert.equal(unknown.status, 200);
    const after = await relay.endPass();
    assert.deepEqual([after.usd, after.calls, after.unknown], [0, 1, 1], "unknown cost: never $0 and never an estimate");
    assert.equal(relay.totals().failed, 1, "the refused one is not billed");
  } finally {
    await relay.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(costOf({ ...image, data: [{ b64_json: "aGk=", providerMetadata: { gateway: { cost: "0", generationId: "gen_NESTED000001" } } }], usage: { cost: 0 } }, "image"), { usd: null, id: null }, "nothing nested or in usage is read");
  assert.deepEqual(costOf({ providerMetadata: { gateway: { cost: "0.04" } } }, "openai"), { usd: null, id: null }, "other OpenAI-compatible answers keep the lookup only");
  assert.equal(routeOf("POST", "/v1/images/edits")?.family, "image");
  assert.equal(routeOf("POST", "/v1/images/edits?x=1"), null);
  assert.equal(routeOf("GET", "/v1/credits"), null, "/v1/credits stays refused");
});

test("image edits (#132): a real turnaround's size, 38.5 MiB, is under the cap and passes whole", async () => {
  const EDITS = "/v1/images/edits";
  const boundary = "pendulum-test-boundary";
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nopenai/gpt-image-2\r\n--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.alloc(Math.ceil(38.5 * 1024 * 1024)), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  assert.ok(body.length < EDITS_MAX_BYTES);
  const gw = await fakeGateway({ [EDITS]: { body: { created: 1, data: [{ b64_json: "aGk=" }], providerMetadata: { gateway: { cost: "0.01", generationId: "gen_EDITSLOW00001" } } } }, "/v1/generation": { body: { data: { total_cost: 0.01 } } } });
  const dir = mkdtempSync(join(tmpdir(), "re-big-"));
  const r = await openRelay({ key: KEY, dir: join(dir, "real"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [5] });
  try {
    r.beginPass(100);
    assert.equal((await send(r.socketPath, { path: EDITS, headers: { authorization: `Bearer ${r.token}`, "content-type": `multipart/form-data; boundary=${boundary}` }, body })).status, 200);
    assert.ok(gw.seen.find((x) => x.url === EDITS).raw.equals(body), "the body arrived whole");
    assert.equal((await r.endPass()).calls, 1);
  } finally {
    await r.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the AI Gateway's own budget refusal (402 quota_for_entity_exceeded) costs $0, is named, and refuses later calls apart from Pendulum's own cap 402 (#134)", async () => {
  // The body the gateway answered an adopter's run with (v0.9.16), its key in the message to show it is cut.
  const MESSAGE = `Team budget exceeded. Current spend: $50.06, limit: $50.00. Team owners can edit this budget in AI Gateway Budgets & Spend (https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fbudgets&title=AI+Gateway+Budgets+%26+Spend).`;
  const real = { type: "quota_for_entity_exceeded", message: MESSAGE };
  let quota = false;
  const gw = await fakeGateway({
    [IMAGE]: () => (quota ? { status: 402, body: { ...real, message: `${MESSAGE}\n${KEY}` } } : priced(0.05)),
    "/v4/ai/language-model": { status: 402, body: { error: { type: "payment_required", message: "pay" } } },
    "/v1/generation": { body: { data: { total_cost: 0.05 } } },
    "/v1/models": { body: { data: [] } },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-quota-"));
  // Every relay this test opens is closed whatever fails, so a failure never leaves a server holding the run open.
  const opened = [];
  const open = async (o) => {
    const r = await openRelay(o);
    opened.push(r);
    return r;
  };
  // The model calls that reached the gateway (a reported cost's lookup runs aside and is not one).
  const modelCalls = () => gw.seen.filter((r) => !r.url.startsWith("/v1/generation")).length;
  try {
    const relay = await open({ key: KEY, dir: join(dir, "a"), maxUsd: 25, origin: gw.origin, lookupDelaysMs: [1] });
    relay.beginPass(15);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 200);
    quota = true;
    // The gateway's 402 reaches the worker as it came, with its type and message, the key cut.
    const first = await call(relay.socketPath, { token: relay.token });
    assert.equal(first.status, 402);
    assert.equal(JSON.parse(first.text).type, "quota_for_entity_exceeded");
    assert.ok(first.text.includes("Team budget exceeded") && !first.text.includes(KEY), "the gateway's own answer, the key cut");
    // Every later billable call: the gateway's refusal at once, never sent, and told apart from Pendulum's cap.
    const sent = modelCalls();
    const later = await call(relay.socketPath, { token: relay.token, path: "/v4/ai/embedding-model" });
    assert.equal(later.status, 402);
    const e = JSON.parse(later.text).error;
    assert.deepEqual([e.type, e.source], ["quota_for_entity_exceeded", "ai-gateway"]);
    assert.match(e.message, /^AI Gateway refused: quota_for_entity_exceeded \(Team budget exceeded\. Current spend: \$50\.06/);
    assert.match(e.message, /not Pendulum's max_usd/);
    assert.equal(modelCalls(), sent, "not sent");
    assert.equal((await call(relay.socketPath, { token: relay.token, method: "GET", path: "/v1/models" })).status, 200, "the model list costs nothing and still passes");
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.capped], [0.05, 1, false], "the refusal is $0, not unpriced");
    assert.equal(pass.gatewayRefused.type, "quota_for_entity_exceeded");
    assert.ok(!pass.gatewayRefused.message.includes(KEY) && !/\n/.test(pass.gatewayRefused.message) && pass.gatewayRefused.message.length <= 160, "one line, clipped, the key cut");
    const rec = addKeySpend({ usd: 9.99, tokens: {} }, pass);
    assert.equal(rec.budgetExceeded, undefined, "the pass is not over budget: the worker finishes and exits itself");
    assert.equal(rec.workerKeyGatewayRefused.type, "quota_for_entity_exceeded");
    const totals = relay.totals();
    assert.deepEqual([totals.failed, totals.refused.gateway], [1, 1]);
    // result.json's workerKey records it.
    assert.equal(keyBreakdown([rec], totals).fields.workerKey.gatewayRefused.type, "quota_for_entity_exceeded");
    // The Block reason and the progress line name it first.
    assert.match(withGatewayRefusal("the lookdev call failed", totals.gatewayRefused), /^AI Gateway refused: quota_for_entity_exceeded \(Team budget exceeded\. Current spend: \$50\.06, limit: \$50\.00\..*\); the lookdev call failed$/);
    assert.equal(withGatewayRefusal("time cap reached", null), "time cap reached");

    // Pendulum's own cap: a 402 of its own type, saying it is Pendulum's cap.
    const capped = await open({ key: KEY, dir: join(dir, "b"), maxUsd: 25, origin: gw.origin, lookupDelaysMs: [1] });
    quota = false;
    capped.beginPass(0.05);
    assert.equal((await call(capped.socketPath, { token: capped.token })).status, 200);
    const own = await call(capped.socketPath, { token: capped.token });
    assert.equal(own.status, 402);
    const oe = JSON.parse(own.text).error;
    assert.equal(oe.type, "pendulum_max_usd");
    assert.match(oe.message, /^Pendulum's gateway relay: Pendulum's dollar cap is reached/);
    assert.equal(oe.source, undefined);
    assert.equal((await capped.endPass()).gatewayRefused, null);

    // A 402 of any other type is no refusal of the gateway's: a call of unknown cost (#142, #483).
    const other = await open({ key: KEY, dir: join(dir, "c"), maxUsd: 25, origin: gw.origin, lookupDelaysMs: [1] });
    other.beginPass(15);
    assert.equal((await call(other.socketPath, { token: other.token, path: "/v4/ai/language-model" })).status, 402);
    const failed = await other.endPass();
    assert.deepEqual([failed.unknown, failed.usd, failed.gatewayRefused], [1, 0, null]);
  } finally {
    for (const r of opened) await r.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // Both places the gateway puts its type; anything else is no refusal of the gateway's.
  assert.equal(gatewayRefusalOf(real)?.type, "quota_for_entity_exceeded");
  assert.equal(gatewayRefusalOf({ error: { type: "insufficient_funds", message: "no credits" } })?.message, "no credits");
  assert.equal(gatewayRefusalOf({ type: "error", error: { type: "quota_for_entity_exceeded", message: "m" } })?.type, "quota_for_entity_exceeded");
  for (const d of [null, "quota_for_entity_exceeded", [real], { error: { type: "rate_limit_exceeded" } }, { type: "payment_required" }, { data: real }]) assert.equal(gatewayRefusalOf(d), null, JSON.stringify(d));
});

test("a failed call is priced where it can be; a cost still unknown is counted as unknown and relaying goes on, however many come in a row; each call is one line of the call log (#142, #163, #483)", async () => {
  const looked = { gen_abcdef12: 0.4, gen_FAIL500ID0001: 0.3, gen_FAIL503HDR001: 0.2 };
  const gw = await fakeGateway({
    [IMAGE]: (body) => {
      const mode = JSON.parse(body || "{}").mode;
      // An upstream 500 that names its generation in the body; a 503 that names it in the header.
      if (mode === "500id") return { status: 500, body: { error: { type: "internal_server_error", message: "boom" }, generationId: "gen_FAIL500ID0001" } };
      if (mode === "503hdr") return { status: 503, headers: { "x-generation-id": "gen_FAIL503HDR001" }, body: { error: { type: "failed_dependency", message: "provider down" } } };
      // A 4xx the gateway gave before any model ran: its `error.type` says so. The same type on a 5xx, or at the top level
      // of the body, says nothing.
      if (mode === "premodel") return { status: 409, body: { error: { type: "model_not_found", message: "no such model" } } };
      if (mode === "premodel5xx") return { status: 500, body: { error: { type: "model_not_found", message: "no such model" } } };
      if (mode === "toplevel") return { status: 409, body: { type: "invalid_request_error", message: "m" } };
      if (mode === "drop") return { drop: '{"images":["aG' };
      return priced(0.4);
    },
    "/v1/generation": (_b, req) => {
      const usd = looked[new URL(req.url, "http://x").searchParams.get("id")];
      return usd === undefined ? { status: 404, body: { error: "not_found" } } : { body: { data: { total_cost: usd } } };
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-unknown-"));
  const lines = [];
  const opened = [];
  try {
    const usage = join(dir, "usage");
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [1], callLog: join(usage, CALL_LOG), log: (l) => lines.push(l) });
    opened.push(relay);
    const go = (mode) => call(relay.socketPath, { token: relay.token, body: JSON.stringify({ mode }) });
    relay.beginPass(100);
    assert.equal((await go("ok")).status, 200);
    assert.equal((await go("500id")).status, 500, "the worker gets the gateway's answer");
    assert.equal((await go("503hdr")).status, 503);
    assert.equal((await go("premodel")).status, 409);
    // A dropped connection mid-answer: no id, no record: a call of unknown cost, nothing booked, and relaying goes on.
    await go("drop").catch(() => null);
    assert.equal((await go("ok")).status, 200, "relaying goes on after the first unknown cost");
    let pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.unknown], [1.3, 5, 1], "0.4 + 0.3 (500, looked up) + 0.2 (503, by its header) + 0 (refused before any model) + unknown (dropped) + 0.4");
    const rec = addKeySpend({ usd: 2, tokens: {} }, pass);
    assert.deepEqual([rec.usd, rec.usdUnknown, rec.usdUnknownWhy, rec.budgetExceeded], [3.3, 1, ["relay"], undefined]);
    assert.ok(lines.some((l) => /a call's cost could not be determined \(the answer broke off: .+; no generation id\); counted as a call of unknown cost \(\d+ in the stage\), not against max_usd, and relaying goes on/.test(l)), lines.join("\n"));
    // Four in a row (a 5xx whose type would say "before any model ran" on a 4xx), each of unknown cost, then a priced call.
    relay.beginPass(100);
    for (let i = 1; i <= 4; i++) assert.equal((await go("premodel5xx")).status, 500);
    assert.equal((await go("ok")).status, 200, "still relaying after four unknown costs in a row");
    pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.unknown], [0.4, 5, 4], "4 calls of unknown cost and the priced call");
    // Six in a row with no priced call between them: each of unknown cost, and relaying and the pass go on (#483).
    relay.beginPass(100);
    for (let i = 1; i <= 6; i++) assert.equal((await go("premodel5xx")).status, 500, "the worker gets the gateway's answer, the sixth time too");
    pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.unknown], [0, 6], "all six counted");
    assert.deepEqual([addKeySpend({ usd: 1, tokens: {} }, pass).budgetExceeded], [undefined], "the pass is not over budget for them: the stage goes on");
    assert.ok(!lines.some((l) => /relay shut|refuses? every later call/.test(l)), lines.join("\n"));
    relay.beginPass(100);
    assert.equal((await go("ok")).status, 200, "still relaying");
    await relay.endPass();
    const totals = relay.totals();
    assert.deepEqual([totals.unknown, totals.usd, totals.callLog?.file], [11, 2.1, CALL_LOG], "the two looked-up failures are of unknown cost no more");
    // The call log: one line per call, the model from its header, no key and no body; only Pendulum's user reads it.
    const log = readFileSync(join(usage, CALL_LOG), "utf8");
    assert.ok(!log.includes(KEY) && !log.includes("boom") && !log.includes('"mode"') && !log.includes("aG"), "no key, no body, no gateway message");
    assert.equal(statSync(join(usage, CALL_LOG)).mode & 0o777, 0o600);
    const calls = log.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(totals.callLog.lines, calls.length);
    // A call's own line, and a later line (`reconciled`) when its generation's record settled what it was booked at.
    const sent = calls.filter((c) => !("reconciled" in c));
    assert.deepEqual(sent.map((c) => [c.status, c.basis ?? c.refused, c.usd ?? null]), [
      [200, "reported", 0.4],
      // A failed call that names its generation: of unknown cost at once, its record's cost on a line of its own.
      [500, "unknown", null],
      [503, "unknown", null],
      [409, "refused", 0],
      [200, "unknown", null],
      [200, "reported", 0.4],
      ...Array.from({ length: 4 }, () => [500, "unknown", null]),
      [200, "reported", 0.4],
      ...Array.from({ length: 6 }, () => [500, "unknown", null]),
      [200, "reported", 0.4],
    ]);
    assert.deepEqual(calls.filter((c) => "reconciled" in c).map((c) => [c.id, c.basis, c.usd, c.reconciled]).sort(), [
      ["gen_FAIL500ID0001", "lookup", 0.3, 0.3],
      ["gen_FAIL503HDR001", "lookup", 0.2, 0.2],
    ]);
    assert.ok(sent.every((c) => c.t && c.method === "POST" && c.path === IMAGE));
    assert.ok(sent.every((c) => c.model === "recraft/recraft-v4.1-flash"), "the model from its header");
    assert.deepEqual([sent[1].id, sent[2].id, sent[3].type], ["gen_FAIL500ID0001", "gen_FAIL503HDR001", "model_not_found"]);
    assert.match(sent[1].unpriced, /^the gateway answered 500 \(internal_server_error\); generation gen_FAIL500ID0001 is looked up$/);
    assert.match(sent[4].unpriced, /^the answer broke off: /);
    // result.json: the first pass's record carries its one call of unknown cost; the relay's totals hold ten more from
    // passes whose records are not given here, counted as one more run of unknown cost. No bound marks.
    writeUsage(usage, { harness: "claude", model: "m", records: [rec], passes: 1, exit: "blocked", reason: "r", credentialBasis: "x", workerKey: totals });
    const result = JSON.parse(readFileSync(join(usage, "result.json"), "utf8"));
    assert.deepEqual([result.usdUnknown, result.usdUnknownWhy, result.usdUpperBound, result.usdLowerBound, result.workerKey.unknown, result.workerKey.callLog.file], [2, ["relay"], undefined, undefined, 11, CALL_LOG]);

    // A call of unknown cost never counts toward the live cap: with $0.25 left, the next call is relayed after one, and
    // the cap stops the call after a priced one.
    const near = await openRelay({ key: KEY, dir: join(dir, "b"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [1] });
    opened.push(near);
    near.beginPass(0.25);
    await call(near.socketPath, { token: near.token, body: '{"mode":"drop"}' }).catch(() => null);
    assert.equal((await call(near.socketPath, { token: near.token, body: '{"mode":"ok"}' })).status, 200, "the unknown cost is not counted against the cap");
    const capped = await call(near.socketPath, { token: near.token, body: '{"mode":"ok"}' });
    assert.equal(capped.status, 402);
    assert.equal(JSON.parse(capped.text).error.type, "pendulum_max_usd");
    const np = await near.endPass();
    assert.deepEqual([np.usd, np.unknown, np.capped], [0.4, 1, true]);
  } finally {
    for (const r of opened) await r.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // The model for the log: a header, else a JSON body's or a form's `model`; nothing else.
  assert.equal(modelOf({ "ai-language-model-id": "openai/gpt-5" }, null), "openai/gpt-5");
  assert.equal(modelOf({}, Buffer.from('{"model":"openai/gpt-image-2"}'), "application/json"), "openai/gpt-image-2");
  assert.equal(modelOf({}, Buffer.from('--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nopenai/gpt-image-2\r\n--b--\r\n'), "multipart/form-data; boundary=b"), "openai/gpt-image-2");
  assert.equal(modelOf({}, Buffer.from('{"model":"x y\\n<script>"}'), "application/json"), null);
});

test("#142 review: a caller-shaped answer that cannot be priced is a call of unknown cost and relaying goes on; the call log keeps no caller path, only model-shaped models, is masked and capped; a pre-model type counts only on a 4xx at error.type", async () => {
  const SECRET = "sk-other-worker-secret-ABCDEF123456";
  const gw = await fakeGateway({
    [IMAGE]: (body) => {
      const mode = JSON.parse(body || "{}").mode;
      if (mode === "nocost") return { body: { images: ["aGk="] } };
      if (mode === "toplevel") return { status: 409, body: { type: "invalid_request_error", message: "m" } };
      return priced(0.01);
    },
    "/v1/generation": { body: { data: { total_cost: 0.01 } } },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-review142-"));
  const opened = [];
  const open = async (o) => {
    const r = await openRelay({ key: KEY, origin: gw.origin, lookupDelaysMs: [1], maxUsd: 10, ...o });
    opened.push(r);
    return r;
  };
  try {
    // Major 1: a cheap call, then a complete answer the relay cannot price. It was billed, so it is a call of unknown
    // cost; relaying goes on and the stage's Block reason, if it has one, is its own (#483).
    const a = await open({ dir: join(dir, "a") });
    a.beginPass(10);
    assert.equal((await call(a.socketPath, { token: a.token })).status, 200);
    assert.equal((await call(a.socketPath, { token: a.token, body: '{"mode":"nocost"}' })).status, 200);
    assert.equal((await call(a.socketPath, { token: a.token })).status, 200, "relaying goes on");
    const pa = await a.endPass();
    assert.deepEqual([pa.usd, pa.unknown], [0.02, 1]);
    assert.equal(stageBlockReason("the look-dev stalled", a.totals()), "the look-dev stalled");

    // Minor 3: a pre-model type at the top level of a 4xx body says nothing: a call of unknown cost.
    const b = await open({ dir: join(dir, "b") });
    b.beginPass(10);
    assert.equal((await call(b.socketPath, { token: b.token, body: '{"mode":"toplevel"}' })).status, 409);
    const pb = await b.endPass();
    assert.deepEqual([pb.usd, pb.unknown], [0, 1]);

    // Major 2: the call log.
    const usage = join(dir, "usage");
    const log = join(usage, CALL_LOG);
    const c = await open({ dir: join(dir, "c"), callLog: log, callLogMaxLines: 4 });
    c.beginPass(10);
    // A refused route: a fixed label, never the path the caller asked for.
    assert.equal((await call(c.socketPath, { token: c.token, path: `/x/${SECRET}` })).status, 403);
    // A model without a model id's shape is dropped; one with it is kept, and the stage's held secrets are masked.
    await call(c.socketPath, { token: c.token, path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: SECRET }) });
    await call(c.socketPath, { token: c.token, headers: { "ai-model-id": `openai/${SECRET}` } });
    await call(c.socketPath, { token: c.token, path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: 'evil\n{"usd":0}' }) });
    // Past the cap: counted, and one closing line says how many.
    await call(c.socketPath, { token: c.token });
    await call(c.socketPath, { token: c.token });
    await c.endPass();
    const tc = c.totals();
    await c.close();
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 5, "4 calls, then the closing line");
    assert.deepEqual(lines[0], { t: lines[0].t, status: 403, refused: "route" });
    assert.equal(lines[1].model, undefined, "no model id's shape: not kept");
    assert.equal(lines[2].model, `openai/${SECRET}`);
    assert.equal(lines[3].model, undefined);
    assert.deepEqual([lines[4].unlogged, tc.callLog.lines, tc.callLog.unlogged], [2, 4, 2]);
    assert.equal(maskFile(log, [SECRET]), 1, "finish masks the stage's held secrets in it, as in events.jsonl");
    assert.ok(!readFileSync(log, "utf8").includes(SECRET));
  } finally {
    for (const r of opened) await r.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the relay's upstream socket probes once a minute on a connection of its own, not the global agent's every second (#145)", async () => {
  // Vercel's edge answers about 27 keepalive probes on a connection, then none: at the global agent's one a second, a
  // call still silent ended with ETIMEDOUT about 38 s in. The setting that reaches the socket last is the one it keeps.
  const set = new Map();
  const original = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function (enable, delay) {
    set.set(this, [enable, delay]);
    return original.call(this, enable, delay);
  };
  let seen = null;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    seen = { connection: req.headers.connection };
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const up = await upstreamRequest(`http://127.0.0.1:${server.address().port}/v4/ai/image-model`, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from("{}") });
    for await (const _ of up.body);
    // The one call in this test: each socket that got a keepalive ends with the relay's.
    assert.ok(set.size >= 1, "the request's socket had its keepalive set");
    for (const last of set.values()) assert.deepEqual(last, [true, UPSTREAM_KEEPALIVE_MS]);
    assert.equal(UPSTREAM_KEEPALIVE_MS, 60_000);
    assert.equal(seen.connection, "close", "a connection of its own, never a pooled one that probed every second");
  } finally {
    net.Socket.prototype.setKeepAlive = original;
    await new Promise((r) => server.close(r));
  }
});

test("a 5xx saying no generation ran (503 service_unavailable_error) with no generation id costs $0 and is no unknown cost; other 5xx keep the lookup, else are of unknown cost (#148)", async () => {
  // The answer the gateway gave an adopter's two decision-model calls (perplexity/pplx-decider-v1.2), in about 800 ms.
  const unavailable = { status: 503, body: { error: { message: "Service temporarily unavailable", type: "service_unavailable_error" } } };
  const answers = {
    unavailable,
    // The same type naming its generation: looked up.
    unavailableWithId: { ...unavailable, headers: { "x-generation-id": "gen_UNAVAILID00001" } },
    internal: { status: 500, body: { error: { message: "boom", type: "internal_server_error" } } },
    // The gateway's other error shape: the type at the top level of a body with no `error` object (as its 402 has it).
    topLevel: { status: 503, body: { type: "service_unavailable_error", message: "m" } },
    // A type nested anywhere else says nothing.
    nested: { status: 503, body: { data: { type: "service_unavailable_error" }, error: { message: "m" } } },
  };
  const gw = await fakeGateway({
    "/v4/ai/decision-model": (body) => answers[JSON.parse(body || "{}").mode] ?? { body: { answers: {}, providerMetadata: { gateway: { cost: "0.002", generationId: "gen_DECIDE000001" } } } },
    "/v1/generation": (_b, req) => ({ body: { data: { total_cost: req.url.includes("gen_UNAVAILID00001") ? 0.003 : 0.002 } } }),
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-unavailable-"));
  const opened = [];
  const open = async (sub, extra = {}) => {
    const r = await openRelay({ key: KEY, dir: join(dir, sub), maxUsd: 10, origin: gw.origin, lookupDelaysMs: [1], ...extra });
    opened.push(r);
    r.beginPass(10);
    return r;
  };
  const decide = (r, mode) => call(r.socketPath, { token: r.token, path: "/v4/ai/decision-model", body: JSON.stringify({ mode }) });
  try {
    // Twice in a row, then relaying goes on and the next call is priced.
    const usage = join(dir, "usage");
    const a = await open("a", { callLog: join(usage, CALL_LOG) });
    assert.equal((await decide(a, "unavailable")).status, 503, "the worker gets the gateway's answer");
    assert.equal((await decide(a, "unavailable")).status, 503);
    assert.equal((await decide(a, "ok")).status, 200, "still relaying");
    const pa = await a.endPass();
    assert.deepEqual([pa.usd, pa.calls, pa.unknown], [0.002, 1, 0]);
    assert.deepEqual([a.totals().failed], [2]);
    const lines = readFileSync(join(usage, CALL_LOG), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.status, l.basis, l.usd, l.type ?? null]), [
      [503, "unavailable", 0, "service_unavailable_error"],
      [503, "unavailable", 0, "service_unavailable_error"],
      [200, "reported", 0.002, null],
    ]);
    // internal_server_error with no generation id: a call of unknown cost.
    const b = await open("b");
    assert.equal((await decide(b, "internal")).status, 500);
    const pb = await b.endPass();
    assert.deepEqual([pb.usd, pb.unknown], [0, 1]);
    // service_unavailable_error naming its generation: of unknown cost until its record's cost is booked.
    const c = await open("c");
    assert.equal((await decide(c, "unavailableWithId")).status, 503);
    const pc = await c.endPass();
    assert.deepEqual([pc.usd, pc.calls, pc.unknown], [0.003, 1, 0]);
    // The type at the top level of a body with no `error` object: read there too, $0.
    const d = await open("d", { callLog: join(dir, "d-usage", CALL_LOG) });
    assert.equal((await decide(d, "topLevel")).status, 503);
    const pd = await d.endPass();
    assert.deepEqual([pd.usd, pd.unknown, d.totals().failed], [0, 0, 1]);
    assert.deepEqual(
      readFileSync(join(dir, "d-usage", CALL_LOG), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((l) => [l.status, l.basis, l.usd, l.type]),
      [[503, "unavailable", 0, "service_unavailable_error"]],
    );
    // Nested elsewhere: a call of unknown cost.
    const e = await open("e");
    assert.equal((await decide(e, "nested")).status, 503);
    const pe = await e.endPass();
    assert.deepEqual([pe.usd, pe.unknown], [0, 1]);
  } finally {
    for (const r of opened) await r.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #163: the failure policy ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The call log's lines. */
const logLines = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
/** A TCP peer that takes a connection, reads its first bytes and resets: `seen.bytes` is what reached it. */
async function resettingPeer() {
  const seen = { bytes: 0, connections: 0 };
  const srv = net.createServer((sock) => {
    seen.connections += 1;
    sock.on("error", () => {});
    sock.on("data", (d) => {
      seen.bytes += d.length;
      sock.destroy();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) };
}
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test("a call that never left this machine costs $0 and is no unknown cost, by the socket's state; one that may have been sent is (#163)", async () => {
  const closed = await refusingOrigin();
  const peer = await resettingPeer();
  // upstreamRequest's own facts. Refused: the socket never connected.
  const refused = await upstreamRequest(`${closed.origin}/v4/ai/image-model`, { method: "POST", headers: {}, body: Buffer.from("{}") }).catch((e) => e);
  assert.deepEqual([refused.code, refused.unsent, refused.relayTimeout], ["ECONNREFUSED", true, false]);
  // Reset during the TLS handshake: connected, never secure, so none of the request was encrypted or sent.
  const handshake = await upstreamRequest(`https://127.0.0.1:${peer.port}/v4/ai/image-model`, { method: "POST", headers: {}, body: Buffer.from("{}") }).catch((e) => e);
  assert.deepEqual([handshake.unsent, peer.seen.bytes > 0], [true, true], "the peer saw the handshake's first bytes only");
  // Reset after the request was written: it may have been sent.
  const sent = await upstreamRequest(`http://127.0.0.1:${peer.port}/v4/ai/image-model`, { method: "POST", headers: {}, body: Buffer.from("{}") }).catch((e) => e);
  assert.deepEqual([sent.code, sent.unsent], ["ECONNRESET", false]);
  // A socket handed over already connected (here a pooled one; a proxy's tunnel is the same) may carry the request at
  // once: never `unsent`, whatever happens next.
  let cut = false;
  const sockets = new Set();
  const keeping = http.createServer((req, res) => {
    sockets.add(req.socket);
    if (cut) return req.socket.destroy();
    req.resume();
    req.on("end", () => res.end("{}"));
  });
  await new Promise((r) => keeping.listen(0, "127.0.0.1", r));
  const kept = `http://127.0.0.1:${keeping.address().port}/v1/models`;
  await new Promise((resolve, reject) => http.get(kept, (res) => res.resume().on("end", resolve)).on("error", reject));
  for (let i = 0; i < 200 && !Object.keys(http.globalAgent.freeSockets).length; i++) await sleep(10);
  cut = true;
  const pooled = await upstreamRequest(kept, { method: "GET", headers: {} }).catch((e) => e);
  assert.deepEqual([sockets.size, pooled.unsent], [1, false], "the same connection carried both requests");

  const dir = mkdtempSync(join(tmpdir(), "relay-unsent-"));
  const opened = [];
  const open = async (sub, origin, extra = {}) => {
    const r = await openRelay({ key: KEY, dir: join(dir, sub), maxUsd: 25, origin, lookupDelaysMs: [1], callLog: join(dir, sub, "usage", CALL_LOG), ...extra });
    opened.push(r);
    r.beginPass(25);
    return r;
  };
  try {
    // Through the relay: never-sent calls, each $0 and no unknown cost, the worker told it may try again.
    const a = await open("a", closed.origin);
    for (let i = 0; i <= SIX; i++) {
      const r = await call(a.socketPath, { token: a.token });
      assert.equal(r.status, 502);
      assert.match(JSON.parse(r.text).error.message, /could not be reached \(ECONNREFUSED\): the call never left this machine, so nothing was billed/);
    }
    const pa = await a.endPass();
    assert.deepEqual([pa.usd, pa.calls, pa.unknown], [0, 0, 0]);
    assert.deepEqual([a.totals().failed], [SIX + 1]);
    const unsent = logLines(join(dir, "a", "usage", CALL_LOG));
    assert.ok(unsent.length === SIX + 1 && unsent.every((l) => l.status === null && l.basis === "unsent" && l.usd === 0 && l.why === "the call never left this machine: ECONNREFUSED"), JSON.stringify(unsent[0]));
    // The same over TLS, reset in the handshake.
    const b = await open("b", `https://127.0.0.1:${peer.port}`);
    assert.equal((await call(b.socketPath, { token: b.token })).status, 502);
    assert.deepEqual([(await b.endPass()).usd, logLines(join(dir, "b", "usage", CALL_LOG))[0].basis], [0, "unsent"]);
    // Sent, then reset before any answer: a call of unknown cost.
    const c = await open("c", `http://127.0.0.1:${peer.port}`);
    const failed = await call(c.socketPath, { token: c.token });
    assert.equal(failed.status, 502);
    assert.match(JSON.parse(failed.text).error.message, /the AI Gateway call failed \(ECONNRESET\)$/);
    const pc = await c.endPass();
    assert.deepEqual([pc.usd, pc.unknown], [0, 1], "never $0 and never an estimate: unknown");
    assert.equal(logLines(join(dir, "c", "usage", CALL_LOG))[0].unpriced, "the call failed after it was sent: ECONNRESET; no generation id");
  } finally {
    for (const r of opened) await r.close();
    await peer.close();
    await closed.close();
    keeping.closeAllConnections();
    await new Promise((r) => keeping.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stream that ends cleanly with an error event and no finish is a failed call of unknown cost, and so is a complete answer with neither (#163, #483)", async () => {
  const failed = [{ type: "stream-start", warnings: [] }, { type: "text-delta", id: "0", delta: "par" }, { type: "error", error: { message: "Overloaded", type: "overloaded_error" } }];
  const gw = await fakeGateway({
    "/v4/ai/language-model": (body) => {
      const mode = JSON.parse(body || "{}").mode;
      if (mode === "error") return { type: "text/event-stream", body: sse(failed) };
      if (mode === "errorWithId") return { type: "text/event-stream", headers: { "x-generation-id": "gen_ERRSTREAM0001" }, body: sse(failed) };
      // No finish and no error: a complete answer that names no cost.
      if (mode === "noFinish") return { type: "text/event-stream", body: sse(failed.slice(0, 2)) };
      return { type: "text/event-stream", body: sse([{ type: "stream-start" }, { type: "finish", finishReason: "stop", providerMetadata: { gateway: { cost: "0.002" } } }]) };
    },
    "/v1/generation": (_b, req) => (req.url.includes("gen_ERRSTREAM0001") ? { body: { data: { total_cost: 0.004 } } } : { status: 404, body: {} }),
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-errstream-"));
  const relay = await openRelay({ key: KEY, dir: join(dir, "r"), maxUsd: 25, origin: gw.origin, lookupDelaysMs: [1], callLog: join(dir, "usage", CALL_LOG) });
  const go = (mode) => call(relay.socketPath, { token: relay.token, path: "/v4/ai/language-model", body: JSON.stringify({ mode }) });
  try {
    relay.beginPass(25);
    assert.equal((await go("error")).status, 200, "the worker gets the stream, its error event included");
    assert.equal((await go("errorWithId")).status, 200);
    assert.equal((await go("ok")).status, 200, "still relaying");
    let pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.unknown], [0.006, 3, 1], "one of unknown cost, its record's 0.004 for the one that named a generation, and the priced call");
    const lines = logLines(join(dir, "usage", CALL_LOG));
    assert.deepEqual(lines.filter((l) => !("reconciled" in l)).map((l) => [l.status, l.basis, l.usd]), [[200, "unknown", null], [200, "unknown", null], [200, "reported", 0.002]]);
    assert.equal(lines[0].unpriced, "the stream carried an error event and no finish; no generation id");
    assert.deepEqual(lines.filter((l) => "reconciled" in l).map((l) => [l.id, l.basis, l.usd, l.reconciled]), [["gen_ERRSTREAM0001", "lookup", 0.004, 0.004]]);
    // A stream with neither is a complete answer the relay cannot price: a call of unknown cost.
    relay.beginPass(25);
    assert.equal((await go("noFinish")).status, 200);
    pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.unknown], [0, 1]);
  } finally {
    await relay.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #163 review: the money and walk-away sequences ---

const LANG = "/v4/ai/language-model";

/** A stand-in for /tmp under the real one: sticky (mode 1700), its owner taken for root's in the calls below. */
function stickyRoot() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "fxr-"));
  chmodSync(root, 0o1700);
  return root;
}

test("the socket's root must be root's and sticky: a non-sticky stand-in is refused with a named reason, and the stage Blocks with nothing made (#185)", async () => {
  const uid = process.getuid();
  assert.equal(checkSocketRoot(RELAY_SOCKET_ROOT), realpathSync(RELAY_SOCKET_ROOT), "this machine's /tmp passes");
  const root = mkdtempSync(join(realpathSync("/tmp"), "fxr-"));
  try {
    chmodSync(root, 0o777);
    assert.throws(() => checkSocketRoot(root, { rootUid: uid }), new RegExp(`^Error: ${root} has no sticky bit \\(mode 777\\), so another user could swap the socket's directory there`));
    chmodSync(root, 0o1777);
    assert.throws(() => checkSocketRoot(root), new RegExp(`^Error: ${root} is not owned by root`), "sticky, but not root's");
    assert.equal(checkSocketRoot(root, { rootUid: uid }), root);
    chmodSync(root, 0o777);
    const shell = { [RELAYED_NAME]: KEY };
    for (const env of [{ PENDULUM_LOCAL: "1", PATH: "/nope" }, { PATH: "/nope" }]) {
      const r = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: join(root, "u"), env, which: (n) => `/usr/bin/${n}`, socketRoot: root, socketRootUid: uid });
      assert.equal(r.relay, null);
      assert.match(r.blocked, new RegExp(`^the gateway relay for ${RELAYED_NAME} could not start: its socket's directory: ${root} has no sticky bit`));
      assert.ok(!(RELAYED_NAME in r.shell), "the key is out of the shell");
      assert.deepEqual(readdirSync(root), [], "no directory made, no fallback either");
    }
    // The loop refuses it too, and hands nothing.
    assert.throws(() => handSocketDir(join(root, "u"), { root, rootUid: uid }), /has no sticky bit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused per-user directory: the stage's socket goes in a private mkdtemp directory, handed from the loop locally, checked, and removed with the stage; the path limit still holds there (#185)", { skip: process.platform === "win32" && "unix" }, async () => {
  const uid = process.getuid();
  const root = stickyRoot();
  const shell = { [RELAYED_NAME]: KEY };
  const opts = { socketRoot: root, socketRootUid: uid };
  try {
    // Another user's stand-in at the per-user name: a file (a directory of theirs, or one open to others, is refused the same way).
    writeFileSync(join(root, `pendulum-relay-${uid}`), "taken");
    // A developer's own session: the stage falls back itself.
    const own = await openWorkerRelay({ inputs: { harness: "claude", maxUsd: 5 }, shell, usageDir: join(root, "u1"), env: { PATH: "/nope" }, ...opts });
    assert.equal(own.blocked, null, own.blocked);
    const fallback = dirname(own.relay.socketPath);
    assert.match(fallback, new RegExp(`^${root}/pendulum-relay-${uid}-[A-Za-z0-9]{6}$`));
    assert.equal(statSync(fallback).mode & 0o7777, 0o700);
    assert.equal(statSync(own.relay.socketPath).mode & 0o777, 0o600);
    await closeWorkerRelay(own.relay);
    assert.ok(!existsSync(fallback), "removed with the stage");

    // Local mode with nothing handed: refused, never a directory the outer sandbox does not name.
    const unhanded = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: join(root, "u2"), env: { PENDULUM_LOCAL: "1", PATH: "/nope" }, which: (n) => `/usr/bin/${n}`, ...opts });
    assert.match(unhanded.blocked, /its socket's directory: .*pendulum-relay-\d+ is not a directory/);

    // Local mode: the loop makes the private directory, records it, names it in the outer sandbox and hands it over.
    const usageDir = join(root, "u3");
    mkdirSync(usageDir);
    const m = handSocketDir(usageDir, { root, rootUid: uid });
    assert.match(m.refused, /pendulum-relay-\d+ is not a directory/);
    assert.match(m.dir, new RegExp(`^${root}/pendulum-relay-${uid}-[A-Za-z0-9]{6}$`));
    assert.equal(readSocketDirRecord(usageDir).dir, m.dir);
    const outer = harnessOuterSettings({ harness: "codex", writable: ["/w"], relaySocketDir: m.dir, env: {} });
    assert.ok(!outer.filesystem.denyRead.some((p) => m.dir === p || m.dir.startsWith(`${p}/`)), "the outer sandbox keeps it reachable");
    const handed = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir, env: { PENDULUM_LOCAL: "1", PATH: "/nope", [RELAY_SOCKET_DIR_ENV]: m.dir }, which: (n) => `/usr/bin/${n}`, ...opts });
    assert.equal(handed.blocked, null, handed.blocked);
    assert.equal(dirname(handed.relay.socketPath), m.dir);
    await closeWorkerRelay(handed.relay);
    assert.equal(dropSocketDir(usageDir, { root, rootUid: uid }), false, "already gone with the stage");
    assert.equal(readSocketDirRecord(usageDir), null);

    // A handed path that is not one of this user's socket directories there is refused, even where recorded.
    writeFileSync(join(usageDir, SOCKET_DIR_RECORD), JSON.stringify({ dir: join(root, "elsewhere") }));
    const odd = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir, env: { PENDULUM_LOCAL: "1", PATH: "/nope", [RELAY_SOCKET_DIR_ENV]: join(root, "elsewhere") }, which: (n) => `/usr/bin/${n}`, ...opts });
    assert.match(odd.blocked, /is not a socket directory of this user's under/);

    // The path limit, for the fallback too: a stand-in root deep enough that the private directory's socket passes it.
    const deep = join(root, "d".repeat(80));
    mkdirSync(deep, { mode: 0o1700 });
    chmodSync(deep, 0o1700);
    writeFileSync(join(deep, `pendulum-relay-${uid}`), "taken");
    const long = await openWorkerRelay({ inputs: { harness: "claude", maxUsd: 5 }, shell, usageDir: join(root, "u4"), env: { PATH: "/nope" }, socketRoot: deep, socketRootUid: uid });
    assert.match(long.blocked, new RegExp(`could not start: its socket's path would be \\d+ bytes, over this system's limit of ${UNIX_SOCKET_PATH_MAX} for a Unix socket \\(${deep}/pendulum-relay-${uid}-`));
    assert.deepEqual(readdirSync(deep), [`pendulum-relay-${uid}`], "the private directory removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after the listen the socket must be in the very directory checked: a directory swapped before the listen, or swapped back after it, Blocks with nothing handed over (#185)", { skip: process.platform === "win32" && "unix" }, async () => {
  const uid = process.getuid();
  const root = stickyRoot();
  const shell = { [RELAYED_NAME]: KEY };
  const opened = [];
  try {
    // What only a writable, non-sticky /tmp would allow: the checked directory renamed away, another put in its place.
    const swap = (back) => async (o) => {
      renameSync(o.socketDir, `${o.socketDir}.aside`);
      mkdirSync(o.socketDir, { mode: 0o700 });
      const relay = await openRelay(o);
      if (back) {
        renameSync(o.socketDir, `${o.socketDir}.other`);
        renameSync(`${o.socketDir}.aside`, o.socketDir);
      }
      return relay;
    };
    // Any relay a failed check let start is closed below, so a failure here never hangs the run.
    for (const [back, why] of [[false, /was replaced after it was checked/], [true, /no socket of this user's is at .* after the listen/]]) {
      const usageDir = join(root, `u-${back}`);
      const r = await openWorkerRelay({ inputs: { harness: "claude", maxUsd: 5 }, shell, usageDir, env: { PATH: "/nope" }, open: swap(back), socketRoot: root, socketRootUid: uid });
      if (r.relay) opened.push(r.relay);
      assert.equal(r.relay, null);
      assert.match(r.blocked, new RegExp(`^the gateway relay for ${RELAYED_NAME} could not start: its socket's directory: `));
      assert.match(r.blocked, why);
      assert.ok(!(RELAYED_NAME in r.shell), "the key is out of the shell");
    }
  } finally {
    for (const r of opened) await closeWorkerRelay(r);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a loop's reap removes the socket directory of a dead stage, never a live one's or a path of another shape (#185)", { skip: process.platform !== "linux" && "process records read /proc" }, async () => {
  const uid = process.getuid();
  const root = stickyRoot();
  const ws = join(root, "ws");
  // A process record of a process that has exited.
  const gone = spawn("sleep", ["30"]);
  const dead = processRecord(gone.pid);
  gone.kill("SIGKILL");
  await new Promise((r) => gone.on("exit", r));
  const stages = {
    "usage-work-dead": { stage: dead },
    "usage-work-live": { stage: processRecord() },
    "usage-work-unstarted-dead-loop": { owner: dead },
    "usage-work-unstarted-live-loop": {},
  };
  try {
    const dirs = {};
    for (const [name, rec] of Object.entries(stages)) {
      const usageDir = join(ws, name);
      mkdirSync(usageDir, { recursive: true });
      dirs[name] = handSocketDir(usageDir, { root, rootUid: uid }).dir;
      if (rec.stage) writeFileSync(join(usageDir, STAGE_RECORD), JSON.stringify(rec.stage));
      if (rec.owner) writeFileSync(join(usageDir, SOCKET_DIR_RECORD), JSON.stringify({ dir: dirs[name], owner: rec.owner }));
    }
    // A record naming some other directory of this user's: never removed.
    const other = join(root, "keep-me");
    mkdirSync(other);
    mkdirSync(join(ws, "usage-odd"));
    writeFileSync(join(ws, "usage-odd", SOCKET_DIR_RECORD), JSON.stringify({ dir: other, owner: dead }));

    assert.equal(reapSocketDirs(ws, { root, rootUid: uid }), 2);
    assert.ok(!existsSync(dirs["usage-work-dead"]), "a dead stage's: removed");
    assert.ok(!existsSync(dirs["usage-work-unstarted-dead-loop"]), "one whose loop died before the stage started: removed");
    assert.ok(existsSync(dirs["usage-work-live"]), "a live stage's: kept");
    assert.ok(existsSync(dirs["usage-work-unstarted-live-loop"]), "one a live loop is starting a stage with: kept");
    assert.ok(existsSync(other), "a path of another shape: kept");
    assert.ok(existsSync(join(root, `pendulum-relay-${uid}`)), "the per-user directory stays");
    assert.equal(reapSocketDirs(ws, { root, rootUid: uid }), 0, "done once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local mode hands a socket directory only to a stage that relays the gateway key (#185)", () => {
  const env = (v) => ({ PENDULUM_WORKER_SECRETS: v });
  assert.equal(relaysGatewayKey("worker.mjs", env("AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY")), true);
  assert.equal(relaysGatewayKey("review.mjs", env("FAL_KEY, AI_GATEWAY_API_KEY=W")), true);
  assert.equal(relaysGatewayKey("merge.mjs", env("AI_GATEWAY_API_KEY=W")), false);
  assert.equal(relaysGatewayKey("worker.mjs", env("FAL_KEY")), false);
  assert.equal(relaysGatewayKey("worker.mjs", {}), false);
});

test("removing a socket directory never goes through a link: a recorded path whose per-user parent is now a link to elsewhere stays, by reap and at the stage's end (#185)", { skip: process.platform !== "linux" && "process records read /proc" }, async () => {
  const uid = process.getuid();
  const root = stickyRoot();
  try {
    // A dead stage's record; then /tmp cleared (a reboot) and another user's link planted at the per-user name.
    const gone = spawn("sleep", ["30"]);
    const dead = processRecord(gone.pid);
    gone.kill("SIGKILL");
    await new Promise((r) => gone.on("exit", r));
    const hash = "0123456789ab";
    const elsewhere = join(root, "clone", "x");
    mkdirSync(join(elsewhere, hash), { recursive: true });
    for (const d of [join(root, "clone"), elsewhere, join(elsewhere, hash)]) chmodSync(d, 0o700);
    writeFileSync(join(elsewhere, hash, "precious.txt"), "keep");
    symlinkSync(elsewhere, join(root, `pendulum-relay-${uid}`));
    const dir = join(root, `pendulum-relay-${uid}`, hash);
    const ws = join(root, "ws");
    for (const name of ["usage-work-dead", "usage-work-ended"]) {
      mkdirSync(join(ws, name), { recursive: true });
      writeFileSync(join(ws, name, SOCKET_DIR_RECORD), JSON.stringify({ dir, owner: dead }));
    }
    assert.equal(reapSocketDirs(ws, { root, rootUid: uid }), 0);
    assert.equal(dropSocketDir(join(ws, "usage-work-ended"), { root, rootUid: uid }), false);
    assert.ok(existsSync(join(elsewhere, hash, "precious.txt")), "nothing removed through the link");
    for (const name of ["usage-work-dead", "usage-work-ended"]) assert.equal(readSocketDirRecord(join(ws, name)), null, "the records go");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locally the stage takes only the socket directory made for it: another stage's live one, or one with no record, is refused; an unrecorded directory is never left behind (#185)", { skip: process.platform === "win32" && "unix" }, async () => {
  const uid = process.getuid();
  const root = stickyRoot();
  const shell = { [RELAYED_NAME]: KEY };
  const opts = { socketRoot: root, socketRootUid: uid };
  const env = (dir) => ({ PENDULUM_LOCAL: "1", PATH: "/nope", [RELAY_SOCKET_DIR_ENV]: dir });
  // Any relay a failed check let start is closed below, so a failure here never hangs the run.
  const opened = [];
  try {
    const [a, b] = ["a", "b"].map((n) => {
      const usageDir = join(root, `usage-${n}`);
      mkdirSync(usageDir);
      return { usageDir, dir: handSocketDir(usageDir, { root, rootUid: uid }).dir };
    });
    // Stage a handed stage b's directory: one of this user's, of the right shape, yet not its own.
    const other = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: a.usageDir, env: env(b.dir), which: (n) => `/usr/bin/${n}`, ...opts });
    if (other.relay) opened.push(other.relay);
    assert.equal(other.relay, null);
    assert.match(other.blocked, new RegExp(`its socket's directory: ${b.dir} is not the directory made for this stage`));
    assert.ok(!(RELAYED_NAME in other.shell));
    const unrecorded = join(root, "usage-c");
    mkdirSync(unrecorded);
    const none = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: unrecorded, env: env(a.dir), which: (n) => `/usr/bin/${n}`, ...opts });
    if (none.relay) opened.push(none.relay);
    assert.match(none.blocked, /is not the directory made for this stage/);
    const own = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: a.usageDir, env: env(a.dir), which: (n) => `/usr/bin/${n}`, ...opts });
    if (own.relay) opened.push(own.relay);
    assert.equal(own.blocked, null, own.blocked);
    assert.equal(dirname(own.relay.socketPath), a.dir);
    await closeWorkerRelay(own.relay);
    assert.ok(existsSync(b.dir), "the other stage's directory untouched");

    // The record cannot be written (here: no usage directory): the directory just made goes too.
    const missing = join(root, "usage-missing");
    assert.throws(() => handSocketDir(missing, { root, rootUid: uid }), /ENOENT/);
    assert.ok(!existsSync(relaySocketDir(missing, { root })), "no directory left without a record");
  } finally {
    for (const r of opened) await closeWorkerRelay(r);
    rmSync(root, { recursive: true, force: true });
  }
});

test("#483 review: a stream of several finish events is priced from its generation's record, never its dearest event; with no generation it is of unknown cost", async () => {
  const fin = (cost) => ({ type: "finish", finishReason: "stop", providerMetadata: { gateway: { cost: String(cost) } } });
  const gw = await fakeGateway({
    [LANG]: (body) => {
      const { mode, id } = JSON.parse(body || "{}");
      if (mode === "two") return { type: "text/event-stream", headers: { "x-generation-id": id }, body: sse([{ type: "stream-start" }, fin(0.9), fin(0.02)]) };
      if (mode === "twoNoId") return { type: "text/event-stream", body: sse([{ type: "stream-start" }, fin(0.9), fin(0.02)]) };
      // A complete answer naming no cost: its only price is its generation's record.
      return { headers: { "x-generation-id": id }, body: {} };
    },
    "/v1/generation": (_b, req) => {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (id === "gen_TWOFINISH0001") return { body: { data: { total_cost: 0.05 } } };
      return { status: 503, body: { error: "down" } };
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-finish-"));
  const r = await openRelay({ key: KEY, dir: join(dir, "r"), maxUsd: 25, origin: gw.origin, lookupDelaysMs: [1, 1] });
  try {
    const go = (body) => call(r.socketPath, { token: r.token, path: LANG, body: JSON.stringify(body) });
    r.beginPass(25);
    assert.equal((await go({ mode: "two", id: "gen_TWOFINISH0001" })).status, 200);
    assert.equal((await go({ mode: "twoNoId" })).status, 200);
    const pass = await r.endPass();
    assert.deepEqual([pass.usd, pass.unknown, pass.calls], [0.05, 1, 2], "the record's $0.05, never the dearest event's $0.90; with no generation, unknown");
  } finally {
    await r.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
