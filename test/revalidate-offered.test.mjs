// A repair-diagnosis question offered `revalidate` in its text, but the
// answer was refused (#2120): the service runs every Objective through
// providerWorkflow, which dropped the workflow's Work Item answers
// (`revalidatable`, `freshable` and the rest), so the engine never offered
// them, while the step wrote its own sentence offering `revalidate`. The
// engine now writes that sentence where it offers the answer, and the
// provider routing passes each answer on to the frozen provider's workflow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { ObjectiveRunner, hold } from "../dist/engine.js";
import { RunLog } from "../dist/log.js";
import { providerWorkflow } from "../dist/providers/selection.js";
import { newObjective } from "../dist/state.js";
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

const ID = "trusted-narrowing-proof";
const WORK = `item:${ID}:work`;
const BASE = "dc3e31082a400f4d93170263b260f675aff62fc4";
const HEAD = "cd38dc1124a824da19ceb7509740adccd66d5869";
const TREE = "aa2393dc8427bf89ce2796b2df5ca090f527651b";

/** The workflow as the service builds it: one provider's, routed by what the Objective froze. */
function served() {
  const inner = objectiveWorkflow({
    config: {
      repository: REPO,
      checkout: "/nonexistent",
      delivery: { kind: "regular" },
    },
    github: { made() {} },
  });
  const routes = new Map([
    ["codex", { workflow: inner, frozen: { digest: "frozen", config: {} } }],
  ]);
  return { inner, workflow: providerWorkflow(routes, inner) };
}

/**
 * Clockgrove #821 when its question was asked: the delivered PR's
 * required check failed (a CI repair), so the item keeps the refused
 * result on its base, and the work step's diagnosis asks.
 */
function held(digest = "frozen") {
  const state = newObjective(821, new Date(), {
    provider: "codex",
    selectedBy: "defaultProvider",
    digest,
    config: {},
  });
  state.status = "building";
  state.done.check = { base: BASE };
  state.done.plan = plan([item(ID, { kind: "work" })]);
  const finding = `Checks failed on PR #825 at ${HEAD}: checks (failure, https://github.com/clockgrove/clockgrove/actions/runs/40462855644/job/122053441527). Factory reran the failed Actions jobs of quality, checks once on this head, and the failure stands`;
  Object.assign(state.kept, {
    [`item:${ID}:base`]: BASE,
    // The CI repair asked for a replay onto the current start; the work
    // step's question keeps its base and clears it (keepBase).
    [`item:${ID}:rebase`]: true,
    [`item:${ID}:refused`]: { commit: HEAD, tree: TREE, notes: [] },
    [`item:${ID}:finding`]: { kind: "failure", detail: finding },
    [`item:${ID}:checkFailures`]: [finding],
  });
  state.repairs[WORK] = { count: 2, findings: [finding] };
  return state;
}

/** The repair diagnosis's question as the work step asks it (work/repair-context.ts). */
const diagnosis = {
  ...hold(
    `Work Item ${ID} needs your decision before it is repaired:\n\nWhat step failed in checks job 122053441527, and what error does its preceding log or quality-receipts-checks artifact report?\n\nAnswer \`answer <text>\` to send the worker your guidance, \`retry\` to diagnose the failure again, or \`replan\` to plan again.`,
    [
      "answer",
      {
        answer: "retry",
        family: "retry",
        consequence: "Diagnoses the failure again.",
      },
      "replan",
      "cancel",
    ],
  ),
  keep: { [`item:${ID}:base`]: BASE, [`item:${ID}:rebase`]: false },
};

