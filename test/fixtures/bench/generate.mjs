#!/usr/bin/env node
/**
 * The bench tests' fixture: an invented Objective, acme/widgets#42, as
 * Factory's state and run log would hold it after it ended. Everything in
 * it is made up: the repository, the Objective, its Work Items, criteria,
 * paths and commands, the operator, thread ids, heads and times. It has
 * only the events and fields the scorer reads, and every case the tests
 * need:
 *
 * - three run files: Factory 0.5.7, then 0.5.8 twice. The first restart
 *   (run-end handed-off) aborts a model call whose tokens the spend ledger
 *   never charged; the second falls inside an operator pause.
 * - Codex worker sessions resumed on their thread, repeating their child
 *   threads' cumulative usage (`providerUsage.descendants`).
 * - holds of every kind: diagnosis, review, spend, allowance (a repair, a
 *   result rereview, planning revisions), config, CI and a read-only QA
 *   item's, each answered after a wait with nothing else running.
 * - repairs from validation, review, worker validation and a CI merge
 *   conflict with the base branch; CI reruns, a flaky check and a CI hold.
 * - amendments accepted (after a sendback), rejected and unchanged.
 * - waste: a result review a later review of the same step replaced (after
 *   a base conflict), an amendment plan its review sent back, a hedge that
 *   lost and a call the first restart cut.
 * - final review refuses the integrated result; the operator fixes the
 *   default branch by hand and answers retry; final validation and final
 *   review run again and pass.
 *
 *   node test/fixtures/bench/generate.mjs
 *
 * writes it to test/fixtures/bench/acme__widgets/ (then run `npx biome
 * format --write test/fixtures/bench`). bench-score.test.mjs checks that the
 * committed files are what this writes.
 *
 * `fixtureRepository(dir)` builds the run repository the same timeline
 * made, with Git, for the tests that read one: the base, Factory's three
 * merges, the operator's hand fix, and a commit after the Objective ended.
 * grader.mjs is the stand-in grader of its result.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE = 42;
export const REPOSITORY = "acme/widgets";
export const FIXTURE_DIR = fileURLToPath(
  new URL("./acme__widgets", import.meta.url),
);

const BASE = "0123456789abcdef0123456789abcdef01234567";
const MODEL = "gpt-test";
const OPERATOR = "operator";

/** The Objective's plan as first accepted. */
function plan(tokenizerCriteria) {
  const item = (id, kind, title, acceptance, extra) => ({
    kind,
    id,
    title,
    goal: title,
    acceptance,
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths: [],
    validation: [],
    brief: "",
    priority: 1,
    ...extra,
  });
  return {
    base: BASE,
    items: [
      item(
        "tokenizer",
        "work",
        "Tokenize widget queries",
        [
          "A query splits into field, operator and value tokens",
          "Quoted values keep their spaces",
          "An unknown operator is an error naming its position",
          "Tokens carry their source offsets",
          "An empty query yields no tokens",
        ].slice(0, tokenizerCriteria),
        {
          ownedPaths: ["src/query/tokenizer.ts", "test/tokenizer.test.ts"],
          validation: [{ command: "npm test -- tokenizer" }],
        },
      ),
      item(
        "query-api",
        "work",
        "Serve widget queries over the API",
        [
          "GET /widgets takes a q parameter",
          "A malformed q answers 400 with the tokenizer's message",
          "Results are paged 50 at a time",
          "The page cursor is opaque",
          "Queries time out after 2 seconds",
          "The OpenAPI document describes q",
        ],
        {
          dependencies: ["tokenizer"],
          ownedPaths: ["src/api/widgets.ts", "openapi.yaml"],
          validation: [{ command: "npm test -- api" }],
        },
      ),
      item(
        "export-csv",
        "work",
        "Export query results as CSV",
        [
          "GET /widgets.csv streams the same results as CSV",
          "The header row names every column",
          "Values with commas are quoted",
          "Dates are ISO 8601 in UTC",
          "An export over 10,000 rows is refused",
        ],
        {
          dependencies: ["query-api"],
          ownedPaths: ["src/api/export.ts"],
          validation: [{ command: "npm test -- export" }],
        },
      ),
      item(
        "release-smoke",
        "qa",
        "Smoke-check the release build",
        [
          "The release build starts",
          "A sample query answers",
          "A sample export downloads",
        ],
        { dependencies: ["export-csv"] },
      ),
    ],
    coverage: [],
    requiredPreIntegrationChecks: [],
    sourceExclusions: [],
    finalCommands: ["npm test", "npm run lint"],
    decisions: [],
    ownedSince: {},
  };
}

