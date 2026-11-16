import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Local } from "../scripts/local.mjs";
import { stopHold } from "../scripts/lib/local.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { OUTAGE } from "../scripts/lib/network.mjs";
import { fakeProc } from "./fixtures/machine.mjs";
import { refusingOrigin } from "./ports.mjs";
import { accountHolds, holdsDir } from "../scripts/lib/holds.mjs";

// The API client retries a failed read (lib/github.mjs RETRY): no real waits here. A fake that must fail a whole read
// fails every one of its tries.
RETRY.sleep = async () => {};

/**
 * A GitHub that keeps one Objective's labels and can show the issues listing a stale view of them (a read from before a
 * stage's exit labels landed). `view(read, labels)` is the listing's labels on its read-th call; `onList(read)` runs
 * after each listing. A single-issue read always shows the current labels; `onIssue(read)` runs after it.
 */
async function fakeGitHub({ view, onList, onIssue = () => {}, extra = () => false }) {
  const labels = new Set(["factory:objective"]);
  const timeline = [];
  const writes = [];
  let reads = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body));
      if (extra(req, url, send)) return;
      const issue = (shown) => ({ number: 7, title: "t", body: "", state: "open", labels: shown.map((name) => ({ name })), updated_at: new Date().toISOString() });
      const label = /^\/repos\/o\/r\/issues\/7\/labels(?:\/(.+))?$/.exec(url.pathname);
      if (label && req.method === "POST") {
        for (const l of JSON.parse(raw).labels) labels.add(l), timeline.push({ event: "labeled", label: { name: l }, created_at: new Date().toISOString() });
        writes.push({ read: reads, op: "add", labels: JSON.parse(raw).labels });
        return send(200, []);
      }
      if (label && req.method === "DELETE") {
        const l = decodeURIComponent(label[1]);
        if (!labels.has(l)) return send(404, { message: "Not Found" });
        labels.delete(l);
        writes.push({ read: reads, op: "remove", labels: [l] });
        return send(200, []);
      }
      if (url.pathname === "/repos/o/r/issues/7/timeline") return send(200, timeline);
      if (url.pathname === "/repos/o/r/issues/7" && req.method === "GET") {
        send(200, issue([...labels]));
        return onIssue(reads, { labels, timeline });
      }
      // The dispatcher's other listings (the stopped pass's state labels) see the current labels, and are no Objectives read.
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("state") === "open" && url.searchParams.get("labels") !== "factory:objective") return send(200, labels.has(url.searchParams.get("labels")) ? [issue([...labels])] : []);
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("state") === "open") {
        reads += 1;
        send(200, [issue(view(reads, [...labels]))]);
        return onList(reads, { labels, timeline });
      }
      if (url.pathname === "/graphql") return send(200, { data: {} });
      if (req.method !== "GET") return send(200, {});
      return send(200, []);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { labels, timeline, writes, reads: () => reads, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

/** This machine's holds (in memory) with `account`'s usage limit spent for the next hour, as a stage here would leave it. */
function heldOn(account) {
  const holds = accountHolds();
  holds.limit({ harness: account, account, reset: Date.now() + 60 * 60_000, now: Date.now() });
  return holds;
}

/** The labels a listing from before the stage's exit labels landed shows: no state label at all. */
const stopLabels = (all) => all.filter((l) => !l.startsWith("factory:") || l === "factory:objective");
const answerAt = (read, at, timeline) => {
  // A maintainer answers by re-applying the Objective label.
  if (read === at) timeline.push({ event: "labeled", label: { name: "factory:objective" }, created_at: new Date().toISOString() });
};

/**
 * Run the real serve and dispatch against `fakeGitHub` until `stopAfter` listings or a second claim. `firstStage(fake)`
 * is the first claim's stage; a later claim ends at once. `pausedHere(fake)` runs at the start of every tick; `stubs`
 * replace more of the loop.
 */
async function serveAgainst({ view, onList = () => {}, onIssue, extra, firstStage, pausedHere = async () => [], stopAfter = 8, stubs = {} }) {
  const env = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL };
  const claims = [];
  const lines = [];
  const fake = await fakeGitHub({
    view,
    onIssue,
    extra,
    onList: (read, state) => {
      onList(read, state);
      if (read >= stopAfter) loop.stopping = true;
    },
  });
  process.env.GITHUB_API_URL = fake.url;
  process.env.FACTORY_LOCAL = "1";
  process.env.FACTORY_LOCAL_ALL = "1";
  const loop = Object.assign(Object.create(Local.prototype), {
    repo: { owner: "o", name: "r", full: "o/r" },
    repoFull: "o/r",
    token: "t",
    notice: null,
    second: null,
    wf: { FACTORY_LOCAL_MAX_CONCURRENT: "2" },
    // A machine of its own (lib/machine.mjs): this one's slots and load are never read or held.
    machine: { home: mkdtempSync(join(tmpdir(), "home-")), proc: fakeProc(mkdtempSync(join(tmpdir(), "proc-"))) },
    opts: { token: "t" },
    children: new Set(),
    baseEnv: () => ({ FACTORY_LOCAL_ALL: "1", FACTORY_INPUT_MAX_CONCURRENT: "2" }),
    cleanup: async () => {},
    pausedHere: () => pausedHere(fake),
    pendingReviews: async () => [],
    runObjective: (n) => {
      claims.push({ n, read: fake.reads() });
      if (claims.length > 1) {
        loop.stopping = true;
        return Promise.resolve({ exit: "delivered" });
      }
      return firstStage(fake);
    },
    ...stubs,
  });
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    await loop.serve({ intervalMs: 5 });
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await fake.close();
  }
  const questionRemoved = fake.writes.filter((w) => w.op === "remove" && w.labels.includes("factory:question")).map((w) => w.read);
  return { claims: claims.map((c) => c.read), questionRemoved, lines, labels: [...fake.labels] };
}

test("stopHold: a Question or a Block holds the Objective; any other end does not", () => {
  assert.match(stopHold({ exit: "question" }), /Question/);
  assert.match(stopHold({ exit: "blocked" }), /Blocked/);
  for (const r of [{ exit: "delivered" }, { exit: "skipped" }, { exit: null }, null, undefined]) assert.equal(stopHold(r), null);
});

