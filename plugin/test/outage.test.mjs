import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { logTime, whenText } from "../scripts/lib/clock.mjs";
import { RETRY, rest } from "../scripts/lib/github.mjs";
import { NetworkDown, OUTAGE, networkBack, passCutOff, resetNetwork, unreachable, waitOutages } from "../scripts/lib/network.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { outageExit, crashed } from "../scripts/lib/session.mjs";
import { parseUsage } from "../scripts/lib/usage.mjs";
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
  process.stdout.write = (chunk, ...more) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...more));
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

const netLines = (lines) => lines.filter((l) => /\[pendulum\] network: /.test(l));
const retryLines = (lines) => lines.filter((l) => /\[pendulum\] GitHub /.test(l));

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
      assert.match(net[1], /network: api\.github\.test answers again after 1 min \(unreachable since Nov 14, 8:47:00 AM UTC\)/);
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
      // ...as the outage it gave up on: its host and its first loss, whoever swallowed the wait's own error.
      await assert.rejects(rest("repos/o/r/issues/7/comments", { method: "POST", body: { body: "x" }, token: "t" }), (x) => x instanceof NetworkDown && x.since === start && x.origin === "https://api.github.test");
      assert.equal(seen.length - before, 1, "no retries once the stage stopped waiting");
    },
  );
});

test("passCutOff: a reported provider failure is a cut, the probe saying whether to wait; with no structured error only a provider that does not answer now is", async () => {
  let down = true;
  await offline(
    (req) => (req.origin === "https://api.anthropic.test" && down ? Promise.reject(dns()) : new Response(null, { status: 200 })),
    async ({ now }) => {
      waitOutages({ until: () => Infinity });
      const lost = { harness: "claude", status: null, type: "server_error", code: "connection_failed" };
      // No structured error and the provider does not answer a probe: cut off, waiting for it.
      assert.deepEqual(await passCutOff(null, "https://api.anthropic.test"), { origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: now(), ongoing: true });
      const start = now();
      const ep = networkBack("https://api.anthropic.test", "EAI_AGAIN");
      assert.deepEqual(await passCutOff(lost, "https://api.anthropic.test"), { origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: start, ongoing: true }, "the outage under way");
      down = false;
      await ep;
      // The provider answers again: its 5xx (or a connection the harness lost) runs the pass again at once; a pass with no
      // structured error failed on its own.
      assert.deepEqual(await passCutOff({ harness: "claude", status: 529, type: "server_error", code: null }, "https://api.anthropic.test"), { origin: "https://api.anthropic.test", code: "HTTP 529", since: now(), ongoing: false });
      assert.equal((await passCutOff(lost, "https://api.anthropic.test")).code, "connection_failed");
      assert.equal(await passCutOff(null, "https://api.anthropic.test"), null);
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
    assert.match(reason, /^this machine could not reach api\.github\.test \(EAI_AGAIN\) from Nov 14, 8:47 AM UTC/);
    assert.deepEqual(records, [{ usd: 1.5 }], "no pass ran here: the caller's records stand");
    if (local) {
      assert.equal(exit, "paused");
      assert.deepEqual(blocks, [], "nothing written to GitHub");
    } else {
      assert.equal(exit, "blocked");
      assert.equal(blocks.length, 1);
      assert.match(blocks[0], /could not reach api\.github\.test \(EAI_AGAIN\) from Nov 14, 8:47 AM UTC.*the stage waited for the network until its time ran out/);
    }
  }
});

// A Codex run whose turn failed on its provider failing, as a JSON error body with no status and the type
// `server_error` (its turn.failed message): the structure usage.mjs outageError reads. With a status it would be the
// provider busy instead (providerBusy).
const SERVER_DOWN = JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type: "server_error", code: null, message: "Service Unavailable" } }) } });
const LOST_RUN = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n${SERVER_DOWN}\n`;
// A run that did a turn's work (its usage reported) before its provider failed.
const SPENT_RUN = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":16151,"cached_input_tokens":12288,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}\n{"type":"turn.started"}\n${SERVER_DOWN}\n`;

