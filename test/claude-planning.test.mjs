import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  ClaudePlanningModel,
  claudeOutputSchema,
  probeClaudeLogin,
} from "../dist/claude-planning.js";
import {
  CodexPlanningModel,
  MalformedPlannerOutput,
  planningReviewEvidence,
} from "../dist/compiler.js";
import { validateConfig } from "../dist/config.js";
import {
  AuthenticationRequiredError,
  CompletedModelInvocationError,
} from "../dist/contracts.js";
import { composePlanning } from "../dist/index.js";
import { ProviderTurnTimeoutError } from "../dist/provider-turn.js";
import { reviewPacket } from "../dist/review-evidence.js";
import { compilerRequest, compilerResponse } from "./support/compiler-wire.mjs";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const baseSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const claudePlanning = {
  kind: "claude-agent-sdk",
  maxOutputTokens: 64000,
  planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
  reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "medium" },
};
const session = "session-planning";
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};

/** One Agent SDK session as the pinned runtime emits it for outputFormat. */
function sdkSession(options, structured, result = {}, init = {}) {
  return [
    {
      type: "system",
      subtype: "init",
      model: options.model,
      tools: ["StructuredOutput"],
      mcp_servers: [],
      permissionMode: "dontAsk",
      session_id: session,
      uuid: "init",
      ...init,
    },
    {
      type: "assistant",
      message: {
        id: "msg_planning",
        model: options.model,
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "StructuredOutput",
            input: structured,
          },
        ],
        usage,
      },
      parent_tool_use_id: null,
      session_id: session,
      uuid: "assistant",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: JSON.stringify(structured),
      stop_reason: "tool_use",
      structured_output: structured,
      usage,
      modelUsage: {
        [options.model]: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          thinkingTokens: 4,
          costUSD: 0.01,
        },
      },
      total_cost_usd: 0.01,
      permission_denials: [],
      session_id: session,
      uuid: "result",
      ...result,
    },
  ];
}

const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * A failure the runtime reports without a model response, shaped as the
 * pinned SDK emits it: a `<synthetic>` assistant message, then a `success`
 * result with `is_error` and `api_error_status` null unless the API answered.
 */
function runtimeFailure(options, text, { error, status = null } = {}) {
  const [init] = sdkSession(options, {});
  return [
    init,
    {
      type: "assistant",
      message: {
        id: "synthetic-message",
        model: "<synthetic>",
        role: "assistant",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text }],
        usage: zeroUsage,
      },
      parent_tool_use_id: null,
      session_id: session,
      uuid: "synthetic",
      error,
      is_api_error_message: true,
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: status,
      num_turns: 1,
      result: text,
      stop_reason: "stop_sequence",
      terminal_reason: "api_error",
      total_cost_usd: 0,
      usage: zeroUsage,
      modelUsage: {},
      permission_denials: [],
      session_id: session,
      uuid: "result",
    },
  ];
}

/** Scripted Agent SDK boundary: each call answers from `respond`. */
function fakeQuery(respond) {
  const calls = [];
  return {
    calls,
    query({ prompt, options }) {
      calls.push({ prompt, options, cwdExisted: existsSync(options.cwd) });
      const outcome = respond(prompt, options, calls.length - 1);
      return (async function* () {
        if (outcome instanceof Error) throw outcome;
        yield* outcome;
      })();
    },
  };
}

function claudeModel(respond, options = {}) {
  const fake = fakeQuery(respond);
  return {
    ...fake,
    model: new ClaudePlanningModel(claudePlanning, {
      query: fake.query,
      wait: async () => undefined,
      ...options,
    }),
  };
}

const objective = "# Objective\n\n## Acceptance\n- Result exists.";
const compileInput = () =>
  compilerRequest({
    objective,
    baseSha,
    sources: [{ path: "OBJECTIVE", content: objective }],
  });
