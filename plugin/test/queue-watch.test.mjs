import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { watchQueue } from "../scripts/dispatch.mjs";
import { approvalPolicyCheck, githubChecks } from "../scripts/doctor.mjs";
import { HUNG_CODE, marker, setSelf } from "../scripts/lib/logic.mjs";
import { mergeBlockReason, mergeReadyOne } from "../scripts/lib/session.mjs";

// #2683: factory-scratch PR #468's queue commit hung in CI's setup step; the queue dropped it with checks_timed_out, and
// the `dequeued` run that would re-enqueue it was held for approval (its actor, github-merge-queue[bot], is an outside
// contributor under all_external_contributors). Recovery must come from the queue watch, which no approval holds.

const SELF = "factory-app[bot]";
const repo = { full: "o/r", owner: "o", name: "r" };
const ACTIONS = { id: 15368, slug: "github-actions" };
const HEAD = "a".repeat(40);
const ISSUE = 7;
const PR = 21;

/** GitHub as the merge pass and the queue watch read it: one reviewed, green PR, the merge queue, its timeline. */
function fakeGitHub({ clock = () => Date.now() } = {}) {
  const s = {
    entry: null, // the PR's merge queue entry: { state, enqueuedAt, head, headAt }
    runs: { [HEAD]: [{ id: 1, name: "Quality", status: "completed", conclusion: "success", app: ACTIONS }] },
    removals: [], // timeline RemovedFromMergeQueueEvent nodes
    enqueued: [],
    dequeued: 0,
    comments: { [PR]: [{ id: 100, user: { login: SELF }, body: `<!-- factory:${ISSUE}:mergeable:${HEAD} -->\nFactory: reviewed`, created_at: new Date(clock() - 3 * 3600_000).toISOString() }] },
    reviewedAt: new Date(clock() - 3 * 3600_000).toISOString(),
    timeout: 60, // the ruleset's check_response_timeout_minutes
    failEnqueue: 0, // enqueue calls GitHub answers with a 502
    jobs: {}, // Actions jobs by id (a check run's id is its job's)
    history: [], // the Quality workflow's recent green runs: { stepName: ms }
    headAt: new Date(clock() - 3 * 3600_000).toISOString(), // the PR head's committer date
    timeline: {}, // issue timeline events (REST) by number
    queueRuns: [], // the merge_group workflow runs (REST actions/runs)
    annotations: {}, // check-run annotations by check-run id
  };
  let id = 200;
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const drop = (reason, login, type) => {
    s.entry = null;
    s.removals.push({ createdAt: new Date(clock()).toISOString(), reason, actor: { login, __typename: type } });
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    // The Objective's issue, open and labelled: the merge pass reads it before any merge (session.mjs mergeReadyOne).
    if (method === "GET" && /\/issues\/\d+$/.test(u.split("?")[0])) return json(200, { number: Number(/(\d+)$/.exec(u.split("?")[0])[1]), state: "open", labels: [{ name: "factory:objective" }] });
    if (/\/graphql$/.test(u)) {
      const q = body.query;
      const pull = (x) => json(200, { data: { repository: { pullRequest: x } } });
      if (q.includes("isInMergeQueue")) return pull({ isInMergeQueue: !!s.entry });
      if (q.includes("mergeQueueEntry { state")) return pull({ mergeQueueEntry: s.entry && { state: s.entry.state, enqueuedAt: s.entry.enqueuedAt, headCommit: s.entry.head ? { oid: s.entry.head, committedDate: s.entry.headAt } : null } });
      if (q.includes("timelineItems")) return pull({ timelineItems: { nodes: s.removals } });
      if (q.includes("dequeuePullRequest")) {
        s.dequeued += 1;
        drop("MANUAL", "factory-app", "Bot");
        return json(200, { data: { dequeuePullRequest: { mergeQueueEntry: { id: "e" } } } });
      }
      if (q.includes("enqueuePullRequest")) {
        if (s.failEnqueue > 0) {
          s.failEnqueue -= 1;
          return json(502, { message: "Bad Gateway" });
        }
        if (s.entry) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request is already in the queue" }] });
        s.enqueued.push(body.variables.oid);
        s.entry = { state: "QUEUED", enqueuedAt: new Date(clock()).toISOString(), head: null, headAt: null };
        return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: "e" } } } });
      }
      return json(200, { data: {} });
    }
    if (method === "GET" && /\/repos\/o\/r$/.test(u)) return json(200, { default_branch: "main" });
    if (method === "GET" && (m = /\/actions\/jobs\/(\d+)$/.exec(u))) return s.jobs[m[1]] ? json(200, s.jobs[m[1]]) : json(404, { message: "Not Found" });
    if (method === "GET" && (m = /\/actions\/runs\/(\d+)\/jobs/.exec(u))) {
      const steps = s.history[Number(m[1]) - 1000] || {};
      const t = Date.parse("2026-11-01T00:00:00Z");
      return json(200, { jobs: [{ name: "Quality", steps: Object.entries(steps).map(([name, ms]) => ({ name, conclusion: "success", started_at: new Date(t).toISOString(), completed_at: new Date(t + ms).toISOString() })) }] });
    }
    if (method === "GET" && /\/actions\/runs\/\d+$/.test(u)) return json(200, { workflow_id: 77 });
    if (method === "GET" && /\/actions\/runs\?/.test(u)) {
      const q = new URL(u).searchParams;
      const from = Date.parse((q.get("created") || "").replace(/^>=/, ""));
      return json(200, { total_count: 0, workflow_runs: s.queueRuns.filter((r) => q.get("event") === "merge_group" && r.event === "merge_group" && (!Number.isFinite(from) || Date.parse(r.created_at) >= from)) });
    }
    if (method === "GET" && (m = /\/check-runs\/(\d+)\/annotations/.exec(u))) return json(200, s.annotations[m[1]] || []);
    if (method === "GET" && (m = /\/commits\/([0-9a-z]+)$/.exec(u))) return json(200, { sha: m[1], commit: { committer: { date: s.headAt } }, parents: [] });
    if (method === "GET" && /\/actions\/workflows\/77\/runs/.test(u)) return json(200, { workflow_runs: s.history.map((_, k) => ({ id: 1000 + k, event: k % 2 ? "merge_group" : "push", head_branch: k % 2 ? "gh-readonly-queue/main/pr-1" : "main" })) });
    if (method === "GET" && /\/repos\/o\/r\/rulesets\?/.test(u)) return json(200, [{ id: 1, target: "branch", enforcement: "active" }]);
    if (method === "GET" && /\/repos\/o\/r\/rulesets\/1$/.test(u))
      return json(200, {
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [
          { type: "merge_queue", parameters: { check_response_timeout_minutes: s.timeout } },
          { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Quality", integration_id: ACTIONS.id }] } },
        ],
      });
    if (method === "GET" && new RegExp(`/repos/o/r/pulls/${PR}$`).test(u)) return json(200, { number: PR, state: "open", draft: false, merged: false, node_id: "PR_21", title: "Objective 7", labels: [], head: { sha: HEAD, ref: `factory/${ISSUE}` }, base: { ref: "main" }, mergeable: true, mergeable_state: "clean" });
    if (method === "GET" && /\/pulls\/\d+\/reviews/.test(u)) return json(200, [{ id: 1, user: { login: SELF }, body: `${marker(ISSUE, "review")}\nFactory reviewer`, submitted_at: s.reviewedAt }]);
    if (method === "GET" && /\/pulls\/\d+\/comments/.test(u)) return json(200, []);
    if (method === "GET" && (m = /\/issues\/(\d+)\/comments/.exec(u))) return json(200, s.comments[m[1]] || []);
    if (method === "POST" && (m = /\/issues\/(\d+)\/comments$/.exec(u))) {
      const c = { id: id++, user: { login: SELF }, body: body.body, created_at: new Date(clock()).toISOString() };
      (s.comments[m[1]] ||= []).push(c);
      return json(201, c);
    }
    if (method === "PATCH" && (m = /\/issues\/comments\/(\d+)$/.exec(u))) {
      const c = Object.values(s.comments).flat().find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return json(200, c);
    }
    if (method === "GET" && (m = /\/commits\/([0-9a-z]+)\/check-runs/.exec(u))) return json(200, { total_count: (s.runs[m[1]] || []).length, check_runs: s.runs[m[1]] || [] });
    if (method === "GET" && /\/commits\/[0-9a-z]+\/status$/.test(u)) return json(200, { statuses: [] });
    if (method === "GET" && /\/commits\/[0-9a-z]+\/check-suites/.test(u)) return json(200, { check_suites: [] });
    if (method === "GET" && (m = /\/issues\/(\d+)\/timeline/.exec(u))) return json(200, s.timeline[m[1]] || []);
    return json(404, { message: `Not Found: ${method} ${u}` });
  };
  /**
   * The queue builds a commit for the entry at `at`; its `Quality` job gets a runner `wait` ms later, spends `before` ms on
   * earlier steps, and runs `step` since (its check run's id is the job's). `status: "queued"` keeps it waiting for a
   * runner; `steps: false` gives a job with a runner and no steps yet.
   */
  let jobId = 500;
  const building = (sha, at, { wait = 5_000, status = "in_progress", step = "Run scripts/ci/setup.sh", before = 3_000, steps = true } = {}) => {
    const id = jobId++;
    s.entry = { state: "AWAITING_CHECKS", enqueuedAt: new Date(at).toISOString(), head: sha, headAt: new Date(at).toISOString() };
    const started = new Date(at + wait).toISOString();
    s.runs[sha] = [{ id, name: "Quality", status, conclusion: null, app: ACTIONS, started_at: status === "queued" ? new Date(at + 1_000).toISOString() : started }];
    s.jobs[id] = {
      id,
      run_id: 42,
      name: "Quality",
      workflow_name: "Quality",
      status,
      started_at: status === "queued" ? null : started,
      steps:
        status === "queued" || !steps
          ? []
          : [
              { name: "Set up job", status: "completed", started_at: started, completed_at: new Date(at + wait + before).toISOString() },
              { name: step, status: "in_progress", started_at: new Date(at + wait + before).toISOString(), completed_at: null },
              { name: "Post Run actions/checkout@v7", status: "pending", started_at: null, completed_at: null },
            ],
    };
  };
  return { s, fetch, drop, building };
}

