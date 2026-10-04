// A charge is made once per failure event (#515, recovery v2.2 rule 5).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compilePlan } from "../dist/compiler.js";
import { attachFault } from "../dist/fault.js";
import { assertRepairLedger, consumption } from "../dist/repair-policy.js";
import {
  applyWorkCorrection,
  CandidateEnvironmentFailure,
  CandidateValidationFailure,
  diagnoseWorkRepair,
  prepareEvidenceRecovery,
  recordWorkFailure,
  SettledAttemptFailure,
} from "../dist/work-repair.js";
import { withCoverage } from "./support/coverage.mjs";
import { createTarget } from "./support/integration-fixture.mjs";

const autonomy = (limit = 2) => ({
  allowances: {
    planningRevisions: limit,
    implementationRepairs: limit,
    resultRereviews: limit,
  },
  repairClasses: [
    "implementation",
    "review-evidence",
    "validation-environment",
    "planning-output",
    "planning-evidence",
    "planning-choice",
  ],
  repairPolicy: {
    perPath: {
      planningRevisions: limit,
      implementationRepairs: limit,
      resultRereviews: limit,
    },
  },
  requiredEnvironment: [],
});
const item = {
  id: "result",
  kind: "work",
  children: [],
  title: "result",
  goal: "result",
  brief: "Write result.txt",
  acceptance: ["result.txt exists"],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE" }],
  dependencies: [],
  ownedPaths: ["result.txt"],
  resources: [],
  validation: [
    {
      command: "test -s result.txt",
      provenance: "source-declared",
      source: "OBJECTIVE",
    },
  ],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
};
const failedAttempt = (attempt) => ({
  status: "failed",
  step: "validate",
  attempt,
  baseSha: "a".repeat(40),
  changeRef: "b".repeat(40),
  treeSha: "c".repeat(40),
});
const itemState = (limit) => ({
  autonomy: autonomy(limit),
  graph: { items: [item] },
  work: { result: failedAttempt("first") },
  baseSha: "a".repeat(40),
  runId: "run",
});
/** A diagnosis model that answers `repair` with a fresh correction each time. */
function diagnoser() {
  const model = {
    calls: 0,
    lose: 0,
    generateStructured: async () => {
      model.calls++;
      if (model.lose > 0) {
        model.lose--;
        throw new Error("diagnosis response lost");
      }
      return {
        decision: "repair",
        diagnosis: `The required file was not written (${model.calls})`,
        correction: `Write result.txt from the accepted base (${model.calls})`,
      };
    },
  };
  return model;
}
const diagnose = (state, model) =>
  diagnoseWorkRepair({
    state,
    item,
    model,
    save: () => {},
    stopped: () => false,
  });
/** Persist and restart: the controller only keeps what JSON keeps. */
const restart = (state) => JSON.parse(JSON.stringify(state));

test("a wrong result is charged once, at its failure event, whatever repeats", async () => {
  let state = itemState(2);
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("Validation command failed (1)"),
  );
  const event = state.work.result.recovery.failure.event;
  assert.equal(event, "first/validate/0");
  // Recording the same failure again (a repeat before anything was saved)
  // names the same event.
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("Validation command failed (1)"),
  );
  assert.equal(state.work.result.recovery.failure.event, event);

  // Lost diagnosis response: charged once, the restart reissues it free.
  const model = diagnoser();
  model.lose = 1;
  await assert.rejects(diagnose(state, model), /lost/);
  assert.equal(state.work.result.recovery.phase, "diagnosing");
  assert.deepEqual(Object.keys(state.charges), [event]);
  state = restart(state);
  assert.equal(await diagnose(state, model), true);
  assert.equal(model.calls, 2);
  assert.equal(consumption(state).implementationRepairs, 1);
  assert.equal(consumption(state, "result").implementationRepairs, 1);
  assertRepairLedger(restart(state));

  // A new failure of the new attempt is a new event and is charged again.
  state.work.result = {
    ...failedAttempt("second"),
    recovery: state.work.result.recovery,
  };
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("Validation command failed (2)"),
  );
  assert.equal(state.work.result.recovery.failure.event, "second/validate/1");
  assert.equal(await diagnose(state, model), true);
  assert.equal(consumption(state).implementationRepairs, 2);

  // The allowance is spent: a third failure stops for the operator without
  // a model call, and is not charged.
  state.work.result = {
    ...failedAttempt("third"),
    recovery: state.work.result.recovery,
  };
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("Validation command failed (3)"),
  );
  const calls = model.calls;
  assert.equal(await diagnose(state, model), false);
  assert.equal(model.calls, calls);
  assert.equal(consumption(state).implementationRepairs, 2);
  assert.equal(state.work.result.status, "failed");
  assert.equal(state.work.result.recovery.phase, "stopped");
  assert.match(state.work.result.recovery.failure.decision, /exhausted/);
});

