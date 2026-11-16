import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRESSURE, defaultStages, loopCap, machineBudget, machineLimits, machineRoom, readPressure, saturation, slotHolders, slotsDir, takeSlot } from "../scripts/lib/machine.mjs";
import { machineChecks } from "../scripts/doctor.mjs";
import { Local } from "../scripts/local.mjs";
import { bootId, startTime } from "../scripts/lib/proc.mjs";
import { fakeProc } from "./fixtures/machine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GB = 2 ** 30;
const home = (stages = null) => {
  const dir = mkdtempSync(join(tmpdir(), "home-"));
  if (stages !== null) {
    mkdirSync(join(dir, ".cache", "factory"), { recursive: true });
    writeFileSync(join(dir, ".cache", "factory", "machine.json"), JSON.stringify({ stages }));
  }
  return dir;
};
const proc = (load) => fakeProc(mkdtempSync(join(tmpdir(), "proc-")), load);

test("machineBudget: the machine's own setting, else a quarter of its threads and at most one per 8 GB; a bad setting is named", () => {
  assert.equal(defaultStages({ cpus: 24, memBytes: 45 * GB }), 5);
  assert.equal(defaultStages({ cpus: 2, memBytes: 4 * GB }), 1);
  const none = machineBudget({ home: home(), cpus: 24, memBytes: 45 * GB });
  assert.deepEqual([none.stages, none.from, none.problem], [5, "default", undefined]);
  const set = machineBudget({ home: home(3), cpus: 24, memBytes: 45 * GB });
  assert.deepEqual([set.stages, set.from], [3, "setting"]);
  for (const bad of [0, -1, 2.5, "4"]) {
    const b = machineBudget({ home: home(bad), cpus: 24, memBytes: 45 * GB });
    assert.deepEqual([b.stages, b.from], [5, "default"], String(bad));
    assert.match(b.problem, /"stages" is not a positive whole number/);
  }
  // FACTORY_LOCAL_MAX_CONCURRENT is a per-loop cap below the budget, never above it (machineRoom).
  assert.equal(loopCap("2", 5), 2);
  assert.equal(loopCap(undefined, 5), 5);
  assert.equal(loopCap("nope", 5), 5);
});

test("readPressure and saturation: Linux CPU PSI over a minute where present, else load per CPU thread; MemAvailable and memory PSI", () => {
  // CPU is judged on PSI's avg60: a busy box idles at 9-13% on avg10, which swings across any threshold tick to tick.
  const box = readPressure({ root: proc({ cpu: 15, cpu10: 4, mem: 0, load: 23.5, availGb: 24 }), cpus: 24 });
  assert.deepEqual([box.cpuPsi, box.memPsi, box.load, box.memAvailable], [15, 0, 23.5, 24 * GB]);
  assert.equal(saturation(box).code, "cpu");
  assert.match(saturation(box).why, /CPU pressure 15% over a minute \(at least 15%\)/);
  assert.equal(saturation(readPressure({ root: proc({ cpu: 11, cpu10: 50, mem: 0 }), cpus: 24 })), null, "a 10-second spike over a calm minute holds nothing");
  assert.equal(saturation(readPressure({ root: proc({ cpu: 3, mem: 0, load: 23.5 }), cpus: 24 })), null, "with PSI, the load average is not judged");
  // No PSI: the load average against the CPU threads.
  const noPsi = (load) => readPressure({ root: proc({ cpu: null, mem: null, load }), cpus: 24 });
  assert.equal(noPsi(23.5).cpuPsi, null);
  assert.equal(saturation(noPsi(23.5)).code, "cpu");
  assert.equal(saturation(noPsi(10)), null);
  // Memory: less than 4 GB available, or memory pressure at its threshold.
  assert.equal(saturation(readPressure({ root: proc({ availGb: 2 }) })).code, "memory");
  assert.equal(saturation(readPressure({ root: proc({ mem: PRESSURE.memPsi }) })).code, "memory");
  assert.equal(saturation(readPressure({ root: proc({}) })), null);
});

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

/**
 * `n` processes that wait for one shared moment, then each take a slot of `budget` with the real takeSlot and hold what
 * they got: {child, taken} for each.
 */
