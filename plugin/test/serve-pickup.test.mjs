import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Local, SERVE_HOLDER_ENV, holderId, inheritedHolder, machineIdentity, settingsChanges } from "../scripts/local.mjs";
import { committedWorkflowNow, workflowPins } from "../scripts/lib/local.mjs";
import { pinDecision, releaseCheckout, releasesDir, runningFactory } from "../scripts/lib/release.mjs";
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
    // The loop of this release: its usage on --help; otherwise what it was started with, in the same process or not.
    writeFileSync(
      join(work, "plugin", "scripts", "local.mjs"),
      `import { inheritedHolder } from ${JSON.stringify(LOCAL_MJS)};\nif (process.argv.includes("--help")) process.exit(0);\nconsole.log(JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid, argv: process.argv.slice(2), holder: inheritedHolder(process.env.${SERVE_HOLDER_ENV}), pluginRoot: process.env.FACTORY_PLUGIN_ROOT ?? null }));\n`,
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
  const text = "jobs:\n  a:\n    steps:\n      - uses: clockgrove/factory@v0.9.31 # pinned\n      - uses: actions/checkout@v7\n      - uses: 'clockgrove/factory@v0.9.31'\n#     - uses: clockgrove/factory@main\n  b:\n    steps:\n      - uses: clockgrove/factory@0123456789abcdef0123456789abcdef01234567\n";
  assert.deepEqual(workflowPins(text), ["v0.9.31", "0123456789abcdef0123456789abcdef01234567"]);
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
});

