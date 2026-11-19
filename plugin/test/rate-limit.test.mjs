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
import { whenText } from "../scripts/lib/clock.mjs";
import { RETRY, rest } from "../scripts/lib/github.mjs";
import { OUTAGE, RATE_LIMIT_SPENT, quotaKey, quotaResource, resetNetwork, spentUntil, waitOutages } from "../scripts/lib/network.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
/** The REST quota running out mid-tick: from the read of today's local spend on, every REST read is refused. */
const restRunsOut = () => {
  let out = false;
  return (req) => (out ||= req.path.endsWith("/issues/comments")) && !req.path.endsWith("/graphql");
};
const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
/** GitHub's answer for a spent primary limit, reset at `resetMs`. */
const spentHeaders = (resetMs) => ({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(resetMs / 1000)) });
const spent = (resetMs, status = 403) => json({ message: "API rate limit exceeded for user ID 1." }, status, spentHeaders(resetMs));

/**
 * GitHub's GET /rate_limit as a fake answers it (#420): each token's quotas as its latest answer's headers left them,
 * 5000 remaining before any. `note` records an answer to a request on `path` with Authorization `auth`; `answer` is the
 * count for `auth`, {body, headers} (the Date of the answer it was read from).
 */
function rateLimitModel() {
  const last = new Map();
  const RESOURCES = ["core", "graphql", "search", "code_search"];
  return {
    note(auth, path, headers) {
      const h = new Headers(headers || {});
      if (h.has("x-ratelimit-remaining")) last.set(`${auth} ${h.get("x-ratelimit-resource") || quotaResource(`https://x${path}`)}`, { remaining: Number(h.get("x-ratelimit-remaining")), reset: Number(h.get("x-ratelimit-reset")), date: h.get("date") });
    },
    answer(auth) {
      const of = (r) => last.get(`${auth} ${r}`) ?? { remaining: 5000, reset: 9_999_999_999 };
      const date = RESOURCES.map(of).find((x) => x.date)?.date;
      return { body: { resources: Object.fromEntries(RESOURCES.map((r) => [r, { limit: 5000, remaining: of(r).remaining, reset: of(r).reset }])) }, headers: date ? { date } : {} };
    },
  };
}

/**
 * Both clocks faked (the client's retries, the network waits). A sleep is held until `release()` moves `now` past it, so
 * a test can send more requests while one waits. `fetch` is `answer(req)` with req {method, path, at}; every request is
 * in `seen`. Log lines are in `lines`. GET /rate_limit is answered by rateLimitModel, or by `count(auth, advance)` ({body,
 * headers}; `advance(ms)` moves the clock while the read is out) when given, and is not in `seen`; `counts` lists its reads.
 */
async function faked(answer, fn, { token = false, count = null } = {}) {
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
  const counts = [];
  const model = rateLimitModel();
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.Authorization;
    if (u.pathname === "/rate_limit") {
      counts.push({ auth, at: t, signal: init.signal ?? null });
      const c = (count ?? model.answer)(auth, (ms) => (t += ms));
      return json(c.body, 200, c.headers);
    }
    const req = { method: init.method || "GET", path: u.pathname, at: t, ...(token ? { token: auth } : {}) };
    seen.push(req);
    const res = await answer(req, t);
    // GitHub names the quota it counted the request on (GraphQL's for a GraphQL call), unless the answer names it.
    if (res.headers.has("x-ratelimit-remaining") && !res.headers.has("x-ratelimit-resource")) res.headers.set("x-ratelimit-resource", quotaResource(url));
    model.note(auth, u.pathname, res.headers);
    return res;
  };
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...more) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...more));
  try {
    return await fn({ seen, counts, lines, held, release, now: () => t });
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

const limitLines = (lines) => lines.filter((l) => /\[pendulum\] network: GitHub's \S+ API rate limit/.test(l));
const retryLines = (lines) => lines.filter((l) => /\[pendulum\] GitHub /.test(l));

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
      const later = [rest("repos/o/r/pulls?state=open&head=o:pendulum/7"), rest("repos/o/r/issues/7/comments", { method: "POST", body: { body: "progress" } })];
      await new Promise((r) => setImmediate(r));
      assert.equal(seen.length, 1, "no request goes to GitHub while the limit is spent");
      assert.equal(held.length, 1, "the later callers wait on the same sleep");
      const slept = await release();
      assert.ok(slept >= reset - start && slept <= reset - start + OUTAGE.quotaJitterMs, `the reset plus a little jitter: ${slept}`);
      assert.deepEqual(await Promise.all([first, ...later]), [{ ok: "/repos/o/r/issues/7" }, { ok: "/repos/o/r/pulls" }, { id: 9 }]);
      assert.ok(seen.slice(1).every((r) => r.at >= reset), "every later request after the reset");
      assert.equal(seen.filter((r) => r.method === "POST").length, 1, "the create once");
      assert.equal(limitLines(lines).length, 2, lines.join(""));
      assert.match(limitLines(lines)[0], /rate limit on api\.github\.test is spent until Nov 14, 9:07:00 AM UTC; no request goes against it until then/);
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
async function fakeGitHub(answer, { count = true } = {}) {
  const seen = [];
  const model = rateLimitModel();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // GET /rate_limit: GitHub's count, as the token's latest answer left it (rateLimitModel); not in `seen`.
      if (req.url === "/rate_limit" && !count) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "A JSON web token could not be decoded" }));
        return;
      }
      if (req.url === "/rate_limit") {
        const c = model.answer(req.headers.authorization);
        res.writeHead(200, { "content-type": "application/json", ...c.headers });
        res.end(JSON.stringify(c.body));
        return;
      }
      const r = { method: req.method, url: req.url, body };
      seen.push(r);
      const [status, data, headers] = answer(r) || [200, req.method === "GET" && /per_page=/.test(req.url) ? [] : { id: 1, user: { login: "me", type: "User" }, body: "" }, {}];
      model.note(req.headers.authorization, new URL(req.url, "http://x").pathname, headers);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}


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
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ, GITHUB_API_URL: gh.url, PENDULUM_APP_TOKEN: "t", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise((r) => child.on("exit", r));
  const file = join(root, "u", "result.json");
  return { code, out, result: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
}

