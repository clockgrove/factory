import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  DaytonaAuthenticationError,
  DaytonaConnectionError,
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaSpotEvictedError,
} from "@daytonaio/sdk";
import { Octokit } from "@octokit/core";
import { Codex } from "@openai/codex-sdk";
import { ClaudePlanningModel } from "../dist/claude-planning.js";
import { CodexPlanningModel, modelFault } from "../dist/compiler.js";
import {
  AuthenticationRequiredError,
  CompletedModelInvocationError,
  Interruption,
} from "../dist/contracts.js";
import { NativeStackDelivery } from "../dist/delivery/native-stack.js";
import { verifyHydratedAssets } from "../dist/media.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import { DaytonaSandboxProvider } from "../dist/execution/daytona.js";
import { earlierHeads } from "../dist/repair-policy.js";
import { daytonaFault, executionFault } from "../dist/execution/fault.js";
import { AgentsApiError } from "../dist/execution/openai-managed.js";
import {
  assertRepeats,
  assertWait,
  attachFault,
  faultOf,
  isFault,
  StepFault,
} from "../dist/fault.js";
import { projectedIssueBody, RealGitHubGateway } from "../dist/github.js";
import {
  GitHubClient,
  GitHubOutcomeUnknown,
  GitHubRequestError,
  gitHubFault,
} from "../dist/github-client.js";
import {
  git,
  gitAsync,
  gitFault,
  withProcessCancellation,
} from "../dist/process.js";
import {
  ProviderTurnIncompleteError,
  ProviderTurnTimeoutError,
} from "../dist/provider-turn.js";
import {
  AcceptanceDecisionRequired,
  reviewAcceptance,
  validateTree,
} from "../dist/validation.js";
import { SettledAttemptFailure } from "../dist/work-repair.js";
import {
  createTarget,
  git as fixtureGit,
} from "./support/integration-fixture.mjs";
import { compilerRequest } from "./support/compiler-wire.mjs";

const MINUTE = 60_000;

/** Assert `actual` matches the expected fault; `retryAt` is checked as a window. */
function assertFault(actual, expected, label) {
  assert.ok(isFault(actual), `${label}: not a fault ${JSON.stringify(actual)}`);
  assert.equal(actual.kind, expected.kind, `${label}: kind`);
  if (expected.outcomeUnknown !== undefined)
    assert.equal(
      actual.outcomeUnknown,
      expected.outcomeUnknown,
      `${label}: outcomeUnknown`,
    );
  if (expected.retryIn) {
    const [low, high] = expected.retryIn;
    const wait = Date.parse(actual.retryAt) - Date.now();
    assert.ok(
      wait > low && wait <= high,
      `${label}: retryAt ${actual.retryAt} is ${wait} ms away`,
    );
  } else if (expected.retryAt)
    assert.equal(actual.retryAt, expected.retryAt, `${label}: retryAt`);
  else if (expected.kind === "transient")
    assert.equal(actual.retryAt, undefined, `${label}: retryAt`);
  if (expected.fix) assert.match(actual.fix, expected.fix, `${label}: fix`);
  if (expected.detailMatches)
    assert.match(actual.detail, expected.detailMatches, `${label}: detail`);
}

test("faults attach once, invisibly, and default to defect", () => {
  const error = new Error("boom");
  const fault = { kind: "transient", detail: "lag", outcomeUnknown: false };
  assert.equal(attachFault(error, fault), error);
  attachFault(error, { kind: "defect", detail: "later" });
  assert.deepEqual(faultOf(error), fault);
  assert.deepEqual(Object.keys(error), []);
  assert.equal(JSON.stringify(error), "{}");
  assert.deepEqual(faultOf(new Interruption(error)), fault);
  assert.deepEqual(faultOf(new Error("plain")), {
    kind: "defect",
    detail: "plain",
  });
  assert.deepEqual(faultOf("text"), { kind: "defect", detail: "text" });
  const step = new StepFault({ kind: "config", detail: "d", fix: "f" });
  assert.equal(step.message, "d");
  assert.equal(faultOf(step).kind, "config");
  // Frozen or primitive errors are rethrown unchanged.
  assert.equal(
    attachFault(Object.freeze(new Error("x")), fault).fault,
    undefined,
  );
  assert.equal(attachFault("x", fault), "x");
  for (const bad of [
    { kind: "transient", detail: "x" },
    { kind: "transient", detail: "x", outcomeUnknown: true, retryAt: "soon" },
    { kind: "decision", question: "q", evidence: [1] },
    { kind: "work", evidence: { detail: "" } },
    { kind: "config", detail: "d" },
    { kind: "defect", detail: "d", extra: 1 },
    { kind: "other", detail: "d" },
  ])
    assert.equal(isFault(bad), false, JSON.stringify(bad));
});

// ---------------------------------------------------------------- GitHub

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const headSha = "a".repeat(40);
const foreignSha = "f".repeat(40);
const pull = (sha = headSha) => ({
  number: 5,
  state: "open",
  merged: false,
  head: { sha, ref: "factory/one" },
  base: { ref: "main" },
});
const identity = { number: 5, branch: "factory/one", headSha };
const secondsFromNow = (seconds) => Math.floor(Date.now() / 1000) + seconds;

/** A fresh client per case, so one case's rate gate never delays another. */
function gateway(routes) {
  const fetch = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const answer = routes[key];
    if (!answer) throw new Error(`unexpected request ${key}`);
    return answer();
  };
  const client = new GitHubClient(new Octokit({ request: { fetch } }));
  return new RealGitHubGateway(
    "a/b",
    new NativeStackDelivery("a/b", client),
    client,
  );
}
const repo = "GET /repos/a/b";
const lost = () => {
  throw new TypeError("fetch failed");
};
const readyPull = {
  "GET /repos/a/b/pulls/5": () => json(pull()),
};

