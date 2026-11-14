import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REBASED_TWICE, applyExit, mergeBlockReason, mergeReadyOne, rebaseMarkers, rebaseNotice, rebasedTwiceBlock, recordMergeable } from "../scripts/lib/session.mjs";
import { marker, setSelf, staleDecision } from "../scripts/lib/logic.mjs";
import { Local } from "../scripts/local.mjs";
import { RETRY, transientError } from "../scripts/lib/github.mjs";
import { planTextMarker } from "../scripts/lib/handoff.mjs";
import { EDITED_REASON, objectiveSha } from "../scripts/lib/objective-trust.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

// #2647: two sibling Objectives add a function to one module. The first merges; the second, reviewed and green, then
// conflicts at its merge. It goes back for one rebase (no Block), merges after it, and a conflict after that rebase Blocks.

const SELF = "factory-app[bot]";
const repo = { full: "o/r", owner: "o", name: "r" };

/** A real git repository: GitHub's mergeable state for a PR is git's own answer for its head against main. */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "conflict-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "main");
  const commit = (branch, from, text, msg) => {
    git("checkout", "-q", "-B", branch, from);
    writeFileSync(join(dir, "store.mjs"), text);
    git("add", "store.mjs");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  writeFileSync(join(dir, "store.mjs"), "export const version = 1;\n");
  git("add", "store.mjs");
  git("commit", "-q", "-m", "base");
  const conflicts = (head) => spawnSync("git", ["-C", dir, "merge-tree", "--write-tree", "main", head]).status === 1;
  return { dir, git, commit, conflicts, main: () => git("rev-parse", "main") };
}

/** GitHub as the merge pass reads it, over the git repository: PRs, comments, reviews, green CI and the merge queue. */
function fakeGitHub(g) {
  const prs = {};
  const comments = {};
  const enqueued = [];
  // Every enqueue call, refused or not: "nothing enqueued" alone cannot tell a call never made from one GitHub refused.
  const attempts = [];
  // The PRs a test put in the merge queue, and `race`: another merge pass that runs just before a merge call lands (#2669).
  const queued = new Set();
  const state = { race: null };
  let id = 1;
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const prView = (pr) => {
    if (pr.unknownOnce) {
      pr.unknownOnce = false;
      return { ...pr, mergeable: null, mergeable_state: "unknown" };
    }
    const dirty = g.conflicts(pr.head.sha);
    return { ...pr, mergeable: !dirty, mergeable_state: dirty ? "dirty" : "clean" };
  };
  const runRace = async () => {
    const race = state.race;
    state.race = null;
    if (race) await race();
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if (/\/graphql$/.test(u)) {
      const q = body.query;
      if (q.includes("isInMergeQueue")) return json(200, { data: { repository: { pullRequest: { isInMergeQueue: queued.has(body.variables.n) } } } });
      if (q.includes("timelineItems")) return json(200, { data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } } });
      if (q.includes("enqueuePullRequest")) {
        const pr = Object.values(prs).find((p) => p.node_id === body.variables.id);
        attempts.push(pr.number);
        await runRace();
        if (queued.has(pr.number)) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request is already in the queue" }] });
        if (pr.merged) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request is already merged" }] });
        // GitHub's answer for a conflicting PR: a GraphQL error with HTTP 200, so no status on the thrown error.
        if (g.conflicts(pr.head.sha)) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request has merge conflicts and Pull request not in mergeable state" }] });
        enqueued.push({ pr: pr.number, sha: body.variables.oid });
        return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: "e" } } } });
      }
      return json(200, { data: {} });
    }
    if (method === "GET" && (m = /\/repos\/o\/r\/pulls\/(\d+)$/.exec(u))) return json(200, prView(prs[m[1]]));
    if (method === "GET" && (m = /\/repos\/o\/r\/pulls\/(\d+)\/reviews/.exec(u))) return json(200, prs[m[1]].reviews);
    if (method === "PUT" && (m = /\/repos\/o\/r\/pulls\/(\d+)\/merge$/.exec(u))) {
      const pr = prs[m[1]];
      attempts.push(pr.number);
      await runRace();
      if (pr.merged) return json(405, { message: "Pull Request is not mergeable" });
      Object.assign(pr, { merged: true, state: "closed" });
      return json(200, { merged: true });
    }
    if (method === "GET" && /\/repos\/o\/r\/pulls\/\d+\/comments/.test(u)) return json(200, []);
    if (method === "GET" && (m = /\/repos\/o\/r\/issues\/(\d+)\/comments/.exec(u))) return json(200, comments[m[1]] || []);
    if (method === "POST" && (m = /\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(u))) {
      const c = { id: id++, user: { login: SELF }, body: body.body, created_at: new Date().toISOString() };
      (comments[m[1]] ||= []).push(c);
      return json(201, c);
    }
    if (method === "PATCH" && (m = /\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(u))) {
      const c = Object.values(comments).flat().find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return json(200, c);
    }
    if (method === "POST" && (m = /\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(u))) return json(200, body.labels.map((name) => ({ name })));
    if (method === "DELETE" && /\/repos\/o\/r\/issues\/\d+\/labels\//.test(u)) return json(404, { message: "Label does not exist" });
    if (method === "GET" && /\/check-runs/.test(u)) return json(200, { total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] });
    if (method === "GET" && /\/commits\/[0-9a-f]+\/status$/.test(u)) return json(200, { statuses: [] });
    if (method === "GET" && /\/timeline/.test(u)) return json(200, []);
    return json(404, { message: `Not Found: ${method} ${u}` });
  };
  const open = (number, issue, sha) => {
    prs[number] = { number, state: "open", draft: false, merged: false, node_id: `PR_${number}`, title: `Objective ${issue}`, labels: [], head: { sha, ref: `factory/${issue}` }, base: { ref: "main" }, reviews: [{ id: number, user: { login: SELF }, body: `${marker(issue, "review")}\nFactory reviewer`, submitted_at: new Date().toISOString() }] };
    return prs[number];
  };
  return { fetch, prs, comments, enqueued, attempts, open, queued, state };
}

