/**
 * A synthetic repository for the auto-grader's tests (bench/grade-auto.mjs,
 * #2273): a tiny tag parser and an Objective of two criteria, with a
 * planted defect. The change splits, trims and lowercases tags, but drops
 * duplicates before lowercasing them, so a tag given twice in different
 * cases appears twice. Its own test never tries that.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The Objective's text, as filed. */
export const OBJECTIVE = `# Parse tags

Add \`parseTags(text)\` to \`src/tags.mjs\`.

## Acceptance

- \`parseTags\` splits its text on commas, trims each tag and lowercases it.
- A tag given twice appears once.
`;

/** The two criteria, as a grader splits them. */
export const CRITERIA = [
  {
    id: "split-trim-lowercase",
    text: "parseTags splits its text on commas, trims each tag and lowercases it.",
  },
  { id: "once-each", text: "A tag given twice appears once." },
];

/** The repository in `dir`: `{ dir, base, commit }`, the base and the graded change. */
export function autoRepository(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (at, ...args) =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=Bench Fixture",
        "-c",
        "user.email=bench@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_DATE: at,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const commit = (at, files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(at, "add", "--all");
    git(at, "commit", "--quiet", "--message", message);
    return git(at, "rev-parse", "HEAD");
  };
  git("2031-03-04T08:00:00Z", "init", "--quiet", "--initial-branch=main");
  const base = commit(
    "2031-03-04T08:00:00Z",
    {
      "README.md": "# tags\n",
      "package.json": `${JSON.stringify({ name: "tags", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
      "src/tags.mjs": "export function parseTags() {\n  return [];\n}\n",
    },
    "Tags",
  );
  const graded = commit(
    "2031-03-04T09:00:00Z",
    {
      "src/tags.mjs": [
        "export function parseTags(text) {",
        '  const tags = text.split(",");',
        "  return [...new Set(tags)].map((tag) => tag.trim().toLowerCase());",
        "}",
        "",
      ].join("\n"),
      "test/tags.test.mjs": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { parseTags } from "../src/tags.mjs";',
        "",
        'test("tags", () => {',
        '  assert.deepEqual(parseTags(" Red, blue"), ["red", "blue"]);',
        "});",
        "",
      ].join("\n"),
    },
    "Parse tags",
  );
  return { dir, base, commit: graded };
}
