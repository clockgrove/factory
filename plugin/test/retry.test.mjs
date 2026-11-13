import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Local, REFUSED_PROBE } from "../scripts/local.mjs";
import { RETRY, graphql, rest } from "../scripts/lib/github.mjs";
import { gitTransport, openOutbox } from "../scripts/lib/outbox.mjs";

// #168: a transient GitHub or git transport failure is retried within a bound; a create is never duplicated; a
// refusal is never retried; a 401 under serve stops new work and names the token's source.

/** The retry clock, faked: waits are recorded and pass at once, and `now` moves by them. */
function fakeClock() {
  const waits = [];
  let t = 1_000_000;
  const saved = { sleep: RETRY.sleep, now: RETRY.now, random: RETRY.random };
  // The middle of the jitter: Factory's own backoffs come out unspread, a wait GitHub asked for 15% longer.
  RETRY.random = () => 0.5;
  RETRY.sleep = async (ms) => {
    waits.push(ms);
    t += ms;
  };
  RETRY.now = () => t;
  return { waits, now: () => t, restore: () => Object.assign(RETRY, saved) };
}

/** GitHub on fetch: `answer(req, n)` (n counts requests to the same method and path) returns a Response or throws. */
async function withFetch(answer, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const seen = [];
  const counts = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    seen.push(key);
    return answer({ method: init.method || "GET", path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined }, counts.get(key));
  };
  const clock = fakeClock();
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    return await fn({ seen, waits: clock.waits, lines, now: clock.now });
  } finally {
    process.stdout.write = write;
    clock.restore();
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

test("rest: a read that fails twice (a 502, a dropped connection) is answered on the third try, each retry logged once", async () => {
  await withFetch(
    (req, n) => {
      if (n === 1) return json({ message: "Bad Gateway" }, 502);
      if (n === 2) throw reset();
      return json({ number: 7 });
    },
    async ({ seen, waits, lines }) => {
      assert.deepEqual(await rest("repos/o/r/issues/7?x=1", { token: "ghs_secretvalue123" }), { number: 7 });
      assert.equal(seen.length, 3);
      assert.deepEqual(waits, [2000, 4000]);
      const logged = lines.filter((l) => /GitHub GET/.test(l));
      assert.equal(logged.length, 2);
      assert.match(logged[0], /GET repos\/o\/r\/issues\/7: HTTP 502; try 2 of 4/);
      assert.match(logged[1], /network \(ECONNRESET\); try 3 of 4/);
      assert.ok(!lines.some((l) => l.includes("ghs_secretvalue123")), "no token in any line");
    },
  );
});

test("rest: an idempotent write (PATCH, DELETE) is retried; a DELETE whose retry finds nothing is done; a refusal is not retried", async () => {
  await withFetch(
    (req, n) => {
      if (req.method === "PATCH") return n === 1 ? json({ message: "Service Unavailable" }, 503) : json({ id: 1, body: req.body.body });
      if (req.method === "DELETE") return n === 1 ? json({ message: "Bad Gateway" }, 502) : json({ message: "Not Found" }, 404);
      return json({ message: "Validation Failed" }, 422);
    },
    async ({ seen }) => {
      assert.deepEqual(await rest("repos/o/r/issues/comments/1", { method: "PATCH", body: { body: "b" } }), { id: 1, body: "b" });
      assert.equal(await rest("repos/o/r/issues/7/labels/x", { method: "DELETE" }), null);
      await assert.rejects(rest("repos/o/r/issues/7", { method: "GET" }), (e) => e.status === 422);
      assert.deepEqual(seen, ["PATCH /repos/o/r/issues/comments/1", "PATCH /repos/o/r/issues/comments/1", "DELETE /repos/o/r/issues/7/labels/x", "DELETE /repos/o/r/issues/7/labels/x", "GET /repos/o/r/issues/7"]);
    },
  );
});

test("rest: a create is never sent twice when it may have landed; it goes again only when it provably did not, or the caller's check finds it absent", async () => {
  const created = [];
  await withFetch(
    (req, n) => {
      const path = req.path;
      if (req.method === "GET") return json(created);
      // A 502 after the comment was made: it landed, the answer was lost.
      if (path.endsWith("/issues/1/comments")) return created.push(req.body.body), json({ message: "Bad Gateway" }, 502);
      // Refused before connecting, then made.
      if (path.endsWith("/issues/2/comments")) {
        if (n === 1) throw refused();
        created.push(req.body.body);
        return json({ id: 2 }, 201);
      }
      // A secondary rate limit turned it away, then it is made.
      if (path.endsWith("/issues/3/comments")) {
        if (n === 1) return json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "7" });
        created.push(req.body.body);
        return json({ id: 3 }, 201);
      }
      // A merge is an action: a 502 is not retried.
      if (path.endsWith("/merge")) return json({ message: "Bad Gateway" }, 502);
      // Landed on the first try (502 lost the answer): the caller's check finds it and nothing is sent again.
      created.push(req.body.body);
      return json({ message: "Bad Gateway" }, 502);
    },
    async ({ seen, waits }) => {
      await assert.rejects(rest("repos/o/r/issues/1/comments", { method: "POST", body: { body: "one" } }), (e) => e.status === 502);
      assert.deepEqual(created, ["one"], "a 502 on a create is not retried: it may have landed");
      assert.deepEqual(await rest("repos/o/r/issues/2/comments", { method: "POST", body: { body: "two" } }), { id: 2 });
      assert.deepEqual(await rest("repos/o/r/issues/3/comments", { method: "POST", body: { body: "three" } }), { id: 3 });
      assert.deepEqual(waits, [2000, 8050], "Retry-After honoured, spread only upward");
      await assert.rejects(rest("repos/o/r/pulls/5/merge", { method: "PUT", body: {} }), (e) => e.status === 502);
      const landed = async () => (await rest("repos/o/r/issues/4/comments")).find((c) => c === "four") || null;
      assert.equal(await rest("repos/o/r/issues/4/comments", { method: "POST", body: { body: "four" }, landed }), "four");
      assert.deepEqual(created, ["one", "two", "three", "four"], "each create landed once");
      assert.equal(seen.filter((s) => s === "PUT /repos/o/r/pulls/5/merge").length, 1);
      assert.equal(seen.filter((s) => s === "POST /repos/o/r/issues/4/comments").length, 1);
    },
  );
});

