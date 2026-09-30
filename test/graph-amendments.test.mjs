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
import { aggregateAcceptance, coverageObligations } from "../dist/qa.js";
import {
  compilerCitationChoices,
  objectiveCriteria,
} from "../dist/compiler.js";
import { readyItems, validateAndOrderGraph } from "../dist/scheduler.js";
import { readState, statePath } from "../dist/state-store.js";
import { failureDigest } from "../dist/repair-policy.js";
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
import { encodeCompilerWire } from "./support/compiler-wire.mjs";

const discovery = {
  scope: "in-scope",
  reason: "Required integrated behavior needs independent QA",
  evidence: ["Implementation result needs integrated proof"],
  ownership: ["result.txt"],
  acceptance: ["result.txt exists at integrated head"],
  dependencies: ["result"],
};
const authority = {
  schemaVersion: 1,
  actor: "fixture",
  reason: "Bounded amendment regression",
  executionConsent: true,
  serviceConsent: false,
  objectives: [1],
  allowances: {
    planningRevisions: 1,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
  resources: { maxConcurrency: 2 },
  requiredEnvironment: [],
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
    const initial = { objective: 1, baseSha: target.baseSha, items: [item()] };
    await fn({ root, config, initial, target });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: worker discovery autonomously adds reviewed QA without rerunning implementation`, async () => {
    await fixture(
      delivery,
      async ({ root, config, initial }) => {
        let generated = 0;
        let reviews = 0;
        let first;
        const planningModel = {
          async generateStructured(request) {
            generated++;
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
            const value = encodeCompilerWire(qaGraph(first), wire.data);
            assert.deepEqual(value.items[0], {
              kind: "retained",
              id: "result",
              coverage: [],
            });
            return wire.decode(value);
          },
          async reviewGraph(request) {
            reviews++;
            if (request.amendment)
              assert.equal(request.amendment.work.result.status, "done");
            return {
              packetId: request.reviewPacket.id,
              findings: [],
            };
          },
          async reviewResult(request) {
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
        const candidate = await setup.application.planObjective(1);
        const admission = await setup.application.admitObjective(1, candidate, {
          ...authority,
          serviceConsent: true,
        });
        const state = await setup.application.runObjective(
          1,
          candidate,
          admission,
        );
        assert.equal(state.finalValidation.passed, true);
        assert.equal(generated, 2);
        assert.equal(reviews, 2);
        assert.equal(state.graphRevisions.length, 2);
        assert.equal(state.admission.graphDigest, graphDigest(candidate.graph));
        assert.equal(state.allowanceConsumption.planningRevisions, 1);
        assert.equal(state.work.result.discoveryDisposition, "accepted");
        assert.equal(state.work.qa.status, "done");
        assert.equal(state.work.qa.pullRequest, undefined);
        assert.equal(
          readEvents(setup.eventsPath).filter((event) => event.type === "start")
            .length,
          1,
        );
        assertGraphRevisions(readState(config.repository, 1));
        assert.doesNotThrow(() => checkServiceState(config, 1));
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
      admission: { graphDigest: graphDigest(graph), authority },
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
    validateAmendment(state, proposal.graph, config, body);
  });
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
      admission: { graphDigest: graphDigest(graph), authority },
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
      }),
      true,
    );
    assert.equal(reviews, 1);
    assert.equal(JSON.stringify(candidate), originalProposal);
    assert.deepEqual(state.graph.items[0], graph.items[0]);
    assert.equal(state.work.result.attempt, "preserved");
    assert.equal(state.allowanceConsumption.planningRevisions, 1);
  });
});

test("partial/unknown projection retains exact intent and prevents duplicate issue creation on restart", async () => {
  await fixture("projection", async ({ config, initial }) => {
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
      admission: { graphDigest: graphDigest(graph), authority },
      coordinator: { mode: "running" },
    };
    submitAmendment(state, {
      ...discovery,
      actor: "operator",
      expectedGraphDigest: graphDigest(graph),
      graph: qaGraph(graph),
    });
    let creates = 0;
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
        async projectGraph(request) {
          request.projected("result", 2);
          await request.beforeCreate("qa");
          creates++;
          throw new Error("response lost");
        },
      },
      save() {},
      cancelled: () => false,
    };
    await assert.rejects(applyPendingAmendment(args), /response lost/);
    assert.equal(state.pendingAmendment.phase, "projecting");
    assert.equal(state.pendingAmendment.projectionPending, "qa");
    assert.equal(state.graph.items.length, 1);
    assert.equal(state.work.result.attempt, "preserved");
    await assert.rejects(applyPendingAmendment(args), /cannot be replayed/);
    assert.equal(creates, 1);
    assert.equal(state.allowanceConsumption.planningRevisions, 1);
  });
});

test("compound: amendment invalidates final review before lost closure acknowledgement is reconciled", async () => {
  await fixture("final-race", async ({ config, initial, root }) => {
    let accepted;
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
          if (finals === 1)
            await setup.application.proposeAmendment(1, {
              ...discovery,
              actor: "operator",
              expectedGraphDigest: graphDigest(accepted.graph),
              graph: qaGraph(accepted.graph),
            });
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
    accepted = await setup.application.planObjective(1);
    const admission = await setup.application.admitObjective(
      1,
      accepted,
      authority,
    );
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
    const running = setup.application.runObjective(1, accepted, admission);
    for (let i = 0; i < 300; i++) {
      const state = readState(config.repository, 1);
      if (
        state?.objectiveClosure === "pending" &&
        state.coordinator.mode === "paused"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pending = readState(config.repository, 1);
    assert.equal(pending.objectiveClosure, "pending");
    assert.equal(pending.coordinator.mode, "paused");
    assert.equal(pending.graphRevisions.length, 2);
    assert.equal(pending.work.qa.status, "done");
    assert.equal(finals, 2);
    const consumption = structuredClone(pending.allowanceConsumption);
    assert.equal(sealed.graphDigest, graphDigest(pending.graph));
    assert.notEqual(sealed.graphDigest, graphDigest(accepted.graph));
    assert.equal(sealed.usage.availability, "unavailable");
    await controlObjective(config, { objective: 1, action: "resume" });
    const state = await running;
    assert.equal(closures, 2);
    assert.equal(state.objectiveClosure, "complete");
    assert.deepEqual(state.finalAcceptance, sealed);
    assert.deepEqual(state.allowanceConsumption, consumption);
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
  test(`${delivery}: aggregate parent proves child results without a competing worker or PR`, async () => {
    await fixture(
      `aggregate-${delivery}`,
      async ({ config, initial, root }) => {
        const one = item("one");
        one.dependencies = ["result"];
        const two = item("two");
        two.dependencies = ["result"];
        const parent = {
          ...item("parent", ["one", "two"]),
          kind: "aggregate",
          acceptance: aggregateAcceptance({ id: "parent" }),
          ownedPaths: [],
          children: ["one", "two"],
        };
        initial.items.push(one, two, parent);
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
    const candidate = await setup.application.planObjective(1);
    const admission = await setup.application.admitObjective(
      1,
      candidate,
      authority,
    );
    const state = await setup.application.runObjective(1, candidate, admission);
    assert.equal(state.work.result.discovery.scope, "backlog");
    assert.equal(state.allowanceConsumption, undefined);
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
        admission: { graphDigest: graphDigest(graph), authority },
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
          save() {},
          cancelled: () => false,
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
      admission: { graphDigest: graphDigest(graph), authority },
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
    restarted.allowanceConsumption.planningRevisions = 0;
    assert.throws(() => assertGraphRevisions(restarted), /exceed consumed/);
    submitAmendment(state, {
      ...discovery,
      actor: "operator",
      expectedGraphDigest: graphDigest(state.graph),
      graph: state.graph,
    });
    await assert.rejects(applyPendingAmendment(args), /allowance exhausted/);
    assert.equal(state.allowanceConsumption.planningRevisions, 1);
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
      2,
      {
        id: 102,
        number: 2,
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
    async paginate(route) {
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
      if (method === "GET") return structuredClone(issues.get(n));
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
        const issue = { id: 100 + number, number, state: "open", ...value };
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
        const candidate = await setup.application.planObjective(1);
        const admission = await setup.application.admitObjective(
          1,
          candidate,
          authority,
        );
        const state = await setup.application.runObjective(
          1,
          candidate,
          admission,
        );
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
        assert.equal(state.allowanceConsumption.planningRevisions, 1);
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
          admission: { graphDigest: graphDigest(graph), authority },
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
        assert.equal(state.allowanceConsumption.planningRevisions, 1);
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
        assert.equal(state.allowanceConsumption.planningRevisions, 1);
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

test("owner handoff after known amendment review resumes without repeating model work", {
  timeout: 20000,
}, async () => {
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
    const candidate = await setup.application.planObjective(1);
    const admission = await setup.application.admitObjective(1, candidate, {
      ...authority,
      serviceConsent: true,
    });
    await assert.rejects(
      setup.application.runObjective(1, candidate, admission),
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
    assert.equal(result.allowanceConsumption.planningRevisions, 1);
    assert.equal(
      readEvents(setup.eventsPath).filter((event) => event.type === "start")
        .length,
      1,
    );
  });
});

for (const transport of ["stopped CLI", "live owner"])
  test(`${transport}: diagnosed QA amendment replacement retains accepted work and charges one remaining revision`, async () => {
    await fixture("rejected-correction", async ({ root, config, initial }) => {
      config.policy.allowedSecretNames = ["FACTORY_TEST_AMENDMENT_SECRET"];
      let first;
      let compilations = 0;
      let graphReviews = 0;
      const planningModel = {
        async generateStructured(request) {
          compilations++;
          if (!first) return (first = withCoverage(request, initial));
          if (compilations === 2) {
            const invalid = qaGraph(first);
            // All source obligations still belong to work; QA is uncovered.
            invalid.coverage = first.coverage;
            return invalid;
          }
          assert.equal(
            JSON.parse(
              request.compileContext.instructions.trim().split("\n").at(-1),
            ).discovery.replacement.correction.kind,
            "planning-output",
          );
          return qaGraph(first);
        },
        async reviewGraph(request) {
          graphReviews++;
          if (request.amendment)
            assert.equal(request.amendment.work.result.status, "done");
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
      const candidate = await setup.application.planObjective(1);
      const admission = await setup.application.admitObjective(1, candidate, {
        ...authority,
        serviceConsent: true,
        allowances: { ...authority.allowances, planningRevisions: 2 },
        repairClasses: ["planning-output"],
        repairPolicy: {
          perPath: { ...authority.allowances, planningRevisions: 2 },
        },
      });
      await assert.rejects(
        setup.application.runObjective(1, candidate, admission),
        /QA node has no acceptance coverage/,
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
      assert.equal(stopped.pendingAmendment.rejectionStage, "compilation");
      assert.equal(stopped.allowanceConsumption.planningRevisions, 1);
      const proposal = {
        ...stopped.pendingAmendment.proposal,
        actor: "operator",
        replacement: {
          amendmentId: stopped.pendingAmendment.id,
          correction: {
            failureDigest: rejectedStatus.failureDigest,
            kind: "planning-output",
            diagnosis: "Emitted choice contract allowed uncovered QA",
            correction:
              "QA choices now require a feasible existing source obligation",
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
        (s) => {
          s.pendingAmendment.phase = "compiling";
        },
        (s) => {
          s.pendingAmendment.projectionPending = "qa";
        },
        (s) => {
          s.pendingAmendment.rejectionStage = "review";
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
          s.work.result.pendingEffect = "merge";
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
          s.admission.authority.repairClasses = [];
        },
        (s) => {
          s.allowanceConsumption.planningRevisions = 2;
        },
        (s) => {
          s.repairConsumption.$planning.planningRevisions = 2;
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
          delete s.allowanceConsumption;
          delete s.repairConsumption;
        },
        (s) => {
          s.allowanceConsumption.planningRevisions = 0;
          s.repairConsumption.$planning.planningRevisions = 0;
        },
        (s) => {
          s.repairConsumption.$planning.planningRevisions = 0;
        },
        (s) => {
          delete s.repairConsumption;
        },
      ]) {
        const reset = structuredClone(replaced);
        mutate(reset);
        assert.throws(
          () => parseFactoryState(reset, config.repository, 1),
          /Known amendment attempts exceed retained planning consumption/,
        );
      }
      assert.deepEqual(replaced.rejectedAmendments, [stopped.pendingAmendment]);
      assert.deepEqual(replaced.graph, stopped.graph);
      assert.deepEqual(replaced.work, stopped.work);
      assert.deepEqual(replaced.admission, stopped.admission);
      assert.equal(replaced.runId, stopped.runId);
      assert.equal(replaced.error, undefined);
      assert.equal(replaced.coordinator.mode, "paused");
      assert.equal(replaced.allowanceConsumption.planningRevisions, 1);
      assert.equal(compilations, 2);
      assert.equal(graphReviews, 1);
      const beforeDuplicate = readFileSync(
        statePath(config.repository, 1),
        "utf8",
      );
      await assert.rejects(
        setup.application.proposeAmendment(1, proposal),
        /known unprojected/,
      );
      assert.equal(
        readFileSync(statePath(config.repository, 1), "utf8"),
        beforeDuplicate,
      );
      await controlObjective(config, { objective: 1, action: "resume" });
      const completed = await (running ?? setup.application.runObjective(1));
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.objectiveClosure, "complete");
      assert.equal(status().pendingAmendment, null);
      assert.equal(completed.allowanceConsumption.planningRevisions, 2);
      assert.equal(completed.repairConsumption.$planning.planningRevisions, 2);
      assert.equal(compilations, 3);
      assert.equal(graphReviews, 2);
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
