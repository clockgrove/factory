// Telemetry and debugging: what the run log and its attempt files keep,
// and how diagnostics, watch and status show it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog, readRunFile, rotateLogs } from "../dist/log.js";
import { RunTally, statusComment } from "../dist/progress.js";
import { CodexStderr, logBoundary } from "../dist/providers/codex-boundary.js";
import {
  captureResponse,
  describeRequest,
  logUsage,
  tokens,
  usageRecord,
} from "../dist/providers/usage.js";
import { validateTree } from "../dist/validate.js";
import { ActivityLog } from "../dist/work/worker.js";
import {
  CLI,
  children,
  cli,
  closedPort,
  configured,
  installation,
  item,
  REPO,
  seed,
  serve,
  stopped,
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
  const worktree = mkdtempSync(join(tmpdir(), "factory-tree-"));
  const run = "2026-01-01T00-00-00-000Z-1";
  const log = new RunLog(inst.logs, run, CAPTURE_OFF, [SECRET]);
  const step = { step: "item:a:work", attemptId: "item:a:work#1" };
  log.write(61, { ...step, event: "start" });
  const activity = new ActivityLog(
    "a",
    worktree,
    (event) => log.write(61, { ...step, ...event }),
    [SECRET],
    log.runFile(61, "item:a:work#1.transcript"),
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
  const checkout = mkdtempSync(join(tmpdir(), "factory-validate-"));
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
      /#64 a review running for \S+ · reviewer result-review codex gpt-6\.1-sol high for \S+, 3 turns, context 84K\/272K/.test(
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

test("a Codex call's boundary telemetry: requests, responses, retries and a lost response.completed, from the pinned runtime's trace records", () => {
  const golden = readFileSync(
    new URL("./codex-0.160.0-stderr.golden", import.meta.url),
    "utf8",
  );
  const file = join(mkdtempSync(join(tmpdir(), "factory-codex-")), "stderr");
  // A call reads what came after it began: an earlier turn's lines are not its own.
  const read = (text, completed) => {
    writeFileSync(file, golden);
    const stderr = new CodexStderr(file);
    writeFileSync(file, `${golden}${text}`);
    return stderr.read(completed);
  };
  assert.equal(read("", true).boundary.coverage, "unavailable");
  const whole = read(`WARNING: an ordinary line\n${golden}`, true);
  assert.deepEqual(whole.boundary, {
    coverage: "observed",
    requests: 2,
    failedRequests: 0,
    connects: 1,
    responsesCompleted: 2,
    // The start-up warm-up's empty response is not a zero-output turn.
    zeroOutputResponses: 0,
    streamFailures: 0,
    retries: { http: 0, stream: 0 },
    retryDelayMs: 0,
    firstOutputMs: 5692,
    completionLost: false,
  });
  assert.equal(whole.ordinary, "WARNING: an ordinary line\n");
  // The stall: the final answer's request, a stream retry, and no response.completed.
  const lines = golden.trim().split("\n");
  const stalled = read(
    `${[
      ...lines.slice(0, -1),
      '2026-10-24T05:50:38.885453Z  INFO codex_otel.trace_safe: event.name="codex.retry" retry.layer=stream retry.operation=sampling retry.delay_ms=200 retry.attempt=1 event.timestamp=2026-10-24T05:50:38.885Z',
    ].join("\n")}\n`,
    false,
  );
  assert.equal(stalled.boundary.completionLost, true);
  assert.deepEqual(stalled.boundary.retries, { http: 0, stream: 1 });
  assert.deepEqual(stalled.retries, [
    {
      layer: "stream",
      operation: "sampling",
      delayMs: 200,
      attempt: 1,
      nativeAt: "2026-10-24T05:50:38.885Z",
    },
  ]);
  // Logged with its call, and summed by analysis.
  const inst = installation();
  const log = new RunLog(inst.logs, "2026-01-01T00-00-00-000Z-4");
  const record = {
    event: "model-usage",
    callId: "c2",
    role: "reviewer",
    provider: "codex",
    phase: "result-review",
    outcome: "error",
  };
  const write = (event) => log.write(65, { step: "item:a:review", ...event });
  writeFileSync(file, "");
  const stderr = new CodexStderr(file);
  writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
  logBoundary(record, write, stderr, false);
  write(record);
  const analysis = cli(inst, "diagnostics", "65", "--analyze");
  assert.match(
    analysis.out,
    /Codex boundary: observed in 1\/1 calls · 2 requests \(0 failed\) · 1 responses completed \(0 with no output\) · retries 0 HTTP, 0 stream \(0 s delay\) · 0 stream failures · 1 lost completions/,
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
