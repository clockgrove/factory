// A worker's discovery: what it proposes in .factory-discovery.json,
// collected as private staging and proposed as amendment
// worker-<item>-<attempt>. The worker's output is fixed here: after the
// plan was accepted, a person landed a test on main that needs a file no
// item owns once the item's own file exists, and the worker proposes that
// file in scope instead of changing it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { discoveryOutcome } from "../dist/work/amend.js";
import { collect } from "../dist/work/collect.js";
import { configured, installation, item, plan, REPO } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function loaded() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return loadConfig(REPO);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const MANIFEST = ".factory-discovery.json";
const work = item("feature", { ownedPaths: ["src/feature.js"] });
const discovery = {
  scope: "in-scope",
  reason:
    "test/feature.test.js, landed on main after the plan, needs src/companion.js once src/feature.js exists",
  evidence: [
    "npm test fails: test/feature.test.js cannot find module ../src/companion.js",
  ],
  ownership: ["src/companion.js"],
  acceptance: ["src/companion.js exports companion, and npm test passes"],
  dependencies: [],
};

/** A worktree on main with the person's test, as the worker starts from. */
function personsMain() {
  const worktree = join(mkdtempSync(join(tmpdir(), "factory-discovery-")), "w");
  mkdirSync(join(worktree, "test"), { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "README.md"), "base\n");
  writeFileSync(
    join(worktree, "test", "feature.test.js"),
    'const { existsSync } = require("node:fs");\nif (existsSync(`${__dirname}/../src/feature.js`)) require("../src/companion.js");\n',
  );
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "person: feature test");
  return { worktree, base: git(worktree, "rev-parse", "HEAD") };
}

/** The worker's owned file. */
function ownedChange(worktree) {
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.js"), "exports.feature = 1;\n");
}

const { sandbox, planning } = loaded();
const collectIn = (worktree, base, finalResponse = "") =>
  collect({
    worktree,
    base,
    plan: { items: [work] },
    item: work,
    mayChange: [],
    playbook: planning.playbook,
    sandbox,
    finalResponse,
    signal: AbortSignal.timeout(60_000),
  });

/** The state of an Objective whose plan of `work` was accepted, at `attempt`. */
function accepted(attempt = 1, kept = {}) {
  return {
    issue: 7,
    holds: [],
    answers: {},
    retries: {},
    attempts: {},
    repairs: attempt > 1 ? { "item:feature:work": { count: attempt - 1 } } : {},
    done: { plan: plan([work]) },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z", ...kept },
  };
}

const contextOf = (state, logged = []) => ({
  state,
  signal: AbortSignal.timeout(60_000),
  log: (event) => logged.push(event),
});

test("an owned change with an in-scope discovery is collected with it, and the manifest is never committed", async () => {
  const { worktree, base } = personsMain();
  ownedChange(worktree);
  // Only the six discovery fields are read; anything else is dropped.
  writeFileSync(
    join(worktree, MANIFEST),
    JSON.stringify({
      ...discovery,
      worker: { itemId: "other", attempt: 9 },
    }),
  );
  const collected = await collectIn(worktree, base);
  assert.equal(collected.kind, "collected", collected.finding);
  assert.deepEqual(collected.discovery, discovery);
  assert.equal(git(worktree, "rev-parse", "HEAD^"), base);
  assert.deepEqual(
    git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"),
    ["src/feature.js"],
  );
  assert.doesNotMatch(
    git(worktree, "ls-tree", "-r", "--name-only", "HEAD"),
    /factory-discovery/,
  );
  assert.ok(!existsSync(join(worktree, MANIFEST)), "the manifest is removed");
});

