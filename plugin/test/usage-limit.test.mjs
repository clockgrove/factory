import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseUsage, providerRefusal } from "../scripts/lib/usage.mjs";
import { BLOCK_CAUSES, blockMarker, decideExit, refusalCause, refusalReason } from "../scripts/lib/logic.mjs";
import { crashed, usageLimitExit } from "../scripts/lib/session.mjs";
import { reviewMissed, reviewRerun } from "../scripts/lib/handoff.mjs";
import { LIMIT_PASS_PROMPT, USAGE_LIMIT, runHarness } from "../scripts/lib/harness.mjs";
import { OUTAGE, resetNetwork, waitOutages } from "../scripts/lib/network.mjs";

// #254: a harness pass that ends on its subscription's usage limit is read from the harness's structured fields, never
// as a crash; no other model of the same subscription runs it; a known reset is waited for (in place, or paused locally
// for serve), else the stage Blocks with the External cause `provider-quota`.

const fixtures = join(import.meta.dirname, "fixtures");
// Claude Code 2.1.323 at its subscription's 5-hour limit (a review stage's events.jsonl, trimmed to the fields read).
const LIMIT_RUN = readFileSync(join(fixtures, "claude-2.1.323-usage-limit.jsonl"), "utf8");
const RESET_S = 1794697200;
const RESET = "2026-11-14T23:00:00.000Z";
const withReset = (text, s) => text.replaceAll(`"resetsAt":${RESET_S}`, `"resetsAt":${s}`);

