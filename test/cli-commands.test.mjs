import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfig } from "../dist/config.js";
import { statusDocument } from "../dist/diagnostics.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { defaultAutonomy } from "../dist/index.js";
import { coverageObligations } from "../dist/qa.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  renderServiceStatus,
  summarizeStatus,
} from "../dist/status-summary.js";
import {
  createTarget,
  factoryConfig,
  git,
} from "./support/integration-fixture.mjs";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

/**
 * A finished-looking Objective whose one Work Item waits for a result decision on an exact
 * tree, with the final acceptance pending as well once the item is decided.
 */
function waitingObjective(root) {
  const target = createTarget(root);
  writeFileSync(join(target.checkout, "result.txt"), "created\n");
  git(target.checkout, "add", "result.txt");
  git(
    target.checkout,
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory-test@example.com",
    "commit",
    "-m",
    "Create result",
  );
  const commit = git(target.checkout, "rev-parse", "HEAD");
  const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
  const config = factoryConfig(target.checkout, "example/cli-commands");
  const pending = {
    criterion: "result.txt exists",
    treeSha,
    source: "OBJECTIVE",
    quote: "result.txt exists",
    question: "Does the result satisfy this criterion?",
    detail: "Review needs owner evidence",
  };
  const state = {
    schemaVersion: 7,
    repository: config.repository,
    objective: 1,
    runId: "cli-commands",
    configDigest: "a".repeat(64),
    autonomy: structuredClone(defaultAutonomy),
    capacity: { concurrency: 1 },
    get planGraphDigest() {
      return graphDigest(this.graph);
    },
    baseSha: target.baseSha,
    graph: {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        {
          id: "one",
          title: "One",
          goal: "Create result",
          acceptance: ["result.txt exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE" }],
          dependencies: [],
          ownedPaths: ["result.txt"],
          resources: [],
          validation: [],
          brief: "Create result",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
      coverage: [
        {
          ...coverageObligations("result.txt exists", ["result.txt exists"])[0],
          itemId: "one",
          proof: { kind: "result-semantic", acceptanceIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
    },
    objectiveCommands: [],
    issueByItemId: { one: 2 },
    work: {
      one: {
        status: "waiting",
        step: "approve-result",
        baseSha: target.baseSha,
        changeRef: commit,
        treeSha,
        acceptancePending: pending,
      },
    },
  };
  return { target, config, state, commit, treeSha, pending };
}

/** Run a command a status printed, as the operator would, filling its placeholders. */
function runNamed(command, configPath, fill = {}, env = process.env, cwd) {
  const [factory, ...args] = command.match(/"[^"]*"|\S+/g);
  assert.equal(factory, "factory");
  return spawnSync(
    process.execPath,
    [
      cli,
      ...args.map((arg) => {
        const bare = arg.replace(/^"|"$/g, "");
        return fill[bare] ?? bare;
      }),
      "--config",
      configPath,
    ],
    { encoding: "utf8", env: { ...env }, cwd },
  );
}

test("the result decision a stop names runs end to end, for a Work Item and for the final acceptance", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-cli-commands-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const { config, state, commit, pending } = waitingObjective(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const path = statePath(config.repository, 1);
    saveState(path, state);
    const named = () =>
      summarizeStatus(
        statusDocument(
          readState(config.repository, 1),
          config.repository,
          1,
          "regular",
        ),
      );

    // The Work Item's criterion: the command carries no tree, actor or digest.
    const item = named();
    assert.equal(item.phase, "needs-decision");
    assert.equal(
      item.nextAction.command,
      'factory decide --objective 1 --item one --outcome accept|refuse --reason "WHY"',
    );
    // The placeholders are the operator's to fill; --answer is a plan's, not a result's.
    const withAnswer = runNamed(item.nextAction.command, configPath, {
      "accept|refuse": "accept",
      WHY: "Looked at the exact result",
    });
    assert.equal(withAnswer.status, 0, withAnswer.stderr);
    assert.match(
      withAnswer.stdout,
      /Recorded accept for the pending criterion of Work Item one; `factory run --objective 1` continues it/,
    );
    const decided = readState(config.repository, 1).work.one;
    assert.equal(decided.status, "running");
    assert.equal(decided.step, "validate");
    assert.equal(decided.acceptanceDecisions[0].treeSha, pending.treeSha);
    assert.equal(
      decided.acceptanceDecisions[0].reason,
      "Looked at the exact result",
    );
    assert.ok(decided.acceptanceDecisions[0].actor);

    // The same decision again has nothing pending and says so.
    const again = runNamed(item.nextAction.command, configPath, {
      "accept|refuse": "accept",
      WHY: "twice",
    });
    assert.equal(again.status, 1);
    assert.match(
      again.stderr,
      /No specific acceptance criterion is awaiting this decision/,
    );

    // The final acceptance: no --item, still no tree.
    const final = readState(config.repository, 1);
    final.work.one = {
      ...final.work.one,
      status: "done",
      integratedSha: commit,
      pullRequest: 3,
    };
    delete final.work.one.step;
    final.integratedSha = commit;
    final.finalAcceptancePending = pending;
    saveState(path, final);
    const objective = named();
    assert.equal(
      objective.nextAction.command,
      'factory decide --objective 1 --outcome accept|refuse --reason "WHY"',
    );
    const refused = runNamed(objective.nextAction.command, configPath, {
      "accept|refuse": "refuse",
      WHY: "Not what was asked",
    });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(
      refused.stdout,
      /Recorded refuse for the pending final acceptance/,
    );
    const after = readState(config.repository, 1);
    assert.equal(after.finalAcceptancePending, undefined);
    assert.equal(after.finalAcceptanceDecisions[0].outcome, "refuse");
    assert.match(after.error, /Final acceptance refused: result.txt exists/);

    // A plan-only flag on a result decision is refused with the reason.
    const stray = runNamed(
      'factory decide --objective 1 --outcome refuse --answer "x" --reason "y"',
      configPath,
    );
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /--answer belongs to a plan decision/);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a decision records USER, then the git identity, when the account has no passwd entry, else says what to set", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-cli-actor-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const { config, state } = waitingObjective(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    saveState(statePath(config.repository, 1), state);
    // A container whose UID has no passwd entry: os.userInfo() throws.
    const preload = join(root, "no-passwd.mjs");
    writeFileSync(
      preload,
      "import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>{throw new Error('no passwd entry for uid')};syncBuiltinESMExports();",
    );
    const gitIdentity = join(root, "gitconfig");
    writeFileSync(gitIdentity, "[user]\n\tname = Git Identity\n");
    const base = {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    delete base.USER;
    delete base.LOGNAME;
    const decide =
      'factory decide --objective 1 --item one --outcome accept --reason "WHY"';
    const none = runNamed(decide, configPath, {}, base, root);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /set USER|git config --global user.name/);
    assert.equal(readState(config.repository, 1).work.one.status, "waiting");

    const viaGit = runNamed(
      decide,
      configPath,
      {},
      {
        ...base,
        GIT_CONFIG_GLOBAL: gitIdentity,
      },
      root,
    );
    assert.equal(viaGit.status, 0, viaGit.stderr);
    assert.equal(
      readState(config.repository, 1).work.one.acceptanceDecisions[0].actor,
      "Git Identity",
    );

    // USER wins over git.
    saveState(statePath(config.repository, 1), state);
    const viaUser = runNamed(
      decide,
      configPath,
      {},
      { ...base, GIT_CONFIG_GLOBAL: gitIdentity, USER: "ci-user" },
      root,
    );
    assert.equal(viaUser.status, 0, viaUser.stderr);
    assert.equal(
      readState(config.repository, 1).work.one.acceptanceDecisions[0].actor,
      "ci-user",
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("select writes the candidates or records the pick, and refuses a mix of the two", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-cli-select-"));
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/cli-select");
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const select = (...args) =>
      spawnSync(
        process.execPath,
        [cli, "select", "--objective", "1", ...args, "--config", configPath],
        { encoding: "utf8", env: { ...process.env } },
      );
    for (const [args, message] of [
      [[], /select requires --item/],
      [
        ["--item", "m"],
        /select without --set writes the candidates for review and requires --output/,
      ],
      [
        ["--item", "m", "--bind", "d", "--output", "/tmp/x"],
        /requires --output ABSOLUTE_NEW_DIRECTORY; select --set SET_ID records the pick/,
      ],
      [
        ["--item", "m", "--set", "s", "--output", "/tmp/x"],
        /--output writes the candidates; omit --set to use it/,
      ],
      [["--item", "m", "--set", "s", "--reason", "x"], /--reason was removed/],
      [["--item", "m", "--set", "s", "--actor", "x"], /--actor was removed/],
    ]) {
      const result = select(...args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, message, args.join(" "));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry takes --rereview only for a Work Item", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-cli-retry-"));
  try {
    const config = factoryConfig(
      createTarget(root).checkout,
      "example/cli-retry",
    );
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const retry = runNamed(
      "factory retry --objective 1 --rereview",
      configPath,
    );
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /retry --rereview requires --item/);
    const rereview = runNamed(
      "factory rereview --objective 1 --item one",
      configPath,
    );
    assert.equal(rereview.status, 1);
    assert.match(
      rereview.stderr,
      /factory rereview was removed; use factory retry --objective N --item X --rereview/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status without an Objective names the command that answers each service and queue state", () => {
  const registered = {
    supported: true,
    registered: true,
    unit: "factory-x.service",
  };
  const lines = (service, queue) => renderServiceStatus({ service, queue });
  assert.deepEqual(lines({ supported: false }, {}), [
    "Service: unavailable on this host (no running systemd user manager); `factory run --objective N` runs an Objective in the foreground",
    "Queue: running; empty",
    "  `factory queue add N` queues an Objective",
  ]);
  assert.match(
    lines({ supported: true, registered: false }, { objectives: [4] })[0],
    /`factory setup --background` sets it up/,
  );
  assert.deepEqual(
    lines(
      { ...registered, active: "inactive", enabled: "enabled" },
      { objectives: [4, 5], dequeued: [5], mode: "paused" },
    ),
    [
      "Service: inactive, enabled (factory-x.service)",
      "  Not running; `factory supervisor start` starts it",
      "Queue: paused; queued #4",
      "  Paused; `factory queue resume` continues it",
    ],
  );
  // A service that stopped for a decision names the Objective's status, then the way back.
  const stopped = lines(
    {
      ...registered,
      active: "inactive",
      enabled: "enabled",
      waitingFor: "human-decision",
    },
    {
      objectives: [4],
      mode: "paused",
      observation: {
        needsDecision: 4,
        error: "Objective #4 needs a human decision: x",
      },
    },
  );
  assert.match(
    stopped.join("\n"),
    /Waiting for a decision on Objective #4: `factory status --objective 4` names the command; then `factory queue resume` and `factory supervisor start`/,
  );
  assert.match(
    stopped.join("\n"),
    /Last error: Objective #4 needs a human decision/,
  );
  assert.match(
    lines(
      { ...registered, active: "active", enabled: "enabled" },
      { objectives: [4], activeObjective: 4, mode: "running" },
    ).join("\n"),
    /Queue: running; queued #4; #4 running/,
  );
});

test("a config naming the removed sandbox backend is refused by every command, naming the backends to use", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-cli-sandbox-"));
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/cli-sandbox");
    config.execution = {
      kind: "sandbox",
      provider: "daytona",
      harness: { kind: "registered", adapter: "installed", config: {} },
      argv: ["installed-harness"],
    };
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    for (const args of [
      ["run", "--objective", "1"],
      ["status", "--objective", "1"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, ...args, "--config", configPath],
        { encoding: "utf8", env: { ...process.env } },
      );
      assert.equal(result.status, 1, args[0]);
      assert.equal(result.stdout, "", args[0]);
      for (const alternative of ['"local"', '"managed-agent"'])
        assert.ok(
          result.stderr.includes(alternative),
          `${args[0]} names ${alternative}`,
        );
    }
    // The backends it names still validate.
    config.execution = {
      kind: "local",
      harness: factoryConfig(target.checkout, "example/cli-sandbox").execution
        .harness,
    };
    assert.equal(validateConfig(config).execution.kind, "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
