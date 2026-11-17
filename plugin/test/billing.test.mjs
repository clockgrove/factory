// What a dollar figure is (#481): billed API spend, a subscription's API-equivalent figure or Copilot's included
// credits, from the credential that ran it (credentialEnv), never from prose or a guess. Each case runs the real pass
// (runHarness on a fake harness CLI) on the credential credentialEnv reads, and follows its record end to end: the
// stage's result.json, its progress comment (exit line and spend line, written to a fake GitHub by the stage's real
// progress reporter), the daily_usd total and its words, and the scorecard from the artifact and from the spend line.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialEnv, runHarness } from "../scripts/lib/harness.mjs";
import { progressReporter, writeUsage } from "../scripts/lib/session.mjs";
import { activityLine, capReached, copilotCount, harnessActivity, selectReady, stageSpendLine, usdText } from "../scripts/lib/logic.mjs";
import { addKeySpend } from "../scripts/lib/gateway-relay.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { todaysSpend } from "../scripts/dispatch.mjs";
import { costOf, loadPrices } from "../../bench/lib/cost.mjs";
import { markdownTable, scoreObjective, spendRecords } from "../../bench/lib/objective.mjs";
import { localMerge } from "../../bench/test/fixtures/github.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures");
const prices = loadPrices();

/**
 * Fake `claude` and `copilot` CLIs. Claude prints Claude Code 2.1.326's init line (its `apiKeySource`: "none" on an
 * OAuth login or token, the key's source on an API key; FAKE_KEY_SOURCE) and a result of FAKE_USD with modelUsage in
 * 2.1.325's shape (`provider`, `costBasis`). Copilot copies the 1.0.107 usage file to its --usage-output-file.
 */
function fakeBin() {
  const bin = mkdtempSync(join(tmpdir(), "billing-"));
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const usd = Number(process.env.FAKE_USD);
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5", apiKeySource: process.env.FAKE_KEY_SOURCE, claude_code_version: "2.1.326" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "s1", total_cost_usd: usd, usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { "claude-opus-5-5": { inputTokens: 30, outputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd, provider: process.env.FAKE_PROVIDER || "firstParty", costBasis: "list" } } }));
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

/** One real pass on `harness` with the credential's env, as the worker runs it. */
async function pass(harness, model, credEnv, fake = {}) {
  const dir = mkdtempSync(join(tmpdir(), "billing-pass-"));
  return runHarness({ harness, model, prompt: "p", maxUsd: 25, cwd: dir, eventsFile: join(dir, "events.jsonl"), env: { HOME: process.env.HOME, PATH: `${BIN}:${process.env.PATH}`, ...credEnv, ...fake }, timeoutMs: 60_000, label: "work-1" });
}

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
 * One stage's end as worker.mjs runs it, on `records` and the credential's `billing`: result.json, the spend line and
 * the exit line in its progress comment. Returns the stored record and the comment body.
 */
async function stageEnd({ harness, model, records, cred }) {
  const dir = mkdtempSync(join(tmpdir(), "billing-usage-"));
  const gh = await fakeGitHub();
  try {
    return await onGitHub(gh.url, async () => {
      const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness, model, soFar: null });
      progress.billing(cred.billing);
      const usage = writeUsage(dir, { harness, model, records, passes: records.length, exit: "delivered", reason: "", credentialBasis: cred.basis, billing: cred.billing });
      const line = stageSpendLine(usage);
      progress.spend(line.usd, line.parts);
      await progress(`exit: delivered; usd ${usdText(usage)}${copilotCount(usage)}`);
      return { usage, stored: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), body: gh.written.at(-1) };
    });
  } finally {
    gh.close();
  }
}

/** The day's total from that comment (todaysSpend, the sandbox route: spend lines only) and the gate's words at it. */
async function dayOf(body) {
  const gh = await fakeGitHub(() => [{ id: 1, user: { login: "owner", type: "User" }, author_association: "OWNER", updated_at: new Date().toISOString(), body }]);
  try {
    const day = await onGitHub(gh.url, () => todaysSpend(repoOf("o/r"), { sandbox: true }, { token: "t" }));
    const gate = selectReady({ issues: [{ number: 9, labels: [] }], maxConcurrent: 3, dailyUsd: 0.01, spentToday: day.spentToday, unknownToday: day.unknownToday, billingToday: day.billingToday });
    return { day, words: gate.skipped[0].reason };
  } finally {
    gh.close();
  }
}

