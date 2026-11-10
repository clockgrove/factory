import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setMaintainers } from "../scripts/lib/logic.mjs";
import { AUTHOR_FIX, authorGate, trustedIssue } from "../scripts/lib/objective-trust.mjs";
import { blockedLine } from "../scripts/lib/session.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const perms = { kirk: "admin", dev: "write", reader: "read" };
const user = (login, databaseId = 1) => ({ __typename: "User", login, databaseId });
// GitHub's answer: the body with its author and last editor, read together; `permission` is the collaborator permission.
const gh = ({ author, editor = null, lastEditedAt = editor ? "2026-11-09T10:00:00Z" : null, body = "Build the thing.", title = "Objective" }) => ({
  graphql: async (q, vars) => {
    assert.match(q, /issue\(number: \$number\) \{ body lastEditedAt author \{.*\} editor \{.*\} title \}/);
    assert.deepEqual(vars, { owner: "acme", name: "app", number: 7 });
    return { repository: { issue: { body, lastEditedAt, author, editor, title } } };
  },
  permission: async (_, login) => perms[login] ?? null,
});
const rest = { number: 7, title: "Objective", body: "Build the thing.", labels: [{ name: "factory:objective" }] };

test("objective trust: a stranger's body Blocks, naming the stranger, and no text comes back", async () => {
  const t = await trustedIssue(repo, 7, rest, {}, gh({ author: user("stranger") }));
  assert.equal(t.ok, false);
  assert.equal(t.issueData, undefined, "nothing of the body for a harness");
  assert.match(t.reason, /^the issue's author `stranger` cannot push to acme\/app and is not a pinned maintainer, so Factory acts on none of its text/);
  const reader = await trustedIssue(repo, 7, rest, {}, gh({ author: user("reader") }));
  assert.match(reader.reason, /author `reader` cannot push/, "read access is not enough");
});

test("objective trust: a stranger's edit after a maintainer wrote the body Blocks", async () => {
  const t = await trustedIssue(repo, 7, rest, {}, gh({ author: user("kirk"), editor: user("stranger") }));
  assert.equal(t.ok, false);
  assert.match(t.reason, /^the issue's last editor `stranger` cannot push to acme\/app/);
  const ghost = await trustedIssue(repo, 7, rest, {}, gh({ author: user("kirk"), editor: null, lastEditedAt: "2026-11-09T10:00:00Z" }));
  assert.match(ghost.reason, /^the issue's last editor could not be read/, "an edit no one can be named for vouches for nothing");
  const app = await trustedIssue(repo, 7, rest, {}, gh({ author: user("kirk"), editor: { __typename: "Bot", login: "kirk", databaseId: 9 } }));
  assert.match(app.reason, /last editor `kirk\[bot\]` cannot push/, "an App never vouches, even one whose GraphQL login is a writer's");
  const none = await trustedIssue(repo, 7, rest, {}, gh({ author: null }));
  assert.match(none.reason, /^the issue's author could not be read/);
});

test("objective trust: a writer's edit passes, and the stage acts on the body read with the people who vouch for it", async () => {
  const later = "Build the thing, as the maintainer last wrote it.";
  const t = await trustedIssue(repo, 7, rest, {}, gh({ author: user("kirk"), editor: user("dev"), body: later }));
  assert.equal(t.ok, true);
  assert.deepEqual(t.people, [["author", "kirk"], ["last editor", "dev"]]);
  assert.equal(t.issueData.body, later, "never the REST read's body, which a later edit could have changed");
  assert.equal(t.issueData.title, "Objective");
  const self = await trustedIssue(repo, 7, rest, {}, gh({ author: user("kirk"), editor: user("kirk") }));
  assert.deepEqual(self.people, [["author", "kirk"]], "an author editing their own body is asked about once");
});

test("objective trust: a pinned maintainer id vouches without push access, a bare login does not", async () => {
  setMaintainers("acme/app", ["boss#42", "loose"]);
  try {
    const pinned = await trustedIssue(repo, 7, rest, {}, gh({ author: user("boss", 42), editor: user("boss-renamed", 42) }));
    assert.equal(pinned.ok, true);
    assert.equal((await trustedIssue(repo, 7, rest, {}, gh({ author: user("boss", 43) }))).ok, false, "the id, not the login");
    assert.equal((await trustedIssue(repo, 7, rest, {}, gh({ author: user("loose", 5) }))).ok, false, "a maintainer named without an id is trusted for nothing");
    assert.equal((await trustedIssue({ owner: "acme", name: "other", full: "acme/other" }, 7, rest, {}, { ...gh({ author: user("boss", 42) }), graphql: async () => ({ repository: { issue: { body: "x", author: user("boss", 42) } } }) })).ok, false, "pinned for this repository's workflow only");
  } finally {
    setMaintainers("acme/app", []);
  }
});

test("objective trust: the stage Blocks (stage author) before any harness, with the fix for who failed", async () => {
  const applied = [];
  const order = [];
  const apply = async (r, exit, opts) => {
    order.push("apply");
    applied.push({ r, exit, opts });
  };
  const before = async () => order.push("before");
  const stranger = await authorGate({ repo, issue: 7, issueData: rest, pr: { number: 9 }, notify: "boss", opts: { token: "t" }, apply, before, gh: gh({ author: user("stranger") }) });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.issueData, undefined, "no text for a harness");
  assert.deepEqual(order, ["before", "apply"], "the review job's label comes off first");
  assert.deepEqual(applied[0].exit, { issue: 7, pr: { number: 9 }, exit: "blocked", reason: stranger.reason, fix: AUTHOR_FIX.author, notify: "boss", stage: "author" });
  assert.deepEqual(applied[0].opts, { token: "t" });
  const edited = await authorGate({ repo, issue: 7, issueData: rest, notify: "boss", opts: {}, apply, gh: gh({ author: user("kirk"), editor: user("stranger") }) });
  assert.equal(applied[1].exit.fix, AUTHOR_FIX["last editor"]);
  assert.equal(applied[1].exit.pr, null);
  assert.equal(edited.ok, false);
  const ok = await authorGate({ repo, issue: 7, issueData: rest, notify: "boss", opts: {}, apply, gh: gh({ author: user("kirk"), body: "Checked body.", title: "Checked title" }) });
  assert.equal(ok.ok, true);
  assert.equal(applied.length, 2, "a trusted issue applies no exit");
  assert.equal(ok.issueData.body, "Checked body.");
  assert.equal(ok.issueData.title, "Checked title", "the title from the checked read, never the REST read's");
});

test("objective trust: the Blocked notice never tells anyone to edit an issue whose author is the problem", () => {
  const author = blockedLine({ issue: 7, stage: "author", reason: "the issue's author `stranger` cannot push to acme/app and is not a pinned maintainer, so Factory acts on none of its text", fix: AUTHOR_FIX.author });
  assert.doesNotMatch(author, /editing the issue|re-save|save it/);
  assert.match(author, /files the Objective as a new issue/);
  const editor = blockedLine({ issue: 7, stage: "author", reason: "x", fix: AUTHOR_FIX["last editor"] });
  assert.match(editor, /person who can push read the body and save it .* re-apply `factory:objective`/);
  assert.match(blockedLine({ issue: 7, pr: { number: 9 }, stage: "work", reason: "x" }), /^Blocked \(work\): x — PR #9 is a draft with what exists\. Fix by pushing to `factory\/7` or editing the issue/, "every other Block keeps its fix");
});

// The session's route (local.mjs issue, deliver, post-review) against a GitHub that answers like the real one.
const LOCAL = join(import.meta.dirname, "..", "scripts", "local.mjs");
const run = (args, env, cwd) => new Promise((ok) => execFile(process.execPath, [LOCAL, ...args, "--repo", "acme/app"], { cwd, env, encoding: "utf8", timeout: 60_000 }, (e, stdout, stderr) => ok({ code: e ? e.code : 0, stdout, stderr })));
async function fakeGitHub({ author, editor = null, perms: p = perms }) {
  const calls = [];
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: url.pathname, body });
      const path = url.pathname;
      if (path === "/graphql") {
        if (/issue\(number/.test(body.query)) return send(res, 200, { data: { repository: { issue: { title: "Checked title", body: "Checked body.\n\n## Acceptance\n\n- A1: it works", lastEditedAt: editor ? "2026-11-09T10:00:00Z" : null, author, editor } } } });
        return send(res, 200, { data: {} });
      }
      if (req.method !== "GET") return send(res, req.method === "DELETE" ? 204 : 200, req.method === "DELETE" ? undefined : { id: 1 });
      if (path === "/repos/acme/app") return send(res, 200, { full_name: "acme/app", default_branch: "main" });
      if (path === "/user") return send(res, 200, { login: "dev", type: "User" });
      if (path === "/repos/acme/app/issues/7") return send(res, 200, { number: 7, title: "REST title", body: "REST body.", state: "open", labels: [{ name: "factory:objective" }] });
      if (path === "/repos/acme/app/pulls/9") return send(res, 200, { number: 9, head: { ref: "factory/7", sha: "a".repeat(40) }, base: { ref: "main" } });
      const perm = /^\/repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(path);
      if (perm) return p[perm[1]] ? send(res, 200, { permission: p[perm[1]] }) : send(res, 404, { message: "Not Found" });
      return send(res, 200, []);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}
/** A clone of acme/app with a local origin, on `branch`, its default branch carrying `workflow` as factory.yml. */
function clone({ branch = "main", workflow = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "trust-"));
  const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "app\n");
  if (workflow) {
    mkdirSync(join(work, ".github", "workflows"), { recursive: true });
    writeFileSync(join(work, ".github", "workflows", "factory.yml"), workflow);
  }
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "init");
  g(work, "remote", "add", "origin", origin);
  g(work, "push", "-q", "origin", "main");
  if (branch !== "main") {
    g(work, "checkout", "-q", "-b", branch);
    writeFileSync(join(work, "feature.txt"), "work\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "work");
  }
  return { root, work, origin, refs: () => execFileSync("git", ["-C", origin, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }) };
}
const envFor = (url, root) => ({ PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: url, FACTORY_LOCAL_TOKEN: "github_pat_test", GIT_CONFIG_NOSYSTEM: "1" });
const writes = (calls) => calls.filter((c) => c.method !== "GET" && c.path !== "/graphql");

test("session route: `factory issue` hands a session only a body its author and last editor vouch for", async () => {
  const c = clone();
  const out = join(c.root, "issue.md");
  for (const [who, role, fix] of [[{ author: user("stranger") }, "author `stranger`", /files the Objective as a new issue/], [{ author: user("kirk"), editor: user("stranger") }, "last editor `stranger`", /read the body and save it/]]) {
    const fake = await fakeGitHub(who);
    try {
      const r = await run(["issue", "7", "--out", out], envFor(fake.url, c.root), c.work);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`#7 is not given to this session: the issue's ${role.replace(/[`]/g, ".")} cannot push to acme/app`));
      assert.match(r.stderr, fix);
      assert.equal(existsSync(out), false, "no body reaches the session");
      assert.deepEqual(writes(fake.calls), [], "nothing written to GitHub");
    } finally {
      await fake.close();
    }
  }
  const fake = await fakeGitHub({ author: user("kirk"), editor: user("dev") });
  try {
    const r = await run(["issue", "7", "--out", out], envFor(fake.url, c.root), c.work);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "# #7: Checked title\n\nChecked body.\n\n## Acceptance\n\n- A1: it works\n", "the checked read's title and body, as the worker writes issue.md");
  } finally {
    await fake.close();
  }
});

test("session route: a pinned maintainer from the committed workflow vouches for `factory issue`", async () => {
  const c = clone({ workflow: 'name: factory\non: workflow_dispatch\nenv:\n  FACTORY_MAINTAINERS: "boss#42"\njobs: {}\n' });
  const out = join(c.root, "issue.md");
  const fake = await fakeGitHub({ author: user("boss", 42) });
  try {
    const r = await run(["issue", "7", "--out", out], envFor(fake.url, c.root), c.work);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(out, "utf8"), /Checked body/);
  } finally {
    await fake.close();
  }
});

test("session route: `factory deliver` Blocks a stranger's Objective with the author notice and pushes nothing", async () => {
  const c = clone({ branch: "factory/7" });
  const fake = await fakeGitHub({ author: user("stranger") });
  try {
    const r = await run(["deliver", "7", "--out", join(c.root, "out")], envFor(fake.url, c.root), c.work);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /#7: blocked, nothing pushed: the issue's author `stranger` cannot push/);
    const notice = writes(fake.calls).find((x) => x.method === "POST" && x.path === "/repos/acme/app/issues/7/comments");
    assert.ok(notice, "the Blocked notice is posted");
    assert.match(notice.body.body, /Blocked \(author\): the issue's author `stranger` cannot push/);
    assert.match(notice.body.body, /files the Objective as a new issue/);
    assert.doesNotMatch(notice.body.body, /editing the issue/);
    assert.ok(writes(fake.calls).some((x) => x.method === "POST" && x.path === "/repos/acme/app/issues/7/labels" && x.body.labels.includes("factory:blocked")));
    assert.equal(writes(fake.calls).some((x) => /\/pulls/.test(x.path)), false, "no PR opened");
    assert.doesNotMatch(c.refs(), /factory\/7/, "nothing pushed");
  } finally {
    await fake.close();
  }
});

test("session route: `factory post-review` posts nothing on an issue a stranger last edited", async () => {
  const c = clone();
  const file = join(c.root, "findings.json");
  writeFileSync(file, JSON.stringify({ acceptance: [{ entry: "A1", met: true }], comments: [] }));
  const fake = await fakeGitHub({ author: user("kirk"), editor: user("stranger") });
  try {
    const r = await run(["post-review", "9", file], envFor(fake.url, c.root), c.work);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing posted: the issue's last editor `stranger` cannot push to acme\/app/);
    assert.deepEqual(writes(fake.calls), [], "no review posted");
  } finally {
    await fake.close();
  }
});

test("objective trust: the work and review stages Block through the gate before any harness", () => {
  for (const file of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", file), "utf8");
    const at = src.indexOf("await authorGate(");
    assert.ok(at > 0, `${file} checks the Objective's writers`);
    assert.match(src.slice(at, at + 400), /if \(!trusted\.ok\) \{\n\s+log\(trusted\.reason\);\n\s+await finish\("blocked", trusted\.reason\);\n\s+return;/, `${file} stops on a refusal`);
    for (const later of ["declaredQuestion(", "openHandoff(", "validationLoop(", "runHarness(", "openOutbox(", "installPlugin("]) {
      const i = src.indexOf(later, src.indexOf("async function run()"));
      assert.ok(i === -1 || i > at, `${file}: ${later} only after the check`);
    }
  }
});
