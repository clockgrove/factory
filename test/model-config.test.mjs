import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel, graphSchemaForSources } from "../dist/compiler.js";
import * as configModule from "../dist/config.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../dist/controller-capabilities.js";
import { codexWorkerInput } from "../dist/execution/local.js";
import { runCodexWorker } from "../dist/execution/worker.js";
import { summarizeDiagnosticUsage } from "../dist/diagnostics.js";
import * as publicModule from "../dist/index.js";
import {
  bindTarget,
  createTarget,
  factoryConfig,
} from "./support/integration-fixture.mjs";

const {
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  validateConfig,
} = configModule;

function structuredOutputSchemaBudget(schema) {
  const budget = { objectProperties: 0, enumValues: 0 };
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.properties && typeof value.properties === "object") {
      budget.objectProperties += Object.keys(value.properties).length;
    }
    if (Array.isArray(value.enum)) budget.enumValues += value.enum.length;
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return budget;
}

test("package root exports only role-specific model defaults", () => {
  assert.equal(
    Object.hasOwn(publicModule, "DEFAULT_CODEX_MODEL_SELECTION"),
    false,
  );
  assert.equal(
    publicModule.DEFAULT_PLANNER_MODEL_SELECTION,
    DEFAULT_PLANNER_MODEL_SELECTION,
  );
  assert.equal(
    publicModule.DEFAULT_REVIEWER_MODEL_SELECTION,
    DEFAULT_REVIEWER_MODEL_SELECTION,
  );
  assert.equal(
    publicModule.DEFAULT_WORKER_MODEL_SELECTION,
    DEFAULT_WORKER_MODEL_SELECTION,
  );
});

