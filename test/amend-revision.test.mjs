// An amendment's plan round that Factory's plan checks refuse goes back to
// its planner, as in first planning. Live (Codex, worker-discovery), the
// amendment planner added the item that owns the file the worker
// discovered but left it out of the integrated QA item's dependencies, and
// the graph check rejected the whole amendment and asked a person. The
// planner's answers are fixed here, in the shape that run's had. The
// independent review's fix findings go back to the planner the same way.
// Both get the files the discovery cites: live, without them, the planner
// asked the operator what a cited test imports. Both are told the
// started-item rule: live (Claude, discovery case), the planner relaxed its
// own worker's item's `npm test` acceptance and validation to make room for
// the new item, and the fence's finding rejected the amendment and asked a
// person. Factory now sets such a change back itself (#2088): live (Codex,
// discovery case), the planner grew its worker's item's owned paths to take
// the discovered file, as the rule allows, but reworded the item's goal in
// rounds 2 and 3 too, so the same fence finding twice rejected it. What
// Factory can't set back, a removed started item, still goes back. A
// planner's cannotPlan is reviewed like a plan (#2105): live (Codex,
// plan.discovery), a wrong refusal rejected the amendment with no review.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import {
  amendmentStatus,
  amendmentSteps,
  citedFiles,
  declineDiscovery,
  proposalProblems,
  startedItemRule,
} from "../dist/planning/amendments.js";
import { buildFacts } from "../dist/planning/facts.js";
import {
  NO_GAP_ANSWER,
  NO_GAP_REFUSAL,
  REFUSAL_REVIEW_LATER_ROUND,
  SELECTED_MEDIA_ABSENT,
} from "../dist/planning/rubric.js";
import { planningRevisions } from "../dist/planning/steps.js";
import { decodePlan } from "../dist/planning/wire.js";
import { readShown } from "../dist/shown.js";
import { failedCommandKept } from "../dist/work/step-validate.js";
import { configured, installation, REPO, tempDir } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** The installation's configuration, on a checkout of `checkout`. */
function loaded(checkout) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return { ...loadConfig(REPO), checkout };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const shown = readShown(
  "<h2>Goal</h2>\n<p>Add <code>a</code>.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>a()</code> returns <code>1</code>.</li>\n<li><code>npm test</code> passes.</li>\n</ul>",
  { sources: true },
);

const work = (id, fields = {}) => ({
  kind: "work",
  id,
  title: `Add ${id}`,
  goal: `Add ${id}.`,
  acceptance: [`${id}() returns 1.`],
  nonGoals: ["No other change."],
  citations: [{ path: "OBJECTIVE", heading: "" }],
  children: [],
  dependencies: [],
  ownedPaths: [`src/${id}.js`],
  newPackages: [],
  priority: 1,
  resources: [],
  scheduling: null,
  validation: ["npm test"],
  brief: `Export ${id} from src/${id}.js.`,
  oneOutcomeReason: null,
  sourceAssets: [],
  media: null,
  ...fields,
});

const qa = (dependencies) => ({
  kind: "qa",
  id: "qa",
  title: "Verify integrated Objective",
  goal: "Verify the integrated result.",
  acceptance: ["`npm test` passes on the integrated result."],
  nonGoals: ["Changing implementation or tests."],
  citations: [{ path: "OBJECTIVE", heading: "" }],
  children: [],
  dependencies,
  priority: 1,
  resources: [],
  scheduling: null,
  validation: ["npm test"],
  brief: "Run the Objective's command on the integrated result.",
  oneOutcomeReason: null,
});

/** The accepted plan's answer: a, and integrated QA after it. */
const accepted = {
  items: [work("a"), qa(["a"])],
  coverage: [
    { itemId: "a", proof: { kind: "result-semantic" }, environment: null },
    {
      itemId: "qa",
      proof: { kind: "integrated-command", validationIndex: 0 },
      environment: null,
    },
  ],
  sourceObligations: [],
  requiredPreIntegrationChecks: [],
  cannotPlan: null,
  decisionRequired: null,
};

/** A revision of the planner's current answer. */
const revision = (items = [], itemEdits = []) => ({
  items,
  itemEdits,
  removedItemIds: [],
  coverage: [],
  sourceObligations: null,
  requiredPreIntegrationChecks: null,
  cannotPlan: null,
  decisionRequired: null,
});

// The run's slip: the new item, and the QA item left as it was.
const missingQa = revision([work("b")]);
const reachesB = revision([qa(["a", "b"])]);
const REACH =
  "Integrated QA item qa must depend, directly or through others, on every implementation item; it does not reach b";

const ACCEPTED_AT = "2026-01-01T00:00:00.000Z";
const discovery = {
  scope: "in-scope",
  reason: "A repository test needs src/b.js, which no item owns",
  evidence: ["npm test fails: cannot find module ../src/b.js"],
  ownership: ["src/b.js"],
  acceptance: ["src/b.js exports b, and npm test passes"],
  dependencies: [],
};

/** An Objective building the accepted plan, with operator proposal op-1 pending. */
async function building({ kept = {}, frozen, answer = accepted } = {}) {
  const checkout = join(tempDir("factory-amend-revision-"), "c");
  mkdirSync(join(checkout, "src"), { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: "node --test" } }),
  );
  writeFileSync(join(checkout, "src", "a.js"), "export const a = () => 1;\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  const base = git(checkout, "rev-parse", "HEAD");
  const built = await buildFacts({ objective: 9, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const decoded = decodePlan(answer, built.facts);
  assert.deepEqual(decoded.findings, []);
  const state = {
    issue: 9,
    ...(frozen ? { frozen } : {}),
    holds: [],
    answers: {},
    retries: {},
    attempts: {},
    repairs: {},
    done: {
      check: { shown, writer: true, base, title: "Add a", reviewArtifacts: [] },
      "plan:1:1": { answer, draft: decoded.plan },
      "decide:1:1": { accept: true },
      plan: { ...decoded.plan, finalCommands: [], decisions: [] },
    },
    kept: {
      "plan:acceptedAt": ACCEPTED_AT,
      "amend:op-1:proposal": {
        id: "op-1",
        actor: "octo",
        at: "2026-01-01T01:00:00.000Z",
        plan: ACCEPTED_AT,
        discovery,
      },
      ...kept,
    },
  };
  return { checkout, state };
}

/** The planner's answers, in order; every call it got. */
function scripted(...answers) {
  const asked = [];
  return {
    asked,
    planner: {
      answer: async (call) => {
        asked.push(call);
        assert.ok(answers.length, `an unexpected ${call.phase} call`);
        return { value: answers.shift() };
      },
    },
  };
}

/**
 * The amendment's next step, run once against `state` and applied as the
 * engine applies it; its log events go to `logged`.
 */
async function step(state, deps, answer, logged = []) {
  const [next] = amendmentSteps(state, deps);
  const kept = {};
  const outcome = await next.run({
    state,
    ...(answer ? { answer } : {}),
    signal: AbortSignal.timeout(60_000),
    log: (event) => logged.push(event),
    runFile: () => assert.fail("no run file"),
    keep: (facts) => Object.assign(kept, facts),
  });
  for (const [key, value] of Object.entries({ ...kept, ...outcome.keep }))
    if (value === null) delete state.kept[key];
    else state.kept[key] = value;
  if (outcome.kind === "done") state.done[next.key] = outcome.result;
  return { key: next.key, outcome };
}

function depsOf(checkout, planner, posted = []) {
  const work = tempDir("factory-amend-work-");
  return {
    config: loaded(checkout),
    planner,
    github: {
      upsertComment: async (issue, marker, body) =>
        posted.push({ issue, marker, body }),
    },
    workDir: (issue) => join(work, String(issue)),
    objectives: work,
  };
}

test("an amendment whose new item the integrated QA item doesn't reach goes back to its planner, and the corrected round is reviewed and accepted", async () => {
  const { checkout, state } = await building();
  const { planner, asked } = scripted(missingQa, reachesB, { findings: [] });
  const posted = [];
  const deps = depsOf(checkout, planner, posted);
  assert.equal(planningRevisions(state).used, 1);

  // Round 1: the graph check's finding goes back to the planner.
  const first = await step(state, deps);
  assert.equal(first.key, "amend:op-1:plan");
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  assert.equal(
    first.outcome.reason,
    "Amendment plan round 1 has 1 fix finding; revising",
  );
  assert.equal(first.outcome.progress, true);
  assert.equal(state.done["amend:op-1:plan"], undefined);
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(
    kept.findings.map((f) => f.message),
    [REACH],
  );
  assert.deepEqual(
    kept.answer.items.map((item) => item.id),
    ["a", "qa", "b"],
  );
  // The round is charged.
  assert.equal(planningRevisions(state).used, 2);

  // Round 2 revises its own answer with the finding, and passes.
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(asked[1].prompt.includes(REACH));
  assert.equal(asked[1].phase, "plan");
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.rejected, undefined);
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "qa").dependencies,
    ["a", "b"],
  );
  assert.equal(state.kept["amend:op-1:revisions"].length, 1);

  // The independent review runs, and the amendment is accepted.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.equal(asked[2].phase, "graph-review");
  assert.deepEqual(review.outcome, { kind: "done", result: { round: 2 } });
  const accept = await step(state, deps);
  assert.equal(accept.key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined);
  assert.deepEqual(
    result.plan.items.map((item) => item.id),
    ["a", "qa", "b"],
  );
  assert.equal(posted.length, 1);
  assert.equal(asked.length, 3);
  assert.equal(planningRevisions(state).used, 2);
});

