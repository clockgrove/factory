// Every Work Item passed a base-relative budget against its own base, and
// final validation, which compares the whole Objective with the plan's
// base, failed on their sum after the last merge (#2240). A Work Item's
// validation now counts as final validation will: each command that names
// no base gets the plan's base as FACTORY_BASE_SHA, and a candidate built
// before another item of the Objective merged runs its commands again on
// top of that merge. A final validation failure that still gets through
// offers `repair`, which sends it, with its complete output, to a merged
// Work Item. Real Git and the real sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { ObjectiveRunner } from "../dist/engine.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { ACCEPTED_AT } from "../dist/planning/plan.js";
import { newObjective } from "../dist/state.js";
import { validateTree } from "../dist/validate.js";
import { fact, facts } from "../dist/work/facts.js";
import {
  deliverySteps,
  finalStep,
  finalValidationRoute,
  integratedRef,
  mergeStep,
  PHASES,
  stepKey,
  validateBeforeMerge,
  validateStep,
} from "../dist/work/steps.js";
import { objectiveWorkflow } from "../dist/workflow.js";
import {
  configured,
  githubOrigin,
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

/**
 * A repository's own budget, as such a check reads its base: test lines
 * added since FACTORY_BASE_SHA may exceed source lines added by at most 5.
 * Over it, pages of detail come before the verdict.
 */
const BUDGET = `import { execFileSync } from "node:child_process";
const numstat = execFileSync("git", ["diff", "--numstat", process.env.FACTORY_BASE_SHA], { encoding: "utf8" });
let tests = 0;
let source = 0;
for (const row of numstat.split("\\n").filter(Boolean)) {
  const [added, , path] = row.split("\\t");
  if (path.startsWith("test/")) tests += Number(added);
  else if (path.startsWith("src/")) source += Number(added);
}
const over = tests - source;
if (over > 5) {
  console.error("budget detail: one added line counted\\n".repeat(400));
  console.error(\`Test-line budget exceeded: \${tests} test lines against \${source} source lines, over by \${over} (allowance 5)\`);
  process.exit(1);
}
console.log(\`Test-line budget: over by \${over} of 5\`);
`;
const CHECK = "node budget.mjs";

/** Work Item `id`: one source line and five test lines, over the budget by 4 alone. */
const owned = (id) => ({
  [`src/${id}.js`]: `export const ${id} = 1;\n`,
  [`test/${id}.test.js`]: "// 1\n// 2\n// 3\n// 4\n// 5\n",
});

/** A commit on `checkout`'s HEAD writing `files`. */
function commit(checkout, files, message) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(checkout, path, ".."), { recursive: true });
    writeFileSync(join(checkout, path), text);
    git(checkout, "add", path);
  }
  git(checkout, "commit", "--quiet", "-m", message);
  return git(checkout, "rev-parse", "HEAD");
}

/** A test installation's configuration, with `checkout` when given, and no network. */
function configFor(checkout) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1", {}, checkout ? { checkout } : {});
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    const own = loadConfig(REPO);
    return {
      inst,
      config: { ...own, sandbox: { ...own.sandbox, network: "off" } },
    };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const AT = "2026-10-30T00:00:00.000Z";
const merge = (sha, at = AT) => ({ mergeSha: sha, integratedSha: sha, at });

/** Two coding items, each owning its files and running the budget. */
const ITEMS = ["a", "b"].map((id) =>
  item(id, {
    ownedPaths: [`src/${id}.js`, `test/${id}.test.js`],
    validation: [{ command: CHECK }],
  }),
);

/** An Objective building `planned`, at its first step past the plan. */
function objective(issue, planned, base) {
  const state = newObjective(issue, new Date(), {
    provider: "codex",
    selectedBy: "defaultProvider",
    digest: "frozen",
    config: {},
  });
  state.status = "building";
  state.done.predecessors = { predecessors: [], ignored: [] };
  state.done.check = {
    shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] },
    base,
    title: "Budget",
    reviewArtifacts: [],
  };
  state.done.plan = planned;
  state.kept[ACCEPTED_AT] = AT;
  return state;
}