function runner(state, workflow) {
  return new ObjectiveRunner(
    state,
    workflow,
    tempDir("factory-revalidate-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
}

test("the service's workflow keeps every Work Item answer of its provider's", () => {
  const { inner, workflow } = served();
  for (const hook of Object.keys(inner))
    assert.ok(hook in workflow, `providerWorkflow drops ${hook}`);
  // Each is the frozen provider's: none while the configuration changed.
  const state = held();
  state.kept[`item:${ID}:rebase`] = false;
  assert.equal(workflow.revalidatable(state, WORK), true);
  assert.equal(workflow.freshable(state, WORK), inner.freshable(state, WORK));
  const changed = held("another");
  changed.kept[`item:${ID}:rebase`] = false;
  assert.equal(workflow.revalidatable(changed, WORK), false);
  assert.equal(workflow.freshable(changed, WORK), false);
  assert.equal(workflow.diagnoseFirst(changed, WORK), false);
  assert.equal(workflow.overrunOffers(changed, WORK), undefined);
});

test("a repair diagnosis after a failed check offers revalidate exactly when it takes it", () => {
  const { workflow } = served();
  const engine = runner(held(), workflow);
  engine.apply(WORK, diagnosis);
  const [asked] = engine.state.holds;
  assert.equal(asked.step, WORK);
  assert.ok(
    asked.options.some((option) => option.answer === "revalidate"),
    JSON.stringify(asked.options),
  );
  // The engine's sentence, once, with the rereviews used of the allowance.
  assert.equal(asked.question.split("answer `revalidate`").length, 2);
  assert.match(
    asked.question,
    /this Objective has used 0 of 1 \(autonomy\.allowances\.resultRereviews\)\./,
  );
  // `factory answer 821 revalidate --question …` lands, charged as a rereview.
  assert.equal(
    engine.transact(() =>
      engine.answer("revalidate", undefined, "kirk", undefined, asked.id),
    ),
    null,
  );
  assert.equal(engine.state.answers[WORK].answer, "revalidate");
  assert.equal(engine.state.kept["allowances:rereviews"], 1);
});

test("a refused result that can't be checked again is offered in neither the options nor the text", () => {
  const { workflow } = served();
  const state = held();
  // The work step found it off its base (work/steps.ts `recheckMark`).
  state.kept[`item:${ID}:refused`] = {
    commit: HEAD,
    tree: TREE,
    notes: [],
    unrecheckable: true,
  };
  const engine = runner(state, workflow);
  engine.apply(WORK, diagnosis);
  const [asked] = engine.state.holds;
  assert.ok(!asked.options.some((option) => option.answer === "revalidate"));
  assert.doesNotMatch(asked.question, /revalidate/);
  const refused = engine.transact(() =>
    engine.answer("revalidate", undefined, "kirk", undefined, asked.id),
  );
  assert.equal(refused.code, "invalid_answer");
  assert.equal(engine.state.kept["allowances:rereviews"], undefined);
});

test("a kept result's question is answered revalidate by the engine only where it is taken", () => {
  const { workflow } = served();
  const kept = {
    ...hold("Work Item kept its refused result.", ["answer", "cancel"]),
    rereview: true,
    keep: { [`item:${ID}:base`]: BASE, [`item:${ID}:rebase`]: false },
  };
  const engine = runner(held(), workflow);
  engine.apply(WORK, kept);
  assert.equal(engine.state.holds.length, 0);
  assert.equal(engine.state.answers[WORK].answer, "revalidate");
  assert.equal(engine.state.answers[WORK].by, "factory");
  assert.equal(engine.state.kept["allowances:rereviews"], 1);
  // Gone or off its base: asked, with no `revalidate`, nothing charged.
  const state = held();
  state.kept[`item:${ID}:refused`] = {
    commit: HEAD,
    tree: TREE,
    notes: [],
    unrecheckable: true,
  };
  const off = runner(state, workflow);
  off.apply(WORK, kept);
  const [asked] = off.state.holds;
  assert.match(asked.question, /^Work Item kept its refused result\./);
  assert.doesNotMatch(asked.question, /revalidate/);
  assert.ok(!asked.options.some((option) => option.answer === "revalidate"));
  assert.equal(off.state.answers[WORK], undefined);
  assert.equal(off.state.kept["allowances:rereviews"], undefined);
});

/**
 * Work Item a's work step as the service runs it (providerWorkflow over the
 * real workflow), past its spent repair allowance (perPath 1, repaired
 * twice), with a real checkout: the refused result sits on its base, and
 * the diagnosis's model and the worker are fakes that record their calls.
 * The worker never finishes, unless `work` says what it does: reaching it
 * is where a repair starts. The item worktree is added at the kept base
 * when the step runs, unless `holding`: then it is kept from the refused
 * attempt and holds the refused change (uncommitted on the base, as a
 * resubmitted result leaves it). `validation`: the item's commands.
 */
function servedWork(
  finding,
  answers = [],
  { perPath = 1, work, holding = false, validation = [] } = {},
) {
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
      const n = asked.length;
      return {
        value: {
          decision: "repair",
          diagnosis: `Diagnosis ${n}.`,
          predecessor: "",
          path: "src/a.js",
          correction: `Correction ${n}.`,
          question: "",
          requestedFiles: [],
          ownership: [],
          evidence: [],
          acceptance: [],
          ...answers[n - 1],
        },
      };
    },
  };
  const dir = tempDir("factory-served-");
  if (holding) {
    // workDir(9)/9/a (worktree.ts `worktreePath`).
    const at = join(dir, "work", "9", "9", "a");
    mkdirSync(join(at, ".."), { recursive: true });
    git("worktree", "add", "--quiet", "--detach", at, base);
    writeFileSync(join(at, "src", "a.js"), "export const a = 2;\n");
  }
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
        if (work) return work(input);
        throw new Error("the worker ran");
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
  const a = item("a", {
    ownedPaths: ["src/a.js"],
    acceptance: ["A one holds", "A two holds"],
    validation,
  });
  const state = newObjective(9, new Date(), {
    provider: "codex",
    selectedBy: "defaultProvider",
    digest: "frozen",
    config: { autonomy: { allowances: { perPath } } },
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
    // An operator's `replace-validation` is recorded against it.
    ...(validation.length
      ? { "plan:acceptedAt": "2026-10-27T00:00:00.000Z" }
      : {}),
    "item:a:base": base,
    "item:a:refused": { commit, tree, notes: [] },
    "item:a:finding": finding(tree),
    // Repair 1's correction, which its worker tried.
    "item:a:diagnosis": {
      repair: 1,
      context: { finding: "refused" },
      applied: [
        {
          source: "review-findings",
          failure: "refused",
          diagnosis: "Tried.",
          correction: "Correction 0.",
        },
      ],
    },
  });
  state.repairs["item:a:work"] = { count: 2, findings: ["refused"] };
  const runner = new ObjectiveRunner(
    state,
    workflow,
    tempDir("factory-served-state-"),
    new RunLog(join(dir, "logs"), "2026-10-27T00-00-00-000Z-1"),
    { id: "run", finished: 0, resumeAt: 0 },
  );
  /** Ticks until `done` holds; no tick once it does. */
  const run = (what, done) =>
    until(() => done() || (runner.tick(), false), what, 30_000);
  const question = async () => {
    await run("a question", () => runner.state.holds.length > 0);
    return runner.state.holds[0];
  };
  const answer = (hold, ...args) =>
    assert.equal(
      runner.transact(() =>
        runner.answer(args[0], args[1], "kirk", undefined, hold.id, args[2]),
      ),
      null,
    );
  return { runner, run, question, answer, asked, prompts, commit };
}

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

