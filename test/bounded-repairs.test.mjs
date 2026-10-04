import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import {
  chargeRepair,
  consumption,
  repairScopes,
  assertRepairLedger,
  earlierHeads,
  failureDigest,
} from "../dist/repair-policy.js";
import {
  applyWorkCorrection,
  recordWorkFailure,
  CandidateValidationFailure,
  CandidateEnvironmentFailure,
} from "../dist/work-repair.js";
import { objectiveCriteria, CodexPlanningModel } from "../dist/compiler.js";
import { coverageObligations, aggregateAcceptance } from "../dist/qa.js";
import { faultOf, StepFault } from "../dist/fault.js";
import { shortPlanDigest } from "../dist/status-summary.js";
import {
  validateTree,
  workItemReviewEvidence,
  objectiveReviewEvidence,
} from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
  git,
  waitForFile,
} from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";
import { compilePlan } from "./support/plan.mjs";

const autonomy = () => ({
  allowances: {
    planningRevisions: 2,
    implementationRepairs: 2,
    resultRereviews: 2,
  },
  repairClasses: [
    "implementation",
    "planning-output",
    "planning-evidence",
    "planning-choice",
  ],
  repairPolicy: {
    perPath: {
      planningRevisions: 2,
      implementationRepairs: 1,
      resultRereviews: 1,
    },
  },
  requiredEnvironment: [],
});
const item = (id = "result", dependencies = []) => ({
  id,
  kind: "work",
  children: [],
  title: id,
  goal: id,
  brief: `Write ${id}.txt`,
  acceptance: [`${id}.txt exists`],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE" }],
  dependencies,
  ownedPaths: [`${id}.txt`],
  resources: [],
  validation: [
    {
      command: `test -s ${id}.txt`,
      provenance: "source-declared",
      source: "OBJECTIVE",
    },
  ],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
});
const body =
  "# Recovery fixture\n## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n";
function reviewer(request) {
  return {
    packetId: request.reviewPacket.id,
    findings: resultFindings(
      request,
      request.criteria.map((criterion, criterionIndex) => ({
        criterion,
        verdict: "pass",
        source: "OBJECTIVE",
        quote: "# Recovery fixture",
        detail: "Fixture exact evidence",
        question: "",
      })),
    ),
  };
}
function model(
  graph,
  diagnosis = () => ({
    decision: "repair",
    diagnosis:
      "The worker stopped before collection; its owned checkout is now removed and connectivity is restored",
    correction:
      "Start from the accepted base and produce the required file with the original validation unchanged",
  }),
) {
  return {
    generateStructured: async (request) =>
      request.purpose === "diagnosis"
        ? diagnosis(request)
        : withCoverage(request, graph),
    reviewGraph: async (request) => ({
      packetId: request.reviewPacket.id,
      findings: [],
    }),
    reviewResult: async (request) => reviewer(request),
  };
}

