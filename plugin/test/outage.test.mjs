import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY, rest } from "../scripts/lib/github.mjs";
import { NetworkDown, OUTAGE, networkBack, passCutOff, resetNetwork, unreachable, waitOutages } from "../scripts/lib/network.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { outageExit, crashed } from "../scripts/lib/session.mjs";
import { LOST_PASS_PROMPT, runHarness } from "../scripts/lib/harness.mjs";

// #228: a request or a harness pass that cannot leave this machine waits for the network in place, one probe loop and
// two log lines for all its callers; past the stage's limit it ends the stage (paused locally, an `outage` Block
// elsewhere), never a crash. GitHub answering anything, a 5xx included, is not this.

const fixtures = join(import.meta.dirname, "fixtures");
const dns = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.test"), { code: "EAI_AGAIN" }) });
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/**
 * Both clocks faked (the client's retries, the outage's probes): waits pass at once and move `now`. `fetch` is
 * `answer(req)` with req {method, origin, path, probe}; every request is in `seen`. Log lines are in `lines`.
 */
async function offline(answer, fn) {
  const saved = { fetch: globalThis.fetch, api: process.env.GITHUB_API_URL, retry: { sleep: RETRY.sleep, now: RETRY.now, random: RETRY.random }, outage: { sleep: OUTAGE.sleep, now: OUTAGE.now } };
  process.env.GITHUB_API_URL = "https://api.github.test";
  let t = Date.parse("2026-11-14T08:47:00Z");
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    t += ms;
  };
  Object.assign(RETRY, { sleep, now: () => t, random: () => 0.5 });
  Object.assign(OUTAGE, { sleep, now: () => t });
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const req = { method: init.method || "GET", origin: u.origin, path: u.pathname, probe: init.method === "HEAD" };
    seen.push(req);
    return answer(req, seen);
  };
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    return await fn({ seen, lines, waits, now: () => t });
  } finally {
    process.stdout.write = write;
    resetNetwork();
    globalThis.fetch = saved.fetch;
    Object.assign(RETRY, saved.retry);
    Object.assign(OUTAGE, saved.outage);
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  }
}

const netLines = (lines) => lines.filter((l) => /\[factory\] network: /.test(l));
const retryLines = (lines) => lines.filter((l) => /\[factory\] GitHub /.test(l));

test("rest: calls that cannot leave this machine wait for one probe loop, then go again; one line lost, one back, no retry lines", async () => {
  let probes = 0;
  await offline(
    (req) => {
      if (req.probe) return ++probes < 4 ? Promise.reject(dns()) : new Response(null, { status: 200 });
      if (probes < 4) throw dns();
      return json({ number: Number(req.path.split("/").at(-1)) });
    },
    async ({ seen, lines }) => {
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      // Five callers at once (the work, the heartbeat, the progress poll, the watch...): one probe loop for all.
      const got = await Promise.all([1, 2, 3, 4, 5].map((n) => rest(`repos/o/r/issues/${n}`, { token: "t" })));
      assert.deepEqual(got.map((g) => g.number), [1, 2, 3, 4, 5]);
      assert.equal(probes, 4, "one probe at a time, until it answers");
      assert.equal(seen.filter((r) => !r.probe).length, 10, "each call: the try that never left, then one after the network is back");
      const net = netLines(lines);
      assert.equal(net.length, 2, net.join(""));
      assert.match(net[0], /network: api\.github\.test is unreachable from this machine \(EAI_AGAIN\); waiting for it to answer again, for up to 15 min/);
      assert.match(net[1], /network: api\.github\.test answers again after 1 min \(unreachable since 2026-11-14T08:47:00\.000Z\)/);
      assert.deepEqual(retryLines(lines), [], "no retry lines for a network that is down");
    },
  );
});

test("rest: a create that never left this machine is sent once more after the network is back, and only once", async () => {
  let posts = 0;
  let probes = 0;
  await offline(
    (req) => {
      // Down for over two minutes: longer than the client's own retries (90 s) would wait.
      if (req.probe) return ++probes < 5 ? Promise.reject(dns()) : new Response(null, { status: 204 });
      if (req.method === "POST") return (++posts, probes < 5 ? Promise.reject(dns()) : json({ id: 9 }, 201));
      return json([]);
    },
    async ({ now }) => {
      const start = now();
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      assert.deepEqual(await rest("repos/o/r/issues/7/comments", { method: "POST", body: { body: "x" }, token: "t" }), { id: 9 });
      assert.equal(posts, 2, "the try that never left, then one");
      assert.ok(now() - start > RETRY.maxWaitMs);
    },
  );
});

