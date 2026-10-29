// Child threads and sub-agents in model spend and diagnostics (#2168):
// a Codex call's child threads count in its tokens and the Objective's
// spend, a resumed call's only by what they added since the call it
// continues; the spend hold names them; a Claude call's sub-agents count
// the same way through its per-model usage; and diagnostics, the analysis
// and the scorecard count an older log's Codex child threads (logged apart,
// and repeated by a resumed call) once, inside the totals.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { analyze } from "../dist/analysis.js";
import { diagnostics } from "../dist/diagnostics.js";
import { ObjectiveRunner } from "../dist/engine.js";
import { RunLog } from "../dist/log.js";
import { usageOf } from "../dist/providers/claude.js";
import {
  addCodexTelemetry,
  codexBaseline,
  codexTokens,
  turnTokens,
} from "../dist/providers/codex-telemetry.js";
import { tokens, usageRecord } from "../dist/providers/usage.js";
import { factoryObjective } from "../dist/scorecard.js";
import { amountOf, DaySpend } from "../dist/spend.js";
import { newObjective, saveState } from "../dist/state.js";
import { tempDir } from "./helpers.mjs";

/** A session record's `token_count`: the thread's cumulative totals. */
const counted = (input, cached, output, reasoning) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  },
});

/** A Codex home whose `add(thread, ...entries)` appends to that thread's session record. */
function codexHome() {
  const home = tempDir("factory-codex-children-");
  const day = join(home, "sessions", "2026", "10", "28");
  mkdirSync(day, { recursive: true });
  return {
    home,
    add(thread, ...entries) {
      appendFileSync(
        join(day, `rollout-2026-10-28T05-00-00-${thread}.jsonl`),
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
    },
  };
}

const codexRecord = (thread, own) => {
  const record = usageRecord({
    role: "worker",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "medium",
  });
  record.thread = thread;
  record.tokens = own;
  return record;
};

test("a Codex call's child threads count in its tokens and its charge; a resumed call's only by what they added", () => {
  const { home, add } = codexHome();
  // A fresh call: the parent thread and one child it spawned.
  add("parent", counted(1000, 900, 100, 10));
  add("child-a", counted(400, 300, 40, 4));
  const fresh = codexRecord(
    "parent",
    codexTokens({
      input_tokens: 1000,
      cached_input_tokens: 900,
      output_tokens: 100,
      reasoning_output_tokens: 10,
    }),
  );
  addCodexTelemetry(fresh, home);
  assert.deepEqual(fresh.childTokens, {
    input: 400,
    output: 40,
    cached: 300,
    cacheWrite: null,
    reasoning: 4,
    total: 440,
    threads: 1,
  });
  assert.deepEqual(fresh.tokens, {
    input: 1400,
    output: 140,
    cached: 1200,
    cacheWrite: null,
    reasoning: 14,
    total: 1540,
  });
  // The provider's own view stays the home's children, cumulative.
  assert.equal(fresh.providerUsage.descendants.total, 440);
  assert.deepEqual(amountOf(fresh), {
    tokens: 1540,
    cents: 0,
    childTokens: 440,
  });

  // A resumed call on the same thread: child-a goes on, child-b is new.
  const baseline = codexBaseline(home, "parent");
  add("parent", counted(1600, 1400, 160, 16));
  add("child-a", counted(600, 450, 60, 6));
  add("child-b", counted(200, 100, 20, 2));
  const resumed = codexRecord(
    "parent",
    turnTokens(
      codexTokens({
        input_tokens: 1600,
        cached_input_tokens: 1400,
        output_tokens: 160,
        reasoning_output_tokens: 16,
      }),
      baseline.tokens,
    ),
  );
  addCodexTelemetry(resumed, home, baseline);
  assert.deepEqual(resumed.childTokens, {
    input: 400,
    output: 40,
    cached: 250,
    cacheWrite: null,
    reasoning: 4,
    total: 440,
    threads: 2,
  });
  assert.equal(resumed.tokens.total, 660 + 440);
  assert.equal(resumed.providerUsage.descendants.total, 880, "cumulative");
  assert.equal(amountOf(resumed).tokens, 1100);

  // Resumed again with no child at work: the earlier children aren't charged
  // again, though the home still holds them.
  const again = codexBaseline(home, "parent");
  add("parent", counted(1700, 1500, 170, 17));
  const quiet = codexRecord(
    "parent",
    turnTokens(
      codexTokens({
        input_tokens: 1700,
        cached_input_tokens: 1500,
        output_tokens: 170,
        reasoning_output_tokens: 17,
      }),
      again.tokens,
    ),
  );
  addCodexTelemetry(quiet, home, again);
  assert.equal(quiet.childTokens, null);
  assert.equal(quiet.tokens.total, 110);
  assert.equal(quiet.providerUsage.descendants.total, 880);
  assert.deepEqual(amountOf(quiet), { tokens: 110, cents: 0, childTokens: 0 });

  // A call whose own count is unknown still charges its child threads.
  const lost = codexHome();
  lost.add("parent", { type: "turn_context", payload: { model: "m" } });
  lost.add("child", counted(300, 200, 30, 3));
  const unknown = codexRecord("parent", null);
  addCodexTelemetry(unknown, lost.home);
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.childTokens.total, 330);
  assert.deepEqual(amountOf(unknown), {
    tokens: 330,
    cents: 0,
    childTokens: 330,
  });
});

