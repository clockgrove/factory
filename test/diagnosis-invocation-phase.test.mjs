import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { analyzeInteractions } from "../dist/analysis.js";
import { renderAnalysisGantt } from "../dist/analysis-gantt.js";
import { readInteractionMetadata } from "../dist/capture.js";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../dist/controller-capabilities.js";
import {
  DiagnosticEmitter,
  readDiagnosticMetadata,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";

const response = {
  kind: "operator",
  diagnosis: "Synthetic failure requires an operator source decision",
  correction: "",
};
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "diagnosis", "correction"],
  properties: {
    kind: { type: "string", enum: ["operator"] },
    diagnosis: { type: "string" },
    correction: { type: "string" },
  },
};
function request(invocation) {
  return {
    purpose: "diagnosis",
    objective: "Diagnose only the preserved synthetic failure",
    baseSha: "a".repeat(40),
    sources: [],
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    schema,
    invocation,
  };
}
const selection = { model: "scripted-model", reasoningEffort: "medium" };

test("actual diagnosis adapter correlates diagnostic and capture phases through analysis without rewriting history", async (t) => {
  const previous = process.env.XDG_STATE_HOME;
  const root = mkdtempSync(join(tmpdir(), "factory-diagnosis-phase-"));
  process.env.XDG_STATE_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const repository = "example/diagnosis-phase";
  const emitter = new DiagnosticEmitter(repository, 1);
  const observe = emitter.modelObserver({ scopeId: "planning" });
  // Retained compile metadata cannot reveal an old call's semantic purpose.
  observe({
    type: "started",
    invocationId: "historical",
    phase: "compile",
    ordinal: 0,
  });
  observe({
    type: "completed",
    invocationId: "historical",
    phase: "compile",
    ordinal: 0,
    usageAvailable: false,
  });
  const historical = readDiagnosticMetadata(repository, 1);
  let usage;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      assert.match(prompt, /requested diagnostic JSON/);
      assert.doesNotMatch(prompt, /Compiler choices \(JSON data\)/);
      assert.deepEqual(options.outputSchema, schema);
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "scripted-thread" };
          yield {
            type: "item.completed",
            item: {
              id: "scripted-message",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage };
        })(),
      };
    },
  }));
  const model = new CodexPlanningModel(root, selection, selection);
  for (const [index, counters] of [
    null,
    { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3 },
  ].entries()) {
    usage = counters;
    const observed = [];
    // Purpose selects the adapter-owned phase, including callers from older source.
    const context = {
      invocationId: `diagnosis-${index}`,
      phase: "compile",
      ordinal: index + 1,
      observe: (event) => {
        observed.push(event);
        observe(event);
      },
    };
    assert.deepEqual(
      await model.generateStructured(request(context)),
      response,
    );
    assert.ok(observed.some((event) => event.type === "started"));
    assert.ok(observed.some((event) => event.type === "progress"));
    assert.equal(
      observed.filter((event) => event.type === "completed").length,
      1,
    );
    assert.ok(
      observed.every(
        (event) =>
          event.phase === "diagnosis" &&
          event.invocationId === context.invocationId &&
          event.ordinal === index + 1 &&
          event.providerAttempt === 1 &&
          event.providerMaxAttempts === 1,
      ),
    );
  }
  const events = readDiagnosticMetadata(repository, 1);
  assert.deepEqual(events.slice(0, historical.length), historical);
  const totals = summarizeModelInvocations(events);
  assert.equal(totals.objective.invocationCount, 3);
  assert.equal(totals.objective.completedCount, 3);
  assert.equal(totals.byPhase.compile.invocationCount, 1);
  assert.equal(totals.byPhase.diagnosis.invocationCount, 2);
  assert.equal(totals.byPhase.diagnosis.completedCount, 2);
  assert.equal(totals.byPhase.diagnosis.usageAvailableCount, 1);
  assert.equal(totals.byPhase.diagnosis.usageUnavailableCount, 1);
  assert.deepEqual(totals.byPhase.diagnosis.tokenTotals, {
    inputTokens: 7,
    cachedInputTokens: 2,
    outputTokens: 3,
  });
  const metadata = readInteractionMetadata(repository, 1);
  assert.ok(
    metadata
      .filter((entry) => entry.invocationId.startsWith("diagnosis-"))
      .every(
        (entry) =>
          entry.phase === "diagnosis" &&
          entry.content.status === "capture-disabled",
      ),
  );
  const report = analyzeInteractions(metadata, events);
  assert.deepEqual(
    report.groups.map((group) => [group.identity.phase, group.invocationCount]),
    [
      ["compile", 1],
      ["diagnosis", 2],
    ],
  );
  const filtered = analyzeInteractions(metadata, events, {
    filters: { phase: "diagnosis" },
  });
  assert.equal(filtered.invocationCount, 2);
  assert.match(renderAnalysisGantt(filtered), /Provider diagnosis:/);
  assert.doesNotMatch(renderAnalysisGantt(filtered), /Provider compile:/);
});

test("diagnosis capacity refusal remains one provider invocation without reviewer retries", async (t) => {
  let calls = 0;
  const observed = [];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed() {
      calls += 1;
      return {
        events: (async function* () {
          yield {
            type: "turn.failed",
            error: { message: "Provider capacity temporarily unavailable" },
          };
        })(),
      };
    },
  }));
  const model = new CodexPlanningModel(
    "/unused",
    selection,
    selection,
    undefined,
    {
      reviewCapacityRetryDelaysMs: [0, 0],
      wait: () => {
        throw Error("diagnosis must not retry");
      },
    },
  );
  await assert.rejects(
    model.generateStructured(
      request({
        invocationId: "refused",
        phase: "diagnosis",
        ordinal: 1,
        observe: (event) => observed.push(event),
      }),
    ),
    /capacity/,
  );
  assert.equal(calls, 1);
  assert.equal(observed.filter((event) => event.type === "failed").length, 1);
  assert.ok(
    observed.every(
      (event) => event.phase === "diagnosis" && event.providerMaxAttempts === 1,
    ),
  );
  assert.equal(
    observed.some((event) => event.type === "retry-scheduled"),
    false,
  );
});
