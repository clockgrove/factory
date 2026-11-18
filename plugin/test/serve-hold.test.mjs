import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Local } from "../scripts/local.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { OUTAGE } from "../scripts/lib/network.mjs";
import { fakeProc } from "./fixtures/machine.mjs";
import { refusingOrigin } from "./ports.mjs";
import { accountHolds } from "../scripts/lib/holds.mjs";

// The API client retries a failed read (lib/github.mjs RETRY): no real waits here. A fake that must fail a whole read
// fails every one of its tries.
RETRY.sleep = async () => {};

/** The repository's one writer, who answers a Question by re-applying the Objective label. */
const MAINTAINER = { login: "maintainer", type: "User" };

/**
 * A GitHub that keeps one Objective's labels and can show the issues listing a stale view of them (a read from before a
 * stage's exit labels landed). `view(read, labels)` is the listing's labels on its read-th call; `onList(read)` runs
 * after each listing. A single-issue read always shows the current labels; `onIssue(read)` runs after it.
 */
async function fakeGitHub({ view, onList, onIssue = () => {}, extra = () => false }) {
  const labels = new Set(["pendulum:objective"]);
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
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("state") === "open" && url.searchParams.get("labels") !== "pendulum:objective") return send(200, labels.has(url.searchParams.get("labels")) ? [issue([...labels])] : []);
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("state") === "open") {
        reads += 1;
        send(200, [issue(view(reads, [...labels]))]);
        return onList(reads, { labels, timeline });
      }
      if (url.pathname === "/graphql") return send(200, { data: {} });
      if (url.pathname === "/repos/o/r/collaborators") return send(200, [{ login: MAINTAINER.login }]);
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
const stopLabels = (all) => all.filter((l) => !l.startsWith("pendulum:") || l === "pendulum:objective");
const answerAt = (read, at, timeline) => {
  // A maintainer answers by re-applying the Objective label: a writer the repository lists (MAINTAINER).
  if (read === at) timeline.push({ event: "labeled", label: { name: "pendulum:objective" }, actor: MAINTAINER, created_at: new Date().toISOString() });
};

/**
 * Run the real serve and dispatch against `fakeGitHub` until `stopAfter` listings or a second claim. `firstStage(fake)`
 * is the first claim's stage; a later claim ends at once. `pausedHere(fake)` runs at the start of every tick; `stubs`
 * replace more of the loop.
 */