const gitHubCases = [
  [
    "429 with Retry-After",
    (g) => g.defaultBranch(),
    { [repo]: () => json({ message: "slow" }, 429, { "retry-after": "30" }) },
    { kind: "transient", outcomeUnknown: false, retryIn: [25_000, 30_000] },
  ],
  [
    "403 secondary rate limit body",
    (g) => g.defaultBranch(),
    {
      [repo]: () =>
        json({ message: "You have exceeded a secondary rate limit." }, 403),
    },
    { kind: "transient", outcomeUnknown: false, retryIn: [55_000, MINUTE] },
  ],
  [
    "403 primary limit with reset",
    (g) => g.defaultBranch(),
    {
      [repo]: () =>
        json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(secondsFromNow(600)),
        }),
    },
    { kind: "transient", outcomeUnknown: false, retryIn: [590_000, 600_000] },
  ],
  [
    "403 primary limit without reset",
    (g) => g.defaultBranch(),
    {
      [repo]: () =>
        json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
        }),
    },
    { kind: "transient", outcomeUnknown: false, retryIn: [55_000, MINUTE] },
  ],
  [
    "403 permission",
    (g) => g.defaultBranch(),
    {
      [repo]: () =>
        json({ message: "Resource not accessible by integration" }, 403),
    },
    { kind: "config", fix: /write access/ },
  ],
  [
    "401 bad credentials",
    (g) => g.defaultBranch(),
    { [repo]: () => json({ message: "Bad credentials" }, 401) },
    { kind: "config", fix: /gh auth login/ },
  ],
  [
    "5xx on a read",
    (g) => g.defaultBranch(),
    { [repo]: () => json({ message: "Server Error" }, 502) },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "5xx on a create",
    (g) =>
      g.publish({ branch: "factory/one", base: "main", title: "t", body: "b" }),
    { "POST /repos/a/b/pulls": () => json({ message: "Server Error" }, 502) },
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "network failure on a read",
    (g) => g.defaultBranch(),
    { [repo]: lost },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "network failure on a create",
    (g) =>
      g.publish({ branch: "factory/one", base: "main", title: "t", body: "b" }),
    { "POST /repos/a/b/pulls": lost },
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "404 on the repository",
    (g) => g.defaultBranch(),
    { [repo]: () => json({ message: "Not Found" }, 404) },
    { kind: "config" },
  ],
  [
    "404 on the Objective issue while the repository is visible",
    (g) => g.objective(7),
    {
      [repo]: () => json({ default_branch: "main" }),
      "GET /repos/a/b/issues/7": () => json({ message: "Not Found" }, 404),
    },
    { kind: "decision" },
  ],
  [
    "404 on a recorded PR with no creation time",
    (g) => g.observe(identity),
    {
      [repo]: () => json({ default_branch: "main" }),
      "GET /repos/a/b/pulls/5": () => json({ message: "Not Found" }, 404),
    },
    { kind: "decision" },
  ],
  [
    "404 on an issue created moments ago (lag)",
    (g) =>
      g.projectGraph({
        objectiveIssue: 7,
        graph: { items: [{ ...workItem }] },
      }),
    {
      [repo]: () => json({ default_branch: "main" }),
      "GET /repos/a/b/labels": () =>
        json([{ name: "factory:objective" }, { name: "factory:work-item" }]),
      "GET /repos/a/b/issues/7": () => json(objectiveIssue),
      "GET /user": () => json({ login: "factory" }),
      "GET /repos/a/b/issues": () => json([]),
      // Projection reads past the newest listed issue before creating one.
      "GET /repos/a/b/issues/1": () => json({ message: "Not Found" }, 404),
      "POST /repos/a/b/issues": () =>
        json(
          {
            id: 80,
            number: 8,
            title: workItem.title,
            body: projectedIssueBody(workItem, 7),
            state: "open",
            labels: ["factory:work-item"],
            repository_url: "https://api.github.com/repos/a/b",
          },
          201,
        ),
      "GET /repos/a/b/issues/8/dependencies/blocked_by": () => json([]),
      "GET /repos/a/b/issues/7/sub_issues": () => json([]),
      "GET /repos/a/b/issues/8": () => json({ message: "Not Found" }, 404),
    },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "404 because the login lost the repository (probe)",
    (g) => g.observe(identity),
    {
      [repo]: () => json({ message: "Not Found" }, 404),
      "GET /repos/a/b/pulls/5": () => json({ message: "Not Found" }, 404),
    },
    { kind: "config", fix: /write access/ },
  ],
  [
    "404 on native stacks: the feature is missing",
    (g) =>
      g.ensureNativeStack(
        [
          { pullRequest: 1, branch: "s/one", headSha },
          { pullRequest: 2, branch: "s/two", headSha: foreignSha },
        ],
        "main",
      ),
    {
      "GET /repos/a/b/pulls/1": () =>
        json({ ...pull(), number: 1, head: { sha: headSha, ref: "s/one" } }),
      "GET /repos/a/b/pulls/2": () =>
        json({
          ...pull(),
          number: 2,
          head: { sha: foreignSha, ref: "s/two" },
          base: { ref: "s/one" },
        }),
      "GET /repos/a/b/stacks": () => json({ message: "Not Found" }, 404),
    },
    { kind: "config", fix: /stacked/ },
  ],
  [
    "422 PR already exists",
    (g) =>
      g.publish({ branch: "factory/one", base: "main", title: "t", body: "b" }),
    {
      "POST /repos/a/b/pulls": () =>
        json(
          {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for a:one." }],
          },
          422,
        ),
    },
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "422 label already exists",
    (g) =>
      g.projectGraph({
        objectiveIssue: 7,
        graph: { items: [{ ...workItem }] },
      }),
    {
      "GET /repos/a/b/labels": () => json([{ name: "factory:objective" }]),
      "POST /repos/a/b/labels": () =>
        json(
          {
            message: "Validation Failed",
            errors: [
              { resource: "Label", code: "already_exists", field: "name" },
            ],
          },
          422,
        ),
    },
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "422 creating a Work Item issue",
    (g) =>
      g.projectGraph({
        objectiveIssue: 7,
        graph: { items: [{ ...workItem }] },
      }),
    {
      "GET /repos/a/b/labels": () =>
        json([{ name: "factory:objective" }, { name: "factory:work-item" }]),
      "GET /repos/a/b/issues/7": () => json(objectiveIssue),
      "GET /user": () => json({ login: "factory" }),
      "GET /repos/a/b/issues": () => json([]),
      // Projection reads past the newest listed issue before creating one.
      "GET /repos/a/b/issues/1": () => json({ message: "Not Found" }, 404),
      "POST /repos/a/b/issues": () =>
        json(
          {
            message: "Validation Failed",
            errors: [{ resource: "Issue", code: "invalid", field: "title" }],
          },
          422,
        ),
    },
    { kind: "decision" },
  ],
  [
    "405 base branch modified",
    (g) => g.merge(identity, headSha),
    {
      ...readyPull,
      "PUT /repos/a/b/pulls/5/merge": () =>
        json(
          {
            message:
              "Base branch was modified. Review and try the merge again.",
          },
          405,
        ),
    },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "405 merge method not allowed",
    (g) => g.merge(identity, headSha),
    {
      ...readyPull,
      "PUT /repos/a/b/pulls/5/merge": () =>
        json(
          { message: "Merge commits are not allowed on this repository." },
          405,
        ),
    },
    { kind: "config", fix: /merge commits/ },
  ],
  [
    "405 not mergeable",
    (g) => g.merge(identity, headSha),
    {
      ...readyPull,
      "PUT /repos/a/b/pulls/5/merge": () =>
        json({ message: "Pull Request is not mergeable" }, 405),
    },
    { kind: "decision" },
  ],
  [
    "405 repository rule",
    (g) => g.merge(identity, headSha),
    {
      ...readyPull,
      "PUT /repos/a/b/pulls/5/merge": () =>
        json(
          {
            message:
              "Repository rule violations found\n\nAt least 1 approving review is required.",
          },
          405,
        ),
    },
    { kind: "decision" },
  ],
  [
    "409 head mismatch on Factory's head",
    (g) => g.merge(identity, headSha),
    {
      ...readyPull,
      "PUT /repos/a/b/pulls/5/merge": () =>
        json(
          {
            message:
              "Head branch was modified. Review and try the merge again.",
          },
          409,
        ),
    },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "409 head mismatch on a foreign head",
    (g) => g.merge(identity, headSha),
    {
      "GET /repos/a/b/pulls/5": () => json(pull(foreignSha)),
      "PUT /repos/a/b/pulls/5/merge": () =>
        json({ message: "Head branch was modified." }, 409),
    },
    { kind: "decision" },
  ],
  [
    "merge accepted but not yet readable",
    (g) => g.merge(identity, headSha),
    {
      ...readyPull,
      "PUT /repos/a/b/pulls/5/merge": () =>
        json({ merged: true, sha: "c".repeat(40) }),
    },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "merged PR whose timeline lags",
    (g) => g.merge(identity, headSha),
    {
      "GET /repos/a/b/pulls/5": () =>
        json({ ...pull(), state: "closed", merged: true }),
      "GET /repos/a/b/issues/5/timeline": () => json([]),
    },
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "PR head changed by someone else",
    (g) => g.observe(identity),
    { "GET /repos/a/b/pulls/5": () => json(pull(foreignSha)) },
    { kind: "decision" },
  ],
  [
    "GraphQL RATE_LIMITED inside HTTP 200",
    (g) => g.observe(identity),
    {
      ...readyPull,
      [`GET /repos/a/b/commits/${headSha}/check-runs`]: () =>
        json({ total_count: 0, check_runs: [] }),
      [`GET /repos/a/b/commits/${headSha}/status`]: () =>
        json({ state: "pending", total_count: 0 }),
      "POST /graphql": () =>
        json({
          data: null,
          errors: [
            { type: "RATE_LIMITED", message: "API rate limit exceeded" },
          ],
        }),
    },
    { kind: "transient", outcomeUnknown: false, retryIn: [55_000, MINUTE] },
  ],
  [
    "400 is unclassified",
    (g) => g.defaultBranch(),
    { [repo]: () => json({ message: "Bad Request" }, 400) },
    { kind: "defect" },
  ],
  [
    "native stack topology changed",
    (g) =>
      g.ensureNativeStack(
        [
          { pullRequest: 1, branch: "s/one", headSha },
          { pullRequest: 2, branch: "s/two", headSha: foreignSha },
        ],
        "main",
      ),
    {
      "GET /repos/a/b/pulls/1": () =>
        json({
          ...pull(),
          number: 1,
          head: { sha: headSha, ref: "s/one" },
        }),
      "GET /repos/a/b/pulls/2": () =>
        json({
          ...pull(),
          number: 2,
          head: { sha: foreignSha, ref: "s/two" },
          base: { ref: "s/one" },
        }),
      "GET /repos/a/b/stacks": () =>
        json([
          {
            number: 9,
            base: { ref: "main" },
            pull_requests: [{ number: 2 }, { number: 1 }],
          },
        ]),
    },
    { kind: "decision" },
  ],
];

