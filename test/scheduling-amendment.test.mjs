import { hydrateWorkerInputSources } from "../dist/compiler.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyPendingAmendment,
  graphDigest,
  submitAmendment,
  validateAmendment,
} from "../dist/graph-amendments.js";
import { readyItems } from "../dist/scheduler.js";
import { coverageObligations } from "../dist/qa.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";

test("accepted reprioritization changes pending order without resetting running ownership or allowance", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-priority-amendment-"));
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/priority-amendment");
    const body =
      "## Acceptance\n- result.txt exists\n## Commands\n- test -s result.txt\n## Final validation\n- test -s result.txt\n";
    const item = (id) => ({
      id,
      kind: "work",
      priority: 0,
      title: id,
      goal: id,
      brief: id,
      acceptance: ["result.txt exists"],
      nonGoals: ["No deployment"],
      citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
      dependencies: [],
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
    });
    const obligations = coverageObligations(body, ["result.txt exists"]);
    const graph = withCoverage(
      { coverageObligations: obligations },
      {
        objective: 1,
        baseSha: target.baseSha,
        items: [
          item("first"),
          item("second"),
          { ...item("legacy"), priority: undefined },
        ],
      },
    );
    graph.coverage[0].source = obligations[0].source;
    hydrateWorkerInputSources(graph, [{ path: "OBJECTIVE", content: body }]);
    const state = {
      objective: 1,
      baseSha: target.baseSha,
      graph,
      runId: "priority-fixture",
      issueByItemId: { first: 2, second: 3, legacy: 4 },
      work: {
        first: { status: "pending" },
        second: { status: "pending" },
        legacy: { status: "done", attempt: "retained-legacy" },
      },
      admission: {
        graphDigest: graphDigest(graph),
        authority: {
          schemaVersion: 1,
          actor: "fixture operator",
          reason: "Bounded accepted reprioritization",
          executionConsent: true,
          serviceConsent: false,
          objectives: [1],
          repairClasses: [],
          requiredEnvironment: [],
          allowances: {
            planningRevisions: 1,
            implementationRepairs: 0,
            resultRereviews: 0,
          },
          resources: { maxConcurrency: 2 },
        },
      },
    };
    assert.equal(
      readyItems(state.graph, state.work, new Set(), 1)[0].id,
      "first",
    );
    const candidate = structuredClone(graph);
    candidate.items[1].priority = 5;
    candidate.items[2].priority = 0;
    const proposal = {
      scope: "in-scope",
      reason: "Accepted prerequisite urgency",
      evidence: ["Operator selected pending priority"],
      ownership: ["second.txt"],
      acceptance: ["result.txt exists"],
      dependencies: [],
      actor: "operator",
      expectedGraphDigest: graphDigest(graph),
      graph: candidate,
    };
    submitAmendment(state, proposal);
    let reviews = 0;
    await applyPendingAmendment({
      state,
      config,
      body,
      model: {
        async reviewGraph(request) {
          reviews++;
          assert.deepEqual(request.executionBounds, {
            configuredConcurrency: config.execution.concurrency,
            authorizedMaxConcurrency:
              state.admission.authority.resources.maxConcurrency,
          });
          return {
            packetId: request.reviewPacket.id,
            findings: [],
          };
        },
      },
      github: {
        async projectGraph() {
          return { issueByItemId: state.issueByItemId };
        },
      },
      save() {},
      cancelled: () => false,
    });
    assert.equal(reviews, 1);
    assert.equal(state.work.legacy.attempt, "retained-legacy");
    assert.equal(state.graph.items[2].priority, 0);
    assert.equal(
      readyItems(state.graph, state.work, new Set(), 1)[0].id,
      "second",
    );
    assert.equal(state.allowanceConsumption.planningRevisions, 1);
    state.work.second = {
      status: "running",
      attempt: "owned",
      phaseReservation: "coding",
    };
    const runningChange = structuredClone(state.graph);
    runningChange.items[1].priority = 0;
    submitAmendment(state, {
      ...proposal,
      expectedGraphDigest: graphDigest(state.graph),
      graph: runningChange,
    });
    assert.throws(
      () => validateAmendment(state, runningChange, config, body),
      /started|active|identity|retain|immutable|preserv/i,
    );
    assert.equal(state.work.second.attempt, "owned");
    assert.equal(state.work.second.phaseReservation, "coding");
    assert.equal(state.allowanceConsumption.planningRevisions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
