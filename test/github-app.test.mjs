// Factory's own GitHub identity, a GitHub App (github-app.ts): its JWT, the
// installation token and its refresh, the bot's login and commit author,
// remote Git's token, the operators' mentions, and setup's App options,
// registration link and readiness. GitHub is a local fake.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { publish } from "../dist/delivery.js";
import { originBound } from "../dist/git.js";
import { GitHubError, githubOutcome } from "../dist/github.js";
import {
  APP_PERMISSIONS,
  appJwt,
  appRegistrationLink,
  appSteps,
  factoryGitHub,
  missingPermissions,
} from "../dist/github-app.js";
import {
  cancelComment,
  GitHubSync,
  questionComment,
} from "../dist/github-sync.js";
import { redact } from "../dist/log.js";
import { mark } from "../dist/markdown.js";
import { postPlan } from "../dist/planning/steps.js";
import { unitName, unitText } from "../dist/systemd.js";
import { FACTORY_EMAIL, factoryCommit } from "../dist/work/collect.js";
import { reportComment } from "../dist/work/finish.js";
import { workerEnvironment } from "../dist/worktree.js";
import {
  CLI,
  children,
  cli,
  closedPort,
  configured,
  exited,
  githubOrigin,
  installation,
  item,
  offered,
  plan,
  REPO,
  serve,
  stopped,
  tempDir,
  until,
} from "./helpers.mjs";

const pair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
const key = pair();
const APP = 42;
const SLUG = "drill-factory";

/** The claims of a JWT GitHub would take from App APP, or undefined. */
function claims(authorization) {
  const [scheme, jwt] = (authorization ?? "").split(" ");
  const parts = jwt?.split(".") ?? [];
  if (scheme !== "Bearer" || parts.length !== 3) return undefined;
  const signed = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key.publicKey,
    Buffer.from(parts[2], "base64url"),
  );
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  return signed && payload.iss === APP && payload.exp * 1000 > Date.now()
    ? payload
    : undefined;
}

/**
 * A fake GitHub: `routes` answers `METHOD /path` with [status, body]; any
 * other request is a 404. Every request is recorded with its credential.
 */
async function fakeGitHub(routes) {
  const calls = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const route = `${request.method} ${request.url.split("?")[0]}`;
      calls.push({ route, authorization: request.headers.authorization });
      const [status, body] = routes[route]?.(request) ?? [
        404,
        { message: "Not Found" },
      ];
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { api: `http://127.0.0.1:${server.address().port}`, calls };
}

/** An App's routes: its installation on REPO, its tokens (`tokens.minted`), and its bot. */
function appRoutes(tokens, permissions = APP_PERMISSIONS) {
  const asApp = (answer) => (request) =>
    claims(request.headers.authorization)
      ? answer()
      : [401, { message: "A JSON web token could not be decoded" }];
  const installation = (id) =>
    asApp(() => [200, { id, app_slug: SLUG, permissions, suspended_at: null }]);
  return {
    [`GET /repos/${REPO}/installation`]: installation(7),
    "GET /app/installations/9": installation(9),
    ...Object.fromEntries(
      [7, 9].map((id) => [
        `POST /app/installations/${id}/access_tokens`,
        asApp(() => {
          tokens.minted += 1;
          return [
            201,
            {
              token: `ghs_test${tokens.minted}`,
              expires_at: new Date(
                Date.now() + (tokens.lifetimeMs ?? 60 * 60_000),
              ).toISOString(),
            },
          ];
        }),
      ]),
    ),
    [`GET /users/${encodeURIComponent(`${SLUG}[bot]`)}`]: () => [
      200,
      { id: 99, login: `${SLUG}[bot]` },
    ],
  };
}

