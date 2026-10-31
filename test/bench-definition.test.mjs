// Benchmark definitions are checked where they enter: the example loads, and
// each optional field is checked when it is given.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  definitionProblems,
  hostValue,
  loadDefinition,
} from "../bench/lib/definition.mjs";
import { policyAnswer } from "../bench/lib/holds.mjs";
import { loadReviewArtifacts } from "../dist/review/artifacts.js";
import { EXAMPLE } from "./bench-fixture.mjs";

const dir = mkdtempSync(join(tmpdir(), "bench-definition-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const example = () => JSON.parse(readFileSync(EXAMPLE, "utf8"));

test("the example benchmark loads and names its Objective at its base", () => {
  const definition = loadDefinition(EXAMPLE);
  assert.equal(definition.source.repository, "acme/widgets");
  assert.equal(
    definition.source.base,
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(definition.objective.issue, 42);
  assert.equal(definition.factory.spend.objectiveTokens, 40_000_000);
  assert.deepEqual(definition.operatorPolicy.answers, {
    spend: "more",
    allowance: "more",
    config: "adopt",
  });
  assert.match(definition.digest, /^[0-9a-f]{64}$/);
  assert.equal(definition.file, EXAMPLE);
  assert.equal(
    hostValue(definition.factory.toolchain.paths[0], { toolchain: "/t" }),
    "/t/node-24/bin",
  );
});

test("a policy scripts only limit raises and adopting a config: never accept or cancel", () => {
  for (const answers of [
    { review: "accept" },
    { spend: "cancel" },
    { diagnosis: "cancel" },
    { other: "cancel" },
    { amendment: "accept" },
    { config: "accept" },
    { allowance: "replan" },
  ]) {
    const definition = example();
    definition.operatorPolicy.answers = { spend: "more", ...answers };
    assert.deepEqual(
      definitionProblems(definition).map((p) => p.split(":")[0]),
      ["operatorPolicy.answers"],
      JSON.stringify(answers),
    );
  }
  // And a policy that slipped past the schema still answers nothing outside the allow-list.
  const loose = { answers: { review: "accept", spend: "more" } };
  const options = [{ answer: "accept" }, { answer: "more" }];
  assert.deepEqual(
    policyAnswer(
      {
        question: "The reviewer needs your judgment on criterion 3",
        options,
      },
      loose,
    ),
    { kind: "review", answer: null },
  );
  assert.deepEqual(
    policyAnswer({ question: "Model spend reached 25M", options }, loose),
    { kind: "spend", answer: "more" },
  );
});

test("operatorPolicy.policy is optional: stamps or scripted", () => {
  for (const policy of ["stamps", "scripted", undefined]) {
    const definition = example();
    definition.operatorPolicy.policy = policy;
    assert.deepEqual(definitionProblems(definition), [], String(policy));
  }
  for (const policy of ["accept", "Scripted", ""]) {
    const definition = example();
    definition.operatorPolicy.policy = policy;
    assert.deepEqual(definitionProblems(definition), [
      "operatorPolicy.policy: stamps | scripted",
    ]);
  }
});

test("grader, scoring and prices are optional, and checked when given", () => {
  // A definition from before scorecard v3 loads as it is.
  const before = example();
  for (const key of ["grader", "scoring", "prices", "hillClimb"])
    delete before[key];
  assert.deepEqual(definitionProblems(before), []);
  const definition = example();
  assert.deepEqual(definition.grader.timeoutMinutes, 10);
  definition.grader = { command: " ", timeoutMinutes: 0, extra: 1 };
  definition.scoring.questionChargeMinutes = -1;
  definition.prices["gpt-test"] = { uncachedInput: 1, cachedInput: "0.1" };
  assert.deepEqual(
    definitionProblems(definition).map((p) => p.split(":")[0]),
    [
      "grader.command",
      "grader.timeoutMinutes",
      "scoring.questionChargeMinutes",
      "prices",
      "grader.extra",
    ],
  );
  const extraRate = example();
  extraRate.prices["gpt-test"].reasoning = 1;
  assert.deepEqual(
    definitionProblems(extraRate).map((p) => p.split(":")[0]),
    ["prices"],
  );
});

test("the judge, its calibration and the agreement it needs are optional, and checked when given", () => {
  const before = example();
  delete before.judge;
  delete before.judgeCalibration;
  delete before.scoring.minJudgeAgreement;
  assert.deepEqual(definitionProblems(before), []);
  // Either scoring field alone will do.
  const agreementOnly = example();
  agreementOnly.scoring = { minJudgeAgreement: 0.9 };
  assert.deepEqual(definitionProblems(agreementOnly), []);
  const definition = example();
  assert.equal(definition.judge.timeoutMinutes, 20);
  assert.equal(definition.judgeCalibration[0].intent, "B");
  definition.judge = { command: "", timeoutMinutes: -1 };
  definition.judgeCalibration[0].intent = "C";
  definition.scoring.minJudgeAgreement = 1.5;
  assert.deepEqual(
    definitionProblems(definition).map((p) => p.split(":")[0]),
    [
      "judge.command",
      "judge.timeoutMinutes",
      "judgeCalibration",
      "scoring.minJudgeAgreement",
    ],
  );
  // A choice of one run against itself, with a field it doesn't have, at
  // a time that isn't UTC, or by no one.
  const entry = example().judgeCalibration[0];
  for (const bad of [
    { ...entry, runB: entry.runA },
    { ...entry, note: "close call" },
    { ...entry, at: "the 6th" },
    { ...entry, by: undefined },
  ]) {
    const value = example();
    value.judgeCalibration = [bad];
    assert.deepEqual(
      definitionProblems(value).map((p) => p.split(":")[0]),
      ["judgeCalibration"],
      JSON.stringify(bad),
    );
  }
});

test("base patches and capacity are optional, and checked when given", () => {
  const before = example();
  delete before.basePatches;
  delete before.factory.capacity;
  assert.deepEqual(definitionProblems(before), []);
  const patch = example().basePatches[0];
  assert.match(patch.reason, /flaky/);
  for (const bad of [
    [{ commit: patch.commit.slice(0, 7), reason: patch.reason }],
    [{ commit: patch.commit }],
    [{ ...patch, note: "x" }],
    [patch, patch],
    [{ ...patch, commit: example().source.base }],
    patch,
  ]) {
    const value = example();
    value.basePatches = bad;
    assert.deepEqual(
      definitionProblems(value).map((p) => p.split(":")[0]),
      ["basePatches"],
      JSON.stringify(bad),
    );
  }
  const capacity = example();
  assert.deepEqual(capacity.factory.capacity, {
    workers: 4,
    validations: 2,
    memoryMib: 16384,
  });
  capacity.factory.capacity = { workers: 0, validations: 1.5, memoryMib: 128 };
  assert.deepEqual(
    definitionProblems(capacity).map((p) => p.split(":")[0]),
    [
      "factory.capacity.workers",
      "factory.capacity.validations",
      "factory.capacity.memoryMib",
    ],
  );
  // Each value is optional; an unknown one is refused.
  capacity.factory.capacity = { memoryMib: 8192, cpus: 4 };
  assert.deepEqual(definitionProblems(capacity), [
    "factory.capacity.cpus: not a field of the schema",
  ]);
  capacity.factory.capacity = 4;
  assert.deepEqual(
    definitionProblems(capacity).map((p) => p.split(":")[0]),
    ["factory.capacity"],
  );
});

test("factory.reviewArtifacts is optional, and Factory's own loader checks it, in its words", () => {
  const without = example();
  delete without.factory.reviewArtifacts;
  assert.deepEqual(definitionProblems(without), []);
  const [selector] = example().factory.reviewArtifacts;
  assert.equal(selector.text.locator.stdoutPathPrefix, "EXPORT_REPORT_DIR=");
  assert.deepEqual(loadReviewArtifacts([selector]), [selector]);
  for (const bad of [
    [{ ...selector, text: { ...selector.text, source: "../outside.js" } }],
    [
      {
        command: "npm test",
        text: {
          source: "test/export.test.js",
          locator: { stdoutPathPrefix: "", files: [] },
        },
      },
    ],
    [selector, selector],
    Array(9).fill(selector),
    selector,
  ]) {
    const value = example();
    value.factory.reviewArtifacts = bad;
    const factory = [];
    loadReviewArtifacts(bad, factory);
    assert.ok(factory.length, JSON.stringify(bad));
    assert.deepEqual(
      definitionProblems(value),
      factory.map((problem) => `factory.${problem}`),
    );
  }
  // The refusal names the field as the loader does.
  const value = example();
  value.factory.reviewArtifacts[0].text.source = "../outside.js";
  const file = join(dir, "artifacts.json");
  writeFileSync(file, JSON.stringify(value));
  assert.throws(
    () => loadDefinition(file),
    /- factory\.reviewArtifacts\[0\]\.text\.source must be a relative path inside the checkout/,
  );
});
