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