test("an amendment's check findings still reject when they repeat; past the allowance its next round asks first", async () => {
  // The same findings twice.
  {
    const { checkout, state } = await building();
    const { planner } = scripted(missingQa, revision());
    const deps = depsOf(checkout, planner);
    assert.equal((await step(state, deps)).outcome.kind, "retry");
    const again = await step(state, deps);
    assert.equal(again.outcome.kind, "done");
    assert.equal(
      state.done["amend:op-1:plan"].rejected,
      `Amendment plan round 2 came back with the same problems as round 1: ${REACH}`,
    );
    await step(state, deps);
    assert.equal(
      state.done["amend:op-1"].rejected,
      state.done["amend:op-1:plan"].rejected,
    );
  }
  // Past planningRevisions, the next round asks before the planner runs.
  {
    const { checkout, state } = await building({
      frozen: {
        config: { autonomy: { allowances: { planningRevisions: 1 } } },
      },
    });
    const { planner, asked } = scripted(missingQa);
    const deps = depsOf(checkout, planner);
    assert.equal((await step(state, deps)).outcome.kind, "retry");
    const held = (await step(state, deps)).outcome;
    assert.equal(held.kind, "hold");
    assert.match(held.question, /takes this Objective to 2 planning revisions/);
    assert.deepEqual(
      held.options.map((option) => option.answer),
      ["more", "refuse", "cancel"],
    );
    assert.equal(asked.length, 1);
    const refused = await step(state, deps, {
      answer: "refuse",
      holdId: "h1",
      by: "octo",
      at: ACCEPTED_AT,
    });
    assert.equal(refused.outcome.kind, "done");
    assert.match(state.done["amend:op-1:plan"].rejected, /refused/);
  }
});

// A round the plan checks pass, and the review's answers on it.
const withB = revision([work("b"), qa(["a", "b"])]);
const restatesB = revision([
  work("b", {
    acceptance: ["b() returns 1, which the repository test checks."],
  }),
]);
const VAGUE =
  "Acceptance of b does not say that the repository test needing src/b.js passes";
const reviewed = (kind) => ({
  findings: [
    { kind, itemIds: ["b"], evidenceIndices: [], detail: VAGUE, question: "" },
  ],
});

test("an amendment's review fix finding goes back to its planner, and the corrected round is reviewed again and accepted", async () => {
  const { checkout, state } = await building();
  const { planner, asked } = scripted(withB, reviewed("fix"), restatesB, {
    findings: [],
  });
  const posted = [];
  const deps = depsOf(checkout, planner, posted);
  assert.equal((await step(state, deps)).outcome.kind, "done");

  // The review's fix finding sends round 1 back, charged.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.equal(review.outcome.kind, "retry", JSON.stringify(review.outcome));
  assert.equal(
    review.outcome.reason,
    "Amendment plan round 1 has 1 fix finding; revising",
  );
  assert.equal(state.done["amend:op-1:review"], undefined);
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(
    kept.findings.map((f) => [f.source, f.kind]),
    [["review", "fix"]],
  );
  assert.deepEqual(kept.answer, state.done["amend:op-1:plan"].answer);
  assert.equal(planningRevisions(state).used, 2);

  // Round 2 revises round 1's answer with the review's finding.
  const second = await step(state, deps);
  assert.equal(second.key, "amend:op-1:plan");
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.equal(asked[2].phase, "plan");
  assert.ok(asked[2].prompt.includes(VAGUE));
  assert.deepEqual(
    state.done["amend:op-1:plan"].answer.items.find((item) => item.id === "b")
      .acceptance,
    ["b() returns 1, which the repository test checks."],
  );

  // It is reviewed again, and accepted.
  const again = await step(state, deps);
  assert.equal(again.key, "amend:op-1:review");
  assert.equal(asked[3].phase, "graph-review");
  assert.deepEqual(again.outcome, { kind: "done", result: { round: 2 } });
  const accept = await step(state, deps);
  assert.equal(accept.key, "amend:op-1");
  assert.equal(state.done["amend:op-1"].rejected, undefined);
  assert.equal(posted.length, 1);
  assert.equal(asked.length, 4);
  assert.equal(planningRevisions(state).used, 2);
});

test("an amendment's review still rejects it on an operator decision, or on the same findings twice", async () => {
  {
    const { checkout, state } = await building();
    const { planner } = scripted(withB, reviewed("operator-decision"));
    const deps = depsOf(checkout, planner);
    await step(state, deps);
    const review = await step(state, deps);
    assert.equal(review.outcome.kind, "done");
    assert.ok(
      review.outcome.result.rejected.startsWith(
        `Independent amendment review: ${VAGUE}`,
      ),
    );
    assert.equal(state.kept["amend:op-1:revisions"], undefined);
    await step(state, deps);
    assert.equal(
      state.done["amend:op-1"].rejected,
      review.outcome.result.rejected,
    );
  }
  {
    const { checkout, state } = await building();
    const { planner } = scripted(
      withB,
      reviewed("fix"),
      restatesB,
      reviewed("fix"),
    );
    const deps = depsOf(checkout, planner);
    await step(state, deps);
    assert.equal((await step(state, deps)).outcome.kind, "retry");
    await step(state, deps);
    const again = await step(state, deps);
    assert.equal(again.key, "amend:op-1:review");
    assert.equal(again.outcome.kind, "done");
    assert.ok(
      state.done["amend:op-1:review"].rejected.startsWith(
        `Independent amendment review: Amendment plan round 2 came back with the same problems as round 1: ${VAGUE}`,
      ),
    );
    assert.equal(state.kept["amend:op-1:revisions"].length, 1);
  }
  {
    // A review invalid twice rejects, and the operator still reads the
    // planner's reason.
    const { checkout, state } = await discovered();
    const { planner } = scripted(refuses, { verdict: "ok" }, { verdict: "ok" });
    const deps = depsOf(checkout, planner);
    await step(state, deps);
    assert.equal((await step(state, deps)).outcome.kind, "retry");
    const again = await step(state, deps);
    assert.equal(again.key, "amend:op-1:review");
    assert.ok(
      state.done["amend:op-1:review"].rejected.startsWith(
        `${REFUSED} The amendment review answer was invalid twice: `,
      ),
      state.done["amend:op-1:review"].rejected,
    );
    await step(state, deps);
    assert.equal(
      state.done["amend:op-1"].rejected,
      state.done["amend:op-1:review"].rejected,
    );
  }
});

// The run's slip: a's own worker proposed b, and the planner relaxed a's
// acceptance, brief and validation so that b, after a, could make
// `npm test` pass.
const relaxesA = revision([
  work("a", {
    acceptance: ["a() returns 1 when its own test runs."],
    brief: "Export a from src/a.js; npm test is qa's to prove.",
    validation: ["node --test test/a.test.js"],
  }),
  work("b", { dependencies: ["a"] }),
  qa(["a", "b"]),
]);
// Round 2 puts a back as it was; b and qa stay from round 1.
const restoresA = revision([work("a")]);
const STARTED_A =
  "Work Item a has started, so it keeps its spec, except that its owned paths or dependencies may grow, keeping every entry, and only then may its acceptance, brief and non-goals be restated; this answer changes its acceptance, brief. Restore the rest, and put further work in a new item or grow its owned paths or dependencies to take it";
