import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ACCOUNT_NAME_MAX, accountEnv, accountReason, accountsFile, declaredLogins, defaultAccount, loadAccounts, sandboxRoots } from "../scripts/lib/accounts.mjs";
import { codexLocalConfig, credentialPaths, gatewayKeyFile, gitPinFile, harnessLogins, harnessOuterSettings, homePlaces, pinGitDir, stageLogin } from "../scripts/lib/local.mjs";
import { FACTORY_CONTROL_KEYS, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { ranWith } from "../scripts/lib/choice.mjs";
import { harnessMarker } from "../scripts/lib/logic.mjs";
import { writeUsage } from "../scripts/lib/session.mjs";
import { localAccountChecks } from "../scripts/doctor.mjs";
import { harnessCell, objectiveAccounts, spendRecords, stageHarnessOf } from "../../bench/lib/objective.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

// A stand-in home with the default logins, a key folder, and account folders outside the names Factory searches for.
// Every file is a dummy.
function fakeHome() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "acct-")));
  for (const d of [".claude", ".codex", ".config/factory", "work/claude-a", "work/claude-b", "work/codex-a"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "factory"), 0o700);
  writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(h, ".claude.json"), "{}");
  writeFileSync(join(h, "work", "claude-a", ".credentials.json"), "{}");
  writeFileSync(join(h, "work", "claude-b", ".credentials.json"), "{}");
  writeFileSync(join(h, "work", "codex-a", "auth.json"), "{}");
  writeFileSync(join(h, ".config", "factory", "copilot-a"), "copilot-token-a\n", { mode: 0o600 });
  return h;
}
const declare = (h, v) => writeFileSync(accountsFile(h), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
const good = (h) => ({ claude: [{ name: "alpha", home: join(h, "work", "claude-a") }, { name: "beta", home: join(h, "work", "claude-b") }], codex: [{ name: "omega", home: join(h, "work", "codex-a") }], copilot: [{ name: "gh-one", token_file: join(h, ".config", "factory", "copilot-a") }] });
const covered = (list, p) => list.some((q) => p === q || p.startsWith(`${q}/`));
/** The problems loadAccounts finds for a declaration, as [account, why]; never a path of the machine in either. */
function problems(h, v, { env = {}, roots = [] } = {}) {
  declare(h, v);
  const r = loadAccounts({ home: h, env, roots });
  for (const p of r.problems || []) assert.ok(!`${p.account} ${p.why}`.includes(h), `no path: ${p.account}: ${p.why}`);
  return (r.problems || []).map((p) => [p.account, p.why]);
}

test("#263: with nothing declared, every harness has one account named after it and a stage's env is today's", () => {
  const h = fakeHome();
  const r = loadAccounts({ home: h, env: {} });
  assert.deepEqual([r.ok, r.declared], [true, false]);
  for (const harness of ["claude", "codex", "copilot"]) assert.deepEqual(defaultAccount(r, harness), { name: harness, harness, declared: false });
  const env = { CLAUDE_CONFIG_DIR: join(h, "x"), CODEX_HOME: join(h, "y") };
  assert.equal(accountEnv(env, defaultAccount(r, "claude"), h), env, "the same env: nothing set, nothing removed");
  assert.deepEqual(declaredLogins(h), []);
  assert.deepEqual(harnessLogins(h, {}).map((l) => l.dir), [join(h, ".claude"), join(h, ".codex"), join(h, ".copilot"), join(h, ".config", "github-copilot")]);
});

test("#263: a declared account is used in place: its folder is set explicitly, never serve's own, and the first is the default", () => {
  const h = fakeHome();
  declare(h, good(h));
  const r = loadAccounts({ home: h, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const alpha = defaultAccount(r, "claude");
  assert.deepEqual(alpha, { name: "alpha", harness: "claude", declared: true, home: join(h, "work", "claude-a") });
  assert.deepEqual(defaultAccount(r, "copilot"), { name: "gh-one", harness: "copilot", declared: true, tokenFile: join(h, ".config", "factory", "copilot-a") });
  // Serve runs with CLAUDE_CONFIG_DIR on the second account: the stage still runs on the first, set explicitly.
  assert.equal(accountEnv({ CLAUDE_CONFIG_DIR: join(h, "work", "claude-b") }, alpha, h).CLAUDE_CONFIG_DIR, join(h, "work", "claude-a"));
  assert.equal(accountEnv({ CODEX_HOME: join(h, ".codex") }, defaultAccount(r, "codex"), h).CODEX_HOME, join(h, "work", "codex-a"));
  // The default ~/.claude as an account: CLAUDE_CONFIG_DIR unset, so Claude Code keeps its .claude.json in the home.
  assert.equal("CLAUDE_CONFIG_DIR" in accountEnv({ CLAUDE_CONFIG_DIR: join(h, "work", "claude-b") }, { name: "main", harness: "claude", declared: true, home: join(h, ".claude") }, h), false);
  // Nothing is copied: the folders hold what they held.
  assert.equal(readFileSync(join(h, "work", "claude-a", ".credentials.json"), "utf8"), "{}");
});

test("#263: every declared login is hidden from every other stage; a stage on one reads only its own", () => {
  const h = fakeHome();
  declare(h, good(h));
  const a = join(h, "work", "claude-a");
  const b = join(h, "work", "claude-b");
  const x = join(h, "work", "codex-a");
  // Outside every name Factory searches for, found only through the declaration.
  assert.deepEqual(declaredLogins(h), [{ harness: "claude", dir: a }, { harness: "claude", dir: b }, { harness: "codex", dir: x }]);
  const onA = credentialPaths(h, accountEnv({}, { name: "alpha", harness: "claude", declared: true, home: a }, h), { own: stageLogin("claude", { CLAUDE_CONFIG_DIR: a }, h) });
  assert.ok(onA.includes(b) && onA.includes(x), "the other accounts' folders whole");
  assert.ok(!onA.includes(a) && covered(onA, join(a, ".credentials.json")), "its own folder by its login only");
  const codexStage = credentialPaths(h, {}, { own: stageLogin("codex", { CODEX_HOME: x }, h) });
  for (const p of [a, b]) assert.ok(codexStage.includes(p), p);
  assert.ok(covered(credentialPaths(h, {}), join(h, ".config", "factory", "copilot-a")), "a Copilot account's token file");
  // Factory makes nothing in another account's folder for a stage's harness state.
  assert.throws(() => homePlaces("claude", { CLAUDE_CONFIG_DIR: a }, h).check(join(b, "hooks")), { code: "home-link" });
});

test("#263: a bad declaration is refused for each account, naming the account alone; Factory makes no account folder", () => {
  const h = fakeHome();
  const g = good(h);
  const one = (claude) => problems(h, { claude });
  assert.deepEqual(one([{ name: "Bad_Name", home: g.claude[0].home }]), [["claude account 1", `its name must be lowercase letters, digits and hyphens, starting with a letter or digit, at most ${ACCOUNT_NAME_MAX} characters`]]);
  assert.equal(one([{ name: "a".repeat(ACCOUNT_NAME_MAX + 1), home: g.claude[0].home }])[0][0], "claude account 1", "longer than a factory:account: label allows");
  assert.equal(ACCOUNT_NAME_MAX, 34);
  assert.deepEqual(problems(h, { claude: [g.claude[0]], codex: [{ name: "alpha", home: g.codex[0].home }] }), [["alpha", "the name is declared twice"]]);
  const missing = join(h, "work", "claude-gone");
  assert.deepEqual(one([{ name: "gone", home: missing }]), [["gone", "its folder does not exist; Factory never makes one"]]);
  assert.equal(existsSync(missing), false, "not made");
  symlinkSync(g.claude[0].home, join(h, "work", "claude-link"));
  assert.deepEqual(one([{ name: "linked", home: join(h, "work", "claude-link") }]), [["linked", "its folder is not at its real path (a link is on the way); declare the real path"]]);
  assert.deepEqual(one([{ name: "slash", home: `${g.claude[0].home}/` }]), [["slash", "its folder is not an absolute, normal path"]]);
  assert.deepEqual(one([{ name: "rel", home: "work/claude-a" }]), [["rel", "its folder is not an absolute, normal path"]]);
  writeFileSync(join(h, "work", "plain"), "");
  assert.deepEqual(one([{ name: "file", home: join(h, "work", "plain") }]), [["file", "its folder is not a directory"]]);
  assert.deepEqual(one([g.claude[0], { name: "twin", home: g.claude[0].home }]), [["alpha", "it is on the same folder as account twin"], ["twin", "it is on the same folder as account alpha"]]);
  mkdirSync(join(g.claude[0].home, "inner"));
  assert.deepEqual(one([g.claude[0], { name: "inner", home: join(g.claude[0].home, "inner") }]).map((p) => p[0]), ["alpha", "inner"], "nested, both ways");
  assert.deepEqual(one([{ name: "codexdir", home: join(h, ".codex") }]), [["codexdir", "its folder is in or around another Codex login"]]);
  mkdirSync(join(h, ".codex", "sub"));
  assert.deepEqual(one([{ name: "insidecodex", home: join(h, ".codex", "sub") }]), [["insidecodex", "its folder is in or around another Codex login"]]);
  assert.deepEqual(one([{ name: "whole", home: h }]).map((p) => p[0]), ["whole"], "around every login");
  mkdirSync(join(h, ".config", "factory", "c"));
  assert.deepEqual(one([{ name: "keys", home: join(h, ".config", "factory", "c") }]), [["keys", "its folder is in or around ~/.config/factory"]]);
  assert.deepEqual(one([{ name: "config", home: join(h, ".config") }]), [["config", "its folder is in or around ~/.config/factory"]]);
  // A directory a sandbox may write: this repository's clone (its .factory holds every Objective's), the stage temp base.
  const dev = join(h, "work", "repo");
  mkdirSync(join(dev, "acct"), { recursive: true });
  for (const [name, home] of [["inclone", join(dev, "acct")], ["aroundclone", join(h, "work")]]) {
    declare(h, { claude: [{ name, home }] });
    assert.match(loadAccounts({ home: h, env: {}, roots: sandboxRoots(dev, h, "linux") }).problems[0].why, /a directory a sandbox may write/, name);
  }
  mkdirSync(join(h, ".cache", "factory", "s", "x"), { recursive: true });
  declare(h, { claude: [{ name: "stagetmp", home: join(h, ".cache", "factory", "s", "x") }] });
  assert.match(loadAccounts({ home: h, env: {}, roots: sandboxRoots(dev, h, "linux") }).problems[0].why, /a directory a sandbox may write/);
});

test("#263: a Copilot token file follows the rules for local secrets", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  const one = (token_file) => problems(h, { copilot: [{ name: "gh", token_file }] });
  assert.deepEqual(one(join(keys, "copilot-a")), []);
  writeFileSync(join(h, "work", "tok"), "t", { mode: 0o600 });
  assert.deepEqual(one(join(h, "work", "tok")), [["gh", "its token file is not under ~/.config/factory, which no sandbox can read; move it there, don't copy it"]]);
  chmodSync(join(keys, "copilot-a"), 0o644);
  assert.deepEqual(one(join(keys, "copilot-a")), [["gh", "its token file is readable or writable by others; chmod 600 it"]]);
  chmodSync(join(keys, "copilot-a"), 0o600);
  linkSync(join(keys, "copilot-a"), join(keys, "copilot-a2"));
  assert.deepEqual(one(join(keys, "copilot-a")), [["gh", "its token file has more than one hard link; keep one copy"]]);
  rmSync(join(keys, "copilot-a2"));
  writeFileSync(join(keys, "empty"), "", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "empty")), [["gh", "its token file is empty"]]);
  symlinkSync(join(keys, "copilot-a"), join(keys, "via-link"));
  assert.deepEqual(one(join(keys, "via-link")), [["gh", "its token file is not at its real path (a link is on the way); declare the real path"]]);
  assert.deepEqual(one(join(keys, "absent")), [["gh", "its token file does not exist; Factory never makes one"]]);
  assert.deepEqual(problems(h, { copilot: [{ name: "gh", token_file: join(keys, "copilot-a") }, { name: "gh2", token_file: join(keys, "copilot-a") }] }), [["gh", "another account has the same token file"], ["gh2", "another account has the same token file"]]);
});

