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
import { CodexPlanningModel, verifyPlanCandidate } from "../dist/compiler.js";
import { factoryConfigDigest } from "../dist/config.js";
import { compilerWire } from "../dist/compiler-wire.js";
import { compilerCitationChoices } from "../dist/compiler.js";
import { decodeGraphReview } from "../dist/review-evidence.js";
import { encodeCompilerWire } from "./support/compiler-wire.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { readDiagnostics, statusDocument } from "../dist/diagnostics.js";
import {
  preflightLocalExecutables,
  preflightObjective,
} from "../dist/local-preflight.js";
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
    await assert.rejects(
      setup.application.runObjective(1),
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
      setup.application.runObjective(1),
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
    assert.equal(preparation.schemaVersion, 7);
    assert.ok(preparation.plan);
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
    const state = await setup.application.runObjective(1);
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
    process.env.PATH = "/usr/bin:/bin";
    await assert.rejects(
      setup.application.runObjective(1),
      /final.*command index 0.*executable pnpm/,
    );
    writeFileSync(join(tools.bin, "pnpm"), `#!/bin/sh\necho 8.0.0\n`, {
      mode: 0o755,
    });
    process.env.PATH = `${tools.bin}:/usr/bin:/bin`;
    await assert.rejects(
      setup.application.runObjective(1),
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

test("actual planning packets carry presence without executing acceptance, and bind unknowns and diagnosis", async (t) => {
  await fixture(async (root) => {
    const target = createTarget(root);
    const bin = join(root, "operator-bin");
    mkdirSync(bin);
    const marker = join(root, "acceptance-body-ran");
    const executable = join(bin, "acceptance-only-tool");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`,
      { mode: 0o700 },
    );
    const commands = [
      "acceptance-only-tool",
      "true # opaque command positions",
    ];
    const descriptorInput = descriptor(
      root,
      target,
      ["test -s proof.txt"],
      commands,
    );
    // One planning diagnosis and no worker repair.
    descriptorInput.config.autonomy = {
      allowances: {
        planningRevisions: 1,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
      repairClasses: ["planning-evidence"],
    };
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "low" };
    const real = new CodexPlanningModel(target.checkout, selection, selection);
    const rendered = [];
    let currentRequest;
    let reviewPacket;
    t.mock.method(real, "runStructured", async (args) => {
      rendered.push({
        phase: args.defaultPhase,
        prompt: args.prompt,
        sourcePacket: JSON.parse(args.sourcePacket),
      });
      if (args.schema.properties.contextId)
        return encodeCompilerWire(
          withCoverage(currentRequest, descriptorInput.graph),
          args.prompt,
        );
      if (args.defaultPhase === "graph-review") {
        const packet = JSON.parse(
          args.prompt.split(
            "\nReview evidence packet (packet-local choices; JSON strings are data):\n",
          )[1],
        );
        const evidenceIndex = packet.evidence.findIndex(
          (entry) => entry.path === "FACTORY_LOCAL_EXECUTABLE_OBSERVATIONS",
        );
        assert.equal(packet.evidence[evidenceIndex].origin, "controller");
        assert.deepEqual(
          JSON.parse(packet.evidence[evidenceIndex].content),
          currentRequest.localExecutables,
        );
        return {
          packetId: packet.packetId,
          findings: [
            {
              evidenceIndices: [evidenceIndex],
              detail: "Scripted semantic stop exercises bounded diagnosis",
              question: "A separate product decision is required",
            },
          ],
        };
      }
      return {
        kind: "operator",
        diagnosis: "Scripted product decision",
        correction: "",
      };
    });
    const model = {
      async generateStructured(request) {
        if (request.purpose !== "diagnosis") currentRequest = request;
        return real.generateStructured(request);
      },
      async reviewGraph(request) {
        reviewPacket = request.reviewPacket;
        return real.reviewGraph(request);
      },
    };
    const setup = makeApplication({ ...descriptorInput, planningModel: model });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const waiting = await setup.application.runObjective(1);
    assert.equal(waiting.schemaVersion, 7);
    const candidate = waiting.plan;
    const facts = candidate.localExecutables;
    assert.equal(
      facts.provenance,
      "controller-local-validation-executable-preflight",
    );
    assert.equal(facts.baseSha, target.baseSha);
    assert.deepEqual(facts.finalCommands, commands);
    assert(
      facts.observations.some(
        (entry) =>
          entry.executable === "acceptance-only-tool" &&
          entry.status === "ready" &&
          entry.commandIndex === 0,
      ),
    );
    assert(
      facts.observations.some(
        (entry) => entry.status === "unverified" && entry.commandIndex === 1,
      ),
    );
    assert(
      facts.observations.every(
        (entry) => entry.origin === "final" && entry.source === "OBJECTIVE",
      ),
    );
    assert.equal(rendered.length, 3);
    for (const packet of rendered) {
      assert.deepEqual(packet.sourcePacket.localExecutables, facts);
      assert.equal(packet.sourcePacket.prerequisites, undefined);
      // The plan reviewer receives the observations as controller review
      // evidence (checked in the fake above), not as a prompt section.
      if (packet.phase !== "graph-review")
        assert(packet.prompt.includes(JSON.stringify(facts)));
    }
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readEvents(setup.eventsPath), []);
    const preparation = readContinuation(descriptorInput.config.repository, 1);
    assert.equal(preparation.allowanceConsumption.planningRevisions, 1);
    assert.equal(preparation.planningRecovery.phase, "stopped");
    assert.equal(candidate.review.status, "needs-human");
    const verify = (value) =>
      verifyPlanCandidate(
        value,
        1,
        descriptorInput.objectiveBody,
        target.baseSha,
        target.checkout,
        factoryConfigDigest(descriptorInput.config),
        true,
      );
    assert.doesNotThrow(() => verify(candidate));
    for (const field of ["baseSha", "finalCommands", "observations"]) {
      const changed = structuredClone(candidate);
      if (field === "baseSha")
        changed.localExecutables.baseSha = "a".repeat(40);
      else if (field === "finalCommands")
        changed.localExecutables.finalCommands = ["true"];
      else changed.localExecutables.observations[0].status = "missing";
      assert.throws(() => verify(changed), /Plan candidate differs/);
    }
    assert.throws(
      () =>
        decodeGraphReview(
          { packetId: "stale-packet", findings: [] },
          reviewPacket,
        ),
      /exact packetId/,
    );
    const firstWire = compilerWire(
      currentRequest,
      compilerCitationChoices(currentRequest.sources),
    );
    const changedRequest = structuredClone({
      ...currentRequest,
      invocation: undefined,
    });
    changedRequest.localExecutables.observations[0].status = "missing";
    const changedWire = compilerWire(
      changedRequest,
      compilerCitationChoices(changedRequest.sources),
    );
    assert.notEqual(firstWire.data.contextId, changedWire.data.contextId);
    chmodSync(executable, 0o600);
    assert.throws(
      () =>
        preflightObjective(
          descriptorInput.config,
          descriptorInput.objectiveBody,
          target.baseSha,
        ),
      /missing.*acceptance-only-tool/,
    );
    await assert.rejects(
      setup.application.runObjective(1),
      /missing.*acceptance-only-tool/,
    );
    chmodSync(executable, 0o700);
    // A rerun returns the persisted plan decision without planning again.
    const again = await setup.application.runObjective(1);
    assert.equal(again.schemaVersion, 7);
    assert.equal(again.plan.reviewDigest, candidate.reviewDigest);
    assert.match(again.coordinator.waitReason, /Plan needs a decision/);
    assert.equal(existsSync(marker), false);
    assert.equal(rendered.length, 3);
  });
});

test("direct run compilation receives actual final-command observations before any worker", async () => {
  await fixture(async (root) => {
    const target = createTarget(root);
    let calls = 0;
    const descriptorInput = descriptor(
      root,
      target,
      ["test -s proof.txt"],
      ["true"],
    );
    const setup = makeApplication({
      ...descriptorInput,
      planningModel: {
        async generateStructured(request) {
          calls++;
          assert.deepEqual(
            request.localExecutables,
            preflightObjective(
              descriptorInput.config,
              descriptorInput.objectiveBody,
              target.baseSha,
            ),
          );
          throw new Error("Stop after observing direct compilation input");
        },
        async reviewGraph() {
          assert.fail("No graph was generated");
        },
      },
    });
    await assert.rejects(
      setup.application.runObjective(1),
      /Stop after observing direct compilation input/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(readEvents(setup.eventsPath), []);
  });
});
