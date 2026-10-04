import { compilerCitationChoices } from "../dist/compiler.js";
import { compilerWire } from "../dist/compiler-wire.js";
import { compilerRequest, compilerResponse } from "./support/compiler-wire.mjs";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { Codex } from "@openai/codex-sdk";
import { composeWithLocalProfiles } from "../dist/application.js";
import {
  CodexPlanningModel,
  compilePlan,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { factoryConfigDigest, validateConfig } from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import {
  statusDocument,
  summarizeDiagnosticUsage,
} from "../dist/diagnostics.js";
import { LocalExecutionDriver } from "../dist/execution/local.js";
import {
  executionProfileChoices,
  normalizeExecutionProfiles,
  profileBinding,
  verifyExecutionProfiles,
} from "../dist/execution-profiles.js";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient, GitHubRequestError } from "../dist/github-client.js";
import { parseFactoryState } from "../dist/state.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  git,
  StatefulGitHubFake,
} from "./support/integration-fixture.mjs";
import { projectionClient } from "./support/projection-client.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const capabilities = {
  protocolVersion: 1,
  worktree: "factory-owned-read-write",
  head: "preserve",
  lifecycle: "restart-safe-durable-handle",
  publication: "controller-only",
  assetSets: true,
  authentication: "none",
};
function item(id, dependencies = [], profile) {
  return {
    id,
    title: id,
    goal: `Write ${id}.txt`,
    acceptance: [`test -s ${id}.txt`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
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
    brief: `Write ${id}.txt`,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
    ...(profile
      ? {
          executionProfile: {
            id: profile,
            reason: "Explicit operator preference",
          },
        }
      : {}),
  };
}
function configFor(target) {
  const config = factoryConfig(target.checkout, "example/profiles");
  config.execution = {
    kind: "local",
    concurrency: 2,
    defaultProfile: "standard",
    profiles: {
      standard: {
        description: "General implementation",
        selectionHints: ["Default when suitable"],
        harness: {
          kind: "registered",
          adapter: "fixture@1",
          config: { setting: "first", privatePath: "DO-NOT-SEND" },
        },
      },
      focused: {
        description: "Focused implementation",
        selectionHints: ["Use for explicit focused work"],
        harness: {
          kind: "registered",
          adapter: "fixture@1",
          config: { setting: "second" },
        },
      },
    },
  };
  return config;
}
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "factory-profiles-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    await fn(root, createTarget(root));
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
const body =
  "# Objective\n\n## Acceptance\n- `test -s one.txt`\n- `test -s two.txt`\n- `test -s joined.txt`\n\n## Final validation\n- `test -s one.txt`\n- `test -s two.txt`\n- `test -s joined.txt`\n";
function modelFor(graph, seen = []) {
  return {
    async generateStructured(request) {
      seen.push(request);
      return withCoverage(request, structuredClone(graph));
    },
    async reviewGraph(request) {
      seen.push(request);
      return {
        packetId: request.reviewPacket.id,
        findings: [],
      };
    },
    async reviewResult(request) {
      return {
        packetId: request.reviewPacket.id,
        findings: resultFindings(
          request,
          request.criteria.map((criterion) => ({
            criterion,
            verdict: "pass",
            source: "OBJECTIVE",
            quote: criterion,
            detail: "Scripted deterministic result review",
            question: "",
          })),
        ),
      };
    },
  };
}
function harnessFor(id, events) {
  return {
    capabilities,
    async start(request) {
      events.push({
        method: "start",
        profile: id,
        item: request.item.id,
        base: git(request.worktree, "rev-parse", "HEAD"),
      });
      for (const dependency of request.item.dependencies)
        assert.ok(existsSync(join(request.worktree, `${dependency}.txt`)));
      writeFileSync(join(request.worktree, `${request.item.id}.txt`), id);
      return { identity: request.attemptId, data: { profile: id } };
    },
    async observe(handle) {
      assert.equal(handle.data.profile, id);
      events.push({ method: "observe", profile: id });
      return { state: "complete" };
    },
    async cancel(handle) {
      assert.equal(handle.data.profile, id);
      events.push({ method: "cancel", profile: id });
    },
    async collect(handle) {
      assert.equal(handle.data.profile, id);
      events.push({ method: "collect", profile: id });
      return {};
    },
  };
}

test("profile configuration, safe compiler choices, default normalization and immutable plan binding", async () =>
  fixture(async (root, target) => {
    const config = configFor(target);
    validateConfig(config);
    const choices = executionProfileChoices(config);
    assert.doesNotMatch(
      JSON.stringify(choices),
      /DO-NOT-SEND|privatePath|setting/,
    );
    for (const mutate of [
      (c) => {
        c.execution.harness = {
          kind: "codex-sdk",
          model: "x",
          reasoningEffort: "low",
        };
      },
      (c) => {
        c.execution.defaultProfile = "absent";
      },
      (c) => {
        c.execution.profiles.standard.environment = {};
      },
      (c) => {
        c.execution.profiles.standard.harness.kind = "unknown";
      },
    ]) {
      const bad = structuredClone(config);
      mutate(bad);
      assert.throws(() => validateConfig(bad));
    }
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        item("one"),
        item("two", [], "focused"),
        item("joined", ["one", "two"]),
      ],
    };
    const seen = [];
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      modelFor(graph, seen),
      factoryConfigDigest(config),
      undefined,
      choices,
    );
    assert.equal(candidate.graph.items[0].executionProfile.id, "standard");
    assert.equal(
      candidate.graph.items[1].executionBinding.adapter,
      "fixture@1",
    );
    assert.deepEqual(seen[1].executionProfiles, choices);
    assert.equal(
      seen[1].graph.items[0].executionBinding.digest,
      choices.profiles[0].digest,
    );
    assert.deepEqual(
      compilerWire(seen[0], compilerCitationChoices(seen[0].sources)).schema
        .properties.items.items.anyOf[0].properties.executionProfile.properties
        .id.enum,
      ["standard", "focused"],
    );
    verifyPlanCandidate(
      candidate,
      1,
      body,
      target.baseSha,
      target.checkout,
      factoryConfigDigest(config),
    );
    verifyExecutionProfiles(candidate.graph, choices);
    const changed = structuredClone(config);
    changed.execution.profiles.standard.harness.config.setting = "changed";
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
          factoryConfigDigest(changed),
        ),
      /differs/,
    );
    assert.throws(
      () =>
        verifyExecutionProfiles(
          candidate.graph,
          executionProfileChoices(changed),
        ),
      /differs/,
    );
    const unknown = structuredClone(graph);
    unknown.items[0].executionProfile = { id: "absent", reason: "invented" };
    await assert.rejects(
      compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        modelFor(unknown),
        factoryConfigDigest(config),
        undefined,
        choices,
      ),
      /unauthorized/,
    );
    const forged = structuredClone(graph);
    forged.items[0].executionBinding = choices.profiles[0];
    await assert.rejects(
      compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        modelFor(forged),
        factoryConfigDigest(config),
        undefined,
        choices,
      ),
      /may not supply/,
    );
  }));

