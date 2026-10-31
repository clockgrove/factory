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
import { BaseFiles, buildFacts } from "../dist/planning/facts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base whose attributes route PNG and glTF binaries through LFS, with one PNG already tracked and an `npm test` script. */
function base() {
  const directory = tempDir("factory-media-roles-");
  git(directory, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(directory, ".gitattributes"),
    "*.png filter=lfs diff=lfs merge=lfs -text\n*.glb filter=lfs diff=lfs merge=lfs -text\n",
  );
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: "node --test" } }),
  );
  writeFileSync(join(directory, "README.md"), "# Target\n");
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

// Run 5093's Objective as its issue showed it (cube.md with ID Qpsry).
const RUN_5093 = readShown(
  "<h2>Goal</h2>\n<p>Add a 3D model of a unit cube for the demo scene, with a small preview image: the model <code>assets/cubeQpsry.glb</code>, its preview <code>assets/cubeQpsry-preview.png</code>, and a new test of those two delivered files. Offer two candidate sets in different colours so the operator can pick one; only the picked set is delivered. Change no files besides the two assets and the new test.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>assets/cubeQpsry.glb</code> is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.</li>\n<li><code>assets/cubeQpsry-preview.png</code> is a 64x64 PNG preview of the cube.</li>\n<li>Both are stored in Git LFS.</li>\n<li><code>npm test</code> passes.</li>\n</ul>",
  { sources: true },
);

const refusal = (id, paths) => ({
  itemId: id,
  message: `Work Item ${id} owns ${paths}, which the Objective names, the base lacks and the base's .gitattributes routes through Git LFS (lfsRules lists its filter=lfs rules), yet no Work Item declares media. A new Git LFS file the Objective asks for is media: Factory captures it in candidate sets, asks the operator to select one when there are several, and delivers only the selection. Declare media on the item that makes it: one expected output role per file, and minimumAssetSets the number of candidate sets the Objective asks for, or 1 when it asks for none`,
});

test("run 5093's accepted plan is refused for this alone, and the media plan that answers the finding passes every plan check", async () => {
  const target = base();
  const built = await buildFacts({
    objective: 1,
    shown: RUN_5093,
    base: target.commit,
    checkout: target.directory,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const owned = [
    "assets/cubeQpsry.glb",
    "assets/cubeQpsry-preview.png",
    "test/cube-assets.test.js",
  ];
  const fields = {
    nonGoals: ["Change no other files."],
    citations: [{ path: "README.md" }],
  };
  const coverage = built.facts.blocks
    .filter((block) => block.kind === "item")
    .map((block) => ({
      source: { path: "OBJECTIVE", text: block.text },
      itemId: "CubeAssets",
      proof: { kind: "result-command", validationIndex: 0 },
      environment: {
        kind: "local",
        readiness: "available",
        probe: "",
        preparedBy: "",
      },
    }));
  assert.equal(coverage.length, 4);
  const check = async (spec) =>
    (
      await checkPlan(
        {
          base: target.commit,
          items: [item("CubeAssets", owned, spec)],
          coverage,
          finalCommands: [],
          decisions: [],
        },
        built.facts,
        new BaseFiles(target.directory, target.commit),
      )
    ).map(({ itemId, message }) => ({ itemId, message }));
  assert.deepEqual(await check(fields), [
    refusal("CubeAssets", "assets/cubeQpsry.glb, assets/cubeQpsry-preview.png"),
  ]);
  assert.deepEqual(await check({ ...fields, ...MEDIA }), []);
});
