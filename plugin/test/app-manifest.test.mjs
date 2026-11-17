// setup's app step (#471): a GitHub App from a pre-filled definition, by GitHub's App Manifest flow. setup.mjs runs as
// a person runs it, against a fake GitHub, with a stub gh and a fake browser that loads the start page, "creates" the
// App at the fake GitHub from the manifest the page posts, and comes back to the listener as GitHub's redirect would.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP_OPTIONAL_PERMISSIONS, APP_PERMISSIONS, permissionGaps } from "../scripts/lib/app-token.mjs";
import { appManifest, manifestPermissions } from "../scripts/lib/app-manifest.mjs";
import { SETUP_STEPS, setupSteps } from "../scripts/setup.mjs";

const SETUP = join(import.meta.dirname, "..", "scripts", "setup.mjs");
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const PEM_LINES = PEM.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"));
const WEBHOOK_SECRET = "whsec-0123456789abcdef";
const CLIENT_SECRET = "clientsecret-0123456789abcdef";
const SHARED_ORG = { ...APP_PERMISSIONS, ...APP_OPTIONAL_PERMISSIONS, organization_projects: "write" };
const SHARED_USER = { ...APP_PERMISSIONS, ...APP_OPTIONAL_PERMISSIONS };

const repoRecord = (type) => ({
  id: 4242,
  name: "widgets",
  full_name: "acme/widgets",
  html_url: "https://github.com/acme/widgets",
  default_branch: "main",
  owner: { login: "acme", id: 77, type },
});

/** A GitHub that knows acme/widgets and turns each code the fake browser registered into its App, once. */
async function fakeGitHub(type, { addPermissions = {} } = {}) {
  const apps = new Map();
  const conversions = [];
  const server = createServer((req, res) => {
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && req.url === "/repos/acme/widgets") return json(200, repoRecord(type));
    const m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url);
    if (req.method === "POST" && m) {
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
        webhook_secret: WEBHOOK_SECRET,
        pem: PEM,
      });
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, apps, conversions, close: () => server.close() };
}

/** setup --apply app as a person runs it: a stub gh (its secret sets logged) and a $BROWSER that records what it opens. */
function runSetup(api, extra = []) {
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
if (a[0] === "secret" && a[1] === "set") {
  const stdin = fs.readFileSync(0, "utf8");
  fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args: a, stdin }) + "\\n");
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "browser"), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: join(bin, "browser"), GITHUB_API_URL: api, GITHUB_GRAPHQL_URL: `${api}/graphql` };
  for (const k of ["GITHUB_ACTIONS", "GITHUB_WORKSPACE", "WSL_DISTRO_NAME"]) delete env[k];
  const child = spawn(process.execPath, [SETUP, "--repo", "acme/widgets", "--apply", "app", "--yes", ...extra], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", (status) => r(status)));
  const firstOpened = async () => {
    for (let i = 0; i < 500; i += 1) {
      if (existsSync(opened) && readFileSync(opened, "utf8").trim()) return readFileSync(opened, "utf8").trim().split("\n")[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`the browser was never opened: ${out}`);
  };
  const secrets = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { child, exited, output: () => out, firstOpened, secrets, ghLog };
}

const unescape = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** The fake browser: load the start page, read the form it posts to GitHub. */
async function loadStart(start) {
  const page = await (await fetch(start)).text();
  const action = unescape(/<form method="post" action="([^"]+)"/.exec(page)[1]);
  const manifest = JSON.parse(unescape(/name="manifest" value="([^"]+)"/.exec(page)[1]));
  return { page, action, manifest, state: new URL(action).searchParams.get("state") };
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

test("setup --apply app: the browser's redirect becomes the two secrets through gh's stdin; a wrong state is refused; the key is never shown or stored", async () => {
  const gh = await fakeGitHub("Organization");
  const run = runSetup(gh.url);
  try {
    const start = await run.firstOpened();
    assert.match(start, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);
    const { action, manifest, state } = await loadStart(start);
    assert.match(action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{48}$/);
    assert.deepEqual(manifest.default_permissions, SHARED_ORG, "the served manifest asks for the shared list");
    assert.equal(manifest.hook_attributes.active, false);
    const callback = new URL(manifest.redirect_url);
    assert.equal(callback.origin, new URL(start).origin);
    // Another page's redirect, with a code of its own: refused before GitHub is asked anything.
    const forged = await fetch(`${manifest.redirect_url}?code=attackercode123&state=${"0".repeat(48)}`, { redirect: "manual" });
    assert.equal(forged.status, 400);
    const noState = await fetch(`${manifest.redirect_url}?code=attackercode123`, { redirect: "manual" });
    assert.equal(noState.status, 400);
    assert.deepEqual(gh.conversions, [], "no code of a refused redirect is exchanged");
    // GitHub makes the App from the posted manifest and sends the browser back with its code and our state.
    gh.apps.set("goodcode1234567890", manifest);
    const back = await fetch(`${manifest.redirect_url}?code=goodcode1234567890&state=${state}`, { redirect: "manual" });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), "https://github.com/apps/pendulum-widgets/installations/new");
    assert.deepEqual(leaks(await back.text()), []);
    assert.equal(await run.exited, 0, run.output());
    assert.deepEqual(gh.conversions, ["goodcode1234567890"]);
    const set = run.secrets();
    assert.deepEqual(set.map((s) => s.args), [
      ["secret", "set", "PENDULUM_APP_ID", "--repo", "acme/widgets"],
      ["secret", "set", "PENDULUM_APP_PRIVATE_KEY", "--repo", "acme/widgets"],
    ]);
    assert.equal(set[0].stdin, "123456");
    assert.equal(set[1].stdin, PEM, "the key reaches gh on its stdin, whole");
    const out = run.output();
    assert.deepEqual(leaks(out), [], "no secret in setup's output");
    assert.ok(!out.includes("goodcode1234567890"), "nor the code");
    assert.match(out, /refused a redirect from the browser whose state is not this run's/);
    assert.match(out, /created the App pendulum-widgets \(id 123456\) for acme and saved PENDULUM_APP_ID and PENDULUM_APP_PRIVATE_KEY as repository secrets; .*https:\/\/github\.com\/apps\/pendulum-widgets\/installations\/new/);
    assert.deepEqual(filesWithKey(process.env.TMPDIR, run.ghLog), [], "the key is in no file but the stub gh's own log");
  } finally {
    run.child.kill();
    gh.close();
  }
});

