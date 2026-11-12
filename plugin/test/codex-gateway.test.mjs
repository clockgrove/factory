import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_PRICES, codexRate, jsonLines, parseCodex, parseUsage, priceCodex, providerRefusal, rotatedPin, sinceSession } from "../scripts/lib/usage.mjs";
import { SHELL_SECRET_KEYS, codexGatewayArgs, credentialEnv, gatewaySession, harnessCommand, hiddenFromShell, runHarness, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { CODEX_GATEWAY_ENV, FACTORY_SECRET_KEYS, MODEL_SECRET_KEYS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { parseWorkerSecrets } from "../scripts/lib/worker-secrets.mjs";
import { isSecretEnv, stageEnvironment } from "../scripts/launch.mjs";
import { gatewayKeyProbe, neededSecrets } from "../scripts/doctor.mjs";
import { fromCodexEvents, loadPrices, priceTokens } from "../../bench/lib/cost.mjs";
import { harnessActivity } from "../scripts/lib/logic.mjs";

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (f) => readFileSync(join(fixtures, f), "utf8");

// The table as listed on 2026-11-11 by OpenAI's pricing page and the AI Gateway's /v1/models: [input, cached, write, output]
// per million tokens, then the long-context (>272K input tokens) rates where the model has them.
const LISTED = {
  "gpt-6-astra": [10, 1, 12.5, 50, [20, 2, 25, 75]],
  "gpt-6.1-sol": [2, 0.1, 2.5, 10, [4, 0.2, 5, 15]],
  "gpt-6.1-terra": [1, 0.05, 1.25, 5, [2, 0.1, 2.5, 7.5]],
  "gpt-6-sol": [2, 0.2, 2.5, 10, [4, 0.4, 5, 15]],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5, [0.2, 0.02, 0.25, 0.75]],
  "gpt-5.6-sol": [4, 0.4, 5, 20, [8, 0.8, 10, 30]],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12, [4, 0.4, 5, 18]],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2, [0.4, 0.04, 0.5, 1.8]],
  "gpt-5.5": [5, 0.5, null, 30, [10, 1, null, 45]],
  "gpt-5.4": [2.5, 0.25, null, 15, [5, 0.5, null, 22.5]],
  "gpt-5.4-mini": [0.75, 0.075, null, 4.5],
  "gpt-5.4-nano": [0.2, 0.02, null, 1.25],
  "gpt-5.3-codex": [1.75, 0.175, null, 14],
  "gpt-5.2": [1.75, 0.175, null, 14],
  "gpt-5.2-codex": [1.75, 0.175, null, 14],
  "gpt-5.1": [1.25, 0.125, null, 10],
  "gpt-5.1-codex": [1.25, 0.13, null, 10],
  "gpt-5.1-codex-max": [1.25, 0.125, null, 10],
  "gpt-5.1-codex-mini": [0.25, 0.03, null, 2],
  "gpt-5": [1.25, 0.125, null, 10],
  "gpt-5-codex": [1.25, 0.13, null, 10],
  "gpt-5-mini": [0.25, 0.025, null, 2],
  "gpt-5-nano": [0.05, 0.005, null, 0.4],
};
const rates = ([input, cached, write, output]) => ({ input, cached, ...(write === null ? {} : { write }), output });

test("the Codex price table is the list price of 2026-11-11, dated, with both sources; the worker and the bench read one file", () => {
  assert.equal(CODEX_PRICES.date, "2026-11-11");
  assert.equal(CODEX_PRICES.status, "verified");
  assert.deepEqual(CODEX_PRICES.sources, ["https://developers.openai.com/api/docs/pricing", "https://ai-gateway.vercel.sh/v1/models"]);
  assert.equal(CODEX_PRICES.longContextAbove, 272000);
  const want = Object.fromEntries(Object.entries(LISTED).map(([m, r]) => [m, { ...rates(r), ...(r[4] ? { long: rates(r[4]) } : {}) }]));
  assert.deepEqual(CODEX_PRICES.perMillion, want);
  assert.deepEqual(loadPrices(), CODEX_PRICES, "the bench's table is the worker's");
});

