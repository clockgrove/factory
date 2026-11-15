import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The stage script serve starts is this file's fake worker: it notes the account its env was made for, waits for FAKE_GO
// when told to (a stage still running), then writes the result.json a test gives it, with that account's name as the real
// worker records it (session.mjs writeUsage `account`). Set before local.mjs is loaded, so
// serve's real start, hold, pause and resume paths run.
const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-")));
mkdirSync(join(root, "scripts"));
writeFileSync(
  join(root, "scripts", "worker.mjs"),
  'import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst a = process.argv;\nappendFileSync(process.env.FAKE_RAN, `${process.env.FAKE_ACCOUNT}\\n`);\nif (process.env.FAKE_GO) while (!existsSync(process.env.FAKE_GO)) await new Promise((r) => setTimeout(r, 20));\nwriteFileSync(join(a[a.indexOf("--usage-dir") + 1], "result.json"), JSON.stringify({ ...JSON.parse(process.env.FAKE_RESULT), account: process.env.FAKE_ACCOUNT }));\n',
);
process.env.FACTORY_PLUGIN_ROOT = root;
const { RETRY } = await import("../scripts/lib/github.mjs");
const { accountHolds, holdsDir } = await import("../scripts/lib/holds.mjs");
const { Local, holderId, machineIdentity, pauseNoticeBody } = await import("../scripts/local.mjs");
const { accountLabelNote, accountPin, accountsFile, autoAccountSetting, chooseAccount, harnessAccounts, loadAccounts, pinnedAccount } = await import("../scripts/lib/accounts.mjs");
const { gitPinFile, pinGitDir } = await import("../scripts/lib/local.mjs");
const { choiceTrusted, objectiveSha } = await import("../scripts/lib/objective-trust.mjs");

RETRY.sleep = async () => {};
const MIN = 60_000;
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const NOTICE = "<!-- factory:8:account-limit -->";

/** A stand-in home: Claude Code accounts alpha (the default), beta and gamma, and a Codex account cx. Every file is a dummy. */
function fakeHome() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "move-")));
  for (const d of [".claude", ".codex", ".config/factory", "work/claude-a", "work/claude-b", "work/claude-c", "work/codex-x"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "factory"), 0o700);
  const at = (d) => join(h, "work", d);
  writeFileSync(accountsFile(h), JSON.stringify({ claude: [{ name: "alpha", home: at("claude-a") }, { name: "beta", home: at("claude-b") }, { name: "gamma", home: at("claude-c") }], codex: [{ name: "cx", home: at("codex-x") }] }), { mode: 0o600 });
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
 * A GitHub for Objective #8: its labels (each `labeled` or `unlabeled` on the timeline, by `kirk`, who can push, unless
 * another login is given), comments, the people who can push (`writers`), and a count of timeline reads. The issue's
 * `updated_at` moves as GitHub's does: on a label change and a new comment. Every write is kept in `writes`.
 */
function fakeGitHub(labels = ["factory:objective", "factory:local", "factory:running"]) {
  const state = { labels: new Set(labels), timeline: [], comments: [], writes: [], timelineReads: 0, writers: new Set(["maintainer", "kirk"]), updated: 0, now: () => Date.now() };
  const touch = () => (state.updated += 1);
  let id = 100;
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const issue = () => ({ number: 8, state: "open", title: "t", body: "b", labels: [...state.labels].map((name) => ({ name })), updated_at: new Date(Date.UTC(2026, 10, 15) + state.updated * 1000).toISOString() });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname.replace("/repos/acme/app", "");
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") state.writes.push(`${method} ${p} ${init.body || ""}`);
    if (p === "/user") return json({ login: "maintainer", type: "User" });
    if (p === "/collaborators") return json([{ login: "maintainer" }]);
    const perm = /^\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (perm) return json({ permission: state.writers.has(perm[1]) ? "write" : "read" });
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "GET" && p === "/issues/8/timeline") return (state.timelineReads += 1), json(state.timeline);
    if (method === "GET" && p === "/issues/8") return json(issue());
    if (method === "GET" && p === "/issues") return json(state.labels.has(u.searchParams.get("labels")) ? [issue()] : []);
    if (method === "GET" && p === "/issues/8/comments") return json(state.comments);
    if (method === "POST" && p === "/issues/8/comments") {
      const c = { id: (id += 1), user: { login: "maintainer", type: "User" }, body: JSON.parse(init.body).body, updated_at: new Date(state.now()).toISOString() };
      state.comments.push(c);
      touch();
      return json(c, 201);
    }
    const one = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (one && method === "PATCH") {
      const c = state.comments.find((x) => String(x.id) === one[1]);
      Object.assign(c, { body: JSON.parse(init.body).body, updated_at: new Date(state.now()).toISOString() });
      return json(c);
    }
    if (one && method === "DELETE") {
      state.comments.splice(state.comments.findIndex((x) => String(x.id) === one[1]), 1);
      return json({});
    }
    const label = /^\/issues\/8\/labels\/(.+)$/.exec(p);
    if (label && method === "DELETE") return state.labels.delete(decodeURIComponent(label[1])) ? (touch(), json([])) : json({ message: "Not Found" }, 404);
    if (p === "/issues/8/labels" && method === "POST") {
      for (const l of JSON.parse(init.body).labels) state.labels.add(l);
      touch();
      return json([]);
    }
    if (p === "/graphql") return json({ data: {} });
    if (method === "GET") return json([]);
    return json({});
  };
  return {
    ...state,
    state,
    apply(name, by = "kirk") {
      state.labels.add(name);
      touch();
      state.timeline.push({ event: "labeled", label: { name }, created_at: new Date(Date.UTC(2026, 10, 15) + state.timeline.length * 1000).toISOString(), actor: { login: by, id: 5, type: "User" } });
    },
    remove(name, by = "kirk") {
      state.labels.delete(name);
      touch();
      state.timeline.push({ event: "unlabeled", label: { name }, created_at: new Date(Date.UTC(2026, 10, 15) + state.timeline.length * 1000).toISOString(), actor: { login: by, id: 5, type: "User" } });
    },
    notices: () => state.comments.filter((c) => c.body.startsWith(NOTICE)),
    blocked: () => state.comments.filter((c) => c.body.includes("factory:block")),
    restore() {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
    },
  };
}

