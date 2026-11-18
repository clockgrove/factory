import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The re-check of usage-limit holds (#613). The stage script serve starts is this file's fake worker (it writes the
// result.json a test gives it), and the harness a probe calls is a fake `claude` on the loop's PATH that prints what a
// test gives it: serve's real stage end, hold, pausedHere, limitHold, probeHolds and probeHold run, through the real
// runDecision and the machine's real holds. Set before local.mjs is loaded.
const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-")));
mkdirSync(join(root, "scripts"));
writeFileSync(join(root, "scripts", "worker.mjs"), 'import { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst a = process.argv;\nappendFileSync(process.env.FAKE_RAN, "ran\\n");\nwriteFileSync(join(a[a.indexOf("--usage-dir") + 1], "result.json"), process.env.FAKE_RESULT);\n');
process.env.PENDULUM_PLUGIN_ROOT = root;
const { RETRY } = await import("../scripts/lib/github.mjs");
const { logTo } = await import("../scripts/lib/inputs.mjs");
const { HOLD_MAX_MS, PROBE_EVERY_MS, PROBE_NEAR_MS, accountHolds, holdsDir } = await import("../scripts/lib/holds.mjs");
const { Local, holderId, machineIdentity } = await import("../scripts/local.mjs");
const { accountsFile } = await import("../scripts/lib/accounts.mjs");
const { gitPinFile, pinGitDir } = await import("../scripts/lib/local.mjs");

RETRY.sleep = async () => {};
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const LIMIT_RUN = readFileSync(join(import.meta.dirname, "fixtures", "claude-2.1.323-usage-limit.jsonl"), "utf8");
const AUTH_RUN = readFileSync(join(import.meta.dirname, "fixtures", "claude-2.1.321-401.jsonl"), "utf8");
const INIT = { type: "system", subtype: "init", session_id: "11111111-1111-1111-1111-111111111111" };
const jsonl = (events) => events.map((l) => JSON.stringify(l)).join("\n") + "\n";
/** An answered call as Claude Code reports each model's use (`modelUsage`): `model` answered, with output. */
const answeredBy = (model) => jsonl([INIT, { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", session_id: INIT.session_id, total_cost_usd: 0.002, modelUsage: { [model]: { inputTokens: 900, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.002 } } }]);
/** Wait until `ok()` holds (polled every 10 ms, up to 10 s). */
const until = async (ok) => {
  const end = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** Claude Code's stream for an answered call that cost `usd`. */
const answered = (usd = 0.012) => [{ type: "system", subtype: "init", session_id: "11111111-1111-1111-1111-111111111111" }, { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", session_id: "11111111-1111-1111-1111-111111111111", total_cost_usd: usd, usage: { input_tokens: 900, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }].map((l) => JSON.stringify(l)).join("\n") + "\n";

/** A stand-in home with two Claude Code accounts declared, alpha (the default) and beta. Every file is a dummy. */
function fakeHome() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "probe-")));
  for (const d of [".claude", ".codex", ".config/pendulum", "work/claude-a", "work/claude-b"]) mkdirSync(join(h, d), { recursive: true, mode: 0o700 });
  chmodSync(join(h, ".config", "pendulum"), 0o700);
  writeFileSync(accountsFile(h), JSON.stringify({ claude: [{ name: "alpha", home: join(h, "work", "claude-a") }, { name: "beta", home: join(h, "work", "claude-b") }] }), { mode: 0o600 });
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

/** A GitHub for Objective #8, Running on this machine: its labels and comments (the claim, the pause notice). */
function fakeGitHub() {
  const state = { labels: new Set(["pendulum:objective", "pendulum:local", "pendulum:running"]), comments: [] };
  let id = 100;
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const issue = () => ({ number: 8, state: "open", title: "t", body: "b", labels: [...state.labels].map((name) => ({ name })), updated_at: new Date(Date.UTC(2026, 10, 15)).toISOString() });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname.replace("/repos/acme/app", "");
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (p === "/user") return json({ login: "maintainer", type: "User" });
    if (method === "GET" && p === "/issues/8") return json(issue());
    if (method === "GET" && p === "/issues") return json(state.labels.has(u.searchParams.get("labels")) ? [issue()] : []);
    if (method === "GET" && p === "/issues/8/comments") return json(state.comments);
    if (method === "POST" && p === "/issues/8/comments") {
      const c = { id: (id += 1), user: { login: "maintainer", type: "User" }, body: JSON.parse(init.body).body, updated_at: new Date().toISOString() };
      state.comments.push(c);
      return json(c, 201);
    }
    const one = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (one && method === "PATCH") return json(Object.assign(state.comments.find((x) => String(x.id) === one[1]), { body: JSON.parse(init.body).body, updated_at: new Date().toISOString() }));
    if (one && method === "DELETE") return state.comments.splice(state.comments.findIndex((x) => String(x.id) === one[1]), 1), json({});
    if (p === "/graphql") return json({ data: {} });
    return json(method === "GET" ? [] : {});
  };
  return {
    restore() {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
    },
  };
}

/**
 * A serve on the fake home (another repository's, or a second one: the machine's holds are shared), as
 * account-move.test.mjs makes one. `claude` on its PATH is the fake harness: it appends its argv and its login folder to
 * a log, prints `loop.says` and exits `loop.exits`.
 */
function serveOn(h, clock) {
  const dev = join(h, "work", `repo-${Math.random().toString(36).slice(2, 8)}`);
  const loop = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repo: REPO, repoFull: REPO.full, wf: {}, opts: { token: "t" }, stopping: false, firstSetup: new Map(), children: new Set(), clock, holder: holderId(machineIdentity(), process.pid), claimRetryMs: 0 });
  loop.holds = accountHolds({ dir: holdsDir(h) });
  loop.harnessReady = () => [];
  const clone = join(loop.ws(8), "repo");
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  pinGitDir(clone, gitPinFile(loop.ws(8)));
  const bin = join(dev, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "srt"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const calls = join(dev, "calls.jsonl");
  const fake = join(dev, "fake.json");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nconst fs = require("node:fs");\nconst cfg = JSON.parse(fs.readFileSync(${JSON.stringify(fake)}, "utf8"));\nconst prompt = fs.readFileSync(0, "utf8");\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), prompt, login: process.env.CLAUDE_CONFIG_DIR ?? null, cwd: process.cwd() }) + "\\n");\nconst end = () => {\n  process.stdout.write(cfg.out);\n  process.exit(cfg.code);\n};\n// With \`gate\`, it answers once that file exists: a probe still running, for as long as a test wants.\nconst wait = () => (!cfg.gate || fs.existsSync(cfg.gate) ? end() : setTimeout(wait, 10));\nwait();\n`, { mode: 0o755 });
  const gate = join(dev, "go");
  loop.says = (out, code = 0, { gated = false } = {}) => writeFileSync(fake, JSON.stringify({ out, code, gate: gated ? gate : null }));
  loop.go = () => writeFileSync(gate, "");
  loop.says(answered());
  loop.calls = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // What every child of the loop starts from, the real baseEnv's, with the fake first on its PATH.
  const baseEnv = loop.baseEnv.bind(loop);
  loop.baseEnv = () => ({ ...baseEnv(), PATH: `${bin}:${process.env.PATH}` });
  const ran = join(dev, "ran.txt");
  writeFileSync(ran, "");
  loop.result = {};
  loop.stageEnv = (issue, usageDir, c, stageTmp) => ({ PATH: `${bin}:${process.env.PATH}`, PENDULUM_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: join(dev, "pnpm"), BUN_INSTALL_CACHE_DIR: join(dev, "bun"), FAKE_RAN: ran, FAKE_RESULT: JSON.stringify(loop.result) });
  loop.ran = () => readFileSync(ran, "utf8").split("\n").filter(Boolean).length;
  return loop;
}