test("claude: the usage limit is a refusal read from api_error, with the reset from the structured resetsAt; no crash, Blocked provider-quota naming the reset", () => {
  const rec = { ...parseUsage("claude", LIMIT_RUN, "claude-opus-5-5", 1), exitCode: 1, signal: null, timedOut: false };
  assert.deepEqual({ ...rec.refusal, message: undefined }, { harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", message: undefined, limitType: "five_hour", resetAt: Date.parse(RESET) });
  assert.equal(crashed(rec), false);
  const d = decideExit({ harness: { ...rec, died: 0 }, pr: null, commits: 0 });
  assert.equal(d.exit, "blocked");
  assert.equal(d.cause, "provider-quota");
  assert.ok(BLOCK_CAUSES[d.cause].external);
  assert.match(d.reason, new RegExp(`^claude reached its subscription's usage limit \\(HTTP 429 rate_limit usage_limit_reached\\), which resets at ${RESET.replaceAll(".", "\\.")}; not run again on another model`));
  assert.ok(!/crash|5-hour|3pm/.test(d.reason), "structure only: no crash wording, none of the provider's prose");
  // The reset from the last rejected rate_limit_event when the API error message carries none.
  const noParams = LIMIT_RUN.replace(/,"api_error_params":\{"rate_limit_info":\{[^}]*\}\}/, "");
  assert.equal(parseUsage("claude", noParams, null).refusal.resetAt, Date.parse(RESET));
  // No reset reported: still the usage limit, Blocked naming no reset.
  const none = noParams.replace(/\{"type":"rate_limit_event"[^\n]*\n/, "");
  const bare = parseUsage("claude", none, null).refusal;
  assert.equal(bare.resetAt, undefined);
  assert.equal(refusalCause(bare), "provider-quota");
  assert.match(refusalReason(bare), /with no reset time reported; .*once the limit has reset/);
});

test("claude: with no resetsAt on the API error, the reset is the last rejected rate_limit_event of the error's own window", () => {
  const weekly = Date.parse(RESET) / 1000 + 5 * 86_400;
  const text = LIMIT_RUN.replace('"rateLimitType":"five_hour"}},"api_error_origin"', '"rateLimitType":"five_hour"}},"api_error_origin"')
    .replace(/("api_error_params":\{"rate_limit_info":\{"status":"rejected"),"resetsAt":\d+/, "$1")
    .replace(/(\{"type":"rate_limit_event"[^\n]*\n)/, `$1{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${weekly},"rateLimitType":"seven_day"},"session_id":"x"}\n`);
  assert.ok(!/"api_error_params":\{"rate_limit_info":\{[^}]*resetsAt/.test(text), "the fixture's API error carries no reset");
  const r = parseUsage("claude", text, null).refusal;
  assert.equal(r.limitType, "five_hour");
  assert.equal(r.resetAt, Date.parse(RESET), "the five-hour window's reset, not the later seven-day one");
});

test("copilot's quota stays a provider-quota refusal with no reset", () => {
  const copilot = providerRefusal("copilot", [{ type: "session.error", data: { statusCode: 402, errorType: "quota", errorCode: "quota_exceeded", message: "m" } }]);
  assert.equal(refusalCause(copilot), "provider-quota");
  assert.equal(copilot.resetAt, undefined);
});

/** A fake claude: its first `limited` runs print the usage-limit run (reset at `resetS`) and exit 1, later ones succeed; argv logged. */
function fakeClaude({ limited = 1, resetS = RESET_S, usd = 0 } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "factory-claude-limit-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "limit.jsonl"), withReset(LIMIT_RUN, resetS).replace('"total_cost_usd":0', `"total_cost_usd":${usd}`));
  const ok = [{ type: "system", subtype: "init", session_id: "00000000-0000-0000-0000-000000000254" }, { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "00000000-0000-0000-0000-000000000254", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} }];
  writeFileSync(join(bin, "ok.jsonl"), ok.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
if (n < ${limited}) { process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "limit.jsonl"))}, "utf8")); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "ok.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { bin, calls };
}

/** A stage's clock faked from `start` (ms): OUTAGE's waits pass at once and move it. Restores PATH, the clock and the wait. */
async function inStage(bin, start, fn) {
  const saved = { path: process.env.PATH, sleep: OUTAGE.sleep, now: OUTAGE.now };
  process.env.PATH = `${bin}:${saved.path}`;
  let t = start;
  const waits = [];
  Object.assign(OUTAGE, { now: () => t, sleep: async (ms) => (waits.push(ms), (t += ms)) });
  try {
    return await fn({ waits, now: () => t });
  } finally {
    process.env.PATH = saved.path;
    Object.assign(OUTAGE, { sleep: saved.sleep, now: saved.now });
    resetNetwork();
  }
}

const pass = (bin, extra = {}) => ({ harness: "claude", model: "claude-fable-5-2", prompt: "the task", maxUsd: 0, cwd: bin, env: { PATH: process.env.PATH }, timeoutMs: 24 * 60 * 60_000, label: "work-1", ...extra });

test("runHarness, real, fake claude: a reset within the stage's in-place bound is waited for, then the pass runs again from its session on the same model", async () => {
  const { bin, calls } = fakeClaude();
  // Ten minutes before the reset; a local stage waits fifteen in place.
  await inStage(bin, Date.parse(RESET) - 10 * 60_000, async ({ waits, now }) => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    const rec = await runHarness(pass(bin, { env: { PATH: process.env.PATH } }));
    const c = calls();
    assert.equal(c.length, 2);
    assert.ok(c.every((x) => x.args[x.args.indexOf("--model") + 1] === "claude-fable-5-2"), "the same model both times");
    assert.equal(c[1].args[c[1].args.indexOf("--resume") + 1], "00000000-0000-0000-0000-000000000254");
    assert.equal(c[1].prompt, LIMIT_PASS_PROMPT);
    assert.ok(now() >= Date.parse(RESET), "the rerun starts after the reset");
    assert.ok(waits.length >= 1);
    assert.equal(rec.ok, true);
    assert.equal(rec.limitWaits, 1);
  });
});

test("runHarness, real, fake claude: a reset past the in-place bound throws USAGE_LIMIT naming it; nothing runs again", async () => {
  const { bin, calls } = fakeClaude();
  await inStage(bin, Date.parse(RESET) - 2 * 60 * 60_000, async () => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    await assert.rejects(runHarness(pass(bin)), (e) => e.code === USAGE_LIMIT && e.resetAt === Date.parse(RESET) && e.refusal.code === "usage_limit_reached");
    assert.equal(calls().length, 1);
  });
});