/**
 * A serve on the fake home, as account-holds.test.mjs makes one: the real harnessFor (the issue and its labels read from
 * the fake GitHub), startStage, withClaim, pausedHere and the machine's holds; srt stands in as the git sandbox and the
 * fake worker as the stage. harnessReady is the one stand-in (no harness CLI here).
 */
function serveOn(h, clock) {
  const dev = join(h, "work", `repo-${Math.random().toString(36).slice(2, 8)}`);
  const loop = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repo: REPO, repoFull: REPO.full, wf: {}, opts: { token: "t" }, stopping: false, firstSetup: new Map(), children: new Set(), clock, holder: holderId(machineIdentity(), process.pid), claimRetryMs: 0, claimSettleMs: 0 });
  loop.holds = accountHolds({ dir: holdsDir(h) });
  loop.baseEnv = () => ({ FACTORY_LOCAL_ALL: "1" });
  loop.harnessReady = () => [];
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
  loop.result = {};
  loop.wait = false;
  loop.stageEnv = (issue, usageDir, c, stageTmp, script, harness, hosts, account) => ({ PATH: `${bin}:${process.env.PATH}`, FACTORY_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1], FAKE_RAN: ran, FAKE_ACCOUNT: account?.name ?? "none", FAKE_RESULT: JSON.stringify(loop.result), ...(loop.wait ? { FAKE_GO: join(dev, "go") } : {}) });
  loop.go = () => writeFileSync(join(dev, "go"), "");
  loop.ran = () => readFileSync(ran, "utf8").split("\n").filter(Boolean);
  return loop;
}

/** A work stage that ends on its usage limit of `window`, reset at `reset` (ms), as session.mjs usageLimitExit writes it. */
const limited = (reset, since, window = "five_hour") => ({ exit: "paused", usd: 0.1, tokens: { output: 0 }, usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(since).toISOString(), limitType: window } });
const work = (loop) => loop.withClaim(8, () => loop.stage(8, "work", "worker.mjs", []));

test("#265: the label's name, decided on the names alone: one pins, two move nothing, a name is an account of the Objective's harness or a problem naming the label", () => {
  assert.deepEqual(accountPin(["factory:objective"]), { label: null });
  assert.deepEqual(accountPin(["factory:objective", { name: "factory:account:Beta" }]), { label: "factory:account:Beta", name: "beta" });
  assert.deepEqual(accountPin(["factory:account:beta", "factory:account:gamma"]), { label: null, two: ["factory:account:beta", "factory:account:gamma"] });
  const h = fakeHome();
  const loaded = loadAccounts({ home: h, env: {} });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.problems));
  assert.equal(pinnedAccount(loaded, "claude", "beta").account.name, "beta");
  assert.match(pinnedAccount(loaded, "claude", "cx").problem, /^`factory:account:cx` names a Codex account, and this Objective runs on Claude Code$/);
  assert.match(pinnedAccount(loaded, "claude", "nobody").problem, /^`factory:account:nobody` names no Claude Code account this machine declares \(`alpha`, `beta`, `gamma`\)$/);
  assert.match(pinnedAccount(loaded, "copilot", "copilot").account.name, /^copilot$/, "a harness that declares none has its one account");
  assert.match(pinnedAccount(loaded, "claude", "claude").problem, /names no Claude Code account/, "with accounts declared, the harness's own name is none of them");
  assert.match(pinnedAccount(loaded, "claude", "`@x").problem, /^an account label whose name is no account name names no/, "a name that is no account name is never echoed");
});

