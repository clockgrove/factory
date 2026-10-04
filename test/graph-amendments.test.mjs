import { consumption } from "../dist/repair-policy.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyPendingAmendment,
  assertGraphRevisions,
  graphDigest,
  submitAmendment,
  validateAmendment,
} from "../dist/graph-amendments.js";
import {
  workItemReviewEvidence,
  objectiveReviewEvidence,
} from "../dist/validation.js";
import { aggregateAcceptance, coverageObligations } from "../dist/qa.js";
import {
  compilerCitationChoices,
  objectiveCriteria,
  CodexPlanningModel,
} from "../dist/compiler.js";
import { readyItems, validateAndOrderGraph } from "../dist/scheduler.js";
import { readState, statePath } from "../dist/state-store.js";
import { failureDigest, resolveAutonomy } from "../dist/repair-policy.js";
import { parseFactoryState } from "../dist/state.js";
import { requestControl } from "../dist/coordinator-control.js";
import { controlObjective } from "../dist/runner.js";
import { checkServiceState } from "../dist/supervision.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { compilerWire } from "../dist/compiler-wire.js";
import { GitHubRequestError } from "../dist/github-client.js";
import { CompletedModelInvocationError } from "../dist/contracts.js";
import { encodeCompilerWire } from "./support/compiler-wire.mjs";
import { attachFault, decision, transient } from "../dist/fault.js";
import { clearRepeats } from "../dist/step.js";

// Step backoff runs on a virtual clock, so repeats never sleep in real time.
let virtualTime = Date.now();
const clock = {
  now: () => virtualTime,
  sleep: async (milliseconds) => {
    virtualTime += milliseconds;
  },
};
/** A response lost in transit, as a model or GitHub adapter classifies it. */
const lost = (message) =>
  attachFault(new Error(message), transient(message, true));
import { packetFromPrompt } from "./support/review-protocol.mjs";

