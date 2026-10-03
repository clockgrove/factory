import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { linuxProcessIdentity } from "../dist/process.js";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { Octokit } from "@octokit/core";
import { createApplication } from "../dist/application.js";
import { applyPendingAmendment } from "../dist/graph-amendments.js";
import { runObjective, controlObjective } from "../dist/runner.js";
import { readContinuation } from "../dist/state-store.js";
import { GitHubClient, GitHubRequestError } from "../dist/github-client.js";
import { RealGitHubGateway, projectedIssueBody } from "../dist/github.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  compilerCitationChoices,
  objectiveCriteria,
} from "../dist/compiler.js";
import { aggregateAcceptance, coverageObligations } from "../dist/qa.js";
import { cancelObjective } from "../dist/runner.js";
import {
  acquireControllerLock,
  readState,
  releaseControllerLock,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { projectionClient } from "./support/projection-client.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
const node = (id) => ({
  kind: "work",
  children: [],
  id,
  title: id,
  goal: `Write ${id}.txt`,
  brief: `Write ${id}.txt`,
  acceptance: ["result.txt exists"],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
  inputSources: compilerCitationChoices([
    { path: "OBJECTIVE", content: body },
  ]).filter((entry) => entry.heading === "Acceptance"),
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

// Synthetic runtime bindings use real temporary Git; full raw actual state stays local.
async function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "factory-known-projection-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      "example/known-projection",
      "regular",
      2,
    );
    const graph = withCoverage(
      {
        coverageObligations: coverageObligations(body, objectiveCriteria(body)),
      },
      { objective: 1, baseSha: target.baseSha, items: [node("result")] },
    );
    const obligations = coverageObligations(body, objectiveCriteria(body));
    graph.coverage.forEach((entry, index) => {
      entry.source = obligations[index].source;
    });
    const candidate = structuredClone(graph);
    candidate.items.push({
      ...node("qa"),
      kind: "qa",
      ownedPaths: [],
      dependencies: ["result"],
      validation: [],
    });
    candidate.items.push({
      ...node("aggregate"),
      kind: "aggregate",
      children: ["result", "qa"],
      dependencies: ["result", "qa"],
      ownedPaths: [],
      validation: [],
      acceptance: aggregateAcceptance({ id: "aggregate" }),
    });
    candidate.coverage = candidate.coverage.map((entry) => ({
      ...entry,
      itemId: "qa",
      proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
    }));
    const authority = {
      schemaVersion: 1,
      actor: "fixture",
      reason: "Bounded cancellation",
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
    const bound = {
      schemaVersion: 1,
      repository: config.repository,
      objective: 1,
      configDigest: factoryConfigDigest(config),
      graphDigest: graphDigest(graph),
      prerequisitesDigest: digest("null"),
      authority,
    };
    const state = {
      schemaVersion: 4,
      repository: config.repository,
      objective: 1,
      runId: "synthetic-partial-run",
      configDigest: factoryConfigDigest(config),
      baseSha: target.baseSha,
      graph,
      issueByItemId: { result: 2 },
      objectiveBodyDigest: digest(body),
      admission: { ...bound, digest: digest(JSON.stringify(bound)) },
      graphRevisions: [
        { graph: structuredClone(graph), digest: graphDigest(graph) },
      ],
      allowanceConsumption: {
        planningRevisions: 1,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
      pendingAmendment: {
        id: "preserved-amendment",
        phase: "rejected",
        rejectionStage: "projection",
        graph: candidate,
        reviewDigest: "b".repeat(64),
        issueByItemId: { result: 2, qa: 3, aggregate: 4 },
        error: "GitHub request failed (HTTP 422)",
        proposal: {
          scope: "in-scope",
          reason: "Independent joined QA",
          evidence: ["Required integrated proof"],
          ownership: ["QA and aggregate"],
          acceptance: ["Read-only integrated result"],
          dependencies: ["result"],
          actor: "fixture",
          expectedGraphDigest: graphDigest(graph),
        },
      },
      coordinator: {
        mode: "paused",
        phase: "waiting",
        phaseStartedAt: "2026-01-01T00:00:00Z",
        processes: [],
        waitReason: "Original projection failure",
      },
      work: {
        result: {
          status: "failed",
          step: "validate",
          attempt: "original-attempt",
          error: "Original condition failed; usage unavailable",
        },
      },
      error: "Original projection failure",
    };
    const remote = projectionClient(config.repository);
    remote.issues.set(
      1,
      remote.issue(1, { body, labels: ["factory:objective"] }),
    );
    for (const item of candidate.items)
      remote.issues.set(
        state.pendingAmendment.issueByItemId[item.id],
        remote.issue(state.pendingAmendment.issueByItemId[item.id], {
          body: projectedIssueBody(item, 1),
          title: item.title,
          labels: ["factory:work-item"],
        }),
      );
    remote.deps.set(3, [2]);
    remote.deps.set(4, [2, 3]);
    remote.hierarchy.set(1, [2, 4]);
    const gateway = new RealGitHubGateway(
      config.repository,
      undefined,
      remote.client,
    );
    const driver = new Proxy(
      {},
      {
        get() {
          throw Error("No execution driver calls allowed");
        },
      },
    );
    const path = statePath(config.repository, 1);
    saveState(path, state);
    assert.deepEqual(readState(config.repository, 1), state);
    await callback({ root, config, state, path, remote, gateway, driver });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("stopped known partial projection cancels without accepting, replaying or changing retained history", async () => {
  await fixture(async ({ config, state, path, remote, gateway, driver }) => {
    assert.equal(
      await cancelObjective(config, 1, driver, undefined, gateway),
      "cancelled",
    );
    const actual = readState(config.repository, 1);
    assert.equal(actual.cancelRequested, true);
    assert.ok(actual.cancelledAt);
    const { cancelRequested, cancelledAt, work, ...retained } = actual;
    const { work: originalWork, ...original } = state;
    assert.deepEqual(retained, original);
    assert.deepEqual(
      { ...work.result, status: "failed", completedAt: undefined },
      { ...originalWork.result, completedAt: undefined },
    );
    assert.equal(actual.finalAcceptance, undefined);
    assert.equal(actual.pendingAmendment.phase, "rejected");
    assert.ok(remote.calls.every((call) => call.method === "GET"));
    const frozen = readFileSync(path);
    assert.equal(
      await cancelObjective(config, 1, driver, undefined, gateway),
      "cancelled",
    );
    assert.deepEqual(readFileSync(path), frozen);
  });
});

for (const mode of [
  "legacy-projecting",
  "unknown-create",
  "compiling",
  "reviewing",
  "planning-submitted",
  "pending-merge",
  "closure-pending",
  "config-mismatch",
  "nonlocal",
  "changed-known-id",
  "bad-id",
  "extra-id",
  "bad-review",
  "live-subprocess",
  "missing-issue",
  "missing-parent-field",
  "unknown-hierarchy-child",
  "duplicate-dependency",
  "missing-id",
  "duplicate-id",
  "foreign-issue",
  "body",
  "title",
  "role",
  "closure",
  "dependencies",
  "parent",
  "missing-old-parent",
  "duplicate-child",
  "unknown-review",
  "unknown-publication",
  "active-work",
  "execution-handle",
  "stale-source",
  "stale-review",
  "missing-gateway",
  "parent-forbidden",
  "parent-server-error",
])
  test(`stopped projection refuses ${mode} before saving cancellation intent`, async () => {
    await fixture(
      async ({ root, config, state, path, remote, gateway, driver }) => {
        const p = state.pendingAmendment;
        if (mode === "legacy-projecting") {
          p.phase = "projecting";
          delete p.rejectionStage;
        }
        if (mode === "unknown-create") {
          p.phase = "projecting";
          delete p.rejectionStage;
          p.projectionPending = "qa";
          delete p.issueByItemId.qa;
        }
        if (["compiling", "reviewing"].includes(mode)) p.phase = mode;
        if (mode === "planning-submitted")
          state.planningRecovery = { phase: "submitted", history: [] };
        if (mode === "pending-merge")
          state.stackMerges = {
            result: {
              topPullRequest: 10,
              uuid: "incomplete-merge",
              expectedHeadSha: state.baseSha,
            },
          };
        if (mode === "closure-pending")
          state.work.result.githubClosure = "pending";
        if (mode === "config-mismatch") config.execution.concurrency = 1;
        if (mode === "nonlocal") config.execution.kind = "managed";
        if (mode === "changed-known-id") {
          p.issueByItemId.result = 7;
          remote.issues.set(
            7,
            remote.issue(7, {
              title: "result",
              body: projectedIssueBody(p.graph.items[0], 1),
              labels: ["factory:work-item"],
            }),
          );
        }
        if (mode === "bad-id") p.issueByItemId.qa = 0;
        if (mode === "extra-id") p.issueByItemId.unknown = 7;
        if (mode === "bad-review") p.reviewDigest = "malformed";
        if (mode === "live-subprocess")
          state.coordinator.processes = [
            {
              pid: process.pid,
              startTime: linuxProcessIdentity(process.pid).startTime,
            },
          ];
        if (mode === "missing-issue") remote.issues.delete(3);
        if (mode === "unknown-hierarchy-child") {
          remote.issues.set(99, remote.issue(99));
          remote.hierarchy.set(1, [2, 4, 99]);
        }
        if (mode === "duplicate-dependency") remote.deps.set(4, [2, 3, 3]);
        if (mode === "missing-parent-field") {
          const request = remote.client.request;
          remote.client.request = async (method, route, ...rest) =>
            route.endsWith("/parent") ? {} : request(method, route, ...rest);
        }
        if (mode === "missing-id") delete p.issueByItemId.qa;
        if (mode === "duplicate-id") p.issueByItemId.qa = 2;
        if (mode === "foreign-issue")
          remote.issues.get(2).repository_url =
            "https://api.github.com/repos/foreign/repo";
        if (mode === "body") remote.issues.get(2).body += "Unreviewed change";
        if (mode === "title") remote.issues.get(2).title = "Unreviewed";
        if (mode === "role") remote.issues.get(2).labels = [];
        if (mode === "closure") remote.issues.get(2).state = "closed";
        if (mode === "dependencies") remote.deps.set(2, [3]);
        if (mode === "parent") {
          remote.issues.set(99, remote.issue(99));
          remote.hierarchy.set(1, [4]);
          remote.hierarchy.set(99, [2]);
        }
        if (mode === "missing-old-parent") remote.hierarchy.set(1, [4]);
        if (mode === "duplicate-child") remote.hierarchy.set(4, [2]);
        if (mode === "unknown-review")
          state.coordinator.phase = "objective-review-submitted";
        if (mode === "unknown-publication")
          state.work.result.pendingEffect = "publication";
        if (mode === "active-work") state.work.result.status = "running";
        if (mode === "execution-handle")
          state.work.result.execution = {
            provider: "local",
            identity: "attempt",
            data: {
              worktree: join(
                root,
                "state",
                "clockgrove-factory",
                "repositories",
                config.repository,
                "worktrees",
                "attempt",
              ),
            },
          };
        if (mode === "stale-source")
          remote.issues.get(1).body += "Source changed";
        if (mode === "stale-review") delete p.reviewDigest;
        if (mode.startsWith("parent-")) {
          const request = remote.client.request;
          remote.client.request = async (method, route, ...rest) => {
            if (route.endsWith("/parent"))
              throw new GitHubRequestError(
                mode === "parent-forbidden" ? 403 : 500,
              );
            return request(method, route, ...rest);
          };
        }
        saveState(path, state);
        const before = readFileSync(path);
        await assert.rejects(
          cancelObjective(
            config,
            1,
            driver,
            undefined,
            mode === "missing-gateway" ? undefined : gateway,
          ),
        );
        assert.deepEqual(readFileSync(path), before);
        assert.ok(remote.calls.every((call) => call.method === "GET"));
      },
    );
  });

test("live stopped-mutation owner prevents projection cancellation", async () => {
  await fixture(async ({ config, path, gateway, driver }) => {
    const lockPath = join(stateRoot(config.repository), "controller.lock");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    // Existing lock ownership supplies a live identity; cancellation cannot borrow a foreign Objective.
    const lock = acquireControllerLock(lockPath, 2);
    try {
      const before = readFileSync(path);
      await assert.rejects(
        cancelObjective(config, 1, driver, undefined, gateway),
        /Controller is running|owns|lock|owner/i,
      );
      assert.deepEqual(readFileSync(path), before);
    } finally {
      releaseControllerLock(lockPath, lock);
      child.kill();
      await exited;
    }
  });
});

test("complete public partial projection reconciles all five identities using GETs only", async () => {
  const input = JSON.parse(
    readFileSync(
      new URL("./fixtures/projection-reparent.json", import.meta.url),
      "utf8",
    ),
  );
  const remote = projectionClient(input.repository, input.issues);
  remote.hierarchy.set(1, [4, 5, 6, 9]);
  for (const item of input.graph.items)
    remote.deps.set(
      input.knownIssues[item.id],
      item.dependencies.map((id) => input.knownIssues[id]),
    );
  const gateway = new RealGitHubGateway(
    input.repository,
    undefined,
    remote.client,
  );
  await gateway.reconcileGraphProjection({
    ...input,
    objectiveIssue: 1,
    objectiveBodyDigest: digest(remote.issues.get(1).body),
  });
  assert.ok(remote.calls.every((call) => call.method === "GET"));
});

// Real transport classification drives durable lifecycle; retained message text never supplies certainty.
for (const producer of ["initial", "amendment"])
  for (const effect of producer === "initial"
    ? [
        "labels",
        "body",
        "dependency",
        "dependency-mid",
        "parent",
        "create",
        "partial-create",
      ]
    : ["body", "dependency", "dependency-mid", "parent", "create"])
    for (const outcome of ["rejected", "lost"])
      test(`${producer}: ${effect} ${outcome} response crosses producer/persist/restart/cancel coherently`, async () => {
        await fixture(async ({ root, config, state, path, remote }) => {
          const pending = state.pendingAmendment;
          pending.phase = "reviewed";
          delete pending.rejectionStage;
          delete pending.error;
          state.coordinator.mode = "running";
          if (effect === "body" && producer === "amendment") {
            state.work.result = { status: "pending" };
            pending.graph.items[0].brief =
              "Reviewed updated public result brief";
          }
          if (producer === "initial") {
            for (const number of [2, 3, 4]) remote.issues.delete(number);
            remote.deps.clear();
            remote.hierarchy.clear();
            if (["body", "labels"].includes(effect))
              remote.issues.get(1).labels = [];
            if (effect === "labels") remote.labels.length = 0;
          } else {
            if (["dependency", "dependency-mid"].includes(effect))
              remote.deps.set(4, []);
            if (effect === "create") {
              remote.issues.delete(3);
              delete pending.issueByItemId.qa;
              remote.deps.clear();
            }
          }
          let submitted = false;
          let targetCount = 0;
          const client = new GitHubClient(
            new Octokit({
              request: {
                fetch: async (url, options) => {
                  assert.equal(
                    options.headers["x-github-api-version"],
                    "2026-03-10",
                  );
                  const u = new URL(url);
                  const route = u.pathname.slice(1);
                  if (route === `repos/${config.repository}`)
                    return new Response(
                      JSON.stringify({ default_branch: "main" }),
                      {
                        status: 200,
                        headers: { "content-type": "application/json" },
                      },
                    );
                  const targeted =
                    options.method !== "GET" &&
                    (effect === "labels"
                      ? route.endsWith("/labels") && !route.includes("/issues/")
                      : effect === "body"
                        ? producer === "initial"
                          ? route.endsWith("/issues/1/labels")
                          : options.method === "PATCH" &&
                            route.endsWith("/issues/2")
                        : ["dependency", "dependency-mid"].includes(effect)
                          ? route.endsWith("/issues/4/dependencies/blocked_by")
                          : effect === "parent"
                            ? route.endsWith("/sub_issues")
                            : route.endsWith("/issues"));
                  if (targeted) targetCount++;
                  if (
                    targeted &&
                    !submitted &&
                    (!["dependency-mid", "partial-create"].includes(effect) ||
                      targetCount === 2)
                  ) {
                    submitted = true;
                    const observed = readContinuation(config.repository, 1);
                    assert.equal(
                      producer === "initial"
                        ? observed.projection
                        : observed.pendingAmendment.phase,
                      producer === "initial" ? "submitted" : "projecting",
                    );
                    if (outcome === "lost")
                      throw Error(
                        "Simulated response loss after known mutation submission",
                      );
                    return new Response(
                      JSON.stringify({
                        message: "Acknowledged public fixture rejection",
                      }),
                      {
                        status: 422,
                        headers: { "content-type": "application/json" },
                      },
                    );
                  }
                  try {
                    const data =
                      options.method === "GET" &&
                      (/\/(labels|sub_issues|blocked_by)$/.test(route) ||
                        route.endsWith("/issues"))
                        ? await remote.client.paginate(route)
                        : await remote.client.request(
                            options.method,
                            route,
                            options.body ? JSON.parse(options.body) : undefined,
                          );
                    return new Response(JSON.stringify(data), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    });
                  } catch (error) {
                    if (!(error instanceof GitHubRequestError)) throw error;
                    return new Response(
                      JSON.stringify({ message: "Documented parent absence" }),
                      {
                        status: error.status,
                        headers: { "content-type": "application/json" },
                      },
                    );
                  }
                },
              },
            }),
          );
          const github = new RealGitHubGateway(
            config.repository,
            undefined,
            client,
          );
          const driver = {
            async preflight() {},
            async availableSlots() {
              throw Error("No dispatch permitted");
            },
            async start() {
              throw Error("No dispatch permitted");
            },
          };
          const graph = structuredClone(pending.graph);
          if (producer === "initial") {
            rmSync(path);
            const planningModel = {
              async generateStructured(request) {
                return withCoverage(request, graph);
              },
              async reviewGraph(request) {
                return { packetId: request.reviewPacket.id, findings: [] };
              },
            };
            const prepared = makeApplication({
              config,
              fakeRoot: join(root, "planning"),
              objectiveBody: body,
              planningModel,
              graph,
              actions: {},
            });
            const application = createApplication(config, {
              planningModel,
              driver,
              github,
              contentStore: prepared.contentStore,
              delivery: {},
            });
            const plan = await application.planObjective(1);
            // This is a fresh supported run, not a hand-built completed-rejection snapshot.
            await assert.rejects(application.runObjective(1, plan), /GitHub/);
          } else {
            saveState(path, state);
            await assert.rejects(
              applyPendingAmendment({
                state,
                config,
                body,
                github,
                model: {},
                save() {
                  saveState(path, state);
                },
                cancelled: () => false,
              }),
              /GitHub/,
            );
          }
          assert.equal(submitted, true);
          const observed = readContinuation(config.repository, 1);
          assert.equal(
            producer === "initial"
              ? observed.projection
              : observed.pendingAmendment.phase,
            outcome === "rejected"
              ? "rejected"
              : producer === "initial"
                ? "submitted"
                : "projecting",
          );
          const frozen = readFileSync(path);
          const requests = remote.calls.length;
          if (outcome === "lost") {
            await assert.rejects(
              cancelObjective(config, 1, driver, undefined, github),
              /Submitted|unknown/,
            );
            assert.deepEqual(readFileSync(path), frozen);
            assert.equal(remote.calls.length, requests);
            await assert.rejects(
              runObjective(config, 1, { driver, github }),
              /cannot be replayed|unknown/,
            );
            assert.deepEqual(readFileSync(path), frozen);
            await assert.rejects(
              controlObjective(config, { objective: 1, action: "resume" }),
              /cannot be resumed/,
            );
            assert.deepEqual(readFileSync(path), frozen);
            const abandonment = {
              kind: "abandon-permanently",
              repository: config.repository,
              objective: 1,
              runId: observed.runId,
              configDigest: observed.configDigest,
              snapshotDigest: digest(frozen),
              actor: "fixture operator",
              reason:
                "Permanently abandon this stopped synchronous graph call without settling its outcome",
              cessation: {
                kind: "operator-verified-local-cessation",
                verifiedAt: new Date().toISOString(),
                basis:
                  "All fixture controller, worker, model and subprocess activity ceased; this is the captured synchronous GitHub response-loss boundary",
                workers: "ceased",
                subprocesses: "ceased",
                models: "ceased",
                unknownOwnedResources: false,
              },
            };
            if (effect === "body") {
              const negatives =
                producer === "initial"
                  ? [
                      (snapshot) => {
                        snapshot.coordinator.phase = "planning-submitted";
                      },
                      (snapshot) => {
                        snapshot.plan.sources[0].content +=
                          "Changed retained source";
                      },
                      (snapshot) => {
                        snapshot.sourcePacketDigest = "f".repeat(64);
                      },
                    ]
                  : [
                      (snapshot) => {
                        snapshot.work.result.pendingEffect = "review";
                      },
                      (snapshot) => {
                        snapshot.coordinator.phase =
                          "objective-review-submitted";
                      },
                      (snapshot) => {
                        snapshot.pendingAmendment.issueByItemId.result = 999;
                      },
                      (snapshot) => {
                        delete snapshot.pendingAmendment.reviewDigest;
                      },
                    ];
              for (const alter of negatives) {
                const negative = structuredClone(observed);
                alter(negative);
                saveState(path, negative);
                const refused = readFileSync(path);
                await assert.rejects(
                  cancelObjective(
                    config,
                    1,
                    driver,
                    { ...abandonment, snapshotDigest: digest(refused) },
                    github,
                  ),
                  /outside permanent abandonment|source binding|candidate differs|reviewed graph|known issue binding/,
                );
                assert.deepEqual(readFileSync(path), refused);
                assert.equal(remote.calls.length, requests);
              }
              saveState(path, observed);
              assert.deepEqual(readFileSync(path), frozen);
            }
            assert.equal(
              await cancelObjective(config, 1, driver, abandonment, github),
              "cancelled",
            );
            const abandoned = readContinuation(config.repository, 1);
            const {
              permanentAbandonment,
              cancelRequested,
              cancelledAt,
              ...history
            } = abandoned;
            assert.deepEqual(history, observed);
            assert.equal(permanentAbandonment.effect, "graph-projection");
            assert.equal(cancelRequested, true);
            assert.equal(cancelledAt, permanentAbandonment.at);
            assert.equal(remote.calls.length, requests);
            if (producer === "amendment") {
              const { sealFinalAcceptance } = await import(
                "../dist/completion.js"
              );
              assert.throws(
                () => sealFinalAcceptance(abandoned),
                /permanently abandoned/,
              );
              await assert.rejects(
                applyPendingAmendment({
                  state: abandoned,
                  config,
                  body,
                  github,
                  model: {},
                  save() {
                    throw Error("No terminal write");
                  },
                  cancelled: () => false,
                }),
                /permanently abandoned/,
              );
            }
            const { checkServiceState } = await import(
              "../dist/supervision.js"
            );
            assert.throws(
              () => checkServiceState(config, 1),
              /permanently abandoned/,
            );
            const terminal = readFileSync(path);
            await assert.rejects(
              runObjective(config, 1, { driver, github }),
              /permanently abandoned/,
            );
            await assert.rejects(
              controlObjective(config, { objective: 1, action: "resume" }),
              /permanently abandoned/,
            );
            assert.equal(
              await cancelObjective(config, 1, driver, undefined, github),
              "cancelled",
            );
            assert.deepEqual(readFileSync(path), terminal);
            assert.equal(remote.calls.length, requests);
          } else {
            assert.equal(
              await cancelObjective(config, 1, driver, undefined, github),
              "cancelled",
            );
            const after = readContinuation(config.repository, 1);
            assert.ok(after.cancelledAt);
            assert.equal(after.finalAcceptance, undefined);
            assert.deepEqual(
              producer === "initial" ? after.plan : after.pendingAmendment,
              producer === "initial"
                ? observed.plan
                : observed.pendingAmendment,
            );
            assert.ok(
              remote.calls
                .slice(requests)
                .every((call) => call.method === "GET"),
            );
          }
        });
      });

for (const producer of ["initial", "amendment"])
  test(`${producer}: interrupted submitted projection refuses before intent and never-dispatched projection cancels`, async () => {
    await fixture(async ({ config, state, path, gateway, driver }) => {
      let snapshot;
      if (producer === "initial")
        snapshot = {
          schemaVersion: 5,
          kind: "preparing",
          repository: config.repository,
          objective: 1,
          runId: "synthetic-interrupted",
          configDigest: factoryConfigDigest(config),
          baseSha: state.baseSha,
          objectiveBodyDigest: digest(body),
          planning: "ready",
          projection: "ready",
          issueByItemId: {},
          coordinator: state.coordinator,
        };
      else {
        snapshot = state;
        snapshot.pendingAmendment.phase = "reviewed";
        delete snapshot.pendingAmendment.rejectionStage;
      }
      saveState(path, snapshot);
      const ready = readFileSync(path);
      if (producer === "initial") {
        snapshot.planning = "complete";
        snapshot.projection = "submitted";
        snapshot.plan = { graph: state.pendingAmendment.graph };
      } else snapshot.pendingAmendment.phase = "projecting";
      saveState(path, snapshot);
      const submitted = readFileSync(path);
      await assert.rejects(
        cancelObjective(config, 1, driver, undefined, gateway),
        /Submitted|unknown/,
      );
      assert.deepEqual(readFileSync(path), submitted);
      // Restore only this synthetic never-dispatched test fixture, not a historical/live snapshot.
      writeFileSync(path, ready);
      assert.equal(
        await cancelObjective(config, 1, driver, undefined, gateway),
        "cancelled",
      );
    });
  });

// A retained common edge cannot be mistaken for an intermediate new dependency.
test("settled readback refuses a removed common dependency before any mutation", async () => {
  await fixture(async ({ state, remote, gateway }) => {
    const candidate = state.pendingAmendment.graph;
    remote.deps.set(4, [2]);
    await assert.rejects(
      gateway.reconcileGraphProjection({
        graph: candidate,
        previousGraph: structuredClone(candidate),
        objectiveIssue: 1,
        objectiveBodyDigest: digest(body),
        knownIssues: state.pendingAmendment.issueByItemId,
      }),
      /dependency/,
    );
    assert.ok(remote.calls.every((call) => call.method === "GET"));
  });
});

for (const invalid of [
  "missing-outcome",
  "planning-projection-conflict",
  "ready-map",
  "unknown-item",
  "duplicate",
  "incomplete-projected",
  "settled-create",
]) {
  test(`preparation decoder refuses ${invalid} without changing snapshot`, async () => {
    await fixture(async ({ config, state, path }) => {
      const snapshot = {
        schemaVersion: 5,
        kind: "preparing",
        repository: config.repository,
        objective: 1,
        runId: "synthetic-decoder",
        configDigest: factoryConfigDigest(config),
        baseSha: state.baseSha,
        objectiveBodyDigest: digest(body),
        planning: "complete",
        projection: "rejected",
        issueByItemId: { result: 2 },
        plan: { graph: state.pendingAmendment.graph },
        coordinator: state.coordinator,
      };
      if (invalid === "missing-outcome") delete snapshot.projection;
      if (invalid === "planning-projection-conflict")
        snapshot.planning = "submitted";
      if (invalid === "ready-map") snapshot.projection = "ready";
      if (invalid === "unknown-item") snapshot.issueByItemId.foreign = 8;
      if (invalid === "duplicate") snapshot.issueByItemId.qa = 2;
      if (invalid === "incomplete-projected") snapshot.projection = "projected";
      if (invalid === "settled-create") snapshot.projectionPending = "qa";
      saveState(path, snapshot);
      const frozen = readFileSync(path);
      assert.throws(
        () => readContinuation(config.repository, 1),
        /Invalid preparation snapshot/,
      );
      assert.deepEqual(readFileSync(path), frozen);
    });
  });
}