test("rest: a 5xx is GitHub answering, not this machine's network: the client's own retries, no probe", async () => {
  let n = 0;
  await offline(
    (req) => (req.probe ? assert.fail("no probe for an answer") : ++n < 3 ? json({ message: "Bad Gateway" }, 502) : json({ ok: true })),
    async ({ lines }) => {
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      assert.deepEqual(await rest("repos/o/r/issues/1", { token: "t" }), { ok: true });
      assert.equal(retryLines(lines).length, 2);
      assert.deepEqual(netLines(lines), []);
    },
  );
});

test("rest: past the stage's limit the wait ends with NetworkDown (offline, its host, code and since), and later requests fail at once", async () => {
  await offline(
    () => Promise.reject(dns()),
    async ({ seen, lines, now }) => {
      const start = now();
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      const e = await rest("repos/o/r/pulls/122", { token: "t" }).then(() => assert.fail("answered"), (x) => x);
      assert.ok(e instanceof NetworkDown);
      assert.equal(unreachable(e), true);
      assert.deepEqual({ code: e.code, origin: e.origin, since: e.since, transport: e.transport, status: e.status }, { code: "EAI_AGAIN", origin: "https://api.github.test", since: start, transport: true, status: 0 });
      assert.equal(now() - start, OUTAGE.stageWaitMs, "it waited the whole limit, no longer");
      assert.ok(seen.filter((r) => r.probe).length <= 20, "probes back off to one a minute");
      assert.match(netLines(lines).at(-1), /still unreachable after 15 min .*; no longer waiting/);
      // Past its limit the stage waits no more: what it still writes (its exit) is one try, failing at once.
      const before = seen.length;
      await assert.rejects(rest("repos/o/r/issues/7/comments", { method: "POST", body: { body: "x" }, token: "t" }), (x) => x.unsent === true && !(x instanceof NetworkDown));
      assert.equal(seen.length - before, 1, "no retries once the stage stopped waiting");
    },
  );
});

test("passCutOff: a failed pass counts as cut off when an outage was under way near its end, or its host does not answer now", async () => {
  let down = true;
  await offline(
    (req) => (req.origin === "https://api.anthropic.test" && down ? Promise.reject(dns()) : new Response(null, { status: 200 })),
    async ({ now }) => {
      waitOutages({ until: () => Infinity });
      assert.deepEqual(await passCutOff(now() - 60_000, now(), ["https://api.anthropic.test", "https://api.github.test"]), { origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: now(), ongoing: true });
      assert.equal(await passCutOff(now() - 60_000, now(), ["https://api.github.test"]), null, "every host answers: the pass failed on its own");
      // An outage that ended near the pass's end counts; one over before the pass began does not (a pass run again after it).
      const ep = networkBack("https://api.anthropic.test", "EAI_AGAIN");
      down = false;
      await ep;
      const back = now();
      assert.equal((await passCutOff(back - 60_000, back + 30_000, ["https://api.github.test"]))?.origin, "https://api.anthropic.test");
      assert.equal(await passCutOff(back + 1, back + 30_000, ["https://api.github.test"]), null);
    },
  );
});

test("outageExit: locally the stage ends paused with the outage and writes nothing to GitHub; elsewhere it Blocks naming the host and since when", async () => {
  const e = new NetworkDown({ origin: "https://api.github.test", code: "EAI_AGAIN", since: Date.parse("2026-11-14T08:47:00Z") });
  for (const local of [true, false]) {
    const ends = [];
    const blocks = [];
    const records = [{ usd: 1.5 }];
    try {
      await outageExit(e, { local, records, finish: async (...a) => ends.push(a), block: async (r) => blocks.push(r) });
    } finally {
      resetNetwork();
    }
    assert.equal(ends.length, 1);
    const [exit, reason, outage] = ends[0];
    assert.deepEqual(outage, { host: "api.github.test", code: "EAI_AGAIN", since: "2026-11-14T08:47:00.000Z", origin: "https://api.github.test" });
    assert.match(reason, /^this machine could not reach api\.github\.test \(EAI_AGAIN\) from 2026-11-14T08:47:00\.000Z/);
    assert.deepEqual(records, [{ usd: 1.5 }], "no pass ran here: the caller's records stand");
    if (local) {
      assert.equal(exit, "paused");
      assert.deepEqual(blocks, [], "nothing written to GitHub");
    } else {
      assert.equal(exit, "blocked");
      assert.equal(blocks.length, 1);
      assert.match(blocks[0], /could not reach api\.github\.test \(EAI_AGAIN\) from 2026-11-14T08:47:00\.000Z.*the stage waited for the network until its time ran out/);
    }
  }
});