test("serve: a Question exit is never re-claimed by a tick that read the issue before its labels landed; a trusted answer re-claims it (#2667)", async () => {
  let stageEnd = null;
  const run = await serveAgainst({
    // 2: the stage cleared Running and has not yet labelled its Question (setStateLabel's gap); 3: a stale listing
    // after the Question landed; from 4 the listing is current.
    view: (read, labels) => (read === 2 || read === 3 ? stopLabels(labels) : labels),
    onList: (read, { labels, timeline }) => {
      if (read === 2) {
        // The stage ends with its Question while this tick's dispatch is still under way.
        labels.add("factory:question");
        timeline.push({ event: "labeled", label: { name: "factory:question" }, created_at: new Date(Date.now() - 60_000).toISOString() });
        stageEnd({ exit: "question" });
      }
      answerAt(read, 5, timeline);
    },
    firstStage: (fake) => {
      // The stage's exit: Running comes off first, then (on the next listing) its Question goes on.
      fake.labels.delete("factory:running");
      return new Promise((ok) => (stageEnd = ok));
    },
  });
  assert.deepEqual(run.claims, [1, 5], "claimed once, then again only after the answer");
  assert.deepEqual(run.questionRemoved, [5], "factory:question stays until the answer");
  assert.ok(run.lines.some((l) => /tick: nothing ready; holding #7 \(its stage here ended with a Question/.test(l)), "the tick line names the hold");
});

test("serve: a stop recorded while a dispatch reads the Objective Running is kept for the next stale read (#2667)", async () => {
  let stageEnd = null;
  const run = await serveAgainst({
    // 2 shows Running (true when read); 3 is a stale listing with no state label, after the Question landed.
    view: (read, labels) => (read === 3 ? stopLabels(labels) : labels),
    onList: (read, { labels, timeline }) => {
      if (read === 2) {
        // The stage ends with its Question after this tick's listing, while its dispatch is still under way.
        labels.delete("factory:running");
        labels.add("factory:question");
        timeline.push({ event: "labeled", label: { name: "factory:question" }, created_at: new Date(Date.now() - 60_000).toISOString() });
        stageEnd({ exit: "question" });
      }
      answerAt(read, 5, timeline);
    },
    firstStage: () => new Promise((ok) => (stageEnd = ok)),
  });
  assert.deepEqual(run.claims, [1, 5], "claimed once, then again only after the answer");
  assert.deepEqual(run.questionRemoved, [5], "factory:question stays until the answer");
});

test("serve: a stop that ends between ticks survives a stale Running read and then a stale Queued one (#2667)", async () => {
  let stageEnd = null;
  let ticks = 0;
  const run = await serveAgainst({
    // 2 is a stale listing that still shows Running; 3 a stale one with no state label.
    view: (read, labels) => (read === 2 ? ["factory:objective", "factory:running"] : read === 3 ? stopLabels(labels) : labels),
    onList: (read, { timeline }) => answerAt(read, 5, timeline),
    firstStage: () => new Promise((ok) => (stageEnd = ok)),
    pausedHere: async (fake) => {
      ticks += 1;
      if (ticks === 2) {
        // The stage ends with its Question before the second tick reads anything: all its labels land first.
        fake.labels.delete("factory:running");
        fake.labels.add("factory:question");
        fake.timeline.push({ event: "labeled", label: { name: "factory:question" }, created_at: new Date(Date.now() - 60_000).toISOString() });
        stageEnd({ exit: "question" });
        await new Promise((ok) => setImmediate(ok));
      }
      return [];
    },
  });
  assert.deepEqual(run.claims, [1, 5], "claimed once, then again only after the answer");
  assert.deepEqual(run.questionRemoved, [5], "factory:question stays until the answer");
});

test("serve: a Block whose labels never reached GitHub is not held forever; a fresh read shows it Queued and it runs again (#2667)", async () => {
  const run = await serveAgainst({
    view: (read, labels) => labels,
    firstStage: (fake) => {
      // The exit write failed after Running came off (applyExit's catch): GitHub shows no stop.
      fake.labels.delete("factory:running");
      return Promise.resolve({ exit: "blocked" });
    },
    stopAfter: 6,
  });
  assert.deepEqual(run.claims, [1, 2], "the next tick takes the Queued Objective again");
  assert.ok(run.lines.some((l) => /#7: its stop here is not on GitHub/.test(l)), "the release is logged");
});

test("serve: a dispatch that releases a stop never drops a newer stop recorded while it ran (#2667)", async () => {
  let reviewEnd = null;
  let ticks = 0;
  const run = await serveAgainst({
    // 4 is a stale listing with no state label, after the review's Block landed.
    view: (read, labels) => (read === 4 ? stopLabels(labels) : labels),
    onList: (read, { labels }) => {
      // A person clears the Block by hand: the next tick's fresh read shows it Queued and releases the first stop.
      if (read === 2) labels.delete("factory:blocked");
    },
    onIssue: (read, { labels }) => {
      if (read !== 3 || !reviewEnd) return;
      // The review running here Blocks after that fresh read, while the same dispatch is still under way.
      labels.add("factory:blocked");
      reviewEnd({ exit: "blocked" });
      reviewEnd = null;
    },
    firstStage: (fake) => {
      fake.labels.delete("factory:running");
      fake.labels.add("factory:blocked");
      return Promise.resolve({ exit: "blocked" });
    },
    stubs: {
      pendingReviews: async () => (++ticks === 2 ? [{ issue: 7, pr: 9 }] : []),
      withClaim: (n, fn) => fn(),
      review: () => new Promise((ok) => (reviewEnd = ok)),
    },
    stopAfter: 6,
  });
  assert.deepEqual(run.claims, [1], "the review's Block holds it through the stale read");
});

/**
 * A GitHub for the Objectives of a local loop's claim tests (#167): #7 by default, and any other number with the same
 * labels (`labelsOf(n)`); their comments (with GitHub's update time, and the issue each is on: #7 when none is named),
 * labels and PR.
 * `fail(kind)` answers 502 to a read while it returns true: "comments", "issue" or "pulls" (404 for "repo").
 */
function claimGitHub({ labels = ["factory:objective", "factory:local", "factory:running"], pr = null, fail = () => false } = {}) {
  const comments = [];
  const writes = [];
  const sets = new Map();
  const labelsOf = (n) => (sets.has(Number(n)) ? sets.get(Number(n)) : sets.set(Number(n), new Set(labels)).get(Number(n)));
  const state = { labels: labelsOf(7) };
  let id = 100;
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    // GitHub's status page goes to the fake a test serves it from (GITHUB_STATUS_URL).
    if (process.env.GITHUB_STATUS_URL && String(url).startsWith(process.env.GITHUB_STATUS_URL)) return realFetch(url, init);
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname.replace("/repos/acme/app", "");
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") writes.push(`${method} ${p}${method === "POST" ? ` ${JSON.parse(init.body).body ?? JSON.stringify(JSON.parse(init.body))}` : ""}`);
    if (p === "/user") return json({ login: "maintainer", type: "User" });
    if (p === "" && method === "GET") return fail("repo") ? json({ message: "Not Found" }, 404) : json({ full_name: "acme/app" });
    if (p === "/collaborators") return json([{ login: "maintainer" }]);
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(p)) return json([]);
    const on = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (on && method === "GET") return fail("comments") ? json({ message: "Server Error" }, 502) : json(comments.filter((c) => (c.issue ?? 7) === Number(on[1])));
    if (on && method === "POST") {
      const c = { id: (id += 1), issue: Number(on[1]), user: { login: "maintainer", type: "User" }, body: JSON.parse(init.body).body, updated_at: new Date().toISOString() };
      comments.push(c);
      return json(c, 201);
    }
    const one = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (one && method === "PATCH") {
      if (fail("patch")) return json({ message: "Server Error" }, 502);
      const c = comments.find((x) => String(x.id) === one[1]);
      Object.assign(c, { body: JSON.parse(init.body).body, updated_at: new Date().toISOString() });
      return json(c);
    }
    if (one && method === "DELETE") {
      comments.splice(comments.findIndex((x) => String(x.id) === one[1]), 1);
      return json({}, 200);
    }
    if (p === "/pulls" && method === "GET") return fail("pulls") ? json({ message: "Server Error" }, 502) : json(pr ? [pr] : []);
    if (p === "/issues" && method === "GET") return json(u.searchParams.get("labels") && state.labels.has(u.searchParams.get("labels")) ? [{ number: 7, state: "open", labels: [...state.labels].map((name) => ({ name })) }] : []);
    const issue = /^\/issues\/(\d+)$/.exec(p);
    if (issue && method === "GET") return fail("issue") ? json({ message: "Server Error" }, 502) : json({ number: Number(issue[1]), state: "open", labels: [...labelsOf(issue[1])].map((name) => ({ name })) });
    const label = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(p);
    if (label && method !== "GET" && fail("labels")) return json({ message: "Server Error" }, 502);
    if (label?.[2] && method === "DELETE") return labelsOf(label[1]).delete(decodeURIComponent(label[2])) ? json([]) : json({ message: "Not Found" }, 404);
    if (label && !label[2] && method === "POST") {
      for (const l of JSON.parse(init.body).labels) labelsOf(label[1]).add(l);
      return json([]);
    }
    if (p === "/graphql") return json({ data: {} });
    return json({ message: "Not Found" }, 404);
  };
  const restore = () => {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  };
  return { comments, writes, labels: state.labels, labelsOf, restore };
}

/** A loop with this machine's holder id and no waits between claim reads. */
async function claimLoop(holderPid = process.pid) {
  const { holderId, machineIdentity } = await import("../scripts/local.mjs");
  return Object.assign(Object.create(Local.prototype), { repo: { owner: "acme", name: "app", full: "acme/app" }, repoFull: "acme/app", dev: mkdtempSync(join(tmpdir(), "claims-")), opts: { token: "t" }, holder: holderId(machineIdentity(), holderPid), stopping: false, claimRetryMs: 0, claimSettleMs: 0, baseEnv: () => ({}), holdOf: (account) => ({ key: account.name, shared: true }) });
}

for (const [stage, end, how] of [
  ["work", { code: 137, signal: null }, /exit code 137/],
  ["review", { code: null, signal: "SIGKILL" }, /signal SIGKILL/],
]) {
  test(`withClaim: a ${stage} stage that ends with no exit record keeps its claim and is resumed once; a second such end Blocks it with its exit and log (cause factory) (#167)`, async () => {
    const gh = claimGitHub({ labels: ["factory:objective", "factory:local", stage === "work" ? "factory:running" : "factory:in-review"] });
    try {
      const loop = await claimLoop();
      const died = async () => ({ ...end, exit: null, usd: null, stage, log: "/x/.factory/7/usage/stage.log" });
      assert.equal((await loop.withClaim(7, died)).exit, null);
      assert.equal(gh.comments.length, 1, "the claim stays: the dispatcher sees it held, never vanished");
      assert.match(gh.comments[0].body, new RegExp(`holder: ${loop.holder}`));
      assert.ok(!gh.writes.some((w) => w.startsWith("POST /issues/7/labels")), "no Block on the first");
      // This loop resumes it once, at once (its own claim, still fresh), and not while it runs here.
      assert.deepEqual(await loop.pausedHere(new Map()), [7]);
      assert.deepEqual(await loop.pausedHere(new Map([[7, null]])), []);
      // The resume dies the same way: Blocked here, naming the stage, its exit and its log; the claim goes.
      await loop.withClaim(7, died);
      assert.ok(gh.labels.has("factory:blocked"));
      const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("factory:block"));
      assert.match(notice, new RegExp(`the ${stage} stage ended with no exit record \\(${how.source}\\) twice in a row on this machine; its log on this machine: /x/.factory/7/usage/stage.log`));
      assert.match(notice, /<!-- factory:block \{"cause":"factory"\} -->/);
      assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0);
      assert.deepEqual(await loop.pausedHere(new Map()), [], "nothing left to resume");
      // A stage with an exit record drops the claim and clears the count.
      gh.labels.delete("factory:blocked");
      await loop.withClaim(7, died);
      await loop.withClaim(7, async () => ({ exit: "delivered" }));
      assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0);
      assert.ok(!loop.lapsed.has(7));
    } finally {
      gh.restore();
    }
  });
}

