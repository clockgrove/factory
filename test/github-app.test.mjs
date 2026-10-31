// Factory's own GitHub identity, a GitHub App (github-app.ts): the
// installation token and its refresh, the bot's login, remote Git's token,
// the operators' mentions, and setup's copy of the App's key. GitHub is a
// local fake.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { publish } from "../dist/delivery.js";
import { originBound } from "../dist/git.js";
import { APP_PERMISSIONS, factoryGitHub } from "../dist/github-app.js";
import {
  cancelComment,
  GitHubSync,
  questionComment,
} from "../dist/github-sync.js";
import { mark } from "../dist/markdown.js";
import { postPlan } from "../dist/planning/steps.js";
import { FACTORY_EMAIL } from "../dist/work/collect.js";
import { reportComment } from "../dist/work/finish.js";
import { workerEnvironment } from "../dist/worktree.js";
import {
  CLI,
  children,
  configured,
  githubOrigin,
  installation,
  item,
  offered,
  plan,
  REPO,
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
