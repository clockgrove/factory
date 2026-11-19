import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whenText } from "../scripts/lib/clock.mjs";

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
const { accountHolds, holdsDir } = await import("../scripts/lib/holds.mjs");
const { Local, holderId, machineIdentity } = await import("../scripts/local.mjs");
const { accountPin, accountsFile, chooseAccount, harnessAccounts, loadAccounts, pinnedAccount } = await import("../scripts/lib/accounts.mjs");
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

for (const [what, apply, says] of [
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

for (const what of ["a usage limit's reset a week out"]) {
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
      assert.equal(line, `every Claude Code account on this machine has its usage limit spent; the first, claude account gamma, resets at ${whenText(t + 90 * MIN)}`);
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
      assert.match(notice, /Claude Code account `alpha` reached its limit with no reset reported, and is passed over until about [^,]+, [^,]+, an estimate\./);
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
      assert.match(gh.blocked()[0].body, /Resume through Draft once a Claude Code account is free again\./);
    });
  } finally {
    gh.restore();
  }
});
