import { compilerRequest, compilerResponse } from "./support/compiler-wire.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import { parseProducedAssetSets } from "../dist/media.js";
import * as configModule from "../dist/config.js";
import { CompletedModelInvocationError } from "../dist/contracts.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../dist/controller-capabilities.js";
import { summarizeDiagnosticUsage } from "../dist/diagnostics.js";
import {
  claudeWorkerEnvironment,
  claudeWorkerInput,
} from "../dist/execution/claude.js";
import { claudeQueryOptions } from "../dist/execution/claude-options.js";
import {
  githubCopilotWorkerEnvironment,
  githubCopilotWorkerInput,
} from "../dist/execution/github-copilot.js";
import {
  githubCopilotClientOptions,
  githubCopilotSessionOptions,
} from "../dist/execution/github-copilot-options.js";
import {
  authenticationFailure,
  harnessFailure,
  parseAuthenticationRequest,
  workItemPrompt,
} from "../dist/execution/harness-support.js";
import { codexWorkerInput } from "../dist/execution/local.js";
import { runCodexWorker } from "../dist/execution/worker.js";
import * as publicModule from "../dist/index.js";
import { FACTORY_VERSION } from "../dist/package-metadata.js";
import { reviewPacket } from "../dist/review-evidence.js";
import {
  bindTarget,
  createTarget,
  factoryConfig,
} from "./support/integration-fixture.mjs";

const {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  factoryConfigDigest,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  validateConfig,
} = configModule;
const { compose, composeWithLocalHarness } = publicModule;
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

test("provider client identity tracks the exact package version", () => {
  assert.equal(FACTORY_VERSION, packageVersion);
});

test("shared worker prompt preserves exact controller validation constraints", () => {
  const checks = [
    {
      command: "grep -qx 'literal without punctuation' proof/exact.txt",
      provenance: "source-declared",
      source: "OBJECTIVE",
    },
    {
      command: "npm test",
      provenance: "base-observed",
      source: "package.json",
    },
  ];
  const prompt = workItemPrompt({
    worktree: "/tmp/factory-shared-prompt-test",
    item: {
      id: "shared-prompt",
      title: "Preserve exact validation",
      goal: "Create the exact literal output.",
      acceptance: ["The literal is exact."],
      nonGoals: ["Do not publish."],
      citations: [{ path: "OBJECTIVE" }],
      dependencies: [],
      ownedPaths: ["proof/exact.txt"],
      validation: checks,
      brief: "Make only the bounded change.",
    },
  });

  assert.match(prompt, /Controller-run validation constraints/);
  assert.match(prompt, /Factory, not the worker, executes/);
  for (const check of checks) assert.ok(prompt.includes(JSON.stringify(check)));
});

test("downstream worker prompt separates selected LFS validation from owned implementation", () => {
  const check = {
    command: `sha256sum assets/source.png | grep -qx '${"a".repeat(64)}  assets/source.png'`,
    provenance: "source-declared",
    source: "OBJECTIVE",
  };
  const selected = {
    fromItem: "media",
    setId: "candidate-a",
    role: "image",
    ref: { digest: "a".repeat(64), bytes: 77 },
    visibility: "repository",
    destination: "assets/source.png",
    path: "/tmp/factory-shared-prompt-test/.factory-inputs/selected-0",
    provenance: { source: "assets/source.png", rights: "MIT" },
  };
  const prompt = workItemPrompt({
    worktree: "/tmp/factory-shared-prompt-test",
    selectedAssets: [selected],
    item: {
      id: "final-integration",
      title: "Document the integrated result",
      goal: "Write the usage note.",
      acceptance: ["The note exists and the selected asset digest passes."],
      nonGoals: ["Do not change assets/source.png."],
      citations: [{ path: "OBJECTIVE" }],
      dependencies: ["media"],
      ownedPaths: ["docs/bootstrap-result.md"],
      validation: [check],
      brief: "Document the completed foundation and selected media.",
    },
  });

  assert.match(prompt, /Change only the owned paths/);
  assert.match(prompt, /Owned paths:\ndocs\/bootstrap-result\.md\nBrief:/);
  assert.match(
    prompt,
    /Factory, not the worker, executes these exact commands after your turn/,
  );
  assert.match(prompt, /Worker checkouts can contain committed LFS pointers/);
  assert.match(
    prompt,
    /verifies applicable selected required-LFS pointers and restores their selected bytes from the content store before running these commands/,
  );
  assert.match(
    prompt,
    /A pointer in the worker checkout alone does not establish impossible acceptance/,
  );
  assert.match(
    prompt,
    /Do not hydrate unowned destinations, configure LFS filters, or claim controller checks have passed/,
  );
  assert.match(
    prompt,
    /Report genuine implementation conflicts or missing required inputs/,
  );
  assert.match(prompt, /read-only asset inputs .*do not edit or commit them/);
  assert.ok(prompt.includes(JSON.stringify(check)));
  assert.ok(prompt.includes(JSON.stringify(selected)));
});

test("shared worker prompt preserves controller-owned media destinations", () => {
  const prompt = workItemPrompt({
    worktree: "/tmp/factory-shared-media-prompt-test",
    sourceAssets: [
      {
        binding: {
          kind: "repository",
          path: "assets/source.png",
          role: "image",
          mediaType: "image/png",
          visibility: "repository",
        },
        ref: { digest: "a".repeat(64), bytes: 77 },
      },
    ],
    item: {
      id: "shared-media-prompt",
      title: "Stage an exact media candidate",
      goal: "Preserve the repository source bytes.",
      acceptance: ["The staged candidate is byte-identical."],
      nonGoals: ["Do not materialize the final destination."],
      citations: [{ path: "OBJECTIVE" }],
      dependencies: [],
      ownedPaths: ["assets/source.png"],
      validation: [],
      brief: "Stage one bounded candidate.",
      expectedOutputRoles: ["image"],
      minimumAssetSets: 1,
      requiredLfsRoles: ["image"],
    },
  });

  assert.match(
    prompt,
    /Do not write, remove, or otherwise change final destinations directly/,
  );
  assert.match(
    prompt,
    /controller owns capture, whole-set selection, final destination materialization/i,
  );
  assert.match(prompt, /authorized byte-identical same-path LFS replacement/);
});

function structuredOutputSchemaBudget(schema) {
  const budget = { objectProperties: 0, enumValues: 0 };
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.properties && typeof value.properties === "object") {
      budget.objectProperties += Object.keys(value.properties).length;
    }
    if (Array.isArray(value.enum)) budget.enumValues += value.enum.length;
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return budget;
}

test("package root exports only role-specific model defaults", () => {
  assert.equal(
    Object.hasOwn(publicModule, "DEFAULT_CODEX_MODEL_SELECTION"),
    false,
  );
  assert.equal(
    publicModule.DEFAULT_PLANNER_MODEL_SELECTION,
    DEFAULT_PLANNER_MODEL_SELECTION,
  );
  assert.equal(
    publicModule.DEFAULT_REVIEWER_MODEL_SELECTION,
    DEFAULT_REVIEWER_MODEL_SELECTION,
  );
  assert.equal(
    publicModule.DEFAULT_WORKER_MODEL_SELECTION,
    DEFAULT_WORKER_MODEL_SELECTION,
  );
});

test("configuration requires explicit selectable Codex models and reasoning", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-config-"));
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/model-config");
    config.planning.planner = {
      model: "operator/planner-model",
      reasoningEffort: "low",
    };
    config.planning.reviewer = {
      model: "operator/reviewer-model",
      reasoningEffort: "ultra",
    };
    config.execution.harness = {
      kind: "codex-sdk",
      model: "operator/worker-model",
      reasoningEffort: "persistent",
    };
    const validated = validateConfig(config);
    assert.deepEqual(validated.planning, config.planning);
    assert.deepEqual(validated.execution.harness, config.execution.harness);

    const missing = structuredClone(config);
    delete missing.planning.reviewer;
    assert.throws(
      () => validateConfig(missing),
      /planning\.reviewer must be an object/,
    );
    const empty = structuredClone(config);
    empty.execution.harness.model = "  ";
    assert.throws(
      () => validateConfig(empty),
      /execution\.harness\.model must be a non-empty string/,
    );
    const unsupported = structuredClone(config);
    unsupported.planning.planner.reasoningEffort = "ambient";
    assert.throws(
      () => validateConfig(unsupported),
      /planning\.planner\.reasoningEffort is unsupported/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing local provider login yields an actionable retry request", () => {
  assert.deepEqual(authenticationFailure("codex", new Error("Not logged in")), {
    state: "failed",
    error:
      "Authentication required for codex; run `codex login` in the developer environment, then retry the Work Item",
    authentication: { provider: "codex", command: "codex login" },
  });
  assert.equal(
    authenticationFailure("claude", new Error("ordinary model failure")),
    undefined,
  );
  assert.equal(
    authenticationFailure("github-copilot", new Error("Authentication failed"))
      .authentication.command,
    "copilot",
  );
  assert.deepEqual(
    harnessFailure("codex", new Error("provider echoed durable-secret-value"), [
      "durable-secret-value",
    ]),
    { state: "failed", error: "provider echoed [REDACTED]" },
  );
  assert.equal(
    authenticationFailure(
      "github-copilot",
      new Error("No authentication active"),
    ).authentication.command,
    "copilot",
  );
  assert.deepEqual(
    parseAuthenticationRequest({ provider: "codex", command: "codex login" }),
    { provider: "codex", command: "codex login" },
  );
  assert.equal(parseAuthenticationRequest({ provider: "codex" }), undefined);
});

