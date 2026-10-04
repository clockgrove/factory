import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import { DiagnosticEmitter } from "../dist/diagnostics.js";
import { saveState, statePath } from "../dist/state-store.js";
import { coverageObligations } from "../dist/qa.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";
import { defaultAutonomy } from "../dist/index.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { writeStateFile } from "./support/state-file.mjs";

test("diagnostics and status CLI preserve snapshots, unknown usage and coordinator error redaction", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-diagnostics-cli-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const target = createTarget(root);
  const config = factoryConfig(target.checkout, "example/diagnostics-cli");
  config.policy.allowedSecretNames = ["FACTORY_TEST_STATUS_SECRET"];
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const snapshotPath = statePath(config.repository, 1);
  const preparation = {
    schemaVersion: 8,
    kind: "preparing",
    repository: config.repository,
    objective: 1,
    runId: "preparing-run",
    configDigest: "b".repeat(64),
    autonomy: structuredClone(defaultAutonomy),
    capacity: { concurrency: 1 },
    baseSha: target.baseSha,
    objectiveBodyDigest: "c".repeat(64),
    plan: {},
    issueByItemId: {},
    coordinator: {
      mode: "running",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
    },
  };
  const observe = new DiagnosticEmitter(config.repository, 1).modelObserver({
    scopeId: "planning",
    runId: preparation.runId,
  });
  observe({
    invocationId: "compile",
    phase: "compile",
    ordinal: 0,
    type: "completed",
    usageAvailable: true,
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  observe({
    invocationId: "review",
    phase: "graph-review",
    ordinal: 0,
    type: "completed",
    usageAvailable: false,
  });
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [
        new URL("../dist/cli.js", import.meta.url).pathname,
        "diagnostics",
        "--objective",
        "1",
        "--config",
        configPath,
        ...args,
      ],
      { encoding: "utf8", env: process.env },
    );
  let expected;
  const execution = {
    schemaVersion: 7,
    repository: config.repository,
    objective: 1,
    runId: "execution-run",
    configDigest: preparation.configDigest,
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
          goal: "Result",
          brief: "Implement",
          acceptance: ["Result exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Goal" }],
          dependencies: [],
          ownedPaths: ["result.txt"],
          resources: [],
          validation: [],
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
      coverage: [
        {
          ...coverageObligations("Result exists", ["Result exists"])[0],
          itemId: "one",
          proof: { kind: "final-review" },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
    },
    issueByItemId: { one: 2 },
    work: { one: { status: "pending" } },
  };
  for (const snapshot of [preparation, execution]) {
    saveState(snapshotPath, snapshot);
    const before = readFileSync(snapshotPath, "utf8");
    const summary = cli("--summary");
    assert.equal(summary.status, 0, summary.stderr);
    const value = JSON.parse(summary.stdout);
    if (expected) assert.deepEqual(value, expected);
    else expected = value;
    assert.equal(value.objective.invocationCount, 2);
    assert.equal(value.objective.usageAvailableCount, 1);
    assert.equal(value.objective.usageUnavailableCount, 1);
    assert.equal(value.objective.tokenTotals.inputTokens, 12);
    const timeline = cli();
    assert.equal(timeline.status, 0, timeline.stderr);
    assert.equal(
      timeline.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.operation === "model-invocation").length,
      2,
    );
    assert.equal(readFileSync(snapshotPath, "utf8"), before);
    for (const mutation of [
      { repository: "other/repo" },
      { objective: 2 },
      { schemaVersion: 99 },
    ]) {
      writeStateFile(snapshotPath, { ...snapshot, ...mutation });
      for (const flags of [[], ["--summary"], ["--follow"]]) {
        const invalid = cli(...flags);
        assert.notEqual(invalid.status, 0);
        assert.equal(invalid.stdout, "");
        assert.match(
          invalid.stderr,
          /Invalid.*(?:state|snapshot)|earlier Factory version: .*v0.2.0 starts fresh/,
        );
      }
    }
  }
  const privateValue = "configured-private-value";
  const coordinator = {
    ...preparation.coordinator,
    mode: "paused",
    waitReason: `Paused: ${privateValue}`,
    cancelError: `Cessation unknown: ${privateValue}`,
  };
  preparation.coordinator = coordinator;
  preparation.error = `Preparation failed: ${privateValue}`;
  execution.coordinator = coordinator;
  execution.error = `Execution failed: ${privateValue}`;
  for (const snapshot of [preparation, execution]) {
    saveState(snapshotPath, snapshot);
    const beforeStatus = readFileSync(snapshotPath, "utf8");
    for (const flags of [[], ["--json"]]) {
      const status = spawnSync(
        process.execPath,
        [
          new URL("../dist/cli.js", import.meta.url).pathname,
          "status",
          "--objective",
          "1",
          "--config",
          configPath,
          ...flags,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, FACTORY_TEST_STATUS_SECRET: privateValue },
        },
      );
      assert.equal(status.status, 0, status.stderr);
      assert.doesNotMatch(status.stdout, /configured-private-value/);
      assert.match(status.stdout, /\[REDACTED\]/);
      if (flags.length) {
        const document = JSON.parse(status.stdout);
        for (const field of ["waitReason", "cancelError"])
          assert.equal(
            document.coordinator[field],
            coordinator[field].replace(privateValue, "[REDACTED]"),
          );
        assert.equal(
          document.error ?? document.lastError,
          snapshot.error.replace(privateValue, "[REDACTED]"),
        );
        assert.ok(document.phase && document.summary);
      } else {
        // Unresolved cancellation comes first while planning and after.
        assert.match(
          status.stdout,
          /^Needs decision: cancellation unresolved: Cessation unknown: \[REDACTED\]\nfactory cancel --objective 1\n/,
        );
        assert.match(
          status.stdout,
          /Error: (Preparation|Execution) failed: \[REDACTED\]/,
        );
      }
      assert.equal(readFileSync(snapshotPath, "utf8"), beforeStatus);
    }
  }
});

