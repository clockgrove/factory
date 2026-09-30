import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { LocalContentStore } from "../dist/content/local.js";
import {
  FixtureSandboxProvider,
  writeSandboxInvoker,
} from "./support/sandbox-provider.mjs";
test("packed package root composes the driver and invokes its registered harness in an installed child", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      root,
      "--offline",
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      join(root, pack.filename),
    ],
    { stdio: "pipe" },
  );
  const installed = join(root, "node_modules/@clockgrove/factory");
  const api = await import(pathToFileURL(join(installed, "dist/index.js")));
  assert.equal(typeof api.composeWithSandbox, "function");
  assert.equal(typeof api.runSandboxHarness, "function");
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(checkout, "keep.txt"), "baseline");
  writeFileSync(join(checkout, "old.txt"), "old");
  git("add", ".");
  git("commit", "-qm", "base");
  const provider = new FixtureSandboxProvider(join(root, "remote"));
  const remote = join(root, "published.git");
  execFileSync("git", ["clone", "--bare", checkout, remote], { stdio: "pipe" });
  provider.repository = remote;
  provider.autoRelease = true;
  const driver = new api.SandboxExecutionDriver({
    repository: "example/fixture",
    checkout,
    workRoot: join(root, "controller"),
    contentStore: new LocalContentStore(join(root, "content")),
    providerIdentity: "fixture@1",
    provider,
    harness: { identity: "fixture-harness@1", config: {} },
    argv: writeSandboxInvoker(root, "@clockgrove/factory"),
    concurrency: 1,
  });
  const handle = await driver.start({
    attemptId: "installed",
    baseSha: git("rev-parse", "HEAD"),
    item: {
      id: "installed",
      title: "Installed bytes",
      goal: "Installed bytes",
      acceptance: ["Bytes"],
      nonGoals: ["No deployment"],
      citations: [],
      dependencies: [],
      ownedPaths: ["keep.txt", "old.txt", "new.bin", "run.sh"],
      validation: [],
      brief: "Write bytes",
    },
  });
  let observation;
  for (let i = 0; i < 100; i++) {
    observation = await driver.observe(handle);
    if (observation.state !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(observation.state, "complete");
  const result = await driver.collect(handle);
  assert.equal(git("show", result.changeRef + ":keep.txt"), "changed");
  assert.notEqual(result.evidence.childPid, process.pid);
  assert.equal(provider.resources.size, 0);
});
