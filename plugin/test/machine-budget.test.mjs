import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRESSURE, defaultStages, loopCap, machineBudget, machineRoom, readPressure, saturation, slotHolders, slotsDir, takeSlot } from "../scripts/lib/machine.mjs";
import { machineChecks } from "../scripts/doctor.mjs";
import { Local } from "../scripts/local.mjs";
import { bootId } from "../scripts/lib/proc.mjs";
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

test("readPressure and saturation: Linux PSI where present, else load per CPU thread; MemAvailable and memory PSI", () => {
  // The Clockgrove box on 2026-11-15 at 00:43: CPU pressure 11%, 24 GB available: saturated on CPU.
  const box = readPressure({ root: proc({ cpu: 11, mem: 0, load: 23.5, availGb: 24 }), cpus: 24 });
  assert.deepEqual([box.cpuPsi, box.memPsi, box.load, box.memAvailable], [11, 0, 23.5, 24 * GB]);
  assert.equal(saturation(box).code, "cpu");
  assert.match(saturation(box).why, /CPU pressure 11% \(at least 10%\)/);
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
    await killed(a.child);
    assert.deepEqual(slotHolders(dir).map((h) => h.pid), [b.child.pid], "the killed holder's slot is gone");
    assert.equal(readdirSync(dir).length, 1, "and its file removed");
    const d = await holder(dir, 2, { repo: "o/d", issue: 4 });
    assert.equal(d.taken, true, "its slot is free again");
    await killed(d.child);
  } finally {
    for (const p of [a, b, c]) if (p.child.exitCode === null && p.child.signalCode === null) await killed(p.child);
  }
});

test("slots: a record from another boot, or a pid now running another process, holds nothing", () => {
  const dir = slotsDir(home());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1-old.json"), JSON.stringify({ pid: process.pid, start: "1", boot: "another-boot", repo: "o/a" }));
  writeFileSync(join(dir, "2-reused.json"), JSON.stringify({ pid: process.pid, start: "1", boot: bootId(), repo: "o/a" }));
  assert.deepEqual(slotHolders(dir), []);
  assert.deepEqual(readdirSync(dir), []);
  const s = takeSlot({ dir, budget: 1, holder: { repo: "o/a" } });
  assert.ok(s);
  assert.equal(takeSlot({ dir, budget: 1, holder: { repo: "o/b" } }), null, "the budget is full");
  const forced = takeSlot({ dir, budget: 1, force: true, holder: { repo: "o/b" } });
  assert.ok(forced, "force takes one whatever the count");
  s.assign({ issue: 9, stage: "work" });
  assert.deepEqual(slotHolders(dir).map((h) => [h.repo, h.issue ?? null, h.stage ?? null]).sort(), [["o/a", 9, "work"], ["o/b", null, null]]);
  s.release();
  forced.release();
  assert.deepEqual(readdirSync(dir), []);
});

/**
 * A GitHub for several repositories' Objectives, Queued until a dispatch labels them: `issues` is {"o/a": [1, 2]}. A
 * label write lands on the issue, so the next listing shows it Running.
 */