test("diagnostics is the one observation command: timeline, summary, analyze, logs and captures are modes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-diagnostics-modes-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const target = createTarget(root);
  const config = factoryConfig(target.checkout, "example/diagnostics-modes");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [
        new URL("../dist/cli.js", import.meta.url).pathname,
        "diagnostics",
        "--objective",
        "1",
        ...args,
        "--config",
        configPath,
      ],
      { encoding: "utf8", env: process.env },
    );
  const refused = (args, message) => {
    const result = cli(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
  };
  // One mode at a time; a flag belongs to the mode that reads it.
  refused(
    ["--summary", "--analyze"],
    /diagnostics takes one mode: --follow, --summary, --analyze, --logs ITEM or --captures/,
  );
  refused(["--follow", "--summary"], /takes one mode/);
  refused(["--captures", "--logs", "one"], /takes one mode/);
  refused(["--follow", "--analyze"], /takes one mode/);
  refused(
    ["--group-by", "phase"],
    /--group-by belongs to diagnostics --analyze/,
  );
  refused(["--summary", "--gantt"], /--gantt belongs to diagnostics --analyze/);
  refused(["--content", "abc"], /--content belongs to diagnostics --captures/);
  refused(["--logs"], /diagnostics --logs requires ITEM/);
  refused(
    ["--analyze", "--wat"],
    /Unknown option --wat for factory diagnostics/,
  );
  refused(["--analyze", "--gantt"], /--gantt requires --output/);
  refused(
    ["--analyze", "--group-by", "nonsense"],
    /Unknown analysis field nonsense/,
  );
  // --logs needs a Work Item with a recorded attempt.
  refused(["--logs", "one"], /requires a Work Item with a recorded attempt/);

  // --analyze reports on the retained interactions (none yet), as text or JSON.
  const report = cli("--analyze", "--json");
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).invocationCount, 0);
  assert.equal(
    cli("--analyze", "--group-by", "phase").status,
    0,
    "text analysis with grouping",
  );
  const saved = join(root, "analysis.json");
  const written = cli("--analyze", "--json", "--output", saved);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /Saved private analysis report to /);
  assert.equal(JSON.parse(readFileSync(saved, "utf8")).invocationCount, 0);

  // --captures lists retained captures: none; one that is unknown names the failure.
  const none = cli("--captures");
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, "");
  refused(
    ["--captures", "--content", "missing"],
    /Captured content unavailable for this record/,
  );

  // --logs prints the worker output of the item's recorded attempt.
  const attempt = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const harness = join(stateRoot(config.repository), "harness");
  mkdirSync(harness, { recursive: true, mode: 0o700 });
  writeFileSync(join(harness, `${attempt}.log`), "first line\nsecond line\n", {
    mode: 0o600,
  });
  const item = {
    id: "one",
    title: "One",
    goal: "Result",
    brief: "Implement",
    acceptance: ["Result exists"],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Goal" }],
    dependencies: [],
    ownedPaths: ["result.txt"],
    resources: [],
    validation: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
  saveState(statePath(config.repository, 1), {
    schemaVersion: 7,
    repository: config.repository,
    objective: 1,
    runId: "logs-run",
    configDigest: "b".repeat(64),
    autonomy: structuredClone(defaultAutonomy),
    capacity: { concurrency: 1 },
    get planGraphDigest() {
      return graphDigest(this.graph);
    },
    baseSha: target.baseSha,
    graph: {
      objective: 1,
      baseSha: target.baseSha,
      items: [item],
      coverage: [
        {
          ...coverageObligations("Result exists", ["Result exists"])[0],
          itemId: "one",
          proof: { kind: "final-review" },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
    },
    issueByItemId: { one: 2 },
    work: { one: { status: "pending", attempt } },
  });
  const logs = cli("--logs", "one");
  assert.equal(logs.status, 0, logs.stderr);
  assert.equal(logs.stdout, "first line\nsecond line\n");
});
