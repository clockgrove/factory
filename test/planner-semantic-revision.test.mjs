import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { ClaudePlanningModel } from "../dist/claude-planning.js";
import {
  CodexPlanningModel,
  MalformedPlannerOutput,
  PlanningNeedsDecision,
} from "../dist/compiler.js";
import { consumption } from "../dist/repair-policy.js";
import {
  compilerChoices,
  compilerItem,
  compilerResponse,
  isCompileSchema,
} from "./support/compiler-wire.mjs";
import { createTarget } from "./support/integration-fixture.mjs";
import { compilePlan } from "./support/plan.mjs";

const body =
  "# Objective\n\n## Acceptance\n- Source-defined result exists.\n\n## Validation\n- `test -d .`\n";
const coverage = (obligationIndex = 0) => ({
  obligationIndex,
  proof: { kind: "final-review" },
  environment: {
    kind: "local",
    readiness: "available",
    probeValidationIndex: null,
    preparedBy: "",
  },
});

/** A well-formed answer the Factory then refuses, with the message it must show the planner. */
const refusals = {
  "a duplicated obligationIndex": {
    message: /obligationIndex is duplicated/,
    spoil(response) {
      response.items[0].coverage.push(coverage(0));
    },
  },
  "an obligationIndex outside the supplied choices": {
    message: /Planner obligationIndex is invalid/,
    spoil(response) {
      response.items[0].coverage[0].obligationIndex = 999;
    },
  },
  "a proof index outside the supplied choices": {
    message: /Planner validationIndex is invalid/,
    spoil(response) {
      response.items[0].coverage[0].proof = {
        kind: "result-command",
        validationIndex: 999,
      };
    },
  },
  "an objective obligation no item covers": {
    message: /Planner omitted Objective coverage/,
    spoil(response) {
      response.items[0].coverage = [];
    },
  },
  "a QA item with no coverage": {
    message: /Planner QA node has no acceptance coverage/,
    spoil(response) {
      const qa = compilerItem({
        kind: "qa",
        id: "verify-result",
        dependencies: [response.items[0].id],
        validation: [],
      });
      for (const field of [
        "ownedPaths",
        "sourceAssets",
        "expectedOutputRoles",
        "requiredLfsRoles",
        "minimumAssetSets",
      ])
        delete qa[field];
      response.items.push({ ...qa, coverage: [] });
    },
  },
};

const state = (planningRevisions) => ({
  autonomy: {
    allowances: {
      planningRevisions,
      implementationRepairs: 0,
      resultRereviews: 0,
    },
    repairClasses: ["planning-output"],
    repairPolicy: {
      perPath: {
        planningRevisions,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
    },
    requiredEnvironment: [],
  },
});

/**
 * Both providers answer from the same script, keyed on the request's schema:
 * `spoilFor(n)` is how the nth compile answer is spoiled (none: it is sound).
 */
function script(spoilFor) {
  const calls = { compile: 0, diagnosis: 0, review: 0 };
  const prompts = [];
  const answer = (prompt, schema) => {
    if (isCompileSchema(schema)) {
      calls.compile++;
      prompts.push(prompt);
      const response = compilerResponse(prompt);
      spoilFor(calls.compile)?.(response);
      return response;
    }
    if (schema.properties.packetId) {
      calls.review++;
      return { packetId: schema.properties.packetId.enum[0], findings: [] };
    }
    calls.diagnosis++;
    return {
      kind: "planning-output",
      diagnosis: "The answer chose coverage the Objective does not supply.",
      correction: `Cover each supplied obligation exactly once: ${compilerChoices(prompts.at(-1)).obligations.length} here.`,
    };
  };
  return { calls, prompts, answer };
}

const providers = {
  Codex(t, target, answer) {
    t.mock.method(Codex.prototype, "startThread", () => ({
      async runStreamed(prompt, options) {
        const response = answer(prompt, options.outputSchema);
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "scripted",
                type: "agent_message",
                text: JSON.stringify(response),
              },
            };
            yield { type: "turn.completed", usage: null };
          })(),
        };
      },
    }));
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
    return new CodexPlanningModel(target.checkout, selection, selection);
  },
  Claude(_t, _target, answer) {
    // Claude's structured output cannot carry `maximum`, so the decoder is
    // the only place an out-of-range index is caught.
    const structured = (options, value) => {
      const usage = {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      return [
        {
          type: "system",
          subtype: "init",
          model: options.model,
          tools: ["StructuredOutput"],
          mcp_servers: [],
          permissionMode: "dontAsk",
          session_id: "session",
          uuid: "init",
        },
        {
          type: "assistant",
          message: {
            id: "msg",
            model: options.model,
            content: [
              {
                type: "tool_use",
                id: "toolu",
                name: "StructuredOutput",
                input: value,
              },
            ],
            usage,
          },
          parent_tool_use_id: null,
          session_id: "session",
          uuid: "assistant",
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          result: JSON.stringify(value),
          stop_reason: "tool_use",
          structured_output: value,
          usage,
          modelUsage: {},
          total_cost_usd: 0,
          permission_denials: [],
          session_id: "session",
          uuid: "result",
        },
      ];
    };
    return new ClaudePlanningModel(
      {
        kind: "claude-agent-sdk",
        maxOutputTokens: 64000,
        planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
        reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "medium" },
      },
      {
        wait: async () => undefined,
        query: ({ prompt, options }) =>
          (async function* () {
            // The Claude schema drops numeric bounds; restore only the
            // properties this script keys on.
            yield* structured(
              options,
              answer(prompt, options.outputFormat.schema),
            );
          })(),
      },
    );
  },
};

