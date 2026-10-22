// Isolated even when run with a bare `node --test`, not only via npm test.
import "./isolate-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planningSessionInputDigest } from "../dist/agent-session.js";
import { assertKnownFlags } from "../dist/cli-flags.js";
import {
  assertNoCiOnlyValidation,
  assertPlanBoundaries,
  assertRequiredFinalCommands,
  fixedScripts,
  validateCommandProvenance,
} from "../dist/compiler.js";
import { PLAN_CHECKS, PLAN_CHECK_EXEMPT } from "../dist/compiler/sources.js";
import { planGraphLint, planStandardLint } from "../dist/compiler-wire.js";
import { prepareCompilationRequest } from "../dist/compiler/planning.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  ciOnlyCommands,
  factoryAuthorityDigest,
  factoryConfigDigest,
  finalValidationCommands,
  requiredFinalCommands,
  planningSessionRoot,
  readConfig,
  resolveProvider,
  validateConfigFile,
} from "../dist/config.js";
import { validationEnvironmentReport } from "../dist/validation-environment.js";
import { addProvider, writeConfiguration } from "../dist/install.js";
import { selectProvider } from "../dist/provider-selection.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import { saveState, statePath } from "../dist/state-store.js";
import {
  checkPreparedIntakeServiceState,
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

test("required final-validation commands follow the Objective's and bind authority", () => {
  const required = {
    ...file,
    finalValidation: { requiredCommands: ["npm run qualify", "npm test"] },
  };
  const config = resolveProvider(validateConfigFile(required), "codex");
  assert.deepEqual(
    finalValidationCommands(
      ["npm test", "npm run lint"],
      requiredFinalCommands(config),
    ),
    ["npm test", "npm run lint", "npm run qualify"],
  );
  assert.deepEqual(
    finalValidationCommands(["npm test"], requiredFinalCommands(flat)),
    ["npm test"],
  );
  // Planning keeps a required command's script fixed, and projection refuses
  // a required command the base cannot run as a fixed command.
  const scripts = checkout("example/scripts");
  writeFileSync(
    join(scripts, "package.json"),
    JSON.stringify({ scripts: { qualify: "node qualify.mjs" } }),
  );
  execFileSync("git", ["-C", scripts, "add", "package.json"]);
  execFileSync("git", [
    "-C",
    scripts,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "scripts",
  ]);
  const baseSha = execFileSync("git", ["-C", scripts, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const body = "## Acceptance\n- The suite qualifies.\n";
  assert.deepEqual(fixedScripts(body, baseSha, scripts, ["npm run qualify"]), [
    { name: "qualify", body: "node qualify.mjs" },
  ]);
  assert.throws(
    () =>
      assertRequiredFinalCommands(
        ["npm run qualify --workspace y"],
        body,
        baseSha,
        scripts,
      ),
    /^Error: Required final-validation command has no executable authority at the accepted base: npm run qualify --workspace y\./,
  );
  assert.notEqual(factoryConfigDigest(config), factoryConfigDigest(flat));
  assert.notEqual(factoryAuthorityDigest(config), factoryAuthorityDigest(flat));
  for (const finalValidation of [
    { requiredCommands: [] },
    { requiredCommands: [" npm test"] },
    { requiredCommands: ["npm test\nrm -rf ."] },
    { requiredCommands: ["npm test", "npm test"] },
    { commands: ["npm test"] },
  ])
    assert.throws(
      () => validateConfigFile({ ...file, finalValidation }),
      /^Error: finalValidation/,
    );
  // Unsupported script forms fail at config load, naming the accepted forms.
  for (const command of ["pnpm test:long-run", "npm run qualify --workspace y"])
    assert.throws(
      () =>
        validateConfigFile({
          ...file,
          finalValidation: { requiredCommands: [command] },
        }),
      /^Error: finalValidation\.requiredCommands lists .*`npm run NAME`/,
    );
});

test("CI-only commands are never validation commands (#1667)", () => {
  const audit = "npm run audit";
  const config = resolveProvider(
    validateConfigFile({
      ...file,
      finalValidation: { ciOnlyCommands: [audit] },
    }),
    "codex",
  );
  assert.deepEqual(ciOnlyCommands(config), [audit]);
  assert.deepEqual(requiredFinalCommands(config), []);
  assert.notEqual(factoryConfigDigest(config), factoryConfigDigest(flat));
  for (const finalValidation of [
    {},
    { ciOnlyCommands: [] },
    { requiredCommands: [audit], ciOnlyCommands: [audit] },
  ])
    assert.throws(
      () => validateConfigFile({ ...file, finalValidation }),
      /^Error: finalValidation/,
    );
  // Final validation: an Objective whose Acceptance runs it is refused
  // before planning.
  const target = checkout("example/ci-only");
  execFileSync("git", [
    "-C",
    target,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "base",
    "--allow-empty",
  ]);
  const baseSha = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.throws(
    () =>
      assertRequiredFinalCommands(
        [],
        `## Acceptance\n- \`${audit}\`\n`,
        baseSha,
        target,
        [audit],
      ),
    /^Error: Acceptance command npm run audit is CI-only/,
  );
  // Commands compare as the rest of Factory compares them: spacing aside.
  assert.throws(
    () =>
      assertRequiredFinalCommands(
        [],
        `## Acceptance\n- \`npm  run   audit\`\n`,
        baseSha,
        target,
        [audit],
      ),
    /is CI-only/,
  );
  // The planner is told, and graph validation refuses a Work Item that runs it.
  const request = prepareCompilationRequest({
    objective: 1,
    body: "## Acceptance\n- Dependencies stay licensed.\n",
    baseSha,
    checkout: target,
    ciOnlyCommands: [audit],
  });
  assert.deepEqual(request.compileContext.ciOnlyCommands, [audit]);
  assert.match(request.objective, /never use one as a validation command/);
  assert.match(request.objective, /decisionRequired/);
  // The planner always gets the compact validation environment (#1714).
  const environment = request.objective.match(
    /Validation environment[^\n]*/,
  )?.[0];
  assert.ok(environment && Buffer.byteLength(environment) < 800);
  assert.match(environment, /FACTORY_BASE_SHA/);
  // Setup reports it and warns on a network script not listed as CI-only.
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node --test",
        audit: "npm audit --omit=dev",
        plan: "tofu init && tofu plan",
        note: "echo curl and terraform init are prose here",
      },
    }),
  );
  const withTarget = { ...config, checkout: target };
  const report = validationEnvironmentReport(withTarget);
  assert.equal(report.ciOnlyCommands.set, true);
  assert.deepEqual(
    report.warnings.map((w) => w.match(/script (\w+)/)[1]).sort(),
    ["plan"],
  );
  assert.equal(
    validationEnvironmentReport({
      ...withTarget,
      finalValidation: { ciOnlyCommands: [audit, "pnpm run plan"] },
    }).warnings.length,
    0,
  );
  const graph = {
    items: [
      {
        id: "deps",
        validation: [
          { command: "npm test", provenance: "base-observed" },
          { command: audit, provenance: "base-observed" },
        ],
      },
    ],
  };
  assert.throws(
    () => assertNoCiOnlyValidation(graph, [audit]),
    /^Error: Work Item deps validation runs npm run audit, which the installation marks CI-only/,
  );
  graph.items[0].validation[1].command = " npm run  audit";
  assert.throws(() => assertNoCiOnlyValidation(graph, [audit]), /CI-only/);
  graph.items[0].validation.pop();
  assertNoCiOnlyValidation(graph, [audit]);
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
      approvedPlaybookPin: null,
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
  // Other commands keep the default; --provider names the one it ran with.
  const select = (flag) => {
    const { provider, source } = selectProvider(file, { objective: 8, flag });
    return `${provider}/${source}`;
  };
  // Service start gates only on Objectives it would dispatch; a dequeued
  // one with a stale binding is reported, not refused (#1650).
  const intake = (dequeued) => ({
    complete: true,
    watch: true,
    repository: file.repository,
    objectives: [8],
    dequeued,
  });
  assert.throws(
    () => checkPreparedIntakeServiceState(service, path, intake([])),
    /different configuration binding/,
  );
  checkPreparedIntakeServiceState(service, path, intake([8]));
  assert.equal(select(), "codex/unmatched");
  assert.equal(select("claude"), "claude/flag");
  // Cancel resolves the provider from the adapters the Objective recorded
  // (none here, so any provider releases nothing): no flag needed.
  const cancelling = selectProvider(file, { objective: 8, cancel: true });
  assert.equal(
    `${cancelling.provider}/${cancelling.source}`,
    "codex/recorded-adapters",
  );
  // A recorded session root the claude provider does not use leaves it
  // unresolved: the operator names the provider.
  const recordedClaude = (objective, root) => {
    const state = JSON.parse(
      readFileSync(statePath(file.repository, 8), "utf8"),
    );
    const scope = {
      repository: file.repository,
      objective,
      runId: `run-${objective}`,
      configDigest: "d".repeat(64),
      role: "planning",
      planningInputDigest: planningSessionInputDigest({
        ...state,
        sourcePacketDigest: "e".repeat(64),
      }),
    };
    saveState(statePath(file.repository, objective), {
      ...state,
      objective,
      runId: scope.runId,
      sourcePacketDigest: "e".repeat(64),
      agentSessions: {
        [JSON.stringify(["planning", null, scope.planningInputDigest])]: {
          scope,
          adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
          identity: randomUUID(),
          turn: 1,
          currentTurn: {
            invocationId: randomUUID(),
            requestDigest: "a".repeat(64),
            dispatch: "submitted",
            resources: "settled",
          },
          data: { root },
          status: "unavailable",
        },
      },
    });
    return selectProvider(file, { objective, cancel: true }).source;
  };
  assert.equal(
    recordedClaude(
      90,
      join(planningSessionRoot(resolveProvider(file, "claude")), "x"),
    ),
    "recorded-adapters",
  );
  assert.equal(recordedClaude(91, "/elsewhere/x"), "unmatched");
  // The remedy status prints must parse (#1426).
  assertKnownFlags("cancel", ["--objective", "8", "--provider", "claude"]);

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

test("every plan check gives the planner its facts and refuses with what would pass (#1732)", () => {
  const repo = checkout("example/plan-facts");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node --test",
        lint: "biome lint .",
        audit: "npm audit",
        "infra:validate": "tofu init && tofu validate",
      },
    }),
  );
  mkdirSync(join(repo, "docs"));
  writeFileSync(
    join(repo, "docs", "dev.md"),
    "Run first:\n\n`node --test`\n\n```ts\nconst key = 'sk-secret';\nrm -rf build\n```\n",
  );
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "base",
  ]);
  const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const request = prepareCompilationRequest({
    objective: 1,
    body: "## Acceptance\n- It works.\n\n## Sources\n- docs/dev.md\n",
    baseSha,
    checkout: repo,
    ciOnlyCommands: ["npm run audit"],
  });
  // The planner request carries the exact list the check uses: scripts in
  // supported forms, minus CI-only and network commands.
  const authorized = request.compileContext.authorizedCommands;
  // Scripts lead, then inline source commands; no CI-only script in any form,
  // no fenced code lines.
  assert.deepEqual(authorized, ["npm test", "npm run lint", "node --test"]);
  const note = request.objective.match(
    /Authorized validation commands[^\n]*/,
  )[0];
  assert.match(note, /`npm test`, `npm run lint`, `node --test`/);
  assert.ok(Buffer.byteLength(note) < 200, `${Buffer.byteLength(note)} bytes`);

  const item = (id, fields) => ({
    id,
    kind: "work",
    ownedPaths: ["src/a.ts"],
    acceptance: ["It works."],
    validation: [],
    dependencies: [],
    ...fields,
  });
  const command = (text) => ({
    command: text,
    provenance: "base-observed",
    source: "package.json",
  });
  const refusal = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.message;
    }
    assert.fail("expected a refusal");
  };
  const graph = (...items) => ({ baseSha, items });
  const refusals = {
    "command-authority": refusal(() =>
      validateCommandProvenance(
        graph(item("a", { validation: [command("pnpm --filter x test")] })),
        [{ path: "OBJECTIVE", content: "## Acceptance\n- It works.\n" }],
        repo,
      ),
    ),
    "ci-only": refusal(() =>
      assertNoCiOnlyValidation(
        graph(item("a", { validation: [command("npm run audit")] })),
        ["npm run audit"],
      ),
    ),
    network: refusal(() =>
      assertPlanBoundaries(
        graph(item("a", { validation: [command("npm run infra:validate")] })),
        repo,
        [],
        [],
        authorized,
      ),
    ),
    "new-file-name": refusal(() =>
      assertPlanBoundaries(
        graph(item("a", { acceptance: ["test/new-thing.test.mjs passes"] })),
        repo,
      ),
    ),
    "path-overlap": planGraphLint(
      graph(item("a", {}), item("b", {})),
      new Set(),
      new Map(),
      authorized,
    )[0],
    "local-proof": planGraphLint(
      graph(
        item("a", { validation: [command("npm test")] }),
        item("b", { ownedPaths: ["src/b.ts"] }),
      ),
      new Set(),
      new Map(),
      authorized,
    )[0],
    "plan-standard": planStandardLint(
      { id: "a", acceptance: ["Fix store.ts:88"] },
      null,
    )[0],
  };
  // The registry and this table move together: a new check adds both.
  assert.deepEqual(
    Object.keys(refusals).sort(),
    PLAN_CHECKS.map((c) => c.id).sort(),
  );
  // A plan-check function in the sources is registered or explicitly exempt.
  const functions = ["src/compiler/sources.ts", "src/compiler-wire.ts"].flatMap(
    (file) =>
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
        .split(/\n(?=(?:export )?(?:async )?function )/)
        .flatMap((chunk) => {
          const name = chunk.match(/^export (?:async )?function (\w+)/)?.[1];
          return name &&
            (/new GraphValidationError\(/.test(chunk) || /Lint$/.test(name))
            ? [name]
            : [];
        }),
  );
  const known = new Set([
    ...PLAN_CHECKS.map((c) => c.entry),
    ...PLAN_CHECK_EXEMPT,
  ]);
  assert.deepEqual(
    functions.filter((name) => !known.has(name)),
    [],
    "register new plan checks in PLAN_CHECKS",
  );
  const fix = {
    "command-authority": /Authorized commands: `npm test`, `npm run lint`/,
    "ci-only": /use an offline authorized command/,
    network:
      /select an offline authorized command instead \(`npm test`, `npm run lint`, `node --test`\)/,
    "new-file-name": /describe it by role and data/,
    "path-overlap": /narrow each item's ownedPaths/,
    "local-proof":
      /select one of the authorized commands \(`npm test`, `npm run lint`, `node --test`\)/,
    "plan-standard": /state the behaviour instead/,
  };
  for (const { id, facts } of PLAN_CHECKS) {
    assert.ok(facts, `${id} names the facts it puts in the request`);
    assert.match(refusals[id], fix[id], id);
  }
});