test("configuration requires explicit selectable Codex models and reasoning", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-config-"));
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/model-config");
    config.planning.planner = {
      model: "operator/planner-model",
      reasoningEffort: "low",
    };
    config.planning.reviewer = {
      model: "operator/reviewer-model",
      reasoningEffort: "ultra",
    };
    config.execution.harness = {
      kind: "codex-sdk",
      model: "operator/worker-model",
      reasoningEffort: "persistent",
    };
    const validated = validateConfig(config);
    assert.deepEqual(validated.planning, config.planning);
    assert.deepEqual(validated.execution.harness, config.execution.harness);

    const missing = structuredClone(config);
    delete missing.planning.reviewer;
    assert.throws(
      () => validateConfig(missing),
      /planning\.reviewer must be an object/,
    );
    const empty = structuredClone(config);
    empty.execution.harness.model = "  ";
    assert.throws(
      () => validateConfig(empty),
      /execution\.harness\.model must be a non-empty string/,
    );
    const unsupported = structuredClone(config);
    unsupported.planning.planner.reasoningEffort = "ambient";
    assert.throws(
      () => validateConfig(unsupported),
      /planning\.planner\.reasoningEffort is unsupported/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install flags persist independent planner, reviewer, and worker selections", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-install-"));
  try {
    const target = createTarget(root);
    bindTarget(target.checkout, "example/model-install");
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "install",
        "--repository",
        "example/model-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--planning-model",
        "planner-choice",
        "--planning-reasoning",
        "high",
        "--review-model",
        "reviewer-choice",
        "--review-reasoning",
        "medium",
        "--worker-model",
        "worker-choice",
        "--worker-reasoning",
        "low",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          XDG_STATE_HOME: join(root, "state"),
        },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.planning.planner, {
      model: "planner-choice",
      reasoningEffort: "high",
    });
    assert.deepEqual(config.planning.reviewer, {
      model: "reviewer-choice",
      reasoningEffort: "medium",
    });
    assert.deepEqual(config.execution.harness, {
      kind: "codex-sdk",
      model: "worker-choice",
      reasoningEffort: "low",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install resolves Factory-owned role defaults and isolates one-role overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-defaults-"));
  const scenarios = [
    {
      name: "defaults",
      flags: [],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "planner",
      flags: ["--planning-model", "planner-choice"],
      planner: { model: "planner-choice", reasoningEffort: "medium" },
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "reviewer",
      flags: ["--review-reasoning", "high"],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "worker",
      flags: ["--worker-model", "worker-choice"],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: { model: "worker-choice", reasoningEffort: "medium" },
    },
  ];
  try {
    for (const scenario of scenarios) {
      const scenarioRoot = join(root, scenario.name);
      mkdirSync(scenarioRoot, { recursive: true });
      const target = createTarget(scenarioRoot);
      bindTarget(target.checkout, `example/model-${scenario.name}`);
      const configPath = join(scenarioRoot, "config", "factory.json");
      execFileSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../dist/cli.js"),
          "install",
          "--repository",
          `example/model-${scenario.name}`,
          "--checkout",
          target.checkout,
          "--concurrency",
          "1",
          ...scenario.flags,
          "--config",
          configPath,
        ],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            XDG_STATE_HOME: join(scenarioRoot, "state"),
          },
        },
      );
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(config.planning.planner, scenario.planner);
      assert.deepEqual(config.planning.reviewer, scenario.reviewer);
      assert.deepEqual(config.execution.harness, {
        kind: "codex-sdk",
        ...scenario.worker,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter passes phase selections to every planning and review thread", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function (options) {
    const index = captured.length;
    const entry = { options, id: `thread-${index}` };
    captured.push(entry);
    return {
      get id() {
        return entry.id;
      },
      async runStreamed(prompt, options) {
        entry.prompt = prompt;
        entry.outputSchema = options.outputSchema;
        async function* events() {
          yield { type: "thread.started", thread_id: entry.id };
          yield { type: "turn.started" };
          yield {
            type: "item.started",
            item: {
              id: `command-${index}`,
              type: "command_execution",
              command: "printf private-command-marker",
              aggregated_output: "private-command-output",
              status: "in_progress",
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text:
                index === 0
                  ? JSON.stringify({
                      objective: 1,
                      baseSha: "a".repeat(40),
                      items: [{ citations: [{ choiceIndex: 3 }] }],
                    })
                  : JSON.stringify({ findings: [] }),
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 100 + index,
              cached_input_tokens: 50 + index,
              cache_write_input_tokens: 3 + index,
              output_tokens: 20 + index,
              reasoning_output_tokens: 7 + index,
            },
          };
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const baseSha = "a".repeat(40);
    const observations = [];
    const invocation = (phase, ordinal) => ({
      invocationId: `${phase}-${ordinal}`,
      phase,
      ordinal,
      observe: (event) => observations.push(event),
    });
    const compileSources = [
      {
        path: "OBJECTIVE",
        content:
          "# Objective\n\n## Acceptance\nRequired\n\n## Cost ($5)? [draft] | exact.*\nLiteral heading",
      },
      {
        path: "AGENTS.md",
        content: "# Disposable target instructions\n\nFollow the Objective.",
      },
    ];
    const compiled = await model.generateStructured({
      objective: "private-objective-marker",
      baseSha,
      sources: compileSources,
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      schema: graphSchemaForSources(compileSources),
      invocation: invocation("compile", 0),
    });
    assert.deepEqual(compiled.items[0].citations, [
      { path: "OBJECTIVE", heading: "Cost ($5)? [draft] | exact.*" },
    ]);
    await model.reviewGraph({
      objective: "Objective",
      baseSha,
      sources: [
        {
          path: "OBJECTIVE",
          content: "# Objective\n\n## Acceptance\nRequired",
        },
        {
          path: "docs/plan.md",
          heading: "Wave 0",
          content: "## Wave 0\nCanonical plan",
        },
        {
          path: "OBJECTIVE",
          content: "# Objective\n\n## Boundaries\nNo deployment",
        },
      ],
      graph: { objective: 1, baseSha, items: [] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      invocation: invocation("graph-review", 0),
    });
    const treeSha = "b".repeat(40);
    await model.reviewResult({
      criteria: ["Criterion"],
      baseSha,
      treeSha,
      sources: [],
      change: "{}",
      evidence: [
        {
          path: "Work Item Git delta: one",
          content: "supervisor item delta",
        },
      ],
      commands: [
        {
          index: 0,
          command: "test -f result.txt",
          passed: true,
          exitCode: 0,
          treeSha,
        },
      ],
      invocation: invocation("result-review", 0),
    });
    assert.deepEqual(
      captured.map(({ options }) => ({
        model: options.model,
        modelReasoningEffort: options.modelReasoningEffort,
      })),
      [
        { model: "planner-choice", modelReasoningEffort: "high" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
      ],
    );
    assert.deepEqual(
      captured[1].outputSchema.properties.findings.items.properties.source,
      { type: "string", enum: ["OBJECTIVE", "docs/plan.md"] },
    );
    const compileCitationSchema =
      captured[0].outputSchema.properties.items.items.properties.citations
        .items;
    assert.deepEqual(compileCitationSchema, {
      type: "object",
      properties: {
        choiceIndex: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description:
            "Exact zero-based index from the supplied citation choice list.",
        },
      },
      required: ["choiceIndex"],
      additionalProperties: false,
    });
    assert.match(
      captured[0].prompt,
      /set choiceIndex to exactly one index from this supplied citation choice JSON list/,
    );
    assert.ok(
      captured[0].prompt.includes(
        '"choiceIndex":3,"path":"OBJECTIVE","heading":"Cost ($5)? [draft] | exact.*"',
      ),
    );
    assert.doesNotMatch(captured[0].prompt, /Do not add a Markdown marker/);
    assert.match(
      captured[0].prompt,
      /exact bare Markdown heading text without # markers/,
    );
    assert.match(
      captured[0].prompt,
      /resource name as an exact, whitespace-sensitive scheduling identity/,
    );
    assert.match(
      captured[0].prompt,
      /Reproduce any source-declared resource name exactly/,
    );
    assert.match(
      captured[0].prompt,
      /planner-authored resource name, avoid accidental leading or trailing whitespace/,
    );
    assert.match(
      captured[0].outputSchema.properties.items.items.properties.resources.items
        .description,
      /Exact, whitespace-sensitive resource identity/,
    );
    assert.match(
      captured[1].prompt,
      /set source to exactly one value from this supplied-path JSON list/,
    );
    assert.match(captured[1].prompt, /\["OBJECTIVE","docs\/plan\.md"\]/);
    assert.match(
      captured[1].prompt,
      /Do not append a heading, section name, separator, or explanation/,
    );
    assert.match(captured[1].prompt, /return exactly \{"findings":\[\]\}/);
    assert.match(captured[0].prompt, /immutable supervisor guarantees/);
    assert.match(
      captured[0].prompt,
      /candidate staging, manifest declaration, and completion boundary/,
    );
    assert.match(
      captured[0].prompt,
      /immutable bytes or candidate variation only when required/,
    );
    assert.match(
      captured[0].prompt,
      /Do not instruct media workers to run installed Factory CLI operations/,
    );
    assert.match(captured[0].prompt, /do not infer a copy-only task/);
    assert.match(
      captured[0].prompt,
      new RegExp(CONTROLLER_CAPABILITIES_DIGEST),
    );
    assert.match(
      captured[1].prompt,
      /immutable Factory controller capabilities/,
    );
    assert.match(
      captured[1].prompt,
      new RegExp(CONTROLLER_CAPABILITIES_DIGEST),
    );
    assert.match(
      captured[1].prompt,
      /do not emit advisory observations, confirmations, or speculative questions/,
    );
    assert.equal(
      captured[1].outputSchema.properties.findings.description,
      "Return [] exactly when the plan has no material source-grounded defect.",
    );
    assert.match(captured[2].prompt, /result identity is a Git tree/);
    assert.match(captured[2].prompt, /stable zero-based index/);
    assert.match(captured[2].prompt, /Work Item Git delta: one/);
    assert.match(captured[2].prompt, /supervisor item delta/);
    assert.match(captured[2].prompt, /Controller hydration receipt/);
    assert.match(captured[2].prompt, new RegExp(treeSha));
    for (const [index, phase] of [
      "compile",
      "graph-review",
      "result-review",
    ].entries()) {
      const events = observations.filter((event) => event.phase === phase);
      assert.equal(events[0].type, "started");
      assert.ok(events.some((event) => event.type === "progress"));
      assert.ok(
        events.some(
          (event) =>
            event.providerItemType === "command_execution" &&
            event.tool === "shell",
        ),
      );
      assert.equal(events.at(-1).type, "completed");
      assert.equal(events.at(-1).providerThreadId, `thread-${index}`);
      assert.deepEqual(events.at(-1).usage, {
        inputTokens: 100 + index,
        cachedInputTokens: 50 + index,
        cacheWriteInputTokens: 3 + index,
        outputTokens: 20 + index,
        reasoningOutputTokens: 7 + index,
      });
      assert.equal(events.at(-1).usageAvailable, true);
      assert.equal(
        events[0].model,
        index ? "reviewer-choice" : "planner-choice",
      );
      assert.equal(events[0].reasoningEffort, index ? "medium" : "high");
      assert.equal(typeof events[0].promptDigest, "string");
      assert.equal(typeof events[0].sourcePacketDigest, "string");
    }
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-objective-marker|private-source-marker|supervisor item delta/,
    );
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-command-marker|private-command-output/,
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex citation indexes preserve exact headings without schema-budget growth", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  const returnedChoiceIndexes = [1, 1_000];
  Codex.prototype.startThread = function () {
    const index = captured.length;
    const entry = { index };
    captured.push(entry);
    return {
      id: `citation-budget-${index}`,
      async runStreamed(prompt, options) {
        entry.prompt = prompt;
        entry.outputSchema = options.outputSchema;
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `citation-budget-${index}`,
          };
          yield { type: "turn.started" };
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text: JSON.stringify({
                objective: 1,
                baseSha: "a".repeat(40),
                items: [
                  {
                    citations:
                      index === 2
                        ? [{ choiceIndex: 1, heading: "One heading\n" }]
                        : [{ choiceIndex: returnedChoiceIndexes[index] }],
                  },
                ],
              }),
            },
          };
          yield { type: "turn.completed", usage: null };
        }
        return { events: events() };
      },
    };
  };
  try {
    const specialHeading = "Cost ($5)? [draft] | exact.*";
    const headings = [
      specialHeading,
      ...Array.from({ length: 999 }, (_, index) => `Heading ${index}`),
    ];
    const sourcePackets = [
      [{ path: "docs/many.md", content: "## One heading\nbody" }],
      [
        {
          path: "docs/many.md",
          content: headings.map((heading) => `## ${heading}\nbody`).join("\n"),
        },
      ],
    ];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const decoded = [];
    for (const sources of sourcePackets) {
      decoded.push(
        await model.generateStructured({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources,
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: graphSchemaForSources(sources),
        }),
      );
    }
    assert.deepEqual(decoded[0].items[0].citations, [
      { path: "docs/many.md", heading: "One heading" },
    ]);
    assert.deepEqual(decoded[1].items[0].citations, [
      { path: "docs/many.md", heading: "Heading 998" },
    ]);
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: sourcePackets[0],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: graphSchemaForSources(sourcePackets[0]),
      }),
      /citation choice must contain only choiceIndex/,
    );
    assert.ok(captured[1].prompt.includes(specialHeading));
    assert.ok(
      captured[1].prompt.includes(
        '"choiceIndex":1000,"path":"docs/many.md","heading":"Heading 998"',
      ),
    );

    const smallBudget = structuredOutputSchemaBudget(captured[0].outputSchema);
    const headingHeavyBudget = structuredOutputSchemaBudget(
      captured[1].outputSchema,
    );
    assert.deepEqual(headingHeavyBudget, smallBudget);
    assert.deepEqual(headingHeavyBudget, {
      objectProperties: 27,
      enumValues: 7,
    });
    assert.equal(
      JSON.stringify(captured[1].outputSchema).length -
        JSON.stringify(captured[0].outputSchema).length,
      3,
      "only the decimal width of the maximum choice index may grow",
    );
    assert.ok(
      headingHeavyBudget.objectProperties <= 5_000,
      "official Structured Outputs object-property budget",
    );
    assert.ok(
      headingHeavyBudget.enumValues <= 1_000,
      "official Structured Outputs total-enum budget",
    );
    const citationSchema =
      captured[1].outputSchema.properties.items.items.properties.citations
        .items;
    assert.deepEqual(citationSchema.properties.choiceIndex, {
      type: "integer",
      minimum: 0,
      maximum: 1_000,
      description:
        "Exact zero-based index from the supplied citation choice list.",
    });
    assert.equal(Object.hasOwn(citationSchema.properties, "heading"), false);
    assert.equal(Object.hasOwn(citationSchema.properties, "path"), false);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter reports unavailable usage, malformed output, and provider failure", async () => {
  const original = Codex.prototype.startThread;
  let call = 0;
  Codex.prototype.startThread = function () {
    const index = call++;
    if (index === 4) throw new Error("provider capacity unavailable");
    return {
      get id() {
        return `failure-thread-${index}`;
      },
      async runStreamed() {
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `failure-thread-${index}`,
          };
          if (index === 0) {
            yield {
              type: "item.completed",
              item: { id: "bad", type: "agent_message", text: "not json" },
            };
            yield { type: "turn.completed", usage: null };
          } else if (index === 1) {
            yield { type: "error", message: "429 rate limit reached" };
          } else {
            yield {
              type: "item.completed",
              item: {
                id: "clean",
                type: "agent_message",
                text: JSON.stringify({ findings: [] }),
              },
            };
            if (index === 2) yield { type: "turn.completed", usage: null };
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const malformed = [];
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: { type: "object" },
        invocation: {
          invocationId: "malformed",
          phase: "compile",
          ordinal: 0,
          observe: (event) => malformed.push(event),
        },
      }),
      SyntaxError,
    );
    assert.equal(malformed.at(-1).type, "response-invalid");
    assert.equal(malformed.at(-1).failureClass, "structured-output-parse");
    assert.equal(malformed.at(-1).usageAvailable, false);
    assert.equal(
      malformed.some((event) => event.type === "failed"),
      false,
    );

    const failed = [];
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        invocation: {
          invocationId: "provider-failure",
          phase: "graph-review",
          ordinal: 0,
          observe: (event) => failed.push(event),
        },
      }),
      /429 rate limit/,
    );
    assert.equal(failed.at(-1).type, "failed");
    assert.equal(failed.at(-1).failureClass, "provider-rate-limit");
    assert.equal(failed.at(-1).usageAvailable, false);

    const unavailable = [];
    await model.reviewGraph({
      objective: "objective",
      baseSha: "a".repeat(40),
      sources: [{ path: "OBJECTIVE", content: "objective" }],
      graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      invocation: {
        invocationId: "usage-unavailable",
        phase: "graph-review",
        ordinal: 1,
        observe: (event) => unavailable.push(event),
      },
    });
    assert.equal(unavailable.at(-1).type, "completed");
    assert.equal(unavailable.at(-1).usageAvailable, false);
    assert.equal(unavailable.at(-1).usage, undefined);

    const interrupted = [];
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        invocation: {
          invocationId: "provider-interrupted",
          phase: "graph-review",
          ordinal: 2,
          observe: (event) => interrupted.push(event),
        },
      }),
      /without turn\.completed/,
    );
    assert.equal(interrupted.at(-1).type, "failed");
    assert.equal(interrupted.at(-1).failureClass, "provider-interrupted");
    assert.equal(interrupted.at(-1).usageAvailable, false);

    const setupFailure = [];
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: { type: "object" },
        invocation: {
          invocationId: "setup-failure",
          phase: "graph-review",
          ordinal: 1,
          observe: (event) => setupFailure.push(event),
        },
      }),
      /capacity unavailable/,
    );
    assert.deepEqual(
      setupFailure.map((event) => event.type),
      ["started", "failed"],
    );
    assert.equal(setupFailure.at(-1).failureClass, "provider-capacity");
    assert.ok(setupFailure.every((event) => event.phase === "compile"));
    assert.ok(setupFailure.every((event) => event.providerMaxAttempts === 1));
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter retries review capacity with the exact request and explicit attempt diagnostics", async () => {
  const original = Codex.prototype.startThread;
  const calls = [];
  let call = 0;
  Codex.prototype.startThread = function (options) {
    const index = call++;
    return {
      id: `capacity-thread-${index}`,
      async runStreamed(prompt, runOptions) {
        calls.push({
          prompt,
          outputSchema: runOptions.outputSchema,
          model: options.model,
          reasoningEffort: options.modelReasoningEffort,
        });
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `capacity-thread-${index}`,
          };
          if (index === 0) {
            yield {
              type: "turn.failed",
              error: {
                message:
                  "Selected model is at capacity. Please try a different model.",
              },
            };
            return;
          }
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text: JSON.stringify({ findings: [] }),
            },
          };
          yield { type: "turn.completed", usage: null };
        }
        return { events: events() };
      },
    };
  };
  try {
    const waits = [];
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      undefined,
      {
        reviewCapacityRetryDelaysMs: [7, 11],
        wait: async (milliseconds) => waits.push(milliseconds),
      },
    );
    const baseSha = "a".repeat(40);
    const result = await model.reviewGraph({
      objective: "objective",
      baseSha,
      sources: [{ path: "OBJECTIVE", content: "objective" }],
      graph: { objective: 1, baseSha, items: [] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      invocation: {
        invocationId: "capacity-then-success",
        phase: "compile",
        ordinal: 0,
        observe: (event) => observations.push(event),
      },
    });
    assert.deepEqual(result, { findings: [] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].prompt, calls[1].prompt);
    assert.deepEqual(calls[0].outputSchema, calls[1].outputSchema);
    assert.deepEqual(
      calls.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })),
      [
        { model: "reviewer-choice", reasoningEffort: "medium" },
        { model: "reviewer-choice", reasoningEffort: "medium" },
      ],
    );
    assert.deepEqual(waits, [7]);
    assert.ok(observations.every((event) => event.phase === "graph-review"));
    assert.deepEqual(
      observations
        .filter((event) =>
          ["started", "failed", "retry-scheduled", "completed"].includes(
            event.type,
          ),
        )
        .map((event) => ({
          type: event.type,
          attempt: event.providerAttempt,
          maxAttempts: event.providerMaxAttempts,
          retryDelayMs: event.retryDelayMs,
          failureClass: event.failureClass,
        })),
      [
        {
          type: "started",
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: undefined,
        },
        {
          type: "failed",
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: "provider-capacity",
        },
        {
          type: "retry-scheduled",
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: 7,
          failureClass: "provider-capacity",
        },
        {
          type: "started",
          attempt: 2,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: undefined,
        },
        {
          type: "completed",
          attempt: 2,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: undefined,
        },
      ],
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter exhausts bounded capacity retries for final review without changing policy", async () => {
  const original = Codex.prototype.startThread;
  const calls = [];
  Codex.prototype.startThread = function (options) {
    const index = calls.length;
    return {
      id: `exhausted-thread-${index}`,
      async runStreamed(prompt, runOptions) {
        calls.push({
          prompt,
          outputSchema: runOptions.outputSchema,
          model: options.model,
          reasoningEffort: options.modelReasoningEffort,
        });
        async function* events() {
          yield {
            type: "turn.failed",
            error: { message: "provider temporarily unavailable at capacity" },
          };
        }
        return { events: events() };
      },
    };
  };
  try {
    const waits = [];
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      undefined,
      {
        reviewCapacityRetryDelaysMs: [3, 5],
        wait: async (milliseconds) => waits.push(milliseconds),
      },
    );
    const treeSha = "b".repeat(40);
    await assert.rejects(
      model.reviewResult({
        reviewPhase: "objective-review",
        criteria: ["Criterion"],
        baseSha: "a".repeat(40),
        treeSha,
        sources: [{ path: "OBJECTIVE", content: "Criterion" }],
        change: "{}",
        commands: [],
        invocation: {
          invocationId: "exhausted-capacity",
          phase: "compile",
          ordinal: 0,
          observe: (event) => observations.push(event),
        },
      }),
      /temporarily unavailable at capacity/,
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [3, 5]);
    assert.ok(calls.every((entry) => entry.prompt === calls[0].prompt));
    assert.ok(
      calls.every(
        (entry) =>
          entry.model === "reviewer-choice" &&
          entry.reasoningEffort === "medium",
      ),
    );
    assert.deepEqual(
      observations
        .filter((event) => event.type === "started")
        .map((event) => event.providerAttempt),
      [1, 2, 3],
    );
    assert.deepEqual(
      observations
        .filter((event) => event.type === "retry-scheduled")
        .map((event) => ({
          attempt: event.providerAttempt,
          delay: event.retryDelayMs,
        })),
      [
        { attempt: 1, delay: 3 },
        { attempt: 2, delay: 5 },
      ],
    );
    assert.equal(
      observations.filter((event) => event.type === "failed").length,
      3,
    );
    assert.ok(
      observations.every((event) => event.phase === "objective-review"),
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter rejects unbounded review-capacity retry timing", () => {
  const create = (reviewCapacityRetryDelaysMs) =>
    new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      undefined,
      { reviewCapacityRetryDelaysMs },
    );
  assert.throws(() => create([0, 0, 0]), /bounded attempts or delay/);
  assert.throws(() => create([10_001]), /bounded attempts or delay/);
});

