// #390: a provider that answers busy (408, 425, 429 or a 5xx, with no refusal kind) is waited out, never a death; a
// resumed pass refused for its request alone (400, 413, 422 with no auth, permission, quota or billing kind) gets one
// fresh try; a vanished work job is placed from its own steps. All decided on structure: statuses, kinds, steps.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jsonLines, parseUsage, providerBusy, providerRefusal, requestRefused } from "../scripts/lib/usage.mjs";
import { crashed, outageExit, usageLimitExit } from "../scripts/lib/session.mjs";
import { BUSY_PASS_PROMPT, USAGE_LIMIT, runHarness } from "../scripts/lib/harness.mjs";
import { OUTAGE, resetNetwork, serverDown, unreachable, waitOutages } from "../scripts/lib/network.mjs";
import { endedNotLost, needsWorkStep, workStepNumber } from "../scripts/lib/relaunch.mjs";

const fixtures = join(import.meta.dirname, "fixtures");
const LIMIT_RUN = readFileSync(join(fixtures, "claude-2.1.323-usage-limit.jsonl"), "utf8");
const RESET_S = 1794697200;
// Claude Code's API rate limit that is not the subscription's usage limit: the same run with no `usage_limit_reached`.
const claudeBusy = (status = 429, error = "rate_limit") => LIMIT_RUN.replaceAll('"api_error":"usage_limit_reached",', "").replaceAll('"api_error_status":429', `"api_error_status":${status}`).replace('"error":"rate_limit"', `"error":"${error}"`);
const codexBody = (status, type = "x", code = null) => `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000b1"}\n${JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type, code, message: "m" }, status }) } })}\n`;
const failed = (harness, text) => ({ ...parseUsage(harness, text, null, 1), exitCode: 1, signal: null, timedOut: false });

test("providerBusy: 408, 425, 429 and 5xx with no refusal kind are busy, never a death; a refusal kind, 409 or no status is not", () => {
  for (const status of [408, 425, 429, 500, 503, 529]) {
    const rec = failed("codex", codexBody(status));
    assert.equal(rec.busy?.status, status, `HTTP ${status}`);
    assert.equal(rec.refusal, undefined);
    assert.equal(crashed(rec), false, `HTTP ${status}: no death`);
    assert.match(rec.error, new RegExp(`^the provider was busy: HTTP ${status}`));
  }
  assert.equal(providerBusy("codex", jsonLines(codexBody(429, "x", "insufficient_quota"))), null, "a quota kind is a refusal");
  assert.equal(providerRefusal("codex", jsonLines(codexBody(429, "x", "insufficient_quota"))).code, "insufficient_quota");
  assert.equal(providerBusy("codex", jsonLines(codexBody(409))), null);
  assert.equal(providerBusy("codex", jsonLines(codexBody(null, "server_error"))), null, "no status: not decidable");
  assert.equal(providerBusy("codex", jsonLines(codexBody(400))), null);
  // Claude: the usage limit stays a refusal; a plain rate limit or an overload is busy, its retry time the structured resetsAt.
  assert.equal(providerBusy("claude", jsonLines(LIMIT_RUN)), null);
  const rec = failed("claude", claudeBusy());
  assert.deepEqual({ ...rec.busy, message: undefined }, { harness: "claude", status: 429, type: "rate_limit", code: null, message: undefined, retryAt: RESET_S * 1000 });
  assert.equal(crashed(rec), false);
  assert.equal(parseUsage("claude", claudeBusy(529, "overloaded_error"), null).busy.status, 529);
  // Copilot: its rate limit, with the retry time its auto-mode switch request gives.
  const at = "2026-11-15T10:00:00.000Z";
  const events = [{ type: "auto_mode_switch.requested", timestamp: at, data: { requestId: "r", errorCode: "user_global_rate_limited", retryAfterSeconds: 120 } }, { type: "session.error", data: { statusCode: 429, errorType: "rate_limit", errorCode: "user_global_rate_limited", message: "m" } }];
  assert.equal(providerBusy("copilot", events).retryAt, Date.parse(at) + 120_000);
});

test("requestRefused: a 400, 413 or 422 with no auth, permission, quota or billing kind refuses the session's request alone", () => {
  for (const status of [400, 413, 422]) assert.equal(requestRefused({ status, type: "invalid_request_error", code: null }), true, `HTTP ${status}`);
  assert.equal(requestRefused({ status: 400, type: "invalid_request_error", code: "billing_error" }), false);
  assert.equal(requestRefused({ status: 400, type: "permission_error", code: null }), false);
  assert.equal(requestRefused({ status: 401, type: "authentication_error", code: null }), false);
  assert.equal(requestRefused({ status: 404, type: "not_found_error", code: null }), false);
  assert.equal(requestRefused(null), false);
});

