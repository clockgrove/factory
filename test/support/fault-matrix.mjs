// The fault matrix: for every effect boundary of an uninterrupted two-item
// Objective (alpha → beta), inject a crash, a lost response or an unavailable
// burst at that boundary, restart the controller, and require the same fixed
// end state as an uninterrupted run, read from the strict GitHub fake's
// request log rather than from fake state.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { describe, test } from "node:test";
import { faults } from "./github-http-fake.mjs";
import { branch, marker, OBJECTIVE, runScenario } from "./fault-harness.mjs";

const repo = "/repos/{owner}/{repo}";

/** Mutations of an uninterrupted run, per endpoint. Every one is a boundary. */
export const REFERENCE_EFFECTS = {
  regular: {
    [`POST ${repo}/labels`]: 2,
    [`POST ${repo}/issues/{number}/labels`]: 1,
    [`POST ${repo}/issues`]: 2,
    [`POST ${repo}/issues/{number}/dependencies/blocked_by`]: 1,
    [`POST ${repo}/issues/{number}/sub_issues`]: 2,
    [`POST ${repo}/pulls`]: 2,
    [`PUT ${repo}/pulls/{number}/merge`]: 2,
    [`POST ${repo}/issues/{number}/comments`]: 3,
    [`PATCH ${repo}/issues/{number}`]: 3,
  },
  "native-stack": {
    [`POST ${repo}/labels`]: 2,
    [`POST ${repo}/issues/{number}/labels`]: 1,
    [`POST ${repo}/issues`]: 2,
    [`POST ${repo}/issues/{number}/dependencies/blocked_by`]: 1,
    [`POST ${repo}/issues/{number}/sub_issues`]: 2,
    [`POST ${repo}/pulls`]: 2,
    [`POST ${repo}/stacks`]: 1,
    [`PUT ${repo}/pulls/{number}/merge-async`]: 1,
    [`POST ${repo}/issues/{number}/comments`]: 3,
    [`PATCH ${repo}/issues/{number}`]: 3,
  },
};

/** Reads of an uninterrupted run; each is faulted on its first occurrence. */
export const REFERENCE_READS = {
  regular: [
    `GET ${repo}/issues/{number}`,
    `GET ${repo}/labels`,
    `GET ${repo}/issues`,
    `GET ${repo}/issues/{number}/dependencies/blocked_by`,
    `GET ${repo}/issues/{number}/sub_issues`,
    `GET ${repo}`,
    `GET ${repo}/pulls`,
    `GET ${repo}/pulls/{number}`,
    `GET ${repo}/commits/{sha}/check-runs`,
    `GET ${repo}/commits/{sha}/status`,
    "POST /graphql",
    `GET ${repo}/issues/{number}/comments`,
    "GIT fetch-advertise",
  ],
  "native-stack": [
    `GET ${repo}/issues/{number}`,
    `GET ${repo}/labels`,
    `GET ${repo}/issues`,
    `GET ${repo}/issues/{number}/dependencies/blocked_by`,
    `GET ${repo}/issues/{number}/sub_issues`,
    `GET ${repo}`,
    `GET ${repo}/pulls`,
    `GET ${repo}/pulls/{number}`,
    `GET ${repo}/commits/{sha}/check-runs`,
    `GET ${repo}/commits/{sha}/status`,
    "POST /graphql",
    `GET ${repo}/stacks`,
    `GET ${repo}/pulls/{number}/merge-async/{uuid}`,
    `GET ${repo}/issues/{number}/timeline`,
    `GET ${repo}/issues/{number}/comments`,
    "GIT fetch-advertise",
  ],
};

/** In-process effects of an uninterrupted run (model and driver calls). */
export const REFERENCE_CALLS = {
  "model.generateStructured": 1,
  "model.reviewGraph": 1,
  "model.reviewResult": 3,
  "driver.start": 2,
  "driver.collect": 2,
};

const KINDS = ["crash-before", "crash-after", "lost", "unavailable"];

function httpRule(endpoint, occurrence, kind) {
  switch (kind) {
    case "crash-before":
    case "crash-after":
      return { match: endpoint, occurrence, kind };
    case "lost":
      return { match: endpoint, occurrence, kind: "drop" };
    case "reset":
      return { match: endpoint, occurrence, kind: "reset" };
    case "unavailable":
      // A burst of two: within Factory's documented repeat budget.
      return { match: endpoint, occurrence, times: 2, ...faults.unavailable() };
  }
  throw new Error(`Unknown kind ${kind}`);
}

