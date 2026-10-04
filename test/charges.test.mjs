// A charge is made once per failure event (#515, recovery v2.2 rule 5).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compilePlan, MalformedPlannerOutput } from "../dist/compiler.js";
import { CompletedModelInvocationError } from "../dist/contracts.js";
import { attachFault } from "../dist/fault.js";
import {
  assertRepairLedger,
  consumption,
  failureDigest,
  PAID_ATTEMPTS,
} from "../dist/repair-policy.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  applyWorkCorrection,
  CandidateEnvironmentFailure,
  CandidateValidationFailure,
  diagnoseWorkRepair,
  recordWorkFailure,
  SettledAttemptFailure,
} from "../dist/work-repair.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const autonomy = (limit = 2) => ({
  allowances: {
    planningRevisions: limit,
    implementationRepairs: limit,
    resultRereviews: limit,
  },
  repairClasses: [
    "implementation",
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
const body =
  "# Charges fixture\n## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n";
const failedAttempt = (attempt, step = "validate") => ({
  status: "failed",
  step,
  attempt,
  baseSha: "a".repeat(40),
  changeRef: "b".repeat(40),
  treeSha: "c".repeat(40),
});
const itemState = (limit) => ({
  objective: 1,
  autonomy: autonomy(limit),
  graph: { items: [item] },
  work: { result: failedAttempt("first") },
  baseSha: "a".repeat(40),
  runId: "run",
});
const lostResponse = (detail = "diagnosis response lost") =>
  attachFault(new Error(detail), {
    kind: "transient",
    detail,
    outcomeUnknown: true,
  });
/** A diagnosis model that answers `repair` with a fresh correction, after `lose` lost responses. */
function diagnoser(lose = 0) {
  const model = {
    calls: 0,
    generateStructured: async () => {
      model.calls++;
      if (model.calls <= lose) throw lostResponse();
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
const fail = (state, detail) =>
  recordWorkFailure(state, "result", new CandidateValidationFailure(detail));

test("a wrong result is charged once, at its failure event, whatever repeats", async () => {
  let state = itemState(2);
  fail(state, "Validation command failed (1)");
  const event = state.work.result.recovery.failure.event;
  assert.equal(event, "item/result/validate/0");
  // Recording the same failure again names the same event.
  fail(state, "Validation command failed (1)");
  assert.equal(state.work.result.recovery.failure.event, event);

  // A lost diagnosis response leaves the diagnosis under way, charged once.
  const model = diagnoser(1);
  assert.equal(await diagnose(state, model), false);
  assert.equal(state.work.result.recovery.phase, "diagnosing");
  assert.match(
    state.work.result.recovery.failure.decision,
    /run the Objective again/,
  );
  assert.deepEqual(state.charges, {
    [event]: { allowances: ["implementationRepairs"], scopes: ["result"] },
  });
  assertRepairLedger(restart(state));
  state = restart(state);
  assert.equal(await diagnose(state, model), true);
  assert.equal(model.calls, 2);
  assert.equal(consumption(state).implementationRepairs, 1);
  assert.equal(consumption(state, "result").implementationRepairs, 1);
  assertRepairLedger(restart(state));

  // A failure of the new attempt is a new event and is charged again.
  state.work.result = {
    ...failedAttempt("second"),
    recovery: state.work.result.recovery,
  };
  fail(state, "Validation command failed (2)");
  assert.equal(
    state.work.result.recovery.failure.event,
    "item/result/validate/1",
  );
  assert.equal(await diagnose(state, model), true);
  assert.equal(consumption(state).implementationRepairs, 2);

  // The allowance is spent: the next failure stops without a model call,
  // is not charged, and names the command that works.
  state.work.result = {
    ...failedAttempt("third"),
    recovery: state.work.result.recovery,
  };
  fail(state, "Validation command failed (3)");
  const calls = model.calls;
  assert.equal(await diagnose(state, model), false);
  assert.equal(model.calls, calls);
  assert.equal(consumption(state).implementationRepairs, 2);
  assert.equal(state.work.result.recovery.phase, "stopped");
  assert.match(
    state.work.result.recovery.failure.decision,
    /exhausted; start a new attempt with `factory retry --objective 1 --item result`/,
  );
});

test("a diagnosis that never answers is asked a bounded number of times", async () => {
  let state = itemState(2);
  fail(state, "Validation command failed");
  const model = diagnoser(Number.POSITIVE_INFINITY);
  for (let run = 1; run <= PAID_ATTEMPTS; run++) {
    assert.equal(await diagnose(state, model), false);
    assert.equal(state.work.result.recovery.phase, "diagnosing");
    state = restart(state);
  }
  assert.equal(await diagnose(state, model), false);
  assert.equal(model.calls, PAID_ATTEMPTS);
  assert.equal(state.work.result.recovery.phase, "stopped");
  assert.match(
    state.work.result.recovery.failure.decision,
    /did not answer 3 times/,
  );
  assert.equal(consumption(state).implementationRepairs, 1);
});

test("a correction saved but not applied before a restart is applied without a second charge", async () => {
  const state = itemState(1);
  fail(state, "Validation command failed");
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
  assertRepairLedger(snapshot);
  applyWorkCorrection(
    snapshot,
    "result",
    snapshot.work.result.recovery.correction,
  );
  assert.equal(snapshot.work.result.status, "pending");
  assert.equal(consumption(snapshot).implementationRepairs, 1);
});

test("an operator correction of a diagnosed failure: same kind free, another kind charges its own allowance", async () => {
  const operatorAnswer = {
    generateStructured: async () => ({
      decision: "operator",
      diagnosis: "The acceptance needs a product decision",
      correction: "",
    }),
  };
  const correction = (state, kind) => ({
    kind,
    failureDigest: state.work.result.recovery.failure.digest,
    actor: "operator",
    diagnosis: "The declared prerequisite was missing",
    correction: "Provide the declared prerequisite and continue",
  });
  for (const kind of ["implementation", "validation-environment"]) {
    const state = itemState(2);
    fail(state, "Validation command failed");
    assert.equal(await diagnose(state, operatorAnswer), false);
    assert.equal(consumption(state).implementationRepairs, 1);
    applyWorkCorrection(state, "result", correction(state, kind));
    assert.equal(consumption(state).implementationRepairs, 1);
    assert.equal(
      consumption(state).resultRereviews,
      kind === "implementation" ? 0 : 1,
    );
    assertRepairLedger(restart(state));
  }
});

test("transient and configuration failures are never charged", async () => {
  for (const [error, decision, kind] of [
    [
      new SettledAttemptFailure(new Error("worker exited")),
      /factory retry --objective 1 --item result/,
      "implementation",
    ],
    [
      new CandidateEnvironmentFailure("Validation environment unavailable"),
      /validation-environment correction/,
      "validation-environment",
    ],
  ]) {
    const state = itemState(2);
    assert.equal(recordWorkFailure(state, "result", error), true);
    const failure = state.work.result.recovery.failure;
    assert.equal(failure.event, undefined);
    assert.match(failure.decision, decision);
    const model = diagnoser();
    assert.equal(await diagnose(state, model), false);
    assert.equal(model.calls, 0);
    // The operator may still correct it; nothing is charged.
    applyWorkCorrection(state, "result", {
      kind,
      failureDigest: failure.digest,
      actor: "operator",
      diagnosis: "The controller environment is restored",
      correction: "Run the same work again",
    });
    assert.equal(state.charges, undefined);
    assertRepairLedger(restart(state));
  }
});

test("any work fault is a wrong result: a refused criterion, a refused push", async () => {
  const refused = attachFault(
    new CompletedModelInvocationError("Criterion refused: result.txt is empty"),
    { kind: "work", evidence: { detail: "result.txt is empty" } },
  );
  const state = itemState(2);
  state.work.result.step = "approve-result";
  assert.equal(recordWorkFailure(state, "result", refused), true);
  assert.equal(
    state.work.result.recovery.failure.event,
    "item/result/approve-result/0",
  );
  assert.equal(
    state.work.result.recovery.failure.classification,
    "implementation",
  );
  assert.equal(await diagnose(state, diagnoser()), true);
  assert.equal(state.work.result.status, "pending");

  // The remote refused the pushed content: nothing was published, so a
  // corrected new attempt may follow.
  const pushed = itemState(2);
  pushed.work.result.step = "deliver";
  const tooLarge = attachFault(new Error("GH001: Large files detected"), {
    kind: "work",
    evidence: { detail: "git push refused a file over the size limit" },
  });
  assert.equal(recordWorkFailure(pushed, "result", tooLarge), true);
  assert.equal(await diagnose(pushed, diagnoser()), true);
  assert.equal(pushed.work.result.status, "pending");
  assert.equal(consumption(pushed).implementationRepairs, 1);
});

/** A planner whose reviews answer `reviews` in turn and whose diagnoses follow `diagnoses`. */
function planner(target, { reviews, diagnoses = [] }) {
  const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
  const model = {
    compiles: 0,
    reviews: 0,
    diagnoses: 0,
    generateStructured: async (request) => {
      if (request.purpose !== "diagnosis") {
        model.compiles++;
        return withCoverage(request, graph);
      }
      const answer = diagnoses[model.diagnoses++] ?? "repair";
      if (answer === "lost") throw lostResponse();
      return {
        kind: "planning-evidence",
        diagnosis: `Brief omitted a supplied fact (${model.diagnoses})`,
        correction: `Keep the supplied fact in the brief (${model.diagnoses})`,
      };
    },
    reviewGraph: async (request) => {
      const answer = reviews[model.reviews++] ?? "clean";
      if (answer === "lost") throw lostResponse("review response lost");
      if (answer === "malformed")
        throw attachFault(new MalformedPlannerOutput("not JSON"), {
          kind: "transient",
          detail: "Model output was invalid: not JSON",
          outcomeUnknown: true,
        });
      return {
        packetId: request.reviewPacket.id,
        findings:
          answer === "finding"
            ? [
                {
                  evidenceIndices: [0],
                  detail: `Brief omitted a supplied fact (${model.reviews})`,
                  question: "Keep the fact",
                },
              ]
            : [],
      };
    },
  };
  return model;
}
const plan = (target, model, state) =>
  compilePlan(
    1,
    body,
    target.baseSha,
    target.checkout,
    model,
    undefined,
    undefined,
    undefined,
    { state, save: () => {} },
  );

async function withTarget(name, run) {
  const root = mkdtempSync(join(tmpdir(), `factory-charges-${name}-`));
  try {
    await run(createTarget(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("planning: a lost diagnosis is charged once and a new failed round again", async () => {
  await withTarget("plan", async (target) => {
    const model = planner(target, {
      reviews: ["finding", "finding", "clean"],
      diagnoses: ["lost"],
    });
    let state = { autonomy: autonomy(2) };
    await assert.rejects(plan(target, model, state), /lost/);
    assert.deepEqual(Object.keys(state.charges), ["objective/plan/0"]);
    state = restart(state);
    const candidate = await plan(target, model, state);
    assert.equal(candidate.review.status, "clean");
    assert.equal(model.diagnoses, 3);
    assert.deepEqual(Object.keys(state.charges).sort(), [
      "objective/plan/0",
      "objective/plan/1",
    ]);
    assert.equal(consumption(state, "$planning").planningRevisions, 2);
    assertRepairLedger(restart(state));
  });
});

test("planning: a diagnosis that never answers stops after the paid bound", async () => {
  await withTarget("plan-bound", async (target) => {
    const model = planner(target, {
      reviews: Array(10).fill("finding"),
      diagnoses: Array(10).fill("lost"),
    });
    let state = { autonomy: autonomy(2) };
    for (let run = 1; run <= PAID_ATTEMPTS; run++) {
      await assert.rejects(plan(target, model, state), /lost/);
      state = restart(state);
    }
    const candidate = await plan(target, model, state);
    assert.equal(candidate.review.status, "needs-human");
    assert.equal(model.diagnoses, PAID_ATTEMPTS);
    assert.equal(consumption(state).planningRevisions, 1);
  });
});

test("planning: transient and configuration faults and unanswered reviews are never charged", async () => {
  await withTarget("plan-uncharged", async (target) => {
    for (const fault of [
      {
        kind: "transient",
        detail: "planner unavailable",
        outcomeUnknown: true,
      },
      { kind: "config", detail: "planner login expired", fix: "Log in" },
    ]) {
      const state = { autonomy: autonomy(2) };
      const model = {
        generateStructured: async () => {
          throw attachFault(new Error(fault.detail), fault);
        },
        reviewGraph: async () => assert.fail("no review"),
      };
      await assert.rejects(
        plan(target, model, state),
        new RegExp(fault.detail),
      );
      assert.equal(state.charges, undefined, fault.kind);
    }
    // A lost or malformed review is asked again in place, without a
    // revision or a second compile.
    const asked = planner(target, { reviews: ["lost", "malformed", "clean"] });
    const state = { autonomy: autonomy(2) };
    assert.equal((await plan(target, asked, state)).review.status, "clean");
    assert.equal(asked.compiles, 1);
    assert.equal(asked.reviews, 3);
    assert.equal(state.charges, undefined);
    // A review that never answers validly leaves the plan to the operator.
    const silent = planner(target, { reviews: Array(10).fill("lost") });
    const stopped = { autonomy: autonomy(2) };
    assert.equal(
      (await plan(target, silent, stopped)).review.status,
      "needs-human",
    );
    assert.equal(silent.reviews, PAID_ATTEMPTS);
    assert.equal(stopped.charges, undefined);
  });
});

test("persisted charges are validated against limits, failures and earlier versions", () => {
  const charge = (allowances, scopes = ["result"]) => ({ allowances, scopes });
  const ledger = (charges, extra = {}) => ({
    autonomy: autonomy(1),
    charges,
    ...extra,
  });
  assert.doesNotThrow(() =>
    assertRepairLedger(
      ledger({ "item/result/validate/0": charge(["implementationRepairs"]) }),
    ),
  );
  for (const charges of [
    { "not an event": charge(["implementationRepairs"]) },
    { "first/validate/0": charge(["implementationRepairs"]) },
    { "item/result/validate/0": charge(["unknown"]) },
    { "item/result/validate/0": charge([]) },
    { "item/result/validate/0": charge(["implementationRepairs"], []) },
    {
      "item/result/validate/0": charge([
        "implementationRepairs",
        "implementationRepairs",
      ]),
    },
    {
      "item/result/validate/0": charge(["implementationRepairs"]),
      "item/result/validate/1": charge(["implementationRepairs"]),
    },
  ])
    assert.throws(() => assertRepairLedger(ledger(charges)));
  // Counters from an earlier version are refused, never silently reset.
  assert.throws(
    () =>
      assertRepairLedger(
        ledger(undefined, {
          allowanceConsumption: {
            planningRevisions: 1,
            implementationRepairs: 0,
            resultRereviews: 0,
          },
        }),
      ),
    /start the Objective fresh/,
  );
  // A wrong result keeps its event, and a diagnosis under way its charge.
  const state = itemState(2);
  fail(state, "Validation command failed");
  state.work.result.recovery.phase = "diagnosing";
  assert.throws(() => assertRepairLedger(restart(state)), /lacks its charge/);
  delete state.work.result.recovery.failure.event;
  assert.throws(
    () => assertRepairLedger(restart(state)),
    /does not match its classification/,
  );
  // Each accepted planning correction kept its charge.
  assert.throws(
    () =>
      assertRepairLedger({
        autonomy: autonomy(1),
        planningRecovery: {
          phase: "ready",
          history: [
            {
              kind: "planning-evidence",
              failure: failureDigest("x"),
              detail: "x",
              diagnosis: "d",
              correction: "c",
              invocations: [],
            },
          ],
        },
      }),
    /Planning correction 0 lacks its charge/,
  );
});

function reviewer(request) {
  return {
    packetId: request.reviewPacket.id,
    findings: resultFindings(
      request,
      request.criteria.map((criterion) => ({
        criterion,
        verdict: "pass",
        source: "OBJECTIVE",
        quote: "# Charges fixture",
        detail: "Fixture exact evidence",
        question: "",
      })),
    ),
  };
}

async function withApplication(name, delivery, setup, run) {
  const root = mkdtempSync(join(tmpdir(), `factory-charges-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      `example/charges-${name}-${delivery}`,
      delivery,
      2,
    );
    config.autonomy = autonomy(2);
    const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
    const descriptor = {
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      ...setup(graph),
    };
    await run({
      descriptor,
      config,
      application: () => makeApplication(descriptor),
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const delivery of ["regular", "native-stack"]) {
  test(`${delivery}: a diagnosis interrupted in a run is asked again by the next run and charged once`, async () => {
    let diagnoses = 0;
    await withApplication(
      "diagnosis",
      delivery,
      (graph) => ({
        actions: {
          result: {
            failAttempts: 1,
            files: [{ path: "result.txt", text: "accepted\n" }],
          },
        },
        planningModel: {
          generateStructured: async (request) => {
            if (request.purpose !== "diagnosis")
              return withCoverage(request, graph);
            diagnoses++;
            if (diagnoses === 1) throw lostResponse();
            return {
              decision: "repair",
              diagnosis: "The worker did not write the required file",
              correction: "Write result.txt from the accepted base",
            };
          },
          reviewGraph: async (request) => ({
            packetId: request.reviewPacket.id,
            findings: [],
          }),
          reviewResult: async (request) => reviewer(request),
        },
      }),
      async ({ application, config }) => {
        const stopped = await application().application.runObjective(1);
        assert.equal(stopped.work.result.status, "failed");
        assert.equal(stopped.work.result.recovery.phase, "diagnosing");
        assert.match(
          stopped.coordinator.waitReason,
          /Work Item result: The diagnosis did not answer/,
        );
        assert.deepEqual(Object.keys(stopped.charges), [
          "item/result/execute/0",
        ]);
        const done = await application().application.runObjective(1);
        assert.equal(done.finalValidation.passed, true);
        assert.equal(diagnoses, 2);
        assert.equal(consumption(done).implementationRepairs, 1);
        assert.deepEqual(
          readState(config.repository, 1).charges,
          stopped.charges,
        );
      },
    );
  });

  test(`${delivery}: a worker that keeps dying stops for retry, uncharged and undiagnosed`, async () => {
    let diagnoses = 0;
    await withApplication(
      "dying",
      delivery,
      (graph) => ({
        actions: {
          result: {
            // Three dead workers repeat; the fourth is a decision.
            dieAttempts: 4,
            files: [{ path: "result.txt", text: "accepted\n" }],
          },
        },
        planningModel: {
          generateStructured: async (request) => {
            if (request.purpose === "diagnosis") diagnoses++;
            return withCoverage(request, graph);
          },
          reviewGraph: async (request) => ({
            packetId: request.reviewPacket.id,
            findings: [],
          }),
          reviewResult: async (request) => reviewer(request),
        },
      }),
      async ({ application }) => {
        const fixture = application();
        const stopped = await fixture.application.runObjective(1);
        const work = stopped.work.result;
        assert.equal(work.status, "failed");
        assert.equal(work.recovery.failure.event, undefined);
        assert.match(
          work.recovery.failure.decision,
          /factory retry --objective 1 --item result/,
        );
        assert.equal(stopped.charges, undefined);
        assert.equal(diagnoses, 0);
        fixture.application.retryWorkItem(1, "result");
        const done = await application().application.runObjective(1);
        assert.equal(done.finalValidation.passed, true);
        assert.equal(done.charges, undefined);
        const starts = readEvents(fixture.eventsPath).filter(
          (event) => event.type === "start",
        );
        assert.equal(starts.length, 5);
      },
    );
  });
}

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: a repeated identical failure after a correction stops for retry, and retry writes loadable state`, async () => {
    let diagnoses = 0;
    await withApplication(
      "repeated",
      delivery,
      (graph) => ({
        actions: {
          result: {
            failAttempts: 2,
            files: [{ path: "result.txt", text: "accepted\n" }],
          },
        },
        planningModel: {
          generateStructured: async (request) => {
            if (request.purpose !== "diagnosis")
              return withCoverage(request, graph);
            diagnoses++;
            return {
              decision: "repair",
              diagnosis: `The worker did not write the required file (${diagnoses})`,
              correction: `Write result.txt from the accepted base (${diagnoses})`,
            };
          },
          reviewGraph: async (request) => ({
            packetId: request.reviewPacket.id,
            findings: [],
          }),
          reviewResult: async (request) => reviewer(request),
        },
      }),
      async ({ application, config }) => {
        config.autonomy.repairPolicy.perPath.implementationRepairs = 1;
        const fixture = application();
        const stopped = await fixture.application.runObjective(1);
        const work = stopped.work.result;
        assert.equal(work.status, "failed");
        // Both failures have the same detail, but they are two events.
        const [first] = work.recovery.history;
        assert.equal(first.failure.digest, work.recovery.failure.digest);
        assert.notEqual(first.failure.event, work.recovery.failure.event);
        // The new failure does not inherit the earlier correction.
        assert.equal(work.recovery.correction, undefined);
        assert.match(
          work.recovery.failure.decision,
          /exhausted; start a new attempt with `factory retry --objective 1 --item result`/,
        );
        assert.equal(consumption(stopped).implementationRepairs, 1);
        fixture.application.retryWorkItem(1, "result");
        const retried = readState(config.repository, 1);
        assert.equal(retried.work.result.status, "pending");
        const done = await application().application.runObjective(1);
        assert.equal(done.finalValidation.passed, true);
        assert.equal(diagnoses, 1);
        assert.equal(consumption(done).implementationRepairs, 1);
      },
    );
  });

test("state that a load would refuse is never written", async () => {
  await withApplication(
    "save",
    "regular",
    (graph) => ({
      actions: { result: { files: [{ path: "result.txt", text: "ok\n" }] } },
      planningModel: {
        generateStructured: async (request) => withCoverage(request, graph),
        reviewGraph: async (request) => ({
          packetId: request.reviewPacket.id,
          findings: [],
        }),
        reviewResult: async (request) => reviewer(request),
      },
    }),
    async ({ application, config }) => {
      const done = await application().application.runObjective(1);
      assert.equal(done.finalValidation.passed, true);
      const path = statePath(config.repository, 1);
      const before = readFileSync(path, "utf8");
      const invalid = (mutate) => {
        const state = JSON.parse(before);
        mutate(state);
        return state;
      };
      for (const mutate of [
        // A charge beyond the snapshotted allowance.
        (state) => {
          state.charges = Object.fromEntries(
            [0, 1, 2].map((round) => [
              `item/result/execute/${round}`,
              { allowances: ["implementationRepairs"], scopes: ["result"] },
            ]),
          );
        },
        // A wrong result without its event.
        (state) => {
          state.work.result.recovery = {
            failure: {
              digest: failureDigest("x"),
              detail: "x",
              at: new Date().toISOString(),
              classification: "implementation",
              continuation: "new-attempt-from-accepted-base",
              unfinishedEdits: "unavailable",
              decision: "d",
            },
            phase: "stopped",
          };
        },
        // Counters from an earlier version.
        (state) => {
          state.allowanceConsumption = {
            planningRevisions: 0,
            implementationRepairs: 0,
            resultRereviews: 0,
          };
        },
      ])
        assert.throws(
          () => saveState(path, invalid(mutate)),
          /Refusing to save invalid Factory state/,
        );
      assert.equal(readFileSync(path, "utf8"), before);
      assert.deepEqual(
        readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")),
        [],
      );
    },
  );
});
