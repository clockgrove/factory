import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The stage script serve starts is this file's fake worker (it writes the result.json a test gives it), so serve's real
// start, end and hold paths run: set before local.mjs is loaded.
const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-")));
mkdirSync(join(root, "scripts"));
// With FAKE_LIMIT, another serve's stage meets the account's limit while this one runs (the real holds.mjs); this one
// then ends once FAKE_GO exists.
writeFileSync(
  join(root, "scripts", "worker.mjs"),
  'import { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst a = process.argv;\nappendFileSync(process.env.FAKE_RAN, "ran\\n");\nif (process.env.FAKE_LIMIT) {\n  const { accountHolds } = await import(process.env.FAKE_HOLDS);\n  accountHolds({ dir: process.env.FAKE_HOLDS_DIR }).limit(JSON.parse(process.env.FAKE_LIMIT));\n  const { existsSync } = await import("node:fs");\n  while (!existsSync(process.env.FAKE_GO)) await new Promise((r) => setTimeout(r, 20));\n}\nwriteFileSync(join(a[a.indexOf("--usage-dir") + 1], "result.json"), process.env.FAKE_RESULT);\n',
);
process.env.FACTORY_PLUGIN_ROOT = root;
const { HOLD_FORGET_MS, HOLD_MAX_MS, LIMIT_BACKOFF_MS, accountHolds, holdsDir } = await import("../scripts/lib/holds.mjs");
const { Local } = await import("../scripts/local.mjs");
const { accountsFile } = await import("../scripts/lib/accounts.mjs");
const { gitPinFile, harnessOuterSettings, pinGitDir } = await import("../scripts/lib/local.mjs");

const HOLDS = join(import.meta.dirname, "..", "scripts", "lib", "holds.mjs");
const MIN = 60_000;
const within = (p, d) => p === d || p.startsWith(`${d}/`);

/** A stand-in home with two Claude Code accounts declared, alpha (the default) and beta, or none. Every file is a dummy. */
function fakeHome({ declared = true } = {}) {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "holds-")));
  for (const d of [".claude", ".codex", ".config/factory", "work/claude-a", "work/claude-b"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "factory"), 0o700);
  if (declared) writeFileSync(accountsFile(h), JSON.stringify({ claude: [{ name: "alpha", home: join(h, "work", "claude-a") }, { name: "beta", home: join(h, "work", "claude-b") }] }), { mode: 0o600 });
  return h;
}

async function withHome(h, fn) {
  const saved = Object.fromEntries(["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_GITHUB_TOKEN"].map((k) => [k, process.env[k]]));
  process.env.HOME = h;
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_GITHUB_TOKEN"]) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

/**
 * A serve on the fake home (one per repository, or a restarted one): its holds are the machine's, as its constructor
 * makes them; its stages run on the account the real accountFor names, through the real startStage, with srt standing
 * in as the git sandbox and the fake worker as the stage.
 */
function serveOn(h, clock) {
  const dev = join(h, "work", `repo-${Math.random().toString(36).slice(2, 8)}`);
  const loop = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repoFull: "o/r", wf: {}, stopping: false, firstSetup: new Map(), children: new Set(), clock });
  loop.holds = accountHolds({ dir: holdsDir(h) });
  const clone = join(loop.ws(8), "repo");
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  pinGitDir(clone, gitPinFile(loop.ws(8)));
  const bin = join(h, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "srt"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const caches = [join(dev, "pnpm"), join(dev, "bun")];
  for (const d of caches) mkdirSync(d, { recursive: true });
  const ran = join(dev, "ran.txt");
  writeFileSync(ran, "");
  loop.harnessFor = async () => ({ ok: true, harness: "claude", account: loop.accountFor("claude") });
  loop.result = {};
  loop.stageEnv = (issue, usageDir, c, stageTmp) => ({ PATH: `${bin}:${process.env.PATH}`, FACTORY_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1], FAKE_RAN: ran, FAKE_RESULT: JSON.stringify(loop.result), ...(loop.during ? { FAKE_LIMIT: JSON.stringify(loop.during), FAKE_HOLDS: HOLDS, FAKE_HOLDS_DIR: holdsDir(h), FAKE_GO: join(dev, "go") } : {}) });
  loop.go = () => writeFileSync(join(dev, "go"), "");
  loop.ran = () => readFileSync(ran, "utf8").split("\n").filter(Boolean).length;
  return loop;
}

/** A work stage that ends on its usage limit, reset at `reset` (ms), as session.mjs usageLimitExit writes it. */
const limited = (reset, since) => ({ exit: "paused", usd: 0.1, tokens: { output: 0 }, usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(since).toISOString() } });

