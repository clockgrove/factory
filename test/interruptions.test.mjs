import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { setLagClock } from "../dist/delivery/lag.js";
import { attachFault, faultOf, requestFault } from "../dist/fault.js";
import { readState } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

// An interruption is not a failure of the work: Factory repeats the step in
// the same run instead of stopping (a paid step up to its bound).

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

/** A review answer lost mid-call, classified as the model adapter does. */
const lostAnswer = () =>
  attachFault(new Error("socket hang up"), {
    kind: "transient",
    detail: "Model connection failed mid-call: socket hang up",
    outcomeUnknown: true,
  });

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
            if (reviews === 1) throw lostAnswer();
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
          // As the client raises it: a lost response, outcome unknown.
          if (++calls === 1)
            throw attachFault(new Error("GitHub mutation outcome unknown"), {
              kind: "transient",
              detail: "GitHub PUT response was lost; it may have taken effect",
              outcomeUnknown: true,
            });
          return result;
        };
        const state = await application.runObjective(objective);
        assert.equal(state.finalValidation.passed, true);
        assert.equal(calls, 2);
        assert.equal(mergeEvents(github), 1);
      });
    });

    test("a merge the default branch does not show is lag for GitHub's lag window, then a defect", async (t) => {
      await withApp(
        "ancestry",
        delivery,
        {},
        async ({ application, github, descriptor }) => {
          // GitHub's two-minute lag window passes in a fraction of a second.
          const started = Date.now();
          const restore = setLagClock(
            () => started + (Date.now() - started) * 1_000,
          );
          t.after(restore);
          const checkout = descriptor.config.checkout;
          // A commit GitHub reports as merged but the fetched default
          // branch does not contain yet.
          const unseen = execFileSync(
            "git",
            ["-C", checkout, "commit-tree", "-m", "unseen", "HEAD^{tree}"],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: "Fixture",
                GIT_AUTHOR_EMAIL: "fixture@example.invalid",
                GIT_COMMITTER_NAME: "Fixture",
                GIT_COMMITTER_EMAIL: "fixture@example.invalid",
              },
            },
          ).trim();
          const original = github.merge.bind(github);
          github.merge = async (...args) => ({
            ...(await original(...args)),
            integratedSha: unseen,
          });
          const error = await application
            .runObjective(objective)
            .catch((caught) => caught);
          // The merge step repeats while GitHub may lag (two minutes), then
          // stops: the default branch lost a merge GitHub confirmed.
          assert.match(error.message, /Default branch does not contain/);
          assert.equal(faultOf(error).kind, "defect");
        },
      );
    });

    test("a transient issue closure failure repeats until the issue closes", async () => {
      await withApp(
        "closure",
        delivery,
        {},
        async ({ application, github }) => {
          const close = github.closeIssue.bind(github);
          let failures = 0;
          github.closeIssue = async (...args) => {
            if (failures++ < 2)
              throw attachFault(new Error("GitHub HTTP 502"), {
                kind: "transient",
                detail: "GitHub HTTP 502",
                outcomeUnknown: false,
              });
            return close(...args);
          };
          const state = await application.runObjective(objective);
          assert.equal(state.work.result.githubClosure, "complete");
          assert.equal(state.objectiveClosure, "complete");
          assert.equal(state.repeats, undefined);
          assert.equal(failures, 4);
        },
      );
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

    test("a review answer lost past the paid bound asks the operator and allows retry", async () => {
      let reviews = 0;
      await withApp(
        "persistent",
        delivery,
        {
          resultReviewer(request) {
            reviews++;
            if (reviews <= 4) throw lostAnswer();
            return passingReview(request);
          },
        },
        async ({ application, descriptor }) => {
          // Three lost answers repeat; the fourth is a decision for this
          // item only: the run waits instead of stopping the Objective.
          const waiting = await application.runObjective(objective);
          assert.equal(waiting.error, undefined);
          assert.equal(reviews, 4);
          const failed = readState(descriptor.config.repository, objective);
          assert.equal(failed.work.result.status, "failed");
          assert.match(
            failed.work.result.recovery.failure.decision,
            /retry or cancel\? Start a new attempt with `factory retry/,
          );
          application.retryWorkItem(objective, "result");
          const state = await application.runObjective(objective);
          assert.equal(state.finalValidation.passed, true);
        },
      );
    });
  });

test("provider request failures in transit are transient; refusals are not", () => {
  const transient = (error) =>
    requestFault(error, { outcomeUnknown: true, fix: "fix" })?.kind ===
    "transient";
  const status = (code) => Object.assign(new Error("http"), { status: code });
  for (const code of [408, 429, 500, 503])
    assert.equal(transient(status(code)), true, String(code));
  for (const code of [400, 401, 403, 404, 409, 422])
    assert.equal(transient(status(code)), false, String(code));
  assert.equal(
    transient(Object.assign(new Error("daytona"), { statusCode: 502 })),
    true,
  );
  assert.equal(
    transient(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      }),
    ),
    true,
  );
  assert.equal(transient(new DOMException("timed out", "TimeoutError")), true);
  assert.equal(transient(new TypeError("x is undefined")), false);
  assert.equal(transient(new Error("invalid result")), false);
});
