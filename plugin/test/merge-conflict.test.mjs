import "./temp.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExit, mergeBlockCause, mergeBlockReason, mergeReadyOne, rebaseBlock, rebaseMarkers, rebaseNotice, recordMergeable } from "../scripts/lib/session.mjs";
import { REBASE_LIMIT, marker, ontoRecord, setSelf, staleDecision } from "../scripts/lib/logic.mjs";
import { Local } from "../scripts/local.mjs";
import { RETRY, transientError } from "../scripts/lib/github.mjs";
import { planTextMarker } from "../scripts/lib/handoff.mjs";
import { EDITED_REASON, objectiveSha, recordText } from "../scripts/lib/objective-trust.mjs";
import { openEditCheck } from "../scripts/lib/edit-check.mjs";
import { logTo } from "../scripts/lib/inputs.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

// #2647: two sibling Objectives add a function to one module. The first merges; the second, reviewed and green, then
// conflicts at its merge. It goes back for a rebase (no Block) and merges after it; a third sibling's conflict sends it back again.

const SELF = "pendulum-app[bot]";
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
  // o/r on the test's git server (temp.mjs GITHUB_SERVER_URL), where Pendulum's trial merges fetch from: `publish()`
  // pushes every branch there as it is now.
  const origin = join(process.env.GITHUB_SERVER_URL, "o", "r.git");
  const publish = () => {
    rmSync(origin, { recursive: true, force: true });
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
    git("push", "-q", origin, "refs/heads/*:refs/heads/*");
  };
  return { dir, git, commit, conflicts, publish, main: () => git("rev-parse", "main") };
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
  // `removals`: the queue's removals of the PR (its timeline); `waiting`: the PRs in the queue; `entries`: the queue's
  // entries as `{pr, head}` (mergeQueueHeads); `mainAt`: main's commit time.
  // `threads`: the PR's review threads (GraphQL's shape); `protection`: branch protection requires resolved conversations;
  // `rules`: the active rules GitHub lists for main; `labelled`: labels added; `resolved`: threads Pendulum resolved.
  // `checkRuns`: the check runs on any head; `queueTimeout`: the merge queue ruleset's check timeout (minutes), with which
  // the repository and its rulesets are read (0: a ruleset with no merge queue), else they are unread. `entry`: a queued
  // PR's merge queue entry (GraphQL's shape), else none is read; `entryFails`: the entry read fails.
  const state = { checkRuns: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }], queueTimeout: null, entry: null, entryFails: false, race: null, removals: [], entries: [], waiting: null, mainAt: "2026-01-01T00:00:00Z", threads: [], protection: false, rules: [], labelled: [], resolved: [], timeline: [], refuseOnce: false, permissions: { dana: "write" } };
  // GitHub's own rule: an unresolved conversation refuses the merge when protection or a ruleset requires them resolved.
  const conversationsHeld = () => state.threads.some((t) => !t.isResolved) && (state.protection || state.rules.some((r) => r.type === "pull_request" && r.parameters?.required_review_thread_resolution));
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
    // The Objective's issue, open and labelled: the merge pass reads it before any merge (session.mjs mergeReadyOne).
    if (method === "GET" && /\/issues\/\d+$/.test(u.split("?")[0])) return json(200, { number: Number(/(\d+)$/.exec(u.split("?")[0])[1]), state: "open", labels: [{ name: "pendulum:objective" }] });
    if (/\/graphql$/.test(u)) {
      const q = body.query;
      if (q.includes("isInMergeQueue")) return json(200, { data: { repository: { pullRequest: { isInMergeQueue: queued.has(body.variables.n) } } } });
      if (q.includes("mergeQueueEntry { state")) {
        if (state.entryFails) return json(502, { message: "Server Error" });
        return json(200, { data: { repository: { pullRequest: { mergeQueueEntry: queued.has(body.variables.n) ? state.entry : null } } } });
      }
      if (q.includes("timelineItems")) return json(200, { data: { repository: { pullRequest: { timelineItems: { nodes: state.removals.map((r) => ({ createdAt: r.at, reason: r.reason, actor: { login: "github-merge-queue", __typename: "Bot" } })) } } } } });
      if (q.includes("entries(first")) return json(200, { data: { repository: { ref: { target: { oid: g.main() } }, mergeQueue: { entries: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.entries.map((e, i) => ({ position: i + 1, pullRequest: { number: e.pr }, headCommit: { oid: e.head } })) } } } } });
      if (q.includes("mergeQueue(branch")) return json(200, { data: { repository: { ref: { target: { oid: g.main(), committedDate: state.mainAt } }, mergeQueue: { entries: { totalCount: state.waiting ?? queued.size } } } } });
      if (q.includes("resolveReviewThread")) {
        state.threads.find((t) => t.id === body.variables.id).isResolved = true;
        state.resolved.push(body.variables.id);
        return json(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }
      if (q.includes("reviewThreads")) return json(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads } } } } });
      if (q.includes("refUpdateRule")) return json(200, { data: { repository: { ref: { refUpdateRule: state.protection ? { requiresConversationResolution: true } : null } } } });
      if (q.includes("enqueuePullRequest")) {
        const pr = Object.values(prs).find((p) => p.node_id === body.variables.id);
        attempts.push(pr.number);
        await runRace();
        if (conversationsHeld()) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request is not mergeable: review conversations must be resolved" }] });
        // GitHub's merge check still counting a conversation resolved a moment ago.
        if (state.refuseOnce) {
          state.refuseOnce = false;
          return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request is not mergeable: review conversations must be resolved" }] });
        }
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
      if (conversationsHeld()) return json(405, { message: "Review conversations must be resolved" });
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
    if (method === "POST" && (m = /\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(u))) {
      state.labelled.push(...body.labels.map((name) => `${m[1]}:${name}`));
      return json(200, body.labels.map((name) => ({ name })));
    }
    if (method === "GET" && /\/repos\/o\/r\/rules\/branches\/main/.test(u)) return json(200, state.rules);
    if (method === "DELETE" && /\/repos\/o\/r\/issues\/\d+\/labels\//.test(u)) return json(404, { message: "Label does not exist" });
    if (method === "GET" && /\/check-runs/.test(u)) return json(200, { total_count: state.checkRuns.length, check_runs: state.checkRuns });
    const rulesRead = state.queueTimeout !== null && method === "GET";
    if (rulesRead && /\/repos\/o\/r$/.test(u)) return json(200, { full_name: "o/r", default_branch: "main" });
    if (rulesRead && /\/repos\/o\/r\/rulesets\?/.test(u)) return json(200, [{ id: 1, target: "branch", enforcement: "active" }]);
    if (rulesRead && /\/repos\/o\/r\/rulesets\/1$/.test(u)) return json(200, { id: 1, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: state.queueTimeout ? [{ type: "merge_queue", parameters: { check_response_timeout_minutes: state.queueTimeout } }] : [] });
    if (method === "GET" && /\/commits\/[0-9a-f]+\/status$/.test(u)) return json(200, { statuses: [] });
    if (method === "GET" && (m = /\/repos\/o\/r\/commits\/([0-9a-f]+)$/.exec(u))) return json(200, { sha: m[1], parents: [], commit: { committer: { date: "2026-01-01T00:00:00Z" } } });
    if (method === "GET" && /\/timeline/.test(u)) return json(200, state.timeline);
    // Each login's permission (`permissions`): dana, the maintainer who answers in threads, can write.
    if (method === "GET" && (m = /\/repos\/o\/r\/collaborators\/([^/]+)\/permission$/.exec(u)) && state.permissions[m[1]]) return json(200, { permission: state.permissions[m[1]] });
    return json(404, { message: `Not Found: ${method} ${u}` });
  };
  const open = (number, issue, sha) => {
    prs[number] = { number, state: "open", draft: false, merged: false, node_id: `PR_${number}`, title: `Objective ${issue}`, labels: [], head: { sha, ref: `pendulum/${issue}` }, base: { ref: "main" }, reviews: [{ id: number, user: { login: SELF }, body: `${marker(issue, "review")}\nPendulum reviewer`, submitted_at: new Date().toISOString() }] };
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

test("#2647: two sibling PRs on one file: the second conflicts at its merge, goes back for a rebase, merges; a third sibling's conflict sends it back again", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const one = g.commit("pendulum/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("pendulum/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
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

    // The send-back (dispatch.mjs): a rebase, with its notice on the PR naming the head it saw.
    let seen = await rebaseMarkers(repo, { issue: 2, pr: { ...pr12, mergeable_state: "dirty" } }, { token: "t" });
    assert.deepEqual([seen.effective, seen.already], [0, false]);
    assert.equal(staleDecision({ pr: { ...pr12, mergeable_state: "dirty" }, rebases: seen.recent, stuck: seen.stuck, queue: true }), "rebase");
    const notice = rebaseNotice(2, { ...pr12, mergeable_state: "dirty" });
    assert.match(notice, /conflicts with `main` after other PRs merged; sending it back to the worker to rebase/);
    assert.ok(notice.startsWith(marker(2, "rebase", two)));
    await gh.fetch("https://api.github.com/repos/o/r/issues/12/comments", { method: "POST", body: JSON.stringify({ body: notice }) });
    seen = await rebaseMarkers(repo, { issue: 2, pr: pr12 }, { token: "t" });
    assert.deepEqual([seen.effective, seen.already], [0, true], "the same head again: no second notice, no rebase counted");
    // The worker's rebase onto main conflicts in store.mjs: its record.
    await gh.fetch("https://api.github.com/repos/o/r/issues/12/comments", { method: "POST", body: JSON.stringify({ body: ontoRecord(2, { from: two, base: one, files: ["store.mjs"] }) }) });

    // The worker rebases keeping both functions, and the review records the new head: it merges with no person.
    const rebased = g.commit("pendulum/2", "main", "export const version = 1;\nexport function saveOne() {}\nexport function saveTwo() {}\n", "two, rebased");
    pr12.head.sha = rebased;
    await recordMergeable(repo, 12, 2, rebased, { token: "t" });
    assert.equal(await merge(2, 12), "queued");
    assert.deepEqual(gh.enqueued.at(-1), { pr: 12, sha: rebased });

    // A third sibling lands on the same lines first: a new base, so it goes back again rather than Blocking.
    const three = g.commit("pendulum/3", one, "export const version = 1;\nexport function saveOne() {}\nexport function saveThree() {}\n", "three");
    g.git("update-ref", "refs/heads/main", three);
    assert.equal(await merge(2, 12), "conflict");
    assert.deepEqual(gh.attempts, [11, 12], "the second conflict is read before any enqueue too");
    seen = await rebaseMarkers(repo, { issue: 2, pr: { ...pr12, mergeable_state: "dirty" } }, { token: "t" });
    assert.deepEqual([seen.effective, seen.recent, seen.stuck, seen.record?.base], [1, 1, null, one], "the last rebase was onto the first sibling's main");
    assert.equal(staleDecision({ pr: { ...pr12, mergeable_state: "dirty" }, rebases: seen.recent, stuck: seen.stuck, queue: true }), "rebase");
  });
});