/** A work stage that ends on its usage limit of `window`, reset at `reset` (ms), as session.mjs usageLimitExit writes it. */
const limited = (reset, since, window = "seven_day") => ({ exit: "paused", usd: 0.1, tokens: { output: 0 }, account: "alpha", usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(since).toISOString(), limitType: window } });
const work = (loop) => loop.withClaim(8, () => loop.stage(8, "work", "worker.mjs", []));
/** One tick's read of the paused work and the queue, then its probe pass, waited for. */
const tick = async (loop) => {
  const paused = await loop.pausedHere(new Map());
  const held = loop.limitHold(["pendulum:objective"], 9, null);
  await loop.probeHolds();
  return { paused, held };
};

/** Run `fn` on a fake home and GitHub with the loop's log lines kept. */
async function scene(fn) {
  const h = fakeHome();
  const gh = fakeGitHub();
  const lines = [];
  logTo({ write: (x) => lines.push(x) });
  try {
    await withHome(h, () => fn(h, lines));
  } finally {
    logTo(null);
    gh.restore();
  }
}

test("#613: a usage limit lifted before the reset it named is released at the next probe: one call on the held account's own login, no stage's, and the paused Objective and new work go on at the next tick", async () => {
  await scene(async (h, lines) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    // A stage on alpha meets its weekly limit, reset six days out.
    loop.result = limited(t + 6 * DAY, t);
    assert.equal((await work(loop)).exit, "paused");
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), t + 6 * DAY);
    const files = readdirSync(holdsDir(h));
    // The provider lifted the limit: the next tick's probe is answered.
    t += MIN;
    const first = await tick(loop);
    assert.deepEqual(first.paused, [], "held at the tick that started the probe");
    assert.match(first.held, /alpha's usage limit is spent until /);
    const calls = loop.calls();
    assert.equal(calls.length, 1, "one call");
    assert.equal(calls[0].login, join(h, "work", "claude-a"), "on the held account's own login");
    assert.equal(calls[0].prompt, "Reply with the single word ok.");
    assert.equal(calls[0].args[calls[0].args.indexOf("--tools") + 1], "", "with no tool");
    assert.ok(calls[0].args.includes("--no-session-persistence"));
    assert.equal(loop.ran(), 1, "no stage started for it");
    // Released as `pendulum hold release` does: one release record more, none removed, read by every serve here.
    const after = readdirSync(holdsDir(h));
    assert.ok(files.every((f) => after.includes(f)));
    const added = after.filter((f) => !files.includes(f) && /^alpha\.[0-9a-f]{16}\.json$/.test(f));
    assert.equal(added.length, 1);
    assert.equal(JSON.parse(readFileSync(join(holdsDir(h), added[0]), "utf8")).released, true);
    const other = serveOn(h, () => t);
    assert.equal(other.limitUntil({ key: "alpha", shared: true }), null);
    assert.equal(other.limitHold(["pendulum:objective"], 9, null), null, "new work starts on it");
    // The probe's cost, as the harness reported it, in the account's probe record and the log.
    const probe = JSON.parse(readFileSync(join(holdsDir(h), "alpha.probe.json"), "utf8"));
    assert.deepEqual(probe, { harness: "claude", account: "alpha", at: t, outcome: "answered", usd: 0.012, billing: "unknown", model: "claude-opus-5-5", released: t });
    assert.ok(lines.some((l) => /claude account alpha: answered a probe before its usage limit's reset .*its hold is released, as `pendulum hold release alpha` does; .*\(the probe: \$0\.0120\)/.test(l)), lines.join(""));
    // The next tick resumes the paused Objective, and says whose release it was.
    t += 30_000;
    const next = await tick(loop);
    assert.deepEqual(next.paused, [8]);
    assert.equal(next.held, null);
    assert.ok(lines.some((l) => /#8: claude account alpha answered a serve's probe and was released at .*; resuming it now, before the reset it paused for/.test(l)), lines.join(""));
    assert.equal(loop.calls().length, 1, "nothing held: nothing probed");
  });
});

test("#613: a probe still refused for the usage limit keeps the hold, as does any other failure; the next probe of the account, by any serve on the machine, is 30 minutes on", async () => {
  await scene(async (h, lines) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    const other = serveOn(h, () => t);
    for (const l of [loop, other]) l.says(LIMIT_RUN, 1);
    loop.result = limited(t + 6 * DAY, t);
    await work(loop);
    const reset = loop.limitUntil({ key: "alpha", shared: true });
    const files = readdirSync(holdsDir(h)).filter((f) => f !== "alpha.probe.json");
    t += MIN;
    const probedAt = t;
    assert.deepEqual((await tick(loop)).paused, []);
    assert.equal(loop.calls().length, 1);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), reset, "the hold stands");
    assert.deepEqual(readdirSync(holdsDir(h)).filter((f) => f !== "alpha.probe.json"), files, "no release record");
    assert.deepEqual(JSON.parse(readFileSync(join(holdsDir(h), "alpha.probe.json"), "utf8")), { harness: "claude", account: "alpha", at: probedAt, outcome: "limited", usd: 0, billing: "subscription", model: "claude-opus-5-5" });
    assert.ok(lines.some((l) => /claude account alpha: probed before its usage limit's reset .*: its usage limit still refuses it; the hold stands, and it is probed again in 30 min at the soonest \(the probe: \$0\.0000\)/.test(l)), lines.join(""));
    // Every tick until the interval has passed probes nothing, in this serve or another on the machine.
    for (const step of [30_000, 10 * MIN, PROBE_EVERY_MS - 10 * MIN - 30_000 - 1]) {
      t += step;
      assert.deepEqual((await tick(loop)).paused, []);
      assert.match((await tick(other)).held, /alpha's usage limit is spent until /);
    }
    assert.equal(t, probedAt + PROBE_EVERY_MS - 1);
    assert.equal(loop.calls().length + other.calls().length, 1, "no probe within 30 minutes of the last");
    // At the interval: one probe, the other serve's this time, and none by the first right after it.
    t += 1;
    await tick(other);
    await tick(loop);
    assert.equal(other.calls().length, 1);
    assert.equal(loop.calls().length, 1);
    // Any other failure (the harness exits with no result): the hold stands, its cost unknown and said so, never a figure.
    loop.says("", 1);
    t += PROBE_EVERY_MS;
    assert.deepEqual((await tick(loop)).paused, []);
    assert.equal(loop.calls().length, 2);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), reset);
    const failed = JSON.parse(readFileSync(join(holdsDir(h), "alpha.probe.json"), "utf8"));
    assert.deepEqual([failed.outcome, failed.usd, failed.usdUnknown, failed.usdUnknownWhy], ["failed", null, 1, ["unreported"]]);
    assert.ok(lines.some((l) => /claude account alpha: probed .*: it got no answer \(.*\); the hold stands, .*\(the probe: no cost reported, of unknown cost \(unreported\)\)/.test(l)), lines.join(""));
    assert.equal(loop.ran(), 1, "no stage started through any of it");
  });
});