test("#264: a usage limit holds only the account that met it, for every serve on the machine and a restarted one, which start nothing on it and spend no call", async () => {
  const h = fakeHome();
  let t = Date.now();
  await withHome(h, async () => {
    const a = serveOn(h, () => t);
    // A stage on alpha (claude's default) meets its usage limit, reset in three hours.
    a.result = limited(t + 180 * MIN, t);
    const end = await a.stage(8, "work", "worker.mjs", []);
    assert.equal(end.account, "alpha");
    a.outagePaused(8, end);
    assert.equal(a.limitUntil({ key: "alpha", shared: true }), t + 180 * MIN);
    assert.equal(a.limitUntil({ key: "beta", shared: true }), null, "beta is not held");
    // Another repository's serve, and a serve started afresh: the machine's holds, read from disk.
    for (const b of [serveOn(h, () => t), serveOn(h, () => t)]) {
      assert.match(b.limitHold(["factory:objective"]), /^claude account alpha's usage limit is spent until /);
      assert.equal(b.limitHold(["factory:objective", "factory:harness:codex"]), null, "another harness's account starts");
      const held = await b.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.account, held.usageLimit.held, Date.parse(held.usageLimit.reset)], ["paused", "alpha", true, t + 180 * MIN]);
      assert.equal(b.ran(), 0, "nothing started on alpha: no call spent to find the limit again");
      b.outagePaused(8, held);
      assert.equal(b.offline.get(8).reset, t + 180 * MIN, "it resumes the Objective after the reset");
    }
    // Past the reset, alpha starts again.
    t += 180 * MIN;
    const c = serveOn(h, () => t);
    assert.equal(c.limitHold(["factory:objective"]), null);
    c.result = { exit: "delivered", tokens: { output: 10 } };
    assert.equal((await c.stage(8, "work", "worker.mjs", [])).exit, "delivered");
    assert.equal(c.ran(), 1);
  });
  // The record: no secret, no path; and under Factory's cache folder, never ~/.config/factory.
  const files = readdirSync(holdsDir(h));
  assert.ok(files.length > 0 && files.every((f) => /^alpha\.[0-9a-f]{16}\.json$/.test(f)), files.join(", "));
  for (const f of files) assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(holdsDir(h), f), "utf8"))).sort(), ["account", "at", "harness", "streak", "until"]);
  assert.equal(lstatSync(holdsDir(h)).mode & 0o077, 0);
  assert.ok(!within(holdsDir(h), join(h, ".config", "factory")));
});

test("#264: an account held by another account's limit still starts: a hold on beta holds no stage on alpha", async () => {
  const h = fakeHome();
  const t = Date.now();
  await withHome(h, async () => {
    accountHolds({ dir: holdsDir(h) }).limit({ harness: "claude", account: "beta", reset: t + 60 * MIN, now: t });
    const a = serveOn(h, () => t);
    assert.equal(a.limitHold(["factory:objective"]), null);
    a.result = { exit: "delivered", tokens: { output: 10 } };
    assert.equal((await a.stage(8, "work", "worker.mjs", [])).exit, "delivered");
    assert.equal(a.ran(), 1);
  });
});

test("#264: the back-off streak is the account's, shared by every serve; it ends when a pass on that account completes, or once the hold is long past", async () => {
  const h = fakeHome();
  let t = Date.now();
  await withHome(h, async () => {
    const pause = async (loop) => {
      loop.result = limited(t - MIN, t);
      const end = await loop.stage(8, "work", "worker.mjs", []);
      loop.outagePaused(8, end);
      const held = (loop.offline.get(8).reset - t) / MIN;
      t = loop.offline.get(8).reset;
      return held;
    };
    // A provider that refuses past the reset it stated, met by two serves in turn: one streak, 2, 5, 10 then 15 minutes.
    const a = serveOn(h, () => t);
    const b = serveOn(h, () => t);
    assert.deepEqual([await pause(a), await pause(b), await pause(a), await pause(b), await pause(a)], [2, 5, 10, 15, 15]);
    // A pass on alpha that another serve's limit lands during: it started before that limit and ends after it, so the
    // streak stays.
    t += 1000;
    b.result = { exit: "delivered", tokens: { output: 10 } };
    b.during = { harness: "claude", account: "alpha", reset: t - MIN, now: t + 500 };
    const files = readdirSync(holdsDir(h)).length;
    const running = b.stage(8, "work", "worker.mjs", []);
    for (const deadline = Date.now() + 30_000; readdirSync(holdsDir(h)).filter((f) => !f.startsWith(".")).length === files; ) {
      assert.ok(Date.now() < deadline, "the other serve's limit was never written");
      await new Promise((r) => setTimeout(r, 20));
    }
    t += 2000;
    b.go();
    assert.equal((await running).exit, "delivered");
    b.during = null;
    t += 16 * MIN;
    assert.equal(await pause(a), 15, "the streak went on: 15 minutes, not 2");
    // A pass on alpha that started after the newest limit completes: the streak ends.
    t += 1000;
    await b.stage(8, "work", "worker.mjs", []);
    assert.equal(await pause(a), 2);
    // A stage that ran but whose pass the provider never served does not end it.
    a.result = { exit: "blocked", tokens: { output: 0 } };
    await a.stage(8, "work", "worker.mjs", []);
    assert.equal(await pause(b), 5);
    // The hold long past: forgotten, and the count starts again.
    t += HOLD_FORGET_MS + MIN;
    assert.equal(await pause(a), 2);
  });
});

