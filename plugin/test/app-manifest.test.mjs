// setup's app step (#471): a GitHub App from a pre-filled definition, by GitHub's App Manifest flow. setup.mjs runs as
// a person runs it, against a fake GitHub (API under /api/v3, web pages at its root), with a stub gh and a fake
// browser that loads the start page, posts its form to the fake GitHub, and follows GitHub's redirect back to the
// listener. The listener's own rules run in this process, with the flow's real function.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP_OPTIONAL_PERMISSIONS, APP_PERMISSIONS, permissionGaps } from "../scripts/lib/app-token.mjs";
import { appManifest, browserCommands, createAppFromManifest, manifestPermissions, scrub, webOrigin } from "../scripts/lib/app-manifest.mjs";
import { SETUP_STEPS, setupSteps } from "../scripts/setup.mjs";

const SETUP = join(import.meta.dirname, "..", "scripts", "setup.mjs");
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const PEM_LINES = PEM.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"));
const WEBHOOK_SECRET = "whsec-0123456789abcdef";
const CLIENT_SECRET = "clientsecret-0123456789abcdef";
const SHARED_ORG = { ...APP_PERMISSIONS, ...APP_OPTIONAL_PERMISSIONS, organization_projects: "write" };
const SHARED_USER = { ...APP_PERMISSIONS, ...APP_OPTIONAL_PERMISSIONS };
const REPO = { owner: "acme", name: "widgets", full: "acme/widgets" };

const repoRecord = (type, { admin = true } = {}) => ({
  id: 4242,
  name: "widgets",
  full_name: "acme/widgets",
  html_url: "https://github.com/acme/widgets",
  default_branch: "main",
  owner: { login: "acme", id: 77, type },
  permissions: { admin, push: true, pull: true },
});

/**
 * A GitHub: its API under /api/v3 (the repository, its and the organization's secrets, the code conversion) and its web
 * form for a new App, which makes an App from the posted manifest and redirects to the manifest's redirect_url.
 */
