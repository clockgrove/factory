// Repair's repeat detection compared a failure's text word for word, and
// that text is an excerpt of noisy output, cut by patterns (#2201): the
// same failure twice, with other durations, timestamps or temporary paths,
// never compared equal, so Factory repaired it the same way again instead
// of escalating. Whether a failure repeated is now decided by what failed:
// the command and its exit, the checks and their conclusions, the refused
// criteria (#2215). Whether it is unchanged, which refuses another repair,
// also needs its output to read the same once that noise is set aside, so
// the same command failing on another test still moved.
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
      "the last entry of prior left the same failure as it was (the same failed command, check or refused criteria, with the same output once timings, timestamps, temporary paths and hashes are set aside)",
    ),
  );
  assert.match(
    model.asked[1].prompt,
    /the failure repeated unchanged after the last correction/,
  );
});

test("the same command failing on another test moved: it is the same failure for a repeated correction, never unchanged", async () => {
  // Repair 1 fixed "sum is 3"; now "sum of nothing is 0" fails, exit 1.
  const moved = `Validation command failed (1): npm test: \n2026-10-29T19:02:11.004Z sum.test.js\n  not ok 2 - sum of nothing is 0\n  at /tmp/factory-d4e5f6/src/a.js:4\n# duration 1093ms`;
  assert.equal(unchangedFailure(moved, [tried], 2, npmTest), false);
  // The same correction again is still refused: its failure is the same.
  assert.equal(
    repeated({ ...tried, failure: moved, repair: undefined }, [tried]),
    true,
  );

  const model = planner(repair("Return 0 for no inputs in src/a.js."));
  const result = await diagnose(
    model,
    { kind: "failure", detail: moved, identity: npmTest },
    { prior: [tried], repair: 2 },
  );
  assert.equal(result.kind, "correction", JSON.stringify(result));
  assert.equal(
    result.correction.correction,
    "Return 0 for no inputs in src/a.js.",
  );
  assert.doesNotMatch(model.asked[0].prompt, /"failureRepeatedUnchanged"/);
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

test("a criterion refused again over another gap after its review-findings correction is diagnosed and may be repaired; refused again over the same gap, it is unchanged", async () => {
  const refused = (detail) => ({
    kind: "review",
    tree: "t",
    refused: [
      {
        criterion: "sum rounds half up",
        source: "model",
        detail,
        evidence: [],
      },
    ],
  });
  // Round 1: the findings are the correction, with no diagnosis call.
  const direct = await diagnose(planner(), refused("2.5 gives 2, not 3."), {
    repair: 1,
  });
  assert.equal(direct.kind, "correction", JSON.stringify(direct));
  assert.equal(direct.correction.source, "review-findings");
  assert.deepEqual(direct.correction.identity, {
    kind: "review",
    criteria: [1],
  });
  const first = { ...direct.correction, repair: 1 };

  // Round 2: the same criterion, another gap. The diagnosis may repair it.
  const model = planner(repair("Round -2.5 toward +infinity in src/a.js."));
  const moved = await diagnose(
    model,
    refused("-2.5 gives -3; half up means -2."),
    {
      prior: [first],
      repair: 2,
    },
  );
  assert.equal(moved.kind, "correction", JSON.stringify(moved));
  assert.equal(moved.correction.source, "diagnosis");
  assert.doesNotMatch(model.asked[0].prompt, /"failureRepeatedUnchanged"/);

  // Round 3: the reviewer refuses it again with the same finding.
  const again = planner(answer({ question: "Should -2.5 round to -2 or -3?" }));
  await diagnose(again, refused("-2.5 gives -3; half up means -2."), {
    prior: [first, { ...moved.correction, repair: 2 }],
    repair: 3,
  });
  assert.match(again.asked[0].prompt, /"failureRepeatedUnchanged":true/);
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
  // The head is noise: the same checks failing the same way are unchanged.
  const ci = {
    source: "diagnosis",
    failure: `Checks failed on PR #7 at ${"a".repeat(40)}: tests (failure)\n\ntests:\n2026-10-29T18:30:52.557Z not ok 1 - sum is 3`,
    identity: checks("tests", "failure"),
    diagnosis: "d",
    correction: "c",
    repair: 1,
  };
  assert.equal(
    unchangedFailure(
      `Checks failed on PR #7 at ${"b".repeat(40)}: tests (failure)\n\ntests:\n2026-10-29T19:41:07.210Z not ok 1 - sum is 3`,
      [ci],
      2,
      checks("tests", "failure"),
    ),
    true,
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
