// A newcomer's first setup (#470): the first-run preset's settings in the rendered workflow, the required checks setup
// infers when none are given, and the default-token step, which makes the repository's default GITHUB_TOKEN read-only
// on consent. setup.mjs runs as a person runs it, in its own process, against a fake GitHub, with a stub gh whose login
// is a dummy token.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctorFooter, workflowTokenChecks } from "../scripts/doctor.mjs";
import { asksWrite, defaultTokenJobs, defaultTokenState } from "../scripts/setup.mjs";

const SETUP = join(import.meta.dirname, "..", "scripts", "setup.mjs");
const REPO = { owner: "acme", name: "widgets", full: "acme/widgets" };

const CI = "on: [pull_request, merge_group]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22]\n    steps:\n      - run: npm test\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n  shared:\n    uses: ./.github/workflows/checks.yml\n";
const RELEASE =
  "on:\n  push:\n    tags: ['v*']\njobs:\n  build:\n    runs-on: ubuntu-latest\n    permissions: { contents: read }\n    steps:\n      - run: npm pack\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create\n  deploy:\n    uses: ./.github/workflows/deploy.yml\n";
const DEPLOY = "on:\n  workflow_call:\npermissions:\n  contents: write\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./ship.sh\n";

/**
 * A GitHub: the repository (a user's, default branch main), its default workflow token (`perms`), its workflows (two
 * pages; `files` the default branch's contents, a path in `missing` 404s, one in `broken` 403s), its pull_request runs
 * and their jobs, its rulesets and variables. Every request is logged as `METHOD path`; `putStatus` answers the PUT.
 */
