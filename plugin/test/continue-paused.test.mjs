// #257: a local work stage paused on its harness's usage limit continues where it stopped, on its kept checkout and in
// its own session, only while the branch on GitHub, the newest restart record, the Running stint and the Objective's
// text are as the pause recorded them; one decider (the worker's enterStage), which cleans when it starts fresh.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLEAN_REFUSED, CONTINUE_GUARDS, checkoutHolds, continueDecision, continuePrompt, enterStage, installEnd, keptPrompt, lastStage, loginOf, pauseRecord } from "../scripts/lib/continue.mjs";
import { UsageLimitReached, runHarness } from "../scripts/lib/harness.mjs";
import { claudeProject, gitPinFile, pinGitDir, prepareClone } from "../scripts/lib/local.mjs";
import { exec } from "../scripts/lib/proc.mjs";
import { installCommand, installDeps } from "../scripts/lib/checkout.mjs";
import { restoreTranscript, saveTranscript, usageLimitExit, writeUsage } from "../scripts/lib/session.mjs";
import { Local } from "../scripts/local.mjs";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const STAMP = (n) => `2026-11-14T0${n}-00-00-000Z`;
const RESET = "2026-11-14T23:00:00.000Z";

/** A clone on factory/7 as a paused work pass left it: a pushed head, a commit on it, a change, untracked and ignored files. */
function pausedClone(root) {
  const clone = join(root, "repo");
  const git = (...a) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", clone], { env: GIT_ENV });
  writeFileSync(join(clone, ".gitignore"), "node_modules/\n*.gen\n");
  writeFileSync(join(clone, "app.txt"), "v1\n");
  // Tracked although .gitignore matches it (added with -f): a snapshot built with `git add -A` lost this one.
  writeFileSync(join(clone, "schema.gen"), "tracked\n");
  git("add", ".");
  git("add", "-f", "schema.gen");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "factory/7");
  const pushed = git("rev-parse", "HEAD").trim();
  writeFileSync(join(clone, "app.txt"), "v2\n");
  git("commit", "-q", "-am", "unpushed work");
  writeFileSync(join(clone, "app.txt"), "v3 half-done\n");
  writeFileSync(join(clone, "schema.gen"), "tracked, changed\n");
  writeFileSync(join(clone, "notes.txt"), "untracked work\n");
  mkdirSync(join(clone, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(clone, "node_modules", "dep", "index.js"), "x\n");
  return { clone, git, pushed };
}

/** outbox.mjs putOn's own command: the checkout forced onto the branch at `ref`. */
const putOn = (clone, ref) => execFileSync("sh", ["-c", 'git -C "$1" rebase --quit >/dev/null 2>&1; exec git -C "$1" checkout -q -f -B "$2" "$3"', "sh", clone, "factory/7", ref], { env: GIT_ENV });

/** The four guards as they stand, and the harness and login, as worker.mjs reads them now. */
const guardsNow = (over = {}) => ({ branch: "a".repeat(40), restart: "2026-11-14T01:00:00.000Z", running: "2026-11-14T01:05:00Z", text: "f".repeat(64), harness: "claude", login: loginOf("claude"), ...over });