/** A step's context: `state` as it is, with `answer`. */
function contextOf(state, logs, step, answer) {
  const log = new RunLog(logs, "2026-10-30T00-00-00-000Z-1", CAPTURE_OFF, []);
  const kept = {};
  return {
    kept,
    context: {
      state,
      ...(answer ? { answer } : {}),
      signal: AbortSignal.timeout(240_000),
      log: () => {},
      runFile: (kind) => log.runFile(state.issue, `${step}#1.${kind}`),
      keep: (values) => Object.assign(kept, values),
    },
  };
}

test("a Work Item's command that names no base counts the Objective's change from the plan's base, as final validation does; one that names its base still sees only its own (#2240)", async () => {
  const checkout = tempDir("factory-aggregate-base-");
  git(checkout, "init", "--quiet");
  const base = commit(checkout, { "budget.mjs": BUDGET }, "base");
  // a merged, and b was built on its merge.
  const a = commit(checkout, owned("a"), "a");
  const b = commit(checkout, owned("b"), "b");
  const { inst, config } = configFor();
  const log = new RunLog(
    inst.logs,
    "2026-10-30T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const scope = `git diff --exit-code "$FACTORY_BASE_SHA" -- . ':!src/b.js' ':!test/b.test.js'`;
  const validated = (commit, built, validation) => {
    const work = item("b", {
      ownedPaths: ["src/b.js", "test/b.test.js"],
      validation,
    });
    return validateTree({
      checkout,
      repository: REPO,
      directory: `${checkout}.validation`,
      commit,
      item: work,
      plan: plan([work], { base }),
      blocks: [],
      base: built,
      ...(built !== base ? { predecessor: built } : {}),
      sandbox: config.sandbox,
      commandTimeoutMs: 60_000,
      signal: AbortSignal.timeout(120_000),
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:b:validate#1.${kind}`),
    });
  };
  // Alone, over by 4: within the allowance.
  const first = await validated(a, base, [{ command: CHECK }]);
  assert.equal(first.kind, "passed", JSON.stringify(first).slice(0, 800));
  assert.match(first.results[0].tail, /over by 4 of 5/);
  // b's own change is over by 4 too, but on top of a's the Objective is over
  // by 8: the budget fails here, before b merges. Its scope check, which
  // names the base, still compares with the commit b was built on.
  const second = await validated(b, a, [
    { command: scope },
    { command: CHECK },
  ]);
  assert.equal(second.kind, "failed", JSON.stringify(second).slice(0, 800));
  assert.deepEqual(
    second.results.map((result) => result.command),
    [scope],
  );
  assert.equal(second.failed.command, CHECK);
  assert.match(second.output, /over by 8 \(allowance 5\)/);
  // Final validation runs it the same way on the same tree.
  const final = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.final`,
    commit: b,
    plan: plan(ITEMS, { base, finalCommands: [CHECK] }),
    blocks: [],
    sandbox: config.sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: () => {},
    runFile: (kind) => log.runFile(1, `final#1.${kind}`),
  });
  assert.equal(final.kind, "failed");
  assert.match(final.output, /over by 8 \(allowance 5\)/);
});