test("disabled repair classes are refused and inherited scopes cannot reset caps", () => {
  const disabled = autonomy();
  disabled.repairClasses = [];
  assert.throws(
    () =>
      chargeRepair(
        { autonomy: disabled },
        "item/a/execute/0",
        "implementation",
        ["parent"],
      ),
    /not enabled/,
  );
  const ledger = { autonomy: autonomy() };
  chargeRepair(ledger, "item/a/execute/0", "implementation", ["parent"]);
  const restored = JSON.parse(JSON.stringify(ledger));
  assertRepairLedger(restored);
  // A repeat of the charged event is free; a new event on the path is not.
  chargeRepair(restored, "item/a/execute/0", "implementation", ["parent"]);
  assert.equal(consumption(restored).implementationRepairs, 1);
  assert.throws(
    () =>
      chargeRepair(restored, "item/b/execute/0", "implementation", ["parent"]),
    /path.*exhausted/,
  );
  const initial = { items: [item("parent")] };
  const state = {
    graphRevisions: [{ graph: initial }],
    graph: {
      items: [{ ...item("parent"), children: ["child"] }, item("child")],
    },
    work: { child: { status: "pending" } },
  };
  assert.deepEqual(repairScopes(state, "child"), ["parent"]);
  assert.throws(
    () =>
      chargeRepair(
        restored,
        "item/c/execute/0",
        "implementation",
        repairScopes(state, "child"),
      ),
    /exhausted/,
  );
});
test("a wrong result retains its failure and rejects ambiguity and unchanged correction", () => {
  const failedAttempt = () => ({
    status: "failed",
    step: "validate",
    attempt: "first",
    baseSha: "a".repeat(40),
    changeRef: "b".repeat(40),
    treeSha: "c".repeat(40),
  });
  const work = failedAttempt();
  const state = {
    autonomy: autonomy(),
    graph: { items: [item()] },
    work: { result: work },
  };
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("required command failed"),
  );
  const correction = {
    kind: "implementation",
    failureDigest: work.recovery.failure.digest,
    actor: "fixture",
    diagnosis: "The result is missing its required content",
    correction: "Write the required content from the accepted base",
  };
  applyWorkCorrection(state, "result", correction);
  // The correction starts a new attempt and archives the failed one.
  const next = state.work.result;
  assert.equal(next.status, "pending");
  assert.equal(next.attempt, undefined);
  assert.equal(next.recovery.history[0].work.attempt, "first");
  assert.equal(
    next.recovery.history[0].failure.detail,
    "required command failed",
  );
  state.work.result = { ...failedAttempt(), recovery: next.recovery };
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("required command failed"),
  );
  assert.throws(
    () => applyWorkCorrection(state, "result", correction),
    /Unchanged/,
  );
  state.work.result.integratedSha = "a".repeat(40);
  assert.throws(
    () => applyWorkCorrection(state, "result", correction),
    /unsettled/,
  );
});
test("a published result that fails a required check is repaired by a new attempt that republishes it", () => {
  const head = "b".repeat(40);
  const work = {
    status: "failed",
    attempt: "first",
    baseSha: "a".repeat(40),
    changeRef: head,
    treeSha: "c".repeat(40),
    pullRequest: 7,
  };
  const state = {
    autonomy: autonomy(),
    graph: { items: [item()] },
    work: { result: work },
  };
  const failure = new StepFault({
    kind: "work",
    evidence: { detail: "Required checks failed on PR #7: quality" },
  });
  assert.equal(recordWorkFailure(state, "result", failure), true);
  assert.equal(work.recovery.failure.classification, "implementation");
  applyWorkCorrection(state, "result", {
    kind: "implementation",
    failureDigest: work.recovery.failure.digest,
    actor: "fixture",
    diagnosis: "The quality check rejects the formatting",
    correction: "Format the result as the quality check requires",
  });
  const next = state.work.result;
  assert.equal(next.status, "pending");
  assert.equal(next.pullRequest, undefined);
  // The new attempt pushes over the published head with a lease.
  assert.deepEqual(earlierHeads(next), [head]);
  assert.equal(next.recovery.history[0].work.pullRequest, 7);
  // Once integrated, the result is no longer the attempt's to repair.
  const merged = {
    ...structuredClone(work),
    status: "failed",
    integratedSha: "d".repeat(40),
  };
  delete merged.recovery;
  const integrated = { ...state, work: { result: merged } };
  assert.equal(recordWorkFailure(integrated, "result", failure), false);
});
test("settled failures ignore sibling processes while correction still requires global quiescence", () => {
  for (const [error, classification] of [
    [
      new CandidateValidationFailure("required command failed"),
      "implementation",
    ],
    [
      // A worker that settled with a failed result.
      new StepFault({ kind: "work", evidence: { detail: "worker failed" } }),
      "implementation",
    ],
  ]) {
    const state = {
      autonomy: autonomy(),
      graph: { items: [item()] },
      coordinator: {
        processes: [{ pid: 123, identity: "sibling collection" }],
      },
      work: {
        result: {
          status: "failed",
          step: "validate",
          attempt: "first",
          baseSha: "a".repeat(40),
          changeRef: "b".repeat(40),
          treeSha: "c".repeat(40),
        },
      },
    };
    assert.equal(recordWorkFailure(state, "result", error), true);
    assert.equal(
      state.work.result.recovery.failure.classification,
      classification,
    );
    assert.throws(
      () =>
        applyWorkCorrection(state, "result", {
          kind: "implementation",
          failureDigest: state.work.result.recovery.failure.digest,
          actor: "fixture",
          diagnosis: "Declared prerequisite absent",
          correction: "Restore the same declared prerequisite",
        }),
      /unsettled/,
    );
    assert.equal(state.charges, undefined);
    for (const guard of [
      { work: { integratedSha: "a".repeat(40) } },
      { coordinator: { cancelError: "owned cancellation unresolved" } },
    ]) {
      const uncertain = structuredClone(state);
      Object.assign(uncertain.work.result, guard.work);
      Object.assign(uncertain.coordinator, guard.coordinator);
      assert.equal(recordWorkFailure(uncertain, "result", error), false);
      // Not isolated: a wrong result past these boundaries is a decision.
      assert.equal(
        uncertain.work.result.recovery.failure.classification,
        "decision",
      );
    }
    assert.equal(
      recordWorkFailure(state, "result", new Error("ownership unresolved")),
      false,
    );
    assert.equal(state.work.result.recovery.failure.classification, "defect");
  }
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: diagnosed lost-connectivity repair preserves original attempt, cleans its workspace and completes without duplicate worker`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repair-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/repair-${delivery}`,
        delivery,
        2,
      );
      config.autonomy = autonomy();
      const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
      const fixture = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          result: {
            failAttempts: 1,
            files: [{ path: "result.txt", text: "accepted\n" }],
          },
        },
        planningModel: model(graph),
      });
      const state = await fixture.application.runObjective(1);
      assert.equal(state.finalValidation.passed, true);
      assert.equal(consumption(state).implementationRepairs, 1);
      const work = state.work.result;
      assert.equal(work.recovery.history.length, 1);
      const prior = work.recovery.history[0];
      assert.notEqual(work.attempt, prior.work.attempt);
      assert.equal(prior.failure.unfinishedEdits, "removed");
      assert.equal(
        prior.failure.continuation,
        "new-attempt-from-accepted-base",
      );
      const starts = readEvents(fixture.eventsPath).filter(
        (event) => event.type === "start",
      );
      assert.equal(starts.length, 2);
      assert.ok(starts.every((event) => !existsSync(event.worktree)));
      assert.equal(starts[0].baseSha, starts[1].baseSha);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: a validation environment failure waits uncharged; once restored, retry validates the same candidate`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-env-repair-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/env-repair-${delivery}`,
        delivery,
        2,
      );
      config.autonomy = autonomy();
      const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
      let diagnoses = 0;
      const descriptor = {
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          result: { files: [{ path: "result.txt", text: "accepted\n" }] },
        },
        planningModel: model(graph, () => {
          diagnoses++;
          throw new Error("an environment fault is never diagnosed");
        }),
      };
      const fixture = makeApplication(descriptor);
      // The controller cannot prepare validation: the item's directory is a file.
      const validationRoot = join(
        stateRoot(config.repository),
        "validation",
        "result",
      );
      mkdirSync(join(stateRoot(config.repository), "validation"), {
        recursive: true,
      });
      writeFileSync(validationRoot, "not a directory\n");
      const waiting = await fixture.application.runObjective(1);
      const stopped = waiting.work.result;
      assert.equal(stopped.status, "running");
      assert.equal(stopped.wait?.kind, "prerequisite");
      assert.match(stopped.wait.detail, /Validation environment unavailable/);
      assert.equal(stopped.recovery?.failure, undefined);
      assert.equal(stopped.validation, undefined);
      assert.equal(waiting.charges, undefined);
      assert.equal(diagnoses, 0);
      const candidate = stopped.treeSha;
      assert.match(candidate, /^[a-f0-9]{40}$/);
      const workers = () =>
        readEvents(fixture.eventsPath).filter((event) => event.type === "start")
          .length;
      const started = workers();
      // Restoring the environment alone changes nothing; the retry answers it.
      rmSync(validationRoot);
      assert.equal(fixture.application.retryWorkItem(1, "result"), "step");
      const done =
        await makeApplication(descriptor).application.runObjective(1);
      assert.equal(done.finalValidation.passed, true);
      assert.equal(done.work.result.validation.treeSha, candidate);
      assert.equal(done.work.result.recovery, undefined);
      assert.equal(done.charges, undefined);
      assert.equal(diagnoses, 0);
      assert.equal(workers(), started);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
