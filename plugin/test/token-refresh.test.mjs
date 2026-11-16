// #405: every GitHub call of a stage carries the current token; a 401 on an App installation token gets one refresh
// and one retry, named in the log; the agent's token file is replaced whole. The real client (github.mjs), the real
// TokenKeeper and notice minter (minting against a fake GitHub App), and the real hand-off writer.
import "./temp.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY, removeLabel, rest } from "../scripts/lib/github.mjs";
import { logTo } from "../scripts/lib/inputs.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { TokenKeeper } from "../scripts/lib/token-keeper.mjs";

RETRY.sleep = async () => {};
const repo = { full: "o/r", owner: "o", name: "r" };
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * GitHub with the Factory App installed on o/r: it mints installation tokens ghs_1, ghs_2, ... (`expiresIn` ms each),
 * takes only the ones not revoked (`revoke`) and not expired, and answers 401 Bad credentials to any other. Every
 * request is recorded with its Authorization header.
 */
function github({ expiresIn = 60 * 60_000, notice = false } = {}) {
  const live = new Map();
  const asked = [];
  let minted = 0;
  const fetch = async (url, init = {}) => {
    const u = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method || "GET";
    const auth = String(new Headers(init.headers).get("authorization") || "");
    asked.push({ method, path: decodeURIComponent(u), auth });
    // The App's own calls (JWT): the App, its installation, a new token.
    if (u === "/app") return json(200, { slug: "factory", name: "Factory" });
    if (u === "/repos/o/r/installation") return json(200, { id: 1, account: { type: "Organization" }, permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read", organization_projects: "write" } });
    if (method === "POST" && u === "/app/installations/1/access_tokens") {
      minted += 1;
      const token = `ghs_${minted}`;
      live.set(token, Date.now() + expiresIn);
      const body = JSON.parse(init.body);
      return json(201, { token, expires_at: new Date(Date.now() + expiresIn).toISOString(), permissions: body.permissions || { issues: "write", metadata: "read" }, repositories: [{ full_name: "o/r" }] });
    }
    const token = /^Bearer (.*)$/.exec(auth)?.[1];
    if (!live.has(token) || live.get(token) <= Date.now()) return json(401, { message: "Bad credentials" });
    if (method === "DELETE" && /\/labels\//.test(u)) return new Response(null, { status: 204 });
    if (method === "GET" && /\/issues\/\d+\/comments/.test(u)) return json(200, []);
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(u)) return json(201, { id: 1, body: JSON.parse(init.body).body, user: { login: notice ? "factory[bot]" : "dev" } });
    if (method === "POST" && /\/labels$/.test(u)) return json(200, []);
    return json(404, { message: "Not Found" });
  };
  return { fetch, asked, live, revoke: (t) => live.delete(t), minted: () => minted, calls: () => asked.filter((a) => !a.path.startsWith("/app") && a.path !== "/repos/o/r/installation") };
}

async function withGitHub(gh, fn) {
  const real = globalThis.fetch;
  const lines = [];
  globalThis.fetch = gh.fetch;
  logTo({ write: (s) => lines.push(String(s)) });
  try {
    return { value: await fn(), lines };
  } finally {
    logTo(null);
    setSelf(null);
    globalThis.fetch = real;
  }
}

test("#405: a review stage that ends for a third-party review removes its label with the current App token, across a rotation and a 401", async () => {
  const { endForWait } = await import("../scripts/review.mjs");
  const gh = github();
  const { value, lines } = await withGitHub(gh, async () => {
    const keeper = await new TokenKeeper({ appId: "1", privateKey: KEY, owner: "o", repo: "r" }).start();
    keeper.stop();
    // The stage's request options, as review.mjs builds them.
    const opts = { token: keeper.getter, notice: null };
    // The installation token is replaced (another mint, an expiry): GitHub no longer takes the one the keeper holds.
    gh.revoke("ghs_1");
    return endForWait({ repo, issue: 7, prNumber: 12, labels: [{ name: "factory:objective" }, { name: "factory:in-review" }], opts });
  });
  assert.deepEqual(value, { ok: true }, "the stage ends waiting: its label is off");
  const calls = gh.calls();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path} ${c.auth}`),
    ["DELETE /repos/o/r/issues/12/labels/factory:review Bearer ghs_1", "DELETE /repos/o/r/issues/12/labels/factory:review Bearer ghs_2"],
    "the label's DELETE goes with the App token, is refused, and goes once more with a new one",
  );
  assert.equal(gh.minted(), 2, "one refresh");
  assert.ok(lines.some((l) => /GitHub DELETE repos\/o\/r\/issues\/12\/labels\/factory%3Areview: HTTP 401 on the App installation token; refreshed it, trying once more/.test(l)), lines.join(""));
  assert.ok(!lines.join("").includes("ghs_"), "no token in the log");
});

test("#405: a 401 is refreshed once, and only on a minted App token: a second 401 is the call's failure, a fixed token's is at once", async () => {
  const gh = github();
  await withGitHub(gh, async () => {
    const keeper = await new TokenKeeper({ appId: "1", privateKey: KEY, owner: "o", repo: "r" }).start();
    keeper.stop();
    // GitHub refuses every token: one refresh, then the 401 stands.
    const realFetch = gh.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes("/labels/") ? json(401, { message: "Bad credentials" }) : realFetch(url, init));
    await assert.rejects(removeLabel(repo, 12, "factory:review", { token: keeper.getter }), (e) => e.status === 401);
    assert.equal(gh.minted(), 2, "one refresh, no more");
    // A token the keeper was given (local mode's, a launcher's) cannot be refreshed here: one request, no mint.
    const fixed = await new TokenKeeper({ fixedToken: "github_pat_x", owner: "o", repo: "r" }).start();
    const before = gh.asked.length;
    await assert.rejects(removeLabel(repo, 12, "factory:review", { token: fixed.getter }), (e) => e.status === 401);
    assert.equal(gh.asked.length, before, "the fake saw no extra request");
    assert.equal(gh.minted(), 2);
  });
});

test("#405: a token refreshed while a call was in flight is the retry's, with no second mint; a token at its expiry is refreshed before the call", async () => {
  const gh = github({ expiresIn: 30_000 });
  const { lines } = await withGitHub(gh, async () => {
    const keeper = await new TokenKeeper({ appId: "1", privateKey: KEY, owner: "o", repo: "r" }).start();
    keeper.stop();
    // ghs_1 expires within the minute: the call mints first and never sends it.
    await removeLabel(repo, 12, "factory:review", { token: keeper.getter });
    assert.deepEqual(gh.calls().map((c) => c.auth), ["Bearer ghs_2"]);
    assert.equal(gh.minted(), 2);
    // The keeper's timer refreshes while a request with the older token is in flight; GitHub refuses that one.
    keeper.expiresAt = Date.now() + 60 * 60_000;
    const realFetch = gh.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/labels/") && gh.minted() === 2) {
        await keeper.refresh();
        keeper.expiresAt = Date.now() + 60 * 60_000;
        gh.revoke("ghs_2");
      }
      return realFetch(url, init);
    };
    await removeLabel(repo, 12, "factory:review", { token: keeper.getter });
    assert.deepEqual(gh.calls().slice(1).map((c) => c.auth), ["Bearer ghs_2", "Bearer ghs_3"]);
    assert.equal(gh.minted(), 3, "the timer's mint only");
  });
  assert.ok(lines.some((l) => /HTTP 401 on the App installation token; it was refreshed meanwhile, trying once more/.test(l)), lines.join(""));
});

test("#405: a stage's request options passed as the token itself are refused before any request", async () => {
  const gh = github();
  await withGitHub(gh, async () => {
    await assert.rejects(rest("repos/o/r/issues/12/labels/x", { method: "DELETE", token: { token: () => "ghs_1", notice: null } }), TypeError);
    await assert.rejects(rest("repos/o/r", { token: () => ({ token: "ghs_1" }) }), TypeError);
  });
  assert.equal(gh.asked.length, 0, "nothing was sent");
});

test("#405: local mode's notice token refused with 401 is minted again by the parent over the stage's channel, and the notice still posts as the App", async () => {
  const { EventEmitter } = await import("node:events");
  const { noticeFromParent, noticeMinter, serveNotices } = await import("../scripts/lib/app-token.mjs");
  const { noticePost } = await import("../scripts/lib/session.mjs");
  const { upsertComment } = await import("../scripts/lib/github.mjs");
  const gh = github({ notice: true });
  const { value, lines } = await withGitHub(gh, async () => {
    // The parent (local.mjs) and the stage, joined by an in-process channel with Node's IPC shape.
    const parent = new EventEmitter();
    const stage = new EventEmitter();
    parent.send = (m, cb) => {
      setImmediate(() => stage.emit("message", structuredClone(m)));
      cb?.();
    };
    stage.send = (m, cb) => {
      setImmediate(() => parent.emit("message", structuredClone(m)));
      cb?.();
    };
    stage.channel = { unref() {} };
    serveNotices(parent, noticeMinter({ appId: "1", privateKey: KEY, owner: "o", repo: "r" }));
    const notice = noticeFromParent({ proc: stage });
    // The stage holds ghs_1 from an earlier notice; GitHub has since stopped taking it.
    assert.equal((await notice()).token, "ghs_1");
    gh.revoke("ghs_1");
    return noticePost({ notice, token: "github_pat_local", what: "Blocked notice", post: (o) => upsertComment(repo, 7, "<!-- factory:7:blocked:x -->", "Blocked", o) });
  });
  assert.match(value.body, /Blocked$/);
  assert.deepEqual(
    gh.calls().map((c) => `${c.method} ${c.auth}`),
    ["GET Bearer ghs_1", "GET Bearer ghs_2", "POST Bearer ghs_2"],
    "the App's refused read goes once more with a new App token, and the notice posts as the App, never with the local token",
  );
  assert.equal(gh.minted(), 2);
  assert.ok(lines.some((l) => /HTTP 401 on the App installation token; refreshed it, trying once more/.test(l)), lines.join(""));
});

test("#405: the agent's token file is replaced whole: a reader that opened the old one reads it all, the path gives the new one, nothing else is left", async () => {
  const { putFiles } = await import("../scripts/lib/handoff.mjs");
  const { readTokenFiles } = await import("../scripts/lib/agent.mjs");
  const home = mkdtempSync(join(tmpdir(), "factory-agent-home-"));
  mkdirSync(join(home, ".factory"));
  const file = join(home, ".factory", "read-token");
  writeFileSync(file, "ghs_old_read_token\n");
  const before = statSync(file).ino;
  // A reader mid-read (git's credential helper running `cat`) holds the old file open.
  const fd = openSync(file, "r");
  try {
    const replace = Object.fromEntries(Object.entries(readTokenFiles(home, "ghs_new_read_token").files).map(([k, text]) => [k, { text, replace: true }]));
    await putFiles(home, replace, { PATH: process.env.PATH });
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    assert.equal(buf.subarray(0, n).toString(), "ghs_old_read_token\n", "the open reader sees the old token whole, never a cut or empty one");
  } finally {
    closeSync(fd);
  }
  assert.equal(readFileSync(file, "utf8"), "ghs_new_read_token\n");
  assert.notEqual(statSync(file).ino, before, "a new file renamed over the old");
  assert.deepEqual(readdirSync(join(home, ".factory")), ["read-token"], "no temporary file is left");
  assert.match(readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"), /oauth_token: ghs_new_read_token/);
});
