import { consumption } from "../dist/repair-policy.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import {
  preparationStatusDocument,
  statusDocument,
} from "../dist/diagnostics.js";
import { defaultAutonomy } from "../dist/index.js";
import { intakeExitCode, runOutcome } from "../dist/run-outcome.js";
import {
  readContinuation,
  readState,
  saveState,
  statePath,
} from "../dist/state-store.js";
import { shortPlanDigest, summarizeStatus } from "../dist/status-summary.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const item = {
  id: "result",
  kind: "work",
  children: [],
  title: "result",
  goal: "Write result.txt",
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
  "# Run fixture\n## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n";

/**
 * A scripted model that records each call. `planFinding` makes plan review return one sourced
 * finding (on every review, or on the first N); `malformedCompile` returns no decodable graph.
 */
function model(
  graph,
  calls,
  {
    planFinding = false,
    planningDiagnosis = "operator",
    malformedCompile = false,
  } = {},
) {
  let reviews = 0;
  return {
    async generateStructured(request) {
      calls.push(request.purpose ?? "compile");
      if (request.purpose === "diagnosis")
        return "kind" in (request.schema?.properties ?? {})
          ? {
              kind: planningDiagnosis,
              diagnosis: "The Objective leaves the owner undecided",
              correction: "Assign result.txt to the result item",
            }
          : {
              decision: "repair",
              diagnosis: "The worker stopped before collection",
              correction: "Start again from the accepted base",
            };
      return malformedCompile ? {} : withCoverage(request, graph);
    },
    async reviewGraph(request) {
      calls.push("plan-review");
      reviews++;
      return {
        packetId: request.reviewPacket.id,
        findings:
          planFinding === true ||
          (typeof planFinding === "number" && reviews <= planFinding)
            ? [
                {
                  evidenceIndices: [
                    request.reviewPacket.evidence.findIndex(
                      (entry) => entry.path === "OBJECTIVE",
                    ),
                  ],
                  detail: "The owner of result.txt is unstated",
                  question: "Should the result item own result.txt?",
                },
              ]
            : [],
      };
    },
    async reviewResult(request) {
      calls.push("result-review");
      return {
        packetId: request.reviewPacket.id,
        findings: resultFindings(
          request,
          request.criteria.map((criterion) => ({
            criterion,
            verdict: "pass",
            source: "OBJECTIVE",
            quote: "# Run fixture",
            detail: "Exact-tree command passed",
            question: "",
          })),
        ),
      };
    },
  };
}