const merge = (issue, prNumber) => mergeReadyOne(repo, { issue, prNumber, queue: true, checkNames: ["ci"] }, { token: "t" });

async function withGitHub(fn) {
  const real = globalThis.fetch;
  setSelf(SELF);
  const g = gitRepo();
  const gh = fakeGitHub(g);
  globalThis.fetch = gh.fetch;
  try {
    await fn(g, gh);
  } finally {
    globalThis.fetch = real;
    setSelf(null);
  }
}

test("#2647: two sibling PRs on one file: the second conflicts at its merge, goes back for one rebase, merges; a second conflict Blocks", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const one = g.commit("factory/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("factory/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(11, 1, one);
    const pr12 = gh.open(12, 2, two);
    // Both reviewed and validated at their heads; neither conflicts yet.
    await recordMergeable(repo, 11, 1, one, { token: "t" });
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    assert.equal(g.conflicts(two), false);

    // The first lands.
    assert.equal(await merge(1, 11), "queued");
    g.git("update-ref", "refs/heads/main", one);

    // The second's review stage reaches the merge: a conflict, never an enqueue GitHub refuses, and no Block.
    assert.equal(await merge(2, 12), "conflict");
    assert.deepEqual(gh.enqueued.map((e) => e.pr), [11], "nothing is enqueued for the conflicting PR");
    assert.deepEqual(gh.attempts, [11], "no enqueue is even attempted for a PR read as conflicting");
    assert.equal(mergeBlockReason("conflict"), null, "a conflict at the merge is not a Block");

    // The send-back (dispatch.mjs): the first is one rebase, with its notice on the PR naming the head it saw.
    let seen = await rebaseMarkers(repo, { issue: 2, pr: { ...pr12, mergeable_state: "dirty" } }, { token: "t" });
    assert.deepEqual([seen.effective, seen.already], [0, false]);
    assert.equal(staleDecision({ pr: { ...pr12, mergeable_state: "dirty" }, rebaseMarkers: seen.effective, queue: true }), "rebase");
    const notice = rebaseNotice(2, { ...pr12, mergeable_state: "dirty" });
    assert.match(notice, /conflicts with `main` after a sibling merged; sending it back to the worker once/);
    assert.ok(notice.startsWith(marker(2, "rebase", two)));
    await gh.fetch("https://api.github.com/repos/o/r/issues/12/comments", { method: "POST", body: JSON.stringify({ body: notice }) });
    seen = await rebaseMarkers(repo, { issue: 2, pr: pr12 }, { token: "t" });
    assert.deepEqual([seen.effective, seen.already], [0, true], "the same head again: no second notice, still the one rebase");

    // The worker rebases keeping both functions, and the review records the new head: it merges with no person.
    const rebased = g.commit("factory/2", "main", "export const version = 1;\nexport function saveOne() {}\nexport function saveTwo() {}\n", "two, rebased");
    pr12.head.sha = rebased;
    await recordMergeable(repo, 12, 2, rebased, { token: "t" });
    assert.equal(await merge(2, 12), "queued");
    assert.deepEqual(gh.enqueued.at(-1), { pr: 12, sha: rebased });

    // A third sibling lands on the same lines first: a second conflict after the one rebase Blocks, as today.
    const three = g.commit("factory/3", one, "export const version = 1;\nexport function saveOne() {}\nexport function saveThree() {}\n", "three");
    g.git("update-ref", "refs/heads/main", three);
    assert.equal(await merge(2, 12), "conflict");
    assert.deepEqual(gh.attempts, [11, 12], "the second conflict is read before any enqueue too");
    seen = await rebaseMarkers(repo, { issue: 2, pr: pr12 }, { token: "t" });
    assert.equal(seen.effective, 1);
    assert.equal(staleDecision({ pr: { ...pr12, mergeable_state: "dirty" }, rebaseMarkers: seen.effective, queue: true }), "blocked");
    assert.match(REBASED_TWICE, /^integration failed twice/);
  });
});

