import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  WorkerInteractionCapture,
  codexCaptureEvent,
} from "../dist/execution/interaction-capture.js";
import { runCodexWorker } from "../dist/execution/worker.js";
import { readInteractionContent } from "../dist/capture.js";
import { ClaudeUsage } from "../dist/execution/claude-usage.js";
import { CopilotUsage } from "../dist/execution/github-copilot-usage.js";

const repository = "public/capture-test";
const request = (
  root,
  provider = "codex",
  enabled = true,
  maxBytesPerInvocation = 100000,
) => ({
  attemptId: randomUUID(),
  worktree: root,
  item: {
    title: "Public capture fixture",
    goal: "Observe SDK boundary",
    acceptance: [],
    nonGoals: [],
    ownedPaths: ["proof.txt"],
    brief: "No provider calls",
    validation: [],
  },
  capture: {
    context: {
      repository,
      objective: 1,
      invocationId: randomUUID(),
      providerAttempt: 1,
      phase: "implementation",
      adapter: `${provider}-sdk`,
      configured: { provider, model: "scripted-model" },
    },
    policy: { enabled, maxBytesPerInvocation },
  },
});
const records = (path) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((value) => value.capture)
    .map((value) => value.capture);
const content = (record) =>
  record.content.reference
    ? readInteractionContent(repository, record.content.reference)
    : "";
