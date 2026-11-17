import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Local } from "../scripts/local.mjs";
import { localAppIdCheck } from "../scripts/doctor.mjs";
import { readLocalAppId, saveLocalAppId } from "../scripts/lib/app-id.mjs";

// Pendulum's App id on this machine (#564): the repository variable, read again with the gh login's token on a 403, and
// its readable local copy beside the local token, which setup, serve and doctor save for `pendulum report`.

const REPO = { owner: "o", name: "r", full: "o/r" };
const home = () => process.env.HOME;
const copyFile = () => join(home(), ".config", "pendulum", "repos", "o", "r.json");
const dropCopies = () => rmSync(join(home(), ".config", "pendulum", "repos"), { recursive: true, force: true });

/**
 * A fake GitHub answering the variables list and the one variable per token (the Authorization header's, without
 * "Bearer "): `list(token)` and `one(token)` give a value ({vars} for the list), {status} or null (404). `asked`: each
 * request as "<path> <token>".
 */
async function host({ list = () => ({ status: 403 }), one = () => null } = {}) {
  const asked = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    asked.push(`${path} ${token}`);
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const a = path === "/repos/o/r/actions/variables" ? list(token) : path === "/repos/o/r/actions/variables/PENDULUM_APP_ID" ? one(token) : null;
    if (a === null || a === undefined) return send(404, { message: "Not Found" });
    if (a.status) return send(a.status, { message: "Resource not accessible by personal access token" });
    if (a.vars) return send(200, { total_count: Object.keys(a.vars).length, variables: Object.entries(a.vars).map(([name, value]) => ({ name, value })) });
    return send(200, { name: "PENDULUM_APP_ID", value: String(a) });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((ok) => server.close(ok)) };
}