test("same-adapter distinct profiles survive restart, cancel and collect; missing/drifted bindings fail closed", async () =>
  fixture(async (root, target) => {
    const config = configFor(target);
    const events = [];
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [item("one", [], "standard"), item("two", [], "focused")],
    };
    normalizeExecutionProfiles(graph, executionProfileChoices(config));
    const registrations = () =>
      new Map(
        Object.entries(config.execution.profiles).map(([id, profile]) => [
          id,
          {
            binding: profileBinding(id, profile, config.policy),
            createHarness: () => harnessFor(id, events),
          },
        ]),
      );
    const driver = () =>
      new LocalExecutionDriver(
        target.checkout,
        join(root, "worktrees"),
        undefined,
        2,
        new LocalContentStore(join(root, "content")),
        "profiles",
        registrations(),
      );
    const first = driver();
    await first.preflight(graph);
    const handles = await Promise.all(
      graph.items.map((item, index) =>
        first.start({
          item,
          baseSha: target.baseSha,
          attemptId: `profile-${index}`,
        }),
      ),
    );
    assert.equal(await first.availableSlots(), 0);
    const restarted = driver();
    for (const handle of handles) {
      await restarted.observe(JSON.parse(JSON.stringify(handle)));
      await restarted.cancel(handle);
      const result = await restarted.collect(handle);
      assert.ok(result.treeSha);
    }
    assert.deepEqual(
      events.filter((e) => e.method === "cancel").map((e) => e.profile),
      ["standard", "focused"],
    );
    const bad = structuredClone(handles[0]);
    delete bad.data.executionBinding;
    await assert.rejects(
      driver().observe(bad),
      /binding is missing|uses another adapter/,
    );
    config.execution.profiles.standard.harness.config.setting = "drift";
    await assert.rejects(driver().observe(handles[0]), /binding changed/);
    await assert.rejects(
      new LocalExecutionDriver(
        target.checkout,
        join(root, "worktrees"),
        undefined,
        2,
        new LocalContentStore(join(root, "content")),
        "profiles",
        new Map(),
      ).preflight(graph),
      /unavailable/,
    );
  }));