const fixture = (action) => {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-capture-"));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    action(root);
  } finally {
    if (old === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
};

test("worker SDK projections retain ordered call/results, safe usage and partial failures without hidden payloads", () =>
  fixture((root) => {
    const path = join(root, "observations.ndjson");
    const capture = new WorkerInteractionCapture(request(root), path, [
      "secret-value",
    ]);
    capture.request("exact prompt secret-value", {
      systemPrompt: "explicit instructions",
    });
    capture.codex(
      {
        type: "item.started",
        item: {
          id: "shell1",
          type: "command_execution",
          command: "echo secret-value",
          aggregated_output: "secret-",
          status: "in_progress",
        },
      },
      "thread1",
    );
    capture.codex(
      {
        type: "item.completed",
        item: {
          id: "shell1",
          type: "command_execution",
          command: "echo secret-value",
          aggregated_output: "secret-value\n",
          status: "completed",
          exit_code: 0,
        },
      },
      "thread1",
    );
    capture.codex({
      type: "item.completed",
      item: {
        id: "thinking",
        type: "reasoning",
        text: "do-not-capture-reasoning",
      },
    });
    capture.codex({
      type: "turn.failed",
      error: { message: "partial failure secret-value" },
    });
    capture.outcome("failed", {}, new Error("failure secret-value"));
    const all = records(path);
    assert.deepEqual(
      all.map((value) => value.sequence),
      all.map((_, index) => index + 1),
    );
    const tools = all.filter((value) => value.toolCallId === "shell1");
    assert.equal(tools.length, 2);
    assert.match(content(tools[0]), /echo \[REDACTED\]/);
    assert.equal(JSON.parse(content(tools[0])).output, "");
    assert.equal(JSON.parse(content(tools[1])).exitCode, 0);
    assert.doesNotMatch(
      all.map(content).join(""),
      /secret-value|do-not-capture-reasoning/,
    );
    assert.equal(all.at(-1).outcome.status, "failed");
    assert.equal(all.at(-2).usage.completeness, "unavailable");
    assert.equal(all[0].configured.model, "scripted-model");
    const projected = codexCaptureEvent({
      type: "item.completed",
      item: {
        id: "mcp",
        type: "mcp_tool_call",
        server: "public",
        tool: "read",
        arguments: { path: "proof.txt" },
        result: {
          content: [{ type: "text", text: "proof" }],
          structured_content: { ok: true },
          _meta: { auth: "excluded" },
        },
        status: "completed",
      },
    });
    assert.equal(projected.event.toolCallId, "mcp");
    assert.doesNotMatch(JSON.stringify(projected.content()), /excluded/);
  }));

test("Claude and Copilot projections reuse dedup identities and separate model totals from calls", () =>
  fixture((root) => {
    const path = join(root, "observations.ndjson");
    const capture = new WorkerInteractionCapture(request(root), path, [
      "secret-value",
    ]);
    const claude = new ClaudeUsage([]);
    const assistant = {
      type: "assistant",
      session_id: "claude1",
      uuid: "event1",
      message: {
        id: "message1",
        model: "reported-model",
        content: [
          { type: "thinking", thinking: "hidden" },
          {
            type: "tool_use",
            id: "tool1",
            name: "Read",
            input: { path: "proof.txt" },
          },
        ],
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          output_tokens: 5,
          arbitrary: "excluded",
        },
      },
    };
    for (let i = 0; i < 2; i++)
      capture.claude(assistant, claude.observe(assistant));
    capture.claude({
      type: "user",
      session_id: "claude1",
      uuid: "result1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool1",
            content: "secret-value",
          },
        ],
      },
    });
    capture.claude({
      type: "result",
      session_id: "claude1",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.25,
      usage: { input_tokens: 2 },
      modelUsage: {
        primary: {
          inputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          outputTokens: 5,
        },
      },
    });
    const copilot = new CopilotUsage([]);
    const event = {
      type: "assistant.usage",
      id: "usage1",
      data: {
        apiCallId: "call1",
        model: "reported-copilot",
        inputTokens: 6,
        outputTokens: 2,
        cost: 999,
        secretField: "excluded",
      },
    };
    for (let i = 0; i < 2; i++)
      capture.copilot(event, "copilot1", copilot.observe(event, "copilot1"));
    capture.copilot({
      type: "tool.execution_start",
      data: {
        toolCallId: "tool2",
        toolName: "shell",
        arguments: { command: "printf safe" },
      },
    });
    capture.copilot({
      type: "tool.execution_partial_result",
      data: { toolCallId: "tool2", partialOutput: "secret-" },
    });
    capture.copilot({
      type: "tool.execution_partial_result",
      data: { toolCallId: "tool2", partialOutput: "value" },
    });
    capture.copilot({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tool2",
        success: true,
        result: { content: "secret-value" },
      },
    });
    capture.providerCompleted();
    capture.outcome(
      "failed",
      { inputTokens: 9 },
      new Error("invalid asset manifest"),
      "protocol",
    );
    const all = records(path);
    const calls = all.filter((value) => value.usage?.scope === "provider-call");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].usage.normalized.inputTokens, 9);
    assert.equal(calls[1].reportedModel, "reported-copilot");
    assert.equal(calls[1].usage.cost, undefined);
    assert.equal(
      all.find((value) => value.usage?.cost).usage.scope,
      "invocation-cumulative",
    );
    assert.equal(
      all.find((value) => value.outcome?.stage === "provider").outcome.status,
      "completed",
    );
    assert.equal(all.at(-1).outcome.stage, "protocol");
    assert.equal(
      all.find((value) => value.usage?.cost).usage.cost.provenance,
      "Claude SDK total_cost_usd",
    );
    const tools = all.filter((value) => value.toolCallId === "tool2");
    assert.equal(tools.length, 4);
    assert.equal(JSON.parse(content(tools[1])).partialOutput.text, "");
    assert.doesNotMatch(
      all.map(content).join(""),
      /hidden|secret-value|excluded/,
    );
  }));

test("Claude estimate completeness is independent of terminal token coverage", () =>
  fixture((root) => {
    for (const [subtype, isError, supplied, expected] of [
      ["success", false, 0, "available"],
      ["success", true, 0.25, "partial"],
      ["error_max_turns", true, 0.25, "partial"],
      ["error_during_execution", true, 0, undefined],
      ["success", false, undefined, undefined],
    ]) {
      const path = join(root, `${randomUUID()}.ndjson`);
      const capture = new WorkerInteractionCapture(request(root), path, []);
      capture.claude({
        type: "result",
        session_id: "claude",
        subtype,
        is_error: isError,
        result: "result",
        errors: ["failure"],
        total_cost_usd: supplied,
        usage: {},
        modelUsage: {},
      });
      capture.outcome(isError ? "failed" : "completed", {});
      const terminal = records(path).find((record) => record.usage?.terminal);
      assert.equal(terminal.usage.completeness, "unavailable");
      assert.equal(terminal.usage.cost?.completeness, expected);
      if (expected) assert.equal(terminal.usage.cost.value, supplied);
      else assert.equal(terminal.usage.cost, undefined);
    }
  }));

