// Benchmark definitions are checked where they enter: the example loads, and
// a broken one is refused with each problem named by its field. Definitions
// and results live outside the Factory repository, where the commands are
// told they are.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  DefinitionError,
  definitionProblems,
  hostValue,
  loadDefinition,
} from "../bench/lib/definition.mjs";
import { policyAnswer } from "../bench/lib/holds.mjs";
import { benchDirs, HOME_ENV } from "../bench/lib/home.mjs";
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

test("a definition by id is read from the definitions directory, never from the repository", () => {
  assert.throws(
    () => loadDefinition("acme-widgets-42"),
    /Benchmark acme-widgets-42: no definitions directory\. Benchmark definitions and results live outside the Factory repository: give --benchmarks DIR, or --bench-home DIR \(with benchmarks\/ and results\/ inside\), or set FACTORY_BENCH_HOME\./,
  );
  writeFileSync(join(dir, "acme-widgets-42.json"), readFileSync(EXAMPLE));
  assert.equal(loadDefinition("acme-widgets-42", dir).id, "acme-widgets-42");
});

test("the directories come from the flags, then the bench home, then the environment", () => {
  assert.deepEqual(benchDirs({}, {}), {
    benchmarks: null,
    results: null,
    reports: null,
  });
  assert.deepEqual(benchDirs({}, { [HOME_ENV]: "/data/bench" }), {
    benchmarks: "/data/bench/benchmarks",
    results: "/data/bench/results",
    reports: "/data/bench/reports",
  });
  assert.deepEqual(
    benchDirs(
      { "bench-home": "/home/b", results: "/elsewhere/results" },
      { [HOME_ENV]: "/data/bench" },
    ),
    {
      benchmarks: "/home/b/benchmarks",
      results: "/elsewhere/results",
      reports: "/home/b/reports",
    },
  );
  assert.equal(
    benchDirs({ benchmarks: "defs" }, {}).benchmarks,
    resolve("defs"),
  );
});

test("a broken definition is refused with every problem named", () => {
  const broken = example();
  broken.source.base = "0123456";
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
  assert.deepEqual(definitionProblems(example()), []);
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

test("memory.before must be UTC in Factory's form", () => {
  for (const before of [
    "2031-03-04T04:00:00-05:00",
    "2031-03-04 09:00:00Z",
    "Mar 4 2031",
  ]) {
    const definition = example();
    definition.memory.before = before;
    assert.deepEqual(
      definitionProblems(definition).map((p) => p.split(":")[0]),
      ["memory.before"],
      before,
    );
  }
  for (const before of ["2031-03-04T09:00:00Z", "2031-03-04T09:00:00.000Z"]) {
    const definition = example();
    definition.memory.before = before;
    assert.deepEqual(definitionProblems(definition), []);
  }
});

test("metric ids are METRICS' own: no prototype names", () => {
  const definition = example();
  definition.hillClimb.primary = ["constructor", "toString"];
  definition.hillClimb.guards = ["__proto__"];
  assert.deepEqual(
    definitionProblems(definition).map((p) => p.split(":")[0]),
    ["hillClimb.primary", "hillClimb.guards"],
  );
});

test("a field the schema doesn't have is refused, at every level", () => {
  const definition = example();
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
  const env = example();
  env.factory.sandbox.environment.ANY_NAME = "value";
  assert.deepEqual(definitionProblems(env), []);
});
