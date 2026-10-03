// Known Factory bugs the fault suites reproduce, with their diagnoses. Each
// listed test is inverted: it passes while the bug reproduces and fails once
// the bug is fixed, and then its entry must be removed. References like
// (r1 #4) point at the adversarial review behind #515.
import { todos } from "./fault-matrix.mjs";

const D = {
  GIT_PUSH:
    "git push failures (HTTP 503, or a lost response after the ref moved) are plain Errors, never interruptions: the item fails at deliver with state.error, and a restart refuses the stopped Objective (r1 #2)",
  GIT_FETCH:
    "a failing git fetch (regular: right after the PR merged; native: before the stack merge) is a plain Error outside any repeat: the Objective stops with state.error and a restart refuses it (r1 #2, #8)",
  NATIVE_READS:
    "native delivery's reads outside a Work Item step (defaultBranch at start; PR, check-run, status and readiness observation before the stack merge) are not repeated: one 5xx or connection reset stops the Objective with state.error and a restart refuses it (r1 #8)",
  GRAPH_REVIEW_DECISION:
    "a lost or unavailable plan (graph) review response is treated as an invalid independent review: the planner compiles a revision, and the persisted plan then waits for a human 'accept despite the invalid independent review' decision on every restart instead of repeating the review",
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
    "a lost merge-async response while the stack merge is still pending: the repeat sends PUT merge-async again, GitHub answers 409 with the pending request's uuid, and Factory treats that as a rejection instead of resuming the pending uuid; the Objective stops (r1 #11)",
  SECONDARY_403:
    "a 403 secondary rate limit (even with retry-after) is a GitHubRequestError, not an interruption: PR creation fails the item at deliver and a restart refuses (r1 #7)",
  PRIMARY_403:
    "a 403 primary rate limit (x-ratelimit-remaining: 0, with a reset) is a GitHubRequestError, not an interruption: PR observation fails the item and a restart refuses (r1 #7)",
  BASE_MODIFIED:
    "PUT merge answered 405 'Base branch was modified' (transient on GitHub when merges race) fails the item as a completed rejection instead of repeating the merge (r3 #4)",
  PAGE_SHIFT:
    "the marker scan pages issues?state=all without deduplicating by id: an issue opened between page reads repeats a boundary row, and a Work Item issue on that boundary stops the run as 'Multiple Work Item issues' (r3 #6)",
  FOREIGN_PUSH:
    "a push by another contributor to the default branch after the last merge stops the Objective with state.error ('Default branch changed before final validation') instead of validating the new head; a restart refuses (r1 #1)",
};

export const DIAGNOSES = D;