/** A paused work stage's directory, its result.json written by the real usageLimitExit and writeUsage. */
async function pausedStage(ws, n, { pause, session = null, local = true } = {}) {
  const dir = join(ws, `usage-work-${STAMP(n)}`);
  mkdirSync(dir, { recursive: true });
  const e = new UsageLimitReached({ harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", message: "m", resetAt: Date.parse(RESET) }, { since: Date.parse(RESET) - 3600_000, label: "work-1" });
  await usageLimitExit(e, { local, records: [], pause, block: async () => {}, finish: async (exit, reason, outage, usageLimit) => writeUsage(dir, { harness: "claude", model: null, records: [], passes: 0, exit, reason, credentialBasis: "login", usageLimit, session }) });
  return dir;
}

test("the pause's record goes through the real usageLimitExit into result.json, locally only, and the next stage reads it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cont-rec-"));
  const now = guardsNow();
  const pause = pauseRecord({ ...now });
  assert.deepEqual(Object.keys(CONTINUE_GUARDS), ["branch", "restart", "running", "text"]);
  assert.deepEqual(pause, { stage: "work", branch: now.branch, restart: now.restart, running: now.running, text: now.text, harness: "claude", login: now.login });
  assert.match(pause.login, /^[0-9a-f]{16}$/, "a hash of the login folder, never its path");
  await pausedStage(ws, 1, { pause });
  const last = lastStage(ws, join(ws, `usage-work-${STAMP(2)}`));
  assert.equal(last.name, `usage-work-${STAMP(1)}`);
  assert.deepEqual(last.result.usageLimit.continue, pause);
  assert.equal(continueDecision({ last, now }).continue, true);
  // Off the local route nothing resumes a stage: no record, and the stage Blocks.
  const off = mkdtempSync(join(tmpdir(), "cont-off-"));
  const dir = join(off, `usage-work-${STAMP(1)}`);
  mkdirSync(dir);
  const e = new UsageLimitReached({ harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", resetAt: Date.parse(RESET) }, { since: 0, label: "work-1" });
  let ended;
  await usageLimitExit(e, { local: false, records: [], pause, block: async () => {}, finish: async (...a) => (ended = a) });
  assert.equal(ended[0], "blocked");
  assert.equal(ended[3].continue, undefined);
});

test("a work stage's start leaves the clone as it is for the worker to decide; a review stage's start still cleans it", async () => {
  const dev = mkdtempSync(join(tmpdir(), "cont-st-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", stopping: false, firstSetup: new Map(), children: new Set() });
  const clone = join(local.ws(7), "repo");
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone], { env: GIT_ENV });
  pinGitDir(clone, gitPinFile(local.ws(7)));
  local.harnessFor = async () => ({ ok: true, harness: "claude" });
  // srt here runs the clone's git as it is.
  const bin = join(dev, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "srt"), '#!/bin/sh\nshift 3\nexec "$@"\n');
  chmodSync(join(bin, "srt"), 0o755);
  const caches = [join(dev, "pnpm"), join(dev, "bun")];
  for (const d of caches) mkdirSync(d);
  local.stageEnv = (issue, usageDir, c, stageTmp) => ({ PATH: `${bin}:${process.env.PATH}`, GITHUB_API_URL: "http://127.0.0.1:9", FACTORY_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1] });
  // The stage's process is stopped as it starts: what matters is what its start did to the clone.
  local.children = {
    add(child) {
      child.kill("SIGKILL");
      throw new Error("stopped at its start");
    },
  };
  writeFileSync(join(clone, "notes.txt"), "the paused pass's untracked work\n");
  await assert.rejects(local.stage(7, "work", "worker.mjs", []), /stopped at its start/);
  assert.ok(existsSync(join(clone, "notes.txt")), "the work stage's own decision cleans or keeps it (lib/continue.mjs enterStage)");
  await assert.rejects(local.stage(7, "review", "review.mjs", []), /stopped at its start/);
  assert.equal(existsSync(join(clone, "notes.txt")), false, "a review stage never continues: its start cleans as before");
});

