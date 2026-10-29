// #2181, the cause behind #2174: Factory's GitHub App has no Administration
// access, so GitHub refuses (403) every classic branch protection read it
// makes. Clockgrove #800 made 113 such requests on a main with no classic
// protection at all (404 to an admin), only the ruleset protected-main. As
// the App, Factory now asks for classic protection only while the
// installation grants Administration; a user's login is unchanged; and
// readiness says when a protected branch's rule is one Factory can't see.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, beforeEach, test } from "node:test";
import { GitHub } from "../dist/github.js";
import {
  newTransport,
  requestEvents,
  transport,
} from "../dist/github-trace.js";
import { repositoryChecks } from "../dist/readiness.js";
import { REPO, tempDir } from "./helpers.mjs";

const PROTECTION = `/repos/${REPO}/branches/main/protection`;
const CHECKS = `${PROTECTION}/required_status_checks`;
const BRANCH = `/repos/${REPO}/branches/main`;
const RULES = `/repos/${REPO}/rules/branches/main`;
const INSTALLATION = `/repos/${REPO}/installation`;
const TOKENS = "/app/installations/7/access_tokens";
const REFUSED = [403, { message: "Resource not accessible by integration" }];

let requests = [];
let routes = {};
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;
    requests.push(path);
    const answer = routes[path];
    const [status, body] = (typeof answer === "function"
      ? answer()
      : answer) ?? [404, { message: "Not Found" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
after(() => server.close());
beforeEach(() => {
  requests = [];
});

async function api() {
  if (!server.listening)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Factory as its GitHub App (the fake GitHub takes any JWT). */
async function app() {
  return new GitHub(REPO, await api(), { jwt: () => "jwt" });
}

/** Factory as a user's login. */
async function user() {
  process.env.FACTORY_GITHUB_TOKEN = "unused";
  return new GitHub(REPO, await api());
}

/** The installation on REPO, granting `permissions`; its tokens grant `token` (the installation's when undefined). */
function installed(permissions, token) {
  return {
    [INSTALLATION]: () => [
      200,
      { id: 7, app_slug: "drill-factory", permissions, suspended_at: null },
    ],
    [TOKENS]: () => [
      201,
      {
        token: "ghs_test",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        ...(token === undefined ? {} : { permissions: token }),
      },
    ],
  };
}

const BASE = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  metadata: "read",
};

/**
 * Clockgrove's main as GitHub shows it on 2026-10-28: no classic
 * protection (404), the ruleset protected-main requiring "quality" and
 * up-to-date branches, and the branch read showing it protected with no
 * classic checks.
 */
const CLOCKGROVE = {
  [RULES]: [
    200,
    [
      { type: "deletion", ruleset_id: 21177101 },
      { type: "non_fast_forward", ruleset_id: 21177101 },
      {
        type: "pull_request",
        ruleset_id: 21177101,
        parameters: {
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["squash", "rebase", "merge"],
        },
      },
      {
        type: "required_status_checks",
        ruleset_id: 21177101,
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "quality", integration_id: 1 }],
        },
      },
    ],
  ],
  [`/repos/${REPO}/rulesets/21177101`]: [200, { name: "protected-main" }],
  [BRANCH]: [
    200,
    {
      name: "main",
      protected: true,
      protection: {
        enabled: false,
        required_status_checks: {
          enforcement_level: "off",
          contexts: [],
          checks: [],
        },
      },
    },
  ],
  [`/repos/${REPO}`]: [200, { allow_merge_commit: true }],
};

const protectionReads = () =>
  requests.filter((path) => path.startsWith(PROTECTION));

/** Every read that consults classic protection, in a step's scope; the scope's events. */
async function allReads(client) {
  const counted = newTransport(true);
  const result = await transport.run(counted, async () => ({
    policy: await client.checksPolicy("main"),
    checks: await client.requiredChecks("main"),
    reviews: await client.requiredReviews("main"),
    threads: await client.threadResolution("main"),
    merges: await client.mergeCommitsAllowed("main"),
  }));
  return { result, events: requestEvents("item:a:ci", counted) };
}