for (const strategy of ["regular", "native-stack"])
  test(`installed profile composition runs ${strategy} through ordinary validation, delivery and final acceptance`, async () =>
    fixture(async (root, target) => {
      const config = configFor(target);
      config.delivery.kind = strategy;
      if (strategy === "native-stack")
        config.execution.profiles.focused.harness.adapter = "other-fixture@1";
      const events = [];
      const seen = [];
      const graph = {
        objective: 1,
        baseSha: target.baseSha,
        items: [
          item("one"),
          item("two", strategy === "native-stack" ? ["one"] : [], "focused"),
          item(
            "joined",
            strategy === "native-stack" ? ["two"] : ["one", "two"],
            "focused",
          ),
        ],
      };
      const github = new StatefulGitHubFake(
        join(root, "github"),
        target.checkout,
        body,
      );
      const project = github.projectGraph.bind(github);
      let projected;
      github.projectGraph = async (request) => {
        projected = structuredClone(request.graph);
        return project(request);
      };
      const registrations = Object.fromEntries(
        Object.entries(config.execution.profiles).map(([id, p]) => [
          id,
          {
            identity: p.harness.adapter,
            config: p.harness.config,
            harness: harnessFor(id, events),
          },
        ]),
      );
      const options = { github, planningModel: modelFor(graph, seen) };
      const app = composeWithLocalProfiles(config, registrations, options);
      const plan = await app.planObjective(1);
      assert.equal(events.length, 0);
      const missing = composeWithLocalProfiles(
        config,
        { standard: registrations.standard },
        options,
      );
      await assert.rejects(missing.runObjective(1), /focused.*unavailable/);
      assert.equal(events.length, 0);
      assert.equal(projected, undefined);
      const state = await app.runObjective(1);
      assert.equal(state.finalValidation?.passed, true, JSON.stringify(state));
      assert.equal(state.work.joined.status, "done");
      assert.equal(projected.items[0].executionProfile.id, "standard");
      const starts = events.filter((event) => event.method === "start");
      // Independent async preparations may finish in either order; the join waits.
      assert.equal(starts.at(-1).item, "joined");
      assert.deepEqual(
        starts
          .map((event) => [event.item, event.profile])
          .sort(([a], [b]) => a.localeCompare(b)),
        [
          ["joined", "focused"],
          ["one", "standard"],
          ["two", "focused"],
        ],
      );
      const joinedBase = events.find((e) => e.item === "joined").base;
      assert.equal(joinedBase, state.work.joined.executionBaseSha);
      if (strategy === "native-stack")
        assert.equal(joinedBase, state.work.two.changeRef);
      else
        for (const id of ["one", "two"])
          git(
            target.checkout,
            "merge-base",
            "--is-ancestor",
            state.work[id].integratedSha,
            joinedBase,
          );
      const status = statusDocument(state, config.repository, 1, strategy);
      assert.equal(status.work[1].assignedExecution.id, "focused");
      if (strategy === "regular")
        assert.equal(status.work[1].actualExecution.id, "focused");
      else assert.equal(status.work[1].actualExecution, null);
      parseFactoryState(state, config.repository, 1);
      if (strategy !== "regular") return;
      const forged = structuredClone(state);
      forged.work.one.execution.data.request.item.executionProfile.id =
        "focused";
      assert.throws(
        () => parseFactoryState(forged, config.repository, 1),
        /differs from accepted graph/,
      );
    }));

