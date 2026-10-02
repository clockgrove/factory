import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { linuxProcessIdentity } from "../dist/process.js";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { GitHubRequestError } from "../dist/github-client.js";
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
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";
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
        phase: "projecting",
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
    assert.equal(actual.pendingAmendment.phase, "projecting");
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
        if (mode === "unknown-create") {
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
        if (mode === "dependencies") remote.deps.set(4, [2]);
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
