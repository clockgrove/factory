import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  objectiveCriteria,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import { coverageObligations } from "../dist/qa.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  encodeCompilerWire,
  isCompileSchema,
} from "./support/compiler-wire.mjs";
import { isGraphReviewSchema } from "./support/review-protocol.mjs";
import { createTarget } from "./support/integration-fixture.mjs";
import { compilePlan, planningDiagnosis } from "./support/plan.mjs";
import { packetFromPrompt } from "./support/review-protocol.mjs";

// Scripted SDK responses exercise the real planning/revision/prompt boundary,
// not live model judgment. No worker or source-declared command is executed.
test("review repairs required implementation content without moving later validation into the item", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  const laterCommand =
    "node tools/check-summary.mjs --input build/summary.json";
  const requirement =
    "GUIDE.md must document the exact final command for use after summary generation.";
  const objective = `# Objective

## Acceptance
- ${requirement}
- A separate item creates the summary and checker after documentation; documentation must not execute the final command or create its inputs.

## Commands
- test -s GUIDE.md

## Later check
- \`${laterCommand}\`
`;
  const item = {
    id: "guide",
    title: "Document the final check",
    goal: "Write GUIDE.md",
    acceptance: [requirement],
    nonGoals: [
      "Do not create the checker or summary, or run their later check.",
    ],
    citations: [{ choiceIndex: 2 }],
    dependencies: [],
    ownedPaths: ["GUIDE.md"],
    resources: [],
    validation: [
      {
        command: "test -s GUIDE.md",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    brief: "Document the Objective's exact final command.",
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
  const incomplete = {
    objective: 1,
    baseSha: target.baseSha,
    items: [
      item,
      {
        ...structuredClone(item),
        id: "summary",
        title: "Generate and check the summary",
        goal: "Create the summary and checker",
        acceptance: ["The checker accepts the generated summary."],
        nonGoals: ["Do not change GUIDE.md."],
        dependencies: ["guide"],
        ownedPaths: ["tools/check-summary.mjs", "build/summary.json"],
        validation: [
          {
            command: laterCommand,
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        brief: `Create the summary and checker for ${laterCommand}.`,
      },
    ],
  };
  const corrected = structuredClone(incomplete);
  corrected.items[0].citations = [{ choiceIndex: 2 }, { choiceIndex: 4 }];
  corrected.items[0].brief =
    "Document the final validation command from the selected source. This is not a command to run during this item. Do not create its inputs or change owned paths.";
  const finding = {
    itemIds: [],
    detail:
      "The guide worker cannot resolve the final command from its item inputs.",
    question:
      "Select the source section containing the exact command without changing validation?",
  };
  const compilePrompts = [];
  const reviewPrompts = [];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options?.outputSchema?.properties?.correction) {
        response = planningDiagnosis(finding.detail);
      } else if (isCompileSchema(options?.outputSchema)) {
        compilePrompts.push(prompt);
        if (compilePrompts.length === 2)
          assert.ok(prompt.includes(finding.detail));
        assert.ok(
          compilePrompts.length <= 2,
          "only the existing single revision",
        );
        response = withCoverage(
          {
            coverageObligations: coverageObligations(
              objective,
              objectiveCriteria(objective),
            ),
          },
          compilePrompts.length === 1 ? incomplete : corrected,
        );
        response = encodeCompilerWire(response, prompt);
      } else {
        assert.ok(isGraphReviewSchema(options?.outputSchema));
        reviewPrompts.push(prompt);
        const reviewed = JSON.parse(
          prompt
            .split("\nGraph:\n")[1]
            .split("\nCommand authority receipts:\n")[0],
        );
        const delivered = workItemPrompt({
          item: reviewed.items[0],
          worktree: target.checkout,
        });
        // The supervisor sees the command even when this item's prompt does not.
        assert.ok(prompt.includes(laterCommand));
        const packet = packetFromPrompt(prompt);
        const evidence = packet.evidence.find(
          (entry) =>
            entry.path === "OBJECTIVE" && entry.content.includes(requirement),
        );
        assert.ok(evidence);
        response = {
          packetId: packet.packetId,
          findings: delivered.includes(laterCommand)
            ? []
            : [{ ...finding, evidenceIndices: [evidence.evidenceIndex] }],
        };
      }
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
  const candidate = await compilePlan(
    1,
    objective,
    target.baseSha,
    target.checkout,
    new CodexPlanningModel(target.checkout, selection, selection),
  );
  assert.equal(candidate.review.status, "clean");
  assert.equal(candidate.review.revisions, 1);
  assert.equal(compilePrompts.length, 2);
  assert.equal(reviewPrompts.length, 2);
  verifyPlanCandidate(candidate, 1, objective, target.baseSha, target.checkout);
  const accepted = candidate.graph.items[0];
  for (const field of [
    "ownedPaths",
    "dependencies",
    "validation",
    "nonGoals",
  ]) {
    assert.deepEqual(accepted[field], item[field]);
  }
  assert.deepEqual(candidate.finalCommands, []);
  assert.equal(
    candidate.commands.filter((c) => c.itemId === "guide").length,
    1,
  );
  const prompt = workItemPrompt({ item: accepted, worktree: target.checkout });
  assert.ok(prompt.includes(laterCommand));
  assert.match(prompt, /Later check/);
  assert.match(prompt, /not a command to run during this item/);
  assert.match(prompt, /Change only the owned paths/);
  assert.match(
    prompt,
    /\.factory-discovery\.json as a private uncommitted proposal/,
  );
  assert.match(
    prompt,
    /controller independently reviews discoveries under existing Objective authority/,
  );
  assert.match(
    prompt,
    /Out-of-scope discoveries are backlog proposals, never authority/,
  );
  assert.ok(
    !prompt
      .split("Controller-run validation constraints")[1]
      .includes(laterCommand),
  );
  assert.ok(
    !prompt.includes(objective),
    "no indiscriminate Objective context injection",
  );
});
