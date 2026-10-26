// The graph reviewer judges validation with the network the installation
// gives it. The Claude prd run's hostnet case (sandbox.network host) planned
// its loopback `curl` in a QA item's validation, as the planner was told it
// could; plan review refused it twice because its Work Item standard said
// validation has no network, and the Objective held until its answers ran out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import { renderGraphReviewCall } from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

async function graphReviewPrompt(checkout, base, hostNetwork) {
  const shown = readShown(
    "<h2>Goal</h2>\n<p>Serve a readiness file.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>curl -sf http://127.0.0.1:18650/ready</code> succeeds on the integrated result.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({
    objective: 4,
    shown,
    base,
    checkout,
    hostNetwork,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return renderGraphReviewCall({
    facts: built.facts,
    draft: { items: [] },
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
}

test("the graph reviewer is told validation's network: the host's under sandbox.network host, none otherwise", async () => {
  const checkout = tempDir("factory-review-network-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(checkout, "README.md"), "# Ready\n");
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

  const host = await graphReviewPrompt(checkout, base, true);
  assert.ok(
    host.includes(
      "Validation has the host's network (sandbox.network host), including services on its loopback, so a command that reaches the network may run in it.",
    ),
  );
  assert.ok(
    host.includes(
      `Validation environment (differs from hosted CI): {"network":"the host's network (sandbox.network host)",`,
    ),
  );
  assert.doesNotMatch(host, /no network/);

  const off = await graphReviewPrompt(checkout, base, false);
  assert.ok(
    off.includes(
      "A script that runs a network tool (an init, install, fetch or audit) fails in validation, which has no network: never select one.",
    ),
  );
  assert.ok(
    off.includes(
      `Validation environment (differs from hosted CI): {"network":"none except the exact script-disabled package install, which runs first",`,
    ),
  );
  assert.doesNotMatch(off, /host's network/);
});
