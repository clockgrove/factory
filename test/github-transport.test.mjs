import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { projectionClient } from "./support/projection-client.mjs";
import { RealGitHubGateway, projectedIssueBody } from "../dist/github.js";
import {
  GitHubClient,
  GitHubOutcomeUnknown,
  GitHubRequestError,
} from "../dist/github-client.js";
import { withProcessCancellation } from "../dist/process.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const clientFor = (fetch) =>
  new GitHubClient(new Octokit({ request: { fetch } }));
const integratedSha = "c".repeat(40);
const headSha = "a".repeat(40);
const item = {
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

function projectionTransport() {
  const fixture = projectionClient("a/b");
  fixture.issues.set(3, fixture.issue(3, { labels: ["factory:objective"] }));
  const urls = [];
  const fetch = async (url, options) => {
    urls.push(String(url));
    const path = new URL(String(url)).pathname.slice(1);
    const method = options.method ?? "GET";
    if (method === "GET" && path === "user")
      return json({ login: await fixture.client.viewer() });
    if (
      method === "GET" &&
      (path.endsWith("/labels") ||
        path.endsWith("/sub_issues") ||
        path.endsWith("/blocked_by") ||
        path.endsWith("/issues"))
    )
      return json(await fixture.client.paginate(path));
    try {
      return json(
        await fixture.client.request(
          method,
          path,
          options.body ? JSON.parse(options.body) : undefined,
        ),
      );
    } catch (error) {
      assert.ok(error instanceof GitHubRequestError);
      return json({ message: "Not Found" }, error.status);
    }
  };
  return { ...fixture, urls, fetch };
}

test("projection direct reads known identity without listing or replacement", async () => {
  const f = projectionTransport();
  f.issues.set(
    7,
    f.issue(7, {
      title: item.title,
      body: projectedIssueBody(item, 3),
      labels: ["factory:work-item"],
    }),
  );
  f.hierarchy.set(3, [7]);
  const gateway = new RealGitHubGateway("a/b", {}, clientFor(f.fetch));
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
  assert.ok(f.urls.some((url) => /issues\/7$/.test(url)));
  assert.ok(f.urls.every((url) => !/\/issues\?/.test(url)));
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("missing known issue fails without replacement", async () => {
  const f = projectionTransport();
  const gateway = new RealGitHubGateway(
    "a/b",
    {},
    clientFor((url, options) =>
      String(url).endsWith("/issues/7")
        ? json({ message: "Not found" }, 404)
        : f.fetch(url, options),
    ),
  );
  await assert.rejects(
    gateway.projectGraph({
      objectiveIssue: 3,
      graph: { items: [item] },
      knownIssues: { one: 7 },
      beforeCreate: () => assert.fail("must not replace"),
    }),
    /404/,
  );
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("projection persists intent before creation and identity before next work", async () => {
  const f = projectionTransport();
  const events = [];
  const gateway = new RealGitHubGateway(
    "a/b",
    {},
    clientFor(async (url, options) => {
      if (options.method === "POST" && String(url).endsWith("/issues"))
        events.push("create");
      return f.fetch(url, options);
    }),
  );
  await gateway.projectGraph({
    objectiveIssue: 3,
    graph: { items: [item] },
    beforeCreate: () => events.push("intent"),
    projected: (_id, number) => events.push(`saved:${number}`),
  });
  assert.deepEqual(events, ["intent", "create", "saved:2"]);
  const create = f.calls.find(
    (call) => call.method === "POST" && call.route.endsWith("/issues"),
  );
  assert.deepEqual(create.body.labels, ["factory:work-item"]);
});

// Current 2026-03-10 PR responses for an open PR and a merged PR.
const openPull = {
  number: 4,
  state: "open",
  merged: false,
  head: { sha: headSha, ref: "branch" },
  base: { ref: "main" },
};
const mergedPull = { ...openPull, state: "closed", merged: true };

test("regular merge sends the exact expected head and verifies integrated identity", async () => {
  const calls = [];
  let merged = false;
  const client = clientFor(async (_url, options) => {
    calls.push(options);
    if (options.method !== "PUT") return json(merged ? mergedPull : openPull);
    merged = true;
    return json({ merged: true, sha: integratedSha });
  });
  const gateway = new RealGitHubGateway("a/b", {}, client);
  assert.deepEqual(
    await gateway.merge({ number: 4, headSha, branch: "branch" }, headSha),
    { integratedSha },
  );
  // Look up the PR first, merge it at the exact head, then confirm it.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PUT", "GET"],
  );
  assert.deepEqual(JSON.parse(calls[1].body), {
    sha: headSha,
    merge_method: "merge",
  });
  await assert.rejects(
    gateway.merge({ number: 4, headSha, branch: "branch" }, "other"),
    /expected head/,
  );
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) => call.headers["x-github-api-version"] === "2026-03-10",
    ),
  );
});

// 2026-03-10 PR responses omit merge_commit_sha, so an already merged PR's
// merge commit comes from its timeline's "merged" event.
test("regular merge of an already merged PR at the expected head confirms it without merging again", async () => {
  const requests = [];
  const client = clientFor(async (url, options) => {
    requests.push(`${options.method} ${new URL(String(url)).pathname}`);
    if (String(url).includes("/timeline"))
      return json([{ event: "merged", commit_id: integratedSha }]);
    return json(mergedPull);
  });
  const gateway = new RealGitHubGateway("a/b", {}, client);
  // Repeating the step after a lost response converges on the same result.
  for (let attempt = 0; attempt < 2; attempt++)
    assert.deepEqual(
      await gateway.merge({ number: 4, headSha, branch: "branch" }, headSha),
      { integratedSha },
    );
  assert.ok(!requests.some((request) => request.startsWith("PUT")));
  assert.equal(
    requests.filter((request) => request.endsWith("/timeline")).length,
    2,
  );
});

test("regular merge refuses a PR already merged at a different head or branch", async () => {
  for (const detail of [
    { head: { sha: "b".repeat(40), ref: "branch" } },
    { head: { sha: headSha, ref: "changed" } },
  ]) {
    const methods = [];
    const client = clientFor(async (_url, options) => {
      methods.push(options.method);
      return json({ ...mergedPull, ...detail });
    });
    await assert.rejects(
      new RealGitHubGateway("a/b", {}, client).merge(
        { number: 4, headSha, branch: "branch" },
        headSha,
      ),
      /PR #4 was merged at a different head/,
    );
    assert.deepEqual(methods, ["GET"]);
  }
});

test("regular merge refuses missing, malformed or conflicting timeline merge evidence", async () => {
  for (const events of [
    [],
    [{ event: "merged", commit_id: "not-a-commit" }],
    [
      { event: "merged", commit_id: integratedSha },
      { event: "merged", commit_id: "d".repeat(40) },
    ],
  ]) {
    const client = clientFor(async (url) =>
      String(url).includes("/timeline") ? json(events) : json(mergedPull),
    );
    await assert.rejects(
      new RealGitHubGateway("a/b", {}, client).merge(
        { number: 4, headSha, branch: "branch" },
        headSha,
      ),
      /merge evidence/,
    );
  }
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
      return json({ status: "merged", details: { sha: integratedSha } });
    }
    if (String(url).includes("/timeline?"))
      return json([{ event: "merged", commit_id: integratedSha }]);
    const number = Number(String(url).split("/").at(-1));
    return json({
      number,
      state: completed ? "closed" : "open",
      merged: completed,
      merged_at: completed ? "2026-09-29T00:00:00Z" : null,
      head: { ref: `branch-${number}`, sha: `head-${number}` },
      base: { ref: number === 1 ? "main" : "branch-1" },
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
    integratedSha,
  );
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(
    calls.every(
      (call) => call.headers["x-github-api-version"] === "2026-03-10",
    ),
  );
});

test("regular merge rejects unsuccessful acknowledgement and changed current PR identity", async () => {
  for (const [result, detail, expected] of [
    [{ merged: false, sha: integratedSha }, undefined, /did not produce/],
    [{ merged: true }, undefined, /did not produce/],
    [{ merged: true, sha: "not-a-commit" }, undefined, /did not produce/],
    [{ merged: true, sha: integratedSha }, { state: "open" }, /not confirmed/],
    [{ merged: true, sha: integratedSha }, { merged: false }, /not confirmed/],
    [
      { merged: true, sha: integratedSha },
      { head: { sha: "b".repeat(40), ref: "branch" } },
      /not confirmed/,
    ],
    [
      { merged: true, sha: integratedSha },
      { head: { sha: headSha, ref: "changed" } },
      /not confirmed/,
    ],
  ]) {
    const methods = [];
    const client = clientFor(async (_url, options) => {
      methods.push(options.method);
      assert.equal(options.headers["x-github-api-version"], "2026-03-10");
      if (options.method === "PUT") return json(result);
      // The lookup before merging sees the open PR; the confirmation after.
      return methods.includes("PUT")
        ? json({ ...mergedPull, ...detail })
        : json(openPull);
    });
    await assert.rejects(
      new RealGitHubGateway("a/b", {}, client).merge(
        { number: 4, headSha, branch: "branch" },
        headSha,
      ),
      expected,
    );
    assert.equal(methods.filter((method) => method === "PUT").length, 1);
    assert.equal(methods[0], "GET");
  }
});

// Current 2026-03-10 PR responses omit merge_commit_sha. Merge identity comes
// from successful merge acknowledgements or the authenticated issue timeline.
async function nativeMergeFixture(mode, options = {}) {
  const { NativeStackDelivery } = await import(
    "../dist/delivery/native-stack.js"
  );
  const layers = [1, 2].map((number) => ({
    pullRequest: number,
    branch: `branch-${number}`,
    headSha: String(number).repeat(40),
  }));
  const calls = [];
  const pending = [];
  let completed = mode === "already";
  const pull = (number) => ({
    number,
    state: completed ? "closed" : "open",
    merged: completed,
    merged_at: completed ? "2026-09-29T00:00:00Z" : null,
    head: { ref: `branch-${number}`, sha: String(number).repeat(40) },
    base: { ref: number === 1 ? "main" : "branch-1" },
    ...(completed && options.changedHead
      ? { head: { ref: `branch-${number}`, sha: "e".repeat(40) } }
      : {}),
  });
  const client = clientFor(async (url, request) => {
    const path = new URL(url).pathname;
    const query = new URL(url).searchParams;
    assert.equal(request.headers["x-github-api-version"], "2026-03-10");
    calls.push({ path, method: request.method, page: query.get("page") });
    if (path.endsWith("/timeline")) {
      const number = Number(path.split("/").at(-2));
      const events = options.events?.(number) ?? [
        { event: "merged", commit_id: integratedSha },
      ];
      const page = Number(query.get("page"));
      return json(events.slice((page - 1) * 100, page * 100));
    }
    if (path.endsWith("/merge-async/saved-uuid")) {
      completed = true;
      return json({
        status: "merged",
        details: { sha: options.asyncSha ?? integratedSha },
      });
    }
    if (path.endsWith("/merge-async")) {
      assert.deepEqual(JSON.parse(request.body), {
        sha: layers[1].headSha,
        merge_method: "merge",
        merge_action: "default",
      });
      completed = true;
      if (mode === "pending")
        return json({ status: "pending", details: { uuid: "saved-uuid" } });
      if (mode === "no-uuid") return json({ status: "queued", details: {} });
      return json({
        status: "merged",
        details: { sha: options.asyncSha ?? integratedSha },
      });
    }
    if (path.endsWith("/stacks"))
      return json([
        {
          number: 10,
          base: { ref: "main" },
          pull_requests: layers.map((layer) => pull(layer.pullRequest)),
        },
      ]);
    return json(pull(Number(path.split("/").at(-1))));
  });
  const delivery = new NativeStackDelivery("a/b", client);
  const result = await delivery.mergeStack(layers, "main", 10, {
    ...(mode === "resume" ? { resumeUuid: "saved-uuid" } : {}),
    onPending: (uuid) => pending.push(uuid),
    cancelled: () => false,
  });
  return { result, calls, pending };
}

for (const mode of ["immediate", "pending", "no-uuid", "resume", "already"])
  test(`native ${mode} merge resolves current timeline evidence without obsolete PR fields`, async () => {
    const { result, calls, pending } = await nativeMergeFixture(mode);
    assert.equal(result, integratedSha);
    assert.equal(
      calls.filter((call) => call.method === "PUT").length,
      ["resume", "already"].includes(mode) ? 0 : 1,
    );
    assert.deepEqual(pending, mode === "pending" ? ["saved-uuid"] : []);
    assert.ok(calls.some((call) => call.path.endsWith("/issues/1/timeline")));
    assert.ok(calls.some((call) => call.path.endsWith("/issues/2/timeline")));
  });

test("native merge evidence spans every timeline page and ignores unrelated events", async () => {
  const { result, calls } = await nativeMergeFixture("already", {
    events: () => [
      ...Array.from({ length: 100 }, () => ({
        event: "commented",
        commit_id: "irrelevant",
      })),
      { event: "merged", commit_id: integratedSha },
    ],
  });
  assert.equal(result, integratedSha);
  assert.equal(
    calls.filter((call) => call.path.endsWith("/timeline") && call.page === "2")
      .length,
    2,
  );
});

test("native merge refuses missing, malformed, conflicting and disagreeing commit evidence", async () => {
  for (const [events, expected] of [
    [() => [], /missing or conflicting/],
    [
      () => [{ event: "closed", commit_id: integratedSha }],
      /missing or conflicting/,
    ],
    [() => [{ event: "merged" }], /malformed/],
    [() => [{ event: "merged", commit_id: null }], /malformed/],
    [() => [{ event: "merged", commit_id: "abbreviated" }], /malformed/],
    [
      () => [
        { event: "merged", commit_id: integratedSha },
        { event: "merged", commit_id: "d".repeat(40) },
      ],
      /missing or conflicting/,
    ],
    [
      (number) => [{ event: "merged", commit_id: String(number).repeat(40) }],
      /different merge commits/,
    ],
  ])
    await assert.rejects(nativeMergeFixture("already", { events }), expected);
  await assert.rejects(
    nativeMergeFixture("resume", { asyncSha: "d".repeat(40) }),
    /differs from the async result/,
  );
  await assert.rejects(
    nativeMergeFixture("resume", { changedHead: true }),
    /matching integrated head/,
  );
  await assert.rejects(
    nativeMergeFixture("already", { changedHead: true }),
    /Merged native stack head changed/,
  );
});

for (const status of [403, 404, 500])
  test(`completed read rejection retains only structured HTTP ${status}`, async () => {
    let calls = 0;
    const client = clientFor(async () => {
      calls++;
      return json(
        { message: "private server data", errors: ["private payload"] },
        status,
      );
    });
    await assert.rejects(
      client.request("GET", "repos/a/b/issues/7/parent"),
      (error) =>
        error instanceof GitHubRequestError &&
        error.status === status &&
        error.message === `GitHub request failed (HTTP ${status})` &&
        !JSON.stringify(error).includes("private"),
    );
    assert.equal(calls, 1);
  });