test("releaseCheckout: a release tag or a SHA on Factory's main is fetched once, verified on every use, and refetched when touched; anything else is refused", async () => {
  const fx = factoryRepo();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  fx.release("9.9.8");
  const sha = fx.release("9.9.9");
  const c = await releaseCheckout("v9.9.9", { home, url: fx.url });
  assert.equal(c.dir, join(releasesDir(home), "v9.9.9"));
  assert.equal(c.commit, sha);
  assert.equal(c.version, "9.9.9");
  assert.equal(JSON.parse(readFileSync(join(c.dir, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version, "9.9.9");
  // A file of it changed: not that release any more, so fetched again.
  writeFileSync(join(c.dir, "plugin", "scripts", "local.mjs"), "planted\n");
  const again = await releaseCheckout("v9.9.9", { home, url: fx.url });
  assert.notEqual(readFileSync(join(again.dir, "plugin", "scripts", "local.mjs"), "utf8"), "planted\n");
  // A SHA on main.
  const bySha = await releaseCheckout(sha, { home, url: fx.url });
  assert.equal(bySha.commit, sha);
  // A tag whose plugin.json names another release, a SHA off main, a branch name: refused, nothing kept.
  fx.release("9.9.10", { tag: "v9.9.11" });
  await assert.rejects(releaseCheckout("v9.9.11", { home, url: fx.url }), /is not that release/);
  assert.equal(existsSync(join(releasesDir(home), "v9.9.11")), false);
  const off = fx.release("9.9.12", { tag: null, branch: "side" });
  await assert.rejects(releaseCheckout(off, { home, url: fx.url }), /not a commit on .*'s main/);
  await assert.rejects(releaseCheckout("main", { home, url: fx.url }), /neither a release tag nor a full commit SHA/);
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
  const fetched = await releaseCheckout(fx.release("9.9.9"), { home, url: fx.url });
  assert.equal(runningFactory(fetched.dir, "9.9.9", home).release, true, "a checkout serve fetched, by SHA");
  assert.equal(runningFactory(mkdtempSync(join(tmpdir(), "nogit-")), "9.9.9", home).release, false, "no git checkout");
});

test("inheritedHolder: only this process's own holder on this machine and boot is taken", () => {
  const id = machineIdentity();
  const own = holderId(id, process.pid);
  assert.equal(inheritedHolder(own), own);
  assert.equal(inheritedHolder(holderId(id, process.pid + 1)), null, "another process's");
  assert.equal(inheritedHolder(holderId({ ...id, host: `${id.host}-other` }, process.pid)), null, "another machine's");
  assert.equal(inheritedHolder(holderId({ ...id, boot: "another-boot" }, process.pid)), null, "another boot's");
  assert.equal(inheritedHolder(undefined), null);
});

test("restartOn: serve starts again on the release in the same process, with its arguments and its claim holder, and without a plugin root override", { skip: typeof process.execve !== "function" && "this Node has no process.execve" }, async () => {
  const fx = factoryRepo();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  fx.release("9.9.9");
  const checkout = await releaseCheckout("v9.9.9", { home, url: fx.url });
  // A process that runs as serve does (local.mjs serve ...) and calls the real restartOn, so the real process.execve runs.
  const script = join(mkdtempSync(join(tmpdir(), "rs-")), "serve.mjs");
  writeFileSync(
    script,
    `import { Local, holderId } from ${JSON.stringify(LOCAL_MJS)};\nconst loop = Object.assign(Object.create(Local.prototype), { holder: holderId(), factory: { version: "0.9.30", commit: null } });\nconsole.log(JSON.stringify({ before: process.pid, holder: loop.holder }));\nloop.restartOn({ ref: "v9.9.9", checkout: ${JSON.stringify(checkout)} });\nconsole.log("not replaced");\n`,
  );
  const r = spawnSync(process.execPath, [script, "serve", "--all", "--interval", "5"], { encoding: "utf8", env: { ...process.env, FACTORY_PLUGIN_ROOT: "/old/plugin" }, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const [first, , after] = r.stdout.trim().split("\n");
  const before = JSON.parse(first);
  const ran = JSON.parse(after);
  assert.equal(ran.version, "9.9.9", "the release's own loop runs");
  assert.equal(ran.pid, before.before, "in the same process");
  assert.deepEqual(ran.argv, ["serve", "--all", "--interval", "5"]);
  assert.equal(ran.holder, before.holder, "its claim holder is its own there");
  assert.equal(ran.pluginRoot, null);
  assert.doesNotMatch(r.stdout, /not replaced/);
});

/** A GitHub with one Objective, #7, that the dispatcher picks for this loop. */
async function fakeGitHub() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
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
async function serveOver(ad, { wf, factory, atTick, paused = () => [], stubs = () => ({}) }) {
  const env = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL, FACTORY_LOCAL_MAX_CONCURRENT: process.env.FACTORY_LOCAL_MAX_CONCURRENT, FACTORY_HARNESS: process.env.FACTORY_HARNESS };
  const fake = await fakeGitHub();
  process.env.GITHUB_API_URL = fake.url;
  process.env.FACTORY_LOCAL = "1";
  process.env.FACTORY_LOCAL_ALL = "1";
  delete process.env.FACTORY_LOCAL_MAX_CONCURRENT;
  delete process.env.FACTORY_HARNESS;
  let tick = 0;
  const loop = Object.assign(Object.create(Local.prototype), {
    dev: ad.dev,
    settingsBranch: "main",
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

test("serve: a settings change on the default branch applies from the next tick, says what changed, and leaves the stage in flight alone (#276)", async () => {
  const ad = adopter({ FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_MODEL: "m1" });
  let stageEnd = null;
  const resumed = [];
  const { lines, loop } = await serveOver(ad, {
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_MODEL: "m1" },
    factory: { version: "0.9.30", commit: null, root: "/f", release: true },
    // Tick 1 starts #7; the change lands during tick 2; from then on, #8 is this machine's paused work, which has no
    // slot beside #7 at one stage at a time.
    atTick: (n, l) => {
      if (n === 2) ad.push({ FACTORY_LOCAL_MAX_CONCURRENT: "2", FACTORY_MODEL: "m2" }, "v0.9.30");
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
  assert.equal((text.match(/settings on origin\/main changed/g) || []).length, 1, "said once");
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
  assert.equal(argv.at(-1 - (process.argv.length - 2)), join(releasesDir(home), "v9.9.9", "plugin", "scripts", "local.mjs"));
  assert.equal(env.FACTORY_SERVE_HOLDER, loop.holder);
  assert.match(text, /no stage runs here: serve starts again on clockgrove\/factory@v9\.9\.9/);
  assert.doesNotMatch(text, /could not start again/);
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
  assert.deepEqual(await committedWorkflowNow(ad.dev, "main"), { wf: { FACTORY_MODEL: "m1" }, pins: ["v0.9.30"], branch: "main", error: null });
  ad.push({ FACTORY_MODEL: "m2" }, "v0.9.31");
  // The developer's clone has not seen the push.
  git(ad.dev, "update-ref", "refs/remotes/origin/main", "HEAD~1");
  const theirs = git(ad.dev, "rev-parse", "refs/remotes/origin/main");
  assert.deepEqual(await committedWorkflowNow(ad.dev, "main"), { wf: { FACTORY_MODEL: "m2" }, pins: ["v0.9.31"], branch: "main", error: null });
  assert.equal(git(ad.dev, "rev-parse", "refs/remotes/origin/main"), theirs, "origin's ref moves only on the developer's own fetch");
  assert.equal(existsSync(join(ad.dev, ".git", "FETCH_HEAD")), false, "no FETCH_HEAD for a `git pull` to merge");
  // Offline: the last fetched commit.
  git(ad.dev, "remote", "set-url", "origin", join(ad.dev, "gone.git"));
  assert.deepEqual((await committedWorkflowNow(ad.dev, "main")).wf, { FACTORY_MODEL: "m2" });
});