test("reviewer path, real, fake claude: a usage limit never runs the fallback model; with no in-place wait it Blocks provider-quota", async () => {
  // Outside a stage's wait (or with no reset reported) runHarness returns the refusal; review.mjs then decides with reviewRerun.
  const { bin, calls } = fakeClaude({ limited: 9 });
  await inStage(bin, Date.parse(RESET) - 2 * 60 * 60_000, async () => {
    const rec = await runHarness(pass(bin, { label: "review", reviewer: true, agent: "reviewer" }));
    assert.equal(calls().length, 1, "one call, on the reviewer's own model");
    assert.equal(rec.refusal?.code, "usage_limit_reached");
    const missed = reviewMissed({ ok: rec.ok, review: { parsed: false }, entries: ["a"] });
    assert.equal(missed, true);
    assert.equal(reviewRerun({ missed, refusal: rec.refusal, retryTimeout: 10 * 60_000 }), false, "no rerun on claude-opus-5-5: the same subscription's limit");
    assert.equal(refusalCause(rec.refusal), "provider-quota");
    assert.match(refusalReason(rec.refusal), new RegExp(`resets at ${RESET.replaceAll(".", "\\.")}`));
    // In a stage, past the bound: the stage ends on it before review.mjs could pick a fallback.
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    await assert.rejects(runHarness(pass(bin, { label: "review", reviewer: true, agent: "reviewer" })), (e) => e.code === USAGE_LIMIT);
    assert.equal(calls().length, 2);
  });
  // A crash still reruns.
  assert.equal(reviewRerun({ missed: true, refusal: undefined, retryTimeout: 10 * 60_000 }), true);
});

test("usageLimitExit: locally the stage ends paused with the reset and writes nothing; elsewhere it Blocks with cause provider-quota naming the reset", async () => {
  const refusal = { harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", message: "m", resetAt: Date.parse(RESET) };
  const e = Object.assign(new Error("x"), { code: USAGE_LIMIT, refusal, resetAt: refusal.resetAt, since: Date.parse(RESET) - 3 * 60 * 60_000 });
  const ends = [];
  const blocks = [];
  const finish = async (...a) => ends.push(a);
  await usageLimitExit(e, { local: true, records: [], finish, block: async (...a) => blocks.push(a) });
  assert.equal(blocks.length, 0, "nothing written to GitHub");
  assert.deepEqual(ends[0].slice(0, 1), ["paused"]);
  assert.deepEqual(ends[0][3], { harness: "claude", reset: RESET, since: "2026-11-14T20:00:00.000Z" });
  await usageLimitExit(e, { local: false, records: [], finish, block: async (...a) => blocks.push(a) });
  assert.equal(blocks.length, 1);
  const [reason, cause] = blocks[0];
  assert.equal(cause, "provider-quota");
  assert.equal(blockMarker(cause), '<!-- factory:block {"cause":"provider-quota"} -->');
  assert.match(reason, new RegExp(`usage limit \\(HTTP 429 rate_limit usage_limit_reached\\), which resets at ${RESET.replaceAll(".", "\\.")}`));
  assert.equal(ends[1][0], "blocked");
});

test("runHarness, real, fake claude: off the local route the in-place bound is the deadline, so a reset two hours out is waited for", async () => {
  const { bin, calls } = fakeClaude();
  const start = Date.parse(RESET) - 2 * 60 * 60_000;
  await inStage(bin, start, async () => {
    const deadlineAt = start + 3 * 60 * 60_000;
    waitOutages({ until: () => deadlineAt });
    const rec = await runHarness(pass(bin));
    assert.equal(calls().length, 2);
    assert.equal(rec.ok, true);
  });
});

test("runHarness, real, fake claude: a wait never reruns past the dollar cap; the rerun gets what is left of it", async () => {
  const start = Date.parse(RESET) - 10 * 60_000;
  const spent = fakeClaude({ usd: 0.5 });
  await inStage(spent.bin, start, async () => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    const rec = await runHarness(pass(spent.bin, { maxUsd: 0.5 }));
    assert.equal(spent.calls().length, 1, "no uncapped rerun");
    assert.equal(rec.budgetExceeded, true);
    assert.equal(rec.error, "dollar cap reached");
  });
  const left = fakeClaude({ usd: 0.5 });
  await inStage(left.bin, start, async () => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    await runHarness(pass(left.bin, { maxUsd: 2 }));
    const c = left.calls();
    assert.equal(c.length, 2);
    assert.equal(Number(c[1].args[c[1].args.indexOf("--max-budget-usd") + 1]), 1.5);
  });
});
