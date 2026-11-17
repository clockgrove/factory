import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The stage script serve starts is this file's fake worker: it notes the account its env was made for, waits for FAKE_GO
// when told to (a stage still running), then writes the result.json a test gives it, with that account's name as the real
// worker records it (session.mjs writeUsage `account`). A limit with no reset ends it `paused` only when serve's env says
// automatic choice picked its account (PENDULUM_STAGE_AUTO_ACCOUNT: harness.mjs LIMIT.moves); else it Blocks recording
// the refusal (`limitRefused`), as the real stage does. Set before local.mjs is loaded, so serve's real start, hold, pause
// and resume paths run.
const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-")));
mkdirSync(join(root, "scripts"));
writeFileSync(
  join(root, "scripts", "worker.mjs"),
  'import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst a = process.argv;\nappendFileSync(process.env.FAKE_RAN, `${process.env.FAKE_ACCOUNT}\\n`);\nif (process.env.FAKE_GO) while (!existsSync(process.env.FAKE_GO)) await new Promise((r) => setTimeout(r, 20));\nconst r = { ...JSON.parse(process.env.FAKE_RESULT), account: process.env.FAKE_ACCOUNT };\nif (r.usageLimit?.noReset && process.env.PENDULUM_STAGE_AUTO_ACCOUNT !== "1") Object.assign(r, { exit: "blocked", usageLimit: undefined, limitRefused: { harness: r.usageLimit.harness } });\nwriteFileSync(join(a[a.indexOf("--usage-dir") + 1], "result.json"), JSON.stringify(r));\n',
);
process.env.PENDULUM_PLUGIN_ROOT = root;
const { RETRY } = await import("../scripts/lib/github.mjs");
const { logTo } = await import("../scripts/lib/inputs.mjs");
const { accountHolds, holdsDir } = await import("../scripts/lib/holds.mjs");
const { Local, holderId, machineIdentity, pauseNoticeBody } = await import("../scripts/local.mjs");
const { accountLabelNote, accountPin, accountsFile, autoAccountSetting, chooseAccount, harnessAccounts, loadAccounts, pinnedAccount } = await import("../scripts/lib/accounts.mjs");
const { gitPinFile, pinGitDir } = await import("../scripts/lib/local.mjs");
const { choiceTrusted, objectiveSha } = await import("../scripts/lib/objective-trust.mjs");

RETRY.sleep = async () => {};
const MIN = 60_000;
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const NOTICE = "<!-- pendulum:8:account-limit -->";

/** A stand-in home: Claude Code accounts alpha (the default), beta and gamma, and a Codex account cx. Every file is a dummy. */
function fakeHome() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "move-")));
  for (const d of [".claude", ".codex", ".config/pendulum", "work/claude-a", "work/claude-b", "work/claude-c", "work/codex-x"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "pendulum"), 0o700);
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
function fakeGitHub(labels = ["pendulum:objective", "pendulum:local", "pendulum:running"]) {
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
    blocked: () => state.comments.filter((c) => c.body.includes("pendulum:block")),
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
  const loop = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repo: REPO, repoFull: REPO.full, wf: {}, opts: { token: "t" }, stopping: false, firstSetup: new Map(), children: new Set(), clock, holder: holderId(machineIdentity(), process.pid), claimRetryMs: 0 });
  loop.holds = accountHolds({ dir: holdsDir(h) });
  loop.baseEnv = () => ({ PENDULUM_LOCAL_ALL: "1" });
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
  loop.stageEnv = (issue, usageDir, c, stageTmp, script, harness, hosts, account) => ({ PATH: `${bin}:${process.env.PATH}`, PENDULUM_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1], FAKE_RAN: ran, FAKE_ACCOUNT: account?.name ?? "none", FAKE_RESULT: JSON.stringify(loop.result), ...(loop.wait ? { FAKE_GO: join(dev, "go") } : {}) });
  loop.go = () => writeFileSync(join(dev, "go"), "");
  loop.ran = () => readFileSync(ran, "utf8").split("\n").filter(Boolean);
  return loop;
}

/** A work stage that ends on its usage limit of `window`, reset at `reset` (ms), as session.mjs usageLimitExit writes it. */
const limited = (reset, since, window = "five_hour") => ({ exit: "paused", usd: 0.1, tokens: { output: 0 }, usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(since).toISOString(), limitType: window } });
const work = (loop) => loop.withClaim(8, () => loop.stage(8, "work", "worker.mjs", []));

test("#265: the label's name, decided on the names alone: one pins, two move nothing, a name is an account of the Objective's harness or a problem naming the label", () => {
  assert.deepEqual(accountPin(["pendulum:objective"]), { label: null });
  assert.deepEqual(accountPin(["pendulum:objective", { name: "pendulum:account:Beta" }]), { label: "pendulum:account:Beta", name: "beta" });
  assert.deepEqual(accountPin(["pendulum:account:beta", "pendulum:account:gamma"]), { label: null, two: ["pendulum:account:beta", "pendulum:account:gamma"] });
  const h = fakeHome();
  const loaded = loadAccounts({ home: h, env: {} });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.problems));
  assert.equal(pinnedAccount(loaded, "claude", "beta").account.name, "beta");
  assert.match(pinnedAccount(loaded, "claude", "cx").problem, /^`pendulum:account:cx` names a Codex account, and this Objective runs on Claude Code$/);
  assert.match(pinnedAccount(loaded, "claude", "nobody").problem, /^`pendulum:account:nobody` names no Claude Code account this machine declares \(`alpha`, `beta`, `gamma`\)$/);
  assert.match(pinnedAccount(loaded, "copilot", "copilot").account.name, /^copilot$/, "a harness that declares none has its one account");
  assert.match(pinnedAccount(loaded, "claude", "claude").problem, /names no Claude Code account/, "with accounts declared, the harness's own name is none of them");
  assert.match(pinnedAccount(loaded, "claude", "`@x").problem, /^an account label whose name is no account name names no/, "a name that is no account name is never echoed");
});

test("#265: the label is no edit to the Objective: the plan's record and the choice-label trust check ignore it", async () => {
  assert.equal(objectiveSha("t", "b", ["pendulum:objective", "pendulum:account:beta"]), objectiveSha("t", "b", ["pendulum:objective"]));
  let reads = 0;
  const t = await choiceTrusted(REPO, 8, ["pendulum:objective", "pendulum:account:beta"], {}, { labelers: async () => (reads += 1, {}) });
  assert.equal(t.ok, true);
  assert.equal(reads, 0, "no timeline read for it");
});