test("#263: the accounts file itself: a regular file only its owner writes, JSON naming the three harnesses; serve's own folder must be one of them", () => {
  const h = fakeHome();
  assert.deepEqual(problems(h, "{oops"), [["the accounts file", "the accounts file is not valid JSON"]]);
  assert.deepEqual(problems(h, { gemini: [] }), [["the accounts file", 'it names no harness Factory runs: "gemini"']]);
  assert.deepEqual(problems(h, { claude: { name: "x" } }), [["claude accounts", "they are not a list"]]);
  declare(h, {});
  chmodSync(accountsFile(h), 0o666);
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "the accounts file is writable by others; chmod 600 it" }]);
  rmSync(accountsFile(h));
  writeFileSync(join(h, "elsewhere.json"), "{}", { mode: 0o600 });
  symlinkSync(join(h, "elsewhere.json"), accountsFile(h));
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "the accounts file is not a regular file (a link or a folder)" }]);
  rmSync(accountsFile(h));
  // ~/.config/factory through a link (into a clone a sandbox writes, say): the deny by its literal path misses the file.
  const keys = join(h, ".config", "factory");
  const moved = join(h, "work", "keys");
  rmSync(keys, { recursive: true });
  mkdirSync(moved, { mode: 0o700 });
  symlinkSync(moved, keys);
  declare(h, { claude: [good(h).claude[0]] });
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "~/.config/factory is not a real directory (a link), so the sandboxes' deny of it does not cover the accounts file" }]);
  rmSync(keys);
  mkdirSync(keys, { mode: 0o700 });
  writeFileSync(join(keys, "copilot-a"), "copilot-token-a\n", { mode: 0o600 });
  // Serve's CLAUDE_CONFIG_DIR on a folder no search finds and no account declares: a stage's env would drop it unhidden.
  mkdirSync(join(h, "work", "claude-own"));
  assert.deepEqual(problems(h, { claude: [good(h).claude[0]] }, { env: { CLAUDE_CONFIG_DIR: join(h, "work", "claude-own") } }), [["CLAUDE_CONFIG_DIR", "this shell's CLAUDE_CONFIG_DIR names a folder no declared Claude Code account has; declare it as one, or unset CLAUDE_CONFIG_DIR"]]);
  assert.deepEqual(problems(h, good(h), { env: { CLAUDE_CONFIG_DIR: join(h, "work", "claude-b") } }), [], "a declared one");
  mkdirSync(join(h, ".claude-other"));
  assert.deepEqual(problems(h, good(h), { env: { CLAUDE_CONFIG_DIR: join(h, ".claude-other") } }), [], "one Factory's search finds and hides");
  assert.deepEqual(problems(h, { codex: good(h).codex }, { env: { CLAUDE_CONFIG_DIR: join(h, "work", "claude-own") } }), [], "no Claude Code account declared: serve's own stays the stage's");
  assert.match(accountReason([{ account: "alpha" }, { account: "beta" }, { account: "alpha" }]), /^local mode: `alpha`, `beta` in this machine's account declaration cannot be used \(account\)/);
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
  assert.equal(JSON.parse(/^<!-- factory:harness (\{.*\}) -->$/.exec(line)[1]).account, "alpha");
  assert.equal(stageHarnessOf(line).account, "alpha");
  // The scorecard: from usage artifacts' result.json, or a local stage's progress line.
  assert.deepEqual(objectiveAccounts([{ account: "alpha" }, { account: "beta" }, { account: "alpha" }, {}]), ["alpha", "beta"]);
  const collected = { issue: { number: 5 }, issueTimeline: [], issueComments: [{ id: 1, user: { login: "me" }, created_at: "2026-11-14T00:00:00Z", body: `<!-- factory:5:progress:work:1 -->\n${line}\n<!-- factory:spend {"usd":1} -->` }] };
  assert.deepEqual(spendRecords(collected, { app: "me" }).map((r) => r.account), ["alpha"]);
  assert.equal(harnessCell({ harness: "claude", models: { worker: "claude-opus-5-5" }, accounts: ["alpha"] }), "claude claude-opus-5-5; account alpha");
  assert.equal(harnessCell({ harness: "claude", models: { worker: "m" }, accounts: ["alpha", "beta"] }), "claude m; accounts alpha, beta");
  // The harness never sees it; the stage reads it to record it.
  assert.ok(FACTORY_CONTROL_KEYS.includes("FACTORY_STAGE_ACCOUNT"));
  assert.equal(scrubbedEnv({ FACTORY_STAGE_ACCOUNT: "alpha" }).FACTORY_STAGE_ACCOUNT, undefined);
  for (const f of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(ROOT, "plugin", "scripts", f), "utf8");
    assert.equal(src.split("ranWith(inputs, chosenLabels, process.env.FACTORY_STAGE_ACCOUNT)").length - 1, 3, `${f}: its result.json (twice) and its harness line`);
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

test("#263, the real path: a stage runs on its harness's default account, set explicitly, names it, and hides the others", async () => {
  const h = fakeHome();
  declare(h, good(h));
  const { local, clone, usage } = await fakeLoop(h);
  const stageTmp = mkdtempSync(join(tmpdir(), "stage-"));
  await withHome(h, { CLAUDE_CONFIG_DIR: join(h, "work", "claude-b"), COPILOT_GITHUB_TOKEN: "from-serve-env" }, () => {
    const env = local.stageEnv(8, usage, clone, stageTmp, "worker.mjs", "claude");
    assert.equal(env.CLAUDE_CONFIG_DIR, join(h, "work", "claude-a"), "the first declared account, not serve's own variable");
    assert.equal(env.FACTORY_STAGE_ACCOUNT, "alpha");
    const { credentials } = JSON.parse(env.FACTORY_LOCAL_SANDBOX);
    for (const p of [join(h, "work", "claude-b"), join(h, "work", "codex-a"), join(h, ".config", "factory")]) assert.ok(covered(credentials, p), p);
    assert.ok(!credentials.includes(join(h, "work", "claude-a")) && covered(credentials, join(h, "work", "claude-a", ".credentials.json")));
    // A Copilot stage's token comes from its account's file, never serve's environment.
    const extra = local.harnessEnv(8, [stageTmp], clone, usage, null, "copilot", undefined, local.accountFor("copilot"));
    assert.equal(extra.COPILOT_GITHUB_TOKEN, "copilot-token-a");
    // The declaration gone after a start on it: the implicit account's token, never the one kept from that start.
    local.copilotToken = "copilot-token-a";
    const implicit = local.harnessEnv(8, [stageTmp], clone, usage, null, "copilot", undefined, { name: "copilot", harness: "copilot", declared: false });
    assert.equal(implicit.COPILOT_GITHUB_TOKEN, "from-serve-env");
    delete local.copilotToken;
  });
  // Nothing declared: the stage keeps serve's own CLAUDE_CONFIG_DIR, as always, on the account named `claude`.
  rmSync(accountsFile(h));
  await withHome(h, { CLAUDE_CONFIG_DIR: join(h, "work", "claude-b") }, () => {
    const env = local.stageEnv(8, usage, clone, stageTmp, "worker.mjs", "claude");
    assert.deepEqual([env.CLAUDE_CONFIG_DIR, env.FACTORY_STAGE_ACCOUNT], [join(h, "work", "claude-b"), "claude"]);
  });
  rmSync(stageTmp, { recursive: true, force: true });
});

test("#263, the real path: a bad declaration Blocks the stage before anything is set up, naming the account alone", async () => {
  const h = fakeHome();
  declare(h, { claude: [{ name: "gone", home: join(h, "work", "nowhere") }] });
  const { local } = await fakeLoop(h);
  const blocked = [];
  local.block = async (...a) => blocked.push(a);
  local.harnessFor = async () => ({ ok: true, harness: "claude" });
  const r = await withHome(h, {}, () => local.stage(8, "work", "worker.mjs", []));
  assert.equal(r.exit, "blocked");
  assert.equal(blocked.length, 1);
  const [, name, reason, opts] = blocked[0];
  assert.equal(name, "work");
  assert.match(reason, /`gone` in this machine's account declaration cannot be used \(account\)/);
  assert.ok(!reason.includes(h), "no path");
  assert.equal(opts?.cause, undefined, "cause `setup`, block()'s default");
  assert.equal(existsSync(join(h, "work", "nowhere")), false, "Factory makes no account folder");
});

test("#263: readiness is checked per account; the loop's starting account passed at its start", async () => {
  const h = fakeHome();
  const { local } = await fakeLoop(h);
  const path = process.env.PATH;
  process.env.PATH = join(h, "empty");
  try {
    await withHome(h, {}, () => {
      local.startAccount = { name: "alpha", harness: "claude", declared: true, home: join(h, "work", "claude-a") };
      assert.deepEqual(local.harnessReady("claude", local.startAccount), []);
      assert.deepEqual(local.harnessReady("claude", { name: "beta", harness: "claude", declared: true, home: join(h, "work", "claude-b") }), ["claude is not on PATH"], "another account is checked on its own");
    });
  } finally {
    process.env.PATH = path;
  }
});

test("#263: doctor --local checks each declared account and names the failing one, never a path", async () => {
  const h = fakeHome();
  declare(h, good(h));
  const seen = [];
  const rows = await localAccountChecks({ env: {}, local: true, home: h, loggedIn: (a) => (seen.push(a.name), a.name !== "beta"), tokenWorks: async (t) => t === "copilot-token-a" });
  assert.deepEqual(seen, ["alpha", "beta", "omega"]);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["account alpha", "PASS"], ["account beta", "FAIL"], ["account omega", "PASS"], ["account gh-one", "PASS"]]);
  assert.match(rows[1].detail, /its claude login does not work/);
  for (const r of rows) assert.ok(!`${r.detail} ${r.fix}`.includes(h), r.detail);
  chmodSync(join(h, "work", "claude-a"), 0o755);
  const open = await localAccountChecks({ env: {}, local: true, home: h, loggedIn: () => true, tokenWorks: async () => true });
  assert.deepEqual(open.filter((r) => r.status !== "PASS").map((r) => [r.name, r.status]), [["account alpha", "WARN"]]);
  declare(h, { claude: [{ name: "gone", home: join(h, "nowhere") }] });
  assert.deepEqual((await localAccountChecks({ env: {}, local: true, home: h })).map((r) => [r.name, r.status, r.detail]), [["account gone", "FAIL", "its folder does not exist; Factory never makes one"]]);
  rmSync(accountsFile(h));
  assert.deepEqual((await localAccountChecks({ env: {}, local: true, home: h })).map((r) => r.status), ["PASS"]);
  assert.deepEqual(await localAccountChecks({ env: { GITHUB_ACTIONS: "true" }, local: true, home: h }), [], "never in an Actions log");
});