test("#243: a PR the merge queue took out for a conflict waits while a PR in the queue conflicts with it by a trial merge, then goes back in; such removals count toward no drop Block", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    // Two siblings write the same line of store.mjs: each merges into main cleanly, but not both.
    const one = g.commit("pendulum/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("pendulum/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    // A third changes another file only.
    g.git("checkout", "-q", "-B", "pendulum/3", base);
    writeFileSync(join(g.dir, "other.mjs"), "export const other = 3;\n");
    g.git("add", "other.mjs");
    g.git("commit", "-q", "-m", "three");
    const three = g.git("rev-parse", "HEAD");
    g.publish();
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const later = (s) => new Date(Date.now() + s * 1000).toISOString();
    // Dropped twice for a conflict with the sibling ahead of it, which still waits in the queue.
    gh.state.removals = [{ at: later(1), reason: "merge_conflict" }, { at: later(2), reason: "merge_conflict" }];
    gh.state.entries = [{ pr: 11, head: one }];
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "queue-wait", "no Block, no enqueue that would bounce off the same entry");
    assert.equal(mergeBlockReason("queue-wait", report), null);
    assert.deepEqual(gh.attempts, []);
    // Main's head and its commit time say nothing: only the queue's own PRs, merged on trial with this one, decide.
    gh.state.mainAt = later(60);
    assert.equal(await merge(2, 12), "queue-wait");
    // The conflicting sibling left the queue; the one there now touches another file: it goes back in at once, with main
    // unmoved and no time passed.
    gh.state.entries = [{ pr: 13, head: three }];
    assert.equal(await merge(2, 12), "queued");
    assert.deepEqual(gh.enqueued, [{ pr: 12, sha: two }]);
    // Dropped again for a conflict with an empty queue now: back in.
    gh.queued.clear();
    gh.state.removals.push({ at: later(3), reason: "merge_conflict" });
    gh.state.entries = [];
    assert.equal(await merge(2, 12), "queued");
    // Two drops for failed checks still Block, as before, once the review stage read the newest as no failure of the
    // PR's own (#312: a red queue run goes to the review stage first).
    gh.queued.clear();
    gh.state.removals = [{ at: later(4), reason: "failed_checks" }, { at: later(5), reason: "failed_checks" }];
    assert.equal(await merge(2, 12), "queue-red");
    const { writeQueueRed } = await import("../scripts/lib/session.mjs");
    await writeQueueRed(repo, 2, 12, { at: gh.state.removals[1].at, state: "requeued", kind: "flaky" }, { token: "t" });
    assert.equal(await merge(2, 12), "dropped");
  });
});

