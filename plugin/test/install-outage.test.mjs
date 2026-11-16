// #415: a set-up step that needs the network (the repository's install, its setup) and fails while this machine's
// network is down is no Block: it waits for this machine's network, as the stage's GitHub calls wait, and runs once
// more. Down is decided on exact facts only: an outage the stage recorded while the step ran, the general check (GitHub's
// origin on a fresh connection with its own lookup) failing, or one of the stage's own allowed hosts failing its lookup
// with a temporary resolver code. Nothing the step printed and nothing its checkout configures is ever probed: the
// model edits both. Each install and setup here is the real one through the real shell; the resolver, the general check,
// fetch and the clocks are fakes.
import "./temp.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { LOCAL_DOMAINS } from "../scripts/lib/local.mjs";
import { NetworkDown, OUTAGE, freshProbe, networkBack, probe, resetNetwork, unreachable, waitOutages } from "../scripts/lib/network.mjs";
import { installDeps, runSetup } from "../scripts/lib/checkout.mjs";
import { outageExit } from "../scripts/lib/session.mjs";

const GITHUB = "https://api.github.test";
const again = (host) => Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: "EAI_AGAIN" });

/**
 * A stage that waits outages out, with the clocks faked (waits pass at once and move `now`). `check(origin)`: the
 * general check's answer (null: answered); `resolve(host)`: an error, or nothing for an answer; `fetch`: the GitHub
 * client's own requests (and probe()), which no set-up step's judgement may use unless the test says so. Every check,
 * lookup and fetch is kept, and every log line.
 */
async function stage({ check = () => null, resolve = () => null, fetch = null } = {}, fn) {
  const saved = { fetch: globalThis.fetch, api: process.env.GITHUB_API_URL, outage: { sleep: OUTAGE.sleep, now: OUTAGE.now, check: OUTAGE.check, lookup: OUTAGE.lookup } };
  process.env.GITHUB_API_URL = GITHUB;
  let t = Date.parse("2026-11-16T07:51:00Z");
  const checks = [];
  const lookups = [];
  const fetched = [];
  Object.assign(OUTAGE, {
    sleep: async (ms) => void (t += ms),
    now: () => t,
    check: async (origin) => (checks.push(origin), check(origin, checks)),
    lookup: (host, opts, cb) => {
      lookups.push(host);
      const e = resolve(host, lookups);
      queueMicrotask(() => (e ? cb(e) : cb(null, "93.184.215.14", 4)));
    },
  });
  globalThis.fetch = async (url, init) => {
    fetched.push(new URL(url).origin);
    if (!fetch) assert.fail(`fetch ${url}: no set-up step's judgement sends one`);
    return fetch(url, init);
  };
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...more) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...more));
  try {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    return await fn({ checks, lookups, fetched, lines, advance: (ms) => void (t += ms) });
  } finally {
    process.stdout.write = write;
    resetNetwork();
    globalThis.fetch = saved.fetch;
    Object.assign(OUTAGE, saved.outage);
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  }
}

/**
 * A checkout whose step fails while the file `down` exists (or on its first `fails` runs), printing `said` (as a
 * failed fetch does), and passes after. `runs()`: how many times it ran.
 */
function checkout({ said = "ERR_PNPM_META_FETCH_FAIL", fails = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "install-outage-"));
  const down = join(dir, "down");
  writeFileSync(down, "");
  const log = join(dir, "runs");
  const failing = fails === null ? `[ -e ${down} ]` : `[ "$(wc -l < ${log})" -le ${fails} ]`;
  writeFileSync(join(dir, "said"), `${said}\n`);
  const command = `echo run >> ${log}; if ${failing}; then cat ${join(dir, "said")} >&2; exit 1; fi`;
  return { dir, down, command, runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
}

const netLines = (lines) => lines.filter((l) => /\[factory\] network: /.test(l));
const allowed = (lookups) => lookups.every((h) => LOCAL_DOMAINS.includes(h));

