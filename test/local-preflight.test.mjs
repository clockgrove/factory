import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDiagnostics, statusDocument } from "../dist/diagnostics.js";
import { preflightLocalExecutables } from "../dist/local-preflight.js";
import {
  localValidationShellArguments,
  resolveLocalExecutable,
} from "../dist/process.js";
import { readContinuation, readState } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-preflight-"));
  const previous = {
    PATH: process.env.PATH,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
  };
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    await run(root);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

function hostTools(root, version = "9.0.0") {
  const bin = join(root, "host-bin");
  mkdirSync(bin);
  const calls = join(root, "host-calls.ndjson");
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
const {appendFileSync,readFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(args[0]==='--version') console.log(${JSON.stringify(version)});
else if(args.join(' ')==='install --frozen-lockfile --ignore-scripts') {}
else {
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 const name=args[0]==='run'?args[1]:args[0];
 const result=spawnSync('/bin/sh',['-c',pkg.scripts[name]],{stdio:'inherit',env:process.env});
 process.exitCode=result.status??1;
}
`,
    { mode: 0o755 },
  );
  // Fail the fixture if validation or its lookup ever requests a login shell.
  writeFileSync(
    join(bin, "sh"),
    `#!/bin/sh
case "$1" in -c) ;; *) exit 91 ;; esac
exec /bin/sh "$@"
`,
    { mode: 0o755 },
  );
  return { bin, calls };
}

function descriptor(root, target, commands, finalCommands = ["pnpm test"]) {
  const item = (id, validation, ownedPaths, dependencies = []) => ({
    id,
    title: id,
    goal: `Implement ${id}`,
    acceptance: [`${id} fixture exists`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths,
    resources: [],
    validation: validation.map((command) => ({
      command,
      provenance: "source-declared",
      source: "OBJECTIVE",
    })),
    brief: "Create only declared fixture paths",
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  });
  const pkg = {
    packageManager: "pnpm@9.0.0",
    scripts: {
      check: "test -s proof.txt",
      test: "test -s proof.txt && test -s downstream.txt",
    },
  };
  return {
    config: factoryConfig(target.checkout, "example/preflight", "regular", 1),
    fakeRoot: join(root, "fake"),
    objectiveBody: `# Preflight fixture\n\n## Acceptance\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${finalCommands.map((c) => `- \`${c}\``).join("\n")}\n`,
    graph: {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        item("bootstrap", commands.slice(0, -1), [
          "package.json",
          "pnpm-lock.yaml",
          "proof.txt",
        ]),
        item("dependent", [commands.at(-1)], ["downstream.txt"], ["bootstrap"]),
      ],
    },
    actions: {
      bootstrap: {
        files: [
          { path: "package.json", text: JSON.stringify(pkg) },
          { path: "pnpm-lock.yaml", text: "lockfileVersion: '9.0'\n" },
          { path: "proof.txt", text: "proof\n" },
        ],
      },
      dependent: { files: [{ path: "downstream.txt", text: "downstream\n" }] },
    },
  };
}

test("known missing final tools fail before planning spend", async () => {
  await fixture(async (root) => {
    const target = createTarget(root);
    const setup = makeApplication({
      ...descriptor(root, target, ["test -s proof.txt"]),
      planningModel: {
        async compile() {
          assert.fail("planner must not run");
        },
        async reviewGraph() {
          assert.fail("reviewer must not run");
        },
      },
    });
    process.env.PATH = "/usr/bin:/bin";
    await assert.rejects(
      setup.application.planObjective(1),
      /final.*command index 0.*executable pnpm/,
    );
    assert.equal(readState("example/preflight", 1), undefined);
    assert.deepEqual(setup.github.state().projections, {});
  });
});

test("missing work-item tools stop activation before projection, attempt or target mutation", async () => {
  await fixture(async (root) => {
    const target = createTarget(root);
    const commands = [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm check",
      "pnpm check",
    ];
    process.env.PATH = "/usr/bin:/bin";
    const setup = makeApplication(descriptor(root, target, commands, ["true"]));
    process.env.PATH = "/usr/bin:/bin";
    const plan = await setup.application.planObjective(1);
    assert.equal(plan.review.status, "clean");
    await assert.rejects(
      setup.application.runObjective(1, plan),
      /work-item bootstrap.*command index 0.*executable pnpm.*PATH=\/usr\/bin:\/bin/,
    );
    const events = readDiagnostics("example/preflight", 1).filter(
      (e) => e.operation === "local-executable-preflight",
    );
    const missingWorkItem = events.find(
      (e) =>
        e.itemId === "bootstrap" &&
        e.metadata.commandIndex === 0 &&
        e.metadata.executable === "pnpm",
    );
    assert.equal(missingWorkItem.outcome, "failed");
    assert.deepEqual(missingWorkItem.metadata, {
      origin: "work-item",
      source: "OBJECTIVE",
      commandIndex: 0,
      executable: "pnpm",
      preflightStatus: "missing",
      pathContext: "/usr/bin:/bin",
    });
    const preparation = readContinuation("example/preflight", 1);
    assert.equal(preparation.schemaVersion, 3);
    assert.equal(preparation.planning, "complete");
    assert.deepEqual(preparation.issueByItemId, {});
    assert.match(preparation.coordinator.waitReason, /pnpm/);
    assert.deepEqual(readEvents(setup.eventsPath), []);
    assert.deepEqual(setup.github.state().projections, {});
    assert.equal(git(target.checkout, "rev-parse", "HEAD"), target.baseSha);
    assert.equal(git(target.checkout, "status", "--porcelain"), "");
  });
});