/** A string as it reads inside the JSON the planner and the review get. */
const inJson = (text) => JSON.stringify(text).slice(1, -1);
const RULE = inJson(
  startedItemRule({ started: new Set(["a"]), reattempt: new Set(["a"]) }),
);

/** As `building`, with a started and op-1 the discovery of a's worker at its first attempt. */
async function discovered(options = {}) {
  const built = await building({
    ...options,
    kept: { "item:a:base": "0".repeat(40), ...options.kept },
  });
  built.state.kept["amend:op-1:proposal"].worker = { itemId: "a", attempt: 1 };
  return built;
}

/** The review's prompt holds `restored` as FACTORY_AMENDMENT's restoredFields. */
const toldRestored = (prompt, restored) =>
  prompt.includes(`"restoredFields":${JSON.stringify(restored)}}`);

test("an amendment that changes a started item without growing it has the change set back, and the review, told the rule and what was set back, accepts it", async () => {
  const { checkout, state } = await discovered();
  const { planner, asked } = scripted(relaxesA, { findings: [] });
  const posted = [];
  const logged = [];
  const deps = depsOf(checkout, planner, posted);

  // Round 1: a grows neither its owned paths nor its dependencies, so its
  // restated acceptance and brief, and its validation, are set back;
  // nothing goes back.
  const first = await step(state, deps, undefined, logged);
  assert.equal(first.key, "amend:op-1:plan");
  assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
  // The planner was told the rule, naming a as started and its reattempt.
  assert.ok(asked[0].prompt.includes(RULE));
  assert.ok(RULE.includes('startedItemIds: \\"a\\"'), RULE);
  // And that a media item's missing selected set is no gap in the plan:
  // live (Codex, media.select-repair), a worker's ENOENT on its own
  // destinations became an amendment the planner could never satisfy.
  assert.ok(asked[0].prompt.includes(inJson(SELECTED_MEDIA_ABSENT)));
  const restored = [
    { itemId: "a", fields: ["acceptance", "brief", "validation"] },
  ];
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.rejected, undefined);
  assert.equal(round.round, 1);
  assert.deepEqual(round.restored, restored);
  assert.equal(state.kept["amend:op-1:revisions"], undefined);
  assert.equal(planningRevisions(state).used, 1);
  // Set back in the draft and in the answer the next revision edits.
  const a = state.done.plan.items.find((item) => item.id === "a");
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "a"),
    a,
  );
  assert.deepEqual(
    round.answer.items.find((item) => item.id === "a"),
    work("a"),
  );
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "b").dependencies,
    ["a"],
  );
  assert.deepEqual(
    logged.filter((event) => event.event === "amendment-restored"),
    [
      {
        event: "amendment-restored",
        amendment: "op-1",
        round: 1,
        restored,
      },
    ],
  );

  // The review is told the rule and what was set back, and it is accepted.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.equal(asked[1].phase, "graph-review");
  assert.ok(asked[1].prompt.includes(RULE));
  assert.ok(asked[1].prompt.includes("FACTORY_AMENDMENT's startedItemRule"));
  assert.ok(asked[1].prompt.includes("FACTORY_AMENDMENT's restoredFields"));
  assert.ok(
    asked[1].prompt.includes(
      `${SELECTED_MEDIA_ABSENT} Report a change made only for one as a defect.`,
    ),
  );
  assert.ok(toldRestored(asked[1].prompt, restored));
  assert.deepEqual(review.outcome, { kind: "done", result: { round: 1 } });
  const accept = await step(state, deps);
  assert.equal(accept.key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined);
  assert.deepEqual(result.plan.items.map((item) => item.id).sort(), [
    "a",
    "b",
    "qa",
  ]);
  assert.deepEqual(
    result.plan.items.find((item) => item.id === "a"),
    a,
  );
  assert.equal(posted.length, 1);
  assert.equal(asked.length, 2);
});

// The run's rounds 2 and 3 (#2088): a's worker found that b's existing
// test needs src/b.js. The planner grew a's owned paths to take it, as the
// rule allows, restated a's acceptance and brief to match, and reworded
// a's goal, which the rule keeps; b owns src/b.js too, after a.
const growsA = revision([
  work("a", {
    goal: "Add a, which returns 1 once b's test is active.",
    ownedPaths: ["src/a.js", "src/b.js"],
    acceptance: ["a() returns 1.", "npm test passes with b's test active."],
    brief: "Export a from src/a.js; npm test must pass with b's test active.",
  }),
  work("b", {
    dependencies: ["a"],
    ownedPaths: ["src/b.js", "test/b.test.js"],
  }),
  qa(["a", "b"]),
]);

test("an amendment that grows a started item's owned paths and rewords its goal keeps the growth and the restatement, has the goal set back, and is reviewed and accepted (#2088)", async () => {
  const { checkout, state } = await discovered();
  const { planner, asked } = scripted(growsA, { findings: [] });
  const posted = [];
  const deps = depsOf(checkout, planner, posted);

  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.rejected, undefined);
  const restored = [{ itemId: "a", fields: ["goal"] }];
  assert.deepEqual(round.restored, restored);
  assert.equal(state.kept["amend:op-1:revisions"], undefined);
  const a = round.draft.items.find((item) => item.id === "a");
  assert.equal(a.goal, "Add a.");
  assert.deepEqual(a.ownedPaths, ["src/a.js", "src/b.js"]);
  assert.deepEqual(a.acceptance, [
    "a() returns 1.",
    "npm test passes with b's test active.",
  ]);
  assert.equal(
    a.brief,
    "Export a from src/a.js; npm test must pass with b's test active.",
  );
  assert.deepEqual(
    round.answer.items.find((item) => item.id === "a"),
    work("a", {
      ownedPaths: ["src/a.js", "src/b.js"],
      acceptance: a.acceptance,
      brief: a.brief,
    }),
  );

  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.ok(toldRestored(asked[1].prompt, restored));
  assert.deepEqual(review.outcome, { kind: "done", result: { round: 1 } });
  assert.equal((await step(state, deps)).key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined);
  assert.deepEqual(
    result.plan.items.find((item) => item.id === "a"),
    a,
  );
  assert.deepEqual(result.answer, round.answer);
  assert.equal(posted.length, 1);
  assert.equal(asked.length, 2);
});

test("a reattempt item that grows still keeps its validation, kind and title; only its acceptance, brief and non-goals are restated", async () => {
  const { checkout, state } = await discovered();
  const [grown, ...rest] = growsA.items;
  const relaxes = revision([
    {
      ...grown,
      title: "Add a and b",
      nonGoals: ["Changing b's test."],
      validation: ["node --test test/a.test.js"],
      oneOutcomeReason: null,
    },
    ...rest,
  ]);
  const { planner } = scripted(relaxes);
  assert.equal(
    (await step(state, depsOf(checkout, planner))).outcome.kind,
    "done",
  );
  const round = state.done["amend:op-1:plan"];
  assert.deepEqual(round.restored, [
    { itemId: "a", fields: ["goal", "title", "validation"] },
  ]);
  const a = round.draft.items.find((item) => item.id === "a");
  const old = state.done.plan.items.find((item) => item.id === "a");
  assert.deepEqual(a.validation, old.validation);
  assert.equal(a.title, old.title);
  assert.equal(a.kind, old.kind);
  assert.deepEqual(a.nonGoals, ["Changing b's test."]);
  assert.deepEqual(a.acceptance, grown.acceptance);
});

// #2107 (Codex, media.select-repair): the plan fixed `git lfs ls-files --
// <paths>` as a media item's validation. git-lfs reads those paths as
// revisions, so the command failed whatever the result held, and the
// started item's own worker's amendment could not change it: the Work Item
// could only end at an operator hold. The planner and the review are now
// told validation runs on the uncommitted result, and a command the
// validate step failed the item on may be replaced through the amendment's
// review.
const MALFORMED = "git lfs ls-files -- src/a.js";
// check-attr exits zero for an unrouted path too: its output is the proof.
const CHECK_ATTR =
  "git check-attr filter -- src/a.js | grep -qx 'src/a.js: filter: lfs'";