test("all four guards unchanged: the stage continues on the kept tree, nothing cleaned, and Claude's session resumes under another config folder, its spend counted once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cont-go-"));
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, FACTORY_LOCAL: process.env.FACTORY_LOCAL, PATH: process.env.PATH };
  try {
    const { clone, git, pushed } = pausedClone(root);
    const ws = root;
    const id = "00000000-0000-0000-0000-000000000257";
    // The paused session, on account A, with Claude Code's running total at the pause.
    process.env.FACTORY_LOCAL = "1";
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-a");
    const project = join(root, "claude-a", "projects", claudeProject(clone));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), `${JSON.stringify({ type: "user", message: { content: "the task" } })}\n${JSON.stringify({ type: "cost-state", sessionId: id, totalCostUSD: 1, modelUsage: {} })}\n`);
    const pausedDir = join(ws, `usage-work-${STAMP(1)}`);
    mkdirSync(pausedDir);
    const session = saveTranscript({ harness: "claude", sessionId: id, usageDir: pausedDir, checkout: clone });
    const now = guardsNow({ branch: pushed });
    await pausedStage(ws, 1, { pause: pauseRecord({ ...now }), session });
    // The next work stage runs on account B: another config folder, which holds no copy of the session.
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-b");
    const own = join(ws, `usage-work-${STAMP(2)}`);
    mkdirSync(own);
    let cleaned = 0;
    const entry = await enterStage({
      ws,
      own,
      now: async () => ({ ...now, login: loginOf("claude") }),
      holds: (pause) => checkoutHolds((args) => exec("git", ["-C", clone, ...args], { env: GIT_ENV }), "factory/7", pause),
      putOn: async () => assert.fail("the kept tree is not put on the branch"),
      clean: async () => (cleaned += 1),
      restore: (from) => restoreTranscript({ checkout: clone, workDir: ws, harness: "claude", only: from }),
    });
    assert.equal(entry.continue, true);
    assert.equal(entry.from, `usage-work-${STAMP(1)}`);
    assert.equal(entry.carry, "", "Claude carries its session to another config folder");
    assert.deepEqual(entry.session, { id, from: `usage-work-${STAMP(1)}`, reason: "" });
    assert.ok(existsSync(join(root, "claude-b", "projects", claudeProject(clone), `${id}.jsonl`)), "the session put back where account B's Claude Code looks");
    assert.equal(cleaned, 0, "nothing of the paused pass is cleaned");
    // The tree stays in place: the unpushed commit, the uncommitted changes (a tracked-but-ignored file's too), untracked and ignored files.
    assert.equal(git("log", "-1", "--format=%s").trim(), "unpushed work");
    assert.equal(readFileSync(join(clone, "app.txt"), "utf8"), "v3 half-done\n");
    assert.equal(readFileSync(join(clone, "schema.gen"), "utf8"), "tracked, changed\n");
    assert.ok(existsSync(join(clone, "notes.txt")) && existsSync(join(clone, "node_modules", "dep", "index.js")));
    // The resumed pass, real runHarness on a fake Claude Code: --resume with the continue prompt, its own share counted.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(root, "call.json"))}, JSON.stringify({ args, prompt: fs.readFileSync(0, "utf8") }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, session_id: args[args.indexOf("--resume") + 1], total_cost_usd: 1.25, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} }));
`, { mode: 0o755 });
    delete process.env.FACTORY_LOCAL;
    process.env.PATH = `${bin}:${saved.PATH}`;
    const dirs = { in: join(root, "h", "in"), out: join(root, "h", "out") };
    const rec = await runHarness({ harness: "claude", model: "claude-fable-5-2", prompt: continuePrompt(dirs), freshPrompt: keptPrompt("the task card"), resume: entry.session.id, maxUsd: 0, cwd: clone, env: { PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
    const call = JSON.parse(readFileSync(join(root, "call.json"), "utf8"));
    assert.equal(call.args[call.args.indexOf("--resume") + 1], id);
    assert.ok(call.prompt.includes(`FACTORY_IN is now ${dirs.in}`) && call.prompt.includes(`FACTORY_OUT is now ${dirs.out}`), "the new hand-off folders restated");
    assert.match(call.prompt, /plan\.md.*exit\.json/s, "it ends with a current plan and exit record of its own");
    assert.match(call.prompt, /Read \$FACTORY_IN\/decisions\.md again: it holds every maintainer decision, those made since you stopped included/);
    assert.ok(Math.abs(rec.usd - 0.25) < 1e-9, `the resumed pass counts its own share, not the session's total: ${rec.usd}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("any guard changed since the pause: the stage starts fresh, says which, and cleans the abandoned pass's untracked files; ignored files stay", async () => {
  const run = (inner) => exec(inner[0], inner.slice(1), { env: GIT_ENV });
  for (const [key, value] of [["branch", "b".repeat(40)], ["branch", ""], ["restart", "2026-11-14T02:00:00.000Z"], ["running", "2026-11-14T02:05:00Z"], ["text", "e".repeat(64)]]) {
    const root = mkdtempSync(join(tmpdir(), "cont-fresh-"));
    const { clone, pushed } = pausedClone(root);
    const now = guardsNow({ branch: pushed });
    await pausedStage(root, 1, { pause: pauseRecord({ ...now }) });
    let restored = 0;
    const entry = await enterStage({
      ws: root,
      own: join(root, `usage-work-${STAMP(2)}`),
      now: async () => ({ ...now, [key]: value }),
      holds: async () => "",
      putOn: async () => putOn(clone, pushed),
      clean: () => prepareClone(clone, [], run, { fresh: true }),
      restore: async () => (restored += 1),
    });
    assert.equal(entry.continue, false, key);
    assert.deepEqual(entry.changed, [key]);
    assert.equal(entry.reason, `${CONTINUE_GUARDS[key]} changed since the pause`);
    assert.equal(restored, 0, "no session restored");
    assert.equal(existsSync(join(clone, "notes.txt")), false, "the abandoned pass's untracked file is cleaned");
    assert.ok(existsSync(join(clone, "node_modules", "dep", "index.js")), "ignored files (the dependencies) stay");
    assert.ok(existsSync(join(clone, "schema.gen")), "a tracked file is the checkout's to reset (outbox.mjs putOn), never removed here");
  }
  // Two at once: both named.
  const last = { name: "usage-work-x", result: { exit: "paused", usageLimit: { continue: pauseRecord(guardsNow()) } } };
  const d = continueDecision({ last, now: guardsNow({ restart: null, text: "0".repeat(64) }) });
  assert.deepEqual(d.changed, ["restart", "text"]);
  assert.equal(d.reason, "the newest restart record and the Objective's text changed since the pause");
});