test("Codex pricing: a provider prefix is stripped, a dated snapshot matches, nothing else borrows another model's rates", () => {
  const t = { input: 1_000_000, cached: 0, output: 0 };
  assert.equal(priceCodex("gpt-6.1-sol", t), 2);
  assert.equal(priceCodex("openai/gpt-6.1-sol", t), 2, "the gateway's id prices as the bare one");
  assert.equal(priceCodex("gpt-5.5-2026-04-23", t), 5, "a dated snapshot");
  assert.equal(priceCodex("gpt-5-mini", t), 0.25, "its own rate, not gpt-5's");
  assert.equal(priceCodex("gpt-5.5-pro", t), null, "unlisted: unmetered, never gpt-5.5's rate");
  assert.equal(priceCodex("anthropic/claude-x", t), null);
  assert.equal(codexRate(CODEX_PRICES, "openai/gpt-5.4")?.input, 2.5);
  assert.equal(priceTokens(CODEX_PRICES, "openai/gpt-6.1-sol", t), 2, "the bench prices the same way");
});

test("Codex through the gateway: cache writes parsed, priced at the write rate, and counted as a resumed pass's own share", () => {
  const fresh = parseCodex(fixture("codex-0.167-gateway-thread.jsonl"), "gpt-6.1-sol");
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.tokens, { input: 21572, output: 61, cached: 10725, written: 10841 });
  assert.deepEqual(fresh.cache.first, { unit: "turn", input: 21572, cached: 10725, written: 10841 });
  // 6 uncached at $2, 10,725 cached at $0.10, 10,841 written at $2.50, 61 out at $10 (per million).
  assert.equal(fresh.usd, Math.round(((6 * 2 + 10725 * 0.1 + 10841 * 2.5 + 61 * 10) / 1e6) * 10000) / 10000);
  assert.equal(fresh.usd, 0.0288);
  // The resume reported the thread's running total, after a model-change warning item: no failure.
  const resumed = parseCodex(fixture("codex-0.167-gateway-resumed.jsonl"), "gpt-6.1-sol");
  assert.equal(resumed.ok, true, "an item error the turn completed after is a warning");
  assert.equal(resumed.error, null);
  const own = sinceSession(resumed, { usd: fresh.usd, tokens: fresh.tokens });
  assert.deepEqual(own.tokens, { input: 22228, output: 61, cached: 21912, written: 310 });
  assert.deepEqual(own.cache.first, { unit: "turn", input: 22228, cached: 21912, written: 310 });
  // The bench reads a raw stream of both passes the same way.
  const raw = fromCodexEvents(`${fixture("codex-0.167-gateway-thread.jsonl")}${fixture("codex-0.167-gateway-resumed.jsonl")}`, "gpt-6.1-sol");
  assert.deepEqual(raw.tokens, { input: 43800, output: 122, cached: 32637, written: 11151 });
  // The live counter on the progress comment counts the resumed pass's own writes too.
  const live = harnessActivity();
  for (const l of fixture("codex-0.167-gateway-thread.jsonl").split("\n")) live.feed(l);
  assert.deepEqual(live.snapshot().tokens, { input: 21572, output: 61, written: 10841 });
  live.since("00000000-0000-0000-0000-000000000002", { usd: fresh.usd, tokens: fresh.tokens });
  for (const l of fixture("codex-0.167-gateway-resumed.jsonl").split("\n")) live.feed(l);
  assert.deepEqual(live.snapshot().tokens, { input: 21572 + 22228, output: 122, written: 10841 + 310 });
  // A model without a write rate bills its writes as input.
  assert.equal(priceCodex("gpt-5.4", { input: 1_000_000, cached: 0, written: 1_000_000, output: 0 }), 2.5);
  // An item error with no completed turn after it is the run's failure.
  const cut = parseCodex(fixture("codex-0.167-gateway-resumed.jsonl").split("\n").slice(0, 2).join("\n"), "gpt-6.1-sol");
  assert.equal(cut.ok, false);
  assert.match(cut.error, /recorded with model/);
});

