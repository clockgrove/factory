// clockgrove/factory#2344 R5: the result review's mutation pass seeds
// rule-based mutants into the lines a result added to product files and
// runs the item's commands on each, several at once, each in a copy of a
// passed validation checkout (validate.ts `use`, `ValidatedCheckout.copy`)
// that installs nothing again: its counts of mutants seeded, killed and
// survived are what the item's telemetry and its result review get, and
// the checkout itself is left as validated. A result that changed only
// tests is skipped, with a note. Real Git, real processes and the real
// sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { mutationPass } from "../dist/review/mutants.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { validateTree } from "../dist/validate.js";
import { configured, installation, item, REPO, tempDir } from "./helpers.mjs";

const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const CLAMP =
  "export function clamp(n) {\n  if (n > 10) return 10;\n  return n;\n}\n";
// It checks only the clamped case: a mutant of the plain return survives.
const TEST =
  'import assert from "node:assert";\nimport { clamp } from "../src/clamp.js";\nassert.equal(clamp(20), 10);\n';

/** A target whose base has `base` files and whose candidate adds `change`. */
function target(base, change) {
  const checkout = tempDir("factory-mutation-");
  git(checkout, "init", "--quiet");
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(checkout, path, ".."), { recursive: true });
      writeFileSync(join(checkout, path), content);
    }
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "change");
    return git(checkout, "rev-parse", "HEAD");
  };
  const from = write({ "package.json": '{"type":"module"}\n', ...base });
  return { checkout, base: from, commit: write(change) };
}

/** The item's validation of the candidate with the mutation pass on its passed result. */
async function validateWithMutants(repo) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const config = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const work = item("a", {
    ownedPaths: ["src/**", "test/**"],
    validation: [{ command: "node test/clamp.test.js" }],
  });
  const events = [];
  let pass;
  const result = await validateTree({
    checkout: repo.checkout,
    repository: REPO,
    directory: `${repo.checkout}.validation`,
    commit: repo.commit,
    item: work,
    plan: {
      base: repo.base,
      items: [work],
      coverage: [],
      finalCommands: [],
    },
    blocks: [],
    base: repo.base,
    sandbox: { ...config.sandbox, network: "off" },
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push(event),
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
    use: async (checkout) => {
      pass = await mutationPass({
        checkout,
        repo: checkout.directory,
        base: repo.base,
        commit: "HEAD",
        commands: ["node test/clamp.test.js"],
        limits: { max: config.review.mutants, ms: 60_000 },
        baselineMs: 1000,
        seed: "a",
        signal: AbortSignal.timeout(120_000),
        log: (event) => events.push(event),
      });
      // The mutants ran in copies: the checkout is as validated.
      assert.equal(
        readFileSync(join(checkout.directory, "src/clamp.js"), "utf8"),
        readFileSync(join(repo.checkout, "src/clamp.js"), "utf8"),
      );
    },
  });
  assert.equal(result.kind, "passed", result.detail);
  return { pass, events };
}

test("a weak test leaves a survivor, and the counts are logged for the item's telemetry", {
  skip,
}, async () => {
  const repo = target(
    {},
    { "src/clamp.js": CLAMP, "test/clamp.test.js": TEST },
  );
  const { pass, events } = await validateWithMutants(repo);
  assert.equal(pass.status, "done");
  assert.deepEqual([pass.seeded, pass.killed, pass.survived], [4, 3, 1]);
  assert.deepEqual(pass.survivors, [
    {
      file: "src/clamp.js",
      line: 3,
      rule: "return null",
      text: "  return null;",
    },
  ]);
  const logged = events.find((event) => event.event === "mutation-pass");
  assert.deepEqual(
    [logged.status, logged.seeded, logged.killed, logged.survived],
    ["done", 4, 3, 1],
  );
  assert.ok(logged.lanes >= 1);
});

test("a result that changes only tests is skipped, with a note", {
  skip,
}, async () => {
  const repo = target(
    { "src/clamp.js": CLAMP },
    { "test/clamp.test.js": TEST },
  );
  const { pass } = await validateWithMutants(repo);
  assert.equal(pass.status, "skipped");
  assert.equal(pass.seeded, 0);
  assert.match(pass.note, /no product source file/);
});
