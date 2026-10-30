// Telemetry and debugging: what the run log and its attempt files keep,
// and how diagnostics, watch and status show it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import {
  CAPTURE_OFF,
  RunLog,
  readNew,
  readRunFile,
  rotatedRuns,
  rotateLogs,
} from "../dist/log.js";
import { RunTally, statusComment } from "../dist/progress.js";
import {
  captureResponse,
  describeRequest,
  logUsage,
  tokens,
  usageRecord,
} from "../dist/providers/usage.js";
import { validateTree } from "../dist/validate.js";
import { ActivityLog } from "../dist/work/worker.js";
import { changedFiles } from "../dist/worktree.js";
import {
  CLI,
  children,
  cli,
  closedPort,
  configured,
  installation,
  item,
  plan,
  REPO,
  seed,
  serve,
  status,
  stopped,
  tempDir,
  until,
} from "./helpers.mjs";

/** The CLI with room for a large output. */
function large(inst, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--repo", REPO], {
    env: inst.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 ** 2,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const SECRET = "s3cret-value-for-redaction";

test("an attempt file redacts a secret or token split across a long line's pieces or between two streams' chunks", () => {
  const inst = installation();
  const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-9", CAPTURE_OFF, [
    SECRET,
  ]);
  const file = log.runFile(63, "item:a:validate#1.validation-0");
  // Another stream's chunk between a line's halves.
  file.append(`token ${SECRET.slice(0, 9)}`, "stdout");
  file.append("stderr line\n", "stderr");
  file.append(`${SECRET.slice(9)}\n`, "stdout");
  // Past 64 KiB with no newline, so the line is written in pieces: a
  // secret, then a token, where a piece would end.
  const long = "x ".repeat(33 * 1024);
  file.append(`${long}${SECRET.slice(0, 9)}`, "stdout");
  file.append(`${SECRET.slice(9)} ${long}ghp_abcd`, "stdout");
  file.append("efghijkl\n", "stdout");
  file.close();
  const text = readRunFile(inst.logs, file.file, []).text;
  assert.ok(!text.includes(SECRET.slice(9)), "no secret half");
  assert.ok(!text.includes("efghijkl"), "no token half");
  assert.equal(
    text,
    `stderr line\ntoken [REDACTED]\n${long}[REDACTED] ${long}[REDACTED]\n`,
  );
});