test("#243: a queue-conflict wait whose queue cannot be read holds this tick; one whose trial merge cannot be computed goes back in once per queue state, never again on the same queue", async () => {
  const { queueConflictWait, queueConflictRecord } = await import("../scripts/lib/session.mjs");
  await withGitHub(async (g, gh) => {
    g.publish();
    const t0 = Date.now();
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => (/\/graphql$/.test(String(url)) && String(init.body).includes("entries(first") ? new Response(JSON.stringify({ message: "Server Error" }), { status: 502 }) : real(url, init));
    assert.equal(await queueConflictWait(repo, { issue: 2, prNumber: 12, head: g.main(), base: "main", removal: at(1) }, { token: "t" }), "pending");
    globalThis.fetch = real;
    // A queue head no trial can read: back in, and the queue's state then recorded on the issue.
    gh.state.entries = [{ pr: 11, head: "0".repeat(40) }];
    assert.equal(await queueConflictWait(repo, { issue: 2, prNumber: 12, head: g.main(), base: "main", removal: at(1) }, { token: "t" }), null);
    const rec = queueConflictRecord(gh.comments[2], 2);
    assert.deepEqual([rec.pr, rec.removal], [12, at(1)]);
    // The queue (its merge group, which pairwise trials cannot see) takes it out again, and nothing in the queue moved:
    // it waits rather than bouncing off the same queue at event speed.
    assert.equal(await queueConflictWait(repo, { issue: 2, prNumber: 12, head: g.main(), base: "main", removal: at(2) }, { token: "t" }), "queue-wait");
    assert.equal(await queueConflictWait(repo, { issue: 2, prNumber: 12, head: g.main(), base: "main", removal: at(2) }, { token: "t" }), "queue-wait", "however often the dispatcher ticks");
    // The queue changed (another PR joined): one more go.
    gh.state.entries = [{ pr: 11, head: "0".repeat(40) }, { pr: 14, head: "1".repeat(40) }];
    assert.equal(await queueConflictWait(repo, { issue: 2, prNumber: 12, head: g.main(), base: "main", removal: at(2) }, { token: "t" }), null);
    assert.equal(queueConflictRecord(gh.comments[2], 2).removal, at(2));
  });
});

test("#2647: a conflict GitHub had not worked out when the PR was read is read again after its refusal: conflict, not a thrown error", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const one = g.commit("pendulum/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("pendulum/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
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
    const two = g.commit("pendulum/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => (/\/graphql$/.test(String(url)) && JSON.parse(init.body).query.includes("enqueuePullRequest") ? new Response(JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }), { status: 200 }) : real(url, init));
    await assert.rejects(merge(2, 12), /Resource not accessible/);
  });
});

test("#2669: the dispatcher's merge pass queues or merges the PR just before the review stage's own call: success, not a refusal", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
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
    const three = g.commit("pendulum/3", g.main(), "export const version = 1;\nexport function saveThree() {}\n", "three");
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
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    const pr = gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const pushed = g.commit("pendulum/2", two, "export const version = 1;\nexport function saveTwo() { return 2; }\n", "two, pushed");
    gh.state.race = async () => {
      pr.head.sha = pushed;
      gh.queued.add(12);
    };
    await assert.rejects(merge(2, 12), /already in the queue/);
  });
});

test("#2669: a refusal whose read-again fails for now throws that read's transient error (the review job's next tick), not the refusal", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
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

test("#243: local --wait sends a conflicting PR back each time other PRs merged; Blocks when the conflict comes back on the same base or at the bound", async () => {
  const pr = { number: 12, state: "open", head: { sha: "a".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" };
  const posted = [];
  const exits = [];
  const ran = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo, opts: { token: "t" }, work: async (issue, o) => (ran.push([issue, o]), { exit: "delivered" }) });
  const gh = (recent, already, stuck = null) => ({ getPrSettled: async () => pr, rebaseMarkers: async () => ({ effective: recent, recent, already, stuck, record: stuck }), prComment: async (_r, n, body) => posted.push([n, body]), applyExit: async (_r, x) => exits.push(x) });
  const inputs = { objectiveLabel: "pendulum:objective", notify: "" };

  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(0, false) }), true);
  assert.deepEqual(ran, [[2, { wait: true }]], "the worker rebases and the review runs again, waiting for the merge");
  assert.equal(posted.length, 1);
  assert.ok(posted[0][1].startsWith(marker(2, "rebase", pr.head.sha)));
  assert.deepEqual(exits, []);

  // The same head (the last send-back produced no push): no second notice, the worker runs again.
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(0, true) }), true);
  assert.equal(posted.length, 1);
  assert.equal(ran.length, 2);

  // A conflict after a rebase, on a new base: sent back again.
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(1, false) }), true);
  assert.deepEqual([ran.length, posted.length, exits.length], [3, 2, 0]);

  // The same conflict on the same base: Blocked naming the files, no worker run.
  const stuck = { from: "9".repeat(40), base: "b".repeat(40), files: ["docs/decisions.md"] };
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(1, false, stuck) }), false);
  assert.equal(ran.length, 3);
  assert.match(exits[0].reason, /no progress: the branch still conflicts with `main` at bbbbbbb.*`docs\/decisions\.md`/);
  assert.equal(exits[0].cause, "work");
  assert.equal(exits[0].key, rebaseBlock({ issue: 2, pr, why: "stuck" }).key, "the Block the dispatcher would write too, one comment");

  // The bound: Blocked, no worker run.
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(REBASE_LIMIT, false) }), false);
  assert.equal(ran.length, 3);
  assert.match(exits[1].reason, new RegExp(`rebased ${REBASE_LIMIT} times in 24 h`));
});