test("#265/#267: off local mode, with no accounts declared there, the label does nothing, and the stage's progress says so once", () => {
  assert.match(accountLabelNote(["pendulum:objective", "pendulum:account:beta"], false), /^`pendulum:account:beta` does nothing on this route: this repository declares no accounts for GitHub Actions and the cloud sandbox/);
  assert.equal(accountLabelNote(["pendulum:objective", "pendulum:account:beta"], true), "", "local mode acts on it");
  assert.equal(accountLabelNote(["pendulum:objective"], false), "");
  for (const script of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", script), "utf8");
    const gate = src.indexOf("await choiceGate(");
    // accountGate (objective-trust.mjs) gives the note: route-accounts.test.mjs runs it.
    const note = src.indexOf("await accountGate(");
    assert.ok(gate > 0 && note > gate, `${script}: once, after the labels are read and checked`);
    assert.equal(src.split("await accountGate(").length, 2, `${script}: one call`);
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
  assert.match(body, /Free now: `beta` \(apply `pendulum:account:beta`\), `gamma` \(apply `pendulum:account:gamma`\)\./);
  assert.ok(!body.includes("@"));
  assert.match(pauseNoticeBody({ harness: "claude", account: "alpha", reset: t, window: "`@someone` ran" }), /\(its window was not reported\)/, "harness text in no other form is not shown");
  assert.match(pauseNoticeBody({ harness: "codex", account: "codex", reset: t, free: [] }), /Codex \(this machine's one Codex login\) reached it \(its window was not reported\)[\s\S]*No other Codex account on this machine is free now\./);
});


const reads = (gh) => gh.state.timelineReads;
const delivered = { exit: "delivered", tokens: { output: 10 }, servedPasses: 1 };

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
      assert.match(first, /Free now: `beta` \(apply `pendulum:account:beta`\), `gamma` \(apply `pendulum:account:gamma`\)/);
      assert.ok(!first.includes("@"), "no @mention");
      assert.ok(!first.includes(h), "no path");
      assert.deepEqual(await loop.pausedHere(new Map()), [], "no label: it waits for alpha's reset");
      assert.equal(reads(gh), 0, "and reads nothing to decide it");
      // A person who can push applies pendulum:account:beta: resumed now, its labeler read once over several ticks.
      gh.apply("pendulum:account:beta");
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
      assert.match(gh.notices()[0].body, /Free now: `gamma` \(apply `pendulum:account:gamma`\)\. /);
      // The label stays on beta, which is held: it waits for beta's reset, though alpha comes free first.
      t += 60 * MIN;
      assert.deepEqual(await loop.pausedHere(new Map()), [], "the pinned account is held: wait");
      // A stage started now on the pin is held before it runs, spending nothing.
      const held = await loop.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.account, held.usageLimit.held], ["paused", "beta", true]);
      assert.equal(loop.ran().length, 3);
      // A person who can push takes the label off: back to the default, alpha, free now: resumed before beta's reset.
      gh.remove("pendulum:account:beta");
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
      gh.apply("pendulum:account:beta");
      loop.result = limited(t + 120 * MIN, t);
      assert.equal((await work(loop)).account, "beta");
      // alpha, the default, is free: a removal by a stranger does not move it there.
      gh.remove("pendulum:account:beta", "stranger");
      for (let i = 0; i < 2; i++) assert.deepEqual(await loop.pausedHere(new Map()), []);
      assert.match(gh.notices()[0].body, /`pendulum:account:beta` was removed by `stranger`, who cannot push to acme\/app and is not a pinned maintainer, so Pendulum does not move the Objective off that account, so it stays paused/);
      // The pin back, and a stranger adds a second label: two labels, it waits, past beta's reset too, said once.
      gh.apply("pendulum:account:beta");
      gh.apply("pendulum:account:gamma", "stranger");
      const patches = () => gh.state.writes.filter((w) => w.startsWith("PATCH /issues/comments/") && w.includes("account-limit")).length;
      const before = patches();
      t += 121 * MIN;
      for (let i = 0; i < 3; i++) assert.deepEqual(await loop.pausedHere(new Map()), []);
      assert.equal(patches() - before, 1, "said once");
      assert.match(gh.notices()[0].body, /`pendulum:account:beta`, `pendulum:account:gamma`: more than one account label moves nothing, so the Objective waits, on no account, until one is left/);
      // A stage started anyway (a race with the tick) starts nothing and Blocks nothing: it waits.
      const waits = await loop.withClaim(8, () => loop.stage(8, "work", "worker.mjs", []));
      assert.equal(waits.exit, "paused");
      assert.equal(loop.ran().length, 1, "nothing ran, on the default or anywhere");
      assert.deepEqual(await loop.pausedHere(new Map()), [], "still two labels: still waiting");
      // One left: it goes on, on that one.
      gh.remove("pendulum:account:gamma");
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      assert.match(gh.notices()[0].body, /^<!-- pendulum:8:account-limit -->\nPendulum: one account label or none is left, so the Objective goes on\.$/, "the note no longer says it waits");
      loop.result = delivered;
      assert.equal((await work(loop)).account, "beta");
      assert.equal(gh.blocked().length, 0, "never Blocked for it");
      // The dispatcher holds a queued Objective with two labels, whatever its accounts' holds.
      assert.match(loop.limitHold(["pendulum:objective", "pendulum:account:beta", "pendulum:account:gamma"], 8, "x"), /more than one account label moves nothing/);
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
      gh.apply("pendulum:account:beta");
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta");
      // Removed, and applied again by a stranger, with no tick between: Blocked, nothing ran on beta.
      gh.remove("pendulum:account:beta");
      gh.apply("pendulum:account:beta", "stranger");
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).exit, "blocked");
      assert.match(gh.blocked().at(-1).body, /`pendulum:account:beta` was applied by `stranger`/);
      assert.deepEqual(loop.ran(), ["beta"]);
      // The other way: kirk takes it off and applies it himself, no tick between: it runs on beta.
      gh.remove("pendulum:account:beta");
      gh.apply("pendulum:account:beta");
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
      gh.apply("pendulum:account:beta", "stranger");
      assert.deepEqual(await loop.pausedHere(new Map()), []);
      gh.remove("pendulum:account:beta");
      gh.apply("pendulum:account:beta");
      assert.deepEqual(await loop.pausedHere(new Map()), [8], "read again: the issue changed");
      // And the reverse: a trusted label removed and re-applied by a stranger before the next tick does not move it.
      const other = serveOn(h, () => t);
      other.result = limited(t + 60 * MIN, t);
      gh.remove("pendulum:account:beta");
      await work(other);
      gh.apply("pendulum:account:beta");
      gh.remove("pendulum:account:beta");
      gh.apply("pendulum:account:beta", "stranger");
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
      gh.apply("pendulum:account:gamma");
      loop.go();
      assert.equal((await running).account, "alpha", "it finishes where it started");
      loop.wait = false;
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "gamma");
      assert.deepEqual(loop.ran(), ["alpha", "gamma"]);
      // alpha held: an unpinned Objective waits; a trusted pin to beta starts once its labeler is read (in the
      // background, for the next tick); until then the default is weighed.
      loop.holds.limit({ harness: "claude", account: "alpha", reset: t + 60 * MIN, now: t });
      assert.match(loop.limitHold(["pendulum:objective"], 8, "u1"), /^claude account alpha's usage limit is spent until /);
      gh.remove("pendulum:account:gamma");
      gh.apply("pendulum:account:beta");
      const pinned = ["pendulum:objective", "pendulum:account:beta"];
      assert.match(loop.limitHold(pinned, 8, "u2"), /alpha's usage limit is spent/, "labeler not known yet: the default");
      await loop.pinReading.get(8);
      assert.equal(loop.limitHold(pinned, 8, "u2"), null, "trusted: beta, free");
      // A stranger's pin to a held account never holds a queued Objective whose default is free.
      loop.holds.limit({ harness: "claude", account: "gamma", reset: t + 8 * 24 * 60 * MIN, now: t });
      gh.remove("pendulum:account:beta");
      gh.apply("pendulum:account:gamma", "stranger");
      const strangers = ["pendulum:objective", "pendulum:account:gamma"];
      assert.match(loop.limitHold(strangers, 8, "u3"), /alpha's usage limit is spent/);
      await loop.pinReading.get(8);
      assert.match(loop.limitHold(strangers, 8, "u3"), /alpha's usage limit is spent/, "refused: the default, not gamma's eight days");
    });
  } finally {
    gh.restore();
  }
});

