import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RELAYED_NAME, RELAY_PING, addKeySpend, costOf, keyCutter, openRelay, routeOf, tokenMatches } from "../scripts/lib/gateway-relay.mjs";
import { relayProbeCommand, relayShimScript, writeRelayShim } from "../scripts/lib/relay-shim.mjs";
import { openWorkerRelay, unrelayedGatewayKeys } from "../scripts/lib/worker-relay.mjs";
import { keyBreakdown, writeUsage } from "../scripts/lib/session.mjs";
import { usdText } from "../scripts/lib/logic.mjs";
import { harnessOuterSettings } from "../scripts/lib/local.mjs";
import { secretForms } from "../scripts/lib/inputs.mjs";
import { costOf as benchCostOf } from "../../bench/lib/cost.mjs";
import { CODEX_PRICES } from "../scripts/lib/usage.mjs";

const KEY = "vck_worker_relay_0123456789abcdef";
const IMAGE = "/v4/ai/image-model";

/**
 * A stand-in AI Gateway on this machine's loopback: each path answers as `routes` says (a function gets the request's
 * body and may wait); every request is recorded.
 */
async function fakeGateway(routes) {
  const seen = [];
  const table = new Map(Object.entries(routes));
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, headers: req.headers });
    // Only the routes this test named (a Map: no inherited name is ever looked up).
    const route = table.get(req.url.split("?")[0]);
    // As the real gateway: a model call without its model header is refused (400), before any route answers.
    const kind = /^\/v\d+\/ai\/([a-z]+)-model$/.exec(req.url.split("?")[0])?.[1];
    if (kind && !req.headers[kind === "language" ? "ai-language-model-id" : "ai-model-id"]) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Missing or empty model identifier", type: "invalid_request_error" } }));
    }
    const r = typeof route === "function" ? await route(body, req) : route || { status: 404, body: { error: "no route" } };
    res.writeHead(r.status ?? 200, { "content-type": r.type || "application/json", ...(r.headers || {}) });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
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
    assert.equal((await call(relay.socketPath, { method: "GET", path: RELAY_PING })).text.trim(), `factory-relay ${relay.probeId}`);
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
    assert.deepEqual([pass.usd, pass.calls, pass.unpriced], [0.04, 1, 0], "the model list is free; the image is booked");
    assert.ok(sent);
  } finally {
    await relay.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay pricing: the larger of reported and looked up; a forged echo, an unknown cost, a 5xx or a hang-up fails closed, never $0", async () => {
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
    assert.deepEqual([pass.usd, pass.calls, pass.unpriced], [0.77, 3, 0], "0.5 (reported, looked up 0.5) + 0.25 (looked up over 0.1) + 0.02 (looked up)");
    relay.beginPass(100);
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/decision-model" })).status, 200);
    pass = await relay.endPass();
    assert.deepEqual([pass.unpriced, pass.usd], [1, 0], "no cost at the top level, no generation: unpriced");
    const rec = addKeySpend({ usd: 1, tokens: {} }, pass);
    assert.equal(rec.budgetExceeded, true, "an unpriced call ends the pass over budget: the stage Blocks");
    relay.beginPass(100);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 403, "and every later call is refused");
    assert.equal((await call(relay.socketPath, { token: relay.token, method: "GET", path: "/v1/models" })).status, 403, "the model list too");
    await relay.endPass();
    await relay.close();
    // A 5xx after the call was sent: unpriced.
    const r5 = await openRelay({ key: KEY, dir: join(dir, "b"), maxUsd: 100, origin: gw.origin, lookupDelaysMs: [5] });
    r5.beginPass(100);
    assert.equal((await call(r5.socketPath, { token: r5.token, path: "/v4/ai/embedding-model" })).status, 500);
    assert.equal((await r5.endPass()).unpriced, 1);
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
    assert.deepEqual([hung.usd, hung.calls, hung.unpriced], [0.3, 1, 0], "booked when it finished, though the client had gone");
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
  const rec = addKeySpend({ usd: 1.5, tokens: {} }, { usd: 0.8, calls: 2, unpriced: 0, capped: true });
  assert.deepEqual([rec.usd, rec.harnessUsd, rec.workerKeyUsd, rec.budgetExceeded], [2.3, 1.5, 0.8, true]);
  const lower = addKeySpend({ usd: null, tokens: {} }, { usd: 0.2, calls: 1, unpriced: 1, capped: false });
  assert.deepEqual([lower.usd, lower.usdLowerBound, lower.workerKeyUnpriced], [0.2, true, 1]);
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  try {
    const records = [{ harness: "claude", model: "m", usd: 2.3, harnessUsd: 1.5, workerKeyUsd: 0.8, tokens: { input: 1, output: 1, cached: 0 }, started: "a", ended: "b" }];
    const usage = writeUsage(dir, { harness: "claude", model: "m", records, passes: 1, exit: "delivered", reason: "", credentialBasis: "x", workerKey: { usd: 0.9, calls: 3, failed: 0, unpriced: 0, failClosed: false, capped: false, refused: { cap: 0 } } });
    assert.deepEqual([usage.usd, usage.workerKeyUsd, usage.harnessUsd], [2.4, 0.9, 1.5], "a call booked outside every pass still counts");
    assert.equal(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).workerKey.calls, 3);
    assert.equal(usdText(usage), "2.4 (harness 1.5, worker key 0.9)");
    assert.deepEqual(keyBreakdown([{ usd: 1 }]), { fields: {}, extra: 0 }, "no relay, no fields");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The scorecard: Codex's repriced dollars keep the key's spend, and the row names it.
  const row = benchCostOf([{ harness: "codex", model: "gpt-5", tokens: { input: 1_000_000, output: 0, cached: 0 }, workerKeyUsd: 0.5, artifact: "factory-usage-1" }], CODEX_PRICES);
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
    const run = (...a) => execFileSync(join(shimDir, "bwrap"), a, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", BASH_ENV: join(dir, "planted") } }).trim().split("\n");
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
    assert.match(relayProbeCommand(41234, "abc"), /factory-relay abc/);
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

test("worker relay: Copilot and a machine without socat Block with the key out of the shell; no relayed key, no relay", async () => {
  const shell = { [RELAYED_NAME]: KEY, FAL_KEY: "fal-0123456789" };
  const copilot = await openWorkerRelay({ inputs: { harness: "copilot", maxUsd: 5 }, shell, usageDir: "/nope" });
  assert.match(copilot.blocked, /does not reach Copilot's sandbox yet/);
  assert.deepEqual(copilot.shell, { FAL_KEY: "fal-0123456789" }, "never handed over");
  const none = await openWorkerRelay({ inputs: { harness: "claude", maxUsd: 5 }, shell: { FAL_KEY: "f" }, usageDir: "/nope" });
  assert.deepEqual([none.relay, none.blocked, none.shell], [null, null, { FAL_KEY: "f" }]);
  const noSocat = await openWorkerRelay({ inputs: { harness: "codex", maxUsd: 5 }, shell, usageDir: "/nope", env: { FACTORY_LOCAL: "1", PATH: "/nope" }, which: (n) => (n === "bwrap" ? "/usr/bin/bwrap" : null) });
  assert.match(noSocat.blocked, /needs socat/);
  assert.ok(!(RELAYED_NAME in noSocat.shell));
  assert.deepEqual(noSocat.masked, [KEY], "the key stays in the stage's mask list");
});

test("local mode: the outer sandbox keeps the relay's directory readable (never writable)", () => {
  const s = harnessOuterSettings({ harness: "codex", writable: ["/w"], relayDir: "/u/relay", env: {} });
  assert.ok(!s.filesystem.denyRead.some((p) => "/u/relay".startsWith(p)));
  assert.ok(!s.filesystem.allowWrite.includes("/u/relay"));
});

test("a relay probe that finds no forwarder Blocks with a fixed reason: no key handed over, nothing run", async () => {
  const { gitRefusalReason } = await import("../scripts/lib/local.mjs");
  const reason = gitRefusalReason("relay", 7, { harness: "codex", local: true });
  assert.match(reason, /gateway relay's forwarder did not come up in Codex's sandbox \(relay\); the harness was not started, and the key was never handed over/);
  assert.match(gitRefusalReason("relay", 7, { harness: "claude" }), /Claude Code's sandbox[^]*work job's log/);
});

test("doctor: the relayed key on Copilot, or without bwrap or socat, is a WARN that every stage Blocks; else a PASS", async () => {
  const { gatewayRelayChecks } = await import("../scripts/doctor.mjs");
  const spec = { workerSecrets: "AI_GATEWAY_API_KEY=W FAL_KEY" };
  assert.deepEqual(gatewayRelayChecks({ inputs: { ...spec, harness: "claude" }, env: {}, which: () => "/usr/bin/x" }).map((c) => c.status), ["PASS"]);
  assert.match(gatewayRelayChecks({ inputs: { ...spec, harness: "codex" }, env: { GITHUB_ACTIONS: "true" }, which: (b) => (b === "socat" ? null : "/usr/bin/bwrap") })[0].detail, /needs socat/);
  assert.match(gatewayRelayChecks({ inputs: { ...spec, harness: "copilot" }, env: {} })[0].detail, /Copilot's sandbox yet/);
  assert.deepEqual(gatewayRelayChecks({ inputs: { workerSecrets: "FAL_KEY", harness: "copilot" } }), [], "no relayed key, no check");
});

test("live harness spend: Claude Code's per-message usage, Codex's turns, Copilot's checkpoints; the relay's cap shares the pass's budget with it", async () => {
  const { claudeUsageUsd, liveSpend } = await import("../scripts/lib/live-spend.mjs");
  // Claude Code: a message's later lines carry its latest usage; each message counts once.
  const claude = liveSpend("claude", "claude-opus-5-5");
  const msg = (id, usage) => JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", usage } });
  claude.line(msg("m1", { input_tokens: 10, output_tokens: 1 }));
  claude.line(msg("m1", { input_tokens: 1_000_000, output_tokens: 0 }));
  claude.line(msg("m2", { input_tokens: 0, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }));
  assert.equal(Math.round((await claude.usd()) * 1e4) / 1e4, 4 + 2 + 0.2 + 8, "$4 input + $2 output + $0.20 cache reads + $8 1-hour writes");
  assert.equal(claudeUsageUsd({ output_tokens: 1_000_000 }, "claude-unknown-9"), 50, "an unlisted model at the dearest row");
  // Codex: turns summed, a resumed thread's earlier total taken off.
  const codex = liveSpend("codex", "gpt-5", { prior: { tokens: { input: 500_000, output: 0 } } });
  codex.line(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
  codex.line(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500_000, output_tokens: 0 } }));
  assert.equal(await codex.usd(), CODEX_PRICES.perMillion["gpt-5"].input);
  // Within a turn the stream says nothing yet: the thread's rollout does.
  const rolled = liveSpend("codex", "gpt-5", { rollout: async (id) => (id === "t-1" ? ['{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2000000,"output_tokens":0}}}}', "{}"].join("\n") : "") });
  rolled.line(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
  assert.equal(await rolled.usd(), 2 * CODEX_PRICES.perMillion["gpt-5"].input);
  // Codex 0.167 writes a token_usage_record per response before its tool call runs: summed, this thread's only.
  const records = liveSpend("codex", "gpt-5", { rollout: async () => [JSON.stringify({ type: "token_usage_record", payload: { thread_id: "t-2", usage: { input_tokens: 900000 } } }), JSON.stringify({ type: "token_usage_record", payload: { thread_id: "other", usage: { input_tokens: 5e6 } } }), JSON.stringify({ type: "token_usage_record", payload: { thread_id: "t-2", usage: { input_tokens: 100000 } } })].join("\n") });
  records.line(JSON.stringify({ type: "thread.started", thread_id: "t-2" }));
  assert.equal(await records.usd(), CODEX_PRICES.perMillion["gpt-5"].input);
  // Copilot: its running AI credits at the run's dollars per credit.
  const copilot = liveSpend("copilot", null, { creditUsd: 0.01 });
  copilot.line(JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu: 5e10 } }));
  assert.equal(await copilot.usd(), 0.5);
  assert.equal(await liveSpend("claude").usd(), 0, "nothing yet");

  // The relay: $1 left; the harness has already spent $0.95 of it, so a $0.10 key call is refused (402).
  const gw = await fakeGateway({ [IMAGE]: priced(0.1), "/v1/generation": { body: { data: { total_cost: 0.1 } } } });
  const dir = mkdtempSync(join(tmpdir(), "relay-live-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 5, origin: gw.origin, lookupDelaysMs: [1] });
    let harness = 0.5;
    relay.beginPass(1, () => harness);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 200, "$0.50 by the harness: room left");
    harness = 0.95;
    const refused = await call(relay.socketPath, { token: relay.token });
    assert.equal(refused.status, 402);
    assert.match(JSON.parse(refused.text).error.message, /\$0\.10 spent through the key and \$0\.95 by the model/);
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.capped], [0.1, true]);
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
    assert.deepEqual([pass.usd, pass.calls, pass.unpriced], [0.047, 4, 0], "0.007 image + 0 text (its record never came: the reported 0 stands, no Block) + 0.02 for each stream (its record's 0.02 over the reported 0, and the one that reported none)");
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