test("outagePaused: pauses on GitHub's spent rate limit one after another count from the first, however long the runs between, so the 12-hour bound holds (#337)", async () => {
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    const first = Date.parse("2026-11-15T22:40:00Z");
    let t = first;
    loop.clock = () => t;
    const paused = (at) => async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "api.github.com", origin: "https://api.github.com", code: "RATE_LIMIT_SPENT", since: new Date(at).toISOString(), reset: new Date(at + 40 * 60_000).toISOString(), quota: "core" } });
    await loop.withClaim(7, paused(first));
    // Resumed after the reset; the run lasts an hour, then meets the spent quota again.
    t = first + 41 * 60_000;
    loop.offline.get(7).resumedAt = t;
    t += 60 * 60_000;
    await loop.withClaim(7, paused(t));
    assert.equal(loop.offline.get(7).since, first, "the same pause, counted from the first");
    // A network pause long after a resume is still a new outage of its own.
    loop.offline.get(7).resumedAt = t;
    const net = t + OUTAGE.stageWaitMs + 60_000;
    await loop.withClaim(7, async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "api.github.com", origin: "https://api.github.com", code: "EAI_AGAIN", since: new Date(net).toISOString() } }));
    assert.equal(loop.offline.get(7).since, net);
  } finally {
    gh.restore();
  }
});

test("resume: a review paused on an outage after its label came off (on its merge path) runs again; with no such pause here, nothing runs (#337)", async () => {
  const gh = claimGitHub({ labels: ["factory:objective", "factory:local", "factory:in-review"], pr: { number: 9, state: "open", draft: false, head: { ref: "factory/7" }, labels: [] } });
  try {
    const since = Date.parse("2026-11-15T22:40:39Z");
    const reviewed = [];
    const loop = Object.assign(await claimLoop(), { clock: () => since + 16 * 60_000, review: async (issue, pr) => (reviewed.push([issue, pr]), { exit: "delivered" }) });
    const paused = async () => ({ exit: "paused", stage: "review", code: 0, outage: { host: "api.github.com", origin: "https://api.github.com", code: "EAI_AGAIN", since: new Date(since).toISOString() } });
    assert.equal((await loop.withClaim(7, paused)).exit, "paused");
    assert.equal((await loop.resume(7)).exit, "delivered");
    assert.deepEqual(reviewed, [[7, 9]], "the review runs again, though its PR has no review label");
    // Another loop holds no such pause: the PR waits for its merge, and nothing runs.
    const other = Object.assign(await claimLoop(), { review: async (issue, pr) => (reviewed.push([issue, pr]), { exit: "delivered" }) });
    assert.equal((await other.resume(7)).exit, "skipped");
    assert.equal(reviewed.length, 1);
  } finally {
    gh.restore();
  }
});

test("withClaim: Factory's set-up of the review stage failing after the PR was delivered Blocks naming that set-up and the delivered PR, never the work (#261)", async () => {
  const { mkdirSync } = await import("node:fs");
  const { gitPinFile, pinGitDir } = await import("../scripts/lib/local.mjs");
  const gh = claimGitHub({ labels: ["factory:objective", "factory:local", "factory:in-review"], pr: { number: 9, draft: false, head: { ref: "factory/7" }, labels: [{ name: "factory:review" }] } });
  try {
    const loop = Object.assign(await claimLoop(), { harness: "claude", firstSetup: new Map(), children: new Set() });
    mkdirSync(join(loop.ws(7), "repo", ".git"), { recursive: true });
    pinGitDir(join(loop.ws(7), "repo"), gitPinFile(loop.ws(7)));
    loop.harnessFor = async () => ({ ok: true, harness: "claude" });
    // The real case: the harness home's `plans` in a folder that is gone (an uncoded throw from the stage's set-up), here
    // an account's folder outside the home directory (#305).
    const gone = join(tmpdir(), "gone-account", "plans");
    loop.stageEnv = () => mkdirSync(gone);
    await assert.rejects(loop.withClaim(7, () => loop.review(7, 9)), /ENOENT/);
    assert.ok(!gh.labels.has("factory:blocked"), "resumed once first");
    await assert.rejects(loop.withClaim(7, () => loop.review(7, 9)), /ENOENT/);
    assert.ok(gh.labels.has("factory:blocked"));
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("factory:block"));
    assert.match(notice, /Blocked \(review\): Factory's set-up of the review stage failed \(ENOENT from mkdir; the local loop's log names the path\) twice in a row on this machine — PR #9 was delivered; it is a draft until this is fixed\. Fix it on this machine/);
    assert.ok(!notice.includes("gone-account"), "no path of this machine's set-up");
    assert.doesNotMatch(notice, /\(work\)|the work stage|draft with what exists/);
    assert.match(notice, /<!-- factory:block \{"cause":"factory"\} -->/);
  } finally {
    gh.restore();
  }
});

test("withClaim: a read-back that fails once is read again; one that never answers keeps the claim for this loop to resume (#167)", async () => {
  // The comments requests of one claim: the check for another holder, upsertComment's own, then the read-back (the 3rd),
  // which fails through all of the client's tries, so the loop's own second read is what answers.
  let reads = 0;
  let failFrom = 3;
  let failTo = 2 + RETRY.tries;
  const gh = claimGitHub({ fail: (kind) => kind === "comments" && ++reads >= failFrom && reads <= failTo });
  try {
    const loop = await claimLoop();
    let ran = 0;
    // The first read-back fails: read again, it is ours, the stage runs.
    assert.equal((await loop.withClaim(7, async () => ((ran += 1), { exit: "delivered" }))).exit, "delivered");
    assert.equal(ran, 1);
    // Every read-back fails: never "another loop claimed it first"; the claim stays, and once stale this loop takes it.
    reads = 0;
    failTo = Infinity;
    const r = await loop.withClaim(7, async () => ((ran += 1), { exit: "delivered" }));
    assert.equal(r.exit, "skipped");
    assert.equal(ran, 1, "nothing ran on an unread read-back");
    failFrom = Infinity;
    assert.equal(gh.comments.length, 1);
    assert.match(gh.comments[0].body, new RegExp(`holder: ${loop.holder}`));
    gh.comments[0].updated_at = new Date(Date.now() - 20 * 60_000).toISOString();
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "a stale claim of this loop's own that nothing runs is resumed");
    assert.deepEqual(await loop.pausedHere(new Map([[7, null]])), [], "not while it runs here");
  } finally {
    gh.restore();
  }
});

test("resume: a failed read of the issue or its PR keeps the claim and runs nothing (#167)", async () => {
  let down = true;
  const gh = claimGitHub({ labels: ["factory:objective", "factory:local", "factory:in-review"], fail: (kind) => down && kind === "issue" });
  try {
    const { writeClaim } = await import("../scripts/lib/local.mjs");
    const dead = await claimLoop(process.pid + 1);
    await writeClaim(dead.repo, 7, dead.holder, dead.opts);
    const loop = await claimLoop();
    assert.equal((await loop.resume(7)).exit, "skipped");
    assert.equal(gh.comments.length, 1, "a failed read is no 'nothing left to run'");
    // Read fine with nothing left (no PR to review, not Running): the claim goes.
    down = false;
    assert.equal((await loop.resume(7)).exit, "skipped");
    assert.equal(gh.comments.length, 0);
  } finally {
    gh.restore();
  }
});

