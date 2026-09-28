import { Codex } from "@openai/codex-sdk";
import { runCodexWorker } from "../dist/execution/worker.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import {
  validateConfig,
  factoryConfigDigest,
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
} from "../dist/config.js";
import {
  executionProfileChoices,
  normalizeExecutionProfiles,
  profileBinding,
  verifyExecutionProfiles,
} from "../dist/execution-profiles.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import { LocalExecutionDriver } from "../dist/execution/local.js";
import { ClaudeAgentSdkHarness } from "../dist/execution/claude.js";
import { LocalContentStore } from "../dist/content/local.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const loader = fileURLToPath(
  new URL("./fixtures/environment-provider-loader.mjs", import.meta.url),
);
const worker = fileURLToPath(
  new URL("../dist/execution/claude-worker.js", import.meta.url),
);
const environment = (id) => ({
  instructions: `PRIVATE-INSTRUCTIONS-${id}`,
  mcp: { kind: "factory-worktree-read", version: 1 },
});
const harnessConfig = (model = "claude-fixture") => ({
  kind: "claude-agent-sdk",
  adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  model,
  reasoningEffort: "medium",
  permissionMode: "acceptEdits",
  session: "new-per-attempt",
  tools: ["Read", "Write"],
  allowedTools: ["Read", "Write"],
  settingSources: [],
  maxTurns: 4,
  authentication: "local",
});
function item(id) {
  return {
    id,
    title: id,
    goal: `Write ${id}.txt`,
    acceptance: ["Produce proof"],
    nonGoals: ["No publication"],
    ownedPaths: [`${id}.txt`],
    dependencies: [],
    resources: [],
    citations: [{ path: "OBJECTIVE" }],
    validation: [],
    brief: "fixture",
    executionProfile: { id, reason: "Fixture assignment" },
  };
}
function configFor(target) {
  const config = factoryConfig(target.checkout, "example/environments");
  config.policy.network = "host";
  config.execution = {
    kind: "local",
    concurrency: 2,
    defaultProfile: "first",
    profiles: Object.fromEntries(
      ["first", "second"].map((id) => [
        id,
        {
          description: id,
          harness: harnessConfig(`model-${id}`),
          environment: environment(id),
        },
      ]),
    ),
  };
  return config;
}

