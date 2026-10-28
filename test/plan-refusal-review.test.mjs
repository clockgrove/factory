// First planning's cannotPlan is reviewed like a plan (#2111), as an
// amendment planner's has been since #2105. Live (Codex, `main`
// media.select-repair), after the plan reviewer's contradictory objections
// about a new test file's ownership (#2108), the planner answered cannotPlan
// at plan:1:7, and the refusal went to the operator as a decide-step hold
// with no review. The review now confirms the refusal, and only then is the
// operator asked, or names the rule or evidence that allows a plan and sends
// it back to the planner within planningRevisions. A second refusal's review
// is given the earlier review's findings, as a plan's revision round is.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import {
  GRAPH_REVIEW_AFTER_REFUSAL,
  GRAPH_REVIEW_FIRST_ROUND,
  GRAPH_REVIEW_REVISION_ROUND,
  PLAN_REFUSAL_REVIEW_INTRO,
  REFUSAL_REVIEW_INTRO,
  REFUSAL_REVIEW_LATER_ROUND,
} from "../dist/planning/rubric.js";
import { planningRevisions, planningStep } from "../dist/planning/steps.js";
import { readShown } from "../dist/shown.js";
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

const HTML =
  "<h2>Goal</h2>\n<p>Add <code>a</code>.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>a()</code> returns <code>1</code>.</li>\n<li><code>npm test</code> passes.</li>\n</ul>";
const shown = readShown(HTML, { sources: true });

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
  ownedPaths: [`src/${id}.js`, `test/${id}.test.js`],
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

/** The planner's plan: a, and integrated QA after it. */
const planned = {
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

// The run's refusal, in the shape that run's had: the reviewer's own
// objections to a new test file's ownership left no plan it would accept.
const CANNOT = {
  reason:
    "The review refuses test/a.test.js as an invented name and test/ as too broad, and a's acceptance needs a new test, so no ownership of it passes review.",
  change: "Name the test file in the Objective.",
};
const refuses = { ...planned, cannotPlan: CANNOT };
const ALLOWED =
  "An item owns each new file it creates, a new test file included, by the literal path the planner chooses: a may own test/a.test.js, so a plan is allowed";
// The finding as Factory keeps it: its detail, and the question it derives.
const FOUND = `${ALLOWED}\nQuestion: How should the plan change to fix this: ${ALLOWED}?`;
const overturns = (kind = "fix", question = "") => ({
  findings: [
    { kind, itemIds: [], evidenceIndices: [], detail: ALLOWED, question },
  ],
});

/** An Objective checked and ready to plan, with nothing planned yet. */
function checked() {
  const checkout = join(tempDir("factory-plan-refusal-"), "c");
  mkdirSync(join(checkout, "src"), { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: "node --test" } }),
  );
  writeFileSync(join(checkout, "src", "b.js"), "export const b = () => 2;\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  const base = git(checkout, "rev-parse", "HEAD");
  const state = {
    issue: 9,
    holds: [],
    answers: {},
    retries: {},
    attempts: {},
    repairs: {},
    done: {
      check: { shown, writer: true, base, title: "Add a", reviewArtifacts: [] },
    },
    kept: {},
  };
  return { checkout, state };
}

/** The planner's and reviewer's answers, in order; every call they got. */
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

function depsOf(checkout, planner, posted = []) {
  const dir = tempDir("factory-plan-refusal-work-");
  const config = loaded(checkout);
  return {
    config,
    provider: config.providers[config.defaultProvider],
    planner,
    github: {
      renderedIssue: async () => ({ body_html: HTML, state: "open" }),
      upsertComment: async (issue, marker, body) =>
        posted.push({ issue, marker, body }),
    },
    workDir: (issue) => join(dir, String(issue)),
    objectives: dir,
  };
}