/**
 * A fake codex: its runs print `runs[i]` (the last one repeats) and exit 1 on a failed one; a run with no entry completes
 * a thread. Each call's argv and prompt are logged.
 */
function fakeCodex(runs) {
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-busy-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "runs.json"), JSON.stringify(runs));
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
const runs = JSON.parse(fs.readFileSync(${JSON.stringify(join(bin, "runs.json"))}, "utf8"));
const out = runs[Math.min(n, runs.length - 1)];
if (out) { process.stdout.write(out); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, "codex-0.167-thread.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { bin, calls };
}

/** A stage's clock faked (OUTAGE's waits pass at once and move it), every probe answered, PATH with `bin` first. */
async function inStage(bin, fn) {
  const saved = { path: process.env.PATH, sleep: OUTAGE.sleep, now: OUTAGE.now, fetch: globalThis.fetch };
  process.env.PATH = `${bin}:${saved.path}`;
  let t = Date.parse("2026-11-15T10:00:00Z");
  const waits = [];
  Object.assign(OUTAGE, { now: () => t, sleep: async (ms) => (waits.push(ms), (t += ms)) });
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    return await fn({ waits, now: () => t });
  } finally {
    process.env.PATH = saved.path;
    globalThis.fetch = saved.fetch;
    Object.assign(OUTAGE, { sleep: saved.sleep, now: saved.now });
    resetNetwork();
  }
}

const pass = (bin, extra = {}) => ({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 24 * 60 * 60_000, label: "work-1", ...extra });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("runHarness, real, fake codex: a busy provider is waited out on the outage doubling and the pass runs again from its session", async () => {
  const { bin, calls } = fakeCodex([codexBody(503), codexBody(429), null]);
  await inStage(bin, async ({ waits }) => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    const rec = await runHarness(pass(bin));
    const c = calls();
    assert.equal(c.length, 3, "two busy runs, then the one that completed");
    assert.ok(c[1].args.includes("resume") && c[1].args.includes("00000000-0000-0000-0000-0000000000b1"), c[1].args.join(" "));
    assert.equal(c[1].prompt, BUSY_PASS_PROMPT);
    assert.equal(sum(waits), 3 * 60_000, "1 then 2 minutes (network.mjs serverWait)");
    assert.equal(rec.ok, true);
    assert.equal(rec.busyWaits, 2);
    assert.equal(crashed(rec), false);
  });
});

test("runHarness, real, fake codex: past the stage's in-place bound the stage ends on the provider's busy answer, as on GitHub's 5xx", async () => {
  const { bin, calls } = fakeCodex([codexBody(529)]);
  await inStage(bin, async ({ waits }) => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    let thrown = null;
    await assert.rejects(runHarness(pass(bin)), (e) => ((thrown = e), true));
    assert.equal(sum(waits), 15 * 60_000, "1, 2, 4 and 8 minutes: the next wait ends past the fifteen");
    assert.equal(calls().length, 5);
    assert.ok(unreachable(thrown) && serverDown(thrown.code), String(thrown?.message));
    assert.equal(thrown.code, "HTTP 529");
    assert.equal(thrown.origin, "https://chatgpt.com");
    // Locally the stage ends paused on it (serve resumes it on the same doubling); elsewhere an `outage` Block.
    const ends = [];
    const blocks = [];
    await outageExit(thrown, { local: true, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a) });
    assert.equal(ends[0][0], "paused");
    assert.equal(ends[0][2].code, "HTTP 529");
    assert.match(ends[0][1], /^chatgpt\.com answered HTTP 529 to every try from /);
    await outageExit(thrown, { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a) });
    assert.equal(blocks[0][1], "outage");
  });
});

test("runHarness, real, fake codex: the stage's time bounds the busy waits, not a count: a long deadline keeps waiting past six", async () => {
  const { bin, calls } = fakeCodex([...Array(8).fill(codexBody(503)), null]);
  await inStage(bin, async ({ waits }) => {
    waitOutages({ until: (since) => since + 12 * 60 * 60_000 });
    const rec = await runHarness(pass(bin));
    assert.equal(calls().length, 9, "eight busy answers, then the run that completed");
    assert.equal(rec.ok, true);
    assert.equal(rec.busyWaits, 8);
    assert.equal(sum(waits), (1 + 2 + 4 + 8 + 16 + 30 + 30 + 30) * 60_000, "doubling up to half an hour");
  });
});

test("runHarness: outside a process that waits outages out, a busy pass is returned as it is, no death", async () => {
  const { bin, calls } = fakeCodex([codexBody(503)]);
  await inStage(bin, async () => {
    const rec = await runHarness(pass(bin));
    assert.equal(calls().length, 1);
    assert.equal(rec.busy.status, 503);
    assert.equal(crashed(rec), false);
  });
});

