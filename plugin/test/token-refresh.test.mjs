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
import { PROPAGATION, RETRY, removeLabel, rest } from "../scripts/lib/github.mjs";
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

test("#405: the review stage's third-party step, ending for a review still to come, takes its label off with the current App token across a rotation, a 401 and GitHub's delay with the new token", async () => {
  const { thirdPartyGate } = await import("../scripts/review.mjs");
  let gh;
  // The token is replaced elsewhere (another mint, an expiry) once the wait is recorded; GitHub is slow to take the new one.
  gh = github({ delay: (t) => (t === "ghs_1" ? 0 : 1), onRequest: (r) => r.method === "POST" && r.path.endsWith("/comments") && gh.revoke("ghs_1") });
  const progress = [];
  let stopChecked = 0;
  const { value, lines } = await withGitHub(gh, async () => {
    // ghs_1 is old: GitHub has it everywhere.
    const keeper = await keeperOf();
    // The stage's request options and arguments, as review.mjs main builds them.
    return thirdPartyGate({ repo, issue: 7, pr: { number: 12, head: { sha: "a".repeat(40) } }, labels: [{ name: "pendulum:objective" }, { name: "pendulum:in-review" }], names: ["greptile-apps[bot]"], own: async () => ["pendulum[bot]"], skip: false, progress: async (l) => progress.push(l), opts: { token: keeper.getter, notice: null }, beforeEnd: async () => (stopChecked += 1) });
  });
  assert.deepEqual(value.wait.missing, ["greptile-apps[bot]"], "the stage ends waiting");
  assert.equal(stopChecked, 1, "the stop check came first");
  assert.match(progress.at(-1), /third-party review: waiting until/);
  assert.deepEqual(
    auths(gh.calls()),
    [
      "GET /repos/o/r/pulls/12/reviews ghs_1",
      "GET /repos/o/r/issues/12/comments ghs_1",
      "POST /repos/o/r/issues/12/comments ghs_1",
      "DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_1",
      "DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_2",
      "DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_2",
    ],
    "the label's DELETE is refused with the replaced token, refused once with the new one while GitHub spreads it, then done",
  );
  assert.equal(gh.calls().at(-1).status, 204);
  assert.equal(gh.minted(), 2, "one refresh");
  assert.deepEqual(slept, [PROPAGATION.stepMs]);
  said(lines, /GitHub DELETE repos\/o\/r\/issues\/12\/labels\/pendulum%3Areview: HTTP 401 on the App installation token; refreshed it, trying once more/);
  said(lines, /GitHub DELETE repos\/o\/r\/issues\/12\/labels\/pendulum%3Areview: HTTP 401 on an App installation token minted \d+\.\d s before; GitHub may not have it everywhere yet, so the same token goes again in 1 s \(wait 1 of 3\)/);
  assert.ok(!lines.join("").includes("ghs_"), "no token in the log");
});

test("#405: a burst of 401s on a token GitHub has just made sends the same token again and mints nothing; one that stays refused fails after octokit's waits", async () => {
  const gh = github({ delay: () => 3 });
  const { lines } = await withGitHub(gh, async () => {
    const keeper = await keeperOf({ age: 0 });
    await Promise.all([1, 2, 3, 4, 5].map((n) => removeLabel(repo, n, "pendulum:review", { token: keeper.getter })));
    assert.equal(gh.minted(), 1, "no call minted");
    assert.ok(gh.calls().every((c) => c.auth === "Bearer ghs_1"));
    assert.equal(gh.calls().filter((c) => c.status === 204).length, 5, "each call done");
    // Refused past GitHub's delay: three waits (1, 2, 3 s), then the 401 is the call's, still with no mint.
    gh.revoke("ghs_1");
    slept.length = 0;
    const before = gh.calls().length;
    await assert.rejects(removeLabel(repo, 9, "pendulum:review", { token: keeper.getter }), (e) => e.status === 401);
    assert.equal(gh.calls().length - before, 1 + PROPAGATION.tries);
    assert.deepEqual(slept, [1000, 2000, 3000]);
    assert.equal(gh.minted(), 1);
  });
  said(lines, /wait 3 of 3/);
});

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

test("#405: a mint whose read-only token or hand-over then fails still replaced the write token: the call goes on with it, and the failure is logged", async () => {
  const gh = github();
  let handOvers = 0;
  const { lines } = await withGitHub(gh, async () => {
    const keeper = await keeperOf({
      onRefresh: async () => {
        handOvers += 1;
        if (handOvers > 1) throw new Error("putFiles failed");
      },
    });
    gh.revoke("ghs_1");
    await removeLabel(repo, 12, "pendulum:review", { token: keeper.getter });
  });
  assert.deepEqual(auths(gh.calls()), ["DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_1", "DELETE /repos/o/r/issues/12/labels/pendulum:review ghs_2"]);
  said(lines, /HTTP 401 on the App installation token; refreshed it \(what follows a mint failed: putFiles failed\), trying once more/);
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

test("#405: local mode's notice token refused with 401 is minted again by the parent over the stage's channel, and the notice still posts as the App", async () => {
  const { EventEmitter } = await import("node:events");
  const { noticeFromParent, noticeMinter, serveNotices } = await import("../scripts/lib/app-token.mjs");
  const { noticePost } = await import("../scripts/lib/session.mjs");
  const { upsertComment } = await import("../scripts/lib/github.mjs");
  const gh = github();
  const realNow = Date.now;
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
    // The stage held ghs_1 from a notice ten minutes ago; GitHub has since stopped taking it.
    const first = await notice();
    assert.equal(first.token, "ghs_1");
    assert.ok(Number.isFinite(first.mintedAt), "the parent says when it minted it");
    Date.now = () => realNow() + TEN_MIN;
    gh.revoke("ghs_1");
    try {
      return await noticePost({ notice, token: "github_pat_local", what: "Blocked notice", post: (o) => upsertComment(repo, 7, "<!-- pendulum:7:blocked:x -->", "Blocked", o) });
    } finally {
      Date.now = realNow;
    }
  });
  assert.match(value.body, /Blocked$/);
  assert.deepEqual(auths(gh.calls()), ["GET /repos/o/r/issues/7/comments ghs_1", "GET /repos/o/r/issues/7/comments ghs_2", "POST /repos/o/r/issues/7/comments ghs_2"], "the App's refused read goes once more with a new App token, and the notice posts as the App, never with the local token");
  assert.equal(gh.minted(), 2);
  said(lines, /HTTP 401 on the App installation token; refreshed it, trying once more/);
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
