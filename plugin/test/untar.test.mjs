import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UNTAR, untarAsAgent } from "../scripts/lib/untar.mjs";

const untar = (archive, dest, keep = false) => spawnSync(process.execPath, ["-e", UNTAR, dest, keep ? "1" : "0"], { input: archive, encoding: "buffer" });

test("a held session archive unpacks without GNU tar: nested directories, long names, pax paths, modes and times", async () => {
  const root = mkdtempSync(join(tmpdir(), "untar-"));
  const from = join(root, "from");
  const long = `${"d".repeat(120)}/${"f".repeat(130)}.jsonl`;
  mkdirSync(join(from, "s1", "checkpoints"), { recursive: true });
  mkdirSync(join(from, "s1", "d".repeat(120)), { recursive: true });
  writeFileSync(join(from, "s1", "checkpoints", "index.md"), "one\n");
  writeFileSync(join(from, "s1", long), "two\n");
  writeFileSync(join(from, "s1", "suid"), "x", { mode: 0o4755 });
  utimesSync(join(from, "s1", "checkpoints", "index.md"), 1_700_000_000, 1_700_000_000);
  for (const format of ["gnu", "pax"]) {
    const to = join(root, `to-${format}`);
    mkdirSync(to);
    const tar = execFileSync("tar", ["-C", from, `--format=${format}`, "-cf", "-", "s1"]);
    const r = await untarAsAgent(tar, to, {});
    assert.equal(r.code, 0, String(r.stderr));
    assert.equal(readFileSync(join(to, "s1", "checkpoints", "index.md"), "utf8"), "one\n");
    assert.equal(readFileSync(join(to, "s1", long), "utf8"), "two\n", `${format}: a name past 100 bytes`);
    assert.equal(statSync(join(to, "s1", "checkpoints", "index.md")).mtimeMs, 1_700_000_000_000);
    assert.equal(statSync(join(to, "s1", "suid")).mode & 0o7000, 0, "no setuid or setgid bit");
  }
});

test("the unpacker writes nothing outside its destination: links skipped, .. and absolute names refused, a linked parent refused", () => {
  const root = mkdtempSync(join(tmpdir(), "untar-"));
  const from = join(root, "from");
  mkdirSync(join(from, "s1"), { recursive: true });
  symlinkSync("/etc", join(from, "s1", "out"));
  writeFileSync(join(from, "s1", "ok"), "ok");
  const to = join(root, "to");
  mkdirSync(to);
  const r = untar(execFileSync("tar", ["-C", from, "-cf", "-", "s1"]), to);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(to, "s1", "out")), "a link is skipped");
  assert.match(String(r.stderr), /skipped "s1\/out" \(type 2\)/);
  const dotdot = execFileSync("tar", ["-C", from, "--transform", "s,^s1,../s1,", "-cf", "-", "s1/ok"]);
  const bad = join(root, "bad");
  mkdirSync(bad);
  const r2 = untar(dotdot, bad);
  assert.equal(r2.status, 1);
  assert.match(String(r2.stderr), /refused name/);
  assert.ok(!existsSync(join(root, "s1")), "nothing written above the destination");
  // A parent that is a link (planted between capture and restore) refuses: never written through.
  const linked = join(root, "linked");
  mkdirSync(linked);
  symlinkSync(root, join(linked, "s1"));
  const r3 = untar(execFileSync("tar", ["-C", from, "-cf", "-", "s1/ok"]), linked);
  assert.equal(r3.status, 1);
  assert.match(String(r3.stderr), /is not a directory/);
  assert.ok(!existsSync(join(root, "ok")));
  // A destination that is a link refuses too, and a cut-short archive.
  assert.equal(untar(execFileSync("tar", ["-C", from, "-cf", "-", "s1/ok"]), join(linked, "s1")).status, 1);
  const whole = execFileSync("tar", ["-C", from, "-cf", "-", "s1/ok"]);
  const cut = join(root, "cut");
  mkdirSync(cut);
  assert.equal(untar(whole.subarray(0, 600), cut).status, 1);
});

test("a crafted size refuses the archive, never loops: negative, not octal, or past a safe integer", async () => {
  const root = mkdtempSync(join(tmpdir(), "untar-"));
  mkdirSync(join(root, "from", "s1"), { recursive: true });
  writeFileSync(join(root, "from", "s1", "a"), "x".repeat(2000));
  const good = execFileSync("tar", ["-C", join(root, "from"), "--format=gnu", "-cf", "-", "s1/a"]);
  const crafted = (size) => {
    const t = Buffer.from(good);
    t.write(size.padEnd(12, "\0"), 124, "latin1");
    // The header checksum, recomputed with the field as spaces, as tar does.
    t.fill(" ", 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += t[i];
    t.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return t;
  };
  for (const size of ["-0002000", "0000zz", "\x80\x7f\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"]) {
    const to = mkdtempSync(join(root, "to-"));
    const t0 = Date.now();
    const r = await untarAsAgent(crafted(size), to, { timeoutMs: 10_000 });
    assert.equal(r.code, 1, JSON.stringify(size));
    assert.ok(!r.timedOut && Date.now() - t0 < 10_000, "refused at once, not stopped by the time cap");
    assert.match(String(r.stderr), /not a whole number of bytes/);
  }
});
