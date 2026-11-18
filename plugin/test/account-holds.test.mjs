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
process.env.PENDULUM_PLUGIN_ROOT = root;
const { LIMIT_BACKOFF_MS, accountHolds, holdsDir } = await import("../scripts/lib/holds.mjs");
const { Local } = await import("../scripts/local.mjs");
const { accountsFile } = await import("../scripts/lib/accounts.mjs");
const { gitPinFile, harnessOuterSettings, pinGitDir } = await import("../scripts/lib/local.mjs");

const HOLDS = join(import.meta.dirname, "..", "scripts", "lib", "holds.mjs");
const MIN = 60_000;
const within = (p, d) => p === d || p.startsWith(`${d}/`);

/** A stand-in home with two Claude Code accounts declared, alpha (the default) and beta, or none. Every file is a dummy. */
function fakeHome({ declared = true } = {}) {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "holds-")));
  for (const d of [".claude", ".codex", ".config/pendulum", "work/claude-a", "work/claude-b"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "pendulum"), 0o700);
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
  loop.stageEnv = (issue, usageDir, c, stageTmp) => ({ PATH: `${bin}:${process.env.PATH}`, PENDULUM_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1], FAKE_RAN: ran, FAKE_RESULT: JSON.stringify(loop.result), ...(loop.during ? { FAKE_LIMIT: JSON.stringify(loop.during), FAKE_HOLDS: HOLDS, FAKE_HOLDS_DIR: holdsDir(h), FAKE_GO: join(dev, "go") } : {}) });
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
    await a.outagePaused(8, end);
    assert.equal(a.limitUntil({ key: "alpha", shared: true }), t + 180 * MIN);
    assert.equal(a.limitUntil({ key: "beta", shared: true }), null, "beta is not held");
    // Another repository's serve, and a serve started afresh: the machine's holds, read from disk.
    for (const b of [serveOn(h, () => t), serveOn(h, () => t)]) {
      assert.match(b.limitHold(["pendulum:objective"]), /^claude account alpha's usage limit is spent until /);
      assert.equal(b.limitHold(["pendulum:objective", "pendulum:harness:codex"]), null, "another harness's account starts");
      const held = await b.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.account, held.usageLimit.held, Date.parse(held.usageLimit.reset)], ["paused", "alpha", true, t + 180 * MIN]);
      assert.equal(b.ran(), 0, "nothing started on alpha: no call spent to find the limit again");
      await b.outagePaused(8, held);
      assert.equal(b.offline.get(8).reset, t + 180 * MIN, "it resumes the Objective after the reset");
    }
    // Past the reset, alpha starts again.
    t += 180 * MIN;
    const c = serveOn(h, () => t);
    assert.equal(c.limitHold(["pendulum:objective"]), null);
    c.result = { exit: "delivered", tokens: { output: 10 }, servedPasses: 1 };
    assert.equal((await c.stage(8, "work", "worker.mjs", [])).exit, "delivered");
    assert.equal(c.ran(), 1);
  });
  // The record: no secret, no path; and under Pendulum's cache folder, never ~/.config/pendulum.
  // A served stage that reported no quota reading leaves that fact too (#391): its account's quota file, no secret or path.
  const all = readdirSync(holdsDir(h));
  const files = all.filter((f) => f !== "alpha.quota.json");
  assert.ok(files.length > 0 && files.every((f) => /^alpha\.[0-9a-f]{16}\.json$/.test(f)), all.join(", "));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(holdsDir(h), "alpha.quota.json"), "utf8"))).sort(), ["account", "at", "harness", "silentAt", "windows"]);
  for (const f of files) assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(holdsDir(h), f), "utf8"))).sort(), ["account", "at", "harness", "streak", "until"]);
  assert.equal(lstatSync(holdsDir(h)).mode & 0o077, 0);
  assert.ok(!within(holdsDir(h), join(h, ".config", "pendulum")));
});

test("#264: several serves writing holds at the same time lose none", async () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), ".cache", "pendulum", "holds");
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
    const fs = harnessOuterSettings({ harness, writable: [join(h, "work", "repo"), join(h, ".cache", "pendulum", "s", "8-abcdef")], home: h, env: {} }).filesystem;
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

test("#421: pauses on GitHub's spent rate limit count from the first only while nothing is done between them: a harness pass served counts afresh, a decision call alone does not", async () => {
  const { writeUsage } = await import("../scripts/lib/session.mjs");
  const { keepDecision } = await import("../scripts/lib/harness.mjs");
  const h = fakeHome();
  let t = Date.parse("2026-11-14T08:00:00Z");
  await withHome(h, async () => {
    const loop = serveOn(h, () => t);
    // The result.json a stage paused on the spent quota writes (the real writeUsage), from its records: `pass` a harness
    // pass with `output` tokens served, `decision` a decision call made through the harness (harness.mjs keepDecision).
    const quota = ({ pass = null, decision = false }) => {
      const usage = mkdtempSync(join(h, "usage-"));
      const ended = new Date(t).toISOString();
      const records = [
        ...(decision ? [keepDecision({ harness: "claude", model: "claude-haiku", usd: 0.01, tokens: { input: 900, output: 40, cached: 0, written: 0 }, basis: "reported", started: ended, ended })] : []),
        ...(pass === null ? [] : [{ harness: "claude", model: "claude-opus-5-5", label: "work", usd: 0.1, tokens: { input: 1000, output: pass, cached: 0, written: 0 }, basis: "reported", started: ended, ended, ok: true }]),
      ];
      return writeUsage(usage, { harness: "claude", model: "claude-opus-5-5", records, passes: [], exit: "paused", reason: "GitHub's rate limit", outage: { host: "api.github.com", origin: "https://api.github.com", code: "RATE_LIMIT_SPENT", since: ended, reset: new Date(t + 60 * MIN).toISOString() } });
    };
    const first = t;
    loop.result = quota({});
    await loop.outagePaused(8, await loop.stage(8, "work", "worker.mjs", []));
    t += 80 * MIN;
    loop.result = quota({ pass: 0 });
    await loop.outagePaused(8, await loop.stage(8, "work", "worker.mjs", []));
    assert.equal(loop.offline.get(8).since, first, "nothing served between: the same outage");
    // A decision call through the harness (the plan-answer or edit check) before the quota ran out again: no progress.
    t += 80 * MIN;
    loop.result = quota({ decision: true });
    assert.equal(loop.result.tokens.output, 40, "the decision call's output is in the stage's totals");
    assert.equal(loop.result.servedPasses, 0);
    await loop.outagePaused(8, await loop.stage(8, "work", "worker.mjs", []));
    assert.equal(loop.offline.get(8).since, first, "a decision call alone is no progress: still the first pause's");
    t += 80 * MIN;
    loop.result = quota({ pass: 1200, decision: true });
    await loop.outagePaused(8, await loop.stage(8, "work", "worker.mjs", []));
    assert.equal(loop.offline.get(8).since, t, "a harness pass served since the last pause: counted from its own");
    assert.equal(loop.ran(), 4);
  });
});