for (const kind of [
  "planning-output",
  "planning-evidence",
  "planning-choice",
  "operator",
])
  test(`planning ${kind}: correction is persisted, counted and independently re-reviewed`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-plan-repair-"));
    try {
      const target = createTarget(root);
      const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
      let generates = 0,
        reviews = 0;
      const snapshots = [];
      const state = { autonomy: autonomy() };
      const planningBody = `${body}\n## Worker material\nRetain the exact literal RELEASE_TOKEN in the worker brief. Representation is delegated to the developer. Security destination policy requires the security owner decision.\n`;
      const planner = {
        generateStructured: async (request) => {
          if (request.purpose === "diagnosis")
            return {
              kind,
              diagnosis:
                kind === "operator"
                  ? "Missing security owner policy decision"
                  : "Available source requires this exact deliverable",
              correction:
                "Preserve the source-required result and its exact commands",
            };
          generates++;
          const candidate = withCoverage(request, graph);
          if (kind === "planning-output" && generates === 1)
            candidate.items[0].sourceAssets = [
              {
                kind: "repository",
                path: "synthetic.png",
                role: "source",
                mediaType: "image/png",
                visibility: "repository",
              },
            ];
          if (generates > 1 && kind !== "operator")
            candidate.items[0].brief +=
              " Retain RELEASE_TOKEN; choose a simple text representation within declared ownership.";
          return candidate;
        },
        reviewGraph: async (request) => {
          reviews++;
          if (kind === "planning-evidence" && reviews > 1)
            assert.match(request.graph.items[0].brief, /RELEASE_TOKEN/);
          return {
            packetId: request.reviewPacket.id,
            findings:
              reviews === 1 && kind !== "planning-output"
                ? [
                    {
                      evidenceIndices: [0],
                      detail:
                        kind === "operator"
                          ? "A security owner must choose policy"
                          : "Worker-visible brief omitted the available required literal",
                      question:
                        kind === "operator"
                          ? "Which policy?"
                          : "Use the required literal",
                    },
                  ]
                : [],
          };
        },
      };
      const candidate = await compilePlan(
        1,
        planningBody,
        target.baseSha,
        target.checkout,
        planner,
        undefined,
        undefined,
        undefined,
        { state, save: () => snapshots.push(structuredClone(state)) },
      );
      assert.equal(
        candidate.review.status,
        kind === "operator" ? "needs-human" : "clean",
      );
      assert.equal(consumption(state).planningRevisions, 1);
      assert.ok(
        snapshots.some(
          (snapshot) => snapshot.planningRecovery?.phase === "submitted",
        ),
      );
      if (kind !== "operator") assert.equal(generates, 2);
      assert.ok(reviews >= 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
test("planning allowance survives restart and stops before a new model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-cap-"));
  try {
    const target = createTarget(root);
    const state = {
      autonomy: autonomy(),
      // Two earlier events spent the planning allowance.
      charges: {
        "objective/amend/earlier-1": {
          allowances: ["planningRevisions"],
          scopes: ["$planning"],
        },
        "objective/amend/earlier-2": {
          allowances: ["planningRevisions"],
          scopes: ["$planning"],
        },
      },
    };
    let calls = 0;
    const planner = {
      generateStructured: async () => {
        calls++;
        return { bad: "shape" };
      },
      reviewGraph: async (request) => ({
        packetId: request.reviewPacket.id,
        findings: [],
      }),
    };
    await assert.rejects(
      compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        planner,
        undefined,
        undefined,
        undefined,
        { state, save: () => {} },
      ),
      /allowance is exhausted/,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        planner,
        undefined,
        undefined,
        undefined,
        { state: JSON.parse(JSON.stringify(state)), save: () => {} },
      ),
      /recovery stopped/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: exhausted isolated path holds descendants while safe independent work integrates`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-scoped-hold-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/scoped-${delivery}`,
        delivery,
        2,
      );
      const body =
        "# Recovery fixture\n## Acceptance\n- failed.txt exists\n- peer.txt exists\n- child.txt exists\n## Commands\n- test -s failed.txt\n- test -s peer.txt\n- test -s child.txt\n## Final validation\n- test -s child.txt\n";
      const graph = {
        objective: 1,
        baseSha: target.baseSha,
        items: [item("failed"), item("peer"), item("child", ["failed"])],
      };
      const fixture = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          failed: { failAttempts: 99 },
          peer: { files: [{ path: "peer.txt", text: "done\n" }] },
          child: { files: [{ path: "child.txt", text: "no\n" }] },
        },
        planningModel: model(graph),
      });
      const plan = await fixture.application.planObjective(1);
      const policy = autonomy();
      policy.repairPolicy.perPath.implementationRepairs = 0;
      const projection = await fixture.github.projectGraph({
        graph: plan.graph,
        objectiveIssue: 1,
      });
      const state = {
        schemaVersion: 7,
        repository: config.repository,
        objective: 1,
        runId: "fixture",
        configDigest: "d".repeat(64),
        baseSha: target.baseSha,
        graph: plan.graph,
        autonomy: policy,
        capacity: { concurrency: config.execution.concurrency },
        planGraphDigest: plan.graphDigest,
        issueByItemId: projection.issueByItemId,
        work: Object.fromEntries(
          graph.items.map((item) => [item.id, { status: "pending" }]),
        ),
      };
      const { RegularDelivery } = await import("../dist/delivery/regular.js");
      const { runRegularGraph } = await import(
        "../dist/delivery/regular-runner.js"
      );
      const { runNativeGraph } = await import(
        "../dist/delivery/native-runner.js"
      );
      await (delivery === "regular" ? runRegularGraph : runNativeGraph)({
        config,
        objective: 1,
        objectiveBody: body,
        root: join(root, "run"),
        state,
        driver: fixture.driver,
        delivery: new RegularDelivery(config.checkout, fixture.github),
        contentStore: fixture.contentStore,
        github: fixture.github,
        planningModel: model(graph),
        save: () => {},
        active: new Map(),
        cancelled: () => false,
      });
      assert.equal(state.work.failed.status, "failed");
      assert.equal(state.work.peer.status, "done");
      assert.equal(state.work.child.status, "pending");
      assert.equal(
        readEvents(fixture.eventsPath).filter(
          (event) => event.type === "start" && event.item === "failed",
        ).length,
        1,
      );
      assert.match(
        state.work.failed.recovery.failure.decision,
        /allowance exhausted/,
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: an Objective decision during delivery leaves the Work Item in place, and delivery resumes once it is answered`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-objective-scope-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/objective-scope-${delivery}`,
        delivery,
        1,
      );
      const graph = {
        objective: 1,
        baseSha: target.baseSha,
        items: [item()],
      };
      const fixture = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          result: { files: [{ path: "result.txt", text: "done\n" }] },
        },
        planningModel: model(graph),
      });
      const plan = await fixture.application.planObjective(1);
      const projection = await fixture.github.projectGraph({
        graph: plan.graph,
        objectiveIssue: 1,
      });
      const state = {
        schemaVersion: 7,
        repository: config.repository,
        objective: 1,
        runId: "fixture",
        configDigest: "d".repeat(64),
        baseSha: target.baseSha,
        graph: plan.graph,
        autonomy: autonomy(),
        capacity: { concurrency: config.execution.concurrency },
        planGraphDigest: plan.graphDigest,
        issueByItemId: projection.issueByItemId,
        work: { result: { status: "pending" } },
      };
      const { RegularDelivery } = await import("../dist/delivery/regular.js");
      const { runRegularGraph } = await import(
        "../dist/delivery/regular-runner.js"
      );
      const { runNativeGraph } = await import(
        "../dist/delivery/native-runner.js"
      );
      // The Objective re-observation before publication finds a foreign
      // edit: a decision on the Objective, not on the Work Item.
      let edited = true;
      const reconcile = async () => {
        if (edited && state.work.result.step === "deliver")
          throw new StepFault({
            kind: "decision",
            question: "The Objective issue body changed outside Factory",
            evidence: [],
          });
      };
      const run = () =>
        (delivery === "regular" ? runRegularGraph : runNativeGraph)({
          config,
          objective: 1,
          objectiveBody: body,
          root: join(root, "run"),
          state,
          driver: fixture.driver,
          delivery: new RegularDelivery(config.checkout, fixture.github),
          contentStore: fixture.contentStore,
          github: fixture.github,
          planningModel: model(graph),
          save: () => {},
          active: new Map(),
          cancelled: () => false,
          reconcile,
        });
      await run();
      assert.equal(state.work.result.status, "running");
      assert.equal(state.work.result.step, "deliver");
      assert.equal(state.work.result.recovery, undefined);
      assert.equal(state.work.result.pullRequest, undefined);
      // The operator answers the Objective's decision; delivery resumes.
      edited = false;
      await run();
      assert.equal(state.work.result.status, "done");
      assert.equal(
        readEvents(fixture.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("run's durable planning carries consumed planning allowance into activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-durable-plan-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/durable-plan");
    config.capture = { enabled: false, maxBytesPerInvocation: 1024 };
    config.autonomy = autonomy();
    const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
    let calls = 0;
    const planner = model(graph, () => ({
      kind: "planning-output",
      diagnosis:
        "Generated synthetic source path was not in the supplied packet",
      correction: "Use only available source inputs",
    }));
    const generate = planner.generateStructured;
    planner.generateStructured = async (request) => {
      if (request.purpose === "diagnosis") return generate(request);
      const response = await generate(request);
      if (++calls === 1)
        response.items[0].sourceAssets = [
          {
            kind: "repository",
            path: "invented.png",
            role: "source",
            mediaType: "image/png",
            visibility: "repository",
          },
        ];
      return response;
    };
    const fixture = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        result: { files: [{ path: "result.txt", text: "accepted\n" }] },
      },
      planningModel: planner,
    });
    const state = await fixture.application.runObjective(1);
    assert.equal(calls, 2);
    assert.equal(state.finalValidation.passed, true);
    assert.equal(consumption(state).planningRevisions, 1);
    const reloaded = JSON.parse(JSON.stringify(state));
    assertRepairLedger(reloaded);
    const retained = reloaded.planningRecovery;
    assert.equal(retained.phase, "complete");
    assert.equal(retained.response, undefined);
    assert.equal(retained.history.length, 1);
    const failure = retained.history[0];
    assert.match(failure.detail, /invented.png/);
    assert.equal(failure.failure, failureDigest(failure.detail));
    assert.deepEqual(
      failure.invocations.map((entry) => entry.phase),
      ["compile", "diagnosis"],
    );
    for (const receipt of [...failure.invocations, ...retained.invocations]) {
      assert.match(receipt.id, /^[a-f0-9-]{36}$/);
      assert.match(receipt.resultDigest, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(
      retained.invocations.map((entry) => entry.phase),
      ["compile", "graph-review"],
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: an invalid review answer is asked again with its error on the exact worker result`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-evidence-repair-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/evidence-repair-${delivery}`,
        delivery,
      );
      config.autonomy = autonomy();
      const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
      const planner = model(graph);
      let calls = 0;
      const reviewedTrees = [];
      planner.reviewResult = async (request) => {
        if (request.reviewPhase !== "objective-review") {
          calls++;
          reviewedTrees.push(request.treeSha);
          if (calls === 1)
            return {
              findings: [
                {
                  criterionIndex: 0,
                  verdict: "pass",
                  evidenceIndices: ["invented-source-id"],
                  detail: "transport only",
                  question: "",
                },
              ],
            };
          assert.match(
            request.previousInvalid,
            /Independent review answer was invalid/,
          );
        }
        return reviewer(request);
      };
      const fixture = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          result: { files: [{ path: "result.txt", text: "accepted\n" }] },
        },
        planningModel: planner,
      });
      const done = await fixture.application.runObjective(1);
      assert.equal(done.finalValidation.passed, true);
      // A re-ask is the review step's paid repeat, not a repair.
      assert.equal(consumption(done).resultRereviews, 0);
      assert.equal(calls, 2);
      assert.equal(new Set(reviewedTrees).size, 1);
      assert.equal(
        readEvents(fixture.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
      assert.equal(done.work.result.recovery, undefined);
      assert.equal(done.work.result.acceptanceDecisions, undefined);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a lost diagnosis is reissued once charged; ambiguous publication never authorizes another attempt", async () => {
  const { diagnoseWorkRepair } = await import("../dist/work-repair.js");
  const work = {
    status: "failed",
    step: "validate",
    attempt: "first",
    baseSha: "a".repeat(40),
    changeRef: "b".repeat(40),
    treeSha: "c".repeat(40),
  };
  const state = {
    autonomy: autonomy(),
    graph: { items: [item()] },
    work: { result: work },
    baseSha: "a".repeat(40),
    runId: "r",
  };
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("failed command"),
  );
  let calls = 0;
  const planner = {
    generateStructured: async () => {
      calls++;
      throw new Error("transport outcome unknown");
    },
  };
  await assert.rejects(
    diagnoseWorkRepair({
      state,
      item: item(),
      model: planner,
      save: () => {},
      stopped: () => false,
    }),
    /unknown/,
  );
  assert.equal(work.recovery.phase, "diagnosing");
  const charged = consumption(state).implementationRepairs;
  // A restart asks again; the diagnosis was already charged when first sent.
  const restarted = JSON.parse(JSON.stringify(state));
  await assert.rejects(
    diagnoseWorkRepair({
      state: restarted,
      item: item(),
      model: planner,
      save: () => {},
      stopped: () => false,
    }),
    /unknown/,
  );
  assert.equal(calls, 2);
  assert.equal(consumption(restarted).implementationRepairs, charged);
  work.pullRequest = 1;
  recordWorkFailure(state, "result", new Error("publication response lost"));
  // Unclassified: a defect, never repaired by diagnosis.
  assert.equal(work.recovery.failure.classification, "defect");
  assert.equal(
    await diagnoseWorkRepair({
      state,
      item: item(),
      model: planner,
      save: () => {},
      stopped: () => false,
    }),
    false,
  );
  assert.equal(calls, 2);
});