test("a queued worker checks the latest Draft release before it touches the plan or starts work", async () => {
  const maintainer = { login: "maintainer", type: "User" };
  const triager = { login: "triager", type: "User" };
  const now = Date.now();
  const labelEvent = (id, event, name, actor, secondsAgo) => ({ id, event, label: { name }, actor, created_at: new Date(now - secondsAgo * 1000).toISOString() });
  const timeline = [
    labelEvent(10, "labeled", "pendulum:objective", maintainer, 60),
    labelEvent(11, "labeled", "pendulum:running", maintainer, 30),
    labelEvent(12, "labeled", "pendulum:draft", maintainer, 15),
    labelEvent(13, "unlabeled", "pendulum:draft", triager, 10),
  ];
  const gh = await fakeGitHub(({ method, url }) => {
    const path = new URL(url, "https://github.test").pathname;
    if (method !== "GET") return null;
    if (path.endsWith("/collaborators/triager/permission")) return [200, { permission: "triage" }];
    if (path.endsWith("/collaborators")) return [200, [maintainer]];
    if (path.endsWith("/timeline")) return [200, timeline];
    if (path.endsWith("/issues/7")) return [200, { number: 7, state: "open", user: maintainer, body: "", labels: [{ name: "pendulum:objective" }, { name: "pendulum:running" }] }];
    return null;
  });
  try {
    const { code, out, result } = await worker(gh, { env: { PENDULUM_LOCAL: "1", PENDULUM_APP_SLUG: "pendulum-app" } });
    assert.equal(code, 0, out);
    assert.equal(result?.exit, "skipped", out);
    assert.match(result.reason, /Draft activation was not authorized/);
    assert.ok(gh.seen.some(({ url }) => url.endsWith("/collaborators/triager/permission")));
    assert.ok(!gh.seen.some(({ url }) => /\/pulls|\/git\/refs/.test(url)), "branch and PR state are untouched");
  } finally {
    gh.close();
  }
});

