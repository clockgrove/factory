// GitHub refuses concurrent changes to one Project v2 with a GraphQL error
// in a 200 ("a temporary conflict", or "Something went wrong"), which asks
// to try again (#2210). Such an answer is a TransientError (TryAgain),
// traced as a failed request with its message, and a Project write tries it
// again after a pause; Factory's own writes to one Project take turns
// (queue.ts `projectWrite`), and different Projects don't wait on each
// other. GitHub is a local fake, or a stub that records each write.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  GitHub,
  GitHubError,
  githubOutcome,
  TransientError,
  TryAgain,
  tryAgain,
} from "../dist/github.js";
import {
  newTransport,
  requestEvents,
  transport,
} from "../dist/github-trace.js";
import {
  addCard,
  moveStatusOffDone,
  QueueDisplay,
  queueIssue,
} from "../dist/queue.js";
import { track } from "../dist/tracking.js";
import { item, plan, REPO } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFLICT =
  "Your attempt to move this item created a temporary conflict. Please try again. (addProjectV2ItemById)";
const WENT_WRONG =
  "Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `0000:1111:2222:3333:44445555` when reporting this issue.";

/**
 * A fake GitHub GraphQL endpoint: `answer(count)` gives the body of the
 * `count`th request. Each request is recorded with when it arrived.
 */
