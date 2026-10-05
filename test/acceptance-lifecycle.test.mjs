import {
  compilerRequest,
  compilerResponse,
  isCompileSchema,
} from "./support/compiler-wire.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../dist/controller-capabilities.js";
import { packetFromPrompt } from "./support/review-protocol.mjs";

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
    itemIds: [],
    evidenceIndices: [0],
    detail:
      "The compound media criterion requires post-delivery evidence before publication.",
    question:
      "Keep upload and final hydration at their source-declared controller phases?",
  };
  const dependencyCriterion =
    "The join starts from the exact integrated predecessor head.";
  const downstreamGraph = structuredClone(graph);
  downstreamGraph.items.push({
    id: "summary-join",
    dependencies: ["media"],
    acceptance: [dependencyCriterion],
  });
  const prompts = [];
  const responses = [
    graph,
    { findings: [finding] },
    { findings: [] },
    { findings: [] },
  ];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      prompts.push(prompt);
      const scripted = responses.shift();
      const response = isCompileSchema(options?.outputSchema)
        ? compilerResponse(prompt, scripted.items)
        : {
            packetId: packetFromPrompt(prompt).packetId,
            ...scripted,
          };
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
  const compiled = await model.generateStructured(compilerRequest(request));
  assert.deepEqual(compiled.items[0].acceptance, [correctedCriterion]);
  const badGraph = structuredClone(graph);
  badGraph.items[0].acceptance = [badCriterion];
  assert.deepEqual(
    (
      await model.reviewGraph({
        ...request,
        graph: badGraph,
        commands: [],
        finalCommands: [],
      })
    ).findings,
    [finding],
  );
  assert.deepEqual(
    (
      await model.reviewGraph({
        ...request,
        graph,
        commands: [],
        finalCommands: [],
      })
    ).findings,
    [],
  );
  assert.deepEqual(
    (
      await model.reviewGraph({
        ...request,
        sources: [
          ...request.sources,
          { path: "docs/local-dag.md", content: dependencyCriterion },
        ],
        graph: downstreamGraph,
        commands: [],
        finalCommands: [],
      })
    ).findings,
    [],
  );
  for (const prompt of prompts) {
    for (const id of [
      "independent-result-review",
      "reviewed-head-publication",
      "protected-exact-head-integration",
    ])
      assert.ok(prompt.includes(id), `Missing rendered capability: ${id}`);
  }
  assert.ok(prompts[0].includes(source));
  for (const prompt of prompts.slice(1)) {
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes(JSON.stringify(request.controllerCapabilities)));
  }
  assert.ok(prompts[1].includes(badCriterion));
  assert.ok(prompts[2].includes(correctedCriterion));
  assert.ok(prompts[3].includes(dependencyCriterion));
  assert.deepEqual(
    badGraph.items[0].acceptance,
    [badCriterion],
    "review does not rewrite the proposed criterion",
  );
});
