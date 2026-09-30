import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient } from "../dist/github-client.js";

const head = "a".repeat(40);
const name = "required / dependency versions";
const run = (overrides = {}) => ({
  id: 71,
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

test("PR observation exposes only successful unambiguous checks on its exact head", async () => {
  for (const [candidates, expected] of [
    [[run()], [71]],
    [[], []],
    [[run({ head_sha: "b".repeat(40) })], []],
    [[run({ status: "in_progress", conclusion: null })], []],
    [[run({ conclusion: "failure" })], []],
    [[run({ conclusion: "neutral" })], []],
    [[run({ conclusion: "skipped" })], []],
    [[run(), run({ id: 72 })], []],
  ]) {
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
                  mergeStateStatus: "CLEAN",
                },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      if (request.pathname.endsWith("/check-runs")) {
        assert.equal(request.searchParams.get("filter"), "latest");
        return response(candidates);
      }
      assert.equal(
        request.pathname,
        `/repos/example/target/commits/${head}/status`,
      );
      return new Response(
        JSON.stringify({ state: "success", total_count: 0 }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    const actual = await github.observe({
      number: 1,
      branch: "factory/item",
      headSha: head,
    });
    assert.deepEqual(
      actual.namedChecks.map((check) => check.id),
      expected,
    );
    for (const check of actual.namedChecks) {
      assert.equal(check.headSha, head);
      assert.equal(check.name, name);
      assert.equal(check.conclusion, "success");
    }
    if (candidates.some((check) => check.conclusion === "failure"))
      assert.equal(actual.checks, "failing");
  }
});