test("registered harness configuration is explicit and bound to its adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-harness-config-"));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/harness-config");
    config.execution.harness = {
      kind: "registered",
      adapter: "example/scripted@1",
      config: { mode: "deterministic", session: { resume: true } },
    };
    const validated = validateConfig(config);
    assert.equal(validated.execution.harness.adapter, "example/scripted@1");

    const changed = structuredClone(config);
    changed.execution.harness.config.session.resume = false;
    assert.notEqual(factoryConfigDigest(config), factoryConfigDigest(changed));

    const leaked = structuredClone(
      factoryConfig(target.checkout, "example/harness-config"),
    );
    leaked.execution.harness.permissionMode = "ambient";
    assert.throws(
      () => validateConfig(leaked),
      /execution\.harness\.permissionMode is unsupported/,
    );
    assert.throws(
      () => compose(config),
      /is not registered; use composeWithLocalHarness/,
    );

    const harness = {
      capabilities: {
        protocolVersion: 1,
        worktree: "factory-owned-read-write",
        head: "preserve",
        lifecycle: "restart-safe-durable-handle",
        publication: "controller-only",
        assetSets: true,
        authentication: "none",
      },
      async start() {
        return { identity: "unused", data: {} };
      },
      async observe() {
        return { state: "running" };
      },
      async cancel() {},
      async collect() {
        return {};
      },
    };
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/other@1",
          config: config.execution.harness.config,
          harness,
        }),
      /does not match registration/,
    );
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/scripted@1",
          config: { mode: "different" },
          harness,
        }),
      /configuration does not match/,
    );
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/scripted@1",
          config: { ...config.execution.harness.config, invalid: undefined },
          harness,
        }),
      /Registered harness configuration\.invalid must be JSON-safe/,
    );
    assert.ok(
      composeWithLocalHarness(config, {
        identity: "example/scripted@1",
        config: config.execution.harness.config,
        harness,
      }),
    );
    const incompatibleHarness = {
      ...harness,
      capabilities: { ...harness.capabilities, head: "may-move" },
    };
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/scripted@1",
          config: config.execution.harness.config,
          harness: incompatibleHarness,
        }),
      /does not satisfy the local AgentHarness capability contract/,
    );
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude adapter configuration is exact, isolated, and bound to the pinned SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-config-"));
  const previousState = process.env.XDG_STATE_HOME;
  const previousToken = process.env.ANTHROPIC_API_KEY;
  const previousGitHub = process.env.GH_TOKEN;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.ANTHROPIC_API_KEY = "claude-test-secret";
  process.env.GH_TOKEN = "github-must-not-leak";
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/claude-config");
    config.policy.network = "host";
    config.execution.harness = {
      kind: "claude-agent-sdk",
      adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
      model: "claude-explicit-model",
      reasoningEffort: "high",
      permissionMode: "acceptEdits",
      session: "new-per-attempt",
      settingSources: [],
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
      maxTurns: 8,
      authentication: "local",
    };
    const validated = validateConfig(config);
    assert.equal(
      validated.execution.harness.adapter,
      CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
    );
    assert.ok(compose(config));

    const request = {
      attemptId: "attempt-claude",
      objective: 7,
      baseSha: "a".repeat(40),
      worktree: target.checkout,
      item: {
        id: "work",
        title: "Change one file",
        goal: "Exercise adapter configuration",
        acceptance: ["The file changes"],
        nonGoals: ["No publication"],
        ownedPaths: ["src/**"],
        dependencies: [],
        validation: ["true"],
        brief: "Make the deterministic change",
      },
    };
    const workerInput = claudeWorkerInput(request, validated.execution.harness);
    assert.doesNotMatch(JSON.stringify(workerInput), /claude-test-secret/);
    const environment = claudeWorkerEnvironment(join(root, "credentials"));
    assert.equal(environment.ANTHROPIC_API_KEY, "claude-test-secret");
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.HOME, process.env.HOME);
    assert.equal(
      environment.CLAUDE_AGENT_SDK_CLIENT_APP,
      `clockgrove-factory/${packageVersion}`,
    );
    const queryOptions = claudeQueryOptions(
      workerInput,
      environment,
      new AbortController(),
    );
    assert.equal(queryOptions.cwd, target.checkout);
    assert.equal(queryOptions.model, "claude-explicit-model");
    assert.equal(queryOptions.effort, "high");
    assert.equal(queryOptions.permissionPrompts, "host");
    assert.deepEqual(queryOptions.allowedTools, []);
    assert.equal(queryOptions.persistSession, false);
    assert.equal(queryOptions.strictMcpConfig, true);
    assert.deepEqual(queryOptions.settingSources, []);
    assert.deepEqual(queryOptions.plugins, []);
    assert.deepEqual(queryOptions.settings, {
      syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false,
      autoMemoryEnabled: false,
      disableBundledSkills: true,
      claudeMdExcludes: ["**"],
    });
    assert.equal(queryOptions.env.DISABLE_TELEMETRY, "1");
    assert.deepEqual(queryOptions.agents, {});
    assert.deepEqual(queryOptions.skills, []);
    assert.deepEqual(queryOptions.mcpServers, {});
    assert.equal(queryOptions.env.GH_TOKEN, undefined);
    const permission = {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      requestId: "request-1",
    };
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Read",
          { file_path: join(target.checkout, "README.md") },
          permission,
        )
      ).behavior,
      "allow",
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Read",
          { file_path: join(root, "outside.txt") },
          permission,
        )
      ).behavior,
      "deny",
    );
    symlinkSync(root, join(target.checkout, "escape"));
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Write",
          { file_path: join(target.checkout, "escape", "outside.txt") },
          permission,
        )
      ).behavior,
      "deny",
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Write",
          {
            file_path: `${target.checkout}/escape/../outside-via-parent.txt`,
          },
          permission,
        )
      ).behavior,
      "deny",
    );
    symlinkSync(
      join(root, "missing-outside.txt"),
      join(target.checkout, "dangling"),
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Write",
          { file_path: join(target.checkout, "dangling") },
          permission,
        )
      ).behavior,
      "deny",
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Glob",
          { path: target.checkout, pattern: "../*.ts" },
          permission,
        )
      ).behavior,
      "deny",
    );
    assert.equal(
      (await queryOptions.canUseTool("Bash", { command: "true" }, permission))
        .behavior,
      "deny",
    );
    const preToolUse = queryOptions.hooks.PreToolUse[0].hooks[0];
    const hookContext = {
      session_id: "session",
      transcript_path: join(root, "transcript.jsonl"),
      cwd: target.checkout,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-1",
    };
    assert.equal(
      (
        await preToolUse(
          {
            ...hookContext,
            tool_name: "Write",
            tool_input: { file_path: join(target.checkout, "safe.txt") },
          },
          "tool-1",
          { signal: permission.signal },
        )
      ).hookSpecificOutput.permissionDecision,
      "allow",
    );
    assert.equal(
      (
        await preToolUse(
          {
            ...hookContext,
            tool_name: "Glob",
            tool_input: { path: target.checkout, pattern: "../*.ts" },
          },
          "tool-1",
          { signal: permission.signal },
        )
      ).hookSpecificOutput.permissionDecision,
      "deny",
    );

    const wrongAdapter = structuredClone(config);
    wrongAdapter.execution.harness.adapter =
      "@anthropic-ai/claude-agent-sdk@latest";
    assert.throws(
      () => validateConfig(wrongAdapter),
      /adapter is not the pinned Claude SDK/,
    );
    const leakedProviderField = structuredClone(config);
    leakedProviderField.execution.harness.effort = "medium";
    assert.throws(
      () => validateConfig(leakedProviderField),
      /effort is unsupported/,
    );
    const unexpectedTool = structuredClone(config);
    unexpectedTool.execution.harness.allowedTools.push("WebSearch");
    assert.throws(
      () => validateConfig(unexpectedTool),
      /allowedTools must be a subset/,
    );
    const shellTool = structuredClone(config);
    shellTool.execution.harness.tools.push("Bash");
    shellTool.execution.harness.allowedTools.push("Bash");
    assert.throws(
      () => validateConfig(shellTool),
      /supports only Read, Edit, Write, Glob, and Grep/,
    );
    const remoteAuthentication = structuredClone(config);
    remoteAuthentication.execution.harness.authentication = "configured-key";
    assert.throws(
      () => validateConfig(remoteAuthentication),
      /authentication must be local/,
    );
    const offline = structuredClone(config);
    offline.policy.network = "off";
    assert.throws(
      () => validateConfig(offline),
      /requires policy\.network host/,
    );
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousToken === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousToken;
    if (previousGitHub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHub;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot local login never inherits the controller gh authentication store", () => {
  const names = [
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "COPILOT_HOME",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    process.env.HOME = "/sentinel/controller-home";
    process.env.XDG_CONFIG_HOME = "/sentinel/controller-xdg-config";
    process.env.XDG_DATA_HOME = "/sentinel/controller-xdg-data";
    process.env.GH_TOKEN = "sentinel-publication-gh-token";
    process.env.GITHUB_TOKEN = "sentinel-publication-github-token";
    process.env.COPILOT_HOME = "/sentinel/copilot-local-profile";
    const owned = "/sentinel/factory-owned-empty-gh-config";
    for (const ambient of ["/sentinel/controller-gh-config", undefined]) {
      if (ambient === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = ambient;
      const environment = githubCopilotWorkerEnvironment(owned);
      assert.equal(environment.GH_CONFIG_DIR, owned);
      assert.equal(environment.GH_TOKEN, undefined);
      assert.equal(environment.GITHUB_TOKEN, undefined);
      assert.equal(environment.COPILOT_HOME, "/sentinel/copilot-local-profile");
      assert.notEqual(environment.GH_CONFIG_DIR, process.env.HOME);
      assert.notEqual(environment.GH_CONFIG_DIR, process.env.XDG_CONFIG_HOME);
      assert.notEqual(environment.GH_CONFIG_DIR, process.env.XDG_DATA_HOME);
      const input = {
        request: { worktree: "/sentinel/worktree" },
        config: { timeoutSeconds: 300 },
      };
      const options = githubCopilotClientOptions(
        input,
        environment,
        environment.COPILOT_HOME,
      );
      assert.equal(options.env.GH_CONFIG_DIR, owned);
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.baseDirectory, "/sentinel/copilot-local-profile");
      assert.equal(options.useLoggedInUser, true);
      assert.equal(options.mode, "empty");
      assert.deepEqual(options.builtinPluginDirectories, []);
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("GitHub Copilot adapter uses local auth with a bounded empty-mode capability set", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-copilot-config-"));
  const previousState = process.env.XDG_STATE_HOME;
  const previousToken = process.env.COPILOT_GITHUB_TOKEN;
  const previousEndpointToken = process.env.GITHUB_COPILOT_API_TOKEN;
  const previousAmbientModel = process.env.COPILOT_MODEL;
  const previousCopilotHome = process.env.COPILOT_HOME;
  const previousGitHub = process.env.GH_TOKEN;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.COPILOT_GITHUB_TOKEN = "copilot-test-secret";
  process.env.GITHUB_COPILOT_API_TOKEN = "copilot-endpoint-secret";
  process.env.COPILOT_MODEL = "ambient-model-must-not-leak";
  process.env.COPILOT_HOME = join(root, "developer-copilot-home");
  process.env.GH_TOKEN = "github-publication-token-must-not-leak";
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/copilot-config");
    config.policy.network = "host";
    config.execution.harness = {
      kind: "github-copilot-sdk",
      adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
      model: "copilot-explicit-model",
      reasoningEffort: "medium",
      session: "new-per-attempt",
      availableTools: ["view", "create", "edit", "grep", "glob"],
      permissionKinds: ["read", "write"],
      timeoutSeconds: 300,
      authentication: "local",
    };
    const validated = validateConfig(config);
    assert.equal(
      validated.execution.harness.adapter,
      GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
    );
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major === 22 && minor < 12)
      assert.throws(() => compose(config), /requires Node >=22\.12\.0/);
    else assert.ok(compose(config));
    const request = {
      attemptId: "attempt-copilot",
      worktree: target.checkout,
      item: {
        id: "work",
        title: "Change one file",
        goal: "Exercise Copilot adapter configuration",
        acceptance: ["The file changes"],
        nonGoals: ["No publication"],
        citations: [],
        ownedPaths: ["src/**"],
        dependencies: [],
        validation: [],
        brief: "Make the deterministic change",
      },
    };
    const workerInput = githubCopilotWorkerInput(
      request,
      validated.execution.harness,
    );
    assert.doesNotMatch(
      JSON.stringify(workerInput),
      /copilot-(?:test|endpoint)-secret/,
    );
    const environment = githubCopilotWorkerEnvironment(
      join(root, "empty-gh-config"),
    );
    assert.equal(environment.COPILOT_GITHUB_TOKEN, "copilot-test-secret");
    assert.equal(
      environment.GITHUB_COPILOT_API_TOKEN,
      "copilot-endpoint-secret",
    );
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.COPILOT_MODEL, undefined);
    assert.equal(
      environment.COPILOT_HOME,
      join(root, "developer-copilot-home"),
    );
    const clientOptions = githubCopilotClientOptions(
      workerInput,
      environment,
      join(root, "copilot-home"),
    );
    assert.equal(clientOptions.mode, "empty");
    assert.equal(clientOptions.useLoggedInUser, true);
    assert.equal(clientOptions.workingDirectory, target.checkout);
    assert.deepEqual(clientOptions.builtinPluginDirectories, []);
    assert.equal(clientOptions.clientInfo.applicationVersion, packageVersion);
    assert.equal(clientOptions.env.GH_TOKEN, undefined);
    const sessionOptions = githubCopilotSessionOptions(workerInput);
    assert.equal(sessionOptions.model, "copilot-explicit-model");
    assert.equal(sessionOptions.reasoningEffort, "medium");
    assert.deepEqual(sessionOptions.availableTools, [
      "view",
      "create",
      "edit",
      "grep",
      "glob",
    ]);
    assert.equal(sessionOptions.enableConfigDiscovery, false);
    assert.equal(sessionOptions.skipCustomInstructions, true);
    assert.equal(sessionOptions.enableSessionStore, false);
    assert.equal(sessionOptions.enableSkills, false);
    assert.equal(sessionOptions.remoteSession, "off");
    assert.deepEqual(
      await sessionOptions.onPermissionRequest(
        {
          kind: "write",
          fileName: join(target.checkout, "src", "one.ts"),
          intention: "write",
          diff: "",
          canOfferSessionApproval: false,
        },
        { sessionId: "test" },
      ),
      { kind: "approve-once" },
    );
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "read",
            path: join(root, "outside"),
            intention: "read",
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );
    symlinkSync(root, join(target.checkout, "escape"));
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "write",
            fileName: join(target.checkout, "escape", "outside.txt"),
            intention: "write",
            diff: "",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "write",
            fileName: `${target.checkout}/escape/../outside-via-parent.txt`,
            intention: "write",
            diff: "",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );
    symlinkSync(
      join(root, "missing-copilot-outside.txt"),
      join(target.checkout, "dangling"),
    );
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "write",
            fileName: join(target.checkout, "dangling"),
            intention: "write",
            diff: "",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );

    const wrongAdapter = structuredClone(config);
    wrongAdapter.execution.harness.adapter = "@github/copilot-sdk@latest";
    assert.throws(
      () => validateConfig(wrongAdapter),
      /adapter is not the pinned GitHub Copilot SDK/,
    );
    for (const tool of [
      "bash",
      "*",
      "builtin:*",
      "mcp:*",
      "custom:*",
      "view:*",
      "future-tool",
    ]) {
      const unsafeTool = structuredClone(config);
      unsafeTool.execution.harness.availableTools.push(tool);
      assert.throws(
        () => validateConfig(unsafeTool),
        /supports only view, create, edit, apply_patch, grep, and glob/,
      );
    }
    const unknownPermission = structuredClone(config);
    unknownPermission.execution.harness.permissionKinds.push("shell");
    assert.throws(
      () => validateConfig(unknownPermission),
      /supports only read and write/,
    );
    const offline = structuredClone(config);
    offline.policy.network = "off";
    assert.throws(
      () => validateConfig(offline),
      /requires policy\.network host/,
    );
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previousToken;
    if (previousEndpointToken === undefined)
      delete process.env.GITHUB_COPILOT_API_TOKEN;
    else process.env.GITHUB_COPILOT_API_TOKEN = previousEndpointToken;
    if (previousAmbientModel === undefined) delete process.env.COPILOT_MODEL;
    else process.env.COPILOT_MODEL = previousAmbientModel;
    if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousCopilotHome;
    if (previousGitHub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHub;
    rmSync(root, { recursive: true, force: true });
  }
});

