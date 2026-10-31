// Per-Work-Item telemetry (#2278): one synthetic run log folded per item,
// and every view of it (the Work Item comment, the Objective's table and
// run details, the PR body's summary line and `factory status ISSUE
// --item ID`) showing the log's sums. Fields a provider doesn't report
// show as "not reported", never 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidateChanges, pullRequestBody } from "../dist/delivery.js";
import {
  ItemTelemetries,
  summaryLine,
  telemetryMarkdown,
} from "../dist/item-telemetry.js";
import { mark } from "../dist/markdown.js";
import { RunTally, statusComment } from "../dist/progress.js";
import { track, trackingDue } from "../dist/tracking.js";
import {
  cli,
  installation,
  item,
  plan,
  REPO,
  refusal,
  seed,
  tempDir,
} from "./helpers.mjs";

const ISSUE = 70;
const STARTED = "2026-03-01T10:00:00.000Z";
const FILE = "2026-03-01T10-00-00-000Z-4242.jsonl";
/** What no GitHub view may show: a worker's last command and a repair's finding. */
const PRIVATE = ["cat private-output.txt", "FAILED tail of the test output"];

const at = (minutes, seconds = 0) =>
  new Date(
    Date.parse(STARTED) + minutes * 60_000 + seconds * 1000,
  ).toISOString();

/** A step attempt: its start and outcome, `between` logged in between. */
function attempt(id, phase, n, from, to, outcome = "done", between = []) {
  const step = `item:${id}:${phase}`;
  const attemptId = `${step}#${n}`;
  return [
    { at: from, step, attemptId, event: "start" },
    ...between.map((event) => ({ step, attemptId, ...event })),
    { at: to, step, attemptId, event: "outcome", ...outcomeOf(outcome) },
  ];
}
const outcomeOf = (outcome) =>
  typeof outcome === "string" ? { outcome } : outcome;

const tokens = (input, output, cached, cacheWrite, reasoning) => ({
  input,
  output,
  cached,
  cacheWrite,
  reasoning,
  total: input + output,
});

/** A Codex call's `model-usage`: reasoning and child threads reported, cost not. */
function codex(when, role, own, children, tools) {
  return {
    at: when,
    event: "model-usage",
    callId: `codex-${when}`,
    role,
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    tokens: own,
    childTokens: children,
    costUsd: null,
    sdkOperations: { total: 3, byName: { command_execution: 3 } },
    nativeToolActivity: {
      total: Object.values(tools).reduce((a, b) => a + b, 0),
      byName: tools,
    },
    outcome: "finished",
    ms: 60_000,
  };
}

/** A Claude call's `model-usage`: cost and cache writes reported; reasoning and child threads not. */
function claude(when, role, own, costUsd, tools) {
  return {
    at: when,
    event: "model-usage",
    callId: `claude-${when}`,
    role,
    provider: "claude",
    model: "claude-opus-5",
    effort: "high",
    tokens: own,
    childTokens: null,
    costUsd,
    sdkOperations: null,
    nativeToolActivity: {
      total: Object.values(tools).reduce((a, b) => a + b, 0),
      byName: tools,
    },
    outcome: "finished",
    ms: 30_000,
  };
}

const activity = (when, item, counts) => ({
  at: when,
  event: "worker-activity",
  item,
  counts: {
    turns: 0,
    edits: 0,
    commands: 0,
    commandsFailed: 0,
    toolsStarted: 0,
    toolsFinished: 0,
    compactions: 0,
    ...counts,
  },
  tools: ["shell"],
  paths: [],
  command: PRIVATE[0],
});

const validation = (when, command, passed, durationMs) => ({
  at: when,
  event: "validation-result",
  command,
  passed,
  exitCode: passed ? 0 : 1,
  durationMs,
});

/**
 * The fixture run: `a` built by a Codex worker, sent back once by its
 * validation and merged after three CI attempts; `b` built by a Claude
 * worker and merged the first time; `c` still at work; one planning call.
 */
