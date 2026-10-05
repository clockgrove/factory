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
import { faultOf } from "../dist/fault.js";
import { GitHubClient, GitHubRequestError } from "../dist/github-client.js";
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
/** A mutation that may have taken effect: transient, outcome unknown. */
const unknownOutcome = (error) => {
  const fault = faultOf(error);
  return fault.kind === "transient" && fault.outcomeUnknown === true;
};

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

test("a second PR for an open head is refused with 422, a stale head with 409; a merged PR answers 200 with its merge", async (t) => {
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
  // Real GitHub (#627): merging an already merged PR answers 200 with the
  // same merge commit and merges nothing again.
  const again = await client.request(
    "PUT",
    `repos/example/target/pulls/${created.number}/merge`,
    { sha, merge_method: "merge" },
  );
  assert.deepEqual([again.merged, again.sha], [true, merged.sha]);
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

test("lists paginate with Link headers, the issue list by cursor, and it includes pull requests", async (t) => {
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
  // The issue list paginates with a cursor (#630): only rel="next". Like
  // GitHub, the link names the repository by id and carries a page number
  // next to the cursor (#646).
  const link = response.headers.get("link");
  assert.match(
    link,
    /^<https:\/\/api\.github\.com\/repositories\/\d+\/issues\?[^>]*[?&]after=[^&>]+[^>]*>; rel="next"$/,
  );
  assert.match(link, /[?&]page=2[&>]/);
  assert.doesNotMatch(link, /rel="last"/);
  const second = await fetch(
    link
      .slice(1, link.indexOf(">"))
      .replace("https://api.github.com", fake.apiUrl),
  );
  assert.deepEqual(
    (await second.json()).map((issue) => issue.number),
    [4, 3],
  );
  const paged = await fetch(
    `${fake.apiUrl}/repos/example/target/issues?state=all&per_page=2&page=2`,
  );
  assert.equal(paged.status, 422);
  const all = await client.paginate("repos/example/target/issues?state=all");
  assert.equal(all.length, 6);
  assert.equal(all.filter((issue) => issue.pull_request).length, 1);
});

test("paginate follows GitHub's repositories/{id} Link URLs past the first page", async (t) => {
  const { fake, client } = await setup(t, {});
  const before = fake.state.nextNumber;
  for (let index = 0; index < 120; index++)
    fake.openForeignIssue(`Issue ${index}`);
  // The cursor list (issues) and a page-number list (comments) (#646).
  const issues = await client.paginate("repos/example/target/issues?state=all");
  const numbers = new Set(issues.map((issue) => issue.number));
  assert.equal(numbers.size, issues.length);
  for (let number = before; number < before + 120; number++)
    assert.ok(numbers.has(number), `issue #${number} is listed`);
  const number = issues[0].number;
  for (let index = 0; index < 101; index++)
    await client.request(
      "POST",
      `repos/example/target/issues/${number}/comments`,
      { body: `comment ${index}` },
    );
  const comments = await client.paginate(
    `repos/example/target/issues/${number}/comments`,
  );
  assert.equal(comments.length, 101);
  const pages = fake.log.filter((entry) =>
    /^\/repos\/example\/target\/issues(\/\d+\/comments)?\?.*page=2/.test(
      entry.path,
    ),
  );
  assert.equal(pages.length, 2);
});

test("lag and merge-async timing read the fake's clock", async (t) => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { fake, client, pushBranch } = await setup(t, {
    now: () => now,
    // Real GitHub: a new issue shows in the list after 2.5-3.4 s, and a
    // merge-async stays pending for about 5-7 s.
    lag: [
      { read: `GET ${repo}/issues`, after: `POST ${repo}/issues`, ms: 3000 },
    ],
    asyncMergeMs: 6000,
  });
  const listed = async () =>
    (await client.paginate("repos/example/target/issues?state=all")).map(
      (issue) => issue.number,
    );
  const created = await client.request("POST", "repos/example/target/issues", {
    title: "New",
  });
  // A single-issue read does not lag; the list does, for 3 s however often
  // it is read.
  assert.equal(
    (
      await client.request(
        "GET",
        `repos/example/target/issues/${created.number}`,
      )
    ).number,
    created.number,
  );
  for (const elapsed of [0, 1000, 2999]) {
    now = Date.parse("2026-01-01T00:00:00Z") + elapsed;
    assert.equal((await listed()).includes(created.number), false);
  }
  now = Date.parse("2026-01-01T00:00:03Z");
  assert.equal((await listed()).includes(created.number), true);
  assert.equal(fake.lag[0].served, 3);

  await pushBranch("feature");
  const pull = await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const start = now;
  const accepted = await client.request(
    "PUT",
    `repos/example/target/pulls/${pull.number}/merge-async`,
    { sha: pull.head.sha, merge_method: "merge", merge_action: "default" },
  );
  assert.equal(accepted.status, "pending");
  const poll = () =>
    client.request(
      "GET",
      `repos/example/target/pulls/${pull.number}/merge-async/${accepted.details.uuid}`,
    );
  // However often it is polled, it is pending until its time.
  for (const elapsed of [0, 2000, 5999]) {
    now = start + elapsed;
    assert.equal((await poll()).status, "pending");
  }
  assert.equal(fake.state.pulls[pull.number].merged_at, undefined);
  // Once due it lands whether or not it is polled: the PR read shows it.
  now = start + 6000;
  const merged = await client.request(
    "GET",
    `repos/example/target/pulls/${pull.number}`,
  );
  assert.equal(merged.merged, true);
  assert.equal((await poll()).status, "merged");
  assert.equal(fake.state.pulls[pull.number].merges, 1);
});

test("a dropped response applies the effect and the client reports an unknown outcome", async (t) => {
  const { fake, client } = await setup(t);
  fake.inject({ match: `POST ${repo}/issues`, kind: "drop" });
  await assert.rejects(
    client.request("POST", "repos/example/target/issues", { title: "Lost" }),
    unknownOutcome,
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
      unknownOutcome,
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

test("a lag with a span and a read count serves the stale read even once the span passed (#815)", async (t) => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { fake, client } = await setup(t, {
    now: () => now,
    lag: [
      {
        read: `GET ${repo}/issues`,
        after: `POST ${repo}/issues`,
        ms: 3000,
        reads: 1,
      },
    ],
  });
  const listed = async () =>
    (await client.paginate("repos/example/target/issues?state=all")).map(
      (issue) => issue.number,
    );
  const created = await client.request("POST", "repos/example/target/issues", {
    title: "New",
  });
  // The span passed before the first list read: that read is still stale.
  now += 10_000;
  assert.equal((await listed()).includes(created.number), false);
  assert.equal((await listed()).includes(created.number), true);
  assert.equal(fake.lag[0].served, 1);
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
    await assert.rejects(delivery.publish(request), unknownOutcome);
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
  const publication = (headSha) => ({
    branch: "factory/objective-1/alpha",
    base: "main",
    headSha,
    title: "Alpha",
    body: "b",
  });
  await assert.rejects(
    gateway.publish(publication("a".repeat(40))),
    /changed head/,
  );
  assert.deepEqual(await gateway.publish(publication(sha)), {
    number,
    branch: "factory/objective-1/alpha",
    headSha: sha,
  });
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
  await assert.rejects(gateway.publish(publication(sha)), /Multiple open PRs/);
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
  // Real GitHub (#627): a stacked PR never merges through PUT merge, and a
  // stale expected head fails merge-async with 400.
  await assert.rejects(
    client.request("PUT", `repos/example/target/pulls/${one.number}/merge`, {
      sha: one.head.sha,
      merge_method: "merge",
    }),
    (error) => error instanceof GitHubRequestError && error.status === 403,
  );
  const stale = await fetch(
    `${fake.apiUrl}/repos/example/target/pulls/${two.number}/merge-async`,
    {
      method: "PUT",
      body: JSON.stringify({ sha: "f".repeat(40), merge_method: "merge" }),
    },
  );
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).status, "failed");
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
  // The open layer above the merge now targets the stack's base.
  assert.equal(fake.state.pulls[three.number].base.ref, "main");
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
  await assert.rejects(
    client.request("PUT", `repos/example/target/pulls/${two.number}/merge`, {
      sha: two.head.sha,
      merge_method: "merge",
    }),
    (error) => error instanceof GitHubRequestError && error.status === 403,
  );
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
  assert.equal(body.status, "422");
  assert.equal(body.errors.length, 1);
  assert.match(body.errors[0].message, /A pull request already exists/);
  fake.inject({ match: `GET ${repo}`, ...faults.secondaryRateLimit() });
  const limited = await fetch(`${fake.apiUrl}/repos/example/target`);
  assert.equal(limited.status, 403);
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "4999");
  assert.ok(limited.headers.get("x-ratelimit-reset"));
});

