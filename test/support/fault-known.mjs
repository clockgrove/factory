// Known Factory bugs the fault suites reproduce, with their diagnoses. Each
// listed test is inverted: it passes while the bug reproduces and fails once
// the bug is fixed, and then its entry must be removed. References like
// (r1 #4) point at the adversarial review behind #515.

const D = {
  PLANNER_STOP: {
    text: "a lost or unavailable planner response stops the run; planning is not repeated in the run, only a manual restart compiles again",
    pattern:
      /^outcome=stopped; message=(socket hang up|503 Service Unavailable); work=none$/,
  },
  FINAL_REVIEW: {
    text: "a lost or unavailable final Objective review response sets state.error after every Work Item merged: the final review runs outside any repeat, retry needs a failed item and a restart refuses the stopped Objective (r1 #1)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+(socket hang up|503 Service Unavailable)\..*; work=alpha:done,beta:done$/,
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
  PROJECTION_STOP: {
    text: "graph projection (labels, issues, dependencies, sub-issues, the marker scan) runs outside any repeat: a lost response, 5xx or 429 stops the run ('GitHub mutation outcome unknown' or 'GitHub request failed') and only a manual restart continues it",
    pattern:
      /^outcome=stopped; message=(GitHub mutation outcome unknown; reconcile authenticated evidence before retrying|GitHub request failed \(HTTP (5\d\d|429)\)); work=none$/,
  },
  CLOSURE_PAUSE: {
    text: "issue closure wraps every error, including a 5xx, 403 rate limit or lost response on the completion comment or close, in GitHubClosureFailure and pauses for 'resume to reconcile' instead of repeating (r1 #9)",
    pattern:
      /^outcome=stopped; message=(Work Item \w+|Objective #\d+): GitHub (mutation outcome unknown; reconcile authenticated evidence before retrying|request failed \(HTTP (5\d\d|403)\)); work=alpha:done,beta:done(;|$)/,
  },
  READBACK_LAG: {
    text: "projection reads dependencies and sub-issues back immediately after writing them and throws 'did not reconcile exactly' (a plain Error) when the list lags one read; the run stops until a manual restart",
    pattern:
      /^outcome=stopped; message=Work Item (hierarchy|dependencies) did not reconcile exactly; work=none$/,
  },
  ISSUE_LIST_LAG: {
    text: "after a lost POST /issues, the marker scan relies on the issue list; when the list lags, projection creates a second issue for the same Work Item (r3 #6)",
    pattern: /^Work Item \w+ has [2-9] issues with its marker\n/,
  },
  PAGE_SHIFT: {
    text: "the marker scan pages issues?state=all without deduplicating by id: an issue opened between page reads repeats a boundary row, and a Work Item issue on that boundary stops the run as 'Multiple Work Item issues' (r3 #6)",
    pattern:
      /^outcome=stopped; message=Multiple Work Item issues for \w+; operator direction required; work=none$/,
  },
  FOREIGN_PUSH: {
    text: "a push by another contributor to the default branch after the last merge stops the Objective with state.error ('Default branch changed before final validation') instead of validating the new head; a restart refuses (r1 #1)",
    pattern:
      /^outcome=stopped; message=(Objective stopped: )+Default branch changed before final validation: expected [0-9a-f]{40}, observed [0-9a-f]{40}\..*; work=alpha:done,beta:done$/,
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
      PROJECTION_STOP: [
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
      CLOSURE_PAUSE: [
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
      PLANNER_STOP: [
        "lost at model.generateStructured #1 without an operator stop",
        "unavailable at model.generateStructured #1 without an operator stop",
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
      FINAL_REVIEW: [
        "lost at model.reviewResult #3",
        "lost at model.reviewResult #3 without an operator stop",
        "unavailable at model.reviewResult #3",
        "unavailable at model.reviewResult #3 without an operator stop",
      ],
    },
    { START_AMBIGUOUS: RACY_CLOSURE_START },
  ),
  "native-stack": todos({
    PROJECTION_STOP: [
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
    CLOSURE_PAUSE: [
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
    PLANNER_STOP: [
      "lost at model.generateStructured #1 without an operator stop",
      "unavailable at model.generateStructured #1 without an operator stop",
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
    FINAL_REVIEW: [
      "lost at model.reviewResult #3",
      "lost at model.reviewResult #3 without an operator stop",
      "unavailable at model.reviewResult #3",
      "unavailable at model.reviewResult #3 without an operator stop",
    ],
  }),
  consistency: todos({
    ISSUE_LIST_LAG: [
      "regular: lost issue creation, then the issue list lags one read",
      "native-stack: lost issue creation, then the issue list lags one read",
    ],
    PROJECTION_STOP: [
      "regular: lost issue creation, then the issue list lags one read without an operator stop",
      "native-stack: lost issue creation, then the issue list lags one read without an operator stop",
      "regular: 429 with retry-after on issue creation without an operator stop",
      "native-stack: 429 with retry-after on issue creation without an operator stop",
    ],
    READBACK_LAG: [
      "regular: sub-issue list lags one read after a sub-issue is added without an operator stop",
      "native-stack: sub-issue list lags one read after a sub-issue is added without an operator stop",
      "regular: dependency list lags one read after a dependency is added without an operator stop",
      "native-stack: dependency list lags one read after a dependency is added without an operator stop",
    ],
    CLOSURE_PAUSE: [
      "regular: 403 secondary rate limit without retry-after on a completion comment without an operator stop",
    ],
    PAGE_SHIFT: [
      "regular: an issue opened during the marker scan shifts its pages without an operator stop",
    ],
    FOREIGN_PUSH: [
      "regular: another contributor pushes to the default branch after the last merge",
      "regular: another contributor pushes to the default branch after the last merge without an operator stop",
      "native-stack: another contributor pushes to the default branch after the last merge",
      "native-stack: another contributor pushes to the default branch after the last merge without an operator stop",
    ],
  }),
};
