import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { machineRoom, slotHolders, slotsDir, takeSlot } from "../scripts/lib/machine.mjs";
import { Local } from "../scripts/local.mjs";
import { bootId } from "../scripts/lib/proc.mjs";
import { fakeProc } from "./fixtures/machine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GB = 2 ** 30;
const home = (stages = null) => {
  const dir = mkdtempSync(join(tmpdir(), "home-"));
  if (stages !== null) {
    mkdirSync(join(dir, ".cache", "pendulum"), { recursive: true });
    writeFileSync(join(dir, ".cache", "pendulum", "machine.json"), JSON.stringify({ stages }));
  }
  return dir;
};
const proc = (load) => fakeProc(mkdtempSync(join(tmpdir(), "proc-")), load);

test("machineRoom: the budget's free slots and the loop's cap; nothing new while saturated, but one stage for a loop holding none", () => {
  const calm = { cpuPsi: 0, memPsi: 0, load: 1, cpus: 24, memAvailable: 30 * GB };
  const busy = { ...calm, cpuPsi: 40 };
  assert.deepEqual(pick(machineRoom({ running: 0, cap: 5, budget: 5, held: 2, pressure: calm })), [3, false]);
  assert.deepEqual(pick(machineRoom({ running: 1, cap: 2, budget: 5, held: 1, pressure: calm })), [1, false]);
  assert.deepEqual(pick(machineRoom({ running: 2, cap: 5, budget: 5, held: 5, pressure: calm })), [0, false]);
  assert.match(machineRoom({ running: 2, cap: 5, budget: 5, held: 5, pressure: calm }).why, /5 of 5 stage\(s\) held on this machine/);
  assert.deepEqual(pick(machineRoom({ running: 1, cap: 5, budget: 5, held: 1, pressure: busy })), [0, false]);
  assert.match(machineRoom({ running: 1, cap: 5, budget: 5, held: 1, pressure: busy }).why, /the machine is saturated: CPU pressure 40%/);
  // A loop that holds none always starts one, saturated or with the budget full.
  assert.deepEqual(pick(machineRoom({ running: 0, cap: 5, budget: 5, held: 1, pressure: busy })), [1, true]);
  assert.deepEqual(pick(machineRoom({ running: 0, cap: 5, budget: 5, held: 5, pressure: calm })), [1, true]);
});
const pick = (r) => [r.room, r.force];

/** A process that takes one slot with the real takeSlot and holds it: resolves {child, taken} once it has tried. */
function holder(dir, budget, holderFields = {}) {
  const lib = pathToFileURL(join(here, "..", "scripts", "lib", "machine.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { takeSlot } from ${JSON.stringify(lib)}; const s = takeSlot({ dir: ${JSON.stringify(dir)}, budget: ${budget}, holder: ${JSON.stringify(holderFields)} }); process.stdout.write(s ? "taken\\n" : "full\\n"); setInterval(() => {}, 60000);`], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((ok, fail) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n")) ok({ child, taken: out.startsWith("taken") });
    });
    child.on("exit", (code) => fail(new Error(`holder exited ${code}`)));
  });
}
const killed = (child, sig = "SIGKILL") => new Promise((ok) => (child.removeAllListeners("exit"), child.on("exit", ok), child.kill(sig)));

test("slots: processes share the budget, and a holder killed with SIGKILL frees its slot for the next reader", async () => {
  const dir = slotsDir(home());
  const a = await holder(dir, 2, { repo: "o/a", issue: 1 });
  const b = await holder(dir, 2, { repo: "o/b", issue: 2 });
  const c = await holder(dir, 2, { repo: "o/c", issue: 3 });
  try {
    assert.deepEqual([a.taken, b.taken, c.taken], [true, true, false], "the third process finds the budget of 2 full");
    assert.deepEqual(slotHolders(dir).map((h) => [h.pid, h.repo, h.issue]), [[a.child.pid, "o/a", 1], [b.child.pid, "o/b", 2]]);
    assert.deepEqual(readdirSync(dir).sort(), ["0.0.json", "1.0.json"], "one file per slot, its first generation");
    await killed(a.child);
    assert.deepEqual(slotHolders(dir).map((h) => h.pid), [b.child.pid], "the killed holder's slot is gone");
    const d = await holder(dir, 2, { repo: "o/d", issue: 4 });
    assert.equal(d.taken, true, "its slot is free again");
    assert.deepEqual(slotHolders(dir).map((h) => [h.slot, h.pid]), [[0, d.child.pid], [1, b.child.pid]], "taken as the slot's next generation");
    assert.deepEqual(readdirSync(dir).sort(), ["0.1.json", "1.0.json"], "the killed holder's generation removed");
    await killed(d.child);
  } finally {
    for (const p of [a, b, c]) if (p.child.exitCode === null && p.child.signalCode === null) await killed(p.child);
  }
});