test("a correction saved but not applied before a restart is applied without a second charge", async () => {
  const state = itemState(1);
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("Validation command failed"),
  );
  // Stop the diagnosis at the point where its correction is saved as ready.
  let snapshot;
  const ready = () => state.work.result.recovery?.phase === "ready";
  await diagnoseWorkRepair({
    state,
    item,
    model: diagnoser(),
    save: () => {
      if (ready()) snapshot ??= restart(state);
    },
    stopped: ready,
  });
  assert.equal(snapshot.work.result.status, "failed");
  assert.equal(snapshot.work.result.recovery.phase, "ready");
  assert.equal(consumption(snapshot).implementationRepairs, 1);
  applyWorkCorrection(
    snapshot,
    "result",
    snapshot.work.result.recovery.correction,
  );
  assert.equal(snapshot.work.result.status, "pending");
  assert.equal(consumption(snapshot).implementationRepairs, 1);
});

test("an operator correction of an already diagnosed failure is not charged again", async () => {
  const state = itemState(2);
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("Validation command failed"),
  );
  const model = {
    generateStructured: async () => ({
      decision: "operator",
      diagnosis: "The acceptance needs a product decision",
      correction: "",
    }),
  };
  assert.equal(await diagnose(state, model), false);
  assert.equal(consumption(state).implementationRepairs, 1);
  applyWorkCorrection(state, "result", {
    kind: "implementation",
    failureDigest: state.work.result.recovery.failure.digest,
    actor: "operator",
    diagnosis: "Product decided to keep the plain-text format",
    correction: "Write result.txt as plain text",
  });
  assert.equal(state.work.result.status, "pending");
  assert.equal(consumption(state).implementationRepairs, 1);
});

test("transient and configuration failures are never charged", async () => {
  for (const [error, kind] of [
    [new SettledAttemptFailure(new Error("worker exited")), "transient"],
    [
      new CandidateEnvironmentFailure("Validation environment unavailable"),
      "config",
    ],
  ]) {
    const state = itemState(2);
    assert.equal(recordWorkFailure(state, "result", error), true);
    const failure = state.work.result.recovery.failure;
    assert.equal(failure.event, undefined, kind);
    const model = diagnoser();
    assert.equal(await diagnose(state, model), false);
    assert.equal(model.calls, 0);
    // The operator may still correct it; nothing is charged.
    applyWorkCorrection(state, "result", {
      kind: kind === "config" ? "validation-environment" : "implementation",
      failureDigest: failure.digest,
      actor: "operator",
      diagnosis: "The controller environment is restored",
      correction: "Run the same attempt again",
    });
    assert.equal(state.charges, undefined, kind);
  }
  // A worker that failed with a result is a wrong result.
  const state = itemState(2);
  recordWorkFailure(
    state,
    "result",
    new SettledAttemptFailure(new Error("tests failed"), "implementation"),
  );
  assert.equal(state.work.result.recovery.failure.event, "first/validate/0");
});

test("a refused review is charged once per refusal", () => {
  const pending = () => ({
    criterion: "result.txt exists",
    treeSha: "c".repeat(40),
    question: "Inspect the invalid review response",
    detail: "unknown source",
    reviewRejection: { field: "source", reason: "unknown-source" },
  });
  let state = itemState(2);
  Object.assign(state.work.result, {
    status: "waiting",
    step: "approve-result",
    acceptancePending: pending(),
  });
  const before = restart(state);
  assert.equal(prepareEvidenceRecovery(state, "result"), true);
  assert.deepEqual(Object.keys(state.charges), ["first/approve-result/0"]);
  // The same refusal seen again after a restart that lost the correction.
  const repeated = restart(before);
  repeated.charges = structuredClone(state.charges);
  assert.equal(prepareEvidenceRecovery(repeated, "result"), true);
  assert.equal(consumption(repeated).resultRereviews, 1);
  // The corrected re-review is refused again: a new event.
  state = restart(state);
  Object.assign(state.work.result, {
    status: "waiting",
    step: "approve-result",
    acceptancePending: { ...pending(), detail: "unknown source again" },
  });
  assert.equal(prepareEvidenceRecovery(state, "result"), true);
  assert.deepEqual(Object.keys(state.charges).sort(), [
    "first/approve-result/0",
    "first/approve-result/1",
  ]);
});