const graphReview = {
  objective,
  baseSha,
  sources: [{ path: "OBJECTIVE", content: objective }],
  graph: { objective: 1, baseSha, items: [] },
  commands: [],
  finalCommands: [],
  controllerCapabilities: compileInput().controllerCapabilities,
  controllerCapabilitiesDigest: compileInput().controllerCapabilitiesDigest,
};
// A fixed packet identity keeps the prompt identical across providers.
graphReview.reviewPacket = reviewPacket(
  [],
  planningReviewEvidence(graphReview),
);
const graphReviewInput = () => ({ ...graphReview });
const resultPacket = reviewPacket(
  ["Result exists."],
  [
    {
      origin: "controller",
      path: "Work Item Git delta: one",
      content: "delta",
    },
  ],
);
const resultReviewInput = () => ({
  reviewPacket: resultPacket,
  criteria: ["Result exists."],
  baseSha,
  treeSha,
  sources: [],
  change: "{}",
  commands: [],
});
const diagnosisSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["stop", "repair"] } },
  required: ["decision"],
  additionalProperties: false,
};
const diagnosisInput = () => ({
  purpose: "diagnosis",
  objective,
  baseSha,
  sources: [{ path: "OBJECTIVE", content: objective }],
  controllerCapabilities: compileInput().controllerCapabilities,
  controllerCapabilitiesDigest: compileInput().controllerCapabilitiesDigest,
  schema: diagnosisSchema,
});

/** The same deterministic answer for whichever provider receives a prompt. */
function answer(prompt) {
  if (prompt.includes("\nCompiler choices (JSON data):\n"))
    return compilerResponse(prompt);
  if (prompt.startsWith("Return only the requested diagnostic JSON"))
    return { decision: "stop" };
  return { packetId: "packet", findings: [] };
}
const answered = (prompt, options) => sdkSession(options, answer(prompt));

/** No keyword the structured-output API rejects reaches the request. */
function assertClaudeSchemaSubset(node) {
  if (Array.isArray(node)) return node.forEach(assertClaudeSchemaSubset);
  if (!node || typeof node !== "object") return;
  for (const keyword of ["minimum", "maximum", "minLength", "maxLength"])
    assert.notEqual(typeof node[keyword], "number");
  if (typeof node.minItems === "number")
    assert.ok([0, 1].includes(node.minItems));
  for (const [key, value] of Object.entries(node))
    if (key !== "enum" && key !== "required" && key !== "const")
      assertClaudeSchemaSubset(value);
}

async function runAllPhases(model) {
  return [
    await model.generateStructured(compileInput()),
    await model.reviewGraph(graphReviewInput()),
    await model.reviewResult(resultReviewInput()),
    await model.reviewResult({
      ...resultReviewInput(),
      reviewPhase: "objective-review",
    }),
    await model.generateStructured(diagnosisInput()),
  ];
}

const invocation = (phase, observations) => ({
  invocationId: phase,
  phase,
  ordinal: 0,
  observe: (event) => observations.push(event),
});

test("Claude planning sends the Codex prompts and schemas through a tool-free Agent SDK session", async (t) => {
  const codexCalls = [];
  t.mock.method(Codex.prototype, "startThread", (options) => ({
    id: "thread",
    async runStreamed(prompt, { outputSchema }) {
      codexCalls.push({ options, prompt, schema: outputSchema });
      async function* events() {
        yield {
          type: "item.completed",
          item: {
            id: "m",
            type: "agent_message",
            text: JSON.stringify(answer(prompt)),
          },
        };
        yield { type: "turn.completed", usage: null };
      }
      return { events: events() };
    },
  }));
  const selection = { model: "codex-choice", reasoningEffort: "medium" };
  const codexResults = await runAllPhases(
    new CodexPlanningModel("/unused", selection, selection),
  );

  const hostEnvironment = {
    GH_TOKEN: "github-token-never-forwarded",
    HTTPS_PROXY: "http://proxy.invalid:3128",
    NO_PROXY: "localhost",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
  };
  const saved = Object.fromEntries(
    Object.keys(hostEnvironment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, hostEnvironment);
  let claudeResults;
  let calls;
  try {
    const claude = claudeModel(answered);
    calls = claude.calls;
    claudeResults = await runAllPhases(claude.model);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }

  assert.deepEqual(claudeResults, codexResults);
  assert.equal(calls.length, codexCalls.length);
  for (const [index, { prompt, options, cwdExisted }] of calls.entries()) {
    const codex = codexCalls[index];
    assert.equal(prompt, codex.prompt);
    assert.deepEqual(options.outputFormat, {
      type: "json_schema",
      schema: claudeOutputSchema(codex.schema),
    });
    assertClaudeSchemaSubset(options.outputFormat.schema);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.allowedTools, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.agents, {});
    assert.deepEqual(options.plugins, []);
    assert.deepEqual(options.skills, []);
    assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.persistSession, false);
    assert.equal(options.verbatimPrompts, true);
    assert.deepEqual(options.thinking, { type: "adaptive" });
    assert.ok(options.abortController instanceof AbortController);
    // An empty private working directory that is removed afterwards.
    assert.equal(cwdExisted, true);
    assert.equal(existsSync(options.cwd), false);
    assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.notEqual(options.env.GH_CONFIG_DIR, undefined);
    // Network settings reach the SDK; the worker harness shares this helper.
    assert.equal(options.env.HTTPS_PROXY, hostEnvironment.HTTPS_PROXY);
    assert.equal(options.env.NO_PROXY, hostEnvironment.NO_PROXY);
    assert.equal(
      options.env.NODE_EXTRA_CA_CERTS,
      hostEnvironment.NODE_EXTRA_CA_CERTS,
    );
    assert.match(
      options.env.CLAUDE_AGENT_SDK_CLIENT_APP,
      /^clockgrove-factory\//,
    );
  }
  // Compile and diagnosis use the planner; every review uses the reviewer.
  assert.deepEqual(
    calls.map(({ options }) => [options.model, options.effort]),
    [
      ["claude-opus-5-5", "high"],
      ["claude-sonnet-5-5", "medium"],
      ["claude-sonnet-5-5", "medium"],
      ["claude-sonnet-5-5", "medium"],
      ["claude-opus-5-5", "high"],
    ],
  );
});

