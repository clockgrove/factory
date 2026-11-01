// The planner and the graph reviewer see what the sandbox provisions. Live,
// the reviewer held every Objective with a real-browser command, asking how
// validation gets Chromium, though sandbox.readOnlyPaths mounted the browser
// directory and sandbox.environment.PLAYWRIGHT_BROWSERS_PATH named it: the
// local executable observations held only command executables (#2337).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  observeLocalExecutables,
  sandboxProvisioning,
} from "../dist/planning/executables.js";
import { buildFacts } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
} from "../dist/planning/prompts.js";
import { planningReviewEvidence } from "../dist/planning/review.js";
import { SANDBOX_PROVISIONING } from "../dist/planning/rubric.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

test("the sandbox's mounts and path variables reach the planner and the graph reviewer; a missing mount shows as missing", async () => {
  const checkout = tempDir("factory-provisioning-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(checkout, "README.md"), "# Browser\n");
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
  const host = tempDir("factory-provisioned-");
  const browsers = join(host, "ms-playwright");
  mkdirSync(browsers);
  const absent = join(host, "absent");
  const unmounted = join(host, "unmounted");
  mkdirSync(unmounted);

  const sandbox = sandboxProvisioning(
    {
      readOnlyPaths: [browsers, absent],
      environment: {
        PLAYWRIGHT_BROWSERS_PATH: browsers,
        TOOL_HOME: join(absent, "tool"),
        HOST_CACHE: unmounted,
        CI: "true",
        NPM_TOKEN: "/not/shown",
      },
    },
    ["NPM_TOKEN"],
  );
  assert.deepEqual(sandbox, {
    readOnlyPaths: [
      { path: browsers, exists: true },
      { path: absent, exists: false },
    ],
    environment: [
      {
        name: "PLAYWRIGHT_BROWSERS_PATH",
        path: browsers,
        exists: true,
        mounted: true,
      },
      {
        name: "TOOL_HOME",
        path: join(absent, "tool"),
        exists: false,
        mounted: false,
      },
      { name: "HOST_CACHE", path: unmounted, exists: true, mounted: false },
      { name: "CI" },
    ],
  });

  const local = await observeLocalExecutables({
    checkout,
    base,
    blocks: [],
    finalCommands: ["npx playwright test"],
    sandbox,
  });
  assert.deepEqual(local.observations.sandbox, sandbox);
  const facts = JSON.stringify(sandbox);

  const evidence = planningReviewEvidence({
    sources: [],
    localExecutables: local.observations,
  });
  const row = evidence.find(
    (entry) => entry.path === "FACTORY_LOCAL_EXECUTABLE_OBSERVATIONS",
  );
  assert.ok(row.content.includes(facts));

  const built = await buildFacts({
    objective: 5,
    shown: readShown(
      "<h2>Goal</h2>\n<p>Check the page in a real browser.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>npx playwright test</code> passes on the integrated result.</li>\n</ul>",
      { sources: true },
    ),
    base,
    checkout,
    ciOnlyCommands: [],
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const reviewer = renderGraphReviewCall({
    facts: built.facts,
    draft: { items: [] },
    evidence,
    decisions: [],
    finalCommands: ["npx playwright test"],
    controllerCapabilities: {},
  }).prompt;
  const planner = renderCompilationCall({
    facts: built.facts,
    data: {},
    revising: false,
    localExecutables: local.observations,
    lookups: { open: false, bodies: [] },
  }).prompt;
  for (const [role, prompt] of Object.entries({ reviewer, planner })) {
    assert.ok(prompt.includes(SANDBOX_PROVISIONING), role);
    assert.ok(prompt.includes(facts), role);
    assert.doesNotMatch(prompt, /not\/shown|NPM_TOKEN/, role);
  }
});