test("Codex adapter aborts and records an abort-aware stalled stream", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    return {
      id: "stalled-thread",
      async runStreamed(_prompt, options) {
        async function* events() {
          yield { type: "thread.started", thread_id: "stalled-thread" };
          await new Promise((resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        }
        return { events: events() };
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: { type: "object" },
        invocation: {
          invocationId: "provider-timeout",
          phase: "compile",
          ordinal: 0,
          observe: (event) => observations.push(event),
        },
      }),
      /no progress for 20 ms/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider-timeout");
    assert.equal(observations.at(-1).providerThreadId, "stalled-thread");
    assert.equal(observations.at(-1).usageAvailable, false);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter bounds a stalled stream that ignores abort", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    return {
      id: "noncooperative-thread",
      async runStreamed() {
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: "noncooperative-thread",
          };
          await new Promise(() => {});
        }
        return { events: events() };
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: { type: "object" },
        invocation: {
          invocationId: "provider-timeout-noncooperative",
          phase: "compile",
          ordinal: 0,
          observe: (event) => observations.push(event),
        },
      }),
      /no progress for 20 ms/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider-timeout");
    assert.equal(observations.at(-1).providerThreadId, "noncooperative-thread");
    assert.equal(observations.at(-1).usageAvailable, false);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter bounds stalled stream creation", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    return {
      id: "stream-creation-thread",
      async runStreamed() {
        return new Promise(() => {});
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: { type: "object" },
        invocation: {
          invocationId: "provider-stream-creation-timeout",
          phase: "compile",
          ordinal: 0,
          observe: (event) => observations.push(event),
        },
      }),
      /no progress for 20 ms/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider-timeout");
    assert.equal(
      observations.at(-1).providerThreadId,
      "stream-creation-thread",
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter closes provider iterators on completion and failure", async () => {
  const original = Codex.prototype.startThread;
  const closed = [];
  let call = 0;
  Codex.prototype.startThread = function () {
    const index = call++;
    return {
      id: `cleanup-thread-${index}`,
      async runStreamed() {
        async function* events() {
          try {
            yield {
              type: "thread.started",
              thread_id: `cleanup-thread-${index}`,
            };
            if (index === 0) {
              yield {
                type: "item.completed",
                item: {
                  id: "message",
                  type: "agent_message",
                  text: JSON.stringify({ result: "complete" }),
                },
              };
              yield { type: "turn.completed", usage: null };
            } else {
              yield {
                type: "turn.failed",
                error: { message: "provider terminal failure" },
              };
            }
          } finally {
            closed[index] = true;
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      100,
    );
    assert.deepEqual(
      await model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        schema: { type: "object" },
      }),
      { result: "complete" },
    );
    assert.equal(closed[0], true);
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      }),
      /provider terminal failure/,
    );
    assert.equal(closed[1], true);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter preserves terminal failure when iterator cleanup stalls", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    let event = 0;
    return {
      id: "cleanup-stall-thread",
      async runStreamed() {
        return {
          events: {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              event += 1;
              if (event === 1)
                return {
                  done: false,
                  value: {
                    type: "thread.started",
                    thread_id: "cleanup-stall-thread",
                  },
                };
              return {
                done: false,
                value: {
                  type: "turn.failed",
                  error: { message: "authoritative provider failure" },
                },
              };
            },
            async return() {
              return new Promise(() => {});
            },
          },
        };
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        invocation: {
          invocationId: "cleanup-stall",
          phase: "graph-review",
          ordinal: 0,
          observe: (observation) => observations.push(observation),
        },
      }),
      /authoritative provider failure/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider");
    assert.equal(observations.at(-1).detail, "authoritative provider failure");
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex harness private request carries selection and turn timeout", () => {
  const input = codexWorkerInput(
    { attemptId: "attempt-1" },
    "off",
    [],
    {
      model: "worker-choice",
      reasoningEffort: "xhigh",
    },
    1234,
  );
  assert.deepEqual(input.model, {
    model: "worker-choice",
    reasoningEffort: "xhigh",
  });
  assert.equal(input.providerTurnIdleTimeoutMs, 1234);
});

