// Benchmark definitions are checked where they enter: the shipped one loads,
// and a broken one is refused with each problem named by its field.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  BENCH_DIR,
  DefinitionError,
  definitionProblems,
  hostValue,
  loadDefinition,
} from "../bench/lib/definition.mjs";
import { policyAnswer } from "../bench/lib/holds.mjs";

const dir = mkdtempSync(join(tmpdir(), "bench-definition-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const shipped = () =>
  JSON.parse(
    readFileSync(join(BENCH_DIR, "benchmarks", "clockgrove-800.json"), "utf8"),
  );

test("the clockgrove-800 benchmark loads and names #800 at its base", () => {
  const definition = loadDefinition("clockgrove-800");
  assert.equal(definition.source.repository, "clockgrove/clockgrove");
  assert.equal(
    definition.source.base,
    "46a206678b4b8446aeb162553b07151647a28536",
  );
  assert.equal(definition.objective.issue, 800);
  assert.equal(definition.factory.spend.objectiveTokens, 200_000_000);
  assert.deepEqual(definition.operatorPolicy.answers, {
    spend: "more",
    allowance: "more",
    config: "adopt",
  });
  assert.match(definition.digest, /^[0-9a-f]{64}$/);
  assert.equal(
    hostValue(definition.factory.toolchain.paths[0], { toolchain: "/t" }),
    "/t/postgresql-18.6/bin",
  );
});

test("a broken definition is refused with every problem named", () => {
  const broken = shipped();
  broken.source.base = "46a2066";
  delete broken.objective.bodySha256;
  broken.factory.worker.kind = "claude";
  broken.operatorPolicy.answers.typo = "more";
  broken.hillClimb.primary = ["speed"];
  assert.deepEqual(
    definitionProblems(broken).map((problem) => problem.split(":")[0]),
    [
      "source.base",
      "objective.bodySha256",
      "factory.worker.network",
      "operatorPolicy.answers",
      "hillClimb.primary",
    ],
  );
  const file = join(dir, "broken.json");
  writeFileSync(file, JSON.stringify(broken));
  assert.throws(
    () => loadDefinition(file),
    (error) =>
      error instanceof DefinitionError &&
      error.problems.length === 5 &&
      error.message.includes("source.base: a full commit SHA"),
  );
  assert.deepEqual(definitionProblems(shipped()), []);
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
    const definition = shipped();
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

test("memory.before must be UTC in Factory's form", () => {
  for (const before of [
    "2026-10-27T20:00:00-05:00",
    "2026-10-28 01:00:00Z",
    "Oct 28 2026",
  ]) {
    const definition = shipped();
    definition.memory.before = before;
    assert.deepEqual(
      definitionProblems(definition).map((p) => p.split(":")[0]),
      ["memory.before"],
      before,
    );
  }
  for (const before of ["2026-10-28T01:00:00Z", "2026-10-28T01:00:00.000Z"]) {
    const definition = shipped();
    definition.memory.before = before;
    assert.deepEqual(definitionProblems(definition), []);
  }
});

test("metric ids are METRICS' own: no prototype names", () => {
  const definition = shipped();
  definition.hillClimb.primary = ["constructor", "toString"];
  definition.hillClimb.guards = ["__proto__"];
  assert.deepEqual(
    definitionProblems(definition).map((p) => p.split(":")[0]),
    ["hillClimb.primary", "hillClimb.guards"],
  );
});

test("a field the schema doesn't have is refused, at every level", () => {
  const definition = shipped();
  definition.factory.worker.netwrok = definition.factory.worker.network;
  delete definition.factory.worker.network;
  definition.factory.allowances.perPaths = 3;
  definition.extra = true;
  definition.ci.keepWorkflow = [];
  assert.deepEqual(definitionProblems(definition), [
    "ci.keepWorkflow: not a field of the schema",
    "factory.worker.netwrok: not a field of the schema",
    "factory.allowances.perPaths: not a field of the schema",
    "extra: not a field of the schema",
  ]);
  // Maps whose keys their own checks cover are not walked.
  const env = shipped();
  env.factory.sandbox.environment.ANY_NAME = "value";
  assert.deepEqual(definitionProblems(env), []);
});