function fixture() {
  return [
    { at: at(-5), event: "model-usage", role: "planner", tokens: { total: 9 } },
    {
      at: at(0),
      step: "plan:1:1",
      event: "model-usage",
      role: "planner",
      provider: "codex",
      tokens: tokens(40_000, 10_000, 30_000, null, 2_000),
    },
    ...attempt("a", "work", 1, at(0), at(10), "done", [
      activity(at(1), "a", { turns: 3, commands: 10, commandsFailed: 1 }),
      codex(
        at(9),
        "worker",
        tokens(1_000_000, 20_000, 900_000, null, 5_000),
        { ...tokens(190_000, 10_000, 150_000, null, 1_000), threads: 2 },
        { exec: 10, apply_patch: 2 },
      ),
      activity(at(9, 30), "a", { turns: 2, commands: 5 }),
    ]),
    ...attempt(
      "a",
      "validate",
      1,
      at(10),
      at(12),
      { outcome: "repair", target: "item:a:work", finding: PRIVATE[1] },
      [validation(at(12), "npm test", false, 120_000)],
    ),
    ...attempt("a", "work", 2, at(12), at(20), "done", [
      codex(
        at(20),
        "worker",
        tokens(500_000, 10_000, 480_000, null, 2_000),
        null,
        { exec: 4 },
      ),
      activity(at(20), "a", { turns: 2, commands: 4 }),
    ]),
    ...attempt("a", "validate", 2, at(20), at(22, 30), "done", [
      validation(at(22), "npm test", true, 110_000),
      validation(at(22, 30), "npm run lint", true, 20_000),
    ]),
    ...attempt("a", "review", 1, at(22, 30), at(25), "done", [
      codex(
        at(25),
        "reviewer",
        tokens(200_000, 5_000, 150_000, null, 1_000),
        null,
        { exec: 3 },
      ),
    ]),
    ...attempt("a", "publish", 1, at(25), at(25, 10), "done", [
      {
        at: at(25, 10),
        event: "published",
        item: "a",
        pr: 12,
        head: "c0ffee",
        changes: {
          commit: "c0ffee0000000000000000000000000000000000",
          count: 3,
          files: [
            { path: "src/a.ts", added: 40, removed: 2 },
            { path: "test/a.test.ts", added: 25, removed: 0 },
            { path: "assets/logo.png", added: null, removed: null },
          ],
          tests: ["test/a.test.ts"],
        },
      },
    ]),
    ...attempt("a", "ci", 1, at(25, 10), at(26, 10), "retry"),
    ...attempt("a", "ci", 2, at(26, 10), at(27, 10), "retry"),
    ...attempt("a", "ci", 3, at(27, 10), at(28, 10), "done"),
    ...attempt("a", "merge", 1, at(28, 10), at(28, 20), "done"),
    ...attempt("b", "work", 1, at(30), at(35), "done", [
      activity(at(34), "b", { turns: 4, edits: 3, commands: 2 }),
      claude(
        at(35),
        "worker",
        tokens(300_000, 8_000, 250_000, 20_000, null),
        1.25,
        { Read: 4, Edit: 3, Bash: 2 },
      ),
    ]),
    ...attempt("b", "validate", 1, at(35), at(36), "done", [
      validation(at(36), "npm test", true, 50_000),
    ]),
    ...attempt("b", "review", 1, at(36), at(38), "done", [
      claude(
        at(38),
        "reviewer",
        tokens(100_000, 2_000, 80_000, 5_000, null),
        0.4,
        { Read: 2 },
      ),
    ]),
    ...attempt("b", "publish", 1, at(38), at(38, 30)),
    ...attempt("b", "ci", 1, at(38, 30), at(39, 30)),
    ...attempt("b", "merge", 1, at(39, 30), at(40)),
    {
      at: at(41),
      step: "item:c:work",
      attemptId: "item:c:work#1",
      event: "start",
    },
    activity(at(42), "c", { turns: 1 }),
  ];
}

/** The fixture as the run's log file of a fresh installation. */
function logged(events = fixture()) {
  const inst = installation();
  const dir = join(inst.logs, String(ISSUE));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, FILE),
    events
      .map((event, index) => JSON.stringify({ seq: index + 1, ...event }))
      .join("\n")
      .concat("\n"),
  );
  return inst;
}

