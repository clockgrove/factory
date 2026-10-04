import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runScenario } from "./support/fault-harness.mjs";
import { DIAGNOSES, KNOWN, todos } from "./support/fault-known.mjs";
import {
  assertFaultsFired,
  diagnosisTarget,
  snapshotDifferences,
  summarizeRun,
  updateSnapshot,
} from "./support/fault-matrix.mjs";

// The guards that keep the fault matrix an honest scoreboard: a known
// failure must fail for its own diagnosed reason, judged on the run that
// stopped; the boundary snapshot must change only deliberately.

const run = promisify(execFile);

/**
 * One representative target per diagnosis, as the matrix produces them. Empty
 * while the known lists are; a new diagnosis adds its sample here.
 */
const SAMPLES = {};

test("every diagnosis has a sample, and each sample matches only its own diagnosis", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(DIAGNOSES).sort());
  for (const [key, sample] of Object.entries(SAMPLES)) {
    const matching = Object.entries(DIAGNOSES)
      .filter(([, diagnosis]) => diagnosis.pattern.test(sample))
      .map(([other]) => other);
    assert.deepEqual(matching, [key], `sample for ${key}: ${sample}`);
  }
});

test("no pattern matches the checks' own failure labels", () => {
  const labels = [
    "operator stops: ",
    "plan compilations",
    "3 paid calls; uninterrupted 2, 0 injected",
    "Work Item alpha has 1 issues with its marker\n",
    "Work Item alpha has 0 issues with its marker\n",
    "Objective closed",
    "PRs for alpha",
    "merges of alpha's PR",
    "kinds of mutation",
    "an attempt started twice",
    "dependencies of alpha",
    "alpha.txt on the default branch",
    summarizeRun({ outcome: "complete", message: "Objective #1 completed" }),
    summarizeRun({ outcome: "crashed" }),
  ];
  for (const [key, diagnosis] of Object.entries(DIAGNOSES))
    for (const label of labels)
      assert.equal(diagnosis.pattern.test(label), false, `${key} ~ ${label}`);
});

test("the target is the run that ended the scenario, or the last stop", () => {
  const early = {
    outcome: "stopped",
    message: "Multiple Work Item issues for alpha; operator direction required",
  };
  const late = { outcome: "stopped", message: "socket hang up" };
  const complete = { outcome: "complete", message: "Objective #1 completed" };
  const error = new Error("Work Item alpha has 2 issues with its marker\n");
  // The final run decides; an earlier run's message cannot satisfy a pattern.
  assert.equal(
    diagnosisTarget({ runs: [early, late] }, "end", error),
    summarizeRun(late),
  );
  // After a complete run: the operator-stop check names the last stop, other
  // checks the end-state fact.
  assert.equal(
    diagnosisTarget(
      { runs: [early, { outcome: "crashed" }, complete] },
      "stop",
      error,
    ),
    summarizeRun(early),
  );
  assert.equal(
    diagnosisTarget({ runs: [early, complete] }, "end", error),
    error.message,
  );
});

test("racy and inverted entries share one duplicate check", () => {
  const diagnoses = {
    ONE: { text: "one", pattern: /^one$/ },
    TWO: { text: "two", pattern: /^two$/ },
  };
  assert.throws(
    () => todos({ ONE: ["a"] }, { TWO: ["a"] }, diagnoses),
    /Duplicate known failure: a/,
  );
  assert.throws(() => todos({ NOT_A_DIAGNOSIS: ["b"] }), /Unknown diagnosis/);
  assert.deepEqual(todos({ ONE: ["a"] }, { TWO: ["b"] }, diagnoses), {
    a: { key: "ONE", ...diagnoses.ONE },
    b: { key: "TWO", ...diagnoses.TWO, racy: true },
  });
  // Every known list is empty at merge (#515 exit).
  for (const [suite, entries] of Object.entries(KNOWN))
    assert.deepEqual(Object.keys(entries), [], suite);
});

test("the snapshot refuses deliveries it no longer derives and boundary changes", () => {
  const snapshot = { mutations: ["POST x #1"], reads: [], calls: [] };
  assert.deepEqual(
    snapshotDifferences({ regular: snapshot }, "regular", snapshot),
    [],
  );
  assert.deepEqual(
    snapshotDifferences(
      { regular: snapshot, "merge-queue": snapshot },
      "regular",
      snapshot,
    ),
    ["- delivery merge-queue is no longer derived"],
  );
  assert.deepEqual(
    snapshotDifferences(
      { regular: { ...snapshot, mutations: ["POST x #1", "POST x #2"] } },
      "regular",
      snapshot,
    ),
    ["- mutations: POST x #2"],
  );
  assert.deepEqual(snapshotDifferences({}, "other", snapshot), [
    "+ delivery other is not a matrix delivery",
    "+ mutations: POST x #1",
  ]);
});

test("concurrent snapshot updates serialize and drop deliveries no longer derived", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fault-boundaries.json");
  writeFileSync(path, `${JSON.stringify({ retired: {} })}\n`);
  const writer = join(root, "writer.mjs");
  writeFileSync(
    writer,
    `import { updateSnapshot } from ${JSON.stringify(new URL("./support/fault-matrix.mjs", import.meta.url).href)};
for (let i = 0; i < 20; i++) updateSnapshot(process.argv[2], process.argv[3], { mutations: [String(i)], reads: [], calls: [] });`,
  );
  await Promise.all(
    ["regular", "native-stack"].map((delivery) =>
      run(process.execPath, [writer, path, delivery]),
    ),
  );
  updateSnapshot(path, "regular", { mutations: ["19"], reads: [], calls: [] });
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(written), ["native-stack", "regular"]);
  assert.deepEqual(written["native-stack"].mutations, ["19"]);
});

test("a controller signalled from outside the harness voids the scenario", async () => {
  const result = await runScenario({
    name: "guard-sigterm",
    // A drained controller may wait out its own work; the signal is the point.
    runTimeoutMs: 15_000,
    maxRestarts: 0,
    http: [
      {
        match: "GET /repos/{owner}/{repo}/issues/{number}",
        kind: "after",
        run: (fake) => process.kill(fake.controllerPid, "SIGTERM"),
      },
    ],
  });
  assert.equal(result.signals.length, 1);
  assert.throws(
    () => assertFaultsFired(result),
    /signal from outside the harness/,
  );
});
