// A base branch that requires review threads resolved (a ruleset's
// pull_request rule, or classic protection's conversation resolution)
// blocks a Factory PR with an unresolved thread: GitHub reports it BLOCKED
// and refuses its merge. Factory asks at once, naming each thread, instead
// of waiting until its generic transient question (#2053). Readiness
// reports the rule.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { merge, observeCi } from "../dist/delivery.js";
import { GitHub, GitHubError } from "../dist/github.js";
import { repositoryChecks } from "../dist/readiness.js";
import { githubOrigin, REPO, tempDir } from "./helpers.mjs";

const HEAD = "a".repeat(40);
const THREAD = `https://github.com/${REPO}/pull/7#discussion_r1`;

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A GitHub that answers only the calls delivery makes here. */
function fake(answers) {
  return new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
}

/** PR #7 at HEAD into main, its required check passed, GitHub's readiness `status`. */
function pullAnswers(status, threads, rules) {
  return {
    repository: REPO,
    defaultBranch: async () => "main",
    pull: async () => ({
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      head: { sha: HEAD, ref: "factory/1/a" },
      base: { ref: "main" },
    }),
    mergeState: async () => ({
      headRefOid: HEAD,
      headRefName: "factory/1/a",
      baseRefName: "main",
      mergeStateStatus: status,
      reviewDecision: null,
    }),
    checkRuns: async () => [
      {
        id: 1,
        name: "ci",
        head_sha: HEAD,
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
      },
    ],
    commitStatuses: async () => [],
    requiredChecks: async () => ["ci"],
    unresolvedThreads: async () => threads,
    threadResolution: async () => rules,
  };
}

const input = {
  issue: 1,
  item: "a",
  pr: 7,
  head: HEAD,
  pushedHeads: [HEAD],
  requiredChecks: [],
};

function context(github, checkout = tempDir("factory-threads-")) {
  return { github, checkout, signal: new AbortController().signal };
}

