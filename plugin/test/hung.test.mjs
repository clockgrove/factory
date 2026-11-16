import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessActivity } from "../scripts/lib/logic.mjs";
import { readFileSync } from "node:fs";
import { agentRoute, cpuTimeMs, exec, hangVerdict, runReading } from "../scripts/lib/proc.mjs";
import { runHarness } from "../scripts/lib/harness.mjs";

// A silent run is judged from its own state, never the silence (#388). The window here is short; every process is real:
// harness-like children that print the stream's items and start commands as a harness does (their stdout a pipe of
// their own, not the run's), busy, asleep, reading, or waiting on a socket.
const WINDOW = 300;
const busy = (ms) => `const end = Date.now() + ${ms}; while (Date.now() < end);`;
const line = (o) => JSON.stringify(o);
const started = line({ type: "item.started", item: { id: "i1", type: "command_execution", command: "pnpm test" } });
const completed = line({ type: "item.completed", item: { id: "i1", type: "command_execution", exit_code: 0 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A harness-like script: prints the open item, runs `command` (spawnSync: it waits, using nothing), closes the item. */
const harnessRunning = (command) => `console.log(${JSON.stringify(started)}); require("node:child_process").spawnSync(${JSON.stringify(command[0])}, ${JSON.stringify(command.slice(1))}); console.log(${JSON.stringify(completed)});`;
const run = (script, opts = {}) => {
  const a = harnessActivity();
  return exec(process.execPath, ["-e", script], { idleMs: WINDOW, onLine: a.feed, openItems: a.open, fileStdio: true, group: true, ...opts });
};

test("exec: an open command item whose command works silently (CPU) keeps the run", async () => {
  const r = await run(harnessRunning([process.execPath, "-e", busy(WINDOW * 4)]));
  assert.deepEqual([r.code, r.idle], [0, false]);
});

test("exec: an open command item whose command reads slowly at no CPU (a download, a pipe) keeps the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-fifo-"));
  const fifo = join(dir, "feed");
  execFileSync("mkfifo", [fifo]);
  // The bytes come from outside the run, a few at a time, as a download's would.
  const feed = spawn(process.execPath, ["-e", `const fs = require("node:fs"); const fd = fs.openSync(${JSON.stringify(fifo)}, "w"); setInterval(() => fs.writeSync(fd, "x"), 50);`], { stdio: "ignore" });
  try {
    const r = await run(`console.log(${JSON.stringify(started)}); require("node:child_process").spawnSync("dd", ["bs=1", "count=30", "status=none", ${JSON.stringify(`if=${fifo}`)}]); console.log(${JSON.stringify(completed)});`);
    assert.deepEqual([r.code, r.idle], [0, false]);
  } finally {
    feed.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exec: an open command item whose command uses no CPU and does no I/O is hung", async () => {
  const r = await run(harnessRunning(["sleep", "60"]));
  assert.deepEqual([r.idle, r.idleOpen, !!r.signal], [true, 1, true]);
});

// A harness waiting on its model with no command open: its own timers use CPU and it reads its own files (an idle Claude
// Code reads ~157 KB a minute), so only the answer's own lines tell a live stream from a stalled one.
const delta = line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } });
const waiting = (deltas) => `let n = 0; const t = setInterval(() => { if (n++ < ${deltas}) console.log(${JSON.stringify(delta)}); }, 50); const fs = require("node:fs"); const fd = fs.openSync(process.execPath, "r"); const buf = Buffer.alloc(65536); setInterval(() => { let x = 0; for (let i = 0; i < 2e6; i++) x += i; fs.readSync(fd, buf, 0, buf.length, 0); }, 20); setTimeout(() => process.exit(0), ${WINDOW * 8});`;

test("exec: with no item open, a harness that streams its answer is hung once the stream stalls, whatever its CPU and reads", async () => {
  const seen = [];
  const r = await exec(process.execPath, ["-e", `console.log(${JSON.stringify(line({ type: "system", subtype: "init" }))}); ${waiting(WINDOW / 50 * 3)}`], { idleMs: WINDOW, answerStreams: true, dropLine: (l) => JSON.parse(l).type === "stream_event", onLine: (l) => seen.push(l), fileStdio: true });
  assert.deepEqual([r.idle, r.idleOpen, !!r.signal], [true, 0, true]);
  assert.deepEqual([seen.length, r.stdout], [1, `${seen[0]}\n`], "the deltas count as output and go no further");
  // A harness that streams no answer (Codex: it ends a stalled stream itself): the silence decides nothing.
  const codex = await exec(process.execPath, ["-e", waiting(0)], { idleMs: WINDOW, fileStdio: true });
  assert.deepEqual([codex.code, codex.idle], [0, false]);
});

