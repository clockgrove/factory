import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controlObjective } from "../dist/runner.js";
import { intakeControl, readIntake } from "../dist/intake.js";
import { factoryConfigDigest } from "../dist/config.js";
import { createHash } from "node:crypto";
import { objectiveComplete } from "../dist/completion.js";
import {
  readState,
  readContinuation,
  saveState,
  statePath,
} from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  git,
  readEvents,
} from "./support/integration-fixture.mjs";

const authority = {
  schemaVersion: 1,
  actor: "fixture",
  reason: "Two bounded public Objectives",
  executionConsent: true,
  serviceConsent: true,
  objectives: [1, 2],
  allowances: {
    planningRevisions: 0,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
  resources: { maxConcurrency: 2 },
  requiredEnvironment: [],
};
const body = (id) =>
  `## Acceptance\n- result-${id}.txt exists\n\n## Commands\n- test -s result-${id}.txt\n\n## Final validation\n- test -s result-${id}.txt\n`;
const item = (id) => ({
  id: `result-${id}`,
  title: `Result ${id}`,
  kind: "work",
  goal: `Write result-${id}.txt`,
  brief: `Write result-${id}.txt`,
  acceptance: [`result-${id}.txt exists`],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
  dependencies: [],
  ownedPaths: [`result-${id}.txt`],
  resources: [],
  validation: [
    {
      command: `test -s result-${id}.txt`,
      provenance: "source-declared",
      source: "OBJECTIVE",
    },
  ],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
});
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "factory-intake-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/intake");
    const plans = [],
      issues = new Map(
        [1, 2].map((id) => [
          id,
          {
            body: body(id),
            title: `Objective ${id}`,
            state: "open",
            labels: [],
          },
        ]),
      );
    const dependencies = new Map([[2, [1]]]);
    const model = {
      async generateStructured(request) {
        const objective = Number(
          request.objective.match(/^Objective #(\d+)/)[1],
        );
        plans.push({ objective, base: request.baseSha });
        return withCoverage(request, {
          objective,
          baseSha: request.baseSha,
          items: [item(objective)],
        });
      },
      async reviewGraph() {
        return { findings: [] };
      },
      async reviewResult(request) {
        return {
          findings: request.reviewPacket.criteria.map((criterion) => ({
            criterionId: criterion.id,
            verdict: "pass",
            evidenceIds: [
              request.reviewPacket.evidence.find(
                (entry) => entry.path === "OBJECTIVE",
              ).id,
            ],
            detail: "Fixture exact-tree acceptance",
            question: "",
          })),
        };
      },
    };
    const setup = makeApplication({
      config,
      graph: { objective: 1, baseSha: target.baseSha, items: [item(1)] },
      objectiveBody: body(1),
      fakeRoot: join(root, "fake"),
      planningModel: model,
      actions: Object.fromEntries(
        [1, 2].map((id) => [
          `result-${id}`,
          { files: [{ path: `result-${id}.txt`, text: `Objective ${id}\n` }] },
        ]),
      ),
    });
    setup.github.objective = async (id) => {
      if (!issues.has(id)) throw new Error("HTTP 404");
      return structuredClone(issues.get(id));
    };
    setup.github.intakePage = async (page) => ({
      status: 200,
      etag: '"current"',
      data:
        page === 1
          ? [...issues].map(([number, issue]) => ({
              number,
              state: issue.state,
              labels: issue.labels,
            }))
          : [],
    });
    setup.github.objectiveDependencies = async (id) =>
      dependencies.get(id) ?? [];
    const close = setup.github.closeIssue.bind(setup.github);
    setup.github.closeIssue = async (number, comment, expected) => {
      if (expected.workItem) return close(number, comment, expected);
      assert.equal(expected.body, issues.get(number).body);
      issues.get(number).state = "closed";
      setup.github.update((state) => {
        state.closedIssues[number] = true;
        state.events.push({ type: "close-objective", number });
      });
    };
    await fn({
      ...setup,
      root,
      target,
      config,
      plans,
      issues,
      dependencies,
      model,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("two explicitly authorized Objectives advance with accepted predecessor baseline and no replay on reopen", async () =>
  fixture(async (f) => {
    await f.application.enqueueIntake(authority, { pollSeconds: 0.01 });
    await f.application.runIntake();
    assert.deepEqual(
      f.plans.map((entry) => entry.objective),
      [1, 2],
    );
    const first = readState(f.config.repository, 1),
      second = readState(f.config.repository, 2);
    assert.equal(objectiveComplete(first), true);
    assert.equal(objectiveComplete(second), true);
    assert.equal(f.plans[1].base, first.finalAcceptance.commit);
    assert.equal(
      git(f.config.checkout, "show", `${second.baseSha}:result-1.txt`),
      "Objective 1",
    );
    f.issues.get(1).state = "open";
    await f.application.runIntake();
    assert.equal(f.plans.length, 2);
    assert.equal(
      readEvents(f.eventsPath).filter((event) => event.type === "start").length,
      2,
    );
  }));

test("pause after predecessor completion and restart keep accepted work and preserve one active Objective", async () =>
  fixture(async (f) => {
    f.dependencies.clear();
    let closures = 0;
    const close = f.github.closeIssue.bind(f.github);
    f.github.closeIssue = async (...args) => {
      await close(...args);
      if (!args[2].workItem && ++closures === 1)
        await intakeControl(f.config, "pause");
    };
    await f.application.enqueueIntake(authority, { pollSeconds: 0.01 });
    const running = f.application.runIntake();
    for (let i = 0; i < 500; i++) {
      if (
        readContinuation(f.config.repository, 1)?.objectiveClosure ===
        "complete"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readIntake(f.config).mode, "paused");
    assert.equal(readContinuation(f.config.repository, 2), undefined);
    await intakeControl(f.config, "drain");
    await running;
    await intakeControl(f.config, "resume");
    await f.application.runIntake();
    assert.deepEqual(
      f.plans.map((entry) => entry.objective),
      [1, 2],
    );
  }));

test("changed queued issue and missing predecessor remain precisely ineligible without provider calls", async () =>
  fixture(async (f) => {
    await f.application.enqueueIntake(authority, { pollSeconds: 0.01 });
    f.issues.get(1).body += "Changed requirement\n";
    f.dependencies.set(2, [99]);
    const running = f.application.runIntake();
    for (let i = 0; i < 100; i++) {
      if (readIntake(f.config).observation?.reasons[2]) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(readIntake(f.config).observation.reasons[1], /body changed/);
    assert.match(
      readIntake(f.config).observation.reasons[2],
      /Predecessor #99/,
    );
    assert.equal(f.plans.length, 0);
    await intakeControl(f.config, "drain");
    await running;
  }));

test("dirty compilation checkout is retained and cannot start planning", async () =>
  fixture(async (f) => {
    await f.application.enqueueIntake(
      { ...authority, objectives: [1] },
      { pollSeconds: 0.01 },
    );
    writeFileSync(join(f.config.checkout, "README.md"), "User change\n");
    const running = f.application.runIntake();
    for (let i = 0; i < 100; i++) {
      if (readIntake(f.config).observation?.reasons[1]) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(readIntake(f.config).observation.reasons[1], /local changes/);
    assert.equal(f.plans.length, 0);
    assert.match(git(f.config.checkout, "diff"), /User change/);
    await intakeControl(f.config, "drain");
    await running;
  }));

test("configured existing priority reorders only authorized pending Objectives", async () =>
  fixture(async (f) => {
    f.dependencies.clear();
    await f.application.enqueueIntake(authority, {
      priorityLabels: ["high"],
      pollSeconds: 0.01,
    });
    f.issues.get(2).labels = ["high"];
    f.issues.set(99, {
      state: "open",
      body: body(99),
      title: "Unapproved",
      labels: ["high"],
    });
    await f.application.runIntake();
    assert.deepEqual(
      f.plans.map((entry) => entry.objective),
      [2, 1],
    );
    assert.equal(readContinuation(f.config.repository, 99), undefined);
  }));

test("discovery omission refreshes exact authorized ID instead of treating work as deleted", async () =>
  fixture(async (f) => {
    await f.application.enqueueIntake(
      { ...authority, objectives: [1] },
      { pollSeconds: 0.01 },
    );
    f.github.intakePage = async () => ({ status: 200, data: [] });
    await f.application.runIntake();
    assert.deepEqual(
      f.plans.map((entry) => entry.objective),
      [1],
    );
  }));

for (const disposition of ["failed", "cancelled"])
  test(`${disposition} predecessor cannot admit its dependent`, async () =>
    fixture(async (f) => {
      await f.application.enqueueIntake(authority, { pollSeconds: 0.01 });
      saveState(statePath(f.config.repository, 1), {
        schemaVersion: 3,
        kind: "preparing",
        repository: f.config.repository,
        objective: 1,
        runId: "failed-preparation",
        configDigest: factoryConfigDigest(f.config),
        baseSha: f.target.baseSha,
        objectiveBodyDigest: createHash("sha256").update(body(1)).digest("hex"),
        planning: "ready",
        issueByItemId: {},
        coordinator: {
          mode: "paused",
          phase: "waiting",
          phaseStartedAt: new Date().toISOString(),
        },
        ...(disposition === "cancelled"
          ? { cancelRequested: true, cancelledAt: new Date().toISOString() }
          : { error: "Known rejected preparation" }),
      });
      if (disposition === "failed") await f.application.runIntake();
      else {
        const running = f.application.runIntake();
        for (let i = 0; i < 100; i++) {
          if (readIntake(f.config).observation?.reasons[2]) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.match(
          readIntake(f.config).observation.reasons[2],
          /Predecessor #1/,
        );
        await intakeControl(f.config, "drain");
        await running;
      }
      assert.equal(f.plans.length, 0);
      assert.equal(readContinuation(f.config.repository, 2), undefined);
    }));

test("pause during durable compilation and restart reuse known model output without a second compile", async () =>
  fixture(async (f) => {
    await f.application.enqueueIntake(authority, { pollSeconds: 0.01 });
    const generate = f.model.generateStructured.bind(f.model);
    let entered, release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    f.model.generateStructured = async (request) => {
      entered();
      await blocked;
      return generate(request);
    };
    const running = f.application.runIntake();
    await started;
    const before = readContinuation(f.config.repository, 1);
    assert.equal(before.authority.executionConsent, true);
    assert.equal(before.configDigest, factoryConfigDigest(f.config));
    for (const action of ["status", "cancel", "pause"])
      await assert.rejects(
        controlObjective(f.config, { objective: 2, action }),
        /Use intake control/,
      );
    assert.equal(
      readContinuation(f.config.repository, 1).cancelRequested,
      undefined,
    );
    await intakeControl(f.config, "dequeue", 2);
    await controlObjective(f.config, { objective: 1, action: "pause" });
    release();
    for (let i = 0; i < 100; i++) {
      if (readContinuation(f.config.repository, 1).planningRecovery?.response)
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await intakeControl(f.config, "drain");
    await running;
    assert.equal(f.plans.length, 1);
    await intakeControl(f.config, "resume");
    await f.application.runIntake();
    const completed = readState(f.config.repository, 1);
    assert.equal(completed.runId, before.runId);
    assert.equal(objectiveComplete(completed), true);
    assert.equal(f.plans.length, 1);
  }));

test("closed selection stays ineligible until explicit dequeue without model calls", async () =>
  fixture(async (f) => {
    await f.application.enqueueIntake(
      { ...authority, objectives: [1] },
      { pollSeconds: 0.01 },
    );
    f.issues.get(1).state = "closed";
    const running = f.application.runIntake();
    for (
      let i = 0;
      i < 100 && !readIntake(f.config).observation?.reasons[1];
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      readIntake(f.config).observation.reasons[1],
      "Issue is closed",
    );
    await intakeControl(f.config, "dequeue", 1);
    await running;
    assert.equal(f.plans.length, 0);
  }));