test("nothing to continue (no pause, a review's or a send-back's end, a later stage, a record cut short, a moved checkout): fresh and cleaned, guards unread", async () => {
  const cases = {
    "no earlier stage": async () => {},
    "a stage that paused with no record (a review stage, a fix pass, a send-back)": (ws) => pausedStage(ws, 1, { pause: null }),
    "a later stage after the pause, whose process ran and ended without a record": async (ws) => {
      await pausedStage(ws, 1, { pause: pauseRecord(guardsNow()) });
      mkdirSync(join(ws, `usage-work-${STAMP(2)}`));
      writeFileSync(join(ws, `usage-work-${STAMP(2)}`, "stage.log"), "doctor: PASS\n");
    },
    "a later stage after the pause, its loop killed while it ran": async (ws) => {
      await pausedStage(ws, 1, { pause: pauseRecord(guardsNow()) });
      mkdirSync(join(ws, `usage-work-${STAMP(2)}`));
      writeFileSync(join(ws, `usage-work-${STAMP(2)}`, "stage-process.json"), "{}");
    },
    "a later review stage after the pause": async (ws) => {
      await pausedStage(ws, 1, { pause: pauseRecord(guardsNow()) });
      mkdirSync(join(ws, `usage-review-${STAMP(2)}`));
      writeFileSync(join(ws, `usage-review-${STAMP(2)}`, "result.json"), JSON.stringify({ exit: "delivered" }));
    },
  };
  for (const [what, make] of Object.entries(cases)) {
    const ws = mkdtempSync(join(tmpdir(), "cont-none-"));
    await make(ws);
    let read = 0;
    let cleaned = 0;
    const entry = await enterStage({ ws, own: join(ws, `usage-work-${STAMP(3)}`), now: async () => (read += 1, guardsNow()), holds: async () => "", putOn: async () => {}, clean: async () => (cleaned += 1), restore: async () => assert.fail("nothing restored") });
    assert.deepEqual(entry, { continue: false, from: null, changed: [], reason: null }, what);
    assert.equal(read, 0, `${what}: no GitHub read for it`);
    assert.equal(cleaned, 1, `${what}: cleaned as every fresh start`);
  }
  // A record without its guards.
  const cut = { name: "usage-work-x", result: { exit: "paused", usageLimit: { continue: { stage: "work", branch: "", text: "", running: null } } } };
  assert.equal(continueDecision({ last: cut, now: guardsNow() }).reason, "the pause's record is incomplete");
  // Guards that cannot be read, or a checkout that no longer holds the work: fresh, cleaned, named.
  for (const [what, opts, reason] of [
    ["unread", { now: async () => Promise.reject(new Error("502")) }, "the guards could not be read"],
    ["moved", { holds: async () => "the checkout is no longer on the paused pass's branch" }, "the checkout is no longer on the paused pass's branch"],
  ]) {
    const ws = mkdtempSync(join(tmpdir(), "cont-held-"));
    await pausedStage(ws, 1, { pause: pauseRecord(guardsNow()) });
    let cleaned = 0;
    const entry = await enterStage({ ws, own: join(ws, `usage-work-${STAMP(2)}`), now: async () => guardsNow(), holds: async () => "", putOn: async () => {}, clean: async () => (cleaned += 1), restore: async () => assert.fail("nothing restored"), ...opts });
    assert.equal(entry.continue, false, what);
    assert.equal(entry.reason, reason);
    assert.equal(cleaned, 1);
  }
});