/** The Objective's state: `a`, `b` and `d` merged (`d` in the run before), `c` at work. */
function stateOf() {
  const merged = (id, pr) => ({
    [`item:${id}:publish`]: { pr },
    [`item:${id}:merge`]: {
      mergeSha: "5".repeat(40),
      integratedSha: "5".repeat(40),
      at: at(40),
    },
  });
  const recorded = (issue, fields = {}) => ({
    issue,
    id: 900 + issue,
    body: "as created",
    labels: [],
    parent: true,
    blockedBy: [],
    comment: "as last written",
    ...fields,
  });
  return {
    version: 9,
    issue: ISSUE,
    status: "building",
    holds: [],
    answers: {},
    retries: {},
    repairs: {
      "item:a:work": {
        count: 1,
        findings: [PRIVATE[1]],
        from: "item:a:validate",
      },
    },
    kept: {},
    done: {
      predecessors: { predecessors: [], ignored: [] },
      plan: plan([item("a"), item("b"), item("c"), item("d")]),
      ...merged("a", 12),
      ...merged("b", 13),
      ...merged("d", 9),
    },
    attempts: { "item:c:work": { startedAt: at(41), id: "item:c:work#1" } },
    appliedRequests: [],
    modules: {
      github: {
        itemId: "I_70",
        commentsSince: STARTED,
        tracking: {
          items: {
            a: recorded(71),
            b: recorded(72),
            c: recorded(73),
            // Merged and closed by the run before: its final comment stays.
            d: recorded(74, { closed: true, comment: "final, from before" }),
          },
          objective: { priority: [] },
          untyped: true,
          project: null,
        },
      },
    },
    startedAt: STARTED,
    updatedAt: STARTED,
  };
}

test("each Work Item's telemetry is the sum of its own events this run, as of its last finished step", () => {
  const inst = logged();
  const tally = new RunTally(inst.logs);
  const { items, calls } = tally.read(ISSUE, STARTED);
  // `c` has finished no step: nothing settled yet. The call before the run is left out.
  assert.deepEqual(Object.keys(items).sort(), ["a", "b"]);
  assert.deepEqual(calls, {
    planner: 3,
    worker: 3,
    tokens: 50_000 + 1_735_000 + 410_000,
    items: 1_735_000 + 410_000,
  });
  const { a, b } = items;
  assert.equal(a.from, at(0));
  assert.equal(a.to, at(28, 20));
  assert.equal(a.calls, 3);
  assert.deepEqual(a.roles, {
    worker: { calls: 2, models: ["codex gpt-6.1-sol high"] },
    reviewer: { calls: 1, models: ["codex gpt-6.1-sol high"] },
  });
  assert.deepEqual(a.tokens, {
    input: { sum: 1_700_000, calls: 3 },
    output: { sum: 35_000, calls: 3 },
    cached: { sum: 1_530_000, calls: 3 },
    cacheWrite: { sum: 0, calls: 0 },
    reasoning: { sum: 8_000, calls: 3 },
    total: { sum: 1_735_000, calls: 3 },
  });
  assert.deepEqual(a.childTokens, { sum: 200_000, calls: 3, threads: 2 });
  assert.deepEqual(a.costUsd, { sum: 0, calls: 0 });
  assert.deepEqual(a.tools, { byName: { exec: 17, apply_patch: 2 }, calls: 3 });
  assert.deepEqual(a.activity, {
    turns: 7,
    toolsStarted: 0,
    toolsFinished: 0,
    edits: 0,
    commands: 19,
    commandsFailed: 1,
    compactions: 0,
  });
  assert.deepEqual(a.validation, {
    "npm test": { runs: 2, failed: 1, ms: 230_000 },
    "npm run lint": { runs: 1, failed: 0, ms: 20_000 },
  });
  assert.deepEqual(a.repairs, [{ from: "validate", target: "work" }]);
  assert.deepEqual(a.reviews, { accepted: 1 });
  assert.deepEqual(a.ci, { attempts: 3, polls: 2, reruns: 0 });
  assert.deepEqual(a.stages.work, {
    attempts: 2,
    ms: 18 * 60_000,
    outcomes: { done: 2 },
  });
  assert.equal(a.stages.ci.ms, 3 * 60_000);
  assert.equal(a.changes.count, 3);
  assert.deepEqual(a.changes.tests, ["test/a.test.ts"]);
  // The Claude-built item: cost and cache writes reported; reasoning and
  // child threads not, so never counted as 0.
  assert.equal(b.tokens.total.sum, 410_000);
  assert.deepEqual(b.tokens.reasoning, { sum: 0, calls: 0 });
  assert.deepEqual(b.tokens.cacheWrite, { sum: 25_000, calls: 2 });
  assert.equal(b.costUsd.calls, 2);
  assert.ok(Math.abs(b.costUsd.sum - 1.65) < 1e-9);
  assert.deepEqual(b.childTokens, { sum: 0, calls: 0, threads: 0 });
  assert.deepEqual(b.repairs, []);
  assert.equal(
    summaryLine(a),
    "28 min · 1,735,000 tokens · 3 model calls · 1 repair",
  );
  assert.equal(
    summaryLine(b),
    "10 min · 410,000 tokens · 2 model calls · 0 repairs",
  );
  // The running item is in the live view only, with its running step.
  const live = tally.live(ISSUE);
  assert.equal(live.c.stages.work.running, at(41));
  assert.deepEqual(live.a, a);
});