async function fakeGitHub(type, { addPermissions = {}, admin = true, repoSecrets = [], orgSecrets = {}, orgDenied = false, webhookSecret = WEBHOOK_SECRET } = {}) {
  const apps = new Map();
  const conversions = [];
  let n = 0;
  const server = createServer((req, res) => {
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    let m;
    if (req.method === "POST" && (p === "/settings/apps/new" || p === "/organizations/acme/settings/apps/new")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const manifest = JSON.parse(new URLSearchParams(body).get("manifest"));
        const code = `code${(n += 1)}abcdefghij`;
        apps.set(code, manifest);
        res.writeHead(302, { location: `${manifest.redirect_url}?code=${code}&state=${url.searchParams.get("state")}` }).end();
      });
      return;
    }
    if (req.method === "GET" && p === "/api/v3/repos/acme/widgets") return json(200, repoRecord(type, { admin }));
    if (req.method === "GET" && (m = /^\/api\/v3\/repos\/acme\/widgets\/actions\/secrets\/(\w+)$/.exec(p))) return repoSecrets.includes(m[1]) ? json(200, { name: m[1] }) : json(404, { message: "Not Found" });
    if (req.method === "GET" && p === "/api/v3/orgs/acme/actions/secrets") return orgDenied ? json(403, { message: "Resource not accessible" }) : json(200, { total_count: 0, secrets: [] });
    if (req.method === "GET" && (m = /^\/api\/v3\/orgs\/acme\/actions\/secrets\/(\w+)(\/repositories)?$/.exec(p))) {
      const sec = orgSecrets[m[1]];
      if (!sec) return json(404, { message: "Not Found" });
      if (m[2]) return json(200, { total_count: sec.repos.length, repositories: sec.repos.map((full_name) => ({ full_name })) });
      return json(200, { name: m[1], visibility: sec.visibility });
    }
    if (req.method === "POST" && (m = /^\/api\/v3\/app-manifests\/([^/]+)\/conversions$/.exec(p))) {
      conversions.push(m[1]);
      const manifest = apps.get(m[1]);
      if (!manifest) return json(404, { message: "Not Found" });
      apps.delete(m[1]);
      return json(201, {
        id: 123456,
        slug: "pendulum-widgets",
        name: manifest.name,
        html_url: "https://github.com/apps/pendulum-widgets",
        owner: { login: "acme", id: 77, type },
        permissions: { ...manifest.default_permissions, ...addPermissions },
        events: manifest.default_events,
        client_id: "Iv1.abc",
        client_secret: CLIENT_SECRET,
        webhook_secret: webhookSecret,
        pem: PEM,
      });
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const web = `http://127.0.0.1:${server.address().port}`;
  return { web, api: `${web}/api/v3`, apps, conversions, close: () => server.close() };
}

/** A folder with a stub gh (secret sets logged; `failSet`: that set echoes its stdin and exits 1) and a $BROWSER that records what it opens. */
function stubs({ authFails = false, failSet = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "app-step-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const ghLog = join(dir, "gh.jsonl");
  const opened = join(dir, "opened.txt");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "auth" && a[1] === "token") { process.stdout.write("gho_fake\\n"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") { if (a.slice(2).join(" ") !== "--hostname github.com") { process.stderr.write("unexpected " + a.join(" ")); process.exit(2); } if (${authFails}) { process.stderr.write("You are not logged into any GitHub hosts.\\n"); process.exit(1); } process.exit(0); }
if (a[0] === "secret" && a[1] === "set") {
  const stdin = fs.readFileSync(0, "utf8");
  if (a[2] === ${JSON.stringify(failSet)}) { process.stderr.write("failed to set: " + stdin); process.exit(1); }
  fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args: a, stdin }) + "\\n");
  process.exit(0);
}
if (a[0] === "variable" && a[1] === "set") { fs.appendFileSync(${JSON.stringify(ghLog)}.replace(/gh\\.jsonl$/, "vars.jsonl"), JSON.stringify({ args: a }) + "\\n"); process.exit(0); }
process.exit(1);
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "browser"), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  const secrets = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const varLog = join(dir, "vars.jsonl");
  const variables = () => (existsSync(varLog) ? readFileSync(varLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args) : []);
  return { dir, bin, ghLog, opened, secrets, variables };
}

/** setup --apply app as a person runs it, with the stubs on PATH. */
function runSetup(gh, extra = [], stubOpts = {}) {
  const st = stubs(stubOpts);
  const env = { ...process.env, PATH: `${st.bin}:${process.env.PATH}`, BROWSER: join(st.bin, "browser"), PENDULUM_TEST_GITHUB_WEB: gh.web, GITHUB_API_URL: gh.api, GITHUB_GRAPHQL_URL: `${gh.api}/graphql` };
  for (const k of ["GITHUB_ACTIONS", "GITHUB_WORKSPACE", "WSL_DISTRO_NAME"]) delete env[k];
  const child = spawn(process.execPath, [SETUP, "--repo", "acme/widgets", "--apply", "app", "--yes", ...extra], { cwd: st.dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", (status) => r(status)));
  const firstOpened = async () => {
    for (let i = 0; i < 500; i += 1) {
      if (existsSync(st.opened) && readFileSync(st.opened, "utf8").trim()) return readFileSync(st.opened, "utf8").trim().split("\n")[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`the browser was never opened: ${out}`);
  };
  return { ...st, child, exited, output: () => out, firstOpened };
}

const unescape = (s) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));

/** The fake browser: load the start page and read the form it posts to GitHub. */
async function loadStart(start) {
  const res = await fetch(start);
  const page = await res.text();
  const action = unescape(/<form method="post" action="([^"]+)"/.exec(page)[1]);
  const manifest = JSON.parse(unescape(/name="manifest" value="([^"]+)"/.exec(page)[1]));
  return { res, page, action, manifest, state: new URL(action).searchParams.get("state") };
}

