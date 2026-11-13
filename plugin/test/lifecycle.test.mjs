import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Local, parseArgs, reapLeftRuns, stageFor } from "../scripts/local.mjs";
import { GROUP_RECORD, bootId, groupRecordName } from "../scripts/lib/proc.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

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
    assert.ok(await until(() => readdirSync(dir).some((f) => GROUP_RECORD.test(f)), 10_000), "the harness started and was recorded");
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => GROUP_RECORD.test(f))), "utf8"));
    assert.equal(record.owner, stage.pid);
    assert.ok(await until(() => alive(-record.pid)), "the harness's group runs");
    stage.kill(sig);
    const end = await Promise.race([closed, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
    assert.notEqual(end, "timeout", "the stage exited");
    assert.equal(end.code, sig === "SIGTERM" ? 143 : 129);
    // Killed before the stage exited: what is left is at most an unreaped zombie for a moment.
    assert.ok(await until(() => !alive(-record.pid), 3_000), "no process of the harness's group is left");
    assert.equal(readdirSync(dir).filter((f) => GROUP_RECORD.test(f)).length, 0, "the record is gone");
  });
}

/** A detached "harness" carrying `tag` in its environment, as exec's group runs do. */
function harness(tag) {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore", env: { ...process.env, FACTORY_RUN_TAG: tag } });
  child.unref();
  return child;
}
const deadPid = () => spawnSync("true").pid;

test("a start reaps the harness a dead stage of the Objective recorded, and only that one", { skip: process.platform === "win32" }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const usage = join(ws, "usage-work-1");
  mkdirSync(usage);
  const left = harness("a".repeat(24));
  const reused = harness("b".repeat(24));
  const live = harness("c".repeat(24));
  try {
    assert.ok(await until(() => alive(left.pid) && alive(reused.pid) && alive(live.pid)));
    const write = (pid, rec) => writeFileSync(join(usage, groupRecordName(pid)), JSON.stringify({ pid, boot: bootId(), ...rec }));
    // The dead stage's own harness.
    write(left.pid, { tag: "a".repeat(24), owner: deadPid() });
    // A pid that now belongs to another process: the record's tag is not in its environment.
    write(reused.pid, { tag: "d".repeat(24), owner: deadPid() });
    // A live stage's harness: its stage stops it.
    write(live.pid, { tag: "c".repeat(24), owner: process.pid });
    assert.equal(reapLeftRuns(ws), 1);
    assert.ok(await until(() => !alive(left.pid)), "the left harness is gone");
    assert.ok(alive(reused.pid), "a process whose pid was reused is left alone");
    assert.ok(alive(live.pid), "a live stage's harness is left alone");
    assert.ok(!existsSync(join(usage, groupRecordName(left.pid))));
    assert.ok(existsSync(join(usage, groupRecordName(live.pid))), "a live stage's record stays");
    // Another boot's record: nothing of that boot is running, so nothing is signalled.
    write(reused.pid, { tag: "b".repeat(24), owner: deadPid(), boot: "another-boot" });
    assert.equal(reapLeftRuns(ws), 0);
    assert.ok(alive(reused.pid));
  } finally {
    for (const c of [left, reused, live]) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
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
  // A failed read never skips the work: the Objective is run from its start, as before.
  const { l, ran } = loop();
  await l.runIssue(7, { gh: { findPr: async () => Promise.reject(new Error("502")), getIssue: async () => Promise.reject(new Error("502")) } });
  assert.deepEqual(ran, [["work", 7, false]]);
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