test("install flags persist independent planner, reviewer, and worker selections", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-install-"));
  try {
    const target = createTarget(root);
    bindTarget(target.checkout, "example/model-install");
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "setup",
        "--config-only",
        "--repository",
        "example/model-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--planning-model",
        "planner-choice",
        "--planning-reasoning",
        "high",
        "--review-model",
        "reviewer-choice",
        "--review-reasoning",
        "medium",
        "--worker-model",
        "worker-choice",
        "--worker-reasoning",
        "low",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          XDG_STATE_HOME: join(root, "state"),
        },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.planning.planner, {
      model: "planner-choice",
      reasoningEffort: "high",
    });
    assert.deepEqual(config.planning.reviewer, {
      model: "reviewer-choice",
      reasoningEffort: "medium",
    });
    assert.deepEqual(config.execution.harness, {
      kind: "codex-sdk",
      model: "worker-choice",
      reasoningEffort: "low",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install selects the pinned optional Claude adapter without changing planning defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-install-"));
  try {
    const target = createTarget(root);
    bindTarget(target.checkout, "example/claude-install");
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "setup",
        "--config-only",
        "--repository",
        "example/claude-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--harness",
        "claude-agent-sdk",
        "--worker-model",
        "claude-explicit-model",
        "--worker-reasoning",
        "xhigh",
        "--claude-max-turns",
        "12",
        "--claude-permission",
        "dontAsk",
        "--claude-tool",
        "Read",
        "--claude-tool",
        "Edit",
        "--claude-allow-tool",
        "Read",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.planning, {
      kind: "codex-sdk",
      planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    });
    assert.deepEqual(config.execution.harness, {
      kind: "claude-agent-sdk",
      adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
      model: "claude-explicit-model",
      reasoningEffort: "xhigh",
      permissionMode: "dontAsk",
      session: "new-per-attempt",
      settingSources: [],
      tools: ["Read", "Edit"],
      allowedTools: ["Read"],
      maxTurns: 12,
      authentication: "local",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install selects the pinned optional GitHub Copilot adapter with local auth", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-copilot-install-"));
  try {
    const target = createTarget(root);
    bindTarget(target.checkout, "example/copilot-install");
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "setup",
        "--config-only",
        "--repository",
        "example/copilot-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--harness",
        "github-copilot-sdk",
        "--worker-model",
        "copilot-explicit-model",
        "--worker-reasoning",
        "high",
        "--copilot-timeout-seconds",
        "600",
        "--copilot-tool",
        "view",
        "--copilot-tool",
        "edit",
        "--copilot-tool",
        "apply_patch",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.execution.harness, {
      kind: "github-copilot-sdk",
      adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
      model: "copilot-explicit-model",
      reasoningEffort: "high",
      session: "new-per-attempt",
      availableTools: ["view", "edit", "apply_patch"],
      permissionKinds: ["read", "write"],
      timeoutSeconds: 600,
      authentication: "local",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install resolves Factory-owned role defaults and isolates one-role overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-defaults-"));
  const scenarios = [
    {
      name: "defaults",
      flags: [],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "planner",
      flags: ["--planning-model", "planner-choice"],
      planner: { model: "planner-choice", reasoningEffort: "medium" },
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "reviewer",
      flags: ["--review-reasoning", "high"],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "worker",
      flags: ["--worker-model", "worker-choice"],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: { model: "worker-choice", reasoningEffort: "medium" },
    },
  ];
  try {
    for (const scenario of scenarios) {
      const scenarioRoot = join(root, scenario.name);
      mkdirSync(scenarioRoot, { recursive: true });
      const target = createTarget(scenarioRoot);
      bindTarget(target.checkout, `example/model-${scenario.name}`);
      const configPath = join(scenarioRoot, "config", "factory.json");
      execFileSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../dist/cli.js"),
          "setup",
          "--config-only",
          "--repository",
          `example/model-${scenario.name}`,
          "--checkout",
          target.checkout,
          "--concurrency",
          "1",
          ...scenario.flags,
          "--config",
          configPath,
        ],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            XDG_STATE_HOME: join(scenarioRoot, "state"),
          },
        },
      );
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(config.planning.planner, scenario.planner);
      assert.deepEqual(config.planning.reviewer, scenario.reviewer);
      assert.deepEqual(config.execution.harness, {
        kind: "codex-sdk",
        ...scenario.worker,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter passes phase selections to every planning and review thread", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function (options) {
    const index = captured.length;
    const entry = { options, id: `thread-${index}` };
    captured.push(entry);
    return {
      get id() {
        return entry.id;
      },
      async runStreamed(prompt, options) {
        entry.prompt = prompt;
        entry.outputSchema = options.outputSchema;
        async function* events() {
          yield { type: "thread.started", thread_id: entry.id };
          yield { type: "turn.started" };
          yield {
            type: "item.started",
            item: {
              id: `command-${index}`,
              type: "command_execution",
              command: "printf private-command-marker",
              aggregated_output: "private-command-output",
              status: "in_progress",
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text:
                index === 0
                  ? JSON.stringify(
                      compilerResponse(prompt, [
                        { citations: [{ choiceIndex: 3 }] },
                      ]),
                    )
                  : JSON.stringify({ findings: [] }),
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 100 + index,
              cached_input_tokens: 50 + index,
              cache_write_input_tokens: 3 + index,
              output_tokens: 20 + index,
              reasoning_output_tokens: 7 + index,
            },
          };
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const baseSha = "a".repeat(40);
    const observations = [];
    const invocation = (phase, ordinal) => ({
      invocationId: `${phase}-${ordinal}`,
      phase,
      ordinal,
      observe: (event) => observations.push(event),
    });
    const compileSources = [
      {
        path: "OBJECTIVE",
        content:
          "# Objective\n\n## Acceptance\nRequired\n\n## Cost ($5)? [draft] | exact.*\nLiteral heading",
      },
      {
        path: "AGENTS.md",
        content: "# Disposable target instructions\n\nFollow the Objective.",
      },
    ];
    const compiled = await model.generateStructured(
      compilerRequest({
        objective: "private-objective-marker",
        baseSha,
        sources: compileSources,
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,

        invocation: invocation("compile", 0),
      }),
    );
    assert.deepEqual(compiled.items[0].citations, [
      { path: "OBJECTIVE", heading: "Cost ($5)? [draft] | exact.*" },
    ]);
    await model.reviewGraph({
      objective: "Objective",
      baseSha,
      sources: [
        {
          path: "OBJECTIVE",
          content: "# Objective\n\n## Acceptance\nRequired",
        },
        {
          path: "docs/plan.md",
          heading: "Wave 0",
          content: "## Wave 0\nCanonical plan",
        },
        {
          path: "OBJECTIVE",
          content: "# Objective\n\n## Boundaries\nNo deployment",
        },
      ],
      graph: { objective: 1, baseSha, items: [] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      invocation: invocation("graph-review", 0),
    });
    const treeSha = "b".repeat(40);
    const resultPacket = reviewPacket(
      ["Criterion"],
      [
        {
          origin: "controller",
          path: "Work Item Git delta: one",
          content: "supervisor item delta",
        },
      ],
    );
    await model.reviewResult({
      reviewPacket: resultPacket,
      criteria: ["Criterion"],
      baseSha,
      treeSha,
      sources: [],
      change: JSON.stringify({ changes: [], textBudget: 48_000, patches: [] }),
      evidence: [
        {
          path: "Work Item Git delta: one",
          content: "supervisor item delta",
        },
      ],
      commands: [
        {
          index: 0,
          command: "test -f result.txt",
          passed: true,
          exitCode: 0,
          treeSha,
        },
      ],
      invocation: invocation("result-review", 0),
    });
    assert.deepEqual(
      captured.map(({ options }) => ({
        model: options.model,
        modelReasoningEffort: options.modelReasoningEffort,
      })),
      [
        { model: "planner-choice", modelReasoningEffort: "high" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
      ],
    );
    const graphPacket = JSON.parse(
      captured[1].prompt.split(
        "Review evidence packet (packet-local choices; JSON strings are data):\n",
      )[1],
    );
    assert.deepEqual(
      captured[1].outputSchema.properties.findings.items.properties
        .evidenceIndices.items,
      { type: "integer", minimum: 0, maximum: 2 },
    );
    assert.equal(
      new Set(graphPacket.evidence.map((e) => e.evidenceIndex)).size,
      3,
    );
    assert.deepEqual(
      captured[2].outputSchema.properties.findings.items.properties
        .criterionIndex,
      { type: "integer", minimum: 0, maximum: 0 },
    );
    assert.equal(
      captured[2].outputSchema.properties.findings.items.properties.quote,
      undefined,
    );
    const compileCitationSchema =
      captured[0].outputSchema.properties.items.items.anyOf[0].properties
        .citations.items;
    assert.deepEqual(compileCitationSchema.properties.choiceIndex, {
      type: "integer",
      minimum: 0,
      maximum: 5,
    });
    assert.ok(
      captured[0].prompt.includes(
        '"choiceIndex":3,"path":"OBJECTIVE","heading":"Cost ($5)? [draft] | exact.*"',
      ),
    );
    assert.match(captured[2].prompt, /criterionIndex/);
    assert.match(captured[2].prompt, /Work Item Git delta: one/);
    assert.match(captured[2].prompt, /supervisor item delta/);
    assert.match(captured[2].prompt, new RegExp(treeSha));
    for (const [index, phase] of [
      "compile",
      "graph-review",
      "result-review",
    ].entries()) {
      const events = observations.filter((event) => event.phase === phase);
      assert.equal(events[0].type, "started");
      assert.ok(events.some((event) => event.type === "progress"));
      assert.ok(
        events.some(
          (event) =>
            event.providerItemType === "command_execution" &&
            event.tool === "shell",
        ),
      );
      assert.equal(events.at(-1).type, "completed");
      assert.equal(events.at(-1).providerThreadId, `thread-${index}`);
      assert.deepEqual(events.at(-1).usage, {
        inputTokens: 100 + index,
        cachedInputTokens: 50 + index,
        cacheWriteInputTokens: 3 + index,
        outputTokens: 20 + index,
        reasoningOutputTokens: 7 + index,
      });
      assert.equal(events.at(-1).usageAvailable, true);
      assert.equal(
        events[0].model,
        index ? "reviewer-choice" : "planner-choice",
      );
      assert.equal(events[0].reasoningEffort, index ? "medium" : "high");
      assert.equal(typeof events[0].promptDigest, "string");
      assert.equal(typeof events[0].sourcePacketDigest, "string");
    }
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-objective-marker|private-source-marker|supervisor item delta/,
    );
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-command-marker|private-command-output/,
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex citation indexes preserve exact headings without schema-budget growth", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  const returnedChoiceIndexes = [1, 1_000];
  Codex.prototype.startThread = function () {
    const index = captured.length;
    const entry = { index };
    captured.push(entry);
    return {
      id: `citation-budget-${index}`,
      async runStreamed(prompt, options) {
        entry.prompt = prompt;
        entry.outputSchema = options.outputSchema;
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `citation-budget-${index}`,
          };
          yield { type: "turn.started" };
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text: JSON.stringify(
                compilerResponse(prompt, [
                  {
                    citations:
                      index === 2
                        ? [{ choiceIndex: 1, heading: "One heading\n" }]
                        : [{ choiceIndex: returnedChoiceIndexes[index] }],
                  },
                ]),
              ),
            },
          };
          yield { type: "turn.completed", usage: null };
        }
        return { events: events() };
      },
    };
  };
  try {
    const specialHeading = "Cost ($5)? [draft] | exact.*";
    const headings = [
      specialHeading,
      ...Array.from({ length: 999 }, (_, index) => `Heading ${index}`),
    ];
    const sourcePackets = [
      [{ path: "docs/many.md", content: "## One heading\nbody" }],
      [
        {
          path: "docs/many.md",
          content: headings.map((heading) => `## ${heading}\nbody`).join("\n"),
        },
      ],
    ];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const decoded = [];
    for (const sources of sourcePackets) {
      decoded.push(
        await model.generateStructured(
          compilerRequest({
            objective: "objective",
            baseSha: "a".repeat(40),
            sources,
            controllerCapabilities: installedControllerCapabilities(),
            controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          }),
        ),
      );
    }
    assert.deepEqual(decoded[0].items[0].citations, [
      { path: "docs/many.md", heading: "One heading" },
    ]);
    assert.deepEqual(decoded[1].items[0].citations, [
      { path: "docs/many.md", heading: "Heading 998" },
    ]);
    await assert.rejects(
      model.generateStructured(
        compilerRequest({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: sourcePackets[0],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        }),
      ),
      /citation.*fields/,
    );
    assert.ok(captured[1].prompt.includes(specialHeading));
    assert.ok(
      captured[1].prompt.includes(
        '"choiceIndex":1000,"path":"docs/many.md","heading":"Heading 998"',
      ),
    );

    const smallBudget = structuredOutputSchemaBudget(captured[0].outputSchema);
    const headingHeavyBudget = structuredOutputSchemaBudget(
      captured[1].outputSchema,
    );
    assert.deepEqual(headingHeavyBudget, smallBudget);
    assert.equal(
      JSON.stringify(captured[1].outputSchema).length -
        JSON.stringify(captured[0].outputSchema).length,
      9,
      "only the maximum choice index width in each of three node variants may grow",
    );
    assert.ok(
      headingHeavyBudget.objectProperties <= 5_000,
      "official Structured Outputs object-property budget",
    );
    assert.ok(
      headingHeavyBudget.enumValues <= 1_000,
      "official Structured Outputs total-enum budget",
    );
    const citationSchema =
      captured[1].outputSchema.properties.items.items.anyOf[0].properties
        .citations.items;
    assert.deepEqual(citationSchema.properties.choiceIndex, {
      type: "integer",
      minimum: 0,
      maximum: 1_000,
    });
    assert.equal(Object.hasOwn(citationSchema.properties, "heading"), false);
    assert.equal(Object.hasOwn(citationSchema.properties, "path"), false);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter reports unavailable usage, malformed output, and provider failure", async () => {
  const original = Codex.prototype.startThread;
  let call = 0;
  Codex.prototype.startThread = function () {
    const index = call++;
    if (index === 4) throw new Error("provider capacity unavailable");
    return {
      get id() {
        return `failure-thread-${index}`;
      },
      async runStreamed() {
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `failure-thread-${index}`,
          };
          if (index === 0) {
            yield {
              type: "item.completed",
              item: { id: "bad", type: "agent_message", text: "not json" },
            };
            yield { type: "turn.completed", usage: null };
          } else if (index === 1) {
            yield { type: "error", message: "429 rate limit reached" };
          } else {
            yield {
              type: "item.completed",
              item: {
                id: "clean",
                type: "agent_message",
                text: JSON.stringify({ findings: [] }),
              },
            };
            if (index === 2) yield { type: "turn.completed", usage: null };
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const malformed = [];
    await assert.rejects(
      model.generateStructured(
        compilerRequest({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: [],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: { type: "object" },
          invocation: {
            invocationId: "malformed",
            phase: "compile",
            ordinal: 0,
            observe: (event) => malformed.push(event),
          },
        }),
      ),
      (error) =>
        error instanceof CompletedModelInvocationError &&
        error.cause instanceof SyntaxError,
    );
    assert.equal(malformed.at(-1).type, "response-invalid");
    assert.equal(malformed.at(-1).failureClass, "structured-output-parse");
    assert.equal(malformed.at(-1).usageAvailable, false);
    assert.equal(
      malformed.some((event) => event.type === "failed"),
      false,
    );

    const failed = [];
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        invocation: {
          invocationId: "provider-failure",
          phase: "graph-review",
          ordinal: 0,
          observe: (event) => failed.push(event),
        },
      }),
      /429 rate limit/,
    );
    assert.equal(failed.at(-1).type, "failed");
    assert.equal(failed.at(-1).failureClass, "provider-rate-limit");
    assert.equal(failed.at(-1).usageAvailable, false);

    const unavailable = [];
    await model.reviewGraph({
      objective: "objective",
      baseSha: "a".repeat(40),
      sources: [{ path: "OBJECTIVE", content: "objective" }],
      graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      invocation: {
        invocationId: "usage-unavailable",
        phase: "graph-review",
        ordinal: 1,
        observe: (event) => unavailable.push(event),
      },
    });
    assert.equal(unavailable.at(-1).type, "completed");
    assert.equal(unavailable.at(-1).usageAvailable, false);
    assert.equal(unavailable.at(-1).usage, undefined);

    const interrupted = [];
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        invocation: {
          invocationId: "provider-interrupted",
          phase: "graph-review",
          ordinal: 2,
          observe: (event) => interrupted.push(event),
        },
      }),
      /without turn\.completed/,
    );
    assert.equal(interrupted.at(-1).type, "failed");
    assert.equal(interrupted.at(-1).failureClass, "provider-interrupted");
    assert.equal(interrupted.at(-1).usageAvailable, false);

    const setupFailure = [];
    await assert.rejects(
      model.generateStructured(
        compilerRequest({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: [],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: { type: "object" },
          invocation: {
            invocationId: "setup-failure",
            phase: "graph-review",
            ordinal: 1,
            observe: (event) => setupFailure.push(event),
          },
        }),
      ),
      /capacity unavailable/,
    );
    assert.deepEqual(
      setupFailure.map((event) => event.type),
      ["started", "failed"],
    );
    assert.equal(setupFailure.at(-1).failureClass, "provider-capacity");
    assert.ok(setupFailure.every((event) => event.phase === "compile"));
    assert.ok(setupFailure.every((event) => event.providerMaxAttempts === 1));
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex harness private request carries an explicit worker selection", () => {
  const previous = process.env.FACTORY_TEST_SECRET;
  process.env.FACTORY_TEST_SECRET = "request-file-must-not-store-this";
  try {
    const input = codexWorkerInput(
      { attemptId: "attempt-1" },
      "off",
      ["FACTORY_TEST_SECRET"],
      {
        model: "worker-choice",
        reasoningEffort: "xhigh",
      },
    );
    assert.deepEqual(input.model, {
      model: "worker-choice",
      reasoningEffort: "xhigh",
    });
    assert.deepEqual(input.allowedSecretNames, ["FACTORY_TEST_SECRET"]);
    assert.doesNotMatch(
      JSON.stringify(input),
      /request-file-must-not-store-this/,
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_TEST_SECRET;
    else process.env.FACTORY_TEST_SECRET = previous;
  }
});

test("Codex adapter retries review capacity with the exact request and explicit attempt diagnostics", async () => {
  const original = Codex.prototype.startThread;
  const calls = [];
  let call = 0;
  Codex.prototype.startThread = function (options) {
    const index = call++;
    return {
      id: `capacity-thread-${index}`,
      async runStreamed(prompt, runOptions) {
        calls.push({
          prompt,
          outputSchema: runOptions.outputSchema,
          model: options.model,
          reasoningEffort: options.modelReasoningEffort,
        });
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `capacity-thread-${index}`,
          };
          if (index === 0) {
            yield {
              type: "turn.failed",
              error: {
                message:
                  "Selected model is at capacity. Please try a different model.",
              },
            };
            return;
          }
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text: JSON.stringify({ findings: [] }),
            },
          };
          yield { type: "turn.completed", usage: null };
        }
        return { events: events() };
      },
    };
  };
  try {
    const waits = [];
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      undefined,
      {
        reviewCapacityRetryDelaysMs: [7, 11],
        wait: async (milliseconds) => waits.push(milliseconds),
      },
    );
    const baseSha = "a".repeat(40);
    const result = await model.reviewGraph({
      objective: "objective",
      baseSha,
      sources: [{ path: "OBJECTIVE", content: "objective" }],
      graph: { objective: 1, baseSha, items: [] },
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      invocation: {
        invocationId: "capacity-then-success",
        phase: "compile",
        ordinal: 0,
        observe: (event) => observations.push(event),
      },
    });
    assert.deepEqual(result, { findings: [] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].prompt, calls[1].prompt);
    assert.deepEqual(calls[0].outputSchema, calls[1].outputSchema);
    assert.deepEqual(
      calls.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })),
      [
        { model: "reviewer-choice", reasoningEffort: "medium" },
        { model: "reviewer-choice", reasoningEffort: "medium" },
      ],
    );
    assert.deepEqual(waits, [7]);
    assert.ok(observations.every((event) => event.phase === "graph-review"));
    assert.deepEqual(
      observations
        .filter((event) =>
          ["started", "failed", "retry-scheduled", "completed"].includes(
            event.type,
          ),
        )
        .map((event) => ({
          type: event.type,
          attempt: event.providerAttempt,
          maxAttempts: event.providerMaxAttempts,
          retryDelayMs: event.retryDelayMs,
          failureClass: event.failureClass,
        })),
      [
        {
          type: "started",
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: undefined,
        },
        {
          type: "failed",
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: "provider-capacity",
        },
        {
          type: "retry-scheduled",
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: 7,
          failureClass: "provider-capacity",
        },
        {
          type: "started",
          attempt: 2,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: undefined,
        },
        {
          type: "completed",
          attempt: 2,
          maxAttempts: 3,
          retryDelayMs: undefined,
          failureClass: undefined,
        },
      ],
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter exhausts bounded capacity retries for final review without changing policy", async () => {
  const original = Codex.prototype.startThread;
  const calls = [];
  Codex.prototype.startThread = function (options) {
    const index = calls.length;
    return {
      id: `exhausted-thread-${index}`,
      async runStreamed(prompt, runOptions) {
        calls.push({
          prompt,
          outputSchema: runOptions.outputSchema,
          model: options.model,
          reasoningEffort: options.modelReasoningEffort,
        });
        async function* events() {
          yield {
            type: "turn.failed",
            error: { message: "provider temporarily unavailable at capacity" },
          };
        }
        return { events: events() };
      },
    };
  };
  try {
    const waits = [];
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      undefined,
      {
        reviewCapacityRetryDelaysMs: [3, 5],
        wait: async (milliseconds) => waits.push(milliseconds),
      },
    );
    const treeSha = "b".repeat(40);
    await assert.rejects(
      model.reviewResult({
        reviewPacket: reviewPacket(
          ["Criterion"],
          [{ origin: "source", path: "OBJECTIVE", content: "Criterion" }],
        ),
        reviewPhase: "objective-review",
        criteria: ["Criterion"],
        baseSha: "a".repeat(40),
        treeSha,
        sources: [{ path: "OBJECTIVE", content: "Criterion" }],
        change: JSON.stringify({
          changes: [],
          textBudget: 48_000,
          patches: [],
        }),
        commands: [],
        invocation: {
          invocationId: "exhausted-capacity",
          phase: "compile",
          ordinal: 0,
          observe: (event) => observations.push(event),
        },
      }),
      /temporarily unavailable at capacity/,
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [3, 5]);
    assert.ok(calls.every((entry) => entry.prompt === calls[0].prompt));
    assert.ok(
      calls.every(
        (entry) =>
          entry.model === "reviewer-choice" &&
          entry.reasoningEffort === "medium",
      ),
    );
    assert.deepEqual(
      observations
        .filter((event) => event.type === "started")
        .map((event) => event.providerAttempt),
      [1, 2, 3],
    );
    assert.deepEqual(
      observations
        .filter((event) => event.type === "retry-scheduled")
        .map((event) => ({
          attempt: event.providerAttempt,
          delay: event.retryDelayMs,
        })),
      [
        { attempt: 1, delay: 3 },
        { attempt: 2, delay: 5 },
      ],
    );
    assert.equal(
      observations.filter((event) => event.type === "failed").length,
      3,
    );
    assert.ok(
      observations.every((event) => event.phase === "objective-review"),
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter rejects unbounded review-capacity retry timing", () => {
  const create = (reviewCapacityRetryDelaysMs) =>
    new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      undefined,
      { reviewCapacityRetryDelaysMs },
    );
  assert.throws(() => create([0, 0, 0]), /bounded attempts or delay/);
  assert.throws(() => create([10_001]), /bounded attempts or delay/);
});