/** The fake browser posts the form to GitHub and returns where GitHub sends it (the listener's callback, with code and state). */
async function postForm(action, manifest) {
  const r = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(manifest) }), redirect: "manual" });
  assert.equal(r.status, 302);
  return r.headers.get("location");
}

/** Every file under `root` but `skip` whose text holds a line of the key. */
function filesWithKey(root, skip) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && p !== skip && PEM_LINES.some((l) => readFileSync(p, "latin1").includes(l))) hits.push(p);
    }
  };
  walk(root);
  return hits;
}

const leaks = (text) => [PEM, ...PEM_LINES, WEBHOOK_SECRET, CLIENT_SECRET].filter((s) => text.includes(s));

test("the App's manifest asks for exactly the shared permission list, never workflows, with its webhook off; app runs only when named", () => {
  assert.deepEqual(manifestPermissions(), SHARED_ORG);
  assert.deepEqual(manifestPermissions({ userAccount: true }), SHARED_USER);
  for (const [perms, userAccount] of [[manifestPermissions(), false], [manifestPermissions({ userAccount: true }), true]]) {
    assert.deepEqual(permissionGaps(perms, { userAccount }), { missing: [], extra: [] });
    assert.equal(perms.workflows, undefined);
  }
  const m = appManifest(repoRecord("Organization"), "http://127.0.0.1:1/callback");
  assert.equal(m.name, "Pendulum (widgets)");
  assert.deepEqual(m.hook_attributes, { url: "https://github.com/acme/widgets", active: false });
  assert.deepEqual(m.default_events, []);
  assert.equal(m.public, false);
  assert.ok(appManifest({ ...repoRecord("User"), name: "a-repository-name-far-too-long-for-it" }, "x").name.length <= 34);
  // `all` never makes a new App; named, it runs first.
  assert.deepEqual(setupSteps(["--apply", "all"]), SETUP_STEPS);
  assert.deepEqual(setupSteps(["--apply", "labels,app"]), ["app", "labels"]);
  assert.deepEqual(setupSteps(["--apply", "app", "--apply", "all"]), ["app", ...SETUP_STEPS]);
});

test("the web origin follows the API, $BROWSER takes %s and arguments, and output holding any part of a secret is not shown", () => {
  assert.equal(webOrigin("https://api.github.com"), "https://github.com");
  assert.equal(webOrigin("https://api.github.com/"), "https://github.com");
  // GitHub Enterprise Server and any other address are refused; only the tests' named fake is let through.
  for (const api of ["https://ghe.example.com/api/v3", "https://proxy.example.com"]) assert.throws(() => webOrigin(api, {}), /the app step works with github\.com only/);
  assert.equal(webOrigin("http://127.0.0.1:9/api/v3", { PENDULUM_TEST_GITHUB_WEB: "http://127.0.0.1:9" }), "http://127.0.0.1:9");
  assert.throws(() => webOrigin("http://127.0.0.1:8/api/v3", { PENDULUM_TEST_GITHUB_WEB: "http://127.0.0.1:9" }), /github\.com only/);
  const url = "http://127.0.0.1:9/abc";
  assert.deepEqual(browserCommands("firefox", url), [["firefox", [url]]]);
  assert.deepEqual(browserCommands("firefox --new-window %s:chromium", url), [["firefox", ["--new-window", url]], ["chromium", [url]]]);
  assert.deepEqual(browserCommands("wslview --x", url), [["wslview", ["--x", url]]]);
  // A key's short last line is never left behind: the whole output goes once any line of it is there.
  const shortTail = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz0123456789\nAb==\n-----END RSA PRIVATE KEY-----\n";
  assert.equal(scrub(`failed to set: ${shortTail}`, ["123456", shortTail]), "(its output held a secret value, so it is not shown)");
  assert.equal(scrub("HTTP 403: Resource not accessible", ["123456", shortTail]), "HTTP 403: Resource not accessible");
});

