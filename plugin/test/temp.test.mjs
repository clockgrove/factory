// Temp directories Factory makes (lib/fsafe.mjs): each is removed when its holder is done, and a killed holder's
// leftover is cleared by the next sweep, never one a live process still holds.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dropOwned, ownedTemp, pidGone, removeTree, sweepOwned } from "../scripts/lib/fsafe.mjs";
import { stageTemp } from "../scripts/lib/local.mjs";

const FSAFE = new URL("../scripts/lib/fsafe.mjs", import.meta.url).href;
const HOUR = 3600_000;
const age = (p, ms) => utimesSync(p, new Date(Date.now() - ms), new Date(Date.now() - ms));

test("the test files run in a temp root of their own, held by their process", () => {
  assert.match(tmpdir(), /\/factory-test-[A-Za-z0-9]{6}$/);
  assert.equal(readFileSync(`${tmpdir()}.pid`, "utf8"), `${process.pid}\n`);
});

test("ownedTemp records its holder beside the directory; dropOwned removes both", () => {
  const base = mkdtempSync(join(tmpdir(), "owned-"));
  const dir = ownedTemp(base, "x-");
  assert.equal(readFileSync(`${dir}.pid`, "utf8"), `${process.pid}\n`);
  writeFileSync(join(dir, "f"), "x");
  dropOwned(dir);
  assert.deepEqual(readdirSync(base), []);
});

test("sweepOwned: a gone holder's directory goes once it is over the age floor; a live, recent or foreign one stays", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-"));
  const names = /^s-[A-Za-z0-9]{6}$/;
  const make = (name, pid, ms) => {
    mkdirSync(join(base, name));
    writeFileSync(join(base, `${name}.pid`), `${pid}\n`);
    age(join(base, `${name}.pid`), ms);
  };
  make("s-dead01", 111, 2 * HOUR);
  make("s-recent", 111, 60_000);
  make("s-live01", 222, 2 * HOUR);
  make("s-badpid", "x", 2 * HOUR);
  // A name the sweep does not own (another tool's directory and pid file) is never touched.
  make("other-dead01", 111, 2 * HOUR);
  // A pid file left without its directory (a holder killed mid-removal) goes too.
  writeFileSync(join(base, "s-nodir1.pid"), "111\n");
  age(join(base, "s-nodir1.pid"), 2 * HOUR);
  const gone = (pid) => pid === 111;
  const removed = sweepOwned(base, names, { gone });
  assert.deepEqual(removed.sort(), ["s-dead01", "s-nodir1"]);
  assert.deepEqual(readdirSync(base).sort(), ["other-dead01", "other-dead01.pid", "s-badpid", "s-badpid.pid", "s-live01", "s-live01.pid", "s-recent", "s-recent.pid"]);
  // Nothing else is removed, however old: a live pid's directory stays.
  assert.deepEqual(sweepOwned(base, names, { gone, now: Date.now() + 1000 * 24 * HOUR }), ["s-recent"]);
});

test("sweepOwned with legacy: a directory with no pid file goes only once it is over a week old", () => {
  const base = mkdtempSync(join(tmpdir(), "legacy-"));
  const names = /^\d+-[A-Za-z0-9]{6}$/;
  for (const n of ["7-oldone", "7-fresh1", "8-sixday"]) mkdirSync(join(base, n));
  age(join(base, "7-oldone"), 8 * 24 * HOUR);
  age(join(base, "8-sixday"), 6 * 24 * HOUR);
  assert.deepEqual(sweepOwned(base, names), [], "without legacy, an unowned directory is never removed");
  assert.deepEqual(sweepOwned(base, names, { legacy: true }), ["7-oldone"]);
  assert.deepEqual(readdirSync(base).sort(), ["7-fresh1", "8-sixday"]);
});

test("stageTemp: a stage's temp directory is owned, and making one clears what a killed loop left, never a live stage's", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const base = join(home, ".cache", "factory", "s");
  mkdirSync(base, { recursive: true });
  // A stage directory from before Factory recorded owners, over a week old; a probe's left by a gone loop; a
  // live loop's stage directory; and a directory of the sandbox check's, not a stage's.
  mkdirSync(join(base, "12-legacy"));
  age(join(base, "12-legacy"), 400 * 24 * HOUR);
  mkdirSync(join(base, "probe-killed"));
  writeFileSync(join(base, "probe-killed.pid"), "999999999\n");
  age(join(base, "probe-killed.pid"), 2 * HOUR);
  mkdirSync(join(base, "13-livexx"));
  writeFileSync(join(base, "13-livexx.pid"), `${process.pid}\n`);
  mkdirSync(join(base, "fsc-abcdef"));
  age(join(base, "fsc-abcdef"), 400 * 24 * HOUR);
  const dir = stageTemp("14-", home);
  assert.ok(dir.startsWith(join(base, "14-")));
  assert.ok(pidGone(999999999), "past every system's pid limit");
  assert.ok(!existsSync(join(base, "12-legacy")) && !existsSync(join(base, "probe-killed")) && !existsSync(join(base, "probe-killed.pid")));
  assert.ok(existsSync(join(base, "13-livexx")) && existsSync(join(base, "fsc-abcdef")));
  dropOwned(dir);
  assert.ok(!existsSync(dir) && !existsSync(`${dir}.pid`));
});

test("privateTmp: Factory's own temp directory is gone when its process ends, by a throw too, and a killed one's by the next", () => {
  const base = mkdtempSync(join(tmpdir(), "private-"));
  const env = { ...process.env, FACTORY_PRIVATE_DIR: base };
  for (const code of [`const { privateTmp } = await import(${JSON.stringify(FSAFE)}); privateTmp(); process.stdout.write(process.env.TMPDIR);`, `const { privateTmp } = await import(${JSON.stringify(FSAFE)}); privateTmp(); throw new Error("boom");`]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
    assert.deepEqual(readdirSync(base), [], r.stderr);
  }
  // A killed process's directory: its pid is gone and its pid file is old, so the next privateTmp clears it.
  mkdirSync(join(base, "factory-killed"));
  writeFileSync(join(base, "factory-killed.pid"), "999999999\n");
  age(join(base, "factory-killed.pid"), 2 * HOUR);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const { privateTmp } = await import(${JSON.stringify(FSAFE)}); privateTmp();`], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(base), []);
});

test("removeTree removes a tree with write-protected directories in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "f"), "x");
  chmodSync(join(dir, "a", "b"), 0o500);
  chmodSync(join(dir, "a"), 0o500);
  removeTree(dir);
  assert.ok(!existsSync(dir));
});
