// Lane Q's Objective held at QA: its scope check diffed the default branch
// from the plan's base, and another Objective's merge had landed between.
// An item's FACTORY_BASE_SHA is the commit it was built on; an integrated
// command names no base, since Factory enforces owned paths itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles } from "../dist/planning/facts.js";
import { validateTree } from "../dist/validate.js";
import { configured, installation, item, REPO } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A commit on `checkout` adding `file`. */
function commit(checkout, file) {
  writeFileSync(join(checkout, file), `${file}\n`);
  git(checkout, "add", file);
  git(checkout, "commit", "--quiet", "-m", file);
  return git(checkout, "rev-parse", "HEAD");
}

test("an item's validation compares with the commit it was built on, not a plan base other Objectives' merges have passed", async () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const { sandbox } = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const checkout = mkdtempSync(join(tmpdir(), "factory-base-"));
  git(checkout, "init", "--quiet");
  const planned = commit(checkout, "base.txt");
  // Another Objective merged, and this item was built on its merge.
  const built = commit(checkout, "other.txt");
  const candidate = commit(checkout, "mine.txt");
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const work = item("a", {
    ownedPaths: ["mine.txt"],
    validation: [
      {
        command: `git diff --exit-code "$FACTORY_BASE_SHA" HEAD -- . ':!mine.txt'`,
      },
    ],
  });
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.validation`,
    commit: candidate,
    item: work,
    plan: { base: planned, items: [work], finalCommands: [] },
    blocks: [],
    base: built,
    predecessor: built,
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: () => {},
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
  });
  assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 800));
});

test("the plan check refuses a QA or integrated command that compares with the plan's base, and leaves a Work Item's own", async () => {
  const target = mkdtempSync(join(tmpdir(), "factory-base-plan-"));
  git(target, "init", "--quiet");
  const base = commit(target, "base.txt");
  const scope = `git diff --exit-code $FACTORY_BASE_SHA HEAD -- . ':!src/a.js'`;
  const items = [
    item("w", {
      kind: "work",
      ownedPaths: ["src/a.js"],
      validation: [{ command: scope }],
    }),
    item("q", {
      kind: "qa",
      dependencies: ["w"],
      validation: [{ command: scope }, { command: "npm test" }],
    }),
    item("p", {
      kind: "qa",
      dependencies: ["w"],
      validation: [
        { command: `git diff --exit-code ${base.slice(0, 12)}... HEAD` },
      ],
    }),
    // Only the command its integrated-command proof selects runs there.
    item("g", {
      kind: "aggregate",
      children: ["w"],
      validation: [
        { command: `git diff --stat ${base} HEAD` },
        { command: `git diff --exit-code ${base} HEAD -- docs` },
      ],
    }),
  ];
  const coverage = [
    {
      source: { path: "OBJECTIVE", text: "Docs stay as they are." },
      itemId: "g",
      proof: { kind: "integrated-command", validationIndex: 1 },
      environment: {
        kind: "local",
        readiness: "available",
        probe: `git diff --exit-code ${base} HEAD -- docs`,
        preparedBy: "",
      },
    },
  ];
  const facts = {
    objective: 1,
    body: "",
    blocks: [],
    base,
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
  const refused = (
    await checkPlan(
      { base, items, coverage, finalCommands: [], decisions: [] },
      facts,
      new BaseFiles(target, base),
    )
  ).filter((finding) => /compares with the plan's base/.test(finding.message));
  assert.deepEqual(
    refused.map(({ itemId, kind, message }) => ({
      itemId,
      kind,
      docs: message.includes("-- docs"),
    })),
    [
      { itemId: "q", kind: undefined, docs: false },
      { itemId: "p", kind: undefined, docs: false },
      { itemId: "g", kind: undefined, docs: true },
    ],
  );
  assert.match(refused[0].message, /\(\$FACTORY_BASE_SHA\)/);
  assert.match(refused[1].message, new RegExp(`\\(${base.slice(0, 12)}\\)`));
  assert.match(refused[0].message, /other Objectives' merges/);
  assert.match(refused[0].message, /enforces each item's owned paths/);
});
