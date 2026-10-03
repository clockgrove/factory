import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { controlObjective, cancelObjective } from "../dist/runner.js";
import { linuxProcessIdentity } from "../dist/process.js";
import { coverageObligations } from "../dist/qa.js";
import { checkServiceState } from "../dist/supervision.js";
import { sealFinalAcceptance } from "../dist/completion.js";
import {
  acquireControllerLock,
  readState,
  readContinuation,
  releaseControllerLock,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
} from "./support/integration-fixture.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const body =
  "## Acceptance\n- `test -s README.md`\n\n## Final validation\n- `test -s README.md`\n";
function item(id) {
  return {
    id,
    kind: "work",
    title: id,
    goal: "Preserve the reviewed result",
    brief: "Preserve the reviewed result",
    acceptance: ["The reviewed result is retained"],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies: [],
    ownedPaths: [`${id}.txt`],
    resources: [],
    validation: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}

async function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "factory-readonly-abandonment-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      "example/readonly-abandonment",
      "regular",
      1,
    );
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const authority = {
      schemaVersion: 1,
      actor: "fixture operator",
      reason: "Bounded fixture lifecycle",
      executionConsent: true,
      serviceConsent: false,
      objectives: [1, 2],
      allowances: {
        planningRevisions: 1,
        implementationRepairs: 2,
        resultRereviews: 1,
      },
      repairClasses: [],
      resources: { maxConcurrency: 1 },
      requiredEnvironment: [],
    };
    const bound = {
      schemaVersion: 1,
      repository: config.repository,
      objective: 1,
      configDigest: factoryConfigDigest(config),
      authority,
    };
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      coverage: coverageObligations(body, ["test -s README.md"]).map(
        (entry) => ({
          ...entry,
          itemId: "accepted",
          proof: { kind: "final-review" },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        }),
      ),
      items: [item("accepted"), item("failed")],
    };
    const state = {
      schemaVersion: 4,
      repository: config.repository,
      objective: 1,
      runId: "stopped-readonly-review-run",
      configDigest: factoryConfigDigest(config),
      baseSha: target.baseSha,
      graph,
      issueByItemId: { accepted: 11, failed: 12 },
      admission: { ...bound, digest: digest(JSON.stringify(bound)) },
      allowanceConsumption: {
        planningRevisions: 1,
        implementationRepairs: 2,
        resultRereviews: 1,
      },
      coordinator: {
        mode: "paused",
        phase: "active",
        phaseStartedAt: "2026-01-01T00:00:00Z",
        processes: [],
        waitReason: "Read-only review submission is uncertain",
      },
      work: {
        accepted: {
          status: "done",
          baseSha: target.baseSha,
          treeSha,
          changeRef: target.baseSha,
          integratedSha: target.baseSha,
          pullRequest: 21,
          githubClosure: "complete",
          completedAt: "2026-01-01T00:00:00Z",
          validation: { treeSha, commands: [] },
        },
        failed: {
          status: "failed",
          step: "approve-result",
          attempt: "preserved-attempt",
          baseSha: target.baseSha,
          treeSha,
          changeRef: target.baseSha,
          pendingEffect: "review",
          phaseReservation: "review",
          error: "Unknown review outcome; usage unavailable",
          validation: { treeSha, commands: [] },
        },
      },
      error: "Stopped after uncertain read-only review",
    };
    const path = statePath(config.repository, 1);
    saveState(path, state);
    assert.deepEqual(readState(config.repository, 1), state);
    const accountingPath = join(root, "accounting.ndjson");
    const accounting =
      '{"invocationId":"original-review","usageAvailable":false,"outcome":"unknown"}\n';
    writeFileSync(accountingPath, accounting);
    let driverCalls = 0;
    const forbiddenDriver = new Proxy(
      {},
      {
        get: () => () => {
          driverCalls++;
          throw new Error("Abandonment must not call the execution driver");
        },
      },
    );
    const application = makeApplication({
      config,
      graph,
      fakeRoot: join(root, "fake"),
      actions: {},
      objectiveBody: body,
      driver: forbiddenDriver,
    }).application;
    const request = () => ({
      kind: "abandon-permanently",
      repository: config.repository,
      objective: 1,
      runId: state.runId,
      configDigest: state.configDigest,
      snapshotDigest: digest(readFileSync(path)),
      actor: "fixture operator",
      reason:
        "Permanently retire this failed exact run without deciding the unknown review",
      cessation: {
        kind: "operator-verified-local-cessation",
        verifiedAt: new Date().toISOString(),
        basis: `Operator verified run ${state.runId} in ${config.repository} Objective 1: all worker process groups, SDK descendants, subprocesses and model requests ceased; no unknown owned resources remain. Historical review usage remains unknown.`,
        workers: "ceased",
        subprocesses: "ceased",
        models: "ceased",
        unknownOwnedResources: false,
      },
    });
    await callback({
      root,
      target,
      config,
      treeSha,
      state,
      path,
      request,
      application,
      authority,
      forbiddenDriver,
      accountingPath,
    });
    assert.equal(driverCalls, 0);
    assert.equal(readFileSync(accountingPath, "utf8"), accounting);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

