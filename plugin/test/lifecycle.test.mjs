import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Local, STAGE_RECORD, liveStage, parseArgs, reapLeftRuns, stageFor } from "../scripts/local.mjs";
import { GROUP_RECORD, bootId, groupRecordName, processRecord, startTime } from "../scripts/lib/proc.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

/** Resolves to `value` after `ms`, without holding the test process open. */
const after = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms).unref());
const killGroup = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // gone
  }
};

/** Poll `check` every 25 ms until it holds or `ms` pass; returns whether it held. */
async function until(check, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}
const alive = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// A stage-like parent: its "harness" leads a process group of its own (as local mode starts it) with a second process
// in that group; the parent then waits on it, as worker.mjs does.
const stageScript = (dir) => `
import { exec } from ${JSON.stringify(pathToFileURL(join(scripts, "lib", "proc.mjs")).href)};
await exec("sh", ["-c", "sleep 60 & sleep 60; wait"], { group: true, record: ${JSON.stringify(dir)}, timeoutMs: 120_000 });
process.exit(0);
`;

for (const sig of ["SIGTERM", "SIGHUP"]) {
  test(`${sig} to a stage stops its harness's whole process group before the stage exits`, { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-"));
    const script = join(dir, "stage.mjs");
    writeFileSync(script, stageScript(dir));
    const stage = spawn(process.execPath, [script], { stdio: "ignore" });
    const closed = new Promise((r) => stage.on("close", (code, s) => r({ code, s })));
    let record = null;
    try {
      assert.ok(await until(() => readdirSync(dir).some((f) => GROUP_RECORD.test(f)), 10_000), "the harness started and was recorded");
      record = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => GROUP_RECORD.test(f))), "utf8"));
      assert.equal(record.owner, stage.pid);
      assert.ok(record.start && record.ownerStart, "start times recorded");
      assert.ok(await until(() => alive(-record.pid)), "the harness's group runs");
      stage.kill(sig);
      const end = await Promise.race([closed, after(10_000, "timeout")]);
      assert.notEqual(end, "timeout", "the stage exited");
      assert.equal(end.code, sig === "SIGTERM" ? 143 : 129);
      // Killed before the stage exited: what is left is at most an unreaped zombie for a moment.
      assert.ok(await until(() => !alive(-record.pid), 3_000), "no process of the harness's group is left");
      assert.equal(readdirSync(dir).filter((f) => GROUP_RECORD.test(f)).length, 0, "the record is gone");
    } finally {
      stage.kill("SIGKILL");
      if (record) killGroup(record.pid);
    }
  });
}

/** A detached "harness" carrying `tag` in its environment, as exec's group runs do. */
function harness(tag) {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore", env: { ...process.env, FACTORY_RUN_TAG: tag } });
  child.unref();
  return child;
}
/** A process group whose leader has exited while a member lives (a daemonised process); the member's pid. */
function leaderless(tag = null) {
  const r = spawnSync("setsid", ["sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!; echo $$"], { encoding: "utf8", env: tag ? { ...process.env, FACTORY_RUN_TAG: tag } : process.env });
  const [member, leader] = r.stdout.trim().split("\n").map(Number);
  return { member, leader };
}
const deadPid = () => spawnSync("true").pid;
const tags = { a: "a".repeat(24), b: "b".repeat(24), c: "c".repeat(24), d: "d".repeat(24), e: "e".repeat(24) };

test("a start reaps the harness a dead stage of the Objective recorded, and only that one", { skip: process.platform !== "linux" }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const usage = join(ws, "usage-work-1");
  mkdirSync(usage);
  const left = harness(tags.a);
  const reused = harness(tags.b);
  const live = harness(tags.c);
  const stale = harness(tags.e);
  const groups = [left.pid, reused.pid, live.pid, stale.pid];
  try {
    assert.ok(await until(() => groups.every(alive)));
    const me = processRecord();
    const dead = { owner: deadPid(), ownerStart: "1" };
    const write = (pid, rec) => writeFileSync(join(usage, groupRecordName(pid)), JSON.stringify({ pid, start: startTime(pid), boot: bootId(), ...rec }));
    // The dead stage's own harness.
    write(left.pid, { tag: tags.a, ...dead });
    // A pid that now belongs to another process: neither its start time nor its environment match the record.
    write(reused.pid, { tag: tags.d, ...dead, start: "1" });
    // A live stage's harness: its stage stops it.
    write(live.pid, { tag: tags.c, owner: me.pid, ownerStart: me.start });
    // A dead stage whose pid a live process took since: the start time tells them apart.
    write(stale.pid, { tag: tags.e, owner: me.pid, ownerStart: "1" });
    assert.equal(reapLeftRuns(ws), 2);
    assert.ok(await until(() => !alive(left.pid) && !alive(stale.pid)), "the left harnesses are gone");
    assert.ok(alive(reused.pid), "a process whose pid was reused is left alone");
    assert.ok(alive(live.pid), "a live stage's harness is left alone");
    assert.ok(!existsSync(join(usage, groupRecordName(left.pid))));
    assert.ok(existsSync(join(usage, groupRecordName(live.pid))), "a live stage's record stays");
    // Another boot's record: nothing of that boot is running, so nothing is signalled.
    write(reused.pid, { tag: tags.b, ...dead, boot: "another-boot" });
    assert.equal(reapLeftRuns(ws), 0);
    assert.ok(alive(reused.pid));
  } finally {
    for (const pid of groups) killGroup(pid);
  }
});