/** Run `fn` with these environment variables (undefined unsets one), then restore them. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  const set = (entries) => {
    for (const [name, value] of Object.entries(entries))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  set(values);
  try {
    return await fn();
  } finally {
    set(saved);
  }
}

const appEnv = () => ({
  FACTORY_STATE_DIR: tempDir("factory-app-"),
  FACTORY_GITHUB_APP_KEY: key.privateKey,
  CREDENTIALS_DIRECTORY: undefined,
});

test("the App's JWT is RS256 with its key, issued 60 s back and expiring within GitHub's 10 min", () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const [header, payload, signature] = appJwt(APP, key.privateKey, now).split(
    ".",
  );
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  const { iat, exp, iss } = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(iss, APP);
  assert.equal(iat, now / 1000 - 60);
  assert.ok(exp > now / 1000 && exp - now / 1000 <= 10 * 60);
  const signed = Buffer.from(`${header}.${payload}`);
  assert.ok(
    verify(
      "sha256",
      signed,
      key.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.ok(
    !verify(
      "sha256",
      signed,
      pair().publicKey,
      Buffer.from(signature, "base64url"),
    ),
    "another key's signature doesn't verify",
  );
  // Logs never show a JWT, a basic header or a key.
  const shown = redact(
    `jwt ${appJwt(APP, key.privateKey)} AUTHORIZATION: basic eC1hY2Nlc3M= ${key.privateKey}`,
  );
  assert.doesNotMatch(shown, /eyJ|eC1hY2Nlc3M|PRIVATE KEY|MII/);
});

test("an installation token is minted once, kept, minted again after a 401 or near its expiry; the login is the App's bot", async () => {
  const tokens = { minted: 0 };
  const revoked = new Set();
  const { api, calls } = await fakeGitHub({
    ...appRoutes(tokens),
    [`GET /repos/${REPO}/issues/1`]: (request) =>
      revoked.has(request.headers.authorization)
        ? [401, { message: "Bad credentials" }]
        : [200, { title: "t", body: "", state: "open", user: null }],
  });
  await withEnv(appEnv(), async () => {
    const github = factoryGitHub(
      { repository: REPO, github: { app: { id: APP } } },
      api,
    );
    assert.equal(github.isApp, true);
    await github.issue(1);
    await github.issue(1);
    assert.equal(tokens.minted, 1);
    const reads = () =>
      calls
        .filter((call) => call.route === `GET /repos/${REPO}/issues/1`)
        .map((call) => call.authorization);
    assert.deepEqual(reads(), ["Bearer ghs_test1", "Bearer ghs_test1"]);
    // The installation is the repository's own, read with the App's JWT.
    const found = calls.find(
      (call) => call.route === `GET /repos/${REPO}/installation`,
    );
    assert.ok(claims(found.authorization));
    assert.equal(await github.login(), `${SLUG}[bot]`);
    assert.equal(
      calls.filter((call) => call.route === "GET /user").length,
      0,
      "an installation token never reads GET /user",
    );
    assert.deepEqual(await github.commitAuthor(), {
      name: `${SLUG}[bot]`,
      email: `99+${SLUG}[bot]@users.noreply.github.com`,
    });

    // A 401 mints a new token, and the request goes again with it.
    revoked.add("Bearer ghs_test1");
    await github.issue(1);
    assert.equal(tokens.minted, 2);
    assert.equal(reads().at(-1), "Bearer ghs_test2");

    // A token close to its expiry is minted again before it is used.
    tokens.lifetimeMs = 5 * 60_000;
    revoked.add("Bearer ghs_test2");
    await github.issue(1);
    assert.equal(tokens.minted, 3);
    await github.issue(1);
    assert.equal(tokens.minted, 4);
    assert.equal(reads().at(-1), "Bearer ghs_test4");
  });
});

test("a configured installation id is read as itself; without a key, or not installed, the App holds with its own fix", async () => {
  const tokens = { minted: 0 };
  const { api, calls } = await fakeGitHub(appRoutes(tokens));
  await withEnv(appEnv(), async () => {
    const github = factoryGitHub(
      { repository: REPO, github: { app: { id: APP, installationId: 9 } } },
      api,
    );
    await github.serviceToken();
    assert.deepEqual(
      calls.map((call) => call.route),
      ["GET /app/installations/9", "POST /app/installations/9/access_tokens"],
    );
  });
  await withEnv(
    { ...appEnv(), FACTORY_GITHUB_APP_KEY: undefined },
    async () => {
      const github = factoryGitHub(
        { repository: REPO, github: { app: { id: APP } } },
        api,
      );
      const error = await github.issue(1).then(
        () => assert.fail("no key, no token"),
        (failure) => failure,
      );
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 401);
      assert.equal(error.app, true);
      assert.match(error.message, /no private key/);
      const question = JSON.stringify(githubOutcome(error, REPO));
      assert.match(question, /GitHub App/);
      assert.match(question, /FACTORY_GITHUB_APP_KEY/);
      assert.doesNotMatch(question, /gh auth login/);
    },
  );
  const { api: nowhere } = await fakeGitHub({});
  await withEnv(appEnv(), async () => {
    const github = factoryGitHub(
      { repository: REPO, github: { app: { id: APP } } },
      nowhere,
    );
    await assert.rejects(github.login(), (error) => {
      assert.equal(error.app, true);
      assert.match(error.message, /isn't installed on drill\/target/);
      return true;
    });
  });
});

test("the App's key the service loaded as a credential comes first and is read whole; an empty one holds naming it", async () => {
  const tokens = { minted: 0 };
  const { api } = await fakeGitHub(appRoutes(tokens));
  const credentials = tempDir("factory-app-credentials-");
  const loaded = join(credentials, "FACTORY_GITHUB_APP_KEY");
  writeFileSync(loaded, key.privateKey, { mode: 0o600 });
  // Another key in the environment: only the credential's signs for App APP.
  await withEnv(
    {
      ...appEnv(),
      FACTORY_GITHUB_APP_KEY: pair().privateKey,
      CREDENTIALS_DIRECTORY: credentials,
    },
    async () => {
      const app = () =>
        factoryGitHub({ repository: REPO, github: { app: { id: APP } } }, api);
      assert.equal(await app().serviceToken(), "ghs_test1");
      writeFileSync(loaded, "\n");
      await assert.rejects(app().serviceToken(), (error) => {
        assert.equal(error.app, true);
        assert.match(
          error.message,
          /credential FACTORY_GITHUB_APP_KEY is empty or invalid/,
        );
        return true;
      });
      assert.equal(tokens.minted, 1);
    },
  );
});

test("remote Git gets the installation token for that one call only: no Git configuration, process or worker environment keeps it", async () => {
  const tokens = { minted: 0 };
  const { api } = await fakeGitHub(appRoutes(tokens));
  const checkout = join(tempDir("factory-app-git-"), "checkout");
  for (const args of [
    ["init", "--quiet", checkout],
    [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      `https://github.com/${REPO}.git`,
    ],
  ])
    assert.equal(spawnSync("git", args).status, 0);
  await withEnv(appEnv(), async () => {
    factoryGitHub({ repository: REPO, github: { app: { id: APP } } }, api);
    const toOrigin = await originBound(checkout, REPO);
    assert.equal(tokens.minted, 1);
    const header = "http.https://github.com/.extraheader";
    const basic = Buffer.from("x-access-token:ghs_test1").toString("base64");
    // The call's own configuration comes last: the operator's helpers and
    // headers for github.com cleared (an empty value), then the token.
    assert.deepEqual(
      (await toOrigin(["config", "--get-all", header])).split("\n").slice(-3),
      ["", `AUTHORIZATION: basic ${basic}`, ""],
    );
    assert.deepEqual(
      (
        await toOrigin([
          "config",
          "--get-all",
          "credential.https://github.com.helper",
        ])
      )
        .split("\n")
        .slice(-2),
      ["", ""],
    );
    // Nothing persisted, and nothing anyone else's environment has.
    assert.equal(
      spawnSync("git", ["-C", checkout, "config", "--get-all", header]).status,
      1,
    );
    assert.doesNotMatch(
      readFileSync(join(checkout, ".git", "config"), "utf8"),
      /AUTHORIZATION|ghs_/,
    );
    const environments = JSON.stringify([
      process.env,
      workerEnvironment(join(checkout, "gh"), ["FACTORY_GITHUB_APP_KEY"]),
    ]);
    assert.doesNotMatch(environments, new RegExp(`ghs_test1|${basic}`));
    assert.doesNotMatch(
      JSON.stringify(workerEnvironment(join(checkout, "gh"))),
      /PRIVATE KEY/,
    );
  });
});

test("a commit Factory makes as the App is authored by its bot and still committed as Factory", () => {
  const repository = tempDir("factory-app-commit-");
  assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0);
  const author = {
    name: `${SLUG}[bot]`,
    email: `99+${SLUG}[bot]@users.noreply.github.com`,
  };
  for (const as of [author, undefined]) {
    const { config, author: given } = factoryCommit(as);
    const made = spawnSync(
      "git",
      [
        "-C",
        repository,
        ...config,
        "commit",
        "--quiet",
        "--allow-empty",
        ...given,
        "-m",
        "Factory: x",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    assert.equal(made.status, 0, made.stderr);
    const shown = spawnSync(
      "git",
      ["-C", repository, "log", "-1", "--format=%an%n%ae%n%cn%n%ce"],
      { encoding: "utf8" },
    ).stdout.trim();
    assert.deepEqual(
      shown.split("\n"),
      as
        ? [author.name, author.email, "Factory", FACTORY_EMAIL]
        : ["Factory", FACTORY_EMAIL, "Factory", FACTORY_EMAIL],
    );
  }
});

test("a hold, the report and a cancel mention every operator once, at the end; without operators they mention no one", () => {
  const operators = ["kirk", "ops-2"];
  const question = questionComment(
    mark(5, "hold", "plan-1"),
    "**Factory needs you.** Which one?",
    "- `/factory answer`",
    " While this is the only open question, the short form works.",
    operators,
  );
  assert.ok(question.startsWith("<!-- factory:5:hold:plan-1 -->\n"));
  assert.ok(question.endsWith("\n\n@kirk @ops-2"));
  assert.equal(question.match(/@kirk/g).length, 1);
  assert.doesNotMatch(
    questionComment(mark(5, "hold", "plan-1"), "Q", "- a", "", []),
    /@/,
  );
  const cancelled = cancelComment(
    mark(5, "cancelled", "run"),
    { ended: { at: "2026-10-26T00:00:00.000Z", by: "kirk", source: "github" } },
    undefined,
    { secrets: [], operators },
  );
  assert.ok(cancelled.startsWith("<!-- factory:5:cancelled:run -->\n"));
  assert.ok(cancelled.endsWith("\n\n@kirk @ops-2"));
  const state = {
    issue: 5,
    done: {
      plan: plan([item("a", { title: "Add a" })]),
      final: { commit: "c".repeat(40), commands: ["npm test"] },
    },
    kept: {},
    answers: {},
    repairs: {},
  };
  const report = reportComment(mark(5, "report", "run"), state, operators);
  assert.match(report, /\*\*Factory finished this Objective\.\*\*/);
  assert.ok(report.endsWith("\n\n@kirk @ops-2"));
  // The checks a rerun of their failed Actions jobs passed come before them.
  state.kept["item:a:ciRerun"] = {
    head: "d".repeat(40),
    checks: ["test"],
    passed: true,
  };
  const flaky = reportComment(mark(5, "report", "run"), state, operators);
  assert.match(
    flaky,
    /Possibly flaky CI checks[^\n]*\n- \*\*a\*\*: `test` at `dddddddddddd`\n\n@kirk @ops-2$/,
  );
  assert.doesNotMatch(reportComment(mark(5, "report", "run"), state, []), /@/);
});

