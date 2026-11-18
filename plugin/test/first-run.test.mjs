import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PREVIOUS_NAME, previousKeyDirProblem, repoFromRemote, tokenFile } from "../scripts/lib/local.mjs";
import { whichSync } from "../scripts/lib/proc.mjs";

// The `pendulum` command's first use (#457), as a newcomer meets it: the real front (plugin/bin/pendulum) in its own
// process, in a fresh clone under a fake home, with GitHub a local fake where a command reaches it.
const PLUGIN = join(import.meta.dirname, "..");
const PENDULUM = join(PLUGIN, "bin", "pendulum");
const REPO = "acme/widget";

/** A fresh home and a clone in it: with `origin` an SSH GitHub URL (no fetch can leave the machine: ssh is `false`), or none. */
function fixture({ origin = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "first-")));
  const home = join(root, "home");
  const clone = join(root, "clone");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(clone);
  spawnSync("git", ["init", "-q", clone]);
  if (origin) spawnSync("git", ["-C", clone, "remote", "add", "origin", `git@github.com:${REPO}.git`]);
  return { root, home, clone, env: { ...devEnv(), HOME: home, GIT_SSH_COMMAND: "false", GIT_TERMINAL_PROMPT: "0" } };
}

/**
 * This process's env as a developer's shell would have it: no GitHub Actions runner's variables (GITHUB_REPOSITORY,
 * GITHUB_ACTIONS and the rest, which doctor.mjs and setup.mjs take before the clone's origin), no CI marker and no
 * Pendulum setting, so the command behaves the same here and on a runner. A test sets what it needs.
 */
function devEnv() {
  const off = /^(GITHUB_|RUNNER_|ACTIONS_|PENDULUM_|INPUT_)|^CI$/;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !off.test(k)));
}

/** A folder with git alone in it, for PATH: every other tool local mode needs is missing. */
function gitOnly(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(realpathSync(whichSync("git")), join(bin, "git"));
  return bin;
}

/** The command, run to its end without blocking this process's event loop (a fake GitHub here answers it meanwhile). */
function pendulum(args, { cwd, env, input = null, path = null } = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [PENDULUM, ...args], { cwd, env: path ? { ...env, PATH: path } : env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.stdin.end(input ?? undefined);
    c.on("close", (status) => res({ status, stdout, stderr }));
  });
}

/** A fake GitHub REST API: the paths asked, and `answer(path)` → [status, body]. */
async function fakeGithub(answer = () => [404, { message: "Not Found" }]) {
  const asked = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    asked.push(path);
    const [status, body] = answer(path);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { asked, url, close: () => new Promise((r) => server.close(r)) };
}

test("#457: pendulum token set saves the token where local mode reads it, owner-only, and never prints it", async () => {
  const fx = fixture();
  const token = "github_pat_11FIRSTRUN0457secret";
  const r = await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input: `${token}\n` });
  assert.equal(r.status, 0, r.stderr);
  const file = tokenFile(REPO, fx.home);
  assert.equal(readFileSync(file, "utf8"), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(fx.home, ".config", "pendulum", "tokens", "acme")).mode & 0o777, 0o700);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "never printed");
  assert.ok(r.stdout.includes(file), "names the file");

  // A character no GitHub token has: refused, and the saved token stays.
  for (const input of ["github_pat_\u001b[2Jx"]) {
    const bad = await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input });
    assert.equal(bad.status, 1, JSON.stringify(input));
    assert.match(bad.stderr, /nothing saved/i);
    assert.equal(readFileSync(file, "utf8"), token);
  }
  // A --repo that would lead out of tokens/: refused, nothing written.
  for (const repo of ["../escape"]) {
    const bad = await pendulum(["token", "set", "--repo", repo], { cwd: fx.home, env: fx.env, input: "github_pat_x" });
    assert.equal(bad.status, 1, repo);
    assert.match(bad.stderr, /--repo must be OWNER\/NAME/);
  }
  assert.equal(existsSync(join(fx.home, ".config", "pendulum", "escape")), false);
});

