// Known Factory bugs the fault suites reproduce, with their diagnoses. Each
// listed test is inverted: it passes while the bug reproduces and fails once
// the bug is fixed, and then its entry must be removed. References like
// (r1 #4) point at the adversarial review behind #515.

const D = {
  GIT_PUSH: {
    text: "git push failures (HTTP 503, or a lost response after the ref moved) are plain Errors, never interruptions: the item fails at deliver with state.error, and a restart refuses the stopped Objective (r1 #2)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+git -C \S+ push origin [0-9a-f]{40}:refs\/heads\/factory\/objective-\d+\/\w+ failed .*; work=.*\b\w+:failed@deliver\b/,
  },
  GIT_FETCH: {
    text: "a failing git fetch (regular: right after the PR merged; native: before the stack merge) is a plain Error outside any repeat: the Objective stops with state.error and a restart refuses it (r1 #2, #8)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+git -C \S+ fetch .*origin \+refs\/heads\/main:\S+ failed \(128\): fatal: unable to access '[^']+': The requested URL returned error: 503 .*; work=(alpha:failed,beta:pending|alpha:published,beta:published)(;|$)/,
  },
  GIT_FETCH_RESET: {
    text: "a connection reset during git fetch stops the Objective with state.error as the fetch failure, a plain Error outside any repeat (r1 #2). (A git-remote-http helper outliving git no longer reads as an unknown outcome: subprocessAsync stops leftovers after a grace period.)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )*git -C \S+ fetch .*origin \+refs\/heads\/main:\S+ failed \(128\): fatal: unable to access '[^']+': Empty reply from server.*; work=(alpha:failed,beta:pending|alpha:published,beta:published)(;|$)/,
  },
  NATIVE_READS: {
    text: "native delivery's reads outside a Work Item step (defaultBranch at start; PR, check-run, status and readiness observation before the stack merge) are not repeated: one 5xx or connection reset stops the Objective with state.error and a restart refuses it (r1 #8)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+GitHub request failed \(HTTP 50[03]\)\..*; work=(alpha:pending,beta:pending|alpha:published,beta:published)$/,
  },
  START_AMBIGUOUS: {
    text: "regular delivery: a crash before or after driver.start leaves the item running/execute without a handle, which regular-runner refuses as 'ambiguous active state at execute; operator direction required' (r1 #4)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )*Work Item (\w+) has ambiguous active state at execute; operator direction required.*; work=.*\b\2:running@execute\b/,
  },
  START_REPEAT: {
    text: "driver.start is repeated with the same attempt id after its response was lost (or, native, after a crash): the local driver's `git worktree add` fails because the attempt's worktree exists, and the item fails (r1 #4)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+git -C \S+ worktree add --no-checkout --detach \S+ [0-9a-f]{40} failed \(128\): .*already exists.*; work=.*\b\w+:failed@execute\b/,
  },
  COLLECT_REPEAT: {
    text: "driver.collect removes the worktree before the runner records the produced commit: a repeated collect after a lost response or crash fails with 'cannot change to <worktree>' and is recorded as an implementation failure of a worker that succeeded (r1 #5)",
    pattern:
      /^outcome=(stopped|needs-decision); message=.*; work=.*\b(\w+):failed@execute\b.*; failure\[\2\]=git rev-parse HEAD failed \(128\): fatal: cannot change to '[^']+': No such file or directory/,
  },
  MERGE_READ_LAG: {
    text: "RealGitHubGateway.merge reads the PR right after PUT merge and throws a plain Error ('has not confirmed the exact integrated commit') when that read lags: the item fails after its PR merged, and a restart refuses (r3 #3)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+PR merge has not confirmed the exact integrated commit\..*; work=alpha:failed,beta:pending(;|$)/,
  },
  TIMELINE_LAG: {
    text: "timelineMergeCommit throws a plain Error ('missing or conflicting merge evidence') when the merged event is not on the timeline yet; it is not an interruption, so the item or Objective stops after a successful merge (r3 #3)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+PR #\d+ has missing or conflicting merge evidence\..*; work=(alpha:published,beta:published|alpha:failed,beta:pending)(;|$)/,
  },
  PULL_LIST_LAG: {
    text: "after a lost POST /pulls, findOpenPullRequest relies on the open-PR list; when the list lags, publish posts again, GitHub answers 422 'A pull request already exists', and the item fails at deliver (r3 #5)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+GitHub request failed \(HTTP 422\)\..*; work=alpha:failed@deliver,beta:pending(;|$)/,
  },
  STACK_MERGE_REPEAT: {
    text: "a lost merge-async response while the stack merge is still pending: the repeat sends PUT merge-async again, GitHub answers 409 with the pending request's uuid, and Factory treats that as a rejection instead of resuming the pending uuid; the Objective stops (r1 #11)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+GitHub request failed \(HTTP 409\)\..*; work=alpha:published,beta:published$/,
  },
  SECONDARY_403: {
    text: "a 403 secondary rate limit (even with retry-after) is a GitHubRequestError, not an interruption: PR creation fails the item at deliver and a restart refuses (r1 #7)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+GitHub request failed \(HTTP 403\)\..*; work=alpha:failed@deliver,beta:pending(;|$)/,
  },
  PRIMARY_403: {
    text: "a 403 primary rate limit (x-ratelimit-remaining: 0, with a reset) is a GitHubRequestError, not an interruption: PR observation fails the item and a restart refuses (r1 #7)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+GitHub request failed \(HTTP 403\)\..*; work=(alpha:failed,beta:pending|alpha:published,beta:published)(;|$)/,
  },
  BASE_MODIFIED: {
    text: "PUT merge answered 405 'Base branch was modified' (transient on GitHub when merges race) fails the item as a completed rejection instead of repeating the merge (r3 #4)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+GitHub request failed \(HTTP 405\)\..*; work=alpha:failed,beta:pending(;|$)/,
  },
};