test("setup --apply app: GitHub's redirect becomes the two secrets through gh's stdin; a wrong state is refused; the key is never shown or stored", { timeout: 60_000 }, async () => {
  const gh = await fakeGitHub("Organization");
  const run = runSetup(gh);
  try {
    const start = await run.firstOpened();
    assert.match(start, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);
    const { action, manifest, state } = await loadStart(start);
    assert.equal(action, `${gh.web}/organizations/acme/settings/apps/new?state=${state}`);
    assert.match(state, /^[0-9a-f]{48}$/);
    assert.deepEqual(manifest.default_permissions, SHARED_ORG, "the served manifest asks for the shared list");
    assert.equal(manifest.hook_attributes.active, false);
    assert.equal(new URL(manifest.redirect_url).origin, new URL(start).origin);
    // Another page's redirects, with a code of their own: refused before GitHub is asked anything, one line said.
    const forged = await fetch(`${manifest.redirect_url}?code=attackercode123&state=${"0".repeat(48)}`, { redirect: "manual" });
    assert.equal(forged.status, 400);
    const noState = await fetch(`${manifest.redirect_url}?code=attackercode123`, { redirect: "manual" });
    assert.equal(noState.status, 400);
    assert.deepEqual(gh.conversions, [], "no code of a refused redirect is exchanged");
    // GitHub makes the App from the posted form and sends the browser back with its code and our state.
    const callback = await postForm(action, manifest);
    const back = await fetch(callback, { redirect: "manual" });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), `${gh.web}/apps/pendulum-widgets/installations/new`);
    assert.deepEqual(leaks(await back.text()), []);
    assert.equal(await run.exited, 0, run.output());
    assert.deepEqual(gh.conversions, ["code1abcdefghij"]);
    const set = run.secrets();
    assert.deepEqual(set.map((s) => s.args), [
      ["secret", "set", "PENDULUM_APP_ID", "--repo", "acme/widgets"],
      ["secret", "set", "PENDULUM_APP_PRIVATE_KEY", "--repo", "acme/widgets"],
    ]);
    assert.equal(set[0].stdin, "123456");
    assert.equal(set[1].stdin, PEM, "the key reaches gh on its stdin, whole");
    // The id beside the secret, as the repository variable `pendulum report` reads (#512).
    assert.deepEqual(run.variables(), [["variable", "set", "PENDULUM_APP_ID", "--repo", "acme/widgets", "--body", "123456"]]);
    const out = run.output();
    assert.deepEqual(leaks(out), [], "no secret in setup's output");
    assert.ok(!out.includes("code1abcdefghij"), "nor the code");
    assert.equal(out.match(/refused a redirect/g).length, 1, "refusals close together are one line");
    assert.match(out, /created the App pendulum-widgets \(id 123456\) for acme and saved PENDULUM_APP_ID and PENDULUM_APP_PRIVATE_KEY as repository secrets and its id as the repository variable PENDULUM_APP_ID; .*\/apps\/pendulum-widgets\/installations\/new/);
    assert.deepEqual(filesWithKey(process.env.TMPDIR, run.ghLog), [], "the key is in no file but the stub gh's own log");
  } finally {
    run.child.kill();
    gh.close();
  }
});

test("setup --apply app refuses an App GitHub made with a permission beyond the shared list: nothing is saved, and its settings page is named", { timeout: 60_000 }, async () => {
  const gh = await fakeGitHub("Organization", { addPermissions: { workflows: "write" } });
  const run = runSetup(gh);
  try {
    const { action, manifest } = await loadStart(await run.firstOpened());
    const back = await fetch(await postForm(action, manifest), { redirect: "manual" });
    assert.equal(back.status, 500);
    assert.equal(await run.exited, 1);
    assert.match(run.output(), new RegExp(`not the one asked for \\(it has workflows:write beyond Pendulum's permissions\\); nothing was saved\\. Delete it at ${gh.web}/organizations/acme/settings/apps/pendulum-widgets \\(Advanced, Delete GitHub App\\)`));
    assert.deepEqual(run.secrets(), []);
    assert.deepEqual(leaks(run.output()), []);
  } finally {
    run.child.kill();
    gh.close();
  }
});