test("#2647: a conflict GitHub had not worked out when the PR was read is read again after its refusal: conflict, not a thrown error", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const one = g.commit("factory/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("factory/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    g.git("update-ref", "refs/heads/main", one);
    const pr = gh.open(12, 2, two);
    pr.unknownOnce = true;
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    assert.equal(await merge(2, 12), "conflict");
    assert.equal(gh.enqueued.length, 0);
  });
});

test("#2647: a merge refusal on a PR that does not conflict is still thrown (the review stage decides on it)", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const two = g.commit("factory/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => (/\/graphql$/.test(String(url)) && JSON.parse(init.body).query.includes("enqueuePullRequest") ? new Response(JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }), { status: 200 }) : real(url, init));
    await assert.rejects(merge(2, 12), /Resource not accessible/);
  });
});

test("#2669: the dispatcher's merge pass queues or merges the PR just before the review stage's own call: success, not a refusal", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("factory/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    // The review stage reads the PR out of the queue; the dispatcher's tick enqueues it before the review's enqueue lands.
    gh.state.race = async () => {
      assert.equal(await merge(2, 12), "queued", "the dispatcher's pass");
      gh.queued.add(12);
    };
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "queued");
    assert.deepEqual(gh.attempts, [12, 12], "both passes called the merge; GitHub refused the second");
    assert.deepEqual(gh.enqueued, [{ pr: 12, sha: two }]);
    assert.equal(report.watch, true, "the queue is watched as for its own enqueue");
    assert.equal(mergeBlockReason("queued", report), null);

    // No merge queue: the dispatcher's pass merges it first and GitHub refuses the review's merge (405).
    const three = g.commit("factory/3", g.main(), "export const version = 1;\nexport function saveThree() {}\n", "three");
    gh.open(13, 3, three);
    await recordMergeable(repo, 13, 3, three, { token: "t" });
    const direct = () => mergeReadyOne(repo, { issue: 3, prNumber: 13, queue: false, checkNames: ["ci"] }, { token: "t" });
    gh.state.race = async () => assert.equal(await direct(), "merged", "the dispatcher's pass");
    assert.equal(await direct(), "merged");
    assert.equal(mergeBlockReason("merged"), null);
  });
});

