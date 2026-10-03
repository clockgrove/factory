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
import {
  chargeRepair,
  emptyConsumption,
  repairScopes,
  assertRepairLedger,
  failureDigest,
} from "../dist/repair-policy.js";
import {
  applyWorkCorrection,
  recordWorkFailure,
  CandidateValidationFailure,
  CandidateEnvironmentFailure,
  SettledAttemptFailure,
  prepareEvidenceRecovery,
} from "../dist/work-repair.js";
import { validateAuthority } from "../dist/admission.js";
import {
  compilePlan,
  objectiveCriteria,
  CodexPlanningModel,
} from "../dist/compiler.js";
import { coverageObligations, aggregateAcceptance } from "../dist/qa.js";
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

const authority = () => ({
  schemaVersion: 1,
  actor: "fixture",
  reason: "Bounded diagnosed recovery",
  executionConsent: true,
  serviceConsent: false,
  objectives: [1],
  allowances: {
    planningRevisions: 2,
    implementationRepairs: 2,
    resultRereviews: 2,
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
      planningRevisions: 2,
      implementationRepairs: 1,
      resultRereviews: 1,
    },
  },
  resources: { maxConcurrency: 2 },
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

test("old admissions gain no repair policy and inherited scopes cannot reset caps", () => {
  const old = authority();
  delete old.repairPolicy;
  validateAuthority(old);
  assert.throws(
    () => chargeRepair({ authority: old }, "implementation", ["parent"]),
    /not admitted/,
  );
  const ledger = { authority: authority() };
  chargeRepair(ledger, "implementation", ["parent"]);
  const restored = JSON.parse(JSON.stringify(ledger));
  assertRepairLedger(restored);
  assert.throws(
    () => chargeRepair(restored, "implementation", ["parent"]),
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
      chargeRepair(restored, "implementation", repairScopes(state, "child")),
    /exhausted/,
  );
});
test("exact candidate recovery retains failure and rejects ambiguity and unchanged correction", () => {
  const work = {
    status: "failed",
    step: "validate",
    attempt: "first",
    baseSha: "a".repeat(40),
    changeRef: "b".repeat(40),
    treeSha: "c".repeat(40),
  };
  const state = {
    admission: { authority: authority() },
    graph: { items: [item()] },
    work: { result: work },
  };
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("required command failed"),
  );
  const correction = {
    kind: "validation-environment",
    failureDigest: work.recovery.failure.digest,
    actor: "fixture",
    diagnosis: "Controller temporary path exceeded the tool limit",
    correction:
      "Restore the declared environment using a shorter supported temporary directory",
  };
  applyWorkCorrection(state, "result", correction);
  assert.equal(work.attempt, "first");
  assert.equal(work.treeSha, "c".repeat(40));
  assert.equal(work.step, "validate");
  assert.equal(work.recovery.history[0].work.error, undefined);
  assert.equal(
    work.recovery.history[0].failure.detail,
    "required command failed",
  );
  work.status = "failed";
  recordWorkFailure(
    state,
    "result",
    new CandidateValidationFailure("required command failed"),
  );
  assert.throws(
    () => applyWorkCorrection(state, "result", correction),
    /Unchanged/,
  );
  work.pendingEffect = "publication";
  assert.throws(
    () => applyWorkCorrection(state, "result", correction),
    /unsettled/,
  );
});
test("settled failures ignore sibling processes while correction still requires global quiescence", () => {
  for (const [error, classification] of [
    [
      new CandidateValidationFailure("required command failed"),
      "implementation",
    ],
    [
      new CandidateEnvironmentFailure("temporary path unavailable"),
      "validation-environment",
    ],
    [new SettledAttemptFailure("worker stopped"), "interruption"],
  ]) {
    const state = {
      admission: { authority: authority() },
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
          kind: "validation-environment",
          failureDigest: state.work.result.recovery.failure.digest,
          actor: "fixture",
          diagnosis: "Declared prerequisite absent",
          correction: "Restore the same declared prerequisite",
        }),
      /unsettled/,
    );
    assert.equal(state.allowanceConsumption, undefined);
    for (const guard of [
      { work: { pendingEffect: "publication" } },
      { work: { pullRequest: 1 } },
      { coordinator: { cancelError: "owned cancellation unresolved" } },
    ]) {
      const uncertain = structuredClone(state);
      Object.assign(uncertain.work.result, guard.work);
      Object.assign(uncertain.coordinator, guard.coordinator);
      assert.equal(recordWorkFailure(uncertain, "result", error), false);
      assert.equal(
        uncertain.work.result.recovery.failure.classification,
        "uncertain",
      );
    }
    assert.equal(
      recordWorkFailure(state, "result", new Error("ownership unresolved")),
      false,
    );
    assert.equal(
      state.work.result.recovery.failure.classification,
      "uncertain",
    );
  }
});

