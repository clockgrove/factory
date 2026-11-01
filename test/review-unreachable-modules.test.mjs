// Review is given the files a change left unreachable. In a 0.5.11
// benchmark run (#2253) a Work Item rewrote a web client's entry point,
// left four modules nothing imported any more, and both reviews passed. A
// Work Item's review is told such a file is dead code, a note (#2344).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { itemInstructions, reviewResult } from "../dist/review/item.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function commit(directory, message) {
  git(directory, "add", "-A");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    message,
  );
  return git(directory, "rev-parse", "HEAD");
}

/**
 * The prompt of a result review of a change whose base has src/a.ts
 * importing src/b.ts by `specifier`, and whose result is `change` applied.
 */
async function reviewPrompt(specifier, change) {
  const checkout = tempDir("factory-review-unreachable-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  mkdirSync(join(checkout, "src"));
  writeFileSync(
    join(checkout, "src/a.ts"),
    `import { b } from "${specifier}";\nexport const a = b + 1;\n`,
  );
  writeFileSync(join(checkout, "src/b.ts"), "export const b = 1;\n");
  const base = commit(checkout, "base");
  writeFileSync(join(checkout, "src/a.ts"), "export const a = 2;\n");
  change(checkout);
  const head = commit(checkout, "rewrite a");
  const item = {
    kind: "work",
    id: "rewrite",
    title: "Rewrite a",
    goal: "Rewrite a.",
    acceptance: ["a is 2."],
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths: ["src/"],
    validation: [{ command: "npm test" }],
    brief: "Rewrite a.",
  };
  let prompt;
  await assert.rejects(
    reviewResult({
      planner: {
        async answer(call) {
          prompt = call.prompt;
          throw new Error("seen");
        },
      },
      plan: {
        base,
        items: [item],
        coverage: [],
        finalCommands: [],
        decisions: [],
      },
      item,
      checkout,
      base,
      commit: head,
      validation: {
        tree: git(checkout, "rev-parse", `${head}^{tree}`),
        commands: ["npm test"],
      },
      sources: [],
      dir: tempDir("factory-review-unreachable-root-"),
      scratch: async () => {
        throw new Error("this review runs no command");
      },
      commandMs: 60_000,
      signal: AbortSignal.timeout(60_000),
      log: () => {},
    }),
    /^Error: seen$/,
  );
  return prompt;
}

const ROW = "Files this change left unreachable";

const NONE = {
  unreachable: false,
  artifacts: false,
  candidates: false,
  inputs: false,
  knowledge: false,
  memory: false,
};
/** The item review's guidance for unreachable files: the line it adds. */
const UNREACHABLE_GUIDANCE = itemInstructions({ ...NONE, unreachable: true })
  .split("\n")
  .at(-1);

test("a result review lists a file the change left with no importer, and the rule to judge it", async () => {
  const prompt = await reviewPrompt("./b.js", () => {});
  const row = prompt
    .split("\n\n")
    .map((paragraph) => {
      try {
        return JSON.parse(paragraph);
      } catch {
        return undefined;
      }
    })
    .find((entry) => entry?.path === ROW);
  assert.deepEqual(JSON.parse(row.content).paths, ["src/b.ts"]);
  assert.ok(prompt.includes(UNREACHABLE_GUIDANCE));
  assert.match(UNREACHABLE_GUIDANCE, /dead code: a note/);
});

test("a file the change deletes, or one imported by a form Factory can't resolve, is not listed", async () => {
  const deleted = await reviewPrompt("./b", (checkout) =>
    rmSync(join(checkout, "src/b.ts")),
  );
  const alias = await reviewPrompt("@/b", () => {});
  for (const prompt of [deleted, alias]) {
    assert.ok(!prompt.includes(ROW));
    assert.ok(!prompt.includes(UNREACHABLE_GUIDANCE));
  }
});
