// clockgrove/factory#2344: a Work Item's result review refuses only with a
// failure Factory reproduces. On one recorded item the reviewer refused 4
// times to find 1 real bug: over a test it judged weak, a behaviour the
// plan never defined, and assertions it found under another validation
// command than the plan named. The earlier reviewer now finds, a proof of
// each of its refusals writes a repro, and Factory runs it. These are the PRD's
// acceptance tests, on real Git repositories and the real sandbox, the
// reviewer's and the proofs' answers given as fixtures at the planner seam.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { ItemTelemetries, telemetryText } from "../dist/item-telemetry.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import {
  commandToolDescription,
  PROOF_SCHEMA,
  PROTECTED_CRITERION,
  proofInstructions,
  protectedCriterion,
  reviewCandidate,
  reviewNotes,
  reviewResult,
  validationWorkspace,
} from "../dist/review/item.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { validateTree } from "../dist/validate.js";
import { withRepros } from "../dist/work/repros.js";
import { REFUSES_ITEM, reviewOutcome } from "../dist/work/step-review.js";
import {
  configured,
  installation,
  item,
  NO_WORKSPACE,
  REPO,
  tempDir,
} from "./helpers.mjs";

const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// The snapshot-late defect, reduced: a snapshot older than the patches
// already received must not discard them.
const REDUCER = `export function reduce(events) {
  let state = { version: 0, items: [] };
  for (const event of events) {
    if (event.kind === "snapshot") state = { version: event.version, items: [...event.items] };
    else if (event.version > state.version) state = { version: event.version, items: [...state.items, event.item] };
  }
  return state;
}
`;
const TEST = `import assert from "node:assert";
import { reduce } from "../src/reduce.js";
assert.deepEqual(reduce([{ kind: "snapshot", version: 1, items: ["a"] }]).items, ["a"]);
`;
const COMMANDS = [
  "node test/reduce.test.js",
  "node test/reduce.test.js --again",
];
const CRITERIA = [
  "A snapshot older than patches already received keeps those patches.",
  "A patch adds its item to the projection.",
];
// Prints the wrong projection and exits 1 on the candidate.
const REPRO = `node -e 'import("./src/reduce.js").then(({ reduce }) => { const s = reduce([{ kind: "patch", version: 2, item: "b" }, { kind: "snapshot", version: 1, items: ["a"] }]); console.log("items:", JSON.stringify(s.items)); process.exit(s.items.includes("b") ? 0 : 1); })'`;

/** A target whose candidate adds the reducer and its test, and `files` at the base and head. */
function target(reducer = REDUCER, files = {}) {
  const checkout = tempDir("factory-repro-");
  git(checkout, "init", "--quiet");
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(checkout, path, ".."), { recursive: true });
      writeFileSync(join(checkout, path), content);
    }
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "change");
    return git(checkout, "rev-parse", "HEAD");
  };
  const base = commit({
    "package.json": '{"type":"module"}\n',
    ...files.base,
  });
  const head = commit({
    "src/reduce.js": reducer,
    "test/reduce.test.js": TEST,
    ...files.head,
  });
  return {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", "HEAD^{tree}"),
    commit,
  };
}

function setup(repo) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const config = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const work = item("reduce", {
    acceptance: CRITERIA,
    ownedPaths: ["src/**", "test/**"],
    validation: COMMANDS.map((command) => ({ command })),
  });
  const plan = {
    base: repo.base,
    items: [work],
    coverage: [],
    finalCommands: [],
    decisions: [],
  };
  const sandbox = { ...config.sandbox, network: "off" };
  const validation = (commit) => ({
    checkout: repo.checkout,
    repository: REPO,
    commit,
    item: work,
    plan,
    blocks: [],
    base: repo.base,
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: () => {},
    runFile: (kind) => log.runFile(1, `item:reduce:review#1.${kind}`),
  });
  return { work, plan, sandbox, validation };
}

/** The review's bounds: the installation's defaults, the test's command limit. */
const LIMITS = {
  commandMs: 60_000,
  prepareMs: 60_000,
  proofs: 10,
  proofCommands: 8,
  proofBudgetMs: 60_000,
};

