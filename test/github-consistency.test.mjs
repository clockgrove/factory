import { describe } from "node:test";
import { faults } from "./support/github-http-fake.mjs";
import { runScenario } from "./support/fault-harness.mjs";
import { KNOWN } from "./support/fault-known.mjs";
import {
  checkKnown,
  declareScenario,
  referenceRun,
  scenarioConcurrency,
  testNames,
} from "./support/fault-matrix.mjs";

// Real-GitHub behaviors the fault matrix does not cover: read-after-write lag,
// rate limits, merge refusals, pagination and other actors. Every scenario
// must reach the end state of an uninterrupted run (see assertEndState),
// except where Factory must refuse. Known Factory bugs are inverted tests
// listed in support/fault-known.mjs.

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

// Factory must refuse, not complete: the merge it observed is gone from the
// default branch. Regular checks right after the merge; native after the stack.
scenarios.push({
  name: "a force-push removes a merge from the default branch",
  deliveries: BOTH,
  http: (delivery) => [
    {
      match: delivery === "regular" ? MERGE : MERGE_ASYNC,
      kind: "after",
      run: (fake) => fake.rewindDefaultBranch(),
    },
  ],
  checks: ["refusal"],
  refuses: /does not contain the merge/,
});

const known = KNOWN.consistency;
const name = (scenario, delivery) => `${delivery}: ${scenario.name}`;
const checksOf = (scenario) => scenario.checks ?? ["end", "stop", "budget"];
checkKnown(
  known,
  scenarios.flatMap((scenario) =>
    scenario.deliveries.flatMap((delivery) =>
      testNames(name(scenario, delivery), checksOf(scenario)),
    ),
  ),
);
// The paid-call budget compares with an uninterrupted run of each strategy.
await Promise.all(BOTH.map((delivery) => referenceRun(delivery)));

describe("GitHub consistency, rate limits and other actors", {
  concurrency: scenarioConcurrency(),
}, () => {
  for (const [index, scenario] of scenarios.entries())
    for (const delivery of scenario.deliveries)
      declareScenario(
        name(scenario, delivery),
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
          checks: checksOf(scenario),
          foreignIssues: scenario.foreignIssues ?? scenario.earlierIssues ?? 0,
          refuses: scenario.refuses,
        },
        known,
      );
});
