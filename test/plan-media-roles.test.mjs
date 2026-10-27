// A new Git LFS file the Objective names is media. Codex's plan for the
// main suite's media.select-repair case (run 2026-10-27T035432PDT-5093)
// delivered the two cube assets from an item with "media": null, so no
// candidates were captured and the operator never selected a set (#2108).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles } from "../dist/planning/facts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base whose attributes route PNG and glTF binaries through LFS, with one PNG already tracked. */
function base() {
  const directory = tempDir("factory-media-roles-");
  git(directory, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(directory, ".gitattributes"),
    "*.png filter=lfs diff=lfs merge=lfs -text\n*.glb filter=lfs diff=lfs merge=lfs -text\n",
  );
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "assets/logo.png"), "logo\n");
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return { directory, commit: git(directory, "rev-parse", "HEAD") };
}

// The case's Objective (integration/objectives/cube.md), with an existing
// asset and a new document named too.
const OBJECTIVE = readShown(
  "<h2>Goal</h2>\n<p>Add a 3D model of a unit cube, <code>assets/cube.glb</code>, with its preview <code>assets/cube-preview.png</code>, and a new test of those two delivered files. Offer two candidate sets in different colours so the operator can pick one. Keep <code>assets/logo.png</code> and add <code>docs/cube.md</code>.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>assets/cube.glb</code> is a valid glTF 2.0 binary.</li>\n<li><code>npm test</code> passes.</li>\n</ul>",
  { sources: true },
);

function item(id, ownedPaths, fields = {}) {
  return {
    kind: "work",
    id,
    title: id,
    goal: "Deliver the cube.",
    acceptance: ["The delivered cube is a unit cube."],
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths,
    validation: [{ command: "npm test" }],
    brief: "Deliver the cube.",
    ...fields,
  };
}

const MEDIA = {
  expectedOutputRoles: ["model", "preview"],
  minimumAssetSets: 2,
};

async function undeclared(target, ...items) {
  const facts = {
    objective: 1,
    body: OBJECTIVE.body,
    blocks: OBJECTIVE.blocks,
    base: target.commit,
    sources: [],
    packageCommands: ["npm test"],
    ciOnlyCommands: [],
    checkNames: [],
    integratedCheckNames: [],
    fixedScripts: [],
    coverageObligations: [],
    playbook: "",
    localAssetRoots: [],
    lfsRules: [
      ".gitattributes: *.png filter=lfs diff=lfs merge=lfs -text",
      ".gitattributes: *.glb filter=lfs diff=lfs merge=lfs -text",
    ],
  };
  const findings = await checkPlan(
    {
      base: target.commit,
      items,
      coverage: [],
      finalCommands: [],
      decisions: [],
    },
    facts,
    new BaseFiles(target.directory, target.commit),
  );
  return findings
    .filter((finding) => /no Work Item declares media/.test(finding.message))
    .map(({ itemId, message }) => ({ itemId, message }));
}

const refusal = (id, paths) => ({
  itemId: id,
  message: `Work Item ${id} owns ${paths}, which the Objective names, the base lacks and the base's .gitattributes routes through Git LFS (lfsRules lists its filter=lfs rules), yet no Work Item declares media. A new Git LFS file the Objective asks for is media: Factory captures it in candidate sets, asks the operator to select one when there are several, and delivers only the selection. Declare media on the item that makes it: one expected output role per file, and minimumAssetSets the number of candidate sets the Objective asks for, or 1 when it asks for none`,
});

test("a plan that delivers the Objective's new Git LFS files with no media roles is refused, naming those files", async () => {
  const target = base();
  // Run 5093's accepted plan: the assets and their test, media null.
  assert.deepEqual(
    await undeclared(
      target,
      item("CubeAssets", [
        "assets/cube.glb",
        "assets/cube-preview.png",
        "test/cube-assets.test.js",
      ]),
    ),
    [refusal("CubeAssets", "assets/cube.glb, assets/cube-preview.png")],
  );
  // A directory it owns covers the named files too.
  assert.deepEqual(
    await undeclared(target, item("CubeAssets", ["assets/", "test/"])),
    [refusal("CubeAssets", "assets/cube.glb, assets/cube-preview.png")],
  );
  // Each owner is named, with only the files it owns.
  assert.deepEqual(
    await undeclared(
      target,
      item("Model", ["assets/cube.glb"]),
      item("Preview", ["assets/cube-preview.png"]),
    ),
    [
      refusal("Model", "assets/cube.glb"),
      refusal("Preview", "assets/cube-preview.png"),
    ],
  );
});

test("plans with media roles, or whose named files are tracked, unrouted or unowned, pass the media-roles check", async () => {
  const target = base();
  // The plan the case needs: the assets as media, the test as ordinary work.
  assert.deepEqual(
    await undeclared(
      target,
      item(
        "CubeAssets",
        ["assets/cube.glb", "assets/cube-preview.png", "test/cube.test.js"],
        MEDIA,
      ),
    ),
    [],
  );
  // Once any item declares media, the check refuses nothing: whether the
  // Objective asks for a choice is prose it doesn't read.
  assert.deepEqual(
    await undeclared(
      target,
      item("Model", ["assets/cube.glb"], {
        expectedOutputRoles: ["model"],
        minimumAssetSets: 2,
      }),
      item("Preview", ["assets/cube-preview.png"]),
    ),
    [],
  );
  // A named file the base already tracks, a new one no rule routes, and a
  // new routed file the Objective doesn't name are ordinary work.
  assert.deepEqual(
    await undeclared(
      target,
      item("Logo", ["assets/logo.png"]),
      item("Docs", ["docs/cube.md"]),
      item("Extra", ["assets/extra.png"]),
    ),
    [],
  );
});
