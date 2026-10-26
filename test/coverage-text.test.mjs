// A coverage entry's Objective text is Factory's: the planner names the
// obligation by its position and decoding copies the criterion. The Claude
// run's padEnd case planned `"ab  "` as `"ab "`: the criterion collapsed the
// spaces its inline code kept, so plan review found the coverage misquoting
// the pinned Objective, and the planner, who writes no text, could not fix it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import { validateGraph } from "../dist/planning/graph.js";
import { decodePlan } from "../dist/planning/wire.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

const CRITERION =
  '`padEndQjgwl(s, width)` puts spaces after `s` until it is `width` characters long: `padEndQjgwl("ab", 4)` is `"ab  "`.';

test("a coverage entry carries the Objective criterion's exact text", async () => {
  const checkout = tempDir("factory-coverage-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(checkout, "README.md"), "# Text\n");
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
    '<h2>Goal</h2>\n<p>Add <code>padEndQjgwl</code>.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>padEndQjgwl(s, width)</code> puts spaces after <code>s</code> until it is <code>width</code> characters long: <code>padEndQjgwl("ab", 4)</code> is <code>"ab  "</code>.</li>\n</ul>',
    { sources: true },
  );
  const built = await buildFacts({ objective: 8, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const { facts } = built;
  // The planner's coverage entry names its owner and proof, never text; its
  // own prose may collapse the spaces.
  const decoded = decodePlan(
    {
      items: [
        {
          kind: "work",
          id: "padEndQjgwl",
          title: "Add padEndQjgwl",
          goal: "Export padEndQjgwl with its test.",
          acceptance: ['padEndQjgwl("ab", 4) returns "ab ".'],
          nonGoals: ["No other file changes."],
          citations: [{ path: "OBJECTIVE", heading: "" }],
          children: [],
          dependencies: [],
          ownedPaths: ["src/padEndQjgwl.js", "test/padEndQjgwl.test.js"],
          newPackages: [],
          priority: 0,
          resources: [],
          scheduling: null,
          validation: ["node --test test/padEndQjgwl.test.js"],
          brief: "Pad on the right with spaces.",
          oneOutcomeReason: null,
          sourceAssets: [],
          media: null,
        },
      ],
      coverage: [
        {
          itemId: "padEndQjgwl",
          proof: { kind: "result-command", validationIndex: 0 },
          environment: null,
        },
      ],
      sourceObligations: [],
      requiredPreIntegrationChecks: [],
      cannotPlan: null,
      decisionRequired: null,
    },
    facts,
  );
  assert.deepEqual(decoded.findings, []);
  const [entry] = decoded.plan.coverage;
  assert.equal(entry.source.text, CRITERION);
  // The pinned Objective review reads says the same.
  const objective = facts.sources.find((source) => source.path === "OBJECTIVE");
  assert.ok(objective.content.includes(entry.source.text));
  assert.deepEqual(validateGraph(decoded.plan, facts).findings, []);
});
