import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient, GitHubOutcomeUnknown } from "../dist/github-client.js";
import { withProcessCancellation } from "../dist/process.js";
import { controlObjective } from "../dist/runner.js";
import { intakeControl } from "../dist/intake.js";
import {
  readContinuation,
  readControllerOwner,
  readState,
} from "../dist/state-store.js";
import { stateRoot } from "../dist/config.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
const item = {
  id: "result",
  title: "Result",
  kind: "work",
  goal: "Write result.txt",
  brief: "Write result.txt",
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
const authority = {
  schemaVersion: 1,
  actor: "fixture",
  reason: "Finite credential-free CI readiness regression",
  executionConsent: true,
  serviceConsent: true,
  objectives: [1],
  allowances: {
    planningRevisions: 0,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
  resources: { maxConcurrency: 1 },
  requiredEnvironment: [],
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 800; n++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Fixture condition not reached");
}
async function fixture(route, name, run, chain = false) {
  const root = mkdtempSync(join(tmpdir(), "factory-ci-wait-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  let active;
  try {
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      `example/ci-${route}-${name}`,
      route,
      1,
    );
    const setup = makeApplication({
      config,
      graph: {
        objective: 1,
        baseSha: target.baseSha,
        items: chain
          ? [
              item,
              {
                ...item,
                id: "next",
                title: "Next",
                goal: "Write next.txt",
                brief: "Write next.txt",
                acceptance: ["next.txt exists"],
                ownedPaths: ["next.txt"],
                dependencies: ["result"],
                validation: [
                  {
                    command: "test -s next.txt",
                    provenance: "source-declared",
                    source: "OBJECTIVE",
                  },
                ],
              },
            ]
          : [item],
      },
      objectiveBody: chain ? body + "- test -s next.txt\n" : body,
      fakeRoot: join(root, "fake"),
      actions: {
        result: { files: [{ path: "result.txt", text: "done\n" }] },
        ...(chain
          ? { next: { files: [{ path: "next.txt", text: "done\n" }] } }
          : {}),
      },
    });
    const { github } = setup;
    const publish = github.publish.bind(github);
    github.publish = async (request) => {
      const result = await publish(request);
      github.update((state) => {
        state.pullRequests[result.number].checks = "pending";
      });
      return result;
    };
    let observations = 0,
      merges = 0;
    const observe = github.observe.bind(github);
    github.observe = async (identity) => {
      observations++;
      return observe(identity);
    };
    const merge = github.merge.bind(github);
    github.merge = async (...args) => {
      const work = readState(config.repository, 1).work.result;
      assert.equal(work.pendingEffect, "merge");
      merges++;
      return merge(...args);
    };
    const mergeStack = github.mergeNativeStack.bind(github);
    github.mergeNativeStack = async (...args) => {
      merges++;
      return mergeStack(...args);
    };
    const ready = () =>
      github.update((state) => {
        for (const pull of Object.values(state.pullRequests))
          pull.checks = "passing";
      });
    await run({
      ...setup,
      config,
      root,
      ready,
      counts: () => ({ observations, merges }),
      track: (promise) => {
        active = promise;
        void promise.catch(() => {});
        return promise;
      },
    });
  } finally {
    if (
      active &&
      readControllerOwner(
        join(stateRoot(`example/ci-${route}-${name}`), "controller.lock"),
      )
    ) {
      await controlObjective(
        { repository: `example/ci-${route}-${name}` },
        { objective: 1, action: "cancel" },
      ).catch(() => {});
      await active.catch(() => {});
    }
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
const identityOf = (state) => ({
  runId: state.runId,
  attempt: state.work.result.attempt,
  pullRequest: state.work.result.pullRequest,
  head: state.work.result.changeRef,
  tree: state.work.result.treeSha,
});
function assertWait(state) {
  assert.equal(state.work.result.status, "published");
  assert.equal(state.work.result.pendingEffect, undefined);
  assert.match(state.work.result.waitingReason, /Awaiting/);
  assert.equal(state.work.result.recovery, undefined);
  assert.equal(state.error, undefined);
  assert.equal(state.finalValidation, undefined);
}
for (const route of ["regular", "native-stack"]) {
  test(`${route}: explicit pending CI returns a resumable exact publication without another worker/review`, async () =>
    fixture(route, "explicit", async (f) => {
      const plan = await f.application.planObjective(1);
      const waiting = await f.application.runObjective(1, plan);
      assertWait(waiting);
      assert.equal(f.counts().merges, 0);
      const identity = identityOf(waiting);
      const starts = readEvents(f.eventsPath).filter(
        (event) => event.type === "start",
      ).length;
      const reviews = readEvents(f.planningPath).filter(
        (event) => event.type === "result-review",
      ).length;
      assert.equal(reviews, 1);
      f.ready();
      const result = await f.application.runObjective(1, plan);
      assert.deepEqual(identityOf(result), identity);
      assert.equal(result.finalValidation.passed, true);
      assert.equal(f.counts().merges, 1);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        starts,
      );
      assert.equal(
        readEvents(f.planningPath).filter(
          (event) => event.type === "result-review",
        ).length,
        reviews + 1,
      ); // final Objective review only
    }));
  test(`${route}: admitted owner pauses read-only wait and observes success automatically`, async () =>
    fixture(route, "admitted", async (f) => {
      const plan = await f.application.planObjective(1, [], authority);
      const admission = await f.application.admitObjective(1, plan, authority);
      const running = f.track(f.application.runObjective(1, plan, admission));
      await until(
        () =>
          readContinuation(f.config.repository, 1)?.work?.result?.waitingReason,
      );
      const waiting = readState(f.config.repository, 1);
      assertWait(waiting);
      const identity = identityOf(waiting);
      await controlObjective(f.config, { objective: 1, action: "pause" });
      const before = f.counts();
      await delay(100);
      assert.deepEqual(f.counts(), before);
      await controlObjective(f.config, { objective: 1, action: "resume" });
      await until(() => f.counts().observations > before.observations);
      f.ready(); // no resume needed after readiness changes
      const result = await running;
      assert.deepEqual(identityOf(result), identity);
      assert.equal(result.finalValidation.passed, true);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
      assert.equal(f.counts().merges, 1);
    }));
  test(`${route}: known pending wait can hand off and restart without replay`, async () =>
    fixture(route, "handoff", async (f) => {
      const plan = await f.application.planObjective(1, [], authority);
      const admission = await f.application.admitObjective(1, plan, authority);
      const running = f.track(f.application.runObjective(1, plan, admission));
      const handed = assert.rejects(
        running,
        (error) => error.constructor.name === "CoordinatorHandoff",
      );
      await until(
        () =>
          readContinuation(f.config.repository, 1)?.work?.result?.waitingReason,
      );
      const identity = identityOf(readState(f.config.repository, 1));
      await controlObjective(f.config, { objective: 1, action: "handoff" });
      await handed;
      assert.equal(
        readControllerOwner(
          join(stateRoot(f.config.repository), "controller.lock"),
        ),
        undefined,
      );
      assertWait(readState(f.config.repository, 1));
      assert.equal(f.counts().merges, 0);
      f.ready();
      await controlObjective(f.config, { objective: 1, action: "resume" });
      const result = await f.track(
        f.application.runObjective(1, plan, admission),
      );
      assert.deepEqual(identityOf(result), identity);
      assert.equal(result.finalValidation.passed, true);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
    }));
  test(`${route}: cancellation of known read-only wait submits no merge`, async () =>
    fixture(route, "cancel", async (f) => {
      const plan = await f.application.planObjective(1, [], authority);
      const admission = await f.application.admitObjective(1, plan, authority);
      const running = f.track(f.application.runObjective(1, plan, admission));
      const cancelled = assert.rejects(running, /cancellation requested/);
      await until(
        () =>
          readContinuation(f.config.repository, 1)?.work?.result?.waitingReason,
      );
      await controlObjective(f.config, { objective: 1, action: "cancel" });
      await cancelled;
      const state = readState(f.config.repository, 1);
      assert.ok(state.cancelledAt);
      assert.equal(state.work.result.pendingEffect, undefined);
      assert.equal(state.coordinator.cancelError, undefined);
      assert.equal(f.counts().merges, 0);
    }));
}

for (const route of ["regular", "native-stack"]) {
  test(`${route}: absent registered checks wait for protection readiness on the same result`, async () =>
    fixture(route, "registration", async (f) => {
      let readiness = "waiting";
      const observe = f.github.observe.bind(f.github);
      f.github.observe = async (identity) => ({
        ...(await observe(identity)),
        checks: "passing",
        mergeReadiness: readiness,
      });
      const plan = await f.application.planObjective(1);
      const waiting = await f.application.runObjective(1, plan);
      assertWait(waiting);
      assert.equal(f.counts().merges, 0);
      const identity = identityOf(waiting);
      readiness = "ready";
      const completed = await f.application.runObjective(1, plan);
      assert.deepEqual(identityOf(completed), identity);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
    }));
  test(`${route}: actual failed checks stop the retained result before merge submission`, async () =>
    fixture(route, "failing", async (f) => {
      const plan = await f.application.planObjective(1);
      const waiting = await f.application.runObjective(1, plan);
      const identity = identityOf(waiting);
      f.github.update((state) => {
        for (const pull of Object.values(state.pullRequests))
          pull.checks = "failing";
      });
      await assert.rejects(
        f.application.runObjective(1, plan),
        /not mergeable/,
      );
      const stopped = readState(f.config.repository, 1);
      assert.deepEqual(identityOf(stopped), identity);
      assert.equal(stopped.work.result.pendingEffect, undefined);
      assert.equal(f.counts().merges, 0);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
    }));
}

test("intake keeps its ordinary pending-CI Objective owned and finishes it when checks pass", async () =>
  fixture("regular", "intake", async (f) => {
    f.github.objective = async (number) => ({
      number,
      title: "Objective",
      body,
      state: f.github.state().closedIssues[number] ? "closed" : "open",
      labels: [],
    });
    f.github.intakePage = async (page) => ({
      status: 200,
      etag: '"current"',
      data: page === 1 ? [{ number: 1, state: "open", labels: [] }] : [],
    });
    f.github.objectiveDependencies = async () => [];
    await f.application.enqueueIntake(authority, { pollSeconds: 0.01 });
    const running = f.track(f.application.runIntake());
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.work?.result?.waitingReason,
    );
    assertWait(readState(f.config.repository, 1));
    f.ready();
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.objectiveClosure ===
        "complete",
    );
    await intakeControl(f.config, "drain");
    await running;
    assert.equal(
      readState(f.config.repository, 1).finalValidation.passed,
      true,
    );
    assert.equal(
      readEvents(f.eventsPath).filter((event) => event.type === "start").length,
      1,
    );
  }));

test("native multi-layer wait preserves every exact published layer and submits intent only at async merge", async () =>
  fixture(
    "native-stack",
    "chain",
    async (f) => {
      const plan = await f.application.planObjective(1);
      const waiting = await f.application.runObjective(1, plan);
      assert.equal(waiting.work.result.status, "published");
      assert.equal(waiting.work.next.status, "published");
      assert.equal(waiting.work.next.pendingEffect, undefined);
      assert.equal(waiting.error, undefined);
      assert.equal(f.counts().merges, 0);
      const identities = Object.fromEntries(
        Object.entries(waiting.work).map(([id, work]) => [
          id,
          { attempt: work.attempt, head: work.changeRef, pr: work.pullRequest },
        ]),
      );
      const ensureStack = f.github.ensureNativeStack.bind(f.github);
      f.github.ensureNativeStack = async (...args) => {
        assert.notEqual(
          readState(f.config.repository, 1).work.next.pendingEffect,
          "merge",
        );
        return ensureStack(...args);
      };
      const mergeStack = f.github.mergeNativeStack.bind(f.github);
      f.github.mergeNativeStack = async (...args) => {
        const beforeMerge = args[3].beforeMerge;
        args[3] = {
          ...args[3],
          beforeMerge: () => {
            beforeMerge();
            assert.equal(
              readState(f.config.repository, 1).work.next.pendingEffect,
              "merge",
            );
          },
        };
        return mergeStack(...args);
      };
      f.ready();
      const completed = await f.application.runObjective(1, plan);
      assert.equal(completed.finalValidation.passed, true);
      for (const [id, identity] of Object.entries(identities))
        assert.deepEqual(
          {
            attempt: completed.work[id].attempt,
            head: completed.work[id].changeRef,
            pr: completed.work[id].pullRequest,
          },
          identity,
        );
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        2,
      );
      assert.equal(f.counts().merges, 1);
    },
    true,
  ));

const head = "a".repeat(40);
const pr = {
  number: 1,
  headSha: head,
  branch: "factory/result",
  baseBranch: "main",
};
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
function observedGateway(status, checks = [], change = {}) {
  const client = new GitHubClient(
    new Octokit({
      request: {
        fetch: async (url, options) => {
          const path = new URL(url).pathname;
          if (path === "/graphql") {
            const body = JSON.parse(options.body);
            assert.match(body.query, /^query FactoryPullRequestReadiness/);
            assert.equal(body.query.includes("mutation"), false);
            assert.deepEqual(body.variables, {
              owner: "example",
              name: "target",
              number: 1,
            });
            return json({
              data: {
                repository: {
                  pullRequest: {
                    number: 1,
                    headRefOid: head,
                    headRefName: pr.branch,
                    baseRefName: "main",
                    mergeStateStatus: status,
                    ...change,
                  },
                },
              },
            });
          }
          if (path.endsWith("/pulls/1"))
            return json({
              number: 1,
              state: "open",
              merged: false,
              head: { sha: head, ref: pr.branch },
              base: { ref: "main" },
            });
          if (path.endsWith("/check-runs")) return json({ check_runs: checks });
          if (path.endsWith("/status"))
            return json({ state: "success", total_count: 0 });
          throw new Error("Unexpected credential-free transport request");
        },
      },
    }),
  );
  return new RealGitHubGateway("example/target", {}, client);
}
test("check registration waits on authenticated protection readiness while clean no-CI targets remain valid", async () => {
  for (const status of ["BLOCKED", "UNKNOWN"]) {
    const observation = await observedGateway(status).observe(pr);
    assert.equal(observation.checks, "passing");
    assert.equal(observation.mergeReadiness, "waiting");
    let merges = 0;
    const github = {
      defaultBranch: async () => "main",
      observe: async () => observation,
      merge: async () => {
        merges++;
      },
    };
    await assert.rejects(
      new RegularDelivery("unused", github).merge({
        pullRequest: 1,
        branch: pr.branch,
        headSha: head,
      }),
      (error) => error.constructor.name === "DeliveryReadinessPending",
    );
    assert.equal(merges, 0);
  }
  assert.equal(
    (await observedGateway("CLEAN").observe(pr)).mergeReadiness,
    "ready",
  );
  assert.equal(
    (await observedGateway("HAS_HOOKS").observe(pr)).mergeReadiness,
    "ready",
  );
  for (const status of ["DIRTY", "BEHIND", "DRAFT", "UNSTABLE"])
    assert.equal(
      (await observedGateway(status).observe(pr)).mergeReadiness,
      "blocked",
    );
  for (const change of [
    { number: 2 },
    { headRefOid: "b".repeat(40) },
    { headRefName: "changed" },
    { baseRefName: "changed" },
  ])
    await assert.rejects(
      observedGateway("CLEAN", [], change).observe(pr),
      /identity|unavailable/,
    );
  await assert.rejects(
    observedGateway("FUTURE_ENUM").observe(pr),
    /unsupported/,
  );
});

test("fixed read query shares REST rate gate, rejects partial data and never classifies read transport loss as a mutation", async () => {
  const calls = [];
  const client = new GitHubClient(
    new Octokit({
      request: {
        fetch: async (url) => {
          calls.push({ url: String(url), at: Date.now() });
          return String(url).endsWith("/graphql")
            ? json({
                errors: [{ message: "private information" }],
                data: { repository: { pullRequest: {} } },
              })
            : new Response("{}", {
                headers: {
                  "content-type": "application/json",
                  "retry-after": "0.06",
                },
              });
        },
      },
    }),
  );
  await client.request("GET", "repos/example/target/issues/1");
  await assert.rejects(
    client.pullRequestReadiness("example/target", 1),
    /unavailable/,
  );
  assert.ok(calls[1].at - calls[0].at >= 50);
  for (const data of [
    { data: null },
    { data: { repository: { pullRequest: null } } },
    { data: { repository: { pullRequest: { number: 1 } } } },
  ]) {
    const unavailable = new GitHubClient(
      new Octokit({ request: { fetch: async () => json(data) } }),
    );
    await assert.rejects(
      unavailable.pullRequestReadiness("example/target", 1),
      /unavailable/,
    );
  }
  const lost = new GitHubClient(
    new Octokit({
      request: {
        fetch: async () => {
          throw new Error("private transport");
        },
      },
    }),
  );
  await assert.rejects(
    lost.pullRequestReadiness("example/target", 1),
    (error) =>
      !(error instanceof GitHubOutcomeUnknown) &&
      !error.message.includes("private"),
  );
  await assert.rejects(
    client.request("POST", "graphql", { query: "mutation" }),
    /outside/,
  );
  const controller = new AbortController();
  const gated = new GitHubClient(
    new Octokit({
      request: {
        fetch: async () =>
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "retry-after": "10",
            },
          }),
      },
    }),
  );
  await gated.request("GET", "repos/example/target/issues/1");
  const waiting = withProcessCancellation(controller.signal, () =>
    gated.pullRequestReadiness("example/target", 1),
  );
  controller.abort();
  await assert.rejects(waiting);
});

test("regular discovery and pending CI settle before amendment without starving owner controls", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-ci-amend-parent-"));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(import.meta.dirname, "support/ci-readiness-amendment.mjs"), root],
      { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 },
    );
    assert.match(stdout, /discovery and CI wait completed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