for (const [what, apply, says] of [
  ["an unknown name", (gh) => gh.apply("pendulum:account:nobody"), /`pendulum:account:nobody` names no Claude Code account this machine declares \(`alpha`, `beta`, `gamma`\), so it stays paused/],
  ["an unknown name from someone who cannot push", (gh) => gh.apply("pendulum:account:nobody", "stranger"), /`pendulum:account:nobody` was applied by `stranger`, who cannot push to acme\/app and is not a pinned maintainer, so Pendulum does not move the Objective to that account, so it stays paused/],
  ["another harness's account", (gh) => gh.apply("pendulum:account:cx"), /`pendulum:account:cx` names a Codex account, and this Objective runs on Claude Code, so it stays paused/],
  ["a labeler who cannot push", (gh) => gh.apply("pendulum:account:beta", "stranger"), /`pendulum:account:beta` was applied by `stranger`, who cannot push to acme\/app and is not a pinned maintainer, so Pendulum does not move the Objective to that account, so it stays paused/],
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
        assert.match(block, /Apply one `pendulum:account:<name>` naming an account of this Objective's harness/);
        // The problem fixed (the label off, by someone who can push; the Objective re-applied), then back: said again.
        gh.remove(accountLabelsOf(gh)[0]);
        gh.state.labels.delete("pendulum:blocked");
        gh.state.labels.add("pendulum:running");
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

const accountLabelsOf = (gh) => [...gh.state.labels].filter((l) => l.startsWith("pendulum:account:"));

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
          gh.apply("pendulum:account:beta");
          gh.apply("pendulum:account:gamma");
        } else loop.result = limited(t + 7 * 24 * 60 * MIN, t, "seven_day");
        assert.equal((await work(loop)).exit, "paused");
        const claimWrites = () => gh.state.writes.filter((w) => w.includes("pendulum:8:local")).length;
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

test("#266: the setting is PENDULUM_LOCAL_AUTO_ACCOUNT=1, off unset, empty or 0; any other value is named and leaves it off; no stage's env carries it", () => {
  assert.deepEqual(autoAccountSetting({ PENDULUM_LOCAL_AUTO_ACCOUNT: "1" }), { on: true, problem: null });
  for (const v of [undefined, "", "0"]) assert.deepEqual(autoAccountSetting(v === undefined ? {} : { PENDULUM_LOCAL_AUTO_ACCOUNT: v }), { on: false, problem: null });
  assert.deepEqual(autoAccountSetting({ PENDULUM_LOCAL_AUTO_ACCOUNT: "yes" }), { on: false, problem: "PENDULUM_LOCAL_AUTO_ACCOUNT is neither 1 nor 0, so automatic account choice is off" });
  const saved = [process.env.PENDULUM_LOCAL_AUTO_ACCOUNT, process.env.PENDULUM_LOCAL_MAX_CONCURRENT];
  process.env.PENDULUM_LOCAL_AUTO_ACCOUNT = "1";
  process.env.PENDULUM_LOCAL_MAX_CONCURRENT = "3";
  try {
    const env = Local.prototype.baseEnv.call({ wf: { PENDULUM_LOCAL_AUTO_ACCOUNT: "1" }, harness: "claude" });
    assert.equal(env.PENDULUM_LOCAL_MAX_CONCURRENT, "3", "another local setting reaches the stage");
    assert.ok(!("PENDULUM_LOCAL_AUTO_ACCOUNT" in env), "this one does not, from the shell or the workflow");
  } finally {
    for (const [k, v] of [["PENDULUM_LOCAL_AUTO_ACCOUNT", saved[0]], ["PENDULUM_LOCAL_MAX_CONCURRENT", saved[1]]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("#266: the machine's holds say when an account last met its limit (a served pass is none) and when a stage last started on it, for every serve; a start file another could have planted is not read", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  // In the past, so t + 1 is never after the reader's own clock (a later time counts as long ago).
  const t = Date.now() - 10 * MIN;
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
      assert.match(off.limitHold(["pendulum:objective"], 8, "u0"), /^claude account alpha's usage limit is spent until /, "off: held on the default though beta is free");
      const held = await off.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.account], ["paused", "alpha"]);
      assert.equal(off.limitHold(["pendulum:objective"], 8, "u0") !== null, true);
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
      gh.apply("pendulum:account:gamma");
      step();
      assert.deepEqual([(await one.stage(8, "work", "worker.mjs", [])).account, (await two.stage(8, "work", "worker.mjs", [])).account], ["gamma", "gamma"]);
      gh.remove("pendulum:account:gamma");
      step();
      assert.equal((await one.stage(8, "work", "worker.mjs", [])).account, "beta", "back to the turns");
      assert.equal(gh.blocked().length, 0);
    });
  } finally {
    gh.restore();
  }
});

test("#391: on, a stage starts on the free account with the most quota left by the readings stages left in the machine's holds, in every serve; the turn decides only among accounts with none; a pinned stage's reading counts too", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  const reading = (used) => ({ ...delivered, quota: { harness: "claude", windows: { seven_day: { used, resetsAt: t + 48 * 60 * MIN }, five_hour: { used: used / 2, resetsAt: t + 4 * 60 * MIN } } } });
  try {
    await withHome(h, async () => {
      const one = autoServe(h, () => t);
      const two = autoServe(h, () => t);
      // No readings yet: each account in turn, and each stage leaves its account's reading.
      const order = [];
      for (const [loop, used] of [[one, 0.8], [two, 0.3], [one, 0.6]]) {
        t += 1000;
        loop.result = reading(used);
        order.push((await loop.stage(8, "work", "worker.mjs", [])).account);
      }
      assert.deepEqual(order, ["alpha", "beta", "gamma"]);
      assert.ok(Math.abs(one.holds.left("beta", t) - 0.7) < 1e-9, "the reading is kept with the machine's holds");
      // Every account read: beta has the most left (0.7, against alpha's 0.2 and gamma's 0.4), though alpha's turn is next.
      for (const loop of [two, one]) {
        t += 1000;
        loop.result = reading(0.3);
        assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta", "in either serve");
      }
      // A pinned stage on gamma leaves its reading too: gamma now has the most left.
      gh.apply("pendulum:account:gamma");
      t += 1000;
      one.result = reading(0.05);
      assert.equal((await one.stage(8, "work", "worker.mjs", [])).account, "gamma");
      gh.remove("pendulum:account:gamma");
      t += 1000;
      two.result = reading(0.05);
      assert.equal((await two.stage(8, "work", "worker.mjs", [])).account, "gamma");
      // Past every window's reset the readings are stale, so no account is measured: the turn (alpha, started longest ago).
      t += 49 * 60 * MIN;
      assert.equal((await one.stage(8, "work", "worker.mjs", [])).account, "alpha");
      assert.equal(gh.blocked().length, 0);
    });
  } finally {
    gh.restore();
  }
});

test("#391: on, an account whose served stage reported no quota reading (an API key) is recorded so, and comes after every account with a reading, however little that one has left; one never measured comes first; a paused Objective resumes on its own account first", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  const reading = (used) => ({ ...delivered, quota: { harness: "claude", windows: { seven_day: { used, resetsAt: t + 48 * 60 * MIN } } } });
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      const order = [];
      for (const r of [delivered, reading(0.95)]) {
        t += 1000;
        loop.result = r;
        order.push((await loop.stage(8, "work", "worker.mjs", [])).account);
      }
      assert.deepEqual(order, ["alpha", "beta"]);
      assert.equal(loop.holds.reportsNothing("alpha", t), true, "alpha ran a stage and reported nothing: kept as a fact");
      assert.equal(loop.holds.reportsNothing("gamma", t), false, "gamma never ran: not measured, which is not the same");
      // gamma, never measured, first; then beta's 5% left beats alpha's silence, though alpha's turn is next.
      t += 1000;
      loop.result = reading(0.99);
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "gamma");
      for (let i = 0; i < 2; i++) {
        t += 1000;
        loop.result = reading(0.95);
        assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta");
      }
      // An Objective paused on alpha resumes there when it is free: its session lives there.
      assert.equal(loop.autoAccount("claude", { prefer: "alpha" }).account.name, "alpha");
      // Held, it is passed over: quota decides among the rest.
      loop.holds.limit({ harness: "claude", account: "alpha", reset: t + 60 * MIN, now: t });
      assert.equal(loop.autoAccount("claude", { prefer: "alpha" }).account.name, "beta");
      assert.equal(gh.blocked().length, 0);
    });
  } finally {
    gh.restore();
  }
});

