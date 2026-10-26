// A worker's discovery: what it proposes in .factory-discovery.json,
// collected as private staging and proposed as amendment
// worker-<item>-<attempt>. The worker's output is fixed here: after the
// plan was accepted, a person landed a test on main that needs a file no
// item owns once the item's own file exists, and the worker proposes that
// file in scope instead of changing it. Live, neither worker proposed it,
// and the repair diagnosis could only ask the operator: the route from that
// failure to the worker's discovery is tested last, with the diagnosis's
// answer fixed here too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import {
  continuation,
  VALIDATE_REQUEST,
} from "../dist/providers/claude-worker.js";
import { correction } from "../dist/repair.js";
import { discoveryOutcome } from "../dist/work/amend.js";
import { collect } from "../dist/work/collect.js";
import { prepareWorkPrompt } from "../dist/work/prompt.js";
import { SelfValidation } from "../dist/work/self-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

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
    return { ...loadConfig(REPO), logs: inst.logs };
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
  const worktree = join(tempDir("factory-discovery-"), "w");
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

const { sandbox, planning, logs } = loaded();
const collectIn = (worktree, base, finalResponse = "", refusedTree) =>
  collect({
    worktree,
    base,
    plan: { items: [work] },
    item: work,
    mayChange: [],
    playbook: planning.playbook,
    sandbox,
    finalResponse,
    refusedTree,
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
  // Its cited files are read from the worker's result.
  assert.equal(proposal.commit, collected.commit);
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
    contextOf(accepted(2, { "item:feature:base": base })),
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
  // No change: its cited files are read from the item's start.
  assert.equal(proposed.keep["amend:worker-feature-2:proposal"].commit, base);

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

// The route from the failure to the discovery. Required validation fails
// on the file no item owns; a QA item, which owns nothing, is in the plan.
const required = { command: "test -f src/companion.js" };
const qa = item("qa", { kind: "qa", dependencies: ["feature"] });
const REDIRECT =
  "If the fix needs files outside your owned paths, do not change them: write an in-scope .factory-discovery.json naming them and stop.";

/** The diagnosis's answers, in order, the last one repeating. */
function diagnosis(...answers) {
  const asked = [];
  const planner = {
    answer: async (call) => {
      asked.push(call);
      return { value: answers[Math.min(asked.length, answers.length) - 1] };
    },
  };
  return { planner, asked };
}

const answer = (fields) => ({
  decision: "operator",
  diagnosis: "",
  predecessor: "",
  path: "",
  correction: "",
  question: "",
  requestedFiles: [],
  ownership: [],
  evidence: [],
  acceptance: [],
  ...fields,
});

const discover = answer({
  decision: "discover",
  diagnosis:
    "test/feature.test.js requires src/companion.js once src/feature.js exists, and no Work Item owns it",
  ownership: ["src/companion.js"],
  evidence: ["test -f src/companion.js failed"],
  acceptance: ["src/companion.js exists, and test -f src/companion.js passes"],
});

/** Work#1's collected result and the diagnosis of its failed validation. */
async function diagnosed(planner, items, logged) {
  const { worktree, base } = personsMain();
  ownedChange(worktree);
  const first = await collectIn(worktree, base);
  assert.equal(first.kind, "collected", first.finding);
  const result = await correction({
    planner,
    plan: plan(items),
    item: work,
    finding: { kind: "failure", detail: `${required.command} failed:\n` },
    checkout: worktree,
    base,
    commit: first.commit,
    sources: [],
    prior: [],
    signal: AbortSignal.timeout(60_000),
    log: (event) => logged.push(event),
  });
  return { worktree, base, first, result };
}

test("a fix needing a file no Work Item owns is Factory's correction to propose it, and the worker's manifest becomes amendment worker-<item>-2", async () => {
  const { planner, asked } = diagnosis(discover);
  const logged = [];
  const { worktree, base, first, result } = await diagnosed(
    planner,
    [work, qa],
    logged,
  );
  assert.equal(result.kind, "correction", JSON.stringify(result));
  assert.equal(asked.length, 1);
  // Only items that own paths are owners: the QA item is not one.
  assert.match(
    asked[0].prompt,
    /"planOwnership":\[\{"id":"feature","ownedPaths":\["src\/feature\.js"\]\}\]/,
  );
  assert.equal(result.correction.diagnosis, discover.diagnosis);
  assert.ok(
    result.correction.correction.startsWith(
      'Required validation needs src/companion.js, which no Work Item owns. Do not change them. Write .factory-discovery.json with scope in-scope, ownership ["src/companion.js"], acceptance and evidence as your instructions say, then stop.',
    ),
    result.correction.correction,
  );
  assert.match(
    result.finding,
    /\nRequired correction: Required validation needs src\/companion\.js/,
  );
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [
      {
        event: "diagnosis",
        decision: "discover",
        ownership: ["src/companion.js"],
      },
    ],
  );

  // Work#2 follows it: the manifest, and no other change.
  writeFileSync(join(worktree, MANIFEST), JSON.stringify(discovery));
  const second = await collectIn(worktree, base, "", first.tree);
  assert.equal(second.kind, "repair");
  assert.equal(second.unchanged, true);
  assert.deepEqual(second.discovery, discovery);
  const proposed = discoveryOutcome(
    work,
    contextOf(
      accepted(2, {
        "item:feature:base": base,
        "item:feature:refused": {
          commit: first.commit,
          tree: first.tree,
          notes: [],
        },
      }),
    ),
    undefined,
    second,
    {},
  );
  assert.equal(proposed.kind, "retry");
  assert.equal(proposed.reason, "Proposed amendment worker-feature-2");
  const proposal = proposed.keep["amend:worker-feature-2:proposal"];
  assert.deepEqual(proposal.worker, { itemId: "feature", attempt: 2 });
  // It resubmitted the refused result, which holds the src/feature.js its
  // discovery names: the cited files are read there, not at its start.
  assert.equal(proposal.commit, first.commit);
});

test("a file another Work Item owns is never discovered: the diagnosis is asked again, and asks the operator as before", async () => {
  const companion = item("companion", { ownedPaths: ["src/companion.js"] });
  const question = "Should companion deliver src/companion.js first?";
  const { planner, asked } = diagnosis(discover, answer({ question }));
  const { result } = await diagnosed(planner, [work, companion], []);
  assert.deepEqual(result, { kind: "question", question });
  assert.equal(asked.length, 2);
  assert.match(
    asked[1].prompt,
    /Your previous answer was rejected: a discover decision's ownership names only repository files no Work Item owns, and src\/companion\.js is owned by companion\./,
  );
});

test("the worker prompt sends a file outside the owned paths to the discovery, and a peer with no owned paths owns nothing", async () => {
  const { worktree, base } = personsMain();
  const validated = { ...work, validation: [required] };
  const prepared = await prepareWorkPrompt({
    checkout: worktree,
    worktree,
    objective: 7,
    objectiveBody: "",
    plan: plan([validated, qa], { base }),
    item: validated,
    base,
    fixedScripts: [],
  });
  assert.equal(prepared.problem, undefined);
  for (const text of [
    "Stop and report if acceptance is impossible; when what blocks it is a change outside the owned paths, propose that change in .factory-discovery.json",
    "(script-run files, existing tests, source files existing tests import, new packages)",
    "If a command needs an unavailable service, tool or credential, report the exact command and reason. If it needs a file the repository's own files require (such as a source file a test imports) outside your owned paths, do not write it, and do not just report it: propose it in .factory-discovery.json",
    "when that output's path is in a peer's ownedPaths (a peer with no ownedPaths, such as a QA or final-validation item, owns no file)",
  ])
    assert.ok(prepared.prompt.includes(text), text);
});

test("a failed Validate run, the request to validate and a turn-limit continuation after a failed run send a fix outside the owned paths to the discovery", async () => {
  const { worktree, base } = personsMain();
  ownedChange(worktree);
  const validated = { ...work, validation: [required] };
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
  const signal = AbortSignal.timeout(120_000);
  const validator = new SelfValidation(
    {
      worktree,
      item: validated,
      base,
      signal,
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:feature:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([validated], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  );
  const run = await validator.call();
  assert.equal(run.isError, false, run.text);
  assert.ok(
    run.text.startsWith(
      `Validation failed. Fix this before you finish.\n${required.command} failed`,
    ),
    run.text,
  );
  assert.ok(run.text.endsWith(REDIRECT), run.text);
  assert.equal(await validator.finalFailed(), true);
  assert.ok(VALIDATE_REQUEST.endsWith(REDIRECT));
  assert.ok(
    continuation(true, true).endsWith(
      `Validate failed on your current files. ${REDIRECT}`,
    ),
  );
  assert.ok(!continuation(true, false).includes(REDIRECT));
  // Files changed since are not the ones that failed.
  writeFileSync(join(worktree, "src", "feature.js"), "exports.feature = 2;\n");
  assert.equal(await validator.finalFailed(), false);
});