test("runObjective: a failed start goes back to Queued and is held for a doubling backoff; the third in a row Blocks once with its error (setup); a start clears it (#167)", async () => {
  const { START_BACKOFF_MS } = await import("../scripts/local.mjs");
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-13T08:00:00Z");
    loop.clock = () => now;
    let starts = 0;
    loop.stage = async () => {
      starts += 1;
      // A system error as Node throws it: its message names the path; GitHub gets its code and call (#305).
      if (loop.fail) throw Object.assign(new Error("ENOSPC: no space left on device, mkdir '/srv/accounts/claude-x/hooks'"), { errno: -28, code: "ENOSPC", syscall: "mkdir", path: "/srv/accounts/claude-x/hooks" });
      return { code: 0, exit: "blocked", usd: 0 };
    };
    loop.fail = true;
    const posted = () => gh.writes.filter((w) => w.startsWith("POST /issues/7/comments") && !w.includes(":local -->"));
    // First failure: un-marked, claim dropped, no Block, and held for 5 minutes.
    let r = await loop.runObjective(7);
    assert.equal(r.startFailed, "work");
    assert.ok(!gh.labels.has("factory:running"), "un-marked");
    assert.equal(gh.comments.length, 0, "its claim goes with the Running mark");
    assert.deepEqual(posted(), [], "no Block on a first failure");
    assert.match(loop.startHolds()[7], /its last start here failed \(1 in a row\)/);
    now += START_BACKOFF_MS - 1000;
    assert.ok(loop.startHolds()[7], "still held before the backoff ends");
    now += 2000;
    assert.deepEqual(loop.startHolds(), {}, "free to pick once it ends");
    // Second failure (the dispatcher marked it Running again): held twice as long.
    gh.labels.add("factory:running");
    await loop.runObjective(7);
    assert.ok(!gh.labels.has("factory:running"));
    now += 2 * START_BACKOFF_MS - 1000;
    assert.ok(loop.startHolds()[7]);
    now += 2000;
    // Third failure in a row: Blocked once, with the error and cause `setup`, not un-marked again.
    gh.labels.add("factory:running");
    r = await loop.runObjective(7);
    assert.equal(r.exit, "blocked");
    assert.ok(gh.labels.has("factory:blocked"));
    assert.equal(posted().length, 1);
    assert.match(posted()[0], /could not start on this machine 3 times in a row \(work, ENOSPC\): ENOSPC from mkdir; the local loop's log names the path\./);
    assert.ok(!posted()[0].includes("/srv/accounts"), "no path of this machine's set-up");
    assert.match(posted()[0], /<!-- factory:block \{"cause":"setup"\} -->/);
    assert.deepEqual(loop.startHolds(), {}, "the Block ends the count");
    // A start that succeeds clears an earlier failure.
    gh.labels.delete("factory:blocked");
    gh.labels.add("factory:running");
    await loop.runObjective(7);
    assert.ok(loop.startFailures.has(7));
    gh.labels.add("factory:running");
    loop.fail = false;
    await loop.runObjective(7);
    assert.ok(!loop.startFailures.has(7), "a start clears it");
    assert.equal(starts, 5);
    // A start that fails on an Objective no longer Running (a person moved it) changes no label.
    loop.fail = true;
    gh.labels.delete("factory:running");
    gh.labels.add("factory:question");
    await loop.runObjective(7);
    assert.ok(gh.labels.has("factory:question"));
  } finally {
    gh.restore();
  }
});

/** Every line this process logs while `fn` runs, as well as printed. */
async function logged(fn) {
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return lines;
}