/** Planning's next step, run once against `state` and applied as the engine applies it. */
async function step(state, deps, answer, logged = []) {
  const next = planningStep(state, deps);
  assert.ok(next, "a planning step");
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

const REFUSED = `The planner says this Objective can't be planned as written:\n\n${CANNOT.reason}\n\nWhat would have to change: ${CANNOT.change}`;

test("first planning's cannotPlan is reviewed, and a refusal its review confirms asks the operator (#2111)", async () => {
  const { checkout, state } = checked();
  const { planner, asked } = scripted(refuses, { findings: [] });
  const logged = [];
  const deps = depsOf(checkout, planner);
  const first = await step(state, deps, undefined, logged);
  assert.equal(first.key, "plan:1:1");
  assert.ok(
    asked[0].prompt.includes(
      "An independent review judges the refusal first: it sends the refusal back to you when a rule or the evidence allows a plan",
    ),
  );
  assert.deepEqual(state.done["plan:1:1"], {
    cannot: CANNOT,
    refusalReview: true,
  });
  assert.deepEqual(
    logged.filter((event) => event.event === "planner-cannot-plan"),
    [{ event: "planner-cannot-plan", ...CANNOT }],
  );

  // The review judges the refusal, not a plan, before anyone is asked.
  const review = await step(state, deps);
  assert.equal(review.key, "review:1:1");
  assert.equal(asked[1].role, "reviewer");
  assert.equal(asked[1].phase, "graph-review");
  const prompt = asked[1].prompt;
  assert.ok(prompt.startsWith(PLAN_REFUSAL_REVIEW_INTRO), prompt.slice(0, 200));
  assert.ok(!prompt.includes(REFUSAL_REVIEW_INTRO));
  assert.ok(prompt.includes(`Refusal:\n${JSON.stringify(CANNOT)}`));
  assert.ok(prompt.includes("The planner's rule for cannotPlan: cannotPlan"));
  assert.ok(prompt.includes("with itemIds [] (there is no plan yet)"));
  assert.ok(!prompt.includes("Graph:\n"));
  assert.ok(!prompt.includes("FACTORY_AMENDMENT"));
  assert.ok(!prompt.includes("Earlier corrections"));
  assert.deepEqual(review.outcome, { kind: "done", result: { findings: [] } });

  // Confirmed: the operator is asked with the planner's reason.
  const decide = await step(state, deps);
  assert.equal(decide.key, "decide:1:1");
  assert.equal(decide.outcome.kind, "hold");
  assert.ok(decide.outcome.question.startsWith(REFUSED));
  assert.ok(
    decide.outcome.question.includes(
      "Factory's independent plan review confirmed it.",
    ),
  );
  assert.deepEqual(
    decide.outcome.options.map((option) => option.answer),
    ["replan", "answer", "cancel"],
  );
  assert.equal(asked.length, 2);
  assert.equal(planningRevisions(state).used, 0);
});

test("a first-planning refusal its review overturns goes back to the planner, whose plan is reviewed in full and accepted (#2111)", async () => {
  const { checkout, state } = checked();
  const { planner, asked } = scripted(refuses, overturns(), planned, {
    findings: [],
  });
  const posted = [];
  const deps = depsOf(checkout, planner, posted);
  await step(state, deps);
  const review = await step(state, deps);
  assert.equal(review.key, "review:1:1");
  assert.equal(review.outcome.result.findings.length, 1);

  // The fix finding goes back to the planner as another round.
  const decide = await step(state, deps);
  assert.equal(decide.key, "decide:1:1");
  assert.equal(decide.outcome.kind, "done", JSON.stringify(decide.outcome));
  assert.deepEqual(
    decide.outcome.result.corrections.map((f) => [f.source, f.message]),
    [["review", FOUND]],
  );

  // Round 2 is told its refusal was overturned, and plans in full.
  const second = await step(state, deps);
  assert.equal(second.key, "plan:1:2");
  assert.equal(asked[2].phase, "plan");
  // The instructions reach the planner as JSON data.
  assert.ok(
    asked[2].prompt.includes(
      JSON.stringify(
        `Your previous answer was cannotPlan, with the reason ${JSON.stringify(CANNOT.reason)}, and Factory's independent review found that a plan is allowed: plan as the review's findings below say`,
      ).slice(1, -1),
    ),
  );
  assert.ok(asked[2].prompt.includes(ALLOWED));
  assert.ok(!asked[2].prompt.includes('"currentPlan"'));
  const round = state.done["plan:1:2"];
  assert.equal(round.cannot, undefined);
  assert.equal(round.findings, undefined, JSON.stringify(round.findings));
  assert.deepEqual(
    round.draft.items.map((item) => item.id),
    ["a", "qa"],
  );

  // The plan has no reviewed plan before it: it gets the full first review,
  // with the refusal and the findings that overturned it.
  const again = await step(state, deps);
  assert.equal(again.key, "review:1:2");
  assert.ok(asked[3].prompt.includes(GRAPH_REVIEW_FIRST_ROUND));
  assert.ok(asked[3].prompt.includes("Graph:\n"));
  assert.ok(!asked[3].prompt.includes("This is a revision round"));
  assert.ok(
    asked[3].prompt.includes(
      `Overturned refusal (round 1):\n${GRAPH_REVIEW_AFTER_REFUSAL}\n${JSON.stringify(
        {
          earlierRefusal: CANNOT,
          findings: [
            {
              round: 1,
              source: "review",
              kind: "fix",
              itemIds: [],
              detail: FOUND,
            },
          ],
        },
      )}`,
    ),
  );
  assert.equal((await step(state, deps)).key, "decide:1:2");
  assert.equal(state.done["decide:1:2"].accept, true);
  const accept = await step(state, deps);
  assert.equal(accept.key, "plan");
  assert.deepEqual(
    state.done.plan.items.map((item) => item.id),
    ["a", "qa"],
  );
  assert.equal(posted.length, 1);
  assert.equal(asked.length, 4);
  assert.equal(planningRevisions(state).used, 1);
});

test("a second refusal's review is given the earlier review's finding, and the same finding twice asks the operator with the refusal (#2111)", async () => {
  const { checkout, state } = checked();
  const { planner, asked } = scripted(
    refuses,
    overturns(),
    refuses,
    overturns(),
  );
  const deps = depsOf(checkout, planner);
  await step(state, deps);
  await step(state, deps);
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.equal((await step(state, deps)).key, "plan:1:2");
  assert.deepEqual(state.done["plan:1:2"].cannot, CANNOT);

  const review = await step(state, deps);
  assert.equal(review.key, "review:1:2");
  const prompt = asked[3].prompt;
  assert.ok(prompt.startsWith(PLAN_REFUSAL_REVIEW_INTRO));
  assert.ok(
    prompt.includes(
      `Earlier corrections (round 1):\n${REFUSAL_REVIEW_LATER_ROUND}`,
    ),
  );
  assert.ok(
    prompt.includes(
      JSON.stringify({
        earlierRefusal: CANNOT,
        previousFindings: [
          {
            round: 1,
            source: "review",
            kind: "fix",
            itemIds: [],
            detail: FOUND,
          },
        ],
      }),
    ),
  );
  // The earlier corrections follow the refusal, after the cached prefix.
  assert.ok(
    prompt.indexOf("Refusal:\n") < prompt.indexOf("Earlier corrections"),
  );

  const decide = await step(state, deps);
  assert.equal(decide.key, "decide:1:2");
  assert.equal(decide.outcome.kind, "hold", JSON.stringify(decide.outcome));
  assert.ok(decide.outcome.question.startsWith(REFUSED));
  assert.ok(
    decide.outcome.question.includes(
      "a plan is allowed, with the same findings as round 1",
    ),
  );
  assert.ok(decide.outcome.question.includes(ALLOWED));
  assert.deepEqual(
    decide.outcome.options.map((option) => option.answer),
    ["answer", "replan", "cancel"],
  );
});

test("a refusal's review that finds a question only the operator can decide asks it with the refusal (#2111)", async () => {
  const { checkout, state } = checked();
  const QUESTION =
    "May a's test live under test/, or must it sit beside src/a.js?";
  const { planner, asked } = scripted(
    refuses,
    overturns("operator-decision", QUESTION),
  );
  const deps = depsOf(checkout, planner);
  await step(state, deps);
  await step(state, deps);
  const decide = await step(state, deps);
  assert.equal(decide.key, "decide:1:1");
  assert.equal(decide.outcome.kind, "hold");
  assert.ok(decide.outcome.question.startsWith(REFUSED));
  assert.ok(decide.outcome.question.includes(QUESTION));
  assert.ok(
    decide.outcome.question.includes(
      "only you can decide, which may allow a plan",
    ),
  );
  assert.deepEqual(
    decide.outcome.options.map((option) => option.answer),
    ["answer", "replan", "cancel"],
  );
  assert.equal(asked.length, 2);
});

// A plan review's objection to a's ownership of its new test file.
const OBJECTION =
  "test/a.test.js is an invented name: a must not own a test file the Objective doesn't name";
const objects = {
  findings: [
    {
      kind: "fix",
      itemIds: ["a"],
      evidenceIndices: [],
      detail: OBJECTION,
      question: "",
    },
  ],
};
const OBJECTED = `${OBJECTION}\nQuestion: How should the plan change to fix this: ${OBJECTION}?`;
// A revision round's refusal: the rest of the answer is discarded.
const refusesRevision = { cannotPlan: CANNOT };

test("a refusal after a plan review whose findings named items is shown them apart, and its review may restate them; an invalid answer's retry is told why (#2111)", async () => {
  const { checkout, state } = checked();
  const restates = (itemIds) => ({
    findings: [
      {
        kind: "fix",
        itemIds,
        evidenceIndices: [],
        detail: `${OBJECTION}: restated`,
        question: "",
      },
    ],
  });
  const { planner, asked } = scripted(
    planned,
    objects,
    refusesRevision,
    restates(["a"]),
    restates([]),
  );
  const deps = depsOf(checkout, planner);
  assert.equal((await step(state, deps)).key, "plan:1:1");
  assert.equal((await step(state, deps)).key, "review:1:1");
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.equal((await step(state, deps)).key, "plan:1:2");
  assert.deepEqual(state.done["plan:1:2"].cannot, CANNOT);

  // The objection named a, an item of a plan the refusal review doesn't
  // see: it is shown apart, as its answer names no item.
  const invalid = await step(state, deps);
  assert.equal(invalid.key, "review:1:2");
  const prompt = asked[3].prompt;
  assert.ok(prompt.startsWith(PLAN_REFUSAL_REVIEW_INTRO));
  assert.ok(
    prompt.includes(
      JSON.stringify({
        previousFindings: [
          {
            round: 1,
            source: "review",
            kind: "fix",
            itemIds: [],
            earlierItemIds: ["a"],
            detail: OBJECTED,
          },
        ],
      }),
    ),
  );
  assert.ok(!prompt.includes('"earlierRefusal"'));
  assert.ok(
    !prompt.includes("Your previous answer to this review was refused"),
  );
  // An answer that still names a is refused, and the retry is told why.
  assert.equal(invalid.outcome.kind, "retry");
  const reason = `The plan review answer was invalid: Finding 0 itemIds must be a unique array of item ids in the reviewed graph (none); use [] for the plan as a whole.`;
  assert.equal(invalid.outcome.reason, reason);
  assert.equal(state.kept["review:1:2:invalid"], reason);
  assert.equal(state.done["review:1:2"], undefined);

  const retried = await step(state, deps);
  assert.equal(retried.key, "review:1:2");
  assert.ok(
    asked[4].prompt.includes(
      `\n\nYour previous answer to this review was refused, and nothing of it was kept: ${reason}\nAnswer again, correcting it.`,
    ),
  );
  assert.equal(retried.outcome.kind, "done", JSON.stringify(retried.outcome));
  assert.equal(state.kept["review:1:2:invalid"], undefined);
  assert.deepEqual(
    state.done["review:1:2"].findings.map((f) => [f.kind, f.itemIds]),
    [["fix", []]],
  );
  assert.equal(asked.length, 5);
});

// A revision whose b owns a's source too, and neither depends on the other:
// Factory's checks refuse it before review.
const overlaps = {
  items: [
    work("b", { ownedPaths: ["src/a.js", "test/b.test.js"] }),
    qa(["a", "b"]),
  ],
  itemEdits: [],
  removedItemIds: [],
  coverage: [],
  sourceObligations: null,
  requiredPreIntegrationChecks: null,
  cannotPlan: null,
  decisionRequired: null,
};

/** A finding the decide step sent, as a first-planning refusal's review is shown it. */
const view = (round, f) => {
  const ids = f.itemIds ?? (f.itemId ? [f.itemId] : []);
  return {
    round,
    source: f.source,
    kind: f.kind ?? "fix",
    itemIds: [],
    ...(ids.length ? { earlierItemIds: ids } : {}),
    detail: f.message,
  };
};

test("a refusal after a round that failed Factory's checks is judged with the check findings the planner got and the review before them (#2111)", async () => {
  const { checkout, state } = checked();
  const { planner, asked } = scripted(
    planned,
    objects,
    overlaps,
    refusesRevision,
    { findings: [] },
  );
  const deps = depsOf(checkout, planner);
  await step(state, deps);
  await step(state, deps);
  await step(state, deps);
  const second = await step(state, deps);
  assert.equal(second.key, "plan:1:2");
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  const checked2 = state.done["plan:1:2"];
  assert.ok(checked2.findings?.length, JSON.stringify(checked2));
  assert.ok(checked2.findings.every((f) => f.source === "check"));
  assert.equal(state.done["review:1:2"], undefined);
  // Round 2 was not reviewed: its check findings go to the planner.
  assert.equal((await step(state, deps)).key, "decide:1:2");
  const sent = state.done["decide:1:2"].corrections;
  assert.ok(sent.length);
  assert.equal((await step(state, deps)).key, "plan:1:3");
  assert.deepEqual(state.done["plan:1:3"].cannot, CANNOT);

  const review = await step(state, deps);
  assert.equal(review.key, "review:1:3");
  const prompt = asked[4].prompt;
  assert.ok(
    prompt.includes(
      `Earlier corrections (round 2):\n${REFUSAL_REVIEW_LATER_ROUND}`,
    ),
  );
  assert.ok(
    prompt.includes(
      JSON.stringify({
        previousFindings: [
          {
            round: 1,
            source: "review",
            kind: "fix",
            itemIds: [],
            earlierItemIds: ["a"],
            detail: OBJECTED,
          },
          ...sent.map((f) => view(2, f)),
        ],
      }),
    ),
    prompt.slice(prompt.indexOf("Earlier corrections")),
  );
});

test("a refusal after a round that failed Factory's checks is shown only the older review's findings the planner was given, not an operator question the decide step dropped (#2111)", async () => {
  const { checkout, state } = checked();
  const ASKED =
    "Whether a's test may live under test/ is a choice the Objective leaves open";
  // The review's objection and an operator question: the decide step sends
  // the planner the fix and drops the question, as it does for any plan.
  const objectsAndAsks = {
    findings: [
      ...objects.findings,
      {
        kind: "operator-decision",
        itemIds: [],
        evidenceIndices: [],
        detail: ASKED,
        question: "May a's test live under test/?",
      },
    ],
  };
  const { planner, asked } = scripted(
    planned,
    objectsAndAsks,
    overlaps,
    refusesRevision,
    { findings: [] },
  );
  const deps = depsOf(checkout, planner);
  for (const key of [
    "plan:1:1",
    "review:1:1",
    "decide:1:1",
    "plan:1:2",
    "decide:1:2",
    "plan:1:3",
    "review:1:3",
  ])
    assert.equal((await step(state, deps)).key, key);
  assert.equal(state.done["review:1:1"].findings.length, 2);
  assert.deepEqual(
    state.done["decide:1:1"].corrections.map((f) => f.message),
    [OBJECTED],
  );
  assert.equal(state.done["review:1:2"], undefined);
  const sent = state.done["decide:1:2"].corrections;
  assert.ok(sent.length);
  assert.deepEqual(state.done["plan:1:3"].cannot, CANNOT);

  const prompt = asked[4].prompt;
  assert.ok(!prompt.includes(ASKED), prompt.slice(prompt.indexOf("Earlier")));
  assert.ok(
    prompt.includes(
      JSON.stringify({
        previousFindings: [
          {
            round: 1,
            source: "review",
            kind: "fix",
            itemIds: [],
            earlierItemIds: ["a"],
            detail: OBJECTED,
          },
          ...sent.map((f) => view(2, f)),
        ],
      }),
    ),
    prompt.slice(prompt.indexOf("Earlier corrections")),
  );
});

test("a plan after a refusal whose review withdrew an earlier plan review's objection is reviewed with the withdrawal (#2111)", async () => {
  const { checkout, state } = checked();
  const WITHDRAWN =
    "The round 1 objection to test/a.test.js was wrong and is withdrawn: an item owns each new file it creates by the path the planner chooses";
  const { planner, asked } = scripted(
    planned,
    objects,
    refusesRevision,
    {
      findings: [
        {
          kind: "fix",
          itemIds: [],
          evidenceIndices: [],
          detail: WITHDRAWN,
          question: "",
        },
      ],
    },
    planned,
    { findings: [] },
  );
  const deps = depsOf(checkout, planner);
  for (const key of [
    "plan:1:1",
    "review:1:1",
    "decide:1:1",
    "plan:1:2",
    "review:1:2",
    "decide:1:2",
    "plan:1:3",
  ])
    assert.equal((await step(state, deps)).key, key);
  assert.ok(state.done["plan:1:3"].draft);
  const review = await step(state, deps);
  assert.equal(review.key, "review:1:3");
  const prompt = asked[5].prompt;
  // A full review: no reviewed plan was revised for it.
  assert.ok(prompt.includes(GRAPH_REVIEW_FIRST_ROUND));
  assert.ok(!prompt.includes(GRAPH_REVIEW_REVISION_ROUND));
  // With the refusal and the finding that withdrew the objection.
  assert.ok(
    prompt.includes(
      `Overturned refusal (round 2):\n${GRAPH_REVIEW_AFTER_REFUSAL}\n${JSON.stringify(
        {
          earlierRefusal: CANNOT,
          findings: [
            {
              round: 2,
              source: "review",
              kind: "fix",
              itemIds: [],
              detail: `${WITHDRAWN}\nQuestion: How should the plan change to fix this: ${WITHDRAWN}?`,
            },
          ],
        },
      )}`,
    ),
    prompt.slice(prompt.indexOf("Review scope")),
  );
  assert.equal((await step(state, deps)).key, "decide:1:3");
  assert.equal(state.done["decide:1:3"].accept, true);
});

test("a refusal an earlier Factory saved without its review mark asks at once, with no review", async () => {
  const { checkout, state } = checked();
  state.done["plan:1:1"] = { cannot: CANNOT };
  const { planner, asked } = scripted();
  const decide = await step(state, depsOf(checkout, planner));
  assert.equal(decide.key, "decide:1:1");
  assert.equal(decide.outcome.kind, "hold");
  assert.ok(decide.outcome.question.startsWith(REFUSED));
  assert.ok(!decide.outcome.question.includes("confirmed"));
  assert.equal(asked.length, 0);
});