async function serveAgainst({ view, onList = () => {}, onIssue, extra, firstStage, pausedHere = async () => [], stopAfter = 8, stubs = {} }) {
  const env = { GITHUB_API_URL: process.env.GITHUB_API_URL, PENDULUM_LOCAL: process.env.PENDULUM_LOCAL, PENDULUM_LOCAL_ALL: process.env.PENDULUM_LOCAL_ALL };
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
  process.env.PENDULUM_LOCAL = "1";
  process.env.PENDULUM_LOCAL_ALL = "1";
  const loop = Object.assign(Object.create(Local.prototype), {
    repo: { owner: "o", name: "r", full: "o/r" },
    repoFull: "o/r",
    token: "t",
    notice: null,
    second: null,
    wf: { PENDULUM_LOCAL_MAX_CONCURRENT: "2" },
    // A machine of its own (lib/machine.mjs): this one's slots and load are never read or held.
    machine: { home: mkdtempSync(join(tmpdir(), "home-")), proc: fakeProc(mkdtempSync(join(tmpdir(), "proc-"))) },
    opts: { token: "t" },
    children: new Set(),
    baseEnv: () => ({ PENDULUM_LOCAL_ALL: "1", PENDULUM_INPUT_MAX_CONCURRENT: "2" }),
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
  const questionRemoved = fake.writes.filter((w) => w.op === "remove" && w.labels.includes("pendulum:question")).map((w) => w.read);
  return { claims: claims.map((c) => c.read), questionRemoved, lines, labels: [...fake.labels] };
}

test("serve: a Question exit is never re-claimed by a tick that read the issue before its labels landed; a trusted answer re-claims it (#2667)", async () => {
  let stageEnd = null;
  const run = await serveAgainst({
    // 2: the stage cleared Running and has not yet labelled its Question (setStateLabel's gap); 3: a stale listing
    // after the Question landed; from 4 the listing is current.
    view: (read, labels) => (read === 2 || read === 3 ? stopLabels(labels) : labels),
    onList: (read, { labels, timeline }) => {
      if (read === 2) {
        // The stage ends with its Question while this tick's dispatch is still under way.
        labels.add("pendulum:question");
        timeline.push({ event: "labeled", label: { name: "pendulum:question" }, created_at: new Date(Date.now() - 60_000).toISOString() });
        stageEnd({ exit: "question" });
      }
      answerAt(read, 5, timeline);
    },
    firstStage: (fake) => {
      // The stage's exit: Running comes off first, then (on the next listing) its Question goes on.
      fake.labels.delete("pendulum:running");
      return new Promise((ok) => (stageEnd = ok));
    },
  });
  assert.deepEqual(run.claims, [1, 5], "claimed once, then again only after the answer");
  assert.deepEqual(run.questionRemoved, [5], "pendulum:question stays until the answer");
  assert.ok(run.lines.some((l) => /tick: nothing ready; holding #7 \(its stage here ended with a Question/.test(l)), "the tick line names the hold");
});

test("serve: a stop that ends between ticks survives a stale Running read and then a stale Queued one (#2667)", async () => {
  let stageEnd = null;
  let ticks = 0;
  const run = await serveAgainst({
    // 2 is a stale listing that still shows Running; 3 a stale one with no state label.
    view: (read, labels) => (read === 2 ? ["pendulum:objective", "pendulum:running"] : read === 3 ? stopLabels(labels) : labels),
    onList: (read, { timeline }) => answerAt(read, 5, timeline),
    firstStage: () => new Promise((ok) => (stageEnd = ok)),
    pausedHere: async (fake) => {
      ticks += 1;
      if (ticks === 2) {
        // The stage ends with its Question before the second tick reads anything: all its labels land first.
        fake.labels.delete("pendulum:running");
        fake.labels.add("pendulum:question");
        fake.timeline.push({ event: "labeled", label: { name: "pendulum:question" }, created_at: new Date(Date.now() - 60_000).toISOString() });
        stageEnd({ exit: "question" });
        await new Promise((ok) => setImmediate(ok));
      }
      return [];
    },
  });
  assert.deepEqual(run.claims, [1, 5], "claimed once, then again only after the answer");
  assert.deepEqual(run.questionRemoved, [5], "pendulum:question stays until the answer");
});

/**
 * A GitHub for the Objectives of a local loop's claim tests (#167): #7 by default, and any other number with the same
 * labels (`labelsOf(n)`); their comments (with GitHub's update time, and the issue each is on: #7 when none is named),
 * labels and PR.
 * `fail(kind)` answers 502 to a read while it returns true: "comments", "issue" or "pulls" (404 for "repo").
 */
function claimGitHub({ labels = ["pendulum:objective", "pendulum:local", "pendulum:running"], pr = null, fail = () => false, now = () => Date.now() } = {}) {
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
      const c = { id: (id += 1), issue: Number(on[1]), user: { login: "maintainer", type: "User" }, body: JSON.parse(init.body).body, updated_at: new Date(now()).toISOString() };
      comments.push(c);
      return json(c, 201);
    }
    const one = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (one && method === "PATCH") {
      if (fail("patch")) return json({ message: "Server Error" }, 502);
      const c = comments.find((x) => String(x.id) === one[1]);
      Object.assign(c, { body: JSON.parse(init.body).body, updated_at: new Date(now()).toISOString() });
      return json(c);
    }
    if (one && method === "DELETE") {
      comments.splice(comments.findIndex((x) => String(x.id) === one[1]), 1);
      return json({}, 200);
    }
    if (p === "/pulls" && method === "GET") return fail("pulls") ? json({ message: "Server Error" }, 502) : json(pr && !pr.unopened ? [pr] : []);
    if (pr && p === `/pulls/${pr.number}` && method === "GET") return json(pr);
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
  return Object.assign(Object.create(Local.prototype), { repo: { owner: "acme", name: "app", full: "acme/app" }, repoFull: "acme/app", dev: mkdtempSync(join(tmpdir(), "claims-")), opts: { token: "t" }, holder: holderId(machineIdentity(), holderPid), stopping: false, claimRetryMs: 0, baseEnv: () => ({}), holdOf: (account) => ({ key: account.name, shared: true }) });
}

for (const [stage, end, how] of [
  ["work", { code: 137, signal: null }, /exit code 137/],
]) {
  test(`withClaim: a ${stage} stage that ends with no exit record keeps its claim and is resumed once; a second such end Blocks it with its exit and log (cause pendulum) (#167)`, async () => {
    const gh = claimGitHub({ labels: ["pendulum:objective", "pendulum:local", stage === "work" ? "pendulum:running" : "pendulum:in-review"] });
    try {
      const loop = await claimLoop();
      const died = async () => ({ ...end, exit: null, usd: null, stage, log: "/x/.pendulum/7/usage/stage.log" });
      assert.equal((await loop.withClaim(7, died)).exit, null);
      assert.equal(gh.comments.length, 1, "the claim stays: the dispatcher sees it held, never vanished");
      assert.match(gh.comments[0].body, new RegExp(`holder: ${loop.holder}`));
      assert.ok(!gh.writes.some((w) => w.startsWith("POST /issues/7/labels")), "no Block on the first");
      // This loop resumes it once, at once (its own claim, still fresh), and not while it runs here.
      assert.deepEqual(await loop.pausedHere(new Map()), [7]);
      assert.deepEqual(await loop.pausedHere(new Map([[7, null]])), []);
      // The resume dies the same way: Blocked here, naming the stage, its exit and its log; the claim goes.
      await loop.withClaim(7, died);
      assert.ok(gh.labels.has("pendulum:blocked"));
      const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("pendulum:block"));
      assert.match(notice, new RegExp(`the ${stage} stage ended with no exit record \\(${how.source}\\) twice in a row on this machine; its log on this machine: /x/.pendulum/7/usage/stage.log`));
      assert.match(notice, /<!-- pendulum:block \{"cause":"pendulum"\} -->/);
      assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0);
      assert.deepEqual(await loop.pausedHere(new Map()), [], "nothing left to resume");
      // A stage with an exit record drops the claim and clears the count.
      gh.labels.delete("pendulum:blocked");
      await loop.withClaim(7, died);
      await loop.withClaim(7, async () => ({ exit: "delivered" }));
      assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0);
      assert.ok(!loop.lapsed.has(7));
    } finally {
      gh.restore();
    }
  });
}

