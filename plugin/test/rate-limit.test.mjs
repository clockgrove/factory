// #250: GitHub's primary rate limit spent is an outage of the API host whose end GitHub states (lib/network.mjs). A stage
// and serve wait for its reset, one sleep for all callers and nothing sent meanwhile; a stage whose reset is past its
// in-place bound ends at once (paused locally, a `provider-quota` Block elsewhere). Every other process fails fast with
// the error's code. A secondary limit keeps the client's own retries.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { RETRY, rest } from "../scripts/lib/github.mjs";
import { OUTAGE, RATE_LIMIT_SPENT, quotaKey, resetNetwork, spentUntil, waitOutages } from "../scripts/lib/network.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
/** The REST quota running out mid-tick: from the read of today's local spend on, every REST read is refused. */
const restRunsOut = () => {
  let out = false;
  return (req) => (out ||= req.path.endsWith("/issues/comments")) && !req.path.endsWith("/graphql");
};
const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
/** GitHub's answer for a spent primary limit, reset at `resetMs`. */
const spentHeaders = (resetMs) => ({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(resetMs / 1000)), "x-ratelimit-resource": "core" });
const spent = (resetMs, status = 403) => json({ message: "API rate limit exceeded for user ID 1." }, status, spentHeaders(resetMs));

/**
 * Both clocks faked (the client's retries, the network waits). A sleep is held until `release()` moves `now` past it, so
 * a test can send more requests while one waits. `fetch` is `answer(req)` with req {method, path, at}; every request is
 * in `seen`. Log lines are in `lines`.
 */