/** A fake codex: its first `fail` runs print `lost` and exit 1, every later one completes; argv logged. */
function fakeCodex({ fail = 1, lost = LOST_RUN } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "pendulum-codex-outage-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "lost.jsonl"), lost);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
if (n < ${fail}) { process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "lost.jsonl"))}, "utf8")); process.exit(1); }
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
        const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
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
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
    assert.equal(calls().length, 1);
    assert.equal(rec.ok, false);
  } finally {
    process.env.PATH = saved;
  }
});

// Codex 0.167 against a provider answering 503: prose only (captured against a local fake server).
const PROSE_503 = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n{"type":"error","message":"unexpected status 503 Service Unavailable: Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses"}\n{"type":"turn.failed","error":{"message":"unexpected status 503 Service Unavailable: Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses"}}\n`;
// A structured 4xx that is neither a refusal nor busy: the provider's JSON body with a 409.
const LIMITED_RUN = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n${JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", error: { type: "conflict", code: null, message: "m" }, status: 409 }) } })}\n`;

// A bare body with no status and a type that names neither an outage nor the provider busy: a structured error that
// goes to the probe as a pass with no structure does.
const BARE_UNKNOWN = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n${JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ error: { type: "api_error", message: "m" } }) } })}\n`;
// The AI Gateway's bare body for an unavailable provider: its 5xx type with no status, the provider busy.
const BARE_503 = `{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000a1"}\n{"type":"turn.started"}\n${JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ error: { type: "service_unavailable_error", message: "m" } }) } })}\n`;

test("runHarness: a pass that ended on the gateway's bare service_unavailable_error (no status) is the provider busy: it waits the doubling and runs again, no probe", async () => {
  const { bin, calls } = fakeCodex({ lost: BARE_503 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    await offline(
      () => new Response(null, { status: 200 }),
      async ({ seen, waits }) => {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60 * 60_000, label: "work-1" });
        assert.equal(calls().length, 2, "the busy pass, then its run after the wait");
        assert.equal(rec.ok, true);
        assert.equal(rec.busyWaits, 1);
        assert.equal(rec.lostToOutage, undefined);
        assert.ok(waits.includes(OUTAGE.serverResumeMs), `waited the doubling's first minute: ${waits}`);
        assert.deepEqual(seen.filter((r) => r.probe), [], "no probe: the provider said it is busy");
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

for (const [what, lost, up] of [["printed its 503 as prose only", PROSE_503, false], ["printed its 503 as prose only", PROSE_503, true], ["ended on a bare error type with no status that names no outage", BARE_UNKNOWN, false], ["ended on a bare error type with no status that names no outage", BARE_UNKNOWN, true]]) {
  test(`runHarness: a pass whose harness ${what} is a cut exactly when its provider ${up ? "answers a probe: no, its failure stands" : "does not answer a probe: it runs again once the provider answers"}`, async () => {
    const { bin, calls } = fakeCodex({ lost });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    let probes = 0;
    try {
      await offline(
        (req) => (req.origin === "https://chatgpt.com" && !up && ++probes < 3 ? Promise.reject(dns()) : new Response(null, { status: 200 })),
        async ({ seen }) => {
          waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
          const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
          assert.ok(seen.some((r) => r.probe && r.origin === "https://chatgpt.com"), "the provider was probed");
          if (up) {
            assert.equal(calls().length, 1, "not run again");
            assert.equal(rec.ok, false);
            assert.equal(rec.lostToOutage, undefined);
          } else {
            assert.equal(calls().length, 2, "the cut-off pass, then its run after the provider answered");
            assert.ok(calls()[1].args.includes("resume"));
            assert.equal(rec.ok, true);
            assert.equal(rec.lostToOutage, 1);
          }
        },
      );
    } finally {
      process.env.PATH = saved;
    }
  });
}

test("passCutOff: a pass with no structured error is a cut when this process lost any host to its network while it ran, though every host answers now", async () => {
  let down = true;
  await offline(
    (req) => (req.origin === "https://api.github.test" && down ? Promise.reject(dns()) : new Response(null, { status: 200 })),
    async ({ now }) => {
      waitOutages({ until: () => Infinity });
      const before = now();
      const ep = networkBack("https://api.github.test", "EAI_AGAIN");
      down = false;
      await ep;
      const back = now();
      // GitHub lost for a few seconds while the pass ran: its outage, though over and short.
      assert.deepEqual(await passCutOff(null, "https://chatgpt.com", { startedMs: before - 60_000, endedMs: back + 1_000 }), { origin: "https://api.github.test", code: "EAI_AGAIN", since: before, ongoing: false });
      // One over before the pass began is no part of it; nor of a pass that reported its failure in structure.
      assert.equal(await passCutOff(null, "https://chatgpt.com", { startedMs: back + 1, endedMs: back + 60_000 }), null);
      assert.equal((await passCutOff({ harness: "codex", status: 503, type: "server_error", code: null }, "https://chatgpt.com", { startedMs: before - 60_000, endedMs: back + 1_000 })).origin, "https://chatgpt.com");
    },
  );
});

test("passCutOff: GitHub answering 5xx while a pass ran is no cut of it; its provider answering busy meanwhile is, another provider's is not", async () => {
  const net = await import("../scripts/lib/network.mjs");
  await offline(
    (req) => (req.origin === "https://api.github.test" && !req.probe ? json({ message: "Bad Gateway" }, 502) : new Response(null, { status: 200 })),
    async ({ now }) => {
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      const start = now();
      // GitHub answers 502 to every try of a request while the pass runs: GitHub failing, not this machine's network.
      const e = await rest("repos/o/r/issues/7", { token: "t" }).then(() => assert.fail("answered"), (x) => x);
      assert.match(String(e.code), /^HTTP 502$/);
      assert.equal(await passCutOff(null, "https://chatgpt.com", { startedMs: start, endedMs: now() + 1_000 }), null, "a GitHub 5xx is no cut of a Codex pass");
      // The pass's own provider answered another pass busy meanwhile: an outage of its host.
      net.noteBusy("https://api.anthropic.test", "HTTP 529", now());
      assert.equal(await passCutOff(null, "https://chatgpt.com", { startedMs: start, endedMs: now() + 1_000 }), null, "another provider's busy answer is none");
      net.noteBusy("https://chatgpt.com", "HTTP 429", now());
      assert.deepEqual(await passCutOff(null, "https://chatgpt.com", { startedMs: start, endedMs: now() + 1_000 }), { origin: "https://chatgpt.com", code: "HTTP 429", since: now(), ongoing: false });
    },
  );
});

test("runHarness: a pass that ended on a structured 4xx (a 409) is no cut, and nothing probes, though its provider does not answer", async () => {
  const { bin, calls } = fakeCodex({ lost: LIMITED_RUN });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    await offline(
      (req) => (req.origin === "https://chatgpt.com" ? Promise.reject(dns()) : new Response(null, { status: 200 })),
      async ({ seen, lines }) => {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
        assert.equal(calls().length, 1, "not run again");
        assert.equal(rec.ok, false);
        assert.equal(rec.lostToOutage, undefined);
        assert.deepEqual(seen.filter((r) => r.probe), [], "no probe: the harness said what ended it");
        assert.deepEqual(netLines(lines), []);
      },
    );
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
  run(work, "checkout", "-q", "-b", "pendulum/1");
  writeFileSync(join(work, "app.txt"), "v2\n");
  run(work, "commit", "-q", "-am", "work");
  let probes = 0;
  await offline(
    () => (++probes === 1 ? Promise.reject(dns()) : new Response(null, { status: 200 })),
    async ({ lines }) => {
      const box = await openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: work, remote: origin, networkOrigin: "https://github.test", agentEnv: { ...process.env, ...quiet }, base: root });
      try {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        // Four dropped connections: one more than the client's three retries allow, unless the outage's own is no try.
        const drops = join(root, "drops");
        writeFileSync(drops, "x\n".repeat(4));
        writeFileSync(join(origin, "hooks", "pre-receive"), `#!/bin/sh\nif [ -s "${drops}" ]; then sed -i 1d "${drops}"; kill -9 $PPID; sleep 1; exit 1; fi\nexit 0\n`, { mode: 0o755 });
        assert.equal(await box.push(), true, box.error);
        assert.equal(run(origin, "rev-parse", "pendulum/1"), run(work, "rev-parse", "HEAD"));
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
    assert.match(src.slice(caught, caught + 600), /block: (async )?\(reason, cause\) =>[\s\S]*?\bcause,/, `${file}: an External Block off the local route, its cause outageExit's`);
  }
  const local = readFileSync(join(SCRIPTS, "local.mjs"), "utf8");
  assert.match(local.slice(local.indexOf("async serve(")), /^[\s\S]*?\n {4}waitOutages\(\);/, "serve: no bound");
});

// --- #228 review: the real stage processes, against a GitHub API whose every connect is refused (ECONNREFUSED). ---

/**
 * A loopback port this file keeps bound for the stage's whole run, to an HTTP server that answers every request: no other
 * test's server can take it (a port closed and handed over could be), and an answer from it would fail the test. The
 * stage's preload refuses every connect to it the way undici does (`fetch failed`, cause ECONNREFUSED), so the outage
 * is the same on every run.
 */
async function heldPort() {
  const srv = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

/** The preload's refusal: every fetch to `origin` fails as a refused connect, before any byte leaves the process. */
const refuseOrigin = (origin) =>
  `const dead = ${JSON.stringify(origin)};\nconst real = globalThis.fetch;\nglobalThis.fetch = (input, init) => {\n  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);\n  if (url.origin !== dead) return real(input, init);\n  const cause = Object.assign(new Error(\`connect ECONNREFUSED \${url.host}\`), { code: "ECONNREFUSED", errno: -111, syscall: "connect" });\n  return Promise.reject(new TypeError("fetch failed", { cause }));\n};\n`;

/**
 * Run worker.mjs or review.mjs as its own process, local mode, against an unreachable API, with the stage's wait cut to
 * 1.5 s (a preload sets OUTAGE, the one module instance the script loads). Returns {code, out, result}.
 */
async function stageAgainstNothing(script, args, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "outage-stage-"));
  mkdirSync(join(root, "co"));
  const pre = join(root, "pre.mjs");
  const held = await heldPort();
  const origin = `http://127.0.0.1:${held.port}`;
  writeFileSync(pre, `import { OUTAGE } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", "network.mjs")).href)};\nOUTAGE.stageWaitMs = 1500;\nOUTAGE.probeMs = [100];\n${refuseOrigin(origin)}`);
  // Run as its own process while this one keeps the port's server answering (so an unrefused request would get an answer).
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(pre).href, join(import.meta.dirname, "..", "scripts", script), "--repo", "o/r", ...args, "--checkout", join(root, "co"), "--usage-dir", join(root, "u")], {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ, PENDULUM_LOCAL: "1", GITHUB_API_URL: origin, ...extraEnv },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => (clearTimeout(timer), done({ status, out })));
  }).finally(held.close);
  const file = join(root, "u", "result.json");
  return { code: r.status, out: r.out, result: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, origin };
}

