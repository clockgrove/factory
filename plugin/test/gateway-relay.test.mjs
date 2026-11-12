import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATEWAY_ORIGIN, RELAYED_NAME, RELAY_PING, addKeySpend, costOf, keyCutter, openRelay, tokenMatches, upstreamUrl } from "../scripts/lib/gateway-relay.mjs";
import { relayProbeCommand, relayShimScript, writeRelayShim } from "../scripts/lib/relay-shim.mjs";
import { openWorkerRelay } from "../scripts/lib/worker-relay.mjs";
import { keyBreakdown, writeUsage } from "../scripts/lib/session.mjs";
import { usdText } from "../scripts/lib/logic.mjs";
import { harnessOuterSettings } from "../scripts/lib/local.mjs";
import { costOf as benchCostOf } from "../../bench/lib/cost.mjs";
import { CODEX_PRICES } from "../scripts/lib/usage.mjs";

const KEY = "vck_worker_relay_0123456789abcdef";

/** A stand-in AI Gateway on this machine's loopback: each path answers as `routes` says; every request is recorded. */
async function fakeGateway(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const r = routes[req.url.split("?")[0]] || { status: 404, body: { error: "no route" } };
      res.writeHead(r.status ?? 200, { "content-type": r.type || "application/json", ...(r.headers || {}) });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** One request to the relay's socket: {status, text}. */
function call(socketPath, { method = "POST", path = "/v4/ai/image-model", token, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : body);
  });
}

