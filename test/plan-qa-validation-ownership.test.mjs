// A read-only QA item owns no paths and runs `npm test` on the integrated
// result, as check 1 of plan review requires. In the 0.5.0 qualifier rerun
// the graph reviewer, told that any item selects a command only if it owns
// files the command checks, flagged that QA item three rounds running and
// planning held; Factory's own check limits the rule to work items.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles, buildFacts } from "../dist/planning/facts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base whose root `test` script is `script`, and Objective 3's facts on it. */
async function objective(script) {
  const checkout = tempDir("factory-qa-ownership-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: script } }),
  );
  writeFileSync(join(checkout, "README.md"), "# Target\n");
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const base = git(checkout, "rev-parse", "HEAD");
  const shown = readShown(
    "<h2>Goal</h2>\n<p>Pad a string.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>npm test</code> passes.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({ objective: 3, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return { checkout, base, facts: built.facts };
}

test("the plan check passes a zero-path QA item that runs npm test, whether the test script is scoped or not", async () => {
  for (const script of ["node --test", "cd test && node --test"]) {
    const { checkout, base, facts } = await objective(script);
    const items = [
      {
        kind: "work",
        id: "padEnd",
        title: "Pad a string",
        goal: "Add padEnd and its test.",
        acceptance: ["padEnd pads a string to a length."],
        nonGoals: ["No other files."],
        citations: [{ path: "README.md" }],
        dependencies: [],
        ownedPaths: ["src/x.js", "test/x.test.js"],
        validation: [{ command: "npm test" }],
        brief: "Pad a string at its end.",
        priority: 1,
      },
      {
        kind: "qa",
        id: "integrated-tests",
        title: "Run the tests on the integrated result",
        goal: "Run npm test on the integrated result.",
        acceptance: ["`npm test` passes on the integrated result."],
        nonGoals: ["Changing implementation or tests."],
        citations: [{ path: "README.md" }],
        dependencies: ["padEnd"],
        ownedPaths: [],
        validation: [{ command: "npm test" }],
        brief: "Run the Objective's command on the integrated result.",
        priority: 1,
      },
    ];
    const coverage = [
      {
        source: { path: "OBJECTIVE", text: "`npm test` passes." },
        itemId: "integrated-tests",
        proof: { kind: "integrated-command", validationIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      },
    ];
    assert.deepEqual(
      await checkPlan(
        { base, items, coverage, finalCommands: [], decisions: [] },
        facts,
        new BaseFiles(checkout, base),
      ),
      [],
      script,
    );
  }
});
