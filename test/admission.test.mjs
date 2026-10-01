import { createHash } from "node:crypto";
import { objectiveComplete } from "../dist/completion.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertAdmissionBinding,
  checkAuthority,
  validateAuthority,
  preflightObjective,
} from "../dist/admission.js";
import { compilePlan } from "../dist/compiler.js";
import { factoryConfigDigest } from "../dist/config.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

function authority(overrides = {}) {
  return {
    schemaVersion: 1,
    actor: "fixture operator",
    reason: "Bounded fixture execution",
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
    ...overrides,
  };
}
const body =
  "## Acceptance\n- `test -s result.txt`\n\n## Planning sources\n- `docs/source.md#Scope`\n\n## Final validation\n- `test -s result.txt`\n";
async function fixture(name, callback, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `factory-admission-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root, {
      "docs/source.md": "## Scope\nDeliver result.txt\n",
      "canonical.md": "## Contract\nThe canonical result is result.txt.\n",
    });
    const config = factoryConfig(target.checkout, `example/admission-${name}`);
    if (options.delivery) config.delivery.kind = options.delivery;
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
    const descriptor = {
      config,
      graph,
      resultReviewer: options.resultReviewer,
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
    };
    await callback({
      ...makeApplication(descriptor),
      config,
      target,
      root,
      graph,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("admission requires explicit bounded authority and environment availability", () => {
  for (const invalid of [
    undefined,
    authority({ executionConsent: false }),
    authority({ serviceConsent: undefined }),
    authority({ actor: " " }),
    authority({ objectives: [] }),
    authority({ objectives: [1, 1] }),
    authority({ allowances: { planningRevisions: 1 } }),
    authority({ repairClasses: ["unbounded"] }),
    authority({ resources: { maxConcurrency: 0 } }),
  ])
    assert.throws(() => validateAuthority(invalid), /Admission/);
  const config = {
    execution: { concurrency: 2 },
    policy: { allowedSecretNames: [] },
  };
  assert.throws(
    () => checkAuthority(config, 2, authority()),
    /outside the authorized batch/,
  );
  assert.throws(
    () =>
      checkAuthority(
        config,
        1,
        authority({ resources: { maxConcurrency: 1 } }),
      ),
    /concurrency/,
  );
  const required = authority({
    requiredEnvironment: ["FACTORY_ADMISSION_TEST_TOKEN"],
  });
  assert.throws(() => checkAuthority(config, 1, required), /allowlist/);
  config.policy.allowedSecretNames.push("FACTORY_ADMISSION_TEST_TOKEN");
  const previous = process.env.FACTORY_ADMISSION_TEST_TOKEN;
  delete process.env.FACTORY_ADMISSION_TEST_TOKEN;
  try {
    assert.throws(() => checkAuthority(config, 1, required), /unavailable/);
    process.env.FACTORY_ADMISSION_TEST_TOKEN = "fixture-value";
    checkAuthority(config, 1, required);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_ADMISSION_TEST_TOKEN;
    else process.env.FACTORY_ADMISSION_TEST_TOKEN = previous;
  }
});

test("admit and check are read-only and bind exact authority, plan, source, body and config", async () => {
  await fixture(
    "binding",
    async ({
      application,
      github,
      config,
      target,
      eventsPath,
      planningPath,
    }) => {
      const candidate = await application.planObjective(1);
      const before = github.state();
      const planningCalls = readEvents(planningPath);
      await assert.rejects(
        application.admitObjective(1, candidate, undefined),
        /Admission/,
      );
      const policy = authority();
      const admission = await application.admitObjective(1, candidate, policy);
      assert.equal(
        admission.prerequisitesDigest,
        createHash("sha256").update("null").digest("hex"),
      );
      for (const malformed of ["invalid", ["0".repeat(64)]])
        assert.throws(
          () =>
            assertAdmissionBinding({
              ...admission,
              prerequisitesDigest: malformed,
            }),
          /native prerequisites digest/,
        );
      assert.throws(
        () =>
          assertAdmissionBinding({
            ...admission,
            prerequisitesDigest: "0".repeat(64),
          }),
        /binding changed/,
      );
      policy.reason = "Changed externally";
      assert.equal(admission.authority.reason, "Bounded fixture execution");
      await application.checkAdmission(1, candidate, admission);
      assert.deepEqual(github.state(), before);
      assert.deepEqual(readEvents(planningPath), planningCalls);
      assert.deepEqual(readEvents(eventsPath), []);
      assert.equal(existsSync(statePath(config.repository, 1)), false);
      await assert.rejects(
        application.checkAdmission(1, candidate, {
          ...admission,
          authority: authority({ objectives: [1, 2] }),
        }),
        /binding changed/,
      );
      await assert.rejects(
        application.checkAdmission(
          1,
          {
            ...candidate,
            sources: candidate.sources.map((source) => ({
              ...source,
              content: "changed",
            })),
          },
          admission,
        ),
        /stale|modified|differ|match/i,
      );
      config.execution.concurrency = 1;
      await assert.rejects(
        application.checkAdmission(1, candidate, admission),
        /stale|modified|differ|match/i,
      );
      config.execution.concurrency = 2;
      github.update((state) => {
        state.objectiveBody = body.replace("Scope", "Missing");
      });
      await assert.rejects(
        application.checkAdmission(1, candidate, admission),
        /headings named Missing/,
      );
      github.update((state) => {
        state.objectiveBody = body + "\n## Notes\nChanged";
      });
      await assert.rejects(
        application.checkAdmission(1, candidate, admission),
        /stale|modified|differ|match/i,
      );
      github.update((state) => {
        state.objectiveBody = body;
      });
      writeFileSync(
        join(target.checkout, "docs/source.md"),
        "Dirty checkout is not pinned source",
      );
      await application.checkAdmission(1, candidate, admission);
    },
  );
});

test("admitted execution persists authority and refuses replacement on resume", async () => {
  await fixture("run", async ({ application, config }) => {
    const candidate = await application.planObjective(1);
    const admission = await application.admitObjective(
      1,
      candidate,
      authority(),
    );
    await assert.rejects(
      application.runObjective(1, undefined, admission),
      /exact reviewed plan/,
    );
    assert.equal(existsSync(statePath(config.repository, 1)), false);
    await application.runObjective(1, candidate, admission);
    const accepted = readState(config.repository, 1);
    assert.deepEqual(accepted.admission, admission);
    const replacement = {
      ...admission,
      authority: authority({ reason: "Replace authority" }),
    };
    await assert.rejects(
      application.runObjective(1, undefined, replacement),
      /cannot be added or replaced/,
    );
    const unchanged = readState(config.repository, 1);
    assert.deepEqual(unchanged.admission, admission);
    assert.deepEqual(unchanged.finalAcceptance, accepted.finalAcceptance);
    assert.equal(unchanged.error, undefined);
    assert.equal(objectiveComplete(unchanged), true);
    const pending = structuredClone(unchanged);
    pending.objectiveClosure = "pending";
    saveState(statePath(config.repository, 1), pending);
    await assert.rejects(
      application.runObjective(1, undefined, replacement),
      /cannot be added or replaced/,
    );
    const stillPending = readState(config.repository, 1);
    assert.deepEqual(stillPending.finalAcceptance, accepted.finalAcceptance);
    assert.equal(stillPending.objectiveClosure, "pending");
    assert.equal(stillPending.error, undefined);
    assert.equal(objectiveComplete(stillPending), false);
    const reconciled = await application.runObjective(1);
    assert.deepEqual(reconciled.finalAcceptance, accepted.finalAcceptance);
    assert.equal(objectiveComplete(reconciled), true);
  });
});

test("explicit runs remain compatible and cannot acquire admission retrospectively", async () => {
  await fixture("explicit", async ({ application, config }) => {
    const candidate = await application.planObjective(1);
    const admission = await application.admitObjective(
      1,
      candidate,
      authority(),
    );
    await application.runObjective(1, candidate);
    assert.equal(readState(config.repository, 1).admission, undefined);
    await assert.rejects(
      application.runObjective(1, undefined, admission),
      /cannot be added or replaced/,
    );
  });
});

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

test("planning checks required environment and batch before any model invocation", async () => {
  await fixture(
    "planning-authority",
    async ({ application, config, planningPath }) => {
      const name = "FACTORY_ADMISSION_TEST_MISSING";
      const previous = process.env[name];
      delete process.env[name];
      config.policy.allowedSecretNames.push(name);
      try {
        await assert.rejects(
          application.planObjective(
            1,
            [],
            authority({ requiredEnvironment: [name] }),
          ),
          /unavailable/,
        );
        await assert.rejects(
          application.planObjective(1, [], authority({ objectives: [2] })),
          /outside the authorized batch/,
        );
        assert.deepEqual(readEvents(planningPath), []);
        assert.equal(existsSync(statePath(config.repository, 1)), false);
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    },
  );
});

test("admission binds the exact human plan decision", async () => {
  await fixture(
    "human-decision",
    async ({ application, config, target, graph }) => {
      const candidate = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        {
          async generateStructured(request) {
            return withCoverage(request, graph);
          },
          async reviewGraph() {
            throw new Error("Fixture malformed review");
          },
        },
        factoryConfigDigest(config),
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        preflightObjective(config, body, target.baseSha),
      );
      assert.equal(candidate.review.status, "needs-human");
      const accepted = await application.decidePlan(1, candidate, {
        actor: "fixture operator",
        outcome: "accept",
        answer: "I accept the exact graph",
        reason: "Inspected source and graph",
      });
      const admission = await application.admitObjective(
        1,
        accepted,
        authority(),
      );
      await application.checkAdmission(1, accepted, admission);
      const changed = {
        ...accepted,
        humanDecision: {
          ...accepted.humanDecision,
          reason: "A different justification",
        },
      };
      await assert.rejects(
        application.checkAdmission(1, changed, admission),
        /Admission differs/,
      );
    },
  );
});

for (const delivery of ["regular", "native-stack"]) {
  test(`${delivery} result review retains additional pinned source sections`, async () => {
    let reviews = 0;
    await fixture(
      `sources-${delivery}`,
      async ({ application, config }) => {
        const selectors = [{ path: "canonical.md", heading: "Contract" }];
        const candidate = await application.planObjective(1, selectors);
        const admission = await application.admitObjective(
          1,
          candidate,
          authority(),
        );
        const state = await application.runObjective(1, candidate, admission);
        assert.equal(state.finalValidation.passed, true);
        assert.deepEqual(
          readState(config.repository, 1).additionalSources,
          selectors,
        );
        assert.equal(
          reviews,
          2,
          "Work Item and Objective review both consume the admitted sources",
        );
      },
      {
        delivery,
        resultReviewer(request) {
          reviews++;
          const canonical = request.sources.find(
            (source) => source.path === "canonical.md",
          );
          assert.ok(
            canonical,
            "result review must receive the additional canonical section",
          );
          assert.equal(canonical.heading, "Contract");
          assert.equal(
            canonical.content,
            "## Contract\nThe canonical result is result.txt.\n",
          );
          return {
            packetId: request.reviewPacket.id,
            findings: resultFindings(
              request,
              request.criteria.map((criterion) => ({
                criterion,
                verdict: "pass",
                source: canonical.path,
                quote: "The canonical result is result.txt.",
                detail:
                  "The validated result satisfies the supplied canonical contract.",
                question: "",
              })),
            ),
          };
        },
      },
    );
  });
}