/** Every case of the matrix for one delivery strategy. */
export function matrixCases(delivery) {
  const cases = [];
  for (const [endpoint, count] of [
    ...Object.entries(REFERENCE_EFFECTS[delivery]),
    ["GIT push", 2],
  ])
    for (let occurrence = 1; occurrence <= count; occurrence++)
      for (const kind of KINDS)
        cases.push({
          name: `${kind} at ${endpoint} #${occurrence}`,
          boundary: { kind: "http", endpoint, occurrence },
          fault: kind,
          http: [httpRule(endpoint, occurrence, kind)],
        });
  for (const endpoint of REFERENCE_READS[delivery])
    for (const kind of ["unavailable", "reset"])
      cases.push({
        name: `${kind} at ${endpoint} #1`,
        boundary: { kind: "http", endpoint, occurrence: 1 },
        fault: kind,
        http: [httpRule(endpoint, 1, kind)],
      });
  for (const [call, count] of Object.entries(REFERENCE_CALLS)) {
    const [target, method] = call.split(".");
    for (let occurrence = 1; occurrence <= count; occurrence++)
      for (const kind of KINDS)
        cases.push({
          name: `${kind} at ${call} #${occurrence}`,
          boundary: { kind: "call", target, method, occurrence },
          fault: kind,
          inProcess: [
            {
              target,
              method,
              occurrence,
              kind,
              ...(kind === "unavailable" ? { times: 2 } : {}),
            },
          ],
        });
  }
  return cases;
}

/**
 * The fixed outcome every case must reach after restarts: the same GitHub
 * effects as an uninterrupted run, nothing duplicated, nothing refused.
 */
export function assertCleanOutcome(result, testCase) {
  const { fake, items, delivery, final } = result;
  const context = () =>
    JSON.stringify(
      { runs: result.runs, crashes: result.crashes, counts: fake.counts() },
      null,
      1,
    );
  assert.equal(final.outcome, "completed", context());
  assert.equal(final.finalValidation, true, context());
  // Exact issue count per marker, each closed with one completion comment.
  for (const item of items) {
    const issues = fake.issuesWithMarker(marker(item.id));
    assert.equal(issues.length, 1, `issues for ${item.id}\n${context()}`);
    assert.equal(issues[0].state, "closed", `issue for ${item.id} closed`);
    assert.equal(
      fake.commentsOn(issues[0].number).length,
      1,
      `completion comments on ${item.id}`,
    );
  }
  const objective = fake.issue(OBJECTIVE);
  assert.equal(objective.state, "closed", `Objective closed\n${context()}`);
  assert.equal(fake.commentsOn(OBJECTIVE).length, 1, "Objective comments");
  // Nothing but the Objective, the Work Items, their PRs and issues other
  // actors opened exists.
  assert.equal(
    Object.keys(fake.state.issues).length,
    1 + items.length * 2 + (testCase.foreignIssues ?? 0),
    `issue and PR numbers\n${context()}`,
  );
  // Exactly one PR per branch, merged.
  for (const item of items) {
    const pulls = fake.pullsForBranch(branch(item.id));
    assert.equal(pulls.length, 1, `PRs for ${item.id}\n${context()}`);
    assert.ok(pulls[0].merged_at, `PR for ${item.id} merged\n${context()}`);
  }
  // Exactly the mutations of an uninterrupted run, counted where GitHub
  // applied them (a dropped response still counts as applied).
  for (const [endpoint, count] of Object.entries(REFERENCE_EFFECTS[delivery]))
    assert.equal(
      fake.effects(endpoint).length,
      count,
      `${endpoint} applied\n${context()}`,
    );
  // Factory never sent a request GitHub refused as a duplicate, conflict or
  // invalid state, and never called an endpoint the fake does not serve.
  const refused = fake.log.filter(
    (entry) =>
      [405, 409, 422].includes(entry.status) || entry.unhandled === true,
  );
  assert.deepEqual(
    refused.map((entry) => `${entry.endpoint} → ${entry.status}`),
    [],
    context(),
  );
  // One worker start per attempt; a fault on the driver may add one attempt.
  const starts = result.harness.filter((event) => event.type === "start");
  assert.equal(
    new Set(starts.map((event) => event.attempt)).size,
    starts.length,
    "an attempt started twice",
  );
  const driverFault = testCase.boundary.target === "driver";
  for (const item of items) {
    const count = starts.filter((event) => event.item === item.id).length;
    assert.ok(
      count >= 1 && count <= (driverFault ? 2 : 1),
      `${count} worker starts for ${item.id}`,
    );
  }
  // Model calls that reached the provider stay bounded: at most one more than
  // an uninterrupted run, and only for the faulted method.
  for (const [call, count] of Object.entries(REFERENCE_CALLS)) {
    const [target, method] = call.split(".");
    if (target !== "model") continue;
    const reached = result.calls.filter(
      (entry) =>
        entry.target === target && entry.method === method && entry.reached,
    ).length;
    const faulted =
      testCase.boundary.target === target &&
      testCase.boundary.method === method;
    assert.ok(
      reached >= count && reached <= count + (faulted ? 1 : 0),
      `${reached} ${call} calls (uninterrupted: ${count})`,
    );
  }
}