test("Claude output schema keeps discriminators and moves unsupported bounds to descriptions", () => {
  const schema = {
    type: "object",
    properties: {
      minimum: { type: "string", enum: ["kept"] },
      index: { type: "integer", minimum: 0, maximum: 3, description: "Pick" },
      probe: { type: ["integer", "null"], minimum: 0 },
      title: { type: "string", minLength: 1 },
      some: { type: "array", minItems: 1, items: { type: "string" } },
      many: { type: "array", minItems: 2, items: { type: "string" } },
      variant: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { type: "string", const: "a" } },
            required: ["kind"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["minimum", "index"],
    additionalProperties: false,
  };
  const original = structuredClone(schema);
  const converted = claudeOutputSchema(schema);
  assert.deepEqual(schema, original);
  assert.deepEqual(converted.properties.minimum, schema.properties.minimum);
  assert.deepEqual(converted.properties.index, {
    type: "integer",
    description: "Pick\n\n{minimum: 0, maximum: 3}",
  });
  assert.deepEqual(converted.properties.probe, {
    type: ["integer", "null"],
    description: "{minimum: 0}",
  });
  assert.deepEqual(converted.properties.title, {
    type: "string",
    description: "{minLength: 1}",
  });
  assert.deepEqual(converted.properties.some, schema.properties.some);
  assert.deepEqual(converted.properties.many, {
    type: "array",
    items: { type: "string" },
    description: "{minItems: 2}",
  });
  assert.deepEqual(converted.properties.variant, schema.properties.variant);
  assert.deepEqual(converted.required, schema.required);
});

test("Claude usage and interactions are observed from the Agent SDK result", async () => {
  const observations = [];
  const { model } = claudeModel(answered);
  await model.reviewGraph({
    ...graphReviewInput(),
    invocation: invocation("graph-review", observations),
  });
  const started = observations.find(({ type }) => type === "started");
  assert.equal(started.adapter, "@anthropic-ai/claude-agent-sdk@0.3.281");
  assert.equal(started.provider, "anthropic-claude-agent-sdk");
  assert.equal(started.model, "claude-sonnet-5-5");
  assert.equal(started.reasoningEffort, "medium");
  const toolCall = observations.find(
    ({ capture }) => capture?.event.tool === "StructuredOutput",
  );
  assert.equal(toolCall.capture.event.providerSessionId, session);
  const terminal = observations.find(
    ({ capture }) =>
      capture?.event.kind === "usage" && capture.event.usage.terminal,
  );
  assert.equal(terminal.capture.event.reportedModel, "claude-sonnet-5-5");
  assert.deepEqual(terminal.capture.event.usage.raw, usage);
  assert.deepEqual(terminal.capture.event.usage.cost, {
    value: 0.01,
    currency: "USD",
    kind: "provider-estimate",
    completeness: "available",
    provenance: "Claude SDK total_cost_usd",
  });
  const completed = observations.find(({ type }) => type === "completed");
  assert.equal(completed.providerThreadId, session);
  assert.equal(completed.usageAvailable, true);
  assert.deepEqual(completed.usage, {
    inputTokens: 15,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 4,
  });
  // `factory analyze` reads completed/failed; the stop reason is separate.
  const outcome = observations.find(
    ({ capture }) => capture?.event.outcome?.stage === "provider",
  );
  assert.deepEqual(outcome.capture.event.outcome, {
    stage: "provider",
    status: "completed",
    stopReason: "tool_use",
  });
});

test("Claude output without structured output or for another request fails closed", async () => {
  const observations = [];
  const missing = claudeModel((prompt, options) =>
    sdkSession(options, answer(prompt), { structured_output: undefined }),
  );
  await assert.rejects(
    missing.model.reviewResult({
      ...resultReviewInput(),
      invocation: invocation("result-review", observations),
    }),
    (error) =>
      error instanceof CompletedModelInvocationError &&
      /no structured output/.test(error.message),
  );
  const failed = observations.find(({ type }) => type === "failed");
  assert.equal(failed.failureClass, "provider-incomplete");
  assert.equal(failed.usageAvailable, true);

  // Schema-valid JSON for another request is still rejected by the decoder.
  const foreign = claudeModel((prompt, options) =>
    sdkSession(options, {
      ...compilerResponse(prompt),
      contextId: "f".repeat(64),
    }),
  );
  await assert.rejects(
    foreign.model.generateStructured(compileInput()),
    (error) =>
      error instanceof MalformedPlannerOutput &&
      /context identity/.test(error.message),
  );
});

test("Claude refusals and limits are completed invocations, never accepted output", async () => {
  for (const [result, failureClass, detail] of [
    [{ stop_reason: "refusal" }, "provider-refusal", /refusal/],
    [
      {
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Reached maximum number of turns"],
      },
      "provider-incomplete",
      /error_max_turns/,
    ],
    [
      {
        subtype: "error_max_structured_output_retries",
        is_error: true,
        errors: ["schema mismatch"],
      },
      "provider-structured-output",
      /schema mismatch/,
    ],
  ]) {
    const observations = [];
    const { model } = claudeModel((prompt, options) =>
      sdkSession(options, answer(prompt), result),
    );
    await assert.rejects(
      model.reviewGraph({
        ...graphReviewInput(),
        invocation: invocation("graph-review", observations),
      }),
      (error) =>
        error instanceof CompletedModelInvocationError &&
        !(error instanceof MalformedPlannerOutput) &&
        detail.test(error.message),
    );
    const failed = observations.find(({ type }) => type === "failed");
    assert.equal(failed.failureClass, failureClass);
    const outcome = observations.find(
      ({ capture }) => capture?.event.outcome?.stage === "provider",
    );
    assert.equal(outcome.capture.event.outcome.status, "failed");
    assert.equal(outcome.capture.event.outcome.failureClass, failureClass);
  }
});

test("Claude login and connection failures reported by the runtime are not provider verdicts", async () => {
  for (const [respond, check, failureClass] of [
    [
      // Pinned SDK 0.3.281 with no login: no API call is made.
      (options) =>
        runtimeFailure(options, "Not logged in · Please run /login", {
          error: "authentication_failed",
        }),
      (error) =>
        error instanceof AuthenticationRequiredError &&
        error.authentication.command === "claude auth login" &&
        /claude auth login/.test(error.message),
      "provider-authentication",
    ],
    [
      (options) =>
        runtimeFailure(
          options,
          "Failed to authenticate. API Error: 401 invalid x-api-key",
          { error: "authentication_failed", status: 401 },
        ),
      (error) => error instanceof AuthenticationRequiredError,
      "provider-authentication",
    ],
    [
      // Offline: the runtime retries, then reports the outage as a result.
      (options) =>
        runtimeFailure(options, "Can't reach the API server (EAI_AGAIN)", {
          error: "unknown",
        }),
      (error) => /EAI_AGAIN/.test(error.message),
      "provider",
    ],
    [
      // A crash after a model reply is still an interrupted attempt.
      (options) => [
        ...sdkSession(options, {}).slice(0, 2),
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 1,
          stop_reason: null,
          errors: ["Claude Code process exited unexpectedly"],
          total_cost_usd: 0,
          usage: zeroUsage,
          modelUsage: {},
          permission_denials: [],
          session_id: session,
          uuid: "result",
        },
      ],
      (error) => /exited unexpectedly/.test(error.message),
      "provider",
    ],
  ]) {
    const observations = [];
    const { model } = claudeModel((_prompt, options) => respond(options));
    await assert.rejects(
      model.reviewResult({
        ...resultReviewInput(),
        invocation: invocation("result-review", observations),
      }),
      (error) =>
        !(error instanceof CompletedModelInvocationError) && check(error),
    );
    const failed = observations.find(({ type }) => type === "failed");
    assert.equal(failed.failureClass, failureClass);
  }
});