test("worker.mjs, run for real: a stage whose first reads swallow the outage still ends paused on it, naming its host and its first loss", async () => {
  const { code, out, result, origin } = await stageAgainstNothing("worker.mjs", ["--issue", "7"], { PENDULUM_APP_TOKEN: "t" });
  assert.equal(code, 0, out);
  assert.equal(result?.exit, "paused", out);
  const first = /network: \S+ is unreachable from this machine \(ECONNREFUSED\)/.exec(out);
  assert.ok(first, out);
  const lostAt = /still unreachable after .* \(since ([^)]+)\)/.exec(out)[1];
  assert.deepEqual({ ...result.outage, since: logTime(result.outage.since) }, { host: new URL(origin).host, code: "ECONNREFUSED", since: lostAt, origin }, "the first loss, not the moment the stage ended");
  assert.match(result.outage.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "the record keeps its ISO time");
  assert.ok(!/crashed/.test(out), out);
});

test("review.mjs, run for real: an outage in its first reads (the token, the writers, the PR) ends it paused with its record, not exit 1", async () => {
  const { code, out, result, origin } = await stageAgainstNothing("review.mjs", ["--pr", "12"], { PENDULUM_APP_TOKEN: "t" });
  assert.equal(code, 0, out);
  assert.equal(result?.exit, "paused", out);
  assert.equal(result.outage.origin, origin);
});