async function refusal(context, change, pattern) {
  change(context);
  saveState(context.path, context.state);
  const request = context.request();
  const before = readFileSync(context.path);
  await assert.rejects(
    context.application.cancelObjective(1, request),
    pattern,
  );
  assert.deepEqual(readFileSync(context.path), before);
}

test("explicit abandonment preserves the entire original snapshot except its terminal disposition", () =>
  fixture(async ({ application, config, path, request, state }) => {
    const input = request();
    assert.equal(await application.cancelObjective(1, input), "cancelled");
    const after = readState(config.repository, 1);
    const { permanentAbandonment, cancelRequested, cancelledAt, ...preserved } =
      after;
    assert.deepEqual(preserved, state);
    assert.deepEqual(permanentAbandonment, {
      ...input,
      at: cancelledAt,
      effect: "read-only-review",
    });
    assert.throws(() => checkServiceState(config, 1), /permanently abandoned/);
    assert.equal(cancelRequested, true);
    assert.ok(Number.isFinite(Date.parse(cancelledAt)));
    assert.equal(permanentAbandonment.cessation.unknownOwnedResources, false);
    assert.equal(after.work.failed.pendingEffect, "review");
    const before = readFileSync(path);
    await assert.rejects(
      application.cancelObjective(1, request()),
      /Terminal|sealed/,
    );
    assert.deepEqual(readFileSync(path), before);
  }));

test("final Objective review uncertainty is retained verbatim", () =>
  fixture(async (context) => {
    delete context.state.work.failed.pendingEffect;
    context.state.coordinator.phase = "objective-review-submitted";
    saveState(context.path, context.state);
    assert.equal(
      await cancelObjective(
        context.config,
        1,
        context.forbiddenDriver,
        context.request(),
      ),
      "cancelled",
    );
    const after = readState(context.config.repository, 1);
    assert.equal(after.coordinator.phase, "objective-review-submitted");
    assert.deepEqual(after.work, context.state.work);
    assert.equal(after.error, context.state.error);
  }));

for (const [name, alter] of [
  [
    "repository",
    (value) => {
      value.repository = "example/other";
    },
  ],
  [
    "Objective",
    (value) => {
      value.objective = 2;
    },
  ],
  [
    "run",
    (value) => {
      value.runId = "other-run";
    },
  ],
  [
    "configuration",
    (value) => {
      value.configDigest = "f".repeat(64);
    },
  ],
  [
    "snapshot",
    (value) => {
      value.snapshotDigest = "f".repeat(64);
    },
  ],
])
  test(`refuses a request bound to another ${name} without changing bytes`, () =>
    fixture(async ({ application, path, request }) => {
      const input = request();
      alter(input);
      const before = readFileSync(path);
      await assert.rejects(
        application.cancelObjective(1, input),
        /exact run|configuration|snapshot/,
      );
      assert.deepEqual(readFileSync(path), before);
    }));

test("raw snapshot binding detects a semantically identical rewrite", () =>
  fixture(async ({ application, path, request }) => {
    const input = request();
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8"))));
    const before = readFileSync(path);
    await assert.rejects(application.cancelObjective(1, input), /snapshot/);
    assert.deepEqual(readFileSync(path), before);
  }));