test("#613: no probe while the reset is an hour away or less, none of a hold no work waits on, and none of a no-reset guess", async () => {
  await scene(async (h) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    // alpha's reset is an hour out: the reset itself comes soon enough.
    loop.result = limited(t + PROBE_NEAR_MS, t, "five_hour");
    await work(loop);
    for (const step of [0, 20 * MIN, 39 * MIN]) {
      t += step;
      assert.deepEqual((await tick(loop)).paused, []);
    }
    assert.equal(loop.calls().length, 0, "the reset is near");
    t += MIN;
    assert.deepEqual((await tick(loop)).paused, [8], "resumed at the reset, never probed");
    assert.equal(loop.calls().length, 0);
  });
  await scene(async (h) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    // beta is held days out, but nothing of this loop runs on it; alpha passed over on a guess only.
    const store = accountHolds({ dir: holdsDir(h) });
    store.limit({ harness: "claude", account: "beta", reset: t + 6 * DAY, now: t });
    store.spent({ harness: "claude", account: "alpha", now: t, steps: [24 * H] });
    t += MIN;
    assert.equal((await tick(loop)).held, null, "alpha, the default, is not held to a reset");
    assert.equal(loop.calls().length, 0);
    // One second past an hour ahead of the reset is far enough: probed.
    const far = serveOn(h, () => t);
    store.limit({ harness: "claude", account: "alpha", reset: t + PROBE_NEAR_MS + 1000, now: t });
    assert.match((await tick(far)).held, /alpha's usage limit is spent until /);
    assert.equal(far.calls().length, 1);
    assert.equal(far.calls()[0].login, join(h, "work", "claude-a"));
  });
});

