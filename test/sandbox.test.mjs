// Real command sandbox behavior, including read-only Git in linked worktrees.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runSandboxed } from "../dist/sandbox.js";
import { addWorktree, validationEnvironment } from "../dist/worktree.js";

test("validation reads Git with system aliases and a private sibling configuration, in a /tmp sized by its limit", async (t) => {
  const root = mkdtempSync("/tmp/factory-sandbox-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config.json");
  writeFileSync(config, '{"private":"configuration"}\n', { mode: 0o600 });
  const previous = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = config;
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = previous;
  });
  const checkout = join(root, "checkout");
  const home = join(root, "home");
  const temporary = join(root, "temporary");
  const credentials = join(root, "credentials");
  for (const dir of [checkout, home, temporary, credentials]) mkdirSync(dir);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  writeFileSync(join(checkout, "a.txt"), "test\n");
  writeFileSync(join(checkout, ".gitattributes"), "a.txt test=value\n");
  git("add", "a.txt", ".gitattributes");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const directory = join(root, "item.validation");
  await addWorktree(checkout, directory, git("rev-parse", "HEAD"));
  const run = (command) =>
    runSandboxed(command, {
      cwd: directory,
      home,
      temporary,
      env: {
        ...validationEnvironment(credentials),
        PATH: "/bin:/sbin:/usr/bin",
        FACTORY_TEST_CONFIG: config,
      },
      config: {
        required: true,
        network: "off",
        readOnlyPaths: [],
        environment: {},
        limits: {
          tmpMiB: 16,
          homeMiB: 16,
          checkoutMiB: 16,
          files: 1024,
          candidateMiB: 16,
          candidateFiles: 1024,
          processes: 4096,
        },
      },
      signal: AbortSignal.timeout(30_000),
      timeoutMs: 20_000,
    });
  const result = await run(
    'test ! -e "$FACTORY_TEST_CONFIG" && git check-attr test -- a.txt',
  );
  assert.equal(result.kind, "ran", JSON.stringify(result));
  assert.equal(result.sandboxed, true);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "a.txt: test: value");
  // The probe found this bubblewrap (0.9 or later) can size a tmpfs.
  const tmp = await run("stat -f -c '%b %S' /tmp");
  assert.equal(tmp.exitCode, 0, tmp.stderr);
  const [blocks, size] = tmp.stdout.trim().split(" ").map(Number);
  assert.equal(blocks * size, 16 * 1024 * 1024);
});

test("sandbox.network host lets validation reach a service on the host's loopback; off does not", async (t) => {
  const root = mkdtempSync("/tmp/factory-sandbox-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [checkout, home, temporary] = ["checkout", "home", "temporary"].map(
    (name) => join(root, name),
  );
  for (const dir of [checkout, home, temporary]) mkdirSync(dir);
  const server = createServer((socket) => socket.end("database\n"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const run = (network) =>
    runSandboxed(
      `node -e 'require("net").connect(${port}, "127.0.0.1").on("data", (d) => process.stdout.write(d)).on("error", () => process.exit(7))'`,
      {
        cwd: checkout,
        home,
        temporary,
        env: { PATH: `${dirname(process.execPath)}:/bin:/usr/bin` },
        config: {
          required: true,
          network,
          readOnlyPaths: [],
          environment: {},
          limits: {
            tmpMiB: 16,
            homeMiB: 64,
            checkoutMiB: 16,
            files: 1024,
            candidateMiB: 16,
            candidateFiles: 1024,
            processes: 4096,
          },
        },
        signal: AbortSignal.timeout(30_000),
        timeoutMs: 20_000,
      },
    );
  const host = await run("host");
  assert.equal(host.kind, "ran", JSON.stringify(host));
  assert.equal(host.exitCode, 0, host.stderr);
  assert.equal(host.stdout, "database\n");
  const off = await run("off");
  assert.equal(off.kind, "ran", JSON.stringify(off));
  assert.equal(off.exitCode, 7, off.stderr);
});
