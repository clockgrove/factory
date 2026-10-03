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
// require the same end state as an uninterrupted run of the same delivery
// strategy: every Work Item issue, one PR per item, one merge per merge call,
// final validation passed and the Objective closed. Nothing may duplicate.

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

async function runCase(name, crashAt, delivery = "regular") {
  const root = mkdtempSync(join(tmpdir(), `factory-crash-${name}-`));
  try {
    const target = createTarget(root);
    const descriptor = {
      config: factoryConfig(target.checkout, `example/crash-${name}`, delivery),
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

const shared = [
  ["planning", "generateStructured"],
  ["planning", "reviewGraph"],
  ["github", "projectGraph"],
  ["planning", "reviewResult"],
  ["github", "publish"],
];
const deliveryCalls = {
  regular: [["github", "merge"]],
  "native-stack": [
    ["github", "ensureNativeStack"],
    ["github", "mergeNativeStack"],
  ],
};

for (const delivery of ["regular", "native-stack"])
  describe(
    `crash recovery with ${delivery} delivery`,
    { concurrency: 6 },
    () => {
      // An uninterrupted run of the same strategy is the expected end state.
      const reference = runCase(`${delivery}-reference`, undefined, delivery);
      test("uninterrupted run completes", async () => {
        const result = await reference;
        assert.equal(result.outcome, "completed", JSON.stringify(result));
        assert.equal(result.finalValidation, true);
        assert.equal(result.objectiveClosed, true);
      });

      const calls = [
        ...shared,
        ...deliveryCalls[delivery],
        ["github", "closeIssue"],
      ];
      for (const [target, method] of calls)
        for (const when of ["before", "after"]) {
          const name = `${delivery}-${target}-${method}-${when}`;
          test(`crash ${when} ${target}.${method} then restart`, async () => {
            const result = await runCase(
              name,
              { target, method, when },
              delivery,
            );
            if (process.env.FACTORY_CRASH_REPORT)
              console.log(`CRASH-REPORT ${name} ${JSON.stringify(result)}`);
            assert.deepEqual(result, await reference);
          });
        }
    },
  );
