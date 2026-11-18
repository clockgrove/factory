import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GIT_RETRY, mergeTree, openOutbox, scratchHistory } from "../scripts/lib/outbox.mjs";

// #599: Pendulum's own git (the mirror's fetch and push, its scratch repositories') goes through the proxy the stage's
// Node fetch uses, and through no other.

/**
 * A real HTTP proxy on a loopback port. Each CONNECT gets its tunnel (200), whose first bytes are recorded and which is
 * then cut, since no upstream is real: `tunnels` holds each CONNECT's target and whether those bytes open a TLS
 * handshake. Every other request (a plain HTTP one, sent as an absolute URL) is in `plain` with its headers, answered 502.
 */
async function proxy() {
  const tunnels = [];
  const plain = [];
  const server = createServer((req, res) => (plain.push({ url: req.url, headers: req.headers }), res.writeHead(502).end()));
  server.on("connect", (req, sock, head) => {
    sock.on("error", () => {});
    const seen = { target: req.url, tls: null };
    tunnels.push(seen);
    const first = (b) => {
      // A TLS record of type handshake (22) whose first message is a ClientHello (1).
      seen.tls = b[0] === 0x16 && b[5] === 0x01;
      sock.destroy();
    };
    if (head.length) return void (sock.write("HTTP/1.1 200 Connection established\r\n\r\n"), first(head));
    sock.once("data", first);
    sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { tunnels, plain, url, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

/** Run `fn` with the stage process's env holding `vars` (an undefined value unset), restored after. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (all) => {
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(vars);
  try {
    return await fn();
  } finally {
    set(saved);
  }
}

const PROXY_NAMES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY"];
const none = Object.fromEntries(PROXY_NAMES.map((k) => [k, undefined]));
// A host no resolver answers: a direct try fails at its lookup, never reaching any network.
const HTTPS_REMOTE = "https://pendulum.invalid/o/r.git";
const HTTP_REMOTE = "http://pendulum.invalid/o/r.git";
const ID = "1".repeat(40);

test("#599: the mirror's fetch, and its scratch repositories', go through the stage's HTTPS_PROXY as a CONNECT tunnel carrying TLS", async () => {
  const p = await proxy();
  const root = mkdtempSync(join(tmpdir(), "mirror-proxy-"));
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "pendulum/1", work]);
  writeFileSync(join(work, "a.txt"), "a\n");
  const tries = GIT_RETRY.tries;
  GIT_RETRY.tries = 1;
  try {
    await withEnv({ ...none, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: p.url }, async () => {
      // The mirror's first network command (ls-remote) reaches the remote only through the proxy, so the outbox does not open.
      await assert.rejects(openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: work, remote: HTTPS_REMOTE, token: () => "t0ken", base: root }));
      assert.equal(await mergeTree({ remote: HTTPS_REMOTE, token: () => "t0ken", ours: ID, theirs: ID, base: root }), null);
      const scratch = await scratchHistory({ remote: HTTPS_REMOTE, token: () => "t0ken", base: root });
      try {
        assert.notEqual((await scratch.git(["fetch", "-q", "origin", ID])).code, 0);
      } finally {
        scratch.close();
      }
    });
    assert.ok(p.tunnels.length >= 3, JSON.stringify(p.tunnels));
    assert.deepEqual(new Set(p.tunnels.map((t) => JSON.stringify(t))), new Set([JSON.stringify({ target: "pendulum.invalid:443", tls: true })]));
    assert.deepEqual(p.plain, [], "nothing but CONNECT tunnels");
  } finally {
    GIT_RETRY.tries = tries;
    await p.close();
  }
});

test("#599: the proxy settings are exactly the stage's Node fetch's: lower case first, HTTP_PROXY too, NO_PROXY kept, none without NODE_USE_ENV_PROXY or from ALL_PROXY", async () => {
  const p = await proxy();
  const root = mkdtempSync(join(tmpdir(), "mirror-proxy-"));
  const through = async (vars, remote = HTTPS_REMOTE) => {
    const before = p.tunnels.length + p.plain.length;
    await withEnv({ ...none, ...vars }, () => mergeTree({ remote, ours: ID, theirs: ID, base: root }));
    return p.tunnels.length + p.plain.length > before;
  };
  try {
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", https_proxy: p.url }), true, "https_proxy");
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: p.url }), true, "https_proxy before HTTPS_PROXY");
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: p.url, https_proxy: "" }), false, "an empty https_proxy: no proxy, as Node's fetch reads it");
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: p.url, NO_PROXY: "pendulum.invalid" }), false, "NO_PROXY");
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: p.url, no_proxy: ".invalid" }), false, "no_proxy");
    assert.equal(await through({ HTTPS_PROXY: p.url, https_proxy: p.url, ALL_PROXY: p.url, all_proxy: p.url }), false, "no NODE_USE_ENV_PROXY: Node's fetch goes directly, and so does git");
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", ALL_PROXY: p.url, all_proxy: p.url }), false, "ALL_PROXY is not Node's fetch's");
    // Git reads http_proxy in lower case only; Node's fetch reads HTTP_PROXY too. No credential rides a plain request.
    assert.equal(await through({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: p.url }, HTTP_REMOTE), true, "HTTP_PROXY");
    assert.ok(p.plain.length > 0 && p.plain.every((r) => r.url.startsWith("http://pendulum.invalid/o/r.git/") && !r.headers.authorization), JSON.stringify(p.plain));
  } finally {
    await p.close();
  }
});