test("#402: local --wait sends back and Blocks at the repository's rebase_limit", async () => {
  const pr = { number: 12, state: "open", head: { sha: "a".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" };
  const posted = [];
  const exits = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo, opts: { token: "t" }, work: async () => ({ exit: "delivered" }) });
  const gh = (recent) => ({ getPrSettled: async () => pr, rebaseMarkers: async () => ({ effective: recent, recent, already: false, stuck: null, record: null }), prComment: async (_r, n, body) => posted.push(body), applyExit: async (_r, x) => exits.push(x) });
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const inputs = { ...resolveInputs({ env: { PENDULUM_REBASE_LIMIT: "2" } }), objectiveLabel: "pendulum:objective", notify: "" };
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(1) }), true);
  assert.match(posted[0], /rebase 2 of at most 2 in 24 h/);
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: gh(2) }), false);
  assert.match(exits[0].reason, /rebased 2 times in 24 h/);
});

/** A Local loop whose GitHub calls are `gh` (sendBack's seam) and whose worker run answers `workAnswers` in turn. */
function sendBackLoop(workAnswers) {
  const ran = [];
  const loop = Object.assign(Object.create(Local.prototype), { repo, opts: { token: "t" }, work: async (issue, o) => (ran.push([issue, o]), workAnswers.shift() || { exit: "delivered" }) });
  return { loop, ran };
}
const dirtyPr = (over = {}) => ({ number: 12, state: "open", head: { sha: "a".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty", ...over });
const failing = (status) => Object.assign(new Error(`GitHub said ${status}`), { status });
const inputs = { objectiveLabel: "pendulum:objective", notify: "" };

test("#2647: --wait follows a merge-time conflict into the send-back, and polls again when the send-back says retry", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    const one = g.commit("pendulum/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const two = g.commit("pendulum/2", base, "export const version = 1;\nexport function saveTwo() {}\n", "two");
    g.git("update-ref", "refs/heads/main", one);
    gh.open(12, 2, two);
    const answers = ["retry", true];
    const sent = [];
    const loop = Object.assign(Object.create(Local.prototype), { repo, repoFull: "o/r", opts: { token: "t" }, baseEnv: () => ({}), sendBack: async (issue, prNumber) => (sent.push([issue, prNumber]), answers.shift()) });
    assert.equal(await loop.followMerge(2, 12, { pollMs: 1 }), true);
    assert.deepEqual(sent, [[2, 12], [2, 12]], "a conflict goes to the send-back; its retry is read again on the next poll");
    assert.deepEqual(gh.attempts, [], "nothing is enqueued");
  });
});

test("#2647: a send-back whose GitHub read or comment fails never throws: a transient error retries, any other Blocks with its reason", async () => {
  const exits = [];
  const posted = [];
  const base = { rebaseMarkers: async () => ({ effective: 0, recent: 0, already: false, since: null }), prComment: async (_r, n, b) => posted.push([n, b]), applyExit: async (_r, x) => exits.push(x) };

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

  // The bound's Block itself hitting a 503: retried on the next poll, never thrown.
  ({ loop, ran } = sendBackLoop([]));
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: { ...base, getPrSettled: async () => dirtyPr(), rebaseMarkers: async () => ({ effective: REBASE_LIMIT, recent: REBASE_LIMIT, already: false }), applyExit: async () => { throw failing(503); } } }), "retry");

  // Even the Block for a non-transient failure failing leaves sendBack returning, not throwing.
  ({ loop, ran } = sendBackLoop([]));
  assert.equal(await loop.sendBack(2, 12, inputs, { gh: { ...base, getPrSettled: async () => { throw failing(404); }, applyExit: async () => { throw failing(500); } } }), false);
  assert.equal(posted.length, 0);
});