test("a worker attempt's transcript is kept redacted and bounded beside the run log, shown by diagnostics --logs, and rotated with its run", () => {
  const inst = installation();
  const worktree = tempDir("factory-tree-");
  const run = "2026-01-01T00-00-00-000Z-1";
  const log = new RunLog(inst.logs, run, CAPTURE_OFF, [SECRET]);
  const step = { step: "item:a:work", attemptId: "item:a:work#1" };
  log.write(61, { ...step, event: "start" });
  const activity = new ActivityLog(
    "a",
    worktree,
    (event) => log.write(61, { ...step, ...event }),
    [SECRET],
    { transcript: log.runFile(61, "item:a:work#1.transcript") },
  );
  activity.report({
    kind: "tool",
    phase: "started",
    tool: "Edit",
    target: join(worktree, "src/a.ts"),
  });
  activity.report({
    kind: "tool",
    phase: "started",
    tool: "shell",
    target: `npm test --token ${SECRET}`,
  });
  // 20 MiB of command output: the head stays, the middle rotates away.
  for (let i = 0; i < 330; i++)
    activity.output({
      type: "item.completed",
      item: {
        type: "command_execution",
        aggregated_output: `${i} ${"x".repeat(64 * 1024)}`,
      },
    });
  activity.output({ type: "item.agentMessage_delta", text: "skipped" });
  activity.output({
    type: "item.completed",
    item: { type: "agent_message", text: `done with ${SECRET}` },
  });
  activity.close();
  log.write(61, { ...step, event: "outcome", outcome: "done" });

  const dir = join(inst.logs, "61", `${run}.attempts`);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const segments = readdirSync(dir).sort();
  assert.ok(segments.includes("item_a_work_1.transcript.0"), segments);
  assert.ok(!segments.includes("item_a_work_1.transcript.1"), segments);
  for (const name of segments)
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
  const bytes = segments.reduce(
    (sum, name) => sum + statSync(join(dir, name)).size,
    0,
  );
  assert.ok(bytes <= 16 * 1024 ** 2, `bounded: ${bytes}`);

  const text = large(inst, "diagnostics", "61", "--logs", "a");
  assert.equal(text.code, 0, text.err);
  // Checked without echoing 16 MiB on a failure.
  const shows = (pattern, what) => assert.ok(pattern.test(text.out), what);
  shows(
    /transcript of item:a:work#1: \d+ records, its middle rotated away/,
    "the transcript, cut",
  );
  shows(/tool Edit started: \S+\/src\/a\.ts/, "a tool with its target");
  shows(/tool shell started: npm test --token \[REDACTED\]/, "redacted");
  shows(/"aggregated_output":"0 x/, "the head");
  shows(/done with \[REDACTED\]/, "the tail");
  assert.ok(!text.out.includes(SECRET), "no secret");
  assert.ok(!text.out.includes("skipped"), "no deltas");
  const json = large(inst, "diagnostics", "61", "--logs", "a", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.kind === "transcript");
  assert.equal(json.transcript.cut, true);
  assert.equal(json.transcript.records[0].activity.tool, "Edit");
  assert.equal(
    json.transcript.records.at(-1).output.item.type,
    "agent_message",
  );
  // The run's activity event names the targets, cut and redacted.
  const shown = cli(inst, "log", "61", "--json").out;
  assert.match(shown, /"targets":\[\{"tool":"Edit","target":"src\/a\.ts"\}/);

  // Rotated with its run.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(join(inst.logs, "61", `${run}.jsonl`), old, old);
  utimesSync(dir, old, old);
  rotateLogs(inst.logs, undefined, { runsPerObjective: 0, totalBytes: 1 });
  assert.ok(!existsSync(dir));
});

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("a failed validation command's whole output is kept in its attempt file and named by its event; a passing one keeps none", async () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const { sandbox } = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const checkout = tempDir("factory-validate-");
  git(checkout, "init", "--quiet");
  // 40,000 numbered lines with a secret at the end: far past the event's head and tail.
  writeFileSync(
    join(checkout, "noisy.js"),
    `for (let i = 0; i < 40000; i++) console.log("line " + i);\nconsole.error("token ${SECRET}");\nprocess.exitCode = 3;\n`,
  );
  git(checkout, "add", "noisy.js");
  git(
    checkout,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const commit = git(checkout, "rev-parse", "HEAD");
  const run = "2026-01-01T00-00-00-000Z-2";
  const log = new RunLog(inst.logs, run, CAPTURE_OFF, [SECRET]);
  const events = [];
  const work = item("a", {
    validation: [
      { command: "node -e 'process.exit(0)'" },
      { command: "node noisy.js" },
    ],
  });
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: join(checkout, "..", `${checkout.split("/").at(-1)}.validation`),
    commit,
    item: work,
    plan: { base: commit, items: [work], finalCommands: [] },
    blocks: [],
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => {
      events.push(event);
      log.write(62, {
        step: "item:a:validate",
        attemptId: "item:a:validate#1",
        ...event,
      });
    },
    runFile: (kind) => log.runFile(62, `item:a:validate#1.${kind}`),
  });
  assert.equal(result.kind, "failed", JSON.stringify(result).slice(0, 500));
  const [passed, failed] = events.filter(
    (e) => e.event === "validation-result",
  );
  assert.equal(passed.passed, true);
  assert.equal(passed.output, undefined);
  assert.equal(failed.passed, false);
  assert.equal(
    failed.output,
    `62/${run}.attempts/item_a_validate_1.validation-1`,
  );
  assert.ok(failed.tail.length < 12_000, "the event keeps its head and tail");
  const whole = readRunFile(inst.logs, failed.output, []);
  assert.equal(whole.cut, false);
  const lines = whole.text.split("\n");
  assert.equal(lines.filter((line) => line.startsWith("line ")).length, 40_000);
  assert.ok(lines.includes("token [REDACTED]"), "redacted as written");
  assert.ok(
    !readFileSync(join(inst.logs, `${failed.output}.0`), "utf8").includes(
      SECRET,
    ),
  );
  // The passing command's file is gone.
  assert.deepEqual(readdirSync(join(inst.logs, "62", `${run}.attempts`)), [
    "item_a_validate_1.validation-1.0",
  ]);
  const shown = cli(inst, "diagnostics", "62", "--logs", "a");
  assert.match(
    shown.out,
    new RegExp(
      `whole output: \\S+/62/${run}\\.attempts/item_a_validate_1\\.validation-1`,
    ),
  );
});