test("#2669: a refusal while the PR sits in the queue at another head is still thrown", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("factory/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    const pr = gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const pushed = g.commit("factory/2", two, "export const version = 1;\nexport function saveTwo() { return 2; }\n", "two, pushed");
    gh.state.race = async () => {
      pr.head.sha = pushed;
      gh.queued.add(12);
    };
    await assert.rejects(merge(2, 12), /already in the queue/);
  });
});

test("#2669: a refusal whose read-again fails for now throws that read's transient error (the review job's next tick), not the refusal", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("factory/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    gh.state.race = async () => gh.queued.add(12);
    // After the refusal, GitHub fails the queue read (502), then the PR read (503).
    let fail = /isInMergeQueue/;
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const what = /\/graphql$/.test(String(url)) ? JSON.parse(init.body).query : `${init.method || "GET"} ${url}`;
      if (gh.attempts.length && fail.test(what)) return new Response(JSON.stringify({ message: "Server Error" }), { status: fail.source === "isInMergeQueue" ? 502 : 503 });
      return real(url, init);
    };
    let thrown = await merge(2, 12).catch((e) => e);
    assert.deepEqual([thrown.status, transientError(thrown)], [502, true], String(thrown.message));

    gh.attempts.length = 0;
    gh.queued.delete(12);
    gh.state.race = async () => gh.queued.add(12);
    fail = /GET .*\/pulls\/12$/;
    thrown = await merge(2, 12).catch((e) => e);
    assert.deepEqual([thrown.status, transientError(thrown)], [503, true], String(thrown.message));
  });
});

test("#2647: local --wait sends a conflicting PR back once (notice, worker rebase, review again), then Blocks", async () => {
  const pr = { number: 12, state: "open", head: { sha: "a".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" };
  const posted = [];
  const exits = [];
  const ran = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo, opts: { token: "t" }, work: async (issue, o) => (ran.push([issue, o]), { exit: "delivered" }) });
  const gh = (effective, already) => ({ getPrSettled: async () => pr, rebaseMarkers: async () => ({ effective, already }), prComment: async (_r, n, body) => posted.push([n, body]), applyExit: async (_r, x) => exits.push(x) });
  const inputs = { objectiveLabel: "factory:objective", notify: "" };

  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(0, false) }), true);
  assert.deepEqual(ran, [[2, { wait: true }]], "the worker rebases and the review runs again, waiting for the merge");
  assert.equal(posted.length, 1);
  assert.ok(posted[0][1].startsWith(marker(2, "rebase", pr.head.sha)));
  assert.deepEqual(exits, []);

  // The same head (the last send-back produced no push): no second notice, the worker runs again.
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(0, true) }), true);
  assert.equal(posted.length, 1);
  assert.equal(ran.length, 2);

  // A conflict after the one rebase: Blocked, no third worker run.
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(1, false) }), false);
  assert.equal(ran.length, 2);
  assert.deepEqual(exits.map((x) => [x.exit, x.reason]), [["blocked", REBASED_TWICE]]);
  assert.equal(exits[0].key, rebasedTwiceBlock({ issue: 2, pr }).key, "the Block the dispatcher would write too, one comment");
});

