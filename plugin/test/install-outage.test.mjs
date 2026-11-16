// #415: a set-up step that needs the network (the repository's install, its setup) and fails while this machine's
// network is down is no Block: it waits for the network, as the stage's GitHub calls do, and runs again. It Blocks only
// when it fails with the network up (and says so), or when the wait runs out (the stage then ends on the outage). The
// hosts a step needs come from what it said (an URL its output names) or its package manager's registry; with none
// known, GitHub's. Each install here is the real installDeps and its real shell; only fetch and the clocks are fakes.
import "./temp.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { NetworkDown, OUTAGE, networkBack, resetNetwork, unreachable, waitOutages } from "../scripts/lib/network.mjs";
import { installDeps, sh, throughOutages, upText } from "../scripts/lib/checkout.mjs";

const REGISTRY = "https://registry.test";
const GITHUB = "https://api.github.test";
const dns = (host) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: "EAI_AGAIN" }) });

/** The outage's clock and fetch faked (probes answer `answer(origin)`), every log line kept; a stage's wait is on. */
async function offline(answer, fn) {
  const saved = { fetch: globalThis.fetch, api: process.env.GITHUB_API_URL, outage: { sleep: OUTAGE.sleep, now: OUTAGE.now } };
  process.env.GITHUB_API_URL = "https://api.github.test";
  let t = Date.parse("2026-11-16T07:51:00Z");
  Object.assign(OUTAGE, { sleep: async (ms) => void (t += ms), now: () => t });
  const probes = [];
  globalThis.fetch = async (url) => {
    const origin = new URL(url).origin;
    probes.push(origin);
    return answer(origin, probes);
  };
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...more) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...more));
  try {
    waitOutages({ until: (since) => since + OUTAGE.stageWaitMs });
    return await fn({ probes, lines, advance: (ms) => void (t += ms) });
  } finally {
    process.stdout.write = write;
    resetNetwork();
    globalThis.fetch = saved.fetch;
    Object.assign(OUTAGE, saved.outage);
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  }
}

const up = () => new Response(null, { status: 200 });

/**
 * A checkout whose install fails while the file `down` exists, naming the URL it could not reach when `names` (as pnpm
 * does), and passes once it is gone. `runs()`: how many times it ran.
 */
function checkout({ names = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "install-outage-"));
  const down = join(dir, "down");
  writeFileSync(down, "");
  const log = join(dir, "runs");
  const said = names ? `Could not reach ${REGISTRY}/@pnpm/exe.linux-x64/12.18.0: fetch failed` : "ERR_PNPM_META_FETCH_FAIL";
  const command = `echo run >> ${log}; if [ -e ${down} ]; then echo '${said}' >&2; exit 1; fi`;
  return { dir, down, command, runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
}

const netLines = (lines) => lines.filter((l) => /\[factory\] network: /.test(l));

test("install: a failure while the host its output names does not answer waits for the network and runs again, no Block and no reinstall", async () => {
  const c = checkout();
  await offline(
    // The whole network down for the first two probes: the host the install named, then the general check.
    (origin, probes) => {
      if (probes.length <= 2) return Promise.reject(dns(new URL(origin).host));
      rmSync(c.down);
      return up();
    },
    async ({ lines, probes }) => {
      const r = await installDeps(c.dir, c.command, { env: process.env });
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.repaired, false, "the outage's failure is no try: no clean reinstall");
      assert.equal(c.runs(), 2);
      assert.deepEqual(probes, [REGISTRY, GITHUB, REGISTRY], "the host the install named (not a guess), the general check, then the wait's probe");
      assert.ok(lines.some((l) => /\[factory\] install: failed while this machine could not reach registry\.test \(EAI_AGAIN\); waiting for the network, then running it again/.test(l)), lines.join(""));
      assert.equal(netLines(lines).length, 2, "one line lost, one back");
    },
  );
});

test("install: a failure with every host it needs answering Blocks as before, and the reason says the network was up", async () => {
  const c = checkout();
  await offline(up, async ({ probes, lines }) => {
    const r = await installDeps(c.dir, c.command, { env: process.env });
    assert.equal(r.ok, false);
    assert.equal(c.runs(), 2, "the first run and the clean reinstall");
    assert.match(r.reason, /^install failed \(infrastructure, not a validation result; validation did not run\): .* exited 1, and again after a clean reinstall: exited 1; the network was up \(registry\.test answered right after\)$/);
    assert.deepEqual([...new Set(probes)], [REGISTRY]);
    assert.equal(netLines(lines).length, 0);
  });
});

test("install: a host that stays unreachable past the stage's wait ends the stage on that outage (NetworkDown), never an install Block", async () => {
  const c = checkout();
  await offline(
    () => Promise.reject(dns("registry.test")),
    async () => {
      const e = await installDeps(c.dir, c.command, { env: process.env }).then(() => null, (x) => x);
      assert.ok(e instanceof NetworkDown, String(e));
      assert.ok(unreachable(e));
      assert.equal(e.origin, REGISTRY);
      assert.equal(e.code, "EAI_AGAIN");
      assert.equal(c.runs(), 1);
    },
  );
});

