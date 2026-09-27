import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { bindTarget, createTarget } from "./support/integration-fixture.mjs";

test("fresh packed artifact composes a registered harness through the package root", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-package-smoke-"));
  const previousStateRoot = process.env.XDG_STATE_HOME;
  try {
    const target = createTarget(root);
    bindTarget(target.checkout, "example/package-smoke");
    const pack = join(root, "pack");
    const prefix = join(root, "prefix");
    const config = join(root, "config", "factory.json");
    mkdirSync(pack, { recursive: true });
    const project = resolve(import.meta.dirname, "..");
    const packageName = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", pack],
      { cwd: project, encoding: "utf8" },
    ).trim();
    const emptyCache = join(root, "empty-npm-cache");
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--omit=optional",
        "--engine-strict",
        "--prefix",
        prefix,
        "--ignore-scripts",
        join(pack, packageName),
      ],
      {
        stdio: "ignore",
        env: { ...process.env, npm_config_cache: emptyCache },
      },
    );
    const installedRoot = join(
      prefix,
      "node_modules",
      "@clockgrove",
      "factory",
    );
    const installedManifest = JSON.parse(
      readFileSync(join(installedRoot, "package.json"), "utf8"),
    );
    assert.deepEqual(installedManifest.optionalDependencies, {
      "@anthropic-ai/claude-agent-sdk": "0.3.281",
      "@github/copilot-sdk": "1.0.13",
    });
    const scanner = join(installedRoot, "dist", "execution", "secret-scan.js");
    const descriptor = JSON.stringify({
      rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
    });
    const fixture = join(root, "scanner-fixture.txt");
    writeFileSync(fixture, "Public credential-free packed scanner fixture.\n");
    assert.equal(
      spawnSync(process.execPath, [scanner, fixture, descriptor]).status,
      0,
    );
    const syntheticSecret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(fixture, `GITHUB_TOKEN=${syntheticSecret}\n`);
    const refused = spawnSync(
      process.execPath,
      [scanner, fixture, descriptor],
      { encoding: "utf8" },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /@secretlint\/secretlint-rule-github/);
    assert.ok(!`${refused.stdout}${refused.stderr}`.includes(syntheticSecret));
    assert.equal(
      spawnSync(process.execPath, [scanner, fixture, "invalid-config"]).status,
      2,
    );
    for (const name of [
      "secretlint",
      "read-pkg",
      "normalize-package-data",
      "hosted-git-info",
    ])
      assert.equal(
        existsSync(join(installedRoot, "node_modules", name)),
        false,
      );
    const lock = JSON.parse(
      readFileSync(join(project, "package-lock.json"), "utf8"),
    );
    let checked = 0;
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || entry.dev) continue;
      const installedPath = join(installedRoot, path, "package.json");
      if ((entry.optional || entry.devOptional) && !existsSync(installedPath))
        continue;
      assert.ok(
        existsSync(installedPath),
        `bundled dependency missing: ${path}`,
      );
      assert.equal(
        JSON.parse(readFileSync(installedPath, "utf8")).version,
        entry.version,
        path,
      );
      checked++;
    }
    const requiredCount = Object.entries(lock.packages).filter(
      ([path, entry]) =>
        path && !entry.dev && !entry.optional && !entry.devOptional,
    ).length;
    assert.ok(requiredCount > 0);
    assert.ok(
      checked >= requiredCount,
      `expected all ${requiredCount} required production entries, got ${checked}`,
    );
    for (const path of [
      ".codex-plugin/plugin.json",
      "skills/director/SKILL.md",
      "skills/setup/SKILL.md",
      "docs/AGENT-HARNESSES.md",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      assert.ok(
        existsSync(join(installedRoot, path)),
        `release asset missing: ${path}`,
      );
    }
    const cli = join(prefix, "node_modules", ".bin", "factory");
    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    };
    process.env.XDG_STATE_HOME = environment.XDG_STATE_HOME;
    const installed = execFileSync(
      cli,
      [
        "install",
        "--repository",
        "example/package-smoke",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--config",
        config,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.match(installed, /Installed Factory for example\/package-smoke/);
    const installedConfig = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual(installedConfig.planning, {
      kind: "codex-sdk",
      planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    });
    assert.deepEqual(installedConfig.execution.harness, {
      kind: "codex-sdk",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });
    const status = execFileSync(
      cli,
      ["status", "--objective", "1", "--config", config],
      { encoding: "utf8", env: environment },
    );
    assert.match(status, /no active Objective/);
    const installedPackage = await import(
      pathToFileURL(
        join(
          prefix,
          "node_modules",
          "@clockgrove",
          "factory",
          "dist",
          "index.js",
        ),
      ).href
    );
    const setupSkill = readFileSync(
      join(installedRoot, "skills", "setup", "SKILL.md"),
      "utf8",
    );
    const describedDefaults = `planner \`${installedPackage.DEFAULT_PLANNER_MODEL_SELECTION.model}\` with \`${installedPackage.DEFAULT_PLANNER_MODEL_SELECTION.reasoningEffort}\` reasoning, reviewer \`${installedPackage.DEFAULT_REVIEWER_MODEL_SELECTION.model}\` with \`${installedPackage.DEFAULT_REVIEWER_MODEL_SELECTION.reasoningEffort}\` reasoning, and worker \`${installedPackage.DEFAULT_WORKER_MODEL_SELECTION.model}\` with \`${installedPackage.DEFAULT_WORKER_MODEL_SELECTION.reasoningEffort}\` reasoning`;
    assert.ok(
      setupSkill.includes(describedDefaults),
      "installed setup skill must describe the runtime role defaults exactly",
    );
    const body = "# Packed Objective\n\n## Acceptance\n- `test -s one.txt`\n";
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        {
          id: "one",
          title: "One",
          goal: "Create one.txt",
          acceptance: ["one.txt exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
          dependencies: [],
          ownedPaths: ["one.txt"],
          resources: [],
          validation: [
            {
              command: "test -s one.txt",
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ],
          brief: "Create one.txt",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
    };
    const application = installedPackage.createApplication(
      installedPackage.readConfig(config),
      {
        github: {
          async objective() {
            return { body, title: "Packed Objective" };
          },
        },
        planningModel: {
          async generateStructured(request) {
            observeInvocation(request);
            return graph;
          },
          async reviewGraph(request) {
            observeInvocation(request);
            return { findings: [] };
          },
        },
      },
    );
    const candidate = await application.planObjective(1);
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.baseSha, target.baseSha);
    assert.equal(
      existsSync(
        join(
          environment.XDG_STATE_HOME,
          "clockgrove-factory",
          "repositories",
          "example",
          "package-smoke",
          "objectives",
          "1",
          "state.json",
        ),
      ),
      false,
    );
    const before = JSON.parse(
      execFileSync(
        cli,
        ["status", "--objective", "1", "--json", "--config", config],
        { encoding: "utf8", env: environment },
      ),
    );
    assert.equal(before.state, "not-started");
    assert.deepEqual(before.work, []);

    const runner = join(prefix, "packed-harness-runner.mjs");
    copyFileSync(
      join(project, "test", "fixtures", "packed-harness-runner.mjs"),
      runner,
    );
    const credentialFreeEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !/^(?:GH_|GITHUB_|ANTHROPIC_|OPENAI_|CLAUDE_)/.test(name),
      ),
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [runner], {
        encoding: "utf8",
        cwd: prefix,
        env: {
          ...credentialFreeEnvironment,
          PACKED_TARGET_CHECKOUT: target.checkout,
          PACKED_TARGET_ORIGIN: target.origin,
          PACKED_FACTORY_CONFIG: config,
        },
      }),
    );
    assert.equal(result.adapter, "example/scripted-local@1");
    assert.equal(result.suppliedBase, target.baseSha);
    assert.equal(result.workerHeadUnchanged, true);
    assert.equal(result.validationPassed, true);
    assert.equal(result.pullRequest, 201);
    assert.equal(result.finalValidation, true);
    assert.match(result.changeRef, /^[0-9a-f]{40}$/);
    assert.match(result.treeSha, /^[0-9a-f]{40}$/);
    assert.match(result.integratedSha, /^[0-9a-f]{40}$/);

    const registeredConfig = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual(registeredConfig.execution.harness, {
      kind: "registered",
      adapter: "example/scripted-local@1",
      config: {
        output: "packed harness",
        permissionMode: "worktree-only",
        settingsSources: [],
      },
    });
    const after = JSON.parse(
      execFileSync(
        cli,
        ["status", "--objective", "1", "--json", "--config", config],
        { encoding: "utf8", env: environment },
      ),
    );
    assert.equal(after.state, "complete");
    assert.equal(after.finalValidation, true);
    const timeline = execFileSync(
      cli,
      ["diagnostics", "--objective", "1", "--config", config],
      { encoding: "utf8", env: environment },
    );
    assert.match(timeline, /"operation":"harness"/);
    const followed = spawnSync(
      cli,
      ["diagnostics", "--objective", "1", "--follow", "--config", config],
      { encoding: "utf8", env: environment, timeout: 1_500 },
    );
    assert.equal(followed.error?.code, "ETIMEDOUT");
    assert.equal(followed.stdout, timeline);
    assert.equal(followed.stderr, "");
    const diagnosticEvents = timeline.trim().split("\n").map(JSON.parse);
    const completed = diagnosticEvents.filter(
      (event) =>
        event.operation === "model-invocation" &&
        event.metadata.observationType === "completed",
    );
    assert.deepEqual(
      completed.map((event) => event.metadata.phase),
      ["compile", "graph-review"],
    );
    assert.ok(
      completed.every(
        (event) =>
          event.metadata.inputTokens === 11 &&
          event.metadata.cachedInputTokens === 5,
      ),
    );
    const unrelatedHarnessRoot = join(
      installedPackage.stateRoot("example/package-smoke"),
      "harness",
    );
    mkdirSync(unrelatedHarnessRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(
        unrelatedHarnessRoot,
        "11111111-1111-4111-8111-111111111111.progress.ndjson",
      ),
      "not-json\n",
      { mode: 0o600 },
    );
    const workerAttempt = "22222222-2222-4222-8222-222222222222";
    const diagnosticsFile = join(
      installedPackage.stateRoot("example/package-smoke"),
      "objectives",
      "1",
      "diagnostics.ndjson",
    );
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      diagnosticsFile,
      `${JSON.stringify({
        eventId: "worker-start",
        at: new Date().toISOString(),
        operation: "harness",
        outcome: "started",
        attemptId: workerAttempt,
        itemId: "worker-item",
        runId: "worker-run",
      })}\n`,
    );
    const workerUsage = {
      type: "completed",
      invocationId: "worker-invocation",
      providerAttempt: 1,
      role: "worker",
      phase: "implementation",
      provider: "generic-harness",
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 9 },
    };
    writeFileSync(
      join(unrelatedHarnessRoot, `${workerAttempt}.progress.ndjson`),
      `${JSON.stringify({ eventId: "worker-complete", at: new Date().toISOString(), operation: "worker-usage", workerUsage })}\n`,
      { mode: 0o600 },
    );
    const summary = JSON.parse(
      execFileSync(
        cli,
        ["diagnostics", "--objective", "1", "--summary", "--config", config],
        { encoding: "utf8", env: environment },
      ),
    );
    assert.equal(summary.objective.invocationCount, 2);
    assert.deepEqual(summary.objective.tokenTotals, {
      inputTokens: 22,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 4,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    });
    assert.deepEqual(summary.objective.cacheReadRatio, {
      numeratorCachedInputTokens: 10,
      denominatorInputTokens: 22,
      value: 10 / 22,
    });
    assert.equal(summary.scope, "planning-and-review-model-invocations");
    assert.equal(summary.workerUsage.tokenTotals.inputTokens, 100);
    assert.equal(summary.combinedUsage.tokenTotals.inputTokens, 122);
    assert.equal(summary.combinedUsage.tokenTotals.cachedInputTokens, 90);
    assert.equal(summary.combinedUsage.tokenTotals.outputTokens, 15);
    // The real injected harness deliberately supplied no typed usage; its
    // completed attempt remains unobserved instead of being inferred as zero.
    assert.equal(summary.workerUsage.coverage.unobservedAttemptCount, 1);
    assert.equal(
      Object.values(summary.workerUsage.byInvocation)[0].itemId,
      "worker-item",
    );
    assert.equal(
      Object.values(summary.workerUsage.byInvocation)[0].runId,
      "worker-run",
    );
  } finally {
    if (previousStateRoot === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

function observeInvocation(request) {
  const context = request.invocation;
  const common = {
    invocationId: context.invocationId,
    phase: context.phase,
    ordinal: context.ordinal,
    provider: "packed-test-provider",
    model: "packed-test-model",
    reasoningEffort: "medium",
    providerThreadId: `packed-${context.invocationId}`,
  };
  context.observe({ ...common, type: "started", promptBytes: 10 });
  context.observe({
    ...common,
    type: "progress",
    providerEvent: "turn.started",
  });
  context.observe({
    ...common,
    type: "completed",
    durationMs: 2,
    usageAvailable: true,
    usage: {
      inputTokens: 11,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
    },
  });
}
