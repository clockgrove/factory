import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { GitHubClient } from "../dist/github-client.js";
import { RealGitHubGateway } from "../dist/github.js";
import { withProcessCancellation } from "../dist/process.js";
import { attachFault, decision, transient } from "../dist/fault.js";
import { stateRoot } from "../dist/config.js";
import { defaultAutonomy } from "../dist/index.js";
import { requestControl } from "../dist/coordinator-control.js";
import { controlObjective } from "../dist/runner.js";
import {
  readContinuation,
  readState,
  saveState,
  statePath,
} from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import { eventually } from "./support/eventually.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const until = (predicate) =>
  eventually(predicate, { message: "fixture condition" });
async function fixture(name, fn, model, customize) {
  const root = mkdtempSync(join(tmpdir(), `fc-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, `example/${name}`);
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        {
          id: "result",
          title: "Result",
          goal: "Write result.txt",
          brief: "Write result.txt",
          acceptance: ["result.txt exists"],
          nonGoals: ["No unrelated files"],
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
        },
      ],
    };
    const descriptor = {
      config,
      graph,
      objectiveBody:
        "## Acceptance\n- `test -s result.txt`\n\n## Final validation\n- `test -s result.txt`\n",
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
      ...(model ? { planningModel: model(graph) } : {}),
    };
    customize?.(descriptor);
    await fn({
      ...makeApplication(descriptor),
      config,
      graph,
      root,
      descriptor,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("owner remains responsive during planning; cancellation succeeds and cannot publish a late result", async () => {
  const pending = deferred();
  let calls = 0;
  await fixture(
    "planning",
    async ({ application, config, github }) => {
      const running = application.runObjective(1);
      const rejected = assert.rejects(running, /cancel/);
      await until(() => calls === 1);
      const snapshot = readContinuation(config.repository, 1);
      assert.equal(snapshot.schemaVersion, 8);
      assert.equal(snapshot.plan, undefined);
      assert.throws(() => readState(config.repository, 1), /schema version/);
      assert.equal(
        statSync(join(stateRoot(config.repository), "control.sock")).mode &
          0o777,
        0o600,
      );
      const status = await requestControl(config.repository, {
        objective: 1,
        action: "status",
      });
      assert.equal(status.result.phase, "planning");
      await assert.rejects(application.runObjective(1), /already owns/);
      await controlObjective(config, { objective: 1, action: "pause" });
      assert.equal(
        readContinuation(config.repository, 1).coordinator.mode,
        "paused",
      );
      await requestControl(config.repository, {
        objective: 1,
        action: "cancel",
      });
      // A planning call has no side effects, so cancelling during it is safe.
      assert.equal(
        readContinuation(config.repository, 1).coordinator.cancelError,
        undefined,
      );
      pending.resolve();
      await rejected;
      assert.equal(calls, 1);
      assert.ok(readContinuation(config.repository, 1).cancelledAt);
      assert.equal(Object.keys(github.state().issues).length, 0);
    },
    (graph) => ({
      async generateStructured(request) {
        calls++;
        await pending.promise;
        return withCoverage(request, graph);
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    }),
  );
});

test("partial projection saves each known identity and resumes with it without planning again", async () => {
  await fixture(
    "partial",
    async ({ application, config, github, planningPath }) => {
      let calls = 0;
      github.projectGraph = async (request) => {
        calls++;
        if (calls === 2) {
          // The restart hands the already created issue back as known.
          assert.deepEqual(request.knownIssues, { result: 42 });
          throw Error("stop after known identities were supplied");
        }
        await request.beforeCreate("result");
        request.projected("result", 42);
        throw Error("API interruption after known issue");
      };
      await assert.rejects(application.runObjective(1), /API interruption/);
      const saved = readContinuation(config.repository, 1);
      assert.ok(saved.plan);
      assert.deepEqual(saved.issueByItemId, { result: 42 });
      const before = readEvents(planningPath);
      await assert.rejects(
        application.runObjective(1),
        /stop after known identities were supplied/,
      );
      assert.deepEqual(readEvents(planningPath), before);
      assert.equal(calls, 2);
    },
  );
});

test("compound: after an interrupted projection, read-only observations keep the rate gate", async () => {
  await fixture("unknown", async ({ application, config, github }) => {
    let creates = 0;
    github.projectGraph = async (request) => {
      await request.beforeCreate("result");
      creates++;
      throw new Error("lost create reply");
    };
    await assert.rejects(application.runObjective(1), /lost create reply/);
    const original = readContinuation(config.repository, 1);
    const observed = await github.objective(1);
    const reads = [];
    const gateway = new RealGitHubGateway(
      config.repository,
      {},
      new GitHubClient(
        new Octokit({
          request: {
            fetch: async () => {
              reads.push(Date.now());
              return new Response(
                JSON.stringify(
                  reads.length === 1
                    ? { message: "secondary rate limit" }
                    : { number: 1, state: "open", ...observed },
                ),
                {
                  status: reads.length === 1 ? 403 : 200,
                  headers: {
                    "content-type": "application/json",
                    ...(reads.length === 1 ? { "retry-after": "0.1" } : {}),
                  },
                },
              );
            },
          },
        }),
      ),
    );
    github.objective = gateway.objective.bind(gateway);
    assert.equal(reads.length, 0);
    // Independent read-only observations retain the transport rate gate, without lifecycle replay.
    await assert.rejects(github.objective(1), /HTTP 403/);
    const abort = new AbortController();
    const queued = withProcessCancellation(abort.signal, () =>
      github.objective(1),
    );
    abort.abort();
    await assert.rejects(queued);
    assert.equal(reads.length, 1);
    await github.objective(1);
    assert.equal(reads.length, 2);
    assert.ok(reads[1] - reads[0] >= 90);
    const stopped = readContinuation(config.repository, 1);
    assert.equal(stopped.runId, original.runId);
    assert.deepEqual(stopped.plan, original.plan);
    assert.deepEqual(stopped.charges, original.charges);
    assert.equal(creates, 1);
  });
});

test("pause and drain persist offline and resume keeps the original deadline", async () => {
  await fixture("modes", async ({ application, config, driver }) => {
    driver.preflight = async () => {
      throw new Error("offline");
    };
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    await assert.rejects(
      application.runObjective(1, { deadlineAt }),
      /offline/,
    );
    await controlObjective(config, { objective: 1, action: "drain" });
    assert.equal(
      readContinuation(config.repository, 1).coordinator.mode,
      "draining",
    );
    await assert.rejects(
      application.runObjective(1, {
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      }),
      /cannot be replaced/,
    );
    await controlObjective(config, { objective: 1, action: "resume" });
    assert.equal(
      readContinuation(config.repository, 1).coordinator.deadlineAt,
      deadlineAt,
    );
  });
});

test("deadline elapsed during a hung planning call preserves unknown disposition and responsive control", async () => {
  const pending = deferred();
  await fixture(
    "deadline",
    async ({ application, config }) => {
      const running = application.runObjective(1, {
        deadlineAt: new Date(Date.now() + 300).toISOString(),
      });
      const rejected = assert.rejects(running, /cancel/);
      await until(
        () => readContinuation(config.repository, 1)?.cancelRequested,
      );
      assert.equal(
        (
          await requestControl(config.repository, {
            objective: 1,
            action: "status",
          })
        ).handled,
        true,
      );
      assert.equal(
        readContinuation(config.repository, 1).cancelledAt,
        undefined,
      );
      pending.resolve();
      await rejected;
    },
    (graph) => ({
      async generateStructured(request) {
        await pending.promise;
        return withCoverage(request, graph);
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    }),
  );
});

test("exact-ID API outage repeats the observation with backoff and resumes without new planning", async () => {
  await fixture(
    "outage",
    async ({ application, config, github, planningPath }) => {
      {
        const original = github.objective.bind(github);
        let reads = 0;
        let offline = true;
        github.objective = async (...args) => {
          reads++;
          if (reads > 1 && offline)
            throw attachFault(
              new Error("API unavailable"),
              transient("API unavailable", false),
            );
          return original(...args);
        };
        const run = application.runObjective(1);
        await until(
          () =>
            readContinuation(config.repository, 1)?.repeats?.[
              "objective/observe"
            ]?.faults?.count >= 2,
        );
        const before = readEvents(planningPath).length;
        const status = await requestControl(config.repository, {
          objective: 1,
          action: "status",
        });
        assert.equal(status.result.mode, "running");
        assert.equal(readEvents(planningPath).length, before);
        offline = false;
        const result = await run;
        assert.equal(result.finalValidation.passed, true);
        assert.equal(result.repeats, undefined);
      }
      assert.equal(
        readEvents(planningPath).filter(
          (event) => event.type !== "result-review",
        ).length,
        1,
      );
    },
  );
});

test("confirmed closure or body change prevents dispatch rather than masquerading as an outage", async () => {
  for (const change of ["closed", "body"])
    await fixture(
      `changed-${change}`,
      async ({ application, github, eventsPath }) => {
        const original = github.objective.bind(github);
        let reads = 0;
        github.objective = async (...args) => {
          const value = await original(...args);
          if (++reads === 1) return value;
          return change === "closed"
            ? { ...value, state: "closed" }
            : { ...value, body: `${value.body}changed` };
        };
        const result = await application.runObjective(1);
        assert.equal(result.wait.kind, "decision");
        assert.match(result.wait.detail, /was closed|body changed/);
        assert.equal(
          readEvents(eventsPath).filter((event) => event.type === "start")
            .length,
          0,
        );
      },
    );
});

/** A reviewer that passes every criterion, after `before` saw the request. */
const passingReviewer = (before) => async (request) => {
  await before?.(request);
  return {
    packetId: request.reviewPacket.id,
    findings: resultFindings(
      request,
      request.criteria.map((criterion) => ({
        criterion,
        verdict: "pass",
        source: "OBJECTIVE",
        quote: "## Acceptance",
        detail: "Exact-tree command passed",
        question: "",
      })),
    ),
  };
};

test("a body change first seen at resume is a decision, as during the run (#648)", async () => {
  let asks = 0;
  await fixture(
    "changed-at-resume",
    async ({ application, config, github }) => {
      // The first run stops on the item's question; nothing has failed.
      const first = await application.runObjective(1);
      assert.equal(first.work.result.wait.kind, "decision");
      assert.equal(first.error, undefined);
      const original = github.objective.bind(github);
      let changed = true;
      github.objective = async (...args) => {
        const value = await original(...args);
        return changed ? { ...value, body: `${value.body}changed` } : value;
      };
      // The resume sees the change first: the operator decides, the run
      // has not failed.
      const resumed = await application.runObjective(1);
      assert.equal(resumed.wait.kind, "decision");
      assert.match(resumed.wait.detail, /body changed outside Factory/);
      const saved = readState(config.repository, 1);
      assert.equal(saved.error, undefined);
      assert.equal(saved.wait.kind, "decision");
      // Asked again until the body is restored; still not a failure.
      const again = await application.runObjective(1);
      assert.equal(again.wait.kind, "decision");
      assert.equal(readState(config.repository, 1).error, undefined);
      // Restored and answered: the Objective completes.
      changed = false;
      assert.equal(application.retryWorkItem(1), "step");
      assert.equal(application.retryWorkItem(1, "result"), "step");
      const done = await application.runObjective(1);
      assert.ok(done.finalValidation.passed);
    },
    undefined,
    (descriptor) => {
      descriptor.resultReviewer = passingReviewer(() => {
        if (++asks === 1)
          throw attachFault(
            new Error("reviewer asks"),
            decision("Is the result right?"),
          );
      });
    },
  );
});

test("a live retry of an item waiting in place resumes it in the running pass (#643)", async () => {
  let asks = 0;
  await fixture(
    "live-retry",
    async ({ application, config, root }) => {
      const run = application.runObjective(1);
      // The result item waits in place for its question while second runs.
      await until(
        () =>
          readContinuation(config.repository, 1)?.work?.result?.wait?.kind ===
          "decision",
      );
      const retried = await requestControl(config.repository, {
        objective: 1,
        action: "retry",
        input: { item: "result" },
      });
      assert.equal(retried.handled, true);
      assert.equal(retried.result, "step");
      // The live owner resumes the item at once, before second finishes.
      await until(() => asks >= 2);
      writeFileSync(join(root, "barrier", "second"), "go\n");
      const result = await run;
      assert.ok(result.finalValidation.passed);
      assert.equal(result.error, undefined);
    },
    undefined,
    (descriptor) => {
      const second = structuredClone(descriptor.graph.items[0]);
      second.id = "second";
      second.title = "Second";
      second.ownedPaths = ["second.txt"];
      second.acceptance = ["second.txt exists"];
      second.validation[0].command = "test -s second.txt";
      descriptor.graph.items.push(second);
      descriptor.objectiveBody +=
        "\n## Other validation\n- `test -s second.txt`\n";
      descriptor.actions.second = {
        files: [{ path: "second.txt", text: "second\n" }],
        barrier: join(descriptor.fakeRoot, "..", "barrier", "second"),
      };
      descriptor.resultReviewer = passingReviewer((request) => {
        if (!request.criteria.includes("result.txt exists")) return;
        if (++asks === 1)
          throw attachFault(
            new Error("reviewer asks"),
            decision("Is the result right?"),
          );
      });
    },
  );
});

test("cancellation while GitHub is unavailable stops locally with no dispatch", async () => {
  await fixture(
    "cancel-outage",
    async ({ application, config, github, eventsPath }) => {
      const original = github.objective.bind(github);
      let reads = 0;
      github.objective = (...args) =>
        ++reads > 1
          ? Promise.reject(
              attachFault(new Error("offline"), transient("offline", false)),
            )
          : original(...args);
      const run = application.runObjective(1);
      const rejected = assert.rejects(run, /cancel/);
      await until(
        () =>
          readContinuation(config.repository, 1)?.repeats?.[
            "objective/observe"
          ],
      );
      await requestControl(config.repository, {
        objective: 1,
        action: "cancel",
      });
      await rejected;
      assert.ok(readState(config.repository, 1).cancelledAt);
      assert.equal(
        readEvents(eventsPath).filter((event) => event.type === "start").length,
        0,
      );
    },
  );
});

test("failed worker cancellation preserves unresolved ownership and cannot become terminal success", async () => {
  await fixture(
    "cancel-failure",
    async ({ application, config, driver, descriptor, eventsPath, root }) => {
      const barrier = join(root, "barrier", "go");
      descriptor.actions.result.barrier = barrier;
      driver.cancel = async () => {
        throw new Error("driver cessation not confirmed");
      };
      const run = application.runObjective(1);
      const rejected = assert.rejects(run, /cancel|aborted/i);
      await until(() =>
        readEvents(eventsPath).some((event) => event.type === "start"),
      );
      await requestControl(config.repository, {
        objective: 1,
        action: "cancel",
      });
      await until(
        () => readContinuation(config.repository, 1)?.coordinator.cancelError,
      );
      const state = readState(config.repository, 1);
      assert.equal(state.cancelledAt, undefined);
      assert.match(state.coordinator.cancelError, /cessation not confirmed/);
      assert.equal(
        (
          await requestControl(config.repository, {
            objective: 1,
            action: "status",
          })
        ).handled,
        true,
      );
      assert.ok(existsSync(state.work.result.execution.data.worktree));
      mkdirSync(join(root, "barrier"), { recursive: true });
      writeFileSync(barrier, "go");
      await rejected;
      assert.equal(readState(config.repository, 1).cancelledAt, undefined);
      assert.throws(
        () => application.retryWorkItem(1, "result"),
        /cessation is unresolved/,
      );
    },
  );
});

test("drain stays idle under the owner and resumes its pending graph", async () => {
  await fixture(
    "drain-idle",
    async ({ application, config, github, planningPath }) => {
      const original = github.projectGraph.bind(github);
      github.projectGraph = async (request) => {
        const result = await original(request);
        await requestControl(config.repository, {
          objective: 1,
          action: "drain",
        });
        return result;
      };
      const run = application.runObjective(1);
      await until(
        () => readContinuation(config.repository, 1)?.schemaVersion === 7,
      );
      const before = readEvents(planningPath).length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(readEvents(planningPath).length, before);
      assert.equal(
        readState(config.repository, 1).work.result.status,
        "pending",
      );
      assert.equal(
        (
          await requestControl(config.repository, {
            objective: 1,
            action: "status",
          })
        ).handled,
        true,
      );
      await requestControl(config.repository, {
        objective: 1,
        action: "resume",
      });
      assert.equal((await run).finalValidation.passed, true);
    },
  );
});

test("resumed preparation keeps its persisted plan and autonomy without planning again", async () => {
  await fixture(
    "preparation-restart",
    async ({ application, config, driver, planningPath }) => {
      const original = driver.preflight?.bind(driver);
      driver.preflight = async () => {
        throw new Error("preprojection preflight unavailable");
      };
      await assert.rejects(
        application.runObjective(1),
        /preprojection preflight/,
      );
      const preparation = readContinuation(config.repository, 1);
      assert.equal(preparation.schemaVersion, 8);
      assert.ok(preparation.plan);
      assert.deepEqual(preparation.autonomy, defaultAutonomy);
      const compiles = () =>
        readEvents(planningPath).filter((event) => !event.type).length;
      const planned = compiles();
      driver.preflight = original;
      const completed = await application.runObjective(1);
      assert.deepEqual(completed.autonomy, preparation.autonomy);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(compiles(), planned);
    },
  );
});

test("regular and native cancellation during publication succeeds and nothing replays", async () => {
  for (const delivery of ["regular", "native-stack"])
    await fixture(
      `publication-${delivery}`,
      async ({ application, config, github }) => {
        config.delivery.kind = delivery;
        const pending = deferred();
        let creates = 0;
        const original = github.publish.bind(github);
        github.publish = async (request) => {
          creates++;
          await original(request);
          await pending.promise;
          throw new Error("publication acknowledgement lost");
        };
        const run = application.runObjective(1);
        const rejected = assert.rejects(run);
        await until(() => creates === 1);
        await requestControl(config.repository, {
          objective: 1,
          action: "cancel",
        });
        // Cancellation never has to prove what the in-flight call did; it is
        // acknowledged and becomes terminal once that call settles.
        await until(() =>
          /cancellation acknowledged/.test(
            readState(config.repository, 1)?.coordinator.waitReason ?? "",
          ),
        );
        assert.equal(
          readState(config.repository, 1).coordinator.cancelError,
          undefined,
        );
        pending.resolve();
        await rejected;
        const state = readState(config.repository, 1);
        assert.ok(state.cancelledAt);
        assert.equal("pendingEffect" in state.work.result, false);
        // The Objective stays cancelled: a later run neither publishes again
        // nor merges the PR the lost call created.
        await assert.rejects(application.runObjective(1), /cancel/);
        assert.equal(creates, 1);
        const pulls = Object.values(github.state().pullRequests);
        assert.equal(pulls.length, 1);
        assert.equal(
          pulls.some((pr) => pr.state === "merged"),
          false,
        );
      },
    );
});

test("pause acknowledged during exact observation prevents regular and native dispatch", async () => {
  for (const delivery of ["regular", "native-stack"])
    await fixture(
      `pause-dispatch-${delivery}`,
      async ({ application, config, github, eventsPath }) => {
        config.delivery.kind = delivery;
        const pending = deferred();
        const original = github.objective.bind(github);
        let calls = 0;
        github.objective = async (...args) => {
          if (++calls === 2) await pending.promise;
          return original(...args);
        };
        const run = application.runObjective(1);
        await until(() => calls === 2);
        await requestControl(config.repository, {
          objective: 1,
          action: "pause",
        });
        pending.resolve();
        // The owner stays alive while paused and dispatches nothing.
        await until(() => readState(config.repository, 1)?.work);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          readState(config.repository, 1).work.result.status,
          "pending",
        );
        assert.equal(
          readEvents(eventsPath).filter((event) => event.type === "start")
            .length,
          0,
        );
        await requestControl(config.repository, {
          objective: 1,
          action: "resume",
        });
        assert.equal((await run).finalValidation.passed, true);
        assert.equal(
          readEvents(eventsPath).filter((event) => event.type === "start")
            .length,
          1,
        );
      },
    );
});

test("pause during planning keeps the owner without projection; resume reuses the retained planning response", async () => {
  const pending = deferred();
  let calls = 0;
  await fixture(
    "pause-planning",
    async ({ application, config, github }) => {
      const run = application.runObjective(1);
      await until(() => calls === 1);
      await requestControl(config.repository, {
        objective: 1,
        action: "pause",
      });
      pending.resolve();
      await until(() =>
        /paused or cancelled/.test(
          readContinuation(config.repository, 1)?.coordinator.waitReason ?? "",
        ),
      );
      const paused = readContinuation(config.repository, 1);
      assert.equal(paused.schemaVersion, 8);
      assert.equal(paused.coordinator.mode, "paused");
      assert.equal(paused.plan, undefined);
      assert.equal(Object.keys(github.state().issues).length, 0);
      await requestControl(config.repository, {
        objective: 1,
        action: "resume",
      });
      const completed = await run;
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(calls, 1);
    },
    (graph) => ({
      async generateStructured(request) {
        calls++;
        await pending.promise;
        return withCoverage(request, graph);
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
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => ({
              criterion,
              verdict: "pass",
              source: "OBJECTIVE",
              quote: "## Acceptance",
              detail: "Exact-tree command passed",
              question: "",
            })),
          ),
        };
      },
    }),
  );
});

test("first deadline added to existing preparation persists before a wait and cannot be extended", async () => {
  await fixture("deadline-add", async ({ application, config, driver }) => {
    let first = true;
    driver.preflight = async () => {
      if (first) {
        first = false;
        throw new Error("offline preprojection");
      }
    };
    await assert.rejects(application.runObjective(1), /offline preprojection/);
    await controlObjective(config, { objective: 1, action: "pause" });
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const run = application.runObjective(1, {
      deadlineAt,
    });
    const rejected = assert.rejects(run, /cancel/);
    await until(
      () =>
        readContinuation(config.repository, 1)?.coordinator.deadlineAt ===
        deadlineAt,
    );
    await requestControl(config.repository, { objective: 1, action: "cancel" });
    await rejected;
    assert.equal(
      readContinuation(config.repository, 1).coordinator.deadlineAt,
      deadlineAt,
    );
    await assert.rejects(
      application.runObjective(1, {
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      }),
      /cannot be replaced/,
    );
  });
});

test("concurrent deliveries share one repeated observation through a GitHub outage without replaying workers", async () => {
  await fixture(
    "concurrent-outage",
    async ({ application, config, github, eventsPath }) => {
      const original = github.objective.bind(github);
      let reads = 0;
      let offline = true;
      github.objective = async (...args) => {
        reads++;
        if (reads >= 3 && offline)
          throw attachFault(
            new Error("shared outage"),
            transient("shared outage", false),
          );
        return original(...args);
      };
      // Both items' deliveries share one repeated observation.
      const run = application.runObjective(1);
      await until(() => reads >= 4);
      offline = false;
      const result = await run;
      assert.ok(result.finalValidation.passed);
      assert.equal(
        readEvents(eventsPath).filter((event) => event.type === "start").length,
        2,
      );
    },
    undefined,
    (descriptor) => {
      const second = structuredClone(descriptor.graph.items[0]);
      second.id = "second";
      second.title = "Second";
      second.ownedPaths = ["second.txt"];
      second.acceptance = ["second.txt exists"];
      second.validation[0].command = "test -s second.txt";
      descriptor.graph.items.push(second);
      descriptor.objectiveBody +=
        "\n## Other validation\n- `test -s second.txt`\n";
      descriptor.actions.second = {
        files: [{ path: "second.txt", text: "second\n" }],
      };
    },
  );
});

test("a response-less result review leaves no unknown effect and allows retry", async () => {
  for (const delivery of ["regular", "native-stack"])
    await fixture(
      `unknown-review-${delivery}`,
      async ({ application, config }) => {
        config.delivery.kind = delivery;
        await assert.rejects(
          application.runObjective(1),
          /review response lost/,
        );
        const state = readState(config.repository, 1);
        assert.equal(state.work.result.pendingEffect, undefined);
        assert.equal(state.work.result.acceptancePending, undefined);
        // A step record and decision left by the failed attempt: retrying a
        // failed item starts a new attempt without them.
        state.repeats = {
          "item/result/review": { paid: 4, inFlight: true },
          "objective/close": { paid: 1 },
        };
        state.work.result.wait = {
          kind: "decision",
          detail: "review failed 4 times; retry or cancel?",
          step: "item/result/review",
        };
        saveState(statePath(config.repository, 1), state);
        // Reviews have no side effects; nothing blocks asking again.
        assert.equal(application.retryWorkItem(1, "result"), "attempt");
        const retried = readState(config.repository, 1);
        assert.equal(retried.work.result.status, "pending");
        assert.equal(retried.work.result.wait, undefined);
        assert.deepEqual(retried.repeats, { "objective/close": { paid: 1 } });
        // Completed cancellation leaves no step to resume.
        if (delivery === "regular") {
          assert.equal(await application.cancelObjective(1), "cancelled");
          const cancelled = readState(config.repository, 1);
          assert.ok(cancelled.cancelledAt);
          assert.equal(cancelled.repeats, undefined);
        }
      },
      undefined,
      (descriptor) => {
        descriptor.resultReviewer = async () => {
          throw new Error("review response lost");
        };
      },
    );
});

test("a completed semantic refusal is failed evidence, not an unknown submitted review", async () => {
  for (const delivery of ["regular", "native-stack"])
    await fixture(
      `refused-review-${delivery}`,
      async ({ application, config }) => {
        config.delivery.kind = delivery;
        // A refusal is a wrong result of this item: diagnosed and stopped
        // for a decision, never an Objective failure.
        const stopped = await application.runObjective(1);
        assert.equal(stopped.error, undefined);
        const state = readState(config.repository, 1);
        assert.equal(state.work.result.pendingEffect, undefined);
        assert.equal(state.work.result.status, "failed");
        assert.match(
          state.work.result.recovery.failure.event,
          /^item\/result\//,
        );
      },
      undefined,
      (descriptor) => {
        descriptor.resultReviewer = async (request) => ({
          packetId: request.reviewPacket.id,
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => ({
              criterion,
              verdict: "refuse",
              source: "OBJECTIVE",
              quote: "## Acceptance",
              detail: "Result does not satisfy the accepted criterion",
              question: "",
            })),
          ),
        });
      },
    );
});

test("owner handoff releases a paused preparation without cancellation or projection", async () => {
  const started = deferred();
  const release = deferred();
  await fixture(
    "handoff-preparation",
    async ({ application, config }) => {
      const running = application.runObjective(1);
      const outcome = running.then(
        () => "returned",
        (error) => error,
      );
      await started.promise;
      await requestControl(config.repository, {
        objective: 1,
        action: "handoff",
      });
      release.resolve();
      const error = await outcome;
      assert.equal(error.constructor.name, "CoordinatorHandoff");
      const state = readContinuation(config.repository, 1);
      assert.equal(state.coordinator.mode, "draining");
      assert.equal(state.cancelRequested, undefined);
      assert.equal(state.cancelledAt, undefined);
      assert.deepEqual(state.issueByItemId, {});
      assert.equal(
        existsSync(join(stateRoot(config.repository), "controller.lock")),
        false,
      );
    },
    (graph) => ({
      generateStructured: async (request) => {
        started.resolve();
        await release.promise;
        return withCoverage(request, graph);
      },
      reviewGraph: async (request) => ({
        packetId: request.reviewPacket.id,
        findings: [],
      }),
    }),
  );
});

test("handoff settles an already running worker and preserves its attempt instead of cancellation", async () => {
  await fixture(
    "handoff-worker",
    async ({ application, config, descriptor, eventsPath, root }) => {
      const barrier = join(root, "barrier", "go");
      descriptor.actions.result.barrier = barrier;
      const running = application.runObjective(1);
      await until(() =>
        readEvents(eventsPath).some((event) => event.type === "start"),
      );
      const attempt = readState(config.repository, 1).work.result.attemptId;
      await requestControl(config.repository, {
        objective: 1,
        action: "handoff",
      });
      assert.equal(
        existsSync(join(stateRoot(config.repository), "controller.lock")),
        true,
      );
      mkdirSync(join(root, "barrier"), { recursive: true });
      writeFileSync(barrier, "go");
      await assert.rejects(
        running,
        (error) => error.constructor.name === "CoordinatorHandoff",
      );
      // A handoff stops at the next safe point after the worker settled
      // (contract 3): delivery stops at its CI wait, not done.
      const state = readState(config.repository, 1);
      assert.equal(state.work.result.attemptId, attempt);
      assert.equal(state.cancelledAt, undefined);
      assert.equal(state.cancelRequested, undefined);
      assert.equal(state.work.result.status, "published");
      assert.equal(state.work.result.wait?.kind, "ci");
      const starts = () =>
        readEvents(eventsPath).filter((event) => event.type === "start").length;
      const cancels = () =>
        readEvents(eventsPath).filter((event) => event.type === "cancel")
          .length;
      assert.equal(starts(), 1);
      assert.equal(cancels(), 0);
      assert.equal(
        existsSync(join(stateRoot(config.repository), "controller.lock")),
        false,
      );
      await controlObjective(config, { objective: 1, action: "resume" });
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.work.result.status, "done");
      assert.equal(completed.work.result.attemptId, attempt);
      assert.equal(starts(), 1);
      assert.equal(cancels(), 0);
    },
  );
});

test("SIGTERM before the first snapshot persists drain and starts no planning or worker", async () => {
  await fixture(
    "handoff-before-snapshot",
    async ({ application, config, github, eventsPath, planningPath }) => {
      const entered = deferred(),
        release = deferred();
      const original = github.objective.bind(github);
      github.objective = async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      };
      const running = application.runObjective(1);
      const rejected = assert.rejects(
        running,
        (error) => error.constructor.name === "CoordinatorHandoff",
      );
      await entered.promise;
      assert.equal(readContinuation(config.repository, 1), undefined);
      process.emit("SIGTERM");
      release.resolve();
      await rejected;
      const state = readContinuation(config.repository, 1);
      assert.equal(state.coordinator.mode, "draining");
      assert.equal(state.plan, undefined);
      assert.equal(state.cancelRequested, undefined);
      assert.equal(
        readEvents(eventsPath).filter((event) => event.type === "start").length,
        0,
      );
      assert.equal(readEvents(planningPath).length, 0);
      assert.equal(
        existsSync(join(stateRoot(config.repository), "controller.lock")),
        false,
      );
    },
  );
});

test("native handoff retains a known published layer and resumes its pending successor without replay", async () => {
  await fixture(
    "handoff-native-layer",
    async ({ application, config, github, eventsPath }) => {
      const original = github.publish.bind(github);
      let requested = false;
      github.publish = async (request) => {
        const published = await original(request);
        if (!requested) {
          requested = true;
          await requestControl(config.repository, {
            objective: 1,
            action: "handoff",
          });
        }
        return published;
      };
      await assert.rejects(
        application.runObjective(1),
        (error) => error.constructor.name === "CoordinatorHandoff",
      );
      const paused = readState(config.repository, 1);
      assert.equal(paused.work.result.status, "published");
      assert.equal(paused.work.next.status, "pending");
      assert.ok(paused.work.result.pullRequest);
      assert.equal(paused.work.result.pendingEffect, undefined);
      assert.equal(
        existsSync(join(stateRoot(config.repository), "controller.lock")),
        false,
      );
      assert.equal(
        readEvents(eventsPath).filter((event) => event.type === "start").length,
        1,
      );
      const identity = {
        attemptId: paused.work.result.attemptId,
        pullRequest: paused.work.result.pullRequest,
        changeRef: paused.work.result.changeRef,
      };
      await controlObjective(config, { objective: 1, action: "resume" });
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      assert.deepEqual(
        {
          attemptId: completed.work.result.attemptId,
          pullRequest: completed.work.result.pullRequest,
          changeRef: completed.work.result.changeRef,
        },
        identity,
      );
      assert.equal(
        readEvents(eventsPath).filter(
          (event) => event.type === "start" && event.item === "result",
        ).length,
        1,
      );
      assert.equal(
        readEvents(eventsPath).filter(
          (event) => event.type === "start" && event.item === "next",
        ).length,
        1,
      );
    },
    undefined,
    (descriptor) => {
      descriptor.config.delivery.kind = "native-stack";
      descriptor.graph.items.push({
        ...structuredClone(descriptor.graph.items[0]),
        id: "next",
        title: "Next",
        goal: "Write next.txt",
        brief: "Write next.txt",
        acceptance: ["next.txt exists"],
        dependencies: ["result"],
        ownedPaths: ["next.txt"],
        validation: [
          {
            command: "test -s next.txt",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
      });
      descriptor.objectiveBody +=
        "\n## Successor validation\n- `test -s next.txt`\n";
      descriptor.actions.next = {
        files: [{ path: "next.txt", text: "next\n" }],
      };
    },
  );
});

test("an item's defect stops only that item; a healthy sibling worker runs on uncancelled and uncharged", async () => {
  await fixture(
    "sibling-defect",
    async ({ application, config, driver, eventsPath, root }) => {
      const barrier = join(root, "barrier", "go");
      const started = (item) =>
        readEvents(eventsPath).some(
          (event) => event.type === "start" && event.item === item,
        );
      const collect = driver.collect.bind(driver);
      driver.collect = async (handle, context) => {
        const owner = Object.entries(
          readState(config.repository, 1)?.work ?? {},
        ).find(([, work]) => work.execution?.identity === handle.identity);
        if (owner?.[0] === "result") {
          await until(() => started("other"));
          // An unclassified error: a defect of this item only.
          throw new Error("Selected AssetSet or captured change is missing");
        }
        return collect(handle, context);
      };
      const running = application.runObjective(1).catch((error) => error);
      // The sibling finishes only after the defective item stopped.
      await until(
        () => readState(config.repository, 1)?.work.result.status === "failed",
      );
      mkdirSync(join(root, "barrier"), { recursive: true });
      writeFileSync(barrier, "go");
      await running;
      const state = readState(config.repository, 1);
      assert.equal(state.work.result.status, "failed");
      assert.equal(state.work.result.recovery.failure.classification, "defect");
      // The sibling was not cancelled, failed, charged or diagnosed.
      assert.equal(
        readEvents(eventsPath).some(
          (event) => event.type === "cancel" && event.item === "other",
        ),
        false,
      );
      assert.notEqual(state.work.other.status, "failed");
      assert.equal(state.work.other.recovery, undefined);
      assert.equal(state.charges, undefined);
      assert.equal(state.coordinator.cancelError, undefined);
    },
    undefined,
    (descriptor) => {
      const [first] = descriptor.graph.items;
      descriptor.graph.items.push({
        ...first,
        id: "other",
        title: "Other",
        goal: "Write other.txt",
        brief: "Write other.txt",
        acceptance: ["other.txt exists"],
        ownedPaths: ["other.txt"],
        validation: [
          {
            command: "test -s other.txt",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
      });
      descriptor.objectiveBody =
        "## Acceptance\n- `test -s result.txt`\n- `test -s other.txt`\n\n## Final validation\n- `test -s result.txt`\n";
      descriptor.actions.other = {
        barrier: join(descriptor.fakeRoot, "..", "barrier", "go"),
        files: [{ path: "other.txt", text: "done\n" }],
      };
    },
  );
});
