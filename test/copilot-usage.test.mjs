import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { summarizeDiagnosticUsage } from "../dist/diagnostics.js";
import { CopilotUsage } from "../dist/execution/github-copilot-usage.js";

const event = (id, data = {}) => ({ type: "assistant.usage", id, data });

test("Copilot per-call sums deduplicate events/calls and retain only safe private token fields", () => {
  const usage = new CopilotUsage(["secret-value"]);
  assert.deepEqual(usage.totals(), {});
  const first = event("event-1", {
    apiCallId: "secret-value",
    providerCallId: "request-1",
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 8,
    cacheWriteTokens: 2,
    reasoningTokens: 1,
    prompt: "private prompt",
    cost: 0.5,
    unknownTokens: 100,
  });
  const raw = usage.observe(first, "session-1");
  assert.deepEqual(raw, {
    providerEventId: "event-1",
    providerSessionId: "session-1",
    apiCallId: "[REDACTED]",
    providerCallId: "request-1",
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
    },
  });
  assert.equal(usage.observe(first, "session-1"), undefined);
  assert.equal(
    usage.observe({ ...first, id: "event-2" }, "session-1"),
    undefined,
  );
  assert.equal(
    usage.observe(
      event("alias-event", {
        providerCallId: "request-1",
        inputTokens: 12,
        outputTokens: 3,
      }),
      "session-1",
    ),
    undefined,
  );
  usage.observe(
    event("event-3", {
      providerCallId: "request-2",
      inputTokens: 5,
      outputTokens: 7,
    }),
    "session-1",
  );
  usage.observe(
    event("event-4", {
      providerCallId: "request-2",
      inputTokens: 5,
      outputTokens: 7,
    }),
    "session-1",
  );
  assert.deepEqual(usage.totals(), { inputTokens: 17, outputTokens: 10 });
});

test("Copilot missing, malformed and overflowing categories remain independently unknown", () => {
  for (const invalid of [
    undefined,
    null,
    "12",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const usage = new CopilotUsage([]);
    usage.observe(
      event("first", { inputTokens: 10, outputTokens: 2 }),
      "session",
    );
    const raw = usage.observe(
      event("missing", {
        inputTokens: invalid,
        outputTokens: 3,
        cacheReadTokens: invalid,
      }),
      "session",
    );
    assert.deepEqual(raw.usage, { outputTokens: 3 });
    usage.observe(
      event("last", { inputTokens: 20, outputTokens: 5 }),
      "session",
    );
    assert.deepEqual(usage.totals(), { outputTokens: 10 });
  }
  const usage = new CopilotUsage([]);
  usage.observe(
    event("first", { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }),
    "session",
  );
  usage.observe(
    event("second", { inputTokens: 1, outputTokens: 0 }),
    "session",
  );
  assert.deepEqual(usage.totals(), { outputTokens: 0 });
  const noIdentity = new CopilotUsage([]);
  noIdentity.observe(
    event(undefined, { inputTokens: 10, outputTokens: 2 }),
    "session",
  );
  assert.deepEqual(noIdentity.totals(), {});
});

test("Copilot context counts never become consumption or inferred totals", () => {
  const usage = new CopilotUsage([]);
  for (const type of [
    "session.shutdown",
    "session.usage_info",
    "session.usage_checkpoint",
  ])
    assert.equal(
      usage.observe(
        {
          type,
          id: type,
          data: {
            conversationTokens: 1000,
            inputTokens: 50,
            outputTokens: 10,
            totalTokens: 60,
          },
        },
        "session",
      ),
      undefined,
    );
  assert.deepEqual(usage.totals(), {});
  usage.observe(
    event("zero", { inputTokens: 0, outputTokens: 0, totalTokens: 1000 }),
    "session",
  );
  assert.deepEqual(usage.totals(), { inputTokens: 0, outputTokens: 0 });
});

test("production Copilot worker exposes terminal usage through existing summaries without model calls", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-copilot-usage-"));
  try {
    for (const scenario of [
      "usage",
      "usage-partial",
      "usage-missing",
      "usage-failure",
    ]) {
      const request = join(root, `${scenario}.request.json`);
      const result = join(root, `${scenario}.result.json`);
      writeFileSync(
        request,
        JSON.stringify({
          request: {
            attemptId: scenario,
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
          },
          config: {
            adapter: "scripted-exact",
            model: "scripted-model",
            reasoningEffort: "medium",
            availableTools: [],
            permissionKinds: [],
            timeoutSeconds: 1,
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
            new URL(
              "../dist/execution/github-copilot-worker.js",
              import.meta.url,
            ),
          ),
          request,
          result,
        ],
        {
          env: {
            PATH: process.env.PATH,
            FACTORY_SCRIPTED_PROVIDER_SCENARIO: scenario,
            FACTORY_SCRIPTED_PROVIDER_SENT: join(root, `${scenario}.sent`),
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.ifError(child.error);
      assert.equal(
        child.status,
        scenario === "usage-failure" ? 1 : 0,
        child.stderr,
      );
      const progress = result.replace(/\.result\.json$/, ".progress.ndjson");
      assert.equal(statSync(progress).mode & 0o777, 0o600);
      const observations = readFileSync(progress, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      const raw = observations.filter((e) => e.operation === "assistant.usage");
      assert.equal(raw.length, 2);
      assert.equal(raw[0].providerEventId, "usage-first");
      assert.equal(raw[0].providerSessionId, "scripted-copilot");
      assert.equal(raw[0].attemptId, scenario);
      assert.doesNotMatch(
        JSON.stringify(raw),
        /private-payload|conversationTokens/,
      );
      const worker = observations.filter((e) => e.operation === "worker-usage");
      assert.equal(worker.length, 2);
      assert.deepEqual(worker[0].workerUsage.usage, {});
      const expected =
        scenario === "usage-missing"
          ? {}
          : scenario === "usage-partial"
            ? { outputTokens: 7 }
            : { inputTokens: 30, outputTokens: 7 };
      assert.deepEqual(worker[1].workerUsage.usage, expected);
      const summary = summarizeDiagnosticUsage(observations).workerUsage;
      assert.deepEqual(summary.tokenTotals, expected);
      assert.equal(summary.invocationCount, 1);
      assert.equal(
        summary.completedCount,
        scenario === "usage-failure" ? 0 : 1,
      );
      assert.equal(summary.failedCount, scenario === "usage-failure" ? 1 : 0);
      assert.equal(
        summary.usageUnavailableCount,
        scenario === "usage-missing" ? 1 : 0,
      );
      assert.deepEqual(
        summarizeDiagnosticUsage([...observations, ...observations]).workerUsage
          .tokenTotals,
        expected,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