test("task-private pinned host tools pass and newly created dependent scripts validate normally", async () => {
  await fixture(async (root) => {
    const target = createTarget(root, {
      "package.json": JSON.stringify({
        packageManager: "pnpm@9.0.0",
        scripts: {},
      }),
    });
    const tools = hostTools(root);
    const home = join(root, "operator-home");
    mkdirSync(home);
    const profileMarker = join(root, "profile-ran");
    writeFileSync(
      join(home, ".profile"),
      `printf profile > '${profileMarker}'\n`,
    );
    process.env.HOME = home;
    process.env.PATH = `${tools.bin}:/usr/bin:/bin`;
    const commands = [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm check",
      "pnpm check",
    ];
    const setup = makeApplication(descriptor(root, target, commands));
    const plan = await setup.application.planObjective(1);
    assert.ok(plan.commands.some((c) => /new|result/i.test(c.reason)));
    const state = await setup.application.runObjective(1, plan);
    assert.equal(state.finalValidation.passed, true);
    assert.equal(state.objectiveClosure, "complete");
    assert.equal(
      readEvents(setup.eventsPath).filter((e) => e.type === "start").length,
      2,
    );
    const hostCalls = readEvents(tools.calls);
    assert.ok(hostCalls.some((c) => c.args[0] === "--version"));
    assert.ok(hostCalls.some((c) => c.args[0] === "test"));
    assert.ok(
      hostCalls
        .filter((c) => c.args[0] === "--version")
        .every(
          (c) => !c.cwd.includes("target") && !c.cwd.includes("worktrees"),
        ),
    );
    assert.equal(existsSync(profileMarker), false);
  });
});

test("activation rechecks changed PATH, final requirements, pinned mismatches and safe version location", async () => {
  await fixture(async (root) => {
    const target = createTarget(root, {
      "package.json": JSON.stringify({
        packageManager: "pnpm@9.0.0",
        scripts: {},
      }),
    });
    const tools = hostTools(root, "9.0.0");
    process.env.PATH = `${tools.bin}:/usr/bin:/bin`;
    const setup = makeApplication(
      descriptor(
        root,
        target,
        ["test -s proof.txt", "test -s downstream.txt"],
        ["pnpm test"],
      ),
    );
    const plan = await setup.application.planObjective(1);
    process.env.PATH = "/usr/bin:/bin";
    await assert.rejects(
      setup.application.runObjective(1, plan),
      /final.*command index 0.*executable pnpm/,
    );
    writeFileSync(join(tools.bin, "pnpm"), `#!/bin/sh\necho 8.0.0\n`, {
      mode: 0o755,
    });
    process.env.PATH = `${tools.bin}:/usr/bin:/bin`;
    await assert.rejects(
      setup.application.runObjective(1, plan),
      /version-mismatch.*pnpm@9.0.0.*8.0.0/,
    );
    assert.equal(readState("example/preflight", 1), undefined);
    assert.deepEqual(readEvents(setup.eventsPath), []);
    assert.deepEqual(setup.github.state().projections, {});
  });
});

test("fixed lookups use supplied environment, do not execute target commands, and expose coverage limits", async () => {
  await fixture(async (root) => {
    const target = createTarget(root);
    const tools = hostTools(root);
    process.env.PATH = `${tools.bin}:/usr/bin:/bin`;
    assert.notEqual(
      resolveLocalExecutable("pnpm", root, { PATH: "/usr/bin:/bin" }, "/bin/sh")
        .status,
      0,
    );
    assert.equal(
      resolveLocalExecutable(
        "pnpm",
        root,
        { PATH: process.env.PATH },
        "/bin/sh",
      ).status,
      0,
    );
    assert.deepEqual(localValidationShellArguments("literal command"), [
      "-c",
      "literal command",
    ]);
    const marker = join(root, "target-hook-ran");
    const checks = [
      `test "$(touch ${marker})" = x`,
      'printf "quoted && not_an_executable"',
      "printf ok # comment; nonexistent_preflight_tool",
      "printf ok & nonexistent_preflight_tool",
      '"$DYNAMIC_TOOL" --do-not-execute',
      "if false; then no_such_tool; fi",
    ];
    const graph = descriptor(root, target, checks, []).graph;
    const observations = [];
    preflightLocalExecutables({
      checkout: target.checkout,
      baseSha: target.baseSha,
      graph,
      finalCommands: [],
      privateRoot: root,
      credentialDirectory: join(root, "empty"),
      observe: (e) => observations.push(e),
    });
    assert.equal(existsSync(marker), false);
    assert.ok(observations.some((e) => e.status === "unverified"));
    assert.equal(
      observations.some((e) => e.status === "missing"),
      false,
    );
    assert.equal(existsSync(tools.calls), false);
    const literal = descriptor(
      root,
      target,
      ["test -s proof.txt", "printf ok && nonexistent_preflight_tool"],
      [],
    ).graph;
    assert.throws(
      () =>
        preflightLocalExecutables({
          checkout: target.checkout,
          baseSha: target.baseSha,
          graph: literal,
          finalCommands: [],
          privateRoot: root,
          credentialDirectory: join(root, "empty"),
          observe: () => {},
        }),
      /executable nonexistent_preflight_tool/,
    );
  });
});