test("a failure while paused or an amendment is pending is diagnosed once the run goes on", async () => {
  const { diagnoseWorkRepair, resumeDiagnoses } = await import(
    "../dist/work-repair.js"
  );
  const work = {
    status: "failed",
    step: "validate",
    attempt: "first",
    baseSha: "a".repeat(40),
    changeRef: "b".repeat(40),
    treeSha: "c".repeat(40),
  };
  const state = {
    autonomy: autonomy(),
    graph: { items: [item()] },
    work: { result: work },
    baseSha: "a".repeat(40),
    runId: "r",
  };
  assert.equal(
    recordWorkFailure(
      state,
      "result",
      new CandidateValidationFailure("failed command"),
    ),
    true,
  );
  let calls = 0;
  const planner = model({ items: [item()] }, () => {
    calls++;
    return {
      decision: "repair",
      diagnosis: "The result file was left empty by the worker",
      correction: "Write non-empty content to result.txt",
    };
  });
  // The Objective is paused (or an amendment is pending) when the item fails.
  assert.equal(
    await diagnoseWorkRepair({
      state,
      item: item(),
      model: planner,
      save: () => {},
      stopped: () => true,
    }),
    false,
  );
  assert.equal(calls, 0);
  // The diagnosis is due, not dropped: the next pass asks it.
  assert.equal(work.recovery.phase, "diagnosing");
  const charged = consumption(state).implementationRepairs;
  await resumeDiagnoses({
    state,
    model: planner,
    save: () => {},
    stopped: () => false,
  });
  assert.equal(calls, 1);
  assert.equal(state.work.result.status, "pending");
  assert.equal(state.work.result.recovery.phase, "ready");
  assert.equal(consumption(state).implementationRepairs, charged);
});

