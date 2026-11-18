import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetHome, fakeProc } from "./fixtures/machine.mjs";
import { Local, deadHereHolder, holderId, machineIdentity } from "../scripts/local.mjs";
import { committedWorkflowNow } from "../scripts/lib/local.mjs";
import { DOWNGRADE_LINE, checkoutProblem, pendulumBuild, pinDecision, releaseCheckout, releasesDir, runningPendulum, startProblem } from "../scripts/lib/release.mjs";
import { claudeLocalSettings, codexLocalConfig, copilotLocalSettings, harnessOuterSettings, srtSettings, versionSettings } from "../scripts/lib/local.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// serve takes the workflow's settings and its Pendulum pin at a stage boundary, without a restart (#276).
RETRY.sleep = async () => {};

const LOCAL_MJS = fileURLToPath(new URL("../scripts/local.mjs", import.meta.url));
const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, ...ident } }).trim();

/** A repository's origin and a developer's clone of it whose default branch carries `workflow(env, pin)`. */
function adopter(env, pin = "v0.9.30") {
  const root = mkdtempSync(join(tmpdir(), "ad-"));
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, dev], { stdio: "ignore" });
  git(dev, "checkout", "-q", "-b", "main");
  const push = (e, p) => {
    mkdirSync(join(dev, ".github", "workflows"), { recursive: true });
    const steps = `jobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: clockgrove/pendulum@${p}\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: clockgrove/pendulum@${p}\n`;
    writeFileSync(join(dev, ".github", "workflows", "pendulum.yml"), `name: Pendulum\nenv:\n${Object.entries(e).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n${steps}`);
    git(dev, "add", ".github");
    git(dev, "commit", "-q", "-m", "workflow");
    git(dev, "push", "-q", "origin", "main");
  };
  push(env, pin);
  return { dev, push };
}

