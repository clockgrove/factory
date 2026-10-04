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
const sha = "a".repeat(40);
const stopped = (message, work, failures = {}) =>
  summarizeRun({ outcome: "stopped", message, work: workOf(work, failures) });
function workOf(work, failures) {
  return Object.fromEntries(
    Object.entries(work).map(([id, status]) => {
      const [state, step] = status.split("@");
      return [
        id,
        {
          status: state,
          ...(step ? { step } : {}),
          ...(failures[id] ? { failure: failures[id] } : {}),
        },
      ];
    }),
  );
}
const objectiveStopped = (message) =>
  `Objective stopped: Objective stopped: ${message}. Use explicit retry or operator direction.. Use explicit retry or operator direction.`;
const pending = { alpha: "pending", beta: "pending" };
const published = { alpha: "published", beta: "published" };
const done = { alpha: "done", beta: "done" };

/** One representative target per diagnosis, as the matrix produces them. */
const SAMPLES = {
  GIT_PUSH: stopped(
    objectiveStopped(
      `git -C /tmp/t/target push origin ${sha}:refs/heads/factory/objective-1/alpha failed (1): error: RPC failed; HTTP 503`,
    ),
    { alpha: "failed@deliver", beta: "pending" },
  ),
  GIT_FETCH: stopped(
    objectiveStopped(
      "git -C /tmp/t/target fetch --no-tags --no-write-fetch-head --refmap= origin +refs/heads/main:refs/factory/fetch/0f8fad5b-d9cb-469f-a165-70867728950e failed (128): fatal: unable to access 'http://127.0.0.1:1/git/example/r.git/': The requested URL returned error: 503 ",
    ),
    published,
  ),
  GIT_FETCH_RESET: stopped(
    objectiveStopped(
      "git -C /tmp/t/target fetch --no-tags --no-write-fetch-head --refmap= origin +refs/heads/main:refs/factory/fetch/0f8fad5b-d9cb-469f-a165-70867728950e failed (128): fatal: unable to access 'http://127.0.0.1:1/git/example/r.git/': Empty reply from server ",
    ),
    { alpha: "failed", beta: "pending" },
  ),
  NATIVE_READS: stopped(
    objectiveStopped("GitHub request failed (HTTP 503)"),
    published,
  ),
  START_AMBIGUOUS: stopped(
    "Objective stopped: Work Item beta has ambiguous active state at execute; operator direction required. Use explicit retry or operator direction.",
    { alpha: "done", beta: "running@execute" },
  ),
  START_REPEAT: stopped(
    objectiveStopped(
      `git -C /tmp/t/target worktree add --no-checkout --detach /tmp/t/w ${sha} failed (128): Preparing worktree (detached HEAD abc1234) fatal: '/tmp/t/w' already exists `,
    ),
    { alpha: "failed@execute", beta: "pending" },
  ),
  COLLECT_REPEAT: summarizeRun({
    outcome: "needs-decision",
    message:
      "Objective #1 needs a human decision: Work Item alpha: Failure requires an operator decision",
    work: workOf(
      { alpha: "failed@execute", beta: "pending" },
      {
        alpha:
          "git rev-parse HEAD failed (128): fatal: cannot change to '/tmp/t/w': No such file or directory",
      },
    ),
  }),
  MERGE_READ_LAG: stopped(
    objectiveStopped("PR merge has not confirmed the exact integrated commit"),
    { alpha: "failed", beta: "pending" },
  ),
  TIMELINE_LAG: stopped(
    objectiveStopped("PR #4 has missing or conflicting merge evidence"),
    published,
  ),
  PULL_LIST_LAG: stopped(objectiveStopped("GitHub request failed (HTTP 422)"), {
    alpha: "failed@deliver",
    beta: "pending",
  }),
  STACK_MERGE_REPEAT: stopped(
    objectiveStopped("GitHub request failed (HTTP 409)"),
    published,
  ),
  SECONDARY_403: stopped(objectiveStopped("GitHub request failed (HTTP 403)"), {
    alpha: "failed@deliver",
    beta: "pending",
  }),
  PRIMARY_403: stopped(objectiveStopped("GitHub request failed (HTTP 403)"), {
    alpha: "failed",
    beta: "pending",
  }),
  BASE_MODIFIED: stopped(objectiveStopped("GitHub request failed (HTTP 405)"), {
    alpha: "failed",
    beta: "pending",
  }),
};

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

test("generic transport text matches only where the run stopped", () => {
  // A socket hang up while Work Items run is neither a planner stop nor a
  // final review; a 503 with work in flight is neither projection nor a
  // native read.
  const midRun = stopped("socket hang up", {
    alpha: "running@execute",
    beta: "pending",
  });
  const midDelivery = stopped(
    objectiveStopped("GitHub request failed (HTTP 503)"),
    {
      alpha: "failed@deliver",
      beta: "pending",
    },
  );
  for (const key of ["NATIVE_READS"]) {
    assert.equal(DIAGNOSES[key].pattern.test(midRun), false, key);
    assert.equal(DIAGNOSES[key].pattern.test(midDelivery), false, key);
  }
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
  assert.throws(
    () => todos({ GIT_PUSH: ["a"] }, { START_AMBIGUOUS: ["a"] }),
    /Duplicate known failure: a/,
  );
  assert.throws(() => todos({ NOT_A_DIAGNOSIS: ["b"] }), /Unknown diagnosis/);
  const racy = Object.values(KNOWN.regular).filter((entry) => entry.racy);
  assert.equal(racy.length, 8);
  assert.ok(racy.every((entry) => entry.key === "START_AMBIGUOUS"));
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