test("#391: on, the Objective's next stage stays on its previous stage's account while that stage's prompt cache is warm, ahead of quota; then quota decides", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  const reading = (used, warm = null) => ({ ...delivered, quota: { harness: "claude", windows: { seven_day: { used, resetsAt: t + 48 * 60 * MIN } } }, ...(warm ? { cacheWarmUntil: warm } : {}) });
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      // Each account measured through a pin: beta has the most left; alpha's stage is the last, its cache warm an hour.
      for (const [name, used] of [["beta", 0.1], ["gamma", 0.5], ["alpha", 0.8]]) {
        gh.apply(`pendulum:account:${name}`);
        t += 1000;
        loop.result = reading(used, name === "alpha" ? t + 60 * MIN : null);
        assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, name);
        gh.remove(`pendulum:account:${name}`);
      }
      t += 1000;
      loop.result = reading(0.8, t + 60 * MIN);
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "alpha", "warm: it stays, though beta has more left");
      t += 61 * MIN;
      loop.result = delivered;
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta", "the cache gone cold: quota decides");
    });
  } finally {
    gh.restore();
  }
});

test("#391: on, picks made before any of their stages starts spread over the measured accounts, the most left first in each round; a start counts until the account's next reading", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      for (const [name, used] of [["alpha", 0.4], ["beta", 0.41], ["gamma", 0.7]]) loop.holds.reading({ harness: "claude", account: name, now: t - 1000, windows: { seven_day: { used, resetsAt: t + 48 * 60 * MIN } } });
      const picks = [];
      for (let i = 0; i < 6; i++) picks.push(loop.autoAccount("claude", { pick: true }).account.name);
      assert.deepEqual(picks, ["alpha", "beta", "gamma", "alpha", "beta", "gamma"]);
      // Their stages start: the count moves to the machine's start records, shared with every serve.
      for (const n of picks) loop.startedOn({ name: n, harness: "claude", declared: true });
      assert.equal(autoServe(h, () => t).holds.startsSince("alpha", t), 2);
      assert.equal(loop.autoAccount("claude").account.name, "alpha", "two each: the most left");
      loop.holds.reading({ harness: "claude", account: "gamma", now: t, windows: { seven_day: { used: 0.7, resetsAt: t + 48 * 60 * MIN } } });
      assert.equal(loop.autoAccount("claude").account.name, "gamma", "gamma's new reading covers its starts: none since");
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
      assert.match(notice, /Free now: `beta`, `gamma`\. This machine chooses accounts by itself, so `pendulum serve` here resumes this Objective on a free one at its next tick, with no label/);
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
      assert.equal(loop.limitHold(["pendulum:objective"], 8, "u1"), null);
      loop.holds.limit({ harness: "claude", account: "beta", reset: t + 120 * MIN, now: t });
      loop.holds.limit({ harness: "claude", account: "gamma", reset: t + 90 * MIN, now: t });
      const line = loop.limitHold(["pendulum:objective"], 8, "u1");
      assert.equal(line, `every Claude Code account on this machine has its usage limit spent; the first, claude account gamma, resets at ${new Date(t + 90 * MIN).toISOString()}`);
      loop.auto = false;
      assert.match(loop.limitHold(["pendulum:objective"], 8, "u1"), /^claude account alpha's usage limit is spent until /, "off: the default's hold, as before");
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
      gh.apply("pendulum:account:beta");
      loop.result = limited(t + 60 * MIN, t);
      assert.equal((await work(loop)).account, "beta");
      assert.match(gh.notices()[0].body, /Free now: `alpha` \(apply `pendulum:account:alpha`\), `gamma` \(apply `pendulum:account:gamma`\)\. Applying one moves/);
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

test("#266: an account whose harness checks fail is passed over, checked again after a while; only with none ready does the stage Block, naming the accounts; a Blocked or held start is no turn", async () => {
  const { UNREADY_RETRY_MS } = await import("../scripts/local.mjs");
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      loop.result = delivered;
      const broken = new Set(["beta"]);
      let checks = 0;
      loop.harnessReady = (harness, a) => (checks++, broken.has(a.name) ? [`${a.name}'s login at ${h} is broken`] : []);
      const order = [];
      for (let i = 0; i < 3; i++, t += 1000) order.push((await loop.stage(8, "work", "worker.mjs", [])).account);
      assert.deepEqual(order, ["alpha", "gamma", "alpha"], "beta passed over, nothing Blocked");
      assert.equal(gh.blocked().length, 0);
      const probed = checks;
      // Fixed, but its failure is kept a while: still passed over, and not checked again.
      broken.clear();
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "gamma");
      assert.equal(checks, probed + 2, "the chosen account's own checks only");
      t += UNREADY_RETRY_MS + 1;
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta", "checked again, and its turn");
      // None ready (each one's failure kept from now): the stage Blocks once, naming the accounts and never a path.
      for (const n of ["alpha", "beta", "gamma"]) broken.add(n);
      t += UNREADY_RETRY_MS + 1;
      const startsBefore = ["alpha", "beta", "gamma"].map((n) => loop.holds.startedAt(n, t));
      const r = await loop.stage(8, "work", "worker.mjs", []);
      assert.equal(r.exit, "blocked");
      const block = gh.blocked()[0].body;
      assert.match(block, /local mode on this machine cannot run Claude Code on any of its accounts \(`alpha`, `beta`, `gamma`\); the loop's log names what is missing for each/);
      assert.ok(!block.includes(h), "no path");
      assert.ok(!block.includes("harness label asks for"), "not the harness label's text");
      assert.deepEqual(["alpha", "beta", "gamma"].map((n) => loop.holds.startedAt(n, t)), startsBefore, "a Blocked start is no turn");
      // A held start is no turn either.
      broken.clear();
      t += UNREADY_RETRY_MS + 1;
      for (const n of ["alpha", "beta", "gamma"]) loop.holds.limit({ harness: "claude", account: n, reset: t + 60 * MIN, now: t });
      const held = await loop.stage(8, "work", "worker.mjs", []);
      assert.deepEqual([held.exit, held.usageLimit.held], ["paused", true]);
      assert.deepEqual(["alpha", "beta", "gamma"].map((n) => loop.holds.startedAt(n, t)), startsBefore);
      assert.equal(loop.ran().length, 5, "nothing ran on a Blocked or held start");
    });
  } finally {
    gh.restore();
  }
});

