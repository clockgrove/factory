import assert from "node:assert/strict";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../dist/controller-capabilities.js";

// Captures production prompts at the SDK seam. Scripted answers prove prompt
// contracts, not a live model's ability to apply them to arbitrary criteria.
test("compile and independent graph review expose the pre-delivery boundary for the actual compound criterion", async (t) => {
  const badCriterion =
    "The selected exact result passes the declared byte-identity and Git LFS listing validations; controller evidence verifies the selected pointer digest and size, required-object upload before publication, and exact post-integration fresh-clone hydration.";
  const source =
    "The controller-owned selected result and final Objective review must verify those completed obligations at their actual phase, without removing them from overall acceptance.";
  const correctedCriterion =
    "The selected exact result passes the declared byte-identity and Git LFS listing validations; controller evidence verifies the selected pointer digest and size.";
  const graph = {
    objective: 1,
    baseSha: "a".repeat(40),
    items: [{ id: "media", acceptance: [correctedCriterion] }],
  };
  const finding = {
    source: "OBJECTIVE",
    quote: source,
    detail:
      "The compound media criterion requires post-delivery evidence before publication.",
    question:
      "Keep upload and final hydration at their source-declared controller phases?",
  };
  const prompts = [];
  const responses = [graph, { findings: [finding] }, { findings: [] }];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt) {
      prompts.push(prompt);
      const response = responses.shift();
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "answer",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel("/unused", selection, selection);
  const request = {
    objective: source,
    baseSha: graph.baseSha,
    sources: [{ path: "OBJECTIVE", content: source }],
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
  };
  // A custom schema keeps this test focused on lifecycle instructions, rather
  // than the independently covered indexed citation/schema decoder.
  assert.deepEqual(
    await model.generateStructured({ ...request, schema: { type: "object" } }),
    graph,
  );
  const badGraph = structuredClone(graph);
  badGraph.items[0].acceptance = [badCriterion];
  assert.deepEqual(
    await model.reviewGraph({
      ...request,
      graph: badGraph,
      commands: [],
      finalCommands: [],
    }),
    { findings: [finding] },
  );
  assert.deepEqual(
    await model.reviewGraph({
      ...request,
      graph,
      commands: [],
      finalCommands: [],
    }),
    { findings: [] },
  );
  for (const prompt of prompts) {
    assert.match(prompt, /BEFORE delivery/);
    assert.match(prompt, /compound criteria/);
    assert.match(prompt, /upload.*before branch\/PR publication/);
    assert.match(
      prompt,
      /final Objective commands.*fresh-clone exact-byte hydration/i,
    );
    assert.match(prompt, /source.*contradict/i);
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes(JSON.stringify(request.controllerCapabilities)));
  }
  assert.ok(prompts[1].includes(badCriterion));
  assert.ok(prompts[2].includes(correctedCriterion));
  assert.deepEqual(
    badGraph.items[0].acceptance,
    [badCriterion],
    "review does not rewrite the proposed criterion",
  );
});
