// #421: local mode answers two questions exactly. Can the local token write to any repository but this one (every
// listed repository probed, through the real client against a fake GitHub)? Is a claim's holder a process of this boot
// (the boot as proc.mjs bootId reads it, never a minute worked out from the uptime)?
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { TOKEN_PROBE_MAX, checkToken, deadHereHolder, holderId, machineIdentity } from "../scripts/local.mjs";

RETRY.sleep = async () => {};

/** GitHub listing `count` repositories for the token (acme/app, this one, among them) and answering each write probe by `probe(name)`. */
async function withGitHub({ count, probe, list = true }, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const probed = [];
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/user/repos") return list ? json([{ full_name: "acme/app" }, ...Array.from({ length: count - 1 }, (_, i) => ({ full_name: `dev/r${i + 1}` }))]) : json({ message: "Forbidden" }, 403);
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(u.pathname);
    if (m && init.method === "POST") {
      probed.push(m[1]);
      const status = probe(m[1]);
      return json({ message: status === 422 ? "Validation Failed" : "Not Found" }, status);
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

test("#421: checkToken probes every repository the token lists: one it can write that sorts past the first 20 refuses it", async () => {
  await withGitHub({ count: 31, probe: (n) => (n === "dev/r25" ? 422 : 404) }, async (probed) => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), /can write to 1 other repository \(dev\/r25\); limit it to acme\/app/);
    assert.equal(probed.length, 30, "every other repository, this one left out");
  });
  await withGitHub({ count: 31, probe: () => 404 }, async () => {
    await checkToken("acme/app", "github_pat_x");
  });
});

test("#421: checkToken never passes on a partial check: a listing that fails, more repositories than it probes, or a probe with no clear answer refuses the token", async () => {
  await withGitHub({ count: 3, probe: () => 404, list: false }, async (probed) => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), /could not be listed \(403\), so its reach is not verified/);
    assert.equal(probed.length, 0);
  });
  await withGitHub({ count: TOKEN_PROBE_MAX + 2, probe: () => 404 }, async (probed) => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), new RegExp(`lists ${TOKEN_PROBE_MAX + 1} other repositories, more than the ${TOKEN_PROBE_MAX} Factory probes`));
    assert.equal(probed.length, 0, "refused before any probe");
  });
  await withGitHub({ count: 3, probe: (n) => (n === "dev/r2" ? 400 : 404) }, async () => {
    await assert.rejects(checkToken("acme/app", "github_pat_x"), /write access to 1 other repository could not be probed \(dev\/r2: 400\)/);
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
  // Linux: the boot_id, as liveStage and the slots read it, in the holder's 12 characters.
  if (process.platform === "linux") assert.equal(machineIdentity().boot, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replace(/-/g, "").slice(0, 12));
});