test("the re-review's minors: unbilled only for known refusals, a stream's cost from its finish event, bounded waiters, a pass's end refuses the queue, an unreadable live figure refuses the call", async () => {
  let hold = null;
  const gw = await fakeGateway({
    "/v4/ai/image-model": async (body) => {
      const j = JSON.parse(body || "{}");
      if (j.status) return { status: j.status, body: {} };
      if (j.wait) await new Promise((r) => (hold = r));
      return priced(1);
    },
    // A stream whose later event carries a forged $0 (F): the finish event's $1 counts.
    "/v4/ai/language-model": { type: "text/event-stream", body: [{ type: "finish", providerMetadata: { gateway: { cost: "1.0" } } }, { type: "tool-call", providerMetadata: { gateway: { cost: 0 } } }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-minors-"));
  const mk = (sub, maxUsd = 100) => openRelay({ key: KEY, dir: join(dir, sub), maxUsd, origin: gw.origin, lookupDelaysMs: [1] });
  try {
    // E: 400, 401, 403, 404, 413, 422, 429 are free; another 4xx (409, 408, 499) fails closed.
    const out = {};
    for (const status of [400, 404, 422, 429, 408, 409, 499]) {
      const r = await mk(`e${status}`);
      r.beginPass(100);
      await call(r.socketPath, { token: r.token, body: JSON.stringify({ status }) });
      out[status] = (await r.endPass()).unpriced ? "closed" : "free";
      await r.close();
    }
    assert.deepEqual(out, { 400: "free", 404: "free", 422: "free", 429: "free", 408: "closed", 409: "closed", 499: "closed" });
    // F
    const f = await mk("f");
    f.beginPass(100);
    await call(f.socketPath, { token: f.token, path: "/v4/ai/language-model" });
    assert.equal((await f.endPass()).usd, 1);
    await f.close();
    // G and C: one in flight, a bounded queue; at the pass's end the queue is refused, never sent.
    const g = await mk("g");
    g.beginPass(100);
    const first = call(g.socketPath, { token: g.token, body: '{"wait":true}' });
    await new Promise((r) => setTimeout(r, 100));
    const queued = Array.from({ length: 10 }, () => call(g.socketPath, { token: g.token }).then((x) => x.status));
    await new Promise((r) => setTimeout(r, 100));
    const ended = g.endPass();
    hold();
    const statuses = await Promise.all(queued);
    assert.equal(statuses.filter((x) => x === 429).length, 2, "8 wait; the 9th and 10th get 429");
    assert.ok(statuses.every((x) => x === 429 || x === 403), `the queue is refused at the pass's end: ${statuses}`);
    assert.equal((await first).status, 200);
    const pass = await ended;
    assert.deepEqual([pass.usd, pass.calls], [1, 1], "the call in flight is booked into the ending pass");
    assert.equal(g.totals().calls, 1, "none of the queue was sent");
    await g.close();
    // B: an unreadable or non-number live figure refuses the call (503); a number lets it through.
    const b = await mk("b", 5);
    for (const live of [() => Promise.reject(new Error("rollout unreadable")), () => Number.NaN, () => "1", () => undefined]) {
      b.beginPass(5, live);
      assert.equal((await call(b.socketPath, { token: b.token })).status, 503);
      await b.endPass();
    }
    b.beginPass(5, () => 0.5);
    assert.equal((await call(b.socketPath, { token: b.token })).status, 200);
    await b.endPass();
    await b.close();
  } finally {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // B: an unset or unlisted Codex model is priced at the table's dearest rates, never $0.
  const { codexUsd } = await import("../scripts/lib/live-spend.mjs");
  const dearest = Math.max(...Object.values(CODEX_PRICES.perMillion).map((r) => r.input));
  assert.equal(codexUsd(null, { input: 1_000_000, output: 0 }), dearest);
  assert.equal(codexUsd("some/unknown-model", { input: 1_000_000, output: 0 }), dearest);
  // H: --level-prefix takes no value, so the separator after it is found.
  const shim = relayShimScript({ bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat", socket: "/s/r.sock", port: 41234 });
  assert.match(shim, /--assert-userns-disabled\|--level-prefix\) n=0/);
  // The relay's address and the state directory from anywhere but Factory never reach a child.
  const { scrubbedEnv } = await import("../scripts/lib/harness.mjs");
  const scrubbed = scrubbedEnv({ FACTORY_GATEWAY_URL: "http://evil", FACTORY_STATE_DIR: "/evil", PATH: "/bin" });
  assert.deepEqual(scrubbed, { PATH: "/bin" });
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