for (const [provider, build] of Object.entries(providers))
  for (const [kind, refusal] of Object.entries(refusals)) {
    test(`${provider}: ${kind} is revised within the planning allowance, not thrown`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "factory-semantic-revision-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const target = createTarget(root);
      const { calls, prompts, answer } = script((n) =>
        n === 1 ? refusal.spoil : undefined,
      );
      const model = build(t, target, answer);
      const recovery = state(1);
      const candidate = await compilePlan(
        17,
        body,
        target.baseSha,
        target.checkout,
        model,
        undefined,
        undefined,
        undefined,
        { state: recovery, save: () => {} },
      );
      assert.equal(candidate.review.status, "clean");
      // One refused answer, one diagnosis, one corrected answer, one review.
      assert.deepEqual(calls, { compile: 2, diagnosis: 1, review: 1 });
      assert.equal(consumption(recovery).planningRevisions, 1);
      assert.equal(recovery.planningRecovery.history.length, 1);
      assert.match(
        recovery.planningRecovery.history[0].detail,
        refusal.message,
      );
      // The planner sees the refusal's diagnosis in its revision prompt.
      assert(
        prompts[1].includes("Cover each supplied obligation exactly once"),
      );
      assert(!prompts[0].includes("Cover each supplied obligation"));
    });

    const stopped = async (t, spoilFor) => {
      const root = mkdtempSync(join(tmpdir(), "factory-semantic-bound-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const target = createTarget(root);
      const { calls, answer } = script(spoilFor);
      const model = build(t, target, answer);
      const recovery = state(1);
      const error = await compilePlan(
        17,
        body,
        target.baseSha,
        target.checkout,
        model,
        undefined,
        undefined,
        undefined,
        { state: recovery, save: () => {} },
      ).then(
        () => assert.fail("planning stopped without a decision"),
        (thrown) => thrown,
      );
      // An operator plan decision, never a malformed-output failure.
      assert(error instanceof PlanningNeedsDecision, error.message);
      assert(!(error instanceof MalformedPlannerOutput));
      // The refused answer was diagnosed once, asked once more, and never reviewed.
      assert.deepEqual(calls, { compile: 2, diagnosis: 1, review: 0 });
      assert.equal(consumption(recovery).planningRevisions, 1);
      assert.equal(recovery.planningRecovery.phase, "stopped");
      assert.equal(recovery.planningRecovery.history.length, 1);
      return error;
    };

    test(`${provider}: ${kind} that is refused again unchanged stops for a decision`, async (t) => {
      const error = await stopped(t, () => refusal.spoil);
      assert.match(error.message, /Unchanged planning failure/);
    });

    test(`${provider}: ${kind} followed by a different refusal stops at the planning allowance`, async (t) => {
      // The second answer is refused for another reason, so the failure is
      // new and only the spent allowance stops planning.
      const other = Object.values(refusals).find((entry) => entry !== refusal);
      const error = await stopped(t, (n) =>
        n === 1 ? refusal.spoil : other.spoil,
      );
      assert.match(error.message, /allowance is exhausted/);
    });
  }