test("Codex adapter aborts and records an abort-aware stalled stream", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    return {
      id: "stalled-thread",
      async runStreamed(_prompt, options) {
        async function* events() {
          yield { type: "thread.started", thread_id: "stalled-thread" };
          await new Promise((resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        }
        return { events: events() };
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.generateStructured(
        compilerRequest({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: [],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: { type: "object" },
          invocation: {
            invocationId: "provider-timeout",
            phase: "compile",
            ordinal: 0,
            observe: (event) => observations.push(event),
          },
        }),
      ),
      /no progress for 20 ms/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider-timeout");
    assert.equal(observations.at(-1).providerThreadId, "stalled-thread");
    assert.equal(observations.at(-1).usageAvailable, false);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter bounds a stalled stream that ignores abort", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    return {
      id: "noncooperative-thread",
      async runStreamed() {
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: "noncooperative-thread",
          };
          await new Promise(() => {});
        }
        return { events: events() };
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.generateStructured(
        compilerRequest({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: [],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: { type: "object" },
          invocation: {
            invocationId: "provider-timeout-noncooperative",
            phase: "compile",
            ordinal: 0,
            observe: (event) => observations.push(event),
          },
        }),
      ),
      /no progress for 20 ms/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider-timeout");
    assert.equal(observations.at(-1).providerThreadId, "noncooperative-thread");
    assert.equal(observations.at(-1).usageAvailable, false);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter bounds stalled stream creation", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    return {
      id: "stream-creation-thread",
      async runStreamed() {
        return new Promise(() => {});
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.generateStructured(
        compilerRequest({
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: [],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: { type: "object" },
          invocation: {
            invocationId: "provider-stream-creation-timeout",
            phase: "compile",
            ordinal: 0,
            observe: (event) => observations.push(event),
          },
        }),
      ),
      /no progress for 20 ms/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider-timeout");
    assert.equal(
      observations.at(-1).providerThreadId,
      "stream-creation-thread",
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter closes provider iterators on completion and failure", async () => {
  const original = Codex.prototype.startThread;
  const closed = [];
  let call = 0;
  Codex.prototype.startThread = function () {
    const index = call++;
    return {
      id: `cleanup-thread-${index}`,
      async runStreamed() {
        async function* events() {
          try {
            yield {
              type: "thread.started",
              thread_id: `cleanup-thread-${index}`,
            };
            if (index === 0) {
              yield {
                type: "item.completed",
                item: {
                  id: "message",
                  type: "agent_message",
                  text: JSON.stringify({ result: "complete" }),
                },
              };
              yield { type: "turn.completed", usage: null };
            } else {
              yield {
                type: "turn.failed",
                error: { message: "provider terminal failure" },
              };
            }
          } finally {
            closed[index] = true;
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      100,
    );
    assert.deepEqual(
      await model.generateStructured(
        compilerRequest({
          purpose: "diagnosis",
          objective: "objective",
          baseSha: "a".repeat(40),
          sources: [],
          controllerCapabilities: installedControllerCapabilities(),
          controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
          schema: { type: "object" },
        }),
      ),
      { result: "complete" },
    );
    assert.equal(closed[0], true);
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      }),
      /provider terminal failure/,
    );
    assert.equal(closed[1], true);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter preserves terminal failure when iterator cleanup stalls", async () => {
  const original = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    let event = 0;
    return {
      id: "cleanup-stall-thread",
      async runStreamed() {
        return {
          events: {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              event += 1;
              if (event === 1)
                return {
                  done: false,
                  value: {
                    type: "thread.started",
                    thread_id: "cleanup-stall-thread",
                  },
                };
              return {
                done: false,
                value: {
                  type: "turn.failed",
                  error: { message: "authoritative provider failure" },
                },
              };
            },
            async return() {
              return new Promise(() => {});
            },
          },
        };
      },
    };
  };
  try {
    const observations = [];
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
      20,
    );
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
        invocation: {
          invocationId: "cleanup-stall",
          phase: "graph-review",
          ordinal: 0,
          observe: (observation) => observations.push(observation),
        },
      }),
      /authoritative provider failure/,
    );
    assert.equal(observations.at(-1).type, "failed");
    assert.equal(observations.at(-1).failureClass, "provider");
    assert.equal(observations.at(-1).detail, "authoritative provider failure");
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex harness private request carries selection and turn timeout", () => {
  const input = codexWorkerInput(
    { attemptId: "attempt-1" },
    "off",
    [],
    {
      model: "worker-choice",
      reasoningEffort: "xhigh",
    },
    1234,
  );
  assert.deepEqual(input.model, {
    model: "worker-choice",
    reasoningEffort: "xhigh",
  });
  assert.equal(input.providerTurnIdleTimeoutMs, 1234);
});

