// #2233: Work Item a's tests launch a headless browser. Its PR's CI job
// never provisions one, so CI failed the same way on every repair. An
// accepted amendment added the item that provisions the browser, but left
// a not depending on it, so a's CI kept running before the provisioning
// was on the default branch, until the operator said "make a depend on
// it". Now an item that provides a prerequisite names the current items
// that need it in the amendment answer's `enables`, and Factory makes each
// depend on it, a published one too; the planner and the review are told
// which items are failing CI or validation. A repair diagnosis that finds
// a missing prerequisite another item provides proposes an amendment at
// once (#2243; where it can't, its question offers `depend`), which the
// fence refuses until the item depends on the provider; the
// item then waits for the provider's merge and runs again on the default
// branch with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import {
  amendmentFindings,
  amendmentSteps,
  dependencyChangesStack,
  failingItems,
  startedStacks,
} from "../dist/planning/amendments.js";
import { buildFacts } from "../dist/planning/facts.js";
import { decodePlan } from "../dist/planning/wire.js";
import { correction } from "../dist/repair.js";
import { readShown } from "../dist/shown.js";
import {
  diagnosedPrerequisite,
  enabledAttempt,
  prerequisiteAmendment,
} from "../dist/work/amend.js";
import { missingPrerequisite } from "../dist/work/repair-context.js";
import { buildSteps } from "../dist/work/steps.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

/** A git repository at `dir`, initialized on main, with a commit of `files`. */
function repository(dir, files) {
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  mkdirSync(join(dir, "src"), { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(dir, path), content);
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return { git, base: git("rev-parse", "HEAD") };
}

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
  "<h2>Goal</h2>\n<p>Add <code>a</code>.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>a()</code> renders in a browser.</li>\n<li><code>npm test</code> passes.</li>\n</ul>",
  { sources: true },
);

/** A work item as the planner answers it. */
const work = (id, fields = {}) => ({
  kind: "work",
  id,
  title: `Add ${id}`,
  goal: `Add ${id}.`,
  acceptance: [`${id}() renders in a browser.`],
  nonGoals: ["No other change."],
  citations: [{ path: "OBJECTIVE", heading: "" }],
  children: [],
  dependencies: [],
  ownedPaths: [`src/${id}.js`],
  newPackages: [],
  priority: 1,
  resources: [],
  scheduling: null,
  validation: [{ command: "npm test", after: null }],
  brief: `Export ${id} from src/${id}.js.`,
  oneOutcomeReason: null,
  sourceAssets: [],
  media: null,
  ...fields,
});

/** The item that provisions the pinned headless browser in CI. */
const browser = work("browser", {
  title: "Provision the headless browser in CI",
  goal: "Provision the pinned headless browser in the CI database job, so tests that launch it run in CI.",
  acceptance: [
    "The CI database job installs the pinned headless browser before the tests run.",
  ],
  ownedPaths: ["ci/browser.sh"],
  brief: "Install the pinned headless browser in ci/browser.sh.",
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
  validation: [{ command: "npm test", after: null }],
  brief: "Run the Objective's command on the integrated result.",
  oneOutcomeReason: null,
});

/** The accepted plan's answer: `items`, a proving the first criterion and qa the second. */
const accepted = (items) => ({
  items,
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
});

/** A revision of the planner's current answer, with its `enables`. */
const revision = (items = [], enables = []) => ({
  items,
  itemEdits: [],
  removedItemIds: [],
  coverage: [],
  sourceObligations: null,
  requiredPreIntegrationChecks: null,
  cannotPlan: null,
  decisionRequired: null,
  enables,
});

const ACCEPTED_AT = "2026-01-01T00:00:00.000Z";
const LAUNCH =
  "browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell";
const CI_FAILED = {
  kind: "ci",
  checks: [{ name: "database", conclusion: "failure" }],
};

/**
 * An Objective building the plan `answer` decodes to, whose Work Item a is
 * published and being repaired a second time for its failed `database`
 * check, with `kept` beside it.
 */