test("rest: a 5xx or a 422 is no rate limit whatever its headers, so a create that may have landed is not sent again", async () => {
  const reset = String(Math.floor(1_000_000 / 1000) + 30);
  const firsts = {
    "/repos/o/r/issues/1/comments": () => json({ message: "Service Unavailable" }, 503, { "retry-after": "1" }),
    "/repos/o/r/issues/2/comments": () => json({ message: "Bad Gateway" }, 502, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
    "/repos/o/r/issues/3/comments": () => json({ message: "Validation Failed" }, 422, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
  };
  await withFetch(
    (req, n) => (n === 1 ? firsts[req.path]() : json({ id: 1 }, 201)),
    async ({ seen }) => {
      for (const [path, status] of [["repos/o/r/issues/1/comments", 503], ["repos/o/r/issues/2/comments", 502], ["repos/o/r/issues/3/comments", 422]]) {
        await assert.rejects(rest(path, { method: "POST", body: { body: "x" } }), (e) => e.status === status && e.rateLimited === false);
      }
      assert.equal(seen.length, 3, "each create sent once");
    },
  );
  // A read with a 503 asking for a wait is retried after it.
  await withFetch(
    (req, n) => (n === 1 ? json({ message: "Service Unavailable" }, 503, { "retry-after": "3" }) : json({ ok: true })),
    async ({ waits }) => {
      assert.deepEqual(await rest("repos/o/r"), { ok: true });
      assert.deepEqual(waits, [3450]);
    },
  );
});

test("rest: jitter spreads Factory's backoff both ways and GitHub's ask only upward; noRateWait throws a rate limit at once", async () => {
  for (const [r, want] of [[0, [1400, 5000]], [1, [2600, 6500]]]) {
    await withFetch(
      (req, n) => (n === 1 ? json({ message: "Bad Gateway" }, 502) : n === 2 ? json({ message: "x" }, 429, { "retry-after": "5" }) : json({ ok: true })),
      async ({ waits }) => {
        RETRY.random = () => r;
        assert.deepEqual(await rest("repos/o/r"), { ok: true });
        assert.deepEqual(waits, want);
      },
    );
  }
  await withFetch(
    () => json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "60" }),
    async ({ seen, waits }) => {
      await assert.rejects(rest("repos/o/r/issues/7/dependencies/blocked_by", { noRateWait: true }), (e) => e.rateLimited === true && e.status === 403);
      assert.equal(seen.length, 1);
      assert.deepEqual(waits, []);
    },
  );
});