test("#266: a usage limit with no reset reported Blocks as before, and automatic choice, in every serve, passes that account over for 1, 4, then 24 hours, until a pass on it is served; with the setting off nothing holds on it", async () => {
  const { writeUsage } = await import("../scripts/lib/session.mjs");
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "usage-"))), "u");
  const refused = { harness: "copilot", status: 429, type: null, code: "usage_limit_reached", message: "spent" };
  assert.deepEqual(writeUsage(dir, { harness: "copilot", model: null, records: [{ usd: 0, refusal: refused }], passes: 1, exit: "blocked", reason: "x", credentialBasis: null }).limitRefused, { harness: "copilot" });
  assert.equal(writeUsage(dir, { harness: "copilot", model: null, records: [{ usd: 0, refusal: { ...refused, resetAt: Date.now() } }], passes: 1, exit: "blocked", reason: "x", credentialBasis: null }).limitRefused, undefined, "a reset reported: a hold, not a guess");
  assert.deepEqual(writeUsage(dir, { harness: "copilot", model: null, records: [{ usd: 0, refusal: { ...refused, code: null, type: "quota" } }], passes: 1, exit: "blocked", reason: "x", credentialBasis: null }).limitRefused, { harness: "copilot" }, "a quota refusal too");
  assert.equal(writeUsage(dir, { harness: "copilot", model: null, records: [{ usd: 0, refusal: { ...refused, status: 401, code: "invalid_api_key" } }], passes: 1, exit: "blocked", reason: "x", credentialBasis: null }).limitRefused, undefined, "not a refused key");
  const t = Date.now();
  const holds = accountHolds({ dir: join(dir, "..", "holds") });
  assert.equal(holds.spent({ harness: "copilot", account: "seat", now: t }), t + 60 * MIN);
  assert.equal(holds.until("seat", t), null, "no hold");
  assert.equal(accountHolds({ dir: join(dir, "..", "holds-cap") }).spent({ harness: "copilot", account: "seat", now: t, steps: [1e15] }), t + 8 * 24 * 60 * MIN, "#402: a step is never longer than the longest hold kept");
  assert.equal(holds.held("copilot", t), false);
  assert.equal(holds.held("copilot", t, true), true);
  assert.equal(accountHolds({ dir: join(dir, "..", "holds") }).avoidUntil("seat", t), t + 60 * MIN, "every serve reads it");
  assert.equal(holds.spent({ harness: "copilot", account: "seat", now: t + 61 * MIN }), t + 61 * MIN + 240 * MIN);
  holds.served({ harness: "copilot", account: "seat", now: t + 62 * MIN, started: t + 61 * MIN + 1 });
  assert.equal(holds.avoidUntil("seat", t + 62 * MIN), null, "a served pass ends it");
  assert.equal(holds.spent({ harness: "copilot", account: "seat", now: t + 63 * MIN }), t + 123 * MIN, "and the count starts again");

  const h = fakeHome();
  const gh = fakeGitHub();
  let now = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => now);
      loop.result = { exit: "blocked", tokens: { output: 0 }, limitRefused: { harness: "claude" } };
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "alpha");
      loop.result = delivered;
      const order = [];
      for (let i = 0; i < 3; i++) order.push((await loop.stage(8, "work", "worker.mjs", [])).account, (now += 1000));
      assert.deepEqual(order.filter((x) => typeof x === "string"), ["beta", "gamma", "beta"], "alpha passed over for its hour");
      assert.ok(!loop.freeAccounts("claude", "none").includes("alpha"));
      // Off: alpha is the default and nothing holds it; its pass is served, which ends the guess for every serve.
      const off = serveOn(h, () => now);
      off.result = delivered;
      assert.equal(off.limitHold(["pendulum:objective"], 8, "u"), null);
      assert.equal((await off.stage(8, "work", "worker.mjs", [])).account, "alpha");
      assert.ok(loop.freeAccounts("claude", "none").includes("alpha"));
    });
  } finally {
    gh.restore();
  }
});

