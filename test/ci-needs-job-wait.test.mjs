// A required check that is a `needs:` job gets no check run until the jobs
// it needs end, which can be long after the push. While a workflow run on
// the head whose workflow defines that job is still under way, the CI step
// waits on it instead of asking a person to fix the workflow; it asks only
// when no run on the head can report the check, or every one that could
// has completed without it (#2157, as on Clockgrove PR #905).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { observeCi } from "../dist/delivery.js";
import { DEFAULT_LIMITS, ObjectiveRunner } from "../dist/engine.js";
import { BaseFiles, workflowFileCheckNames } from "../dist/planning/facts.js";
import { newObjective } from "../dist/state.js";
import { githubOrigin, REPO, tempDir } from "./helpers.mjs";

const RUN = 40703915553;
const QUALITY = ".github/workflows/quality.yml";
const LINT = ".github/workflows/lint.yml";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A GitHub that answers only the calls delivery makes here. */
function fake(answers) {
  return new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
}

/**
 * A checkout whose origin is a GitHub URL for REPO, whose main (the PR's
 * head too) has Clockgrove's quality.yml shape: `quality` needs the
 * `commands` matrix (checks, tests, database, browser-build). lint.yml
 * defines `lint` only.
 */
function checkout() {
  const root = tempDir("factory-needs-job-");
  const bare = join(root, "origin.git");
  const dir = join(root, "checkout");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, dir);
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, QUALITY),
    [
      "name: Quality",
      "on:",
      "  pull_request:",
      "jobs:",
      "  commands:",
      "    strategy:",
      "      matrix:",
      "        command: [checks, tests, database, browser-build]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ matrix.command }}",
      "  quality:",
      "    needs: commands",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ok",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, LINT),
    [
      "name: Lint",
      "on: [pull_request]",
      "jobs:",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo lint",
      "",
    ].join("\n"),
  );
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "workflows");
  git(dir, "push", "--quiet", "origin", "main");
  githubOrigin(dir, bare);
  return { checkout: dir, head: git(dir, "rev-parse", "HEAD") };
}

const job = (name, head, status = "completed") => ({
  id: name.length,
  name,
  head_sha: head,
  status,
  conclusion: status === "completed" ? "success" : null,
  app: { id: 15368, slug: "github-actions" },
});

const workflowRun = (path, head, status, conclusion = null) => ({
  id: path === QUALITY ? RUN : 7,
  name: path === QUALITY ? "Quality" : "Lint",
  path,
  head_sha: head,
  status,
  conclusion,
});

/**
 * PR #905 at `head`, pushed 15 minutes and a minute ago, BLOCKED on
 * `required` (the default branch's), with the `commands` matrix's checks
 * on it as at 14:28:57: database still running. `runs` are the head's
 * workflow runs; `calls` counts the reads of them.
 */
function answers(head, { required = ["quality"], runs, pushedAt, calls }) {
  return {
    repository: REPO,
    defaultBranch: async () => "main",
    pull: async (number) => ({
      number,
      state: "open",
      merged: false,
      draft: false,
      head: { sha: head, ref: "factory/800/living-scene" },
      base: { ref: "main" },
    }),
    mergeState: async () => ({
      headRefOid: head,
      headRefName: "factory/800/living-scene",
      baseRefName: "main",
      mergeStateStatus: "BLOCKED",
      reviewDecision: null,
    }),
    checkRuns: async () => [
      job("commands (checks)", head),
      job("commands (tests)", head),
      job("commands (database)", head, "in_progress"),
      job("commands (browser-build)", head),
    ],
    commitStatuses: async () => [],
    requiredChecks: async () => required,
    pushTime: async () => pushedAt,
    workflowRuns: async (sha) => {
      assert.equal(sha, head);
      if (calls) calls.count += 1;
      return runs;
    },
  };
}

const pushed = (minutesAgo) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const input = (head, requiredChecks = []) => ({
  issue: 800,
  item: "living-scene",
  pr: 905,
  head,
  pushedHeads: [head],
  requiredChecks,
});

const ci = (github, dir, head, requiredChecks) =>
  observeCi(
    {
      github: fake(github),
      checkout: dir,
      signal: new AbortController().signal,
    },
    input(head, requiredChecks),
  );

