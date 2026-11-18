// How a dollar figure is billed (#481), decided on a positive sign only: billed per use on a known key (`api`), API-
// equivalent at list prices on a subscription (`subscription`), Copilot AI credits billed to the seat (`credits`), or
// billing not recorded (`unknown`). The credential's kind comes from the environment the harness child gets
// (credentialEnv), each pass's from what the harness reported as it ended. Each case runs real passes (runHarness and
// runDecision on fake harness CLIs that behave as the real ones do) and follows the records end to end: result.json, the
// progress comment (exit line and spend line, written to a fake GitHub by the stage's real progress reporter), the
// running spend line and status line, the day's total and its words, the dispatch report and step summary, the serve
// log, the rebase line, the vendor comment, and the scorecard from the artifact and from the spend line.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { childBilling, codexKeyBilling, credentialEnv, foldDecision, keepDecision, runDecision, runHarness } from "../scripts/lib/harness.mjs";
import { progressReporter, writeUsage } from "../scripts/lib/session.mjs";
import { activityLine, capReached, copilotCount, harnessActivity, rebaseCost, rebaseCostMarker, rebaseLine, rebaseTally, selectReady, spendMarker, spendOf, spendParts, spendText, stageSpendLine, usdText, vendorBody } from "../scripts/lib/logic.mjs";
import { BILLING, codexPlanLimits, passBilling } from "../scripts/lib/usage.mjs";
import { addKeySpend } from "../scripts/lib/gateway-relay.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { dispatchStepSummary, reportDispatch, todaysSpend } from "../scripts/dispatch.mjs";
import { stageEndText, stageSpendOf } from "../scripts/local.mjs";
import { costOf, loadPrices } from "../../bench/lib/cost.mjs";
import { accountUse, markdownTable, scoreObjective, spendRecords } from "../../bench/lib/objective.mjs";
import { localMerge } from "../../bench/test/fixtures/github.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(import.meta.dirname, "fixtures");
const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const LIB = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;
const prices = loadPrices();
const SUB = "API-equivalent at list prices, on the subscription";
const CREDITS = "Copilot AI credits, billed to the seat";
const UNKNOWN = "billing not recorded";

/**
 * Fake `claude`, `codex` and `copilot` CLIs. Claude behaves as Claude Code 2.1.326 does (checked live on a fake home):
 * its init line's `apiKeySource` is "ANTHROPIC_API_KEY" with that variable set and "none" for an OAuth token and for a
 * bearer token (`ANTHROPIC_AUTH_TOKEN`) alike; FAKE_KEY_SOURCE stands in for a stored Console login or a legacy source.
 * It sends a subscription's `rate_limit_event` on a claude.ai login only: an OAuth token, or FAKE_STORED=claudeai, with no
 * key, bearer token or base URL of its own. Its result is FAKE_USD with modelUsage in 2.1.325's shape (`provider`:
 * FAKE_PROVIDER, "firstParty" by default; `costBasis`). FAKE_OVERAGE: after its limit's event, the event of a pass on paid
 * extra usage (`isUsingOverage`). FAKE_SLEEP: it then hangs. Codex prints one completed turn;
 * Copilot copies the 1.0.107 usage file to its --usage-output-file and prints its stream.
 */
function fakeBin() {
  const bin = mkdtempSync(join(tmpdir(), "billing-"));
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const e = process.env;
const usd = Number(e.FAKE_USD || "0.5");
const source = e.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : e.FAKE_KEY_SOURCE || "none";
const own = e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_BASE_URL;
const claudeAi = !own && (e.CLAUDE_CODE_OAUTH_TOKEN || e.FAKE_STORED === "claudeai");
const say = (o) => console.log(JSON.stringify(o));
say({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5", apiKeySource: source, claude_code_version: "2.1.326" });
if (claudeAi) say({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1794697200 }, session_id: "s1" });
// The event a real 2.1.326 OAuth run sent once its plan's limit was met and paid extra usage carried it on.
if (claudeAi && e.FAKE_OVERAGE) say({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1794697200, rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: true }, session_id: "s1" });
if (e.FAKE_SLEEP) setTimeout(() => {}, 60000);
else say({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: e.FAKE_ANSWER || "done", session_id: "s1", total_cost_usd: usd, usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { "claude-opus-5-5": { inputTokens: 30, outputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd, provider: e.FAKE_PROVIDER || "firstParty", costBasis: "list" } } });
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
console.log(JSON.stringify({ type: "thread.started", thread_id: "01a1c6ba-16b2-7a13-b2da-47bf51b4e724" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 0, output_tokens: 5000, reasoning_output_tokens: 0 } }));
`, { mode: 0o755 });
  writeFileSync(join(bin, "copilot"), `#!${process.execPath}