const discovery = {
  scope: "in-scope",
  reason: "Required integrated behavior needs independent QA",
  evidence: ["Implementation result needs integrated proof"],
  ownership: ["result.txt"],
  acceptance: ["result.txt exists at integrated head"],
  dependencies: ["result"],
};
// One planning revision pays for one amendment; no repair is enabled.
const autonomyConfig = {
  allowances: {
    planningRevisions: 1,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
};
const autonomy = resolveAutonomy(autonomyConfig);
// Two planning revisions, both chargeable as diagnosed planning-output repairs.
const replacementAutonomy = {
  allowances: { ...autonomyConfig.allowances, planningRevisions: 2 },
  repairClasses: ["planning-output"],
  repairPolicy: {
    perPath: { ...autonomyConfig.allowances, planningRevisions: 2 },
  },
};
const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
function item(id = "result", dependencies = []) {
  return {
    kind: "work",
    children: [],
    inputSources: compilerCitationChoices([
      { path: "OBJECTIVE", content: body },
    ]).filter((choice) => choice.heading === "Acceptance"),
    id,
    title: id,
    goal: `Write ${id}.txt`,
    brief: `Write ${id}.txt`,
    acceptance: ["result.txt exists"],
    nonGoals: ["No unrelated changes"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths: [`${id}.txt`],
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
}
function qaGraph(graph) {
  const next = structuredClone(graph);
  next.items.push({ ...item("qa", ["result"]), kind: "qa", ownedPaths: [] });
  next.coverage = next.coverage.map((entry) => ({
    ...entry,
    itemId: "qa",
    proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
  }));
  return next;
}
async function fixture(name, fn, delivery = "regular") {
  const root = mkdtempSync(join(tmpdir(), `factory-amend-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      `example/amend-${name}`,
      delivery,
    );
    config.autonomy = structuredClone(autonomyConfig);
    const initial = { objective: 1, baseSha: target.baseSha, items: [item()] };
    await fn({ root, config, initial, target });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: worker discovery adds reviewed QA and parent evidence through dependencies and final review without rerunning implementation`, async () => {
    await fixture(
      delivery,
      async ({ root, config, initial }) => {
        let generated = 0;
        let reviews = 0;
        let first;
        const packets = [];
        const planningModel = {
          async generateStructured(request) {
            generated++;
            assert.deepEqual(request.executionBounds, {
              configuredConcurrency: config.execution.concurrency,
            });
            assert.equal(
              request.localExecutables.provenance,
              "controller-local-validation-executable-preflight",
            );
            assert.deepEqual(request.localExecutables.finalCommands, [
              "test -s result.txt",
            ]);
            if (!first) {
              first = withCoverage(request, initial);
              return first;
            }
            assert.deepEqual(request.compileContext.immutableItemIds, [
              "result",
            ]);
            const wire = compilerWire(
              request,
              compilerCitationChoices(request.sources),
            );
            const amended = qaGraph(first);
            amended.items.push({
              ...item("aggregate", ["result", "qa"]),
              kind: "aggregate",
              children: ["result", "qa"],
              ownedPaths: [],
              acceptance: aggregateAcceptance({ id: "aggregate" }),
              validation: [],
            });
            const value = encodeCompilerWire(amended, wire.data);
            assert.deepEqual(value.items[0], {
              kind: "retained",
              id: "result",
              coverage: [],
            });
            return wire.decode(value);
          },
          async reviewGraph(request) {
            reviews++;
            const bounds = request.reviewPacket.evidence.find(
              (entry) => entry.path === "FACTORY_EXECUTION_BOUNDS",
            );
            assert.equal(bounds.origin, "controller");
            assert.deepEqual(
              JSON.parse(bounds.content),
              request.executionBounds,
            );
            assert.equal(
              request.localExecutables.provenance,
              "controller-local-validation-executable-preflight",
            );
            const host = request.reviewPacket.evidence.find(
              (entry) => entry.path === "FACTORY_LOCAL_EXECUTABLE_OBSERVATIONS",
            );
            assert.equal(host.origin, "controller");
            assert.deepEqual(
              JSON.parse(host.content),
              request.localExecutables,
            );
            if (request.amendment) {
              assert.equal(request.amendment.work.result.status, "done");
              const parent = request.graph.items.find(
                (entry) => entry.kind === "aggregate",
              );
              assert.match(
                parent.acceptance[0],
                /Implementation child results/,
              );
              assert.match(
                parent.acceptance[0],
                /read-only QA and aggregate children have accepted proof/,
              );
              assert.doesNotMatch(
                parent.acceptance[0],
                /Every explicit child.*its result is integrated/,
                "The controller cannot require delivery from the read-only QA child",
              );
            }
            return {
              packetId: request.reviewPacket.id,
              findings: [],
            };
          },
          async reviewResult(request) {
            packets.push(request);
            if (
              request.observations &&
              JSON.parse(request.observations).reviewedItemId === "result"
            ) {
              const observation = request.reviewPacket.evidence.find(
                (entry) => entry.path === "Delivery observations",
              );
              const captured = JSON.parse(observation.content).harnessDiscovery;
              assert.equal(observation.origin, "controller");
              assert.equal(observation.complete, true);
              assert.equal(captured.itemId, "result");
              assert.equal(captured.resultTreeSha, request.treeSha);
              assert.equal(captured.contentOrigin, "harness-declared-proposal");
              assert.deepEqual(captured.proposal, discovery);
              assert.equal(captured.acceptedAmendment, null);
              assert(captured.attemptId);
              assert.match(captured.resultCommitSha, /^[a-f0-9]{40}$/);
              assert(!request.change.includes(".factory-discovery.json"));
            }
            return {
              packetId: request.reviewPacket.id,
              findings: request.reviewPacket.criteria.map(
                (criterion, criterionIndex) => ({
                  criterionIndex,
                  evidenceIndices: [
                    request.reviewPacket.evidence.findIndex(
                      (entry) => entry.path === "OBJECTIVE",
                    ),
                  ],
                  verdict: "pass",
                  detail: "Fixture source-backed acceptance",
                  question: "",
                }),
              ),
            };
          },
        };
        const setup = makeApplication({
          config,
          graph: initial,
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          planningModel,
          actions: {
            result: {
              files: [
                { path: "result.txt", text: "done\n" },
                {
                  path: ".factory-discovery.json",
                  text: JSON.stringify(discovery),
                },
              ],
            },
          },
        });
        const state = await setup.application.runObjective(1);
        assert.equal(state.finalValidation.passed, true);
        assert.equal(generated, 2);
        assert.equal(reviews, 2);
        assert.equal(state.graphRevisions.length, 2);
        assert.deepEqual(
          state.graphRevisions[0].graph.items.map(({ id }) => id),
          ["result"],
        );
        assert.equal(consumption(state).planningRevisions, 1);
        assert.equal(state.work.result.discoveryDisposition, "accepted");
        assert.equal(state.work.qa.status, "done");
        assert.equal(state.work.qa.pullRequest, undefined);
        assert.equal(state.work.qa.execution, undefined);
        assert.equal(state.work.qa.changeRef, state.integratedSha);
        assert.equal(
          readEvents(setup.eventsPath).filter((event) => event.type === "start")
            .length,
          1,
        );
        assertGraphRevisions(readState(config.repository, 1));
        assert.doesNotThrow(() => checkServiceState(config, 1));
        assert.equal(state.work.aggregate.status, "done");
        assert.equal(state.work.aggregate.pullRequest, undefined);
        assert.equal(state.work.aggregate.execution, undefined);
        assert.equal(state.work.aggregate.changeRef, state.work.qa.changeRef);
        const finalPacket = packets.find(
          (packet) => packet.reviewPhase === "objective-review",
        );
        const captured = JSON.parse(finalPacket.observations).work.find(
          (entry) => entry.id === "result",
        ).harnessDiscovery;
        assert.equal(captured.itemId, "result");
        assert.equal(captured.attemptId, state.work.result.attempt);
        assert.equal(captured.resultCommitSha, state.work.result.changeRef);
        assert.equal(captured.resultTreeSha, state.work.result.treeSha);
        assert.deepEqual(captured.proposal, discovery);
        const receipt = captured.acceptedAmendment;
        const revision = state.graphRevisions[1];
        assert.equal(receipt.parentGraphDigest, state.graphRevisions[0].digest);
        assert.equal(receipt.graphDigest, revision.digest);
        assert.equal(receipt.reviewDigest, revision.reviewDigest);
        assert.equal(receipt.acceptedAt, revision.acceptedAt);
        assert.deepEqual(receipt.worker, {
          itemId: "result",
          attempt: state.work.result.attempt,
        });
        assert.deepEqual(
          receipt.addedItems.map((entry) => [entry.id, entry.kind]),
          [
            ["qa", "qa"],
            ["aggregate", "aggregate"],
          ],
        );
        assert.deepEqual(receipt.addedItems[0].dependencies, ["result"]);
        assert.deepEqual(receipt.addedItems[1].children, ["result", "qa"]);
        assert.deepEqual(receipt.addedItems[1].dependencies, ["result", "qa"]);
        assert(
          receipt.addedItems.every((entry) => entry.ownedPaths.length === 0),
        );
        assert(
          state.graphRevisions[0].graph.items.every(
            (entry) => !["qa", "aggregate"].includes(entry.id),
          ),
        );
        for (const id of ["qa", "aggregate"]) {
          const packet = packets.find(
            (packet) =>
              packet.observations &&
              JSON.parse(packet.observations).reviewedItemId === id,
          );
          const dependencies = JSON.parse(
            packet.evidence.find(
              (entry) => entry.path === "Completed dependency results",
            ).content,
          );
          assert.deepEqual(
            dependencies.work.find((entry) => entry.id === "result")
              .harnessDiscovery,
            captured,
          );
        }
        const wireModel = new CodexPlanningModel(config.checkout);
        wireModel.runStructured = async ({ prompt, schema, defaultPhase }) => {
          assert.equal(defaultPhase, "objective-review");
          const packet = packetFromPrompt(prompt);
          assert.equal(packet.packetId, finalPacket.reviewPacket.id);
          assert.equal(schema.properties.packetId.enum[0], packet.packetId);
          assert.deepEqual(
            JSON.parse(
              packet.evidence.find(
                (entry) => entry.path === "Delivery observations",
              ).content,
            ).work.find((entry) => entry.id === "result").harnessDiscovery,
            captured,
          );
          assert(
            prompt.includes("it is not proof that no submission occurred"),
          );
          assert(
            prompt.includes(
              "Required discovery remains unproved unless supplied evidence establishes it",
            ),
          );
          assert(
            prompt.includes(
              "receipt facts supply no proof of amendment acceptance",
            ),
          );
          assert(!prompt.includes("receipt facts prove no accepted amendment"));
          assert(
            !prompt.includes(
              "An absent or stale discovery proves no submission",
            ),
          );
          return planningModel.reviewResult(finalPacket);
        };
        await wireModel.reviewResult(finalPacket);
        const projection = (snapshot) =>
          objectiveReviewEvidence({
            state: snapshot,
            checkout: config.checkout,
            candidateCommitSha: snapshot.integratedSha,
            candidateTreeSha: finalPacket.treeSha,
          });
        for (const corruption of [
          "missing",
          "stale",
          "worker",
          "proposal",
          "unaccepted",
          "backlog",
        ]) {
          const broken = structuredClone(state);
          if (corruption === "missing") delete broken.work.result.discovery;
          if (corruption === "stale")
            broken.work.result.discovery.attempt = "stale-attempt";
          if (corruption === "worker")
            broken.graphRevisions[1].proposal.worker.attempt =
              "unrelated-attempt";
          if (corruption === "proposal")
            broken.graphRevisions[1].proposal.reason = "Different discovery";
          if (corruption === "unaccepted")
            broken.work.result.discoveryDisposition = "proposed";
          if (corruption === "backlog")
            broken.work.result.discovery.scope = "backlog";
          const capture = JSON.parse(projection(broken).observations).work.find(
            (entry) => entry.id === "result",
          ).harnessDiscovery;
          if (["missing", "stale"].includes(corruption))
            assert.equal(capture, null);
          else assert.equal(capture.acceptedAmendment, null);
        }
        for (const corruption of [
          "missing-revision",
          "review",
          "parent",
          "digest",
        ]) {
          const broken = structuredClone(state);
          if (corruption === "missing-revision") broken.graphRevisions.pop();
          if (corruption === "review")
            delete broken.graphRevisions[1].reviewDigest;
          if (corruption === "parent")
            broken.graphRevisions[1].parentDigest = "0".repeat(64);
          if (corruption === "digest")
            broken.graphRevisions[1].digest = "0".repeat(64);
          assert.throws(
            () => projection(broken),
            /Graph revision|Current graph/,
          );
        }
      },
      delivery,
    );
  });

test("amendment validation preserves cycles, stable/completed identity, command authority and coverage", async () => {
  await fixture("validation", async ({ config, initial }) => {
    const obligations = coverageObligations(body, objectiveCriteria(body));
    const graph = withCoverage({ coverageObligations: obligations }, initial);
    graph.coverage[0].source = obligations[0].source;
    const state = {
      graph,
      objective: 1,
      baseSha: initial.baseSha,
      issueByItemId: { result: 2 },
      work: { result: { status: "pending" } },
      autonomy,
      capacity: { concurrency: config.execution.concurrency },
      planGraphDigest: graphDigest(graph),
    };
    const proposal = {
      ...discovery,
      actor: "operator",
      expectedGraphDigest: graphDigest(graph),
      graph: qaGraph(graph),
    };
    assert.throws(
      () =>
        submitAmendment(state, { ...proposal, expectedGraphDigest: "stale" }),
      /compare-and-set/,
    );
    submitAmendment(state, proposal);
    validateAmendment(state, proposal.graph, config, body);
    for (const mutate of [
      (g) => g.items[0].dependencies.push("qa"),
      (g) => g.items.splice(0, 1),
      (g) => g.items[0].acceptance.splice(0),
      (g) => g.coverage.splice(0),
      (g) => (g.coverage[0].source.text += " weakened"),
      (g) => (g.coverage[0].criterionId = "changed-source-identity"),
      (g) =>
        g.items[1].validation.push({
          command: "unauthorized command",
          provenance: "source-declared",
          source: "OBJECTIVE",
        }),
    ]) {
      const invalid = structuredClone(proposal.graph);
      mutate(invalid);
      assert.throws(() => validateAmendment(state, invalid, config, body));
    }
    state.work.result = {
      status: "done",
      attempt: "preserved",
      treeSha: "a".repeat(40),
    };
    const changed = structuredClone(proposal.graph);
    changed.items[0].brief += " changed";
    assert.throws(
      () => validateAmendment(state, changed, config, body),
      /immutable/,
    );
    changed.items[0].brief = proposal.graph.items[0].brief;
    changed.items[0].acceptance = ["Equivalent generated wording"];
    assert.throws(
      () => validateAmendment(state, changed, config, body),
      /immutable/,
    );
    validateAmendment(state, proposal.graph, config, body);
  });
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: pending acceptance paraphrase requires independent semantic review before activation`, async () => {
    for (const weakened of [false, true])
      await fixture(
        `pending-prose-${delivery}-${weakened}`,
        async ({ root, config, initial }) => {
          const source =
            "## Acceptance\n- result.txt and peer.txt provide the input results\n- summary.txt joins both results without changing either input\n\n## Commands\n- test -s result.txt\n- test -s summary.txt\n\n## Final validation\n- test -s summary.txt\n";
          const original =
            "summary.txt joins both results without changing either input";
          const replacement = weakened
            ? "summary.txt may contain any text, without joining the inputs"
            : "summary.txt contains the joined result from result.txt and peer.txt while both input files remain unchanged";
          initial.items[0].resources = ["serial-inputs"];
          const peer = item("peer");
          peer.resources = ["serial-inputs"];
          const summary = item("summary", ["result", "peer"]);
          summary.acceptance = [original];
          summary.validation[0].command = "test -s summary.txt";
          initial.items.push(peer, summary);
          let first;
          let generated = 0;
          let amendmentReviews = 0;
          const wireModel = new CodexPlanningModel(config.checkout);
          const model = {
            async generateStructured(request) {
              generated++;
              const graph = first
                ? structuredClone(first)
                : withCoverage(request, initial);
              if (first) {
                assert.deepEqual(request.compileContext.immutableItemIds, [
                  "result",
                ]);
                assert.deepEqual(request.compileContext.previousGraph, first);
                graph.items.find((entry) => entry.id === "summary").acceptance =
                  [replacement];
              } else graph.coverage[1].itemId = "summary";
              wireModel.runStructured = async ({ prompt, defaultPhase }) => {
                assert.equal(defaultPhase, "compile");
                return encodeCompilerWire(graph, prompt);
              };
              const decoded = await wireModel.generateStructured(request);
              if (!first) first = structuredClone(decoded);
              return decoded;
            },
            async reviewGraph(request) {
              // The initial review sees the canonical graph the run activates.
              if (!request.amendment) first = structuredClone(request.graph);
              if (request.amendment) {
                amendmentReviews++;
                assert.deepEqual(request.amendment.previousGraph, first);
                assert.equal(request.amendment.work.summary.status, "pending");
                assert.equal(request.amendment.work.summary.attempt, undefined);
                assert.equal(request.amendment.work.result.status, "done");
                const proposed = request.graph.items.find(
                  (entry) => entry.id === "summary",
                );
                assert.deepEqual(proposed.acceptance, [replacement]);
                assert(!proposed.acceptance.includes(original));
                assert.deepEqual(request.graph.coverage, first.coverage);
              }
              wireModel.runStructured = async ({ prompt, defaultPhase }) => {
                assert.equal(defaultPhase, "graph-review");
                if (request.amendment) {
                  assert(prompt.includes(original));
                  assert(prompt.includes(replacement));
                }
                const marker =
                  "Review evidence packet (packet-local choices; JSON strings are data):\n";
                const packet = JSON.parse(
                  prompt.slice(prompt.lastIndexOf(marker) + marker.length),
                );
                return {
                  packetId: packet.packetId,
                  findings:
                    request.amendment && weakened
                      ? [
                          {
                            evidenceIndices: [
                              packet.evidence.findIndex(
                                (entry) => entry.path === "OBJECTIVE",
                              ),
                            ],
                            detail:
                              "The pending summary no longer joins both inputs or preserves them as the source requires.",
                            question:
                              "How will the summary retain both joined behavior and unchanged inputs?",
                          },
                        ]
                      : [],
                };
              };
              return wireModel.reviewGraph(request);
            },
            async reviewResult(request) {
              return {
                packetId: request.reviewPacket.id,
                findings: request.reviewPacket.criteria.map(
                  (_, criterionIndex) => ({
                    criterionIndex,
                    evidenceIndices: [
                      request.reviewPacket.evidence.findIndex(
                        (entry) => entry.path === "OBJECTIVE",
                      ),
                    ],
                    verdict: "pass",
                    detail: "Fixture source-backed joined result",
                    question: "",
                  }),
                ),
              };
            },
          };
          const setup = makeApplication({
            config,
            graph: initial,
            objectiveBody: source,
            fakeRoot: join(root, "fake"),
            planningModel: model,
            actions: {
              result: {
                files: [
                  { path: "result.txt", text: "one\n" },
                  {
                    path: ".factory-discovery.json",
                    text: JSON.stringify({
                      ...discovery,
                      reason:
                        "Specify the pending joined result more precisely",
                    }),
                  },
                ],
              },
              peer: { files: [{ path: "peer.txt", text: "two\n" }] },
              summary: {
                files: [{ path: "summary.txt", text: "one two\n" }],
              },
            },
          });
          const projected = [];
          const project = setup.github.projectGraph.bind(setup.github);
          setup.github.projectGraph = async (request) => {
            projected.push(request.graph);
            return project(request);
          };
          if (weakened)
            await assert.rejects(
              setup.application.runObjective(1),
              /Independent amendment review rejected/,
            );
          else await setup.application.runObjective(1);
          const state = readState(config.repository, 1);
          assert.equal(generated, 2);
          assert.equal(amendmentReviews, 1);
          assert.equal(consumption(state).planningRevisions, 1);
          if (weakened) {
            assert.deepEqual(state.graph, first);
            assert.equal(state.graphRevisions.length, 1);
            assert.equal(
              state.pendingAmendment.rejectionStage,
              "review-findings",
            );
            assert.equal(projected.length, 1);
            assert.deepEqual(
              readEvents(setup.eventsPath)
                .filter((entry) => entry.type === "start")
                .map((entry) => entry.item),
              ["result"],
            );
          } else {
            assert.equal(state.finalValidation.passed, true);
            assert.equal(state.graphRevisions.length, 2);
            assert.equal(projected.length, 2);
            assert.deepEqual(state.graph.items[0], first.items[0]);
            assert.deepEqual(state.graph.coverage, first.coverage);
            assert.deepEqual(
              state.graph.items.find((entry) => entry.id === "summary")
                .acceptance,
              [replacement],
            );
          }
        },
        delivery,
      );
  });

test("aggregate hierarchy is explicit, children run independently, parent joins without a worker", () => {
  const parent = {
    ...item("parent", ["one", "two"]),
    kind: "aggregate",
    ownedPaths: [],
    children: ["one", "two"],
  };
  const graph = {
    objective: 1,
    baseSha: "a".repeat(40),
    items: [parent, item("one"), item("two")],
    coverage: [
      {
        ...coverageObligations(body, objectiveCriteria(body))[0],
        itemId: "parent",
        proof: { kind: "final-review" },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      },
    ],
  };
  assert.equal(
    validateAndOrderGraph(graph, 1, graph.baseSha, new Set(["OBJECTIVE"])).at(
      -1,
    ).id,
    "parent",
  );
  const work = Object.fromEntries(
    graph.items.map((entry) => [entry.id, { status: "pending" }]),
  );
  assert.deepEqual(
    readyItems(graph, work, new Set(), 2).map((entry) => entry.id),
    ["one", "two"],
  );
  work.one.status = work.two.status = "done";
  assert.deepEqual(
    readyItems(graph, work, new Set(), 2).map((entry) => entry.id),
    ["parent"],
  );
  parent.dependencies.pop();
  assert.throws(
    () =>
      validateAndOrderGraph(graph, 1, graph.baseSha, new Set(["OBJECTIVE"])),
    /explicit dependencies/,
  );
});

test("operator amendment source inputs are hydrated from pinned citations before review", async () => {
  await fixture("operator-inputs", async ({ config, initial }) => {
    const obligations = coverageObligations(body, objectiveCriteria(body));
    const graph = withCoverage({ coverageObligations: obligations }, initial);
    graph.coverage[0].source = obligations[0].source;
    const state = {
      graph,
      objective: 1,
      baseSha: initial.baseSha,
      runId: "fixture",
      issueByItemId: { result: 2 },
      work: { result: { status: "done", attempt: "preserved" } },
      autonomy,
      capacity: { concurrency: config.execution.concurrency },
      planGraphDigest: graphDigest(graph),
      coordinator: { mode: "running" },
    };
    const candidate = qaGraph(graph);
    delete candidate.items[0].inputSources;
    candidate.items[1].inputSources = [
      { path: "OBJECTIVE", content: "forged" },
    ];
    const originalProposal = JSON.stringify(candidate);
    submitAmendment(state, {
      ...discovery,
      actor: "operator",
      expectedGraphDigest: graphDigest(graph),
      graph: candidate,
    });
    let reviews = 0;
    assert.equal(
      await applyPendingAmendment({
        state,
        config,
        body,
        model: {
          async generateStructured() {
            throw new Error("Unexpected compilation");
          },
          async reviewGraph(request) {
            reviews++;
            for (const workItem of request.graph.items)
              assert.deepEqual(
                workItem.inputSources,
                graph.items[0].inputSources,
              );
            return { packetId: request.reviewPacket.id, findings: [] };
          },
        },
        github: {
          async projectGraph() {
            return { issueByItemId: { result: 2, qa: 3 } };
          },
        },
        save() {},
        cancelled: () => false,
        clock,
      }),
      true,
    );
    assert.equal(reviews, 1);
    assert.equal(JSON.stringify(candidate), originalProposal);
    assert.deepEqual(state.graph.items[0], graph.items[0]);
    assert.equal(state.work.result.attempt, "preserved");
    assert.equal(consumption(state).planningRevisions, 1);
  });
});

// GitHub stand-in that finds existing issues by their Factory marker, as
// projectGraph does. The first `losses` calls lose their response: right after
// creating an issue, or at the end of a call that created nothing.
function markerGitHub(lostError, losses) {
  const issues = new Map([["result", 2]]);
  const github = {
    knownIssues: [],
    creates: 0,
    async projectGraph(request) {
      github.knownIssues.push(structuredClone(request.knownIssues));
      const lose = github.knownIssues.length <= losses;
      const issueByItemId = { ...request.knownIssues };
      for (const { id } of request.graph.items) {
        if (!issues.has(id)) {
          await request.beforeCreate(id);
          issues.set(id, 2 + ++github.creates);
          if (lose) throw lostError;
        }
        issueByItemId[id] = issues.get(id);
        request.projected(id, issueByItemId[id]);
      }
      if (lose) throw lostError;
      return { issueByItemId };
    },
  };
  return github;
}

function assertAmendmentCompleted(state) {
  assert.equal(state.pendingAmendment, undefined);
  assert.deepEqual(state.issueByItemId, { result: 2, qa: 3 });
  assert.deepEqual(
    state.graph.items.map((entry) => entry.id),
    ["result", "qa"],
  );
  assert.equal(state.work.qa.status, "pending");
  assert.equal(state.graphRevisions.length, 2);
  assert.equal(consumption(state).planningRevisions, 1);
}

async function assertProjectionRepeats(name, lostError) {
  // Projection is a free effect: lost responses repeat until it completes.
  for (const losses of [1, 3])
    await fixture(`${name}-${losses}`, async ({ config, initial }) => {
      const obligations = coverageObligations(body, objectiveCriteria(body));
      const graph = withCoverage({ coverageObligations: obligations }, initial);
      graph.coverage[0].source = obligations[0].source;
      const state = {
        graph,
        objective: 1,
        baseSha: initial.baseSha,
        runId: "fixture",
        issueByItemId: { result: 2 },
        work: { result: { status: "done", attempt: "preserved" } },
        autonomy,
        capacity: { concurrency: config.execution.concurrency },
        planGraphDigest: graphDigest(graph),
        coordinator: { mode: "running" },
      };
      submitAmendment(state, {
        ...discovery,
        actor: "operator",
        expectedGraphDigest: graphDigest(graph),
        graph: qaGraph(graph),
      });
      let reviews = 0;
      const github = markerGitHub(lostError, losses);
      const args = {
        state,
        config,
        body,
        model: {
          async reviewGraph(request) {
            reviews++;
            return {
              packetId: request.reviewPacket.id,
              findings: [],
            };
          },
        },
        github,
        save() {},
        cancelled: () => false,
        clock,
      };
      assert.equal(await applyPendingAmendment(args), true);
      // Each repeat projects again from the reviewed phase and finds the
      // issue the lost call created by its marker instead of a duplicate.
      assert.equal(github.knownIssues.length, losses + 1);
      assert.equal(github.creates, 1);
      assert.equal(reviews, 1);
      assert.equal(state.repeats, undefined);
      assert.equal(state.coordinator.mode, "running");
      assert.equal(state.work.result.attempt, "preserved");
      assertAmendmentCompleted(state);
    });
}

test("partial/unknown projection repeats without duplicate issues", async () => {
  await assertProjectionRepeats("projection", lost("response lost"));
});

test("interrupted amendment compile is repeated and charged once", async () => {
  // Lost compiles repeat within the paid bound; a fourth asks the operator.
  for (const losses of [1, 3, 4])
    await fixture(
      `compile-interrupted-${losses}`,
      async ({ config, initial }) => {
        const obligations = coverageObligations(body, objectiveCriteria(body));
        const graph = withCoverage(
          { coverageObligations: obligations },
          initial,
        );
        graph.coverage[0].source = obligations[0].source;
        const state = {
          graph,
          objective: 1,
          baseSha: initial.baseSha,
          runId: "fixture",
          issueByItemId: { result: 2 },
          work: { result: { status: "done", attempt: "preserved" } },
          autonomy: resolveAutonomy({
            ...autonomyConfig,
            allowances: { ...autonomyConfig.allowances, planningRevisions: 2 },
          }),
          capacity: { concurrency: config.execution.concurrency },
          planGraphDigest: graphDigest(graph),
          coordinator: { mode: "running" },
        };
        submitAmendment(state, {
          ...discovery,
          actor: "operator",
          expectedGraphDigest: graphDigest(graph),
        });
        let compiles = 0;
        let reviews = 0;
        let projections = 0;
        const saved = [];
        const args = {
          state,
          config,
          body,
          model: {
            async generateStructured(request) {
              compiles++;
              if (compiles <= losses) throw lost("compile response lost");
              const wire = compilerWire(
                request,
                compilerCitationChoices(request.sources),
              );
              return wire.decode(encodeCompilerWire(qaGraph(graph), wire.data));
            },
            async reviewGraph(request) {
              reviews++;
              return { packetId: request.reviewPacket.id, findings: [] };
            },
          },
          github: {
            async projectGraph(request) {
              projections++;
              return { issueByItemId: { ...request.knownIssues, qa: 3 } };
            },
          },
          save() {
            if (state.pendingAmendment)
              saved.push(structuredClone(state.pendingAmendment));
          },
          cancelled: () => false,
          clock,
        };
        if (losses <= 3) {
          assert.equal(await applyPendingAmendment(args), true);
          const repeated = saved.find((entry) => entry.phase === "ready");
          assert.ok(state.charges[`objective/amend/${repeated.id}`]);
          assert.equal(consumption(state).planningRevisions, 1);
        } else {
          await assert.rejects(applyPendingAmendment(args), /unknown outcome/);
          // Not rejected: the amendment waits at its last completed phase.
          assert.equal(state.pendingAmendment.phase, "ready");
          assert.ok(
            state.charges[`objective/amend/${state.pendingAmendment.id}`],
          );
          assert.equal(state.pendingAmendment.rejectionStage, undefined);
          assert.equal(state.wait.kind, "decision");
          assert.equal(compiles, 4);
          assert.equal(consumption(state).planningRevisions, 1);
          // The operator's retry clears the step's records; the repeat is
          // not charged again.
          assert.equal(clearRepeats(state, "objective"), true);
          assert.equal(await applyPendingAmendment(args), true);
        }
        assert.equal(compiles, losses + 1);
        assert.equal(reviews, 1);
        assert.equal(projections, 1);
        // Every repeat ran under the amendment's one charge.
        assert.equal(consumption(state).planningRevisions, 1);
        assert.equal(state.work.result.attempt, "preserved");
        assertAmendmentCompleted(state);
      },
    );
});

test("compound: amendment invalidates final review before lost closure acknowledgement is reconciled", async () => {
  await fixture("final-race", async ({ config, initial, root }) => {
    let finals = 0;
    let setup;
    const planningModel = {
      async generateStructured(request) {
        return withCoverage(request, initial);
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
      async reviewResult(request) {
        if (request.invocation.phase === "objective-review") {
          finals++;
          if (finals === 1) {
            const { graph } = readState(config.repository, 1);
            await setup.application.proposeAmendment(1, {
              ...discovery,
              actor: "operator",
              expectedGraphDigest: graphDigest(graph),
              graph: qaGraph(graph),
            });
          }
        }
        return {
          packetId: request.reviewPacket.id,
          findings: request.reviewPacket.criteria.map(
            (criterion, criterionIndex) => ({
              criterionIndex,
              evidenceIndices: [
                request.reviewPacket.evidence.findIndex(
                  (entry) => entry.path === "OBJECTIVE",
                ),
              ],
              verdict: "pass",
              detail: "Fixture acceptance",
              question: "",
            }),
          ),
        };
      },
    };
    setup = makeApplication({
      config,
      graph: initial,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      planningModel,
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
    });
    const close = setup.github.closeIssue.bind(setup.github);
    let closures = 0;
    let sealed;
    setup.github.closeIssue = async (...parameters) => {
      await close(...parameters);
      if (parameters[0] === 1 && ++closures === 1) {
        sealed = readState(config.repository, 1).finalAcceptance;
        throw new Error("Acknowledgement lost after amended Objective closure");
      }
    };
    await assert.rejects(
      setup.application.runObjective(1),
      /Acknowledgement lost after amended Objective closure/,
    );
    const pending = readState(config.repository, 1);
    assert.equal(pending.objectiveClosure, "pending");
    assert.equal(pending.graphRevisions.length, 2);
    assert.equal(pending.work.qa.status, "done");
    assert.equal(finals, 2);
    const charges = structuredClone(pending.charges);
    assert.equal(sealed.graphDigest, graphDigest(pending.graph));
    assert.notEqual(sealed.graphDigest, pending.graphRevisions[0].digest);
    assert.equal(sealed.usage.availability, "unavailable");
    const state = await setup.application.runObjective(1);
    assert.equal(closures, 2);
    assert.equal(state.objectiveClosure, "complete");
    assert.deepEqual(state.finalAcceptance, sealed);
    assert.deepEqual(state.charges, charges);
    assert.deepEqual(state.work, pending.work);
    assert.equal(finals, 2);
    assert.equal(state.finalValidation.passed, true);
    assert.equal(state.work.qa.status, "done");
    assert.equal(state.graphRevisions.length, 2);
    assert.equal(
      readEvents(setup.eventsPath).filter((event) => event.type === "start")
        .length,
      1,
    );
  });
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: aggregate parent retains completed coding and read-only QA proofs without a worker or PR`, async () => {
    await fixture(
      `aggregate-${delivery}`,
      async ({ config, initial, root }) => {
        const one = item("one");
        one.dependencies = ["result"];
        const two = item("two");
        two.dependencies = ["result"];
        const qa = {
          ...item("qa", ["one", "two"]),
          kind: "qa",
          ownedPaths: [],
        };
        const parent = {
          ...item("parent", ["one", "two", "qa"]),
          kind: "aggregate",
          acceptance: aggregateAcceptance({ id: "parent" }),
          ownedPaths: [],
          children: ["one", "two", "qa"],
        };
        initial.items.push(one, two, qa, parent);
        initial.coverage = coverageObligations(
          body,
          objectiveCriteria(body),
        ).map((entry) => ({
          ...entry,
          itemId: "qa",
          proof: { kind: "integrated-command", validationIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        }));
        const setup = makeApplication({
          config,
          graph: initial,
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          actions: {
            result: { files: [{ path: "result.txt", text: "done\n" }] },
            one: { files: [{ path: "one.txt", text: "one\n" }] },
            two: { files: [{ path: "two.txt", text: "two\n" }] },
          },
        });
        const state = await setup.application.runObjective(1);
        assert.equal(state.finalValidation.passed, true);
        assert.equal(state.work.parent.status, "done");
        assert.equal(state.work.parent.pullRequest, undefined);
        assert.equal(state.work.parent.execution, undefined);
        assert.equal(state.work.qa.status, "done");
        const sources = workItemReviewEvidence({
          state,
          item: parent,
          checkout: config.checkout,
          delivery,
        });
        const proof = JSON.parse(
          sources.find(
            (source) => source.path === "Completed dependency results",
          ).content,
        );
        assert.deepEqual(
          proof.work.map((record) => record.id),
          ["result", "one", "two", "qa"],
        );
        const qaProof = proof.work.at(-1);
        assert.equal(qaProof.kind, "qa");
        assert.equal(qaProof.resultCommitSha, state.integratedSha);
        assert.equal(
          qaProof.validationCommands[0].command,
          "test -s result.txt",
        );
        assert.equal(
          qaProof.validationCommands[0].treeSha,
          state.work.qa.treeSha,
        );
        assert.ok(
          sources.some((source) => source.path === "Read-only QA proof: qa"),
        );
        assert.ok(
          sources.some(
            (source) => source.path === "Delivery lifecycle proof: two",
          ),
        );
        // A structural dependency stays in the packet without becoming a merge layer.
        const structural = {
          ...parent,
          id: "later",
          dependencies: ["parent"],
          children: ["parent"],
        };
        const nested = structuredClone(state);
        nested.graph.items.push(structural);
        nested.work.later = { ...nested.work.parent };
        const nestedProof = workItemReviewEvidence({
          state: nested,
          item: structural,
          checkout: config.checkout,
          delivery,
        });
        assert.ok(
          nestedProof.some(
            (source) => source.path === "Read-only QA proof: parent",
          ),
        );
        for (const mutate of [
          (candidate) => {
            candidate.work.qa.validation.commands[0].treeSha =
              candidate.baseSha;
          },
          (candidate) => {
            candidate.work.qa.pullRequest = 999;
          },
          (candidate) => {
            candidate.work.two.integratedSha = candidate.work.two.changeRef;
          },
        ]) {
          const candidate = structuredClone(state);
          mutate(candidate);
          assert.throws(
            () =>
              workItemReviewEvidence({
                state: candidate,
                item: parent,
                checkout: config.checkout,
                delivery,
              }),
            /exact result tree|worker or delivery identity|exact delivered result head|first result base/,
          );
        }

        assert.deepEqual(
          readEvents(setup.eventsPath)
            .filter((event) => event.type === "start")
            .map((event) => event.item)
            .sort(),
          ["one", "result", "two"],
        );
      },
      delivery,
    );
  });

test("out-of-scope discovery is retained as backlog without consuming authority or blocking accepted completion", async () => {
  await fixture("backlog", async ({ config, initial, root }) => {
    const setup = makeApplication({
      config,
      graph: initial,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        result: {
          files: [
            { path: "result.txt", text: "done\n" },
            {
              path: ".factory-discovery.json",
              text: JSON.stringify({ ...discovery, scope: "backlog" }),
            },
          ],
        },
      },
    });
    const state = await setup.application.runObjective(1);
    assert.equal(state.work.result.discovery.scope, "backlog");
    assert.equal(state.charges, undefined);
    assert.equal(state.graph.items.length, 1);
    assert.equal(state.finalValidation.passed, true);
  });
});

test("native amendments cannot repartition a started published stack", async () => {
  await fixture(
    "native-pin",
    async ({ config, initial }) => {
      initial.items.push(item("second", ["result"]));
      const obligations = coverageObligations(body, objectiveCriteria(body));
      const graph = withCoverage({ coverageObligations: obligations }, initial);
      graph.coverage[0].source = obligations[0].source;
      const state = {
        graph,
        objective: 1,
        baseSha: initial.baseSha,
        issueByItemId: { result: 2, second: 3 },
        work: {
          result: { status: "published", attempt: "original", pullRequest: 4 },
          second: { status: "pending" },
        },
        autonomy,
        capacity: { concurrency: config.execution.concurrency },
        planGraphDigest: graphDigest(graph),
      };
      const candidate = structuredClone(graph);
      candidate.items.push(item("fork", ["result"]));
      submitAmendment(state, {
        ...discovery,
        actor: "operator",
        expectedGraphDigest: graphDigest(graph),
        graph: candidate,
      });
      assert.throws(
        () => validateAmendment(state, candidate, config, body),
        /repartitions/,
      );
      const original = JSON.stringify(state.work);
      assert.equal(
        await applyPendingAmendment({
          state,
          config,
          body,
          model: {},
          save() {},
          cancelled: () => false,
          clock,
        }),
        false,
      );
      assert.equal(JSON.stringify(state.work), original);
    },
    "native-stack",
  );
});

test("planning consumption survives acceptance and cannot reset for a second revision", async () => {
  await fixture("allowance", async ({ config, initial }) => {
    const obligations = coverageObligations(body, objectiveCriteria(body));
    const graph = withCoverage({ coverageObligations: obligations }, initial);
    graph.coverage[0].source = obligations[0].source;
    const state = {
      graph,
      objective: 1,
      baseSha: initial.baseSha,
      runId: "fixture",
      issueByItemId: { result: 2 },
      work: { result: { status: "done", attempt: "original" } },
      autonomy,
      capacity: { concurrency: config.execution.concurrency },
      planGraphDigest: graphDigest(graph),
    };
    const args = {
      state,
      config,
      body,
      model: {
        async reviewGraph(request) {
          return {
            packetId: request.reviewPacket.id,
            findings: [],
          };
        },
      },
      github: {
        async projectGraph() {
          return { issueByItemId: { result: 2, qa: 3 } };
        },
      },
      save() {},
      cancelled: () => false,
      clock,
    };
    submitAmendment(state, {
      ...discovery,
      actor: "operator",
      expectedGraphDigest: graphDigest(graph),
      graph: qaGraph(graph),
    });
    await applyPendingAmendment(args);
    assertGraphRevisions(state);
    const restarted = structuredClone(state);
    delete restarted.charges;
    assert.throws(
      () => assertGraphRevisions(restarted),
      /exceed retained planning charges/,
    );
    submitAmendment(state, {
      ...discovery,
      actor: "operator",
      expectedGraphDigest: graphDigest(state.graph),
      graph: state.graph,
    });
    await assert.rejects(applyPendingAmendment(args), /allowance exhausted/);
    assert.equal(consumption(state).planningRevisions, 1);
  });
});

test("real gateway reconciles reviewed issue bodies, native hierarchy and dependency edges; rejects outside edits", async () => {
  const { RealGitHubGateway, projectedIssueBody } = await import(
    "../dist/github.js"
  );
  const original = {
    objective: 1,
    baseSha: "a".repeat(40),
    items: [item("parent")],
  };
  const parent = {
    ...item("parent", ["one", "two"]),
    kind: "aggregate",
    ownedPaths: [],
    children: ["one", "two"],
  };
  const graph = { ...original, items: [parent, item("one"), item("two")] };
  let next = 3;
  const issues = new Map([
    [
      1,
      {
        id: 101,
        number: 1,
        title: "Objective",
        body: "Public objective",
        state: "open",
        labels: ["factory:objective"],
        repository_url: "https://api.github.com/repos/example/projection",
      },
    ],
    [
      2,
      {
        id: 102,
        number: 2,
        labels: ["factory:work-item"],
        repository_url: "https://api.github.com/repos/example/projection",
        state: "open",
        title: original.items[0].title,
        body: projectedIssueBody(original.items[0], 1),
      },
    ],
  ]);
  const deps = new Map();
  const hierarchy = new Map();
  const calls = [];
  const client = {
    async viewer() {
      return "factory-bot";
    },
    async paginate(route) {
      if (route.endsWith("/labels"))
        return ["factory:objective", "factory:work-item"].map((name) => ({
          name,
          archived_at: null,
        }));
      const n = Number(route.match(/issues\/(\d+)/)?.[1]);
      if (route.includes("blocked_by"))
        return (deps.get(n) ?? []).map((id) => issues.get(id));
      if (route.includes("sub_issues"))
        return (hierarchy.get(n) ?? []).map((id) => issues.get(id));
      return [...issues.values()];
    },
    async request(method, route, value) {
      calls.push({ method, route, value });
      const n = Number(route.match(/issues\/(\d+)/)?.[1]);
      if (method === "GET" && /\/issues\?/.test(route))
        return [...issues.values()].sort((a, b) => b.number - a.number);
      if (method === "GET") {
        if (route.endsWith("/parent")) {
          const parent = [...hierarchy].find(([, children]) =>
            children.includes(n),
          )?.[0];
          if (parent === undefined) {
            const { GitHubRequestError } = await import(
              "../dist/github-client.js"
            );
            throw new GitHubRequestError(404);
          }
          return structuredClone(issues.get(parent));
        }
        return structuredClone(issues.get(n));
      }
      if (method === "PATCH") {
        Object.assign(issues.get(n), value);
        return structuredClone(issues.get(n));
      }
      if (route.endsWith("blocked_by")) {
        const issue = [...issues.values()].find(
          (issue) => issue.id === value.issue_id,
        );
        deps.set(n, [...(deps.get(n) ?? []), issue.number]);
        return {};
      }
      if (route.endsWith("sub_issues")) {
        assert.equal(value.replace_parent, false);
        const issue = [...issues.values()].find(
          (issue) => issue.id === value.sub_issue_id,
        );
        hierarchy.set(n, [...(hierarchy.get(n) ?? []), issue.number]);
        return {};
      }
      if (method === "POST" && route.endsWith("issues")) {
        const number = next++;
        const issue = {
          id: 100 + number,
          number,
          state: "open",
          repository_url: "https://api.github.com/repos/example/projection",
          user: { login: "factory-bot" },
          ...value,
        };
        issues.set(number, issue);
        return structuredClone(issue);
      }
      throw new Error(`Unexpected ${method} ${route}`);
    },
  };
  const gateway = new RealGitHubGateway("example/projection", {}, client);
  const intents = [];
  const result = await gateway.projectGraph({
    graph,
    previousGraph: original,
    objectiveIssue: 1,
    knownIssues: { parent: 2 },
    beforeCreate(id) {
      intents.push(id);
    },
  });
  assert.deepEqual(intents, ["one", "two"]);
  assert.deepEqual(deps.get(2), [3, 4]);
  assert.deepEqual(hierarchy.get(2), [3, 4]);
  assert.deepEqual(hierarchy.get(1), [2]);
  assert.equal(issues.get(2).body, projectedIssueBody(parent, 1));
  const before = calls.filter(
    (call) => call.method === "POST" && call.route.endsWith("issues"),
  ).length;
  issues.get(2).body += "\nUnreviewed edit";
  await assert.rejects(
    gateway.projectGraph({
      graph,
      previousGraph: graph,
      objectiveIssue: 1,
      knownIssues: result.issueByItemId,
    }),
    /edits are proposals/,
  );
  assert.equal(
    calls.filter(
      (call) => call.method === "POST" && call.route.endsWith("issues"),
    ).length,
    before,
  );
  issues.get(2).body = projectedIssueBody(parent, 1);
  issues.get(2).state = "closed";
  await assert.rejects(
    gateway.projectGraph({
      graph,
      previousGraph: graph,
      objectiveIssue: 1,
      knownIssues: result.issueByItemId,
    }),
    /closure/,
  );
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: discovery decomposes an unstarted node into executable children and parent acceptance`, async () => {
    await fixture(
      `decompose-${delivery}`,
      async ({ config, initial, root }) => {
        initial.items[0].resources = ["serial-initial"];
        const parent = item("parent");
        parent.resources = ["serial-initial"];
        initial.items.push(parent);
        let first;
        let generated = 0;
        const model = {
          async generateStructured(request) {
            generated++;
            if (!first) {
              first = withCoverage(request, initial);
              return first;
            }
            const next = structuredClone(first);
            Object.assign(next.items[1], {
              kind: "aggregate",
              ownedPaths: [],
              children: ["one", "two"],
              dependencies: ["one", "two"],
            });
            next.items.push(item("one", ["result"]), item("two", ["result"]));
            return next;
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
                  evidenceIndices: [
                    request.reviewPacket.evidence.findIndex(
                      (entry) => entry.path === "OBJECTIVE",
                    ),
                  ],
                  verdict: "pass",
                  detail: "Fixture acceptance",
                  question: "",
                }),
              ),
            };
          },
        };
        const setup = makeApplication({
          config,
          graph: initial,
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          planningModel: model,
          actions: {
            result: {
              files: [
                { path: "result.txt", text: "done\n" },
                {
                  path: ".factory-discovery.json",
                  text: JSON.stringify(discovery),
                },
              ],
            },
            one: { files: [{ path: "one.txt", text: "one\n" }] },
            two: { files: [{ path: "two.txt", text: "two\n" }] },
          },
        });
        const state = await setup.application.runObjective(1);
        assert.equal(generated, 2);
        assert.equal(state.finalValidation.passed, true);
        assert.equal(state.work.parent.status, "done");
        assert.equal(state.work.parent.execution, undefined);
        assert.equal(state.work.parent.pullRequest, undefined);
        assert.deepEqual(
          readEvents(setup.eventsPath)
            .filter((event) => event.type === "start")
            .map((event) => event.item)
            .sort(),
          ["one", "result", "two"],
        );
        assert.equal(state.graphRevisions.length, 2);
        assert.equal(consumption(state).planningRevisions, 1);
      },
      delivery,
    );
  });

for (const mode of ["paused", "draining"])
  for (const boundary of ["compiled", "reviewed", "projected"])
    test(`${mode} during amendment ${boundary} preserves known work across continuation`, async () => {
      await fixture(`${mode}-${boundary}`, async ({ config, initial }) => {
        const obligations = coverageObligations(body, objectiveCriteria(body));
        const graph = withCoverage(
          { coverageObligations: obligations },
          initial,
        );
        graph.coverage[0].source = obligations[0].source;
        let state = {
          graph,
          objective: 1,
          baseSha: initial.baseSha,
          runId: "fixture",
          issueByItemId: { result: 2 },
          work: {
            result: {
              status: "done",
              attempt: "preserved",
              graphRevisionDigest: graphDigest(graph),
            },
          },
          autonomy,
          capacity: { concurrency: config.execution.concurrency },
          planGraphDigest: graphDigest(graph),
          coordinator: { mode: "running" },
        };
        const admittedBytes = JSON.stringify(graph);
        submitAmendment(state, {
          ...discovery,
          actor: "worker:result",
          expectedGraphDigest: graphDigest(graph),
        });
        const calls = { compile: 0, review: 0, project: 0 };
        let saved;
        const stop = (at) => {
          if (boundary === at) state.coordinator.mode = mode;
        };
        const args = {
          config,
          body,
          cancelled: () => false,
          clock,
          save: () => {
            saved = JSON.stringify(state);
          },
          model: {
            async generateStructured() {
              calls.compile++;
              stop("compiled");
              const candidate = qaGraph(graph);
              candidate.items = candidate.items.map((entry) =>
                Object.fromEntries(
                  Object.entries({
                    ...entry,
                    kind: entry.kind ?? "work",
                    children: [],
                  }).reverse(),
                ),
              );
              return candidate;
            },
            async reviewGraph(request) {
              calls.review++;
              stop("reviewed");
              return {
                packetId: request.reviewPacket.id,
                findings: [],
              };
            },
          },
          github: {
            async projectGraph() {
              calls.project++;
              stop("projected");
              return { issueByItemId: { result: 2, qa: 3 } };
            },
          },
        };
        assert.equal(await applyPendingAmendment({ ...args, state }), false);
        assert.equal(state.pendingAmendment.phase, boundary);
        assert.equal(JSON.stringify(state.graph), admittedBytes);
        assert.equal(consumption(state).planningRevisions, 1);
        const expected = {
          compile: 1,
          review: boundary === "compiled" ? 0 : 1,
          project: boundary === "projected" ? 1 : 0,
        };
        assert.deepEqual(calls, expected);
        // Rehydration preserves the safe point; a stopped coordinator submits nothing.
        state = JSON.parse(saved);
        assertGraphRevisions(state);
        assert.equal(await applyPendingAmendment({ ...args, state }), false);
        assert.deepEqual(calls, expected);
        state.coordinator.mode = "running";
        assert.equal(await applyPendingAmendment({ ...args, state }), true);
        assert.deepEqual(calls, { compile: 1, review: 1, project: 1 });
        assert.equal(consumption(state).planningRevisions, 1);
        assert.equal(state.graphRevisions.length, 2);
        assert.equal(
          JSON.stringify(state.graphRevisions[0].graph),
          admittedBytes,
        );
        assert.equal(state.work.result.attempt, "preserved");
        assert.deepEqual(state.issueByItemId, { result: 2, qa: 3 });
        assertGraphRevisions(state);
        state.graph.items[0].brief += " changed obligation";
        assert.throws(
          () => assertGraphRevisions(state),
          /identity changed|differs|binding changed/,
        );
      });
    });

test("owner handoff after known amendment review resumes without repeating model work", async () => {
  await fixture("amendment-handoff", async ({ root, config, initial }) => {
    let first;
    let generated = 0;
    let reviewed = 0;
    const planningModel = {
      async generateStructured(request) {
        generated++;
        if (!first) return (first = withCoverage(request, initial));
        return qaGraph(first);
      },
      async reviewGraph(request) {
        reviewed++;
        if (request.amendment)
          await requestControl(config.repository, {
            objective: 1,
            action: "handoff",
          });
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
              evidenceIndices: [
                request.reviewPacket.evidence.findIndex(
                  (entry) => entry.path === "OBJECTIVE",
                ),
              ],
              verdict: "pass",
              detail: "Fixture source-backed acceptance",
              question: "",
            }),
          ),
        };
      },
    };
    const setup = makeApplication({
      config,
      graph: initial,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      planningModel,
      actions: {
        result: {
          files: [
            { path: "result.txt", text: "done\n" },
            {
              path: ".factory-discovery.json",
              text: JSON.stringify(discovery),
            },
          ],
        },
      },
    });
    await assert.rejects(
      setup.application.runObjective(1),
      (error) => error.constructor.name === "CoordinatorHandoff",
    );
    const stopped = readState(config.repository, 1);
    assert.equal(stopped.pendingAmendment.phase, "reviewed");
    assert.equal(stopped.coordinator.mode, "draining");
    assert.equal(stopped.graph.items.length, 1);
    assert.equal(stopped.cancelRequested, undefined);
    assert.equal(generated, 2);
    assert.equal(reviewed, 2);
    assert.doesNotThrow(() => checkServiceState(config, 1));
    await controlObjective(config, { objective: 1, action: "resume" });
    const result = await setup.application.runObjective(1);
    assert.equal(result.finalValidation.passed, true);
    assert.equal(generated, 2);
    assert.equal(reviewed, 2);
    assert.equal(consumption(result).planningRevisions, 1);
    assert.equal(
      readEvents(setup.eventsPath).filter((event) => event.type === "start")
        .length,
      1,
    );
  });
});

for (const { transport, rejection } of ["stopped CLI", "live owner"].flatMap(
  (transport) =>
    ["compilation", "review", "review-unresolved"].map((rejection) => ({
      transport,
      rejection,
    })),
))
  test(`${transport}: diagnosed ${rejection} amendment replacement retains accepted work and charges one remaining revision`, async () => {
    await fixture("rejected-correction", async ({ root, config, initial }) => {
      config.policy.allowedSecretNames = ["FACTORY_TEST_AMENDMENT_SECRET"];
      config.autonomy = structuredClone(replacementAutonomy);
      let first;
      let compilations = 0;
      let graphReviews = 0;
      let fullRejectedResponse;
      const amended = (redundant = false) => {
        const graph = qaGraph(first);
        if (rejection !== "compilation")
          graph.items.push({
            ...item("acceptance", ["result", "qa"]),
            kind: "aggregate",
            children: ["result", "qa"],
            ownedPaths: [],
            acceptance: aggregateAcceptance(["result", "qa"]),
            validation: redundant
              ? structuredClone(first.items[0].validation)
              : [],
          });
        return graph;
      };
      const planningModel = {
        async generateStructured(request) {
          compilations++;
          if (!first) return (first = withCoverage(request, initial));
          if (compilations === 2) {
            const candidate = amended(true);
            if (rejection === "compilation")
              // All source obligations still belong to work; QA is uncovered.
              candidate.coverage = first.coverage;
            return candidate;
          }
          assert.equal(
            JSON.parse(
              request.compileContext.instructions.trim().split("\n").at(-1),
            ).discovery.replacement.correction.kind,
            "planning-output",
          );
          return amended();
        },
        async reviewGraph(request) {
          graphReviews++;
          if (request.amendment) {
            assert.equal(request.amendment.work.result.status, "done");
            assert.deepEqual(request.amendment.previousGraph, first);
            assert.deepEqual(request.finalCommands, ["test -s result.txt"]);
            assert.equal(
              request.localExecutables.finalCommands[0],
              "test -s result.txt",
            );
            if (
              rejection !== "compilation" &&
              (compilations === 2 || rejection === "review-unresolved")
            ) {
              const response = {
                packetId: request.reviewPacket.id,
                findings: [
                  {
                    evidenceIndices: [
                      request.reviewPacket.evidence.findIndex(
                        (entry) => entry.path === "OBJECTIVE",
                      ),
                    ],
                    detail:
                      compilations === 2
                        ? "The aggregate repeats source coverage already retained on work and final validation. Remove the unnecessary aggregate command."
                        : "A source-owned acceptance question remains unresolved; diagnosis does not grant acceptance.",
                    question:
                      compilations === 2
                        ? "Can the corrected structural parent retain its children without the redundant check?"
                        : "What source evidence resolves this acceptance question?",
                  },
                ],
              };
              if (compilations === 2)
                fullRejectedResponse = structuredClone(response);
              return JSON.parse(JSON.stringify(response));
            }
          }
          return { packetId: request.reviewPacket.id, findings: [] };
        },
        async reviewResult(request) {
          return {
            packetId: request.reviewPacket.id,
            findings: request.reviewPacket.criteria.map(
              (_, criterionIndex) => ({
                criterionIndex,
                evidenceIndices: [
                  request.reviewPacket.evidence.findIndex(
                    (entry) => entry.path === "OBJECTIVE",
                  ),
                ],
                verdict: "pass",
                detail: "Fixture source-backed acceptance",
                question: "",
              }),
            ),
          };
        },
      };
      const setup = makeApplication({
        config,
        graph: initial,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        planningModel,
        actions: {
          result: {
            files: [
              { path: "result.txt", text: "done\n" },
              {
                path: ".factory-discovery.json",
                text: JSON.stringify(discovery),
              },
            ],
          },
        },
      });
      await assert.rejects(
        setup.application.runObjective(1),
        rejection === "compilation"
          ? /QA node has no acceptance coverage/
          : /Independent amendment review rejected/,
      );
      const configPath = join(root, "factory.json");
      writeFileSync(configPath, JSON.stringify(config));
      const status = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              resolve(import.meta.dirname, "../dist/cli.js"),
              "status",
              "--objective",
              "1",
              "--json",
              "--config",
              configPath,
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                FACTORY_TEST_AMENDMENT_SECRET: "coverage",
              },
            },
          ),
        );
      const stopped = readState(config.repository, 1);
      const rejectedDocument = status();
      assert.doesNotMatch(JSON.stringify(rejectedDocument), /coverage/);
      const rejectedStatus = rejectedDocument.pendingAmendment;
      assert.equal(rejectedStatus.phase, "rejected");
      assert.match(rejectedStatus.error, /\[REDACTED\]/);
      assert.doesNotMatch(rejectedStatus.error, /coverage/);
      assert.equal(
        rejectedStatus.failureDigest,
        failureDigest(stopped.pendingAmendment.error),
      );
      assert.notEqual(
        rejectedStatus.failureDigest,
        failureDigest(rejectedStatus.error),
      );
      assert.equal(stopped.work.result.status, "done");
      assert.equal(stopped.pendingAmendment.phase, "rejected");
      assert.equal(
        stopped.pendingAmendment.rejectionStage,
        rejection === "compilation" ? "compilation" : "review-findings",
      );
      if (rejection !== "compilation") {
        assert.equal(fullRejectedResponse.findings.length, 1);
        assert.equal(
          stopped.pendingAmendment.graph.items.at(-1).validation.length,
          1,
        );
        assert.equal(stopped.graph.items.length, 1);
      }
      assert.equal(consumption(stopped).planningRevisions, 1);
      const proposal = {
        ...stopped.pendingAmendment.proposal,
        actor: "operator",
        replacement: {
          amendmentId: stopped.pendingAmendment.id,
          correction: {
            failureDigest: rejectedStatus.failureDigest,
            kind: "planning-output",
            diagnosis:
              rejection === "compilation"
                ? "Emitted choice contract allowed uncovered QA"
                : "Generated aggregate repeats an already retained source check",
            correction:
              rejection === "compilation"
                ? "QA choices now require a feasible existing source obligation"
                : "Keep required QA, work and final checks while omitting redundant aggregate validation",
            actor: "operator",
          },
        },
      };
      // Refuse unsupported disposition before changing any authoritative bytes.
      for (const mutate of [
        (s, p) => {
          p.replacement.amendmentId = "stale";
        },
        (s, p) => {
          p.replacement.correction.failureDigest = "0".repeat(64);
        },
        (s, p) => {
          p.replacement.correction.failureDigest = failureDigest(
            rejectedStatus.error,
          );
        },
        (s, p) => {
          p.expectedGraphDigest = "0".repeat(64);
        },
        (s, p) => {
          p.ownership = ["outside.txt"];
        },
        // An interrupted call leaves its last completed phase, never "rejected".
        ...["ready", "compiled", "reviewed", "projected"].map(
          (phase) => (s) => {
            s.pendingAmendment.phase = phase;
          },
        ),
        (s, p) => {
          p.worker.attempt = "stale";
        },
        (s, p) => {
          p.graph = structuredClone(s.graph);
        },
        (s) => {
          s.pendingAmendment.proposal.graph = structuredClone(s.graph);
        },
        (s) => {
          s.work.result.status = "running";
        },
        (s) => {
          s.work.result.status = "published";
        },
        (s) => {
          s.pendingAmendment.rejectionStage = "review";
        },
        (s) => {
          s.pendingAmendment.rejectionStage = "review-findings";
          delete s.pendingAmendment.graph;
        },
        (s) => {
          s.pendingAmendment.rejectionStage = "projection";
        },
        (s) => {
          s.pendingAmendment.reviewDigest = "0".repeat(64);
        },
        (s) => {
          s.pendingAmendment.issueByItemId.qa = 99;
        },
        (s) => {
          s.coordinator.mode = "running";
        },
        (s) => {
          s.coordinator.processes = [{ pid: 1, startTime: "1" }];
        },
        (s) => {
          s.error = "unrelated error";
        },
        (s) => {
          s.cancelRequested = true;
        },
        (s) => {
          s.objectiveClosure = "complete";
        },
        (s) => {
          s.autonomy.repairClasses = [];
        },
        (s) => {
          // Spend the rest of the planning allowance on other events.
          for (const round of [90, 91])
            s.charges[`objective/plan/${round}`] = {
              allowances: ["planningRevisions"],
              scopes: ["$planning"],
            };
        },
      ]) {
        const altered = structuredClone(stopped);
        const input = structuredClone(proposal);
        mutate(altered, input);
        const unchanged = JSON.stringify(altered);
        assert.throws(() => submitAmendment(altered, input));
        assert.equal(JSON.stringify(altered), unchanged);
      }
      let running;
      if (transport === "stopped CLI") {
        const proposalPath = join(root, "proposal.json");
        writeFileSync(proposalPath, JSON.stringify(proposal));
        const result = JSON.parse(
          execFileSync(
            process.execPath,
            [
              resolve(import.meta.dirname, "../dist/cli.js"),
              "propose-amendment",
              "--objective",
              "1",
              "--proposal",
              proposalPath,
              "--config",
              configPath,
            ],
            { encoding: "utf8" },
          ),
        );
        assert.equal(result.phase, "ready");
      } else {
        running = setup.application.runObjective(1);
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            (
              await requestControl(config.repository, {
                objective: 1,
                action: "status",
              })
            ).handled
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await setup.application.proposeAmendment(1, proposal);
      }
      const replaced = readState(config.repository, 1);
      const readyStatus = status().pendingAmendment;
      assert.equal(readyStatus.phase, "ready");
      assert.equal(readyStatus.error, null);
      assert.equal(readyStatus.failureDigest, null);
      assert.doesNotThrow(() => checkServiceState(config, 1));
      for (const mutate of [
        (s) => {
          delete s.charges;
        },
        (s) => {
          for (const event of Object.keys(s.charges))
            if (event.startsWith("objective/amend/")) delete s.charges[event];
        },
      ]) {
        const reset = structuredClone(replaced);
        mutate(reset);
        assert.throws(
          () => parseFactoryState(reset, config.repository, 1),
          /Known amendment attempts exceed retained planning charges/,
        );
      }
      assert.deepEqual(replaced.rejectedAmendments, [stopped.pendingAmendment]);
      assert.deepEqual(replaced.graph, stopped.graph);
      assert.deepEqual(replaced.work, stopped.work);
      assert.deepEqual(replaced.autonomy, stopped.autonomy);
      assert.equal(replaced.runId, stopped.runId);
      assert.equal(replaced.error, undefined);
      assert.equal(replaced.coordinator.mode, "paused");
      assert.equal(consumption(replaced).planningRevisions, 1);
      assert.equal(compilations, 2);
      assert.equal(graphReviews, rejection === "compilation" ? 1 : 2);
      const beforeDuplicate = readFileSync(
        statePath(config.repository, 1),
        "utf8",
      );
      await assert.rejects(
        setup.application.proposeAmendment(1, proposal),
        /known generated amendment rejection/,
      );
      assert.equal(
        readFileSync(statePath(config.repository, 1), "utf8"),
        beforeDuplicate,
      );
      await controlObjective(config, { objective: 1, action: "resume" });
      if (rejection === "review-unresolved") {
        await assert.rejects(
          running ?? setup.application.runObjective(1),
          /Independent amendment review rejected/,
        );
        const refused = readState(config.repository, 1);
        assert.deepEqual(refused.graph, stopped.graph);
        assert.deepEqual(refused.work, stopped.work);
        assert.equal(refused.issueByItemId.qa, undefined);
        assert.equal(
          refused.pendingAmendment.graph.items.at(-1).validation.length,
          0,
        );
        assert.equal(refused.pendingAmendment.phase, "rejected");
        assert.equal(consumption(refused).planningRevisions, 2);
        assert.equal(consumption(refused, "$planning").planningRevisions, 2);
        assert.equal(compilations, 3);
        assert.equal(graphReviews, 3);
        const next = {
          ...proposal,
          replacement: {
            amendmentId: refused.pendingAmendment.id,
            correction: {
              ...proposal.replacement.correction,
              failureDigest: failureDigest(refused.pendingAmendment.error),
              correction:
                "New correction requires unavailable further planning allowance",
            },
          },
        };
        const before = JSON.stringify(refused);
        assert.throws(
          () => submitAmendment(refused, next),
          /allowance exhausted/,
        );
        assert.equal(JSON.stringify(refused), before);
        assertGraphRevisions(refused);
        return;
      }
      const completed = await (running ?? setup.application.runObjective(1));
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.objectiveClosure, "complete");
      assert.equal(status().pendingAmendment, null);
      assert.equal(consumption(completed).planningRevisions, 2);
      assert.equal(consumption(completed, "$planning").planningRevisions, 2);
      assert.equal(compilations, 3);
      assert.equal(graphReviews, rejection === "compilation" ? 2 : 3);
      assert.equal(completed.work.result.attempt, stopped.work.result.attempt);
      assert.equal(
        completed.work.result.integratedSha,
        stopped.work.result.integratedSha,
      );
      assert.equal(completed.work.qa.status, "done");
      assert.equal(
        readEvents(setup.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
      assert.deepEqual(completed.rejectedAmendments, [
        stopped.pendingAmendment,
      ]);
      assertGraphRevisions(readState(config.repository, 1));
    });
  });

test("actual review provider/protocol failures cannot authorize amendment replacement", async () => {
  for (const failure of [
    "unknown-once",
    "unknown",
    "completed-provider",
    "wrong-packet",
    "incomplete-response",
  ])
    await fixture(`review-${failure}`, async ({ config, initial }) => {
      const graph = withCoverage(
        {
          coverageObligations: coverageObligations(
            body,
            objectiveCriteria(body),
          ),
        },
        initial,
      );
      graph.coverage[0].source = coverageObligations(
        body,
        objectiveCriteria(body),
      )[0].source;
      const state = {
        objective: 1,
        baseSha: initial.baseSha,
        graph,
        issueByItemId: { result: 2 },
        work: { result: { status: "done", attempt: "retained" } },
        autonomy: resolveAutonomy(replacementAutonomy),
        capacity: { concurrency: config.execution.concurrency },
        planGraphDigest: graphDigest(graph),
        coordinator: { mode: "running" },
      };
      submitAmendment(state, {
        ...discovery,
        actor: "operator",
        expectedGraphDigest: graphDigest(graph),
      });
      let compiled = 0;
      let reviewed = 0;
      let projected = 0;
      let reviewAnswers = false;
      const saved = [];
      const args = {
        state,
        config,
        body,
        model: {
          async generateStructured(request) {
            compiled++;
            const wire = compilerWire(
              request,
              compilerCitationChoices(request.sources),
            );
            return wire.decode(encodeCompilerWire(qaGraph(graph), wire.data));
          },
          async reviewGraph(request) {
            reviewed++;
            if (reviewAnswers || (failure === "unknown-once" && reviewed > 1))
              return { packetId: request.reviewPacket.id, findings: [] };
            if (failure.startsWith("unknown"))
              throw lost("Unknown review submission outcome");
            if (failure === "completed-provider")
              throw new CompletedModelInvocationError(
                "Provider refused the request",
              );
            if (failure === "wrong-packet")
              return { packetId: "stale", findings: [] };
            return {
              packetId: request.reviewPacket.id,
              findings: [
                {
                  evidenceIndices: [0],
                  detail: "Partial finding with missing question",
                },
              ],
            };
          },
        },
        github: {
          async projectGraph(request) {
            projected++;
            if (!reviewAnswers && failure !== "unknown-once")
              throw new Error("Unexpected projection");
            return { issueByItemId: { ...request.knownIssues, qa: 3 } };
          },
        },
        save() {
          if (state.pendingAmendment)
            saved.push(structuredClone(state.pendingAmendment));
        },
        cancelled: () => false,
        clock,
      };
      if (failure === "unknown-once") {
        // The step repeats the lost review and completes.
        assert.equal(await applyPendingAmendment(args), true);
        assert.ok(saved.some((entry) => entry.phase === "compiled"));
        assert.equal(compiled, 1);
        assert.equal(reviewed, 2);
        assert.equal(projected, 1);
        assert.equal(state.coordinator.mode, "running");
        assert.equal(state.pendingAmendment, undefined);
        assert.deepEqual(state.issueByItemId, { result: 2, qa: 3 });
        assert.equal(consumption(state).planningRevisions, 1);
        return;
      }
      await assert.rejects(applyPendingAmendment(args));
      // Lost answers repeat within the paid bound, then ask the operator;
      // completed answers are not repeated.
      assert.equal(reviewed, failure === "unknown" ? 4 : 1);
      assert.equal(projected, 0);
      // A lost answer leaves the amendment at its last completed phase. A
      // completed refusal or protocol failure rejects it.
      assert.equal(
        state.pendingAmendment.phase,
        failure === "unknown" ? "compiled" : "rejected",
      );
      assert.equal(
        state.pendingAmendment.rejectionStage,
        failure === "unknown" ? undefined : "review",
      );
      assert.equal(state.pendingAmendment.reviewDigest, undefined);
      if (failure === "unknown") assert.equal(state.wait.kind, "decision");
      else {
        assert.equal(state.coordinator.mode, "paused");
        assert.equal(
          state.coordinator.waitReason,
          state.pendingAmendment.error,
        );
      }
      assert.equal(consumption(state).planningRevisions, 1);
      const correction = {
        ...state.pendingAmendment.proposal,
        replacement: {
          amendmentId: state.pendingAmendment.id,
          correction: {
            failureDigest: failureDigest(
              state.pendingAmendment.error ?? "unknown review outcome",
            ),
            kind: "planning-output",
            actor: "operator",
            diagnosis:
              "Incomplete or unavailable review is not a decoded finding",
            correction:
              "Do not treat a provider or protocol failure as acceptance evidence",
          },
        },
      };
      const before = JSON.stringify(state);
      assert.throws(
        () => submitAmendment(state, correction),
        /known generated amendment rejection/,
      );
      assert.equal(JSON.stringify(state), before);
      if (failure !== "unknown") {
        await assert.rejects(applyPendingAmendment(args), /cannot be replayed/);
        assert.equal(reviewed, 1);
        return;
      }
      // The operator's retry repeats only the interrupted review.
      assert.equal(clearRepeats(state, "objective"), true);
      reviewAnswers = true;
      assert.equal(await applyPendingAmendment(args), true);
      assert.equal(compiled, 1);
      assert.equal(reviewed, 5);
      assert.equal(state.wait, undefined);
      assert.equal(projected, 1);
      assert.equal(state.pendingAmendment, undefined);
      assert.deepEqual(state.issueByItemId, { result: 2, qa: 3 });
      assert.equal(consumption(state).planningRevisions, 1);
    });
});

test("a projection refusal waits for the operator and is never a rejection", async () => {
  // A foreign change (decision) or a refused permission (config) leaves the
  // amendment reviewed; the operator's retry projects again.
  for (const fault of [
    decision("GitHub rejected a value Factory submitted."),
    {
      kind: "config",
      detail: "GitHub login lacks permission",
      fix: "Grant it",
    },
  ])
    await fixture(
      `projection-refusal-${fault.kind}`,
      async ({ config, initial }) => {
        const obligations = coverageObligations(body, objectiveCriteria(body));
        const graph = withCoverage(
          { coverageObligations: obligations },
          initial,
        );
        graph.coverage[0].source = obligations[0].source;
        const state = {
          graph,
          objective: 1,
          baseSha: initial.baseSha,
          runId: "fixture",
          issueByItemId: { result: 2 },
          work: { result: { status: "done", attempt: "preserved" } },
          autonomy,
          capacity: { concurrency: config.execution.concurrency },
          planGraphDigest: graphDigest(graph),
          coordinator: { mode: "running" },
        };
        submitAmendment(state, {
          ...discovery,
          actor: "operator",
          expectedGraphDigest: graphDigest(graph),
          graph: qaGraph(graph),
        });
        let creates = 0;
        let refuse = true;
        const args = {
          state,
          config,
          body,
          model: {
            async reviewGraph(request) {
              return { packetId: request.reviewPacket.id, findings: [] };
            },
          },
          github: {
            async projectGraph(request) {
              request.projected("result", 2);
              await request.beforeCreate("qa");
              if (refuse) throw attachFault(new GitHubRequestError(422), fault);
              creates++;
              return { issueByItemId: { ...request.knownIssues, qa: 3 } };
            },
          },
          save() {},
          cancelled: () => false,
          clock,
        };
        await assert.rejects(applyPendingAmendment(args), /GitHub/);
        assert.equal(state.pendingAmendment.phase, "reviewed");
        assert.equal(state.pendingAmendment.rejectionStage, undefined);
        assert.ok(state.pendingAmendment.reviewDigest);
        assert.equal(
          state.wait.kind,
          fault.kind === "decision" ? "decision" : "prerequisite",
        );
        assert.equal(state.graph.items.length, 1);
        refuse = false;
        assert.equal(clearRepeats(state, "objective"), true);
        assert.equal(await applyPendingAmendment(args), true);
        assert.equal(creates, 1);
        assert.equal(state.wait, undefined);
        assert.equal(state.work.result.attempt, "preserved");
        assertAmendmentCompleted(state);
      },
    );
});

test("mutation-unknown projection repeats without duplicate issues", async () => {
  await assertProjectionRepeats(
    "projection-mutation-unknown",
    attachFault(
      new Error("GitHub mutation outcome unknown"),
      transient("GitHub POST response was lost", true),
    ),
  );
});
