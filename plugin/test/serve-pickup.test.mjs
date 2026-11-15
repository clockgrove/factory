import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Local, deadHereHolder, holderId, machineIdentity, settingsChanges } from "../scripts/local.mjs";
import { committedWorkflowNow, workflowPins } from "../scripts/lib/local.mjs";
import { DOWNGRADE_LINE, checkoutProblem, markInUse, pinDecision, pruneReleases, releaseCheckout, releasesDir, runningFactory, startProblem } from "../scripts/lib/release.mjs";
import { claudeLocalSettings, codexLocalConfig, copilotLocalSettings, harnessOuterSettings, srtSettings, versionSettings } from "../scripts/lib/local.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// serve takes the workflow's settings and its Factory pin at a stage boundary, without a restart (#276).
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
    const steps = `jobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: clockgrove/factory@${p}\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: clockgrove/factory@${p}\n`;
    writeFileSync(join(dev, ".github", "workflows", "factory.yml"), `name: Factory\nenv:\n${Object.entries(e).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n${steps}`);
    git(dev, "add", ".github");
    git(dev, "commit", "-q", "-m", "workflow");
    git(dev, "push", "-q", "origin", "main");
  };
  push(env, pin);
  return { dev, push };
}

/** A stand-in for Factory's own repository: release tags whose plugin.json names them, and a loop that prints how it ran. */
function factoryRepo() {
  const root = mkdtempSync(join(tmpdir(), "fx-"));
  const bare = join(root, "factory.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "remote", "add", "origin", bare);
  const release = (version, { tag = `v${version}`, branch = "main" } = {}) => {
    mkdirSync(join(work, "plugin", ".claude-plugin"), { recursive: true });
    mkdirSync(join(work, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(work, "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "factory", version }));
    // The loop of this release: its usage on --help (failing if it sees a token of this shell's); otherwise what it was
    // started with, in the same process or not.
    writeFileSync(
      join(work, "plugin", "scripts", "local.mjs"),
      `if (process.argv.includes("--help")) process.exit(Object.keys(process.env).some((k) => k.includes("TOKEN")) ? 3 : 0);\nconsole.log(JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid, argv: process.argv.slice(2), pluginRoot: process.env.FACTORY_PLUGIN_ROOT ?? null, switchedAt: Number(process.env.FACTORY_SERVE_SWITCHED_AT || 0) }));\n`,
    );
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", version);
    if (tag) git(work, "tag", tag);
    git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`, ...(tag ? [`refs/tags/${tag}`] : []));
    return git(work, "rev-parse", "HEAD");
  };
  return { url: bare, work, release };
}

test("workflowPins: the Factory refs a workflow's steps call, once each; settingsChanges names each change and a shell value that still wins", () => {
  const text = "jobs:\n  a:\n    steps:\n      - uses: clockgrove/factory@v0.9.31 # pinned\n      - uses: actions/checkout@v7\n      - uses: 'clockgrove/factory@v0.9.31'\n#     - uses: clockgrove/factory@main\n      - run: |\n          echo uses: clockgrove/factory@v0.0.1\n  b:\n    steps:\n      - { uses: clockgrove/factory@0123456789abcdef0123456789abcdef01234567 }\n";
  assert.deepEqual(workflowPins(text), ["v0.9.31", "0123456789abcdef0123456789abcdef01234567"], "steps only: a flow mapping counts, a script's text does not");
  assert.deepEqual(workflowPins("jobs: [\n"), [], "a workflow that does not parse pins nothing");
  assert.deepEqual(workflowPins("env:\n  FACTORY_MODEL: m\n"), []);
  assert.deepEqual(settingsChanges({ FACTORY_MAX_CONCURRENT: "2", FACTORY_LOCAL_DOMAINS: "a.com" }, { FACTORY_MAX_CONCURRENT: "3", FACTORY_LOCAL_DOMAINS: "b.com", FACTORY_MODEL: "m" }, { FACTORY_LOCAL_DOMAINS: "c.com" }), [
    'FACTORY_LOCAL_DOMAINS: "a.com" → "b.com" (this shell sets it, and its value wins)',
    'FACTORY_MAX_CONCURRENT: "2" → "3"',
    'FACTORY_MODEL: unset → "m"',
  ]);
  assert.deepEqual(settingsChanges({ FACTORY_MODEL: "m" }, { FACTORY_MODEL: "m" }, {}), []);
});

test("pinDecision: a release tag or a full SHA other than the running one is followed; a branch, a short SHA or steps that disagree never are", () => {
  const running = { version: "0.9.30", commit: "a".repeat(40) };
  assert.deepEqual(pinDecision([], running), { same: true });
  assert.deepEqual(pinDecision(["v0.9.30"], running), { same: true });
  assert.deepEqual(pinDecision(["a".repeat(40)], running), { same: true });
  assert.deepEqual(pinDecision(["v0.9.31"], running), { follow: true, ref: "v0.9.31" });
  assert.deepEqual(pinDecision(["b".repeat(40)], running), { follow: true, ref: "b".repeat(40) });
  for (const pins of [["main"], ["v0.9"], ["abc1234"], ["v0.9.31", "v0.9.30"]]) assert.equal(pinDecision(pins, running).follow, false, pins.join());
  // An older release is never taken by itself: a release from before this one would never follow a pin again.
  for (const ref of ["v0.9.29", "v0.8.99", "v0.9.3"]) assert.deepEqual(pinDecision([ref], running), { follow: false, ref, older: true, why: `clockgrove/factory@${ref}: ${DOWNGRADE_LINE}` });
  assert.deepEqual(pinDecision(["v0.10.0"], running), { follow: true, ref: "v0.10.0" }, "versions compare as numbers");
});

test("releaseCheckout: each switch fetches a fresh checkout of a tag, or of a SHA on Factory's main that comes after the running commit; anything else is refused", async () => {
  const fx = factoryRepo();
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
  const fx = factoryRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const cfg = join(mkdtempSync(join(tmpdir(), "cfg-")), "gitconfig");
  writeFileSync(cfg, `[url "${join(home, "elsewhere.git")}"]\n\tinsteadOf = ${fx.url}\n`);
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR };
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_DIR = join(home, "nowhere");
  try {
    const c = await releaseCheckout("v9.9.9", { home, url: fx.url });
    assert.equal(c.version, "9.9.9", "fetched from Factory's repository, not where this shell's config points");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("checkoutProblem: every file is hashed against the manifest taken at the fetch, so no change hides behind git, and no git runs", async () => {
  const fx = factoryRepo();
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

test("pruneReleases: the newest three checkouts stay, and the one serve runs or any live serve runs whatever its age; a fetch under way stays; a ~/.cache behind a link too", () => {
  for (const linked of [false, true]) pruneCase(linked);
});

function pruneCase(linked) {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  if (linked) symlinkSync(mkdtempSync(join(tmpdir(), "cache-")), join(home, ".cache"));
  const root = releasesDir(home);
  const names = ["v1.0.0-a", "v1.0.1-b", "v1.0.2-c", "v1.0.3-d", "v1.0.4-e", "v1.0.5-f", "v1.0.6-g", "v1.0.7-h.part"];
  names.forEach((n, i) => {
    mkdirSync(join(root, n), { recursive: true });
    const at = new Date(Date.now() - (names.length - i) * 60_000);
    utimesSync(join(root, n), at, at);
  });
  mkdirSync(join(root, ".home"));
  // Another live serve on this machine runs from the oldest but one; a dead one's name keeps nothing.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    markInUse(join(root, "v1.0.1-b"), { home, pid: other.pid });
    markInUse(join(root, "v1.0.2-c"), { home, pid: 2 ** 22 + 7 });
    // A live process's name another serve removed while this one reads it (here: one that does not read).
    mkdirSync(join(root, ".in-use", String(process.pid)));
    pruneReleases(home, [join(root, "v1.0.0-a")]);
    rmSync(join(root, ".in-use", String(process.pid)), { recursive: true });
  } finally {
    other.kill();
  }
  assert.deepEqual(readdirSync(root).sort(), [".home", ".in-use", "v1.0.0-a", "v1.0.1-b", "v1.0.4-e", "v1.0.5-f", "v1.0.6-g", "v1.0.7-h.part"]);
  assert.deepEqual(readdirSync(join(root, ".in-use")), [String(other.pid)], "a dead process's name goes");
}

test("startProblem: the new release's loop is tried with nothing of this shell's env", async () => {
  const fx = factoryRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const c = await releaseCheckout("v9.9.9", { home, url: fx.url });
  const saved = process.env.FACTORY_LOCAL_TOKEN;
  process.env.FACTORY_LOCAL_TOKEN = "secret";
  try {
    assert.equal(await startProblem(c.dir), null);
  } finally {
    saved === undefined ? delete process.env.FACTORY_LOCAL_TOKEN : (process.env.FACTORY_LOCAL_TOKEN = saved);
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

test("runningFactory: a release is a checkout at its own release tag and unchanged, or one serve fetched; a branch or a local change is not", async () => {
  const fx = factoryRepo();
  fx.release("9.9.8");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.equal(runningFactory(fx.work, "9.9.8", home).release, true, "at its tag");
  assert.equal(runningFactory(fx.work, "9.9.7", home).release, false, "plugin.json names a release this commit is not");
  writeFileSync(join(fx.work, "plugin", "scripts", "local.mjs"), "// a change of my own\n");
  assert.equal(runningFactory(fx.work, "9.9.8", home).release, false, "a tracked file changed");
  git(fx.work, "checkout", "-q", "--", ".");
  git(fx.work, "commit", "-q", "--allow-empty", "-m", "between releases");
  assert.equal(runningFactory(fx.work, "9.9.8", home).release, false, "a commit after the tag");
  const before = git(fx.work, "rev-parse", "HEAD");
  const fetched = await releaseCheckout(fx.release("9.9.9"), { home, url: fx.url, running: { commit: before } });
  assert.equal(runningFactory(fetched.dir, "9.9.9", home).release, true, "a checkout serve fetched, by SHA");
  assert.equal(runningFactory(mkdtempSync(join(tmpdir(), "nogit-")), "9.9.9", home).release, false, "no git checkout");
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
  const fx = factoryRepo();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  fx.release("9.9.9");
  const checkout = await releaseCheckout("v9.9.9", { home, url: fx.url });
  // A process that runs as serve does (local.mjs serve ...) and calls the real restartOn, so the real process.execve runs.
  const script = join(mkdtempSync(join(tmpdir(), "rs-")), "serve.mjs");
  writeFileSync(
    script,
    `import { Local, holderId } from ${JSON.stringify(LOCAL_MJS)};\nconst loop = Object.assign(Object.create(Local.prototype), { holder: holderId(), factory: { version: "0.9.30", commit: null }, releaseOpts: { home: ${JSON.stringify(home)} } });\nconsole.log(JSON.stringify({ before: process.pid, holder: loop.holder }));\nloop.restartOn({ ref: "v9.9.9", checkout: ${JSON.stringify(checkout)} });\nconsole.log("not replaced");\n`,
  );
  const r = spawnSync(process.execPath, [script, "serve", "--all", "--interval", "5"], { encoding: "utf8", env: { ...process.env, FACTORY_PLUGIN_ROOT: "/old/plugin" }, timeout: 30_000 });
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
  const fx = factoryRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const checkout = await releaseCheckout("v9.9.9", { home, url: fx.url });
  writeFileSync(join(checkout.dir, "plugin", "scripts", "local.mjs"), "planted\n");
  const execs = [];
  const loop = Object.assign(Object.create(Local.prototype), { factory: { version: "0.9.30", commit: null }, releaseOpts: { home }, execve: (...a) => execs.push(a) });
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
      const issue = { number: 7, title: "t", body: "", state: "open", labels: [{ name: "factory:objective" }], updated_at: new Date().toISOString() };
      if (url.pathname === "/repos/o/r/issues/7" && req.method === "GET") return send(200, issue);
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("labels") === "factory:objective") return send(200, [issue]);
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
async function serveOver(ad, { wf, factory, atTick, paused = () => [], stubs = () => ({}), github = {} }) {
  const env = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL, FACTORY_LOCAL_MAX_CONCURRENT: process.env.FACTORY_LOCAL_MAX_CONCURRENT, FACTORY_HARNESS: process.env.FACTORY_HARNESS };
  const fake = await fakeGitHub(github);
  process.env.GITHUB_API_URL = fake.url;
  process.env.FACTORY_LOCAL = "1";
  process.env.FACTORY_LOCAL_ALL = "1";
  delete process.env.FACTORY_LOCAL_MAX_CONCURRENT;
  delete process.env.FACTORY_HARNESS;
  let tick = 0;
  const loop = Object.assign(Object.create(Local.prototype), {
    dev: ad.dev,
    settingsBranch: "main",
    // Every tick fetches, so a push between two ticks is seen at the next.
    settingsEveryMs: 0,
    pins: ["v0.9.30"],
    harness: "claude",
    factory,
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

test("serve: a change to a hot setting applies from the next tick, says what changed, and leaves the stage in flight alone; any other setting waits for a restart (#276)", async () => {
  const ad = adopter({ FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_MODEL: "m1", FACTORY_LOCAL_DOMAINS: "a.example" });
  let stageEnd = null;
  const resumed = [];
  const { lines, loop } = await serveOver(ad, {
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_MODEL: "m1", FACTORY_LOCAL_DOMAINS: "a.example" },
    factory: { version: "0.9.30", commit: null, root: "/f", release: true },
    // Tick 1 starts #7; the change lands during tick 2; from then on, #8 is this machine's paused work, which has no
    // slot beside #7 at one stage at a time.
    atTick: (n, l) => {
      // What a stage may reach or receive changes too: that waits for a restart.
      if (n === 2) ad.push({ FACTORY_LOCAL_MAX_CONCURRENT: "2", FACTORY_MODEL: "m2", FACTORY_LOCAL_DOMAINS: "evil.example", FACTORY_LOCAL_ENV: "AWS_SECRET_ACCESS_KEY" }, "v0.9.30");
      if (n >= 8) l.stopping = true;
    },
    paused: (n) => (n >= 2 ? [8] : []),
    stubs: (loop) => ({
      runObjective: () => new Promise((ok) => (stageEnd = ok)),
      resume: async (n) => {
        resumed.push(n);
        loop.stopping = true;
        stageEnd?.({ exit: "delivered" });
        return { exit: "delivered" };
      },
    }),
  });
  const text = lines.join("");
  assert.match(text, /the workflow's settings on origin\/main changed; each stage that starts from now on runs with them, and stages in flight keep theirs: FACTORY_LOCAL_MAX_CONCURRENT: "1" → "2"; FACTORY_MODEL: "m1" → "m2"/);
  assert.match(text, /at most 2 Objective stage\(s\) at once on this box/);
  assert.deepEqual(resumed, [8], "the new limit gives the paused Objective a slot beside the stage in flight");
  assert.equal(loop.baseEnv().FACTORY_MODEL, "m2", "stages that start now get the new settings");
  assert.match(text, /the workflow's settings on origin\/main changed; these take effect when serve restarts, and until then serve keeps the values it started with: FACTORY_LOCAL_DOMAINS: "a\.example" → "evil\.example"; FACTORY_LOCAL_ENV: unset → "AWS_SECRET_ACCESS_KEY"/);
  assert.equal(loop.wf.FACTORY_LOCAL_DOMAINS, "a.example");
  assert.equal(loop.wf.FACTORY_LOCAL_ENV, undefined);
  assert.equal(loop.baseEnv().AWS_SECRET_ACCESS_KEY, undefined);
  assert.deepEqual(loop.domains().slice(-1), ["a.example"]);
  assert.equal((text.match(/settings on origin\/main changed/g) || []).length, 2, "each said once");
});

test("serve: a new pinned release is announced, holds new stages while one runs, and serve starts again on it once none runs (#276)", async () => {
  const ad = adopter({ FACTORY_LOCAL_MAX_CONCURRENT: "3" });
  const fx = factoryRepo();
  fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  let stageEnd = null;
  const offered = [];
  const execs = [];
  const { lines, loop } = await serveOver(ad, {
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "3" },
    factory: { version: "0.9.30", commit: null, root: "/f", release: true },
    atTick: (n, l) => {
      // Tick 1 starts #7; the repin lands before tick 2. The stage in flight ends a few ticks after the release is ready.
      if (n === 1) ad.push({ FACTORY_LOCAL_MAX_CONCURRENT: "3" }, "v9.9.9");
      if (l.repin?.state === "ready" && (l.waited = (l.waited || 0) + 1) === 3) stageEnd({ exit: "delivered" });
      if (n >= 200) l.stopping = true;
    },
    paused: (n, l) => {
      offered.push({ n, waiting: !!l.repin && !execs.length });
      return [];
    },
    stubs: (loop) => ({
      releaseOpts: { home, url: fx.url },
      runObjective: () => new Promise((ok) => (stageEnd = ok)),
      execve: (...args) => {
        execs.push(args);
        loop.stopping = true;
      },
    }),
  });
  const text = lines.join("");
  assert.match(text, /the workflow on origin\/main pins clockgrove\/factory@v9\.9\.9; this serve runs v0\.9\.30\. It fetches v9\.9\.9 from https:\/\/github\.com\/clockgrove\/factory\.git and starts no new stage meanwhile; once the 1 stage\(s\) in flight here end, serve runs on v9\.9\.9/);
  assert.match(text, /tick: nothing ready.*no new stage until serve runs on clockgrove\/factory@v9\.9\.9/);
  assert.doesNotMatch(text, /this box is full/);
  assert.ok(loop.waited >= 3, "the switch waited for the stage in flight");
  assert.deepEqual(offered.filter((o) => o.waiting), [], "no paused work is resumed while the switch waits");
  assert.equal(execs.length, 1, "started again once");
  const [file, argv, env] = execs[0];
  assert.equal(file, process.execPath);
  assert.match(argv.at(-1 - (process.argv.length - 2)), new RegExp(`^${releasesDir(home)}/v9\\.9\\.9-[0-9a-z]+/plugin/scripts/local\\.mjs$`));
  assert.equal(env.FACTORY_PLUGIN_ROOT, undefined);
  assert.match(text, /no stage runs here: serve starts again on clockgrove\/factory@v9\.9\.9/);
  assert.doesNotMatch(text, /could not start again/);
});

test("serve: a repository variable sets a setting over the workflow; a hot one applies from the next tick, any other waits for a restart, an excluded one is named and ignored (#284)", async () => {
  const ad = adopter({ FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_MAX_USD: "25" });
  let vars = {};
  const seen = [];
  const { lines, loop } = await serveOver(ad, {
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_MAX_USD: "25" },
    factory: { version: "0.9.30", commit: null, root: "/f", release: true },
    github: { variables: () => ({ vars }), seen },
    atTick: (n, l) => {
      if (n === 2) vars = { FACTORY_LOCAL_MAX_CONCURRENT: "2", FACTORY_MAX_USD: "5", FACTORY_AUTO_MERGE: "false", OTHER: "x" };
      if (n >= 6) l.stopping = true;
    },
    stubs: () => ({ runObjective: async () => ({ exit: "delivered" }) }),
  });
  const text = lines.join("");
  assert.match(text, /the repository's settings \(the workflow on origin\/main and its variables\) changed; each stage that starts from now on runs with them, and stages in flight keep theirs: FACTORY_LOCAL_MAX_CONCURRENT: "1" → "2" \(repository variable\)/);
  assert.match(text, /at most 2 Objective stage\(s\) at once on this box/);
  assert.match(text, /the repository's settings \(the workflow on origin\/main and its variables\) changed; these take effect when serve restarts, and until then serve keeps the values it started with: FACTORY_MAX_USD: "25" → "5" \(repository variable\)/);
  assert.equal(text.split("repository variable FACTORY_AUTO_MERGE ignored: only the reviewed workflow file sets it").length - 1, 1, "named once");
  assert.doesNotMatch(text, /FACTORY_AUTO_MERGE: /);
  assert.deepEqual({ cap: loop.wf.FACTORY_LOCAL_MAX_CONCURRENT, usd: loop.wf.FACTORY_MAX_USD, merge: loop.wf.FACTORY_AUTO_MERGE }, { cap: "2", usd: "25", merge: undefined });
  assert.equal(loop.from.FACTORY_LOCAL_MAX_CONCURRENT, "variable");
  // One list call a read, conditional: an unchanged list is GitHub's 304, which costs no rate limit.
  assert.ok(seen.length >= 4);
  assert.equal(seen[0], null);
  assert.ok(seen.slice(1).every((t) => typeof t === "string"), "every later read sends the last ETag");
});

test("serve: a token without Variables: read is said once, with the fix, and the workflow's values stand (#284)", async () => {
  const ad = adopter({ FACTORY_LOCAL_MAX_CONCURRENT: "1" });
  const { lines, loop } = await serveOver(ad, {
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "1" },
    factory: { version: "0.9.30", commit: null, root: "/f", release: true },
    github: { variables: () => ({ status: 403 }) },
    atTick: (n, l) => {
      if (n >= 4) l.stopping = true;
    },
    stubs: () => ({ runObjective: async () => ({ exit: "delivered" }) }),
  });
  const text = lines.join("");
  const said = "the local token cannot read this repository's variables (HTTP 403), so its FACTORY_* repository variables do not apply on this machine and the workflow's values stand; give the token Variables: read (docs/LOCAL.md, Set it up)";
  assert.equal(text.split(said).length - 1, 1, "said once");
  assert.equal(loop.wf.FACTORY_LOCAL_MAX_CONCURRENT, "1");
  assert.doesNotMatch(text, /settings .*changed/);
});

test("serve: a pin it does not follow is said once and changes nothing: a branch, or a serve run from a checkout that is not a release (#276)", async () => {
  for (const [pin, factory, said] of [
    ["main", { version: "0.9.30", commit: null, root: "/f", release: true }, /pins clockgrove\/factory@main is neither a release tag \(vX\.Y\.Z\) nor a full commit SHA; serve runs no code from it and keeps running v0\.9\.30/],
    ["v9.9.9", { version: "0.9.30", commit: "c".repeat(40), root: "/dev/factory", release: false }, /pins clockgrove\/factory@v9\.9\.9; this serve runs v0\.9\.30 \(ccccccc\) from \/dev\/factory, which is not a release checkout, so it keeps running that: start serve from v9\.9\.9 to run it/],
  ]) {
    const ad = adopter({}, pin);
    const { lines, loop } = await serveOver(ad, {
      wf: {},
      factory,
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

test("committedWorkflowNow: a running serve reads the default branch's workflow as pushed since, and leaves the developer's own refs and FETCH_HEAD alone", async () => {
  const ad = adopter({ FACTORY_MODEL: "m1" });
  const settingsOf = ({ text: _text, ...rest }) => rest;
  assert.deepEqual(settingsOf(await committedWorkflowNow(ad.dev, "main")), { wf: { FACTORY_MODEL: "m1" }, pins: ["v0.9.30"], branch: "main", error: null });
  ad.push({ FACTORY_MODEL: "m2" }, "v0.9.31");
  // The developer's clone has not seen the push.
  git(ad.dev, "update-ref", "refs/remotes/origin/main", "HEAD~1");
  const theirs = git(ad.dev, "rev-parse", "refs/remotes/origin/main");
  assert.deepEqual(settingsOf(await committedWorkflowNow(ad.dev, "main")), { wf: { FACTORY_MODEL: "m2" }, pins: ["v0.9.31"], branch: "main", error: null });
  assert.equal(git(ad.dev, "rev-parse", "refs/remotes/origin/main"), theirs, "origin's ref moves only on the developer's own fetch");
  assert.equal(existsSync(join(ad.dev, ".git", "FETCH_HEAD")), false, "no FETCH_HEAD for a `git pull` to merge");
  // Offline: nothing read, never an older commit's settings (refreshSettings keeps what it has).
  git(ad.dev, "remote", "set-url", "origin", join(ad.dev, "gone.git"));
  assert.deepEqual(await committedWorkflowNow(ad.dev, "main"), { wf: {}, pins: [], branch: "main", error: "origin/main could not be fetched", unfetched: true });
  const loop = Object.assign(Object.create(Local.prototype), { dev: ad.dev, settingsBranch: "main", wf: { FACTORY_MODEL: "m3" }, pins: ["v0.9.32"] });
  await loop.refreshSettings();
  assert.deepEqual({ wf: loop.wf, pins: loop.pins }, { wf: { FACTORY_MODEL: "m3" }, pins: ["v0.9.32"] });
});

test("refreshSettings: a change waits while a stage is being set up, so one stage never mixes two harnesses' settings", async () => {
  const ad = adopter({ FACTORY_MODEL: "m1" });
  const harness = process.env.FACTORY_HARNESS;
  delete process.env.FACTORY_HARNESS;
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const loop = Object.assign(Object.create(Local.prototype), { dev: ad.dev, settingsBranch: "main", harness: "claude", wf: { FACTORY_MODEL: "m1" }, settingUp: 1 });
    ad.push({ FACTORY_MODEL: "m2" }, "v0.9.31");
    await loop.refreshSettings();
    assert.deepEqual(loop.wf, { FACTORY_MODEL: "m1" }, "kept while the set-up runs");
    assert.deepEqual(loop.pins, ["v0.9.31"], "the pin is read all the same");
    loop.settingUp = 0;
    await loop.refreshSettings();
    assert.deepEqual(loop.wf, { FACTORY_MODEL: "m2" }, "taken once no stage is being set up");
  } finally {
    process.stdout.write = write;
    if (harness !== undefined) process.env.FACTORY_HARNESS = harness;
  }
  assert.equal(lines.filter((l) => /settings on origin\/main changed/.test(l)).length, 1);
});

test("refreshSettings: a change of harness holds the models and effort with it until serve restarts: they belong to that harness (#284)", async () => {
  const ad = adopter({ FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_MAX_CONCURRENT: "2" });
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const loop = Object.assign(Object.create(Local.prototype), { dev: ad.dev, settingsBranch: "main", harness: "claude", wf: { FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_MAX_CONCURRENT: "2" } });
    ad.push({ FACTORY_HARNESS: "codex", FACTORY_MODEL: "gpt-x", FACTORY_MAX_CONCURRENT: "3" }, "v0.9.31");
    await loop.refreshSettings();
    assert.deepEqual(loop.wf, { FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_MAX_CONCURRENT: "3" }, "a hot setting of another kind still applies");
    assert.match(lines.join(""), /take effect when serve restarts.*FACTORY_HARNESS: "claude" → "codex"; FACTORY_MODEL: "claude-opus-5-5" → "gpt-x"/);
  } finally {
    process.stdout.write = write;
  }
});

test("followPin: a new switch waits until 30 minutes after the last, and a SHA before the running commit is refused, not retried", async () => {
  const fx = factoryRepo();
  const older = fx.release("9.9.8");
  const newer = fx.release("9.9.9");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const loop = Object.assign(Object.create(Local.prototype), { settingsBranch: "main", pins: ["v9.9.9"], factory: { version: "9.9.8", commit: older, root: "/f", release: true }, releaseOpts: { home, url: fx.url }, switchedAt: Date.now() - 60_000 });
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
    // A full SHA that is not on Factory's main: refused until the pin changes, never fetched again every ten minutes.
    loop.pins = ["0123456789abcdef0123456789abcdef01234567"];
    await loop.followPin(0);
    await loop.repin.fetch;
    assert.equal(loop.repin.state, "refused");
    loop.repin.retryAt = Date.now() - 1;
    const tried = loop.repin;
    assert.equal(await loop.followPin(0), false);
    assert.equal(loop.repin, tried, "not tried again");
    // A SHA before the commit serve runs: refused, said once, and no stage waits for it.
    loop.factory = { version: "9.9.9", commit: newer, root: "/f", release: true };
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

/** A web server that takes connections and never answers: a stalled host. */
async function stalledHost() {
  const socks = [];
  const server = createNetServer((sock) => {
    socks.push(sock);
    sock.on("data", () => {});
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}/factory.git`, close: () => (socks.forEach((x) => x.destroy()), new Promise((ok) => server.close(ok))) };
}

test("a stalled fetch ends at its timeout, every git process with it: a release fetch fails and is tried again, a settings read is unfetched", async () => {
  const host = await stalledHost();
  try {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const t0 = Date.now();
    await assert.rejects(releaseCheckout("v9.9.9", { home, url: host.url, timeoutMs: 2000 }), /fetching v9\.9\.9/);
    assert.ok(Date.now() - t0 < 20_000, "ended near its timeout");
    const dev = mkdtempSync(join(tmpdir(), "dev-"));
    execFileSync("git", ["init", "-q", dev]);
    git(dev, "remote", "add", "origin", host.url);
    const t1 = Date.now();
    assert.equal((await committedWorkflowNow(dev, "main", { timeoutMs: 2000 })).unfetched, true);
    assert.ok(Date.now() - t1 < 20_000, "ended near its timeout");
  } finally {
    await host.close();
  }
});

test("refreshSettings: the default branch is fetched every few minutes, and never with the developer's credential helper", async () => {
  const ad = adopter({ FACTORY_MODEL: "m1" });
  const loop = Object.assign(Object.create(Local.prototype), { dev: ad.dev, settingsBranch: "main", wf: { FACTORY_MODEL: "m1" }, token: "t" });
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await loop.refreshSettings();
    ad.push({ FACTORY_MODEL: "m2" }, "v0.9.30");
    await loop.refreshSettings();
    assert.equal(loop.wf.FACTORY_MODEL, "m1", "a tick soon after the last read takes what it brought");
    loop.settingsReadAt -= 3 * 60_000;
    await loop.refreshSettings();
    assert.equal(loop.wf.FACTORY_MODEL, "m2", "a few minutes on, fetched again");
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

test("a serve that stops at the start of the release it switched to says so, and how to go back", () => {
  const r = spawnSync(process.execPath, [LOCAL_MJS, "serve", "--dir", join(tmpdir(), "no-such-clone")], { encoding: "utf8", env: { ...process.env, FACTORY_SERVE_SWITCHED_FROM: "/old/factory" }, timeout: 30_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /serve stopped at the start of the release it switched to, .* from \/old\/factory; start serve from \/old\/factory\/plugin\/bin\/factory to run that one again/);
});