test("a PR blocked on review threads its base requires resolved holds at once, naming them", async () => {
  const threads = [
    { path: "src/a.js", url: THREAD },
    { path: "src/b.js", url: `${THREAD}2` },
  ];
  const held = await observeCi(
    context(fake(pullAnswers("BLOCKED", threads, ['ruleset "main"']))),
    input,
  );
  assert.equal(held.kind, "hold", JSON.stringify(held));
  assert.match(held.question, /PR #7 has 2 unresolved review threads/);
  assert.match(held.question, /main requires review threads to be resolved/);
  assert.match(held.question, /ruleset "main"/);
  assert.ok(held.question.includes(`src/a.js (${THREAD})`), held.question);
  assert.ok(held.question.includes(`src/b.js (${THREAD}2)`), held.question);
  assert.match(
    held.question,
    /Resolve them on GitHub, then answer retry; or cancel\.$/,
  );
  assert.deepEqual(
    held.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
});

test("a blocked PR whose threads are resolved, or whose base doesn't require it, waits as before", async () => {
  for (const [threads, rules] of [
    [[], ["branch protection"]],
    [[{ path: "src/a.js", url: THREAD }], []],
  ]) {
    const waited = await observeCi(
      context(fake(pullAnswers("BLOCKED", threads, rules))),
      input,
    );
    assert.equal(waited.kind, "retry", JSON.stringify(waited));
    assert.match(waited.reason, /Awaiting checks and protection readiness/);
    assert.equal(waited.holdAfter, undefined);
  }
});

test("a pending check is waited for before the threads are read", async () => {
  const answers = pullAnswers("BLOCKED", [], []);
  answers.commitStatuses = async () => [{ context: "lint", state: "pending" }];
  answers.unresolvedThreads = async () => {
    throw new Error("threads read while a check is pending");
  };
  const waited = await observeCi(context(fake(answers)), input);
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.match(waited.reason, /: lint$/);
});

test("a merge GitHub refuses over unresolved review threads holds at once, with GitHub's refusal", async () => {
  const root = tempDir("factory-threads-");
  const bare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, checkout);
  githubOrigin(checkout, bare);
  const answers = pullAnswers(
    "CLEAN",
    [{ path: "src/a.js", url: THREAD }],
    ["branch protection"],
  );
  answers.mergeCommitsAllowed = async () => true;
  answers.mergePull = async () => {
    throw new GitHubError("Merge blocked: All comments must be resolved.", 405);
  };
  const held = await merge(context(fake(answers), checkout), input);
  assert.equal(held.kind, "hold", JSON.stringify(held));
  assert.match(held.question, /PR #7 has 1 unresolved review thread,/);
  assert.match(
    held.question,
    /\(branch protection\), so GitHub refused the merge: Merge blocked/,
  );
  assert.ok(held.question.includes(`src/a.js (${THREAD})`), held.question);
  // Without unresolved threads the refusal is the usual lagging question.
  answers.unresolvedThreads = async () => [];
  const lagged = await merge(context(fake(answers), checkout), input);
  assert.equal(lagged.kind, "retry", JSON.stringify(lagged));
  assert.match(lagged.holdAfter.question, /GitHub refused to merge PR #7/);
});

// GitHub's own answers, from a local server: the rules a branch has, and a
// PR's review threads over GraphQL, page by page.
const requests = [];
let routes = {};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;
    requests.push({ path, body });
    const route = routes[path];
    const [status, answer] =
      typeof route === "function"
        ? route(JSON.parse(body || "{}"))
        : (route ?? [404, { message: "Not Found" }]);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
});
after(() => server.close());

async function github() {
  process.env.FACTORY_GITHUB_TOKEN = "unused";
  if (!server.listening)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new GitHub(REPO, `http://127.0.0.1:${server.address().port}`);
}

test("the rules that require review threads resolved: rulesets by name, and classic protection", async () => {
  const client = await github();
  routes = {
    [`/repos/${REPO}/rules/branches/main`]: [
      200,
      [
        {
          type: "pull_request",
          ruleset_id: 9,
          parameters: {
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
        {
          type: "pull_request",
          ruleset_id: 10,
          parameters: { required_review_thread_resolution: false },
        },
        { type: "required_linear_history", ruleset_id: 11 },
      ],
    ],
    [`/repos/${REPO}/rulesets/9`]: [200, { id: 9, name: "main rules" }],
    [`/repos/${REPO}/branches/main/protection`]: [
      200,
      { required_conversation_resolution: { enabled: true } },
    ],
  };
  assert.deepEqual(await client.threadResolution("main"), [
    'ruleset "main rules"',
    "branch protection",
  ]);
  // No rule, and classic protection the login can't read: none known.
  routes = {
    [`/repos/${REPO}/rules/branches/main`]: [200, []],
    [`/repos/${REPO}/branches/main/protection`]: [
      403,
      { message: "Resource not accessible by integration" },
    ],
  };
  assert.deepEqual(await client.threadResolution("main"), []);
});

test("a PR's unresolved review threads, read page by page", async () => {
  const client = await github();
  const thread = (isResolved, path, url) => ({
    isResolved,
    path,
    comments: { nodes: url ? [{ url }] : [] },
  });
  routes = {
    "/graphql": (request) => {
      assert.equal(request.variables.number, 7);
      return request.variables.after === "page2"
        ? [
            200,
            {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [thread(false, "src/c.js")],
                      pageInfo: { hasNextPage: false, endCursor: "end" },
                    },
                  },
                },
              },
            },
          ]
        : [
            200,
            {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        thread(false, "src/a.js", THREAD),
                        thread(true, "src/b.js", `${THREAD}2`),
                      ],
                      pageInfo: { hasNextPage: true, endCursor: "page2" },
                    },
                  },
                },
              },
            },
          ];
    },
  };
  assert.deepEqual(await client.unresolvedThreads(7), [
    { path: "src/a.js", url: THREAD },
    { path: "src/c.js" },
  ]);
});

test("readiness warns when the default branch requires review threads resolved", async () => {
  process.env.FACTORY_STATE_DIR = tempDir("factory-threads-state-");
  const answers = (resolution) =>
    fake({
      login: async () => "factory-bot",
      checkIdentity: async () => {},
      canPush: async () => true,
      defaultBranch: async () => "main",
      mergeCommitsAllowed: async () => true,
      checksPolicy: async () => ({ names: ["ci"], strict: true }),
      requiredReviews: async () => [],
      threadResolution: async () => resolution,
    });
  const config = {
    repository: REPO,
    checkout: tempDir("factory-threads-checkout-"),
    tracking: { enabled: false },
  };
  const named = (checks) =>
    checks.find((check) => check.name === "review threads");
  const warned = named(
    await repositoryChecks(config, answers(['ruleset "main"'])),
  );
  assert.equal(warned.status, "warn");
  assert.match(
    warned.detail,
    /^main requires review threads to be resolved \(ruleset "main"\)/,
  );
  assert.ok(warned.fix);
  const clear = named(await repositoryChecks(config, answers([])));
  assert.equal(clear.status, "ok");
  assert.equal(clear.detail, "main requires no review thread resolution");
});