test("exec: a command that left the run's group and tree (setsid, double fork) is found by the run's tag", async () => {
  // The command's shell sleeps; only its escaped child, reparented away from it, works meanwhile.
  const escaped = `(setsid ${JSON.stringify(process.execPath)} -e ${JSON.stringify(busy(WINDOW * 5))} >/dev/null 2>&1 &); exec sleep ${(WINDOW * 4) / 1000}`;
  const r = await run(harnessRunning(["sh", "-c", escaped]));
  assert.deepEqual([r.code, r.idle], [0, false]);
});

// On a runner the harness runs as the agent in a systemd unit of its own (proc.mjs asAgent): systemd starts it, outside
// the tree of the systemd-run client Factory waits on. A user manager's unit stands in for the system's here.
const userSystemd = (() => {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
test("exec: a run in an agent's systemd unit is read from the unit's cgroup, its harness told from its commands", { skip: !userSystemd && "no systemd user manager here" }, async () => {
  const unit = `factory-agent-hung${process.pid}`;
  const args = ["--user", "--quiet", "--wait", "--collect", "--pipe", `--unit=${unit}`, "--", process.execPath, "-e", harnessRunning([process.execPath, "-e", busy(WINDOW * 4)])];
  assert.deepEqual(agentRoute(args), { unit: { name: unit, user: true } });
  const a = harnessActivity();
  const r = await exec("systemd-run", args, { idleMs: WINDOW, onLine: a.feed, openItems: a.open, fileStdio: true });
  assert.deepEqual([r.code, r.idle], [0, false], r.stderr);
});

test("runReading: /proc, and ps with lsof, find a run's harness and its commands and read their CPU and I/O", async () => {
  for (const procfs of [true, false]) {
    // The harness's stdout is its own; its command's is not (as a harness captures what its commands print).
    const command = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(busy(15_000))}], { stdio: "ignore" }); setTimeout(() => {}, 15_000);`;
    const child = spawn(process.execPath, ["-e", command], { stdio: ["ignore", "pipe", "ignore"] });
    await wait(200);
    const before = await runReading(child.pid, { procfs });
    const roles = [...before.procs.values()].map((p) => [p.pid === child.pid, p.role]);
    assert.deepEqual(roles.sort(), [[false, "command"], [true, "harness"]], `procfs ${procfs}`);
    assert.equal(before.ioRead, procfs);
    // ps reads CPU time in whole seconds on Linux (procps): read until the command's first second shows.
    let after = before;
    while (hangVerdict(before, after, { open: 1 }) !== false && child.exitCode === null) {
      await wait(200);
      after = await runReading(child.pid, { procfs });
    }
    assert.equal(hangVerdict(before, after, { open: 1 }), false, `procfs ${procfs}: the command's CPU is counted`);
    for (const p of after.procs.values()) process.kill(p.pid, "SIGKILL");
  }
});

test("runReading and hangVerdict: what cannot be read decides nothing", async () => {
  const gone = spawn("true");
  await new Promise((r) => gone.on("exit", r));
  for (const procfs of [true, false]) assert.equal(await runReading(gone.pid, { procfs }), null, `procfs ${procfs}: a run not found is unknown, not idle`);
  assert.equal(await runReading(process.pid, { agent: { cgroup: "/sys/fs/cgroup/factory-no-such-cgroup" } }), null, "an agent's cgroup unread is unknown");
  const reading = (procs, ioRead = true) => ({ procs: new Map(procs.map((p, i) => [`${i}:1`, p])), ioRead });
  const harness = { pid: 1, ppid: 0, cpu: 5, io: { rchar: 10, wchar: 0 }, role: "harness" };
  const command = { pid: 2, ppid: 1, cpu: 5, io: { rchar: 10, wchar: 0 }, role: "command" };
  const r = reading([harness, command]);
  assert.deepEqual([hangVerdict(null, r, { open: 1 }), hangVerdict(r, null, { open: 1 }), hangVerdict(r, r, { heard: true, open: 1 })], [null, null, false]);
  assert.equal(hangVerdict(r, r, { open: 1 }), true, "an open command with no progress is hung");
  assert.deepEqual([hangVerdict(null, null, { streams: true }), hangVerdict(r, r)], [true, null], "no command open: a streaming harness's silence decides, readings or not; another's cannot");
  const unreadCommand = reading([harness, { ...command, io: null }]);
  assert.equal(hangVerdict(unreadCommand, unreadCommand, { open: 1 }), null, "a command whose I/O cannot be read");
  const unclassified = reading([harness, { ...command, role: null }]);
  assert.equal(hangVerdict(unclassified, unclassified, { open: 1 }), null, "a process that cannot be classified");
  assert.equal(hangVerdict(reading([harness]), reading([harness]), { open: 1 }), null, "an item open with no command process (a sub-agent)");
  const macos = reading([{ ...harness, io: null }, { ...command, io: null }], false);
  assert.equal(hangVerdict(macos, macos, { open: 1 }), true, "without I/O counts the command's CPU decides");
  assert.equal(agentRoute(["-n", "/usr/bin/env", "codex", "--", "--unit=factory-agent-x"]), null, "only systemd-run's own options name a unit");
  assert.deepEqual(agentRoute(["-n", "/usr/bin/unshare", "/bin/bash", "-c", "…", "factory-agent-wrap", "/home/a"]), { cgroup: "/sys/fs/cgroup/factory-agent" });
  assert.deepEqual(["00:01:02", "1:02.03", "1-00:00:00", "0:00.5", "x"].map(cpuTimeMs), [62_000, 62_030, 86_400_000, 500, null]);
});