const workItem = {
  kind: "work",
  id: "one",
  title: "One",
  goal: "goal",
  acceptance: [],
  nonGoals: [],
  dependencies: [],
  citations: [],
  ownedPaths: [],
  validation: [],
  brief: "brief",
};
const objectiveIssue = {
  id: 70,
  number: 7,
  title: "Objective",
  body: "",
  state: "open",
  labels: ["factory:objective"],
  repository_url: "https://api.github.com/repos/a/b",
};

for (const [name, call, routes, expected] of gitHubCases)
  test(`GitHub gateway: ${name}`, async () => {
    const error = await call(gateway(routes)).then(
      () => assert.fail("expected a rejection"),
      (caught) => caught,
    );
    assertFault(faultOf(error), expected, name);
  });

test("a lost mutation is still GitHubOutcomeUnknown, now carrying its fault", async () => {
  const error = await gateway({ "POST /repos/a/b/pulls": lost })
    .publish({ branch: "factory/one", base: "main", title: "t", body: "b" })
    .catch((caught) => caught);
  assert.ok(error instanceof GitHubOutcomeUnknown);
  assert.equal(faultOf(error).outcomeUnknown, true);
});

test("a rate limit without a reset header waits a minute instead of stopping every request", async () => {
  let calls = 0;
  const client = new GitHubClient(
    new Octokit({
      request: {
        fetch: async () => {
          calls++;
          return json({ message: "API rate limit exceeded" }, 403, {
            "x-ratelimit-remaining": "0",
          });
        },
      },
    }),
  );
  const error = await client
    .request("GET", "repos/a/b/issues/1")
    .catch((caught) => caught);
  assertFault(
    faultOf(error),
    { kind: "transient", outcomeUnknown: false, retryIn: [55_000, MINUTE] },
    "missing reset",
  );
  // The gate is finite: the next request waits for it rather than failing
  // with "rate reset unavailable" for the rest of the process.
  const controller = new AbortController();
  const queued = withProcessCancellation(controller.signal, () =>
    client.request("GET", "repos/a/b/issues/2"),
  ).then(
    () => "sent",
    (caught) => caught,
  );
  const early = await Promise.race([
    queued,
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
  ]);
  assert.equal(early, "waiting");
  controller.abort();
  const settled = await queued;
  assert.ok(settled instanceof Error);
  assert.doesNotMatch(settled.message, /rate reset unavailable/);
  assert.equal(calls, 1);
});

test("projection treats a missing dependency as lag right after creating the issue", async () => {
  const error = await gateway({
    [repo]: () => json({ default_branch: "main" }),
    "GET /repos/a/b/labels": () =>
      json([{ name: "factory:objective" }, { name: "factory:work-item" }]),
    "GET /repos/a/b/issues/7": () => json(objectiveIssue),
    "GET /repos/a/b/issues": () => json([]),
    "POST /repos/a/b/issues": () =>
      json(
        {
          id: 80,
          number: 8,
          title: workItem.title,
          body: projectedIssueBody(workItem, 7),
          state: "open",
          labels: ["factory:work-item"],
          repository_url: "https://api.github.com/repos/a/b",
        },
        201,
      ),
    "GET /repos/a/b/issues/8/dependencies/blocked_by": () =>
      json({ message: "Not Found" }, 404),
  })
    .projectGraph({ objectiveIssue: 7, graph: { items: [{ ...workItem }] } })
    .catch((caught) => caught);
  assertFault(
    faultOf(error),
    { kind: "transient", outcomeUnknown: false },
    "fresh dependency route",
  );
});