// diagnoseFirst saves its diagnosis past the allowance before the worker
// tries it. `accept 1` there leaves criterion 2 standing, diagnosed again:
// that diagnosis was told its own untried correction had already failed,
// and after `more` the step diagnosed once more instead of repairing with
// the saved diagnosis (#2120).
test("accept on a spent repair allowance diagnoses what still stands once, as untried, and more repairs with it", async () => {
  const served = servedWork(reviewRefusal);
  const { runner, asked, prompts } = served;
  const first = await served.question();
  assert.equal(asked.length, 1, "diagnosed first");
  assert.equal(first.step, "item:a:work");
  assert.deepEqual(
    first.options.map((option) => option.answer + (option.arg ?? "")),
    ["more", "revalidate", "accept1", "accept2", "replan", "cancel"],
  );
  assert.equal(first.question.split("answer `revalidate`").length, 2);
  served.answer(first, "accept", "The reviewer misread it.", "1");
  const second = await served.question();
  assert.notEqual(second.id, first.id);
  assert.equal(asked.length, 2, "what still stands is diagnosed");
  assert.match(asked[1].prompt, /Correction 0\./);
  assert.doesNotMatch(
    asked[1].prompt,
    /Correction 1\./,
    "the correction no worker tried is no prior",
  );
  assert.deepEqual(
    second.options.map((option) => option.answer + (option.arg ?? "")),
    ["more", "revalidate", "accept2", "replan", "cancel"],
  );
  assert.deepEqual(
    runner.state.kept["item:a:diagnosis"].applied.map((c) => c.correction),
    ["Correction 0.", "Correction 2."],
  );
  // Saved with the repair that runs it, so the next diagnosis can tell
  // whether its failure came from this correction's attempt (#2173); the
  // one saved before corrections carried it has none.
  assert.deepEqual(
    runner.state.kept["item:a:diagnosis"].applied.map((c) => c.repair),
    [undefined, 2],
  );
  // `more`: the worker repairs with that diagnosis, and none runs again.
  served.answer(second, "more");
  await served.run("the worker", () => prompts.length > 0);
  assert.equal(asked.length, 2);
  assert.match(prompts[0], /Correction 2\./);
  // Charged once: the repair that led here, no rereview.
  assert.equal(runner.state.repairs["item:a:work"].count, 2);
  assert.equal(runner.state.kept["allowances:rereviews"], undefined);
  assert.equal(runner.state.kept["item:a:decisions"].length, 1);
});