test("every job of every workflow file at a commit is a check it can report, a needs: job's too", async () => {
  const { checkout: dir, head } = checkout();
  const names = await workflowFileCheckNames(new BaseFiles(dir, head));
  assert.deepEqual(Object.fromEntries(names), {
    [LINT]: ["lint"],
    [QUALITY]: [
      "commands (browser-build)",
      "commands (checks)",
      "commands (database)",
      "commands (tests)",
      "quality",
    ],
  });
});

test("a required needs: job of a workflow run under way on the head is waited for, naming the run, with no question", async () => {
  const { checkout: dir, head } = checkout();
  for (const status of [
    "queued",
    "in_progress",
    "waiting",
    "pending",
    "requested",
  ]) {
    const calls = { count: 0 };
    const waited = await ci(
      answers(head, {
        runs: [
          workflowRun(LINT, head, "completed", "success"),
          workflowRun(QUALITY, head, status),
        ],
        pushedAt: pushed(16),
        calls,
      }),
      dir,
      head,
    );
    assert.equal(waited.kind, "retry", JSON.stringify(waited));
    assert.equal(
      waited.reason,
      `Awaiting checks and protection readiness on PR #905: commands (database), quality. "quality" has not registered yet; workflow run ${RUN} (Quality, ${status}) on this head defines it and is under way`,
    );
    // No question while the run is under way, however long after the push:
    // the engine's limit on a wait bounds it (see the engine test below).
    assert.equal(waited.holdAfter, undefined, status);
    assert.equal(waited.wait, undefined);
    // One read of the head's workflow runs a poll.
    assert.equal(calls.count, 1);
  }
});

test("a plan-named needs: job of a workflow run under way is waited for too", async () => {
  const { checkout: dir, head } = checkout();
  const waited = await ci(
    answers(head, {
      required: [],
      runs: [workflowRun(QUALITY, head, "in_progress")],
      pushedAt: pushed(16),
    }),
    dir,
    head,
    ["quality"],
  );
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.match(
    waited.reason,
    new RegExp(
      `^Awaiting successful plan-required checks on PR #905: quality\\. "quality" has not registered yet; workflow run ${RUN} \\(Quality, in_progress\\) on this head defines it and is under way$`,
    ),
  );
  assert.equal(waited.holdAfter, undefined);
});

test("a required check no workflow run on the head can report still asks 15 minutes after the push, saying so", async () => {
  const { checkout: dir, head } = checkout();
  const pushedAt = pushed(16);
  // Lint is under way, but its workflow doesn't define `quality`.
  for (const runs of [[], [workflowRun(LINT, head, "in_progress")]]) {
    const waited = await ci(answers(head, { runs, pushedAt }), dir, head);
    assert.equal(waited.kind, "retry", JSON.stringify(waited));
    assert.equal(
      waited.reason,
      "Awaiting checks and protection readiness on PR #905: commands (database), quality",
    );
    assert.equal(waited.holdAfter.since, pushedAt);
    assert.equal(waited.holdAfter.ms, 15 * 60_000);
    assert.equal(
      waited.holdAfter.question,
      `Check "quality" has no run or status on PR #905's head ${head} 15 minutes after its push at ${pushedAt}, though main's branch protection requires it. No Actions workflow run on this head is of a workflow that defines "quality" as a job. Trigger or fix the workflow that reports it, then answer retry; or cancel.`,
    );
  }
});

test("a required needs: job whose workflow run completed without it asks, naming that run", async () => {
  const { checkout: dir, head } = checkout();
  const pushedAt = pushed(16);
  const waited = await ci(
    answers(head, {
      runs: [workflowRun(QUALITY, head, "completed", "cancelled")],
      pushedAt,
    }),
    dir,
    head,
  );
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.equal(waited.holdAfter.since, pushedAt);
  assert.match(
    waited.holdAfter.question,
    new RegExp(
      `though main's branch protection requires it\\. Every workflow run on this head whose workflow defines "quality" completed without reporting it: workflow run ${RUN} \\(Quality, cancelled\\)\\. Trigger or fix`,
    ),
  );
});

