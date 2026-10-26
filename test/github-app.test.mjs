// Factory's own GitHub identity, a GitHub App (github-app.ts): its JWT, the
// installation token and its refresh, the bot's login and commit author,
// remote Git's token, the operators' mentions, and setup's App options,
// registration link and readiness. GitHub is a local fake.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { originBound } from "../dist/git.js";
import { GitHubError, githubOutcome } from "../dist/github.js";
import {
  APP_PERMISSIONS,
  appJwt,
  appRegistrationLink,
  factoryGitHub,
  missingPermissions,
} from "../dist/github-app.js";
import { cancelComment, questionComment } from "../dist/github-sync.js";
import { redact } from "../dist/log.js";
import { mark } from "../dist/markdown.js";
import { FACTORY_EMAIL, factoryCommit } from "../dist/work/collect.js";
import { reportComment } from "../dist/work/finish.js";
import { workerEnvironment } from "../dist/worktree.js";
import {
  CLI,
  children,
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
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
  assert.doesNotMatch(reportComment(mark(5, "report", "run"), state, []), /@/);
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
  assert.deepEqual(
    [...report.changed].sort(),
    ["FACTORY_GITHUB_APP_KEY", "github.app.id", "operators"],
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
  assert.match(shown.next, /install it on the repository/);
  const mixed = await factory(
    inst,
    "setup",
    "--github-app-link",
    "--operator",
    "kirk",
  );
  assert.equal(mixed.code, 2);
});