/** One review of the candidate with `planner`, its events logged. */
function review(repo, planner, extra = {}) {
  const { work, validation } = setup(repo);
  const events = [];
  return {
    events,
    run: reviewCandidate({
      planner,
      checkout: repo.checkout,
      base: repo.base,
      commit: repo.head,
      criteria: work.acceptance,
      validation: { tree: repo.tree, commands: COMMANDS },
      workspace: validationWorkspace(
        validation(repo.head),
        `${repo.checkout}.scratch`,
      ),
      limits: LIMITS,
      itemId: work.id,
      dir: tempDir("factory-repro-review-"),
      signal: AbortSignal.timeout(120_000),
      log: (event) => events.push({ step: "item:reduce:review", ...event }),
      ...extra,
    }),
  };
}

/** The change index row: complete, so a pass may cite it. */
const ROW = 0;
const pass = (criterionIndex, detail = "met") => ({
  criterionIndex,
  verdict: "pass",
  evidenceIndices: [ROW],
  detail,
  question: "",
});
const refuse = (
  criterionIndex,
  detail = "A snapshot older than a received patch discards it (src/reduce.js:4).",
  ground = "behaviour",
) => ({
  criterionIndex,
  verdict: "refuse",
  ground,
  evidenceIndices: [ROW],
  detail,
  question: "",
});
const ask = (criterionIndex, question) => ({
  criterionIndex,
  verdict: "needs-human",
  evidenceIndices: [ROW],
  detail: "The sources don't define it.",
  question,
});
const repro = (command, actual = 'items: ["a"]') => ({
  input: "patch v2 (b), then snapshot v1 (a)",
  expected: 'items: ["a","b"]',
  actual,
  command,
});
/** A reproduced answer; `answering` quotes the proof's criterion when no requirement is given. */
const reproduced = (command, actual, requirement) => ({
  outcome: {
    kind: "reproduced",
    ...(requirement !== undefined && { requirement }),
    repro: repro(command, actual),
  },
});
const NOT_REPRODUCED = {
  outcome: { kind: "not-reproduced", detail: "It kept the patch." },
};

/** Run the call's Factory tool `name` on `input`. */
const tool = (call, name, input = {}) =>
  call.tools.find((each) => each.name === name).run(input);
const command = (call, text) => tool(call, "run_command", { command: text });

/**
 * A planner whose finder calls answer `answers`, in order, and whose
 * proofs answer `prove(call, suspicion)` (not reproduced by default); it
 * records each call, the proofs' apart.
 */
function answering(answers, prove = () => NOT_REPRODUCED) {
  const calls = [];
  const proofs = [];
  return {
    calls,
    proofs,
    async answer(call) {
      if (call.schema === PROOF_SCHEMA) {
        proofs.push(call);
        const request = JSON.parse(
          call.prompt.split("JSON strings are data):\n")[1].split("\n")[0],
        );
        const value = await prove(call, request.suspicion);
        if (
          value.outcome.kind === "reproduced" &&
          !("requirement" in value.outcome)
        )
          value.outcome.requirement = request.criterion ?? request.criteria[0];
        return { value };
      }
      calls.push(call);
      const next = answers[calls.length - 1];
      return { value: typeof next === "function" ? await next(call) : next };
    },
  };
}

