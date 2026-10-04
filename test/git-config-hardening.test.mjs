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
import { bindOrigin, OriginBindingChanged } from "../dist/origin-binding.js";
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

test("a configuration value cannot forge another entry or scope", async (t) => {
  const { root, worktree, canary, ran } = fixture(t);
  // Read line by line, this value forged a global-scope helper entry.
  run(
    worktree,
    "config",
    "credential.helper",
    `x\nglobal\tcredential.helper ${canary("forged-helper")}`,
  );
  const remote = await authenticatingRemote(t);
  await withEnvironment({ GIT_TERMINAL_PROMPT: "0" }, () =>
    assert.rejects(gitAsync(worktree, "ls-remote", remote)),
  );
  run(worktree, "config", "--unset", "credential.helper");
  // Git LFS's filter command followed by another line is not Git LFS's.
  writeFileSync(join(worktree, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(join(worktree, "model.bin"), "model\n");
  run(
    worktree,
    "config",
    "filter.lfs.clean",
    `git-lfs clean -- %f\n${canary("forged-filter")}`,
  );
  await assert.rejects(pinnedGitAsync(worktree, "add", "-A"), (error) => {
    assert.ok(error instanceof RepositoryProgramConfigured, String(error));
    assert.equal(error.key, "filter.lfs.clean");
    return true;
  });
  assert.deepEqual(ran(), []);
  assert.equal(existsSync(join(root, "ran")), false);
});

test("remote commands refuse repository transport settings", async (t) => {
  const { worktree, ran } = fixture(t);
  // A proxy that would see the request (and, with TLS verification off,
  // the credentials Git sends).
  let proxied = 0;
  const proxy = createServer((_, response) => {
    proxied++;
    response.writeHead(502);
    response.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const remote = await authenticatingRemote(t);
  for (const settings of [
    [
      ["http.proxy", proxyUrl],
      ["http.sslVerify", "false"],
    ],
    // URL-specific keys outrank any generic pin, so they are refused too.
    [[`http.${remote}/info/refs.proxy`, proxyUrl]],
    [["remote.origin.proxy", proxyUrl]],
    [["http.curloptResolve", "github.com:443:127.0.0.1"]],
    [["http.extraHeader", "X-Leak: yes"]],
  ]) {
    for (const [key, value] of settings) run(worktree, "config", key, value);
    for (const attempt of [
      () => gitAsync(worktree, "ls-remote", remote),
      () => gitAsync(worktree, "fetch", "origin", "main"),
      () => gitAsync(worktree, "lfs", "push", "origin", "HEAD"),
    ])
      await assert.rejects(attempt(), (error) => {
        assert.ok(error instanceof RepositoryProgramConfigured, String(error));
        assert.equal(attachedFault(error)?.kind, "config");
        return true;
      });
    for (const [key] of settings) run(worktree, "config", "--unset", key);
  }
  assert.equal(proxied, 0);
  // Transfer tuning is allowed, and local commands ignore transport keys.
  run(worktree, "config", "http.postBuffer", "524288000");
  await gitAsync(worktree, "fetch", "origin", "main");
  run(worktree, "config", "http.proxy", proxyUrl);
  await gitAsync(worktree, "status");
  assert.deepEqual(ran(), []);
});

/** A checkout whose origin is bound to a GitHub repository. */
function boundFixture(t) {
  const fixed = fixture(t);
  run(
    fixed.checkout,
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/target.git",
  );
  bindOrigin(fixed.checkout, "example/target");
  return fixed;
}

test("remote commands verify origin's binding every time", async (t) => {
  const { root, checkout, worktree } = boundFixture(t);
  const verified = () => gitAsync(worktree, "ls-remote", "--get-url", "origin");
  assert.equal(await verified(), "https://github.com/example/target.git");
  for (const [key, value] of [
    ["remote.origin.url", "https://github.com/attacker/target.git"],
    ["remote.origin.pushurl", "https://github.com/attacker/target.git"],
    [
      "url.https://github.com/attacker/target.git.insteadOf",
      "https://github.com/example/target.git",
    ],
    [
      "url.https://github.com/attacker/target.git.pushInsteadOf",
      "https://github.com/example/target.git",
    ],
    ["lfs.url", "https://lfs.attacker.invalid/target"],
  ]) {
    const original = spawnSync(
      "git",
      ["-C", checkout, "config", "--get", key],
      {
        encoding: "utf8",
      },
    ).stdout.trim();
    run(worktree, "config", key, value);
    for (const attempt of [
      verified,
      () => gitAsync(worktree, "push", "origin", "HEAD:refs/heads/x"),
      () => gitAsync(worktree, "lfs", "push", "origin", "HEAD"),
    ])
      await assert.rejects(attempt(), (error) => {
        assert.ok(error instanceof OriginBindingChanged, `${key}: ${error}`);
        assert.equal(attachedFault(error)?.kind, "config");
        return true;
      });
    if (original) run(worktree, "config", key, original);
    else run(worktree, "config", "--unset", key);
  }
  assert.equal(await verified(), "https://github.com/example/target.git");
  // A clone must name a bound repository.
  await assert.rejects(
    withEnvironment({ FACTORY_TEST_LOCAL_ORIGINS: "0" }, () =>
      gitAsync(
        root,
        "clone",
        "https://github.com/attacker/target.git",
        join(root, "clone"),
      ),
    ),
    OriginBindingChanged,
  );
});

test("without the test override, origin must be bound and file transport is refused", async (t) => {
  const { root, checkout } = fixture(t);
  await withEnvironment({ FACTORY_TEST_LOCAL_ORIGINS: "0" }, async () => {
    // A local bare origin is not a bound GitHub repository.
    await assert.rejects(
      gitAsync(checkout, "fetch", "origin", "main"),
      OriginBindingChanged,
    );
    // An operator rewrite of a bound URL to a local path reaches the
    // transport, which refuses file://.
    const bound = boundFixture(t);
    const operator = join(root, "operator-gitconfig");
    writeFileSync(
      operator,
      `[url "${join(root, "origin.git")}"]\n\tinsteadOf = https://github.com/example/target.git\n`,
    );
    await withEnvironment({ GIT_CONFIG_GLOBAL: operator }, () =>
      assert.rejects(
        gitAsync(
          bound.root,
          "clone",
          "https://github.com/example/target.git",
          join(bound.root, "clone"),
        ),
        /transport 'file' not allowed/,
      ),
    );
  });
});