const fs = require("node:fs");
const at = process.argv.indexOf("--usage-output-file");
if (at > 0) fs.copyFileSync(${JSON.stringify(join(FIXTURES, "copilot-1.0.107-usage.json"))}, process.argv[at + 1]);
for (const l of fs.readFileSync(${JSON.stringify(join(FIXTURES, "copilot-events.jsonl"))}, "utf8").split("\\n")) if (l.trim()) console.log(l);
`, { mode: 0o755 });
  return bin;
}
const BIN = fakeBin();
const BASE = { HOME: process.env.HOME, PATH: `${BIN}:${process.env.PATH}` };

/** The credential a stage reads (credentialEnv), on `env` as the stage's own process environment. */
const credOf = (harness, credential, inputs = {}, env = {}) => credentialEnv({ harness, credential, inputs, env: { ...BASE, ...env } });

/** A fake GitHub: keeps every comment body written, lists `listed()` as the repository's comments, no artifacts. */
async function fakeGitHub(listed = () => []) {
  const written = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if ((req.method === "POST" || req.method === "PATCH") && /\/comments/.test(req.url)) written.push(JSON.parse(body || "{}").body || "");
      else if (req.method === "GET" && /\/issues\/comments/.test(req.url)) return res.end(JSON.stringify(listed()));
      else if (req.method === "GET") return res.end("[]");
      res.end(JSON.stringify({ id: 1, user: { login: "owner", type: "User" }, body: "" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { written, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** `fn` with GITHUB_API_URL at `url`. */
async function onGitHub(url, fn) {
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = url;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/**
 * One stage as worker.mjs runs it: its progress reporter is told the credential's billing (which books each pass by its
 * own as it ends), `run(progress)` runs its passes, then its end writes result.json, the spend line and the exit line.
 */
async function stage({ harness, model, cred, run }) {
  const dir = mkdtempSync(join(tmpdir(), "billing-usage-"));
  const gh = await fakeGitHub();
  try {
    return await onGitHub(gh.url, async () => {
      const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness, model, soFar: null });
      progress.billing(cred.billing);
      const records = await run(progress);
      const usage = writeUsage(dir, { harness, model, records, passes: records.length, exit: "delivered", reason: "", credentialBasis: cred.basis, billing: cred.billing });
      const line = stageSpendLine(usage);
      progress.spend(line.usd, line.parts);
      await progress(`exit: delivered; usd ${usdText(usage)}${copilotCount(usage)}`);
      return { records, usage, stored: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), body: gh.written.at(-1) };
    });
  } finally {
    gh.close();
  }
}

/** One real pass on `harness` with the credential's env, as the worker runs it (its stage env plus the credential). */
const pass = (harness, model, cred, fake = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "billing-pass-"));
  return runHarness({ harness, model, prompt: "p", maxUsd: 25, cwd: dir, eventsFile: join(dir, "events.jsonl"), env: { ...BASE, CODEX_HOME: join(dir, "codex"), ...fake, ...cred.env }, timeoutMs: 60_000, label: "work-1" });
};

/** The day's total from that comment (todaysSpend, spend lines only), the gate's words, the dispatch log and step summary. */
async function dayOf(body) {
  const gh = await fakeGitHub(() => [{ id: 1, user: { login: "owner", type: "User" }, author_association: "OWNER", updated_at: new Date().toISOString(), body }]);
  try {
    const day = await onGitHub(gh.url, () => todaysSpend(repoOf("o/r"), { sandbox: true }, { token: "t" }));
    const gate = selectReady({ issues: [{ number: 9, labels: [] }], maxConcurrent: 3, dailyUsd: 0.01, spentToday: day.spentToday, unknownToday: day.unknownToday, billingToday: day.billingToday });
    const none = Object.fromEntries(["ready", "reset", "done", "stopped", "restarted", "vanished", "relaunched", "relaunchesUsed", "paused", "sentBack", "rebaseHeld", "nextParts", "merged", "updated"].map((k) => [k, []]));
    const result = { ...none, running: 0, skipped: gate.skipped, spentToday: day.spentToday, unknownToday: day.unknownToday, billingToday: day.billingToday };
    const logged = [];
    const write = process.stdout.write;
    process.stdout.write = (s) => (logged.push(String(s)), true);
    let summary;
    try {
      summary = reportDispatch(result, { dailyUsd: 0.01, maxConcurrent: 3 });
    } finally {
      process.stdout.write = write;
    }
    return { day, words: gate.skipped[0].reason, log: logged.join(""), stepSummary: dispatchStepSummary(result, { dailyUsd: 0.01 }, summary), summary };
  } finally {
    gh.close();
  }
}

/** The scorecard: from the usage artifact, from the progress comment's spend line, and its Cost cell. */
function scorecard(stored, body, harness) {
  const fromArtifact = costOf([{ ...stored, artifact: "pendulum-usage-7" }], prices, { harness });
  const c = localMerge(7);
  c.issueComments = [{ ...c.issueComments[0], body: body.replace(/^<!-- pendulum:7:progress:work:1 -->/, "<!-- pendulum:7:progress:work:1700000001 -->") }, c.issueComments[1]];
  const row = scoreObjective(c, { prices, now: "2031-03-05T00:00:00Z" });
  return { fromArtifact, fromLine: costOf(spendRecords(c, {}), prices, { harness }), costCell: markdownTable([row]).split("\n")[2].split(" | ")[8] };
}

test("the credential's billing comes from the environment the child gets, on a positive sign only", async () => {
  const kind = async (...a) => (await credOf(...a)).billing;
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }), "subscription");
  assert.equal(await kind("claude", "api", { anthropicApiKey: "sk-ant-api03-dummy" }), "api");
  assert.equal(await kind("claude", "login"), "unknown", "a stored login proves nothing until its passes say");
  assert.equal(await kind("claude", "login", {}, { ANTHROPIC_API_KEY: "sk-ant-api03-dummy" }), "api");
  // A bearer token, a base URL or a provider switch in the stage's own environment reaches the child: not the subscription.
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { ANTHROPIC_AUTH_TOKEN: "gw-dummy" }), "api", "a bearer token to a gateway");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { ANTHROPIC_AUTH_TOKEN: "gw-dummy", GITHUB_ACTIONS: "true" }), "api", "on Actions too");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { ANTHROPIC_BASE_URL: "https://proxy.example" }), "unknown", "a base URL of its own, no key");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { ANTHROPIC_BASE_URL: "https://api.anthropic.com/" }), "subscription", "Anthropic's own URL");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { CLAUDE_CODE_USE_BEDROCK: "1" }), "api");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { CLAUDE_CODE_USE_VERTEX: "true" }), "api");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { CLAUDE_CODE_USE_FOUNDRY: "1" }), "unknown");
  assert.equal(await kind("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { CLAUDE_CODE_USE_BEDROCK: "0" }), "subscription", "a switch set off");
  // Codex by its key, or a ChatGPT login's auth mode.
  const auth = (mode) => JSON.stringify({ ...(mode ? { auth_mode: mode } : {}), tokens: { access_token: "x" } });
  assert.equal(await kind("codex", "api", { codexApiKey: "sk-proj-dummy" }), "api");
  assert.equal(await kind("codex", "api", { codexGatewayKey: "vck_dummy" }), "api");
  assert.equal(await kind("codex", "login"), "unknown");
  assert.deepEqual(["chatgpt", "chatgptAuthTokens", "apikey", "personalAccessToken", "bedrockAccessKeys", "agentIdentity", null].map((m) => codexKeyBilling(auth(m))), ["subscription", "subscription", "api", "api", "api", "unknown", "unknown"]);
  assert.equal(codexKeyBilling("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"), "subscription", "a ChatGPT access token");
  assert.equal(await kind("codex", "api", { codexApiKey: auth("chatgpt") }), "subscription");
  assert.equal(await kind("copilot", "api", { copilotGithubToken: "github_pat_dummy" }), "credits");
  assert.equal(childBilling("claude", {}), "unknown");
  assert.deepEqual([...BILLING], ["api", "subscription", "credits", "unknown"]);
});

test("each pass is decided by what its harness reported: a known key source is api, an unknown one unknown, a claude.ai login's limits the subscription", () => {
  const claude = (extra) => ({ harness: "claude", ...extra });
  assert.equal(passBilling("subscription", claude({ apiKeySource: "none" })), "subscription");
  for (const src of ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]) assert.equal(passBilling("subscription", claude({ apiKeySource: src })), "api", src);
  assert.equal(passBilling("subscription", claude({ apiKeySource: "oauth" })), "unknown", "a legacy source");
  assert.equal(passBilling("unknown", claude({ apiKeySource: "none" })), "unknown", '"none" alone is no proof');
  assert.equal(passBilling("unknown", claude({ apiKeySource: "none", planLimits: true })), "subscription");
  assert.equal(passBilling("api", claude({ apiKeySource: "none", planLimits: true })), "api", "a key the environment names stays billed");
  assert.equal(passBilling("subscription", claude({ models: { m: { provider: "vertex" } } })), "api");
  assert.equal(passBilling("subscription", claude({ models: { m: { provider: "gateway" } } })), "unknown");
  assert.equal(passBilling("unknown", { harness: "codex", planLimits: true }), "subscription");
  assert.equal(passBilling(null, { harness: "copilot" }), "credits");
  // Codex's ChatGPT plan limits in a rollout (its token_count's plan_type).
  const rollout = readFileSync(join(FIXTURES, "codex-0.167-usage-limit-rollout.jsonl"), "utf8");
  assert.equal(codexPlanLimits(rollout), true);
  assert.equal(codexPlanLimits(rollout.replace(/"plan_type":"pro"/g, '"plan_type":null')), false);
});

test("a Claude run on a plan credential is the subscription's in result.json, the exit line, the spend line, the day's total, the dispatch report and the scorecard", async () => {
  const cred = await credOf("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" });
  const { records, usage, stored, body } = await stage({ harness: "claude", model: "claude-opus-5-5", cred, run: async () => [await pass("claude", "claude-opus-5-5", cred, { FAKE_USD: "1.2" })] });
  assert.equal(records[0].billing, "subscription", "the pass is stamped as it ends");
  assert.deepEqual([records[0].apiKeySource, records[0].planLimits, records[0].models["claude-opus-5-5"].costBasis], ["none", true, "list"]);
  assert.deepEqual([stored.billing, stored.usdByBilling], ["subscription", { subscription: 1.2 }], "result.json");
  assert.equal(usdText(usage), `1.2 ${SUB}`, "the exit line");
  assert.ok(body.includes(`exit: delivered; usd 1.2 ${SUB}`), body);
  assert.match(body, /^<!-- pendulum:spend \{"usd":1\.2,"usdByBilling":\{"subscription":1\.2\},"billing":"subscription","usdByPass":\{"work":\{"usd":1\.2,"usdByBilling":\{"subscription":1\.2\}\}\},"exit":"delivered"\} -->$/m, "the spend line");
  assert.equal(capReached(1.2, records), true, "max_usd compares the figure");
  const { day, words, log, stepSummary } = await dayOf(body);
  assert.deepEqual([day.spentToday, day.billingToday], [1.2, { subscription: 1.2 }], "daily_usd's total");
  assert.equal(words, `daily_usd reached ($1.20 ${SUB} of $0.01)`);
  assert.ok(log.includes(`spent today: $1.20 ${SUB} of $0.01`), log);
  assert.ok(stepSummary.includes(`Spent today: $1.20 ${SUB} / $0.01`), stepSummary);
  assert.equal(stageEndText({ exit: "delivered", ...stageSpendOf(stored) }), `delivered, $1.20 ${SUB}`, "the serve log");
  const card = scorecard(stored, body, "claude");
  for (const [from, cost] of [["artifact", card.fromArtifact], ["spend line", card.fromLine]]) {
    assert.deepEqual(cost.usdByBilling, { subscription: 1.2 }, from);
    assert.match(cost.basis, /; 1\.2 USD API-equivalent at list prices, on the subscription$/, from);
  }
  assert.ok(card.costCell.startsWith(`$1.20 ${SUB}`), card.costCell);
});

test("api only on a known key: an API key, a Console login, a bearer token; a base URL or an unknown key source is billing not recorded", async () => {
  const key = await credOf("claude", "api", { anthropicApiKey: "sk-ant-api03-dummy" });
  const keyed = await stage({ harness: "claude", model: "claude-opus-5-5", cred: key, run: async () => [await pass("claude", "claude-opus-5-5", key, { FAKE_USD: "1.2" })] });
  assert.deepEqual([keyed.records[0].apiKeySource, keyed.stored.billing, keyed.stored.usdByBilling], ["ANTHROPIC_API_KEY", "api", { api: 1.2 }]);
  assert.equal(usdText(keyed.usage), "1.2");
  assert.match(keyed.body, /^<!-- pendulum:spend \{"usd":1\.2,"usdByBilling":\{"api":1\.2\},"billing":"api","usdByPass":\{"work":\{"usd":1\.2,"usdByBilling":\{"api":1\.2\}\}\},"exit":"delivered"\} -->$/m);
  assert.equal((await dayOf(keyed.body)).words, "daily_usd reached ($1.20 of $0.01)");
  const card = scorecard(keyed.stored, keyed.body, "claude");
  assert.match(card.fromArtifact.basis, /; billed per use on API keys$/);
  assert.ok(!/subscription|credits|not recorded/.test(card.costCell), card.costCell);
  // A bearer token reports apiKeySource "none" as an OAuth token does: the environment says it is billed.
  const bearer = await credOf("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { ANTHROPIC_AUTH_TOKEN: "gw-dummy" });
  const viaGateway = await pass("claude", "claude-opus-5-5", bearer, { FAKE_USD: "0.4", ANTHROPIC_AUTH_TOKEN: "gw-dummy" });
  assert.equal(viaGateway.apiKeySource, "none");
  // A base URL of its own with no key: no sign either way.
  const proxied = await credOf("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { ANTHROPIC_BASE_URL: "https://proxy.example" });
  // A stored login: a Console login's key source is billed, a legacy one unknown, a claude.ai login's limits the subscription.
  const login = await credOf("claude", "login");
  const runs = async (cred, fakes) => {
    const out = [];
    for (const f of fakes) out.push(await pass("claude", "claude-opus-5-5", cred, f));
    return out;
  };
  const b = await stage({ harness: "claude", model: "claude-opus-5-5", cred: bearer, run: () => runs(bearer, [{ FAKE_USD: "0.4", ANTHROPIC_AUTH_TOKEN: "gw-dummy" }]) });
  assert.deepEqual([b.stored.billing, b.stored.usdByBilling], ["api", { api: 0.4 }], "a bearer token is billed per use");
  const p = await stage({ harness: "claude", model: "claude-opus-5-5", cred: proxied, run: () => runs(proxied, [{ FAKE_USD: "0.3", ANTHROPIC_BASE_URL: "https://proxy.example" }]) });
  assert.deepEqual([p.stored.billing, p.stored.usdByBilling], ["unknown", { unknown: 0.3 }]);
  assert.equal(usdText(p.usage), `0.3 ${UNKNOWN}`);
  const l = await stage({ harness: "claude", model: "claude-opus-5-5", cred: login, run: () => runs(login, [{ FAKE_USD: "0.5", FAKE_KEY_SOURCE: "/login managed key" }, { FAKE_USD: "0.25", FAKE_KEY_SOURCE: "oauth" }, { FAKE_USD: "0.125", FAKE_STORED: "claudeai" }, { FAKE_USD: "0.0625" }, { FAKE_USD: "1", FAKE_PROVIDER: "bedrock" }]) });
  assert.deepEqual(l.records.map((r) => r.billing), ["api", "unknown", "subscription", "unknown", "api"]);
  assert.deepEqual([l.stored.billing, l.stored.usdByBilling], ["unknown", { api: 1.5, unknown: 0.3125, subscription: 0.125 }]);
  assert.equal(usdText(l.usage), `1.9375: 1.5 API + 0.3125 ${UNKNOWN} + 0.125 ${SUB}`, "every part, in one flat list");
});

test("a Copilot run is Copilot AI credits, billed to the seat, everywhere", async () => {
  const cred = await credOf("copilot", "api", { copilotGithubToken: "github_pat_dummy" });
  const { records, usage, stored, body } = await stage({ harness: "copilot", model: "claude-sonnet-5.5", cred, run: async () => [await pass("copilot", "claude-sonnet-5.5", cred)] });
  // The pass's credits unrounded (#565 W8); the stage's figures keep them to the micro-dollar.
  const usd = Math.round(records[0].usd * 1e6) / 1e6;
  assert.ok(usd > 0 && /AI credits/.test(records[0].basis), `the credits priced: ${usd}`);
  assert.deepEqual([stored.billing, stored.usdByBilling], ["credits", { credits: usd }]);
  assert.equal(usdText(usage), `${usd} ${CREDITS}`);
  assert.ok(body.includes(`exit: delivered; usd ${usd} ${CREDITS}; 1 premium request, ${usage.aiCredits} AI credits`), body);
  assert.equal((await dayOf(body)).words, `daily_usd reached ($${usd.toFixed(2)} ${CREDITS} of $0.01)`);
  const card = scorecard(stored, body, "copilot");
  assert.ok(card.fromArtifact.basis.endsWith(`; ${Math.round(usd * 1e4) / 1e4} USD ${CREDITS}`), card.fromArtifact.basis);
  assert.ok(!/API-equivalent|not a charge/.test(card.fromArtifact.basis + card.costCell), "no API-equivalent words for Copilot");
  assert.ok(card.costCell.startsWith(`$${usd.toFixed(2)} ${CREDITS}`), card.costCell);
});

test("a Codex pass end to end: an API key is billed per use, a ChatGPT auth mode the subscription's, and the scorer re-prices it at the record's own billing", async () => {
  for (const [value, kind] of [["sk-proj-dummy", "api"], [JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } }), "subscription"]]) {
    const cred = await credOf("codex", "api", { codexApiKey: value });
    assert.equal(cred.billing, kind);
    const { records, stored, body } = await stage({ harness: "codex", model: "gpt-6.1-sol", cred, run: async () => [await pass("codex", "gpt-6.1-sol", cred)] });
    assert.ok(records[0].usd > 0, "priced from the table");
    assert.deepEqual([stored.billing, stored.usdByBilling], [kind, { [kind]: records[0].usd }]);
    const card = scorecard(stored, body, "codex");
    assert.deepEqual(card.fromArtifact.usdByBilling, { [kind]: card.fromArtifact.usd }, "the re-priced dollars keep the record's billing");
  }
  // A relayed key's share stays `api` beside the harness's own when the bench re-prices the tokens.
  const rec = { harness: "codex", model: "gpt-6.1-sol", artifact: "pendulum-usage-7", tokens: { input: 200000, output: 5000, cached: 100000, written: 0 }, usd: 9, workerKeyUsd: 0.5, usdByBilling: { subscription: 8.5, api: 0.5 }, billing: "subscription", runs: 1 };
  const cost = costOf([rec], prices, { harness: "codex" });
  assert.deepEqual(cost.parts[0].usdByBilling, { subscription: Math.round((cost.usd - 0.5) * 1e6) / 1e6, api: 0.5 });
});

test("a stage mixing the subscription's figure and a relayed AI Gateway key's billed calls shows both parts everywhere", async () => {
  const cred = await credOf("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" });
  const { usage, stored, body } = await stage({
    harness: "claude",
    model: "claude-opus-5-5",
    cred,
    run: async () => {
      const rec = await pass("claude", "claude-opus-5-5", cred, { FAKE_USD: "1.2" });
      addKeySpend(rec, { usd: 0.3, calls: 2, unknown: 0 });
      return [rec];
    },
  });
  assert.deepEqual([stored.billing, stored.usdByBilling], ["subscription", { subscription: 1.2, api: 0.3 }]);
  assert.equal(usdText(usage), `1.5: 1.2 ${SUB} + 0.3 API; harness 1.2, worker key 0.3`);
  assert.match(body, /^<!-- pendulum:spend \{"usd":1\.5,"workerKeyUsd":0\.3,"usdByBilling":\{"subscription":1\.2,"api":0\.3\},"billing":"subscription","usdByPass":\{"work":\{"usd":1\.5,"usdByBilling":\{"subscription":1\.2,"api":0\.3\}\}\},"exit":"delivered"\} -->$/m);
  const { words, summary } = await dayOf(body);
  assert.equal(words, `daily_usd reached ($1.50: $1.20 ${SUB} + $0.30 API of $0.01)`);
  assert.deepEqual(summary.spent_today_by_billing, { subscription: 1.2, api: 0.3 });
  const card = scorecard(stored, body, "claude");
  for (const cost of [card.fromArtifact, card.fromLine]) {
    assert.deepEqual(cost.usdByBilling, { subscription: 1.2, api: 0.3 });
    assert.match(cost.basis, /; 1\.2 USD API-equivalent at list prices, on the subscription; 0\.3 USD billed per use(;|$)/);
  }
  assert.ok(card.costCell.startsWith(`$1.50: $1.20 ${SUB} + $0.30 API`), card.costCell);
});

test("a Claude pass on paid extra usage past the plan's limit is of unknown billing, whatever the credential", async () => {
  const cred = await credOf("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" });
  const { records, usage, stored, body } = await stage({ harness: "claude", model: "claude-opus-5-5", cred, run: async () => [await pass("claude", "claude-opus-5-5", cred, { FAKE_USD: "0.9" }), await pass("claude", "claude-opus-5-5", cred, { FAKE_USD: "0.6", FAKE_OVERAGE: "1" })] });
  assert.deepEqual(records.map((r) => [r.billing, r.overage === true]), [["subscription", false], ["unknown", true]]);
  assert.deepEqual([stored.billing, stored.usdByBilling], ["unknown", { subscription: 0.9, unknown: 0.6 }]);
  assert.equal(usdText(usage), `1.5: 0.9 ${SUB} + 0.6 ${UNKNOWN}`);
  assert.match(body, /"usdByBilling":\{"subscription":0\.9,"unknown":0\.6\},"billing":"unknown"/);
  // The status line from the same event, and a decision record made from such a pass.
  const a = harnessActivity();
  for (const l of [{ type: "system", subtype: "init", session_id: "s1", apiKeySource: "none", claude_code_version: "2.1.326" }, { type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed", isUsingOverage: true }, session_id: "s1" }, { type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0.6 }]) a.feed(JSON.stringify(l));
  assert.ok(activityLine(a.snapshot(), { harness: "claude", model: "m", billing: "subscription" }).includes(`, $0.60 ${UNKNOWN}`));
  assert.equal(passBilling("subscription", keepDecision({ ...records[1], billing: undefined })), "unknown", "kept on a decision record");
});

test("a Codex decision call on a ChatGPT login reads its rollout's plan limits before its files are removed, so the stage is the subscription's", async () => {
  // A fake Codex that answers and writes its rollout with a ChatGPT plan's rate limits, stamped now.
  const bin = mkdtempSync(join(tmpdir(), "billing-codex-"));
  const home = mkdtempSync(join(tmpdir(), "billing-codexhome-"));
  const thread = "01a1d3a0-5c1e-7b20-9f3a-2c4d6e8f0777";
  const counts = readFileSync(join(FIXTURES, "codex-0.167-usage-limit-rollout.jsonl"), "utf8").split("\n").find((l) => l.includes('"token_count"') && l.includes('"plan_type"'));
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const dir = process.env.CODEX_HOME + "/sessions/2026/11/16";
fs.mkdirSync(dir, { recursive: true });
const o = JSON.parse(${JSON.stringify(counts)});
o.timestamp = new Date().toISOString();
fs.writeFileSync(dir + "/rollout-2026-11-16T00-00-00-${thread}.jsonl", JSON.stringify(o) + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: "${thread}" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 800, cached_input_tokens: 0, output_tokens: 12 } }));
`, { mode: 0o755 });
  const cred = await credOf("codex", "login");
  assert.equal(cred.billing, "unknown", "a stored login: its calls decide");
  const { records, stored } = await stage({
    harness: "codex",
    model: "gpt-6.1-sol",
    cred,
    run: async () => {
      const call = await runDecision({ harness: "codex", model: "gpt-6.1-sol", prompt: "q", env: { HOME: process.env.HOME, PATH: `${bin}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, CODEX_HOME: home } });
      assert.equal(call.ok, true, call.error);
      return [keepDecision(call)];
    },
  });
  assert.deepEqual([records[0].planLimits, records[0].billing], [true, "subscription"]);
  assert.equal(existsSync(join(home, "sessions", "2026", "11", "16", `rollout-2026-11-16T00-00-00-${thread}.jsonl`)), false, "the call's rollout is removed after the read");
  assert.deepEqual([stored.billing, Object.keys(stored.usdByBilling)], ["subscription", ["subscription"]]);
});

test("decision records keep the pass's key source and billing through keepDecision and foldDecision", async () => {
  const cred = await credOf("claude", "login");
  const { records, stored } = await stage({
    harness: "claude",
    model: "m-1",
    cred,
    run: async () => {
      const env = { ...BASE, TMPDIR: process.env.TMPDIR, FAKE_ANSWER: '{"choice":"x","confidence":0.9}', FAKE_USD: "0.02", FAKE_STORED: "claudeai" };
      const one = await runDecision({ harness: "claude", model: "m-1", prompt: "q", env });
      const two = await runDecision({ harness: "claude", model: "m-1", prompt: "q", env });
      assert.deepEqual([one.billing, one.apiKeySource, one.planLimits], ["subscription", "none", true], "stamped as the call ended");
      const kept = keepDecision(one);
      assert.deepEqual([kept.billing, kept.apiKeySource, kept.planLimits], ["subscription", "none", true]);
      foldDecision(kept, keepDecision(two));
      assert.deepEqual([kept.calls, kept.billing, kept.apiKeySource], [2, "subscription", "none"]);
      return [kept];
    },
  });
  assert.equal(records[0].decision, true);
  assert.deepEqual([stored.billing, stored.usdByBilling], ["subscription", { subscription: 0.04 }]);
});

test("the running spend line and status line say what the passes' dollars are, as each pass booked them when it ended", async () => {
  // One stage process (its spend so far is the process's own): a login, one pass on a Console key and one on a claude.ai
  // login, each booked by its own as it ended; the default local writer's line after them.
  const gh = await fakeGitHub();
  const script = `
    import { progressReporter } from ${JSON.stringify(LIB("session.mjs"))};
    import { credentialEnv, runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { repoOf } from ${JSON.stringify(LIB("github.mjs"))};
    process.env.PENDULUM_LOCAL = "1";
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness: "claude" });
    delete process.env.PENDULUM_LOCAL;
    progress.billing((await credentialEnv({ harness: "claude", credential: "login", inputs: {}, env: process.env })).billing);
    const env = { HOME: process.env.HOME, PATH: process.env.PATH };
    await runHarness({ harness: "claude", model: "m", prompt: "p", maxUsd: 0, cwd: process.env.HOME, env: { ...env, FAKE_USD: "0.5", FAKE_KEY_SOURCE: "/login managed key" }, timeoutMs: 60_000, label: "work-1" });
    await runHarness({ harness: "claude", model: "m", prompt: "p", maxUsd: 0, cwd: process.env.HOME, env: { ...env, FAKE_USD: "0.25", FAKE_STORED: "claudeai" }, timeoutMs: 60_000, label: "work-2" });
    await progress("work-2 ended");
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: process.env.HOME, PATH: BASE.PATH, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("exit", r));
  gh.close();
  assert.equal(code, 0, err);
  const line = spendParts(gh.written.at(-1));
  assert.deepEqual([line?.usd, line?.usdByBilling], [0.75, { api: 0.5, subscription: 0.25 }], gh.written.at(-1));
  // The status line: a finished pass's dollars as its record will say.
  const said = (feed, billing) => {
    const a = harnessActivity();
    for (const l of feed) a.feed(JSON.stringify(l));
    a.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 1.2 }));
    return activityLine(a.snapshot(), { harness: "claude", model: "claude-opus-5-5", billing });
  };
  const init = (src) => ({ type: "system", subtype: "init", session_id: "s1", apiKeySource: src, claude_code_version: "2.1.326" });
  const limits = { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: "s1" };
  assert.ok(said([init("none")], "subscription").includes(`, $1.20 ${SUB}`));
  assert.ok(said([init("none"), limits], "unknown").includes(`, $1.20 ${SUB}`), "a stored login's limits");
  assert.ok(said([init("none")], "unknown").includes(`, $1.20 ${UNKNOWN}`));
  assert.match(said([init("ANTHROPIC_API_KEY")], "subscription"), /, \$1\.20(;|$)/, "a key Claude Code reports is billed");
});

