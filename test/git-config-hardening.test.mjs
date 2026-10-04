// A worker, or a tool a worker or validation command runs, can write the
// checkout's shared repository configuration. No program configured there
// may run inside Factory's own git commands, which have the controller's
// environment and credentials. Each configured program here is a canary that
// records that it ran.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachedFault } from "../dist/fault.js";
import {
  git,
  gitAsync,
  pinnedGit,
  pinnedGitAsync,
  RepositoryProgramConfigured,
} from "../dist/process.js";

function run(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-git-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "notes.txt"), "base\n");
  run(checkout, "add", "notes.txt");
  run(
    checkout,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  );
  run(checkout, "remote", "add", "origin", origin);
  run(checkout, "push", "-q", "origin", "main");
  // The worker's tree is a linked worktree; its configuration is shared.
  const worktree = join(root, "worker");
  run(checkout, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  const marker = join(root, "ran");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const canary = (name, script = "exit 1") => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho ${name} >>'${marker}'\n${script}\n`, {
      mode: 0o755,
    });
    return path;
  };
  const ran = () =>
    existsSync(marker)
      ? readFileSync(marker, "utf8").trim().split("\n").sort()
      : [];
  const clear = () => rmSync(marker, { force: true });
  return { root, checkout, worktree, canary, ran, clear };
}

/** Restore the variables an operation changed, even when it fails. */
async function withEnvironment(values, operation) {
  const saved = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

/** An HTTP remote that asks for credentials on every request. */
async function authenticatingRemote(t) {
  const server = createServer((_, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="factory"' });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/target.git`;
}

const commitArgs = [
  "-c",
  "user.name=Factory",
  "-c",
  "user.email=factory@example.invalid",
  "commit",
  "-q",
];

test("programs in repository configuration never run inside Factory's git", async (t) => {
  const { root, checkout, worktree, canary, ran, clear } = fixture(t);
  const config = (...args) => run(worktree, "config", ...args);
  config("core.fsmonitor", canary("fsmonitor"));
  config("diff.external", canary("external-diff"));
  config("diff.canary.textconv", canary("textconv", "cat"));
  writeFileSync(join(worktree, ".gitattributes"), "*.txt diff=canary\n");
  config("commit.gpgSign", "true");
  config("gpg.program", canary("gpg"));
  config("credential.helper", canary("credential-helper"));
  config("core.askPass", canary("askpass"));
  config("core.sshCommand", canary("ssh-command"));
  config("protocol.ext.allow", "always");
  config(
    `url.ext::${canary("ext-transport")}.insteadOf`,
    "https://example.invalid/",
  );
  const remote = await authenticatingRemote(t);
  const operatorConfig = join(root, "operator-gitconfig");
  writeFileSync(
    operatorConfig,
    `[credential]\n\thelper = ${canary("operator-helper", "printf 'username=operator\\npassword=secret\\n'")}\n`,
  );

  // The vectors are live for plain git.
  spawnSync("git", ["-C", worktree, "status"]);
  writeFileSync(join(worktree, "notes.txt"), "changed\n");
  spawnSync("git", ["-C", worktree, "diff"]);
  assert.deepEqual([...new Set(ran())], ["external-diff", "fsmonitor"]);
  clear();

  await withEnvironment(
    { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: operatorConfig },
    async () => {
      await pinnedGitAsync(worktree, "status", "--porcelain");
      await gitAsync(worktree, "status", "--porcelain");
      pinnedGit(worktree, "status", "--porcelain");
      git(worktree, "diff");
      await gitAsync(worktree, "diff");
      await pinnedGitAsync(worktree, "add", "-A");
      await pinnedGitAsync(worktree, ...commitArgs, "-m", "pinned");
      await gitAsync(worktree, ...commitArgs, "--allow-empty", "-m", "ambient");
      await gitAsync(worktree, "show", "HEAD~1");
      await gitAsync(worktree, "log", "-p", "-2");
      await assert.rejects(
        gitAsync(worktree, "ls-remote", remote),
        /Authentication failed|could not read/,
      );
      await assert.rejects(
        gitAsync(worktree, "ls-remote", "ssh://127.0.0.1:1/target.git"),
        /ssh|connect/i,
      );
      await assert.rejects(
        gitAsync(worktree, "ls-remote", "https://example.invalid/target.git"),
        /transport 'ext' not allowed/,
      );
    },
  );
  // Only the operator's own credential helper ran.
  assert.deepEqual([...new Set(ran())], ["operator-helper"]);
  // Factory's commits are unsigned.
  assert.doesNotMatch(run(worktree, "cat-file", "commit", "HEAD"), /gpgsig/);
  assert.equal(existsSync(join(checkout, ".git", "FETCH_HEAD")), false);
});

test("without an operator helper, no credential helper or askpass runs", async (t) => {
  const { worktree, canary, ran } = fixture(t);
  run(worktree, "config", "credential.helper", canary("credential-helper"));
  run(worktree, "config", "core.askPass", canary("askpass"));
  const remote = await authenticatingRemote(t);
  await withEnvironment({ GIT_TERMINAL_PROMPT: "0" }, () =>
    assert.rejects(
      gitAsync(worktree, "ls-remote", remote),
      /could not read Username|terminal prompts disabled/,
    ),
  );
  assert.deepEqual(ran(), []);
});

test("a filter or merge driver in repository configuration stops Factory's git", async (t) => {
  const { worktree, canary, ran } = fixture(t);
  writeFileSync(
    join(worktree, ".gitattributes"),
    "*.txt filter=canary merge=canary\n",
  );
  writeFileSync(join(worktree, "notes.txt"), "changed\n");
  for (const [key, value] of [
    ["filter.canary.clean", canary("clean", "cat")],
    ["filter.lfs.process", canary("lfs-process")],
    ["merge.canary.driver", canary("merge-driver")],
    ["lfs.customtransfer.canary.path", canary("lfs-transfer")],
  ]) {
    run(worktree, "config", key, value);
    for (const attempt of [
      () => pinnedGitAsync(worktree, "add", "-A"),
      () => gitAsync(worktree, "status"),
      async () => pinnedGit(worktree, "status"),
    ])
      await assert.rejects(attempt(), (error) => {
        assert.ok(error instanceof RepositoryProgramConfigured, String(error));
        assert.equal(error.key, key);
        assert.equal(attachedFault(error)?.kind, "config");
        return true;
      });
    run(worktree, "config", "--unset", key);
  }
  assert.deepEqual(ran(), []);
  // Without the drivers, the same commands run.
  await pinnedGitAsync(worktree, "add", "-A");
});

test("Git LFS's own filter configuration is allowed", async (t) => {
  const { worktree } = fixture(t);
  writeFileSync(join(worktree, ".gitattributes"), "*.bin filter=lfs -text\n");
  run(worktree, "lfs", "install", "--local", "--skip-repo");
  writeFileSync(join(worktree, "model.bin"), "model bytes\n");
  await pinnedGitAsync(worktree, "add", "-A");
  assert.match(
    await pinnedGitAsync(worktree, "show", ":model.bin"),
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1/,
  );
});

test("inherited git -c configuration cannot override Factory's pins", async (t) => {
  const { worktree, canary, ran } = fixture(t);
  await withEnvironment(
    { GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${canary("fsmonitor")}'` },
    async () => {
      assert.equal(
        await gitAsync(worktree, "config", "--get", "core.fsmonitor"),
        "false",
      );
      await gitAsync(worktree, "status");
    },
  );
  assert.deepEqual(ran(), []);
});