test("refuses an installation configuration changed after the stopped snapshot", () =>
  fixture(async ({ application, config, path, request }) => {
    const input = request();
    config.execution.harness.model = "changed-model";
    const before = readFileSync(path);
    await assert.rejects(
      application.cancelObjective(1, input),
      /configuration/,
    );
    assert.deepEqual(readFileSync(path), before);
  }));

for (const [name, alter] of [
  [
    "actor",
    (value) => {
      value.actor = " ";
    },
  ],
  [
    "reason",
    (value) => {
      value.reason = " ";
    },
  ],
  [
    "cessation basis",
    (value) => {
      value.cessation.basis = " ";
    },
  ],
  [
    "worker cessation",
    (value) => {
      value.cessation.workers = "unknown";
    },
  ],
  [
    "subprocess cessation",
    (value) => {
      value.cessation.subprocesses = "unknown";
    },
  ],
  [
    "model cessation",
    (value) => {
      value.cessation.models = "unknown";
    },
  ],
  [
    "unknown owned resources",
    (value) => {
      value.cessation.unknownOwnedResources = true;
    },
  ],
  [
    "verification time",
    (value) => {
      value.cessation.verifiedAt = "not-a-date";
    },
  ],
  [
    "old verification",
    (value) => {
      value.cessation.verifiedAt = "2025-01-01T00:00:00Z";
    },
  ],
  [
    "future verification",
    (value) => {
      value.cessation.verifiedAt = "2100-01-01T00:00:00Z";
    },
  ],
])
  test(`requires complete current operator evidence: ${name}`, () =>
    fixture(async ({ application, path, request }) => {
      const input = request();
      alter(input);
      const before = readFileSync(path);
      await assert.rejects(
        application.cancelObjective(1, input),
        /nonempty|cessation evidence|stopped failure/,
      );
      assert.deepEqual(readFileSync(path), before);
    }));

test("exclusive stopped ownership refuses a live controller", () =>
  fixture(async ({ application, config, path, request }) => {
    const lockPath = join(stateRoot(config.repository), "controller.lock");
    const lock = acquireControllerLock(lockPath, 1);
    const before = readFileSync(path);
    try {
      await assert.rejects(
        application.cancelObjective(1, request()),
        /controller|Controller|owns|owned|already|active/i,
      );
    } finally {
      releaseControllerLock(lockPath, lock);
    }
    assert.deepEqual(readFileSync(path), before);
  }));

function worker(
  context,
  provider = "local",
  adapterIdentity = "codex-sdk",
  pid = process.pid,
) {
  return {
    provider,
    identity: "original-worker",
    data: {
      worktree: join(
        stateRoot(context.config.repository),
        "worktrees",
        "original-worker",
      ),
      adapterIdentity,
      request: {
        item: context.state.graph.items[1],
        baseSha: context.state.baseSha,
      },
      handle: {
        identity: "original-sdk-worker",
        data: {
          pid,
          startTime:
            linuxProcessIdentity(pid)?.startTime ?? "verified-deceased",
        },
      },
    },
  };
}

