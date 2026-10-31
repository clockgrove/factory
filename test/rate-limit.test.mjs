// GitHub's rate limits (#2080): a rate-limited answer, primary or
// secondary, holds every request it covers until its reset (github.ts
// `send`), and a rate-limited sync job runs again after the reset, never
// sooner and never given up. A budget an
// answer reports below github.reserve defers the queue poll until its reset
// (#2194, github-sync.ts `tick`). GitHub is a local fake that answers with
// GitHub's own headers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  GitHub,
  githubOutcome,
  LIMIT_UNSAID_MS,
  rateLimitOf,
  TransientError,
} from "../dist/github.js";
import { GitHubSync } from "../dist/github-sync.js";
import { item, plan, REPO, tempDir, until } from "./helpers.mjs";

const ISSUE = 5;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake GitHub: `answer(route, count)` gives [status, body, headers] for
 * the `count`th request of `METHOD /path`, or undefined for a 404. Each
 * request is recorded with when it arrived (this host's clock).
 */
async function fakeGitHub(answer) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const route = `${request.method} ${request.url.split("?")[0]}`;
      requests.push({ route, at: Date.now() });
      const count = requests.filter((r) => r.route === route).length;
      const [status, body, headers = {}] = answer(route, count) ?? [
        404,
        { message: "Not Found" },
      ];
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { api: `http://127.0.0.1:${server.address().port}`, requests };
}

/** A client of the fake as a token's login (no GitHub CLI), keeping `reserve` (github.reserve). */
function client(api, reserve) {
  process.env.FACTORY_GITHUB_TOKEN = "ghs_test";
  return new GitHub(REPO, api, undefined, reserve);
}

/** The routes a live status comment takes: the login, the comment list, the post. */
function statusRoutes(limited) {
  const comments = `/repos/${REPO}/issues/${ISSUE}/comments`;
  return (route, count) => {
    if (route === "GET /user") return [200, { login: "factory" }];
    if (route === `GET ${comments}`) return [200, []];
    if (route === `POST ${comments}`) {
      if (count === 1) return limited();
      const at = new Date().toISOString();
      return [
        201,
        { id: 1, body: "", created_at: at, updated_at: at, user: null },
      ];
    }
    return undefined;
  };
}

/**
 * An Objective in planning with one Work Item, its runner and the sync's
 * view, and a GitHubSync on `github` whose clock is `now`, with no jitter
 * (`random`). `events` collects the log.
 */
function harness(github, now, random = () => 0, fields = {}) {
  const started = iso(now() - 60_000);
  const state = {
    version: 10,
    issue: ISSUE,
    status: "planning",
    holds: [],
    answers: {},
    repairs: {},
    kept: {},
    attempts: {},
    appliedRequests: [],
    retries: {},
    done: { plan: plan([item("a")]) },
    modules: { github: { itemId: "I_5", commentsSince: started } },
    startedAt: started,
    updatedAt: started,
    ...fields,
  };
  const runner = {
    state,
    settled: false,
    blocked: () => false,
    transact: (change) => change(),
    shown: () => {},
  };
  const events = [];
  const sync = new GitHubSync(
    github,
    {
      repository: REPO,
      secrets: [],
      operators: [],
      progress: { enabled: true, includeQuestions: true },
      tracking: { enabled: true, issueType: {} },
      queue: {
        projectId: "P_1",
        field: "Factory",
        pollSeconds: 30,
        options: { queued: "Queued", cancelled: "Cancelled" },
      },
    },
    { write: (issue, event) => events.push({ issue, ...event }) },
    { noteAfterMs: 60 * 60_000, remindAfterMs: 24 * 60 * 60_000 },
    now,
    random,
  );
  const view = {
    logs: tempDir("factory-rate-limit-logs-"),
    queue: { mode: "running" },
    waitsOn: () => null,
  };
  const failures = (job) =>
    events.filter((e) => e.event === "github-sync" && e.job === job);
  return { sync, runner, state, view, events, failures };
}

test("GitHub's rate limits are told by their headers or their message, with how long to wait", () => {
  const now = Date.parse("2026-10-27T01:44:10Z");
  const headers = (fields) => new Headers(fields);
  // The primary limit: until its reset, for its resource.
  assert.deepEqual(
    rateLimitOf(
      403,
      headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Date.parse("2026-10-27T01:44:35Z") / 1000),
        "x-ratelimit-resource": "core",
      }),
      "API rate limit exceeded for installation ID 175636918.",
      now,
    ),
    { ms: 25_000, resource: "core" },
  );
  // A secondary limit: its retry-after, for every request.
  assert.deepEqual(
    rateLimitOf(
      403,
      headers({ "retry-after": "30", "x-ratelimit-remaining": "4000" }),
      "You have exceeded a secondary rate limit.",
      now,
    ),
    { ms: 30_000, resource: "*" },
  );
  // One known only by its message, or a bare 429: at least a minute.
  assert.deepEqual(
    rateLimitOf(
      403,
      headers({}),
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      now,
    ),
    { ms: LIMIT_UNSAID_MS, resource: "*" },
  );
  // GitHub's older wording for a secondary limit.
  assert.deepEqual(
    rateLimitOf(
      403,
      headers({}),
      "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.",
      now,
    ),
    { ms: LIMIT_UNSAID_MS, resource: "*" },
  );
  assert.deepEqual(rateLimitOf(429, headers({}), undefined, now), {
    ms: LIMIT_UNSAID_MS,
    resource: "*",
  });
  // A refusal, and a 5xx with rate-limit headers, are not limits.
  assert.equal(
    rateLimitOf(
      403,
      headers({ "x-ratelimit-remaining": "4000" }),
      "Resource not accessible by integration",
      now,
    ),
    undefined,
  );
  assert.equal(
    rateLimitOf(502, headers({ "x-ratelimit-remaining": "0" }), "", now),
    undefined,
  );
});