test("#457: no token is saved through a symbolic link in ~/.config/pendulum, which the sandboxes hide by its path alone, nor read where one is behind it", async () => {
  const fx = fixture();
  const base = join(fx.home, ".config", "pendulum");
  mkdirSync(join(fx.home, ".config"));
  // Each level a link to a folder of its own, and where the token file lands behind it.
  const levels = [
    [base, () => base, ["tokens", "acme", "widget"]],
  ];
  for (const [at, parent, behind] of levels) {
    parent();
    const elsewhere = realpathSync(mkdtempSync(join(fx.root, "elsewhere-")));
    symlinkSync(elsewhere, at);
    const r = await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input: "github_pat_linked" });
    assert.equal(r.status, 1, at);
    assert.ok(r.stderr.includes(`${at} is a symbolic link`) && /Nothing saved/.test(r.stderr), r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    const path = gitOnly(mkdtempSync(join(fx.root, "p-")));
    // A token behind it is not read: serve stops with the link's line, the token never shown.
    mkdirSync(join(elsewhere, ...behind.slice(0, -1)), { recursive: true });
    writeFileSync(join(elsewhere, ...behind), "github_pat_planted");
    const s = await pendulum(["serve", "--once"], { cwd: fx.clone, env: fx.env, path });
    assert.equal(s.status, 1);
    assert.ok(s.stderr.includes(`${at} is a symbolic link`), s.stderr);
    assert.ok(!s.stderr.includes("github_pat_planted"));
    renameSync(at, `${at}.gone`);
  }
});

test("#457: repoFromRemote takes github.com alone as the host, never a name that ends in it", () => {
  for (const url of ["https://github.com/acme/widget.git", "git@github.com:acme/widget.git", "ssh://git@github.com/acme/widget", "https://x-access-token:t@github.com/acme/widget/"]) assert.equal(repoFromRemote(url), REPO, url);
  for (const url of ["https://evilgithub.com/acme/widget", "git@notgithub.com:acme/widget.git", "https://github.com.evil.io/acme/widget", "https://gitlab.com/acme/widget"]) assert.equal(repoFromRemote(url), null, url);
});

test("#465: serve refuses while the key folder under the previous name is in ~/.config, naming the mv; none once it is moved", async () => {
  const fx = fixture();
  const old = join(fx.home, ".config", PREVIOUS_NAME);
  const now = join(fx.home, ".config", "pendulum");
  assert.equal(previousKeyDirProblem(fx.home), null, "nothing there");
  mkdirSync(join(old, "tokens", "acme"), { recursive: true, mode: 0o700 });
  writeFileSync(join(old, "tokens", "acme", "widget"), "github_pat_left_behind", { mode: 0o600 });
  const why = previousKeyDirProblem(fx.home);
  assert.ok(why.includes(`mv ${old} ${now}`), why);
  const gh = await fakeGithub(() => [200, { total_count: 0, variables: [] }]);
  try {
    const env = { ...fx.env, PATH: gitOnly(fx.root), GITHUB_API_URL: gh.url, GITHUB_GRAPHQL_URL: `${gh.url}/graphql`, PENDULUM_LOCAL_TOKEN: "github_pat_x" };
    for (const args of [["serve", "--once"]]) {
      const r = await pendulum(args, { cwd: fx.clone, env });
      assert.equal(r.status, 1, args.join(" "));
      assert.ok(r.stderr.includes(`\n- ${why}`), `${args.join(" ")}:\n${r.stderr}`);
    }
    // A link under the old name counts too; moved away, nothing is refused.
    renameSync(old, now);
    symlinkSync(now, old);
    assert.ok(previousKeyDirProblem(fx.home));
    rmSync(old);
    assert.equal(previousKeyDirProblem(fx.home), null);
  } finally {
    await gh.close();
  }
});