test("a Work Item command final validation never runs keeps the item's own base: another Objective's merge since the plan's base is not its change (#2240)", async () => {
  const checkout = tempDir("factory-aggregate-other-");
  git(checkout, "init", "--quiet");
  // A scope check that reads the base itself: its command names none.
  const SCOPE = `import { execFileSync } from "node:child_process";
const changed = execFileSync("git", ["diff", "--name-only", process.env.FACTORY_BASE_SHA], { encoding: "utf8" }).split("\\n").filter(Boolean);
const outside = changed.filter((path) => !path.startsWith("src/") && !path.startsWith("test/"));
if (outside.length) {
  console.error(\`Changed outside the item's paths: \${outside.join(", ")}\`);
  process.exit(1);
}
console.log("Scope: only the item's paths");
`;
  const base = commit(
    checkout,
    { "budget.mjs": BUDGET, "scope.mjs": SCOPE },
    "base",
  );
  // a merged; then another Objective's merge landed; b was built on it.
  const a = commit(checkout, owned("a"), "a");
  const other = commit(checkout, { "other.txt": "x\n" }, "another Objective");
  const b = commit(checkout, owned("b"), "b");
  const { inst, config } = configFor();
  const log = new RunLog(
    inst.logs,
    "2026-10-30T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const work = item("b", {
    ownedPaths: ["src/b.js", "test/b.test.js"],
    validation: [{ command: "node scope.mjs" }, { command: CHECK }],
  });
  const validated = (finalCommands) =>
    validateTree({
      checkout,
      repository: REPO,
      directory: `${checkout}.validation`,
      commit: b,
      item: work,
      plan: plan([item("a"), work], { base, finalCommands }),
      blocks: [],
      base: other,
      predecessor: other,
      sandbox: config.sandbox,
      commandTimeoutMs: 60_000,
      signal: AbortSignal.timeout(120_000),
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:b:validate#1.${kind}`),
    });
  // Final validation runs only its own command, which is neither of b's:
  // both compare with the commit b was built on, so the scope check never
  // sees the other Objective's file, and the budget counts b alone.
  const alone = await validated(["node budget.mjs --final"]);
  assert.equal(alone.kind, "passed", JSON.stringify(alone).slice(0, 800));
  assert.match(alone.results[0].tail, /only the item's paths/);
  assert.match(alone.results[1].tail, /over by 4 of 5/);
  // The budget is final validation's own command: it counts from the plan's
  // base there, so here too, a's merge included; the scope check still
  // compares with b's own base.
  const final = await validated([CHECK]);
  assert.equal(final.kind, "failed", JSON.stringify(final).slice(0, 800));
  assert.equal(final.results[0].command, "node scope.mjs");
  assert.equal(final.failed.command, CHECK);
  assert.match(final.output, /over by 8 \(allowance 5\)/);
});

/**
 * Work Items a and b, both started on the base: a merged first, and b's
 * candidate was built without it. `b` writes b's files.
 */
function parallel(issue, planned, b = owned("b")) {
  const checkout = tempDir("factory-aggregate-parallel-");
  git(checkout, "init", "--quiet", "-b", "main");
  const base = commit(checkout, { "budget.mjs": BUDGET }, "base");
  const a = commit(checkout, owned("a"), "a");
  git(checkout, "reset", "--quiet", "--hard", base);
  const candidate = commit(checkout, b, "b");
  const tree = git(checkout, "rev-parse", "HEAD^{tree}");
  git(checkout, "branch", "a", a);
  git(checkout, "branch", "b", candidate);
  git(checkout, "reset", "--quiet", "--hard", base);
  const { inst, config } = configFor(checkout);
  const state = objective(issue, planned(base), base);
  state.done[stepKey("a", "merge")] = merge(a);
  state.done[stepKey("b", "work")] = {
    base,
    commit: candidate,
    tree,
    notes: [],
    sets: [],
  };
  state.kept["item:b:base"] = base;
  const dir = tempDir("factory-aggregate-work-");
  const deps = (github = {}) => ({
    config,
    github: { commitAuthor: async () => undefined, made() {}, ...github },
    workDir: (id) => join(dir, "work", String(id)),
  });
  return { checkout, inst, state, deps, a, b: candidate, tree };
}

test("a candidate built before another Work Item of the Objective merged is validated again on top of that merge, and fails there before it merges (#2240)", async () => {
  const { checkout, inst, state, deps, a, b } = parallel(41, (base) =>
    plan(ITEMS, { base }),
  );
  const { context } = contextOf(state, inst.logs, "item:b:validate");
  const outcome = await validateStep(ITEMS[1], context, deps(), undefined);
  // b's own change passed; on top of a's merge, as final validation will
  // see it, the budget failed: b's repair, before it merges.
  assert.equal(outcome.kind, "repair", JSON.stringify(outcome).slice(0, 800));
  assert.equal(outcome.target, stepKey("b", "work"));
  const finding = outcome.keep["item:b:finding"];
  assert.equal(finding.kind, "failure");
  assert.ok(
    finding.detail.startsWith(
      "Validated on the default branch with this Objective's merges since Work Item b started (Work Item a; Factory's merge ",
    ),
    finding.detail.slice(0, 400),
  );
  assert.match(finding.detail, /over by 8 \(allowance 5\)/);
  assert.deepEqual(finding.identity, {
    kind: "validation",
    command: CHECK,
    exit: "1",
  });
  // The complete output, past the finding's excerpt, is kept (#2201).
  assert.ok(
    readFileSync(finding.output, "utf8").includes(
      "budget detail: one added line counted\n".repeat(400),
    ),
  );
  // The repair moves b onto the default branch, which holds a's merge.
  assert.equal(outcome.keep["item:b:rebase"], true);
  const kept = outcome.keep["item:b:validation"];
  assert.equal(kept.commit, b);
  assert.equal(kept.result.integrated, true);
  // Factory's merge, pinned until cleanup: a's merge and b's candidate.
  const pinned = git(checkout, "rev-parse", integratedRef(41, "b"));
  assert.deepEqual(
    git(checkout, "rev-list", "--parents", "-n", "1", pinned)
      .split(" ")
      .slice(1),
    [a, b],
  );
});