test("the gateway route's Codex flags: provider, key name, session header, and the model as openai/<id> on a resume too", () => {
  const args = codexGatewayArgs({ session: "factory-abc" });
  assert.deepEqual(args, [
    "-c", 'model_provider="vercel"',
    "-c", 'model_providers.vercel.name="Vercel AI Gateway"',
    "-c", 'model_providers.vercel.base_url="https://ai-gateway.vercel.sh/codex/v1"',
    "-c", 'model_providers.vercel.env_key="FACTORY_CODEX_GATEWAY_KEY"',
    "-c", 'model_providers.vercel.wire_api="responses"',
    "-c", 'model_providers.vercel.env_http_headers={ "x-session-id" = "FACTORY_GATEWAY_SESSION" }',
  ]);
  const gateway = { session: "factory-abc" };
  const fresh = harnessCommand({ harness: "codex", model: "gpt-6.1-sol", prompt: "P", gateway });
  for (const a of args) assert.ok(fresh.args.includes(a), a);
  assert.deepEqual(fresh.args.slice(fresh.args.indexOf("-m"), fresh.args.indexOf("-m") + 2), ["-m", "openai/gpt-6.1-sol"]);
  assert.deepEqual(fresh.env, { FACTORY_GATEWAY_SESSION: "factory-abc" }, "the session id travels with the key to the agent uid");
  const resumed = harnessCommand({ harness: "codex", model: "gpt-6.1-sol", prompt: "P", resume: "t-1", gateway });
  assert.deepEqual(resumed.args.slice(resumed.args.indexOf("-m"), resumed.args.indexOf("-m") + 2), ["-m", "openai/gpt-6.1-sol"], "a resume keeps the thread's model");
  const prefixed = harnessCommand({ harness: "codex", model: "openai/gpt-5.5", prompt: "P", gateway });
  assert.ok(prefixed.args.includes("openai/gpt-5.5") && !prefixed.args.includes("openai/openai/gpt-5.5"));
  // The direct route is as before: no provider flags, and no model flag on a resume.
  const direct = harnessCommand({ harness: "codex", model: "gpt-6.1-sol", prompt: "P", resume: "t-1" });
  assert.ok(!direct.args.some((a) => a.startsWith("model_provider")) && !direct.args.includes("-m"));
  assert.deepEqual(direct.env, {});
  // Locally the gateway's host is among Codex's own API hosts and the flags are the same.
  const local = harnessCommand({ harness: "codex", model: "gpt-6.1-sol", prompt: "P", gateway, local: { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: [] } });
  assert.ok(local.args.includes('model_provider="vercel"') && local.env.FACTORY_GATEWAY_SESSION === "factory-abc");
});

