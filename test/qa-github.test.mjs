import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient } from "../dist/github-client.js";

const head = "a".repeat(40);
const name = "required / dependency versions";
const run = (overrides = {}) => ({
  id: 71,
  app: { id: 15368 },
  head_sha: head,
  name,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/target/runs/71",
  ...overrides,
});
function gateway(fetch) {
  return new RealGitHubGateway(
    "example/target",
    {},
    new GitHubClient(new Octokit({ request: { fetch } })),
  );
}
function response(check_runs) {
  return new Response(
    JSON.stringify({ total_count: check_runs.length, check_runs }),
    { headers: { "content-type": "application/json" } },
  );
}

test("named CI uses authenticated exact-candidate latest-check API and retains result identity", async () => {
  const github = gateway(async (url) => {
    const request = new URL(url);
    assert.equal(
      request.pathname,
      `/repos/example/target/commits/${head}/check-runs`,
    );
    assert.equal(request.searchParams.get("check_name"), name);
    assert.equal(request.searchParams.get("filter"), "latest");
    return response([run()]);
  });
  assert.deepEqual(await github.namedCheck(head, name), {
    id: 71,
    headSha: head,
    name,
    status: "completed",
    conclusion: "success",
    detailsUrl: "https://github.com/example/target/runs/71",
  });
});

test("named CI does not replace missing, unrelated, pending, or failed results with success", async () => {
  for (const candidates of [
    [],
    [run({ name: "other" })],
    [run({ head_sha: "b".repeat(40) })],
  ]) {
    assert.equal(
      await gateway(async () => response(candidates)).namedCheck(head, name),
      undefined,
    );
  }
  for (const candidate of [
    run({ status: "in_progress", conclusion: null }),
    run({ conclusion: "failure" }),
  ]) {
    const actual = await gateway(async () => response([candidate])).namedCheck(
      head,
      name,
    );
    assert.equal(actual.status, candidate.status);
    assert.equal(actual.conclusion, candidate.conclusion);
  }
  await assert.rejects(
    gateway(async () => response([run(), run({ id: 72 })])).namedCheck(
      head,
      name,
    ),
    /ambiguous/,
  );
});

test("named CI reads later result pages and preserves transport failures", async () => {
  const pages = [];
  const github = gateway(async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return response(
      page === 1
        ? Array.from({ length: 100 }, (_, id) => run({ id, name: "other" }))
        : [run()],
    );
  });
  assert.equal((await github.namedCheck(head, name)).id, 71);
  assert.deepEqual(pages, [1, 2]);
  let calls = 0;
  await assert.rejects(
    gateway(async () => {
      calls++;
      throw new Error("transport unavailable");
    }).namedCheck(head, name),
  );
  assert.equal(calls, 1);
});

test("PR observation retains successful exact-head checks and same-app repeated triggers", async () => {
  for (const [candidates, expected] of [
    [[run()], [71]],
    [[], []],
    [[run({ head_sha: "b".repeat(40) })], []],
    [[run({ status: "in_progress", conclusion: null })], []],
    [[run({ conclusion: "failure" })], []],
    [[run({ conclusion: "neutral" })], []],
    [[run({ conclusion: "skipped" })], []],
    [[run(), run({ id: 72 })], [71]],
    [[run({ app: undefined })], [71]],
    [[run(), run({ id: 72, app: { id: 99 } })], []],
    [[run(), run({ id: 72, app: undefined })], []],
    [[run({ app: null }), run({ id: 72, app: null })], []],
    [[run({ app: { id: 0 } }), run({ id: 72, app: { id: 0 } })], []],
    [[run(), run({ id: 72, head_sha: "b".repeat(40) })], []],
    [[run(), run({ id: 72, status: "queued", conclusion: null })], []],
    [[run(), run({ id: 72, conclusion: "failure" })], []],
    [[run(), run({ id: 72, conclusion: "neutral" })], []],
    [[run(), run({ id: 72, conclusion: "skipped" })], []],
    [[run(), run({ id: 0 })], []],
    [[run(), run({ id: 72, html_url: "" })], []],
  ]) {
    const actual = await observeChecks([candidates]);
    assert.deepEqual(
      actual.namedChecks.map((check) => check.id),
      expected,
    );
    for (const check of actual.namedChecks) {
      assert.equal(check.headSha, head);
      assert.equal(check.name, name);
      assert.equal(check.conclusion, "success");
      assert.equal(
        check.detailsUrl,
        candidates.find((run) => run.id === check.id).html_url,
      );
    }
    if (candidates.some((check) => check.conclusion === "failure"))
      assert.equal(actual.checks, "failing");
    else if (candidates.some((check) => check.status !== "completed"))
      assert.equal(actual.checks, "pending");
    else assert.equal(actual.checks, "passing");
    assert.equal(actual.mergeReadiness, "ready");
  }
});

async function observeChecks(pages, readiness = "CLEAN") {
  const github = gateway(async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/pulls/1"))
      return new Response(
        JSON.stringify({
          state: "open",
          merged: false,
          head: { sha: head, ref: "factory/item" },
          base: { ref: "main" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (request.pathname === "/graphql")
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 1,
                headRefOid: head,
                headRefName: "factory/item",
                baseRefName: "main",
                mergeStateStatus: readiness,
              },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (request.pathname.endsWith("/check-runs")) {
      assert.equal(request.searchParams.get("filter"), "latest");
      const page = Number(request.searchParams.get("page"));
      return response(pages[page - 1] ?? []);
    }
    assert.equal(
      request.pathname,
      `/repos/example/target/commits/${head}/status`,
    );
    return new Response(JSON.stringify({ state: "success", total_count: 0 }), {
      headers: { "content-type": "application/json" },
    });
  });
  return github.observe({
    number: 1,
    branch: "factory/item",
    headSha: head,
  });
}

test("PR receipt grouping considers every latest-check page", async () => {
  const firstPage = [
    run(),
    ...Array.from({ length: 99 }, (_, index) =>
      run({
        id: 100 + index,
        name: `other-${index}`,
      }),
    ),
  ];
  for (const [last, retained, checks] of [
    [run({ id: 72 }), true, "passing"],
    [run({ id: 72, conclusion: "failure" }), false, "failing"],
    [
      run({ id: 72, status: "in_progress", conclusion: null }),
      false,
      "pending",
    ],
    [run({ id: 72, app: { id: 99 } }), false, "passing"],
  ]) {
    const actual = await observeChecks([firstPage, [last]]);
    assert.equal(
      actual.namedChecks.some((check) => check.name === name),
      retained,
    );
    assert.equal(actual.checks, checks);
  }
});

test("successful repeated-check receipts preserve current protection readiness", async () => {
  for (const [readiness, expected] of [
    ["BLOCKED", "waiting"],
    ["DIRTY", "conflict"],
  ]) {
    const actual = await observeChecks([[run(), run({ id: 72 })]], readiness);
    assert.equal(actual.namedChecks.length, 1);
    assert.equal(actual.mergeReadiness, expected);
  }
});
