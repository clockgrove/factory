import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readState } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

const baseline = "packages:\n  - packages/core\nminimumReleaseAge: 1440\n";
const expanded =
  "packages:\n  - packages/core\n  - apps/runtime\nminimumReleaseAge: 1440\n";
const command = "npm run check";
const objectiveBody = `# Add the runtime package

## Acceptance
- apps/runtime/package.json exists and npm run check passes.
- The successor retains the runtime package.
- \`${command}\`

## Workspace package additions
- \`apps/runtime\`
`;

function item(id, dependencies, ownedPaths) {
  return {
    id,
    title: id,
    goal: "Add and retain apps/runtime",
    acceptance: ["apps/runtime/package.json exists"],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies,
    ownedPaths,
    resources: [],
    validation: [
      { command, provenance: "source-declared", source: "OBJECTIVE" },
    ],
    brief:
      "Create apps/runtime/package.json and add apps/runtime to pnpm-workspace.yaml; preserve all other configuration.",
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}

async function fixture(strategy, callback) {
  const root = mkdtempSync(join(tmpdir(), `factory-workspace-${strategy}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const marker = join(root, "validation-ran");
    const script = `node -e "const fs = require('node:fs'); if (!fs.existsSync('apps/runtime/package.json')) process.exit(1); fs.appendFileSync('${marker}', 'pass\\n')"`;
    const target = createTarget(root, {
      "package.json": JSON.stringify({
        private: true,
        scripts: { check: script },
      }),
      "pnpm-workspace.yaml": baseline,
      "packages/core/package.json": JSON.stringify({
        name: "core",
        private: true,
      }),
    });
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        `example/workspace-${strategy}`,
        strategy,
        1,
      ),
      graph: {
        objective: 1,
        baseSha: target.baseSha,
        items: [
          item("addition", [], ["pnpm-workspace.yaml", "apps/runtime/"]),
          item("successor", ["addition"], ["result.txt"]),
        ],
      },
      objectiveBody,
      fakeRoot: join(root, "fake"),
      actions: {
        addition: {
          files: [
            { path: "pnpm-workspace.yaml", text: expanded },
            {
              path: "apps/runtime/package.json",
              text: JSON.stringify({ name: "runtime", private: true }),
            },
          ],
        },
        successor: {
          files: [
            { path: "result.txt", text: "Successor retained the package\n" },
          ],
        },
      },
    };
    await callback({ descriptor, target, marker });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const strategy of ["regular", "native-stack"]) {
  test(`${strategy} carries Objective workspace authority through successor and final acceptance`, async () => {
    await fixture(strategy, async ({ descriptor, target, marker }) => {
      const { application, github, eventsPath } = makeApplication(descriptor);
      const plan = await application.planObjective(1);
      assert.equal(plan.review.status, "clean");
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.finalAcceptancePending, undefined);
      for (const id of ["addition", "successor"]) {
        assert.equal(completed.work[id].acceptancePending, undefined);
        assert.equal(completed.work[id].acceptanceDecisions, undefined);
        assert.equal(completed.work[id].validation.commands.length, 1);
        assert.equal(completed.work[id].validation.commands[0].passed, true);
      }
      assert.equal(readFileSync(marker, "utf8"), "pass\npass\npass\n");
      // Factory's fetches leave origin/main alone; observe the remote here.
      git(target.checkout, "fetch", "-q", "origin");
      assert.equal(
        git(target.checkout, "show", "origin/main:pnpm-workspace.yaml"),
        expanded.trim(),
      );
      assert.equal(
        JSON.parse(
          git(target.checkout, "show", "origin/main:apps/runtime/package.json"),
        ).name,
        "runtime",
      );
      assert.deepEqual(
        readEvents(eventsPath)
          .filter((event) => event.type === "start")
          .map((event) => event.item),
        ["addition", "successor"],
      );
      const events = github.state().events;
      assert.ok(
        events.some(
          (event) =>
            event.type ===
            (strategy === "native-stack" ? "merge-stack" : "merge"),
        ),
      );
    });
  });

  test(`${strategy} refuses a mixed membership and release-age mutation before validation commands`, async () => {
    await fixture(strategy, async ({ descriptor, target, marker }) => {
      descriptor.actions.addition.files[0].text = expanded.replace("1440", "0");
      const { application, github, eventsPath } = makeApplication(descriptor);
      const plan = await application.planObjective(1);
      assert.equal(plan.review.status, "clean");
      await assert.rejects(
        application.runObjective(1),
        /non-membership configuration/i,
      );
      assert.equal(
        existsSync(marker),
        false,
        "the pinned npm script must not run on rejected configuration",
      );
      const failed = readState(descriptor.config.repository, 1);
      git(target.checkout, "fetch", "-q", "origin");
      assert.equal(failed.work.addition.status, "failed");
      assert.equal(failed.work.addition.pullRequest, undefined);
      assert.equal(
        git(target.checkout, "rev-parse", "origin/main"),
        target.baseSha,
      );
      assert.deepEqual(
        readEvents(eventsPath)
          .filter((event) => event.type === "start")
          .map((event) => event.item),
        ["addition"],
      );
      assert.equal(
        github.state().events.some((event) => event.type === "publish"),
        false,
      );
    });
  });
}