test("a Claude call's sub-agents count in its tokens through its per-model usage, a resumed call's only by what they added", () => {
  // The SDK's modelUsage covers the main loop and Task sub-agents (here on
  // another model), cumulative over a resumed session.
  const result = (opus, haiku) => ({
    modelUsage: {
      "claude-opus": {
        inputTokens: opus[0],
        outputTokens: opus[1],
        cacheReadInputTokens: opus[2],
        cacheCreationInputTokens: 0,
      },
      ...(haiku && {
        "claude-haiku": {
          inputTokens: haiku[0],
          outputTokens: haiku[1],
          cacheReadInputTokens: haiku[2],
          cacheCreationInputTokens: 0,
        },
      }),
    },
  });
  const record = usageRecord({
    role: "worker",
    provider: "claude",
    model: "claude-opus",
    effort: "medium",
  });
  record.tokens = tokens({
    ...usageOf(result([100, 10, 900], [40, 4, 360])),
  });
  assert.deepEqual(record.tokens, {
    input: 1400,
    output: 14,
    cached: 1260,
    cacheWrite: 0,
    reasoning: null,
    total: 1414,
  });
  assert.deepEqual(amountOf(record), {
    tokens: 1414,
    cents: 0,
    childTokens: 0,
  });
  // Resumed: the session's earlier turns, sub-agent included, are the baseline.
  const baseline = {
    "claude-opus": { input: 100, output: 10, cacheRead: 900, cacheCreation: 0 },
    "claude-haiku": { input: 40, output: 4, cacheRead: 360, cacheCreation: 0 },
  };
  assert.deepEqual(usageOf(result([150, 15, 1800], [60, 6, 560]), baseline), {
    input: 1170,
    output: 7,
    cached: 1100,
    cacheWrite: 0,
  });
  // No sub-agent this turn: the earlier one isn't charged again.
  assert.deepEqual(usageOf(result([150, 15, 1800], [40, 4, 360]), baseline), {
    input: 950,
    output: 5,
    cached: 900,
    cacheWrite: 0,
  });
});