test("rest: a wait past the caller's deadline or the bound is not taken; the error goes to the caller at once", async () => {
  await withFetch(
    () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(1_000_000 / 1000) + 3600) }),
    async ({ seen, waits }) => {
      await assert.rejects(rest("repos/o/r"), (e) => e.rateLimited === true);
      assert.equal(seen.length, 1, "an hour's wait is beyond the bound");
      assert.deepEqual(waits, []);
    },
  );
  await withFetch(
    () => json({ message: "Bad Gateway" }, 502),
    async ({ seen, waits, now }) => {
      await assert.rejects(rest("repos/o/r", { deadlineAt: now() + 5000 }), (e) => e.status === 502);
      assert.deepEqual(waits, [2000], "the second wait (4 s) would end past the deadline");
      assert.equal(seen.length, 2);
    },
  );
});

test("graphql: a query is retried; a mutation is not resent after a 502, but is after GitHub's RATE_LIMITED refusal", async () => {
  let mutations = 0;
  await withFetch(
    (req, n) => {
      if (/^mutation/.test(req.body.query)) {
        mutations += 1;
        if (req.body.variables.limited && mutations === 2) return json({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] });
        return mutations === 1 ? json({ message: "Bad Gateway" }, 502) : json({ data: { ok: true } });
      }
      return n === 1 ? json({ message: "Bad Gateway" }, 502) : json({ data: { viewer: { login: "x" } } });
    },
    async () => {
      assert.deepEqual(await graphql("query { viewer { login } }"), { viewer: { login: "x" } });
      await assert.rejects(graphql("mutation { a }", {}), (e) => e.status === 502);
      assert.equal(mutations, 1);
      assert.deepEqual(await graphql("mutation($limited: Boolean) { a }", { limited: true }), { ok: true });
      assert.equal(mutations, 3);
    },
  );
});

// ------------------------------------------------------------------ git

const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function repos() {
  const root = mkdtempSync(join(tmpdir(), "factory-retry-"));
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
  return { root, origin, work, run };
}

/** A hook in the origin that drops the connection (kills receive-pack) while the file `drops` still has lines. */
function dropConnection(r, hook, times) {
  const count = join(r.root, `${hook}-drops`);
  writeFileSync(count, "x\n".repeat(times));
  // reference-transaction: only once the ref is written, so the push lands and its answer is lost.
  const read = hook === "reference-transaction" ? '[ "$1" = committed ] || exit 0\ncat >/dev/null\n' : "";
  writeFileSync(join(r.origin, "hooks", hook), `#!/bin/sh\n${read}if [ -s "${count}" ]; then sed -i 1d "${count}"; kill -9 $PPID; sleep 1; exit 1; fi\nexit 0\n`, { mode: 0o755 });
}

const open = (r) => openOutbox({ branch: "factory/1", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, base: r.root });