test("update-branch merges the base into the head, guarded by the expected head; strict protection reads BEHIND", async (t) => {
  const { fake, client, pushBranch } = await setup(t, {
    strict: true,
    protectionChecks: () => [],
  });
  const head = await pushBranch("feature");
  const pull = await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const readiness = () =>
    client.pullRequestReadiness("example/target", pull.number);
  assert.equal((await readiness()).mergeStateStatus, "CLEAN");
  await assert.rejects(
    client.request(
      "PUT",
      `repos/example/target/pulls/${pull.number}/update-branch`,
      { expected_head_sha: head },
    ),
    (error) => error instanceof GitHubRequestError && error.status === 422,
    "nothing new on the base",
  );
  const base = await fake.pushForeignCommit();
  assert.equal((await readiness()).mergeStateStatus, "BEHIND");
  await assert.rejects(
    client.request(
      "PUT",
      `repos/example/target/pulls/${pull.number}/update-branch`,
      { expected_head_sha: "f".repeat(40) },
    ),
    (error) => error instanceof GitHubRequestError && error.status === 422,
    "a stale expected head",
  );
  const updated = await client.request(
    "PUT",
    `repos/example/target/pulls/${pull.number}/update-branch`,
    { expected_head_sha: head },
  );
  assert.match(updated.message, /Updating/);
  const after = await client.request(
    "GET",
    `repos/example/target/pulls/${pull.number}`,
  );
  assert.notEqual(after.head.sha, head);
  assert.deepEqual(
    git(fake.origin, "rev-list", "--parents", "-n", "1", after.head.sha)
      .split(" ")
      .slice(1),
    [head, base],
  );
  assert.equal((await readiness()).mergeStateStatus, "CLEAN");
  const update = await client.request(
    "GET",
    `repos/example/target/commits/${after.head.sha}`,
  );
  assert.equal(update.committer.login, "web-flow");
  assert.deepEqual(
    update.parents.map((parent) => parent.sha),
    [head, base],
  );
  assert.equal(
    (await client.request("GET", `repos/example/target/compare/${base}...main`))
      .status,
    "identical",
  );
  assert.equal(
    (
      await client.request(
        "GET",
        `repos/example/target/compare/${head}...${after.head.sha}`,
      )
    ).status,
    "ahead",
  );
  assert.equal(
    (await client.request("GET", `repos/example/target/commits/${head}`))
      .committer.login,
    "example",
  );
  const protection = await client.request(
    "GET",
    "repos/example/target/branches/main/protection/required_status_checks",
  );
  assert.equal(protection.strict, true);
});

