import { defaultAutonomy } from "../dist/repair-policy.js";
import { coverageObligations } from "../dist/qa.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AuthenticationRequiredError } from "../dist/contracts.js";
import { runRegularGraph } from "../dist/delivery/regular-runner.js";
import { statusDocument } from "../dist/diagnostics.js";
import { ClaudeAgentSdkHarness } from "../dist/execution/claude.js";
import {
  GitHubCopilotSdkHarness,
  requireCopilotRuntime,
} from "../dist/execution/github-copilot.js";
import {
  cleanupCopilotClient,
  stopCopilotClient,
} from "../dist/execution/github-copilot-lifecycle.js";
import { CodexHarness } from "../dist/execution/local.js";
import {
  ProviderTurnGuard,
  ProviderTurnTimeoutError,
} from "../dist/provider-turn.js";

test("a guard already awaiting callbacks keeps its timeout after asynchronous progress", async () => {
  const turn = new ProviderTurnGuard(100);
  const started = Date.now();
  let progressed = false;
  const progress = setTimeout(() => {
    progressed = true;
    turn.progress();
  }, 60);
  try {
    await assert.rejects(
      turn.race(new Promise(() => undefined)),
      ProviderTurnTimeoutError,
    );
    assert.equal(progressed, true);
    assert.equal(turn.signal.aborted, true);
    assert.ok(turn.signal.reason instanceof ProviderTurnTimeoutError);
    assert.ok(
      Date.now() - started >= 140,
      "real progress must extend the original idle deadline",
    );
    assert.ok(
      Date.now() - started < 2_000,
      "the existing active race must still terminate",
    );
  } finally {
    clearTimeout(progress);
    turn.finish();
  }
});

test("only the selected Copilot adapter requires its genuine SDK Node minimum", () => {
  for (const version of ["22.0.0", "22.11.9"])
    assert.throws(
      () => requireCopilotRuntime(version),
      new RegExp(
        `GitHub Copilot SDK 1.0.13 requires Node >=22.12.0; current runtime is ${version}`,
      ),
    );
  for (const version of ["22.12.0", "24.0.0"])
    assert.doesNotThrow(() => requireCopilotRuntime(version));
});

