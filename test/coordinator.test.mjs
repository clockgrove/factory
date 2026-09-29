import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import { requestControl } from "../dist/coordinator-control.js";
import { controlObjective } from "../dist/runner.js";
import {
  readContinuation,
  readState,
  saveState,
  statePath,
} from "../dist/state-store.js";
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
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Fixture condition not reached");
}
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

test("planning submission persists before provider entry and owner remains responsive; cancellation cannot publish a late result", async () => {
  const pending = deferred();
  let calls = 0;
  await fixture(
    "planning",
    async ({ application, config, github }) => {
      const running = application.runObjective(1);
      const rejected = assert.rejects(running, /cancellation requested/);
      await until(
        () => readContinuation(config.repository, 1)?.planning === "submitted",
      );
      const snapshot = readContinuation(config.repository, 1);
      assert.equal(snapshot.schemaVersion, 3);
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
      assert.equal(
        readContinuation(config.repository, 1).cancelledAt,
        undefined,
      );
      assert.match(
        readContinuation(config.repository, 1).coordinator.cancelError,
        /unknown outcome/,
      );
      pending.resolve();
      await rejected;
      assert.equal(calls, 1);
      assert.equal(Object.keys(github.state().issues).length, 0);
    },
    (graph) => ({
      async generateStructured() {
        calls++;
        await pending.promise;
        return graph;
      },
      async reviewGraph() {
        return { findings: [] };
      },
    }),
  );
});

test("partial projection saves each known identity and resumes without planning again", async () => {
  await fixture(
    "partial",
    async ({ application, config, github, planningPath }) => {
      const original = github.projectGraph.bind(github);
      let once = true;
      github.projectGraph = async (request) => {
        if (once) {
          once = false;
          await request.beforeCreate("result");
          request.projected("result", 42);
          throw new Error("API interruption after known issue");
        }
        assert.deepEqual(request.knownIssues, { result: 42 });
        return original(request);
      };
      await assert.rejects(application.runObjective(1), /API interruption/);
      const saved = readContinuation(config.repository, 1);
      assert.equal(saved.planning, "complete");
      assert.deepEqual(saved.issueByItemId, { result: 42 });
      const before = readEvents(planningPath).length;
      await application.runObjective(1);
      assert.equal(
        readEvents(planningPath).filter((e) => e.type !== "result-review")
          .length,
        readEvents(planningPath)
          .slice(0, before)
          .filter((e) => e.type !== "result-review").length,
      );
    },
  );
});

test("unknown projection acknowledgement stops restart without another create", async () => {
  await fixture("unknown", async ({ application, config, github }) => {
    let creates = 0;
    github.projectGraph = async (request) => {
      await request.beforeCreate("result");
      creates++;
      throw new Error("lost create reply");
    };
    await assert.rejects(application.runObjective(1), /lost create reply/);
    assert.equal(
      readContinuation(config.repository, 1).projectionPending,
      "result",
    );
    await assert.rejects(
      application.runObjective(1),
      /preparation stopped|unknown outcome/,
    );
    assert.equal(creates, 1);
  });
});

