import "./temp.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quotaReading } from "../scripts/lib/usage.mjs";
import { runHarness } from "../scripts/lib/harness.mjs";
import { stageQuota, writeUsage } from "../scripts/lib/session.mjs";
import { accountHolds } from "../scripts/lib/holds.mjs";
import { chooseAccount } from "../scripts/lib/accounts.mjs";

// #391: automatic account choice ranks the free accounts by the quota their provider reports left. The numbers come
// from the harness's own structure: Claude Code's `rate_limit_event` lines on its stream, Codex's `token_count`
// rate-limit snapshots in its thread's rollout. Copilot reports none.

const H = 60 * 60_000;
const S = (ms) => Math.floor(ms / 1000);

/** A Claude Code `rate_limit_event` as Claude Code 2.1.32x writes it on a subscription (the shape of real stage logs). */
const claudeEvent = (info) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false, ...info }, uuid: "00000000-0000-0000-0000-000000000391", session_id: "00000000-0000-0000-0000-000000000391" });
/** A Codex rollout's `token_count` line with rate limits `rl`, stamped `at` (ms). */
const codexCount = (at, rl) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "codex", limit_name: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: "0" }, plan_type: "pro", rate_limit_reached_type: null, ...rl } } });

test("#391 quotaReading: Claude Code's rate_limit_event windows, a later event's replacing an earlier's; Codex's last snapshot of the pass from its rollout; Copilot none", () => {
  const reset = 1794909600;
  const stream = [
    claudeEvent({ status: "allowed", resetsAt: reset, rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: reset, status: "allowed" }, five_hour: { utilization: 0.2, resetsAt: reset - 3600, status: "allowed" } } }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    claudeEvent({ status: "allowed_warning", resetsAt: reset, rateLimitType: "seven_day", utilization: 0.97, surpassedThreshold: 0.75, unifiedWindows: { seven_day: { utilization: 0.97, resetsAt: reset, status: "allowed_warning" }, seven_day_overage_included: { utilization: 0.9, resetsAt: reset, status: "allowed_warning" } } }),
    // A rejected event names no utilization at its top: only the windows that carry both numbers count.
    claudeEvent({ status: "rejected", resetsAt: reset, rateLimitType: "five_hour" }),
  ].join("\n");
  assert.deepEqual(quotaReading("claude", stream), {
    harness: "claude",
    windows: { seven_day: { used: 0.97, resetsAt: reset * 1000 }, five_hour: { used: 0.2, resetsAt: (reset - 3600) * 1000 }, seven_day_overage_included: { used: 0.9, resetsAt: reset * 1000 } },
  });
  // An event with no unifiedWindows (an older Claude Code): its own window, when it names the use.
  assert.deepEqual(quotaReading("claude", claudeEvent({ status: "allowed_warning", resetsAt: reset, rateLimitType: "five_hour", utilization: 0.8 })).windows, { five_hour: { used: 0.8, resetsAt: reset * 1000 } });
  assert.equal(quotaReading("claude", JSON.stringify({ type: "result", subtype: "success" })), null, "an API key's stream has none");
  assert.equal(quotaReading("claude", claudeEvent({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.4 } } })), null, "a window with no reset could never be told stale");

  const since = Date.UTC(2026, 10, 15, 10);
  const rollout = [
    codexCount(since - 60_000, { primary: { used_percent: 10, window_minutes: 300, resets_at: S(since) + 3600 } }),
    codexCount(since + 60_000, { primary: { used_percent: 30, window_minutes: 300, resets_at: S(since) + 3600 }, secondary: { used_percent: 55, window_minutes: 10080, resets_at: S(since) + 86_400 } }),
    codexCount(since + 120_000, { limit_id: "codex_other", primary: { used_percent: 99, window_minutes: 300, resets_at: S(since) + 3600 } }),
  ].join("\n");
  assert.deepEqual(quotaReading("codex", "", { rollout, since: new Date(since).toISOString() }), { harness: "codex", windows: { "codex/primary": { used: 0.3, resetsAt: (S(since) + 3600) * 1000 }, "codex/secondary": { used: 0.55, resetsAt: (S(since) + 86_400) * 1000 } } }, "this pass's last snapshot of the codex group");
  assert.equal(quotaReading("codex", "", { rollout: rollout.split("\n")[0], since: new Date(since).toISOString() }), null, "an earlier pass's snapshot is not this pass's");
  assert.equal(quotaReading("copilot", stream), null);
});