test("checkoutHolds: the checkout on the branch, built on the head the pause recorded; else why not", async () => {
  const root = mkdtempSync(join(tmpdir(), "cont-holds-"));
  const { clone, git, pushed } = pausedClone(root);
  const g = (args) => exec("git", ["-C", clone, ...args], { env: GIT_ENV });
  assert.equal(await checkoutHolds(g, "factory/7", { branch: pushed }), "");
  assert.equal(await checkoutHolds(g, "factory/7", { branch: "" }), "", "a branch not on GitHub at the pause: its own commits only");
  git("checkout", "-q", "--orphan", "other");
  git("commit", "-q", "-m", "elsewhere");
  git("checkout", "-q", "-B", "factory/7");
  assert.equal(await checkoutHolds(g, "factory/7", { branch: pushed }), "the checkout no longer holds the branch head the paused pass built on");
  git("checkout", "-q", "-f", "main");
  assert.equal(await checkoutHolds(g, "factory/7", { branch: pushed }), "the checkout is no longer on the paused pass's branch");
});

test("which session carries over: Claude under any config folder; Codex on its own login only (a fresh thread on the kept tree under another); Copilot fresh", () => {
  const last = (pause) => ({ name: "usage-work-x", result: { exit: "paused", usageLimit: { continue: pause } } });
  const home = mkdtempSync(join(tmpdir(), "cont-login-"));
  const a = loginOf("codex", { CODEX_HOME: join(home, "a") });
  const b = loginOf("codex", { CODEX_HOME: join(home, "b") });
  assert.notEqual(a, b);
  assert.equal(loginOf("codex", {}, home), loginOf("codex", { CODEX_HOME: join(home, ".codex") }), "no CODEX_HOME: the default home");
  assert.equal(loginOf("copilot", {}), null);
  const claudeA = loginOf("claude", { CLAUDE_CONFIG_DIR: join(home, "a") });
  const claudeB = loginOf("claude", { CLAUDE_CONFIG_DIR: join(home, "b") });
  assert.equal(continueDecision({ last: last({ ...pauseRecord(guardsNow()), login: claudeA }), now: guardsNow({ login: claudeB }) }).carry, "");
  const codex = { ...pauseRecord({ ...guardsNow(), harness: "codex", env: { CODEX_HOME: join(home, "a") } }) };
  assert.equal(codex.login, a);
  assert.equal(continueDecision({ last: last(codex), now: guardsNow({ harness: "codex", login: a }) }).carry, "");
  const moved = continueDecision({ last: last(codex), now: guardsNow({ harness: "codex", login: b }) });
  assert.equal(moved.continue, true, "the kept tree still continues");
  assert.match(moved.carry, /never resumes under another login/);
  assert.match(continueDecision({ last: last({ ...codex, harness: "copilot", login: null }), now: guardsNow({ harness: "copilot", login: null }) }).carry, /fresh session/);
  assert.match(continueDecision({ last: last(codex), now: guardsNow({ harness: "claude" }) }).carry, /the pause ran codex; this stage runs claude/);
});