test("#243: a rebase whose worker delivers unlabelled with the PR conflicting again (another sibling landed) is sent back by the next poll, not Blocked", async () => {
  const exits = [];
  const gh = { getPrSettled: async () => dirtyPr(), rebaseMarkers: async () => ({ effective: 0, recent: 0, already: false, since: "2026-11-09T00:00:00Z" }), prComment: async () => {}, applyExit: async (_r, x) => exits.push(x) };
  const { loop, ran } = sendBackLoop([{ exit: "delivered", unreviewed: true }]);
  assert.equal(await loop.sendBack(2, 12, inputs, { gh }), "retry", "followMerge's next poll decides under the same rules");
  assert.equal(ran.length, 1);
  assert.deepEqual(exits, []);
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

test("#243: the dispatcher and a --wait loop Blocking the same send-back condition write one Blocked comment", async () => {
  await withGitHub(async (g, gh) => {
    const pr = gh.open(12, 2, g.main());
    const since = "2026-11-09T00:00:00Z";
    await applyExit(repo, rebaseBlock({ issue: 2, pr, why: "limit", since, notify: "kirk", stage: "dispatch" }), { token: "t" });
    await applyExit(repo, rebaseBlock({ issue: 2, pr, why: "limit", since, notify: "kirk", stage: "merge" }), { token: "t" });
    const blocked = (gh.comments[2] || []).filter((c) => c.body.startsWith(marker(2, "blocked").replace(/ -->$/, "")));
    assert.equal(blocked.length, 1, "one comment, one @mention");
    // A new head (or a human recovery) is a new condition: it notifies again.
    await applyExit(repo, rebaseBlock({ issue: 2, pr: { ...pr, head: { sha: "c".repeat(40) } }, why: "limit", since, notify: "kirk", stage: "merge" }), { token: "t" });
    assert.equal((gh.comments[2] || []).filter((c) => c.body.startsWith(marker(2, "blocked").replace(/ -->$/, ""))).length, 2);
  });
});

test("#205: an Objective edited since its plan does not merge; with its plan's text it does", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    // The plan comment Pendulum wrote, recording the text it was made from; the issue's text as GitHub returns it now.
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
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
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

test("#400: an edit since the plan by a writer merges once judged wording only; one no decider here can judge goes to the review stage", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    // The plan comment records the text it was made from; the body since edited by kirk, who can push.
    const kirk = { __typename: "User", login: "kirk", databaseId: 4 };
    const issue = { title: "Objective", body: "Save two, fixed a typo.", lastEditedAt: new Date().toISOString(), author: kirk, editor: kirk, labels: { nodes: [] }, renames: { nodes: [] } };
    (gh.comments[2] ||= []).push({ id: 900, user: { login: SELF }, body: `${marker(2, "plan")}${planTextMarker({ sha256: objectiveSha("Objective", "Save two."), label: null, text: recordText({ title: "Objective", body: "Save two." }) })}\n## Plan`, created_at: new Date().toISOString() });
    const real = gh.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (/\/graphql$/.test(String(url)) && /issue\(number/.test(JSON.parse(init.body).query)) return new Response(JSON.stringify({ data: { repository: { issue } } }), { status: 200 });
      if (/\/collaborators\/kirk\/permission$/.test(String(url))) return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
      return real(url, init);
    };
    // The dispatcher on Actions holds no AI Gateway key: the review label goes back on, and nothing merges.
    const noKey = () => openEditCheck({ inputs: {}, env: { GITHUB_ACTIONS: "true" } });
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], editCheck: noKey }, { token: "t" }), "text-edit");
    assert.deepEqual([gh.state.labelled, gh.enqueued], [["12:pendulum:review"], []]);
    assert.equal(mergeBlockReason("text-edit"), null, "no Block");
    // With decision_route off, as before: Blocked.
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], editCheck: () => openEditCheck({ inputs: { decisionRoute: "off" } }) }, { token: "t" }), "edited");
    // The gateway (or the review stage's own decider) reads it as wording only: it merges, the verdict on the plan comment.
    const asked = [];
    const wording = () => openEditCheck({ decider: { decide: async (input) => (asked.push(input), { verdict: "wording", confidence: 0.9 }) } });
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], editCheck: wording }, { token: "t" }), "queued");
    assert.equal(asked.length, 1);
    assert.match(gh.comments[2].find((c) => c.id === 900).body, /"verdicts":\{"[0-9a-f]{64}":"wording"\}/);
    // Said on the issue: a merge progress comment naming the verdict, the decider and its confidence.
    assert.ok(gh.comments[2].some((c) => c.body.startsWith("<!-- pendulum:2:progress:merge:") && /edit judged wording-only by given \(perplexity\/pplx-decider-v1\.2\) \(0\.90\); plan kept/.test(c.body)), gh.comments[2].map((c) => c.body).join("\n---\n"));
  });
});

// #331: clockgrove/clockgrove#339's merge. Its ruleset requires every review conversation resolved, and code scanning's
// thread (a CodeQL alert) was still open, so the merge failed and the Objective Blocked with the generic merge failure.
const codeql = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "codeql-pr-339.json"), "utf8"));
const RULESET = { type: "pull_request", ruleset_source_type: "Repository", ruleset_id: 1, parameters: { required_review_thread_resolution: true } };
const reply = (body, author = { __typename: "Bot", login: "pendulum-app" }, authorAssociation = "NONE") => ({ body, authorAssociation, author, pullRequestReview: { body: "", authorAssociation, author } });
const personThread = { id: "PRRT_person", isResolved: false, path: "src/store.ts", line: null, originalLine: 41, comments: { nodes: [reply("Why a second store?", { __typename: "User", login: "dana" }, "MEMBER")] } };

test("#331 #368: code scanning's open comment at the merge goes to the answer pass; Pendulum's answer alone leaves it open, and once the finding check resolved its thread the PR merges", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const thread = structuredClone(codeql.thread);
    gh.state.threads = [thread];
    gh.state.rules = [RULESET];
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "code-scanning");
    assert.deepEqual(gh.attempts, [], "no merge GitHub would refuse");
    assert.deepEqual(gh.state.labelled, ["12:pendulum:review"], "the review runs again; its answer pass takes the comment");
    assert.equal(mergeBlockReason("code-scanning", report), null, "not a Block");
    // The answer pass replied in its thread, and the finding check did not read it as resolving the alert: still open.
    thread.comments.nodes.push(reply("<!-- pendulum:2:reply:4580153891 -->\nFixed in abc1234: the key is checked against __proto__."));
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "code-scanning");
    assert.deepEqual(gh.state.resolved, [], "Pendulum's own answer resolves nothing at the merge");
    // The finding check's yes resolved the thread (finding-check.mjs): the merge goes on.
    thread.isResolved = true;
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "queued");
    assert.deepEqual(gh.enqueued, [{ pr: 12, sha: two }]);
  });
});

