import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readContinuation, readState } from "../../dist/state-store.js";
import { controlObjective } from "../../dist/runner.js";
import { compilerCitationChoices } from "../../dist/compiler.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./integration-fixture.mjs";
import { withCoverage } from "./coverage.mjs";
import { startHeartbeat } from "./liveness.mjs";
import { scaleTimers } from "./fast-timers.mjs";

// CI waits poll from inside the delivery step; run its polls fast.
scaleTimers(0.02);

// Parent owns the disposable root and a heartbeat watchdog: a microtask spin
// starves this timer, so the parent detects the regression without a
// total-duration budget (see liveness.mjs).
const stopHeartbeat = startHeartbeat();
const root = process.argv[2];
mkdirSync(root, { recursive: true });
process.env.XDG_STATE_HOME = join(root, "state");
const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
const item = {
  id: "result",
  kind: "work",
  children: [],
  title: "Result",
  goal: "Write result.txt",
  brief: "Write result.txt",
  inputSources: compilerCitationChoices([
    { path: "OBJECTIVE", content: body },
  ]).filter((choice) => choice.heading === "Acceptance"),
  acceptance: ["result.txt exists"],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
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
const target = createTarget(root);
const config = factoryConfig(
  target.checkout,
  "example/ci-wait-amendment",
  "regular",
  1,
);
let graph,
  generations = 0;
const model = {
  async generateStructured(request) {
    generations++;
    if (!graph) {
      graph = withCoverage(request, {
        objective: 1,
        baseSha: target.baseSha,
        items: [item],
      });
      return graph;
    }
    const next = structuredClone(graph);
    next.items.push({
      ...item,
      id: "qa",
      title: "QA",
      kind: "qa",
      dependencies: ["result"],
      ownedPaths: [],
    });
    next.coverage = next.coverage.map((entry) => ({
      ...entry,
      itemId: "qa",
      proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
    }));
    return next;
  },
  async reviewGraph(request) {
    return { packetId: request.reviewPacket.id, findings: [] };
  },
  async reviewResult(request) {
    return {
      packetId: request.reviewPacket.id,
      findings: request.reviewPacket.criteria.map(
        (_criterion, criterionIndex) => ({
          criterionIndex,
          verdict: "pass",
          evidenceIndices: [
            request.reviewPacket.evidence.findIndex(
              (entry) => entry.path === "OBJECTIVE",
            ),
          ],
          detail: "Exact fixture acceptance",
          question: "",
        }),
      ),
    };
  },
};
const discovery = {
  scope: "in-scope",
  reason: "Required integrated behavior needs independent QA",
  evidence: ["Implementation result needs integrated proof"],
  ownership: ["result.txt"],
  acceptance: ["result.txt exists at integrated head"],
  dependencies: ["result"],
};
const setup = makeApplication({
  config,
  graph: { objective: 1, baseSha: target.baseSha, items: [item] },
  objectiveBody: body,
  fakeRoot: join(root, "fake"),
  planningModel: model,
  actions: {
    result: {
      files: [
        { path: "result.txt", text: "done\n" },
        { path: ".factory-discovery.json", text: JSON.stringify(discovery) },
      ],
    },
  },
});
const publish = setup.github.publish.bind(setup.github);
setup.github.publish = async (request) => {
  const published = await publish(request);
  setup.github.update((state) => {
    state.pullRequests[published.number].checks = "pending";
  });
  return published;
};
const running = setup.application.runObjective(1);
void running.catch(() => {});
while (
  readContinuation(config.repository, 1)?.work?.result?.wait?.kind !== "ci"
)
  await new Promise((resolve) => setTimeout(resolve, 10));
const waiting = readState(config.repository, 1);
assert.equal(waiting.work.result.status, "published");
assert.ok(waiting.work.result.discovery);
// Timer and controls must remain responsive while the amendment is blocked by
// the exact published result. CI becomes passing after the owner reaches that wait.
await new Promise((resolve) => setTimeout(resolve, 100));
const status = await controlObjective(config, {
  objective: 1,
  action: "status",
});
assert.equal(status.mode, "running");
setup.github.update((state) => {
  for (const pull of Object.values(state.pullRequests)) pull.checks = "passing";
});
const completed = await running;
assert.equal(completed.finalValidation.passed, true);
assert.equal(completed.work.result.attempt, waiting.work.result.attempt);
assert.equal(
  completed.work.result.pullRequest,
  waiting.work.result.pullRequest,
);
assert.equal(completed.work.result.changeRef, waiting.work.result.changeRef);
assert.equal(completed.work.result.discoveryDisposition, "accepted");
assert.equal(completed.work.qa.status, "done");
assert.equal(completed.graphRevisions.length, 2);
assert.deepEqual(
  completed.graphRevisions[0].graph.items.map(({ id }) => id),
  ["result"],
);
assert.equal(generations, 2);
assert.equal(
  readEvents(setup.eventsPath).filter((event) => event.type === "start").length,
  1,
);
console.log(
  "discovery and CI wait completed with one worker and a responsive owner",
);
// Done: a process that now fails to exit stops beating and is reported.
stopHeartbeat();