test("planning: a lost diagnosis is charged once and a new failed round again", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-charges-"));
  try {
    const target = createTarget(root);
    const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
    let reviews = 0;
    let diagnoses = 0;
    let loseDiagnosis = true;
    const planner = {
      generateStructured: async (request) => {
        if (request.purpose !== "diagnosis")
          return withCoverage(request, graph);
        diagnoses++;
        if (loseDiagnosis) {
          loseDiagnosis = false;
          throw new Error("diagnosis response lost");
        }
        return {
          kind: "planning-evidence",
          diagnosis: `Brief omitted a supplied fact (${diagnoses})`,
          correction: `Keep the supplied fact in the brief (${diagnoses})`,
        };
      },
      reviewGraph: async (request) => {
        reviews++;
        return {
          packetId: request.reviewPacket.id,
          findings:
            reviews <= 2
              ? [
                  {
                    evidenceIndices: [0],
                    detail: `Brief omitted a supplied fact (${reviews})`,
                    question: "Keep the fact",
                  },
                ]
              : [],
        };
      },
    };
    const plan = (state) =>
      compilePlan(
        1,
        "# Charges fixture\n## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n",
        target.baseSha,
        target.checkout,
        planner,
        undefined,
        undefined,
        undefined,
        { state, save: () => {} },
      );
    let state = { autonomy: autonomy(2) };
    await assert.rejects(plan(state), /lost/);
    assert.deepEqual(Object.keys(state.charges), ["objective/plan/0"]);
    state = restart(state);
    const candidate = await plan(state);
    assert.equal(candidate.review.status, "clean");
    assert.equal(diagnoses, 3);
    assert.deepEqual(Object.keys(state.charges).sort(), [
      "objective/plan/0",
      "objective/plan/1",
    ]);
    assert.equal(consumption(state, "$planning").planningRevisions, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planning: a transient or configuration fault is never charged", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-uncharged-"));
  try {
    const target = createTarget(root);
    for (const fault of [
      {
        kind: "transient",
        detail: "planner unavailable",
        outcomeUnknown: true,
      },
      { kind: "config", detail: "planner login expired", fix: "Log in" },
    ]) {
      const state = { autonomy: autonomy(2) };
      const planner = {
        generateStructured: async () => {
          throw attachFault(new Error(fault.detail), fault);
        },
        reviewGraph: async () => assert.fail("no review"),
      };
      await assert.rejects(
        compilePlan(
          1,
          "# Charges fixture\n## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n",
          target.baseSha,
          target.checkout,
          planner,
          undefined,
          undefined,
          undefined,
          { state, save: () => {} },
        ),
        new RegExp(fault.detail),
      );
      assert.equal(state.charges, undefined, fault.kind);
    }
    // A plan review that never answered is asked again after a restart,
    // without a charged revision or a second compile.
    let compiles = 0;
    let reviews = 0;
    const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
    const planner = {
      generateStructured: async (request) => {
        compiles++;
        return withCoverage(request, graph);
      },
      reviewGraph: async (request) => {
        reviews++;
        if (reviews === 1)
          throw attachFault(new Error("review response lost"), {
            kind: "transient",
            detail: "review response lost",
            outcomeUnknown: true,
          });
        return { packetId: request.reviewPacket.id, findings: [] };
      },
    };
    let state = { autonomy: autonomy(2) };
    const plan = () =>
      compilePlan(
        1,
        "# Charges fixture\n## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n",
        target.baseSha,
        target.checkout,
        planner,
        undefined,
        undefined,
        undefined,
        { state, save: () => {} },
      );
    await assert.rejects(plan(), /review response lost/);
    assert.equal(state.charges, undefined);
    state = restart(state);
    assert.equal((await plan()).review.status, "clean");
    assert.equal(compiles, 1);
    assert.equal(reviews, 2);
    assert.equal(state.charges, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted charges are validated against the snapshotted limits", () => {
  const charge = (allowance, scopes) => ({ allowance, scopes });
  assert.doesNotThrow(() =>
    assertRepairLedger({
      autonomy: autonomy(1),
      charges: { "a/validate/0": charge("implementationRepairs", ["result"]) },
    }),
  );
  for (const charges of [
    { "not an event": charge("implementationRepairs", ["result"]) },
    { "a/validate/0": charge("unknown", ["result"]) },
    { "a/validate/0": charge("implementationRepairs", []) },
    {
      "a/validate/0": charge("implementationRepairs", ["result"]),
      "b/validate/0": charge("implementationRepairs", ["result"]),
    },
  ])
    assert.throws(() => assertRepairLedger({ autonomy: autonomy(1), charges }));
});