test("Claude login readiness asks the runtime for account info without a prompt", async () => {
  for (const [account, expected] of [
    [
      {
        email: "x@example.com",
        subscriptionType: "max",
        apiProvider: "firstParty",
      },
      { status: "present", source: "claude-login" },
    ],
    [
      { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" },
      { status: "present", source: "ANTHROPIC_API_KEY" },
    ],
    [{ tokenSource: "none", apiProvider: "firstParty" }, { status: "missing" }],
  ]) {
    const calls = [];
    const readiness = await probeClaudeLogin(
      { CLAUDE_CODE_OAUTH_TOKEN: "bound-token" },
      ({ prompt, options }) => {
        calls.push({ prompt, options, closed: false });
        return {
          accountInfo: async () => account,
          close: () => {
            calls[0].closed = true;
          },
        };
      },
    );
    assert.equal(readiness.status, expected.status);
    assert.equal(readiness.source, expected.source);
    if (expected.status === "missing")
      assert.match(readiness.detail, /claude auth login/);
    assert.doesNotMatch(JSON.stringify(readiness), /example\.com/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].closed, true);
    assert.equal(typeof calls[0].prompt[Symbol.asyncIterator], "function");
    assert.deepEqual(calls[0].options.tools, []);
    assert.deepEqual(calls[0].options.settingSources, []);
    assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, "bound-token");
    assert.equal(existsSync(calls[0].options.cwd), false);
  }
  const failed = await probeClaudeLogin({}, () => ({
    accountInfo: async () => {
      throw new Error("runtime unavailable");
    },
    close: () => undefined,
  }));
  assert.equal(failed.status, "missing");
  assert.match(failed.detail, /runtime unavailable/);
});

