import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOKEN_LINK_FIX, repoFromRemote, tokenFile } from "../scripts/lib/local.mjs";
import { whichSync } from "../scripts/lib/proc.mjs";

// The `pendulum` command's first use (#457), as a newcomer meets it: the real front (plugin/bin/pendulum) in its own
// process, in a fresh clone under a fake home, with GitHub a local fake where a command reaches it.
const PLUGIN = join(import.meta.dirname, "..");
const PENDULUM = join(PLUGIN, "bin", "pendulum");
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

test("#457: --version prints this release; --help lists doctor, token set, --version and serve's --verbose", async () => {
  const fx = fixture();
  const v = await pendulum(["--version"], fx);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `pendulum ${VERSION}\n`);
  const h = await pendulum(["--help"], fx);
  assert.equal(h.status, 0, h.stderr);
  const lines = h.stdout.split("\n").map((l) => l.trim());
  assert.ok(lines.some((l) => l.startsWith("pendulum doctor ")), h.stdout);
  assert.ok(lines.includes("pendulum token set [--repo OWNER/NAME] [--checkout CLONE]"), h.stdout);
  assert.ok(lines.includes("pendulum --version"), h.stdout);
  assert.ok(lines.some((l) => l.startsWith("pendulum serve ") && l.includes("[--verbose]")), h.stdout);
});

test("#457: a clone with no origin, or no clone, is one plain line naming the fix, never git's failure, on every command that infers the repository", async () => {
  const fx = fixture({ origin: false });
  for (const args of [["serve", "--once"], ["run", "5"], ["doctor"], ["token", "set"], ["wait", "--timeout", "1"], ["issue", "5"]]) {
    const r = await pendulum(args, { ...fx, cwd: fx.clone, input: "github_pat_x\n" });
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
    const said = r.stderr.trim().split("\n");
    assert.equal(said.length, 1, `${args.join(" ")}: one line\n${r.stderr}`);
    assert.ok(said[0].includes("has no remote named origin") && said[0].includes("git remote add origin") && said[0].includes("--repo OWNER/NAME"), `${args.join(" ")}: ${said[0]}`);
    assert.ok(!r.stderr.includes("Command failed"), args.join(" "));
  }
  assert.equal(existsSync(tokenFile(REPO, fx.home)), false, "nothing saved");
  // Outside any clone: the same, naming --checkout.
  const out = await pendulum(["serve", "--once"], { ...fx, cwd: fx.home });
  assert.equal(out.status, 1);
  assert.equal(out.stderr.trim().split("\n").length, 1, out.stderr);
  assert.match(out.stderr, /is not in a git clone .*; run this in a clone of the repository, or pass --checkout CLONE\n$/);
  // A command that takes --repo in place of a clone names --repo.
  for (const args of [["token", "set"], ["doctor"], ["wait", "--timeout", "1"]]) {
    const r = await pendulum(args, { ...fx, cwd: fx.home, input: "github_pat_x\n" });
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, /is not in a git clone .*; run this in a clone of the repository, or pass --repo OWNER\/NAME\n$/, args.join(" "));
  }
  // doctor.mjs itself, run directly as the docs and skills run it: the same line, not "--repo is required".
  const d = spawnSync(process.execPath, [join(PLUGIN, "scripts", "doctor.mjs"), "--local"], { cwd: fx.clone, env: fx.env, encoding: "utf8" });
  assert.ok(d.stderr.includes("has no remote named origin") && !d.stderr.includes("is required"), d.stderr);
});