test("a deleted issue answers 410 and leaves the lists", async (t) => {
  const { fake, client } = await setup(t);
  const created = await client.request("POST", "repos/example/target/issues", {
    title: "Doomed",
  });
  fake.deleteIssue(created.number);
  await assert.rejects(
    client.request("GET", `repos/example/target/issues/${created.number}`),
    (error) => error instanceof GitHubRequestError && error.status === 410,
  );
  const listed = await client.paginate("repos/example/target/issues?state=all");
  assert.deepEqual(
    listed.map((issue) => issue.number),
    [1],
  );
});

test("an App token has no user; what it creates carries the bot login", async (t) => {
  const { fake, client } = await setup(t, {
    appToken: true,
    protectionChecks: () => ["ci"],
  });
  // It cannot read classic protection; the branch shows the required checks.
  await assert.rejects(
    client.request(
      "GET",
      "repos/example/target/branches/main/protection/required_status_checks",
    ),
    (error) => error instanceof GitHubRequestError && error.status === 403,
  );
  const branch = await client.request(
    "GET",
    "repos/example/target/branches/main",
  );
  assert.deepEqual(branch.protection.required_status_checks.contexts, ["ci"]);
  await assert.rejects(
    client.viewer(),
    (error) => error instanceof GitHubRequestError && error.status === 403,
  );
  const created = await client.request("POST", "repos/example/target/issues", {
    title: "Work",
  });
  assert.equal(created.user.login, fake.author.login);
  assert.match(created.user.login, /\[bot\]$/);
  const mine = await client.paginate(
    `repos/example/target/issues?state=all&creator=${encodeURIComponent(created.user.login)}`,
  );
  assert.deepEqual(
    mine.map((issue) => issue.number),
    [created.number],
  );
});