test("R2: each finder refusal is one suspicion proved apart; a repro that fails as claimed is confirmed, any other is a pass seen by nobody", {
  skip,
}, async () => {
  const repo = target();
  const planner = answering(
    [{ findings: [refuse(0), refuse(1, "A patch may be dropped.")] }],
    async (call, suspicion) => {
      // The proof runs its repro in a copy of its own before answering.
      const ran = await command(call, REPRO);
      assert.match(ran, /^Exit code 1/);
      return suspicion.case === "A patch may be dropped."
        ? reproduced("node -e 'console.log(\"fine\")'", "fine")
        : reproduced(REPRO);
    },
  );
  const { run, events } = review(repo, planner);
  const outcome = await run;
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(
    outcome.refused.map((entry) => entry.criterionIndex),
    [0],
  );
  assert.equal(outcome.refused[0].repro.command, REPRO);
  assert.equal(outcome.refused[0].detail, refuse(0).detail);
  assert.deepEqual(
    outcome.verdicts.map(({ criterionIndex, verdict }) => [
      criterionIndex,
      verdict,
    ]),
    [[1, "pass"]],
  );
  // A proof gets the criterion and its suspicion only, the workspace's
  // checkout to read and run_command, in a fresh call.
  assert.equal(planner.proofs.length, 2);
  for (const call of planner.proofs) {
    assert.deepEqual(
      call.tools.map((each) => each.name),
      ["run_command"],
    );
    assert.equal(call.readDir, `${repo.checkout}.scratch`);
    assert.ok(!call.prompt.includes("evidenceIndex"));
    assert.equal(call.conversation, undefined);
  }
  const { suspicion } = JSON.parse(
    planner.proofs[0].prompt
      .split("JSON strings are data):\n")[1]
      .split("\n")[0],
  );
  assert.ok(CRITERIA.includes(suspicion.expected));
  assert.deepEqual(
    events
      .filter((event) => event.event === "result-review-suspicion")
      .map(({ criterionIndex, outcome, reason }) => ({
        criterionIndex,
        outcome,
        reason,
      }))
      .sort((a, b) => a.criterionIndex - b.criterionIndex),
    [
      { criterionIndex: 0, outcome: "proved", reason: undefined },
      { criterionIndex: 1, outcome: "dropped", reason: "it exited 0" },
    ],
  );
  const logged = events.find((event) => event.event === "result-review");
  assert.deepEqual(
    { ...logged.suspicions, tokens: undefined },
    { raised: 2, proved: 1, dropped: 1, tokens: undefined },
  );
  assert.deepEqual(logged.verdicts, { pass: 0, suspect: 2, question: 0 });
  assert.equal(
    events.find((event) => event.event === "result-review-find").outcome,
    "refused",
  );
  // Only the confirmed refusal costs a repair.
  const repairs = [];
  reviewOutcome(
    outcome,
    () => ({}),
    REFUSES_ITEM,
    (refusal) => {
      repairs.push(refusal.refused.length);
      return { kind: "repair", target: "item:reduce:work", reason: "" };
    },
  );
  assert.deepEqual(repairs, [1]);
  // A repro whose command fails for another reason than the claimed one
  // is dropped, and so is a suspicion its proof didn't reproduce.
  for (const prove of [
    () => reproduced(REPRO, 'items: ["z"]'),
    () => NOT_REPRODUCED,
  ]) {
    const dropped = answering([{ findings: [refuse(0), pass(1)] }], prove);
    assert.equal((await review(repo, dropped).run).kind, "pass");
  }
  // Refusals of two criteria citing overlapping lines of one tracked file
  // are one proof, and its confirmed repro refuses both.
  const merged = answering(
    [
      {
        findings: [
          refuse(0),
          refuse(1, "The patch is lost (candidate/src/reduce.js:3-5)."),
        ],
      },
    ],
    () => reproduced(REPRO),
  );
  const { run: mergedRun, events: mergedEvents } = review(repo, merged);
  const both = await mergedRun;
  assert.equal(merged.proofs.length, 1);
  assert.deepEqual(
    both.refused.map((entry) => [entry.criterionIndex, entry.repro.command]),
    [
      [0, REPRO],
      [1, REPRO],
    ],
  );
  const request = JSON.parse(
    merged.proofs[0].prompt
      .split("JSON strings are data):\n")[1]
      .split("\n")[0],
  );
  assert.deepEqual(request.criteria, CRITERIA);
  assert.deepEqual(
    mergedEvents.find((event) => event.event === "result-review-suspicion")
      .criteria,
    [0, 1],
  );
  // Past the review's proofs at once, a suspicion waits for a lane and is
  // proved: none passes unproved.
  let running = 0;
  let most = 0;
  const capped = answering(
    [{ findings: [refuse(0), refuse(1, "A patch may be dropped.")] }],
    async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 50));
      running -= 1;
      return reproduced(REPRO);
    },
  );
  const { run: cappedRun, events: cappedEvents } = review(repo, capped, {
    limits: { ...LIMITS, proofs: 1 },
  });
  assert.deepEqual(
    (await cappedRun).refused.map((entry) => entry.criterionIndex),
    [0, 1],
  );
  assert.equal(most, 1);
  assert.deepEqual(
    cappedEvents
      .filter((event) => event.event === "result-review-suspicion")
      .map((event) => event.outcome),
    ["proved", "proved"],
  );
});