/** A fake claude: its first run answers a plain rate limit (no usage-limit code) whose reset is `resetS`, later ones succeed. */
function fakeClaudeBusy(resetS) {
  const bin = mkdtempSync(join(tmpdir(), "factory-claude-busy-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "busy.jsonl"), claudeBusy().replaceAll(`"resetsAt":${RESET_S}`, `"resetsAt":${resetS}`));
  const ok = [{ type: "system", subtype: "init", session_id: "00000000-0000-0000-0000-000000000254" }, { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "00000000-0000-0000-0000-000000000254", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} }];
  writeFileSync(join(bin, "ok.jsonl"), ok.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
if (n < 1) { process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "busy.jsonl"))}, "utf8")); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "ok.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { bin, calls };
}
const START = Date.parse("2026-11-15T10:00:00Z");

test("runHarness, real, fake claude: the provider's own retry time is waited for, not the doubling", async () => {
  const { bin, calls } = fakeClaudeBusy(START / 1000 + 180);
  await inStage(bin, async ({ waits }) => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    const rec = await runHarness({ ...pass(bin), harness: "claude", model: "claude-fable-5-2" });
    const c = calls();
    assert.equal(c.length, 2);
    assert.equal(c[1].args[c[1].args.indexOf("--resume") + 1], "00000000-0000-0000-0000-000000000254");
    assert.equal(c[1].prompt, BUSY_PASS_PROMPT);
    assert.equal(sum(waits), 180_000, "the three minutes the provider gave");
    assert.equal(rec.ok, true);
  });
});

test("runHarness, real, fake claude: a provider time past the stage's bound is a usage limit's reset: the account is held until it, not the outage doubling", async () => {
  const reset = START + 3 * 24 * 60 * 60_000;
  const { bin, calls } = fakeClaudeBusy(reset / 1000);
  await inStage(bin, async ({ waits }) => {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    let thrown = null;
    await assert.rejects(runHarness({ ...pass(bin), harness: "claude", model: "claude-fable-5-2" }), (e) => ((thrown = e), true));
    assert.equal(thrown.code, USAGE_LIMIT, String(thrown?.message));
    assert.equal(thrown.resetAt, reset);
    assert.equal(calls().length, 1);
    assert.deepEqual(waits, [], "no wait in place");
    // Locally: paused on the usage limit with its reset, which serve holds the account until (local.mjs limitPaused).
    const ends = [];
    await usageLimitExit(thrown, { local: true, records: [], finish: async (...a) => ends.push(a), block: async () => assert.fail("nothing written") });
    assert.equal(ends[0][0], "paused");
    assert.equal(ends[0][2], null, "no outage");
    assert.deepEqual({ ...ends[0][3], since: undefined }, { harness: "claude", reset: new Date(reset).toISOString(), since: undefined });
    // On a route with automatic account choice: the holds record is written for that reset (route-holds.mjs limit).
    const held = [];
    await usageLimitExit(thrown, { local: false, records: [], finish: async (...a) => ends.push(a), block: async () => {}, goOn: async (e) => (held.push(e.resetAt), { goOn: "another account is free" }) });
    assert.deepEqual(held, [reset]);
    assert.equal(ends.at(-1)[0], "waiting");
  });
});

test("runHarness, real, fake codex: a resumed pass refused 400/413/422 for its request alone runs once fresh; an account refusal does not", async () => {
  for (const status of [400, 413, 422]) {
    const { bin, calls } = fakeCodex([codexBody(status, "invalid_request_error", "context_length_exceeded"), null]);
    await inStage(bin, async () => {
      const rec = await runHarness(pass(bin, { prompt: "the ask", freshPrompt: "card\n\n---\n\nthe ask", resume: "00000000-0000-0000-0000-0000000000b1" }));
      const c = calls();
      assert.deepEqual(c.map((x) => [x.args.includes("resume"), x.prompt]), [[true, "the ask"], [false, "card\n\n---\n\nthe ask"]], `HTTP ${status}`);
      assert.equal(rec.ok, true);
      assert.deepEqual(rec.resumeRefused, { session: "00000000-0000-0000-0000-0000000000b1", status, type: "invalid_request_error", code: "context_length_exceeded" });
    });
  }
  // The fresh pass refused too: the refusal stands, run twice in all.
  const again = fakeCodex([codexBody(400, "invalid_request_error", "context_length_exceeded")]);
  await inStage(again.bin, async () => {
    const rec = await runHarness(pass(again.bin, { prompt: "the ask", freshPrompt: "card", resume: "00000000-0000-0000-0000-0000000000b1" }));
    assert.equal(again.calls().length, 2);
    assert.equal(rec.refusal?.status, 400);
  });
  // A billing or permission kind, or a 401: the account's refusal, run once.
  for (const [status, type, code] of [[400, "invalid_request_error", "billing_error"], [400, "permission_error", null], [401, "authentication_error", null]]) {
    const { bin, calls } = fakeCodex([codexBody(status, type, code), null]);
    await inStage(bin, async () => {
      const rec = await runHarness(pass(bin, { prompt: "the ask", freshPrompt: "card", resume: "00000000-0000-0000-0000-0000000000b1" }));
      assert.equal(calls().length, 1, `HTTP ${status} ${type} ${code}`);
      assert.equal(rec.refusal?.status, status);
    });
  }
  // A fresh pass (no resume) refused 400 is not run again.
  const fresh = fakeCodex([codexBody(400, "invalid_request_error", "context_length_exceeded"), null]);
  await inStage(fresh.bin, async () => {
    await runHarness(pass(fresh.bin, { freshPrompt: "card" }));
    assert.equal(fresh.calls().length, 1);
  });
});