/** A Local loop whose GitHub calls are `gh` (sendBack's seam) and whose worker run answers `workAnswers` in turn. */
function sendBackLoop(workAnswers) {
  const ran = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo, opts: { token: "t" }, work: async (issue, o) => (ran.push([issue, o]), workAnswers.shift() || { exit: "delivered" }) });
  return { loop, ran };
}
const dirtyPr = (over = {}) => ({ number: 12, state: "open", head: { sha: "a".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty", ...over });
const failing = (status) => Object.assign(new Error(`GitHub said ${status}`), { status });
const inputs = { objectiveLabel: "factory:objective", notify: "" };

test("#2647: --wait follows a merge-time conflict into the send-back, and polls again when the send-back says retry", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const one = g.commit("factory/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("factory/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    g.git("update-ref", "refs/heads/main", one);
    gh.open(12, 2, two);
    const answers = ["retry", true];
    const sent = [];
    const loop = Object.assign(Object.create(Local.prototype), { repo, repoFull: "o/r", opts: { token: "t" }, baseEnv: () => ({}), sendBack: async (issue, prNumber) => (sent.push([issue, prNumber]), answers.shift()) });
    assert.equal(await loop.followMerge(2, 12, { timeoutMs: 5_000, pollMs: 1 }), true);
    assert.deepEqual(sent, [[2, 12], [2, 12]], "a conflict goes to the send-back; its retry is read again on the next poll");
    assert.deepEqual(gh.attempts, [], "nothing is enqueued");
  });
});

test("#2647: a send-back whose GitHub read or comment fails never throws: a transient error retries, any other Blocks with its reason", async () => {
  const exits = [];
  const posted = [];
  const base = { rebaseMarkers: async () => ({ effective: 0, already: false, since: null }), prComment: async (_r, n, b) => posted.push([n, b]), applyExit: async (_r, x) => exits.push(x) };

  // GitHub 502 reading the PR: no worker run, no Block, followMerge polls again.
  let { loop, ran } = sendBackLoop([]);
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: { ...base, getPrSettled: async () => { throw failing(502); } } }), "retry");
  assert.deepEqual([ran.length, exits.length], [0, 0]);

  // A refused notice (403): Blocked with the reason, no worker run.
  ({ loop, ran } = sendBackLoop([]));
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: { ...base, getPrSettled: async () => dirtyPr(), prComment: async () => { throw failing(403); } } }), false);
  assert.equal(ran.length, 0);
  assert.deepEqual(exits.map((x) => [x.exit, x.stage]), [["blocked", "merge"]]);
  assert.match(exits[0].reason, /send-back .* failed \(HTTP 403\)/);

  // The REBASED_TWICE Block itself hitting a 503: retried on the next poll, never thrown.
  ({ loop, ran } = sendBackLoop([]));
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: { ...base, getPrSettled: async () => dirtyPr(), rebaseMarkers: async () => ({ effective: 1, already: false }), applyExit: async () => { throw failing(503); } } }), "retry");

  // Even the Block for a non-transient failure failing leaves sendBack returning, not throwing.
  ({ loop, ran } = sendBackLoop([]));
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: { ...base, getPrSettled: async () => { throw failing(404); }, applyExit: async () => { throw failing(500); } } }), false);
  assert.equal(posted.length, 0);
});

test("#2647: after the one rebase, a worker that delivers unlabelled with the PR still conflicting Blocks under --wait", async () => {
  const exits = [];
  const reads = [dirtyPr(), dirtyPr({ head: { sha: "b".repeat(40) } })];
  const gh = { getPrSettled: async () => reads.shift(), rebaseMarkers: async () => ({ effective: 0, already: false, since: "2026-11-09T00:00:00Z" }), prComment: async () => {}, applyExit: async (_r, x) => exits.push(x) };
  const { loop, ran } = sendBackLoop([{ exit: "delivered", unreviewed: true }]);
  assert.equal(await loop.sendBack(2, 12, inputs, { gh }), false, "not a clean exit with a dirty PR");
  assert.equal(ran.length, 1);
  assert.deepEqual(exits.map((x) => [x.exit, x.reason, x.stage]), [["blocked", REBASED_TWICE, "merge"]]);
  assert.equal(exits[0].pr.head.sha, "b".repeat(40), "the Block names the rebased head it read");

  // The same worker answer with the conflict gone by the re-read: no Block, the merge pass reads it again.
  const clean = [dirtyPr(), dirtyPr({ mergeable_state: "clean" })];
  const exits2 = [];
  const { loop: loop2 } = sendBackLoop([{ exit: "delivered", unreviewed: true }]);
  assert.equal(await loop2.sendBack(2, 12, inputs, { gh: { ...gh, getPrSettled: async () => clean.shift(), applyExit: async (_r, x) => exits2.push(x) } }), "retry");
  assert.deepEqual(exits2, []);
});