test("#457: pendulum doctor (and doctor.mjs without --repo) checks the repository the clone's origin names", async () => {
  const fx = fixture();
  const gh = await fakeGithub();
  try {
    // git alone on PATH: no harness CLI or gh of this machine runs under the fake home.
    const env = { ...fx.env, PATH: gitOnly(fx.root), GITHUB_API_URL: gh.url, GITHUB_GRAPHQL_URL: `${gh.url}/graphql` };
    const r = await pendulum(["doctor"], { cwd: fx.clone, env });
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
    await pendulum(["doctor", "--repo", "other/thing"], { cwd: fx.clone, env });
    assert.ok(gh.asked.includes("/repos/other/thing") && !gh.asked.some((p) => p.includes(REPO)), gh.asked.join(", "));
  } finally {
    await gh.close();
  }
});

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

  // Local mode reads it there: serve gets past the token, to the tools this machine lacks.
  const gh = await fakeGithub(() => [200, { total_count: 0, variables: [] }]);
  try {
    const after = await pendulum(["serve", "--once"], { cwd: fx.clone, env: { ...fx.env, GITHUB_API_URL: gh.url }, path: gitOnly(fx.root) });
    assert.ok(!after.stderr.includes("no token for") && after.stderr.includes("gh is not on PATH"), after.stderr);
    assert.ok(gh.asked.includes(`/repos/${REPO}/actions/variables`), "read the variables with it");
  } finally {
    await gh.close();
  }

  // --repo, outside any clone; a replaced token replaces the file whole, still owner-only.
  const other = await pendulum(["token", "set", "--repo", "acme/other"], { cwd: fx.home, env: fx.env, input: "github_pat_second" });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(readFileSync(tokenFile("acme/other", fx.home), "utf8"), "github_pat_second");
  const again = await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input: "github_pat_third\n" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(file, "utf8"), "github_pat_third");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // Nothing given, more than one word, or a character no GitHub token has: refused, and the saved token stays.
  for (const input of ["", "\n", "github_pat_a github_pat_b\n", "github_pat_\u0001x\n", "github_pat_\u001b[2Jx", "ghp-x\n"]) {
    const bad = await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input });
    assert.equal(bad.status, 1, JSON.stringify(input));
    assert.match(bad.stderr, /nothing saved/i);
    assert.equal(readFileSync(file, "utf8"), "github_pat_third");
  }
  // A --repo that would lead out of tokens/: refused, nothing written.
  for (const repo of ["../escape", "acme/..", "acme/a/b"]) {
    const bad = await pendulum(["token", "set", "--repo", repo], { cwd: fx.home, env: fx.env, input: "github_pat_x" });
    assert.equal(bad.status, 1, repo);
    assert.match(bad.stderr, /--repo must be OWNER\/NAME/);
  }
  assert.equal(existsSync(join(fx.home, ".config", "pendulum", "escape")), false);
  const word = await pendulum(["token", "get"], { cwd: fx.clone, env: fx.env });
  assert.equal(word.status, 64);

  // An owner's folder made by hand with group or world bits: owner-only again after a save.
  chmodSync(join(fx.home, ".config", "pendulum", "tokens", "acme"), 0o755);
  assert.equal((await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input: "github_pat_fourth" })).status, 0);
  assert.equal(statSync(join(fx.home, ".config", "pendulum", "tokens", "acme")).mode & 0o777, 0o700);
  assert.equal(statSync(join(fx.home, ".config", "pendulum", "tokens")).mode & 0o777, 0o700);
});

