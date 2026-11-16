import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { watchQueue } from "../scripts/dispatch.mjs";
import { approvalPolicyCheck, githubChecks } from "../scripts/doctor.mjs";
import { HUNG_CODE, marker, setSelf } from "../scripts/lib/logic.mjs";
import { mergeBlockCause, mergeBlockReason, mergeReadyOne, queueDropBlock, queueRedBody, queueRedMarker, queueRedRecords, queueTryEnd, readQueueRed, recordQueueTry, writeQueueRed } from "../scripts/lib/session.mjs";
import { openTriage } from "../scripts/lib/triage.mjs";
import { openProgressCheck } from "../scripts/lib/fix-progress.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    labels: [], // the PR's label writes, in order: "+name" or "-name"
    logs: {}, // Actions job logs by job id
    prFiles: [{ filename: "src/add.js", patch: "+export const add = (a, b) => a - b;" }], // the PR's files
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
    if (method === "GET" && (m = /\/actions\/jobs\/(\d+)\/logs$/.exec(u))) return new Response(s.logs[m[1]] ?? "", { status: 200 });
    if (method === "GET" && /\/pulls\/\d+\/files/.test(u)) return json(200, s.prFiles);
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
      // `status=failure`: finished runs that failed only, as GitHub lists them.
      return json(200, { total_count: 0, workflow_runs: s.queueRuns.filter((r) => q.get("event") === "merge_group" && r.event === "merge_group" && (!Number.isFinite(from) || Date.parse(r.created_at) >= from) && (!q.get("status") || r.conclusion === q.get("status"))) });
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
    if (method === "POST" && /\/issues\/\d+\/labels$/.test(u)) {
      s.labels.push(...body.labels.map((l) => `+${l}`));
      return json(200, body.labels.map((name) => ({ name })));
    }
    if (method === "DELETE" && (m = /\/issues\/\d+\/labels\/(.+)$/.exec(u))) {
      s.labels.push(`-${decodeURIComponent(m[1])}`);
      return json(200, []);
    }
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
/**
 * A review stage read each red queue drop (FAILED_CHECKS) as no failure of the PR's own (#312: session.mjs queueRedOf):
 * its record says so, and the merge pass treats the drop as any other.
 */
const readByReview = (fake, kind = "flaky") => {
  for (const r of fake.s.removals.filter((x) => x.reason === "FAILED_CHECKS")) {
    const body = `${queueRedMarker(ISSUE, r.createdAt)}\n${queueRedBody(ISSUE, PR, { at: r.createdAt, state: "requeued", kind })}`;
    const had = (fake.s.comments[ISSUE] || []).find((c) => c.body.startsWith(queueRedMarker(ISSUE, r.createdAt)));
    if (had) had.body = body;
    else (fake.s.comments[ISSUE] ||= []).push({ id: 5000 + fake.s.removals.indexOf(r), user: { login: SELF }, body, created_at: r.createdAt });
  }
};
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

    // That tick's merge pass hands the red run to the review stage first (#312); the review read it as a flake.
    assert.equal(await merge({}), "queue-red");
    assert.deepEqual(fake.s.labels, ["-factory:review", "+factory:review"], "the review label back on: the review stage reads the failure");
    assert.equal(fake.s.enqueued.length, 0);
    readByReview(fake);
    // Then the merge pass: enqueued again once, with the one line on the issue, and watched again.
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