test("#264: several serves writing holds at the same time lose none", async () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), ".cache", "factory", "holds");
  const t = Date.now();
  const go = t + 400;
  // Twelve processes, each its own serve, write at the same instant: eight accounts, some met by two serves at once.
  const writers = Array.from({ length: 12 }, (_, i) => ({ account: `acct-${i % 8}`, reset: t + (60 + i) * MIN }));
  const script = `const { accountHolds } = await import(${JSON.stringify(HOLDS)}); const [dir, account, reset, now, go] = process.argv.slice(1); while (Date.now() < Number(go)); accountHolds({ dir }).limit({ harness: "claude", account, reset: Number(reset), now: Number(now) });`;
  await Promise.all(
    writers.map(
      (w) =>
        new Promise((ok, fail) => {
          const p = spawn(process.execPath, ["--input-type=module", "-e", script, dir, w.account, String(w.reset), String(t), String(go)], { stdio: "inherit" });
          p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`writer exit ${code}`))));
        }),
    ),
  );
  const holds = accountHolds({ dir });
  for (let i = 0; i < 8; i++) {
    const latest = Math.max(...writers.filter((w) => w.account === `acct-${i}`).map((w) => w.reset));
    assert.equal(holds.until(`acct-${i}`, t), latest, `acct-${i}: held to its latest reset`);
  }
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 12);
});

test("#264: no sandbox may write the holds; a record a sandbox or another user could have made is not read", () => {
  const h = fakeHome();
  const dir = holdsDir(h);
  const t = Date.now();
  accountHolds({ dir }).limit({ harness: "claude", account: "alpha", reset: t + 60 * MIN, now: t });
  for (const harness of ["claude", "codex", "copilot"]) {
    const fs = harnessOuterSettings({ harness, writable: [join(h, "work", "repo"), join(h, ".cache", "factory", "s", "8-abcdef")], home: h, env: {} }).filesystem;
    assert.ok(fs.denyWrite.includes(dir), `${harness}: the holds are read-only in its outer sandbox`);
    assert.ok(!fs.allowWrite.some((p) => within(dir, p) || within(p, dir)), `${harness}: no writable path is in or around the holds`);
  }
  // Planted records: a link, one others may write, one with a second link. None holds beta.
  const elsewhere = join(h, "work", "planted.json");
  writeFileSync(elsewhere, JSON.stringify({ harness: "claude", account: "beta", until: t + 60 * MIN, streak: 0, at: t }));
  symlinkSync(elsewhere, join(dir, "beta.0000000000000001.json"));
  writeFileSync(join(dir, "beta.0000000000000002.json"), readFileSync(elsewhere), { mode: 0o666 });
  chmodSync(join(dir, "beta.0000000000000002.json"), 0o666);
  const holds = accountHolds({ dir });
  assert.equal(holds.until("beta", t), null);
  assert.equal(holds.until("alpha", t), t + 60 * MIN);
  // A holds folder that is a link is not read either.
  const other = realpathSync(mkdtempSync(join(tmpdir(), "holds-link-")));
  const linked = join(other, "holds");
  symlinkSync(dir, linked);
  assert.equal(accountHolds({ dir: linked }).until("alpha", t), null);
  assert.ok(existsSync(join(dir)));
  assert.deepEqual(LIMIT_BACKOFF_MS, [2, 5, 10, 15].map((m) => m * MIN));
});