// ------------------------------------------------------------------ security review of #294

test("#263: serve's own CLAUDE_CONFIG_DIR or CODEX_HOME counts when relative too, resolved as the harness resolves it", () => {
  const h = fakeHome();
  mkdirSync(join(h, "work", "claude-own"));
  const rel = relative(process.cwd(), join(h, "work", "claude-own"));
  assert.ok(!rel.startsWith("/"), "a relative path");
  assert.deepEqual(problems(h, { claude: [good(h).claude[0]] }, { env: { CLAUDE_CONFIG_DIR: rel } }), [["CLAUDE_CONFIG_DIR", "this shell's CLAUDE_CONFIG_DIR names a folder no declared Claude Code account has; declare it as one, or unset CLAUDE_CONFIG_DIR"]]);
  assert.deepEqual(problems(h, { codex: good(h).codex }, { env: { CODEX_HOME: relative(process.cwd(), join(h, "work", "claude-own")) } }).map((p) => p[0]), ["CODEX_HOME"]);
  assert.deepEqual(problems(h, good(h), { env: { CLAUDE_CONFIG_DIR: relative(process.cwd(), join(h, "work", "claude-b")) } }), [], "a declared one, named relatively");
});

test("#263: the root folder is around everything: no account may be on /", () => {
  const h = fakeHome();
  assert.deepEqual(problems(h, { claude: [{ name: "root", home: "/" }] }), [["root", "its folder is in or around ~/.config/factory"]]);
  assert.deepEqual(problems(h, { codex: [{ name: "root", home: "/" }] }).map((p) => p[0]), ["root"]);
});