test("Claude sessions exposing anything beyond structured output fail closed", async () => {
  for (const [init, pattern] of [
    [{ tools: ["StructuredOutput", "Bash"] }, /unconfigured tool Bash/],
    [{ mcp_servers: [{ name: "x", status: "connected" }] }, /MCP server/],
    [{ model: "claude-other" }, /selected model claude-other/],
  ]) {
    const { model } = claudeModel((prompt, options) =>
      sdkSession(options, answer(prompt), {}, init),
    );
    await assert.rejects(model.reviewGraph(graphReviewInput()), pattern);
  }
});

test("Claude overload retries only reviews; a lost session stays ambiguous", async () => {
  // The API answered 529 after the runtime's own retries.
  const overloaded = (_prompt, options) =>
    runtimeFailure(options, "API Error: 529 Overloaded", {
      error: "overloaded",
      status: 529,
    });
  const observations = [];
  const review = claudeModel((prompt, options, index) =>
    index === 0 ? overloaded(prompt, options) : answered(prompt, options),
  );
  assert.deepEqual(
    await review.model.reviewGraph({
      ...graphReviewInput(),
      invocation: invocation("graph-review", observations),
    }),
    { packetId: "packet", findings: [] },
  );
  assert.deepEqual(
    observations
      .filter(({ type }) => type !== "progress")
      .map(({ type, failureClass }) => [type, failureClass]),
    [
      ["started", undefined],
      ["failed", "provider-capacity"],
      ["retry-scheduled", "provider-capacity"],
      ["started", undefined],
      ["completed", undefined],
    ],
  );

  const compile = claudeModel(overloaded);
  await assert.rejects(
    compile.model.generateStructured(compileInput()),
    CompletedModelInvocationError,
  );
  assert.equal(compile.calls.length, 1);

  // A runtime that dies before reporting a result is not a provider verdict.
  const lost = claudeModel(() => new Error("Claude Code process exited"));
  await assert.rejects(
    lost.model.reviewGraph(graphReviewInput()),
    (error) =>
      /process exited/.test(error.message) &&
      !(error instanceof CompletedModelInvocationError),
  );
  const truncated = claudeModel((prompt, options) =>
    answered(prompt, options).slice(0, 2),
  );
  await assert.rejects(
    truncated.model.reviewGraph(graphReviewInput()),
    (error) =>
      /without turn.completed/.test(error.message) &&
      !(error instanceof CompletedModelInvocationError),
  );
});