test("target version commands, relative PATH and unsupported policies remain unverified without secret leakage", async () => {
  await fixture(async (root) => {
    const target = createTarget(root, {
      "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    });
    const tools = hostTools(root);
    const targetBin = join(target.checkout, "bin");
    mkdirSync(targetBin);
    const marker = join(root, "target-version-hook-ran");
    writeFileSync(
      join(targetBin, "pnpm"),
      `#!/bin/sh\nprintf hook > '${marker}'\nprintf '9.0.0\\n'\n`,
      { mode: 0o755 },
    );
    const run = (candidate, commands = ["pnpm check", "pnpm check"]) => {
      const observations = [];
      preflightLocalExecutables({
        checkout: candidate.checkout,
        baseSha: candidate.baseSha,
        graph: descriptor(root, candidate, commands, []).graph,
        finalCommands: [],
        privateRoot: root,
        credentialDirectory: join(root, "empty"),
        secrets: [root],
        observe: (entry) => observations.push(entry),
      });
      assert.ok(observations.some((entry) => entry.status === "unverified"));
      assert.ok(!JSON.stringify(observations).includes(root));
      return observations;
    };
    process.env.PATH = `${targetBin}:/usr/bin:/bin`;
    run(target);
    const alias = join(root, "checkout-alias");
    symlinkSync(target.checkout, alias, "dir");
    run({ ...target, checkout: alias });
    const nested = join(target.checkout, "nested");
    mkdirSync(nested);
    run({ ...target, checkout: nested });
    assert.equal(existsSync(marker), false);
    const customMarker = join(root, "target-custom-tool-ran");
    writeFileSync(
      join(targetBin, "custom_target_tool"),
      `#!/bin/sh\nprintf hook > '${customMarker}'\n`,
      { mode: 0o755 },
    );
    const customAlias = join(root, "custom-bin-alias");
    symlinkSync(targetBin, customAlias, "dir");
    for (const path of [targetBin, customAlias]) {
      process.env.PATH = `${path}:/usr/bin:/bin`;
      for (const checkout of [target.checkout, alias, nested]) {
        const observations = run({ ...target, checkout }, [
          "custom_target_tool check",
          "custom_target_tool check",
        ]);
        const custom = observations.filter(
          (entry) => entry.executable === "custom_target_tool",
        );
        assert.ok(custom.length > 0);
        assert.ok(custom.every((entry) => entry.status === "unverified"));
      }
    }
    assert.equal(existsSync(customMarker), false);
    process.env.PATH = `${targetBin}:/usr/bin:/bin`;
    const shellMarker = join(root, "target-shell-hook-ran");
    writeFileSync(
      join(targetBin, "sh"),
      `#!/bin/sh\nprintf hook > '${shellMarker}'\n`,
      { mode: 0o755 },
    );
    for (const checkout of [target.checkout, alias, nested]) {
      const observations = run({ ...target, checkout });
      assert.ok(!observations.some((entry) => entry.status === "ready"));
    }
    const binAlias = join(root, "target-bin-alias");
    symlinkSync(targetBin, binAlias, "dir");
    process.env.PATH = `${binAlias}:/usr/bin:/bin`;
    run(target);
    assert.equal(existsSync(shellMarker), false);
    process.env.PATH = `${tools.bin}:.:/usr/bin:/bin`;
    run(target);
    assert.equal(existsSync(tools.calls), false);
    const unsupported = createTarget(join(root, "unsupported"), {
      "package.json": JSON.stringify({ packageManager: "pnpm@>=9" }),
    });
    process.env.PATH = `${tools.bin}:/usr/bin:/bin`;
    run(unsupported);
    assert.equal(existsSync(tools.calls), false);
    chmodSync(join(tools.bin, "pnpm"), 0o600);
    assert.throws(() => run(target), /missing.*executable pnpm/);
  });
});