test("the gateway credential: preferred over CODEX_API_KEY, alone in the child, a stint's session id, never on a login run", async () => {
  const env = { GITHUB_ACTIONS: "true" };
  const both = await credentialEnv({ harness: "codex", credential: "api", inputs: { codexGatewayKey: "vck_g", codexApiKey: "sk-c" }, env, session: "factory-s" });
  assert.deepEqual(both.env, { FACTORY_CODEX_GATEWAY_KEY: "vck_g", FACTORY_GATEWAY_SESSION: "factory-s" });
  assert.equal(both.basis, "FACTORY_CODEX_GATEWAY_KEY (Vercel AI Gateway, step-scoped)");
  const direct = await credentialEnv({ harness: "codex", credential: "api", inputs: { codexApiKey: "sk-c" }, env });
  assert.deepEqual(direct.env, { CODEX_API_KEY: "sk-c" });
  const noSession = await credentialEnv({ harness: "codex", credential: "api", inputs: { codexGatewayKey: "vck_g" }, env });
  assert.match(noSession.env.FACTORY_GATEWAY_SESSION, /^factory-[0-9a-f]{32}$/, "a stage that cannot read its stint gets its own");
  const login = await credentialEnv({ harness: "codex", credential: "login", inputs: {}, env: { CODEX_API_KEY: "sk-c", FACTORY_CODEX_GATEWAY_KEY: "vck_g" } });
  assert.deepEqual(login.env, { CODEX_API_KEY: "sk-c" }, "a CLI-login run stays on the CLI's own provider");
  // The input reads the secret's own name, under the action's and the workflow's names.
  assert.equal(resolveInputs({ env: { FACTORY_INPUT_CODEX_GATEWAY_KEY: "a" } }).codexGatewayKey, "a");
  assert.equal(resolveInputs({ env: { FACTORY_CODEX_GATEWAY_KEY: "b" } }).codexGatewayKey, "b");
  // One stint, one id; another stint or Objective, another. Opaque: no repository name in it.
  const a = gatewaySession({ repo: "o/r", issue: 7, since: "2026-11-11T10:00:00Z" });
  assert.equal(a, gatewaySession({ repo: "o/r", issue: 7, since: "2026-11-11T10:00:00Z" }));
  assert.notEqual(a, gatewaySession({ repo: "o/r", issue: 7, since: "2026-11-11T12:00:00Z" }));
  assert.notEqual(a, gatewaySession({ repo: "o/r", issue: 8, since: "2026-11-11T10:00:00Z" }));
  assert.ok(!a.includes("o/r") && a.length <= 256);
});