test("#613: the probe bounds are the store's: a hold more than an hour from its reset, at most once in 30 minutes for every serve, a turn taken as the probe starts", () => {
  assert.equal(PROBE_EVERY_MS, 30 * MIN);
  assert.equal(PROBE_NEAR_MS, H);
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "holds-"))), "holds");
  const t = Date.now();
  const a = accountHolds({ dir });
  const b = accountHolds({ dir });
  assert.equal(a.probeDue("alpha", t), false, "nothing held");
  a.limit({ harness: "claude", account: "alpha", reset: t + 3 * DAY, now: t });
  assert.equal(b.probeDue("alpha", t), true);
  assert.equal(b.probeDue("alpha", t + 3 * DAY - PROBE_NEAR_MS), false, "an hour from the reset");
  assert.equal(b.probeDue("alpha", t + 3 * DAY - PROBE_NEAR_MS - 1), true);
  // The turn is taken as a probe starts, before its answer: another serve reads it at once.
  a.probed({ harness: "claude", account: "alpha", now: t });
  assert.equal(b.probe("alpha", t).outcome, null);
  assert.equal(b.probeDue("alpha", t), false);
  assert.equal(b.probeDue("alpha", t + PROBE_EVERY_MS - 1), false);
  assert.equal(b.probeDue("alpha", t + PROBE_EVERY_MS), true);
  // Its end and cost replace it: dollars as reported, or runs of unknown cost with their codes; nothing else is kept.
  a.probed({ harness: "claude", account: "alpha", now: t, outcome: "limited", usd: 0.004, usdUnknown: 1, usdUnknownWhy: ["unreported", "not a code!"], billing: "subscription", model: "m-1", secret: "x" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "alpha.probe.json"), "utf8")), { harness: "claude", account: "alpha", at: t, outcome: "limited", usd: 0.004, usdUnknown: 1, usdUnknownWhy: ["unreported"], billing: "subscription", model: "m-1" });
  assert.equal(b.until("alpha", t), t + 3 * DAY, "a probe record holds and releases nothing");
  assert.deepEqual(b.list(t).map((x) => x.account), ["alpha"]);
  // Another clock's probe, dated after now, is long ago: it never keeps a hold from being probed.
  a.probed({ harness: "claude", account: "alpha", now: t + 5 * DAY });
  assert.equal(b.probeDue("alpha", t + MIN), true);
  // With no folder (a hold kept in one loop's memory), the same bounds in that process.
  const mem = accountHolds();
  mem.limit({ harness: "claude", account: "claude@env", reset: t + 3 * DAY, now: t });
  assert.equal(mem.probeDue("claude@env", t), true);
  mem.probed({ harness: "claude", account: "claude@env", now: t });
  assert.equal(mem.probeDue("claude@env", t + MIN), false);
  // The record goes once no probe was made for as long as a hold can last.
  assert.ok(HOLD_MAX_MS > PROBE_EVERY_MS);
});

