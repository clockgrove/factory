// Repair's repeat detection compared a failure's text word for word, and
// that text is an excerpt of noisy output, cut by patterns (#2201): the
// same failure twice, with other durations, timestamps or temporary paths,
// never compared equal, so Factory repaired it the same way again instead
// of escalating. Whether a failure repeated is now decided by what failed:
// the command and its exit, the checks and their conclusions, the refused
// criteria (#2215). A correction saved with only its text compares by its
// text, as before.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  correction,
  failureIdentity,
  repeated,
  sameFailure,
  unchangedFailure,
} from "../dist/repair.js";
import { item, plan, tempDir } from "./helpers.mjs";

const a = item("a", {
  ownedPaths: ["src/a.js"],
  acceptance: ["sum adds its inputs", "sum rounds half up"],
  validation: [{ command: "npm test" }],
});
const b = item("b", {
  ownedPaths: ["src/b.js"],
  dependencies: ["a"],
  validation: [{ command: "npm test" }],
});

/** A checkout with a base and a result commit that changes src/a.js. */
function checkout() {
  const dir = tempDir("factory-identity-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/b.js"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
  git("commit", "-q", "-am", "result");
  return { dir, base, commit: git("rev-parse", "HEAD") };
}

const answer = (fields) => ({
  decision: "operator",
  diagnosis: "",
  predecessor: "",
  path: "",
  correction: "",
  question: "",
  requestedFiles: [],
  ownership: [],
  evidence: [],
  acceptance: [],
  ...fields,
});

const repair = (text) =>
  answer({
    decision: "repair",
    diagnosis: "sum truncates in src/a.js.",
    path: "src/a.js",
    correction: text,
  });

/** A planner whose answers come in order, the last one repeating. */
function planner(...answers) {
  const asked = [];
  return {
    asked,
    answer: async (call) => {
      asked.push(call);
      return { value: answers[Math.min(asked.length, answers.length) - 1] };
    },
  };
}

/** One correction of Work Item a's result for `finding`. */
function diagnose(model, finding, fields = {}) {
  const repo = checkout();
  return correction({
    planner: model,
    plan: plan([a, b]),
    item: a,
    finding,
    checkout: repo.dir,
    base: repo.base,
    commit: repo.commit,
    sources: [{ path: "objective.md", content: "The Objective." }],
    prior: [],
    validate: true,
    signal: AbortSignal.timeout(60_000),
    log: () => {},
    ...fields,
  });
}

/** `npm test`'s failure as one run printed it: its time, temp directory and duration. */
const run = (at, dir, ms) =>
  `Validation command failed (1): npm test: \n${at} sum.test.js\n  not ok 1 - sum is 3\n  at ${dir}/src/a.js:1\n# duration ${ms}ms`;
const first = run("2026-10-29T18:30:52.557Z", "/tmp/factory-a1b2c3", 812);
const second = run("2026-10-29T19:02:11.004Z", "/tmp/factory-d4e5f6", 1093);
const npmTest = { kind: "validation", command: "npm test", exit: "1" };

/** The correction repair 1 ran for the first run, as repairContext saves it. */
const tried = {
  source: "diagnosis",
  failure: first,
  identity: npmTest,
  diagnosis: "sum truncates in src/a.js.",
  path: "src/a.js",
  correction: "Round half up in src/a.js.",
  repair: 1,
};

test("the same failed command, ending the same way, is a repeat whatever its output's durations, timestamps and temporary paths", async () => {
  assert.notEqual(first, second);
  assert.equal(unchangedFailure(second, [tried], 2, npmTest), true);

  // The diagnosis is told so, and may not repair it again.
  const question =
    "npm test still fails with sum is 3 after rounding half up: should sum round to even instead?";
  const model = planner(repair("Round half up again."), answer({ question }));
  const result = await diagnose(
    model,
    { kind: "failure", detail: second, identity: npmTest },
    { prior: [tried], repair: 2 },
  );
  assert.deepEqual(result, { kind: "question", question });
  assert.match(model.asked[0].prompt, /"failureRepeatedUnchanged":true/);
  assert.ok(
    model.asked[0].prompt.includes(
      "the last entry of prior left the same failure as it was (the same failed command, check or refused criteria, however its output reads)",
    ),
  );
  assert.match(
    model.asked[1].prompt,
    /the failure repeated unchanged after the last correction/,
  );
});

test("another command, or the same command ending another way, is not the same failure", async () => {
  const lint = { kind: "validation", command: "npm run lint", exit: "1" };
  assert.equal(unchangedFailure(first, [tried], 2, lint), false);
  assert.equal(
    unchangedFailure(first, [tried], 2, { ...npmTest, exit: "time limit" }),
    false,
  );
  // Text the same, identity not: the identity decides.
  assert.equal(sameFailure(tried, { failure: first, identity: lint }), false);

  const model = planner(repair("Fix the lint error in src/a.js."));
  const result = await diagnose(
    model,
    { kind: "failure", detail: second, identity: lint },
    { prior: [tried], repair: 2 },
  );
  assert.equal(result.kind, "correction");
  assert.deepEqual(result.correction.identity, lint);
  assert.doesNotMatch(model.asked[0].prompt, /"failureRepeatedUnchanged"/);
});

test("the same correction for the same failure is refused whatever the output's wording; for another failure it is taken", async () => {
  const answered = {
    ...tried,
    source: "operator",
    correction: "Use Math.round.",
  };
  const again = await diagnose(
    planner(),
    { kind: "failure", detail: second, identity: npmTest },
    { prior: [answered], operatorAnswer: "Use Math.round." },
  );
  assert.equal(again.kind, "question");
  assert.match(again.question, /^This correction already failed/);
  assert.equal(repeated({ ...answered, failure: second }, [answered]), true);

  const lint = { kind: "validation", command: "npm run lint", exit: "1" };
  const other = await diagnose(
    planner(),
    { kind: "failure", detail: first, identity: lint },
    { prior: [answered], operatorAnswer: "Use Math.round." },
  );
  assert.equal(other.kind, "correction");
  assert.deepEqual(other.correction.identity, lint);
});

test("a review refusal is identified by its refused criteria's indices, never by the reviewer's wording", () => {
  const refusal = (criterion, detail) => ({
    finding: {
      kind: "review",
      tree: "t",
      refused: [{ criterion, source: "model", detail, evidence: [] }],
    },
    plan: plan([a, b]),
    item: a,
  });
  const rounds = failureIdentity(
    refusal("sum rounds half up", "2.5 gives 2, not 3."),
  );
  assert.deepEqual(rounds, { kind: "review", criteria: [1] });
  const reworded = failureIdentity(
    refusal("sum rounds half up", "sum(2.5) truncates to 2."),
  );
  assert.equal(
    sameFailure(
      { failure: "2.5 gives 2, not 3.", identity: rounds },
      { failure: "sum(2.5) truncates to 2.", identity: reworded },
    ),
    true,
  );
  const adds = failureIdentity(refusal("sum adds its inputs", "1 + 1 is 3."));
  assert.deepEqual(adds, { kind: "review", criteria: [0] });
  assert.equal(
    sameFailure(
      { failure: "x", identity: rounds },
      { failure: "x", identity: adds },
    ),
    false,
  );
  // A criterion the item doesn't review has no index: its text decides.
  assert.equal(failureIdentity(refusal("something else", "no")), undefined);
});

test("failed checks are identified by name and conclusion, not by the head or the logs; staging refusals by their file", () => {
  const checks = (name, conclusion) => ({
    kind: "ci",
    checks: [{ name, conclusion }],
  });
  assert.equal(
    sameFailure(
      {
        failure: `Checks failed on PR #7 at ${"a".repeat(40)}: tests (failure)`,
        identity: checks("tests", "failure"),
      },
      {
        failure: `Checks failed on PR #7 at ${"b".repeat(40)}: tests (failure)`,
        identity: checks("tests", "failure"),
      },
    ),
    true,
  );
  assert.equal(
    sameFailure(
      { failure: "x", identity: checks("tests", "failure") },
      { failure: "x", identity: checks("tests", "timed_out") },
    ),
    false,
  );
  // As the state file returns it, its keys in another order.
  const read = JSON.parse(
    '{"checks":[{"conclusion":"failure","name":"tests"}],"kind":"ci"}',
  );
  assert.equal(
    sameFailure(
      { failure: "x", identity: read },
      { failure: "y", identity: checks("tests", "failure") },
    ),
    true,
  );
  assert.deepEqual(
    failureIdentity({
      finding: { kind: "failure", detail: "bad notes", staging: "handoff" },
      plan: plan([a]),
      item: a,
    }),
    { kind: "staging", staging: "handoff" },
  );
});

test("a blamed predecessor's correction carries the failure it was blamed for, by the Work Item that failed", async () => {
  const repo = checkout();
  const result = await correction({
    planner: planner(
      answer({
        decision: "predecessor",
        predecessor: "a",
        diagnosis: "src/a.js exports 2 where b expects 1.",
        path: "src/a.js",
        correction: "Export 1 from src/a.js.",
      }),
    ),
    plan: plan([a, b]),
    item: b,
    finding: {
      kind: "failure",
      detail: `${second}\nsrc/a.js`,
      identity: npmTest,
    },
    checkout: repo.dir,
    base: repo.base,
    commit: repo.commit,
    sources: [{ path: "objective.md", content: "The Objective." }],
    prior: [],
    validate: true,
    signal: AbortSignal.timeout(60_000),
    log: () => {},
  });
  assert.equal(result.kind, "predecessor", JSON.stringify(result));
  assert.deepEqual(result.correction.identity, {
    kind: "blame",
    item: "b",
    failure: npmTest,
  });
});

test("a correction saved with only its text (0.5.10) still loads and compares by its text for one round, then by identity", async () => {
  const saved = JSON.parse(JSON.stringify(tried));
  delete saved.identity;
  // Unknown identity: its text decides, as before.
  assert.equal(unchangedFailure(first, [saved], 2, npmTest), true);
  assert.equal(unchangedFailure(second, [saved], 2, npmTest), false);
  assert.equal(repeated({ ...tried }, [saved]), true);
  assert.equal(repeated({ ...tried, failure: second }, [saved]), false);
  // A finding saved before identities has none.
  assert.equal(
    failureIdentity({
      finding: { kind: "failure", detail: first },
      plan: plan([a]),
      item: a,
    }),
    undefined,
  );

  // Its next correction carries the identity, so the round after compares by it.
  const model = planner(repair("Round half up with Math.round."));
  const next = await diagnose(
    model,
    { kind: "failure", detail: second, identity: npmTest },
    { prior: [saved], repair: 2 },
  );
  assert.equal(next.kind, "correction");
  assert.doesNotMatch(model.asked[0].prompt, /"failureRepeatedUnchanged"/);
  assert.deepEqual(next.correction.identity, npmTest);
  const third = run("2026-10-29T20:15:40.120Z", "/tmp/factory-g7h8i9", 977);
  assert.equal(
    unchangedFailure(
      third,
      [saved, { ...next.correction, repair: 2 }],
      3,
      npmTest,
    ),
    true,
  );
});