test("setup --apply app on a personal account: the user's form, no Projects, and an address pasted on stdin is taken as GitHub's redirect", async () => {
  const gh = await fakeGitHub("User");
  const run = runSetup(gh.url);
  try {
    const { action, manifest, state } = await loadStart(await run.firstOpened());
    assert.match(action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    assert.deepEqual(manifest.default_permissions, SHARED_USER);
    gh.apps.set("pastedcode1234567890", manifest);
    // The browser could not reach the listener: the user pastes the address it shows. A wrong one first.
    run.child.stdin.write(`${manifest.redirect_url}?code=pastedcode1234567890&state=${"f".repeat(48)}\n`);
    run.child.stdin.write(`${manifest.redirect_url}?code=pastedcode1234567890&state=${state}\n`);
    assert.equal(await run.exited, 0, run.output());
    assert.match(run.output(), /refused a redirect pasted whose state is not this run's/);
    assert.deepEqual(gh.conversions, ["pastedcode1234567890"]);
    assert.deepEqual(run.secrets().map((s) => [s.args[2], s.stdin]), [["PENDULUM_APP_ID", "123456"], ["PENDULUM_APP_PRIVATE_KEY", PEM]]);
    assert.deepEqual(leaks(run.output()), []);
  } finally {
    run.child.kill();
    gh.close();
  }
});

test("setup --apply app refuses an App GitHub made with a permission beyond the shared list: nothing is saved", async () => {
  const gh = await fakeGitHub("Organization", { addPermissions: { workflows: "write" } });
  const run = runSetup(gh.url, ["--secret-scope", "org"]);
  try {
    const { manifest, state } = await loadStart(await run.firstOpened());
    gh.apps.set("widercode1234567890", manifest);
    const back = await fetch(`${manifest.redirect_url}?code=widercode1234567890&state=${state}`, { redirect: "manual" });
    assert.equal(back.status, 500);
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /not the one asked for \(it has workflows:write beyond Pendulum's permissions\); nothing was saved\. Delete it at https:\/\/github\.com\/apps\/pendulum-widgets/);
    assert.deepEqual(run.secrets(), []);
    assert.deepEqual(leaks(run.output()), []);
  } finally {
    run.child.kill();
    gh.close();
  }
});

test("setup --apply app --secret-scope org saves the organization's secrets, shared with this repository alone", async () => {
  const gh = await fakeGitHub("Organization");
  const run = runSetup(gh.url, ["--secret-scope", "org"]);
  try {
    const { manifest, state } = await loadStart(await run.firstOpened());
    gh.apps.set("orgcode1234567890", manifest);
    assert.equal((await fetch(`${manifest.redirect_url}?code=orgcode1234567890&state=${state}`, { redirect: "manual" })).status, 302);
    assert.equal(await run.exited, 0, run.output());
    assert.deepEqual(run.secrets().map((s) => s.args), [
      ["secret", "set", "PENDULUM_APP_ID", "--org", "acme", "--repos", "widgets"],
      ["secret", "set", "PENDULUM_APP_PRIVATE_KEY", "--org", "acme", "--repos", "widgets"],
    ]);
    assert.match(run.output(), /as organization secrets/);
  } finally {
    run.child.kill();
    gh.close();
  }
});