const withMalformed = {
  ...accepted,
  items: [work("a", { validation: ["npm test", MALFORMED] }), qa(["a"])],
};
/** The validate step failed a's results on `commands` under the plan accepted at `plan`. */
const failedOn = (commands, plan = ACCEPTED_AT) => ({
  "item:a:validationFailed": { plan, commands },
});
const replacesMalformed = revision([
  work("a", {
    validation: ["npm test", CHECK_ATTR],
    brief:
      "Export a from src/a.js; check src/a.js's Git LFS routing with git check-attr.",
  }),
]);
const UNCOMMITTED = "Validation runs on the uncommitted result.";
const LFS_ARGUMENTS =
  "`git lfs ls-files` reads its arguments as revisions, not paths.";
const ENVIRONMENT =
  '"commit":"the uncommitted result: commands check working-tree files, never HEAD, the index or a commit of the result; a base-relative check compares the working tree with $FACTORY_BASE_SHA"';
const ROUTING =
  "which must name `lfs` (the command exits zero for an unrouted path too, so it proves nothing alone)";

test("a reattempt item's validation command the validate step failed it on is replaced through the amendment's review, and both are told validation runs on the uncommitted result (#2107)", async () => {
  const { checkout, state } = await discovered({
    answer: withMalformed,
    kept: failedOn([MALFORMED]),
  });
  const { planner, asked } = scripted(replacesMalformed, { findings: [] });
  const posted = [];
  const deps = depsOf(checkout, planner, posted);

  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.rejected, undefined);
  // Nothing set back: the replacement and the restated brief stay.
  assert.equal(round.restored, undefined);
  const a = round.draft.items.find((item) => item.id === "a");
  assert.deepEqual(a.validation, [
    { command: "npm test" },
    { command: CHECK_ATTR },
  ]);
  assert.equal(a.brief, replacesMalformed.items[0].brief);
  assert.deepEqual(
    round.answer.items.find((item) => item.id === "a").validation,
    ["npm test", CHECK_ATTR],
  );

  // The planner is told which commands it may replace, and why a command
  // can't pass.
  const rule = inJson(
    startedItemRule({
      started: new Set(["a"]),
      reattempt: new Set(["a"]),
      replaceable: new Map([["a", [MALFORMED]]]),
    }),
  );
  assert.ok(
    rule.includes(inJson(`by item: ${JSON.stringify({ a: [MALFORMED] })}`)),
  );
  const replaceable = `"replaceableValidation":${JSON.stringify({ a: [MALFORMED] })}`;
  const [planning] = asked;
  assert.ok(planning.prompt.includes(rule));
  assert.ok(planning.prompt.includes(replaceable));
  assert.ok(planning.prompt.includes(UNCOMMITTED));
  assert.ok(planning.prompt.includes(LFS_ARGUMENTS));
  assert.ok(planning.prompt.includes(ROUTING));
  assert.ok(planning.prompt.includes(inJson(ENVIRONMENT)));

  // So is the review, which accepts it.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  const reviewing = asked[1];
  assert.equal(reviewing.phase, "graph-review");
  assert.ok(reviewing.prompt.includes(rule));
  assert.ok(reviewing.prompt.includes(replaceable));
  assert.ok(
    reviewing.prompt.includes(
      "A reattempt item may lose only the validation commands FACTORY_AMENDMENT's replaceableValidation lists for it",
    ),
  );
  assert.ok(reviewing.prompt.includes(UNCOMMITTED));
  assert.ok(reviewing.prompt.includes(LFS_ARGUMENTS));
  assert.ok(reviewing.prompt.includes(ENVIRONMENT));
  assert.deepEqual(review.outcome, { kind: "done", result: { round: 1 } });
  assert.equal((await step(state, deps)).key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined);
  assert.deepEqual(
    result.plan.items.find((item) => item.id === "a").validation,
    a.validation,
  );
  assert.equal(posted.length, 1);
});

test("a reattempt item keeps every validation command the validate step didn't fail it on under the plan accepted now (#2107)", async () => {
  const cases = [
    // It failed on another command: the replaced one stays.
    [failedOn(["npm test"]), ["npm test"]],
    // It failed on this one under an earlier plan.
    [failedOn([MALFORMED], "2025-12-31T00:00:00.000Z"), []],
    // It never failed.
    [{}, []],
  ];
  for (const [kept, listed] of cases) {
    const { checkout, state } = await discovered({
      answer: withMalformed,
      kept,
    });
    const { planner, asked } = scripted(replacesMalformed);
    const first = await step(state, depsOf(checkout, planner));
    assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
    const round = state.done["amend:op-1:plan"];
    assert.deepEqual(round.restored, [
      { itemId: "a", fields: ["brief", "validation"] },
    ]);
    const a = round.draft.items.find((item) => item.id === "a");
    assert.deepEqual(a.validation, [
      { command: "npm test" },
      { command: MALFORMED },
    ]);
    assert.equal(a.brief, "Export a from src/a.js.");
    assert.equal(
      asked[0].prompt.includes('"replaceableValidation"'),
      listed.length > 0,
    );
  }
  // A replacement that also drops a command it didn't fail on is set back
  // whole; so is a list that only adds a command, keeping the failed one,
  // or one that reorders the commands it keeps.
  const withThree = {
    ...accepted,
    items: [
      work("a", { validation: ["npm test", "node --test", MALFORMED] }),
      qa(["a"]),
    ],
  };
  const setBack = [
    [withMalformed, [CHECK_ATTR]],
    [withMalformed, ["npm test", MALFORMED, CHECK_ATTR]],
    [withThree, ["node --test", "npm test", CHECK_ATTR]],
  ];
  for (const [answer, validation] of setBack) {
    const { checkout, state } = await discovered({
      answer,
      kept: failedOn([MALFORMED]),
    });
    const { planner } = scripted(revision([work("a", { validation })]));
    assert.equal(
      (await step(state, depsOf(checkout, planner))).outcome.kind,
      "done",
    );
    const round = state.done["amend:op-1:plan"];
    assert.deepEqual(round.restored, [{ itemId: "a", fields: ["validation"] }]);
    assert.deepEqual(
      round.draft.items.find((item) => item.id === "a").validation,
      answer.items[0].validation.map((command) => ({ command })),
    );
  }
  // Keeping the other commands in their order, it may drop the failed one.
  const { checkout, state } = await discovered({
    answer: withThree,
    kept: failedOn([MALFORMED]),
  });
  const { planner } = scripted(
    revision([work("a", { validation: ["npm test", "node --test"] })]),
  );
  assert.equal(
    (await step(state, depsOf(checkout, planner))).outcome.kind,
    "done",
  );
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.restored, undefined);
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "a").validation,
    [{ command: "npm test" }, { command: "node --test" }],
  );
});

test("the validate step keeps every command it failed an item's results on, under the plan accepted then (#2107)", () => {
  const state = { kept: { "plan:acceptedAt": ACCEPTED_AT } };
  assert.deepEqual(failedCommandKept(state, "a", undefined), {});
  const first = failedCommandKept(state, "a", MALFORMED);
  assert.deepEqual(first, {
    "item:a:validationFailed": { plan: ACCEPTED_AT, commands: [MALFORMED] },
  });
  Object.assign(state.kept, first);
  // The same command again keeps nothing new.
  assert.deepEqual(failedCommandKept(state, "a", MALFORMED), {});
  assert.deepEqual(failedCommandKept(state, "a", "npm test"), {
    "item:a:validationFailed": {
      plan: ACCEPTED_AT,
      commands: [MALFORMED, "npm test"],
    },
  });
  // A replan accepts a new plan: what failed under the old one no longer counts.
  state.kept["plan:acceptedAt"] = "2026-02-01T00:00:00.000Z";
  assert.deepEqual(failedCommandKept(state, "a", "npm test"), {
    "item:a:validationFailed": {
      plan: "2026-02-01T00:00:00.000Z",
      commands: ["npm test"],
    },
  });
});