test("real structured adapter uses a diagnosis request rather than a graph-compilation prompt", async (t) => {
  const { Codex } = await import("@openai/codex-sdk");
  const { CodexPlanningModel } = await import("../dist/compiler.js");
  const { installedControllerCapabilities, CONTROLLER_CAPABILITIES_DIGEST } =
    await import("../dist/controller-capabilities.js");
  const result = {
    decision: "operator",
    diagnosis: "Missing policy",
    correction: "",
  };
  let prompt;
  t.mock.method(Codex.prototype, "startThread", () => ({
    runStreamed: async (text) => {
      prompt = text;
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "a",
              type: "agent_message",
              text: JSON.stringify(result),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const planner = new CodexPlanningModel(process.cwd(), selection, selection);
  const observed = await planner.generateStructured({
    purpose: "diagnosis",
    objective: "Diagnose only the preserved failure",
    baseSha: "a".repeat(40),
    sources: [],
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    schema: {
      type: "object",
      properties: {
        decision: { type: "string" },
        diagnosis: { type: "string" },
        correction: { type: "string" },
      },
      required: ["decision", "diagnosis", "correction"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(observed, result);
  assert.match(prompt, /requested diagnostic JSON/);
  assert.doesNotMatch(prompt, /Compiler choices \(JSON data\)/);
});

test("a real human-owned planning decision resolves the exact persisted plan without repeating models", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-human-plan-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/human-plan");
    config.autonomy = autonomy();
    const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
    let calls = 0;
    const planner = model(graph, () => ({
      kind: "operator",
      diagnosis: "Policy selection belongs to the owner",
      correction: "",
    }));
    const generate = planner.generateStructured;
    planner.generateStructured = async (request) => {
      calls++;
      return generate(request);
    };
    planner.reviewGraph = async (request) => ({
      packetId: request.reviewPacket.id,
      findings: [
        {
          evidenceIndices: [0],
          detail: "Source needs an owner interpretation",
          question: "Which delivery policy applies?",
        },
      ],
    });
    const fixture = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        result: { files: [{ path: "result.txt", text: "accepted\n" }] },
      },
      planningModel: planner,
    });
    const waiting = await fixture.application.runObjective(1);
    assert.equal(waiting.schemaVersion, 8);
    assert.equal(waiting.plan.review.status, "needs-human");
    await fixture.application.decidePlan(1, {
      plan: shortPlanDigest(waiting.plan),
      actor: "fixture-owner",
      outcome: "accept",
      reason: "Answer applies to this exact reviewed packet",
      answer: "Use the existing declared target policy",
    });
    const before = calls;
    const done = await fixture.application.runObjective(1);
    assert.equal(done.finalValidation.passed, true);
    assert.equal(calls, before);
    // The finding's diagnosis was charged once and left to the owner.
    assert.equal(consumption(done).planningRevisions, 1);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause after known planning response preserves compilation for resume with repair disabled and no extra charge", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-planning-pause-"));
  try {
    const target = createTarget(root);
    const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
    const policy = autonomy();
    policy.repairClasses = [];
    const state = { autonomy: policy };
    let paused = false,
      generations = 0,
      reviews = 0;
    const planner = {
      generateStructured: async (request) => {
        generations++;
        paused = true;
        return withCoverage(request, graph);
      },
      reviewGraph: async (request) => {
        reviews++;
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    };
    const compile = () =>
      compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        planner,
        undefined,
        undefined,
        undefined,
        { state, save: () => {}, stopped: () => paused },
      );
    await assert.rejects(compile(), /paused/);
    assert.equal(state.planningRecovery.phase, "ready");
    assert.ok(state.planningRecovery.response);
    assert.equal(reviews, 0);
    assert.equal(state.charges, undefined);
    paused = false;
    const accepted = await compile();
    assert.equal(accepted.review.status, "clean");
    assert.equal(generations, 1);
    assert.equal(reviews, 1);
    assert.equal(state.charges, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
