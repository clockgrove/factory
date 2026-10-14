import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfigFile } from "../dist/config.js";
import { claudeQueryOptions } from "../dist/execution/claude-options.js";
import {
  factoryValidationServerName,
  factoryValidationToolAllowed,
  factoryValidationToolName,
  runDeclaredValidation,
  workerValidationCommands,
} from "../dist/execution/claude-validation.js";

const fileTools = ["Read", "Edit", "Write", "Glob", "Grep"];
const withValidate = [...fileTools, "Validate"];

function workerInput(tools, allowedTools = tools) {
  return {
    config: {
      kind: "claude-agent-sdk",
      model: "claude-sonnet-5-5",
      reasoningEffort: "medium",
      permissionMode: "acceptEdits",
      settingSources: [],
      tools,
      allowedTools,
      maxTurns: 12,
    },
    request: {
      worktree: "/tmp/worktree",
      item: {
        validation: [{ command: "pnpm check" }, { command: "pnpm test" }],
      },
    },
  };
}

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "factory-worker-validation-"));
  const worktree = join(directory, "worktree");
  execFileSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, "a.txt"), "original\n");
  execFileSync("git", ["-C", worktree, "add", "a.txt"]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  return { directory, worktree };
}

function targetCheckout() {
  const directory = mkdtempSync(join(tmpdir(), "factory-validate-config-"));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", [
    "-C",
    directory,
    "remote",
    "add",
    "origin",
    "https://github.com/example/target.git",
  ]);
  return directory;
}

const status = (worktree) =>
  execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
    encoding: "utf8",
  });

test("a Claude harness may name Validate as a configured tool", () => {
  const harness = workerInput(withValidate).config;
  const file = {
    schemaVersion: 1,
    repository: "example/target",
    checkout: targetCheckout(),
    providers: {
      claude: {
        planning: {
          kind: "claude-agent-sdk",
          maxOutputTokens: 64000,
          planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
          reviewer: { model: "claude-opus-5-5", reasoningEffort: "medium" },
        },
        execution: { kind: "local", harness },
      },
    },
    defaultProvider: "claude",
    delivery: { kind: "regular" },
    policy: { network: "host", allowedSecretNames: [] },
  };
  validateConfigFile(file);
  harness.tools = [...fileTools, "Bash"];
  assert.throws(() => validateConfigFile(file), /Grep, and Validate/);
});

test("only a worker granted Validate receives its declared commands", () => {
  assert.deepEqual(workerValidationCommands(workerInput(withValidate)), [
    "pnpm check",
    "pnpm test",
  ]);
  assert.deepEqual(workerValidationCommands(workerInput(fileTools)), []);
  assert.deepEqual(
    workerValidationCommands(workerInput(withValidate, fileTools)),
    [],
  );
});

test("the validation tool accepts only its own argument-free SDK call", () => {
  const input = workerInput(withValidate);
  const sdk = { name: factoryValidationServerName, source: "sdk" };
  assert.equal(
    factoryValidationToolAllowed(input, factoryValidationToolName, {}, sdk),
    true,
  );
  for (const [toolInput, provenance] of [
    [{ command: "rm -rf /" }, sdk],
    [{}, { name: "other", source: "sdk" }],
    [{}, { name: factoryValidationServerName, source: "user" }],
    [{}, undefined],
  ])
    assert.equal(
      factoryValidationToolAllowed(
        input,
        factoryValidationToolName,
        toolInput,
        provenance,
      ),
      false,
    );
  assert.equal(
    factoryValidationToolAllowed(
      workerInput(fileTools),
      factoryValidationToolName,
      {},
      sdk,
    ),
    false,
  );
});

test("SDK options serve Validate as Factory's tool, gated on readiness", async () => {
  const input = workerInput(withValidate);
  let ready = false;
  const validation = { server: { marker: true }, isReady: () => ready };
  const options = claudeQueryOptions(
    input,
    {},
    new AbortController(),
    undefined,
    validation,
  );
  assert.deepEqual(options.tools, fileTools);
  assert.equal(
    options.mcpServers[factoryValidationServerName],
    validation.server,
  );
  const call = () =>
    options.canUseTool(
      factoryValidationToolName,
      {},
      {
        mcpServer: { name: factoryValidationServerName, source: "sdk" },
        toolUseID: "t1",
      },
    );
  assert.equal((await call()).behavior, "deny");
  ready = true;
  assert.equal((await call()).behavior, "allow");
});

test("declared validation runs on a snapshot and leaves the worktree unchanged", async () => {
  const { worktree } = repository();
  writeFileSync(join(worktree, "a.txt"), "changed\n");
  writeFileSync(join(worktree, "new.txt"), "new\n");
  const before = status(worktree);
  const passed = await runDeclaredValidation(
    worktree,
    ["grep -q changed a.txt", "test -f new.txt"],
    1,
  );
  assert.equal(passed.passed, true, passed.text);
  const failed = await runDeclaredValidation(
    worktree,
    ["echo marker-output; exit 3"],
    2,
  );
  assert.equal(failed.passed, false);
  assert.match(failed.text, /marker-output/);
  assert.equal(status(worktree), before);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "changed\n");
  assert.equal(existsSync(`${worktree}.validation/1`), false);
});