/** A stand-in for Pendulum's own repository: release tags whose plugin.json names them, and a loop that prints how it ran. */
function pendulumRepo() {
  const root = mkdtempSync(join(tmpdir(), "fx-"));
  const bare = join(root, "pendulum.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "remote", "add", "origin", bare);
  const release = (version, { tag = `v${version}`, branch = "main" } = {}) => {
    mkdirSync(join(work, "plugin", ".claude-plugin"), { recursive: true });
    mkdirSync(join(work, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(work, "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pendulum", version }));
    // The loop of this release: its usage on --help (failing if it sees a token of this shell's); otherwise what it was
    // started with, in the same process or not.
    writeFileSync(
      join(work, "plugin", "scripts", "local.mjs"),
      `if (process.argv.includes("--help")) process.exit(Object.keys(process.env).some((k) => k.includes("TOKEN")) ? 3 : 0);\nconsole.log(JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid, argv: process.argv.slice(2), pluginRoot: process.env.PENDULUM_PLUGIN_ROOT ?? null, switchedAt: Number(process.env.PENDULUM_SERVE_SWITCHED_AT || 0) }));\n`,
    );
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", version);
    if (tag) git(work, "tag", tag);
    git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`, ...(tag ? [`refs/tags/${tag}`] : []));
    return git(work, "rev-parse", "HEAD");
  };
  return { url: bare, work, release };
}

test("pinDecision: a release tag or a full SHA other than the running one is followed; a branch, a short SHA or steps that disagree never are", () => {
  const running = { version: "0.9.30", commit: "a".repeat(40) };
  assert.deepEqual(pinDecision([], running), { same: true });
  assert.deepEqual(pinDecision(["v0.9.30"], running), { same: true });
  assert.deepEqual(pinDecision(["a".repeat(40)], running), { same: true });
  assert.deepEqual(pinDecision(["v0.9.31"], running), { follow: true, ref: "v0.9.31" });
  assert.deepEqual(pinDecision(["b".repeat(40)], running), { follow: true, ref: "b".repeat(40) });
  for (const pins of [["main"], ["v0.9"], ["abc1234"], ["v0.9.31", "v0.9.30"]]) assert.equal(pinDecision(pins, running).follow, false, pins.join());
  // An older release is never taken by itself: a release from before this one would never follow a pin again.
  for (const ref of ["v0.9.29", "v0.8.99", "v0.9.3"]) assert.deepEqual(pinDecision([ref], running), { follow: false, ref, older: true, why: `clockgrove/pendulum@${ref}: ${DOWNGRADE_LINE}` });
  assert.deepEqual(pinDecision(["v0.10.0"], running), { follow: true, ref: "v0.10.0" }, "versions compare as numbers");
});

test("releaseCheckout: each switch fetches a fresh checkout of a tag, or of a SHA on Pendulum's main that comes after the running commit; anything else is refused", async () => {
  const fx = pendulumRepo();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const older = fx.release("9.9.8");
  const sha = fx.release("9.9.9");
  const c = await releaseCheckout("v9.9.9", { home, url: fx.url });
  assert.match(c.dir, new RegExp(`^${releasesDir(home)}/v9\\.9\\.9-`));
  assert.deepEqual({ commit: c.commit, ref: c.ref, version: c.version }, { commit: sha, ref: "v9.9.9", version: "9.9.9" });
  assert.equal(checkoutProblem(c, { home }), null);
  // A directory planted under the release's own name, with a tag of its own making: never used, a fresh fetch is.
  const planted = join(releasesDir(home), "v9.9.9");
  execFileSync("git", ["clone", "-q", fx.work, planted]);
  writeFileSync(join(planted, "plugin", "scripts", "local.mjs"), "planted\n");
  git(planted, "commit", "-qam", "planted");
  git(planted, "tag", "-f", "v9.9.9");
  const again = await releaseCheckout("v9.9.9", { home, url: fx.url });
  assert.notEqual(again.dir, planted);
  assert.equal(again.commit, sha);
  // A SHA on main, after the running commit; one before it, or with no running commit known, is a downgrade.
  assert.equal((await releaseCheckout(sha, { home, url: fx.url, running: { commit: older } })).commit, sha);
  for (const running of [{ commit: sha }, null]) await assert.rejects(releaseCheckout(older, { home, url: fx.url, running }), (e) => e.code === "older" && e.message.includes(DOWNGRADE_LINE));
  // A tag whose plugin.json names another release, a SHA off main, a branch name: refused, nothing kept.
  fx.release("9.9.10", { tag: "v9.9.11" });
  await assert.rejects(releaseCheckout("v9.9.11", { home, url: fx.url }), /is not that release: its plugin.json names v9.9.10/);
  assert.equal(readdirSync(releasesDir(home)).some((n) => n.startsWith("v9.9.11")), false);
  const off = fx.release("9.9.12", { tag: null, branch: "side" });
  await assert.rejects(releaseCheckout(off, { home, url: fx.url, running: { commit: older } }), /not a commit on .*'s main/);
  await assert.rejects(releaseCheckout("main", { home, url: fx.url }), /neither a release tag nor a full commit SHA/);
});

test("releaseCheckout: this shell's git config and GIT_* variables can neither redirect the fetch nor run anything", async () => {
  const fx = pendulumRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const cfg = join(mkdtempSync(join(tmpdir(), "cfg-")), "gitconfig");
  writeFileSync(cfg, `[url "${join(home, "elsewhere.git")}"]\n\tinsteadOf = ${fx.url}\n`);
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR };
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_DIR = join(home, "nowhere");
  try {
    const c = await releaseCheckout("v9.9.9", { home, url: fx.url });
    assert.equal(c.version, "9.9.9", "fetched from Pendulum's repository, not where this shell's config points");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("checkoutProblem: every file is hashed against the manifest taken at the fetch, so no change hides behind git, and no git runs", async () => {
  const fx = pendulumRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const fresh = () => releaseCheckout("v9.9.9", { home, url: fx.url });
  const loop = (c) => join(c.dir, "plugin", "scripts", "local.mjs");
  const evil = (c) => writeFileSync(loop(c), 'console.log("evil");\n');
  let c = await fresh();
  assert.equal(checkoutProblem(c), null);
  evil(c);
  assert.equal(checkoutProblem(c), "plugin/scripts/local.mjs changed", "a plain edit");
  c = await fresh();
  git(c.dir, "update-index", "--skip-worktree", "plugin/scripts/local.mjs");
  evil(c);
  assert.notEqual(checkoutProblem(c), null, "skip-worktree");
  // A replace ref that makes git read another commit in HEAD's place.
  c = await fresh();
  evil(c);
  git(c.dir, "add", "-A");
  git(c.dir, "replace", c.commit, git(c.dir, "commit-tree", git(c.dir, "write-tree"), "-p", c.commit, "-m", "evil"));
  assert.notEqual(checkoutProblem(c), null, "replace ref");
  // core.worktree pointing git at a pristine copy.
  c = await fresh();
  const pristine = mkdtempSync(join(tmpdir(), "pristine-"));
  cpSync(c.dir, pristine, { recursive: true });
  evil(c);
  git(c.dir, "config", "core.worktree", pristine);
  assert.notEqual(checkoutProblem(c), null, "core.worktree");
  // A .git file pointing at a pristine repository elsewhere.
  c = await fresh();
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  cpSync(c.dir, elsewhere, { recursive: true });
  rmSync(join(c.dir, ".git"), { recursive: true });
  writeFileSync(join(c.dir, ".git"), `gitdir: ${elsewhere}/.git\n`);
  assert.notEqual(checkoutProblem(c), null, "gitfile");
  // A same-size change with its times put back, which git's stat cache can miss.
  c = await fresh();
  const st = statSync(loop(c));
  const text = readFileSync(loop(c), "utf8");
  const same = text.replace("pid", "PID");
  assert.ok(same !== text && same.length === text.length);
  writeFileSync(loop(c), same);
  utimesSync(loop(c), st.atime, st.mtime);
  assert.equal(checkoutProblem(c), "plugin/scripts/local.mjs changed", "same size, same times");
  // A clean filter its config names, with a file added and ignored: the filter never runs, the file is seen.
  c = await fresh();
  const marker = join(home, "filter-ran");
  const filter = join(home, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  git(c.dir, "config", "filter.x.clean", filter);
  writeFileSync(join(c.dir, ".git", "info", "attributes"), "* filter=x\n");
  assert.match(checkoutProblem(c), /^\.git\/(config|info\/attributes) (changed|was added)$/);
  assert.equal(existsSync(marker), false, "no filter ran");
  c = await fresh();
  writeFileSync(join(c.dir, ".git", "info", "exclude"), "extra.mjs\n");
  writeFileSync(join(c.dir, "plugin", "scripts", "extra.mjs"), "planted\n");
  assert.match(checkoutProblem(c), /extra\.mjs was added|\.git\/info\/exclude changed/);
});

test("startProblem: the new release's loop is tried with nothing of this shell's env", async () => {
  const fx = pendulumRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const c = await releaseCheckout("v9.9.9", { home, url: fx.url });
  const saved = process.env.PENDULUM_LOCAL_TOKEN;
  process.env.PENDULUM_LOCAL_TOKEN = "secret";
  try {
    assert.equal(await startProblem(c.dir), null);
  } finally {
    saved === undefined ? delete process.env.PENDULUM_LOCAL_TOKEN : (process.env.PENDULUM_LOCAL_TOKEN = saved);
  }
});

test("every sandbox names serve's releases among what it may not write", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const releases = releasesDir(home);
  mkdirSync(releases, { recursive: true });
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  const env = { HOME: home, PATH: process.env.PATH };
  assert.ok(srtSettings({ home, env, clone }).filesystem.denyWrite.includes(releases), "srt");
  assert.ok(claudeLocalSettings({ home, env, clone, credentials: [] }).sandbox.filesystem.denyWrite.includes(releases), "Claude Code");
  assert.ok(harnessOuterSettings({ harness: "codex", home, env, clone, credentials: [] }).filesystem.denyWrite.includes(releases), "outer");
  assert.ok(versionSettings("codex", env, home).filesystem.denyWrite.includes(releases), "version probe");
  assert.ok(copilotLocalSettings({ home, env, clone, denied: [] }).sandbox.userPolicy.filesystem.readonlyPaths.includes(releases), "Copilot");
  assert.ok(codexLocalConfig({ home, env, clone, credentials: [], secrets: [] }).join(" ").includes(`${JSON.stringify(releases)}="read"`), "Codex");
});

test("runningPendulum: a release is a checkout at its own release tag and unchanged, or one serve fetched; a branch or a local change is not", async () => {
  const fx = pendulumRepo();
  fx.release("9.9.8");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.equal(runningPendulum(fx.work, "9.9.8", home).release, true, "at its tag");
  assert.equal(runningPendulum(fx.work, "9.9.7", home).release, false, "plugin.json names a release this commit is not");
  writeFileSync(join(fx.work, "plugin", "scripts", "local.mjs"), "// a change of my own\n");
  assert.equal(runningPendulum(fx.work, "9.9.8", home).release, false, "a tracked file changed");
  git(fx.work, "checkout", "-q", "--", ".");
  git(fx.work, "commit", "-q", "--allow-empty", "-m", "between releases");
  assert.equal(runningPendulum(fx.work, "9.9.8", home).release, false, "a commit after the tag");
  const before = git(fx.work, "rev-parse", "HEAD");
  const fetched = await releaseCheckout(fx.release("9.9.9"), { home, url: fx.url, running: { commit: before } });
  assert.equal(runningPendulum(fetched.dir, "9.9.9", home).release, true, "a checkout serve fetched, by SHA");
  assert.equal(runningPendulum(mkdtempSync(join(tmpdir(), "nogit-")), "9.9.9", home).release, false, "no git checkout");
});

test("#565 W6: a build records the Pendulum it really is: its release at its tag, else the version with its commit or ref as build metadata, never the last tag alone", async () => {
  const fx = pendulumRepo();
  fx.release("9.9.8");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const at = (v) => runningPendulum(fx.work, v, home);
  assert.equal(pendulumBuild({ env: {}, version: "9.9.8", running: at("9.9.8") }), "9.9.8", "the release itself");
  git(fx.work, "commit", "-q", "--allow-empty", "-m", "a candidate between releases");
  const head = git(fx.work, "rev-parse", "HEAD").trim();
  assert.equal(pendulumBuild({ env: {}, version: "9.9.8", running: at("9.9.8") }), `9.9.8+${head.slice(0, 12)}`, "a candidate: its commit");
  writeFileSync(join(fx.work, "plugin", "scripts", "local.mjs"), "// a change of my own\n");
  assert.equal(pendulumBuild({ env: {}, version: "9.9.8", running: at("9.9.8") }), `9.9.8+${head.slice(0, 12)}.dirty`);
  assert.equal(pendulumBuild({ env: {}, version: "9.9.8", running: { commit: null, release: false } }), "9.9.8", "an installed copy with no checkout of its own: its manifest's");
  // On Actions: the ref the workflow's uses: names, taken only where the runner's checkout of the action ends with it.
  const base = "/home/runner/work/_actions/clockgrove/pendulum";
  const actions = (ref, path = `${base}/${ref}`) => pendulumBuild({ env: { GITHUB_ACTIONS: "true", PENDULUM_ACTION_REF: ref, GITHUB_ACTION_PATH: path }, version: "0.10.2" });
  assert.equal(actions("v0.10.2"), "0.10.2");
  assert.equal(actions("v0.10"), "0.10.2", "a moving tag of its line is the release");
  assert.equal(actions("v0"), "0.10.2");
  assert.equal(actions("8a783bda3cca1d2e3f4a5b6c7d8e9f0a1b2c3d4e"), "0.10.2+8a783bda3cca", "a commit pin");
  assert.equal(actions("main"), "0.10.2+main", "a branch pin: the candidate build");
  assert.equal(actions("fix/565"), "0.10.2+fix-565", "a branch with a slash: its whole name");
  // A ref the action's path does not end with (a nested action's, actions/runner#2473) is unknown, never taken.
  assert.equal(actions("949feb2413d6458794dcd2491c4babbbce0c15c1", `${base}/v0.10.2`), "0.10.2+unknown", "the nested setup-node's SHA");
  assert.equal(actions("v0.10.2", `${base}/main`), "0.10.2+unknown");
  // Set but empty (the runner gave no ref): unknown, never guessed from the path.
  assert.equal(actions("", `${base}/v0.10.2`), "0.10.2+unknown");
  // Not set at all (a command run from a person's own workflow, local mode): this checkout's own build.
  assert.equal(pendulumBuild({ env: { GITHUB_ACTIONS: "true", GITHUB_ACTION_PATH: `${base}/main` }, version: "9.9.8", running: at("9.9.8") }), `9.9.8+${head.slice(0, 12)}.dirty`);
  assert.equal(pendulumBuild({ env: { GITHUB_ACTIONS: "true" }, version: "9.9.8", running: { commit: null, release: false } }), "9.9.8");
  // A cloud-sandbox stage: the launcher's build, handed over (the sandbox's plugin has no checkout); only one of this version.
  const { stageEnvironment } = await import("../scripts/launch.mjs");
  const handed = stageEnvironment({ inputs: { harness: "claude" }, env: { GITHUB_ACTIONS: "true", PENDULUM_ACTION_REF: "main", GITHUB_ACTION_PATH: `${base}/main` }, stage: "work", issue: 3, pr: null, claim: "c", tokens: { write: "w" } }).PENDULUM_STAGE_BUILD;
  assert.equal(handed, pendulumBuild({ env: { PENDULUM_ACTION_REF: "main", GITHUB_ACTION_PATH: `${base}/main` } }));
  assert.match(handed, /\+main$/);
  assert.equal(pendulumBuild({ env: { GITHUB_ACTIONS: "true", PENDULUM_STAGE_BUILD: "0.10.2+main" }, version: "0.10.2" }), "0.10.2+main");
  assert.equal(pendulumBuild({ env: { GITHUB_ACTIONS: "true", PENDULUM_STAGE_BUILD: "0.9.0+main" }, version: "0.10.2", running: { commit: null } }), "0.10.2", "another version's build is not this one's");
  // action.yml reads the ref in its first step, before any nested uses:, and passes that step's output to the run step.
  const yml = readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8");
  const steps = yml.slice(yml.indexOf("\n  steps:\n"));
  assert.ok(steps.indexOf("github.action_ref") < steps.search(/^ {6}uses: /m), "read before any nested action runs");
  assert.match(steps, /^ {4}- name: Pendulum's ref\n {6}id: pendulum-ref\n/m);
  assert.match(yml, /^ {8}PENDULUM_ACTION_REF: \$\{\{ steps\.pendulum-ref\.outputs\.ref \}\}$/m);
  for (const v of [actions("main"), `9.9.8+${head.slice(0, 12)}.dirty`]) assert.match(v, /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/, "a version the report and the card read");
});

test("#569 N8: on a Windows runner, whose action path has backslashes, the workflow's ref is matched as on any other runner", () => {
  const actions = (ref, path) => pendulumBuild({ env: { GITHUB_ACTIONS: "true", PENDULUM_ACTION_REF: ref, GITHUB_ACTION_PATH: path }, version: "0.10.2" });
  const base = "D:\\a\\_actions\\clockgrove\\pendulum";
  assert.equal(actions("v0.10.2", `${base}\\v0.10.2`), "0.10.2");
  assert.equal(actions("v0.10", `${base}\\v0.10\\`), "0.10.2", "a trailing backslash");
  assert.equal(actions("main", `${base}\\main`), "0.10.2+main");
  assert.equal(actions("fix/565", `${base}\\fix\\565`), "0.10.2+fix-565", "a branch with a slash, checked out in two folders");
  assert.equal(actions("v0.10.2", `${base}\\main`), "0.10.2+unknown", "still an exact match: another ref's path is unknown");
  assert.equal(actions("main", "D:\\a\\_actions\\clockgrove\\pendulum-main"), "0.10.2+unknown", "a folder that only ends with the ref's name is none");
});

test("deadHereHolder: a holder with this process's pid that is not its own loop's is the loop it was before it started again, so dead", () => {
  const id = machineIdentity();
  const own = holderId(id, process.pid);
  const before = holderId(id, process.pid);
  assert.equal(deadHereHolder(before, { id, own }), true, "the loop this process ran before its restart");
  assert.equal(deadHereHolder(own, { id, own }), false, "its own loop");
  assert.equal(deadHereHolder(before, { id }), false, "no own loop named: alive, as before");
  assert.equal(deadHereHolder(holderId({ ...id, host: `${id.host}-other` }, process.pid), { id, own }), false, "another machine's");
});

test("restartOn: serve starts again on the release in the same process, with its arguments, without a plugin root override, and takes up the old loop's claims", { skip: typeof process.execve !== "function" && "this Node has no process.execve" }, async () => {
  const fx = pendulumRepo();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  fx.release("9.9.9");
  const checkout = await releaseCheckout("v9.9.9", { home, url: fx.url });
  // A process that runs as serve does (local.mjs serve ...) and calls the real restartOn, so the real process.execve runs.
  const script = join(mkdtempSync(join(tmpdir(), "rs-")), "serve.mjs");
  writeFileSync(
    script,
    `import { Local, holderId } from ${JSON.stringify(LOCAL_MJS)};\nconst loop = Object.assign(Object.create(Local.prototype), { holder: holderId(), pendulum: { version: "0.9.30", commit: null }, releaseOpts: { home: ${JSON.stringify(home)} } });\nconsole.log(JSON.stringify({ before: process.pid, holder: loop.holder }));\nloop.restartOn({ ref: "v9.9.9", checkout: ${JSON.stringify(checkout)} });\nconsole.log("not replaced");\n`,
  );
  const r = spawnSync(process.execPath, [script, "serve", "--all", "--interval", "5"], { encoding: "utf8", env: { ...process.env, PENDULUM_PLUGIN_ROOT: "/old/plugin" }, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const [first, , after] = r.stdout.trim().split("\n");
  const before = JSON.parse(first);
  const ran = JSON.parse(after);
  assert.equal(ran.version, "9.9.9", "the release's own loop runs");
  assert.equal(ran.pid, before.before, "in the same process");
  assert.deepEqual(ran.argv, ["serve", "--all", "--interval", "5"]);
  assert.equal(deadHereHolder(before.holder, { self: ran.pid, own: holderId() }), true, "the new loop takes up the claims the old one left at once");
  assert.equal(ran.pluginRoot, null);
  assert.equal(ran.switchedAt > 0, true, "the new loop knows when it switched");
  assert.doesNotMatch(r.stdout, /not replaced/);
});

test("restartOn: a checkout that changed after its fetch is not run; serve stays and fetches it afresh later", async () => {
  const fx = pendulumRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const checkout = await releaseCheckout("v9.9.9", { home, url: fx.url });
  writeFileSync(join(checkout.dir, "plugin", "scripts", "local.mjs"), "planted\n");
  const execs = [];
  const loop = Object.assign(Object.create(Local.prototype), { pendulum: { version: "0.9.30", commit: null }, releaseOpts: { home }, execve: (...a) => execs.push(a) });
  const r = { ref: "v9.9.9", checkout, state: "ready" };
  assert.equal(loop.restartOn(r), false);
  assert.deepEqual(execs, []);
  assert.equal(r.state, "failed");
});

/**
 * A GitHub with one Objective, #7, that the dispatcher picks for this loop. `variables()` answers the repository's
 * variables list: {status} alone refuses it, else {vars} is listed with an ETag, and a request that sends that ETag back
 * gets 304 (`seen` records each list request's If-None-Match).
 */
async function fakeGitHub({ variables = () => ({ vars: {} }), seen = [] } = {}) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      if (url.pathname === "/repos/o/r/actions/variables") {
        const v = variables();
        seen.push(req.headers["if-none-match"] ?? null);
        if (v.status) return send(v.status, { message: "Resource not accessible by personal access token" });
        const etag = `"${createHash("sha1").update(JSON.stringify(v.vars)).digest("hex")}"`;
        if (req.headers["if-none-match"] === etag) return res.writeHead(304, { etag }).end();
        return send(200, { total_count: Object.keys(v.vars).length, variables: Object.entries(v.vars).map(([name, value]) => ({ name, value })) }, { etag });
      }
      const issue = { number: 7, title: "t", body: "", state: "open", labels: [{ name: "pendulum:objective" }], updated_at: new Date().toISOString() };
      if (url.pathname === "/repos/o/r/issues/7" && req.method === "GET") return send(200, issue);
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("labels") === "pendulum:objective") return send(200, [issue]);
      if (url.pathname === "/graphql") return send(200, { data: {} });
      return send(200, req.method === "GET" ? [] : {});
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

/**
 * The real serve loop over a real clone of `ad`, ticking every few milliseconds against fakeGitHub. `atTick(n, loop)`
 * runs at each tick, after its settings and pin are read; `paused(n, loop)` is the machine's paused work, when the tick
 * asks for it; `stubs(loop)` replace more of the loop. Returns the log lines and the loop.
 */
async function serveOver(ad, { wf, pendulum, atTick, paused = () => [], stubs = () => ({}), github = {} }) {
  const env = { GITHUB_API_URL: process.env.GITHUB_API_URL, PENDULUM_LOCAL: process.env.PENDULUM_LOCAL, PENDULUM_LOCAL_ALL: process.env.PENDULUM_LOCAL_ALL, PENDULUM_LOCAL_MAX_CONCURRENT: process.env.PENDULUM_LOCAL_MAX_CONCURRENT, PENDULUM_HARNESS: process.env.PENDULUM_HARNESS };
  const fake = await fakeGitHub(github);
  process.env.GITHUB_API_URL = fake.url;
  process.env.PENDULUM_LOCAL = "1";
  process.env.PENDULUM_LOCAL_ALL = "1";
  delete process.env.PENDULUM_LOCAL_MAX_CONCURRENT;
  delete process.env.PENDULUM_HARNESS;
  let tick = 0;
  const loop = Object.assign(Object.create(Local.prototype), {
    machine: { home: budgetHome(), proc: fakeProc(mkdtempSync(join(tmpdir(), "proc-"))) },
    dev: ad.dev,
    settingsBranch: "main",
    // Every tick fetches, so a push between two ticks is seen at the next.
    settingsEveryMs: 0,
    pins: ["v0.9.30"],
    harness: "claude",
    pendulum,
    repo: { owner: "o", name: "r", full: "o/r" },
    repoFull: "o/r",
    token: "t",
    notice: null,
    wf,
    opts: { token: "t" },
    holder: holderId(),
    children: new Set(),
    cleanup: async () => {},
    pendingReviews: async () => [],
    recheckStarts: async () => atTick((tick += 1), loop),
    pausedHere: async () => paused(tick, loop),
  });
  Object.assign(loop, stubs(loop));
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    await loop.serve({ intervalMs: 20 });
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await fake.close();
  }
  return { lines, loop };
}

test("serve: a pin it does not follow is said once and changes nothing: a branch, or a serve run from a checkout that is not a release (#276)", async () => {
  for (const [pin, pendulum, said] of [
    ["main", { version: "0.9.30", commit: null, root: "/f", release: true }, /pins clockgrove\/pendulum@main is neither a release tag \(vX\.Y\.Z\) nor a full commit SHA; serve runs no code from it and keeps running v0\.9\.30/],
    ["v9.9.9", { version: "0.9.30", commit: "c".repeat(40), root: "/dev/pendulum", release: false }, /pins clockgrove\/pendulum@v9\.9\.9; this serve runs v0\.9\.30 \(ccccccc\) from \/dev\/pendulum, which is not a release checkout, so it keeps running that: start serve from v9\.9\.9 to run it/],
  ]) {
    const ad = adopter({}, pin);
    const { lines, loop } = await serveOver(ad, {
      wf: {},
      pendulum,
      atTick: (n, l) => {
        if (n >= 4) l.stopping = true;
      },
      stubs: () => ({ runObjective: async () => ({ exit: "delivered" }), execve: () => assert.fail("no restart") }),
    });
    const text = lines.join("");
    assert.match(text, said);
    assert.equal(text.split(said).length - 1, 1, "said once");
    assert.equal(loop.repin ?? null, null);
  }
});

test("followPin: a new switch waits until 30 minutes after the last, and a SHA before the running commit is refused, not retried", async () => {
  const fx = pendulumRepo();
  const older = fx.release("9.9.8");
  const newer = fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const loop = Object.assign(Object.create(Local.prototype), { settingsBranch: "main", pins: ["v9.9.9"], pendulum: { version: "9.9.8", commit: older, root: "/f", release: true }, releaseOpts: { home, url: fx.url }, switchedAt: Date.now() - 60_000 });
    assert.equal(await loop.followPin(0), false);
    assert.equal(await loop.followPin(0), false);
    assert.equal(loop.repin, undefined, "no switch within 30 minutes of the last");
    assert.equal(lines.filter((l) => /switched releases less than 30 minutes ago/.test(l)).length, 1, "said once");
    loop.switchedAt = Date.now() - 31 * 60_000;
    assert.equal(await loop.followPin(1), true, "past the gap: the switch starts and holds new stages");
    await loop.repin.fetch;
    assert.equal(loop.repin.state, "ready");
    // A failed try is tried again after ten minutes: only a switch counts toward the gap.
    loop.repin = { ref: "v9.9.9", state: "failed", retryAt: Date.now() - 1 };
    assert.equal(await loop.followPin(1), true, "the same pin is tried again");
    await loop.repin.fetch;
    // A mistyped pin that fails, then the right one: taken at once, no gap.
    loop.repin = null;
    loop.pins = ["v9.9.99"];
    await loop.followPin(0);
    await loop.repin.fetch;
    assert.equal(loop.repin.state, "failed");
    loop.pins = ["v9.9.9"];
    assert.equal(await loop.followPin(1), true, "the corrected pin starts at once");
    await loop.repin.fetch;
    assert.equal(loop.repin.state, "ready");
    assert.equal(lines.filter((l) => /switched releases less than/.test(l)).length, 1, "the gap was said only for the real switch");
    // A full SHA that is not on Pendulum's main: refused until the pin changes, never fetched again every ten minutes.
    loop.pins = ["0123456789abcdef0123456789abcdef01234567"];
    await loop.followPin(0);
    await loop.repin.fetch;
    assert.equal(loop.repin.state, "refused");
    loop.repin.retryAt = Date.now() - 1;
    const tried = loop.repin;
    assert.equal(await loop.followPin(0), false);
    assert.equal(loop.repin, tried, "not tried again");
    // A SHA before the commit serve runs: refused, said once, and no stage waits for it.
    loop.pendulum = { version: "9.9.9", commit: newer, root: "/f", release: true };
    loop.pins = [older];
    loop.switchedAt = 0;
    await loop.followPin(1);
    await loop.repin.fetch;
    assert.equal(loop.repin.state, "refused");
    assert.equal(await loop.followPin(1), false);
    assert.equal(lines.filter((l) => l.includes(DOWNGRADE_LINE)).length, 1);
  } finally {
    process.stdout.write = write;
  }
});

test("refreshSettings: the default branch is fetched every few minutes, and never with the developer's credential helper", async () => {
  const ad = adopter({ PENDULUM_MODEL: "m1" });
  const loop = Object.assign(Object.create(Local.prototype), { dev: ad.dev, settingsBranch: "main", wf: { PENDULUM_MODEL: "m1" }, token: "t" });
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await loop.refreshSettings();
    ad.push({ PENDULUM_MODEL: "m2" }, "v0.9.30");
    await loop.refreshSettings();
    assert.equal(loop.wf.PENDULUM_MODEL, "m1", "a tick soon after the last read takes what it brought");
    loop.settingsReadAt -= 3 * 60_000;
    await loop.refreshSettings();
    assert.equal(loop.wf.PENDULUM_MODEL, "m2", "a few minutes on, fetched again");
  } finally {
    process.stdout.write = quiet;
  }
  // A host that asks for credentials: the developer's helper in their clone is never run.
  const asks = createServer((req, res) => res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end());
  await new Promise((ok) => asks.listen(0, "127.0.0.1", ok));
  try {
    const marker = join(ad.dev, "..", "helper-ran");
    const helper = join(ad.dev, "..", "helper.sh");
    writeFileSync(helper, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(ad.dev, "config", "credential.helper", helper);
    git(ad.dev, "remote", "set-url", "origin", `http://127.0.0.1:${asks.address().port}/r.git`);
    assert.equal((await committedWorkflowNow(ad.dev, "main", { token: "t", timeoutMs: 10_000 })).unfetched, true);
    assert.equal(existsSync(marker), false);
  } finally {
    await new Promise((ok) => asks.close(ok));
  }
});
