// Managed workers' crash safety, on a real Git worktree in real processes:
// a run killed at a crash point leaves a marker, and the next run cleans
// up what it names before starting. No provider API is contacted: the
// crashes come before any request, and the next run stops at the missing
// API key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MANAGED = fileURLToPath(
  new URL("../dist/providers/managed.js", import.meta.url),
);

function worktree() {
  const dir = mkdtempSync(join(tmpdir(), "factory-managed-"));
  const tree = join(dir, "item");
  const git = (...args) =>
    spawnSync("git", args, { cwd: tree, encoding: "utf8" });
  spawnSync("git", ["init", "-q", tree]);
  writeFileSync(join(tree, "a.txt"), "a\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return { dir, tree };
}

/** One OpenAI managed worker run in its own process; prints its result and log. */
function run(tree, env) {
  const script = `
    const { OpenAIManagedWorker } = await import(${JSON.stringify(MANAGED)});
    const worker = new OpenAIManagedWorker({
      kind: "openai-agents", model: "m", effort: "low", containerSize: "small",
      apiKeyEnv: "FACTORY_TEST_OPENAI_KEY", timeoutSeconds: 60, maxRuns: 3,
    });
    const log = [];
    const result = await worker.run({
      worktree: ${JSON.stringify(tree)}, prompt: "work", item: { id: "a", kind: "work" },
      commands: [], base: "HEAD", signal: new AbortController().signal,
      log: (event) => log.push(event),
    });
    process.stdout.write(JSON.stringify({ result, log }));
  `;
  const clean = { ...process.env };
  delete clean.FACTORY_CRASH_AT;
  delete clean.FACTORY_TEST_OPENAI_KEY;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...clean, ...env }, encoding: "utf8" },
  );
  return {
    signal: child.signal,
    out: child.stdout ? JSON.parse(child.stdout || "null") : null,
  };
}

const scratch = (dir) =>
  readdirSync(dir).filter((name) => name.startsWith("item.managed-"));

test("a run killed after writing its marker is cleaned up by the next run", () => {
  const { dir, tree } = worktree();
  const crashed = run(tree, { FACTORY_CRASH_AT: "managed:marker-written" });
  assert.equal(crashed.signal, "SIGKILL");
  const marker = JSON.parse(readFileSync(`${tree}.managed.json`, "utf8"));
  assert.equal(marker.session, undefined);
  assert.equal(marker.creating, undefined);
  assert.equal(scratch(dir).length, 1);

  // Nothing was sent, so there is nothing to look for: the marker and the
  // crashed run's scratch go, and the run goes on to its own checks.
  const next = run(tree, {});
  assert.equal(next.signal, null);
  assert.equal(next.out.result.kind, "hold");
  assert.match(next.out.result.question, /FACTORY_TEST_OPENAI_KEY/);
  assert.equal(next.out.result.spend.runs, 0);
  assert.equal(
    next.out.log.filter((event) => event.event === "possible-orphan").length,
    0,
  );
  assert.equal(existsSync(`${tree}.managed.json`), false);
  assert.deepEqual(scratch(dir), []);
});

test("a run killed as it creates its session reports the possible orphan once", () => {
  const { dir, tree } = worktree();
  const crashed = run(tree, {
    FACTORY_CRASH_AT: "managed:creating",
    FACTORY_TEST_OPENAI_KEY: "not-a-key",
  });
  assert.equal(crashed.signal, "SIGKILL");
  const marker = JSON.parse(readFileSync(`${tree}.managed.json`, "utf8"));
  assert.equal(marker.creating, true);
  assert.equal(marker.session, undefined);

  // The create may have reached the API, which can't look sessions up by
  // their tag: the next run reports it with the key, drops the marker and
  // carries on.
  const next = run(tree, {});
  assert.equal(next.out.result.kind, "hold");
  const orphans = next.out.log.filter(
    (event) => event.event === "possible-orphan",
  );
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].key, marker.key);
  assert.equal(existsSync(`${tree}.managed.json`), false);
  assert.deepEqual(scratch(dir), []);
});