/** The fixture's files: path (under acme__widgets/) to content. */
export function fixtureFiles() {
  return fixture().files;
}

/** The fixture's files, and the times its run repository's commits were made. */
function fixture() {
  let now = Date.parse("2031-03-04T09:00:00.000Z");
  const iso = () => new Date(now).toISOString();
  const wait = (seconds) => {
    now += Math.round(seconds * 1000);
  };
  const runs = [];
  let run;
  const emit = (event, fields = {}) => {
    run.events.push({ at: iso(), seq: ++run.seq, event, ...fields });
  };
  const begin = (pid, factoryVersion) => {
    run = { name: `${iso().replace(/[:.]/g, "-")}-${pid}`, seq: 0, events: [] };
    runs.push(run);
    emit("run-header", { factoryVersion, sourceDigest: "5d".repeat(32) });
  };

  const attempts = new Map();
  const start = (step) => {
    const n = (attempts.get(step) ?? 0) + 1;
    attempts.set(step, n);
    emit("start", { step, attemptId: `${step}#${n}` });
  };
  const attemptOf = (step) => `${step}#${attempts.get(step)}`;
  const on = (step, event, fields = {}) =>
    emit(event, { step, attemptId: attemptOf(step), ...fields });
  const outcome = (step, value, extra = {}) =>
    on(step, "outcome", { outcome: value, ...extra });

  const split = (total, cachedShare) => {
    const output = Math.round(total * 0.008);
    const input = total - output;
    return {
      input,
      output,
      cached: Math.round(input * cachedShare),
      reasoning: Math.round(output * 0.4),
      total,
    };
  };
  let threads = 0;
  /** A model call that took `seconds`, logged when it ends; returns its thread. */
  const call = (step, role, phase, total, seconds, extra = {}) => {
    wait(seconds);
    const { descendants, ...rest } = extra;
    const thread = `t-${(0x5a000 + ++threads).toString(16)}`;
    const own = total === null ? null : { ...split(total, 0.9), cacheWrite: 0 };
    on(step, "model-usage", {
      role,
      provider: "codex",
      model: MODEL,
      effort: role === "planner" ? "high" : "medium",
      ...(phase ? { phase } : {}),
      tokens: own,
      ms: Math.round(seconds * 1000),
      outcome: "done",
      costUsd: null,
      sessionMode: "fresh",
      sessionTurn: 1,
      thread,
      ...(descendants
        ? {
            providerUsage: {
              descendants: {
                threads: descendants.threads,
                ...split(descendants.total, 0.92),
              },
            },
          }
        : {}),
      ...rest,
    });
    return rest.thread ?? thread;
  };
  const resumed = (thread, turn = 2) => ({
    sessionMode: "resumed",
    sessionTurn: turn,
    thread,
  });
  const worker = (item, extra = {}) => ({
    item,
    outcome: "finished",
    ...extra,
  });
  /** A hold on `step`; the step's attempt ends with it. Returns its id. */
  const hold = (step, question) => {
    const id = `${step}@${iso()}`;
    emit("hold", { step, id, cause: "question", question });
    outcome(step, "hold");
    return id;
  };
  const request = (kind, fields = {}, as) =>
    emit("request", {
      by: OPERATOR,
      ...(as ? { as } : {}),
      message: "ok",
      request: { kind, issue: ISSUE, ...fields },
    });
  const answer = (question, value, as) =>
    request("answer", { answer: value, question }, as);
  const steps = (id) => ({
    work: `item:${id}:work`,
    validate: `item:${id}:validate`,
    review: `item:${id}:review`,
    publish: `item:${id}:publish`,
    ci: `item:${id}:ci`,
    merge: `item:${id}:merge`,
  });
  const quick = (step, value = "done", seconds = 1) => {
    start(step);
    wait(seconds);
    outcome(step, value);
  };
  const merged = {};
  const proposals = {};
  const propose = (id, item) => {
    proposals[id] = {
      id,
      actor: `Work Item ${item}'s worker`,
      at: iso(),
    };
  };

  // --- run 1: Factory 0.5.7 ---------------------------------------------------
  begin(4101, "0.5.7");
  emit("request", { by: OPERATOR, request: { kind: "run", issue: ISSUE } });
  wait(4);
  emit("admitted");
  const startedAt = iso();
  wait(1);
  quick("predecessors", "done", 0.2);
  wait(0.5);
  quick("check", "done", 2.5);

  // Planning: two rounds of one generation.
  wait(0.4);
  start("plan:1:1");
  const planner = call("plan:1:1", "planner", "plan", 940_000, 312);
  outcome("plan:1:1", "done");
  wait(0.5);
  start("review:1:1");
  const planReviewer = call(
    "review:1:1",
    "reviewer",
    "graph-review",
    310_000,
    48,
  );
  outcome("review:1:1", "done");
  wait(0.3);
  quick("decide:1:1", "done", 0.2);
  wait(0.8);
  start("plan:1:2");
  call("plan:1:2", "planner", "plan", 180_000, 40, resumed(planner));
  outcome("plan:1:2", "done");
  wait(0.5);
  start("review:1:2");
  call(
    "review:1:2",
    "reviewer",
    "graph-review",
    260_000,
    35,
    resumed(planReviewer),
  );
  outcome("review:1:2", "done");
  wait(0.3);
  quick("decide:1:2", "done", 0.4);
  wait(0.5);
  const acceptedAt = iso();
  quick("plan", "done", 1.4);

  // tokenizer: an amendment accepted after a sendback, a diagnosis, an
  // allowance raise, a review hold and a review sendback; CI reruns.
  const t = steps("tokenizer");
  wait(0.5);
  start(t.work);
  const tokenizerThread = call(
    t.work,
    "worker",
    null,
    2_400_000,
    430,
    worker("tokenizer", { descendants: { threads: 2, total: 400_000 } }),
  );
  wait(1);
  outcome(t.work, "retry", { progress: true });
  const a1 = "amend:worker-tokenizer-1";
  propose("worker-tokenizer-1", "tokenizer");
  wait(0.1);
  start(`${a1}:plan`);
  const a1Planner = call(`${a1}:plan`, "planner", "plan", 120_000, 52);
  on(`${a1}:plan`, "amendment-answer", { amendment: "worker-tokenizer-1" });
  outcome(`${a1}:plan`, "done");
  wait(0.2);
  start(`${a1}:review`);
  const a1Reviewer = call(
    `${a1}:review`,
    "reviewer",
    "graph-review",
    210_000,
    38,
  );
  outcome(`${a1}:review`, "retry", { progress: true });
  wait(0.8);
  start(`${a1}:plan`);
  call(`${a1}:plan`, "planner", "plan", 95_000, 27, resumed(a1Planner));
  on(`${a1}:plan`, "amendment-answer", { amendment: "worker-tokenizer-1" });
  outcome(`${a1}:plan`, "done");
  wait(0.8);
  start(`${a1}:review`);
  call(
    `${a1}:review`,
    "reviewer",
    "graph-review",
    150_000,
    11,
    resumed(a1Reviewer),
  );
  outcome(`${a1}:review`, "done");
  wait(0.7);
  quick(a1, "done", 1.5);

  // The worker's session goes on: its children's cumulative usage repeats.
  wait(0.5);
  start(t.work);
  call(
    t.work,
    "worker",
    null,
    1_150_000,
    240,
    worker("tokenizer", {
      ...resumed(tokenizerThread),
      descendants: { threads: 2, total: 400_000 },
    }),
  );
  on(t.work, "worker-validate", { passed: false });
  wait(1);
  outcome(t.work, "repair", { target: t.work });
  wait(0.1);
  start(t.work);
  call(t.work, "planner", "diagnosis", 64_000, 35);
  const diagnosis1 = hold(
    t.work,
    "Work Item tokenizer needs your decision before it is repaired",
  );
  wait(380);
  answer(diagnosis1, "answer");
  wait(0.1);
  start(t.work);
  wait(20);
  request("decline-discovery", { item: "tokenizer" });
  call(
    t.work,
    "worker",
    null,
    980_000,
    280,
    worker("tokenizer", {
      ...resumed(tokenizerThread, 3),
      descendants: { threads: 3, total: 650_000 },
    }),
  );
  on(t.work, "worker-validate", { passed: true });
  wait(1);
  outcome(t.work, "done");
  wait(0.9);
  start(t.validate);
  wait(95);
  outcome(t.validate, "repair", { target: t.work });
  wait(0.3);
  start(t.work);
  const allowance1 = hold(
    t.work,
    "item:tokenizer:work needs another repair, past the 2 autonomy.allowances.perPath allows for src/query/tokenizer.ts",
  );
  wait(45);
  answer(allowance1, "more");
  wait(0.1);
  start(t.work);
  call(
    t.work,
    "worker",
    null,
    720_000,
    210,
    worker("tokenizer", { descendants: { threads: 1, total: 90_000 } }),
  );
  wait(1);
  outcome(t.work, "done");
  wait(1);
  start(t.validate);
  wait(88);
  outcome(t.validate, "done");
  wait(0.5);
  start(t.review);
  const tokenizerReviewer = call(
    t.review,
    "reviewer",
    "result-review",
    340_000,
    70,
  );
  const review1 = hold(
    t.review,
    "The reviewer needs your judgment on criterion 3 of tokenizer: quoted values",
  );
  wait(250);
  answer(review1, "accept");
  wait(0.1);
  start(t.review);
  call(
    t.review,
    "reviewer",
    "result-review",
    120_000,
    30,
    resumed(tokenizerReviewer),
  );
  on(t.review, "result-review", { outcome: "fail", criteria: 5 });
  outcome(t.review, "repair", { target: t.work });
  wait(0.4);
  start(t.work);
  call(t.work, "worker", null, 510_000, 160, worker("tokenizer"));
  wait(1);
  outcome(t.work, "done");
  wait(0.6);
  start(t.validate);
  wait(80);
  outcome(t.validate, "done");
  wait(0.5);
  start(t.review);
  call(t.review, "reviewer", "result-review", 200_000, 40);
  on(t.review, "result-review", { outcome: "pass", criteria: 5 });
  outcome(t.review, "done");
  wait(0.5);
  start(t.publish);
  wait(6);
  on(t.publish, "published", { item: "tokenizer", pr: 101, head: "h-0a1" });
  outcome(t.publish, "done");
  wait(0.5);
  start(t.ci);
  wait(25);
  outcome(t.ci, "retry");
  wait(20);
  start(t.ci);
  wait(4);
  on(t.ci, "ci-rerun", { item: "tokenizer", head: "h-0a1" });
  outcome(t.ci, "retry");
  wait(20);
  start(t.ci);
  wait(5);
  on(t.ci, "ci-flaky", { item: "tokenizer", head: "h-0a1" });
  outcome(t.ci, "done");
  wait(0.4);
  start(t.merge);
  wait(10);
  outcome(t.merge, "done");
  merged.tokenizer = iso();

  // query-api: a spend raise; its first push conflicts with its base.
  const q = steps("query-api");
  wait(0.6);
  start(q.work);
  const spend1 = hold(
    q.work,
    "Model spend reached 12,000,000 of the 12,000,000 tokens this Objective may spend",
  );
  wait(170);
  answer(spend1, "more");
  wait(0.1);
  start(q.work);
  const queryThread = call(
    q.work,
    "worker",
    null,
    1_900_000,
    380,
    worker("query-api", { descendants: { threads: 1, total: 300_000 } }),
  );
  on(q.work, "worker-validate", { passed: true });
  wait(1);
  outcome(q.work, "done");
  wait(0.5);
  start(q.validate);
  wait(70);
  outcome(q.validate, "done");
  wait(0.5);
  start(q.review);
  call(q.review, "reviewer", "result-review", 280_000, 55);
  on(q.review, "result-review", { outcome: "pass", criteria: 6 });
  outcome(q.review, "done");
  wait(0.5);
  start(q.publish);
  wait(5);
  on(q.publish, "published", { item: "query-api", pr: 102, head: "h-0b1" });
  outcome(q.publish, "done");
  wait(0.5);
  start(q.ci);
  wait(30);
  outcome(q.ci, "retry");
  wait(20);
  start(q.ci);
  wait(3);
  outcome(q.ci, "repair", {
    target: q.work,
    finding:
      "The pull request conflicts with its base branch: rebase it onto main",
  });
  wait(0.3);
  start(q.work);
  call(
    q.work,
    "worker",
    null,
    260_000,
    90,
    worker("query-api", {
      ...resumed(queryThread),
      descendants: { threads: 1, total: 300_000 },
    }),
  );
  wait(1);
  outcome(q.work, "done");
  wait(0.5);
  start(q.validate);
  wait(66);
  outcome(q.validate, "done");
  wait(0.5);
  start(q.review);
  call(q.review, "reviewer", "result-review", 150_000, 30);
  on(q.review, "result-review", { outcome: "pass", criteria: 6 });
  outcome(q.review, "done");
  wait(0.5);
  start(q.publish);
  wait(5);
  on(q.publish, "published", { item: "query-api", pr: 102, head: "h-0b2" });
  outcome(q.publish, "done");
  wait(0.5);
  start(q.ci);
  wait(40);
  outcome(q.ci, "retry");
  wait(20);
  start(q.ci);
  wait(5);
  outcome(q.ci, "done");
  wait(0.4);
  start(q.merge);
  wait(9);
  outcome(q.merge, "done");
  merged["query-api"] = iso();

  // export-csv starts; the service is restarted under its worker's call,
  // which logs its tokens but is never charged to the spend ledger.
  const e = steps("export-csv");
  wait(0.6);
  start(e.work);
  const replaced = 55_000;
  call(
    e.work,
    "worker",
    null,
    replaced,
    200,
    worker("export-csv", { outcome: "aborted", error: "replaced" }),
  );
  wait(2);
  emit("run-end", { outcome: "handed-off" });

  // --- run 2: Factory 0.5.8, a changed configuration, then a pause ---------
  wait(6.5);
  begin(4207, "0.5.8");
  start("config");
  wait(0.07);
  const config1 = hold(
    "config",
    "The configuration changed since this Objective froze it: provider.worker.effort",
  );
  wait(22);
  answer(config1, "adopt");
  wait(0.1);
  start(e.work);
  const exportThread = call(
    e.work,
    "worker",
    null,
    1_600_000,
    350,
    worker("export-csv", { descendants: { threads: 2, total: 520_000 } }),
  );
  wait(1);
  outcome(e.work, "retry", { progress: true });
  const a2 = "amend:worker-export-csv-1";
  propose("worker-export-csv-1", "export-csv");
  wait(0.2);
  start(`${a2}:plan`);
  call(`${a2}:plan`, "planner", "plan", 140_000, 45);
  on(`${a2}:plan`, "amendment-answer", { amendment: "worker-export-csv-1" });
  outcome(`${a2}:plan`, "done");
  wait(0.3);
  start(`${a2}:review`);
  call(`${a2}:review`, "reviewer", "graph-review", 90_000, 20);
  outcome(`${a2}:review`, "done");
  wait(0.4);
  quick(a2, "done", 1);
  wait(0.5);
  start(e.work);
  call(
    e.work,
    "worker",
    null,
    600_000,
    150,
    worker("export-csv", {
      ...resumed(exportThread),
      descendants: { threads: 2, total: 520_000 },
    }),
  );
  wait(1);
  outcome(e.work, "done");
  wait(0.5);
  start(e.validate);
  wait(30);
  request("pause");
  wait(25);
  outcome(e.validate, "repair", { target: e.work });
  wait(600);
  emit("run-end", { outcome: "handed-off" });

  // --- run 3: Factory 0.5.8, resumed; the rest to the end ------------------
  wait(55);
  begin(4388, "0.5.8");
  wait(1800);
  request("resume");
  wait(0.5);
  start(e.work);
  call(e.work, "planner", "diagnosis", 50_000, 20);
  const diagnosis2 = hold(
    e.work,
    "Work Item export-csv needs your decision before it is repaired",
  );
  wait(540);
  answer(diagnosis2, "answer");
  wait(0.1);
  start(e.work);
  const exportThread2 = call(
    e.work,
    "worker",
    null,
    880_000,
    260,
    worker("export-csv", { descendants: { threads: 1, total: 150_000 } }),
  );
  wait(1);
  outcome(e.work, "retry", { progress: true });
  const a3 = "amend:worker-export-csv-2";
  propose("worker-export-csv-2", "export-csv");
  wait(0.2);
  start(`${a3}:plan`);
  call(`${a3}:plan`, "planner", "plan", 100_000, 30);
  on(`${a3}:plan`, "amendment-answer", { amendment: "worker-export-csv-2" });
  const revisions = hold(
    `${a3}:plan`,
    "Amendment `worker-export-csv-2` (Work Item export-csv's worker) takes this Objective to 6 planning revisions (the plan's rounds, and each amendment with the rounds sent back to its planner, this one included), past the 5 autonomy.allowances.planningRevisions allows",
  );
  wait(50);
  answer(revisions, "more");
  wait(0.3);
  // The amendment's reviewer fails twice before it answers: tokens unknown.
  for (const _ of [1, 2]) {
    start(`${a3}:review`);
    call(`${a3}:review`, "reviewer", "graph-review", null, 1.6, {
      outcome: "retry",
      error: "Error",
    });
    outcome(`${a3}:review`, "retry");
    wait(30);
  }
  start(`${a3}:review`);
  call(`${a3}:review`, "reviewer", "graph-review", 110_000, 25);
  outcome(`${a3}:review`, "done");
  wait(0.4);
  start(a3);
  wait(0.5);
  on(a3, "amendment-unchanged", { amendment: "worker-export-csv-2" });
  outcome(a3, "done");
  wait(0.5);
  start(e.work);
  call(
    e.work,
    "worker",
    null,
    700_000,
    200,
    worker("export-csv", {
      ...resumed(exportThread2),
      descendants: { threads: 1, total: 210_000 },
    }),
  );
  on(e.work, "worker-validate", { passed: true });
  wait(1);
  outcome(e.work, "done");
  wait(0.5);
  start(e.validate);
  wait(2);
  const spend2 = hold(
    e.validate,
    "Model spend reached 18,000,000 of the 18,000,000 tokens this Objective may spend",
  );
  wait(120);
  answer(spend2, "more");
  wait(0.1);
  start(e.validate);
  wait(75);
  outcome(e.validate, "done");
  wait(0.5);
  start(e.review);
  call(e.review, "reviewer", "result-review", 260_000, 60);
  const review2 = hold(
    e.review,
    "The reviewer needs your judgment on criterion 4 of export-csv: time zones",
  );
  wait(180);
  answer(review2, "accept");
  wait(0.1);
  start(e.review);
  const rereview = hold(
    e.review,
    "item:export-csv:work's refused result can't be checked again: this Objective has used 1 of its 1 result rereviews",
  );
  wait(60);
  answer(rereview, "more");
  wait(0.1);
  start(e.review);
  call(e.review, "reviewer", "result-review", 130_000, 28);
  on(e.review, "result-review", { outcome: "pass", criteria: 5 });
  outcome(e.review, "done");
  wait(0.5);
  start(e.publish);
  wait(5);
  on(e.publish, "published", { item: "export-csv", pr: 103, head: "h-0c1" });
  outcome(e.publish, "done");
  wait(0.5);
  start(e.ci);
  wait(30);
  const ci1 = hold(e.ci, 'Check "lint" has no run on h-0c1 after 30 minutes');
  wait(300);
  answer(ci1, "retry");
  wait(0.1);
  start(e.ci);
  wait(40);
  outcome(e.ci, "retry");
  wait(20);
  start(e.ci);
  wait(5);
  outcome(e.ci, "done");
  wait(0.4);
  start(e.merge);
  wait(8);
  outcome(e.merge, "done");
  merged["export-csv"] = iso();

  // release-smoke: a read-only QA item, held, then settled.
  const r = steps("release-smoke");
  wait(0.6);
  start(r.validate);
  wait(1.8);
  const qa = hold(
    r.validate,
    "Read-only QA item release-smoke can't start the release build: no display",
  );
  wait(690);
  answer(qa, "retry", "assistant (for operator)");
  wait(0.1);
  start(r.validate);
  wait(1.6);
  outcome(r.validate, "done");
  wait(0.5);
  start(r.review);
  call(r.review, "reviewer", "result-review", 90_000, 14);
  on(r.review, "result-review", { outcome: "pass", criteria: 3 });
  outcome(r.review, "done");
  wait(0.8);
  quick(r.merge, "done", 0.02);

  // Final validation; the final review (with a hedge that lost) refuses the
  // integrated result. The operator fixes the default branch by hand and
  // answers retry: final validation and final review run again, and pass.
  wait(1);
  quick("final", "done", 480);
  wait(0.6);
  start("final-review");
  call("final-review", "reviewer", "objective-review", 1_100_000, 130);
  call("final-review", "reviewer", "objective-review", 600_000, 0.1, {
    outcome: "error",
    hedge: 1,
    error: "aborted: hedged",
  });
  on("final-review", "objective-review", { outcome: "refused", criteria: 19 });
  const refusal = hold(
    "final-review",
    "Final review refused the integrated result:\n\n12. Values with commas are quoted: a value with a comma is written as it is",
  );
  wait(400);
  const handFixAt = iso();
  wait(200);
  answer(refusal, "retry");
  wait(0.1);
  start("final-review");
  wait(0.2);
  outcome("final-review", "repair", {
    target: "final",
    finding: "Final review runs again after the operator's fix.",
  });
  wait(0.3);
  quick("final", "done", 470);
  wait(0.6);
  start("final-review");
  call("final-review", "reviewer", "objective-review", 300_000, 90);
  on("final-review", "objective-review", { outcome: "pass", criteria: 19 });
  outcome("final-review", "done");
  wait(1);
  quick("report", "done", 5);
  const endedAt = iso();
  wait(6 * 3600);
  emit("run-end", { outcome: "stopped" });

  // --- the state ----------------------------------------------------------
  const events = runs.flatMap((r) => r.events);
  // Repairs as the state keeps them: per target, from the log's repair outcomes.
  const repairs = {};
  for (const event of events)
    if (event.event === "outcome" && event.outcome === "repair") {
      repairs[event.target] ??= { count: 0, findings: [], from: event.step };
      repairs[event.target].count += 1;
      repairs[event.target].from = event.step;
    }
  // The spend ledger: every call's own tokens but the one the restart replaced.
  const counted = events
    .filter((event) => event.event === "model-usage" && event.tokens)
    .reduce((sum, event) => sum + event.tokens.total, 0);
  const amended = plan(5);
  amended.requiredPreIntegrationChecks = [
    { checkName: "lint", source: { path: "CONTRIBUTING.md" } },
  ];
  const state = {
    version: 10,
    issue: ISSUE,
    status: "done",
    frozen: {
      digest: "f0".repeat(32),
      config: {
        repository: REPOSITORY,
        provider: {
          planner: "codex",
          worker: {
            model: MODEL,
            effort: "medium",
            kind: "codex",
            network: "host",
          },
          models: {
            planner: { model: MODEL, effort: "high" },
            reviewer: { model: MODEL, effort: "medium" },
          },
        },
      },
      provider: "codex",
      selectedBy: "defaultProvider",
    },
    holds: [],
    answers: {},
    retries: {},
    repairs,
    kept: {
      "plan:acceptedAt": acceptedAt,
      ...Object.fromEntries(
        Object.values(proposals).map((proposal) => [
          `amend:${proposal.id}:proposal`,
          { ...proposal, plan: acceptedAt },
        ]),
      ),
    },
    done: {
      plan: plan(4),
      "amend:worker-tokenizer-1": { plan: amended },
      "amend:worker-export-csv-1": { rejected: "rejected" },
      "amend:worker-export-csv-2": { unchanged: true },
      // The merge commits are the run repository's (fixtureRepository): a
      // test that reads one puts its SHAs here.
      ...Object.fromEntries(
        Object.entries(merged).map(([id, at]) => [
          `item:${id}:merge`,
          { mergeSha: `merge-${id}`, integratedSha: `merge-${id}`, at },
        ]),
      ),
      "item:release-smoke:merge": { settled: "qa" },
      // Final review passed: the step is done (a refusal holds it).
      "final-review": true,
    },
    attempts: {},
    appliedRequests: [],
    modules: {},
    updatedAt: endedAt,
    startedAt,
    stepRuns: {},
    finishedRun: runs.at(-1).name,
    spend: {
      tokens: counted - replaced,
      cents: 0,
      granted: { tokens: 12_000_000 },
    },
    closedHolds: [],
    ended: { at: endedAt },
  };

  const files = new Map();
  for (const r of runs)
    files.set(
      `logs/${ISSUE}/${r.name}.jsonl`,
      `${r.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  files.set(
    `objectives/finished/${ISSUE}.json`,
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return { files, timeline: { startedAt, endedAt, merged, handFixAt } };
}

/** What each Work Item's merge adds to the run repository, and the operator's hand fix. */
const CHANGES = {
  tokenizer: {
    "src/query/tokenizer.ts":
      "export function tokenize(query: string): string[] {\n  return query.split(/\\s+/).filter(Boolean);\n}\n",
  },
  "query-api": {
    "src/api/widgets.ts":
      "export function widgets(q: string) {\n  return { q, page: 50 };\n}\n",
  },
  "export-csv": {
    "src/api/export.ts":
      'export function exportCsv(rows: string[][]): string {\n  return rows.map((row) => row.join(",")).join("\\n");\n}\n',
  },
};
const HAND_FIX = {
  "src/api/export.ts":
    'const quote = (value: string) =>\n  value.includes(",") ? `"${value}"` : value;\n\nexport function exportCsv(rows: string[][]): string {\n  return rows.map((row) => row.map(quote).join(",")).join("\\n");\n}\n',
};

/**
 * The run repository as the fixture's timeline made it, in `dir`: `origin`
 * (the test repository) and `checkout`, Factory's clone of it. On `main`,
 * first parent: the base; each Work Item's merge commit, at its merge
 * step's time; the operator's hand fix during final review's refusal; and a
 * commit an hour after the Objective ended. Returns the commits' SHAs.
 */
export function fixtureRepository(dir) {
  const { timeline } = fixture();
  const origin = join(dir, "origin");
  const checkout = join(dir, "checkout");
  mkdirSync(origin, { recursive: true });
  const git = (cwd, at, ...args) => {
    const date = `${Math.floor(Date.parse(at) / 1000)} +0000`;
    return execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Bench Fixture",
        "-c",
        "user.email=bench@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  };
  const commit = (at, files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(origin, path)), { recursive: true });
      writeFileSync(join(origin, path), text);
    }
    git(origin, at, "add", "--all");
    git(origin, at, "commit", "--quiet", "--message", message);
    return git(origin, at, "rev-parse", "HEAD");
  };
  const minuteBefore = (at) => new Date(Date.parse(at) - 60_000).toISOString();
  git(origin, timeline.startedAt, "init", "--quiet", "--initial-branch=main");
  const base = commit(
    "2031-03-04T08:00:00.000Z",
    { "README.md": "# widgets\n" },
    "Widgets",
  );
  const merges = {};
  for (const [id, files] of Object.entries(CHANGES)) {
    const at = timeline.merged[id];
    git(origin, at, "checkout", "--quiet", "-b", `factory/${id}`, "main");
    commit(minuteBefore(at), files, id);
    git(origin, at, "checkout", "--quiet", "main");
    git(
      origin,
      at,
      "merge",
      "--quiet",
      "--no-ff",
      "--message",
      `Merge ${id}`,
      `factory/${id}`,
    );
    merges[id] = git(origin, at, "rev-parse", "HEAD");
  }
  const handFix = commit(timeline.handFixAt, HAND_FIX, "Quote values");
  const after = commit(
    new Date(Date.parse(timeline.endedAt) + 3_600_000).toISOString(),
    { "CHANGELOG.md": "# Changes\n" },
    "Changelog",
  );
  execFileSync("git", ["clone", "--quiet", origin, checkout], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { origin, checkout, base, merges, handFix, after, timeline };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  for (const [path, text] of fixtureFiles()) {
    const file = join(FIXTURE_DIR, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  process.stdout.write(`${FIXTURE_DIR}\n`);
}
