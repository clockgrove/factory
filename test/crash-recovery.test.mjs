import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
  createTarget,
  factoryConfig,
  writeDescriptor,
} from "./support/integration-fixture.mjs";

// Crash the controller at every external-effect boundary, restart it, and
// require the same end state as an uninterrupted run: every Work Item issue,
// one pull request and one merge per item, final validation, Objective closed.
// A stop is reported with its message so the remaining fences stay visible.

const run = promisify(execFile);
const controller = join(import.meta.dirname, "support", "crash-controller.mjs");
const objective = 1;
const commands = [
  'test "$(cat alpha.txt)" = alpha',
  'test "$(cat beta.txt)" = beta',
];

function item(id, dependencies = []) {
  return {
    id,
    title: `Implement ${id}`,
    goal: `Create ${id}.txt`,
    acceptance: [`${id}.txt has the scripted result`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths: [`${id}.txt`],
    resources: [],
    validation: [
      {
        command: `test "$(cat ${id}.txt)" = ${id}`,
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    brief: `Make only the ${id} fixture change.`,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}

async function runCase(name, crashAt) {
  const root = mkdtempSync(join(tmpdir(), `factory-crash-${name}-`));
  try {
    const target = createTarget(root);
    const descriptor = {
      config: factoryConfig(target.checkout, `example/crash-${name}`),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("alpha"), item("beta", ["alpha"])],
      },
      objectiveBody: `# Deterministic Objective\n\n## Acceptance\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${commands.map((c) => `- \`${c}\``).join("\n")}\n`,
      fakeRoot: join(root, "fake"),
      actions: {
        alpha: { files: [{ path: "alpha.txt", text: "alpha\n" }] },
        beta: { files: [{ path: "beta.txt", text: "beta\n" }] },
      },
    };
    // Built after factoryConfig, which puts the test git transport on PATH.
    const env = { ...process.env, XDG_STATE_HOME: join(root, "state") };
    const descriptorPath = join(root, "descriptor.json");
    const invoke = async () => {
      const { stdout } = await run(
        process.execPath,
        [controller, descriptorPath, String(objective)],
        { env, cwd: join(import.meta.dirname, ".."), timeout: 120_000 },
      );
      return JSON.parse(stdout.trim().split("\n").at(-1));
    };
    if (crashAt) {
      writeDescriptor(descriptorPath, { ...descriptor, crashAt });
      const crashed = await invoke().then(
        (result) => ({ result }),
        (error) => ({ signal: error.signal }),
      );
      assert.equal(
        crashed.signal,
        "SIGKILL",
        `boundary ${name} was never reached: ${JSON.stringify(crashed.result)}`,
      );
    }
    writeDescriptor(descriptorPath, descriptor);
    return await invoke();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const reference = {
  outcome: "completed",
  finalValidation: true,
  objectiveClosed: true,
  issues: ["alpha", "beta"],
  pullRequests: 2,
  merged: 2,
  mergeEvents: 2,
  closedIssues: 3,
};

// Boundaries where a crash still stops for the operator. Phase A (#515)
// removes these fences one class at a time; each removal deletes its row.
const fenced = new Map([
  ["github-publish-before", /submitted publication has unknown outcome/],
  ["github-publish-after", /submitted publication has unknown outcome/],
  ["github-merge-before", /submitted merge has unknown outcome/],
  ["github-merge-after", /submitted merge has unknown outcome/],
]);

const boundaries = [
  ["planning", "generateStructured"],
  ["planning", "reviewGraph"],
  ["github", "projectGraph"],
  ["planning", "reviewResult"],
  ["github", "publish"],
  ["github", "merge"],
  ["github", "closeIssue"],
].flatMap(([target, method]) =>
  ["before", "after"].map((when) => ({ target, method, when })),
);

describe("crash recovery", { concurrency: 6 }, () => {
  test("uninterrupted run is the reference", async () => {
    assert.deepEqual(await runCase("reference"), reference);
  });

  for (const crashAt of boundaries) {
    const name = `${crashAt.target}-${crashAt.method}-${crashAt.when}`;
    test(`crash ${crashAt.when} ${crashAt.target}.${crashAt.method} then restart`, async () => {
      const result = await runCase(name, crashAt);
      if (process.env.FACTORY_CRASH_REPORT)
        console.log(`CRASH-REPORT ${name} ${JSON.stringify(result)}`);
      const expectedStop = fenced.get(name);
      if (expectedStop) {
        assert.equal(
          result.outcome,
          "stopped",
          `${name} now converges; remove its fence row`,
        );
        assert.match(result.error, expectedStop);
      } else {
        assert.deepEqual(result, reference);
      }
    });
  }
});
