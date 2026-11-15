import "./temp.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseUsage, providerRefusal } from "../scripts/lib/usage.mjs";
import { BLOCK_CAUSES, blockMarker, decideExit, refusalCause, refusalReason } from "../scripts/lib/logic.mjs";
import { crashed, usageLimitExit } from "../scripts/lib/session.mjs";
import { reviewMissed, reviewRerun } from "../scripts/lib/handoff.mjs";
import { LIMIT_PASS_PROMPT, USAGE_LIMIT, codexPassRollout, runHarness } from "../scripts/lib/harness.mjs";
import { captureSession, dropSessions } from "../scripts/lib/claude-runner.mjs";
import { codexRunnerLayout } from "../scripts/lib/codex-runner.mjs";
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

// #256: Codex (codex-cli 0.167, ChatGPT login) reports its usage limit on its stream as prose only (an `error` event's
// `message`, exit 1). The structure is the rate-limit snapshot it records in the thread's rollout when the backend
// refuses with `usage_limit_reached` (codex-rs rust-v0.167.0: codex-api/src/api_bridge.rs builds it from the 429's
// x-codex-* headers, core/src/session/turn.rs `update_rate_limits` emits it as a `token_count` event, and
// rollout/src/policy.rs persists that event). The fixtures follow those shapes: the stream as
// exec/src/event_processor_with_jsonl_output.rs writes it, with the message protocol/src/error.rs makes for a Pro plan;
// the rollout's `token_count` lines in the shape a real 0.167 rollout holds, at the window's limit with no credits left.
const CODEX_STREAM = readFileSync(join(fixtures, "codex-0.167-usage-limit.jsonl"), "utf8");
const CODEX_ROLLOUT = readFileSync(join(fixtures, "codex-0.167-usage-limit-rollout.jsonl"), "utf8");
const CODEX_THREAD = "01a1d3a0-5c1e-7b20-9f3a-2c4d6e8f0256";
const PASS_START = "2026-11-14T21:00:00.000Z";
const codexRec = (rollout = CODEX_ROLLOUT, since = PASS_START, stream = CODEX_STREAM) => ({ ...parseUsage("codex", stream, "gpt-6.1-sol", 1, { rollout, since }), exitCode: 1, signal: null, timedOut: false });
/** The fixture's last snapshot (the refusal's) with its rate_limits changed by `edit`. */
const editLimit = (edit) => {
  const lines = CODEX_ROLLOUT.trim().split("\n");
  const o = JSON.parse(lines.at(-1));
  edit(o.payload.rate_limits);
  return [...lines.slice(0, -1), JSON.stringify(o)].join("\n");
};

test("codex: the usage limit is read from the rollout's rate-limit snapshot, never the prose; no crash, Blocked provider-quota naming the reset", () => {
  const rec = codexRec();
  assert.deepEqual({ ...rec.refusal, message: undefined }, { harness: "codex", status: null, type: "usage_limit_reached", code: null, message: undefined, limitType: "codex/primary", resetAt: Date.parse(RESET) });
  assert.equal(crashed(rec), false, "no death, so the worker does not retry it");
  const d = decideExit({ harness: { ...rec, died: 0 }, pr: null, commits: 0 });
  assert.equal(d.exit, "blocked");
  assert.equal(d.cause, "provider-quota");
  assert.match(d.reason, new RegExp(`^codex reached its subscription's usage limit \\(usage_limit_reached\\), which resets at ${RESET.replaceAll(".", "\\.")}; not run again on another model`));
  assert.ok(!/crash|3:00 PM|credits/.test(d.reason), "structure only: none of the provider's prose");
  // The stream alone (no rollout read) holds no structure: the failure stays a death, as before.
  const bare = { ...parseUsage("codex", CODEX_STREAM, null, 1), exitCode: 1, signal: null, timedOut: false };
  assert.equal(bare.refusal, undefined);
  assert.equal(crashed(bare), true);
});

