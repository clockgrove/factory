import { basename } from "node:path";
import { describe } from "node:test";
import { runScenario } from "./fault-harness.mjs";
import { KNOWN } from "./fault-known.mjs";
import {
  checkKnown,
  declareScenario,
  partOf,
  referenceRun,
  scenarioConcurrency,
  testNames,
} from "./fault-matrix.mjs";
import { faults } from "./github-http-fake.mjs";

// Real-GitHub and provider behaviors the fault matrix does not cover:
// read-after-write lag, rate limits (REST and model usage limits), merge
// refusals, pagination, other actors, a worker that dies and the paid-call
// bound. Every scenario must reach the end state of an uninterrupted run (see
// assertEndState), except where Factory must refuse or stop for a decision.
// Known Factory bugs are inverted tests listed in support/fault-known.mjs.

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
    // Real GitHub (#630): the list shows a new issue after 2.5-3.4 s. Factory
    // keeps the number a create answers, so only a lost answer makes it list
    // within that span; the number probe must find the issue, not a duplicate.
    // The test clock runs 100x fast (src/clock.ts), so real overhead between
    // the create and the list read counts 100x too: the span is 30 s logical
    // (0.3 s real), still inside Factory's lag window, so the read stays stale.
    // A loaded machine can spend that span before the first list read, so
    // the read after the create is stale whatever the clock says (#815).
    name: "lost issue creation, then the issue list lags after each creation",
    deliveries: BOTH,
    http: [{ match: CREATE_ISSUE, kind: "drop" }],
    fake: {
      lag: [{ read: ISSUES, after: CREATE_ISSUE, ms: 30_000, reads: 1 }],
    },
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
    // Real GitHub (#630): a merge-async stays pending for about 5-7 s.
    name: "stack merge stays pending for 6 s",
    deliveries: ["native-stack"],
    fake: { asyncMergeMs: 6000 },
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
  // Secondary limits without retry-after: the body alone names the limit,
  // so Factory waits GitHub's documented minute before the next request.
  {
    name: "429 secondary rate limit without retry-after on issue creation",
    deliveries: BOTH,
    http: [
      { match: CREATE_ISSUE, ...faults.secondaryRateLimit({ status: 429 }) },
    ],
  },
  {
    name: "429 secondary rate limit without retry-after on PR creation",
    deliveries: BOTH,
    http: [
      { match: CREATE_PULL, ...faults.secondaryRateLimit({ status: 429 }) },
    ],
  },
  {
    name: "429 secondary rate limit without retry-after on merge",
    deliveries: BOTH,
    http: (delivery) => [
      {
        match: delivery === "regular" ? MERGE : MERGE_ASYNC,
        ...faults.secondaryRateLimit({ status: 429 }),
      },
    ],
  },
  {
    name: "403 secondary rate limit without retry-after on PR creation",
    deliveries: BOTH,
    http: [{ match: CREATE_PULL, ...faults.secondaryRateLimit() }],
  },
  {
    name: "403 secondary rate limit with retry-after on issue creation",
    deliveries: BOTH,
    http: [
      { match: CREATE_ISSUE, ...faults.secondaryRateLimit({ retryAfter: 1 }) },
    ],
  },
  {
    name: "403 secondary rate limit without retry-after on a completion comment",
    deliveries: ["native-stack"],
    http: [
      {
        match: `POST ${repo}/issues/{number}/comments`,
        ...faults.secondaryRateLimit(),
      },
    ],
  },
  {
    name: "403 primary rate limit without a reset header on PR observation",
    deliveries: BOTH,
    http: [{ match: PULL, ...faults.primaryRateLimitWithoutReset() }],
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
  {
    // A usage limit carries its reset time; waiting for it is not a paid
    // fault, so four in a row stay within the paid-call bound of three.
    name: "a model usage limit with a reset time four times at the first result review",
    deliveries: BOTH,
    inProcess: [
      {
        target: "model",
        method: "reviewResult",
        occurrence: 1,
        times: 4,
        kind: "usage-limit",
      },
    ],
  },
  {
    // The fresh attempt is one more worker start than the reference.
    name: "alpha's worker ends without a result once",
    deliveries: BOTH,
    actions: { alpha: { dieAttempts: 1 } },
    checks: ["end", "stop"],
  },
];

// Factory must stop for a decision once a paid call's transient faults
// exceed its bound of three, instead of repeating it without end.
scenarios.push({
  name: "four lost responses at the first result review",
  deliveries: BOTH,
  inProcess: [
    {
      target: "model",
      method: "reviewResult",
      occurrence: 1,
      times: 4,
      kind: "lost",
    },
  ],
  checks: ["refusal"],
  // The paid bound is a decision on the item (contract 2); test/paid-bounds
  // answers it and drives the Objective to completion.
  refuses:
    /^Objective #\d+ Work Item alpha needs a decision: review failed 4 times/,
});

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

