// An owned path is a file's literal name. The media case's plan owned
// "test/<worker-chosen-new-test-file>"; the worker named its test, which
// that path didn't own, and the item asked a person which path to use.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles } from "../dist/planning/facts.js";
import { validateGraph } from "../dist/planning/graph.js";
import { tempDir } from "./helpers.mjs";

const base = "0".repeat(40);

function item(ownedPaths) {
  return {
    kind: "work",
    id: "CubeAssets",
    title: "Cube assets",
    goal: "Add the cube model, its preview and a test.",
    acceptance: ["`npm test` passes."],
    nonGoals: ["No other files."],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths,
    validation: [{ command: "npm test" }],
    brief: "Stage two colour sets for the operator to pick from.",
    priority: 1,
  };
}

function findings(ownedPaths) {
  const draft = {
    base,
    items: [item(ownedPaths)],
    coverage: [],
    requiredPreIntegrationChecks: [],
    finalCommands: [],
    decisions: [],
  };
  return validateGraph(draft, {
    base,
    body: "",
    sources: [],
    coverageObligations: [],
    integratedCheckNames: [],
  }).findings.filter((f) => /invalid ownership path/.test(f.message));
}

test("a placeholder is no owned path; the file's own name is", () => {
  const [refused] = findings(["test/<worker-chosen-new-test-file>"]);
  assert.match(refused.message, /not a placeholder/);
  assert.deepEqual(findings(["test/cubeQmnan.test.js", "assets/"]), []);
});

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base commit holding `files`. */
function baseWith(files) {
  const directory = tempDir("factory-owned-");
  git(directory, "init", "--quiet", "--initial-branch=main");
  for (const file of files) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), "x\n");
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

async function exportFindings(target, ownedPaths) {
  const facts = {
    objective: 1,
    body: "",
    blocks: [],
    base: target.commit,
    sources: [],
    packageCommands: [],
    ciOnlyCommands: [],
    checkNames: [],
    integratedCheckNames: [],
    fixedScripts: [],
    coverageObligations: [],
    playbook: "",
    localAssetRoots: [],
    lfsRules: [],
  };
  return (
    await checkPlan(
      {
        base: target.commit,
        items: [item(ownedPaths)],
        coverage: [],
        finalCommands: [],
        decisions: [],
      },
      facts,
      new BaseFiles(target.directory, target.commit),
    )
  )
    .map((finding) => finding.message)
    .filter((message) => /read directory's copy/.test(message));
}

// The crash lane's two-item plan owned "repository/src/chainBase….js": the
// planner reads the base as repository/ in its read directory. The worker
// wrote src/chainBase….js, outside that ownership, and the item asked a person.
test("an owned path under the planner's repository/ export is refused unless the base has one", async () => {
  const plain = baseWith(["src/a.js"]);
  const [refused] = await exportFindings(plain, [
    "repository/src/chainBase.js",
  ]);
  assert.match(refused, /own "src\/chainBase\.js"/);
  assert.deepEqual(await exportFindings(plain, ["src/chainBase.js"]), []);
  const own = baseWith(["repository/index.js"]);
  assert.deepEqual(await exportFindings(own, ["repository/index.js"]), []);
});