test("actual worker packets preserve media requirements and isolate controller operations", async () => {
  const original = Codex.prototype.startThread;
  const root = mkdtempSync(join(tmpdir(), "factory-worker-packets-"));
  const bytes = Buffer.from("immutable repository source\n");
  const ref = {
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    mediaType: "image/png",
  };
  const scenarios = [
    {
      id: "same-path",
      roles: ["image"],
      count: 1,
      owned: ["assets/source.png"],
      sourcePath: "assets/source.png",
      acceptance: [
        "Copy assets/source.png byte-for-byte into staging for the same destination.",
      ],
      brief:
        "Using installed Factory CLI, preserve the exact source bytes. Report any controller-operation conflict.",
    },
    {
      id: "multi-role",
      roles: ["image", "metadata"],
      count: 2,
      owned: ["assets/result.png", "assets/result.json", "consumer.ts"],
      sourcePath: ".factory-inputs/source-0",
      acceptance: [
        "Stage two complete sets with source-required visual variation and update consumer.ts.",
      ],
      brief:
        "Use the read-only source to create the two requested variants, declare provenance and any authoritative metadata, and update consumer.ts.",
    },
    {
      id: "ordinary",
      roles: [],
      count: 0,
      owned: ["consumer.ts"],
      acceptance: ["consumer.ts exports the requested value."],
      brief:
        "Update consumer.ts using the exact source-declared command npm test.",
    },
  ];
  let scenario;
  let captured;
  let worktree;
  Codex.prototype.startThread = function (options) {
    assert.equal(options.workingDirectory, worktree);
    assert.equal(options.networkAccessEnabled, false);
    return {
      id: `packet-${scenario.id}`,
      async runStreamed(prompt) {
        captured = prompt;
        async function* events() {
          if (scenario.roles.length) {
            const sets = Array.from({ length: scenario.count }, (_, index) => ({
              id: `candidate-${index}`,
              members: scenario.roles.map((role, roleIndex) => {
                const path = `.factory-media/candidate-${index}/${role}`;
                mkdirSync(join(worktree, `.factory-media/candidate-${index}`), {
                  recursive: true,
                });
                writeFileSync(
                  join(worktree, path),
                  scenario.id === "same-path"
                    ? bytes
                    : `${role} variant ${index}\n`,
                );
                return {
                  role,
                  path,
                  mediaType:
                    role === "image" ? "image/png" : "application/json",
                  destination: scenario.owned[roleIndex],
                };
              }),
              provenance: {
                source: scenario.sourcePath,
                rights: "test fixture",
                visibility: "repository",
                lineage: [scenario.sourcePath],
              },
            }));
            writeFileSync(
              join(worktree, ".factory-assets.json"),
              JSON.stringify({ sets }),
            );
          }
          yield { type: "turn.completed", usage: null };
        }
        return { events: events() };
      },
    };
  };
  try {
    for (scenario of scenarios) {
      worktree = join(root, scenario.id);
      mkdirSync(worktree);
      const sourceAssets = scenario.roles.length
        ? [
            {
              binding: {
                kind: scenario.id === "same-path" ? "repository" : "local",
                path:
                  scenario.id === "same-path"
                    ? "assets/source.png"
                    : "/approved/source.png",
                role: "image",
                mediaType: ref.mediaType,
                visibility: "repository",
              },
              ref,
              ...(scenario.id === "multi-role"
                ? { path: join(worktree, scenario.sourcePath) }
                : {}),
            },
          ]
        : [];
      if (scenario.sourcePath) {
        mkdirSync(join(worktree, scenario.sourcePath, ".."), {
          recursive: true,
        });
        writeFileSync(join(worktree, scenario.sourcePath), bytes);
      }
      const item = {
        id: scenario.id,
        title: scenario.id,
        goal: "Implement accepted source requirements",
        acceptance: scenario.acceptance,
        nonGoals: ["No deployment"],
        citations: [],
        dependencies: [],
        ownedPaths: scenario.owned,
        resources: ["exact scheduling identity"],
        validation: [],
        brief: scenario.brief,
        sourceAssets: sourceAssets.map((source) => source.binding),
        expectedOutputRoles: scenario.roles,
        minimumAssetSets: scenario.count,
        requiredLfsRoles: scenario.id === "same-path" ? ["image"] : [],
      };
      const inputPath = join(root, `${scenario.id}.request.json`);
      const resultPath = join(root, `${scenario.id}.result.json`);
      writeFileSync(
        inputPath,
        JSON.stringify({
          request: { item, worktree, sourceAssets },
          network: "off",
          model: { model: "worker-choice", reasoningEffort: "medium" },
        }),
      );
      assert.equal(await runCodexWorker(inputPath, resultPath), true);
      assert.equal(
        JSON.parse(readFileSync(resultPath, "utf8")).state,
        "complete",
      );
      assert.ok(captured.includes(`Brief:\n${item.brief}`));
      assert.ok(
        captured.includes(`Acceptance:\n${item.acceptance.join("\n")}`),
      );
      assert.ok(
        captured.includes(`Owned paths:\n${item.ownedPaths.join("\n")}`),
      );
      assert.match(
        captured,
        /\.factory-discovery\.json as a private uncommitted proposal/,
      );
      assert.match(
        captured,
        /controller independently reviews discoveries under existing Objective authority/,
      );
      assert.match(
        captured,
        /Out-of-scope discoveries are backlog proposals, never authority/,
      );
      if (!scenario.roles.length) {
        assert.equal(
          captured.split("\n\n").slice(0, 2).join("\n\n"),
          `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${item.title}\nGoal: ${item.goal}\nAcceptance:\n${item.acceptance.join("\n")}\nNon-goals:\n${item.nonGoals.join("\n")}\nOwned paths:\n${item.ownedPaths.join("\n")}\nBrief:\n${item.brief}`,
        );
        continue;
      }
      assert.ok(
        captured.includes(
          `Produce at least ${scenario.count} complete candidate AssetSets.`,
        ),
      );
      assert.ok(
        captured.includes(`Source bindings: ${JSON.stringify(sourceAssets)}`),
      );
      assert.ok(
        captured.includes(
          `Expected output roles: ${scenario.roles.join(", ")}`,
        ),
      );
      const manifest = JSON.parse(
        captured.match(
          /manifest shape[^]*?: (\{"sets":.*?\})\. Include every expected role/,
        )[1],
      );
      assert.deepEqual(Object.keys(manifest.sets[0].members[0]), [
        "role",
        "path",
        "mediaType",
        "destination",
      ]);
      assert.deepEqual(Object.keys(manifest.sets[0].provenance), [
        "source",
        "rights",
        "visibility",
        "lineage",
      ]);
      // Exercise the examples from the actual SDK worker input, not a copied prompt.
      assert.deepEqual(parseProducedAssetSets(manifest.sets), manifest.sets);
      const metadata = JSON.parse(
        captured.match(/exact optional shape: (\{"source":.*?\})\. Put all/)[1],
      );
      assert.deepEqual(metadata, {
        source: "<authoritative tool or source>",
        values: {},
      });
      const withMetadata = structuredClone(manifest.sets);
      withMetadata[0].members[0].formatMetadata = {
        ...metadata,
        source: "fixture-format-tool",
        values: { format: "fixture-format", nested: { field: true } },
      };
      assert.deepEqual(parseProducedAssetSets(withMetadata), withMetadata);
      const malformed = structuredClone(manifest.sets);
      malformed[0].members[0].formatMetadata = {
        source: "fixture-format-tool",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      assert.throws(
        () => parseProducedAssetSets(malformed),
        /AssetSet candidate-a format metadata is invalid/,
      );
      assert.match(captured, /Put all supplied format fields inside values/);
      assert.match(
        captured,
        /Omit formatMetadata when no authoritative format fields are supplied/,
      );
      assert.match(
        captured,
        /Source byte identity alone does not require formatMetadata/,
      );
      assert.match(
        captured,
        /controller source\/content receipts already bind byte count and digest/,
      );
      assert.match(
        captured,
        /preserve source bytes exactly when byte identity is required/,
      );
      assert.doesNotMatch(captured, /AssetSets with different content/);
      assert.match(
        captured,
        /Do not write, remove, or otherwise change final destinations directly/,
      );
      assert.match(
        captured,
        /controller owns capture, whole-set selection, final destination materialization/,
      );
      assert.match(captured, /publication, and Objective lifecycle/);
      assert.match(
        captured,
        /Do not run Factory CLI operations or inspect controller installation, configuration, status, or logs/,
      );
      assert.match(
        captured,
        /do not remove explicitly owned ordinary code work/,
      );
      assert.match(
        captured,
        /Stop after completing the authorized owned code changes, candidate files, and manifest/,
      );
      assert.match(captured, /report the conflict rather than performing it/);
      if (scenario.id === "same-path") {
        assert.deepEqual(
          readFileSync(join(worktree, ".factory-media/candidate-0/image")),
          bytes,
        );
        assert.deepEqual(
          readFileSync(join(worktree, "assets/source.png")),
          bytes,
        );
      } else {
        assert.match(captured, /Authorized read-only asset inputs/);
        assert.match(captured, /do not edit or commit them/);
        assert.match(captured, /formatMetadata/);
        assert.match(captured, /relationships with from, toRole, and kind/);
        assert.match(captured, /Do not invent metadata or tool identities/);
      }
    }
  } finally {
    Codex.prototype.startThread = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex worker closes completed streams and durably fails nonterminal streams", async () => {
  const original = Codex.prototype.startThread;
  const root = mkdtempSync(join(tmpdir(), "factory-worker-terminal-"));
  const closed = new Set();
  let scenario = "complete";
  Codex.prototype.startThread = function () {
    return {
      id: `worker-${scenario}`,
      async runStreamed() {
        if (scenario === "creation-stall") await new Promise(() => {});
        async function* events() {
          try {
            yield {
              type: "thread.started",
              thread_id: `worker-${scenario}`,
            };
            yield {
              type: "item.completed",
              item: {
                id: "message",
                type: "agent_message",
                text: "provider prose is not terminal authority",
              },
            };
            if (
              ["complete", "partial", "no-usage", "validation-fail"].includes(
                scenario,
              )
            ) {
              yield {
                type: "turn.completed",
                usage:
                  scenario === "no-usage"
                    ? null
                    : scenario === "partial"
                      ? { input_tokens: 10 }
                      : {
                          input_tokens: 100,
                          cached_input_tokens: 70,
                          output_tokens: 12,
                          cache_write_input_tokens: 4,
                          reasoning_output_tokens: 2,
                        },
              };
              return;
            }
            if (scenario === "eof") return;
            await new Promise(() => {});
          } finally {
            closed.add(scenario);
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    for (scenario of [
      "complete",
      "partial",
      "no-usage",
      "eof",
      "silent",
      "creation-stall",
      "validation-fail",
    ]) {
      const inputPath = join(root, `${scenario}.request.json`);
      const resultPath = join(root, `${scenario}.result.json`);
      writeFileSync(
        inputPath,
        `${JSON.stringify({
          request: {
            attemptId: `attempt-${scenario}`,
            worktree: root,
            item: {
              id: "item",
              title: "Title",
              goal: "Goal",
              acceptance: ["Acceptance"],
              nonGoals: ["Non-goal"],
              citations: [],
              dependencies: [],
              ownedPaths: [],
              resources: [],
              validation: [],
              brief: "Brief",
              sourceAssets: [],
              expectedOutputRoles: [],
              minimumAssetSets: 0,
              requiredLfsRoles: [],
            },
          },
          network: "off",
          redactionValues: [],
          model: { model: "worker-choice", reasoningEffort: "medium" },
          providerTurnIdleTimeoutMs: 20,
        })}\n`,
      );
      if (scenario === "validation-fail")
        writeFileSync(join(root, ".factory-assets.json"), "not-json");
      const pending = runCodexWorker(inputPath, resultPath);
      if (scenario === "creation-stall") {
        // Inspect while stream creation is still pending, before timeout.
        const started = JSON.parse(
          readFileSync(
            resultPath.replace(/\.result\.json$/, ".progress.ndjson"),
            "utf8",
          ).trim(),
        );
        assert.equal(started.workerUsage.type, "started");
        const active = summarizeDiagnosticUsage([started]);
        assert.equal(active.workerUsage.activeCount, 1);
        assert.equal(active.workerUsage.failedCount, 0);
        assert.deepEqual(active.workerUsage.tokenTotals, {});
      }
      const completed = await pending;
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const observations = readFileSync(
        resultPath.replace(/\.result\.json$/, ".progress.ndjson"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((event) => event.operation === "worker-usage");
      const terminal = observations.at(-1).workerUsage;
      assert.equal(terminal.role, "worker");
      assert.equal(terminal.phase, "implementation");
      assert.equal(terminal.invocationId, `attempt-${scenario}`);
      assert.equal(terminal.providerAttempt, 1);
      assert.equal(terminal.model, "worker-choice");
      assert.doesNotMatch(
        JSON.stringify(observations),
        /provider prose|Brief|Acceptance/,
      );
      if (["complete", "partial", "no-usage"].includes(scenario)) {
        assert.equal(completed, true);
        assert.equal(result.state, "complete");
        assert.equal(closed.has(scenario), true);
        assert.equal(terminal.type, "completed");
        assert.deepEqual(
          terminal.usage,
          scenario === "no-usage"
            ? {}
            : scenario === "partial"
              ? { inputTokens: 10 }
              : {
                  inputTokens: 100,
                  cachedInputTokens: 70,
                  cacheWriteInputTokens: 4,
                  outputTokens: 12,
                  reasoningOutputTokens: 2,
                },
        );
        continue;
      }
      assert.equal(completed, false);
      assert.equal(result.state, "failed");
      assert.equal(terminal.type, "failed");
      if (scenario === "validation-fail") {
        assert.equal(terminal.usage.inputTokens, 100);
        assert.equal(result.evidence, undefined);
        continue;
      }
      assert.deepEqual(terminal.usage, {});
      if (scenario === "creation-stall") {
        const failed = summarizeDiagnosticUsage(observations);
        assert.equal(failed.workerUsage.activeCount, 0);
        assert.equal(failed.workerUsage.failedCount, 1);
        assert.equal(failed.workerUsage.usageUnavailableCount, 1);
        assert.deepEqual(failed.workerUsage.tokenTotals, {});
      }
      assert.match(
        result.error,
        scenario === "eof"
          ? /without turn\.completed/
          : /no progress for 20 ms/,
      );
      assert.equal(result.evidence, undefined);
    }
  } finally {
    Codex.prototype.startThread = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual reviewer SDK schemas stay constant with more than a thousand packet IDs", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function () {
    return {
      async runStreamed(prompt, options) {
        captured.push({ prompt, schema: options.outputSchema });
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "review",
                type: "agent_message",
                text: '{"findings":[]}',
              },
            };
            yield { type: "turn.completed", usage: null };
          })(),
        };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "medium" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    for (const count of [1, 1001]) {
      const packet = reviewPacket(
        Array.from({ length: count }, (_, i) => `Criterion ${i}`),
        Array.from({ length: count }, (_, i) => ({
          origin: "source",
          path: `source-${i}`,
          content: `Evidence ${i}`,
        })),
      );
      const request = {
        reviewPacket: packet,
        objective: "objective",
        baseSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        sources: packet.evidence,
        criteria: packet.criteria.map((c) => c.text),
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        change: JSON.stringify({ changes: [], patches: [], textBudget: 48000 }),
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      };
      await model.reviewGraph(request);
      await model.reviewResult(request);
      assert.ok(
        captured.at(-1).prompt.includes(`"criterionIndex":${count - 1}`),
      );
      assert.ok(
        captured.at(-1).prompt.includes(`"evidenceIndex":${count - 1}`),
      );
    }
    for (const [small, large] of [
      [captured[0].schema, captured[2].schema],
      [captured[1].schema, captured[3].schema],
    ]) {
      assert.deepEqual(
        structuredOutputSchemaBudget(small),
        structuredOutputSchemaBudget(large),
      );
      assert.equal(
        large.properties.findings.items.properties.evidenceIndices.items
          .maximum,
        1000,
      );
      assert.equal(
        small.properties.findings.items.properties.evidenceIndices.items
          .maximum,
        0,
      );
    }
    assert.ok(JSON.stringify(captured[3].schema).length < 2000);
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("capacity-like transport text without a terminal provider event does not retry or claim completion", async () => {
  const { CompletedModelInvocationError } = await import(
    "../dist/contracts.js"
  );
  const original = Codex.prototype.startThread;
  let calls = 0;
  const waits = [];
  Codex.prototype.startThread = function () {
    calls++;
    return {
      id: "uncertain-review",
      async runStreamed() {
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "uncertain-review" };
            throw new Error("connection temporarily unavailable");
          })(),
        };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner", reasoningEffort: "medium" },
      { model: "reviewer", reasoningEffort: "medium" },
      undefined,
      {
        reviewCapacityRetryDelaysMs: [0, 0],
        wait: async (delay) => waits.push(delay),
      },
    );
    const baseSha = "a".repeat(40);
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha,
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha, items: [] },
        commands: [],
        finalCommands: [],
        controllerCapabilities: installedControllerCapabilities(),
        controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      }),
      (error) =>
        error.message === "connection temporarily unavailable" &&
        !(error instanceof CompletedModelInvocationError),
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  } finally {
    Codex.prototype.startThread = original;
  }
});