async function withGitHub(fake, fn) {
  const real = globalThis.fetch;
  setSelf(SELF);
  globalThis.fetch = fake.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// The Actions route: the job token reads Actions (actionsToken). The local route passes none.
const merge = (report = {}, extra = {}) => mergeReadyOne(repo, { issue: ISSUE, prNumber: PR, queue: true, checkNames: ["Quality"], report, actionsToken: "job", ...extra }, { token: "t" });
const requeues = (s) => (s.comments[ISSUE] || []).filter((c) => c.body.includes(`<!-- factory:${ISSUE}:requeue:`));
const MIN = 60_000;

test("queue watch: a PR the queue drops after its CI started ticks the dispatcher, with no dequeued run; the merge pass re-enqueues it once (#2683)", async () => {
  let now = Date.now();
  const fake = fakeGitHub({ clock: () => now });
  await withGitHub(fake, async () => {
    // CI started on the queue commit: before #2683 the watch let the PR go here, and a drop was left to `dequeued`.
    const queuedAt = now;
    fake.building("b".repeat(40), queuedAt);
    const sleep = async (ms) => {
      now += ms;
      // Four minutes in, the queue drops the PR (its checks failed on the queue commit). No `dequeued` run follows.
      if (fake.s.entry && now >= queuedAt + 4 * MIN) fake.drop("FAILED_CHECKS", "github-merge-queue", "Bot");
    };
    const r = await watchQueue(repo, [PR], { token: "t" }, { now: () => now, sleep, maxMs: 2 * 3600_000 });
    assert.deepEqual(r, { tick: true, pr: PR, left: true }, "the watch outlives the check starting and ticks when the PR leaves");

    // That tick's merge pass: enqueued again once, with the one line on the issue, and watched again.
    const report = {};
    assert.equal(await merge(report), "queued");
    assert.equal(fake.s.enqueued.length, 1);
    assert.equal(report.watch, true, "the re-enqueued PR is watched again");
    assert.equal(requeues(fake.s).length, 1);
    assert.match(requeues(fake.s)[0].body, /the merge queue dropped PR #21 \(failed_checks\).*enqueued again \(try 2\)/, "the queue's drop is said to be the queue's");

    // The `dequeued` run, where GitHub does run it, is the same merge pass a moment later: nothing is enqueued twice.
    const again = {};
    assert.equal(await merge(again), "in-queue");
    assert.equal(fake.s.enqueued.length, 1, "the dequeued run and the watch's tick enqueue once between them");
    assert.equal(requeues(fake.s).length, 1, "one notice");
    assert.equal(again.watch, true, "a PR left in the queue is watched until it leaves, whatever its checks show");
  });
});

test("queue watch: a PR still in the queue at the watch's bound ticks anyway, so the next dispatcher run watches it again", async () => {
  let now = Date.now();
  const fake = fakeGitHub({ clock: () => now });
  await withGitHub(fake, async () => {
    fake.building("c".repeat(40), now);
    const r = await watchQueue(repo, [PR], { token: "t" }, { now: () => now, sleep: async (ms) => (now += ms), maxMs: 12 * MIN });
    assert.deepEqual(r, { tick: true, pr: null });
  });
});

test("hung queue check: tonight's case, a setup step normally ~1 min, is left at 15 min and re-enqueued once past 16, then Blocks naming the step (#2683)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.history = Array.from({ length: 12 }, (_, k) => ({ "Run scripts/ci/setup.sh": 50_000 + k * 800, "Run npm test": 20 * MIN }));
    // max(3 x ~1 min, ~1 min + 15 min): not stalled at 15 minutes.
    fake.building("0".repeat(40), Date.now() - 15 * MIN);
    assert.equal(await merge({}), "in-queue");
    assert.equal(fake.s.dequeued, 0, "15 minutes of a normal ~1 is under the bound");
    const since = Date.now() - 16.2 * MIN;
    fake.building("d".repeat(40), since);

    // The watch sees it first and ticks.
    const w = await watchQueue(repo, [PR], { token: "t" }, { sleep: async () => {}, maxMs: 0, actionsToken: "job" });
    assert.deepEqual(w, { tick: true, pr: PR, stalled: true });

    // The merge pass takes it out (CI restarts on the new queue commit) and puts it back once, naming the stuck step
    // and its times, and saying Factory, not the queue, took it out.
    const report = {};
    assert.equal(await merge(report), "queued");
    assert.equal(fake.s.dequeued, 1);
    assert.equal(fake.s.enqueued.length, 1);
    assert.equal(requeues(fake.s).length, 1);
    assert.match(requeues(fake.s)[0].body, new RegExp(`Factory took PR #21 out of the merge queue \\(${HUNG_CODE}; no progress: \`Quality\` / \`Run scripts/ci/setup\\.sh\` running 16 min, normally ~1 min\\).*try 2`));

    // It hangs again on the new queue commit: out again, and the Objective Blocks with the step named.
    fake.building("e".repeat(40), since);
    const blocked = {};
    const how = await merge(blocked);
    assert.equal(how, "dropped");
    assert.equal(fake.s.dequeued, 2);
    assert.equal(fake.s.enqueued.length, 1, "no third enqueue");
    assert.match(mergeBlockReason(how, blocked), /`Quality` \/ `Run scripts\/ci\/setup\.sh` running 16 min, normally ~1 min.*re-enqueued the PR once/);
    assert.doesNotMatch(mergeBlockReason(how, blocked), /checks_never_started/);
  });
});