test("harnessActivity: open() counts each open command item once, a Claude sub-agent's task included", () => {
  const a = harnessActivity();
  a.feed(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: { description: "look" } }] } }));
  a.feed(line({ type: "system", subtype: "task_started", task_id: "k1", task_type: "local_agent", description: "look" }));
  assert.equal(a.open(), 1);
  a.feed(line({ type: "system", subtype: "task_started", task_id: "k2", task_type: "local_bash", description: "server" }));
  a.feed(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }));
  assert.equal(a.open(), 1, "the background shell");
  a.feed(line({ type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash" } }));
  a.feed(started);
  assert.equal(a.open(), 3);
  a.feed(completed);
  a.feed(line({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true } }));
  assert.equal(a.open(), 1);
});

test("runHarness: a Codex pass silent while its open command works is kept; one whose open command sleeps is killed as hung", async () => {
  const bin = mkdtempSync(join(tmpdir(), "factory-hung-"));
  const codex = (command) => `#!${process.execPath}
const put = (o) => console.log(JSON.stringify(o));
put({ type: "thread.started", thread_id: "t1" });
put({ type: "turn.started" });
console.log(${JSON.stringify(started)});
require("node:child_process").spawnSync(${JSON.stringify(command[0])}, ${JSON.stringify(command.slice(1))});
console.log(${JSON.stringify(completed)});
put({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "done" } });
put({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
`;
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const pass = () => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work", idleMs: WINDOW });
  try {
    writeFileSync(join(bin, "codex"), codex([process.execPath, "-e", busy(WINDOW * 4)]), { mode: 0o755 });
    const kept = await pass();
    assert.deepEqual([kept.ok, kept.idle, kept.finalText], [true, false, "done"], kept.error);
    writeFileSync(join(bin, "codex"), codex(["sleep", "10"]), { mode: 0o755 });
    const hung = await pass();
    assert.equal(hung.idle, true);
    assert.match(hung.error, /^hung: no output for \d+ min with 1 command item open and no CPU or I\/O by its commands; killed$/);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("runHarness: a Claude pass streams its answer (--include-partial-messages) and is killed as hung when it stalls with no command open; the deltas stay out of its record", async () => {
  const bin = mkdtempSync(join(tmpdir(), "factory-hung-claude-"));
  const events = join(bin, "usage", "events.jsonl");
  const claude = `#!${process.execPath}
if (!process.argv.includes("--include-partial-messages")) process.exit(3);
console.log(${JSON.stringify(line({ type: "system", subtype: "init", session_id: "s1" }))});
console.log(${JSON.stringify(line({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "thinking" }], usage: { input_tokens: 1, output_tokens: 1 } } }))});
${waiting(WINDOW / 50 * 2)}
`;
  writeFileSync(join(bin, "claude"), claude, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const rec = await runHarness({ harness: "claude", model: "claude-opus-5-5", prompt: "p", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work", idleMs: WINDOW, eventsFile: events });
    assert.equal(rec.idle, true, rec.error);
    assert.match(rec.error, /^hung: no output for \d+ min with no command open, so its model stream stalled; killed$/);
    assert.ok(!rec.stdoutTail.includes("stream_event") && rec.stdoutTail.includes('"assistant"'), rec.stdoutTail);
    const kept = readFileSync(events, "utf8");
    assert.ok(!kept.includes("stream_event") && kept.includes('"assistant"'), "the events file keeps no deltas");
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});