test("an idle Claude session times out and aborts the Agent SDK query", async () => {
  let aborted;
  const model = new ClaudePlanningModel(claudePlanning, {
    providerTurnIdleTimeoutMs: 20,
    query: ({ options }) =>
      (async function* () {
        await new Promise((resolve) =>
          options.abortController.signal.addEventListener("abort", resolve),
        );
        aborted = options.abortController.signal.aborted;
        yield* [];
      })(),
  });
  await assert.rejects(
    model.generateStructured(compileInput()),
    ProviderTurnTimeoutError,
  );
  assert.equal(aborted, true);
});

test("configuration validates Claude planning and composition needs no API key", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-planning-"));
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/claude-planning");
    config.planning = structuredClone(claudePlanning);
    assert.deepEqual(validateConfig(config).planning, config.planning);
    for (const [change, pattern] of [
      [(p) => (p.kind = "claude-api"), /Unsupported planning model/],
      [(p) => (p.credentialEnv = "ANTHROPIC_API_KEY"), /planning/],
      [(p) => (p.maxOutputTokens = 0), /maxOutputTokens/],
      [
        (p) => (p.planner.reasoningEffort = "ultra"),
        /planning\.planner\.reasoningEffort is unsupported/,
      ],
      [(p) => (p.reviewer.model = " "), /planning\.reviewer\.model/],
    ]) {
      const invalid = structuredClone(config);
      change(invalid.planning);
      assert.throws(() => validateConfig(invalid), pattern);
    }
    assert.equal(typeof composePlanning(config).planObjective, "function");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup writes explicit Claude planning selections and a first run checks the login", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-install-"));
  try {
    const { checkout } = createTarget(root);
    factoryConfig(checkout, "example/claude-install");
    const cli = resolve(import.meta.dirname, "../dist/cli.js");
    const install = (configPath, extra) =>
      execFileSync(
        process.execPath,
        [
          cli,
          "setup",
          "--config-only",
          "--repository",
          "example/claude-install",
          "--checkout",
          checkout,
          "--concurrency",
          "1",
          "--planning",
          "claude-agent-sdk",
          ...extra,
          "--config",
          configPath,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
        },
      );
    // Setup reports a refused choice as a blocked document on stdout.
    assert.throws(
      () => install(join(root, "missing.json"), []),
      (error) =>
        error.status === 1 &&
        /requires --planning-model and --review-model/.test(
          JSON.parse(error.stdout.toString()).blocked.detail,
        ),
    );
    const configPath = join(root, "factory.json");
    install(configPath, [
      "--planning-model",
      "claude-opus-5-5",
      "--review-model",
      "claude-sonnet-5-5",
      "--review-reasoning",
      "xhigh",
    ]);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).planning, {
      kind: "claude-agent-sdk",
      maxOutputTokens: 64000,
      planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
      reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "xhigh" },
    });

    // A first run asks the pinned runtime, model-free, whether a login exists.
    const emptyLogin = join(root, "claude-config");
    mkdirSync(emptyLogin);
    const first = spawnSync(
      process.execPath,
      [cli, "run", "--objective", "1", "--config", configPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_STATE_HOME: join(root, "state"),
          CLAUDE_CONFIG_DIR: emptyLogin,
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        },
      },
    );
    assert.equal(first.status, 2, first.stderr);
    assert.match(
      first.stdout,
      /Objective #1 waits before it starts: .*claude auth login/,
    );
    assert.match(first.stdout, /\nFix: Run `claude auth login` on this host/);
    assert.match(first.stdout, /run `factory run --objective 1` again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude attempt that cannot create its private directory leaves no timer", async () => {
  const saved = process.env.TMPDIR;
  const timers = () =>
    process.getActiveResourcesInfo().filter((name) => name === "Timeout")
      .length;
  const before = timers();
  process.env.TMPDIR = join(tmpdir(), "factory-missing-tmp", "nested");
  try {
    const { model, calls } = claudeModel(answered);
    await assert.rejects(model.reviewGraph(graphReviewInput()), /ENOENT/);
    assert.equal(calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.equal(timers(), before);
});