test("removing a dependency GitHub already removed counts as done", async () => {
  const zero = { ...workItem, id: "zero", title: "Zero" };
  const before = { ...workItem, dependencies: ["zero"] };
  const after = { ...workItem };
  const issue = (number, item) => ({
    id: number * 10,
    number,
    title: item.title,
    body: projectedIssueBody(item, 7),
    state: "open",
    labels: ["factory:work-item"],
    repository_url: "https://api.github.com/repos/a/b",
  });
  let body = issue(9, before);
  let blockers = [issue(8, zero)];
  const deletes = [];
  const result = await gateway({
    "GET /repos/a/b/labels": () =>
      json([{ name: "factory:objective" }, { name: "factory:work-item" }]),
    "GET /repos/a/b/issues/7": () => json(objectiveIssue),
    "GET /repos/a/b/issues/8": () => json(issue(8, zero)),
    "GET /repos/a/b/issues/9": () => json(body),
    "PATCH /repos/a/b/issues/9": () => {
      body = issue(9, after);
      return json(body);
    },
    "GET /repos/a/b/issues/8/dependencies/blocked_by": () => json([]),
    "GET /repos/a/b/issues/9/dependencies/blocked_by": () => json(blockers),
    "DELETE /repos/a/b/issues/9/dependencies/blocked_by/80": () => {
      deletes.push(80);
      blockers = [];
      return json({ message: "Not Found" }, 404);
    },
    "GET /repos/a/b/issues/7/sub_issues": () =>
      json([issue(8, zero), issue(9, after)]),
  }).projectGraph({
    objectiveIssue: 7,
    graph: { items: [zero, after] },
    previousGraph: { items: [zero, before] },
    knownIssues: { zero: 8, one: 9 },
  });
  assert.deepEqual(result.issueByItemId, { zero: 8, one: 9 });
  assert.deepEqual(deletes, [80]);
});

test("a GraphQL rate limit gates the next request like REST headers do", async () => {
  let calls = 0;
  const client = new GitHubClient(
    new Octokit({
      request: {
        fetch: async () => {
          calls++;
          return json({
            data: null,
            errors: [
              { type: "RATE_LIMITED", message: "API rate limit exceeded" },
            ],
          });
        },
      },
    }),
  );
  await assert.rejects(client.pullRequestReadiness("a/b", 5));
  const controller = new AbortController();
  const queued = withProcessCancellation(controller.signal, () =>
    client.request("GET", "repos/a/b/issues/2"),
  ).then(
    () => "sent",
    (caught) => caught,
  );
  const early = await Promise.race([
    queued,
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
  ]);
  assert.equal(early, "waiting");
  controller.abort();
  await queued;
  assert.equal(calls, 1);
});

test("a 404 on a Factory object is lag only within two minutes of its creation", () => {
  const notFound = new GitHubRequestError(404);
  const call = { method: "GET", path: "issues/8" };
  const now = Date.now();
  assert.equal(
    gitHubFault(notFound, { ...call, createdAt: now - 60_000 }, now).kind,
    "transient",
  );
  assert.equal(
    gitHubFault(notFound, { ...call, createdAt: now - 180_000 }, now).kind,
    "decision",
  );
  assert.equal(gitHubFault(notFound, call, now).kind, "decision");
  for (const path of [
    "stacks?pull_request=1",
    "issues/8/dependencies/blocked_by",
    "issues/8/sub_issues",
  ]) {
    assert.equal(
      gitHubFault(notFound, { method: "GET", path }, now).kind,
      "config",
      path,
    );
    // Right after Factory created the issue, its feature routes may lag too.
    if (path.startsWith("issues/"))
      assert.equal(
        gitHubFault(
          notFound,
          { method: "GET", path, createdAt: now - 10_000 },
          now,
        ).kind,
        "transient",
        path,
      );
  }
});

// ------------------------------------------------------------------- git

const gitError = (args, stderr) =>
  new Error(`git ${args.join(" ")} failed (128): ${stderr}`);
const gitCases = [
  [
    ["push", "origin", "x:refs/heads/f"],
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    ["fetch", "origin", "main"],
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    ["fetch", "origin"],
    "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: expected flush after ref listing",
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    ["-c", "credential.helper=", "push", "origin", "x"],
    "remote: Permission to a/b.git denied to someone.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
    { kind: "config", fix: /gh auth status/ },
  ],
  [
    ["fetch", "origin"],
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    { kind: "config" },
  ],
  [
    ["push", "origin", "x:refs/heads/f"],
    " ! [rejected]        x -> f (fetch first)\nerror: failed to push some refs to 'https://github.com/a/b.git'",
    // Ownership is known only at the push site, which checks ls-remote.
    { kind: "defect" },
  ],
  [
    ["push", "origin", "x:refs/heads/main"],
    "remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] x -> main (protected branch hook declined)",
    { kind: "config" },
  ],
  [
    ["push", "origin", "x:refs/heads/f"],
    "remote: error: File big.bin is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected.",
    { kind: "work" },
  ],
  [
    ["lfs", "push", "origin", "x"],
    "batch response: Rate limit exceeded: https://github.com/a/b.git/info/lfs",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    ["lfs", "push", "origin", "x"],
    "git: 'lfs' is not a git command. See 'git --help'.",
    { kind: "config", fix: /Git LFS/ },
  ],
  [
    ["commit", "-m", "x"],
    "fatal: Unable to create '/w/.git/index.lock': File exists.",
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    ["rev-parse", "nope"],
    "fatal: ambiguous argument 'nope': unknown revision",
    { kind: "defect" },
  ],
  [
    ["fetch", "origin"],
    "fatal: couldn't find remote ref nope",
    { kind: "defect" },
  ],
];

test("git failures classify by subcommand and remote answer", () => {
  for (const [args, stderr, expected] of gitCases) {
    const fault = gitFault(args, gitError(args, stderr));
    assertFault(fault ?? faultOf(new Error(stderr)), expected, stderr);
  }
  const missing = Object.assign(new Error("spawn git ENOENT"), {
    code: "ENOENT",
  });
  assertFault(gitFault(["status"], missing), { kind: "config" }, "ENOENT");
});

test("the git wrappers attach faults to the errors they already throw", async () => {
  const refused = await gitAsync(
    tmpdir(),
    "ls-remote",
    "http://127.0.0.1:9/a/b.git",
  ).catch((caught) => caught);
  assert.match(refused.message, /git -C .* ls-remote/);
  assertFault(
    faultOf(refused),
    { kind: "transient", outcomeUnknown: false },
    "refused connection",
  );
  assert.throws(
    () => git(tmpdir(), "rev-parse", "--verify", "missing-ref"),
    (error) => faultOf(error).kind === "defect",
  );
});