test("#421: the lapse check decides a stage's lapse: same_again Blocks at once naming the verdict; transient resumes, and the third lapse in a row Blocks", async () => {
  const { writeFileSync } = await import("node:fs");
  const { openLapseCheck } = await import("../scripts/lib/lapse-check.mjs");
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    const log = join(loop.dev, "stage.log");
    writeFileSync(log, `${Array.from({ length: 200 }, (_, i) => `[#7 work] line ${i}`).join("\n")}\n[#7 work] bash: pnpm: command not found\n`);
    const asked = [];
    let verdict = "same_again";
    loop.lapseCheck = openLapseCheck({ decider: { name: "fake", decide: async (input, question) => (asked.push({ input, question }), { verdict, confidence: 0.9 }) } });
    const died = async () => ({ code: 127, signal: null, exit: null, usd: null, stage: "work", log });
    // The newest Blocked notice as it now reads: on Actions (GITHUB_RUN_ID) each Block updates the one notice in place.
    const lastNotice = () => gh.comments.filter((c) => c.body.includes(":blocked:")).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id).at(-1).body;
    // A cause that stays: Blocked on the first lapse, no resume spent on it.
    await loop.withClaim(7, died);
    assert.ok(gh.labels.has("pendulum:blocked"), "Blocked on the first lapse");
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("pendulum:block"));
    assert.match(notice, /the work stage ended with no exit record \(exit code 127\) on this machine; the lapse check \(.*\) judged it likely to end the same way again; its log on this machine: /);
    assert.equal(asked[0].question.name, "stage_lapse");
    assert.match(asked[0].input, /Stage: work\nEnded with: exit code 127/);
    assert.match(asked[0].input, /bash: pnpm: command not found/, "the end of its log");
    assert.ok(!asked[0].input.includes("line 49\n"), "its last 150 lines only");
    assert.match(asked[0].input, /Machine at the end: /);
    assert.ok(!asked[0].input.includes("The time before"), "no lapse before it");
    // A cause that passed (an out-of-memory kill under load): resumed, then resumed again; the third in a row Blocks.
    gh.labels.delete("pendulum:blocked");
    verdict = "transient";
    const before = gh.writes.filter((w) => w.includes("pendulum:block")).length;
    await loop.withClaim(7, died);
    await loop.withClaim(7, died);
    assert.equal(gh.writes.filter((w) => w.includes("pendulum:block")).length, before, "two transient lapses resume");
    assert.equal(loop.lapsed.get(7).count, 2);
    assert.match(asked.at(-1).input, /The time before \(resumed after it\):/, "the lapse before it is given too");
    await loop.withClaim(7, died);
    assert.ok(gh.labels.has("pendulum:blocked"));
    assert.match(lastNotice(), /3 times in a row on this machine; the lapse check \(.*\) judged it transient/);
    // A verdict under the floor is none: resumed once, the second Blocks (as with no key).
    gh.labels.delete("pendulum:blocked");
    loop.lapseCheck = openLapseCheck({ decider: { decide: async () => ({ verdict: "same_again", confidence: 0.5 }) } });
    await loop.withClaim(7, died);
    assert.equal(loop.lapsed.get(7).count, 1);
    // PENDULUM_LOCAL_LAPSE_MAX sets the transient lapse in a row that Blocks: 4 here, so the third resumes.
    loop.lapsed.delete(7);
    gh.labels.delete("pendulum:blocked");
    loop.wf = { ...loop.wf, PENDULUM_LOCAL_LAPSE_MAX: "4" };
    verdict = "transient";
    loop.lapseCheck = openLapseCheck({ decider: { decide: async () => ({ verdict, confidence: 0.9 }) } });
    const blocks = gh.writes.filter((w) => w.includes("pendulum:block")).length;
    for (let i = 0; i < 3; i += 1) await loop.withClaim(7, died);
    assert.equal(loop.lapsed.get(7).count, 3);
    assert.equal(gh.writes.filter((w) => w.includes("pendulum:block")).length, blocks);
    await loop.withClaim(7, died);
    assert.match(lastNotice(), /4 times in a row on this machine/);
  } finally {
    gh.restore();
  }
});

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

