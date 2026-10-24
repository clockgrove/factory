// Telemetry and debugging: what the run log and its attempt files keep,
// and how diagnostics, watch and status show it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPTURE_OFF, RunLog, readRunFile, rotateLogs } from "../dist/log.js";
import { ActivityLog } from "../dist/work/worker.js";
import { CLI, cli, installation, REPO } from "./helpers.mjs";

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