test("a continued stage whose session does not carry over: no restore, and the task card says what the kept checkout holds", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cont-codex-"));
  const home = mkdtempSync(join(tmpdir(), "cont-codex-home-"));
  const pause = pauseRecord({ ...guardsNow(), harness: "codex", env: { CODEX_HOME: join(home, "a") } });
  await pausedStage(ws, 1, { pause });
  const entry = await enterStage({ ws, own: join(ws, `usage-work-${STAMP(2)}`), now: async () => guardsNow({ harness: "codex", login: loginOf("codex", { CODEX_HOME: join(home, "b") }) }), holds: async () => "", putOn: async () => assert.fail("the kept tree is not put on the branch"), clean: async () => assert.fail("the kept tree is not cleaned"), restore: async () => assert.fail("a Codex thread never resumes under another login") });
  assert.equal(entry.continue, true);
  assert.equal(entry.session, undefined);
  const card = keptPrompt("# Task card\n");
  assert.ok(card.startsWith("# Task card\n\n---\n\n"), "the whole card first, so it splits as every card does");
  assert.match(card, /Its work is still in this checkout/);
});

test("a fresh entry puts the checkout on the branch before it cleans: files the abandoned pass hid in its own .gitignore are removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cont-leak-"));
  const { clone, git, pushed } = pausedClone(root);
  // The abandoned pass ignored its own planted files: an untracked clean before putOn keeps them.
  writeFileSync(join(clone, ".gitignore"), "node_modules/\n*.gen\nleak/\n");
  mkdirSync(join(clone, "leak"));
  writeFileSync(join(clone, "leak", "planted.txt"), "x\n");
  await pausedStage(root, 1, { pause: pauseRecord(guardsNow({ branch: pushed })) });
  const order = [];
  const run = (inner) => exec(inner[0], inner.slice(1), { env: GIT_ENV });
  const entry = await enterStage({
    ws: root,
    own: join(root, `usage-work-${STAMP(2)}`),
    now: async () => guardsNow({ branch: "c".repeat(40) }),
    holds: async () => "",
    putOn: async () => (order.push("putOn"), putOn(clone, pushed)),
    clean: async () => (order.push("clean"), prepareClone(clone, [], run, { fresh: true })),
    restore: async () => assert.fail("nothing restored"),
  });
  assert.equal(entry.continue, false);
  assert.deepEqual(order, ["putOn", "clean"]);
  assert.equal(readFileSync(join(clone, ".gitignore"), "utf8"), "node_modules/\n*.gen\n", "the branch's .gitignore is back");
  assert.equal(existsSync(join(clone, "leak", "planted.txt")), false, "nothing for a later git add -A to commit");
  git("add", "-A");
  assert.equal(git("status", "--porcelain").trim(), "", "the checkout is the branch exactly");
});

test("a clean that fails on a fresh entry fails the entry, and the work stage Blocks on it with cause setup and no local path", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cont-cleanfail-"));
  await pausedStage(ws, 1, { pause: pauseRecord(guardsNow()) });
  const refused = Object.assign(new Error(CLEAN_REFUSED), { code: "clone-clean" });
  // prepareClone's own failure when the clone's sandbox command fails.
  const failing = () => prepareClone(join(ws, "repo"), [], async () => ({ code: 3, stdout: "", stderr: "refusing" }), { fresh: true });
  await assert.rejects(failing(), /could not be prepared in its sandbox/);
  await assert.rejects(enterStage({ ws, own: join(ws, `usage-work-${STAMP(2)}`), now: async () => guardsNow({ text: "0".repeat(64) }), holds: async () => "", putOn: async () => {}, clean: () => failing().catch(() => Promise.reject(refused)), restore: async () => assert.fail("nothing restored") }), (e) => e === refused);
  assert.doesNotMatch(CLEAN_REFUSED, /\/home|\/tmp|\/Users|\.factory\//, "no local path reaches GitHub");
  // worker.mjs: that failure Blocks the stage with cause setup before any harness, never a crash.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "worker.mjs"), "utf8");
  const at = src.indexOf('if (e?.code !== "clone-clean") throw e;');
  assert.ok(at > 0 && /cause: "setup"/.test(src.slice(at, at + 400)) && at < src.indexOf("await runHarness("), "Blocked with cause setup before the harness");
});

