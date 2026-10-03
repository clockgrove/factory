import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planReviewPacket } from "../dist/compiler.js";
import { readContinuation, saveState, statePath } from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import { resultFindings } from "./support/review-protocol.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

const body =
  "## Acceptance\n- `test -s result.txt`\n\n## Planning sources\n- `docs/source.md#Scope`\n\n## Final validation\n- `test -s result.txt`\n";

/** A plan whose independent review fails needs a specific human decision. */
function undecidedModel(graph, calls) {
  return {
    async generateStructured(request) {
      calls.push(request.purpose ?? "compile");
      return withCoverage(request, graph);
    },
    async reviewGraph() {
      calls.push("graph-review");
      throw new Error("Fixture malformed review");
    },
    async reviewResult(request) {
      return {
        packetId: request.reviewPacket.id,
        findings: resultFindings(
          request,
          request.criteria.map((criterion) => ({
            criterion,
            verdict: "pass",
            source: "Command pass evidence",
            quote: request.commands[0].command,
            detail: "Exact-tree command passed",
            question: "",
          })),
        ),
      };
    },
  };
}

async function fixture(name, callback, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `factory-plan-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root, {
      "docs/source.md": "## Scope\nDeliver result.txt\n",
    });
    const config = factoryConfig(target.checkout, `example/plan-${name}`);
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        {
          id: "result",
          title: "Result",
          goal: "Write result.txt",
          acceptance: ["result.txt exists"],
          nonGoals: ["No deployment"],
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
          brief: "Write result.txt",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
    };
    const objectiveBody = options.namedCi
      ? body +
        "\n## Delivery\nThe named check `quality` must pass on every exact published PR head before integration.\n"
      : body;
    if (options.namedCi)
      graph.requiredPreIntegrationChecks = [
        {
          checkName: "quality",
          source: {
            path: "OBJECTIVE",
            text: objectiveBody.split("\n").at(-2),
            digest: createHash("sha256").update(objectiveBody).digest("hex"),
          },
        },
      ];
    const calls = [];
    const descriptor = {
      config,
      graph,
      objectiveBody,
      fakeRoot: join(root, "fake"),
      ...(options.undecided
        ? { planningModel: undecidedModel(graph, calls) }
        : {}),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
    };
    await callback({
      ...makeApplication(descriptor),
      config,
      target,
      root,
      graph,
      objectiveBody,
      calls,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const accept = {
  actor: "fixture operator",
  outcome: "accept",
  answer: "I accept the exact graph",
  reason: "Inspected source and graph",
};

/** Keep every plan digest consistent so only semantic validation can refuse it. */
function rehash(plan, objectiveBody, target) {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  plan.graphDigest = hash(JSON.stringify(plan.graph));
  plan.packetDigest = hash(
    JSON.stringify(
      planReviewPacket(
        objectiveBody,
        target.baseSha,
        plan.sources,
        plan.graph,
        target.checkout,
        plan.executionProfiles,
        plan.prerequisites,
        plan.localExecutables,
        plan.executionBounds,
      ),
    ),
  );
  plan.reviewDigest = hash(
    JSON.stringify({
      packetDigest: plan.packetDigest,
      revisions: plan.review.revisions,
      findings: plan.review.findings,
      ...(plan.review.failure ? { failure: plan.review.failure } : {}),
    }),
  );
  return plan;
}

test("malformed final commands fail before planning provider calls", async () => {
  await fixture("preflight", async ({ application, github, planningPath }) => {
    for (const command of ["npm install", "npm run", "pnpm exec unknown"]) {
      github.update((state) => {
        state.objectiveBody = body.replace(
          "## Final validation\n- `test -s result.txt`",
          `## Final validation\n- \`${command}\``,
        );
      });
      await assert.rejects(
        application.planObjective(1),
        /authority|npm|pnpm|script|command/i,
      );
    }
    assert.deepEqual(readEvents(planningPath), []);
  });
});