test("pause and drain persist offline and resume keeps the original deadline", async () => {
  await fixture("modes", async ({ application, config, github }) => {
    github.projectGraph = async () => {
      throw new Error("offline");
    };
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    await assert.rejects(
      application.runObjective(1, undefined, undefined, { deadlineAt }),
      /offline/,
    );
    await controlObjective(config, { objective: 1, action: "drain" });
    assert.equal(
      readContinuation(config.repository, 1).coordinator.mode,
      "draining",
    );
    await assert.rejects(
      application.runObjective(1, undefined, undefined, {
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
      const running = application.runObjective(1, undefined, undefined, {
        deadlineAt: new Date(Date.now() + 300).toISOString(),
      });
      const rejected = assert.rejects(running, /cancellation requested/);
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
      async generateStructured() {
        await pending.promise;
        return graph;
      },
      async reviewGraph() {
        return { findings: [] };
      },
    }),
  );
});

test("exact-ID API outage keeps the owner responsive and resumes without new planning", async () => {
  await fixture(
    "outage",
    async ({ application, config, github, planningPath }) => {
      const original = github.objective.bind(github);
      let reads = 0;
      let offline = true;
      github.objective = async (...args) => {
        reads++;
        if (reads > 1 && offline) throw new Error("API unavailable");
        return original(...args);
      };
      const run = application.runObjective(1);
      await until(
        () =>
          readContinuation(config.repository, 1)?.coordinator.observationError,
      );
      const before = readEvents(planningPath).length;
      const status = await requestControl(config.repository, {
        objective: 1,
        action: "status",
      });
      assert.equal(status.result.mode, "paused");
      assert.match(status.result.waitReason, /GitHub API unavailable/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(readEvents(planningPath).length, before);
      assert.equal(reads, 2, "no blind API polling");
      offline = false;
      await requestControl(config.repository, {
        objective: 1,
        action: "resume",
      });
      assert.equal((await run).finalValidation.passed, true);
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
        await assert.rejects(
          application.runObjective(1),
          /confirmed closed|body changed/,
        );
        assert.equal(
          readEvents(eventsPath).filter((event) => event.type === "start")
            .length,
          0,
        );
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
        ++reads > 1 ? Promise.reject(new Error("offline")) : original(...args);
      const run = application.runObjective(1);
      const rejected = assert.rejects(run, /cancel/);
      await until(
        () =>
          readContinuation(config.repository, 1)?.coordinator.observationError,
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

test("admitted drain stays idle under the owner and resumes its pending graph", async () => {
  await fixture(
    "admitted-drain",
    async ({ application, config, github, planningPath }) => {
      const candidate = await application.planObjective(1);
      const admission = await application.admitObjective(1, candidate, {
        schemaVersion: 1,
        actor: "fixture",
        reason: "control regression",
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
      });
      const original = github.projectGraph.bind(github);
      github.projectGraph = async (request) => {
        const result = await original(request);
        await requestControl(config.repository, {
          objective: 1,
          action: "drain",
        });
        return result;
      };
      const run = application.runObjective(1, candidate, admission);
      await until(
        () => readContinuation(config.repository, 1)?.schemaVersion === 2,
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

test("resumed preparation retains its admitted policy without requiring command-line authority again", async () => {
  await fixture(
    "admission-restart",
    async ({ application, config, github }) => {
      const candidate = await application.planObjective(1);
      const admission = await application.admitObjective(1, candidate, {
        schemaVersion: 1,
        actor: "fixture",
        reason: "restart binding",
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
      });
      const original = github.projectGraph.bind(github);
      github.projectGraph = async () => {
        throw new Error("projection observation unavailable");
      };
      await assert.rejects(
        application.runObjective(1, candidate, admission),
        /projection observation/,
      );
      assert.equal(
        readContinuation(config.repository, 1).admission.digest,
        admission.digest,
      );
      github.projectGraph = original;
      const completed = await application.runObjective(1);
      assert.equal(completed.admission.digest, admission.digest);
      assert.equal(completed.finalValidation.passed, true);
    },
  );
});

test("regular and native cancellation preserves unknown publication without terminal success or replay", async () => {
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
        const rejected = assert.rejects(run, /acknowledgement lost/);
        await until(() => creates === 1);
        await requestControl(config.repository, {
          objective: 1,
          action: "cancel",
        });
        await until(
          () => readState(config.repository, 1)?.coordinator.cancelError,
        );
        assert.match(
          readState(config.repository, 1).coordinator.cancelError,
          /publication.*unknown/,
        );
        pending.resolve();
        await rejected;
        const state = readState(config.repository, 1);
        assert.equal(state.cancelledAt, undefined);
        assert.equal(state.work.result.pendingEffect, "publication");
        await assert.rejects(application.runObjective(1), /cancel/);
        assert.equal(creates, 1);
        assert.equal(
          Object.values(github.state().pullRequests).some(
            (pr) => pr.state === "merged",
          ),
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
        const paused = await run;
        assert.equal(paused.work.result.status, "pending");
        assert.equal(
          readEvents(eventsPath).filter((event) => event.type === "start")
            .length,
          0,
        );
      },
    );
});

test("pause during planning stops issue projection until resumed or cancelled", async () => {
  const pending = deferred();
  await fixture(
    "pause-planning",
    async ({ application, config, github }) => {
      const run = application.runObjective(1);
      const rejected = assert.rejects(run, /cancel/);
      await until(
        () => readContinuation(config.repository, 1)?.planning === "submitted",
      );
      await requestControl(config.repository, {
        objective: 1,
        action: "pause",
      });
      pending.resolve();
      await until(
        () => readContinuation(config.repository, 1)?.planning === "complete",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(Object.keys(github.state().issues).length, 0);
      await requestControl(config.repository, {
        objective: 1,
        action: "cancel",
      });
      await rejected;
      assert.ok(readContinuation(config.repository, 1).cancelledAt);
    },
    (graph) => ({
      async generateStructured() {
        await pending.promise;
        return graph;
      },
      async reviewGraph() {
        return { findings: [] };
      },
    }),
  );
});

test("first deadline added to existing preparation persists before a wait and cannot be extended", async () => {
  await fixture("deadline-add", async ({ application, config, github }) => {
    github.projectGraph = async () => {
      throw new Error("offline projection");
    };
    await assert.rejects(application.runObjective(1), /offline projection/);
    await controlObjective(config, { objective: 1, action: "pause" });
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const run = application.runObjective(1, undefined, undefined, {
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
      application.runObjective(1, undefined, undefined, {
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      }),
      /cannot be replaced/,
    );
  });
});

test("one resume wakes both concurrent GitHub outage waiters without replaying workers", {
  timeout: 10_000,
}, async () => {
  await fixture(
    "concurrent-outage",
    async ({ application, config, github, eventsPath }) => {
      const original = github.objective.bind(github);
      let reads = 0;
      let offline = true;
      github.objective = async (...args) => {
        reads++;
        if (reads >= 3 && offline) throw new Error("shared outage");
        return original(...args);
      };
      const run = application.runObjective(1);
      await until(() => reads >= 4);
      offline = false;
      await requestControl(config.repository, {
        objective: 1,
        action: "resume",
      });
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

test("response-less result review preserves unknown effect and refuses implementation retry", async () => {
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
        assert.equal(state.work.result.pendingEffect, "review");
        assert.equal(state.work.result.acceptancePending, undefined);
        assert.throws(
          () => application.retryWorkItem(1, "result"),
          /Submitted effect outcome is unknown/,
        );
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
        await assert.rejects(
          application.runObjective(1),
          /criterion disproved/,
        );
        const state = readState(config.repository, 1);
        assert.equal(state.work.result.pendingEffect, undefined);
        assert.equal(state.work.result.status, "failed");
      },
      undefined,
      (descriptor) => {
        descriptor.resultReviewer = async (request) => ({
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
      generateStructured: async () => {
        started.resolve();
        await release.promise;
        return graph;
      },
      reviewGraph: async () => ({ findings: [] }),
    }),
  );
});