for (const [name, change, pattern] of [
  [
    "live worker",
    (c) => {
      c.state.work.failed.execution = worker(c);
    },
    /worker remains live/,
  ],
  [
    "live worker with a stale recorded process identity",
    (c) => {
      c.state.work.failed.execution = worker(c);
      c.state.work.failed.execution.data.handle.data.startTime =
        "wrong-start-time";
    },
    /worker remains live/,
  ],
  [
    "live subprocess",
    (c) => {
      c.state.coordinator.processes = [
        {
          pid: process.pid,
          startTime: linuxProcessIdentity(process.pid).startTime,
        },
      ];
    },
    /subprocess remains live/,
  ],
  [
    "unsupported worker adapter",
    (c) => {
      c.state.work.failed.execution = worker(
        c,
        "local",
        "unsupported",
        2147483647,
      );
    },
    /unsupported|unresolved cessation/,
  ],
  [
    "remote worker resources",
    (c) => {
      c.state.work.failed.execution = worker(c, "remote", "remote", 2147483647);
    },
    /unsupported|unresolved cessation/,
  ],
  [
    "unknown worker identity",
    (c) => {
      c.state.work.failed.execution = worker(c);
      delete c.state.work.failed.execution.data.handle.data.pid;
    },
    /unresolved cessation/,
  ],
  [
    "missing execution identity",
    (c) => {
      c.state.work.failed.step = "execute";
    },
    /no stable cessation identity/,
  ],
  [
    "publication",
    (c) => {
      c.state.work.failed.pendingEffect = "publication";
    },
    /Publication|mutating/,
  ],
  [
    "merge",
    (c) => {
      c.state.work.failed.pendingEffect = "merge";
    },
    /merge|mutating/,
  ],
  [
    "active work",
    (c) => {
      c.state.work.failed.status = "running";
    },
    /mutating/,
  ],
  [
    "delivery",
    (c) => {
      c.state.work.failed.step = "deliver";
    },
    /mutating/,
  ],
  [
    "GitHub closure",
    (c) => {
      c.state.work.accepted.githubClosure = "pending";
    },
    /mutating/,
  ],
  [
    "planning submission",
    (c) => {
      c.state.coordinator.phase = "planning-submitted";
    },
    /Planning|mutating/,
  ],
  [
    "projection submission",
    (c) => {
      c.state.coordinator.phase = "projection-submitted";
    },
    /Planning|projection|mutating/,
  ],
  [
    "native stack merge",
    (c) => {
      c.state.stackMerges = {
        chain: {
          topPullRequest: 20,
          expectedHeadSha: c.state.baseSha,
          uuid: "original-merge",
        },
      };
    },
    /Planning|mutating/,
  ],
  [
    "sealed validation",
    (c) => {
      c.state.objectiveCommands = [];
      c.state.finalValidation = {
        treeSha: c.treeSha,
        commands: [],
        passed: true,
        criteria: c.state.graph.coverage.map((entry) => ({
          criterion: entry.source.text,
          verdict: "pass",
        })),
      };
    },
    /Terminal|sealed/,
  ],
  [
    "no uncertain review",
    (c) => {
      delete c.state.work.failed.pendingEffect;
    },
    /outside permanent abandonment/,
  ],
  [
    "no stopped failure",
    (c) => {
      delete c.state.error;
      c.state.work.failed.status = "pending";
    },
    /stopped failure/,
  ],
])
  test(`refuses ${name} and preserves the snapshot`, () =>
    fixture((context) => refusal(context, change, pattern)));

test("verified ceased known local worker identities and subprocess markers are retained", () =>
  fixture(async (context) => {
    const pid = 2147483647;
    assert.equal(linuxProcessIdentity(pid), null);
    context.state.work.failed.execution = worker(
      context,
      "local",
      "codex-sdk",
      pid,
    );
    context.state.coordinator.processes = [
      { pid, startTime: "verified-deceased" },
    ];
    saveState(context.path, context.state);
    await context.application.cancelObjective(1, context.request());
    const after = readState(context.config.repository, 1);
    assert.deepEqual(
      after.work.failed.execution,
      context.state.work.failed.execution,
    );
    assert.deepEqual(
      after.coordinator.processes,
      context.state.coordinator.processes,
    );
  }));

test("ordinary cancellation refuses uncertain review before writing cancellation intent", () =>
  fixture(async ({ application, config, state, path }) => {
    const before = readFileSync(path);
    await assert.rejects(
      application.cancelObjective(1),
      /Submitted|unknown|uncertain/,
    );
    const after = readState(config.repository, 1);
    assert.deepEqual(after.work, state.work);
    assert.equal(after.error, state.error);
    assert.equal(after.cancelledAt, undefined);
    assert.equal(after.permanentAbandonment, undefined);
    assert.equal(after.cancelRequested, undefined);
    assert.equal(after.coordinator.cancelError, undefined);
    assert.deepEqual(readFileSync(path), before);
  }));

