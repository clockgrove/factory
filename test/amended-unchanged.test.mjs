// After an accepted amendment, a worker that found its change already met
// the amended plan and left it as it was was refused as "no repository
// change" and charged as a failed repair (#2229): collection read the tree
// a refusal under the old plan judged as the refused result again. An
// amendment refuses nothing, so that tree is a result, validated and
// reviewed under the amended plan; a refusal of it since still makes it
// no change.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { implementationRepairs, perPath } from "../dist/allowances.js";
import { loadConfig } from "../dist/config.js";
import { ObjectiveRunner } from "../dist/engine.js";
import { RunLog } from "../dist/log.js";
import { providerWorkflow } from "../dist/providers/selection.js";
import { newObjective } from "../dist/state.js";
import { amendedAttempt } from "../dist/work/amend.js";
import { amendedOnly, refusedTreeFor } from "../dist/work/refused.js";
import { repairOutcome } from "../dist/work/step-deliver.js";
import { objectiveWorkflow } from "../dist/workflow.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
  until,
} from "./helpers.mjs";

const WORK = "item:a:work";
const AMENDMENT = "worker-a-2";
const a = item("a", {
  ownedPaths: ["src/a.js"],
  acceptance: ["A one holds", "A two holds"],
});

const failedValidation = () => ({
  kind: "failure",
  detail: "test -f src/b.js failed",
});

const reviewRefusal = (tree) => ({
  kind: "review",
  tree,
  refused: ["A one holds", "A two holds"].map((criterion, n) => ({
    criterionIndex: n,
    criterion,
    source: "model",
    detail: `Gap ${n + 1}.`,
    question: "",
    evidence: [],
  })),
});

/** A worker that leaves the change as it was: the refused tree again. */
const keeps = async (input) => {
  writeFileSync(join(input.worktree, "src", "a.js"), "export const a = 2;\n");
  return {
    kind: "finished",
    finalResponse: "Checked the change against the plan; it already meets it.",
  };
};

/**
 * Work Item a's work step as the service runs it, after one repair: its
 * result was refused on `finding`, which repair 1's correction answered,
 * and the refused result sits on its base in a real checkout. The
 * diagnosis's model and the worker are fakes that record their calls.
 */