test("runObjective: the same failed start on two Objectives is the machine's: no start is counted or Blocked while new starts are held, said once, until the disk probe passes; a cause on one Objective alone is its own (#370)", async () => {
  const { START_DISK_FLOOR, MACHINE_PROBE_EVERY_MS } = await import("../scripts/local.mjs");
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-15T08:00:00Z");
    loop.clock = () => now;
    // The disk as statfs reads it: full until the test frees it.
    let free = 1024 ** 2;
    const read = [];
    loop.machineProbes = { statfs: (dir) => (read.push(dir), { bavail: free, bsize: 1 }) };
    let fail = { code: "ENOSPC", errno: -28 };
    loop.stage = async (n) => {
      if (fail) throw Object.assign(new Error(`${fail.code}: mkdir '/srv/box/.factory/${n}/usage-work'`), { ...fail, syscall: "mkdir", path: `/srv/box/.factory/${n}/usage-work` });
      return { code: 0, exit: "blocked", usd: 0 };
    };
    const posted = () => gh.writes.filter((w) => /^POST \/issues\/\d+\/(comments|labels)/.test(w) && !w.includes(":local -->"));
    // #7 alone: its own, as before: back to Queued, one failed start counted, held for its backoff; no machine hold.
    await loop.runObjective(7);
    assert.ok(!gh.labelsOf(7).has("factory:running"));
    assert.equal(loop.startFailures.get(7).count, 1);
    assert.match(loop.startHolds()[7], /1 in a row/);
    assert.deepEqual(await loop.machineWait(), { work: null, all: null }, "one Objective alone is no fault of the machine");
    // #8 fails the same way (setup, ENOSPC) a minute later: the machine's. Back to Queued, nothing counted from here on.
    now += 60_000;
    const lines = await logged(async () => {
      await loop.runObjective(8);
      // Far past three failed starts each, an hour apart, while the hold lasts: never Blocked, never counted, said once.
      for (let i = 0; i < 4; i += 1) {
        now += 60 * 60_000;
        for (const n of [7, 8]) {
          gh.labelsOf(n).add("factory:running");
          await loop.runObjective(n);
        }
      }
    });
    assert.ok(!gh.labelsOf(8).has("factory:running"), "back to Queued");
    assert.deepEqual(posted(), [], "no Block, no label written");
    assert.equal(loop.startFailures.get(7).count, 1, "the count from before the hold stays as it was");
    assert.equal(loop.startFailures.get(8).count, 0);
    const said = lines.filter((l) => /holding every new stage on this machine/.test(l));
    assert.equal(said.length, 1, "said once");
    assert.match(said[0], /#7, #8 failed to start the same way \(setup, ENOSPC\), which is this machine's fault, not theirs; no Objective is charged for it while the hold lasts\. Fix: free disk space on this machine/);
    assert.match(said[0], /New starts resume once the probe passes: 2 GB free on its disk\./);
    // Each tick: still full, so serve starts nothing, resumes and reviews included; the disk read is the one the error
    // named, and the probe runs at most once a minute.
    const held = await loop.machineWait();
    assert.match(held.work, /^this machine's starts fail \(setup, ENOSPC\): 0\.0 GB free on its disk/);
    assert.equal(held.all, held.work);
    assert.ok(read.at(-1).startsWith("/srv/box/.factory/"));
    const probed = read.length;
    free = START_DISK_FLOOR;
    assert.ok((await loop.machineWait()).work, "within the minute: the last probe's answer");
    assert.equal(read.length, probed);
    // Another cause on one Objective, during the hold: its own, counted as before.
    fail = { code: "EACCES", errno: -13 };
    gh.labelsOf(9).add("factory:running");
    await loop.runObjective(9);
    assert.equal(loop.startFailures.get(9).count, 1);
    // The disk freed, a minute on: the hold ends, said once, and starts go on; one that starts clears its record.
    now += MACHINE_PROBE_EVERY_MS;
    const back = await logged(async () => assert.deepEqual(await loop.machineWait(), { work: null, all: null }));
    assert.ok(back.some((l) => /this machine's start fault \(setup, ENOSPC\) is gone \(2 GB free on its disk\): new starts resume/.test(l)));
    fail = null;
    gh.labelsOf(7).add("factory:running");
    await loop.runObjective(7);
    assert.ok(!loop.startFailures.has(7));
  } finally {
    gh.restore();
  }
});

test("runObjective: two Objectives whose starts fail at the same moment the same way are the machine's (#370)", async () => {
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    loop.clock = () => Date.parse("2026-11-15T08:00:00Z");
    loop.machineProbes = { statfs: () => ({ bavail: 0, bsize: 1 }) };
    // Both stages fail only once both have started: neither unstart runs before the other's start failed.
    let arrived = 0;
    let open;
    const barrier = new Promise((ok) => (open = ok));
    loop.stage = async (n) => {
      if (++arrived === 2) open();
      await barrier;
      throw Object.assign(new Error(`ENOSPC: mkdir '/srv/box/.factory/${n}'`), { code: "ENOSPC", syscall: "mkdir", path: `/srv/box/.factory/${n}` });
    };
    gh.labelsOf(8).add("factory:running");
    await Promise.all([loop.runObjective(7), loop.runObjective(8)]);
    assert.ok(loop.machineHolds.has("setup ENOSPC"), "held as the machine's");
    assert.deepEqual([...loop.machineHolds.get("setup ENOSPC").issues].sort(), [7, 8]);
    assert.ok([7, 8].every((n) => loop.startFailures.get(n).count <= 1), "at most the first is counted, before the second fails");
    assert.ok((await loop.machineWait()).work);
  } finally {
    gh.restore();
  }
});

test("runObjective: a cause that fails again after its hold's probe passed is not the machine's: each Objective is counted and Blocks on its own count, with no hold flapping each tick (#370)", async () => {
  const { MACHINE_PROBE_EVERY_MS } = await import("../scripts/local.mjs");
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-15T08:00:00Z");
    loop.clock = () => now;
    // A token file this machine cannot read: EACCES on every start, which no probe explains (its probe: a start tried
    // again after the backoff).
    loop.stage = async () => {
      throw Object.assign(new Error("EACCES: open '/srv/box/token'"), { code: "EACCES", syscall: "open", path: "/srv/box/token" });
    };
    let blockedBy = null;
    const lines = await logged(async () => {
      for (let round = 1; round <= 12; round += 1) {
        await loop.machineWait();
        for (const n of [7, 8]) {
          if (gh.labelsOf(n).has("factory:blocked")) continue;
          gh.labelsOf(n).add("factory:running");
          await loop.runObjective(n);
        }
        if (blockedBy === null && [7, 8].every((n) => gh.labelsOf(n).has("factory:blocked"))) blockedBy = round;
        now += Math.max(MACHINE_PROBE_EVERY_MS, (61 * 60_000) / 12);
      }
    });
    // One round held (no count), then each Objective's three failed starts: both Blocked by the fourth round.
    assert.equal(blockedBy, 4, "both Blocked on their own count");
    assert.equal(lines.filter((l) => /holding every new stage on this machine/.test(l)).length, 1, "one hold, not one a tick");
    assert.equal(lines.filter((l) => /after this machine's probe for it passed, so the probe does not explain it/.test(l)).length, 1, "said once");
    assert.ok(gh.writes.length <= 60, `GitHub writes stay bounded: seven failed starts and two Blocks (${gh.writes.length})`);
  } finally {
    gh.restore();
  }
});

test("startCause: a failed start's kind and code, on structure; a clone's machine hold waits for git ls-remote and holds new work only, a claim's for the API reading the repository, the clone's preparation for the sandbox (#370)", async () => {
  const { startCause } = await import("../scripts/local.mjs");
  const { prepareClone } = await import("../scripts/lib/local.mjs");
  const { GitHubError } = await import("../scripts/lib/github.mjs");
  assert.deepEqual(startCause(Object.assign(new Error("ENOSPC"), { code: "ENOSPC", syscall: "mkdir", startFailed: "work" })), { kind: "setup", code: "ENOSPC" });
  assert.deepEqual(startCause(Object.assign(new Error("git clone failed (exit 128)"), { startStep: "clone", exitCode: 128, startFailed: "work" })), { kind: "clone", code: "exit 128" });
  const prepared = await prepareClone("/nowhere", [], async () => ({ code: 1, stdout: "", stderr: "" })).catch((e) => e);
  assert.deepEqual(startCause(Object.assign(prepared, { startStep: "prepare", startFailed: "work" })), { kind: "prepare", code: "exit 1" });
  assert.deepEqual(startCause(Object.assign(new GitHubError("Server Error", 502, {}), { startFailed: "claim-read" })), { kind: "claim-read", code: "HTTP 502" });
  assert.deepEqual(startCause(Object.assign(new Error("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }), { startFailed: "claim-read" })), { kind: "claim-read", code: "ECONNREFUSED" });
  assert.deepEqual(startCause(Object.assign(new Error("no settings"), { startFailed: "work" })), { kind: "setup", code: null }, "no code: never the machine's");

  let repoDown = true;
  const gh = claimGitHub({ fail: (kind) => kind === "repo" && repoDown });
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-15T08:00:00Z");
    loop.clock = () => now;
    let lsRemote = 128;
    let sandbox = ["srt's sandbox does not start here (bwrap: setting up uid map: Permission denied)"];
    loop.machineProbes = { statfs: () => ({ bavail: 1, bsize: 2 ** 40 }), lsRemote: async () => lsRemote, sandbox: async () => sandbox };
    for (const [fail, key, why] of [
      [{ startStep: "clone", exitCode: 128 }, "clone exit 128", /^git ls-remote of acme\/app with the local token failed \(exit 128\)$/],
      [{ startFailed: "claim-read", status: 502 }, "claim-read HTTP 502", /^GitHub's API answered HTTP 404 to reading acme\/app with the local token$/],
      [{ startStep: "prepare", exitCode: 1 }, "prepare exit 1", /^srt's sandbox does not start here/],
    ]) {
      loop.stage = async () => {
        throw Object.assign(new Error("failed"), fail);
      };
      loop.withClaim = fail.startFailed ? async () => Promise.reject(Object.assign(new Error("failed"), fail)) : Local.prototype.withClaim;
      for (const n of [7, 8]) {
        gh.labelsOf(n).add("factory:running");
        await loop.runObjective(n);
      }
      assert.match(await loop.machineProbe(loop.machineHolds.get(key)), why);
      if (key === "clone exit 128") {
        const held = await loop.machineWait();
        assert.ok(held.work && held.all === null, "a clone's hold holds new work only: resumes and reviews run in their clones");
      }
      now += 2 * 60 * 60_000;
      // Each cause on its own: a start in between would have cleared the counts.
      loop.startFailures.clear();
    }
    assert.equal(loop.machineHolds.size, 3);
    lsRemote = 0;
    repoDown = false;
    sandbox = [];
    assert.deepEqual(await loop.machineWait(), { work: null, all: null }, "every probe passes: every hold ends");
    assert.equal(loop.machineHolds.size, 0);
    assert.ok(!gh.writes.some((w) => /factory:blocked/.test(w)), "nothing Blocked");
  } finally {
    gh.restore();
  }
});

test("serve: a machine hold starts nothing new, with its reason on the tick line, and the tick after its probe passes picks again (#370)", async () => {
  let free = 0;
  const run = await serveAgainst({
    view: (read, labels) => labels,
    onList: (read) => {
      if (read === 2) free = 2 ** 40;
    },
    firstStage: () => Promise.resolve({ exit: "delivered" }),
    stopAfter: 4,
    stubs: {
      dev: mkdtempSync(join(tmpdir(), "dev-")),
      machineProbeEveryMs: 0,
      machineProbes: { statfs: () => ({ bavail: free, bsize: 1 }) },
      machineHolds: new Map([["setup ENOSPC", { kind: "setup", code: "ENOSPC", key: "setup ENOSPC", probes: ["disk"], path: "/srv/box/.factory/7", issues: new Set([7, 8]), all: true, since: Date.now(), retryAt: Date.now() }]]),
    },
  });
  assert.deepEqual(run.claims, [3], "nothing started while the disk was full; picked on the tick after it was freed");
  assert.ok(run.lines.some((l) => /tick: nothing ready \(this machine's starts fail \(setup, ENOSPC\): 0\.0 GB free on its disk/.test(l)), "the tick line names the hold");
  assert.ok(run.lines.some((l) => /this machine's start fault \(setup, ENOSPC\) is gone/.test(l)));
});

test("runObjective: a start that fails on a claim it cannot read, or on another loop's it cannot replace, changes nothing; after the backoff the loop reads again, puts it back to Queued and starts it (#167)", async () => {
  const { claimBody } = await import("../scripts/lib/local.mjs");
  const { START_BACKOFF_MS } = await import("../scripts/local.mjs");
  let down = "comments";
  const gh = claimGitHub({ fail: (kind) => kind === down });
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-13T08:00:00Z");
    loop.clock = () => now;
    let starts = 0;
    loop.stage = async () => ((starts += 1), { code: 0, exit: "blocked", usd: 0, stage: "work" });
    // The claim cannot be read: another machine may be running it, so nothing changes yet.
    let r = await loop.runObjective(7);
    assert.equal(r.startFailed, "claim-read");
    assert.ok(gh.labels.has("factory:running"), "not un-marked");
    assert.deepEqual(gh.writes, [], "nothing written");
    // Inside the backoff the tick does not read again; after it, a read that answers with no live claim requeues it.
    down = null;
    await loop.recheckStarts(new Map());
    assert.ok(gh.labels.has("factory:running"));
    now += START_BACKOFF_MS + 1000;
    await loop.recheckStarts(new Map());
    assert.ok(!gh.labels.has("factory:running"), "back to Queued for the next pick");
    assert.deepEqual(loop.startHolds(), {}, "free to pick");
    // The next pick (the dispatcher marks it Running) starts it, which clears the count.
    gh.labels.add("factory:running");
    await loop.runObjective(7);
    assert.equal(starts, 1);
    assert.ok(!loop.startFailures.has(7));

    // Another machine's stale claim that this loop cannot replace (the edit fails): left as it is, then requeued once
    // a read shows it is still stale, and started.
    gh.labels.delete("factory:blocked");
    gh.labels.add("factory:running");
    gh.comments.length = 0;
    gh.comments.push({ id: 9, user: { login: "maintainer", type: "User" }, body: `<!-- factory:7:local -->\n${claimBody("otherbox:1:abc:m:b", new Date())}`, updated_at: new Date(Date.now() - 20 * 60_000).toISOString() });
    down = "patch";
    r = await loop.runObjective(7);
    assert.equal(r.startFailed, "claim");
    assert.ok(gh.labels.has("factory:running"));
    assert.equal(gh.comments.length, 1, "its claim stays");
    down = null;
    now += START_BACKOFF_MS + 1000;
    gh.comments[0].updated_at = new Date(Date.now() - 20 * 60_000).toISOString();
    await loop.recheckStarts(new Map());
    assert.ok(!gh.labels.has("factory:running"));
    gh.labels.add("factory:running");
    await loop.runObjective(7);
    assert.equal(starts, 2);
    // A claim read that keeps failing: the third failed start in a row Blocks.
    gh.labels.delete("factory:blocked");
    gh.labels.add("factory:running");
    down = "comments";
    for (let i = 0; i < 3; i += 1) {
      if (i === 0) await loop.runObjective(7);
      else {
        now += 60 * 60_000;
        await loop.recheckStarts(new Map());
      }
    }
    assert.ok(gh.labels.has("factory:blocked"));
  } finally {
    gh.restore();
  }
});

test("serve: a review this loop owes is held from its own dispatch, so a day-old In-review Objective is reviewed, never Blocked in the same tick (#167)", async () => {
  const reviewed = [];
  let loop = null;
  const run = await serveAgainst({
    view: () => ["factory:objective", "factory:local", "factory:in-review"],
    onList: (read, { timeline }) => {
      // In review for three days; the merge pass re-applied factory:review to its PR long ago, as the fixture's day 0.
      if (read === 1) timeline.push({ event: "labeled", label: { name: "factory:in-review" }, created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    },
    extra: (req, url, send) => {
      if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head")) return send(200, [{ number: 9, draft: false, labels: [{ name: "factory:review" }], head: { ref: "factory/7" } }]), true;
      return false;
    },
    firstStage: () => Promise.resolve({ exit: "delivered" }),
    stopAfter: 2,
    stubs: {
      pendingReviews: async () => [{ issue: 7, pr: 9 }],
      withClaim: (n, fn) => fn(),
      review: async (n, pr) => {
        reviewed.push(pr);
        return { exit: "delivered" };
      },
    },
  });
  assert.ok(reviewed.includes(9), "the review runs");
  assert.ok(!run.labels.includes("factory:blocked"), "never Blocked as 'no local loop running its review'");
  assert.ok(!run.lines.some((l) => /no local loop running its review/.test(l)));
});

test("unstart: a GitHub failure while settling a failed start still records the backoff, so the loop reads it again; one no longer Running is let go (#167)", async () => {
  const { START_BACKOFF_MS } = await import("../scripts/local.mjs");
  let down = new Set(["comments", "issue"]);
  const gh = claimGitHub({ fail: (kind) => down.has(kind) });
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-13T08:00:00Z");
    loop.clock = () => now;
    loop.stage = async () => ({ code: 0, exit: "blocked", usd: 0, stage: "work" });
    // The claim read and the issue read fail together: nothing changes, but the loop will read it again.
    await loop.runObjective(7);
    assert.ok(gh.labels.has("factory:running"));
    assert.equal(loop.startFailures.get(7)?.recheck, true, "not stranded: a recheck is due after the backoff");
    down = new Set();
    now += START_BACKOFF_MS + 1000;
    await loop.recheckStarts(new Map());
    assert.ok(!gh.labels.has("factory:running"), "back to Queued");
    // A person moved it out of Running while its claim stays unreadable: the loop lets it go, no read every tick.
    gh.labels.add("factory:question");
    down = new Set(["comments"]);
    loop.startFailures.set(7, { count: 1, retryAt: now, recheck: true });
    await loop.recheckStarts(new Map());
    assert.ok(!loop.startFailures.has(7));
  } finally {
    gh.restore();
  }
});

test("unstart: the third failed start keeps its count when the Block cannot be written, and Blocks on the next try (#167)", async () => {
  let down = new Set();
  const gh = claimGitHub({ fail: (kind) => down.has(kind) });
  try {
    const loop = await claimLoop();
    let now = Date.parse("2026-11-13T08:00:00Z");
    loop.clock = () => now;
    loop.stage = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    loop.startFailures = new Map([[7, { count: 2, retryAt: now, recheck: false }]]);
    // The Block's own writes fail (its labels): the entry stays, with a recheck, so the Objective is not stranded.
    down = new Set(["labels"]);
    await loop.runObjective(7);
    assert.ok(!gh.labels.has("factory:blocked"));
    assert.equal(loop.startFailures.get(7)?.count, 3);
    assert.equal(loop.startFailures.get(7)?.recheck, true);
    down = new Set();
    await loop.runObjective(7);
    assert.ok(gh.labels.has("factory:blocked"));
    assert.ok(!loop.startFailures.has(7));
  } finally {
    gh.restore();
  }
});

test("runObjective: a stage of this Objective still running on this machine is never doubled, and its claim is left alone (#167)", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { STAGE_RECORD } = await import("../scripts/local.mjs");
  const { processRecord } = await import("../scripts/lib/proc.mjs");
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    let starts = 0;
    loop.stage = async () => ((starts += 1), { code: 0, exit: "delivered", usd: 0, stage: "work" });
    // An orphaned stage of an earlier serve: its record names a live process (this test's own).
    mkdirSync(join(loop.ws(7), "usage-work-1"), { recursive: true });
    writeFileSync(join(loop.ws(7), "usage-work-1", STAGE_RECORD), JSON.stringify(processRecord(process.pid)));
    const r = await loop.runObjective(7);
    assert.equal(r.exit, "skipped");
    assert.equal(starts, 0);
    assert.deepEqual(gh.writes, [], "no claim written or dropped");
  } finally {
    gh.restore();
  }
});

test("withClaim: a stage that paused on this machine's network keeps its claim with no lapse; it is resumed once its host answers, and Blocked with cause outage past the bound (#228)", async () => {
  const gh = claimGitHub();
  const inner = globalThis.fetch;
  let down = true;
  globalThis.fetch = async (url, init) => (new URL(url).origin === "https://api.anthropic.test" && down ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })) : inner(url, init));
  try {
    const loop = await claimLoop();
    const since = Date.parse("2026-11-14T08:47:00Z");
    let t = since + 20 * 60_000;
    loop.clock = () => t;
    const outage = (at) => ({ host: "api.anthropic.test", origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: new Date(at).toISOString() });
    const paused = (at) => async () => ({ exit: "paused", stage: "work", code: 0, outage: outage(at) });
    assert.equal((await loop.withClaim(7, paused(since))).exit, "paused");
    assert.equal(gh.comments.length, 1, "the claim stays");
    assert.ok(!loop.lapsed?.has(7), "a pause is no lapse");
    assert.ok(!gh.writes.some((w) => w.startsWith("POST /issues/7/labels")), "nothing Blocked");
    assert.deepEqual(await loop.pausedHere(new Map()), [], "not resumed while its host does not answer");
    down = false;
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "resumed once it answers");
    // Paused again within fifteen minutes of a resume: the same outage, counted from its first loss.
    loop.offline.get(7).resumedAt = t;
    await loop.withClaim(7, paused(t + 60_000));
    assert.equal(loop.offline.get(7).since, since);
    // Past the bound: Blocked with the External cause, naming the host and since when, and the claim goes.
    t = since + OUTAGE.blockMs;
    assert.equal((await loop.resume(7)).exit, "blocked");
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("factory:block"));
    assert.match(notice, /this machine could not reach api\.anthropic\.test \(EAI_AGAIN\) from 2026-11-14T08:47:00\.000Z for 12 h, past Factory's 12 h bound for an outage\. The network is back: re-apply the label/);
    assert.match(notice, /<!-- factory:block \{"cause":"outage"\} -->/);
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "the claim is dropped");
    // A later pause long after a resume is a new outage: its own since.
    gh.labels.delete("factory:blocked");
    gh.labels.add("factory:running");
    await loop.withClaim(7, paused(t));
    loop.offline.get(7).resumedAt = t;
    await loop.withClaim(7, paused(t + OUTAGE.stageWaitMs + 60_000));
    assert.equal(loop.offline.get(7).since, t + OUTAGE.stageWaitMs + 60_000);
    // A stage that ends with an exit record clears it.
    await loop.withClaim(7, async () => ({ exit: "delivered" }));
    assert.ok(!loop.offline.has(7));
  } finally {
    globalThis.fetch = inner;
    gh.restore();
  }
});

/**
 * GitHub's status page served on this machine (GITHUB_STATUS_URL): `answer()` is {status, components} per request, the
 * components as {name: status}; `close` stops it and clears the variable. Each request is counted in `asked()`.
 */
async function statusPage(answer) {
  let n = 0;
  const server = createServer((req, res) => {
    n += 1;
    const a = answer();
    res.writeHead(a.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ page: { id: "x", name: "GitHub" }, components: Object.entries(a.components ?? {}).map(([name, status]) => ({ id: name, name, status })) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.GITHUB_STATUS_URL = `http://127.0.0.1:${server.address().port}`;
  return { asked: () => n, close: () => (delete process.env.GITHUB_STATUS_URL, new Promise((r) => server.close(r))) };
}
const parts = (api, rest = "operational") => ({ "Git Operations": "major_outage", "API Requests": api, Issues: rest, "Pull Requests": rest });

/** A loop with an Objective paused on GitHub's 5xx, whose resumed stage pauses on the same 5xx again (runObjective). */
async function serverPaused() {
  const loop = await claimLoop();
  const first = Date.parse("2026-11-14T08:47:00Z");
  const at = { t: first };
  loop.clock = () => at.t;
  const endpoint = "POST repos/acme/app/issues/7/labels";
  // GitHub's host answers a probe (github.test answers every request) while that one request keeps failing.
  const paused = () => async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "github.test", origin: "https://github.test", code: "HTTP 500", since: new Date(at.t).toISOString(), endpoint } });
  let tries = 0;
  // The resumed stage runs longer than a network outage's carry-over before it meets the 5xx again.
  loop.runObjective = (n) => ((tries += 1), (at.t += OUTAGE.stageWaitMs + 60_000), loop.withClaim(n, paused()));
  await loop.withClaim(7, paused());
  // Each resume is due after its doubling wait, not on the probe.
  const next = async () => {
    const off = loop.offline.get(7);
    at.t += 30_000;
    assert.deepEqual(await loop.pausedHere(new Map()), [], "not resumed on the probe");
    at.t = off.server.at + Math.min(OUTAGE.serverResumeMaxMs, OUTAGE.serverResumeMs * 2 ** (off.server.pauses - 1));
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "resumed after its wait");
    return loop.resume(7);
  };
  return { loop, first, at, next, tries: () => tries };
}

test("#389: a stage paused on GitHub's 5xx waits on while GitHub's status page reports an incident or does not answer, past any count of resumes, and Blocks at 12 h as an outage", async () => {
  const gh = claimGitHub();
  // An incident on the API, then the page itself down (no JSON, then a refused connection), then one without Issues.
  let mode = "degraded";
  const page = await statusPage(() => (mode === "degraded" ? { components: parts("degraded_performance") } : mode === "503" ? { status: 503 } : { components: { "API Requests": "operational" } }));
  const refusing = await refusingOrigin();
  try {
    const { loop, first, at, next, tries } = await serverPaused();
    for (let i = 1; i <= 12; i++) {
      mode = ["degraded", "503", "missing"][i % 3];
      const served = process.env.GITHUB_STATUS_URL;
      if (i === 6) process.env.GITHUB_STATUS_URL = refusing.origin;
      assert.notEqual((await next()).exit, "blocked", `resume ${i}: no Block while the page says nothing is operational`);
      process.env.GITHUB_STATUS_URL = served;
      assert.equal(loop.offline.get(7).server.pauses, i + 1);
      assert.equal(loop.offline.get(7).since, first);
    }
    assert.equal(tries(), 12, "every resume ran the stage again");
    assert.equal(page.asked(), 11, "the page was asked at each resume (the one to the refusing origin aside)");
    assert.ok(!gh.writes.some((w) => w.includes("factory:block")));
    // Twelve hours from the first pause: taken up at once and Blocked as an outage, whatever the page says.
    at.t = first + OUTAGE.blockMs;
    assert.deepEqual(await loop.pausedHere(new Map()), [7]);
    assert.equal((await loop.resume(7)).exit, "blocked");
    assert.equal(tries(), 12);
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("factory:block"));
    assert.match(notice, /github\.test answered HTTP 500 to every try of POST repos\/acme\/app\/issues\/7\/labels from 2026-11-14T08:47:00\.000Z, through 13 pauses over 12 h, past Factory's 12 h bound for GitHub failing/);
    assert.match(notice, /<!-- factory:block \{"cause":"outage"\} -->/);
    assert.ok(!loop.offline.has(7));
  } finally {
    await refusing.close();
    await page.close();
    gh.restore();
  }
});

test("#389: a stage paused on GitHub's 5xx while GitHub's status page reports its parts operational gets one more try, then Blocks naming the request; an incident between starts the try afresh", async () => {
  const gh = claimGitHub();
  let api = "operational";
  const page = await statusPage(() => ({ components: parts(api) }));
  try {
    const { loop, next, tries } = await serverPaused();
    // Operational: one more try. Then an incident: wait on. Operational again: one more try, not a Block.
    assert.notEqual((await next()).exit, "blocked");
    api = "partial_outage";
    assert.notEqual((await next()).exit, "blocked");
    api = "operational";
    assert.notEqual((await next()).exit, "blocked");
    assert.equal(tries(), 3);
    // That try met the 5xx again, and the page still says operational: Blocked, naming the request, the status and the page.
    assert.equal((await next()).exit, "blocked");
    assert.equal(tries(), 3, "no try after the one more");
    assert.equal(page.asked(), 4);
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("factory:block"));
    assert.match(notice, /github\.test answered HTTP 500 to every try of POST repos\/acme\/app\/issues\/7\/labels from 2026-11-14T08:47:00\.000Z, through 4 pauses over \d+ min; GitHub's status page reported API Requests operational, Issues operational, Pull Requests operational, before and after one more try, so the failure is this request's/);
    assert.match(notice, /<!-- factory:block \{"cause":"factory"\} -->/);
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "the claim is dropped");
    assert.ok(!loop.offline.has(7));
    // A stage that ends any other way starts the count again.
    gh.labels.delete("factory:blocked");
    gh.labels.add("factory:running");
    await loop.withClaim(7, async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "github.test", origin: "https://github.test", code: "HTTP 500", since: new Date().toISOString() } }));
    await loop.withClaim(7, async () => ({ exit: "delivered" }));
    assert.ok(!loop.offline.has(7));
  } finally {
    await page.close();
    gh.restore();
  }
});

