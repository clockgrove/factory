import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  finalObjectiveCommands,
  objectiveRequiredChecks,
  compilerCitationChoices,
  objectiveCriteria,
  planningSources,
} from "../dist/compiler.js";
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
    "## Final validation",
    "- `false`",
    "````",
    "  ## Acceptance ##",
    "- Actual outcome",
    "## Final validation ###",
    "- `test -f result.txt`",
    "# Outside",
    "- `exit 1`",
  ].join("\n");
  assert.deepEqual(objectiveCriteria(body), ["Actual outcome"]);
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
      "## Acceptance\n- Actual outcome\n```md\n## Planning sources\n- `missing.md`\n```\n## Planning sources ##\n- `docs/languages.md#C#`\n# End\nNo source entry here";
    assert.throws(
      () =>
        planningSources(
          "## Planning sources\n- docs",
          target.baseSha,
          target.checkout,
        ),
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

test("declared final validation and source selectors fail closed before model work", () => {
  for (const entry of [
    "",
    "```sh\ntrue\n```",
    "* true",
    "- ` `",
    "explanation",
  ]) {
    assert.throws(
      () =>
        planningSources(`## Final validation\n${entry}`, "unused", "/unused"),
      /Final validation/,
    );
  }
  assert.deepEqual(
    finalObjectiveCommands("## Final validation\n- `second`\n- first"),
    ["second", "first"],
  );
  for (const entry of [
    "```md\n- docs/a.md\n```",
    "- docs/a.md#",
    "- #Heading",
  ]) {
    assert.throws(
      () =>
        planningSources(`## Planning sources\n${entry}`, "unused", "/unused"),
      /Planning sources/,
    );
  }
});

test("Objective issue form keeps its planning sources, even when the field repeats its heading", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-objective-form-"));
  try {
    const target = createTarget(root, {
      "docs/spec.md": "# Spec\n\n## Scope\nThe exact scope.\n",
    });
    const answers = {
      outcome: "Add a result file.",
      acceptance: "- result.txt exists.",
      "final-validation": "- `test -f README.md`",
    };
    assert.match(
      renderedObjectiveForm(answers),
      /### Planning sources\n\n- README\.md$/,
    );
    // The form's own value, and one that repeats the heading as older
    // copies of the form did.
    for (const sources of [
      "- README.md\n- `docs/spec.md#Scope`",
      "## Planning sources\n- README.md\n- `docs/spec.md#Scope`",
    ]) {
      const body = renderedObjectiveForm({
        ...answers,
        "planning-sources": sources,
      });
      assert.deepEqual(objectiveCriteria(body), ["result.txt exists."]);
      assert.deepEqual(finalObjectiveCommands(body), ["test -f README.md"]);
      // The optional Required checks field renders empty as _No response_.
      assert.match(body, /### Required checks\n\n_No response_/);
      assert.deepEqual(objectiveRequiredChecks(body), []);
      const selected = planningSources(body, target.baseSha, target.checkout)
        .slice(1)
        .map(({ path, heading }) => (heading ? `${path}#${heading}` : path));
      assert.deepEqual(selected, [
        "AGENTS.md",
        "README.md",
        "docs/spec.md#Scope",
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