test("#423 hung queue check: the repository's step_stall_factor and step_stall_floor_minutes decide: a warm 6-minute build at 20 minutes is progress by default, hung at 2 x and 5 minutes", async () => {
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const stall = resolveInputs({ env: { FACTORY_STEP_STALL_FACTOR: "2", FACTORY_STEP_STALL_FLOOR_MINUTES: "5" } }).stall;
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.history = Array.from({ length: 12 }, () => ({ "Run scripts/ci/setup.sh": MIN, "Run npm run build": 6 * MIN }));
    fake.building("7".repeat(40), Date.now() - 22 * MIN, { step: "Run npm run build", before: 2 * MIN });
    assert.equal(await merge({}), "in-queue");
    assert.deepEqual(await watchQueue(repo, [PR], { token: "t" }, { sleep: async () => {}, maxMs: 0, actionsToken: "job" }), { tick: true, pr: null }, "the watch keeps it");
    assert.equal(fake.s.dequeued, 0, "under max(3 x 6, 6 + 15)");
    // The watch and the merge pass at the repository's settings: past max(2 x 6, 6 + 5), hung.
    assert.deepEqual(await watchQueue(repo, [PR], { token: "t" }, { sleep: async () => {}, maxMs: 0, actionsToken: "job", stall }), { tick: true, pr: PR, stalled: true });
    assert.equal(await merge({}, { stall }), "queued");
    assert.equal(fake.s.dequeued, 1);
    assert.match(requeues(fake.s)[0].body, new RegExp(`\\(${HUNG_CODE}; no progress: \`Quality\` / \`Run npm run build\` running 20 min, normally ~6 min\\)`));
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
    readByReview(fake);
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
    readByReview(fake);
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
    readByReview(fake);
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
    readByReview(fake, "not-started");
    const blocked = {};
    assert.equal(await merge(blocked), "dropped");
    const why = mergeBlockReason("dropped", blocked);
    assert.ok(why.includes(`GitHub did not start the required job Quality: ${lock}`), why);
    assert.match(why, /infrastructure, not the change/);
    assert.doesNotMatch(why, /Check that the required checks run/, "not blamed on the checks");

    // A job that ran and failed on the queue's commit: the Block names it and its first failure line, the work's (#312).
    for (const k of [1, 2]) fake.s.jobs[700 + k] = { ...fake.s.jobs[700 + k], steps: [{ name: "Run npm test", conclusion: "failure" }], runner_id: 5, runner_name: "r" };
    fake.s.logs[702] = testLog;
    // The review stage read these drops with triage off, and no failure named what the PR changed.
    readByReview(fake, "unclassified");
    const ran = {};
    assert.equal(await merge(ran), "dropped");
    const said = mergeBlockReason("dropped", ran);
    assert.match(said, /its run on the queue's commit failed: `Quality`: .+\. Fix that on the branch/);
    assert.doesNotMatch(said, /Check that the required checks run/, "they ran and failed: the cause is named, not the wiring");
    assert.equal(mergeBlockCause("dropped", ran), "work");
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

// ------------------------------------------------------------------ a red merge-queue run (#312)

const testLog = ["##[group]Run npm test", "not ok 1 - adds", "  AssertionError [ERR_ASSERTION]: 2 == 3", "##[error]Process completed with exit code 1."].join("\n");

/** The queue's failed run for PR 21 on its merge_group commit `sha`, its Quality job (id) as `job` has it, with `log`. */
function queueRed(fake, { sha = "c".repeat(40), id = 610, at = ago(10 * MIN), job = {}, log = testLog } = {}) {
  fake.s.queueRuns.push({ id: 900 + id, event: "merge_group", head_branch: `gh-readonly-queue/main/pr-${PR}-${"f".repeat(40)}`, head_sha: sha, created_at: at, conclusion: "failure" });
  fake.s.runs[sha] = [{ id, name: "Quality", status: "completed", conclusion: "failure", app: ACTIONS, check_suite: { id: 800 }, started_at: at, completed_at: at }];
  fake.s.jobs[id] = { id, run_id: 900 + id, name: "Quality", status: "completed", conclusion: "failure", steps: [{ name: "Run npm test", conclusion: "failure", number: 3 }], runner_id: 5, runner_name: "r", ...job };
  fake.s.logs[id] = log;
  return sha;
}
const records = (fake) => queueRedRecords(fake.s.comments[ISSUE] || [], ISSUE);

/**
 * The review stage's step (session.mjs readQueueRed) on the fake, with triage's decider answering `verdict` (none: off),
 * on the PR's `head`, then how its fix pass ended as review.mjs records it (recordQueueTry): `pass` {before, after,
 * pushed, rec, question}, by default a pass that committed and pushed; null, no pass ran.
 * `progressCheck`: the fix-progress check (fix-progress.mjs); none judges by the exact checks alone.
 */
async function reviewReads(fake, verdict = null, { head = HEAD, pass = COMMITTED, progressCheck = null, diffStat = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "nokey-"));
  try {
    const triage = openTriage({ inputs: {}, env: {}, home, repo, issue: ISSUE, prNumber: PR, token: "t", actionsToken: "job", ...(verdict ? { decider: { decide: async () => verdict } } : {}) });
    const step = await readQueueRed({ repo, issue: ISSUE, prNumber: PR, base: "main", head, names: async () => ["Quality"], triage, progressCheck, diffStat, token: "t", actionsToken: "job" });
    if (step?.state === "fixing") await recordQueueTry(repo, ISSUE, PR, step.record, { rec: null, ...pass }, { token: "t" });
    return step;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const own = { verdict: "change_caused", confidence: 0.95 };
/** How a queue fix pass ended (session.mjs queueTryEnd): committed and pushed; ran and committed nothing; never ran. */
const COMMITTED = { before: "a".repeat(40), after: "b".repeat(40), pushed: true, rec: { ok: true } };
const IDLE = { before: "a".repeat(40), after: "a".repeat(40), pushed: true, rec: { ok: true } };
const NEVER_RAN = { before: "a".repeat(40), after: "a".repeat(40), pushed: true, rec: null };

test("queue red: a red run on the queue's commit goes to the review stage once per drop, before any re-enqueue or Block; other drops do not (#312)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    fake.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    assert.deepEqual(records(fake).map((r) => r.state), ["handed"]);
    assert.deepEqual(fake.s.labels, ["-factory:review", "+factory:review"]);
    assert.equal(fake.s.enqueued.length, 0, "nothing enqueued before the review stage read it");
    assert.match(fake.s.comments[ISSUE].at(-1).body, /the merge queue's run of PR #21's required checks failed \(failed_checks\) at [^;]+; the review stage reads whether the failure is the PR's own change\./);
    // Not read yet (the stage did not run): handed again, with the one record.
    assert.equal(await merge({}), "queue-red");
    assert.equal(records(fake).length, 1);
    // A second red drop after a re-enqueue is its own: handed too, even past the queue's bound of drops.
    readByReview(fake);
    fake.s.removals.push(queueDrop(ago(2 * MIN)));
    assert.equal(await merge({}), "queue-red", "before the Block the two drops would make");
    assert.deepEqual(records(fake).map((r) => r.state), ["requeued", "handed"]);
    // A drop of another kind (the queue's timeout) is enqueued again as before, never handed.
    const other = fakeGitHub();
    await withGitHub(other, async () => {
      other.s.removals = [{ createdAt: ago(5 * MIN), reason: "CHECKS_TIMED_OUT", actor: { login: "github-merge-queue", __typename: "Bot" } }];
      assert.equal(await mergeReadyOne(repo, { issue: ISSUE, prNumber: PR, queue: true, checkNames: ["Quality"], actionsToken: "job" }, { token: "t" }), "queued");
      assert.deepEqual(other.s.labels, []);
    });
  });
});

test("queue red: the review stage reads the PR's own change as one fix pass, handed the queue's failure; red again the same way after it, it Blocks (#312)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    const sha = queueRed(fake, { at: ago(20 * MIN) });
    fake.s.removals = [queueDrop(ago(18 * MIN))];
    assert.equal(await merge({}), "queue-red");
    const step = await reviewReads(fake, own);
    assert.equal(step.state, "fixing");
    assert.equal(step.red.sha, sha);
    assert.equal(step.red.queue, true);
    assert.deepEqual(step.red.failures.map((f) => [f.command, f.code]), [["CI job Quality", 1]]);
    assert.ok(step.red.failures[0].full.includes("AssertionError [ERR_ASSERTION]: 2 == 3"), "the job's whole log for $FACTORY_IN/checks/");
    assert.match(step.line, /^merge queue run red on ccccccc: Quality \(required check\): .+; the PR's own change, one fix pass \(the answer pass\)$/);
    const [rec] = records(fake);
    assert.equal(rec.state, "fixed");
    assert.equal(rec.sigs.length, 1);
    assert.match(rec.sigs[0], /^sig:[0-9a-f]{12}$/);
    // Read once: nothing is pending now.
    assert.equal(await reviewReads(fake), null);

    // The fix's head goes back in; the queue's run fails again the same way: no second fix pass, Blocked.
    const again = queueRed(fake, { sha: "d".repeat(40), id: 611, at: ago(12 * MIN) });
    fake.s.removals.push(queueDrop(ago(10 * MIN)));
    assert.equal(await merge({}), "queue-red");
    const blocked = await reviewReads(fake, own);
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.reason, new RegExp(`^the merge queue's run on its commit ${again.slice(0, 7)} failed in this PR's own change \\(Quality \\(required check\\): .+\\) after Factory's fix pass, which made no progress: the same jobs fail with the same failure lines`));
    assert.deepEqual(records(fake).map((r) => r.state), ["fixed", "blocked"]);

    // Another failure of the same job on a later drop: the decision model judges the fix pass before it; closer, it gets its fix pass.
    queueRed(fake, { sha: "e".repeat(40), id: 612, at: ago(5 * MIN), log: testLog.replace("2 == 3", "4 == 5").replace("adds", "subtracts") });
    fake.s.removals.push(queueDrop(ago(3 * MIN)));
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(fake, own, { progressCheck: closer() })).state, "fixing");
    assert.deepEqual(records(fake).map((r) => r.state), ["fixed", "blocked", "fixed"]);
  });
});