test("an ownership overlap a started item's growth makes still goes back to the planner, which is told what was set back", async () => {
  const { checkout, state } = await discovered();
  // As growsA, but b owns src/b.js without waiting for a.
  const overlaps = revision([growsA.items[0], work("b"), qa(["a", "b"])]);
  const afterA = revision([work("b", { dependencies: ["a"] })]);
  const { planner, asked } = scripted(overlaps, afterA, { findings: [] });
  const deps = depsOf(checkout, planner);

  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.equal(kept.findings.length, 1, JSON.stringify(kept.findings));
  assert.match(
    kept.findings[0].message,
    /^Work Items a and b own overlapping paths \(src\/b\.js\) and neither depends on the other/,
  );
  const restored = [{ itemId: "a", fields: ["goal"] }];
  assert.deepEqual(kept.restored, restored);
  // The answer kept for the next round is the one set back.
  assert.equal(
    kept.answer.items.find((item) => item.id === "a").goal,
    "Add a.",
  );
  assert.equal(planningRevisions(state).used, 2);

  // Round 2 is told the finding and what was set back, and passes.
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(
    asked[1].prompt.includes(
      "Factory set these fields of started Work Items back to the plan being amended, as the started-item rule keeps them: a (goal). Keep them as that plan has them.",
    ),
  );
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.restored, undefined);
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "a").ownedPaths,
    ["src/a.js", "src/b.js"],
  );
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.equal((await step(state, deps)).key, "amend:op-1");
  assert.equal(state.done["amend:op-1"].rejected, undefined);
});

test("a started item that isn't a reattempt item and grows goes back to the planner, with the rest set back", async () => {
  // An operator's proposal: a started, but hasn't failed.
  const { checkout, state } = await building({
    kept: { "item:a:base": "0".repeat(40) },
  });
  const { planner } = scripted(growsA);
  const deps = depsOf(checkout, planner);
  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(kept.findings, [
    {
      source: "check",
      message:
        "Work Item a has started, so it keeps its spec; this answer changes its ownedPaths. Leave it as it is, and put further work in a new item",
      itemId: "a",
    },
  ]);
  assert.deepEqual(kept.restored, [
    { itemId: "a", fields: ["acceptance", "brief", "goal"] },
  ]);
});

test("a plan with no planner answer to revise has its started items set back in the draft, and keeps no answer that would show them changed", async () => {
  const { checkout, state } = await discovered();
  // As `factory reset` leaves it: no planning round to revise.
  state.done["plan:1:1"] = {};
  const whole = (a, qaDependencies) => ({
    ...accepted,
    items: [a, work("b", { dependencies: ["a"] }), qa(qaDependencies)],
  });
  // Round 1 changes a and leaves b out of qa's reach; round 2 fixes qa.
  const changesA = whole(
    work("a", { acceptance: ["a() returns 1 when its own test runs."] }),
    ["a"],
  );
  const reaches = whole(work("a"), ["a", "b"]);
  const { planner, asked } = scripted(changesA, reaches, { findings: [] });
  const deps = depsOf(checkout, planner);
  const a = state.done.plan.items.find((item) => item.id === "a");

  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(
    kept.findings.map((f) => f.message),
    [REACH],
  );
  const restored = [{ itemId: "a", fields: ["acceptance"] }];
  assert.deepEqual(kept.restored, restored);
  // The answer still holds a as the planner changed it, so it isn't kept:
  // round 2 answers in full again, with the plan as it stands.
  assert.equal(kept.answer, undefined);
  assert.ok(asked[0].prompt.includes('"planInForce"'));

  // Round 2 leaves a as it is: its answer decodes to its draft and is kept.
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(asked[1].prompt.includes('"planInForce"'));
  assert.ok(!asked[1].prompt.includes('"currentPlan"'));
  assert.ok(
    asked[1].prompt.includes(
      "Factory set these fields of started Work Items back to the plan being amended, as the started-item rule keeps them: a (acceptance).",
    ),
  );
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.restored, undefined);
  assert.deepEqual(round.answer, reaches);
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "a"),
    a,
  );
  assert.equal((await step(state, deps)).key, "amend:op-1:review");
  assert.equal((await step(state, deps)).key, "amend:op-1");
  assert.deepEqual(state.done["amend:op-1"].answer, reaches);
});

test("a whole plan whose accepted round had a started item set back keeps no answer, so the next amendment answers in full", async () => {
  const { checkout, state } = await discovered();
  state.done["plan:1:1"] = {};
  const changesA = {
    ...accepted,
    items: [
      work("a", { goal: "Add a, as its own test checks." }),
      work("b", { dependencies: ["a"] }),
      qa(["a", "b"]),
    ],
  };
  const { planner } = scripted(changesA, { findings: [] });
  const deps = depsOf(checkout, planner);
  assert.equal((await step(state, deps)).outcome.kind, "done");
  const round = state.done["amend:op-1:plan"];
  assert.deepEqual(round.restored, [{ itemId: "a", fields: ["goal"] }]);
  assert.equal(round.answer, undefined);
  assert.equal(
    round.draft.items.find((item) => item.id === "a").goal,
    "Add a.",
  );
  assert.equal((await step(state, deps)).key, "amend:op-1:review");
  assert.equal((await step(state, deps)).key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined);
  assert.equal(result.answer, undefined);
  assert.equal(
    result.plan.items.find((item) => item.id === "a").goal,
    "Add a.",
  );

  // The next amendment's planner gets the plan as it stands, not a's change.
  state.kept["amend:op-2:proposal"] = {
    ...state.kept["amend:op-1:proposal"],
    id: "op-2",
    at: "2026-01-01T02:00:00.000Z",
  };
  const next = scripted(revision());
  const asked = await step(state, depsOf(checkout, next.planner));
  assert.equal(asked.key, "amend:op-2:plan");
  assert.ok(next.asked[0].prompt.includes('"planInForce"'));
  assert.ok(!next.asked[0].prompt.includes("as its own test checks"));
});

// A round that removes a, which Factory can't set back: b takes its coverage.
const dropsA = {
  ...revision([work("b"), qa(["b"])]),
  removedItemIds: ["a"],
  coverage: [
    {
      obligationIndex: 0,
      itemId: "b",
      proof: { kind: "result-semantic" },
      environment: null,
    },
  ],
};
// Round 2 puts a back, with its coverage.
const keepsA = {
  ...revision([work("a"), qa(["a", "b"])]),
  coverage: [
    {
      obligationIndex: 0,
      itemId: "a",
      proof: { kind: "result-semantic" },
      environment: null,
    },
  ],
};
const DROPS_A =
  "The amendment removes Work Item a; keep every item (an unneeded pending item can change, not disappear)";

test("an amendment that removes a started item goes back to its planner, asks past the allowance before its planner runs, and the same removal twice rejects it", async () => {
  {
    const { checkout, state } = await discovered({
      frozen: {
        config: { autonomy: { allowances: { planningRevisions: 1 } } },
      },
    });
    const { planner, asked } = scripted(dropsA, keepsA);
    const deps = depsOf(checkout, planner);
    const first = (await step(state, deps)).outcome;
    assert.equal(first.kind, "retry", JSON.stringify(first));
    assert.deepEqual(state.kept["amend:op-1:revisions"][0].findings, [
      { source: "check", message: DROPS_A, itemId: "a" },
    ]);
    const held = (await step(state, deps)).outcome;
    assert.equal(held.kind, "hold", JSON.stringify(held));
    assert.match(
      held.question,
      /takes this Objective to 2 planning revisions .* past the 1 autonomy\.allowances\.planningRevisions allows/,
    );
    assert.deepEqual(
      held.options.map((option) => option.answer),
      ["more", "refuse", "cancel"],
    );
    assert.equal(asked.length, 1);
    // `more` grants, and the planner revises.
    const more = { answer: "more", holdId: "h1", by: "octo", at: ACCEPTED_AT };
    assert.equal((await step(state, deps, more)).outcome.kind, "retry");
    assert.equal((await step(state, deps)).outcome.kind, "done");
    assert.equal(state.done["amend:op-1:plan"].rejected, undefined);
    assert.equal(asked.length, 2);
  }
  {
    const { checkout, state } = await discovered();
    const { planner } = scripted(dropsA, revision());
    const deps = depsOf(checkout, planner);
    assert.equal((await step(state, deps)).outcome.kind, "retry");
    assert.equal((await step(state, deps)).outcome.kind, "done");
    assert.equal(
      state.done["amend:op-1:plan"].rejected,
      `Amendment plan round 2 came back with the same problems as round 1: ${DROPS_A}`,
    );
    await step(state, deps);
    assert.equal(
      state.done["amend:op-1"].rejected,
      state.done["amend:op-1:plan"].rejected,
    );
    const asks = await step(state, deps);
    assert.equal(asks.key, "amend:op-1:continue");
    assert.equal(asks.outcome.kind, "hold");
  }
});

