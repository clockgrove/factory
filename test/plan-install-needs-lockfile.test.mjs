// The plan check refuses a package install whose manager's lockfile the base
// doesn't track (#2317). A plan put `npm ci --ignore-scripts` first in a
// repository with no package-lock.json; validation held the item there and
// the replan ran planning out of revisions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import {
  BaseFiles,
  commandInstructions,
  PINNED_NPM_BOOTSTRAP,
  PINNED_PNPM_BOOTSTRAP,
} from "../dist/planning/facts.js";
import { shownBlocks } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base commit holding package.json and `lockfiles`. */
function target(lockfiles) {
  const directory = tempDir("factory-install-lockfile-");
  git(directory, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(directory, "package.json"),
    '{"scripts":{"test":"node --test"}}\n',
  );
  for (const name of lockfiles) writeFileSync(join(directory, name), "{}\n");
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

function facts(base) {
  return {
    objective: 1,
    body: "",
    blocks: shownBlocks(
      "<h2>Goal</h2><p>Run the tests.</p><h2>Acceptance</h2><ul><li>The tests pass.</li></ul>",
      { sources: true },
    ),
    base: base.commit,
    sources: [],
    packageCommands: ["npm test"],
    ciOnlyCommands: [],
    checkNames: [],
    integratedCheckNames: [],
    fixedScripts: [],
    coverageObligations: [],
    playbook: "",
    localAssetRoots: [],
    lfsRules: [],
  };
}

function item(command) {
  return {
    kind: "work",
    id: "tests",
    title: "Tests",
    goal: "Run the tests.",
    acceptance: ["`npm test` passes."],
    nonGoals: ["No other files."],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths: ["src/"],
    validation: [{ command }, { command: "npm test", after: [0] }],
    brief: "Run the tests.",
    priority: 1,
  };
}

async function findings(base, command, accepted) {
  const draft = (items) => ({
    base: base.commit,
    items,
    coverage: [],
    finalCommands: [],
    decisions: [],
  });
  return (
    await checkPlan(
      draft([item(command)]),
      facts(base),
      new BaseFiles(base.directory, base.commit),
      accepted && draft([]),
      accepted && draft([]),
    )
  ).filter((finding) => /tracked at the base/.test(finding.message));
}

test("a package install without its manager's tracked lockfile is refused, naming what would pass; with it, accepted", async () => {
  const bare = target([]);
  for (const [command, lockfile] of [
    [PINNED_NPM_BOOTSTRAP, "package-lock.json"],
    [PINNED_PNPM_BOOTSTRAP, "pnpm-lock.yaml"],
  ]) {
    // Both first planning and an amendment judge it.
    for (const accepted of [false, true]) {
      const [refused, ...rest] = await findings(bare, command, accepted);
      assert.deepEqual(rest, []);
      assert.equal(refused.itemId, "tests");
      assert.ok(refused.message.includes(`needs ${lockfile}`));
      assert.match(refused.message, /Drop the install command/);
      assert.match(refused.message, /track .* first/);
    }
  }
  // Another manager's lockfile doesn't stand in for it.
  assert.equal(
    (await findings(target(["pnpm-lock.yaml"]), PINNED_NPM_BOOTSTRAP)).length,
    1,
  );
  assert.deepEqual(
    await findings(target(["package-lock.json"]), PINNED_NPM_BOOTSTRAP),
    [],
  );
  assert.deepEqual(
    await findings(target(["pnpm-lock.yaml"]), PINNED_PNPM_BOOTSTRAP),
    [],
  );
  // The planner request carries the fact.
  const request = (base) => commandInstructions(facts(base), base.directory);
  assert.match(await request(bare), /Lockfiles tracked at the base: none/);
  assert.match(
    await request(target(["package-lock.json"])),
    /Lockfiles tracked at the base: package-lock\.json\./,
  );
});