/** A target checkout with a bare origin; the branch holds `remoteHead`. */
function pushFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-push-faults-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const run = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  run(checkout, "config", "user.email", "fixture@example.invalid");
  run(checkout, "config", "user.name", "Fixture");
  run(checkout, "remote", "add", "origin", origin);
  const commit = (name) => {
    writeFileSync(join(checkout, name), name);
    run(checkout, "add", name);
    run(checkout, "commit", "-qm", name);
    return run(checkout, "rev-parse", "HEAD");
  };
  const base = commit("base");
  run(checkout, "push", "-q", "origin", "main");
  const delivery = new RegularDelivery(checkout, {
    defaultBranch: async () => "main",
    findOpenPullRequest: async () => undefined,
    publish: async () => assert.fail("publish follows only a successful push"),
  });
  const publish = (changeRef, earlierHeads) =>
    delivery.publish({
      item: { id: "one", title: "One" },
      baseSha: base,
      treeSha: run(checkout, "rev-parse", `${changeRef}^{tree}`),
      changeRef,
      branch: "factory/one",
      baseBranch: "main",
      ...(earlierHeads && { earlierHeads }),
    });
  return { root, run, checkout, commit, base, publish };
}

test("a push rejected by an earlier attempt's recorded head is transient", async (t) => {
  const f = pushFixture(t);
  const earlier = f.commit("earlier attempt");
  f.run(
    f.checkout,
    "push",
    "-q",
    "origin",
    `${earlier}:refs/heads/factory/one`,
  );
  f.run(f.checkout, "reset", "-q", "--hard", f.base);
  const retry = f.commit("retry");
  const error = await f.publish(retry, [earlier]).catch((caught) => caught);
  assert.match(error.message, /\[rejected\]/);
  assertFault(
    faultOf(error),
    { kind: "transient", outcomeUnknown: false },
    "earlier head",
  );
  // Without the record the same head is someone else's, in neutral words.
  const unknown = await f.publish(retry).catch((caught) => caught);
  assert.equal(faultOf(unknown).kind, "decision");
  assert.match(faultOf(unknown).question, /has no record of/);
});

test("earlier attempt heads come from the archived attempt history", () => {
  assert.deepEqual(
    earlierHeads({
      status: "running",
      recovery: {
        history: [
          { at: "2026-10-03T00:00:00Z", work: { status: "failed" } },
          {
            at: "2026-10-03T00:01:00Z",
            work: { status: "failed", changeRef: "a".repeat(40) },
          },
        ],
      },
    }),
    ["a".repeat(40)],
  );
  assert.deepEqual(earlierHeads({ status: "pending" }), []);
});

test("a push rejected by a foreign branch head is a decision", async (t) => {
  const f = pushFixture(t);
  const foreign = f.commit("foreign");
  f.run(
    f.checkout,
    "push",
    "-q",
    "origin",
    `${foreign}:refs/heads/factory/one`,
  );
  f.run(f.checkout, "reset", "-q", "--hard", f.base);
  const ours = f.commit("ours");
  const error = await f.publish(ours).catch((caught) => caught);
  assert.match(error.message, /\[rejected\]/);
  assertFault(faultOf(error), { kind: "decision" }, "foreign head");
});

test("a push rejected while the remote already holds Factory's commit is lag", async (t) => {
  const f = pushFixture(t);
  const ours = f.commit("ours");
  f.run(f.checkout, "push", "-q", "origin", `${ours}:refs/heads/factory/one`);
  // A push whose acknowledgement was lost: the remote reports a rejection
  // although the branch already holds the commit.
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in\n  *" push origin "*) echo " ! [rejected]        x -> factory/one (fetch first)" >&2; exit 1 ;;\nesac\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const error = await f.publish(ours).catch((caught) => caught);
  assertFault(
    faultOf(error),
    { kind: "transient", outcomeUnknown: false },
    "own head",
  );
});

test("fresh-clone hydration keeps the git failure as its cause", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-hydration-faults-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  ]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "http://127.0.0.1:9/a/b.git",
  ]);
  const integratedSha = execFileSync(
    "git",
    ["-C", checkout, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const error = await verifyHydratedAssets({
    checkout,
    workRoot: join(root, "work"),
    integratedSha,
    selections: [{ set: { members: [] } }],
  }).catch((caught) => caught);
  assert.equal(
    error.message,
    "Fresh-clone hydration verification failed during clone",
  );
  assertFault(
    faultOf(error),
    { kind: "transient", outcomeUnknown: false },
    "clone refused",
  );
});

// --------------------------------------------------------- model adapters

const claudePlanning = {
  kind: "claude-agent-sdk",
  maxOutputTokens: 64000,
  planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
  reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "medium" },
};
const session = "session-faults";
const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const init = (options, overrides = {}) => ({
  type: "system",
  subtype: "init",
  model: options.model,
  tools: ["StructuredOutput"],
  mcp_servers: [],
  permissionMode: "dontAsk",
  session_id: session,
  uuid: "init",
  ...overrides,
});
const reply = (options, structured) => ({
  type: "assistant",
  message: {
    id: "msg",
    model: options.model,
    content: [
      {
        type: "tool_use",
        id: "t1",
        name: "StructuredOutput",
        input: structured,
      },
    ],
    usage: zeroUsage,
  },
  parent_tool_use_id: null,
  session_id: session,
  uuid: "assistant",
});
const result = (structured, overrides = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  result: JSON.stringify(structured),
  stop_reason: "tool_use",
  structured_output: structured,
  usage: zeroUsage,
  modelUsage: {},
  total_cost_usd: 0,
  permission_denials: [],
  session_id: session,
  uuid: "result",
  ...overrides,
});
/** A runtime-reported failure as the pinned Agent SDK (0.3.281) emits it. */
const runtimeFailure = (options, text, { error, status = null } = {}) => [
  init(options),
  {
    type: "assistant",
    message: {
      id: "synthetic",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text }],
      usage: zeroUsage,
    },
    parent_tool_use_id: null,
    session_id: session,
    uuid: "synthetic",
    error,
    is_api_error_message: true,
  },
  {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: status,
    num_turns: 1,
    result: text,
    stop_reason: "stop_sequence",
    terminal_reason: "api_error",
    total_cost_usd: 0,
    usage: zeroUsage,
    modelUsage: {},
    permission_denials: [],
    session_id: session,
    uuid: "result",
  },
];
const findings = { packetId: "packet", findings: [] };
const graphReview = () => {
  const request = compilerRequest({
    objective: "# Objective",
    baseSha: headSha,
    sources: [{ path: "OBJECTIVE", content: "# Objective" }],
  });
  return {
    objective: "# Objective",
    baseSha: headSha,
    sources: [{ path: "OBJECTIVE", content: "# Objective" }],
    graph: { objective: 1, baseSha: headSha, items: [] },
    commands: [],
    finalCommands: [],
    controllerCapabilities: request.controllerCapabilities,
    controllerCapabilitiesDigest: request.controllerCapabilitiesDigest,
  };
};
const usageReset = 1_893_456_000; // 2030-01-01T00:00:00Z

