import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jsonLines, parseUsage, providerRefusal } from "../scripts/lib/usage.mjs";
import { REASON_MAX, decideExit } from "../scripts/lib/logic.mjs";
import { crashed } from "../scripts/lib/session.mjs";

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

test("runHarness and exitRecord: one refused Codex call, no second ask, the exit record Blocks with the refusal", async () => {
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  const { exitRecord } = await import("../scripts/lib/session.mjs");
  const bin = mkdtempSync(join(tmpdir(), "pendulum-codex-refused-"));
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
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
    assert.equal(rec.refusal?.code, "codex_byok_restricted_by_api_credit_promo");
    assert.equal(crashed(rec), false);
    const asked = await exitRecord({ text: undefined, harness: "codex", model: "gpt-6.1-sol", session: { id: null, canResume: false }, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, deadlineAt: Date.now() + 600_000, maxUsd: 0 });
    assert.equal(asked.record.exit, "blocked");
    assert.match(asked.record.reason, /^codex was refused by its provider \(HTTP 400/);
    assert.equal(asked.usage.length, 1);
    assert.equal(readFileSync(calls, "utf8"), "xx", "one call each, nothing retried");
  } finally {
    process.env.PATH = saved;
  }
});

// Claude Code 2.1.325 against a provider that refused the connection, and one that answered 529 (overloaded).
test("providerError and providerOutage: a failed run's provider error is read from the harness's own structure, never its words", () => {
  const fields = (r) => r && { status: r.status, type: r.type, code: r.code };
  const refused = failed("claude", fixture("claude-2.1.325-connection-refused.jsonl"));
  assert.deepEqual(fields(refused.providerOutage), { status: null, type: "server_error", code: "connection_failed" });
  assert.equal(refused.refusal, undefined);
  // A 529 carries its status: the provider busy (providerBusy), no outage of this reading.
  const busy = failed("claude", fixture("claude-2.1.325-529.jsonl"));
  assert.deepEqual([busy.busy?.status, busy.providerOutage, busy.providerError], [529, undefined, undefined]);
  assert.equal(failed("claude", fixture("claude-2.1.321-401.jsonl")).providerOutage, undefined, "a refusal is no outage");
  // Codex: a JSON error body with no status and the type server_error is one; one with a 5xx or 429 status is busy; a
  // 409 is a provider error, no outage.
  const body = (status, type = "server_error") => JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type, code: null, message: "m" }, ...(status === null ? {} : { status }) }) } });
  assert.deepEqual(fields(failed("codex", body(null)).providerOutage), { status: null, type: "server_error", code: null });
  for (const status of [503, 429]) assert.deepEqual([failed("codex", body(status)).busy?.status, failed("codex", body(status)).providerOutage], [status, undefined], `HTTP ${status}`);
  assert.equal(failed("codex", body(409)).providerOutage, undefined);
  assert.deepEqual(fields(failed("codex", body(409)).providerError), { status: 409, type: "server_error", code: null });
  // The gateway's bare 5xx bodies, with no status: the provider busy, as a 5xx with its status is.
  for (const type of ["service_unavailable_error", "overloaded_error", "internal_server_error"]) {
    const rec = failed("codex", body(null, type));
    assert.deepEqual([fields(rec.busy), rec.providerOutage, rec.refusal], [{ status: null, type, code: null }, undefined, undefined], type);
  }
  // Another bare type with no status: a provider error that names no outage by itself (harness.mjs probes for it).
  assert.deepEqual([fields(failed("codex", body(null, "api_error")).providerError), failed("codex", body(null, "api_error")).busy], [{ status: null, type: "api_error", code: null }, undefined]);
  // A 5xx that carries an auth, permission, quota or billing type is that refusal, never busy; any other 5xx is busy.
  for (const type of ["authentication_error", "permission_error", "insufficient_quota", "billing_error"]) {
    const rec = failed("codex", body(503, type));
    assert.deepEqual([rec.refusal?.status, rec.refusal?.type, rec.busy, rec.providerError], [503, type, undefined, undefined], type);
  }
  // Codex prints a 5xx and a lost stream as prose: no structure at all.
  for (const prose of ["unexpected status 503 Service Unavailable: Service Unavailable, url: http://127.0.0.1:8080/v1/responses", "stream disconnected before completion: error sending request"]) {
    const rec = failed("codex", JSON.stringify({ type: "turn.failed", error: { message: prose } }));
    assert.deepEqual([rec.providerOutage, rec.providerError], [undefined, undefined], prose);
  }
  // Copilot: session.error's statusCode; one with none is a provider error that names no outage.
  const copilot = fixture("copilot-1.0.107-session-error.jsonl").replace('"errorType":"quota","errorCode":"quota_exceeded","statusCode":402', '"errorType":"server","errorCode":"bad_gateway","statusCode":502');
  assert.deepEqual([failed("copilot", copilot).busy?.status, failed("copilot", copilot).providerOutage], [502, undefined]);
  const bare = fixture("copilot-1.0.107-session-error.jsonl").replace('"errorType":"quota","errorCode":"quota_exceeded","statusCode":402', '"errorType":"query"');
  assert.deepEqual([fields(failed("copilot", bare).providerError), failed("copilot", bare).providerOutage], [{ status: null, type: "query", code: null }, undefined]);
  assert.equal(failed("copilot", fixture("copilot-1.0.107-session-error.jsonl")).providerOutage, undefined);
  // Claude's API error with no status and a type other than server_error (`unknown`): no outage by itself, and no refusal.
  const unknown = failed("claude", fixture("claude-2.1.325-connection-refused.jsonl").replace('"error":"server_error"', '"error":"unknown"').replaceAll('"api_error":"connection_failed"', '"api_error":null'));
  assert.deepEqual([fields(unknown.providerError), unknown.providerOutage, unknown.refusal], [{ status: null, type: "unknown", code: null }, undefined, undefined]);
});