test("codex: no usage limit on credits, below the limit, from an earlier pass, or after a completed turn", () => {
  const onCredits = editLimit((rl) => (rl.credits = { has_credits: true, unlimited: false, balance: "62494.47" }));
  assert.equal(codexRec(onCredits).refusal, undefined, "on credits Codex runs on past a full window");
  assert.equal(codexRec(editLimit((rl) => (rl.credits = { has_credits: false, unlimited: true, balance: null }))).refusal, undefined);
  assert.equal(codexRec(editLimit((rl) => (rl.primary.used_percent = 99))).refusal, undefined);
  assert.equal(codexRec(CODEX_ROLLOUT, "2026-11-14T21:00:10.000Z").refusal, undefined, "the snapshot is an earlier pass's");
  assert.equal(codexRec(CODEX_ROLLOUT, null).refusal, undefined, "no pass start, no reading");
  const recovered = `${CODEX_STREAM}{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n`;
  assert.equal(codexRec(CODEX_ROLLOUT, PASS_START, recovered).refusal, undefined);
  // Missing credits read as none: the full window is the limit.
  assert.equal(codexRec(editLimit((rl) => (rl.credits = null))).refusal.resetAt, Date.parse(RESET));
});

test("codex: the reset is the latest full window's; a workspace's credits or spend cap has none", () => {
  const weekly = Date.parse(RESET) / 1000 + 3 * 86_400;
  const both = codexRec(editLimit((rl) => (rl.secondary = { used_percent: 100, window_minutes: 43200, resets_at: weekly }))).refusal;
  assert.equal(both.resetAt, weekly * 1000);
  assert.equal(both.limitType, "codex/secondary");
  const typed = codexRec(editLimit((rl) => Object.assign(rl, { rate_limit_reached_type: "rate_limit_reached" }))).refusal;
  assert.equal(typed.code, "rate_limit_reached");
  assert.equal(typed.resetAt, Date.parse(RESET));
  // A reached type with no window at its limit: the limit, with no reset.
  const workspace = codexRec(editLimit((rl) => Object.assign(rl, { rate_limit_reached_type: "workspace_member_credits_depleted", primary: { used_percent: 40, window_minutes: 10080, resets_at: RESET_S } }))).refusal;
  assert.equal(workspace.code, "workspace_member_credits_depleted");
  assert.equal(workspace.resetAt, undefined);
  assert.equal(refusalCause(workspace), "provider-quota");
  assert.match(refusalReason(workspace), /^codex reached its subscription's usage limit \(usage_limit_reached workspace_member_credits_depleted\), with no reset time reported/);
  // A spend cap at a full window: still no reset, since the window's end does not lift it.
  assert.equal(codexRec(editLimit((rl) => (rl.rate_limit_reached_type = "workspace_owner_usage_limit_reached"))).refusal.resetAt, undefined);
});

/**
 * A fake codex: its first `limited` runs write the usage-limit rollout under CODEX_HOME (stamped now, its reset at
 * `resetS`), print the usage-limit stream and exit 1; later ones print a completed turn. argv and stdin logged.
 */
function fakeCodex({ limited = 1, resetS = RESET_S } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-limit-"));
  const home = join(bin, "codex-home");
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "limit.jsonl"), CODEX_STREAM);
  writeFileSync(join(bin, "rollout.jsonl"), CODEX_ROLLOUT.replaceAll(`"resets_at":${RESET_S}`, `"resets_at":${resetS}`));
  const ok = [{ type: "thread.started", thread_id: CODEX_THREAD }, { type: "turn.started" }, { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } }, { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } }];
  writeFileSync(join(bin, "ok.jsonl"), ok.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
if (n < ${limited}) {
  const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "14");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const text = fs.readFileSync(${JSON.stringify(join(bin, "rollout.jsonl"))}, "utf8").replace(/"timestamp":"[^"]*"/g, '"timestamp":"' + now + '"');
  fs.appendFileSync(path.join(dir, "rollout-2026-11-14T21-00-00-${CODEX_THREAD}.jsonl"), text);
  process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "limit.jsonl"))}, "utf8"));
  process.exit(1);
}
process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "ok.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { bin, home, calls };
}

