import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountEnv, accountsFile, declaredLogins, loadAccounts } from "../scripts/lib/accounts.mjs";
import { credentialPaths, gatewayKeyFile, gitPinFile, homePlaces, pinGitDir, stageLogin } from "../scripts/lib/local.mjs";
import { PENDULUM_CONTROL_KEYS, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { ranWith } from "../scripts/lib/choice.mjs";
import { harnessMarker } from "../scripts/lib/logic.mjs";
import { writeUsage } from "../scripts/lib/session.mjs";
import { harnessCell, objectiveAccounts, spendRecords, stageHarnessOf } from "../../bench/lib/objective.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

// A stand-in home with the default logins, a key folder, and account folders outside the names Pendulum searches for.
// Every file is a dummy.
function fakeHome() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "acct-")));
  for (const d of [".claude", ".codex", ".config/pendulum", "work/claude-a", "work/claude-b", "work/codex-a"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "pendulum"), 0o700);
  writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(h, ".claude.json"), "{}");
  writeFileSync(join(h, "work", "claude-a", ".credentials.json"), "{}");
  writeFileSync(join(h, "work", "claude-b", ".credentials.json"), "{}");
  writeFileSync(join(h, "work", "codex-a", "auth.json"), "{}");
  writeFileSync(join(h, ".config", "pendulum", "copilot-a"), "copilot-token-a\n", { mode: 0o600 });
  return h;
}
const declare = (h, v) => writeFileSync(accountsFile(h), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
const good = (h) => ({ claude: [{ name: "alpha", home: join(h, "work", "claude-a") }, { name: "beta", home: join(h, "work", "claude-b") }], codex: [{ name: "omega", home: join(h, "work", "codex-a") }], copilot: [{ name: "gh-one", token_file: join(h, ".config", "pendulum", "copilot-a") }] });
const covered = (list, p) => list.some((q) => p === q || p.startsWith(`${q}/`));
/** The problems loadAccounts finds for a declaration, as [account, why]; never a path of the machine in either. */
function problems(h, v, { env = {}, roots = [] } = {}) {
  declare(h, v);
  const r = loadAccounts({ home: h, env, roots });
  for (const p of r.problems || []) assert.ok(!`${p.account} ${p.why}`.includes(h), `no path: ${p.account}: ${p.why}`);
  return (r.problems || []).map((p) => [p.account, p.why]);
}

test("#263: every declared login is hidden from every other stage; a stage on one reads only its own", () => {
  const h = fakeHome();
  declare(h, good(h));
  const a = join(h, "work", "claude-a");
  const b = join(h, "work", "claude-b");
  const x = join(h, "work", "codex-a");
  // Outside every name Pendulum searches for, found only through the declaration.
  assert.deepEqual(declaredLogins(h), [{ harness: "claude", dir: a }, { harness: "claude", dir: b }, { harness: "codex", dir: x }]);
  const onA = credentialPaths(h, accountEnv({}, { name: "alpha", harness: "claude", declared: true, home: a }, h), { own: stageLogin("claude", { CLAUDE_CONFIG_DIR: a }, h) });
  assert.ok(onA.includes(b) && onA.includes(x), "the other accounts' folders whole");
  assert.ok(!onA.includes(a) && covered(onA, join(a, ".credentials.json")), "its own folder by its login only");
  const codexStage = credentialPaths(h, {}, { own: stageLogin("codex", { CODEX_HOME: x }, h) });
  for (const p of [a, b]) assert.ok(codexStage.includes(p), p);
  assert.ok(covered(credentialPaths(h, {}), join(h, ".config", "pendulum", "copilot-a")), "a Copilot account's token file");
  // Pendulum makes nothing in another account's folder for a stage's harness state.
  assert.throws(() => homePlaces("claude", { CLAUDE_CONFIG_DIR: a }, h).check(join(b, "hooks")), { code: "home-link" });
});

test("#263: the account's name is recorded in result.json, the progress comment's harness line and the scorecard; nothing else of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-"));
  const inputs = { harness: "claude", model: "claude-opus-5-5", subagentModel: "", reviewerModel: "" };
  const ran = ranWith(inputs, [], "alpha");
  assert.equal(ran.account, "alpha");
  assert.equal(ranWith(inputs, [], "../etc").account, undefined, "only an account name");
  assert.equal(ranWith(inputs, []).account, undefined, "none on Actions");
  writeUsage(dir, { harness: "claude", model: "m", records: [], passes: 0, exit: "delivered", reason: "", credentialBasis: null, ran });
  assert.equal(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).account, "alpha");
  const line = harnessMarker("claude", "claude-opus-5-5", ran);
  assert.equal(JSON.parse(/^<!-- pendulum:harness (\{.*\}) -->$/.exec(line)[1]).account, "alpha");
  assert.equal(stageHarnessOf(line).account, "alpha");
  // The scorecard: from usage artifacts' result.json, or a local stage's progress line.
  assert.deepEqual(objectiveAccounts([{ account: "alpha" }, { account: "beta" }, { account: "alpha" }, {}]), ["alpha", "beta"]);
  const collected = { issue: { number: 5 }, issueTimeline: [], issueComments: [{ id: 1, user: { login: "me" }, created_at: "2026-11-14T00:00:00Z", body: `<!-- pendulum:5:progress:work:1 -->\n${line}\n<!-- pendulum:spend {"usd":1} -->` }] };
  assert.deepEqual(spendRecords(collected, { app: "me" }).map((r) => r.account), ["alpha"]);
  assert.equal(harnessCell({ harness: "claude", models: { worker: "claude-opus-5-5" }, accounts: ["alpha"] }), "claude claude-opus-5-5; account alpha");
  assert.equal(harnessCell({ harness: "claude", models: { worker: "m" }, accounts: ["alpha", "beta"] }), "claude m; accounts alpha, beta");
  // The harness never sees it; the stage reads it to record it.
  assert.ok(PENDULUM_CONTROL_KEYS.includes("PENDULUM_STAGE_ACCOUNT"));
  assert.equal(scrubbedEnv({ PENDULUM_STAGE_ACCOUNT: "alpha" }).PENDULUM_STAGE_ACCOUNT, undefined);
  for (const f of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(ROOT, "plugin", "scripts", f), "utf8");
    assert.equal(src.split("ranWith(inputs, chosenLabels, process.env.PENDULUM_STAGE_ACCOUNT)").length - 1, 4, `${f}: its result.json (its end, a stop's and a cancel's) and its harness line`);
  }
});