test("hung queue check: progress decides, not the job's age; no history falls back to the time bound; a runner wait never stalls (#2683 F1)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.history = Array.from({ length: 12 }, () => ({ "Run scripts/ci/setup.sh": MIN, "Run npm test": 20 * MIN }));
    // A long but normal step: tests usually 20 minutes, running 25, in a job that started 55 minutes ago.
    fake.building("1".repeat(40), Date.now() - 55 * MIN, { step: "Run npm test", before: 30 * MIN });
    const slow = {};
    assert.equal(await merge(slow), "in-queue");
    assert.equal(slow.watch, true);
    assert.equal(fake.s.dequeued, 0, "25 of a normal 20 is progress");
    assert.deepEqual(await watchQueue(repo, [PR], { token: "t" }, { sleep: async () => {}, maxMs: 0, actionsToken: "job" }), { tick: true, pr: null }, "the watch keeps it too");

    // A warm 6-minute build running 20 minutes: under max(18, 21), not stalled.
    fake.s.history = fake.s.history.map((h) => ({ ...h, "Run npm run build": 6 * MIN }));
    fake.building("7".repeat(40), Date.now() - 22 * MIN, { step: "Run npm run build", before: 2 * MIN });
    assert.equal(await merge({}), "in-queue");
    assert.equal(fake.s.dequeued, 0, "a warm 6-minute build at 20 minutes is progress");

    // The tests step past three times its baseline (61 of a normal 20): stalled.
    fake.building("2".repeat(40), Date.now() - 91.5 * MIN, { step: "Run npm test", before: 30 * MIN });
    assert.equal(await merge({}), "queued");
    assert.equal(fake.s.dequeued, 1);

    // No history for the step: the fallback bound (50 minutes at 60) from the job's own start.
    fake.s.history = [];
    fake.s.entry = null;
    fake.building("3".repeat(40), Date.now() - 16.2 * MIN);
    assert.equal(await merge({}), "in-queue", "no history, 16 minutes: within the fallback");
    fake.building("4".repeat(40), Date.now() - 51 * MIN);
    fake.s.removals = [];
    assert.equal(await merge({}), "queued", "no history, past 50 minutes: stalled");
    assert.equal(fake.s.dequeued, 2);

    // Queued for a runner for 59 minutes, or a runner with no steps yet 55 minutes after the commit: never stalled.
    fake.building("5".repeat(40), Date.now() - 59 * MIN, { status: "queued" });
    assert.equal(await merge({}), "in-queue");
    fake.building("6".repeat(40), Date.now() - 55 * MIN, { steps: false });
    assert.equal(await merge({}), "in-queue");
    assert.equal(fake.s.dequeued, 2, "a check waiting for a runner, or with no steps yet, is not hung");
  });
});