test("endedNotLost: the work job's conclusion and steps place a vanished stage, Factory's step read from the workflow file; a runner that went away is lost", () => {
  // The workflow names its own steps: Factory's work step is found by its `uses` and `mode`, never by a name.
  const workflow = ["jobs:", "  work:", "    steps:", "      - name: Pick the account", "        uses: clockgrove/factory@v0.9", "        with: { mode: account }", "      - name: Get the code", "        uses: actions/checkout@v7", "      - name: Build it", "        uses: clockgrove/factory@v0.9", "        with: { mode: work }", "      - uses: actions/upload-artifact@v7", ""].join("\n");
  assert.equal(workStepNumber(workflow, "work (7)"), 4, "Set up job is 1, then the YAML steps in order");
  assert.equal(workStepNumber(workflow, "review (factory/7)"), null, "another job");
  assert.equal(workStepNumber("jobs: [", "work (7)"), null, "unparsable");
  assert.equal(workStepNumber(workflow.replace("mode: work", "mode: review"), "work (7)"), null, "no Factory work step");
  const step = (number, name, conclusion, status = "completed") => ({ number, name, status, conclusion });
  const job = (steps, conclusion = "failure") => ({ name: "work (7)", status: "completed", conclusion, runner_id: 3, runner_name: "r", steps });
  const ran = (failedAt) => job([step(1, "Set up job", failedAt === 1 ? "failure" : "success"), step(2, "Pick the account", failedAt === 2 ? "failure" : "skipped"), step(3, "Get the code", failedAt === 3 ? "failure" : failedAt < 3 ? "skipped" : "success"), step(4, "Build it", failedAt === 4 ? "failure" : failedAt < 4 ? "skipped" : null), step(5, "Run actions/upload-artifact@v7", "success")]);
  assert.deepEqual(endedNotLost({ job: ran(1) }), { by: "setup", step: "Set up job" }, "GitHub's set-up: no workflow needed");
  assert.equal(needsWorkStep(ran(1)), false);
  assert.deepEqual(endedNotLost({ job: ran(2), workStep: 4 }), { by: "setup", step: "Pick the account" }, "the account step, before Factory's own");
  assert.deepEqual(endedNotLost({ job: ran(3), workStep: 4 }), { by: "setup", step: "Get the code" });
  assert.equal(needsWorkStep(ran(3)), true);
  assert.equal(endedNotLost({ job: ran(3), workStep: null }), null, "the workflow unread: the step cannot be placed, so lost");
  assert.equal(endedNotLost({ job: ran(4), workStep: 4 }), null, "Factory's own step failed with no exit written: its network");
  const gone = job([step(1, "Set up job", "success"), step(2, "Get the code", "success"), step(3, "Build it", null, "in_progress")]);
  assert.equal(endedNotLost({ job: gone, workStep: 3 }), null, "a runner that went away: no step of its own failed");
  assert.equal(needsWorkStep(gone), false, "nothing failed: no workflow read");
  assert.deepEqual(endedNotLost({ job: { name: "work (7)", status: "completed", conclusion: "failure", runner_id: null, runner_name: null, steps: [] } }), { by: "setup", step: null }, "GitHub never started it");
  assert.deepEqual(endedNotLost({ job: job(ran(3).steps, "cancelled") }), { by: "cancelled" });
  assert.equal(needsWorkStep(job(ran(3).steps, "cancelled")), false);
  assert.deepEqual(endedNotLost({ job: job([], "timed_out") }), { by: "cancelled" });
  assert.deepEqual(endedNotLost({ record: { state: "ended" } }), { by: "sandbox" });
  assert.equal(endedNotLost({ job: null }), null);
});