test("required environment from config autonomy is checked before any model invocation", async () => {
  await fixture(
    "required-environment",
    async ({ application, config, planningPath }) => {
      const name = "FACTORY_PLAN_TEST_MISSING";
      const previous = process.env[name];
      delete process.env[name];
      config.autonomy = { requiredEnvironment: [name] };
      try {
        await assert.rejects(
          application.planObjective(1),
          /not in policy.allowedSecretNames/,
        );
        config.policy.allowedSecretNames.push(name);
        await assert.rejects(application.planObjective(1), /unavailable/);
        await assert.rejects(application.runObjective(1), /unavailable/);
        assert.deepEqual(readEvents(planningPath), []);
        assert.equal(existsSync(statePath(config.repository, 1)), false);
        process.env[name] = "fixture-value";
        const preview = await application.planObjective(1);
        assert.equal(preview.review.status, "clean");
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    },
  );
});

test("run persists a plan that needs a decision and binds the exact human answer", async () => {
  await fixture(
    "human-decision",
    async ({ application, config, github, calls }) => {
      await assert.rejects(
        application.decidePlan(1, accept),
        /no persisted plan/,
      );
      const preparing = await application.runObjective(1);
      assert.equal(preparing.schemaVersion, 5);
      assert.equal(preparing.plan.review.status, "needs-human");
      assert.match(
        preparing.coordinator.waitReason,
        /^Plan needs a decision: /,
      );
      assert.equal(Object.keys(github.state().issues).length, 0);
      const planned = calls.length;
      const again = await application.runObjective(1);
      assert.equal(again.schemaVersion, 5);
      assert.equal(calls.length, planned, "a rerun never plans again");
      await assert.rejects(
        application.decidePlan(1, { ...accept, answer: " " }),
        /specific answer/,
      );
      const decided = await application.decidePlan(1, accept);
      const persisted = readContinuation(config.repository, 1);
      assert.deepEqual(persisted.plan, decided.plan);
      assert.equal(persisted.plan.review.status, "human-accepted");
      assert.equal(
        persisted.plan.humanDecision.reviewDigest,
        persisted.plan.reviewDigest,
      );
      assert.equal(
        persisted.plan.humanDecision.question,
        persisted.plan.review.failure.question,
      );
      assert.equal(persisted.coordinator.waitReason, undefined);
      await assert.rejects(
        application.decidePlan(1, accept),
        /no unresolved specific human question/,
      );
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(calls.length, planned);
      await assert.rejects(
        application.decidePlan(1, accept),
        /no persisted plan/,
      );
    },
    { undecided: true },
  );
});

test("plan decisions validate required CI shape and pinned authority even with consistent recomputed plan hashes", async () => {
  await fixture(
    "named-ci-source",
    async ({ application, config, github, target, objectiveBody, calls }) => {
      const preparing = await application.runObjective(1);
      assert.equal(
        preparing.plan.graph.requiredPreIntegrationChecks[0].checkName,
        "quality",
      );
      const path = statePath(config.repository, 1);
      const original = readContinuation(config.repository, 1);
      const before = github.state();
      const planned = calls.length;
      for (const [mutate, message] of [
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks = "quality";
          },
          /must be an array/,
        ],
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks = [null];
          },
          /unique name or pinned authority/,
        ],
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks[0].checkName = " ";
          },
          /unique name or pinned authority/,
        ],
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks.push(
              structuredClone(plan.graph.requiredPreIntegrationChecks[0]),
            );
          },
          /unique name or pinned authority/,
        ],
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks[0].source.digest =
              "0".repeat(64);
          },
          /exact pinned source authority/,
        ],
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks[0].source.path =
              "UNSUPPLIED";
          },
          /exact pinned source authority/,
        ],
        [
          (plan) => {
            plan.graph.requiredPreIntegrationChecks[0].source.text =
              "Unsupported reconstructed pre-integration authority";
          },
          /exact pinned source authority/,
        ],
      ]) {
        const invalid = structuredClone(original);
        mutate(invalid.plan);
        rehash(invalid.plan, objectiveBody, target);
        saveState(path, invalid);
        await assert.rejects(application.decidePlan(1, accept), message);
        assert.equal(
          readContinuation(config.repository, 1).plan.review.status,
          "needs-human",
        );
      }
      assert.deepEqual(github.state(), before);
      assert.equal(calls.length, planned);
    },
    { namedCi: true, undecided: true },
  );
});

test("controller planning bounds are observed from configuration and refuse rehashed authored claims", async () => {
  await fixture(
    "execution-bounds",
    async ({ application, config, target, objectiveBody, github, calls }) => {
      const preview = await application.planObjective(1);
      assert.deepEqual(preview.executionBounds, {
        configuredConcurrency: config.execution.concurrency,
      });
      const preparing = await application.runObjective(1);
      assert.deepEqual(preparing.plan.executionBounds, {
        configuredConcurrency: config.execution.concurrency,
      });
      const path = statePath(config.repository, 1);
      const original = readContinuation(config.repository, 1);
      const before = github.state();
      const planned = calls.length;
      for (const [altered, message] of [
        [
          { configuredConcurrency: config.execution.concurrency + 1 },
          /execution bounds differ/,
        ],
        [
          {
            configuredConcurrency: config.execution.concurrency,
            authorizedMaxConcurrency: 3,
          },
          /Invalid controller planning execution bounds/,
        ],
      ]) {
        const invalid = structuredClone(original);
        invalid.plan.executionBounds = altered;
        if (!("authorizedMaxConcurrency" in altered))
          rehash(invalid.plan, objectiveBody, target);
        saveState(path, invalid);
        await assert.rejects(application.runObjective(1), message);
      }
      assert.deepEqual(github.state(), before);
      assert.equal(calls.length, planned);
    },
    { undecided: true },
  );
});