test("an amendment whose item started while it was planned goes back to its planner at acceptance, and the revised round is reviewed again", async () => {
  const { checkout, state } = await building();
  const changesA = revision([
    work("a", { acceptance: ["a() returns 1, as its own test checks."] }),
    work("b"),
    qa(["a", "b"]),
  ]);
  const { planner, asked } = scripted(changesA, { findings: [] }, restoresA, {
    findings: [],
  });
  const posted = [];
  const deps = depsOf(checkout, planner, posted);
  // a hasn't started: the round may change it.
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.deepEqual((await step(state, deps)).outcome, {
    kind: "done",
    result: { round: 1 },
  });

  // a starts before acceptance: the round goes back, charged.
  state.kept["item:a:base"] = "0".repeat(40);
  const accept = await step(state, deps);
  assert.equal(accept.key, "amend:op-1");
  assert.equal(accept.outcome.kind, "retry", JSON.stringify(accept.outcome));
  assert.equal(state.done["amend:op-1"], undefined);
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.equal(kept.atAcceptance, true);
  assert.deepEqual(
    kept.findings.map((f) => f.message),
    [
      "Work Item a has started, so it keeps its spec; this answer changes its acceptance. Leave it as it is, and put further work in a new item",
    ],
  );
  assert.equal(planningRevisions(state).used, 2);

  // Round 2 is planned, then reviewed again rather than accepted on round 1's review.
  const second = await step(state, deps);
  assert.equal(second.key, "amend:op-1:plan");
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  const again = await step(state, deps);
  assert.equal(again.key, "amend:op-1:review");
  assert.deepEqual(again.outcome, { kind: "done", result: { round: 2 } });
  const accepted = await step(state, deps);
  assert.equal(accepted.key, "amend:op-1");
  assert.equal(state.done["amend:op-1"].rejected, undefined);
  assert.equal(posted.length, 1);
  assert.deepEqual(
    asked.map((call) => call.phase),
    ["plan", "graph-review", "plan", "graph-review"],
  );
});

test("a worker's discovery whose reviewed round acceptance sent back can be declined while it is planned again", async () => {
  const { state } = await building({
    kept: { "item:a:base": "0".repeat(40) },
  });
  const { "amend:op-1:proposal": proposal } = state.kept;
  delete state.kept["amend:op-1:proposal"];
  state.kept["amend:worker-a-1:proposal"] = {
    ...proposal,
    id: "worker-a-1",
    worker: { itemId: "a", attempt: 1 },
  };
  const { draft } = state.done["plan:1:1"];
  state.done["amend:worker-a-1:plan"] = { answer: accepted, draft, round: 1 };
  state.done["amend:worker-a-1:review"] = { round: 1 };
  const decline = () =>
    declineDiscovery(state, "a", "obsolete", "octo", ACCEPTED_AT);
  // Reviewed: acceptance may be posting it.
  assert.deepEqual(decline(), [
    "Amendment worker-a-1 has been reviewed and is being accepted; it can't be declined now",
  ]);
  // Acceptance sent the round back: its review no longer counts.
  state.kept["amend:worker-a-1:revisions"] = [
    {
      answer: accepted,
      findings: [{ source: "check", message: STARTED_A }],
      atAcceptance: true,
    },
  ];
  assert.deepEqual(decline(), []);
  assert.equal(
    state.done["amend:worker-a-1"].rejected,
    "Declined by octo: obsolete",
  );
});

/** A commit on the checkout's main after the plan's base, with `files`. */
function landed(checkout, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(checkout, path, ".."), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "landed");
  return git(checkout, "rev-parse", "HEAD");
}

const COMPANION =
  "const { b } = require('../src/b.js');\nif (b() !== 1) throw new Error('b');\n";

test("an amendment's planner and review get the files its discovery cites, read at the commit it was proposed from", async () => {
  const { checkout, state } = await building();
  // The test landed after the plan's base: only the proposal's commit has it.
  const commit = landed(checkout, { "test/b.test.js": COMPANION });
  const proposal = state.kept["amend:op-1:proposal"];
  proposal.commit = commit;
  proposal.discovery = {
    ...discovery,
    evidence: ["npm test fails: test/b.test.js cannot find module ../src/b.js"],
  };
  const { planner, asked } = scripted(withB, { findings: [] });
  const deps = depsOf(checkout, planner);
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.equal((await step(state, deps)).key, "amend:op-1:review");

  const named = { path: "test/b.test.js", content: COMPANION, complete: true };
  // The ownership path the commit lacks is listed with a note.
  const missing = {
    path: "src/b.js",
    content: `[missing: no regular file at ${commit.slice(0, 12)}]`,
    complete: false,
  };
  const [planning, review] = asked;
  assert.equal(planning.phase, "plan");
  // A supplied file is a literal block; a note stays inline.
  assert.ok(
    planning.prompt.includes(
      `"citedFiles":${JSON.stringify([{ ...named, content: { block: "cited file 0" } }, missing])}`,
    ),
  );
  assert.match(
    planning.prompt,
    /<<<BODY-[0-9a-f]{20} cited file 0>>>\nconst \{ b \} = require\('\.\.\/src\/b\.js'\);\nif \(b\(\) !== 1\) throw new Error\('b'\);\n\n<<<BODY-[0-9a-f]{20} end>>>/,
  );
  assert.ok(
    !planning.prompt.includes("export const a"),
    "src/a.js isn't cited",
  );
  assert.equal(review.phase, "graph-review");
  assert.ok(review.prompt.includes("if (b() !== 1) throw new Error('b');"));
  for (const row of [named, missing])
    assert.match(
      review.prompt,
      new RegExp(
        `"origin":"repository","path":"${row.path}","complete":${row.complete}`,
      ),
    );
  assert.ok(review.prompt.includes(missing.content));
});

test("cited files share a diagnosis's bound on named files, and a binary file or a commit Git doesn't have gets a note", async () => {
  const { checkout, state } = await building();
  const base = state.done.check.base;
  const commit = landed(checkout, {
    "docs/big.txt": "a".repeat(200_000),
    "docs/more.txt": "b".repeat(100_000),
    "docs/small.txt": "small\n",
    "docs/image.bin": Buffer.from([0x89, 0x50, 0x00, 0x0a]),
  });
  const proposal = {
    ...state.kept["amend:op-1:proposal"],
    commit,
    discovery: {
      ...discovery,
      evidence: [
        "docs/big.txt, docs/more.txt, docs/small.txt and docs/image.bin say so",
      ],
    },
  };
  const signal = AbortSignal.timeout(60_000);
  const cited = await citedFiles(checkout, proposal, base, signal);
  assert.deepEqual(
    cited.map(({ path, complete }) => [path, complete]),
    [
      ["docs/big.txt", true],
      ["docs/image.bin", false],
      ["docs/more.txt", false],
      ["docs/small.txt", true],
      ["src/b.js", false],
    ],
  );
  assert.equal(cited[0].content.length, 200_000);
  assert.equal(cited[1].content, "[unavailable: binary, not UTF-8 text]");
  // Past what is left of the bound; a smaller file after it still fits.
  assert.equal(
    cited[2].content,
    "[unavailable: 100000 bytes exceed what is left of the 256000-byte bound on cited files]",
  );
  assert.equal(cited[3].content, "small\n");
  assert.equal(
    cited[4].content,
    `[missing: no regular file at ${commit.slice(0, 12)}]`,
  );
  // A commit Git doesn't have: read at the plan's base, which names none.
  assert.deepEqual(
    await citedFiles(
      checkout,
      { ...proposal, commit: "f".repeat(40) },
      base,
      signal,
    ),
    [
      {
        path: "src/b.js",
        content: `[missing: no regular file at ${base.slice(0, 12)}]`,
        complete: false,
      },
    ],
  );
  assert.ok(
    proposalProblems({ ...proposal, commit: "HEAD" }, state).includes(
      "An amendment's commit is a full commit id",
    ),
  );
});

