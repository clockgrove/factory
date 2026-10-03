import { availableParallelism } from "node:os";
import { describe } from "node:test";
import { faults } from "./support/github-http-fake.mjs";
import { runScenario } from "./support/fault-harness.mjs";
import {
  DIAGNOSES as D,
  checkKnown,
  declareScenario,
  todos,
} from "./support/fault-matrix.mjs";

// Real-GitHub behaviors the fault matrix does not cover: read-after-write lag,
// rate limits, merge refusals, pagination and other actors. Every scenario
// must reach the same fixed outcome as an uninterrupted run (see
// assertCleanOutcome). Known Factory bugs are `todo` with their diagnosis.

const repo = "/repos/{owner}/{repo}";
const PULL = `GET ${repo}/pulls/{number}`;
const MERGE = `PUT ${repo}/pulls/{number}/merge`;
const MERGE_ASYNC = `PUT ${repo}/pulls/{number}/merge-async`;
const CREATE_PULL = `POST ${repo}/pulls`;
const ISSUES = `GET ${repo}/issues`;
const CREATE_ISSUE = `POST ${repo}/issues`;

const BOTH = ["regular", "native-stack"];
const pushForeign = (fake) => fake.pushForeignCommit();

const scenarios = [
  {
    name: "PR state lags one read after a merge",
    deliveries: ["regular"],
    fake: { lag: [{ read: PULL, after: MERGE, reads: 1 }] },
  },
  {
    name: "PR state lags one read after a stack merge",
    deliveries: ["native-stack"],
    fake: { lag: [{ read: PULL, after: MERGE_ASYNC, reads: 1 }] },
  },
  {
    name: "timeline lags one read after a merge",
    deliveries: ["native-stack"],
    fake: {
      lag: [
        {
          read: `GET ${repo}/issues/{number}/timeline`,
          after: MERGE_ASYNC,
          reads: 1,
        },
      ],
    },
  },
  {
    name: "lost merge response, then the timeline lags one read",
    deliveries: ["regular"],
    http: [{ match: MERGE, kind: "drop" }],
    fake: {
      lag: [
        {
          read: `GET ${repo}/issues/{number}/timeline`,
          after: MERGE,
          reads: 1,
        },
      ],
    },
  },
  {
    name: "lost PR creation, then the open-PR list lags one read",
    deliveries: BOTH,
    http: [{ match: CREATE_PULL, kind: "drop" }],
    fake: {
      lag: [{ read: `GET ${repo}/pulls`, after: CREATE_PULL, reads: 1 }],
    },
  },
  {
    name: "lost issue creation, then the issue list lags one read",
    deliveries: BOTH,
    http: [{ match: CREATE_ISSUE, kind: "drop" }],
    fake: { lag: [{ read: ISSUES, after: CREATE_ISSUE, reads: 1 }] },
  },
  {
    name: "sub-issue list lags one read after a sub-issue is added",
    deliveries: BOTH,
    fake: {
      lag: [
        {
          read: `GET ${repo}/issues/{number}/sub_issues`,
          after: `POST ${repo}/issues/{number}/sub_issues`,
          reads: 1,
        },
      ],
    },
  },
  {
    name: "dependency list lags one read after a dependency is added",
    deliveries: BOTH,
    fake: {
      lag: [
        {
          read: `GET ${repo}/issues/{number}/dependencies/blocked_by`,
          after: `POST ${repo}/issues/{number}/dependencies/blocked_by`,
          reads: 1,
        },
      ],
    },
  },
  {
    name: "mergeability is UNKNOWN for the first two readiness reads",
    deliveries: BOTH,
    fake: { readinessUnknownReads: 2 },
  },
  {
    name: "stack merge stays pending for three polls",
    deliveries: ["native-stack"],
    fake: { asyncMergePolls: 3 },
  },
  {
    name: "lost stack merge response while the merge is still pending",
    deliveries: ["native-stack"],
    fake: { asyncMergePolls: 3 },
    http: [{ match: MERGE_ASYNC, kind: "drop" }],
  },
  {
    name: "429 with retry-after on issue creation",
    deliveries: BOTH,
    http: [{ match: CREATE_ISSUE, ...faults.rateLimited({ retryAfter: 1 }) }],
  },
  {
    name: "403 secondary rate limit with retry-after on PR creation",
    deliveries: BOTH,
    http: [
      { match: CREATE_PULL, ...faults.secondaryRateLimit({ retryAfter: 1 }) },
    ],
  },
  {
    name: "403 secondary rate limit without retry-after on a completion comment",
    deliveries: ["regular"],
    http: [
      {
        match: `POST ${repo}/issues/{number}/comments`,
        ...faults.secondaryRateLimit(),
      },
    ],
  },
  {
    name: "403 primary rate limit with a reset on PR observation",
    deliveries: BOTH,
    http: [{ match: PULL, ...faults.primaryRateLimit({ resetInSeconds: 1 }) }],
  },
  {
    name: "403 primary rate limit without a reset header",
    deliveries: ["regular"],
    http: [{ match: PULL, ...faults.primaryRateLimit() }],
  },
  {
    name: "405 base branch modified on merge",
    deliveries: ["regular"],
    http: [{ match: MERGE, ...faults.baseModified() }],
  },
  {
    name: "a repository with 150 earlier issues paginates the marker scan",
    deliveries: BOTH,
    earlierIssues: 150,
  },
  {
    name: "an issue opened during the marker scan shifts its pages",
    deliveries: ["regular"],
    // The first run creates alpha's issue and crashes before the response;
    // 99 newer issues put alpha last on page 1 of the restart's scan, and an
    // issue opened between the page reads moves it to page 2 as well.
    http: [
      { match: CREATE_ISSUE, kind: "crash-after" },
      {
        match: ISSUES,
        occurrence: 2,
        kind: "after",
        run: (fake) => fake.openForeignIssue(),
      },
    ],
    beforeRun: (fake, index) => {
      if (index === 1)
        for (let count = 0; count < 99; count++) fake.openForeignIssue();
    },
    foreignIssues: 100,
  },
  {
    name: "another contributor pushes to the default branch after the first merge",
    deliveries: ["regular"],
    http: [{ match: MERGE, kind: "after", run: pushForeign }],
  },
  {
    name: "another contributor pushes to the default branch after the last merge",
    deliveries: BOTH,
    // The last merge: beta's PR in regular delivery, the stack in native.
    http: (delivery) => [
      delivery === "regular"
        ? { match: MERGE, occurrence: 2, kind: "after", run: pushForeign }
        : { match: MERGE_ASYNC, kind: "after", run: pushForeign },
    ],
  },
];

const known = todos({
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
    "regular: 403 primary rate limit without a reset header",
    "regular: 403 primary rate limit without a reset header without an operator stop",
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
});

checkKnown(
  known,
  scenarios.flatMap((scenario) =>
    scenario.deliveries.map((delivery) => `${delivery}: ${scenario.name}`),
  ),
);

describe("GitHub consistency, rate limits and other actors", {
  concurrency: Math.max(2, Math.floor(availableParallelism() / 2)),
}, () => {
  for (const [index, scenario] of scenarios.entries())
    for (const delivery of scenario.deliveries)
      declareScenario(
        `${delivery}: ${scenario.name}`,
        () =>
          runScenario({
            name: `c${index}-${delivery === "regular" ? "r" : "n"}`,
            delivery,
            http:
              typeof scenario.http === "function"
                ? scenario.http(delivery)
                : (scenario.http ?? []),
            fake: scenario.fake ?? {},
            beforeRun: scenario.beforeRun,
            earlierIssues: scenario.earlierIssues ?? 0,
          }),
        {
          boundary: {},
          foreignIssues: scenario.foreignIssues ?? scenario.earlierIssues ?? 0,
        },
        known,
      );
});
