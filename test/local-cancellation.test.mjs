import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { ClaudeAgentSdkHarness } from "../dist/execution/claude.js";
import { GitHubCopilotSdkHarness } from "../dist/execution/github-copilot.js";
import { CodexHarness, LocalExecutionDriver } from "../dist/execution/local.js";
import { linuxProcessIdentity, processGroupExists } from "../dist/process.js";
import { cancelObjective } from "../dist/runner.js";
import { coverageObligations } from "../dist/qa.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const adapters = [
  [
    "Codex",
    (root) =>
      new CodexHarness(join(root, "credentials"), "off", {
        model: "fixture",
        reasoningEffort: "low",
      }),
    "harness",
  ],
  [
    "Claude",
    (root) => new ClaudeAgentSdkHarness(root, { kind: "claude-agent-sdk" }),
    "",
  ],
  [
    "Copilot",
    (root) => new GitHubCopilotSdkHarness(root, { kind: "github-copilot-sdk" }),
    "",
  ],
];

async function worker(descendant = false, args = []) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const { spawn } = require("node:child_process");
    ${descendant ? 'const nested = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); nested.unref();' : ""}
    process.on("message", message => {
      if (message === "probe") process.send("alive");
      else process.exit(7);
    });
    process.send("ready");
  `,
      ...args,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exited = once(child, "exit");
  await once(child, "message");
  const identity = linuxProcessIdentity(child.pid);
  assert.equal(identity.group, child.pid);
  return {
    child,
    identity,
    async exit() {
      child.send("exit");
      await exited;
      assert.equal(linuxProcessIdentity(child.pid), null);
    },
    async cleanup() {
      if (processGroupExists(child.pid)) process.kill(-child.pid, "SIGKILL");
      await exited;
      for (let n = 0; n < 100 && processGroupExists(child.pid); n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(processGroupExists(child.pid), false);
    },
  };
}

function handle(root, pid, startTime) {
  mkdirSync(root, { recursive: true });
  const data = {
    pid,
    startTime,
    requestPath: join(root, "attempt.request.json"),
    resultPath: join(root, "attempt.result.json"),
    logPath: join(root, "attempt.log"),
  };
  writeFileSync(data.requestPath, "original request\n");
  writeFileSync(data.logPath, "original failure; usage unavailable\n");
  return { identity: "attempt", data };
}

for (const [name, create, subdirectory] of adapters) {
  test(`${name} cancels a deceased empty-group worker without inventing a result`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cancel-deceased-"));
    const owned = await worker();
    try {
      const h = handle(
        join(root, subdirectory),
        owned.child.pid,
        owned.identity.startTime,
      );
      const harness = create(root);
      await owned.exit();
      assert.equal(processGroupExists(h.data.pid), false);
      const originalLog = readFileSync(h.data.logPath);
      await harness.cancel(h);
      assert.equal((await harness.observe(h)).state, "failed");
      await assert.rejects(harness.collect(h), /without a durable result/);
      assert.equal(existsSync(h.data.resultPath), false);
      assert.deepEqual(readFileSync(h.data.logPath), originalLog);
      assert.equal(
        readFileSync(h.data.requestPath, "utf8"),
        "original request\n",
      );
    } finally {
      await owned.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const result of [false, true]) {
    test(`${name} kills the live descendants of an absent leader (result ${result})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-cancel-descendant-"));
      const owned = await worker(true);
      try {
        const h = handle(
          join(root, subdirectory),
          owned.child.pid,
          owned.identity.startTime,
        );
        if (result)
          writeFileSync(
            h.data.resultPath,
            '{"state":"failed","error":"original failure"}\n',
          );
        await owned.exit();
        assert.equal(processGroupExists(h.data.pid), true);
        await create(root).cancel(h);
        assert.equal(processGroupExists(h.data.pid), false);
        // Repeating the cancellation is safe.
        await create(root).cancel(h);
        if (result)
          assert.equal(
            readFileSync(h.data.resultPath, "utf8"),
            '{"state":"failed","error":"original failure"}\n',
          );
      } finally {
        await owned.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
    });

    test(`${name} treats a reused pid as its worker gone and never signals it (result ${result})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-cancel-changed-"));
      const foreign = await worker();
      try {
        const h = handle(
          join(root, subdirectory),
          foreign.child.pid,
          `${foreign.identity.startTime}-changed`,
        );
        if (result) writeFileSync(h.data.resultPath, '{"state":"complete"}\n');
        await create(root).cancel(h);
        const observed = linuxProcessIdentity(h.data.pid);
        assert.ok(observed);
        assert.equal(observed.group, foreign.identity.group);
        assert.equal(observed.startTime, foreign.identity.startTime);
        assert.equal(foreign.child.exitCode, null);
        assert.equal(foreign.child.signalCode, null);
        const responsive = once(foreign.child, "message", {
          signal: AbortSignal.timeout(5_000),
        });
        foreign.child.send("probe");
        const [reply] = await responsive;
        assert.equal(reply, "alive");
        assert.equal(processGroupExists(h.data.pid), true);
      } finally {
        await foreign.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test(`${name} rejects a leader outside the recorded process group`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cancel-foreign-group-"));
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const exited = once(foreign, "exit");
    try {
      await once(foreign, "spawn");
      const current = linuxProcessIdentity(foreign.pid);
      assert.notEqual(current.group, foreign.pid);
      const h = handle(
        join(root, subdirectory),
        foreign.pid,
        current.startTime,
      );
      writeFileSync(h.data.resultPath, '{"state":"complete"}\n');
      await assert.rejects(create(root).cancel(h), /identity changed/);
      assert.deepEqual(linuxProcessIdentity(foreign.pid), current);
    } finally {
      foreign.kill("SIGKILL");
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name} still cancels a matching live owned group`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cancel-owned-"));
    const owned = await worker();
    try {
      const h = handle(
        join(root, subdirectory),
        owned.child.pid,
        owned.identity.startTime,
      );
      await create(root).cancel(h);
      assert.equal(processGroupExists(h.data.pid), false);
      assert.equal(existsSync(h.data.resultPath), false);
    } finally {
      await owned.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const recorded of [true, false])
  test(`supported Objective cancellation retains the ceased worker failure and consumed allowances (${recorded ? "recorded handle" : "start never recorded a handle"})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cancel-objective-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    // An unrecorded worker is found by the request file in its arguments.
    const attempt = recorded ? "attempt" : randomUUID();
    const owned = await worker(
      false,
      recorded ? [] : [join(root, "harness", `${attempt}.request.json`)],
    );
    try {
      const target = createTarget(root);
      const config = factoryConfig(target.checkout, "example/deceased-worker");
      const workRoot = join(stateRoot(config.repository), "worktrees");
      const h = handle(
        join(root, "harness"),
        owned.child.pid,
        owned.identity.startTime,
      );
      const item = {
        id: "worker",
        kind: "work",
        title: "worker",
        goal: "Write result.txt",
        brief: "Write result.txt",
        acceptance: ["result.txt exists"],
        nonGoals: [],
        citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
        dependencies: [],
        ownedPaths: ["result.txt"],
        resources: [],
        validation: [],
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      };
      const execution = {
        provider: "local",
        identity: "attempt",
        data: {
          request: { attemptId: "attempt", item, baseSha: target.baseSha },
          worktree: join(workRoot, "attempt"),
          adapterIdentity: "fixture-codex",
          handle: h,
        },
      };
      const bound = {
        schemaVersion: 1,
        repository: config.repository,
        objective: 1,
        configDigest: factoryConfigDigest(config),
        authority: {
          schemaVersion: 1,
          actor: "fixture operator",
          reason: "Cancellation regression",
          executionConsent: true,
          serviceConsent: false,
          objectives: [1],
          allowances: {
            planningRevisions: 1,
            implementationRepairs: 1,
            resultRereviews: 1,
          },
          repairClasses: [],
          resources: { maxConcurrency: 2 },
          requiredEnvironment: [],
        },
      };
      const state = {
        schemaVersion: 4,
        repository: config.repository,
        objective: 1,
        runId: "failed-run",
        configDigest: factoryConfigDigest(config),
        baseSha: target.baseSha,
        graph: {
          objective: 1,
          baseSha: target.baseSha,
          items: [item],
          coverage: coverageObligations(
            "## Acceptance\n- result.txt exists\n",
            item.acceptance,
          ).map((entry) => ({
            ...entry,
            itemId: item.id,
            proof: { kind: "final-review" },
            environment: {
              kind: "local",
              readiness: "available",
              probe: "",
              preparedBy: "",
            },
          })),
        },
        issueByItemId: { worker: 2 },
        admission: {
          ...bound,
          digest: createHash("sha256")
            .update(JSON.stringify(bound))
            .digest("hex"),
        },
        allowanceConsumption: {
          planningRevisions: 1,
          implementationRepairs: 1,
          resultRereviews: 1,
        },
        work: {
          worker: recorded
            ? {
                status: "failed",
                step: "execute",
                baseSha: target.baseSha,
                attempt: "attempt",
                execution,
                error:
                  "Worker exited without a durable result; usage unavailable",
              }
            : {
                status: "running",
                step: "execute",
                baseSha: target.baseSha,
                attempt,
              },
        },
        error: "Original failed attempt",
      };
      const path = statePath(config.repository, 1);
      saveState(path, state);
      const accountingPath = join(root, "accounting.ndjson");
      const accounting =
        '{"invocationId":"attempt","usageAvailable":false,"outcome":"failed"}\n';
      writeFileSync(accountingPath, accounting);
      const driver = new LocalExecutionDriver(
        target.checkout,
        workRoot,
        adapters[0][1](root),
        1,
        new LocalContentStore(join(root, "content")),
        "fixture-codex",
      );
      if (!recorded) {
        // Cancellation completes instead of staying incomplete: the worker is
        // found by its attempt identity and its process group is killed.
        assert.equal(await cancelObjective(config, 1, driver), "cancelled");
        assert.equal(processGroupExists(owned.child.pid), false);
        const after = readState(config.repository, 1);
        assert.ok(after.cancelledAt);
        assert.equal(after.work.worker.status, "cancelled");
        return;
      }
      await owned.exit();
      assert.equal(await cancelObjective(config, 1, driver), "cancelled");
      const after = readState(config.repository, 1);
      assert.ok(after.cancelledAt);
      assert.equal(after.work.worker.status, "cancelled");
      assert.equal(after.error, state.error);
      assert.equal(after.work.worker.error, state.work.worker.error);
      assert.equal(after.runId, state.runId);
      assert.equal(after.work.worker.attempt, state.work.worker.attempt);
      assert.deepEqual(after.work.worker.execution, execution);
      assert.deepEqual(after.allowanceConsumption, state.allowanceConsumption);
      assert.equal(after.work.worker.validation, undefined);
      assert.equal(after.finalAcceptance, undefined);
      assert.equal(existsSync(h.data.resultPath), false);
      assert.equal(readFileSync(accountingPath, "utf8"), accounting);
    } finally {
      await owned.cleanup();
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