/** Every event of the issue's run log so far. */
function events(inst, issue) {
  return cli(inst, "log", String(issue), "--tail", "100000", "--json")
    .out.trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("a step's GitHub requests are traced with their failure category, time and counts, like a sync job's", async () => {
  for (const [api, category] of [
    [`http://127.0.0.1:${await closedPort()}`, "connection"],
    ["http://factory-drill.invalid", "dns"],
  ]) {
    const inst = installation();
    configured(inst, api);
    seed(inst, 63);
    const service = serve(inst);
    const traced = () =>
      events(inst, 63).find(
        (e) => e.event === "github-request" && e.step === "check",
      );
    await until(traced, `the check's ${category} failure, traced`, 30_000);
    const request = traced();
    assert.equal(request.category, category);
    // Its cause, not only fetch's "fetch failed" (#2192).
    assert.ok(request.codes?.length, JSON.stringify(request));
    assert.match(request.cause, /^fetch failed: \S/);
    assert.equal(request.status, null);
    assert.equal(request.job, "check");
    assert.match(request.attemptId, /^check#\d+$/);
    assert.equal(typeof request.ms, "number");
    assert.match(request.route, /^\/(?:repos|graphql|user)/);
    const call = events(inst, 63).find(
      (e) => e.event === "github-call" && e.step === "check",
    );
    assert.ok(call.calls >= 1 && call.failed >= 1, JSON.stringify(call));
    assert.equal(typeof call.requestMs, "number");
    // analysis sums them with the sync jobs'.
    const analysis = JSON.parse(
      cli(inst, "diagnostics", "63", "--analyze", "--json").out,
    );
    assert.ok(analysis.github.traced[`network ${category}`] >= 1);
    assert.ok(
      Object.keys(analysis.github.causes).some((key) =>
        key.startsWith(`${category} `),
      ),
      JSON.stringify(analysis.github.causes),
    );
    await stopped(service);
  }
});

test("a running planner or reviewer call shows in watch and the live status comment with its model, role, age, context and turns", async () => {
  const inst = installation();
  const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-3");
  const step = { step: "item:a:review", attemptId: "item:a:review#1" };
  log.write(64, { ...step, event: "start" });
  log.write(64, {
    ...step,
    event: "model-call",
    callId: "c1",
    role: "reviewer",
    phase: "result-review",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
  });
  log.write(64, {
    ...step,
    event: "model-progress",
    callId: "c1",
    ms: 20_000,
    turns: 3,
    tokens: 84_000,
    window: 272_000,
  });
  const watching = spawn(
    process.execPath,
    [CLI, "watch", "64", "--repo", REPO],
    {
      env: inst.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(watching);
  let view = "";
  watching.stdout.on("data", (chunk) => {
    view += chunk;
  });
  await until(
    () =>
      /#64 a review #1 running for \S+ · reviewer result-review codex gpt-6\.1-sol high for \S+, 3 turns, context 84K\/272K/.test(
        view,
      ),
    "the running call in watch",
  );
  watching.kill("SIGINT");
  const tally = new RunTally(inst.logs);
  const shown = (running) =>
    statusComment(
      "<!-- marker -->",
      {
        view: {
          issue: 64,
          status: "building",
          phase: "building",
          mode: "running",
          holds: [],
          items: [],
          waiting: [],
          waitsOn: null,
          running: [],
          flakyRerun: [],
          rereviews: [],
          decisions: [],
          nextAction: { reason: "Factory is reviewing." },
        },
        ...running,
        decisions: [],
      },
      [],
      { questions: true },
      Date.now(),
    ).body;
  const body = shown(tally.read(64, "2026-01-01T00:00:00.000Z"));
  assert.match(body, /\*\*Model calls running\*\*/);
  assert.match(
    body,
    /- reviewer result-review \(Work Item `a`\): codex gpt-6\.1-sol high, started .*; 3 turns; 84000 input tokens in context/,
  );
  log.write(64, {
    ...step,
    event: "model-usage",
    callId: "c1",
    role: "reviewer",
  });
  assert.doesNotMatch(
    shown(tally.read(64, "2026-01-01T00:00:00.000Z")),
    /Model calls running/,
  );
});

test("a model call's answer is sized and digested with capture off; a cut capture keeps its originals' size and digest", () => {
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const prompt = `Plan ${"p".repeat(4_000)}`;
  const answer = `{"plan": "${"a".repeat(3_000)}"}`;
  const call = (capture, issue) => {
    const inst = installation();
    const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-5", capture);
    const record = usageRecord({
      role: "planner",
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      phase: "plan",
    });
    describeRequest(record, { prompt });
    captureResponse(record, answer);
    record.tokens = tokens({ input: 10, output: 2, cached: 4, cacheWrite: 3 });
    record.outcome = "done";
    logUsage((event) => log.write(issue, { step: "plan", ...event }), record);
    return inst;
  };
  const off = call(CAPTURE_OFF, 66);
  const usage = events(off, 66).find((e) => e.event === "model-usage");
  assert.equal(usage.responseBytes, Buffer.byteLength(answer));
  assert.equal(usage.responseDigest, sha(answer));
  assert.equal(usage.capture, undefined);
  assert.deepEqual(usage.tokens, {
    input: 10,
    output: 2,
    cached: 4,
    cacheWrite: 3,
    reasoning: null,
    total: 12,
  });
  const summary = JSON.parse(
    cli(off, "diagnostics", "66", "--summary", "--json").out,
  );
  assert.equal(summary.roles.planner.tokens.cacheWrite, 3);
  const on = call({ enabled: true, maxBytesPerCall: 2048 }, 67);
  const [captured] = JSON.parse(
    cli(on, "diagnostics", "67", "--captures", "--json").out,
  ).captures;
  const shown = cli(
    on,
    "diagnostics",
    "67",
    "--captures",
    "--content",
    captured.id,
  );
  assert.match(
    shown.out,
    new RegExp(
      `\\(cut to capture\\.maxBytesPerCall; the request was 4,005 bytes \\(sha256 ${sha(prompt).slice(0, 12)}…\\), the response was 3,012 bytes \\(sha256 ${sha(answer).slice(0, 12)}…\\)\\)`,
    ),
  );
});

test("watch --once and --json show each row's attempt, PR, tool targets and the worktree's changed files, shell edits included; log --tail reads long lines", async () => {
  const inst = installation();
  const tree = tempDir("factory-tree-");
  git(tree, "init", "--quiet");
  writeFileSync(join(tree, "a.ts"), "a\n");
  git(tree, "add", "a.ts");
  git(
    tree,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-6");
  const step = { step: "item:a:work", attemptId: "item:a:work#3" };
  log.write(68, { ...step, event: "start" });
  const activity = new ActivityLog(
    "a",
    tree,
    (event) => log.write(68, { ...step, ...event }),
    [],
    { changes: () => changedFiles(tree, AbortSignal.timeout(30_000)) },
  );
  activity.report({
    kind: "tool",
    phase: "started",
    tool: "shell",
    target: "sed -i s/a/b/ a.ts",
  });
  // A shell command's edits: no edit tool reported them.
  writeFileSync(join(tree, "a.ts"), "b\n");
  writeFileSync(join(tree, "generated.ts"), "g\n");
  await activity.sample();
  activity.close();
  log.write(68, {
    step: "item:a:publish",
    event: "published",
    item: "a",
    pr: 7,
    head: "h",
  });
  const [row] = cli(inst, "watch", "68", "--once", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(row.attempt, 3);
  assert.equal(row.pr, 7);
  assert.deepEqual(row.changed, { count: 2, files: ["a.ts", "generated.ts"] });
  assert.deepEqual(row.targets, [
    { tool: "shell", target: "sed -i s/a/b/ a.ts" },
  ]);
  const text = cli(inst, "watch", "68", "--once");
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^#68 a work #3 running for \S+ · PR #7 · /);
  assert.match(text.out, /last tools: shell sed -i s\/a\/b\/ a\.ts/);
  assert.match(
    text.out,
    /2 files changed in the worktree \(a\.ts, generated\.ts\)/,
  );
  // 30 events of 5 KiB each: more than the old fixed read of the file's end held.
  for (let i = 0; i < 30; i++)
    log.write(68, {
      event: "model-usage",
      n: i,
      providerUsage: { pad: "x".repeat(5_000) },
    });
  const tail = cli(inst, "log", "68", "--tail", "20", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(tail.length, 20);
  assert.equal(tail.at(-1).n, 29);
});

test("status --json details each Work Item's attempt, commits, last error, repair class, blocker and whether it runs, with the service's setup; analyze groups by attempt and call and breaks tokens down by model and child thread", () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  seed(inst, 69, "building", {
    done: {
      check: {},
      plan: plan([item("a"), item("b", { dependencies: ["a"] }), item("c")]),
      "item:a:work": {
        base: "b0",
        commit: "c1",
        tree: "t1",
        notes: [],
        sets: [],
      },
      "item:a:validate": { tree: "t2", commands: [] },
    },
    retries: {
      "item:a:review": {
        count: 1,
        attempts: 1,
        since: "2026-01-01T00:00:00.000Z",
        nextAt: "2099-01-01T00:00:00.000Z",
        lastError: "GitHub GET /repos: 502",
      },
    },
    repairs: {
      "item:a:work": {
        count: 1,
        findings: ["npm test failed"],
        from: "item:a:validate",
      },
    },
    stepRuns: { "item:a:review": { n: 2 } },
    attempts: { "item:c:work": { startedAt: new Date().toISOString() } },
  });
  const [objective] = status(inst).objectives;
  const [a, b, c] = objective.items;
  assert.deepEqual(
    {
      attempt: a.attempt,
      base: a.base,
      tree: a.tree,
      head: a.head,
      lastError: a.lastError,
      repair: a.repair,
      blocker: a.blocker,
    },
    {
      attempt: { id: "item:a:review#2", n: 2 },
      base: "b0",
      tree: "t2",
      head: "c1",
      lastError: "GitHub GET /repos: 502",
      repair: {
        target: "item:a:work",
        class: "validate",
        finding: "npm test failed",
      },
      blocker: null,
    },
  );
  assert.equal(b.blocker, "waits for a to merge");
  assert.deepEqual(
    objective.items.map((row) => [row.id, row.running]),
    [
      ["a", false],
      ["b", false],
      ["c", true],
    ],
  );
  // The live status comment lists running Work Items' workers only.
  const reported = { at: new Date().toISOString(), counts: { turns: 1 } };
  const comment = statusComment(
    "<!-- marker -->",
    {
      view: objective,
      calls: [],
      running: [],
      activity: { a: reported, c: reported },
      decisions: [],
    },
    [],
    { questions: true },
    Date.now(),
  ).body;
  assert.match(comment, /\*\*Workers\*\*\n- `c`: active/);
  assert.doesNotMatch(comment, /- `a`: active/);
  const shown = cli(inst, "status");
  assert.match(
    shown.out,
    /Provider: codex \(the default\) · sandbox (required|optional), network (off|package-install)/,
  );
  // Analysis: one Claude call with a sub-agent model, a resumed one whose
  // per-model counts are its session's running total, and one Codex call
  // with child threads.
  const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-7");
  log.write(69, {
    step: "item:a:review",
    attemptId: "item:a:review#1",
    event: "model-usage",
    callId: "k1",
    role: "reviewer",
    provider: "claude",
    model: "claude-opus",
    tokens: {
      input: 150,
      output: 20,
      cached: 30,
      cacheWrite: 20,
      reasoning: null,
      total: 170,
    },
    providerUsage: {
      modelUsage: {
        "claude-opus": {
          inputTokens: 80,
          outputTokens: 15,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 20,
          costUSD: 0.5,
        },
        "claude-haiku": { inputTokens: 20, outputTokens: 5, costUSD: 0.01 },
      },
    },
  });
  log.write(69, {
    step: "item:a:review",
    attemptId: "item:a:review#1",
    event: "model-usage",
    callId: "k3",
    role: "reviewer",
    provider: "claude",
    model: "claude-opus",
    reportedModel: "claude-opus",
    sessionMode: "resumed",
    tokens: { input: 40, output: 4, cached: 0, cacheWrite: 0, total: 44 },
    costUsd: 0.1,
    providerUsage: {
      modelUsage: {
        "claude-opus": { inputTokens: 120, outputTokens: 19, costUSD: 0.6 },
        "claude-haiku": { inputTokens: 20, outputTokens: 5, costUSD: 0.01 },
      },
    },
  });
  log.write(69, {
    step: "item:a:work",
    attemptId: "item:a:work#1",
    event: "model-usage",
    callId: "k2",
    role: "worker",
    provider: "codex",
    model: "gpt-6.1-sol",
    reportedModel: "gpt-6.1-sol",
    tokens: {
      input: 1000,
      output: 100,
      cached: 900,
      cacheWrite: 0,
      reasoning: 10,
      total: 1100,
    },
    providerUsage: {
      descendants: {
        threads: 2,
        input: 400,
        cached: 300,
        output: 40,
        reasoning: 4,
        total: 440,
      },
    },
  });
  const analysis = JSON.parse(
    cli(
      inst,
      "diagnostics",
      "69",
      "--analyze",
      "--json",
      "--group-by",
      "attemptId",
    ).out,
  );
  assert.deepEqual(analysis.groups.map((group) => group.key.attemptId).sort(), [
    "item:a:review#1",
    "item:a:work#1",
  ]);
  assert.deepEqual(analysis.calls.models["claude-haiku"], {
    calls: 1,
    input: 20,
    output: 5,
    cached: 0,
    cacheWrite: 0,
    costUsd: 0.01,
  });
  assert.deepEqual(analysis.calls.models["claude-opus"], {
    calls: 2,
    input: 170,
    output: 19,
    cached: 30,
    cacheWrite: 20,
    costUsd: 0.6,
  });
  assert.equal(analysis.calls.models["gpt-6.1-sol"].input, 1000);
  assert.equal(analysis.calls.descendants.threads, 2);
  const filtered = JSON.parse(
    cli(
      inst,
      "diagnostics",
      "69",
      "--analyze",
      "--json",
      "--filter",
      "callId=k2",
    ).out,
  );
  assert.equal(filtered.calls.usage.calls, 1);
  assert.match(
    cli(inst, "diagnostics", "69", "--analyze").out,
    /Codex child threads: 2 in 1 calls · 440 tokens/,
  );
});

test("diagnostics counts hedges won and lost per role and phase, in the summary and the analysis", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-8");
  const usage = (step, callId, role, phase, fields) =>
    log.write(72, {
      step,
      attemptId: `${step}#1`,
      event: "model-usage",
      callId,
      role,
      phase,
      provider: "codex",
      model: "gpt-6.1-sol",
      ...fields,
    });
  // A diagnosis whose hedge lost, as all ten in Clockgrove #800 did: the
  // first call answered and the hedge was aborted.
  usage("item:a:work", "d1", "planner", "diagnosis", {
    outcome: "done",
    tokens: { total: 1000 },
  });
  usage("item:a:work", "d2", "planner", "diagnosis", {
    outcome: "error",
    error: "Error: hedged",
    hedge: 1,
    tokens: { total: 400 },
  });
  // A result review whose hedge won: it answered, and the stalled first
  // call was aborted.
  usage("item:a:review", "r1", "reviewer", "result-review", {
    outcome: "error",
    error: "Error: hedged",
    tokens: { total: 300 },
  });
  usage("item:a:review", "r2", "reviewer", "result-review", {
    outcome: "done",
    hedge: 1,
    tokens: { total: 200 },
  });
  // Unhedged calls add nothing.
  usage("item:a:review", "r3", "reviewer", "result-review", {
    outcome: "done",
    tokens: { total: 50 },
  });
  // A lost hedge aborted before it reported tokens: unknown, not 0.
  usage("plan:1:1", "g1", "reviewer", "graph-review", {
    outcome: "done",
    tokens: { total: 90 },
  });
  usage("plan:1:1", "g2", "reviewer", "graph-review", {
    outcome: "error",
    error: "Error: hedged",
    hedge: 1,
  });
  const expected = {
    "planner diagnosis": {
      hedged: 1,
      won: 0,
      lost: 1,
      tokens: 400,
      tokensUnknown: 0,
    },
    "reviewer graph-review": {
      hedged: 1,
      won: 0,
      lost: 1,
      tokens: 0,
      tokensUnknown: 1,
    },
    "reviewer result-review": {
      hedged: 1,
      won: 1,
      lost: 0,
      tokens: 200,
      tokensUnknown: 0,
    },
  };
  const analysis = JSON.parse(
    cli(inst, "diagnostics", "72", "--analyze", "--json").out,
  );
  assert.deepEqual(analysis.hedges, expected);
  const text = cli(inst, "diagnostics", "72", "--analyze").out;
  assert.match(
    text,
    /Hedges by role and phase[^\n]*\n {2}planner diagnosis: 1 hedged · 0 won · 1 lost · 400 tokens in hedges\n {2}reviewer graph-review: 1 hedged · 0 won · 1 lost · 0 tokens in hedges \(1 unreported\)\n {2}reviewer result-review: 1 hedged · 1 won · 0 lost · 200 tokens in hedges\n/,
  );
  // A filter selects the calls counted.
  const filtered = JSON.parse(
    cli(
      inst,
      "diagnostics",
      "72",
      "--analyze",
      "--json",
      "--filter",
      "role=planner",
    ).out,
  );
  assert.deepEqual(Object.keys(filtered.hedges), ["planner diagnosis"]);
  const summary = JSON.parse(
    cli(inst, "diagnostics", "72", "--summary", "--json").out,
  );
  assert.deepEqual(summary.hedges, expected);
  assert.match(
    cli(inst, "diagnostics", "72", "--summary").out,
    /reviewer result-review: 1 hedged · 1 won · 0 lost/,
  );
});

test("a follow reads new run-log lines in bounded chunks, a line longer than a chunk included, and leaves a line still being written for the next read", () => {
  const logs = tempDir("factory-follow-");
  mkdirSync(join(logs, "7"));
  const run = "2026-01-01T00-00-00-000Z-1";
  const file = join(logs, "7", `${run}.jsonl`);
  const line = (n, pad = "") =>
    `${JSON.stringify({ at: new Date(Date.UTC(2026, 0, 1) + n).toISOString(), n, pad })}\n`;
  // About 3 MiB over many 1 MiB chunks, with a 2.5 MiB line among them.
  const lines = Array.from({ length: 3000 }, (_, n) =>
    line(n, n === 1500 ? "y".repeat(2.5 * 1024 ** 2) : "x".repeat(1000)),
  );
  const partial = line(3000);
  writeFileSync(file, lines.join("") + partial.slice(0, 20));
  const offsets = new Map();
  const first = readNew(logs, 7, offsets);
  assert.deepEqual(
    first.map((event) => event.n),
    lines.map((_, n) => n),
  );
  assert.equal(first[1500].pad.length, 2.5 * 1024 ** 2);
  assert.equal(first[0].run, run);
  assert.equal(offsets.get(file), statSync(file).size - 20);
  // The rest of the line lands: the next read has it, and only it.
  appendFileSync(file, partial.slice(20));
  assert.deepEqual(
    readNew(logs, 7, offsets).map((event) => event.n),
    [3000],
  );
  assert.equal(offsets.get(file), statSync(file).size);
  assert.deepEqual(readNew(logs, 7, offsets), []);
});

test("log rotation carries on past a run it can't remove, and records each removed run once", {
  // Root removes the read-only directory's file anyway.
  skip: process.getuid?.() === 0,
}, () => {
  const logs = tempDir("factory-rotate-");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const runs = ["a", "b", "c"].map((name) => `2026-01-01T00-00-0${name}`);
  for (const issue of ["8", "9"]) {
    mkdirSync(join(logs, issue));
    for (const run of runs) {
      writeFileSync(join(logs, issue, `${run}.jsonl`), "{}\n");
      utimesSync(join(logs, issue, `${run}.jsonl`), old, old);
    }
  }
  // #8's first run has a capture its directory doesn't let go of.
  const stuck = join(logs, "8", `${runs[0]}.captures`);
  mkdirSync(stuck);
  writeFileSync(join(stuck, "c.json"), "{}");
  chmodSync(stuck, 0o500);
  utimesSync(stuck, old, old);
  try {
    const all = { runsPerObjective: 0, totalBytes: 1 };
    for (let pass = 0; pass < 3; pass++) {
      const failed = rotateLogs(logs, undefined, all);
      assert.equal(failed.length, 1, "the capture, each pass");
    }
    assert.deepEqual(readdirSync(join(logs, "8")).sort(), [
      `${runs[0]}.captures`,
      "rotated",
    ]);
    assert.deepEqual(readdirSync(join(logs, "9")), ["rotated"]);
    // One record per run, however many passes found it still there.
    for (const issue of ["8", "9"])
      assert.deepEqual(
        readFileSync(join(logs, issue, "rotated"), "utf8")
          .trim()
          .split("\n")
          .map((record) => JSON.parse(record).run)
          .sort(),
        runs,
      );
    assert.deepEqual(
      rotatedRuns(logs, 8).map((record) => record.run),
      runs,
    );
  } finally {
    chmodSync(stuck, 0o700);
  }
});