async function fakeGraphQL(answer) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(Date.now());
      response.writeHead(200, {
        "content-type": "application/json",
        "x-github-request-id": "0000:1111:2222:3333:44445555",
      });
      response.end(JSON.stringify(answer(requests.length)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.FACTORY_GITHUB_TOKEN = "ghs_test";
  return {
    github: new GitHub(REPO, `http://127.0.0.1:${server.address().port}`),
    requests,
  };
}

/** GitHub's answer to a mutation it refused with `message`. */
const refusedWith = (message) => ({
  data: { addProjectV2ItemById: null },
  errors: [
    {
      path: ["addProjectV2ItemById"],
      locations: [{ line: 3, column: 3 }],
      message,
    },
  ],
});

const added = (id) => ({ data: { addProjectV2ItemById: { item: { id } } } });

for (const [name, message] of [
  ["a Project's temporary conflict", CONFLICT],
  ['GitHub\'s "Something went wrong"', WENT_WRONG],
])
  test(`${name} is a TransientError, traced as a failed request with its message`, async () => {
    assert.equal(tryAgain({ message }), true);
    const { github } = await fakeGraphQL(() => refusedWith(message));
    const counted = newTransport();
    const error = await transport
      .run(counted, () => github.graphql("mutation { x }", {}))
      .then(
        () => assert.fail("the request succeeded"),
        (thrown) => thrown,
      );
    assert.ok(error instanceof TryAgain, String(error));
    assert.ok(error instanceof TransientError);
    assert.equal(error.message, `GitHub GraphQL: ${message}`);
    assert.equal(error.limited, false);
    assert.equal(githubOutcome(error, REPO).kind, "retry");
    assert.equal(counted.failed, 1);
    const events = requestEvents("sync", counted);
    assert.equal(events.length, 1);
    const { ms, ...request } = events[0];
    assert.equal(typeof ms, "number");
    assert.deepEqual(request, {
      event: "github-request",
      job: "sync",
      method: "POST",
      route: "/graphql",
      status: 200,
      attempt: 1,
      category: "server",
      cause: message,
      requestId: "0000:1111:2222:3333:44445555",
    });
  });

test("any other GraphQL error stays a GitHubError: a known message only where it starts", async () => {
  for (const message of [
    "Could not resolve to a node with the global id of 'PVT_x'",
    `Field failed: ${CONFLICT}`,
    "your attempt to move this item created a temporary conflict",
  ])
    assert.equal(tryAgain({ message }), false, message);
  // An answer with another error too is that error's.
  const { github } = await fakeGraphQL(() => ({
    data: null,
    errors: [
      { message: CONFLICT },
      { type: "NOT_FOUND", message: "Could not resolve to a node" },
    ],
  }));
  const error = await github.graphql("mutation { x }", {}).catch((e) => e);
  assert.ok(error instanceof GitHubError, String(error));
  assert.ok(!(error instanceof TransientError));
  assert.equal(error.status, 200);
});

test("a Project write GitHub answers with a temporary conflict is tried again after a pause", async () => {
  const { github, requests } = await fakeGraphQL((count) =>
    count === 1 ? refusedWith(CONFLICT) : added("PVTI_1"),
  );
  assert.equal(await addCard(github, "P_retry", "I_1"), "PVTI_1");
  assert.equal(requests.length, 2);
  assert.ok(requests[1] - requests[0] >= 900, `${requests[1] - requests[0]}`);
});

test("a conflict that lasts surfaces as the TransientError after three tries", async () => {
  const { github, requests } = await fakeGraphQL(() => refusedWith(WENT_WRONG));
  const error = await addCard(github, "P_lasting", "I_1").catch((e) => e);
  assert.ok(error instanceof TryAgain, String(error));
  assert.equal(requests.length, 3);
  // Paused 1 s, then 2 s.
  assert.ok(requests[2] - requests[0] >= 2900, `${requests[2] - requests[0]}`);
});

test("a Work Item's card GitHub answers with a conflict once still lands: the item gets its card", async () => {
  const startedAt = "2026-10-27T01:41:25.238Z";
  const events = [];
  let adds = 0;
  const [owner, name] = REPO.split("/");
  // The role labels and types are found; the card's add answers a
  // conflict once, then adds it. The issue's other writes land.
  const github = {
    repository: REPO,
    owner,
    name,
    rest: async () => ({}),
    graphqlPartial: async () => ({
      data: { repository: { issueTypes: { nodes: [] } } },
    }),
    async graphql(query) {
      assert.match(query, /addProjectV2ItemById/);
      adds += 1;
      if (adds === 1) throw new TryAgain(`GitHub GraphQL: ${CONFLICT}`);
      return { addProjectV2ItemById: { item: { id: "PVTI_card" } } };
    },
    editIssue: async () => {},
    upsertComment: async () => ({}),
  };
  // A building Objective whose item's issue is recorded without its card.
  const state = {
    version: 9,
    issue: 3,
    status: "building",
    holds: [],
    answers: {},
    repairs: {},
    kept: {},
    attempts: {},
    appliedRequests: [],
    retries: {},
    done: { plan: plan([item("pair")]) },
    modules: {
      github: {
        itemId: "I_3",
        commentsSince: startedAt,
        tracking: {
          items: {
            pair: {
              issue: 9,
              id: 9009,
              node: "I_9",
              body: "as created",
              parent: true,
              blockedBy: [],
              labels: [],
            },
          },
          objective: { priority: [] },
          untyped: true,
          project: "P_item_card",
        },
      },
    },
    startedAt,
    updatedAt: startedAt,
  };
  await track({
    github,
    state: () => state,
    issueType: { objective: "Objective", workItem: "Task" },
    save: (change) => change(state.modules.github.tracking),
    log: (event) => events.push(event),
    signal: new AbortController().signal,
  });
  assert.equal(adds, 2);
  const { tracking } = state.modules.github;
  assert.equal(tracking.items.pair.card, true);
  assert.equal(tracking.items.pair.cardItem, "PVTI_card");
  assert.equal(tracking.uncarded, undefined);
  assert.deepEqual(
    events.filter((event) => event.event === "item-card-refused"),
    [],
  );
});

test("a write that isn't GitHub's passing failure is never tried again", async () => {
  const { github, requests } = await fakeGraphQL(() =>
    refusedWith("Resource not accessible by integration"),
  );
  const error = await addCard(github, "P_refused", "I_1").catch((e) => e);
  assert.ok(error instanceof GitHubError, String(error));
  assert.equal(requests.length, 1);
});

// --- one at a time per Project -------------------------------------------------

const config = (projectId) => ({
  repository: REPO,
  queue: {
    projectId,
    field: "Factory",
    options: { queued: "Queued", cancelled: "Cancelled" },
  },
});

/**
 * A GitHub stub whose reads answer at once and whose Project writes take
 * 20 ms (or until `gate` opens, for a write to `gated`), recording when
 * each starts and ends and the most at once per Project.
 */
function stubGitHub({ gated, gate } = {}) {
  const writes = [];
  const active = new Map();
  const most = new Map();
  const [owner, name] = REPO.split("/");
  const github = {
    owner,
    name,
    sameRepository() {},
    async graphqlPartial(_query, variables) {
      return {
        data: {
          repository: {
            nameWithOwner: REPO,
            issue: {
              id: `I_${variables.issue}`,
              number: variables.issue,
              state: "OPEN",
              repository: { nameWithOwner: REPO },
              projectItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        errors: [],
      };
    },
    async graphql(query, variables) {
      if (!query.trimStart().startsWith("mutation"))
        return variables.issue !== undefined
          ? {
              repository: {
                nameWithOwner: REPO,
                issue: {
                  number: variables.issue,
                  repository: { nameWithOwner: REPO },
                  projectItems: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: `PVTI_${variables.issue}`,
                        isArchived: false,
                        project: { id: variables.project },
                        value: { name: "Done" },
                      },
                    ],
                  },
                },
              },
              node: {
                field: {
                  id: "F_status",
                  options: [
                    { id: "O_todo", name: "Todo" },
                    { id: "O_done", name: "Done" },
                  ],
                },
              },
            }
          : {
              node: {
                field: {
                  id: "F_1",
                  options: [
                    { id: "O_queued", name: "Queued" },
                    { id: "O_cancelled", name: "Cancelled" },
                  ],
                },
              },
            };
      const project = variables.project;
      const write = {
        project,
        what: variables.content ?? variables.item,
        started: true,
        ended: false,
      };
      writes.push(write);
      active.set(project, (active.get(project) ?? 0) + 1);
      most.set(project, Math.max(most.get(project) ?? 0, active.get(project)));
      await (project === gated ? gate : sleep(20));
      active.set(project, active.get(project) - 1);
      write.ended = true;
      return query.includes("addProjectV2ItemById")
        ? {
            addProjectV2ItemById: { item: { id: `PVTI_${variables.content}` } },
          }
        : {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { value: { updatedAt: new Date().toISOString() } },
            },
          };
    },
  };
  return { github, writes, most };
}