test("#265: the label is no edit to the Objective: the plan's record and the choice-label trust check ignore it", async () => {
  assert.equal(objectiveSha("t", "b", ["factory:objective", "factory:account:beta"]), objectiveSha("t", "b", ["factory:objective"]));
  let reads = 0;
  const t = await choiceTrusted(REPO, 8, ["factory:objective", "factory:account:beta"], {}, { labelers: async () => (reads += 1, {}) });
  assert.equal(t.ok, true);
  assert.equal(reads, 0, "no timeline read for it");
});

test("#265: off local mode the label does nothing, and the stage's progress says so once", () => {
  assert.match(accountLabelNote(["factory:objective", "factory:account:beta"], false), /^`factory:account:beta` does nothing on this route: accounts are a local-mode setting/);
  assert.equal(accountLabelNote(["factory:objective", "factory:account:beta"], true), "", "local mode acts on it");
  assert.equal(accountLabelNote(["factory:objective"], false), "");
  for (const script of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", script), "utf8");
    const gate = src.indexOf("await choiceGate(");
    const note = src.indexOf("accountLabelNote(trusted.labels, local)");
    assert.ok(gate > 0 && note > gate, `${script}: once, after the labels are read and checked`);
    assert.equal(src.split("accountLabelNote(").length, 2, `${script}: one call`);
  }
});

test("#264/#265: a hold keeps the limit's window, and the pause notice names the account, its reset and window, and the free accounts with their labels, with no @mention", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now();
  const holds = accountHolds({ dir });
  holds.limit({ harness: "claude", account: "alpha", reset: t + 60 * MIN, now: t, window: "seven_day" });
  assert.equal(accountHolds({ dir }).window("alpha", t), "seven_day", "read back by another serve");
  holds.limit({ harness: "claude", account: "beta", reset: t + 60 * MIN, now: t, window: "not a window!" });
  assert.equal(holds.window("beta", t), null);
  const body = pauseNoticeBody({ harness: "claude", account: "alpha", reset: t + 60 * MIN, window: "five_hour", free: ["beta", "gamma"] });
  assert.match(body, /Claude Code account `alpha` reached it \(window `five_hour`\), which resets at /);
  assert.ok(body.includes(new Date(t + 60 * MIN).toISOString()));
  assert.match(body, /Free now: `beta` \(apply `factory:account:beta`\), `gamma` \(apply `factory:account:gamma`\)\./);
  assert.ok(!body.includes("@"));
  assert.match(pauseNoticeBody({ harness: "claude", account: "alpha", reset: t, window: "`@someone` ran" }), /\(its window was not reported\)/, "harness text in no other form is not shown");
  assert.match(pauseNoticeBody({ harness: "codex", account: "codex", reset: t, free: [] }), /Codex \(this machine's one Codex login\) reached it \(its window was not reported\)[\s\S]*No other Codex account on this machine is free now\./);
});


const reads = (gh) => gh.state.timelineReads;
const delivered = { exit: "delivered", tokens: { output: 10 } };

test("#265: a pause posts one notice, updated in place; a trusted label moves the paused Objective to a free account at once, read once per label change; a held pin waits for its reset; a removal by someone who can push goes back to the default", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = serveOn(h, () => t);
      // A stage on alpha (the default) meets its usage limit, reset in an hour.
      loop.result = limited(t + 60 * MIN, t);
      assert.equal((await work(loop)).account, "alpha");
      assert.deepEqual(loop.ran(), ["alpha"]);
      assert.equal(gh.notices().length, 1);
      const first = gh.notices()[0].body;
      assert.match(first, /Claude Code account `alpha` reached it \(window `five_hour`\), which resets at /);
      assert.match(first, /Free now: `beta` \(apply `factory:account:beta`\), `gamma` \(apply `factory:account:gamma`\)/);
      assert.ok(!first.includes("@"), "no @mention");
      assert.ok(!first.includes(h), "no path");
      assert.deepEqual(await loop.pausedHere(new Map()), [], "no label: it waits for alpha's reset");
      assert.equal(reads(gh), 0, "and reads nothing to decide it");
      // A person who can push applies factory:account:beta: resumed now, its labeler read once over several ticks.
      gh.apply("factory:account:beta");
      for (let i = 0; i < 3; i++) assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      assert.equal(reads(gh), 1, "once per label change, not every tick");
      // The resume's stage runs on beta, its env made for beta; a stage start reads the labeler afresh.
      loop.result = delivered;
      const moved = await work(loop);
      assert.deepEqual([moved.exit, moved.account, moved.pinned], ["delivered", "beta", true]);
      assert.deepEqual(loop.ran(), ["alpha", "beta"]);
      assert.equal(reads(gh), 2);
      // beta meets its own limit, reset in two hours: one notice still, now naming beta; alpha is still held, gamma is free.
      t += 5 * MIN;
      loop.result = limited(t + 120 * MIN, t, "seven_day");
      assert.equal((await work(loop)).account, "beta");
      assert.equal(gh.notices().length, 1, "one comment, updated in place");
      assert.match(gh.notices()[0].body, /Claude Code account `beta` reached it \(window `seven_day`\)/);
      assert.match(gh.notices()[0].body, /Free now: `gamma` \(apply `factory:account:gamma`\)\. /);
      // The label stays on beta, which is held: it waits for beta's reset, though alpha comes free first.
      t += 60 * MIN;
      assert.deepEqual(await loop.pausedHere(new Map()), [], "the pinned account is held: wait");
      // A stage started now on the pin is held before it runs, spending nothing.
      const held = await loop.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.account, held.usageLimit.held], ["paused", "beta", true]);
      assert.equal(loop.ran().length, 3);
      // A person who can push takes the label off: back to the default, alpha, free now: resumed before beta's reset.
      gh.remove("factory:account:beta");
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      loop.result = delivered;
      assert.equal((await work(loop)).account, "alpha");
      assert.equal(gh.blocked().length, 0, "nothing Blocked");
    });
  } finally {
    gh.restore();
  }
});

