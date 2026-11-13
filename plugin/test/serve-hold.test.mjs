import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Local } from "../scripts/local.mjs";
import { stopHold } from "../scripts/lib/local.mjs";

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
 * A GitHub for one Objective (#7) of a local loop's claim tests (#167): its comments (with GitHub's update time), labels
 * and PR. `fail(kind)` answers 502 to a read while it returns true: "comments", "issue" or "pulls".
 */
function claimGitHub({ labels = ["factory:objective", "factory:local", "factory:running"], pr = null, fail = () => false } = {}) {
  const comments = [];
  const writes = [];
  const state = { labels: new Set(labels) };
  let id = 100;
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname.replace("/repos/acme/app", "");
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") writes.push(`${method} ${p}${method === "POST" ? ` ${JSON.parse(init.body).body ?? JSON.stringify(JSON.parse(init.body))}` : ""}`);
    if (p === "/user") return json({ login: "maintainer", type: "User" });
    if (p === "/collaborators") return json([{ login: "maintainer" }]);
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "GET" && p === "/issues/7/comments") return fail("comments") ? json({ message: "Server Error" }, 502) : json(comments);
    if (method === "POST" && p === "/issues/7/comments") {
      const c = { id: (id += 1), user: { login: "maintainer", type: "User" }, body: JSON.parse(init.body).body, updated_at: new Date().toISOString() };
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
    if (p === "/issues/7" && method === "GET") return fail("issue") ? json({ message: "Server Error" }, 502) : json({ number: 7, state: "open", labels: [...state.labels].map((name) => ({ name })) });
    const label = /^\/issues\/7\/labels\/(.+)$/.exec(p);
    if (label && method === "DELETE") return state.labels.delete(decodeURIComponent(label[1])) ? json([]) : json({ message: "Not Found" }, 404);
    if (p === "/issues/7/labels" && method === "POST") {
      for (const l of JSON.parse(init.body).labels) state.labels.add(l);
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
  return { comments, writes, labels: state.labels, restore };
}

/** A loop with this machine's holder id and no waits between claim reads. */
async function claimLoop(holderPid = process.pid) {
  const { holderId, machineIdentity } = await import("../scripts/local.mjs");
  return Object.assign(Object.create(Local.prototype), { repo: { owner: "acme", name: "app", full: "acme/app" }, repoFull: "acme/app", opts: { token: "t" }, holder: holderId(machineIdentity(), holderPid), stopping: false, claimRetryMs: 0, claimSettleMs: 0, baseEnv: () => ({}) });
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

test("withClaim: a read-back that fails once is read again; one that never answers keeps the claim for this loop to resume (#167)", async () => {
  // The comments reads of one claim: the check for another holder, upsertComment's own, then the read-back (the 3rd).
  let reads = 0;
  let failFrom = 3;
  let failTo = 3;
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
      if (loop.fail) throw Object.assign(new Error("ENOSPC: no space left on device, mkdir"), { code: "ENOSPC" });
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
    assert.match(posted()[0], /could not start on this machine 3 times in a row \(work, ENOSPC\): ENOSPC: no space left on device/);
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