export const KNOWN = {
  regular: todos({
    [D.PROJECTION_STOP]: [
      "unavailable at GET /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/labels #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/labels #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/labels #2 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/labels #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues #2 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/parent #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #2 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/labels #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/labels #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/labels #2 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/labels #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues #2 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/parent #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #2 without an operator stop",
    ],
    [D.GIT_PUSH]: [
      "unavailable at GIT push-advertise #1",
      "unavailable at GIT push-advertise #1 without an operator stop",
      "lost at GIT push #1",
      "lost at GIT push #1 without an operator stop",
      "lost at GIT push #2",
      "lost at GIT push #2 without an operator stop",
      "reset at GIT push-advertise #1",
      "reset at GIT push-advertise #1 without an operator stop",
      "unavailable at GIT push #1",
      "unavailable at GIT push #1 without an operator stop",
      "unavailable at GIT push #2",
      "unavailable at GIT push #2 without an operator stop",
    ],
    [D.GIT_FETCH]: [
      "unavailable at GIT fetch-advertise #1",
      "unavailable at GIT fetch-advertise #1 without an operator stop",
      "reset at GIT fetch-advertise #1",
      "reset at GIT fetch-advertise #1 without an operator stop",
    ],
    [D.CLOSURE_PAUSE]: [
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "lost at PATCH /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/comments #2 without an operator stop",
      "lost at PATCH /repos/{owner}/{repo}/issues/{number} #2 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/comments #3 without an operator stop",
      "lost at PATCH /repos/{owner}/{repo}/issues/{number} #3 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "unavailable at PATCH /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/comments #2 without an operator stop",
      "unavailable at PATCH /repos/{owner}/{repo}/issues/{number} #2 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/comments #3 without an operator stop",
      "unavailable at PATCH /repos/{owner}/{repo}/issues/{number} #3 without an operator stop",
    ],
    [D.PLANNER_STOP]: [
      "lost at model.generateStructured #1 without an operator stop",
      "unavailable at model.generateStructured #1 without an operator stop",
    ],
    [D.GRAPH_REVIEW_DECISION]: [
      "lost at model.reviewGraph #1",
      "lost at model.reviewGraph #1 without an operator stop",
      "lost at model.reviewGraph #1 compiles the plan once",
      "unavailable at model.reviewGraph #1",
      "unavailable at model.reviewGraph #1 without an operator stop",
      "unavailable at model.reviewGraph #1 compiles the plan once",
    ],
    [D.START_AMBIGUOUS]: [
      "crash-before at driver.start #1",
      "crash-before at driver.start #1 without an operator stop",
      "crash-before at driver.start #2",
      "crash-before at driver.start #2 without an operator stop",
      "crash-after at driver.start #1",
      "crash-after at driver.start #1 without an operator stop",
      "crash-after at driver.start #2",
      "crash-after at driver.start #2 without an operator stop",
    ],
    [D.START_REPEAT]: [
      "lost at driver.start #1",
      "lost at driver.start #1 without an operator stop",
      "lost at driver.start #2",
      "lost at driver.start #2 without an operator stop",
    ],
    [D.COLLECT_REPEAT]: [
      "lost at driver.collect #1",
      "lost at driver.collect #1 without an operator stop",
      "lost at driver.collect #2",
      "lost at driver.collect #2 without an operator stop",
      "crash-after at driver.collect #1",
      "crash-after at driver.collect #1 without an operator stop",
      "crash-after at driver.collect #2",
      "crash-after at driver.collect #2 without an operator stop",
    ],
    [D.FINAL_REVIEW]: [
      "lost at model.reviewResult #3",
      "lost at model.reviewResult #3 without an operator stop",
      "unavailable at model.reviewResult #3",
      "unavailable at model.reviewResult #3 without an operator stop",
    ],
  }),
  "native-stack": todos({
    [D.PROJECTION_STOP]: [
      "unavailable at GET /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/labels #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/labels #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/labels #2 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/labels #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues #2 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/parent #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #2 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/labels #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/labels #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/labels #2 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/labels #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues #2 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/parent #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/sub_issues #2 without an operator stop",
    ],
    [D.NATIVE_READS]: [
      "unavailable at GET /repos/{owner}/{repo} #1",
      "unavailable at GET /repos/{owner}/{repo} #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/pulls/{number} #1",
      "unavailable at GET /repos/{owner}/{repo}/pulls/{number} #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/commits/{sha}/check-runs #1",
      "unavailable at GET /repos/{owner}/{repo}/commits/{sha}/check-runs #1 without an operator stop",
      "unavailable at GET /repos/{owner}/{repo}/commits/{sha}/status #1",
      "unavailable at GET /repos/{owner}/{repo}/commits/{sha}/status #1 without an operator stop",
      "unavailable at POST /graphql #1",
      "unavailable at POST /graphql #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo} #1",
      "reset at GET /repos/{owner}/{repo} #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/pulls/{number} #1",
      "reset at GET /repos/{owner}/{repo}/pulls/{number} #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/commits/{sha}/check-runs #1",
      "reset at GET /repos/{owner}/{repo}/commits/{sha}/check-runs #1 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/commits/{sha}/status #1",
      "reset at GET /repos/{owner}/{repo}/commits/{sha}/status #1 without an operator stop",
      "reset at POST /graphql #1",
      "reset at POST /graphql #1 without an operator stop",
    ],
    [D.GIT_PUSH]: [
      "unavailable at GIT push-advertise #1",
      "unavailable at GIT push-advertise #1 without an operator stop",
      "lost at GIT push #1",
      "lost at GIT push #1 without an operator stop",
      "lost at GIT push #2",
      "lost at GIT push #2 without an operator stop",
      "reset at GIT push-advertise #1",
      "reset at GIT push-advertise #1 without an operator stop",
      "unavailable at GIT push #1",
      "unavailable at GIT push #1 without an operator stop",
      "unavailable at GIT push #2",
      "unavailable at GIT push #2 without an operator stop",
    ],
    [D.GIT_FETCH]: [
      "unavailable at GIT fetch-advertise #1",
      "unavailable at GIT fetch-advertise #1 without an operator stop",
      "reset at GIT fetch-advertise #1",
      "reset at GIT fetch-advertise #1 without an operator stop",
    ],
    [D.CLOSURE_PAUSE]: [
      "unavailable at GET /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "lost at PATCH /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/comments #2 without an operator stop",
      "lost at PATCH /repos/{owner}/{repo}/issues/{number} #2 without an operator stop",
      "lost at POST /repos/{owner}/{repo}/issues/{number}/comments #3 without an operator stop",
      "lost at PATCH /repos/{owner}/{repo}/issues/{number} #3 without an operator stop",
      "reset at GET /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/comments #1 without an operator stop",
      "unavailable at PATCH /repos/{owner}/{repo}/issues/{number} #1 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/comments #2 without an operator stop",
      "unavailable at PATCH /repos/{owner}/{repo}/issues/{number} #2 without an operator stop",
      "unavailable at POST /repos/{owner}/{repo}/issues/{number}/comments #3 without an operator stop",
      "unavailable at PATCH /repos/{owner}/{repo}/issues/{number} #3 without an operator stop",
    ],
    [D.PLANNER_STOP]: [
      "lost at model.generateStructured #1 without an operator stop",
      "unavailable at model.generateStructured #1 without an operator stop",
    ],
    [D.GRAPH_REVIEW_DECISION]: [
      "lost at model.reviewGraph #1",
      "lost at model.reviewGraph #1 without an operator stop",
      "lost at model.reviewGraph #1 compiles the plan once",
      "unavailable at model.reviewGraph #1",
      "unavailable at model.reviewGraph #1 without an operator stop",
      "unavailable at model.reviewGraph #1 compiles the plan once",
    ],
    [D.START_REPEAT]: [
      "lost at driver.start #1",
      "lost at driver.start #1 without an operator stop",
      "lost at driver.start #2",
      "lost at driver.start #2 without an operator stop",
      "crash-after at driver.start #1",
      "crash-after at driver.start #1 without an operator stop",
      "crash-after at driver.start #2",
      "crash-after at driver.start #2 without an operator stop",
    ],
    [D.COLLECT_REPEAT]: [
      "lost at driver.collect #1",
      "lost at driver.collect #1 without an operator stop",
      "lost at driver.collect #2",
      "lost at driver.collect #2 without an operator stop",
      "crash-after at driver.collect #1",
      "crash-after at driver.collect #1 without an operator stop",
      "crash-after at driver.collect #2",
      "crash-after at driver.collect #2 without an operator stop",
    ],
    [D.FINAL_REVIEW]: [
      "lost at model.reviewResult #3",
      "lost at model.reviewResult #3 without an operator stop",
      "unavailable at model.reviewResult #3",
      "unavailable at model.reviewResult #3 without an operator stop",
    ],
  }),
  consistency: todos({
    [D.MERGE_READ_LAG]: [
      "regular: PR state lags one read after a merge",
      "regular: PR state lags one read after a merge without an operator stop",
    ],
    [D.TIMELINE_LAG]: [
      "native-stack: timeline lags one read after a merge",
      "native-stack: timeline lags one read after a merge without an operator stop",
      "regular: lost merge response, then the timeline lags one read",
      "regular: lost merge response, then the timeline lags one read without an operator stop",
    ],
    [D.PULL_LIST_LAG]: [
      "regular: lost PR creation, then the open-PR list lags one read",
      "regular: lost PR creation, then the open-PR list lags one read without an operator stop",
      "native-stack: lost PR creation, then the open-PR list lags one read",
      "native-stack: lost PR creation, then the open-PR list lags one read without an operator stop",
    ],
    [D.ISSUE_LIST_LAG]: [
      "regular: lost issue creation, then the issue list lags one read",
      "native-stack: lost issue creation, then the issue list lags one read",
    ],
    [D.PROJECTION_STOP]: [
      "regular: lost issue creation, then the issue list lags one read without an operator stop",
      "native-stack: lost issue creation, then the issue list lags one read without an operator stop",
      "regular: 429 with retry-after on issue creation without an operator stop",
      "native-stack: 429 with retry-after on issue creation without an operator stop",
    ],
    [D.READBACK_LAG]: [
      "regular: sub-issue list lags one read after a sub-issue is added without an operator stop",
      "native-stack: sub-issue list lags one read after a sub-issue is added without an operator stop",
      "regular: dependency list lags one read after a dependency is added without an operator stop",
      "native-stack: dependency list lags one read after a dependency is added without an operator stop",
    ],
    [D.STACK_MERGE_REPEAT]: [
      "native-stack: lost stack merge response while the merge is still pending",
      "native-stack: lost stack merge response while the merge is still pending without an operator stop",
    ],
    [D.SECONDARY_403]: [
      "regular: 403 secondary rate limit with retry-after on PR creation",
      "regular: 403 secondary rate limit with retry-after on PR creation without an operator stop",
      "native-stack: 403 secondary rate limit with retry-after on PR creation",
      "native-stack: 403 secondary rate limit with retry-after on PR creation without an operator stop",
    ],
    [D.CLOSURE_PAUSE]: [
      "regular: 403 secondary rate limit without retry-after on a completion comment without an operator stop",
    ],
    [D.PRIMARY_403]: [
      "regular: 403 primary rate limit with a reset on PR observation",
      "regular: 403 primary rate limit with a reset on PR observation without an operator stop",
      "native-stack: 403 primary rate limit with a reset on PR observation",
      "native-stack: 403 primary rate limit with a reset on PR observation without an operator stop",
    ],
    [D.BASE_MODIFIED]: [
      "regular: 405 base branch modified on merge",
      "regular: 405 base branch modified on merge without an operator stop",
    ],
    [D.PAGE_SHIFT]: [
      "regular: an issue opened during the marker scan shifts its pages without an operator stop",
    ],
    [D.FOREIGN_PUSH]: [
      "regular: another contributor pushes to the default branch after the last merge",
      "regular: another contributor pushes to the default branch after the last merge without an operator stop",
      "native-stack: another contributor pushes to the default branch after the last merge",
      "native-stack: another contributor pushes to the default branch after the last merge without an operator stop",
    ],
  }),
};

// Racy known failures: regular-runner calls phases.release(alpha) before
// `await closeWorkItem(alpha)`, which wakes the scheduler, so beta is
// checkpointed at running/execute and its driver.start begins while alpha's
// completion comment and close are in flight. A crash during alpha's closure
// sometimes lands between beta's checkpoint and its driver handle
// (START_AMBIGUOUS). The race predates #543 (same code at 3fbea270) and shows
// on slower CI runners. These tests must pass, or fail for exactly this reason.
const racyStart = {
  diagnosis: D.START_AMBIGUOUS,
  pattern: /ambiguous active state at execute/,
};
for (const kind of ["crash-before", "crash-after"])
  for (const boundary of [
    "POST /repos/{owner}/{repo}/issues/{number}/comments #1",
    "PATCH /repos/{owner}/{repo}/issues/{number} #1",
  ])
    for (const suffix of ["", " without an operator stop"])
      KNOWN.regular[`${kind} at ${boundary}${suffix}`] = racyStart;