test("the App without Administration makes no classic protection request: Clockgrove's ruleset alone answers, with no 403 and no notice", async () => {
  routes = {
    ...installed(BASE),
    ...CLOCKGROVE,
    // Were it asked, GitHub would refuse it.
    [CHECKS]: REFUSED,
    [PROTECTION]: REFUSED,
  };
  const client = await app();
  for (let poll = 0; poll < 3; poll++) {
    const { result, events } = await allReads(client);
    assert.deepEqual(result, {
      policy: { names: ["quality"], strict: true },
      checks: ["quality"],
      reviews: [],
      threads: ['ruleset "protected-main"'],
      merges: true,
    });
    assert.deepEqual(
      events.filter((event) => event.event === "branch-protection-unreadable"),
      [],
    );
    assert.deepEqual(
      events.filter((event) => event.status === 403),
      [],
      JSON.stringify(events),
    );
  }
  assert.deepEqual(protectionReads(), [], requests.join("\n"));
});

test("the App without Administration takes the branch read's classic checks, with strict unknown", async () => {
  routes = {
    ...installed({ ...BASE, administration: "none" }),
    [RULES]: [200, []],
    [BRANCH]: [
      200,
      {
        name: "main",
        protected: true,
        protection: {
          enabled: true,
          required_status_checks: { contexts: ["tests"], checks: [] },
        },
      },
    ],
    [CHECKS]: REFUSED,
  };
  const client = await app();
  assert.deepEqual(await client.checksPolicy("main"), {
    names: ["tests"],
    strict: undefined,
  });
  assert.deepEqual(protectionReads(), []);
});

for (const level of ["read", "write"])
  test(`the App granted Administration ${level} still reads classic protection`, async () => {
    routes = {
      ...installed({ ...BASE, administration: level }),
      [RULES]: [200, []],
      [CHECKS]: [200, { strict: true, contexts: ["tests"] }],
      [PROTECTION]: [
        200,
        {
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_conversation_resolution: { enabled: true },
          required_linear_history: { enabled: true },
        },
      ],
      [`/repos/${REPO}`]: [200, { allow_merge_commit: true }],
    };
    const client = await app();
    const { result } = await allReads(client);
    assert.deepEqual(result, {
      policy: { names: ["tests"], strict: true },
      checks: ["tests"],
      reviews: [{ rule: "branch protection", count: 1 }],
      threads: ["branch protection"],
      merges: false,
    });
    assert.ok(protectionReads().includes(CHECKS));
    assert.ok(protectionReads().includes(PROTECTION));
  });

test("the App granted Administration but refused anyway (withdrawn mid-run) latches, as #2174's safety net", async () => {
  routes = {
    ...installed({ ...BASE, administration: "read" }),
    [RULES]: [200, []],
    [BRANCH]: [200, { name: "main", protected: false }],
    [CHECKS]: REFUSED,
    [PROTECTION]: REFUSED,
    [`/repos/${REPO}`]: [200, { allow_merge_commit: true }],
  };
  const client = await app();
  const { events } = await allReads(client);
  const notices = events.filter(
    (event) => event.event === "branch-protection-unreadable",
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /^Factory's GitHub App can't read /);
  assert.deepEqual(protectionReads(), [CHECKS]);
});

test("the installation's permissions stay fresh: a minted token's own count, and so does a later installation read", async () => {
  // The installation was read without Administration; the token minted
  // since grants it: classic protection is read.
  routes = {
    ...installed(BASE, { ...BASE, administration: "read" }),
    [RULES]: [200, []],
    [CHECKS]: [200, { strict: true, contexts: ["tests"] }],
  };
  const granted = await app();
  assert.deepEqual(await granted.checksPolicy("main"), {
    names: ["tests"],
    strict: true,
  });
  assert.deepEqual(protectionReads(), [CHECKS]);

  // Read without it, then granted: the next installation read (the
  // push-access check) counts it.
  routes = {
    ...installed(BASE),
    [RULES]: [200, []],
    [BRANCH]: [200, { name: "main", protected: false }],
    [CHECKS]: [200, { strict: true, contexts: ["tests"] }],
  };
  requests = [];
  const client = await app();
  assert.deepEqual(await client.checksPolicy("main"), {
    names: [],
    strict: undefined,
  });
  assert.deepEqual(protectionReads(), []);
  routes = { ...routes, ...installed({ ...BASE, administration: "read" }) };
  assert.equal(await client.canPush(), true);
  assert.deepEqual(await client.checksPolicy("main"), {
    names: ["tests"],
    strict: true,
  });
  assert.deepEqual(protectionReads(), [CHECKS]);
});

