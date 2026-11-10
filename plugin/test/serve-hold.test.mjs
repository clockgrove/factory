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
async function fakeGitHub({ view, onList, onIssue = () => {} }) {
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
async function serveAgainst({ view, onList = () => {}, onIssue, firstStage, pausedHere = async () => [], stopAfter = 8, stubs = {} }) {
  const env = { GITHUB_API_URL: process.env.GITHUB_API_URL, FACTORY_LOCAL: process.env.FACTORY_LOCAL, FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL };
  const claims = [];
  const lines = [];
  const fake = await fakeGitHub({
    view,
    onIssue,
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
