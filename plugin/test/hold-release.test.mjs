import "./temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIMIT_BACKOFF_MS, accountHolds, holdsDir } from "../scripts/lib/holds.mjs";
import { parseArgs } from "../scripts/local.mjs";

// `pendulum hold list | release <account>` (#376) on this machine: the real command, in its own process, on a fake home's
// holds folder, read back by another serve's store (the real holds.mjs) as every serve here reads it.
const CLI = join(import.meta.dirname, "..", "scripts", "local.mjs");
const MIN = 60_000;
const H = 60 * MIN;
const hold = (home, ...args) => spawnSync(process.execPath, [CLI, "hold", ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });

test("#376: hold list shows each held or passed-over account; hold release lifts one account's hold, guess and back-off for every serve, removes no file and leaves the others", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hold-")));
  const dir = holdsDir(home);
  const serve = accountHolds({ dir });
  const now = Date.now();
  // alpha: held 20 hours ahead, then refused past its stated reset twice in a row (back-off 2); a guess on it too.
  serve.limit({ harness: "claude", account: "alpha", reset: now + 20 * H, now: now - 3 * H, window: "seven_day" });
  serve.limit({ harness: "claude", account: "alpha", reset: now - 2 * H - MIN, now: now - 2 * H });
  serve.limit({ harness: "claude", account: "alpha", reset: now - H - MIN, now: now - H });
  serve.spent({ harness: "claude", account: "alpha", now: now - MIN });
  serve.limit({ harness: "claude", account: "beta", reset: now + 2 * H, now: now - MIN, window: "five_hour" });
  serve.spent({ harness: "codex", account: "codex@0123456789ab", now: now - MIN });

  const list = hold(home, "list");
  assert.equal(list.status, 0, list.stderr);
  const lines = list.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^alpha \(Claude Code\): held until \S+ \(seven_day\), back-off count 2; passed over until about \S+ \(no reset reported\), 1 in a row$/);
  assert.match(lines[1], /^beta \(Claude Code\): held until \S+ \(five_hour\), back-off count 0$/);
  assert.match(lines[2], /^codex@0123456789ab \(Codex\): passed over until about \S+ \(no reset reported\), 1 in a row$/);

  // A name nothing holds: refused, naming the ones that are; nothing written.
  const files = readdirSync(dir).sort();
  const unknown = hold(home, "release", "gamma");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /nothing is held or passed over for "gamma" on this machine .*; the accounts that are: alpha, beta, codex@0123456789ab/);
  assert.deepEqual(readdirSync(dir).sort(), files);

  const rel = hold(home, "release", "alpha");
  assert.equal(rel.status, 0, rel.stderr);
  assert.match(rel.stdout, /^released alpha \(Claude Code\), which was held until \S+ \(seven_day\), back-off count 2; passed over until about /);
  assert.match(rel.stdout, /\nevery serve on this Pendulum release or later on this machine may start on it at its next tick, .*; a serve on an earlier release still holds it until its reset: restart that serve on this release/);
  const after = readdirSync(dir).sort();
  assert.equal(after.length, files.length + 1, "one release record, and no file removed");
  assert.ok(files.every((f) => after.includes(f)));

  // Another serve here, at its next tick: alpha is free (no hold, no guess), beta and the Codex login still held.
  const other = accountHolds({ dir });
  const t = Date.now();
  assert.equal(other.until("alpha", t), null);
  assert.equal(other.avoidUntil("alpha", t), null);
  assert.equal(other.limitedAt("alpha", t), null);
  assert.equal(other.until("beta", t), now + 2 * H);
  assert.ok(other.avoidUntil("codex@0123456789ab", t) > t);
  assert.ok(other.held("claude", t), "beta still holds the harness's other account");
  // The back-off count starts again: a refusal past its reset is the first in a row.
  assert.equal(other.limit({ harness: "claude", account: "alpha", reset: t - MIN, now: t }), t + LIMIT_BACKOFF_MS[0]);
  assert.equal(other.until("alpha", t), t + LIMIT_BACKOFF_MS[0], "a limit after the release holds again");

  const again = hold(home, "list");
  assert.match(again.stdout, /^alpha \(Claude Code\): held until \S+, back-off count 1\nbeta /);
  // A login's key releases the same way, as the list shows it.
  assert.equal(hold(home, "release", "codex@0123456789ab").status, 0);
  assert.equal(accountHolds({ dir }).avoidUntil("codex@0123456789ab", Date.now()), null);
});

test("#376: with nothing held, hold list says so; hold release names that no account is", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hold-")));
  const list = hold(home, "list");
  assert.equal(list.status, 0);
  assert.match(list.stdout, /^no account is held or passed over on this machine/);
  const rel = hold(home, "release", "alpha");
  assert.equal(rel.status, 1);
  assert.match(rel.stderr, /; no account is\n$/);
});

test("#376: hold takes list, or release and one account, and --repo alone", () => {
  assert.deepEqual(parseArgs(["hold", "list"]).flags._, ["hold", "list"]);
  assert.deepEqual(parseArgs(["hold", "release", "alpha", "--repo", "o/r"]).flags, { _: ["hold", "release", "alpha"], repo: "o/r" });
  for (const a of ["hold", "hold drop", "hold list alpha", "hold release", "hold release a b", "hold list --checkout x", "hold list --all"]) assert.throws(() => parseArgs(a.split(" ")), (e) => e.usage === true, a);
  assert.equal(parseArgs(["hold", "--help"]).help, true);
});