test("a secondary limit known only by its message waits as a limit, holds every request a minute, and is a step's reset wait, not a refusal", async () => {
  const fake = await fakeGitHub((route) =>
    route === `GET /repos/${REPO}/issues/${ISSUE}`
      ? [
          403,
          {
            message:
              "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
          },
        ]
      : [200, {}],
  );
  const github = client(fake.api);
  const error = await github.issue(ISSUE).catch((e) => e);
  assert.ok(error instanceof TransientError, String(error));
  assert.equal(error.limited, true);
  assert.ok(error.retryAfterMs > LIMIT_UNSAID_MS - 1000);
  const outcome = githubOutcome(error, REPO);
  assert.equal(outcome.kind, "retry");
  assert.equal(outcome.wait?.kind, "reset");
  assert.ok(Date.parse(outcome.wait.at) >= Date.now() + 55_000);
  // Every other request, GraphQL too, waits for it: none is sent.
  const sent = fake.requests.length;
  for (const call of [
    () => github.issue(ISSUE + 1),
    () => github.graphql("query { viewer { login } }", {}),
  ]) {
    const held = await call().catch((e) => e);
    assert.ok(held instanceof TransientError && held.limited, String(held));
    assert.match(held.message, /not sent/);
    assert.ok(held.retryAfterMs > 55_000);
  }
  assert.equal(fake.requests.length, sent);
});

test("the primary limit holds only its own resource", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 600;
  const fake = await fakeGitHub((route) =>
    route === `GET /repos/${REPO}/issues/${ISSUE}`
      ? [
          403,
          { message: "API rate limit exceeded for installation ID 1." },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
            "x-ratelimit-resource": "core",
          },
        ]
      : route === "POST /graphql"
        ? [200, { data: { viewer: { login: "factory" } } }]
        : [200, {}],
  );
  const github = client(fake.api);
  await assert.rejects(github.issue(ISSUE), (e) => e.limited === true);
  const held = await github.issue(ISSUE + 1).catch((e) => e);
  assert.ok(held instanceof TransientError && held.limited, String(held));
  assert.ok(held.retryAfterMs > 590_000);
  // GraphQL has its own limit.
  assert.deepEqual(await github.graphql("query { viewer { login } }", {}), {
    viewer: { login: "factory" },
  });
  assert.deepEqual(
    fake.requests.map((r) => r.route),
    [`GET /repos/${REPO}/issues/${ISSUE}`, "POST /graphql"],
  );
});

for (const [kind, limited] of [
  [
    "the installation's limit (403, x-ratelimit-remaining 0, x-ratelimit-reset)",
    (resetAt) => [
      403,
      { message: "API rate limit exceeded for installation ID 175636918." },
      {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt / 1000),
        "x-ratelimit-resource": "core",
      },
    ],
  ],
  [
    "a secondary limit (403 with retry-after)",
    (resetAt) => [
      403,
      { message: "You have exceeded a secondary rate limit." },
      {
        "retry-after": String(Math.ceil((resetAt - Date.now()) / 1000)),
        "x-ratelimit-remaining": "4321",
      },
    ],
  ],
]) {
  test(`a live status comment that hit ${kind} is written after the reset: nothing is sent before it, and it is never given up`, async () => {
    // Whole seconds, as GitHub sends them, 2 to 3 s away.
    const resetAt = (Math.floor(Date.now() / 1000) + 3) * 1000;
    const fake = await fakeGitHub(statusRoutes(() => limited(resetAt)));
    const github = client(fake.api);
    // The sync's clock runs ahead on demand, past its own pacing (one
    // status edit a minute, the job's backoff); the client's is the host's.
    let skew = 0;
    const { sync, runner, state, view, events, failures } = harness(
      github,
      () => Date.now() + skew,
    );
    const job = `status:${ISSUE}`;
    sync.status(runner, view);
    await until(() => failures(job).length === 1, "the rate-limited post");
    const [first] = failures(job);
    assert.equal(first.rateLimited, true);
    assert.equal(first.transient, true);
    // It waits at least for the reset (and the base backoff).
    assert.ok(Date.parse(first.retryAt) >= resetAt, first.retryAt);
    const limitedAt = fake.requests.at(-1).at;
    assert.ok(limitedAt < resetAt);

    // Before the reset, a status write that comes due again sends nothing.
    skew += 61_000;
    sync.status(runner, view);
    await until(() => failures(job).length === 2, "the held try");
    assert.match(failures(job)[1].error, /not sent/);
    assert.equal(failures(job)[1].rateLimited, true);
    assert.equal(fake.requests.filter((r) => r.at > limitedAt).length, 0);

    // After the reset (a retry-after counts from the answer, in whole
    // seconds), the job runs again and posts.
    while (Date.now() < resetAt + 1100) await sleep(50);
    skew += 61_000;
    sync.status(runner, view);
    await until(() => state.modules.github.status, "the status comment");
    assert.equal(state.modules.github.status.shown, "planning");
    assert.equal(state.modules.github.statusGivenUp, undefined);
    assert.ok(!events.some((e) => e.event === "status-given-up"));
    const later = fake.requests.filter((r) => r.at > limitedAt);
    assert.ok(later.length >= 1);
    for (const request of later)
      assert.ok(request.at >= resetAt, `${request.route} sent before reset`);
    assert.equal(
      fake.requests.filter(
        (r) => r.route === `POST /repos/${REPO}/issues/${ISSUE}/comments`,
      ).length,
      2,
    );
  });
}