test("costOf: the gateway's reported cost (JSON or a stream), else its generation id, else the price table; never $0 by default", () => {
  assert.deepEqual(costOf(JSON.stringify({ images: ["x"], providerMetadata: { gateway: { cost: "0.04", generationId: "gen_A1" } } })), { usd: 0.04 });
  assert.deepEqual(costOf(JSON.stringify({ answers: {}, providerMetadata: { gateway: { generationId: "gen_B2" } } })), { generationId: "gen_B2" });
  const sse = ['data: {"type":"text-delta","delta":"hi"}', 'data: {"type":"finish","providerMetadata":{"gateway":{"cost":0.0123}}}', "data: [DONE]"].join("\n\n");
  assert.deepEqual(costOf(sse, "text/event-stream"), { usd: 0.0123 });
  assert.deepEqual(costOf(JSON.stringify({ id: "gen_C3", model: "unknown/model" })), { generationId: "gen_C3" });
  const table = costOf(JSON.stringify({ model: "openai/gpt-5", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
  assert.equal(table.usd, CODEX_PRICES.perMillion["gpt-5"].input, "the Codex price table (#86) for a listed model's tokens");
  assert.equal(costOf(JSON.stringify({ ok: true })), null, "no cost, no generation, no priced tokens: unpriced");
  assert.equal(costOf("not json"), null);
  assert.equal(costOf(JSON.stringify({ providerMetadata: { gateway: { cost: "-1" } } })), null, "a negative cost is no cost");
});

test("the relay's guards: Bearer token in constant time, only origin-relative paths on the gateway, the key cut from any response", () => {
  assert.equal(tokenMatches("Bearer abc", "abc"), true);
  assert.equal(tokenMatches("Bearer abd", "abc"), false);
  assert.equal(tokenMatches("abc", "abc"), false);
  assert.equal(tokenMatches(undefined, "abc"), false);
  assert.equal(upstreamUrl("/v4/ai/image-model?x=1").href, `${GATEWAY_ORIGIN}/v4/ai/image-model?x=1`);
  for (const bad of ["//evil.example/x", "http://evil.example/x", "evil", "/x\\y", "/a b", "", null]) assert.equal(upstreamUrl(bad), null, String(bad));
  const c = keyCutter(KEY);
  const out = Buffer.concat([c.push(`one ${KEY.slice(0, 9)}`), c.push(`${KEY.slice(9)} two ${KEY}`), c.end()]).toString();
  assert.equal(out, "one *** two ***");
});

test("relay: forwards with the key in the token's place, prices each call, refuses without the token, outside a pass, at the cap and after an unpriced call", async () => {
  const gw = await fakeGateway({
    "/v4/ai/image-model": { body: { images: ["aGk="], providerMetadata: { gateway: { cost: 0.04 } } } },
    "/v4/ai/echo-key": { body: { note: `the key was ${KEY}` }, headers: { "x-echo": KEY } },
    "/v4/ai/language-model": { body: { providerMetadata: { gateway: { generationId: "gen_L1" } } } },
    "/v1/generation": { body: { data: { total_cost: 0.25 } } },
    "/v4/ai/no-cost": { body: { ok: true } },
    "/v4/ai/rate-limited": { status: 429, body: { error: { message: "slow down" } } },
    "/v1/models": { body: { data: [] } },
  });
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const lines = [];
  const relay = await openRelay({ key: KEY, dir: join(dir, "r"), maxUsd: 10, origin: gw.origin, lookupDelaysMs: [10, 10], log: (l) => lines.push(l) });
  try {
    assert.equal(statSync(relay.socketPath).mode & 0o777, 0o600, "the socket is the owner's alone");
    assert.equal(statSync(join(dir, "r")).mode & 0o777, 0o700);
    assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(!relay.token.includes(KEY));
    // No token, a wrong one, outside a pass.
    assert.equal((await call(relay.socketPath, {})).status, 401);
    assert.equal((await call(relay.socketPath, { token: `${relay.token}x` })).status, 401);
    const outside = await call(relay.socketPath, { token: relay.token });
    assert.equal(outside.status, 403);
    assert.match(outside.text, /only while a Factory pass runs/);
    assert.equal(gw.seen.length, 0, "nothing reached the gateway");
    // The ping, without a token: the relay's probe id, nothing else.
    assert.equal((await call(relay.socketPath, { method: "GET", path: RELAY_PING })).text.trim(), `factory-relay ${relay.probeId}`);
    relay.beginPass(1);
    const img = await call(relay.socketPath, { token: relay.token, body: '{"prompt":"a raccoon"}' });
    assert.equal(img.status, 200);
    assert.equal(gw.seen.at(-1).auth, `Bearer ${KEY}`, "the gateway gets the key");
    assert.equal(gw.seen.at(-1).body, '{"prompt":"a raccoon"}');
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v1/models", method: "GET" })).status, 200, "GET is free");
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/rate-limited" })).status, 429, "a refused call is passed back, not billed");
    assert.equal((await call(relay.socketPath, { token: relay.token, path: "/v4/ai/language-model" })).status, 200);
    // Last: a response that names no cost (and echoes the key, which never comes back).
    const echo = await call(relay.socketPath, { token: relay.token, path: "/v4/ai/echo-key" });
    assert.ok(!echo.text.includes(KEY) && !JSON.stringify(echo.headers).includes(KEY), "the key never comes back");
    let pass = await relay.endPass();
    assert.equal(pass.usd, 0.29, "0.04 reported + 0.25 looked up; the echo call named no cost and failed closed");
    assert.equal(pass.unpriced, 1, "the echo call reported neither a cost nor a generation");
    assert.match(lines.join("\n"), /could not be determined/);
    // After an unpriced call: every later call is refused (fail closed), free ones still pass.
    relay.beginPass(5);
    const closed = await call(relay.socketPath, { token: relay.token });
    assert.equal(closed.status, 403);
    assert.match(closed.text, /cost could not be determined/);
    pass = await relay.endPass();
    assert.equal(pass.calls, 0);
    const t = relay.totals();
    assert.equal(t.failClosed, true);
    assert.ok(!JSON.stringify(t).includes(KEY) && !lines.join("\n").includes(KEY), "no total or log line carries the key");
  } finally {
    await relay.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay: once a pass's budget is spent the next call is refused at the cap; with no max_usd nothing is capped", async () => {
  const gw = await fakeGateway({ "/v4/ai/image-model": { body: { providerMetadata: { gateway: { cost: 0.4 } } } } });
  const dir = mkdtempSync(join(tmpdir(), "relay-cap-"));
  try {
    const relay = await openRelay({ key: KEY, dir: join(dir, "a"), maxUsd: 5, origin: gw.origin });
    relay.beginPass(1);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call(relay.socketPath, { token: relay.token })).status);
    const refused = await call(relay.socketPath, { token: relay.token });
    assert.deepEqual(codes, [200, 200, 402, 402], "0.4 + 0.4 spent, the next 0.4 would reach $1");
    assert.equal(refused.status, 402);
    assert.match(JSON.parse(refused.text).error.message, /max_usd is reached/);
    const pass = await relay.endPass();
    assert.deepEqual([pass.usd, pass.calls, pass.capped], [0.8, 2, true]);
    relay.beginPass(0);
    assert.equal((await call(relay.socketPath, { token: relay.token })).status, 402, "nothing left: nothing relayed");
    await relay.endPass();
    await relay.close();
    const free = await openRelay({ key: KEY, dir: join(dir, "b"), maxUsd: 0, origin: gw.origin });
    free.beginPass(0);
    for (let i = 0; i < 4; i++) assert.equal((await call(free.socketPath, { token: free.token })).status, 200);
    assert.equal((await free.endPass()).usd, 1.6);
    await free.close();
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

test("the shim wraps only a command sandbox (--unshare-net): forwarder, ping, then the command under its argv0; anything else as given", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-shim-"));
  try {
    // A stand-in bwrap that prints what it was asked to run.
    const fake = join(dir, "real-bwrap");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const shimDir = writeRelayShim(join(dir, "bin"), { bwrap: fake, socat: "/usr/bin/socat", socket: "/run/x/relay.sock", port: 41234 });
    assert.equal(statSync(shimDir).mode & 0o777, 0o755);
    const run = (...a) => execFileSync(join(shimDir, "bwrap"), a, { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(run("--version"), ["--version"]);
    assert.deepEqual(run("--ro-bind", "/", "/", "--", "/usr/bin/true"), ["--ro-bind", "/", "/", "--", "/usr/bin/true"], "no network namespace: as given");
    const wrapped = run("--unshare-net", "--argv0", "codex-linux-sandbox", "--", "/opt/codex", "--x");
    assert.deepEqual(wrapped.slice(0, 5), ["--unshare-net", "--argv0", "codex-linux-sandbox", "--", "/bin/bash"]);
    const script = wrapped.slice(6, -4).join("\n");
    assert.match(script, /'\/usr\/bin\/socat' TCP4-LISTEN:41234,bind=127\.0\.0\.1,fork,reuseaddr UNIX-CONNECT:'\/run\/x\/relay\.sock'/);
    assert.match(script, /\.factory-relay\/ping\?shim/);
    assert.deepEqual(wrapped.slice(-4), ["bash", "codex-linux-sandbox", "/opt/codex", "--x"], "the command and its argv0 follow");
    execFileSync("bash", ["-n", join(shimDir, "bwrap")]);
    assert.throws(() => relayShimScript({ bwrap: "bwrap", socat: "/usr/bin/socat", socket: "/s", port: 41234 }), /absolute/);
    assert.match(relayProbeCommand(41234, "abc"), /factory-relay abc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