test("#457: no token is saved through a symbolic link in ~/.config/pendulum, which the sandboxes hide by its path alone, nor read where one is behind it", async () => {
  const fx = fixture();
  const base = join(fx.home, ".config", "pendulum");
  mkdirSync(join(fx.home, ".config"));
  // Each level a link to a folder of its own, and where the token file lands behind it.
  const levels = [
    [base, () => base, ["tokens", "acme", "widget"]],
    [join(base, "tokens"), () => mkdirSync(base, { recursive: true }), ["acme", "widget"]],
    [join(base, "tokens", "acme"), () => mkdirSync(join(base, "tokens"), { recursive: true }), ["widget"]],
  ];
  for (const [at, parent, behind] of levels) {
    parent();
    const elsewhere = realpathSync(mkdtempSync(join(fx.root, "elsewhere-")));
    symlinkSync(elsewhere, at);
    const r = await pendulum(["token", "set"], { cwd: fx.clone, env: fx.env, input: "github_pat_linked" });
    assert.equal(r.status, 1, at);
    assert.ok(r.stderr.includes(`${at} is a symbolic link`) && /Nothing saved/.test(r.stderr), r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    // No token behind the link: nothing to refuse, it reads as no token.
    const path = gitOnly(mkdtempSync(join(fx.root, "p-")));
    const empty = await pendulum(["serve", "--once"], { cwd: fx.clone, env: fx.env, path });
    assert.ok(empty.stderr.includes(`- no token for ${REPO}:`) && !empty.stderr.includes("symbolic link"), empty.stderr);
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

test("#457: a linked ~/.config/pendulum with no token behind it leaves the session commands their gh login; doctor makes a token behind one a FAIL row", async () => {
  const fx = fixture();
  const elsewhere = realpathSync(mkdtempSync(join(fx.root, "dotfiles-")));
  mkdirSync(join(fx.home, ".config"));
  symlinkSync(elsewhere, join(fx.home, ".config", "pendulum"));
  const auth = [];
  // GitHub as far as doctor's rows need it: the repository, and nothing else found.
  const gh = await fakeGithub((path) => (path === `/repos/${REPO}` ? [200, { id: 1, full_name: REPO, default_branch: "main", private: false, permissions: { admin: true, push: true } }] : path.endsWith("/rulesets") ? [200, []] : [404, { message: "Not Found" }]));
  const seen = createServer((req, res) => {
    auth.push(req.headers.authorization || "");
    res.writeHead(404, { "content-type": "application/json" }).end('{"message":"Not Found"}');
  });
  await new Promise((r) => seen.listen(0, "127.0.0.1", r));
  // git, and a gh whose login is a stand-in token.
  const bin = gitOnly(fx.root);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\n[ \"$1 $2\" = \"auth token\" ] && echo gho_standin\n", { mode: 0o755 });
  try {
    const r = await pendulum(["issue", "5"], { cwd: fx.clone, env: { ...fx.env, PATH: bin, GITHUB_API_URL: `http://127.0.0.1:${seen.address().port}` } });
    assert.ok(!r.stderr.includes("symbolic link"), r.stderr);
    assert.ok(auth.length && auth.every((a) => a.includes("gho_standin")), `${auth.join(", ")}\n${r.stderr}`);

    // A token behind the link: doctor goes on, with a FAIL row naming the link and the fix.
    mkdirSync(join(elsewhere, "tokens", "acme"), { recursive: true });
    writeFileSync(join(elsewhere, "tokens", "acme", "widget"), "github_pat_planted");
    const d = await pendulum(["doctor", "--json"], { cwd: fx.clone, env: { ...fx.env, PATH: bin, GITHUB_API_URL: gh.url, GITHUB_GRAPHQL_URL: `${gh.url}/graphql` } });
    assert.ok(!d.stderr.includes("doctor failed: "), d.stderr);
    const report = JSON.parse(d.stdout.slice(d.stdout.indexOf("{\n")));
    const row = report.checks.find((c) => c.name === "local token");
    assert.deepEqual([row?.status, row?.fix], ["FAIL", TOKEN_LINK_FIX], JSON.stringify(row));
    assert.ok(row.detail.startsWith(`${join(fx.home, ".config", "pendulum")} is a symbolic link`), row.detail);
    assert.ok(report.checks.length > 5, "the other rows still print");
    assert.ok(!(d.stdout + d.stderr).includes("github_pat_planted"));
  } finally {
    await gh.close();
    await new Promise((r) => seen.close(r));
  }
});

test("#457: repoFromRemote takes github.com alone as the host, never a name that ends in it", () => {
  for (const url of ["https://github.com/acme/widget.git", "git@github.com:acme/widget.git", "ssh://git@github.com/acme/widget", "https://x-access-token:t@github.com/acme/widget/"]) assert.equal(repoFromRemote(url), REPO, url);
  for (const url of ["https://evilgithub.com/acme/widget", "git@notgithub.com:acme/widget.git", "https://github.com.evil.io/acme/widget", "https://gitlab.com/acme/widget"]) assert.equal(repoFromRemote(url), null, url);
});

const script = platform() === "linux" ? whichSync("script") : null;
test("#457: at a terminal, pendulum token set asks without echoing what is typed; Ctrl-C or Ctrl-Z saves nothing", { skip: !script && "needs util-linux script for a terminal" }, async () => {
  const fx = fixture();
  // A terminal of its own (script's pty); the token is typed once the prompt shows, as a person types it.
  const typed = (keys) =>
    new Promise((res) => {
      const c = spawn(script, ["-q", "-e", "-c", `'${process.execPath}' '${PENDULUM}' token set`, "/dev/null"], { cwd: fx.clone, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
      let screen = "";
      let sent = false;
      c.stdout.on("data", (d) => {
        screen += d;
        if (!sent && screen.includes(`token for ${REPO}`) && screen.includes("): ")) {
          sent = true;
          c.stdin.write(keys);
        }
      });
      // A command that stops instead of ending (a Ctrl-Z it does not take) fails here, not as a hung suite.
      const stuck = setTimeout(() => c.kill("SIGKILL"), 20_000);
      c.on("close", (status) => (clearTimeout(stuck), res({ status, screen })));
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
  // Ctrl-Z: no stop with the echo back on and the prompt still reading; the command ends, nothing saved.
  const z = await typed("github_pat_SUSPEND\u001a");
  assert.equal(z.status, 1, z.screen);
  assert.ok(!z.screen.includes("github_pat_SUSPEND"));
  assert.match(z.screen, /cancelled; nothing saved/);
  assert.equal(readFileSync(tokenFile(REPO, fx.home), "utf8"), token);
});

test("#457: serve with no token, or missing tools, says each in one line with its fix, and no settings listing comes before it", async () => {
  const fx = fixture();
  const gh = await fakeGithub(() => [200, { total_count: 0, variables: [] }]);
  // git alone on PATH (and the node that runs Pendulum, by its path).
  const bin = gitOnly(fx.root);
  try {
    const env = { ...fx.env, GITHUB_API_URL: gh.url };
    const none = await pendulum(["serve", "--once"], { cwd: fx.clone, env, path: bin });
    assert.equal(none.status, 1);
    // Every start problem at once, the token among them, each one line naming its fix.
    assert.match(none.stderr, /local mode cannot start:\n/);
    const token = none.stderr.split("\n").filter((l) => l.startsWith(`- no token for ${REPO}:`));
    assert.equal(token.length, 1, none.stderr);
    assert.ok(token[0].includes("`pendulum token set`"), token[0]);
    assert.match(none.stderr, /\n- gh is not on PATH; install the GitHub CLI/);
    assert.ok(!/PENDULUM_GUESS_HOURS|Pendulum's defaults|settings, each over/.test(none.stdout + none.stderr), "no listing of the settings");

    const tools = await pendulum(["serve", "--once"], { cwd: fx.clone, env: { ...env, PENDULUM_LOCAL_TOKEN: "github_pat_x" }, path: bin });
    assert.equal(tools.status, 1);
    const text = tools.stdout + tools.stderr;
    assert.match(text, /local mode cannot start:\n/);
    assert.match(text, /\n- gh is not on PATH; install the GitHub CLI \(https:\/\/cli\.github\.com\)\n/);
    assert.match(text, /\n- claude is not on PATH; install Claude Code \(npm i -g @anthropic-ai\/claude-code\) and log in/);
    assert.match(text, /\n- srt is not on PATH; .*\(npm i -g @anthropic-ai\/sandbox-runtime\)/);
    assert.ok(!/PENDULUM_GUESS_HOURS|Pendulum's defaults|settings, each over/.test(text), `no listing of the settings before the error:\n${text}`);
    assert.ok(!text.includes("github_pat_x"));
  } finally {
    await gh.close();
  }
});

test("#457: a running serve keeps its token while the file sits behind a link, says so once, and again when a link comes back after a clean read", async () => {
  const { Local } = await import("../scripts/local.mjs");
  const fx = fixture();
  const before = process.env.HOME;
  const said = [];
  const write = process.stdout.write;
  process.env.HOME = fx.home;
  process.stdout.write = (chunk, ...rest) => (said.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    const base = join(fx.home, ".config", "pendulum");
    const elsewhere = realpathSync(mkdtempSync(join(fx.root, "elsewhere-")));
    mkdirSync(join(elsewhere, "tokens", "acme"), { recursive: true });
    writeFileSync(join(elsewhere, "tokens", "acme", "widget"), "github_pat_behind");
    mkdirSync(join(fx.home, ".config"));
    const loop = Object.assign(Object.create(Local.prototype), { repoFull: REPO });
    const linked = () => said.filter((l) => l.includes("the local token is not read again") && l.includes(`${base} is a symbolic link`)).length;
    symlinkSync(elsewhere, base);
    assert.equal(loop.tokenNow(), "");
    assert.equal(loop.tokenNow(), "");
    assert.equal(linked(), 1, "said once");
    renameSync(base, `${base}.gone`);
    renameSync(join(`${base}.gone`, "tokens"), join(fx.root, "moved-tokens"));
    mkdirSync(join(base, "tokens", "acme"), { recursive: true });
    writeFileSync(join(base, "tokens", "acme", "widget"), "github_pat_real");
    assert.equal(loop.tokenNow(), "github_pat_real");
    rmSync(base, { recursive: true });
    symlinkSync(elsewhere, base);
    mkdirSync(join(elsewhere, "tokens", "acme"), { recursive: true });
    writeFileSync(join(elsewhere, "tokens", "acme", "widget"), "github_pat_behind");
    assert.equal(loop.tokenNow(), "");
    assert.equal(linked(), 2, "said again once the link is back");
    assert.ok(!said.join("").includes("github_pat_behind"));
  } finally {
    process.stdout.write = write;
    process.env.HOME = before;
  }
});