async function fixture(name, run) {
  const root = mkdtempSync(join(tmpdir(), `factory-run-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, `example/run-${name}`);
    const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
    await run({ root, config, graph });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("run persists a plan that needs a decision and resumes it without planning again", async () => {
  await fixture("decide", async ({ root, config, graph }) => {
    const calls = [];
    const { application, eventsPath } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      planningModel: model(graph, calls, { planFinding: true }),
    });
    const stopped = await application.runObjective(1);
    assert.equal(stopped.schemaVersion, 8);
    assert.deepEqual(stopped.autonomy, defaultAutonomy);
    assert.equal(stopped.plan.review.status, "needs-human");
    assert.match(
      stopped.coordinator.waitReason,
      /owner of result\.txt|own result\.txt/,
    );
    assert.deepEqual(calls, ["compile", "plan-review", "diagnosis"]);
    assert.deepEqual(readEvents(eventsPath), []);

    // A rerun reads the persisted plan and its review; no model is asked again.
    const again = await application.runObjective(1);
    assert.equal(again.schemaVersion, 8);
    assert.deepEqual(again.plan, stopped.plan);
    assert.equal(calls.length, 3);

    // Refusing discards the unprojected plan, so the next run plans afresh.
    await application.decidePlan(1, {
      plan: shortPlanDigest(stopped.plan),
      actor: "operator",
      outcome: "refuse",
      answer: "",
      reason: "Plan again",
    });
    assert.equal(existsSync(statePath(config.repository, 1)), false);
    const replanned = await application.runObjective(1);
    assert.equal(replanned.plan.review.status, "needs-human");
    assert.equal(calls.length, 6);

    await assert.rejects(
      application.decidePlan(1, {
        plan: shortPlanDigest(replanned.plan),
        actor: "operator",
        outcome: "accept",
        answer: "",
        reason: "Owner is result",
      }),
      /specific answer/,
    );
    const decided = await application.decidePlan(1, {
      plan: shortPlanDigest(replanned.plan),
      actor: "operator",
      outcome: "accept",
      answer: "Yes, the result item owns result.txt",
      reason: "Checked the Objective",
    });
    assert.equal(decided.plan.review.status, "human-accepted");
    assert.equal(
      readContinuation(config.repository, 1).plan.humanDecision.answer,
      "Yes, the result item owns result.txt",
    );

    const completed = await application.runObjective(1);
    assert.equal(completed.finalValidation.passed, true);
    assert.deepEqual(
      calls.filter((call) => call !== "result-review"),
      [
        "compile",
        "plan-review",
        "diagnosis",
        "compile",
        "plan-review",
        "diagnosis",
      ],
    );
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      1,
    );
  });
});

test("run completes autonomously within the default allowances", async () => {
  await fixture("autonomous", async ({ root, config, graph }) => {
    const calls = [];
    const { application, eventsPath } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        result: {
          failAttempts: 1,
          files: [{ path: "result.txt", text: "done\n" }],
        },
      },
      planningModel: model(graph, calls),
    });
    const completed = await application.runObjective(1);
    assert.equal(completed.finalValidation.passed, true);
    assert.deepEqual(completed.autonomy, defaultAutonomy);
    assert.equal(consumption(completed).implementationRepairs, 1);
    assert.equal(completed.work.result.recovery.history.length, 1);
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      2,
    );
    // The diagnosis was the only extra model call; planning ran once.
    assert.deepEqual(
      calls.filter((call) => call !== "result-review"),
      ["compile", "plan-review", "diagnosis"],
    );
  });
});

test("required environment is checked before any model is called", async () => {
  await fixture("environment", async ({ root, config, graph }) => {
    const calls = [];
    const { application } = makeApplication({
      config: {
        ...config,
        policy: { ...config.policy, allowedSecretNames: ["FIXTURE_SECRET"] },
        autonomy: { requiredEnvironment: ["FIXTURE_SECRET"] },
      },
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
      planningModel: model(graph, calls),
    });
    delete process.env.FIXTURE_SECRET;
    await assert.rejects(
      application.runObjective(1),
      /Required environment FIXTURE_SECRET is unavailable/,
    );
    assert.deepEqual(calls, []);
  });
});

test("decisions bind to the plan status showed and refuse once projection starts", async () => {
  await fixture("bind", async ({ root, config, graph }) => {
    const calls = [];
    const { application } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      planningModel: model(graph, calls, { planFinding: true }),
    });
    const stopped = await application.runObjective(1);
    const digest = shortPlanDigest(stopped.plan);
    const status = preparationStatusDocument(stopped);
    assert.equal(status.planReview.digest, digest);
    assert.match(status.nextAction.command, new RegExp(`--plan ${digest} `));
    const decision = {
      actor: "operator",
      answer: "Yes, the result item owns result.txt",
      reason: "Checked the Objective",
    };
    for (const plan of [
      undefined,
      "000000000000",
      stopped.plan.reviewDigest.slice(0, 11),
      stopped.plan.reviewDigest.toUpperCase(),
    ])
      for (const outcome of ["accept", "refuse"])
        await assert.rejects(
          application.decidePlan(1, { ...decision, plan, outcome }),
          /saved plan is/,
        );
    // Any prefix of at least the short form names the plan.
    const accepted = await application.decidePlan(1, {
      ...decision,
      plan: stopped.plan.reviewDigest.slice(0, 20),
      outcome: "accept",
    });
    assert.equal(accepted.plan.review.status, "human-accepted");
    // A crash between creating an issue and recording it leaves projection unknown.
    const path = statePath(config.repository, 1);
    const projecting = readContinuation(config.repository, 1);
    projecting.coordinator.phase = "projection";
    saveState(path, projecting);
    await assert.rejects(
      application.decidePlan(1, {
        ...decision,
        plan: stopped.plan.reviewDigest,
        outcome: "refuse",
      }),
      /projection has started/,
    );
    assert.ok(existsSync(path));
  });
});

test("state from an earlier Factory version stops every command with one message", async () => {
  await fixture("stale", async ({ root, config, graph }) => {
    const calls = [];
    const { application } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
      planningModel: model(graph, calls),
    });
    // An old Objective state and an old preparation, plus a current-version neighbour.
    for (const [objective, schemaVersion] of [
      [9, 4],
      [12, 5],
    ]) {
      const leftover = statePath(config.repository, objective);
      mkdirSync(dirname(leftover), { recursive: true });
      writeFileSync(leftover, JSON.stringify({ schemaVersion }));
    }
    const objectives = join(stateRoot(config.repository), "objectives");
    const message = `State from an earlier Factory version: ${join(objectives, "9")}, ${join(objectives, "12")}. v0.2.0 starts fresh: stop and uninstall any old Factory service with the old version (factory supervisor uninstall), then delete those directories, or finish them with the old version first`;
    await assert.rejects(application.runObjective(1), { message });
    assert.doesNotMatch(
      message,
      new RegExp(`delete ${stateRoot(config.repository)}\\b`),
    );
    assert.throws(() => readContinuation(config.repository, 9), { message });
    assert.throws(() => readState(config.repository, 9), { message });
    assert.deepEqual(calls, []);
  });
});

test("an Objective keeps the capacity it started with when the host changes", async () => {
  await fixture("host", async ({ root, config, graph }) => {
    const { concurrency: _declared, ...execution } = config.execution;
    const declared = { ...config, execution };
    const calls = [];
    const { application } = makeApplication({
      config: declared,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      planningModel: model(graph, calls, { planFinding: true }),
    });
    const { availableParallelism: cpus, totalmem: memory } = os;
    const host = (parallelism, gib) => {
      os.availableParallelism = () => parallelism;
      os.totalmem = () => gib * 1024 ** 3;
      syncBuiltinESMExports();
    };
    try {
      host(4, 8);
      const stopped = await application.runObjective(1);
      assert.deepEqual(stopped.capacity.concurrency, 1);
      assert.equal(stopped.plan.executionBounds.configuredConcurrency, 1);
      host(64, 256);
      await application.decidePlan(1, {
        plan: shortPlanDigest(stopped.plan),
        actor: "operator",
        outcome: "accept",
        answer: "Yes, the result item owns result.txt",
        reason: "Checked the Objective",
      });
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      assert.deepEqual(completed.capacity, stopped.capacity);
    } finally {
      os.availableParallelism = cpus;
      os.totalmem = memory;
      syncBuiltinESMExports();
    }
  });
});

test("planning that stops without a plan waits for a refusal instead of failing", async () => {
  await fixture("stopped", async ({ root, config, graph }) => {
    const calls = [];
    const { application } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
      planningModel: model(graph, calls, { malformedCompile: true }),
    });
    const stopped = await application.runObjective(1);
    assert.equal(stopped.schemaVersion, 8);
    assert.equal(stopped.plan, undefined);
    assert.equal(stopped.planningRecovery.phase, "stopped");
    assert.match(
      stopped.coordinator.waitReason,
      /^Planning stopped for a decision: /,
    );
    assert.deepEqual(calls, ["compile", "diagnosis"]);
    assert.equal(runOutcome(stopped).code, 2);
    assert.match(runOutcome(stopped).message, /--outcome refuse/);
    const status = preparationStatusDocument(stopped);
    assert.equal(status.phase, "needs-plan-decision");
    assert.equal(
      status.nextAction.command,
      'factory decide --objective 1 --outcome refuse --reason "WHY"',
    );
    // A rerun repeats no model call and still names the way out.
    const again = await application.runObjective(1);
    assert.equal(again.coordinator.waitReason, stopped.coordinator.waitReason);
    assert.equal(calls.length, 2);
    await application.decidePlan(1, {
      actor: "operator",
      outcome: "refuse",
      answer: "",
      reason: "Clarified the Objective",
    });
    assert.equal(existsSync(statePath(config.repository, 1)), false);
  });
});

test("planning revisions use the whole configured allowance", async () => {
  await fixture("revisions", async ({ root, config, graph }) => {
    const calls = [];
    const { application } = makeApplication({
      config: { ...config, autonomy: { allowances: { planningRevisions: 2 } } },
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      planningModel: model(graph, calls, {
        planFinding: 2,
        planningDiagnosis: "planning-evidence",
      }),
    });
    const completed = await application.runObjective(1);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(consumption(completed).planningRevisions, 2);
    assert.equal(consumption(completed, "$planning").planningRevisions, 2);
    assert.equal(calls.filter((call) => call === "compile").length, 3);
  });
});

test("a started Objective names its required environment from its own limits", async () => {
  await fixture("environment-snapshot", async ({ root, config, graph }) => {
    const policy = { ...config.policy, allowedSecretNames: ["FIXTURE_SECRET"] };
    const application = (autonomy) =>
      makeApplication({
        config: { ...config, policy, autonomy },
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {},
        planningModel: model(graph, [], { planFinding: true }),
      }).application;
    delete process.env.FIXTURE_SECRET;
    const stopped = await application({}).runObjective(1);
    assert.deepEqual(stopped.autonomy.requiredEnvironment, []);
    // Adding a requirement to the configuration applies to the next Objective only.
    const again = await application({
      requiredEnvironment: ["FIXTURE_SECRET"],
    }).runObjective(1);
    assert.equal(again.schemaVersion, 8);
    // A requirement in the snapshot is still checked live on every run.
    const path = statePath(config.repository, 1);
    const snapshot = readContinuation(config.repository, 1);
    snapshot.autonomy.requiredEnvironment = ["FIXTURE_SECRET"];
    saveState(path, snapshot);
    await assert.rejects(
      application({}).runObjective(1),
      /Required environment FIXTURE_SECRET is unavailable/,
    );
  });
});

test("the active graph stays bound to the accepted plan and runs report exit codes", async () => {
  await fixture("plan-root", async ({ root, config, graph }) => {
    const { application } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      planningModel: model(graph, []),
    });
    const completed = await application.runObjective(1);
    assert.equal(runOutcome(completed).code, 0);
    assert.equal(
      runOutcome({ ...completed, finalValidation: undefined, cancelledAt: "x" })
        .code,
      1,
    );
    assert.equal(
      runOutcome({ ...completed, finalValidation: undefined }).code,
      2,
    );
    assert.equal(intakeExitCode({ mode: "running" }), 0);
    assert.equal(
      intakeExitCode({ mode: "paused", observation: { error: "failed" } }),
      1,
    );
    assert.equal(
      intakeExitCode({
        mode: "paused",
        observation: { error: "decide", needsDecision: 1 },
      }),
      2,
    );
    const path = statePath(config.repository, 1);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.planGraphDigest = "0".repeat(64);
    writeFileSync(path, JSON.stringify(value));
    assert.throws(
      () => readState(config.repository, 1),
      /differs from the accepted plan/,
    );
  });
});

/**
 * A planner scripted to stop planning before any graph is reviewed. `answers`
 * are the compile answers in order (the last repeats); `diagnose` answers or
 * throws for each diagnosis.
 */
function stoppingModel(calls, answers, diagnose) {
  let compiled = 0;
  return {
    async generateStructured(request) {
      calls.push(request.purpose ?? "compile");
      if (request.purpose === "diagnosis") return diagnose();
      return answers[Math.min(compiled++, answers.length - 1)];
    },
    async reviewGraph() {
      throw new Error("a stopped planning is never reviewed");
    },
  };
}

const diagnosing = () => ({
  kind: "planning-output",
  diagnosis: "The answer is not a graph",
  correction: "Return the graph",
});

for (const [name, expected, answers, diagnose, runs] of [
  ["an unchanged failure", /Unchanged planning failure/, [{}], diagnosing, 1],
  [
    "an exhausted planning allowance",
    /allowance is exhausted/,
    [{}, { items: "not a list" }],
    diagnosing,
    1,
  ],
  [
    "a diagnosis that never answers",
    /diagnosis did not answer 3 times/,
    [{}],
    () => {
      throw new Error("diagnosis unavailable");
    },
    4,
  ],
  [
    "a diagnosis that says the operator decides",
    /undelegated decision/,
    [{}],
    () => ({
      kind: "operator",
      diagnosis: "The Objective leaves the owner undecided",
      correction: "Assign result.txt to the result item",
    }),
    1,
  ],
])
  test(`planning that stopped on ${name} names a decide command that works`, async () => {
    await fixture("stop-command", async ({ root, config, graph }) => {
      const calls = [];
      const { application } = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {},
        planningModel: stoppingModel(calls, answers, diagnose),
      });
      // A diagnosis that fails is a defect each run; the fourth run stops.
      let stopped;
      for (let run = 1; run <= runs; run++)
        stopped = await application
          .runObjective(1)
          .catch((error) => (run < runs ? undefined : Promise.reject(error)));
      assert.equal(stopped.plan, undefined);
      assert.equal(stopped.planningRecovery.phase, "stopped");
      assert.match(stopped.coordinator.waitReason, expected);
      const outcome = runOutcome(stopped);
      assert.equal(outcome.code, 2);
      assert.match(outcome.message, expected);
      // The reason is said once, and the way out is the printed command.
      assert.doesNotMatch(
        outcome.message,
        /stopped for a decision: .*stopped for a decision/is,
      );
      const status = preparationStatusDocument(stopped);
      assert.equal(status.phase, "needs-plan-decision");
      assert.match(status.summary, /^Planning stopped for a decision: /);
      const command = status.nextAction.command;
      assert.equal(
        command,
        'factory decide --objective 1 --outcome refuse --reason "WHY"',
      );
      assert(outcome.message.includes(command.replace("WHY", "…")));

      // Run the printed command, as the operator would.
      const configPath = join(root, "config.json");
      writeFileSync(configPath, JSON.stringify(config));
      const [factory, ...args] = command.match(/"[^"]*"|\S+/g);
      assert.equal(factory, "factory");
      const decided = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "../dist/cli.js"),
          ...args.map((arg) =>
            arg === '"WHY"' ? "Clarified the Objective" : arg,
          ),
          "--actor",
          "operator",
          "--config",
          configPath,
        ],
        { encoding: "utf8", env: { ...process.env } },
      );
      assert.equal(decided.status, 0, decided.stderr);
      assert.equal(existsSync(statePath(config.repository, 1)), false);

      // The next run plans again from scratch instead of staying stopped.
      const before = calls.length;
      await application.runObjective(1).catch(() => undefined);
      assert(calls.length > before);
    });
  });

test("the CLI requires an answer to accept a plan and keeps no admission vocabulary", async () => {
  await fixture("cli", async ({ root, config }) => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const cli = (...args) =>
      spawnSync(
        process.execPath,
        [join(import.meta.dirname, "../dist/cli.js"), ...args],
        { encoding: "utf8", env: { ...process.env } },
      );
    const accept = cli(
      "decide",
      "--objective",
      "1",
      "--plan",
      "0123456789ab",
      "--outcome",
      "accept",
      "--reason",
      "Looks right",
      "--config",
      configPath,
    );
    assert.equal(accept.status, 1);
    assert.match(accept.stderr, /requires --answer/);
    const help = cli("help");
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stdout, /--authority\b|\badmit\b|admission/);
    // Every command refuses options it does not read; removed ones say so.
    for (const [args, message] of [
      [
        ["run", "--objective", "1", "--plan", "x"],
        /Unknown option --plan for factory run/,
      ],
      [["status", "--objective", "1", "--follow"], /Unknown option --follow/],
      [
        ["plan", "--objective", "1", "--source", "a.md"],
        /--source was removed/,
      ],
      [
        ["intake", "enqueue", "--authority", "a.json"],
        /--authority was removed/,
      ],
      [
        ["run", "--objective", "1", "--admission", "a.json"],
        /--admission was removed/,
      ],
      [["cancel", "--objective", "1", "--abandon"], /--abandon was removed/],
      [
        ["analyze", "--objective", "1", "--source", "a.md"],
        /--source was removed/,
      ],
    ]) {
      const result = cli(...args, "--config", configPath);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, message);
    }
  });
});

test("factory retry runs the command status prints for a step decision", async () => {
  await fixture("step-retry", async ({ root, config, graph }) => {
    const { application } = makeApplication({
      config,
      graph,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      planningModel: model(graph, []),
    });
    await application.runObjective(1);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    /** Run the printed command, as the operator would. */
    const run = (command) => {
      const [factory, ...args] = command.split(" ");
      assert.equal(factory, "factory");
      return spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "../dist/cli.js"),
          ...args,
          "--config",
          configPath,
        ],
        { encoding: "utf8", env: { ...process.env } },
      );
    };
    const path = statePath(config.repository, 1);
    const question =
      "review failed 4 times with an unknown outcome; retry or cancel?";

    // An item step at its paid bound, after its PR was published: the
    // attempt retry refuses this item, the step retry answers it.
    const state = readState(config.repository, 1);
    // Unsealed, so the test may edit the finished Objective's work.
    delete state.finalAcceptance;
    state.repeats = {
      "item/result/review": { paid: 4 },
      "objective/close": { paid: 1 },
    };
    state.work.result.wait = {
      kind: "decision",
      detail: question,
      step: "item/result/review",
    };
    saveState(path, state);
    const document = statusDocument(
      readState(config.repository, 1),
      config.repository,
      1,
      "regular",
    );
    const itemStatus = summarizeStatus({
      ...document,
      state: "active",
      work: document.work.map((work) => ({ ...work, status: "published" })),
    });
    assert.equal(itemStatus.phase, "needs-decision");
    assert.equal(
      itemStatus.nextAction.command,
      "factory retry --objective 1 --item result",
    );
    const answered = run(itemStatus.nextAction.command);
    assert.equal(answered.status, 0, answered.stderr);
    assert.match(answered.stdout, /Work Item result step will run again/);
    const cleared = readState(config.repository, 1);
    assert.equal(cleared.work.result.wait, undefined);
    assert.deepEqual(cleared.repeats, { "objective/close": { paid: 1 } });
    // Nothing awaits the operator now, so the attempt rules apply again.
    assert.match(run(itemStatus.nextAction.command).stderr, /already complete/);

    // The Objective's own step: no --item.
    cleared.wait = {
      kind: "decision",
      detail: question,
      step: "objective/close",
    };
    saveState(path, cleared);
    const objectiveStatus = summarizeStatus({
      ...statusDocument(
        readState(config.repository, 1),
        config.repository,
        1,
        "regular",
      ),
      state: "active",
    });
    assert.equal(
      objectiveStatus.nextAction.command,
      "factory retry --objective 1",
    );
    const objectiveAnswer = run(objectiveStatus.nextAction.command);
    assert.equal(objectiveAnswer.status, 0, objectiveAnswer.stderr);
    assert.match(objectiveAnswer.stdout, /Objective step will run again/);
    const done = readState(config.repository, 1);
    assert.equal(done.wait, undefined);
    assert.equal(done.repeats, undefined);
    assert.match(
      run("factory retry --objective 1").stderr,
      /No Objective step awaits/,
    );

    // A stop outside any Work Item: status names the retry, which answers it.
    done.error = "Fixture stop outside any Work Item";
    saveState(path, done);
    const stoppedStatus = summarizeStatus({
      ...statusDocument(
        readState(config.repository, 1),
        config.repository,
        1,
        "regular",
      ),
      state: "failed",
    });
    assert.equal(
      stoppedStatus.nextAction.command,
      "factory retry --objective 1",
    );
    const restarted = run(stoppedStatus.nextAction.command);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /Objective step will run again/);
    assert.equal(readState(config.repository, 1).error, undefined);
  });
});