test("hung queue check: a running step GitHub gives no start time is judged by the fallback from the check run's start, never skipped (#2683 F2-a)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.history = Array.from({ length: 12 }, () => ({ "Run scripts/ci/setup.sh": MIN }));
    const strip = () => {
      const id = fake.s.runs[fake.s.entry.head][0].id;
      fake.s.jobs[id].steps[1].started_at = null;
    };
    fake.building("8".repeat(40), Date.now() - 30 * MIN);
    strip();
    assert.equal(await merge({}), "in-queue", "30 minutes: within the fallback");
    fake.building("9".repeat(40), Date.now() - 51 * MIN);
    strip();
    assert.equal(await merge({}), "queued", "past the fallback from the check run's start: stalled");
    assert.equal(fake.s.dequeued, 1);
  });
});

test("hung queue check: the local route (no Actions token) judges a queue check by the time fallback only (#2683 F1-c)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.history = Array.from({ length: 12 }, () => ({ "Run scripts/ci/setup.sh": MIN }));
    fake.building("a1".repeat(20), Date.now() - 16.2 * MIN);
    assert.equal(await merge({}, { actionsToken: null }), "in-queue", "no step progress read: 16 minutes is within the fallback");
    fake.building("a2".repeat(20), Date.now() - 51 * MIN);
    assert.equal(await merge({}, { actionsToken: null }), "queued", "past the fallback: stalled");
    assert.equal(fake.s.dequeued, 1);
  });
});