test("#266: a start record dated after now counts as long ago; records of names no longer declared go, and any not written for a long while", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now();
  const holds = accountHolds({ dir });
  holds.started({ harness: "claude", account: "beta", now: t });
  writeFileSync(join(dir, "beta.started.json"), JSON.stringify({ harness: "claude", account: "beta", at: t + 365 * 24 * 60 * MIN }), { mode: 0o600 });
  const fresh = accountHolds({ dir });
  assert.equal(fresh.startedAt("beta", t), 0, "another clock's future time: long ago, as a hold record's");
  const list = ["alpha", "beta"].map((name) => ({ name }));
  assert.equal(chooseAccount(list, { until: () => null, startedAt: (a) => (a.name === "alpha" ? t - 1000 : fresh.startedAt(a.name, t)) }).name, "beta", "so it never blocks its turn");
  fresh.started({ harness: "claude", account: "old", now: t });
  fresh.started({ harness: "claude", account: "claude@0123456789ab", now: t });
  fresh.forgetStarts(["alpha", "beta"]);
  assert.equal(fresh.startedAt("old", t), t, "this process's memory");
  assert.equal(accountHolds({ dir }).startedAt("old", t), null, "the file is gone: no longer declared");
  assert.equal(accountHolds({ dir }).startedAt("claude@0123456789ab", t), t, "a login's stays: another serve may run on it");
  const stale = join(dir, "claude@0123456789ab.started.json");
  const long = new Date(t - 9 * 24 * 60 * MIN);
  utimesSync(stale, long, long);
  accountHolds({ dir }).until("alpha", t);
  assert.equal(accountHolds({ dir }).startedAt("claude@0123456789ab", t), null, "not written for over eight days: gone");
});

test("#266: a paused Objective's move and its stage weigh the same account; when a pin comes off, the notice says the loop moves it now", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      gh.apply("pendulum:account:beta");
      loop.result = limited(t + 60 * MIN, t);
      assert.equal((await work(loop)).account, "beta");
      assert.match(gh.notices()[0].body, /\(apply `pendulum:account:alpha`\)/);
      gh.remove("pendulum:account:beta");
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      assert.match(gh.notices()[0].body, /This machine chooses accounts by itself, so `pendulum serve` here resumes this Objective on a free one at its next tick/, "said again once the pin is gone");
      assert.ok(!gh.notices()[0].body.includes("(apply"));
      // A pause held on gamma at its start, after a stage that paused on beta: once beta and alpha are free, the move and
      // the stage both weigh beta first (where the session is), though alpha has no limit remembered.
      t += 61 * MIN;
      gh.apply("pendulum:account:beta");
      loop.holds.limit({ harness: "claude", account: "beta", reset: t + 20 * MIN, now: t });
      loop.result = limited(t + 20 * MIN, t);
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta");
      gh.remove("pendulum:account:beta");
      t += 21 * MIN;
      loop.holds.limit({ harness: "claude", account: "gamma", reset: t + 60 * MIN, now: t });
      const off = { harness: "claude", hold: "gamma", account: "gamma", reset: t + 60 * MIN, pinned: false, pin: null };
      const lines = [];
      logTo({ write: (x) => lines.push(x) });
      let due;
      try {
        due = await loop.movesEarly(8, off, ["pendulum:objective"], "u9");
      } finally {
        logTo(null);
      }
      assert.equal(due, true);
      assert.ok(lines.some((l) => l.includes("moving to claude account beta, which is free")), lines.join(""));
      loop.result = delivered;
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "beta");
    });
  } finally {
    gh.restore();
  }
});

test("#266: no-reset refusals in a row on one account are passed over 1, 4, then 24 hours, though each pass had output; a served pass ends the guess for good; guesses stay out of the back-off count; a serve with the setting off writes none", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      gh.apply("pendulum:account:alpha");
      loop.result = { exit: "blocked", tokens: { output: 500 }, limitRefused: { harness: "claude" } };
      const ends = [];
      for (let i = 0; i < 3; i++) {
        assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "alpha");
        ends.push(loop.holds.avoidUntil("alpha", t) - t);
        t += 1000;
      }
      assert.deepEqual(ends, [60, 240, 1440].map((m) => m * MIN));
      assert.equal(loop.holds.until("alpha", t), null, "never a hold");
      // Off: a refusal writes no guess.
      const off = serveOn(h, () => t);
      gh.remove("pendulum:account:alpha");
      off.result = loop.result;
      assert.equal((await off.stage(8, "work", "worker.mjs", [])).account, "alpha");
      assert.equal(off.holds.avoidUntil("beta", t), null);
      assert.equal(loop.holds.avoidUntil("alpha", t) - (t - 1000), 1440 * MIN, "the count unchanged by it");
    });
  } finally {
    gh.restore();
  }
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t0 = Date.now();
  const holds = accountHolds({ dir });
  holds.spent({ harness: "claude", account: "a", now: t0 });
  holds.spent({ harness: "claude", account: "a", now: t0 + 1 });
  holds.served({ harness: "claude", account: "a", now: t0 + 2 * MIN, started: t0 + MIN });
  for (const later of [2 * MIN, 61 * MIN, 125 * MIN, 230 * MIN]) assert.equal(accountHolds({ dir }).avoidUntil("a", t0 + later), null, `ended for good (${later / MIN} min on)`);
  // Two guesses, then a limit with a near reset: its back-off is the first step, not the third.
  holds.spent({ harness: "claude", account: "b", now: t0 });
  holds.spent({ harness: "claude", account: "b", now: t0 + 1 });
  assert.equal(holds.limit({ harness: "claude", account: "b", reset: t0 + 2 + MIN, now: t0 + 2 }), t0 + 2 + 2 * MIN);
});