test("slots: a loop whose clock reads earlier than the holder's cannot take the slot it holds (#323)", () => {
  // A take stalled between reading the clock and writing its slot, or another process's clock behind this one's: either
  // way the later take reads an earlier time. Who holds a slot is the file system's to say, not a clock's.
  const dir = slotsDir(home());
  const held = takeSlot({ dir, budget: 1, holder: { repo: "o/a" } });
  const now = performance.now;
  performance.now = () => -1e9;
  let late;
  try {
    late = takeSlot({ dir, budget: 1, holder: { repo: "o/b" } });
  } finally {
    performance.now = now;
  }
  try {
    assert.equal(late, null, "the budget is full");
    assert.deepEqual(slotHolders(dir).map((h) => h.repo), ["o/a"]);
  } finally {
    late?.release();
    held.release();
  }
});

/** Budget 3 with slot 0 held, a forced slot 3 taken while 0-2 were full, and slots 1 and 2 let go since: 2 live. */
function forcedOverBudget() {
  const dir = slotsDir(home());
  const held = [0, 1, 2].map(() => takeSlot({ dir, budget: 3 }));
  const forced = takeSlot({ dir, budget: 3, force: true });
  assert.equal(forced.file, join(dir, "3.0.json"));
  held[1].release();
  held[2].release();
  assert.equal(slotHolders(dir).length, 2);
  return { dir, mine: [held[0], forced] };
}

test("slots: a forced slot above the budget counts when two loops take the free slots below it at once (#323)", () => {
  const { dir, mine } = forcedOverBudget();
  // Both count 2 live first; the other loop's whole take lands between this one's count and its take.
  let other = null;
  const late = takeSlot({ dir, budget: 3, afterCount: () => (other = takeSlot({ dir, budget: 3, holder: { repo: "o/other" } })) });
  try {
    assert.ok(other, "the first to land keeps its slot");
    assert.equal(late, null, "the one that lands after finds the budget over and lets its slot go");
    assert.deepEqual(slotHolders(dir).map((h) => h.slot), [0, 1, 3]);
  } finally {
    for (const s of [...mine, other, late]) s?.release();
  }
});

test("slots: a record from another boot, or a pid now running another process, holds nothing", () => {
  const dir = slotsDir(home());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0.0.json"), JSON.stringify({ pid: process.pid, start: "1", boot: "another-boot", repo: "o/a" }));
  writeFileSync(join(dir, "1.0.json"), JSON.stringify({ pid: process.pid, start: "1", boot: bootId(), repo: "o/a" }));
  assert.deepEqual(slotHolders(dir), []);
  const s = takeSlot({ dir, budget: 1, holder: { repo: "o/a" } });
  assert.ok(s);
  assert.equal(takeSlot({ dir, budget: 1, holder: { repo: "o/b" } }), null, "the budget is full");
  const forced = takeSlot({ dir, budget: 1, force: true, holder: { repo: "o/b" } });
  assert.ok(forced, "force takes one whatever the count");
  s.assign({ issue: 9, stage: "work" });
  assert.deepEqual(slotHolders(dir).map((h) => [h.slot, h.repo, h.issue ?? null, h.stage ?? null]), [[0, "o/a", 9, "work"], [1, "o/b", null, null]]);
  assert.deepEqual(readdirSync(dir).sort(), ["0.1.json", "1.1.json"], "each gone holder's slot taken as its next generation");
  s.release();
  assert.equal(takeSlot({ dir, budget: 1, holder: { repo: "o/c" } }), null, "a forced slot counts against the budget");
  forced.release();
  assert.deepEqual(slotHolders(dir), []);
  assert.deepEqual(readdirSync(dir).sort(), ["0.1.json", "1.1.json"], "a slot let go keeps its file, which says free");
  const again = takeSlot({ dir, budget: 1, holder: { repo: "o/c" } });
  assert.deepEqual(readdirSync(dir).sort(), ["0.2.json", "1.1.json"]);
  again.release();
});



test("run and review hold one slot of the machine's budget for each stage while it runs, whatever the machine holds, and none after it (#309)", async () => {
  const homeDir = home(1);
  const dir = slotsDir(homeDir);
  const other = takeSlot({ dir, budget: 1, holder: { repo: "o/x", issue: 4 } });
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const during = [];
    const loop = Object.assign(Object.create(Local.prototype), {
      repoFull: "o/r",
      wf: {},
      solo: "run",
      machine: { home: homeDir, proc: proc({}) },
      startStage: async (issue, name) => {
        during.push(slotHolders(dir).map((h) => [h.repo, h.issue, h.stage ?? null, h.cmd ?? null]).sort());
        return { exit: "delivered", stage: name };
      },
    });
    await loop.stage(12, "work", "worker.mjs", []);
    assert.deepEqual(during, [[["o/r", 12, "work", "run"], ["o/x", 4, null, null]]], "the stage holds a slot while it runs");
    assert.ok(lines.some((l) => /#12: the machine's budget is full \(1 of 1 stage\(s\) held on this machine\); one stage starts, as this loop holds none/.test(l)));
    assert.deepEqual(slotHolders(dir).map((h) => h.repo), ["o/x"], "and none once it ends: following the PR to its merge holds no slot");
    await assert.rejects(loop.stage.call(Object.assign(loop, { startStage: async () => { throw new Error("no clone"); } }), 12, "review", "review.mjs", []), /no clone/);
    assert.deepEqual(slotHolders(dir).map((h) => h.repo), ["o/x"], "a stage that fails to start lets its slot go");
  } finally {
    process.stdout.write = write;
    other.release();
  }
});