test("D: refusals citing one file merge on its full path when both name a directory, on its basename when one doesn't", {
  skip,
}, async () => {
  const repo = target();
  const proofs = async (first, second) => {
    const planner = answering(
      [{ findings: [refuse(0, first), refuse(1, second)] }],
      () => NOT_REPRODUCED,
    );
    await review(repo, planner).run;
    return planner.proofs.length;
  };
  assert.equal(
    await proofs("Wrong (src/a/index.js:3).", "Lost (src/b/index.js:3)."),
    2,
  );
  assert.equal(
    await proofs("Wrong (src/a/index.js:3).", "Lost (./src/a/index.js:2-4)."),
    1,
  );
  assert.equal(
    await proofs("Wrong (index.js:3).", "Lost (src/a/index.js:3)."),
    1,
  );
  assert.equal(
    await proofs("Wrong (src/a/index.js:3).", "Lost (src/a/index.js:9)."),
    2,
  );
});

test("A: the finder names each refusal's ground; test economy, placement and standard are notes, a protected change is the check's, and none costs a proof", {
  skip,
}, async () => {
  const repo = target();
  const planner = answering([
    {
      findings: [
        refuse(0, "The test repeats another's claim.", "test-economy"),
        refuse(1, "An existing assertion was changed.", "protected-change"),
      ],
    },
  ]);
  const { run, events } = review(repo, planner);
  const outcome = await run;
  assert.equal(planner.proofs.length, 0);
  assert.equal(outcome.kind, "pass");
  assert.deepEqual(reviewNotes(outcome), [
    { criterion: CRITERIA[0], note: "The test repeats another's claim." },
  ]);
  assert.equal(outcome.verdicts[1].verdict, "pass");
  assert.deepEqual(
    events
      .filter((event) => event.event === "result-review-routed")
      .map(({ ground, outcome }) => [ground, outcome]),
    [
      ["test-economy", "note"],
      ["protected-change", "protected-check"],
    ],
  );
  assert.deepEqual(
    events.find((event) => event.event === "result-review").grounds,
    { "test-economy": 1, "protected-change": 1 },
  );
  // The finder's schema asks a refusal for its ground; a refusal without
  // one is invalid.
  const [call] = planner.calls;
  const variants = call.schema.properties.findings.items.anyOf;
  const refusal = variants.find(
    (variant) => variant.properties.verdict.enum[0] === "refuse",
  );
  assert.ok(refusal.required.includes("ground"));
  assert.deepEqual(refusal.properties.ground.enum, [
    "behaviour",
    "verification-gap",
    "test-economy",
    "placement",
    "standard",
    "protected-change",
  ]);
  assert.ok(!call.prompt.includes("Command-proven criteria"));
  const { ground: _ground, ...bare } = refuse(0);
  const ungrounded = answering([
    { findings: [bare, pass(1)] },
    { findings: [bare, pass(1)] },
  ]);
  await review(repo, ungrounded).run;
  assert.equal(ungrounded.calls.length, 2);
  assert.match(ungrounded.calls[1].prompt, /A refusal needs its ground/);
});