test("pausedHere: an Objective paused on a provider that never answers again is taken up past the bound, so resume Blocks it; a stopped one's pause is forgotten (#228)", async () => {
  const gh = claimGitHub();
  const inner = globalThis.fetch;
  // GitHub answers; the provider never does.
  globalThis.fetch = async (url, init) => (new URL(url).origin === "https://api.anthropic.test" ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })) : inner(url, init));
  try {
    const loop = await claimLoop();
    const since = Date.parse("2026-11-14T08:47:00Z");
    let t = since + 60 * 60_000;
    loop.clock = () => t;
    const paused = async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "api.anthropic.test", origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: new Date(since).toISOString() } });
    await loop.withClaim(7, paused);
    assert.deepEqual(await loop.pausedHere(new Map()), [], "inside the bound: waits for its host");
    t = since + OUTAGE.blockMs;
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "past it: taken up whatever the probe says");
    assert.equal((await loop.resume(7)).exit, "blocked");
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes('"cause":"outage"'));
    assert.match(notice, /bound for an outage\. api\.anthropic\.test is still unreachable from this machine: re-apply the label once it answers/);
    assert.ok(!/The network is back/.test(notice));
    // Paused again, then stopped by a person: its pause is over with it.
    gh.labels.delete("factory:blocked");
    gh.labels.add("factory:running");
    await loop.withClaim(7, paused);
    assert.ok(loop.offline.has(7));
    gh.labels.delete("factory:objective");
    await loop.pausedHere(new Map());
    assert.ok(!loop.offline.has(7));
  } finally {
    globalThis.fetch = inner;
    gh.restore();
  }
});