test("a settled view moves at a step's end, not with a worker's report or a CI poll", () => {
  const fold = new ItemTelemetries();
  const events = fixture().filter(
    (event) => event.at && event.at <= at(26, 10),
  );
  for (const event of events) fold.add(event);
  const ci = fold.settledItems().a;
  // Settled at the publish step's end: the CI poll is live only.
  assert.equal(ci.to, at(25, 10));
  assert.equal(ci.ci.polls, 0);
  assert.equal(fold.liveItems().a.ci.polls, 1);
  fold.add(activity(at(26, 20), "a", { turns: 5 }));
  assert.deepEqual(fold.settledItems().a, ci);
  assert.equal(fold.liveItems().a.activity.turns, 12);
});

test("the Work Item comment shows its telemetry in a summary line and a details block, with nothing private, and a closed issue from the run before keeps its comment", async () => {
  const inst = logged();
  const { items: telemetry } = new RunTally(inst.logs).read(ISSUE, STARTED);
  const state = stateOf();
  const comments = new Map();
  const github = {
    repository: REPO,
    owner: REPO.split("/")[0],
    name: REPO.split("/")[1],
    rest: async () => ({}),
    graphqlPartial: async () => ({
      data: { repository: { issueTypes: { nodes: [] } } },
    }),
    editIssue: async () => {},
    closeIssue: async () => {},
    upsertComment: async (_on, marker, body) => {
      comments.set(marker, body);
      return {};
    },
  };
  await track({
    github,
    state: () => state,
    issueType: { objective: "Objective", workItem: "Task" },
    save: (change) => change(state.modules.github.tracking),
    log: () => {},
    signal: new AbortController().signal,
    telemetry,
  });
  const a = comments.get(mark(ISSUE, "item-status", "a"));
  assert.match(
    a,
    /\*\*Telemetry:\*\* 28 min · 1,735,000 tokens · 3 model calls · 1 repair\n\n<details><summary>Telemetry details<\/summary>\n/,
  );
  for (const line of [
    "- **Time:** 28 min in all; work 18 min (2 attempts), validate 4 min (2 attempts), review 2 min, publish 10 s, CI 3 min (3 attempts, 2 polls), merge 10 s",
    "- **Model calls:** reviewer 1 (`codex gpt-6.1-sol high`), worker 2 (`codex gpt-6.1-sol high`)",
    "- **Tokens:** 1,735,000 in all, input 1,700,000, cached 1,530,000, 90% of input, cache writes not reported, output 35,000, reasoning 8,000, child threads 200,000 by 2 threads",
    "- **Cost:** not reported",
    "- **Tool calls:** 19: `exec` 17, `apply_patch` 2",
    "- **Worker:** 7 turns, 19 commands (1 failed), 0 edits by edit tools, 0 compactions",
    "- **Validation:** 3 runs, 1 failed, 4 min: `npm run lint` 1 in 20 s; `npm test` 2 (1 failed) in 3 min",
    "- **Repairs:** 1: validate sent work back",
    "- **Review:** 1 accepted",
    "- **CI:** 3 attempts, 2 polls, 0 reruns of failed jobs",
    "- **Changes:** 3 files, +65 -2 lines in `c0ffee000000`",
    "  - `src/a.ts` +40 -2",
    "  - `assets/logo.png` binary",
    "- **Tests added or changed:** `test/a.test.ts`",
  ])
    assert.ok(a.includes(line), `${line}\nnot in:\n${a}`);
  const b = comments.get(mark(ISSUE, "item-status", "b"));
  assert.match(
    b,
    /\*\*Telemetry:\*\* 10 min · 410,000 tokens · 2 model calls · 0 repairs/,
  );
  for (const line of [
    "- **Cost:** $1.65",
    "cache writes 25,000",
    "reasoning not reported, child threads not reported",
    "- **Tool calls:** 11: `Read` 6, `Edit` 3, `Bash` 2",
    "- **Changes:** not published yet",
  ])
    assert.ok(b.includes(line), `${line}\nnot in:\n${b}`);
  // `c` has finished no step: no telemetry yet.
  assert.doesNotMatch(
    comments.get(mark(ISSUE, "item-status", "c")),
    /Telemetry/,
  );
  assert.ok(!comments.has(mark(ISSUE, "item-status", "d")));
  for (const body of comments.values())
    for (const text of PRIVATE) assert.ok(!body.includes(text), text);
  // Written, the pass is done: nothing due with the same telemetry.
  assert.equal(trackingDue(state, Date.now(), telemetry), false);
  assert.equal(
    state.modules.github.tracking.items.d.comment,
    "final, from before",
  );
});

