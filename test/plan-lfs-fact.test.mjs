// Planning is told that validation checkouts hold real Git LFS bytes. The
// Claude qualifier's media.select-repair case planned a QA item that read
// the selected model's bytes; the graph reviewer, told only that hydration
// pulls LFS objects after the Final commands, asked the operator for five
// rounds whether QA and final saw pointer files, and planning ran out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts, commandInstructions } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
} from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const LFS = `"lfs":"every Git LFS file holds its real bytes before any command runs, in Work Item, QA, integrated and final validation alike; Factory fetches missing objects outside the sandbox, so commands read content, never pointers, and need not reach a network for it"`;

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

test("the planner and the graph reviewer are told validation restores Git LFS bytes, with or without the host's network", async () => {
  const checkout = tempDir("factory-lfs-fact-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, ".gitattributes"),
    "*.glb filter=lfs diff=lfs merge=lfs -text\n",
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
    "<h2>Goal</h2>\n<p>Ship a cube model.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>assets/cube.glb</code> is a binary glTF file.</li>\n</ul>",
    { sources: true },
  );
  for (const hostNetwork of [true, false]) {
    const built = await buildFacts({
      objective: 4,
      shown,
      base,
      checkout,
      hostNetwork,
    });
    assert.ok(built.facts, JSON.stringify(built.problems));
    const { facts } = built;
    const planner = renderCompilationCall({
      facts,
      data: { instructions: await commandInstructions(facts, checkout) },
      revising: false,
      lookups: { open: false, bodies: [] },
    }).prompt;
    // The planner's instructions are a JSON string in its data.
    assert.ok(planner.includes(JSON.stringify(LFS).slice(1, -1)), hostNetwork);
    const reviewer = renderGraphReviewCall({
      facts,
      draft: { items: [] },
      evidence: [],
      decisions: [],
      finalCommands: [],
      controllerCapabilities: {},
    }).prompt;
    assert.ok(reviewer.includes(LFS), hostNetwork);
  }
});