/** The scorecard's Cost cell and basis, from the usage artifact and from the progress comment's spend line. */
function scorecard(stored, body, harness) {
  const fromArtifact = costOf([{ ...stored, artifact: "pendulum-usage-7" }], prices, { harness });
  const c = localMerge(7);
  c.issueComments = [{ ...c.issueComments[0], body: body.replace(/^<!-- pendulum:7:progress:work:1 -->/, "<!-- pendulum:7:progress:work:1700000001 -->") }, c.issueComments[1]];
  const lines = spendRecords(c, {});
  const row = scoreObjective(c, { prices, now: "2031-03-05T00:00:00Z" });
  const costCell = markdownTable([row]).split("\n")[2].split(" | ")[8];
  return { fromArtifact, fromLine: costOf(lines, prices, { harness }), costCell };
}

test("credentialEnv names what each credential's dollars are, from the credential itself", async () => {
  const read = (harness, credential, inputs, env = {}) => credentialEnv({ harness, credential, inputs, env: { PATH: "/usr/bin", ...env } }).then((c) => c.billing);
  assert.equal(await read("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }), "subscription");
  assert.equal(await read("claude", "api", { anthropicApiKey: "sk-ant-api03-dummy" }), "api");
  assert.equal(await read("claude", "login", {}), "subscription", "the CLI's own sign-in");
  assert.equal(await read("claude", "login", {}, { ANTHROPIC_API_KEY: "sk-ant-api03-dummy" }), "api", "a login that carries an API key variable");
  assert.equal(await read("codex", "api", { codexApiKey: "sk-proj-dummy" }), "api");
  assert.equal(await read("codex", "api", { codexApiKey: JSON.stringify({ tokens: { access_token: "x" } }) }), "subscription", "a ChatGPT login (local mode)");
  assert.equal(await read("codex", "api", { codexGatewayKey: "vck_dummy" }), "api", "the AI Gateway");
  assert.equal(await read("codex", "login", {}), "subscription");
  assert.equal(await read("copilot", "api", { copilotGithubToken: "github_pat_dummy" }), "included-credits");
  // On Actions the same: the plan token is a subscription's there too.
  assert.equal(await read("claude", "plan", { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, { GITHUB_ACTIONS: "true" }), "subscription");
});

test("a Claude run on a plan credential is labelled subscription in result.json, the exit line, the spend line, the day's total and the scorecard", async () => {
  const cred = await credentialEnv({ harness: "claude", credential: "plan", inputs: { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, env: { PATH: "/usr/bin" } });
  const rec = await pass("claude", "claude-opus-5-5", cred.env, { FAKE_USD: "1.2", FAKE_KEY_SOURCE: "none" });
  assert.equal(rec.apiKeySource, "none", "Claude Code's own word on its key is kept");
  assert.deepEqual([rec.models["claude-opus-5-5"].provider, rec.models["claude-opus-5-5"].costBasis], ["firstParty", "list"], "modelUsage's provider and costBasis are kept");
  const { usage, stored, body } = await stageEnd({ harness: "claude", model: "claude-opus-5-5", records: [rec], cred });
  assert.deepEqual(stored.usdByBilling, { subscription: 1.2 }, "result.json");
  assert.equal(usdText(usage), "1.2 API-equivalent (subscription)", "the exit line");
  assert.match(body, /exit: delivered; usd 1\.2 API-equivalent \(subscription\)$/m, "the progress comment's exit line");
  assert.match(body, /^<!-- pendulum:spend \{"usd":1\.2,"usdByBilling":\{"subscription":1\.2\}\} -->$/m, "the spend line");
  // The cap stays in dollars: the API-equivalent figure counts against max_usd and daily_usd as it is.
  assert.equal(capReached(1.2, [rec]), true, "max_usd compares the figure");
  const { day, words } = await dayOf(body);
  assert.deepEqual([day.spentToday, day.billingToday], [1.2, { subscription: 1.2 }], "daily_usd's total");
  assert.equal(words, "daily_usd reached ($1.20 API-equivalent (subscription) of $0.01)", "daily_usd's words");
  const card = scorecard(stored, body, "claude");
  for (const [from, cost] of [["artifact", card.fromArtifact], ["spend line", card.fromLine]]) {
    assert.deepEqual(cost.usdByBilling, { subscription: 1.2 }, `the scorer from the ${from}`);
    assert.match(cost.basis, /1\.2 USD API-equivalent \(subscription\), not a charge/, `the scorer's basis from the ${from}`);
  }
  assert.match(card.costCell, /^\$1\.20 API-equivalent \(subscription\)/, "the scorecard's Cost cell");
});

test("a Claude run on an API key is labelled api: the bare figure everywhere, billed spend in the scorer's basis", async () => {
  const cred = await credentialEnv({ harness: "claude", credential: "api", inputs: { anthropicApiKey: "sk-ant-api03-dummy" }, env: { PATH: "/usr/bin" } });
  const rec = await pass("claude", "claude-opus-5-5", cred.env, { FAKE_USD: "1.2", FAKE_KEY_SOURCE: "ANTHROPIC_API_KEY" });
  const { usage, stored, body } = await stageEnd({ harness: "claude", model: "claude-opus-5-5", records: [rec], cred });
  assert.deepEqual(stored.usdByBilling, { api: 1.2 });
  assert.equal(usdText(usage), "1.2");
  assert.match(body, /exit: delivered; usd 1\.2$/m);
  assert.match(body, /^<!-- pendulum:spend \{"usd":1\.2,"usdByBilling":\{"api":1\.2\}\} -->$/m);
  const { words } = await dayOf(body);
  assert.equal(words, "daily_usd reached ($1.20 of $0.01)");
  const card = scorecard(stored, body, "claude");
  assert.match(card.fromArtifact.basis, /; billed API spend$/);
  assert.match(card.costCell, /^\$1\.20/);
  assert.doesNotMatch(card.costCell, /API-equivalent/, "no API-equivalent words on billed spend");
  // A local login whose Claude Code reports an API key (a Console login) or a third-party provider is billed too.
  const login = await credentialEnv({ harness: "claude", credential: "login", inputs: {}, env: { PATH: "/usr/bin" } });
  assert.equal(login.billing, "subscription");
  const keyed = await pass("claude", "claude-opus-5-5", login.env, { FAKE_USD: "0.5", FAKE_KEY_SOURCE: "/login managed key" });
  const bedrock = await pass("claude", "claude-opus-5-5", login.env, { FAKE_USD: "0.25", FAKE_KEY_SOURCE: "none", FAKE_PROVIDER: "bedrock" });
  const both = await stageEnd({ harness: "claude", model: "claude-opus-5-5", records: [keyed, bedrock], cred: login });
  assert.deepEqual(both.stored.usdByBilling, { api: 0.75 });
});

test("a Copilot run is labelled included-credits: its credits' dollars are API-equivalent everywhere", async () => {
  const cred = await credentialEnv({ harness: "copilot", credential: "api", inputs: { copilotGithubToken: "github_pat_dummy" }, env: { PATH: "/usr/bin" } });
  const rec = await pass("copilot", "claude-sonnet-5.5", cred.env);
  assert.ok(rec.usd > 0 && /AI credits/.test(rec.basis), `the credits priced: ${rec.usd} (${rec.basis})`);
  const { usage, stored, body } = await stageEnd({ harness: "copilot", model: "claude-sonnet-5.5", records: [rec], cred });
  assert.deepEqual(stored.usdByBilling, { "included-credits": rec.usd });
  assert.equal(usdText(usage), `${rec.usd} API-equivalent (included credits)`);
  assert.ok(body.includes(`exit: delivered; usd ${rec.usd} API-equivalent (included credits); 1 premium request, ${usage.aiCredits} AI credits`), body);
  assert.ok(body.includes(`"usdByBilling":{"included-credits":${rec.usd}}`), body);
  const { words } = await dayOf(body);
  assert.equal(words, "daily_usd reached ($0.06 API-equivalent (included credits) of $0.01)");
  const card = scorecard(stored, body, "copilot");
  assert.match(card.fromArtifact.basis, /API-equivalent \(included credits\), not a charge/);
  assert.match(card.fromLine.basis, /API-equivalent \(included credits\), not a charge/);
  assert.match(card.costCell, /^\$0\.06 API-equivalent \(included credits\)/);
});

test("a stage mixing a subscription's figure and billed API spend (a relayed AI Gateway key) shows both parts everywhere", async () => {
  const cred = await credentialEnv({ harness: "claude", credential: "plan", inputs: { claudeCodeOauthToken: "sk-ant-oat01-dummy" }, env: { PATH: "/usr/bin" } });
  const rec = await pass("claude", "claude-opus-5-5", cred.env, { FAKE_USD: "1.2", FAKE_KEY_SOURCE: "none" });
  // The pass's calls through the relayed worker key (gateway-relay.mjs): billed on the gateway key.
  addKeySpend(rec, { usd: 0.3, calls: 2, unknown: 0 });
  const { usage, stored, body } = await stageEnd({ harness: "claude", model: "claude-opus-5-5", records: [rec], cred });
  assert.deepEqual(stored.usdByBilling, { subscription: 1.2, api: 0.3 });
  assert.equal(usdText(usage), "1.5 (1.2 API-equivalent (subscription) + 0.3 API) (harness 1.2, worker key 0.3)");
  assert.match(body, /^<!-- pendulum:spend \{"usd":1\.5,"workerKeyUsd":0\.3,"usdByBilling":\{"subscription":1\.2,"api":0\.3\}\} -->$/m);
  const { words } = await dayOf(body);
  assert.equal(words, "daily_usd reached ($1.50 ($1.20 API-equivalent (subscription) + $0.30 API) of $0.01)");
  const card = scorecard(stored, body, "claude");
  for (const cost of [card.fromArtifact, card.fromLine]) {
    assert.deepEqual(cost.usdByBilling, { subscription: 1.2, api: 0.3 });
    assert.match(cost.basis, /1\.2 USD API-equivalent \(subscription\), not a charge; 0\.3 USD billed API spend/);
  }
  assert.match(card.costCell, /^\$1\.50 \(\$1\.20 API-equivalent \(subscription\) \+ \$0\.30 API\)/);
});

test("the running stage's spend line names its credential's billing and the relayed key's share before the final figure", async () => {
  const gh = await fakeGitHub();
  try {
    await onGitHub(gh.url, async () => {
      let live = { usd: 1.5, keyUsd: 0.3, unknown: 1 };
      const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness: "claude", soFar: async () => live });
      progress.billing("subscription");
      await progress("work-1");
      live = { usd: 0, keyUsd: 0, unknown: 1 };
      await progress("work-2");
    });
  } finally {
    gh.close();
  }
  assert.match(gh.written[0], /^<!-- pendulum:spend \{"usd":1\.5,"usdByBilling":\{"subscription":1\.2,"api":0\.3\},"usdUnknown":1,"usdUnknownWhy":\["unreported"\]\} -->$/m);
  assert.match(gh.written[1], /^<!-- pendulum:spend \{"usd":0,"usdByBilling":\{"subscription":0\},"usdUnknown":1,"usdUnknownWhy":\["unreported"\]\} -->$/m);
});

test("the running status line says what a finished pass's dollars are, from Claude Code's own init line", () => {
  const line = (keySource) => {
    const a = harnessActivity();
    a.feed(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", apiKeySource: keySource, claude_code_version: "2.1.326" }));
    a.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 1.2 }));
    return activityLine(a.snapshot(), { harness: "claude", model: "claude-opus-5-5", billing: "subscription" });
  };
  assert.match(line("none"), /, \$1\.20 API-equivalent \(subscription\)/);
  assert.match(line("ANTHROPIC_API_KEY"), /, \$1\.20(;|$)/, "a key Claude Code reports is billed");
});

test("a figure that names no billing (a record written before it, a sandbox vendor's dollars) reads as it is: no words added", async () => {
  const { spendText } = await import("../scripts/lib/logic.mjs");
  assert.equal(spendText({ usd: 1.2, unknown: 0 }), "$1.20");
  assert.equal(spendText({ usd: 1.5, unknown: 0, byBilling: { subscription: 1.2 } }), "$1.50 ($1.20 API-equivalent (subscription) + $0.30)", "the vendor's $0.30 is no part of the subscription's");
  assert.equal(spendText({ usd: 0, unknown: 0, byBilling: { subscription: 0 } }), "$0.00 API-equivalent (subscription)");
  assert.equal(spendText({ usd: 2, unknown: 1, byBilling: { subscription: 2, bogus: 5 } }), "$2.00 API-equivalent (subscription) plus 1 run of unknown cost", "an unknown code is dropped");
});
