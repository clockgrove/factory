// A newcomer's first setup (#470): the first-run preset's settings in the rendered workflow, and the default-token step,
// which makes the repository's default GITHUB_TOKEN read-only on consent. setup.mjs runs as a person runs it, in its
// own process, against a fake GitHub, with a stub gh whose login is a dummy token.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflowTokenChecks } from "../scripts/doctor.mjs";
import { workflowSettings } from "../scripts/setup.mjs";

const SETUP = join(import.meta.dirname, "..", "scripts", "setup.mjs");
const REPO = { owner: "acme", name: "widgets", full: "acme/widgets" };

const WORKFLOWS = {
  ".github/workflows/ci.yml": "on: [pull_request, merge_group]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
  ".github/workflows/release.yml":
    "on:\n  push:\n    tags: ['v*']\njobs:\n  build:\n    runs-on: ubuntu-latest\n    permissions: { contents: read }\n    steps:\n      - run: npm pack\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create\n",
};

/** A GitHub with the repository's default workflow token (`perms`), its workflows, and every PUT of the default recorded. */
async function fakeGitHub(perms) {
  const state = { perms: { ...perms }, puts: [] };
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (p === "/repos/acme/widgets/actions/permissions/workflow") {
      if (req.method === "GET") return json(200, state.perms);
      if (req.method === "PUT") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          const b = JSON.parse(body);
          state.puts.push(b);
          Object.assign(state.perms, b);
          res.writeHead(204).end();
        });
        return;
      }
    }
    if (req.method === "GET" && p === "/repos/acme/widgets/actions/workflows") {
      return json(200, { total_count: 3, workflows: [...Object.keys(WORKFLOWS).map((path) => ({ path })), { path: "dynamic/github-code-scanning/codeql" }] });
    }
    const file = /^\/repos\/acme\/widgets\/contents\/(.+)$/.exec(p)?.[1];
    if (req.method === "GET" && file && WORKFLOWS[file]) return res.writeHead(200, { "content-type": "text/plain" }).end(WORKFLOWS[file]);
    return json(404, { message: "Not Found" });
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

/** doctor's default-token row against the fake GitHub. */
async function doctorRow(gh) {
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = gh.url;
  try {
    return (await workflowTokenChecks({ repo: REPO, token: "dummy" })).find((r) => r.name === "default workflow token");
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

test("--preset first-run renders max_usd 5, max_concurrent 1 and auto-merge off; a flag beside it wins; a re-render takes it over the file's values", async () => {
  const gh = await fakeGitHub({ default_workflow_permissions: "read" });
  try {
    const clone = mkdtempSync(join(tmpdir(), "first-setup-clone-"));
    const out = join(clone, "pendulum.yml");
    const preview = await setup(gh, ["--apply", "workflow", "--preset", "first-run"], clone);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /with the first-run preset \(max_usd 5, max_concurrent 1, auto_merge false; a flag beside it wins\)/);

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

test("the default-token step: its dry run names the workflows the change reaches and changes nothing; with --yes the default is read-only and doctor's row passes", async () => {
  const gh = await fakeGitHub({ default_workflow_permissions: "write", can_approve_pull_request_reviews: false });
  try {
    assert.equal((await doctorRow(gh)).status, "FAIL");
    assert.match((await doctorRow(gh)).fix, /--apply default-token/);

    // No consent: the preview reads the workflows, names who gets a read-only token and who is left alone, and writes nothing.
    const preview = await setup(gh, ["--apply", "default-token"]);
    assert.equal(preview.status, 0, preview.out);
    assert.match(preview.out, /default-token: set the repository's default workflow token \(now write\) to read-only/);
    assert.match(preview.out, /get a read-only token: \.github\/workflows\/release\.yml \(jobs publish\)/);
    assert.match(preview.out, /left alone \(they set their own permissions:\): \.github\/workflows\/ci\.yml/);
    assert.doesNotMatch(preview.out, /codeql/);
    assert.deepEqual(gh.state.puts, []);
    assert.equal((await doctorRow(gh)).status, "FAIL");

    // Consent: one PUT that sets read and keeps the approval setting as it was; doctor's row then passes.
    const r = await setup(gh, ["--apply", "default-token", "--yes"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(gh.state.puts, [{ default_workflow_permissions: "read", can_approve_pull_request_reviews: false }]);
    assert.match(r.out, /default-token: the default workflow token is read-only now \(it was write\); .*release\.yml \(jobs publish\)/);
    assert.equal((await doctorRow(gh)).status, "PASS");

    // A plain setup (every step `all` runs) never reads or changes the default token.
    const plain = await setup(gh, []);
    assert.equal(plain.status, 0, plain.out);
    assert.doesNotMatch(plain.out, /default-token/);

    // Already read-only: nothing is sent.
    const again = await setup(gh, ["--apply", "default-token", "--yes"]);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /already read-only; nothing changed/);
    assert.equal(gh.state.puts.length, 1);
  } finally {
    await gh.close();
  }
});