function served(finding, { perPath: allowed = 1, work = keeps } = {}) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  let config;
  try {
    config = loadConfig(REPO);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
  const git = (...args) => {
    const result = spawnSync(
      "git",
      [
        "-C",
        config.checkout,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
      ].concat(args),
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(join(config.checkout, "src"), { recursive: true });
  writeFileSync(join(config.checkout, "src", "a.js"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(config.checkout, "src", "a.js"), "export const a = 2;\n");
  git("commit", "--quiet", "-am", "Factory: a");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  git("branch", "refused");
  git("reset", "--quiet", "--hard", base);

  const asked = [];
  const prompts = [];
  const planner = {
    answer: async (call) => {
      asked.push(call);
      return {
        value: {
          decision: "repair",
          diagnosis: `Diagnosis ${asked.length}.`,
          predecessor: "",
          path: "src/a.js",
          correction: `Correction ${asked.length}.`,
          question: "",
          requestedFiles: [],
          ownership: [],
          evidence: [],
          acceptance: [],
        },
      };
    },
  };
  const dir = tempDir("factory-amended-");
  const inner = objectiveWorkflow({
    config,
    github: {
      commitAuthor: async () => undefined,
      made() {},
      serviceToken: async () => "",
    },
    planner,
    worker: () => ({
      run: async (input) => {
        prompts.push(input.prompt);
        return work(input);
      },
    }),
    workDir: (issue) => join(dir, "work", String(issue)),
    objectives: join(dir, "objectives"),
  });
  const workflow = providerWorkflow(
    new Map([
      ["codex", { workflow: inner, frozen: { digest: "frozen", config: {} } }],
    ]),
    inner,
  );
  const state = newObjective(9, new Date(), {
    provider: "codex",
    selectedBy: "defaultProvider",
    digest: "frozen",
    config: { autonomy: { allowances: { perPath: allowed } } },
  });
  state.status = "building";
  state.done.predecessors = { predecessors: [], ignored: [] };
  state.done.check = {
    shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] },
    base,
    title: "A",
    reviewArtifacts: [],
  };
  state.done.plan = plan([a], { base });
  Object.assign(state.kept, {
    "item:a:base": base,
    "item:a:refused": { commit, tree, notes: [] },
    "item:a:finding": finding(tree),
    "item:a:diagnosis": {
      repair: 1,
      context: { finding: "refused" },
      applied: [
        {
          source: "review-findings",
          failure: "refused",
          diagnosis: "Diagnosis 0.",
          correction: "Correction 0.",
          repair: 1,
        },
      ],
    },
  });
  state.repairs[WORK] = { count: 1, findings: ["refused"] };
  const runner = new ObjectiveRunner(
    state,
    workflow,
    tempDir("factory-amended-state-"),
    new RunLog(join(dir, "logs"), "2026-10-30T00-00-00-000Z-1"),
    { id: "run", finished: 0, resumeAt: 0 },
  );
  /** Ticks until `done` holds; no tick once it does. */
  const run = (what, done) =>
    until(() => done() || (runner.tick(), false), what, 30_000);
  /** The work step's attempt once the worker's discovery was accepted as amendment AMENDMENT. */
  const amend = () => {
    runner.apply(
      WORK,
      amendedAttempt(a, runner.state, undefined, AMENDMENT, {}),
    );
    // The default branch is still at the item's start, so the replay onto
    // it moves nothing (and this checkout has no origin to fetch).
    delete runner.state.kept["item:a:rebase"];
  };
  const settled = (count) => () =>
    runner.state.done[WORK] ||
    runner.state.holds.length > 0 ||
    runner.state.repairs[WORK].count > count;
  return { runner, run, amend, settled, asked, prompts, base, commit, tree };
}

test("after an accepted amendment, the change left as it was is collected for validation, charging no repair (#2229)", async () => {
  // One repair allowed on the path, and spent: a charged no-change repair
  // would ask for `more` instead of validating.
  const served1 = served(failedValidation);
  const { runner, asked, prompts, base, tree } = served1;
  served1.amend();
  assert.deepEqual(runner.state.repairs[WORK].free, [2]);
  assert.equal(amendedOnly(runner.state, "a"), true);
  await served1.run("the work step", served1.settled(2));

  assert.equal(runner.state.holds.length, 0, runner.state.holds[0]?.question);
  const done = runner.state.done[WORK];
  assert.ok(done, "the work step is done");
  // The refused tree, committed by Factory on the item's start as a result.
  assert.equal(done.tree, tree);
  assert.equal(done.base, base);
  // No repair counted: the amended attempt's own one is free.
  assert.equal(runner.state.repairs[WORK].count, 2);
  assert.equal(perPath(runner.state)[WORK].used, 1);
  assert.equal(implementationRepairs(runner.state).used, 1);
  assert.equal(runner.state.kept["allowances:rereviews"], undefined);
  assert.equal(runner.state.kept["item:a:refused"], undefined);
  // The amendment was the attempt's correction: no diagnosis ran.
  assert.equal(asked.length, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Amendment worker-a-2 was accepted/);
});

test("an amendment followed by a refusal of the same tree is no change again (#2229)", async () => {
  const served1 = served(failedValidation, { perPath: 5 });
  const { runner, asked, prompts, tree } = served1;
  served1.amend();
  await served1.run("the amended result", served1.settled(2));
  assert.equal(runner.state.done[WORK]?.tree, tree);

  // Review refuses that result under the amended plan.
  runner.apply(
    "item:a:review",
    repairOutcome(a, "review", reviewRefusal(tree), runner.state, undefined),
  );
  assert.equal(runner.state.repairs[WORK].count, 3);
  assert.equal(runner.state.kept["item:a:refused"].tree, tree);
  assert.equal(amendedOnly(runner.state, "a"), false);
  await served1.run("the repair", served1.settled(3));

  assert.equal(runner.state.done[WORK], undefined);
  assert.equal(runner.state.holds.length, 0);
  assert.equal(runner.state.repairs[WORK].count, 4);
  assert.match(
    runner.state.repairs[WORK].findings.at(-1),
    /^Worker produced no repository change/,
  );
  assert.equal(perPath(runner.state)[WORK].used, 3);
  assert.equal(asked.length, 1, "the review refusal was diagnosed");
  assert.equal(prompts.length, 2);
});

test("after a review refusal, with no amendment, an unchanged tree is still an empty repair (#2229)", async () => {
  const served1 = served(reviewRefusal, { perPath: 5 });
  const { runner, prompts } = served1;
  assert.equal(amendedOnly(runner.state, "a"), false);
  await served1.run("the repair", served1.settled(1));
  assert.equal(runner.state.done[WORK], undefined);
  assert.equal(runner.state.repairs[WORK].count, 2);
  assert.match(
    runner.state.repairs[WORK].findings.at(-1),
    /^Worker produced no repository change/,
  );
  assert.equal(runner.state.repairs[WORK].free, undefined);
  assert.equal(prompts.length, 1);
});

test("after an accepted amendment, a result with media keeps its rule: its kept selection's refused tree is no change (#2229)", () => {
  const served1 = served(failedValidation);
  const { runner, tree } = served1;
  const set = { id: "A", members: [{ destination: "assets/a.png" }] };
  assert.equal(
    refusedTreeFor(runner.state, "a", { sets: [], selectionStands: false }),
    tree,
  );
  served1.amend();
  assert.equal(
    refusedTreeFor(runner.state, "a", { sets: [], selectionStands: false }),
    undefined,
  );
  assert.equal(
    refusedTreeFor(runner.state, "a", { sets: [set], selectionStands: true }),
    tree,
  );
  // New candidates are a new result, as before.
  assert.equal(
    refusedTreeFor(runner.state, "a", { sets: [set], selectionStands: false }),
    undefined,
  );
  // The operator's guidance diagnosed for the same repair replaces the
  // amendment's correction: the refused tree is no change again.
  assert.equal(
    refusedTreeFor(
      runner.state,
      "a",
      { sets: [], selectionStands: false },
      {
        "item:a:diagnosis": {
          repair: 2,
          context: { finding: "refused", operator: "Keep it." },
          applied: [],
        },
      },
    ),
    tree,
  );
});