test("queue red: a flake, a job GitHub never started or no readable run is enqueued again as any drop, with no fix pass (#312)", async () => {
  // Triage reads the failure as a flake: recorded, and the merge pass re-enqueues it once.
  const flaky = fakeGitHub();
  await withGitHub(flaky, async () => {
    queueRed(flaky, { log: testLog.replace("AssertionError [ERR_ASSERTION]: 2 == 3", "Error: connect ETIMEDOUT 10.0.0.1:5432") });
    flaky.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    const step = await reviewReads(flaky, { verdict: "flaky_or_infra", confidence: 0.9 });
    assert.equal(step.state, "requeued");
    assert.equal(step.red, undefined, "no fix pass");
    assert.match(step.line, /not known to be the PR's change \(flaky\), enqueued again as any drop$/);
    assert.equal(await merge({}), "queued");
    assert.equal(requeues(flaky.s).length, 1, "the re-enqueue's one line, as before");
  });
  // GitHub never started the queue's job: infrastructure, and the queue's bound Blocks it as before.
  const locked = fakeGitHub();
  await withGitHub(locked, async () => {
    queueRed(locked, { job: { steps: [], runner_id: null, runner_name: null } });
    locked.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(locked, { verdict: "change_caused", confidence: 0.95 })).state, "requeued");
    assert.equal(records(locked)[0].kind, "not-started");
  });
  // No queue run of the drop is ever listed (a failing check no Actions run carries): read again by the next stage, then
  // nothing is known, so it is no fix pass.
  const none = fakeGitHub();
  await withGitHub(none, async () => {
    none.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(none)).state, "pending");
    assert.deepEqual(records(none).map((r) => [r.state, r.reads]), [["handed", 1]]);
    assert.equal(await merge({}), "queue-red", "handed again");
    const step = await reviewReads(none);
    assert.equal(step.state, "requeued");
    assert.equal(records(none)[0].kind, "none");
  });
});