test("a user's login is unchanged: it reads classic protection, with no installation read", async () => {
  routes = {
    [RULES]: [200, []],
    [CHECKS]: [200, { strict: false, contexts: ["tests"] }],
    [PROTECTION]: [
      200,
      { required_conversation_resolution: { enabled: true } },
    ],
    [`/repos/${REPO}`]: [200, { allow_merge_commit: true }],
  };
  const client = await user();
  const { result } = await allReads(client);
  assert.deepEqual(result, {
    policy: { names: ["tests"], strict: false },
    checks: ["tests"],
    reviews: [],
    threads: ["branch protection"],
    merges: true,
  });
  assert.ok(protectionReads().includes(CHECKS));
  assert.ok(protectionReads().includes(PROTECTION));
  assert.ok(!requests.includes(INSTALLATION));
});

test("branchProtected reads GitHub's protected flag, by a ruleset or a classic rule", async () => {
  routes = { [BRANCH]: [200, { name: "main", protected: true }] };
  const client = await user();
  assert.equal(await client.branchProtected("main"), true);
  routes = { [BRANCH]: [200, { name: "main", protected: false }] };
  assert.equal(await client.branchProtected("main"), false);
  routes = {};
  assert.equal(await client.branchProtected("main"), undefined);
});

/** A GitHub stand-in for readiness: every read it isn't given fails the test. */
function fake(answers) {
  return new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
}

async function readiness({ isApp, policy, protectedBranch }) {
  process.env.FACTORY_STATE_DIR = tempDir("factory-unseen-state-");
  return repositoryChecks(
    {
      repository: REPO,
      checkout: tempDir("factory-unseen-checkout-"),
      tracking: { enabled: false },
      github: { login: true },
      operators: [],
    },
    fake({
      isApp,
      login: async () => "drill-factory[bot]",
      checkIdentity: async () => {},
      canPush: async () => true,
      defaultBranch: async () => "main",
      mergeCommitsAllowed: async () => true,
      checksPolicy: async () => policy,
      branchProtected: async () => protectedBranch,
      requiredReviews: async () => [],
      threadResolution: async () => [],
    }),
  );
}

test("readiness: a protected branch whose rule Factory can't see (no ruleset or branch-read checks, up-to-date unknown) is named, with a ruleset as the fix", async () => {
  const checks = await readiness({
    isApp: true,
    policy: { names: [], strict: undefined },
    protectedBranch: true,
  });
  const warned = checks.find((check) => check.name === "branch protection");
  assert.equal(warned.status, "warn");
  assert.match(
    warned.detail,
    /^GitHub shows main as protected, but neither its rulesets nor the branch read show a required check or the up-to-date rule\. A classic branch protection rule is unreadable to drill-factory\[bot\]: GitHub shows it only with Administration access/,
  );
  assert.match(warned.fix, /into a ruleset/);
  assert.match(warned.fix, /rather than granting the App Administration/);
  assert.equal(
    checks.find((check) => check.name === "required checks"),
    undefined,
  );

  // A user's login: the same case, its own wording.
  const login = (
    await readiness({
      isApp: false,
      policy: { names: [], strict: undefined },
      protectedBranch: true,
    })
  ).find((check) => check.name === "branch protection");
  assert.match(login.detail, /can't read a classic branch protection rule/);
  assert.doesNotMatch(login.fix, /Administration/);
});

test("readiness: an unprotected branch, or one whose classic protection was read, keeps the plain required-checks warning", async () => {
  for (const [policy, protectedBranch] of [
    [{ names: [], strict: undefined }, false],
    [{ names: [], strict: false }, true],
  ]) {
    const checks = await readiness({ isApp: true, policy, protectedBranch });
    const required = checks.find((check) => check.name === "required checks");
    assert.equal(required.status, "warn");
    assert.match(required.detail, /^main requires no status checks/);
    assert.equal(
      checks.find((check) => check.name === "branch protection"),
      undefined,
    );
  }
  // Clockgrove's ruleset: required checks seen, up to date required.
  const checks = await readiness({
    isApp: true,
    policy: { names: ["quality"], strict: true },
    protectedBranch: true,
  });
  assert.equal(
    checks.find((check) => check.name === "required checks").status,
    "ok",
  );
  assert.equal(
    checks.find((check) => check.name === "branch protection").status,
    "ok",
  );
});