/** A loop as the tests make one, on a fake home ($HOME, which os.homedir() reads), with one Objective's pinned clone. */
async function fakeLoop(h, harness = "claude") {
  const { Local } = await import("../scripts/local.mjs");
  const dev = join(h, "work", "repo");
  const local = Object.assign(Object.create(Local.prototype), { dev, harness, repoFull: "o/r", wf: {}, stopping: false, firstSetup: new Map(), children: new Set() });
  const clone = join(local.ws(8), "repo");
  mkdirSync(join(clone, ".git"), { recursive: true });
  pinGitDir(clone, gitPinFile(local.ws(8)));
  const usage = join(local.ws(8), "usage-work-1");
  mkdirSync(usage, { recursive: true });
  return { local, clone, usage };
}
async function withHome(h, env, fn) {
  const saved = Object.fromEntries(["HOME", ...Object.keys(env)].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: h, ...env });
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ------------------------------------------------------------------ security review of #294

test("#263: a Copilot token file may not be one of Pendulum's own secrets; a blank one is empty and an unreadable one refused", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "pendulum");
  const own = "its token file is one of Pendulum's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)";
  const one = (token_file, env = {}) => problems(h, { copilot: [{ name: "gh", token_file }] }, { env });
  assert.deepEqual(one(accountsFile(h)), [["gh", own]], "the accounts file itself");
  writeFileSync(gatewayKeyFile(h), "vck_dummy\n", { mode: 0o600 });
  assert.deepEqual(one(gatewayKeyFile(h)), [["gh", own]], "the AI Gateway key");
  mkdirSync(join(keys, "tokens", "acme"), { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "tokens", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "tokens", "acme", "app")), [["gh", own]], "a repository's GitHub token");
  writeFileSync(join(keys, "app.pem"), "-----BEGIN DUMMY-----\n", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "app.pem"), { PENDULUM_LOCAL_APP_KEY: "~/.config/pendulum/app.pem" }), [["gh", own]], "the App's key, by its real path");
  assert.deepEqual(one(join(keys, "app.pem")), [], "a file of that name is only the App's key when PENDULUM_LOCAL_APP_KEY names it");
  writeFileSync(join(keys, "blank"), " \n\t\n", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "blank")), [["gh", "its token file is empty"]]);
  // Write-only: no group or world bit, but Pendulum cannot read it. An account problem, never a throw at the stage.
  writeFileSync(join(keys, "write-only"), "copilot-token-w\n", { mode: 0o200 });
  chmodSync(join(keys, "write-only"), 0o200);
  assert.deepEqual(one(join(keys, "write-only")), [["gh", "its token file cannot be read by this user; chmod 600 it"]]);
});