const failedChecks = () => ({
  kind: "failure",
  detail: "Checks failed on PR #3: checks (failure)",
});

/** The validate step's kept result for `commit` (work/facts.ts `validation`). */
const validated = (commit) => ({
  commit,
  key: "digest",
  at: "2026-10-28T12:01:00.000Z",
  result: { kind: "passed", done: { tree: "t", commands: ["true"] } },
});

test("revalidate on a spent repair allowance finishes the work step with the same result, charged once as a rereview", async () => {
  const served = servedWork(failedChecks);
  const { runner, asked, prompts, commit } = served;
  const asked1 = await served.question();
  assert.equal(asked.length, 1, "diagnosed first");
  assert.deepEqual(
    asked1.options.map((option) => option.answer),
    ["more", "revalidate", "replan", "cancel"],
  );
  // The refused result's last validation, which the operator's own
  // `revalidate` doesn't reuse: it runs the commands again (#2174).
  runner.state.kept["item:a:validation"] = validated(commit);
  served.answer(asked1, "revalidate");
  const landed = runner.state.answers["item:a:work"].at;
  await served.run("the work step", () => runner.state.done["item:a:work"]);
  assert.equal(runner.state.done["item:a:work"].commit, commit);
  assert.deepEqual(runner.state.kept["item:a:rereviewed"], {
    commit,
    at: landed,
  });
  assert.equal(runner.state.kept["item:a:validation"], undefined);
  assert.equal(runner.state.kept["item:a:refused"], undefined);
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
  assert.equal(runner.state.repairs["item:a:work"].count, 2);
  assert.equal(asked.length, 1);
  assert.equal(prompts.length, 0, "no worker");
});

