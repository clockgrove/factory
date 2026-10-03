import { availableParallelism } from "node:os";
import { describe } from "node:test";
import { faults } from "./support/github-http-fake.mjs";
import { runScenario } from "./support/fault-harness.mjs";
import { declareScenario } from "./support/fault-matrix.mjs";

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
    http: [
      { match: CREATE_ISSUE, ...faults.rateLimited({ retryAfter: 1 }) },
    ],
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
    name: "another contributor pushes to the default branch after a merge",
    deliveries: BOTH,
    http: [
      {
        match: (entry) =>
          entry.endpoint === MERGE || entry.endpoint === MERGE_ASYNC,
        kind: "after",
        run: (fake) => fake.pushForeignCommit(),
      },
    ],
  },
];

const known = {};

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
            http: scenario.http ?? [],
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