const codexPass = (f, extra = {}) => ({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: f.bin, env: { PATH: process.env.PATH, CODEX_HOME: f.home }, timeoutMs: 24 * 60 * 60_000, label: "work-1", ...extra });

test("runHarness, real, fake codex: a reset within the stage's in-place bound is waited for, then the thread resumes on the same model", async () => {
  const f = fakeCodex();
  await inStage(f.bin, Date.parse(RESET) - 10 * 60_000, async ({ now }) => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    const rec = await runHarness(codexPass(f, { env: { PATH: process.env.PATH, CODEX_HOME: f.home } }));
    const c = f.calls();
    assert.equal(c.length, 2);
    assert.deepEqual(c[0].args.slice(0, 1), ["exec"]);
    assert.equal(c[0].args[c[0].args.indexOf("-m") + 1], "gpt-6.1-sol");
    assert.deepEqual(c[1].args.slice(0, 3), ["exec", "resume", CODEX_THREAD], "the same thread, so the same model");
    assert.equal(c[1].prompt, LIMIT_PASS_PROMPT);
    assert.ok(now() >= Date.parse(RESET), "the rerun starts after the reset");
    assert.equal(rec.ok, true);
    assert.equal(rec.limitWaits, 1);
  });
});

test("runHarness, real, fake codex: a reset past the in-place bound throws USAGE_LIMIT naming it; nothing runs again", async () => {
  const f = fakeCodex({ limited: 9 });
  await inStage(f.bin, Date.parse(RESET) - 2 * 60 * 60_000, async () => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    await assert.rejects(runHarness(codexPass(f)), (e) => e.code === USAGE_LIMIT && e.resetAt === Date.parse(RESET) && e.refusal.harness === "codex" && e.refusal.type === "usage_limit_reached");
    assert.equal(f.calls().length, 1);
  });
  // Outside a stage's wait (a reviewer's call, say) the refusal comes back: no fallback model, no crash.
  await inStage(f.bin, Date.parse(RESET) - 2 * 60 * 60_000, async () => {
    const rec = await runHarness(codexPass(f, { label: "review", reviewer: true }));
    assert.equal(f.calls().length, 2);
    assert.equal(rec.refusal?.type, "usage_limit_reached");
    assert.equal(reviewRerun({ missed: true, refusal: rec.refusal, retryTimeout: 10 * 60_000 }), false);
    assert.equal(crashed({ ...rec, died: 0 }), false);
  });
});

test("codexPassRollout: on a runner the rollout is the copy captured after the run, never the agent's home by then", async () => {
  dropSessions();
  const root = mkdtempSync(join(tmpdir(), "codex-limit-runner-"));
  const layout = codexRunnerLayout({ home: join(root, "agent"), tmp: join(root, "agent", "tmp") }, join(root, "codex-home"));
  const file = join(layout.sessions, "2026", "11", "14", `rollout-2026-11-14T21-00-00-${CODEX_THREAD}.jsonl`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, CODEX_ROLLOUT);
  try {
    assert.equal(await codexPassRollout(CODEX_THREAD, layout, process.env), null, "nothing captured yet");
    await captureSession(layout, CODEX_THREAD);
    // Written after the capture (the agent's validation runs next): not what is read.
    appendFileSync(file, `${JSON.stringify({ timestamp: "2026-11-14T21:00:20.000Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 5 } } } })}\n`);
    const text = await codexPassRollout(CODEX_THREAD, layout, process.env);
    assert.equal(text.split("\n").length, 2, "the token_count lines only");
    assert.equal(parseUsage("codex", CODEX_STREAM, null, 1, { rollout: text, since: PASS_START }).refusal.resetAt, Date.parse(RESET));
  } finally {
    dropSessions();
    rmSync(root, { recursive: true, force: true });
  }
});
