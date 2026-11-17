// A newcomer's first setup (#470): the first-run preset's settings in the rendered workflow, the required checks setup
// infers when none are given, and the default-token step, which makes the repository's default GITHUB_TOKEN read-only
// on consent. setup.mjs runs as a person runs it, in its own process, against a fake GitHub, with a stub gh whose login
// is a dummy token.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctorFooter, workflowTokenChecks } from "../scripts/doctor.mjs";
import { asksWrite, defaultTokenJobs, defaultTokenState, workflowSettings } from "../scripts/setup.mjs";

const SETUP = join(import.meta.dirname, "..", "scripts", "setup.mjs");
const REPO = { owner: "acme", name: "widgets", full: "acme/widgets" };

const CI = "on: [pull_request, merge_group]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22]\n    steps:\n      - run: npm test\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n  shared:\n    uses: ./.github/workflows/checks.yml\n";
const RELEASE =
  "on:\n  push:\n    tags: ['v*']\njobs:\n  build:\n    runs-on: ubuntu-latest\n    permissions: { contents: read }\n    steps:\n      - run: npm pack\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create\n  deploy:\n    uses: ./.github/workflows/deploy.yml\n";
const LINT = "on:\n  pull_request:\n    paths: ['src/**']\npermissions: read-all\njobs:\n  eslint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx eslint .\n";
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

test("--preset first-run renders max_usd 5, max_concurrent 1 and auto-merge off; a flag beside it wins; a re-render takes it over the file's values", async () => {
  const gh = await fakeGitHub({ perms: { default_workflow_permissions: "read" } });
  try {
    const clone = mkdtempSync(join(tmpdir(), "first-setup-clone-"));
    const out = join(clone, "pendulum.yml");
    const preview = await setup(gh, ["--apply", "workflow", "--preset", "first-run"], clone);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /with the first-run preset \(max_usd 5, max_concurrent 1, auto_merge false; a flag beside it wins\)/);
    assert.doesNotMatch(preview.out, /WARNING/, "no repository variable sets a cap");

    const r = await setup(gh, ["--apply", "workflow", "--preset", "first-run", "--out", out, "--yes"], clone);
    assert.equal(r.status, 0, r.out);
    const env = workflowSettings(readFileSync(out, "utf8")).env;
    assert.deepEqual([env.PENDULUM_MAX_USD, env.PENDULUM_MAX_CONCURRENT, env.PENDULUM_AUTO_MERGE], ["5", "1", "false"]);
    assert.equal(env.PENDULUM_DAILY_USD, "100", "the other settings keep their defaults");

    // A flag beside the preset wins over it.
    const own = await setup(gh, ["--apply", "workflow", "--preset", "first-run", "--max-usd", "8", "--out", join(clone, "own.yml"), "--yes"], clone);
    assert.equal(own.status, 0, own.out);
    assert.equal(workflowSettings(readFileSync(join(clone, "own.yml"), "utf8")).env.PENDULUM_MAX_USD, "8");

    // Over a file with the defaults, the preset's values replace the file's, and the report names the preset.
    const full = join(clone, "full.yml");
    assert.equal((await setup(gh, ["--apply", "workflow", "--out", full, "--yes"], clone)).status, 0);
    assert.equal(workflowSettings(readFileSync(full, "utf8")).env.PENDULUM_MAX_USD, "25");
    const again = await setup(gh, ["--apply", "workflow", "--preset", "first-run", "--out", full, "--yes"], clone);
    assert.equal(again.status, 0, again.out);
    const after = workflowSettings(readFileSync(full, "utf8")).env;
    assert.deepEqual([after.PENDULUM_MAX_USD, after.PENDULUM_MAX_CONCURRENT, after.PENDULUM_AUTO_MERGE], ["5", "1", "false"]);
    assert.match(again.out, /PENDULUM_MAX_USD "25" -> "5" \(--preset first-run\)/);

    const bad = await setup(gh, ["--apply", "workflow", "--preset", "cheap", "--out", join(clone, "bad.yml"), "--yes"], clone);
    assert.equal(bad.status, 1);
    assert.match(bad.out, /--preset cheap: no such preset \(have: first-run\)/);
  } finally {
    await gh.close();
  }
});

test("--preset first-run warns when a repository variable sets a cap over it", async () => {
  const gh = await fakeGitHub({ perms: { default_workflow_permissions: "read" }, variables: { PENDULUM_MAX_USD: "40" } });
  try {
    const clone = mkdtempSync(join(tmpdir(), "first-setup-clone-"));
    for (const args of [[], ["--out", join(clone, "p.yml"), "--yes"]]) {
      const r = await setup(gh, ["--apply", "workflow", "--preset", "first-run", ...args], clone);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /WARNING: the repository variable PENDULUM_MAX_USD \(40\) sets this over the workflow file, so the first-run preset's value does not apply while it stands/);
    }
  } finally {
    await gh.close();
  }
});

test("--preset first-run warns of an organization variable shared with the repository, or says it could not read them", async () => {
  const gh = await fakeGitHub({ perms: { default_workflow_permissions: "read" }, orgVariables: [{ name: "PENDULUM_MAX_CONCURRENT", value: "4" }, { name: "OTHER", value: "x" }] });
  try {
    const r = await setup(gh, ["--apply", "workflow", "--preset", "first-run"]);
    assert.match(r.out, /WARNING: the organization variable PENDULUM_MAX_CONCURRENT \(4\), shared with this repository, sets this over the workflow file/);
  } finally {
    await gh.close();
  }
  const denied = await fakeGitHub({ perms: { default_workflow_permissions: "read" }, orgVariables: "denied" });
  try {
    const r = await setup(denied, ["--apply", "workflow", "--preset", "first-run"]);
    assert.match(r.out, /could not read the organization variables shared with it \(HTTP 403\): check no PENDULUM_MAX_USD or PENDULUM_MAX_CONCURRENT variable sets these over the preset/);
    assert.doesNotMatch(r.out, /WARNING/);
  } finally {
    await denied.close();
  }
});