const probeFile = (h, key = "alpha") => JSON.parse(readFileSync(join(holdsDir(h), `${key}.probe.json`), "utf8"));
const releases = (h) => readdirSync(holdsDir(h)).filter((f) => /^[a-z@0-9-]+\.[0-9a-f]{16}\.json$/.test(f) && JSON.parse(readFileSync(join(holdsDir(h), f), "utf8")).released === true).length;

test("#613: only an answer the provider served releases: a clean exit with a result of no output (a synthetic one), or with no result line at all, keeps the hold", async () => {
  // Claude Code's own stand-in message (model `<synthetic>`, no tokens) under a result that says success.
  const synthetic = jsonl([INIT, { type: "assistant", message: { model: "<synthetic>", role: "assistant", type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, session_id: INIT.session_id }, { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", session_id: INIT.session_id, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} }]);
  // A stream that ends with no result event: its last line is no result, whatever it carries.
  const noResult = jsonl([INIT, { type: "assistant", message: { model: "claude-opus-5-5", role: "assistant", type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 900, output_tokens: 2 } }, session_id: INIT.session_id }]);
  for (const [out, name] of [[synthetic, "synthetic"], [noResult, "no result"]]) {
    await scene(async (h, lines) => {
      let t = Date.now();
      const loop = serveOn(h, () => t);
      loop.result = limited(t + 6 * DAY, t);
      await work(loop);
      loop.says(out, 0);
      t += MIN;
      assert.deepEqual((await tick(loop)).paused, [], name);
      assert.equal(loop.calls().length, 1, name);
      assert.equal(loop.limitUntil({ key: "alpha", shared: true }), t - MIN + 6 * DAY, `${name}: the hold stands`);
      assert.equal(releases(h), 0, name);
      assert.equal(probeFile(h).outcome, "failed", name);
      assert.ok(lines.some((l) => /claude account alpha: probed .*: it got no answer \(.*\); the hold stands/.test(l)), lines.join(""));
    });
  }
});

test("#613: a hold kept for a per-model window is probed on a model of that family, and released only by an answer from one", async () => {
  await scene(async (h, lines) => {
    let t = Date.now();
    // This loop's stages run Opus alone: its probe of a Sonnet window is answered by Opus, which says nothing of it.
    const loop = serveOn(h, () => t);
    loop.result = limited(t + 6 * DAY, t, "seven_day_sonnet");
    await work(loop);
    loop.says(answeredBy("claude-opus-5-5"));
    t += MIN;
    assert.deepEqual((await tick(loop)).paused, []);
    assert.equal(loop.calls().length, 1);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), t - MIN + 6 * DAY, "another model's answer releases nothing");
    assert.equal(releases(h), 0);
    assert.deepEqual([probeFile(h).outcome, probeFile(h).usd], ["failed", 0.002]);
    assert.ok(lines.some((l) => /claude account alpha: probed .*: it was answered by claude-opus-5-5, which its seven_day_sonnet window does not limit; the hold stands/.test(l)), lines.join(""));
    // A loop whose sub-agents run Sonnet probes on that model; an answer that names another model still releases nothing.
    const sonnet = serveOn(h, () => t);
    sonnet.wf = { PENDULUM_SUBAGENT_MODEL: "claude-sonnet-5" };
    sonnet.says(answeredBy("claude-opus-5-5"));
    t += PROBE_EVERY_MS;
    await tick(sonnet);
    const call = sonnet.calls()[0];
    assert.equal(call.args[call.args.indexOf("--model") + 1], "claude-sonnet-5", "probed on the window's family");
    assert.equal(releases(h), 0);
    // Answered by a Sonnet model: the window is lifted.
    sonnet.says(answeredBy("claude-sonnet-5"));
    t += PROBE_EVERY_MS;
    await tick(sonnet);
    assert.equal(sonnet.calls().length, 2);
    assert.equal(releases(h), 1);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), null);
    assert.deepEqual([probeFile(h).outcome, probeFile(h).model, probeFile(h).released], ["answered", "claude-sonnet-5", t]);
  });
  // A window of every model is probed on the worker's model, and its answer releases.
  await scene(async (h) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    loop.wf = { PENDULUM_SUBAGENT_MODEL: "claude-sonnet-5" };
    loop.result = limited(t + 6 * DAY, t, "seven_day");
    await work(loop);
    loop.says(answeredBy("claude-opus-5-5"));
    t += MIN;
    await tick(loop);
    assert.equal(loop.calls()[0].args[loop.calls()[0].args.indexOf("--model") + 1], "claude-opus-5-5");
    assert.equal(releases(h), 1);
  });
});

