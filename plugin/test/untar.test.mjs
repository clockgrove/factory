import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UNTAR, untarAsAgent } from "../scripts/lib/untar.mjs";
import { claudeSandboxChecks } from "../scripts/doctor.mjs";

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

test("keep leaves a file already there; otherwise it is replaced, a link in its place included", () => {
  const root = mkdtempSync(join(tmpdir(), "untar-"));
  mkdirSync(join(root, "from", "s1"), { recursive: true });
  writeFileSync(join(root, "from", "s1", "a"), "new");
  const tar = execFileSync("tar", ["-C", join(root, "from"), "-cf", "-", "s1"]);
  const to = join(root, "to");
  mkdirSync(join(to, "s1"), { recursive: true });
  writeFileSync(join(to, "s1", "a"), "old");
  assert.equal(untar(tar, to, true).status, 0);
  assert.equal(readFileSync(join(to, "s1", "a"), "utf8"), "old");
  symlinkSync(join(root, "elsewhere"), join(to, "s1", "b"));
  writeFileSync(join(root, "from", "s1", "b"), "b");
  assert.equal(untar(execFileSync("tar", ["-C", join(root, "from"), "-cf", "-", "s1"]), to).status, 0);
  assert.equal(readFileSync(join(to, "s1", "a"), "utf8"), "new");
  assert.ok(lstatSync(join(to, "s1", "b")).isFile(), "the link is replaced, not written through");
  assert.ok(!existsSync(join(root, "elsewhere")));
});

test("nothing systemd-run would expand in the unpacker; doctor's session restore row", async () => {
  assert.ok(!UNTAR.includes("${"));
  const names = (rows) => rows.map((r) => `${r.name}:${r.status}`);
  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  for (const h of ["claude", "codex", "copilot"]) {
    const rows = await claudeSandboxChecks({ inputs: { harness: h }, env: hosted, local: false, has: async () => true, start: async () => null, restore: async () => ({ ok: false, reason: "untar: s1 is not a directory" }) });
    assert.equal(names(rows).at(-1), "session restore:FAIL", h);
    assert.match(rows.at(-1).detail, /resumed stage Blocks/);
  }
  const ok = await claudeSandboxChecks({ inputs: { harness: "claude" }, env: hosted, local: false, has: async () => true, restore: async () => ({ ok: true }) });
  assert.equal(names(ok).at(-1), "session restore:PASS");
  assert.deepEqual(names(await claudeSandboxChecks({ inputs: { harness: "claude" }, env: hosted, local: false, has: async () => true, restore: async () => null })).filter((n) => n.startsWith("session")), [], "before the agent exists, no row");
});