test("with final commands, a Work Item's command that isn't one doesn't run on the Objective's merges: final validation never runs it (#2240)", async () => {
  const { inst, state, deps, a, b } = parallel(44, (base) =>
    plan(ITEMS, { base, finalCommands: ["node budget.mjs --final"] }),
  );
  const { context } = contextOf(state, inst.logs, "item:b:validate");
  const outcome = await validateStep(ITEMS[1], context, deps(), undefined);
  // b's budget compares with b's own base, over by 4: it passes, and runs
  // on nothing else.
  assert.equal(outcome.kind, "done", JSON.stringify(outcome).slice(0, 800));
  assert.deepEqual(outcome.keep["item:b:validatedOn"], {
    commit: b,
    merges: [a],
  });
});

/** b validated, reviewed and its PR ready, before a merged: only its merge step is left. */
function readyToMerge(issue, b) {
  const h = parallel(issue, (base) => plan(ITEMS, { base }), b);
  const { state } = h;
  state.done[stepKey("b", "validate")] = { tree: h.tree, commands: [CHECK] };
  state.done[stepKey("b", "review")] = { accepted: true };
  state.done[stepKey("b", "publish")] = { pr: 6, head: h.b, merged: false };
  state.done[stepKey("b", "ci")] = { head: h.b, merged: false };
  // b's validation counted no merge: a merged after it.
  state.kept["item:b:validatedOn"] = { commit: h.b, merges: [] };
  return h;
}

test("a Work Item validated before another of the Objective merged is validated on that merge at its own merge step, and fails there before it merges (#2240)", async () => {
  const { checkout, inst, state, deps, a, b } = readyToMerge(45);
  // The merge step validates again, so it takes a CPU slot.
  const [step] = deliverySteps(state, deps());
  assert.equal(step.key, stepKey("b", "merge"));
  assert.equal(step.resource, "cpu");
  const { context } = contextOf(state, inst.logs, "item:b:merge");
  const outcome = await mergeStep(
    ITEMS[1],
    context,
    deps({
      pull: async () => ({ merged: false }),
      mergePull: async () => assert.fail("b must not merge"),
    }),
    undefined,
  );
  assert.equal(outcome.kind, "repair", JSON.stringify(outcome).slice(0, 800));
  assert.equal(outcome.target, stepKey("b", "work"));
  const finding = outcome.keep["item:b:finding"];
  assert.ok(
    finding.detail.startsWith(
      "Validated on the default branch with this Objective's merges since Work Item b started (Work Item a; Factory's merge ",
    ),
    finding.detail.slice(0, 400),
  );
  assert.match(finding.detail, /over by 8 \(allowance 5\)/);
  assert.deepEqual(finding.identity, {
    kind: "validation",
    command: CHECK,
    exit: "1",
  });
  assert.equal(outcome.keep["item:b:rebase"], true);
  assert.equal(outcome.keep["item:b:validatedOn"], undefined);
  assert.ok(outcome.clear.includes(stepKey("b", "merge")));
  // Factory's merge of a's merge and b's candidate, as at the validate step.
  const pinned = git(checkout, "rev-parse", integratedRef(45, "b"));
  assert.deepEqual(
    git(checkout, "rev-list", "--parents", "-n", "1", pinned)
      .split(" ")
      .slice(1),
    [a, b],
  );
});

