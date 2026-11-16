import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tokenFile } from "../scripts/lib/local.mjs";
import { whichSync } from "../scripts/lib/proc.mjs";

// The `factory` command's first use (#457), as a newcomer meets it: the real front (plugin/bin/factory) in its own
// process, in a fresh clone under a fake home, with GitHub a local fake where a command reaches it.
const PLUGIN = join(import.meta.dirname, "..");
const FACTORY = join(PLUGIN, "bin", "factory");
const VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;
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
  return { root, home, clone, env: { ...process.env, HOME: home, GIT_SSH_COMMAND: "false", GIT_TERMINAL_PROMPT: "0" } };
}

/** A folder with git alone in it, for PATH: every other tool local mode needs is missing. */
function gitOnly(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(realpathSync(whichSync("git")), join(bin, "git"));
  return bin;
}

/** The command, run to its end without blocking this process's event loop (a fake GitHub here answers it meanwhile). */
function factory(args, { cwd, env, input = null, path = null } = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [FACTORY, ...args], { cwd, env: path ? { ...env, PATH: path } : env, stdio: ["pipe", "pipe", "pipe"] });
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

test("#457: --version prints this release; --help lists doctor, token set, --version and serve's --verbose", async () => {
  const fx = fixture();
  const v = await factory(["--version"], fx);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `factory ${VERSION}\n`);
  const h = await factory(["--help"], fx);
  assert.equal(h.status, 0, h.stderr);
  const lines = h.stdout.split("\n").map((l) => l.trim());
  assert.ok(lines.some((l) => l.startsWith("factory doctor ")), h.stdout);
  assert.ok(lines.includes("factory token set [--repo OWNER/NAME] [--checkout CLONE]"), h.stdout);
  assert.ok(lines.includes("factory --version"), h.stdout);
  assert.ok(lines.some((l) => l.startsWith("factory serve ") && l.includes("[--verbose]")), h.stdout);
});

test("#457: a clone with no origin, or no clone, is one plain line naming the fix, never git's failure, on every command that infers the repository", async () => {
  const fx = fixture({ origin: false });
  for (const args of [["serve", "--once"], ["run", "5"], ["doctor"], ["token", "set"], ["wait", "--timeout", "1"], ["issue", "5"]]) {
    const r = await factory(args, { ...fx, cwd: fx.clone, input: "github_pat_x\n" });
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
    const said = r.stderr.trim().split("\n");
    assert.equal(said.length, 1, `${args.join(" ")}: one line\n${r.stderr}`);
    assert.ok(said[0].includes("has no remote named origin") && said[0].includes("git remote add origin") && said[0].includes("--repo OWNER/NAME"), `${args.join(" ")}: ${said[0]}`);
    assert.ok(!r.stderr.includes("Command failed"), args.join(" "));
  }
  assert.equal(existsSync(tokenFile(REPO, fx.home)), false, "nothing saved");
  // Outside any clone: the same, naming --checkout.
  const out = await factory(["serve", "--once"], { ...fx, cwd: fx.home });
  assert.equal(out.status, 1);
  assert.equal(out.stderr.trim().split("\n").length, 1, out.stderr);
  assert.match(out.stderr, /is not in a git clone .*; run factory in a clone of the repository, or pass --checkout CLONE/);
  // doctor.mjs itself, run directly as the docs and skills run it: the same line, not "--repo is required".
  const d = spawnSync(process.execPath, [join(PLUGIN, "scripts", "doctor.mjs"), "--local"], { cwd: fx.clone, env: fx.env, encoding: "utf8" });
  assert.ok(d.stderr.includes("has no remote named origin") && !d.stderr.includes("is required"), d.stderr);
});

test("#457: factory doctor (and doctor.mjs without --repo) checks the repository the clone's origin names", async () => {
  const fx = fixture();
  const gh = await fakeGithub();
  try {
    const env = { ...fx.env, GITHUB_API_URL: gh.url, GITHUB_GRAPHQL_URL: `${gh.url}/graphql` };
    const r = await factory(["doctor"], { cwd: fx.clone, env });
    assert.ok(gh.asked.includes(`/repos/${REPO}`), `${gh.asked.join(", ")}\n${r.stderr}`);
    assert.ok(!r.stderr.includes("is required"), r.stderr);
    gh.asked.length = 0;
    const d = await new Promise((res) => {
      const c = spawn(process.execPath, [join(PLUGIN, "scripts", "doctor.mjs"), "--local"], { cwd: join(fx.clone), env });
      c.on("close", res);
    });
    assert.notEqual(d, 64);
    assert.ok(gh.asked.includes(`/repos/${REPO}`), gh.asked.join(", "));
    // --repo still wins over the origin.
    gh.asked.length = 0;
    await factory(["doctor", "--repo", "other/thing"], { cwd: fx.clone, env });
    assert.ok(gh.asked.includes("/repos/other/thing") && !gh.asked.some((p) => p.includes(REPO)), gh.asked.join(", "));
  } finally {
    await gh.close();
  }
});