test("#331: another unresolved thread a ruleset or branch protection requires resolved Blocks naming its author, file and line, never as a merge failure", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    gh.state.threads = [structuredClone(personThread)];
    gh.state.rules = [RULESET];
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "threads");
    assert.deepEqual(gh.attempts, []);
    const why = mergeBlockReason("threads", report);
    assert.equal(why, "PR #12 cannot merge: a ruleset on main requires every review conversation resolved, and 1 is open: dana on src/store.ts:41. Answer or resolve each on the PR, then re-apply `pendulum:objective` to resume");
    assert.equal(mergeBlockCause("threads", report), "work");
    assert.deepEqual(gh.state.labelled, [], "a person's thread is not Pendulum's to answer");

    // Branch protection's own setting, read without admin (refUpdateRule).
    gh.state.rules = [];
    gh.state.protection = true;
    const prot = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: false, checkNames: ["ci"], report: prot }, { token: "t" }), "threads");
    assert.match(mergeBlockReason("threads", prot), /^PR #12 cannot merge: branch protection on main requires every review conversation resolved/);

    // No rule requires it: the open thread holds nothing.
    gh.state.protection = false;
    assert.equal(await merge(2, 12), "queued");
  });
});

test("#331: a thread opened between the read and the merge is named from the threads after GitHub's refusal", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    gh.state.rules = [RULESET];
    gh.state.race = async () => {
      gh.state.threads = [structuredClone(personThread)];
    };
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" }), "threads");
    assert.match(mergeBlockReason("threads", report), /dana on src\/store\.ts:41/);
  });
});

test("#331: local --wait takes code scanning's comment to the review stage, and Blocks on another thread with its name", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    gh.state.threads = [structuredClone(codeql.thread)];
    gh.state.rules = [RULESET];
    const reviewed = [];
    const loop = Object.assign(Object.create(Local.prototype), { repo, repoFull: "o/r", opts: { token: "t" }, baseEnv: () => ({ PENDULUM_CI_CHECKS: "ci" }), review: async (issue, prNumber) => (reviewed.push([issue, prNumber]), { exit: "delivered" }) });
    assert.equal(await loop.followMerge(2, 12, { pollMs: 1 }), true);
    assert.deepEqual(reviewed, [[2, 12]], "the review stage answers it");
    gh.state.threads = [structuredClone(personThread)];
    assert.equal(await loop.followMerge(2, 12, { pollMs: 1 }), false);
    const notice = (gh.comments[2] || []).find((c) => c.body.includes(marker(2, "blocked").replace(/ -->$/, "")));
    assert.match(notice?.body ?? "", /Blocked \(merge\): PR #12 cannot merge: a ruleset on main requires every review conversation resolved, and 1 is open: dana on src\/store\.ts:41/);
    assert.match(notice.body, /"cause":"work"/);
    assert.deepEqual(gh.attempts, [], "nothing is enqueued");
  });
});

test("#575: a review the merge path sends back to (code scanning's comment) that pauses on this machine's network ends the --wait review paused, never delivered, so run exits 75, not 0", async () => {
  const { runExit } = await import("../scripts/local.mjs");
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    gh.state.threads = [structuredClone(codeql.thread)];
    gh.state.rules = [RULESET];
    const paused = { exit: "paused", stage: "review", code: 0, outage: { host: "api.anthropic.test", origin: "https://api.anthropic.test", code: "EAI_AGAIN", since: "2026-11-17T08:47:00.000Z" } };
    const ends = [{ exit: "delivered", stage: "review", code: 0 }, paused];
    const started = [];
    const loop = Object.assign(Object.create(Local.prototype), { repo, repoFull: "o/r", opts: { token: "t" }, baseEnv: () => ({ PENDULUM_CI_CHECKS: "ci" }), stage: async (n, name) => (started.push(name), ends[started.length - 1]) });
    const r = await loop.review(2, 12, { wait: true });
    assert.deepEqual(started, ["review", "review"], "the merge path's review ran and paused");
    assert.equal(r, paused, "the pause is the review's end, for withClaim to keep the claim and run to wait it out");
    assert.equal(runExit(r), 75);
    assert.deepEqual(gh.attempts, [], "nothing is enqueued");
  });
});

test("#331: code scanning's review rounds at the merge are bounded per re-entry, counted in Pendulum's record; past the bound it Blocks naming each open alert", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    gh.state.rules = [RULESET];
    const alert = (id, line) => ({ ...structuredClone(codeql.thread), id, line, originalLine: line });
    const pass = (report = {}) => mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report }, { token: "t" });
    // Each round's fix brings a new alert: two rounds, then a Block, not a third review.
    gh.state.threads = [alert("A1", 239)];
    assert.equal(await pass(), "code-scanning");
    gh.state.threads = [alert("A2", 250)];
    assert.equal(await pass(), "code-scanning");
    gh.state.threads = [alert("A3", 260), alert("A4", 12)];
    const report = {};
    assert.equal(await pass(report), "threads");
    assert.equal(mergeBlockReason("threads", report), "code scanning still has 2 open alert(s) on PR #12 after 2 answer rounds: packages/application/src/wake-triage-cases.ts:260; packages/application/src/wake-triage-cases.ts:12. Fix them on the branch or resolve them on the PR, then re-apply `pendulum:objective` to resume");
    assert.equal(mergeBlockCause("threads", report), "work");
    assert.equal(gh.state.labelled.length, 2, "two rounds, two review labels");
    assert.equal((gh.comments[2] || []).filter((c) => c.body.startsWith(marker(2, "answer-rounds"))).length, 1, "one record on the issue");
    assert.deepEqual(gh.attempts, []);
    // A re-entry (the Objective label applied again) starts the count over.
    gh.state.timeline = [{ event: "labeled", label: { name: "pendulum:objective" }, created_at: new Date(Date.now() + 1000).toISOString() }];
    assert.equal(await pass(), "code-scanning");
  });
});

test("#331: a person's reply in code scanning's thread is no answer: the thread stays open and goes to the answer pass", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const thread = structuredClone(codeql.thread);
    thread.comments.nodes.push(reply("Looking into it.", { __typename: "User", login: "dana" }, "MEMBER"));
    gh.state.threads = [thread];
    assert.equal(await merge(2, 12), "code-scanning");
    assert.deepEqual(gh.state.resolved, [], "never resolved on a person's word");
  });
});