test("a group whose leader is gone is reaped only when a member carries the run's tag", { skip: process.platform !== "linux" }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const usage = join(ws, "usage-work-1");
  mkdirSync(usage);
  // An unrelated daemon that took the recorded pid's group id: no tag anywhere.
  const other = leaderless();
  // The run's own group, its leader gone: its member inherited the tag.
  const ours = leaderless(tags.a);
  try {
    assert.ok(await until(() => alive(other.member) && alive(ours.member) && !alive(other.leader) && !alive(ours.leader)));
    const dead = { owner: deadPid(), ownerStart: "1", boot: bootId(), start: "1" };
    writeFileSync(join(usage, groupRecordName(other.leader)), JSON.stringify({ pid: other.leader, tag: tags.b, ...dead }));
    assert.equal(reapLeftRuns(ws), 0);
    assert.ok(alive(other.member), "an untagged group is left alone");
    writeFileSync(join(usage, groupRecordName(ours.leader)), JSON.stringify({ pid: ours.leader, tag: tags.a, ...dead }));
    assert.equal(reapLeftRuns(ws), 1);
    assert.ok(await until(() => !alive(ours.member)), "the run's group is gone");
    assert.ok(alive(other.member));
  } finally {
    killGroup(other.leader);
    killGroup(ours.leader);
  }
});

test("liveStage: a recorded stage counts while it is the same process", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(ws, "usage-work-1"));
  mkdirSync(join(ws, "usage-review-2"));
  writeFileSync(join(ws, "usage-work-1", STAGE_RECORD), JSON.stringify({ ...processRecord(), start: "1" }));
  assert.equal(liveStage(ws), null, "a reused pid is no live stage");
  assert.ok(!existsSync(join(ws, "usage-work-1", STAGE_RECORD)), "its record goes");
  writeFileSync(join(ws, "usage-review-2", STAGE_RECORD), JSON.stringify(processRecord()));
  assert.equal(liveStage(ws), process.pid);
  writeFileSync(join(ws, "usage-review-2", STAGE_RECORD), JSON.stringify({ ...processRecord(deadPid()) }));
  assert.equal(liveStage(ws), null);
});

const pr = (o = {}) => ({ number: 5, state: "open", draft: false, labels: [{ name: "factory:review" }], head: { ref: "factory/7" }, ...o });
const issue = (...labels) => ({ number: 7, labels: labels.map((name) => ({ name })) });

test("stageFor: the stage an Objective's state calls for", () => {
  assert.equal(stageFor({ pr: pr(), issue: issue("factory:in-review") }), "review");
  assert.equal(stageFor({ pr: pr(), issue: issue("factory:running") }), "review");
  assert.equal(stageFor({ pr: null, issue: issue("factory:running") }), "work");
  assert.equal(stageFor({ pr: pr({ draft: true }), issue: issue("factory:running") }), "work");
  assert.equal(stageFor({ pr: pr({ labels: [] }), issue: issue("factory:in-review") }), "merge");
  assert.equal(stageFor({ pr: pr({ draft: true }), issue: issue("factory:question") }), null);
  assert.equal(stageFor({ pr: null, issue: issue("factory:objective") }), null);
  assert.equal(stageFor({ pr: null, issue: null }), null);
});

/** A loop whose stages are recorded instead of run; its GitHub reads are `gh`'s. */
function loop() {
  const ran = [];
  const l = Object.assign(Object.create(Local.prototype), {
    dev: mkdtempSync(join(tmpdir(), "dev-")),
    repo: { owner: "o", name: "r", full: "o/r" },
    opts: { token: "t" },
    withClaim: async (n, fn) => fn(),
    review: async (n, prNumber, o) => (ran.push(["review", n, prNumber, o.wait]), { exit: "delivered" }),
    runObjective: async (n, o) => (ran.push(["work", n, o.wait]), { exit: "delivered" }),
    followMerge: async (n, prNumber) => (ran.push(["merge", n, prNumber]), true),
  });
  return { l, ran };
}
const reads = (p, i) => ({ findPr: async () => p, getIssue: async () => i });
const failing = () => Promise.reject(new Error("HTTP 502"));