test("the Objective's table shows each item's tokens and wall time, and the run details planner tokens apart from item tokens", () => {
  const inst = logged();
  const read = new RunTally(inst.logs).read(ISSUE, STARTED);
  const row = (id, phase, pr, repairs, running = false) => ({
    id,
    kind: "work",
    phase,
    running,
    pr,
    repairs,
    hold: null,
  });
  const { body } = statusComment(
    "<!-- marker -->",
    {
      view: {
        issue: ISSUE,
        status: "building",
        phase: "building",
        mode: "running",
        holds: [],
        items: [
          row("a", "merged", 12, 1),
          row("b", "merged", 13, 0),
          row("c", "work (running)", null, 0, true),
        ],
        waiting: [],
        waitsOn: null,
        running: [],
        flakyRerun: [],
        decisions: [],
        nextAction: { reason: "Factory is building." },
      },
      ...read,
      decisions: [],
    },
    [],
    { questions: true },
    Date.now(),
  );
  assert.match(
    body,
    /\| Work Item \| Kind \| Phase \| PR \| Repairs \| Tokens \| Time \| Question \|/,
  );
  assert.match(
    body,
    /\| `a` \| work \| merged \| #12 \| 1 \| 1\.7M \| 28 min \| - \|/,
  );
  assert.match(
    body,
    /\| `b` \| work \| merged \| #13 \| 0 \| 410K \| 10 min \| - \|/,
  );
  assert.match(
    body,
    /\| `c` \| work \| work \(running\) \| - \| 0 \| - \| - \| - \|/,
  );
  assert.match(
    body,
    /- Model calls so far: 6 \(planner 3, worker 3\), 2195000 tokens reported: 2145000 by Work Items, 50000 outside them \(planning, plan and final review, Dream\)/,
  );
});

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("the PR body carries the item's summary line under its changes, and the candidate's changes count lines per file", async () => {
  const tree = tempDir("factory-telemetry-tree-");
  git(tree, "init", "--quiet");
  const commit = () => {
    git(tree, "add", "-A");
    git(
      tree,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "-m",
      "c",
    );
    return git(tree, "rev-parse", "HEAD");
  };
  writeFileSync(join(tree, "a.ts"), "one\ntwo\n");
  const base = commit();
  writeFileSync(join(tree, "a.ts"), "one\n2\n3\n");
  mkdirSync(join(tree, "test"));
  writeFileSync(join(tree, "test", "a.test.ts"), "t\n");
  writeFileSync(join(tree, "logo.png"), Buffer.from([0, 1, 2, 0, 255]));
  const head = commit();
  const context = {
    github: { repository: REPO },
    checkout: tree,
    signal: new AbortController().signal,
  };
  assert.deepEqual(await candidateChanges(context, base, head), [
    { path: "a.ts", added: 2, removed: 1 },
    { path: "logo.png", added: null, removed: null },
    { path: "test/a.test.ts", added: 1, removed: 0 },
  ]);
  const inst = logged();
  const { a } = new RunTally(inst.logs).read(ISSUE, STARTED).items;
  const body = await pullRequestBody(context, {
    issue: ISSUE,
    item: item("a"),
    base,
    commit: head,
    tree: "t",
    pushedHeads: [],
    validation: { commands: ["npm test"] },
    secrets: [],
    telemetry: summaryLine(a),
  });
  assert.match(
    body,
    /Changes in this candidate:\n\n- Updates <code>a\.ts<\/code>\n- Adds <code>logo\.png<\/code>\n- Adds <code>test\/a\.test\.ts<\/code>\n\nWork Item telemetry before publishing: 28 min · 1,735,000 tokens · 3 model calls · 1 repair\.\n\nController validation passed/,
  );
});