test("a Work Item that fits the Objective's merges since its validation merges, and keeps them counted (#2240)", async () => {
  // b adds a source line and no test: the sum stays within the budget.
  const { inst, state, deps, a, b } = readyToMerge(46, {
    "src/b.js": "export const b = 1;\n",
  });
  const { context, kept } = contextOf(state, inst.logs, "item:b:merge");
  let asked = 0;
  const outcome = await validateBeforeMerge(
    ITEMS[1],
    context,
    deps({
      pull: async (pr) => {
        asked += 1;
        assert.equal(pr, 6);
        return { merged: false };
      },
    }),
  );
  assert.equal(outcome, undefined);
  assert.equal(asked, 1);
  assert.deepEqual(kept["item:b:validatedOn"], { commit: b, merges: [a] });
  // Counted: its next merge step runs nothing again, and takes no CPU slot.
  Object.assign(state.kept, kept);
  const [step] = deliverySteps(state, deps());
  assert.equal(step.key, stepKey("b", "merge"));
  assert.equal(step.resource, undefined);
  assert.equal(await validateBeforeMerge(ITEMS[1], context, deps()), undefined);
});

test("a merge step resumed after GitHub merged the PR doesn't validate again (#2240)", async () => {
  const { inst, state, deps } = readyToMerge(47);
  const { context, kept } = contextOf(state, inst.logs, "item:b:merge");
  const outcome = await validateBeforeMerge(
    ITEMS[1],
    context,
    deps({ pull: async () => ({ merged: true }) }),
  );
  assert.equal(outcome, undefined);
  assert.deepEqual(kept, {});
});