/** A fake harness `name` in its own bin: prints `stream`; a Codex one also writes `rollout(now)` to its thread's rollout. */
function fakeHarness(name, stream, rollout = null) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), `pendulum-quota-${name}-`)));
  writeFileSync(join(bin, "out.jsonl"), stream);
  writeFileSync(
    join(bin, name),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.readFileSync(0, "utf8");
${rollout ? `const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "15");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "rollout-2026-11-15T10-00-00-${rollout.thread}.jsonl"), ${JSON.stringify(rollout.text)}.replaceAll("NOW", new Date().toISOString()));` : ""}
process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "out.jsonl"))}, "utf8"));
`,
    { mode: 0o755 },
  );
  return bin;
}

async function onPath(bin, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("#391 runHarness, real, fake harnesses: a completed pass keeps its quota reading, Claude Code's from its stream and Codex's from its rollout; writeUsage puts the stage's in result.json", async () => {
  const reset = S(Date.now()) + 4 * 3600;
  const session = "00000000-0000-0000-0000-000000000391";
  const claudeOut = [
    JSON.stringify({ type: "system", subtype: "init", session_id: session }),
    claudeEvent({ status: "allowed", resetsAt: reset, rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 0.57, resetsAt: reset, status: "allowed" } } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", session_id: session, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} }),
  ].join("\n");
  const claudeBin = fakeHarness("claude", `${claudeOut}\n`);
  const claude = await onPath(claudeBin, () => runHarness({ harness: "claude", model: "claude-fable-5-2", prompt: "the task", maxUsd: 0, cwd: claudeBin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" }));
  assert.equal(claude.ok, true);
  assert.deepEqual(claude.quota, { harness: "claude", windows: { seven_day: { used: 0.57, resetsAt: reset * 1000 } } });

  // A Codex pass that completes: its rollout is read for the snapshot too, not only after a failure.
  const thread = "01a1d3a0-5c1e-7b20-9f3a-2c4d6e800391";
  const codexOut = [{ type: "thread.started", thread_id: thread }, { type: "turn.started" }, { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } }, { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }].map((l) => JSON.stringify(l)).join("\n");
  const line = codexCount(0, { primary: { used_percent: 42, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: reset + 86_400 } }).replace(/"timestamp":"[^"]*"/, '"timestamp":"NOW"');
  const codexBin = fakeHarness("codex", `${codexOut}\n`, { thread, text: `${line}\n` });
  const home = join(codexBin, "codex-home");
  mkdirSync(home);
  const codex = await onPath(codexBin, () => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: codexBin, env: { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: home }, timeoutMs: 60_000, label: "work-1" }));
  assert.equal(codex.ok, true);
  assert.deepEqual(codex.quota, { harness: "codex", windows: { "codex/primary": { used: 0.42, resetsAt: reset * 1000 }, "codex/secondary": { used: 0.12, resetsAt: (reset + 86_400) * 1000 } } });

  // The stage's reading: each window as the last pass that reported it read it.
  const later = { harness: "codex", windows: { "codex/primary": { used: 0.5, resetsAt: reset * 1000 } } };
  assert.deepEqual(stageQuota([codex, { usd: 0 }, { quota: later }]).windows, { "codex/primary": { used: 0.5, resetsAt: reset * 1000 }, "codex/secondary": { used: 0.12, resetsAt: (reset + 86_400) * 1000 } });
  const dir = join(mkdtempSync(join(tmpdir(), "quota-usage-")), "u");
  const stored = writeUsage(dir, { harness: "codex", model: null, records: [codex], passes: 1, exit: "delivered", reason: null, credentialBasis: null });
  assert.deepEqual(stored.quota, codex.quota);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).quota, codex.quota);
  assert.equal(writeUsage(dir, { harness: "copilot", model: null, records: [{ usd: 0 }], passes: 1, exit: "delivered", reason: null, credentialBasis: null }).quota, undefined, "none reported: none written");
});

test("#391 holds: an account's quota reading is kept for every serve on the machine; a window past its reset is stale and not used; a newer reading of a window replaces it; a file another could have planted is not read", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now() - 10 * 60_000;
  const one = accountHolds({ dir });
  const two = accountHolds({ dir });
  assert.equal(two.left("alpha", t), null, "no reading");
  one.reading({ harness: "claude", account: "alpha", now: t, windows: { five_hour: { used: 0.3, resetsAt: t + H }, seven_day: { used: 0.6, resetsAt: t + 48 * H } } });
  assert.equal(two.left("alpha", t), 0.4, "another serve reads it: the tightest window's share left");
  assert.equal(two.left("alpha", t + 2 * H), 0.4, "five_hour has reset: its reading is stale; seven_day still stands");
  // A later stage reports five_hour alone: it replaces that window and keeps seven_day.
  two.reading({ harness: "claude", account: "alpha", now: t + 1000, windows: { five_hour: { used: 0.9, resetsAt: t + H } } });
  assert.ok(Math.abs(one.left("alpha", t + 2000) - 0.1) < 1e-9);
  assert.equal(one.left("alpha", t + 49 * H), null, "every window past its reset: no reading");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "alpha.quota.json"), "utf8")).windows, { five_hour: { used: 0.9, resetsAt: t + H, at: t + 1000 }, seven_day: { used: 0.6, resetsAt: t + 48 * H, at: t } }, "one file per account, replaced whole; a window carried over keeps when it was reported");
  // Well-formed numbers only; a key no file may carry stays in this process.
  assert.equal(one.reading({ harness: "claude", account: "beta", now: t, windows: { five_hour: { used: "lots", resetsAt: t + H } } }), null);
  assert.equal(one.left("beta", t), null);
  const mem = accountHolds();
  mem.reading({ harness: "codex", account: "codex@env", now: t, windows: { "codex/primary": { used: 0.25, resetsAt: t + H } } });
  assert.equal(mem.left("codex@env", t), 0.75);
  // A link or a file others may write is not read.
  const elsewhere = join(dir, "..", "planted.json");
  writeFileSync(elsewhere, JSON.stringify({ harness: "claude", account: "gamma", at: t, windows: { five_hour: { used: 0, resetsAt: t + H } } }));
  symlinkSync(elsewhere, join(dir, "gamma.quota.json"));
  assert.equal(accountHolds({ dir }).left("gamma", t), null);
  writeFileSync(join(dir, "delta.quota.json"), JSON.stringify({ harness: "claude", account: "delta", at: t, windows: { five_hour: { used: 0, resetsAt: t + H } } }));
  chmodSync(join(dir, "delta.quota.json"), 0o666);
  assert.equal(accountHolds({ dir }).left("delta", t), null);
  // Records of names no longer declared go with their start records.
  one.forgetStarts(["beta"]);
  assert.equal(accountHolds({ dir }).left("alpha", t), null);
});

test("#391 chooseAccount: the paused-on account first when free; then never measured, then the most quota left, then the ones that report nothing; within a group and for equal shares, the earlier order", () => {
  const list = ["a", "b", "c"].map((name) => ({ name }));
  const of = (m) => (x) => m[x.name] ?? null;
  const pick = (o) => chooseAccount(list, { until: () => null, ...o }).name;
  assert.equal(pick({ left: of({ a: 0.2, b: 0.7, c: 0.5 }) }), "b", "the most left, ahead of the first declared");
  assert.equal(pick({ left: of({ a: 0.2, b: 0.7, c: 0.5 }), limitedAt: of({ b: 100 }), startedAt: of({ b: 9, c: 1 }) }), "b", "ahead of an older limit and the turn");
  assert.equal(pick({ left: of({ a: 0.2, b: 0.7, c: 0.5 }), prefer: "a" }), "a", "the paused-on account, where its thread lives, whatever it has left");
  assert.equal(pick({ left: of({ a: 0.2, b: 0.7, c: 0.5 }), prefer: "b", until: of({ b: 5 }) }), "c", "held, the paused-on account is passed over and quota decides among the rest");
  assert.equal(pick({ left: of({ a: 0.2, b: 0.7 }) }), "c", "an account never measured is measured first");
  const silent = (names) => (x) => names.includes(x.name);
  assert.equal(pick({ left: of({ c: 0.05 }), silent: silent(["a", "b"]) }), "c", "a reporting account with little left beats ones that ran and reported nothing");
  assert.equal(pick({ left: of({ c: 0.05 }), silent: silent(["a"]) }), "b", "a never-measured one comes before both");
  assert.equal(pick({ silent: silent(["a", "b", "c"]), startedAt: of({ a: 3, b: 1, c: 2 }) }), "b", "all report nothing (Copilot): the turn, as before");
  assert.equal(pick({ silent: silent(["a", "b", "c"]), limitedAt: of({ a: 5, b: 9 }) }), "c", "all report nothing: the least recently limited, as before");
  assert.equal(pick({ left: of({ a: 0.5, b: 0.5, c: 0.1 }), startedAt: of({ a: 5, b: 1 }) }), "b", "equal shares: the turn decides");
  assert.equal(pick({ left: of({ a: 0.9, b: 0.1, c: 0.2 }), until: of({ a: 5 }) }), "c", "a held account is no candidate, however much it has left");
  assert.equal(pick({ startedAt: of({ a: 3, b: 1, c: 2 }) }), "b", "nothing known at all: the turn, as before");
});
