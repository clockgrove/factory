import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Octokit } from "@octokit/core";
import { NativeStackDelivery } from "../dist/delivery/native-stack.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import {
  GitHubClient,
  GitHubOutcomeUnknown,
  GitHubRequestError,
} from "../dist/github-client.js";
import { RealGitHubGateway } from "../dist/github.js";
import {
  ENDPOINTS,
  GitHubHttpFake,
  faults,
  gitTransportEnvironment,
  rewritingFetch,
} from "./support/github-http-fake.mjs";
import { createTarget, git } from "./support/integration-fixture.mjs";

// The strict fake behaves like GitHub where Factory's recovery depends on it,
// and Factory's real gateway runs against it unchanged.

const repo = "/repos/{owner}/{repo}";
const run = promisify(execFile);

const commit = (checkout, message) =>
  git(
    checkout,
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory-test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );

async function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-http-fake-"));
  const target = createTarget(root);
  const fake = await new GitHubHttpFake({
    repository: "example/target",
    origin: target.origin,
    issues: [{ title: "Objective", body: "Objective body" }],
    ...options,
  }).start();
  t.after(async () => {
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const client = new GitHubClient(
    new Octokit({ request: { fetch: rewritingFetch(fake.apiUrl) } }),
  );
  const gateway = new RealGitHubGateway(
    "example/target",
    new NativeStackDelivery("example/target", client),
    client,
  );
  git(
    target.checkout,
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/target.git",
  );
  const env = { ...process.env, ...gitTransportEnvironment(fake.gitUrl) };
  /** Commit on a new branch and push it through the fake's Git transport. */
  const pushBranch = async (branch, from = "main") => {
    git(target.checkout, "checkout", "-q", "-b", branch, from);
    commit(target.checkout, branch);
    const sha = git(target.checkout, "rev-parse", "HEAD");
    // Asynchronous: the fake serving the push runs in this process.
    await run(
      "git",
      [
        "-C",
        target.checkout,
        "push",
        "-q",
        "origin",
        `${sha}:refs/heads/${branch}`,
      ],
      { env },
    );
    git(target.checkout, "checkout", "-q", "main");
    return sha;
  };
  return { fake, client, gateway, target, env, pushBranch };
}

test("every served endpoint is named in the request log", () => {
  assert.ok(ENDPOINTS.includes(`PUT ${repo}/pulls/{number}/merge`));
  assert.ok(ENDPOINTS.includes("GIT push"));
  assert.equal(new Set(ENDPOINTS).size, ENDPOINTS.length);
});

test("a second PR for an open head is refused with 422, a merged PR with 405, a stale head with 409", async (t) => {
  const { fake, client, pushBranch } = await setup(t);
  const sha = await pushBranch("feature");
  const created = await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  assert.equal(created.head.sha, sha);
  assert.equal("merge_commit_sha" in created, false);
  await assert.rejects(
    client.request("POST", "repos/example/target/pulls", {
      head: "feature",
      base: "main",
      title: "Again",
    }),
    (error) => error instanceof GitHubRequestError && error.status === 422,
  );
  await assert.rejects(
    client.request(
      "PUT",
      `repos/example/target/pulls/${created.number}/merge`,
      {
        sha: "f".repeat(40),
        merge_method: "merge",
      },
    ),
    (error) => error instanceof GitHubRequestError && error.status === 409,
  );
  const merged = await client.request(
    "PUT",
    `repos/example/target/pulls/${created.number}/merge`,
    { sha, merge_method: "merge" },
  );
  assert.equal(merged.merged, true);
  await assert.rejects(
    client.request(
      "PUT",
      `repos/example/target/pulls/${created.number}/merge`,
      {
        sha,
        merge_method: "merge",
      },
    ),
    (error) => error instanceof GitHubRequestError && error.status === 405,
  );
  // The merge commit is on the default branch and only on the timeline.
  const main = git(fake.origin, "rev-parse", "refs/heads/main");
  assert.equal(main, merged.sha);
  const timeline = await client.paginate(
    `repos/example/target/issues/${created.number}/timeline`,
  );
  assert.deepEqual(
    timeline
      .filter((event) => event.event === "merged")
      .map((e) => e.commit_id),
    [merged.sha],
  );
  assert.equal(fake.effects(`PUT ${repo}/pulls/{number}/merge`).length, 1);
});

test("lists paginate with Link headers and the issue list includes pull requests", async (t) => {
  const { fake, pushBranch, client } = await setup(t, {});
  for (let index = 0; index < 4; index++)
    fake.openForeignIssue(`Issue ${index}`);
  await pushBranch("feature");
  await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const response = await fetch(
    `${fake.apiUrl}/repos/example/target/issues?state=all&per_page=2&page=1`,
  );
  assert.match(response.headers.get("link"), /page=2>; rel="next"/);
  assert.match(response.headers.get("link"), /page=3>; rel="last"/);
  const all = await client.paginate("repos/example/target/issues?state=all");
  assert.equal(all.length, 6);
  assert.equal(all.filter((issue) => issue.pull_request).length, 1);
});

test("a dropped response applies the effect and the client reports an unknown outcome", async (t) => {
  const { fake, client } = await setup(t);
  fake.inject({ match: `POST ${repo}/issues`, kind: "drop" });
  await assert.rejects(
    client.request("POST", "repos/example/target/issues", { title: "Lost" }),
    (error) => error instanceof GitHubOutcomeUnknown,
  );
  assert.equal(fake.effects(`POST ${repo}/issues`).length, 1);
  assert.equal(
    Object.values(fake.state.issues).filter((issue) => issue.title === "Lost")
      .length,
    1,
  );
});

test("an unavailable burst and rate limits are answered without an effect", async (t) => {
  const { fake, client } = await setup(t);
  fake.inject({
    match: `POST ${repo}/issues`,
    times: 2,
    ...faults.unavailable(),
  });
  fake.inject({
    match: `POST ${repo}/issues`,
    occurrence: 3,
    ...faults.secondaryRateLimit({ retryAfter: 0 }),
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      client.request("POST", "repos/example/target/issues", { title: "X" }),
      (error) => error instanceof GitHubOutcomeUnknown,
    );
  await assert.rejects(
    client.request("POST", "repos/example/target/issues", { title: "X" }),
    (error) => error instanceof GitHubRequestError && error.status === 403,
  );
  await client.request("POST", "repos/example/target/issues", { title: "X" });
  assert.deepEqual(
    fake.requests(`POST ${repo}/issues`).map((entry) => entry.status),
    [503, 503, 403, 201],
  );
  assert.equal(fake.effects(`POST ${repo}/issues`).length, 1);
});

test("a lagging read sees the state before the write", async (t) => {
  const { fake, client, pushBranch } = await setup(t, {
    lag: [{ read: `GET ${repo}/pulls`, after: `POST ${repo}/pulls`, reads: 1 }],
  });
  await pushBranch("feature");
  await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const route = "repos/example/target/pulls?state=open&head=example%3Afeature";
  assert.equal((await client.paginate(route)).length, 0);
  assert.equal((await client.paginate(route)).length, 1);
  assert.equal(fake.requests().filter((entry) => entry.unhandled).length, 0);
});

test("regular delivery finds the PR whose creation response was lost instead of creating another", async (t) => {
  const { fake, gateway, target } = await setup(t);
  commit(target.checkout, "change");
  const head = git(target.checkout, "rev-parse", "HEAD");
  const tree = git(target.checkout, "rev-parse", "HEAD^{tree}");
  git(target.checkout, "reset", "-q", "--hard", "HEAD~1");
  fake.inject({ match: `POST ${repo}/pulls`, kind: "drop" });
  const delivery = new RegularDelivery(target.checkout, gateway);
  const request = {
    baseSha: git(target.checkout, "rev-parse", "HEAD"),
    changeRef: head,
    treeSha: tree,
    branch: "factory/objective-1/alpha",
    item: { id: "alpha", title: "Alpha" },
  };
  const previous = process.env.PATH;
  const previousGit = process.env.FACTORY_FAKE_GITHUB_GIT;
  Object.assign(process.env, gitTransportEnvironment(fake.gitUrl));
  try {
    await assert.rejects(delivery.publish(request), GitHubOutcomeUnknown);
    const published = await delivery.publish(request);
    assert.equal(published.headSha, head);
  } finally {
    process.env.PATH = previous;
    if (previousGit === undefined) delete process.env.FACTORY_FAKE_GITHUB_GIT;
    else process.env.FACTORY_FAKE_GITHUB_GIT = previousGit;
  }
  assert.equal(fake.effects(`POST ${repo}/pulls`).length, 1);
  assert.equal(fake.requests(`POST ${repo}/pulls`).length, 1);
  assert.equal(fake.pullsForBranch("factory/objective-1/alpha").length, 1);
});

test("the gateway refuses two open PRs for one branch and an existing PR with another head", async (t) => {
  const { fake, gateway, pushBranch } = await setup(t);
  const sha = await pushBranch("factory/objective-1/alpha");
  const number = fake.state.nextNumber;
  fake.createIssueRecord(
    fake.state,
    { title: "Alpha" },
    {
      number,
      head: { ref: "factory/objective-1/alpha", sha },
      base: { ref: "main", sha },
    },
  );
  await assert.rejects(
    gateway.findOpenPullRequest(
      "factory/objective-1/alpha",
      "main",
      "a".repeat(40),
    ),
    /changed head or base/,
  );
  assert.deepEqual(
    await gateway.findOpenPullRequest("factory/objective-1/alpha", "main", sha),
    { number, branch: "factory/objective-1/alpha", headSha: sha },
  );
  // Another actor opened a second PR from the same head into another base.
  const second = fake.state.nextNumber;
  fake.createIssueRecord(
    fake.state,
    { title: "Alpha again" },
    {
      number: second,
      head: { ref: "factory/objective-1/alpha", sha },
      base: { ref: "release", sha },
    },
  );
  await assert.rejects(
    gateway.findOpenPullRequest("factory/objective-1/alpha", "main", sha),
    /Multiple open PRs/,
  );
});

test("stacks: listing fields, a nonexistent PR is 422, and merge-async follows the documented statuses", async (t) => {
  const { fake, client, pushBranch } = await setup(t, { asyncMergePolls: 2 });
  const pull = async (head, base) =>
    client.request("POST", "repos/example/target/pulls", {
      head,
      base,
      title: head,
    });
  await pushBranch("one");
  await pushBranch("two", "one");
  await pushBranch("three", "two");
  const one = await pull("one", "main");
  const two = await pull("two", "one");
  const three = await pull("three", "two");
  await assert.rejects(
    client.request("POST", "repos/example/target/stacks", {
      pull_requests: [one.number, 999],
    }),
    (error) => error instanceof GitHubRequestError && error.status === 422,
  );
  const stack = await client.request("POST", "repos/example/target/stacks", {
    pull_requests: [one.number, two.number, three.number],
  });
  const [listed] = await client.request(
    "GET",
    `repos/example/target/stacks?pull_request=${two.number}`,
  );
  assert.equal(listed.number, stack.number);
  assert.equal(typeof listed.id, "number");
  assert.equal(typeof listed.node_id, "string");
  assert.equal(listed.open, true);
  // Merging the middle PR includes the PR below it, not the one above.
  const accepted = await client.request(
    "PUT",
    `repos/example/target/pulls/${two.number}/merge-async`,
    { sha: two.head.sha, merge_method: "merge", merge_action: "default" },
  );
  assert.equal(accepted.status, "pending");
  // A repeated request while pending is 409 with the pending request.
  const conflict = await fetch(
    `${fake.apiUrl}/repos/example/target/pulls/${two.number}/merge-async`,
    {
      method: "PUT",
      body: JSON.stringify({ sha: two.head.sha, merge_method: "merge" }),
    },
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).details.uuid, accepted.details.uuid);
  let polled;
  for (let poll = 0; poll < 2; poll++)
    polled = await client.request(
      "GET",
      `repos/example/target/pulls/${two.number}/merge-async/${accepted.details.uuid}`,
    );
  assert.equal(polled.status, "merged");
  assert.ok(fake.state.pulls[one.number].merged_at);
  assert.ok(fake.state.pulls[two.number].merged_at);
  assert.equal(fake.state.pulls[three.number].merged_at, undefined);
  // Already merged: 200 with the merge commit, and no second merge.
  const again = await client.request(
    "PUT",
    `repos/example/target/pulls/${two.number}/merge-async`,
    { sha: two.head.sha, merge_method: "merge" },
  );
  assert.deepEqual(
    [again.status, again.details.sha],
    ["merged", polled.details.sha],
  );
  assert.equal(fake.state.pulls[two.number].merges, 1);
  // A closed PR is not ready to merge.
  await client.request("PATCH", `repos/example/target/issues/${three.number}`, {
    state: "closed",
  });
  await assert.rejects(
    client.request(
      "PUT",
      `repos/example/target/pulls/${three.number}/merge-async`,
      { sha: three.head.sha, merge_method: "merge" },
    ),
    (error) => error instanceof GitHubRequestError && error.status === 400,
  );
});

test("every response carries rate-limit headers; a duplicate PR is one 422 error entry", async (t) => {
  const { fake, client, pushBranch } = await setup(t);
  await pushBranch("feature");
  await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const duplicate = await fetch(`${fake.apiUrl}/repos/example/target/pulls`, {
    method: "POST",
    body: JSON.stringify({ head: "feature", base: "main", title: "Again" }),
  });
  assert.equal(duplicate.status, 422);
  assert.ok(duplicate.headers.get("x-ratelimit-reset"));
  const body = await duplicate.json();
  assert.equal(body.errors.length, 1);
  assert.match(body.errors[0].message, /A pull request already exists/);
  fake.inject({ match: `GET ${repo}`, ...faults.secondaryRateLimit() });
  const limited = await fetch(`${fake.apiUrl}/repos/example/target`);
  assert.equal(limited.status, 403);
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "4999");
  assert.ok(limited.headers.get("x-ratelimit-reset"));
});