test("#263: a declaration this user cannot read is an account problem with a fixed reason; harnessFor Blocks on it and rethrows anything else", async () => {
  const h = fakeHome();
  declare(h, good(h));
  const keys = join(h, ".config", "factory");
  const { local } = await fakeLoop(h);
  Object.assign(local, { repoFull: "acme/app", repo: { owner: "acme", name: "app", full: "acme/app" }, opts: { token: "t" } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (/\/user$/.test(u)) return json({ login: "me", type: "User" });
    if (/\/collaborators\?/.test(u)) return json([{ login: "dev" }]);
    if (/\/issues\/8\/timeline/.test(u)) return json([]);
    if (/\/issues\/8$/.test(u)) return json({ number: 8, labels: [{ name: "factory:objective" }] });
    throw new Error(`unexpected ${u}`);
  };
  chmodSync(keys, 0o000);
  try {
    assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "the accounts file cannot be read (EACCES)" }]);
    assert.deepEqual(declaredLogins(h), [], "nothing to hide when nothing can be read");
    const r = await withHome(h, {}, () => local.harnessFor(8));
    assert.equal(r.ok, false);
    assert.match(r.reason, /^local mode: `the accounts file` in this machine's account declaration cannot be used \(account\)/);
    chmodSync(keys, 0o700);
    // Anything but a declaration that cannot be used is Factory's own failure, never a Block with no reason.
    local.accountFor = () => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    };
    await assert.rejects(withHome(h, {}, () => local.harnessFor(8)), /EIO/);
  } finally {
    globalThis.fetch = real;
    chmodSync(keys, 0o700);
  }
});