const claudeCases = [
  [
    "not logged in (no API call)",
    (options) =>
      runtimeFailure(options, "Not logged in · Please run /login", {
        error: "authentication_failed",
      }),
    { kind: "config", fix: /claude auth login/ },
  ],
  [
    "invalid API key (401)",
    (options) =>
      runtimeFailure(
        options,
        "Failed to authenticate. API Error: 401 invalid x-api-key",
        { error: "authentication_failed", status: 401 },
      ),
    { kind: "config", fix: /claude auth login/ },
  ],
  [
    "offline (the runtime gave up reaching the API)",
    (options) =>
      runtimeFailure(options, "Can't reach the API server (EAI_AGAIN)", {
        error: "unknown",
      }),
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "overloaded (529 after the runtime's retries)",
    (options) =>
      runtimeFailure(options, "API Error: 529 Overloaded", {
        error: "overloaded",
        status: 529,
      }),
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "usage limit with its reset time",
    (options) =>
      runtimeFailure(options, `Claude AI usage limit reached|${usageReset}`, {
        error: "rate_limit",
        status: 429,
      }),
    {
      kind: "transient",
      outcomeUnknown: false,
      retryAt: new Date(usageReset * 1000).toISOString(),
    },
  ],
  [
    "usage limit with the runtime's structured reset time",
    (options) => [
      init(options),
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: usageReset,
          rateLimitType: "five_hour",
        },
        uuid: "limit",
        session_id: session,
      },
      ...runtimeFailure(options, "You've hit your limit · resets 3pm", {
        error: "rate_limit",
        status: 429,
      }).slice(1),
    ],
    {
      kind: "transient",
      outcomeUnknown: false,
      retryAt: new Date(usageReset * 1000).toISOString(),
    },
  ],
  [
    "exhausted credit balance (billing, not login)",
    (options) =>
      runtimeFailure(options, "Credit balance is too low", {
        error: "billing_error",
        status: 400,
      }),
    { kind: "config", fix: /billing/ },
  ],
  [
    "process crash after a model reply",
    (options) => [
      init(options),
      reply(options, {}),
      {
        ...result({}),
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: null,
        errors: ["Claude Code process exited unexpectedly"],
      },
    ],
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "lost session (the runtime died before a result)",
    () => new Error("Claude Code process exited with code 1"),
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "stream ended without a result",
    (options) => [init(options), reply(options, findings)],
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "refusal",
    (options) => [
      init(options),
      reply(options, findings),
      result(findings, { stop_reason: "refusal" }),
    ],
    { kind: "decision" },
  ],
  [
    "max turns",
    (options) => [
      init(options),
      reply(options, findings),
      {
        ...result(findings),
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Reached maximum number of turns"],
      },
    ],
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "structured output retries exhausted",
    (options) => [
      init(options),
      reply(options, findings),
      {
        ...result(findings),
        subtype: "error_max_structured_output_retries",
        is_error: true,
        errors: ["schema mismatch"],
      },
    ],
    {
      kind: "transient",
      outcomeUnknown: true,
      detailMatches: /Model output was invalid/,
    },
  ],
  [
    "a different model than configured",
    (options) => [init(options, { model: "claude-haiku-5-5" })],
    { kind: "config" },
  ],
  [
    "an unconfigured tool exposed",
    (options) => [init(options, { tools: ["StructuredOutput", "Bash"] })],
    { kind: "defect" },
  ],
];

for (const [name, respond, expected] of claudeCases)
  test(`Claude planner: ${name}`, async () => {
    const model = new ClaudePlanningModel(claudePlanning, {
      query: ({ options }) => {
        const outcome = respond(options);
        return (async function* () {
          if (outcome instanceof Error) throw outcome;
          yield* outcome;
        })();
      },
      wait: async () => undefined,
      reviewCapacityRetryDelaysMs: [],
    });
    const error = await model.reviewGraph(graphReview()).then(
      () => assert.fail("expected a rejection"),
      (caught) => caught,
    );
    assertFault(faultOf(error), expected, name);
  });

test("Claude planner: decoded output that fails validation counts toward a bounded re-ask", async () => {
  const model = new ClaudePlanningModel(claudePlanning, {
    query: ({ options }) =>
      (async function* () {
        yield init(options);
        yield reply(options, { contextId: "wrong" });
        yield result({ contextId: "wrong" });
      })(),
  });
  const error = await model
    .generateStructured(
      compilerRequest({
        objective: "# Objective",
        baseSha: headSha,
        sources: [{ path: "OBJECTIVE", content: "# Objective" }],
      }),
    )
    .catch((caught) => caught);
  assertFault(
    faultOf(error),
    {
      kind: "transient",
      outcomeUnknown: true,
      detailMatches: /Model output was invalid/,
    },
    "decode",
  );
});

/** Codex SDK thread whose stream yields `events`, then throws `failure`. */
function codexThread(events, failure) {
  return () => ({
    id: "thread-faults",
    async runStreamed() {
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-faults" };
          yield { type: "turn.started" };
          yield* events;
          if (failure) throw failure;
        })(),
      };
    },
  });
}

const codexCases = [
  [
    "usage limit with a relative reset",
    codexThread([
      {
        type: "turn.failed",
        error: {
          message:
            "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes.",
        },
      },
    ]),
    {
      kind: "transient",
      outcomeUnknown: false,
      retryIn: [125 * MINUTE - 5_000, 125 * MINUTE],
    },
  ],
  [
    "retries exhausted on 429",
    codexThread([
      {
        type: "error",
        message: "exceeded retry limit, last status: 429 Too Many Requests",
      },
    ]),
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "model at capacity",
    codexThread([
      {
        type: "turn.failed",
        error: {
          message:
            "Selected model is at capacity. Please try a different model.",
        },
      },
    ]),
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "not logged in",
    codexThread(
      [],
      new Error(
        "Codex Exec exited with code 1: Error: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ),
    { kind: "config", fix: /codex login/ },
  ],
  [
    "quota exhausted",
    codexThread([
      {
        type: "turn.failed",
        error: {
          message: "Quota exceeded. Check your plan and billing details.",
        },
      },
    ]),
    { kind: "config" },
  ],
  [
    "usage limit with a plan-upgrade hint and a reset",
    codexThread([
      {
        type: "turn.failed",
        error: {
          message:
            "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing), or try again in 3 hours.",
        },
      },
    ]),
    {
      kind: "transient",
      outcomeUnknown: false,
      retryIn: [180 * MINUTE - 5_000, 180 * MINUTE],
    },
  ],
  [
    "connection reset after the turn started",
    codexThread(
      [],
      Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
        syscall: "read",
      }),
    ),
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "insufficient quota reported as 429",
    codexThread([
      {
        type: "error",
        message:
          "exceeded retry limit, last status: 429 Too Many Requests, insufficient_quota",
      },
    ]),
    { kind: "config", fix: /billing/ },
  ],
  [
    "stream disconnected mid-turn",
    codexThread([
      {
        type: "turn.failed",
        error: {
          message:
            "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
        },
      },
    ]),
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "CLI killed",
    codexThread([], new Error("Codex Exec exited with signal SIGKILL: ")),
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "invalid JSON reply",
    codexThread([
      {
        type: "item.completed",
        item: { id: "m", type: "agent_message", text: "not json" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ]),
    {
      kind: "transient",
      outcomeUnknown: true,
      detailMatches: /Model output was invalid/,
    },
  ],
];

for (const [name, startThread, expected] of codexCases)
  test(`Codex planner: ${name}`, async (t) => {
    t.mock.method(Codex.prototype, "startThread", startThread);
    const model = new CodexPlanningModel(
      tmpdir(),
      { model: "gpt-5.5", reasoningEffort: "high" },
      { model: "gpt-5.5", reasoningEffort: "medium" },
      undefined,
      { reviewCapacityRetryDelaysMs: [], wait: async () => undefined },
    );
    const error = await model.reviewGraph(graphReview()).then(
      () => assert.fail("expected a rejection"),
      (caught) => caught,
    );
    assertFault(faultOf(error), expected, name);
  });

test("model faults: only connect-phase failures before a turn started are unpaid", () => {
  const call = (started) => ({
    provider: "openai-codex-sdk",
    ended: false,
    started,
    failureClass: "provider",
  });
  const refused = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  const reset = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  });
  assert.equal(modelFault(refused, call(false)).outcomeUnknown, false);
  assert.equal(modelFault(refused, call(true)).outcomeUnknown, true);
  assert.equal(modelFault(reset, call(false)).outcomeUnknown, true);
  assert.equal(modelFault(reset, call(true)).kind, "transient");
  // A local filesystem failure is Factory's, not the provider's.
  const denied = Object.assign(
    new Error("EACCES: permission denied, mkdtemp"),
    {
      code: "EACCES",
      syscall: "mkdtemp",
    },
  );
  assert.equal(modelFault(denied, call(false)).kind, "defect");
  // Other syscalls are not presumed local.
  const odd = Object.assign(new Error("getsockopt failed"), {
    syscall: "getsockopt",
  });
  assert.equal(modelFault(odd, call(true)).kind, "transient");
});