test("#331: threads resolved just now that GitHub's merge check does not count yet: one more try after a moment, not a refusal", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    // Pendulum's reviewer's finding a maintainer answered: a person's answer, resolved at the merge.
    const pendulum = { __typename: "Bot", login: "pendulum-app" };
    const root = { body: "acceptance 1: a second store", authorAssociation: "NONE", author: pendulum, pullRequestReview: { body: `${marker(2, "review")}\nPendulum's review`, authorAssociation: "NONE", author: pendulum } };
    const thread = { id: "PRRT_ours", isResolved: false, path: "src/store.ts", line: 41, originalLine: 41, comments: { nodes: [root, reply("Keep it: decided on the issue.", { __typename: "User", login: "dana" }, "MEMBER")] } };
    gh.state.threads = [thread];
    gh.state.rules = [RULESET];
    gh.state.refuseOnce = true;
    assert.equal(await merge(2, 12), "queued");
    assert.deepEqual(gh.attempts, [12, 12]);
    assert.deepEqual(gh.state.resolved, ["PRRT_ours"]);
  });
});

test("#331: a named reviewer's comment posted after the answer pass Blocks under the rule, saying so; no review runs for it", async () => {
  await withGitHub(async (g, gh) => {
    const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
    gh.open(12, 2, two);
    await recordMergeable(repo, 12, 2, two, { token: "t" });
    const greptile = { __typename: "Bot", login: "greptile-apps" };
    gh.state.threads = [{ id: "PRRT_late", isResolved: false, path: "src/a.ts", line: 3, originalLine: 3, comments: { nodes: [reply("P2: missing check", greptile)] } }];
    gh.state.rules = [RULESET];
    const report = {};
    assert.equal(await mergeReadyOne(repo, { issue: 2, prNumber: 12, queue: true, checkNames: ["ci"], report, thirdParty: ["greptile-apps[bot]"] }, { token: "t" }), "threads");
    assert.equal(mergeBlockReason("threads", report), "PR #12 cannot merge: a ruleset on main requires every review conversation resolved, and 1 is open: greptile-apps[bot] on src/a.ts:3 (posted after the answer pass). Answer or resolve each on the PR, then re-apply `pendulum:objective` to resume");
    assert.deepEqual(gh.state.labelled, []);
  });
});

/**
 * A local --wait follow of PR #12 on a mocked clock: each poll's pause moves it on by `pollMs` and calls `step` with the
 * minutes since the start. Returns the follow's answer, the minutes it ran and the loop's lines. A follow still going
 * after a day fails the test.
 */
async function followOnClock(pollMs, step, env = {}) {
  const lines = [];
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  logTo({ write: (s) => lines.push(s) });
  const start = Date.now();
  const pause = async (ms) => {
    mock.timers.tick(ms);
    const min = (Date.now() - start) / 60_000;
    if (min > 24 * 60) throw new Error(`still following after a day:\n${lines.join("")}`);
    step(min);
  };
  try {
    const loop = Object.assign(Object.create(Local.prototype), { repo, repoFull: "o/r", opts: { token: "t" }, baseEnv: () => ({ PENDULUM_CI_CHECKS: "ci", ...env }), pause });
    const answer = await loop.followMerge(2, 12, { pollMs });
    return { answer, minutes: (Date.now() - start) / 60_000, lines: lines.join("") };
  } finally {
    logTo(null);
    mock.timers.reset();
  }
}

/** PR #12 for Objective 2, reviewed and recorded mergeable at its head. */
async function reviewedPr(g, gh) {
  const two = g.commit("pendulum/2", g.main(), "export const version = 1;\nexport function saveTwo() {}\n", "two");
  const pr = gh.open(12, 2, two);
  await recordMergeable(repo, 12, 2, two, { token: "t" });
  return pr;
}

const mergedNow = (pr) => Object.assign(pr, { merged: true, merged_at: new Date().toISOString(), state: "closed" });
const entryAt = (state, position) => ({ state, enqueuedAt: "2026-01-01T00:00:00Z", position, headCommit: null });

