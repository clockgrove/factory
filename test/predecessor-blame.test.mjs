// A failure caused by a merged predecessor is not repaired on the dependent (#672).
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { blameDecision } from "../dist/blame-decision.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  assertRepairLedger,
  defaultAutonomy,
  consumption,
  releaseCharge,
} from "../dist/repair-policy.js";
import {
  readContinuation,
  readState,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  applyWorkCorrection,
  CandidateValidationFailure,
  diagnoseWorkRepair,
  recordWorkFailure,
} from "../dist/work-repair.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  ScriptedPlanningModel,
} from "./support/integration-fixture.mjs";

const autonomy = {
  allowances: {
    planningRevisions: 2,
    implementationRepairs: 2,
    resultRereviews: 2,
  },
  repairClasses: ["implementation"],
  repairPolicy: {
    perPath: {
      planningRevisions: 2,
      implementationRepairs: 2,
      resultRereviews: 2,
    },
  },
  requiredEnvironment: [],
};
const workItem = (id, ownedPaths, dependencies, command) => ({
  id,
  kind: "work",
  children: [],
  title: id,
  goal: id,
  brief: `Write ${ownedPaths[0]}`,
  acceptance: [`${ownedPaths[0]} works`],
  nonGoals: [],
  citations: [{ path: "OBJECTIVE" }],
  dependencies,
  ownedPaths,
  resources: [],
  validation: [{ command, provenance: "source-declared", source: "OBJECTIVE" }],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
});
const lib = workItem(
  "lib",
  ["live/p2c/lib.sh", "live/p2c/gone.sh"],
  [],
  "sh -n live/p2c/lib.sh",
);
const cli = workItem(
  "cli",
  ["live/p2c/hello.sh"],
  ["lib"],
  'test "$(sh live/p2c/hello.sh)" = "hello, world"',
);
const execFileAsync = promisify(execFile);
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** The live scenario: lib merged printing "hello world"; cli's correct script fails because of it. */
function liveScenario(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-blame-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  const files = {
    "README.md": "# Target\n",
    "live/p2c/lib.sh": 'greet() { echo "hello world"; }\n',
    "live/p2c/hello.sh": '. "$(dirname "$0")/lib.sh"\ngreet\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", "-A");
  git(
    checkout,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "lib and cli",
  );
  const state = {
    objective: 65,
    autonomy,
    graph: { items: [lib, cli] },
    work: {
      lib: {
        status: "done",
        pullRequest: 69,
        integratedSha: "d".repeat(40),
      },
      cli: {
        status: "failed",
        step: "validate",
        attempt: "first",
        baseSha: "a".repeat(40),
        changeRef: git(checkout, "rev-parse", "HEAD"),
        treeSha: git(checkout, "rev-parse", "HEAD^{tree}"),
      },
    },
    baseSha: "a".repeat(40),
    runId: "run",
  };
  recordWorkFailure(
    state,
    "cli",
    new CandidateValidationFailure(
      'Validation command failed (1): test "$(sh live/p2c/hello.sh)" = "hello, world"',
    ),
  );
  return { checkout, state };
}
const clock = () => {
  let now = Date.now();
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
};
const blame = (predecessor, path) => ({
  decision: "predecessor",
  diagnosis: "lib.sh prints hello world, which cli's script only forwards",
  correction: "",
  predecessor,
  path,
});

test("a failure in a merged predecessor's file stops with a decision and spends no repair", async (t) => {
  const { checkout, state } = liveScenario(t);
  const requests = [];
  const model = {
    generateStructured: async (request) => {
      requests.push(request);
      return blame("lib", "live/p2c/lib.sh");
    },
  };
  const diagnose = () =>
    diagnoseWorkRepair({
      state,
      item: cli,
      model,
      checkout,
      save: () => {},
      stopped: () => false,
      clock: clock(),
    });
  assert.equal(await diagnose(), false);

  // The diagnosis saw the contents of both the item's and the predecessor's file.
  assert.equal(requests.length, 1);
  const sources = requests[0].sources;
  assert.match(
    sources.find((source) => source.path === "live/p2c/lib.sh").content,
    /hello world/,
  );
  assert.ok(sources.some((source) => source.path === "live/p2c/hello.sh"));
  assert.ok(
    !sources.some((source) => source.path === "README.md"),
    "files nobody involved owns are not sent",
  );

  // No repair was spent and none is offered.
  const recovery = state.work.cli.recovery;
  assert.equal(consumption(state).implementationRepairs, 0);
  assert.equal(recovery.phase, "stopped");
  assert.equal(recovery.correction, undefined);
  assert.equal(recovery.failure.classification, "decision");
  assert.equal(recovery.failure.event, undefined);
  assert.deepEqual(recovery.failure.predecessor, {
    item: "lib",
    path: "live/p2c/lib.sh",
    pullRequest: 69,
    diagnosis: "lib.sh prints hello world, which cli's script only forwards",
    // The graph the blame was made on: a later amendment changes it.
    graphDigest: graphDigest(state.graph),
  });
  // The decision names the predecessor, its PR and the file, and a way that works.
  assert.match(recovery.failure.decision, /live\/p2c\/lib\.sh/);
  assert.match(recovery.failure.decision, /lib \(PR #69\)/);
  assert.match(recovery.failure.decision, /propose-amendment --objective 65/);
  assert.match(recovery.failure.decision, /retry --objective 65 --item cli/);
  assertRepairLedger(state);
  assert.throws(
    () =>
      applyWorkCorrection(state, "cli", {
        kind: "implementation",
        failureDigest: recovery.failure.digest,
        diagnosis: "Rewrite hello.sh",
        correction: "Rewrite hello.sh",
        actor: "operator",
      }),
    /Only a wrong result can be repaired/,
  );
  // Asking again (a restart) neither calls the model nor changes the decision.
  assert.equal(await diagnose(), false);
  assert.equal(requests.length, 1);
});

/** Each answer is invalid and asked again with its reason; then a repair applies. */
async function askUntilRepaired(t, invalid) {
  const { checkout, state } = liveScenario(t);
  const answers = [
    ...invalid,
    {
      decision: "repair",
      diagnosis: "hello.sh forgot to call greet",
      correction: "Call greet from hello.sh",
      predecessor: "",
      path: "",
    },
  ];
  const prompts = [];
  const model = {
    generateStructured: async (request) => {
      prompts.push(request.objective);
      return answers.shift();
    },
  };
  const repaired = await diagnoseWorkRepair({
    state,
    item: cli,
    model,
    checkout,
    save: () => {},
    stopped: () => false,
    clock: clock(),
  });
  assert.equal(repaired, true);
  assert.equal(prompts.length, invalid.length + 1);
  assert.equal(state.work.cli.status, "pending");
  assert.equal(consumption(state).implementationRepairs, 1);
  return prompts;
}

test("a blame the accepted graph does not support is asked again, then repaired normally", async (t) => {
  const prompts = await askUntilRepaired(t, [
    // Not a predecessor of cli.
    blame("ghost", "live/p2c/lib.sh"),
    // A path the predecessor does not own.
    blame("lib", "live/p2c/other.sh"),
    // The failing item's own file.
    blame("lib", "live/p2c/hello.sh"),
  ]);
  assert.match(prompts[1], /ghost is not a merged predecessor of cli/);
  assert.match(prompts[2], /live\/p2c\/other\.sh is not owned by lib/);
  assert.match(prompts[3], /live\/p2c\/hello\.sh is not owned by lib/);
});

test("a blame must name a regular file of the failed result", async (t) => {
  const prompts = await askUntilRepaired(t, [
    // A directory (trailing slash), and a path that is not Git-relative.
    blame("lib", "docs/"),
    blame("lib", "../live/p2c/lib.sh"),
    // Owned by the predecessor, but not in the failed result.
    blame("lib", "live/p2c/gone.sh"),
  ]);
  assert.match(prompts[1], /docs\/ is not a file path/);
  assert.match(prompts[2], /\.\.\/live\/p2c\/lib\.sh is not a file path/);
  assert.match(
    prompts[3],
    /live\/p2c\/gone\.sh is not a regular file in the result of cli/,
  );
});

test("a repair answer still spends its allowance", async (t) => {
  const { checkout, state } = liveScenario(t);
  const model = {
    generateStructured: async () => ({
      decision: "repair",
      diagnosis: "hello.sh forgot to call greet",
      correction: "Call greet from hello.sh",
      predecessor: "",
      path: "",
    }),
  };
  assert.equal(
    await diagnoseWorkRepair({
      state,
      item: cli,
      model,
      checkout,
      save: () => {},
      stopped: () => false,
      clock: clock(),
    }),
    true,
  );
  assert.equal(consumption(state).implementationRepairs, 1);
});

test("diagnosis evidence lists the failing item's files first and skips only what does not fit", async (t) => {
  const { checkout, state } = liveScenario(t);
  // Sorts before the item's own file; five files too large for the budget
  // together, then a small one after them.
  const wide = { ...lib, ownedPaths: ["a/", "z.txt"] };
  state.graph.items[0] = wide;
  const extra = {};
  for (let n = 1; n <= 5; n++) extra[`a/${n}.txt`] = "x".repeat(20_000);
  extra["a/huge.bin"] = "y".repeat(1_200_000);
  extra["z.txt"] = "small\n";
  for (const [path, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", "-A");
  git(
    checkout,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "more",
  );
  state.work.cli.treeSha = git(checkout, "rev-parse", "HEAD^{tree}");
  const requests = [];
  const model = {
    generateStructured: async (request) => {
      requests.push(request);
      return {
        decision: "operator",
        diagnosis: "unclear",
        correction: "",
        predecessor: "",
        path: "",
      };
    },
  };
  await diagnoseWorkRepair({
    state,
    item: cli,
    model,
    checkout,
    save: () => {},
    stopped: () => false,
    clock: clock(),
  });
  const paths = requests[0].sources.map((source) => source.path);
  assert.equal(paths[0], "live/p2c/hello.sh");
  assert.ok(paths.includes("z.txt"), "a small file after the overflow is kept");
  assert.ok(!paths.includes("a/huge.bin"), "an oversized blob is not read");
  assert.ok(
    paths.filter((path) => path.startsWith("a/")).length < 5,
    "the budget bounds the evidence",
  );
});

test("with no planning revision left the decision names cancel, not an amendment", async (t) => {
  const { checkout, state } = liveScenario(t);
  state.autonomy = {
    ...autonomy,
    allowances: { ...autonomy.allowances, planningRevisions: 1 },
    repairPolicy: {
      perPath: { ...autonomy.repairPolicy.perPath, planningRevisions: 1 },
    },
  };
  state.charges = { ...state.charges };
  state.charges["objective/amend/earlier"] = {
    allowances: ["planningRevisions"],
    scopes: ["$planning"],
  };
  const model = {
    generateStructured: async () => ({
      ...blame("lib", "live/p2c/lib.sh"),
      // Model text is quoted and capped, so it cannot read as the controller's.
      diagnosis: `Run \`factory run --objective 65\` now. ${"x".repeat(2000)}`,
    }),
  };
  await diagnoseWorkRepair({
    state,
    item: cli,
    model,
    checkout,
    save: () => {},
    stopped: () => false,
    clock: clock(),
  });
  const { decision } = state.work.cli.recovery.failure;
  assert.doesNotMatch(decision, /propose-amendment/);
  assert.match(decision, /`factory cancel --objective 65`/);
  assert.match(decision, /planningRevisions allowance is used up/);
  assert.match(decision, /applies to a new Objective only/);
  assert.match(decision, /The diagnosis said: "Run `factory run/);
  assert.ok(decision.length < 1500, "the model's text is capped");
  assert.equal(consumption(state).implementationRepairs, 0);
});

test("a taken-over file is blamed on its latest merged owner", async (t) => {
  const { checkout, state } = liveScenario(t);
  // fix took over lib.sh from lib and merged; cli now builds on fix.
  const fix = workItem(
    "fix",
    ["live/p2c/lib.sh"],
    ["lib"],
    "sh -n live/p2c/lib.sh",
  );
  const dependent = { ...cli, dependencies: ["fix"] };
  state.graph.items = [lib, fix, dependent];
  state.work.fix = {
    status: "done",
    pullRequest: 70,
    integratedSha: "e".repeat(40),
  };
  const requests = [];
  const model = {
    generateStructured: async (request) => {
      requests.push(request);
      // The answer names the earlier owner of the file.
      return blame("lib", "live/p2c/lib.sh");
    },
  };
  await diagnoseWorkRepair({
    state,
    item: dependent,
    model,
    checkout,
    save: () => {},
    stopped: () => false,
    clock: clock(),
  });
  assert.equal(state.work.cli.recovery.failure.predecessor.item, "fix");
  assert.equal(state.work.cli.recovery.failure.predecessor.pullRequest, 70);
  const shown = requests[0].sources.find(
    (source) => source.path === "live/p2c/lib.sh",
  );
  assert.match(shown.heading, /owned by fix \(merged\)/);
});

test("releasing a charge gives back only the implementation repair", () => {
  const state = {
    charges: {
      "item/cli/validate/0": {
        allowances: ["implementationRepairs", "resultRereviews"],
        scopes: ["cli"],
      },
      "item/lib/validate/0": {
        allowances: ["implementationRepairs"],
        scopes: ["lib"],
      },
    },
  };
  releaseCharge(state, "item/cli/validate/0");
  assert.deepEqual(state.charges["item/cli/validate/0"].allowances, [
    "resultRereviews",
  ]);
  releaseCharge(state, "item/lib/validate/0");
  assert.equal(state.charges["item/lib/validate/0"], undefined);
});

// The stop's named commands, run as written, fix the predecessor (#672).
const bodyWith = (command) =>
  `## Acceptance\n- result.txt exists\n\n## Commands\n- \`test -s result.txt\`\n- \`${command}\`\n\n## Final validation\n- \`test -s result.txt\`\n`;
const fileItem = (id, file, dependencies, command) => ({
  id,
  title: id,
  kind: "work",
  goal: `Write ${file}`,
  brief: `Write ${file}`,
  acceptance: [`${file} exists`],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
  dependencies,
  ownedPaths: [file],
  resources: [],
  validation: [{ command, provenance: "source-declared", source: "OBJECTIVE" }],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
});
const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function until(check) {
  for (let n = 0; n < 3000; n++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Fixture condition not reached");
}
const NEXT_CHECK = 'test "$(cat result.txt)" = good';

/**
 * result merges bad content; next (after result) cannot pass on it and is
 * blamed on result. `held` adds an independent item whose PR waits for CI,
 * which keeps the owner alive through the stop.
 */
async function blameFixture(name, { held = false, limits } = {}, run) {
  const root = mkdtempSync(join(tmpdir(), "factory-blame-fix-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = {
      ...factoryConfig(
        target.checkout,
        `example/blame-fix-${name}`,
        "regular",
        held ? 2 : 1,
      ),
      autonomy: limits ?? autonomy,
    };
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        fileItem("result", "result.txt", [], "test -s result.txt"),
        fileItem("next", "next.txt", ["result"], NEXT_CHECK),
        ...(held
          ? [fileItem("other", "other.txt", ["result"], "test -s result.txt")]
          : []),
      ],
    };
    const fakeRoot = join(root, "fake");
    const scripted = new ScriptedPlanningModel(
      graph,
      join(fakeRoot, "planning.ndjson"),
    );
    let first;
    let amendments = 0;
    const planningModel = Object.create(scripted);
    planningModel.generateStructured = async (request) => {
      if (request.purpose === "diagnosis")
        return {
          decision: "predecessor",
          diagnosis: "result.txt holds the wrong content",
          correction: "",
          predecessor: "result",
          path: "result.txt",
        };
      if (!request.compileContext?.immutableItemIds)
        return (first = await scripted.generateStructured(request));
      amendments++;
      const amended = structuredClone(first);
      // The fix takes over result.txt, which the merged result item owns.
      amended.items.push(
        fileItem("fix", "result.txt", ["result"], "test -s result.txt"),
      );
      return amended;
    };
    const setup = makeApplication({
      config,
      graph,
      objectiveBody: bodyWith(NEXT_CHECK),
      fakeRoot,
      planningModel,
      actions: {
        result: { files: [{ path: "result.txt", text: "bad\n" }] },
        fix: { files: [{ path: "result.txt", text: "good\n" }] },
        next: { files: [{ path: "next.txt", text: "done\n" }] },
        other: { files: [{ path: "other.txt", text: "done\n" }] },
      },
    });
    // The first PR (result) passes its checks; later ones wait for the test.
    const { github } = setup;
    const publish = github.publish.bind(github);
    let published = 0;
    github.publish = async (request) => {
      const result = await publish(request);
      if (++published > 1)
        github.update((state) => {
          state.pullRequests[result.number].checks = "pending";
        });
      return result;
    };
    const checks = (number, value) =>
      github.update((state) => {
        state.pullRequests[number].checks = value;
      });
    const configPath = join(root, "factory.json");
    writeFileSync(configPath, JSON.stringify(config));
    const proposalPath = join(root, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        scope: "in-scope",
        reason: "result.txt holds the wrong content",
        evidence: ["next cannot pass on the merged result.txt"],
        ownership: ["result.txt"],
        acceptance: ["result.txt holds good content"],
        dependencies: ["result"],
        actor: "operator",
      }),
    );
    // Run one of the decision's commands exactly as it names it.
    const command = (text) => {
      const [, verb, ...args] = text.replace("FILE", proposalPath).split(" ");
      if (verb === "run") return setup.application.runObjective(1);
      return execFileAsync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../dist/cli.js"),
          verb,
          ...args,
          "--config",
          configPath,
        ],
        { encoding: "utf8" },
      ).then(({ stdout }) => stdout);
    };
    const proposal = (live) => {
      const state = live
        ? readContinuation(config.repository, 1)
        : readState(config.repository, 1);
      return {
        ...JSON.parse(readFileSync(proposalPath, "utf8")),
        expectedGraphDigest: graphDigest(state.graph),
      };
    };
    await run({
      ...setup,
      config,
      checks,
      command,
      proposalPath,
      amendments: () => amendments,
      prepare: (live) =>
        writeFileSync(proposalPath, JSON.stringify(proposal(live))),
      stateOf: () => readState(config.repository, 1),
      // Another amendment has used a planning revision.
      useRevision: () => {
        const state = readState(config.repository, 1);
        state.charges = {
          ...state.charges,
          "objective/amend/earlier": {
            allowances: ["planningRevisions"],
            scopes: ["$planning"],
          },
        };
        saveState(statePath(config.repository, 1), state);
      },
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
/** The commands the decision names, in order, as written. */
const namedCommands = (decision) =>
  [...decision.matchAll(/`(factory [^`]+)`/g)].map((match) => match[1]);

test("the stop's named commands, run as written while stopped, fix the predecessor and complete the Objective", async () =>
  blameFixture("stopped", {}, async (f) => {
    await f.application.runObjective(1).catch(() => undefined);
    const stopped = f.stateOf();
    assert.equal(stopped.work.result.status, "done");
    assert.equal(stopped.work.next.status, "failed");
    const commands = namedCommands(stopped.work.next.recovery.failure.decision);
    assert.deepEqual(
      commands.map((text) => text.split(" ")[1]),
      ["propose-amendment", "run", "retry", "run"],
    );
    const [amend, runFix, retry, runAgain] = commands;
    // No owner is running: the command is accepted offline.
    f.prepare(false);
    const accepted = JSON.parse(await f.command(amend));
    assert.equal(accepted.phase, "ready");
    assert.equal(f.stateOf().pendingAmendment.phase, "ready");

    // The next run compiles, reviews and projects it, and merges the fix.
    const fixRun = f.command(runFix);
    await until(() => {
      const fix = readContinuation(f.config.repository, 1)?.work?.fix;
      return fix?.status === "published";
    });
    f.checks(f.stateOf().work.fix.pullRequest, "passing");
    await fixRun.catch(() => undefined);
    const fixed = f.stateOf();
    assert.equal(f.amendments(), 1);
    assert.equal(fixed.work.fix.status, "done");
    assert.equal(fixed.work.next.status, "failed");

    // The blamed item starts over on the integrated head and passes.
    assert.match(await f.command(retry), /attempt/);
    const finished = f.command(runAgain);
    await until(() => {
      const next = readContinuation(f.config.repository, 1)?.work?.next;
      return next?.status === "published";
    });
    const retried = f.stateOf();
    assert.equal(retried.work.next.baseSha, retried.work.fix.integratedSha);
    f.checks(retried.work.next.pullRequest, "passing");
    const final = await finished;
    assert.equal(final.work.next.status, "done");
    assert.equal(final.finalValidation.passed, true);
    assert.equal(consumption(final).implementationRepairs, 0);
    // The fix owns the path the done predecessor owns.
    assert.deepEqual(
      final.graph.items
        .filter((entry) => entry.ownedPaths.includes("result.txt"))
        .map((entry) => entry.id),
      ["result", "fix"],
    );
  }));

/**
 * The default limits give one planning revision, and the amendment that fixes
 * the predecessor takes it. Each step below runs the command `factory status`
 * names, so a status that offers cancel (or a retry too early) fails here.
 */
test("at the default planningRevisions of 1, status names each step through blame, amendment, merged fix and retry", async () =>
  blameFixture("default", { limits: defaultAutonomy }, async (f) => {
    assert.equal(defaultAutonomy.allowances.planningRevisions, 1);
    const status = async () =>
      JSON.parse(await f.command("factory status --objective 1 --json"));
    await f.application.runObjective(1).catch(() => undefined);
    assert.equal(f.stateOf().work.next.status, "failed");

    // Blamed: the amendment comes first, and a planning revision is left.
    const blamed = await status();
    assert.equal(blamed.allowanceRemaining.objective.planningRevisions, 1);
    // The command that works first is the amendment; the retry is in the reason.
    assert.match(
      blamed.nextAction.command,
      /^factory propose-amendment --objective 1 --proposal FILE$/,
    );
    assert.match(
      blamed.nextAction.reason,
      /factory retry --objective 1 --item next/,
    );
    const [amend] = namedCommands(
      f.stateOf().work.next.recovery.failure.decision,
    );
    f.prepare(false);
    await f.command(amend);

    // Pending: status names what settles it, not cancel or retry.
    const pending = await status();
    assert.equal(pending.nextAction.command, "factory run --objective 1");
    assert.match(pending.nextAction.reason, /amendment .* is pending/);
    const stored = f.stateOf().work.next.recovery.failure.decision;
    assert.doesNotMatch(stored, /propose-amendment/);
    assert.match(stored, /An amendment is pending/);
    const fixRun = f.command(pending.nextAction.command);
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.work?.fix?.status ===
        "published",
    );
    // The run charged the one revision; mid-run the fix is still unmerged.
    f.checks(f.stateOf().work.fix.pullRequest, "passing");
    await fixRun.catch(() => undefined);
    const merged = f.stateOf();
    assert.equal(merged.work.fix.status, "done");
    assert.equal(merged.work.next.status, "failed");

    // Merged: no revision is left, yet the way forward is retry, not cancel.
    const after = await status();
    assert.equal(after.allowanceRemaining.objective.planningRevisions, 0);
    assert.equal(
      after.nextAction.command,
      "factory retry --objective 1 --item next",
    );
    assert.match(after.nextAction.reason, /landed and merged/);
    const refreshed = merged.work.next.recovery.failure.decision;
    assert.doesNotMatch(refreshed, /propose-amendment|factory cancel/);
    assert.match(refreshed, /The graph changed since this stop/);
    assert.deepEqual(
      namedCommands(refreshed).map((text) => text.split(" ")[1]),
      ["retry", "run"],
    );

    // The named retry starts a new attempt on the integrated head and passes.
    assert.match(await f.command(after.nextAction.command), /attempt/);
    const retried = await status();
    assert.equal(retried.nextAction.command, "factory run --objective 1");
    const finished = f.command(retried.nextAction.command);
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.work?.next?.status ===
        "published",
    );
    const live = f.stateOf();
    assert.equal(live.work.next.baseSha, live.work.fix.integratedSha);
    f.checks(live.work.next.pullRequest, "passing");
    const final = await finished;
    assert.equal(final.work.next.status, "done");
    assert.equal(final.finalValidation.passed, true);
    assert.equal(consumption(final).implementationRepairs, 0);
  }));

test("an owner already running takes the proposed amendment once in-flight delivery settles", async () =>
  blameFixture("live", { held: true }, async (f) => {
    const running = f.application.runObjective(1);
    // other waits for CI, which keeps the owner alive; next is blamed.
    await until(() => {
      const state = readContinuation(f.config.repository, 1);
      return (
        state?.work?.next?.status === "failed" &&
        state.work.other?.status === "published" &&
        state.work.next.recovery?.failure?.predecessor
      );
    });
    const [amend, , retry, runAgain] = namedCommands(
      readContinuation(f.config.repository, 1).work.next.recovery.failure
        .decision,
    );
    f.prepare(true);
    const accepted = JSON.parse(await f.command(amend));
    assert.equal(accepted.phase, "ready");

    // The owner takes the amendment once in-flight delivery settles.
    f.checks(
      readContinuation(f.config.repository, 1).work.other.pullRequest,
      "passing",
    );
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.work?.fix?.status ===
        "published",
    );
    f.checks(
      readContinuation(f.config.repository, 1).work.fix.pullRequest,
      "passing",
    );
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.work?.fix?.status === "done",
    );
    assert.equal(f.amendments(), 1);

    // With nothing left to run, the owner ends; the rest is the stopped path.
    await running.catch(() => undefined);
    await f.command(retry);
    const finished = f.command(runAgain);
    await until(
      () =>
        readContinuation(f.config.repository, 1)?.work?.next?.status ===
        "published",
    );
    const state = readContinuation(f.config.repository, 1);
    assert.equal(state.work.next.baseSha, state.work.fix.integratedSha);
    f.checks(state.work.next.pullRequest, "passing");
    const final = await finished;
    assert.equal(final.work.next.status, "done");
    assert.equal(final.finalValidation.passed, true);
  }));

test("a stopped Objective refuses an out-of-scope amendment with a reason", async () =>
  blameFixture("backlog", {}, async (f) => {
    await f.application.runObjective(1).catch(() => undefined);
    f.prepare(false);
    const [amend] = namedCommands(
      f.stateOf().work.next.recovery.failure.decision,
    );
    const backlog = { ...JSON.parse(readFileSync(f.proposalPath, "utf8")) };
    writeFileSync(
      f.proposalPath,
      JSON.stringify({ ...backlog, scope: "backlog" }),
    );
    await assert.rejects(
      f.command(amend),
      /Only an in-scope amendment can be proposed while the Objective is stopped/,
    );
    const state = f.stateOf();
    assert.equal(state.pendingAmendment, undefined);
    assert.equal(state.backlogDiscoveries, undefined);
  }));

test("an amendment is refused up front once the planning revision is used, and the Objective stays runnable", async () =>
  blameFixture(
    "used",
    {
      limits: {
        ...autonomy,
        allowances: { ...autonomy.allowances, planningRevisions: 1 },
        repairPolicy: {
          perPath: { ...autonomy.repairPolicy.perPath, planningRevisions: 1 },
        },
      },
    },
    async (f) => {
      await f.application.runObjective(1).catch(() => undefined);
      const [amend] = namedCommands(
        f.stateOf().work.next.recovery.failure.decision,
      );
      assert.match(amend, /^factory propose-amendment/);
      // The one planning revision goes elsewhere before the operator acts.
      f.useRevision();
      f.prepare(false);
      await assert.rejects(
        f.command(amend),
        /planningRevisions allowance is used up[^]*factory cancel --objective 1/,
      );
      const refused = f.stateOf();
      assert.equal(refused.pendingAmendment, undefined);
      assert.equal(refused.error, undefined);
      // The next run is not blocked by a pending amendment it cannot charge.
      const error = await f.application.runObjective(1).catch((e) => e);
      assert.doesNotMatch(String(error?.message ?? error), /allowance/);
      const after = f.stateOf();
      assert.equal(after.pendingAmendment, undefined);
      assert.equal(after.error, undefined);
      assert.equal(f.amendments(), 0);
    },
  ));

test("a rejected remedy amendment names cancel at the default planningRevisions of 1, and a replacement only while one fits", async () =>
  blameFixture("default", { limits: defaultAutonomy }, async (f) => {
    await f.application.runObjective(1).catch(() => undefined);
    const state = f.stateOf();
    const digest = graphDigest(state.graph);
    // As runAmendment leaves a rejected amendment: charged, paused.
    state.pendingAmendment = {
      id: "remedy",
      proposal: {
        scope: "in-scope",
        reason: "Fix the predecessor's file",
        evidence: ["blamed"],
        ownership: ["result.txt"],
        acceptance: ["result.txt is right"],
        dependencies: [],
        expectedGraphDigest: digest,
        actor: "operator",
      },
      phase: "rejected",
      rejectionStage: "compilation",
      issueByItemId: { ...state.issueByItemId },
      error: "Injected rejection",
    };
    state.charges = {
      ...state.charges,
      "objective/amend/remedy": {
        allowances: ["planningRevisions"],
        scopes: ["$planning"],
      },
    };
    state.coordinator.mode = "paused";
    const spent = blameDecision(state, "next", digest);
    assert.match(spent, /`factory cancel --objective 1`/);
    assert.match(spent, /planningRevisions allowance exhausted/);
    assert.doesNotMatch(spent, /propose-amendment/);
    // With a revision to spare the replacement fits.
    state.autonomy.allowances.planningRevisions = 2;
    assert.match(
      blameDecision(state, "next", digest),
      /`factory propose-amendment --objective 1 --proposal FILE` with a replacement/,
    );
    // While work runs, the replacement is refused until it settles.
    state.work.next.status = "running";
    // A command settles it (status names which), so cancel is not named.
    const waiting = blameDecision(state, "next", digest);
    assert.match(waiting, /`factory status --objective 1`/);
    assert.doesNotMatch(waiting, /factory cancel|propose-amendment/);
  }));
