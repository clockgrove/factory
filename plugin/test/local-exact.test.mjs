// #421: local mode answers two questions exactly. Can the local token write to any repository but this one (every
// listed repository probed, through the real client against a fake GitHub)? Is a claim's holder a process of this boot
// (the boot as proc.mjs bootId reads it, never a minute worked out from the uptime)?
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { LOCAL_BOUNDS } from "../scripts/lib/inputs.mjs";
import { bootId } from "../scripts/lib/proc.mjs";
import { checkToken, deadHereHolder, holderId, machineIdentity, thisBoot } from "../scripts/local.mjs";

const TOKEN_PROBE_MAX = LOCAL_BOUNDS.PENDULUM_LOCAL_TOKEN_PROBE_MAX.fallback;

RETRY.sleep = async () => {};

/**
 * GitHub listing `count` repositories for the token (acme/app, this one, among them), each with its person's permissions
 * `perms(name)` (push by default), or the listing `repos` as given, and answering each write probe by `probe(name)`:
 * a status, or `{status, headers}`.
 */
async function withGitHub({ count, probe, list = true, repos, perms = () => ({ admin: false, maintain: false, push: true, triage: true, pull: true }) }, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const probed = [];
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/user/repos") return list ? json(repos ?? [{ full_name: "acme/app", permissions: perms("acme/app") }, ...Array.from({ length: count - 1 }, (_, i) => ({ full_name: `dev/r${i + 1}`, permissions: perms(`dev/r${i + 1}`) }))]) : json({ message: "Forbidden" }, 403);
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(u.pathname);
    if (m && init.method === "POST") {
      probed.push(m[1]);
      const a = probe(m[1]);
      const { status, headers = {} } = typeof a === "number" ? { status: a } : a;
      return new Response(JSON.stringify({ message: status === 422 ? "Validation Failed" : status === 403 && headers["retry-after"] ? "You have exceeded a secondary rate limit" : "Not Found" }), { status, headers: { "content-type": "application/json", ...headers } });
    }
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(probed);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

test("#421: checkToken never passes on a partial check: a listing that fails, more repositories than it probes, or a probe with no clear answer refuses the token", async () => {
  await withGitHub({ count: 3, probe: () => 404, list: false }, async (probed) => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), /could not be listed \(403\), so its reach is not verified/);
    assert.equal(probed.length, 0);
  });
  await withGitHub({ count: TOKEN_PROBE_MAX + 2, probe: () => 404 }, async (probed) => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), new RegExp(`lists ${TOKEN_PROBE_MAX + 1} other repositories it could write to, more than the ${TOKEN_PROBE_MAX} Pendulum probes for write access \\(PENDULUM_LOCAL_TOKEN_PROBE_MAX\\)`));
    assert.equal(probed.length, 0, "refused before any probe");
  });
  await withGitHub({ count: 3, probe: (n) => (n === "dev/r2" ? 400 : 404) }, async () => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), /write access to 1 other repository could not be probed \(dev\/r2: 400\)/);
  });
});

test("#421: checkToken refuses a token that lists any other private repository, with no probe: a fine-grained token lists one only when granted it", async () => {
  const read = { admin: false, maintain: false, push: false, triage: false, pull: true };
  const repos = [
    { full_name: "acme/app", private: true, permissions: { ...read, push: true } },
    { full_name: "acme/secret", private: true, permissions: read },
    { full_name: "acme/other", private: false, permissions: read },
  ];
  await withGitHub({ repos, probe: () => 404 }, async (probed) => {
    const e = await checkToken("acme/app", "github_pat_x").then(() => null, (err) => err);
    assert.ok(e, "a token granted another private repository is refused");
    assert.match(e.message, /can reach 1 other private repository \(acme\/secret\); limit it to acme\/app/);
    assert.equal(e.again, undefined, "refused for good, not checked again");
    assert.deepEqual(probed, [], "no probe");
  });
  // This repository private and listed alone (or with public ones that pass) is the token it should be.
  await withGitHub({ repos: [repos[0], { full_name: "dev/lib", private: false, permissions: read }], probe: () => 404 }, async (probed) => {
    await checkToken("ACME/App", "github_pat_x");
    assert.deepEqual(probed, []);
  });
});

test("#421: a write probe GitHub's rate limit turns away is no answer: the token is refused as unverified, at once, and worth checking again", async () => {
  await withGitHub({ count: 3, probe: (n) => (n === "dev/r2" ? { status: 403, headers: { "retry-after": "60" } } : 404) }, async (probed) => {
    const e = await checkToken("acme/app", "github_pat_x").then(() => null, (err) => err);
    assert.ok(e, "a rate-limited probe never passes the token");
    assert.match(e.message, /write access to 1 other repository could not be probed \(dev\/r2: rate limited\); try again/);
    assert.equal(e.again, true);
    assert.equal(probed.filter((n) => n === "dev/r2").length, 1, "thrown at once, not waited out");
  });
  // A token that can write elsewhere is refused for good: not checked again.
  await withGitHub({ count: 3, probe: (n) => (n === "dev/r2" ? 422 : 404) }, async () => {
    const e = await checkToken("acme/app", "github_pat_x").then(() => null, (err) => err);
    assert.equal(e.again, undefined);
  });
});

test("#421: a claim holder's boot is proc.mjs bootId's (macOS: the boot time's exact second), the same at every call; with none, the pid alone decides", () => {
  const mac = machineIdentity({ boot: () => "1731450000" });
  assert.equal(mac.boot, "1731450000");
  assert.deepEqual(machineIdentity({ boot: () => "1731450000" }), mac, "never recomputed from the clock");
  // A live loop of this boot is alive; one of another boot is gone.
  const live = holderId(mac, process.pid);
  assert.equal(deadHereHolder(live, { id: mac, self: 1 }), false);
  assert.equal(deadHereHolder(live, { id: { ...mac, boot: "1731450001" }, self: 1 }), true);
  // No boot readable: no boot in the holder, and its pid is probed.
  const none = machineIdentity({ boot: () => null });
  assert.equal(none.boot, "");
  assert.equal(deadHereHolder(holderId(none, process.pid), { id: none, self: 1 }), false);
  // This process's boot, read once (a subprocess on macOS), is the one bootId reads.
  assert.equal(thisBoot(), bootId());
  // Linux: the boot_id, as liveStage and the slots read it, in the holder's 12 characters.
  if (process.platform === "linux") assert.equal(machineIdentity().boot, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replace(/-/g, "").slice(0, 12));
});
