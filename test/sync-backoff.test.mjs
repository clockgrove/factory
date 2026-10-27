// A sync job that fails runs again once its backoff ends (jobs.ts,
// github-sync.ts): the live status comment and the Work Item issues of an
// Objective that finished while GitHub's rate limit was spent are still
// written, and a check-only item's issue, which no PR closes, is closed;
// a withdrawal's comment edit is made, so the service can let the run go.
// GitHub is a fake; the clock is the test's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TransientError } from "../dist/github.js";
import { GitHubSync } from "../dist/github-sync.js";
import { Jobs } from "../dist/jobs.js";
import { mark } from "../dist/markdown.js";
import { trackingDue } from "../dist/tracking.js";
import { item, plan, REPO, tempDir, until } from "./helpers.mjs";

/**
 * A GitHubSync on the fake `github`, with progress comments and tracking
 * on; its log goes to `events`. No jitter after a rate limit's reset, so a
 * limited job's wait is exactly max(reset, the base backoff).
 */
function syncOf(github, events, now) {
  return new GitHubSync(
    github,
    {
      repository: REPO,
      secrets: [],
      operators: [],
      progress: { enabled: true, includeQuestions: true },
      tracking: {
        enabled: true,
        issueType: { objective: "Objective", workItem: "Task" },
      },
      queue: {
        projectId: "PVT_1",
        options: { done: "Done", cancelled: "Cancelled" },
      },
    },
    { write: (on, event) => events.push({ on, ...event }) },
    { noteAfterMs: 0, remindAfterMs: 0 },
    now,
    () => 0,
  );
}

test("a failed job is pending until it succeeds, and held only while its backoff is on", async () => {
  let clock = Date.parse("2026-10-27T01:44:00.000Z");
  const jobs = new Jobs(
    { write: () => {} },
    "test",
    { baseMs: 10_000, maxMs: 60_000, deadlineMs: 60_000 },
    () => clock,
  );
  let runs = 0;
  const failing = async () => {
    runs += 1;
    throw new TransientError("rate limited");
  };
  jobs.run(1, "k", failing);
  await until(() => !jobs.active("k"), "the failed run");
  assert.equal(runs, 1);
  assert.ok(jobs.pending("k"));
  assert.ok(jobs.held("k"));
  // Within the backoff, a run is refused.
  clock += 9_999;
  jobs.run(1, "k", failing);
  assert.equal(runs, 1);
  assert.ok(jobs.held("k"));
  // Once it ends, the key is due again, and still owed (service.ts
  // `release` reads `pending` as an observation not yet landed).
  clock += 1;
  assert.ok(!jobs.held("k"));
  assert.ok(jobs.pending("k"));
  jobs.run(1, "k", async () => {
    runs += 1;
  });
  await until(() => !jobs.pending("k"), "the run that worked");
  assert.equal(runs, 2);
});