// An App installation token has no user: GET /user is 403, and the issues
// and PRs Factory creates are authored by the App's bot. Ownership is the
// author login persisted at the first create, not the viewer.
scenarios.push({
  name: "an App installation token without a user",
  deliveries: BOTH,
  fake: { appToken: true, protectionChecks: () => [] },
});

// A maintainer deleted the newest issue: the number probe past the newest
// listed issue reads 410, which is a gap like 404.
scenarios.push({
  name: "a deleted issue right after the Objective",
  deliveries: BOTH,
  earlierIssues: 1,
  beforeRun: (fake, index) => {
    if (index === 0) fake.deleteIssue(2);
  },
});

// Strict required checks: once the default branch moves, alpha's open PR is
// BEHIND. Factory updates the branch with the head it expects instead of
// waiting forever, then merges.
scenarios.push({
  name: "the default branch moves under strict protection while alpha's PR is open",
  deliveries: ["regular"],
  fake: { strict: true, protectionChecks: () => [] },
  http: [{ match: CREATE_PULL, kind: "after", run: pushForeign }],
  extraMutations: [`PUT ${repo}/pulls/{number}/update-branch`],
});

// Factory integrates with merge commits (its evidence binds the delivered
// head as the second parent): a repository that disallows them waits for
// the configuration fix before any merge is sent.
scenarios.push({
  name: "a repository without merge commits is refused before any merge",
  deliveries: BOTH,
  fake: { mergeMethods: ["squash"] },
  checks: ["refusal"],
  refuses: /does not allow merge commits/,
  unsent: [MERGE, MERGE_ASYNC],
});

/**
 * The suite is split across CONSISTENCY_PARTS files,
 * github-consistency-<part>.test.mjs, so CI shards can spread it. Each file
 * takes its part from its own name, so the files cover every part exactly
 * when their names are 1..CONSISTENCY_PARTS, which test/fault-guards checks.
 */
export const CONSISTENCY_PARTS = 4;

const known = KNOWN.consistency;
const checksOf = (scenario) => scenario.checks ?? ["end", "stop", "budget"];

/**
 * Every scenario run, one per scenario and delivery, with the part it
 * belongs to. The part hashes the run's name, as the fault matrix does, so
 * adding a scenario moves no other.
 */
export const consistencyCases = () =>
  scenarios.flatMap((scenario, index) =>
    scenario.deliveries.map((delivery) => {
      const name = `${delivery}: ${scenario.name}`;
      return {
        name,
        scenario,
        delivery,
        index,
        part: partOf(name, CONSISTENCY_PARTS),
      };
    }),
  );

export const PART_FILE = /^github-consistency-(\d+)\.test\.mjs$/;

/** Declare the part of the suite that the test file `filename` names. */
export async function defineConsistency(filename) {
  const part = Number(PART_FILE.exec(basename(filename))?.[1]);
  if (!(part >= 1 && part <= CONSISTENCY_PARTS))
    throw new Error(`${filename} names no part 1..${CONSISTENCY_PARTS}`);
  const cases = consistencyCases();
  checkKnown(
    known,
    cases.flatMap(({ name, scenario }) => testNames(name, checksOf(scenario))),
  );
  // The paid-call budget compares with an uninterrupted run of each strategy.
  await Promise.all(BOTH.map((delivery) => referenceRun(delivery)));

  describe(`GitHub consistency, rate limits and other actors (${part}/${CONSISTENCY_PARTS})`, {
    concurrency: scenarioConcurrency(),
  }, () => {
    for (const { name, scenario, delivery, index, part: own } of cases) {
      if (own !== part) continue;
      declareScenario(
        name,
        () =>
          runScenario({
            name: `c${index}-${delivery === "regular" ? "r" : "n"}`,
            delivery,
            http:
              typeof scenario.http === "function"
                ? scenario.http(delivery)
                : (scenario.http ?? []),
            inProcess: scenario.inProcess ?? [],
            actions: scenario.actions ?? {},
            fake: scenario.fake ?? {},
            beforeRun: scenario.beforeRun,
            earlierIssues: scenario.earlierIssues ?? 0,
          }),
        {
          checks: checksOf(scenario),
          foreignIssues: scenario.foreignIssues ?? scenario.earlierIssues ?? 0,
          refuses: scenario.refuses,
          unsent: scenario.unsent ?? [],
          extraMutations: scenario.extraMutations ?? [],
        },
        known,
      );
    }
  });
}