test("hung queue check: a hung removal read back on a later pass keeps its code, so a queue drop after it Blocks with checks_hung (#2683 F2)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.building("3".repeat(40), Date.now() - 52 * MIN);
    assert.equal(await merge({}), "queued");
    // Factory's removal is on the timeline now, and its requeue comment holds the code. The queue then drops the PR.
    fake.drop("FAILED_CHECKS", "github-merge-queue", "Bot");
    const blocked = {};
    const how = await merge(blocked);
    assert.equal(how, "dropped");
    assert.match(mergeBlockReason(how, blocked), /\(checks_hung, failed_checks\)/, "the earlier removal reads as hung, not as never started");
  });
});

test("hung queue check: an enqueue that fails after Factory took the PR out leaves it watched, and the next pass puts it back (#2683 F3)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.building("4".repeat(40), Date.now() - 52 * MIN);
    fake.s.failEnqueue = 1;
    const report = {};
    await assert.rejects(merge(report));
    assert.equal(fake.s.dequeued, 1);
    assert.equal(fake.s.entry, null, "out of the queue");
    assert.equal(report.watch, true, "the caller has it watched, so its next pass comes without a cron");
    // The watch's first read sees it out and ticks; that pass enqueues it again.
    assert.deepEqual(await watchQueue(repo, [PR], { token: "t" }, { sleep: async () => {}, maxMs: 0, actionsToken: "job" }), { tick: true, pr: PR, left: true });
    assert.equal(await merge({}), "queued");
    assert.equal(fake.s.enqueued.length, 1);
  });
});

