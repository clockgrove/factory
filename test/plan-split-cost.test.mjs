// The planner splits a dependent item at its contract (#2293). In a 0.5.12
// run a client item waited 2 h 17 min for all of its upstream item though
// one of its 8 entries needed it.
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

const ISSUE = 90;

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

async function factsWith(itemCosts) {
  const checkout = tempDir("factory-split-cost-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
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
  const built = await buildFacts({
    objective: ISSUE,
    shown: readShown(
      "<h2>Goal</h2>\n<p>Stream events.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>Subscribers receive every event.</li>\n</ul>",
      { sources: true },
    ),
    base: git(checkout, "rev-parse", "HEAD"),
    checkout,
    itemCosts,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return built.facts;
}

test("planner and plan review split a dependent item at its contract, and only where the split pays", async () => {
  const facts = await factsWith("");
  const planner = renderCompilationCall({
    facts,
    data: { instructions: "" },
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  const reviewer = renderGraphReviewCall({
    facts,
    draft: { items: [], coverage: [] },
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  const check3 = reviewer.indexOf("3. Decomposition and ownership.");
  const check4 = reviewer.indexOf("4. Phases.");
  for (const rule of [
    "when a dependent item's work divides into contract-level work (against a contract already settled in the repository or in supplied briefs, testable without the dependency's implementation) and an end-to-end proof that needs that implementation, plan two items, the contract-level one depending only on what it truly needs and a smaller proof item depending on both.",
    "Flag a dependency edge when most of the dependent's acceptance entries are provable against an already-settled contract, naming the contract-level item and the proof item to split it into.",
    "Do not split when handoff, preparation and review cost more than the overlap saves, or when the dependent needs the upstream implementation throughout.",
    "A harness that an upstream item and an end-to-end proof need, but contract-level work does not, belongs to the upstream item or the proof item, so it does not make the contract-level item wait.",
  ]) {
    const at = reviewer.indexOf(rule);
    assert.ok(check3 < at && at < check4, rule);
    // The planner checks its plan by the same rule.
    assert.ok(planner.includes(rule), rule);
  }
});