test("B: a result that removes many assertions from an existing test is the operator's question, never a refusal; accept settles it", {
  skip,
}, async () => {
  const lines = (n) =>
    Array.from({ length: n }, (_, i) => `expect(f(${i})).toBe(${i});`).join(
      "\n",
    );
  // Each style the heuristic knows: expect(, node's assert methods,
  // unittest's assert methods and pytest.raises.
  const styled = (n, line) => Array.from({ length: n }, () => line).join("\n");
  const files = (old, node, unit) => ({
    "test/old.test.js": lines(old),
    "test/kept.test.js": lines(old === 12 ? 4 : 3),
    "test/node.test.js": styled(node, "  assert.equal(f(1), 1);"),
    "tests/test_unit.py": `${styled(unit, "        self.assertEqual(f(1), 1)")}\n${styled(unit, "    with pytest.raises(ValueError):")}`,
  });
  const reduced = (old, node, unit) =>
    target(REDUCER, { base: files(12, 12, 6), head: files(old, node, unit) });
  const repo = reduced(1, 12, 0);
  const planner = answering([{ findings: [pass(0), pass(1)] }]);
  const { run, events } = review(repo, planner);
  const outcome = await run;
  assert.equal(outcome.kind, "needs-human");
  assert.equal(planner.proofs.length, 0);
  const fired = [
    { path: "test/old.test.js", base: 12, candidate: 1 },
    { path: "tests/test_unit.py", base: 12, candidate: 0 },
  ];
  assert.deepEqual(
    outcome.questions.map(({ criterionIndex, criterion }) => [
      criterionIndex,
      criterion,
    ]),
    [[2, protectedCriterion(fired)]],
  );
  assert.ok(outcome.questions[0].criterion.startsWith(PROTECTED_CRITERION));
  assert.match(outcome.questions[0].detail, /test\/old\.test\.js 12 → 1/);
  assert.doesNotMatch(outcome.questions[0].detail, /kept|node/);
  assert.deepEqual(
    events.find((event) => event.event === "result-review-protected").files,
    fired,
  );
  // node's assert methods count: removing them fires too.
  const node = await review(
    reduced(12, 0, 6),
    answering([{ findings: [pass(0), pass(1)] }]),
  ).run;
  assert.match(node.questions[0].detail, /test\/node\.test\.js 12 → 0/);
  // The operator's accept authorizes those files with those counts.
  const decision = {
    criterion: outcome.questions[0].criterion,
    outcome: "accept",
    reason: "The old cases moved to a table.",
    by: "operator",
    at: "2026-01-01T00:00:00Z",
    tree: repo.tree,
    itemId: "reduce",
  };
  const settledBy = (repo) =>
    review(repo, answering([{ findings: [pass(0), pass(1)] }]), {
      context: { decisions: [decision] },
    }).run;
  assert.equal((await settledBy(repo)).kind, "pass");
  // A repaired result, another tree with the same reduction: not asked again.
  const repaired = target(`${REDUCER}// repaired\n`, {
    base: files(12, 12, 6),
    head: files(1, 12, 0),
  });
  assert.notEqual(repaired.tree, repo.tree);
  assert.equal((await settledBy(repaired)).kind, "pass");
  // Other counts are asked again, for that file only.
  const other = await settledBy(reduced(2, 12, 0));
  assert.equal(other.kind, "needs-human");
  assert.deepEqual(
    other.questions.map((entry) => entry.criterion),
    [
      protectedCriterion([
        { path: "test/old.test.js", base: 12, candidate: 2 },
      ]),
    ],
  );
});

test("E: a reproduced proof quotes the criterion its expected rests on, verbatim, and the suspicion keeps it", {
  skip,
}, async () => {
  const repo = target();
  // An invented requirement is asked again once, then dropped.
  const invented = answering([{ findings: [refuse(0), pass(1)] }], () =>
    reproduced(REPRO, undefined, "patches are never discarded"),
  );
  const { run, events } = review(repo, invented);
  assert.equal((await run).kind, "pass");
  assert.equal(invented.proofs.length, 2);
  assert.match(invented.proofs[1].prompt, /requirement must quote, verbatim/);
  assert.equal(
    events.find((event) => event.event === "result-review-suspicion").reason,
    "its answer was invalid twice",
  );
  // A quotation of the criterion, whitespace aside, is kept on the suspicion.
  const quoted = answering([{ findings: [refuse(0), pass(1)] }], () =>
    reproduced(REPRO, undefined, "keeps   those patches"),
  );
  const { run: quotedRun, events: quotedEvents } = review(repo, quoted);
  assert.equal((await quotedRun).kind, "refused");
  assert.equal(
    quotedEvents.find((event) => event.event === "result-review-suspicion")
      .requirement,
    "keeps   those patches",
  );
});

test("review.proofs is at least 1 and 4 by default: a review that proved nothing could refuse nothing", () => {
  const load = (fields) => {
    const inst = installation();
    configured(inst, "http://127.0.0.1:1", {}, fields);
    process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
    try {
      return loadConfig(REPO);
    } finally {
      delete process.env.FACTORY_CONFIG;
    }
  };
  assert.equal(load({}).review.proofs, 4);
  assert.throws(
    () => load({ review: { proofs: 0 } }),
    /review\.proofs must be a whole number from 1/,
  );
});

