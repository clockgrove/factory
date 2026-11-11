import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jsonLines, parseUsage, providerRefusal } from "../scripts/lib/usage.mjs";
import { REASON_MAX, decideExit } from "../scripts/lib/logic.mjs";
import { crashed } from "../scripts/lib/session.mjs";
import { reviewCallEnd } from "../scripts/lib/handoff.mjs";

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (f) => readFileSync(join(fixtures, f), "utf8");
// A failed run as runHarness returns it: the parsed record plus the process's exit.
const failed = (harness, text, exitCode = 1) => ({ ...parseUsage(harness, text, null, exitCode), exitCode, signal: null, timedOut: false });

// Codex 0.167.1 on the cloud sandbox route: every request refused with HTTP 400 (the usage artifact's events.jsonl).
test("codex: a 400 refusal is read from turn.failed's JSON body, not counted as a death, and Blocks naming it", () => {
  const rec = failed("codex", fixture("codex-0.167-refused-400.jsonl"));
  assert.deepEqual({ ...rec.refusal, message: undefined }, { harness: "codex", status: 400, type: "invalid_request_error", code: "codex_byok_restricted_by_api_credit_promo", message: undefined });
  assert.equal(rec.error, "refused by the provider: HTTP 400 invalid_request_error codex_byok_restricted_by_api_credit_promo");
  assert.equal(crashed(rec), false, "no death, so the worker does not retry it");
  const d = decideExit({ harness: { ...rec, died: 0 }, pr: null, commits: 0 });
  assert.equal(d.exit, "blocked");
  assert.match(d.reason, /^codex was refused by its provider \(HTTP 400 invalid_request_error codex_byok_restricted_by_api_credit_promo\): This organization /);
  assert.match(d.reason, /not retried: the fix is on the credential's account/);
  const quoted = d.reason.slice(d.reason.indexOf("): ") + 3, d.reason.indexOf("; not retried"));
  assert.ok(quoted.length <= REASON_MAX && quoted.endsWith("…"), "the provider's message is clipped");
});

test("codex: a 401 Codex reports only as prose stays a death (retried as before); nothing reads the words", () => {
  const rec = failed("codex", fixture("codex-0.167-401.jsonl"));
  assert.equal(rec.refusal, undefined);
  assert.equal(crashed(rec), true);
});

test("codex: a JSON body with a 429 or 5xx status is retryable; 429 insufficient_quota is not", () => {
  const body = (status, code) => JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type: "x", code, message: "m" }, status }) } });
  assert.equal(providerRefusal("codex", jsonLines(body(429, "rate_limit_exceeded"))), null);
  assert.equal(providerRefusal("codex", jsonLines(body(503, null))), null);
  assert.equal(providerRefusal("codex", jsonLines(body(429, "insufficient_quota"))).code, "insufficient_quota");
  // A turn that completed after the error: the run recovered.
  assert.equal(providerRefusal("codex", jsonLines(`${body(400, "x")}\n{"type":"turn.completed","usage":{}}`)), null);
});

// Claude Code 2.1.321 with a rejected API key: the API error message and the result carry api_error_status.
test("claude: a 401 is a refusal from the result's api_error_status; a 429 or 5xx is not", () => {
  const text = fixture("claude-2.1.321-401.jsonl");
  const rec = failed("claude", text);
  assert.deepEqual(rec.refusal, { harness: "claude", status: 401, type: "authentication_failed", code: null, message: "Invalid API key · Fix external API key" });
  assert.equal(crashed(rec), false);
  assert.match(decideExit({ harness: rec, pr: null, commits: 0 }).reason, /^claude was refused by its provider \(HTTP 401 authentication_failed\): Invalid API key/);
  for (const [status, kind] of [[429, "rate_limit"], [500, "server_error"], [529, "server_error"]]) {
    const retryable = text.replaceAll('"api_error_status":401', `"api_error_status":${status}`).replace('"error":"authentication_failed"', `"error":"${kind}"`);
    assert.equal(parseUsage("claude", retryable, null).refusal, undefined, `HTTP ${status}`);
  }
});

// Copilot 1.0.107's session.error event (copilot-sdk/generated/session-events.d.ts ErrorData).
test("copilot: session.error with a 4xx status or a quota type is a refusal on a failed run; a rate limit is not", () => {
  const text = fixture("copilot-1.0.107-session-error.jsonl");
  const rec = failed("copilot", text);
  assert.deepEqual({ ...rec.refusal, message: undefined }, { harness: "copilot", status: 402, type: "quota", code: "quota_exceeded", message: undefined });
  assert.equal(parseUsage("copilot", text.replace('"exitCode":1', '"exitCode":0'), null, 0).refusal, undefined, "a run that exited 0 recovered");
  const limited = text.replace('"errorType":"quota","errorCode":"quota_exceeded","statusCode":402', '"errorType":"rate_limit","errorCode":"user_global_rate_limited","statusCode":429');
  assert.equal(parseUsage("copilot", limited, null, 1).refusal, undefined);
});

test("a refusal outranks a death count and names itself in the review's account of a call", () => {
  const rec = failed("codex", fixture("codex-0.167-refused-400.jsonl"));
  assert.match(decideExit({ harness: { ...rec, died: 2 }, pr: null }).reason, /^codex was refused/);
  assert.equal(reviewCallEnd(rec, null), "a refusal by the provider (HTTP 400 invalid_request_error codex_byok_restricted_by_api_credit_promo)");
});

test("runHarness and exitRecord: one refused Codex call, no second ask, the exit record Blocks with the refusal", async () => {
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  const { exitRecord } = await import("../scripts/lib/session.mjs");
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-refused-"));
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, "x");
process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, "codex-0.167-refused-400.jsonl"))}, "utf8"));
process.exit(1);
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: bin, env: { PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
    assert.equal(rec.refusal?.code, "codex_byok_restricted_by_api_credit_promo");
    assert.equal(crashed(rec), false);
    const asked = await exitRecord({ text: undefined, harness: "codex", model: "gpt-6.1-sol", session: { id: null, canResume: false }, cwd: bin, env: { PATH: process.env.PATH }, deadlineAt: Date.now() + 600_000, maxUsd: 0 });
    assert.equal(asked.record.exit, "blocked");
    assert.match(asked.record.reason, /^codex was refused by its provider \(HTTP 400/);
    assert.equal(asked.usage.length, 1);
    assert.equal(readFileSync(calls, "utf8"), "xx", "one call each, nothing retried");
  } finally {
    process.env.PATH = saved;
  }
});