test("worker.mjs, run for real on the local route: a reset 20 minutes ahead (past its 15-minute wait) ends it paused with the reset, nothing sent after", async () => {
  const reset = Math.ceil((Date.now() + 20 * 60_000) / 1000) * 1000;
  // The quota stays spent: every request is refused.
  const gh = await fakeGitHub(() => [403, { message: "API rate limit exceeded for user ID 1." }, spentHeaders(reset)]);
  try {
    const { code, out, result } = await worker(gh, { env: { PENDULUM_LOCAL: "1" } });
    assert.equal(code, 0, out);
    assert.equal(result?.exit, "paused", out);
    assert.equal(result.outage.code, RATE_LIMIT_SPENT);
    // On this machine's clock, through the answer's Date (whole seconds): at most a second after the stated reset.
    const at = Date.parse(result.outage.reset);
    assert.ok(at >= reset && at < reset + 1500, `serve resumes it after this: ${result.outage.reset}`);
    assert.equal(result.outage.quota, "core");
    assert.equal(result.outage.origin, gh.url);
    assert.ok(result.reason.startsWith(`GitHub's core API rate limit on 127.0.0.1:`) && result.reason.includes(`is spent until ${whenText(result.outage.reset)}`), result.reason);
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

/** One dispatcher tick in this process over one queued Objective (#5); `spentOn(req)` says which reads meet a spent quota. */
async function tickWith(spentOn) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const start = Date.parse("2026-11-14T08:47:00Z");
  const queued = { number: 5, state: "open", labels: [{ name: "pendulum:objective" }], body: "", updated_at: new Date(start).toISOString(), user: { login: "maintainer" } };
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
    async ({ lines, seen }) => ({ r: await dispatch({ repo: "acme/app", objectiveLabel: "pendulum:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t", dryRun: true }), lines, seen }),
  );
}

test("dispatch: a tick that met its token's REST quota spent in a read it went on without starts nothing; a GraphQL-only limit holds nothing", async () => {
  const graphqlOnly = await tickWith((req) => req.path.endsWith("/graphql"));
  assert.deepEqual(graphqlOnly.r.ready, [5], graphqlOnly.lines.join(""));
  const restOut = await tickWith(restRunsOut());
  assert.deepEqual(restOut.r.ready, [], restOut.lines.join(""));
  assert.match(restOut.r.reason, /^GitHub's API rate limit is spent until Nov 14, 9:07 AM UTC; no new stage starts until then$/);
  assert.deepEqual(restOut.r.skipped.find((s) => s.number === 5)?.reason, restOut.r.reason);
  assert.equal(restOut.lines.filter((l) => l.includes("no new stage starts until then")).length, 1);
});


test("#534: a count read that crosses a second puts the reset no earlier than GitHub's, read through the count's own Date", async () => {
  // The refusal at 08:47:00.000; GitHub's count answers 1.2 s later, its Date (whole seconds) 08:47:01. Read through
  // that Date against the time the refusal came, the reset would land a second before GitHub's.
  const start = Date.parse("2026-11-14T08:47:00Z");
  const reset = Math.ceil((start + 20 * 60_000) / 1000);
  const core = quotaKey("https://api.github.test/repos", "t");
  await faked(
    (req, t) => json({ message: "API rate limit exceeded for user ID 1." }, 403, { ...spentHeaders(reset * 1000), date: new Date(t).toUTCString() }),
    async ({ now }) => {
      assert.equal(now(), start);
      const e = await rest("repos/o/r/issues/7", { token: "t" }).then(() => null, (x) => x);
      assert.equal(e?.code, RATE_LIMIT_SPENT, String(e));
      assert.equal(now(), start + 1200, "the clock moved while the count was read");
      assert.ok(e.resetAt >= reset * 1000 && e.resetAt < reset * 1000 + 1000, new Date(e.resetAt).toISOString());
      assert.equal(spentUntil(core), e.resetAt);
    },
    {
      count: (auth, advance) => {
        const date = new Date(advance(1200)).toUTCString();
        return { body: { resources: { core: { limit: 5000, remaining: 0, reset } } }, headers: { date } };
      },
    },
  );
});

test("#420: GitHub's count of the quota (GET /rate_limit), not the answer's words, says a refusal is the primary limit spent", async () => {
  const start = Date.parse("2026-11-14T08:47:00Z");
  const core = quotaKey("https://api.github.test/repos", "t");
  const left = (remaining) => () => ({ body: { resources: { core: { limit: 5000, remaining, reset: Math.ceil((start + 20 * 60_000) / 1000) } } }, headers: {} });
  // A 403 on the last quota point for another reason (no access, abuse detection), and a 429 with no Retry-After whose
  // quota still has points (a secondary limit): the count has some left, so neither is the limit spent.
  await faked(
    (req) => (req.path.endsWith("/busy") ? json({ message: "Too many requests." }, 429, spentHeaders(start + 20 * 60_000)) : json({ message: req.path.endsWith("/denied") ? "Resource not accessible by integration" : "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again." }, 403, spentHeaders(start + 20 * 60_000))),
    async ({ counts }) => {
      for (const path of ["denied", "abuse", "busy"]) {
        const e = await rest(`repos/o/r/${path}`, { token: "t" }).then(() => null, (x) => x);
        assert.ok(e?.status === 403 || e?.status === 429, path);
        assert.equal(e.rateLimited, true, path);
        assert.notEqual(e.code, RATE_LIMIT_SPENT, path);
      }
      assert.equal(spentUntil(core), null);
      assert.ok(counts.length >= 3 && counts.every((c) => c.auth === "Bearer t"), "the count is read with the same token");
    },
    { count: left(4999) },
  );
  // GitHub's primary limit in words the client has never seen: the count has none left, so it is spent until the count's reset.
  await faked(
    () => json({ message: "Quota for this token is used up." }, 403, spentHeaders(start + 20 * 60_000)),
    async () => {
      const e = await rest("repos/o/r/issues/7", { token: "t" }).then(() => null, (x) => x);
      assert.equal(e?.code, RATE_LIMIT_SPENT, String(e));
      assert.equal(e.resetAt, Math.ceil((start + 20 * 60_000) / 1000) * 1000);
      assert.equal(spentUntil(core), e.resetAt);
    },
    { count: left(0) },
  );
  // No count to read (GET /rate_limit refused): the answer's own headers stand, as GitHub documents them.
  await faked(
    () => json({ message: "Quota for this token is used up." }, 403, spentHeaders(start + 20 * 60_000)),
    async () => {
      const e = await rest("repos/o/r/issues/7", { token: "t" }).then(() => null, (x) => x);
      assert.equal(e?.code, RATE_LIMIT_SPENT, String(e));
    },
    { count: () => ({ body: { message: "Not Found" }, headers: {} }) },
  );
});
