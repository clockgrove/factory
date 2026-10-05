import { readDiagnostics } from "../dist/diagnostics.js";
import { preflightObjective } from "../dist/local-preflight.js";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compileObjective, planningSources } from "../dist/compiler.js";
import { packageManagerUpdate } from "../dist/package-manager-update.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import {
  assertPinnedNpmScripts,
  validateWorkItem,
} from "../dist/validation.js";
import { readState } from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

const before = "pnpm@9.0.0";
const after = "pnpm@9.1.0";
const declaration = `## Package manager update\n- \`${after}\`\n`;
const body = `# Refresh the package manager\n\n## Acceptance\n- The declared version is delivered.\n- \`pnpm run qa\`\n- \`pnpm test\`\n\n${declaration}`;
const pkg = {
  private: true,
  packageManager: before,
  scripts: { check: "true", qa: "true", test: "true" },
  config: { trusted: true },
  pnpm: { onlyBuiltDependencies: ["approved"] },
};
const workspace = "packages:\n  - packages/core\nminimumReleaseAge: 1440\n";

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-manager-update-"));
  const previous = {
    state: process.env.XDG_STATE_HOME,
    path: process.env.PATH,
  };
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root, {
      "package.json": JSON.stringify(pkg),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": workspace,
      ".npmrc": "ignore-scripts=true\n",
    });
    await run(root, target);
  } finally {
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.state;
    process.env.PATH = previous.path;
    rmSync(root, { recursive: true, force: true });
  }
}

function commit(target, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target.checkout, path)), { recursive: true });
    writeFileSync(join(target.checkout, path), content);
  }
  git(target.checkout, "add", "-A");
  git(
    target.checkout,
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory-test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Package manager candidate",
  );
  return git(target.checkout, "rev-parse", "HEAD");
}