test("optional production workers bound turns, require terminals and report unavailable normalized usage", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-optional-workers-"));
  try {
    for (const provider of ["claude", "github-copilot"])
      for (const scenario of [
        "complete",
        "nonterminal",
        "creation",
        "timeout",
        "cleanup",
        "auth",
        "failure",
        ...(provider === "github-copilot"
          ? [
              "startup-missing",
              "startup-cwd",
              "startup-model",
              "startup-effort",
              "startup-error",
              "startup-async",
              "startup-idle",
              "progress-timeout",
              "cleanup-progress",
            ]
          : [
              "startup-tool",
              "startup-tool-skill",
              "startup-tool-agent",
              "startup-mcp",
            ]),
      ]) {
        const attemptId = `${provider}-${scenario}`;
        const input = join(root, `${attemptId}.request.json`);
        const result = join(root, `${attemptId}.result.json`);
        const sent = join(root, `${attemptId}.sent`);
        const cleanup = join(root, `${attemptId}.cleanup.json`);
        const complete = [
          "complete",
          "startup-async",
          "cleanup-progress",
        ].includes(scenario);
        writeFileSync(
          input,
          JSON.stringify({
            providerTurnIdleTimeoutMs: complete ? 1_000 : 100,
            request: {
              attemptId,
              worktree: root,
              item: {
                title: "Scripted",
                goal: "Bound the worker",
                acceptance: [],
                nonGoals: [],
                ownedPaths: ["result.txt"],
                brief: "Only the owned file",
                validation: [],
              },
            },
            config: {
              adapter: "scripted-exact",
              model: "scripted-model",
              reasoningEffort: "medium",
              tools: [],
              allowedTools: [],
              permissionMode: "default",
              settingSources: [],
              maxTurns: 2,
              availableTools: [],
              timeoutSeconds: 1,
            },
          }),
        );
        const started = Date.now();
        const child = spawnSync(
          process.execPath,
          [
            "--loader",
            fileURLToPath(
              new URL("./fixtures/provider-worker-loader.mjs", import.meta.url),
            ),
            fileURLToPath(
              new URL(
                `../dist/execution/${provider}-worker.js`,
                import.meta.url,
              ),
            ),
            input,
            result,
          ],
          {
            env: {
              PATH: process.env.PATH,
              FACTORY_SCRIPTED_PROVIDER_SCENARIO: scenario,
              FACTORY_SCRIPTED_PROVIDER_SENT: sent,
              FACTORY_SCRIPTED_PROVIDER_CLEANUP: cleanup,
            },
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        assert.ifError(child.error);
        const outcome = JSON.parse(readFileSync(result, "utf8"));
        assert.equal(
          outcome.state,
          complete ? "complete" : "failed",
          `${attemptId}: ${outcome.error ?? ""} ${child.stderr}`,
        );
        assert.equal(child.status, complete ? 0 : 1, attemptId);
        if (scenario === "cleanup-progress") {
          const exit = JSON.parse(readFileSync(cleanup, "utf8"));
          assert.equal(exit.callbacks, 1);
          assert.ok(
            exit.elapsed < 500,
            `completed worker must exit without waiting for its 1000 ms idle deadline; cleanup-to-exit=${exit.elapsed} ms`,
          );
        }
        if (provider === "github-copilot")
          assert.equal(
            existsSync(sent),
            ![
              "creation",
              "auth",
              "startup-missing",
              "startup-cwd",
              "startup-model",
              "startup-effort",
              "startup-error",
            ].includes(scenario),
            attemptId,
          );
        assert.ok(Date.now() - started < 4_000, attemptId);
        if (
          ["creation", "timeout", "progress-timeout"].includes(scenario) ||
          (provider === "claude" && scenario === "cleanup")
        )
          assert.match(outcome.error, /no progress/);
        if (provider === "claude" && complete)
          assert.deepEqual(outcome.evidence.plugins, [
            { name: "agents-md", path: "builtin" },
            { name: "sec-default", path: "builtin" },
          ]);
        if (scenario === "startup-tool")
          assert.match(outcome.error, /unconfigured tool Bash/);
        if (scenario === "startup-tool-skill")
          assert.match(outcome.error, /unconfigured tool Skill/);
        if (scenario === "startup-tool-agent")
          assert.match(outcome.error, /unconfigured tool Agent/);
        if (scenario === "startup-mcp")
          assert.match(outcome.error, /unconfigured MCP server/);
        if (scenario === "failure")
          assert.match(outcome.error, /authoritative provider failure/);
        assert.doesNotMatch(
          child.stderr,
          /UnhandledPromiseRejection|uncaughtException|triggerUncaughtException/,
        );
        if (scenario === "auth")
          assert.equal(outcome.authentication.provider, provider);
        const observations = readFileSync(
          result.replace(/\.result\.json$/, ".progress.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map(JSON.parse)
          .filter((event) => event.operation === "worker-usage");
        assert.equal(observations[0].workerUsage.type, "started");
        const terminal = observations.at(-1).workerUsage;
        assert.equal(terminal.type, complete ? "completed" : "failed");
        assert.equal(terminal.provider, provider);
        assert.equal(terminal.invocationId, attemptId);
        assert.equal(terminal.providerAttempt, 1);
        assert.equal(terminal.phase, "implementation");
        assert.equal(terminal.model, "scripted-model");
        assert.deepEqual(terminal.usage, {});
      }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot cleanup errors force stop and fail the durable outcome", async () => {
  let forced = 0;
  await assert.rejects(
    stopCopilotClient({
      async stop() {
        return [new Error("runtime remained alive")];
      },
      async forceStop() {
        forced += 1;
      },
    }),
    /reported cleanup errors/,
  );
  assert.equal(forced, 1);
  await assert.rejects(
    stopCopilotClient({
      async stop() {
        throw new Error("graceful stop failed");
      },
      async forceStop() {
        throw new Error("forced stop failed");
      },
    }),
    /graceful and forced cleanup failed/,
  );
  let stopped = 0;
  await assert.rejects(
    cleanupCopilotClient(
      {
        async stop() {
          stopped += 1;
          return [];
        },
        async forceStop() {},
        async deleteSession() {
          return await new Promise(() => undefined);
        },
      },
      {
        sessionId: "session",
        async disconnect() {
          return await new Promise(() => undefined);
        },
      },
      5,
    ),
    /client cleanup failed/,
  );
  assert.equal(stopped, 1);
});

test("built-in harnesses propagate typed local authentication requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-harness-auth-"));
  const request = {
    provider: "codex",
    command: "codex login",
  };
  try {
    const cases = [
      {
        root: join(root, "codex", "harness"),
        harness: new CodexHarness(
          join(root, "codex", "empty-gh-config"),
          "host",
          { model: "model", reasoningEffort: "medium" },
        ),
      },
      {
        root: join(root, "claude"),
        harness: new ClaudeAgentSdkHarness(join(root, "claude"), {
          kind: "claude-agent-sdk",
        }),
      },
      {
        root: join(root, "copilot"),
        harness: new GitHubCopilotSdkHarness(join(root, "copilot"), {
          kind: "github-copilot-sdk",
        }),
      },
    ];
    for (const [index, entry] of cases.entries()) {
      mkdirSync(entry.root, { recursive: true });
      const identity = `attempt-${index}`;
      const resultPath = join(entry.root, `${identity}.result.json`);
      writeFileSync(
        resultPath,
        `${JSON.stringify({ state: "failed", error: "Authentication required", authentication: request })}\n`,
      );
      const data = {
        pid: 999_999,
        startTime: "missing",
        requestPath: join(entry.root, `${identity}.request.json`),
        resultPath,
        logPath: join(entry.root, `${identity}.log`),
      };
      await assert.rejects(
        entry.harness.collect({ identity, data }),
        (error) => {
          assert.ok(error instanceof AuthenticationRequiredError);
          assert.deepEqual(error.authentication, request);
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regular execution persists authentication requests for status", async () => {
  const item = {
    id: "auth",
    title: "Authenticate",
    goal: "Exercise the login handoff",
    brief: "Use local login",
    acceptance: ["Authentication is available"],
    nonGoals: ["No fallback"],
    citations: [],
    dependencies: [],
    ownedPaths: ["result.txt"],
    resources: [],
    validation: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
  const state = {
    schemaVersion: 7,
    repository: "example/auth",
    objective: 1,
    runId: "run-auth",
    configDigest: "a".repeat(64),
    baseSha: "b".repeat(40),
    graph: {
      objective: 1,
      baseSha: "b".repeat(40),
      items: [item],
      coverage: [
        {
          ...coverageObligations(item.acceptance[0], [item.acceptance[0]])[0],
          itemId: item.id,
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
    issueByItemId: { auth: 2 },
    capacity: { concurrency: 1 },
    autonomy: defaultAutonomy,
    work: { auth: { status: "pending" } },
  };
  const request = { provider: "codex", command: "codex login" };
  const driver = {
    async availableSlots() {
      return 1;
    },
    async start(input) {
      return { provider: "local", identity: input.attemptId };
    },
    async observe() {
      return { state: "failed", authentication: request };
    },
    async cancel() {},
    async collect() {
      throw new AuthenticationRequiredError(
        "Authentication required for codex",
        request,
      );
    },
  };
  await assert.rejects(
    runRegularGraph({
      config: {
        checkout: "/unused",
        execution: { concurrency: 1 },
      },
      objective: 1,
      objectiveBody: "",
      root: "/unused",
      state,
      driver,
      delivery: {},
      contentStore: {},
      github: {},
      planningModel: {},
      save() {},
      active: new Map(),
      cancelled: () => false,
    }),
    /Authentication required for codex/,
  );
  assert.equal(state.work.auth.status, "failed");
  assert.deepEqual(state.work.auth.authentication, request);
  const status = statusDocument(state, state.repository, 1, "regular", [], 1);
  assert.deepEqual(status.work[0].authentication, request);
});