test("outbox: a push whose connection drops is retried and lands; the outbox takes later pushes", async () => {
  const r = repos();
  const clock = fakeClock();
  let box;
  try {
    box = await open(r);
    dropConnection(r, "pre-receive", 2);
    assert.equal(await box.push(), true, box.error);
    assert.equal(r.run(r.origin, "rev-parse", "factory/1"), r.run(r.work, "rev-parse", "HEAD"));
    assert.deepEqual(clock.waits, [2000, 4000]);
    assert.equal(box.failed, false);
    writeFileSync(join(r.work, "app.txt"), "v3\n");
    r.run(r.work, "commit", "-q", "-am", "more");
    assert.equal(await box.push(), true, box.error);
  } finally {
    clock.restore();
    box?.close?.();
  }
});

test("outbox: a push after the work's deadline (in the stage's exit reserve) is still retried", async () => {
  const r = repos();
  const clock = fakeClock();
  try {
    // A minute past the work's deadline, by the retry clock: a timed-out stage's last push.
    const box = await openOutbox({ branch: "factory/1", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, base: r.root, deadlineAt: clock.now() - 60_000 });
    dropConnection(r, "pre-receive", 1);
    assert.equal(await box.push(), true, box.error);
    assert.deepEqual(clock.waits, [2000]);
    box.close();
  } finally {
    clock.restore();
  }
});

test("outbox: a push that landed though its answer was lost is not sent again", async () => {
  const r = repos();
  const clock = fakeClock();
  try {
    const box = await open(r);
    dropConnection(r, "reference-transaction", 1);
    const sends = join(r.root, "sends");
    writeFileSync(join(r.origin, "hooks", "pre-receive"), `#!/bin/sh\necho x >> "${sends}"\n`, { mode: 0o755 });
    assert.equal(await box.push(), true, box.error);
    assert.equal(readFileSync(sends, "utf8"), "x\n", "sent once");
    assert.deepEqual(clock.waits, [2000]);
    assert.equal(r.run(r.origin, "rev-parse", "factory/1"), r.run(r.work, "rev-parse", "HEAD"));
    box.close();
  } finally {
    clock.restore();
  }
});

test("outbox: a refused push (a hook's rejection, a rejected ref) is never retried", async () => {
  const r = repos();
  const clock = fakeClock();
  try {
    const box = await open(r);
    writeFileSync(join(r.origin, "hooks", "pre-receive"), "#!/bin/sh\necho declined >&2\nexit 1\n", { mode: 0o755 });
    assert.equal(await box.push(), false);
    assert.match(box.error, /^push rejected: .*remote rejected/);
    assert.deepEqual(clock.waits, [], "no retry of a refusal");
    box.close();
  } finally {
    clock.restore();
  }
});

test("gitTransport: transport words count only without a refusal and without the ref's own porcelain line", () => {
  const fail = (stderr, stdout = "") => ({ code: 128, stdout, stderr });
  assert.equal(gitTransport(fail("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com")), true);
  assert.equal(gitTransport(fail("error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502")), true);
  assert.equal(gitTransport(fail("batch response: Fatal error: Server error: https://github.com/o/r.git/info/lfs/objects/batch")), true);
  assert.equal(gitTransport(fail("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403")), false);
  assert.equal(gitTransport(fail("error: RPC failed; HTTP 413 curl 22\nfatal: the remote end hung up unexpectedly")), false);
  assert.equal(gitTransport(fail("fatal: the remote end hung up unexpectedly", "To o\n!\trefs/heads/incoming:refs/heads/f\t[remote rejected] (pre-receive hook declined)\nDone\n"), "refs/heads/f"), false);
  assert.equal(gitTransport(fail("fatal: couldn't find remote ref refs/heads/x")), false);
  assert.equal(gitTransport({ code: 0, stdout: "", stderr: "" }), false);
});

// ------------------------------------------------------------------ serve and a 401