test("#266: with every account held and the first to end a guess, the pause says an estimate, never a reset", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      loop.holds.spent({ harness: "claude", account: "alpha", now: t });
      for (const n of ["beta", "gamma"]) loop.holds.limit({ harness: "claude", account: n, reset: t + 120 * MIN, now: t });
      assert.match(loop.limitHold(["pendulum:objective"], 8, "u"), /the first, claude account alpha, resets at about /);
      const held = await work(loop);
      assert.deepEqual([held.exit, held.account, held.usageLimit.guessed], ["paused", "alpha", true]);
      const body = gh.notices()[0].body;
      assert.match(body, /Claude Code account `alpha` reached its limit with no reset reported, and is passed over until about \S+, an estimate/);
      assert.ok(!body.includes("resets at"), body);
    });
  } finally {
    gh.restore();
  }
});

/** A stage that ended on a usage limit or quota with no reset reported, as session.mjs usageLimitExit writes it locally (#332). */
const noReset = (since, harness = "claude") => ({ exit: "paused", usd: 0.1, tokens: { output: 0 }, usageLimit: { harness, reset: null, since: new Date(since).toISOString(), noReset: true } });

test("#332: on, a limit with no reset reported moves the Objective to a free account at the next tick, with no Block and no person, never back to the one it left, which its guess passes over", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      loop.result = noReset(t);
      const paused = await work(loop);
      assert.deepEqual([paused.exit, paused.account], ["paused", "alpha"]);
      assert.equal(gh.blocked().length, 0, "no Block");
      assert.equal(loop.holds.avoidUntil("alpha", t), t + 60 * MIN, "alpha is passed over for its guess");
      assert.equal(loop.holds.until("alpha", t), null, "a guess, no hold");
      assert.equal(loop.offline.get(8).reset, t + 60 * MIN, "paused at most until the guess's end");
      const notice = gh.notices()[0].body;
      assert.match(notice, /Claude Code account `alpha` reached its limit with no reset reported, and is passed over until about \S+, an estimate\./);
      assert.match(notice, /Free now: `beta`, `gamma`\. This machine chooses accounts by itself/);
      assert.ok(!notice.includes("Every Claude Code account"), notice);
      // The next tick moves it, and its stage starts on a free account, not alpha.
      t += 1000;
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      loop.result = delivered;
      assert.equal((await work(loop)).account, "beta");
      assert.deepEqual(loop.ran(), ["alpha", "beta"]);
      assert.equal(gh.blocked().length, 0);
      // Every serve on the machine passes alpha over until the guess ends.
      assert.ok(!autoServe(h, () => t).freeAccounts("claude", "none").includes("alpha"));
    });
  } finally {
    gh.restore();
  }
});

test("#332: on, with every other account held or passed over, a limit with no reset Blocks once, provider-quota, naming each account's state, and the claim goes", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      loop.holds.limit({ harness: "claude", account: "beta", reset: t + 120 * MIN, now: t });
      loop.holds.spent({ harness: "claude", account: "gamma", now: t - MIN });
      loop.result = noReset(t);
      const end = await work(loop);
      assert.deepEqual([end.exit, end.account], ["paused", "alpha"], "alpha, free, was chosen");
      const blocks = gh.blocked();
      assert.equal(blocks.length, 1, "one Block");
      const at = (ms) => new Date(ms).toISOString().replaceAll(".", "\\.");
      assert.match(blocks[0].body, new RegExp(`Claude Code account \`alpha\` reached its usage limit or quota with no reset reported, and no other Claude Code account on this machine is free: \`alpha\` passed over until about ${at(t + 60 * MIN)} \\(no reset reported\\); \`beta\` held until ${at(t + 120 * MIN)}; \`gamma\` passed over until about ${at(t + 59 * MIN)} \\(no reset reported\\)\\. Re-apply \`pendulum:objective\` once a Claude Code account is free again\\.`));
      assert.match(blocks[0].body, /"cause":"provider-quota"/);
      assert.equal(loop.offline?.has(8) ?? false, false, "not kept paused");
      assert.deepEqual(await loop.pausedHere(new Map()), [], "nothing resumes it");
      assert.equal(loop.holds.avoidUntil("alpha", t), t + 60 * MIN, "alpha's guess is kept for every serve");
    });
  } finally {
    gh.restore();
  }
});

test("#332: a pinned Objective, or any with the setting off, still Blocks on a limit with no reset, as before: no move; on, the pinned account's guess is kept", async () => {
  const h = fakeHome();
  const gh = fakeGitHub();
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const on = autoServe(h, () => t);
      gh.apply("pendulum:account:beta");
      on.result = noReset(t);
      const pinned = await work(on);
      assert.deepEqual([pinned.exit, pinned.account], ["blocked", "beta"], "pinned: Blocked on its own account");
      assert.equal(on.offline?.has(8) ?? false, false);
      assert.equal(on.holds.avoidUntil("beta", t), t + 60 * MIN, "its guess, for other Objectives");
      gh.remove("pendulum:account:beta");
      t += 1000;
      const off = serveOn(h, () => t);
      off.result = noReset(t);
      const plain = await work(off);
      assert.deepEqual([plain.exit, plain.account], ["blocked", "alpha"], "off: Blocked on the default");
      assert.equal(off.holds.avoidUntil("alpha", t), null, "off writes no guess");
      assert.deepEqual([on.ran(), off.ran()], [["beta"], ["alpha"]]);
    });
  } finally {
    gh.restore();
  }
});