test("#263: a Copilot token file may not be one of Factory's own secrets; a blank one is empty and an unreadable one refused", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  const own = "its token file is one of Factory's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)";
  const one = (token_file, env = {}) => problems(h, { copilot: [{ name: "gh", token_file }] }, { env });
  assert.deepEqual(one(accountsFile(h)), [["gh", own]], "the accounts file itself");
  writeFileSync(gatewayKeyFile(h), "vck_dummy\n", { mode: 0o600 });
  assert.deepEqual(one(gatewayKeyFile(h)), [["gh", own]], "the AI Gateway key");
  mkdirSync(join(keys, "tokens", "acme"), { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "tokens", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "tokens", "acme", "app")), [["gh", own]], "a repository's GitHub token");
  writeFileSync(join(keys, "app.pem"), "-----BEGIN DUMMY-----\n", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "app.pem"), { FACTORY_LOCAL_APP_KEY: "~/.config/factory/app.pem" }), [["gh", own]], "the App's key, by its real path");
  assert.deepEqual(one(join(keys, "app.pem")), [], "a file of that name is only the App's key when FACTORY_LOCAL_APP_KEY names it");
  writeFileSync(join(keys, "blank"), " \n\t\n", { mode: 0o600 });
  assert.deepEqual(one(join(keys, "blank")), [["gh", "its token file is empty"]]);
  // Write-only: no group or world bit, but Factory cannot read it. An account problem, never a throw at the stage.
  writeFileSync(join(keys, "write-only"), "copilot-token-w\n", { mode: 0o200 });
  chmodSync(join(keys, "write-only"), 0o200);
  assert.deepEqual(one(join(keys, "write-only")), [["gh", "its token file cannot be read by this user; chmod 600 it"]]);
});