test("#264: with no accounts declared, a hold is the login's: two serves on two Claude Code folders never hold each other, two on one folder do", async () => {
  const h = fakeHome({ declared: false });
  const t = Date.now();
  await withHome(h, async () => {
    const on = (folder) => (process.env.CLAUDE_CONFIG_DIR = join(h, "work", folder));
    on("claude-a");
    const a = serveOn(h, () => t);
    a.result = limited(t + 180 * MIN, t);
    a.outagePaused(8, await a.stage(8, "work", "worker.mjs", []));
    // Another serve on another login: nothing held, its stage runs.
    on("claude-b");
    const b = serveOn(h, () => t);
    assert.equal(b.limitHold(["factory:objective"]), null);
    b.result = { exit: "delivered", tokens: { output: 10 } };
    assert.equal((await b.stage(8, "work", "worker.mjs", [])).exit, "delivered");
    assert.equal(b.ran(), 1);
    // Another serve (or a restarted one) on the first login: held, nothing starts.
    on("claude-a");
    const c = serveOn(h, () => t);
    assert.match(c.limitHold(["factory:objective"]), /^claude's usage limit is spent until /);
    assert.equal((await c.stage(8, "work", "worker.mjs", [])).exit, "paused");
    assert.equal(c.ran(), 0);
  });
  // The key is the login's path, hashed: no path in the record.
  for (const f of readdirSync(holdsDir(h))) {
    assert.match(f, /^claude@[0-9a-f]{12}\.[0-9a-f]{16}\.json$/);
    assert.ok(!readFileSync(join(holdsDir(h), f), "utf8").includes(h));
  }
});

test("#264: a Copilot token from serve's environment names no login: its hold stays in that serve's memory", async () => {
  const h = fakeHome({ declared: false });
  const t = Date.now();
  await withHome(h, async () => {
    process.env.COPILOT_GITHUB_TOKEN = "dummy";
    const a = serveOn(h, () => t);
    const hold = a.holdOf({ name: "copilot", harness: "copilot", declared: false });
    assert.deepEqual(hold, { key: "copilot@env", shared: false });
    a.limitPaused(8, { exit: "paused", stage: "work", account: "copilot", hold, usageLimit: { harness: "copilot", reset: new Date(t + 60 * MIN).toISOString(), since: new Date(t).toISOString() } });
    assert.equal(a.limitUntil(hold), t + 60 * MIN);
    assert.match(a.limitHold(["factory:objective", "factory:harness:copilot"]), /^copilot's usage limit is spent until /);
    assert.equal(serveOn(h, () => t).limitUntil(hold), null, "another serve does not see it");
    assert.deepEqual(readdirSync(holdsDir(h)), []);
    // A token file in ~/.config/factory is a login: shared, keyed by its path, never its value.
    delete process.env.COPILOT_GITHUB_TOKEN;
    assert.equal(a.holdOf({ name: "copilot", harness: "copilot", declared: false }).shared, true);
  });
});

test("#264: a record is held to the longest window, a record from a later clock does not pin the streak, a served pass's record lasts as long as the hold, and a key no file may carry stays in memory", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now();
  const errors = [];
  const holds = accountHolds({ dir, onError: (e) => errors.push(e.message) });
  // Hand-made: an end past any window (toISOString would throw on it), and one stamped a day ahead with a long streak.
  writeFileSync(join(dir, "alpha.00000000000000a1.json"), JSON.stringify({ harness: "claude", account: "alpha", until: 8.9e15, streak: 0, at: t }), { mode: 0o600 });
  writeFileSync(join(dir, "beta.00000000000000b1.json"), JSON.stringify({ harness: "claude", account: "beta", until: t - MIN, streak: 3, at: t + 24 * 60 * MIN }), { mode: 0o600 });
  assert.equal(holds.until("alpha", t), t + HOLD_MAX_MS);
  assert.doesNotThrow(() => new Date(holds.until("alpha", t)).toISOString());
  assert.equal(holds.limit({ harness: "claude", account: "gamma", reset: t + 30 * 24 * 60 * MIN, now: t }), t + HOLD_MAX_MS);
  // beta: a pass completes after the later-clock record; the streak ends and the next refusal is held 2 minutes.
  holds.served({ harness: "claude", account: "beta", now: t, started: t - 1 });
  assert.equal(holds.limit({ harness: "claude", account: "beta", reset: t - MIN, now: t + 1 }), t + 1 + LIMIT_BACKOFF_MS[0]);
  // A pass served while held: its record lasts as long as the hold, so the streak does not come back when it is forgotten.
  const d = { harness: "claude", account: "delta" };
  const end = holds.limit({ ...d, reset: t - MIN, now: t });
  holds.served({ ...d, now: t + 1000, started: t + 500 });
  assert.equal(holds.limit({ ...d, reset: end - MIN, now: t + 1000 + HOLD_FORGET_MS + 1 }), t + 1000 + HOLD_FORGET_MS + 1 + LIMIT_BACKOFF_MS[0]);
  // A key no file may be named by: kept in memory, and said.
  holds.limit({ harness: "claude", account: "Bad/Key", reset: t + 60 * MIN, now: t });
  assert.equal(holds.until("Bad/Key", t), t + 60 * MIN);
  assert.equal(errors.length, 1);
});