test("#265: someone who cannot push moves nothing: removing a trusted pin leaves a paused Objective waiting, and a second label keeps it waiting on no account, never on the default", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = serveOn(h, () => t);
      gh.apply("factory:account:beta");
      loop.result = limited(t + 120 * MIN, t);
      assert.equal((await work(loop)).account, "beta");
      // alpha, the default, is free: a removal by a stranger does not move it there.
      gh.remove("factory:account:beta", "stranger");
      for (let i = 0; i < 2; i++) assert.deepEqual(await loop.pausedHere(new Map()), []);
      assert.match(gh.notices()[0].body, /`factory:account:beta` was removed by `stranger`, who cannot push to acme\/app and is not a pinned maintainer, so Factory does not move the Objective off that account, so it stays paused/);
      // The pin back, and a stranger adds a second label: two labels, it waits, past beta's reset too, said once.
      gh.apply("factory:account:beta");
      gh.apply("factory:account:gamma", "stranger");
      const patches = () => gh.state.writes.filter((w) => w.startsWith("PATCH /issues/comments/") && w.includes("account-limit")).length;
      const before = patches();
      t += 121 * MIN;
      for (let i = 0; i < 3; i++) assert.deepEqual(await loop.pausedHere(new Map()), []);
      assert.equal(patches() - before, 1, "said once");
      assert.match(gh.notices()[0].body, /`factory:account:beta`, `factory:account:gamma`: more than one account label moves nothing, so the Objective waits, on no account, until one is left/);
      // A stage started anyway (a race with the tick) starts nothing and Blocks nothing: it waits.
      const waits = await loop.withClaim(8, () => loop.stage(8, "work", "worker.mjs", []));
      assert.equal(waits.exit, "paused");
      assert.equal(loop.ran().length, 1, "nothing ran, on the default or anywhere");
      assert.deepEqual(await loop.pausedHere(new Map()), [], "still two labels: still waiting");
      // One left: it goes on, on that one.
      gh.remove("factory:account:gamma");
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      assert.match(gh.notices()[0].body, /^<!-- factory:8:account-limit -->\nFactory: one account label or none is left, so the Objective goes on\.$/, "the note no longer says it waits");
      loop.result = delivered;
      assert.equal((await work(loop)).account, "beta");
      assert.equal(gh.blocked().length, 0, "never Blocked for it");
      // The dispatcher holds a queued Objective with two labels, whatever its accounts' holds.
      assert.match(loop.limitHold(["factory:objective", "factory:account:beta", "factory:account:gamma"], 8, "x"), /more than one account label moves nothing/);
      await Promise.all(loop.notesInFlight ?? []);
    });
  } finally {
    gh.restore();
  }
});

test("#265: a stage start reads the labeler afresh, so a label removed and applied again with no tick between is judged by its new labeler, both ways, and revoked push access counts at once", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = serveOn(h, () => t);
      loop.result = delivered;
      gh.apply("factory:account:beta");
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta");
      // Removed, and applied again by a stranger, with no tick between: Blocked, nothing ran on beta.
      gh.remove("factory:account:beta");
      gh.apply("factory:account:beta", "stranger");
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).exit, "blocked");
      assert.match(gh.blocked().at(-1).body, /`factory:account:beta` was applied by `stranger`/);
      assert.deepEqual(loop.ran(), ["beta"]);
      // The other way: kirk takes it off and applies it himself, no tick between: it runs on beta.
      gh.remove("factory:account:beta");
      gh.apply("factory:account:beta");
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta");
      // kirk loses push access: the next stage start knows it.
      gh.state.writers.delete("kirk");
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).exit, "blocked");
      assert.deepEqual(loop.ran(), ["beta", "beta"]);
      assert.equal(reads(gh), 4, "one read per stage start");
    });
  } finally {
    gh.restore();
  }
});

