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
import { NetworkDown, OUTAGE, freshProbe, resetNetwork, unreachable, waitOutages } from "../scripts/lib/network.mjs";
import { installDeps } from "../scripts/lib/checkout.mjs";

const GITHUB = "https://api.github.test";

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

const netLines = (lines) => lines.filter((l) => /\[pendulum\] network: /.test(l));
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
      assert.ok(lines.some((l) => /\[pendulum\] install: failed while this machine's network was down \(EAI_AGAIN\); waiting for the network, then running it once more/.test(l)), lines.join(""));
      assert.equal(netLines(lines).length, 2, "one line lost, one back");
    },
  );
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
    if (/\/repos\/acme\/app\/issues$/.test(u.pathname) && u.searchParams.get("state") === "open") return Response.json([{ number: 7, state: "open", body: "", labels: [{ name: "pendulum:objective" }], user: { login: "maintainer" } }]);
    return Response.json([]);
  };
  try {
    await assert.rejects(dispatch({ repo: "acme/app", objectiveLabel: "pendulum:objective", maxConcurrent: 2, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60 }, { token: "t" }), /blocked_by\?per_page=100 failed: terminated \(ETIMEDOUT\)/);
    assert.equal(cuts, RETRY.tries, "the client's retries, all of them");
    assert.deepEqual(writes, [], "nothing marked");
  } finally {
    globalThis.fetch = saved.fetch;
    RETRY.sleep = saved.sleep;
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  }
});