/**
 * The real serve loop against a GitHub that answers 401 while `refuses(authorization)` says so. `onRefused(file)` runs
 * once the refusal is logged; the loop stops after its first dispatch read GitHub answers, or after `stopMs`.
 */
async function serveThrough401({ refuses, onRefused, stopMs = 5000 }) {
  const home = mkdtempSync(join(tmpdir(), "factory-home-"));
  const file = join(home, ".config", "factory", "tokens", "o", "r");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "github_pat_old\n");
  let reads = 0;
  const server = createServer((req, res) => {
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (refuses(req.headers.authorization)) return send(401, { message: "Bad credentials" });
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/repos/o/r/issues") reads += 1;
    return send(200, req.method === "POST" ? { message: "Validation Failed" } : url.pathname === "/repos/o/r" ? { full_name: "o/r" } : []);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const env = { HOME: process.env.HOME, GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_TOKEN: process.env.FACTORY_LOCAL_TOKEN };
  const probe = REFUSED_PROBE.ms;
  REFUSED_PROBE.ms = 20;
  process.env.HOME = home;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.FACTORY_LOCAL = "1";
  delete process.env.FACTORY_LOCAL_TOKEN;
  const lines = [];
  const loop = Object.assign(Object.create(Local.prototype), {
    repo: { owner: "o", name: "r", full: "o/r" },
    repoFull: "o/r",
    token: "github_pat_old",
    notice: null,
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "1" },
    opts: { token: "github_pat_old" },
    children: new Set(),
    baseEnv: () => ({ FACTORY_INPUT_MAX_CONCURRENT: "1" }),
    cleanup: async () => {},
    pausedHere: async () => {
      if (reads > 0) loop.stopping = true;
      return [];
    },
    pendingReviews: async () => [],
    runObjective: async () => ({ exit: "delivered" }),
  });
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    if (/GitHub refused the local token/.test(chunk)) setTimeout(() => onRefused(file), 30);
    return write.call(process.stdout, chunk, ...rest);
  };
  const stopper = setTimeout(() => (loop.stopping = true), stopMs);
  try {
    await loop.serve({ intervalMs: 5 });
  } finally {
    clearTimeout(stopper);
    process.stdout.write = write;
    REFUSED_PROBE.ms = probe;
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await new Promise((ok) => server.close(ok));
  }
  return { lines, reads, file, token: loop.token };
}

test("serve: a 401 on the local token stops new work and names its source; a renewed token in that source resumes it", async () => {
  const run = await serveThrough401({ refuses: (auth) => auth !== "Bearer github_pat_new", onRefused: (file) => writeFileSync(file, "github_pat_new\n") });
  const refusedLines = run.lines.filter((l) => /GitHub refused the local token \(HTTP 401/.test(l));
  assert.equal(refusedLines.length, 1, "said once, not every tick");
  assert.ok(refusedLines[0].includes(run.file), "names the token's file");
  assert.ok(!run.lines.some((l) => /github_pat_(old|new)/.test(l)), "never the token's value");
  assert.ok(!run.lines.some((l) => /dispatch failed/.test(l)));
  assert.ok(run.lines.some((l) => /a new token in .*: taking work again/.test(l)));
  assert.equal(run.token, "github_pat_new");
  assert.ok(run.reads > 0, "the dispatcher read GitHub again with the new token");
});

test("serve: a 401 GitHub gives for a moment does not stop the loop: the same token, tried again, resumes it", async () => {
  let incident = true;
  const run = await serveThrough401({ refuses: () => incident, onRefused: () => (incident = false) });
  assert.equal(run.lines.filter((l) => /GitHub refused the local token/.test(l)).length, 1);
  assert.ok(run.lines.some((l) => /GitHub takes the local token again: taking work again/.test(l)));
  assert.equal(run.token, "github_pat_old");
  assert.ok(run.reads > 0, "the dispatcher read GitHub again with the same token");
});