async function fakeGitHub(issues) {
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

/** A loop (fixtures/budget-loop.mjs) for `repo` in its own process: its output lines, and `until(fn)` to wait on them. */
function loopProcess({ repo, homeDir, procDir, api }) {
  const child = spawn(process.execPath, [join(here, "fixtures", "budget-loop.mjs")], { env: { ...process.env, HOME: homeDir, LOOP_REPO: repo, LOOP_PROC: procDir, GITHUB_API_URL: api, FACTORY_LOCAL_MAX_CONCURRENT: "" }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const waiters = new Set();
  const onData = (c) => {
    lines.push(...String(c).split("\n").filter(Boolean));
    for (const w of waiters) w();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const started = () => lines.filter((l) => l.startsWith(`started ${repo}#`)).length;
  const until = (fn, what, ms = 20_000) =>
    new Promise((ok, fail) => {
      const t = setTimeout(() => (waiters.delete(check), fail(new Error(`${repo}: timed out waiting for ${what}\n${lines.slice(-15).join("\n")}`))), ms);
      const check = () => {
        if (!fn()) return;
        clearTimeout(t);
        waiters.delete(check);
        ok();
      };
      waiters.add(check);
      check();
    });
  const ticks = () => lines.filter((l) => /tick: /.test(l)).length;
  return { child, lines, started, until, ticks, stop: () => (child.exitCode === null && child.signalCode === null ? killed(child) : Promise.resolve()) };
}

test("serve: two loops of two repositories share one machine budget; a killed loop's slots free for the other (#309)", async () => {
  const homeDir = home(3);
  const procDir = proc({});
  const gh = await fakeGitHub({ "o/a": [1, 2], "o/b": [1, 2, 3] });
  const a = loopProcess({ repo: "o/a", homeDir, procDir, api: gh.url });
  let b = null;
  try {
    await a.until(() => a.started() === 2, "o/a to start both its Objectives");
    b = loopProcess({ repo: "o/b", homeDir, procDir, api: gh.url });
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

test("serve: a saturated machine holds new starts, said in the tick line, but a loop holding none starts one (#309)", async () => {
  const homeDir = home(5);
  const procDir = proc({ cpu: 50 });
  const gh = await fakeGitHub({ "o/c": [1, 2, 3] });
  const c = loopProcess({ repo: "o/c", homeDir, procDir, api: gh.url });
  try {
    await c.until(() => c.started() === 1, "the one stage a loop holding none starts");
    const from = c.ticks();
    await c.until(() => c.ticks() >= from + 3, "three more ticks");
    assert.equal(c.started(), 1, "nothing more starts while the machine is saturated");
    const held = c.lines.filter((l) => /tick: /.test(l)).slice(-1)[0];
    assert.match(held, /the machine is saturated: CPU pressure 50% \(at least 10%\)/);
    assert.equal(held.match(/saturated/g).length, 1, "said once in the line");
    fakeProc(procDir, { cpu: 1 });
    await c.until(() => c.started() === 3, "the rest once the load falls");
  } finally {
    await c.stop();
    await gh.close();
  }
});

test("run and review hold one slot of the machine's budget while they run, whatever the machine holds (#309)", () => {
  const homeDir = home(1);
  const dir = slotsDir(homeDir);
  const other = takeSlot({ dir, budget: 1, holder: { repo: "o/x", issue: 4 } });
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const loop = Object.assign(Object.create(Local.prototype), { repoFull: "o/r", wf: {}, machine: { home: homeDir, proc: proc({}) } });
    const slot = loop.holdSlot({ issue: 12, stage: "run", cmd: "run" });
    assert.deepEqual(slotHolders(dir).map((h) => [h.repo, h.issue, h.cmd ?? null]).sort(), [["o/r", 12, "run"], ["o/x", 4, null]]);
    assert.ok(lines.some((l) => /#12: the machine's budget is full \(1 of 1 stage\(s\) held on this machine\); one stage starts, as this loop holds none/.test(l)));
    slot.release();
    assert.deepEqual(slotHolders(dir).map((h) => h.repo), ["o/x"]);
  } finally {
    process.stdout.write = write;
    other.release();
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
    assert.match(by["machine load"].detail, /^CPU pressure 30%, memory pressure 0%, 12\.0 GB memory available: saturated/);
    assert.deepEqual(machineChecks({ env: { GITHUB_ACTIONS: "true" }, local: true, home: homeDir }), [], "not inside a job");
    const bad = machineChecks({ env: {}, local: true, home: home("x"), proc: proc({}) });
    assert.equal(bad[0].status, "WARN");
    assert.equal(bad[2].status, "PASS");
    assert.ok(existsSync(join(slotsDir(homeDir), readdirSync(slotsDir(homeDir))[0])), "doctor removes no slot");
  } finally {
    await killed(h.child);
  }
});
