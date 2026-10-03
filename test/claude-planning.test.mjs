import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { Codex } from "@openai/codex-sdk";
import {
  ClaudePlanningModel,
  claudeMessageUsage,
  claudeOutputSchema,
} from "../dist/claude-planning.js";
import {
  CodexPlanningModel,
  MalformedPlannerOutput,
  planningReviewEvidence,
} from "../dist/compiler.js";
import { validateConfig } from "../dist/config.js";
import { CompletedModelInvocationError } from "../dist/contracts.js";
import { compose, composePlanning } from "../dist/index.js";
import { reviewPacket } from "../dist/review-evidence.js";
import { compilerRequest, compilerResponse } from "./support/compiler-wire.mjs";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const baseSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const claudePlanning = {
  kind: "claude-api",
  credentialEnv: "ANTHROPIC_API_KEY",
  maxOutputTokens: 64000,
  planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
  reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "medium" },
};

function message(text, overrides = {}) {
  return {
    id: "msg_planning",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 4 },
    },
    ...overrides,
  };
}

/** Scripted Messages API boundary: each call answers from `respond(params)`. */
function stubClient(respond) {
  const calls = [];
  return {
    calls,
    client: {
      messages: {
        stream(params, options) {
          calls.push({ params, options });
          const outcome = respond(params, calls.length - 1);
          return {
            async *[Symbol.asyncIterator]() {
              if (outcome instanceof Error) throw outcome;
              yield {
                type: "message_start",
                message: { ...outcome, content: [] },
              };
              yield { type: "message_stop" };
            },
            async finalMessage() {
              if (outcome instanceof Error) throw outcome;
              return outcome;
            },
          };
        },
      },
    },
  };
}