test("#421: withClaim's heartbeat reads the claim before it writes: one another live loop now holds ends this loop's stage, with no lapse and its claim left alone", async () => {
  const { spawn } = await import("node:child_process");
  const { holderId, machineIdentity } = await import("../scripts/local.mjs");
  const gh = claimGitHub();
  try {
    const loop = await claimLoop();
    loop.heartbeatMs = 50;
    loop.children = new Set();
    // Another machine's loop, alive: its write landed after this loop read its own name back.
    const other = holderId({ ...machineIdentity(), host: "other-box" }, 4242);
    let stage = null;
    // The stage process as stage() starts it: tagged with its Objective among the loop's children.
    const fn = () =>
      new Promise((done) => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"]);
        child.issue = 7;
        loop.children.add(child);
        stage = child;
        child.on("spawn", () => {
          const c = gh.comments[0];
          c.body = c.body.replaceAll(loop.holder, other);
          c.updated_at = new Date().toISOString();
        });
        child.on("close", (code, signal) => (loop.children.delete(child), done({ code, signal, exit: null, stage: "work" })));
      });
    const r = await loop.withClaim(7, fn);
    assert.equal(stage.signalCode, "SIGTERM", "the stage was ended at a heartbeat, not by itself");
    assert.equal(r.exit, "skipped");
    assert.ok(!loop.lapsed?.has(7), "no lapse");
    assert.equal(gh.comments.length, 1);
    assert.match(gh.comments[0].body, new RegExp(`holder: ${other}`), "the other loop's claim is not overwritten or dropped");
    assert.ok(loop.ceded.has(7), "and this loop does not resume it from that claim");
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
    assert.ok(!gh.labels.has("pendulum:running"), "un-marked");
    assert.equal(gh.comments.length, 0, "its claim goes with the Running mark");
    assert.deepEqual(posted(), [], "no Block on a first failure");
    assert.match(loop.startHolds()[7], /its last start here failed \(1 in a row\)/);
    now += START_BACKOFF_MS - 1000;
    assert.ok(loop.startHolds()[7], "still held before the backoff ends");
    now += 2000;
    assert.deepEqual(loop.startHolds(), {}, "free to pick once it ends");
    // Second failure (the dispatcher marked it Running again): held twice as long.
    gh.labels.add("pendulum:running");
    await loop.runObjective(7);
    assert.ok(!gh.labels.has("pendulum:running"));
    now += 2 * START_BACKOFF_MS - 1000;
    assert.ok(loop.startHolds()[7]);
    now += 2000;
    // Third failure in a row: Blocked once, with the error and cause `setup`, not un-marked again.
    gh.labels.add("pendulum:running");
    r = await loop.runObjective(7);
    assert.equal(r.exit, "blocked");
    assert.ok(gh.labels.has("pendulum:blocked"));
    assert.equal(posted().length, 1);
    assert.match(posted()[0], /could not start on this machine 3 times in a row \(work, ENOSPC\): ENOSPC from mkdir; the local loop's log names the path\./);
    assert.ok(!posted()[0].includes("/srv/accounts"), "no path of this machine's set-up");
    assert.match(posted()[0], /<!-- pendulum:block \{"cause":"setup"\} -->/);
    assert.deepEqual(loop.startHolds(), {}, "the Block ends the count");
    // A start that succeeds clears an earlier failure.
    gh.labels.delete("pendulum:blocked");
    gh.labels.add("pendulum:running");
    await loop.runObjective(7);
    assert.ok(loop.startFailures.has(7));
    gh.labels.add("pendulum:running");
    loop.fail = false;
    await loop.runObjective(7);
    assert.ok(!loop.startFailures.has(7), "a start clears it");
    assert.equal(starts, 5);
    // A start that fails on an Objective no longer Running (a person moved it) changes no label.
    loop.fail = true;
    gh.labels.delete("pendulum:running");
    gh.labels.add("pendulum:question");
    await loop.runObjective(7);
    assert.ok(gh.labels.has("pendulum:question"));
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
      if (fail) throw Object.assign(new Error(`${fail.code}: mkdir '/srv/box/.pendulum/${n}/usage-work'`), { ...fail, syscall: "mkdir", path: `/srv/box/.pendulum/${n}/usage-work` });
      return { code: 0, exit: "blocked", usd: 0 };
    };
    const posted = () => gh.writes.filter((w) => /^POST \/issues\/\d+\/(comments|labels)/.test(w) && !w.includes(":local -->"));
    // #7 alone: its own, as before: back to Queued, one failed start counted, held for its backoff; no machine hold.
    await loop.runObjective(7);
    assert.ok(!gh.labelsOf(7).has("pendulum:running"));
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
          gh.labelsOf(n).add("pendulum:running");
          await loop.runObjective(n);
        }
      }
    });
    assert.ok(!gh.labelsOf(8).has("pendulum:running"), "back to Queued");
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
    assert.ok(read.at(-1).startsWith("/srv/box/.pendulum/"));
    const probed = read.length;
    free = START_DISK_FLOOR;
    assert.ok((await loop.machineWait()).work, "within the minute: the last probe's answer");
    assert.equal(read.length, probed);
    // Another cause on one Objective, during the hold: its own, counted as before.
    fail = { code: "EACCES", errno: -13 };
    gh.labelsOf(9).add("pendulum:running");
    await loop.runObjective(9);
    assert.equal(loop.startFailures.get(9).count, 1);
    // The disk freed, a minute on: the hold ends, said once, and starts go on; one that starts clears its record.
    now += MACHINE_PROBE_EVERY_MS;
    const back = await logged(async () => assert.deepEqual(await loop.machineWait(), { work: null, all: null }));
    assert.ok(back.some((l) => /this machine's start fault \(setup, ENOSPC\) is gone \(2 GB free on its disk\): new starts resume/.test(l)));
    fail = null;
    gh.labelsOf(7).add("pendulum:running");
    await loop.runObjective(7);
    assert.ok(!loop.startFailures.has(7));
  } finally {
    gh.restore();
  }
});