test("install: a failure while the general check fails waits for this machine's network and runs once more, no Block and no reinstall", async () => {
  const c = checkout();
  let down = true;
  await stage(
    {
      check: () => {
        if (down) return (down = false), "EAI_AGAIN";
        rmSync(c.down, { force: true });
        return null;
      },
    },
    async ({ checks, lookups, fetched, lines }) => {
      const r = await installDeps(c.dir, c.command, { env: process.env });
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.repaired, false, "the outage's failure is no try: no clean reinstall");
      assert.equal(c.runs(), 2);
      assert.deepEqual([...new Set(checks)], [GITHUB], "the general check alone, on GitHub's origin");
      assert.ok(allowed(lookups), `only the stage's allowed hosts are looked up: ${lookups}`);
      assert.deepEqual(fetched, [], "no pooled request stands in for the check");
      assert.ok(lines.some((l) => /\[factory\] install: failed while this machine's network was down \(EAI_AGAIN\); waiting for the network, then running it once more/.test(l)), lines.join(""));
      assert.equal(netLines(lines).length, 2, "one line lost, one back");
    },
  );
});

test("install: a failure with the network up Blocks as before, and the reason says the network was up, naming no host", async () => {
  const c = checkout({ said: "Could not reach https://registry.test/@pnpm/exe: fetch failed" });
  await stage({}, async ({ lines }) => {
    const r = await installDeps(c.dir, c.command, { env: process.env });
    assert.equal(r.ok, false);
    assert.equal(c.runs(), 2, "the first run and the clean reinstall");
    assert.match(r.reason, /exited 1, and again after a clean reinstall: exited 1; the network was up \(this machine's reachability check answered right after\)$/);
    assert.doesNotMatch(r.reason, /registry\.test/);
    assert.equal(netLines(lines).length, 0);
  });
});

test("install: the network down past the stage's wait ends the stage on that outage (NetworkDown), never an install Block", async () => {
  const c = checkout();
  await stage({ check: () => "ENOTFOUND" }, async () => {
    const e = await installDeps(c.dir, c.command, { env: process.env }).then(() => null, (x) => x);
    assert.ok(e instanceof NetworkDown, String(e));
    assert.ok(unreachable(e));
    assert.equal(e.origin, GITHUB);
    assert.equal(e.code, "ENOTFOUND");
    assert.equal(c.runs(), 1);
  });
});

test("install: an outage the stage recorded while the install ran (a GitHub call lost and back meanwhile) runs it once more, though all answers after", async () => {
  const c = checkout({ fails: 1 });
  let calls = 0;
  await stage({ fetch: () => (++calls === 1 ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: again("api.github.test") })) : new Response(null, { status: 200 })) }, async ({ lines }) => {
    const install = installDeps(c.dir, c.command, { env: process.env });
    await networkBack(GITHUB, "EAI_AGAIN");
    const r = await install;
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.repaired, false);
    assert.equal(c.runs(), 2);
    assert.ok(lines.some((l) => /install: failed while this machine's network was down \(EAI_AGAIN\); the network is back, running it once more/.test(l)), lines.join(""));
  });
});

test("install: the registry's lookup failing with EAI_AGAIN is this machine's network, though GitHub's names resolve and the general check answers", async () => {
  const c = checkout();
  let failing = true;
  await stage(
    {
      // A resolver that still serves GitHub's names (cached) and fails the registry's.
      resolve: (host) => {
        if (host === "registry.npmjs.org" && failing) return again(host);
        return null;
      },
      check: (origin, checks) => {
        // The resolver comes back by the wait's probe.
        if (checks.length > 1) {
          failing = false;
          rmSync(c.down, { force: true });
        }
        return null;
      },
    },
    async ({ lines, lookups }) => {
      const r = await installDeps(c.dir, c.command, { env: process.env });
      assert.equal(r.ok, true, r.reason);
      assert.equal(c.runs(), 2);
      assert.ok(lines.some((l) => /install: failed while this machine's network was down \(EAI_AGAIN\); waiting/.test(l)), lines.join(""));
      // Every allowed name is looked up (the built-in list here), the ones that are not GitHub's first.
      const first = lookups.slice(0, LOCAL_DOMAINS.length);
      assert.deepEqual([...first].sort(), [...LOCAL_DOMAINS].filter((h) => !h.startsWith("*.")).sort());
      assert.ok(first.indexOf("registry.npmjs.org") < first.indexOf("github.com"));
    },
  );
});

test("the machine's wait reads the general check, whichever host the outage was met on", async () => {
  const c = checkout();
  // A provider's host lost while the step ran, its own probe still out: the step's wait checks GitHub's origin and the
  // allowed names, never that host.
  let release;
  const provider = new Promise((r) => (release = r));
  await stage({ check: () => (rmSync(c.down, { force: true }), null), fetch: () => provider }, async ({ checks, fetched }) => {
    const install = installDeps(c.dir, c.command, { env: process.env });
    const lost = networkBack("https://provider.test", "EAI_AGAIN");
    const r = await install;
    release(new Response(null, { status: 200 }));
    await lost;
    assert.equal(r.ok, true, r.reason);
    assert.equal(c.runs(), 2);
    assert.deepEqual([...new Set(checks)], [GITHUB]);
    assert.deepEqual([...new Set(fetched)], ["https://provider.test"], "only the provider's own wait probed it");
  });
});

test("install: an URL the output names is never probed or looked up, an exfiltration host and a link-local address alike", async () => {
  const c = checkout({ said: "fetch failed: https://exfil.test/steal?d=secret http://169.254.169.254/latest/meta-data http://10.0.0.7:8080/x" });
  await stage({}, async ({ checks, lookups, fetched }) => {
    const r = await installDeps(c.dir, c.command, { env: process.env });
    assert.equal(r.ok, false);
    assert.deepEqual([...new Set(checks)], [GITHUB]);
    assert.ok(allowed(lookups), `looked up: ${lookups}`);
    assert.ok(!lookups.some((h) => /exfil|169\.254|10\.0\.0\.7/.test(h)));
    assert.deepEqual(fetched, []);
    assert.doesNotMatch(r.reason, /exfil|169\.254|10\.0\.0\.7/);
  });
});

test("install: the checkout's .npmrc and its package manager's registry are never read or asked", async () => {
  const c = checkout();
  writeFileSync(join(c.dir, ".npmrc"), "registry=https://evil.test/\n");
  writeFileSync(join(c.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const bin = join(c.dir, "bin");
  mkdirSync(bin);
  const asked = join(c.dir, "asked");
  for (const pm of ["pnpm", "npm", "yarn"]) {
    writeFileSync(join(bin, pm), `#!/bin/sh\necho "$@" >> ${asked}\nexit 0\n`);
    chmodSync(join(bin, pm), 0o755);
  }
  await stage({}, async ({ lookups }) => {
    const r = await installDeps(c.dir, c.command, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.ok, false);
    assert.ok(!existsSync(asked), "no package manager was asked for its registry");
    assert.ok(!lookups.includes("evil.test"));
  });
});

test("the general check is a fresh connection with its own lookup: a pooled GitHub socket that answers does not hide a resolver that does not", async () => {
  const c = checkout();
  // The GitHub client's pool still answers (probe() rides it); the resolver does not: the general check (the real
  // freshProbe, its own lookup) says the network is down, and the stage ends on it.
  const pooled = () => new Response(null, { status: 200 });
  await stage({ check: (origin) => freshProbe(origin), resolve: (host) => again(host), fetch: pooled }, async ({ fetched }) => {
    assert.equal(await probe(GITHUB), null, "the pooled request answers");
    const before = fetched.length;
    const e = await installDeps(c.dir, c.command, { env: process.env }).then(() => null, (x) => x);
    assert.ok(e instanceof NetworkDown, String(e));
    assert.equal(e.code, "EAI_AGAIN");
    assert.equal(fetched.length, before, "the step's judgement and wait never used the pool");
  });
});

test("freshProbe connects to no private, loopback or link-local address: an address literal or a name that resolves to one", async () => {
  let connections = 0;
  const srv = createServer((req, res) => res.end());
  srv.on("connection", () => (connections += 1));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const saved = OUTAGE.lookup;
  OUTAGE.lookup = (host, opts, cb) => queueMicrotask(() => (opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)));
  try {
    assert.equal(await freshProbe(`http://inside.test:${srv.address().port}`), null, "no claim either way");
    assert.equal(await freshProbe(`http://127.0.0.1:${srv.address().port}`), null);
    assert.equal(await freshProbe("http://169.254.169.254"), null);
    assert.equal(await freshProbe("http://[fe80::1]"), null);
    assert.equal(connections, 0);
  } finally {
    OUTAGE.lookup = saved;
    await new Promise((r) => srv.close(r));
  }
});

test("the general check reaches the operator's own GitHub on a private address (GitHub Enterprise Server on 10.x): its origin is exempt", async () => {
  let connections = 0;
  const srv = createServer((req, res) => res.end());
  srv.on("connection", () => (connections += 1));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const saved = OUTAGE.lookup;
  OUTAGE.lookup = (host, opts, cb) => queueMicrotask(() => (opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)));
  try {
    const { port } = srv.address();
    assert.equal(await OUTAGE.check(`http://ghes.test:${port}`), null);
    assert.equal(await OUTAGE.check(`http://127.0.0.1:${port}`), null);
    assert.equal(connections, 2, "the general check connected; freshProbe alone (above) does not");
    // A GHES that drops every connection (a port this test holds, so no other test's server can take it): down.
    srv.on("connection", (sock) => sock.destroy());
    assert.equal(await OUTAGE.check(`http://127.0.0.1:${port}`), "ECONNRESET");
  } finally {
    OUTAGE.lookup = saved;
    await new Promise((r) => srv.close(r));
  }
});

test("freshProbe reaches the network as the GitHub client does: through the stage's own proxy when NODE_USE_ENV_PROXY is on, a fresh connection each time", async () => {
  const seen = [];
  let connections = 0;
  // The proxy forwards http requests (502 when it cannot reach the origin) and answers CONNECT with a 502.
  const proxy = createServer((req, res) => (seen.push(`${req.method} ${req.url}`), res.writeHead(/down\.test/.test(req.url) ? 502 : 200).end()));
  proxy.on("connect", (req, sock) => (seen.push(`CONNECT ${req.url}`), sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")));
  proxy.on("connection", () => (connections += 1));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${proxy.address().port}`;
  const lookups = [];
  const saved = OUTAGE.lookup;
  OUTAGE.lookup = (host, opts, cb) => (lookups.push(host), queueMicrotask(() => cb(again(host))));
  try {
    const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: at, HTTPS_PROXY: at, NO_PROXY: "direct.test" };
    // The proxy answers for the origin, which this machine never looks up; two checks, two connections.
    assert.equal(await freshProbe("http://api.github.test", env), null);
    assert.equal(await freshProbe("http://api.github.test", env), null);
    assert.equal(connections, 2, "no kept-alive socket answers for the next check");
    // A tunnel the proxy could not open (its 502): the origin unreached.
    assert.equal(await freshProbe("https://api.github.test", env), "ERR_PROXY_TUNNEL");
    // An http origin the proxy forwards: its 502 is the origin unreached.
    assert.equal(await freshProbe("http://down.test", env), "ERR_PROXY_502");
    assert.deepEqual(seen, ["HEAD http://api.github.test/", "HEAD http://api.github.test/", "CONNECT api.github.test:443", "HEAD http://down.test/"]);
    assert.deepEqual(lookups, []);
    // NO_PROXY's origin, and any origin with NODE_USE_ENV_PROXY off (Node's fetch ignores HTTPS_PROXY then too): direct,
    // with its own lookup.
    assert.equal(await freshProbe("http://direct.test", env), "EAI_AGAIN");
    assert.equal(await freshProbe("http://api.github.test", { HTTP_PROXY: at, HTTPS_PROXY: at }), "EAI_AGAIN");
    assert.deepEqual(lookups, ["direct.test", "api.github.test"]);
    assert.equal(seen.length, 4, "the proxy saw neither");
  } finally {
    OUTAGE.lookup = saved;
    await new Promise((r) => proxy.close(r));
  }
});

test("setup: a run that met an outage gets one more once the network is back; a Block after it says its first run met an outage and the network was up", async () => {
  const c = checkout({ fails: 2 });
  let down = true;
  await stage({ check: () => (down ? ((down = false), "EAI_AGAIN") : null) }, async () => {
    const s = await runSetup({ tree: c.dir, command: c.command, env: process.env, deadlineAt: Infinity });
    assert.equal(s.ok, false);
    assert.equal(c.runs(), 2, "one more run, not a loop");
    assert.equal(s.reason, `setup failed: ${c.command} exited 1; its first run met an outage of this machine's network (EAI_AGAIN), and it ran again once the network was back; the network was up (this machine's reachability check answered right after)`);
  });
});

test("setup, through the stage's end: down past the wait it is NetworkDown, which outageExit ends paused locally and as an outage Block elsewhere", async () => {
  for (const local of [true, false]) {
    const c = checkout();
    const ends = [];
    const blocks = [];
    await stage({ check: () => "EAI_AGAIN" }, async () => {
      const e = await runSetup({ tree: c.dir, command: c.command, env: process.env, deadlineAt: Infinity }).then(() => null, (x) => x);
      assert.ok(unreachable(e), String(e));
      // The stage's own catch (worker.mjs, review.mjs: unreachable(e) -> outageExit).
      await outageExit(e, { local, records: [], finish: async (...a) => ends.push(a), block: async (reason, cause) => blocks.push({ reason, cause }) });
    });
    assert.equal(c.runs(), 1);
    assert.equal(ends.length, 1);
    const [exit, reason, outage] = ends[0];
    assert.equal(exit, local ? "paused" : "blocked");
    assert.equal(outage.origin, GITHUB);
    assert.equal(outage.code, "EAI_AGAIN");
    assert.match(reason, /^this machine could not reach api\.github\.test \(EAI_AGAIN\)/);
    if (local) assert.deepEqual(blocks, [], "nothing written to GitHub: serve resumes it");
    else assert.deepEqual(blocks.map((b) => b.cause), ["outage"]);
  }
});

test("install: a process that does not wait outages out (no stage) judges nothing and fails as before", async () => {
  const c = checkout();
  const saved = { fetch: globalThis.fetch, check: OUTAGE.check, lookup: OUTAGE.lookup };
  globalThis.fetch = async () => assert.fail("no probe off a stage");
  OUTAGE.check = async () => assert.fail("no check off a stage");
  OUTAGE.lookup = () => assert.fail("no lookup off a stage");
  try {
    resetNetwork();
    const r = await installDeps(c.dir, c.command, { env: process.env });
    assert.equal(r.ok, false);
    assert.match(r.reason, /exited 1$/);
  } finally {
    Object.assign(OUTAGE, { check: saved.check, lookup: saved.lookup });
    globalThis.fetch = saved.fetch;
  }
});

// The dispatch tick's own read cut off mid-answer (undici's "terminated", a socket that timed out): the client's
// retries, then the tick fails whole before it writes anything; serve logs it and the next tick reads again.
test("dispatch: a blocked-by read cut off mid-answer on every try fails the tick before any write", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const saved = { fetch: globalThis.fetch, api: process.env.GITHUB_API_URL, sleep: RETRY.sleep };
  process.env.GITHUB_API_URL = GITHUB;
  RETRY.sleep = async () => {};
  const writes = [];
  let cuts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    if (method !== "GET") writes.push(`${method} ${u.pathname}`);
    if (/\/dependencies\/blocked_by$/.test(u.pathname)) {
      cuts += 1;
      throw new TypeError("terminated", { cause: Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    }
    if (/\/repos\/acme\/app\/issues$/.test(u.pathname) && u.searchParams.get("state") === "open") return Response.json([{ number: 7, state: "open", body: "", labels: [{ name: "factory:objective" }], user: { login: "maintainer" } }]);
    return Response.json([]);
  };
  try {
    await assert.rejects(dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60 }, { token: "t" }), /blocked_by\?per_page=100 failed: terminated \(ETIMEDOUT\)/);
    assert.equal(cuts, RETRY.tries, "the client's retries, all of them");
    assert.deepEqual(writes, [], "nothing marked");
  } finally {
    globalThis.fetch = saved.fetch;
    RETRY.sleep = saved.sleep;
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  }
});