function racers(dir, budget, n) {
  const lib = pathToFileURL(join(here, "..", "scripts", "lib", "machine.mjs")).href;
  const at = Date.now() + 700;
  return Promise.all(
    Array.from({ length: n }, () => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import { takeSlot } from ${JSON.stringify(lib)}; while (Date.now() < ${at}); const s = takeSlot({ dir: ${JSON.stringify(dir)}, budget: ${budget} }); process.stdout.write(s ? "taken\\n" : "full\\n"); setInterval(() => {}, 60000);`], { stdio: ["ignore", "pipe", "inherit"] });
      return new Promise((ok, fail) => {
        let out = "";
        child.stdout.on("data", (c) => ((out += c), out.includes("\n") && ok({ child, taken: out.startsWith("taken") })));
        child.on("exit", (code) => fail(new Error(`racer exited ${code}`)));
      });
    }),
  );
}

test("slots: loops taking the last slot at once leave exactly one of them holding it (#309, #323)", async () => {
  for (let round = 0; round < 8; round += 1) {
    const dir = slotsDir(home());
    // Odd rounds race for the last of a budget of 3, two slots held already (one of them let go and taken again).
    const budget = round % 2 ? 3 : 1;
    const mine = [];
    if (budget === 3) {
      mine.push(takeSlot({ dir, budget }), takeSlot({ dir, budget }));
      mine[0].release();
      mine[0] = takeSlot({ dir, budget });
    }
    const raced = await racers(dir, budget, 8);
    try {
      const taken = raced.filter((r) => r.taken);
      assert.equal(taken.length, 1, `round ${round}: one racer keeps the slot`);
      assert.deepEqual(slotHolders(dir).map((h) => h.pid).sort(), [...mine.map(() => process.pid), taken[0].child.pid].sort(), `round ${round}: the budget's holders`);
    } finally {
      for (const r of raced) await killed(r.child);
      for (const s of mine) s.release();
    }
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

test("slots: loops racing for the free slots below a forced one never go over the budget (#323)", async () => {
  for (let round = 0; round < 4; round += 1) {
    const { dir, mine } = forcedOverBudget();
    const raced = await racers(dir, 3, 8);
    try {
      assert.ok(raced.filter((r) => r.taken).length <= 1, `round ${round}: at most one racer keeps a slot`);
      assert.ok(slotHolders(dir).length <= 3, `round ${round}: the budget's holders`);
    } finally {
      for (const r of raced) await killed(r.child);
      for (const s of mine) s.release();
    }
  }
});

test("slots: a slot read while it keeps moving counts as held, and the slots after it are still counted (#323)", () => {
  const dir = slotsDir(home());
  mkdirSync(dir, { recursive: true });
  // Listed but never readable: what a slot whose next generation lands on every look shows its reader.
  symlinkSync(join(dir, "nowhere"), join(dir, "0.0.json"));
  const s = takeSlot({ dir, budget: 3, holder: { repo: "o/a" } });
  try {
    assert.deepEqual(slotHolders(dir).map((h) => [h.slot, h.repo ?? null]), [[0, null], [1, "o/a"]]);
    assert.match(machineChecks({ env: {}, local: true, home: dirname(dirname(dirname(dir))), proc: proc({}) }).find((r) => r.name === "machine slots").detail, /^2 of \d+ held: a holder whose record cannot be read yet \(.*0\.0\.json\); pid /);
  } finally {
    s.release();
  }
});

test("slots: a slot file that does not parse holds its slot for a few minutes, then frees it (#323)", () => {
  const dir = slotsDir(home());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0.0.json"), '{"pid": 12');
  assert.equal(slotHolders(dir).length, 1);
  assert.equal(takeSlot({ dir, budget: 1 }), null, "held while young");
  const old = (Date.now() - 6 * 60_000) / 1000;
  utimesSync(join(dir, "0.0.json"), old, old);
  assert.equal(slotHolders(dir).length, 0);
  const s = takeSlot({ dir, budget: 1 });
  assert.equal(s?.file, join(dir, "0.1.json"), "then free: taken as its next generation");
  s.release();
});

test("slots: a dot file is a killed writer's leftover only after ten minutes; a dead pid's one-file-per-holder slot is removed (#323)", () => {
  const dir = slotsDir(home());
  mkdirSync(dir, { recursive: true });
  const ago = (min) => (Date.now() - min * 60_000) / 1000;
  writeFileSync(join(dir, ".0.0.json.stalled"), "{}");
  utimesSync(join(dir, ".0.0.json.stalled"), ago(2), ago(2));
  writeFileSync(join(dir, ".0.0.json.killed"), "{}");
  utimesSync(join(dir, ".0.0.json.killed"), ago(11), ago(11));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(join(dir, `${dead}-0a1b2c.json`), JSON.stringify({ pid: dead }));
  writeFileSync(join(dir, `${process.pid}-0a1b2d.json`), JSON.stringify({ pid: process.pid, start: startTime(process.pid), boot: bootId() }));
  assert.deepEqual(slotHolders(dir), [], "neither layout's leftovers count");
  assert.deepEqual(readdirSync(dir).sort(), [`${process.pid}-0a1b2d.json`, ".0.0.json.stalled"].sort());
  assert.deepEqual(slotHolders(dir, { reap: false }), []);
});

test("slots: without a boot id, a recorded start time that differs from the pid's own means the holder is gone", () => {
  const dir = slotsDir(home());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0.0.json"), JSON.stringify({ pid: process.pid, start: "1", boot: null, repo: "o/a" }));
  writeFileSync(join(dir, "1.0.json"), JSON.stringify({ pid: process.pid, start: startTime(process.pid), boot: null, repo: "o/b" }));
  assert.deepEqual(slotHolders(dir).map((h) => h.repo), ["o/b"]);
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

/**
 * A GitHub for several repositories' Objectives, Queued until a dispatch labels them: `issues` is {"o/a": [1, 2]}. A
 * label write lands on the issue, so the next listing shows it Running.
 */
async function fakeGitHub(issues, { onList = () => {} } = {}) {
  const labels = new Map();
  for (const [repo, ns] of Object.entries(issues)) for (const n of ns) labels.set(`${repo}#${n}`, new Set(["factory:objective"]));
  const issue = (repo, n) => ({ number: n, title: "t", body: "", state: "open", labels: [...labels.get(`${repo}#${n}`)].map((name) => ({ name })), updated_at: new Date().toISOString() });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (url.pathname === "/graphql") return send(200, { data: {} });
      const m = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(\/labels(?:\/(.+))?)?)?$/.exec(url.pathname);
      const repo = m?.[1];
      if (m && !m[2] && req.method === "GET") {
        const want = url.searchParams.get("labels");
        if (want === "factory:objective") onList();
        return send(200, (issues[repo] || []).map((n) => issue(repo, n)).filter((i) => !want || i.labels.some((l) => l.name === want)));
      }
      const set = m?.[2] ? labels.get(`${repo}#${m[2]}`) : null;
      if (set && m[3] && req.method === "POST") {
        for (const l of JSON.parse(raw).labels) set.add(l);
        return send(200, []);
      }
      if (set && m[4] && req.method === "DELETE") return set.delete(decodeURIComponent(m[4])) ? send(200, []) : send(404, { message: "Not Found" });
      if (set && !m[3] && req.method === "GET") return send(200, issue(repo, Number(m[2])));
      return send(200, req.method === "GET" ? [] : {});
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

/**
 * A loop (fixtures/budget-loop.mjs) for `repo` in its own process: its output lines, whole, and `until(fn)` to wait on
 * them. A wait ends when its lines show what it waits for, or fails when the loop exits (it never does by itself) or
 * the test's `signal` ends the test; never on a clock of its own: a loaded machine only makes the loop slower (#411).
 */
function loopProcess({ repo, homeDir, procDir, api, cap = "", signal }) {
  const child = spawn(process.execPath, [join(here, "fixtures", "budget-loop.mjs")], { env: { ...process.env, HOME: homeDir, LOOP_REPO: repo, LOOP_PROC: procDir, GITHUB_API_URL: api, FACTORY_LOCAL_MAX_CONCURRENT: cap }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const waiters = new Set();
  const wake = () => {
    for (const w of waiters) w();
  };
  const onLine = (l) => {
    if (l) lines.push(l);
    wake();
  };
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", onLine);
  child.on("exit", wake);
  signal?.addEventListener("abort", wake, { once: true });
  const ended = () => (child.exitCode !== null || child.signalCode !== null ? `the loop exited (${child.exitCode ?? child.signalCode})` : signal?.aborted ? "the test ended" : null);
  const started = () => lines.filter((l) => l.startsWith(`started ${repo}#`)).length;
  const until = (fn, what) =>
    new Promise((ok, fail) => {
      const check = () => {
        const why = fn() ? "" : ended();
        if (why === null) return;
        waiters.delete(check);
        if (why) fail(new Error(`${repo}: ${why} while waiting for ${what}\n${lines.slice(-15).join("\n")}`));
        else ok();
      };
      waiters.add(check);
      check();
    });
  const ticks = () => lines.filter((l) => /tick: /.test(l)).length;
  return { child, lines, started, until, ticks, stop: () => (child.exitCode === null && child.signalCode === null ? killed(child) : Promise.resolve()) };
}

// The serve tests' timeout only ends a hung test (its loops then stop): each wait in it is on the loops' own lines.
test("serve: two loops of two repositories share one machine budget; a killed loop's slots free for the other (#309)", { timeout: 300_000 }, async (t) => {
  const homeDir = home(3);
  const procDir = proc({});
  const gh = await fakeGitHub({ "o/a": [1, 2], "o/b": [1, 2, 3] });
  // o/a's own cap (8) is above the budget: its start line names the cap it runs at, the budget's.
  const a = loopProcess({ repo: "o/a", homeDir, procDir, api: gh.url, cap: "8", signal: t.signal });
  let b = null;
  try {
    await a.until(() => a.started() === 2, "o/a to start both its Objectives");
    assert.ok(a.lines.some((l) => /this loop: at most 3, the budget \(FACTORY_LOCAL_MAX_CONCURRENT 8 is above it\)/.test(l)), "the start line states the cap the loop runs at");
    b = loopProcess({ repo: "o/b", homeDir, procDir, api: gh.url, signal: t.signal });
    await b.until(() => b.started() === 1, "o/b to start one");
    const from = b.ticks();
    await b.until(() => b.ticks() >= from + 3, "three more o/b ticks");
    assert.equal(b.started(), 1, "o/b starts only the budget's one free slot, not its own three");
    assert.ok(b.lines.some((l) => /the machine's budget is full \(3 of 3 stage\(s\) held on this machine\)/.test(l)), "its tick line says what holds the rest");
    assert.deepEqual(slotHolders(slotsDir(homeDir)).map((h) => h.repo).sort(), ["o/a", "o/a", "o/b"]);
    await a.stop();
    await b.until(() => b.started() === 3, "o/b to take the killed loop's slots");
    assert.deepEqual(slotHolders(slotsDir(homeDir)).map((h) => [h.repo, h.pid]), [1, 2, 3].map(() => ["o/b", b.child.pid]));
  } finally {
    await a.stop();
    await b?.stop();
    await gh.close();
  }
});

test("serve: a saturated machine holds new starts, said in the tick line, but a loop holding none starts one (#309)", { timeout: 300_000 }, async (t) => {
  const homeDir = home(5);
  const procDir = proc({ cpu: 50 });
  const gh = await fakeGitHub({ "o/c": [1, 2, 3] });
  const c = loopProcess({ repo: "o/c", homeDir, procDir, api: gh.url, signal: t.signal });
  try {
    await c.until(() => c.started() === 1, "the one stage a loop holding none starts");
    const from = c.ticks();
    await c.until(() => c.ticks() >= from + 3, "three more ticks");
    assert.equal(c.started(), 1, "nothing more starts while the machine is saturated");
    const held = c.lines.filter((l) => /tick: /.test(l)).slice(-1)[0];
    assert.match(held, /the machine is saturated: CPU pressure 50% over a minute \(at least 15%\)/);
    assert.equal(held.match(/saturated/g).length, 1, "said once in the line");
    fakeProc(procDir, { cpu: 1 });
    await c.until(() => c.started() === 3, "the rest once the load falls");
  } finally {
    await c.stop();
    await gh.close();
  }
});

test("#402: the machine's limits are machine.json's beside stages: when it counts as saturated and the no-reset guess; each one unset or unusable is the default, named", () => {
  const withFile = (data) => {
    const dir = home();
    mkdirSync(join(dir, ".cache", "factory"), { recursive: true });
    writeFileSync(join(dir, ".cache", "factory", "machine.json"), typeof data === "string" ? data : JSON.stringify(data));
    return dir;
  };
  const none = machineLimits({ home: home() });
  assert.deepEqual([none.pressure, none.guessMs, none.from, none.problems], [PRESSURE, [1, 4, 24].map((h) => h * 3600_000), { pressure: "default", guess: "default" }, []]);
  const set = machineLimits({ home: withFile({ stages: 3, pressure: { cpu_psi: 40, available_gb: 1.5 }, guess_hours: [0.5, 2] }) });
  assert.deepEqual(set.pressure, { ...PRESSURE, cpuPsi: 40, memAvailable: 1.5 * GB });
  assert.deepEqual(set.guessMs, [30 * 60_000, 2 * 3600_000]);
  assert.deepEqual([set.from, set.problems], [{ pressure: "setting", guess: "setting" }, []]);
  assert.deepEqual(machineBudget({ home: withFile({ pressure: { load: 2 } }), cpus: 24, memBytes: 45 * GB }).problem, undefined, "limits alone: the budget is the default, with nothing to name");
  const bad = machineLimits({ home: withFile({ pressure: { cpu_psi: 0, swap: 3, load: 2 }, guess_hours: [] }) });
  assert.deepEqual(bad.pressure, { ...PRESSURE, load: 2 }, "a usable limit beside unusable ones is taken");
  assert.equal(bad.guessMs, none.guessMs);
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems.join("\n"), /"pressure\.cpu_psi" is not a number above 0[\s\S]*"pressure" has no limit "swap"[\s\S]*"guess_hours" is not a list of hours/);
  assert.match(machineLimits({ home: withFile("{") }).problems[0], /is not JSON$/);
  const huge = machineLimits({ home: withFile({ guess_hours: [1, 1e10] }) });
  assert.deepEqual([huge.guessMs, huge.problems], [none.guessMs, [`${join(huge.file)}: "guess_hours" is not a list of hours, each above 0 and at most 192`]], "a step past the longest hold kept is named, never cut silently");
  assert.deepEqual(machineLimits({ home: withFile({ guess_hours: [192] }) }).guessMs, [192 * 3600_000]);
});

test("#402: a loop holds new starts by the machine's own pressure limits, and doctor prints the limits in force", () => {
  const busy = proc({ cpu: 20, availGb: 12 });
  const loopAt = (homeDir) => Object.assign(Object.create(Local.prototype), { repoFull: "o/r", wf: {}, machine: { home: homeDir, proc: busy } });
  const dflt = home(4);
  assert.equal(loopAt(dflt).machineBox(1).room, 0, "CPU pressure 20% is saturated at the default 15%");
  const relaxed = home();
  mkdirSync(join(relaxed, ".cache", "factory"), { recursive: true });
  writeFileSync(join(relaxed, ".cache", "factory", "machine.json"), JSON.stringify({ stages: 4, pressure: { cpu_psi: 30, available_gb: 8 }, guess_hours: [2, 8] }));
  const box = loopAt(relaxed).machineBox(1);
  assert.deepEqual([box.room, box.why], [3, null], "not at the machine's own 30%");
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
  const rows = by(machineChecks({ env: {}, local: true, home: relaxed, proc: busy }));
  assert.equal(rows["machine limits"].status, "PASS");
  assert.equal(rows["machine limits"].detail, `saturated at CPU pressure 30% over a minute (without PSI, a load of 0.9 per CPU thread), memory pressure 10%, or under 8.0 GB memory available; a usage limit with no reset passes its account over for 2 h, 8 h by how many in a row; the pressure limits from ${join(relaxed, ".cache", "factory", "machine.json")}, the guess from ${join(relaxed, ".cache", "factory", "machine.json")}`);
  assert.equal(rows["machine load"].status, "PASS", "doctor judges the load by the same limits");
  const dfltRows = by(machineChecks({ env: {}, local: true, home: dflt, proc: busy }));
  assert.match(dfltRows["machine limits"].detail, /^saturated at CPU pressure 15% over a minute .*under 4\.0 GB memory available; .* for 1 h, 4 h, 24 h by how many in a row; the pressure limits from Factory's defaults \(set them in .*\), the guess from Factory's default$/);
  // Without machine.json's guess_hours, the repository's setting is the one in force.
  const repoRows = by(machineChecks({ env: { FACTORY_GUESS_HOURS: "3, 9" }, local: true, home: dflt, proc: busy }));
  assert.match(repoRows["machine limits"].detail, /for 3 h, 9 h by how many in a row; .* the guess from the repository's FACTORY_GUESS_HOURS$/);
  assert.match(by(machineChecks({ env: { FACTORY_GUESS_HOURS: "3, 9" }, local: true, home: relaxed, proc: busy }))["machine limits"].detail, /for 2 h, 8 h by how many in a row/, "machine.json's wins on this machine");
  // The source is what a stage reads (serve's baseEnv): a value in this shell alone is no repository's.
  assert.match(by(machineChecks({ env: { FACTORY_GUESS_HOURS: "3, 9" }, settings: {}, local: true, home: dflt, proc: busy }))["machine limits"].detail, /for 1 h, 4 h, 24 h by how many in a row; .* the guess from Factory's default$/);
  assert.equal(dfltRows["machine load"].status, "WARN");
  const wrong = home();
  mkdirSync(join(wrong, ".cache", "factory"), { recursive: true });
  writeFileSync(join(wrong, ".cache", "factory", "machine.json"), JSON.stringify({ pressure: { cpu_psi: "high" } }));
  const warn = by(machineChecks({ env: {}, local: true, home: wrong, proc: busy }))["machine limits"];
  assert.equal(warn.status, "WARN");
  assert.match(warn.detail, /"pressure\.cpu_psi" is not a number above 0, so Factory's defaults stand for those; in force: saturated at CPU pressure 15%/);
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

test("serve: a review starts as soon as its slot is taken, never held idle through the dispatch (#309)", async () => {
  const homeDir = home(3);
  let reviewing = false;
  let seenAtList = null;
  const gh = await fakeGitHub({ "o/r": [1] }, { onList: () => (seenAtList ??= reviewing) });
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL };
  Object.assign(process.env, { GITHUB_API_URL: gh.url, FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" });
  try {
    const loop = Object.assign(Object.create(Local.prototype), {
      repo: { owner: "o", name: "r", full: "o/r" },
      repoFull: "o/r",
      token: "t",
      notice: null,
      wf: {},
      opts: { token: "t" },
      children: new Set(),
      machine: { home: homeDir, proc: proc({}) },
      baseEnv: () => ({ FACTORY_LOCAL_ALL: "1", FACTORY_INPUT_MAX_CONCURRENT: "9" }),
      cleanup: async () => {},
      pausedHere: async () => [],
      pendingReviews: async () => [{ issue: 5, pr: 9, labels: [] }],
      withClaim: (n, fn) => fn(),
      review: async () => {
        reviewing = true;
        return { exit: "delivered" };
      },
      runObjective: async () => ({ exit: "delivered" }),
    });
    await loop.serve({ once: true });
    assert.equal(seenAtList, true, "the review was running when the dispatcher read the Objectives");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await gh.close();
  }
});

test("doctor --local: the machine's budget, who holds its slots, and its load (#309)", async () => {
  const homeDir = home(4);
  const h = await holder(slotsDir(homeDir), 4, { repo: "o/a", issue: 7, stage: "work" });
  try {
    const rows = machineChecks({ env: {}, local: true, home: homeDir, proc: proc({ cpu: 30, availGb: 12 }) });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(by["machine budget"].status, "PASS");
    assert.match(by["machine budget"].detail, /^4 stage\(s\) at once on this machine, shared by every Factory loop here \(.*machine\.json\)$/);
    assert.equal(by["machine slots"].detail, `1 of 4 held: pid ${h.child.pid} o/a #7 work`);
    assert.equal(by["machine load"].status, "WARN");
    assert.match(by["machine load"].detail, /^CPU pressure 30% over a minute, memory pressure 0%, 12\.0 GB memory available: saturated/);
    assert.equal(by.FACTORY_LOCAL_MAX_CONCURRENT, undefined, "no cap set: no warning");
    const over = machineChecks({ env: { FACTORY_LOCAL_MAX_CONCURRENT: "8" }, local: true, home: homeDir, proc: proc({}) });
    const warn = over.find((r) => r.name === "FACTORY_LOCAL_MAX_CONCURRENT");
    assert.equal(warn?.status, "WARN", "a loop cap above the budget is named");
    assert.match(warn.detail, /^8 is above this machine's stage budget of 4/);
    assert.ok(warn.fix.includes(join(homeDir, ".cache", "factory", "machine.json")), "the fix names machine.json");
    assert.equal(machineChecks({ env: { FACTORY_LOCAL_MAX_CONCURRENT: "4" }, local: true, home: homeDir, proc: proc({}) }).some((r) => r.name === "FACTORY_LOCAL_MAX_CONCURRENT"), false);
    assert.deepEqual(machineChecks({ env: { GITHUB_ACTIONS: "true" }, local: true, home: homeDir }), [], "not inside a job");
    const bad = machineChecks({ env: {}, local: true, home: home("x"), proc: proc({}) });
    assert.equal(bad[0].status, "WARN");
    assert.equal(bad[2].status, "PASS");
    assert.ok(existsSync(join(slotsDir(homeDir), readdirSync(slotsDir(homeDir))[0])), "doctor removes no slot");
  } finally {
    await killed(h.child);
  }
});