test("model faults: a Factory programming error is a defect, a missing CLI is configuration", () => {
  const call = {
    provider: "openai-codex-sdk",
    ended: false,
    failureClass: "provider",
  };
  assert.equal(
    modelFault(new TypeError("Cannot read properties of undefined"), call).kind,
    "defect",
  );
  assert.equal(
    modelFault(
      Object.assign(new Error("spawn codex ENOENT"), {
        code: "ENOENT",
        syscall: "spawn codex",
      }),
      call,
    ).kind,
    "config",
  );
  // fetch's own network TypeError is weather, not a bug.
  assert.equal(
    modelFault(Object.assign(new TypeError("fetch failed"), {}), call).kind,
    "transient",
  );
});

test("model faults: an authentication request is configuration", () => {
  assertFault(
    modelFault(
      new AuthenticationRequiredError("login", {
        provider: "claude",
        command: "claude auth login",
      }),
      { provider: "claude-agent-sdk", ended: false, failureClass: "provider" },
    ),
    { kind: "config", fix: /claude auth login/ },
    "auth",
  );
});

/** A committed result with validation evidence, as result review receives it. */
async function reviewFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-review-faults-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root, { "base.txt": "base\n" });
  writeFileSync(join(target.checkout, "result.txt"), "result\n");
  fixtureGit(target.checkout, "add", "result.txt");
  fixtureGit(
    target.checkout,
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory-test@example.invalid",
    "commit",
    "-m",
    "result",
  );
  const commit = fixtureGit(target.checkout, "rev-parse", "HEAD");
  const treeSha = fixtureGit(target.checkout, "rev-parse", "HEAD^{tree}");
  return {
    checkout: target.checkout,
    baseSha: target.baseSha,
    commit,
    evidence: await validateTree(
      target.checkout,
      join(root, "validation"),
      commit,
      treeSha,
      ["test -f result.txt"],
    ),
    criteria: ["result.txt exists"],
    sources: [
      { path: "OBJECTIVE", content: "## Acceptance\n- result.txt exists\n" },
    ],
  };
}

const claudeReviewer = (respond) =>
  new ClaudePlanningModel(claudePlanning, {
    query: ({ options }) =>
      (async function* () {
        yield* respond(options);
      })(),
    wait: async () => undefined,
    reviewCapacityRetryDelaysMs: [],
  });

const reviewCases = [
  [
    "no reviewer configured",
    () => ({}),
    AcceptanceDecisionRequired,
    { kind: "config", fix: /reviewer/ },
  ],
  [
    "reviewer over capacity",
    () =>
      claudeReviewer((options) =>
        runtimeFailure(options, "API Error: 529 Overloaded", {
          error: "overloaded",
          status: 529,
        }),
      ),
    AcceptanceDecisionRequired,
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "reviewer not logged in",
    () =>
      claudeReviewer((options) =>
        runtimeFailure(options, "Not logged in · Please run /login", {
          error: "authentication_failed",
        }),
      ),
    Interruption,
    { kind: "config", fix: /claude auth login/ },
  ],
  [
    "reviewer answer that cannot be decoded",
    () => ({
      async reviewResult({ reviewPacket }) {
        return { packetId: reviewPacket.id, findings: [] };
      },
    }),
    AcceptanceDecisionRequired,
    { kind: "decision" },
  ],
  [
    "reviewer refuses the criterion",
    () => ({
      async reviewResult({ reviewPacket }) {
        return {
          packetId: reviewPacket.id,
          findings: [
            {
              criterionIndex: 0,
              verdict: "refuse",
              evidenceIndices: [0],
              detail: "result.txt is empty",
              question: "",
            },
          ],
        };
      },
    }),
    CompletedModelInvocationError,
    { kind: "work" },
  ],
];

for (const [name, model, type, expected] of reviewCases)
  test(`result review: ${name}`, async (t) => {
    const error = await reviewAcceptance({
      ...(await reviewFixture(t)),
      model: model(),
    }).then(
      () => assert.fail("expected a rejection"),
      (caught) => caught,
    );
    assert.ok(error instanceof type, `${name}: ${error}`);
    assertFault(faultOf(error), expected, name);
  });

// ------------------------------------------ execution drivers and sandboxes

