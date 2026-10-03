import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  createReadStream,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  DaytonaSandboxProvider,
  SandboxExecutionDriver,
} from "../dist/index.js";
import { LocalContentStore } from "../dist/content/local.js";
import {
  FixtureSandboxProvider,
  writeSandboxInvoker,
} from "./support/sandbox-provider.mjs";

test("Daytona adapter runs the shared driver through real separate processes, collection and restart cleanup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "daytona-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"),
    remote = join(root, "published.git"),
    bin = join(root, "bin");
  mkdirSync(checkout);
  mkdirSync(bin);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(checkout, "keep.txt"), "base\n");
  writeFileSync(join(checkout, "old.txt"), "delete\n");
  git("add", ".");
  git("commit", "-qm", "base");
  execFileSync("git", ["clone", "--bare", checkout, remote], { stdio: "pipe" });
  const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2).map(x=>x==='https://github.com/example/public.git'?${JSON.stringify(remote)}:x);const r=spawnSync(${JSON.stringify(nativeGit)},args,{stdio:'inherit'});process.exit(r.status??1);`,
  );
  chmodSync(wrapper, 0o755);
  const infrastructure = new FixtureSandboxProvider("/tmp/factory");
  const sandboxes = new Map();
  const client = {
    async create(parameters) {
      const h = await infrastructure.create({
        attemptId: parameters.labels["factory-attempt"],
      });
      const commands = new Map();
      const sandbox = {
        id: h.identity,
        labels: parameters.labels,
        state: "started",
        fs: {
          async uploadFileStream(src, dst) {
            copyFileSync(src, dst);
          },
          async downloadFileStream(src) {
            return createReadStream(src);
          },
        },
        process: {
          async executeCommand(command) {
            try {
              return {
                exitCode: 0,
                result: execFileSync("/bin/bash", ["-c", command], {
                  encoding: "utf8",
                  cwd: h.workspace,
                  env: {
                    PATH: bin + ":" + process.env.PATH,
                    HOME: h.workspace,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                }),
              };
            } catch (error) {
              return { exitCode: 1, result: error.stderr.toString() };
            }
          },
          async createSession() {},
          async executeSessionCommand(session, { command }) {
            const p = await infrastructure.execute(h, {
              cwd: h.workspace,
              argv: ["/bin/bash", "-c", command],
            });
            commands.set(p.identity, { p, session });
            return { cmdId: p.identity };
          },
          async getSessionCommand(session, id) {
            assert.equal(commands.get(id).session, session);
            const observation = await infrastructure.observe(
              h,
              commands.get(id).p,
            );
            return {
              id,
              ...(observation.state === "running"
                ? {}
                : { exitCode: observation.state === "complete" ? 0 : 1 }),
            };
          },
        },
        async delete(timeout, wait) {
          assert.equal(wait, true);
          await infrastructure.destroy(h);
          sandbox.state = "destroyed";
        },
      };
      sandboxes.set(h.identity, sandbox);
      return sandbox;
    },
    async get(id) {
      return sandboxes.get(id);
    },
    async *list({ labels }) {
      for (const sandbox of sandboxes.values())
        if (
          sandbox.state !== "destroyed" &&
          sandbox.labels["factory-attempt"] === labels["factory-attempt"]
        )
          yield sandbox;
    },
  };
  const providerConfig = {
    snapshot: "installed-fixture",
    target: "test",
    apiKeyEnv: "DAYTONA_API_KEY",
    timeoutSeconds: 30,
    factoryRoot: resolve("."),
  };
  const provider = new DaytonaSandboxProvider(
    providerConfig,
    "controller-only-canary",
    client,
  );
  const argv = writeSandboxInvoker(
    root,
    pathToFileURL(resolve("dist/index.js")).href,
  );
  const options = {
    repository: "example/public",
    checkout,
    workRoot: join(root, "controller"),
    contentStore: new LocalContentStore(join(root, "content")),
    providerIdentity: "daytona",
    provider,
    harness: { identity: "fixture-harness@1", config: {} },
    argv,
    concurrency: 1,
  };
  const driver = new SandboxExecutionDriver(options);
  const request = {
    attemptId: randomUUID(),
    baseSha: git("rev-parse", "HEAD"),
    item: {
      id: "first",
      title: "bytes",
      goal: "bytes",
      acceptance: ["bytes"],
      nonGoals: [],
      citations: [],
      dependencies: [],
      ownedPaths: ["keep.txt", "old.txt", "new.bin", "run.sh"],
      validation: [],
      brief: "bytes",
    },
  };
  const h = await driver.start(request);
  t.after(async () => {
    for (const resource of infrastructure.resources.values())
      await infrastructure.destroy(resource);
  });
  writeFileSync(join(h.data.sandbox.workspace, "release"), "go");
  const restarted = new SandboxExecutionDriver({
    ...options,
    provider: new DaytonaSandboxProvider(
      providerConfig,
      "controller-only-canary",
      client,
    ),
  });
  for (let i = 0; i < 100; i++) {
    const state = await restarted.observe(h);
    if (state.state === "complete") break;
    assert.equal(state.state, "running");
    await new Promise((r) => setTimeout(r, 10));
  }
  const result = await restarted.collect(h);
  assert.match(result.treeSha, /^[a-f0-9]{40}$/);
  assert.equal(infrastructure.resources.size, 0);
  assert.equal(git("show", result.changeRef + ":keep.txt"), "changed");
  assert.equal(
    git("ls-tree", result.changeRef, "run.sh").slice(0, 6),
    "100755",
  );
  const cancellation = await driver.start({
    ...request,
    attemptId: randomUUID(),
  });
  const starts = infrastructure.starts;
  infrastructure.destroyFailure = true;
  await assert.rejects(restarted.cancel(cancellation), /not confirmed/);
  assert.equal(cancellation.data.phase, "destroying");
  assert.equal(infrastructure.resources.size, 1);
  infrastructure.destroyFailure = false;
  await restarted.cancel(JSON.parse(JSON.stringify(cancellation)));
  assert.equal(infrastructure.resources.size, 0);
  assert.equal(infrastructure.starts, starts);
  assert.equal(readFileSync(join(checkout, "keep.txt"), "utf8"), "base\n");
});