/** Final validation's failure as it holds in a two-item Objective whose merges pass the budget alone and fail it together. */
async function finalHarness() {
  const root = tempDir("factory-aggregate-final-");
  const bare = join(root, "origin.git");
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
  const work = join(root, "work");
  git(root, "clone", "--quiet", bare, "work");
  const pushed = (files, message) => {
    const sha = commit(work, files, message);
    git(work, "push", "--quiet", "origin", "HEAD:main");
    return sha;
  };
  const base = pushed({ "budget.mjs": BUDGET }, "base");
  const a = pushed(owned("a"), "a merged");
  const b = pushed(owned("b"), "b merged");
  // A target's clone outside the state directory validation seals, so git
  // in the sandbox reads its metadata.
  const checkout = join(root, "checkout");
  git(root, "clone", "--quiet", bare, "checkout");
  githubOrigin(checkout, bare);
  const { inst, config } = configFor(checkout);
  const planned = plan(ITEMS, { base, finalCommands: [CHECK] });
  const state = objective(42, planned, base);
  state.status = "finishing";
  for (const [id, sha, at] of [
    ["a", a, "2026-10-30T01:00:00.000Z"],
    ["b", b, "2026-10-30T02:00:00.000Z"],
  ]) {
    for (const phase of ["work", "validate", "review", "ci"])
      state.done[stepKey(id, phase)] = {
        base,
        commit: sha,
        tree: sha,
        head: sha,
        commands: [CHECK],
        notes: [],
        sets: [],
      };
    state.done[stepKey(id, "publish")] = {
      pr: id === "a" ? 5 : 6,
      head: sha,
      merged: false,
    };
    state.done[stepKey(id, "merge")] = merge(sha, at);
  }
  const dir = tempDir("factory-aggregate-final-work-");
  const deps = {
    config,
    github: { commitAuthor: async () => undefined },
    workDir: (issue) => join(dir, "work", String(issue)),
  };
  const bookkeeping = {
    config: {
      delivery: { kind: "regular" },
      validation: { commandTimeoutSeconds: 60 },
    },
  };
  const runner = new ObjectiveRunner(
    state,
    objectiveWorkflow(bookkeeping),
    tempDir("factory-aggregate-runner-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
  /** The final step run once on the runner's state, with its answer. */
  const run = async () => {
    const { context, kept } = contextOf(
      structuredClone(runner.state),
      inst.logs,
      "final",
      runner.state.answers.final,
    );
    const outcome = await finalStep(planned, deps).run(context);
    return { ...outcome, keep: { ...kept, ...outcome.keep } };
  };
  const answer = (given) =>
    runner.transact(() =>
      runner.answer(
        given,
        undefined,
        "kirk",
        undefined,
        runner.state.holds[0].id,
      ),
    );
  return { runner, run, answer, pushed, b, bookkeeping };
}

test("final validation's failure offers repair, which sends it with its complete output to a Work Item, and closes once that item merges again (#2240)", async () => {
  const h = await finalHarness();
  // The budget passed each item alone and fails on their sum; a failed
  // command runs once more first, and its rerun fails too.
  const failed = await h.run();
  assert.equal(failed.kind, "retry", JSON.stringify(failed).slice(0, 800));
  h.runner.apply("final", failed);
  const held = await h.run();
  assert.equal(held.kind, "hold", JSON.stringify(held).slice(0, 800));
  h.runner.apply("final", held);
  const [question] = h.runner.state.holds;
  assert.equal(question.step, "final");
  assert.deepEqual(
    question.options.map((option) => option.answer),
    ["repair", "retry", "replan", "cancel"],
  );
  assert.equal(question.options[0].recommended, true);
  assert.equal(question.options[0].family, "repair");
  assert.match(question.question, /over by 8 \(allowance 5\)/);
  // Both items run the budget: b merged last, so it fits the sum.
  assert.ok(
    question.question.includes(
      "Answer `repair` to send this failure back to Work Item b, the last to merge of the Work Items whose own validation runs `node budget.mjs`: b is repaired against the current default branch",
    ),
    question.question,
  );
  const failure = fact(h.runner.state, "final:held");
  assert.equal(failure.head, h.b);
  assert.equal(failure.failed.command, CHECK);
  assert.ok(
    readFileSync(failure.failed.output, "utf8").includes(
      "budget detail: one added line counted\n".repeat(400),
    ),
  );

  assert.equal(h.answer("repair"), null);
  const outcome = await h.run();
  assert.equal(outcome.kind, "repair", JSON.stringify(outcome).slice(0, 800));
  assert.equal(outcome.target, stepKey("b", "work"));
  assert.deepEqual(outcome.clear, [
    ...PHASES.map((phase) => stepKey("b", phase)),
    "final",
    "final-review",
  ]);
  h.runner.apply("final", outcome);
  const { state } = h.runner;
  // Only b is reopened, as a repair of its work, on the default branch, to
  // publish on a new PR; its first merge stays among the Objective's.
  for (const phase of PHASES.filter((phase) => phase !== "select")) {
    assert.equal(state.done[stepKey("b", phase)], undefined, phase);
    assert.ok(state.done[stepKey("a", phase)], phase);
  }
  assert.deepEqual(state.holds, []);
  assert.equal(state.repairs[stepKey("b", "work")].count, 1);
  const finding = fact(state, "finding", "b");
  assert.equal(finding.kind, "failure");
  assert.ok(
    finding.detail.startsWith(
      `Final validation failed on the default branch (${h.b.slice(0, 12)}), which holds this Work Item's merged result and the Objective's other merges. This repair starts from the current default branch.`,
    ),
    finding.detail.slice(0, 400),
  );
  assert.match(finding.detail, /over by 8 \(allowance 5\)/);
  assert.equal(finding.output, failure.failed.output);
  assert.deepEqual(finding.identity, {
    kind: "validation",
    command: CHECK,
    exit: "1",
  });
  assert.equal(fact(state, "base", "b"), undefined);
  assert.equal(fact(state, "republish", "b"), true);
  assert.deepEqual(
    fact(state, "earlierMerges", "b").map((entry) => [
      entry.merged.mergeSha,
      entry.pr,
    ]),
    [[h.b, 6]],
  );
  assert.equal(fact(state, "final:held"), undefined);
  assert.equal(fact(state, "final:failed"), undefined);
  assert.deepEqual(
    deliverySteps(state, h.bookkeeping).map((step) => step.key),
    [stepKey("b", "work")],
  );

  // b's repair keeps one test line and merges; final validation runs again
  // and passes on the new head.
  const fixed = h.pushed({ "test/b.test.js": "// 1\n" }, "b repaired");
  for (const phase of PHASES.slice(0, -1).filter((p) => p !== "select"))
    h.runner.apply(stepKey("b", phase), {
      kind: "done",
      result: {
        base: h.b,
        commit: fixed,
        tree: fixed,
        head: fixed,
        commands: [CHECK],
        notes: [],
        sets: [],
        pr: 7,
      },
    });
  h.runner.apply(stepKey("b", "merge"), {
    kind: "done",
    result: merge(fixed, "2026-10-30T03:00:00.000Z"),
  });
  assert.deepEqual(
    deliverySteps(h.runner.state, h.bookkeeping).map((step) => step.key),
    ["final"],
  );
  const passed = await h.run();
  assert.equal(passed.kind, "done", JSON.stringify(passed).slice(0, 800));
  assert.equal(passed.result.commit, fixed);
  assert.equal(passed.keep["final:held"], null);
});

test("a final validation failure held by 0.5.11, which kept no failure, takes retry and refuses repair", async () => {
  const h = await finalHarness();
  h.runner.apply("final", await h.run());
  const held = await h.run();
  // As 0.5.11 asked it: no `repair`, and no failure kept.
  held.options = held.options.filter((option) => option.answer !== "repair");
  delete held.keep["final:held"];
  h.runner.apply("final", held);
  assert.equal(fact(h.runner.state, "final:held"), undefined);
  assert.equal(h.answer("repair")?.code, "invalid_answer");
  assert.equal(h.answer("retry"), null);
});

test("final validation's failure goes to the Work Item the state attributes it to", () => {
  const items = [
    item("parse", {
      ownedPaths: ["src/parse/"],
      validation: [{ command: "npm test" }],
    }),
    item("render", {
      ownedPaths: ["src/render.js"],
      validation: [{ command: "npm test" }, { command: "npm run lint" }],
    }),
    item("check", { kind: "qa", validation: [{ command: "npm run e2e" }] }),
  ];
  const planned = plan(items, { base: "0".repeat(40) });
  const state = newObjective(43, new Date());
  state.done.plan = planned;
  state.done[stepKey("parse", "merge")] = merge(
    "1".repeat(40),
    "2026-10-30T01:00:00.000Z",
  );
  state.done[stepKey("render", "merge")] = merge(
    "2".repeat(40),
    "2026-10-30T02:00:00.000Z",
  );
  const deps = { config: { delivery: { kind: "regular" } } };
  const route = (failure) =>
    finalValidationRoute(
      planned,
      state,
      { head: "3".repeat(40), ...failure },
      deps,
    );
  const failed = (command, detail) => ({
    kind: "failed",
    command,
    detail,
    exit: "1",
  });
  // The Work Item whose own commands final validation ran.
  assert.equal(
    route({ item: "parse", failed: failed("npm test", "1 failing") }).item.id,
    "parse",
  );
  // The one owning a file the output names, as its tool printed it.
  const named = route({
    failed: failed(
      "npm test",
      "FAIL /tmp/factory-validation/final/src/parse/empty.test.js\n  expected [] got undefined",
    ),
  });
  assert.equal(named.item.id, "parse");
  assert.equal(named.why, "which owns files the failure names");
  // Else, of those whose validation runs the command, the last to merge.
  assert.equal(
    route({ failed: failed("npm test", "2 failing") }).item.id,
    "render",
  );
  assert.equal(
    route({ failed: failed("npm run lint", "lint failed") }).why,
    "whose own validation runs `npm run lint`",
  );
  // Else the last to merge; a QA item is never repaired.
  const last = route({
    item: "check",
    failed: failed("npm run e2e", "timeout"),
  });
  assert.equal(last.item.id, "render");
  assert.equal(last.why, "the last of this Objective's Work Items to merge");
  // With no coding Work Item merged there is no route.
  const none = newObjective(44, new Date());
  none.done.plan = planned;
  assert.equal(
    finalValidationRoute(
      planned,
      none,
      { head: "3".repeat(40), failed: failed("npm test", "x") },
      deps,
    ),
    undefined,
  );
});