test("worker.mjs, run for real: a token mint that cannot reach GitHub waits, then ends the stage paused on the outage", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { code, out, result, origin } = await stageAgainstNothing("worker.mjs", ["--issue", "7"], { PENDULUM_INPUT_APP_ID: "1", PENDULUM_INPUT_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }) });
  assert.equal(code, 0, out);
  assert.equal(result?.exit, "paused", out);
  assert.equal(result.outage.origin, origin);
  assert.equal(result.outage.code, "ECONNREFUSED");
});

test("runHarness: a pass that fails on its own after each outage runs again at most twice", async () => {
  const { bin, calls } = fakeCodex({ fail: Infinity });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  let probes = 0;
  try {
    await offline(
      // The provider fails every other probe: each failed run finds it down, then it answers.
      (req) => (req.origin === "https://chatgpt.com" && ++probes % 2 === 1 ? Promise.reject(dns()) : new Response(null, { status: 200 })),
      async () => {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
        assert.equal(calls().length, 1 + OUTAGE.passReruns, "the first run and two more, then its failure stands");
        assert.equal(rec.ok, false);
        assert.equal(rec.lostToOutage, OUTAGE.passReruns);
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("runHarness: a cut-off run that leaves no budget for another counts its spend once", async () => {
  const { bin, calls } = fakeCodex({ lost: SPENT_RUN });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  let probes = 0;
  try {
    await offline(
      (req) => (req.origin === "https://chatgpt.com" && ++probes < 2 ? Promise.reject(dns()) : new Response(null, { status: 200 })),
      async () => {
        waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
        const one = parseUsage("codex", SPENT_RUN, "gpt-6.1-sol", 1);
        assert.ok(one.usd > 0);
        const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: one.usd / 2, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
        assert.equal(calls().length, 1, "no budget left to run it again");
        assert.equal(rec.budgetExceeded, true);
        assert.equal(rec.usd, one.usd, "the run's dollars once");
        assert.equal(rec.tokens.input, one.tokens.input, "its tokens once");
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("rest: a host that comes and goes is one outage: its first loss and limit carried over, one lost line and one back line in all", async () => {
  let up = false;
  await offline(
    // Answers each probe, then drops again on the next request: a DNS that fails on and off.
    (req, seen) => {
      if (seen.length > 2000) throw new Error("a fresh wait per flap: it never ends");
      if (req.probe) {
        up = true;
        return new Response(null, { status: 200 });
      }
      if (up) {
        up = false;
        throw dns();
      }
      throw dns();
    },
    async ({ lines, now }) => {
      const start = now();
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      const e = await rest("repos/o/r/issues/1", { token: "t" }).then(() => assert.fail("answered"), (x) => x);
      assert.ok(e instanceof NetworkDown);
      assert.equal(e.since, start, "the first loss");
      assert.ok(now() - start <= OUTAGE.stageWaitMs + 60_000, "one limit, not a fresh one per flap");
      assert.equal(netLines(lines).length, 3, `lost, back once, given up: ${netLines(lines).join("")}`);
    },
  );
});

test("rest: a flap that then stays down past a minute is logged as its own loss, and its return too", async () => {
  // By the clock: down for the first 20 s, back, lost again at 65 s (a flap, 30 s after it answered), then down 6 h.
  const t0 = Date.parse("2026-11-14T08:47:00Z");
  await offline(
    (req, seen) => {
      if (seen.length > 5000) throw new Error("runaway");
      const t = RETRY.now() - t0;
      const up = (t >= 20_000 && t < 65_000) || t >= 65_000 + 6 * 60 * 60_000;
      if (req.probe) return up ? new Response(null, { status: 200 }) : Promise.reject(dns());
      if (!up) throw dns();
      return json({ ok: true });
    },
    async ({ lines }) => {
      waitOutages({ until: () => Infinity });
      assert.deepEqual(await rest("repos/o/r/issues/1", { token: "t" }), { ok: true });
      await RETRY.sleep(30_000);
      assert.deepEqual(await rest("repos/o/r/issues/2", { token: "t" }), { ok: true });
      const net = netLines(lines);
      assert.equal(net.length, 4, net.join(""));
      assert.match(net[1], /answers again after 35 s/);
      assert.match(net[2], /api\.github\.test is unreachable from this machine again \(EAI_AGAIN\) since Nov 14, 8:48:05 AM UTC; on and off since Nov 14, 8:47:00 AM UTC/);
      assert.match(net[3], /api\.github\.test answers again after 6 h \(unreachable since Nov 14, 8:48:05 AM UTC; on and off since Nov 14, 8:47:00 AM UTC\)/);
    },
  );
});

// --- #337: a Block that came from an outage, and a run the outage cut off, end the stage on the outage. ---

// Looked up at run time, so each test names what it needs.
const net = await import("../scripts/lib/network.mjs");
const sessionLib = await import("../scripts/lib/session.mjs");
const REPO = { owner: "o", name: "r", full: "o/r" };

const thrown = (fn) => {
  try {
    fn();
  } catch (x) {
    return x;
  }
  return null;
};

/** The stage gives up on GitHub: its fifteen minutes pass with every request and probe failing (the answer decides). */
async function giveUp() {
  waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
  const e = await rest("repos/o/r/issues/7", { token: "t" }).then(() => assert.fail("answered"), (x) => x);
  assert.ok(e instanceof NetworkDown, String(e));
  return e;
}

test("#337: the worker's split record, its write failed on the outage, ends the stage paused on that outage, not a pendulum Block", async () => {
  const { recordPart } = await import("../scripts/lib/handoff.mjs");
  let down = false;
  await offline(
    // The record is read; its write is the first request that cannot leave, and GitHub stays lost.
    (req) => (down || req.probe ? Promise.reject(dns()) : req.method === "POST" ? ((down = true), Promise.reject(dns())) : json([])),
    async ({ now }) => {
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      const lostAt = now();
      const decision = { exit: "delivered", reason: "" };
      // The worker's step, as worker.mjs runs it.
      await sessionLib.exitStep(decision, "the split record could not be written", () => recordPart(REPO, 7, 70, 2, { token: "t" }));
      assert.equal(decision.exit, "blocked");
      assert.equal(decision.cause, "pendulum");
      assert.match(decision.reason, /^the split record could not be written: api\.github\.test unreachable from this machine/);
      const end = thrown(() => sessionLib.outageFirst(decision));
      assert.ok(end instanceof NetworkDown, String(end));
      assert.deepEqual({ origin: end.origin, since: end.since, code: end.code }, { origin: "https://api.github.test", since: lostAt, code: "EAI_AGAIN" });
      const ends = [];
      const blocks = [];
      await outageExit(end, { local: true, records: [], finish: async (...a) => ends.push(a), block: async (r) => blocks.push(r) });
      assert.equal(ends[0][0], "paused");
      assert.equal(ends[0][2].since, new Date(lostAt).toISOString(), "named from its first loss");
      assert.deepEqual(blocks, [], "nothing written to GitHub");
    },
  );
});

test("#337: host back after the stage gave up: a real Block stays a Block, a step GitHub answered is no outage, and the harness is asked for its record", async () => {
  const { bin, calls } = fakeCodex({ fail: 0 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  let down = true;
  try {
    await offline(
      (req) => (down ? Promise.reject(dns()) : req.probe ? new Response(null, { status: 200 }) : json({ message: "Validation Failed" }, 422)),
      async () => {
        await giveUp();
        down = false;
        assert.equal(await net.givenUp(), null, "a host that answers again stops counting");
        // Blocks no outage caused: protected paths, the dollar cap, validation.
        for (const reason of ["protected paths touched: .github/workflows/ci.yml", "dollar cap reached", "validation red after 2 passes"]) assert.equal(thrown(() => sessionLib.outageFirst({ exit: "blocked", reason, cause: "work" })), null, reason);
        // A step GitHub answered with a refusal: a pendulum Block that stands.
        const decision = { exit: "delivered", reason: "" };
        await sessionLib.exitStep(decision, "the review label could not be applied", () => rest("repos/o/r/issues/70/labels", { method: "POST", body: { labels: ["x"] }, token: "t" }));
        assert.equal(decision.exit, "blocked");
        assert.equal(decision.outage, null);
        assert.equal(thrown(() => sessionLib.outageFirst(decision)), null);
        // No exit record: the harness is asked, as ever.
        const asked = await sessionLib.exitRecord({ text: undefined, harness: "codex", model: "gpt-6.1-sol", session: { id: null, canResume: false }, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, eventsFile: join(bin, "events.jsonl"), deadlineAt: Date.now() + 60 * 60_000, maxUsd: 0 });
        assert.equal(calls().length, 1, "asked once");
        assert.equal(asked.record.exit, "blocked");
        // An exit record the harness wrote stands.
        const written = await sessionLib.exitRecord({ text: JSON.stringify({ exit: "blocked", reason: "the issue asks for two repositories" }), harness: "codex", model: "gpt-6.1-sol", deadlineAt: Date.now() + 60 * 60_000, maxUsd: 0 });
        assert.equal(written.record.reason, "the issue asks for two repositories");
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("#337: with no exit record while the host the stage gave up on still does not answer, the harness is not asked; the stage ends on the outage", async () => {
  const { bin } = fakeCodex({ fail: 0 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    await offline(
      () => Promise.reject(dns()),
      async () => {
        const lost = await giveUp();
        const asked = sessionLib.exitRecord({ text: undefined, harness: "codex", model: "gpt-6.1-sol", session: { id: null, canResume: false }, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, eventsFile: join(bin, "events.jsonl"), deadlineAt: Date.now() + 60 * 60_000, maxUsd: 0 });
        await assert.rejects(asked, (x) => x instanceof NetworkDown && x.since === lost.since && x.origin === lost.origin);
        assert.equal(existsSync(join(bin, "calls.jsonl")), false, "no harness call");
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("#337: a pass that fails while the host the stage gave up on still does not answer is no death and runs no more: it ends the stage on the outage", async () => {
  const { bin, calls } = fakeCodex({ fail: Infinity });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    await offline(
      () => Promise.reject(dns()),
      async () => {
        const lost = await giveUp();
        assert.equal(net.stoppedWaiting(), true);
        const pass = runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "the task", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "work-1" });
        await assert.rejects(pass, (x) => x instanceof NetworkDown && x.since === lost.since && x.origin === lost.origin);
        assert.equal(calls().length, 1, "the pass ran once and was not run again");
      },
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("#337: only GitHub's core REST quota spent is an outage of a write: a spent GraphQL or search quota leaves a Block to stand", async () => {
  await offline(
    () => Promise.reject(dns()),
    async ({ now }) => {
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      const resetAt = now() + 60 * 60_000;
      const spent = (url) => () => networkBack("https://api.github.test", net.RATE_LIMIT_SPENT, { resetAt, key: net.quotaKey(url, "t") });
      for (const url of ["https://api.github.test/graphql", "https://api.github.test/search/issues"]) {
        const decision = { exit: "delivered", reason: "" };
        await sessionLib.exitStep(decision, "a read", spent(url));
        assert.equal(decision.exit, "blocked", url);
        assert.equal(decision.outage, null, url);
        assert.equal(thrown(() => sessionLib.outageFirst(decision)), null, url);
      }
      const decision = { exit: "delivered", reason: "" };
      await sessionLib.exitStep(decision, "the review label could not be applied", spent("https://api.github.test/repos/o/r/issues/70/labels"));
      const end = thrown(() => sessionLib.outageFirst(decision));
      assert.equal(end?.resetAt, resetAt, "the core quota: the stage ends on it, until its reset");
      assert.equal(net.stoppedWaiting(), false, "the stage still waits for its other hosts and quotas");
    },
  );
});

// --- #353: GitHub answering 5xx past the client's retries is an outage of GitHub, not a crash. ---

test("#353: a label write GitHub answers 500 on every try ends the stage on GitHub's outage (paused locally, an outage Block elsewhere); a 422 stays a pendulum Block", async () => {
  await offline(
    (req) => (req.probe ? assert.fail("no probe: GitHub answered") : req.path.endsWith("/issues/70/labels") ? json({ message: "Server Error" }, 500) : json({ message: "Validation Failed" }, 422)),
    async ({ seen, now }) => {
      waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
      const first = now();
      const decision = { exit: "delivered", reason: "" };
      await sessionLib.exitStep(decision, "the review label could not be applied", () => rest("repos/o/r/issues/70/labels", { method: "POST", body: { labels: ["pendulum:in-review"] }, token: "t" }));
      assert.equal(seen.length, RETRY.tries, "every try sent");
      assert.equal(decision.exit, "blocked");
      const end = thrown(() => sessionLib.outageFirst(decision));
      assert.ok(end && unreachable(end), String(end));
      assert.deepEqual({ status: end.status, origin: end.origin, code: end.code, since: end.since, endpoint: end.endpoint }, { status: 500, origin: "https://api.github.test", code: "HTTP 500", since: first, endpoint: "POST repos/o/r/issues/70/labels" });
      const ends = [];
      const blocks = [];
      await outageExit(end, { local: true, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a) });
      assert.equal(ends[0][0], "paused");
      assert.match(ends[0][1], /^api\.github\.test answered HTTP 500 to every try of POST repos\/o\/r\/issues\/70\/labels from Nov 14, 8:47 AM UTC/);
      assert.deepEqual(ends[0][2], { host: "api.github.test", code: "HTTP 500", since: new Date(first).toISOString(), origin: "https://api.github.test", endpoint: "POST repos/o/r/issues/70/labels" });
      assert.deepEqual(blocks, [], "nothing written to GitHub");
      await outageExit(end, { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a) });
      assert.equal(ends[1][0], "blocked");
      assert.equal(blocks[0][1], "outage", "an External outage Block, which the dispatcher relaunches");
      assert.match(blocks[0][0], /answered HTTP 500 to every try .*; the stage ended on it\. /);
      // A refusal is GitHub's answer to the request itself: no retry, no outage, the Block stands.
      const refused = { exit: "delivered", reason: "" };
      await sessionLib.exitStep(refused, "the review label could not be applied", () => rest("repos/o/r/issues/71/labels", { method: "POST", body: { labels: ["x"] }, token: "t" }));
      assert.equal(refused.exit, "blocked");
      assert.equal(refused.outage, null);
      assert.equal(thrown(() => sessionLib.outageFirst(refused)), null);
    },
  );
});

/**
 * Run worker.mjs as its own process, local mode, against a GitHub API that answers `status` to every request, the
 * client's backoff cut to milliseconds (a preload sets RETRY). Returns {code, out, result}.
 */
async function stageAgainstStatus(script, args, status, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "outage-5xx-"));
  mkdirSync(join(root, "co"));
  const srv = createServer((req, res) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ message: "Server Error" })));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const pre = join(root, "pre.mjs");
  writeFileSync(pre, `import { RETRY } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", "github.mjs")).href)};\nRETRY.baseMs = 5;\n`);
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(pre).href, join(import.meta.dirname, "..", "scripts", script), "--repo", "o/r", ...args, "--checkout", join(root, "co"), "--usage-dir", join(root, "u")], {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, PENDULUM_LOCAL: "1", GITHUB_API_URL: origin, GITHUB_GRAPHQL_URL: `${origin}/graphql`, ...extraEnv },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => (clearTimeout(timer), done({ code, out })));
  }).finally(() => new Promise((r) => srv.close(r)));
  const file = join(root, "u", "result.json");
  return { code: r.code, out: r.out, result: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, origin };
}

test("#353, worker.mjs run for real: GitHub answering 500 past the retries ends the stage paused on it, naming the status, not a crash Block", async () => {
  const { code, out, result, origin } = await stageAgainstStatus("worker.mjs", ["--issue", "7"], 500, { PENDULUM_APP_TOKEN: "t" });
  assert.equal(code, 0, out);
  assert.equal(result?.exit, "paused", out);
  assert.equal(result.outage.origin, origin);
  assert.equal(result.outage.code, "HTTP 500");
  assert.match(result.reason, /answered HTTP 500 to every try/);
  assert.ok(!/crashed/.test(out), out);
});
