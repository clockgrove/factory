import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  compilePlan,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import { createTarget } from "./support/integration-fixture.mjs";

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

test -s GUIDE.md

## Final validation
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
    citations: [{ choiceIndex: 0 }],
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
  corrected.items[0].brief = `Source: OBJECTIVE, Final validation. Document this exact command: ${laterCommand}. This is documentation content for use after summary generation, not a command to run during this item. Do not create its inputs or change owned paths.`;
  const finding = {
    source: "OBJECTIVE",
    quote: requirement,
    detail:
      "The guide worker cannot resolve the final command from its item inputs.",
    question:
      "Include the exact sourced command in the guide brief without changing its validation?",
  };
  const compilePrompts = [];
  const reviewPrompts = [];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt) {
      let response;
      if (prompt.startsWith("Compile this human Objective")) {
        compilePrompts.push(prompt);
        if (compilePrompts.length === 2)
          assert.ok(prompt.includes(finding.detail));
        assert.ok(
          compilePrompts.length <= 2,
          "only the existing single revision",
        );
        response = compilePrompts.length === 1 ? incomplete : corrected;
      } else {
        assert.ok(
          prompt.startsWith(
            "Independently review this complete proposed Factory plan",
          ),
        );
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
        response = {
          findings: delivered.includes(laterCommand) ? [] : [finding],
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
  for (const prompt of compilePrompts) {
    assert.match(
      prompt,
      /Make each item brief self-contained for implementation/,
    );
    assert.match(prompt, /exact source-backed literals.*source attribution/);
    assert.match(
      prompt,
      /do not add a command to item validation merely to transport its text/,
    );
    assert.match(
      prompt,
      /Distinguish writing a script or documenting a later command from executing it/,
    );
  }
  for (const prompt of reviewPrompts) {
    assert.match(
      prompt,
      /Check worker-input completeness separately from complete supervisor-packet coverage/,
    );
    assert.match(
      prompt,
      /source-backed material finding.*worker-visible item fields/,
    );
    assert.match(
      prompt,
      /citations, Objective\/source text, sibling items and final commands are not automatically supplied/,
    );
    assert.match(
      prompt,
      /preserve ownership, dependencies and later-phase validation/,
    );
  }
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
  assert.deepEqual(candidate.finalCommands, [laterCommand]);
  assert.equal(
    candidate.commands.filter((c) => c.itemId === "guide").length,
    1,
  );
  const prompt = workItemPrompt({ item: accepted, worktree: target.checkout });
  assert.ok(prompt.includes(laterCommand));
  assert.match(prompt, /Source: OBJECTIVE, Final validation/);
  assert.match(prompt, /not a command to run during this item/);
  assert.match(prompt, /Change only the owned paths/);
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