async function faked(answer, fn, { token = false } = {}) {
  const saved = { fetch: globalThis.fetch, api: process.env.GITHUB_API_URL, graphqlUrl: process.env.GITHUB_GRAPHQL_URL, retry: { sleep: RETRY.sleep, now: RETRY.now, random: RETRY.random }, outage: { sleep: OUTAGE.sleep, now: OUTAGE.now, random: OUTAGE.random } };
  // Both: a runner sets GITHUB_GRAPHQL_URL to GitHub's own, which GraphQL calls would otherwise reach.
  process.env.GITHUB_API_URL = "https://api.github.test";
  process.env.GITHUB_GRAPHQL_URL = "https://api.github.test/graphql";
  let t = Date.parse("2026-11-14T08:47:00Z");
  const held = [];
  const sleep = (ms) => new Promise((resolve) => held.push({ ms, resolve }));
  const release = async () => {
    await new Promise((r) => setImmediate(r));
    const next = held.shift();
    if (!next) return null;
    t += Math.max(0, next.ms);
    next.resolve();
    await new Promise((r) => setImmediate(r));
    return next.ms;
  };
  Object.assign(RETRY, { sleep, now: () => t, random: () => 0.5 });
  Object.assign(OUTAGE, { sleep, now: () => t, random: () => 0.5 });
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const req = { method: init.method || "GET", path: u.pathname, at: t, ...(token ? { token: init.headers?.Authorization } : {}) };
    seen.push(req);
    return answer(req, t);
  };
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...more) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...more));
  try {
    return await fn({ seen, lines, held, release, now: () => t });
  } finally {
    process.stdout.write = write;
    resetNetwork();
    globalThis.fetch = saved.fetch;
    Object.assign(RETRY, saved.retry);
    Object.assign(OUTAGE, saved.outage);
    for (const [k, v] of [["GITHUB_API_URL", saved.api], ["GITHUB_GRAPHQL_URL", saved.graphqlUrl]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const limitLines = (lines) => lines.filter((l) => /\[factory\] network: GitHub's \S+ API rate limit/.test(l));
const retryLines = (lines) => lines.filter((l) => /\[factory\] GitHub /.test(l));

test("a waiting process: a spent primary limit waits to its reset for all callers, nothing sent meanwhile, a create sent again; one line in, one out", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  const reset = start + 20 * 60_000;
  await faked(
    (req, t) => (t < reset ? spent(reset) : json(req.method === "POST" ? { id: 9 } : { ok: req.path })),
    async ({ seen, lines, held, release, now }) => {
      waitOutages();
      const first = rest("repos/o/r/issues/7");
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(held.length, 1, "one sleep, to the reset");
      // Callers that come while it waits, a create among them: not sent.
      const later = [rest("repos/o/r/pulls?state=open&head=o:factory/7"), rest("repos/o/r/issues/7/comments", { method: "POST", body: { body: "progress" } })];
      await new Promise((r) => setImmediate(r));
      assert.equal(seen.length, 1, "no request goes to GitHub while the limit is spent");
      assert.equal(held.length, 1, "the later callers wait on the same sleep");
      const slept = await release();
      assert.ok(slept >= reset - start && slept <= reset - start + OUTAGE.quotaJitterMs, `the reset plus a little jitter: ${slept}`);
      assert.deepEqual(await Promise.all([first, ...later]), [{ ok: "/repos/o/r/issues/7" }, { ok: "/repos/o/r/pulls" }, { id: 9 }]);
      assert.ok(seen.slice(1).every((r) => r.at >= reset), "every later request after the reset");
      assert.equal(seen.filter((r) => r.method === "POST").length, 1, "the create once");
      assert.equal(limitLines(lines).length, 2, lines.join(""));
      assert.match(limitLines(lines)[0], /rate limit on api\.github\.test is spent until 2026-11-14T09:07:00\.000Z; no request goes against it until then/);
      assert.match(limitLines(lines)[1], /has reset; requests go again after 20 min/);
      assert.deepEqual(retryLines(lines), [], "no try spent on it");
      assert.ok(now() >= reset);

      // A secondary limit in the same process keeps the client's retries: GitHub's Retry-After, no wait for a reset.
      let n = 0;
      globalThis.fetch = async (url, init = {}) => {
        seen.push({ method: init.method || "GET", path: new URL(url).pathname, at: now() });
        n += 1;
        return n === 1 ? json({ message: "You have exceeded a secondary rate limit." }, 403, { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil((now() + 50 * 60_000) / 1000)) }) : json({ ok: 1 });
      };
      const sec = rest("repos/o/r/issues/8");
      const secSlept = await release();
      assert.deepEqual(await sec, { ok: 1 });
      assert.ok(secSlept >= 60_000 && secSlept < 90_000, `Retry-After, spread upward: ${secSlept}`);
      assert.equal(retryLines(lines).length, 1);
      assert.match(retryLines(lines)[0], /GitHub GET repos\/o\/r\/issues\/8: rate limited \(HTTP 403\); try 2 of 4/);
      assert.equal(limitLines(lines).length, 2, "no rate-limit wait for a secondary limit");
    },
  );
});

test("a process that does not wait (dispatcher, doctor, setup, launcher) fails fast on a spent limit, with the code and the reset; a near reset keeps the client's retry", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  await faked(
    (req, t) => (req.path.endsWith("/far") ? spent(start + 20 * 60_000, 429) : req.path.endsWith("/sooner") ? spent(start + 10 * 60_000) : t < start + 30_000 ? spent(start + 30_000) : json({ ok: 1 })),
    async ({ seen, lines, held, release }) => {
      const core = quotaKey("https://api.github.test/repos", "t");
      const e = await rest("repos/o/r/far", { token: "t" }).then(() => null, (x) => x);
      assert.equal(e?.code, RATE_LIMIT_SPENT, String(e));
      assert.equal(e.status, 429);
      assert.equal(e.rateLimited, true);
      assert.equal(e.resetAt, start + 20 * 60_000);
      assert.equal(held.length, 0, "no wait");
      assert.equal(seen.length, 1, "one request");
      assert.equal(spentUntil(core), start + 20 * 60_000, "the process's record of it");
      assert.deepEqual(limitLines(lines), []);
      // Its latest answer sets the record, an earlier reset included.
      await rest("repos/o/r/sooner", { token: "t" }).catch(() => {});
      assert.equal(spentUntil(core), start + 10 * 60_000, "the latest answer's reset");
      // A reset inside the client's 90 s bound: its own retry, as before; the answer clears the record.
      const near = rest("repos/o/r/near", { token: "t" });
      const slept = await release();
      assert.deepEqual(await near, { ok: 1 });
      assert.ok(slept >= 30_000 && slept < 45_000, String(slept));
      assert.match(retryLines(lines).at(-1), /rate limited \(HTTP 403\); try 2 of 4/);
      assert.equal(spentUntil(core), null, "an answer clears it");
    },
  );
});

/** A fake GitHub on a port. `answer(req, body)` returns [status, body, headers] or null for the default (an empty list, else {}). */
async function fakeGitHub(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { method: req.method, url: req.url, body };
      seen.push(r);
      const [status, data, headers] = answer(r) || [200, req.method === "GET" && /per_page=/.test(req.url) ? [] : { id: 1, user: { login: "me", type: "User" }, body: "" }, {}];
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const ISSUE = { number: 7, state: "open", labels: [{ name: "factory:objective" }], body: "" };

/**
 * Run worker.mjs as its own process against `gh`. `virtual`: a preload makes the network waits and the client's retries
 * pass at once on a clock of their own (so a 20-minute reset takes no time), the one module instance the script loads.
 */
async function worker(gh, { env = {}, virtual = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rate-limit-"));
  mkdirSync(join(root, "co"));
  const pre = join(root, "pre.mjs");
  writeFileSync(pre, `import { OUTAGE } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib", "network.mjs")).href)};\nimport { RETRY } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib", "github.mjs")).href)};\n${virtual ? "let ahead = 0;\nOUTAGE.now = RETRY.now = () => Date.now() + ahead;\nOUTAGE.sleep = RETRY.sleep = async (ms) => { ahead += Math.max(0, ms); };\n" : ""}`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(pre).href, join(SCRIPTS, "worker.mjs"), "--repo", "o/r", "--issue", "7", "--checkout", join(root, "co"), "--usage-dir", join(root, "u")], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, FACTORY_APP_TOKEN: "t", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise((r) => child.on("exit", r));
  const file = join(root, "u", "result.json");
  return { code, out, result: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
}

test("worker.mjs, run for real on the local route: a reset 20 minutes ahead (past its 15-minute wait) ends it paused with the reset, nothing sent after", async () => {
  const reset = Math.ceil((Date.now() + 20 * 60_000) / 1000) * 1000;
  // The quota stays spent: every request is refused.
  const gh = await fakeGitHub(() => [403, { message: "API rate limit exceeded for user ID 1." }, spentHeaders(reset)]);
  try {
    const { code, out, result } = await worker(gh, { env: { FACTORY_LOCAL: "1" } });
    assert.equal(code, 0, out);
    assert.equal(result?.exit, "paused", out);
    assert.equal(result.outage.code, RATE_LIMIT_SPENT);
    // On this machine's clock, through the answer's Date (whole seconds): at most a second after the stated reset.
    const at = Date.parse(result.outage.reset);
    assert.ok(at >= reset && at < reset + 1500, `serve resumes it after this: ${result.outage.reset}`);
    assert.equal(result.outage.quota, "core");
    assert.equal(result.outage.origin, gh.url);
    assert.ok(result.reason.startsWith(`GitHub's core API rate limit on 127.0.0.1:`) && result.reason.includes(`is spent until ${result.outage.reset}`), result.reason);
    assert.match(out, /past this process's wait \(until .*\); no longer waiting for it/);
    assert.match(out, /paused: .*serve resumes the stage after the reset/);
    assert.doesNotMatch(out, /crashed/);
    // Only the requests already in flight when the first refusal came: nothing after the stage stopped waiting.
    assert.ok(gh.seen.length <= 3, gh.seen.map((r) => `${r.method} ${r.url}`).join("\n"));
    assert.ok(!gh.seen.some((r) => r.method !== "GET" && !r.url.endsWith("/graphql")), `no write: the pause writes nothing to GitHub\n${gh.seen.map((r) => `${r.method} ${r.url}`).join("\n")}`);
  } finally {
    gh.close();
  }
});

test("worker.mjs, run for real off the local route: a reset 20 minutes ahead is waited for (one wait), then the stage goes on", async () => {
  const reset = Math.ceil((Date.now() + 20 * 60_000) / 1000) * 1000;
  let refused = 0;
  const gh = await fakeGitHub((r) => {
    if (r.method === "GET" && /\/issues\/7$/.test(r.url)) {
      // The first read of the issue meets the spent quota; it has reset by the time the stage sends it again.
      if (refused === 0) return (refused += 1), [403, { message: "API rate limit exceeded for user ID 1." }, spentHeaders(reset)];
      return [200, ISSUE, {}];
    }
    if (r.method === "GET" && /\/user$/.test(r.url)) return [200, { login: "me", type: "User" }, {}];
    return null;
  });
  try {
    const { out, result } = await worker(gh, { virtual: true });
    assert.equal(refused, 1);
    assert.match(out, /network: GitHub's core API rate limit on \S+ is spent until \S+; no request goes against it until then/);
    assert.match(out, /network: GitHub's core API rate limit on \S+ has reset; requests go again after 20 min/);
    assert.equal(gh.seen.filter((r) => /\/issues\/7$/.test(r.url)).length >= 2, true, "the issue read again after the reset");
    // The stage went on to its own end (the fake names no author: its own Block), not a crash or a rate-limit end.
    assert.ok(result, out);
    assert.doesNotMatch(String(result.reason), /crashed|rate limit/, out);
    assert.doesNotMatch(out, /worker crashed/);
    assert.ok(!result.outage, "no outage end");
  } finally {
    gh.close();
  }
});

test("worker.mjs, run for real off the local route: a reset past the stage's deadline Blocks it with provider-quota, naming the reset, written after it", async () => {
  // The deadline: five minutes (timeout_minutes 5, the floor). The reset: fourteen minutes ahead, inside the job's reserve
  // after the deadline.
  const reset = Math.ceil((Date.now() + 14 * 60_000) / 1000) * 1000;
  let refused = 0;
  const gh = await fakeGitHub((r) => {
    if (r.method === "GET" && /\/issues\/7$/.test(r.url) && refused === 0) return (refused += 1), [403, { message: "API rate limit exceeded for user ID 1." }, spentHeaders(reset)];
    if (r.method === "GET" && /\/issues\/7$/.test(r.url)) return [200, ISSUE, {}];
    if (r.method === "GET" && /\/user$/.test(r.url)) return [200, { login: "me", type: "User" }, {}];
    return null;
  });
  try {
    const { out, result } = await worker(gh, { virtual: true, env: { FACTORY_INPUT_TIMEOUT_MINUTES: "5" } });
    assert.equal(result?.exit, "blocked", out);
    assert.ok(Math.abs(Date.parse(result.outage.reset) - reset) < 1500, result.outage.reset);
    assert.match(out, /waiting for the rate limit's reset at \S+ to write the Block/);
    const notice = gh.seen.find((r) => r.method === "POST" && /\/issues\/7\/comments$/.test(r.url) && r.body.includes("factory:block"));
    assert.ok(notice, `${out}\n${gh.seen.map((r) => `${r.method} ${r.url} ${r.body.slice(0, 200)}`).join("\n")}`);
    assert.match(JSON.parse(notice.body).body, /<!-- factory:block \{"cause":"provider-quota"\} -->/);
    assert.ok(JSON.parse(notice.body).body.includes(`is spent until ${result.outage.reset}`), notice.body);
    assert.doesNotMatch(out, /worker crashed/);
  } finally {
    gh.close();
  }
});

test("dispatch.mjs, run for real: a spent limit starts nothing, says so once, and is no failure", async () => {
  const reset = Math.ceil((Date.now() + 20 * 60_000) / 1000) * 1000;
  const gh = await fakeGitHub(() => [403, { message: "API rate limit exceeded for user ID 1." }, spentHeaders(reset)]);
  const root = mkdtempSync(join(tmpdir(), "rate-limit-dispatch-"));
  const output = join(root, "out");
  writeFileSync(output, "");
  try {
    const child = spawn(process.execPath, [join(SCRIPTS, "dispatch.mjs"), "--repo", "o/r"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, FACTORY_APP_TOKEN: "t", GITHUB_OUTPUT: output }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, out);
    const said = out.split("\n").filter((l) => /^\[factory\] GitHub's API rate limit is spent until \S+; no new stage starts until then$/.test(l));
    assert.equal(said.length, 1, out);
    assert.ok(Math.abs(Date.parse(/until (\S+);/.exec(said[0])[1]) - reset) < 1500, said[0]);
    assert.doesNotMatch(out, /dispatch failed/);
    const outputs = readFileSync(output, "utf8");
    assert.match(outputs, /^count=0$/m, outputs);
    assert.match(outputs, /^issues=\[\]$/m, outputs);
    // A wake a minute after the reset dispatches again (a `retry` wake, armed on private repositories too).
    assert.match(outputs, /^wake_kind=retry$/m, outputs);
    const wake = Date.parse(/^wake_at=(\S+)$/m.exec(outputs)?.[1]);
    assert.ok(wake >= reset + 60_000 && wake < reset + 61_500, outputs);
  } finally {
    gh.close();
  }
});

/** One dispatcher tick in this process over one queued Objective (#5); `spentOn(req)` says which reads meet a spent quota. */
async function tickWith(spentOn) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const start = Date.parse("2026-11-14T08:47:00Z");
  const queued = { number: 5, state: "open", labels: [{ name: "factory:objective" }], body: "", updated_at: new Date(start).toISOString(), user: { login: "maintainer" } };
  return faked(
    (req) => {
      if (spentOn(req)) return spent(start + 20 * 60_000);
      if (req.path.endsWith("/graphql")) return json({ data: {} });
      if (req.method === "GET" && req.path === "/repos/acme/app/issues") return json([queued]);
      if (req.method === "GET" && req.path.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (req.method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(req.path)) return json({ workflow_runs: [] });
      if (req.method === "GET" && (/\/comments$/.test(req.path) || /\/timeline$/.test(req.path) || /\/pulls$/.test(req.path))) return json([]);
      if (req.method === "GET" && req.path.endsWith("/user")) return json({ login: "maintainer", type: "User" });
      return json({ message: "Not Found" }, 404);
    },
    async ({ lines, seen }) => ({ r: await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t", dryRun: true }), lines, seen }),
  );
}

test("dispatch: a tick that met its token's REST quota spent in a read it went on without starts nothing; a GraphQL-only limit holds nothing", async () => {
  const graphqlOnly = await tickWith((req) => req.path.endsWith("/graphql"));
  assert.deepEqual(graphqlOnly.r.ready, [5], graphqlOnly.lines.join(""));
  const restOut = await tickWith(restRunsOut());
  assert.deepEqual(restOut.r.ready, [], restOut.lines.join(""));
  assert.match(restOut.r.reason, /^GitHub's API rate limit is spent until 2026-11-14T09:07:00\.000Z; no new stage starts until then$/);
  assert.deepEqual(restOut.r.skipped.find((s) => s.number === 5)?.reason, restOut.r.reason);
  assert.equal(restOut.lines.filter((l) => l.includes("no new stage starts until then")).length, 1);
});

/** Release held sleeps until `p` settles (at most `max`); returns the sleeps taken. */
async function settle(p, release, max = 40) {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  const slept = [];
  for (let i = 0; i < max && !done; i += 1) {
    const ms = await release();
    if (ms !== null) slept.push(ms);
  }
  await p;
  return slept;
}

test("quotas apart: a spent GraphQL quota holds no REST call, and another token's quota is its own", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  const reset = start + 20 * 60_000;
  await faked(
    (req, t) => (req.path.endsWith("/graphql") && req.token === "Bearer t" && t < reset ? spent(reset) : json(req.path.endsWith("/graphql") ? { data: { ok: req.token } } : { ok: 1 })),
    async ({ seen, held, release, lines }) => {
      const { graphql } = await import("../scripts/lib/github.mjs");
      waitOutages({ until: () => Infinity });
      const q = graphql("query { viewer { login } }", {}, { token: "t" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(held.length, 1, "the GraphQL call waits for its reset");
      // REST on the same token, and GraphQL on another token, go at once.
      assert.deepEqual(await rest("repos/o/r/issues/7", { token: "t" }), { ok: 1 });
      assert.deepEqual(await graphql("query { viewer { login } }", {}, { token: "u" }), { ok: "Bearer u" });
      assert.equal(held.length, 1);
      assert.match(limitLines(lines)[0], /GitHub's graphql API rate limit on api\.github\.test is spent until/);
      await settle(q, release);
      assert.deepEqual(await q, { ok: "Bearer t" });
      assert.equal(seen.filter((r) => r.token === "Bearer t" && r.path.endsWith("/graphql")).length, 2);
    },
    { token: true },
  );
});

test("a quota drained again soon after its reset, until a later reset, is a new wait with its own two lines", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  const first = start + 20 * 60_000;
  let second = null;
  await faked(
    (req, t) => {
      if (t < first) return spent(first);
      // Just after the reset, another tool on the account spends it again: reset in fifty minutes.
      second ??= t + 50 * 60_000;
      return t < second ? spent(second) : json({ ok: 1 });
    },
    async ({ release, lines }) => {
      waitOutages();
      const p = rest("repos/o/r/issues/7", { token: "t" });
      await settle(p, release);
      assert.equal(limitLines(lines).length, 4, lines.join(""));
      assert.match(limitLines(lines)[2], /is spent until 2026-11-14T09:57:\d\d\.000Z; no request goes against it until then \(50 min\)/);
    },
  );
});

test("a clock ahead of GitHub's: the reset is read through the answer's Date, so the wait sends no request into the limit; a refusal after the stated reset backs off", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  // GitHub's clock is 30 s behind this machine's; its reset is 20 minutes after its own now.
  const skew = 30_000;
  const reset = start - skew + 20 * 60_000;
  await faked(
    (req, t) => (t - skew < reset ? json({ message: "API rate limit exceeded for user ID 1." }, 403, { ...spentHeaders(reset), date: new Date(t - skew).toUTCString() }) : json({ ok: 1 })),
    async ({ seen, release }) => {
      waitOutages();
      const p = rest("repos/o/r/issues/7", { token: "t" });
      const slept = await settle(p, release);
      assert.equal(seen.length, 2, `one refusal, then the answer: ${slept}`);
      assert.equal(slept.length, 1);
    },
  );
  // No Date to go by, and refused after the stated reset has passed here: 5, 10, 20, 40 s (plus the jitter), not a
  // request every few seconds.
  let refusals = 0;
  await faked(
    (req, t) => (refusals < 4 ? ((refusals += 1), spent(t - 60_000)) : json({ ok: 1 })),
    async ({ release }) => {
      waitOutages();
      const slept = await settle(rest("repos/o/r/issues/7", { token: "t" }), release);
      assert.deepEqual(slept, [5_000, 10_000, 20_000, 40_000].map((ms) => ms + 5_500));
    },
  );
});

test("a 403 on the last quota point that is no primary limit (no access, abuse detection) carries no RATE_LIMIT_SPENT", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  await faked(
    (req) => json({ message: req.path.endsWith("/denied") ? "Resource not accessible by integration" : "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again." }, 403, spentHeaders(start + 20 * 60_000)),
    async () => {
      const denied = await rest("repos/o/r/denied", { token: "t" }).then(() => null, (x) => x);
      assert.equal(denied?.status, 403);
      assert.notEqual(denied.code, RATE_LIMIT_SPENT);
      const abuse = await rest("repos/o/r/abuse", { token: "t" }).then(() => null, (x) => x);
      assert.equal(abuse?.rateLimited, true, "the secondary limit's older wording");
      assert.notEqual(abuse.code, RATE_LIMIT_SPENT);
      assert.equal(spentUntil(quotaKey("https://api.github.test/repos", "t")), null);
    },
  );
});

test("the App token's mint carries RATE_LIMIT_SPENT and the reset", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const reset = Math.ceil((Date.now() + 20 * 60_000) / 1000) * 1000;
  const gh = await fakeGitHub(() => [403, { message: "API rate limit exceeded for app ID 1." }, spentHeaders(reset)]);
  try {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
    const script = `import { mintInstallationToken } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib", "app-token.mjs")).href)};
      try { await mintInstallationToken({ appId: "1", privateKey: process.env.KEY, owner: "o", repo: "r" }); } catch (e) { process.stdout.write(JSON.stringify({ code: e.code, resetAt: e.resetAt, status: e.status })); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, KEY: key }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    await new Promise((r) => child.on("exit", r));
    const e = JSON.parse(out);
    assert.equal(e.code, RATE_LIMIT_SPENT);
    assert.equal(e.status, 403);
    assert.ok(Math.abs(e.resetAt - reset) < 1500, out);
  } finally {
    gh.close();
  }
});
