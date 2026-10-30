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
import { observedRecords } from "../dist/knowledge/memory.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import {
  continuation,
  VALIDATE_REQUEST,
  validateRequest,
} from "../dist/providers/claude-worker.js";
import { operatorAnswers } from "../dist/planning/plan.js";
import { correction, workerShellRule } from "../dist/repair.js";
import { newObjective } from "../dist/state.js";
import { discoveryOutcome } from "../dist/work/amend.js";
import { collect } from "../dist/work/collect.js";
import { prepareWorkPrompt } from "../dist/work/prompt.js";
import {
  SELECTED_MEDIA_VALIDATE,
  SelfValidation,
  VALIDATION_TOOL_DESCRIPTION,
  validationToolDescription,
} from "../dist/work/self-validate.js";
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
    plan: { items: [work], coverage: [] },
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

  // Settled with the plan unchanged (the discovery showed no gap, #2116):
  // collection goes on with the result as collected, with no question and
  // no new attempt.
  state.done["amend:worker-feature-1"] = { unchanged: true };
  assert.equal(
    discoveryOutcome(work, contextOf(state), undefined, again, keep),
    undefined,
  );

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
  // Its diagnosis names the amendment, which refused nothing (#2229).
  assert.equal(
    amended.keep["item:feature:diagnosis"].amendment,
    "worker-feature-1",
  );
  assert.equal(amended.keep["item:feature:diagnosis"].repair, 1);
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

  // A first attempt keeps its start only in this step's keep: the files are
  // still read there, not at the plan's base, which lacks the person's test
  // (#2134: run 2026-10-27T140320PDT-d58c).
  const first = discoveryOutcome(
    work,
    contextOf(accepted(1)),
    undefined,
    stopped,
    { "item:feature:base": base, "item:feature:rebase": false },
  );
  assert.equal(first.reason, "Proposed amendment worker-feature-1");
  assert.equal(first.keep["amend:worker-feature-1:proposal"].commit, base);
  assert.equal(first.keep["item:feature:base"], base);

  // A repair attempt moved onto a new start (an amended attempt's replay, a
  // conflict or a failed delivery) keeps that start only in this step's
  // keep too: the files are read where the worker started, not at the
  // start its previous attempt had.
  const earlier = "e".repeat(40);
  const moved = discoveryOutcome(
    work,
    contextOf(
      accepted(2, {
        "item:feature:base": earlier,
        "item:feature:rebase": true,
      }),
    ),
    undefined,
    stopped,
    { "item:feature:base": base, "item:feature:rebase": false },
  );
  assert.equal(moved.reason, "Proposed amendment worker-feature-2");
  assert.equal(moved.keep["amend:worker-feature-2:proposal"].commit, base);

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
async function diagnosed(planner, items, logged, prior = [], validate = true) {
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
    prior,
    validate,
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

// Live (#2078), the diagnosis asked the operator whether an item should be
// added to own the missing file or the test changed: a plan change, which
// amendment planning makes. Its question named the file.
const planQuestion = answer({
  ...discover,
  decision: "operator",
  question:
    "How should the plan address the missing src/companion.js required by the existing test: should an item be added to own and provide it, or should the test dependency be removed through an authorized change?",
});

test("the diagnosis rubric keeps plan changes from the operator: work outside the owned paths is discover, and a question is for what only a person can decide", async () => {
  const question = "Which locale should feature format dates in?";
  const { planner, asked } = diagnosis(answer({ question }));
  const logged = [];
  const { result } = await diagnosed(planner, [work], logged);
  // A question with no files no Work Item owns still holds, as before.
  assert.deepEqual(result, { kind: "question", question });
  assert.equal(asked.length, 1);
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [{ event: "diagnosis", decision: "operator" }],
  );
  for (const rule of [
    "Return decision discover when the correction needs files or work outside this item's owned paths that no Work Item in the plan owns",
    "even when that looks like a plan change (a new Work Item, a new dependency)",
    "amendment planning decides how the plan changes (a new Work Item, or a change to one), with its own independent review.",
    "Never ask the operator how the plan should change or which Work Item should provide a file: a question is only for what a person alone can decide.",
    "Return operator with a concrete question when the correction needs the operator's intent (what they want where the sources conflict or say nothing), an external fact Factory cannot see, or an authorization or prerequisite",
    "With operator, ownership lists every file no Work Item owns that the question is about ([] when it is about none), with evidence and acceptance as for discover: Factory then takes the discovery route for those files instead of asking, unless the worker was already asked to propose them.",
    // #2156: live (#800), a Codex worker found no registry in its own
    // shell, and the diagnosis asked the operator to restore it.
    workerShellRule(true),
    "A tool, dependency, package registry or network unavailable in the worker's own shell is never an operator question and never a correction by itself: decide repair",
    "tell the worker to check its result with its Validate tool (run_validation), which runs the item's commands after the exact locked install, instead of installing dependencies or running the commands in its shell.",
    // Its own sentence, before the operator rule.
    "running the commands in its shell. Return operator with a concrete question",
  ])
    assert.ok(asked[0].prompt.includes(rule), rule);
});