const anthropic429 = Anthropic.APIError.generate(
  429,
  { type: "error", error: { type: "rate_limit_error", message: "slow" } },
  "429 rate limited",
  new Headers({ "retry-after": "20" }),
);
const executionCases = [
  [
    "authentication request",
    new AuthenticationRequiredError("Authentication required for codex", {
      provider: "codex",
      command: "codex login",
    }),
    "observe",
    { kind: "config", fix: /codex login/ },
  ],
  [
    "worker settled without a result",
    new SettledAttemptFailure(new Error("worker exited"), "interruption"),
    "collect",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "worker settled with a failed result",
    new SettledAttemptFailure(new Error("tests failed"), "implementation"),
    "collect",
    { kind: "work" },
  ],
  [
    "provider turn idle",
    new ProviderTurnTimeoutError(1000),
    "observe",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "provider stream incomplete",
    new ProviderTurnIncompleteError(),
    "observe",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "Agents API 503 on start",
    new AgentsApiError("Agents API POST failed (503)", 503),
    "start",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "Agents API 503 on observe",
    new AgentsApiError("Agents API GET failed (503)", 503),
    "observe",
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "Agents API 401",
    new AgentsApiError("Agents API GET failed (401)", 401),
    "observe",
    { kind: "config" },
  ],
  [
    "Agents API 404 is left to the driver",
    new AgentsApiError("Agents API POST failed (404)", 404),
    "start",
    { kind: "defect" },
  ],
  [
    "missing controller credential",
    new Error(
      "OpenAI Agents API requires controller credential OPENAI_API_KEY",
    ),
    "start",
    { kind: "config" },
  ],
  [
    "interrupted by a lost Anthropic connection",
    new Interruption(new Anthropic.APIConnectionError({ message: "reset" })),
    "observe",
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "Anthropic 429 with Retry-After",
    anthropic429,
    "observe",
    { kind: "transient", outcomeUnknown: false, retryIn: [15_000, 20_000] },
  ],
];

test("execution driver errors classify by type, status and method", () => {
  for (const [name, error, method, expected] of executionCases)
    assertFault(
      executionFault(error, method) ?? faultOf(error),
      expected,
      name,
    );
});

const daytonaCases = [
  [
    "rate limited",
    new DaytonaRateLimitError("Too many requests", 429, { "retry-after": "5" }),
    "create",
    { kind: "transient", outcomeUnknown: false, retryIn: [0, 5_000] },
  ],
  [
    "server error on create",
    new DaytonaInternalServerError("boom", 500),
    "create",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "connection lost while observing",
    new DaytonaConnectionError("socket hang up"),
    "observe",
    { kind: "transient", outcomeUnknown: false },
  ],
  [
    "bad API key",
    new DaytonaAuthenticationError("Unauthorized", 401),
    "find",
    { kind: "config" },
  ],
  [
    "sandbox evicted",
    new DaytonaSpotEvictedError("evicted"),
    "observe",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "sandbox gone",
    new DaytonaNotFoundError("Sandbox not found", 404),
    "download",
    { kind: "transient", outcomeUnknown: true },
  ],
  [
    "SDK missing",
    Object.assign(new Error("Daytona SDK 0.220.0 unavailable"), {
      code: "DAYTONA_SDK_UNAVAILABLE",
    }),
    "create",
    { kind: "config" },
  ],
];

test("Daytona SDK errors classify by class and status", () => {
  for (const [name, error, method, expected] of daytonaCases)
    assertFault(daytonaFault(error, method) ?? faultOf(error), expected, name);
});

test("a decorated provider rethrows the same error with its fault", async () => {
  const notFound = new DaytonaNotFoundError("Sandbox not found", 404);
  const unauthorized = new DaytonaAuthenticationError("Unauthorized", 401);
  const provider = new DaytonaSandboxProvider(
    {
      snapshot: "s",
      target: "us",
      apiKeyEnv: "DAYTONA_API_KEY",
      timeoutSeconds: 60,
      factoryRoot: "/opt/factory",
    },
    "key",
    {
      get: async () => {
        throw notFound;
      },
      list: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw unauthorized;
          },
        }),
      }),
      create: async () => assert.fail("no create"),
    },
  );
  const handle = {
    identity: "sandbox-1",
    attemptId: "attempt-1",
    workspace: "/tmp/factory/attempt-1",
    data: { owner: "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12) },
  };
  const process = {
    identity: "command-1",
    sandboxIdentity: "sandbox-1",
    attemptId: "attempt-1",
    data: { session: handle.data.owner },
  };
  await assert.rejects(
    provider.observe(handle, process),
    (error) =>
      error === notFound &&
      faultOf(error).kind === "transient" &&
      faultOf(error).outcomeUnknown === true,
  );
  await assert.rejects(
    provider.find({ attemptId: "attempt-1" }),
    (error) => error === unauthorized && faultOf(error).kind === "config",
  );
  // Its own validation errors stay unclassified defects.
  await assert.rejects(
    provider.find({ attemptId: "../escape" }),
    (error) => faultOf(error).kind === "defect",
  );
});

// ------------------------------------------------------- state records

test("repeat records and structured waits are validated", () => {
  const faults = {
    since: "2026-10-03T00:00:00.000Z",
    count: 2,
    last: {
      kind: "transient",
      detail: "GitHub HTTP 502",
      outcomeUnknown: false,
    },
    activeMs: 1000,
  };
  const nextAt = "2026-10-03T00:00:04.000Z";
  const scheduledAt = "2026-10-03T00:00:02.000Z";
  assertRepeats(undefined, "repeats");
  assertRepeats(
    {
      "objective/plan": { nextAt, scheduledAt, faults },
      "item/one/publish": { nextAt, scheduledAt },
      "item/one/execute": { paid: 2, inFlight: true, asked: "Keep it?" },
    },
    "repeats",
  );
  for (const bad of [
    { "one/attempt-1/publish": { nextAt } },
    { "item/one": { nextAt } },
    { "objective/Plan": { nextAt } },
    { "objective/plan": {} },
    { "objective/plan": { nextAt: "later", scheduledAt } },
    { "objective/plan": { nextAt } },
    { "objective/plan": { scheduledAt } },
    { "objective/plan": { asked: "" } },
    { "objective/plan": { faults: { ...faults, count: 0 } } },
    {
      "objective/plan": { faults: { ...faults, last: { kind: "transient" } } },
    },
    {
      "objective/plan": {
        faults: { ...faults, last: { kind: "defect", detail: "x" } },
      },
    },
    { "objective/plan": { paid: 0 } },
    { "objective/plan": { inFlight: 1 } },
    { "objective/plan": { nextAt, scheduledAt, extra: true } },
    [],
  ])
    assert.throws(() => assertRepeats(bad, "repeats"), /repeats/);
  assertWait(undefined, "wait");
  for (const kind of [
    "ci",
    "capacity",
    "dependency",
    "decision",
    "prerequisite",
  ])
    assertWait({ kind, detail: "x" }, "wait");
  assertWait(
    {
      kind: "prerequisite",
      detail: "403",
      fix: "Grant access",
      step: "item/one/publish",
    },
    "wait",
  );
  for (const bad of [
    { kind: "later", detail: "x" },
    { kind: "outage", detail: "x" },
    { kind: "ci", detail: "" },
    { kind: "ci", detail: "x", since: "now" },
    { kind: "ci", detail: "x", fix: "y" },
    { kind: "prerequisite", detail: "x", fix: "" },
    { kind: "decision", detail: "x", step: "publish" },
    "ci",
  ])
    assert.throws(() => assertWait(bad, "wait"), /wait is invalid/);
  assert.equal(
    isFault({ kind: "cancelled", detail: "Objective cancelled" }),
    true,
  );
});