test("#263: an account may not take another harness's name, which its hold and label key on", () => {
  const h = fakeHome();
  const g = good(h);
  assert.deepEqual(problems(h, { codex: [{ name: "claude", home: g.codex[0].home }] }), [["claude", "the name is another harness's (its account when none is declared)"]]);
  assert.deepEqual(problems(h, { claude: [{ name: "copilot", home: g.claude[0].home }] }).map((p) => p[0]), ["copilot"]);
  assert.deepEqual(problems(h, { claude: [{ name: "claude", home: g.claude[0].home }] }), [], "its own harness's name");
});

test("#263: the accounts file is held to the rules for secrets: this user's, one link, in a folder no one else writes", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  declare(h, good(h));
  assert.equal(loadAccounts({ home: h, env: {} }).ok, true);
  assert.deepEqual(loadAccounts({ home: h, env: {}, uid: process.getuid() + 1 }).problems, [{ account: "the accounts file", why: "the accounts file belongs to another user" }]);
  linkSync(accountsFile(h), join(h, "work", "accounts-copy.json"));
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "the accounts file has more than one hard link; keep one copy" }]);
  assert.equal(declaredLogins(h).length, 3, "what a refused file names is still hidden");
  rmSync(join(h, "work", "accounts-copy.json"));
  chmodSync(keys, 0o770);
  assert.deepEqual(loadAccounts({ home: h, env: {} }).problems, [{ account: "the accounts file", why: "~/.config/factory is writable by others; chmod 700 it" }]);
  chmodSync(keys, 0o700);
  assert.equal(loadAccounts({ home: h, env: {} }).ok, true);
});