// The run's refusal (#2105, Codex, plan.discovery): a's worker found that
// its test needs a file no item owns, and the amendment planner answered
// cannotPlan, saying no separate item could supply it before a's own
// validation runs. The started-item rule in the same prompt lets a, a
// reattempt item, grow its dependencies to wait for a new item that
// delivers it. The refusal rejected the amendment with no review.
const CANNOT = {
  reason:
    "A separate item cannot supply src/b.js before the started item's pre-delivery validation runs.",
  change: "Let item a own src/b.js.",
};
const refuses = { ...revision(), cannotPlan: CANNOT };
const REFUSED = `The planner says it can't be planned: ${CANNOT.reason} What would have to change: ${CANNOT.change}`;
const ALLOWED =
  "The started-item rule lets reattempt item a grow its dependencies to wait for a new item b that owns src/b.js";
const overturns = (kind = "fix") => ({
  findings: [
    {
      kind,
      itemIds: ["a"],
      evidenceIndices: [],
      detail: ALLOWED,
      question: "",
    },
  ],
});
// The plan the review names: b delivers src/b.js, and a waits for it.
const waitsForB = [
  work("a", { dependencies: ["b"] }),
  work("b"),
  qa(["a", "b"]),
];

test("an amendment planner's cannotPlan is reviewed, and a refusal its review confirms rejects the amendment and asks the operator (#2105)", async () => {
  const { checkout, state } = await discovered();
  const { planner, asked } = scripted(refuses, { findings: [] });
  const posted = [];
  const logged = [];
  const deps = depsOf(checkout, planner, posted);
  const first = await step(state, deps, undefined, logged);
  assert.equal(first.key, "amend:op-1:plan");
  assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
  assert.ok(
    asked[0].prompt.includes(
      "An independent review judges a cannotPlan answer before Factory asks the operator",
    ),
  );
  // The refusal is a round with no draft: the current plan with it.
  const round = state.done["amend:op-1:plan"];
  assert.deepEqual(round, {
    answer: { ...accepted, cannotPlan: CANNOT },
    cannot: CANNOT,
    round: 1,
  });
  assert.deepEqual(
    logged.filter((event) => event.event === "planner-cannot-plan"),
    [{ event: "planner-cannot-plan", amendment: "op-1", ...CANNOT }],
  );
  // A rerun from the saved round reviews it; the planner isn't asked again.
  assert.equal(amendmentSteps(state, deps)[0].key, "amend:op-1:review");

  // The review judges the refusal, told the rule and the plan it amends.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.equal(asked[1].phase, "graph-review");
  const prompt = asked[1].prompt;
  assert.ok(prompt.includes("Independently review a planner's refusal"));
  assert.ok(prompt.includes(`Refusal:\n${JSON.stringify(CANNOT)}`));
  assert.ok(prompt.includes("The planner's rule for cannotPlan: cannotPlan"));
  assert.ok(prompt.includes(RULE));
  assert.ok(prompt.includes('"previousPlan"'));
  assert.ok(!prompt.includes("Graph:\n"));
  // And, as the planner is, that a missing selected set is no gap.
  assert.ok(prompt.includes(NO_GAP_REFUSAL));
  assert.deepEqual(review.outcome, { kind: "done", result: { round: 1 } });

  // Confirmed: the amendment is rejected with the planner's reason.
  const accept = await step(state, deps);
  assert.equal(accept.key, "amend:op-1");
  assert.equal(
    state.done["amend:op-1"].rejected,
    `${REFUSED} The independent amendment review confirmed it.`,
  );
  assert.equal(posted.length, 0);
  assert.equal(asked.length, 2);
  assert.equal(planningRevisions(state).used, 1);
  const asks = await step(state, deps);
  assert.equal(asks.key, "amend:op-1:continue");
  const held = asks.outcome;
  assert.equal(held.kind, "hold");
  assert.ok(held.question.includes(REFUSED));
  assert.deepEqual(
    held.options.map((option) => option.answer),
    ["replace", "continue", "cancel"],
  );
});

test("a refusal saved before it was reviewed still rejects its amendment on a rerun, with no model call", async () => {
  const { checkout, state } = await discovered();
  // The round an earlier Factory saved for a cannotPlan.
  state.done["amend:op-1:plan"] = {
    answer: { ...accepted, cannotPlan: CANNOT },
    rejected: REFUSED,
  };
  const { planner, asked } = scripted();
  const accept = await step(state, depsOf(checkout, planner));
  assert.equal(accept.key, "amend:op-1");
  assert.equal(state.done["amend:op-1"].rejected, REFUSED);
  assert.equal(asked.length, 0);
});

test("a cannotPlan its review overturns goes back to the planner with the rule that allows a plan, and the plan is reviewed and accepted (#2105)", async () => {
  const { checkout, state } = await discovered();
  const { planner, asked } = scripted(
    refuses,
    overturns(),
    revision(waitsForB),
    { findings: [] },
  );
  const posted = [];
  const deps = depsOf(checkout, planner, posted);
  assert.equal((await step(state, deps)).outcome.kind, "done");

  // The review's fix finding sends the refusal back, charged.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.equal(review.outcome.kind, "retry", JSON.stringify(review.outcome));
  assert.equal(
    review.outcome.reason,
    "Amendment plan round 1 has 1 fix finding; revising",
  );
  assert.equal(state.done["amend:op-1:review"], undefined);
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(kept.refused, CANNOT);
  assert.deepEqual(kept.answer, state.done["amend:op-1:plan"].answer);
  assert.deepEqual(
    kept.findings.map((f) => [f.source, f.kind, f.itemIds]),
    [["review", "fix", ["a"]]],
  );
  assert.equal(planningRevisions(state).used, 2);

  // Round 2 is told the refusal was overturned, and why; it plans.
  const second = await step(state, deps);
  assert.equal(second.key, "amend:op-1:plan");
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(asked[2].prompt.includes(ALLOWED));
  assert.ok(
    asked[2].prompt.includes(
      "Your previous answer for it was cannotPlan, with the reason",
    ),
  );
  const round = state.done["amend:op-1:plan"];
  assert.equal(round.cannot, undefined);
  assert.equal(round.round, 2);
  assert.deepEqual(
    round.draft.items.find((item) => item.id === "a").dependencies,
    ["b"],
  );

  // The plan is reviewed as a plan, and accepted.
  const again = await step(state, deps);
  assert.equal(again.key, "amend:op-1:review");
  assert.ok(
    asked[3].prompt.includes(
      "Independently review this complete proposed Factory plan",
    ),
  );
  assert.deepEqual(again.outcome, { kind: "done", result: { round: 2 } });
  assert.equal((await step(state, deps)).key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined);
  assert.deepEqual(
    result.plan.items.find((item) => item.id === "a").dependencies,
    ["b"],
  );
  assert.equal(posted.length, 1);
  assert.equal(asked.length, 4);
  assert.equal(planningRevisions(state).used, 2);
});