/** Run `fn` against `url` with a fake `gh` first on PATH (`gh auth token` prints `token`; null: no login); its stdout lines. */
async function around(url, token, fn) {
  const bin = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(bin, "gh"), token === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\n[ "$1 $2" = "auth token" ] && { echo ${token}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const saved = { api: process.env.GITHUB_API_URL, path: process.env.PATH };
  process.env.GITHUB_API_URL = url;
  process.env.PATH = `${bin}:${saved.path}`;
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  let value;
  try {
    value = await fn();
  } finally {
    process.stdout.write = write;
    process.env.PATH = saved.path;
    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  }
  return { value, said: lines.join("") };
}

test("the App id's local copy: readable, written by its owner alone, never through a link; an id that is no App id is refused", () => {
  try {
    assert.deepEqual(readLocalAppId("o/r"), { id: null, file: copyFile() });
    assert.deepEqual(saveLocalAppId("o/r", "5487746"), { file: copyFile(), saved: true });
    assert.deepEqual(JSON.parse(readFileSync(copyFile(), "utf8")), { appId: 5487746 });
    assert.equal(lstatSync(copyFile()).mode & 0o777, 0o644, "no secret: readable");
    assert.equal(lstatSync(join(copyFile(), "..")).mode & 0o777, 0o700);
    assert.deepEqual(saveLocalAppId("o/r", 5487746), { file: copyFile(), saved: false }, "the same id: nothing written");
    assert.deepEqual(readLocalAppId("o/r"), { id: 5487746, file: copyFile() });
    assert.throws(() => saveLocalAppId("o/r", "pendulum-app"), /is no GitHub App id/);
    assert.throws(() => saveLocalAppId("../r", 1), /must be OWNER\/NAME/);
    chmodSync(copyFile(), 0o664);
    assert.match(readLocalAppId("o/r").problem, /r\.json is writable by others \(mode 664\); chmod go-w /);
    assert.throws(() => saveLocalAppId("o/r", 7), /writable by others .*the App id was not saved/);
    // The owner's folder writable by others: the file in it could be swapped, so it is not read.
    chmodSync(copyFile(), 0o644);
    chmodSync(join(copyFile(), ".."), 0o777);
    assert.match(readLocalAppId("o/r").problem, /repos\/o is writable by others \(mode 777\)/);
    chmodSync(join(copyFile(), ".."), 0o700);
    // The file itself a link: never followed.
    rmSync(copyFile());
    const target = join(mkdtempSync(join(tmpdir(), "target-")), "r.json");
    writeFileSync(target, JSON.stringify({ appId: 99 }), { mode: 0o644 });
    symlinkSync(target, copyFile());
    assert.match(readLocalAppId("o/r").problem, /r\.json is a symbolic link/);
    // A link in place of the owner's folder: neither read nor written through.
    dropCopies();
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    writeFileSync(join(elsewhere, "r.json"), JSON.stringify({ appId: 99 }));
    mkdirSync(join(home(), ".config", "pendulum", "repos"), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(home(), ".config", "pendulum", "repos", "o"));
    assert.match(readLocalAppId("o/r").problem, /repos\/o is a symbolic link/);
    assert.equal(readLocalAppId("o/r").id, null);
    assert.throws(() => saveLocalAppId("o/r", 7), /symbolic link/);
  } finally {
    dropCopies();
  }
});

test("serve's start saves the App id's local copy: from the variables list, else, the list refused, from the gh login's read of the one variable; a variable not set is said with its gh variable set line", async () => {
  const start = () => Object.assign(Object.create(Local.prototype), { repo: REPO, repoFull: "o/r", token: "local" });
  // The local token may not read variables; the gh login reads the one variable.
  let gh = await host({ list: () => ({ status: 403 }), one: (t) => (t === "gho_login" ? 5487746 : { status: 403 }) });
  try {
    const loop = start();
    const { value, said } = await around(gh.url, "gho_login", async () => {
      await loop.readVariables();
      return loop.keepAppId();
    });
    assert.equal(value.id, 5487746);
    assert.equal(value.from, "variable-gh");
    assert.deepEqual(readLocalAppId("o/r"), { id: 5487746, file: copyFile() });
    assert.match(said, /saved Pendulum's App id 5487746 \(the repository variable as the gh login reads it\) for `pendulum report` to \S+\/\.config\/pendulum\/repos\/o\/r\.json/);
    assert.ok(!said.includes("gho_login"), "the gh token is never printed");
    assert.deepEqual(gh.asked, ["/repos/o/r/actions/variables local", "/repos/o/r/actions/variables/PENDULUM_APP_ID gho_login"]);
    // A later start with the copy there and the list still refused reads it again, so a replaced App's id is taken.
    gh.close();
    gh = await host({ list: () => ({ status: 403 }), one: (t) => (t === "gho_login" ? 6000001 : { status: 403 }) });
    const again = start();
    const later = await around(gh.url, "gho_login", async () => {
      await again.readVariables();
      return again.keepAppId();
    });
    assert.deepEqual([later.value.id, later.value.from, later.value.saved], [6000001, "variable-gh", true]);
    assert.equal(readLocalAppId("o/r").id, 6000001);
    // A gh login whose token is the local token itself, which was refused: no second read.
    gh.asked.length = 0;
    const same = Object.assign(start(), { token: "gho_login" });
    const skipped = await around(gh.url, "gho_login", async () => {
      await same.readVariables();
      return same.keepAppId();
    });
    assert.equal(skipped.value.from, "forbidden");
    assert.deepEqual(gh.asked, ["/repos/o/r/actions/variables gho_login"]);
    assert.match(skipped.said, /could not be read .*`pendulum report` takes the local copy, 6000001, unverified/);
  } finally {
    dropCopies();
    await gh.close();
  }
  // The list holds it: no further call, and a copy naming another App is brought up to date.
  gh = await host({ list: () => ({ vars: { PENDULUM_APP_ID: "2271", PENDULUM_MAX_USD: "5" } }) });
  try {
    saveLocalAppId("o/r", 17);
    const loop = start();
    const { value } = await around(gh.url, null, async () => {
      await loop.readVariables();
      return loop.keepAppId();
    });
    assert.deepEqual([value.id, value.from, value.saved], [2271, "variable", true]);
    assert.equal(readLocalAppId("o/r").id, 2271);
    assert.deepEqual(gh.asked, ["/repos/o/r/actions/variables local"]);
  } finally {
    dropCopies();
    await gh.close();
  }
  // Not set: said, with the line that sets it; nothing saved.
  gh = await host({ list: () => ({ vars: { PENDULUM_MAX_USD: "5" } }) });
  try {
    const loop = start();
    const { value, said } = await around(gh.url, null, async () => {
      await loop.readVariables();
      return loop.keepAppId();
    });
    assert.equal(value.from, "unset");
    assert.match(said, /the repository variable PENDULUM_APP_ID is not set, .*set it once: gh variable set PENDULUM_APP_ID --repo o\/r --body </);
    assert.equal(readLocalAppId("o/r").id, null);
  } finally {
    dropCopies();
    await gh.close();
  }
});

test("doctor in local mode: the App id variable not set is a WARN naming its gh variable set line; read through the gh login it is a PASS and its local copy is saved; unreadable with no copy is a WARN", async () => {
  const gh = await host({ one: (t) => (t === "gho_login" ? 5487746 : { status: 403 }) });
  try {
    const unset = await localAppIdCheck({ repo: REPO, listed: { vars: { PENDULUM_MAX_USD: "5" } }, fallback: () => null });
    assert.equal(unset.status, "WARN");
    assert.match(unset.detail, /the repository variable PENDULUM_APP_ID is not set/);
    assert.match(unset.fix, /^gh variable set PENDULUM_APP_ID --repo o\/r --body </);
    assert.equal(readLocalAppId("o/r").id, null);

    // The gh login is the refused token itself: not read again.
    const { value: same } = await around(gh.url, "gho_login", () => localAppIdCheck({ repo: REPO, listed: { refused: 403 }, token: "gho_login" }));
    assert.equal(same.status, "WARN");
    assert.equal(gh.asked.length, 0);
    const notId = await localAppIdCheck({ repo: REPO, listed: { vars: { PENDULUM_APP_ID: "pendulum" } }, fallback: () => null });
    assert.match(notId.detail, /PENDULUM_APP_ID is no App id \(a number\)/);
    const { value: read } = await around(gh.url, "gho_login", () => localAppIdCheck({ repo: REPO, listed: { refused: 403 }, token: "local" }));
    assert.equal(read.status, "PASS");
    assert.match(read.detail, /^PENDULUM_APP_ID is 5487746 \(read with the gh login: the local token may not read it\); its local copy for `pendulum report` is \S+r\.json \(saved now\)$/);
    assert.deepEqual(readLocalAppId("o/r"), { id: 5487746, file: copyFile() });
    // Neither token may read it: a PASS while the copy is there, a WARN with the fix once it is not.
    const { value: copied } = await around(gh.url, null, () => localAppIdCheck({ repo: REPO, listed: { refused: 403 } }));
    assert.equal(copied.status, "PASS");
    assert.match(copied.detail, /takes the local copy, 5487746/);
    dropCopies();
    const { value: none } = await around(gh.url, null, () => localAppIdCheck({ repo: REPO, listed: { refused: 403 } }));
    assert.equal(none.status, "WARN");
    assert.match(none.detail, /could not be read: .*\(app-unreadable\)/);
    assert.match(none.fix, /log in with gh/);
  } finally {
    dropCopies();
    await gh.close();
  }
});