test("actual worker packets preserve media requirements and isolate controller operations", async () => {
  const original = Codex.prototype.startThread;
  const root = mkdtempSync(join(tmpdir(), "factory-worker-packets-"));
  const bytes = Buffer.from("immutable repository source\n");
  const ref = {
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    mediaType: "image/png",
  };
  const scenarios = [
    {
      id: "same-path",
      roles: ["image"],
      count: 1,
      owned: ["assets/source.png"],
      sourcePath: "assets/source.png",
      acceptance: [
        "Copy assets/source.png byte-for-byte into staging for the same destination.",
      ],
      brief:
        "Using installed Factory CLI, preserve the exact source bytes. Report any controller-operation conflict.",
    },
    {
      id: "multi-role",
      roles: ["image", "metadata"],
      count: 2,
      owned: ["assets/result.png", "assets/result.json", "consumer.ts"],
      sourcePath: ".factory-inputs/source-0",
      acceptance: [
        "Stage two complete sets with source-required visual variation and update consumer.ts.",
      ],
      brief:
        "Use the read-only source to create the two requested variants, declare provenance and any authoritative metadata, and update consumer.ts.",
    },
    {
      id: "ordinary",
      roles: [],
      count: 0,
      owned: ["consumer.ts"],
      acceptance: ["consumer.ts exports the requested value."],
      brief:
        "Update consumer.ts using the exact source-declared command npm test.",
    },
  ];
  let scenario;
  let captured;
  let worktree;
  Codex.prototype.startThread = function (options) {
    assert.equal(options.workingDirectory, worktree);
    assert.equal(options.networkAccessEnabled, false);
    return {
      id: `packet-${scenario.id}`,
      async runStreamed(prompt) {
        captured = prompt;
        async function* events() {
          if (scenario.roles.length) {
            const sets = Array.from({ length: scenario.count }, (_, index) => ({
              id: `candidate-${index}`,
              members: scenario.roles.map((role, roleIndex) => {
                const path = `.factory-media/candidate-${index}/${role}`;
                mkdirSync(join(worktree, `.factory-media/candidate-${index}`), {
                  recursive: true,
                });
                writeFileSync(
                  join(worktree, path),
                  scenario.id === "same-path"
                    ? bytes
                    : `${role} variant ${index}\n`,
                );
                return {
                  role,
                  path,
                  mediaType:
                    role === "image" ? "image/png" : "application/json",
                  destination: scenario.owned[roleIndex],
                };
              }),
              provenance: {
                source: scenario.sourcePath,
                rights: "test fixture",
                visibility: "repository",
                lineage: [scenario.sourcePath],
              },
            }));
            writeFileSync(
              join(worktree, ".factory-assets.json"),
              JSON.stringify({ sets }),
            );
          }
          yield { type: "turn.completed", usage: null };
        }
        return { events: events() };
      },
    };
  };
  try {
    for (scenario of scenarios) {
      worktree = join(root, scenario.id);
      mkdirSync(worktree);
      const sourceAssets = scenario.roles.length
        ? [
            {
              binding: {
                kind: scenario.id === "same-path" ? "repository" : "local",
                path:
                  scenario.id === "same-path"
                    ? "assets/source.png"
                    : "/approved/source.png",
                role: "image",
                mediaType: ref.mediaType,
                visibility: "repository",
              },
              ref,
              ...(scenario.id === "multi-role"
                ? { path: join(worktree, scenario.sourcePath) }
                : {}),
            },
          ]
        : [];
      if (scenario.sourcePath) {
        mkdirSync(join(worktree, scenario.sourcePath, ".."), {
          recursive: true,
        });
        writeFileSync(join(worktree, scenario.sourcePath), bytes);
      }
      const item = {
        id: scenario.id,
        title: scenario.id,
        goal: "Implement accepted source requirements",
        acceptance: scenario.acceptance,
        nonGoals: ["No deployment"],
        citations: [],
        dependencies: [],
        ownedPaths: scenario.owned,
        resources: ["exact scheduling identity"],
        validation: [],
        brief: scenario.brief,
        sourceAssets: sourceAssets.map((source) => source.binding),
        expectedOutputRoles: scenario.roles,
        minimumAssetSets: scenario.count,
        requiredLfsRoles: scenario.id === "same-path" ? ["image"] : [],
      };
      const inputPath = join(root, `${scenario.id}.request.json`);
      const resultPath = join(root, `${scenario.id}.result.json`);
      writeFileSync(
        inputPath,
        JSON.stringify({
          request: { item, worktree, sourceAssets },
          network: "off",
          model: { model: "worker-choice", reasoningEffort: "medium" },
        }),
      );
      assert.equal(await runCodexWorker(inputPath, resultPath), true);
      assert.equal(
        JSON.parse(readFileSync(resultPath, "utf8")).state,
        "complete",
      );
      assert.ok(captured.includes(`Brief:\n${item.brief}`));
      assert.ok(
        captured.includes(`Acceptance:\n${item.acceptance.join("\n")}`),
      );
      assert.ok(
        captured.includes(`Owned paths:\n${item.ownedPaths.join("\n")}`),
      );
      if (!scenario.roles.length) {
        assert.equal(
          captured,
          `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${item.title}\nGoal: ${item.goal}\nAcceptance:\n${item.acceptance.join("\n")}\nNon-goals:\n${item.nonGoals.join("\n")}\nOwned paths:\n${item.ownedPaths.join("\n")}\nBrief:\n${item.brief}`,
        );
        continue;
      }
      assert.ok(
        captured.includes(
          `Produce at least ${scenario.count} complete candidate AssetSets.`,
        ),
      );
      assert.ok(
        captured.includes(`Source bindings: ${JSON.stringify(sourceAssets)}`),
      );
      assert.ok(
        captured.includes(
          `Expected output roles: ${scenario.roles.join(", ")}`,
        ),
      );
      const manifest = JSON.parse(
        captured.match(
          /manifest shape[^]*?: (\{"sets":.*?\})\. Include every expected role/,
        )[1],
      );
      assert.deepEqual(Object.keys(manifest.sets[0].members[0]), [
        "role",
        "path",
        "mediaType",
        "destination",
      ]);
      assert.deepEqual(Object.keys(manifest.sets[0].provenance), [
        "source",
        "rights",
        "visibility",
        "lineage",
      ]);
      assert.match(
        captured,
        /preserve source bytes exactly when byte identity is required/,
      );
      assert.doesNotMatch(captured, /AssetSets with different content/);
      assert.match(
        captured,
        /Do not write, remove, or otherwise change final destinations directly/,
      );
      assert.match(
        captured,
        /controller owns capture, whole-set selection, final destination materialization/,
      );
      assert.match(captured, /publication, and Objective lifecycle/);
      assert.match(
        captured,
        /Do not run Factory CLI operations or inspect controller installation, configuration, status, or logs/,
      );
      assert.match(
        captured,
        /do not remove explicitly owned ordinary code work/,
      );
      assert.match(
        captured,
        /Stop after completing the authorized owned code changes, candidate files, and manifest/,
      );
      assert.match(captured, /report the conflict rather than performing it/);
      if (scenario.id === "same-path") {
        assert.deepEqual(
          readFileSync(join(worktree, ".factory-media/candidate-0/image")),
          bytes,
        );
        assert.deepEqual(
          readFileSync(join(worktree, "assets/source.png")),
          bytes,
        );
      } else {
        assert.match(captured, /Authorized read-only asset inputs/);
        assert.match(captured, /do not edit or commit them/);
        assert.match(captured, /formatMetadata/);
        assert.match(captured, /relationships with from, toRole, and kind/);
        assert.match(captured, /Do not invent metadata or tool identities/);
      }
    }
  } finally {
    Codex.prototype.startThread = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex worker closes completed streams and durably fails nonterminal streams", async () => {
  const original = Codex.prototype.startThread;
  const root = mkdtempSync(join(tmpdir(), "factory-worker-terminal-"));
  const closed = new Set();
  let scenario = "complete";
  Codex.prototype.startThread = function () {
    return {
      id: `worker-${scenario}`,
      async runStreamed() {
        if (scenario === "creation-stall") await new Promise(() => {});
        async function* events() {
          try {
            yield {
              type: "thread.started",
              thread_id: `worker-${scenario}`,
            };
            yield {
              type: "item.completed",
              item: {
                id: "message",
                type: "agent_message",
                text: "provider prose is not terminal authority",
              },
            };
            if (
              ["complete", "partial", "no-usage", "validation-fail"].includes(
                scenario,
              )
            ) {
              yield {
                type: "turn.completed",
                usage:
                  scenario === "no-usage"
                    ? null
                    : scenario === "partial"
                      ? { input_tokens: 10 }
                      : {
                          input_tokens: 100,
                          cached_input_tokens: 70,
                          output_tokens: 12,
                          cache_write_input_tokens: 4,
                          reasoning_output_tokens: 2,
                        },
              };
              return;
            }
            if (scenario === "eof") return;
            await new Promise(() => {});
          } finally {
            closed.add(scenario);
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    for (scenario of [
      "complete",
      "partial",
      "no-usage",
      "eof",
      "silent",
      "creation-stall",
      "validation-fail",
    ]) {
      const inputPath = join(root, `${scenario}.request.json`);
      const resultPath = join(root, `${scenario}.result.json`);
      writeFileSync(
        inputPath,
        `${JSON.stringify({
          request: {
            attemptId: `attempt-${scenario}`,
            worktree: root,
            item: {
              id: "item",
              title: "Title",
              goal: "Goal",
              acceptance: ["Acceptance"],
              nonGoals: ["Non-goal"],
              citations: [],
              dependencies: [],
              ownedPaths: [],
              resources: [],
              validation: [],
              brief: "Brief",
              sourceAssets: [],
              expectedOutputRoles: [],
              minimumAssetSets: 0,
              requiredLfsRoles: [],
            },
          },
          network: "off",
          redactionValues: [],
          model: { model: "worker-choice", reasoningEffort: "medium" },
          providerTurnIdleTimeoutMs: 20,
        })}\n`,
      );
      if (scenario === "validation-fail")
        writeFileSync(join(root, ".factory-assets.json"), "not-json");
      const pending = runCodexWorker(inputPath, resultPath);
      if (scenario === "creation-stall") {
        // Inspect while stream creation is still pending, before timeout.
        const started = JSON.parse(
          readFileSync(
            resultPath.replace(/\.result\.json$/, ".progress.ndjson"),
            "utf8",
          ).trim(),
        );
        assert.equal(started.workerUsage.type, "started");
        const active = summarizeDiagnosticUsage([started]);
        assert.equal(active.workerUsage.activeCount, 1);
        assert.equal(active.workerUsage.failedCount, 0);
        assert.deepEqual(active.workerUsage.tokenTotals, {});
      }
      const completed = await pending;
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const observations = readFileSync(
        resultPath.replace(/\.result\.json$/, ".progress.ndjson"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((event) => event.operation === "worker-usage");
      const terminal = observations.at(-1).workerUsage;
      assert.equal(terminal.role, "worker");
      assert.equal(terminal.phase, "implementation");
      assert.equal(terminal.invocationId, `attempt-${scenario}`);
      assert.equal(terminal.providerAttempt, 1);
      assert.equal(terminal.model, "worker-choice");
      assert.doesNotMatch(
        JSON.stringify(observations),
        /provider prose|Brief|Acceptance/,
      );
      if (["complete", "partial", "no-usage"].includes(scenario)) {
        assert.equal(completed, true);
        assert.equal(result.state, "complete");
        assert.equal(closed.has(scenario), true);
        assert.equal(terminal.type, "completed");
        assert.deepEqual(
          terminal.usage,
          scenario === "no-usage"
            ? {}
            : scenario === "partial"
              ? { inputTokens: 10 }
              : {
                  inputTokens: 100,
                  cachedInputTokens: 70,
                  cacheWriteInputTokens: 4,
                  outputTokens: 12,
                  reasoningOutputTokens: 2,
                },
        );
        continue;
      }
      assert.equal(completed, false);
      assert.equal(result.state, "failed");
      assert.equal(terminal.type, "failed");
      if (scenario === "validation-fail") {
        assert.equal(terminal.usage.inputTokens, 100);
        assert.equal(result.evidence, undefined);
        continue;
      }
      assert.deepEqual(terminal.usage, {});
      if (scenario === "creation-stall") {
        const failed = summarizeDiagnosticUsage(observations);
        assert.equal(failed.workerUsage.activeCount, 0);
        assert.equal(failed.workerUsage.failedCount, 1);
        assert.equal(failed.workerUsage.usageUnavailableCount, 1);
        assert.deepEqual(failed.workerUsage.tokenTotals, {});
      }
      assert.match(
        result.error,
        scenario === "eof"
          ? /without turn\.completed/
          : /no progress for 20 ms/,
      );
      assert.equal(result.evidence, undefined);
    }
  } finally {
    Codex.prototype.startThread = original;
    rmSync(root, { recursive: true, force: true });
  }
});