test("#265: a paused Objective's kept check follows the issue's updated_at: a stranger's label, then the same label re-applied by someone who can push before the next tick, moves it", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = serveOn(h, () => t);
      loop.result = limited(t + 60 * MIN, t);
      await work(loop);
      gh.apply("factory:account:beta", "stranger");
      assert.deepEqual(await loop.pausedHere(new Map()), []);
      gh.remove("factory:account:beta");
      gh.apply("factory:account:beta");
      assert.deepEqual(await loop.pausedHere(new Map()), [8], "read again: the issue changed");
      // And the reverse: a trusted label removed and re-applied by a stranger before the next tick does not move it.
      const other = serveOn(h, () => t);
      other.result = limited(t + 60 * MIN, t);
      gh.remove("factory:account:beta");
      await work(other);
      gh.apply("factory:account:beta");
      gh.remove("factory:account:beta");
      gh.apply("factory:account:beta", "stranger");
      assert.deepEqual(await other.pausedHere(new Map()), []);
    });
  } finally {
    gh.restore();
  }
});

test("#265: a running stage finishes on its own account and the pin applies from the next stage; the dispatcher weighs a pin only once its labeler is known to be trusted", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = serveOn(h, () => t);
      loop.result = delivered;
      loop.wait = true;
      const running = loop.stage(8, "work", "worker.mjs", []);
      while (loop.ran().length === 0) await new Promise((r) => setTimeout(r, 20));
      gh.apply("factory:account:gamma");
      loop.go();
      assert.equal((await running).account, "alpha", "it finishes where it started");
      loop.wait = false;
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "gamma");
      assert.deepEqual(loop.ran(), ["alpha", "gamma"]);
      // alpha held: an unpinned Objective waits; a trusted pin to beta starts once its labeler is read (in the
      // background, for the next tick); until then the default is weighed.
      loop.holds.limit({ harness: "claude", account: "alpha", reset: t + 60 * MIN, now: t });
      assert.match(loop.limitHold(["factory:objective"], 8, "u1"), /^claude account alpha's usage limit is spent until /);
      gh.remove("factory:account:gamma");
      gh.apply("factory:account:beta");
      const pinned = ["factory:objective", "factory:account:beta"];
      assert.match(loop.limitHold(pinned, 8, "u2"), /alpha's usage limit is spent/, "labeler not known yet: the default");
      await loop.pinReading.get(8);
      assert.equal(loop.limitHold(pinned, 8, "u2"), null, "trusted: beta, free");
      // A stranger's pin to a held account never holds a queued Objective whose default is free.
      loop.holds.limit({ harness: "claude", account: "gamma", reset: t + 8 * 24 * 60 * MIN, now: t });
      gh.remove("factory:account:beta");
      gh.apply("factory:account:gamma", "stranger");
      const strangers = ["factory:objective", "factory:account:gamma"];
      assert.match(loop.limitHold(strangers, 8, "u3"), /alpha's usage limit is spent/);
      await loop.pinReading.get(8);
      assert.match(loop.limitHold(strangers, 8, "u3"), /alpha's usage limit is spent/, "refused: the default, not gamma's eight days");
    });
  } finally {
    gh.restore();
  }
});

