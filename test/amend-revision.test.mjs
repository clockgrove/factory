// An amendment's plan round that Factory's plan checks refuse goes back to
// its planner, as in first planning. Live (Codex, worker-discovery), the
// amendment planner added the item that owns the file the worker
// discovered but left it out of the integrated QA item's dependencies, and
// the graph check rejected the whole amendment and asked a person. The
// planner's answers are fixed here, in the shape that run's had. The
// independent review's fix findings go back to the planner the same way.
// Both get the files the discovery cites: live, without them, the planner
// asked the operator what a cited test imports.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import {
  amendmentSteps,
  citedFiles,
  proposalProblems,
} from "../dist/planning/amendments.js";
import { buildFacts } from "../dist/planning/facts.js";
import { planningRevisions } from "../dist/planning/steps.js";
import { decodePlan } from "../dist/planning/wire.js";
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
async function building({ kept = {}, frozen } = {}) {
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
  const decoded = decodePlan(accepted, built.facts);
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
      "plan:1:1": { answer: accepted, draft: decoded.plan },
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

/** The amendment's next step, run once against `state` and applied as the engine applies it. */
async function step(state, deps, answer) {
  const [next] = amendmentSteps(state, deps);
  const kept = {};
  const outcome = await next.run({
    state,
    ...(answer ? { answer } : {}),
    signal: AbortSignal.timeout(60_000),
    log: () => {},
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
  assert.deepEqual(review.outcome, { kind: "done", result: {} });
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

test("an amendment's check findings still reject when they repeat, or come with a fence finding; past the allowance its next round asks first", async () => {
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
  // a has started: changing it is a fence finding, which rejects at once.
  {
    const { checkout, state } = await building({
      kept: { "item:a:base": "0".repeat(40) },
    });
    const { planner } = scripted(
      revision([work("b"), work("a", { title: "Add a, again" })]),
    );
    const deps = depsOf(checkout, planner);
    const outcome = (await step(state, deps)).outcome;
    assert.equal(outcome.kind, "done");
    const { rejected } = state.done["amend:op-1:plan"];
    assert.ok(
      rejected.startsWith(`${REACH}; Work Item a has started`),
      rejected,
    );
    assert.equal(state.kept["amend:op-1:revisions"], undefined);
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
  assert.deepEqual(again.outcome, { kind: "done", result: {} });
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
  assert.ok(
    planning.prompt.includes(
      `"citedFiles":${JSON.stringify([named, missing])}`,
    ),
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