function claudeModel(respond, options = {}) {
  const stub = stubClient(respond);
  return {
    ...stub,
    model: new ClaudePlanningModel(claudePlanning, "unused-key", {
      client: stub.client,
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
    return JSON.stringify(compilerResponse(prompt));
  if (prompt.startsWith("Return only the requested diagnostic JSON"))
    return JSON.stringify({ decision: "stop" });
  return JSON.stringify({ packetId: "packet", findings: [] });
}

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

test("Claude planning sends the Codex prompts and schemas and decodes identically", async (t) => {
  const codexCalls = [];
  t.mock.method(Codex.prototype, "startThread", (options) => ({
    id: "thread",
    async runStreamed(prompt, { outputSchema }) {
      codexCalls.push({ options, prompt, schema: outputSchema });
      async function* events() {
        yield {
          type: "item.completed",
          item: { id: "m", type: "agent_message", text: answer(prompt) },
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

  const { model, calls } = claudeModel((params) =>
    message(answer(params.messages[0].content)),
  );
  const claudeResults = await runAllPhases(model);

  assert.deepEqual(claudeResults, codexResults);
  assert.equal(calls.length, codexCalls.length);
  for (const [index, call] of calls.entries()) {
    const codex = codexCalls[index];
    assert.deepEqual(call.params.messages, [
      { role: "user", content: codex.prompt },
    ]);
    assert.deepEqual(call.params.output_config.format, {
      type: "json_schema",
      schema: claudeOutputSchema(codex.schema),
    });
    assert.deepEqual(call.params.thinking, { type: "adaptive" });
    assert.equal(call.params.max_tokens, 64000);
    assert.equal(call.params.tools, undefined);
    assert.ok(call.options.signal instanceof AbortSignal);
    assertClaudeSchemaSubset(call.params.output_config.format.schema);
  }
  // Compile and diagnosis use the planner; every review uses the reviewer.
  assert.deepEqual(
    calls.map(({ params }) => [params.model, params.output_config.effort]),
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

test("Claude usage is observed in cache-inclusive token categories", async () => {
  assert.deepEqual(claudeMessageUsage(message("{}").usage), {
    inputTokens: 15,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 4,
  });
  assert.deepEqual(
    claudeMessageUsage({
      input_tokens: 7,
      output_tokens: 1,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    }),
    { inputTokens: 7, outputTokens: 1 },
  );
  const observations = [];
  const { model } = claudeModel((params) =>
    message(answer(params.messages[0].content)),
  );
  await model.reviewGraph({
    ...graphReviewInput(),
    invocation: {
      invocationId: "review",
      phase: "graph-review",
      ordinal: 0,
      observe: (event) => observations.push(event),
    },
  });
  const started = observations.find(({ type }) => type === "started");
  assert.equal(started.adapter, "@anthropic-ai/sdk@0.129.0");
  assert.equal(started.provider, "anthropic-claude-api");
  assert.equal(started.model, "claude-sonnet-5-5");
  assert.equal(started.reasoningEffort, "medium");
  const usageCapture = observations.find(
    ({ capture }) => capture?.event.kind === "usage",
  );
  assert.deepEqual(usageCapture.capture.event.usage.raw, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  });
  const completed = observations.find(({ type }) => type === "completed");
  assert.equal(completed.providerThreadId, "msg_planning");
  assert.equal(completed.usageAvailable, true);
  assert.deepEqual(completed.usage, {
    inputTokens: 15,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 4,
  });
});

test("malformed Claude output fails closed as MalformedPlannerOutput", async () => {
  const observations = [];
  const invocation = (phase) => ({
    invocationId: phase,
    phase,
    ordinal: 0,
    observe: (event) => observations.push(event),
  });
  const unparsable = claudeModel(() => message('{"packetId": "packet"'));
  await assert.rejects(
    unparsable.model.reviewResult({
      ...resultReviewInput(),
      invocation: invocation("result-review"),
    }),
    MalformedPlannerOutput,
  );
  const invalid = observations.find(({ type }) => type === "response-invalid");
  assert.equal(invalid.failureClass, "structured-output-parse");
  assert.equal(invalid.usageAvailable, true);

  // Schema-valid JSON for another request is still rejected by the decoder.
  const foreign = claudeModel((params) =>
    message(
      JSON.stringify({
        ...compilerResponse(params.messages[0].content),
        contextId: "f".repeat(64),
      }),
    ),
  );
  await assert.rejects(
    foreign.model.generateStructured({
      ...compileInput(),
      invocation: invocation("compile"),
    }),
    (error) =>
      error instanceof MalformedPlannerOutput &&
      /context identity/.test(error.message),
  );
});

test("Claude refusals and truncation are completed invocations, never accepted output", async () => {
  for (const [stop, failureClass] of [
    ["refusal", "provider-refusal"],
    ["max_tokens", "provider-incomplete"],
  ]) {
    const observations = [];
    const { model } = claudeModel(() =>
      message('{"packetId": "packet", "findings": []}', {
        stop_reason: stop,
        stop_details:
          stop === "refusal"
            ? { type: "refusal", category: "cyber", explanation: null }
            : null,
      }),
    );
    await assert.rejects(
      model.reviewGraph({
        ...graphReviewInput(),
        invocation: {
          invocationId: stop,
          phase: "graph-review",
          ordinal: 0,
          observe: (event) => observations.push(event),
        },
      }),
      (error) =>
        error instanceof CompletedModelInvocationError &&
        !(error instanceof MalformedPlannerOutput) &&
        error.message.includes(stop),
    );
    const failed = observations.find(({ type }) => type === "failed");
    assert.equal(failed.failureClass, failureClass);
    assert.equal(failed.usageAvailable, true);
  }
});

test("Claude overload retries only reviews; a lost connection stays ambiguous", async () => {
  const overloaded = () =>
    new APIError(
      529,
      { type: "error", error: { type: "overloaded_error", message: "x" } },
      "Overloaded",
      new Headers(),
      "overloaded_error",
    );
  const observations = [];
  const review = claudeModel((params, index) =>
    index === 0 ? overloaded() : message(answer(params.messages[0].content)),
  );
  assert.deepEqual(
    await review.model.reviewGraph({
      ...graphReviewInput(),
      invocation: {
        invocationId: "review",
        phase: "graph-review",
        ordinal: 0,
        observe: (event) => observations.push(event),
      },
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

  const compile = claudeModel(() => overloaded());
  await assert.rejects(
    compile.model.generateStructured(compileInput()),
    CompletedModelInvocationError,
  );
  assert.equal(compile.calls.length, 1);

  const lost = claudeModel(
    () => new APIConnectionError({ message: "socket hang up" }),
  );
  await assert.rejects(
    lost.model.reviewGraph(graphReviewInput()),
    (error) =>
      error instanceof APIConnectionError &&
      !(error instanceof CompletedModelInvocationError),
  );
});

test("configuration validates Claude planning and composition requires its credential", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-planning-"));
  const saved = process.env.FACTORY_TEST_CLAUDE_KEY;
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/claude-planning");
    config.planning = {
      ...structuredClone(claudePlanning),
      credentialEnv: "FACTORY_TEST_CLAUDE_KEY",
    };
    assert.deepEqual(validateConfig(config).planning, config.planning);
    for (const [change, pattern] of [
      [(p) => (p.kind = "claude"), /Unsupported planning model/],
      [(p) => (p.extra = true), /planning/],
      [(p) => (p.credentialEnv = "lower"), /credentialEnv/],
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
    delete process.env.FACTORY_TEST_CLAUDE_KEY;
    assert.throws(
      () => composePlanning(config),
      /Set FACTORY_TEST_CLAUDE_KEY in the controller environment/,
    );
    process.env.FACTORY_TEST_CLAUDE_KEY = "test-key";
    assert.equal(typeof composePlanning(config).planObjective, "function");

    // A supervised service reads the systemd-loaded file, never the ambient value.
    const loaded = join(root, "loaded");
    process.env.CREDENTIALS_DIRECTORY = loaded;
    assert.throws(
      () => compose(config, []),
      /binding lacks FACTORY_TEST_CLAUDE_KEY/,
    );
    assert.throws(
      () => compose(config, ["FACTORY_TEST_CLAUDE_KEY"]),
      /FACTORY_TEST_CLAUDE_KEY is unavailable/,
    );
    rmSync(loaded, { recursive: true, force: true });
    mkdirSync(loaded);
    writeFileSync(join(loaded, "FACTORY_TEST_CLAUDE_KEY"), "loaded-key", {
      mode: 0o600,
    });
    assert.equal(
      typeof compose(config, ["FACTORY_TEST_CLAUDE_KEY"]).runObjective,
      "function",
    );
  } finally {
    if (saved === undefined) delete process.env.FACTORY_TEST_CLAUDE_KEY;
    else process.env.FACTORY_TEST_CLAUDE_KEY = saved;
    delete process.env.CREDENTIALS_DIRECTORY;
    rmSync(root, { recursive: true, force: true });
  }
});

test("install writes explicit Claude planning selections", () => {
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
          "install",
          "--repository",
          "example/claude-install",
          "--checkout",
          checkout,
          "--concurrency",
          "1",
          "--planning",
          "claude-api",
          ...extra,
          "--config",
          configPath,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
        },
      );
    assert.throws(
      () => install(join(root, "missing.json"), []),
      /requires --planning-model and --review-model/,
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
      kind: "claude-api",
      credentialEnv: "ANTHROPIC_API_KEY",
      maxOutputTokens: 64000,
      planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
      reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "xhigh" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
