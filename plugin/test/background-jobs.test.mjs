import "./temp.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHarness } from "../scripts/lib/harness.mjs";
import { backgroundJobs } from "../scripts/lib/usage.mjs";

const line = (o) => JSON.stringify(o);
const job = { command: "pnpm run qualify:wave5 --out $TMPDIR/q5 > $TMPDIR/q5.log 2>&1", run_in_background: true, timeout: 7200000 };

// A stand-in for Claude Code (#440): a fresh session starts the qualification in the background (a real child, left
// running) and its process ends while the job runs, its notification never printed; FAKE_MODE=done prints the
// notification first, as Claude Code does once the job ends. A resumed session answers and ends, its cost the session's running total. Each call is kept.
const claude = `#!${process.execPath}
const fs = require("node:fs");
const dir = process.env.FAKE_STATE;
const input = fs.readFileSync(0, "utf8");
const n = fs.readdirSync(dir).filter((f) => f.startsWith("call-")).length + 1;
fs.writeFileSync(dir + "/call-" + n + ".json", JSON.stringify({ argv: process.argv.slice(2), input }));
const put = (o) => console.log(JSON.stringify(o));
put({ type: "system", subtype: "init", session_id: "s1" });
if (!process.argv.includes("--resume")) {
  put({ type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", id: "toolu_q", name: "Bash", input: ${line(job)} }], usage: { input_tokens: 1, output_tokens: 1 } } });
  put({ type: "system", subtype: "task_started", task_id: "bq5", tool_use_id: "toolu_q", description: "Run the full Wave 5 qualification", is_backgrounded: true, task_type: "local_bash", session_id: "s1" });
  const child = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(dir + "/job.pid", String(child.pid));
  put({ type: "user", session_id: "s1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", content: "running in the background" }] }, tool_use_result: { backgroundTaskId: "bq5" } });
  put({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "The qualification run is still in progress in the background." }], usage: { input_tokens: 1, output_tokens: 1 } } });
  if (process.env.FAKE_MODE === "done") put({ type: "system", subtype: "task_notification", task_id: "bq5", tool_use_id: "toolu_q", status: "completed", output_file: dir + "/bq5.output", summary: "completed (exit code 0)" });
}
put({ type: "result", subtype: "success", is_error: false, session_id: "s1", num_turns: 1, total_cost_usd: process.argv.includes("--resume") ? 0.5 : 0.25, usage: { input_tokens: 1, output_tokens: 1 } });
`;

async function pass(mode) {
  const bin = mkdtempSync(join(tmpdir(), "factory-bg-"));
  const state = join(bin, "state");
  mkdirSync(state);
  writeFileSync(join(bin, "claude"), claude, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const rec = await runHarness({ harness: "claude", model: "claude-opus-5-5", prompt: "the task card", maxUsd: 5, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH, FAKE_STATE: state, FAKE_MODE: mode }, timeoutMs: 120_000, label: "work-1" });
    const calls = readdirSync(state).filter((f) => f.startsWith("call-")).sort().map((f) => JSON.parse(readFileSync(join(state, f), "utf8")));
    return { rec, calls };
  } finally {
    process.env.PATH = path;
    const pid = existsSync(join(state, "job.pid")) ? Number(readFileSync(join(state, "job.pid"), "utf8")) : 0;
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
    rmSync(bin, { recursive: true, force: true });
  }
}

test("runHarness: a session that ended while its own background job still ran is resumed once to run the job again in the foreground", async () => {
  const { rec, calls } = await pass("pending");
  assert.equal(calls.length, 2, "the pass ran again");
  const [first, again] = calls;
  assert.equal(first.input, "the task card");
  assert.deepEqual(again.argv.slice(again.argv.indexOf("--resume"), again.argv.indexOf("--resume") + 2), ["--resume", "s1"], "the same session, resumed");
  // The resumed session is told which of its commands was stopped, by its own command line, and to run it in the foreground.
  assert.ok(again.input.includes(job.command) && again.input.includes("Run the full Wave 5 qualification"), again.input);
  assert.match(again.input, /in the foreground/);
  // One pass on the record: both runs' dollars, the rerun counted, the resumed run's own end (no job left).
  assert.deepEqual([rec.ok, rec.jobReruns, rec.usd, rec.backgroundJobs], [true, 1, 0.5, undefined]);
  // Inside the dollar cap: the resumed run gets what the first left (Claude Code's --max-budget-usd).
  assert.equal(again.argv[again.argv.indexOf("--max-budget-usd") + 1], "4.75");
});

test("runHarness: a background job whose end the stream reported leaves the pass as it ended", async () => {
  const { rec, calls } = await pass("done");
  assert.equal(calls.length, 1);
  assert.deepEqual([rec.ok, rec.jobReruns, rec.backgroundJobs], [true, undefined, undefined]);
});

test("backgroundJobs: only Claude's backgrounded commands with no end in the stream, a command moved to the background included", () => {
  const stream = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm e2e" } }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "pnpm build", run_in_background: true } }] } }),
    // A foreground command the process ended while it ran is no background job.
    line({ type: "system", subtype: "task_started", task_id: "f1", tool_use_id: "t1", description: "unit tests", is_backgrounded: false, task_type: "local_bash" }),
    // Moved to the background while it ran (its timeout), still running.
    line({ type: "system", subtype: "task_started", task_id: "m1", tool_use_id: "t2", description: "e2e", is_backgrounded: false, task_type: "local_bash" }),
    line({ type: "system", subtype: "task_updated", task_id: "m1", patch: { is_backgrounded: true } }),
    // Started in the background and ended.
    line({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t3", description: "build", is_backgrounded: true, task_type: "local_bash" }),
    line({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed" }),
    // A sub-agent is no command.
    line({ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "t9", description: "look", is_backgrounded: true, task_type: "local_agent" }),
  ].join("\n");
  assert.deepEqual(backgroundJobs("claude", stream), [{ id: "m1", description: "e2e", command: "pnpm e2e" }]);
  assert.deepEqual(backgroundJobs("codex", stream), []);
});