test("transport recovery never accepts semantic findings or invents accounting", () => {
  const state = {
    admission: { authority: authority() },
    graph: { items: [item()] },
    work: {
      result: {
        status: "waiting",
        step: "approve-result",
        attempt: "original",
        baseSha: "a".repeat(40),
        changeRef: "b".repeat(40),
        treeSha: "c".repeat(40),
        acceptancePending: { detail: "semantic disagreement" },
      },
    },
  };
  assert.equal(prepareEvidenceRecovery(state, "result"), false);
  state.work.result.acceptancePending.reviewRejection = {
    field: "source",
    reason: "unknown-source",
  };
  assert.equal(prepareEvidenceRecovery(state, "result"), true);
  assert.equal(state.work.result.attempt, "original");
  assert.equal(state.work.result.status, "running");
  assert.equal(state.allowanceConsumption.resultRereviews, 1);
  assert.equal(state.work.result.acceptanceDecisions, undefined);
  assert.equal(state.work.result.recovery.history[0].work.usage, undefined);
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
      const plan = await fixture.application.planObjective(1);
      const admitted = await fixture.application.admitObjective(
        1,
        plan,
        authority(),
      );
      const state = await fixture.application.runObjective(1, plan, admitted);
      assert.equal(state.finalValidation.passed, true);
      assert.equal(state.allowanceConsumption.implementationRepairs, 1);
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
test("validation environment path failure revalidates the byte-identical candidate after correction", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-env-repair-"));
  try {
    const target = createTarget(root, { "result.txt": "accepted\n" });
    const tree = git(target.checkout, "rev-parse", "HEAD^{tree}");
    await assert.rejects(
      validateTree(
        target.checkout,
        join(root, "x".repeat(260)),
        target.baseSha,
        tree,
        ["test -s result.txt"],
      ),
      CandidateEnvironmentFailure,
    );
    const evidence = await validateTree(
      target.checkout,
      join(root, "short"),
      target.baseSha,
      tree,
      ["test -s result.txt"],
    );
    assert.equal(evidence.treeSha, tree);
    assert.equal(evidence.commands.length, 1);
  } finally {
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
      const state = { authority: authority() };
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
        [],
        { state, save: () => snapshots.push(structuredClone(state)) },
      );
      assert.equal(
        candidate.review.status,
        kind === "operator" ? "needs-human" : "clean",
      );
      assert.equal(state.allowanceConsumption.planningRevisions, 1);
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
      authority: authority(),
      allowanceConsumption: { ...emptyConsumption(), planningRevisions: 2 },
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
        [],
        { state, save: () => {} },
      ),
      /allowance exhausted/,
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
        [],
        { state: JSON.parse(JSON.stringify(state)), save: () => {} },
      ),
      /allowance exhausted/,
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
      const policy = authority();
      policy.repairPolicy.perPath.implementationRepairs = 0;
      const projection = await fixture.github.projectGraph({
        graph: plan.graph,
        objectiveIssue: 1,
      });
      const state = {
        schemaVersion: 4,
        repository: config.repository,
        objective: 1,
        runId: "fixture",
        configDigest: "d".repeat(64),
        baseSha: target.baseSha,
        graph: plan.graph,
        admission: { authority: policy },
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

test("durable plan --authority carries consumed planning allowance into exact activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-durable-plan-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/durable-plan");
    config.capture = { enabled: false, maxBytesPerInvocation: 1024 };
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
    const plan = await fixture.application.planObjective(1, [], authority());
    assert.equal(plan.review.status, "clean");
    assert.equal(calls, 2);
    const same = await fixture.application.planObjective(1, [], authority());
    assert.deepEqual(same, plan);
    assert.equal(calls, 2);
    const admitted = await fixture.application.admitObjective(
      1,
      plan,
      authority(),
    );
    const state = await fixture.application.runObjective(1, plan, admitted);
    assert.equal(state.finalValidation.passed, true);
    assert.equal(state.allowanceConsumption.planningRevisions, 1);
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
  test(`${delivery}: compound: persisted repair survives controller handoff and restart without resetting allowance`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-env-control-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/env-control-${delivery}`,
        delivery,
      );
      const gate = join(root, "readiness");
      const command = `test -f '${gate}'`;
      const aggregateCriterion = aggregateAcceptance({ id: "aggregate" })[0];
      const source = `${body.replace("## Commands", `- The integrated conditional check passes; an actual failure requires diagnosed authorized correction\n- ${aggregateCriterion}\n## Commands`)}\n## Environment\nThe controller requires this already-provisioned environment prerequisite.\n- ${command}\n`;
      const graph = {
        objective: 1,
        baseSha: target.baseSha,
        items: [
          {
            ...item(),
            validation: [
              ...item().validation,
              { command, provenance: "source-declared", source: "OBJECTIVE" },
            ],
          },
          {
            ...item("qa", ["result"]),
            kind: "qa",
            ownedPaths: [],
            acceptance: [
              "The integrated conditional check passes; an actual failure requires diagnosed authorized correction",
            ],
            validation: [
              { command, provenance: "source-declared", source: "OBJECTIVE" },
            ],
          },
          {
            ...item("aggregate", ["qa"]),
            kind: "aggregate",
            children: ["qa"],
            ownedPaths: [],
            acceptance: [aggregateCriterion],
            validation: [],
          },
        ],
      };
      graph.coverage = coverageObligations(
        source,
        objectiveCriteria(source),
      ).map((obligation, index) => ({
        criterionId: obligation.criterionId,
        itemId: ["result", "qa", "aggregate"][index],
        proof:
          index === 0
            ? { kind: "final-review" }
            : { kind: "integrated-semantic", acceptanceIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      }));
      let reviews = 0;
      const packets = [];
      const planner = model(graph);
      planner.reviewResult = async (request) => {
        reviews++;
        packets.push(request);
        return reviewer(request);
      };
      const descriptor = {
        config,
        graph,
        objectiveBody: source,
        fakeRoot: join(root, "fake"),
        actions: {
          result: { files: [{ path: "result.txt", text: "accepted\n" }] },
        },
        planningModel: planner,
      };
      const fixture = makeApplication(descriptor);
      const policy = authority();
      policy.repairClasses = ["validation-environment"];
      policy.allowances.implementationRepairs = 0;
      const plan = await fixture.application.planObjective(1);
      const admitted = await fixture.application.admitObjective(
        1,
        plan,
        policy,
      );
      const { readState, statePath } = await import("../dist/state-store.js");
      const { requestControl } = await import("../dist/coordinator-control.js");
      const running = fixture.application.runObjective(1, plan, admitted);
      const failed = await waitForFile(
        () => {
          const state = readState(config.repository, 1);
          return state?.work.result.status === "failed" ? state : undefined;
        },
        statePath(config.repository, 1),
        "preserved validation candidate",
      );
      writeFileSync(gate, "ready\n");
      const work = failed.work.result;
      const drained = assert.rejects(running, /drained and released ownership/);
      await requestControl(config.repository, {
        objective: 1,
        action: "handoff",
      });
      await drained;
      fixture.application.repairWorkItem(1, {
        item: "result",
        treeSha: work.treeSha,
        correction: {
          kind: "validation-environment",
          failureDigest: work.recovery.failure.digest,
          actor: "fixture",
          diagnosis: "Declared controller prerequisite was unavailable",
          correction:
            "The same declared prerequisite is now provisioned; revalidate the preserved exact candidate",
        },
      });
      const charged = readState(config.repository, 1);
      assert.equal(charged.allowanceConsumption.resultRereviews, 1);
      assert.equal(charged.work.result.attempt, work.attempt);
      const { controlObjective } = await import("../dist/runner.js");
      await controlObjective(config, { objective: 1, action: "resume" });
      const restarted = makeApplication(descriptor);
      const done = await restarted.application.runObjective(1);
      assert.equal(done.runId, charged.runId);
      assert.throws(
        () =>
          chargeRepair(structuredClone(done), "validation-environment", [
            "result",
          ]),
        /exhausted/,
      );
      assert.deepEqual(
        done.work.result.recovery.history,
        charged.work.result.recovery.history,
      );
      assert.equal(done.finalValidation.passed, true);
      assert.equal(done.work.result.attempt, work.attempt);
      assert.equal(done.work.result.treeSha, work.treeSha);
      assert.equal(
        readEvents(fixture.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
      assert.equal(done.allowanceConsumption.resultRereviews, 1);
      assert.ok(reviews >= 2);
      assert.equal(done.work.result.recovery.history[0].work.error, work.error);
      assert.equal(done.work.qa.status, "done");
      assert.equal(done.work.aggregate.status, "done");
      const resultPacket = packets.find((packet) =>
        packet.evidence.some(
          (source) => source.path === "Retained repair proof: result",
        ),
      );
      const qaPacket = packets.find((packet) =>
        packet.criteria.includes(graph.items[1].acceptance[0]),
      );
      const aggregatePacket = packets.find((packet) =>
        packet.criteria.includes(graph.items[2].acceptance[0]),
      );
      const finalPacket = packets.find(
        (packet) => packet.reviewPhase === "objective-review",
      );
      const repair = JSON.parse(
        resultPacket.evidence.find(
          (source) => source.path === "Retained repair proof: result",
        ).content,
      );
      assert.equal(
        repair.controllerFacts.failedAttempt.resultCommitSha,
        work.changeRef,
      );
      assert.equal(
        repair.controllerFacts.failedAttempt.resultTreeSha,
        work.treeSha,
      );
      assert.equal(
        repair.controllerFacts.failedAttempt.attemptId,
        work.attempt,
      );
      assert.equal(repair.controllerFacts.failedAttempt.phase, "validate");
      assert.equal(repair.controllerFacts.currentAttemptId, work.attempt);
      assert.deepEqual(repair.controllerFacts.admittedAuthority, {
        admissionDigest: done.admission.digest,
        objective: 1,
        actor: policy.actor,
        reason: policy.reason,
        executionConsent: true,
        repairClass: "validation-environment",
      });
      const preservation = repair.controllerFacts.candidatePreservation;
      assert.equal(preservation.preserved, true);
      assert.equal(preservation.sameAttempt, true);
      assert.equal(preservation.sameExecutionBase, true);
      assert.equal(preservation.unchangedOwnedPaths, true);
      assert.deepEqual(preservation.acceptedOwnedPaths, ["result.txt"]);
      assert.deepEqual(preservation.ownedPathChanges, []);
      assert.equal(preservation.failedCandidateChanges[0].path, "result.txt");
      assert.equal(
        preservation.failedCandidateChanges[0].newObject,
        git(config.checkout, "rev-parse", `${work.changeRef}:result.txt`),
      );
      assert.equal(
        repair.declaredCorrection.contentOrigin,
        "declared-diagnosis-and-correction",
      );
      assert.equal(
        repair.declaredCorrection.failureDigest,
        work.recovery.failure.digest,
      );
      assert.deepEqual(repair.controllerFacts.snapshotConsumption.objective, {
        consumed: 1,
        limit: policy.allowances.resultRereviews,
      });
      assert.deepEqual(repair.controllerFacts.snapshotConsumption.paths, [
        { scope: "result", consumed: 1, limit: 1 },
      ]);
      for (const packet of [qaPacket, aggregatePacket]) {
        const dependency = JSON.parse(
          packet.evidence.find(
            (source) => source.path === "Completed dependency results",
          ).content,
        ).work.find((entry) => entry.id === "result");
        assert.deepEqual(dependency.repair, repair);
      }
      assert.deepEqual(
        JSON.parse(finalPacket.observations).work.find(
          (entry) => entry.id === "result",
        ).repair,
        repair,
      );
      for (const corruption of [
        "history",
        "candidate",
        "candidate-base",
        "consumption",
        "admission",
        "source-binding",
      ]) {
        const broken = structuredClone(done);
        if (corruption === "history") broken.work.result.recovery.history = [];
        if (corruption === "candidate")
          broken.work.result.recovery.history[0].work.treeSha = "0".repeat(40);
        if (corruption === "candidate-base")
          delete broken.work.result.recovery.history[0].work.executionBaseSha;
        if (corruption === "consumption")
          broken.repairConsumption.result.resultRereviews = 0;
        if (corruption === "admission")
          broken.admission.authority.reason = "Unbound authority";
        if (corruption === "source-binding")
          broken.objectiveBodyDigest = "0".repeat(64);
        assert.throws(
          () =>
            workItemReviewEvidence({
              state: broken,
              item: graph.items[1],
              checkout: config.checkout,
              delivery,
            }),
          /retained failure|tree|admitted consumption|preservation bindings|Admission binding|admission differs/,
        );
        assert.throws(
          () =>
            objectiveReviewEvidence({
              state: broken,
              checkout: config.checkout,
              candidateCommitSha: broken.integratedSha,
              candidateTreeSha: git(
                config.checkout,
                "rev-parse",
                `${broken.integratedSha}^{tree}`,
              ),
            }),
          /retained failure|tree|admitted consumption|preservation bindings|Admission binding|admission differs/,
        );
      }
      for (const corruption of ["attempt", "execution-base"]) {
        const broken = structuredClone(done);
        const prior = broken.work.result.recovery.history[0].work;
        if (corruption === "attempt") prior.attempt = "stale-attempt";
        else prior.executionBaseSha = done.work.result.changeRef;
        const evidence = () =>
          workItemReviewEvidence({
            state: broken,
            item: done.graph.items.find((entry) => entry.id === "result"),
            checkout: config.checkout,
            delivery,
          });
        if (corruption === "execution-base") {
          assert.throws(evidence, /unexpected controller commit identity/);
          continue;
        }
        const proof = JSON.parse(
          evidence().find(
            (source) => source.path === "Retained repair proof: result",
          ).content,
        );
        assert.equal(
          proof.controllerFacts.candidatePreservation.preserved,
          false,
        );
      }
      git(config.checkout, "checkout", "--detach", done.work.result.changeRef);
      for (const corruption of ["blob", "mode"]) {
        if (corruption === "blob")
          writeFileSync(join(config.checkout, "result.txt"), "changed\n");
        else {
          writeFileSync(join(config.checkout, "result.txt"), "accepted\n");
          chmodSync(join(config.checkout, "result.txt"), 0o755);
        }
        git(config.checkout, "add", "result.txt");
        const changedTree = git(config.checkout, "write-tree");
        const changedCommit = git(
          config.checkout,
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory-test@example.com",
          "commit-tree",
          changedTree,
          "-p",
          done.work.result.baseSha,
          "-m",
          "Factory: result",
        );
        const broken = structuredClone(done);
        broken.work.result.changeRef = changedCommit;
        broken.work.result.treeSha = changedTree;
        const proof = JSON.parse(
          workItemReviewEvidence({
            state: broken,
            item: done.graph.items.find((entry) => entry.id === "result"),
            checkout: config.checkout,
            delivery,
          }).find((source) => source.path === "Retained repair proof: result")
            .content,
        );
        assert.equal(
          proof.controllerFacts.candidatePreservation.preserved,
          false,
        );
        assert.equal(
          proof.controllerFacts.candidatePreservation.ownedPathChanges[0].path,
          "result.txt",
        );
        const changed =
          proof.controllerFacts.candidatePreservation.ownedPathChanges[0];
        if (corruption === "mode") {
          assert.equal(changed.oldObject, changed.newObject);
          assert.notEqual(changed.oldMode, changed.newMode);
        } else assert.notEqual(changed.oldObject, changed.newObject);
      }
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("regular: diagnosed read-only QA repair retains its selected commit through review and final evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-qa-env-control-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/qa-env-control");
    const gate = join(root, "readiness");
    const command = `test -f '${gate}'`;
    const qaCriterion =
      "The integrated conditional check passes; an actual failure requires diagnosed authorized correction";
    const aggregateCriterion = aggregateAcceptance({ id: "aggregate" })[0];
    const source = `${body.replace("## Commands", `- ${qaCriterion}\n- ${aggregateCriterion}\n## Commands`)}\n## Environment\nThe controller requires this already-provisioned environment prerequisite.\n- ${command}\n`;
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        item(),
        {
          ...item("qa", ["result"]),
          kind: "qa",
          ownedPaths: [],
          acceptance: [qaCriterion],
          validation: [
            { command, provenance: "source-declared", source: "OBJECTIVE" },
          ],
        },
        {
          ...item("aggregate", ["qa"]),
          kind: "aggregate",
          children: ["qa"],
          ownedPaths: [],
          acceptance: [aggregateCriterion],
          validation: [],
        },
      ],
    };
    graph.coverage = coverageObligations(source, objectiveCriteria(source)).map(
      (obligation, index) => ({
        criterionId: obligation.criterionId,
        itemId: ["result", "qa", "aggregate"][index],
        proof:
          index === 0
            ? { kind: "final-review" }
            : { kind: "integrated-semantic", acceptanceIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      }),
    );
    const packets = [];
    const planner = model(graph);
    planner.reviewResult = async (request) => {
      packets.push(request);
      return reviewer(request);
    };
    const descriptor = {
      config,
      graph,
      objectiveBody: source,
      fakeRoot: join(root, "fake"),
      actions: {
        result: { files: [{ path: "result.txt", text: "accepted\n" }] },
      },
      planningModel: planner,
    };
    const fixture = makeApplication(descriptor);
    const policy = authority();
    policy.repairClasses = ["validation-environment"];
    policy.allowances.implementationRepairs = 0;
    const plan = await fixture.application.planObjective(1);
    const admitted = await fixture.application.admitObjective(1, plan, policy);
    const { readState, statePath } = await import("../dist/state-store.js");
    const { requestControl } = await import("../dist/coordinator-control.js");
    const running = fixture.application.runObjective(1, plan, admitted);
    const failed = await waitForFile(
      () => {
        const state = readState(config.repository, 1);
        return state?.work.qa.status === "failed" ? state : undefined;
      },
      statePath(config.repository, 1),
      "preserved read-only QA candidate",
    );
    const work = failed.work.qa;
    assert.equal(failed.work.result.status, "done");
    assert.equal(work.baseSha, work.changeRef);
    assert.equal(work.executionBaseSha, work.changeRef);
    assert.equal(work.execution, undefined);
    assert.equal(work.pullRequest, undefined);
    const drained = assert.rejects(running, /drained and released ownership/);
    await requestControl(config.repository, {
      objective: 1,
      action: "handoff",
    });
    await drained;
    writeFileSync(gate, "ready\n");
    fixture.application.repairWorkItem(1, {
      item: "qa",
      treeSha: work.treeSha,
      correction: {
        kind: "validation-environment",
        failureDigest: work.recovery.failure.digest,
        actor: "fixture",
        diagnosis: "Declared integrated QA prerequisite was unavailable",
        correction:
          "The same prerequisite is provisioned; revalidate the selected integrated commit",
      },
    });
    const { controlObjective } = await import("../dist/runner.js");
    await controlObjective(config, { objective: 1, action: "resume" });
    const done = await makeApplication(descriptor).application.runObjective(1);
    assert.equal(done.finalValidation.passed, true);
    assert.equal(done.work.qa.status, "done");
    assert.equal(done.work.qa.attempt, work.attempt);
    assert.equal(done.work.qa.changeRef, work.changeRef);
    assert.equal(done.work.qa.treeSha, work.treeSha);
    assert.equal(done.work.qa.execution, undefined);
    assert.equal(done.work.qa.pullRequest, undefined);
    assert.equal(done.allowanceConsumption.resultRereviews, 1);
    assert.equal(done.allowanceConsumption.implementationRepairs, 0);
    assert.deepEqual(
      readEvents(fixture.eventsPath)
        .filter((event) => event.type === "start")
        .map((event) => event.item),
      ["result"],
    );
    const qaPacket = packets.find((packet) =>
      packet.evidence.some(
        (entry) => entry.path === "Retained repair proof: qa",
      ),
    );
    const repair = JSON.parse(
      qaPacket.evidence.find(
        (entry) => entry.path === "Retained repair proof: qa",
      ).content,
    );
    assert.equal(
      repair.controllerFacts.failedAttempt.resultCommitSha,
      work.changeRef,
    );
    assert.equal(
      repair.controllerFacts.failedAttempt.resultTreeSha,
      work.treeSha,
    );
    assert.equal(repair.controllerFacts.failedAttempt.attemptId, work.attempt);
    assert.equal(repair.controllerFacts.currentAttemptId, work.attempt);
    assert.equal(repair.controllerFacts.currentResultCommitSha, work.changeRef);
    assert.equal(repair.controllerFacts.candidatePreservation, undefined);
    assert.equal(
      repair.controllerFacts.admittedAuthority.admissionDigest,
      done.admission.digest,
    );
    assert.equal(
      repair.controllerFacts.admittedAuthority.repairClass,
      "validation-environment",
    );
    assert.deepEqual(repair.controllerFacts.snapshotConsumption.paths, [
      { scope: "aggregate", consumed: 1, limit: 1 },
      { scope: "qa", consumed: 1, limit: 1 },
    ]);
    const aggregatePacket = packets.find((packet) =>
      packet.criteria.includes(aggregateCriterion),
    );
    const dependency = JSON.parse(
      aggregatePacket.evidence.find(
        (entry) => entry.path === "Completed dependency results",
      ).content,
    ).work.find((entry) => entry.id === "qa");
    assert.equal(dependency.validationPhase, "post-integration-read-only");
    assert.equal(dependency.selectedIntegratedCommitSha, work.changeRef);
    assert.deepEqual(dependency.repair, repair);
    const finalPacket = packets.find(
      (packet) => packet.reviewPhase === "objective-review",
    );
    assert.deepEqual(
      JSON.parse(finalPacket.observations).work.find(
        (entry) => entry.id === "qa",
      ).repair,
      repair,
    );
    const broken = structuredClone(done);
    broken.work.qa.recovery.history[0].work.executionBaseSha = target.baseSha;
    assert.throws(
      () =>
        workItemReviewEvidence({
          state: broken,
          item: done.graph.items.find((entry) => entry.id === "qa"),
          checkout: config.checkout,
          delivery: "regular",
        }),
      /retained candidate contains a worker or delivery identity/,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: evidence-only recovery retains original rejection and exact worker result`, async () => {
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
          assert.match(request.observations, /reviewTransportCorrection/);
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
      const plan = await fixture.application.planObjective(1);
      const admitted = await fixture.application.admitObjective(
        1,
        plan,
        authority(),
      );
      const done = await fixture.application.runObjective(1, plan, admitted);
      assert.equal(done.finalValidation.passed, true);
      assert.equal(done.allowanceConsumption.resultRereviews, 1);
      assert.equal(calls, 2);
      assert.equal(new Set(reviewedTrees).size, 1);
      assert.equal(
        readEvents(fixture.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
      assert.equal(
        done.work.result.recovery.history[0].work.acceptancePending
          .reviewRejection.reason,
        "invalid-response",
      );
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
    admission: { authority: authority() },
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
  assert.equal(work.pendingEffect, undefined);
  assert.equal(work.recovery.phase, "diagnosing");
  const charged = state.allowanceConsumption.implementationRepairs;
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
  assert.equal(restarted.allowanceConsumption.implementationRepairs, charged);
  work.pendingEffect = "publication";
  recordWorkFailure(state, "result", new Error("publication response lost"));
  assert.equal(work.recovery.failure.classification, "uncertain");
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
  assert.doesNotMatch(prompt, /Compile this human Objective/);
});

test("a real human-owned planning decision resolves the exact persisted plan without repeating models", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-human-plan-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/human-plan");
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
    const plan = await fixture.application.planObjective(1, [], authority());
    assert.equal(plan.review.status, "needs-human");
    const answered = await fixture.application.decidePlan(1, plan, {
      actor: "fixture-owner",
      outcome: "accept",
      reason: "Answer applies to this exact reviewed packet",
      answer: "Use the existing declared target policy",
    });
    const admitted = await fixture.application.admitObjective(
      1,
      answered,
      authority(),
    );
    const before = calls;
    const done = await fixture.application.runObjective(1, answered, admitted);
    assert.equal(done.finalValidation.passed, true);
    assert.equal(calls, before);
    assert.equal(done.allowanceConsumption.planningRevisions, 1);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause after known planning response preserves compilation for resume without repair authority or extra charge", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-planning-pause-"));
  try {
    const target = createTarget(root);
    const graph = { objective: 1, baseSha: target.baseSha, items: [item()] };
    const policy = authority();
    delete policy.repairPolicy;
    policy.repairClasses = [];
    const state = { authority: policy };
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
        [],
        { state, save: () => {}, stopped: () => paused },
      );
    await assert.rejects(compile(), /paused/);
    assert.equal(state.planningRecovery.phase, "ready");
    assert.ok(state.planningRecovery.response);
    assert.equal(reviews, 0);
    assert.equal(state.allowanceConsumption, undefined);
    paused = false;
    const accepted = await compile();
    assert.equal(accepted.review.status, "clean");
    assert.equal(generations, 1);
    assert.equal(reviews, 1);
    assert.equal(state.allowanceConsumption, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native settled validation failure survives real sibling collection and diagnosed candidate repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-settled-sibling-"));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  const release = join(root, "release-collection");
  let previousPath;
  let running;
  let outcome;
  let fixture;
  let config;
  let ownershipReleased = false;
  const timeout = setTimeout(
    () => writeFileSync(release, "timeout release"),
    15000,
  );
  try {
    const target = createTarget(root);
    config = factoryConfig(
      target.checkout,
      "example/settled-sibling",
      "native-stack",
      2,
    );
    const collectionStarted = join(root, "collection-started");
    const alphaRelease = join(root, "alpha-release");
    const prerequisite = join(root, "prerequisite");
    const transportGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const shim = join(root, "shim");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh
if [ "$1" = '-C' ] && [ "$3" = 'add' ] && [ -f "$2/alpha.txt" ] && [ ! -f ${quote(collectionStarted)} ]; then
  : > ${quote(collectionStarted)}
  while [ ! -f ${quote(release)} ]; do sleep 0.02; done
fi
exec ${quote(transportGit)} "$@"
`,
    );
    chmodSync(join(shim, "git"), 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${shim}:${previousPath}`;
    const check = join(root, "check.mjs");
    writeFileSync(
      check,
      `import {existsSync} from 'node:fs';
const started = Date.now();
while (!existsSync(${JSON.stringify(collectionStarted)})) {
  if (Date.now() - started > 10000) throw Error('collection barrier missing');
  await new Promise(resolve => setTimeout(resolve, 10));
}
process.exit(existsSync(${JSON.stringify(prerequisite)}) ? 0 : 1);
`,
    );
    const command = `${quote(process.execPath)} ${quote(check)}`;
    const beta = {
      ...item("beta"),
      validation: [
        ...item("beta").validation,
        { command, provenance: "source-declared", source: "OBJECTIVE" },
      ],
    };
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [item("alpha"), beta],
    };
    const source = `# Recovery fixture
## Acceptance
- alpha.txt exists
- beta.txt exists
## Commands
- test -s alpha.txt
- test -s beta.txt
- ${command}
## Final validation
- test -s beta.txt
`;
    const betaReviewTrees = [];
    const betaPackets = [];
    let finalPacket;
    const planner = model(graph, () => {
      throw Error("Implementation diagnosis is not authorized");
    });
    planner.reviewResult = async (request) => {
      if (
        request.reviewPhase === "result-review" &&
        request.criteria.includes("beta.txt exists")
      ) {
        betaReviewTrees.push(request.treeSha);
        betaPackets.push(request);
      }
      if (request.reviewPhase === "objective-review") finalPacket = request;
      return reviewer(request);
    };
    const descriptor = {
      config,
      graph,
      objectiveBody: source,
      fakeRoot: join(root, "fake"),
      actions: {
        alpha: {
          barrier: alphaRelease,
          files: [{ path: "alpha.txt", text: "accepted\n" }],
        },
        beta: { files: [{ path: "beta.txt", text: "accepted\n" }] },
      },
      planningModel: planner,
    };
    fixture = makeApplication(descriptor);
    const policy = authority();
    policy.repairClasses = ["validation-environment"];
    policy.allowances.implementationRepairs = 0;
    policy.repairPolicy.perPath.implementationRepairs = 0;
    const plan = await fixture.application.planObjective(1);
    const admitted = await fixture.application.admitObjective(1, plan, policy);
    const { readState, statePath } = await import("../dist/state-store.js");
    const { requestControl } = await import("../dist/coordinator-control.js");
    running = fixture.application.runObjective(1, plan, admitted);
    outcome = running.then(
      (state) => ({ state }),
      (error) => ({ error }),
    );
    await waitForFile(
      () =>
        readEvents(fixture.eventsPath).some(
          (event) => event.type === "complete" && event.item === "beta",
        ),
      fixture.eventsPath,
      "beta collection ready",
    );
    writeFileSync(alphaRelease, "release alpha worker");
    const failed = await waitForFile(
      () => {
        const state = readState(config.repository, 1);
        return state?.work.beta.recovery?.failure ? state : undefined;
      },
      statePath(config.repository, 1),
      "beta validation failure with live sibling collection",
    );
    assert.equal(
      failed.work.beta.recovery.failure.classification,
      "implementation",
    );
    assert.ok(failed.coordinator.processes.length > 0);
    assert.equal(failed.error, undefined);
    const correction = {
      kind: "validation-environment",
      failureDigest: failed.work.beta.recovery.failure.digest,
      actor: "fixture",
      diagnosis: "Declared local prerequisite was unavailable",
      correction:
        "Restore the same declared prerequisite and revalidate the preserved candidate",
    };
    assert.throws(
      () => applyWorkCorrection(structuredClone(failed), "beta", correction),
      /unsettled/,
    );
    writeFileSync(release, "settle sibling collection");
    const settled = await waitForFile(
      () => {
        const state = readState(config.repository, 1);
        return state?.work.alpha.status === "done" &&
          state.coordinator.processes.length === 0
          ? state
          : undefined;
      },
      statePath(config.repository, 1),
      "sibling completion and global quiescence",
    );
    assert.equal(settled.error, undefined);
    assert.equal(settled.coordinator.cancelError, undefined);
    const drained = assert.rejects(running, /drained and released ownership/);
    await requestControl(config.repository, {
      objective: 1,
      action: "handoff",
    });
    await drained;
    ownershipReleased = true;
    writeFileSync(prerequisite, "ready");
    const original = settled.work.beta;
    fixture.application.repairWorkItem(1, {
      item: "beta",
      treeSha: original.treeSha,
      correction,
    });
    const repaired = readState(config.repository, 1);
    assert.equal(repaired.work.beta.attempt, original.attempt);
    assert.equal(repaired.work.beta.treeSha, original.treeSha);
    assert.equal(repaired.work.beta.changeRef, original.changeRef);
    assert.equal(repaired.allowanceConsumption.implementationRepairs, 0);
    assert.equal(repaired.allowanceConsumption.resultRereviews, 1);
    const { controlObjective } = await import("../dist/runner.js");
    await controlObjective(config, { objective: 1, action: "resume" });
    const done = await makeApplication(descriptor).application.runObjective(1);
    assert.equal(done.finalValidation.passed, true);
    assert.equal(done.work.beta.attempt, original.attempt);
    assert.equal(done.runId, settled.runId);
    assert.equal(done.work.beta.validation.treeSha, done.work.beta.treeSha);
    assert.deepEqual(betaReviewTrees, [done.work.beta.treeSha]);
    assert.equal(
      done.work.beta.recovery.history[0].work.changeRef,
      original.changeRef,
    );
    assert.deepEqual(
      done.work.beta.recovery.history[0].work.usage,
      original.usage,
    );
    assert.equal(
      git(config.checkout, "show", `${done.work.beta.changeRef}:beta.txt`),
      "accepted",
    );
    assert.equal(
      done.work.beta.recovery.history[0].work.treeSha,
      original.treeSha,
    );
    assert.equal(
      done.work.beta.recovery.history[0].failure.digest,
      correction.failureDigest,
    );
    assert.equal(done.allowanceConsumption.resultRereviews, 1);
    assert.notEqual(done.work.beta.changeRef, original.changeRef);
    assert.notEqual(done.work.beta.treeSha, original.treeSha);
    const repair = JSON.parse(
      betaPackets[0].reviewPacket.evidence.find(
        (source) => source.path === "Retained repair proof: beta",
      ).content,
    );
    const preservation = repair.controllerFacts.candidatePreservation;
    assert.equal(preservation.preserved, true);
    assert.equal(preservation.sameAttempt, true);
    assert.equal(preservation.sameExecutionBase, true);
    assert.equal(preservation.failedResultBaseCommitSha, original.baseSha);
    assert.equal(
      preservation.currentResultBaseCommitSha,
      done.work.beta.baseSha,
    );
    assert.notEqual(
      preservation.failedResultBaseCommitSha,
      preservation.currentResultBaseCommitSha,
    );
    assert.deepEqual(preservation.acceptedOwnedPaths, ["beta.txt"]);
    assert.deepEqual(preservation.ownedPathChanges, []);
    const failedBlob = preservation.failedCandidateChanges[0];
    assert.equal(failedBlob.path, "beta.txt");
    assert.equal(failedBlob.newMode, "100644");
    assert.equal(
      failedBlob.newObject,
      git(config.checkout, "rev-parse", `${done.work.beta.changeRef}:beta.txt`),
    );
    assert.equal(
      repair.controllerFacts.admittedAuthority.repairClass,
      "validation-environment",
    );
    assert.equal(
      repair.controllerFacts.admittedAuthority.admissionDigest,
      done.admission.digest,
    );
    assert.deepEqual(
      JSON.parse(finalPacket.observations).work.find(
        (entry) => entry.id === "beta",
      ).repair,
      repair,
    );
    const wireModel = new CodexPlanningModel(config.checkout);
    let renderedFinal;
    wireModel.runStructured = async ({ prompt, schema, defaultPhase }) => {
      assert.equal(defaultPhase, "objective-review");
      renderedFinal = packetFromPrompt(prompt);
      assert.equal(renderedFinal.packetId, finalPacket.reviewPacket.id);
      assert.equal(schema.properties.packetId.enum[0], renderedFinal.packetId);
      assert.ok(prompt.includes("do not require whole-tree equality"));
      assert.ok(
        prompt.includes(
          "Controller-origin Work Item Git deltas and retained repair comparisons provide supervisor-generated exact Git evidence",
        ),
      );
      assert.equal(
        prompt.includes(
          "Only evidence with origin controller and a Work Item Git delta label",
        ),
        false,
      );
      assert.ok(
        prompt.includes(
          "without inventing a requirement to independently witness every declared host action",
        ),
      );
      return reviewer(finalPacket);
    };
    await wireModel.reviewResult(finalPacket);
    const renderedRepair = JSON.parse(
      renderedFinal.evidence.find(
        (entry) => entry.path === "Delivery observations",
      ).content,
    ).work.find((entry) => entry.id === "beta").repair;
    assert.deepEqual(renderedRepair, repair);
    assert.deepEqual(
      readEvents(fixture.eventsPath)
        .filter((event) => event.type === "start")
        .map((event) => event.item)
        .sort(),
      ["alpha", "beta"],
    );
  } finally {
    clearTimeout(timeout);
    writeFileSync(release, "release cleanup");
    if (running && outcome) {
      if (!ownershipReleased && fixture && config) {
        const { requestControl } = await import(
          "../dist/coordinator-control.js"
        );
        await requestControl(config.repository, {
          objective: 1,
          action: "handoff",
        }).catch(() => {});
      }
      await outcome;
    }
    if (previousPath !== undefined) process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});
