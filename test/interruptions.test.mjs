import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { setLagClock } from "../dist/delivery/lag.js";
import { faultOf, requestFault } from "../dist/fault.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";

// An interruption is not a failure of the work: Factory repeats the step in
// the same run instead of stopping (a paid step up to its bound).

const objective = 1;
const command = 'test "$(cat result.txt)" = result';
const body = `# Deterministic Objective\n\n## Acceptance\n- \`${command}\`\n`;

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
    };
    const app = makeApplication(descriptor);
    return await callback({ ...app, descriptor });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const delivery of ["regular", "native-stack"])
  describe(`interruptions with ${delivery} delivery`, () => {
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
    transient(Object.assign(new Error("provider"), { statusCode: 502 })),
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