test("required checks: only the branch's own or --ci-checks are applied; the preview lists candidates with their marks; --ci-checks= clears them; nothing inferred reaches the workflow file", async () => {
  // The latest pull request's head ran CI (a passed matrix leg, a failed and a skipped job), a paths-filtered lint
  // workflow with no merge_group trigger, and Pendulum's own workflow.
  const runs = [
    { id: 11, name: "CI", path: ".github/workflows/ci.yml", head_sha: "abc1234def", pull_requests: [{ number: 7 }] },
    { id: 13, name: "Lint", path: ".github/workflows/lint.yml", head_sha: "abc1234def", pull_requests: [{ number: 7 }] },
    { id: 12, name: "Pendulum", path: ".github/workflows/pendulum.yml", head_sha: "abc1234def", pull_requests: [{ number: 7 }] },
    { id: 10, name: "CI", path: ".github/workflows/ci.yml", head_sha: "0ld", pull_requests: [{ number: 6 }] },
  ];
  const jobs = { 11: [{ name: "test (22)", conclusion: "success" }, { name: "Lint", conclusion: "failure" }, { name: "docs", conclusion: "skipped" }], 13: [{ name: "eslint", conclusion: "success" }], 12: [{ name: "dispatch", conclusion: "success" }], 10: [{ name: "old", conclusion: "success" }] };
  const files = { ".github/workflows/ci.yml": CI, ".github/workflows/lint.yml": LINT };
  const gh = await fakeGitHub({ runs, jobs, files, ownerType: "Organization" });
  try {
    const preview = await setup(gh, ["--apply", "protection"]);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /required checks none; candidates, from the checks that passed on pull request #7, none applied until you name them: "test \(22\)" \(CI\), "eslint" \(Lint; its workflow has no merge_group trigger, so it never reports in the merge queue .*; its workflow has a paths filter on pull_request, so a pull request outside those paths never gets it and cannot merge\); to require some, run this step again with --ci-checks/);
    assert.doesNotMatch(preview.out, /"Lint"|"docs"|"dispatch"|"old"/, "failed, skipped, Pendulum's and older runs' jobs are no candidates");
    const r = await setup(gh, ["--apply", "protection", "--yes"]);
    assert.equal(r.status, 0, r.out);
    const rule = (i) => gh.state.posted[i].rules.find((x) => x.type === "required_status_checks")?.parameters.required_status_checks.map((c) => c.context);
    assert.equal(rule(0), undefined, "a candidate is never applied on its own");
    assert.match(r.out, /candidates, from the checks that passed on pull request #7/);

    // The person names what they accept.
    const own = await setup(gh, ["--apply", "protection", "--ci-checks", "test (22)", "--yes"]);
    assert.equal(own.status, 0, own.out);
    assert.deepEqual(rule(1), ["test (22)"]);

    // --ci-checks= clears them and reads no candidates; a re-render with it empties the file's PENDULUM_CI_CHECKS.
    const clone = mkdtempSync(join(tmpdir(), "first-setup-clone-"));
    const out = join(clone, "p.yml");
    assert.equal((await setup(gh, ["--apply", "workflow", "--ci-checks", "quality", "--out", out, "--yes"], clone)).status, 0);
    assert.equal(workflowSettings(readFileSync(out, "utf8")).env.PENDULUM_CI_CHECKS, "quality");
    const at = gh.state.requests.length;
    const cleared = await setup(gh, ["--apply", "protection,workflow", "--ci-checks=", "--out", out, "--yes"], clone);
    assert.equal(cleared.status, 0, cleared.out);
    assert.equal(rule(2), undefined);
    assert.equal(workflowSettings(readFileSync(out, "utf8")).env.PENDULUM_CI_CHECKS, "");
    assert.ok(!gh.state.requests.slice(at).some((q) => q.includes("/actions/runs")), "no candidates read");
    assert.match(cleared.out, /--ci-checks= clears them/);

    // A first render never writes inferred names: PENDULUM_CI_CHECKS stays empty, so the runtime reads the live ruleset.
    const first = join(clone, "first.yml");
    const w = await setup(gh, ["--apply", "workflow", "--out", first, "--yes"], clone);
    assert.equal(w.status, 0, w.out);
    assert.equal(workflowSettings(readFileSync(first, "utf8")).env.PENDULUM_CI_CHECKS, "");
  } finally {
    await gh.close();
  }

  // No pull request ran yet: the job names of the workflows on pull_request are the candidates, less those GitHub names
  // only when they run; a user's repository has no merge queue, so no merge_group mark.
  const fresh = await fakeGitHub();
  try {
    const preview = await setup(fresh, ["--apply", "protection"]);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /candidates, from the job names of the workflows on pull_request \(no pull request has passed them yet\), none applied until you name them: "Lint" \(ci\.yml\); their check names known only once they run: test \(ci\.yml\), shared \(ci\.yml\)/);
  } finally {
    await fresh.close();
  }

  // The branch already requires checks: those are exact, and kept.
  const required = await fakeGitHub({ rulesets: [{ id: 5, name: "main rules", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }] }] });
  try {
    const r = await setup(required, ["--apply", "protection", "--yes"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(required.state.posted[0].rules.find((x) => x.type === "required_status_checks").parameters.required_status_checks.map((c) => c.context), ["build"]);
    assert.match(r.out, /checks from the default branch's required checks, kept/);
  } finally {
    await required.close();
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