async function building(answer, kept = {}) {
  const checkout = join(tempDir("factory-amend-prerequisite-"), "c");
  mkdirSync(checkout, { recursive: true });
  const { base } = repository(checkout, {
    "package.json": JSON.stringify({
      name: "target",
      scripts: { test: "node --test" },
    }),
    "src/a.js": "export const a = () => 1;\n",
  });
  const built = await buildFacts({ objective: 9, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const decoded = decodePlan(answer, built.facts);
  assert.deepEqual(decoded.findings, []);
  const state = {
    issue: 9,
    holds: [],
    answers: {},
    retries: {},
    attempts: {},
    repairs: { "item:a:work": { count: 2, findings: [LAUNCH, LAUNCH] } },
    done: {
      check: { shown, writer: true, base, title: "Add a", reviewArtifacts: [] },
      "plan:1:1": { answer, draft: decoded.plan },
      "decide:1:1": { accept: true },
      plan: { ...decoded.plan, finalCommands: [], decisions: [] },
    },
    kept: {
      "plan:acceptedAt": ACCEPTED_AT,
      "item:a:base": base,
      "item:a:pushed": ["1".repeat(40)],
      "item:a:finding": {
        kind: "failure",
        detail: `Required checks failed: database\n${LAUNCH}`,
        identity: CI_FAILED,
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
async function step(state, deps) {
  const [next] = amendmentSteps(state, deps);
  const kept = {};
  const outcome = await next.run({
    state,
    signal: AbortSignal.timeout(60_000),
    log: () => {},
    runFile: () => assert.fail("no run file"),
    keep: (facts) => Object.assign(kept, facts),
  });
  apply(state, { keep: { ...kept, ...outcome.keep } });
  if (outcome.kind === "done") state.done[next.key] = outcome.result;
  return { key: next.key, outcome };
}

/** Applies an outcome's keep as the engine does. */
function apply(state, outcome) {
  for (const [key, value] of Object.entries(outcome.keep ?? {}))
    if (value === null) delete state.kept[key];
    else state.kept[key] = value;
}

function depsOf(checkout, planner, posted = []) {
  const work = tempDir("factory-amend-prerequisite-work-");
  const config = loaded(checkout);
  return {
    config,
    provider: config.providers[config.defaultProvider],
    planner,
    github: {
      upsertComment: async (issue, marker, body) =>
        posted.push({ issue, marker, body }),
    },
    workDir: (issue) => join(work, String(issue)),
    objectives: work,
  };
}

/** The item steps that can run now. */
const runnable = (state, deps) => buildSteps(state, deps).map((s) => s.key);

/** A work step's context on `state`. */
const contextOf = (state, answer) => ({
  state,
  ...(answer ? { answer } : {}),
  signal: AbortSignal.timeout(60_000),
  log: () => {},
  keep: () => {},
});

/** Records Work Item `id`'s merge, as the merge step does. */
const merged = (state, id) => {
  state.done[`item:${id}:merge`] = {
    mergeSha: "5".repeat(40),
    integratedSha: "5".repeat(40),
    at: "2026-01-01T03:00:00.000Z",
  };
};

/**
 * Once its providers merged, Work Item `id` of `state`'s plan, which an
 * accepted amendment made wait for them, runs again: a free attempt on the
 * amended plan, moved onto the default branch with its change replayed.
 */
function assertBroughtUpToDate(state, id, amendment) {
  const target = state.done.plan.items.find((entry) => entry.id === id);
  const runs = enabledAttempt(target, contextOf(state), undefined, {});
  assert.equal(runs.kind, "repair", JSON.stringify(runs));
  const repair = state.repairs[`item:${id}:work`].count + 1;
  assert.deepEqual(runs.free, { target: `item:${id}:work`, repair });
  assert.equal(runs.keep[`item:${id}:rebase`], true);
  assert.equal(runs.keep[`item:${id}:enabled`], null);
  assert.match(
    runs.keep[`item:${id}:diagnosis`].context.finding,
    new RegExp(`Amendment ${amendment} was accepted`),
  );
  return runs;
}

const dependenciesOf = (plan, id) =>
  plan.items.find((entry) => entry.id === id).dependencies;

const FAILING = JSON.stringify([
  {
    itemId: "a",
    failed: CI_FAILED,
    failure: `Required checks failed: database\n${LAUNCH}`,
  },
]);
const ENABLES_A = [{ itemId: "browser", enables: ["a"] }];
const MISSING_ENABLES =
  "browser provisions the headless browser a's failing database check lacks, but enables doesn't name a: name a in browser's enables";

test("an amendment's item that provisions what a published, failing item lacks names it in enables: the review is told the failing items and refuses the round without it, Factory makes the item depend on it, and it waits for its merge (#2233)", async () => {
  const { checkout, state } = await building(accepted([work("a"), qa(["a"])]));
  state.kept["amend:op-1:proposal"] = {
    id: "op-1",
    actor: "Work Item a's worker",
    at: "2026-01-01T01:00:00.000Z",
    plan: ACCEPTED_AT,
    worker: { itemId: "a", attempt: 3 },
    discovery: {
      scope: "in-scope",
      reason:
        "The CI database job never provisions the headless browser a's tests launch",
      evidence: [LAUNCH],
      ownership: ["ci/browser.sh"],
      acceptance: [
        "The CI database job provisions the pinned headless browser",
      ],
      dependencies: [],
    },
  };
  const { planner, asked } = scripted(
    // Round 1: the provisioning item, which a doesn't depend on.
    revision([browser, qa(["a", "browser"])]),
    {
      findings: [
        {
          kind: "fix",
          itemIds: ["browser"],
          evidenceIndices: [],
          detail: MISSING_ENABLES,
          question: "",
        },
      ],
    },
    // Round 2: browser enables a.
    revision([], ENABLES_A),
    { findings: [] },
  );
  const posted = [];
  const deps = depsOf(checkout, planner, posted);

  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
  // The planner is told which items are failing, and what enables does.
  assert.ok(asked[0].prompt.includes(`"failingItems":${FAILING}`));
  assert.ok(asked[0].prompt.includes("name those items in its enables entry"));
  assert.ok(asked[0].schema.required.includes("enables"));
  assert.deepEqual(
    dependenciesOf(state.done["amend:op-1:plan"].draft, "a"),
    [],
  );

  // The review is told them too, and its finding sends the round back.
  const refused = await step(state, deps);
  assert.equal(refused.key, "amend:op-1:review");
  assert.equal(refused.outcome.kind, "retry", JSON.stringify(refused.outcome));
  assert.ok(asked[1].prompt.includes(`"failingItems":${FAILING}`));
  assert.ok(asked[1].prompt.includes("FACTORY_AMENDMENT's failingItems"));

  // Round 2: Factory makes a, published and no reattempt item, depend on
  // browser, in the answer the next revision edits and in the draft.
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(asked[2].prompt.includes(MISSING_ENABLES));
  const round = state.done["amend:op-1:plan"];
  assert.deepEqual(round.enables, ENABLES_A);
  assert.deepEqual(dependenciesOf(round.draft, "a"), ["browser"]);
  assert.deepEqual(dependenciesOf(round.answer, "a"), ["browser"]);
  assert.equal(round.restored, undefined);

  const review = await step(state, deps);
  assert.deepEqual(review.outcome, { kind: "done", result: { round: 2 } });
  assert.ok(asked[3].prompt.includes(`"enables":${JSON.stringify(ENABLES_A)}`));
  const accept = await step(state, deps);
  assert.equal(accept.key, "amend:op-1");
  const result = state.done["amend:op-1"];
  assert.equal(result.rejected, undefined, result.rejected);
  assert.deepEqual(dependenciesOf(result.plan, "a"), ["browser"]);
  assert.equal(posted.length, 1);
  // a didn't propose op-1 (its worker's own would be worker-a-3), so
  // acceptance records what it now waits for.
  assert.deepEqual(state.kept["item:a:enabled"], {
    amendment: "op-1",
    providers: ["browser"],
  });

  // a waits for browser; once browser merges, a runs again, brought up to
  // date with browser's result instead of diagnosing its stale failure.
  assert.deepEqual(runnable(state, deps), ["item:browser:work"]);
  merged(state, "browser");
  assert.deepEqual(runnable(state, deps), ["item:a:work"]);
  assertBroughtUpToDate(state, "a", "op-1");
});

test("an enables entry that names no current item yet to merge goes back to the planner with what passes (#2233)", async () => {
  const { checkout, state } = await building(accepted([work("a"), qa(["a"])]), {
    "amend:op-1:proposal": {
      id: "op-1",
      actor: "octo",
      at: "2026-01-01T01:00:00.000Z",
      plan: ACCEPTED_AT,
      discovery: {
        scope: "in-scope",
        reason: "CI lacks the headless browser",
        evidence: [LAUNCH],
        ownership: ["ci/browser.sh"],
        acceptance: ["CI provisions the headless browser"],
        dependencies: [],
      },
    },
  });
  const { planner, asked } = scripted(
    revision(
      [browser, qa(["a", "browser"])],
      [{ itemId: "browser", enables: ["a", "nowhere"] }],
    ),
    // Round 2 sees a's dependency on browser in currentPlan already, and
    // names no entry again.
    revision([], []),
  );
  const deps = depsOf(checkout, planner);
  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(
    kept.findings.map((finding) => finding.message),
    [
      `browser's enables names "nowhere", which is not another item of the plan being amended that has yet to merge; name only the current items that need what browser provides (a new item depends on it through its own dependencies)`,
    ],
  );
  // The valid entry still made its edge, which the round keeps.
  assert.deepEqual(dependenciesOf(kept.answer, "a"), ["browser"]);
  assert.deepEqual(kept.enables, ENABLES_A);

  // The edge stands in round 2, which is told the entry behind it.
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  assert.ok(
    asked[1].prompt.includes(`"earlierEnables":${JSON.stringify(ENABLES_A)}`),
  );
  const round = state.done["amend:op-1:plan"];
  assert.deepEqual(dependenciesOf(round.draft, "a"), ["browser"]);
  assert.deepEqual(round.enables, ENABLES_A);
});

test("a started item's dependency an earlier round's enables made stands when the review sends the round back and the next answer names no entry; the failing item, not the proposer, is brought up to date for its validation failure once the provider merges (#2233)", async () => {
  const FIXTURE =
    "Validation command failed (1): npm test: \nnot ok 1 - fixture db/seed.sql is missing";
  const { checkout, state } = await building(accepted([work("a"), qa(["a"])]), {
    "item:a:finding": {
      kind: "failure",
      detail: FIXTURE,
      identity: { kind: "validation", command: "npm test", exit: "1" },
    },
    "item:a:refused": {
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      notes: [],
    },
    "amend:op-1:proposal": {
      id: "op-1",
      actor: "octo",
      at: "2026-01-01T01:00:00.000Z",
      plan: ACCEPTED_AT,
      discovery: {
        scope: "in-scope",
        reason: "Tests need the shared seed fixture",
        evidence: [FIXTURE],
        ownership: ["db/seed.sql"],
        acceptance: ["The shared seed fixture exists"],
        dependencies: [],
      },
    },
  });
  const fixture = work("fixture", {
    title: "Add the shared seed fixture",
    goal: "Add the shared seed fixture the tests load.",
    acceptance: ["db/seed.sql holds the shared seed fixture."],
    ownedPaths: ["db/seed.sql"],
    brief: "Write db/seed.sql.",
  });
  const ENABLES_FIXTURE = [{ itemId: "fixture", enables: ["a"] }];
  const { planner, asked } = scripted(
    revision([fixture, qa(["a", "fixture"])], ENABLES_FIXTURE),
    {
      findings: [
        {
          kind: "fix",
          itemIds: ["fixture"],
          evidenceIndices: [],
          detail: "fixture's brief should name the seed's tables",
          question: "",
        },
      ],
    },
    // Round 2 changes only fixture's brief, and names no entry again.
    revision([{ ...fixture, brief: "Write db/seed.sql with every table." }]),
    { findings: [] },
  );
  const deps = depsOf(checkout, planner);
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.ok(asked[0].prompt.includes('"failed":{"kind":"validation"'));
  const sentBack = await step(state, deps);
  assert.equal(
    sentBack.outcome.kind,
    "retry",
    JSON.stringify(sentBack.outcome),
  );
  assert.deepEqual(
    state.kept["amend:op-1:revisions"][0].enables,
    ENABLES_FIXTURE,
  );

  // The fence still lets a, published and no reattempt item, take it.
  const second = await step(state, deps);
  assert.equal(second.outcome.kind, "done", JSON.stringify(second.outcome));
  const round = state.done["amend:op-1:plan"];
  assert.deepEqual(dependenciesOf(round.draft, "a"), ["fixture"]);
  assert.deepEqual(round.enables, ENABLES_FIXTURE);
  assert.deepEqual((await step(state, deps)).outcome, {
    kind: "done",
    result: { round: 2 },
  });
  assert.ok(
    asked[3].prompt.includes(`"enables":${JSON.stringify(ENABLES_FIXTURE)}`),
  );
  await step(state, deps);
  assert.equal(state.done["amend:op-1"].rejected, undefined);
  assert.deepEqual(state.kept["item:a:enabled"], {
    amendment: "op-1",
    providers: ["fixture"],
  });

  // Once fixture merged, a is checked again on the default branch with it,
  // its refused change replayed and free to end on the same tree.
  assert.deepEqual(runnable(state, deps), ["item:fixture:work"]);
  merged(state, "fixture");
  assert.deepEqual(runnable(state, deps), ["item:a:work"]);
  const runs = assertBroughtUpToDate(state, "a", "op-1");
  assert.equal(runs.keep["item:a:refused"].amended, "op-1");
  assert.equal(runs.keep["item:a:refused"].replayOnly, undefined);
});

test("a started item's grown dependency that no enables entry made goes back saying to name it in enables (#2233)", () => {
  const a = item("a", { ownedPaths: ["src/a.js"] });
  const current = plan([a, item("qa", { kind: "qa", dependencies: ["a"] })]);
  const provider = item("browser", { ownedPaths: ["ci/browser.sh"] });
  const draft = plan([
    { ...a, dependencies: ["browser"] },
    provider,
    item("qa", { kind: "qa", dependencies: ["a", "browser"] }),
  ]);
  const progress = { started: new Set(["a"]), reattempt: new Set() };
  assert.deepEqual(
    amendmentFindings(current, draft, progress, {
      answered: false,
      nativeStack: false,
    }).map((finding) => finding.message),
    [
      "Work Item a has started, so it keeps its spec; this answer adds browser to its dependencies, and a started item depends on another only through that item's enables entry. Name a in the enables entry of each of browser when a needs what it provides, else leave a's dependencies as they are",
    ],
  );
  assert.deepEqual(
    amendmentFindings(current, draft, progress, {
      answered: false,
      nativeStack: false,
      enables: [{ itemId: "browser", enables: ["a"] }],
    }),
    [],
  );
});

test("under native-stack delivery a layer of a started stack takes no enables edge and isn't offered depend, and a lone item's edge that would stack it says how to keep it apart (#2233)", async () => {
  const { checkout, state } = await building(
    accepted([
      work("x"),
      work("a", { dependencies: ["x"] }),
      browser,
      qa(["a", "browser"]),
    ]),
    {
      "item:x:base": "0".repeat(40),
      "amend:op-1:proposal": {
        id: "op-1",
        actor: "octo",
        at: "2026-01-01T01:00:00.000Z",
        plan: ACCEPTED_AT,
        discovery: {
          scope: "in-scope",
          reason: "a's CI lacks the headless browser",
          evidence: [LAUNCH],
          ownership: ["ci/browser.sh"],
          acceptance: ["a's CI has the headless browser"],
          dependencies: [],
        },
      },
    },
  );
  const current = state.done.plan;
  const started = new Set(["x", "a"]);
  const stacked = startedStacks(current, started, true);
  assert.deepEqual(Object.fromEntries(stacked), { x: "x > a", a: "x > a" });
  assert.deepEqual(startedStacks(current, started, false).size, 0);
  assert.equal(failingItems(state, current, stacked)[0].stack, "x > a");

  // depend: a depending on browser would take it out of the stack x > a.
  assert.equal(
    dependencyChangesStack(current, started, "a", "browser"),
    "x > a",
  );
  const a = current.items.find((entry) => entry.id === "a");
  const found = {
    repair: 2,
    provider: "browser",
    diagnosis: "The database job never installs the browser.",
    failure: LAUNCH,
    stack: "x > a",
  };
  // The diagnosis proposes nothing: it asks, its repair free.
  const asked = diagnosedPrerequisite(state, a, found);
  assert.equal(asked.kind, "hold", JSON.stringify(asked));
  assert.deepEqual(asked.free, { target: "item:a:work", repair: 2 });
  assert.ok(!asked.options.some((option) => option.answer === "depend"));
  assert.match(
    asked.question,
    /`depend` isn't offered: under native-stack delivery, a depending on browser would change the layers of the started native stack x > a/,
  );
  // Nor is an answer of depend taken.
  state.kept["item:a:prerequisite"] = found;
  assert.equal(
    prerequisiteAmendment(
      a,
      contextOf(state, { holdId: "h", answer: "depend", by: "octo" }),
      undefined,
      {},
    ),
    undefined,
  );
  delete state.kept["item:a:prerequisite"];

  // An enables entry naming a makes no edge and goes back.
  const { planner, asked: calls } = scripted(
    revision([], [{ itemId: "browser", enables: ["a"] }]),
  );
  const deps = depsOf(checkout, planner);
  deps.config.delivery = { kind: "native-stack" };
  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  assert.ok(calls[0].prompt.includes('"stack":"x > a"'));
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(
    kept.findings.map((finding) => finding.message),
    [
      "browser's enables names a, a layer of the started native stack x > a: a new dependency would take it out of that stack, whose layers an amendment keeps, so leave it out of enables",
    ],
  );
  assert.deepEqual(dependenciesOf(kept.answer, "a"), ["x"]);
  assert.equal(kept.enables, undefined);

  // A lone started item whose new provider nothing else depends on would
  // join that provider's stack: the fence says how to keep it apart.
  const lone = item("b", { ownedPaths: ["src/b.js"] });
  const provider = item("tool", { ownedPaths: ["ci/tool.sh"] });
  const findings = amendmentFindings(
    plan([lone]),
    plan([{ ...lone, dependencies: ["tool"] }, provider]),
    { started: new Set(["b"]), reattempt: new Set() },
    {
      answered: false,
      nativeStack: true,
      enables: [{ itemId: "tool", enables: ["b"] }],
    },
  ).map((finding) => finding.message);
  assert.deepEqual(findings, [
    "The amendment changes the started native stack b; keep its layers as they are. b took a new dependency (an enables entry, or the prerequisite), and an item whose only dependency is an item nothing else depends on joins that item's stack: make another item (such as the QA item) depend on the item that provides the prerequisite too",
  ]);
  // With another dependent, the provider starts no stack with it.
  assert.deepEqual(
    amendmentFindings(
      plan([lone, item("qa", { kind: "qa", dependencies: ["b"] })]),
      plan([
        { ...lone, dependencies: ["tool"] },
        provider,
        item("qa", { kind: "qa", dependencies: ["b", "tool"] }),
      ]),
      { started: new Set(["b"]), reattempt: new Set() },
      {
        answered: false,
        nativeStack: true,
        enables: [{ itemId: "tool", enables: ["b"] }],
      },
    ),
    [],
  );
});

/** A checkout whose result commit changes src/a.js, for a diagnosis. */
function failedResult() {
  const dir = tempDir("factory-prerequisite-diagnosis-");
  const { git, base } = repository(dir, {
    "src/a.js": "export const a = 1;\n",
  });
  writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
  git("commit", "--quiet", "-am", "result");
  return { dir, base, commit: git("rev-parse", "HEAD") };
}

const diagnosis = (fields) => ({
  decision: "prerequisite",
  diagnosis: `The database job fails with "${LAUNCH}": it never installs the browser, which browser provisions.`,
  predecessor: "browser",
  path: "",
  correction: "",
  question: "",
  requestedFiles: [],
  ownership: [],
  evidence: [],
  acceptance: [],
  ...fields,
});

test("a repair diagnosis that finds a missing prerequisite another item provides names it, never an item the failing one builds on (#2233)", async () => {
  const a = item("a", {
    ownedPaths: ["src/a.js"],
    validation: [{ command: "npm test" }],
  });
  const provider = item("browser", {
    title: "Provision the headless browser in CI",
    goal: "Provision the pinned headless browser in the CI database job.",
    ownedPaths: ["ci/browser.sh"],
  });
  const base = item("base", { ownedPaths: ["src/base.js"] });
  const after = { ...a, dependencies: ["base"] };
  const repo = failedResult();
  const asked = [];
  const result = await correction({
    planner: {
      answer: async (call) => {
        asked.push(call);
        // First a predecessor, whose result is in a's base already.
        return {
          value: diagnosis(asked.length === 1 ? { predecessor: "base" } : {}),
        };
      },
    },
    plan: plan([after, provider, base, item("qa", { kind: "qa" })]),
    item: after,
    finding: {
      kind: "failure",
      detail: `Required checks failed: database\n${LAUNCH}`,
      identity: CI_FAILED,
    },
    checkout: repo.dir,
    base: repo.base,
    commit: repo.commit,
    sources: [],
    prior: [],
    validate: false,
    signal: AbortSignal.timeout(60_000),
    log: () => {},
  });
  assert.deepEqual(result, {
    kind: "prerequisite",
    provider: "browser",
    diagnosis: diagnosis({}).diagnosis,
    failure: `Required checks failed: database\n${LAUNCH}`,
  });
  // Told the items that may provide one, and why the first answer failed.
  assert.ok(
    asked[0].prompt.includes(
      `"prerequisiteItems":[{"id":"browser","title":"Provision the headless browser in CI","goal":"Provision the pinned headless browser in the CI database job."}]`,
    ),
  );
  assert.ok(asked[0].prompt.includes("Return decision prerequisite"));
  assert.match(
    asked[1].prompt,
    /a prerequisite names one of prerequisiteItems \(browser\); base is not one/,
  );
});

test("a CI failure that repeated unchanged after the last correction may still be diagnosed a missing prerequisite: the diagnosis is told so, and a repeated repair is refused naming it (#2233)", async () => {
  const a = item("a", {
    ownedPaths: ["src/a.js"],
    validation: [{ command: "npm test" }],
  });
  const provider = item("browser", {
    title: "Provision the headless browser in CI",
    goal: "Provision the pinned headless browser in the CI database job.",
    ownedPaths: ["ci/browser.sh"],
  });
  const failed = `Required checks failed: database\n${LAUNCH}`;
  // Repair 1 tried a correction of a's own; the same check failed the same way.
  const tried = {
    source: "diagnosis",
    failure: failed,
    identity: CI_FAILED,
    diagnosis: "The test launches the browser before it is ready.",
    path: "src/a.js",
    correction: "Wait for the browser in src/a.js.",
    repair: 1,
  };
  const repo = failedResult();
  const asked = [];
  const result = await correction({
    planner: {
      answer: async (call) => {
        asked.push(call);
        return {
          value:
            asked.length === 1
              ? diagnosis({
                  decision: "repair",
                  predecessor: "",
                  path: "src/a.js",
                  correction: "Wait longer for the browser in src/a.js.",
                })
              : diagnosis({}),
        };
      },
    },
    plan: plan([a, provider, item("qa", { kind: "qa" })]),
    item: a,
    finding: { kind: "failure", detail: failed, identity: CI_FAILED },
    checkout: repo.dir,
    base: repo.base,
    commit: repo.commit,
    sources: [],
    prior: [tried],
    repair: 2,
    validate: false,
    signal: AbortSignal.timeout(60_000),
    log: () => {},
  });
  assert.equal(result.kind, "prerequisite", JSON.stringify(result));
  assert.equal(result.provider, "browser");
  assert.match(asked[0].prompt, /"failureRepeatedUnchanged":true/);
  assert.ok(
    asked[0].prompt.includes(
      "never decide repair again; decide predecessor, prerequisite or discover when the evidence shows one, otherwise operator",
    ),
  );
  assert.ok(
    asked[1].prompt.includes(
      "so another repair of this Work Item is refused: return predecessor, prerequisite or discover when the evidence shows one",
    ),
  );
});

test("a repair diagnosis's missing prerequisite is proposed at once, with no question, as an amendment that makes the item depend on the provider: a round without the dependency goes back, and the item waits for the provider's merge, then runs again brought up to date (#2233, #2243)", async () => {
  const found = {
    repair: 2,
    provider: "browser",
    diagnosis:
      "The database job never installs the browser, which browser provisions.",
    failure: `Required checks failed: database\n${LAUNCH}`,
  };
  const { checkout, state } = await building(
    accepted([work("a"), browser, qa(["a", "browser"])]),
    {
      "item:a:prerequisite": found,
      "item:a:refused": {
        commit: "1".repeat(40),
        tree: "2".repeat(40),
        notes: [],
      },
    },
  );
  const a = state.done.plan.items.find((entry) => entry.id === "a");
  const context = (answer) => ({
    state,
    ...(answer ? { answer } : {}),
    signal: AbortSignal.timeout(60_000),
    log: () => {},
    keep: () => {},
  });

  // The diagnosis proposes the amendment as its own, asking nothing; its
  // repair is free.
  const proposed = diagnosedPrerequisite(state, a, found);
  assert.equal(proposed.kind, "retry", JSON.stringify(proposed));
  assert.deepEqual(proposed.free, { target: "item:a:work", repair: 2 });
  apply(state, proposed);
  const proposal = state.kept["amend:prerequisite-a-2:proposal"];
  assert.equal(proposal.actor, "Work Item a's repair diagnosis");
  assert.deepEqual(proposal.prerequisite, { itemId: "a", provider: "browser" });
  assert.deepEqual(proposal.worker, { itemId: "a", attempt: 3 });
  assert.deepEqual(proposal.discovery.dependencies, ["browser"]);
  assert.match(
    prerequisiteAmendment(a, context(), undefined, {}).reason,
    /Waits for amendment prerequisite-a-2/,
  );

  // A round that leaves a not depending on browser goes back; the next,
  // with browser enabling a, is reviewed and accepted.
  const MISSING =
    "This amendment is for Work Item a's failure, a missing prerequisite that Work Item browser provides, and a doesn't depend on browser: name a in browser's enables entry, so a waits for browser's merge";
  const { planner, asked: calls } = scripted(
    revision(),
    revision([], ENABLES_A),
    { findings: [] },
  );
  const deps = depsOf(checkout, planner);
  const first = await step(state, deps);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  assert.deepEqual(
    state.kept["amend:prerequisite-a-2:revisions"][0].findings.map(
      (finding) => finding.message,
    ),
    [MISSING],
  );
  assert.ok(
    calls[0].prompt.includes(
      '"prerequisite":{"itemId":"a","provider":"browser"}',
    ),
  );
  assert.equal((await step(state, deps)).outcome.kind, "done");
  assert.ok(calls[1].prompt.includes(MISSING));
  assert.deepEqual((await step(state, deps)).outcome.kind, "done");
  assert.ok(
    calls[2].prompt.includes(
      '"prerequisite":{"itemId":"a","provider":"browser"}',
    ),
  );
  await step(state, deps);
  const result = state.done["amend:prerequisite-a-2"];
  assert.equal(result.rejected, undefined, result.rejected);
  assert.deepEqual(dependenciesOf(result.plan, "a"), ["browser"]);

  // a waits for browser's merge.
  assert.deepEqual(runnable(state, deps), ["item:browser:work"]);
  state.done["item:browser:merge"] = {
    mergeSha: "5".repeat(40),
    integratedSha: "5".repeat(40),
    at: "2026-01-01T03:00:00.000Z",
  };
  assert.deepEqual(runnable(state, deps), ["item:a:work"]);
  // Then it runs again on the amended plan, charged to no allowance, moved
  // onto the default branch with browser's result, its change replayed.
  const runs = prerequisiteAmendment(a, context(), undefined, {});
  assert.equal(runs.kind, "repair", JSON.stringify(runs));
  assert.deepEqual(runs.free, { target: "item:a:work", repair: 3 });
  assert.equal(runs.keep["item:a:rebase"], true);
  assert.equal(runs.keep["item:a:refused"].amended, "prerequisite-a-2");
  assert.equal(runs.keep["item:a:refused"].replayOnly, undefined);
  assert.equal(runs.keep["item:a:prerequisite"], null);
  // Its own route took it: the edge's record goes with it.
  assert.equal(runs.keep["item:a:enabled"], null);

  // Its question no longer offers depend for this repair.
  assert.ok(
    !missingPrerequisite(state, a, found).options.some(
      (option) => option.answer === "depend",
    ),
  );
});

test("a missing prerequisite whose provider has a question open asks, offering depend, which proposes the amendment as the operator's; continued past, it asks once more without depend (#2243)", async () => {
  const found = {
    repair: 2,
    provider: "browser",
    diagnosis:
      "The database job never installs the browser, which browser provisions.",
    failure: `Required checks failed: database\n${LAUNCH}`,
  };
  const { state } = await building(
    accepted([work("a"), browser, qa(["a", "browser"])]),
    { "item:a:prerequisite": found },
  );
  state.holds.push({
    id: "item:browser:work@1",
    step: "item:browser:work",
    item: "browser",
    question: "Work Item browser needs your decision.",
    options: [],
    cause: "question",
    askedAt: "2026-01-01T01:30:00.000Z",
  });
  const a = state.done.plan.items.find((entry) => entry.id === "a");

  // The diagnosis asks, its repair free, offering depend with no text.
  const asked = diagnosedPrerequisite(state, a, found);
  assert.equal(asked.kind, "hold", JSON.stringify(asked));
  assert.deepEqual(asked.free, { target: "item:a:work", repair: 2 });
  assert.equal(asked.keep, undefined);
  assert.deepEqual(
    asked.options.map((option) => [option.answer, option.needsText ?? false]),
    [
      ["depend", false],
      ["answer", true],
      ["retry", false],
      ["replan", false],
      ["cancel", false],
    ],
  );
  assert.match(asked.question, /a then waits for browser's merge/);

  // Another answer: the repair goes on as usual.
  assert.equal(
    prerequisiteAmendment(
      a,
      contextOf(state, { holdId: "h", answer: "retry", by: "octo" }),
      undefined,
      {},
    ),
    undefined,
  );
  const depend = {
    holdId: "item:a:work@3",
    question: asked.question,
    answer: "depend",
    by: "octo",
    at: "2026-01-01T02:00:00.000Z",
  };
  const proposed = prerequisiteAmendment(
    a,
    contextOf(state, depend),
    undefined,
    {},
  );
  assert.equal(proposed.kind, "retry", JSON.stringify(proposed));
  apply(state, proposed);
  const proposal = state.kept["amend:prerequisite-a-2:proposal"];
  assert.equal(proposal.actor, "octo");
  assert.deepEqual(proposal.prerequisite, { itemId: "a", provider: "browser" });

  // Settled with the plan unchanged: it asks once more, without depend,
  // and the answer to that goes on as usual.
  state.done["amend:prerequisite-a-2"] = { unchanged: true };
  const again = prerequisiteAmendment(a, contextOf(state), undefined, {});
  assert.equal(again.kind, "hold", JSON.stringify(again));
  assert.match(again.question, /didn't change the plan/);
  assert.ok(!again.options.some((option) => option.answer === "depend"));
  apply(state, again);
  assert.equal(state.kept["item:a:prerequisite"], undefined);
  assert.equal(
    prerequisiteAmendment(
      a,
      contextOf(state, { holdId: "h2", answer: "retry", by: "octo" }),
      undefined,
      {},
    ),
    undefined,
  );
});
