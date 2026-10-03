import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { GitHubOutcomeUnknown } from "../dist/github-client.js";
import { readState } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

// An interruption is not a failure of the work: Factory repeats the step in
// the same run (at most twice per attempt) instead of stopping.

const objective = 1;
const command = 'test "$(cat result.txt)" = result';
const body = `# Deterministic Objective\n\n## Acceptance\n- \`${command}\`\n\n## Final validation\n- \`${command}\`\n`;

async function withApp(name, delivery, options, callback) {
  const root = mkdtempSync(join(tmpdir(), `factory-interrupt-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        `example/interrupt-${name}-${delivery}`,
        delivery,
        1,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          {
            id: "result",
            title: "Implement result",
            goal: "Create result.txt",
            acceptance: ["result.txt has the scripted result"],
            nonGoals: ["No deployment"],
            citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
            dependencies: [],
            ownedPaths: ["result.txt"],
            resources: [],
            validation: [
              { command, provenance: "source-declared", source: "OBJECTIVE" },
            ],
            brief: "Make only the result change.",
            sourceAssets: [],
            expectedOutputRoles: [],
            minimumAssetSets: 0,
            requiredLfsRoles: [],
          },
        ],
      },
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {
        result: {
          files: [{ path: "result.txt", text: "result\n" }],
          ...options.action,
        },
      },
      ...(options.resultReviewer
        ? { resultReviewer: options.resultReviewer }
        : {}),
    };
    const app = makeApplication(descriptor);
    return await callback({ ...app, descriptor });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function passingReview(request) {
  return {
    packetId: request.reviewPacket.id,
    findings: resultFindings(
      request,
      request.criteria.map((criterion) => ({
        criterion,
        verdict: "pass",
        source: "OBJECTIVE",
        quote: "## Acceptance",
        detail: "fixture semantic proof",
        question: "",
      })),
    ),
  };
}

const mergeEvents = (github) =>
  github
    .state()
    .events.filter((event) => ["merge", "merge-stack"].includes(event.type))
    .length;

for (const delivery of ["regular", "native-stack"])
  describe(`interruptions with ${delivery} delivery`, () => {
    test("a lost reviewer response is asked again in the same run", async () => {
      let reviews = 0;
      await withApp(
        "review",
        delivery,
        {
          resultReviewer(request) {
            reviews++;
            if (reviews === 1) throw new Error("socket hang up");
            return passingReview(request);
          },
        },
        async ({ application, github }) => {
          const state = await application.runObjective(objective);
          assert.equal(state.finalValidation.passed, true);
          assert.equal(state.work.result.interruptions, undefined);
          assert.ok(reviews >= 2);
          assert.equal(Object.keys(github.state().pullRequests).length, 1);
          assert.equal(mergeEvents(github), 1);
        },
      );
    });

    test("a lost merge response is confirmed, not merged again", async () => {
      await withApp("merge", delivery, {}, async ({ application, github }) => {
        // A one-item native unit merges its single PR like regular delivery.
        const original = github.merge.bind(github);
        let calls = 0;
        github.merge = async (...args) => {
          const result = await original(...args);
          if (++calls === 1) throw new GitHubOutcomeUnknown();
          return result;
        };
        const state = await application.runObjective(objective);
        assert.equal(state.finalValidation.passed, true);
        assert.equal(calls, 2);
        assert.equal(mergeEvents(github), 1);
      });
    });

    test("a worker that ends without a result gets a fresh attempt", async () => {
      await withApp(
        "worker",
        delivery,
        { action: { dieAttempts: 1 } },
        async ({ application, eventsPath }) => {
          const state = await application.runObjective(objective);
          assert.equal(state.finalValidation.passed, true);
          const starts = readEvents(eventsPath).filter(
            (event) => event.type === "start" && event.item === "result",
          );
          assert.equal(starts.length, 2);
          assert.notEqual(starts[0].attempt, starts[1].attempt);
        },
      );
    });

    test("a persistent interruption stops after two repeats and allows retry", async () => {
      let reviews = 0;
      await withApp(
        "persistent",
        delivery,
        {
          resultReviewer(request) {
            reviews++;
            if (reviews <= 3) throw new Error("socket hang up");
            return passingReview(request);
          },
        },
        async ({ application, descriptor }) => {
          await assert.rejects(
            application.runObjective(objective),
            /socket hang up/,
          );
          assert.equal(reviews, 3);
          const failed = readState(descriptor.config.repository, objective);
          assert.equal(failed.work.result.status, "failed");
          assert.equal(
            failed.work.result.recovery.failure.classification,
            "interruption",
          );
          application.retryWorkItem(objective, "result");
          const state = await application.runObjective(objective);
          assert.equal(state.finalValidation.passed, true);
        },
      );
    });
  });

test("provider request failures in transit are transient; refusals are not", async () => {
  const { transientRequestFailure } = await import("../dist/work-repair.js");
  const status = (code) => Object.assign(new Error("http"), { status: code });
  for (const code of [408, 429, 500, 503])
    assert.equal(transientRequestFailure(status(code)), true, String(code));
  for (const code of [400, 401, 403, 404, 409, 422])
    assert.equal(transientRequestFailure(status(code)), false, String(code));
  assert.equal(
    transientRequestFailure(
      Object.assign(new Error("daytona"), { statusCode: 502 }),
    ),
    true,
  );
  assert.equal(
    transientRequestFailure(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      }),
    ),
    true,
  );
  assert.equal(
    transientRequestFailure(new DOMException("timed out", "TimeoutError")),
    true,
  );
  assert.equal(transientRequestFailure(new TypeError("x is undefined")), false);
  assert.equal(transientRequestFailure(new Error("invalid result")), false);
});

test("transient failures are retried in place until the budget, then surface", async () => {
  const { retryTransient, transientRequestFailure } = await import(
    "../dist/work-repair.js"
  );
  const unavailable = () =>
    Object.assign(new Error("unavailable"), { status: 503 });
  let calls = 0;
  assert.equal(
    await retryTransient(
      async () => {
        if (++calls < 3) throw unavailable();
        return "read";
      },
      transientRequestFailure,
      { budgetMs: 1_000, firstDelayMs: 1 },
    ),
    "read",
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        calls++;
        throw unavailable();
      },
      transientRequestFailure,
      { budgetMs: 30, firstDelayMs: 5 },
    ),
    /unavailable/,
  );
  assert.ok(calls >= 2 && calls < 10);
  calls = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        calls++;
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      transientRequestFailure,
      { budgetMs: 1_000, firstDelayMs: 1 },
    ),
    /forbidden/,
  );
  assert.equal(calls, 1);
});

test("retries stop when the step is cancelled; incomplete cleanup repeats, then interrupts", async () => {
  const {
    retryTransient,
    transientRequestFailure,
    repeatCleanup,
    CleanupIncomplete,
  } = await import("../dist/work-repair.js");
  const { Interruption } = await import("../dist/contracts.js");
  let calls = 0;
  let cancelled = false;
  await assert.rejects(
    retryTransient(
      async () => {
        calls++;
        cancelled = true;
        throw Object.assign(new Error("unavailable"), { status: 503 });
      },
      transientRequestFailure,
      { budgetMs: 1_000, firstDelayMs: 1, cancelled: () => cancelled },
    ),
    /unavailable/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await repeatCleanup(
    async () => {
      if (++calls < 3) throw new CleanupIncomplete("deletion not confirmed");
    },
    transientRequestFailure,
    { budgetMs: 1_000, firstDelayMs: 1 },
  );
  assert.equal(calls, 3);
  await assert.rejects(
    repeatCleanup(
      async () => {
        throw new CleanupIncomplete("deletion not confirmed");
      },
      transientRequestFailure,
      { budgetMs: 20, firstDelayMs: 5 },
    ),
    (error) =>
      error instanceof Interruption && /not confirmed/.test(error.message),
  );
  await assert.rejects(
    repeatCleanup(
      async () => {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      transientRequestFailure,
      { budgetMs: 1_000, firstDelayMs: 1 },
    ),
    (error) =>
      !(error instanceof Interruption) && /forbidden/.test(error.message),
  );
});
