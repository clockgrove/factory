import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commandAuthority,
  compileObjective,
  objectiveCriteria,
  planningSources,
  validateCommandProvenance,
} from "../dist/compiler.js";
import { runNativeGraph } from "../dist/delivery/native-runner.js";
import { linearDeliveryUnits } from "../dist/delivery/plan.js";
import {
  assertCompletedCoverage,
  assertCoverageShape,
  assertCoverageSources,
  coverageObligations,
} from "../dist/qa.js";
import { installedControllerCapabilities } from "../dist/controller-capabilities.js";
import { runQaItem } from "../dist/qa-execution.js";
import { readyItems, validateAndOrderGraph } from "../dist/scheduler.js";
import { readContinuation, readState } from "../dist/state-store.js";
import { attachFault } from "../dist/fault.js";
import { controlObjective } from "../dist/runner.js";
import { workItemReviewEvidence } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";
import { compilePlan, planningDiagnosis } from "./support/plan.mjs";

/** The run's snapshot once planning is done; undefined while it prepares. */
function runSnapshot(repository) {
  const state = readContinuation(repository, 1);
  return state?.kind === "preparing" ? undefined : state;
}

async function until(check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function work(id, dependencies = []) {
  return {
    id,
    kind: "work",
    title: id,
    goal: id,
    acceptance: [`${id} proof`],
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
    brief: id,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}
const body = `# Public multi-item QA fixture
## Acceptance
- unit behavior is proven
- integrated behavior is proven
- actual real-environment readiness is proven
- dependency versions pass the named CI job
## Commands
- test -s unit.txt
- test -s integration.txt
- test -s real-environment.txt
## Final validation
- test -s integration.txt
## Required checks
- dependency-version-test
`;
function graph(baseSha, text = body) {
  const unit = work("unit");
  const integration = work("integration", ["unit"]);
  const qa = {
    ...work("qa", ["integration"]),
    kind: "qa",
    ownedPaths: [],
    acceptance: ["real environment and exact named CI proof"],
    validation: [
      {
        command: "test -s real-environment.txt",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
  };
  const obligations = coverageObligations(text, objectiveCriteria(text));
  const entry = (
    i,
    itemId,
    phase,
    kind,
    reference,
    environment = {
      kind: "local",
      readiness: "available",
      probe: "",
      preparedBy: "",
    },
  ) => ({
    ...obligations[i],
    itemId,
    proof:
      kind === "command"
        ? { kind: `${phase}-command`, validationIndex: 0 }
        : kind === "ci"
          ? { kind: `${phase}-ci`, checkName: reference }
          : { kind: `${phase}-semantic`, acceptanceIndex: Number(reference) },
    environment,
  });
  return {
    objective: 1,
    baseSha,
    items: [unit, integration, qa],
    coverage: [
      entry(0, "unit", "result", "command", "test -s unit.txt"),
      entry(1, "integration", "result", "command", "test -s integration.txt"),
      entry(2, "qa", "integrated", "command", "test -s real-environment.txt", {
        kind: "real",
        readiness: "available",
        probe: "test -s real-environment.txt",
        preparedBy: "",
      }),
      entry(3, "qa", "integrated", "ci", "dependency-version-test"),
    ],
  };
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-qa-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("published ordinary proof is rejected at planning and completion instead of bypassing integrated freshness", () => {
  for (const ownerKind of ["qa", "aggregate"]) {
    for (const oracleKind of ["command", "semantic"]) {
      const value = graph("a".repeat(40));
      const owner = value.items[2];
      owner.kind = ownerKind;
      const entry = value.coverage[2];
      value.coverage = [entry];
      entry.proof =
        oracleKind === "command"
          ? { kind: "published-command", validationIndex: 0 }
          : { kind: "published-semantic", acceptanceIndex: 0 };
      assert.throws(
        () => assertCoverageShape(value),
        /published ordinary proof is unsupported/,
      );
      const treeSha = "c".repeat(40);
      const state = {
        graph: value,
        integratedSha: "b".repeat(40),
        work: {
          qa: {
            status: "done",
            changeRef: "a".repeat(40),
            treeSha,
            validation: {
              treeSha,
              commands: [
                { command: owner.validation[0].command, treeSha, passed: true },
              ],
              criteria: [{ criterion: owner.acceptance[0], verdict: "pass" }],
            },
          },
        },
      };
      assert.throws(
        () => assertCompletedCoverage(state),
        /published ordinary proof is unsupported/,
      );
    }
  }
});

test("published named CI retains the real dependency head instead of claiming integrated proof", () => {
  const value = graph("a".repeat(40));
  const entry = value.coverage[3];
  value.coverage = [entry];
  entry.proof = {
    kind: "published-ci",
    checkName: entry.proof.checkName,
    targetItem: "integration",
  };
  assertCoverageShape(value);
  const treeSha = "c".repeat(40);
  const headSha = "d".repeat(40);
  const state = {
    graph: value,
    integratedSha: "b".repeat(40),
    work: {
      integration: { changeRef: headSha },
      qa: {
        status: "done",
        changeRef: "a".repeat(40),
        treeSha,
        validation: { treeSha, commands: [] },
        qaChecks: [
          {
            id: 1,
            name: entry.proof.checkName,
            headSha,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    },
  };
  assertCompletedCoverage(state);
  state.work.integration.changeRef = "e".repeat(40);
  assert.throws(
    () => assertCompletedCoverage(state),
    /named CI proof is missing or stale/,
  );
});

test("coverage rejects missing, unknown, premature and unready proof without weakening commands", async () =>
  fixture(async (root) => {
    const target = createTarget(root, {
      "real-environment.txt": "actual local fixture resource",
    });
    const good = graph(target.baseSha);
    const sources = [{ path: "OBJECTIVE", content: body }];
    const check = (value) => {
      validateAndOrderGraph(value, 1, target.baseSha, new Set(["OBJECTIVE"]));
      assertCoverageSources(
        value,
        sources,
        coverageObligations(body, objectiveCriteria(body)),
      );
    };
    check(good);
    for (const [mutate, message] of [
      [(value) => value.coverage.pop(), /Uncovered/],
      [(value) => (value.coverage[0].itemId = "unknown"), /owner/],
      [
        (value) => (value.coverage[2].proof.kind = "result-command"),
        /feasible/,
      ],
      [(value) => (value.items[2].dependencies = []), /dependencies/],
      [
        (value) => (value.coverage[2].environment.readiness = "missing"),
        /Missing external/,
      ],
      [
        (value) => {
          value.coverage[2].environment.readiness = "prepare";
          value.coverage[2].environment.preparedBy = "unapproved";
        },
        /authorized dependency/,
      ],
      [
        (value) => (value.coverage[0].source.digest = "f".repeat(64)),
        /Uncovered/,
      ],
      [
        (value) =>
          (value.coverage[0].proof.validationIndex = "npm run invented"),
        /validation command/,
      ],
    ]) {
      const value = structuredClone(good);
      mutate(value);
      assert.throws(() => check(value), message);
    }
    const unauthorized = structuredClone(good);
    unauthorized.items[2].validation[0].command = "npm run invented";
    assert.throws(
      () => validateCommandProvenance(unauthorized, sources, target.checkout),
      /no exact/,
    );
    assert.deepEqual(
      readyItems(
        good,
        {
          unit: { status: "pending" },
          integration: { status: "pending" },
          qa: { status: "pending" },
        },
        new Set(),
        3,
      ).map((item) => item.id),
      ["unit"],
    );
    assert.deepEqual(
      linearDeliveryUnits(good).map((unit) =>
        unit.items.map((item) => item.id),
      ),
      [["unit", "integration"], ["qa"]],
    );
    await assert.rejects(
      compileObjective(1, body, target.baseSha, target.checkout, {
        async generateStructured() {
          const value = graph(target.baseSha);
          delete value.coverage;
          return value;
        },
      }),
      /coverage.*nonempty/,
    );
  }));

test("a command obligation is proved by exactly that command; other obligations are semantic", () => {
  const guarantee = installedControllerCapabilities().guarantees[0].id;
  const check = (
    criterion,
    proof,
    runs = ["test -s unit.txt"],
    isCommand = undefined,
  ) => {
    const objective = `## Acceptance\n- ${criterion}\n## Final validation\n- \`test -s final.txt\`\n`;
    const obligations = coverageObligations(
      objective,
      objectiveCriteria(objective),
    );
    const unit = work("unit");
    unit.validation = runs.map((command) => ({
      command,
      provenance: "source-declared",
      source: "OBJECTIVE",
    }));
    assertCoverageSources(
      {
        objective: 1,
        baseSha: "a".repeat(40),
        items: [unit],
        coverage: [
          {
            ...obligations[0],
            itemId: "unit",
            proof,
            environment: {
              kind: "local",
              readiness: "available",
              probe: "",
              preparedBy: "",
            },
          },
        ],
      },
      [{ path: "OBJECTIVE", content: objective }],
      obligations,
      ["test -s final.txt"],
      isCommand,
    );
  };
  const command = (validationIndex = 0) => ({
    kind: "result-command",
    validationIndex,
  });
  const refused = (name) =>
    new RegExp(
      `obligation \`${name.replace(/[-.*+?^${}()|[\]\\]/g, "\\$&")}\` is a command, so its proof must be a result-command or integrated-command whose validationIndex selects exactly`,
    );
  // A bullet that is exactly one command: proved by that command, or by
  // anything when Final validation runs it.
  check("`test -s unit.txt`", command());
  check("`test  -s unit.txt`", command());
  check("test -s unit.txt", command());
  check("`test -s final.txt`", { kind: "final-review" });
  for (const proof of [
    { kind: "final-review" },
    { kind: "final-controller", guaranteeId: guarantee },
    { kind: "result-semantic", acceptanceIndex: 0 },
  ]) {
    assert.throws(
      () => check("`test -s unit.txt`", proof),
      refused("test -s unit.txt"),
    );
    assert.throws(
      () => check("test -s unit.txt", proof),
      refused("test -s unit.txt"),
    );
  }
  // The proof must select that exact command, not another the item runs.
  assert.throws(
    () =>
      check("`npm test -- --coverage`", command(0), [
        "npm test",
        "npm test -- --coverage",
      ]),
    refused("npm test -- --coverage"),
  );
  check("`npm test -- --coverage`", command(1), [
    "npm test",
    "npm test -- --coverage",
  ]);
  // A command with authority that no item runs, and Final validation does
  // not, cannot be proved; without authority the bullet is semantic.
  const lint = (command, backticked) =>
    backticked && command === "npm run lint";
  assert.throws(
    () => check("`npm run lint`", { kind: "final-review" }, [], lint),
    refused("npm run lint"),
  );
  check("`npm run lint`", { kind: "final-review" }, []);
  check("`README.md`", { kind: "final-review" }, [], lint);
  // Any other wording is semantic: the planner's proof choice stands and
  // review judges whether it fits.
  for (const criterion of [
    "`test -s unit.txt` passes",
    "README documents how to run `npm test`",
    "`npm run lint` and `test -s unit.txt` pass",
  ])
    check(criterion, { kind: "final-review" });
});

test("a backticked bullet is a command only with authority beyond itself", async () =>
  fixture(async (root) => {
    const target = createTarget(root, {
      "package.json": JSON.stringify({ scripts: { lint: "true" } }),
      "docs/run.md": "# Run\n\n- `test -s docs.txt`\n",
    });
    const objective = [
      "## Acceptance",
      "- `npm run lint`",
      "- `README.md`",
      "- `test -s docs.txt`",
      "- `echo only-here`",
      "- `test -s twice.txt`",
      "- `test -s final.txt`",
      "",
      "## Validation",
      "- `test -s twice.txt`",
      "",
      "## Final validation",
      "- `test -s final.txt`",
      "",
      "## Planning sources",
      "- docs/run.md",
      "- `README.md`",
      "",
      "## Required checks",
      "- `npm run lint`",
      "",
    ].join("\n");
    const sources = planningSources(objective, target.baseSha, target.checkout);
    const isCommand = commandAuthority(
      objective,
      sources,
      target.baseSha,
      target.checkout,
    );
    // A package script at the base, a line declared in another source or
    // section, and a Final validation command have authority.
    for (const command of [
      "npm run lint",
      "test -s docs.txt",
      "test -s twice.txt",
      "test -s final.txt",
    ])
      assert(isCommand(command, true), command);
    // A bullet that only declares itself, or a line repeated as prose or as a
    // planning source, is a semantic obligation. A plan that runs it gives it
    // no authority: commandAuthority never sees the plan.
    for (const command of ["README.md", "echo only-here", "npm run missing"])
      assert(!isCommand(command, true), command);
    assert(!isCommand("test -s docs.txt", false));
  }));

for (const delivery of ["regular", "native"])
  test(`${delivery} executes multi-item QA after integration with no worker or empty PR`, async () =>
    fixture(async (root) => {
      const target = createTarget(root, {
        "real-environment.txt": "actual local fixture resource",
      });
      let qaPacket;
      const value = graph(target.baseSha);
      value.items[2].acceptance[0] +=
        "; if the check fails, retain the failure for authorized correction";
      const { application, github, eventsPath } = makeApplication({
        config: factoryConfig(
          target.checkout,
          `example/qa-${delivery}`,
          delivery,
        ),
        graph: value,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          unit: { files: [{ path: "unit.txt", text: "unit" }] },
          integration: {
            files: [{ path: "integration.txt", text: "integration" }],
          },
        },
        resultReviewer(request) {
          if (request.criteria.includes(value.items[2].acceptance[0])) {
            qaPacket = request;
            const observation = JSON.parse(request.observations);
            assert.equal(observation.delivery.kind, "read-only-proof");
            assert.equal(observation.reviewedItemId, "qa");
            assert.equal(
              observation.validationPhase.kind,
              "post-integration-read-only",
            );
            assert.equal(observation.validationPhase.worker, false);
            assert.equal(observation.validationPhase.pullRequest, false);
            assert.equal(
              observation.validationPhase.selectedIntegratedCommitSha,
              observation.currentIntegratedCommitSha,
            );
            assert.equal(
              observation.validationPhase.selectedIntegratedTreeSha,
              request.treeSha,
            );
            assert.deepEqual(
              observation.validationPhase.commands,
              request.commands,
            );
            assert.ok(request.commands.every((command) => command.passed));
            assert.ok(
              !request.reviewPacket.evidence.some((source) =>
                source.path.startsWith("Retained repair proof:"),
              ),
            );
            const proof = JSON.parse(
              request.evidence.find(
                (source) => source.path === "Read-only QA proof: qa",
              ).content,
            );
            assert.equal(
              proof.attemptId,
              observation.validationPhase.attemptId,
            );
            assert.equal(
              proof.selectedIntegratedCommitSha,
              observation.currentIntegratedCommitSha,
            );
          }
          return {
            packetId: request.reviewPacket.id,
            findings: resultFindings(
              request,
              request.criteria.map((criterion) => ({
                criterion,
                source:
                  request === qaPacket ? "Read-only QA proof: qa" : "OBJECTIVE",
                verdict: "pass",
                detail:
                  "Actual passing conditional check and exact phase proof; no failed execution is required by this condition.",
                question: "",
              })),
            ),
          };
        },
      });
      const observed = [];
      github.namedCheck = async (headSha, name) => {
        observed.push({ headSha, name });
        return {
          id: 71,
          headSha,
          name,
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.com/example/check/71",
        };
      };
      const plan = await application.planObjective(1);
      assert.equal(plan.review.status, "clean");
      const state = await application.runObjective(1);
      assert.equal(state.finalValidation.passed, true);
      assert.equal(state.work.qa.status, "done");
      assert.equal(state.work.qa.pullRequest, undefined);
      assert.equal(state.work.qa.execution, undefined);
      assert.equal(state.work.qa.changeRef, state.integratedSha);
      assert.ok(qaPacket);
      const stale = structuredClone(state);
      stale.integratedSha = target.baseSha;
      assert.throws(
        () =>
          workItemReviewEvidence({
            state: stale,
            item: value.items[2],
            checkout: target.checkout,
            delivery: delivery === "regular" ? "regular" : "native-stack",
          }),
        /selected integration is stale/,
      );
      const missing = structuredClone(state);
      delete missing.work.integration.integratedSha;
      assert.throws(
        () =>
          workItemReviewEvidence({
            state: missing,
            item: value.items[2],
            checkout: target.checkout,
            delivery: delivery === "regular" ? "regular" : "native-stack",
          }),
        /lacks a completed delivery result/,
      );
      assert.deepEqual(
        readEvents(eventsPath)
          .filter((event) => event.type === "start")
          .map((event) => event.item),
        ["unit", "integration"],
      );
      assert.deepEqual(observed, [
        { headSha: state.integratedSha, name: "dependency-version-test" },
      ]);
      assertCompletedCoverage(state);
      const staleCoverage = structuredClone(state);
      staleCoverage.integratedSha = "a".repeat(40);
      assert.throws(() => assertCompletedCoverage(staleCoverage), /stale/);
    }));

test("a job renamed on main after merge does not stop QA whose CI proof is bound to its own commit", async () =>
  fixture(async (root) => {
    const workflow = ".github/workflows/ci.yml";
    const target = createTarget(root, {
      "real-environment.txt": "actual local fixture resource",
      [workflow]:
        "name: CI\non: pull_request\njobs:\n  dependency-version-test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    });
    // The check is bound by the workflow job alone.
    const objectiveBody = body.replace(
      "## Required checks\n- dependency-version-test\n",
      "",
    );
    const { application, github } = makeApplication({
      config: factoryConfig(target.checkout, "example/qa-renamed-on-main"),
      graph: graph(target.baseSha, objectiveBody),
      objectiveBody,
      fakeRoot: join(root, "fake"),
      actions: {
        unit: { files: [{ path: "unit.txt", text: "unit" }] },
        integration: {
          files: [{ path: "integration.txt", text: "integration" }],
        },
      },
    });
    const calls = [];
    let reported = false;
    github.namedCheck = async (headSha, name) => {
      calls.push(headSha);
      if (calls.length === 1) {
        // The proof starts waiting; meanwhile main renames the job.
        const clone = join(root, "rename");
        git(root, "clone", join(root, "origin.git"), clone);
        const file = join(clone, workflow);
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(
            "dependency-version-test:",
            "renamed:",
          ),
        );
        git(clone, "add", "-A");
        git(
          clone,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Rename the job",
        );
        git(clone, "push", "origin", "main");
      }
      return {
        id: 73,
        headSha,
        name,
        status: reported ? "completed" : "in_progress",
        conclusion: "success",
        detailsUrl: "https://github.com/example/check/73",
      };
    };
    const running = application.runObjective(1);
    const waiting = await until(() => {
      const state = runSnapshot("example/qa-renamed-on-main");
      return state?.work.qa.wait?.kind === "ci" ? state : undefined;
    });
    assert.equal(waiting.work.qa.wait.kind, "ci");
    reported = true;
    // The resumed validation does not read the renamed tip: QA finishes its
    // own item. (Main moving past the candidate is a separate, ordinary
    // staleness of the final result, so the run itself is not awaited.)
    const done = await until(() => {
      const state = runSnapshot("example/qa-renamed-on-main");
      return state?.work.qa.status === "done" ? state : undefined;
    });
    assert.notEqual(done.work.qa.wait?.kind, "decision");
    assert.ok(calls.length >= 2);
    await running.catch(() => {});
  }));

for (const failure of ["missing", "pending", "failure", "stale", "unrelated"])
  test(`local success cannot finish with ${failure} named CI evidence`, async () =>
    fixture(async (root) => {
      const target = createTarget(root, {
        "real-environment.txt": "actual local fixture resource",
      });
      const { application, github } = makeApplication({
        config: factoryConfig(target.checkout, `example/qa-${failure}`),
        graph: graph(target.baseSha),
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {
          unit: {
            files: [{ path: "unit.txt", text: "local dependency v1 passes" }],
          },
          integration: {
            files: [
              { path: "integration.txt", text: "local integration passes" },
            ],
          },
        },
      });
      github.namedCheck = async (headSha, name) =>
        failure === "missing"
          ? undefined
          : {
              id: 72,
              headSha: failure === "stale" ? "f".repeat(40) : headSha,
              name: failure === "unrelated" ? "other-job" : name,
              status: failure === "pending" ? "in_progress" : "completed",
              conclusion: failure === "failure" ? "failure" : "success",
              detailsUrl: "https://github.com/example/check/72",
            };
      if (["missing", "pending"].includes(failure)) {
        // The run stays alive through the readiness wait and polls again.
        const running = application.runObjective(1);
        const waiting = await until(() => {
          const state = runSnapshot(`example/qa-${failure}`);
          return state?.work.qa.wait?.kind === "ci" ? state : undefined;
        });
        assert.equal(waiting.work.qa.status, "running");
        assert.equal(waiting.error, undefined);
        assert.equal(waiting.work.qa.pendingEffect, undefined);
        assert.equal(waiting.finalValidation, undefined);
        const attempt = waiting.work.qa.attempt;
        github.namedCheck = async (headSha, name) => ({
          id: 72,
          headSha,
          name,
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.com/example/check/72",
        });
        const completed = await running;
        assert.equal(completed.work.qa.attempt, attempt);
        assert.equal(completed.work.qa.status, "done");
        assert.equal(completed.finalValidation.passed, true);
      } else {
        await assert.rejects(
          application.runObjective(1),
          /Required named CI check/,
        );
        const state = readState(`example/qa-${failure}`, 1);
        assert.equal(state.work.qa.status, "failed");
        assert.equal(state.finalValidation, undefined);
      }
      assert.equal(
        readState(`example/qa-${failure}`, 1).work.integration.status,
        "done",
      );
    }));

for (const delivery of ["regular", "native-stack"])
  for (const action of ["pause", "handoff"])
    test(`${delivery}: ${action} acknowledged during resumed named-CI read submits no new QA review`, async () =>
      fixture(async (root) => {
        const target = createTarget(root, {
          "real-environment.txt": "actual local resource",
        });
        const config = factoryConfig(
          target.checkout,
          `example/qa-wait-${delivery}-${action}`,
          delivery,
        );
        const { application, github, planningPath, eventsPath } =
          makeApplication({
            config,
            graph: graph(target.baseSha),
            objectiveBody: body,
            fakeRoot: join(root, "fake"),
            actions: {
              unit: { files: [{ path: "unit.txt", text: "unit" }] },
              integration: {
                files: [{ path: "integration.txt", text: "integration" }],
              },
            },
          });
        github.namedCheck = async () => undefined;
        const running = application.runObjective(1);
        const waiting = await until(() => {
          const state = runSnapshot(config.repository);
          return state?.work.qa.wait?.kind === "ci" ? state : undefined;
        });
        assert.equal(waiting.work.qa.status, "running");
        const attempt = waiting.work.qa.attempt;
        const before = readEvents(planningPath).filter(
          (event) => event.type === "result-review",
        ).length;
        const completedCheck = (headSha, name) => ({
          id: 72,
          headSha,
          name,
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.com/example/check/72",
        });
        let acknowledged = false;
        github.namedCheck = async (headSha, name) => {
          await controlObjective(config, { objective: 1, action });
          acknowledged = true;
          return completedCheck(headSha, name);
        };
        // A pause keeps the owner alive and idle; a handoff releases it.
        if (action === "handoff")
          await assert.rejects(
            running,
            (error) => error.constructor.name === "CoordinatorHandoff",
          );
        const paused = await until(() => {
          const state = runSnapshot(config.repository);
          return acknowledged && state?.coordinator.phase === "waiting"
            ? state
            : undefined;
        });
        assert.equal(acknowledged, true);
        assert.equal(
          paused.coordinator.mode,
          action === "pause" ? "paused" : "draining",
        );
        assert.equal(paused.work.qa.status, "running");
        assert.equal(paused.work.qa.attempt, attempt);
        assert.equal(paused.work.qa.pendingEffect, undefined);
        assert.equal(paused.work.qa.wait?.kind, "ci");
        assert.equal(paused.error, undefined);
        assert.equal(
          readEvents(planningPath).filter(
            (event) => event.type === "result-review",
          ).length,
          before,
        );
        github.namedCheck = async (headSha, name) =>
          completedCheck(headSha, name);
        await controlObjective(config, { objective: 1, action: "resume" });
        const completed =
          action === "pause"
            ? await running
            : await application.runObjective(1);
        assert.equal(completed.work.qa.attempt, attempt);
        assert.equal(completed.work.qa.status, "done");
        assert.equal(completed.finalValidation.passed, true);
        assert.equal(
          readEvents(eventsPath).filter((event) => event.type === "start")
            .length,
          2,
        );
      }));

test("independent review blocks inadequate negative controls and unauthorized golden changes", async () =>
  fixture(async (root) => {
    const target = createTarget(root, {
      "real-environment.txt": "actual fixture resource",
    });
    let reviewed = 0;
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        async generateStructured(request) {
          if (request.purpose === "diagnosis")
            return planningDiagnosis("State the baseline and threshold");
          return graph(target.baseSha);
        },
        async reviewGraph(request) {
          reviewed++;
          assert.equal(request.graph.coverage.length, 4);
          return {
            packetId: request.reviewPacket.id,
            findings: [
              {
                evidenceIndices: [
                  request.reviewPacket.evidence.findIndex(
                    (source) => source.path === "OBJECTIVE",
                  ),
                ],
                detail:
                  "The proposed real-environment assertion is insufficient for required behavior; its rewritten golden baseline lacks source authority and its negative control does not fail.",
                question:
                  "Which source-authorized baseline and negative-control threshold defines the required behavior?",
              },
            ],
          };
        },
      },
    );
    assert.equal(reviewed, 2);
    assert.equal(candidate.review.status, "needs-human");
    assert.match(candidate.review.findings[0].question, /baseline.*threshold/);
  }));

test("compiler resolves selected criterion IDs to canonical sources without model quotations", async () =>
  fixture(async (root) => {
    const target = createTarget(root);
    const modelGraph = () => {
      const value = graph(target.baseSha);
      for (const entry of value.coverage) delete entry.source;
      return value;
    };
    const compiled = await compileObjective(
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        async generateStructured(request) {
          assert.equal(request.compileContext.objectiveNumber, 1);
          return modelGraph();
        },
      },
    );
    assert.deepEqual(
      compiled.coverage.map(({ criterionId, source }) => ({
        criterionId,
        source,
      })),
      coverageObligations(body, objectiveCriteria(body)),
    );
    for (const corruption of ["unknown", "duplicate"]) {
      await assert.rejects(
        compileObjective(1, body, target.baseSha, target.checkout, {
          async generateStructured() {
            const value = modelGraph();
            value.coverage[0].criterionId =
              corruption === "unknown"
                ? "0".repeat(64)
                : value.coverage[1].criterionId;
            return value;
          },
        }),
        /identity is unknown or duplicated/,
      );
    }
  }));

test("unavailable real environment stops before a worker starts", async () =>
  fixture(async (root) => {
    const target = createTarget(root);
    const value = graph(target.baseSha);
    value.items[0].validation.push(value.items[2].validation[0]);
    value.coverage[0].environment = {
      kind: "real",
      readiness: "available",
      probe: "test -s real-environment.txt",
      preparedBy: "",
    };
    const { application, eventsPath } = makeApplication({
      config: factoryConfig(target.checkout, "example/qa-missing-environment"),
      graph: value,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
    });
    // The failed probe stops the item for an operator decision; no worker starts.
    const stopped = await application.runObjective(1);
    assert.equal(stopped.work.unit.status, "failed");
    assert.match(stopped.coordinator.waitReason, /operator decision/);
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      0,
    );
  }));

test("authorized prerequisite creates the real environment before late QA probes it", async () =>
  fixture(async (root) => {
    const target = createTarget(root);
    const value = graph(target.baseSha);
    value.items[1].ownedPaths.push("real-environment.txt");
    value.coverage[2].environment.readiness = "prepare";
    value.coverage[2].environment.preparedBy = "integration";
    const { application, github } = makeApplication({
      config: factoryConfig(target.checkout, "example/qa-prepared-environment"),
      graph: value,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        unit: { files: [{ path: "unit.txt", text: "unit" }] },
        integration: {
          files: [
            { path: "integration.txt", text: "integration" },
            {
              path: "real-environment.txt",
              text: "created by authorized prerequisite",
            },
          ],
        },
      },
    });
    github.namedCheck = async (headSha, name) => ({
      id: 91,
      headSha,
      name,
      status: "completed",
      conclusion: "success",
      detailsUrl: "https://github.com/example/check/91",
    });
    const state = await application.runObjective(1);
    assert.equal(state.work.qa.status, "done");
  }));

test("a dependency-version mismatch passes real local validation but failed CI blocks completion", async () =>
  fixture(async (root) => {
    const target = createTarget(root, {
      "real-environment.txt": "actual local resource",
      "package.json": JSON.stringify({
        scripts: { test: "node dependency-check.cjs 1" },
      }),
      "dependency-check.cjs":
        "const assert = require('node:assert/strict'); const version = Number(process.argv[2]); const dependency = version === 1 ? { value: () => 'compatible' } : { value: () => ({ changed: true }) }; assert.equal(dependency.value(), 'compatible');\n",
    });
    const objectiveBody = body.replace(
      "## Commands",
      "## Commands\n- npm test",
    );
    const value = graph(target.baseSha);
    value.coverage = value.coverage.map((entry, index) => ({
      ...entry,
      ...coverageObligations(objectiveBody, objectiveCriteria(objectiveBody))[
        index
      ],
    }));
    value.items[0].validation.push({
      command: "npm test",
      provenance: "source-declared",
      source: "OBJECTIVE",
    });
    const { application, github } = makeApplication({
      config: factoryConfig(target.checkout, "example/qa-ci-version-mismatch"),
      graph: value,
      objectiveBody,
      fakeRoot: join(root, "fake"),
      actions: {
        unit: { files: [{ path: "unit.txt", text: "unit" }] },
        integration: {
          files: [{ path: "integration.txt", text: "integration" }],
        },
      },
    });
    github.namedCheck = async (headSha, name) => {
      const result = spawnSync(
        process.execPath,
        [join(target.checkout, "dependency-check.cjs"), "2"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ERR_ASSERTION/);
      return {
        id: 92,
        headSha,
        name,
        status: "completed",
        conclusion: result.status === 0 ? "success" : "failure",
        detailsUrl: "https://github.com/example/check/92",
      };
    };
    await assert.rejects(
      application.runObjective(1),
      /Required named CI check/,
    );
    const state = readState("example/qa-ci-version-mismatch", 1);
    assert.equal(
      state.work.unit.validation.commands.find(
        (command) => command.command === "npm test",
      ).passed,
      true,
    );
    assert.equal(state.work.qa.status, "failed");
    assert.equal(state.finalValidation, undefined);
  }));

test("native preparation integrates before its worker consumer readiness probe", async () =>
  fixture(async (root) => {
    const target = createTarget(root);
    const value = graph(target.baseSha);
    value.items[0].ownedPaths.push("real-environment.txt");
    value.items[1].validation.push(value.items[2].validation[0]);
    value.coverage[1].environment = {
      kind: "real",
      readiness: "prepare",
      probe: "test -s real-environment.txt",
      preparedBy: "unit",
    };
    assert.deepEqual(
      linearDeliveryUnits(value).map((unit) =>
        unit.items.map((item) => item.id),
      ),
      [["unit"], ["integration"], ["qa"]],
    );
    const { application, github, eventsPath } = makeApplication({
      config: factoryConfig(
        target.checkout,
        "example/qa-native-prepared-consumer",
        "native",
      ),
      graph: value,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        unit: {
          files: [
            { path: "unit.txt", text: "unit" },
            { path: "real-environment.txt", text: "prepared" },
          ],
        },
        integration: {
          files: [{ path: "integration.txt", text: "integration" }],
        },
      },
    });
    github.namedCheck = async (headSha, name) => ({
      id: 93,
      headSha,
      name,
      status: "completed",
      conclusion: "success",
      detailsUrl: "https://github.com/example/check/93",
    });
    const state = await application.runObjective(1);
    assert.equal(state.work.integration.status, "done");
    const started = readEvents(eventsPath).filter(
      (event) => event.type === "start",
    );
    assert.deepEqual(
      started.map((event) => event.item),
      ["unit", "integration"],
    );
    assert.equal(started[1].baseSha, state.work.unit.integratedSha);
  }));

test("native paused admission does not start a pending QA proof", async () => {
  for (const initiallyPaused of [true, false]) {
    let paused = initiallyPaused;
    let reconciliations = 0;
    let saves = 0;
    const candidate = "a".repeat(40);
    const state = {
      graph: graph(candidate),
      integratedSha: candidate,
      capacity: { concurrency: 1 },
      work: {
        unit: { status: "done", integratedSha: candidate },
        integration: { status: "done", integratedSha: candidate },
        qa: { status: "pending" },
      },
    };
    await runNativeGraph({
      config: { execution: { concurrency: 1 } },
      objective: 1,
      objectiveBody: body,
      root: "/unused",
      state,
      driver: {
        async availableSlots() {
          return 0;
        },
      },
      github: {
        async defaultBranch() {
          return "main";
        },
      },
      save() {
        saves++;
      },
      active: new Map(),
      cancelled: () => false,
      paused: () => paused,
      async reconcile() {
        reconciliations++;
        paused = true;
      },
    });
    assert.equal(state.work.qa.status, "pending");
    assert.equal(saves, 0);
    assert.equal(reconciliations, initiallyPaused ? 0 : 1);
  }
});

for (const delivery of ["regular", "native"])
  for (const outcome of ["unknown", "refused"])
    test(`${delivery} ${outcome} QA review: lost response repeats, refusal needs retry`, async () =>
      fixture(async (root) => {
        const target = createTarget(root, {
          "real-environment.txt": "actual local resource",
        });
        const repository = `example/qa-review-${outcome}-${delivery}`;
        let submissions = 0;
        const { application, github } = makeApplication({
          config: factoryConfig(target.checkout, repository, delivery),
          graph: graph(target.baseSha),
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          actions: {
            unit: { files: [{ path: "unit.txt", text: "unit" }] },
            integration: {
              files: [{ path: "integration.txt", text: "integration" }],
            },
          },
          resultReviewer(request) {
            if (
              request.criteria.includes(
                "real environment and exact named CI proof",
              )
            ) {
              submissions++;
              if (outcome === "unknown" && submissions === 1)
                throw attachFault(new Error("QA provider response was lost"), {
                  kind: "transient",
                  detail: "QA provider response was lost",
                  outcomeUnknown: true,
                });
            }
            return {
              packetId: request.reviewPacket.id,
              findings: resultFindings(
                request,
                request.criteria.map((criterion) => ({
                  criterion,
                  source: "OBJECTIVE",
                  verdict:
                    outcome === "refused" &&
                    submissions === 1 &&
                    criterion === "real environment and exact named CI proof"
                      ? "refuse"
                      : "pass",
                  detail: "fixture semantic proof",
                  question: "",
                })),
              ),
            };
          },
        });
        github.namedCheck = async (headSha, name) => ({
          id: 94,
          headSha,
          name,
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.com/example/check/94",
        });
        if (outcome === "unknown") {
          // A lost review response is an interruption: asked again in the
          // same run, without a retry.
          const completed = await application.runObjective(1);
          assert.equal(completed.finalValidation.passed, true);
          assert.equal(submissions, 2);
          return;
        }
        // A refusal is a wrong result of this item only: it is diagnosed
        // (here the diagnosis leaves it to the operator) and the run stops
        // for the decision without failing the Objective.
        const stopped = await application.runObjective(1);
        assert.equal(stopped.error, undefined);
        const state = readState(repository, 1);
        assert.equal(state.work.qa.status, "failed");
        assert.match(state.work.qa.recovery.failure.event, /^item\/qa\//);
        assert.equal(submissions, 1);
        // An explicit retry reviews once more.
        assert.equal(state.work.qa.execution, undefined);
        application.retryWorkItem(1, "qa");
        const completed = await application.runObjective(1);
        assert.equal(completed.finalValidation.passed, true);
        assert.equal(submissions, 2);
      }));

test("cancellation acknowledged during named CI observation prevents QA model submission", async () =>
  fixture(async (root) => {
    const target = createTarget(root, {
      "real-environment.txt": "actual local resource",
    });
    const repository = "example/qa-cancel-before-review";
    const entered = Promise.withResolvers();
    const response = Promise.withResolvers();
    let qaReviews = 0;
    const { application, github } = makeApplication({
      config: factoryConfig(target.checkout, repository),
      graph: graph(target.baseSha),
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        unit: { files: [{ path: "unit.txt", text: "unit" }] },
        integration: {
          files: [{ path: "integration.txt", text: "integration" }],
        },
      },
      resultReviewer(request) {
        if (
          request.criteria.includes("real environment and exact named CI proof")
        )
          qaReviews++;
        return {
          packetId: request.reviewPacket.id,
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => ({
              criterion,
              source: "OBJECTIVE",
              verdict: "pass",
              detail: "fixture semantic proof",
              question: "",
            })),
          ),
        };
      },
    });
    github.namedCheck = async (headSha, name) => {
      entered.resolve();
      await response.promise;
      return {
        id: 95,
        headSha,
        name,
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://github.com/example/check/95",
      };
    };
    const rejected = assert.rejects(application.runObjective(1), /cancel/i);
    await entered.promise;
    try {
      await application.cancelObjective(1);
      assert.equal(readState(repository, 1).cancelRequested, true);
    } finally {
      response.resolve();
    }
    await rejected;
    assert.equal(qaReviews, 0);
    assert.equal(readState(repository, 1).work.qa.pendingEffect, undefined);
  }));