test("#613: an answered probe releases only the hold it was started for: a limit met while it ran stands, and a hold already ended gets no second release", async () => {
  await scene(async (h, lines) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    loop.result = limited(t + 6 * DAY, t);
    await work(loop);
    loop.says(answered(), 0, { gated: true });
    t += MIN;
    await loop.pausedHere(new Map());
    const probing = loop.probeHolds();
    await until(() => loop.calls().length === 1);
    // Another serve's stage meets the account's limit again while the probe runs.
    t += MIN;
    accountHolds({ dir: holdsDir(h) }).limit({ harness: "claude", account: "alpha", reset: t + 5 * DAY, now: t });
    t += 1000;
    loop.go();
    await probing;
    assert.equal(releases(h), 0);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), t - MIN - 1000 - MIN + 6 * DAY, "the hold stands");
    assert.deepEqual([probeFile(h).outcome, probeFile(h).released], ["answered", undefined]);
    assert.ok(lines.some((l) => /claude account alpha: answered a probe \(\$0\.0120\); a stage met its usage limit again meanwhile, so the hold stands/.test(l)), lines.join(""));
  });
  await scene(async (h, lines) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    loop.result = limited(t + 6 * DAY, t);
    await work(loop);
    loop.says(answered(), 0, { gated: true });
    t += MIN;
    await loop.pausedHere(new Map());
    const probing = loop.probeHolds();
    await until(() => loop.calls().length === 1);
    // A person releases the account while the probe runs.
    t += MIN;
    accountHolds({ dir: holdsDir(h) }).release({ account: "alpha", now: t });
    t += 1000;
    loop.go();
    await probing;
    assert.equal(releases(h), 1, "the person's release alone");
    assert.equal(probeFile(h).released, undefined);
    assert.ok(lines.some((l) => /claude account alpha: answered a probe \(\$0\.0120\); its hold had ended already/.test(l)), lines.join(""));
    // The resume says whose release it was: the person's.
    assert.deepEqual(await loop.pausedHere(new Map()), [8]);
    assert.ok(lines.some((l) => /#8: claude account alpha was released \(pendulum hold release\) at /.test(l)), lines.join(""));
  });
});

