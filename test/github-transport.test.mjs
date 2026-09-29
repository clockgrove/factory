import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient, GitHubOutcomeUnknown } from "../dist/github-client.js";
import { withProcessCancellation } from "../dist/process.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const clientFor = (fetch) =>
  new GitHubClient(new Octokit({ request: { fetch } }));
const item = {
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

test("shared gate observes successful response delay before queued dispatch", async () => {
  const calls = [];
  const client = clientFor(async () => {
    calls.push(Date.now());
    return json({}, 200, calls.length === 1 ? { "retry-after": "0.06" } : {});
  });
  await Promise.all([
    client.request("GET", "repos/a/b/issues/1"),
    client.request("GET", "repos/a/b/issues/2"),
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1] - calls[0] >= 50);
});

test("rate rejection is not retried, and queued wait is cancellable", async () => {
  let calls = 0;
  const client = clientFor(async () => {
    calls++;
    return json({ message: "secondary rate limit" }, 403, {
      "retry-after": "10",
    });
  });
  await assert.rejects(client.request("GET", "repos/a/b/issues/1"), /HTTP 403/);
  const controller = new AbortController();
  const waiting = withProcessCancellation(controller.signal, () =>
    client.request("GET", "repos/a/b/issues/2"),
  );
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(waiting);
  assert.equal(calls, 1);
});

test("lost mutation response is unknown and does not expose transport details", async () => {
  let calls = 0;
  const client = clientFor(async () => {
    calls++;
    throw new Error("private token or payload");
  });
  await assert.rejects(
    client.request("POST", "repos/a/b/issues", { title: "x" }),
    (error) =>
      error instanceof GitHubOutcomeUnknown &&
      !error.message.includes("private"),
  );
  assert.equal(calls, 1);
});

test("projection direct reads known identity without listing or replacement", async () => {
  const calls = [];
  const client = clientFor(async (url) => {
    calls.push(String(url));
    return json({
      number: 7,
      id: 100,
      body: "<!-- factory:objective=3;item=one -->",
    });
  });
  const gateway = new RealGitHubGateway("a/b", {}, client);
  const saved = [];
  const result = await gateway.projectGraph({
    objectiveIssue: 3,
    graph: { items: [item] },
    knownIssues: { one: 7 },
    beforeCreate: () => assert.fail("known identity must not be created"),
    projected: (id, number) => saved.push([id, number]),
  });
  assert.deepEqual(result.issueByItemId, { one: 7 });
  assert.deepEqual(saved, [["one", 7]]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /issues\/7$/);
});

test("missing known issue fails without replacement", async () => {
  let calls = 0;
  const client = clientFor(async () => {
    calls++;
    return json({ message: "Not found" }, 404);
  });
  const gateway = new RealGitHubGateway("a/b", {}, client);
  await assert.rejects(
    gateway.projectGraph({
      objectiveIssue: 3,
      graph: { items: [item] },
      knownIssues: { one: 7 },
      beforeCreate: () => assert.fail("must not replace"),
    }),
    /404/,
  );
  assert.equal(calls, 1);
});

test("projection persists intent before creation and identity before next work", async () => {
  const events = [];
  const client = clientFor(async (_url, options) => {
    if (options.method === "GET") return json([]);
    events.push("create");
    return json({ number: 8, id: 101 });
  });
  const gateway = new RealGitHubGateway("a/b", {}, client);
  await gateway.projectGraph({
    objectiveIssue: 3,
    graph: { items: [item] },
    beforeCreate: () => events.push("intent"),
    projected: (_id, number) => events.push(`saved:${number}`),
  });
  assert.deepEqual(events, ["intent", "create", "saved:8"]);
});

test("regular merge sends the exact expected head and verifies integrated identity", async () => {
  const calls = [];
  const client = clientFor(async (_url, options) => {
    calls.push(options);
    return options.method === "PUT"
      ? json({ merged: true, sha: "integrated" })
      : json({
          merged: true,
          head: { sha: "head", ref: "branch" },
          merge_commit_sha: "integrated",
        });
  });
  const gateway = new RealGitHubGateway("a/b", {}, client);
  assert.deepEqual(
    await gateway.merge(
      { number: 4, headSha: "head", branch: "branch" },
      "head",
    ),
    { integratedSha: "integrated" },
  );
  assert.deepEqual(JSON.parse(calls[0].body), {
    sha: "head",
    merge_method: "merge",
  });
  await assert.rejects(
    gateway.merge({ number: 4, headSha: "head", branch: "branch" }, "other"),
    /expected head/,
  );
  assert.equal(calls.length, 2);
});

test("cancelled in-flight mutation retains unknown outcome", async () => {
  const controller = new AbortController();
  const client = clientFor(async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  });
  await assert.rejects(
    withProcessCancellation(controller.signal, () =>
      client.request("POST", "repos/a/b/issues", { title: "x" }),
    ),
    GitHubOutcomeUnknown,
  );
});

test("primary exhaustion on a successful response gates the next request", async () => {
  const calls = [];
  let reset;
  const client = clientFor(async () => {
    calls.push(Date.now());
    reset ??= Date.now() + 80;
    return json(
      {},
      200,
      calls.length === 1
        ? {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset / 1000),
          }
        : {},
    );
  });
  await client.request("GET", "repos/a/b/issues/1");
  await client.request("GET", "repos/a/b/issues/2");
  assert.ok(calls[1] >= reset);
});

test("cancelled queued request cannot let later dispatch overtake its owner", async () => {
  const calls = [];
  let finish;
  const firstResponse = new Promise((resolve) => {
    finish = resolve;
  });
  const client = clientFor(async (url) => {
    calls.push(String(url));
    if (calls.length === 1) await firstResponse;
    return json({});
  });
  const first = client.request("GET", "repos/a/b/issues/1");
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = withProcessCancellation(controller.signal, () =>
    client.request("GET", "repos/a/b/issues/2"),
  );
  controller.abort();
  await assert.rejects(second);
  const third = client.request("GET", "repos/a/b/issues/3");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  finish();
  await Promise.all([first, third]);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /issues\/3$/);
});

test("native merge resumes its UUID without submitting another mutation", async () => {
  const { NativeStackDelivery } = await import(
    "../dist/delivery/native-stack.js"
  );
  const calls = [];
  let completed = false;
  const client = clientFor(async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      headers: options.headers,
    });
    if (String(url).endsWith("/merge-async/saved-uuid")) {
      completed = true;
      return json({ status: "merged", details: { sha: "integrated" } });
    }
    const number = Number(String(url).split("/").at(-1));
    return json({
      number,
      state: completed ? "closed" : "open",
      merged: completed,
      merged_at: completed ? "2026-09-29T00:00:00Z" : null,
      head: { ref: `branch-${number}`, sha: `head-${number}` },
      base: { ref: number === 1 ? "main" : "branch-1" },
      merge_commit_sha: completed ? "integrated" : null,
    });
  });
  const delivery = new NativeStackDelivery("a/b", client);
  assert.equal(
    await delivery.mergeStack(
      [
        { pullRequest: 1, branch: "branch-1", headSha: "head-1" },
        { pullRequest: 2, branch: "branch-2", headSha: "head-2" },
      ],
      "main",
      10,
      {
        resumeUuid: "saved-uuid",
        onPending: () => assert.fail("already persisted"),
        cancelled: () => false,
      },
    ),
    "integrated",
  );
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(
    calls.every(
      (call) => call.headers["x-github-api-version"] === "2026-03-10",
    ),
  );
});
