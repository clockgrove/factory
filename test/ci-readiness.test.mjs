import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
// Failed checks stop for the operator instead of using a repair allowance.
const autonomy = {
  allowances: {
    planningRevisions: 0,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A live owner re-observes a readiness wait every 5 seconds; allow a few rounds. */
async function until(check) {
  for (let n = 0; n < 3000; n++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Fixture condition not reached");
}
async function fixture(route, name, run, chain = false, namedGate = false) {
  const root = mkdtempSync(join(tmpdir(), "factory-ci-wait-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  let active;
  try {
    const target = createTarget(root);
    const config = {
      ...factoryConfig(
        target.checkout,
        `example/ci-${route}-${name}`,
        route,
        1,
      ),
      autonomy,
    };
    const objectiveBody =
      (chain ? body + "- test -s next.txt\n" : body) +
      (namedGate
        ? "\n## Delivery\nThe Quality workflow job `quality` must succeed on each exact PR head before integration; preserve workflow/job files and final acceptance.\n"
        : "");
    const setup = makeApplication({
      config,
      graph: {
        objective: 1,
        ...(namedGate
          ? {
              requiredPreIntegrationChecks: [
                {
                  checkName: "quality",
                  source: {
                    path: "OBJECTIVE",
                    text: objectiveBody.split("\n").at(-2),
                    digest: createHash("sha256")
                      .update(objectiveBody)
                      .digest("hex"),
                  },
                },
              ],
            }
          : {}),
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
      objectiveBody,
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
    let namedMode = "missing";
    let observations = 0,
      merges = 0;
    const observe = github.observe.bind(github);
    github.observe = async (identity) => {
      observations++;
      const observation = await observe(identity);
      if (!namedGate || namedMode === "missing") return observation;
      const receipt = {
        id: 1,
        name: "quality",
        headSha: identity.headSha,
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://example.test/check/1",
      };
      if (namedMode === "stale") receipt.headSha = "f".repeat(40);
      if (namedMode === "failed")
        return { ...observation, checks: "failing", namedChecks: [] };
      if (namedMode === "pending") receipt.status = "in_progress";
      return {
        ...observation,
        namedChecks:
          namedMode === "ambiguous"
            ? [receipt, { ...receipt, id: 2 }]
            : [receipt],
      };
    };
    const merge = github.merge.bind(github);
    github.merge = async (identity, expectedHead) => {
      // No intent marker precedes a merge any more: the merge names the
      // retained publication's exact PR and head, so repeating it is safe.
      const work = readState(config.repository, 1).work.result;
      assert.equal(work.status, "published");
      assert.equal(identity.number, work.pullRequest);
      assert.equal(expectedHead, work.changeRef);
      merges++;
      return merge(identity, expectedHead);
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
      setNamedMode: (mode) => {
        namedMode = mode;
      },
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
  assert.match(state.work.result.waitingReason, /Awaiting/);
  assert.equal(state.work.result.recovery, undefined);
  assert.equal(state.error, undefined);
  assert.equal(state.finalValidation, undefined);
}
/** Start a tracked run and return the exact published wait it reaches. */
async function startWaiting(
  f,
  reached = (state) => state.work.result.waitingReason,
) {
  const running = f.track(f.application.runObjective(1));
  await until(() => {
    const state = readContinuation(f.config.repository, 1);
    return state?.work && reached(state);
  });
  return { running, waiting: readState(f.config.repository, 1) };
}
/** Wait until the live owner has observed GitHub again after this point. */
async function observedAgain(f) {
  const before = f.counts().observations;
  await until(() => f.counts().observations > before);
}
for (const route of ["regular", "native-stack"]) {
  test(`${route}: pending CI keeps the run on its exact publication and completes without another worker/review`, async () =>
    fixture(route, "pending", async (f) => {
      const { running, waiting } = await startWaiting(f);
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
      const result = await running;
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
  test(`${route}: owner pauses read-only wait and observes success automatically`, async () =>
    fixture(route, "paused", async (f) => {
      const { running, waiting } = await startWaiting(f);
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
      const { running, waiting } = await startWaiting(f);
      const handed = assert.rejects(
        running,
        (error) => error.constructor.name === "CoordinatorHandoff",
      );
      const identity = identityOf(waiting);
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
      const result = await f.track(f.application.runObjective(1));
      assert.deepEqual(identityOf(result), identity);
      assert.equal(result.finalValidation.passed, true);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
      assert.equal(f.counts().merges, 1);
      assert.equal(
        f.github.state().events.filter((event) => event.type === "publish")
          .length,
        1,
      );
    }));
  test(`${route}: cancellation of known read-only wait submits no merge`, async () =>
    fixture(route, "cancel", async (f) => {
      const { running } = await startWaiting(f);
      const cancelled = assert.rejects(running, /cancellation requested/);
      await controlObjective(f.config, { objective: 1, action: "cancel" });
      await cancelled;
      const state = readState(f.config.repository, 1);
      assert.ok(state.cancelledAt);
      assert.equal(state.work.result.status, "published");
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
      const { running, waiting } = await startWaiting(f);
      assertWait(waiting);
      assert.equal(f.counts().merges, 0);
      const identity = identityOf(waiting);
      readiness = "ready";
      const completed = await running;
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
      const { running, waiting } = await startWaiting(f);
      const identity = identityOf(waiting);
      f.github.update((state) => {
        for (const pull of Object.values(state.pullRequests))
          pull.checks = "failing";
      });
      await assert.rejects(running, /not mergeable/);
      const stopped = readState(f.config.repository, 1);
      assert.deepEqual(identityOf(stopped), identity);
      assert.equal(f.counts().merges, 0);
      assert.equal(
        readEvents(f.eventsPath).filter((event) => event.type === "start")
          .length,
        1,
      );
    }));
}

for (const route of ["regular", "native-stack"]) {
  test(`${route}: source-required quality waits for exact named evidence despite clean no-check readiness`, async () =>
    fixture(
      route,
      "named",
      async (f) => {
        const { running, waiting: first } = await startWaiting(f);
        assert.equal(
          first.graph.requiredPreIntegrationChecks[0].checkName,
          "quality",
        );
        assertWait(first);
        const identity = identityOf(first);
        f.ready();
        for (const mode of ["missing", "pending", "stale", "ambiguous"]) {
          f.setNamedMode(mode);
          await observedAgain(f);
          // Each pass reserves a phase, clearing the wait; read it once settled.
          await until(
            () =>
              readContinuation(f.config.repository, 1)?.work?.result
                ?.waitingReason,
          );
          const waiting = readState(f.config.repository, 1);
          assertWait(waiting);
          assert.deepEqual(identityOf(waiting), identity);
          assert.equal(f.counts().merges, 0);
        }
        f.setNamedMode("success");
        const completed = await running;
        assert.equal(completed.finalValidation.passed, true);
        assert.equal(f.counts().merges, 1);
        assert.deepEqual(identityOf(completed), identity);
        assert.equal(
          completed.work.result.preIntegrationChecks[0].headSha,
          identity.head,
        );
        assert.equal(
          readEvents(f.eventsPath).filter((event) => event.type === "start")
            .length,
          1,
        );
      },
      false,
      true,
    ));
  test(`${route}: failed source-required check stops before merge submission`, async () =>
    fixture(
      route,
      "named-fail",
      async (f) => {
        const { running } = await startWaiting(f);
        f.setNamedMode("failed");
        f.ready();
        await assert.rejects(running, /not mergeable/);
        assert.equal(f.counts().merges, 0);
      },
      false,
      true,
    ));
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
    await f.application.enqueueIntake([1], { pollSeconds: 0.01 });
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

test("native multi-layer wait preserves every exact published layer and creates and merges the stack only after readiness", async () =>
  fixture(
    "native-stack",
    "chain",
    async (f) => {
      const stacks = () =>
        f.github.state().events.filter((event) => event.type === "stack")
          .length;
      const { running, waiting } = await startWaiting(
        f,
        // The stack head carries the wait for the whole unbranched chain.
        (state) =>
          state.work.result.status === "published" &&
          state.work.next?.waitingReason,
      );
      assert.equal(waiting.work.result.status, "published");
      assert.equal(waiting.work.next.status, "published");
      assert.equal(waiting.error, undefined);
      assert.equal(stacks(), 0);
      assert.equal(f.counts().merges, 0);
      const identities = Object.fromEntries(
        Object.entries(waiting.work).map(([id, work]) => [
          id,
          { attempt: work.attempt, head: work.changeRef, pr: work.pullRequest },
        ]),
      );
      const mergeStack = f.github.mergeNativeStack.bind(f.github);
      f.github.mergeNativeStack = async (...args) => {
        // The merge names the exact retained layers; nothing was republished.
        assert.deepEqual(
          args[0].map((layer) => [layer.pullRequest, layer.headSha]),
          Object.values(identities).map((identity) => [
            identity.pr,
            identity.head,
          ]),
        );
        const beforeMerge = args[3].beforeMerge;
        args[3] = {
          ...args[3],
          beforeMerge: () => {
            beforeMerge();
            assert.ok(
              Object.values(
                readState(f.config.repository, 1).stackNumbers ?? {},
              ).includes(args[2]),
            );
          },
        };
        return mergeStack(...args);
      };
      f.ready();
      const completed = await running;
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
      assert.equal(stacks(), 1);
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

// Full preserved public #446 reproduction: empty check runs, zero commit statuses,
// authenticated CLEAN readiness. Source-required gates must close this exact gap.
test("public no-registered-check reproduction refuses gated integration while preserving no-CI targets", async () => {
  const identity = {
    number: 1,
    branch: "work",
    headSha: head,
    baseBranch: "main",
  };
  let runs = [];
  const client = {
    async request(method, path) {
      if (path.endsWith("/pulls/1"))
        return {
          head: { sha: head, ref: "work" },
          base: { ref: "main" },
          state: "open",
          merged: false,
        };
      if (path.includes("/check-runs?")) return { check_runs: runs };
      if (path.endsWith("/status")) return { state: "pending", total_count: 0 };
      throw new Error(`Unexpected request ${method} ${path}`);
    },
    async pullRequestReadiness() {
      return {
        headRefOid: head,
        headRefName: "work",
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
      };
    },
  };
  const gateway = new RealGitHubGateway("example/fixture", false, client);
  let submitted = 0;
  gateway.defaultBranch = async () => "main";
  gateway.merge = async () => {
    submitted++;
    return { integratedSha: "b".repeat(40) };
  };
  assert.deepEqual(await gateway.observe(identity), {
    namedChecks: [],
    mergeReadiness: "ready",
    state: "open",
    checks: "passing",
  });
  const result = { branch: "work", pullRequest: 1, headSha: head };
  await new RegularDelivery("/unused", gateway).merge(result);
  assert.equal(submitted, 1);
  submitted = 0;
  const gated = new RegularDelivery("/unused", gateway, ["quality"]);
  await assert.rejects(gated.merge(result), /Awaiting.*quality/);
  assert.equal(submitted, 0);
  const success = {
    id: 1,
    name: "quality",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    html_url: "https://example.test/check/1",
    app: { id: 100 },
  };
  for (const variant of [
    { ...success, status: "in_progress", conclusion: null },
    { ...success, head_sha: "f".repeat(40) },
    { ...success, conclusion: "neutral" },
    { ...success, conclusion: "skipped" },
  ]) {
    runs = [variant];
    await assert.rejects(gated.merge(result), /Awaiting/);
    assert.equal(submitted, 0);
  }
  runs = [success, { ...success, id: 2, app: { id: 200 } }];
  await assert.rejects(gated.merge(result), /Awaiting/);
  assert.equal(submitted, 0);
  runs = [{ ...success, conclusion: "failure" }];
  await assert.rejects(gated.merge(result), /not mergeable/);
  assert.equal(submitted, 0);
  runs = [success];
  let before;
  await gated.merge(result, (observation) => {
    before = observation;
    assert.equal(submitted, 0);
  });
  assert.equal(submitted, 1);
  assert.equal(before.namedChecks[0].name, "quality");
  assert.equal(before.namedChecks[0].headSha, head);
});
