import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { summarizeDiagnosticUsage } from "../dist/diagnostics.js";
import {
  claudeTokenUsage,
  claudeCost,
  claudeModelUsage,
} from "../dist/execution/claude-usage.js";
import { runCodexWorker } from "../dist/execution/worker.js";

const request = (root, id) => ({
  attemptId: id,
  worktree: root,
  item: {
    title: "Usage fixture",
    goal: "Report usage",
    acceptance: [],
    nonGoals: [],
    ownedPaths: ["proof.txt"],
    brief: "Scripted only",
    validation: [],
  },
});
const progress = (result) =>
  readFileSync(result.replace(/\.result\.json$/, ".progress.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);

test("Claude normalizes complete per-model categories without cache or model double counting", () => {
  assert.equal(claudeCost(0.25), 0.25);
  for (const invalid of [undefined, "private-payload", -1, NaN, Infinity])
    assert.equal(claudeCost(invalid), undefined);
  const main = {
    inputTokens: 10,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 5,
    outputTokens: 8,
    thinkingTokens: 2,
  };
  assert.deepEqual(claudeTokenUsage({ main }), {
    inputTokens: 35,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 5,
    outputTokens: 8,
    reasoningOutputTokens: 2,
  });
  for (const invalid of [
    undefined,
    null,
    "5",
    -1,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const usage = claudeTokenUsage({
      main,
      helper: { ...main, cacheCreationInputTokens: invalid },
    });
    assert.equal(usage.inputTokens, undefined);
    assert.equal(usage.cacheWriteInputTokens, undefined);
    assert.equal(usage.outputTokens, 16);
    assert.equal(usage.cachedInputTokens, 40);
  }
  assert.equal(
    claudeTokenUsage({
      main: { ...main, inputTokens: Number.MAX_SAFE_INTEGER },
    }).inputTokens,
    undefined,
  );
  assert.equal(
    claudeTokenUsage({ main: { ...main, thinkingTokens: 9 } })
      .reasoningOutputTokens,
    undefined,
  );
  for (const absent of [undefined, null, {}, [], { main: null }])
    assert.deepEqual(claudeTokenUsage(absent), {});
  assert.deepEqual(
    claudeModelUsage(
      {
        "secret-model": {
          ...main,
          private: "private-payload",
          contextWindow: 1000000,
        },
      },
      ["secret-model"],
    ),
    { "[REDACTED]": main },
  );
});

test("production Claude worker captures unique assistant observations and uses result model totals on success/error", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-usage-"));
  try {
    for (const scenario of [
      "claude-usage",
      "claude-usage-missing",
      "claude-usage-failure",
      "claude-usage-crash",
      "claude-usage-no-result",
    ]) {
      const input = join(root, `${scenario}.request.json`);
      const result = join(root, `${scenario}.result.json`);
      writeFileSync(
        input,
        JSON.stringify({
          request: request(root, scenario),
          config: {
            adapter: "scripted-exact",
            model: "scripted-model",
            reasoningEffort: "medium",
            permissionMode: "acceptEdits",
            tools: [],
            allowedTools: [],
            settingSources: [],
            maxTurns: 4,
          },
        }),
      );
      const child = spawnSync(
        process.execPath,
        [
          "--loader",
          fileURLToPath(
            new URL("./fixtures/provider-worker-loader.mjs", import.meta.url),
          ),
          fileURLToPath(
            new URL("../dist/execution/claude-worker.js", import.meta.url),
          ),
          input,
          result,
        ],
        {
          env: {
            PATH: process.env.PATH,
            FACTORY_SCRIPTED_PROVIDER_SCENARIO: scenario,
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.ifError(child.error);
      const failed = [
        "claude-usage-failure",
        "claude-usage-crash",
        "claude-usage-no-result",
      ].includes(scenario);
      assert.equal(child.status, failed ? 1 : 0, child.stderr);
      const observations = progress(result);
      const calls = observations.filter(
        (e) => e.operation === "assistant" && e.usage,
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((e) => e.providerMessageId),
        ["call-one", "call-two"],
      );
      assert.equal(calls[0].sessionId, "scripted-claude");
      assert.equal(calls[0].attemptId, scenario);
      assert.equal(calls[0].usage.output_tokens, 9999); // Raw placeholder, never summed.
      assert.doesNotMatch(
        JSON.stringify(observations),
        /private-payload|contextWindow/,
      );
      const expected =
        scenario === "claude-usage-crash" ||
        scenario === "claude-usage-no-result"
          ? {}
          : scenario === "claude-usage-missing"
            ? {
                cachedInputTokens: 24,
                outputTokens: 11,
                reasoningOutputTokens: 3,
              }
            : {
                inputTokens: 42,
                cachedInputTokens: 24,
                cacheWriteInputTokens: 6,
                outputTokens: 11,
                reasoningOutputTokens: 3,
              };
      const summary = summarizeDiagnosticUsage(observations).workerUsage;
      assert.deepEqual(summary.tokenTotals, expected);
      assert.equal(summary.invocationCount, 1);
      assert.equal(summary.failedCount, failed ? 1 : 0);
      assert.equal(summary.completedCount, failed ? 0 : 1);
      assert.equal(summary.tokenTotals.totalTokens, undefined);
      assert.deepEqual(
        summarizeDiagnosticUsage([...observations, ...observations]).workerUsage
          .tokenTotals,
        expected,
      );
      if (!failed)
        assert.doesNotMatch(
          readFileSync(result, "utf8"),
          /private-payload|contextWindow/,
        );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production Codex worker preserves completed-turn accounting and filters raw usage evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-codex-usage-"));
  const original = Codex.prototype.startThread;
  try {
    for (const [scenario, counters, expected] of [
      [
        "complete",
        { input_tokens: 30, cached_input_tokens: 10, output_tokens: 8 },
        { inputTokens: 30, cachedInputTokens: 10, outputTokens: 8 },
      ],
      ["invalid", { input_tokens: -1, output_tokens: "8" }, {}],
      ["missing", {}, {}],
    ]) {
      let later = 0;
      Codex.prototype.startThread = () => ({
        id: "scripted-codex-thread",
        async runStreamed() {
          return {
            events: (async function* () {
              yield {
                type: "turn.completed",
                usage: {
                  ...counters,
                  private: "private-payload",
                  context_tokens: 1000000,
                },
              };
              later += 1;
              yield { type: "turn.completed", usage: counters };
            })(),
          };
        },
      });
      const input = join(root, `${scenario}.request.json`);
      const result = join(root, `${scenario}.result.json`);
      writeFileSync(
        input,
        JSON.stringify({
          request: request(root, scenario),
          network: "off",
          model: { model: "scripted-model", reasoningEffort: "medium" },
          providerTurnIdleTimeoutMs: 1000,
        }),
      );
      assert.equal(await runCodexWorker(input, result), true);
      assert.equal(later, 0);
      const observations = progress(result);
      assert.doesNotMatch(
        JSON.stringify(observations),
        /private-payload|context_tokens/,
      );
      assert.equal(
        observations.find((e) => e.operation === "turn.completed").threadId,
        "scripted-codex-thread",
      );
      assert.doesNotMatch(
        readFileSync(result, "utf8"),
        /private-payload|context_tokens/,
      );
      assert.deepEqual(
        summarizeDiagnosticUsage(observations).workerUsage.tokenTotals,
        expected,
      );
    }
  } finally {
    Codex.prototype.startThread = original;
    rmSync(root, { recursive: true, force: true });
  }
});