test("the spend ceiling charges child threads and its hold names them", async () => {
  const root = tempDir("factory-spend-children-");
  const run = {
    id: "run",
    finished: 0,
    resumeAt: 0,
    spend: new DaySpend(root),
  };
  const config = { autonomy: { spend: { perObjective: { tokens: 1000 } } } };
  const calls = {
    // A Codex call whose 600 tokens hold its child threads' 400.
    "plan:1": {
      provider: "codex",
      tokens: { total: 600 },
      childTokens: { total: 400, threads: 1 },
    },
    // One whose own count was lost: its child threads' 300 still count.
    "plan:2": {
      provider: "codex",
      tokens: null,
      childTokens: { total: 300, threads: 2 },
    },
    // A Claude call: sub-agents inside its tokens, not split out.
    "plan:3": { provider: "claude", tokens: { total: 300 }, childTokens: null },
    "plan:4": { provider: "claude", tokens: { total: 1 }, childTokens: null },
  };
  const started = [];
  const runner = new ObjectiveRunner(
    newObjective(41, new Date(), {
      provider: "codex",
      selectedBy: "defaultProvider",
      digest: "x",
      config,
    }),
    {
      steps: (state) =>
        Object.keys(calls)
          .filter((key) => !state.done[key])
          .slice(0, 1)
          .map((key) => ({
            key,
            resource: "planner",
            deadlineMs: 60_000,
            run: async (context) => {
              started.push(key);
              context.log({ event: "model-usage", ...calls[key] });
              return { kind: "done" };
            },
          })),
      status: () => "planning",
    },
    root,
    { write() {} },
    run,
  );
  for (let i = 0; i < 4; i++) {
    runner.tick();
    for (let n = 0; n < 5; n++) await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(started, ["plan:1", "plan:2", "plan:3"]);
  assert.deepEqual(runner.state.spend, {
    tokens: 1200,
    cents: 0,
    childTokens: 700,
  });
  const [held] = runner.state.holds;
  assert.equal(held.step, "plan:4");
  assert.match(
    held.question,
    /this Objective's 1,200 tokens of 1,000 tokens \(700 of them by child threads; autonomy\.spend\.perObjective\.tokens;/,
  );
  assert.match(held.question, /child threads and sub-agents too/);
});

const ISSUE = 81;

/**
 * Codex calls as 0.5.8 logged them (child threads only in
 * `providerUsage.descendants`, cumulative, so a resumed call repeats the
 * call it continues, as #800's living-scene and entity-selection work#4
 * did), then as 0.5.9 logs them.
 */
function writeLog(logs) {
  const log = new RunLog(logs, "2026-10-28T05-05-54-542Z-1");
  const call = (attempt, fields) =>
    log.write(ISSUE, {
      step: "item:a:work",
      attemptId: `item:a:work#${attempt}`,
      event: "model-usage",
      callId: `c${attempt}`,
      role: "worker",
      provider: "codex",
      model: "gpt-6.1-sol",
      reportedModel: "gpt-6.1-sol",
      ...fields,
    });
  const own = (input, cached, output) => ({
    input,
    output,
    cached,
    cacheWrite: 0,
    reasoning: 0,
    total: input + output,
  });
  const descendants = (threads, input, cached, output) => ({
    threads,
    input,
    cached,
    output,
    reasoning: 0,
    total: input + output,
  });
  // 0.5.8: fresh, then resumed twice on the same thread.
  call(1, {
    thread: "t1",
    sessionMode: "fresh",
    tokens: own(1000, 900, 100),
    providerUsage: { descendants: descendants(1, 400, 300, 40) },
  });
  call(2, {
    thread: "t1",
    sessionMode: "resumed",
    tokens: own(200, 100, 20),
    providerUsage: { descendants: descendants(1, 400, 300, 40) },
  });
  call(3, {
    thread: "t1",
    sessionMode: "resumed",
    tokens: own(300, 200, 30),
    providerUsage: { descendants: descendants(2, 600, 400, 60) },
  });
  // 0.5.9: the children in tokens and childTokens; descendants cumulative.
  call(4, {
    thread: "t2",
    sessionMode: "fresh",
    tokens: own(1400, 1200, 140),
    childTokens: { ...own(400, 300, 40), cacheWrite: null, threads: 1 },
    providerUsage: { descendants: descendants(1, 400, 300, 40) },
  });
  call(5, {
    thread: "t2",
    sessionMode: "resumed",
    tokens: own(100, 50, 10),
    childTokens: null,
    providerUsage: { descendants: descendants(1, 400, 300, 40) },
  });
}

/** What one diagnostics view prints. */
async function shown(view, options) {
  let out = "";
  await view(options, (text) => {
    out += text;
  });
  return out;
}

test("diagnostics count each call's child threads once, inside the totals, an older log's resumed calls by their increase", async () => {
  const logs = tempDir("factory-children-logs-");
  writeLog(logs);
  const read = {
    logs,
    issue: ISSUE,
    runs: { kind: "all" },
    secrets: [],
  };
  // Own 1,100 + 440; 220; 330 + 220; 1,540 (children in); 110.
  const total = 1540 + 220 + 550 + 1540 + 110;
  const analysis = JSON.parse(
    await shown(analyze, {
      ...read,
      json: true,
      groupBy: ["attemptId"],
      filters: {},
    }),
  );
  assert.equal(analysis.calls.usage.tokens.total, total);
  assert.equal(analysis.calls.usage.childTokens, 1100);
  assert.deepEqual(analysis.calls.descendants, {
    calls: 3,
    threads: 3,
    input: 1000,
    cached: 700,
    output: 100,
    reasoning: 0,
    total: 1100,
    outside: 0,
  });
  const byAttempt = Object.fromEntries(
    analysis.groups.map((group) => [
      group.key.attemptId,
      group.descendants.total,
    ]),
  );
  assert.deepEqual(byAttempt, {
    "item:a:work#1": 440,
    "item:a:work#2": 0,
    "item:a:work#3": 220,
    "item:a:work#4": 440,
    "item:a:work#5": 0,
  });
  assert.equal(analysis.calls.efficiency.tokensPerCall, total / 5);
  assert.deepEqual(analysis.calls.models["child threads (model unreported)"], {
    calls: 3,
    input: 1000,
    output: 100,
    cached: 700,
    cacheWrite: 0,
    costUsd: 0,
  });
  // The calls' own: 1,000 + 200 + 300 + 1,000 + 100.
  assert.equal(analysis.calls.models["gpt-6.1-sol"].input, 2600);
  // A filter keeps the thread's history: #3 is still its increase.
  const filtered = JSON.parse(
    await shown(analyze, {
      ...read,
      json: true,
      groupBy: ["phase"],
      filters: { attemptId: "item:a:work#3" },
    }),
  );
  assert.equal(filtered.calls.descendants.total, 220);
  assert.equal(filtered.calls.usage.tokens.total, 550);
  const text = await shown(analyze, {
    ...read,
    groupBy: ["phase"],
    filters: {},
  });
  assert.match(
    text,
    /5 calls · 3,960 tokens \(in [^)]*; child threads 1,100 of the total\)/,
  );
  assert.match(
    text,
    /Codex child threads: 3 in 3 calls · 1,100 tokens \(1,000 in, 700 cached, 100 out, 0 reasoning\), in the totals/,
  );
  assert.doesNotMatch(text, /not in the totals/);

  const options = { ...read, maxBytesPerCall: 1_000_000 };
  const summary = JSON.parse(
    await shown(diagnostics, { ...options, summary: true, json: true }),
  );
  assert.equal(summary.roles.worker.tokens.total, total);
  assert.equal(summary.roles.worker.childTokens, 1100);
  const timeline = (await shown(diagnostics, options))
    .split("\n")
    .filter((line) => line.includes("model worker"));
  assert.equal(timeline.length, 5);
  assert.match(
    timeline[0],
    /1,540 tokens \(1,200 cached, 440 by 1 child thread\)/,
  );
  assert.match(timeline[1], /220 tokens \(100 cached\)$/);
  assert.match(timeline[2], /550 tokens \(300 cached, 220 by 1 child thread\)/);
  assert.match(
    timeline[3],
    /1,540 tokens \(1,200 cached, 440 by 1 child thread\)/,
  );
  assert.match(timeline[4], /110 tokens \(50 cached\)$/);
});

