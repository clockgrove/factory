// The plan check holds an item's owned paths to collection's protected-path
// rule (#2246). An amendment gave an item workflow files the Objective's
// May change section didn't list; collection refused the worker's edits
// and the item held for the operator.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROTECTED_PATH_RULE } from "../dist/objective.js";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles } from "../dist/planning/facts.js";
import { shownBlocks } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const WORKFLOW = ".github/workflows/x.yml";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base commit with a script and a workflow that runs it. */
function target() {
  const directory = tempDir("factory-protected-plan-");
  git(directory, "init", "--quiet", "--initial-branch=main");
  for (const [file, text] of [
    ["src/check.js", "export {};\n"],
    [WORKFLOW, "on: push\n"],
  ]) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return { directory, commit: git(directory, "rev-parse", "HEAD") };
}

function item(id, ownedPaths) {
  return {
    kind: "work",
    id,
    title: `Item ${id}`,
    goal: "Run the browser checks in CI.",
    acceptance: ["`npm test` passes."],
    nonGoals: ["No other files."],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths,
    validation: [{ command: "npm test" }],
    brief: "Prepare the browser before the checks run.",
    priority: 1,
  };
}

/** A synthetic Objective, with a May change section listing `listed` when given. */
function objective(listed) {
  return shownBlocks(
    `<h2>Goal</h2><p>Run the browser checks in CI.</p><h2>Acceptance</h2><ul><li>The checks pass.</li></ul>${
      listed
        ? `<h2>May change</h2><ul>${listed.map((path) => `<li><code>${path}</code></li>`).join("")}</ul>`
        : ""
    }`,
    { sources: true },
  );
}

/** The protected-path findings checkPlan returns for `items`. */
async function findings(base, items, options = {}) {
  const facts = {
    objective: 1,
    body: "",
    blocks: objective(options.listed),
    base: base.commit,
    sources: [],
    packageCommands: [],
    ciOnlyCommands: [],
    checkNames: [],
    integratedCheckNames: [],
    fixedScripts: [],
    coverageObligations: [],
    playbook: "",
    ...(options.playbookPath ? { playbookPath: options.playbookPath } : {}),
    localAssetRoots: [],
    lfsRules: [],
  };
  const draft = (entries) => ({
    base: base.commit,
    items: entries,
    coverage: [],
    finalCommands: [],
    decisions: [],
  });
  const accepted = options.accepted ? draft(options.accepted) : undefined;
  return (
    await checkPlan(
      draft(items),
      facts,
      new BaseFiles(base.directory, base.commit),
      accepted,
      accepted,
      new Set(),
    )
  ).filter((finding) => /a protected path/.test(finding.message));
}

test("a plan giving an item a workflow the May change section doesn't list is refused, naming the path and the rule", async () => {
  const base = target();
  const [refused, ...rest] = await findings(base, [
    item("ci", ["src/check.js", WORKFLOW]),
  ]);
  assert.deepEqual(rest, []);
  assert.equal(refused.itemId, "ci");
  // The planner's to fix: no operator decision.
  assert.equal(refused.kind, undefined);
  assert.ok(refused.message.includes(`owns "${WORKFLOW}"`));
  assert.ok(refused.message.includes(PROTECTED_PATH_RULE));
  assert.match(refused.message, /decisionRequired/);
  // Listing another path allows nothing here.
  assert.equal(
    (
      await findings(base, [item("ci", [WORKFLOW])], {
        listed: ["CODEOWNERS"],
      })
    ).length,
    1,
  );
});

test("the exact path in May change lets an item own it; a directory over it stays refused", async () => {
  const base = target();
  assert.deepEqual(
    await findings(base, [item("ci", ["src/check.js", WORKFLOW])], {
      listed: [WORKFLOW],
    }),
    [],
  );
  const [refused] = await findings(base, [item("ci", [".github/workflows/"])], {
    listed: [WORKFLOW],
  });
  assert.ok(refused.message.includes('owns ".github/workflows/"'));
});

test("CODEOWNERS, other CI configuration and the playbook are protected; a directory holding the playbook is not", async () => {
  const base = target();
  const refused = await findings(
    base,
    [
      item("owners", ["docs/CODEOWNERS", ".gitlab-ci.yml"]),
      item("docs", ["docs/", "docs/plays.md"]),
    ],
    { playbookPath: "docs/plays.md" },
  );
  assert.deepEqual(
    refused.map((finding) => [finding.itemId, finding.message.split(",")[0]]),
    [
      ["owners", 'Work Item owners owns "docs/CODEOWNERS"'],
      ["owners", 'Work Item owners owns ".gitlab-ci.yml"'],
      ["docs", 'Work Item docs owns "docs/plays.md"'],
    ],
  );
});

test("an amendment that adds or grows an item with an unlisted workflow is refused; what the accepted plan owned isn't judged again", async () => {
  const base = target();
  const accepted = [item("app", ["src/check.js"]), item("old", [WORKFLOW])];
  // Added: a new item owning the workflow.
  const [added] = await findings(
    base,
    [...accepted, item("browser", [WORKFLOW])],
    { accepted },
  );
  assert.equal(added.itemId, "browser");
  // Grown: an accepted item that gains it.
  const [grown, ...rest] = await findings(
    base,
    [item("app", ["src/check.js", WORKFLOW]), item("old", [WORKFLOW])],
    { accepted },
  );
  assert.deepEqual(rest, []);
  assert.equal(grown.itemId, "app");
  // Listed, both are accepted.
  assert.deepEqual(
    await findings(base, [...accepted, item("browser", [WORKFLOW])], {
      accepted,
      listed: [WORKFLOW],
    }),
    [],
  );
});