/** No run stopped for an operator: only injected crashes interrupt it. */
export function assertNoOperatorStop(result) {
  assert.deepEqual(
    result.runs
      .filter(
        (run) => !["completed", "crashed", "returned"].includes(run.outcome),
      )
      .map((run) => `${run.outcome}: ${run.message ?? run.stderr ?? ""}`),
    [],
  );
}

export const OPERATOR_STOP = "without an operator stop";

/**
 * Declare one scenario as two tests over a single run: the fixed end state,
 * and that no run stopped for an operator on its way there. Known failures
 * are `todo` with their diagnosis: they run and report, but do not fail.
 */
export function declareScenario(name, run, testCase, known) {
  let result;
  const once = () =>
    (result ??= run().then((value) => {
      if (process.env.FACTORY_FAULT_REPORT)
        console.log(
          `FAULT-REPORT ${JSON.stringify({
            suite: basename(process.argv[1] ?? ""),
            name,
            runs: value.runs,
            crashes: value.crashes,
            refused: value.fake.log
              .filter(
                (entry) =>
                  (entry.status >= 400 && entry.status !== 404) ||
                  entry.unhandled,
              )
              .map(
                (entry) =>
                  `${entry.endpoint} → ${entry.status}${entry.fault ? ` (${entry.fault})` : ""}`,
              ),
          })}`,
        );
      return value;
    }));
  const options = (todo) => ({ ...(todo ? { todo } : {}), timeout: 300_000 });
  test(name, options(known[name]), async () =>
    assertCleanOutcome(await once(), testCase),
  );
  const stop = `${name} ${OPERATOR_STOP}`;
  test(stop, options(known[stop]), async () =>
    assertNoOperatorStop(await once()),
  );
}

/**
 * Diagnoses of the known failures (Factory bugs, not test bugs). References
 * like (r1 #4) point at the adversarial review behind #515.
 */