test("a stopped stage's usage keeps its passes' billing: the pass that ended and the one still running at the stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "billing-stop-"));
  const script = `
    import { mkdtempSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { runHarness, setStageBilling, credentialEnv } from ${JSON.stringify(LIB("harness.mjs"))};
    import { stopStage, writeUsage } from ${JSON.stringify(LIB("session.mjs"))};
    globalThis.fetch = async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    process.env.GITHUB_API_URL = "https://github.test";
    const root = process.env.FAKE_STATE;
    const cred = await credentialEnv({ harness: "claude", credential: "plan", inputs: { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, env: process.env });
    setStageBilling(cred.billing);
    const env = { HOME: process.env.HOME, PATH: process.env.PATH, ...cred.env };
    await runHarness({ harness: "claude", model: "m", prompt: "p", maxUsd: 0, cwd: root, env: { ...env, FAKE_USD: "0.7" }, timeoutMs: 60_000, label: "work-1" });
    runHarness({ harness: "claude", model: "m", prompt: "p", maxUsd: 0, cwd: root, env: { ...env, FAKE_SLEEP: "1" }, timeoutMs: 60_000, label: "work-2" });
    await new Promise((r) => setTimeout(r, 1500));
    const dir = mkdtempSync(join(root, "usage-"));
    // The worker's stopped end (worker.mjs finish and endNow): writeUsage on the stop's records, with the stage's billing.
    const records = [];
    const write = (exit, reason, recs) => writeUsage(dir, { harness: "claude", model: "m", records: recs, passes: 2, exit, reason, credentialBasis: cred.basis, billing: cred.billing });
    await stopStage({ cause: "unlabeled", label: "pendulum:objective", repo: { owner: "a", name: "b", full: "a/b" }, issue: 7, records, finish: async (exit, reason) => write(exit, reason, records), endNow: (recs, why) => write("stopped", why, recs), opts: { token: "t" }, exit: () => {} });
    process.stdout.write(readFileSync(join(dir, "result.json"), "utf8").replace(/\\n/g, " ") + "\\n");
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: process.env.HOME, PATH: BASE.PATH, TMPDIR: process.env.TMPDIR, FAKE_STATE: root }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  assert.equal(await new Promise((r) => child.on("exit", r)), 0, err);
  const stored = JSON.parse(out.trim().split("\n").at(-1));
  assert.equal(stored.exit, "stopped");
  assert.deepEqual([stored.billing, stored.usdByBilling, stored.usd, stored.usdUnknown], ["subscription", { subscription: 0.7 }, 0.7, 1], JSON.stringify(stored));
  // Every usage write of the work and review stages, the stop's included, passes the stage's billing.
  for (const f of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    const calls = src.match(/writeUsage\(usageDir, \{[^\n]*/g) ?? [];
    assert.ok(calls.length >= 2, f);
    for (const c of calls) assert.ok(c.includes("billing: credentialBilling"), `${f}: ${c.slice(0, 160)}`);
  }
});

test("the rebase line, the rebase tally, the vendor comment and an account's share carry the billing, with no stray $0.00 part", async () => {
  const usage = { usd: 0.8, usdByBilling: { subscription: 0.8 }, billing: "subscription" };
  const cost = rebaseCost(usage, { records: [{ usd: 0.8 }] });
  assert.deepEqual(cost, { usd: 0.8, usdByBilling: { subscription: 0.8 }, billing: "subscription" });
  const marker = rebaseCostMarker({ ...cost, conflict: false });
  assert.equal(marker, '<!-- pendulum:rebase-cost {"usd":0.8,"conflict":false,"usdByBilling":{"subscription":0.8},"billing":"subscription"} -->');
  const stageComment = (id, m) => ({ user: { login: "me" }, body: `<!-- pendulum:7:progress:work:${id} -->\n${m}` });
  const third = rebaseCostMarker({ usd: 0.3333333, conflict: false, usdByBilling: { api: 0.3333333 }, billing: "api" });
  const tally = rebaseTally([stageComment(1, marker), stageComment(2, third)], 7, () => true);
  assert.deepEqual(tally.byBilling, { subscription: 0.8, api: 0.333333 });
  assert.equal(rebaseLine({ ...cost, conflict: false, passes: 1 }, tally), `rebase 3 of this Objective (clean, 1 fix pass(es)): $0.80 ${SUB}; all its rebases: $1.93: $1.60 ${SUB} + $0.33 API`);
  // The tally rounds its total to 1/100 cent and its parts to the micro-dollar: no "$0.00" remainder.
  assert.ok(!/\$0\.00/.test(spendText({ usd: tally.usd, unknown: 0, byBilling: tally.byBilling })), spendText({ usd: tally.usd, unknown: 0, byBilling: tally.byBilling }));
  // A sandbox stage with no progress comment: the vendor comment carries the model's billing; the vendor's dollars none.
  const body = vendorBody({ line: "- 00:00Z sandbox", vendorUsd: 0.1, modelUsd: 0.8, modelBilling: usage });
  assert.deepEqual(spendParts(body), { usd: 0.9, modelUsd: 0.8, vendorUsd: 0.1, usdByBilling: { subscription: 0.8 }, billing: "subscription" });
  assert.equal(spendText(spendOf(body)), `$0.90: $0.80 ${SUB} + $0.10`, "the vendor's dollars a bare part");
  // An account's share in the Harness cell, summed from 1/100-cent figures: no stray part either.
  const use = accountUse([{ account: "alpha", usd: 0.3333, usdByBilling: { subscription: 0.333333 } }, { account: "alpha", usd: 0.3333, usdByBilling: { subscription: 0.333333 } }]);
  assert.deepEqual(use[0].usdByBilling, { subscription: 0.666666 });
  assert.ok(!/\$0\.00/.test(markdownTable([{ ...scoreObjective(localMerge(8), { prices, now: "2031-03-05T00:00:00Z" }), accountUse: use }])));
  // The day's total from a rounded figure and unrounded parts: no "+ $0.00".
  assert.equal(spendText({ usd: 1.5, unknown: 0, byBilling: { subscription: 1.2, api: 0.300004 } }), `$1.50: $1.20 ${SUB} + $0.30 API`);
  assert.equal(spendText({ usd: 1.2, unknown: 0, byBilling: { subscription: 1.2, api: 0.001 } }), `$1.20 ${SUB}`, "a part under half a cent is not shown");
});

test("a figure that names no billing (a record from before it) reads as it is; an unknown code is dropped", () => {
  assert.equal(spendText({ usd: 1.2, unknown: 0 }), "$1.20");
  assert.equal(spendText({ usd: 0, unknown: 0, byBilling: { subscription: 0 } }), `$0.00 ${SUB}`);
  assert.equal(spendText({ usd: 2, unknown: 1, byBilling: { subscription: 2, "included-credits": 5 } }), `$2.00 ${SUB} plus 1 run of unknown cost`);
  assert.deepEqual(stageSpendLine({ usd: 1, usdByBilling: {} }).parts, {});
  assert.equal(spendOf(spendMarker(1, { usdByBilling: { credits: 1 }, billing: "credits" })).byBilling.credits, 1);
  // No "not a charge" words, and none of the old kind names, anywhere Pendulum writes them.
  for (const f of ["plugin/scripts/lib/usage.mjs", "plugin/scripts/lib/logic.mjs", "bench/lib/cost.mjs", "README.md", "docs/INSTALL.md", "docs/LOCAL.md", "docs/PLAN.md", "bench/README.md"]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.ok(!/not a charge|included-credits|API-equivalent \(included credits\)/.test(text), f);
  }
});
