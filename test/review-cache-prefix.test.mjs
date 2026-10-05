import assert from "node:assert/strict";
import test from "node:test";
import { ClaudePlanningModel } from "../dist/claude-planning.js";
import { planningReviewEvidence } from "../dist/compiler.js";
import { reviewPacket } from "../dist/review-evidence.js";
import { compilerRequest, compilerResponse } from "./support/compiler-wire.mjs";

const baseSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const config = {
  kind: "claude-agent-sdk",
  maxOutputTokens: 64000,
  planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
  reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "medium" },
};
const usage = { input_tokens: 1, output_tokens: 1 };

/** One Agent SDK session as the pinned runtime emits it for outputFormat. */
function sdkSession(options, structured) {
  return [
    {
      type: "system",
      subtype: "init",
      model: options.model,
      tools: ["StructuredOutput"],
      mcp_servers: [],
      permissionMode: "dontAsk",
      session_id: "s",
      uuid: "init",
    },
    {
      type: "assistant",
      message: {
        id: "m",
        model: options.model,
        content: [
          {
            type: "tool_use",
            id: "t",
            name: "StructuredOutput",
            input: structured,
          },
        ],
        usage,
      },
      parent_tool_use_id: null,
      session_id: "s",
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
      modelUsage: {},
      total_cost_usd: 0,
      permission_denials: [],
      session_id: "s",
      uuid: "result",
    },
  ];
}

/** Records each prompt the provider receives and answers it. */
function recorder(answer) {
  const prompts = [];
  const query = ({ prompt, options }) => {
    prompts.push(prompt);
    return (async function* () {
      yield* sdkSession(options, answer(prompt));
    })();
  };
  return {
    prompts,
    model: new ClaudePlanningModel(config, { query, wait: async () => {} }),
  };
}

function prefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * A provider caches the prompt prefix both calls share. It must reach past
 * every stable text, and each per-call text must come after them.
 */
function assertStablePrefix(first, second, stable, perCall) {
  const shared = prefix(first, second);
  const stableEnd = Math.max(
    ...stable.map((text) => {
      assert.ok(first.includes(text));
      return first.indexOf(text) + text.length;
    }),
  );
  assert.ok(shared >= stableEnd, "stable content is inside the shared prefix");
  for (const text of perCall) {
    const found = [first, second].filter((prompt) => prompt.includes(text));
    assert.equal(found.length, 1);
    assert.ok(found[0].indexOf(text) >= stableEnd, "per-call content is last");
  }
}

test("graph reviews of different candidates share a stable prompt prefix", async () => {
  const objective = "# Objective\n\nSTABLE-OBJECTIVE-TEXT";
  const sources = [{ path: "OBJECTIVE", content: "STABLE-SOURCE-TEXT" }];
  const base = compilerRequest({ objective, baseSha, sources });
  const request = (candidate) => {
    const input = {
      objective,
      baseSha,
      sources,
      graph: { objective: 1, baseSha, items: [{ id: candidate }] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: base.controllerCapabilities,
      controllerCapabilitiesDigest: base.controllerCapabilitiesDigest,
    };
    // Each call mints a fresh packet identity.
    return {
      ...input,
      reviewPacket: reviewPacket([], planningReviewEvidence(input)),
    };
  };
  const first = request("ALPHA-CANDIDATE");
  const second = request("BRAVO-CANDIDATE");
  const { model, prompts } = recorder(() => ({ packetId: "p", findings: [] }));
  await model.reviewGraph(first);
  await model.reviewGraph(second);
  assertStablePrefix(
    prompts[0],
    prompts[1],
    ["STABLE-OBJECTIVE-TEXT", "STABLE-SOURCE-TEXT"],
    [
      "ALPHA-CANDIDATE",
      "BRAVO-CANDIDATE",
      first.reviewPacket.id,
      second.reviewPacket.id,
    ],
  );
});

test("result reviews of different candidates share a stable prompt prefix", async () => {
  const stableSource = {
    origin: "source",
    path: "OBJECTIVE",
    content: "STABLE-SOURCE-TEXT",
  };
  const request = (candidate, tree) => ({
    reviewPacket: reviewPacket(
      ["Result exists."],
      [
        stableSource,
        {
          origin: "controller",
          path: "Exact Git change packet",
          content: candidate,
        },
      ],
    ),
    criteria: ["Result exists."],
    baseSha,
    treeSha: tree,
    sources: [],
    change: candidate,
    commands: [],
  });
  const first = request("ALPHA-CANDIDATE", "c".repeat(40));
  const second = request("BRAVO-CANDIDATE", "d".repeat(40));
  const { model, prompts } = recorder(() => ({ packetId: "p", findings: [] }));
  await model.reviewResult(first);
  await model.reviewResult(second);
  assertStablePrefix(
    prompts[0],
    prompts[1],
    ["STABLE-SOURCE-TEXT", "Result exists."],
    [
      "ALPHA-CANDIDATE",
      "BRAVO-CANDIDATE",
      first.reviewPacket.id,
      second.reviewPacket.id,
      first.treeSha,
      second.treeSha,
    ],
  );
});

test("compilations that differ only in revision context share a stable prompt prefix", async () => {
  const objective =
    "# Objective\n\nSTABLE-OBJECTIVE-TEXT\n\n## Acceptance\n- Done.";
  const sources = [{ path: "OBJECTIVE", content: objective }];
  const request = (instructions) => {
    const input = compilerRequest({ objective, baseSha, sources });
    return {
      ...input,
      compileContext: { ...input.compileContext, instructions },
    };
  };
  const { model, prompts } = recorder((prompt) => compilerResponse(prompt));
  const first = request("\n\nALPHA-REVISION");
  const second = request("\n\nBRAVO-REVISION");
  await model.generateStructured(first).catch(() => undefined);
  await model.generateStructured(second).catch(() => undefined);
  assert.equal(prompts.length, 2);
  assertStablePrefix(
    prompts[0],
    prompts[1],
    ["STABLE-OBJECTIVE-TEXT", "Compiler choices (JSON data)"],
    ["ALPHA-REVISION", "BRAVO-REVISION"],
  );
  // The context identity hashes the revision text, so it is per call too.
  const identity = (prompt) =>
    JSON.parse(prompt.split("\nCompiler choices (JSON data):\n")[1]).contextId;
  assert.notEqual(identity(prompts[0]), identity(prompts[1]));
  for (const prompt of prompts)
    assert.ok(
      prompt.indexOf(identity(prompt)) >= prefix(prompts[0], prompts[1]),
    );
});