test("factory status ISSUE --item ID prints the same breakdown from the local log, and --json its numbers", () => {
  const inst = logged();
  seed(inst, ISSUE, "building", stateOf());
  const shown = cli(inst, "status", String(ISSUE), "--item", "a");
  assert.equal(shown.code, 0, shown.err);
  const lines = shown.out.split("\n");
  assert.equal(
    lines[0],
    "Work Item a of #70: merged · 28 min · 1,735,000 tokens · 3 model calls · 1 repair",
  );
  for (const line of [
    "  Time: 28 min in all; work 18 min (2 attempts), validate 4 min (2 attempts), review 2 min, publish 10 s, CI 3 min (3 attempts, 2 polls), merge 10 s",
    "  Model calls: reviewer 1 (codex gpt-6.1-sol high), worker 2 (codex gpt-6.1-sol high)",
    "  Tokens: 1,735,000 in all, input 1,700,000, cached 1,530,000, 90% of input, cache writes not reported, output 35,000, reasoning 8,000, child threads 200,000 by 2 threads",
    "  Cost: not reported",
    "  Validation: 3 runs, 1 failed, 4 min: npm run lint 1 in 20 s; npm test 2 (1 failed) in 3 min",
    "  Changes: 3 files, +65 -2 lines in c0ffee000000",
    "    test/a.test.ts +25 -0",
    "  Tests added or changed: test/a.test.ts",
  ])
    assert.ok(lines.includes(line), `${line}\nnot in:\n${shown.out}`);
  const json = JSON.parse(
    cli(inst, "status", String(ISSUE), "--item", "b", "--json").out,
  );
  assert.equal(json.phase, "merged");
  assert.equal(json.telemetry.tokens.total.sum, 410_000);
  assert.deepEqual(json.telemetry.tokens.reasoning, { sum: 0, calls: 0 });
  // A running item shows its step running.
  assert.match(
    cli(inst, "status", String(ISSUE), "--item", "c").out,
    /Time: 1 min in all; work 0 s, running since /,
  );
  const unknown = cli(inst, "status", String(ISSUE), "--item", "zz");
  assert.equal(refusal(unknown), "no_factory_state");
  assert.equal(cli(inst, "status", "--item", "a").code, 2);
});

test("a long-running item's comment stays well under GitHub's comment limit", () => {
  const fold = new ItemTelemetries();
  const long = (prefix, n) => `${prefix}-${n}-${"x".repeat(400)}`;
  const step = "item:big:work";
  for (let n = 0; n < 300; n++) {
    fold.add({
      at: at(n * 10),
      step,
      attemptId: `${step}#${n}`,
      event: "start",
    });
    fold.add({
      ...codex(
        at(n * 10 + 5),
        `role-${n % 40}`,
        tokens(1_000_000, 1_000, 900_000, null, 10),
        null,
        Object.fromEntries(
          Array.from({ length: 20 }, (_, k) => [long(`tool${n}`, k), 1]),
        ),
      ),
      step,
      model: long("model", n),
    });
    for (let k = 0; k < 5; k++)
      fold.add({
        ...validation(at(n * 10 + 6), long("command", n * 5 + k), false, 1_000),
        step,
      });
    fold.add({
      at: at(n * 10 + 9),
      step,
      event: "outcome",
      outcome: "repair",
      target: step,
    });
  }
  fold.add({
    at: at(3_001),
    step: "item:big:publish",
    event: "published",
    item: "big",
    changes: {
      commit: "f".repeat(40),
      count: 5_000,
      files: Array.from({ length: 200 }, (_, n) => ({
        path: long("src/file", n),
        added: n,
        removed: n,
      })),
      tests: Array.from({ length: 200 }, (_, n) => long("test/file", n)),
    },
  });
  fold.add({
    at: at(3_002),
    step: "item:big:publish",
    event: "outcome",
    outcome: "done",
  });
  const body = telemetryMarkdown(fold.settledItems().big).join("\n\n");
  assert.ok(body.length < 25_000, `${body.length} characters`);
  assert.match(body, /\+\d+ more/);
});