test("queue red: a deterministic failure only the queue's jobs run (another OS) is the PR's own change, judged from the log, and its fix pass gets that job's log (#312, assetgrove#174)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    // The PR's checks run Linux only and were green; the queue runs Windows too. The PR's new test expects SIGKILL,
    // which Windows reports as null: red on Windows only, every time.
    fake.s.prFiles = [{ filename: "test/kill.test.mjs", patch: '+test("kills", () => assert.equal(child.signalCode, "SIGKILL"));' }];
    const sha = "7".repeat(40);
    const at = ago(10 * MIN);
    const winLog = ["##[group]Run npm test", "# Subtest: kills", "not ok 3 - kills", "  AssertionError [ERR_ASSERTION]: null == 'SIGKILL'", "      at TestContext.<anonymous> (file:///D:/a/app/app/test/kill.test.mjs:12:10)", "##[error]Process completed with exit code 1."].join("\n");
    fake.s.queueRuns.push({ id: 951, event: "merge_group", head_branch: `gh-readonly-queue/main/pr-${PR}-${"f".repeat(40)}`, head_sha: sha, created_at: at, conclusion: "failure" });
    fake.s.runs[sha] = [
      { id: 620, name: "test (windows-latest)", status: "completed", conclusion: "failure", app: ACTIONS, check_suite: { id: 801 }, started_at: at, completed_at: ago(8 * MIN) },
      { id: 621, name: "Quality", status: "completed", conclusion: "failure", app: ACTIONS, check_suite: { id: 801 }, started_at: ago(7 * MIN), completed_at: ago(7 * MIN) },
    ];
    fake.s.jobs[620] = { id: 620, run_id: 951, name: "test (windows-latest)", status: "completed", conclusion: "failure", steps: [{ name: "Run npm test", conclusion: "failure", number: 4 }], runner_id: 7, runner_name: "w" };
    fake.s.jobs[621] = { id: 621, run_id: 951, name: "Quality", status: "completed", conclusion: "failure", steps: [{ name: "Run test \"$RESULT\" = success", conclusion: "failure", number: 2 }], runner_id: 8, runner_name: "l" };
    fake.s.logs[620] = winLog;
    fake.s.logs[621] = 'test "$RESULT" = success\n##[error]Process completed with exit code 1.';
    fake.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    // Even a decider that calls every job a flake does not decide it: the failure names a test the PR changed.
    const step = await reviewReads(fake, { verdict: "flaky_or_infra", confidence: 0.95 });
    assert.equal(step.state, "fixing", "the PR's own change: one fix pass, no re-enqueue");
    assert.equal(step.red.sha, sha);
    const win = step.red.failures.find((f) => f.command === "CI job test (windows-latest)");
    assert.ok(win, step.red.failures.map((f) => f.command).join(", "));
    assert.ok(win.full.includes("AssertionError [ERR_ASSERTION]: null == 'SIGKILL'"), "the failed job's whole log");
    assert.match(step.red.lead, /test \(windows-latest\)[^\n]*\n?[\s\S]*null == 'SIGKILL'/, "the job named, with its first failing test");
    assert.match(step.line, /test \(windows-latest\)/);
  });
});