test("no silent pass: a criterion the finder leaves without a verdict beside a refusal is asked again alone, once, then is the operator's question", {
  skip,
}, async () => {
  const repo = target();
  // The first answer refuses criterion 0 and omits criterion 1; asked
  // again for criterion 1 alone, it answers nothing valid.
  const planner = answering([{ findings: [refuse(0)] }, { findings: [] }]);
  const { run, events } = review(repo, planner);
  const outcome = await run;
  assert.equal(planner.calls.length, 2);
  const asked = (call) =>
    JSON.parse(
      call.prompt.split("\n").find((line) => line.startsWith('{"criteria"')),
    ).criteria.map((entry) => entry.criterion);
  assert.deepEqual(asked(planner.calls[0]), CRITERIA);
  assert.deepEqual(asked(planner.calls[1]), [CRITERIA[1]]);
  assert.deepEqual(
    events.find((event) => event.event === "result-review-missing").criteria,
    [1],
  );
  // The refusal didn't reproduce: criterion 0 passes, and criterion 1 is
  // a question in one hold, never a pass.
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(
    outcome.questions.map((entry) => entry.criterionIndex),
    [1],
  );
  assert.deepEqual(
    outcome.verdicts.map((entry) => [entry.criterionIndex, entry.verdict]),
    [[0, "pass"]],
  );
  const held = reviewOutcome(
    outcome,
    () => ({}),
    REFUSES_ITEM,
    () => {
      assert.fail("repaired");
    },
  );
  assert.equal(held.kind, "hold");
});

test("R3: after a repair, the confirmed repro runs as extra validation and must pass", {
  skip,
}, async () => {
  const repo = target();
  const { work, validation } = setup(repo);
  const state = {
    kept: {
      "plan:acceptedAt": "2026-01-01T00:00:00.000Z",
      "item:reduce:repros": {
        plan: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            criterion: CRITERIA[0],
            tree: repo.tree,
            detail: "A late snapshot discards a received patch.",
            repro: repro(REPRO),
          },
        ],
      },
    },
  };
  const checked = withRepros(state, work);
  assert.deepEqual(checked.validation.at(-1), { command: REPRO, after: [] });
  const validate = (commit) =>
    validateTree({
      ...validation(commit),
      item: checked,
      directory: `${repo.checkout}.validation`,
    });
  const refused = await validate(repo.head);
  assert.equal(refused.kind, "failed");
  assert.equal(refused.failed.command, REPRO);
  const repaired = repo.commit({
    "src/reduce.js": REDUCER.replace(
      "state = { version: event.version, items: [...event.items] };",
      "state = { version: Math.max(event.version, state.version), items: [...new Set([...event.items, ...state.items])] };",
    ),
  });
  const passed = await validate(repaired);
  assert.equal(passed.kind, "passed", passed.detail);
  assert.ok(passed.commands.includes(REPRO));
  // An operator's accept of the refused criterion on that tree drops it.
  state.kept["item:reduce:decisions"] = [
    {
      criterion: CRITERIA[0],
      outcome: "accept",
      reason: "the reviewer was wrong",
      by: "kirk",
      at: "2026-01-01T00:00:00.000Z",
      tree: repo.tree,
      itemId: "reduce",
      holdId: "h",
      plan: "2026-01-01T00:00:00.000Z",
    },
  ];
  assert.equal(withRepros(state, work), work);
});