test("setup --apply app checks before the browser opens: no secret overwritten without --replace, no organization secret taken from other repositories", { timeout: 60_000 }, async () => {
  const cases = [
    [{ repoSecrets: ["PENDULUM_APP_PRIVATE_KEY"] }, [], /PENDULUM_APP_PRIVATE_KEY/],
    [{ orgSecrets: { PENDULUM_APP_PRIVATE_KEY: { visibility: "selected", repos: ["acme/widgets", "acme/gears"] } } }, ["--secret-scope", "org", "--replace"], /acme\/gears/],
  ];
  for (const [fake, args, want] of cases) {
    const gh = await fakeGitHub("Organization", fake);
    const run = runSetup(gh, args);
    try {
      assert.equal(await run.exited, 1, run.output());
      assert.match(run.output(), want);
      assert.ok(!existsSync(run.opened), "the browser never opened");
    } finally {
      run.child.kill();
      gh.close();
    }
  }
});

/** The flow in this process against `gh`, with the stub gh on PATH; its opened addresses and lines are kept. */
async function inProcess(gh, opts = {}) {
  const st = stubs();
  const saved = { path: process.env.PATH, api: process.env.GITHUB_API_URL };
  process.env.PATH = `${st.bin}:${process.env.PATH}`;
  process.env.GITHUB_API_URL = gh.api;
  const opened = [];
  const lines = [];
  let onOpen;
  const firstOpen = new Promise((r) => (onOpen = r));
  const stop = new AbortController();
  const flow = createAppFromManifest(REPO, repoRecord("Organization"), {
    web: gh.web,
    env: process.env,
    input: null,
    signal: stop.signal,
    say: (l) => lines.push(l),
    open: (u) => {
      opened.push(u);
      onOpen(u);
    },
    ...opts,
  });
  flow.catch(() => {});
  // Each test's end stops its flow, passed or failed, so no listener outlives it.
  const restore = () => {
    stop.abort();
    process.env.PATH = saved.path;
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  };
  return { flow, start: await firstOpen, lines, opened, restore };
}

/** A raw GET or other method to the listener with the Host header given. */
const raw = (url, { method = "GET", host } = {}) =>
  new Promise((ok, fail) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: host ? { host } : {} }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode));
    });
    req.on("error", fail);
    req.end();
  });

test("the listener: only GET with its own Host, the start page's headers, and one redirect at a time", { timeout: 60_000 }, async () => {
  const gh = await fakeGitHub("Organization");
  let release;
  const slow = new Promise((r) => (release = r));
  let saving;
  const saveStarted = new Promise((r) => (saving = r));
  const p = await inProcess(gh, {
    save: async () => {
      saving();
      await slow;
      return ["PENDULUM_APP_ID", "PENDULUM_APP_PRIVATE_KEY"];
    },
  });
  try {
    const { res, action, manifest, state } = await loadStart(p.start);
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'; script-src 'sha256-[^']+'; base-uri 'none'; frame-ancestors 'none'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(await raw(p.start, { method: "POST" }), 400, "no POST");
    assert.equal(await raw(p.start, { host: "rebound.example.com" }), 400, "no other Host");
    assert.equal(await raw(`${manifest.redirect_url}?state=${state}&code=x`, { host: "evil.test:80" }), 400);
    const callback = await postForm(action, manifest);
    const first = fetch(callback, { redirect: "manual" });
    await Promise.race([saveStarted, p.flow.then(() => assert.fail("the flow ended before its save"))]);
    // While the first redirect is being saved: the same redirect again is turned away.
    assert.equal((await fetch(callback, { redirect: "manual" })).status, 409);
    release();
    assert.equal((await first).status, 302);
    const result = await p.flow;
    assert.equal(result.slug, "pendulum-widgets");
  } finally {
    release();
    p.restore();
    gh.close();
  }
});

