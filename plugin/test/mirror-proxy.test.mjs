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
 * A real HTTP proxy on a loopback port, with every byte it receives in `raw`. `auth`: each CONNECT is refused with a
 * 407 asking for Basic proxy credentials, the connection kept open for a retry, which is cut. Else each CONNECT gets its
 * tunnel (200), whose first bytes are recorded and which is then cut, since no upstream is real. `tunnels` holds each
 * CONNECT's target, its headers and whether the tunnel's first bytes open a TLS handshake. Every other request (a plain
 * HTTP one, sent as an absolute URL) is in `plain` with its headers, answered 502. `close` destroys every connection, a
 * tunnel's included (a server's closeAllConnections leaves those).
 */
async function proxy({ auth = false } = {}) {
  const tunnels = [];
  const plain = [];
  const raw = [];
  const sockets = new Set();
  const server = createServer((req, res) => (plain.push({ url: req.url, headers: req.headers }), res.writeHead(502).end()));
  server.on("connection", (sock) => (sockets.add(sock), sock.on("data", (b) => raw.push(Buffer.from(b)))));
  server.on("connect", (req, sock, head) => {
    sock.on("error", () => {});
    const seen = { target: req.url, headers: req.headers, tls: null };
    tunnels.push(seen);
    if (auth) {
      sock.once("data", () => sock.destroy());
      return void sock.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\nContent-Length: 0\r\n\r\n');
    }
    const first = (b) => {
      // A TLS record of type handshake (22) whose first message is a ClientHello (1).
      seen.tls = b[0] === 0x16 && b[5] === 0x01;
      sock.destroy();
    };
    sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head.length) first(head);
    else sock.once("data", first);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const count = () => tunnels.length + plain.length;
  return { tunnels, plain, raw, url, count, close: () => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(r))) };
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
const ID = "1".repeat(40);
const TOKEN = "t0ken-599-never-at-the-proxy";

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
      await assert.rejects(openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: work, remote: HTTPS_REMOTE, token: () => TOKEN, base: root }));
      assert.equal(await mergeTree({ remote: HTTPS_REMOTE, token: () => TOKEN, ours: ID, theirs: ID, base: root }), null);
      const scratch = await scratchHistory({ remote: HTTPS_REMOTE, token: () => TOKEN, base: root });
      try {
        assert.notEqual((await scratch.git(["fetch", "-q", "origin", ID])).code, 0);
      } finally {
        scratch.close();
      }
    });
    assert.ok(p.tunnels.length >= 3, JSON.stringify(p.tunnels));
    assert.deepEqual(new Set(p.tunnels.map((t) => JSON.stringify({ target: t.target, tls: t.tls }))), new Set([JSON.stringify({ target: "pendulum.invalid:443", tls: true })]));
    assert.deepEqual(p.plain, [], "nothing but CONNECT tunnels");
  } finally {
    GIT_RETRY.tries = tries;
    await p.close();
  }
});

// GitHub's own URL, the one the token's credential helper answers for. The proxy never connects anywhere (git connects
// to github.com directly only without this fix).
test("#599: the mirror's GitHub token never reaches the proxy: no CONNECT carries a credential, a 407 gets no token, and no byte holds it", async () => {
  const remote = "https://github.com/o/r.git";
  const forms = [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString("base64"), Buffer.from(TOKEN).toString("base64")];
  const tries = GIT_RETRY.tries;
  GIT_RETRY.tries = 1;
  try {
    for (const auth of [false, true]) {
      const p = await proxy({ auth });
      const root = mkdtempSync(join(tmpdir(), "mirror-proxy-"));
      try {
        await withEnv({ ...none, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: p.url }, async () => {
          await assert.rejects(openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: root, remote, token: () => TOKEN, base: root }));
          assert.equal(await mergeTree({ remote, token: () => TOKEN, ours: ID, theirs: ID, base: root }), null);
        });
        assert.ok(p.tunnels.length >= 2, JSON.stringify(p.tunnels));
        for (const t of p.tunnels) {
          assert.equal(t.target, "github.com:443");
          assert.equal(t.headers.authorization, undefined);
          assert.equal(t.headers["proxy-authorization"], undefined);
          if (!auth) assert.equal(t.tls, true);
        }
        assert.deepEqual(p.plain, []);
        const bytes = Buffer.concat(p.raw).toString("latin1");
        for (const f of forms) assert.ok(!bytes.includes(f), `the proxy saw ${f}`);
      } finally {
        await p.close();
      }
    }
  } finally {
    GIT_RETRY.tries = tries;
  }
});