test("a rate-limited status job waits for each reset, however often it is limited, and is never given up", async () => {
  let now = Date.parse("2026-10-27T01:44:00Z");
  const RESET_MS = 120_000;
  const tries = [];
  const github = {
    repository: REPO,
    upsertComment: async () => {
      tries.push(now);
      if (tries.length <= 4)
        throw new TransientError(
          "GitHub POST comments: 403 API rate limit exceeded",
          RESET_MS,
          true,
        );
      return { id: 1, created_at: iso(now), updated_at: iso(now) };
    },
  };
  const { sync, runner, state, view, events, failures } = harness(
    github,
    () => now,
  );
  const job = `status:${ISSUE}`;
  for (let limited = 1; limited <= 4; limited++) {
    sync.status(runner, view);
    await until(() => failures(job).length === limited, `limit ${limited}`);
    const failure = failures(job).at(-1);
    assert.equal(failure.rateLimited, true);
    assert.equal(Date.parse(failure.retryAt), now + RESET_MS);
    // Due again before the reset: it doesn't run.
    now += 61_000;
    sync.status(runner, view);
    await sleep(50);
    assert.equal(tries.length, limited);
    now += RESET_MS - 61_000;
  }
  sync.status(runner, view);
  await until(() => state.modules.github.status, "the status comment");
  assert.equal(tries.length, 5);
  for (let i = 1; i < tries.length; i++)
    assert.ok(tries[i] - tries[i - 1] >= RESET_MS);
  assert.equal(state.modules.github.statusGivenUp, undefined);
  assert.ok(!events.some((e) => e.event === "status-given-up"));
});

test("an answer that reports the budget below github.reserve defers the queue poll until its reset, logged once; above it the poll goes on", async () => {
  // Whole seconds, as GitHub sends them, 2 to 3 s away.
  const resetAt = (Math.floor(Date.now() / 1000) + 3) * 1000;
  const fake = await fakeGitHub((route) =>
    route === `GET /repos/${REPO}/issues/${ISSUE}`
      ? [
          200,
          { number: ISSUE, state: "open" },
          {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "1500",
            "x-ratelimit-reset": String(resetAt / 1000),
            "x-ratelimit-resource": "core",
          },
        ]
      : [200, { data: {} }],
  );
  const polls = () =>
    fake.requests.filter((r) => r.route === "POST /graphql").length;
  const tick = (sync) =>
    sync.tick({ runners: new Map(), unreadable: new Map(), guard: () => {} });
  const lows = (events) =>
    events.filter((e) => e.event === "github-budget-low");

  // Above the reserve (1000): nothing changes, the poll is sent.
  const above = client(fake.api, 1000);
  await above.issue(ISSUE);
  const plain = harness(above, () => Date.now());
  plain.sync.identified = true;
  tick(plain.sync);
  await until(() => polls() === 1, "the poll above the reserve");
  assert.deepEqual(lows(plain.events), []);

  // Below it (2000): the poll waits for the reset, and one event says why.
  const below = client(fake.api, 2000);
  await below.issue(ISSUE);
  const { sync, events } = harness(below, () => Date.now());
  sync.identified = true;
  tick(sync);
  await sleep(100);
  tick(sync);
  await sleep(100);
  assert.equal(polls(), 1);
  assert.deepEqual(lows(events), [
    {
      issue: 0,
      event: "github-budget-low",
      resource: "core",
      remaining: 1500,
      reserve: 2000,
      reset: iso(resetAt),
    },
  ]);
  // After the reset, the next tick polls; no run failed meanwhile.
  while (Date.now() < resetAt + 50) await sleep(50);
  tick(sync);
  await until(() => polls() === 2, "the poll after the reset");
  assert.equal(lows(events).length, 1);
});