// ------------------------------------------------------------------ the queue's fix passes: bounded, recorded once done (#312 review)

/** Three different failures of the PR's own on three drops, each with its own run and log. */
const failureNo = (i) => testLog.replace("adds", ["alpha", "beta", "gamma", "delta"][i]).replace("2 == 3", `${i} is not ${i + 1}`);

/** A fix-progress check whose decision model answers `verdict` (closer by default); `asked` the questions. */
const closer = (verdict = { verdict: "closer", confidence: 0.9 }) => {
  const check = openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input) => (check.asked.push(input), verdict) } });
  check.asked = [];
  return check;
};

test("queue red: the queue's fix passes go on while each makes progress, past two per re-entry; a failure seen before Blocks naming both; a re-entry starts over (#399)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    const states = [];
    const check = closer();
    for (let i = 0; i < 3; i++) {
      queueRed(fake, { sha: String(i + 1).repeat(40), id: 630 + i, at: ago((40 - 10 * i) * MIN), log: failureNo(i) });
      fake.s.removals.push(queueDrop(ago((38 - 10 * i) * MIN)));
      assert.equal(await merge({}), "queue-red");
      states.push((await reviewReads(fake, own, { progressCheck: check })).state);
    }
    assert.deepEqual(states, ["fixing", "fixing", "fixing"], "each a new failure the decision model reads as closer");
    assert.equal(check.asked.length, 2, "the first red is not judged");
    assert.deepEqual(records(fake).at(-1).jobs.map(([name]) => name), ["Quality"]);
    // The first failure comes back: no progress, whatever the model would say.
    queueRed(fake, { sha: "5".repeat(40), id: 634, at: ago(9 * MIN), log: failureNo(0) });
    fake.s.removals.push(queueDrop(ago(8 * MIN)));
    assert.equal(await merge({}), "queue-red");
    const back = await reviewReads(fake, own, { progressCheck: check });
    assert.equal(back.state, "blocked");
    assert.equal(check.asked.length, 2);
    assert.match(back.reason, /after Factory's fix pass, which made no progress: it brought back the red of the merge queue's run red at \S+: Quality, failing the same way, after the red it was handed \(the merge queue's run red at \S+: Quality\)/);
    // A person re-applies the Objective label: the fixes before it are not this re-entry's.
    fake.s.timeline[ISSUE] = [{ event: "labeled", label: { name: "factory:objective" }, created_at: ago(5 * MIN) }];
    queueRed(fake, { sha: "4".repeat(40), id: 633, at: ago(4 * MIN), log: failureNo(0) });
    fake.s.removals.push(queueDrop(ago(3 * MIN)));
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(fake, own)).state, "fixing");
  });
});

test("queue red: the decision model is given the before-red's failure lines and the fix pass's own commits; no answer Blocks as Factory's (#399 review)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    queueRed(fake, { sha: "1".repeat(40), id: 690, at: ago(40 * MIN), log: failureNo(0) });
    fake.s.removals.push(queueDrop(ago(38 * MIN)));
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(fake, own)).state, "fixing");
    assert.match(records(fake)[0].lead, /alpha/, "the record keeps its failure lines");
    queueRed(fake, { sha: "2".repeat(40), id: 691, at: ago(30 * MIN), log: failureNo(1) });
    fake.s.removals.push(queueDrop(ago(28 * MIN)));
    assert.equal(await merge({}), "queue-red");
    const asked = [];
    const stats = [];
    const check = openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input) => (asked.push(input), { verdict: null, confidence: null, error: "vendor" }) } });
    const step = await reviewReads(fake, own, { progressCheck: check, diffStat: async (from, to) => (stats.push([from, to]), "abc1234 fix the sum\n\n src/sum.js | 2 +-\n") });
    assert.equal(stats.length, 1, "the fix pass's own commits read once");
    assert.match(asked[0], /Before the fix pass:\n<<<BEGIN \w+>>>\nFailing: Quality\n\n[^<]*alpha/);
    assert.match(asked[0], /After the fix pass:\n<<<BEGIN \w+>>>\nFailing: Quality\n\n[^<]*beta/);
    assert.match(asked[0], /own commits \(git log --stat, merges left out\):\n<<<BEGIN \w+>>>\nabc1234 fix the sum\n\n src\/sum\.js \| 2 \+-/);
    assert.equal(step.state, "blocked");
    assert.equal(step.cause, "factory");
    assert.match(step.reason, /after Factory's fix pass, which could not be judged for progress: the decision model \(perplexity\/pplx-decider-v1\.2\) gave no answer \(vendor\)/);
  });
});