test("hung queue check: the merge pass uses the bound its caller read once, as the watch does (#2683 F4)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    // The ruleset now reads 30 (bound 20 min); the tick read 60 (bound 50) at its start: the pass keeps the tick's bound.
    fake.s.timeout = 30;
    fake.building("5".repeat(40), Date.now() - 25 * MIN);
    assert.equal(await merge({}, { hungMs: 50 * MIN }), "in-queue");
    assert.equal(fake.s.dequeued, 0);
    // With no bound given, the pass reads the queue's own once: 20 minutes.
    assert.equal(await merge({}), "queued");
    assert.equal(fake.s.dequeued, 1);
  });
});

// #9: the queue dropped the PR twice (GitHub never started its merge_group jobs: a billing lock), the Objective Blocked,
// and a re-entry pushed a new head and delivered with the old review standing. The old drops are not this head's.
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const queueDrop = (at) => ({ createdAt: at, reason: "FAILED_CHECKS", actor: { login: "github-merge-queue", __typename: "Bot" } });
const labeled = (name, at) => ({ event: "labeled", label: { name }, created_at: at });

test("queue drops: drops before the issue's last re-entry or Block, or before the head's commit, do not count; drops after them still Block (#9)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.reviewedAt = ago(5 * 3600_000);
    fake.s.headAt = ago(5 * 3600_000);
    fake.s.removals = [queueDrop(ago(4 * 3600_000)), queueDrop(ago(3.5 * 3600_000))];
    fake.s.timeline[ISSUE] = [labeled("factory:blocked", ago(3.4 * 3600_000)), labeled("factory:objective", ago(3 * 3600_000))];
    const report = {};
    assert.equal(await merge(report), "queued", "the re-entry starts the count over: the new head is enqueued");
    assert.equal(fake.s.enqueued.length, 1);
    assert.equal(requeues(fake.s).length, 0, "no drop counted, so no re-enqueue notice");

    // The Block alone (no re-entry yet read) moves the count too, and so does a head committed after the drops.
    fake.s.entry = null;
    fake.s.timeline[ISSUE] = [labeled("factory:blocked", ago(3.4 * 3600_000))];
    assert.equal(await merge({}), "queued");
    fake.s.entry = null;
    fake.s.timeline[ISSUE] = [];
    fake.s.headAt = ago(3 * 3600_000);
    assert.equal(await merge({}), "queued", "a head committed after the drops: they were the old head's");

    // A head date in the future is no time GitHub recorded: it never puts the drops out of count.
    fake.s.entry = null;
    fake.s.headAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    assert.equal(await merge({}), "dropped", "the review is the bound again: two drops since it Block");

    // Two drops after the re-entry still Block.
    fake.s.entry = null;
    fake.s.headAt = ago(5 * 3600_000);
    fake.s.timeline[ISSUE] = [labeled("factory:objective", ago(3 * 3600_000))];
    fake.s.removals.push(queueDrop(ago(2 * 3600_000)), queueDrop(ago(3600_000)));
    const blocked = {};
    assert.equal(await merge(blocked), "dropped");
    assert.match(mergeBlockReason("dropped", blocked), /dropped the reviewed PR 2 times/);
  });
});