/**
 * `body` without what GitHub never reads a mention in: code spans and
 * blocks, and HTML comments (Factory's markers and status record).
 */
const notified = (body) =>
  body.replace(/(`+)[\s\S]*?\1/g, "").replace(/<!--[\s\S]*?-->/g, "");
/** An @mention GitHub notifies (prose writes `&#64;`, inert adds a joiner). */
const MENTION = /@[\w-]/;

test("with operators set, the live status comment, the waiting note, reminders, the plan comment and PR bodies mention no one", async () => {
  const operators = ["kirk", "ops-2"];
  const issue = 5;
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const written = new Map();
  const comment = async (on, marker, body) => {
    written.set(marker, body);
    const at = new Date().toISOString();
    return {
      id: written.size,
      created_at: at,
      updated_at: at,
      html_url: `https://github.com/${REPO}/issues/${on}#issuecomment-${written.size}`,
    };
  };
  const github = {
    repository: REPO,
    upsertComment: comment,
    ensureComment: comment,
    markedComment: async () => undefined,
  };
  // Every text the comments show names an operator too.
  const accepted = plan(
    [item("a", { title: "Tell @kirk", goal: "Ask @ops-2 first" })],
    {
      base: "b".repeat(40),
      decisions: [{ answer: "go", text: "as @kirk said", by: "kirk" }],
    },
  );
  const asked = (id, fields = {}) => ({
    id,
    step: "item:a:work",
    item: "a",
    question: `Which way, @kirk? (${id})`,
    options: offered("retry", "cancel"),
    cause: "question",
    askedAt: old,
    ...fields,
  });
  const gate = { kind: "gate", gate: "a review by @kirk" };
  const state = {
    version: 9,
    issue,
    status: "holding",
    holds: [asked("shown", { shownAt: old }), asked("new")],
    answers: {},
    repairs: {},
    kept: {},
    attempts: {},
    appliedRequests: [],
    retries: {
      "item:a:merge": {
        count: 0,
        since: old,
        nextAt: old,
        lastError: "@kirk",
        wait: gate,
      },
      "item:a:ci": {
        count: 0,
        since: old,
        nextAt: old,
        lastError: "GitHub 502 for @ops-2",
        cause: "GitHub 502 for @ops-2",
      },
    },
    done: { plan: accepted },
    modules: { github: { itemId: "I_5", commentsSince: old } },
    startedAt: old,
    updatedAt: old,
  };
  const runner = {
    state,
    settled: false,
    blocked: () => false,
    transact: (change) => change(),
    shown: (id, at) => {
      state.holds.find((hold) => hold.id === id).shownAt = at;
    },
  };
  const sync = new GitHubSync(
    github,
    {
      repository: REPO,
      secrets: [],
      operators,
      progress: { enabled: true, includeQuestions: true },
    },
    { write: () => {} },
    { noteAfterMs: 0, remindAfterMs: 0 },
  );
  // One tick's comment jobs for this Objective (github-sync.ts `tick`).
  const module = state.modules.github;
  sync.ask(runner);
  sync.status(runner, {
    logs: tempDir("factory-app-logs-"),
    queue: { mode: "running" },
    waitsOn: () => null,
  });
  sync.note(runner, module);
  sync.remind(runner, module);
  const question = mark(issue, "hold", "new");
  const edited = [
    mark(issue, "status", old),
    mark(issue, "waiting", "note"),
    mark(issue, "remind", `item:a:merge@${old}`),
    mark(issue, "remind", "hold:shown"),
  ];
  await until(
    () => [question, ...edited].every((marker) => written.has(marker)),
    "every comment",
  );
  // The question is what GitHub notifies them of, once.
  assert.ok(written.get(question).endsWith("\n\n@kirk @ops-2"));
  for (const marker of edited)
    assert.doesNotMatch(notified(written.get(marker)), MENTION, marker);
  assert.match(written.get(edited[0]), /Which way/);

  // The plan comment, and its data.
  const posted = [];
  await postPlan(
    {
      github: { upsertComment: async (...call) => posted.push(call[2]) },
      config: { operators },
    },
    state,
    accepted,
    new AbortController().signal,
    { accepted: old },
  );
  assert.equal(posted.length, 1);
  assert.match(posted[0], /\*\*Factory's plan\*\*/);
  assert.doesNotMatch(notified(posted[0]), MENTION);

  // A Work Item's PR: its title and body. Another repository than the
  // App tests', which bind REPO's remote Git to their App.
  const repository = "drill/plain";
  const root = tempDir("factory-app-pr-");
  const bare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  for (const args of [
    ["init", "--quiet", "--bare", "--initial-branch=main", bare],
    ["clone", "--quiet", bare, checkout],
  ])
    assert.equal(spawnSync("git", args).status, 0);
  githubOrigin(checkout, bare, repository);
  const commit = (file, text) => {
    writeFileSync(join(checkout, file), text);
    git("add", file);
    git(
      "-c",
      "user.name=Factory",
      "-c",
      `user.email=${FACTORY_EMAIL}`,
      "commit",
      "--quiet",
      "-m",
      `Factory: ${file}`,
    );
    return git("rev-parse", "HEAD");
  };
  git("checkout", "--quiet", "-b", "main");
  const base = commit("README.md", "target\n");
  git("push", "--quiet", "origin", "main");
  const result = commit("a.js", "export const a = 1;\n");
  const created = [];
  const pulls = new Proxy(
    {
      repository,
      defaultBranch: async () => "main",
      made: () => {},
      pullsByHead: async () => [],
      createPull: async (pull) => {
        created.push(pull);
        return { number: 8 };
      },
    },
    {
      get: (target, name) => {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        throw new Error(`unexpected GitHub call: ${String(name)}`);
      },
    },
  );
  const published = await publish(
    {
      github: pulls,
      checkout,
      signal: new AbortController().signal,
      config: { operators },
    },
    {
      issue,
      item: {
        id: "a",
        title: "Tell @kirk",
        goal: "Ask @ops-2 first",
        ownedPaths: ["a.js"],
      },
      base,
      commit: result,
      tree: git("rev-parse", `${result}^{tree}`),
      pushedHeads: [],
      validation: { commands: ["npm test"] },
      secrets: [],
    },
  );
  assert.equal(published.kind, "published", JSON.stringify(published));
  assert.equal(created.length, 1);
  assert.match(created[0].body, /Work Item: <code>a<\/code>/);
  assert.doesNotMatch(created[0].title, MENTION);
  assert.doesNotMatch(notified(created[0].body), MENTION);
});

test("the registration link prefills every permission for an organization or a user, with no webhook and a private App", () => {
  const org = new URL(appRegistrationLink("clockgrove", true));
  assert.equal(
    `${org.origin}${org.pathname}`,
    "https://github.com/organizations/clockgrove/settings/apps/new",
  );
  const given = Object.fromEntries(org.searchParams);
  assert.equal(given.name, "clockgrove Factory");
  assert.equal(given.url, "https://github.com/clockgrove/factory");
  assert.equal(given.public, "false");
  assert.equal(given.webhook_active, "false");
  for (const [name, level] of Object.entries(APP_PERMISSIONS))
    assert.equal(given[name], level, name);
  assert.equal(given.organization_projects, "write");
  assert.equal(given.workflows, "write");
  // A flaky run's failed jobs are rerun (POST .../rerun-failed-jobs).
  assert.equal(given.actions, "write");
  const user = new URL(appRegistrationLink("kirk", false));
  assert.equal(
    `${user.origin}${user.pathname}`,
    "https://github.com/settings/apps/new",
  );
  // An installation that grants less names each missing permission; a
  // user's repository needs no organization Project permission.
  const { workflows: _workflows, ...less } = APP_PERMISSIONS;
  assert.deepEqual(missingPermissions({ ...less, issues: "read" }, true), [
    "issues: write",
    "workflows: write",
  ]);
  assert.deepEqual(
    missingPermissions({ ...APP_PERMISSIONS, actions: "read" }, true),
    ["actions: write"],
  );
  // The App reads every repository of the Project: an organization's
  // installation takes All repositories.
  assert.match(
    appSteps(true),
    /install it on All repositories of the organization \(at the least, on the repository and every other repository of its Project\)/,
  );
  assert.match(
    appSteps(false),
    /install it on the repository and every other repository of its Project, then run factory setup --github-app-id ID --github-app-key PATH --operator LOGIN/,
  );
  const { organization_projects: _projects, ...personal } = APP_PERMISSIONS;
  assert.deepEqual(missingPermissions(personal, false), []);
  assert.deepEqual(missingPermissions(personal, true), [
    "organization_projects: write",
  ]);
});

/** `factory ARGS --repo REPO` in `inst`, without blocking this process's fake GitHub. */
function factory(inst, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--repo", REPO], {
      env: inst.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

const repository = () => [
  200,
  {
    full_name: REPO,
    default_branch: "main",
    allow_merge_commit: true,
    owner: { type: "Organization" },
  },
];

test("setup keeps the App's key as an owner-only copy, never shown; readiness checks the App's installation, permissions and operators", async () => {
  const tokens = { minted: 0 };
  let permissions = { ...APP_PERMISSIONS, workflows: undefined };
  const routes = appRoutes(tokens);
  const { api } = await fakeGitHub({
    ...routes,
    [`GET /repos/${REPO}/installation`]: (request) =>
      claims(request.headers.authorization)
        ? [200, { id: 7, app_slug: SLUG, permissions, suspended_at: null }]
        : [401, {}],
    [`GET /repos/${REPO}`]: repository,
  });
  const inst = installation();
  configured(inst, api);
  delete inst.env.CREDENTIALS_DIRECTORY;
  delete inst.env.FACTORY_GITHUB_APP_KEY;
  const pem = join(inst.root, "downloaded.pem");
  writeFileSync(pem, key.privateKey, { mode: 0o644 });
  const copy = join(inst.root, "github-app-key.pem");

  const alone = await factory(inst, "setup", "--github-app-key", pem, "--json");
  assert.equal(JSON.parse(alone.out).status, "refused");
  assert.match(alone.out, /give --github-app-id too/);
  assert.equal(existsSync(copy), false);
  const wrong = join(inst.root, "not-a-key.pem");
  writeFileSync(wrong, "-----BEGIN RSA PRIVATE KEY-----\nnope\n");
  const unreadable = await factory(
    inst,
    "setup",
    "--github-app-id",
    "42",
    "--github-app-key",
    wrong,
  );
  assert.equal(unreadable.code, 2);
  assert.match(unreadable.err, /is not a private key Factory can read/);
  assert.doesNotMatch(unreadable.err, /nope/);

  const check = (report, name) =>
    report.readiness.checks.filter((entry) => entry.name === name);
  const first = await factory(
    inst,
    "setup",
    "--github-app-id",
    "42",
    "--github-app-key",
    pem,
    "--operator",
    "kirk",
    "--json",
  );
  assert.doesNotMatch(first.out + first.err, /PRIVATE KEY|MII/);
  const report = JSON.parse(first.out);
  // The App replaces the GitHub CLI's login the configuration chose.
  assert.deepEqual(
    [...report.changed].sort(),
    ["FACTORY_GITHUB_APP_KEY", "github.app.id", "github.login", "operators"],
    first.out,
  );
  const saved = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  assert.deepEqual(saved.github, { app: { id: 42 } });
  assert.deepEqual(saved.operators, ["kirk"]);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE KEY/);
  assert.equal(readFileSync(copy, "utf8"), key.privateKey);
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  const [lacking] = check(report, "GitHub App");
  assert.equal(lacking.status, "blocked", JSON.stringify(lacking));
  assert.match(lacking.detail, /lacks workflows: write/);

  permissions = APP_PERMISSIONS;
  const again = JSON.parse((await factory(inst, "setup", "--json")).out);
  assert.deepEqual(again.changed, []);
  const app = check(again, "GitHub App");
  assert.equal(app[0].status, "ok", JSON.stringify(app));
  assert.match(
    app[0].detail,
    /acts as drill-factory\[bot\] \(App 42, installation 7\)/,
  );
  // The test checkout's origin is SSH: its pushes don't go as the App.
  assert.equal(app[1].status, "warn");
  assert.match(app[1].detail, /SSH login/);
  const [operators] = check(again, "operators");
  assert.equal(operators.status, "ok", JSON.stringify(operators));
  assert.match(operators.detail, /@kirk/);

  // The service loads setup's copy, the key readiness checked: a bound
  // key file is refused before anything runs.
  const bound = await factory(
    inst,
    "setup",
    "--background",
    "--credential-file",
    `FACTORY_GITHUB_APP_KEY=${pem}`,
  );
  assert.equal(bound.code, 2);
  assert.match(bound.err, /takes no FACTORY_GITHUB_APP_KEY.*--github-app-key/);

  // Another App while an Objective has state is refused; the same App
  // changes nothing.
  mkdirSync(join(inst.root, "objectives"), { recursive: true });
  writeFileSync(join(inst.root, "objectives", "5.json"), "{}\n");
  const other = JSON.parse(
    (await factory(inst, "setup", "--github-app-id", "43", "--json")).out,
  );
  assert.equal(other.status, "refused");
  assert.match(other.problems[0], /#5 still has state/);
  assert.match(other.problems[0], /factory queue drain/);
  // So is going back to the GitHub CLI's login.
  const back = JSON.parse(
    (await factory(inst, "setup", "--github-login", "--json")).out,
  );
  assert.equal(back.status, "refused");
  assert.match(back.problems[0], /^--github-login changes who Factory acts as/);
  assert.deepEqual(
    JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8")).github,
    { app: { id: 42 } },
  );
  const same = JSON.parse(
    (await factory(inst, "setup", "--github-app-id", "42", "--json")).out,
  );
  assert.deepEqual(same.changed, []);
});

test("readiness warns when no operator is set, or when Factory acts as the operator, and links the App registration", async () => {
  const { api } = await fakeGitHub({
    "GET /user": () => [200, { login: "kirk" }],
    [`GET /repos/${REPO}`]: repository,
    "GET /users/drill": () => [200, { login: "drill", type: "Organization" }],
  });
  const inst = installation();
  configured(inst, api);
  const operators = async (...args) =>
    JSON.parse(
      (await factory(inst, "setup", ...args, "--json")).out,
    ).readiness.checks.find((entry) => entry.name === "operators");
  const none = await operators();
  assert.equal(none.status, "warn");
  assert.match(none.detail, /holds notify nobody/);
  assert.match(none.fix, /--operator LOGIN/);
  const self = await operators("--operator", "Kirk");
  assert.equal(self.status, "warn");
  assert.match(self.detail, /Factory acts as kirk, which is the operator Kirk/);
  assert.match(
    self.fix,
    /https:\/\/github\.com\/organizations\/drill\/settings\/apps\/new\?name=/,
  );
  assert.match(self.fix, /--github-app-id ID --github-app-key PATH/);
  const link = await factory(inst, "setup", "--github-app-link", "--json");
  assert.equal(link.code, 0, link.err);
  const shown = JSON.parse(link.out);
  assert.match(
    shown.link,
    /^https:\/\/github\.com\/organizations\/drill\/settings\/apps\/new\?/,
  );
  assert.equal(shown.next, appSteps(true));
  assert.match(self.fix, /install it on All repositories of the organization/);
  const mixed = await factory(
    inst,
    "setup",
    "--github-app-link",
    "--operator",
    "kirk",
  );
  assert.equal(mixed.code, 2);
});

test("a configuration naming no GitHub identity, as before 0.5.2, is blocked on the App's preflight step; --github-login records the opt-out, and with an Objective in flight the App is refused", async () => {
  const { api } = await fakeGitHub({
    "GET /user": () => [200, { login: "kirk" }],
    [`GET /repos/${REPO}`]: repository,
  });
  const inst = installation();
  configured(inst, api, {}, { github: undefined });
  const setup = async (...args) =>
    JSON.parse((await factory(inst, "setup", ...args, "--json")).out);
  const saved = () =>
    JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8")).github;
  const named = (report, name) =>
    report.readiness.checks.filter((entry) => entry.name === name);

  // The upgraded configuration loads, and nothing changes who Factory is.
  const upgraded = await setup();
  assert.equal(upgraded.status, "blocked");
  assert.deepEqual(upgraded.changed, []);
  assert.equal(saved(), undefined);
  const [identity, ...more] = named(upgraded, "GitHub App");
  assert.deepEqual(more, []);
  assert.equal(identity.status, "blocked");
  assert.match(identity.fix, /preflight step/);
  assert.match(identity.fix, /factory setup --github-app-link/);
  assert.match(
    identity.fix,
    /https:\/\/github\.com\/organizations\/drill\/settings\/apps\/new\?name=/,
  );
  assert.match(
    identity.fix,
    /--github-app-id ID --github-app-key PATH --operator LOGIN/,
  );
  assert.match(identity.fix, /factory setup --github-login$/);
  // Nothing is read as the login no one chose.
  assert.deepEqual(named(upgraded, "GitHub"), []);
  assert.deepEqual(named(upgraded, "operators"), []);

  // An Objective in flight finds what it made by the login: the App would
  // change it, so it waits for a drained queue; the opt-out doesn't.
  mkdirSync(join(inst.root, "objectives"), { recursive: true });
  writeFileSync(join(inst.root, "objectives", "5.json"), "{}\n");
  const pem = join(inst.root, "downloaded.pem");
  writeFileSync(pem, key.privateKey, { mode: 0o600 });
  const app = ["--github-app-id", "42", "--github-app-key", pem];
  const refused = await setup(...app);
  assert.equal(refused.status, "refused");
  assert.match(
    refused.problems[0],
    /^--github-app-id changes who Factory acts as on GitHub, and #5 still has state/,
  );
  assert.equal(saved(), undefined);
  assert.equal(existsSync(join(inst.root, "github-app-key.pem")), false);

  const kept = await setup("--github-login");
  assert.notEqual(kept.status, "refused", JSON.stringify(kept.problems));
  assert.deepEqual(kept.changed, ["github.login"]);
  assert.deepEqual(saved(), { login: true });
  assert.deepEqual(named(kept, "GitHub App"), []);
  // With the opt-out, readiness warns as before: holds notify nobody.
  const [operators] = named(kept, "operators");
  assert.equal(operators.status, "warn");
  assert.match(operators.detail, /holds notify nobody/);
  assert.equal((await setup(...app)).status, "refused");
  assert.deepEqual(saved(), { login: true });

  // Once the Objective is finished, the App replaces the login.
  mkdirSync(join(inst.root, "objectives", "finished"));
  renameSync(
    join(inst.root, "objectives", "5.json"),
    join(inst.root, "objectives", "finished", "5.json"),
  );
  const adopted = await setup(...app);
  assert.notEqual(adopted.status, "refused", JSON.stringify(adopted.problems));
  assert.deepEqual([...adopted.changed].sort(), [
    "FACTORY_GITHUB_APP_KEY",
    "github.app.id",
    "github.login",
  ]);
  assert.deepEqual(saved(), { app: { id: 42 } });
});

test("setup takes one GitHub identity: --github-login with an App option is refused, both keys by hand don't load, and --github-login drops the App and its key copy", async () => {
  const { api } = await fakeGitHub({});
  const inst = installation();
  configured(inst, api, {}, { github: { app: { id: 42 } } });
  const copy = join(inst.root, "github-app-key.pem");
  writeFileSync(copy, key.privateKey, { mode: 0o600 });
  for (const flags of [
    ["--github-app-id", "42"],
    ["--github-app-installation", "9"],
  ]) {
    const both = await factory(inst, "setup", "--github-login", ...flags);
    assert.equal(both.code, 2, both.err);
    assert.match(
      both.err,
      /--github-login keeps the GitHub CLI's login instead of a GitHub App: drop --github-app-/,
    );
  }
  // The App's key copy setup kept stays through a usage error, and goes
  // with the App, unread; while the background unit loads it, it stays
  // until --background rewrites the unit (the unit is written, never loaded).
  assert.equal(existsSync(copy), true);
  const units = tempDir("factory-units-");
  inst.env.XDG_CONFIG_HOME = units;
  mkdirSync(join(units, "systemd", "user"), { recursive: true });
  const unit = join(
    units,
    "systemd",
    "user",
    unitName({ root: realpathSync(inst.root) }),
  );
  writeFileSync(
    unit,
    unitText(REPO, [{ name: "FACTORY_GITHUB_APP_KEY", file: copy }]),
  );
  const config = inst.env.FACTORY_CONFIG;
  const switched = JSON.parse(
    (await factory(inst, "setup", "--github-login", "--json")).out,
  );
  assert.deepEqual([...switched.changed].sort(), [
    "github.app",
    "github.login",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).github, {
    login: true,
  });
  assert.equal(existsSync(copy), true);
  rmSync(unit);
  const unbound = JSON.parse(
    (await factory(inst, "setup", "--github-login", "--json")).out,
  );
  assert.deepEqual(unbound.changed, ["FACTORY_GITHUB_APP_KEY"]);
  assert.equal(existsSync(copy), false);
  const again = JSON.parse(
    (await factory(inst, "setup", "--github-login", "--json")).out,
  );
  assert.deepEqual(again.changed, []);

  const written = JSON.parse(readFileSync(config, "utf8"));
  written.github = { app: { id: 42 }, login: true };
  writeFileSync(config, JSON.stringify(written));
  const loaded = JSON.parse((await factory(inst, "setup", "--json")).out);
  assert.equal(loaded.status, "refused");
  assert.match(
    loaded.problems[0],
    /github\.app and github\.login are both set/,
  );
});

test("serve refuses to start on a configuration naming no GitHub identity, as before 0.5.2, and status shows why; with the App or the login it starts", async () => {
  const { api } = await fakeGitHub(appRoutes({ minted: 0 }));
  const inst = installation();
  configured(
    inst,
    api,
    { FACTORY_GITHUB_APP_KEY: key.privateKey },
    { github: undefined },
  );
  delete inst.env.CREDENTIALS_DIRECTORY;
  const holder = () =>
    spawnSync(
      "git",
      [
        "--git-dir",
        join(inst.root, "origin.git"),
        "for-each-ref",
        "--format=%(objectname)",
        "refs/factory/holder",
      ],
      { encoding: "utf8" },
    ).stdout.trim();
  const named = (github) => {
    const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
    config.github = github;
    writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  };
  const why =
    /The configuration of drill\/target names no GitHub identity \(github\.app or github\.login\), so the service refuses to start\. Factory acts as its own GitHub App, setup's preflight step \(docs\/reference\/setup\.md#github-identity\): register and install it \(factory setup --repo drill\/target --github-app-link prints the link\), then run factory setup --repo drill\/target --github-app-id N --github-app-key PATH --operator LOGIN\. Or keep the GitHub CLI's login: factory setup --repo drill\/target --github-login\./;

  // Refused as a configuration that doesn't load is: the unit doesn't
  // restart on it, and nothing reaches GitHub or takes the repository.
  const refused = await exited(serve(inst), "the refused start");
  assert.equal(refused.code, 78, refused.stderr);
  assert.match(refused.stderr, new RegExp(`^factory: ${why.source}$`, "m"));
  assert.equal(holder(), "", "a refused start takes nothing");
  const shown = JSON.parse(cli(inst, "status", "--json").out);
  assert.match(shown.setup.identity, why);
  assert.match(
    cli(inst, "status").out,
    /\n {2}Not ready: The configuration of drill\/target names no GitHub identity/,
  );

  for (const github of [{ login: true }, { app: { id: APP } }]) {
    named(github);
    const view = JSON.parse(cli(inst, "status", "--json").out);
    assert.equal(view.setup.identity, undefined);
    assert.doesNotMatch(cli(inst, "status").out, /Not ready/);
    const serving = serve(inst);
    await until(
      () => JSON.parse(cli(inst, "status", "--json").out).service === "running",
      `a start with ${JSON.stringify(github)}`,
    );
    assert.notEqual(holder(), "");
    assert.equal((await stopped(serving)).code, 0, serving.stderr());
  }
});