test("withClaim: a stage that paused on its harness's usage limit keeps its claim with no lapse; resumed after the reset, never Blocked by the outage bound (#254)", async () => {
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    const since = Date.parse("2026-11-14T21:27:00Z");
    const reset = Date.parse("2026-11-14T23:00:00Z");
    let t = since;
    loop.clock = () => t;
    const paused = async () => ({ exit: "paused", stage: "review", code: 0, usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(since).toISOString() } });
    assert.equal((await loop.withClaim(7, paused)).exit, "paused");
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 1, "the claim stays");
    assert.equal(gh.comments.filter((c) => c.body.startsWith("<!-- factory:7:account-limit -->")).length, 1, "and the pause notice (#265)");
    assert.ok(!loop.lapsed?.has(7), "a pause is no lapse");
    assert.ok(!gh.writes.some((w) => w.startsWith("POST /issues/7/labels")), "nothing Blocked");
    assert.equal(loop.limitUntil({ key: "claude", shared: true }), reset, "no stage starts on claude until the reset");
    assert.equal(loop.limitUntil({ key: "codex", shared: true }), null);
    assert.deepEqual(await loop.pausedHere(new Map()), [], "not resumed before the reset");
    t = reset;
    assert.equal(loop.limitUntil({ key: "claude", shared: true }), null);
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "resumed once the reset has passed");
    // A weekly limit's reset is past the outage bound: still resumed after it, not Blocked as an outage.
    t = since + OUTAGE.blockMs + 60_000;
    loop.offline.get(7).reset = t;
    assert.deepEqual(await loop.pausedHere(new Map()), [7]);
  } finally {
    gh.restore();
  }
});