test("the gateway key reaches the Codex child only: out of every shell, every other child and the worker's secrets; never AI_GATEWAY_API_KEY", () => {
  assert.equal(CODEX_GATEWAY_ENV, "FACTORY_CODEX_GATEWAY_KEY");
  assert.ok(MODEL_SECRET_KEYS.includes(CODEX_GATEWAY_ENV) && !FACTORY_SECRET_KEYS.includes(CODEX_GATEWAY_ENV) && FACTORY_SECRET_KEYS.includes("AI_GATEWAY_API_KEY"));
  assert.ok(SHELL_SECRET_KEYS.includes(CODEX_GATEWAY_ENV) && hiddenFromShell([CODEX_GATEWAY_ENV]).includes(CODEX_GATEWAY_ENV), "no opt-in unhides it");
  for (const local of [null, { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: [] }]) {
    const x = harnessCommand({ harness: "codex", prompt: "P", local, gateway: { session: "s" } });
    assert.match(x.args.find((a) => a.startsWith("shell_environment_policy.exclude=")), /"FACTORY_CODEX_GATEWAY_KEY"/);
    const p = harnessCommand({ harness: "copilot", prompt: "P", local });
    assert.ok(p.args.find((a) => a.startsWith("--secret-env-vars=")).split(/[=,]/).includes(CODEX_GATEWAY_ENV));
  }
  const e = scrubbedEnv({ PATH: "/bin", FACTORY_CODEX_GATEWAY_KEY: "k", FACTORY_INPUT_CODEX_GATEWAY_KEY: "k" });
  assert.deepEqual(e, { PATH: "/bin" });
  const ws = parseWorkerSecrets("FACTORY_CODEX_GATEWAY_KEY X=FACTORY_CODEX_GATEWAY_KEY");
  assert.deepEqual(ws.entries, []);
  assert.equal(ws.refused.length, 2, "refused as a NAME and as a SOURCE");
  // The cloud sandbox: only the key the stage's Codex runs on goes into the VM.
  assert.equal(isSecretEnv("FACTORY_INPUT_CODEX_GATEWAY_KEY") && isSecretEnv("FACTORY_CODEX_GATEWAY_KEY"), true);
  const inputs = { harness: "codex", model: "gpt-6.1-sol", codexApiKey: "sk-c", codexGatewayKey: "vck_g", aiGatewayApiKey: "" };
  const out = stageEnvironment({ inputs, env: { FACTORY_CODEX_GATEWAY_KEY: "vck_g" }, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
  assert.equal(out.FACTORY_INPUT_CODEX_GATEWAY_KEY, "vck_g");
  assert.ok(!("FACTORY_INPUT_CODEX_API_KEY" in out) && !("FACTORY_CODEX_GATEWAY_KEY" in out));
  assert.equal(stageEnvironment({ inputs: { ...inputs, codexGatewayKey: "" }, env: {}, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } }).FACTORY_INPUT_CODEX_API_KEY, "sk-c");
});

test("the gateway's error body: a budget or payment refusal Blocks, with or without a status; a rate limit and a bare 400 type do not", () => {
  const wrapped = (status, type) => JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type, message: "m" }, status }) } });
  const bare = (type) => JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ error: { type, message: "m" } }) } });
  assert.deepEqual({ ...providerRefusal("codex", jsonLines(wrapped(402, "quota_for_entity_exceeded"))), message: undefined }, { harness: "codex", status: 402, type: "quota_for_entity_exceeded", code: null, message: undefined });
  assert.equal(providerRefusal("codex", jsonLines(bare("quota_for_entity_exceeded")))?.type, "quota_for_entity_exceeded");
  assert.equal(providerRefusal("codex", jsonLines(bare("customer_verification_required")))?.status, null);
  assert.equal(providerRefusal("codex", jsonLines(bare("authentication_error")))?.type, "authentication_error");
  assert.equal(providerRefusal("codex", jsonLines(wrapped(429, "rate_limit_exceeded"))), null);
  assert.equal(providerRefusal("codex", jsonLines(bare("rate_limit_exceeded"))), null);
  assert.equal(providerRefusal("codex", jsonLines(bare("invalid_request_error"))), null, "no status, no refusing type: not decidable, so not a refusal");
  assert.equal(parseUsage("codex", bare("quota_for_entity_exceeded"), "gpt-6.1-sol").error, "refused by the provider: quota_for_entity_exceeded");
});

test("a Codex resume refused for a rotated credential runs one fresh thread with the full prompt; a fresh run's refusal is not retried", async () => {
  const pin = (code) => `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000003"}\n${JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type: "invalid_request_error", code, message: "m" }, status: 400 }) } })}`;
  assert.equal(rotatedPin("codex", jsonLines(pin("invalid_encrypted_content"))), true);
  assert.equal(rotatedPin("codex", jsonLines(pin("codex_byok_restricted_by_api_credit_promo"))), false);
  assert.equal(rotatedPin("claude", jsonLines(pin("invalid_encrypted_content"))), false);
  assert.equal(parseCodex(pin("invalid_encrypted_content"), "gpt-6.1-sol").pinRotated, true);
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-pin-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "pin.jsonl"), `${pin("invalid_encrypted_content")}\n`);
  // A fake codex: a resume (exec resume <id>) is refused for the rotated pin, a fresh exec completes; each call is logged.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resume: args[1] === "resume", stdin, session: process.env.FACTORY_GATEWAY_SESSION || null, key: process.env.FACTORY_CODEX_GATEWAY_KEY || null }) + "\\n");
