import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  finalObjectiveCommands,
  compilerCitationChoices,
  objectiveCriteria,
  planningSources,
} from "../dist/compiler.js";
import { workspacePackageAdditions } from "../dist/workspace-membership.js";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createTarget } from "./support/integration-fixture.mjs";

/** The issue body GitHub renders from the Objective form: `### Label` per field. */
function renderedObjectiveForm(answers) {
  const form = parse(
    readFileSync(
      new URL("../docs/templates/objective.yml", import.meta.url),
      "utf8",
    ),
  );
  return form.body
    .filter((field) => field.type === "textarea" || field.type === "input")
    .map(({ id, attributes }) => {
      const value = (answers[id] ?? attributes.value ?? "").trim();
      return `### ${attributes.label}\n\n${value || "_No response_"}`;
    })
    .join("\n\n");
}

test("Objective sections ignore fenced examples and accept real closing hashes", () => {
  const body = [
    "## Background",
    "````md",
    "## Acceptance",
    "- Example only",
    "```",
    "",
    "- `false`",
    "````",
    "  ## Acceptance ##",
    "- Actual outcome",
    "",
    "- `test -f result.txt`",
    "# Outside",
    "- `exit 1`",
  ].join("\n");
  assert.deepEqual(objectiveCriteria(body), [
    "Actual outcome",
    "`test -f result.txt`",
  ]);
  assert.deepEqual(finalObjectiveCommands(body), ["test -f result.txt"]);
  assert.deepEqual(
    objectiveCriteria(
      "## Acceptance\n- Output exactly:\n```text\n## literal content\n```\n## Outside\nIgnored",
    ),
    ["Output exactly: ```text ## literal content ```"],
  );
});

test("pinned sections and citation choices preserve literal hashes and ignore fenced headings", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-markdown-sources-"));
  try {
    const text =
      "# Source\n```md\n## C#\nexample\n```\n## C# ###\nReal content\n~~~\n## Next\nexample\n~~~\n## Next\nOther content\n";
    const target = createTarget(root, { "docs/languages.md": text });
    const body =
      "## Acceptance\n- Actual outcome\n```md\n## Sources\n- `missing.md`\n```\n## Sources\n- `docs/languages.md#C#`\n# End\nNo source entry here";
    assert.throws(
      () =>
        planningSources("## Sources\n- docs", target.baseSha, target.checkout),
      /missing at base/,
    );
    const selected = planningSources(
      body,
      target.baseSha,
      target.checkout,
    ).find((source) => source.path === "docs/languages.md");
    assert.equal(selected.heading, "C#");
    assert.equal(
      selected.content,
      "## C# ###\nReal content\n~~~\n## Next\nexample\n~~~",
    );
    const choices = compilerCitationChoices([
      { path: "docs/languages.md", content: text },
    ]);
    assert.deepEqual(
      choices.map((entry) => entry.heading),
      ["", "Source", "C#", "Next"],
    );
    assert.throws(
      () =>
        planningSources(
          body.replace("#C#`", "#C`"),
          target.baseSha,
          target.checkout,
        ),
      /0 headings named C/,
    );
    const duplicate = createTarget(join(root, "duplicates"), {
      "docs/languages.md": "## C#\none\n## C# ##\ntwo\n",
    });
    assert.throws(
      () => planningSources(body, duplicate.baseSha, duplicate.checkout),
      /2 headings named C#/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removed Objective fields are refused with where their content goes now", () => {
  for (const [field, moved] of [
    ["Final validation", /Acceptance bullet/],
    ["Required checks", /workflow job/],
    ["Planning sources", /Sources/],
    ["What must be true", /Acceptance/],
    ["Goal", /Outcome/],
    ["Non-goals", /Constraints/],
  ]) {
    for (const body of [
      `## Acceptance\n- one\n\n## ${field}\n- \`true\`\n`,
      `### ${field}\n\n- \`true\`\n`,
    ]) {
      for (const read of [
        objectiveCriteria,
        finalObjectiveCommands,
        (text) => planningSources(text, "unused", "/unused"),
      ])
        assert.throws(
          () => read(body),
          (error) =>
            error.message.includes(`"${field}" was removed`) &&
            moved.test(error.message) &&
            /Outcome, Acceptance, Sources, Constraints/.test(error.message),
        );
    }
  }
  // A removed field's name inside a fenced example is only text.
  assert.deepEqual(
    objectiveCriteria("## Acceptance\n- one\n```md\n## Goal\n```\n"),
    ["one ```md ## Goal ```"],
  );
});

test("command obligations are Acceptance bullets that are exactly one backticked command", () => {
  assert.deepEqual(
    finalObjectiveCommands(
      [
        "## Acceptance",
        "- `second`",
        "- first",
        "- `npm test` passes",
        "- Runs `a` and then `b`",
        "- ``",
        "- `a` `b`",
        "-   `third`  ",
        "1. `fourth`",
        "",
        "## Constraints",
        "- `ignored`",
      ].join("\n"),
    ),
    ["second", "third", "fourth"],
  );
  assert.deepEqual(finalObjectiveCommands("## Outcome\nDone\n"), []);
});

test("source selectors fail closed before model work", () => {
  for (const entry of [
    "```md\n- docs/a.md\n```",
    "- docs/a.md#",
    "- #Heading",
  ]) {
    assert.throws(
      () => planningSources(`## Sources\n${entry}`, "unused", "/unused"),
      /Invalid Sources entry/,
    );
  }
});

test("Objective issue form keeps its sources, even when the field repeats its heading", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-objective-form-"));
  try {
    const target = createTarget(root, {
      "docs/spec.md":
        "# Spec\n\n## Scope\nThe exact scope.\n\n## 7.1 Two words\nMore.\n",
    });
    const answers = {
      outcome: "Add a result file.",
      acceptance: "- result.txt exists.\n- `test -f README.md`",
    };
    assert.match(
      renderedObjectiveForm(answers),
      /### Sources\n\n- README\.md\n\n### Constraints/,
    );
    // The form's own value, and one that repeats the heading as older
    // copies of the form did.
    for (const sources of [
      "- README.md\n- `docs/spec.md#Scope`",
      "## Sources\n- README.md\n- `docs/spec.md#Scope`",
      // A heading with spaces works without backticks, as the guide shows it.
      "- README.md\n- docs/spec.md#Scope\n- docs/spec.md#7.1 Two words",
    ]) {
      const body = renderedObjectiveForm({
        ...answers,
        sources,
      });
      assert.deepEqual(objectiveCriteria(body), [
        "result.txt exists.",
        "`test -f README.md`",
      ]);
      assert.deepEqual(finalObjectiveCommands(body), ["test -f README.md"]);
      const selected = planningSources(body, target.baseSha, target.checkout)
        .slice(1)
        .map(({ path, heading }) => (heading ? `${path}#${heading}` : path));
      assert.deepEqual(selected.slice(0, 3), [
        "AGENTS.md",
        "README.md",
        "docs/spec.md#Scope",
      ]);
      if (!sources.includes("`"))
        assert.equal(selected[3], "docs/spec.md#7.1 Two words");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the issue form's Workspace package additions field declares additions or is left empty", () => {
  assert.deepEqual(workspacePackageAdditions(renderedObjectiveForm({})), []);
  assert.deepEqual(
    workspacePackageAdditions(
      renderedObjectiveForm({
        "workspace-package-additions": "- `packages/example`",
      }),
    ),
    ["packages/example"],
  );
});