export const DIAGNOSES = D;

/**
 * Expand {DIAGNOSIS_KEY: [test names]} into {test name: {key, text, pattern}}.
 * An inverted known test passes only when its check fails with a message
 * matching the diagnosis pattern; any other failure fails the test. Racy
 * entries may also pass. Both kinds share one duplicate check.
 */
export function todos(groups, racy = {}) {
  const map = {};
  for (const [entries, isRacy] of [
    [groups, false],
    [racy, true],
  ])
    for (const [key, names] of Object.entries(entries)) {
      if (!D[key]) throw new Error(`Unknown diagnosis: ${key}`);
      for (const name of names) {
        if (map[name]) throw new Error(`Duplicate known failure: ${name}`);
        map[name] = { key, ...D[key], ...(isRacy ? { racy: true } : {}) };
      }
    }
  return map;
}

// Racy known failures: regular-runner calls phases.release(alpha) before
// `await closeWorkItem(alpha)`, which wakes the scheduler, so beta is
// checkpointed at running/execute and its driver.start begins while alpha's
// completion comment and close are in flight. A crash during alpha's closure
// sometimes lands between beta's checkpoint and its driver handle
// (START_AMBIGUOUS). The race predates #543 (same code at 3fbea270) and shows
// on slower CI runners. These tests must pass, or fail for exactly this reason.
const RACY_CLOSURE_START = ["crash-before", "crash-after"].flatMap((kind) =>
  [
    "POST /repos/{owner}/{repo}/issues/{number}/comments #1",
    "PATCH /repos/{owner}/{repo}/issues/{number} #1",
  ].flatMap((boundary) =>
    ["", " without an operator stop"].map(
      (suffix) => `${kind} at ${boundary}${suffix}`,
    ),
  ),
);

