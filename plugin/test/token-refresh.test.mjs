// #405: every GitHub call of a stage carries the current token. A 401 on an App installation token GitHub has just made
// sends the same token again (GitHub's delay); any other gets one refresh and one retry; each is named in the log. The
// agent's token file is replaced whole. The real client (github.mjs), the real TokenKeeper and notice minter (minting
// against a fake GitHub App), the review stage's real third-party step, and the real hand-off writer.
import "./temp.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY, removeLabel, rest } from "../scripts/lib/github.mjs";
import { logTo } from "../scripts/lib/inputs.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { TokenKeeper } from "../scripts/lib/token-keeper.mjs";

const slept = [];
RETRY.sleep = async (ms) => {
  slept.push(ms);
};
const repo = { full: "o/r", owner: "o", name: "r" };
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const TEN_MIN = 10 * 60_000;

/**
 * GitHub with the Pendulum App installed on o/r. It mints installation tokens ghs_1, ghs_2, ... (`expiresIn` ms each) and
 * takes only the ones not revoked (`revoke`) and not expired, answering 401 Bad credentials to any other. A token is
 * also refused for its first `delay(token)` uses, as GitHub does while it spreads a new token to its servers. `skewMs`: GitHub's
 * clock ahead of this machine's, in its Date header. Every request is recorded with its Authorization header; `onRequest`
 * runs after each is answered.
 */