test("the scorecard counts an older log's Codex child threads once, inside its tokens", () => {
  const root = tempDir("factory-children-card-");
  const logs = join(root, "logs");
  const objectives = join(root, "objectives");
  saveState(objectives, newObjective(ISSUE, new Date(Date.now() - 60_000)));
  writeLog(logs);
  const report = factoryObjective({ logs, objectives, secrets: [] }, ISSUE);
  assert.equal(report.tokens.total.known, 1540 + 220 + 550 + 1540 + 110);
  assert.deepEqual(report.nativeUsage.descendants, {
    threads: 3,
    input: 1000,
    cached: 700,
    output: 100,
    reasoning: 0,
    total: 1100,
  });
});

test("an older log with no thread counts each call's child threads whole", () => {
  // Nothing to continue: no thread id, so no increase to take.
  const logs = tempDir("factory-children-nothread-");
  const log = new RunLog(logs, "2026-10-28T05-05-54-542Z-2");
  for (const n of [1, 2])
    log.write(ISSUE, {
      step: "plan:1:1",
      event: "model-usage",
      role: "planner",
      provider: "codex",
      tokens: { input: 10, output: 1, cached: 0, total: 11 },
      providerUsage: {
        descendants: { threads: 1, input: 5, output: 1, cached: 0, total: 6 },
      },
      callId: `p${n}`,
    });
  let out = "";
  analyze(
    {
      logs,
      issue: ISSUE,
      runs: { kind: "all" },
      secrets: [],
      json: true,
      groupBy: ["phase"],
      filters: {},
    },
    (text) => {
      out += text;
    },
  );
  const analysis = JSON.parse(out);
  assert.equal(analysis.calls.descendants.total, 12);
  assert.equal(analysis.calls.usage.tokens.total, 34);
});