test("sealed final Objective acceptance cannot be abandoned", () =>
  fixture(async (context) => {
    const state = context.state;
    delete state.error;
    state.coordinator.phase = "idle";
    state.integratedSha = state.baseSha;
    state.work.failed = structuredClone(state.work.accepted);
    state.objectiveCommands = [];
    state.finalValidation = {
      treeSha: context.treeSha,
      commands: [],
      passed: true,
      criteria: state.graph.coverage.map((entry) => ({
        criterion: entry.source.text,
        verdict: "pass",
      })),
    };
    sealFinalAcceptance(state);
    saveState(context.path, state);
    assert.ok(readState(context.config.repository, 1).finalAcceptance);
    const before = readFileSync(context.path);
    await assert.rejects(
      context.application.cancelObjective(1, context.request()),
      /Terminal|sealed/,
    );
    assert.deepEqual(readFileSync(context.path), before);
  }));

test("abandoned runs permanently refuse run, retry, repair, re-review and resume", () =>
  fixture(async ({ application, config, path, request, treeSha }) => {
    await application.cancelObjective(1, request());
    const before = readFileSync(path);
    await assert.rejects(application.runObjective(1), /permanently abandoned/);
    assert.deepEqual(readFileSync(path), before);
    assert.throws(
      () => application.retryWorkItem(1, "failed"),
      /permanently abandoned/,
    );
    assert.throws(
      () =>
        application.repairWorkItem(1, {
          item: "failed",
          treeSha,
          correction: {},
        }),
      /permanently abandoned/,
    );
    assert.throws(
      () =>
        application.rereviewWorkItem(1, {
          item: "failed",
          treeSha,
          actor: "fixture",
          reason: "Do not revive",
        }),
      /permanently abandoned/,
    );
    await assert.rejects(
      controlObjective(config, { objective: 1, action: "resume" }),
      /permanently abandoned/,
    );
    assert.deepEqual(readFileSync(path), before);
  }));

test("a successor uses normal finite admission after the predecessor is terminal", () =>
  fixture(async (context) => {
    const graph = {
      objective: 2,
      baseSha: context.state.baseSha,
      items: [item("successor")],
    };
    const { application } = makeApplication({
      config: context.config,
      graph,
      fakeRoot: join(context.root, "successor-fake"),
      actions: {},
      objectiveBody: body,
    });
    const candidate = await application.planObjective(2);
    await assert.rejects(
      application.admitObjective(2, candidate, context.authority),
      /already active/,
    );
    await context.application.cancelObjective(1, context.request());
    const before = readFileSync(context.path);
    const admission = await application.admitObjective(
      2,
      candidate,
      context.authority,
    );
    assert.equal(admission.objective, 2);
    assert.deepEqual(
      admission.authority.allowances,
      context.authority.allowances,
    );
    assert.deepEqual(readFileSync(context.path), before);
    await assert.rejects(
      application.admitObjective(2, candidate, {
        ...context.authority,
        executionConsent: false,
      }),
      /consent|authority|authorized/i,
    );
  }));

for (const planning of ["ready", "submitted"])
  test(`preparation ${planning} cannot be abandoned through the read-only review exception`, () =>
    fixture(async (context) => {
      const preparation = {
        schemaVersion: 5,
        kind: "preparing",
        projection: "ready",
        repository: context.config.repository,
        objective: 1,
        runId: context.state.runId,
        configDigest: context.state.configDigest,
        baseSha: context.state.baseSha,
        objectiveBodyDigest: digest(body),
        coordinator: context.state.coordinator,
        planning,
        issueByItemId: {},
        error: "Original uncertain preparation remains unresolved",
      };
      saveState(context.path, preparation);
      const before = readFileSync(context.path);
      await assert.rejects(
        context.application.cancelObjective(1, context.request()),
        /outside permanent abandonment/,
      );
      assert.deepEqual(readFileSync(context.path), before);
    }));

function cli(context, args) {
  const configPath = join(context.root, "factory.json");
  writeFileSync(configPath, JSON.stringify(context.config), { mode: 0o600 });
  return spawnSync(
    process.execPath,
    [
      new URL("../dist/cli.js", import.meta.url).pathname,
      "cancel",
      "--objective",
      "1",
      "--config",
      configPath,
      ...args,
    ],
    { encoding: "utf8", env: process.env, timeout: 10000 },
  );
}

