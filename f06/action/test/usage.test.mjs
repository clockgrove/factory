import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { finalText, harnessCommand, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { CODEX_PRICES, mergeUsage, parseClaude, parseCodex, parseCopilot, parseUsage, priceCodex } from "../scripts/lib/usage.mjs";

const fixture = (f) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");

test("claude: single JSON result; total_cost_usd and modelUsage with sub-agents", () => {
  const rec = parseClaude(fixture("claude-result.json"), "claude-fable-5-1");
  assert.equal(rec.harness, "claude");
  assert.equal(rec.ok, true);
  assert.equal(rec.usd, 7.4312);
  assert.equal(rec.sessionId, "3f1c2a9e-9c1a-4e2a-8d3b-aaa111222333");
  assert.equal(rec.turns, 87);
  // input = inputTokens + cacheRead + cacheCreation across both models
  assert.equal(rec.tokens.input, 1200 + 2400000 + 180000 + 800 + 300000 + 20000);
  assert.equal(rec.tokens.output, 41000 + 9000);
  assert.equal(rec.tokens.cached, 2400000 + 300000);
  assert.match(rec.basis, /sub-agents included/);
  assert.equal(rec.budgetExceeded, false);
});

test("claude: stream-json with a non-JSON line and a budget-exceeded result", () => {
  const rec = parseClaude(fixture("claude-stream.jsonl"), null);
  assert.equal(rec.ok, false);
  assert.equal(rec.budgetExceeded, true);
  assert.equal(rec.subtype, "error_max_budget_usd");
  assert.equal(rec.usd, 5.02);
  assert.equal(rec.model, "claude-fable-5-1");
  assert.equal(rec.sessionId, "abc-123");
  assert.equal(finalText("claude", fixture("claude-stream.jsonl")), "Budget of $5 reached");
});

test("claude: no result on stdout is an error record, not a crash", () => {
  const rec = parseClaude("", "m");
  assert.equal(rec.ok, false);
  assert.equal(rec.usd, null);
  assert.match(rec.error, /no JSON result/);
});

test("codex: JSONL turn.completed usage summed and priced from the table", () => {
  const rec = parseCodex(fixture("codex-events.jsonl"), "gpt-6.1-sol");
  assert.equal(rec.ok, true);
  assert.equal(rec.turns, 2);
  assert.equal(rec.sessionId, "thr_01HZX");
  assert.equal(rec.tokens.input, 150000);
  assert.equal(rec.tokens.cached, 115000);
  assert.equal(rec.tokens.output, 10500);
  const p = CODEX_PRICES.perMillion["gpt-6.1-sol"];
  const expected = Math.round(((150000 - 115000) * p.input + 115000 * p.cached + 10500 * p.output) / 1e6 * 10000) / 10000;
  assert.equal(rec.usd, expected);
  assert.match(rec.basis, new RegExp(`priced from table dated ${CODEX_PRICES.date}`));
  assert.equal(finalText("codex", fixture("codex-events.jsonl")).split("\n")[0], "Plan posted.");
});

test("codex: unknown model is unmetered, never zero", () => {
  const rec = parseCodex(fixture("codex-events.jsonl"), "gpt-unknown-9");
  assert.equal(rec.usd, null);
  assert.match(rec.basis, /unmetered: no price for gpt-unknown-9/);
  assert.equal(priceCodex(null, { input: 1 }), null);
  assert.equal(priceCodex("gpt-5.5-codex-2026", { input: 1_000_000, cached: 0, output: 0 }), 1.25, "prefix match");
});

test("copilot: no usage output; dollars null with the billing-window basis", () => {
  const rec = parseCopilot(fixture("copilot-stdout.txt"), null, 0);
  assert.equal(rec.ok, true);
  assert.equal(rec.usd, null);
  assert.deepEqual(rec.tokens, { input: null, output: null, cached: null });
  assert.match(rec.basis, /unmetered: Copilot bills AI Credits/);
  assert.equal(parseCopilot("", null, 2).ok, false);
  assert.equal(parseUsage("copilot", "", null, 0).harness, "copilot");
  assert.throws(() => parseUsage("gemini", ""), /unknown harness/);
});

test("mergeUsage sums runs and keeps null dollars only when every run is unmetered", () => {
  const a = parseClaude(fixture("claude-result.json"), "m");
  const b = parseClaude(fixture("claude-stream.jsonl"), "m");
  const m = mergeUsage([a, b]);
  assert.equal(m.usd, 7.4312 + 5.02);
  assert.equal(m.turns, 87 + 12);
  assert.equal(m.ok, false);
  assert.equal(m.budgetExceeded, true);
  const c = mergeUsage([parseCopilot("", null, 0), parseCopilot("", null, 0)]);
  assert.equal(c.usd, null);
  assert.equal(mergeUsage([]), null);
});

test("harness command lines follow RESEARCH.md; the prompt goes on stdin for claude and codex", () => {
  const c = harnessCommand({ harness: "claude", model: "claude-fable-5-1", prompt: "P", maxUsd: 25 });
  assert.equal(c.cmd, "claude");
  assert.ok(c.args.includes("--output-format") && c.args.includes("--max-budget-usd") && c.args.includes("25"));
  assert.equal(c.stdin, "P");
  const r = harnessCommand({ harness: "claude", prompt: "fix", maxUsd: 0, resume: "sid" });
  assert.deepEqual(r.args.slice(r.args.indexOf("--resume")), ["--resume", "sid"]);
  const x = harnessCommand({ harness: "codex", model: "gpt-6.1-sol", prompt: "P", maxUsd: 1 });
  assert.deepEqual(x.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(x.args.includes("-m") && x.args.at(-1) === "-");
  const xr = harnessCommand({ harness: "codex", prompt: "fix", resume: "thr_1" });
  assert.deepEqual(xr.args.slice(0, 3), ["exec", "resume", "thr_1"]);
  const p = harnessCommand({ harness: "copilot", prompt: "P", agent: "reviewer" });
  assert.deepEqual(p.args.slice(0, 2), ["-p", "P"]);
  assert.ok(p.args.includes("--no-ask-user") && p.args.includes("--agent"));
  assert.equal(p.canResume, false);
});

test("model secrets never reach a non-harness child", () => {
  const e = scrubbedEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", CODEX_API_KEY: "ck", FACTORY_INPUT_CODEX_API_KEY: "ck", FACTORY_INPUT_APP_PRIVATE_KEY: "pem", FACTORY_INPUT_MODEL: "m" }, { GH_TOKEN: "t" });
  assert.deepEqual(e, { PATH: "/bin", FACTORY_INPUT_MODEL: "m", GH_TOKEN: "t" });
});