test("an App token's bot login is known before the first create, so ownership lists by creator (#614)", async (t) => {
  const { fake, gateway } = await setup(t, {
    appToken: true,
    protectionChecks: () => [],
  });
  // A stranger's issue that carries this Objective's Work Item marker.
  fake.openForeignIssue(
    "Look-alike",
    "<!-- factory:objective=1;item=one -->\nnot Factory's",
  );
  const projected = await gateway.projectGraph({
    objectiveIssue: 1,
    graph: {
      items: [
        {
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
        },
      ],
    },
  });
  const creator = `creator=${encodeURIComponent(fake.author.login)}`;
  const firstCreate = fake.log.findIndex(
    (entry) => entry.endpoint === `POST ${repo}/issues`,
  );
  assert.ok(firstCreate > 0);
  assert.ok(
    fake.log
      .slice(0, firstCreate)
      .some(
        (entry) =>
          entry.endpoint === `GET ${repo}/issues` &&
          entry.path.includes(creator),
      ),
    "the issue list before the first create is filtered by the bot's login",
  );
  assert.equal(projected.issueByItemId.one, 3);
});

test("classic linear history is read before a merge is sent (#614)", async (t) => {
  const { fake, client, gateway, pushBranch } = await setup(t, {
    classicLinearHistory: () => true,
  });
  const sha = await pushBranch("feature");
  const created = await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const identity = {
    number: created.number,
    headSha: sha,
    branch: "feature",
  };
  const error = await gateway.merge(identity, sha).catch((caught) => caught);
  assert.match(String(error?.message), /does not allow merge commits/);
  assert.equal(fake.effects(`PUT ${repo}/pulls/{number}/merge`).length, 0);
  assert.deepEqual(
    fake.log
      .filter((entry) => entry.method === "PUT")
      .map((entry) => entry.endpoint),
    [],
  );
});

test("branch protection serves GitHub's shape: linear history enabled, off, or unknown (#614)", async (t) => {
  const route = "repos/example/target/branches/main/protection";
  const enabled = await setup(t, { classicLinearHistory: () => true });
  const on = await enabled.client.request("GET", route);
  assert.equal(on.required_linear_history.enabled, true);
  assert.equal(on.required_status_checks, undefined);

  const off = await setup(t, { protectionChecks: () => ["ci"] });
  const read = await off.client.request("GET", route);
  assert.equal(read.required_linear_history.enabled, false);
  assert.deepEqual(read.required_status_checks.contexts, ["ci"]);

  // Unprotected is 404 and an App token is 403: unknown, so the merge decides.
  const none = await setup(t, {});
  const missing = await none.client
    .request("GET", route)
    .catch((caught) => caught);
  assert.equal(missing.status, 404);
  const app = await setup(t, {
    appToken: true,
    classicLinearHistory: () => true,
  });
  const refused = await app.client
    .request("GET", route)
    .catch((caught) => caught);
  assert.equal(refused.status, 403);
});

test("classic linear history that an App token cannot read leaves the merge to decide (#614)", async (t) => {
  const { fake, client, gateway, pushBranch } = await setup(t, {
    appToken: true,
    protectionChecks: () => [],
    classicLinearHistory: () => true,
  });
  const sha = await pushBranch("feature");
  const created = await client.request("POST", "repos/example/target/pulls", {
    head: "feature",
    base: "main",
    title: "Feature",
  });
  const error = await gateway
    .merge({ number: created.number, headSha: sha, branch: "feature" }, sha)
    .catch((caught) => caught);
  // 403 on the protection route: unreadable, not a fault of its own. The
  // merge was sent and GitHub refused it.
  assert.equal(fake.log.filter((entry) => entry.method === "PUT").length, 1);
  assert.ok(error instanceof Error);
});