test("R4: a proof runs commands in its own scratch copy, within its budget; the network is refused as in validation", {
  skip,
}, async () => {
  const repo = target();
  const fetch =
    'node -e \'fetch("http://example.com").then(() => process.exit(0), () => { console.log("no network"); process.exit(7); })\'';
  const replies = [];
  const planner = answering(
    [{ findings: [refuse(0), pass(1)] }],
    async (call) => {
      for (const text of [
        "node test/reduce.test.js && echo tested",
        fetch,
        // The scratch is a copy: a write there never reaches the candidate.
        "echo changed > src/reduce.js",
        "pwd",
        "true",
      ])
        replies.push(await command(call, text).catch((error) => error.message));
      return NOT_REPRODUCED;
    },
  );
  const { run, events } = review(repo, planner, {
    limits: { ...LIMITS, proofCommands: 4 },
  });
  assert.equal((await run).kind, "pass");
  assert.match(replies[0], /^Exit code 0 .*\ntested/);
  assert.match(replies[1], /^Exit code 7 .*\nno network/);
  // It appears at the workspace's path, where the install's recorded
  // paths (pnpm's workspace state) hold.
  assert.equal(replies[3].split("\n")[1], `${repo.checkout}.scratch`);
  assert.match(replies[4], /command budget is spent \(4 commands/);
  assert.equal(git(repo.checkout, "rev-parse", "HEAD^{tree}"), repo.tree);
  const proof = events.find(
    (event) => event.event === "result-review-suspicion",
  );
  assert.equal(proof.commands, 4);
  const logged = events.find((event) => event.event === "result-review");
  for (const phase of ["prepareMs", "modelMs", "proofsMs"])
    assert.equal(typeof logged.phases[phase], "number", phase);
  // The same call fails as a validation command.
  const { validation, work } = setup(repo);
  const validated = await validateTree({
    ...validation(repo.head),
    item: { ...work, validation: [{ command: fetch }] },
    directory: `${repo.checkout}.validation`,
  });
  assert.equal(validated.kind, "failed");
  assert.match(validated.output, /no network/);
});

test("a refusal of weakened protected tests is proved by running the base's test on the result", {
  skip,
}, async () => {
  const repo = target(REDUCER);
  // The base's test checks patches; the candidate drops that assertion
  // and the behaviour it guarded.
  const guarded = `${TEST}assert.deepEqual(reduce([{ kind: "patch", version: 2, item: "b" }]).items, ["b"]);\n`;
  repo.base = repo.commit({ "test/reduce.test.js": guarded });
  repo.head = repo.commit({
    "src/reduce.js": REDUCER.replace(
      "[...state.items, event.item]",
      "state.items",
    ),
    "test/reduce.test.js": TEST,
  });
  repo.tree = git(repo.checkout, "rev-parse", "HEAD^{tree}");
  // The base's test file, run on the result, then put back.
  const check = `git show ${repo.base}:test/reduce.test.js > /tmp/base.test.js && cp /tmp/base.test.js test/base.test.js && node test/base.test.js; s=$?; rm -f test/base.test.js; exit $s`;
  const planner = answering(
    [
      {
        findings: [
          pass(0),
          refuse(
            1,
            "test/reduce.test.js lost its patch assertion, and a patch no longer adds its item.",
          ),
        ],
      },
    ],
    async (call) => {
      const ran = await command(call, check);
      assert.match(ran, /AssertionError/);
      return reproduced(check, "AssertionError");
    },
  );
  const outcome = await review(repo, planner).run;
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(
    outcome.refused.map((entry) => entry.criterion),
    [CRITERIA[1]],
  );
  // As validation after a repair, the repro leaves the tree as it found it.
  const { work, validation } = setup(repo);
  const validated = await validateTree({
    ...validation(repo.base),
    item: { ...work, validation: [{ command: check }] },
    directory: `${repo.checkout}.validation`,
  });
  assert.equal(validated.kind, "passed", validated.detail);
});

test("the finder judges the Objective criteria the item proves after its own acceptance", async () => {
  const repo = target();
  const { work, plan } = setup(repo);
  const objective = "Patches survive a late snapshot.";
  const bound = {
    ...plan,
    coverage: [
      {
        itemId: "reduce",
        source: { path: "OBJECTIVE", heading: "Acceptance", text: objective },
        proof: { kind: "result-semantic" },
      },
    ],
  };
  const planner = answering([{ findings: [pass(0), pass(1), pass(2)] }]);
  const outcome = await reviewResult({
    planner,
    plan: bound,
    item: work,
    checkout: repo.checkout,
    base: repo.base,
    commit: repo.head,
    validation: { tree: repo.tree, commands: COMMANDS },
    sources: [],
    ...NO_WORKSPACE,
    dir: tempDir("factory-repro-review-"),
    signal: AbortSignal.timeout(60_000),
    log: () => {},
  });
  assert.equal(outcome.kind, "pass");
  assert.deepEqual(
    outcome.verdicts.map((verdict) => verdict.criterion),
    [...CRITERIA, objective],
  );
});

test("R7: every review is a fresh call, and a re-review's packet holds the confirmed refusals and the repair's diff", async () => {
  const repo = target();
  const first = answering([{ findings: [pass(0), pass(1)] }]);
  await review(repo, first).run;
  const repaired = repo.commit({ "src/reduce.js": `${REDUCER}// repaired\n` });
  const second = answering([{ findings: [pass(0), pass(1)] }]);
  const { work } = setup(repo);
  await reviewCandidate({
    planner: second,
    checkout: repo.checkout,
    base: repo.base,
    commit: repaired,
    criteria: work.acceptance,
    validation: {
      tree: git(repo.checkout, "rev-parse", "HEAD^{tree}"),
      commands: COMMANDS,
    },
    ...NO_WORKSPACE,
    itemId: work.id,
    prior: {
      tree: repo.tree,
      refused: [
        {
          criterion: CRITERIA[0],
          detail: "A late snapshot discards a received patch.",
          repro: repro(REPRO),
        },
      ],
    },
    dir: tempDir("factory-repro-review-"),
    signal: AbortSignal.timeout(60_000),
    log: () => {},
  });
  for (const call of [...first.calls, ...second.calls])
    assert.equal(call.conversation, undefined);
  const packet = second.calls[0].prompt;
  assert.ok(packet.includes("Previous refusals and the repair"));
  assert.ok(packet.includes("+// repaired"));
  assert.ok(packet.includes("process.exit(s.items.includes"));
  assert.ok(!packet.includes('"findings"'));
});

test("R8: behaviour the sources don't define is one question, one hold and no repair", async () => {
  const repo = target();
  const planner = answering([
    {
      findings: [
        ask(
          0,
          "Should a missing final patch request recovery, or end at the delivered prefix?",
        ),
        ask(1, "Should a duplicate patch be applied twice?"),
      ],
    },
  ]);
  const outcome = await review(repo, planner).run;
  assert.equal(outcome.kind, "needs-human");
  let repaired = false;
  const held = reviewOutcome(
    outcome,
    () => ({}),
    REFUSES_ITEM,
    () => {
      repaired = true;
    },
  );
  assert.equal(held.kind, "hold");
  assert.match(held.question, /Should a missing final patch/);
  assert.match(held.question, /Should a duplicate patch/);
  assert.equal(repaired, false);
});

test("R9: a proof's instructions with its tool's description fit in 5,000 characters", () => {
  const proof =
    proofInstructions(LIMITS).length +
    commandToolDescription({ ...LIMITS, network: "host" }).length;
  assert.ok(proof <= 5000, `${proof} characters`);
});

test("R11: the item's telemetry shows the reviews' verdicts, suspicions, repros, questions, tokens and time, as text and JSON", () => {
  const telemetry = new ItemTelemetries();
  const at = "2026-01-01T00:00:00.000Z";
  const suspicions = { raised: 4, proved: 1, dropped: 3, tokens: 900 };
  for (const event of [
    { event: "start", step: "item:reduce:review", at },
    {
      event: "model-usage",
      step: "item:reduce:review",
      role: "reviewer",
      phase: "result-review",
      tokens: { total: 1200 },
      at,
    },
    {
      event: "result-review",
      step: "item:reduce:review",
      outcome: "refused",
      verdicts: { pass: 1, suspect: 4, question: 0 },
      suspicions,
      repros: { confirmed: 1, dropped: 1 },
      questions: 1,
      phases: { prepareMs: 12_000, modelMs: 90_000, proofsMs: 8000 },
      ms: 4000,
      at,
    },
  ])
    telemetry.add(event);
  const item = telemetry.liveItems().reduce;
  assert.deepEqual(
    {
      verdicts: item.reviewer.verdicts,
      suspicions: item.reviewer.suspicions,
      repros: item.reviewer.repros,
      tokens: item.reviewer.tokens.sum,
      ms: item.reviewer.ms,
      phases: item.reviewer.phases,
    },
    {
      verdicts: { pass: 1, suspect: 4, question: 0 },
      suspicions,
      repros: { confirmed: 1, dropped: 1 },
      tokens: 1200,
      ms: 4000,
      phases: { prepareMs: 12_000, modelMs: 90_000, proofsMs: 8000 },
    },
  );
  assert.match(
    telemetryText(item, "Work Item reduce"),
    /Reviewer: 1 review, verdicts 1 pass, 4 suspect, 0 question, suspicions 4 raised, 1 proved, 3 dropped \(proofs 900 tokens\), repros 1 confirmed, 1 dropped, 1 question, 1,200 tokens/,
  );
});