test("a tracked or invalid discovery manifest is a repair about the discovery, and nothing is committed", async () => {
  const { worktree, base } = personsMain();
  ownedChange(worktree);
  const manifest = join(worktree, MANIFEST);
  const refused = async (pattern) => {
    const outcome = await collectIn(worktree, base);
    assert.equal(outcome.kind, "repair");
    assert.equal(outcome.staging, "discovery");
    assert.match(outcome.finding, pattern);
    assert.equal(outcome.discovery, undefined);
    assert.equal(git(worktree, "rev-parse", "HEAD"), base);
  };
  for (const [content, pattern] of [
    ["{ not json", /^Discovery manifest is not JSON: /],
    [
      { ...discovery, scope: "later" },
      /^Discovery requires explicit scope \(in-scope or backlog\) and reason$/,
    ],
    [{ ...discovery, reason: " " }, /requires explicit scope/],
    [{ ...discovery, ownership: [] }, /^Discovery lacks ownership: /],
    [{ ...discovery, evidence: ["ok", ""] }, /^Discovery lacks evidence: /],
    [
      { ...discovery, dependencies: undefined },
      /^Discovery lacks dependencies/,
    ],
  ]) {
    writeFileSync(
      manifest,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    await refused(pattern);
  }
  // A link, even to a valid manifest, is not a regular file.
  const elsewhere = join(worktree, "..", "discovery.json");
  writeFileSync(elsewhere, JSON.stringify(discovery));
  rmSync(manifest);
  symlinkSync(elsewhere, manifest);
  await refused(/^Discovery manifest must be a regular private staging file$/);
  // Staged, it would be committed: it must stay untracked.
  rmSync(manifest);
  writeFileSync(manifest, JSON.stringify(discovery));
  git(worktree, "add", "--force", MANIFEST);
  await refused(/^Discovery manifest must be untracked private staging$/);
  // Untracked again, the same manifest is collected.
  git(worktree, "rm", "--quiet", "--cached", MANIFEST);
  const collected = await collectIn(worktree, base);
  assert.equal(collected.kind, "collected", collected.finding);
  assert.deepEqual(collected.discovery, discovery);
});

test("a worker that stopped without a change carries its discovery on the no-change repair", async () => {
  const { worktree, base } = personsMain();
  writeFileSync(join(worktree, MANIFEST), JSON.stringify(discovery));
  const outcome = await collectIn(
    worktree,
    base,
    "Stopped: src/companion.js is unowned.",
  );
  assert.equal(outcome.kind, "repair");
  assert.equal(
    outcome.finding,
    "Worker produced no repository change. Worker's final response: Stopped: src/companion.js is unowned.",
  );
  assert.equal(outcome.staging, undefined);
  assert.deepEqual(outcome.discovery, discovery);
  assert.equal(git(worktree, "rev-parse", "HEAD"), base);
});

test("a collected in-scope discovery is proposed as amendment worker-<item>-<attempt>, waits for it, and starts a new attempt once accepted", async () => {
  const { worktree, base } = personsMain();
  ownedChange(worktree);
  writeFileSync(join(worktree, MANIFEST), JSON.stringify(discovery));
  const collected = await collectIn(worktree, base);
  assert.equal(collected.kind, "collected", collected.finding);
  const state = accepted(1, { "item:feature:base": base });
  const keep = { "item:feature:base": base };
  const proposed = discoveryOutcome(
    work,
    contextOf(state),
    undefined,
    collected,
    keep,
  );
  assert.equal(proposed.kind, "retry");
  assert.equal(proposed.reason, "Proposed amendment worker-feature-1");
  assert.equal(proposed.progress, true);
  const proposal = proposed.keep["amend:worker-feature-1:proposal"];
  assert.equal(proposal.id, "worker-feature-1");
  assert.equal(proposal.actor, "Work Item feature's worker");
  assert.equal(proposal.plan, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(proposal.discovery, discovery);
  assert.deepEqual(proposal.worker, { itemId: "feature", attempt: 1 });
  // Kept for the attempt, since collection deleted the file.
  assert.deepEqual(proposed.keep["item:feature:discovered"], {
    attempt: 1,
    discovery,
  });
  assert.equal(proposed.keep["item:feature:base"], base);

  // Taken in, it waits for its amendment, from the kept discovery alone.
  Object.assign(state.kept, proposed.keep);
  const again = { ...collected, discovery: undefined };
  const waits = discoveryOutcome(
    work,
    contextOf(state),
    undefined,
    again,
    keep,
  );
  assert.equal(waits.kind, "retry");
  assert.equal(waits.reason, "Waits for amendment worker-feature-1");
  assert.equal(waits.afterMs, 60_000);

  // Accepted: a free repair on the amended plan, replaying the change.
  const companion = item("companion", { ownedPaths: ["src/companion.js"] });
  state.done["amend:worker-feature-1"] = {
    plan: plan([work, companion]),
    answer: {},
  };
  const amended = discoveryOutcome(
    work,
    contextOf(state),
    undefined,
    again,
    keep,
  );
  assert.equal(amended.kind, "repair");
  assert.equal(amended.target, "item:feature:work");
  assert.deepEqual(amended.free, { target: "item:feature:work", repair: 1 });
  assert.match(amended.finding, /^Amendment worker-feature-1 was accepted/);
  assert.deepEqual(amended.keep["item:feature:refused"], {
    commit: collected.commit,
    tree: collected.tree,
    notes: [],
    replayOnly: true,
  });
  assert.equal(amended.keep["item:feature:rebase"], true);
  assert.equal(amended.keep["item:feature:discovered"], null);
});

test("a no-change repair's discovery is proposed for the attempt that made it, and a backlog discovery is only logged", async () => {
  const { worktree, base } = personsMain();
  writeFileSync(join(worktree, MANIFEST), JSON.stringify(discovery));
  const stopped = await collectIn(worktree, base);
  assert.equal(stopped.kind, "repair");
  // The second attempt, after one repair of the work step.
  const proposed = discoveryOutcome(
    work,
    contextOf(accepted(2)),
    undefined,
    stopped,
    {},
  );
  assert.equal(proposed.kind, "retry");
  assert.equal(proposed.reason, "Proposed amendment worker-feature-2");
  assert.deepEqual(proposed.keep["amend:worker-feature-2:proposal"].worker, {
    itemId: "feature",
    attempt: 2,
  });

  const backlog = { ...discovery, scope: "backlog" };
  ownedChange(worktree);
  writeFileSync(join(worktree, MANIFEST), JSON.stringify(backlog));
  const collected = await collectIn(worktree, base);
  assert.equal(collected.kind, "collected", collected.finding);
  assert.deepEqual(collected.discovery, backlog);
  const logged = [];
  assert.equal(
    discoveryOutcome(
      work,
      contextOf(accepted(), logged),
      undefined,
      collected,
      {},
    ),
    undefined,
  );
  assert.deepEqual(logged, [
    {
      event: "backlog-discovery",
      item: "feature",
      attempt: 1,
      discovery: backlog,
    },
  ]);
});