test("factory run starts where the Objective stands, as serve's resume does", async () => {
  const cases = [
    [pr(), issue("factory:in-review"), false, [["review", 7, 5, false]]],
    [pr(), issue("factory:running"), true, [["review", 7, 5, true]]],
    [null, issue("factory:running"), false, [["work", 7, false]]],
    [pr({ labels: [] }), issue("factory:in-review"), true, [["merge", 7, 5]]],
    [pr({ labels: [] }), issue("factory:in-review"), false, []],
    [null, issue("factory:objective"), false, [["work", 7, false]]],
    [pr({ draft: true, labels: [] }), issue("factory:objective"), true, [["work", 7, true]]],
  ];
  for (const [p, i, wait, want] of cases) {
    const { l, ran } = loop();
    const r = await l.runIssue(7, { wait, gh: reads(p, i) });
    assert.deepEqual(ran, want, JSON.stringify({ p: p && { draft: p.draft, labels: p.labels }, i: i.labels, wait }));
    assert.equal(r.exit, "delivered");
  }
});

test("factory run starts nothing when it cannot tell where the Objective stands", async () => {
  // A PR read that keeps failing, on an In-review Objective: retried, then refused, never a work pass.
  let tries = 0;
  const { l, ran } = loop();
  await assert.rejects(l.runIssue(7, { waitMs: 1, gh: { findPr: () => (tries++, failing()), getIssue: async () => issue("factory:in-review") } }), /reading the open PR of factory\/7 failed 3 times .*nothing was started/);
  assert.equal(tries, 3);
  await assert.rejects(l.runIssue(7, { waitMs: 1, gh: { findPr: async () => null, getIssue: failing } }), /reading issue #7 failed/);
  // A read that fails once and then answers is used.
  let once = 0;
  await l.runIssue(7, { waitMs: 1, gh: { findPr: () => (once++ ? Promise.resolve(pr()) : failing()), getIssue: async () => issue("factory:in-review") } });
  assert.deepEqual(ran, [["review", 7, 5, false]]);
  // A closed issue: nothing to run.
  ran.length = 0;
  await assert.rejects(l.runIssue(7, { gh: reads(null, { ...issue("factory:objective"), state: "closed" }) }), /closed/);
  // A stage of it still running on this machine (its loop gone): not a second one beside it.
  mkdirSync(join(l.ws(7), "usage-work-1"), { recursive: true });
  writeFileSync(join(l.ws(7), "usage-work-1", STAGE_RECORD), JSON.stringify(processRecord()));
  await assert.rejects(l.runIssue(7, { gh: reads(null, issue("factory:running")) }), /still runs on this machine/);
  assert.deepEqual(ran, []);
});

test("the command line is checked before anything runs", () => {
  for (const a of ["--help", "-h", "serve --help", "serve -h", "run 12 --help", "run --help", "review 5 --help", "deliver 5 -h", "post-review --help", "issue --help"]) assert.equal(parseArgs(a.split(" ")).help, true, a);
  const bad = ["serve --bogus", "serve --dry-run", "serve --interval", "serve --interval abc", "serve --interval 0", "serve --interval --once", "run", "run abc", "run 12 13", "run -5", "run --wait=yes 12", "run 12 --repo", "review", "post-review 5", "deliver 5 --all", "nonsense", ""];
  for (const a of bad) assert.throws(() => parseArgs(a ? a.split(" ") : []), (e) => e.usage === true, a);
  assert.deepEqual(parseArgs(["run", "--wait", "12"]), { cmd: "run", flags: { _: ["run", "12"], wait: true } });
  assert.deepEqual(parseArgs(["serve", "--interval", "5", "--once", "--all"]), { cmd: "serve", flags: { _: ["serve"], interval: 5, once: true, all: true } });
  assert.deepEqual(parseArgs(["deliver", "4", "--out=/x", "--repo", "o/r"]), { cmd: "deliver", flags: { _: ["deliver", "4"], out: "/x", repo: "o/r" } });
});

test("factory and factory-db answer --help and refuse a bad flag before doing anything", { skip: process.platform === "win32" }, () => {
  const factory = (...a) => spawnSync(process.execPath, [join(bin, "factory"), ...a], { encoding: "utf8", timeout: 30_000 });
  for (const a of [["--help"], ["-h"], ["serve", "--help"], ["run", "12", "-h"]]) {
    const r = factory(...a);
    assert.equal(r.status, 0, a.join(" "));
    assert.match(r.stdout, /^usage:/, a.join(" "));
  }
  for (const a of [["serve", "--bogus"], ["serve", "--interval"], ["serve", "--interval", "abc"], ["run", "--wait"], []]) {
    const r = factory(...a);
    assert.equal(r.status, 64, a.join(" "));
    assert.match(r.stderr, /usage:/, a.join(" "));
  }
  const db = (...a) => spawnSync("bash", [join(bin, "factory-db"), ...a], { encoding: "utf8", timeout: 30_000 });
  for (const a of ["--help", "-h"]) {
    const r = db(a);
    assert.equal(r.status, 0, a);
    assert.match(r.stdout, /^usage: factory-db/);
  }
  for (const a of [["--bogus"], []]) {
    const r = db(...a);
    assert.equal(r.status, 2, a.join(" "));
    assert.match(r.stderr, /usage: factory-db/);
  }
});