test("environment config is strict, private and covered by accepted profile/configuration digests", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-environment-config-"));
  try {
    const target = createTarget(root);
    const config = configFor(target);
    assert.doesNotThrow(() => validateConfig(config));
    const choices = executionProfileChoices(config);
    assert.doesNotMatch(
      JSON.stringify(choices),
      /PRIVATE-INSTRUCTIONS|factory-worktree-read/,
    );
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [item("first")],
    };
    normalizeExecutionProfiles(graph, choices);
    const changed = structuredClone(config);
    changed.execution.profiles.first.environment.instructions += "changed";
    assert.notEqual(factoryConfigDigest(config), factoryConfigDigest(changed));
    assert.notEqual(
      profileBinding("first", config.execution.profiles.first, config.policy)
        .digest,
      profileBinding("first", changed.execution.profiles.first, config.policy)
        .digest,
    );
    assert.throws(
      () => verifyExecutionProfiles(graph, executionProfileChoices(changed)),
      /differs/,
    );
    for (const mutate of [
      (p) => (p.environment.command = "install something"),
      (p) => (p.environment.instructions = ""),
      (p) => (p.environment.instructions = "bad\0text"),
      (p) => (p.environment.mcp.version = 2),
      (p) => (p.environment.mcp.kind = "remote-server"),
      (p) => (p.environment.mcp.url = "https://example.invalid"),
      (p) => (p.harness.allowedTools = ["Write"]),
      (p) => (p.harness.tools = ["Write"]),
      (p) =>
        (p.harness = {
          kind: "codex-sdk",
          model: "gpt-5.4",
          reasoningEffort: "medium",
        }),
      (p) =>
        (p.harness = { kind: "registered", adapter: "fixture@1", config: {} }),
    ]) {
      const bad = structuredClone(config);
      mutate(bad.execution.profiles.first);
      assert.throws(() => validateConfig(bad));
    }
    const instructionsOnly = structuredClone(config);
    instructionsOnly.execution.profiles.first.harness = {
      kind: "codex-sdk",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    };
    delete instructionsOnly.execution.profiles.first.environment.mcp;
    assert.doesNotThrow(() => validateConfig(instructionsOnly));
    const prompt = workItemPrompt({
      item: graph.items[0],
      worktree: target.checkout,
      environment: instructionsOnly.execution.profiles.first.environment,
    });
    assert.match(prompt, /Do not commit, push/);
    assert.match(prompt, /subordinate to required Factory worker constraints/);
    assert.match(prompt, /PRIVATE-INSTRUCTIONS-first/);
    assert.doesNotMatch(JSON.stringify(graph), /PRIVATE-INSTRUCTIONS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production Claude worker enforces readiness, SDK provenance, real MCP access and cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-environment-worker-"));
  try {
    for (const scenario of [
      "success",
      "missing",
      "construction",
      "provenance",
      "version",
      "tools",
      "extra",
      "status-timeout",
    ]) {
      const worktree = join(root, scenario);
      mkdirSync(worktree);
      writeFileSync(join(worktree, "README.md"), "readable fixture\n");
      const input = join(root, `${scenario}.request.json`);
      const result = join(root, `${scenario}.result.json`);
      const observations = join(root, scenario);
      writeFileSync(
        input,
        JSON.stringify({
          request: {
            item: item("first"),
            attemptId: scenario,
            worktree,
            environment: environment("first"),
          },
          config: harnessConfig(),
          providerTurnIdleTimeoutMs: 1000,
        }),
      );
      const child = childProcess.spawnSync(
        process.execPath,
        ["--loader", loader, worker, input, result],
        {
          env: {
            PATH: process.env.PATH,
            FACTORY_ENVIRONMENT_SCENARIO: scenario,
            FACTORY_ENVIRONMENT_OBSERVATIONS: observations,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.ifError(child.error);
      const output = JSON.parse(readFileSync(result, "utf8"));
      assert.equal(
        child.status,
        scenario === "success" ? 0 : 1,
        `${scenario}: ${child.stderr} ${JSON.stringify(output)}`,
      );
      assert.equal(
        output.state,
        scenario === "success" ? "complete" : "failed",
      );
      assert.equal(
        existsSync(join(worktree, "first.txt")),
        scenario === "success",
      );
      if (["missing", "construction"].includes(scenario)) {
        assert.equal(existsSync(`${observations}.query`), false);
      } else {
        assert.equal(
          existsSync(`${observations}.server-closed`),
          true,
          scenario,
        );
        assert.equal(
          existsSync(`${observations}.query-closed`),
          true,
          scenario,
        );
      }
      if (scenario === "success") {
        assert.deepEqual(output.evidence.environment, {
          kind: "factory-worktree-read",
          version: 1,
          successfulReads: 1,
        });
        assert.equal(
          readFileSync(join(worktree, "first.txt"), "utf8"),
          "claude-fixture:PRIVATE-INSTRUCTIONS-first\n",
        );
      }
      const progress = readFileSync(
        result.replace(".result.json", ".progress.ndjson"),
        "utf8",
      );
      assert.doesNotMatch(
        progress,
        /PRIVATE-INSTRUCTIONS|readable fixture|README.md/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent same-adapter production workers retain private preparation through restart, collect and cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-environment-lifecycle-"));
  const target = createTarget(root);
  const config = configFor(target);
  const graph = {
    objective: 1,
    baseSha: target.baseSha,
    items: [item("first"), item("second")],
  };
  normalizeExecutionProfiles(graph, executionProfileChoices(config));
  let launches = 0;
  const realSpawn = childProcess.spawn;
  const spawnMock = mock.method(
    childProcess,
    "spawn",
    (command, args, options) => {
      if (args[0] === worker) {
        launches++;
        const input = JSON.parse(readFileSync(args[1], "utf8"));
        return realSpawn(command, ["--loader", loader, ...args], {
          ...options,
          env: {
            ...options.env,
            FACTORY_ENVIRONMENT_SCENARIO:
              input.request.attemptId === "cancel-second" ? "hold" : "success",
            FACTORY_ENVIRONMENT_OBSERVATIONS: join(
              root,
              input.request.attemptId,
            ),
          },
        });
      }
      return realSpawn(command, args, options);
    },
  );
  syncBuiltinESMExports();
  const registrations = () =>
    new Map(
      Object.entries(config.execution.profiles).map(([id, profile]) => [
        id,
        {
          binding: profileBinding(id, profile, config.policy),
          environment: profile.environment,
          createHarness: () =>
            new ClaudeAgentSdkHarness(join(root, "harness"), profile.harness),
        },
      ]),
    );
  const driver = () =>
    new LocalExecutionDriver(
      target.checkout,
      join(root, "worktrees"),
      undefined,
      2,
      new LocalContentStore(join(root, "content")),
      "profiles",
      registrations(),
    );
  let cancelled;
  try {
    const first = driver();
    await first.preflight(graph);
    const handles = await Promise.all(
      graph.items.map((item) =>
        first.start({
          item,
          baseSha: target.baseSha,
          attemptId: `run-${item.id}`,
        }),
      ),
    );
    const restarted = driver();
    for (const [index, handle] of handles.entries()) {
      const result = await restarted.collect(
        JSON.parse(JSON.stringify(handle)),
      );
      assert.deepEqual(result.evidence.environment, {
        kind: "factory-worktree-read",
        version: 1,
        successfulReads: 1,
      });
      const id = graph.items[index].id;
      assert.equal(result.evidence.configuredModel, `model-${id}`);
      assert.ok(existsSync(join(root, `run-${id}.server-closed`)));
      const request = JSON.parse(
        readFileSync(join(root, "harness", `run-${id}.request.json`), "utf8"),
      );
      assert.equal(
        request.request.environment.instructions,
        `PRIVATE-INSTRUCTIONS-${id}`,
      );
      const other = id === "first" ? "second" : "first";
      assert.doesNotMatch(
        JSON.stringify(request),
        new RegExp(`PRIVATE-INSTRUCTIONS-${other}`),
      );
    }
    assert.equal(launches, 2);
    const active = driver();
    cancelled = await active.start({
      item: graph.items[1],
      baseSha: target.baseSha,
      attemptId: "cancel-second",
    });
    const deadline = Date.now() + 10000;
    while (
      !existsSync(join(root, "cancel-second.ready")) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(join(root, "cancel-second.ready")));
    const afterRestart = driver();
    await afterRestart.cancel(JSON.parse(JSON.stringify(cancelled)));
    assert.equal(
      launches,
      3,
      "restart/cancel must never start another preparation",
    );
    assert.equal((await afterRestart.observe(cancelled)).state, "failed");
    assert.ok(existsSync(join(root, "cancel-second.server-closed")));
    assert.ok(existsSync(join(root, "cancel-second.query-closed")));
    await assert.rejects(afterRestart.collect(cancelled));
    cancelled = undefined;
  } finally {
    if (cancelled) await driver().cancel(cancelled);
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex and Copilot production workers apply additive private instructions", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-environment-instructions-"));
  const original = Codex.prototype.startThread;
  try {
    let invoked = false;
    Codex.prototype.startThread = (options) => {
      assert.equal(options.model, "codex-fixture");
      assert.equal(options.modelReasoningEffort, "medium");
      return {
        id: "fixture",
        async runStreamed(prompt) {
          invoked = true;
          assert.match(prompt, /PRIVATE-INSTRUCTIONS-first/);
          assert.match(
            prompt,
            /subordinate to required Factory worker constraints/,
          );
          assert.match(prompt, /Do not commit, push/);
          return {
            events: (async function* () {
              yield { type: "turn.completed", usage: {} };
            })(),
          };
        },
      };
    };
    const request = {
      item: item("first"),
      worktree: root,
      environment: { instructions: "PRIVATE-INSTRUCTIONS-first" },
    };
    const input = join(root, "codex.request.json");
    const result = join(root, "codex.result.json");
    writeFileSync(
      input,
      JSON.stringify({
        request,
        network: "off",
        model: { model: "codex-fixture", reasoningEffort: "medium" },
      }),
    );
    assert.equal(await runCodexWorker(input, result), true);
    assert.equal(invoked, true);
    const copilotInput = join(root, "copilot.request.json");
    const copilotResult = join(root, "copilot.result.json");
    writeFileSync(
      copilotInput,
      JSON.stringify({
        request,
        config: {
          adapter: "fixture",
          model: "copilot-fixture",
          reasoningEffort: "medium",
          availableTools: ["view"],
          permissionKinds: ["read"],
          timeoutSeconds: 5,
        },
        providerTurnIdleTimeoutMs: 1000,
      }),
    );
    const child = childProcess.spawnSync(
      process.execPath,
      [
        "--loader",
        fileURLToPath(
          new URL("./fixtures/provider-worker-loader.mjs", import.meta.url),
        ),
        fileURLToPath(
          new URL(
            "../dist/execution/github-copilot-worker.js",
            import.meta.url,
          ),
        ),
        copilotInput,
        copilotResult,
      ],
      {
        env: {
          PATH: process.env.PATH,
          FACTORY_SCRIPTED_PROVIDER_SCENARIO: "profile-instructions",
          FACTORY_SCRIPTED_PROVIDER_SENT: join(root, "sent"),
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(child.error);
    assert.equal(
      child.status,
      0,
      child.stderr + readFileSync(copilotResult, "utf8"),
    );
    assert.ok(existsSync(join(root, "sent")));
    for (const path of [result, copilotResult])
      assert.doesNotMatch(readFileSync(path, "utf8"), /PRIVATE-INSTRUCTIONS/);
  } finally {
    Codex.prototype.startThread = original;
    rmSync(root, { recursive: true, force: true });
  }
});