test("disabled, bounded and unavailable capture remain observational", () =>
  fixture((root) => {
    for (const [name, enabled, bytes] of [
      ["disabled", false, 100],
      ["bounded", true, 24],
    ]) {
      const path = join(root, `${name}.ndjson`);
      const capture = new WorkerInteractionCapture(
        request(root, "codex", enabled, bytes),
        path,
        [],
      );
      capture.request("x".repeat(100));
      capture.response("final text");
      const all = records(path);
      if (!enabled)
        assert.ok(
          all.every((value) => value.content.status === "capture-disabled"),
        );
      else {
        assert.ok(all.every((value) => value.content.truncated));
        assert.ok(
          all.reduce(
            (total, value) => total + value.content.retainedBytes,
            0,
          ) <= bytes,
        );
      }
    }
    const path = join(root, "failure.ndjson");
    const malformed = request(root);
    malformed.capture.context.providerAttempt = 0;
    const capture = new WorkerInteractionCapture(malformed, path, []);
    assert.doesNotThrow(() => {
      capture.request("safe");
      capture.outcome("failed", {}, new Error("original"));
    });
    assert.equal(records(path)[0].content.status, "unavailable");
  }));

test("production worker entry points capture the actual boundary request and terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-capture-entry-"));
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const original = Codex.prototype.startThread;
  try {
    Codex.prototype.startThread = () => ({
      id: "codex-session",
      runStreamed: async () => ({
        events: (async function* () {
          yield {
            type: "item.completed",
            item: { type: "agent_message", id: "reply", text: "codex done" },
          };
          yield {
            type: "turn.completed",
            usage: { input_tokens: 4, output_tokens: 2 },
          };
        })(),
      }),
    });
    for (const provider of ["codex", "claude", "github-copilot"]) {
      const supplied = request(root, provider);
      const input = join(root, `${provider}.request.json`),
        result = join(root, `${provider}.result.json`);
      writeFileSync(
        input,
        JSON.stringify({
          request: supplied,
          model: { model: "scripted-model", reasoningEffort: "medium" },
          network: "off",
          config: {
            adapter: "scripted-exact",
            model: "scripted-model",
            reasoningEffort: "medium",
            permissionMode: "acceptEdits",
            tools: [],
            allowedTools: [],
            settingSources: [],
            maxTurns: 4,
            availableTools: [],
            permissionKinds: [],
            timeoutSeconds: 1,
          },
        }),
      );
      if (provider === "codex")
        assert.equal(await runCodexWorker(input, result), true);
      else {
        const child = spawnSync(
          process.execPath,
          [
            "--loader",
            fileURLToPath(
              new URL("./fixtures/provider-worker-loader.mjs", import.meta.url),
            ),
            fileURLToPath(
              new URL(
                `../dist/execution/${provider}-worker.js`,
                import.meta.url,
              ),
            ),
            input,
            result,
          ],
          {
            env: {
              PATH: process.env.PATH,
              XDG_STATE_HOME: root,
              FACTORY_SCRIPTED_PROVIDER_SCENARIO:
                provider === "claude" ? "claude-usage" : "usage",
              FACTORY_SCRIPTED_PROVIDER_SENT: join(root, "sent"),
            },
            encoding: "utf8",
            timeout: 10000,
          },
        );
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
      }
      const all = records(
        result.replace(/\.result\.json$/, ".progress.ndjson"),
      );
      const boundary = all.find((value) => value.kind === "request");
      assert.match(content(boundary), /Public capture fixture/);
      if (provider !== "codex")
        assert.match(
          content(boundary),
          /implementation worker controlled by Clockgrove Factory/,
        );
      assert.equal(all.at(-1).outcome.status, "completed");
      assert.ok(
        all.some(
          (value) =>
            value.usage?.terminal &&
            value.usage.completeness === "available-categories",
        ),
      );
    }
  } finally {
    Codex.prototype.startThread = original;
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    rmSync(root, { recursive: true, force: true });
  }
});