async function fakeGitHub({ perms = { default_workflow_permissions: "write", can_approve_pull_request_reviews: false }, files = { ".github/workflows/ci.yml": CI }, missing = [], broken = [], runs = [], jobs = {}, rulesets = [], variables = {}, orgVariables = null, ownerType = "User", putStatus = 204, getStatus = 200 } = {}) {
  const state = { perms: { ...perms }, puts: [], requests: [], rulesets: [...rulesets], posted: [] };
  const listed = [...Object.keys(files), ...missing, ...broken, "dynamic/github-code-scanning/codeql"].map((path, i) => ({ id: i + 1, path, name: path.split("/").pop(), state: "active" }));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    state.requests.push(`${req.method} ${p}`);
    const json = (status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const b = body ? JSON.parse(body) : null;
      if (p === "/repos/acme/widgets" && req.method === "GET") return json(200, { full_name: "acme/widgets", name: "widgets", default_branch: "main", private: false, owner: { login: "acme", type: ownerType } });
      if (p === "/repos/acme/widgets" && req.method === "PATCH") return json(200, {});
      if (p === "/repos/acme/widgets/actions/permissions/workflow") {
        if (req.method === "GET") return getStatus === 200 ? json(200, state.perms) : json(getStatus, { message: "Must have admin rights to Repository." });
        state.puts.push(b);
        if (putStatus !== 204) return json(putStatus, { message: "refused" });
        Object.assign(state.perms, b);
        return res.writeHead(204).end();
      }
      if (p === "/repos/acme/widgets/actions/workflows") {
        // Two pages, so a reader that does not follow the Link header misses the second.
        const page = Number(url.searchParams.get("page") || 1);
        const half = Math.ceil(listed.length / 2);
        const next = `<http://${req.headers.host}/repos/acme/widgets/actions/workflows?per_page=100&page=2>; rel="next"`;
        return page === 1 ? json(200, { total_count: listed.length, workflows: listed.slice(0, half) }, { link: next }) : json(200, { total_count: listed.length, workflows: listed.slice(half) });
      }
      const file = /^\/repos\/acme\/widgets\/contents\/(.+)$/.exec(p)?.[1];
      if (file && files[file]) return res.writeHead(200, { "content-type": "text/plain" }).end(files[file]);
      if (file && broken.includes(file)) return json(403, { message: "Resource not accessible" });
      if (p === "/repos/acme/widgets/actions/runs") return json(200, { total_count: runs.length, workflow_runs: runs });
      const run = /^\/repos\/acme\/widgets\/actions\/runs\/(\d+)\/jobs$/.exec(p)?.[1];
      if (run) return json(200, { total_count: (jobs[run] || []).length, jobs: jobs[run] || [] });
      if (p === "/repos/acme/widgets/rulesets" && req.method === "GET") return json(200, state.rulesets.map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement })));
      if (p === "/repos/acme/widgets/rulesets" && req.method === "POST") {
        state.posted.push(b);
        return json(201, { id: 99, ...b });
      }
      const rs = /^\/repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(p)?.[1];
      if (rs && req.method === "GET") return json(200, state.rulesets.find((r) => String(r.id) === rs) || {});
      if (rs && req.method === "PUT") {
        state.posted.push(b);
        return json(200, b);
      }
      const variable = /^\/repos\/acme\/widgets\/actions\/variables\/(\w+)$/.exec(p)?.[1];
      if (variable && variables[variable] !== undefined) return json(200, { name: variable, value: variables[variable] });
      if (p === "/repos/acme/widgets/actions/organization-variables") {
        if (orgVariables === "denied") return json(403, { message: "Resource not accessible by integration" });
        if (orgVariables) return json(200, { total_count: orgVariables.length, variables: orgVariables });
      }
      return json(404, { message: "Not Found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)) };
}

/** setup.mjs in its own process: a developer's env (no runner or Pendulum variables), a stub gh, the fake GitHub. */
function setup(gh, args, cwd) {
  const dir = mkdtempSync(join(tmpdir(), "first-setup-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n[ "$1 $2" = "auth token" ] && { echo gho_dummy; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const off = /^(GITHUB_|RUNNER_|ACTIONS_|PENDULUM_|INPUT_)|^CI$/;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !off.test(k))), HOME: process.env.HOME, PATH: `${bin}:${process.env.PATH}`, GITHUB_API_URL: gh.url, GITHUB_GRAPHQL_URL: `${gh.url}/graphql` };
  return new Promise((res) => {
    const c = spawn(process.execPath, [SETUP, "--repo", REPO.full, ...args], { cwd: cwd || dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (status) => res({ status, out }));
  });
}

/** `fn` with GITHUB_API_URL pointed at the fake, for a function called in this process. */
async function withApi(gh, fn) {
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = gh.url;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/** doctor's default-token row against the fake GitHub. */
const doctorRow = (gh) => withApi(gh, async () => (await workflowTokenChecks({ repo: REPO, token: "dummy" })).find((r) => r.name === "default workflow token"));

test("#556: doctor's ci token row FAILs a pull_request or merge_group workflow, on any page of the list, that grants any scope write, or write-all, at the top or on a job, naming each grant; read, none, read-all and {} pass", async () => {
  const scopes = ["id-token", "packages", "checks", "statuses", "deployments", "security-events", "pages", "attestations", "discussions", "repository-projects", "a-scope-github-adds-later"];
  const flow = (top, job) => `on: [pull_request, merge_group]\npermissions: ${top}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    permissions: ${job}\n    steps:\n      - run: npm test\n`;
  const files = {
    ...Object.fromEntries(scopes.flatMap((s) => [[`.github/workflows/top-${s}.yml`, flow(`{contents: read, ${s}: write}`, "{}")], [`.github/workflows/job-${s}.yml`, flow("{}", `{contents: read, ${s}: write}`)]])),
    ".github/workflows/top-all.yml": flow("write-all", "read-all"),
    ".github/workflows/job-all.yml": flow("read-all", "write-all"),
    ".github/workflows/read.yml": flow("{contents: read, id-token: none, packages: read}", "{}"),
    ".github/workflows/none.yml": flow("{}", "{contents: none, checks: read}"),
  };
  const gh = await fakeGitHub({ perms: { default_workflow_permissions: "read" }, files });
  try {
    const row = await withApi(gh, async () => (await workflowTokenChecks({ repo: REPO, token: "dummy" })).find((r) => r.name === "ci token"));
    assert.equal(row.status, "FAIL");
    const named = row.detail.replace(/^branch code would run with a token that can write: /, "").split("; ").sort();
    const expected = [...scopes.flatMap((s) => [`.github/workflows/top-${s}.yml (top-level permissions grant ${s}: write)`, `.github/workflows/job-${s}.yml job test (permissions grant ${s}: write)`]), ".github/workflows/top-all.yml (top-level permissions grant write-all)", ".github/workflows/job-all.yml job test (permissions grant write-all)"].sort();
    assert.deepEqual(named, expected, "every grant named, and neither read-only workflow");
    assert.match(row.fix, /no scope at `write` and no `write-all`/);
  } finally {
    await gh.close();
  }
  const clean = await fakeGitHub({ perms: { default_workflow_permissions: "read" }, files: { ".github/workflows/read.yml": files[".github/workflows/read.yml"], ".github/workflows/none.yml": files[".github/workflows/none.yml"] } });
  try {
    const row = await withApi(clean, async () => (await workflowTokenChecks({ repo: REPO, token: "dummy" })).find((r) => r.name === "ci token"));
    assert.equal(row.status, "PASS", row.detail);
  } finally {
    await clean.close();
  }
});

test("the default-token step: its dry run names who gets a read-only token, a called workflow that asks for write, those left alone and those off the default branch; with --yes the default is read-only and doctor's row passes", async () => {
  const gh = await fakeGitHub({ files: { ".github/workflows/ci.yml": CI, ".github/workflows/release.yml": RELEASE, ".github/workflows/deploy.yml": DEPLOY }, missing: [".github/workflows/old.yml"], broken: [".github/workflows/broken.yml"] });
  try {
    assert.equal((await doctorRow(gh)).status, "FAIL");
    assert.match((await doctorRow(gh)).fix, /--apply default-token/);

    // No consent: the preview reads every page of workflows, names each group, and writes nothing.
    const preview = await setup(gh, ["--apply", "default-token"]);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /default-token: set the repository's default workflow token \(now write\) to read-only/);
    assert.match(preview.out, /get a read-only token: \.github\/workflows\/release\.yml \(jobs publish; deploy, which calls \.github\/workflows\/deploy\.yml, which asks for write: on a read-only default it cannot get it and the run fails\)/);
    assert.match(preview.out, /left alone \(they set their own permissions:\): \.github\/workflows\/ci\.yml(;|$)/m);
    assert.match(preview.out, /reusable \(on: workflow_call\), which run with their caller's token: \.github\/workflows\/deploy\.yml/);
    assert.match(preview.out, /not on the default branch: \.github\/workflows\/old\.yml; they run from other branches, which also get the read-only default; check them by hand/);
    assert.match(preview.out, /could not read \.github\/workflows\/broken\.yml: check them by hand/);
    assert.doesNotMatch(preview.out, /codeql/);
    assert.ok(gh.state.requests.includes("GET /repos/acme/widgets/contents/.github/workflows/old.yml"), "the second page was read");
    assert.deepEqual(gh.state.puts, []);
    assert.equal((await doctorRow(gh)).status, "FAIL");

    // A plain setup (every step `all` runs) never reads or changes the default token, and writes nothing.
    const at = gh.state.requests.length;
    const plain = await setup(gh, []);
    assert.equal(plain.status, 0, plain.out);
    assert.doesNotMatch(plain.out, /default-token/);
    const asked = gh.state.requests.slice(at);
    assert.ok(asked.length > 0, "the other steps' previews read GitHub");
    assert.deepEqual(asked.filter((q) => q.includes("/actions/permissions/") || !q.startsWith("GET ")), []);

    // Consent: one PUT that sets read and keeps the approval setting as it was; doctor's row then passes.
    const r = await setup(gh, ["--apply", "default-token", "--yes"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(gh.state.puts, [{ default_workflow_permissions: "read", can_approve_pull_request_reviews: false }]);
    assert.match(r.out, /default-token: the default workflow token is read-only now \(it was write\); .*release\.yml \(jobs publish; deploy, which calls/);
    assert.equal((await doctorRow(gh)).status, "PASS");

    // Already read-only: nothing is sent.
    const again = await setup(gh, ["--apply", "default-token", "--yes"]);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /already read-only; nothing changed/);
    assert.equal(gh.state.puts.length, 1);
  } finally {
    await gh.close();
  }
});

test("the default-token step: a refused PUT names the fix and runs after the workflow step; a GET without can_approve sends only the default", async () => {
  for (const [status, want] of [
    [403, /needs a gh login that administers acme\/widgets \(classic `repo` scope or fine-grained Administration: write\) \(HTTP 403\)/],
    [404, /needs a gh login that administers acme\/widgets .*\(HTTP 404\)/],
    [409, /your organization or enterprise sets this; ask an owner \(HTTP 409\)/],
  ]) {
    const gh = await fakeGitHub({ putStatus: status });
    try {
      const clone = mkdtempSync(join(tmpdir(), "first-setup-clone-"));
      const r = await setup(gh, ["--apply", "default-token,workflow", "--out", join(clone, "p.yml"), "--yes"], clone);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, want);
      assert.match(r.out, /^workflow: wrote /m, "the workflow step ran first");
      assert.ok(r.out.indexOf("workflow: wrote") < r.out.indexOf("setup failed"));
    } finally {
      await gh.close();
    }
  }
  const gh = await fakeGitHub({ perms: { default_workflow_permissions: "write" } });
  try {
    const r = await setup(gh, ["--apply", "default-token", "--yes"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(gh.state.puts, [{ default_workflow_permissions: "read" }]);
  } finally {
    await gh.close();
  }
});

test("the default-token step: a refused read of the setting names the same fix in the preview and with --yes", async () => {
  const gh = await fakeGitHub({ getStatus: 403 });
  try {
    const preview = await setup(gh, ["--apply", "default-token"]);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /default-token: set the repository's default workflow token to read-only; could not read the default workflow token: it needs a gh login that administers acme\/widgets \(classic `repo` scope or fine-grained Administration: write\) \(HTTP 403\)/);
    const r = await setup(gh, ["--apply", "default-token", "--yes"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /could not read the default workflow token: it needs a gh login that administers acme\/widgets/);
    assert.deepEqual(gh.state.puts, []);
  } finally {
    await gh.close();
  }
});

test("the default-token step lists a workflow on push and workflow_call with its own permissions in both roles", async () => {
  const both = "on:\n  push:\n  workflow_call:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";
  const gh = await fakeGitHub({ files: { ".github/workflows/both.yml": both, ".github/workflows/deploy.yml": DEPLOY } });
  try {
    const st = await withApi(gh, () => defaultTokenState(REPO, { token: "dummy" }));
    assert.deepEqual(st.own, [".github/workflows/both.yml"], "on push, its own permissions: left alone");
    assert.deepEqual(st.reusable.sort(), [".github/workflows/both.yml", ".github/workflows/deploy.yml"], "called, its caller's token");
  } finally {
    await gh.close();
  }
});

test("defaultTokenJobs and asksWrite: an empty mapping and write-all are permissions of the file's own; defaultTokenState sorts a 404 and an unreadable file apart", async () => {
  assert.deepEqual(defaultTokenJobs({ permissions: {}, jobs: { a: {} } }), [], "permissions: {} is the file's own (none)");
  assert.deepEqual(defaultTokenJobs({ permissions: "write-all", jobs: { a: {} } }), [], "write-all is the file's own");
  assert.deepEqual(defaultTokenJobs({ jobs: { a: {}, b: { permissions: {} }, c: { permissions: "read-all" } } }), ["a"]);
  assert.deepEqual(defaultTokenJobs({}), []);
  assert.equal(asksWrite("write-all"), true);
  assert.equal(asksWrite("read-all"), false);
  assert.equal(asksWrite({}), false);
  assert.equal(asksWrite({ contents: "read", "id-token": "write" }), true);
  const gh = await fakeGitHub({ perms: { default_workflow_permissions: "write" }, missing: [".github/workflows/gone.yml"], broken: [".github/workflows/bad.yml"] });
  try {
    const st = await withApi(gh, () => defaultTokenState(REPO, { token: "dummy" }));
    assert.equal(st.current, "write");
    assert.equal(st.canApprove, undefined);
    assert.deepEqual(st.offBranch, [".github/workflows/gone.yml"]);
    assert.deepEqual(st.unread, [".github/workflows/bad.yml"]);
    assert.deepEqual(st.own, [".github/workflows/ci.yml"]);
    assert.deepEqual(st.relies, []);
  } finally {
    await gh.close();
  }
});

test("doctor's last line names --apply default-token when the default workflow token FAILs, since setup's all leaves it out", () => {
  const fail = (name) => ({ name, status: "FAIL" });
  assert.match(doctorFooter([fail("default workflow token")], REPO), /--yes to apply the GitHub fixes; the default workflow token needs its own step, --apply default-token/);
  assert.doesNotMatch(doctorFooter([fail("merge queue")], REPO), /default-token/);
  assert.equal(doctorFooter([{ name: "x", status: "PASS" }], REPO), "\nready\n");
});