export const DIAGNOSES = {
  GIT_PUSH:
    "git push failures (HTTP 503, or a lost response after the ref moved) are plain Errors, never interruptions: the item fails at deliver with state.error, and a restart refuses the stopped Objective (r1 #2)",
  GIT_FETCH:
    "a failing git fetch (regular: right after the PR merged; native: before the stack merge) is a plain Error outside any repeat: the Objective stops with state.error and a restart refuses it (r1 #2, #8)",
  NATIVE_READS:
    "native delivery's reads outside a Work Item step (defaultBranch at start; PR, check-run, status and readiness observation before the stack merge) are not repeated: one 5xx or connection reset stops the Objective with state.error and a restart refuses it (r1 #8)",
  PLAN_RECOMPILE:
    "a crash or lost response at plan (graph) review compiles the plan again on restart: the compiled candidate is not kept across the review, so the planner is called twice",
  GRAPH_REVIEW_STOP:
    "a lost or unavailable plan (graph) review response stops planning as 'Plan needs a specific human source decision before run' instead of repeating the review",
  PLANNER_STOP:
    "a lost or unavailable planner response stops the run; planning is not repeated in the run, only a manual restart compiles again",
  FINAL_REVIEW:
    "a lost or unavailable final Objective review response sets state.error after every Work Item merged: the final review runs outside any repeat, retry needs a failed item and a restart refuses the stopped Objective (r1 #1)",
  START_AMBIGUOUS:
    "regular delivery: a crash before or after driver.start leaves the item running/execute without a handle, which regular-runner refuses as 'ambiguous active state at execute; operator direction required' (r1 #4)",
  START_REPEAT:
    "driver.start is repeated with the same attempt id after its response was lost (or, native, after a crash): the local driver's `git worktree add` fails because the attempt's worktree exists, and the item fails (r1 #4)",
  COLLECT_REPEAT:
    "driver.collect removes the worktree before the runner records the produced commit: a repeated collect after a lost response or crash fails with 'cannot change to <worktree>' and is recorded as an implementation failure of a worker that succeeded (r1 #5)",
  PROJECTION_STOP:
    "graph projection (labels, issues, dependencies, sub-issues, the marker scan) runs outside any repeat: a lost response, 5xx or 429 stops the run ('GitHub mutation outcome unknown' or 'GitHub request failed') and only a manual restart continues it",
  CLOSURE_PAUSE:
    "issue closure wraps every error, including a 5xx, 403 rate limit or lost response on the completion comment or close, in GitHubClosureFailure and pauses for 'resume to reconcile' instead of repeating (r1 #9)",
  READBACK_LAG:
    "projection reads dependencies and sub-issues back immediately after writing them and throws 'did not reconcile exactly' (a plain Error) when the list lags one read; the run stops until a manual restart",
  MERGE_READ_LAG:
    "RealGitHubGateway.merge reads the PR right after PUT merge and throws a plain Error ('has not confirmed the exact integrated commit') when that read lags: the item fails after its PR merged, and a restart refuses (r3 #3)",
  TIMELINE_LAG:
    "timelineMergeCommit throws a plain Error ('missing or conflicting merge evidence') when the merged event is not on the timeline yet; it is not an interruption, so the item or Objective stops after a successful merge (r3 #3)",
  PULL_LIST_LAG:
    "after a lost POST /pulls, findOpenPullRequest relies on the open-PR list; when the list lags, publish posts again, GitHub answers 422 'A pull request already exists', and the item fails at deliver (r3 #5)",
  ISSUE_LIST_LAG:
    "after a lost POST /issues, the marker scan relies on the issue list; when the list lags, projection creates a second issue for the same Work Item (r3 #6)",
  STACK_MERGE_REPEAT:
    "a lost merge-async response while the stack merge is still pending is repeated as a second PUT merge-async (GitHub: 405 merge already in progress) instead of observing the pending merge, and the Objective stops (r1 #11)",
  SECONDARY_403:
    "a 403 secondary rate limit (even with retry-after) is a GitHubRequestError, not an interruption: PR creation fails the item at deliver and a restart refuses (r1 #7)",
  PRIMARY_403:
    "a 403 primary rate limit (x-ratelimit-remaining: 0) is a GitHubRequestError, not an interruption: PR observation fails the item and a restart refuses; without a reset header the client also stops every later request (r1 #7)",
  BASE_MODIFIED:
    "PUT merge answered 405 'Base branch was modified' (transient on GitHub when merges race) fails the item as a completed rejection instead of repeating the merge (r3 #4)",
  PAGE_SHIFT:
    "the marker scan pages issues?state=all without deduplicating by id: an issue opened between page reads repeats a boundary row, and a Work Item issue on that boundary stops the run as 'Multiple Work Item issues' (r3 #6)",
  FOREIGN_PUSH:
    "a push by another contributor to the default branch after the last merge stops the Objective with state.error ('Default branch changed before final validation') instead of validating the new head; a restart refuses (r1 #1)",
};

/** Expand {diagnosis: [case names]} into {case name: diagnosis}. */
export function todos(groups) {
  const map = {};
  for (const [diagnosis, names] of Object.entries(groups))
    for (const name of names) {
      if (map[name]) throw new Error(`Duplicate known failure: ${name}`);
      map[name] = diagnosis;
    }
  return map;
}

/** A known failure must name a declared scenario (or its operator-stop test). */
export function checkKnown(known, scenarios) {
  const names = new Set(
    scenarios.flatMap((name) => [name, `${name} ${OPERATOR_STOP}`]),
  );
  for (const name of Object.keys(known))
    if (!names.has(name)) throw new Error(`Unknown scenario: ${name}`);
}

/** Declare the matrix for one delivery strategy. */
export function defineMatrix(delivery, known) {
  const cases = matrixCases(delivery);
  checkKnown(
    known,
    cases.map((testCase) => testCase.name),
  );
  describe(`fault matrix: ${delivery} delivery`, {
    concurrency: Math.max(2, Math.floor(availableParallelism() / 2)),
  }, () => {
    declareScenario(
      "uninterrupted run",
      () => runScenario({ name: `reference-${delivery}`, delivery }),
      { boundary: {} },
      {},
    );
    for (const [index, testCase] of cases.entries())
      declareScenario(
        testCase.name,
        () =>
          runScenario({
            name: `${delivery === "regular" ? "r" : "n"}${index}`,
            delivery,
            http: testCase.http ?? [],
            inProcess: testCase.inProcess ?? [],
          }),
        testCase,
        known,
      );
  });
}