if (args[1] === "resume") { process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "pin.jsonl"))}, "utf8")); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, "codex-0.167-gateway-thread.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const env = { PATH: process.env.PATH, FACTORY_CODEX_GATEWAY_KEY: "vck_g", FACTORY_GATEWAY_SESSION: "factory-s" };
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the ask", freshPrompt: "card\n\n---\n\nthe ask", resume: "00000000-0000-0000-0000-000000000003", maxUsd: 0, cwd: bin, env, timeoutMs: 60_000, label: "validation-fix-1" });
    assert.equal(rec.ok, true);
    assert.equal(rec.refusal, undefined);
    assert.equal(rec.resumed, false);
    assert.deepEqual(rec.resumeRefused, { session: "00000000-0000-0000-0000-000000000003", status: 400, type: "invalid_request_error", code: "invalid_encrypted_content" });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => [c.resume, c.stdin, c.session, c.key]), [[true, "the ask", "factory-s", "vck_g"], [false, "card\n\n---\n\nthe ask", "factory-s", "vck_g"]]);
    // A fresh run refused the same way is a refusal, run once.
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, "{}\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "pin.jsonl"))}, "utf8"));
process.exit(1);
`, { mode: 0o755 });
    writeFileSync(log, "");
    const refused = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: bin, env, timeoutMs: 60_000, label: "work-1" });
    assert.equal(refused.refusal?.code, "invalid_encrypted_content");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  } finally {
    process.env.PATH = saved;
  }
});

test("doctor: the gateway key is checked free against its Codex model list; either Codex secret meets the secrets check", async () => {
  const at = (status) => async (url, init) => {
    assert.equal(url, "https://ai-gateway.vercel.sh/codex/v1/models");
    assert.equal(init.headers.Authorization, "Bearer vck_g");
    return { status };
  };
  assert.equal((await gatewayKeyProbe("vck_g", { fetchFn: at(200) })).status, "PASS");
  assert.equal((await gatewayKeyProbe("vck_g", { fetchFn: at(401) })).status, "FAIL");
  assert.equal((await gatewayKeyProbe("vck_g", { fetchFn: at(503) })).status, "WARN");
  assert.equal((await gatewayKeyProbe("vck_g", { fetchFn: async () => { throw new Error("offline"); } })).status, "WARN");
  assert.deepEqual(neededSecrets({ harness: "codex" }), ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", ["FACTORY_CODEX_GATEWAY_KEY", "CODEX_API_KEY"]]);
});

// A fake codex in its own directory: a resume (`exec resume <id>`) is refused for a rotated pin, a fresh exec completes;
// each call's resume flag and the env names it got are logged.
function fakeCodex() {
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-review-"));
  const log = join(bin, "calls.jsonl");
  const refused = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000003"}\n${JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "invalid_encrypted_content", message: "m" }, status: 400 }) } })}\n`;
  writeFileSync(join(bin, "pin.jsonl"), refused);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resume: args[1] === "resume", env: Object.keys(process.env).sort() }) + "\\n");
if (args[1] === "resume") { process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "pin.jsonl"))}, "utf8")); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, "codex-0.167-gateway-thread.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { bin, calls };
}

test("no fresh prompt, no fallback: the exit-record ask's refused resume Blocks with the refusal instead of a context-free thread", async () => {
  const { exitRecord } = await import("../scripts/lib/session.mjs");
  const { bin, calls } = fakeCodex();
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const env = { PATH: process.env.PATH, FACTORY_CODEX_GATEWAY_KEY: "vck_g", FACTORY_GATEWAY_SESSION: "factory-s" };
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the ask", resume: "00000000-0000-0000-0000-000000000003", maxUsd: 0, cwd: bin, env, timeoutMs: 60_000, label: "exit" });
    assert.equal(rec.refusal?.code, "invalid_encrypted_content");
    assert.equal(rec.resumeRefused, undefined);
    assert.equal(calls().length, 1, "one call: no fresh thread without a fresh prompt");
    const asked = await exitRecord({ text: undefined, harness: "codex", model: "gpt-6.1-sol", session: { id: "00000000-0000-0000-0000-000000000003", canResume: true }, cwd: bin, env, deadlineAt: Date.now() + 600_000, maxUsd: 0 });
    assert.equal(asked.record.exit, "blocked");
    assert.match(asked.record.reason, /^codex was refused by its provider \(HTTP 400 invalid_request_error invalid_encrypted_content\)/);
    assert.deepEqual(calls().map((c) => c.resume), [true, true], "the exit-record ask resumed once and stopped");
  } finally {
    process.env.PATH = saved;
  }
});

