import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessActivity } from "../scripts/lib/logic.mjs";
import { agentRoute, cpuTimeMs, hangVerdict, harnessHome, runReading } from "../scripts/lib/proc.mjs";

// A silent run is judged from its own state, never the silence (#388): the verdict from two readings of the run's
// processes, and the count of command items the harness's stream has open.
const line = (o) => JSON.stringify(o);
const started = line({ type: "item.started", item: { id: "i1", type: "command_execution", command: "pnpm test" } });
const completed = line({ type: "item.completed", item: { id: "i1", type: "command_execution", exit_code: 0 } });

test("harnessHome: a CLI's install directory, symlinks resolved: its npm package, else its own directory; never one of the system's command directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pendulum-home-"));
  try {
    const pkg = join(root, "lib", "node_modules", "@openai", "codex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "codex.js"), "");
    mkdirSync(join(root, "bin"));
    symlinkSync(join(pkg, "bin", "codex.js"), join(root, "bin", "codex"));
    const plain = join(root, "releases", "1.0", "bin");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "codex"), "");
    symlinkSync(join(plain, "codex"), join(root, "bin", "codex2"));
    const env = { PATH: join(root, "bin") };
    assert.deepEqual([harnessHome(join(root, "bin", "codex"), env), harnessHome(join(root, "bin", "codex2"), env), harnessHome(join(root, "none"), env)], [pkg, plain, null].map((p) => (p ? realpathSync(p) : null)));
    // A CLI in a directory of the system's own commands, or on PATH, or above one: no harness home.
    const sh = realpathSync("/bin/sh");
    assert.equal(harnessHome(sh, env), null, "a SAFE_PATH directory");
    assert.equal(harnessHome(join(root, "bin", "codex"), { PATH: `${join(pkg, "bin")}:${join(root, "bin")}` }), null, "a PATH directory inside it");
    writeFileSync(join(root, "bin", "tool"), "");
    assert.equal(harnessHome(join(root, "bin", "tool"), env), null, "a PATH directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReading and hangVerdict: what cannot be read decides nothing", async () => {
  const gone = spawn("true");
  await new Promise((r) => gone.on("exit", r));
  for (const procfs of [true, false]) assert.equal(await runReading(gone.pid, { procfs }), null, `procfs ${procfs}: a run not found is unknown, not idle`);
  assert.equal(await runReading(process.pid, { agent: { cgroup: "/sys/fs/cgroup/pendulum-no-such-cgroup" } }), null, "an agent's cgroup unread is unknown");
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
  assert.equal(agentRoute(["-n", "/usr/bin/env", "codex", "--", "--unit=pendulum-agent-x"]), null, "only systemd-run's own options name a unit");
  assert.deepEqual(agentRoute(["-n", "/usr/bin/unshare", "/bin/bash", "-c", "…", "pendulum-agent-wrap", "/home/a"]), { cgroup: "/sys/fs/cgroup/pendulum-agent" });
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
