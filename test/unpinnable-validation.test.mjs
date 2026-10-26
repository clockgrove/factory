// Validation pins a package script only in its fixed root forms and refuses
// any other npm or pnpm command. A production plan validated an item with
// `npm test -- test/countCharQpgmlc.test.js`; no plan check refused it, so
// the item asked a person at validate after the work was built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles } from "../dist/planning/facts.js";
import { validateTree } from "../dist/validate.js";
import { tempDir } from "./helpers.mjs";

const refused = [
  "npm test -- test/countCharQpgmlc.test.js",
  "pnpm test --watch",
  "npm run lint --silent",
];
const accepted = [
  "npm test",
  "pnpm check",
  "npm run build",
  "npm ci --ignore-scripts",
  "npm --version",
  "node --test test/x.test.js",
];

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function commit(directory, message) {
  git(directory, "add", "-A");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    message,
  );
  return git(directory, "rev-parse", "HEAD");
}

/**
 * A base with root npm scripts, and a candidate without package.json: every
 * package command validation doesn't refuse for its form fails a later pin
 * there, so none runs.
 */
function repository() {
  const directory = tempDir("factory-unpinnable-");
  git(directory, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "target",
      scripts: {
        test: "node --test",
        build: "tsc",
        lint: "eslint .",
        check: "tsc",
      },
    }),
  );
  writeFileSync(
    join(directory, "package-lock.json"),
    JSON.stringify({ name: "target", lockfileVersion: 3, packages: {} }),
  );
  const base = commit(directory, "base");
  spawnSync("git", ["rm", "--quiet", "package.json"], { cwd: directory });
  return { directory, base, candidate: commit(directory, "candidate") };
}

function item(command) {
  return {
    kind: "work",
    id: "CountCharacter",
    title: "Count a character",
    goal: "Add countChar and its test.",
    acceptance: ["countChar counts one character."],
    nonGoals: ["No other files."],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths: ["src/countChar.js", "test/countCharQpgmlc.test.js"],
    validation: [{ command }],
    brief: "Count one character in a string.",
    priority: 1,
  };
}

/** The plan check's findings that this command can't be pinned. */
async function planFindings(target, command) {
  const facts = {
    objective: 3,
    body: "",
    blocks: [],
    base: target.base,
    sources: [],
    packageCommands: ["npm test", "npm run build", "npm run lint"],
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
        base: target.base,
        items: [item(command)],
        coverage: [],
        finalCommands: [],
        decisions: [],
      },
      facts,
      new BaseFiles(target.directory, target.base),
    )
  ).filter((finding) =>
    /pins only those root script forms/.test(finding.message),
  );
}

/** Whether validation refuses this command's form, before anything runs. */
async function validationRefuses(target, command) {
  const work = item(command);
  const result = await validateTree({
    checkout: target.directory,
    repository: "example/target",
    directory: join(target.directory, "..", "unpinnable.validation"),
    commit: target.candidate,
    item: work,
    plan: { base: target.base, items: [work], finalCommands: [] },
    blocks: [],
    sandbox: {},
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(60_000),
    log: () => {},
    runFile: () => assert.fail(`${command} ran`),
  });
  assert.notEqual(result.kind, "passed", command);
  return result.kind === "hold" && /can be pinned/.test(result.question);
}

test("the plan check refuses a validation command that runs npm or pnpm outside the pinned forms", async () => {
  const target = repository();
  for (const command of refused) {
    const [finding, ...more] = await planFindings(target, command);
    assert.equal(more.length, 0, command);
    assert.equal(finding?.itemId, "CountCharacter", command);
    assert.equal(finding.kind, undefined);
    assert.match(finding.message, /`npm test`, `pnpm test`, `pnpm check`/);
    assert.match(finding.message, /root package scripts: `npm test`/);
  }
  for (const command of accepted)
    assert.deepEqual(await planFindings(target, command), [], command);
});

// A command without npm or pnpm has no package pin, so validation would run it.
test("the plan check refuses exactly the package commands validation refuses", async () => {
  const target = repository();
  for (const command of [...refused, ...accepted].filter((c) =>
    /\b(?:npm|pnpm)\b/.test(c),
  ))
    assert.equal(
      (await planFindings(target, command)).length > 0,
      await validationRefuses(target, command),
      command,
    );
});