test("#438: local --wait follows a PR through a long merge queue while its entry moves, past any fixed bound", async () => {
  await withGitHub(async (g, gh) => {
    const pr = await reviewedPr(g, gh);
    gh.state.queueTimeout = 60;
    gh.queued.add(12);
    gh.state.entry = entryAt("QUEUED", 3);
    // Four hours in the queue, its place moving up each hour (never still for the 110-min bound), then it merges.
    const r = await followOnClock(30 * 60_000, (min) => {
      gh.state.entry = min >= 180 ? entryAt("AWAITING_CHECKS", 1) : entryAt("QUEUED", 3 - Math.floor(min / 60));
      if (min >= 240) mergedNow(pr), gh.queued.delete(12);
    });
    assert.equal(r.answer, true, r.lines);
    assert.ok(r.minutes >= 240, "followed past 120 minutes and past the hung bound, while it moved in the queue");
    assert.match(r.lines, /following PR #12: in the merge queue \(entry QUEUED, position 3\)\n[^]*following PR #12: in the merge queue \(entry AWAITING_CHECKS, position 1\)\n/, "it says where the PR is as that changes");
  });
});

test("#438: local --wait stops on a merge queue entry that cannot be read, or stays the same, past the queue's check timeout plus the hung bound", async () => {
  await withGitHub(async (g, gh) => {
    await reviewedPr(g, gh);
    gh.state.queueTimeout = 60;
    gh.queued.add(12);
    gh.state.entryFails = true;
    let r = await followOnClock(10 * 60_000, () => {});
    assert.equal(r.answer, false);
    assert.equal(r.minutes, 110, r.lines);
    assert.match(r.lines, /stopped following PR #12: its merge queue entry \(unread\) made no progress in 110 min, past the merge queue's 60-min check timeout plus the bound for a hung required check \(50 min\)/);

    gh.state.entryFails = false;
    gh.state.entry = entryAt("QUEUED", 2);
    r = await followOnClock(10 * 60_000, () => {});
    assert.equal(r.minutes, 110, r.lines);
    assert.match(r.lines, /its merge queue entry \(QUEUED, position 2\) made no progress in 110 min/);
  });
});

test("#438: local --wait follows a PR waiting for the queue ahead while that queue changes, and stops once it has not for the queue's check timeout plus the hung bound", async () => {
  await withGitHub(async (g, gh) => {
    const base = g.main();
    // Siblings that write the same line of store.mjs as PR #12: each in the queue conflicts with it by a trial merge.
    const one = g.commit("pendulum/1", base, "export const version = 1;\nexport function saveOne() {}\n", "one");
    const four = g.commit("pendulum/4", base, "export const version = 1;\nexport function saveFour() {}\n", "four");
    await reviewedPr(g, gh);
    g.publish();
    gh.state.queueTimeout = 60;
    // Taken out for a conflict with #11 ahead of it; at 60 min #11 has left and #14, which conflicts too, waits there.
    gh.state.removals = [{ at: new Date(Date.now() + 1000).toISOString(), reason: "merge_conflict" }];
    gh.state.entries = [{ pr: 11, head: one }];
    const r = await followOnClock(10 * 60_000, (min) => {
      if (min >= 60) gh.state.entries = [{ pr: 14, head: four }];
    });
    assert.equal(r.answer, false);
    assert.equal(r.minutes, 170, `110 min after the queue ahead last changed, not after the follow began: ${r.lines}`);
    assert.match(r.lines, /following PR #12: out of the merge queue, waiting for the queue ahead of it to move\n/);
    assert.match(r.lines, /stopped following PR #12 after 110 min waiting for the merge queue ahead of it \(#14\), which did not change, past the merge queue's 60-min check timeout plus the bound for a hung required check \(50 min\)/);
    assert.deepEqual(gh.attempts, []);
  });
});

test("#438: local --wait counts the bound out of the queue from when it last saw the PR there", async () => {
  await withGitHub(async (g, gh) => {
    await reviewedPr(g, gh);
    gh.state.queueTimeout = 60;
    gh.queued.add(12);
    // Three hours in the queue, moving up; then out of it, its checks running again.
    const r = await followOnClock(10 * 60_000, (min) => {
      gh.state.entry = entryAt("QUEUED", 4 - Math.floor(min / 60));
      if (min >= 180) gh.queued.delete(12), (gh.state.checkRuns = [{ id: 1, name: "ci", status: "in_progress", conclusion: null, started_at: new Date().toISOString() }]);
    });
    assert.equal(r.answer, false);
    assert.equal(r.minutes, 230, `50 min after it left the queue, not after the follow began: ${r.lines}`);
    assert.match(r.lines, /stopped following PR #12 after 50 min out of the merge queue, the bound for a hung required check \(from the merge queue's 60-min check timeout\); still pending: its required checks on [0-9a-f]{7} \(ci running\)/);
  });
});

test("#438: with auto_merge off, local --wait follows a PR a person put in the queue, and otherwise stops naming the person's merge", async () => {
  await withGitHub(async (g, gh) => {
    const pr = await reviewedPr(g, gh);
    gh.state.queueTimeout = 60;
    // A person enqueues it at 10 min; the queue's checks take 80 more; it merges at 90, past the 50-min bound.
    let r = await followOnClock(
      10 * 60_000,
      (min) => {
        if (min >= 10) gh.queued.add(12), (gh.state.entry = entryAt(min >= 30 ? "AWAITING_CHECKS" : "QUEUED", 1));
        if (min >= 90) mergedNow(pr), gh.queued.delete(12);
      },
      { PENDULUM_AUTO_MERGE: "false" },
    );
    assert.equal(r.answer, true, r.lines);
    assert.equal(r.minutes, 90);
    assert.deepEqual(gh.attempts, [], "Pendulum merges and enqueues nothing with auto_merge off");

    // Never enqueued: it stops after the bound, waiting on a person, not on a hung check.
    Object.assign(pr, { merged: false, merged_at: null, state: "open" });
    r = await followOnClock(10 * 60_000, () => {}, { PENDULUM_AUTO_MERGE: "false" });
    assert.equal(r.answer, false);
    assert.equal(r.minutes, 50);
    assert.match(r.lines, /stopped following PR #12 after 50 min with no person merging it or putting it in the merge queue \(auto_merge is off\)\n/);
    assert.doesNotMatch(r.lines, /hung required check/);
  });
});

test("#438: local --wait out of the merge queue stops on the bound from the queue's check timeout, naming it and the pending checks", async () => {
  await withGitHub(async (g, gh) => {
    await reviewedPr(g, gh);
    gh.state.checkRuns = [{ id: 1, name: "ci", status: "in_progress", conclusion: null, started_at: new Date().toISOString() }];
    // A 30-minute queue check timeout: a running required check is hung past 20 minutes.
    gh.state.queueTimeout = 30;
    let r = await followOnClock(5 * 60_000, () => {});
    assert.equal(r.answer, false);
    assert.equal(r.minutes, 20, "stopped at the repository's bound, not 120 minutes");
    assert.match(r.lines, /stopped following PR #12 after 20 min out of the merge queue, the bound for a hung required check \(from the merge queue's 30-min check timeout\); still pending: its required checks on [0-9a-f]{7} \(ci running\)/);
    assert.deepEqual(gh.enqueued, []);

    // No merge queue: setup's default timeout is the bound, and the line says so.
    gh.state.queueTimeout = 0;
    r = await followOnClock(10 * 60_000, () => {});
    assert.equal(r.minutes, 50);
    assert.match(r.lines, /stopped following PR #12 after 50 min waiting for its merge, the bound for a hung required check \(from setup's default 60-min check timeout\); still pending: its required checks/);

    // A 4-hour timeout: checks green after 150 minutes are still followed, enqueued and merged.
    gh.state.queueTimeout = 240;
    r = await followOnClock(10 * 60_000, (min) => {
      if (min >= 150) gh.state.checkRuns = [{ id: 1, name: "ci", status: "completed", conclusion: "success" }];
      if (gh.queued.size || gh.enqueued.length) mergedNow(gh.prs[12]);
    });
    assert.equal(r.answer, true, r.lines);
    assert.deepEqual(gh.enqueued.map((e) => e.pr), [12]);
  });
});
