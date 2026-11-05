import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";
import { FACTORY_PROTECTED, protectedPaths, protectedTouched, renderTaskCard, taskCardValues } from "../scripts/lib/logic.mjs";
import { buildPrompt } from "../scripts/lib/session.mjs";

const template = readFileSync(join(PLUGIN_ROOT, "templates", "task-card.md"), "utf8");

test("renders the plugin's task card with every placeholder filled", () => {
  const values = taskCardValues({ issue: 811, maxUsd: 25, timeoutMinutes: 240, validation: ["pnpm check", "pnpm test"], budgetCommand: "node scripts/check-test-budget.mjs", protectedPaths: protectedPaths(["scripts/test-budget.json"]) });
  const card = renderTaskCard(template, values);
  assert.match(card, /GitHub issue #811 in this repository, unattended/);
  assert.match(card, /Your budget is \$25 and 4 hours/);
  assert.match(card, /Validation commands: pnpm check; pnpm test\./);
  assert.match(card, /Budget command: node scripts\/check-test-budget\.mjs\./);
  assert.match(card, /Protected paths: \.github\/, CODEOWNERS, \.agents\/skills\/, \.claude\/, \.codex\/, scripts\/test-budget\.json\./);
  assert.match(card, /commits on factory\/811;/);
  assert.doesNotMatch(card, /\{\{/);
});

test("hours are rounded to one decimal and empty commands read as none", () => {
  const v = taskCardValues({ issue: 1, maxUsd: 5, timeoutMinutes: 100, validation: [], budgetCommand: "", protectedPaths: FACTORY_PROTECTED });
  assert.equal(v.hours, "1.7");
  assert.equal(v.validation, "none");
  assert.equal(v.budget_command, "none");
});

test("a missing placeholder value is an error, not an empty string", () => {
  assert.throws(() => renderTaskCard("hi {{issue}} {{nope}}", { issue: 1 }), /missing values for nope/);
});

test("the prompt is the card followed by the issue verbatim", () => {
  const prompt = buildPrompt({ templatePath: join(PLUGIN_ROOT, "templates", "task-card.md"), issue: 7, issueTitle: "Add thing", issueBody: "## Goal\nDo it.\n\n## Decisions\n- keep X", maxUsd: 10, timeoutMinutes: 60, validation: ["make test"], budgetCommand: "", protectedList: FACTORY_PROTECTED });
  const [card, issue] = prompt.split("\n---\n");
  assert.match(card, /issue #7/);
  assert.match(issue, /Issue #7: Add thing\n\n## Goal\nDo it\.\n\n## Decisions\n- keep X/);
});

test("protected paths: Factory's list plus the repository's, deduped; directory and file rules", () => {
  const list = protectedPaths([".github/", " scripts/test-budget.json ", ""]);
  assert.deepEqual(list, [".github/", "CODEOWNERS", ".agents/skills/", ".claude/", ".codex/", "scripts/test-budget.json"]);
  assert.deepEqual(protectedTouched([".github/workflows/ci.yml", "src/a.ts", "docs/CODEOWNERS", "scripts/test-budget.json", ".claude/agents/implementer.md"], list), [".github/workflows/ci.yml", "docs/CODEOWNERS", "scripts/test-budget.json", ".claude/agents/implementer.md"]);
  assert.deepEqual(protectedTouched(["src/x.ts"], list), []);
});


test("task card: with required checks the harness runs the tests it touched; without them it runs the commands", () => {
  const withChecks = taskCardValues({ issue: 2, maxUsd: 5, timeoutMinutes: 60, validation: ["pnpm test"], budgetCommand: "", protectedPaths: FACTORY_PROTECTED, ciChecks: ["quality"] });
  assert.match(withChecks.validation_note, /required check \(quality\) on the head you push.*tests your change touches/);
  const without = taskCardValues({ issue: 2, maxUsd: 5, timeoutMinutes: 60, validation: ["pnpm test"], budgetCommand: "", protectedPaths: FACTORY_PROTECTED });
  assert.equal(without.validation_note, "Run the validation commands before you push; Factory runs them again.");
});