test("queue red: a roll-up with no failure line of its own is left out of the queue's comparison (#399 review)", async () => {
  const { queueJobs } = await import("../scripts/lib/session.mjs");
  const sig = { id: "aaaaaaaaaaaa", line: "not ok 1 - adds", lines: ["not ok 1 - adds"] };
  const jobs = queueJobs([{ name: "test", sig }, { name: "ci", aggregate: true, sig: { id: null, line: "", lines: [] } }]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0][0], "test");
  assert.equal(jobs[0][1], "aaaaaaaaaaaa");
  assert.match(jobs[0][2], /^[0-9a-f]{12}$/, "the folded failure lines' digest");
  // The record's digest counts folded lines: durations fold away, how many failures do not.
  const { failureSignature } = await import("../scripts/lib/triage.mjs");
  const of = (lines) => queueJobs([{ name: "test", sig: failureSignature("test", lines.join("\n")) }])[0];
  const three = of(["✖ parses row 1 (2.1ms)", "✖ parses row 2 (3.4ms)", "✖ parses row 3 (0.9ms)"]);
  assert.deepEqual(of(["✖ parses row 1 (1.7ms)", "✖ parses row 2 (4.2ms)", "✖ parses row 3 (1.1ms)"]), three, "only durations changed: the same");
  const one = of(["✖ parses row 3 (1.3ms)"]);
  assert.equal(one[1], three[1], "one class");
  assert.notEqual(one[2], three[2], "three failures are not one");
});

test("queue red: with no decision model, a new failure of the same job after a fix pass is no progress and Blocks (#399)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    const states = [];
    for (let i = 0; i < 2; i++) {
      queueRed(fake, { sha: String(i + 1).repeat(40), id: 670 + i, at: ago((40 - 10 * i) * MIN), log: failureNo(i) });
      fake.s.removals.push(queueDrop(ago((38 - 10 * i) * MIN)));
      assert.equal(await merge({}), "queue-red");
      states.push(await reviewReads(fake, own));
    }
    assert.deepEqual(states.map((x) => x.state), ["fixing", "blocked"]);
    assert.match(states[1].reason, /after Factory's fix pass, which made no progress: the failing jobs changed without fewer of them failing and the rest passing, and no decision model can judge it;/);
  });
});

test("queue red: the stage harness's usage limit in the progress question ends the stage through UsageLimitReached; the drop stays handed (#399)", async () => {
  const { USAGE_LIMIT } = await import("../scripts/lib/harness.mjs");
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    queueRed(fake, { sha: "1".repeat(40), id: 680, at: ago(40 * MIN), log: failureNo(0) });
    fake.s.removals.push(queueDrop(ago(38 * MIN)));
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(fake, own)).state, "fixing");
    queueRed(fake, { sha: "2".repeat(40), id: 681, at: ago(30 * MIN), log: failureNo(1) });
    fake.s.removals.push(queueDrop(ago(28 * MIN)));
    assert.equal(await merge({}), "queue-red");
    // The judge as openProgressCheck returns it when the stage harness's decision call met its usage limit.
    const limit = { harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", message: "m", resetAt: Date.now() + 3600_000 };
    const limited = { judge: async () => ({ progress: false, why: "the decision model (claude m-1) gave no answer (rate_limited)", limited: limit }) };
    await assert.rejects(reviewReads(fake, own, { progressCheck: limited }), (e) => e.code === USAGE_LIMIT && e.refusal === limit);
    assert.deepEqual(records(fake).map((r) => r.state), ["fixed", "handed"], "nothing decided: the next stage reads it again");
  });
});

test("queue red: with triage off, a red is the PR's own only when its failure names what the PR changed; else it is enqueued again as any drop", async () => {
  for (const [files, want] of [[[{ filename: "src/other.js", patch: "+x" }], "requeued"], [[{ filename: "test/x.test.mjs", patch: '+test("adds", () => {});' }], "fixing"]]) {
    const fake = fakeGitHub();
    await withGitHub(fake, async () => {
      fake.s.prFiles = files;
      queueRed(fake, { id: 640 + files.length + want.length });
      fake.s.removals = [queueDrop(ago(5 * MIN))];
      assert.equal(await merge({}), "queue-red");
      const step = await reviewReads(fake);
      assert.equal(step.state, want, files[0].filename);
      if (want === "requeued") assert.equal(records(fake)[0].kind, "unclassified");
    });
  }
});