test("a finished Objective's status and Work Item issues are written after a rate-limited pass", async () => {
  const issue = 4;
  const startedAt = "2026-10-27T01:41:25.238Z";
  let clock = Date.parse("2026-10-27T01:44:00.000Z");
  // The installation's rate limit is spent until `reset` (github.ts sends
  // it as a TransientError, rate limited).
  const reset = clock + 35_000;
  const comments = new Map();
  const closed = [];
  const events = [];
  let calls = 0;
  const limited = (what) => {
    calls += 1;
    if (clock < reset)
      throw new TransientError(
        `GitHub ${what}: 403 API rate limit exceeded`,
        reset - clock,
        true,
      );
  };
  const github = {
    repository: REPO,
    owner: REPO.split("/")[0],
    name: REPO.split("/")[1],
    rest: async () => ({}),
    graphqlPartial: async () => ({
      data: { repository: { issueTypes: { nodes: [] } } },
    }),
    upsertComment: async (on, marker, body) => {
      limited(`PATCH comment on #${on}`);
      comments.set(marker, body);
      const at = new Date(clock).toISOString();
      return { id: comments.size, created_at: at, updated_at: at };
    },
    closeIssue: async (number, reason) => {
      limited(`PATCH /issues/${number}`);
      closed.push([number, reason]);
    },
  };
  // Two items: one that merged its PR (whose body closed its issue), and
  // a check-only one with no PR, settled without a merge of its own.
  const accepted = plan([
    item("pair"),
    item("integrated-test", { kind: "qa", dependencies: ["pair"] }),
  ]);
  const recorded = (number, fields = {}) => ({
    issue: number,
    id: 6051312800 + number,
    body: "as created",
    labels: [],
    parent: true,
    blockedBy: [],
    comment: "as last written while building",
    ...fields,
  });
  const state = {
    version: 9,
    issue,
    status: "done",
    holds: [],
    answers: {},
    repairs: {},
    kept: {},
    attempts: {},
    appliedRequests: [],
    retries: {},
    done: {
      plan: accepted,
      "item:pair:publish": { pr: 13 },
      "item:pair:merge": {
        mergeSha: "5".repeat(40),
        integratedSha: "5".repeat(40),
        at: "2026-10-27T01:43:59.000Z",
      },
      "item:integrated-test:merge": { settled: "qa" },
    },
    modules: {
      github: {
        itemId: "I_4",
        commentsSince: startedAt,
        status: {
          hash: "building",
          shown: "building",
          at: "2026-10-27T01:43:26Z",
        },
        tracking: {
          items: {
            pair: recorded(9),
            "integrated-test": recorded(11, { blockedBy: ["pair"] }),
          },
          objective: { priority: [] },
          untyped: true,
          project: null,
        },
      },
    },
    startedAt,
    ended: { at: "2026-10-27T01:45:49.000Z" },
    updatedAt: startedAt,
  };
  const runner = {
    state,
    settled: true,
    blocked: () => false,
    transact: (change) => change(),
  };
  const sync = syncOf(github, events, () => clock);
  const view = {
    logs: tempDir("factory-backoff-logs-"),
    queue: { mode: "running" },
    waitsOn: () => null,
  };
  // One tick's status and tracking jobs (github-sync.ts `tick`).
  const tick = () => {
    sync.status(runner, view);
    sync.track(runner);
  };
  const failed = (job) =>
    events.some((event) => event.event === "github-sync" && event.job === job);

  // The pass right after the Objective finished meets the rate limit.
  tick();
  await until(
    () => failed(`status:${issue}`) && failed(`track:${issue}`),
    "both rate-limited passes",
  );
  assert.deepEqual(closed, []);
  const tried = calls;

  // Within their backoff, nothing is tried again.
  clock += 5_000;
  tick();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, tried);

  // Past it, and past the reset, both run again and land.
  clock = reset + 25_000;
  tick();
  await until(
    () => closed.length === 2 && state.modules.github.status.shown === "done",
    "the final status and the closed Work Item issues",
  );
  assert.deepEqual(closed.sort(), [
    [11, "completed"],
    [9, "completed"],
  ]);
  const shown = comments.get(mark(issue, "item-status", "integrated-test"));
  assert.match(shown, /\*\*Phase:\*\* merged/);
  assert.match(shown, /\*\*Closed:\*\* merged\./);
  assert.ok(state.modules.github.tracking.items["integrated-test"].closed);
  assert.equal(trackingDue(state, clock), false);
  assert.ok(comments.has(mark(issue, "status", startedAt)));
});

test("a withdrawal whose comment edit failed is shown once its backoff ends", async () => {
  const issue = 7;
  const startedAt = "2026-10-27T01:40:00.000Z";
  let clock = Date.parse("2026-10-27T01:44:00.000Z");
  const reset = clock + 5_000;
  const edited = [];
  const events = [];
  let calls = 0;
  const github = {
    repository: REPO,
    owner: REPO.split("/")[0],
    name: REPO.split("/")[1],
    editComment: async (on, marker, body) => {
      calls += 1;
      if (clock < reset)
        throw new TransientError(
          `GitHub PATCH comment on #${on}: 403 API rate limit exceeded`,
          reset - clock,
          true,
        );
      edited.push([marker, body]);
    },
  };
  // Withdrawn before planning: the service lets it go only once its
  // status comment shows the withdrawal (`withdrawShown`).
  const state = {
    version: 9,
    issue,
    status: "checking",
    withdrawing: true,
    holds: [],
    answers: {},
    repairs: {},
    kept: {},
    attempts: {},
    appliedRequests: [],
    retries: {},
    done: {},
    modules: { github: { itemId: "I_7", commentsSince: startedAt } },
    startedAt,
    updatedAt: startedAt,
  };
  const runner = {
    state,
    settled: false,
    blocked: () => false,
    transact: (change) => change(),
  };
  const sync = syncOf(github, events, () => clock);
  const view = { queue: { mode: "running" }, waitsOn: () => null };

  sync.status(runner, view);
  await until(
    () =>
      events.some(
        (event) =>
          event.event === "github-sync" && event.job === `status:${issue}`,
      ),
    "the rate-limited edit",
  );
  assert.equal(sync.withdrawShown(state), false);

  // Within its backoff, nothing is tried again.
  clock += 9_999;
  sync.status(runner, view);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1);

  // Past it, the edit is made and the run may go.
  clock += 1;
  sync.status(runner, view);
  await until(() => sync.withdrawShown(state), "the withdrawal shown");
  assert.equal(calls, 2);
  assert.deepEqual(edited, [
    [
      mark(issue, "status", startedAt),
      `${mark(issue, "status", startedAt)}\nWithdrawn before planning; queue it again to start afresh.`,
    ],
  ]);
});