test("#376: an Objective paused on a usage limit with a far reset resumes at the next tick once its account is no longer held: released with factory hold release, or its files removed by hand; another account's release moves nothing", async () => {
  const gh = claimGitHub();
  try {
    const home = mkdtempSync(join(tmpdir(), "hold-"));
    const dir = holdsDir(home);
    const loop = await claimLoop();
    loop.holds = accountHolds({ dir });
    const hold = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "local.mjs"), "hold", ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    const since = Date.now() - 60_000;
    const reset = since + 30 * 60 * 60_000;
    const limit = { exit: "paused", stage: "work", code: 0, usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(since).toISOString() } };
    assert.equal((await loop.withClaim(7, async () => limit)).exit, "paused");
    assert.equal(loop.offline.get(7).reset, reset, "the pause keeps the provider's reset, thirty hours out");
    loop.holds.limit({ harness: "claude", account: "other", reset, now: Date.now() });
    assert.deepEqual(await loop.pausedHere(new Map()), [], "held: it waits");
    assert.equal(hold("release", "other").status, 0);
    assert.deepEqual(await loop.pausedHere(new Map()), [], "another account's release moves nothing");
    const r = hold("release", "claude");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "released: resumed at the next tick, long before the reset");
    // Paused again on a new limit (after the release, so it holds), then the folder cleared by hand: resumed too.
    await loop.limitPaused(7, { ...limit, usageLimit: { ...limit.usageLimit, since: new Date().toISOString() } });
    assert.deepEqual(await loop.pausedHere(new Map()), [], "a limit after the release holds again");
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    assert.deepEqual(await loop.pausedHere(new Map()), [7]);
  } finally {
    gh.restore();
  }
});

test("serve: while the loop's harness's usage limit is spent, no new work or review starts, said once (#254)", async () => {
  const reviewed = [];
  const run = await serveAgainst({
    view: (read, labels) => labels,
    firstStage: () => Promise.resolve({ exit: "delivered" }),
    stopAfter: 3,
    stubs: {
      harness: "claude",
      holds: heldOn("claude"),
      accountFor: (harness) => ({ name: harness, harness, declared: false }),
      holdOf: (account) => ({ key: account.name, shared: true }),
      pendingReviews: async () => [{ issue: 8, pr: 18 }],
      review: async (n, pr) => (reviewed.push(pr), { exit: "delivered" }),
    },
  });
  assert.deepEqual(run.claims, [], "nothing new started");
  assert.ok(!run.labels.includes("factory:running"), `the dispatcher never picked it: it stays Queued (${run.labels.join(", ")})`);
  assert.deepEqual(reviewed, [], "no review started");
  assert.equal(run.lines.filter((l) => /claude's usage limit is spent until .*; no stage starts on claude until then/.test(l)).length, 1);
});

test("serve: one harness's spent usage limit holds only that harness's work; an Objective labelled for another still starts (#254)", async () => {
  const reviewed = [];
  const run = await serveAgainst({
    view: (read, labels) => [...labels, "factory:harness:codex"],
    firstStage: () => Promise.resolve({ exit: "delivered" }),
    stopAfter: 3,
    stubs: {
      harness: "claude",
      holds: heldOn("claude"),
      accountFor: (harness) => ({ name: harness, harness, declared: false }),
      holdOf: (account) => ({ key: account.name, shared: true }),
      pendingReviews: async () => [{ issue: 8, pr: 18 }],
      review: async (n, pr) => (reviewed.push(pr), { exit: "delivered" }),
    },
  });
  assert.deepEqual(run.claims, [1], "the codex Objective starts on the first tick");
  assert.deepEqual(reviewed, [], "the review on the loop's claude stays held");
});

test("limitPaused: a provider that refuses past its stated reset is held 2, 5, 10, then 15 minutes, not every tick; a reset further out starts over (#254)", async () => {
  // No repository: this loop posts no pause notice (#265), so nothing here reaches GitHub.
  const loop = Object.assign(await claimLoop(), { repo: null });
  let t = Date.parse("2026-11-14T23:01:00Z");
  loop.clock = () => t;
  const pause = (reset, extra = {}) => loop.limitPaused(7, { exit: "paused", stage: "work", usageLimit: { harness: "claude", reset: new Date(reset).toISOString(), since: new Date(t).toISOString(), ...extra } });
  const holds = [];
  for (let i = 0; i < 5; i++) {
    await pause(t - 60_000);
    holds.push((loop.offline.get(7).reset - t) / 60_000);
    t = loop.offline.get(7).reset;
  }
  assert.deepEqual(holds, [2, 5, 10, 15, 15]);
  // A stage held before it ran counts nothing.
  await pause(t + 60_000, { held: true });
  assert.equal(loop.offline.get(7).reset, t + 60_000);
  // A real window ahead: its reset, and the count starts again.
  await pause(t + 60 * 60_000);
  assert.equal(loop.offline.get(7).reset, t + 60 * 60_000);
  t += 60 * 60_000;
  await pause(t - 1);
  assert.equal(loop.offline.get(7).reset, t + 2 * 60_000);
});

test("withClaim: a stage that paused on GitHub's spent rate limit is resumed after the reset, with no probe and no lapse (#250)", async () => {
  const gh = claimGitHub();
  const inner = globalThis.fetch;
  // GitHub answers any probe while its limit is spent: a probe would resume the Objective at once.
  const probes = [];
  globalThis.fetch = async (url, init = {}) => (init.method === "HEAD" ? (probes.push(String(url)), new Response(null, { status: 200 })) : inner(url, init));
  try {
    const loop = await claimLoop();
    const since = Date.parse("2026-11-14T08:47:00Z");
    const reset = since + 20 * 60_000;
    let t = since + 60_000;
    loop.clock = () => t;
    const outage = { host: "github.test", origin: "https://github.test", code: "RATE_LIMIT_SPENT", since: new Date(since).toISOString(), reset: new Date(reset).toISOString() };
    assert.equal((await loop.withClaim(7, async () => ({ exit: "paused", stage: "work", code: 0, outage }))).exit, "paused");
    assert.equal(gh.comments.length, 1, "the claim stays");
    assert.ok(!loop.lapsed?.has(7), "a pause is no lapse");
    assert.deepEqual(await loop.pausedHere(new Map()), [], "not before the reset");
    t = reset - 1;
    assert.deepEqual(await loop.pausedHere(new Map()), [], "not a moment before it");
    assert.deepEqual(probes, [], "no probe: GitHub answers while the limit is spent");
    t = reset;
    assert.deepEqual(await loop.pausedHere(new Map()), [7], "resumed once the reset has passed");
    assert.deepEqual(probes, []);
  } finally {
    globalThis.fetch = inner;
    gh.restore();
  }
});