export const KNOWN = {
  regular: todos(
    {
      GIT_PUSH: [
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
      GIT_FETCH: [
        "unavailable at GIT fetch-advertise #1",
        "unavailable at GIT fetch-advertise #1 without an operator stop",
      ],
      GIT_FETCH_RESET: [
        "reset at GIT fetch-advertise #1",
        "reset at GIT fetch-advertise #1 without an operator stop",
      ],
      START_AMBIGUOUS: [
        "crash-before at driver.start #1",
        "crash-before at driver.start #1 without an operator stop",
        "crash-before at driver.start #2",
        "crash-before at driver.start #2 without an operator stop",
        "crash-after at driver.start #1",
        "crash-after at driver.start #1 without an operator stop",
        "crash-after at driver.start #2",
        "crash-after at driver.start #2 without an operator stop",
      ],
      START_REPEAT: [
        "lost at driver.start #1",
        "lost at driver.start #1 without an operator stop",
        "lost at driver.start #2",
        "lost at driver.start #2 without an operator stop",
      ],
      COLLECT_REPEAT: [
        "lost at driver.collect #1",
        "lost at driver.collect #1 without an operator stop",
        "lost at driver.collect #2",
        "lost at driver.collect #2 without an operator stop",
        "crash-after at driver.collect #1",
        "crash-after at driver.collect #1 without an operator stop",
        "crash-after at driver.collect #2",
        "crash-after at driver.collect #2 without an operator stop",
      ],
    },
    { START_AMBIGUOUS: RACY_CLOSURE_START },
  ),
  "native-stack": todos({
    NATIVE_READS: [
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
    GIT_PUSH: [
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
    GIT_FETCH: [
      "unavailable at GIT fetch-advertise #1",
      "unavailable at GIT fetch-advertise #1 without an operator stop",
    ],
    GIT_FETCH_RESET: [
      "reset at GIT fetch-advertise #1",
      "reset at GIT fetch-advertise #1 without an operator stop",
    ],
    START_REPEAT: [
      "lost at driver.start #1",
      "lost at driver.start #1 without an operator stop",
      "lost at driver.start #2",
      "lost at driver.start #2 without an operator stop",
      "crash-after at driver.start #1",
      "crash-after at driver.start #1 without an operator stop",
      "crash-after at driver.start #2",
      "crash-after at driver.start #2 without an operator stop",
    ],
    COLLECT_REPEAT: [
      "lost at driver.collect #1",
      "lost at driver.collect #1 without an operator stop",
      "lost at driver.collect #2",
      "lost at driver.collect #2 without an operator stop",
      "crash-after at driver.collect #1",
      "crash-after at driver.collect #1 without an operator stop",
      "crash-after at driver.collect #2",
      "crash-after at driver.collect #2 without an operator stop",
    ],
  }),
  consistency: todos({
    MERGE_READ_LAG: [
      "regular: PR state lags one read after a merge",
      "regular: PR state lags one read after a merge without an operator stop",
    ],
    TIMELINE_LAG: [
      "native-stack: timeline lags one read after a merge",
      "native-stack: timeline lags one read after a merge without an operator stop",
      "regular: lost merge response, then the timeline lags one read",
      "regular: lost merge response, then the timeline lags one read without an operator stop",
    ],
    PULL_LIST_LAG: [
      "regular: lost PR creation, then the open-PR list lags one read",
      "regular: lost PR creation, then the open-PR list lags one read without an operator stop",
      "native-stack: lost PR creation, then the open-PR list lags one read",
      "native-stack: lost PR creation, then the open-PR list lags one read without an operator stop",
    ],
    STACK_MERGE_REPEAT: [
      "native-stack: lost stack merge response while the merge is still pending",
      "native-stack: lost stack merge response while the merge is still pending without an operator stop",
    ],
    SECONDARY_403: [
      "regular: 403 secondary rate limit with retry-after on PR creation",
      "regular: 403 secondary rate limit with retry-after on PR creation without an operator stop",
      "native-stack: 403 secondary rate limit with retry-after on PR creation",
      "native-stack: 403 secondary rate limit with retry-after on PR creation without an operator stop",
    ],
    PRIMARY_403: [
      "regular: 403 primary rate limit with a reset on PR observation",
      "regular: 403 primary rate limit with a reset on PR observation without an operator stop",
      "native-stack: 403 primary rate limit with a reset on PR observation",
      "native-stack: 403 primary rate limit with a reset on PR observation without an operator stop",
    ],
    BASE_MODIFIED: [
      "regular: 405 base branch modified on merge",
      "regular: 405 base branch modified on merge without an operator stop",
    ],
  }),
};