test("queue red: each try's end is recorded; tries whose pass never ran never count, one that ran and committed nothing Blocks (#399)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    queueRed(fake, { id: 650, at: ago(20 * MIN) });
    fake.s.removals = [queueDrop(ago(18 * MIN))];
    assert.equal(await merge({}), "queue-red");
    // Three stages in a row end before their pass runs (a crash, a stop, a pause): nothing recorded, each takes it up again.
    for (let i = 1; i <= 3; i++) {
      assert.equal((await reviewReads(fake, own, { pass: NEVER_RAN })).state, "fixing", `early end ${i}`);
      assert.deepEqual(records(fake).map((r) => [r.state, r.tries, r.ends]), [["handed", i, []]]);
      assert.equal(await merge({}), "queue-red", "handed again");
    }
    assert.equal(fake.s.enqueued.length, 0);
    // The fourth runs to its end and commits nothing: recorded, and the next read Blocks as no progress.
    assert.equal((await reviewReads(fake, own, { pass: IDLE })).state, "fixing");
    assert.deepEqual(records(fake).map((r) => [r.state, r.tries, r.ends]), [["handed", 4, ["idle"]]]);
    const blocked = await reviewReads(fake, own);
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.reason, /after Factory's fix pass that ran and committed nothing for it; fix it on the branch/);
  });
});

test("queue red: a record from before try ends were kept still Blocks at two tries", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    queueRed(fake, { id: 655, at: ago(20 * MIN) });
    fake.s.removals = [queueDrop(ago(18 * MIN))];
    assert.equal(await merge({}), "queue-red");
    const [rec] = records(fake);
    // Written as an older review stage wrote it: two tries, no `ends`.
    await writeQueueRed(repo, ISSUE, PR, { ...rec, kind: "own", tries: 2, ends: undefined }, { token: "t" });
    assert.equal(records(fake)[0].ends, null);
    const step = await reviewReads(fake, own);
    assert.equal(step.state, "blocked");
    assert.match(step.reason, /after Factory's 2 fix passes that committed nothing for it/);
  });
});

test("queue red: an answer pass that ended on an error (max turns) without committing ran: the drop's next red Blocks, never a loop (#399 review)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    queueRed(fake, { id: 657, at: ago(20 * MIN) });
    fake.s.removals = [queueDrop(ago(18 * MIN))];
    assert.equal(await merge({}), "queue-red");
    // The reviewer's sequence: the answer pass stops on error_max_turns with nothing committed, the validation commands
    // are green, its exit record says delivered, and the queue drops the PR red again.
    const maxTurns = { ok: false, subtype: "error_max_turns", error: "error_max_turns", turns: 40, exitCode: 1 };
    assert.equal(queueTryEnd({ ...IDLE, rec: maxTurns, question: false }), "idle");
    assert.equal((await reviewReads(fake, own, { pass: { ...IDLE, rec: maxTurns } })).state, "fixing");
    assert.deepEqual(records(fake).map((r) => [r.state, r.ends]), [["handed", ["idle"]]]);
    assert.equal(await merge({}), "queue-red", "the merge pass hands the drop back to review");
    const blocked = await reviewReads(fake, own);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.cause, "work");
    assert.match(blocked.reason, /after Factory's fix pass that ran and committed nothing for it/);
  });
});

test("queueTryEnd: committed when the HEAD moved and went up; idle for any pass that ran, ok or not, and committed nothing; never ran, stopped or a Question is an early end", () => {
  const ok = { ok: true };
  assert.equal(queueTryEnd({ before: "a", after: "b", pushed: true, rec: ok }), "committed");
  assert.equal(queueTryEnd({ before: "a", after: "b", pushed: true, rec: { ok: false, stopped: true } }), "committed", "a stopped pass's commit went up");
  assert.equal(queueTryEnd({ before: "a", after: "b", pushed: false, rec: ok }), null, "a refused push");
  for (const rec of [ok, { ok: false, signal: "SIGKILL" }, { ok: false, subtype: "error_max_turns" }, { ok: true, timedOut: true }, { ok: true, budgetExceeded: true }, { ok: true, unmetered: true }, { ok: false, refusal: { status: 400 } }]) {
    assert.equal(queueTryEnd({ before: "a", after: "a", pushed: true, rec }), "idle", JSON.stringify(rec));
  }
  assert.equal(queueTryEnd({ before: "a", after: "a", pushed: true, rec: null }), null, "no pass ran");
  assert.equal(queueTryEnd({ before: "a", after: "a", pushed: true, rec: { ok: false, stopped: true } }), null, "stopped");
  assert.equal(queueTryEnd({ before: "a", after: "a", pushed: true, rec: ok, question: true }), null, "a Question");
  assert.equal(queueTryEnd({ before: null, after: "a", pushed: true, rec: ok }), null, "a HEAD unread");
});