test("the review's answer pass runs at most twice: no second fresh run after runHarness already ran one for a refused resume", async () => {
  const { answerFreshAfter, crashed } = await import("../scripts/lib/session.mjs");
  const died = { ok: false, timedOut: false, budgetExceeded: false, stopped: false, signal: null, exitCode: 1, subtype: null, turns: 0 };
  assert.equal(crashed(died), true);
  assert.equal(answerFreshAfter("t-1", died), true, "a resumed answer pass that died runs fresh once");
  assert.equal(answerFreshAfter("t-1", { ...died, resumeRefused: { session: "t-1" } }), false, "already fresh: that was the second run");
  assert.equal(answerFreshAfter(null, died), false, "a fresh pass that died is not run again here");
});

test("doctor --probe runs the harness on a scrubbed env plus its one credential: no Factory key, no unused CODEX_API_KEY", async () => {
  const { probeHarness } = await import("../scripts/doctor.mjs");
  const { bin, calls } = fakeCodex();
  // The CLI is found on this process's PATH (proc.mjs onPath), as on a runner.
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const env = { PATH: process.env.PATH, HOME: bin, AI_GATEWAY_API_KEY: "vck_factory", CODEX_API_KEY: "sk-unused", FACTORY_INPUT_AI_GATEWAY_API_KEY: "vck_factory", GH_TOKEN: "ghs_x" };
    const out = await probeHarness({ inputs: { harness: "codex", credential: "api", model: "gpt-6.1-sol", codexGatewayKey: "vck_g" }, env });
    assert.equal(out.status, "PASS", out.detail);
    const [call] = calls();
    for (const k of ["AI_GATEWAY_API_KEY", "FACTORY_INPUT_AI_GATEWAY_API_KEY", "CODEX_API_KEY", "GH_TOKEN"]) assert.ok(!call.env.includes(k), `${k} kept out`);
    for (const k of ["FACTORY_CODEX_GATEWAY_KEY", "FACTORY_GATEWAY_SESSION", "PATH"]) assert.ok(call.env.includes(k), `${k} given`);
  } finally {
    process.env.PATH = saved;
  }
});

test("doctor: a job-level CODEX_API_KEY is warned beside the gateway key; an unpriced Codex model says max_usd cannot stop it", async () => {
  const { credentialChecks } = await import("../scripts/doctor.mjs");
  const { unpricedCodex } = await import("../scripts/lib/usage.mjs");
  const env = { GITHUB_ACTIONS: "true", CODEX_API_KEY: "sk-c", FACTORY_INPUT_CODEX_GATEWAY_KEY: "vck_g" };
  const checks = await credentialChecks({ inputs: { harness: "codex", credential: "api", model: "gpt-6.1-sol", codexGatewayKey: "vck_g", codexApiKey: "" }, env });
  assert.ok(checks.some((c) => c.status === "WARN" && /CODEX_API_KEY is a job-level variable/.test(c.detail)));
  assert.ok(!checks.some((c) => c.name === "codex model"), "a priced model: no warning");
  const unpriced = await credentialChecks({ inputs: { harness: "codex", credential: "api", model: "openai/gpt-5.5-pro", codexGatewayKey: "vck_g" }, env: { GITHUB_ACTIONS: "true", FACTORY_INPUT_CODEX_GATEWAY_KEY: "vck_g" } });
  assert.match(unpriced.find((c) => c.name === "codex model")?.detail ?? "", /^gpt-5\.5-pro has no row .* max_usd and daily_usd cannot stop them; only the AI Gateway key's budget does$/);
  assert.equal(unpricedCodex("codex", "gpt-6.1-sol"), null);
  assert.equal(unpricedCodex("claude", "anything"), null);
});