test("CLI exact request file permanently abandons the stopped review", () =>
  fixture(async (context) => {
    const requestPath = join(context.root, "exact-abandonment.json");
    writeFileSync(requestPath, JSON.stringify(context.request()));
    const result = cli(context, ["--abandon", requestPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readState(context.config.repository, 1).permanentAbandonment);
  }));

test("CLI requires an explicit request file and leaves malformed requests unchanged", () =>
  fixture(async (context) => {
    const before = readFileSync(context.path);
    const missing = cli(context, ["--abandon"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /explicit JSON request file/);
    assert.deepEqual(readFileSync(context.path), before);
    const requestPath = join(context.root, "malformed-abandonment.json");
    writeFileSync(requestPath, "{}");
    const malformed = cli(context, ["--abandon", requestPath]);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Invalid permanent abandonment/);
    assert.deepEqual(readFileSync(context.path), before);
  }));

test("CLI explicit abandonment refuses a live controller owner", () =>
  fixture(async (context) => {
    const requestPath = join(context.root, "exact-abandonment.json");
    writeFileSync(requestPath, JSON.stringify(context.request()));
    const lockPath = join(
      stateRoot(context.config.repository),
      "controller.lock",
    );
    const lock = acquireControllerLock(lockPath, 1);
    const before = readFileSync(context.path);
    try {
      const result = cli(context, ["--abandon", requestPath]);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /controller|Controller|owns|owned|already|active/i,
      );
    } finally {
      releaseControllerLock(lockPath, lock);
    }
    assert.deepEqual(readFileSync(context.path), before);
  }));

for (const schemaVersion of [4, 5])
  test(`schema ${schemaVersion} refuses unsupported historical abandonment form without changing bytes`, () =>
    fixture(async (context) => {
      const state =
        schemaVersion === 4
          ? context.state
          : {
              schemaVersion: 5,
              kind: "preparing",
              repository: context.config.repository,
              objective: 1,
              runId: context.state.runId,
              configDigest: context.state.configDigest,
              baseSha: context.state.baseSha,
              objectiveBodyDigest: digest(body),
              planning: "ready",
              projection: "ready",
              issueByItemId: {},
              coordinator: context.state.coordinator,
            };
      state.readOnlyReviewAbandonment = {
        ...context.request(),
        kind: "abandon-read-only-review",
        at: new Date().toISOString(),
      };
      saveState(context.path, state);
      const before = readFileSync(context.path);
      assert.throws(
        () => readContinuation(context.config.repository, 1),
        /Unsupported permanent abandonment snapshot form/,
      );
      await assert.rejects(
        context.application.runObjective(1),
        /Unsupported permanent abandonment snapshot form/,
      );
      await assert.rejects(
        context.application.cancelObjective(1, context.request()),
        /Unsupported permanent abandonment snapshot form/,
      );
      assert.deepEqual(readFileSync(context.path), before);
    }));

for (const field of ["effect", "at", "automaticConsent"])
  test(`request cannot supply controller-owned or extra field ${field}`, () =>
    fixture(async (context) => {
      const request = { ...context.request(), [field]: "caller-defined" };
      const before = readFileSync(context.path);
      await assert.rejects(
        context.application.cancelObjective(1, request),
        /Invalid permanent abandonment disposition field/,
      );
      assert.deepEqual(readFileSync(context.path), before);
    }));

for (const alter of [
  (state) => {
    state.permanentAbandonment.effect = "graph-projection";
  },
  (state) => {
    state.permanentAbandonment.at = "not-a-time";
  },
  (state) => {
    state.permanentAbandonment.runId = "foreign";
  },
  (state) => {
    state.cancelledAt = undefined;
  },
  (state) => {
    state.cancelRequested = false;
  },
  (state) => {
    state.work.failed.pendingEffect = "publish";
  },
])
  test("decoded permanent disposition refuses mismatched effect, identity or terminal facts", () =>
    fixture(async (context) => {
      await context.application.cancelObjective(1, context.request());
      const state = readState(context.config.repository, 1);
      alter(state);
      saveState(context.path, state);
      const before = readFileSync(context.path);
      assert.throws(
        () => readContinuation(context.config.repository, 1),
        /Invalid permanent abandonment binding/,
      );
      assert.deepEqual(readFileSync(context.path), before);
    }));