test("the diagnosis never tells a worker without Validate to use it: Factory's validation reruns the commands and returns their output (#2156)", async () => {
  const question = "Which locale should feature format dates in?";
  const { planner, asked } = diagnosis(answer({ question }));
  await diagnosed(planner, [work], [], [], false);
  const prompt = asked[0].prompt;
  for (const rule of [
    workerShellRule(false),
    "A tool, dependency, package registry or network unavailable in the worker's own shell is never an operator question and never a correction by itself: decide repair",
    "tell the worker that it has no tool that runs the item's commands, and that Factory's validation runs them after the exact locked install once it finishes and returns any failure's output, so it should neither install dependencies nor ask for another environment. Return operator with a concrete question",
  ])
    assert.ok(prompt.includes(rule), rule);
  assert.ok(!prompt.includes("Validate tool"), prompt);
  assert.ok(!prompt.includes("run_validation"), prompt);
});

test("a question about a file no Work Item owns is decided discover instead, with no further call", async () => {
  const { planner, asked } = diagnosis(planQuestion);
  const logged = [];
  const { result } = await diagnosed(planner, [work, qa], logged);
  assert.equal(result.kind, "correction", JSON.stringify(result));
  assert.equal(asked.length, 1);
  assert.equal(result.correction.source, "diagnosis");
  assert.equal(result.correction.diagnosis, discover.diagnosis);
  assert.equal(
    result.correction.correction,
    `Required validation needs src/companion.js, which no Work Item owns. Do not change them. Write .factory-discovery.json with scope in-scope, ownership ["src/companion.js"], acceptance and evidence as your instructions say, then stop. The diagnosis's evidence and acceptance, to check against the failure: ${JSON.stringify({ evidence: discover.evidence, acceptance: discover.acceptance })}`,
  );
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [
      {
        event: "diagnosis",
        decision: "discover",
        ownership: ["src/companion.js"],
        rerouted: "operator",
      },
    ],
  );
});

test("a question about a file no Work Item owns is checked as a discovery: without evidence it is asked again, and with a file an item owns as well it is no discovery", async () => {
  const bare = answer({ ...planQuestion, evidence: [] });
  const { planner, asked } = diagnosis(bare, discover);
  const { result } = await diagnosed(planner, [work], []);
  assert.equal(result.kind, "correction", JSON.stringify(result));
  assert.equal(asked.length, 2);
  assert.match(
    asked[1].prompt,
    /\nYour previous answer was rejected: an operator question about files no Work Item owns is decided discover instead, and a discover decision needs the reason in diagnosis, every file the fix needs in ownership, and nonempty evidence and acceptance\. Answer again\.$/,
  );

  const companion = item("companion", { ownedPaths: ["src/companion.js"] });
  const question = "Should companion deliver src/companion.js first?";
  const mixed = answer({
    ...planQuestion,
    ownership: ["src/companion.js", "src/more.js"],
  });
  const owned = diagnosis(mixed, answer({ question }));
  const held = await diagnosed(owned.planner, [work, companion], []);
  assert.deepEqual(held.result, { kind: "question", question });
  assert.equal(owned.asked.length, 2);
  assert.match(
    owned.asked[1].prompt,
    /Your previous answer was rejected: an operator question about files no Work Item owns is decided discover instead, and a discover decision's ownership names only repository files no Work Item owns, and src\/companion\.js is owned by companion\. A file this item owns is a repair, a predecessor's a predecessor blame; otherwise return operator with a question and ownership \[\]\./,
  );
});

test("a question that names only files Work Items own stays a question, with no further call", async () => {
  // Another item's file is the operator's to decide, as before; listing it
  // in ownership is no reason to ask again.
  const companion = item("companion", { ownedPaths: ["src/companion.js"] });
  const { planner, asked } = diagnosis(planQuestion);
  const logged = [];
  const { result } = await diagnosed(planner, [work, companion], logged);
  assert.deepEqual(result, {
    kind: "question",
    question: planQuestion.question,
  });
  assert.equal(asked.length, 1);
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [{ event: "diagnosis", decision: "operator" }],
  );
});