test("install: only the host its output names not answering, while the general check does, is that host's trouble: no wait, the Block names it", async () => {
  const c = checkout();
  await offline(
    (origin) => (origin === REGISTRY ? Promise.reject(dns("registry.test")) : up()),
    async ({ probes, lines }) => {
      const r = await installDeps(c.dir, c.command, { env: process.env });
      assert.equal(r.ok, false);
      assert.equal(c.runs(), 2, "the first run and the clean reinstall, no run for an outage");
      assert.match(r.reason, /exited 1, and again after a clean reinstall: exited 1; the network was up \(api\.github\.test answered right after\), but registry\.test did not answer \(EAI_AGAIN\)$/);
      assert.deepEqual(probes, [REGISTRY, GITHUB, REGISTRY, GITHUB], "each failure: the named host, then the general check; never a wait's probe");
      assert.equal(netLines(lines).length, 0, "no wait");
    },
  );
});

test("install: an outage this stage met while the install ran (GitHub lost and back meanwhile) runs it again, though every host answers after", async () => {
  const c = checkout({ names: false });
  // It fails its first run only: the run the outage met.
  const command = `${c.command.replace(`if [ -e ${c.down} ]`, `if [ "$(wc -l < ${join(c.dir, "runs")})" -eq 1 ]`)}`;
  await offline(
    // The stage's own GitHub call lost the network while the install ran; it is back by the time anything probes.
    (origin, probes) => (probes.length === 1 ? Promise.reject(dns("api.github.test")) : up()),
    async ({ lines }) => {
      const install = installDeps(c.dir, command, { env: process.env });
      await networkBack("https://api.github.test", "EAI_AGAIN");
      const r = await install;
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.repaired, false);
      assert.equal(c.runs(), 2);
      assert.ok(lines.some((l) => /install: failed while this machine could not reach api\.github\.test \(EAI_AGAIN\); the network is back, running it again/.test(l)), lines.join(""));
    },
  );
});

test("install: with no host named, the package manager's own registry is probed", async () => {
  const c = checkout({ names: false });
  writeFileSync(join(c.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const bin = join(c.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nif [ "$1 $2 $3" = "config get registry" ]; then echo "${REGISTRY}/"; exit 0; fi\nexit 9\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  await offline(
    (origin, probes) => {
      if (probes.length <= 2) return Promise.reject(dns(new URL(origin).host));
      rmSync(c.down);
      return up();
    },
    async ({ probes }) => {
      const r = await installDeps(c.dir, c.command, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.repaired, false);
      assert.equal(c.runs(), 2);
      assert.deepEqual(probes, [REGISTRY, GITHUB, REGISTRY]);
    },
  );
});

test("setup: the repository's setup through the real shell waits out an outage of the host it names and runs again; failing with the network up it says so", async () => {
  const c = checkout();
  await offline(
    (origin, probes) => {
      if (probes.length <= 2) return Promise.reject(dns(new URL(origin).host));
      rmSync(c.down, { force: true });
      return up();
    },
    async ({ advance }) => {
      const s = await throughOutages("setup", () => sh(c.dir, c.command, { env: process.env }));
      assert.equal(s.ok, true);
      assert.equal(c.runs(), 2);
      // A later setup, the outage long over: it fails once and stands.
      advance(60_000);
      writeFileSync(c.down, "");
      const failed = await throughOutages("setup", () => sh(c.dir, c.command, { env: process.env }));
      assert.equal(failed.ok, false);
      assert.deepEqual(failed.up, [REGISTRY]);
      assert.equal(c.runs(), 3);
      assert.equal(upText(failed), "; the network was up (registry.test answered right after)");
    },
  );
});

test("the work and review stages run their setup through the outage wait and name the network in its Block", () => {
  for (const file of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", file), "utf8");
    assert.match(src, /const s = await throughOutages\("setup", \(\) => sh\(tree, inputs\.setup, /, file);
    assert.match(src, /setup failed[^`]*\$\{inputs\.setup\}[^`]*\$\{upText\(s\)\}`/, file);
  }
});

test("install: a process that does not wait outages out (no stage) probes nothing and fails as before", async () => {
  const c = checkout();
  const saved = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("no probe off a stage");
  try {
    resetNetwork();
    const r = await installDeps(c.dir, c.command, { env: process.env });
    assert.equal(r.ok, false);
    assert.match(r.reason, /exited 1$/);
  } finally {
    globalThis.fetch = saved;
  }
});

// The dispatch tick's own read cut off mid-answer (undici's "terminated", a socket that timed out): the client's
// retries, then the tick fails whole before it writes anything; serve logs it and the next tick reads again.
test("dispatch: a blocked-by read cut off mid-answer on every try fails the tick before any write", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const saved = { fetch: globalThis.fetch, api: process.env.GITHUB_API_URL, sleep: RETRY.sleep };
  process.env.GITHUB_API_URL = "https://api.github.test";
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
    if (/\/collaborators$/.test(u.pathname)) return Response.json([]);
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
