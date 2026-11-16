import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessActivity } from "../scripts/lib/logic.mjs";
import { agentUnit, cpuTimeMs, cpuUsed, exec, runCpu } from "../scripts/lib/proc.mjs";
import { runHarness } from "../scripts/lib/harness.mjs";

// A silent run is hung only when none of its processes used CPU across a whole window (#388). The window here is short;
// the children are real: one busy, one asleep, one behind an open command item.
const WINDOW = 300;
const busy = (ms) => `const end = Date.now() + ${ms}; while (Date.now() < end);`;
const line = (o) => JSON.stringify(o);
const started = line({ type: "item.started", item: { id: "i1", type: "command_execution", command: "pnpm test" } });
const completed = line({ type: "item.completed", item: { id: "i1", type: "command_execution", exit_code: 0 } });

test("exec: a child that prints nothing but uses CPU across every window runs to its end", async () => {
  const r = await exec(process.execPath, ["-e", busy(WINDOW * 4)], { idleMs: WINDOW });
  assert.deepEqual([r.code, r.idle, !!r.signal], [0, false, false]);
});

test("exec: a child that prints nothing and uses no CPU across a window is killed as hung", async () => {
  const r = await exec("sh", ["-c", "echo x; exec sleep 60"], { idleMs: WINDOW, fileStdio: true });
  assert.deepEqual([r.idle, r.idleOpen, r.stdout, !!r.signal], [true, 0, "x\n", true]);
});

test("exec: an open command item whose command is busy keeps a silent run; one whose command is idle is hung", async () => {
  // The harness waits on its command (as a harness does, using no CPU itself) while the command, its child, works.
  const run = (command) => `console.log(${JSON.stringify(started)}); require("node:child_process").spawnSync(${JSON.stringify(command[0])}, ${JSON.stringify(command.slice(1))}); console.log(${JSON.stringify(completed)});`;
  const working = harnessActivity();
  const r = await exec(process.execPath, ["-e", run([process.execPath, "-e", busy(WINDOW * 4)])], { idleMs: WINDOW, onLine: working.feed, openItems: working.open, fileStdio: true });
  assert.deepEqual([r.code, r.idle, working.open()], [0, false, 0]);
  const stuck = harnessActivity();
  const h = await exec(process.execPath, ["-e", run(["sleep", "60"])], { idleMs: WINDOW, onLine: stuck.feed, openItems: stuck.open, fileStdio: true, group: true });
  assert.deepEqual([h.idle, h.idleOpen, !!h.signal], [true, 1, true]);
});

test("exec: a group run's busy process that left its group and tree (setsid, double fork) is found by the run's tag", async () => {
  // The leader sleeps and exits; only the escaped process, reparented away from it, uses CPU meanwhile.
  const escaped = `(setsid ${JSON.stringify(process.execPath)} -e ${JSON.stringify(busy(WINDOW * 5))} &); exec sleep ${(WINDOW * 4) / 1000}`;
  const r = await exec("sh", ["-c", escaped], { idleMs: WINDOW, group: true });
  assert.deepEqual([r.code, r.idle], [0, false]);
});

// On a runner the harness runs as the agent in a systemd unit of its own (proc.mjs asAgent): systemd starts its process,
// outside the tree of the systemd-run client Factory waits on. A user manager's unit stands in for the system's here.
const userSystemd = (() => {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
test("exec: a run in an agent's systemd unit is read from the unit's cgroup, not the client's process tree", { skip: !userSystemd && "no systemd user manager here" }, async () => {
  const unit = `factory-agent-hung${process.pid}`;
  const args = ["--user", "--quiet", "--wait", "--collect", "--pipe", `--unit=${unit}`, "--", process.execPath, "-e", busy(WINDOW * 4)];
  assert.deepEqual(agentUnit(args), { name: unit, user: true });
  const r = await exec("systemd-run", args, { idleMs: WINDOW });
  assert.deepEqual([r.code, r.idle], [0, false], r.stderr);
});

test("runCpu: /proc and ps read a run's CPU, its descendants' included; a sleeping run uses none", async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const procfs of [true, false]) {
    const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });
    const a = runCpu(sleeper.pid, { procfs });
    await wait(400);
    assert.deepEqual([a.size, cpuUsed(a, runCpu(sleeper.pid, { procfs }))], [1, 0], `procfs ${procfs}: a sleeping run uses no CPU`);
    sleeper.kill("SIGKILL");
    // The work is a grandchild; ps reads CPU time in whole seconds on Linux (procps), so it is read until its first
    // second shows, while it still works.
    const child = spawn("sh", ["-c", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(busy(6000))}; true`], { stdio: "ignore" });
    await wait(100);
    const before = runCpu(child.pid, { procfs });
    let after = before;
    for (let i = 0; i < 25 && !(cpuUsed(before, after) > 0); i++) {
      await wait(200);
      after = runCpu(child.pid, { procfs });
    }
    assert.deepEqual([after.size, cpuUsed(before, after) > 0], [2, true], `procfs ${procfs}: the busy grandchild's CPU is counted`);
    for (const k of after.keys()) process.kill(Number(k.split(":")[0]), "SIGKILL");
  }
  assert.equal(cpuUsed(null, new Map()), null, "an unread reading decides nothing");
  assert.equal(runCpu(process.pid, { cgroup: "/factory-no-such-cgroup" }), null, "nor does a unit's cgroup that cannot be read");
  assert.equal(agentUnit(["-n", "/usr/bin/env", "codex", "--", "--unit=factory-agent-x"]), null, "only systemd-run's own options name a unit");
  assert.deepEqual(["00:01:02", "1:02.03", "1-00:00:00", "0:00.5", "x"].map(cpuTimeMs), [62_000, 62_030, 86_400_000, 500, null]);
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
    assert.match(hung.error, /^hung: no output and no CPU used by its processes for \d+ min with 1 command item open; killed$/);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});