test("once the worker was asked to propose those files, a question about them is the operator's, whatever the failure's or the evidence's wording", async () => {
  const reworded = answer({
    ...discover,
    evidence: ["npm test: cannot find module src/companion.js"],
  });
  const first = await diagnosed(diagnosis(reworded).planner, [work], []);
  assert.equal(first.result.kind, "correction");
  // The same validation fails again, its timings changed.
  const tried = {
    ...first.result.correction,
    failure: `${first.result.correction.failure} (1.2ms)`,
  };
  const { planner, asked } = diagnosis(planQuestion);
  const logged = [];
  const { result } = await diagnosed(planner, [work], logged, [tried]);
  assert.deepEqual(result, {
    kind: "question",
    question: planQuestion.question,
  });
  assert.equal(asked.length, 1);
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [{ event: "diagnosis", decision: "operator" }],
  );
});

test("a repeated discovery the diagnosis is told to turn into a question is not proposed again through that question", async () => {
  const first = await diagnosed(diagnosis(discover).planner, [work], []);
  assert.equal(first.result.kind, "correction");
  // Told the discovery was already tried and to return operator, it asks
  // about the same file with its evidence reworded.
  const { planner, asked } = diagnosis(
    discover,
    answer({
      ...planQuestion,
      evidence: ["npm test: cannot find module src/companion.js"],
    }),
  );
  const logged = [];
  const { result } = await diagnosed(planner, [work], logged, [
    first.result.correction,
  ]);
  assert.deepEqual(result, {
    kind: "question",
    question: planQuestion.question,
  });
  assert.equal(asked.length, 2);
  assert.match(
    asked[1].prompt,
    /Your previous answer was rejected: the worker was already asked to propose those files for this same failure \(see prior\); propose a different correction, or return operator with a question\./,
  );
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [{ event: "diagnosis", decision: "operator" }],
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
    "If a command needs an unavailable service, tool or credential, report the exact command and reason; a dependency or tool missing only from your own shell is not one, since Factory's validation, and Validate, install the locked dependencies before they run the commands. If it needs a file the repository's own files require (such as a source file a test imports) outside your owned paths, do not write it, and do not just report it: propose it in .factory-discovery.json",
    "when that output's path is in a peer's ownedPaths (a peer with no ownedPaths, such as a QA or final-validation item, owns no file)",
    // #2156: every worker is told how to check its result: Validate when it
    // has one; otherwise Factory's validation, never a promise that its own
    // shell can run the commands.
    "check your result with every exact required command below before finishing, through your Validate tool (run_validation) when you have one, which runs them as Factory will, after the exact locked install; without one, Factory runs them after you finish and returns any failure's output to you, and a command you run yourself in the checkout may lack the dependencies it needs, which is no failure of your result; fix failures within owned paths.",
    // #2107: a command no correct result can pass goes to the discovery.
    // #2156: HEAD where Factory validates is the result; live (#800), a
    // worker took a check of HEAD for one no result could pass.
    "Factory collects your uncommitted result as a new commit and validates that commit in a fresh checkout: there HEAD is your result, so a check that reads HEAD's tree sees it and a diff against HEAD shows nothing, while HEAD in your own checkout doesn't hold your uncommitted changes. Write your tests to check files, never HEAD, the index or a commit of the result. If a command can't pass on any correct result, because it is malformed or depends on more of the commit than its files (such as its message), don't work around it in your tests: propose its replacement in .factory-discovery.json",
  ])
    assert.ok(prepared.prompt.includes(text), text);
});

// #2147: the operator's planning decisions as plan steps save them in that
// run (Codex, main media.select-repair). Its plan review's unresolved
// finding asked for the asset item to own the delivered files' test; the
// operator's `more` only granted rounds, and the plan accepted after them
// kept the test with its own item. A worker given that `more` as a human
// decision took the finding for its requirement and proposed moving the
// test into its item.
const STALE =
  "make the asset item own and validate the test that checks the delivered files";
const MORE = {
  question: `The plan still has 1 problem after 3 rounds, past the 2 autonomy.allowances.planningRevisions allows:\n\n1. Unresolved: this item's validation still only checks the Git LFS attributes. Add validation that checks those asset properties locally, or ${STALE}.\n\n\`more\` allows 2 more rounds.`,
  answer: "more",
  by: "kirk",
  at: "2026-01-01T00:00:30.000Z",
};
const ANSWERED = {
  question: "Which two colours should the candidate sets use?",
  answer: "answer",
  text: "Green and purple.",
  by: "kirk",
  at: "2026-01-01T00:00:20.000Z",
};