test("#613: a refusal that is no usage limit keeps the hold; a probe under way is the account's only one, in its serve and in another; a stopping serve ends it; a Copilot hold is never probed", async () => {
  // A refused credential: no answer, and no word on the limit.
  await scene(async (h, lines) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    loop.result = limited(t + 6 * DAY, t);
    await work(loop);
    loop.says(AUTH_RUN, 1);
    t += MIN;
    await tick(loop);
    assert.equal(loop.calls().length, 1);
    assert.equal(releases(h), 0);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), t - MIN + 6 * DAY);
    assert.equal(probeFile(h).outcome, "failed");
    assert.ok(lines.some((l) => /claude account alpha: probed .*: the provider refused it \(HTTP 401[^)]*\); the hold stands/.test(l)), lines.join(""));
  });
  await scene(async (h, lines) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    const other = serveOn(h, () => t);
    loop.result = limited(t + 6 * DAY, t);
    await work(loop);
    loop.says(answered(), 0, { gated: true });
    t += MIN;
    const tookAt = t;
    await loop.pausedHere(new Map());
    const probing = loop.probeHolds();
    // The turn is written as the probe starts, before any answer: another serve reads it and stays quiet.
    assert.deepEqual(probeFile(h), { harness: "claude", account: "alpha", at: tookAt, outcome: null, usd: null, billing: null, model: null });
    await until(() => loop.calls().length === 1);
    t += MIN;
    await tick(other);
    assert.equal(other.calls().length, 0, "another serve, inside the interval");
    // Past the interval with the probe still running: this loop starts no second one of its own.
    t += PROBE_EVERY_MS;
    await loop.pausedHere(new Map());
    assert.deepEqual(await loop.probeHolds(), [], "one probe per account at a time in a loop");
    assert.equal(loop.calls().length, 1);
    // serve stops (its signal handler aborts probeStop): the probe ends, releasing nothing.
    loop.probeStop.abort();
    assert.deepEqual(await probing, ["failed"]);
    assert.equal(releases(h), 0);
    assert.equal(loop.limitUntil({ key: "alpha", shared: true }), tookAt - MIN + 6 * DAY);
    assert.equal(probeFile(h).outcome, "failed");
    assert.ok(lines.some((l) => /claude account alpha: probed .*: it got no answer \(stopped by Pendulum\); the hold stands/.test(l)), lines.join(""));
    // And a stopping loop starts none.
    t += PROBE_EVERY_MS;
    loop.stopping = true;
    await loop.pausedHere(new Map());
    assert.deepEqual(await loop.probeHolds(), []);
    assert.equal(loop.calls().length, 1);
  });
  // Copilot reports no reset; a record that holds its login to one all the same is never probed.
  await scene(async (h) => {
    let t = Date.now();
    const loop = serveOn(h, () => t);
    const key = loop.holdOf({ name: "copilot", harness: "copilot", declared: false }).key;
    loop.holds.limit({ harness: "copilot", account: key, reset: t + 6 * DAY, now: t });
    t += MIN;
    assert.match(loop.limitHold(["pendulum:objective", "pendulum:harness:copilot"], 9, null), /copilot's usage limit is spent until /);
    assert.deepEqual(await loop.probeHolds(), []);
    assert.equal(loop.holds.probe(key, t), null, "no turn taken");
    assert.equal(loop.calls().length, 0);
  });
});