test("#457: factory token set saves the token where local mode reads it, owner-only, and never prints it", async () => {
  const fx = fixture();
  const token = "github_pat_11FIRSTRUN0457secret";
  const r = await factory(["token", "set"], { cwd: fx.clone, env: fx.env, input: `${token}\n` });
  assert.equal(r.status, 0, r.stderr);
  const file = tokenFile(REPO, fx.home);
  assert.equal(readFileSync(file, "utf8"), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(fx.home, ".config", "factory", "tokens", "acme")).mode & 0o777, 0o700);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "never printed");
  assert.ok(r.stdout.includes(file), "names the file");

  // Local mode reads it there: serve gets past the token, to the tools this machine lacks.
  const gh = await fakeGithub(() => [200, { total_count: 0, variables: [] }]);
  try {
    const after = await factory(["serve", "--once"], { cwd: fx.clone, env: { ...fx.env, GITHUB_API_URL: gh.url }, path: gitOnly(fx.root) });
    assert.ok(!after.stderr.includes("no token for") && after.stderr.includes("gh is not on PATH"), after.stderr);
    assert.ok(gh.asked.includes(`/repos/${REPO}/actions/variables`), "read the variables with it");
  } finally {
    await gh.close();
  }

  // --repo, outside any clone; a replaced token replaces the file whole, still owner-only.
  const other = await factory(["token", "set", "--repo", "acme/other"], { cwd: fx.home, env: fx.env, input: "github_pat_second" });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(readFileSync(tokenFile("acme/other", fx.home), "utf8"), "github_pat_second");
  const again = await factory(["token", "set"], { cwd: fx.clone, env: fx.env, input: "github_pat_third\n" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(file, "utf8"), "github_pat_third");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // Nothing given, or more than one word: refused, and the saved token stays.
  for (const input of ["", "\n", "github_pat_a github_pat_b\n"]) {
    const bad = await factory(["token", "set"], { cwd: fx.clone, env: fx.env, input });
    assert.equal(bad.status, 1, JSON.stringify(input));
    assert.match(bad.stderr, /nothing saved/i);
    assert.equal(readFileSync(file, "utf8"), "github_pat_third");
  }
  // A --repo that would lead out of tokens/: refused, nothing written.
  for (const repo of ["../escape", "acme/..", "acme/a/b"]) {
    const bad = await factory(["token", "set", "--repo", repo], { cwd: fx.home, env: fx.env, input: "github_pat_x" });
    assert.equal(bad.status, 1, repo);
    assert.match(bad.stderr, /--repo must be OWNER\/NAME/);
  }
  assert.equal(existsSync(join(fx.home, ".config", "factory", "escape")), false);
  const word = await factory(["token", "get"], { cwd: fx.clone, env: fx.env });
  assert.equal(word.status, 64);
});

const script = platform() === "linux" ? whichSync("script") : null;
test("#457: at a terminal, factory token set asks without echoing what is typed; Ctrl-C saves nothing", { skip: !script && "needs util-linux script for a terminal" }, async () => {
  const fx = fixture();
  // A terminal of its own (script's pty); the token is typed once the prompt shows, as a person types it.
  const typed = (keys) =>
    new Promise((res) => {
      const c = spawn(script, ["-q", "-e", "-c", `'${process.execPath}' '${FACTORY}' token set`, "/dev/null"], { cwd: fx.clone, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
      let screen = "";
      let sent = false;
      c.stdout.on("data", (d) => {
        screen += d;
        if (!sent && screen.includes(`token for ${REPO}`) && screen.includes("): ")) {
          sent = true;
          c.stdin.write(keys);
        }
      });
      c.on("close", (status) => res({ status, screen }));
    });
  const token = "github_pat_TYPED0457";
  const r = await typed(`${token}\r`);
  assert.equal(r.status, 0, r.screen);
  assert.ok(!r.screen.includes(token), `not echoed:\n${r.screen}`);
  assert.equal(readFileSync(tokenFile(REPO, fx.home), "utf8"), token);
  const c = await typed("github_pat_NOT\u0003");
  assert.equal(c.status, 1, c.screen);
  assert.ok(!c.screen.includes("github_pat_NOT"));
  assert.match(c.screen, /cancelled; nothing saved/);
  assert.equal(readFileSync(tokenFile(REPO, fx.home), "utf8"), token);
});

test("#457: serve with no token, or missing tools, says each in one line with its fix, and no settings listing comes before it", async () => {
  const fx = fixture();
  const gh = await fakeGithub(() => [200, { total_count: 0, variables: [] }]);
  // git alone on PATH (and the node that runs Factory, by its path).
  const bin = gitOnly(fx.root);
  try {
    const env = { ...fx.env, GITHUB_API_URL: gh.url };
    const none = await factory(["serve", "--once"], { cwd: fx.clone, env, path: bin });
    assert.equal(none.status, 1);
    const said = none.stderr.split("\n").filter((l) => l.startsWith("[factory] local:"));
    assert.equal(said.length, 1, none.stderr);
    assert.ok(said[0].includes(`no token for ${REPO}`) && said[0].includes("`factory token set`"), said[0]);
    assert.ok(!/FACTORY_GUESS_HOURS|Factory's defaults/.test(none.stdout + none.stderr), "no listing of the settings");

    const tools = await factory(["serve", "--once"], { cwd: fx.clone, env: { ...env, FACTORY_LOCAL_TOKEN: "github_pat_x" }, path: bin });
    assert.equal(tools.status, 1);
    const text = tools.stdout + tools.stderr;
    assert.match(text, /local mode cannot start:\n/);
    assert.match(text, /\n- gh is not on PATH; install the GitHub CLI \(https:\/\/cli\.github\.com\)\n/);
    assert.match(text, /\n- claude is not on PATH; install Claude Code \(npm i -g @anthropic-ai\/claude-code\) and log in/);
    assert.match(text, /\n- srt is not on PATH; .*\(npm i -g @anthropic-ai\/sandbox-runtime\)/);
    assert.ok(!/FACTORY_GUESS_HOURS|Factory's defaults|settings, each over/.test(text), `no listing of the settings before the error:\n${text}`);
    assert.ok(!text.includes("github_pat_x"));
  } finally {
    await gh.close();
  }
});