test("fresh on a repair diagnosis question past a spent allowance is one more repair, which asks for more", async () => {
  const served = servedWork(failedChecks, [
    { decision: "operator", question: "Which runtime does checks use?" },
  ]);
  const { runner, asked, prompts } = served;
  const diagnosis = await served.question();
  assert.match(diagnosis.question, /Which runtime does checks use\?/);
  assert.deepEqual(
    diagnosis.options.map((option) => option.answer),
    ["answer", "retry", "replan", "fresh", "revalidate", "cancel"],
  );
  assert.equal(diagnosis.question.split("answer `revalidate`").length, 2);
  served.answer(diagnosis, "fresh");
  const more = await served.question();
  assert.equal(runner.state.repairs["item:a:work"].count, 3);
  assert.equal(runner.state.kept["item:a:refused"], undefined);
  assert.equal(runner.state.kept["item:a:finding"], undefined);
  assert.match(more.question, /needs another repair, past its repair path's/);
  assert.deepEqual(
    more.options.map((option) => option.answer),
    ["more", "replan", "cancel"],
  );
  assert.equal(asked.length, 1);
  assert.equal(prompts.length, 0);
  assert.equal(runner.state.kept["allowances:rereviews"], undefined);
});

// Clockgrove #821 (#2131): the operator answered the diagnosis question
// with guidance to keep the change as it is, the worker did exactly that,
// and collection refused the unchanged result as "no repository change",
// charged as a repair past both repair allowances.
const KEEP =
  "Keep your change as it is; with the current main as its base, CI picks up the fix.";

/** A worker that keeps the refused result as it is: the refused tree again. */
const keeps = async (input) => {
  writeFileSync(join(input.worktree, "src", "a.js"), "export const a = 2;\n");
  return {
    kind: "finished",
    finalResponse: "Kept the change as it is, as the operator said.",
  };
};

const operatorQuestion = [
  { decision: "operator", question: "Is the failed check the change's?" },
];

test("a result kept unchanged on the operator's guidance is checked again as a rereview, not charged as a repair", async () => {
  const served = servedWork(failedChecks, operatorQuestion, {
    perPath: 5,
    work: keeps,
  });
  const { runner, asked, prompts, commit } = served;
  // Factory's own `revalidate` keeps the refused result's last validation,
  // which the validate step reuses for that same commit (#2174).
  const kept = validated(commit);
  runner.state.kept["item:a:validation"] = kept;
  const diagnosis = await served.question();
  served.answer(diagnosis, "answer", KEEP);
  await served.run(
    "the work step",
    () =>
      runner.state.done["item:a:work"] ||
      runner.state.holds.length > 0 ||
      runner.state.repairs["item:a:work"].count > 2,
  );
  assert.deepEqual(runner.state.kept["item:a:validation"], kept);
  assert.equal(prompts.length, 1, "the worker ran once, with the guidance");
  assert.match(prompts[0], /Keep your change as it is/);
  assert.equal(runner.state.repairs["item:a:work"].count, 2, "no repair");
  assert.equal(runner.state.done["item:a:work"]?.commit, commit);
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
  assert.equal(runner.state.kept["item:a:rereviewed"].commit, commit);
  assert.equal(runner.state.kept["item:a:refused"], undefined);
  assert.equal(runner.state.kept["item:a:finished"], undefined);
  assert.equal(runner.state.holds.length, 0);
  assert.equal(asked.length, 1);
});

test("past the rereview allowance, a result kept on the operator's guidance asks, charging no repair", async () => {
  const served = servedWork(failedChecks, operatorQuestion, {
    perPath: 5,
    work: keeps,
  });
  const { runner, prompts, commit } = served;
  runner.state.kept["allowances:rereviews"] = 1;
  const diagnosis = await served.question();
  served.answer(diagnosis, "answer", KEEP);
  await served.run(
    "the kept result's question",
    () =>
      (runner.state.holds.length > 0 &&
        runner.state.holds[0].id !== diagnosis.id) ||
      runner.state.repairs["item:a:work"].count > 2,
  );
  const kept = runner.state.holds[0];
  assert.equal(runner.state.repairs["item:a:work"].count, 2, "no repair");
  assert.match(
    kept.question,
    /^After your guidance, Work Item a's worker resubmitted its refused result unchanged,/,
  );
  assert.match(kept.question, /Kept the change as it is/);
  // The engine's sentence, once, where it offers the answer.
  assert.equal(kept.question.split("answer `revalidate`").length, 2);
  assert.deepEqual(
    kept.options.map((option) => option.answer),
    ["answer", "replan", "fresh", "revalidate", "cancel"],
  );
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
  assert.equal(prompts.length, 1);
  // `revalidate` asks for `more`, which checks the same result again.
  served.answer(kept, "revalidate");
  const more = await served.question();
  assert.match(more.question, /result rereview/);
  served.answer(more, "more");
  await served.run("the work step", () => runner.state.done["item:a:work"]);
  assert.equal(runner.state.done["item:a:work"].commit, commit);
  assert.equal(runner.state.kept["allowances:rereviews"], 2);
  assert.equal(runner.state.repairs["item:a:work"].count, 2);
  assert.equal(prompts.length, 1);
});

/**
 * A worker that changes nothing. servedWork's item worktree is added at the
 * kept base and nothing replays the refused change into it, so its
 * checkout never held the refused result: it leaves no change at all.
 */
const idles = async (input) => {
  assert.equal(
    readFileSync(join(input.worktree, "src", "a.js"), "utf8"),
    "export const a = 1;\n",
    "the checkout is the base's, without the refused change",
  );
  return {
    kind: "finished",
    finalResponse: "Kept the change as it is; I changed nothing.",
  };
};

// The same guidance, in a checkout that doesn't hold the refused change
// (one added again at the kept base): the worker changes nothing, which
// collection finds empty rather than unchanged. It was refused as "no
// repository change" and charged as a repair, the #2131 symptom.
test("a worker that makes no change after the operator's guidance, in a checkout without its refused result, is checked again as a rereview", async () => {
  const served = servedWork(failedChecks, operatorQuestion, {
    perPath: 5,
    work: idles,
  });
  const { runner, prompts, commit } = served;
  const diagnosis = await served.question();
  served.answer(diagnosis, "answer", KEEP);
  await served.run(
    "the work step",
    () =>
      runner.state.done["item:a:work"] ||
      (runner.state.holds.length > 0 &&
        runner.state.holds[0].id !== diagnosis.id) ||
      runner.state.repairs["item:a:work"].count > 2,
  );
  assert.equal(prompts.length, 1);
  assert.equal(runner.state.repairs["item:a:work"].count, 2, "no repair");
  assert.deepEqual(runner.state.repairs["item:a:work"].findings, ["refused"]);
  assert.equal(runner.state.holds.length, 0);
  assert.equal(runner.state.done["item:a:work"]?.commit, commit);
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
  assert.equal(runner.state.kept["item:a:rereviewed"].commit, commit);
});

test("past the rereview allowance, a worker that made no change after the operator's guidance asks, charging no repair", async () => {
  const served = servedWork(failedChecks, operatorQuestion, {
    perPath: 5,
    work: idles,
  });
  const { runner } = served;
  runner.state.kept["allowances:rereviews"] = 1;
  const diagnosis = await served.question();
  served.answer(diagnosis, "answer", KEEP);
  await served.run(
    "the question",
    () =>
      (runner.state.holds.length > 0 &&
        runner.state.holds[0].id !== diagnosis.id) ||
      runner.state.repairs["item:a:work"].count > 2,
  );
  const [asked] = runner.state.holds;
  assert.equal(runner.state.repairs["item:a:work"].count, 2, "no repair");
  assert.match(
    asked.question,
    /^After your guidance, Work Item a's worker made no change,/,
  );
  assert.match(asked.question, /I changed nothing\./);
  assert.ok(asked.options.some((option) => option.answer === "revalidate"));
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
});

/** A worker whose checkout holds the refused change and that changes nothing. */
const leaves = async (input) => {
  assert.equal(
    readFileSync(join(input.worktree, "src", "a.js"), "utf8"),
    "export const a = 2;\n",
    "the kept checkout holds the refused change",
  );
  return { kind: "finished", finalResponse: "Kept the change as it is." };
};

/** A worker that removes the refused change from a checkout that held it. */
const reverts = async (input) => {
  assert.equal(
    readFileSync(join(input.worktree, "src", "a.js"), "utf8"),
    "export const a = 2;\n",
    "the kept checkout holds the refused change",
  );
  writeFileSync(join(input.worktree, "src", "a.js"), "export const a = 1;\n");
  return {
    kind: "finished",
    finalResponse: "Removed my change to src/a.js, as the operator said.",
  };
};

// In a checkout that held the refused change, an empty change is the
// worker removing it: that is a change, not the worker keeping its result.
// It was taken for "made no change", and the refused result the worker
// dropped was checked again (and could be delivered) as a rereview.
test("a worker that removes its refused change after the operator's guidance is refused, not taken as keeping it", async () => {
  const served = servedWork(failedChecks, operatorQuestion, {
    perPath: 5,
    work: reverts,
    holding: true,
  });
  const { runner, prompts } = served;
  const diagnosis = await served.question();
  served.answer(diagnosis, "answer", "Drop your change to src/a.js.");
  await served.run(
    "the work step",
    () =>
      runner.state.done["item:a:work"] ||
      (runner.state.holds.length > 0 &&
        runner.state.holds[0].id !== diagnosis.id) ||
      runner.state.repairs["item:a:work"].count > 2,
  );
  assert.equal(prompts.length, 1);
  assert.equal(runner.state.done["item:a:work"], undefined);
  assert.equal(runner.state.holds.length, 0);
  assert.equal(runner.state.repairs["item:a:work"].count, 3);
  assert.match(
    runner.state.repairs["item:a:work"].findings.at(-1),
    /^Worker produced no repository change/,
  );
  assert.equal(runner.state.kept["allowances:rereviews"], undefined);
});

// The same kept checkout, left as it was: the refused result resubmitted.
test("a worker that leaves its kept checkout as it was after the operator's guidance is checked again as a rereview", async () => {
  const served = servedWork(failedChecks, operatorQuestion, {
    perPath: 5,
    work: leaves,
    holding: true,
  });
  const { runner, prompts, commit } = served;
  const diagnosis = await served.question();
  served.answer(diagnosis, "answer", KEEP);
  await served.run(
    "the work step",
    () =>
      runner.state.done["item:a:work"] ||
      (runner.state.holds.length > 0 &&
        runner.state.holds[0].id !== diagnosis.id) ||
      runner.state.repairs["item:a:work"].count > 2,
  );
  assert.equal(prompts.length, 1);
  assert.equal(runner.state.repairs["item:a:work"].count, 2, "no repair");
  assert.equal(runner.state.done["item:a:work"]?.commit, commit);
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
});

for (const [what, work] of [
  ["an unchanged result", keeps],
  ["no change at all", idles],
])
  test(`${what} after Factory's own diagnosis is still refused as a repair`, async () => {
    const served = servedWork(failedChecks, [], { perPath: 5, work });
    const { runner, prompts } = served;
    await served.run(
      "the repair",
      () =>
        runner.state.repairs["item:a:work"].count > 2 ||
        runner.state.done["item:a:work"],
    );
    assert.equal(runner.state.done["item:a:work"], undefined);
    assert.equal(runner.state.repairs["item:a:work"].count, 3);
    assert.match(
      runner.state.repairs["item:a:work"].findings.at(-1),
      /^Worker produced no repository change/,
    );
    assert.equal(runner.state.kept["allowances:rereviews"], undefined);
    assert.equal(prompts.length, 1);
  });

// #2199: a diagnosis question answered `replace-validation` it can't take
// was asked again from the question text the engine stored, with a fixed
// list of offers: it lost a review refusal's `accept <n>`, which its text
// still offered, and repeated the engine's own notes.
const COMMANDS = [
  { command: "npm test" },
  { command: "grep -q 'Rollout steps' docs/guide.md" },
];
const REASON = "It greps a heading the guide never had; check the list.";
const whichHeading = [
  { decision: "operator", question: "Which heading does the guide use?" },
];
const offered = (hold) =>
  hold.options.map((option) => option.answer + (option.arg ?? ""));

test("a review refusal's diagnosis question asked again after a replace-validation it can't take offers what it offered, and its text once (#2199)", async () => {
  const served = servedWork(reviewRefusal, whichHeading, {
    perPath: 5,
    validation: COMMANDS,
  });
  const { runner, asked, prompts } = served;
  const first = await served.question();
  assert.ok(offered(first).includes("replace-validation"), offered(first));
  assert.ok(offered(first).includes("accept2"), offered(first));
  served.answer(first, "replace-validation", `a 9 ${REASON}`);
  const second = await served.question();
  assert.notEqual(second.id, first.id);
  assert.deepEqual(offered(second), offered(first));
  assert.match(
    second.question,
    /^Work Item a needs your decision before it is repaired:\n\nWhich heading does the guide use\?/,
  );
  assert.match(
    second.question,
    /wasn't taken: Work Item a has no validation command 9; its commands are 0 `npm test`, 1 `grep/,
  );
  // Each sentence once: the step's, and the engine's where it offers.
  for (const once of [
    "answer `revalidate`",
    "answer `accept <n> <reason>`",
    "wasn't taken",
  ])
    assert.equal(second.question.split(once).length, 2, once);
  assert.equal(runner.state.kept["validation:authorized"], undefined);
  // What its text offers, it takes.
  served.answer(second, "accept", "The reviewer misread it.", "2");
  assert.equal(asked.length, 1);
  assert.equal(prompts.length, 0);
});

test("a diagnosis question answered replace-validation proposes the item's amendment, and the item runs again on the amended plan once it is accepted, charged to no allowance (#2199)", async () => {
  const served = servedWork(failedChecks, whichHeading, {
    perPath: 5,
    validation: COMMANDS,
  });
  const { runner, asked, prompts } = served;
  const diagnosis = await served.question();
  served.answer(diagnosis, "replace-validation", `a 1 ${REASON}`);
  const PROPOSAL = "amend:validation-a-2:proposal";
  await served.run("the proposal", () => runner.state.kept[PROPOSAL]);
  const proposal = runner.state.kept[PROPOSAL];
  assert.deepEqual(proposal.worker, { itemId: "a", attempt: 3 });
  assert.equal(proposal.plan, "2026-10-27T00:00:00.000Z");
  assert.deepEqual(
    runner.state.kept["validation:authorized"].map((entry) => entry.command),
    [COMMANDS[1].command],
  );
  assert.equal(runner.state.kept["item:a:asked"], undefined);
  assert.equal(runner.state.done["item:a:work"], undefined);
  assert.equal(asked.length, 1, "no diagnosis runs again");
  assert.equal(prompts.length, 0);
  // Its review accepted it (planning/amendments.ts): the work step's next
  // run starts a new attempt on the amended plan, its own repair `free`.
  runner.state.done["amend:validation-a-2"] = { plan: runner.state.done.plan };
  await served.run(
    "the amended attempt",
    () => runner.state.repairs["item:a:work"].count > 2,
  );
  const repairs = runner.state.repairs["item:a:work"];
  assert.equal(repairs.count, 3);
  assert.deepEqual(repairs.free, [3]);
  assert.match(
    repairs.findings.at(-1),
    /^Amendment validation-a-2 was accepted/,
  );
  assert.equal(runner.state.kept["item:a:rebase"], true);
  assert.equal(asked.length, 1, "no diagnosis");
});