test("SDK compile and independent review prompts carry profile choices and retain indexed schema assignments", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function () {
    return {
      id: "test",
      async runStreamed(prompt, options) {
        captured.push({ prompt, schema: options.outputSchema });
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                type: "agent_message",
                text:
                  captured.length === 1
                    ? JSON.stringify(
                        compilerResponse(prompt, [
                          {
                            executionProfile: {
                              id: "standard",
                              reason: "Suitable default",
                            },
                          },
                        ]),
                      )
                    : '{"findings":[]}',
              },
            };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
              },
            };
          })(),
        };
      },
    };
  };
  try {
    const choices = {
      defaultProfile: "standard",
      profiles: [
        {
          id: "standard",
          description: "General",
          selectionHints: ["low latency preference"],
          adapter: "codex-sdk",
          model: "selected-model",
          reasoningEffort: "low",
          digest: "b".repeat(64),
          constraints: { network: "off" },
        },
      ],
    };
    const sources = [{ path: "OBJECTIVE", content: body }];
    const model = new CodexPlanningModel(
      "/tmp",
      { model: "planner", reasoningEffort: "low" },
      { model: "reviewer", reasoningEffort: "low" },
    );
    const request = {
      objective: body,
      baseSha: "a".repeat(40),
      sources,
      executionProfiles: choices,
      controllerCapabilities: {},
      controllerCapabilitiesDigest: "c".repeat(64),
    };
    await model.generateStructured(
      compilerRequest({
        ...request,
      }),
    );
    await model.reviewGraph({
      ...request,
      graph: { objective: 1, baseSha: request.baseSha, items: [] },
      commands: [],
      finalCommands: [],
    });
    for (const { prompt } of captured)
      assert.match(prompt, /low latency preference/);
    assert.ok(
      captured[0].schema.properties.items.items.anyOf[0].required.includes(
        "executionProfile",
      ),
    );
    assert.deepEqual(
      captured[0].schema.properties.items.items.anyOf[0].properties
        .executionProfile.type,
      "object",
    );
    assert.deepEqual(
      captured[0].schema.properties.items.items.anyOf[0].properties
        .executionProfile.properties.id.enum,
      ["standard"],
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("usage preserves actual profile identity and unknown counters", () => {
  const report = summarizeDiagnosticUsage([
    {
      operation: "worker-usage",
      attemptId: "attempt",
      workerUsage: {
        type: "completed",
        invocationId: "invocation",
        providerAttempt: 1,
        role: "worker",
        phase: "implementation",
        profileId: "focused",
        adapter: "fixture@1",
        model: "model",
        reasoningEffort: "low",
        usage: {},
      },
    },
  ]);
  assert.match(JSON.stringify(report), /focused/);
  assert.equal(report.workerUsage.tokenTotals.inputTokens, undefined);
});

test("GitHub issue projection renders the accepted assignment and resolved binding", async () =>
  fixture(async (root, target) => {
    const config = configFor(target);
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [item("one")],
    };
    normalizeExecutionProfiles(graph, executionProfileChoices(config));
    const projection = projectionClient(config.repository);
    projection.issues.set(
      1,
      projection.issue(1, { body, labels: ["existing-objective-label"] }),
    );
    const client = new GitHubClient(
      new Octokit({
        request: {
          fetch: async (url, options) => {
            const path = new URL(url).pathname.slice(1);
            assert.match(
              path,
              /^(?:user|repos\/example\/profiles\/(?:labels|issues(?:\/[12](?:\/(?:labels|dependencies\/blocked_by|sub_issues|parent))?)?))$/,
            );
            assert.equal(options.headers["x-github-api-version"], "2026-03-10");
            const method = options.method ?? "GET";
            if (path === "user")
              return Response.json({ login: await projection.client.viewer() });
            if (
              method === "GET" &&
              (path.endsWith("/labels") ||
                path.endsWith("/issues") ||
                path.endsWith("/blocked_by") ||
                path.endsWith("/sub_issues"))
            )
              return Response.json(await projection.client.paginate(path));
            try {
              return Response.json(
                await projection.client.request(
                  method,
                  path,
                  options.body ? JSON.parse(options.body) : undefined,
                ),
              );
            } catch (error) {
              assert.ok(error instanceof GitHubRequestError);
              return Response.json(
                { message: "Not Found" },
                { status: error.status },
              );
            }
          },
        },
      }),
    );
    const gateway = new RealGitHubGateway(config.repository, {}, client);
    const projected = await gateway.projectGraph({ graph, objectiveIssue: 1 });
    const creation = projection.calls.find(
      (call) => call.method === "POST" && call.route.endsWith("/issues"),
    );
    const projectedBody = creation.body.body;
    const workIssue = projection.issues.get(projected.issueByItemId.one);
    assert.equal(workIssue.body, projectedBody);
    assert.equal(
      workIssue.repository_url,
      "https://api.github.com/repos/example/profiles",
    );
    assert.deepEqual(creation.body.labels, ["factory:work-item"]);
    assert.deepEqual(projection.issues.get(1).labels, [
      "existing-objective-label",
      "factory:objective",
    ]);
    assert.deepEqual(projection.hierarchy.get(1), [workIssue.number]);
    assert.deepEqual(
      projection.calls.find(
        (call) => call.method === "POST" && call.route.endsWith("/sub_issues"),
      ).body,
      { sub_issue_id: workIssue.id, replace_parent: false },
    );
    const mutations = projection.calls.filter(
      (call) => call.method !== "GET",
    ).length;
    await gateway.projectGraph({
      graph,
      objectiveIssue: 1,
      knownIssues: projected.issueByItemId,
    });
    assert.equal(
      projection.calls.filter((call) => call.method !== "GET").length,
      mutations,
    );
    assert.match(projectedBody, /## Assigned execution profile/);
    assert.ok(
      projectedBody.includes(JSON.stringify(graph.items[0].executionProfile)),
    );
    assert.ok(
      projectedBody.includes(JSON.stringify(graph.items[0].executionBinding)),
    );
    assert.doesNotMatch(projectedBody, /DO-NOT-SEND|privatePath/);
  }));