// #2116 (Codex, media.select-repair, run 2026-10-27T062037PDT-66dd): a
// media item's worker took its own test's ENOENT on destinations Factory
// fills only after selection for a gap. The plan needed no change, but the
// planner could answer only with a change or cannotPlan, and a confirmed
// cannotPlan holds the Objective. Now the refusal's review is told the
// discovery shows no gap and sends the planner back to answer with no
// change; the unchanged round, once reviewed, settles the amendment as
// continued, with nothing posted and no "plan changed" reattempt.
const NO_GAP = {
  reason:
    "test/cube.test.js reads assets/cube.glb, which is absent until selection, so no plan can make npm test pass in the worker's checkout.",
  change: "Move the test into an item after materialization.",
};
test("a cannotPlan resting on a missing selected set is sent back to answer with no change, and an unchanged round settles the amendment as continued (#2116)", async () => {
  const { checkout, state } = await discovered();
  const { planner, asked } = scripted(
    { ...revision(), cannotPlan: NO_GAP },
    {
      findings: [
        {
          kind: "fix",
          itemIds: ["a"],
          evidenceIndices: [],
          detail:
            "The discovery shows no gap: the item's validation runs after selection. Answer with no change to the plan.",
          question: "",
        },
      ],
    },
    revision(),
    { findings: [] },
  );
  const posted = [];
  const logged = [];
  const deps = depsOf(checkout, planner, posted);
  // The planner is told what to answer for a discovery with no gap.
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.ok(asked[0].prompt.includes(inJson(SELECTED_MEDIA_ABSENT)));
  assert.ok(asked[0].prompt.includes(inJson(NO_GAP_ANSWER)));
  // The refusal's review is told the rule too, and sends it back.
  const review = await step(state, deps);
  assert.equal(review.key, "amend:op-1:review");
  assert.ok(
    asked[1].prompt.includes("Independently review a planner's refusal"),
  );
  assert.ok(asked[1].prompt.includes(NO_GAP_REFUSAL), asked[1].prompt);
  assert.equal(review.outcome.kind, "retry", JSON.stringify(review.outcome));
  // Round 2 answers with no change, and its review agrees.
  const second = await step(state, deps);
  assert.equal(second.key, "amend:op-1:plan");
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  const again = await step(state, deps);
  assert.deepEqual(again.outcome, { kind: "done", result: { round: 2 } });
  assert.ok(
    asked[3].prompt.includes(
      "A draft that leaves previousPlan unchanged is the planner's answer for a discovery that shows no gap",
    ),
  );
  // Settled as continued: no plan posted, the plan as it was, no rejection
  // to answer, and the proposing item carries on (work/amend.ts).
  const accept = await step(state, deps, undefined, logged);
  assert.equal(accept.key, "amend:op-1");
  assert.deepEqual(state.done["amend:op-1"], { unchanged: true });
  assert.deepEqual(
    logged.filter((event) => event.event === "amendment-unchanged"),
    [{ event: "amendment-unchanged", amendment: "op-1" }],
  );
  assert.equal(posted.length, 0);
  assert.equal(amendmentStatus(state, "op-1").status, "continued");
  assert.deepEqual(amendmentSteps(state, deps), []);
  assert.equal(asked.length, 4);
  // The integration suite's ledger reads it as continued too: case_amend
  // took a result with no plan and no `continue` for a rejection and
  // waited for a `continue` question that never comes.
  const root = tempDir("factory-amend-unchanged-");
  mkdirSync(join(root, "objectives"));
  writeFileSync(
    join(root, "objectives", `${state.issue}.json`),
    JSON.stringify(state),
  );
  const ledger = spawnSync(
    "python3",
    [
      join(import.meta.dirname, "..", "integration", "lib", "st.py"),
      root,
      "amendments",
      String(state.issue),
    ],
    { encoding: "utf8" },
  );
  assert.equal(ledger.status, 0, ledger.stderr);
  assert.equal(ledger.stdout, "op-1 continued\n");
});

test("a refusal's review that asks an operator decision rejects with both, and the same findings twice or an invalid review twice reject with the refusal too", async () => {
  {
    const { checkout, state } = await discovered();
    const { planner } = scripted(refuses, overturns("operator-decision"));
    const deps = depsOf(checkout, planner);
    await step(state, deps);
    const review = await step(state, deps);
    assert.equal(review.outcome.kind, "done");
    assert.ok(
      review.outcome.result.rejected.startsWith(
        `${REFUSED} Independent amendment review: ${ALLOWED}`,
      ),
    );
    assert.equal(state.kept["amend:op-1:revisions"], undefined);
    await step(state, deps);
    assert.equal(
      state.done["amend:op-1"].rejected,
      review.outcome.result.rejected,
    );
  }
  {
    // The planner refuses again, and the review says the same: rejected.
    const { checkout, state } = await discovered();
    const { planner, asked } = scripted(
      refuses,
      overturns(),
      refuses,
      overturns(),
    );
    const deps = depsOf(checkout, planner);
    await step(state, deps);
    assert.equal((await step(state, deps)).outcome.kind, "retry");
    assert.ok(!asked[1].prompt.includes("Earlier corrections"));
    await step(state, deps);
    assert.deepEqual(state.done["amend:op-1:plan"].cannot, CANNOT);
    const again = await step(state, deps);
    assert.equal(again.key, "amend:op-1:review");
    // The second refusal's review is given the first review's finding, so
    // it rules consistently with it (#2111).
    assert.ok(
      asked[3].prompt.includes(
        `Earlier corrections (round 1):\n${REFUSAL_REVIEW_LATER_ROUND}`,
      ),
    );
    assert.ok(
      asked[3].prompt.includes(
        JSON.stringify({
          earlierRefusal: CANNOT,
          previousFindings: [
            {
              round: 1,
              source: "review",
              kind: "fix",
              itemIds: ["a"],
              detail: `${ALLOWED}\nQuestion: How should the plan change to fix this: ${ALLOWED}?`,
            },
          ],
        }),
      ),
    );
    assert.ok(
      state.done["amend:op-1:review"].rejected.startsWith(
        `${REFUSED} Independent amendment review: Amendment plan round 2 came back with the same problems as round 1: ${ALLOWED}`,
      ),
    );
    assert.equal(state.kept["amend:op-1:revisions"].length, 1);
  }
});

test("a refusal after a review whose finding named a new item is shown it apart, its review may restate it, and its one retry is told why (#2111)", async () => {
  const { checkout, state } = await building();
  const restates = (itemIds) => ({
    findings: [
      {
        kind: "fix",
        itemIds,
        evidenceIndices: [],
        detail: `${VAGUE}: restated`,
        question: "",
      },
    ],
  });
  const { planner, asked } = scripted(
    withB,
    reviewed("fix"),
    refuses,
    restates(["b"]),
    { findings: [] },
  );
  const deps = depsOf(checkout, planner);
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.equal((await step(state, deps)).outcome.kind, "retry");
  await step(state, deps);
  assert.deepEqual(state.done["amend:op-1:plan"].cannot, CANNOT);

  // b was a new item of round 1's draft, not of previousPlan, which the
  // refusal review's answer names.
  const invalid = await step(state, deps);
  assert.equal(invalid.key, "amend:op-1:review");
  assert.ok(
    asked[3].prompt.includes(
      JSON.stringify({
        previousFindings: [
          {
            round: 1,
            source: "review",
            kind: "fix",
            itemIds: [],
            earlierItemIds: ["b"],
            detail: `${VAGUE}\nQuestion: How should the plan change to fix this: ${VAGUE}?`,
          },
        ],
      }),
    ),
    asked[3].prompt.slice(asked[3].prompt.indexOf("Earlier corrections")),
  );
  assert.equal(invalid.outcome.kind, "retry", JSON.stringify(invalid.outcome));
  const reason = state.kept["amend:op-1:review:invalid"];
  assert.ok(reason.startsWith("The amendment review answer was invalid: "));

  // Its one retry is told why, and confirms the refusal.
  const confirmed = await step(state, deps);
  assert.equal(confirmed.key, "amend:op-1:review");
  assert.ok(
    asked[4].prompt.includes(
      `Your previous answer to this review was refused, and nothing of it was kept: ${reason}\nAnswer again, correcting it.`,
    ),
  );
  assert.equal(confirmed.outcome.kind, "done");
  assert.equal(state.kept["amend:op-1:review:invalid"], undefined);
});

test("a whole plan's refusal keeps no answer, so the round its review sends back answers in full", async () => {
  const { checkout, state } = await discovered();
  // As `factory reset` leaves it: no planning round to revise.
  state.done["plan:1:1"] = {};
  const { planner, asked } = scripted(
    { ...accepted, cannotPlan: CANNOT },
    overturns(),
    { ...accepted, items: waitsForB },
  );
  const deps = depsOf(checkout, planner);
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.deepEqual(state.done["amend:op-1:plan"], { cannot: CANNOT, round: 1 });
  assert.equal((await step(state, deps)).outcome.kind, "retry");
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.equal(kept.answer, undefined);
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(asked[2].prompt.includes('"planInForce"'));
  assert.ok(!asked[2].prompt.includes('"currentPlan"'));
  assert.deepEqual(
    state.done["amend:op-1:plan"].draft.items.map((item) => item.id),
    ["a", "b", "qa"],
  );
});