test("the worker prompt gives the operator's planning answers, never a `more`, whose question lists findings the accepted plan settled (#2147)", async () => {
  const { worktree, base } = personsMain();
  const validated = { ...work, validation: [required] };
  const prepared = await prepareWorkPrompt({
    checkout: worktree,
    worktree,
    objective: 7,
    objectiveBody: "",
    plan: plan([validated, qa], { base, decisions: [ANSWERED, MORE] }),
    item: validated,
    base,
    fixedScripts: [],
  });
  assert.equal(prepared.problem, undefined);
  assert.ok(
    prepared.prompt.includes(
      `Controller-bound human planning decision context: ${JSON.stringify([ANSWERED])}`,
    ),
  );
  assert.ok(!prepared.prompt.includes(STALE));
});

test("operatorAnswers keeps every planning decision but a `more` (#2147)", () => {
  const approve = { ...ANSWERED, answer: "approve", text: undefined };
  assert.deepEqual(operatorAnswers([MORE, ANSWERED, approve, MORE]), [
    ANSWERED,
    approve,
  ]);
  assert.deepEqual(operatorAnswers([]), []);
});

test("this Objective's repository memory records the operator's planning answers as human decisions, never a `more` (#2147)", async () => {
  // queryMemory gives an Objective's own decision records to its planning,
  // workers, repair diagnosis and reviews.
  const state = newObjective(7, new Date("2026-01-01T00:00:00.000Z"));
  state.status = "working";
  state.done.plan = plan([item("a", { ownedPaths: ["src/a.js"] })], {
    decisions: [ANSWERED, MORE],
  });
  const records = await observedRecords(
    { repository: REPO, checkout: tempDir("factory-memory-") },
    state,
    false,
  );
  const decided = records.filter((record) => record.kind === "decision");
  assert.equal(decided.length, 1, JSON.stringify(decided));
  assert.equal(decided[0].authority, "human-decision");
  assert.ok(decided[0].body.includes(ANSWERED.text));
  assert.ok(!JSON.stringify(records).includes(STALE));
});

test("a failed Validate run, the request to validate and a turn-limit continuation after a failed run send a fix outside the owned paths to the discovery, and a media item's say a failure for its absent selected set is neither (#2116)", async () => {
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
  // None of them says anything of selected media for an item with none.
  assert.ok(!run.text.includes(SELECTED_MEDIA_VALIDATE));
  assert.equal(validateRequest(validated), VALIDATE_REQUEST);
  assert.equal(continuation(true, true, validated), continuation(true, true));
  assert.equal(
    validationToolDescription(validated),
    VALIDATION_TOOL_DESCRIPTION,
  );
  // A media item's selected set is never in the files Validate runs on, so
  // a test of the delivered files always fails there (#2116): the tool, a
  // failed run, the request to validate and a continuation all say that
  // failure is no fix and no discovery, after what they say of other
  // failures. Live (Codex, media.select-repair), a worker took that ENOENT
  // for a gap and its amendment could never be planned.
  const media = {
    ...validated,
    expectedOutputRoles: ["badge"],
    minimumAssetSets: 2,
  };
  const note = ` ${SELECTED_MEDIA_VALIDATE}`;
  const mediaRun = await new SelfValidation(
    {
      worktree,
      item: media,
      base,
      signal,
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:feature:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([media], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  ).call();
  assert.equal(mediaRun.isError, false, mediaRun.text);
  assert.ok(mediaRun.text.endsWith(`${REDIRECT}${note}`), mediaRun.text);
  assert.equal(validateRequest(media), `${VALIDATE_REQUEST}${note}`);
  for (const failed of [true, false])
    assert.ok(continuation(true, failed, media).endsWith(note));
  assert.ok(!continuation(false, false, media).includes(note));
  assert.equal(
    validationToolDescription(media),
    `${VALIDATION_TOOL_DESCRIPTION}${note}`,
  );
  assert.ok(
    SELECTED_MEDIA_VALIDATE.includes(
      "do not write .factory-discovery.json for it, and finish once every other failure is fixed",
    ),
  );
  // Files changed since are not the ones that failed.
  writeFileSync(join(worktree, "src", "feature.js"), "exports.feature = 2;\n");
  assert.equal(await validator.finalFailed(), false);
});