test("concurrent queueIssue and QueueDisplay.set writes to one Project never overlap", async () => {
  const { github, writes, most } = stubGitHub();
  const p = config("P_serial");
  const display = new QueueDisplay(github, p);
  const since = { at: new Date(Date.now() - 60_000).toISOString() };
  const outcomes = await Promise.all([
    ...[1, 2, 3, 4].map((issue) =>
      queueIssue(github, p, display, issue, false, since),
    ),
    ...[5, 6, 7, 8].map((n) => display.set(`PVTI_${n}`, "Cancelled")),
    addCard(github, "P_serial", "I_9"),
    moveStatusOffDone(github, p, 10, "test:status"),
  ]);
  assert.deepEqual(outcomes.slice(0, 4), [
    "queued",
    "queued",
    "queued",
    "queued",
  ]);
  assert.equal(outcomes.at(-1), "Todo");
  // Four adds and four sets for queueIssue, four sets, a card, a Status.
  assert.equal(writes.length, 14);
  assert.ok(writes.every((write) => write.ended));
  assert.equal(most.get("P_serial"), 1);
});

test("a write to one Project never waits on another Project's", async () => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const { github, writes } = stubGitHub({ gated: "P_slow", gate });
  const slow = addCard(github, "P_slow", "I_1");
  const behind = addCard(github, "P_slow", "I_2");
  // Another Project's write lands while the first Project's is held.
  assert.equal(await addCard(github, "P_fast", "I_3"), "PVTI_I_3");
  assert.deepEqual(
    writes.map((write) => [write.project, write.what, write.ended]),
    [
      ["P_slow", "I_1", false],
      ["P_fast", "I_3", true],
    ],
  );
  open();
  assert.deepEqual(await Promise.all([slow, behind]), ["PVTI_I_1", "PVTI_I_2"]);
  assert.deepEqual(
    writes.map((write) => write.what),
    ["I_1", "I_3", "I_2"],
  );
});
