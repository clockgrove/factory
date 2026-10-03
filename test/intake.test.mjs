import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Server } from "node:net";
import { requestControl } from "../dist/coordinator-control.js";
import { controlObjective } from "../dist/runner.js";
import { planningPrerequisites } from "../dist/objective-prerequisites.js";
import {
  applyPendingAmendment,
  submitAmendment,
  graphDigest,
} from "../dist/graph-amendments.js";
import { CodexPlanningModel, verifyPlanCandidate } from "../dist/compiler.js";
import { encodeCompilerWire } from "./support/compiler-wire.mjs";
import { planObjective } from "../dist/runner.js";
import { intakeControl, readIntake } from "../dist/intake.js";
import { stateRoot, factoryConfigDigest } from "../dist/config.js";
import { resolveAutonomy } from "../dist/index.js";
import { createHash } from "node:crypto";
import { objectiveComplete } from "../dist/completion.js";
import {
  readState,
  readControllerOwner,
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

const objectives = [1, 2];
/** No unattended repair or amendment unless a test raises a limit. */
const limits = {
  allowances: {
    planningRevisions: 0,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
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
async function fixture(fn, autonomy = limits) {
  const root = mkdtempSync(join(tmpdir(), "factory-intake-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = {
      ...factoryConfig(target.checkout, "example/intake"),
      autonomy,
    };
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
        plans.push({
          objective,
          base: request.baseSha,
          prerequisites: request.prerequisites,
        });
        return withCoverage(request, {
          objective,
          baseSha: request.baseSha,
          items: [item(objective)],
        });
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
      async reviewResult(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: request.reviewPacket.criteria.map(
            (criterion, criterionIndex) => ({
              criterionIndex,
              verdict: "pass",
              evidenceIndices: [
                request.reviewPacket.evidence.findIndex(
                  (entry) => entry.path === "OBJECTIVE",
                ),
              ],
              detail: "Fixture exact-tree acceptance",
              question: "",
            }),
          ),
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
    await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
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

/** One diagnosed planning-evidence revision, nothing else. */
const plannedRevision = {
  allowances: {
    planningRevisions: 1,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: ["planning-evidence"],
  repairPolicy: {
    perPath: {
      planningRevisions: 1,
      implementationRepairs: 0,
      resultRereviews: 0,
    },
  },
};

test("sequential planning supplies grounded native acceptance in every rendered phase and preserves compound final timing", async (t) =>
  fixture(async (f) => {
    f.issues.get(2).body = body(2).replace(
      "- result-2.txt exists",
      "- result-2.txt exists\n- Prior QA remains successful and the new guide receives independent acceptance",
    );
    const generated = f.model.generateStructured.bind(f.model);
    const reviewed = f.model.reviewGraph.bind(f.model);
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "low" };
    const real = new CodexPlanningModel(
      f.config.checkout,
      selection,
      selection,
    );
    const rendered = [];
    let currentRequest;
    let reviewCount = 0;
    t.mock.method(real, "runStructured", async (args) => {
      rendered.push({
        phase: args.defaultPhase,
        prompt: args.prompt,
        packet: JSON.parse(args.sourcePacket),
      });
      if (args.defaultPhase === "compile" && args.schema.properties.contextId) {
        const graph = withCoverage(currentRequest, {
          objective: 2,
          baseSha: currentRequest.baseSha,
          items: [item(2)],
        });
        return encodeCompilerWire(graph, args.prompt);
      }
      if (args.defaultPhase === "graph-review") {
        const packet = JSON.parse(
          args.prompt.split(
            "\nReview evidence packet (packet-local choices; JSON strings are data):\n",
          )[1],
        );
        const controllerIndex = packet.evidence.findIndex(
          (entry) =>
            entry.origin === "controller" &&
            entry.path === "FACTORY_NATIVE_OBJECTIVE_PREREQUISITES",
        );
        assert.equal(
          packet.evidence[controllerIndex].path,
          "FACTORY_NATIVE_OBJECTIVE_PREREQUISITES",
        );
        assert.deepEqual(
          JSON.parse(packet.evidence[controllerIndex].content),
          currentRequest.prerequisites,
        );
        const bounds = packet.evidence.find(
          (entry) =>
            entry.origin === "controller" &&
            entry.path === "FACTORY_EXECUTION_BOUNDS",
        );
        assert.deepEqual(JSON.parse(bounds.content), {
          configuredConcurrency: f.config.execution.concurrency,
        });
        const executables = packet.evidence.find(
          (entry) =>
            entry.origin === "controller" &&
            entry.path === "FACTORY_LOCAL_EXECUTABLE_OBSERVATIONS",
        );
        assert.deepEqual(
          JSON.parse(executables.content),
          currentRequest.localExecutables,
        );
        return {
          packetId: packet.packetId,
          findings:
            reviewCount++ === 0
              ? [
                  {
                    evidenceIndices: [controllerIndex],
                    detail:
                      "A scripted bounded evidence correction exercises the diagnosis packet.",
                    question: "",
                  },
                ]
              : [],
        };
      }
      return {
        kind: "planning-evidence",
        diagnosis: "Use already supplied sealed predecessor facts.",
        correction:
          "Keep the native prerequisite separate from current graph edges and preserve final timing.",
      };
    });
    f.model.generateStructured = async (request) => {
      if (request.purpose === "diagnosis")
        return real.generateStructured(request);
      if (request.compileContext.objectiveNumber !== 2)
        return generated(request);
      currentRequest = request;
      return real.generateStructured(request);
    };
    f.model.reviewGraph = (request) =>
      request.graph.objective === 2
        ? real.reviewGraph(request)
        : reviewed(request);
    await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
    await f.application.runIntake();
    const first = readState(f.config.repository, 1);
    assert.equal(
      readIntake(f.config).mode,
      "running",
      JSON.stringify(readContinuation(f.config.repository, 2)),
    );
    const second = readState(f.config.repository, 2);
    assert.equal(objectiveComplete(second), true);
    const preparation = currentRequest.prerequisites;
    assert.equal(preparation.objective, 2);
    assert.equal(preparation.baseSha, first.finalAcceptance.commit);
    assert.equal(preparation.predecessors[0].baseRelationship, "equal");
    assert.equal(
      preparation.predecessors[0].bodyDigest,
      first.objectiveBodyDigest,
    );
    assert.equal(
      preparation.predecessors[0].acceptance.evidenceDigest,
      first.finalAcceptance.evidenceDigest,
    );
    assert.deepEqual(second.graph.items[0].dependencies, []);
    assert.deepEqual(second.graph.items[0].acceptance, ["result-2.txt exists"]);
    assert.equal(second.graph.coverage[1].proof.kind, "final-review");
    assert.deepEqual(
      rendered.map((entry) => entry.phase),
      ["compile", "graph-review", "diagnosis", "compile", "graph-review"],
    );
    for (const packet of rendered) {
      assert.deepEqual(packet.packet.prerequisites, preparation);
      assert.deepEqual(
        packet.packet.localExecutables,
        currentRequest.localExecutables,
      );
      assert.equal(
        packet.packet.localExecutables.baseSha,
        first.finalAcceptance.commit,
      );
      assert.equal(
        packet.packet.localExecutables.provenance,
        "controller-local-validation-executable-preflight",
      );
      // The plan reviewer receives these as controller review evidence
      // (checked in the fake above), not as prompt sections.
      if (packet.phase === "graph-review") continue;
      assert(packet.prompt.includes(JSON.stringify(preparation)));
      assert(
        packet.prompt.includes(JSON.stringify(currentRequest.localExecutables)),
      );
    }
    assert.equal(second.allowanceConsumption.planningRevisions, 1);
    assert.equal(
      readEvents(f.eventsPath).filter((event) => event.type === "start").length,
      2,
    );
  }, plannedRevision));

test("native planning facts refuse missing, unaccepted, changed and mismatched predecessors and bind descendant bases honestly", async () =>
  fixture(async (f) => {
    await assert.rejects(
      planObjective(f.config, 2, { github: f.github, planningModel: f.model }),
      /lacks bound accepted/,
    );
    await f.application.enqueueIntake([1], { pollSeconds: 0.01 });
    await f.application.runIntake();
    const first = readState(f.config.repository, 1);
    const exact = await planningPrerequisites(
      f.config,
      f.github,
      2,
      first.finalAcceptance.commit,
    );
    assert.equal(exact.predecessors[0].status, "accepted-and-closed");
    git(f.config.checkout, "merge", "--ff-only", first.finalAcceptance.commit);
    const candidate = await planObjective(f.config, 2, {
      github: f.github,
      planningModel: f.model,
    });
    verifyPlanCandidate(
      candidate,
      2,
      f.issues.get(2).body,
      candidate.baseSha,
      f.config.checkout,
      factoryConfigDigest(f.config),
    );
    const tampered = structuredClone(candidate);
    tampered.prerequisites.predecessors[0].acceptance.commit = f.target.baseSha;
    assert.throws(
      () =>
        verifyPlanCandidate(
          tampered,
          2,
          f.issues.get(2).body,
          candidate.baseSha,
          f.config.checkout,
          factoryConfigDigest(f.config),
        ),
      /Plan candidate differs/,
    );
    await assert.rejects(
      planningPrerequisites(f.config, f.github, 2, f.target.baseSha),
    );
    f.issues.get(1).body += "\nChanged after acceptance\n";
    await assert.rejects(
      planObjective(f.config, 2, { github: f.github, planningModel: f.model }),
      /body changed after acceptance/,
    );
    f.issues.get(1).body = body(1);
    writeFileSync(
      join(f.config.checkout, "later.txt"),
      "Later authenticated base\n",
    );
    git(f.config.checkout, "add", "later.txt");
    git(
      f.config.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Later default branch",
    );
    const later = git(f.config.checkout, "rev-parse", "HEAD");
    const descendant = await planningPrerequisites(
      f.config,
      f.github,
      2,
      later,
    );
    assert.equal(descendant.baseSha, later);
    assert.equal(
      descendant.predecessors[0].acceptance.commit,
      exact.predecessors[0].acceptance.commit,
    );
    assert.equal(descendant.predecessors[0].baseRelationship, "descendant");
    const original = structuredClone(first);
    first.finalAcceptance.tree = f.target.baseSha;
    saveState(statePath(f.config.repository, 1), first);
    await assert.rejects(
      planningPrerequisites(f.config, f.github, 2, later),
      /sealed candidate|evidence/,
    );
    Object.assign(first, original);
    first.objectiveClosure = "pending";
    saveState(statePath(f.config.repository, 1), first);
    await assert.rejects(
      planningPrerequisites(f.config, f.github, 2, later),
      /lacks bound accepted/,
    );
  }));

const twoRevisions = {
  ...limits,
  allowances: { ...limits.allowances, planningRevisions: 2 },
};
async function activatedSuccessor(
  f,
  descendant = false,
  dependent = true,
  historical = false,
) {
  await f.application.enqueueIntake([1], { pollSeconds: 0.01 });
  await f.application.runIntake();
  const first = readState(f.config.repository, 1);
  assert.equal(objectiveComplete(first), true);
  if (historical) {
    delete first.finalAcceptance.candidateBasis;
    saveState(statePath(f.config.repository, 1), first);
  }
  git(f.config.checkout, "merge", "--ff-only", first.finalAcceptance.commit);
  if (descendant) {
    writeFileSync(join(f.config.checkout, "later.txt"), "Later baseline\n");
    git(f.config.checkout, "add", "later.txt");
    git(
      f.config.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Later baseline",
    );
    git(f.config.checkout, "push", "origin", "main");
  }
  if (!dependent) f.dependencies.set(2, []);
  // A read-only preview of the plan the run compiles from the same deterministic model.
  const candidate = await f.application.planObjective(2);
  // Refuse a worker start only after production activation has persisted the successor.
  f.driver.start = async () => {
    throw new Error("Fixture activated hold");
  };
  await assert.rejects(f.application.runObjective(2), /Fixture activated hold/);
  const second = readState(f.config.repository, 2);
  assert.equal(second.graphRevisions, undefined);
  assert.deepEqual(second.graph, candidate.graph);
  assert.equal(second.work["result-2"].status, "failed");
  second.coordinator.mode = "running";
  return { first, second, candidate };
}

function successorDiscovery(state) {
  submitAmendment(state, {
    scope: "in-scope",
    reason: "Independent integrated proof of the existing source acceptance",
    evidence: ["Objective acceptance requires result-2.txt at integrated head"],
    ownership: ["result-2.txt"],
    acceptance: ["result-2.txt exists"],
    dependencies: ["result-2"],
    actor: "fixture",
    expectedGraphDigest: graphDigest(state.graph),
  });
}

for (const [descendant, dependent, historical] of [
  [false, true],
  [true, true],
  [false, false],
  [false, true, true],
])
  test(`activated ${dependent ? "native successor" : "first Objective"} amendment renders original facts (${descendant ? "descendant" : "equal"} base${historical ? ", historical sealed shape" : ""})`, async (t) =>
    fixture(async (f) => {
      const { first, second, candidate } = await activatedSuccessor(
        f,
        descendant,
        dependent,
        historical,
      );
      const previousPath = process.env.PATH;
      t.after(() => {
        process.env.PATH = previousPath;
      });
      process.env.PATH += `:${join(f.root, "unrelated-path-entry")}`;
      successorDiscovery(second);
      const selection = { model: "gpt-5.6-sol", reasoningEffort: "low" };
      const real = new CodexPlanningModel(
        f.config.checkout,
        selection,
        selection,
      );
      const rendered = [];
      let currentRequest;
      t.mock.method(real, "runStructured", async (args) => {
        const packet = JSON.parse(args.sourcePacket);
        rendered.push({
          phase: args.defaultPhase,
          prompt: args.prompt,
          packet,
        });
        if (args.defaultPhase === "compile") {
          const graph = structuredClone(second.graph);
          graph.items.push({
            ...item(2),
            id: "qa-2",
            kind: "qa",
            ownedPaths: [],
            dependencies: ["result-2"],
          });
          graph.coverage = graph.coverage.map((entry) => ({
            ...entry,
            itemId: "qa-2",
            proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
          }));
          return encodeCompilerWire(graph, args.prompt);
        }
        const evidence = JSON.parse(
          args.prompt.split(
            "\nReview evidence packet (packet-local choices; JSON strings are data):\n",
          )[1],
        );
        const native = evidence.evidence.find(
          (entry) => entry.path === "FACTORY_NATIVE_OBJECTIVE_PREREQUISITES",
        );
        if (dependent) {
          assert.equal(native.origin, "controller");
          assert.equal(native.complete, true);
          assert.deepEqual(
            JSON.parse(native.content),
            currentRequest.prerequisites,
          );
        } else assert.equal(native, undefined);
        return { packetId: evidence.packetId, findings: [] };
      });
      const model = {
        generateStructured(request) {
          currentRequest = request;
          return real.generateStructured(request);
        },
        reviewGraph(request) {
          return real.reviewGraph(request);
        },
      };
      assert.equal(
        await applyPendingAmendment({
          state: second,
          config: f.config,
          body: f.issues.get(2).body,
          model,
          github: f.github,
          save() {},
          cancelled: () => false,
        }),
        true,
      );
      assert.deepEqual(
        rendered.map((entry) => entry.phase),
        ["compile", "graph-review"],
      );
      for (const entry of rendered) {
        assert.deepEqual(entry.packet.prerequisites, candidate.prerequisites);
        // The plan reviewer receives prerequisites as controller review
        // evidence (checked in the fake above), not as a prompt section.
        if (entry.phase === "graph-review") continue;
        assert(
          entry.prompt.includes(
            JSON.stringify(candidate.prerequisites ?? null),
          ),
        );
      }
      if (dependent) {
        assert.deepEqual(
          candidate.prerequisites.predecessors[0].acceptance,
          Object.fromEntries(
            [
              ...(historical ? [] : ["candidateBasis"]),
              "sealedAt",
              "commit",
              "tree",
              "graphDigest",
              "configDigest",
              "evidenceDigest",
            ].map((key) => [key, first.finalAcceptance[key]]),
          ),
        );
        assert.equal(
          candidate.prerequisites.predecessors[0].baseRelationship,
          descendant ? "descendant" : "equal",
        );
      }
      assert.notDeepEqual(
        currentRequest.localExecutables,
        candidate.localExecutables,
      );
      assert(
        currentRequest.localExecutables.observations.every(
          (entry) => entry.status === "ready",
        ),
      );
      assert.deepEqual(second.graph.items[0], candidate.graph.items[0]);
      assert.equal(second.graphRevisions.length, 2);
      assert.equal(second.graphRevisions[0].digest, candidate.graphDigest);
      assert.equal(second.allowanceConsumption.planningRevisions, 1);
      assert.equal(second.baseSha, candidate.baseSha);
      assert.equal(second.objectiveBodyDigest, candidate.bodyDigest);
      assert.equal(second.configDigest, candidate.configDigest);
      if (historical) {
        assert.equal(
          Object.hasOwn(
            candidate.prerequisites.predecessors[0].acceptance,
            "candidateBasis",
          ),
          false,
        );
        assert.deepEqual(
          readState(f.config.repository, 1).finalAcceptance,
          first.finalAcceptance,
        );
      }
    }, twoRevisions));

test("native successor amendments refuse missing, unaccepted, changed and removed original evidence before model calls", async () =>
  fixture(async (f) => {
    const { first, second } = await activatedSuccessor(f);
    let calls = 0;
    const model = {
      async generateStructured() {
        calls++;
        throw new Error("Unexpected model call");
      },
      async reviewGraph() {
        calls++;
        throw new Error("Unexpected model call");
      },
    };
    for (const fault of [
      "missing",
      "unaccepted",
      "body",
      "relationship",
      "tree",
    ]) {
      const state = structuredClone(second);
      successorDiscovery(state);
      if (fault === "missing") rmSync(statePath(f.config.repository, 1));
      if (fault === "unaccepted")
        saveState(statePath(f.config.repository, 1), {
          ...first,
          objectiveClosure: "pending",
        });
      if (fault === "body")
        f.issues.get(1).body += "\nChanged after acceptance\n";
      if (fault === "relationship") f.dependencies.set(2, []);
      if (fault === "tree") {
        const changed = structuredClone(first);
        changed.finalAcceptance.tree = f.target.baseSha;
        saveState(statePath(f.config.repository, 1), changed);
      }
      await assert.rejects(
        applyPendingAmendment({
          state,
          config: f.config,
          body: f.issues.get(2).body,
          model,
          github: f.github,
          save() {},
          cancelled: () => false,
        }),
        /accepted|acceptance|sealed|evidence|prerequisite/,
      );
      assert.equal(calls, 0, fault);
      assert.equal(state.pendingAmendment.phase, "rejected");
      assert.deepEqual(state.graph, second.graph);
      assert.equal(state.allowanceConsumption.planningRevisions, 1);
      saveState(statePath(f.config.repository, 1), first);
      f.issues.get(1).body = body(1);
      f.dependencies.set(2, [1]);
    }
  }, twoRevisions));

test("one intake listener serves entry and terminal return controls under the same owner", async (t) =>
  fixture(async (f) => {
    const servers = new Set();
    let closes = 0;
    const listen = Server.prototype.listen;
    const close = Server.prototype.close;
    t.mock.method(Server.prototype, "listen", function (...args) {
      if (String(args[0]).endsWith("/control.sock")) servers.add(this);
      return listen.apply(this, args);
    });
    t.mock.method(Server.prototype, "close", function (...args) {
      if (servers.has(this)) closes++;
      return close.apply(this, args);
    });
    const entry = Promise.withResolvers();
    const releaseEntry = Promise.withResolvers();
    const returned = Promise.withResolvers();
    const releaseReturn = Promise.withResolvers();
    // Hold Objective entry once its persisted plan starts projection.
    const project = f.github.projectGraph.bind(f.github);
    let entryHeld = false;
    f.github.projectGraph = async (request) => {
      if (
        !entryHeld &&
        request.objectiveIssue === 1 &&
        Boolean(readContinuation(f.config.repository, 1)?.plan)
      ) {
        entryHeld = true;
        entry.resolve();
        await releaseEntry.promise;
      }
      return project(request);
    };
    const scan = f.github.intakePage.bind(f.github);
    f.github.intakePage = async (...args) => {
      if (
        readContinuation(f.config.repository, 1)?.objectiveClosure ===
        "complete"
      ) {
        returned.resolve();
        await releaseReturn.promise;
      }
      return scan(...args);
    };
    await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
    const running = f.application.runIntake();
    const ownerPath = join(stateRoot(f.config.repository), "controller.lock");
    try {
      await entry.promise;
      const owner = readControllerOwner(ownerPath);
      assert.equal(owner.objective, 1);
      assert.equal(servers.size, 1);
      assert.equal(closes, 0);
      await intakeControl(f.config, "pause");
      assert.equal(
        (await controlObjective(f.config, { objective: 1, action: "status" }))
          .mode,
        "paused",
      );
      await intakeControl(f.config, "drain");
      assert.equal(
        (await controlObjective(f.config, { objective: 1, action: "status" }))
          .mode,
        "draining",
      );
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        0,
      );
      assert.equal(readControllerOwner(ownerPath).token, owner.token);
      await intakeControl(f.config, "resume");
      releaseEntry.resolve();
      await returned.promise;
      assert.equal(objectiveComplete(readState(f.config.repository, 1)), true);
      assert.equal(readControllerOwner(ownerPath).objective, 0);
      assert.equal(readControllerOwner(ownerPath).token, owner.token);
      assert.equal(servers.size, 1);
      assert.equal(closes, 0);
      assert.ok(
        await controlObjective(f.config, { objective: 1, action: "status" }),
      );
      await intakeControl(f.config, "pause");
      assert.equal((await intakeControl(f.config, "status")).mode, "paused");
      await intakeControl(f.config, "drain");
      assert.equal((await intakeControl(f.config, "status")).mode, "draining");
      releaseReturn.resolve();
      await running;
      assert.equal(closes, 1);
      assert.equal(readControllerOwner(ownerPath), undefined);
      assert.equal(readContinuation(f.config.repository, 2), undefined);
      assert.deepEqual(
        f.plans.map((entry) => entry.objective),
        [1],
      );
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
    } finally {
      releaseEntry.resolve();
      releaseReturn.resolve();
      if (readControllerOwner(ownerPath))
        await requestControl(f.config.repository, {
          objective: 0,
          action: "handoff",
        });
      await running;
    }
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
    await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
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
    await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
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
    await f.application.enqueueIntake([1], { pollSeconds: 0.01 });
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
    await f.application.enqueueIntake(objectives, {
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
    await f.application.enqueueIntake([1], { pollSeconds: 0.01 });
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
      await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
      saveState(statePath(f.config.repository, 1), {
        schemaVersion: 7,
        kind: "preparing",
        repository: f.config.repository,
        objective: 1,
        runId: "failed-preparation",
        autonomy: resolveAutonomy(limits),
        capacity: { concurrency: f.config.execution.concurrency },
        configDigest: factoryConfigDigest(f.config),
        baseSha: f.target.baseSha,
        objectiveBodyDigest: createHash("sha256").update(body(1)).digest("hex"),
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
    await f.application.enqueueIntake(objectives, { pollSeconds: 0.01 });
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
    assert.deepEqual(before.autonomy, resolveAutonomy(limits));
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
    // A paused preparation keeps its owner waiting for resume; hand off to stop it.
    await requestControl(f.config.repository, {
      objective: 0,
      action: "handoff",
    });
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
    await f.application.enqueueIntake([1], { pollSeconds: 0.01 });
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

const watcherConsent = {
  actor: "fixture",
  reason: "Observe approved target without spending",
  consent: true,
};

test("idle intake status does not rescan or race an immediate same-owner refill", async () =>
  fixture(async (f) => {
    const { watchIntake } = await import("../dist/intake.js");
    const firstScan = Promise.withResolvers();
    const releaseFirst = Promise.withResolvers();
    const secondScan = Promise.withResolvers();
    const releaseSecond = Promise.withResolvers();
    let scans = 0;
    f.github.intakePage = async () => {
      scans++;
      if (scans === 1) {
        firstScan.resolve();
        await releaseFirst.promise;
      } else {
        secondScan.resolve();
        await releaseSecond.promise;
      }
      return { status: 200, etag: '"deferred"', data: [] };
    };
    await watchIntake(f.config, watcherConsent, { pollSeconds: 60 });
    const running = f.application.runIntake();
    try {
      await firstScan.promise;
      releaseFirst.resolve();
      // The socket response follows the released scan's microtasks. No polling
      // or timed retries are needed to reach the first settled boundary.
      const status = await intakeControl(f.config, "status");
      assert.equal(status.observation.idleReason, "awaiting-approved-work");
      assert.equal(status.activeObjective, null);
      assert.equal(
        scans,
        1,
        "status must preserve the 60-second poll schedule",
      );
      const before = readIntake(f.config);
      const owner = readControllerOwner(
        join(stateRoot(f.config.repository), "controller.lock"),
      );
      assert.deepEqual(await intakeControl(f.config, "status"), status);
      assert.deepEqual(readIntake(f.config), before);
      assert.equal(scans, 1);
      const selected = await f.application.enqueueIntake([1]);
      assert.deepEqual(selected.objectives, [1]);
      assert.equal(
        readControllerOwner(
          join(stateRoot(f.config.repository), "controller.lock"),
        ).token,
        owner.token,
      );
      // A mutation still wakes observation. Its existing refill fence remains
      // enforced while that second GitHub scan is deliberately outstanding.
      await secondScan.promise;
      await assert.rejects(
        f.application.enqueueIntake([1]),
        /settled refill boundary/,
      );
      await assert.rejects(
        watchIntake(f.config, watcherConsent, { pollSeconds: 60 }),
        /settled refill boundary/,
      );
      await intakeControl(f.config, "status");
      assert.equal(scans, 2);
      assert.deepEqual(f.plans, []);
    } finally {
      // Keep cleanup model-free even if an assertion fails on the old code.
      f.issues.get(1).state = "closed";
      releaseFirst.resolve();
      releaseSecond.resolve();
      await intakeControl(f.config, "drain");
      await running;
    }
    assert.deepEqual(f.plans, []);
    assert.equal(
      readControllerOwner(
        join(stateRoot(f.config.repository), "controller.lock"),
      ),
      undefined,
    );
  }));

async function waitFor(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Intake fixture condition did not settle");
}
async function settledEnqueue(application, selection) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await application.enqueueIntake(selection);
    } catch (error) {
      if (!String(error).includes("settled refill boundary")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Refill did not reach its settled boundary");
}

test("consented continuous intake stays model-free while idle and refills through its same owner without reviving completed work", async () =>
  fixture(async (f) => {
    const { watchIntake } = await import("../dist/intake.js");
    await watchIntake(f.config, watcherConsent, { pollSeconds: 0.05 });
    assert.deepEqual(readIntake(f.config).objectives, []);
    const running = f.application.runIntake();
    await waitFor(
      () =>
        readIntake(f.config).observation?.idleReason ===
        "awaiting-approved-work",
    );
    assert.deepEqual(readIntake(f.config).observation.unapproved, [1, 2]);
    assert.deepEqual(f.plans, []);
    const owner = readControllerOwner(
      join(stateRoot(f.config.repository), "controller.lock"),
    );
    await settledEnqueue(f.application, [1]);
    await waitFor(() => {
      const state = readContinuation(f.config.repository, 1);
      return (
        state?.schemaVersion === 6 &&
        objectiveComplete(state) &&
        readIntake(f.config).observation?.idleReason ===
          "awaiting-approved-work"
      );
    });
    const first = JSON.stringify(readContinuation(f.config.repository, 1));
    assert.equal(
      readControllerOwner(
        join(stateRoot(f.config.repository), "controller.lock"),
      ).token,
      owner.token,
    );
    await settledEnqueue(f.application, [1, 2]);
    await waitFor(() => {
      const state = readContinuation(f.config.repository, 2);
      return (
        state?.schemaVersion === 6 &&
        objectiveComplete(state) &&
        readIntake(f.config).observation?.idleReason ===
          "awaiting-approved-work"
      );
    });
    assert.equal(
      JSON.stringify(readContinuation(f.config.repository, 1)),
      first,
    );
    assert.deepEqual(
      f.plans.map((entry) => entry.objective),
      [1, 2],
    );
    await intakeControl(f.config, "drain");
    await running;
    assert.equal(
      readControllerOwner(
        join(stateRoot(f.config.repository), "controller.lock"),
      ),
      undefined,
    );
    await intakeControl(f.config, "resume");
    const restarted = f.application.runIntake();
    await waitFor(
      async () =>
        (
          await requestControl(f.config.repository, {
            objective: 0,
            action: "status",
          })
        ).handled,
    );
    assert.deepEqual(
      f.plans.map((entry) => entry.objective),
      [1, 2],
    );
    await intakeControl(f.config, "drain");
    await restarted;
  }));

test("watch retains changed-body fences and reports unavailable observations without candidate body storage or model calls", async () =>
  fixture(async (f) => {
    const { watchIntake } = await import("../dist/intake.js");
    await watchIntake(f.config, watcherConsent, { pollSeconds: 0.05 });
    await f.application.enqueueIntake([1], { watch: true, pollSeconds: 0.05 });
    f.issues.get(1).body += "Changed after explicit authorization";
    const running = f.application.runIntake();
    await waitFor(() =>
      readIntake(f.config).observation?.reasons[1]?.includes("body changed"),
    );
    assert.deepEqual(readIntake(f.config).observation.unapproved, [2]);
    assert.deepEqual(f.plans, []);
    f.github.intakePage = async () => {
      throw new Error("Fixture observation unavailable");
    };
    await waitFor(() =>
      readIntake(f.config).observation?.error?.includes(
        "observation unavailable",
      ),
    );
    const observation = JSON.stringify(readIntake(f.config).observation);
    assert.doesNotMatch(observation, /result-1\.txt|Changed after explicit/);
    assert.equal(readIntake(f.config).observation.idleReason, undefined);
    await intakeControl(f.config, "drain");
    await running;
  }));

test("watch and refill preserve failed nonterminal fences and require real service consent", async () =>
  fixture(async (f) => {
    const { watchIntake } = await import("../dist/intake.js");
    await assert.rejects(
      watchIntake(f.config, { ...watcherConsent, consent: false }),
      /explicit service consent/,
    );
    await assert.rejects(
      f.application.enqueueIntake(objectives, { watch: true }),
      /explicit service consent/,
    );
    await watchIntake(f.config, watcherConsent);
    const failed = {
      schemaVersion: 7,
      kind: "preparing",
      repository: f.config.repository,
      objective: 1,
      configDigest: factoryConfigDigest(f.config),
      runId: "preserved-failure",
      autonomy: resolveAutonomy(limits),
      capacity: { concurrency: f.config.execution.concurrency },
      baseSha: "a".repeat(40),
      objectiveBodyDigest: "b".repeat(64),
      coordinator: {
        mode: "paused",
        phase: "idle",
        phaseStartedAt: new Date().toISOString(),
      },
      error: "Fixture submitted outcome unknown",
      issueByItemId: {},
    };
    saveState(statePath(f.config.repository, 1), failed);
    await assert.rejects(
      f.application.enqueueIntake(objectives),
      /active Objective prevents/,
    );
    await assert.rejects(
      watchIntake(f.config, watcherConsent),
      /active Objective prevents/,
    );
    assert.deepEqual(readContinuation(f.config.repository, 1), failed);
    assert.deepEqual(readIntake(f.config).objectives, []);
  }));
