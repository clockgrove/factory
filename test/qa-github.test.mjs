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
