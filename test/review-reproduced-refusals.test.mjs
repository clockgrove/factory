// clockgrove/factory#2344: a Work Item's result review refuses only with a
// failure Factory reproduces. On one recorded item the reviewer refused 4
// times to find 1 real bug: over a test it judged weak, a behaviour the
// plan never defined, and assertions it found under another validation
// command than the plan named. These are the PRD's acceptance tests, on
// real Git repositories and the real sandbox, the reviewer's answers
// given as fixtures at the planner seam.
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
  ITEM_REVIEW_SCHEMA,
  itemInstructions,
  reviewCandidate,
  reviewResult,
  validationScratch,
} from "../dist/review/item.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { validateTree } from "../dist/validate.js";
import { withRepros } from "../dist/work/repros.js";
import { REFUSES_ITEM, reviewOutcome } from "../dist/work/step-review.js";
import { configured, installation, item, REPO, tempDir } from "./helpers.mjs";

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

/** A target whose candidate adds the reducer and its test. */
function target(reducer = REDUCER) {
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
  const base = commit({ "package.json": '{"type":"module"}\n' });
  const head = commit({
    "src/reduce.js": reducer,
    "test/reduce.test.js": TEST,
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

/** One review of the candidate with `planner`, its events logged. */
function review(repo, planner, extra = {}) {
  const { work, validation } = setup(repo);
  const events = [];
  const scratch = validationScratch(
    validation(repo.head),
    (name) => `${repo.checkout}.${name}`,
  );
  return {
    events,
    run: reviewCandidate({
      planner,
      checkout: repo.checkout,
      base: repo.base,
      commit: repo.head,
      criteria: work.acceptance,
      validation: { tree: repo.tree, commands: COMMANDS },
      scratch,
      itemId: work.id,
      commandMs: 60_000,
      dir: tempDir("factory-repro-review-"),
      signal: AbortSignal.timeout(120_000),
      log: (event) => events.push({ step: "item:reduce:review", ...event }),
      ...extra,
    }),
  };
}

const pass = (criterionIndex, detail = "met") => ({
  criterionIndex,
  verdict: "pass",
  detail,
  evidenceIndices: [],
});
const refuse = (criterionIndex, command, actual) => ({
  criterionIndex,
  verdict: "refuse",
  detail: "A late snapshot discards a received patch.",
  evidenceIndices: [],
  repro: {
    input: "patch v2 (b), then snapshot v1 (a)",
    expected: 'items: ["a","b"]',
    actual,
    command,
  },
});

/** A planner whose answers are `answers`, in order; it records each call. */
function answering(...answers) {
  const calls = [];
  return {
    calls,
    async answer(call) {
      calls.push(call);
      const next = answers[calls.length - 1];
      return { value: typeof next === "function" ? await next(call) : next };
    },
  };
}

test("R1: a refusal without a repro is invalid, asked again once, and ends as a note with no repair", async () => {
  const refuses = ITEM_REVIEW_SCHEMA.properties.findings.items.anyOf.find(
    (variant) => variant.properties.verdict.enum[0] === "refuse",
  );
  assert.ok(refuses.required.includes("repro"));
  assert.deepEqual(refuses.properties.repro.required, [
    "input",
    "expected",
    "actual",
    "command",
  ]);
  const repo = target();
  const bare = { ...refuse(0, REPRO, "x"), repro: undefined };
  const planner = answering(
    { findings: [bare, pass(1)] },
    { findings: [bare] },
  );
  const outcome = await review(repo, planner).run;
  assert.equal(planner.calls.length, 2);
  assert.match(planner.calls[1].prompt, /criteria 0 without a valid finding/);
  assert.equal(outcome.kind, "pass");
  assert.deepEqual(
    outcome.verdicts.map((verdict) => verdict.verdict),
    ["note", "pass"],
  );
});

test("R1 (#2341): an answer missing a criterion keeps its verdicts and asks only for that one", async () => {
  const repo = target();
  const planner = answering({ findings: [pass(1)] }, { findings: [pass(0)] });
  const outcome = await review(repo, planner).run;
  assert.equal(planner.calls.length, 2);
  assert.match(
    planner.calls[1].prompt,
    /Give one finding for each of criteria 0 only/,
  );
  assert.equal(outcome.kind, "pass");
  assert.equal(outcome.verdicts.length, 2);
});

test("R2: a repro that passes on the candidate is dropped, one that fails as claimed is confirmed", {
  skip,
}, async () => {
  const repo = target();
  const planner = answering({
    findings: [
      refuse(0, REPRO, 'items: ["a"]'),
      refuse(1, "node -e 'console.log(\"fine\")'", "fine"),
    ],
  });
  const { run, events } = review(repo, planner);
  const outcome = await run;
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(
    outcome.refused.map((entry) => entry.criterionIndex),
    [0],
  );
  assert.equal(outcome.refused[0].repro.command, REPRO);
  assert.deepEqual(
    events
      .filter((event) => event.event === "result-review-repro")
      .map(({ criterionIndex, confirmed, reason }) => ({
        criterionIndex,
        confirmed,
        reason,
      })),
    [
      { criterionIndex: 0, confirmed: true, reason: undefined },
      { criterionIndex: 1, confirmed: false, reason: "it exited 0" },
    ],
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
  // A refusal whose command fails for another reason than the claimed one is dropped too.
  const wrong = answering({
    findings: [refuse(0, REPRO, 'items: ["z"]'), pass(1)],
  });
  assert.equal((await review(repo, wrong).run).kind, "pass");
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
            repro: refuse(0, REPRO, 'items: ["a"]').repro,
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

test("R4: the reviewer runs a test in its scratch copy and cites its output; the network is refused as in validation", {
  skip,
}, async () => {
  const repo = target();
  const fetch =
    'node -e \'fetch("http://example.com").then(() => process.exit(0), () => { console.log("no network"); process.exit(7); })\'';
  let ran;
  let offline;
  const planner = answering(async (call) => {
    ran = await call.commands.run("node test/reduce.test.js && echo tested");
    offline = await call.commands.run(fetch);
    // The scratch is a copy: a write there never reaches the candidate.
    await call.commands.run("echo changed > src/reduce.js");
    return {
      findings: [pass(0, `The test ran: ${ran.split("\n")[1]}`), pass(1)],
    };
  });
  const { run, events } = review(repo, planner);
  const outcome = await run;
  assert.match(ran, /^Exit code 0 .*\ntested/);
  assert.match(offline, /^Exit code 7 .*\nno network/);
  assert.equal(outcome.kind, "pass");
  assert.equal(outcome.verdicts[0].detail, "The test ran: tested");
  assert.equal(git(repo.checkout, "rev-parse", "HEAD^{tree}"), repo.tree);
  assert.equal(
    events.find((event) => event.event === "result-review").commands,
    3,
  );
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

test("R6: any command the item's validation runs proves any criterion; the plan's command binding never reaches the review", async () => {
  const repo = target();
  const { work, plan } = setup(repo);
  const bound = {
    ...plan,
    coverage: [
      {
        itemId: "reduce",
        source: {
          path: "OBJECTIVE",
          heading: "Acceptance",
          text: "Patches survive a late snapshot.",
        },
        proof: { kind: "result-command", validationIndex: 0 },
      },
    ],
  };
  const planner = answering({
    findings: [
      pass(0, "Asserted under validation command 1, which passed."),
      pass(1),
    ],
  });
  const outcome = await reviewResult({
    planner,
    plan: bound,
    item: work,
    checkout: repo.checkout,
    base: repo.base,
    commit: repo.head,
    validation: { tree: repo.tree, commands: COMMANDS },
    sources: [],
    scratch: async () => {
      throw new Error("this review runs no command");
    },
    commandMs: 60_000,
    dir: tempDir("factory-repro-review-"),
    signal: AbortSignal.timeout(60_000),
    log: () => {},
  });
  assert.equal(outcome.kind, "pass");
  const { prompt } = planner.calls[0];
  const { criteria } = JSON.parse(
    prompt.split("\n").find((line) => line.startsWith('{"criteria"')),
  );
  assert.deepEqual(
    criteria.map((entry) => entry.criterion),
    CRITERIA,
  );
  assert.ok(!prompt.includes("Command-proven"));
});

test("R7: every review is a fresh call, and a re-review's packet holds the confirmed refusals and the repair's diff", async () => {
  const repo = target();
  const first = answering({ findings: [pass(0), pass(1)] });
  await review(repo, first).run;
  const repaired = repo.commit({ "src/reduce.js": `${REDUCER}// repaired\n` });
  const second = answering({ findings: [pass(0), pass(1)] });
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
    scratch: async () => {
      throw new Error("this review runs no command");
    },
    itemId: work.id,
    prior: {
      tree: repo.tree,
      refused: [
        {
          criterion: CRITERIA[0],
          detail: "A late snapshot discards a received patch.",
          repro: refuse(0, REPRO, 'items: ["a"]').repro,
        },
      ],
    },
    commandMs: 60_000,
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
  const planner = answering({
    findings: [
      {
        criterionIndex: 0,
        verdict: "question",
        detail: "The plan doesn't say what a dropped final patch should do.",
        evidenceIndices: [],
        question:
          "Should a missing final patch request recovery, or end at the delivered prefix?",
      },
      {
        criterionIndex: 1,
        verdict: "question",
        detail: "Duplicate patches are not defined.",
        evidenceIndices: [],
        question: "Should a duplicate patch be applied twice?",
      },
    ],
  });
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

test("R9: the assembled instructions, with every evidence kind's guidance and the command tool, fit in 5,000 characters", () => {
  const all = itemInstructions({
    unreachable: true,
    artifacts: true,
    candidates: true,
    inputs: true,
    knowledge: true,
    memory: true,
  });
  const size = all.length + commandToolDescription(1_800_000).length;
  assert.ok(size <= 5000, `${size} characters`);
  assert.match(
    all,
    /the engineering standard, test economy and the design checklist are notes, never refusals/,
  );
});

test("R11: the item's telemetry shows the reviews' verdicts, repros, mutants, questions, tokens and time, as text and JSON", () => {
  const telemetry = new ItemTelemetries();
  const at = "2026-01-01T00:00:00.000Z";
  for (const event of [
    { event: "start", step: "item:reduce:review", at },
    {
      event: "mutation-pass",
      step: "item:reduce:validate",
      status: "done",
      seeded: 6,
      killed: 4,
      survived: 2,
      at,
    },
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
      verdicts: { pass: 1, refuse: 2, question: 0, note: 1 },
      repros: { confirmed: 1, dropped: 1 },
      questions: 0,
      commands: 3,
      ms: 4000,
      at,
    },
  ])
    telemetry.add(event);
  const item = telemetry.liveItems().reduce;
  assert.deepEqual(
    {
      verdicts: item.reviewer.verdicts,
      repros: item.reviewer.repros,
      mutants: item.reviewer.mutants,
      tokens: item.reviewer.tokens.sum,
      ms: item.reviewer.ms,
    },
    {
      verdicts: { pass: 1, refuse: 2, question: 0, note: 1 },
      repros: { confirmed: 1, dropped: 1 },
      mutants: { status: "done", seeded: 6, killed: 4, survived: 2 },
      tokens: 1200,
      ms: 4000,
    },
  );
  assert.match(
    telemetryText(item, "Work Item reduce"),
    /Reviewer: 1 review, verdicts 1 pass, 2 refuse, 0 question, 1 note, repros 1 confirmed, 1 dropped, 0 questions, 3 commands, 6 mutants seeded, 4 killed, 2 survived, 1,200 tokens/,
  );
});