test("#263: the accounts file is held to the rules for secrets: this user's, one link, in a folder no one else writes", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "pendulum");
  declare(h, good(h));
  assert.equal(loadAccounts({ home: h, env: {} }).ok, true);
  assert.deepEqual(loadAccounts({ home: h, env: {}, uid: process.getuid() + 1 }).problems, [{ account: "the accounts file", why: "the accounts file belongs to another user" }]);
  linkSync(accountsFile(h), join(h, "work", "accounts-copy.json"));
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "the accounts file has more than one hard link; keep one copy" }]);
  assert.equal(declaredLogins(h).length, 3, "what a refused file names is still hidden");
  rmSync(join(h, "work", "accounts-copy.json"));
  chmodSync(keys, 0o770);
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "~/.config/pendulum is writable by others; chmod 700 it" }]);
  chmodSync(keys, 0o700);
  assert.equal(loadAccounts({ home: h, env: {} }).ok, true);
});

test("#263, the real path: Pendulum's git on the clone before a stage gets no secret, a Copilot account's token included", async () => {
  const h = fakeHome();
  declare(h, good(h));
  const { local, clone, usage } = await fakeLoop(h, "copilot");
  rmSync(join(clone, ".git"), { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  pinGitDir(clone, gitPinFile(local.ws(8)));
  // srt stands where local mode's git sandbox would: it records the environment Pendulum's git starts with, then runs it.
  const bin = join(h, "bin");
  const seen = join(h, "srt-env.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "srt"), `#!/bin/sh\nenv >> "${seen}"\nshift 3\nexec "$@"\n`, { mode: 0o755 });
  const caches = [join(h, "pnpm"), join(h, "bun")];
  for (const d of caches) mkdirSync(d);
  local.harnessFor = async () => ({ ok: true, harness: "copilot", account: local.accountFor("copilot") });
  local.limitUntil = () => null;
  // The stage's env: the real Copilot part (its account's token), with the git sandbox's settings.
  local.stageEnv = (issue, usageDir, c, stageTmp, script, harness, hosts, account) => ({ PATH: `${bin}:${process.env.PATH}`, PENDULUM_LOCAL_SRT_GIT: join(h, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1], ...local.harnessEnv(issue, [stageTmp], c, usage, null, harness, undefined, account) });
  local.children = {
    add(child) {
      child.kill("SIGKILL");
      throw new Error("stop after the set-up");
    },
  };
  await withHome(h, { CLAUDE_CONFIG_DIR: join(h, "work", "claude-b"), CODEX_HOME: join(h, "work", "codex-a") }, () => assert.rejects(local.stage(8, "work", "worker.mjs", []), /stop after the set-up/));
  const env = readFileSync(seen, "utf8");
  assert.ok(env.includes("PENDULUM_LOCAL_SRT_GIT="), "srt ran Pendulum's git with its sandbox settings");
  assert.ok(!env.includes("copilot-token-a") && !env.includes("COPILOT_GITHUB_TOKEN="), "no Copilot token");
});

test("#305: Pendulum's own secrets are recognised by the file itself, however its name is spelled", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "pendulum");
  const own = "its token file is one of Pendulum's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)";
  const one = (token_file) => problems(h, { copilot: [{ name: "gh", token_file }] });
  // On a case-insensitive file system (macOS) `AI-Gateway-Key` is the key itself. Linux's are case-sensitive: a second
  // name for the same file stands in for that other spelling.
  writeFileSync(gatewayKeyFile(h), "vck_dummy\n", { mode: 0o600 });
  linkSync(gatewayKeyFile(h), join(keys, "AI-Gateway-Key"));
  assert.deepEqual(one(join(keys, "AI-Gateway-Key")), [["gh", own]], "the AI Gateway key");
  mkdirSync(join(keys, "tokens", "acme"), { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "tokens", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  linkSync(join(keys, "tokens", "acme", "app"), join(keys, "TOKENS-acme-app"));
  assert.deepEqual(one(join(keys, "TOKENS-acme-app")), [["gh", own]], "a repository's GitHub token");
  assert.deepEqual(one(join(keys, "copilot-a")), [], "a token file of its own still passes");
});

test("#318: a token Pendulum reads through a folder link under tokens/ is still one of its own secrets", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "pendulum");
  mkdirSync(join(keys, "store", "acme"), { recursive: true, mode: 0o700 });
  mkdirSync(join(keys, "tokens"), { mode: 0o700 });
  writeFileSync(join(keys, "store", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  // tokens/acme/app, which Pendulum reads as acme/app's token, is store/acme/app.
  symlinkSync(join(keys, "store", "acme"), join(keys, "tokens", "acme"));
  // And two links back up the tree, which a walk that follows links enters once.
  symlinkSync(".", join(keys, "tokens", "loop-a"));
  symlinkSync(keys, join(keys, "store", "acme", "up"));
  assert.deepEqual(problems(h, { copilot: [{ name: "gh", token_file: join(keys, "store", "acme", "app") }] }), [["gh", "its token file is one of Pendulum's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)"]]);
});

test("#318: a clone that cannot be prepared Blocks with git's cause, never a path outside the home; the log has the path", { skip: process.platform === "win32" }, async () => {
  const { logTo } = await import("../scripts/lib/inputs.mjs");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { prepareClone } = await import("../scripts/lib/local.mjs");
  const h = fakeHome();
  // A clone outside the home directory (a checkout under /srv), named by the line its set-up command failed with.
  const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "srv-"))), "checkout");
  const { local } = await fakeLoop(h);
  Object.assign(local, { repoFull: "acme/app", repo: { owner: "acme", name: "app", full: "acme/app" }, opts: { token: "t" } });
  const blocked = [];
  local.block = async (...a) => {
    blocked.push(a);
    throw new Error("the test's own end");
  };
  const lines = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/\/issues\/8$/.test(String(url))) return new Response(JSON.stringify({ number: 8, labels: [{ name: "pendulum:running" }] }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected ${url}`);
  };
  logTo({ write: (s) => lines.push(s) });
  try {
    // The clone's sandbox, its command failing as git does, with the clone's path on its last line.
    const run = () => exec("sh", ["-c", `echo "fatal: Unable to create '${outside}/.git/index.lock': File exists." >&2; exit 3`]);
    const failed = await prepareClone(outside, [], run, { fresh: true }).then(() => assert.fail("the set-up should fail"), (e) => e);
    await withHome(h, {}, async () => {
      // A review stage's set-up failing twice (lapse), and a work stage's start failing a third time (unstart).
      failed.stageSetup = "review";
      await local.lapse(8, null, failed);
      await local.lapse(8, null, failed);
      local.startFailures = new Map([[8, { count: 2, retryAt: 0 }]]);
      await local.unstart(8, Object.assign(failed, { startFailed: "work" }));
    });
  } finally {
    logTo(null);
    globalThis.fetch = real;
  }
  assert.equal(blocked.length, 2);
  for (const [, , reason] of blocked) {
    assert.match(reason, /the clone could not be prepared in its sandbox \(exit 3\): fatal: Unable to create '<path>': File exists\.; (this machine's|the job) log has its output/, "git's cause, its path replaced");
    assert.ok(!reason.includes(outside) && !reason.includes("srv-"), `no path: ${reason}`);
  }
  assert.ok(lines.some((l) => l.includes(`${outside}/.git/index.lock`)), "this machine's log has the output");
});