test("#2647: a PR that stopped conflicting before the send-back read it is neither Blocked nor sent to a worker", async () => {
  const exits = [];
  const posted = [];
  for (const now of [dirtyPr({ mergeable_state: "clean" }), dirtyPr({ state: "closed" }), dirtyPr({ merged: true, state: "closed" })]) {
    const { loop, ran } = sendBackLoop([]);
    const gh = { getPrSettled: async () => now, rebaseMarkers: async () => ({ effective: 1, already: false }), prComment: async (_r, n, b) => posted.push([n, b]), applyExit: async (_r, x) => exits.push(x) };
    assert.equal(await loop.sendBack(2, 12, inputs, { gh }), "retry");
    assert.equal(ran.length, 0);
  }
  assert.deepEqual([exits.length, posted.length], [0, 0]);
});

test("#2647: the dispatcher and a --wait loop Blocking the same second conflict write one Blocked comment", async () => {
  await withGitHub(async (g, gh) => {
    const pr = gh.open(12, 2, g.main());
    const since = "2026-11-09T00:00:00Z";
    await applyExit(repo, rebasedTwiceBlock({ issue: 2, pr, since, notify: "kirk", stage: "dispatch" }), { token: "t" });
    await applyExit(repo, rebasedTwiceBlock({ issue: 2, pr, since, notify: "kirk", stage: "merge" }), { token: "t" });
    const blocked = (gh.comments[2] || []).filter((c) => c.body.startsWith(marker(2, "blocked").replace(/ -->$/, "")));
    assert.equal(blocked.length, 1, "one comment, one @mention");
    // A new head (or a human recovery) is a new condition: it notifies again.
    await applyExit(repo, rebasedTwiceBlock({ issue: 2, pr: { ...pr, head: { sha: "c".repeat(40) } }, since, notify: "kirk", stage: "merge" }), { token: "t" });
    assert.equal((gh.comments[2] || []).filter((c) => c.body.startsWith(marker(2, "blocked").replace(/ -->$/, ""))).length, 2);
  });
});

test("#205: an Objective edited since its plan does not merge; with its plan's text it does", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("factory/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    // The plan comment Factory wrote, recording the text it was made from; the issue's text as GitHub returns it now.
    const issue = { title: "Objective", body: "Save two." };
    (gh.comments[2] ||= []).push({ id: 900, user: { login: SELF }, body: `${marker(2, "plan")}${planTextMarker({ sha256: objectiveSha("Objective", "Save two."), label: null })}\n## Plan`, created_at: new Date().toISOString() });
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => (/\/graphql$/.test(String(url)) && /issue\(number/.test(JSON.parse(init.body).query) ? new Response(JSON.stringify({ data: { repository: { issue } } }), { status: 200 }) : real(url, init));
    issue.body = "Save two, and three.";
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "edited");
    assert.deepEqual([gh.enqueued, gh.attempts], [[], []], "nothing is enqueued");
    assert.equal(mergeBlockReason("edited", report), EDITED_REASON);
    issue.body = "Save two.";
    assert.equal(await merge(2, 12), "queued", "the plan's own text merges as before");
  });
});

test("#205: an Objective edited while its PR waits in the merge queue is taken out of it and does not merge", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("factory/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const issue = { title: "Objective", body: "Save two." };
    (gh.comments[2] ||= []).push({ id: 900, user: { login: SELF }, body: `${marker(2, "plan")}${planTextMarker({ sha256: objectiveSha("Objective", "Save two."), label: null })}\n## Plan`, created_at: new Date().toISOString() });
    const dequeued = [];
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const q = /\/graphql$/.test(String(url)) ? JSON.parse(init.body) : null;
      if (q && /issue\(number/.test(q.query)) return new Response(JSON.stringify({ data: { repository: { issue } } }), { status: 200 });
      if (q && q.query.includes("dequeuePullRequest")) {
        dequeued.push(q.variables);
        gh.queued.delete(12);
        return new Response(JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: { id: "e" } } } }), { status: 200 });
      }
      return real(url, init);
    };
    assert.equal(await merge(2, 12), "queued");
    gh.queued.add(12);
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "in-queue", "the plan's own text waits in the queue");
    issue.body = "Save two, and three.";
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report: {} }, { token: "t" }), "edited");
    assert.equal(dequeued.length, 1, "taken out of the queue");
    assert.equal(mergeBlockReason("edited"), EDITED_REASON);
  });
});
