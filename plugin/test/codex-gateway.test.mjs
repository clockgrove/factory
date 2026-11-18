import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_PRICES, codexRate, parseCodex, priceCodex, sinceSession } from "../scripts/lib/usage.mjs";
import { SHELL_SECRET_KEYS, credentialEnv, gatewaySession, harnessCommand, hiddenFromShell, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { CODEX_GATEWAY_ENV, PENDULUM_SECRET_KEYS, MODEL_SECRET_KEYS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { parseWorkerSecrets } from "../scripts/lib/worker-secrets.mjs";
import { isSecretEnv, stageEnvironment } from "../scripts/launch.mjs";
import { loadPrices, priceTokens } from "../../bench/lib/cost.mjs";
import { harnessActivity } from "../scripts/lib/logic.mjs";

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (f) => readFileSync(join(fixtures, f), "utf8");

// The table as OpenAI listed it on 2026-11-16 (its pricing page and model pages): [input, cached, write, output] per
// million tokens, then the long-context (>272K input tokens) rates where the model has them.
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
  "gpt-5.1-codex": [1.25, 0.125, null, 10],
  "gpt-5.1-codex-max": [1.25, 0.125, null, 10],
  "gpt-5.1-codex-mini": [0.25, 0.025, null, 2],
  "gpt-5": [1.25, 0.125, null, 10],
  "gpt-5-codex": [1.25, 0.125, null, 10],
  "gpt-5-mini": [0.25, 0.025, null, 2],
  "gpt-5-nano": [0.05, 0.005, null, 0.4],
};
const rates = ([input, cached, write, output]) => ({ input, cached, ...(write === null ? {} : { write }), output });

test("the Codex price table is OpenAI's list price of 2026-11-16, dated, with its sources; the worker and the bench read one file", () => {
  assert.equal(CODEX_PRICES.date, "2026-11-16");
  assert.equal(CODEX_PRICES.status, "verified");
  assert.deepEqual(CODEX_PRICES.sources, ["https://developers.openai.com/api/docs/pricing", "https://developers.openai.com/api/docs/models", "https://developers.openai.com/api/docs/guides/prompt-caching"]);
  assert.equal(CODEX_PRICES.longContextAbove, 272000);
  assert.deepEqual(CODEX_PRICES.aliases, { "gpt-5.6": "gpt-5.6-sol" }, "the alias OpenAI's GPT-5.6 Sol page documents");
  // GPT-5.6 Sol's rates are OpenAI's promotional pricing, "available until November 30, 2026".
  const until = { "gpt-5.6-sol": "2026-11-30" };
  const want = Object.fromEntries(Object.entries(LISTED).map(([m, r]) => [m, { ...rates(r), ...(r[4] ? { long: rates(r[4]) } : {}), ...(until[m] ? { until: until[m] } : {}) }]));
  assert.deepEqual(CODEX_PRICES.perMillion, want);
  assert.deepEqual(loadPrices(), CODEX_PRICES, "the bench's table is the worker's");
});

test("Codex pricing: a provider prefix is stripped, a dated snapshot matches, nothing else borrows another model's rates", () => {
  // A million input tokens from requests none of which passed the long-context threshold.
  const t = { input: 1_000_000, cached: 0, output: 0, long: { input: 0, cached: 0, written: 0, output: 0 } };
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
  // The live counter on the progress comment counts the resumed pass's own writes too.
  const live = harnessActivity();
  for (const l of fixture("codex-0.167-gateway-thread.jsonl").split("\n")) live.feed(l);
  assert.deepEqual(live.snapshot().tokens, { input: 21572, output: 61, written: 10841 });
  live.since("00000000-0000-0000-0000-000000000002", { usd: fresh.usd, tokens: fresh.tokens });
  for (const l of fixture("codex-0.167-gateway-resumed.jsonl").split("\n")) live.feed(l);
  assert.deepEqual(live.snapshot().tokens, { input: 21572 + 22228, output: 122, written: 10841 + 310 });
  // A model without a write rate bills its writes as input.
  assert.equal(priceCodex("gpt-5.4", { input: 1_000_000, cached: 0, written: 1_000_000, output: 0, long: { input: 0, cached: 0, written: 0, output: 0 } }), 2.5);
  // An item error with no completed turn after it is the run's failure.
  const cut = parseCodex(fixture("codex-0.167-gateway-resumed.jsonl").split("\n").slice(0, 2).join("\n"), "gpt-6.1-sol");
  assert.equal(cut.ok, false);
  assert.match(cut.error, /recorded with model/);
});

test("the gateway credential: preferred over CODEX_API_KEY, alone in the child, a stint's session id, never on a login run", async () => {
  const env = { GITHUB_ACTIONS: "true" };
  const both = await credentialEnv({ harness: "codex", credential: "api", inputs: { codexGatewayKey: "vck_g", codexApiKey: "sk-c" }, env, session: "pendulum-s" });
  assert.deepEqual(both.env, { PENDULUM_CODEX_GATEWAY_KEY: "vck_g", PENDULUM_GATEWAY_SESSION: "pendulum-s" });
  assert.equal(both.basis, "PENDULUM_CODEX_GATEWAY_KEY (Vercel AI Gateway, step-scoped)");
  const direct = await credentialEnv({ harness: "codex", credential: "api", inputs: { codexApiKey: "sk-c" }, env });
  assert.deepEqual(direct.env, { CODEX_API_KEY: "sk-c" });
  const noSession = await credentialEnv({ harness: "codex", credential: "api", inputs: { codexGatewayKey: "vck_g" }, env });
  assert.match(noSession.env.PENDULUM_GATEWAY_SESSION, /^pendulum-[0-9a-f]{32}$/, "a stage that cannot read its stint gets its own");
  const login = await credentialEnv({ harness: "codex", credential: "login", inputs: {}, env: { CODEX_API_KEY: "sk-c", PENDULUM_CODEX_GATEWAY_KEY: "vck_g" } });
  assert.deepEqual(login.env, { CODEX_API_KEY: "sk-c" }, "a CLI-login run stays on the CLI's own provider");
  // The input reads the secret's own name, under the action's and the workflow's names.
  assert.equal(resolveInputs({ env: { PENDULUM_INPUT_CODEX_GATEWAY_KEY: "a" } }).codexGatewayKey, "a");
  assert.equal(resolveInputs({ env: { PENDULUM_CODEX_GATEWAY_KEY: "b" } }).codexGatewayKey, "b");
  // One stint, one id; another stint or Objective, another. Opaque: no repository name in it.
  const a = gatewaySession({ repo: "o/r", issue: 7, since: "2026-11-11T10:00:00Z" });
  assert.equal(a, gatewaySession({ repo: "o/r", issue: 7, since: "2026-11-11T10:00:00Z" }));
  assert.notEqual(a, gatewaySession({ repo: "o/r", issue: 7, since: "2026-11-11T12:00:00Z" }));
  assert.notEqual(a, gatewaySession({ repo: "o/r", issue: 8, since: "2026-11-11T10:00:00Z" }));
  assert.ok(!a.includes("o/r") && a.length <= 256);
});

test("the gateway key reaches the Codex child only: out of every shell, every other child and the worker's secrets; never AI_GATEWAY_API_KEY", () => {
  assert.equal(CODEX_GATEWAY_ENV, "PENDULUM_CODEX_GATEWAY_KEY");
  assert.ok(MODEL_SECRET_KEYS.includes(CODEX_GATEWAY_ENV) && !PENDULUM_SECRET_KEYS.includes(CODEX_GATEWAY_ENV) && PENDULUM_SECRET_KEYS.includes("AI_GATEWAY_API_KEY"));
  assert.ok(SHELL_SECRET_KEYS.includes(CODEX_GATEWAY_ENV) && hiddenFromShell([CODEX_GATEWAY_ENV]).includes(CODEX_GATEWAY_ENV), "no opt-in unhides it");
  for (const local of [null, { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: [] }]) {
    const x = harnessCommand({ harness: "codex", prompt: "P", local, gateway: { session: "s" } });
    assert.match(x.args.find((a) => a.startsWith("shell_environment_policy.exclude=")), /"PENDULUM_CODEX_GATEWAY_KEY"/);
    const p = harnessCommand({ harness: "copilot", prompt: "P", local });
    assert.ok(p.args.find((a) => a.startsWith("--secret-env-vars=")).split(/[=,]/).includes(CODEX_GATEWAY_ENV));
  }
  const e = scrubbedEnv({ PATH: "/bin", PENDULUM_CODEX_GATEWAY_KEY: "k", PENDULUM_INPUT_CODEX_GATEWAY_KEY: "k" });
  assert.deepEqual(e, { PATH: "/bin" });
  const ws = parseWorkerSecrets("PENDULUM_CODEX_GATEWAY_KEY X=PENDULUM_CODEX_GATEWAY_KEY");
  assert.deepEqual(ws.entries, []);
  assert.equal(ws.refused.length, 2, "refused as a NAME and as a SOURCE");
  // The cloud sandbox: only the key the stage's Codex runs on goes into the VM.
  assert.equal(isSecretEnv("PENDULUM_INPUT_CODEX_GATEWAY_KEY") && isSecretEnv("PENDULUM_CODEX_GATEWAY_KEY"), true);
  const inputs = { harness: "codex", model: "gpt-6.1-sol", codexApiKey: "sk-c", codexGatewayKey: "vck_g", aiGatewayApiKey: "" };
  const out = stageEnvironment({ inputs, env: { PENDULUM_CODEX_GATEWAY_KEY: "vck_g" }, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
  assert.equal(out.PENDULUM_INPUT_CODEX_GATEWAY_KEY, "vck_g");
  assert.ok(!("PENDULUM_INPUT_CODEX_API_KEY" in out) && !("PENDULUM_CODEX_GATEWAY_KEY" in out));
  assert.equal(stageEnvironment({ inputs: { ...inputs, codexGatewayKey: "" }, env: {}, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } }).PENDULUM_INPUT_CODEX_API_KEY, "sk-c");
});

// A fake codex in its own directory: a resume (`exec resume <id>`) is refused for a rotated pin, a fresh exec completes;
// each call's resume flag and the env names it got are logged.
function fakeCodex() {
  const bin = mkdtempSync(join(tmpdir(), "pendulum-codex-review-"));
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

test("doctor --probe runs the harness on a scrubbed env plus its one credential: no Pendulum key, no unused CODEX_API_KEY", async () => {
  const { probeHarness } = await import("../scripts/doctor.mjs");
  const { bin, calls } = fakeCodex();
  // The CLI is found on this process's PATH (proc.mjs onPath), as on a runner.
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const env = { PATH: process.env.PATH, HOME: bin, AI_GATEWAY_API_KEY: "vck_pendulum", CODEX_API_KEY: "sk-unused", PENDULUM_INPUT_AI_GATEWAY_API_KEY: "vck_pendulum", GH_TOKEN: "ghs_x" };
    const out = await probeHarness({ inputs: { harness: "codex", credential: "api", model: "gpt-6.1-sol", codexGatewayKey: "vck_g" }, env });
    assert.equal(out.status, "PASS", out.detail);
    const [call] = calls();
    for (const k of ["AI_GATEWAY_API_KEY", "PENDULUM_INPUT_AI_GATEWAY_API_KEY", "CODEX_API_KEY", "GH_TOKEN"]) assert.ok(!call.env.includes(k), `${k} kept out`);
    for (const k of ["PENDULUM_CODEX_GATEWAY_KEY", "PENDULUM_GATEWAY_SESSION", "PATH"]) assert.ok(call.env.includes(k), `${k} given`);
  } finally {
    process.env.PATH = saved;
  }
});