for (const [what, apply, says] of [
  ["an unknown name", (gh) => gh.apply("factory:account:nobody"), /`factory:account:nobody` names no Claude Code account this machine declares \(`alpha`, `beta`, `gamma`\), so it stays paused/],
  ["an unknown name from someone who cannot push", (gh) => gh.apply("factory:account:nobody", "stranger"), /`factory:account:nobody` was applied by `stranger`, who cannot push to acme\/app and is not a pinned maintainer, so Factory does not move the Objective to that account, so it stays paused/],
  ["another harness's account", (gh) => gh.apply("factory:account:cx"), /`factory:account:cx` names a Codex account, and this Objective runs on Claude Code, so it stays paused/],
  ["a labeler who cannot push", (gh) => gh.apply("factory:account:beta", "stranger"), /`factory:account:beta` was applied by `stranger`, who cannot push to acme\/app and is not a pinned maintainer, so Factory does not move the Objective to that account, so it stays paused/],
]) {
  test(`#265: ${what}: a paused Objective stays paused, said once on its notice; at a stage start it Blocks, cause setup, naming the problem`, async () => {
    const h = fakeHome();
    const gh = fakeGitHub();
    let t = Date.now();
    try {
      await withHome(h, async () => {
        const loop = serveOn(h, () => t);
        loop.result = limited(t + 60 * MIN, t);
        await work(loop);
        apply(gh);
        const patches = () => gh.state.writes.filter((w) => w.startsWith("PATCH /issues/comments/") && w.includes("account-limit")).length;
        const before = patches();
        for (let i = 0; i < 3; i++) assert.deepEqual(await loop.pausedHere(new Map()), []);
        assert.equal(patches() - before, 1, "said once");
        assert.match(gh.notices()[0].body, says);
        assert.equal(gh.notices().length, 1);
        if (/stranger/.test(what) || what.includes("cannot push")) assert.ok(!gh.notices()[0].body.includes("`alpha`, `beta`"), "a stranger's label never lists the accounts");
        assert.equal(gh.blocked().length, 0, "a paused Objective is not Blocked for it");
        // At the reset, the stage starts and Blocks.
        t += 61 * MIN;
        assert.deepEqual(await loop.pausedHere(new Map()), [8]);
        loop.result = delivered;
        const r = await loop.stage(8, "work", "worker.mjs", []);
        assert.equal(r.exit, "blocked");
        assert.deepEqual(loop.ran(), ["alpha"], "nothing ran");
        const block = gh.blocked()[0].body;
        assert.match(block, new RegExp(says.source.replace(/, so it stays paused$/, "").replace(/^`/, "local mode: `")));
        assert.match(block, /"cause":"setup"/);
        assert.match(block, /Apply one `factory:account:<name>` naming an account of this Objective's harness/);
        // The problem fixed (the label off, by someone who can push; the Objective re-applied), then back: said again.
        gh.remove(accountLabelsOf(gh)[0]);
        gh.state.labels.delete("factory:blocked");
        gh.state.labels.add("factory:running");
        loop.result = delivered;
        assert.equal((await loop.stage(8, "work", "worker.mjs", [])).exit, "delivered");
        loop.result = limited(t + 60 * MIN, t);
        await work(loop);
        apply(gh);
        await loop.pausedHere(new Map());
        assert.match(gh.notices()[0].body, says, "a problem that comes back is said again");
      });
    } finally {
      gh.restore();
    }
  });
}

const accountLabelsOf = (gh) => [...gh.state.labels].filter((l) => l.startsWith("factory:account:"));

for (const what of ["a usage limit's reset a week out", "two account labels"]) {
  test(`#265: a paused Objective's claim stays alive while its loop is, so ${what} is never Blocked as a loop gone away after a day; its claim is written about once an hour`, async () => {
    const { BACKENDS } = await import("../scripts/lib/backend.mjs");
    const { PAUSED_BEAT_MS } = await import("../scripts/local.mjs");
    const h = fakeHome();
    const gh = fakeGitHub();
    let t = Date.now();
    gh.state.now = () => t;
    try {
      await withHome(h, async () => {
        const loop = serveOn(h, () => t);
        if (what === "two account labels") {
          gh.apply("factory:account:beta");
          gh.apply("factory:account:gamma");
        } else loop.result = limited(t + 7 * 24 * 60 * MIN, t, "seven_day");
        assert.equal((await work(loop)).exit, "paused");
        const claimWrites = () => gh.state.writes.filter((w) => w.includes("factory:8:local")).length;
        const before = claimWrites();
        for (let i = 0; i < 60; i++) {
          t += 30 * MIN;
          assert.deepEqual(await loop.pausedHere(new Map()), [], "still waiting");
        }
        const hold = await BACKENDS.local.trigger.localHold(REPO, 8, { token: "t" }, t);
        assert.notEqual(hold.state, "expired", "30 hours on: the dispatcher sees this loop's claim, not one a day old");
        assert.equal(hold.holder, loop.holder);
        const beats = claimWrites() - before;
        assert.ok(beats >= 29 && beats <= 31, `about one claim write an hour: ${beats} in 30 h`);
        assert.equal(PAUSED_BEAT_MS, 60 * MIN);
        assert.equal(gh.blocked().length, 0);
      });
    } finally {
      gh.restore();
    }
  });
}

test("#266: the choice: a free account, the one the Objective paused on first, then the least recently limited, then in turn, then the first declared; with all held, the one that resets first", () => {
  const list = ["a", "b", "c"].map((name) => ({ name }));
  const pick = (o) => chooseAccount(list, { until: () => null, ...o }).name;
  const of = (m) => (x) => m[x.name] ?? null;
  assert.equal(pick({}), "a", "nothing known: the first declared");
  assert.equal(pick({ until: of({ a: 5 }) }), "b", "a held account is skipped");
  assert.equal(pick({ limitedAt: of({ a: 100, b: 50 }) }), "c", "one with no limit remembered first");
  assert.equal(pick({ limitedAt: of({ a: 100, b: 50, c: 200 }) }), "b", "then the oldest limit");
  assert.equal(pick({ startedAt: of({ a: 3, b: 1, c: 2 }) }), "b", "then the one started on longest ago");
  assert.equal(pick({ startedAt: of({ a: 3, c: 2 }) }), "b", "one never started on first");
  assert.equal(pick({ prefer: "c", limitedAt: of({ c: 9 }), startedAt: of({ c: 9 }) }), "c", "the paused-on account when it is free");
  assert.equal(pick({ prefer: "c", until: of({ c: 9 }) }), "a", "not when it is held");
  assert.equal(pick({ until: of({ a: 30, b: 10, c: 20 }) }), "b", "all held: the first to reset");
  assert.deepEqual(harnessAccounts(loadAccounts({ home: fakeHome(), env: {} }), "claude").map((a) => a.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(harnessAccounts({ ok: true, accounts: { claude: [], codex: [], copilot: [] } }, "codex"), [{ name: "codex", harness: "codex", declared: false }]);
});

test("#266: the setting is FACTORY_LOCAL_AUTO_ACCOUNT=1, off unset, empty or 0; any other value is named and leaves it off; no stage's env carries it", () => {
  assert.deepEqual(autoAccountSetting({ FACTORY_LOCAL_AUTO_ACCOUNT: "1" }), { on: true, problem: null });
  for (const v of [undefined, "", "0"]) assert.deepEqual(autoAccountSetting(v === undefined ? {} : { FACTORY_LOCAL_AUTO_ACCOUNT: v }), { on: false, problem: null });
  assert.deepEqual(autoAccountSetting({ FACTORY_LOCAL_AUTO_ACCOUNT: "yes" }), { on: false, problem: "FACTORY_LOCAL_AUTO_ACCOUNT is neither 1 nor 0, so automatic account choice is off" });
  const saved = [process.env.FACTORY_LOCAL_AUTO_ACCOUNT, process.env.FACTORY_LOCAL_MAX_CONCURRENT];
  process.env.FACTORY_LOCAL_AUTO_ACCOUNT = "1";
  process.env.FACTORY_LOCAL_MAX_CONCURRENT = "3";
  try {
    const env = Local.prototype.baseEnv.call({ wf: { FACTORY_LOCAL_AUTO_ACCOUNT: "1" }, harness: "claude" });
    assert.equal(env.FACTORY_LOCAL_MAX_CONCURRENT, "3", "another local setting reaches the stage");
    assert.ok(!("FACTORY_LOCAL_AUTO_ACCOUNT" in env), "this one does not, from the shell or the workflow");
  } finally {
    for (const [k, v] of [["FACTORY_LOCAL_AUTO_ACCOUNT", saved[0]], ["FACTORY_LOCAL_MAX_CONCURRENT", saved[1]]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("#266: the machine's holds say when an account last met its limit (a served pass is none) and when a stage last started on it, for every serve; a start file another could have planted is not read", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now();
  const one = accountHolds({ dir });
  const two = accountHolds({ dir });
  one.limit({ harness: "claude", account: "alpha", reset: t + 3 * MIN, now: t });
  one.served({ harness: "claude", account: "alpha", now: t + 5 * MIN, started: t + 4 * MIN });
  assert.equal(two.limitedAt("alpha", t + 5 * MIN), t, "the served pass's record is no limit");
  assert.equal(two.limitedAt("beta", t), null);
  assert.equal(two.startedAt("beta"), null);
  one.started({ harness: "claude", account: "beta", now: t });
  assert.equal(two.startedAt("beta"), t, "another serve reads it");
  two.started({ harness: "claude", account: "beta", now: t + 1 });
  assert.equal(one.startedAt("beta"), t + 1, "replaced whole, the last start wins");
  assert.equal(two.until("beta", t), null, "a start holds nothing");
  const file = join(dir, "beta.started.json");
  const elsewhere = join(dir, "..", "planted.json");
  writeFileSync(elsewhere, JSON.stringify({ harness: "claude", account: "beta", at: t + 99 }));
  rmSync(file);
  symlinkSync(elsewhere, file);
  assert.equal(accountHolds({ dir }).startedAt("beta"), null, "a link is not read");
  rmSync(file);
  writeFileSync(file, JSON.stringify({ harness: "claude", account: "beta", at: t + 99 }), { mode: 0o666 });
  chmodSync(file, 0o666);
  assert.equal(accountHolds({ dir }).startedAt("beta"), null, "nor a file others may write");
});

/** A serve with automatic choice on, on a clock the test moves. */
const autoServe = (h, clock) => Object.assign(serveOn(h, clock), { auto: true });

test("#266: off, a stage runs on its pin or the default, as before; on, a stage with no label starts on a free account, in turn across every serve on the machine, and a pin still wins", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  const step = () => (t += 1000);
  try {
    await withHome(h, async () => {
      const off = serveOn(h, () => t);
      off.result = delivered;
      for (let i = 0; i < 2; i++, step()) assert.equal((await off.stage(8, "work", "worker.mjs", [])).account, "alpha");
      off.holds.limit({ harness: "claude", account: "alpha", reset: t + 60 * MIN, now: t });
      assert.match(off.limitHold(["factory:objective"], 8, "u0"), /^claude account alpha's usage limit is spent until /, "off: held on the default though beta is free");
      const held = await off.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.account], ["paused", "alpha"]);
      assert.equal(off.limitHold(["factory:objective"], 8, "u0") !== null, true);
      t += 61 * MIN;
      // On, in two serves on the one machine: alpha, limited an hour ago, comes after beta and gamma, which have no
      // limit remembered and take turns, whichever serve starts the stage.
      const one = autoServe(h, () => t);
      const two = autoServe(h, () => t);
      one.result = two.result = delivered;
      const order = [];
      for (const loop of [one, two, one, two]) {
        step();
        const r = await loop.stage(8, "work", "worker.mjs", []);
        assert.equal(r.exit, "delivered");
        order.push(r.account);
      }
      assert.deepEqual(order, ["beta", "gamma", "beta", "gamma"]);
      // Once alpha's record is forgotten, three take turns.
      t += 61 * MIN;
      order.length = 0;
      for (const loop of [one, two, one, two]) {
        step();
        order.push((await loop.stage(8, "work", "worker.mjs", [])).account);
      }
      assert.deepEqual(order, ["alpha", "beta", "gamma", "alpha"]);
      // A pin wins over the turn (beta's): every stage on gamma while it stays.
      gh.apply("factory:account:gamma");
      step();
      assert.deepEqual([(await one.stage(8, "work", "worker.mjs", [])).account, (await two.stage(8, "work", "worker.mjs", [])).account], ["gamma", "gamma"]);
      gh.remove("factory:account:gamma");
      step();
      assert.equal((await one.stage(8, "work", "worker.mjs", [])).account, "beta", "back to the turns");
      assert.equal(gh.blocked().length, 0);
    });
  } finally {
    gh.restore();
  }
});

test("#266: on, a paused Objective resumes on a free account with no label and no person, prefers the account it paused on once that is free, and is held only while every account is", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      loop.result = limited(t + 300 * MIN, t);
      const paused = await work(loop);
      assert.deepEqual([paused.exit, paused.account], ["paused", "alpha"]);
      const notice = gh.notices()[0].body;
      assert.match(notice, /Claude Code account `alpha` reached it/);
      assert.match(notice, /Free now: `beta`, `gamma`\. This machine chooses accounts by itself, so `factory serve` here resumes this Objective on a free one at its next tick, with no label/);
      assert.ok(!notice.includes("(apply"), "no label to apply");
      // The next tick resumes it, reading nothing to decide; its stage starts on beta (alpha, where it paused, is held).
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      assert.equal(reads(gh), 0);
      t += 1000;
      loop.result = limited(t + 20 * MIN, t);
      assert.equal((await work(loop)).account, "beta");
      // beta resets first: the Objective resumes on beta, where its session is, though gamma was never used.
      t += 21 * MIN;
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      loop.result = delivered;
      assert.equal((await work(loop)).account, "beta");
      // Held only while every account is: alpha alone held lets a queued Objective start; all three hold it until the first reset.
      assert.equal(loop.limitHold(["factory:objective"], 8, "u1"), null);
      loop.holds.limit({ harness: "claude", account: "beta", reset: t + 120 * MIN, now: t });
      loop.holds.limit({ harness: "claude", account: "gamma", reset: t + 90 * MIN, now: t });
      const line = loop.limitHold(["factory:objective"], 8, "u1");
      assert.equal(line, `every Claude Code account on this machine has its usage limit spent; the first, claude account gamma, resets at ${new Date(t + 90 * MIN).toISOString()}`);
      loop.auto = false;
      assert.match(loop.limitHold(["factory:objective"], 8, "u1"), /^claude account alpha's usage limit is spent until /, "off: the default's hold, as before");
      loop.auto = true;
      // A stage that starts anyway is held on gamma, the first to reset, and waits for it; then goes on there.
      const held = await work(loop);
      assert.deepEqual([held.exit, held.account, held.usageLimit.held], ["paused", "gamma", true]);
      assert.deepEqual(await loop.pausedHere(new Map()), [], "every account held: it waits");
      t += 91 * MIN;
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      assert.equal((await work(loop)).account, "gamma");
      assert.deepEqual(loop.ran(), ["alpha", "beta", "beta", "gamma"]);
      assert.equal(gh.blocked().length, 0);
    });
  } finally {
    gh.restore();
  }
});

test("#266: on, an Objective pinned by a label stays on its account: paused there, it waits for that account's reset, and its notice says how to move it", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      gh.apply("factory:account:beta");
      loop.result = limited(t + 60 * MIN, t);
      assert.equal((await work(loop)).account, "beta");
      assert.match(gh.notices()[0].body, /Free now: `alpha` \(apply `factory:account:alpha`\), `gamma` \(apply `factory:account:gamma`\)\. Applying one moves/);
      assert.ok(!gh.notices()[0].body.includes("chooses accounts by itself"));
      for (let i = 0; i < 2; i++) assert.deepEqual(await loop.pausedHere(new Map()), [], "alpha and gamma are free, but the pin holds it on beta");
      t += 61 * MIN;
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      loop.result = delivered;
      assert.equal((await work(loop)).account, "beta");
    });
  } finally {
    gh.restore();
  }
});
