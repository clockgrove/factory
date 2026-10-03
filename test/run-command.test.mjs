import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultAutonomy } from "../dist/index.js";
import { readContinuation, statePath } from "../dist/state-store.js";
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

/** A scripted model that records each call; plan review can return one sourced finding. */
function model(graph, calls, { planFinding = false } = {}) {
  return {
    async generateStructured(request) {
      calls.push(request.purpose ?? "compile");
      if (request.purpose === "diagnosis")
        return "kind" in (request.schema?.properties ?? {})
          ? {
              kind: "operator",
              diagnosis: "The Objective leaves the owner undecided",
              correction: "Ask the operator",
            }
          : {
              decision: "repair",
              diagnosis: "The worker stopped before collection",
              correction: "Start again from the accepted base",
            };
      return withCoverage(request, graph);
    },
    async reviewGraph(request) {
      calls.push("plan-review");
      return {
        packetId: request.reviewPacket.id,
        findings: planFinding
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
    assert.equal(stopped.schemaVersion, 5);
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
    assert.equal(again.schemaVersion, 5);
    assert.deepEqual(again.plan, stopped.plan);
    assert.equal(calls.length, 3);

    // Refusing discards the unprojected plan, so the next run plans afresh.
    await application.decidePlan(1, {
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
        actor: "operator",
        outcome: "accept",
        answer: "",
        reason: "Owner is result",
      }),
      /specific answer/,
    );
    const decided = await application.decidePlan(1, {
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
    assert.equal(completed.allowanceConsumption.implementationRepairs, 1);
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
