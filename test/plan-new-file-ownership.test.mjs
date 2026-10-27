// An item owns the new test file it creates by its literal path. In run
// 2026-10-27T034728PDT-f46b (#2108) Codex's graph reviewer applied the
// new-identifier rule to ownedPaths: it refused `test/cube-assets.test.js`
// as an invented name, `test/` as too broad and dropping the test, so the
// planner had no valid answer and returned cannotPlan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
} from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const OWNED_NEW_FILES =
  'The rule is for acceptance and briefs, not ownedPaths: an item owns each new file it creates, a new test file included, by the literal path the planner chooses for it, or by a directory prefix ending in "/" where the ownership rule allows one, and neither is a new-identifier finding.';

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

test("the planner and the graph reviewer keep the new-identifier rule out of ownedPaths, so a new test file has an owner", async () => {
  const checkout = tempDir("factory-new-file-ownership-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: "node --test" } }),
  );
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
    "<h2>Goal</h2>\n<p>Deliver a cube asset with a test.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>npm test</code> passes.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({ objective: 5, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const { facts } = built;
  const planner = renderCompilationCall({
    facts,
    data: {},
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  const reviewer = renderGraphReviewCall({
    facts,
    draft: { items: [] },
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  for (const prompt of [planner, reviewer]) {
    // The reviewer's check 8 and the planner's checklist quote the rule.
    const rule = prompt.indexOf(
      "Flag acceptance or a brief that names a NEW identifier",
    );
    assert.notEqual(rule, -1);
    assert.equal(prompt.indexOf(OWNED_NEW_FILES, rule) > rule, true);
    assert.ok(
      prompt.includes(
        "Identifiers: acceptance and briefs (not ownedPaths, which name each file literally) name only identifiers that already exist at the base",
      ),
    );
  }
  assert.ok(
    planner.includes(
      "Own each new file an item creates, a new test file included, by the literal path you choose for it.",
    ),
  );
});