test("queue red: unreadable job logs on the queue's commit are no failure of the PR's own; a record of an older head is superseded", async () => {
  const fake = fakeGitHub();
  const inner = fake.fetch;
  fake.fetch = async (url, init = {}) => (/\/actions\/jobs\/66\d\/logs$/.test(String(url)) ? new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403, headers: { "content-type": "application/json" } }) : inner(url, init));
  await withGitHub(fake, async () => {
    queueRed(fake, { id: 660 });
    fake.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    const step = await reviewReads(fake, own);
    assert.equal(step.state, "requeued");
    assert.equal(records(fake)[0].kind, "none");
  });
  const moved = fakeGitHub();
  await withGitHub(moved, async () => {
    queueRed(moved, { id: 661 });
    moved.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    assert.equal(records(moved)[0].head, HEAD);
    const step = await reviewReads(moved, own, { head: "e".repeat(40) });
    assert.equal(step.state, "superseded");
    assert.deepEqual(records(moved).map((r) => r.state), ["superseded"]);
  });
});

test("queue drops: the Block's cause and advice follow what the review stage read the red drops as", async () => {
  const cases = { infra: ["outage", /GitHub's side \(infra\); rerun the queue's jobs/], "not-started": ["outage", /GitHub's side \(not-started\)/], base: ["work", /The default branch fails the same way: fix it there/], flaky: ["work", /read the failure as a flake each time/], unclassified: ["work", /Fix that on the branch/] };
  for (const [kind, [cause, said]] of Object.entries(cases)) {
    const fake = fakeGitHub();
    await withGitHub(fake, async () => {
      queueRed(fake, { id: 670, at: ago(30 * MIN) });
      queueRed(fake, { sha: "d".repeat(40), id: 671, at: ago(8 * MIN) });
      fake.s.removals = [queueDrop(ago(28 * MIN)), queueDrop(ago(6 * MIN))];
      readByReview(fake, kind);
      const report = {};
      assert.equal(await merge(report), "dropped", kind);
      assert.equal(mergeBlockCause("dropped", report), cause, kind);
      assert.match(mergeBlockReason("dropped", report), said, kind);
    });
  }
  assert.equal(queueDropBlock({ drops: 2, codes: ["failed_checks"] }), null, "nothing recorded or read: the queue's own words");
});

test("queue red: a record another trusted writer wrote is read (the merge pass and the review can run under different logins)", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    queueRed(fake, { id: 680 });
    fake.s.removals = [queueDrop(ago(5 * MIN))];
    assert.equal(await merge({}), "queue-red");
    for (const c of fake.s.comments[ISSUE]) if (c.body.includes("queue-red")) Object.assign(c, { user: { login: "kirk" }, author_association: "MEMBER" });
    assert.equal(records(fake).length, 1, "a writer's record counts");
    assert.equal((await reviewReads(fake, own)).state, "fixing");
    for (const c of fake.s.comments[ISSUE]) if (c.body.includes("queue-red")) Object.assign(c, { user: { login: "stranger" }, author_association: "NONE" });
    assert.equal(records(fake).length, 0, "a stranger's pasted record does not");
  });
});

test("queue red: a drop is read from its own merge-group run, never an earlier drop's; a run still going counts, and one not listed yet is read later", async () => {
  const fake = fakeGitHub();
  await withGitHub(fake, async () => {
    // Drop 1: its run failed on A, and the fix pass committed.
    queueRed(fake, { sha: "1".repeat(40), id: 690, at: ago(40 * MIN) });
    fake.s.removals = [queueDrop(ago(38 * MIN))];
    assert.equal(await merge({}), "queue-red");
    assert.equal((await reviewReads(fake, own)).state, "fixing");
    // Drop 2: the queue dropped the PR at its first failed job while the run goes on, and the finished-failed listing
    // has not got it yet. Before, the stage read drop 1's run (A, already fixed) and Blocked quoting the old failure.
    fake.s.removals.push(queueDrop(ago(10 * MIN)));
    assert.equal(await merge({}), "queue-red");
    const notYet = await reviewReads(fake, own);
    assert.equal(notYet.state, "pending", "no run of this drop yet: nothing decided");
    assert.ok(Date.parse(records(fake).at(-1).after) >= Date.parse(fake.s.removals[0].createdAt), "runs before the previous drop are not this drop's");
    // Its run appears, still in progress, with a new failure B: the PR's own, its own fix pass (the model reads it closer).
    const sha = "2".repeat(40);
    queueRed(fake, { sha, id: 691, at: ago(12 * MIN), log: failureNo(1) });
    fake.s.queueRuns.at(-1).status = "in_progress";
    fake.s.queueRuns.at(-1).conclusion = null;
    assert.equal(await merge({}), "queue-red");
    const step = await reviewReads(fake, own, { progressCheck: closer() });
    assert.equal(step.state, "fixing");
    assert.equal(step.red.sha, sha);
  });
});