function github({ expiresIn = 60 * 60_000, delay = () => 0, skewMs = 0, onRequest = () => {} } = {}) {
  const live = new Map();
  const uses = new Map();
  const asked = [];
  const comments = [];
  let minted = 0;
  const json = (status, data) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", date: new Date(Date.now() + skewMs).toUTCString() } });
  const answer = async (u, method, init, auth) => {
    // The App's own calls (JWT): the App, its installation, a new token.
    if (u === "/app") return json(200, { slug: "pendulum", name: "Pendulum" });
    if (u === "/repos/o/r/installation") return json(200, { id: 1, account: { type: "Organization" }, permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read", organization_projects: "write" } });
    if (method === "POST" && u === "/app/installations/1/access_tokens") {
      minted += 1;
      const token = `ghs_${minted}`;
      live.set(token, Date.now() + expiresIn);
      const body = JSON.parse(init.body);
      return json(201, { token, expires_at: new Date(Date.now() + skewMs + expiresIn).toISOString(), permissions: body.permissions || { issues: "write", metadata: "read" }, repositories: [{ full_name: "o/r" }] });
    }
    const token = /^Bearer (.*)$/.exec(auth)?.[1];
    uses.set(token, (uses.get(token) || 0) + 1);
    if (!live.has(token) || live.get(token) <= Date.now() || uses.get(token) <= delay(token)) return json(401, { message: "Bad credentials" });
    if (method === "DELETE" && /\/labels\//.test(u)) return json(204);
    if (method === "GET" && /\/pulls\/\d+\/reviews/.test(u)) return json(200, []);
    if (method === "GET" && /\/issues\/\d+\/comments/.test(u)) return json(200, comments);
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(u)) {
      const c = { id: 100 + comments.length, body: JSON.parse(init.body).body, user: { login: "pendulum[bot]", type: "Bot" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      comments.push(c);
      return json(201, c);
    }
    if (method === "POST" && /\/labels$/.test(u)) return json(200, []);
    return json(404, { message: "Not Found" });
  };
  const fetch = async (url, init = {}) => {
    const u = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method || "GET";
    const auth = String(new Headers(init.headers).get("authorization") || "");
    const r = await answer(u, method, init, auth);
    asked.push({ method, path: decodeURIComponent(u), auth, status: r.status });
    onRequest(asked.at(-1));
    return r;
  };
  return { fetch, asked, comments, revoke: (t) => live.delete(t), minted: () => minted, calls: () => asked.filter((a) => !a.path.startsWith("/app") && a.path !== "/repos/o/r/installation") };
}

async function withGitHub(gh, fn) {
  const real = globalThis.fetch;
  const lines = [];
  globalThis.fetch = gh.fetch;
  slept.length = 0;
  logTo({ write: (s) => lines.push(String(s)) });
  try {
    return { value: await fn(), lines };
  } finally {
    logTo(null);
    setSelf(null);
    globalThis.fetch = real;
  }
}

/** A keeper for o/r, minted from the fake App; `age` (ms): how long ago its first token was minted. */
async function keeperOf({ age = TEN_MIN, onRefresh = null } = {}) {
  const keeper = await new TokenKeeper({ appId: "1", privateKey: KEY, owner: "o", repo: "r", onRefresh }).start();
  keeper.stop();
  keeper.mintedAt -= age;
  return keeper;
}

const said = (lines, re) => assert.ok(lines.some((l) => re.test(l)), lines.join(""));
const auths = (calls) => calls.map((c) => `${c.method} ${c.path.replace(/\?.*/, "")} ${c.auth.replace(/^Bearer /, "")}`);

test("#405: a 401 is refreshed once, and only on a minted App token: a second 401 is the call's failure, a fixed token's is at once", async () => {
  const gh = github();
  await withGitHub(gh, async () => {
    const keeper = await keeperOf();
    // GitHub refuses every token: one refresh, the new token's delay waited for, then the 401 stands.
    const realFetch = gh.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes("/labels/") ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) : realFetch(url, init));
    await assert.rejects(removeLabel(repo, 12, "pendulum:review", { token: keeper.getter }), (e) => e.status === 401);
    assert.equal(gh.minted(), 2, "one refresh, no more");
    // A token the keeper was given (local mode's, a launcher's) cannot be refreshed here: one request, no mint.
    const fixed = await new TokenKeeper({ fixedToken: "github_pat_x", owner: "o", repo: "r" }).start();
    let sent = 0;
    globalThis.fetch = async () => {
      sent += 1;
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    };
    await assert.rejects(removeLabel(repo, 12, "pendulum:review", { token: fixed.getter }), (e) => e.status === 401);
    assert.equal(sent, 1);
    assert.equal(gh.minted(), 2);
  });
});

test("#405: a token refreshed while a call was in flight is the retry's, with no second mint; a token at its expiry on GitHub's clock is refreshed before the call", async () => {
  // GitHub's clock is 10 minutes ahead of this machine's; its tokens live 15 minutes by its clock.
  const gh = github({ expiresIn: 15 * 60_000, skewMs: TEN_MIN });
  const { lines } = await withGitHub(gh, async () => {
    const keeper = await keeperOf();
    // An answer carries GitHub's Date: ghs_1 has 15 minutes left on its clock, so it is used as it is.
    await rest("repos/o/r/pulls/12/reviews?per_page=100", { token: keeper.getter });
    assert.equal(gh.minted(), 1);
    // Later: GitHub's expires_at is 30 s ahead on its clock, ten and a half minutes ahead on this machine's. It is at its
    // expiry, so it is refreshed first.
    keeper.expiresAt = Date.now() + TEN_MIN + 30_000;
    await removeLabel(repo, 12, "pendulum:review", { token: keeper.getter });
    assert.deepEqual(auths(gh.calls()).slice(1), ["DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_2"]);
    assert.equal(gh.minted(), 2);
    // The keeper's timer refreshes while a request with the older token is in flight; GitHub refuses that one.
    keeper.mintedAt -= TEN_MIN;
    const realFetch = gh.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/labels/") && gh.minted() === 2) {
        await keeper.refresh();
        gh.revoke("ghs_2");
      }
      return realFetch(url, init);
    };
    await removeLabel(repo, 12, "pendulum:review", { token: keeper.getter });
    assert.deepEqual(auths(gh.calls()).slice(2), ["DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_2", "DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_3"]);
    assert.equal(gh.minted(), 3, "the timer's mint only");
    // GitHub's clock as this machine's again, for the tests after.
    globalThis.fetch = github().fetch;
    await rest("repos/o/r", { token: "x" }).catch(() => {});
  });
  said(lines, /HTTP 401 on the App installation token; it was refreshed meanwhile, trying once more/);
});

test("#405: a stage's request options passed as the token itself are refused before any request", async () => {
  const gh = github();
  await withGitHub(gh, async () => {
    await assert.rejects(rest("repos/o/r/issues/12/labels/x", { method: "DELETE", token: { token: () => "ghs_1", notice: null } }), TypeError);
    await assert.rejects(rest("repos/o/r", { token: () => ({ token: "ghs_1" }) }), TypeError);
  });
  assert.equal(gh.asked.length, 0, "nothing was sent");
});

test("#405: the agent's token file is replaced whole: a reader that opened the old one reads it all, the path gives the new one, nothing else is left", async () => {
  const { putFiles } = await import("../scripts/lib/handoff.mjs");
  const { readTokenFiles } = await import("../scripts/lib/agent.mjs");
  const home = mkdtempSync(join(tmpdir(), "pendulum-agent-home-"));
  mkdirSync(join(home, ".pendulum"));
  const file = join(home, ".pendulum", "read-token");
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
  assert.deepEqual(readdirSync(join(home, ".pendulum")), ["read-token"], "no temporary file is left");
  assert.match(readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"), /oauth_token: ghs_new_read_token/);
});