test("queue drops: a Block on drops whose merge_group jobs GitHub never started is infrastructure, quoting GitHub's annotation (#9)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    const lock = "The job was not started because your account is locked due to a billing issue.";
    const queueRun = (k, at) => {
      const sha = String(k).repeat(40);
      fake.s.queueRuns.push({ id: 900 + k, event: "merge_group", head_branch: `gh-readonly-queue/main/pr-${PR}-${"f".repeat(40)}`, head_sha: sha, created_at: at, conclusion: "failure" });
      fake.s.runs[sha] = [{ id: 700 + k, name: "Quality", status: "completed", conclusion: "failure", app: ACTIONS, check_suite: { id: 800 + k }, started_at: at, completed_at: at }];
      fake.s.jobs[700 + k] = { id: 700 + k, name: "Quality", status: "completed", conclusion: "failure", steps: [], runner_id: null, runner_name: null };
      fake.s.annotations[700 + k] = [{ annotation_level: "failure", message: lock }];
    };
    // Another PR's queue run on the same window is not this PR's.
    fake.s.queueRuns.push({ id: 990, event: "merge_group", head_branch: `gh-readonly-queue/main/pr-${PR + 1}-${"f".repeat(40)}`, head_sha: "9".repeat(40), created_at: ago(30 * MIN), conclusion: "failure" });
    queueRun(1, ago(2 * 3600_000));
    queueRun(2, ago(3600_000));
    fake.s.removals = [queueDrop(ago(2 * 3600_000 - MIN)), queueDrop(ago(3600_000 - MIN))];
    const blocked = {};
    assert.equal(await merge(blocked), "dropped");
    const why = mergeBlockReason("dropped", blocked);
    assert.ok(why.includes(`GitHub did not start the required job Quality: ${lock}`), why);
    assert.match(why, /infrastructure, not the change/);
    assert.doesNotMatch(why, /Check that the required checks run/, "not blamed on the checks");

    // A job that ran and failed on the queue's commit is the checks': the queue's own words stay.
    for (const k of [1, 2]) fake.s.jobs[700 + k] = { ...fake.s.jobs[700 + k], steps: [{ name: "Run npm test", conclusion: "failure" }], runner_id: 5, runner_name: "r" };
    const ran = {};
    assert.equal(await merge(ran), "dropped");
    assert.match(mergeBlockReason("dropped", ran), /Check that the required checks run on the queue's merge_group commits/);
  });
});

test("doctor: an approval policy that can hold the merge queue bot's dequeued run WARNs that recovery runs from the queue watch (#2683)", () => {
  const [held] = approvalPolicyCheck({ approval_policy: "all_external_contributors" });
  assert.equal(held.status, "WARN");
  assert.match(held.detail, /all_external_contributors.*github-merge-queue\[bot\]/);
  assert.match(held.fix, /queue-watch job/);
  assert.equal(approvalPolicyCheck({ approval_policy: "first_time_contributors" })[0].status, "WARN");
  assert.equal(approvalPolicyCheck({ approval_policy: "first_time_contributors_new_to_github" })[0].status, "PASS");
  const [unread] = approvalPolicyCheck({ error: 403 });
  assert.equal(unread.status, "WARN");
  assert.match(unread.detail, /^unread \(needs admin; HTTP 403\)/);
});

test("doctor: the dequeue approval check runs only with a merge queue, and says so when the policy is unread (#2683 F6)", async () => {
  const run = async ({ queue, policy }) => {
    const reads = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      const json = (st, b) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
      if (path === "/repos/o/r") return json(200, { default_branch: "main" });
      if (path === "/repos/o/r/rulesets") return json(200, [{ id: 1, target: "branch", enforcement: "active" }]);
      if (path === "/repos/o/r/rulesets/1") return json(200, { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: queue ? [{ type: "merge_queue", parameters: {} }] : [] });
      if (path.endsWith("/fork-pr-contributor-approval")) return policy ? json(200, { approval_policy: policy }) : json(403, { message: "Resource not accessible by integration" });
      if (path === "/graphql") return json(200, { data: {} });
      return json(404, { message: "Not Found" });
    };
    try {
      const inputs = { repo: "o/r", objectiveLabel: "factory:objective", maintainers: [], notify: "", ciChecks: [], setup: "", validation: [], githubToken: "" };
      const out = await githubChecks({ inputs, repo, token: "t", app: { appSlug: "factory-app", missing: [], extra: [] }, env: {} });
      return { checks: out.filter((c) => c.name === "dequeue approval"), asked: reads.some((p) => p.endsWith("/fork-pr-contributor-approval")) };
    } finally {
      globalThis.fetch = real;
    }
  };
  const unread = await run({ queue: true, policy: null });
  assert.equal(unread.checks.length, 1);
  assert.equal(unread.checks[0].status, "WARN");
  assert.match(unread.checks[0].detail, /^unread \(needs admin/);
  const held = await run({ queue: true, policy: "all_external_contributors" });
  assert.equal(held.checks[0].status, "WARN");
  const none = await run({ queue: false, policy: "all_external_contributors" });
  assert.deepEqual(none, { checks: [], asked: false }, "no merge queue: no dequeued run, nothing read");
});
