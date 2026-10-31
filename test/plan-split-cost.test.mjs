// The planner splits a dependent item at its contract (#2293) and sizes
// items against what this installation's past items cost (#2286). In a
// 0.5.12 run a client item waited 2 h 17 min for all of its upstream item
// though one of its 8 entries needed it; and the size guidance rested on
// judgment, not on what items had taken.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import { itemCostSummary, pastItems } from "../dist/planning/item-costs.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
} from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { installation, item, plan, seed, tempDir } from "./helpers.mjs";

const ISSUE = 90;
const STARTED = "2026-03-01T10:00:00.000Z";
const at = (minutes) =>
  new Date(Date.parse(STARTED) + minutes * 60_000).toISOString();

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

/** One item's merged run: its work, `runs` validation runs, a repair when `repairs`, and an accepted review, `minutes` in all. */
function ran(id, minutes, runs, repairs) {
  const step = (phase, from, to, extra = {}) => [
    { at: at(from), step: `item:${id}:${phase}`, event: "start" },
    { at: at(to), step: `item:${id}:${phase}`, event: "outcome", ...extra },
  ];
  return [
    ...step("work", 0, minutes - 2, { outcome: "done" }),
    ...Array.from({ length: runs }, (_, n) => ({
      at: at(minutes - 2),
      step: `item:${id}:validate`,
      event: "validation-result",
      command: "npm test",
      passed: n === runs - 1,
      durationMs: 1000,
    })),
    ...Array.from({ length: repairs }, () => ({
      at: at(minutes - 2),
      step: `item:${id}:validate`,
      event: "outcome",
      outcome: "repair",
      target: `item:${id}:work`,
    })),
    ...step("review", minutes - 2, minutes, { outcome: "done" }),
    {
      at: at(minutes),
      step: `item:${id}:work`,
      event: "model-usage",
      item: id,
      role: "worker",
      tokens: { total: minutes * 1000 },
    },
  ];
}

test("past items' cost reaches the planner and plan review as a bounded summary of derived counts", async () => {
  const inst = installation();
  // Six merged items: entries, paths, minutes, validation runs, repairs. The
  // last took 200 minutes, past twice the median of 27.5; the QA item and the
  // one that was never accepted say nothing about a result's cost.
  const rows = [
    ["a", 3, 1, 20, 2, 0],
    ["b", 4, 2, 20, 3, 0],
    ["c", 6, 3, 25, 4, 1],
    ["d", 6, 3, 30, 5, 1],
    ["e", 9, 4, 40, 8, 2],
    ["f", 9, 5, 200, 30, 3],
  ];
  const items = [
    ...rows.map(([id, entries, paths]) =>
      item(id, {
        acceptance: Array.from({ length: entries }, (_, n) => `Entry ${n}.`),
        ownedPaths: Array.from({ length: paths }, (_, n) => `src/${id}${n}.ts`),
      }),
    ),
    item("qa", { kind: "qa" }),
    item("never", { acceptance: ["Entry."] }),
  ];
  seed(inst, ISSUE, "done", {
    startedAt: STARTED,
    done: { plan: plan(items) },
  });
  const dir = join(inst.logs, String(ISSUE));
  mkdirSync(dir, { recursive: true });
  const events = [
    ...rows.flatMap(([id, , , minutes, runs, repairs]) =>
      ran(id, minutes, runs, repairs),
    ),
    { at: at(1), step: "item:never:work", event: "start" },
  ];
  writeFileSync(
    join(dir, "2026-03-01T10-00-00-000Z-4242.jsonl"),
    events
      .map((event) => JSON.stringify(event))
      .join("\n")
      .concat("\n"),
  );

  const summary = itemCostSummary(pastItems(inst.objectives, inst.logs));
  assert.equal(
    summary,
    [
      "Measured cost of 6 Work Items this installation completed (in its newest done Objectives; wall time runs from an item's first step to its last event). Facts about past items, not limits or targets.",
      "Median: 6 acceptance entries, 3 owned paths, 27 min wall time, 28K tokens, 5 validation runs, 1 repair.",
      "Up to 5 acceptance entries: 2 items, median 20 min, 3 validation runs, 0 repairs.",
      "More than 5: 4 items, median 35 min, 7 validation runs, 2 repairs.",
      "Items that took at least 2 times the median wall time, longest first:",
      "- 9 acceptance entries, 5 owned paths, 3 h 20 min wall time, 200K tokens, 30 validation runs, 3 repairs",
    ].join("\n"),
  );
  // Fewer than five items measured: nothing to summarize.
  assert.equal(
    itemCostSummary(pastItems(inst.objectives, inst.logs).slice(0, 4)),
    "",
  );

  const facts = await factsWith(summary);
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
  for (const prompt of [planner, reviewer]) {
    assert.ok(prompt.includes("Past Work Item cost (derived from"));
    assert.ok(prompt.includes(summary));
    assert.ok(
      prompt.includes(
        "Where the request lists the measured cost of this installation's past Work Items, judge that cost against it",
      ),
    );
  }
  const bare = renderCompilationCall({
    facts: await factsWith(""),
    data: { instructions: "" },
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(!bare.includes("Past Work Item cost (derived from"));
});

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