test("a stage directory whose process never ran (a stopping serve's start) does not hide the pause before it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cont-empty-"));
  await pausedStage(ws, 1, { pause: pauseRecord(guardsNow()) });
  mkdirSync(join(ws, `usage-work-${STAMP(2)}`));
  assert.equal(lastStage(ws, join(ws, `usage-work-${STAMP(3)}`)).name, `usage-work-${STAMP(1)}`);
  const entry = await enterStage({ ws, own: join(ws, `usage-work-${STAMP(3)}`), now: async () => guardsNow(), holds: async () => "", putOn: async () => assert.fail("kept"), clean: async () => assert.fail("kept"), restore: async () => ({ id: "s", from: `usage-work-${STAMP(1)}`, reason: "" }) });
  assert.equal(entry.continue, true);
  assert.equal(entry.from, `usage-work-${STAMP(1)}`);
});

test("a fresh work stage's clean that cannot remove a leftover fails with clone-clean; serve's best-effort clean still only warns", { skip: process.getuid?.() === 0 && "root removes anything" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cont-stuck-"));
  const { clone } = pausedClone(root);
  // An abandoned pass's untracked file git clean cannot remove (its directory read-only).
  mkdirSync(join(clone, "stuck"));
  writeFileSync(join(clone, "stuck", "planted.txt"), "x\n");
  chmodSync(join(clone, "stuck"), 0o555);
  const run = (inner) => exec(inner[0], inner.slice(1), { env: GIT_ENV });
  try {
    await prepareClone(clone, [], run, { fresh: true });
    assert.ok(existsSync(join(clone, "stuck", "planted.txt")), "best effort: left, with a warning");
    await assert.rejects(prepareClone(clone, [], run, { fresh: true, strict: true }), (e) => e.code === "clone-clean" && /could not all be removed/.test(e.message));
    // Through the decider, as worker.mjs calls it: the entry fails, and the worker Blocks on its clone-clean code.
    await pausedStage(root, 1, { pause: pauseRecord(guardsNow()) });
    await assert.rejects(enterStage({ ws: root, own: join(root, `usage-work-${STAMP(2)}`), now: async () => guardsNow({ text: "0".repeat(64) }), holds: async () => "", putOn: async () => {}, clean: () => prepareClone(clone, [], run, { fresh: true, strict: true }), restore: async () => assert.fail("nothing restored") }), (e) => e.code === "clone-clean");
  } finally {
    chmodSync(join(clone, "stuck"), 0o755);
  }
});

test("a continued stage's frozen install that fails on its unfinished dependency change does not Block: the pass is told and finishes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cont-npm-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } }));
  // The paused pass added a dependency to package.json and had not updated the lockfile yet.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }));
  const command = installCommand(dir, "auto");
  assert.equal(command, "npm ci --ignore-scripts");
  const env = { ...process.env, npm_config_offline: "true", npm_config_cache: join(dir, ".npm"), npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
  const result = await installDeps(dir, command, { env, timeoutMs: 120_000 });
  assert.equal(result.ok, false, "npm ci refuses a manifest its lockfile does not match");
  assert.deepEqual(installEnd(result, { continued: false, command }), { block: result.reason }, "a fresh stage Blocks on it, as before");
  const kept = installEnd(result, { continued: true, command });
  assert.equal(kept.block, undefined);
  assert.match(kept.note, /^Factory's install \(npm ci --ignore-scripts\) failed on this checkout.*lockfile included/);
  assert.ok(continuePrompt({ in: "/i", out: "/o" }, { note: kept.note }).endsWith(kept.note), "the resumed session is told");
  assert.ok(keptPrompt("# Task card\n", { note: kept.note }).endsWith(kept.note), "so is a fresh session on the kept checkout");
  assert.deepEqual(installEnd({ ok: true }, { continued: true, command }), {});
});