test("serve: a review this loop owes is held from its own dispatch, so a day-old In-review Objective is reviewed, never Blocked in the same tick (#167)", async () => {
  const reviewed = [];
  let loop = null;
  const run = await serveAgainst({
    view: () => ["pendulum:objective", "pendulum:local", "pendulum:in-review"],
    onList: (read, { timeline }) => {
      // In review for three days; the merge pass re-applied pendulum:review to its PR long ago, as the fixture's day 0.
      if (read === 1) timeline.push({ event: "labeled", label: { name: "pendulum:in-review" }, created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    },
    extra: (req, url, send) => {
      if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head")) return send(200, [{ number: 9, draft: false, labels: [{ name: "pendulum:review" }], head: { ref: "pendulum/7" } }]), true;
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
  assert.ok(!run.labels.includes("pendulum:blocked"), "never Blocked as 'no local loop running its review'");
  assert.ok(!run.lines.some((l) => /no local loop running its review/.test(l)));
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
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("pendulum:block"));
    assert.match(notice, /this machine could not reach api\.anthropic\.test \(EAI_AGAIN\) from Nov 14, 8:47 AM UTC for 12 h, past Pendulum's 12 h bound for an outage\. The network is back: re-apply the label/);
    assert.match(notice, /<!-- pendulum:block \{"cause":"outage"\} -->/);
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "the claim is dropped");
    // A later pause long after a resume is a new outage: its own since.
    gh.labels.delete("pendulum:blocked");
    gh.labels.add("pendulum:running");
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
 * `pendulum run 7 --wait` (runToEnd; `go` for another command) against claimGitHub, its stages ending as `ends` says in
 * turn (stage() stubbed: the rest of the run is real; an end may be a function of the stage), on a clock `at()` that
 * reads it; the provider's host api.anthropic.test answers once `up(probe)` says so for that probe (1, 2, …). A PR's
 * merge, once followed, is `merged` (true by default; `merges` counts the follows); `prep(loop)` sets the loop up further. Returns the run's end, its exit status, its log, the
 * stages started and the probes made.
 */
async function runPaused({ ends, up, at, merged = true, prep = () => {}, go = (loop) => loop.runToEnd(7, { wait: true, resumeWith: " --repo acme/app" }) }) {
  const { runExit } = await import("../scripts/local.mjs");
  const inner = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = async (url, init) => (new URL(url).origin === "https://api.anthropic.test" && !up((probes += 1)) ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })) : inner(url, init));
  try {
    const loop = await claimLoop();
    loop.clock = at;
    loop.resumePollMs = 1;
    const started = [];
    loop.stage = async (n, name) => {
      started.push(name);
      const end = ends[started.length - 1];
      return typeof end === "function" ? end(name) : end;
    };
    const merges = [];
    loop.followMerge = async (n, prNumber) => (merges.push(prNumber), merged);
    prep(loop);
    let r;
    const lines = await logged(async () => {
      r = await go(loop);
    });
    return { r, code: runExit(r), log: lines.join(""), started, probes, loop, merges };
  } finally {
    globalThis.fetch = inner;
  }
}

const lostSince = Date.parse("2026-11-17T08:47:00Z");
const pausedOnDns = { exit: "paused", stage: "work", code: 0, outage: { host: "api.anthropic.test", origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: new Date(lostSince).toISOString() } };

test("#575: run --wait waits in place for a stage paused on this machine's network, resumes it once its host answers, and exits 0 once the resumed stage's PR merged", async () => {
  const pr = reviewPr(true);
  const gh = claimGitHub({ pr });
  try {
    const t = lostSince + 20 * 60_000;
    const { r, code, log, started, probes } = await runPaused({ ends: [pausedOnDns, delivers(pr), delivers(pr)], up: (n) => n >= 3, at: () => t });
    assert.deepEqual(started, ["work", "work", "review"], "the paused stage is resumed in place, then reviewed");
    assert.equal(probes, 3, "one probe a poll until the host answers");
    assert.equal(r.exit, "delivered");
    assert.equal(code, 0);
    assert.match(log, /#7: waiting here for api\.anthropic\.test to answer, as serve would, up to 12 h from Nov 17, 8:47:00 AM UTC/);
    assert.match(log, /#7: resuming \(api\.anthropic\.test answers again\)/);
    assert.ok(!/#7: paused, resumable/.test(log));
    assert.ok(!gh.writes.some((w) => w.startsWith("POST /issues/7/labels")), "nothing Blocked");
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "the claim is dropped at the end");
  } finally {
    gh.restore();
  }
});

/**
 * PR #5 of pendulum/7, labelled for its review (`unopened`: listed once a work stage delivers). A review stage that
 * delivers takes the label off, as review.mjs does.
 */
const reviewPr = (unopened = false) => ({ unopened, number: 5, state: "open", draft: false, head: { ref: "pendulum/7" }, base: { ref: "main" }, labels: [{ name: "pendulum:review" }] });
const delivers = (pr) => (name) => {
  if (name === "work") pr.unopened = false;
  if (name === "review") pr.labels = [];
  return { exit: "delivered", stage: name, code: 0 };
};

test("#575: run --wait exits 0 only once its PR merged: a reviewed PR whose merge follow ends without a merge (Blocked, stopped, held, closed, the bound) exits 1", async () => {
  const pr = reviewPr(true);
  const gh = claimGitHub({ pr });
  try {
    const { r, code, started, merges } = await runPaused({ ends: [delivers(pr), delivers(pr)], up: () => true, at: () => lostSince, merged: false });
    assert.deepEqual(started, ["work", "review"]);
    assert.deepEqual(merges, [5]);
    assert.notEqual(r.exit, "delivered");
    assert.equal(code, 1);
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "the claim is dropped, as on any end with no pause");
  } finally {
    gh.restore();
  }
});

test("#575: run --wait keeps its claim fresh while it waits with GitHub answering: written at least every heartbeat, so no serve here takes it for a loop gone away", async () => {
  const { CLAIM_FRESH_MS, HEARTBEAT_MS } = await import("../scripts/lib/local.mjs");
  const start = Date.now();
  let t = start;
  const gh = claimGitHub({ now: () => t });
  try {
    const since = start - 20 * 60_000;
    const paused = { ...pausedOnDns, outage: { ...pausedOnDns.outage, since: new Date(since).toISOString() } };
    // Each probe that finds the provider still down is five minutes later, up to the bound.
    const { code, started } = await runPaused({ ends: [paused], up: () => ((t += 5 * 60_000), false), at: () => t });
    assert.equal(code, 75);
    assert.deepEqual(started, ["work"]);
    const claim = gh.comments.find((c) => c.body.includes(":local -->"));
    assert.ok(claim, "the claim stays");
    const beats = gh.writes.filter((w) => w.startsWith("PATCH /issues/comments/")).length;
    // Twelve hours, less the twenty minutes before the wait, at one write per five-minute poll once its heartbeat is due.
    assert.ok(beats >= Math.floor((12 * 60 - 20) / 5) - 1, `${beats} claim writes`);
    assert.ok(t - Date.parse(claim.updated_at) < CLAIM_FRESH_MS, "fresh when the run stops waiting");
    assert.ok(HEARTBEAT_MS < CLAIM_FRESH_MS);
  } finally {
    gh.restore();
  }
});

test("#575: run --wait resumes nothing for an Objective stopped while paused (its claim goes, as a stopped stage's does), nor for one whose claim another loop took", async () => {
  const { holderId } = await import("../scripts/local.mjs");
  const other = holderId({ host: "other-box", machine: "m2", boot: "b2" }, 4242);
  for (const how of ["stopped", "taken"]) {
    const gh = claimGitHub();
    try {
      const prep = (loop) => {
        const real = loop.outageDue.bind(loop);
        loop.outageDue = async (...a) => {
          if (how === "stopped") gh.labels.delete("pendulum:objective");
          else for (const c of gh.comments) c.body = c.body.replaceAll(loop.holder, other);
          return real(...a);
        };
      };
      const { r, code, log, started } = await runPaused({ ends: [pausedOnDns], up: () => true, at: () => lostSince + 20 * 60_000, prep });
      assert.deepEqual(started, ["work"], "never resumed");
      assert.equal(r.exit, how === "stopped" ? "stopped" : "skipped");
      assert.equal(code, 1);
      if (how === "stopped") {
        assert.match(log, /#7: stopped while paused; not resuming it/);
        assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "its claim goes");
      } else {
        assert.ok(log.includes(`#7: its claim is no longer this run's (${other}); not resuming it`));
        assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 1, "the other loop's claim is left alone");
      }
    } finally {
      gh.restore();
    }
  }
});

/**
 * GitHub's status page served on this machine (GITHUB_STATUS_URL): `answer()` is {status, components, incidents,
 * maintenances} per request, the components as {name: status}, the others as Statuspage's summary.json lists them;
 * `close` stops it and clears the variable. Each request is counted in `asked()`, its paths in `paths`.
 */
async function statusPage(answer) {
  let n = 0;
  const paths = [];
  const server = createServer((req, res) => {
    n += 1;
    paths.push(req.url);
    const a = answer();
    res.writeHead(a.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ page: { id: "x", name: "GitHub" }, components: Object.entries(a.components ?? {}).map(([name, status]) => ({ id: name, name, status })), incidents: a.incidents ?? [], scheduled_maintenances: a.maintenances ?? [], status: { indicator: "none" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.GITHUB_STATUS_URL = `http://127.0.0.1:${server.address().port}`;
  return { asked: () => n, paths, close: () => (delete process.env.GITHUB_STATUS_URL, new Promise((r) => server.close(r))) };
}
const parts = (api, rest = "operational") => ({ "Git Operations": "major_outage", "API Requests": api, Issues: rest, "Pull Requests": rest });

/** A loop with an Objective paused on GitHub's 5xx, whose resumed stage pauses on the same 5xx again (runObjective). */
async function serverPaused() {
  const loop = await claimLoop();
  const first = Date.parse("2026-11-14T08:47:00Z");
  // `endpoint`: the request the resumed stage's next 5xx meets (a test moves it on to another).
  const at = { t: first, endpoint: "POST repos/acme/app/issues/7/labels" };
  loop.clock = () => at.t;
  // GitHub's host answers a probe (github.test answers every request) while that one request keeps failing.
  const paused = () => async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "github.test", origin: "https://github.test", code: "HTTP 500", since: new Date(at.t).toISOString(), endpoint: at.endpoint } });
  let tries = 0;
  // The resumed stage starts its process (stage(): tryStarted) and runs longer than a network outage's carry-over before
  // it meets the 5xx again.
  const stub = (n) => ((tries += 1), loop.tryStarted(n), (at.t += OUTAGE.stageWaitMs + 60_000), loop.withClaim(n, paused()));
  loop.runObjective = stub;
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
  // A resume after the wait with no time moved (one skipped before it, tried again on the next tick).
  const again = () => loop.resume(7);
  return { loop, first, at, next, again, stub, tries: () => tries };
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
    assert.ok(!gh.writes.some((w) => w.includes("pendulum:block")));
    // Twelve hours from the first pause: taken up at once and Blocked as an outage, whatever the page says.
    at.t = first + OUTAGE.blockMs;
    assert.deepEqual(await loop.pausedHere(new Map()), [7]);
    assert.equal((await loop.resume(7)).exit, "blocked");
    assert.equal(tries(), 12);
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("pendulum:block"));
    assert.match(notice, /github\.test answered HTTP 500 to every try of POST repos\/acme\/app\/issues\/7\/labels from Nov 14, 8:47 AM UTC, through 13 pauses over 12 h, past Pendulum's 12 h bound for github\.test failing/);
    assert.match(notice, /<!-- pendulum:block \{"cause":"outage"\} -->/);
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
    assert.ok(page.paths.every((u) => u === "/api/v2/summary.json"), page.paths.join(" "));
    const notice = gh.writes.find((w) => w.startsWith("POST /issues/7/comments") && w.includes("pendulum:block"));
    assert.match(notice, /github\.test answered HTTP 500 to every try of POST repos\/acme\/app\/issues\/7\/labels from Nov 14, 8:47 AM UTC; GitHub's status page reported API Requests operational, Issues operational, Pull Requests operational, before and after one more try, so the failure is this request's/);
    assert.match(notice, /<!-- pendulum:block \{"cause":"pendulum"\} -->/);
    assert.equal(gh.comments.filter((c) => c.body.includes(":local -->")).length, 0, "the claim is dropped");
    assert.ok(!loop.offline.has(7));
    // A stage that ends any other way starts the count again.
    gh.labels.delete("pendulum:blocked");
    gh.labels.add("pendulum:running");
    await loop.withClaim(7, async () => ({ exit: "paused", stage: "work", code: 0, outage: { host: "github.test", origin: "https://github.test", code: "HTTP 500", since: new Date().toISOString() } }));
    await loop.withClaim(7, async () => ({ exit: "delivered" }));
    assert.ok(!loop.offline.has(7));
  } finally {
    await page.close();
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
    assert.equal(gh.comments.filter((c) => c.body.startsWith("<!-- pendulum:7:account-limit -->")).length, 1, "and the pause notice (#265)");
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
  assert.ok(!run.labels.includes("pendulum:running"), `the dispatcher never picked it: it stays Queued (${run.labels.join(", ")})`);
  assert.deepEqual(reviewed, [], "no review started");
  assert.equal(run.lines.filter((l) => /claude's usage limit is spent until .*; no stage starts on claude until then/.test(l)).length, 1);
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

test("serve: a held account days from its reset is probed beside the tick; once the probe is answered the hold is released and the Objective it held starts at a later tick (#613)", { timeout: 60_000 }, async (ctx) => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  // The harness on the loop's PATH: a fake `claude` that answers the probe, logging each call.
  const bin = mkdtempSync(join(tmpdir(), "probe-bin-"));
  const calls = join(bin, "calls.txt");
  const out = [{ type: "system", subtype: "init", session_id: "11111111-1111-1111-1111-111111111111" }, { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", session_id: "11111111-1111-1111-1111-111111111111", total_cost_usd: 0.004, usage: { input_tokens: 900, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }].map((l) => JSON.stringify(l)).join("\n");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nconst fs = require("node:fs");\nfs.readFileSync(0);\nfs.appendFileSync(${JSON.stringify(calls)}, "call\\n");\nprocess.stdout.write(${JSON.stringify(`${out}\n`)});\n`, { mode: 0o755 });
  const holds = accountHolds();
  holds.limit({ harness: "claude", account: "claude", reset: Date.now() + 3 * 24 * 60 * 60_000, now: Date.now() });
  const started = [];
  const run = await serveAgainst({
    view: (read, labels) => labels,
    firstStage: () => Promise.resolve({ exit: "delivered" }),
    // The loop ends on the event itself, the Objective's start (runObjective), however many ticks that takes: no count
    // of listings bounds it. A run that never gets there ends with the test's own time cap.
    stopAfter: Infinity,
    stubs: {
      harness: "claude",
      holds,
      accountFor: (harness) => ({ name: harness, harness, declared: false }),
      holdOf: (account) => ({ key: account.name, shared: true }),
      pausedHere() {
        if (ctx.signal.aborted) this.stopping = true;
        return Promise.resolve([]);
      },
      baseEnv: () => ({ PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1", PENDULUM_INPUT_MAX_CONCURRENT: "2" }),
      runObjective(n) {
        started.push(n);
        this.stopping = true;
        return Promise.resolve({ exit: "delivered" });
      },
    },
  });
  assert.deepEqual(started, [7], "the Objective the hold kept Queued started once the probe released it");
  assert.equal(readFileSync(calls, "utf8"), "call\n", "one probe, however many ticks passed while it ran");
  assert.equal(run.lines.filter((l) => /claude: answered a probe before its usage limit's reset .*its hold is released, as `pendulum hold release claude` does; .*\(the probe: \$0\.0040\)/.test(l)).length, 1, run.lines.join(""));
  assert.equal(holds.until("claude", Date.now()), null);
});

test("serve: a dispatch that releases a stop never drops a newer stop recorded while it ran (#2667)", async () => {
  let reviewEnd = null;
  let ticks = 0;
  const run = await serveAgainst({
    // 4 is a stale listing with no state label, after the review's Block landed.
    view: (read, labels) => (read === 4 ? stopLabels(labels) : labels),
    onList: (read, { labels }) => {
      // A person clears the Block by hand: the next tick's fresh read shows it Queued and releases the first stop.
      if (read === 2) labels.delete("pendulum:blocked");
    },
    onIssue: (read, { labels }) => {
      if (read !== 3 || !reviewEnd) return;
      // The review running here Blocks after that fresh read, while the same dispatch is still under way.
      labels.add("pendulum:blocked");
      reviewEnd({ exit: "blocked" });
      reviewEnd = null;
    },
    firstStage: (fake) => {
      fake.labels.delete("pendulum:running");
      fake.labels.add("pendulum:blocked");
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

test("resume: a failed read of the issue or its PR keeps the claim and runs nothing (#167)", async () => {
  let down = true;
  const gh = claimGitHub({ labels: ["pendulum:objective", "pendulum:local", "pendulum:in-review"], fail: (kind) => down && kind === "issue" });
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

test("runObjective: a start that fails on a claim it cannot read changes nothing (#167)", async () => {
  const gh = claimGitHub({ fail: (kind) => kind === "comments" });
  try {
    const loop = await claimLoop();
    loop.stage = async () => ({ code: 0, exit: "blocked", usd: 0, stage: "work" });
    // The claim cannot be read: another machine may be running it, so nothing changes yet.
    const r = await loop.runObjective(7);
    assert.equal(r.startFailed, "claim-read");
    assert.ok(gh.labels.has("pendulum:running"), "not un-marked");
    assert.deepEqual(gh.writes, [], "nothing written");
  } finally {
    gh.restore();
  }
});