function item(
  id,
  dependencies = [],
  ownedPaths = ["package.json", "pnpm-lock.yaml"],
  command = "pnpm run check",
) {
  return {
    id,
    title: id,
    goal: "Deliver the declared package-manager update",
    acceptance: ["The declared version is delivered."],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies,
    ownedPaths,
    resources: [],
    validation: [
      { command, provenance: "base-observed", source: "package.json" },
    ],
    brief:
      "Apply the exact Package manager update and preserve all other configuration.",
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}

function guard(target, head, authority = {}, commands = ["pnpm run check"]) {
  return assertPinnedNpmScripts(
    target.checkout,
    target.baseSha,
    head,
    commands,
    authority,
  );
}

test("package manager authority is one structured, exact, stable declaration", () => {
  assert.equal(packageManagerUpdate(body), after);
  assert.equal(packageManagerUpdate(declaration.replace("##", "###")), after);
  for (const source of [
    "Update packageManager to pnpm@9.1.0.",
    "## Constraints\n- `pnpm@9.1.0`\n",
    `\`\`\`markdown\n${declaration}\`\`\`\n`,
    "### Package manager update\n_No response_\n",
  ])
    assert.equal(packageManagerUpdate(source), undefined);
  for (const source of [
    `${declaration}\n${declaration}`,
    `${declaration}- \`${after}\`\n`,
    `${declaration}- \`pnpm@9.2.0\`\n`,
    "## Package manager update\n_No response_\n- `pnpm@9.1.0`\n",
    "## Package manager update\n",
    "# Package manager update\n- `pnpm@9.1.0`\n",
    "## Package manager update\n```\n- `pnpm@9.1.0`\n```\n",
    ...[
      "pnpm@^9.1.0",
      "pnpm@https://example.com/pnpm",
      "pnpm@9.1.0-rc.1",
      "pnpm@9.1.0+sha512.abc",
      "pnpm@09.1.0",
      "yarn@4.1.0",
      "pnpm@9.1",
      "pnpm@9.1.0` trailing",
    ].map((pin) => `## Package manager update\n- \`${pin}\`\n`),
  ])
    assert.throws(() => packageManagerUpdate(source), /Package manager update/);
});

test("real Git preview and result admit only the declared same-manager pin, including npm", async () => {
  for (const manager of ["npm", "pnpm"])
    await fixture(async (root, target) => {
      const baseline =
        manager === "pnpm"
          ? target.baseSha
          : commit(target, {
              "package.json": JSON.stringify({
                ...pkg,
                packageManager: "npm@9.0.0",
              }),
            });
      target.baseSha = baseline;
      const pin = `${manager}@9.1.0`;
      const objective = body.replaceAll("pnpm@9.1.0", pin);
      assert.ok(
        planningSources(objective, baseline, target.checkout).some(
          (source) => source.path === "OBJECTIVE",
        ),
      );
      assert.doesNotThrow(() =>
        guard(target, baseline, { packageManagerUpdate: pin, preview: true }),
      );
      const head = commit(target, {
        "package.json": JSON.stringify({ ...pkg, packageManager: pin }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# refresh\n",
      });
      assert.doesNotThrow(() =>
        guard(target, head, { packageManagerUpdate: pin }),
      );
      assert.doesNotThrow(() =>
        guard(
          target,
          head,
          { packageManagerUpdate: pin, requirePackageManagerUpdate: true },
          [],
        ),
      );
      await assert.doesNotReject(
        validateWorkItem(
          target.checkout,
          join(root, "validation"),
          item("update", [], undefined, "npm run check"),
          head,
          git(target.checkout, "rev-parse", `${head}^{tree}`),
          baseline,
          undefined,
          undefined,
          baseline,
          [],
          undefined,
          [],
          pin,
        ),
      );
      assert.throws(() => guard(target, head), /packageManager differs/);
      assert.throws(
        () => guard(target, head, {}, []),
        /packageManager differs/,
      );
      for (const denied of [
        `${manager}@9.2.0`,
        `${manager}@^9.1.0`,
        `${manager === "npm" ? "pnpm" : "npm"}@9.1.0`,
      ])
        assert.throws(
          () => guard(target, head, { packageManagerUpdate: denied }),
          /packageManager differs|same manager/,
        );
      assert.throws(
        () =>
          guard(target, baseline, {
            packageManagerUpdate: pin,
            requirePackageManagerUpdate: true,
          }),
        /not delivered/,
      );
      assert.throws(
        () =>
          guard(target, baseline, {
            packageManagerUpdate: pin,
            predecessorSha: head,
          }),
        /revert/,
      );
    });
});

test("same-manager authority does not relax scripts, lifecycle hooks or package-manager security", async () => {
  await fixture(async (root, target) => {
    const changed = { ...pkg, packageManager: after };
    for (const files of [
      {
        "package.json": JSON.stringify({
          ...changed,
          scripts: { ...pkg.scripts, check: "false" },
        }),
      },
      {
        "package.json": JSON.stringify({
          ...changed,
          scripts: { ...pkg.scripts, precheck: "true" },
        }),
      },
      {
        "package.json": JSON.stringify({
          ...changed,
          config: { trusted: false },
        }),
      },
      {
        "package.json": JSON.stringify({
          ...changed,
          pnpm: { onlyBuiltDependencies: [] },
        }),
      },
      { ".npmrc": "ignore-scripts=false\n" },
      { "pnpm-workspace.yaml": workspace.replace("1440", "0") },
      { ".pnpmfile.cjs": "module.exports = {}\n" },
    ]) {
      git(target.checkout, "checkout", "--detach", target.baseSha);
      const head = commit(target, {
        "package.json": JSON.stringify(changed),
        ...files,
      });
      const commands = files[".pnpmfile.cjs"]
        ? ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm run check"]
        : undefined;
      assert.throws(
        () =>
          guard(
            target,
            head,
            {
              packageManagerUpdate: after,
              sourceDeclared: [
                "pnpm install --frozen-lockfile --ignore-scripts",
              ],
            },
            commands,
          ),
        /differs|hooks/,
      );
      await assert.rejects(
        validateWorkItem(
          target.checkout,
          join(root, "refused"),
          {
            ...item("update"),
            ...(commands && {
              validation: commands.map((command) => ({
                command,
                provenance: "source-declared",
                source: "OBJECTIVE",
              })),
            }),
          },
          head,
          git(target.checkout, "rev-parse", `${head}^{tree}`),
          target.baseSha,
          undefined,
          undefined,
          target.baseSha,
          [],
          undefined,
          [],
          after,
        ),
        /differs|hooks/,
      );
    }
  });
});

test("planning rejects malformed or switched authority before the planner and supplies fixed metadata", async () => {
  await fixture(async (root, target) => {
    let calls = 0;
    const model = {
      async generateStructured(request) {
        calls++;
        assert.match(
          request.compileContext.instructions,
          /packageManager pnpm@9\.1\.0/,
        );
        assert.match(
          request.objective,
          /preserve package.json config and pnpm settings/,
        );
        assert.deepEqual(
          request.fixedScripts.map((entry) => entry.name),
          ["qa", "test"],
        );
        return withCoverage(request, {
          objective: 1,
          baseSha: target.baseSha,
          items: [item("update")],
        });
      },
    };
    const result = await compileObjective(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(result.items.length, 1);
    assert.equal(calls, 1);
    for (const source of [
      body.replace(after, "npm@9.1.0"),
      body.replace(after, "pnpm@^9.1.0"),
      `${body}\n${declaration}`,
    ])
      await assert.rejects(
        compileObjective(1, source, target.baseSha, target.checkout, model),
        /Package manager update/,
      );
    assert.equal(calls, 1);
    const prompt = workItemPrompt({
      item: result.items[0],
      worktree: target.checkout,
      packageManagerUpdate: after,
    });
    assert.match(prompt, /packageManager pnpm@9\.1\.0/);
    assert.match(prompt, /bodies must stay identical/);
    assert.match(
      workItemPrompt({ item: result.items[0], worktree: target.checkout }),
      /no exact Package manager update is authorized/,
    );
  });
});

function hostTools(root, marker) {
  const bin = join(root, "host-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst {spawnSync} = require('node:child_process');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') console.log('9.1.0');\nelse {\nfs.appendFileSync(${JSON.stringify(marker)}, args.join(' ') + '\\n');\nconst pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));\nconst name = args[0] === 'run' ? args[1] : args[0];\nprocess.exitCode = spawnSync('/bin/sh', ['-c', pkg.scripts[name]], {stdio: 'inherit', env: process.env}).status ?? 1;\n}\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

function descriptor(root, target, strategy) {
  const qa = { ...item("qa", ["successor"], [], "pnpm run qa"), kind: "qa" };
  return {
    config: factoryConfig(
      target.checkout,
      `example/manager-${strategy}`,
      strategy,
      1,
    ),
    graph: {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        item("update"),
        item("successor", ["update"], ["result.txt"]),
        qa,
      ],
    },
    objectiveBody: body,
    fakeRoot: join(root, "fake"),
    actions: {
      update: {
        files: [
          {
            path: "package.json",
            text: JSON.stringify({ ...pkg, packageManager: after }),
          },
          {
            path: "pnpm-lock.yaml",
            text: "lockfileVersion: '9.0'\n# refresh\n",
          },
        ],
      },
      successor: {
        files: [{ path: "result.txt", text: "Retain the declared pin\n" }],
      },
    },
  };
}

for (const strategy of ["regular", "native-stack"]) {
  test(`${strategy} carries the exact version through worker, successor, QA and final validation`, async () => {
    await fixture(async (root, target) => {
      const marker = join(root, "commands");
      hostTools(root, marker);
      const input = descriptor(root, target, strategy);
      const { application, driver, eventsPath, planningPath } =
        makeApplication(input);
      const start = driver.harness.start.bind(driver.harness);
      driver.harness.start = (request) => {
        assert.equal(request.packageManagerUpdate, after);
        assert.match(workItemPrompt(request), /packageManager pnpm@9\.1\.0/);
        return start(request);
      };
      const plan = await application.planObjective(1);
      assert.equal(plan.review.status, "clean");
      assert.match(
        readEvents(planningPath)[0].objective,
        /packageManager pnpm@9\.1\.0/,
      );
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      for (const id of ["update", "successor", "qa"])
        assert.equal(completed.work[id].validation.commands[0].passed, true);
      assert.deepEqual(
        readEvents(eventsPath)
          .filter((event) => event.type === "start")
          .map((event) => event.item),
        ["update", "successor"],
      );
      assert.match(readFileSync(marker, "utf8"), /run qa\n.*test\n/s);
      git(target.checkout, "fetch", "-q", "origin");
      const delivered = JSON.parse(
        git(target.checkout, "show", "origin/main:package.json"),
      );
      assert.deepEqual(delivered, { ...pkg, packageManager: after });
    });
  });

  test(`${strategy} preserves a rejected mismatched candidate and refuses before commands or publication`, async () => {
    await fixture(async (root, target) => {
      const marker = join(root, "commands");
      hostTools(root, marker);
      const input = descriptor(root, target, strategy);
      input.actions.update.files[0].text = JSON.stringify({
        ...pkg,
        packageManager: "pnpm@9.2.0",
      });
      const { application, github } = makeApplication(input);
      await application.planObjective(1);
      await assert.rejects(
        application.runObjective(1),
        /packageManager differs/,
      );
      const failed = readState(input.config.repository, 1);
      assert.equal(failed.work.update.status, "failed");
      assert.equal(failed.work.update.pullRequest, undefined);
      assert.equal(
        JSON.parse(
          git(
            target.checkout,
            "show",
            `${failed.work.update.changeRef}:package.json`,
          ),
        ).packageManager,
        "pnpm@9.2.0",
      );
      assert.equal(existsSync(marker), false);
      assert.equal(
        github.state().events.some((event) => event.type === "publish"),
        false,
      );
      assert.ok(failed.work.update.attempt);
      assert.ok(
        readDiagnostics(input.config.repository, 1).some(
          (event) => event.operation === "model-invocation",
        ),
      );
    });
  });

  test(`${strategy} final validation refuses an undelivered declaration`, async () => {
    await fixture(async (root, target) => {
      const marker = join(root, "commands");
      hostTools(root, marker);
      const input = descriptor(root, target, strategy);
      input.actions.update.files = [
        {
          path: "pnpm-lock.yaml",
          text: "lockfileVersion: '9.0'\n# refresh only\n",
        },
      ];
      const { application } = makeApplication(input);
      await application.planObjective(1);
      await assert.rejects(application.runObjective(1), /was not delivered/);
      const failed = readState(input.config.repository, 1);
      assert.equal(failed.finalAcceptance, undefined);
      assert.equal(failed.work.update.status, "done");
      assert.equal(failed.work.qa.status, "done");
    });
  });
}

test("host readiness requires the declared target version and preserves the base requirement without authority", async () => {
  await fixture(async (root, target) => {
    const marker = join(root, "commands");
    hostTools(root, marker);
    const config = factoryConfig(target.checkout, "example/manager-readiness");
    assert.doesNotThrow(() => preflightObjective(config, body, target.baseSha));
    assert.throws(
      () =>
        preflightObjective(
          config,
          body.replace(declaration, ""),
          target.baseSha,
        ),
      /version-mismatch.*pnpm@9.0.0.*9.1.0/,
    );
    assert.throws(
      () =>
        preflightObjective(
          config,
          body.replace(after, "npm@9.1.0"),
          target.baseSha,
        ),
      /same manager/,
    );
    assert.equal(
      existsSync(marker),
      false,
      "readiness executes only fixed host version probes",
    );
  });
});

test("version refresh authority requires a supported pinned manager at the immutable accepted base", async () => {
  await fixture(async (root, target) => {
    for (const pin of [
      undefined,
      "yarn@4.0.0",
      "pnpm@^9.0.0",
      "pnpm@9.0.0-rc.1",
    ]) {
      const baseline = commit(target, {
        "package.json": JSON.stringify({ ...pkg, packageManager: pin }),
      });
      assert.throws(
        () => planningSources(body, baseline, target.checkout),
        /existing exact stable pin/,
      );
    }
  });
});

test("Work Item validation refuses undeclared and mismatched pins, including range and URL results", async () => {
  await fixture(async (root, target) => {
    for (const pin of [
      after,
      "npm@9.1.0",
      "pnpm@^9.1.0",
      "pnpm@https://example.com/pnpm",
    ]) {
      const head = commit(target, {
        "package.json": JSON.stringify({ ...pkg, packageManager: pin }),
      });
      for (const authority of pin === after ? [undefined] : [undefined, after])
        await assert.rejects(
          validateWorkItem(
            target.checkout,
            join(root, "invalid"),
            item("update"),
            head,
            git(target.checkout, "rev-parse", `${head}^{tree}`),
            target.baseSha,
            undefined,
            undefined,
            target.baseSha,
            [],
            undefined,
            [],
            authority,
          ),
          /packageManager differs/,
        );
    }
  });
});