test("#263, the real path: Factory's git on the clone before a stage gets no secret, a Copilot account's token included", async () => {
  const h = fakeHome();
  declare(h, good(h));
  const { local, clone, usage } = await fakeLoop(h, "copilot");
  rmSync(join(clone, ".git"), { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  pinGitDir(clone, gitPinFile(local.ws(8)));
  // srt stands where local mode's git sandbox would: it records the environment Factory's git starts with, then runs it.
  const bin = join(h, "bin");
  const seen = join(h, "srt-env.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "srt"), `#!/bin/sh\nenv >> "${seen}"\nshift 3\nexec "$@"\n`, { mode: 0o755 });
  const caches = [join(h, "pnpm"), join(h, "bun")];
  for (const d of caches) mkdirSync(d);
  local.harnessFor = async () => ({ ok: true, harness: "copilot", account: local.accountFor("copilot") });
  local.limitUntil = () => null;
  // The stage's env: the real Copilot part (its account's token), with the git sandbox's settings.
  local.stageEnv = (issue, usageDir, c, stageTmp, script, harness, hosts, account) => ({ PATH: `${bin}:${process.env.PATH}`, FACTORY_LOCAL_SRT_GIT: join(h, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1], ...local.harnessEnv(issue, [stageTmp], c, usage, null, harness, undefined, account) });
  local.children = {
    add(child) {
      child.kill("SIGKILL");
      throw new Error("stop after the set-up");
    },
  };
  await withHome(h, { CLAUDE_CONFIG_DIR: join(h, "work", "claude-b"), CODEX_HOME: join(h, "work", "codex-a") }, () => assert.rejects(local.stage(8, "work", "worker.mjs", []), /stop after the set-up/));
  const env = readFileSync(seen, "utf8");
  assert.ok(env.includes("FACTORY_LOCAL_SRT_GIT="), "srt ran Factory's git with its sandbox settings");
  assert.ok(!env.includes("copilot-token-a") && !env.includes("COPILOT_GITHUB_TOKEN="), "no Copilot token");
});

test("#263 with #287: a Codex stage on a declared account, with Codex's release in ~/.codex, reads no other login in any sandbox", () => {
  const h = fakeHome();
  declare(h, good(h));
  // Codex's installer layout: its release in ~/.codex/packages, a login beside it. Every file is a dummy.
  const release = join(h, ".codex", "packages", "standalone");
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "bin", "codex"), "\x7fELF", { mode: 0o755 });
  writeFileSync(join(h, ".codex", "auth.json"), "{}");
  const omega = defaultAccount(loadAccounts({ home: h, env: {} }), "codex");
  const host = accountEnv({ PATH: join(release, "bin") }, omega, h);
  const own = stageLogin("codex", host, h);
  assert.equal(own.dir, join(h, "work", "codex-a"));
  const credentials = credentialPaths(h, host, { own });
  const codex = codexLocalConfig({ home: h, env: host, credentials }).find((a) => a.startsWith("permissions.factory="));
  const denies = (p) => codex.includes(`${JSON.stringify(p)}="deny"`);
  for (const p of [join(h, "work", "claude-a"), join(h, "work", "claude-b"), join(h, ".codex", "auth.json"), join(h, "work", "codex-a", "auth.json*"), join(h, ".config", "factory")]) assert.ok(denies(p), `codex's sandbox: ${p}`);
  assert.ok(!codex.includes(JSON.stringify(release)), "the release Codex's sandbox execs stays readable");
  // The harness's outer sandbox: its own account's login readable to it alone, every other login denied.
  const outer = harnessOuterSettings({ harness: "codex", writable: ["/c"], home: h, env: host, credentials }).filesystem.denyRead;
  for (const p of [join(h, "work", "claude-a"), join(h, "work", "claude-b"), join(h, ".codex")]) assert.ok(covered(outer, p), `outer: ${p}`);
  assert.ok(!covered(outer, join(h, "work", "codex-a", "auth.json")), "its own login, for the harness process");
});

test("#305: Factory's own secrets are recognised by the file itself, however its name is spelled", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  const own = "its token file is one of Factory's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)";
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

test("#318: a loop of links under Factory's own GitHub tokens finishes fast and still finds them", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  mkdirSync(join(keys, "tokens", "acme"), { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "tokens", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  linkSync(join(keys, "tokens", "acme", "app"), join(keys, "TOKENS-acme-app"));
  // Two links to `.`: followed, the listing grows threefold at every level. In a child process, so a stall fails the test.
  symlinkSync(".", join(keys, "tokens", "loop-a"));
  symlinkSync(".", join(keys, "tokens", "loop-b"));
  declare(h, { copilot: [{ name: "gh", token_file: join(keys, "TOKENS-acme-app") }] });
  const script = `import { loadAccounts } from ${JSON.stringify(join(ROOT, "plugin", "scripts", "lib", "accounts.mjs"))};
process.stdout.write(JSON.stringify(loadAccounts({ home: ${JSON.stringify(h)}, env: {} }).problems ?? []));`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: h }, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, `the check finished: ${r.signal || r.stderr}`);
  assert.ok(Date.now() - t0 < 10_000, "and fast");
  assert.deepEqual(JSON.parse(r.stdout).map((p) => p.account), ["gh"], "the token behind the loop is still Factory's own");
});

test("#318: a token Factory reads through a folder link under tokens/ is still one of its own secrets", () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  mkdirSync(join(keys, "store", "acme"), { recursive: true, mode: 0o700 });
  mkdirSync(join(keys, "tokens"), { mode: 0o700 });
  writeFileSync(join(keys, "store", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  // tokens/acme/app, which Factory reads as acme/app's token, is store/acme/app.
  symlinkSync(join(keys, "store", "acme"), join(keys, "tokens", "acme"));
  // And two links back up the tree, which a walk that follows links enters once.
  symlinkSync(".", join(keys, "tokens", "loop-a"));
  symlinkSync(keys, join(keys, "store", "acme", "up"));
  assert.deepEqual(problems(h, { copilot: [{ name: "gh", token_file: join(keys, "store", "acme", "app") }] }), [["gh", "its token file is one of Factory's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)"]]);
});

test("#318: a folder of Factory's tokens that cannot be read costs that folder alone", { skip: process.getuid?.() === 0 }, () => {
  const h = fakeHome();
  const keys = join(h, ".config", "factory");
  mkdirSync(join(keys, "tokens", "acme"), { recursive: true, mode: 0o700 });
  mkdirSync(join(keys, "tokens", "locked"), { mode: 0o700 });
  writeFileSync(join(keys, "tokens", "acme", "app"), "github_pat_dummy\n", { mode: 0o600 });
  linkSync(join(keys, "tokens", "acme", "app"), join(keys, "TOKENS-acme-app"));
  chmodSync(join(keys, "tokens", "locked"), 0o000);
  try {
    assert.deepEqual(problems(h, { copilot: [{ name: "gh", token_file: join(keys, "TOKENS-acme-app") }] }), [["gh", "its token file is one of Factory's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)"]]);
  } finally {
    chmodSync(join(keys, "tokens", "locked"), 0o700);
  }
});

test("#305: the outer probe builds Codex's profile from the stage's account env, never serve's", { skip: process.platform !== "linux" }, async () => {
  const { runOuterProbe } = await import("../scripts/lib/local.mjs");
  const h = fakeHome();
  declare(h, good(h));
  // srt stands where the outer sandbox would: it records the command it was given and runs nothing.
  const bin = join(h, "bin");
  const seen = join(h, "srt-args");
  mkdirSync(bin);
  writeFileSync(join(bin, "srt"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\n`, { mode: 0o755 });
  const omega = defaultAccount(loadAccounts({ home: h, env: {} }), "codex");
  runOuterProbe("codex", { env: accountEnv({ HOME: h, PATH: `${bin}:${process.env.PATH}` }, omega, h), home: h });
  const profile = readFileSync(seen, "utf8").split("\n").find((a) => a.startsWith("permissions.factory="));
  const denies = (p) => profile.includes(`${JSON.stringify(p)}="deny"`);
  assert.ok(denies(join(h, "work", "codex-a", "auth.json*")), "the account's own login files, as its stage's profile denies them");
  assert.ok(!denies(join(h, "work", "codex-a")), "not the account's whole home, which Codex runs on");
});

test("#305, the real path: a stage's set-up failing in an account folder outside the home posts no path; the log has the whole error", { skip: process.platform !== "linux" || process.getuid() === 0 }, async () => {
  const { logTo } = await import("../scripts/lib/inputs.mjs");
  const h = fakeHome();
  // An account outside the home directory, which Factory cannot write: the harness's own folders cannot be made in it.
  const acct = join(realpathSync(mkdtempSync(join(tmpdir(), "outside-"))), "claude-x");
  mkdirSync(acct, { mode: 0o700 });
  declare(h, { claude: [{ name: "x", home: acct }] });
  const { local } = await fakeLoop(h);
  Object.assign(local, { repoFull: "acme/app", repo: { owner: "acme", name: "app", full: "acme/app" }, opts: { token: "t" } });
  local.harnessFor = async () => ({ ok: true, harness: "claude", account: local.accountFor("claude") });
  local.limitUntil = () => null;
  const blocked = [];
  // The Block is where the test ends each path: nothing after it reaches GitHub.
  local.block = async (...a) => {
    blocked.push(a);
    throw new Error("the test's own end");
  };
  const lines = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/\/issues\/8$/.test(String(url))) return new Response(JSON.stringify({ number: 8, labels: [{ name: "factory:running" }] }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected ${url}`);
  };
  chmodSync(acct, 0o500);
  logTo({ write: (s) => lines.push(s) });
  try {
    const failed = await withHome(h, {}, () => local.stage(8, "work", "worker.mjs", []).then(() => assert.fail("the set-up should fail"), (e) => e));
    assert.equal(failed.code, "EACCES");
    assert.ok(failed.message.includes(acct), "the error itself names the account's folder");
    await withHome(h, {}, async () => {
      // A review stage's set-up failing twice (lapse), and a work stage's start failing a third time (unstart).
      await local.lapse(8, null, failed);
      await local.lapse(8, null, failed);
      local.startFailures = new Map([[8, { count: 2, retryAt: 0 }]]);
      await local.unstart(8, Object.assign(failed, { startFailed: "work" }));
    });
  } finally {
    logTo(null);
    globalThis.fetch = real;
    chmodSync(acct, 0o700);
  }
  assert.equal(blocked.length, 2);
  for (const [, , reason] of blocked) {
    assert.match(reason, /EACCES from (mkdir|open); the local loop's log names the path/);
    assert.ok(!reason.includes(acct) && !reason.includes("outside-"), `no path: ${reason}`);
  }
  assert.ok(lines.some((l) => l.includes(acct)), "this machine's log has the whole error");
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
    if (/\/issues\/8$/.test(String(url))) return new Response(JSON.stringify({ number: 8, labels: [{ name: "factory:running" }] }), { status: 200, headers: { "content-type": "application/json" } });
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