test("only the checks no run under way can report are asked about", async () => {
  const { checkout: dir, head } = checkout();
  const pushedAt = pushed(16);
  const waited = await ci(
    answers(head, {
      required: ["quality", "deploy"],
      runs: [workflowRun(QUALITY, head, "in_progress")],
      pushedAt,
    }),
    dir,
    head,
  );
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.match(
    waited.reason,
    new RegExp(
      `: commands \\(database\\), quality, deploy\\. "quality" has not registered yet; workflow run ${RUN} \\(Quality, in_progress\\) on this head defines it and is under way$`,
    ),
  );
  assert.match(
    waited.holdAfter.question,
    /^Check "deploy" has no run or status on PR #905's head \S+ 15 minutes after its push at .*\. No Actions workflow run on this head is of a workflow that defines "deploy" as a job\. Trigger/,
  );
});

test("without Actions read access a missing required check still asks, saying GitHub doesn't show the runs", async () => {
  const { checkout: dir, head } = checkout();
  const waited = await ci(
    answers(head, { runs: undefined, pushedAt: pushed(16) }),
    dir,
    head,
  );
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.match(
    waited.holdAfter.question,
    /requires it\. GitHub does not show this head's Actions workflow runs\. Trigger or fix/,
  );
});

test("the engine keeps waiting on the run past the 15 minutes, asks once it completes without the check, and bounds the wait by its own limit", async () => {
  const { checkout: dir, head } = checkout();
  const start = Date.now();
  let now = start;
  const key = "item:living-scene:ci";
  const runner = new ObjectiveRunner(
    newObjective(800, new Date(now), {
      provider: "codex",
      selectedBy: "defaultProvider",
      digest: "x",
      config: {},
    }),
    {
      steps: () => [
        { key, deadlineMs: 60_000, run: async () => ({ kind: "done" }) },
      ],
      status: () => "building",
    },
    tempDir("factory-needs-job-clock-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    DEFAULT_LIMITS,
    () => new Date(now),
  );
  const pushedAt = new Date(start - 15 * 60_000).toISOString();
  const poll = async (status, conclusion) =>
    runner.apply(
      key,
      await ci(
        answers(head, {
          runs: [workflowRun(QUALITY, head, status, conclusion)],
          pushedAt,
        }),
        dir,
        head,
      ),
    );
  // 14:28:57 on PR #905: 15 minutes after the push, the run is under way.
  await poll("in_progress");
  now += 60_000;
  await poll("in_progress");
  assert.deepEqual(runner.state.holds, []);
  assert.match(
    runner.state.retries[key].lastError,
    /workflow run \d+ \(Quality, in_progress\)/,
  );
  // It completes without `quality`: the question comes at once.
  now += 60_000;
  await poll("completed", "failure");
  assert.equal(runner.state.holds.length, 1);
  assert.match(
    runner.state.holds[0].question,
    /^Check "quality" has no run or status .* completed without reporting it: workflow run \d+ \(Quality, failure\)\./,
  );
  // A run that stays under way is bounded by the engine's wait limit.
  const other = new ObjectiveRunner(
    newObjective(801, new Date(start), {
      provider: "codex",
      selectedBy: "defaultProvider",
      digest: "x",
      config: {},
    }),
    {
      steps: () => [
        { key, deadlineMs: 60_000, run: async () => ({ kind: "done" }) },
      ],
      status: () => "building",
    },
    tempDir("factory-needs-job-limit-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    DEFAULT_LIMITS,
    () => new Date(now),
  );
  now = start;
  const running = await ci(
    answers(head, {
      runs: [workflowRun(QUALITY, head, "queued")],
      pushedAt,
    }),
    dir,
    head,
  );
  other.apply(key, running);
  now = start + DEFAULT_LIMITS.maxWaitMs - 60_000;
  other.apply(key, running);
  assert.deepEqual(other.state.holds, []);
  now = start + DEFAULT_LIMITS.maxWaitMs;
  other.apply(key, running);
  assert.equal(other.state.holds.length, 1);
  assert.match(other.state.holds[0].question, /has been retrying since/);
});
