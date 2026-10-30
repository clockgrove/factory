// #2233: Work Item a's tests launch a headless browser. Its PR's CI job
// never provisions one, so CI failed the same way on every repair. An
// accepted amendment added the item that provisions the browser, but left
// a not depending on it, so a's CI kept running before the provisioning
// was on the default branch, until the operator said "make a depend on
// it". Now an item that provides a prerequisite names the current items
// that need it in the amendment answer's `enables`, and Factory makes each
// depend on it, a published one too; the planner and the review are told
// which items are failing CI or validation. A repair diagnosis that finds
// a missing prerequisite another item provides offers `depend`, whose
// amendment the fence refuses until the item depends on the provider; the
// item then waits for the provider's merge and runs again on the default
// branch with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { amendmentSteps } from "../dist/planning/amendments.js";
import { buildFacts } from "../dist/planning/facts.js";
import { decodePlan } from "../dist/planning/wire.js";
import { correction } from "../dist/repair.js";
import { readShown } from "../dist/shown.js";
import { prerequisiteAmendment } from "../dist/work/amend.js";
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
  validation: ["npm test"],
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
  validation: ["npm test"],
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

  // a waits for browser; once browser merges, a runs again.
  assert.deepEqual(runnable(state, deps), ["item:browser:work"]);
  state.done["item:browser:merge"] = {
    mergeSha: "5".repeat(40),
    integratedSha: "5".repeat(40),
    at: "2026-01-01T03:00:00.000Z",
  };
  assert.deepEqual(runnable(state, deps), ["item:a:work"]);
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
  const { planner } = scripted(
    revision(
      [browser, qa(["a", "browser"])],
      [{ itemId: "browser", enables: ["a", "nowhere"] }],
    ),
  );
  const first = await step(state, depsOf(checkout, planner));
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  const [kept] = state.kept["amend:op-1:revisions"];
  assert.deepEqual(
    kept.findings.map((finding) => finding.message),
    [
      `browser's enables names "nowhere", which is not another item of the plan being amended that has yet to merge; name only the current items that need what browser provides (a new item depends on it through its own dependencies)`,
    ],
  );
  // The valid entry still made its edge.
  assert.deepEqual(dependenciesOf(kept.answer, "a"), ["browser"]);
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

test("a missing prerequisite answered depend amends the plan so the item depends on the provider: a round without the dependency goes back, and the item waits for the provider's merge, then runs again brought up to date (#2233)", async () => {
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

  // The diagnosis's question offers depend, with no guidance text needed.
  const asked = missingPrerequisite(state, a, found);
  assert.equal(asked.kind, "hold");
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
  assert.equal(prerequisiteAmendment(a, context(), undefined, {}), undefined);
  const depend = {
    holdId: "item:a:work@3",
    question: asked.question,
    answer: "depend",
    by: "octo",
    at: "2026-01-01T02:00:00.000Z",
  };
  const proposed = prerequisiteAmendment(a, context(depend), undefined, {});
  assert.equal(proposed.kind, "retry", JSON.stringify(proposed));
  apply(state, proposed);
  const proposal = state.kept["amend:prerequisite-a-2:proposal"];
  assert.deepEqual(proposal.prerequisite, { itemId: "a", provider: "browser" });
  assert.deepEqual(proposal.worker, { itemId: "a", attempt: 3 });
  assert.deepEqual(proposal.discovery.dependencies, ["browser"]);
  assert.match(
    prerequisiteAmendment(a, context(depend), undefined, {}).reason,
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
  assert.equal(runs.keep["item:a:refused"].replayOnly, true);
  assert.equal(runs.keep["item:a:prerequisite"], null);

  // Its question no longer offers depend for this repair.
  assert.ok(
    !missingPrerequisite(state, a, found).options.some(
      (option) => option.answer === "depend",
    ),
  );
});
