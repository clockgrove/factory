import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  factoryAuthorityDigest,
  factoryConfigDigest,
  readConfig,
  resolveProvider,
  validateConfigFile,
} from "../dist/config.js";
import { addProvider, writeConfiguration } from "../dist/install.js";
import { selectProvider } from "../dist/provider-selection.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import { saveState, statePath } from "../dist/state-store.js";
import {
  checkServiceState,
  queuedObjectiveConfig,
} from "../dist/supervision.js";

/** A Git checkout whose origin is the configured repository. */
function checkout(repository) {
  const directory = mkdtempSync(join(tmpdir(), "factory-provider-target-"));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", [
    "-C",
    directory,
    "remote",
    "add",
    "origin",
    `https://github.com/${repository}.git`,
  ]);
  return directory;
}
const target = checkout("example/target");

const codex = {
  planning: {
    kind: "codex-sdk",
    planner: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    reviewer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  },
  execution: {
    kind: "local",
    harness: {
      kind: "codex-sdk",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    },
  },
};
const claude = {
  planning: {
    kind: "claude-agent-sdk",
    maxOutputTokens: 64000,
    planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
    reviewer: { model: "claude-opus-5-5", reasoningEffort: "medium" },
  },
  execution: {
    kind: "local",
    harness: {
      kind: "claude-agent-sdk",
      model: "claude-sonnet-5-5",
      reasoningEffort: "medium",
      permissionMode: "acceptEdits",
      settingSources: [],
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
      maxTurns: 12,
    },
  },
};
const flat = {
  schemaVersion: 1,
  repository: "example/target",
  checkout: target,
  ...codex,
  delivery: { kind: "regular" },
  policy: { network: "host", allowedSecretNames: [] },
};
const file = {
  schemaVersion: 1,
  repository: "example/target",
  checkout: target,
  providers: { codex, claude },
  defaultProvider: "codex",
  delivery: { kind: "regular" },
  policy: { network: "host", allowedSecretNames: [] },
};

test("a provider resolves to the flat configuration its Objectives froze", () => {
  validateConfigFile(file);
  assert.equal(
    factoryConfigDigest(resolveProvider(file, "codex")),
    factoryConfigDigest(flat),
  );
  assert.notEqual(
    factoryConfigDigest(resolveProvider(file, "claude")),
    factoryConfigDigest(flat),
  );
  assert.throws(
    () => validateConfigFile(flat),
    /planning and execution belong to a named provider/,
  );
  assert.throws(
    () => validateConfigFile({ ...file, defaultProvider: "copilot" }),
    /defaultProvider must name a configured provider/,
  );
});

test("queue authority binds the default provider whichever provider runs", () => {
  const authority = factoryAuthorityDigest(flat);
  assert.equal(
    factoryAuthorityDigest(resolveProvider(file, "codex")),
    authority,
  );
  assert.equal(
    factoryAuthorityDigest(resolveProvider(file, "claude")),
    authority,
  );
  assert.equal(
    factoryConfigDigest(resolveProvider(file, "claude")),
    factoryConfigDigest({ ...flat, ...claude }),
  );
  assert.notEqual(
    factoryAuthorityDigest(
      resolveProvider({ ...file, defaultProvider: "claude" }, "codex"),
    ),
    authority,
  );
});

test("new work overrides the default provider only with --provider", () => {
  const pick = (options) => {
    const { provider, source } = selectProvider(file, options);
    return `${provider}/${source}`;
  };
  assert.equal(pick({}), "codex/default");
  assert.equal(pick({ flag: "claude" }), "claude/flag");
  // An agent host's marker never switches the provider.
  process.env.CLAUDECODE = "1";
  try {
    assert.equal(pick({}), "codex/default");
  } finally {
    delete process.env.CLAUDECODE;
  }
});

test("the service continues a started Objective on the provider it froze", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "factory-provider-service-")),
    "config.json",
  );
  writeFileSync(path, JSON.stringify(file));
  const started = (objective, configDigest) =>
    saveState(statePath(file.repository, objective), {
      schemaVersion: 18,
      kind: "preparing",
      repository: file.repository,
      objective,
      runId: `run-${objective}`,
      configDigest,
      baseSha: "b".repeat(40),
      objectiveBodyDigest: "c".repeat(64),
      coordinator: {
        mode: "paused",
        phase: "planning",
        phaseStartedAt: new Date().toISOString(),
      },
      issueByItemId: {},
      capacity: { concurrency: 1 },
      autonomy: resolveAutonomy(),
    });
  const service = resolveProvider(file, "codex");
  const claudeDigest = factoryConfigDigest(resolveProvider(file, "claude"));

  started(7, claudeDigest);
  const frozen = queuedObjectiveConfig(service, 7, path);
  assert.equal(factoryConfigDigest(frozen), claudeDigest);
  assert.equal(frozen.planning.kind, "claude-agent-sdk");
  checkServiceState(frozen, 7, path);
  assert.throws(
    () => checkServiceState(service, 7, path),
    /different configuration binding/,
  );

  // A frozen configuration that no provider matches still refuses.
  started(8, "d".repeat(64));
  const unmatched = queuedObjectiveConfig(service, 8, path);
  assert.equal(factoryConfigDigest(unmatched), factoryConfigDigest(service));
  assert.throws(
    () => checkServiceState(unmatched, 8, path),
    /different configuration binding/,
  );

  // New work runs with the service's own provider.
  assert.equal(queuedObjectiveConfig(service, 9, path), service);
});

test("setup adds a provider without changing the others", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-provider-setup-"));
  const path = join(directory, "config.json");
  writeConfiguration(
    ["--repository", "example/setup", "--checkout", checkout("example/setup")],
    path,
  );
  const before = factoryConfigDigest(readConfig(path, "codex"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).defaultProvider, "codex");
  addProvider(
    [
      "--provider",
      "claude",
      "--planning",
      "claude-agent-sdk",
      "--planning-model",
      "claude-opus-5-5",
      "--review-model",
      "claude-opus-5-5",
      "--harness",
      "claude-agent-sdk",
      "--worker-model",
      "claude-sonnet-5-5",
    ],
    path,
  );
  assert.equal(factoryConfigDigest(readConfig(path, "codex")), before);
  const claude = readConfig(path, "claude");
  assert.equal(claude.planning.kind, "claude-agent-sdk");
  // A turn-limit stop continues the worker, so the limit is operational:
  // new configurations default to 400, and changing it keeps both digests.
  assert.equal(claude.execution.harness.maxTurns, 400);
  const raised = structuredClone(claude);
  raised.execution.harness.maxTurns = 800;
  assert.equal(factoryConfigDigest(raised), factoryConfigDigest(claude));
  assert.equal(factoryAuthorityDigest(raised), factoryAuthorityDigest(claude));
  assert.equal(readConfig(path).planning.kind, "codex-sdk");
  assert.throws(
    () => addProvider(["--provider", "claude"], path),
    /already configured/,
  );
});