/** A fake codex: its first run loses its stream (a failed turn, exit 1), every later one completes; argv logged. */
function fakeCodex() {
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-outage-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "lost.jsonl"), `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"stream disconnected before completion: error sending request"}}\n`);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
if (n === 0) { process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "lost.jsonl"))}, "utf8")); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, "codex-0.167-thread.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { bin, calls };
}

test("runHarness: a pass this machine's network cut off is no death: once the provider answers it runs again from its session, its runs joined", async () => {
  const { bin, calls } = fakeCodex();
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  let probes = 0;
  try {
    await offline(
      (req) => (req.origin === "https://chatgpt.com" && ++probes < 3 ? Promise.reject(dns()) : new Response(null, { status: 200 })),
      async ({ lines }) => {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
        const c = calls();
        assert.equal(c.length, 2, "the cut-off pass, then its run after the network came back");
        assert.ok(c[1].args.includes("resume") && c[1].args.includes("00000000-0000-0000-0000-0000000000a1"), c[1].args.join(" "));
        assert.match(c[1].prompt, new RegExp(LOST_PASS_PROMPT.slice(0, 40)));
        assert.equal(rec.ok, true);
        assert.equal(crashed(rec), false);
        assert.equal(rec.lostToOutage, 1);
        assert.equal(rec.tokens.input, 16151, "both runs' tokens (the cut-off run reported none)");
        assert.equal(netLines(lines).length, 2);
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("runHarness: without the outage wait (a process that does not wait outages out) a failed pass is returned as it is", async () => {
  const { bin, calls } = fakeCodex();
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
    assert.equal(calls().length, 1);
    assert.equal(rec.ok, false);
  } finally {
    process.env.PATH = saved;
  }
});

test("outbox: a push while the remote's host does not answer waits for it and goes again, no try counted", async () => {
  const quiet = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const root = mkdtempSync(join(tmpdir(), "outbox-outage-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const run = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: { ...process.env, ...quiet } }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env: { ...process.env, ...quiet } });
  writeFileSync(join(work, "app.txt"), "v1\n");
  run(work, "add", "app.txt");
  run(work, "commit", "-q", "-m", "base");
  run(work, "push", "-q", "origin", "HEAD:main");
  run(work, "checkout", "-q", "-b", "factory/1");
  writeFileSync(join(work, "app.txt"), "v2\n");
  run(work, "commit", "-q", "-am", "work");
  let probes = 0;
  await offline(
    () => (++probes === 1 ? Promise.reject(dns()) : new Response(null, { status: 200 })),
    async ({ lines }) => {
      const box = await openOutbox({ branch: "factory/1", defaultBranch: "main", checkout: work, remote: origin, networkOrigin: "https://github.test", agentEnv: { ...process.env, ...quiet }, base: root });
      try {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        // Four dropped connections: one more than the client's three retries allow, unless the outage's own is no try.
        const drops = join(root, "drops");
        writeFileSync(drops, "x\n".repeat(4));
        writeFileSync(join(origin, "hooks", "pre-receive"), `#!/bin/sh\nif [ -s "${drops}" ]; then sed -i 1d "${drops}"; kill -9 $PPID; sleep 1; exit 1; fi\nexit 0\n`, { mode: 0o755 });
        assert.equal(await box.push(), true, box.error);
        assert.equal(run(origin, "rev-parse", "factory/1"), run(work, "rev-parse", "HEAD"));
        assert.equal(netLines(lines).length, 2);
      } finally {
        box.close();
      }
    },
  );
});

test("the work and review stages wait outages out and end on one through outageExit, before the crash Block; serve waits with no bound", () => {
  const SCRIPTS = join(import.meta.dirname, "..", "scripts");
  for (const file of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(SCRIPTS, file), "utf8");
    assert.match(src, /waitOutages\(\{ until: \(since\) => \(local \? Math\.min\(since \+ OUTAGE\.stageWaitMs, deadlineAt\) : deadlineAt\) \}\);/, `${file}: fifteen minutes locally, the deadline elsewhere`);
    assert.ok(src.indexOf("waitOutages(") < src.indexOf("await openAccess("), `${file}: before its first GitHub call`);
    const caught = src.indexOf("if (unreachable(e)) {");
    assert.ok(caught > 0 && caught < src.indexOf("crashed: ${e.message.slice(0, 300)}"), `${file}: the outage before the crash Block`);
    assert.match(src.slice(caught, caught + 600), /await outageExit\(e, \{\s+local,\s+records,\s+finish,/, `${file}: through outageExit`);
    assert.match(src.slice(caught, caught + 600), /cause: "outage"/, `${file}: an outage Block off the local route`);
  }
  const local = readFileSync(join(SCRIPTS, "local.mjs"), "utf8");
  assert.match(local.slice(local.indexOf("async serve(")), /^[\s\S]*?\n {4}waitOutages\(\);/, "serve: no bound");
});