test("#332: a Codex stage's limit feeds the same holds: with no reset, a guess automatic choice passes over, and the Objective moves; with a reset, a hold", async () => {
  const h = fakeHome();
  mkdirSync(join(h, "work", "codex-y"), { recursive: true, mode: 0o700 });
  const at = (d) => join(h, "work", d);
  writeFileSync(accountsFile(h), JSON.stringify({ claude: [{ name: "alpha", home: at("claude-a") }], codex: [{ name: "cx", home: at("codex-x") }, { name: "cy", home: at("codex-y") }] }), { mode: 0o600 });
  const gh = fakeGitHub();
  gh.apply("pendulum:harness:codex");
  let t = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => t);
      loop.result = noReset(t, "codex");
      assert.deepEqual([(await work(loop)).account, gh.blocked().length], ["cx", 0]);
      assert.equal(loop.holds.avoidUntil("cx", t), t + 60 * MIN);
      assert.equal(loop.autoAccount("codex").account.name, "cy", "cx is passed over");
      assert.deepEqual(await loop.pausedHere(new Map()), [8]);
      // On cy, a limit with its reset: held, and the Objective waits for the first to end (cx's guess) with no Block.
      t += 1000;
      loop.result = limited(t + 180 * MIN, t, "codex/primary");
      loop.result.usageLimit.harness = "codex";
      assert.equal((await work(loop)).account, "cy");
      assert.equal(loop.holds.until("cy", t), t + 180 * MIN);
      assert.equal(loop.freeAccounts("codex", "none").length, 0);
      assert.equal(gh.blocked().length, 0);
    });
  } finally {
    gh.restore();
  }
});

test("#332: a guess is remembered a day past its end, so a limit again within that day counts on (1, 4, then 24 hours) and an account out for weeks is retried less and less; a day later it starts again at an hour", async () => {
  const { GUESS_FORGET_MS, HOLD_FORGET_MS } = await import("../scripts/lib/holds.mjs");
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now();
  const holds = accountHolds({ dir });
  assert.equal(holds.spent({ harness: "copilot", account: "seat", now: t }), t + 60 * MIN);
  // The guess ended two hours ago, past a hold's hour of memory: the next limit there is the second in a row.
  const second = t + 60 * MIN + 2 * 60 * MIN;
  assert.ok(second - (t + 60 * MIN) > HOLD_FORGET_MS);
  assert.equal(accountHolds({ dir }).spent({ harness: "copilot", account: "seat", now: second }), second + 240 * MIN, "four hours, in every serve");
  const third = second + 240 * MIN + 20 * 60 * MIN;
  assert.equal(accountHolds({ dir }).spent({ harness: "copilot", account: "seat", now: third }), third + 1440 * MIN);
  // A day and more past the last guess's end, it is forgotten (its file too): the count starts again.
  const later = third + 1440 * MIN + GUESS_FORGET_MS + MIN;
  assert.equal(accountHolds({ dir }).spent({ harness: "copilot", account: "seat", now: later }), later + 60 * MIN);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith("seat.")).length, 1, "the forgotten guesses' files are removed");
  // A hold with a reset is still forgotten an hour past its end: its back-off count starts again.
  holds.limit({ harness: "claude", account: "beta", reset: t + MIN, now: t });
  assert.equal(holds.limit({ harness: "claude", account: "beta", reset: t + 2 * HOLD_FORGET_MS, now: t + 2 * HOLD_FORGET_MS }), t + 2 * HOLD_FORGET_MS + 2 * MIN);
});

test("#402: a usage limit with no reset passes its account over for machine.json's guess_hours, by how many in a row, in a stage's end and a paused stage's alike", async () => {
  const h = fakeHome();
  mkdirSync(join(h, ".cache", "pendulum"), { recursive: true });
  writeFileSync(join(h, ".cache", "pendulum", "machine.json"), JSON.stringify({ stages: 8, guess_hours: [2, 6] }));
  const gh = fakeGitHub();
  let now = Date.now();
  try {
    await withHome(h, async () => {
      const loop = autoServe(h, () => now);
      // The repository's guess_hours too: machine.json's wins on this machine.
      loop.baseEnv = () => ({ PENDULUM_LOCAL_ALL: "1", PENDULUM_GUESS_HOURS: "3, 9" });
      loop.result = { exit: "blocked", tokens: { output: 0 }, limitRefused: { harness: "claude" } };
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "alpha");
      assert.equal(loop.holds.avoidUntil("alpha", now), now + 120 * MIN, "two hours, not the default's one nor the repository's three");
      // A second in a row, from a stage that ended paused on it: the setting's second step.
      now += 121 * MIN;
      await loop.spentPaused(8, { stage: "work", account: "alpha", hold: { key: "alpha", shared: true }, pinned: true, usageLimit: { harness: "claude", reset: null, since: new Date(now).toISOString(), noReset: true } });
      assert.equal(loop.holds.avoidUntil("alpha", now), now + 360 * MIN);
    });
  } finally {
    gh.restore();
  }
  // Without guess_hours in machine.json, the repository's setting is the one in force.
  const plain = fakeHome();
  const gh2 = fakeGitHub();
  try {
    await withHome(plain, async () => {
      const loop = autoServe(plain, () => now);
      loop.baseEnv = () => ({ PENDULUM_LOCAL_ALL: "1", PENDULUM_GUESS_HOURS: "3, 9" });
      loop.result = { exit: "blocked", tokens: { output: 0 }, limitRefused: { harness: "claude" } };
      assert.equal((await loop.stage(8, "work", "worker.mjs", [])).account, "alpha");
      assert.equal(loop.holds.avoidUntil("alpha", now), now + 180 * MIN);
    });
  } finally {
    gh2.restore();
  }
});

test("#332: PENDULUM_LOCAL_ENV never carries a control variable into a stage, so no stage moves on a limit unless serve chose its account; a serve with automatic choice off writes no guess", async () => {
  const { localBaseEnv } = await import("../scripts/lib/local.mjs");
  const { PENDULUM_CONTROL_KEYS } = await import("../scripts/lib/inputs.mjs");
  const shell = { PATH: "/bin", PENDULUM_STAGE_AUTO_ACCOUNT: "1", PENDULUM_STAGE_ACCOUNT: "beta", DATABASE_URL: "postgres://x" };
  const base = localBaseEnv(shell, ["PENDULUM_STAGE_AUTO_ACCOUNT", "PENDULUM_STAGE_ACCOUNT", "DATABASE_URL"]);
  assert.equal(base.DATABASE_URL, "postgres://x");
  for (const k of PENDULUM_CONTROL_KEYS) assert.ok(!(k in base), k);
  const h = fakeHome();
  const gh = fakeGitHub();
  const t = Date.now();
  try {
    await withHome(h, async () => {
      const off = serveOn(h, () => t);
      await off.spentPaused(8, { stage: "work", account: "alpha", hold: { key: "alpha", shared: true }, usageLimit: { harness: "claude", reset: null, since: new Date(t).toISOString(), noReset: true } });
      assert.equal(off.holds.avoidUntil("alpha", t), null, "no guess");
      assert.equal(gh.blocked().length, 1, "Blocked, as with no move");
      assert.match(gh.blocked()[0].body, /Re-apply `pendulum:objective` once a Claude Code account is free again\./);
    });
  } finally {
    gh.restore();
  }
});
